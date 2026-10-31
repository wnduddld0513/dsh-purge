# specialist-paths: Pick the Exploitation Path That Fits the Asset Class

This skill routes an asset to the specialist path that actually has tooling behind it — directory and identity, boundary equipment, cloud and Kubernetes, IoT and OT, file and backup, or AI and agent infrastructure — and names the commands, the point codes and the evidence each path must leave. It is a routing document used after asset collection and before the vuln stage, so it produces a path decision per asset rather than a scan. The decision, the chosen path and the reason are recorded on the asset through `redteam_asset_assess`.

## When to use

- The asset list has enough rows that "scan everything the same way" would waste the campaign.
- An asset answers on an unusual port and the meaning of that port decides the whole approach.
- A path stalls and the next move is another class of asset, not more of the same scanning.
- You need the point code before spending time: some paths pay 5000 and some pay 10.
- Not for collecting the assets themselves; `recon-pipeline` and `active-scan` own that.
- Not for the final scoring decision on a specific result; `score-coverage` owns that ruling.

## Prerequisites

- Whatever the chosen path needs, and nothing more. Each path below names its tools and the fallback when a tool is absent.
- One reachable vantage point per path: internet-facing for boundary work, a tunnel for internal paths.
- `redteam_asset_query` to pull the unassessed rows, `redteam_asset_assess` to record the decision.
- Nothing here is mandatory and every step has a fallback: every path lists a client-only variant that needs no binary beyond `curl` or a language runtime.

## Workflow

1. Pull the rows that have no assessment yet and route them by the strongest signal on the asset:

```text
redteam_asset_query  sort=todo
```

| What you see | Path | First code to chase |
| --- | --- | --- |
| 445/389/88/636, an `LDAP` or `kerberos` banner | identity and directory | `central-system`, `domain-control` |
| 443 on a gateway model string, `SSLVPN`, `GlobalProtect`, `AnyConnect` | boundary equipment | `boundary-logical`, `netdev` |
| 6443, 10250, 2379, a registry on 5000, metadata reachable | cloud and Kubernetes | `cloud-platform`, `central-system` |
| 502, 102, 1883, 47808, 9100, a device web UI | IoT and OT | `iiot`, `iot-platform`, `terminal-access` |
| 2049, 873, 139, 9200, a backup console | file and backup | `file-storage`, `bigdata-system` |
| 11434, 8000 with `/v1/`, 8888, an `MLflow` UI | AI and agent | `ai-agent`, `model-compute`, `model-data` |

2. Identity and directory. Enumerate before touching credentials, and keep every command read-only until a real account is proven:

```bash
netexec smb TARGET_IP -u '' -p '' --shares
enum4linux -a TARGET_IP 2>&1 | tee RESULT_DIR/enum-TARGET_IP.txt
impacket-GetNPUsers DOMAIN/ -dc-ip TARGET_IP -no-pass -usersfile RESULT_DIR/users.txt
```

3. Boundary equipment. Identify the exact build first; a VPN appliance is worth an Nday, and a wrong version guess wastes the window:

```bash
nmap -Pn -sV -p 443,4443,10443 TARGET_IP -oN RESULT_DIR/vpn-fingerprint.txt
curl -sk "https://TARGET_IP:PORT/remote/login" | grep -oiE '(fortinet|pulse|citrix|globalprotect|anyconnect)' | sort -u
nuclei -u https://TARGET_IP:PORT -t ~/.local/nuclei-templates/http/cves -severity critical,high -o RESULT_DIR/vpn-cves.txt
```

4. Cloud and Kubernetes. The metadata endpoint is the cheapest proof of cloud presence; a kubelet or API server that answers unauthenticated is the cheapest proof of control:

```bash
curl -s -m 3 http://169.254.169.254/latest/meta-data/instance-id; echo
curl -sk "https://TARGET_IP:10250/pods" | head -c 400
curl -sk "https://TARGET_IP:6443/version" | head -c 200
```

5. IoT and OT. Identify the protocol, then decide whether the objective is the device or the plant network behind it. Never write to a register during identification:

```bash
nmap -Pn -sU -p 502,102,1883,47808 TARGET_IP -oN RESULT_DIR/ot-udp.txt
nmap -Pn -sV -p 80,443,8080,9100 TARGET_IP -oN RESULT_DIR/ot-web.txt
curl -s "http://TARGET_IP:PORT/" | grep -oiE '(siemens|schneider|rockwell|honeywell|axis)' | sort -u
```

6. File and backup. A backup server is usually the shortest route to a large data claim, so establish the share list before attempting any credential:

