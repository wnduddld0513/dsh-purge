# redteam-setup: Bring the Drill Environment to a Known State

This skill takes a fresh or half-broken drill host to a state where every later skill runs: it reads `redteam_preflight`, turns each gap into one concrete action, fills the two settings that gate whole branches (FOFA and the VPS), and leaves a completion marker the next session can trust. It produces a short report under RESULT_DIR and a single marker file, and it never installs anything on the operator's behalf — the operator runs the installer. The same procedure covers a Kali host with the setup script, a host where that script is absent, and Windows.

## When to use

- The first turn of any engagement: nothing is known about the host yet.
- `redteam_preflight` reports broken skills and the reason has to be separated from a missing tool.
- A VPS or FOFA key was just added and the running process still cannot see it.
- A previous session ended mid-install and the completion marker is stale or absent.
- Not for installing individual tools for a specific task; run this once, then let the task skill name its one dependency.
- Not for fixing a single skill's syntax; the availability panel already names the missing piece per skill.

## Prerequisites

- The plugin's redteam preset, which deploys `presets/redteam/preset.yml`, `presets/redteam/agent.cordis.yml` and `presets/redteam/anchor-gate.mjs` into the host, and syncs the bundled skill set from the package directory `skills/redteam` into `$DSH_HOME/redteam/skills` at plugin start.
- `bash` and the setup script at `$DSH_HOME/redteam/setup.sh` if this install shipped one; `curl` and `jq` for the checks.
- An editor for `$DSH_HOME/.env` (mode 600), plus a VPS reachable over SSH if reverse-shell work is planned.
- Nothing here is mandatory and every step has a fallback: without the setup script every tool can be placed manually under `$DSH_HOME/redteam/toolkit/`, and every skill that depends on a missing piece degrades to a named substitute instead of failing.

## Workflow

1. Measure first. One call tells you what is installed, what is broken and what each broken skill needs:

```text
redteam_preflight
```

2. Read the onboarding block, not just the skill list. `onboarding.complete`, `onboarding.setup_script.exists`, `onboarding.toolkit` and `onboarding.runtime_hint` decide which of the next two steps applies:

```text
redteam_preflight  include="recon-pipeline,browser-automation,suo5-tunnel,vps-reverse-shell"
```

3. Choose the branch by what the host actually provides:

| Signal | Branch | Action |
| --- | --- | --- |
| `onboarding.setup_script.exists = true` | scripted host | have the operator run `--check`, then `--yes` |
| `onboarding.setup_script.exists = false` | manual host | place binaries under `$DSH_HOME/redteam/toolkit/` by hand |
| `runtime_hint` mentions Windows | adapted host | use the drill console "environment adapt" page, not `setup.sh` |
| `onboarding.complete = true` | already done | verify the marker, then stop |

4. On a scripted host, inspect before installing. The check mode writes nothing and is safe to repeat:

```bash
bash "$DSH_HOME/redteam/setup.sh" --check
```

5. When the operator agrees to the install, they run it. The script keeps existing VPS and key values, is idempotent, and accepts `--force` to re-download something corrupted:

```bash
bash "$DSH_HOME/redteam/setup.sh" --yes
```

6. Fill the two settings that gate whole branches. `env_set()` writes them to `$DSH_HOME/.env` at mode 600; do the same by hand when the script is absent:

```bash
grep -E '^(FOFA_KEY|REDTEAM_VPS_HOST|REDTEAM_VPS_USER|REDTEAM_VPS_KEY)=' "$DSH_HOME/.env" 2>/dev/null | sed 's/=.*/=<set>/'
```

7. Verify the FOFA key against the API rather than trusting the line in the file. A key with trailing whitespace looks set and answers `error: true`:

```bash
set -a; . "$DSH_HOME/.env"; set +a
curl -s "https://fofa.info/api/v1/info/my?key=$FOFA_KEY" | jq '{error, email, isvip}'
```

8. Verify the VPS path end to end. The key must be mode 600 and the login must be non-interactive, or every later reverse-shell step stalls on a prompt:

```bash
chmod 600 "$DSH_HOME/redteam/toolkit/vps/id_rsa"
ssh -i "$DSH_HOME/redteam/toolkit/vps/id_rsa" -o BatchMode=yes -o StrictHostKeyChecking=accept-new \
  "${REDTEAM_VPS_USER:-ubuntu}@VPS_HOST" 'echo ok'
```

9. Place anything the script does not fetch. These are the usual manual gaps, each with its target path:

