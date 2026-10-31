# Nuclei Scanning

Run template-based checks against a curated target list and triage the results into confirmed, candidate and false-positive findings. This skill covers target selection, template scoping, rate control, out-of-band interaction through `OAST_DOMAIN`, JSON output, and the manual verification step that decides whether a template hit is a real finding. Raw output lands under `RESULT_DIR/nuclei/`.

## When to use

- Fingerprinting identified products and you want the matching checks run.
- A specific CVE is suspected and a template exists for it.
- You need a broad, low-noise sweep for exposures, default logins and misconfigurations.
- A previous scan produced hits that need triage before they reach a report.
- You want out-of-band confirmation of a blind issue before believing it.

Not for: host discovery (`active-scan`), path brute forcing (`dir-bruteforce`), or judging impact — a template hit is a signal, and the finding is written after manual verification.

## Prerequisites

- `nuclei` — `apt install nuclei`. Templates arrive with the setup script or through `nuclei -update-templates`; verify before scanning with `nuclei -tl | wc -l`.
- A target list from `RESULT_DIR/http/live-urls.txt` or `RESULT_DIR/recon/ports.txt`. Scanning an unverified host list wastes requests and creates ambiguous results.
- Optional: an interaction server. Set the address in a corpus file the tool reads, never in a value that ends up in a report:

  ```bash
  nuclei -version
  nuclei -tl 2>/dev/null | wc -l
  ```

Fallbacks: any single template can be supplied with `-t path/to/template.yaml` when tag filtering is unavailable; a manual `curl` with proof markers substitutes for an out-of-band template. Nothing here is mandatory.

## Workflow

1. Confirm the template corpus before scanning. A scan against zero loaded templates reports clean and proves nothing:

   ```bash
   mkdir -p RESULT_DIR/nuclei
   n=$(nuclei -tl 2>/dev/null | wc -l); echo "templates loaded: $n"
   [ "$n" -gt 1000 ] || echo "corpus incomplete - see nuclei-templates"
   ```

2. Snapshot the target list and deduplicate. One URL twice means duplicate findings:

   ```bash
   sort -u RESULT_DIR/http/live-urls.txt > RESULT_DIR/nuclei/targets.txt
   wc -l < RESULT_DIR/nuclei/targets.txt
   head -n 5 RESULT_DIR/nuclei/targets.txt
   ```

3. Start with a narrow, low-risk tag set. Exclude the tags that generate load or false positives on first contact:

   ```bash
   nuclei -l RESULT_DIR/nuclei/targets.txt \
     -tags cve,exposure,misconfig,default-login,tech \
     -etags dos,fuzz,intrusive,brute-force \
     -severity critical,high,medium \
     -rl RATE -c THREADS -timeout 10 -retries 1 -stats \
     -jsonl -o RESULT_DIR/nuclei/scan-narrow.jsonl 2>&1 | tail -n 20
   ```

4. Read the summary line before reading the hits. `matched` versus `requests` tells you whether the rate was adequate:

   ```bash
   tail -n 30 RESULT_DIR/nuclei/scan-narrow.jsonl >/dev/null 2>&1 || true
   jq -r '.templateID' RESULT_DIR/nuclei/scan-narrow.jsonl 2>/dev/null | sort | uniq -c | sort -rn | head
   ```

   Under about a hundred requests on a list of dozens of hosts means most targets timed out or were filtered — fix reachability before widening the tag set.

5. Widen by product, using the fingerprint seed list rather than a global tag sweep:

   ```bash
   cut -f1 RESULT_DIR/fingerprint/template-seed.tsv 2>/dev/null | sort -u | head -n 20
   nuclei -l RESULT_DIR/nuclei/targets.txt -tags apache,tomcat,spring,nacos,jenkins \
     -rl RATE -c THREADS -jsonl -o RESULT_DIR/nuclei/scan-product.jsonl
   jq -r '"\(.info.severity)\t\(.templateID)\t\(.matched-at)"' RESULT_DIR/nuclei/scan-product.jsonl | sort -u
   ```

6. Out-of-band pass for blind issues. Only run when the interaction server is reachable, and keep the poll interval explicit:

   ```bash
   OAST_DOMAIN=OAST_DOMAIN
   nuclei -l RESULT_DIR/nuclei/targets.txt -tags ssrf,blind-xss,rce,oob \
     -interactsh-url "https://$OAST_DOMAIN" -interactions-poll-duration 10 \
     -rl RATE -c 5 -jsonl -o RESULT_DIR/nuclei/scan-oast.jsonl
   jq -r 'select(.interaction) | "\(.templateID)\t\(.matched-at)"' RESULT_DIR/nuclei/scan-oast.jsonl
   ```

