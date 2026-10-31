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
  'target-outbound': '目标主动连出（反弹 shell / 目标上跑 frp 客户端）',
  'target-http': '经目标 WebShell/HTTP 通道（suo5 / Neo-ReGeorg）',
  'target-agent': '经目标已控进程/会话转发（SSH -R 等）',
  'self-only': '只在自己 VPS/自建服务器上（不算突破）',
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
  if (authority === null) return hit.target ? String(hit.target) : '(未标注服务)'
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
  if (ipv6) { multiplier *= 3; reasons.push("G6 IPv6 成果 ×3") }
  const scale = String(hit.data_scale || "").trim().toLowerCase()
  if (scale === "large") { multiplier *= 2; reasons.push("G5 数据规模超 1 亿条 / 10TB ×2") }
  else if (scale === "knowledge-base" || scale === "kb") { multiplier *= 2; reasons.push("G5 控制知识库相关系统 ×2") }
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
    return '「' + label + '」这条不计分：'
      + (hit.rule === null || hit.rule === undefined ? '' : '规则 ' + hit.rule + ' ')
      + '的**累计得分已达该规则上限（' + (Number(hit.rule_cap) || 0) + ' 分）**——同一规则超出上限的部分不再累加。'
      + '把精力换到别的规则或别的资产上，不要在已达上限的规则里继续刷。'
  }
  return '「' + label + '」这个目标上的权限已经拿满（计分口径：同一目标只算分值最高的那条'
    + (bestPoints === undefined || bestPoints === null ? '' : '，+' + bestPoints + ' 分')
    + '）——这条按规则不再计分，只作过程留痕；**换目标或换规则推进，不要在同一个目标上刷同类成果**。'
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
    need: '目标域名解析记录被改为我方可控（NS/A 记录生效），或域名管理后台可操作',
    proof: '管理后台截图 + 改记录前后的 dig/nslookup 对比',
    replay: 'nslookup <域名> <我方 NS>；或后台操作请求原文',
    script: 'dig NS <域名> @8.8.8.8\ndig <域名> @<我方NS>',
  },
  'terminal-access': {
    need: '能对终端下发指令并取回执行结果（不是"发现了一台设备"）',
    proof: '被控终端执行 id/hostname 的回显 + 与目标单位的关系证明（G7）',
    replay: '远控会话里执行 id；或木马/远控的 agent 上线记录',
    script: 'id; whoami; hostname',
  },
  'server-host': {
    need: '在主机上执行了命令并拿到回显（WebShell / 反弹 Shell / 远控均可）',
    proof: '命令回显（id / hostname）+ WebShell 连接要素或会话记录',
    replay: 'WebShell 请求原文（可直接重放）；或反弹 Shell 的监听记录',
    script: 'id; uname -a; cat /etc/passwd | head',
  },
  'db-credential': {
    need: '用账号成功连上数据库并执行了查询（未授权访问也算：能连上即成立）',
    proof: '登录成功后的查询回显（select user(), version()）+ 账号权限级别',
    replay: 'mysql -h <host> -P <port> -u <user> -p\'<pass>\' -e "select user(),version()"',
    script: 'mysql -h <host> -u <user> -p -e "select user(),version(),current_user()"',
  },
  'web-app': {
    need: '以目标已有账号登录进系统（普通或管理员），并访问了受保护页面',
    proof: '登录后的页面内容/回显 + 会话 Cookie 或 Token（证明不是只拿到口令）',
    replay: '登录请求原文（含见证 Cookie/Token）+ 一次带会话的受保护页面请求',
    script: 'curl -i -s -X POST <登录URL> -d "username=<u>&password=<p>" -c cookie.txt\ncurl -s -b cookie.txt <受保护页面>',
  },
  'central-system': {
    need: '登录进堡垒机/域控/SSO/终端管理后台等集权系统并取得管理权限',
    proof: '管理后台页面截图 + 能体现"可管控下属节点"的操作（登录 20% 托管节点或 20 台）',
    replay: '登录请求原文 + 一次管控操作（如列举托管主机）的请求与响应',
    script: 'curl -s -b cookie.txt "<管控列表接口>"',
  },
  'bigdata-system': {
    need: '获得大数据平台（Hadoop/Spark/ES 等）管理或普通权限',
    proof: '平台管理页/接口回显 + 可访问的数据规模（条数或容量）',
    replay: '平台接口请求原文（如 ES _cat/indices、YARN /ws/v1/cluster/apps）',
    script: 'curl -s "<平台接口>" | head -50',
  },
  netdev: {
    need: '登录网络设备（防火墙/路由器/交换机/VPN/网闸）并取得权限',
    proof: '设备管理页截图 + 路由表或连接量截图（G7 明确要求）',
    replay: '设备登录请求原文 + 读取路由表的命令回显',
    script: 'show ip route    # 或 display ip routing-table',
  },
  'netdev-redirect': {
    need: '借助该设备实际改变了流量走向（策略/路由/DNS 改动生效）',
    proof: '改动前后的路由表或策略对比 + 我方节点收到流量的证据',
    replay: '策略配置请求原文 + 我方可控节点上的抓包/访问日志',
    script: 'tcpdump -ni any port <端口> -c 10',
  },
  'netdev-implant': {
    need: '设备上植入了可执行的远控/持久化，**并且**借助它完成了后续攻击',
    proof: '远控进程或持久化项的证据 + 经该设备发起的后续成果记录',
    replay: '植入动作的请求/命令原文 + 后续经由该设备的访问日志',
    script: '',
  },
  iiot: {
    need: '获得工业互联网系统管理权限，或批量控制其下的互联设备',
    proof: '管理后台截图 + 被控设备清单与数量',
    replay: '登录请求原文 + 设备列表接口响应',
    script: '',
  },
  'cloud-platform': {
    need: '云管理平台管理员权限；或通过 ak/sk 批量控制云上节点（≥100 个才计节点分）',
    proof: '平台管理页截图；ak/sk 场景需给出被控节点清单与数量、或管理员证明（新增节点/改权限）',
    replay: '平台接口请求原文（列举实例、创建用户等）',
    script: 'curl -s -H "Authorization: Bearer <token>" "<平台/实例列表接口>"',
  },
  'iot-platform': {
    need: '获得物联网管控平台权限，或按其连接点批量控制设备',
    proof: '平台管理页截图 + 连接点/设备数量',
    replay: '平台登录与设备列表接口原文',
    script: '',
  },
  'iot-corenet': {
    need: '从物联网端点设备横向进入核心网，并控制了业务生产等重要系统',
    proof: '路径说明（哪个端点→核心网→哪个系统）+ 该系统的控制证据',
    replay: '从端点发起的横向动作命令 + 核心网系统的登录/操作请求',
    script: '',
  },
  secdev: {
    need: '获得非集权类安全设备（IPS/IDS/审计/WAF）管理员权限',
    proof: '设备管理页截图 + 能体现策略可控的操作',
    replay: '登录请求原文 + 一条策略读取接口响应',
    script: '',
  },
  'file-storage': {
    need: '获得文件存储系统后台权限（FTP/NAS/网盘/对象存储），或拿到其普通账号',
    proof: '目录列举截图 + 可读文件清单（数据成果另有计分，见 G2）',
    replay: '列举目录的请求原文（FTP LIST / S3 ListObjects / WebDAV PROPFIND）',
    script: 'curl -s "<存储接口>" | head -50',
  },
  'ai-agent': {
    need: '控制模型智能体/skill 等 agent 工具，并**实际驱动它执行了动作**',
    proof: '对话或调用记录 + 被驱动执行的动作与其结果（区间分按控制深度研判）',
    replay: '驱动 agent 的请求原文 + 它执行动作的回显',
    script: '',
  },
  'model-compute': {
    need: '获得算力管理平台/训练数据与知识库系统的系统管理权限',
    proof: '管理后台截图 + 能体现算力调度或数据可读写的操作',
    replay: '平台登录与调度/数据接口原文',
    script: '',
  },
  'model-data': {
    need: '获得模型相关数据系统管理员权限（可影响训练/推理/运营或窃取篡改权重）',
    proof: '管理后台截图 + 可读写的模型/数据集清单',
    replay: '平台接口原文（列举模型、下载权重）',
    script: '',
  },
  'computepower-admin': {
    need: '获得算力基础设施管理员权限',
    proof: '管理后台截图 + 可调度资源证明',
    replay: '平台登录与资源列表接口原文',
    script: '',
  },
  'computepower-cards': {
    need: '实际取得算力卡资源（10 分/卡）或卡池化平台控制权',
    proof: '卡资源清单（数量）+ 能提交任务或独占卡的证据',
    replay: 'nvidia-smi 回显 / 平台卡列表接口',
    script: 'nvidia-smi -L',
  },
  'boundary-logical': {
    need: '从靶标侧建立了通往内网的通道，并能**实际访问内网目标**',
    proof: '隧道登记（入口必须是目标侧）+ 经隧道访问内网目标的回显/截图（G7）',
    replay: '经隧道访问内网目标的那条命令与回显；隧道搭建命令',
    script: 'curl --socks5-hostname 127.0.0.1:<端口> http://<内网IP>/ -i',
  },
  'boundary-strong': {
    need: '突破网闸类强隔离，进入强隔离业务内网并实际访问到内网目标',
    proof: '网闸类隔离设备的控制截图 + 能访问内网的截图证明（G7）',
    replay: '经强隔离通道访问内网目标的命令与回显',
    script: '',
  },
  'boundary-physical': {
    need: '突破物理隔离/进入核心生产网并实际访问到目标',
    proof: '防火墙/VPN/多网卡主机/网闸的控制截图 + 能访问内网的截图（G7）',
    replay: '进入核心网后访问目标的命令与回显',
    script: '',
  },
  'boundary-supply': {
    need: '借助供应链运维通道或云服务进入主防单位内网（按情形分别计分）',
    proof: '供应链/云侧的控制证据 + 进入主防单位内网的证明；写明属于哪种情形',
    replay: '从供应链通道进入内网的命令与回显',
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
  { code: 'G1', name: '权限取高、只计一次', detail: '同一系统、同一主机、同一数据库上取得多种权限时，只按最高权限计一次分（既获取管理员又获取普通权限的，只给管理员权限分）。' },
  { code: 'G2', name: '数据成果另行计分', detail: '邮件数据、业务数据、数据资产等成果按数据重要程度单独计分，不与权限分混算。' },
  { code: 'G3', name: '上限口径', detail: '各项分值上限针对单个防守单位及其所有下属机构，达到上限后不再累计。' },
  { code: 'G4', name: '设备/终端按台（个）计分', detail: '打印机、wifi 路由器 5 分/台；PC、Pad、手机、摄像头、电子大屏 10 分/台；云上主机、容器、托管互联设备、物联网连接点等按 10 分/台（个）。批量控制按"被控节点"折算。' },
  { code: 'G5', name: '数据规模翻倍', detail: '含大量数据系统（重要数据量超 1 亿条或 10TB）得分翻倍；控制知识库相关系统得分翻倍。不含系统产生的普通日志数据。' },
  { code: 'G6', name: 'IPv6 倍数', detail: '利用 IPv6 取得的成果分数 ×3，但上限仍按对应系统类型的原上限计算，不因倍数突破上限。' },
  { code: 'G7', name: '证明材料', detail: '突破网络边界须提供隔离设备控制截图、能访问内网的截图证明等；控制的手机、Pad 等终端设备应能证明与目标单位的关系；网络设备权限需提供路由表等证据或连接量截图。' },
  { code: 'G8', name: '兜底条款', detail: '其他系统、服务器、设备等权限不预设分值，由专项组研判后给分。' },
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
  { code: 'GENERAL', name: '控制一般系统' },
  { code: 'WEB', name: '控制 Web 应用系统' },
  { code: 'CENTRAL', name: '控制集权系统' },
  { code: 'BIGDATA', name: '控制大数据系统' },
  { code: 'NETINFRA', name: '控制网络基础设施' },
  { code: 'STORAGE', name: '文件存储类系统' },
  { code: 'MODEL', name: '控制模型相关系统' },
  { code: 'BOUNDARY', name: '突破网络边界' },
]

