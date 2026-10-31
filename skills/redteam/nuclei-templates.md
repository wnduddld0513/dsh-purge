# Nuclei Template Library

Manage the local template corpus that makes template-based checking possible: confirm it exists, keep it current without hammering the upstream repository, verify the count, and index it by tag, severity and product so a scan can be targeted instead of blind. The skill produces a verified template directory plus a local index of what is inside it, under `RESULT_DIR/nuclei/`.

## When to use

- `nuclei -tl` prints nothing or fails, so no template-based check can run.
- The template count looks far too low for a current corpus (a few hundred rather than thousands).
- You need to know which templates match a product before scanning it.
- You want an offline snapshot of template metadata for an engagement with no upstream access.
- A previous scan used a tag that no longer exists and you must confirm the current tag name.

Not for: running the checks themselves (`nuclei-scan`), writing custom templates from scratch, or managing the nuclei binary itself — that is an `apt install nuclei` concern.

## Prerequisites

- `nuclei` installed and on `PATH` — `apt install nuclei`; verify with `nuclei -version`.
- The template directory defaults to `~/.local/nuclei-templates`. The plugin's configuration also accepts an override under `$DSH_HOME/redteam/config.json` (`nucleiTemplatesDir`), which falls back to `toolkit/nuclei-templates` when unset.
- Initial fill: `nuclei -update-templates`. Upgrade runs are limited to at most once a week; if the corpus is already present, the update is a no-op for existing files.

Fallbacks: a corpus shipped with the distribution package (`/usr/share/nuclei-templates` or the package's `nuclei-templates` path) can be pointed at with `-t`. If no corpus can be obtained, tag and severity filtering in `nuclei-scan` is unavailable, but a single explicit template path still works. Nothing here is mandatory.

## Workflow

1. Establish where the corpus actually is and whether nuclei sees it:

   ```bash
   mkdir -p RESULT_DIR/nuclei
   nuclei -version
   printf 'default: %s\n' "$HOME/.local/nuclei-templates"
   ls -d "$HOME/.local/nuclei-templates" 2>/dev/null || echo "default dir absent"
   jq -r '.nucleiTemplatesDir // "unset"' "${DSH_HOME:-$HOME/.dsh}/redteam/config.json" 2>/dev/null
   ```

2. Count what is there before changing anything. A fresh checkout with 300 files is incomplete, not current:

   ```bash
   find "$HOME/.local/nuclei-templates" -name '*.yaml' 2>/dev/null | wc -l | tee RESULT_DIR/nuclei/count-before.txt
   ```

   A healthy corpus is in the thousands (13,000+ for a recent release). Below roughly 1,000, treat the directory as truncated and continue to step 3.

3. Update the corpus. This is a network operation against GitHub; run it once, not per scan:

   ```bash
   nuclei -update-templates 2>&1 | tee RESULT_DIR/nuclei/update.log
   find "$HOME/.local/nuclei-templates" -name '*.yaml' | wc -l | tee RESULT_DIR/nuclei/count-after.txt
   ```

4. If the count did not grow, force a clean refill into an explicit directory rather than deleting the existing one blindly:

   ```bash
   nuclei -update-templates -update-template-dir "$HOME/.local/nuclei-templates" \
     -force 2>&1 | tail -n 20
   find "$HOME/.local/nuclei-templates" -name '*.yaml' | wc -l
   ```

5. Verify the loader, not just the files. `-tl` is the only proof that nuclei can parse the corpus:

   ```bash
   nuclei -tl 2>/dev/null | wc -l | tee RESULT_DIR/nuclei/loaded.txt
   nuclei -tl 2>/dev/null | head -n 10
   ```

   If files exist but `loaded.txt` is `0`, the directory layout is wrong (templates must sit under subdirectories such as `http/`, `dns/`, `network/`) or the YAML is broken.

6. Index the corpus by tag and severity for later targeting. This is the artefact that makes `nuclei-scan` cheap:

   ```bash
   nuclei -tl -tags cve 2>/dev/null | wc -l | tee RESULT_DIR/nuclei/tag-cve.txt
   grep -rhoE '^\s+tags:\s*.*' "$HOME/.local/nuclei-templates" 2>/dev/null \
     | sed 's/.*tags:\s*//' | tr ',' '\n' | tr -d ' ' | sort | uniq -c | sort -rn \
     > RESULT_DIR/nuclei/tags.tsv
   head -n 30 RESULT_DIR/nuclei/tags.tsv
   ```

7. Check that the tags a run intends to use actually exist. A typo silently selects nothing and looks like a clean scan:

   ```bash
   for t in cve exposure misconfig default-login takeover tech; do
     n=$(nuclei -tl -tags "$t" 2>/dev/null | wc -l)
     printf '%s\t%s\n' "$t" "$n"
   done | tee RESULT_DIR/nuclei/tag-check.tsv
   ```

8. Record the corpus state as engagement evidence, so a later reader knows what was tested with what:

   ```
   redteam_evidence_record
     operation: "nuclei_template_sync"
     parameters: { templates_dir: "~/.local/nuclei-templates", updated: false }
     result: { count_before: 13812, count_after: 13812, loaded: 13812, index: "nuclei/tags.tsv" }
     confidence: observed
     authority: tool-output
     limitations: ["template set is a point-in-time snapshot"]
   ```

## Output and evidence

Files under `RESULT_DIR/nuclei/`:

- `count-before.txt`, `count-after.txt`, `loaded.txt` — file count versus parseable count.
- `update.log` — the update transcript, kept because a partial download is diagnosable from it.
- `tags.tsv`, `tag-check.tsv` — tag inventory and per-tag availability.
- `template-seed.tsv` — product/version pairs carried over from `web-fingerprint` to pick templates.

Tool rows: `redteam_evidence_record` with `operation="nuclei_template_sync"` and `authority="tool-output"`; `redteam_unknown_record` when the corpus cannot be verified and scan coverage is therefore unknown.

Evidence is a count plus a `-tl` result. "The templates are up to date" is a claim; `loaded.txt` containing a number in the thousands is evidence.

## Failure modes

- `nuclei -tl` returns nothing but `.yaml` files exist → wrong directory or nested one level too deep → point `-t` at the directory that directly contains `http/`, `dns/`, `network/`.
- `-update-templates` exits successfully but the count is unchanged → existing files skipped and the release index was not fetched → re-run with `-force` into the explicit directory (step 4).
- Update fails with a TLS or proxy error → egress blocked on the engagement network → use the distribution-provided corpus or a copy from an earlier engagement, and note the limitation.
- Some templates fail to parse and are skipped → mixed-version corpus after a partial update → clear the directory and refill, do not merge two releases.
- `-tags` selects zero templates → tag name changed or misspelled → confirm against `tags.tsv` before concluding the target is clean.
- Update runs on every scan and slows it down → `-update-templates` was left in the scan command → keep it in this skill only, never in the scan pipeline.

## Notes

- Rate limits: template updates hit GitHub, not the target. Once a week is generous; more frequent runs waste time and risk throttling.
- Opsec: fetching templates touches only the local network egress. Scanning with them is a separate decision handled by `nuclei-scan`.
- Idempotency: `-update-templates` is idempotent per release. Re-running without `-force` is safe and leaves existing files untouched.
- Resume: if an update is interrupted, delete the half-written directory and refill; a merged corpus is worse than an older consistent one.
- Keep a copy of `tags.tsv` with the engagement report. It documents which checks were even available at the time, which is the difference between "not vulnerable" and "not tested".
