# browser-automation: Capture JS-Rendered Pages and Prove a Session

This skill is the decision layer for browser work: it picks the cheapest engine that can actually see the page, captures the rendered DOM, title, endpoint list and screenshot, and records them against the right asset. It exists because most "the target returns nothing" reports are an engine mismatch, not a dead host. Outputs land under RESULT_DIR and are mirrored into `redteam_asset_add`, `redteam_shot_add` and `redteam_access_add` so a later stage can act on them without re-visiting the page.

## When to use

- `curl` or `pd-httpx` returns a shell with no title and no readable content, and the page is clearly alive.
- The asset list needs the API endpoints a bundle calls, which only exist after the app boots.
- An account-class claim needs a real login: title, menus, account name, one page transition.
- A rendered screenshot is required as evidence for a boundary or privilege claim.
- Not for server-rendered pages: `pd-httpx` plus `curl` already return status, title and stack, and are far cheaper.
- Not for finding vulnerabilities: this skill reads and captures; `nuclei`, `sqlmap` and `ffuf` are the next stage.

## Prerequisites

- A browser binary: `apt install chromium` or `apt install google-chrome-stable`.
- Optional engines, chosen by the table in step 2: `npx playwright install chromium` for scripted flows, the WebBridge daemon for interactive ones.
- `curl` and `jq` for health checks, `grep`/`sed` for extraction.
- A profile directory in CHROME_PROFILE for any path that must keep cookies.
- Nothing here is mandatory and every step has a fallback: the engine table always has a no-extension, no-install row, and a failed capture is recorded as an `untested` surface rather than a finding.

## Workflow

1. Confirm the page is actually alive before blaming the renderer:

```bash
curl -s -o /dev/null -w '%{http_code} %{size_download}\n' http://TARGET
curl -s http://TARGET | head -c 400
```

2. Pick the engine by what the page needs. Do not start with the most expensive row.

| Symptom | Engine | Command |
| --- | --- | --- |
| Server-rendered, title present | none | `curl -s http://TARGET` |
| JS renders, no login needed | headless Chromium | `chromium --headless=new --no-sandbox --dump-dom http://TARGET` |
| Multi-step flow, replay needed | Playwright CLI | `npx --yes @playwright/cli@latest --browser chromium open http://TARGET` |
| Login plus interactive walk | WebBridge | `~/.local/bin/kimi-chrome http://TARGET` then the daemon status check |
| Only a screenshot is needed | headless Chromium | `chromium --headless=new --screenshot=RESULT_DIR/shot-TARGET.png http://TARGET` |

3. Render headless and save the DOM. This row needs no daemon, no extension and no install beyond the browser:

```bash
mkdir -p RESULT_DIR/dom
chromium --headless=new --no-sandbox --disable-gpu --virtual-time-budget=5000 \
  --user-data-dir="${CHROME_PROFILE:-$HOME/.config/recon-chrome}" \
  --dump-dom "http://TARGET" > RESULT_DIR/dom/TARGET.html
grep -o '<title>[^<]*</title>' RESULT_DIR/dom/TARGET.html
```

4. Compare the rendered title with the raw one. A difference is the proof that the engine mattered, and it belongs in the step record:

```bash
printf 'raw:      '; curl -s http://TARGET | grep -o '<title>[^<]*</title>' || echo '(none)'
printf 'rendered: '; grep -o '<title>[^<]*</title>' RESULT_DIR/dom/TARGET.html || echo '(none)'
```

5. Extract the endpoint surface from the rendered DOM, then keep only paths that answer. A bundle lists far more routes than the app exposes:

```bash
grep -oE '"(/api/[a-zA-Z0-9_/?=&.-]+|/[a-z]+/v[0-9]/[a-zA-Z0-9_/?=&.-]+)"' RESULT_DIR/dom/*.html \
  | tr -d '"' | sort -u > RESULT_DIR/api-candidates.txt
while read -r p; do
  code=$(curl -s -o /dev/null -w '%{http_code}' "http://TARGET$p")
  printf '%s %s\n' "$code" "$p"
done < RESULT_DIR/api-candidates.txt | sort -rn > RESULT_DIR/api-TARGET.txt
head -20 RESULT_DIR/api-TARGET.txt
```

6. Capture the screenshot in the same session that produced the DOM, otherwise the two artifacts can disagree:

```bash
chromium --headless=new --no-sandbox --disable-gpu \
  --user-data-dir="${CHROME_PROFILE:-$HOME/.config/recon-chrome}" --window-size=1440,900 \
  --screenshot=RESULT_DIR/shot-TARGET.png "http://TARGET"
file RESULT_DIR/shot-TARGET.png
```

