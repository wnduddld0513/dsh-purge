# Active Port and Service Scanning

Turn a list of candidate IPs into a confirmed port and service map. Masscan provides width at a controlled packet rate, Nmap provides depth, version detection and scripted probes, and Naabu is the non-root TCP fallback when raw sockets are unavailable. Raw scanner output stays in `RESULT_DIR/scans/`, and every open port is registered on its asset through `redteam_asset_add` with `provenance=active`.

## When to use

- `passive-recon` or `recon-pipeline` produced `scope.txt` / `ips.txt` and ports are still unknown.
- You must answer "which of these 200 addresses are alive" before spending time on web probing.
- You need service versions (SSH banner, nginx version, MySQL build) to select vulnerability checks.
- A specific high port range has to be excluded from a full sweep (mail, backup, management).
- A previous scan reported `filtered` on everything and you need a second method before concluding.

Not for: name and certificate collection (`passive-recon`), HTTP response comparison (`pd-httpx`), technology fingerprinting (`web-fingerprint`), brute forcing credentials or paths (`dir-bruteforce`), or template-based vulnerability checks (`nuclei-scan`). A port being open is not a finding; it is inventory.

## Prerequisites

- `nmap` and `masscan` — `apt install nmap masscan`. Both need root for SYN scanning; without root use `nmap -sT` (full TCP connect) and accept the extra noise and time.
- `toolkit/naabu/naabu` — installed by `bash $DSH_HOME/redteam/setup.sh --yes`. Non-root Naabu must be told `-scan-type c`; the default SYN mode fails without `CAP_NET_RAW`.
- A text file of targets, one IP or CIDR per line. Ranges, never single IPs, are the unit of work.

Fallbacks exist for every step: no root means `-sT` instead of `-sS`; no masscan means `nmap -p-` with `--min-rate`; no Naabu means `nmap -Pn --top-ports 1000`. Nothing here is mandatory — a top-1000 Nmap scan on one host still produces usable inventory.

## Workflow

1. Establish scope and the output layout, and confirm every target actually belongs to the engagement:

   ```bash
   mkdir -p RESULT_DIR/scans
   sort -u RESULT_DIR/passive/scope.txt -o RESULT_DIR/passive/scope.txt
   wc -l RESULT_DIR/passive/scope.txt
   head -n 20 RESULT_DIR/passive/scope.txt | tee RESULT_DIR/scans/targets.head.txt
   ```

   If the file contains names rather than IPs, resolve first and keep only addresses inside the approved ranges; drop the rest instead of scanning "just in case".

2. Host discovery. Everything downstream depends on this list:

   ```bash
   nmap -sn -T4 -iL RESULT_DIR/passive/scope.txt -oG RESULT_DIR/scans/up.gnmap
   grep -E 'Status: Up' RESULT_DIR/scans/up.gnmap | awk '{print $2}' \
     | sort -u > RESULT_DIR/scans/live-ips.txt
   wc -l RESULT_DIR/scans/live-ips.txt
   ```

   Zero live hosts usually means ICMP and ARP are filtered, not that the range is empty. Re-run with `-Pn -PS22,80,443` and treat every address as up.

3. Register the declared state before scanning, so the panel can show what is in progress:

   ```
   redteam_asset_test
     ip: TARGET_IP
     status: testing
     test: "active-scan: masscan full TCP range at RATE pps, then nmap -sV on open ports"
     updated_by: recon
   ```

4. Width pass with masscan. Pick `RATE` from the link quality, start low:

   ```bash
   sudo masscan -iL RESULT_DIR/scans/live-ips.txt -p1-65535 --rate=RATE \
     --wait 3 -oL RESULT_DIR/scans/masscan.lst
   awk '$1=="open"{print $4}' RESULT_DIR/scans/masscan.lst | sort -un \
     | paste -sd, - > RESULT_DIR/scans/open-ports.csv
   cat RESULT_DIR/scans/open-ports.csv
   ```

   A rate above the link capacity shows up as `failed to transmit` lines and false negatives. Halve `RATE` and repeat the affected range rather than trusting the first result.

5. Depth pass with Nmap on exactly the ports masscan found, against live hosts only:

   ```bash
   PORTS=$(cat RESULT_DIR/scans/open-ports.csv)
   sudo nmap -sS -sV --version-all -Pn -p "$PORTS" -iL RESULT_DIR/scans/live-ips.txt \
     -oA RESULT_DIR/scans/nmap-services
   grep -E '^[0-9]+/tcp' RESULT_DIR/scans/nmap-services.nmap | head -n 40
   ```

   `-oA` is deliberate: `.nmap` is for humans, `.xml` is for re-parsing, `.gnmap` is greppable. Keep all three. Unrecognised services get `?` in the VERSION column — those are the ones worth a manual banner grab later.

