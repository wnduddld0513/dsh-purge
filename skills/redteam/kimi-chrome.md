# kimi-chrome: Launch a Browser the WebBridge Extension Can Drive

This skill produces a running Chrome or Chromium process that the Kimi WebBridge extension attaches to, so a later step can read a JS-rendered DOM, harvest API endpoints and prove an authenticated login. It installs one launcher, `~/.local/bin/kimi-chrome`, and every invocation reuses CHROME_PROFILE so cookies, extension state and logged-in sessions survive a restart. DOM dumps, page titles and screenshots land under RESULT_DIR, and the rows describing them are recorded with `redteam_asset_add`, `redteam_shot_add` and `redteam_access_add`.

## When to use

- The target is a single-page app: `curl -s http://TARGET` returns a shell such as `<div id="root"></div>` with no title and no menu text.
- The capture needs the logged-in DOM: account dashboard, OA/ERP console, mail system, operations backend.
- You need the API list a bundle calls, and that list only appears once the app boots in a real engine.
- You must prove an account-class item with a genuine login: title, visible menus, logged-in username, one page transition.
- You need a screenshot of a rendered page as boundary or privilege evidence.
- Not for static fetching: `pd-httpx` and `curl` are cheaper and already return status, title and stack for server-rendered pages.
- Not for deterministic multi-step flows (pagination, repeated clicks, file download); the `playwright-cli` skill records a trace and replays cleanly.

## Prerequisites

- One browser binary: `apt install google-chrome-stable`, or `apt install chromium`. Verify with `command -v google-chrome chromium`.
- The launcher this skill writes. It is a small wrapper around the browser binary plus a profile flag.
- The WebBridge daemon when driving through the extension (see the `kimi-webbridge` skill). The launcher starts the unit as a fallback so the two skills work in either order.
- A writable profile directory, for example `CHROME_PROFILE=$HOME/.config/kimi-chrome`.
- `curl` and `jq` for health checks; `xdotool` only if you script window focus on a headful box.
- Nothing here is mandatory and every step has a fallback: without the extension, `chromium --headless=new --no-sandbox --dump-dom http://TARGET` renders the same DOM; without Chrome at all, `pd-httpx` still yields title and status for anything server-rendered.

## Workflow

1. Confirm a browser resolves, and record which one this run will use:

```bash
command -v google-chrome || command -v chromium || echo "no browser: apt install chromium"
```

2. Write the launcher. It starts the daemon on a best-effort basis, honours an optional `KIMI_BROWSER` selector (read it with `os.environ.get("KIMI_BROWSER", "")` when you reimplement this in Python), and pins the profile:

```bash
mkdir -p ~/.local/bin
cat > ~/.local/bin/kimi-chrome <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
systemctl start kimi-webbridge >/dev/null 2>&1 || sudo -n systemctl start kimi-webbridge >/dev/null 2>&1 || true
BIN=/usr/bin/google-chrome
case "${KIMI_BROWSER:-chrome}" in
  chromium|chromium-browser) BIN=/usr/bin/chromium ;;
esac
exec "$BIN" --no-first-run --no-default-browser-check \
  --user-data-dir="${CHROME_PROFILE:-$HOME/.config/kimi-chrome}" \
  --remote-debugging-port=9222 "$@"
EOF
chmod +x ~/.local/bin/kimi-chrome
```

3. Make the profile directory explicit for the run so later skills find the same cookies:

```bash
export CHROME_PROFILE="${CHROME_PROFILE:-$HOME/.config/kimi-chrome}"
mkdir -p "$CHROME_PROFILE"
```

4. Launch against the target. A headful window is what the extension attaches to; keep it in `tmux` so a dropped SSH session does not kill it:

```bash
tmux new -d -s chrome-1 "CHROME_PROFILE=$CHROME_PROFILE ~/.local/bin/kimi-chrome http://TARGET"
```

5. Confirm the extension actually attached. `extension_connected` is the field that matters:

```bash
curl -s http://127.0.0.1:10086/status | jq '{running, extension_connected, port, version}'
```

6. If the status is not `true`, start the browser first and re-check; the daemon reports the connection only while a compatible browser is alive:

```bash
~/.local/bin/kimi-chrome http://TARGET &
sleep 3
curl -s http://127.0.0.1:10086/status | jq .extension_connected
```

7. Read the rendered DOM when you only need text. This path needs no daemon at all:

