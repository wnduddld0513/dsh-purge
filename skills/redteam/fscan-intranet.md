# fscan: Intranet Point Strike After Tunnel Establishment

Runs fscan across an internal range reached through a tunnel and converts its output into a host inventory, a weak-password list, and high-risk vulnerability candidates. This is the breadth-first strike that follows the `gogo-intranet` survey: gogo answers "how big is this network", fscan answers "which single host gives me the next foothold". Raw reports land under `RESULT_DIR/fscan-*.txt`; every confirmed host and finding is then written to the database through `redteam_asset_add`, `redteam_vuln_add`, and the score tools.

`RESULT_DIR` is the engagement result directory (`runs/` under the engagement root unless the operator points it elsewhere).

## When to use

- An active tunnel exists and you know at least one internal CIDR from the compromised host's routing table, ARP cache, or application config.
- You need survival, ports, service versions, and default-credential coverage for a `/24` in minutes rather than hours.
- You want weak-password coverage across SSH, SMB, RDP, MSSQL, MySQL, Redis, and PostgreSQL in one pass, using the same target list.
- Known-CVE sweep is appropriate for the era in scope: MS17-010, SMBGhost, WebLogic, Shiro, Fastjson on internal-only hosts that were never patched.
- Not for: the external perimeter. Use `active-scan` for internet-facing hosts.
- Not for: verifying a finding. fscan produces candidates; the verification is a separate read-only request.

## Prerequisites

Every step below has a fallback and nothing in this list is mandatory — if a tool is missing, use the fallback named beside it.

- `fscan` — `bash $DSH_HOME/redteam/setup.sh --yes` places the Linux binary at `$DSH_HOME/redteam/toolkit/fscan/fscan`. If only `fscan.zip` arrived, unpack it yourself, extract `fscan`, and `chmod +x`. If the setup script could not fetch it, download the platform build (`fscan_windows_x64.exe`, `fscan_linux_amd64`, `fscan_linux_arm64`) from the shadow1ng/fscan releases page and put it in the same directory.
- Fallback for the credential pass: `hydra -L users -p 'Password1' svc://TARGET_IP -t 2` per service, or the service's own client with a small dictionary.
- A callback listener when a module needs a reverse shell: on the VPS run `vps.sh serve 9100`, and set `REDTEAM_VPS_HOST` in the environment file so the payload host is known (`REDTEAM_VPS_HOST` is optional; without it, modules that need a callback are simply skipped).
- `proxychains4` only if you prefer wrapping fscan over its native `-socks5` flag. Never edit the system proxychains config.

## Workflow

1. Gate on the tunnel and write down the range before the first packet leaves.

```
redteam_tunnel_list
redteam_sessions
```

2. Derive the CIDR list from the host you already control, not from a guess.

```
ip route
arp -a
netstat -rn
```

Write the result to `RESULT_DIR/intranet-ranges.txt`; every later command reads from that file so the range is auditable.

3. Prove one host is reachable through the proxy before sweeping a subnet.

```
curl --socks5-hostname 127.0.0.1:PORT -s -m 5 -o /dev/null -w 'http=%{http_code}\n' http://TARGET_IP/
```

4. Pass 1 — survival and ports only. No brute force, no PoCs: this keeps the run quiet and fast, and it is the pass that decides whether the segment is worth the noise.

```
"$DSH_HOME/redteam/toolkit/fscan/fscan" \
  -h 10.20.0.0/24 \
  -p 21,22,80,135,139,443,445,1433,3306,3389,5432,6379,8080,8443,9200,27017 \
  -t THREADS -time 3 -np -nobr -nopoc \
  -socks5 127.0.0.1:PORT \
  -o RESULT_DIR/fscan-10.20.0.0-24.txt
```

5. Pass 2 — default and weak credentials, restricted to the services that actually answered in pass 1.

```
"$DSH_HOME/redteam/toolkit/fscan/fscan" \
  -h 10.20.0.0/24 -p 22,445,1433,3306,5432,6379 \
  -t THREADS -time 5 -np -nopoc \
  -socks5 127.0.0.1:PORT \
  -o RESULT_DIR/fscan-weak-10.20.0.0-24.txt

# replay a specific account pair without a dictionary
"$DSH_HOME/redteam/toolkit/fscan/fscan" -h TARGET_IP -p 445 \
  -user USERNAME -pwd PASSWORD -nopoc -socks5 127.0.0.1:PORT \
  -o RESULT_DIR/fscan-creds-TARGET_IP.txt
```

6. Pass 3 — CVE candidates, one host at a time. Whole-subnet PoC runs are how fragile appliances go down.

```
"$DSH_HOME/redteam/toolkit/fscan/fscan" -h TARGET_IP -p 445 \
  -nobr -socks5 127.0.0.1:PORT -o RESULT_DIR/fscan-poc-TARGET_IP.txt

"$DSH_HOME/redteam/toolkit/fscan/fscan" -h TARGET_IP -p 445 \
  -pocpath ./pocs -nobr -socks5 127.0.0.1:PORT -o RESULT_DIR/fscan-poc2-TARGET_IP.txt
```

7. Turn the report into a host list, then verify every candidate with a read-only probe of your own.