6. Add the transports a TCP sweep cannot see. UDP top ports and a targeted sweep of management ports are cheap and high value:

   ```bash
   sudo nmap -sU --top-ports 50 --max-retries 1 --host-timeout 10m -Pn \
     -iL RESULT_DIR/scans/live-ips.txt -oA RESULT_DIR/scans/nmap-udp
   sudo nmap -sS -sV -Pn -p 22,23,135,139,445,1433,3306,3389,5432,5900,6379,8080,9200,11211 \
     -iL RESULT_DIR/scans/live-ips.txt -oA RESULT_DIR/scans/nmap-management
   ```

7. Non-root fallback when raw sockets are refused. Naabu connect mode is slower but works as an unprivileged user:

   ```bash
   toolkit/naabu/naabu -list RESULT_DIR/scans/live-ips.txt -top-ports 1000 \
     -scan-type c -rate RATE -o RESULT_DIR/scans/naabu.txt
   sort -u RESULT_DIR/scans/naabu.txt | head
   ```

   Compare against the masscan result: ports present in one and missing in the other are the uncertain ones, and only those deserve a re-scan.

8. Convert versions into candidate vulnerabilities, not into findings. Nmap tells you `nginx 1.18.0`; it does not tell you the host is vulnerable:

   ```bash
   grep -Eo '[A-Za-z0-9._-]+ [0-9]+\.[0-9]+[0-9a-z.-]*' RESULT_DIR/scans/nmap-services.nmap \
     | sort -u > RESULT_DIR/scans/products.txt
   ```

9. Register every open port. One call per host, all ports at once:

   ```
   redteam_asset_add
     ip: TARGET_IP
     state: live
     primary_name: DOMAIN
     provenance: active
     tool: nmap
     ports: [{ port: 443, proto: "tcp", service: "https", product: "nginx",
               version: "1.18.0", banner: "Server: nginx/1.18.0",
               provenance: "active", tool: "nmap" },
             { port: 22, proto: "tcp", service: "ssh", product: "OpenSSH", version: "8.2p1" }]
   ```

10. Close the loop on the asset test so the measurement page shows real progress:

    ```
    redteam_asset_test
      ip: TARGET_IP
      status: tested
      test: "nmap -sV complete (top + full TCP), UDP top 50 done"
      surface: "no SMB/445; Web /api not tested yet"
      updated_by: recon
    ```

## Output and evidence

Files under `RESULT_DIR/scans/`:

- `live-ips.txt`, `open-ports.csv` — the working set for every later skill.
- `masscan.lst` — raw open-port lines with timestamps, the fastest way to prove when a port appeared.
- `nmap-services.{nmap,xml,gnmap}`, `nmap-udp.*`, `nmap-management.*` — full depth results.
- `naabu.txt`, `products.txt` — fallback sweep and the product/version list used to steer `nuclei-scan`.

Tool rows: `redteam_asset_add` with `provenance=active` and per-port `service`/`product`/`version`; `redteam_asset_test` at start and end of every host; `redteam_evidence_record` with `operation="port_scan"`, `confidence="observed"`, `authority="tool-output"` and `limitations` such as `["masscan only, -sV not yet run"]`.

Evidence is a scanner artefact that names the port and the version, backed by a file on disk. A port remembered from an earlier engagement without a matching artefact is a claim, not evidence.

## Failure modes

- `masscan: failed to open adapter` or `socket() = -1` → not root or no raw socket capability → run under `sudo`, or switch to Naabu `-scan-type c`.
- Masscan reports far fewer ports than Nmap on the same host → rate too high, packets dropped silently → lower `RATE` by half, re-scan, compare before publishing the port list.
- `nmap -sS` stalls at "Starting Nmap" → raw sockets blocked by a local firewall or container → use `-sT`, and note in the evidence that connect scanning was used.
- `0 hosts up` across a whole range → ICMP echo filtered → use `-Pn` and continue; do not conclude the range is unused.
- Every port shows `tcpwrapped` → a load balancer accepts connections and drops them → probe with `nmap --reason -sV --version-light` on a few ports, and pivot to the web layer with `pd-httpx`.
- Nmap `-sV` identifies the wrong product on a custom port → banner grab directly (`nmap -sV --version-intensity 9 -p PORT --script banner TARGET_IP`) before trusting the label.

## Notes

- Rate limits: keep masscan at or below the agreed `RATE`, and give Nmap `--max-rate` when several operators scan the same range. A noisy sweep against a monitored range gets the source IP blocked and wastes the whole window.
- Opsec: SYN scans from `VPS_HOST` leave a different source IP than operator traffic. Use one consistent source per engagement so the target's logs tell a coherent story.
- Idempotency: port rows upsert per `(asset, port, proto)`, so re-scanning refreshes `last_seen` instead of duplicating rows. Re-running a finished scan is safe and cheap on the library side.
- Resume: Nmap supports `--resume <logfile>` for interrupted runs; masscan does not, so split large ranges into per-/24 target files and track finished files in `RESULT_DIR/scans/done.txt`.
- Keep the raw `.xml`. Every later re-parse (new CVEs, new fingerprint rules) should read the original scanner output rather than a summary somebody wrote by hand.
