# Directory and Content Brute Force

Discover paths, files and endpoints that are not linked from the application: admin panels, backup archives, exposed configuration, API routes, upload directories and editor leftovers. The skill covers baseline calibration, tool selection, filtering rules that keep the result list honest, and the recording step that turns a hit into a queryable endpoint on the asset. Wordlists, raw tool output and the filtered hit list live under `RESULT_DIR/brute/`.

## When to use

- A web application answers on `PORT` and the visible links are clearly incomplete.
- The fingerprint suggests a known product and you want its standard paths confirmed.
- You need backups, `.git`, `.env`, `WEB-INF`, `actuator` or `swagger` checked on a specific host.
- An application returns `403` on `/admin` and you want sibling paths before deciding it is closed.
- A previous run produced thousands of `200`s and you need a calibrated, trustworthy pass.

Not for: finding which hosts exist (`recon-pipeline`), deciding what product is running (`web-fingerprint`), credential attacks against a login form, or injection testing. A directory hit is an exposure candidate; whether it is a finding depends on what it returns.

## Prerequisites

- `ffuf` — `apt install ffuf`; `feroxbuster` and `gobuster` — `apt install feroxbuster gobuster`.
- `toolkit/dirsearch/dirsearch` is not part of the setup download list. Fetch the source package from the `maurosoria/dirsearch` GitHub releases into `$DSH_HOME/redteam/toolkit/dirsearch/` and make the entry point executable (`chmod +x`); until then use `feroxbuster`, `ffuf` or `gobuster`.
- A wordlist. Any of the distribution lists works; keep the path in a variable so the command lines stay copy-pasteable:

  ```bash
  WORDLIST=/usr/share/wordlists/dirb/common.txt
  ls -l "$WORDLIST" || WORDLIST=/usr/share/seclists/Discovery/Web-Content/raft-small-words.txt
  wc -l "$WORDLIST"
  ```

Every step has a substitute: no `ffuf` means `gobuster dir`, no wordlist means a 200-line hand-written list of product paths. Nothing here is mandatory — a nine-path probe of known product routes is still useful output.

## Workflow

1. Calibrate before brute forcing. Establish what a miss looks like on this host; every later filter depends on it:

   ```bash
   mkdir -p RESULT_DIR/brute
   for p in /this-path-should-not-exist-9137 / /robots.txt; do
     curl -s -o /dev/null -w "%{http_code} %{size_download} %{time_total} $p\n" \
       --max-time 10 "http://TARGET_IP:PORT$p"
   done | tee RESULT_DIR/brute/baseline.txt
   ```

   If the unknown path returns `200`, the application has a soft 404 and size filtering alone will not work — note the response size of the miss, it becomes the `-fs` value in step 3.

2. Pick the tool by job shape. `ffuf` for tight filter control, `feroxbuster` for recursion and resume, `gobuster` when only status codes matter:

   ```bash
   ffuf -V; feroxbuster --version | head -n 1; gobuster version
   ```

3. Run the calibrated pass. `-ac` enables automatic calibration; `-fs` excludes the size measured in step 1. Two filters together are usually enough:

   ```bash
   ffuf -u "http://TARGET_IP:PORT/FUZZ" -w "$WORDLIST" \
     -mc 200,204,301,302,307,401,403,405,500 -ac -fs 0 \
     -t THREADS -rate RATE -timeout 10 -recursion -recursion-depth 2 \
     -e .php,.bak,.zip,.tar.gz,.old,.txt,.json \
     -o RESULT_DIR/brute/ffuf-http.json -of json
   jq -r '.results[] | "\(.status) \(.length) \(.url)"' RESULT_DIR/brute/ffuf-http.json | head -n 40
   ```

   Keep `-rate` explicit. Unbounded concurrency against a small appliance is the fastest way to get the source IP blocked and the application restarted mid-run.

4. When hit counts explode, tighten filters instead of lowering `-mc`. Count first, then decide:

   ```bash
   jq '.results | length' RESULT_DIR/brute/ffuf-http.json
   jq -r '.results[].length' RESULT_DIR/brute/ffuf-http.json | sort -n | uniq -c | sort -rn | head
   ```

   A single dominant length is the soft-404 body; exclude it with `-fs <len>` and re-run, rather than discarding the whole result file.

5. Recursive and resume pass with `feroxbuster` when step 3 found directories worth descending into:

   ```bash
   feroxbuster -u "http://TARGET_IP:PORT/" -w "$WORDLIST" -t THREADS --rate-limit RATE \
     -d 3 -x php,zip,bak,txt -C 404 -o RESULT_DIR/brute/ferox.txt \
     --json -o RESULT_DIR/brute/ferox.json --resume-from RESULT_DIR/brute/ferox.state
   ```

