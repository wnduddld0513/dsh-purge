# Passive Reconnaissance

Build the public footprint of `DOMAIN` and its netblock without sending a single packet to the target: subdomains from certificate transparency, DNS records, mail and SPF includes, ASN and netblocks, historical URLs, and third-party passive DNS. Everything lands in `RESULT_DIR/passive/` as raw source responses plus a deduplicated `hosts.txt`, and every host that survives is registered with `redteam_asset_add` using `provenance=passive`.

## When to use

- A new `DOMAIN` or `TARGET_IP` is handed over and you need an inventory before touching the target.
- You must answer "how wide is this organisation really" (sibling domains, mail providers, cloud ranges).
- The target has a sensitive WAF and any active probing has to be justified per IP, not per domain.
- You need a certificate or ASN pivot to find assets nobody listed in the brief.
- You are re-running collection weeks later and need to diff "what is new since last time".

Not for: open-port discovery (`active-scan`), live HTTP probing (`pd-httpx`), technology identification (`web-fingerprint`), content discovery (`dir-bruteforce`), or vulnerability confirmation (`nuclei-scan`). If a step sends a SYN, a brute-force query, or an HTTP request to `TARGET`, it belongs to another skill, not this one.

## Prerequisites

- `curl`, `dig`, `jq` — `apt install curl dnsutils jq`. This skill needs no API key at all.
- Optional speed-ups: `subfinder`, `ksubdomain`, and `nuclei-templates` from `bash $DSH_HOME/redteam/setup.sh --yes`; they only replace loops you can write yourself.
- Optional commercial data source: a FOFA key, read at runtime as `os.environ.get("FOFA_KEY", "")` or exported in the shell as `$FOFA_KEY` with an empty default. When it is unset, skip that source and the rest of the workflow is unchanged.

Every step below has a fallback: the certificate query falls back to a second CT API, passive DNS falls back to a third provider, and resolution falls back to the system resolver. Nothing here is mandatory — a host list assembled from one working source is still a valid deliverable.

## Workflow

1. Create the workspace and pin the query set so the run is reproducible:

   ```bash
   mkdir -p RESULT_DIR/passive
   printf 'domain=%s\nstarted=%s\n' "DOMAIN" "$(date -Is)" > RESULT_DIR/passive/run.env
   ```

2. Pull certificate transparency. `crt.sh` occasionally answers with an HTML error page, so verify the payload before parsing:

   ```bash
   curl -s --max-time 90 "https://crt.sh/?q=%25.DOMAIN&output=json" -o RESULT_DIR/passive/crt.json
   head -c 80 RESULT_DIR/passive/crt.json; echo
   jq -r '.[].name_value' RESULT_DIR/passive/crt.json 2>/dev/null \
     | tr ',' '\n' | sed 's/^\*\.//' | tr 'A-Z' 'a-z' | sort -u > RESULT_DIR/passive/hosts.txt
   wc -l RESULT_DIR/passive/hosts.txt
   ```

   Zero lines means the query failed, not that the domain has no certificates. Retry with the fallback provider before moving on:

   ```bash
   curl -s "https://api.certspotter.com/v1/issuances?domain=DOMAIN&include_subdomains=true&expand=dns_names" \
     | jq -r '.[].dns_names[]?' | sed 's/^\*\.//' | sort -u >> RESULT_DIR/passive/hosts.txt
   sort -u RESULT_DIR/passive/hosts.txt -o RESULT_DIR/passive/hosts.txt
   ```

3. Collect the DNS records that leak infrastructure and third parties:

   ```bash
   for t in A AAAA MX NS TXT SOA CAA; do
     echo "== $t"
     dig +short "$t" DOMAIN @1.1.1.1
   done | tee RESULT_DIR/passive/dns.txt
   dig +short TXT DOMAIN | grep -Eo 'include:[^ ]+' | cut -d: -f2 \
     | tee RESULT_DIR/passive/spf-includes.txt
   ```

   Every `include:` host is a mail vendor that can hold other names for the same organisation. Feed those vendors back into step 2 as additional apex domains.

4. Resolve the candidate names to IPs and keep the mapping — later skills need IPs, not names:

   ```bash
   while read -r h; do
     ip=$(dig +short A "$h" @1.1.1.1 | head -n1)
     [ -n "$ip" ] && echo "$h $ip"
   done < RESULT_DIR/passive/hosts.txt | tee RESULT_DIR/passive/resolved.txt | head
   awk '{print $2}' RESULT_DIR/passive/resolved.txt | sort -u > RESULT_DIR/passive/ips.txt
   ```

   Names with no A record are not junk: keep them in `RESULT_DIR/passive/unresolved.txt`, they often resolve from inside the target network later.

5. Expand the netblock with RDAP. This converts one `TARGET_IP` into the ranges the organisation actually owns:

   ```bash
   curl -s "https://rdap.arin.net/registry/ip/TARGET_IP" \
     | jq '{handle, name, startAddress, endAddress, country}' | tee RESULT_DIR/passive/rdap.json
   ```

   A 404 means the address is registered at a different registry; try `https://rdap.apnic.net/registry/ip/TARGET_IP`, `https://rdap.db.ripe.net/ip/TARGET_IP`, then `whois -h whois.arin.net TARGET_IP`.

