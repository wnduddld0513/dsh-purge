# Web Fingerprinting

Decide what is actually running on a web port and how confident that conclusion is. The skill combines HTTP probe output (`pd-httpx -tech-detect`), `whatweb` plugin depth, favicon hashing, response-header and error-page analysis, and a small set of well-known management paths. Each conclusion is registered as a structured fingerprint on the port with its evidence and a confidence value, so later template selection can be traced back to the observation that caused it.

## When to use

- Ports are known and open on 80/443/8080/8443 and you must decide "what product is this".
- A login page gives no version banner and you need another anchor (favicon, cookie name, error page).
- You are choosing nuclei template groups and want them driven by observed products, not guesses.
- Two hosts answer identically and you suspect one is a reverse proxy in front of the other.
- A product was fingerprinted months ago and you need to confirm the version has not changed.

Not for: discovering which ports exist (`active-scan`), finding hidden paths (`dir-bruteforce`), proving a vulnerability (`nuclei-scan`), or reading public records (`passive-recon`). A fingerprint is an identification, not an assessment of security.

## Prerequisites

- `pd-httpx` on `PATH`, wrapping `toolkit/httpx/httpx`. The Python `httpx` CLI is a different program and rejects `-tech-detect`:

  ```bash
  printf '#!/usr/bin/env bash\nexec "${DSH_HOME:-$HOME/.dsh}/redteam/toolkit/httpx/httpx" "$@"\n' \
    > ~/.local/bin/pd-httpx && chmod +x ~/.local/bin/pd-httpx
  pd-httpx -version
  ```

- `whatweb` — `apt install whatweb`. `nuclei` — `apt install nuclei`, then `nuclei -update-templates` so the technology-detection templates exist.
- Optional: `python3` with `mmh3` (`pip install mmh3`) for favicon hashing; the wrapper script below degrades to a plain checksum when `mmh3` is absent.

Every method has a fallback: `curl -sI` and a careful read of headers can replace `whatweb`, and a sha256 of the favicon still identifies a product family even without the murmur hash. Nothing here is mandatory — one confirmed fingerprint from one method is a usable result.

## Workflow

1. Prepare the output directory and a host list that comes from a scanner, never from memory:

   ```bash
   mkdir -p RESULT_DIR/fingerprint
   awk -F: '$2 ~ /^(80|443|8000|8080|8443|8888|9000)$/ {print $1}' \
     RESULT_DIR/recon/ports.txt > RESULT_DIR/fingerprint/web-hosts.txt
   wc -l < RESULT_DIR/fingerprint/web-hosts.txt
   ```

2. Baseline probe with technology detection. Save the JSON, not the pretty output — the JSON keeps the per-host tech array that step 8 needs:

   ```bash
   pd-httpx -l RESULT_DIR/fingerprint/web-hosts.txt \
     -ports 80,443,8000,8080,8443,8888,9000 \
     -title -tech-detect -status-code -server -content-length -web-server -cname \
     -follow-redirects -threads THREADS -rate-limit RATE -json \
     -o RESULT_DIR/fingerprint/httpx.json
   jq -r 'select(.tech) | "\(.url) | \(.tech|join(","))"' RESULT_DIR/fingerprint/httpx.json | head
   ```

   Hosts with an empty `tech` array are not "unknown products" — they may be custom applications. They get the manual treatment in steps 4–6.

3. Depth pass with `whatweb` on the hosts that matter. Aggression 3 sends extra requests, so keep it to the interesting subset and stay under `RATE`:

   ```bash
   awk -F'|' 'NR<=20{print $1}' RESULT_DIR/fingerprint/httpx.json | tr -d ' "' \
     > RESULT_DIR/fingerprint/whatweb-targets.txt
   whatweb --aggression 3 --log-json RESULT_DIR/fingerprint/whatweb.json \
     --user-agent "Mozilla/5.0" -i RESULT_DIR/fingerprint/whatweb-targets.txt
   jq -r '.[] | "\(.target) \(.plugins|keys|join(","))"' RESULT_DIR/fingerprint/whatweb.json | head
   ```

4. Header-level identification with `curl` when both tools disagree or return nothing. The order and spelling of headers are themselves a fingerprint:

   ```bash
   curl -sS -D RESULT_DIR/fingerprint/h-TARGET_IP.txt -o /dev/null --max-time 15 \
     "http://TARGET_IP:PORT/" -H 'User-Agent: Mozilla/5.0'
   grep -iE '^(server|x-powered-by|x-aspnet-version|set-cookie|via|x-generator):' \
     RESULT_DIR/fingerprint/h-TARGET_IP.txt
   ```

   `Server: nginx` with `X-Powered-By: Shiro` is a different conclusion from `Server: nginx` alone.

5. Favicon hash. A favicon survives version upgrades and is one of the strongest anchors for third-party search queries:

   ```bash
   python3 - <<'PY' | tee RESULT_DIR/fingerprint/favicon.txt
   import hashlib, base64, sys, urllib.request
   url = "http://TARGET_IP:PORT/favicon.ico"
   try:
       raw = urllib.request.urlopen(url, timeout=10).read()
   except Exception as exc:
       print("fetch failed:", exc); sys.exit(0)
   b64 = base64.encodebytes(raw)
   print("sha256", hashlib.sha256(raw).hexdigest(), "bytes", len(raw))
   try:
       import mmh3
       print("mmh3", mmh3.hash(b64))
   except ImportError:
       print("mmh3 unavailable: compare sha256 instead")
   PY
   ```

