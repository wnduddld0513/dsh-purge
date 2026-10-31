# campaign-planning: Turn a Target Name into a Staged, Budgeted Plan

This skill produces the plan that every later stage executes against: `RESULT_DIR/plan.md`, a stage budget with exit criteria, a point budget naming which score items this campaign can realistically reach, and a role assignment that respects the three-agent cap. It runs before any packet is sent, so its output is a decision record rather than a finding. The plan itself is stored as recon-stage rows through `redteam_chain_add` and as explicit gaps through `redteam_unknown_record`.

## When to use

- A target has just been opened and nothing has been executed yet.
- A campaign is being resumed after a pivot, a lost session or a scope change, and the old plan no longer matches reality.
- More than one execution agent is about to run and their work must not overlap.
- A time box or a noise budget has to be agreed before scanning starts.
- Not for recording assets or findings; that is `redteam_asset_add` and `redteam_vuln_add` territory.
- Not for deciding what a finding is worth; the `score-coverage` skill owns the point-code mapping.

## Prerequisites

- No external tool and no environment variable. The whole skill is the `redteam_*` tool set plus a text file.
- `redteam_roles` to read the role list, `redteam_session_info` to confirm the binding, `redteam_preflight` to know what is actually installed.
- A writable RESULT_DIR.
- Nothing here is mandatory and every step has a fallback: with no tools available the plan is still written to `RESULT_DIR/plan.md` by hand, and the stage and point tables below carry the same content.

## Workflow

1. Open or bind the target, then confirm the binding. Never plan against an assumed engagement:

```text
redteam_engagement_open  target="TARGET"  scope=["TARGET_IP/24"]
redteam_session_info                     # verify bound_engagement before writing anything
```

2. Read the role list rather than inventing labels. The five execution roles are `recon`, `assess`, `vuln-scan`, `exploit`, `internal`; `plan` is the session doing this work:

```text
redteam_roles
```

3. Run preflight once and record what is missing. A plan that depends on `suo5` when `suo5` cannot run is a fiction:

```text
redteam_preflight  include="recon-pipeline,browser-automation,suo5-tunnel,lateral-movement"
```

4. Fix the time box and the noise budget before any scan. Fill the table, keep it short, and paste it into `plan.md`:

| Field | Value | Why it is fixed now |
| --- | --- | --- |
| Wall clock | 8 h, hard stop at 6 h | late-hour work produces unverified findings |
| Scan rate | `RATE` per second, `THREADS` concurrent | one burst wakes the blue team for the whole campaign |
| Intrusive window | after 22:00 local | scans outside business hours are less likely to be attributed |
| Noise ceiling | stop after 2 blocked WAF responses | a blocked campaign yields no evidence, only a log entry |
| Stop condition | target-side incident response observed, or 3 consecutive blocks | continuing past this makes every later finding unattributable |

5. Write the stage plan. Each stage needs an entry condition, an exit criterion and the evidence it must leave behind:

| Stage code | Goal | Exit criterion | Artifact |
| --- | --- | --- | --- |
| `recon` | map assets, confirm the attack surface | every live host has an asset row with title or banner | `redteam_asset_add`, `RESULT_DIR/assets.csv` |
| `internet` | obtain the first credential or code execution | one `redteam_access_add` or one `redteam_webshell_add` | `RESULT_DIR/vuln-*.md`, raw request |
| `boundary` | cross into the internal network | one `redteam_tunnel_add` with `entry_kind` that is not `self-only` | `RESULT_DIR/tunnel-*.txt` |
| `internal` | map the internal range, move laterally | internal hosts recorded with `provenance=active` and a service | `RESULT_DIR/internal-*.json` |
| `target` | reach the named objective system | admin or root on the objective, with a screenshot | `redteam_shot_add`, `redteam_score_hit` |

6. Budget the points before chasing them. Pick at most four codes this campaign can prove, and name the surface that would prove each one:

| Observable surface | Point code | Base | Realistic here |
| --- | --- | --- | --- |
| exposed admin console with default password | `web-app` | 100 | yes |
| reachable MySQL or Redis on the perimeter | `db-credential` | 50 | yes |
| VPN or bastion in scope | `central-system` | 500 | unknown, needs login proof |
| jump host between zones | `boundary-logical` | 1000 | no, until a tunnel exists |
| model endpoint in the asset list | `ai-agent` | 100 | only if the target really serves one |