```bash
netexec smb TARGET_IP -u '' -p '' --shares
showmount -e TARGET_IP 2>/dev/null
curl -s "http://TARGET_IP:9200/_cat/indices?v" | head -20
```

7. AI and agent infrastructure. Probe for an unauthenticated model endpoint and for the tooling around it; the control plane is worth far more than the model:

```bash
curl -s -m 3 "http://TARGET_IP:11434/api/tags" | head -c 300; echo
curl -s -m 3 "http://TARGET_IP:PORT/v1/models" -H 'authorization: bearer none' | head -c 300
curl -s -m 3 "http://TARGET_IP:8888/api/contents" | head -c 200
```

8. Record the routing decision per asset, in the same pass that makes it. A path chosen but not written down is indistinguishable from a random scan:

```text
redteam_asset_assess  asset_id=<id>  priority="high"  \
  potential="account privileges + internal pivot"  \
  reason="Fortinet SSL-VPN build on 443, CVE match, single factor login, sits on the zone edge"  \
  assessed_by="assess"
```

9. Note the surface each path still needs, so the next agent inherits a task and not a mystery:

```text
redteam_asset_test  asset_id=<id>  status="blocked"  blocked=1  \
  surface="VPN portal reachable, login form single-factor, no MFA prompt observed"  \
  notes="needs a credential or an Nday; replay from RESULT_DIR/vpn-fingerprint.txt"
```

10. When a path needs an internal vantage point, state it as a dependency rather than improvising a scan through a host you do not control:

```bash
# internal paths only after a tunnel exists, and only through it
nmap -Pn -sT -p 445,3389,5985 --open TARGET_IP -oN RESULT_DIR/internal-TARGET_IP.txt
# with a socks5 landing point from redteam_tunnel_list
proxychains4 -f RESULT_DIR/proxychains-PORT.conf nmap -Pn -sT -p 445 TARGET_IP
```

11. Close the loop before switching paths. One path per pass, one artifact per command, one assessment row per asset:

- [ ] Every routed asset has an `redteam_asset_assess` row with `priority`, `potential` and `reason`.
- [ ] Every command output that justified the routing is under RESULT_DIR and is named in `reason`.
- [ ] The point code the path targets is named in `potential`.
- [ ] Paths needing a tunnel are marked blocked, not attempted directly.
- [ ] No write operation was issued to an OT protocol port.

## Output and evidence

- `RESULT_DIR/enum-*.txt`, `RESULT_DIR/*-fingerprint.txt` — version and stack identification per path.
- `RESULT_DIR/ot-udp.txt`, `RESULT_DIR/ot-web.txt` — protocol and vendor identification, read-only.
- `RESULT_DIR/internal-*.txt` — internal path output, always produced through the tunnel.
- `redteam_asset_assess` rows: `priority`, `potential` (the point code it aims at), `reason` (the observed evidence), `assessed_by`.
- `redteam_asset_test` rows with `surface` for reachable-but-unproven paths and `blocked` when a control is in the way.
- `redteam_tunnel_add` first when an internal path is chosen; a boundary claim with no tunnel entry scores nothing.

## Failure modes

- Path chosen from the port number alone → the banner was never read → run `nmap -sV` and match the vendor string before committing.
- Identity path stalls at anonymous enumeration → no null session and no user list → build the list from a web leak or `kerbrute`, and record the gap with `redteam_unknown_record`.
- VPN fingerprint matches nothing → the appliance is behind a proxy or a custom build → capture the TLS certificate subject and reuse it as a search key.
- Metadata endpoint times out → the host is not in that cloud, or egress to 169.254.169.254 is filtered → try the alternate provider addresses once, then drop the path.
- OT scan causes a device alarm → a write or a malformed packet reached a live controller → stop the path, record `blocked`, and do not repeat it.
- Backup share is empty but the console is open → the data lives on the console's own storage → pursue the console, not SMB.
- Model endpoint returns 401 with every key → the auth is real → the control plane (jupyter, k8s, registry) is the better target.

## Notes

- Route by evidence, not by convention: a host on 445 is not automatically a directory member, and a host on 502 is not automatically worth the risk.
- One path per pass keeps the noise budget intact; two paths in parallel double the alerting surface for the same result.
- Access to an internal path always needs `redteam_tunnel_add` first; scanning straight from the drill host into a private range produces a boundary claim the report cannot support.
- Rate: keep OT and IoT identification at `RATE=1` and `THREADS=1`; those devices fail closed and do not recover.
- Idempotency: fingerprinting is safe to repeat, authentication attempts are not — a lockout costs a path.
- Record the vendor string verbatim in `reason`; it is the only part of the routing decision that survives a rebuild.
