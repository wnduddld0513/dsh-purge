# kimi-webbridge: Drive a Real Browser Through the Local WebBridge Daemon

This skill controls the Kimi WebBridge daemon that listens on `127.0.0.1:10086` and relays commands into a real Chrome window through the enterprise-installed extension. It is the path for pages that only exist after JavaScript boots and after a login, so it produces rendered DOM, the API list a bundle calls, screenshots and a session proof. Outputs land under RESULT_DIR and every capture is mirrored into `redteam_asset_add`, `redteam_shot_add` or `redteam_access_add` so the report can cite it.

## When to use

- A page renders client-side and `curl` shows an empty mount point with no title.
- The run needs the authenticated view: menus, account name, tenant switch, inbox counters.
- You want the endpoint list a bundle uses, harvested from a live session rather than from static JS.
- You must confirm a login really landed before an account-class score item is claimed.
- You need a repeatable "open, read, screenshot" loop without writing a Playwright script.
- Not for bulk fetching or fuzzing — `ffuf`, `nuclei` and `pd-httpx` are the right tools and produce machine-readable output.
- Not for load generation; one daemon drives one interactive window, and concurrency is capped by the browser, not by this skill.

## Prerequisites

- The daemon binary at `~/.kimi-webbridge/bin/kimi-webbridge`, managed by the unit `/etc/systemd/system/kimi-webbridge.service`.
- The browser side: a Chrome or Chromium window started through `kimi-chrome` (see the `kimi-chrome` skill). The extension is force-installed by enterprise policy under id `fldmhceldgbpfpkbgopacenieobmligc`.
- `curl` and `jq` for every health and control call; `systemctl` access for start and restart.
- A browser profile directory held in CHROME_PROFILE, so the attached session keeps its cookies between runs.
- Nothing here is mandatory and every step has a fallback: with no daemon, `chromium --headless=new --dump-dom` still renders JS; with no extension, `playwright-cli` drives the same flow with `--browser chromium`.

## Workflow

1. Read the current state first. A daemon that is up but not attached is the common case, and the fix differs from a stopped unit:

```bash
systemctl is-active kimi-webbridge; ~/.kimi-webbridge/bin/kimi-webbridge status | jq .
curl -s http://127.0.0.1:10086/status | jq '{running, extension_connected, port}'
```

2. Start or restart the unit when `running` is false. `enable --now` is idempotent and is safe to repeat:

```bash
sudo systemctl enable --now kimi-webbridge
sleep 2
~/.kimi-webbridge/bin/kimi-webbridge status | jq .running
```

3. When the unit is active but the port refuses connections, reload the unit file instead of guessing at the port:

```bash
sudo systemctl daemon-reload
sudo systemctl restart kimi-webbridge
ss -lntp | grep 10086
```

4. Bring up a browser window so the extension can attach. The daemon never launches a browser for you:

```bash
tmux new -d -s wb-1 "CHROME_PROFILE=$CHROME_PROFILE ~/.local/bin/kimi-chrome about:blank"
sleep 3
curl -s http://127.0.0.1:10086/status | jq .extension_connected
```

5. Navigate and read the rendered document. Save the raw DOM before extracting anything, so a later parser change does not force a re-navigation:

```bash
mkdir -p RESULT_DIR/dom
curl -s -X POST http://127.0.0.1:10086/navigate \
  -H 'content-type: application/json' \
  -d '{"url":"http://TARGET"}' | jq .
sleep 3
curl -s http://127.0.0.1:10086/dom > RESULT_DIR/dom/TARGET.html
grep -o '<title>[^<]*</title>' RESULT_DIR/dom/TARGET.html
```

6. Pull the visible text when you only need content, and keep the title separate because the asset row wants it verbatim:

```bash
curl -s http://127.0.0.1:10086/text | sed 's/[[:space:]]\+/ /g' > RESULT_DIR/text-TARGET.txt
head -40 RESULT_DIR/text-TARGET.txt
```

7. Capture a screenshot for the report. One image per claim is enough; three is the practical ceiling per score item:

```bash
curl -s http://127.0.0.1:10086/screenshot -o RESULT_DIR/shot-TARGET.png
file RESULT_DIR/shot-TARGET.png
```

