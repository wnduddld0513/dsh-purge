# gogo: Intranet Surface Survey Through a Tunnel

Maps an internal segment the moment a tunnel exists: alive hosts, open ports, service fingerprints, and the metadata that decides where the next hour goes (web titles, certificates, JWT and e-mail leakage, exposed keys). This is the breadth-first survey; `fscan-intranet` is the point strike that follows it. Results are written as JSON under `RESULT_DIR` and then flattened into `asset` rows with fingerprint fields — one row per host, not per port.

`RESULT_DIR` is the engagement result directory (`runs/` under the engagement root unless the operator points it elsewhere).

## When to use

- A tunnel is up and you have at least one CIDR from the compromised host's route table, ARP cache, or application configuration.
- You need the shape of the segment before spending any noise on credential attacks: how many hosts, which services, which management planes are exposed.
- You need HTTP-level metadata (title, server header, certificate subject, detected technology) for hosts that later become `web-app` or `central-system` results.
- Internal web portals, admin consoles, and unauthenticated back ends are expected, and you want them ranked in one pass.
- Not for: weak-password checks or CVE modules. That is `fscan-intranet`.
- Not for: deep application fingerprinting or directory discovery. `web-fingerprint` and `dir-bruteforce` do that per host.
- Not for: the external perimeter, which is `recon-pipeline` and `active-scan` territory.

## Prerequisites

Every step below has a fallback and nothing in this list is mandatory — if a tool is missing, use the fallback named beside it.

- `gogo` — not downloaded by `bash $DSH_HOME/redteam/setup.sh --yes`; that script only prints instructions. Fetch the platform build from the chainreactors/gogo releases page (`gogo_linux_amd64`, `gogo_linux_arm64`, `gogo_windows_amd64.exe`, v2.15.0 line) and place it at `$DSH_HOME/redteam/toolkit/gogo/gogo`, then `chmod +x` every binary in that directory.
- Fallback for survival and ports: `fscan -h <cidr> -np -nobr -nopoc` (see `fscan-intranet`), which answers the same question with fewer fingerprints.
- Fallback for HTTP metadata: `pd-httpx -l hosts.txt -title -tech-detect -status-code -server` (the ProjectDiscovery build; `/usr/bin/httpx` is the Python library CLI and is not it), or a `curl` loop over the host list.
- Fallback for technology detection: `nuclei -l hosts.txt -tags tech -proxy socks5://127.0.0.1:PORT -rate-limit RATE`.
- `proxychains4` only for tools that cannot take a proxy flag. Never edit the system proxychains config; use `-f runs/proxychains-<port>.conf`.
- `jq` for reading the JSON report — `apt install jq`. Fallback: `grep -o` on the text output (`-O`), which many builds emit alongside the JSON.

## Workflow

1. Confirm the tunnel and the range before the first packet. Both come from the database, not from memory.

```
redteam_tunnel_list
redteam_sessions
cat RESULT_DIR/intranet-ranges.txt
```

2. Check the local build's flag set once. gogo's flags have shifted between 2.x releases, and a wrong flag wastes the whole run.

```
"$DSH_HOME/redteam/toolkit/gogo/gogo" -h | head -40
"$DSH_HOME/redteam/toolkit/gogo/gogo" -p TARGET_IP --proxy socks5://127.0.0.1:PORT -v | head -20
```

3. Run the survey for one `/24` at a time. Small units keep the output parseable and let a dead listener be restarted without losing the run.

```
"$DSH_HOME/redteam/toolkit/gogo/gogo" \
  -p 10.20.0.0/24 \
  --proxy socks5://127.0.0.1:PORT \
  -t THREADS -v \
  -o RESULT_DIR/gogo-10.20.0.0-24.json
```

4. Where the build supports a target file, use it instead of a wide CIDR so the survey stays auditable.

