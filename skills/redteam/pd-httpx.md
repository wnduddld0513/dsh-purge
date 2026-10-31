# PD-HTTPX Probing

Drive the ProjectDiscovery HTTP prober through its stable `pd-httpx` entry point and turn a flat list of hosts and ports into structured HTTP facts: status code, title, server, technology, redirect chain and content length, one JSON object per URL. This is the shared substrate for every later decision in the library — which hosts are alive, which are web, which product family they belong to. Output lands in `RESULT_DIR/http/`.

## When to use

- A port scan produced open `80`/`443`/`8080` style ports and you need to know which answer HTTP.
- You must deduplicate a large host list down to the URLs that actually return content.
- You want titles, server headers and technology arrays in one pass instead of one `curl` per host.
- You need virtual-host discovery on a shared IP before deciding the host is empty.
- You are about to run templates and want the exact URL list that will be scanned.

Not for: discovering subdomains (`recon-pipeline`), deep product identification beyond the technology array (`web-fingerprint`), path discovery (`dir-bruteforce`), or vulnerability checks (`nuclei-scan`).

## Prerequisites

- The ProjectDiscovery binary is installed by the setup script into `$DSH_HOME/redteam/toolkit/httpx/httpx`. Confirm it exists before writing any pipeline:

  ```bash
  bash $DSH_HOME/redteam/setup.sh --yes
  ls -l "${DSH_HOME:-$HOME/.dsh}/redteam/toolkit/httpx/httpx"
  ```

- Create the wrapper that shadows the unrelated Python `httpx` CLI. This is the only supported way to call the prober, because `/usr/bin/httpx` on some distributions is the Python library's command:

  ```bash
  printf '#!/usr/bin/env bash\nexec "${DSH_HOME:-$HOME/.dsh}/redteam/toolkit/httpx/httpx" "$@"\n' \
    > ~/.local/bin/pd-httpx && chmod +x ~/.local/bin/pd-httpx
  pd-httpx -version
  ```

- Fallback: a `curl` loop (`curl -sS -o /dev/null -w '%{http_code} %{size_download}\n'`) answers the liveness question for a short list. Every step below has a substitute; none is mandatory, and a ten-URL `curl` sweep is a valid result when the binary is unavailable.

## Workflow

1. Verify the entry point and its version before blaming a pipeline for empty output:

   ```bash
   command -v pd-httpx || echo "wrapper missing"
   pd-httpx -version
   pd-httpx -h | head -n 20
   ```

   If `-tech-detect` is rejected as an unknown flag, the wrapper is not in effect and the Python CLI is being executed. Rebuild the wrapper, do not try to install a second prober.

2. Build the target list from scanner output, one host:port per line. Never hand-write the list:

   ```bash
   mkdir -p RESULT_DIR/http
   awk -F'[ /]' '{print $1":"$2}' RESULT_DIR/recon/ports.txt | sort -u \
     > RESULT_DIR/http/targets.txt
   wc -l < RESULT_DIR/http/targets.txt
   ```

3. Probe with the fact set you will actually use. Keep `-json` on for machine parsing and add a text run only when a human will read it:

   ```bash
   pd-httpx -l RESULT_DIR/http/targets.txt \
     -ports 80,443,8000,8080,8443,8888,9000,9090,10000 \
     -status-code -title -tech-detect -web-server -content-length -cname -location \
     -follow-redirects -threads THREADS -rate-limit RATE -timeout 10 -retries 2 \
     -json -o RESULT_DIR/http/httpx.json
   jq -r '[.url, .status_code, .title, (.tech // [] | join(","))] | @tsv' \
     RESULT_DIR/http/httpx.json | head -n 20
   ```

4. Separate live web surface from noise with `jq`, so every later stage consumes a clean list:

   ```bash
   jq -r 'select(.status_code >= 200 and .status_code < 400) | .url' \
     RESULT_DIR/http/httpx.json | sort -u > RESULT_DIR/http/live-urls.txt
   jq -r 'select(.status_code >= 400) | "\(.status_code)\t\(.url)"' \
     RESULT_DIR/http/httpx.json | sort -u > RESULT_DIR/http/error-urls.txt
   wc -l RESULT_DIR/http/live-urls.txt RESULT_DIR/http/error-urls.txt
   ```