8. For an authenticated capture, navigate to the login page, log in inside the window, then re-read the DOM. The daemon keeps the session, so the next call sees the logged-in view:

```bash
curl -s -X POST http://127.0.0.1:10086/navigate -H 'content-type: application/json' \
  -d '{"url":"http://TARGET/login"}' | jq .
# submit the form in the window, confirm the landing page shows the account name
curl -s http://127.0.0.1:10086/dom > RESULT_DIR/dom/TARGET-after-login.html
grep -oiE '(welcome|logout|sign out|admin|'$(whoami)')\b' RESULT_DIR/dom/TARGET-after-login.html | sort -u
```

9. Harvest the API surface from the live document plus the bundle it references:

```bash
grep -oE '"(/api/[a-zA-Z0-9_/?=&.-]+|/v[0-9]/[a-zA-Z0-9_/?=&.-]+)"' RESULT_DIR/dom/*.html \
  | sed 's/"//g' | sort -u > RESULT_DIR/api-surface.txt
wc -l < RESULT_DIR/api-surface.txt
```

10. Record the outcome per asset, not once per session:

- `redteam_asset_add` with `ip=TARGET_IP`, `provenance=active`, `tool=kimi-webbridge`, and a `ports` entry with `port=PORT`, `service=https`, `url=http://TARGET`, `title=<exact title>`.
- `redteam_shot_add` with `path=RESULT_DIR/shot-TARGET.png`, `label`, `source_ref`, and `point_code` only when the page itself proves the privilege.
- `redteam_access_add` with `method=web-shell` and the real `username` after a successful login; without a login there is no access row.
- `redteam_evidence_record` with `authority=tool-output`, `confidence=observed` when the daemon status is the thing being documented.

11. Shut the run down cleanly so the next skill starts from a known state:

```bash
tmux kill-session -t wb-1 2>/dev/null || true
sudo systemctl stop kimi-webbridge   # only if this run started it
```

## Output and evidence

- `RESULT_DIR/dom/TARGET.html`, `RESULT_DIR/dom/TARGET-after-login.html` — rendered DOM before and after authentication.
- `RESULT_DIR/text-TARGET.txt` — whitespace-normalized visible text for diffing or quoting.
- `RESULT_DIR/shot-TARGET.png` — screenshot attached through `redteam_shot_add`.
- `RESULT_DIR/api-surface.txt` — endpoint list used by the vuln and exploit stages.
- `RESULT_DIR/webbridge-status.txt` — the status JSON at start and end of the run.
- A `redteam_access_add` row only when a login actually succeeded; a `redteam_asset_test` `surface` entry when the only finding is an exposed login page.

## Failure modes

- `curl: (7) Failed to connect to 127.0.0.1 port 10086` → the unit is not running → `sudo systemctl enable --now kimi-webbridge`, then re-read status.
- `"running": true` together with `extension_connected: false` → no browser window is alive → start `kimi-chrome`, wait three seconds, re-check.
- Status is healthy but navigation returns the pre-JS shell → the window is on the wrong profile or the extension is attached to another tab → close extra windows and re-navigate.
- Extension never appears after a Chrome upgrade → the enterprise policy lags the new major version → install the older channel, do not attempt `--load-extension`.
- 10086 is taken by another process → the unit exits at start → `ss -lntp | grep 10086`, then stop the squatter.
- DOM call returns stale content → the navigation did not finish before the read → increase the sleep, or poll the title until it changes.
- Screenshot is black → the window is minimized or occluded in a headless X session → use a headless capture instead.

## Notes

- One daemon serves one window; a second interactive browser needs a second profile and will fight over the extension attachment.
- Bind everything to loopback. Never publish 10086 or the debugging port on INTERFACE.
- The status endpoint is the cheapest liveness probe; poll it rather than restarting the unit, which drops the attached session.
- Idempotency: navigation and DOM reads are safe to repeat, a login flow is not — re-running it with a live session lands on an already-authenticated page and produces misleading evidence.
- Rate: keep interactive navigations to roughly `RATE` per minute; bursty reloading triggers account lockout far more often than it reveals content.
- Resume behaviour: after a daemon restart the attached window must be re-navigated; nothing about the previous tab survives.