| Piece | Target path | Fallback when absent |
| --- | --- | --- |
| `suo5-linux-amd64` | `$DSH_HOME/redteam/toolkit/suo5/` | `chisel` for the same tunnel |
| `gogo` | `$DSH_HOME/redteam/toolkit/gogo/gogo` | `fscan` for internal mapping |
| `frpc` / `frps` | `$DSH_HOME/redteam/toolkit/frp/` | `chisel` or `ssh -R` |
| `httpx` wrapper | `$DSH_HOME/redteam/toolkit/httpx/httpx` | `curl` per host |
| Behinder / Godzilla | `$DSH_HOME/redteam/toolkit/Behinder/`, `.../Godzilla/` | script-generated encoded shell |
| nuclei templates | `~/.local/nuclei-templates` | `nuclei -update-templates` |

10. Re-run preflight after every change, because the process reads `.env` and `config.json` at call time but cached tool paths only after a restart:

```text
redteam_preflight
```

11. Restart the host process when `.env` changed, then confirm the values are visible to the tool rather than to your shell:

```bash
# after restarting the dsh process, this must show the key as set, not empty
set -a; . "$DSH_HOME/.env"; set +a
printf 'fofa=%s vps=%s\n' "${FOFA_KEY:+set}" "${REDTEAM_VPS_HOST:-empty}"
```

12. Write the completion marker only when preflight is clean, and record the state so the next session does not repeat this work:

```bash
mkdir -p "$DSH_HOME/redteam"
date -Is > "$DSH_HOME/redteam/.setup-complete"
```

```text
redteam_evidence_record  operation="environment_ready"  authority="tool-output"  confidence="observed" \
  result={"preflight":"complete","marker":"$DSH_HOME/redteam/.setup-complete","fofa":"set","vps":"reachable"}
```

13. Turn the gaps you chose to skip into named unknowns instead of silent assumptions:

```text
redteam_unknown_record  domain="lateral-movement"  \
  recommended_probe="no netexec on this host; confirm whether smbclient plus impacket covers the internal path"  \
  supporting_ev_ids=[]
```

14. On a Windows or adapted host, skip the script entirely and set the same values through the drill console "environment adapt" page: tool absolute paths, extra `binDirs`, `nucleiTemplatesDir`, `FOFA_KEY`, `REDTEAM_VPS_HOST` and `REDTEAM_VPS_KEY`. The result is written to `$DSH_HOME/redteam/config.json` and read by preflight on the next call.

## Output and evidence

- `$DSH_HOME/.env` — the four keys, mode 600; never copied into RESULT_DIR and never quoted in a report.
- `$DSH_HOME/redteam/config.json` — tool paths and directories for adapted hosts.
- `$DSH_HOME/redteam/.setup-complete` — the marker that makes `onboarding.complete` true.
- `RESULT_DIR/setup-report.md` — preflight before and after, the branch taken, and the manual placements with their target paths.
- `redteam_evidence_record` with `authority=tool-output` and `confidence=observed`, carrying the preflight summary and the marker path.
- `redteam_unknown_record` per capability deliberately skipped, naming the probe that would resolve it.

## Failure modes

- `onboarding.complete` stays false after everything works → the marker file is missing or the process predates it → write the marker, then re-run preflight.
- Skill still reported broken after installing its tool → the resolved path is cached from before the install → restart the host process and re-run preflight.
- `FOFA_KEY` is set but the skill is unavailable → whitespace or quotes survived in `.env` → rewrite the line without quotes and verify with the info endpoint.
- `$REDTEAM_VPS_HOST` expands to empty → the variable is unset, and VPS-dependent skills are then judged unavailable by design → set it, restart, re-check.
- `ssh` hangs on the VPS check → the key is not 600, or the host key is unknown → fix the mode and pass `accept-new` once.
- `setup.sh --check` reports a tool present but the tool prints nothing → the download was truncated → re-run with `--force`.
- Every tool resolves but the skills are still missing → the bundled directory was never synced → confirm the package directory `skills/redteam` is populated and restart the plugin.
- `httpx` resolves to the Python library CLI → `/usr/bin/httpx` is not ProjectDiscovery → use the wrapper path under the toolkit directory.

## Notes

- Run this once per host, not once per engagement; the marker is what makes the second run cheap.
- `.env` changes need a process restart; tool-path changes need the same. There is no live reload for either.
- Never let an agent download or install on the operator's behalf; the report says what is missing and the operator decides.
- Idempotency: `--yes` keeps existing values, `--check` writes nothing, rewriting the marker only refreshes its timestamp.
- Keep the VPS key off any shared or synced path; the default location under the toolkit directory is fine only on a dedicated drill host.
- The preset that ships this skill also deploys the role prompts consumed by `redteamRole:` briefs; if roles look empty, run `redteam_roles` before editing any prompt.
