# DeepSeek Web Intelligence

Use a language model as an analysis layer over public web data: draft search queries, summarise pages you fetched yourself, extract asset candidates from unstructured text, and map products to candidate CVEs. The model never replaces a data source — every claim it produces is recorded as inferred and must be confirmed by an artefact before it becomes an asset or a finding. Prompts, raw model replies and the extracted candidates land in `RESULT_DIR/intel/`.

## When to use

- You have an organisation name or a product brand and need a good query set faster than guessing.
- You collected a pile of public pages, PDFs or job posts and need entities extracted consistently.
- You must translate a vendor advisory or release note into "which versions and which endpoints".
- You want a first-pass CVE candidate list for a product/version pair before running templates.
- A long provider response has to be reduced to ten lines an operator can act on.

Not for: confirming anything (`nuclei-scan`, `pd-httpx`), obtaining data that is not public, or generating payloads against a live target without a separate verification step. A model answer is a hypothesis with a citation, nothing more.

## Prerequisites

- `curl` and `jq` — `apt install curl jq`.
- A DeepSeek API key in `$DSH_HOME/.env` as `DEEPSEEK_API_KEY=<key>`, file mode `600`, then restart the host process (`dsh web`) so the value reaches the session. The skill reads it as `os.environ.get("DEEPSEEK_API_KEY", "")`.
- Without a key this skill alone is unavailable: every other workflow still runs, and the fallback is to write the prompts into a file and paste the replies back by hand.

Fallbacks are explicit throughout: any model call can be replaced by an operator-written summary, and any model-extracted candidate is still only a candidate until a fetcher or a scanner confirms it. Nothing in this skill is mandatory.

## Workflow

1. Create the workspace and check whether the key is wired up. Do not print the key value:

   ```bash
   mkdir -p RESULT_DIR/intel
   if [ -n "${DEEPSEEK_API_KEY:-}" ]; then echo "model enabled"; else echo "model disabled: manual mode"; fi
   ```

2. Put the credential in a curl config file instead of the command line, so it never lands in process listings or shell history, and make it operator-only:

   ```bash
   umask 077
   printf 'header = "Authorization: Bearer %s"\nheader = "Content-Type: application/json"\n' \
     "$DEEPSEEK_API_KEY" > RESULT_DIR/intel/.curlrc
   chmod 600 RESULT_DIR/intel/.curlrc
   ```

3. Write the prompt as a file, not as an inline string — prompts are artefacts that get reviewed and re-used:

   ```bash
   cat > RESULT_DIR/intel/prompt-01.txt <<'EOF'
You are assisting an asset inventory pass. From the text below, extract only:
1) hostnames, 2) IP addresses, 3) product names with versions, 4) e-mail domains.
Return one item per line as: kind<TAB>value<TAB>quote.
If a value is not literally present in the text, do not output it.
EOF
   wc -l RESULT_DIR/intel/prompt-01.txt
   ```

4. Build the request body with `jq` so quoting cannot break the JSON, then call the API:

   ```bash
   jq -n --rawfile sys RESULT_DIR/intel/prompt-01.txt --rawfile src RESULT_DIR/intel/source-01.txt \
     '{model:"deepseek-chat", temperature:0, stream:false,
       messages:[{role:"system",content:$sys},{role:"user",content:$src}]}' \
     > RESULT_DIR/intel/body-01.json
   curl -s --max-time 120 --config RESULT_DIR/intel/.curlrc \
     https://api.deepseek.com/chat/completions \
     -d @RESULT_DIR/intel/body-01.json -o RESULT_DIR/intel/reply-01.json
   jq -r '.error.message // "ok"' RESULT_DIR/intel/reply-01.json
   ```

   `temperature: 0` matters: the same source must produce the same extraction twice, otherwise the output cannot be reviewed.

5. Extract the answer and keep the raw reply, then split it into machine-usable candidates:

   ```bash
   jq -r '.choices[0].message.content' RESULT_DIR/intel/reply-01.json \
     > RESULT_DIR/intel/extract-01.txt
   awk -F'\t' 'NF==3{print $1"\t"$2}' RESULT_DIR/intel/extract-01.txt \
     | sort -u > RESULT_DIR/intel/candidates-01.tsv
   cut -f1 RESULT_DIR/intel/candidates-01.tsv | sort | uniq -c
   ```

