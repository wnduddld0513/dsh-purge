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
  'target-outbound': '대상이 자발적으로 외부로 연결(리버스 shell / 대상에서 frp 클라이언트 실행)',
  'target-http': '대상의 WebShell/HTTP 채널 경유(suo5 / Neo-ReGeorg)',
  'target-agent': '대상에서 이미 장악한 프로세스/세션 경유 전달(SSH -R 등)',
  'self-only': '자기 VPS/직접 구축한 서버에서만(돌파로 치지 않음)',
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
  if (authority === null) return hit.target ? String(hit.target) : '(서비스 미표기)'
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
  if (ipv6) { multiplier *= 3; reasons.push("G6 IPv6 성과 ×3") }
  const scale = String(hit.data_scale || "").trim().toLowerCase()
  if (scale === "large") { multiplier *= 2; reasons.push("G5 데이터 규모 1억 건 / 10TB 초과 ×2") }
  else if (scale === "knowledge-base" || scale === "kb") { multiplier *= 2; reasons.push("G5 지식 베이스 관련 시스템 장악 ×2") }
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
    return '「' + label + '」이 항목은 득점하지 않는다: '
      + (hit.rule === null || hit.rule === undefined ? '' : '규칙 ' + hit.rule + ' ')
      + '의**누적 득점이 이미 해당 규칙 상한(' + (Number(hit.rule_cap) || 0) + ' 점)에 도달했다** —— 같은 규칙에서 상한을 넘는 부분은 더 이상 누적되지 않는다. '
      + '힘을 다른 규칙이나 다른 자산으로 돌려라. 이미 상한에 닿은 규칙에서 계속 점수를 만들지 마라.'
  }
  return '「' + label + '」이 타깃에서의 권한은 이미 최대로 확보했다(득점 기준: 같은 타깃은 점수가 가장 높은 한 건만 인정'
    + (bestPoints === undefined || bestPoints === null ? '' : ', +' + bestPoints + ' 점')
    + ') —— 이 건은 규칙상 더 득점하지 않고 과정 기록으로만 남긴다; **타깃이나 규칙을 바꿔 진행하고, 같은 타깃에서 같은 종류의 성과를 반복해 만들지 마라**.'
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
    need: '타깃 도메인의 DNS 레코드가 우리 쪽 통제로 바뀌었거나(NS/A 레코드 반영), 도메인 관리 콘솔을 조작할 수 있다',
    proof: '관리 콘솔 스크린샷 + 레코드 변경 전후의 dig/nslookup 비교',
    replay: 'nslookup <도메인> <우리 NS>; 또는 콘솔 조작 요청 원문',
    script: 'dig NS <도메인> @8.8.8.8\ndig <도메인> @<우리NS>',
  },
  'terminal-access': {
    need: '엔드포인트에 명령을 내려 실행 결과를 돌려받을 수 있다("장비 하나를 발견했다"가 아니다)',
    proof: '장악한 엔드포인트에서 실행한 id/hostname 출력 + 타깃 기관과의 관계 증명(G7)',
    replay: '원격 제어 세션에서 id 실행; 또는 트로이 목마/원격 제어 agent 의 접속 기록',
    script: 'id; whoami; hostname',
  },
  'server-host': {
    need: '호스트에서 명령을 실행해 출력을 받았다(WebShell / 리버스 Shell / 원격 제어 모두 인정)',
    proof: '명령 출력(id / hostname) + WebShell 접속 요소 또는 세션 기록',
    replay: 'WebShell 요청 원문(그대로 재생 가능); 또는 리버스 Shell 리스너 기록',
    script: 'id; uname -a; cat /etc/passwd | head',
  },
  'db-credential': {
    need: '계정으로 데이터베이스에 실제 접속해 쿼리를 실행했다(비인가 접속도 인정: 접속되면 성립)',
    proof: '로그인 성공 후 쿼리 출력(select user(), version()) + 계정 권한 등급',
    replay: 'mysql -h <host> -P <port> -u <user> -p\'<pass>\' -e "select user(),version()"',
    script: 'mysql -h <host> -u <user> -p -e "select user(),version(),current_user()"',
  },
  'web-app': {
    need: '타깃에 이미 존재하던 계정(일반 또는 관리자)으로 시스템에 로그인해 보호된 페이지에 접근했다',
    proof: '로그인 후 페이지 내용/출력 + 세션 Cookie 또는 Token(패스워드만 얻은 것이 아님을 증명)',
    replay: '로그인 요청 원문(증명 Cookie/Token 포함) + 세션을 붙인 보호 페이지 요청 1건',
    script: 'curl -i -s -X POST <로그인URL> -d "username=<u>&password=<p>" -c cookie.txt\ncurl -s -b cookie.txt <보호페이지>',
  },
  'central-system': {
    need: '배스천 호스트/도메인 컨트롤러/SSO/엔드포인트 관리 콘솔 등 집권 시스템에 로그인해 관리자 권한을 얻었다',
    proof: '관리 콘솔 화면 스크린샷 + "하위 노드를 통제할 수 있음"을 보이는 조작(관리 노드의 20% 또는 20대 로그인)',
    replay: '로그인 요청 원문 + 통제 조작 1회(예: 관리 호스트 목록 조회)의 요청과 응답',
    script: 'curl -s -b cookie.txt "<관리목록API>"',
  },
  'bigdata-system': {
    need: '빅데이터 플랫폼(Hadoop/Spark/ES 등)의 관리자 또는 일반 권한을 얻었다',
    proof: '플랫폼 관리 페이지/API 출력 + 접근 가능한 데이터 규모(건수 또는 용량)',
    replay: '플랫폼 API 요청 원문(예: ES _cat/indices, YARN /ws/v1/cluster/apps)',
    script: 'curl -s "<플랫폼API>" | head -50',
  },
  netdev: {
    need: '네트워크 장비(방화벽/라우터/스위치/VPN/망간 장비)에 로그인해 권한을 얻었다',
    proof: '장비 관리 페이지 스크린샷 + 라우팅 테이블 또는 연결 수 스크린샷(G7 명시 요구)',
    replay: '장비 로그인 요청 원문 + 라우팅 테이블을 읽는 명령 출력',
    script: 'show ip route    # 또는 display ip routing-table',
  },
  'netdev-redirect': {
    need: '해당 장비로 실제 트래픽 방향을 바꿨다(정책/라우팅/DNS 변경이 반영됨)',
    proof: '변경 전후 라우팅 테이블 또는 정책 비교 + 우리 노드가 트래픽을 받은 증거',
    replay: '정책 설정 요청 원문 + 우리 통제 노드의 패킷 캡처/접근 로그',
    script: 'tcpdump -ni any port <포트> -c 10',
  },
  'netdev-implant': {
    need: '장비에 실행 가능한 원격 제어/지속성 수단을 심었고, **그리고** 그것으로 후속 공격을 수행했다',
    proof: '원격 제어 프로세스 또는 지속성 항목의 증거 + 해당 장비를 경유한 후속 성과 기록',
    replay: '심기 동작의 요청/명령 원문 + 이후 해당 장비를 경유한 접근 로그',
    script: '',
  },
  iiot: {
    need: '산업 인터넷 시스템의 관리자 권한을 얻었거나, 그 아래 연결된 장비를 일괄 통제했다',
    proof: '관리 콘솔 스크린샷 + 장악한 장비 목록과 수량',
    replay: '로그인 요청 원문 + 장비 목록 API 응답',
    script: '',
  },
  'cloud-platform': {
    need: '클라우드 관리 플랫폼 관리자 권한; 또는 ak/sk 로 클라우드 노드를 일괄 통제(노드 득점은 100개 이상일 때만 인정)',
    proof: '플랫폼 관리 페이지 스크린샷; ak/sk 의 경우 장악한 노드 목록과 수량, 또는 관리자 증명(노드 추가/권한 변경)',
    replay: '플랫폼 API 요청 원문(인스턴스 나열, 사용자 생성 등)',
    script: 'curl -s -H "Authorization: Bearer <token>" "<플랫폼/인스턴스목록API>"',
  },
  'iot-platform': {
    need: 'IoT 관리 플랫폼 권한을 얻었거나, 그 연결 지점을 통해 장비를 일괄 통제했다',
    proof: '플랫폼 관리 페이지 스크린샷 + 연결 지점/장비 수량',
    replay: '플랫폼 로그인 및 장비 목록 API 원문',
    script: '',
  },
  'iot-corenet': {
    need: 'IoT 엔드포인트 장비에서 코어 네트워크로 횡적 이동해 업무 생산 등 중요 시스템을 장악했다',
    proof: '경로 설명(어느 엔드포인트 → 코어 네트워크 → 어느 시스템) + 해당 시스템의 통제 증거',
    replay: '엔드포인트에서 시작한 횡적 이동 명령 + 코어 네트워크 시스템의 로그인/조작 요청',
    script: '',
  },
  secdev: {
    need: '비집권형 보안 장비(IPS/IDS/감사/WAF)의 관리자 권한을 얻었다',
    proof: '장비 관리 페이지 스크린샷 + 정책 통제가 가능함을 보이는 조작',
    replay: '로그인 요청 원문 + 정책 조회 API 응답 1건',
    script: '',
  },
  'file-storage': {
    need: '파일 스토리지 시스템의 백엔드 권한(FTP/NAS/클라우드 드라이브/오브젝트 스토리지)을 얻었거나, 그 일반 계정을 확보했다',
    proof: '디렉터리 목록 스크린샷 + 읽을 수 있는 파일 목록(데이터 성과는 별도 득점, G2 참조)',
    replay: '디렉터리 목록 요청 원문(FTP LIST / S3 ListObjects / WebDAV PROPFIND)',
    script: 'curl -s "<스토리지API>" | head -50',
  },
  'ai-agent': {
    need: '모델 에이전트/skill 등 agent 도구를 통제했고, **실제로 그것을 구동해 동작을 수행시켰다**',
    proof: '대화 또는 호출 기록 + 구동되어 수행된 동작과 그 결과(구간 점수는 통제 깊이로 판정)',
    replay: 'agent 를 구동한 요청 원문 + 그것이 수행한 동작의 출력',
    script: '',
  },
  'model-compute': {
    need: '연산 관리 플랫폼/학습 데이터 및 지식 베이스 시스템의 시스템 관리자 권한을 얻었다',
    proof: '관리 콘솔 스크린샷 + 연산 스케줄링 또는 데이터 읽기/쓰기가 가능함을 보이는 조작',
    replay: '플랫폼 로그인 및 스케줄링/데이터 API 원문',
    script: '',
  },
  'model-data': {
    need: '모델 관련 데이터 시스템의 관리자 권한을 얻었다(학습/추론/운영에 영향, 또는 가중치 탈취·변조 가능)',
    proof: '관리 콘솔 스크린샷 + 읽기/쓰기가 가능한 모델/데이터셋 목록',
    replay: '플랫폼 API 원문(모델 나열, 가중치 다운로드)',
    script: '',
  },
  'computepower-admin': {
    need: '연산 인프라 관리자 권한을 얻었다',
    proof: '관리 콘솔 스크린샷 + 스케줄링 가능한 자원 증명',
    replay: '플랫폼 로그인 및 자원 목록 API 원문',
    script: '',
  },
  'computepower-cards': {
    need: '연산 카드 자원을 실제로 확보했거나(10 점/카드) 카드 풀링 플랫폼의 통제권을 얻었다',
    proof: '카드 자원 목록(수량) + 작업 제출 또는 카드 독점 증거',
    replay: 'nvidia-smi 출력 / 플랫폼 카드 목록 API',
    script: 'nvidia-smi -L',
  },
  'boundary-logical': {
    need: '타깃 측에서 내부 네트워크로 통하는 채널을 세웠고, **실제로 내부 타깃에 접근할 수 있다**',
    proof: '터널 등록(진입점은 반드시 타깃 측) + 터널 경유 내부 타깃 접근 출력/스크린샷(G7)',
    replay: '터널 경유로 내부 타깃에 접근한 그 명령과 출력; 터널 구축 명령',
    script: 'curl --socks5-hostname 127.0.0.1:<포트> http://<내부IP>/ -i',
  },
  'boundary-strong': {
    need: '망간(gap)류 강격리를 돌파해 강격리 업무 내부 네트워크로 들어가 내부 타깃에 실제 접근했다',
    proof: '망간류 격리 장비의 통제 스크린샷 + 내부 네트워크 접근을 증명하는 스크린샷(G7)',
    replay: '강격리 채널 경유로 내부 타깃에 접근한 명령과 출력',
    script: '',
  },
  'boundary-physical': {
    need: '물리 격리를 돌파했거나 핵심 생산망으로 들어가 타깃에 실제 접근했다',
    proof: '방화벽/VPN/다중 NIC 호스트/망간 장비의 통제 스크린샷 + 내부 네트워크 접근 스크린샷(G7)',
    replay: '핵심망 진입 후 타깃에 접근한 명령과 출력',
    script: '',
  },
  'boundary-supply': {
    need: '공급망 운영 채널 또는 클라우드 서비스를 통해 주 방어 기관 내부 네트워크로 들어갔다(상황별로 각각 득점)',
    proof: '공급망/클라우드 측 통제 증거 + 주 방어 기관 내부 네트워크 진입 증명; 어느 상황인지 명시',
    replay: '공급망 채널에서 내부 네트워크로 진입한 명령과 출력',
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
  { code: 'G1', name: '권한은 높은 것만, 한 번만', detail: '같은 시스템, 같은 호스트, 같은 데이터베이스에서 여러 권한을 얻은 경우 최고 권한으로 한 번만 득점한다(관리자와 일반 권한을 모두 얻어도 관리자 권한 점수만 준다).' },
  { code: 'G2', name: '데이터 성과는 별도 득점', detail: '메일 데이터, 업무 데이터, 데이터 자산 등 성과는 데이터 중요도에 따라 따로 득점하며 권한 점수와 섞지 않는다.' },
  { code: 'G3', name: '상한 기준', detail: '각 항목의 점수 상한은 단일 방어 기관과 그 모든 하위 기관에 적용되며, 상한에 도달하면 더 누적되지 않는다.' },
  { code: 'G4', name: '장비/엔드포인트는 대(개) 단위 득점', detail: '프린터, wifi 라우터 5 점/대; PC, Pad, 휴대폰, 카메라, 전자 대형 스크린 10 점/대; 클라우드 호스트, 컨테이너, 위탁 연결 장비, IoT 연결 지점 등은 10 점/대(개). 일괄 통제는 "장악한 노드"로 환산한다.' },
  { code: 'G5', name: '데이터 규모 배증', detail: '대량 데이터를 보유한 시스템(중요 데이터량 1억 건 또는 10TB 초과)은 점수가 배가되고, 지식 베이스 관련 시스템 장악도 점수가 배가된다. 시스템이 생성하는 일반 로그 데이터는 포함하지 않는다.' },
  { code: 'G6', name: 'IPv6 배수', detail: 'IPv6 를 이용해 얻은 성과의 점수는 ×3 이지만, 상한은 해당 시스템 유형의 원래 상한으로 계산하며 배수 때문에 상한을 넘지 않는다.' },
  { code: 'G7', name: '증명 자료', detail: '네트워크 경계 돌파는 격리 장비 통제 스크린샷, 내부 네트워크 접근을 증명하는 스크린샷 등을 제출해야 한다; 장악한 휴대폰, Pad 등 엔드포인트 장비는 타깃 기관과의 관계를 증명할 수 있어야 한다; 네트워크 장비 권한은 라우팅 테이블 등 증거 또는 연결 수 스크린샷을 제출해야 한다.' },
  { code: 'G8', name: '폴백 조항', detail: '그 밖의 시스템, 서버, 장비 등의 권한은 점수를 미리 정하지 않고 전담 그룹이 검토해 부여한다.' },
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
  { code: 'GENERAL', name: '일반 시스템 장악' },
  { code: 'WEB', name: 'Web 애플리케이션 시스템 장악' },
  { code: 'CENTRAL', name: '중앙 집권 시스템 장악' },
  { code: 'BIGDATA', name: '빅데이터 시스템 장악' },
  { code: 'NETINFRA', name: '네트워크 인프라 장악' },
  { code: 'STORAGE', name: '파일 스토리지 계열 시스템' },
  { code: 'MODEL', name: '모델 관련 시스템 장악' },
  { code: 'BOUNDARY', name: '네트워크 경계 돌파' },
]

