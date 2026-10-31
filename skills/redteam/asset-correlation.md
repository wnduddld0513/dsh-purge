# Asset Correlation

Turn a pile of independently collected observations into one queryable asset library: merge duplicates, resolve contradictions, link hosts that share certificates or ranges, and surface the gaps that make the inventory look complete when it is not. This skill depends on no external tool — it is record work over the library itself — and it produces a written correlation report under `RESULT_DIR/correlation/` plus relationship edges in the asset graph.

## When to use

- Several collection passes (passive, FOFA, scanning) registered overlapping hosts and the counts no longer match reality.
- The same IP appears with three different hostnames and you must decide which one is primary.
- You need the internal/external split before deciding what to attack first.
- A reporting step needs "how many distinct assets, ports and products" from one authoritative source.
- You suspect two engagements' worth of names belong to one organisation and need edges to prove it.

Not for: discovering new assets (`passive-recon`, `active-scan`, `fofa-recon`), fingerprinting (`web-fingerprint`), or vulnerability work (`nuclei-scan`). If this skill needs a new observation, it is the wrong skill — collect first, correlate after.

## Prerequisites

- No external binary and no environment variable. The work is done with the `redteam_*` library tools: `redteam_asset_query`, `redteam_asset_get`, `redteam_asset_stats`, `redteam_asset_graph`, `redteam_asset_link`, `redteam_domain_index`, and `redteam_asset_test`.
- Write access to `RESULT_DIR/correlation/` for the report and the intermediate dumps.
- A populated library. Correlation over an empty library produces a correct but useless report.

Fallback: if `redteam_asset_link` is unavailable in the running build, the same edges can be written into `RESULT_DIR/correlation/edges.tsv` and replayed later; the analysis itself still works from `redteam_asset_query` output. Nothing here is mandatory.

## Workflow

1. Measure the library before touching it, so the effect of the merge is visible afterwards:

   ```
   redteam_asset_stats
   ```

   Save the numbers to `RESULT_DIR/correlation/stats-before.json`. If `assets` is 0, stop: there is nothing to correlate.

2. Dump the current inventory in one pass and normalise it to a TSV the rest of the workflow reads:

   ```
   redteam_asset_query
     limit: 200
     sort: ip
   ```

   ```bash
   mkdir -p RESULT_DIR/correlation
   jq -r '.items[] | [.ip, (.primary_name // "-"), (.state // "unknown"), (.provenance // "-"),
                     ([.ports[]?.port] | join(","))] | @tsv' RESULT_DIR/correlation/assets.json \
     | column -t -s $'\t' | tee RESULT_DIR/correlation/assets.tsv
   wc -l < RESULT_DIR/correlation/assets.tsv
   ```

3. Find duplicate identities. One IP with several names is normal; several IPs claiming the same primary name is a contradiction that must be resolved:

   ```bash
   awk -F'\t' '$2!="-"{print $2"\t"$1}' RESULT_DIR/correlation/assets.tsv \
     | sort | awk -F'\t' '{c[$1]++; v[$1]=v[$1]" "$2} END{for(k in c) if(c[k]>1) print k, v[k]}' \
     | tee RESULT_DIR/correlation/duplicate-names.txt
   ```

   For each conflict, open the asset (`redteam_asset_get id=<n>`) and keep the name with the newest observed `last_seen`; the older name becomes an alias in the `names` array, not the primary.

4. Group by segment. A /24 with many unrelated-looking assets usually means shared hosting, and that changes how much weight a single finding deserves:

   ```bash
   awk -F'\t' '{split($1,a,"."); print a[1]"."a[2]"."a[3]".0/24"}' RESULT_DIR/correlation/assets.tsv \
     | sort | uniq -c | sort -rn | tee RESULT_DIR/correlation/segments.txt
   ```

   Cross-check against `redteam_domain_index`: a segment where every asset resolves from one domain is owned; a segment with dozens of unrelated domains is a hosting provider.

5. Check the internal/external dimension, which the library derives from the address itself:

   ```
   redteam_asset_query
     scope: internal
     limit: 200
   ```

   Internal rows are the pivot targets; external rows are the entry candidates. Record the split in `RESULT_DIR/correlation/scope-split.txt` as two counts.

6. Write the edges that the observations already prove. Each edge is a claim with a confidence, and the weakest justifiable one is better than a strong guess:

   ```
   redteam_asset_link src_kind=domain src_id=DOMAIN dst_kind=asset dst_id=10.0.0.5 relation=resolves confidence=1.0
   redteam_asset_link src_kind=asset src_id=10.0.0.5 dst_kind=asset dst_id=10.0.0.9 relation=shares_cert confidence=0.9
   redteam_asset_link src_kind=segment src_id=10.0.0.0/24 dst_kind=asset dst_id=10.0.0.5 relation=contains confidence=1.0
   ```

   Useful relations: `resolves`, `exposes`, `contains`, `trusts`, `shares_cert`, `same_operator`. Only `contains` and `resolves` should carry confidence near 1.0; the rest are inferences.