5. Collapse redirect chains and duplicate content. A dozen hostnames pointing at one application is a routing fact worth recording, not twelve separate assets:

   ```bash
   jq -r 'select(.chain) | .chain[]?' RESULT_DIR/http/httpx.json | sort -u \
     > RESULT_DIR/http/redirect-targets.txt
   jq -r '[.title // "-", .content_length // 0] | @tsv' RESULT_DIR/http/httpx.json \
     | sort | uniq -c | sort -rn | head
   ```

6. Virtual-host discovery when several names must be tested against one IP:

   ```bash
   pd-httpx -l RESULT_DIR/http/targets.txt -vhost \
     -status-code -title -content-length -json \
     -o RESULT_DIR/http/httpx-vhost.json
   jq -r 'select(.vhost != false) | "\(.vhost) -> \(.url)"' RESULT_DIR/http/httpx-vhost.json
   ```

7. Re-probe only what is missing, so a long run is resumable and cheap:

   ```bash
   comm -23 <(sort -u RESULT_DIR/http/targets.txt) \
     <(jq -r '.input // .host // empty' RESULT_DIR/http/httpx.json | sort -u) \
     > RESULT_DIR/http/targets-missing.txt
   pd-httpx -l RESULT_DIR/http/targets-missing.txt -status-code -title -json \
     | tee -a RESULT_DIR/http/httpx.json
   ```

8. Feed the recorded asset with URLs and titles for every live web port:

   ```
   redteam_asset_add
     ip: TARGET_IP
     state: live
     primary_name: DOMAIN
     provenance: active
     tool: pd-httpx
     ports: [{ port: 8080, service: "http", url: "http://TARGET_IP:8080/",
               title: "Jenkins", provenance: "active", tool: "pd-httpx" }]
   ```

## Output and evidence

Files under `RESULT_DIR/http/`:

- `targets.txt`, `targets-missing.txt` — the input lists, exact and reproducible.
- `httpx.json` — one JSON object per probed URL; the primary evidence for every liveness claim.
- `live-urls.txt`, `error-urls.txt` — filtered view, the handoff to scanning and fingerprinting.
- `redirect-targets.txt`, `httpx-vhost.json` — routing and virtual-host findings.

Tool rows: `redteam_asset_add` for each live web port, carrying `url`, `title` and `tool=pd-httpx`; `redteam_asset_test` when a host was probed and produced nothing (`status=no_surface`) or was blocked by a filter (`status=blocked`, `blocked=true`).

Evidence is the JSON object for the URL: status, title and server header together. A host that answers `403` is live and worth recording — "no content" is not the same as "no service".

## Failure modes

- `pd-httpx: error: unknown flag --tech-detect` → the Python `httpx` CLI answered → rebuild the wrapper from Prerequisites and re-check with `pd-httpx -version`.
- Empty output with a non-empty target list → the list has CRLF line endings from a Windows export → `tr -d '\r' < targets.txt > targets-clean.txt` and re-run.
- Everything reports `-` for title and server → the target is HTTPS-only or drops the request → add `-follow-redirects` and include the scheme in the input lines.
- The run dies partway on a large list → rate limiter or memory → drop `-threads` to half, keep `-rate-limit`, and resume with step 7 instead of restarting the full sweep.
- Duplicate URLs appear after a resume → the appended file was merged without deduplication → `jq -s 'unique_by(.url)'` over both files before use.
- A shared hosting IP shows one title for every name → you are probing by IP and the vhost is unresolved → probe by hostname, or run step 6 with `Host:` names drawn from certificate SANs.

## Notes

- Rate limits: `-rate-limit` is global across the process; `-threads` only controls parallelism. On a third-party network keep the rate under `RATE` and lower it when `429` or `503` appears.
- Opsec: technology detection adds requests per host and is visible in the server log. Against a monitored target, prefer one wide pass over repeated small ones.
- Idempotency: the prober always writes a fresh object per URL; the deduplication step is what makes the file idempotent. Never edit `httpx.json` by hand — filter into a new file.
- Resume: keep `targets.txt` immutable for the life of an engagement. New discovery goes into a new file, and the missing-target diff keeps the two consistent.