export const DEFAULT_SCORE_POINTS = [
  /* ══ 1. 권한 획득(18 개)══════════════════════════════════════════════ */

  /* 1 도메인 제어 권한 */
  sp(1, 1, '1급 50 / 2급 20 점/개', 'domain-control', '도메인 제어 권한', 'GENERAL', 50, 400, 'system',
    '**1급 도메인 50 점/개, 2급 도메인 20 점/개**, 도메인 유형에 따라 점수를 준다; 이 항목 상한 400 점(G3).\n'
    + '득점 기록 시 evidence 에 도메인과 그 유형을 명시한다; 2급 도메인이면 단일 득점을 20 으로 조정한다.'),

  /* 2 엔드포인트 권한 */
  sp(2, 2, '5 / 10 점/대', 'terminal-access', '엔드포인트 권한(휴대폰, Pad, PC, 프린터, 카메라, wifi 라우터 등)', 'GENERAL', 10, 600, 'system',
    '**프린터, wifi 라우터 5 점/대; PC, Pad, 휴대폰, 카메라, 전자 대형 스크린 10 점/대**(G4), 대수로 누적; 이 항목 상한 600 점(G3).\n'
    + '장악한 엔드포인트 장비는 타깃 기관과의 관계를 증명할 수 있어야 한다(G7); 5 점 등급 장비면 단일 득점을 5 로 조정한다.\n'
    + '피싱으로 확보한 엔드포인트도 이 항목으로 득점하며, evidence 에 대상 인원의 역할(일반 사무 / IT 운영 / 업무 운영)을 명시한다.'),

  /* 3 서버 호스트 권한 */
  sp(3, 3, '일반 10 / 관리자 50 점/개', 'server-host', '서버 호스트 권한(webshell 권한 포함)', 'GENERAL', 50, 600, 'system',
    '**일반 권한 10 점/개, 관리자 권한 50 점/개**; 이 항목 상한 600 점(G3).\n'
    + '같은 호스트는 최고 권한으로 한 번만 계산한다(G1) —— root/SYSTEM 을 얻은 뒤에는 같은 호스트에서 일반 권한이 더 누적되지 않는다.\n'
    + '서버 호스트 1대를 확보해도 감점되지 않는다; 일반 권한이면 단일 득점을 10 으로 조정한다.'),

  /* 4 데이터베이스 접속 계정 비밀번호 */
  sp(4, 4, '일반 10 / 관리자 50 / 비인가 10 점/개', 'db-credential', '데이터베이스 접속 계정 비밀번호(SQL 인젝션 포함)', 'GENERAL', 50, 400, 'system',
    '**일반 사용자 권한 10 점/개, 관리자 권한 50 점/개; redis 및 그 밖의 빈 비밀번호·비인가 접속 성과는 일괄 10 점/개**; 이 항목 상한 400 점(G3).\n'
    + '같은 데이터베이스의 동등 권한(관리자 포함)은 한 번만 득점한다; 같은 호스트의 시스템 권한·애플리케이션 권한·데이터베이스 권한은 최고 권한으로 한 번만 득점한다(G1).\n'
    + '데이터 성과는 별도 득점(G2); 일반 권한/비인가이면 단일 득점을 10 으로 조정한다.'),

  /* 5, 6 메일과 업무 생산 시스템(원본 표의 두 항목이 규칙과 상한을 공유) */
  sp(5, 5, '관리자 100 / 일반 50 점/개', 'web-app', '메일 시스템 / 사무 자동화와 업무 생산 시스템 / 그 밖의 Web 애플리케이션 시스템 권한', 'WEB', 100, 2000, 'system',
    '**관리자 권한 100 점/개, 일반 사용자 권한 50 점/개; 같은 시스템은 최고 권한 점수만 한 번 계산한다**(G1); 이 항목 상한 2000 점(G3).\n'
    + '이 항목은 원본 표의 5·6 항목을 병합한 것이다(규칙과 상한이 완전히 같다), **즉 "Web 애플리케이션 시스템 장악"이라는 분류**다; 득점 기록 시 evidence 에 어느 유형의 시스템인지 명시한다:\n'
    + '· **메일 시스템**;\n'
    + '· **사무 자동화와 업무 생산 시스템**(사무 OA, ERP, 직보 메신저, 재무 시스템, 업무 생산 시스템, 데이터 웨어하우스 등, 장악되거나 마비되면 업계 또는 기관의 업무 생산·운영 관리·일상 사무에 영향을 주는 시스템);\n'
    + '· **그 밖의 Web 애플리케이션 시스템(폴백 분류)**: 자격 증명 목록의 계정으로 **실측 로그인되는** HTTP/HTTPS 사이트 중,'
    + '더 구체적인 다른 득점 항목 분류에 들어가지 않는 것(집권 시스템은 7 항목, 빅데이터 시스템은 8 항목, 클라우드 관리 플랫폼은 11 항목, IoT 관리 플랫폼은 12 항목, 보안 장비는 13 항목 등),'
    + '모두 이 항목으로 득점한다(관리자 100 / 일반 50). **자격 증명에 `host:port` 만 등록되어 있고 시스템 이름이나 업무 귀속이 없는 Web 로그인(백오피스, 관리 콘솔, 운영 플랫폼, 자체 개발 업무 시스템 등)도 이 조항을 따른다** ——'
    + '먼저 더 적합한 분류가 있는지 판단하고, 없으면 "Web 애플리케이션 시스템 장악"으로 넣는다. "메일/OA 인지 알 수 없다"는 이유로 누락하지 마라.'
    + '득점 기록 시 `target` 에 실제 로그인 URL(포트 포함)을 쓰고, evidence 에 "어떤 사이트 + 어떤 계정 + 관리자/일반 등급"을 밝히며, 레드라인 1에 따라 먼저 실측 로그인을 한다.\n'
    + '메일 데이터는 중요도에 따라 다시 별도 득점한다(G2); 일반 사용자 권한이면 단일 득점을 50 으로 조정한다.'),

  /* 7 집권 시스템 */
  sp(7, 6, '관리자 500 / 일반 50 점/개', 'central-system', '집권 시스템 권한(운영 / 신원 / 네트워킹 / 엔드포인트 관리 콘솔)', 'CENTRAL', 500, 4000, 'system',
    '**시스템 관리자 권한 500 점/개, 일반 권한 50 점/개**; 같은 권한은 한 번만 득점한다, 즉 관리자와 일반 권한을 모두 얻어도 관리자 권한 점수만 준다(G1); 이 항목 상한 4000 점(G3).\n'
    + '집권 시스템은 네 가지를 포함한다:\n'
    + '· **운영 집권류**: 배스천 호스트, 중앙 모니터링, 통합 리소스 배포 등;\n'
    + '· **신원 권한 관리류**: SSO, 4A, IAM 등;\n'
    + '· **네트워킹 집권류**: 도메인 컨트롤러, 인증서 인증, SDWAN 통합 컨트롤러 등;\n'
    + '· **엔드포인트/호스트 관리 콘솔류**: 엔드포인트 관리 소프트웨어 백엔드, 제로 트러스트 통제 센터 등.\n'
    + '⚠️ 집권 시스템이 **위탁 관리하는 호스트·엔드포인트 등 장비는 교차 분류로 "일반 시스템 장악"의 점수를 인용한다**(예: PC, 모바일 엔드포인트 10 점/대, G4) ——'
    + '**집권 시스템 최고 등급 500 점으로 계산하지 마라**, 그러면 크게 과대평가된다; 일괄 통제는 증명이 필요하다: 관리 노드 수의 20% 이상, 최대 20대 로그인이면 충분하다.'),

  /* 8 빅데이터 시스템 */
  sp(8, 7, '관리자 1000 / 일반 100 점/개', 'bigdata-system', '빅데이터 시스템 권한', 'BIGDATA', 1000, 4000, 'system',
    '**관리자 권한 1000 점, 일반 권한 100 점/개**; 같은 권한은 한 번만 득점한다, 즉 관리자와 일반 권한을 모두 얻어도 관리자 권한 점수만 준다(G1); 이 항목 상한 4000 점(G3).\n'
    + '데이터는 별도 득점(G2); **유효 데이터량이 5억 건 또는 1TB 미만이면 일반 데이터베이스로 계산한다**(즉 4 항목 점수를 쓴다).'),

  /* 9 네트워크 장비 권한 */
  sp(9, 8, '일반 100 / 관리자 200 / 가산 200·1000 점', 'netdev', '네트워크 장비 권한(방화벽, 라우터, 스위치, 망간 장비, 광간 장비, 반입 장비, VPN 등)', 'NETINFRA', 200, 2000, 'service',
    '**일반 사용자 권한 100 점, 관리자 권한 200 점**; 이 항목 상한 2000 점(G3). 라우팅 테이블 등 증거 또는 연결 수 스크린샷을 제출해야 한다(G7).\n'
    + '같은 장비에서 다음 동작을 해내면 **추가 득점**한다(해낸 등급으로 득점):\n'
    + '· 해당 장비로 **네트워크 리다이렉션 또는 업무 탈취**: +200 점;\n'
    + '· 해당 장비에 **원격 제어 프로그램을 심고 후속 공격까지 성공**: 1000 점.\n'
    + '일반 권한이나 가산 등급이면 단일 득점을 실제 등급에 맞춰 조정한다.'),

  /* 10 산업 인터넷 시스템 */
  sp(10, 9, '관리자 200 / 장비 10 점/개', 'iiot', '산업 인터넷 시스템 권한', 'NETINFRA', 200, 2000, 'system',
    '**관리 콘솔 관리자 권한 200 점; 위탁 관리 중인 연결 장비 10 점/개**(G4); 이 항목 상한 2000 점(G3).\n'
    + '커넥티드카, 스마트 제조, 원격 진단, 지능형 교통 등을 포함한다. 장비를 개수로 누적할 때는 별도의 적중 기록을 쓰고(득점을 10 으로 조정) 기록한다.'),

  /* 11 클라우드 관리 플랫폼 */
  sp(11, 10, '관리자 500 / 노드 10 점/대', 'cloud-platform', '클라우드 관리 플랫폼 제어권(PaaS 클라우드 플랫폼 포함, 예: K8S, Red Hat OpenShift 등)', 'NETINFRA', 500, 2000, 'system',
    '**관리자 권한 500 점; 클라우드 호스트·컨테이너 10 점/대**(G4); 이 항목 상한 2000 점(G3). 클라우드 위의 업무 시스템은 중요 시스템 규칙에 따라 별도 득점한다.\n'
    + 'ak/sk 를 통한 일괄 제어는 기본적으로 **장악한 노드 점수만 계산하고 관리자 점수는 계산하지 않는다**. 관리자 권한을 증명한 경우(예: 클라우드 노드 추가, 사용자 권한 관리 등)는 예외다.\n'
    + '⚠️ **노드 수가 100 미만이면 일반 Web 애플리케이션으로 득점하고 노드 점수는 주지 않는다**(즉 5·6 항목 기준을 따른다).'),

  /* 12 IoT 장비 관리 플랫폼 */
  sp(12, 11, '플랫폼 200 / 연결 지점 10 / 코어망 +5000 점', 'iot-platform', 'IoT 장비 관리 플랫폼 권한', 'NETINFRA', 200, 2000, 'system',
    '**제어 기능이 있는 IoT 플랫폼 200 점; 플랫폼의 연결 지점 수로 10 점/대 계산**(G4); 이 항목 상한 2000 점(G3).\n'
    + '**IoT 엔드포인트 장비를 통해 코어망에 진입해 업무 생산 등 중요 시스템을 장악한 경우 별도로 5000 점을 더한다**(이 항목의 2000 점 상한에 얽매이지 않고 별도 적중으로 기록한다).'),

  /* 13 보안 장비 */
  sp(13, 12, '관리자 200 점', 'secdev', '보안 장비 권한(IPS, IDS, 감사 장비, WAF 등 집권류가 아닌 보안 장비)', 'NETINFRA', 200, 1000, 'service',
    '**관리자 권한 200 점**; 이 항목 상한 1000 점(G3). 집권류가 아닌 보안 장비에만 해당한다(집권류는 7 항목을 따른다).'),

  /* 14 파일 스토리지 계열 시스템 */
  sp(14, 13, '관리자 50 / 일반 10 점/개', 'file-storage', '파일 스토리지 계열 시스템 권한(FTP, 오브젝트 스토리지, 기업 NAS, 기업 네트워크 드라이브 등)', 'STORAGE', 50, 500, 'system',
    '**관리자 권한 50 점/개; 일반 사용자 권한, 빈 시스템 또는 테스트 데이터만 있는 시스템 10 점/개**; 이 항목 상한 500 점(G3).\n'
    + 'FTP, 오브젝트 스토리지(시스템 단위로 득점), 기업 NAS, 기업 네트워크 드라이브 등을 포함한다; 데이터는 별도 득점(G2). 일반 권한이면 단일 득점을 10 으로 조정한다.'),

  /* 15 모델 에이전트 / agent 도구 */
  sp(15, 14, '100–500 점/개', 'ai-agent', '모델 에이전트, skill 등 agent 도구(그리고 agent 를 조작해 공격까지 수행)', 'MODEL', 100, 4000, 'service',
    '**100–500 점/개**, 구간 점수이며 장악과 조작 깊이로 판정한다; 이 항목 상한 4000 점(G3).\n'
    + '모델 에이전트, skill 등 agent 도구를 포함한다; 득점 기록 시 evidence 에 장악/조작 깊이를 밝히고 판정 등급에 맞춰 단일 득점을 조정한다.'),

  /* 16, 17 연산력 관리 플랫폼 + 학습 데이터/지식 베이스 시스템(원본 표의 두 항목은 규칙이 글자 단위로 같다) */
  sp(16, 15, '시스템 관리 권한 500 점/개', 'model-compute', '연산력 관리 플랫폼 권한 / 학습 데이터와 지식 베이스 시스템 권한', 'MODEL', 500, 4000, 'system',
    '**시스템 관리 권한 획득 500 점/개**; 이 항목 상한 4000 점(G3).\n'
    + '이 항목은 원본 표의 16·17 항목을 병합한 것이다(규칙이 글자 단위로 같다), 득점 기록 시 evidence 에 어느 유형의 시스템인지 명시한다:\n'
    + '· **연산력 관리 플랫폼**(연산력 자원을 관리·스케줄링할 수 있다 등);\n'
    + '· **학습 데이터, 지식 베이스 등 관련 시스템**(학습 데이터나 지식 베이스를 탈취·변조하거나 데이터 오염을 실행할 수 있다 등).\n'
    + '대량 데이터 보유 시스템(1억 건 또는 10TB 초과)은 **점수 배증**, 지식 베이스 관련 시스템 장악도 **점수 배증**(G5).'),

  /* 18 모델 관련 데이터 시스템 */
  sp(18, 16, '시스템 관리자 권한 500 점/개', 'model-data', '모델 관련 데이터 시스템 권한', 'MODEL', 500, 4000, 'system',
    '**시스템 관리자 권한 획득 500 점/개**; 이 항목 상한 4000 점(G3).\n'
    + '모델 학습·추론·운영 서비스를 방해하거나 모델 가중치 파일을 탈취·변조할 수 있다.\n'
    + '⚠️ 16·17 항목과의 차이는 **메울 수 없다**: 이 항목에는 **"지식 베이스 관련 시스템 장악 시 점수 배증"이 없고**, 대신 "데이터 자산 성과는 데이터 점수 규정을 참조"(G2)가 있다;'
    + '초대규모 데이터 시스템(1억 건 또는 10TB 초과)은 점수 배증(G5).'),

  /* 19 연산력 인프라(권한과 연산 카드라는 두 가지 과금 단위, 두 항목 유지) */
  sp(19, 17, '관리자 500 점/개', 'computepower-admin', '연산력 인프라 · 관리자 권한', 'MODEL', 500, 2000, 'system',
    '**관리자 권한 500 점/개**; 이 항목 상한 2000 점(경로 점수 포함, G3).\n'
    + '이 항목은 「연산력 인프라 · 연산 카드 자원」과 함께 19 항목에 속하며 2000 점 상한을 공유한다. 세 가지(관리자 권한 / 대량 연산 카드 자원 / 연산 카드 풀링 플랫폼)는 각각 득점할 수 있지만 이 조항의 총 상한을 받는다.'),
  sp(19, 18, '10 점/카드', 'computepower-cards', '연산력 인프라 · 연산 카드 자원 / 연산 카드 풀링 플랫폼', 'MODEL', 10, 2000, 'none',
    '**10 점/카드**, 카드 수로 누적(G4); 대량 연산 카드 자원 확보 득점, 연산 카드 풀링 플랫폼 직접 확보 득점은 각각 상한 2000 점이며, 「관리자 권한」과 함께 19 항목 총 상한 2000 점을 공유한다.\n'
    + '득점 기록 시 evidence 에 카드 수 또는 플랫폼 이름을 명시한다.'),

  /* ══ 2. 네트워크 경계 돌파(4 항목, 목표 단위 전체에서 같은 종류의 경계는 한 번만 득점)══════════ */

  sp(22, 19, '1000 점', 'boundary-logical', '논리 격리 업무 내부망 진입', 'BOUNDARY', 1000, 0, 'target',
    '**1000 점**. 적용 범위: 목표 기관 전체에서 같은 종류의 네트워크 경계 돌파는 한 번만 득점한다.\n'
    + '증명 자료(G7): 방화벽 격리 장비의 제어 스크린샷, 내부망 접근을 증명하는 스크린샷 등.'),
  sp(23, 20, '10000 점', 'boundary-strong', '논리 강격리 업무 내부망 진입', 'BOUNDARY', 10000, 0, 'target',
    '**10000 점**. 적용 범위: 목표 기관 전체에서 같은 종류의 네트워크 경계 돌파는 한 번만 득점한다.\n'
    + '증명 자료(G7): 망간(gap)류 격리 장비의 제어 스크린샷, 내부망 접근을 증명하는 스크린샷 등.'),
  sp(24, 21, '30000 점', 'boundary-physical', '물리 격리 내부망, 핵심 생산망 진입', 'BOUNDARY', 30000, 0, 'target',
    '**30000 점**. 적용 범위: 목표 기관 전체에서 같은 종류의 네트워크 경계 돌파는 한 번만 득점한다.\n'
    + '증명 자료(G7): 방화벽, VPN, 다중 NIC 호스트, 네트워크 장비, 망간(gap)류 격리 장비의 제어 스크린샷, 내부망 접근을 증명하는 스크린샷 등.\n'
    + '예: 철도 관제 전용망, 은행 핵심 계정망, 전력 생산 통제 구역, 통신사 시그널링망, 에너지 생산 IoT 등.'),
  sp(25, 22, '1000 점(최대 3000)', 'boundary-supply', '공급망 운영 채널 또는 클라우드 서비스로 내부망 진입', 'BOUNDARY', 1000, 3000, 'service',
    '세 가지 상황으로 득점한다:\n'
    + '· **같은 주 방어 기관 내부망** 진입: 1000 점;\n'
    + '· **한** 공급망 기관 또는 클라우드 서비스로 **여러** 주 방어 기관 내부망 진입: 주 방어 기관당 1000 점;\n'
    + '· **여러** 공급망 기관 또는 클라우드 서비스로 **한** 주 방어 기관 내부망의 서로 다른 네트워크 구역 진입: 구역당 1000 점, 최대 3000 점.\n'
    + '득점 기록 시 evidence 에 어떤 상황인지, 어느 주 방어 기관/네트워크 구역인지 명시한다.'),

  /* ══ 부가 성과 가산(위의 특정 권한에 딸리지만 **독립 득점, 독립 상한**)══════════
     이 항목들은 "시스템 권한을 하나 더 얻는" 것이 아니라 "이미 얻은 권한 위에서 또 무엇인가를 해낸" 것이다(문서의 +N 점).
     기본 항목 안에 두면 그 rule 상한을 공유해 기본 점수에 먹히므로, 독립 득점 항목으로 나눈다. */

  /* 9 네트워크 장비 가산: 해당 장비로 네트워크 리다이렉션 또는 업무 탈취 +200 점 */
  sp(9, 23, '리다이렉션 / 업무 탈취 +200 점', 'netdev-redirect', '네트워크 장비 · 해당 장비로 네트워크 리다이렉션 또는 업무 탈취', 'NETINFRA', 200, 2000, 'none',
    '**기존 「네트워크 장비 권한」 점수 위에 200 점 추가**(문서 9 항목).\n'
    + '적용: 라우팅/정책을 바꿔 트래픽을 우리가 통제하는 노드로 유도, DNS 탈취, 업무 트래픽 탈취 등 실제로 유효한 리다이렉션.\n'
    + '증거 제출 필요(G7): 라우팅 테이블, 정책 설정 또는 연결 수 스크린샷; evidence 에 리다이렉션 방향과 검증 방법을 밝힌다.'),

  /* 9 네트워크 장비 가산: 장비에 원격 제어 프로그램을 심고 후속 공격까지 성공 1000 점 */
  sp(9, 24, '원격 제어 심기 + 후속 공격 1000 점', 'netdev-implant', '네트워크 장비 · 원격 제어 프로그램을 심고 후속 공격까지 성공', 'NETINFRA', 1000, 2000, 'none',
    '**기존 「네트워크 장비 권한」 점수 위에 1000 점 추가**(문서 9 항목).\n'
    + '「심기 성공 **그리고** 그것으로 후속 공격 완료」 두 가지를 증명해야 한다: 원격 제어 프로세스/지속성 증거 + 해당 장비를 경유한 후속 성과.'),

  /* 12 IoT: 엔드포인트 장비로 코어망에 진입해 업무 생산 등 중요 시스템을 장악, 별도 5000 점 */
  sp(12, 25, '코어망 +5000 점', 'iot-corenet', 'IoT · 엔드포인트 장비로 코어망에 진입해 중요 시스템 장악', 'NETINFRA', 5000, 5000, 'none',
    '**문서 12 항목이 명시한 「별도로 5000 점 추가」**, 그 조항의 2000 점 상한을 차지하지 않는다.\n'
    + '적용: IoT 엔드포인트 장비에서 코어망으로 횡적 이동해 업무 생산 등 중요 시스템을 장악;\n'
    + 'evidence 에 밝힌다: 어느 엔드포인트에서 진입했는지, 코어망에서 어떤 시스템을 장악했는지, 어떤 권한을 얻었는지.'),
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