6. Add historical and passive sources. Each one is independent — one failing source never stops the run:

   ```bash
   curl -s "https://otx.alienvault.com/api/v1/indicators/domain/DOMAIN/passive_dns" \
     | jq -r '.passive_dns[]?.hostname' | sort -u > RESULT_DIR/passive/passive-dns.txt
   curl -s "https://urlscan.io/api/v1/search/?q=domain:DOMAIN&size=100" \
     | jq -r '.results[]?.page.domain' | sort -u > RESULT_DIR/passive/urlscan.txt
   curl -s "http://web.archive.org/cdx/search/cdx?url=*.DOMAIN&output=json&collapse=urlkey&fl=original&limit=5000" \
     | jq -r '.[][0]?' | sort -u > RESULT_DIR/passive/wayback.txt
   cat RESULT_DIR/passive/passive-dns.txt RESULT_DIR/passive/urlscan.txt >> RESULT_DIR/passive/hosts.txt
   sort -u RESULT_DIR/passive/hosts.txt -o RESULT_DIR/passive/hosts.txt
   ```

7. Record the inventory. Register one asset per resolved IP, with every name that pointed at it, and mark the source. Repeat per IP in `RESULT_DIR/passive/ips.txt`:

   ```
   redteam_asset_add
     ip: TARGET_IP
     primary_name: DOMAIN
     state: unknown
     provenance: passive
     tool: crt.sh
     names: [{ name: "oa.DOMAIN", kind: "domain", provenance: "passive" },
             { name: "vpn.DOMAIN", kind: "hostname", provenance: "passive" }]
   ```

8. Record the relationships you can already prove, before any active step can blur the source:

   ```bash
   redteam_asset_link src_kind=domain src_id=DOMAIN dst_kind=asset dst_id=TARGET_IP relation=resolves confidence=0.9
   ```

   Two hosts sharing one certificate serial are worth an edge of their own (`relation=shares_cert`); that edge is how `asset-correlation` later finds forgotten siblings.

9. Finish with a scope handoff so the next skill knows what to scan:

   ```bash
   { echo "# scope for active skills"; cat RESULT_DIR/passive/ips.txt; } > RESULT_DIR/passive/scope.txt
   sort -u RESULT_DIR/passive/scope.txt | wc -l
   ```

   Hand `RESULT_DIR/passive/scope.txt` to `active-scan`; do not re-derive scope inside that skill.

## Output and evidence

Files under `RESULT_DIR/passive/`:

- `run.env` — the exact queries and start time; without it a later re-run cannot be diffed.
- `crt.json`, `passive-dns.txt`, `urlscan.txt`, `wayback.txt` — raw provider responses, unparsed.
- `hosts.txt`, `resolved.txt`, `unresolved.txt`, `ips.txt`, `scope.txt` — derived inventories.
- `dns.txt`, `spf-includes.txt`, `rdap.json` — infrastructure and ownership context.

Tool rows:

- `redteam_asset_add` with `provenance=passive`, `tool` naming the actual source (`crt.sh`, `otx`, `urlscan`, `rdap`). `state` stays `unknown` — you have not touched the host.
- `redteam_asset_link` for `resolves` and `shares_cert` edges.
- `redteam_evidence_record` with `operation="passive_recon"`, `confidence="observed"`, `authority="tool-output"`, `parameters` holding the query URL, `result` holding the counts (names found, IPs resolved). Add `limitations: ["crt.sh only", "no brute force"]`.

Evidence means: the raw response file exists on disk and the command that produced it is recorded. A hostname someone typed into a chat message is not evidence until a source response contains it.

## Failure modes

- `crt.sh` returns 502 or an HTML page → the `%25.DOMAIN` query is too wide or the service is degraded → retry once after 30 s, then switch to the certspotter fallback and note the source gap.
- `jq: error (at crt.json:0): Cannot iterate over null` → you parsed an error page → inspect with `head -c 200`, never delete the file, it documents the failure.
- A name from CT does not resolve → certificate was issued for a decommissioned host → keep it in `unresolved.txt` and record the asset with `state=unknown`, do not silently drop the name.
- Wildcard entries like `*.DOMAIN` flood the list → strip the leading `*.` and keep one line per unique name; a wildcard is a fact about the DNS zone, not an asset.
- Wayback CDX times out on large domains → add `&limit=2000` or query a specific path prefix instead of `*.DOMAIN`.
- RDAP answers 404 for an APNIC address → query the correct regional registry, then fall back to `whois`; never invent a netblock from the IP's own /24.

## Notes

- Rate limits: `crt.sh` tolerates a handful of queries per minute, certspotter is stricter on unauthenticated calls, urlscan returns 100 results per page. Sleep 5–10 s between repeats and cache every raw response so a second pass costs nothing.
- Opsec: this skill never contacts `TARGET` directly, but resolver queries and CT lookups do leave your IP at third parties. Run collection from the operator host or `VPS_HOST`, not from a host inside the target network.
- Idempotency: the library deduplicates by IP and name, so re-running is safe. Before a repeat run, check what is already known with `redteam_asset_query q=DOMAIN` and only register deltas.
- Resume: if a run stops midway, `RESULT_DIR/passive/hosts.txt` and `resolved.txt` are the state. Skip names already present in `resolved.txt` and continue from the next provider.
- Keep the timestamp of every source response. When two runs disagree, the newer response wins and the older one is the evidence of what changed.
