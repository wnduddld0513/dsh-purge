# score-coverage: Map a Finding to the Right Point Code Before Recording It

This skill is a lookup and verification pass over the 25 score items the engine rates: it names the code, the tier that applies, the cap and dedup scope that decide whether a duplicate counts, and the evidence string the record needs. It produces a decision per finding, not a new artifact, and the decision is applied through `redteam_score_hit` (or `redteam_chain_add` with `point_code` plus `evidence`). Getting the code wrong is the most common way a real result scores zero.

## When to use

- A privilege was obtained and the question is which code it belongs to and at which tier.
- A second host or a second account looks like a duplicate and you need the cap and dedup scope to decide.
- Data was reached and the claim needs a row count instead of a privilege description.
- A boundary was crossed and the gap between `boundary-logical`, `boundary-strong` and `boundary-physical` matters.
- Not for finding the vulnerability; the code is chosen after the result exists.
- Not for planning what to chase; the `campaign-planning` skill sets the budget, this one rules on individual claims.

## Prerequisites

- No external tool and no environment variable. Everything comes from `redteam_score_list` and the recorded assets.
- The raw evidence for the claim: a screenshot, a command output, a response body, or an evidence id.
- Nothing here is mandatory and every step has a fallback: with no live tool, the table in step 2 gives the same mapping, and the caps are stated per row.

## Workflow

1. Read the live item list first. Codes are stable, but caps, tiers and `achieved` state are per engagement:

```text
redteam_score_list
```

2. Map the observed result through this table. `cap 0` means uncapped, `scope` is the dedup scope, and `tier` is the value to pass as `points`:

| Code | Counts as | Base | Tier / points override | Cap | Scope |
| --- | --- | --- | --- | --- | --- |
| `domain-control` | registrar, DNS or certificate control | 50 | tier 1 = 50, tier 2 = 20 | 400 | system |
| `terminal-access` | one endpoint (PC, pad, phone, camera, screen) | 10 | printer or wifi router = 5, endpoint = 10 | 600 | system |
| `server-host` | shell or login on one server | 50 | user = 10, admin = 50 | 600 | system |
| `db-credential` | database account | 50 | user = 10, admin = 50, unauthenticated or empty password = 10 | 400 | system |
| `web-app` | login to an HTTP application | 100 | user = 50, admin = 100 | 2000 | system |
| `central-system` | bastion, SSO/IAM, DC, CA, management console | 500 | user = 50, admin = 500 | 4000 | system |
| `bigdata-system` | data platform with real volume | 1000 | user = 100, admin = 1000 | 4000 | system |
| `netdev` | router, switch, firewall | 200 | user = 100, admin = 200 | 2000 | service |
| `iiot` | industrial console, connected devices | 200 | console admin = 200, device = 10 | 2000 | system |
| `cloud-platform` | cloud or container control plane | 500 | admin = 500, node = 10 | 2000 | system |
| `iot-platform` | IoT platform control | 200 | platform = 200, endpoint = 10 | 2000 | system |
| `secdev` | IPS, IDS, audit, WAF (not central class) | 200 | flat | 1000 | service |
| `file-storage` | file server, NAS, backup | 50 | admin = 50, user or test data = 10 | 500 | system |
| `ai-agent` | model agent, skill or tooling | 100 | 100 to 500 by depth of control | 4000 | service |
| `model-compute` | compute management, training or knowledge base | 500 | admin = 500 | 4000 | system |
| `model-data` | weights, inference artefacts | 500 | admin = 500 | 4000 | system |
| `computepower-admin` | compute infrastructure admin | 500 | flat, shares the 2000 cap with cards | 2000 | system |
| `computepower-cards` | accelerator card | 10 | 10 per card | 2000 | none |
| `boundary-logical` | policy or routing boundary crossed | 1000 | flat | 0 | target |
| `boundary-strong` | gap-class isolation crossed | 10000 | flat | 0 | target |
| `boundary-physical` | physically separated network crossed | 30000 | flat | 0 | target |
| `boundary-supply` | supplier or multi-tenant route into the target | 1000 | 1000 per primary org or per zone | 3000 | service |
| `netdev-redirect` | routing, DNS or capture through a device | 200 | additive on top of `netdev` | 2000 | none |
| `netdev-implant` | implant on the device and a completed follow-on | 1000 | additive, needs both halves | 2000 | none |
| `iot-corenet` | IoT endpoint to core network, work system compromised | 5000 | flat | 5000 | none |

3. Apply the dedup rules before recording, because a duplicate is not an error the server reports as an error — it silently does not count:

- G1: highest privilege only once per system, host or database. Upgrade a `user` row to `admin` instead of adding a second row.
- G2: data reached scores separately from the privilege that reached it; do not fold a row count into a shell claim.
- G3: the cap applies to one target org and all its children; the sum never exceeds the cap.
- G4: count devices by class — printer or wifi router 5, PC/pad/phone/camera/large screen 10, cloud host/container/consigned/IoT 10.
- G5: double for a system holding 100M rows or 10TB, and for a knowledge-base system; generated logs do not qualify.
- G6: IPv6 is worth 3x but never past the item cap.
- G7: some items require specific proof — routing table or session count for `netdev`, isolated-device control for `terminal-access` groups, endpoint-to-org relationship for phones and pads.
- G8: a system that fits no item goes to the review group rather than being forced into the closest code.

4. Check the cap with the live counter, not from memory. `cap_used`, `earned` and `capped` tell you whether this claim can still land:

```text
redteam_score_list          # inspect cap_used and capped for the code you intend to use
```

5. Choose the tier and write the evidence string. Evidence states the result, not the route: the asset, the account, the privilege and, for data, the volume in a parseable form.

```text
redteam_score_hit  code="server-host"  points=50  target="TARGET_IP:PORT"  port=PORT  \
  evidence="admin shell on TARGET_IP:PORT as root (id output uid=0), host is the deployment server for DOMAIN"  \
  vuln_id=<id>  self_created=false
```

6. For data claims, state the volume in a form the parser accepts — a count followed by a unit — and keep it separate from the privilege row:

```text
redteam_score_hit  code="db-credential"  points=50  target="TARGET_IP:PORT"  port=PORT  \
  evidence="MySQL root via redis module load; users table 1,320,000 rows dumped to RESULT_DIR/db-users.csv"
```

7. Set `self_created=true` when the account or privilege was created by the operator. The row is kept for the timeline and scores nothing; recording it as if it were target-owned is the one mistake that invalidates a whole report.

8. Link the artifact to the claim so the report can embed it. A screenshot with no claim, or a claim with no screenshot, both read as unverified:

```text
redteam_shot_add  path="RESULT_DIR/shot-TARGET-admin.png"  point_code="server-host"  \
  hit_id=<score_hit_id>  label="root shell and hostname banner"  source_ref="RESULT_DIR/root-shell.txt"
```

9. Reconcile at the end of the stage. Any `capped` or `capped_summary` item means the campaign hit a ceiling and more of the same will not score:

```text
redteam_score_report  limit=500  markdown=true
redteam_attack_chain
```

## Output and evidence

- One `redteam_score_hit` row per counted claim, with `code`, `points`, `target`, `port`, `evidence` and `vuln_id` when a vulnerability produced it.
- `redteam_chain_add` with `point_code` plus `evidence` when the hit belongs to an attack step; without `evidence` the server stores the step and skips the score.
- `redteam_shot_add` per claim, at most three images per item, with `hit_id` when the hit already exists.
- `RESULT_DIR/score-map.md` — the filled-in mapping table for this engagement: code, tier, target, evidence line, cap state.
- `redteam_score_report` output appended to `RESULT_DIR/score-report.md` at each stage close.

## Failure modes

- A real result scores nothing and no error appears → the code was capped or deduped at `system` scope → read `cap_used` and `capped_summary`, then switch target or drop the duplicate.
- `web-app` was used for a bastion or SSO console → wrong bucket, undercounting by 400 points → use `central-system` and keep the login evidence.
- A 200-response endpoint is claimed as `bigdata-system` → the data volume is below 500M rows or 1TB → it scores as `db-credential`; state the real count.
- Two rows for user and admin on the same host → G1 violation, one silently dropped → record only the higher tier.
- `point_code` given without `evidence` on a chain step → the score hit is skipped by design → re-add with both fields.
- Data claim written as prose ("large dump") → `parseRowCount` finds no number → restate as "1,320,000 rows".
- Operator-created account recorded without `self_created` → the claim is treated as target-owned → correct the flag; the row stays for the timeline only.

## Notes

- Codes are identifiers, not descriptions; `db-credential` is used even when the access came from SQL injection or an unauthenticated Redis.
- Tier selection is the whole game: user versus admin on the same host is a 5x difference, and the evidence must justify the higher one.
- Caps are per defended org, including subsidiaries; a second engagement against a related org inherits the same ceiling.
- Data outcomes and privilege outcomes are separate rows even when one command produced both.
- Idempotency: re-recording the same claim does not double it, but it does add noise to the timeline; check `hits` before adding.
- Keep the evidence string free of credentials; the report prints it, and secrets belong in `redteam_credential_add` with a `secret_ref`.