7. Assign roles and reserve slots. At most three execution agents run per target; a fourth acquire fails immediately instead of queueing:

```text
redteam_agent_slot  action="status"
redteam_agent_slot  action="acquire"  label="recon: subdomains and C segment"
redteam_agent_slot  action="acquire"  label="vuln-scan: exposed web apps on TARGET_IP"
```

8. Write each brief so the first line is the role tag. That single line is what injects the role prompt; repeating the role text into the brief breaks the mechanism:

```text
redteamRole: recon
Scope: TARGET_IP/24, ports from the plan table only.
Deliverable: asset rows with url and title, RESULT_DIR/assets.csv.
Stop: after 2 blocked responses or 6 hours, whichever is first.
```

9. Record the plan itself, not just the outcome. A plan with no row cannot be reviewed after the fact:

```text
redteam_chain_add  stage="recon"  stage_code="recon"  \
  title="campaign plan fixed: 5 stages, parallel agents, 8h box"  \
  detail="point budget: web-app, db-credential; boundary deferred until a credential exists"  \
  tool="manual"  result="RESULT_DIR/plan.md"
```

10. Record every assumption that could invalidate the plan, so a later stage can resolve it instead of rediscovering it:

```text
redteam_unknown_record  domain="internal-recon"  \
  recommended_probe="resolve DNS suffixes from the first foothold; confirm 10.0.0.0/8 reachability"  \
  supporting_ev_ids=[]
```

11. Close the loop on a fixed cadence, not when work feels finished:

- [ ] Every stage in the table has either an artifact row or an `unknown` entry.
- [ ] No agent is holding a slot it is not using (`redteam_agent_slot action="status"`).
- [ ] Every asset row has a `provenance`; `active` rows carry `tool`.
- [ ] Every claim in `plan.md` names the artifact under RESULT_DIR that supports it.
- [ ] Stop conditions were checked at the last stage transition, not at the end.
- [ ] Slots released: `redteam_agent_slot action="release"` for anything still reserved.

## Output and evidence

- `RESULT_DIR/plan.md` — the table set above, filled in, plus the point budget and the stop conditions.
- `RESULT_DIR/assets.csv` — expected shape of the recon deliverable (`ip,port,service,url,title,provenance,tool`).
- `RESULT_DIR/plan-review.txt` — one line per cadence check with a timestamp and the observed value.
- `redteam_chain_add` recon rows for the plan itself, the scope decision and each stop-condition check; `tool` carries the actual command when one was run.
- `redteam_unknown_record` rows for every assumption the plan depends on but cannot yet prove.
- No `redteam_score_hit` from this skill: planning is not a scoring event.

## Failure modes

- Plan lists tools that preflight marked broken → the plan was written from habit → rewrite step 3 and replace each missing tool with its fallback.
- Two agents scan the same range → no slot was reserved and no label recorded scope → release both, re-acquire with disjoint labels.
- Fourth agent never starts and no error is read → the subagent never got dispatched at all → check `action="status"` for the reservation list and confirm the dispatch call itself returned an id.
- Stage table has no exit criterion → work continues until the time box, producing breadth and no proof → add one binary criterion per stage.
- Plan is complete but nothing is in the database → `plan.md` was written and never recorded → add the `redteam_chain_add` row in step 9.
- Stop conditions never checked → every later finding inherits an unattributable burst → check them at each transition, not at the end.

## Notes

- The plan is a document plus rows, never one or the other; the file is for humans, the rows are for the report.
- Re-plan at every stage transition. A boundary plan written before a credential existed is usually wrong.
- Keep the noise budget in the same units as the scan tools: packets per second for `nmap`/`masscan`, requests per second for web fuzzing.
- Concurrency is not capped in this fork: `action="acquire"` always succeeds and `max`/`free` are `null`. Parallelism is a noise budget decision, so keep the useful ones fed and release slots you no longer use.
- Idempotency: rewriting `plan.md` is safe; re-acquiring a slot without releasing the old one leaks capacity until the child exits.
- Opsec: the plan file itself names targets and times, so keep it on the drill host and out of the delivered report body.
