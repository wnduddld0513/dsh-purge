/**
 * 점수 규칙: 판정 기준 + 기본 득점 항목(의존성 없음, node: 내장 모듈만 사용).
 *
 * core.js 에서 분리해 낸 모듈이며, 이 프로젝트에서 **가장 따로 읽어야 할 코드**이기도 하다:
 * 패널 / 보고서 / 공격 체인 세 곳의 총점이 반드시 일치해야 하는데, 그걸 가능하게 하는 것이 여기의 applyScoreCaps 와
 * evaluateScoreBoard 가 **유일한 구현**이다 —— 세 곳에 각각 따로 쓰면 반드시 서로 다른 기준으로 어긋난다.
 *
 * 역할 분담:
 *   · applyScoreCaps       —— 주어진 적중 행에 대해 어느 것이 득점이고 어느 것이 상한 적용/상한 초과인지 표시한다;
 *   · evaluateScoreBoard   —— "메타데이터 읽기 + applyScoreCaps 호출 + 표시 되쓰기"를 하나의 진입점으로 묶는다;
 *   · DEFAULT_SCORE_POINTS —— 규칙 문서를 펼친 뒤의 득점 항목 정의(src/rule/cap/dedup_scope).
 */

/* targetHasIpv6Host 는 IPv6 리터럴을 판정해야 한다: ip-utils 의 같은 구현을 재사용해 두 벌의 정규식이 어긋나는 일을 막는다 */
import { isIpv6 } from './ip-utils.js'

/* ------------------------------------------------------------------ 판정 규칙 */

/* ------------------------------------------------------------------ 판정 규칙 */

/**
 * 무엇이 "진짜 터널"인가(경계 돌파/내부 네트워크 돌파의 증빙으로 인정): **반드시 타깃 경계를 넘어야 한다**,
 * 즉 채널의 한쪽 끝이 대상 측에 있어야 한다. 세 가지 경우:
 *   · target-outbound : 대상이 자발적으로 우리 서버로 연결(리버스 shell 착지, 대상에서 frp/Stowaway 클라이언트 실행)
 *   · target-http : 대상의 WebShell/HTTP 채널 경유(suo5, Neo-ReGeorg, reGeorg, 자체 제작 HTTP 터널)
 *   · target-agent : 대상에서 이미 장악한 프로세스/세션을 경유해 전달되는 터널(SSH -R 을 대상이 시작하는 경우 등)
 * 인정되지 않는 것: self-only —— 자기 VPS / 직접 구축한 서버에서만 연 프록시나 서버 측이며, 대상에 닿지 않았다.
 */
const TUNNEL_ENTRY_KINDS = {
  'target-outbound': "Target-initiated outbound (reverse shell / frp client running on the target)",
  'target-http': "Target WebShell/HTTP channel (suo5 / Neo-ReGeorg)",
  'target-agent': "Forwarding through a compromised process/session on the target (SSH -R, etc.)",
  'self-only': "Own VPS/self-hosted server only (does not count as a breach)",
}
export { TUNNEL_ENTRY_KINDS }

/** 이 터널이 "타깃 경계를 넘었는지" 판정한다. 미선언(오래된 데이터/미기입)이면 null 을 반환하고, 화면에는 "확인 대기"로 표시한다. */
export function tunnelIsLegit(entryKind) {
  const k = String(entryKind || '').trim()
  if (k === '') return null
  return k !== 'self-only'
}

/**
 * 계정/권한 계열 득점 항목: **직접 가입하거나 직접 만든 계정은 권한 획득으로 치지 않는다**(드릴 득점은 "남이 이미 가진 것을 얻는" 것 기준).
 * 이 항목들이 적중하면 self_created 선언을 요구해, 자체 가입을 성과로 오인하지 않게 한다.
 */
const ACCOUNT_POINT_CODES = ['web-account-user', 'web-account-admin', 'server-shell', 'db-access', 'internal-pivot', 'core-system']
export { ACCOUNT_POINT_CODES }

/**
 * "서비스" 단위로 상한이 걸리는 항목: **같은 자산의 같은 포트는 한 번만 득점으로 센다**.
 *
 *   · 계정 계열(web-account-user / web-account-admin) —— 최고 권한 계정을 얻으면 해당 서비스는 만점:
 *     일반 계정 10 점, 관리자 20 점이며, 같은 서비스에서 계정을 더 파도 누적되지 않는다
 *     (두 종류 계정은 **같은 분류**로 본다: 일반 계정을 먼저 얻고 관리자를 나중에 얻어도 관리자 항목만 득점하며, 총점은 가장 높은 항목으로 계산한다).
 *   · 데이터베이스 계열(db-access) —— 같은 기준: 한 DB 의 권한을 얻으면 만점이고, 같은 서비스의 두 번째 DB 계정은 중복 득점되지 않는다.
 *
 * 그 밖의 항목(webshell/rce/sensitive-data/boundary/…)은 여전히 상한이 없고 적중 횟수만큼 누적된다.
 */
const SERVICE_CAPPED_POINT_CODES = ['web-account-user', 'web-account-admin', 'db-access']
export { SERVICE_CAPPED_POINT_CODES }

/**
 * target 에서 포트를 파싱한다: `http://h:8080/x`, `10.0.0.5:6379`, `10.0.0.5:22`.
 * 포트가 없거나 파싱할 수 없으면 null 을 반환한다(**80/443 을 지어내지 마라**. 서로 다른 서비스가 하나로 합쳐진다).
 */
