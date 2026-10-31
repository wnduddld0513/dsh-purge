# Reconnaissance Pipeline

Run the whole enumeration chain end to end — subdomain discovery, DNS resolution, port discovery, HTTP probing — and stop at the first stage that produces nothing usable. The pipeline is a sequence of files on disk, so any stage can be re-run, inspected, or replaced without redoing the others. Outputs land in `RESULT_DIR/recon/` and feed the asset library through `redteam_asset_add` with the provenance of the stage that produced each fact.

## When to use

- A fresh `DOMAIN` engagement and the operator wants the full funnel in one pass instead of by hand.
- You already have `hosts.txt` and only need the downstream stages re-run (start at the stage number that matches your existing input file).
- A previous pipeline stopped partway (rate limit, killed shell) and you need to resume rather than restart.
- You need a reproducible count per stage to explain why the final host list is small.
- You want one consistent artefact set that the reporting step can cite.

Not for: certificate and netblock collection (`passive-recon`), targeted single-host depth work (`active-scan`), web content analysis (`web-fingerprint`), or vulnerability checks (`nuclei-scan`). This skill owns the funnel, not the interpretation of its output.

## Prerequisites

- `bash $DSH_HOME/redteam/setup.sh --yes` once, which installs `toolkit/subfinder/subfinder`, `toolkit/dnsx/dnsx`, `toolkit/naabu/naabu`, `toolkit/httpx/httpx` and `toolkit/ksubdomain/ksubdomain`.
- The `pd-httpx` wrapper on `PATH`. The ProjectDiscovery scanner is not the Python `httpx` CLI, so the wrapper is what makes the name unambiguous:

  ```bash
  printf '#!/usr/bin/env bash\nexec "${DSH_HOME:-$HOME/.dsh}/redteam/toolkit/httpx/httpx" "$@"\n' \
    > ~/.local/bin/pd-httpx && chmod +x ~/.local/bin/pd-httpx
  pd-httpx -version
  ```

- `~/.local/nuclei-templates` populated by `nuclei -update-templates` if you intend to chain into `nuclei-scan` afterwards.

Every stage has a substitute: `subfinder` can be replaced by the certificate list from `passive-recon`, `dnsx` by a `dig` loop, `naabu` by `nmap --top-ports`, and `pd-httpx` by `curl -sI`. Nothing is mandatory; run the stages you have tools for and record which ones you skipped.

## Workflow

1. Create the stage directories and freeze the input domain. Every later stage reads the previous stage's file, never a hand-typed list:

   ```bash
   mkdir -p RESULT_DIR/recon
   echo DOMAIN > RESULT_DIR/recon/apex.txt
   printf 'started=%s\n' "$(date -Is)" > RESULT_DIR/recon/stage-log.txt
   ```

2. Stage 1 — passive subdomain enumeration. Several independent engines, then union:

   ```bash
   toolkit/subfinder/subfinder -d DOMAIN -all -recursive -silent \
     -o RESULT_DIR/recon/subfinder.txt 2> RESULT_DIR/recon/subfinder.err
   wc -l < RESULT_DIR/recon/subfinder.txt
   ```

   Fewer than five results on a real domain usually means an upstream source is rate limiting. Seed the list from the certificate file instead of waiting:

   ```bash
   cat RESULT_DIR/passive/hosts.txt RESULT_DIR/recon/subfinder.txt 2>/dev/null \
     | tr 'A-Z' 'a-z' | sort -u > RESULT_DIR/recon/candidates.txt
   wc -l < RESULT_DIR/recon/candidates.txt
   ```

3. Stage 2 — brute force the remaining name space when passive sources are thin. `ksubdomain` needs root for packet sending; `dnsx` plus `WORDLIST` is the unprivileged path:

   ```bash
   sudo toolkit/ksubdomain/ksubdomain enum -dl WORDLIST -d DOMAIN \
     -o RESULT_DIR/recon/ksubdomain.txt 2>/dev/null || true
   cat RESULT_DIR/recon/ksubdomain.txt >> RESULT_DIR/recon/candidates.txt 2>/dev/null || true
   sort -u RESULT_DIR/recon/candidates.txt -o RESULT_DIR/recon/candidates.txt
   ```

4. Stage 3 — resolve and keep only names with an address. This is the stage that usually shrinks the funnel by an order of magnitude:

   ```bash
   toolkit/dnsx/dnsx -l RESULT_DIR/recon/candidates.txt -a -resp -silent \
     -threads THREADS -o RESULT_DIR/recon/resolved.txt
   awk '{print $1}' RESULT_DIR/recon/resolved.txt | sort -u > RESULT_DIR/recon/live-names.txt
   awk '{print $2}' RESULT_DIR/recon/resolved.txt | tr ',' '\n' | sort -u > RESULT_DIR/recon/ips.txt
   wc -l RESULT_DIR/recon/live-names.txt RESULT_DIR/recon/ips.txt
   ```

   If `live-names.txt` is empty while `resolved.txt` has lines, the output format changed; inspect the first line before writing any parser downstream.