```bash
chromium --headless=new --no-sandbox --disable-gpu \
  --user-data-dir="$CHROME_PROFILE" \
  --dump-dom "http://TARGET" > RESULT_DIR/dom-TARGET.html
grep -o '<title>[^<]*</title>' RESULT_DIR/dom-TARGET.html
```

8. Capture a screenshot as evidence. `--window-size` keeps the capture readable in the report:

```bash
chromium --headless=new --no-sandbox --disable-gpu \
  --user-data-dir="$CHROME_PROFILE" --window-size=1440,900 \
  --screenshot=RESULT_DIR/shot-TARGET.png "http://TARGET"
```

9. Harvest the API surface from the saved bundle, then keep only the paths that answer:

```bash
grep -oE '"(/api/[a-zA-Z0-9_/?=&.-]+|/v[0-9]/[a-zA-Z0-9_/?=&.-]+)"' RESULT_DIR/dom-TARGET.html \
  | tr -d '"' | sort -u > RESULT_DIR/api-TARGET.txt
wc -l RESULT_DIR/api-TARGET.txt
```

10. For a login proof, do it in the same profile so the session persists, then read the post-login page:

```bash
~/.local/bin/kimi-chrome "http://TARGET/login"
# fill the form in the window, submit, confirm the landing page shows the account name
curl -s http://127.0.0.1:10086/status | jq .extension_connected
```

11. Record what the session produced before moving on; a screenshot in RESULT_DIR that no row references is invisible to the report:

- `redteam_asset_add` with `ip=TARGET_IP`, `provenance=active`, `tool=kimi-chrome`, and a `ports` entry carrying `port=PORT`, `service=https`, `url=http://TARGET`, `title=<page title>`.
- `redteam_shot_add` with `path=RESULT_DIR/shot-TARGET.png`, `label="login landing page, account menu visible"`, `source_ref=RESULT_DIR/dom-TARGET.html`.
- `redteam_access_add` with `host=TARGET_IP`, `method=web-shell`, `username=<account>`, `privilege=user` once a login actually succeeded.

## Output and evidence

- `RESULT_DIR/dom-TARGET.html` — rendered DOM of the page the run actually reached (not the pre-JS shell).
- `RESULT_DIR/api-TARGET.txt` — de-duplicated endpoint list extracted from the bundle.
- `RESULT_DIR/shot-TARGET.png` — full-window capture used as visual evidence.
- `RESULT_DIR/kimi-chrome-session.txt` — the `status` JSON, launcher path, browser version and profile directory for this run.
- `redteam_asset_add` row per reachable web service, with `url` and `title` filled in — the report reads the title from there.
- `redteam_shot_add` row per capture, linked to the point code it supports when the page proves a privilege.
- `redteam_evidence_record` with `authority=tool-output`, `confidence=observed` and the raw `status` output when the daemon, not the page, is the thing being proven.

## Failure modes

- `status` shows `"running": true` but `extension_connected: false` → no compatible browser is alive → start `kimi-chrome`, wait three seconds, re-read status.
- `command not found: ~/.local/bin/kimi-chrome` → the wrapper was never written or lost its mode → re-run step 2 and `chmod +x`.
- Chrome opens a first-run wizard and the extension never loads → the launcher was bypassed, so `--no-first-run --no-default-browser-check` were dropped → call the wrapper, not the binary.
- Profile is locked after a crashed run → a stale `SingletonLock` remains in CHROME_PROFILE → kill the leftover process, then remove the lock file, never the whole profile.
- `--dump-dom` returns the same empty shell as `curl` → the page needs a real JS session or auth → use the extension path (steps 4-6) instead of headless dump.
- Extension is missing in Chrome 137+ → `--load-extension` is ignored by policy → let the enterprise policy install it, do not force-load a folder.
- Screenshot is blank or 0 bytes → the window closed before paint → add `--virtual-time-budget=5000` or keep the window alive in `tmux`.

## Notes

- One profile per engagement keeps cookies separable; a second profile means a second `CHROME_PROFILE` value, not a second install.
- Restarting the browser invalidates any handle captured from the old instance; re-read status and re-capture rather than reusing stale data.
- Keep the remote debugging port bound to loopback; do not expose 9222 or 10086 on INTERFACE.
- Rate: navigate no faster than `RATE` pages per minute with `THREADS=1`; parallel headful windows burn memory and trip login anomaly checks.
- The launcher is idempotent — rewriting it is safe and is the fastest fix for a corrupted flag set.
- Cleanup order: close the window, stop the unit if this run started it, then delete generated DOM dumps you did not reference from a row.