export function parseTargetPort(target) {
  const t = String(target || '').trim()
  if (t === '') return null
  const url = /^[a-z][a-z0-9+.-]*:\/\/([^/?#\s]+)/i.exec(t)
  const authority = url !== null ? url[1] : (/^([^\s/?#]+)/.exec(t) || [])[1]
  if (!authority) return null
  const m = /:(\d{1,5})$/.exec(authority)
  if (m === null) return null
  const n = Number(m[1])
  return Number.isInteger(n) && n > 0 && n <= 65535 ? n : null
}

/** DB 열의 port 값(오래된 DB 는 null/0/빈 문자열일 수 있다). */
function normalizePort(value) {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  return Number.isInteger(n) && n > 0 && n <= 65535 ? n : null
}

/**
 * target 에서 "서비스 식별자"를 뽑는다: host[:port].
 *   · 포트는 명시된 값을 쓴다; 없으면 프로토콜로 기본 포트를 추론한다(http→80, https→443, 그 외→추론 안 함),
 *     이렇게 하면 `http://h/x` 와 `http://h:80/y` 가 같은 서비스로 묶인다;
 *   · 경로/인자/쿼리 문자열은 모두 버린다(`http://h:8080/a/b?c=1` → `h:8080`).
 * host 를 파싱할 수 없으면 null 을 반환한다.
 */
function targetAuthority(target) {
  const t = String(target || '').trim()
  if (t === '') return null
  const url = /^([a-z][a-z0-9+.-]*):\/\/([^/?#\s]+)/i.exec(t)
  const scheme = url !== null ? url[1].toLowerCase() : null
  const authority = url !== null ? url[2] : (/^([^\s/?#]+)/.exec(t) || [])[1]
  if (!authority) return null
  const host = authority.replace(/:\d{1,5}$/, '').toLowerCase()
  if (host === '') return null
  let port = parseTargetPort(t)
  /* 포트를 쓰지 않았을 때 프로토콜로 기본 포트를 채운다: 같은 서비스의 두 가지 표기가 두 서비스로 계산되어 중복 득점되는 것을 막는다 */
  if (port === null) {
    if (scheme === 'http') port = 80
    else if (scheme === 'https') port = 443
  }
  return port === null ? host : host + ':' + port
}

/**
 * "서비스" 키: 득점 상한의 단위 = 같은 자산의 같은 포트.
 *   · target 에서 host[:port] 를 파싱할 수 있으면 → 그것을 쓴다(`t10.20.30.40:3306`) ——
 *     같은 서비스를 서로 다른 사람이 기록할 수 있고, 어떤 이는 asset_id 를 붙이고 어떤 이는 target 만 쓴다,
 *     대상을 기준으로 삼아야 그것들을 한데 묶을 수 있다;
 *   · target 을 파싱할 수 없으면(누락/이름만 기입) → 자산으로 물러난다: 포트가 있으면 `a<id>:<port>` 를 쓰고,
 *     포트가 없으면 `a<id>:0` 으로 기록한다(해당 자산의 미상 포트);
 *   · 둘 다 없으면 → null(서비스 정보를 얻을 수 없어 이 항목은 상한 계산에 참여하지 않는다).
 */
export function scoreServiceKey(hit = {}) {
  const authority = targetAuthority(hit.target)
  if (authority !== null) return 't' + authority
  const assetId = hit.asset_id === null || hit.asset_id === undefined || hit.asset_id === '' ? null : Number(hit.asset_id)
  if (assetId === null) return null
  const port = normalizePort(hit.port)
  return 'a' + assetId + ':' + (port === null ? 0 : port)
}

/** "서비스"의 읽기 쉬운 라벨. 경고/보고서에 쓴다(예: `10.1.2.3:8080`). */
export function serviceLabel(hit = {}, assetIp) {
  const ip = assetIp || hit.asset_ip || ''
  const port = normalizePort(hit.port) ?? parseTargetPort(hit.target)
  if (ip !== '') return port === null ? ip : ip + ':' + port
  /* 자산 id 가 없을 때는 target 의 host[:port] 를 쓴다(경로와 인자를 제거하고, URL 전체를 서비스 이름으로 쓰지 마라);
     포트가 DB 열에서 왔고 target 에는 없을 때 채워 넣어, 어느 서비스인지 한눈에 보이게 한다. */
  const authority = targetAuthority(hit.target)
  if (authority === null) return hit.target ? String(hit.target) : "(service not specified)"
  if (port !== null && !/:\d{1,5}$/.test(authority)) return authority + ':' + port
  return authority
}

/**
 * 득점 상한과 중복 제거의 **유일한 구현**(데이터 기반, v0.11.0 부터).
 *
 * 판정 필드는 득점 항목 자체에서 온다(`score_point.rule / cap / dedup_scope`). 더 이상 코드에 하드코딩된 목록에 의존하지 않는다:
 *   · `dedup_scope = service` —— 같은 (자산, 포트)는 점수가 가장 높은 한 건만 센다;
 *   · `dedup_scope = system`  —— 같은 (자산, 포트, 시스템 이름)은 최고 권한 한 건만 센다,
 *     "같은 시스템은 최고 권한 점수를 한 번만 계산한다"에 쓴다(메일/OA/중앙 집권 시스템 등);
 *   · `dedup_scope = target`  —— 목표 전체에서 한 번만 센다(네트워크 경계 돌파, IPv6 가산);
 *   · `dedup_scope = none`    —— 중복 제거 없이, 대/장/노드 수만큼 누적한다(연산 카드 등).
 * 그다음 `rule` 로 묶어 누적하고, 해당 규칙의 `cap` 을 넘는 부분은 `capped` 로 표시한다(cap = 0 은 상한 없음을 뜻한다).
 *
 * `self_created = 1`(직접 가입/직접 만든 계정)은 애초에 득점되지 않으며, 경쟁에도 참여하지 않고 자리도 차지하지 않는다.
 *
 * @param {Array} rows - 적중 행(code / points / asset_id / port / target / recorded_at 이 필요하다;
 *                       선택 사항인 system_key 는 system 기준에 쓴다)
 * @param {Map|Object|null} pointsByCode - code → `{rule, cap, dedup_scope, points}`;
 *                       생략하면 "각 code 가 스스로 한 그룹이 되어 중복 제거만 하고 상한은 걸지 않는" 동작으로 물러난다(구 호출 호환)
 * @returns {{capped:number, items:Array, caps:Map}} 표시가 끝난 행 + 상한 적용 건수 + 규칙별 상한 사용량
 */
export function applyScoreCaps(rows = [], pointsByCode = null, nameByAsset = null) {
  const metaOf = (r) => {
    const m = pointsByCode === null || pointsByCode === undefined
      ? undefined
      : (typeof pointsByCode.get === 'function' ? pointsByCode.get(r.code) : pointsByCode[r.code])
    const rule = m && m.rule !== null && m.rule !== undefined ? Number(m.rule) : null
    const legacyScope = legacyCapGroup(r.code)
    return {
      group: rule === null ? 'code:' + String(r.code || '') : 'rule:' + rule,
      cap: m && Number(m.cap) > 0 ? Number(m.cap) : 0,
      scope: (m && m.dedup_scope) || legacyScope || 'none',
      rule,
    }
  }
  const flagged = (rows || []).map((r) => {
    const m = metaOf(r)
    return {
      ...r, capped: false, capped_by_id: null, capped_reason_kind: null,
      service_key: null, cap_group: m.group, dedup_scope: m.scope, rule: m.rule, rule_cap: m.cap,
    }
  })

  /* ① 득점 기준 중복 제거: 같은 기준 키 안에서는 점수가 가장 높은 한 건만 남긴다(같은 점수면 먼저 기록된 것) */
  const buckets = new Map()
  for (const r of flagged) {
    if (Number(r.self_created) === 1) continue
    const scope = r.dedup_scope
    if (scope === 'none' || scope === null || scope === undefined) continue
    let key
    if (scope === 'target') key = 'target'
    else if (scope === 'system') key = 'sys:' + String(systemKeyOf(r, nameByAsset) || '')
    else {
      /* `service` 기준에는 진짜 서비스 키가 있어야 한다(`t<host[:port]>` / `a<id>:<port>`).
         서비스 정보를 얻지 못하면 **중복 제거에 참여하지 않는다**. "건마다 스스로 키가 되는" 쪽으로 물러나지 않는다 —— 후자는
         `svc:#hit7` 같은 키가 같은 기준의 적중을 모두 서로 밀어내 버린다: 실측으로 target 이 없는 62 건의
         terminal-access 적중 가운데 61 건이 dedup 으로 판정되어 득점되지 않고 1 건만 남았으니, 성과를 조용히 삼킨 셈이다.
         상한을 덜 거는 편이 잘못 거는 것보다 낫다: 서비스를 알아보지 못하면 각각 따로 센다. */
      const svc = scoreServiceKey(r)
      if (svc === null || svc === undefined || String(svc) === '') continue
      key = 'svc:' + String(svc)
    }
    if (key === '' || key === 'svc:null' || key === 'sys:null') continue
    const k = r.cap_group + '|' + key
    if (!buckets.has(k)) buckets.set(k, [])
    buckets.get(k).push(r)
  }
  let capped = 0
  for (const list of buckets.values()) {
    if (list.length < 2) continue
    const best = pickBestHit(list)
    for (const r of list) {
      if (r === best) continue
      r.capped = true
      r.capped_by_id = best.id
      r.capped_by_points = Number(best.points) || 0
      r.capped_by_evidence = best.evidence || null
      r.capped_reason_kind = 'dedup'
      capped += 1
    }
  }

  /* ② 규칙 상한: 같은 rule 의 득점 적중 누계는 cap 을 넘을 수 없다(점수가 높은 것부터 누적하고, 넘는 부분은 capped 로 표시) */
  const caps = new Map()
  const byRule = new Map()
  for (const r of flagged) {
    if (r.capped === true || Number(r.self_created) === 1) continue
    if (r.rule_cap <= 0) continue
    if (!byRule.has(r.cap_group)) byRule.set(r.cap_group, [])
    byRule.get(r.cap_group).push(r)
  }
  for (const [group, list] of byRule.entries()) {
    const cap = list[0].rule_cap
    const ordered = [...list].sort((a, b) => {
      const pa = Number(a.points) || 0; const pb = Number(b.points) || 0
      if (pb !== pa) return pb - pa
      return Number(a.id) - Number(b.id)
    })
    let used = 0; let nCapped = 0
    for (const r of ordered) {
      const pts = Number(r.points) || 0
      if (used + pts > cap) {
        r.capped = true
        r.capped_reason_kind = 'cap'
        r.capped_by_points = null
        nCapped += 1
        capped += 1
      } else {
        used += pts
      }
    }
    caps.set(group, { rule: list[0].rule, cap, used, capped: nCapped })
  }
  return { capped, items: flagged, caps }
}

/**
 * `system` 기준 중복 제거에 참여하는 "시스템 키".
 *
 * 규칙 원문은 "같은 시스템은 최고 권한 점수를 한 번만 계산한다"이다(메일, OA, 중앙 집권 시스템 등).
 * 판정 순서:
 *   ① 적중에 딸린 `system_key`(호출 측이 명시적으로 지정, 가장 정확);
 *   ② 자산의 `primary_name`(시스템 이름/도메인의 우선 이름); 자산 이름은 대개 같은 시스템 묶음이라 "같은 시스템"에 가장 가깝다;
 *   ③ 서비스 키로 물러난다(자산:포트).
 * 세 가지 모두 얻지 못하면 null 을 반환한다 —— 이때는 **해당 기준의 중복 제거에 참여하지 않는다**. 상한을 덜 거는 편이 잘못 거는 것보다 낫다.
 */
function systemKeyOf(hit = {}, nameByAsset = null) {
  const svc = scoreServiceKey(hit)
  const svcText = svc === null || svc === undefined ? '' : String(svc)

  /* ① 호출 측이 명시적으로 준 system_key : **서비스 키 접두사(t<host[:port]> / a<id>:<port>)가 붙어 있을 때만 인정한다**.
     호출 측(listScorePoints / scoreReport / scoreChain)은 `자산 이름|포트` 같은 키를 미리 만들어 두는데,
     자산에 아직 이름이 없으면 `"|8080"` 으로 퇴화한다 —— 그대로 인정하면 10.7.7.7:8080 과 10.7.7.8:8080 이
     "같은 시스템"으로 합쳐져 다른 호스트의 성과가 헛되이 상한에 걸린다.
     인정할 수 없을 때는 **계속 아래로 내려가** 서비스 키로 폴백하며, system 기준 전체를 버리지 않는다. */
  const explicit = String(hit.system_key || '').trim()
  if (explicit !== '' && (svcText === '' || explicit.includes(svcText))) {
    /* 검증할 서비스 키가 없을 때는 "이름 필드가 비어 있지 않을 것"을 요구한다(포트만 인정하는 야생 키가 모든 서비스를 하나로 합치는 것을 막는다) */
    const head = explicit.split('|')[0]
    if (svcText !== '' || String(head).trim() !== '') return explicit
  }

  /* ② 자산 이름(시스템 이름/도메인 우선 이름) + 서비스 키 —— **이것이 system 기준의 주력 경로**다.
     규칙 원문은 "같은 시스템은 최고 권한 점수를 한 번만 계산한다"이고, 적용 범위는 "같은 시스템 + 같은 포트"다:
     같은 시스템 묶음이 여러 호스트, 여러 포트에서 돌면 서로 다른 인스턴스이며 각각 최고 권한을 한 번씩 센다.
     ⚠️ 정말로 "호스트를 넘고 포트를 넘어 한 번만" 계산해야 할 때는 system_key 를 명시적으로 주고 같은 값을 쓰고
     (위 ① 참조) —— 다만 그때는 이 적중들이 정말 같은 시스템 인스턴스인지 스스로 확인해야 한다. */
  const id = hit.asset_id === null || hit.asset_id === undefined || hit.asset_id === '' ? null : Number(hit.asset_id)
  const nameOf = (assetId) => {
    if (assetId === null || nameByAsset === null || nameByAsset === undefined) return null
    const raw = typeof nameByAsset.get === 'function' ? nameByAsset.get(assetId) : nameByAsset[assetId]
    const text = raw === null || raw === undefined ? '' : String(raw).trim()
    return text === '' ? null : text
  }
  const name = nameOf(id)
  if (name !== null) return name + '|' + svcText

  /* ③ 서비스 키로 물러난다: 같은 (자산, 포트)는 최고 권한을 한 번만 센다 —— service 기준과 동등하며,
     이것이 "같은 호스트의 시스템 권한, 애플리케이션 권한, 데이터베이스 권한은 최고 권한으로 한 번만 득점한다"(G1)의 폴백이다. */
  if (svcText !== '') return svcText

  /* ④ 세 가지 모두 얻지 못할 때(asset_id 없음, 시스템 이름 없음, target 에서 host 도 파싱 불가):
     **이 적중 자신의 id** 로 물러난다 —— 즉 "서로 다름"이며, 각각 따로 센다.
     상한을 덜 거는 편이 잘못 거는 것보다 낫다: 구분할 수 없는 두 적중을 "같은 시스템"으로 판정하면 사용자의 성과를 헛되이 삼킨다.
     ⚠️ 여기서는 Math.random() 을 **써서는 안 된다**: 같은 hit 이 두 번의 호출(패널 / 보고서 / 공격 체인)에서
     서로 다른 키를 받게 되면 득점 기준이 불안정해진다. */
  return '#hit' + String(hit.id ?? '0')
}

/** 같은 기준의 적중 묶음에서 "득점하는 한 건"을 고른다: 점수가 가장 높은 것, 같은 점수면 먼저 기록된 것(id 가 작은 것). */
function pickBestHit(list) {
  return list.reduce((a, b) => {
    const pa = Number(a.points) || 0; const pb = Number(b.points) || 0
    if (pb !== pa) return pb > pa ? b : a
    return Number(b.id) < Number(a.id) ? b : a
  }, list[0])
}

/** 구 기준 그룹(호환 v0.10 및 그 이전: 계정 계열과 데이터베이스 계열은 "같은 자산 같은 포트"로 상한). */
function legacyCapGroup(code) {
  const c = String(code || '').trim()
  if (c === 'web-account-user' || c === 'web-account-admin') return 'service'
  return SERVICE_CAPPED_POINT_CODES.includes(c) ? 'service' : null
}


/**
 * 득점 항목 메타데이터를 읽는다(code → `{ rule, cap, dedup_scope, points, enabled, builtin, src }`).
 * 패널 / 보고서 / 공격 체인 세 곳이 공유해, "같은 규칙을 세 곳에서 따로 읽고 필드를 하나씩 빠뜨리는" 일을 막는다.
 * @param db - 타깃 DB 핸들.
 */
function loadScoreMeta(db) {
  return new Map(db.prepare('SELECT code, rule, cap, dedup_scope, points, enabled, builtin, src FROM score_point')
    .all()
    .map((r) => [String(r.code), {
      rule: r.rule === null || r.rule === undefined ? null : Number(r.rule),
      cap: Number(r.cap) || 0,
      dedup_scope: r.dedup_scope || 'service',
      points: Number(r.points) || 0,
      enabled: r.enabled === null || r.enabled === undefined ? 1 : Number(r.enabled),
      builtin: Number(r.builtin) === 1,
      src: r.src === null || r.src === undefined ? null : Number(r.src),
    }]))
}

/**
 * 자산 id → 시스템 이름(primary_name). `system` 기준에서 이것으로 "같은 시스템 묶음"을 한데 모은다.
 * @param db - 타깃 DB 핸들.
 */
function loadAssetNames(db) {
  return new Map(db.prepare('SELECT id, primary_name FROM asset').all()
    .filter((a) => a.primary_name).map((a) => [Number(a.id), a.primary_name]))
}

/**
 * 이 적중의 **실제 점수** = 등급 점수 × 배율.
 *   · 등급 점수: 적중에 딸린 값이 우선이며(병합판은 한 항목에 여러 등급이 있다), 없으면 득점 항목의 기본 점수로 물러난다;
 *   · 배율: G5 데이터 규모 배증(1억 건 초과 / 10TB, 또는 지식 베이스 관련 시스템 장악) ×2,
 *     G6 IPv6 성과 ×3. 배율은 **권한 점수**에 작용하므로 점수에 곱해지고, 상한과 함께 cap 제약을 받는다
 *     (문서 요구: "상한은 해당 시스템 유형의 원래 상한으로 계산하며, 배수 때문에 상한을 넘지 않는다").
 */
function hitPointsOf(hit = {}, metaByCode = null) {
  let base = 0
  if (hit.points !== null && hit.points !== undefined && hit.points !== '') {
    base = Number(hit.points) || 0
  } else {
    const code = hit.code === null || hit.code === undefined ? null : String(hit.code)
    if (code !== null && metaByCode !== null && metaByCode !== undefined) {
      const meta = typeof metaByCode.get === 'function' ? metaByCode.get(code) : metaByCode[code]
      if (meta !== undefined && meta !== null) base = Number(meta.points) || 0
    }
  }
  const mult = Number(hit.multiplier)
  return Math.round(base * (Number.isFinite(mult) && mult > 0 ? mult : 1))
}

/**
 * 이 target 의 호스트 부분이 IPv6 리터럴인가(http://[2001:db8::1]:8080/x, 2001:db8::1, [::1]:22).
 *
 * 대충 만든 문자 클래스 정규식으로 대신할 수 없다: IPv6 안에는 16진수 문자가 섞여 있고(a-f),
 * /^\[[0-9a-f:]+\]/ 처럼 "콜론과 16진수만 보는" 표기는 문자가 들어간 주소를 놓친다
 * (실측에서 2001:db8::1 의 db8 이 누락되어 G6 의 ×3 이 전혀 적용되지 않았다).
 * 그래서 호스트 부분은 isIpv6() 에 맡겨 판정한다 —— cidrOf / scopeOfIp 와 같은 구현을 쓴다.
 */
function targetHasIpv6Host(target) {
  const text = String(target || "").trim()
  if (text === "") return false
  const bracket = /^[a-z][a-z0-9+.-]*:\/\/(\[[^\]]+\])/i.exec(text)
  if (bracket !== null) return isIpv6(bracket[1].replace(/^\[|\]$/g, ""))
  const url = /^[a-z][a-z0-9+.-]*:\/\/([^/?#\s]+)/i.exec(text)
  const authority = url !== null ? url[1] : (/^([^\s/?#]+)/.exec(text) || [])[1]
  if (!authority) return false
  /* 맨몸 IPv6 에 포트를 붙이려면 대괄호가 필요하므로, 여기서는 대괄호를 벗긴 뒤 포트 분리를 시도한다 */
  const host = authority.replace(/^\[|\]$/g, "").replace(/:\d{1,5}$/, "")
  return isIpv6(host)
}

/**
 * G5 / G6 의 배율 규칙을 배율 값으로 계산한다(권한 점수에만 적용되고 원래 상한을 넘지 않는다 —— cap 이 막아 준다).
 *   · `ip_version === 6` 이거나 target 이 IPv6 리터럴 → ×3(G6);
 *   · `data_scale === "large"` → ×2(G5 : 1억 건 초과 또는 10TB);
 *   · `data_scale === "knowledge-base"` → ×2(G5 : 지식 베이스 관련 시스템 장악);
 *   · 둘 다 적중 → 서로 곱한다. 문서에 중첩 금지가 없으므로 드릴 측에 유리한 해석을 택하고 **이유를 있는 그대로 표시**한다.
 * @param hit - 적중 인자(ip_version / data_scale / target).
 * @returns `{ multiplier, reasons }`
 */
function scoreMultiplierOf(hit = {}) {
  const reasons = []
  let multiplier = 1
  const target = String(hit.target || "")
  const ipv6 = Number(hit.ip_version) === 6 || targetHasIpv6Host(target)
    /* 맨몸 IPv6 폴백 정규식에는 콜론이 2개 이상 있어야 한다: dc01:389 / ad01:8080 같은 내부 네트워크 호스트명:포트는
       콜론이 하나뿐이라, 옛 정규식은 이를 IPv6 로 오판해 성과를 조용히 ×3 시켰다 */
    || /(^|\/\/)(?:\[[0-9a-f:]+\]|[0-9a-f]*(?::[0-9a-f]*){2,})/i.test(target)
  if (ipv6) { multiplier *= 3; reasons.push("G6 IPv6 result ×3") }
  const scale = String(hit.data_scale || "").trim().toLowerCase()
  if (scale === "large") { multiplier *= 2; reasons.push("G5 data volume over 100 million rows / 10 TB ×2") }
  else if (scale === "knowledge-base" || scale === "kb") { multiplier *= 2; reasons.push("G5 controls a knowledge-base-related system ×2") }
  return { multiplier, reasons }
}

/**
 * **통일된 득점 평가**: 패널 / 보고서 / 공격 체인 모두 이 함수 하나를 호출해 "어느 것이 득점이고 어느 것이 상한에 걸렸는지" 계산한다.
 *
 * 입력은 "적중 행" 묶음이고, 출력은 그들의 득점 표시다. 호출 측은 각 행에
 * `{ id, code, points, asset_id, port, target, self_created }` 와 **이 적중의 실제 점수**만 있으면 된다
 * (`points` 필드; 득점 항목의 기본값을 넘기지 마라 —— 병합판은 한 항목에 여러 등급이 있어, 기본값을 넘기면 어느 것이 득점인지 반대로 판정한다).
 *
 * @param db - 타깃 DB 핸들.
 * @param rows - 적중 행 배열.
 * @param options - `{ meta?, names?, enabledOnly? }`: 이미 읽어 둔 메타데이터를 재사용할 수 있다; `enabledOnly` 가 true 이면
 *                  "비활성화된 득점 항목"의 적중은 곧바로 미득점으로 표시한다(보고서와 패널 기준은 반드시 일치해야 한다).
 * @returns `{ byId, items, caps, meta, names, disabledIds }`
 */
function evaluateScoreBoard(db, rows = [], options = {}) {
  const meta = options.meta || loadScoreMeta(db)
  const names = options.names || loadAssetNames(db)
  const prepared = (rows || []).map((h) => {
    const code = h.code === null || h.code === undefined ? null : String(h.code)
    const m = code === null ? undefined : meta.get(code)
    const nm = h.asset_id === null || h.asset_id === undefined ? null : names.get(Number(h.asset_id))
    return Object.assign({}, h, {
      code,
      /* points 는 "이 적중의 실제 점수"여야 한다(위 설명 참조) */
      points: hitPointsOf(h, meta),
      rule: m === undefined || m.rule === undefined ? null : m.rule,
      cap: m === undefined ? 0 : m.cap,
      dedup_scope: m === undefined ? 'service' : m.dedup_scope,
      cap_group: m === undefined || m.rule === null || m.rule === undefined ? 'code:' + String(code) : 'rule:' + m.rule,
      rule_cap: m === undefined ? 0 : m.cap,
      system_key: [nm || '', normalizePort(h.port) ?? parseTargetPort(h.target) ?? ''].join('|'),
    })
  })
  const evaluated = applyScoreCaps(prepared, meta, names)
  const byId = new Map(evaluated.items.map((x) => [x.id, x]))
  const disabledIds = new Set()
  if (options.enabledOnly === true) {
    for (const h of prepared) {
      const m = h.code === null ? undefined : meta.get(h.code)
      if (m !== undefined && Number(m.enabled) !== 1) disabledIds.add(h.id)
    }
  }
  return { byId, items: evaluated.items, caps: evaluated.caps, meta, names, disabledIds }
}

/**
 * 이 적중이 왜 득점되지 않는지(경고 / 화면 / 보고서가 한 문장을 공유해, 세 곳의 기준이 어긋나는 것을 막는다).
 * @param hit - 적중 행(code / target / port / rule / rule_cap / capped_reason_kind 가 붙는다)
 * @param bestPoints - 중복 제거 때 어느 것에 눌렸는지(그 항목의 점수)
 */
export function scoreCapReasonText(hit = {}, bestPoints) {
  const label = serviceLabel(hit)
  if (hit.capped_reason_kind === 'cap') {
    return '"' + label + "\" is not scored: "
      + (hit.rule === null || hit.rule === undefined ? '' : "rule " + hit.rule + ' ')
      + "**has cumulatively reached its cap (" + (Number(hit.rule_cap) || 0) + " pts)** — anything above that cap for the same rule is not accumulated. "
      + "Spend your effort on other rules or other assets instead of farming results in a rule that has already reached its cap."
  }
  return '"' + label + "\" target access is already maxed out (scoring rule: only the highest-scoring hit per target counts"
    + (bestPoints === undefined || bestPoints === null ? '' : ', +' + bestPoints + " pts")
    + ") — this hit does not score under the rule and is kept only as a process trace; **move on to another target or another rule — do not farm similar results on the same target**."
}

/** 옛 이름 호환(v0.10 및 그 이전에는 serviceCapReason 이라 불렀다). */
export const serviceCapReason = scoreCapReasonText


/**
 * 데이터 규모의 **대략적 판정 임계값**: 100만 건/행.
 * 용도는 "대량 민감 정보 득점 항목"에서 G5 배증을 위한 규모 자체 점검으로 바뀌었다 —— addScoreHit 안의 경고 참조.
 * 문서에서 G5 의 정식 임계값은 "1억 건 초과 또는 10TB"다; 여기서는 더 낮은 등급으로 "규모를 적었는지" 대략 걸러 낸다,
 * 그보다 낮으면 확인을 안내하지만 득점 기록을 막지는 않는다.
 */
export const SENSITIVE_DATA_MIN_ROWS = 1000000

/**
 * 증거 텍스트에서 데이터 규모(행/건/레코드 수)를 파싱한다.
 * "120만 건", "1300만 행", "1,200,000 건 레코드", "2.5만 행", "1200000 records" 를 지원한다.
 * **단위어(건/행/레코드/records/rows)나 중국어 규모 단위(억/만…)가 붙은 표기만 인정한다** ——
 * 맨 숫자는 인정하지 않는다. 그렇지 않으면 패스워드 안의 `123456` 이나 포트 번호를 데이터 규모로 오인한다.
 * 파싱할 수 없으면 null 을 반환한다(호출 측이 규모 보충을 안내하며, 추측하거나 수를 지어내지 않는다).
 */
export function parseRowCount(evidence) {
  const text = String(evidence || '')
  if (text.trim() === '') return null
  const units = { '\u4ebf': 1e8, '억': 1e8, '\u5343\u4e07': 1e7, '천만': 1e7, '\u767e\u4e07': 1e6, '백만': 1e6, '\u5341\u4e07': 1e5, '십만': 1e5, '\u4e07': 1e4, '만': 1e4, '\u5343': 1e3, '천': 1e3 }
  const nums = []
  /* "숫자 + 단위 + 건/행/레코드": 단위는 중국어 단위어이거나 영어 records/rows/entries */
  const cn = /(\d[\d,]*(?:\.\d+)?)\s*(\u4ebf|\u5343\u4e07|\u767e\u4e07|\u5341\u4e07|\u4e07|\u5343|억|천만|백만|십만|만|천)?\s*(\u6761|\u884c|\u8bb0\u5f55|\u6570\u636e|records?|rows?|entries|건|행|레코드|데이터)/gi
  for (const m of text.matchAll(cn)) {
    const base = Number(String(m[1]).replace(/,/g, ''))
    if (!Number.isFinite(base)) continue
    const mult = m[2] === undefined ? 1 : units[m[2]]
    nums.push(Math.round(base * mult))
  }
  if (nums.length > 0) return Math.max(...nums)
  /* "내보내기 120만" 처럼 (건/행을 쓰지 않은) 표기도 인정하지만, 반드시 중국어 규모 단위가 붙어야 한다 */
  for (const m of text.matchAll(/(\d[\d,]*(?:\.\d+)?)\s*(\u4ebf|\u5343\u4e07|\u767e\u4e07|\u5341\u4e07|\u4e07|\u5343|억|천만|백만|십만|만|천)/g)) {
    const base = Number(String(m[1]).replace(/,/g, ''))
    if (Number.isFinite(base)) nums.push(Math.round(base * units[m[2]]))
  }
  return nums.length === 0 ? null : Math.max(...nums)
}

/** 천 단위 구분 표시. 경고에서 숫자를 읽기 더 직관적이다. */
export function formatRows(n) {
  return Number(n).toLocaleString('en-US')
}


/* ------------------------------------------------------------------ 기본 득점 항목 */

/**
 * 득점 항목 → 인도 기준(어떻게 얻은 것으로 볼지, 무엇으로 자증할지, 어떻게 재현할지).
 *
 * 왜 표를 따로 하나 두고 `score_point.description` 에 밀어 넣지 않는가:
 * 설명은 "규칙 문서의 조항"(에이전트가 등급을 판정할 때 쓴다)이고, 이 표는 "검수자에게 보여 줄 재현 기준"이다,
 * 두 가지는 독자도 다르고 상세함도 다르다. 보고서와 화면은 code 로 여기 설명을 가져오며,
 * 규칙 문서가 갱신될 때 이 표를 건드릴 필요가 없고, 그 반대도 마찬가지다.
 *
 * 필드:
 *   · need   —— 판정 기준: 무엇을 충족해야 이 항목을 얻은 것으로 보는지(검수자 대조용)
 *   · proof  —— 자증 자료: 어떤 증거를 붙여야 하는지(G7 의 증명 자료 요구)
 *   · replay —— 재현 진입점: 어느 요청 / 어느 명령으로 재생할지("재현 가능"에 대한 가장 직접적인 답)
 *   · script —— 현장에서 곧바로 따라 할 수 있는 동작(가능한 한 복사해 실행할 수 있게)
 */
export const SCORE_CONFIRM = {
  'domain-control': {
    need: "The target domain's DNS records are changed to something we control (NS/A records live), or the domain admin console can be operated",
    proof: "Admin console screenshot + dig/nslookup comparison before and after the record change",
    replay: "nslookup <host> <our-ns>; or the raw request of the console action",
    script: "dig NS <host> @8.8.8.8\ndig <host> @<our-ns>",
  },
  'terminal-access': {
    need: "Can push a command to the endpoint and get the execution result back (not just 'a device was found')",
    proof: "Echo of id/hostname run on the compromised endpoint + proof of its relation to the target organization (G7)",
    replay: "Run id in the remote-control session; or the agent check-in record of the trojan/RAT",
    script: 'id; whoami; hostname',
  },
  'server-host': {
    need: "A command was executed on the host and its output returned (WebShell / reverse shell / RAT all count)",
    proof: "Command output (id / hostname) + WebShell connection details or the session record",
    replay: "Raw WebShell request (directly replayable); or the listener record of the reverse shell",
    script: 'id; uname -a; cat /etc/passwd | head',
  },
  'db-credential': {
    need: "Connected to the database with an account and ran a query (unauthorized access counts too: being able to connect is enough)",
    proof: "Query output after a successful login (select user(), version()) + the account's privilege level",
    replay: 'mysql -h <host> -P <port> -u <user> -p\'<pass>\' -e "select user(),version()"',
    script: 'mysql -h <host> -u <user> -p -e "select user(),version(),current_user()"',
  },
  'web-app': {
    need: "Logged into the system with an account that already existed on the target (ordinary or admin) and reached a protected page",
    proof: "Page content/output after login + the session Cookie or Token (proof that it is not just the password)",
    replay: "Raw login request (with the Cookie/Token that proves it) + one request to a protected page carrying that session",
    script: "curl -i -s -X POST <url> -d \"username=<u>&password=<p>\" -c cookie.txt\ncurl -s -b cookie.txt <protected-page>",
  },
  'central-system': {
    need: "Logged into a centralized system (jump server / domain controller / SSO / endpoint management console) and obtained admin privileges",
    proof: "Admin console page screenshot + an action showing control over subordinate nodes (log in to 20% of managed nodes, or 20 nodes)",
    replay: "Raw login request + the request and response of one management action (e.g. listing managed hosts)",
    script: "curl -s -b cookie.txt \"<console-api>\"",
  },
  'bigdata-system': {
    need: "Obtained admin or ordinary privileges on a big-data platform (Hadoop/Spark/ES, etc.)",
    proof: "Platform admin page/API output + the volume of data accessible (row count or capacity)",
    replay: "Raw platform API request (e.g. ES _cat/indices, YARN /ws/v1/cluster/apps)",
    script: "curl -s \"<platform-api>\" | head -50",
  },
  netdev: {
    need: "Logged into a network device (firewall/router/switch/VPN/gap device) and obtained privileges",
    proof: "Device admin page screenshot + routing table or connection-count screenshot (explicitly required by G7)",
    replay: "Raw device login request + the command output that reads the routing table",
    script: "show ip route    # or display ip routing-table",
  },
  'netdev-redirect': {
    need: "The device was actually used to change traffic flow (policy/routing/DNS change took effect)",
    proof: "Routing table or policy comparison before and after the change + evidence that our node received the traffic",
    replay: "Raw policy-configuration request + packet capture/access logs on our controlled node",
    script: "tcpdump -ni any port <port> -c 10",
  },
  'netdev-implant': {
    need: "A runnable remote-control/persistence implant was placed on the device, **and** it was used to carry out follow-up attacks",
    proof: "Evidence of the RAT process or persistence item + records of the follow-up results obtained through that device",
    replay: "Raw request/command of the implant action + access logs of the follow-up traffic through that device",
    script: '',
  },
  iiot: {
    need: "Obtained admin privileges on an industrial internet system, or batch-controlled its interconnected devices",
    proof: "Admin console screenshot + list and count of controlled devices",
    replay: "Raw login request + response of the device-list API",
    script: '',
  },
  'cloud-platform': {
    need: "Cloud management platform admin privileges; or batch control of cloud nodes via AK/SK (node points only count for ≥100 nodes)",
    proof: "Platform admin page screenshot; for AK/SK, list and count of controlled nodes, or proof of admin rights (creating nodes/changing permissions)",
    replay: "Raw platform API request (list instances, create users, etc.)",
    script: "curl -s -H \"Authorization: Bearer <token>\" \"<instance-list-api>\"",
  },
  'iot-platform': {
    need: "Obtained privileges on an IoT management platform, or batch-controlled devices through its connection points",
    proof: "Platform admin page screenshot + connection point/device count",
    replay: "Raw platform login and device-list API requests",
    script: '',
  },
  'iot-corenet': {
    need: "Moved laterally from an IoT endpoint device into the core network and took control of important systems such as business production",
    proof: "Path description (which endpoint → core network → which system) + control evidence for that system",
    replay: "Lateral-movement command issued from the endpoint + login/operation requests against the core-network system",
    script: '',
  },
  secdev: {
    need: "Obtained admin privileges on a non-centralized security device (IPS/IDS/audit appliance/WAF)",
    proof: "Device admin page screenshot + an action showing policy control",
    replay: "Raw login request + response of one policy-read API",
    script: '',
  },
  'file-storage': {
    need: "Obtained backend privileges on a file storage system (FTP/NAS/cloud drive/object storage), or an ordinary account on it",
    proof: "Directory-listing screenshot + list of readable files (data results score separately, see G2)",
    replay: "Raw directory-listing request (FTP LIST / S3 ListObjects / WebDAV PROPFIND)",
    script: "curl -s \"<storage-api>\" | head -50",
  },
  'ai-agent': {
    need: "Controlled a model agent, skill, or other agent tool, and **actually drove it to perform actions**",
    proof: "Conversation or invocation record + the actions it was driven to perform and their results (graded by control depth for the range score)",
    replay: "Raw request that drives the agent + the output of the action it performed",
    script: '',
  },
  'model-compute': {
    need: "Obtained system admin privileges on a compute management platform, training-data system, or knowledge-base system",
    proof: "Admin console screenshot + an action showing compute scheduling or data read/write",
    replay: "Raw platform login and scheduling/data API requests",
    script: '',
  },
  'model-data': {
    need: "Obtained admin privileges on a model-related data system (able to affect training/inference/operations, or steal or tamper with weights)",
    proof: "Admin console screenshot + list of models/datasets that can be read/written",
    replay: "Raw platform API requests (list models, download weights)",
    script: '',
  },
  'computepower-admin': {
    need: "Obtained admin privileges on compute infrastructure",
    proof: "Admin console screenshot + proof of resources that can be scheduled",
    replay: "Raw platform login and resource-list API requests",
    script: '',
  },
  'computepower-cards': {
    need: "Actually obtained compute card resources (10 pts/card) or control of a card-pooling platform",
    proof: "Card resource list (with counts) + evidence of submitting jobs or exclusive card use",
    replay: "nvidia-smi output / platform card-list API",
    script: 'nvidia-smi -L',
  },
  'boundary-logical': {
    need: "Established a channel from the target side into the intranet and can **actually reach intranet targets through it**",
    proof: "Tunnel registration (the entry must be on the target side) + output/screenshot of reaching an intranet target through the tunnel (G7)",
    replay: "The command that reached the intranet target through the tunnel and its output; the tunnel setup command",
    script: "curl --socks5-hostname 127.0.0.1:<port> http://<host>/ -i",
  },
  'boundary-strong': {
    need: "Broke through gap-type strong isolation into the strongly isolated business intranet and actually reached an intranet target",
    proof: "Control screenshot of the gap-type isolation device + screenshot proving intranet access (G7)",
    replay: "Command and output of reaching the intranet target through the strong-isolation channel",
    script: '',
  },
  'boundary-physical': {
    need: "Broke through physical isolation / entered the core production network and actually reached the target",
    proof: "Control screenshots of the firewall/VPN/multi-NIC host/gap device + screenshot proving intranet access (G7)",
    replay: "Command and output of reaching the target after entering the core network",
    script: '',
  },
  'boundary-supply': {
    need: "Entered a primary defending unit's intranet through a supply-chain O&M channel or a cloud service (scored by scenario)",
    proof: "Control evidence on the supply-chain/cloud side + proof of entering the primary defending unit's intranet; state which scenario applies",
    replay: "Command and output of entering the intranet through the supply-chain channel",
    script: '',
  },
}

/** 특정 득점 항목의 인도 기준을 가져온다; 전용 항목이 없으면 null 을 반환한다(보고서는 evidence 만 표시하는 쪽으로 물러난다). */
export function scoreConfirmOf(code) {
  const key = String(code || '').trim()
  return SCORE_CONFIRM[key] === undefined ? null : SCORE_CONFIRM[key]
}

export const DEDUP_SCOPES = ['service', 'system', 'target', 'none']

/**
 * 득점 항목 하나의 완전한 정의(팩터리 함수. 22 개 객체의 필드 중복을 피한다).
 *
 * 두 번호는 각자 역할이 있으므로 **혼용하지 마라**:
 *   · `src`  —— "돌파 침투류 점수 규칙(병합판)"의 "원래 번호"(병합 행은 첫 번째 원래 번호를 쓴다),
 *               원본 표와 항목별로 대조할 때만 쓰며, 문서와 코드 주석에 나타난다;
 *   · `rule` —— 이 구현 내부의 **상한 그룹 키**(`applyScoreCaps` 가 이것으로 cap 을 누적한다).
 *               이것은 **유일**해야 한다: 과거에는 원래 번호를 그대로 그룹 키로 써서 16/17 병합 행과
 *               19 의 두 하위 항목이 같은 키를 공유했다 —— 한 적중이 다른 적중의 상한을 먹어 버리고,
 *               게다가 `rule` 번호에 중복(19 두 개)과 빈 번호(6/17/20/21)가 생겨,
 *               모델이 "규칙 19 가 상한에 도달했다"를 읽어도 어느 항목인지 구분하지 못했다.
 *               지금은 1..N 의 연속 유일 번호로 통일했고, 배열 순서와 일대일로 대응한다.
 */
const sp = (src, rule, tier, code, name, category, points, cap, dedup_scope, description) => ({
  src, rule, tier, code, name, category, points, cap, dedup_scope, description,
})

/* ── 일반 규칙(G1–G8, 모든 항목에 교차 적용; 따로 득점하지 않고 설명과 프롬프트에 적는다)────────────
   G1 권한은 높은 것만 한 번 계산 | G2 데이터 성과는 별도 득점 | G3 상한은 단일 방어 단위 기준 |
   G4 장비는 대(개) 단위로 득점 | G5 데이터 규모 배증 | G6 IPv6 ×3(원래 상한을 넘지 않음)|
   G7 증명 자료 요구 | G8 폴백: 그 밖의 시스템은 전담 그룹이 검토해 점수를 준다.
   전체 원문은 docs/돌파-침투류-점수-규칙-병합판.md 참조. */
export const SCORE_GENERAL_RULES = [
  { code: 'G1', name: "Highest privilege only, counted once", detail: "When multiple privileges are obtained on the same system, host, or database, only the highest privilege scores once (if you get both admin and ordinary access, only the admin points are awarded)." },
  { code: 'G2', name: "Data results score separately", detail: "Mail data, business data, data assets, and similar results score separately by data importance and are not mixed with privilege points." },
  { code: 'G3', name: "Cap basis", detail: "Each item's cap applies to a single defending unit and all its subordinate organizations; once the cap is reached, nothing more accumulates." },
  { code: 'G4', name: "Devices/endpoints score per unit", detail: "Printers and wifi routers score 5 pts per unit; PCs, tablets, phones, cameras, and electronic displays score 10 pts per unit; cloud hosts, containers, hosted interconnected devices, and IoT connection points score 10 pts per unit. Batch control is converted per \"controlled node\"." },
  { code: 'G5', name: "Data-volume doubling", detail: "Systems containing large data volumes (important data over 100 million rows or 10 TB) score double; control of a knowledge-base-related system scores double. Ordinary log data generated by the system does not count." },
  { code: 'G6', name: "IPv6 multiplier", detail: "Results obtained over IPv6 score ×3, but the cap is still the original cap for that system type; the multiplier does not raise the cap." },
  { code: 'G7', name: "Proof material", detail: "A boundary breach requires control screenshots of the isolation device and a screenshot proving intranet access; controlled phones, tablets, and other endpoints must prove their relation to the target organization; network-device privileges require routing-table evidence or connection-count screenshots." },
  { code: 'G8', name: "Catch-all clause", detail: "Privileges on other systems, servers, devices, etc. have no preset points; the special review group determines the score." },
]

/**
 * 기본 득점 항목 —— **"돌파 침투류 점수 규칙(병합판)"에 엄격히 정렬, 총 25 항목**
 * (1. 권한 획득 21 개 + 2. 네트워크 경계 돌파 4 개, 총 8 개 분류; 그중 "같은 행의 서로 다른 과금 단위"는 독립 득점 항목으로 나눈다. 예: 연산 인프라의 관리자 권한과 연산 카드).
 *
 * 이전 버전과의 차이: 더 이상 "같은 규칙 안의 권한 등급"으로 항목을 나누지 않는다 —— 한 항목 = 병합판의 한 행
 * (`tier` 필드에 그 항목의 등급/하위 항목을 적는다), **과금 단위가 다른** 여러 등급만 하위 항목을 유지한다
 * (예: 연산 인프라의 "관리자 권한"과 "연산 카드 10 점/장").
 *
 * 필드 의미:
 *   · src    병합판의 "원래 번호"(원본 표와 항목별 대조에 쓴다);
 *   · group  화면 그룹: GENERAL = 일반 시스템 장악, WEB = Web 애플리케이션 시스템 장악,
 *            CENTRAL = 중앙 집권 시스템 장악, BIGDATA = 빅데이터 시스템 장악,
 *            NETINFRA = 네트워크 인프라 장악, STORAGE = 파일 스토리지 계열 시스템,
 *            MODEL = 모델 관련 시스템 장악, BOUNDARY = 네트워크 경계 돌파;
 *   · points 단일 득점(한 항목에 여러 등급이 있으면 그 항목의 주 등급을 쓰고, 설명에 각 등급을 밝힌다);
 *   · cap    해당 항목의 상한(0 = 상한 없음); dedup_scope 는 득점 기준.
 */
export const SCORE_GROUPS = [
  { code: 'GENERAL', name: "General systems" },
  { code: 'WEB', name: "Web application systems" },
  { code: 'CENTRAL', name: "Centralized systems" },
  { code: 'BIGDATA', name: "Big-data systems" },
  { code: 'NETINFRA', name: "Network infrastructure" },
  { code: 'STORAGE', name: "File storage systems" },
  { code: 'MODEL', name: "Model-related systems" },
  { code: 'BOUNDARY', name: "Boundary breach" },
]

export const DEFAULT_SCORE_POINTS = [
  /* ══ 1. 권한 획득(18 개)══════════════════════════════════════════════ */

  /* 1 도메인 제어 권한 */
  sp(1, 1, "50 pts per primary domain / 20 pts per secondary domain", 'domain-control', "Domain control privilege", 'GENERAL', 50, 400, 'system',
    "**Primary domains score 50 pts each, secondary domains 20 pts each**, graded by domain type; this item is capped at 400 pts (G3).\n"
    + "When recording, state the domain and its type in `evidence`; for a secondary domain set the per-hit points to 20."),

  /* 2 엔드포인트 권한 */
  sp(2, 2, "5 / 10 pts per unit", 'terminal-access', "Endpoint privilege (phones, tablets, PCs, printers, cameras, wifi routers, etc.)", 'GENERAL', 10, 600, 'system',
    "**Printers and wifi routers score 5 pts per unit; PCs, tablets, phones, cameras, and electronic displays score 10 pts per unit** (G4), accumulating per unit; this item is capped at 600 pts (G3).\n"
    + "Controlled endpoint devices must prove their relation to the target organization (G7); for a 5-pt device set the per-hit points to 5.\n"
    + "Endpoints obtained via phishing also score under this item; state the target person role in `evidence` (general office / IT operations / business operations)."),

  /* 3 서버 호스트 권한 */
  sp(3, 3, "10 pts per ordinary privilege / 50 pts per admin privilege", 'server-host', "Server host privilege (including WebShell access)", 'GENERAL', 50, 600, 'system',
    "**Ordinary privileges score 10 pts each, admin privileges 50 pts each**; this item is capped at 600 pts (G3).\n"
    + "The same host counts only once at its highest privilege (G1) — after root/SYSTEM, ordinary privileges on that host no longer accumulate.\n"
    + "Taking one server host does not deduct points; for an ordinary privilege set the per-hit points to 10."),

  /* 4 데이터베이스 접속 계정 비밀번호 */
  sp(4, 4, "10 pts ordinary / 50 pts admin / 10 pts unauthorized, each", 'db-credential', "Database account credentials (including SQL injection)", 'GENERAL', 50, 400, 'system',
    "**Ordinary user privileges score 10 pts each, admin privileges 50 pts each; redis and other empty-password or unauthorized-access results score a flat 10 pts each**; this item is capped at 400 pts (G3).\n"
    + "Equivalent privileges on the same database (including admin) score only once; system, application, and database privileges on the same host score only once at the highest privilege (G1).\n"
    + "Data results score separately (G2); for an ordinary privilege or unauthorized access set the per-hit points to 10."),

  /* 5, 6 메일과 업무 생산 시스템(원본 표의 두 항목이 규칙과 상한을 공유) */
  sp(5, 5, "100 pts per admin privilege / 50 pts per ordinary privilege", 'web-app', "Mail system / office-automation and business-production systems / other web application privileges", 'WEB', 100, 2000, 'system',
    "**Admin privileges score 100 pts each, ordinary user privileges 50 pts each; each system counts only once at its highest privilege** (G1); this item is capped at 2000 pts (G3).\n"
    + "This item merges items 5 and 6 of the original table (identical rules and caps), **i.e. the \"web application systems\" category**; when recording, state in `evidence` which kind of system it is:\n"
    + "· **Mail system**;\n"
    + "· **Office-automation and business-production systems** (office OA, ERP, direct-report instant messaging, finance systems, business-production systems, data warehouses — systems whose compromise or outage affects industry or unit production, operations management, or daily office work);\n"
    + "· **Other web application systems (catch-all)**: HTTP/HTTPS sites you have **actually verified you can log in to** with an account from the credential list, "
    + "that do not fall into a more specific score point category (centralized systems go to item 7, big-data systems to item 8, cloud management platforms to item 11, IoT management platforms to item 12, security devices to item 13, etc.); "
    + "all of them score under this item (admin 100 / ordinary 50). **Web logins where the credential list only records `host:port` with no system name or business owner (back offices, admin consoles, operations platforms, in-house business systems, etc.) also fall here** — "
    + "first check whether a more fitting category applies; if not, file it under \"web application systems\" rather than skipping it because you cannot tell whether it is mail/OA. "
    + "When recording, put the actual login URL (with port) in `target` and state \"which site + which account + admin/ordinary tier\" in `evidence`; verify the login live first per red line 1.\n"
    + "Mail data additionally scores separately by importance (G2); for an ordinary user privilege set the per-hit points to 50."),

  /* 7 중앙 집권 시스템 */
  sp(7, 6, "500 pts per admin privilege / 50 pts per ordinary privilege", 'central-system', "Centralized system privilege (O&M / identity / networking / endpoint management consoles)", 'CENTRAL', 500, 4000, 'system',
    "**System admin privileges score 500 pts each, ordinary privileges 50 pts each**; each privilege scores only once, so holding both admin and ordinary access awards only the admin points (G1); this item is capped at 4000 pts (G3).\n"
    + "Centralized systems cover four kinds:\n"
    + "· **O&M centralization**: jump servers, centralized monitoring, unified resource publishing, etc.;\n"
    + "· **Identity and privilege management**: SSO, 4A, IAM, etc.;\n"
    + "· **Network centralization**: domain controllers, certificate authorities, SD-WAN unified controllers, etc.;\n"
    + "· **Endpoint/host management consoles**: endpoint management software backends, zero-trust control centers, etc.\n"
    + "⚠️ **Hosts and endpoints managed by a centralized system are scored under the \"general systems\" points instead** (e.g. PCs and mobile endpoints at 10 pts per unit, G4) —"
    + "**do not apply the centralized system's top tier of 500 pts**, which would grossly overstate it; batch control must be proven with logins to at least 20% of the managed nodes, and 20 nodes at most is enough."),

  /* 8 빅데이터 시스템 */
  sp(8, 7, "1000 pts per admin privilege / 100 pts per ordinary privilege", 'bigdata-system', "Big-data system privilege", 'BIGDATA', 1000, 4000, 'system',
    "**Admin privileges are worth 1000 pts, ordinary privileges 100 pts each**; each privilege scores only once, so holding both admin and ordinary access awards only the admin points (G1); this item is capped at 4000 pts (G3).\n"
    + "Data scores separately (G2); **systems with effective data volume below 500 million rows or 1 TB are treated as ordinary databases** (i.e. use the item 4 points)."),

  /* 9 네트워크 장비 권한 */
  sp(9, 8, "100 pts ordinary / 200 pts admin / +200 or +1000 pts bonus", 'netdev', "Network device privilege (firewalls, routers, switches, gap devices, optical gap devices, ferry machines, VPNs, etc.)", 'NETINFRA', 200, 2000, 'service',
    "**Ordinary user privileges are worth 100 pts, admin privileges 200 pts**; this item is capped at 2000 pts (G3). Routing-table evidence or connection-count screenshots are required (G7).\n"
    + "Achieving the following on the same device **earns bonus points** (scored at the tier achieved):\n"
    + "· **Network redirection or service hijacking** through the device: +200 pts;\n"
    + "· **Implanting a remote-control program on the device and successfully carrying out follow-up attacks**: 1000 pts.\n"
    + "For an ordinary privilege or a bonus tier, set the per-hit points to the actual tier."),

  /* 10 산업 인터넷 시스템 */
  sp(10, 9, "200 pts admin / 10 pts per device", 'iiot', "Industrial internet system privilege", 'NETINFRA', 200, 2000, 'system',
    "**Admin privileges on the management console are worth 200 pts; hosted interconnected devices score 10 pts each** (G4); this item is capped at 2000 pts (G3).\n"
    + "Covers connected vehicles, smart manufacturing, remote diagnostics, intelligent transport, etc. To accumulate devices per unit, use separate score hits (with points set to 10)."),

  /* 11 클라우드 관리 플랫폼 */
  sp(11, 10, "500 pts admin / 10 pts per node", 'cloud-platform', "Cloud management platform control (including PaaS platforms such as Kubernetes, Red Hat OpenShift, etc.)", 'NETINFRA', 500, 2000, 'system',
    "**Admin privileges are worth 500 pts; cloud hosts and containers score 10 pts per unit** (G4); this item is capped at 2000 pts (G3). Cloud business systems score separately under the important-system rules.\n"
    + "Batch control via AK/SK by default **scores only the controlled nodes, not the admin privilege**, unless admin rights are proven (e.g. creating cloud nodes, managing user permissions).\n"
    + "⚠️ **With fewer than 100 nodes, score it as an ordinary web application and give no node points** (i.e. use the item 5/6 basis)."),

  /* 12 IoT 장비 관리 플랫폼 */
  sp(12, 11, "200 pts platform / 10 pts per connection point / +5000 pts core network", 'iot-platform', "IoT device management platform privilege", 'NETINFRA', 200, 2000, 'system',
    "**An IoT platform with control capability is worth 200 pts; connection points on the platform score 10 pts per unit** (G4); this item is capped at 2000 pts (G3).\n"
    + "**Entering the core network through an IoT endpoint device and controlling important systems such as business production earns a separate +5000 pts** (not bound by this item's 2000-pt cap; record it as a separate hit)."),

  /* 13 보안 장비 */
  sp(13, 12, "200 pts admin", 'secdev', "Security device privilege (IPS, IDS, audit appliances, WAF, and other non-centralized security devices)", 'NETINFRA', 200, 1000, 'service',
    "**Admin privileges are worth 200 pts**; this item is capped at 1000 pts (G3). Limited to non-centralized security devices (centralized ones go to item 7)."),

  /* 14 파일 스토리지 계열 시스템 */
  sp(14, 13, "50 pts admin / 10 pts per ordinary privilege", 'file-storage', "File storage system privilege (FTP, object storage, enterprise NAS, enterprise cloud drives, etc.)", 'STORAGE', 50, 500, 'system',
    "**Admin privileges score 50 pts each; ordinary user privileges, empty systems, or systems holding only test data score 10 pts each**; this item is capped at 500 pts (G3).\n"
    + "Covers FTP, object storage (scored per system), enterprise NAS, enterprise cloud drives, etc.; data scores separately (G2). For an ordinary privilege set the per-hit points to 10."),

  /* 15 모델 에이전트 / agent 도구 */
  sp(15, 14, "100–500 pts each", 'ai-agent', "Model agents, skills, and other agent tools (with the ability to drive an agent to attack)", 'MODEL', 100, 4000, 'service',
    "**100–500 pts each**, a range graded by control and operation depth; this item is capped at 4000 pts (G3).\n"
    + "Covers model agents, skills, and other agent tools; when recording, state the control/operation depth in `evidence` and set the per-hit points to the assessed tier."),

  /* 16, 17 연산 관리 플랫폼 + 학습 데이터/지식 베이스 시스템(원본 표의 두 항목은 규칙이 글자까지 같다) */
  sp(16, 15, "500 pts per system admin privilege", 'model-compute', "Compute management platform privilege / training-data and knowledge-base system privilege", 'MODEL', 500, 4000, 'system',
    "**Obtaining system admin privileges scores 500 pts each**; this item is capped at 4000 pts (G3).\n"
    + "This item merges items 16 and 17 of the original table (identical wording); when recording, state in `evidence` which kind of system it is:\n"
    + "· **Compute management platform** (able to manage and schedule compute resources, etc.);\n"
    + "· **Training-data, knowledge-base, and related systems** (able to steal or tamper with training data or knowledge bases, plant poisoned data, etc.).\n"
    + "Systems with large data volumes (over 100 million rows or 10 TB) **score double**; controlling a knowledge-base-related system **scores double** (G5)."),

  /* 18 모델 관련 데이터 시스템 */
  sp(18, 16, "500 pts per system admin privilege", 'model-data', "Model-related data system privilege", 'MODEL', 500, 4000, 'system',
    "**Obtaining system admin privileges scores 500 pts each**; this item is capped at 4000 pts (G3).\n"
    + "Allows interference with model training, inference, and operations services, and theft or tampering with model weight files, etc.\n"
    + "⚠️ The difference from items 16 and 17 **must not be flattened**: this item **does not include \"controlling a knowledge-base-related system doubles the score\"**, but it does include \"data-asset results are scored by the data rules\" (G2); "
    + "Systems with very large data volumes (over 100 million rows or over 10 TB) score double (G5)."),

  /* 19 연산 인프라(권한과 연산 카드 두 가지 과금 단위, 두 항목 유지) */
  sp(19, 17, "500 pts per admin privilege", 'computepower-admin', "Compute infrastructure · admin privilege", 'MODEL', 500, 2000, 'system',
    "**Admin privileges score 500 pts each**; this item is capped at 2000 pts (including path points, G3).\n"
    + "This item and \"Compute infrastructure · compute card resources\" both belong to item 19 and share the 2000-pt cap; the three (admin privilege / large compute-card resources / compute-card pooling platform) can each score but are subject to this item's overall cap."),
  sp(19, 18, "10 pts per card", 'computepower-cards', "Compute infrastructure · compute card resources / compute-card pooling platform", 'MODEL', 10, 2000, 'none',
    "**10 pts per card**, accumulating per card (G4); obtaining large compute-card resources and obtaining a compute-card pooling platform each score directly, each capped at 2000 pts, and sharing item 19's overall 2000-pt cap with \"admin privilege\".\n"
    + "When recording, state the card count or platform name in `evidence`."),

  /* ══ 2. 네트워크 경계 돌파(4 항목, 목표 단위 전체에서 같은 종류의 경계는 한 번만 득점)══════════ */

  sp(22, 19, "1000 pts", 'boundary-logical', "Enter a logically isolated business intranet", 'BOUNDARY', 1000, 0, 'target',
    "**1000 pts**. Scope: breaking the same kind of network boundary scores only once for the entire target unit.\n"
    + "Proof material (G7): control screenshots of the firewall isolation device, a screenshot proving intranet access, etc."),
  sp(23, 20, "10000 pts", 'boundary-strong', "Enter a logically strongly isolated business intranet", 'BOUNDARY', 10000, 0, 'target',
    "**10000 pts**. Scope: breaking the same kind of network boundary scores only once for the entire target unit.\n"
    + "Proof material (G7): control screenshots of the gap-type isolation device, a screenshot proving intranet access, etc."),
  sp(24, 21, "30000 pts", 'boundary-physical', "Enter a physically isolated intranet / core production network", 'BOUNDARY', 30000, 0, 'target',
    "**30000 pts**. Scope: breaking the same kind of network boundary scores only once for the entire target unit.\n"
    + "Proof material (G7): control screenshots of firewalls, VPNs, multi-NIC hosts, network devices, and gap-type isolation devices, plus a screenshot proving intranet access, etc.\n"
    + "Examples: railway dispatch private networks, bank core accounting networks, power production control zones, carrier signaling networks, energy production IoT networks, etc."),
  sp(25, 22, "1000 pts (max 3000)", 'boundary-supply', "Enter an intranet via a supply-chain O&M channel or cloud service", 'BOUNDARY', 1000, 3000, 'service',
    "Scored under three scenarios:\n"
    + "· Entering **the same primary defending unit's intranet**: 1000 pts;\n"
    + "· Using **one** supply-chain entity or cloud service to enter **multiple** primary defending units' intranets: 1000 pts per primary defending unit;\n"
    + "· Using **multiple** supply-chain entities or cloud services to enter different network zones of **one** primary defending unit's intranet: 1000 pts per zone, up to 3000 pts.\n"
    + "When recording, state in `evidence` which scenario applies and which primary defending unit / network zone is involved."),

  /* ══ 부가 성과 가산(위의 특정 권한에 딸리지만 **독립 득점, 독립 상한**)══════════
     이 항목들은 "시스템 권한을 하나 더 얻는" 것이 아니라 "이미 얻은 권한 위에서 또 무엇인가를 해낸" 것이다(문서의 +N 점).
     기본 항목 안에 두면 그 rule 상한을 공유해 기본 점수에 먹히므로, 독립 득점 항목으로 나눈다. */

  /* 9 네트워크 장비 가산: 해당 장비로 네트워크 리다이렉션 또는 업무 탈취가 가능 +200 점 */
  sp(9, 23, "Redirection / service hijacking +200 pts", 'netdev-redirect', "Network device · Network redirection or service hijacking via the device", 'NETINFRA', 200, 2000, 'none',
    "**Adds 200 pts on top of the \"network device privilege\" score** (item 9 of the rules document).\n"
    + "Applies to: changing routes/policies to steer traffic to our controlled node, DNS hijacking, business-traffic hijacking — redirection that actually took effect.\n"
    + "Evidence required (G7): routing table, policy configuration, or connection-count screenshot; state the redirection direction and how it was verified in `evidence`."),

  /* 9 네트워크 장비 가산: 장비에 원격 제어 프로그램을 심고 후속 공격에 성공 1000 점 */
  sp(9, 24, "Remote-control implant + follow-up attack 1000 pts", 'netdev-implant', "Network device · Implant a remote-control program and successfully carry out follow-up attacks", 'NETINFRA', 1000, 2000, 'none',
    "**Adds 1000 pts on top of the \"network device privilege\" score** (item 9 of the rules document).\n"
    + "Both must be proven: \"the implant succeeded **and** was used to complete follow-up attacks\" — evidence of the remote-control process/persistence plus follow-up results obtained through that device."),

  /* 12 IoT: 엔드포인트 장비로 코어 네트워크에 침투해 업무 생산 등 중요 시스템을 장악, 별도 5000 점 가산 */
  sp(12, 25, "Core network +5000 pts", 'iot-corenet', "IoT · Enter the core network via an endpoint device and control important systems", 'NETINFRA', 5000, 5000, 'none',
    "**Item 12 of the rules document explicitly says \"add 5000 pts separately\"**, which does not count against that item's 2000-pt cap.\n"
    + "Applies to: moving laterally from an IoT endpoint device into the core network and controlling important systems such as business production;\n"
    + "in `evidence`, state: which endpoint was used, which core-network systems were controlled, and what privileges were obtained."),
]

/* ------------------------------------------------------------------ 내부 보조 함수의 내보내기 */

/**
 * 아래 함수들은 원래 core.js 안의 모듈 수준 함수였고(외부로 내보내지 않았다), 분리한 뒤 core.js 가 쓰게 되었으므로
 * 명시적으로 내보낸다. 이것들은 "남에게 주는 API"가 아니므로, 시그니처를 바꾸기 전에 core.js 의 사용법을 먼저 보라.
 */
export {
  normalizePort, targetAuthority, systemKeyOf, pickBestHit, legacyCapGroup,
  targetHasIpv6Host, evaluateScoreBoard, loadScoreMeta, loadAssetNames, hitPointsOf,
  scoreMultiplierOf,
}