7. Read the graph back and look for the shapes that matter — a host reachable from two names, a segment with a single exposed management port:

   ```
   redteam_asset_graph
     cidr: TARGET_IP/24
     maxNodes: 300
   ```

   When the tool refuses because the node count is too high, narrow to one /24 at a time; a refusal is the signal to work per segment, not to raise the limit blindly.

8. Find the gaps, which is the real deliverable. Every asset in one of these states is an unfinished thread, not a clean result:

   ```bash
   awk -F'\t' '$5==""{print "NO_PORTS", $1}' RESULT_DIR/correlation/assets.tsv \
     | tee RESULT_DIR/correlation/gaps.txt
   awk -F'\t' '$2=="-"{print "NO_NAME", $1}' RESULT_DIR/correlation/assets.tsv \
     | tee -a RESULT_DIR/correlation/gaps.txt
   awk -F'\t' '$3=="unknown"{print "UNVERIFIED", $1}' RESULT_DIR/correlation/assets.tsv \
     | tee -a RESULT_DIR/correlation/gaps.txt
   sort RESULT_DIR/correlation/gaps.txt | uniq -c | sort -rn
   ```

9. Write the correlation report and re-measure:

   ```bash
   { echo "# Correlation report"; echo; echo "- generated: $(date -Is)"
     echo "- assets: $(wc -l < RESULT_DIR/correlation/assets.tsv)"
     echo "- duplicate names: $(wc -l < RESULT_DIR/correlation/duplicate-names.txt)"
     echo "- segments: $(wc -l < RESULT_DIR/correlation/segments.txt)"
     echo "- open gaps: $(wc -l < RESULT_DIR/correlation/gaps.txt)"; } \
     > RESULT_DIR/correlation/report.md
   cat RESULT_DIR/correlation/report.md
   ```

   Then run `redteam_asset_stats` again and compare with `stats-before.json`; a merge that produced no change in counts either did nothing or was not needed.

## Output and evidence

Files under `RESULT_DIR/correlation/`:

- `stats-before.json` — the measurement the work is judged against.
- `assets.tsv`, `assets.json` — the normalised inventory used by every awk step.
- `duplicate-names.txt`, `segments.txt`, `scope-split.txt` — the three structural views.
- `gaps.txt`, `report.md` — unfinished threads and the human-readable summary.

Tool rows: `redteam_asset_link` for every proven edge; `redteam_asset_add` only to add alias names to an existing IP (never to create a duplicate asset); `redteam_asset_test` with `surface` notes for assets that correlate to a promising target; `redteam_evidence_record` with `operation="asset_correlation"`, `confidence="derived"`, `authority="database-record"` and `limitations: ["library data only"]`.

Evidence is a queryable library row plus the edge that explains how it is reachable. "We have 120 assets" is a count, not a finding; "10.0.0.5 is reachable from two names and one certificate" is.

## Failure modes

- `redteam_asset_stats` reports assets but all port counts are 0 → collection registered IPs only → run `active-scan` before drawing conclusions; correlation cannot invent ports.
- The same host appears twice with different spellings (`oa.DOMAIN` vs `OA.domain`) → case-sensitive input upstream → normalise to lowercase before registering, and merge with the alias field.
- `redteam_asset_graph` refuses with a node-count error → scope too wide → work one /24 at a time and record each partial graph separately.
- Confidence values drift upward over successive runs → each re-run raising an inference to certainty → keep the original confidence and add a new edge only when a new observation justifies it.
- `awk` reports a segment with 200 hosts, all from different domains → shared hosting → drop that segment from ownership reasoning and note it in the report.
- The report says everything is complete while `gaps.txt` is long → the gaps step was skipped → treat `gaps.txt` as a required section, not an optional check.

## Notes

- Rate limits: none, this skill is local. Do not run it while a scan is writing to the library, or the dump will contain a half-finished pass.
- Opsec: correlation changes records, not traffic. It is safe to run in the middle of scanning, but it is cheap to run at the end of each collection pass instead.
- Idempotency: edges upsert on `(src, dst, relation)`, so re-running step 6 does not duplicate them. Alias names merge into the same asset.
- Resume: `assets.tsv` is the snapshot; if the run stops, re-dump rather than editing the TSV by hand, because the library is the source of truth.
- Run this skill after every collection pass, not once at the end. Gaps found early are cheap; gaps found during reporting are usually out of time.