export const DEFAULT_SCORE_POINTS = [
  /* ══ 1. 권한 획득(18 개)══════════════════════════════════════════════ */

  /* 1 域名控制权限 */
  sp(1, 1, '一级 50 / 二级 20 分/个', 'domain-control', '域名控制权限', 'GENERAL', 50, 400, 'system',
    '**一级域名 50 分/个，二级域名 20 分/个**，按域名类型给分；本项上限 400 分（G3）。\n'
    + '记分时在 evidence 里写明域名与其类型；拿到二级域名时把单次分值调整为 20。'),

  /* 2 终端权限 */
  sp(2, 2, '5 / 10 分/台', 'terminal-access', '终端权限（手机、Pad、PC、打印机、摄像头、wifi 路由器等）', 'GENERAL', 10, 600, 'system',
    '**打印机、wifi 路由器 5 分/台；PC、Pad、手机、摄像头、电子大屏 10 分/台**（G4），按台累加；本项上限 600 分（G3）。\n'
    + '控制的终端设备需能证明与目标单位的关系（G7）；拿到 5 分档设备时把单次分值调整为 5。\n'
    + '钓鱼获取的终端同样按本项计分，在 evidence 里写明目标人员角色（普通办公 / IT 运维 / 业务运营）。'),

  /* 3 服务器主机权限 */
  sp(3, 3, '普通 10 / 管理员 50 分/个', 'server-host', '服务器主机权限（含 webshell 权限）', 'GENERAL', 50, 600, 'system',
    '**普通权限 10 分/个，管理员权限 50 分/个**；本项上限 600 分（G3）。\n'
    + '同一主机只按最高权限计一次（G1）——拿到 root/SYSTEM 后同主机不再累加普通权限。\n'
    + '获取 1 台服务器主机不扣分；拿到普通权限时把单次分值调整为 10。'),

  /* 4 数据库连接账号密码 */
  sp(4, 4, '普通 10 / 管理员 50 / 未授权 10 分/个', 'db-credential', '数据库连接账号密码（含 SQL 注入）', 'GENERAL', 50, 400, 'system',
    '**普通用户权限 10 分/个，管理员权限 50 分/个；redis 和其他空密码、未授权访问成果统一 10 分/个**；本项上限 400 分（G3）。\n'
    + '同一数据库的同等权限（含管理员）只得一次分；同一主机上的系统权限、应用权限、数据库权限按最高权限只得一次分（G1）。\n'
    + '数据成果单独计分（G2）；拿到普通权限/未授权时把单次分值调整为 10。'),

  /* 5、6 邮箱与业务生产系统（原表两项共用规则与上限） */
  sp(5, 5, '管理员 100 / 普通 50 分/个', 'web-app', '邮箱系统 / 办公自动化与业务生产系统 / 其他 Web 应用系统权限', 'WEB', 100, 2000, 'system',
    '**管理员权限 100 分/个，普通用户权限 50 分/个；同一个系统只计算一次最高权限分**（G1）；本项上限 2000 分（G3）。\n'
    + '本项合并原表第 5、6 项（规则与上限完全相同），**即"控制 Web 应用系统"这一类**；记分时在 evidence 里写明是哪类系统：\n'
    + '· **邮箱系统**；\n'
    + '· **办公自动化与业务生产系统**（办公 OA、ERP、直报即时通讯、财务系统、业务生产系统、数据仓库等被控或瘫痪后影响行业或单位业务生产、运行管理、日常办公的系统）；\n'
    + '· **其他 Web 应用系统（兜底归类）**：用凭据清单里的账号**实测能登录**的 HTTP/HTTPS 站点，'
    + '凡不归入其他更具体的得分点类别（集权系统走第 7 项、大数据系统走第 8 项、云管理平台走第 11 项、物联网管控平台走第 12 项、安全设备走第 13 项等），'
    + '统一按本项计分（管理员 100 / 普通 50）。**凭据里只登记了 `host:port`、没写系统名或业务归属的 Web 登录（后台、管理端、运营平台、自研业务系统等）也走这一条**——'
    + '先判是否有更贴切的类别，没有就归入"控制 Web 应用系统"，不因"看不出是不是邮箱/OA"而漏记。'
    + '记分时 `target` 写实际登录 URL（带端口），evidence 写清"什么站点 + 什么账号 + 管理员/普通档"，并按红线一先实测登录。\n'
    + '邮件数据按重要程度再单独计分（G2）；拿到普通用户权限时把单次分值调整为 50。'),

  /* 7 集权系统 */
  sp(7, 6, '管理员 500 / 普通 50 分/个', 'central-system', '集权系统权限（运维 / 身份 / 组网 / 终端管理后台）', 'CENTRAL', 500, 4000, 'system',
    '**系统管理员权限 500 分/个，普通权限 50 分/个**；同一权限只给一次分，即获取管理员和普通权限只给管理员权限分（G1）；本项上限 4000 分（G3）。\n'
    + '集权系统包括四类：\n'
    + '· **运维集权类**：堡垒机、集中监控、统一资源发布等；\n'
    + '· **身份权限管理类**：SSO、4A、IAM 等；\n'
    + '· **组网集权类**：域控、证书认证、SDWAN 统一控制器等；\n'
    + '· **终端主机管理后台类**：终端管理软件后台、零信任控制中心等。\n'
    + '⚠️ 集权系统**托管的主机、终端等设备跨类引用"控制一般系统"的分值**（如 PC、移动终端 10 分/台，G4）——'
    + '**不要按集权系统最高档 500 分算**，那会严重偏高；批量控制需提供证明：至少登录托管节点数量的 20%，最多登录 20 台即可。'),

  /* 8 大数据系统 */
  sp(8, 7, '管理员 1000 / 普通 100 分/个', 'bigdata-system', '大数据系统权限', 'BIGDATA', 1000, 4000, 'system',
    '**管理员权限 1000 分，普通权限 100 分/个**；同一权限只给一次分，既获取管理员和普通权限只给管理员权限分（G1）；本项上限 4000 分（G3）。\n'
    + '数据单独计分（G2）；**有效数据量小于 5 亿条或 1TB 的按普通数据库计算**（即改用第 4 项分值）。'),

  /* 9 网络设备权限 */
  sp(9, 8, '普通 100 / 管理员 200 / 加成 200·1000 分', 'netdev', '网络设备权限（防火墙、路由器、交换机、网闸、光闸、摆渡机、VPN 等）', 'NETINFRA', 200, 2000, 'service',
    '**普通用户权限 100 分，管理员权限 200 分**；本项上限 2000 分（G3）。需提供路由表等证据或连接量截图（G7）。\n'
    + '在同一台设备上做到下列动作**再加分**（按做到的那一档记分）：\n'
    + '· 借助该设备进行**网络重定向或业务劫持**：+200 分；\n'
    + '· 在该设备上**植入远控程序并成功进行后续攻击**：1000 分。\n'
    + '拿到普通权限或加成分时，把单次分值按实际档位调整。'),

  /* 10 工业互联网系统 */
  sp(10, 9, '管理员 200 / 设备 10 分/个', 'iiot', '工业互联网系统权限', 'NETINFRA', 200, 2000, 'system',
    '**管理后台管理员权限 200 分；托管的互联设备 10 分/个**（G4）；本项上限 2000 分（G3）。\n'
    + '含车联网、智能制造、远程诊断、智能交通等。设备按个累加时用另起的命中记录（分值调为 10）。'),

  /* 11 云管理平台 */
  sp(11, 10, '管理员 500 / 节点 10 分/台', 'cloud-platform', '云管理平台控制权（含 PaaS 云平台，如 K8S、红帽 OpenShift 等）', 'NETINFRA', 500, 2000, 'system',
    '**管理员权限 500 分；云上主机、容器 10 分/台**（G4）；本项上限 2000 分（G3）。云上业务系统按重要系统规则单独计分。\n'
    + '通过 ak/sk 批量控制默认**只计算被控节点分数、不计算管理员分数**，除非提供证明具有管理员权限（如新增云上节点、用户权限管理等）。\n'
    + '⚠️ **节点数量小于 100 的按普通 Web 应用给分，节点不给分**（即走第 5、6 项口径）。'),

  /* 12 物联网设备管控平台 */
  sp(12, 11, '平台 200 / 连接点 10 / 核心网 +5000 分', 'iot-platform', '物联网设备管控平台权限', 'NETINFRA', 200, 2000, 'system',
    '**带控制功能的物联网平台 200 分；按平台上连接点数计算 10 分/台**（G4）；本项上限 2000 分（G3）。\n'
    + '**通过物联网端点设备打入核心网并控制业务生产等重要系统的，单独加 5000 分**（不受本项 2000 分上限约束，单独记一条命中）。'),

  /* 13 安全设备 */
  sp(13, 12, '管理员 200 分', 'secdev', '安全设备权限（IPS、IDS、审计设备、WAF 等非集权类安全设备）', 'NETINFRA', 200, 1000, 'service',
    '**管理员权限 200 分**；本项上限 1000 分（G3）。仅限非集权类安全设备（集权类走第 7 项）。'),

  /* 14 文件存储类系统 */
  sp(14, 13, '管理员 50 / 普通 10 分/个', 'file-storage', '文件存储类系统权限（FTP、对象存储、企业 NAS、企业网盘等）', 'STORAGE', 50, 500, 'system',
    '**管理员权限 50 分/个；普通用户权限、空系统或只含有测试数据的系统 10 分/个**；本项上限 500 分（G3）。\n'
    + '含 FTP、对象存储（按系统计分）、企业 NAS、企业网盘等；数据单独计分（G2）。拿到普通权限时把单次分值调整为 10。'),

  /* 15 模型智能体 / agent 工具 */
  sp(15, 14, '100–500 分/个', 'ai-agent', '模型智能体、skill 等 agent 工具（并能操作 agent 进行攻击）', 'MODEL', 100, 4000, 'service',
    '**100–500 分/个**，区间分，按控制与操作深度研判；本项上限 4000 分（G3）。\n'
    + '含模型智能体、skill 等 agent 工具；记分时在 evidence 里写明控制/操作深度，并按研判档位调整单次分值。'),

  /* 16、17 算力管理平台 + 训练数据/知识库系统（原表两项规则逐字相同） */
  sp(16, 15, '系统管理权限 500 分/个', 'model-compute', '算力管理平台权限 / 训练数据与知识库系统权限', 'MODEL', 500, 4000, 'system',
    '**获取系统管理权限 500 分/个**；本项上限 4000 分（G3）。\n'
    + '本项合并原表第 16、17 项（规则逐字相同），记分时在 evidence 里写明是哪类系统：\n'
    + '· **算力管理平台**（可管控调度算力资源等）；\n'
    + '· **训练数据、知识库等相关系统**（可窃取篡改训练数据或知识库、实施数据投毒等）。\n'
    + '含大量数据系统（超 1 亿条或 10TB）**得分翻倍**、控制知识库相关系统**得分翻倍**（G5）。'),

  /* 18 模型相关数据系统 */
  sp(18, 16, '系统管理员权限 500 分/个', 'model-data', '模型相关数据系统权限', 'MODEL', 500, 4000, 'system',
    '**获取系统管理员权限 500 分/个**；本项上限 4000 分（G3）。\n'
    + '可干扰模型训练、推理、运营服务，窃取篡改模型权重文件等。\n'
    + '⚠️ 与第 16、17 项的差异**不可抹平**：本项**没有"控制知识库相关系统得分翻倍"**，但有"数据资产成果参照数据评分"（G2）；'
    + '超大数据规模系统（超 1 亿条或超 10TB）得分翻倍（G5）。'),

  /* 19 算力基础设施（权限与算力卡两种计费单位，保留两条） */
  sp(19, 17, '管理员 500 分/个', 'computepower-admin', '算力基础设施 · 管理员权限', 'MODEL', 500, 2000, 'system',
    '**管理员权限 500 分/个**；本项上限 2000 分（含路径分，G3）。\n'
    + '本项与「算力基础设施 · 算力卡资源」同属第 19 项、共用 2000 分上限，三项（管理员权限 / 大量算力卡资源 / 算力卡池化平台）可分别得分但受本条总上限约束。'),
  sp(19, 18, '10 分/卡', 'computepower-cards', '算力基础设施 · 算力卡资源 / 算力卡池化平台', 'MODEL', 10, 2000, 'none',
    '**10 分/卡**，按卡累加（G4）；获取大量算力卡资源得分、获取算力卡池化平台直接得分，各上限 2000 分，且与「管理员权限」共用第 19 项总上限 2000 分。\n'
    + '记分时在 evidence 里写明卡数或平台名称。'),

  /* ══ 2. 네트워크 경계 돌파(4 항목, 목표 단위 전체에서 같은 종류의 경계는 한 번만 득점)══════════ */

  sp(22, 19, '1000 分', 'boundary-logical', '进入逻辑隔离业务内网', 'BOUNDARY', 1000, 0, 'target',
    '**1000 分**。适用范围：整个目标单位突破同一类网络边界只给一次分。\n'
    + '证明材料（G7）：防火墙隔离设备的控制截图、能访问内网的截图证明等。'),
  sp(23, 20, '10000 分', 'boundary-strong', '进入逻辑强隔离业务内网', 'BOUNDARY', 10000, 0, 'target',
    '**10000 分**。适用范围：整个目标单位突破同一类网络边界只给一次分。\n'
    + '证明材料（G7）：网闸类隔离设备的控制截图、能访问内网的截图证明等。'),
  sp(24, 21, '30000 分', 'boundary-physical', '进入物理隔离内网、核心生产网', 'BOUNDARY', 30000, 0, 'target',
    '**30000 分**。适用范围：整个目标单位突破同一类网络边界只给一次分。\n'
    + '证明材料（G7）：防火墙、VPN、多网卡主机、网络设备、网闸类隔离设备的控制截图，能访问内网的截图证明等。\n'
    + '如铁路调度专网、银行核心账务网、电力生产控制大区、运营商信令网、能源生产物联网等。'),
  sp(25, 22, '1000 分（最多 3000）', 'boundary-supply', '借助供应链运维通道或云服务进入内网', 'BOUNDARY', 1000, 3000, 'service',
    '按三种情形计分：\n'
    + '· 进入**同一主防单位内网**：1000 分；\n'
    + '· 借助**一家**供应链单位或云服务进入**多家**主防单位内网：1000 分/每家主防单位；\n'
    + '· 借助**多家**供应链单位或云服务进入**一家**主防单位内网不同网络区域：1000 分/个，最多 3000 分。\n'
    + '记分时在 evidence 里写明属于哪种情形、涉及哪家主防单位/哪个网络区域。'),

  /* ══ 부가 성과 가산(위의 특정 권한에 딸리지만 **독립 득점, 독립 상한**)══════════
     이 항목들은 "시스템 권한을 하나 더 얻는" 것이 아니라 "이미 얻은 권한 위에서 또 무엇인가를 해낸" 것이다(문서의 +N 점).
     기본 항목 안에 두면 그 rule 상한을 공유해 기본 점수에 먹히므로, 독립 득점 항목으로 나눈다. */

  /* 9 网络设备加成：能够借助该设备进行网络重定向或业务劫持 +200 分 */
  sp(9, 23, '重定向 / 业务劫持 +200 分', 'netdev-redirect', '网络设备 · 借助该设备进行网络重定向或业务劫持', 'NETINFRA', 200, 2000, 'none',
    '**在原「网络设备权限」分之上另加 200 分**（文档第 9 项）。\n'
    + '适用：改路由/策略把流量引向我方可控节点、DNS 劫持、业务流量劫持等实际生效的重定向。\n'
    + '需要提供证据（G7）：路由表、策略配置或连接量截图；evidence 里写清重定向方向与验证方式。'),

  /* 9 网络设备加成：能在设备上植入远控程序并成功进行后续攻击 1000 分 */
  sp(9, 24, '植入远控 + 后续攻击 1000 分', 'netdev-implant', '网络设备 · 植入远控程序并成功进行后续攻击', 'NETINFRA', 1000, 2000, 'none',
    '**在原「网络设备权限」分之上另加 1000 分**（文档第 9 项）。\n'
    + '需要证明「植入成功 **且** 借它完成了后续攻击」两件事：远控进程/持久化证据 + 经该设备发起的后续成果。'),

  /* 12 物联网：通过端点设备打入核心网并控制业务生产等重要系统，单独加 5000 分 */
  sp(12, 25, '核心网 +5000 分', 'iot-corenet', '物联网 · 经端点设备打入核心网并控制重要系统', 'NETINFRA', 5000, 5000, 'none',
    '**文档第 12 项明确「单独加 5000 分」**，不占该条 2000 分的上限。\n'
    + '适用：从物联网端点设备横向进入核心网，并控制业务生产等重要系统；\n'
    + 'evidence 里写清：从哪个端点进、核心网里控了什么系统、拿到了什么权限。'),
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