```
grep -E 'Alive|open|MS17|SMBGhost|Redis|weak|\[\+\]' RESULT_DIR/fscan-10.20.0.0-24.txt | head -60
grep -oE '([0-9]{1,3}\.){3}[0-9]{1,3}' RESULT_DIR/fscan-10.20.0.0-24.txt | sort -u \
  > RESULT_DIR/fscan-hosts.txt

redis-cli -h TARGET_IP -p 6379 --no-auth-warning PING
curl -s -m 5 -i http://TARGET_IP:PORT/ | head -20
```

8. Record the inventory first, findings second. A host row with no finding is still a result; a finding with no host row cannot be scored.

```
redteam_asset_add ip=TARGET_IP provenance=active tool=fscan \
  primary_name=web01 state=up

redteam_vuln_add title='MS17-010 candidate on 445' severity=critical target=TARGET_IP \
  source='fscan' status=confirmed confidence=medium \
  evidence='fscan reported MS17-010; nmap --script smb-vuln-ms17-010 returned VULNERABLE' \
  gained='remote code execution path on an internal file server'

redteam_score_hit code=db-credential points=10 target=TARGET_IP port=6379 \
  evidence='redis-cli PING -> PONG with no AUTH after fscan flagged 6379'
```

9. Iterate on the new segments the pass reveals, one `/24` at a time, each with its own output file.

```
for cidr in 10.20.1 10.20.2; do
  "$DSH_HOME/redteam/toolkit/fscan/fscan" -h "$cidr.0/24" -p 22,80,445,3389 \
    -t THREADS -time 3 -np -nobr -nopoc -socks5 127.0.0.1:PORT \
    -o "RESULT_DIR/fscan-$cidr.0-24.txt"
done
```

10. Stop widening when three consecutive passes add no new host. Then hand the confirmed services to `unauth-exploit`, the credentials to `lateral-movement`, and the web surfaces to `web-fingerprint`.

## Output and evidence

Files under `RESULT_DIR`:

- `fscan-<cidr>.txt` — pass 1 report: alive hosts, open ports, service banners.
- `fscan-weak-<cidr>.txt` — credential pass results, one line per service and account.
- `fscan-poc-<host>.txt` — CVE module output for the hosts you chose to test.
- `fscan-hosts.txt`, `intranet-ranges.txt` — the deduplicated host list and the audited range list.

Database rows:

- `asset` via `redteam_asset_add`: `ip`, `provenance=active`, `tool=fscan`, `primary_name` when a hostname is known. One row per IP, not per port.
- Surface via `redteam_asset_test`: `status=tested`, `surface` carrying the open ports and service versions.
- `finding` via `redteam_vuln_add` only for candidates you re-verified yourself; `status=candidate` while unverified, `confirmed` after your own probe.
- Score hit via `redteam_score_hit` per confirmed result: `db-credential` (`points=10` for a blank or unauthenticated database), `server-host` (`points=10`/`50`) when a credential gives a shell, `web-app` (`points=50`/`100`) for an application login. Never score a raw port.
- Chain step via `redteam_chain_add` with `stage=recon`, `tool` holding the literal fscan command including `-socks5`.

What counts as evidence: the fscan line plus your independent verification of it. A weak-password hit must be replayed with the real client (a `200` with session content, a `select user()` result, a shell banner), because fscan reports protocol-level success that can be a banner quirk rather than a working login.

## Failure modes

- fscan exits immediately with `Permission denied` → the binary was never made executable. `chmod +x` the file and retry.
- `exec format error` → the wrong platform build (`fscan_linux_arm64` on x86, or the Windows `.exe` on Linux). Pick the matching artifact.
- No output at all and no error → `-np` is missing on a network that drops ICMP, so every host is considered dead. Add `-np`.
- `-socks5` is rejected as an unknown flag → older or forked builds use `-proxy socks5://127.0.0.1:PORT`. Run `fscan -h` once and use whatever that build documents.
- The run takes hours for a `/16` → threads multiplied by per-host timeout. Chunk into `/24`s, keep `-time 3`, and raise `-t` only while the SOCKS listener stays healthy.
- Every host shows `open 445` but no service detail → the module needs a real banner exchange that the proxy is truncating. Re-check with `nc -zv` and `nmap -sV` on a single host.
- Weak-password hits that do not survive a replay → false positive from PHP/JSP banner behaviour, or the account is locked. Downgrade the row, never leave it as confirmed.
- MS17-010 reported on a patched host → fscan's probe is heuristic. Confirm with `nmap --script smb-vuln-ms17-010` before claiming anything.

## Notes

- Order of noise, lowest first: no-brute port pass → credential pass → CVE pass. The credential pass is the loudest thing here and it can lock accounts, so read the lockout policy first when the segment is a Windows domain.
- Throttle with `THREADS` and `RATE`; through a single SOCKS listener keep `-t` in the low hundreds and expect the tunnel, not the target, to be the bottleneck.
- Idempotency: one output file per pass, never append to a previous report. Re-running a pass with the same `-o` overwrites cleanly, which is what you want after a partial failure.
- Resume by chunk: the per-`/24` report is the unit of progress. A resumed run reads `RESULT_DIR/intranet-ranges.txt`, skips the CIDRs that already have a report with matches, and continues.
- Never run nmap host-by-host inside the network. It is slower than fscan, noisier per host, and produces a worse artifact for the database.
