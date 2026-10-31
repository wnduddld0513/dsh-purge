# CN Proxy Pool: Harvesting and Using Public HTTP/SOCKS Proxies

Builds a small, individually verified pool of public HTTP and SOCKS proxies and uses each one for exactly the command that needs it. The whole capability depends on nothing but `curl` and `python3`: harvest candidate `host:port` strings from published lists, validate them concurrently with a tight timeout, measure latency, and then pass the winner to a single command through `-proxy`, `-x` or `--proxy`. No system-wide proxy settings, no `proxychains` configuration file, no tunnel row — a public proxy is a vantage point for one request, not a path into the target network.

## When to use

- A quick check needs a source address other than this host's: a geo-dependent response, a rate-limited endpoint, or a redirect that reveals where a visitor is treated differently.
- A redirector is not available and the request is cheap enough to tolerate an unreliable exit node.
- You want to confirm that a response difference is caused by source geography rather than by authentication.
- Testing whether an application trusts `X-Forwarded-For` or an upstream proxy header.
- Not for authenticated work, not for anything you cannot afford to have logged by a stranger, and not for reaching internal hosts — a public pool never crosses the target boundary, so no `tunnel` row is ever recorded for it.
- Not when the request body or headers contain credentials or session tokens.

## Prerequisites

- `curl` and `python3` only. Nothing to install: `curl --version`, `python3 -V`. If `python3` is truly absent, `python -c` or `busybox wget` covers the validation step and everything else still works.
- One writable directory for the pool files: `mkdir -p RESULT_DIR`.
- A decision about the exit address before you start, because the validation request should not be the target itself.
- Nothing here is mandatory and every step has a fallback. No reachable list → seed the file by hand with proxies from a paste you already have. Validation blocked → lower `THREADS` to 4 and raise the timeout. Pool unusable for a given site → drop the pool and use the `VPS_IP` egress through `vps-reverse-shell` instead.
- Treat every harvested address as hostile: it sees your headers, your URL and your timing.

## Workflow

1. Harvest. Pull candidate lists and extract `ip:port` with one regex; keep the raw bodies so a bad source can be identified later.

```bash
mkdir -p RESULT_DIR/raw
for u in \
  "https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt" \
  "https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/socks5.txt" \
  "https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt" ; do
  curl -fsSL --max-time 20 "$u" -o "RESULT_DIR/raw/$(echo "$u" | md5sum | cut -c1-8).txt" || true
done
cat RESULT_DIR/raw/*.txt | grep -Eo '([0-9]{1,3}\.){3}[0-9]{1,3}:[0-9]{1,5}' \
  | sort -u > RESULT_DIR/proxies-candidates.txt
wc -l RESULT_DIR/proxies-candidates.txt
```

   A short list is normal — many published lists are stale. Never invent entries and never append one you have not validated.

2. Validate concurrently with a short timeout and a fixed probe URL. `--proxy` (curl 7.21+) is the flag name; `-x` is the short form.

```bash
python3 - <<'PY'
import concurrent.futures as cf, subprocess, os
src = os.path.join(os.environ.get("RESULT_DIR", "."), "proxies-candidates.txt")
probe = "http://httpbin.org/ip"
out = []
def check(line):
    p = line.strip()
    if not p:
        return None
    r = subprocess.run(["curl", "-sS", "--max-time", "8", "--proxy", "http://" + p, probe],
                       capture_output=True, text=True)
    if r.returncode == 0 and '"origin"' in r.stdout:
        return p
    return None
with open(src) as fh:
    lines = fh.readlines()
with cf.ThreadPoolExecutor(max_workers=60) as ex:
    for res in ex.map(check, lines):
        if res:
            out.append(res)
with open(os.path.join(os.environ.get("RESULT_DIR", "."), "proxies-validated.txt"), "w") as fh:
    fh.write("\n".join(out) + ("\n" if out else ""))
print("valid", len(out), "of", len(lines))
PY
```

   `origin` in the body must differ from this host's address. If it matches, the proxy forwarded you transparently and is worth nothing.

3. Rank by latency so later commands use the fast ones first, and keep the probe output as evidence of the exit address.

```bash
while read -r p; do
  t=$(curl -s -o /dev/null -w '%{time_total}' --max-time 8 --proxy "http://$p" http://httpbin.org/ip || echo 99)
  echo "$t $p"
done < RESULT_DIR/proxies-validated.txt | sort -n | tee RESULT_DIR/proxies-ranked.txt
```

4. Use one proxy for one command. Choose the flag by tool: `curl --proxy`, `wget -e use_proxy=yes -e http_proxy=`, `ffuf -x`, `nuclei -proxy`, `httpx -http-proxy`, `nmap --proxies` (very slow, avoid), and `python3 requests` with a `proxies=` dict.

```bash
P=$(head -1 RESULT_DIR/proxies-ranked.txt | awk '{print $2}')
curl -sS --max-time 12 --proxy "http://$P" -H 'Accept: */*' "https://DOMAIN/" -o RESULT_DIR/DOMAIN-via-$P.html -D RESULT_DIR/DOMAIN-via-$P.headers
grep -iE '^(server|via|x-forwarded|x-cache)' RESULT_DIR/DOMAIN-via-$P.headers
```