7. When a login is required, drive it in a persistent profile so the post-login DOM is real and not a replay of the login form:

```bash
export CHROME_PROFILE="${CHROME_PROFILE:-$HOME/.config/recon-chrome}"
~/.local/bin/kimi-chrome "http://TARGET/login"
# authenticate interactively, then confirm the reloaded page shows the account name
curl -s http://127.0.0.1:10086/dom > RESULT_DIR/dom/TARGET-after-login.html
grep -oiE '(logout|sign out|welcome|admin|profile)' RESULT_DIR/dom/TARGET-after-login.html | sort -u
```

8. Record the asset before the next asset, not at the end of the run. A late batch loses the per-asset title:

- `redteam_asset_add` with `ip=TARGET_IP`, `provenance=active`, `tool=chromium|playwright-cli|kimi-webbridge`, `state=live`, and a `ports` entry: `port=PORT`, `service=https`, `url=http://TARGET`, `title=<rendered title>`.
- A second `redteam_asset_add` only when the rendered page reveals a different hostname; put it in `names` instead if it is the same asset.
- `redteam_asset_test` with `status=tested` and `test="rendered with chromium, title=<title>"` so the engine that worked is recorded.
- `redteam_asset_test` with `status=no_surface` when both engines agree the page is an empty shell.

9. Attach the evidence to whatever it proves:

- `redteam_shot_add` `path=RESULT_DIR/shot-TARGET.png`, `point_code` only if the page demonstrates a privilege, `hit_id` when a score hit already exists.
- `redteam_access_add` `method=web-shell`, `username=<account>` after a real login, with `session_ref` pointing at the post-login DOM.
- `redteam_http_evidence_add` for a request/response pair that proves an unauthenticated endpoint; include raw headers.

10. Hand off what the next stage needs, and nothing else. The vuln stage wants `RESULT_DIR/api-TARGET.txt` plus the login state, not a directory of screenshots:

```bash
printf '%s\n' "engine: chromium" "title: $(grep -o '<title>[^<]*</title>' RESULT_DIR/dom/TARGET.html)" \
  "endpoints: $(wc -l < RESULT_DIR/api-TARGET.txt)" "login: $(test -s RESULT_DIR/dom/TARGET-after-login.html && echo yes || echo no)" \
  > RESULT_DIR/browser-TARGET.summary
```

## Output and evidence

- `RESULT_DIR/dom/TARGET.html` — rendered DOM; the primary artifact of this skill.
- `RESULT_DIR/dom/TARGET-after-login.html` — present only when a login genuinely succeeded.
- `RESULT_DIR/api-TARGET.txt` — endpoint list with observed status codes, sorted so the 200s are on top.
- `RESULT_DIR/shot-TARGET.png` — rendered capture, linked through `redteam_shot_add`.
- `RESULT_DIR/browser-TARGET.summary` — engine, title, endpoint count and login flag, the one file the next stage reads.
- `redteam_asset_add` with `url` and `title` filled — the report prints the title from this row, not from the file.

## Failure modes

- Rendered DOM equals the `curl` output → the page is server-rendered after all → stop here and record `status=tested`; do not escalate to Playwright.
- `--dump-dom` hangs → the page never reaches an idle state (long poll, websocket) → add `--virtual-time-budget=5000` and accept a snapshot.
- Rendered DOM shows a login form when the asset was expected to be open → session expired or the profile is fresh → authenticate in CHROME_PROFILE and re-capture.
- Title is present but the menu body is empty → content loads after a second request → wait for the post-hydration DOM instead of reading the first paint.
- Every endpoint in the candidate list answers 401 → the login state was not carried into the loop → re-run step 5 in the authenticated session.
- Screenshot is black → a headless GPU or occlusion problem → add `--disable-gpu`, or capture the viewport instead of the full page.
- Chrome refuses to start as root → add `--no-sandbox`; never bake that flag into a production wrapper.

## Notes

- Cheapest engine first. A page that `curl` already renders costs one request; the same page through Playwright costs a process, a profile and several seconds.
- One profile per engagement. Cookies from one target in a shared profile turn a clean capture into a confusing "already logged in" page.
- Restarting an engine invalidates handles; re-navigate rather than reusing a captured DOM after a restart.
- Rate: at most `RATE` page loads per minute with `THREADS=1`; a browser farm against one host is a different, noisier experiment.
- Idempotency: DOM dumps and screenshots overwrite safely; login and form submission do not, so check the rendered state before repeating them.
- Keep loopback-only ports loopback-only; the debugging port is a full browser control channel.
