# FOFA Asset Discovery

Query the FOFA cyberspace search engine with structured fingerprints to find internet-facing assets belonging to an organisation — before any packet reaches them. The skill covers query construction, paging, deduplication and conversion of FOFA records into library assets with `provenance=passive`. Raw JSON responses and the exact query strings land in `RESULT_DIR/fofa/` so every result can be re-derived and re-run later.

## When to use

- You have an organisation name, certificate string, favicon hash or ASN and need the matching hosts.
- `passive-recon` produced hostnames but you suspect more IPs are exposed outside DNS.
- You need a technology census ("how many Weblogic 12.2.1.4 hosts answer on this range").
- You want a cheap second opinion before spending a scan window on a wide netblock.
- You are diffing exposure between two dates and need the same query replayed.

Not for: confirming what FOFA reports (`active-scan`, `pd-httpx`), vulnerability testing (`nuclei-scan`), or anything FOFA has no index for — internal-only ranges and non-HTTP services return nothing here.

## Prerequisites

- `curl` and `jq` — `apt install curl jq`.
- A FOFA account with API access. Take the key from the personal centre at `https://fofa.info`, then either put it in `$DSH_HOME/.env` as `FOFA_KEY=<key>` with `chmod 600`, or export it for the current shell. The skill reads it as `os.environ.get("FOFA_KEY", "")`, so an unset key simply disables this skill without breaking anything else.
- After editing `.env`, restart the host process (`dsh web`) so the value reaches the running session; an exported shell variable only affects commands started from that shell.

Self-check before any query — a working key returns `"error":false`:

```bash
curl -s "https://fofa.info/api/v1/info/my?key=$FOFA_KEY" | jq '{error, email, vip_level, remain_api_query}'
```

Fallback: if the REST API is unavailable, the same queries can be pasted into the FOFA web UI and the result table exported; the parsing steps below only need the fields, not the transport. Nothing in this skill is mandatory — the remaining workflows do not depend on it.

## Workflow

1. Prepare the workspace and confirm the key is present. Never echo the key into a log:

   ```bash
   mkdir -p RESULT_DIR/fofa
   if [ -n "${FOFA_KEY:-}" ]; then echo "key present"; else echo "key missing: skip FOFA"; fi
   ```

2. Establish the account quota, because a wide query with `size=10000` can burn a full day's allowance in one call:

   ```bash
   curl -s "https://fofa.info/api/v1/info/my?key=$FOFA_KEY" \
     | jq '{vip_level, remain_free_api_query, remain_api_query}' | tee RESULT_DIR/fofa/quota.json
   ```

   If `remain_api_query` is 0, stop and schedule the work for the next quota window instead of retrying — the API answers with an error object, not an empty result.

3. Build the base query from organisation identifiers. `base64` encoding is required for the `qbase64` parameter, and the plain query must be saved next to it for reproducibility:

   ```bash
   Q='domain="DOMAIN"'
   printf '%s' "$Q" > RESULT_DIR/fofa/query-1.txt
   Q64=$(printf '%s' "$Q" | base64 -w0)
   curl -s "https://fofa.info/api/v1/search/all?key=$FOFA_KEY&qbase64=$Q64&size=100&fields=host,ip,port,title,server,domain,update_time" \
     -o RESULT_DIR/fofa/page-1.json
   jq '.error, .size, (.results|length)' RESULT_DIR/fofa/page-1.json
   ```

   Iterate the query family rather than widening one query: certificate string (`cert="DOMAIN"`), favicon hash (`icon_hash="-1234567890"`), ASN (`asn="12345"`), and body or header fingerprints (`body="Copyright Acme"`, `header="X-Powered-By: Acme"`).

4. Page through results. The API is 1-indexed and caps `size` at 10000, so walk `page` explicitly and stop when a page is short:

   ```bash
   for p in 1 2 3; do
     curl -s "https://fofa.info/api/v1/search/all?key=$FOFA_KEY&qbase64=$Q64&size=100&page=$p&fields=host,ip,port,title,server" \
       -o "RESULT_DIR/fofa/page-$p.json"
     n=$(jq '.results|length' "RESULT_DIR/fofa/page-$p.json")
     echo "page $p -> $n"; [ "$n" -lt 100 ] && break
     sleep 2
   done
   jq -r '.results[]? | @tsv' RESULT_DIR/fofa/page-*.json | sort -u > RESULT_DIR/fofa/records.tsv
   wc -l < RESULT_DIR/fofa/records.tsv
   ```

5. Normalise into the two files every later step consumes — unique hosts and unique IPs:

   ```bash
   cut -f1 RESULT_DIR/fofa/records.tsv | sort -u > RESULT_DIR/fofa/hosts.txt
   cut -f2 RESULT_DIR/fofa/records.tsv | sort -u > RESULT_DIR/fofa/ips.txt
   cut -f3 RESULT_DIR/fofa/records.tsv | sort -n -u | paste -sd, - > RESULT_DIR/fofa/ports.csv
   cat RESULT_DIR/fofa/ports.csv
   ```