5. Stage 4 — port discovery on the resolved addresses, keeping only ports that matter for the next stage. Full range on a large range is slow, top-ports is the default compromise:

   ```bash
   toolkit/naabu/naabu -list RESULT_DIR/recon/ips.txt -top-ports 1000 \
     -rate RATE -scan-type c -o RESULT_DIR/recon/ports.txt
   awk -F: '{print $1":"$2}' RESULT_DIR/recon/ports.txt | sort -u > RESULT_DIR/recon/targets-web.txt
   grep -cE ':(80|443|8080|8443|8000|9000)$' RESULT_DIR/recon/targets-web.txt
   ```

   Zero web ports means the next stage has nothing to do — stop here, register the ports with `active-scan`, and report the funnel rather than forcing an HTTP pass.

6. Stage 5 — HTTP probing with the wrapper. Titles and tech detection here decide which hosts get attention later:

   ```bash
   pd-httpx -l RESULT_DIR/recon/live-names.txt -ports 80,443,8080,8443,8000,9000,8888 \
     -title -tech-detect -status-code -server -location -cdn -follow-redirects \
     -threads THREADS -rate-limit RATE -json -o RESULT_DIR/recon/httpx.json
   jq -r 'select(.status_code<400) | "\(.url) \(.status_code) \(.title // "-")"' \
     RESULT_DIR/recon/httpx.json | head -n 30
   ```

   Hosts answering `0` or with an empty `url` are dead or virtual-host mismatched; keep them in `RESULT_DIR/recon/httpx-dead.json` (`jq -c 'select(.status_code==0)'`) instead of discarding them, they become useful once a Host header or an internal resolver is found.

7. Stage 6 — register the survivors in one sweep, one call per IP, ports nested under the asset:

   ```
   redteam_asset_add
     ip: TARGET_IP
     state: live
     primary_name: DOMAIN
     provenance: active
     tool: naabu+httpx
     names: [{ name: "app.DOMAIN", kind: "domain" }]
     ports: [{ port: 443, service: "https", url: "https://app.DOMAIN/", title: "Portal",
               provenance: "active", tool: "pd-httpx" }]
   ```

8. Stage 7 — hand off. Write one manifest that names the file for each stage, so the next skill does not guess:

   ```bash
   { echo "candidates=RESULT_DIR/recon/candidates.txt"
     echo "live_names=RESULT_DIR/recon/live-names.txt"
     echo "web_targets=RESULT_DIR/recon/targets-web.txt"
     echo "http=RESULT_DIR/recon/httpx.json"; } > RESULT_DIR/recon/manifest.txt
   cat RESULT_DIR/recon/manifest.txt
   ```

   `web-fingerprint` and `nuclei-scan` consume `manifest.txt`, never a re-derived list.

9. One orchestrated re-run for the whole funnel, when it has to be repeatable:

   ```bash
   for s in subfinder dnsx naabu httpx; do
     printf '%s %s\n' "$s" "$(date -Is)" >> RESULT_DIR/recon/stage-log.txt
   done
   tail -n 4 RESULT_DIR/recon/stage-log.txt
   ```

## Output and evidence

Files under `RESULT_DIR/recon/`:

- `candidates.txt`, `ksubdomain.txt` — name space before resolution.
- `resolved.txt`, `live-names.txt`, `ips.txt` — resolution result in both directions.
- `ports.txt`, `targets-web.txt` — port discovery and the web subset.
- `httpx.json`, `httpx-dead.json` — per-host HTTP facts, one JSON object per line.
- `manifest.txt`, `stage-log.txt` — what ran, in which order, and where each artefact lives.

Tool rows: `redteam_asset_add` per live IP with `provenance=active`; `redteam_asset_link` `relation=resolves` for name-to-IP edges; `redteam_asset_test` with `status=testing` before the pipeline touches a host and `status=tested` plus a `surface` note afterwards.

Evidence is the stage file plus its line count. A total such as "34 names, 12 resolve, 3 web ports" is reportable only when the four files that produced it are on disk.

## Failure modes

- `subfinder: command not found` → toolkit not installed → run `bash $DSH_HOME/redteam/setup.sh --yes`, or seed `candidates.txt` from `passive-recon` output.
- `dnsx` returns nothing but `dig` resolves the same name → resolver list blocked or rate limited → add `-r 1.1.1.1,8.8.8.8` and lower `THREADS`.
- `ksubdomain` prints `permission denied` → packet sending needs root → run with `sudo`, or skip stage 2 entirely; the pipeline is designed to continue.
- `naabu` exits immediately with a raw-socket error → non-root default mode → add `-scan-type c` and expect it to be slower.
- `pd-httpx` prints version `0.27.x` and treats `-l` as an unknown flag → you are running the Python `httpx` CLI → call the wrapper, or the absolute path `toolkit/httpx/httpx`.
- A stage writes an empty file and the next stage silently succeeds on zero input → guard each stage with `[ -s <file> ] || { echo "stage empty" ; exit 0 ; }` so the funnel stops loudly.

## Notes

- Rate limits: `RATE` covers HTTP probing; Naabu has its own `-rate`. Keep total packets per second under what the operator agreed, and slow down when the target's edge starts answering 429.
- Opsec: this pipeline is loud — brute force and port scanning are visible in DNS and firewall logs. Run from `VPS_HOST` when the source IP must stay stable and separate from operator traffic.
- Idempotency: every stage overwrites its own file, so a full re-run is safe; the library upserts by IP and port. Keep `stage-log.txt` append-only so history survives the overwrite.
- Resume: re-run from the stage whose output file is missing or empty. `manifest.txt` is the map; never re-run a completed stage just because the shell was restarted.
- When a stage's yield drops sharply between runs, check the tool version before blaming the target.
