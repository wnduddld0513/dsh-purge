# playwright-cli: Scripted Browser Sessions That Replay

This skill drives a browser through the Playwright CLI so a multi-step flow — login, paginate, click, wait, download — runs the same way twice and leaves a replayable trace. It is the deterministic counterpart to a hand-driven window: every navigation, fill and capture is a command you can re-run, diff or hand to another operator. Artifacts (screenshots, PDFs, cookie jars, DOM snapshots) land under RESULT_DIR, and the rows that describe them are recorded with `redteam_asset_add`, `redteam_access_add` and `redteam_shot_add`.

## When to use

- The flow has more than one step: authenticate, navigate a menu, open a record, paginate, export.
- A capture must be reproducible after a session loss, so the commands themselves are the documentation.
- You need a cookie jar or storage state for a second tool (`sqlmap`, `nuclei`, `ffuf`) rather than a screenshot.
- You need a PDF or a full-page screenshot of a rendered page.
- A previous attempt with `curl` failed because the content only exists after JS and after login.
- Not for a single page read: `chromium --headless=new --dump-dom http://TARGET` is one command and no install.
- Not for attacking the page (fuzzing parameters, injection points); this skill only reads and navigates.

## Prerequisites

- Node.js 18 or newer on PATH: `node --version`.
- The CLI itself, invoked through npx so nothing is installed globally: `npx --yes @playwright/cli@latest`.
- The Chromium build Playwright ships: `npx playwright install chromium`.
- Always pass `--browser chromium`. The default channel resolves to a `chrome` build that is usually absent, and the failure is `Chromium distribution 'chrome' is not found`.
- A profile or storage-state directory held in CHROME_PROFILE when you want cookies to persist between invocations.
- Nothing here is mandatory and every step has a fallback: if npx is unavailable, `chromium --headless=new --screenshot=... --dump-dom ...` covers static reads; if Playwright cannot install a browser, the `kimi-chrome` and `kimi-webbridge` skills drive the system browser instead.

## Workflow

1. Confirm the toolchain and pin the browser channel before writing any flow:

```bash
node --version
npx --yes @playwright/cli@latest --help
npx playwright install chromium
```

2. Open the target with the channel flag present. Keep one session per flow so the state machine stays simple:

```bash
npx --yes @playwright/cli@latest --browser chromium open http://TARGET
```

3. Snapshot the page before acting. The snapshot is the accessibility tree, which is what selectors should be built from — not pixel coordinates:

```bash
npx --yes @playwright/cli@latest --browser chromium snapshot > RESULT_DIR/snap-TARGET.txt
grep -iE 'button|textbox|link' RESULT_DIR/snap-TARGET.txt | head -40
```

4. Authenticate by filling the fields the snapshot named, then submit. Quote values with shell-safe quoting and never paste a real password into a saved script:

```bash
npx --yes @playwright/cli@latest --browser chromium fill "input[name=username]" "$APP_USER"
npx --yes @playwright/cli@latest --browser chromium fill "input[type=password]" "$APP_PASS"
npx --yes @playwright/cli@latest --browser chromium click "button[type=submit]"
sleep 2
npx --yes @playwright/cli@latest --browser chromium snapshot | head -20
```

5. Confirm the login landed before treating it as access. A redirect is not proof; a rendered account element is:

```bash
npx --yes @playwright/cli@latest --browser chromium eval "document.title"
npx --yes @playwright/cli@latest --browser chromium eval "document.querySelector('body').innerText.slice(0,200)"
```

6. Walk the flow the way a user does, waiting on state rather than sleeping where possible:

```bash
npx --yes @playwright/cli@latest --browser chromium click "text=Reports"
npx --yes @playwright/cli@latest --browser chromium snapshot > RESULT_DIR/snap-reports.txt
npx --yes @playwright/cli@latest --browser chromium click "text=Next"
```

7. Capture evidence at the moment it is true. Save both the DOM and the image so the finding survives a parser change:

```bash
npx --yes @playwright/cli@latest --browser chromium screenshot --full-page RESULT_DIR/shot-TARGET-full.png
npx --yes @playwright/cli@latest --browser chromium eval "document.documentElement.outerHTML" > RESULT_DIR/dom-TARGET.html
npx --yes @playwright/cli@latest --browser chromium pdf RESULT_DIR/TARGET.pdf
```

8. Export the session state when another tool needs the cookies. Storage state is JSON and is the portable form:

```bash
mkdir -p "$CHROME_PROFILE"
npx --yes @playwright/cli@latest --browser chromium eval "JSON.stringify(document.cookie)" > "$CHROME_PROFILE/cookies.json"
jq -r . "$CHROME_PROFILE/cookies.json" | head -c 300
```

9. Extract the API surface the flow touched, which is what the vuln stage consumes:

```bash
grep -oE '/api/[a-zA-Z0-9_/?=&.-]+' RESULT_DIR/dom-TARGET.html | sort -u > RESULT_DIR/api-TARGET.txt
wc -l < RESULT_DIR/api-TARGET.txt
```

10. Close the session and record the results. A closed session still leaves its files; a recorded row is what reaches the report:

```bash
npx --yes @playwright/cli@latest --browser chromium close
```

- `redteam_asset_add` with `ip=TARGET_IP`, `provenance=active`, `tool=playwright-cli`, and the `ports` entry carrying `url=http://TARGET`, `title=<document.title>`.
- `redteam_access_add` with `host=TARGET_IP`, `method=web-shell`, `username=<account>`, `session_ref=RESULT_DIR/dom-TARGET.html`.
- `redteam_shot_add` with `path=RESULT_DIR/shot-TARGET-full.png` and `source_ref` pointing at the DOM dump.
- `redteam_http_evidence_add` when a specific request/response pair proves the finding; copy the raw headers, not a summary.

## Output and evidence

- `RESULT_DIR/snap-*.txt` — accessibility snapshots used to build selectors; they double as the flow's readable record.
- `RESULT_DIR/dom-TARGET.html` — rendered DOM after the flow reached its final state.
- `RESULT_DIR/shot-TARGET-full.png` — full-page capture linked through `redteam_shot_add`.
- `RESULT_DIR/TARGET.pdf` — print rendering, useful for exporting a whole record set in one artifact.
- `$CHROME_PROFILE/cookies.json` — session material for a second tool; keep it out of the report body.
- `RESULT_DIR/api-TARGET.txt` — endpoint list for the vuln stage.
- A `redteam_chain_add` step with `stage_code=internet`, `tool` set to the exact CLI command text and `result` set to the observed output.

## Failure modes

- `Chromium distribution 'chrome' is not found` → the default channel was used → add `--browser chromium` to every command.
- `browserType.launch: Executable doesn't exist` → the browser build was never downloaded → run `npx playwright install chromium`.
- `npx` prints a package-not-found error → the registry is unreachable or the name was mistyped → `npx --yes @playwright/cli@latest --help` to confirm the package resolves.
- Selector resolves during a snapshot but times out on click → the element is inside an iframe or re-rendered after hydration → target the frame, or wait for the post-hydration snapshot first.
- Login appears to succeed but every page redirects back → the session cookie was rejected (wrong domain, `Secure` on plain HTTP) → repeat on the correct scheme.
- Screenshot is truncated → `--full-page` was omitted, or the page virtualizes its list → capture the visible viewport instead of pretending it is complete.
- Flow works once and fails on the second run → the profile still holds a logged-in session → clear CHROME_PROFILE or reuse the session deliberately.

## Notes

- One session per flow. Parallel flows on one profile corrupt each other's cookies, and the failure looks like a flaky selector.
- Keep `--browser chromium` in a shell variable (`PW="npx --yes @playwright/cli@latest --browser chromium"`) so it cannot be forgotten.
- Rate: pace navigations at roughly `RATE` per minute with `THREADS=1`; this tool is for correctness, not throughput.
- Credentials never go into a committed script; read them from the environment or a 600-mode file and keep the value out of RESULT_DIR.
- Idempotency: snapshots, screenshots and DOM dumps are safe to overwrite; a login step is not, so check state before re-authenticating.
- Cleanup: `close` every session at the end, then delete generated artifacts you never referenced from a row.