6. Second pass on a product-specific path list, which finds things a generic wordlist never contains:

   ```bash
   printf '%s\n' actuator/env swagger-ui.html v2/api-docs nacos/ console/ manager/html \
     druid/index.html .git/HEAD .svn/entries WEB-INF/web.xml server-status phpinfo.php \
     > RESULT_DIR/brute/product-paths.txt
   ffuf -u "http://TARGET_IP:PORT/FUZZ" -w RESULT_DIR/brute/product-paths.txt \
     -mc all -fc 404 -t 10 -rate RATE -o RESULT_DIR/brute/ffuf-product.json -of json
   jq -r '.results[] | "\(.status) \(.url)"' RESULT_DIR/brute/ffuf-product.json
   ```

7. Verify each hit that matters. A `200` is not an exposure until the body says something:

   ```bash
   while read -r url; do
     echo "== $url"
     curl -s --max-time 10 "$url" | head -c 400; echo
   done < RESULT_DIR/brute/hits.txt | tee RESULT_DIR/brute/bodies.txt
   ```

   Write `hits.txt` from the filtered JSON (`jq -r '.results[] | select(.status!=404) | .url'`) so the verification loop covers exactly what will be reported.

8. Register the exposed endpoints on the port, and record anything that leaks data as a candidate vulnerability with the request that proves it:

   ```
   redteam_asset_add
     ip: TARGET_IP
     state: live
     provenance: active
     tool: ffuf
     ports: [{ port: 8080, service: "http", url: "http://TARGET_IP:8080/actuator/env",
               title: "Spring Boot Actuator", provenance: "active", tool: "ffuf",
               fingerprints: [{ category: "Framework", vendor: "VMware", product: "Spring Boot",
                                evidence: "HTTP 200 on /actuator/env", confidence: 0.85 }] }]
   ```

   ```
   redteam_vuln_add
     title: "Spring Boot Actuator env exposed without authentication"
     severity: medium
     status: candidate
     target: "http://TARGET_IP:8080/actuator/env"
     source: ffuf
     confidence: 0.8
     evidence: "GET /actuator/env -> 200, body contains spring.datasource.url; body saved at brute/bodies.txt"
   ```

9. Capture the raw request for anything that will be reported, so the report can replay it:

   ```
   redteam_http_evidence_add
     method: GET
     url: "http://TARGET_IP:8080/actuator/env"
     status: 200
     label: "unauthenticated actuator env"
     request: "GET /actuator/env HTTP/1.1\nHost: TARGET_IP:8080\nUser-Agent: Mozilla/5.0\nAccept: */*\nConnection: close\n\n"
     response: "<first 2 KB of the body>"
   ```

## Output and evidence

Files under `RESULT_DIR/brute/`:

- `baseline.txt` — status, size and latency of a known-miss path; the basis for every filter.
- `ffuf-http.json`, `ffuf-product.json`, `ferox.json` — raw tool output, unfiltered.
- `product-paths.txt`, `hits.txt` — the probe list and the verified hit list.
- `bodies.txt` — the first bytes of every hit, the artefact that proves an exposure.
- `ferox.state` — resume state for long recursive runs.

Tool rows: `redteam_asset_add` to attach the discovered endpoint URL to its port; `redteam_vuln_add` with `status=candidate` for exposures and `evidence` naming the request and the body file; `redteam_http_evidence_add` for the replayable request of each reported hit; `redteam_asset_test` with `surface` listing paths still untested.

Evidence is a status code plus a body excerpt plus the exact path that produced them. A directory name in a wordlist is a guess; `200` with recognisable content is evidence.

## Failure modes

- Thousands of `200` results of identical length → soft-404 → measure a guaranteed-miss path and add `-fs <len>`, then re-run; never delete the first result file, it documents the calibration error.
- `ffuf` prints `WARN Failed to read ... wordlist` → path wrong or list compressed → unzip the list or fix `WORDLIST`; check with `wc -l "$WORDLIST"` before the run.
- The application starts returning `429` or `503` partway through → rate too high or a rate limiter tripped → halve `-rate`, wait a few minutes, resume from the tool's own state file.
- `feroxbuster` reports `recursion depth reached` and stops early → `-d` too small for the tree → raise depth on the specific subtree, not across the whole host.
- Hits appear only with extensions and never bare → the application rewrites extensionless requests → add the extension set from step 3 and keep `-mc` wide enough to see `403`.
- Every request is blocked with a WAF challenge page → fingerprint the WAF first; slow down, change the user agent, and record `status=blocked` in `redteam_asset_test` instead of brute forcing harder.

## Notes

- Rate limits: keep total requests per second under the agreed `RATE`. A content-discovery pass is the noisiest thing in this library after port scanning; a blocked IP ends the whole window.
- Opsec: `-e .zip,.bak,.old` requests against production file servers generate real load. Schedule wide runs outside business hours and prefer the product-path list over the generic wordlist first.
- Idempotency: the tool writes its own output file, so overwrite it per run and keep the timestamped copy (`cp ffuf-http.json ffuf-http-$(date +%s).json`) if two passes must be compared.
- Resume: `feroxbuster --resume-from` and `ffuf` restart-from-wordlist-line both work; record the wordlist path and line offset in `baseline.txt` so a resumed run is provably the same pass.
- Keep `-t` modest on appliances. Twenty threads against embedded hardware is enough; a hundred turns a discovery run into an outage.