6. Verify every candidate against the source before it counts. A value the model "knows" is not in the text; this check removes exactly those:

   ```bash
   while IFS=$'\t' read -r kind value; do
     grep -qiF -- "$value" RESULT_DIR/intel/source-01.txt && echo "$kind $value" \
       || echo "DROPPED $kind $value"
   done < RESULT_DIR/intel/candidates-01.tsv | tee RESULT_DIR/intel/verified-01.txt
   ```

   Anything printed as `DROPPED` is a hallucination and must never reach the library.

7. Use the model for query drafting, not for facts. Keep the query set in a file that later runs can replay against a real source:

   ```bash
   jq -n --arg q "Draft 15 search queries that would find public documents naming DOMAIN, one per line, no commentary." \
     '{model:"deepseek-chat", temperature:0.3, stream:false,
       messages:[{role:"user",content:$q}]}' > RESULT_DIR/intel/body-queries.json
   curl -s --config RESULT_DIR/intel/.curlrc https://api.deepseek.com/chat/completions \
     -d @RESULT_DIR/intel/body-queries.json \
     | jq -r '.choices[0].message.content' > RESULT_DIR/intel/queries.txt
   head -n 5 RESULT_DIR/intel/queries.txt
   ```

8. Record model output with the lowest confidence the ledger understands, and promote it only after a fetcher or a scanner confirms it:

   ```
   redteam_evidence_record
     operation: "deepseek_extract"
     parameters: { model: "deepseek-chat", prompt_file: "intel/prompt-01.txt", source: "intel/source-01.txt" }
     result: { candidates: 37, after_verbatim_check: 21 }
     confidence: inferred
     authority: operator-input
     limitations: ["model output", "verbatim check only", "not probed"]
   ```

   After `pd-httpx` confirms a hostname, record the observed evidence separately and reference the inferred one in `supporting_ev_ids`; do not rewrite history by flipping the original entry.

9. Clean up the credential file and close the run:

   ```bash
   shred -u RESULT_DIR/intel/.curlrc 2>/dev/null || rm -f RESULT_DIR/intel/.curlrc
   ls -l RESULT_DIR/intel/ | head
   ```

## Output and evidence

Files under `RESULT_DIR/intel/`:

- `prompt-*.txt` — the exact instructions, reviewable and reusable.
- `source-*.txt` — the public material being analysed; without it nothing can be re-verified.
- `body-*.json`, `reply-*.json` — request and raw response, kept verbatim including errors.
- `extract-*.txt`, `candidates-*.tsv`, `verified-*.txt` — extraction, machine form, verbatim check.
- `queries.txt` — drafted queries to feed into `passive-recon` or `fofa-recon`.

Tool rows: `redteam_evidence_record` with `confidence="inferred"` and `authority="operator-input"` for anything model-derived; `redteam_asset_add` with `provenance="passive"`, `tool="deepseek-web-intel"` only for candidates that passed the verbatim check and were confirmed by a fetch; `redteam_unknown_record` for questions the model raised but nothing could answer.

Evidence is the source text plus the exact prompt plus the raw reply. A summary without its source file is not evidence, and a value absent from the source is not a candidate.

## Failure modes

- `{"error":{"message":"Insufficient Balance"}}` → account has no credit → stop, record the limitation, and fall back to manual extraction.
- HTTP 401 with `invalid api key` → `DEEPSEEK_API_KEY` is unset or stale in the running process → fix `.env`, restart `dsh web`, re-check `${DEEPSEEK_API_KEY:-}` is non-empty.
- HTTP 429 or timeouts on long sources → request too large → split `source-*.txt` into 4–8 KB chunks and call once per chunk, keeping the same prompt file.
- The reply contains items that are not in the source → normal model behaviour, not a bug → the verbatim check in step 6 is mandatory, never skip it.
- `jq: error ... Cannot index array with string "choices"` → the response was an error object → read `.error.message` first, as the step 4 command already does.
- Output differs between two runs on identical input → `temperature` not 0 or the model version changed → pin the model name in the body and record it in the evidence parameters.

## Notes

- Rate limits: the API is metered per token; batch sources into a few large calls rather than many small ones, and keep prompts in files so a retry costs nothing to rebuild.
- Opsec: only send material that is already public, and never paste credentials, internal hostnames or captured traffic into a prompt. Treat the prompt file as a document that will be read by others.
- Idempotency: the same prompt and the same source should produce the same extraction at `temperature: 0`. If they diverge, the difference is signal — inspect it instead of overwriting.
- Resume: `candidates-*.tsv` and `verified-*.txt` are the state. Skip sources already listed in `RESULT_DIR/intel/done.txt` and continue with the next one.
- Keep the model name and parameters in every evidence record. "The model said so" is only useful when the exact call can be repeated.