6. Filter out shared infrastructure before treating anything as an asset. A CDN or parking page answers for hundreds of unrelated domains:

   ```bash
   jq -r '.results[]? | select(.server|test("cloudflare|AkamaiGHost|awselb";"i")) | @tsv' \
     RESULT_DIR/fofa/page-*.json > RESULT_DIR/fofa/cdn.tsv
   comm -23 <(sort RESULT_DIR/fofa/ips.txt) <(cut -f2 RESULT_DIR/fofa/cdn.tsv | sort -u) \
     > RESULT_DIR/fofa/ips-filtered.txt
   wc -l RESULT_DIR/fofa/ips.txt RESULT_DIR/fofa/ips-filtered.txt
   ```

7. Record the assets. FOFA data is third-party observation, so it is `provenance=passive` until you confirm it yourself:

   ```
   redteam_asset_add
     ip: TARGET_IP
     primary_name: DOMAIN
     state: unknown
     provenance: passive
     tool: fofa
     names: [{ name: "oa.DOMAIN", kind: "domain", provenance: "passive" }]
     ports: [{ port: 443, service: "https", product: "nginx", title: "Acme OA",
               url: "https://oa.DOMAIN/", provenance: "passive", tool: "fofa" }]
   ```

8. Turn the query set into reusable evidence and note the identifiers that worked:

   ```bash
   cp RESULT_DIR/fofa/query-1.txt RESULT_DIR/fofa/query-index.txt
   jq -r '.results[]? | .title' RESULT_DIR/fofa/page-*.json | sort | uniq -c | sort -rn | head
   ```

   The most frequent title is the organisation's product name and usually yields a better `body=` query than the domain name does.

9. Hand off: the confirmed list must still be probed, and FOFA titles are not proof of a live host:

   ```bash
   head -n 50 RESULT_DIR/fofa/ips-filtered.txt > RESULT_DIR/fofa/next-targets.txt
   pd-httpx -l RESULT_DIR/fofa/hosts.txt -title -status-code -tech-detect -json \
     -o RESULT_DIR/fofa/verify.json
   jq -r 'select(.status_code>0) | .url' RESULT_DIR/fofa/verify.json | wc -l
   ```

   Promote only hosts that answer here; everything else stays `state=unknown` with a recorded limitation.

## Output and evidence

Files under `RESULT_DIR/fofa/`:

- `query-*.txt` — the plaintext query strings, one per line, the query set that reproduces the run.
- `page-*.json` — unparsed API responses, including any error objects.
- `records.tsv`, `hosts.txt`, `ips.txt`, `ports.csv` — normalised result sets.
- `cdn.tsv`, `ips-filtered.txt` — infrastructure removed and the reason it was removed.
- `verify.json` — the active probe of the FOFA claims.

Tool rows: `redteam_asset_add` with `provenance=passive`, `tool=fofa`; `redteam_asset_link` `relation=resolves` where FOFA gave both a host and an IP; `redteam_evidence_record` with `operation="fofa_query"`, `parameters` holding the query string, `result` holding `{total, returned, unique_ips}` and `limitations: ["third-party index", "CDN filtered"]`.

Evidence is the saved JSON response plus the query that produced it. A screenshot of the FOFA web UI is not evidence until the same query is stored in `query-*.txt`.

## Failure modes

- `{"error":true,"errmsg":"Unsupported query"}` → the plaintext query is invalid for the free tier or the field is not allowed → validate it in the web UI first, then copy the working form.
- `{"error":true,"errmsg":"... quota ..."}` → daily allowance exhausted → stop, record `limitations`, and schedule the wide query for the next window.
- Empty `results` with `error:false` → the query is valid but narrow → widen with `||` between alternatives (`domain="DOMAIN" || cert="DOMAIN"`), never with a bare wildcard.
- Base64 decode failure on the server side → `qbase64` lost a character in the shell → quote the variable, use `base64 -w0`, and confirm the length differs from the plain query.
- Thousands of hits on shared hosting → the query matches a template page → add `&& server!="cloudflare"` or filter afterwards with the CDN step.
- API answers but every host fails the active probe → the index is stale → report the gap; do not register FOFA hosts as `live`.

## Notes

- Rate limits: the free tier throttles per minute and per day. Two seconds between pages is enough; parallelising pages gets the key temporarily blocked.
- Opsec: FOFA queries contact a third party, not the target. The follow-up `pd-httpx` probe does touch the target, so keep that step under `RATE` and inside the approved window.
- Idempotency: re-running the same query is safe on the library side (upsert by IP and port), but it does consume quota. Cache the JSON and re-parse instead of re-querying.
- Resume: track completed queries in `query-index.txt` and skip any query already listed there.
- Never write the key into a report, a commit, or a command line that ends up in a shell history file. `chmod 600 $DSH_HOME/.env` and read it via the environment.