7. Triage every hit manually. A template match is a hypothesis; the response body decides. Replay the match with the same path and check what the template claimed:

   ```bash
   jq -r '"\(.templateID)\t\(.matched-at)"' RESULT_DIR/nuclei/scan-narrow.jsonl \
     | sort -u > RESULT_DIR/nuclei/hits.tsv
   while IFS=$'\t' read -r id url; do
     code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$url")
     printf '%s\t%s\t%s\n' "$id" "$code" "$url"
   done < RESULT_DIR/nuclei/hits.tsv | tee RESULT_DIR/nuclei/triage.tsv
   ```

8. Record the confirmed and the candidate hits separately. Severity from the template is a starting point, not the final word:

   ```
   redteam_vuln_add
     title: "Apache Tomcat AJP file read (Ghostcat)"
     severity: high
     status: candidate
     target: "http://TARGET_IP:8080/"
     source: nuclei
     cve: CVE-2020-1938
     confidence: 0.7
     evidence: "template CVE-2020-1938 matched; triage.tsv shows 200 on /WEB-INF/web.xml; raw JSON nuclei/scan-narrow.jsonl"
   ```

9. Attach the replayable request for each reported hit, so a reader can reproduce it without the tool:

   ```
   redteam_http_evidence_add
     method: GET
     url: "http://TARGET_IP:8080/"
     status: 200
     label: "nuclei CVE-2020-1938 match"
     vuln_id: <id returned by redteam_vuln_add>
     request: "GET / HTTP/1.1\nHost: TARGET_IP:8080\nUser-Agent: Mozilla/5.0\nConnection: close\n\n"
   ```

## Output and evidence

Files under `RESULT_DIR/nuclei/`:

- `targets.txt` — the deduplicated scan input.
- `scan-narrow.jsonl`, `scan-product.jsonl`, `scan-oast.jsonl` — raw per-match JSON, append-only.
- `hits.tsv`, `triage.tsv` — unique matches and their manual replay result.
- `escalate/` — one directory per hit worth deeper work, with the template name in the path.

Tool rows: `redteam_vuln_add` with `status=candidate` until replay confirms, then `status=confirmed` plus `evidence`; `redteam_http_evidence_add` for the replayable request; `redteam_attack_file_add` with `kind=poc` when a working request is worth keeping as a reusable template; `redteam_unknown_record` for a suspicious response the templates do not cover.

Evidence is a template id plus a replayed request plus an observed response. A JSON line alone is a claim from a third-party template; the replay is what makes it yours.

## Failure modes

- Scan finishes in seconds with zero matches on a large list → templates not loaded → check `nuclei -tl` first; a clean result from an empty corpus is meaningless.
- Many `could not connect` errors → targets are stale or filtered by a WAF → re-verify with `pd-httpx` before scanning, and record blocked hosts in `redteam_asset_test`.
- Everything is `info` severity and nothing else → the tag set is dominated by tech-detection → narrow to `cve,exposure,misconfig` and raise `-severity`.
- The scan stalls on a few hosts → a template waiting on a timeout → lower `-timeout`, keep `-retries 1`, and re-run the remainder separately.
- Out-of-band templates never confirm → interaction server unreachable from the target → verify egress with a benign callback first; do not report a blind issue on a template match alone.
- Dozens of duplicate findings for one URL → the list was not deduplicated → step 2, and dedupe output with `jq -s 'unique_by(.templateID + .matched-at)'`.
- A hit looks real but the body is a WAF block page → the template matched a substring → compare against the error page from `dir-bruteforce` baseline and mark `false-positive`.

## Notes

- Rate limits: `-rl` is requests per second across the whole run; `-c` is templates in parallel. Keep `-rl` at `RATE` and `-c` modest on appliances. Nuclei is the heaviest request generator in this library.
- Opsec: never include `dos` or `fuzz` tags against production without explicit scheduling. A single intrusive template can take a service down and end the engagement window.
- Idempotency: matches are appended to JSONL per run. Deduplicate by `templateID + matched-at` when combining runs, and keep the run timestamp in the filename for a second pass.
- Resume: split `targets.txt` by host and run per batch; a completed batch is never re-scanned. Keep the batch list beside the output so coverage is auditable.
- Rerun after fingerprint changes. A template set chosen for the previous product is not the right set for a host that has since been reinstalled.