```
sed -n '1,256p' RESULT_DIR/internal-hosts.txt > RESULT_DIR/gogo-batch-01.txt
"$DSH_HOME/redteam/toolkit/gogo/gogo" -p RESULT_DIR/gogo-batch-01.txt \
  --proxy socks5://127.0.0.1:PORT -t THREADS -o RESULT_DIR/gogo-batch-01.json
```

5. Discover the JSON shape before writing a projection. Do not assume the schema of a version you have not inspected.

```
jq -c '.' RESULT_DIR/gogo-10.20.0.0-24.json | head -3
jq -r '.[]? | [.ip, .port, .frame.server, .frame.title] | @tsv' \
  RESULT_DIR/gogo-10.20.0.0-24.json | head -40
```

6. Flatten to a host list and a service summary; these files become the input for every later step.

```
jq -r '.[]?.ip' RESULT_DIR/gogo-10.20.0.0-24.json 2>/dev/null | sort -u \
  > RESULT_DIR/gogo-hosts.txt
wc -l RESULT_DIR/gogo-hosts.txt

grep -oE '([0-9]{1,3}\.){3}[0-9]{1,3}' RESULT_DIR/gogo-10.20.0.0-24.json \
  | sort -u > RESULT_DIR/gogo-hosts-grep.txt
```

7. Pull the extracted key information into one file. This is gogo's real advantage over a port scanner: certificates, e-mail addresses, JWT samples, and leaked keys.

```
jq -r '.[]? | select(.cert != null or .jwt != null or .emails != null)' \
  RESULT_DIR/gogo-10.20.0.0-24.json > RESULT_DIR/gogo-keyinfo.json 2>/dev/null
grep -oE '[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+' RESULT_DIR/gogo-10.20.0.0-24.json \
  | sort -u | head -20 | tee RESULT_DIR/gogo-emails.txt
```

8. Triage by what a host is, not by how many ports it has. Management planes first.

- `7001`/`7002`, `8080`/`8443`, `9000`, `9090` → application servers and consoles.
- `9200`/`9300` → Elasticsearch; `2375`/`2376` → Docker API; `5985`/`5986` → WinRM; `3389` → RDP; `22` with password auth → Linux servers.
- `445` on a domain-joined host → lateral movement candidate.
- A certificate subject naming a domain you did not know about is often the most valuable single line in the report.

9. Verify the top candidates by hand through the same proxy. Fingerprints are hints; the request is evidence.

```
curl --socks5-hostname 127.0.0.1:PORT -s -i -m 8 http://TARGET_IP:PORT/ | head -20
curl --socks5-hostname 127.0.0.1:PORT -s -o /dev/null -w '%{http_code} %{size_download}\n' \
  http://TARGET_IP:PORT/
```

10. Write the inventory. One asset row per host, with the fingerprint fields the database understands.

```
redteam_asset_add ip=TARGET_IP provenance=active tool=gogo primary_name=web01.corp.local \
  names='["web01.corp.local","web01"]' state=up

redteam_asset_test asset_id=12 status=tested \
  surface='80/443 nginx 1.24 PHP 8.1; 3306 MySQL exposed; 8080 Tomcat manager' \
  test='gogo survey + manual curl verification'

redteam_chain_add stage=recon title='gogo surface survey of 10.20.0.0/24' \
  tool='gogo -p 10.20.0.0/24 --proxy socks5://127.0.0.1:PORT -o runs/gogo-10.20.0.0-24.json' \
  result='37 alive hosts, 92 open ports, 11 web apps, 1 exposed MySQL'
```

11. Hand off in this order: exposed management planes to `unauth-exploit`, hosts with a working credential to `lateral-movement`, the whole CIDR to `fscan-intranet` for the point strike, and named web applications to `web-fingerprint`.

12. Repeat for each new range revealed by a certificate subject, an application config, or a host's own routing table. Stop when three consecutive surveys add no new host.

## Output and evidence

Files under `RESULT_DIR`:

- `gogo-<cidr>.json` — the full report: hosts, ports, service banners, fingerprints, extracted key info.
- `gogo-hosts.txt`, `gogo-batch-<nn>.txt` — flattened host lists used as inputs downstream.
- `gogo-keyinfo.json`, `gogo-emails.txt` — certificates, JWT samples, addresses, and keys lifted from responses.
- `<host>-verify.txt` — your own `curl` transcript for each host you intend to claim.

Database rows:

- `asset` via `redteam_asset_add`: `ip` plus `primary_name`, `names[]`, `provenance=active`, `tool=gogo`, and the port/service detail the database stores per host.
- Surface via `redteam_asset_test`: `status=tested` with `surface` listing ports, versions, and web titles.
- `finding` via `redteam_vuln_add` with `status=candidate` for an exposed management plane; it becomes `confirmed` only after an independent probe.
- Chain step via `redteam_chain_add` with `stage=recon`; the `tool` field must carry the literal command including `--proxy socks5://...`, because a report that omits how the network was reached cannot be replayed.
- No score hit at this stage. gogo produces the map; `unauth-exploit`, `webshell-toolkit`, and `credential-attack` produce the results, and scoring an unverified fingerprint is double counting.

What counts as evidence: the JSON record for the host plus your own request against it. A port listed by gogo is a candidate surface; a `curl` response with a title and a server header is the evidence that the surface is real.

## Failure modes

- `gogo: command not found` → the binary is not at the path you called. Check `$DSH_HOME/redteam/toolkit/gogo/` and call the file directly.
- `Permission denied` → `chmod +x` was never applied to the downloaded binary, or the archive lost its mode.
- `exec format error` → Windows or arm64 build on the wrong host. Match the artifact to the platform.
- `unknown flag: --proxy` → that build spells it differently (`-proxy`, or proxy support lives in a wrapper). Run `gogo -h`, use what it documents, and record the exact form in the chain step.
- Zero hosts through a proxy that is known to work → the scheme is missing from the proxy value. Use the full `socks5://127.0.0.1:PORT`, not a bare `127.0.0.1:PORT`.
- Firewalled hosts missing from the report → the liveness probe is ICMP-based. Look for a no-ping switch in `gogo -h` and rerun that range.
- The run is far slower than the port count suggests → thread count is low or the SOCKS listener is the bottleneck. Raise `-t` in steps, watch the listener, and keep `-v` off for long runs.
- Output file is partial after an interruption → gogo writes incrementally. Keep the partial file, and rerun only the `/24`s that produced no records.
- `jq` returns `Cannot index array with string "ip"` → the report root is an array of arrays or line-delimited JSON. Use `jq -c '.' file | head` to see the real shape before projecting, or fall back to `grep` on the text output.
- Titles are empty for every HTTPS host → certificate validation is aborting the request. Retry with the build's insecure/`-k` equivalent, or verify the host with `curl -k`.
- The survey works but every later tool fails through the proxy → the tunnel maps a different port range. Confirm the listener and the reachable CIDR with `redteam_tunnel_list` before blaming the scanner.

## Notes

- gogo is the quietest way to answer "how big is this network". Its traffic is a connect and a banner read, while the credential pass that follows writes authentication attempts to logs.
- Throttle with `THREADS` and `RATE`; a `/16` through one SOCKS listener is a self-inflicted outage, so keep to `/24` units and raise threads only while responses keep coming.
- Idempotency: one JSON file per CIDR per pass, never appended. A rerun overwrites and that is correct — the previous file should already be parsed into `RESULT_DIR/gogo-hosts.txt`.
- Resume behaviour: the per-`/24` report is the checkpoint. A restarted run reads `RESULT_DIR/intranet-ranges.txt`, skips ranges with an existing report, and continues with the next one.
- Never substitute nmap host-by-host inside the network. It is slower, noisier per host, and produces nothing the database can consume without extra parsing work.
- Everything gogo reports is a hypothesis until a request confirms it. Keep the hypothesis in `surface`, the confirmation in `evidence`, and only score what the confirmation actually produced.