5. Compare with a direct request before drawing any conclusion. The whole point is the difference.

```bash
curl -sS --max-time 12 "https://DOMAIN/" -o RESULT_DIR/DOMAIN-direct.html
sha256sum RESULT_DIR/DOMAIN-direct.html RESULT_DIR/DOMAIN-via-*.html
diff <(head -60 RESULT_DIR/DOMAIN-direct.html) <(head -60 RESULT_DIR/DOMAIN-via-$P.html) | head -40
```

6. Rotate deliberately, not in a loop. One proxy per logical action, `RATE` respected, and a fresh proxy only after a failure.

```bash
for P in $(awk '{print $2}' RESULT_DIR/proxies-ranked.txt | head -5); do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 --proxy "http://$P" "https://DOMAIN/PORT" || echo 000)
  echo "$code $P"; sleep 2
done | tee RESULT_DIR/proxies-recheck.txt
```

   `000` means transport failure, not a 4xx; keep those two apart in the notes.

7. Never touch the host's own proxy configuration. Keep the per-command form and, if a tool needs an environment variable, scope it to that single invocation.

```bash
env http_proxy="http://$P" https_proxy="http://$P" curl -sS --max-time 12 "https://DOMAIN/" -o /dev/null -w '%{http_code}\n'
# forbidden in this skill: writing to /etc/proxychains4.conf, netsh winhttp set proxy, XDG proxy settings, ~/.curlrc
```

## Output and evidence

- `RESULT_DIR/raw/*.txt` — untouched harvest bodies, one per source.
- `RESULT_DIR/proxies-candidates.txt`, `RESULT_DIR/proxies-validated.txt`, `RESULT_DIR/proxies-ranked.txt` — candidate list, verified list, and latency ranking.
- `RESULT_DIR/DOMAIN-via-<proxy>.html` plus `.headers` and `RESULT_DIR/DOMAIN-direct.html` — the paired responses that justify any claim of a geographic difference.
- `RESULT_DIR/proxies-recheck.txt` — status codes per proxy for the action actually needed.
- `redteam_evidence_record` with `operation=proxy_pool_check`, `authority=tool-output`, `confidence=observed`, and `limitations` naming the proxy address, its validation timestamp and the fact that the exit node is untrusted.
- No `redteam_tunnel_add`: a public proxy does not cross the target boundary and adding a tunnel row would misrepresent the data model. When a difference is confirmed, record it as an `asset` note or an attack-file observation instead.
- `redteam_asset_add` with `provenance=passive` when a proxy-based request reveals a name or address that the direct request did not.
- `redteam_attack_file_add` with `kind=other` when a specific proxy response demonstrates header trust (`X-Forwarded-For` honoured) and the evidence is the response pair.

## Failure modes

- Validation returns the same `origin` as a direct request → the proxy is transparent and useless as a vantage point → discard; a proxy must change the observed source address.
- Most proxies fail with `curl: (56) CONNECT tunnel failed, response 403` → the proxy requires auth or filters the CONNECT target → try `https://` probe destinations, and skip the entry if it never succeeds.
- `curl: (7) Failed to connect ... port 8080: Connection refused` → the published entry is dead → drop it; do not retry the same address more than twice.
- `curl: (28) Operation timed out` on a proxy that validated earlier → the node is overloaded → rerun the latency ranking and take the next address.
- Response bodies differ in a way that looks like a geo difference but also shows a proxy interstitial → the exit node injects its own page → check for a `Server` header naming the proxy and discard the observation.
- `python3: can't open file` right after validation → `RESULT_DIR` was not exported for the heredoc → pass absolute paths instead of relying on the environment.
- Validation succeeds and the target request 403s with a bot check → the exit address is already flagged → rotate once, then stop; hammering a flagging list is the fastest way to get the whole pool blocked.
- A tool ignores `--proxy` and still connects directly → it reads environment variables only → prefix that single command with `env http_proxy=... https_proxy=...` and confirm the exit address again.

## Notes

- Rate: keep `THREADS` around 40-60 for validation and never more than 1 in flight against `DOMAIN` at a time. Respect `RATE` as a per-second ceiling; a public proxy multiplies your request count by its own retries.
- Opsec: the exit node logs the URL, headers and timing. Send no cookies, no tokens, no internal hostnames — the probe should be a public endpoint and the real request should be one you would not mind seeing in someone else's log.
- Idempotency: every run rewrites `proxies-candidates.txt` and `proxies-validated.txt`; keep the timestamp in the file name if you need history across runs. Validation is cheap enough to repeat, so never reuse yesterday's list silently.
- Resume: the validated file is the resume point. A rotation interrupted halfway is restarted from the ranked list, not from the harvest.
- Cleanup: delete `RESULT_DIR/raw/` and the pool files when the engagement closes, since they are third-party addresses that age badly; remove any downloaded response body that contains data; confirm with `git status` equivalent review that no proxy setting was written to the host — nothing in this skill persists outside `RESULT_DIR`.