6. Probe the small set of paths that identify whole product families. A single 200 on `/nacos/` is a much stronger statement than a title guess:

   ```bash
   for p in /actuator /actuator/env /nacos/ /console/ /manager/html /solr/ /api/ /swagger-ui.html \
            /druid/index.html /jenkins/ /phpinfo.php; do
     code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 "http://TARGET_IP:PORT$p")
     echo "$code $p"
   done | tee RESULT_DIR/fingerprint/paths.txt
   ```

   `401`/`403` on `/manager/html` still identifies a Tomcat manager; `404` identifies nothing.

7. Extract versions where the product exposes them, and treat absent versions as absent rather than inventing one:

   ```bash
   grep -rhoiE '(nginx|apache|tomcat|weblogic|shiro|spring|jenkins|gitlab|nacos)[/ ]?[0-9]+\.[0-9.]+' \
     RESULT_DIR/fingerprint/httpx.json RESULT_DIR/fingerprint/whatweb.json 2>/dev/null \
     | sort -u | tee RESULT_DIR/fingerprint/versions.txt
   ```

8. Register the fingerprints against the port. Confidence reflects the observation, not enthusiasm:

   ```
   redteam_asset_add
     ip: TARGET_IP
     state: live
     primary_name: DOMAIN
     provenance: active
     tool: pd-httpx
     ports: [{ port: 8080, service: "http", url: "http://TARGET_IP:8080/", title: "Acme OA",
               provenance: "active", tool: "pd-httpx",
               fingerprints: [
                 { category: "Web server", vendor: "nginx", product: "nginx", version: "1.18.0",
                   evidence: "Server header: nginx/1.18.0", confidence: 0.95 },
                 { category: "Framework", vendor: "Apache", product: "Shiro",
                   evidence: "Set-Cookie: rememberMe=deleteMe", confidence: 0.8 },
                 { category: "CMS", product: "Nacos", evidence: "HTTP 200 on /nacos/",
                   confidence: 0.7 }] }]
   ```

9. Produce the template seed list that `nuclei-scan` consumes, grouped by product:

   ```bash
   jq -r '.items[] | .ports[]? | .fingerprints[]? | "\(.product // .vendor // "unknown")\t\(.version // "-")"' \
     RESULT_DIR/fingerprint/library.json 2>/dev/null | sort -u \
     > RESULT_DIR/fingerprint/template-seed.tsv
   cut -f1 RESULT_DIR/fingerprint/template-seed.tsv | sort | uniq -c | sort -rn | head
   ```

## Output and evidence

Files under `RESULT_DIR/fingerprint/`:

- `web-hosts.txt` — the exact host list probed, taken from scanner output.
- `httpx.json`, `whatweb.json` — raw tool JSON, the primary evidence for every fingerprint.
- `h-*.txt`, `favicon.txt`, `paths.txt`, `versions.txt` — manual observations per host.
- `template-seed.tsv` — product/version pairs used to choose nuclei templates.

Tool rows: `redteam_asset_add` with nested `fingerprints[]` (each with `category`, `vendor`, `product`, `version`, `evidence`, `confidence`); `redteam_asset_test` when a host was fully profiled and no further surface remains (`status=no_surface`) or when a WAF blocks probing (`status=blocked`, `blocked=true`); `redteam_evidence_record` with `operation="web_fingerprint"`, `confidence="observed"`, `authority="tool-output"`.

Evidence is a header, a cookie, a path status code or a tool JSON entry that names the product. A title like "Acme Portal" identifies an application, not a product, and does not justify a version.

## Failure modes

- `pd-httpx: error: unknown flag -tech-detect` → you ran the Python `httpx` CLI → call `pd-httpx` or the absolute path `toolkit/httpx/httpx`.
- Every host reports `tech: []` → the probe used a `HEAD`-only path or the host needs a Host header → add `-follow-redirects` and probe by hostname instead of IP where a virtual host exists.
- A path returns `200` with the application's own 404 page → soft-404 → compare `content-length` and body hash against a known-bad path (`/this-path-should-not-exist-9137`).
- `whatweb` and `pd-httpx` disagree on the product → both may be right (proxy in front) → record two fingerprints with their own evidence rather than merging them into one guess.

## Notes

- Rate limits: `-rate-limit` applies per second across all hosts. Technology detection triples the request count compared to a plain probe, so budget for it before running a wide range.
- Opsec: path probing on management consoles is highly visible and can lock accounts on some appliances. Keep the path list short, and never send credentials while fingerprinting.
- Idempotency: fingerprints upsert per port and product, so re-running refreshes evidence and confidence instead of creating duplicates. A version change shows up as an updated row.
- Resume: `httpx.json` is append-only evidence; re-probe only hosts missing from it, and re-run `whatweb` only for hosts whose technology array is empty.
