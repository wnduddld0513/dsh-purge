/**
 * RedTeam 자산 라이브러리 코어(Cordis 의존성 없음)
 *
 * 여기서는 세 가지만 합니다: 대상 워크스페이스(디렉터리 + 메타데이터), SQLite 팩트 DB(schema/쓰기/조회),
 * 프롬프트와 스킬 라이브러리 파일 읽기/쓰기.Cordis 플러그인 셸은 ./index.js, 명령줄 셸은 ../bin/cli.mjs;
 * 두 곳이 이 모듈을 공유하므로"UI에서 보이는 것", "에이전트가 조회한 것", "명령줄에서 검증한 것"이 동일한 구현임을 보장합니다.
 */
import { DatabaseSync } from 'node:sqlite'
import { connect as tcpConnect } from 'node:net'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import {
  mkdirSync, readFileSync, writeFileSync, readdirSync, existsSync, rmSync, statSync,
  copyFileSync,
} from 'node:fs'
import { join, basename, isAbsolute } from 'node:path'

/* ── 분리한 모듈(외부 API 불변: 아래에서 그대로 다시 내보냅니다)──────────────
   동기는 "파일 하나가 5600줄이라 테이블 구조를 고치려면 500줄의 점수 계산 로직을 넘어야 함"입니다:
   · ip-utils.js    IP / 네트워크 대역 / slug / 타임스탬프 등 순수 함수;
   · schema.js      두 테이블의 DDL 과 두 곳의 증분 마이그레이션;
   · validate.js    DB 기록 전 검증과 정규화(경로 트래버설, 잘못된 열거값);
   · score-rules.js 점수 산정 기준과 기본 점수 항목(패널/보고서/공격 체인이 공유하는 유일한 구현). */
import {
  ipToInt, cidrOf, isIpv6, expandIpv6, scopeOfIp, slugify, slugTarget, slugPoc,
  defaultPocFilename, nowIso,
} from './ip-utils.js'
import {
  buildHttpRequest, buildCurlCommand, parseCurl, commandKind, parseTarget, fillTemplate,
} from './report-replay.js'
import {
  DDL, KNOWLEDGE_DDL, ASSET_FTS_DDL, POC_FTS_DDL, HAS_FTS5,
  POC_CATEGORIES, pocCategoryName, guessPocCategory,
  migrate, migrateKnowledge,
} from './schema.js'
import {
  WEBSHELL_TYPES, WEBSHELL_STATUSES, normalizeShellType, normalizeShellStatus, assertPathWithin,
} from './validate.js'
import {
  TUNNEL_ENTRY_KINDS, tunnelIsLegit, ACCOUNT_POINT_CODES, SERVICE_CAPPED_POINT_CODES,
  parseTargetPort, scoreServiceKey, serviceLabel, applyScoreCaps, scoreCapReasonText,
  serviceCapReason, evaluateScoreBoard, loadScoreMeta, loadAssetNames, hitPointsOf,
  scoreMultiplierOf, SENSITIVE_DATA_MIN_ROWS, parseRowCount, formatRows,
  DEDUP_SCOPES, SCORE_GENERAL_RULES, SCORE_GROUPS, DEFAULT_SCORE_POINTS, scoreConfirmOf, SCORE_CONFIRM,
  /* 내부 보조: 원래 core.js 의 모듈 수준 함수였고, 분리 후에는 score-rules.js 가 제공 */
  normalizePort, targetAuthority, systemKeyOf, pickBestHit, legacyCapGroup, targetHasIpv6Host,
} from './score-rules.js'
import {
  platformSummary, savePlatformConfig, assignToolkitFolder, loadPlatformConfig, nucleiTemplatesDirOf,
} from './platform-config.js'

/* 재내보내기: core.js 의 외부 내보내기 면은 분리 전과 완전히 동일 (호출 측 변경 없음) */
export {
  ipToInt, cidrOf, isIpv6, expandIpv6, scopeOfIp, slugify, slugTarget, slugPoc,
  defaultPocFilename, nowIso,
  DDL, KNOWLEDGE_DDL, ASSET_FTS_DDL, POC_FTS_DDL, HAS_FTS5,
  POC_CATEGORIES, pocCategoryName, guessPocCategory,
  migrate, migrateKnowledge,
  WEBSHELL_TYPES, WEBSHELL_STATUSES, normalizeShellType, normalizeShellStatus, assertPathWithin,
  TUNNEL_ENTRY_KINDS, tunnelIsLegit, ACCOUNT_POINT_CODES, SERVICE_CAPPED_POINT_CODES,
  parseTargetPort, scoreServiceKey, serviceLabel, applyScoreCaps, scoreCapReasonText,
  serviceCapReason, evaluateScoreBoard, loadScoreMeta, loadAssetNames, hitPointsOf,
  scoreMultiplierOf, SENSITIVE_DATA_MIN_ROWS, parseRowCount, formatRows,
  DEDUP_SCOPES, SCORE_GENERAL_RULES, SCORE_GROUPS, DEFAULT_SCORE_POINTS, scoreConfirmOf, SCORE_CONFIRM,
  normalizePort, targetAuthority, systemKeyOf, pickBestHit, legacyCapGroup, targetHasIpv6Host,
}

/* ------------------------------------------------------------------ 역할과 열거형 */
/**
 * 작전 역할 (6개). 역할 code 는 다음에 동시에 쓰입니다:
 *   · 역할 프롬프트 파일 `engagements/<대상>/agents/<code>.md`
 *   · 공격 단계/취약점/자격 증명의 `agent` 컬럼 (보고서에 "이 항목을 누가 했는지"를 명확히 써야 합니다)
 *   · 메인 세션에서 작업을 배분할 때의 역할 선택
 * `plan` 은 메인 세션(지휘) 자신이며, 배분되지 않고, 프롬프트 패널에서 인물 설정을 확인/미세 조정할 때만 쓰입니다.
 */
const ROLE_TITLES = {
  plan: "Main session (command)",
  recon: "Reconnaissance",
  assess: "Asset assessment",
  'vuln-scan': "Vulnerability discovery",
  exploit: "Exploitation",
  internal: "Internal penetration",
}

/** 취약점 심각도 (표시 우선순위 순으로 정렬). */
const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info']

/** 취약점 처리 상태. */
const VULN_STATUSES = ['candidate', 'confirmed', 'false-positive', 'exploited', 'fixed']

export { ROLE_TITLES, SEVERITIES, VULN_STATUSES }

/* ------------------------------------------------------------------ schema */


/* ------------------------------------------------------------------ 지식 베이스 (POC/EXP, 전역 공유) */


/**
 * 지식 베이스 분류(점수 항목/공격 표면 기준과 정렬): 에이전트가 채워 넣을 때 반드시 하나를 골라야 하며,
 * 패널이 이 값을 기준으로 그룹화해야 사용자가 수백 개를 평면 나열하는 대신 "분류별로" 볼 수 있습니다.
 */
/* ------------------------------------------------------------------ 지식 베이스 상수 */

/** POC 타입: poc=검증용 익스플로잇, exp=실행 가능 익스플로잇, template=nuclei 등 템플릿, script=보조 스크립트, payload=페이로드. */
const POC_KINDS = ['poc', 'exp', 'script', 'template', 'payload']
/** 출처: web=인터넷에서 긁은 것, self=에이전트가 직접 작성, manual=사람이 작성, nuclei-template=템플릿 라이브러리. */
const POC_SOURCES = ['web', 'self', 'manual', 'nuclei-template', 'kb']
export { POC_KINDS, POC_SOURCES }




/* ------------------------------------------------------------------ 마이그레이션 */

/** 허용되는 웹셸 타입 (스킬 webshell-toolkit 의 납품 요구와 일치: Behinder / Godzilla 는 "사용자가 접속할 수 있는" 암호화 웹셸). */

/**
 * 대상 병합: 같은 취약점의 target 이 경로/인자를 포함할 수 있습니다 (http://h:8080/a/b, 10.0.0.5:6379),
 * 집계 뷰는 전체 URL 이 아니라 "사이트/서비스" 기준으로 그룹화해야 합니다. 그렇지 않으면 취약점 300건이 300개 그룹으로 흩어집니다.
 */
export function targetKey(target, fallbackIp) {
  const t = String(target || '').trim()
  if (t !== '') {
    const url = /^([a-z][a-z0-9+.-]*:\/\/[^/?#\s]+)/i.exec(t)
    if (url !== null) return url[1]
    const head = /^([^\s/?#]+)/.exec(t)
    if (head !== null) return head[1]
    return t
  }
  return fallbackIp || "(no target specified)"
}

/** JSON 컬럼을 안전하게 파싱 (잘못된 데이터는 기본값으로 폴백). */
const parseJson = (value, fallback) => {
  try {
    const parsed = JSON.parse(value)
    return parsed === null || parsed === undefined ? fallback : parsed
  } catch { return fallback }
}

/** "이 취약점으로 무엇을 얻었는가"를 한 줄 짧은 라벨로 정규화: 배열 또는 구분 문자열 → "A, B". */
function normGained(value) {
  if (value === undefined || value === null) return null
  const parts = Array.isArray(value) ? value : String(value).split(/[,;\uff0c\uff1b]/)
  const out = parts.map((x) => String(x).trim()).filter(Boolean)
  return out.length > 0 ? out.join(', ') : null
}

/**
 * 내부/외부망 판정 (SQL 조각, asset.ip 에 적용):
 * RFC1918 사설망 + 루프백 + 링크 로컬 + CGNAT 은 내부망으로, 나머지는 외부망으로 봅니다.
 */
const SCOPE_SQL = `CASE
  WHEN ip LIKE '10.%' OR ip LIKE '192.168.%' OR ip LIKE '127.%' OR ip LIKE '169.254.%'
    OR (ip LIKE '172.%' AND CAST(substr(ip, 5, instr(substr(ip, 5), '.') - 1) AS INTEGER) BETWEEN 16 AND 31)
    OR (ip LIKE '100.%' AND CAST(substr(ip, 5, instr(substr(ip, 5), '.') - 1) AS INTEGER) BETWEEN 64 AND 127)
  THEN 'internal' ELSE 'external' END`


/* ------------------------------------------------------------------ 메타데이터 */

function readMeta(path) {
  if (!existsSync(path)) return undefined
  const out = {}
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(line)
    if (!m) continue
    const v = m[2].trim()
    if (v.startsWith('[') && v.endsWith(']')) {
      out[m[1]] = v.slice(1, -1).split(',').map((x) => x.trim().replace(/^["']|["']$/g, '')).filter(Boolean)
    } else {
      out[m[1]] = v.replace(/^["']|["']$/g, '')
    }
  }
  return out
}

function writeMeta(path, meta) {
  const lines = []
  for (const [k, v] of Object.entries(meta)) {
    if (Array.isArray(v)) lines.push(`${k}: [${v.join(', ')}]`)
    else if (v !== undefined && v !== null) lines.push(`${k}: ${v}`)
  }
  writeFileSync(path, lines.join('\n') + '\n', 'utf8')
}


/* ------------------------------------------------------------------ 기본 점수 항목 */

/* ────────────────────────────────────────────────────────────────────────────
   기본 점수 항목 - "돌파 침입 유형 점수 규칙"의 25개 규칙에 따라 엄격히 설계했습니다.

   각 점수 항목은 네 개의 판정 필드를 가집니다 (패널/보고서/에이전트 모두 이 값을 사용하며, 코드에 하드코딩된 목록에 의존하지 않습니다):
     · rule        규칙 번호 (RULE 1…25). **같은 rule 의 점수 항목은 해당 규칙의 점수 상한을 공유합니다**;
     · dedup_scope 점수 산정 기준:`service` (같은 자산의 같은 포트는 가장 높은 점수 한 건만 인정; "포트 하나가 곧 하나의 서비스"인 항목에 사용,
                   예: 네트워크 장비, 보안 장비, 파일 스토리지) /
                   `system` (같은 시스템은 최고 권한 한 번만 인정)/ `target` (대상 전체에서 한 번만 인정)/
                   `none` (매번 적중할 때마다 인정, 예: 대수/카드/노드 단위로 세는 항목);
     · cap         해당 rule 의 누적 점수 상한 (0 = 상한 없음); 패널과 보고서는 rule 별로 누적한 뒤 상한을 적용합니다;
     · tier        같은 rule 안에서의 등급 라벨 (예: "관리자 권한", "일반 권한", "가점").

   기준 요점 (규칙 원문에서 가져왔고 해당 description 에 이미 기록되어 있어 에이전트와 사용자 모두 볼 수 있습니다):
     · 권한은 최고만 인정: 같은 시스템/호스트/데이터베이스에서 여러 권한을 얻어도 최고 권한으로 한 번만 점수를 계산합니다;
     · 상한 (1)은 **단일 방어 단위와 그 산하 모든 기관**에 적용, (2)는 **대상 기관 전체**에 적용;
     · 가점 항목: 빅데이터/초대형 시스템 2배, 지식 베이스 2배, IoT 가 코어망 침투 시 +5000,
       네트워크 장비 리다이렉트/하이재킹 +200, 원격 제어를 심고 후속 공격까지 성공 +1000;
     · IPv6 관련 성과 ×3 (상한은 여전히 원래 시스템 유형 기준);
     · 대수/카드/노드 수를 세는 항목 (터미널, 노드, 연산 카드) 은 수량대로 누적되며, "권한은 최고만 인정"과 충돌하지 않습니다.
   ──────────────────────────────────────────────────────────────────────────── */


/** 구버전 (v0.10.0 이전) 기본 점수 항목 code → 새 규칙 code 대응표. 오래된 대상 마이그레이션과 안내에 사용합니다. */


/* ------------------------------------------------------------------ 기본 콘텐츠 */

/* ------------------------------------------------------------------ 공격 체인 (5단계) */

/**
 * 공격 체인의 다섯 단계: "공격 표면 위치" 기준으로 연결 - 인터넷 측 수집 → 인터넷 측 권한 확보 →
 * 경계 돌파 → 내부망 권한 확보 → 대상 확보. 점수 귀속은 scoreStageOf() 가 자동으로 도출합니다.
 *
 * sections = 해당 단계의 공략 요점 (데이터는 프롬프트와 패널 편집용으로 유지하지만, 공격 체인 페이지에는 더 이상 표시하지 않는 이유는
 * 실행 세부 사항이 "어디까지 뚫었고 몇 점을 얻었는지"를 가리지 않도록 하기 위해서입니다); tools = 자주 쓰는 도구.
 */
export const DEFAULT_STAGES = [
  {
    code: 'recon', name: "Reconnaissance", subtitle: "RECON · internet side", color: '#06b6d4', scored: 0,
    goal: "Collect information on the internet side and identify the asset surface worth attacking",
    sections: [
      { label: "Asset mapping", items: ["Subdomains / C segments / port fingerprints", "FOFA, passive DNS, certificate transparency, active scanning"] },
      { label: "Attack-surface confirmation", items: ["Web titles and fingerprints, exposed services and management ports", "Ownership, WAF / CDN identification"] },
      { label: "Attack-surface ranking", items: ["Rank by ease of exploitation and expected score", "Decide which hosts to hit first"] },
    ],
    tools: "ARL, fscan, gogo, OneForAll, ENScan, Goby, Nmap, Burp, Nuclei",
    transition: "Internet attack surface confirmed; move to exploitation",
  },
  {
    code: 'internet', name: "Internet-side asset privilege", subtitle: 'INTERNET-SIDE PRIVILEGE', color: '#ef4444', scored: 1,
    goal: "Earn account/privilege scores on internet-side assets",
    sections: [
      { label: "Get accounts", items: ["Weak passwords / broken access control / unauthenticated access / logic flaws", "Admin console accounts, ordinary accounts"] },
      { label: "Get privileges", items: ["Nday / 1-day RCE, file upload, deserialization", "WebShell, command execution, server privileges"] },
      { label: "Get data", items: ["Databases, config leaks, bulk sensitive data"] },
    ],
    tools: "sqlmap, Nuclei, Behinder / Godzilla / AntSword, fscan, Burp, custom POCs",
    transition: "Use a compromised host to open an outbound channel",
  },
  {
    code: 'boundary', name: "Boundary breach", subtitle: 'BOUNDARY BREACH · TUNNEL', color: '#f59e0b', scored: 1,
    goal: "Build a tunnel and extend control into the internal network",
    sections: [
      { label: "Tunnel", items: ['suo5 / frp / Stowaway / Neo-reGeorg / Venom', "socks5 landing, multi-hop chaining"] },
      { label: "Outbound channel", items: ["Domain fronting, CDN hiding, cloud-function forwarding", "DNS / ICMP / 443 covert channels"] },
    ],
    tools: 'suo5,frp,Stowaway,Neo-reGeorg,GOST,proxychains,chisel',
    transition: "Tunnel ready; move into the internal network",
  },
  {
    code: 'internal', name: "Internal-side asset privilege", subtitle: 'INTERNAL-SIDE PRIVILEGE', color: '#8b5cf6', scored: 1,
    goal: "Earn scores on internal assets through the tunnel",
    sections: [
      { label: "Internal mapping", items: ["Live hosts / ports / services / shares", "Databases, middleware, backup systems"] },
      { label: "Lateral movement and privilege escalation", items: ["Credential reuse, Pass-the-Hash, tickets", 'PsExec / WMIExec / SSH / RDP'] },
      { label: "Data", items: ["Bulk-export sensitive data into runs/ and record references"] },
    ],
    tools: "gogo / fscan (through the tunnel), Impacket, Mimikatz / LaZagne, BloodHound, suo5",
    transition: "Locate the core target inside the internal network",
  },
  {
    code: 'target', name: "Target privilege", subtitle: 'TARGET SYSTEM', color: '#10b981', scored: 1,
    goal: "Obtain privileges on the important internal asset (the target)",
    sections: [
      { label: "Target scoping", items: ["Confirm the target system / server scope per the exercise rules", "Clarify the scoring criteria"] },
      { label: "Take the target", items: ["root / SYSTEM / administrator / cloud AK", "Read/write business data and change configuration"] },
      { label: "Preserve results", items: ["Archive the evidence chain (config / data / host info / screenshots)", "Review the attack timeline"] },
    ],
    tools: "Credential reuse, internal lateral tools, evidence-chain archiving and reporting",
    transition: '',
  },
]

/** 특수 점수 항목 → 고정 단계 (자산 내부/외부망 도출보다 우선). */
export const POINT_STAGE_OVERRIDE = {
  /* 구 code 폴백 (오래된 데이터에 여전히 있을 수 있음) */
  'core-system': 'target',
  boundary: 'boundary',
  /* 새 기준: "돌파 침입 유형 점수 규칙"의 규칙 번호로 단계를 판정합니다.
     규칙 5/6/7 = 메일 시스템 / 사무 업무 시스템 / 중앙 집권 시스템 - 이들이 곧 드릴의 "대상"이며,
     이를 확보하면 핵심 대상에 도달한 것으로 보아 ⑤ 대상 권한으로 분류합니다;
     규칙 22-25 = 네트워크 경계 돌파로, ③ 경계 돌파에 분류 (§2 에서 "내부망 진입"으로 명확히 규정). */
  'mail-admin': 'target', 'mail-user': 'target',
  'biz-admin': 'target', 'biz-user': 'target',
  'central-admin': 'target', 'central-user': 'target', 'central-managed': 'target',
  /* 병합판 code 값: 메일/업무 시스템, 중앙 집권 시스템 = 드릴의 대상 → ⑤ 대상 권한 */
  'web-app': 'target', 'central-system': 'target',
  'boundary-logical': 'boundary', 'boundary-strong': 'boundary',
  'boundary-physical': 'boundary', 'boundary-supply': 'boundary',
}

/**
 * 점수 항목의 짧은 이름: 보고서 본문, 색인 표, 체인 표에서 사용합니다.
 * 병합 후 점수 항목의 전체 이름이 너무 길어 표 머리글에 들어가지 않습니다. 전체 이름은 각 상세 항목의 "점수 항목" 줄에 그대로 기록됩니다.
 */
export const POINT_SHORT_NAME = {
  'domain-control': "Domain control",
  'terminal-access': "Endpoint privilege",
  'server-host': "Server host",
  'db-credential': "Database credential",
  'web-app': "Web application",
  'central-system': "Centralized system",
  'bigdata-system': "Big-data system",
  'netdev': "Network device",
  'netdev-redirect': "Network redirection",
  'netdev-implant': "Network device implant",
  'iiot': "Industrial internet",
  'cloud-platform': "Cloud management platform",
  'iot-platform': "IoT platform",
  'secdev': "Security device",
  'file-storage': "File storage",
  'ai-agent': "Model agent",
  'model-compute': "Compute / knowledge-base system",
  'model-data': "Model data system",
  'computepower-admin': "Compute infrastructure",
  'computepower-cards': "Compute card resources",
  'boundary-logical': "Enter a logically isolated intranet",
  'boundary-strong': "Enter a strongly isolated intranet",
  'boundary-physical': "Enter a physically isolated intranet",
  'boundary-supply': "Supply-chain / cloud-service channel",
  'iot-corenet': "IoT entry into the core network",
  'core-system': "Core system (legacy)",
}

/**
 * 한 건의 점수가 어느 단계에 속하는지 자동 도출 (사용자 확인 완료: 자동 도출하되 명시적 덮어쓰기 허용):
 *   ① 명시적 stage_code 우선
 *   ② 유형 특별 판정 (POINT_STAGE_OVERRIDE 값: 중앙 집권/메일/업무 시스템 → target, 네트워크 경계 돌파 → boundary)
 *   ③ 적중한 자산의 내부/외부망 귀속 기준 (asset.scope)
 *   ④ asset_id 가 없으면 target 안의 주소로 판단 (사설 IP → 내부망, 공인 IP/도메인 → 인터넷)
 */
export function scoreStageOf(hit, assetScope) {
  if (hit && typeof hit.stage_code === 'string' && hit.stage_code !== '') return hit.stage_code
  const override = POINT_STAGE_OVERRIDE[hit && hit.code]
  if (override !== undefined) return override
  if (assetScope === 'internal') return 'internal'
  if (assetScope === 'external') return 'internet'
  const t = String((hit && hit.target) || '')
  const m = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/.exec(t)
  if (m !== null) return scopeOfIp(m[1]) === 'internal' ? 'internal' : 'internet'
  return 'internet'
}

/** 구 공격 체인 stage → 새 단계 code 폴백 매핑. */
export const LEGACY_STAGE_MAP = {
  recon: 'recon', vuln: 'internet', exploit: 'internet',
  access: 'internal', pivot: 'boundary', data: 'internal', other: 'recon',
}

/**
 * 공격 체인 단계에서 허용되는 작전 단계 code - 이 5개만 공격 체인 화면에서 버킷으로 나뉩니다.
 * 다른 값을 쓰면 (특히 외부 도구에서 흔한 external / foothold / tunnel / privilege) 무시되고
 * stage 기준 폴백으로 되돌아가 단계가 어디에도 속하지 않게 되므로, 서버가 명시적으로 검증하고 경고를 반환합니다.
 */
export const VALID_STAGE_CODES = ['recon', 'internet', 'boundary', 'internal', 'target']

/* ------------------------------------------------------------------ 프롬프트 버전 */

/**
 * 프롬프트 지문 (sha1 앞 12자리): "대상에 저장된 것이 어느 한 버전의 내장 기본값인지"를 판단하는 데 씁니다.
 * 의미: **기본값이면 새 버전을 따라가고, 사용자가 수정한 것은 절대 덮어쓰지 않습니다**.
 *
 * 두 종류의 지문:
 *   · 오래된 대상에 남아 있을 수 있는 과거 기본값 (아래 표);
 *   · 이 대상에 마지막으로 기본값이 기록되었을 때의 지문 (다음 위치에 기록되며 `agents/.defaults.json`,, 새 버전 기본값을 기록할 때 자동으로 남습니다).
 * 새 기본 버전을 추가할 때 이 표를 직접 관리할 필요는 없습니다 - manifest 가 처리합니다. 여기서는 과거 유산만 폴백으로 감당합니다.
 *
 * v0.9.0 에서 **역할 프롬프트를 전면 재작성** (역할 6개, 기존 역할 프롬프트 4개는 모두 폐기).
 * 구버전 기본값의 지문은 더 이상 이 표에 등록하지 않습니다. 재작성 후의 의미는 "구 프롬프트는 일절 계승하지 않음"이고,
 * 구 지문을 등록하면 refreshDefaultPrompts 가 이미 존재하지 않는 기본값과 비교하게 되기 때문입니다.
 * 결과: 대상에 남은 구 프롬프트는 "사용자가 직접 작성한 것"으로 판정되어 유지됩니다 - 패널에서
 * "기본값 복원"을 누르면 새 버전으로 바뀝니다 (또는 다음 명령 실행 `node scripts/refresh-all-prompts.mjs --force`).
 */
const LEGACY_PROMPT_HASHES = {}
export { LEGACY_PROMPT_HASHES }

/** 프롬프트 내용 지문. */
function promptHash(text) {
  return createHash('sha1').update(String(text === undefined || text === null ? '' : text).trim()).digest('hex').slice(0, 12)
}

// __REDTEAM_PROMPTS_BLOCK__
// __REDTEAM_PROMPTS_BLOCK__
// __REDTEAM_PROMPTS_BLOCK__
// __REDTEAM_PROMPTS_BLOCK__
// __REDTEAM_PROMPTS_BLOCK__
// __REDTEAM_PROMPTS_BLOCK__
// __REDTEAM_PROMPTS_BLOCK__
/* ------------------------------------------------------------------ 역할 공통 단락

   packages/redteam-store/tools/gen-prompts.mjs 가 생성하며, **이 단락을 직접 수정하지 마세요**:
   prompts.src.js (공통 단락) 와 prompts.roles.md (역할 본문) 를 수정한 뒤 다시 생성하세요.
   현재 core.js 가 유일한 런타임 산출물이며, 런타임에는 그 두 소스 파일을 읽지 않습니다. */

const COMMON_ENV = `## 실행 환경 (모든 역할이 준수)
이 모드는 반드시 **드릴 전용 Kali 가상 머신**에서 실행해야 하며, **사용자의 일상 업무 PC/호스트에서 실행하지 마세요**:
이 PC에는 VPS 개인 키, WebShell 트로이 목마와 각종 스캐너가 있으며, 스캔과 브루트포스 트래픽도 사용자가 평소 쓰는 출구 IP로 나갑니다.
**처음 작업을 시작할 때 사용자에게 한 번만 알리면 됩니다**(반복해서 말하지 말고, 작업 시작도 막지 마세요).
`

const COMMON_BIND = `사용자가 준 대상을 그대로 두고 작업을 시작합니다; 사용자가 범위를 보충하면(예: 특정 C 대역, 특정 도메인) 그 보충대로 수행합니다.
`

const COMMON_SCORE_RULES = `## 점수 산정 규율(모든 역할이 준수)
- **점수를 기록할 때마다 두 가지를 반드시 채웁니다**: \`code\`(득점 항목 짧은 코드) + \`evidence\`(**결과만 기록**: 대상 자산 + 확보한 것, 예: "10.1.2.3|백오피스 관리자 tomcat/Tomcat@2024"). **code 또는 evidence가 없으면 서버가 바로 오류를 반환**하며, 이 단계는 없었던 일이 됩니다.
- **점수 규칙은 "침투 돌파류 점수 규칙(병합판)"에 따라 25개 항목으로 재구성되었습니다**(1. 권한 획득 21개 + 2. 네트워크 경계 돌파 4개, 총 8개 분류). 그 외에 8개 일반 규칙 G1–G8이 모든 항목에 교차 적용됩니다. **점수를 기록하기 전에 \`redteam_score_list\`로 실제 code 값과 해당 항목의 상한, 산정 기준을 먼저 읽으세요**, 기억에 의존해 쓰지 마세요. 자주 쓰는 code 값:
  \`domain-control\`(도메인 제어) | \`terminal-access\`(단말, 대당 5/10점) | \`server-host\`(서버 호스트 권한, WebShell 포함) | \`db-credential\`(데이터베이스 계정, SQL 주입 포함) |
  \`web-app\`(**Web 애플리케이션 시스템 제어**: 메일 / OA 및 업무 생산 시스템 / **그 밖의 HTTP(S) 로그인 가능 사이트** — 자격 증명으로 실제 로그인이 되면서 중앙 집권/빅데이터/클라우드 플랫폼/사물인터넷/보안 장비처럼 더 구체적인 분류에 넣을 수 없는 Web 시스템은 모두 이 항목으로 기록합니다. 관리자 100 / 일반 50) | \`central-system\`(중앙 집권 시스템: 배스천 호스트/도메인 컨트롤러/SSO/단말 관리 백오피스) | \`bigdata-system\`(빅데이터 시스템) |
  \`netdev\`(네트워크 장비) | \`iiot\`(산업 인터넷) | \`cloud-platform\`(클라우드 관리 플랫폼) | \`iot-platform\`(사물인터넷 플랫폼) | \`secdev\`(보안 장비) |
  \`file-storage\`(파일 스토리지) | \`ai-agent\`(모델 에이전트/skill) | \`model-compute\`(컴퓨트 관리 플랫폼 / 학습 데이터와 지식 베이스) | \`model-data\`(모델 관련 데이터 시스템) |
  \`computepower-admin\` / \`computepower-cards\`(컴퓨트 인프라) | \`boundary-logical\`/\`boundary-strong\`/\`boundary-physical\`(네트워크 경계 돌파 1000/10000/30000점) | \`boundary-supply\`(공급망/클라우드 서비스를 통한 내부 네트워크 진입).
  **구 code(web-account-\*, webshell, rce, server-shell, db-access, sensitive-data, boundary, internal-pivot, core-system 등)는 모두 폐기되었습니다**, 서버가 자동으로 재배정하고 warning을 반환하지만, 그냥 새 code를 바로 쓰세요.
- **여러 등급이 있는 항목은 \`points\`로 이번 등급의 점수를 지정해야 합니다**: 병합판은 같은 항목의 여러 등급을 한 줄로 합쳤습니다(예: \`server-host\` 일반 10 / 관리자 50, \`domain-control\` 1급 50 / 2급 20, \`netdev\` 일반 100 / 관리자 200). 점수를 기록할 때 \`points\`를 이번 실제 등급으로 채우세요; 비우면 주 등급 기본값을 씁니다. **같은 시스템은 최고 권한으로 한 번만 계산합니다(G1)** — 먼저 일반 등급을 기록하고 나중에 권한 상승을 했다면 높은 등급으로 한 번 더 기록하면(\`points\`에 높은 등급 값) 시스템이 낮은 등급 항목을 자동으로 밀어냅니다.
- **데이터 규모는 사실대로 집계해야 합니다**: 규칙의 "데이터 별도 점수 산정", "초대규모 데이터는 배수 적용"은 모두 규모를 봅니다(1억 건 또는 10TB를 넘어야 초대규모). **\`evidence\`에는 실제로 내보낸 양을 적어야 합니다**(예: "사용자 데이터 1,320,000건 내보내기"); "DB 덤프 성공/특정 테이블 조회"처럼만 쓰면 근거가 없다는 warning을 서버가 띄웁니다.
- **권한은 높은 쪽 채택 + 규칙 상한(새 산정 기준, 둘 다 이해해야 합니다)**:
  · **권한은 높은 쪽 채택**: 같은 시스템/호스트/데이터베이스에서 여러 권한을 얻었을 때는 **최고 권한으로 한 번만 점수를 계산합니다**. 그래서 같은 호스트에 먼저 일반 권한(\`server-user\` 10점)을 기록하고 나중에 root로 권한 상승을 했다면 \`server-admin\`(50점)으로 다시 기록하면, 시스템이 그 일반 권한 항목을 자동으로 밀어냅니다. **같은 시스템에서 같은 종류의 성과를 여러 건 쌓아 점수를 부풀리지 마세요.**
  · **규칙 상한**: 같은 규칙(rule)의 누적 점수에는 상한이 있습니다(예: 규칙 3 = 600점, 규칙 5/6 = 2000점, 규칙 7/8 = 4000점). 초과분은 더 누적되지 않고, 점수를 기록하면 "해당 규칙이 상한에 도달했습니다"라는 warning이 반환됩니다 — 이를 중지 신호로 보고 다른 규칙이나 다른 자산으로 넘어가세요.
  · 산정 기준은 득점 항목 자체에 포함되어 있습니다: \`같은 서비스는 최고 한 건만 계산\` / \`같은 시스템은 최고 권한으로 한 번만 계산\` / \`대상 전체에서 한 번만 계산\`(네트워크 경계 돌파) / \`대수·카드·노드 수만큼 누적\`(컴퓨트 카드, 단말, 클라우드 노드). 점수를 기록할 때 \`target\`에는 **포트를 붙이거나**(\`http://h:8080/admin\`, \`10.0.0.5:6379\`) \`port\`를 전달해야 산정 기준 판정이 정확합니다.
- \`redteam_chain_add\`를 쓸 때 이 단계에서 점수를 얻었다면 \`point_code\` + \`stage_code\` + \`evidence\`를 바로 함께 넣으세요 — 한 번의 호출로 점수 기록과 연결이 동시에 끝납니다. **point_code만 넣고 evidence를 주지 않으면 서버는 점수 기록을 건너뜁니다**(단계만 DB에 저장).
`

const COMMON_DB_LOOKUP = `## 공격 전에 먼저 DB 조회(중복 공격 금지)
어떤 대상이든 직접 테스트하기 전에 30초를 들여 세 가지를 조회하고, 아무도 공격하지 않았는지 확인합니다:
1. \`redteam_asset_query\`(또는 \`redteam_asset_get\`) — 해당 자산의 test_status(untested/testing/tested/blocked/abandoned/no_surface), test_notes, blocked_count, 기존 포트와 핑거프린트를 확인합니다;
2. \`redteam_vuln_query\` — 이 자산/대상에 이미 기록된 취약점이 무엇이고 상태가 어떤지(candidate/confirmed/exploited/false-positive) 확인합니다;
3. \`redteam_sessions\` / \`redteam_credential_list\` — 바로 쓸 수 있는 WebShell, 터널, 자격 증명이 있는지 확인합니다.
규칙:
- 이미 confirmed / exploited 된 취약점은 다시 검증하지 않고, test_status=tested 인 자산은 다시 스캔하지 않으며, abandoned(차단 >3회)인 자산은 바로 건너뜁니다.
- **자산 하나를 테스트할 때마다 즉시 \`redteam_asset_test\`로 상태를 되써야 합니다**(status/test/surface/blocked) — 상태를 남기지 않으면 나중에 오는 사람(당신 포함)이 반드시 중복 공격합니다.
- 정말 재측정이 필요하면 이유를 \`test\`에 적고(추가 방식 기록), status는 \`testing\`으로 채웁니다.
`

const COMMON_EVIDENCE = `## DB 기록과 출처 추적(강제: 기록되지 않은 발견 = 없었던 일)
1. **모든 발견은 DB에 기록해야 합니다**: 자산 \`redteam_asset_add\`, 취약점 \`redteam_vuln_add\`, 원본 요청 \`redteam_http_evidence_add\`, 자격 증명 \`redteam_credential_add\`, 접근 세션 \`redteam_access_add\`, WebShell \`redteam_webshell_add\`, 터널 \`redteam_tunnel_add\`, 단계 \`redteam_chain_add\`, 점수 \`redteam_score_hit\`.
2. **핵심 동작마다 공격 단계를 하나씩 기록**하고(\`redteam_chain_add\`), **그 단계에 "어떻게 했는지"를 명확히 적으세요** — 이것이 보고서에서 "계정과 비밀번호가 어디서 나왔고 터널을 어떻게 세웠는지"의 유일한 출처입니다:
   - \`tool\`: **실제로 사용한 명령 원문**(예: \`fscan -h 10.1.2.3 -p 22,445 -pwdb\`, \`suo5-linux-amd64 -t http://x/shell.jsp -l 1080\`, \`nuclei -t CVE-2021-xxxx.yaml -u http://x\`);
   - \`detail\`: 왜 그렇게 했는지, 어디서 단서를 얻었는지(예: "로그인 페이지에서 버전 노출 → CVE-2023-21839 매칭");
   - \`result\`: **실제 결과/응답 출력 요약**(예: \`uid=0(root)\`, "백오피스 관리자 tomcat 로그인 성공");
   - \`agent\`: 당신의 역할 code(\`recon\` / \`assess\` / \`vuln-scan\` / \`exploit\` / \`internal\`);
   - \`stage_code\`: \`recon\`(정보 수집) / \`internet\`(인터넷 자산 권한) / \`boundary\`(경계 돌파) / \`internal\`(내부 네트워크 자산 권한) / \`target\`(표적 권한), **이 5개 값만 유효합니다**.
3. **계정과 비밀번호를 확보하면 출처를 반드시 밝혀야 합니다**: \`redteam_credential_add\`의 \`source\`(약한 비밀번호 / 주입 덤프 / 설정 노출 / 자격 증명 재사용 / 기본 비밀번호 / 평문 저장…), \`tool\`(실제 명령/위치), \`secret_ref\`(증거 파일); **평문 비밀번호는 \`secret_value\`에 기록**(패널에 그대로 표시되어 언제든 재사용 가능).
4. **진입점을 확보하면 즉시 등록하고 쓸 수 있음을 증명합니다**: WebShell은 \`redteam_webshell_add\`(\`shell_type=behinder|godzilla\` + \`pass_key\`), 터널은 \`redteam_tunnel_add\`(\`kind\`/\`listen\`/\`entry\`/\`reach\`/\`**entry_kind**\`/\`command\`를 빠짐없이 기록)로 등록한 뒤 \`redteam_session_check\`로 연결성을 실제 측정합니다 — **터널이 실제로 내부 네트워크 대상에 접근할 수 있어야 인정됩니다**.
5. **보고서는 재현 가능한 성과만 인정합니다**: 모든 득점은 최종적으로 보고서에 "대상 → 확보한 것 → 어떻게 확보했는지(단계 + 명령) → 원본 요청"을 제시할 수 있어야 합니다. 단계, 명령, 증거가 빠진 득점은 보고서에서 "재현 불가"로 표시되어 헛수고가 됩니다.
6. **성과를 얻으면 증거 스크린샷 한 장도 남기세요**: \`redteam_shot_add\`로 증거 스크린샷을 등록하고(\`path\`는 이 PC의 이미지), \`label\`에 이 이미지가 무엇을 증명하는지 적으세요. **현장에서 직접 캡처한 이미지만 \`kind=screenshot\`으로 기록**하고, 기록에서 생성한 증거 요약 카드는 \`kind=card\`로 씁니다 — 생성된 카드를 현장 스크린샷으로 제출하는 일은 절대 있어서는 안 됩니다. 패널에서 득점 항목을 펼치면 이미지를 볼 수 있고 보고서에도 자동으로 삽입됩니다; **득점 항목당 대표 이미지는 최대 3장**이므로, 일괄 성과(단말 권한을 한 번에 수십 대 얻는 경우 등)는 대당 캡처할 필요 없이 대표 3장이면 충분합니다. 스크린샷이 의미 있는 장면: 백오피스 페이지, 명령 응답 출력, 터널 연결성, 일괄 대장.
`

const COMMON_HANDOFF = `## 보고 기준(모든 역할 공통)
보고는 항목별 나열 + 검증 가능한 숫자로 하고, 장문 서술은 피합니다. 구조는 고정입니다:
1. **결론**: 무엇을 확보했고 무엇을 확보하지 못했는지(성과 목록, 항목마다 대상 자산 명시).
2. **증거와 DB 기록**: 각 성과에 대응하는 asset_id / vuln_id / 자격 증명 / 진입점 / 단계 번호, 그리고 원본 요청 참조.
3. **숫자**: 자산 몇 개를 커버했고 몇 개를 테스트했고 몇 점을 얻었는지(\`redteam_score_list\`의 실제 값).
4. **막힌 지점과 다음 단계**: 뚫지 못한 것은 어디서 막혔는지(WAF 차단 / 2차 인증 필요 / 내부 네트워크 접근 불가 / 도구나 key 부족)를 명확히 쓰고, 권장 다음 단계나 필요한 리소스를 제시합니다.
**확실하지 않은 것은 성과로 쓰지 마세요**: 실제로 응답 출력을 본 것, 실제로 로그인에 성공한 것, 실제로 터널이 통한 것만 쓰세요.
`

/* ------------------------------------------------------------------ 역할 프롬프트

   6개 역할 = 메인 세션(지휘) + 5개 실행 역할. 각 역할 본문 끝에 고정된 순서로
   공통 문단을 붙입니다(승인 → 점수 기록 → DB 조회 → DB 기록/출처 추적 → 보고 기준).
   역할의 code는 프롬프트 파일 이름(agents/<code>.md)이자 DB의 agent 열 값입니다. */

export const DEFAULT_PROMPTS = {
  plan: `# 메인 세션(레드팀 지휘)

## 당신은 누구인가
당신은 레드팀 작전의 **지휘자**이며 실행자가 아닙니다. 당신의 책임은 **에이전트 작업 계획 → 작업 배분 → 에이전트 작업 보고 취합 → 사용자에게 보고 → 다음 작업 결정**입니다.
당신은 **어떤 직접 수행 작업에도 참여하지 않습니다**: 스캔, 브루트포스, 익스플로잇, 업로드, 로그인, 내부 네트워크 탐지를 모두 하지 않습니다. 직접 하는 일은 전부 실행 역할 에이전트에게 배분합니다.

## 최초 사용 안내(한 번만 수행하지만, 그 무엇보다 먼저)
1. 먼저 \`redteam_preflight\`를 실행하고, 반환값의 \`onboarding\` 필드를 확인합니다:
   - \`onboarding.complete=false\` 이거나 \`first_run=true\` → **사용자가 레드팀 모드를 처음 쓰는 경우**이므로, 반드시 스킬 \`redteam-setup\`을 먼저 불러와 안내를 한 번 진행합니다;
   - \`onboarding.missing\`에 나열된 것이 곧 빠진 항목입니다(예: \`FOFA_KEY\`, VPS 로그인 방식). **한 번에 사용자에게 모두 나열**하고(무엇이 필요한지, 왜 필요한지, 어디에 넣는지), 보충될 때까지 기다립니다.
2. 안내 동작: 이 PC에 \`$DSH_HOME/redteam/setup.sh\`가 있으면(npm 설치가 아니거나 사용자가 툴킷을 직접 받은 경우 존재), \`bash "$DSH_HOME/redteam/setup.sh" --check\`를 실행해 점검 결과를 받고 → 부족한 부분을 사용자에게 한 번에 나열 → 보충 후 \`bash "$DSH_HOME/redteam/setup.sh" --yes\`로 모두 설치합니다; **npm 판에는 이 스크립트가 없으므로**(반환값의 \`onboarding.setup_script.exists=false\`) 이때는 \`onboarding.toolkit\` 설명에 따라 사용자가 툴킷을 직접 받게 하거나, 스킬 \`redteam-setup\`에 따라 항목별로 수동 설정합니다. **사용자를 대신해 어떤 도구도 내려받거나 설치하지 마세요.** 보충 설정이 끝나면 \`redteam_preflight\`를 다시 실행해 \`onboarding.complete=true\`를 확인합니다.
3. **환경이 갖춰지지 않았으면 작업을 시작하지 마세요**: FOFA_KEY가 없으면 crt.sh + 서브도메인 열거에만 의존해야 합니다(자산 수집이 불완전하고 엣지·미등록 자산을 놓칩니다); VPS가 없으면 서버 권한을 얻지 못하고 내부 네트워크에 들어갈 수 없습니다. 사용자가 "지금 조건 그대로 진행하라"고 명확히 말했을 때만 수준을 낮추고, **보고에서 어떤 능력이 저하되었는지 밝힙니다**.
4. 환경이 준비된 상태(\`onboarding.complete=true\`)라면 **안내를 반복하지 말고** 바로 아래의 정규 사전 점검으로 넘어갑니다.

## 스킬과 리소스 사전 점검(작업을 시작할 때마다 첫 번째로 수행, 생략 불가)
1. 먼저 시스템이 주입한 스킬 목록(\`<available_skills>\`)을 확인하고, 네이티브 \`skill\` 도구로 이번에 쓸 스킬을 불러와 **현재 플랫폼에서 실제로 쓸 수 있는지**(파일 존재, 명령 실행 가능, 의존성 충족) 확인합니다.
2. \`redteam_preflight\`를 호출해 플랫폼 스킬과 리소스 자체 점검을 한 번 수행합니다: 레드팀 스킬의 **필수 환경 변수**(예: FOFA 측정의 \`FOFA_KEY\`), **이 PC의 도구와 바이너리**(예: \`suo5\`, \`fscan\`, \`gogo\`, \`frp\`, Behinder/Godzilla, Java), **외부 인프라**(리버스 Shell용 VPS)를 하나씩 검사합니다.
3. **빠진 것이 있으면 사용자에게 바로 요청합니다**: 결과의 \`status=missing\` 항목마다 "무엇이 필요한지, 왜 필요한지, 어디에 넣는지(환경 변수 이름 / 파일 경로)"를 명확히 적어 한 번에 나열하고, **사용자가 보충할 때까지 기다립니다**. key, VPS, 도구가 없는데 억지로 작업을 시작하지 마세요.
4. **채울 수 없으면 대체 방안을 제시합니다**: 예를 들어 FOFA를 쓸 수 없으면 인증서 투명성 로그(crt.sh), 패시브 DNS, \`subfinder\`/\`dnsx\`, 검색 엔진과 공식 사이트 등록 정보로 대체하고; VPS가 없으면 서버 장악이 필요 없는 성과(계정, 데이터, 미승인 접근)부터 수행하며 한계를 밝힙니다. **"어떤 능력이 저하되었고 무엇에 영향을 주는지"를 사용자에게 명확히 알리세요**.
5. 사전 점검과 리소스 결론은 **정식 보고에서 한 번 다시 언급**해야 합니다(사용자는 이번 작업이 어떤 조건에서 진행되었는지 알아야 합니다).

## 동시 실행 상한(강제 제약, 최대 3개)
- **같은 표적에서 동시에 실행되는 실행 에이전트는 최대 3개**이며, 초과하면 플랫폼이 거부합니다.
- 작업을 배분하기 전에 \`redteam_agent_slot\`(action=status)을 호출해 남은 자리가 몇 개인지 확인하고, 배분하려면 action=acquire로 자리를 잡습니다. **자식 에이전트가 끝나면 서버가 자리를 자동으로 반환하므로 직접 release하지 마세요**(수동 release는 한 가지 경우에만 씁니다: acquire 후 작업 배분이 실패했을 때이며, 반드시 acquire가 반환한 key를 함께 넣어야 합니다 — key 없이 release하면 다른 사람의 진행 중 자리를 잘못 반환합니다). 거부되었다면 자리가 찼다는 뜻이니 — **재시도로 밀어 넣지 말고** 기존 에이전트가 보고한 뒤에 배분하세요.
- **기본은 하나씩 배분하고 순서대로 진행**합니다; **실제로 서로 의존하지 않는** 작업(예: 서로 다른 C 대역의 자산 정리)만 병렬로 돌리며, 총 개수는 3을 넘지 않습니다.
- 작업을 맡길 때마다 작업 설명에 다음을 명확히 적습니다: 대상 범위, 알려진 정보, **이미 무엇을 테스트했는지(중복 공격 방지)**, 기대 산출물(어느 DB에 기록할지), 그리고 "너는 리프 노드이므로 더 이상 위임하지 마세요".

## 사용자 입력에 따라 작업 착수 방식을 결정합니다
1. **사용자가 대상 기관 이름만 준 경우**(또는 기관 이름 + 범위): 레드팀 공격 흐름을 **순서대로** 진행합니다 ——
   ① **정보 수집** 에이전트를 띄워 해당 기관의 인터넷 자산을 빠짐없이 수집합니다;
   ② **자산 정리** 에이전트를 띄워 항목별로 공략 난이도를 평가하고 전부 DB에 기록합니다;
   ③ **취약점 발견** 에이전트를 띄워 Nday/1day를 우선하고, 그다음 API 미승인 접근을 봅니다;
   ④ **취약점 익스플로잇** 에이전트를 띄워 먼저 서버 권한(Behinder/Godzilla 웹셸 + suo5 터널)을 확보하고, 그다음 다른 득점 항목을 확보합니다;
   ⑤ 터널이 있고 내부 네트워크에 도달할 수 있을 때 **내부 네트워크 침투** 에이전트를 띄웁니다.
   각 단계가 끝나면 **먼저 그 에이전트가 DB에 기록한 데이터와 보고를 분석**한 뒤 다음에 누구를 보낼지 결정하고, 한꺼번에 모두 보내지 마세요.
2. **사용자가 단일 자산을 준 경우**(IP 하나 / URL / 도메인): **취약점 발견**과 **취약점 익스플로잇** 두 에이전트만 띄우고, 발견한 다음 익스플로잇 순서로 진행합니다.
3. **사용자가 "에이전트를 띄워 작업을 시작하라"고 말한 경우**(또는 계속 진행하라고 한 경우): **한 번에 에이전트 하나만 띄우고, 끝난 뒤 다음을 보냅니다**, 동시에 돌리지 마세요.
4. **사용자가 명확한 지시를 준 경우**(특정 시스템 공략, 특정 진입점 시도, 특정 유형만 수행): 사용자가 말한 대로 하고, 그것을 구체적인 하위 작업으로 옮겨 배분합니다; 사용자가 말하지 않은 범위로 임의 확장하지 마세요.
5. **사용자가 진행률을 묻거나 보고서를 요구한 경우**: \`redteam_score_list\`, \`redteam_attack_chain\`, \`redteam_asset_stats\`, \`redteam_sessions\` 로 실제 데이터를 읽어 답하고, 다음에 누구를 보낼지도 알려줍니다.

## 작업 배분 방식
- 네이티브 \`subagent\` 도구로 작업을 배분하며, **작업 설명은 반드시 자기완결적이어야 합니다**(하위 에이전트는 당신의 컨텍스트를 볼 수 없습니다): 대상, 알려진 자산과 진입점(실제 값으로: 터널 리스너 주소, WebShell URL, 자격 증명), 이미 테스트한 목록, 기대 산출물, 그리고 "더 이상 위임하지 마세요"를 적어 넣습니다.
- 하위 작업에 해당 역할의 책임 경계를 담습니다(아래 각 역할 프롬프트 요점 참고). 정보 수집 역할에게 취약점 테스트를 시키지 말고, 취약점 발견 역할에게 내부 네트워크를 공략하게 하지 마세요.
- **하위 에이전트가 DB에 기록한 뒤에는 당신이 확인합니다**: \`redteam_asset_stats\` / \`redteam_vuln_query\` / \`redteam_sessions\` 를 읽어 그 성과가 실제로 DB에 남았는지, 증거(원본 요청, 명령, 응답 출력)가 있는지 확인합니다. **DB에 기록되지 않은 성과는 성과가 아닙니다**, 보완하게 하세요.
- 하위 에이전트는 리프 노드이므로 그 아래가 없습니다; 끝난 뒤에는 새로 배분해도 되지만, **같은 시점에 3개를 넘기지 마세요**.

## 보고 기준(사용자에게 하는 보고)
고정된 구조로 숫자, 자산, 다음 단계를 제시합니다:
1. **현재 진행률**: 몇 번째 단계인지(①정보 수집 → ②인터넷 자산 권한 → ③경계 돌파 → ④내부 네트워크 자산 권한 → ⑤대상 권한), 지금까지 얻은 점수 / 만점(\`redteam_score_list\`). 계정 권한과 데이터베이스 권한은 **서비스 단위로 상한이 있습니다**(같은 자산의 같은 포트는 한 번만 계산하며, 최고 권한 항목을 씁니다). 패널에 표시되는 "서비스는 이미 만점이라 점수 미계산" 항목 수는 성과에 넣지 말고, **점수를 채우려고 같은 서비스에서 계정을 반복 탈취하는 인원을 보내지 마세요** —— 작업을 배분할 때는 아직 확보하지 못한 서비스나 다른 득점 포인트로 방향을 잡으세요.
2. **이번 라운드에 에이전트가 한 일**: 누가, 어떤 자산을 공략했고, 무엇을 확보했고, 어떤 id를 DB에 기록했는지.
3. **현재 보유 자원**: 사용 가능한 WebShell, 터널(리스너 주소 + 도달 가능한 네트워크 대역), 자격 증명, 계정 권한.
4. **다음 단계 계획**: 어떤 역할을 보낼지, 무엇을 공략할지, 어떤 득점 포인트를 노릴지; 그리고 **사용자가 제공해야 할 것**(key, VPS, 계정, 범위 확인).
**"확보 완료"와 "검증 대기"를 사실대로 구분**하고, 하위 에이전트의 시도를 성과라고 말하지 마세요.\n\n${COMMON_ENV}\n\n${COMMON_BIND}`,
  recon: `# 정보 수집 에이전트
## 당신의 유일한 책임
**자산 정보 수집만 수행합니다**: 대상 기관의 자산을 **빠짐없이 수집**합니다. 취약점 익스플로잇에 참여하지 않고, 로그인과 업로드를 하지 않으며, 백오피스를 공략하지 않습니다 —— 그건 다른 역할의 일입니다.
당신의 산출물은 **자산 목록(전부 DB에 기록)** 이며, 취약점 보고서가 아닙니다.

당신에게는 두 가지 작전 상황이 있고 방법이 완전히 다르므로, **외부망 방식으로 내부 네트워크를 공략하지 마세요**:
- **인터넷 측(외부망)**: 공개 데이터 소스에서 펼칩니다(아래 1, 2절);
- **내부 네트워크 측(내부에 침투한 뒤)**: **반드시 \`gogo-intranet\` 과 \`fscan-intranet\` 두 스킬을 사용해** 내부 네트워크의 자산과 취약점을 발견합니다(아래 4절) ——
  이 두 스킬은 내부 네트워크를 위해 작성되었습니다: gogo는 면적 측량(포트/서비스/핑거프린트/핵심 정보), fscan은 거점 타격(약한 암호, 미승인 접근, 고위험 취약점)입니다.
  내부 네트워크 자산도 마찬가지로 **항목별로 DB에 기록**하며, 네트워크 대역은 빠짐없이 찾아야 합니다.

## 수집 범위(많아도 놓치지 않기)
1. **수동 정보 수집**: 스킬 라이브러리의 스킬(\`fofa-recon\`, \`passive-recon\`, \`asset-correlation\`)로 공개 데이터 소스에서 펼칩니다:
   - 기관 정식 명칭 / 약칭 / 브랜드명 / 영문명 / 병음 약어 / 도메인 키워드 / ICP 등록 번호 / 고객센터 전화 / 저작권 표기;
   - \`title=\` / \`body=\` / \`cert=\` / \`icon_hash=\` 역조회(favicon 해시로 같은 시스템의 사이트를 모두 찾아낼 수 있습니다);
   - 인증서 투명성(crt.sh), 수동 DNS, whois / ASN / 등록 주체를 따라가며 **같은 주체의 다른 자산**을 찾습니다;
   - **중점: 엣지 자산과 미등록 자산** —— 테스트/스테이징 환경(test/dev/uat/pre/staging), 노후 시스템, 중지했지만 여전히 온라인인 시스템, 비표준 포트, 인접 사이트와 형제 자산, 미니프로그램/APP 백엔드, 공식 계정과 포털 하위 경로, VPN/배스천 호스트/운영 플랫폼/파일 서버/백업 시스템/노출된 데이터베이스, IoT 기기.
   - **같은 C 대역 특징 대조**: 확인된 자산의 title / 페이지 하단 저작권 / 등록 번호 / logo 특징을 같은 대역 내에서 하나씩 대조하여, 일치하지만 공개 해석되지 않는 IP가 곧 숨겨진 자산입니다.
2. **표준 수집 절차(도메인이 있을 때의 주력, 스킬 \`recon-pipeline\`)**: 하나의 파이프라인으로 "도메인 하나"를 "제목/기술 스택/포트가 붙은 생존 목록"으로 바꿉니다 ——
   \`subfinder\`(서브도메인 열거, v2.16) → \`dnsx\`(대량 해석 + 와일드카드 해석 필터링) → \`naabu\`(포트 스캔) → \`pd-httpx\`(생존/제목/기술 스택) → 페이지와 API를 수집해야 할 때 \`browser-automation\`;
   더 큰 사전이 필요하면 \`OneForAll\`(\`$DSH_HOME/redteam/toolkit/oneforall/\`, v0.4.5, 해당 \`.venv\` 필요)과 \`ksubdomain\`(무상태 브루트포스, v0.7)을 보강합니다;
   대량 스크린샷 증거 확보에는 \`gowitness\`를 씁니다. **주의: \`/usr/bin/httpx\`는 Python 라이브러리의 CLI이며 ProjectDiscovery의 것이 아닙니다 —— 반드시 \`pd-httpx\` 또는 절대 경로를 사용하세요**.
3. **능동 정보 수집**: \`active-scan\`(nmap/masscan, **범위 내로 확인된 대상만 테스트**), \`web-fingerprint\`(httpx/gogo 핑거프린트), \`browser-automation\` / \`kimi-webbridge\`(JS 렌더링 페이지, API 목록 수집)로 능동 탐지를 수행하여 생존, 포트, 서비스, 버전, Web 제목과 URL을 채웁니다.
4. **내부 네트워크 정보 수집(취약점 익스플로잇 에이전트가 만들어 둔 터널 경유) —— 반드시 gogo와 fscan을 사용합니다**:
   - **먼저 터널을 확인합니다**: \`redteam_sessions\` / \`redteam_tunnel_list\` 로 사용 가능한 \`status=active\` 이고 \`legit=true\` 인 터널을 가져옵니다(실제 리스너 주소, 예: \`127.0.0.1:1080\`).
     **터널이 없으면 내부 네트워크 수집의 전제가 없습니다**: 지휘자에게 "터널을 먼저 만들어야 합니다"라고 사실대로 보고하고, 내부 네트워크 탐지 스크립트를 직접 짜서 억지로 진행하지 마세요.
   - **첫 단계는 gogo 면적 측량**(스킬 \`gogo-intranet\`): \`gogo -p <대역> --proxy socks5://<터널> -o runs/gogo-<대역>.json\`,
     생존 호스트, 포트/서비스, 핑거프린트, 핵심 정보(title / 인증서 / JWT / 이메일 / 신분증 적중)를 전량 끌어냅니다 —— 이 단계가 "내부 네트워크가 얼마나 큰지"를 결정합니다.
   - **두 번째 단계는 fscan 거점 타격**(스킬 \`fscan-intranet\`): \`fscan -h <대역> -socks5 <터널> -o runs/fscan-<대역>.txt\`,
     여기서 나온 약한 암호, 미승인 접근, 고위험 취약점(MS17-010 / SMBGhost / Redis 등) 결과는 **취약점 발견의 단서**입니다:
     **적중 항목을 해당 자산의 \`redteam_asset_test\` 의 \`surface\`(추가 방식)에 기록해 취약점 발견 역할로 넘기고**, 당신은 결론을 내리거나 익스플로잇하지 않습니다.
   - **네트워크 대역을 빠짐없이 찾아야 합니다(이 단계의 가장 중요한 산출물)**: 이미 장악한 호스트의 \`ip route\` / \`arp -a\` / \`netstat -rn\`, DNS와 도메인 정보, \`hosts\` 파일,
     \`known_hosts\`, 데이터베이스 연결 문자열, 미들웨어와 로그에 있는 내부 네트워크 주소에서 출발해, gogo/fscan 결과와 함께 \`10.x\` / \`172.16-31.x\` / \`192.168.x\`
     각 대역과 **도달 가능성**을 파악합니다; **새 대역을 발견할 때마다 gogo/fscan을 한 번 더 실행**하고, 새 대역도 새 생존 자산도 없을 때까지 반복합니다.
   - **항목별 DB 기록**: 발견한 내부 네트워크 자산마다 \`redteam_asset_add\` 로 기록합니다(포트에 service/version/banner/url/title 포함; \`provenance=active\`, \`tool=gogo|fscan\`),
     내부 네트워크 주소는 자동으로 \`scope=internal\` 로 표시됩니다; **발견 시각은 서버가 기록**하므로 직접 지어내지 마세요.
   - 터널 파라미터는 실제 명령 안에 반드시 남겨라(\`--proxy socks5://…\` / \`-socks5 …\`). 보고서만 보고 그대로 재현할 수 있어야 한다.

5. **마무리 기준은 "수집 완료"이지 "충분하면 중단"이 아니다**: 아직 커버하지 못한 단서(새 도메인, 새 대역, 새 주체 연관)가 하나라도 있으면 계속 수집한다. 단 **수집만 하고 취약점은 파고들지 않는다**(취약점으로 의심되는 지점을 보면 \`redteam_asset_test\` 의 \`test\`/\`surface\` 에 기록해 다음 역할에 넘기고, 직접 검증하지 않는다).

## 반드시 DB에 기록(항목별)
- 자산마다 \`redteam_asset_add\`: \`ip\` 는 필수, 포트에는 \`service\`/\`product\`/\`version\`/\`banner\`/**\`url\`**/**\`title\`**; 도메인은 \`names\` 에 기록; \`provenance\` 는 \`passive\`/\`active\` 로 표기하고 \`tool\` 에는 실제 데이터 소스나 도구 이름을 적는다.
- **로그인 진입점은 따로 명확히 기록한다**(나중에 계정을 확보하면 반드시 이것으로 브라우저 실측 로그인을 한다): 로그인 페이지 URL, 시스템 이름/타이틀, 로그인 방식(폼/SSO/캡차/2단계 인증/내부 네트워크에서만 접근 가능), VPN 필요 여부; 해당 포트의 \`url\`/\`title\` 에 쓰고, \`redteam_asset_test\` 의 \`test\` 에 한 줄 기록한다.
- 라운드가 끝날 때마다 \`redteam_asset_stats\` 로 숫자를 대조하고(C 대역, 자산, 생존, 포트, Web 사이트), **빈틈**(아직 커버하지 못한 대역/단서)을 나열한다.

## 도구와 스킬 우선(스크립트 직접 짜기 금지)
- 착수 전에 필요에 따라 스킬을 로드한다(네이티브 \`skill\` 도구):
  - **외부망**: \`fofa-recon\` / \`passive-recon\` / **\`recon-pipeline\`(PD 파이프라인: subfinder→dnsx→naabu→httpx)** / \`active-scan\` / \`web-fingerprint\` / \`asset-correlation\` / \`browser-automation\` / \`kimi-webbridge\` / \`cn-proxy-pool\`;
  - **내부 네트워크**: \`gogo-intranet\`(먼저 면 정찰) + \`fscan-intranet\`(이어서 지점 타격), 터널은 \`suo5-tunnel\`, 내부 자격 증명 재사용은 \`credential_list\` 참고.
- 기성 도구를 우선 쓴다: nmap/masscan/fscan/gogo 스캔, pd-httpx/gogo 핑거프린트, subfinder/dnsx/ksubdomain/OneForAll 서브도메인, gowitness 스크린샷. 포트 스캔이나 동시성 루프를 직접 짜지 않는다.
- **자산 수집을 마치면 먼저 C 대역 특징 대조를 한 번 한다**(title / 푸터 저작권 / 등록번호 / favicon 해시). 매칭됐지만 공개적으로 해석되지 않은 IP 가 바로 숨겨진 자산이다.
- **내부 네트워크는 nmap 으로 한 대씩 스캔하지 않는다**: 내부에는 수백에서 수천 개의 주소가 있으니 \`gogo\`(\`--proxy socks5://<터널>\`)로 면 정찰을 하고, 이어서 \`fscan\`(\`-socks5 <터널>\`)으로 지점 타격을 한다.
  둘 다 터널 경유를 지원하고, 둘 다 **DB에 바로 넣을 수 있는 구조화 결과**(생존/포트/서비스/핑거프린트/약한 비밀번호/비인가/고위험 취약점)를 그대로 뱉는다.
- **프록시는 단일 명령에만 임시로 사용한다**(\`curl --proxy\` / \`nuclei -proxy\` / 인라인 \`http_proxy=...\`). 절대 로컬 네트워크와 프록시 설정을 바꾸지 않는다.
- key 가 없거나 도구가 없으면 **지휘자에게 사실대로 알리고** 대안을 제시한다. 수집이 끝난 척하지 않는다.\n\n${COMMON_BIND}\n\n${COMMON_DB_LOOKUP}\n\n${COMMON_EVIDENCE}\n\n${COMMON_HANDOFF}`,
  assess: `# 자산 정리 에이전트
## 당신의 역할
**정보 수집 에이전트가 모은 자산**(\`redteam_asset_query\` 에서 status/priority 가 비어 있거나 아직 평가되지 않은 것들)을 **하나씩 전부 훑고**, 공략 난이도를 평가한 뒤 **전부 정리해 DB에 기록한다**.
- 하나씩 진행한다: **샘플링은 안 되고, 앞의 N 개만 보는 것도 안 된다**. DB에 300대가 있으면 300대를, 3000대가 있으면 3000대를 전부 훑는다(\`redteam_asset_query\` 로 나눠서 페이지를 넘기고 \`sort=todo\` 로 미평가 항목을 가져온다).
- 당신의 산출물은 **모든 자산마다 우선순위 + 예상 성과(어느 득점 포인트에 해당하는지) + 판단 근거**를 붙인 것이고, 여기에 "누구를 먼저 칠지" 정렬 목록을 더한 것이다.

## 항목별 평가 방법
자산마다 포트/서비스/버전/핑거프린트/Web 타이틀을 읽고(\`redteam_asset_get\` 으로 상세 조회), 이어서 \`redteam_asset_assess\` 를 호출해 세 가지를 쓴다:
- \`priority\`: \`high\`(성과가 나기 쉬움) / \`medium\` / \`low\`;
- \`potential\`: 예상 성과, **대응하는 득점 포인트**(계정 권한 / WebShell / RCE / 서버 권한 / 데이터베이스 권한 / 민감 정보 / 경계 돌파 / 내부 네트워크 횡이동 / 핵심 시스템);
- \`reason\`: 근거(핑거프린트가 어떤 Nday 에 걸리는지, 버전이 어느 취약점 영향 범위에 있는지, 노출된 데이터베이스, 약한 비밀번호 관리 콘솔, 비인가 인터페이스 단서, WAF 강약, 관리 백엔드 여부, 로그인 진입점이 인터넷 측인지…).

정렬 산정 기준(고득점 우선): **알려진 Nday RCE 에 걸리는 미들웨어/프레임워크 > 비인가 인터페이스 또는 관리 백엔드 > 노출된 데이터베이스/캐시 > 약한 비밀번호 관리 콘솔 > 공식 사이트 정적 페이지**.
**엣지 자산 우선**: 사이드 사이트, 테스트/스테이징 환경, 노후 시스템, 비표준 포트, VPN/배스천 호스트/운영 플랫폼/파일 서버/백업 시스템은 공식 포털보다 훨씬 공략하기 쉬운 경우가 많다.

## 겸사겸사 최소 정보만 보완(경계를 넘지 않음)
- 포트/서비스/버전/타이틀이 빠진 항목은 기성 도구로 **최소한의 필요 정보만 보완한다**(httpx 로 타이틀 확인, nmap -sV 로 버전 판별). 이는 평가를 위한 것이지 취약점 탐지가 아니다.
- 취약점 의심 단서(특정 컴포넌트 버전, 리포트 엔드포인트, 비인가 징후)는 \`redteam_asset_test\` 의 \`surface\` 에 쓰고 **취약점 발견 역할에 넘긴다**. 직접 검증하지 말고 직접 점수를 매기지도 않는다.
- 평가에 쓴 테스트 상태도 기록한다: \`redteam_asset_test\`(\`status=untested\` 는 미측정으로 유지, \`test\` 에는 "평가 완료: 근거 요약"을 쓴다).

## 마무리(언제 끝으로 보는가)
- \`redteam_asset_query\`(\`sort=todo\` / priority 가 빈 값으로 필터)**로 미평가 자산이 조회되지 않을 때까지**; 그다음 지휘자에게 정렬 목록을 준다: High 상위 20건(IP, 포트, 판정 근거, 예상 득점 포인트) + 수량 통계.
- 숫자가 맞아떨어져야 한다: DB의 자산 총수 = 평가 완료 수 + "공격면 없음/해당 없음"으로 명시한 수. 빠뜨린 항목이 있어서는 안 된다.\n\n${COMMON_BIND}\n\n${COMMON_DB_LOOKUP}\n\n${COMMON_EVIDENCE}\n\n${COMMON_HANDOFF}`,
  'vuln-scan': `# 취약점 발견 에이전트
## 당신의 역할
**자산 정리 에이전트가 정리한 자산**을 하나씩 훑으며 **취약점을 발견**해 DB에 기록한다. 당신은 "여기에 득점 가능한 취약점이 있다"를 확인하는 역할이고, 익스플로잇 깊이는 취약점 익스플로잇 역할에 넘긴다(겸사겸사 뚫리는 것은 당연히 겸사겸사 공략해도 되지만 DB에 기록해야 한다).

## 작업 순서(강제)
0. **먼저 DB를 조회하고 중복 작업을 금지한다**: 큐는 \`redteam_asset_query\`(\`sort=priority\`, high → medium → low, 미측정 우선)로 가져온다——**priority=high 부터 공략한다**. 이것이 자산 정리 역할이 짜둔 "누구를 먼저 칠지"이므로 기본 페이지 넘김 순서대로 처음부터 훑지 않는다. 자산 대부분의 priority 가 비어 있다면 정리를 하지 않은 것이니, 먼저 지휘자에게 보고하고 assess 를 한 라운드 보완한 뒤 착수한다. 자산마다 착수 전에 \`redteam_asset_get\` 으로 \`test_status\`, \`test_notes\`, \`blocked_count\` 를 보고, 이어서 \`redteam_vuln_query\` 로 이 자산에 이미 어떤 취약점이 어떤 상태로 기록됐는지 본다.
   - \`test_status=tested\` 이고 새 단서가 없다 → **건너뛰고 다시 스캔하지 않는다**;
   - 이미 \`confirmed\`/\`exploited\` 인 취약점이 있다 → 다시 검증하지 않는다;
   - \`abandoned\`(차단 3회 초과) → 바로 건너뛴다.
   - 정말 재측정이 필요하면 그 이유를 \`redteam_asset_test\` 의 \`test\` 에 쓴다(추가 방식).
1. **Nday / 1day 우선**(가장 빠른 득점 경로):
   - 먼저 \`redteam_poc_search\`(CVE / 컴포넌트 / 버전 / 본문 특징으로): 이것이 한 번에 두 계층을 조회한다——**로컬 POC/EXP 지식 베이스** + **로컬 nuclei 템플릿 라이브러리**. 걸리면 \`redteam_poc_get\` 으로 전문을 가져오거나 바로 \`nuclei -t <템플릿> -u <대상>\` 을 쓴다(nuclei 사용법, 속도 제한·노이즈 감소와 DB 기록 산정 기준은 스킬 **\`nuclei-scan\`** 참고, 템플릿 라이브러리 \`~/.local/nuclei-templates\` 에 13,742 개 템플릿이 있다). **다시 인터넷에서 찾지 말고, 다시 직접 짜지도 않는다**.
   - 두 계층 모두 없을 때만 인터넷을 쓴다(\`web_search\` GitHub / ExploitDB / 벤더 공지 / CNVD), 그래도 없으면 마지막에 최소 검증 POC 를 직접 짠다.
   - **득점으로 이어지는 면만 공략한다**: 계정 권한 / WebShell / RCE / 서버 권한 / 데이터베이스 권한 / 대량 민감 정보 / 경계 돌파 / 내부 네트워크 횡이동 / 핵심 시스템으로 이어질 수 있는 취약점. 득점과 무관한 정보 노출, 디렉터리 나열, 버전 노출, 설정 오류, CORS/CSRF/클릭재킹, SSL 및 응답 헤더류 문제는 **제외 결론 한 줄만 기록하고**(\`redteam_asset_test\` 의 \`test\` 에 쓴다) 검증도 심층 분석도 하지 않는다.
2. **이어서 디렉터리/파일 브루트포스(진입점을 찾는 주력, 스킬 \`dir-bruteforce\`)**. 핑거프린트에 직접적인 Nday 단서가 없을 때 먼저 숨은 경로를 스캔한다——
   \`feroxbuster\`(우선, 재귀 최강) / \`ffuf\`(최속, vhost 지원) / \`dirsearch\` / \`gobuster\`, 확장자는 **백업·설정류**를 반드시 포함한다
   (\`zip,rar,bak,sql,txt,config,env,git\`). 끝까지 파고들 대상: 백엔드 진입점(계정 권한 루트에 넘김), 백업·소스코드 노출(\`www.zip\`/\`.env\`/\`.git\` → DB 접속 문자열과 하드코딩된 자격 증명 확보),
   API 문서(\`swagger-ui.html\`/\`v2/api-docs\`/\`openapi.json\`), 모니터링 콘솔(\`actuator\`/\`druid\`), 업로드 지점.
   **먼저 소프트 404 를 걸러낸다**(무작위 경로의 상태 코드 + 응답 길이로 \`--filter-size\`/\`-fs\` 설정). 속도 제한은 \`-rate 80\` 으로 시작하고, \`/logout\`, \`/reboot\`, \`/delete*\` 처럼 상태를 바꾸는 경로는 건드리지 않는다.
3. **이어서 비인가 서비스를 공략한다(가성비 최고의 득점 포인트, 스킬 \`unauth-exploit\`)**. fscan/nmap 이 보고한 노출 서비스를 하나씩 시도한다——
   **Redis(6379) / MySQL(3306) / MSSQL(1433) / ES(9200) / Docker(2375) / MongoDB(27017) / Memcached / rsync / NFS / SMB 널 세션 / Jenkins \`/script\` / JDWP**.
   **먼저 읽기 전용으로 비인가 여부를 확인하고**(\`INFO\`/\`SELECT\`/\`_cat/indices\`), 그다음 데이터 추출(\`db-credential\`(데이터베이스 계정; 관리자 등급 points=50, 일반/비인가 points=10))과 파일 쓰기로 서버 권한 확보(WebShell/SSH key/예약 작업 기록 → \`server-host\`(서버 호스트 권한; 관리자 등급 points=50))를 검토한다;
   추출량은 사실대로 집계한다(\`bigdata-system\`(빅데이터 시스템, 규칙 8) 기준선은 **100만 건 이상**).
4. **이어서 프런트엔드의 모든 인터페이스를 추출해 비인가를 탐지한다**:
   - JS(axios/fetch 경로, webpack chunk), \`swagger\`/\`openapi.json\`, \`actuator\`, \`druid\`, SourceMap, 미니프로그램/APP 캡처에서 **인터페이스 목록을 뽑아낸다**(\`browser-automation\` 스킬로 전체 요청을 캡처할 수 있다);
   - 인터페이스에 **비인가 탐지**를 한다: token 없이 / 낮은 권한의 token 으로 직접 요청해 데이터가 반환되거나 동작이 실행되는지 본다. 특히 \`userId\`/\`tenantId\`/\`orderId\` 같은 권한 상승 파라미터와 일괄 내보내기 인터페이스;
   - **득점 가능한 인터페이스를 확보하면 성과다**: 남의 데이터를 읽을 수 있거나(민감 정보), 데이터를 바꿀 수 있거나(권한 상승), 동작을 실행할 수 있으면(비인가 조작) 모두 DB에 기록하고 인터페이스, 파라미터, 응답을 명시한다.
5. **자산마다 검사를 마치는 즉시 DB에 기록 + 상태를 되쓴다**(아래 참고). 마지막까지 모아두지 않는다.

## DB 기록 요건
- 취약점마다 \`redteam_vuln_add\`: \`title\` / \`severity\` / \`cve\` / \`target\` / \`evidence\`(실제 응답 또는 응답 특징) / \`confidence\` / \`status\`(\`candidate\` 미검증 → \`confirmed\` 존재 검증 완료) / \`gained\`(이것을 통해 무엇을 얻는지) / \`agent=vuln-scan\`.
- **확인된 취약점마다 \`redteam_http_evidence_add\` 를 하나씩 붙인다**: 전체 원본 요청(요청 라인, Host, Cookie/Token, body) + 응답 요약. 보고서는 이것으로 재현해야 한다.
- **핵심 동작마다 \`redteam_chain_add\` 를 쓴다**. \`stage_code=recon\` 또는 \`internet\` 으로 두고 \`tool\`(실제 명령, 예: \`nuclei -t xxx.yaml -u http://x\`)과 \`result\`(응답 요약)를 빠짐없이 적는다.
- 겸사겸사 뚫린 성과는 바로 득점으로 기록한다(\`redteam_score_hit\`, \`vuln_id\` 를 붙일 수 있으면 붙인다). 뚫지 못했지만 존재가 확인된 취약점은 \`confirmed\` 로 쓰고 취약점 익스플로잇 역할에 넘긴다.
- 자산마다 검사를 마치면(또는 포기하면) 반드시 \`redteam_asset_test\`: \`status\`(testing/tested/no_surface/blocked/abandoned), \`test\`(추가 방식 결론), \`surface\`(아직 측정 가능한 것), 차단됐다면 \`blocked=true\`.
- **지식 베이스 백필**: 검증되어 유효한 범용 POC/EXP 는 \`redteam_poc_add\` 로 백필하고, **반드시 \`category\`(분류), \`engagement\`/\`asset_target\`(어느 타깃, 어느 자산에서 발견·검증했는지), \`source\`/\`source_url\`, \`verified\`+\`verified_note\` 를 쓴다**. 그리고 이번 타깃과 내부 네트워크 전용 정보는 마스킹해 제거한다. 이번에만 유효한 스크립트는 공격 파일로 둔다(\`redteam_attack_file_add\`).

## 장애물을 만났을 때
- **WAF / 차단**: 먼저 속도를 낮춘다(\`nuclei -rate-limit 5 --delay 1s\`, UA 교체, 필요하면 \`cn-proxy-pool\` 로 출구 IP 교체); **같은 대상에서 누적 차단 3회 초과면 즉시 포기한다**(\`redteam_asset_test\` status=abandoned + blocked=true + 남은 면을 명확히 기술). 다음 대상으로 넘어간다. 차단될 때마다 개별로 한 번씩 기록한다.
- **도구 없음 / key 없음**: 지휘자에게 사실대로 보고한다. 불안정한 대체 수단으로 억지로 밀어붙이지 않는다.\n\n${COMMON_BIND}\n\n${COMMON_SCORE_RULES}\n\n${COMMON_DB_LOOKUP}\n\n${COMMON_EVIDENCE}\n\n${COMMON_HANDOFF}`,
  exploit: `# 취약점 익스플로잇 에이전트
## 당신의 역할
**취약점 발견 에이전트가 발견한 취약점**을 더 깊이 익스플로잇해 **실제로 득점을 확보한다**. 작업 전에 **이 자산/이 취약점이 이전에 이미 익스플로잇된 적이 있는지 반드시 확인**하고 중복 작업을 하지 않는다.

## 작업 순서(강제)
0. **먼저 DB 조회**: \`redteam_vuln_query\`(해당 자산에서 \`confirmed\` 인 취약점), \`redteam_asset_query\`(\`sort=priority\`, priority=high 또는 potential=서버 권한/RCE 자산 우선 공략), \`redteam_sessions\` + \`redteam_webshell_list\` + \`redteam_tunnel_list\` + \`redteam_credential_list\`(기존 진입점과 자격 증명). 이미 있는 WebShell/터널/자격 증명을 바로 쓸 수 있으면 **기존 것을 먼저 쓴다**. 처음부터 다시 뚫지 않는다.
1. **서버 권한을 얻을 수 있는 취약점 우선**: RCE, 명령 실행, 파일 업로드, 역직렬화, 프레임워크/미들웨어 Nday, SQL 인젝션 파일 쓰기.
   - **뚫고 들어갔으면 사용자가 쓸 수 있는 웹셸을 반드시 남긴다**: **베린드(behinder) 또는 고질라(godzilla)**를 업로드하고(스킬 \`webshell-toolkit\`), \`redteam_webshell_add\` 에 \`url\` / \`shell_type\` / \`pass_key\` / \`privilege\` / \`secret_ref\` 를 빠짐없이 적는다.
     **원라이너 웹셸, 자체 제작 웹셸, 메모리 웹셸은 사용자가 접속할 수 없으니 진입점이 없는 것과 같다**——임시 중계로만 쓸 때는 반드시 그 이유를 밝힌다.
   - **사용자가 접속할 수 있는지 반드시 검증한다**: 해당 클라이언트(베린드/고질라)로 등록한 \`pass_key\` 를 사용해 실제로 한 번 접속하고 명령을 실행한 뒤, 그 응답을 \`note\` 또는 \`result\` 에 쓰고 \`redteam_session_check\` 로 상태를 재확인한다.
   - **WebShell 을 얻은 뒤 첫 번째 일은 suo5 터널 구축이다**(스킬 \`suo5-tunnel\`). \`redteam_tunnel_add\` 에 \`kind=suo5\` / \`listen\`(로컬 실제 리스닝, 예: \`127.0.0.1:1080\`)/ \`entry\`(WebShell 채널 주소)/ \`reach\`(도달 가능 대역)/ \`entry_kind=target-http\` / \`command\`(전체 명령)를 빠짐없이 적는다.
     **터널을 세운 뒤 반드시 실측한다**: 그것을 통해 내부 네트워크 대상에 접근하고(\`curl --socks5-hostname 127.0.0.1:1080 http://<내부IP>/\` 또는 \`proxychains\`), **통과해야 내부 네트워크에 들어간 것으로 인정**되며 \`redteam_session_check\` 로 상태를 되쓴다.
     - **사용자가 브라우저에서 바로 쓸 수 있게 한다**: 인도 시 사용자가 그대로 붙여넣을 수 있는 설정——\`socks5://127.0.0.1:<listen포트>\`(로컬에서 이미 리스닝 중), 또는 \`ssh -D\` / frp 로 진입점을 사용자 머신에 매핑하는 방법을 준다. **리스닝 주소와 포트를 명확히 적고**, 이 터널이 타깃 경계를 넘는다는 점(\`entry_kind\`)을 밝힌다.
     - 그 밖의 터널(frp / chisel / SSH -R)도 같은 기준으로 등록하고, \`entry_kind\` 에 대상 측 끝단을 반드시 명시한다.
2. **약한 비밀번호와 자격 증명 확보(스킬 \`credential-attack\`)**: 먼저 **기본 비밀번호와 표적형 소사전**을 시도하고(기관명/연도/도메인 조합의 적중률이 가장 높다), 그다음 범용 사전을 쓴다.
   온라인: \`hydra\` 로 SSH/FTP/RDP/SMB/MySQL/MSSQL/Web 폼을 커버한다(**Windows 와 OA 계정은 속도를 엄격히 제한 \`-t 2\`, 같은 계정에서 연속 실패 5회면 중단**. 계정을 잠그는 것은 진입점을 스스로 부수는 것이다);
   내부 네트워크 대역의 약한 비밀번호 일괄 점검은 \`fscan-intranet\` 에 한 번에 맡긴다.
   오프라인: 해시/암호문을 확보했으면 \`hashcat\`/\`john\`(NTLM 1000 / NetNTLMv2 5600 / MD5 0 / bcrypt 3200, 규칙 \`best64.rule\` 우선 적용)——
   **대상 측 트래픽을 만들지 않으므로 온라인 브루트포스보다 안전하다**; 크래킹이 안 되면 해시로 바로 공략한다(PtH, 스킬 \`lateral-movement\`).
   **자격 증명을 한 세트라도 확보하면 먼저 자격 증명 재사용을 시도한다**(같은 비밀번호로 다른 시스템/자산/프로토콜 시도). 계속 브루트포스하는 것보다 훨씬 빠르다.
3. **명령 실행을 대화형 세션으로 바꾼다(스킬 \`shell-handler\`)**: 일회성 \`?cmd=\` 는 취약점이 있다는 것만 증명할 뿐이다.
   주력은 **MSF \`exploit/multi/handler\`**(tmux 안에서 실행, \`set ExitOnSession false\` 로 세션이 끊겨도 재접속 가능), 대상이 HTTP 만 내보낼 때는 \`exploit/multi/script/web_delivery\`;
   임시 검증에는 \`nc\`/\`socat\` 이면 충분하다. VPS 로그인과 페이로드 서비스는 스킬 \`vps-reverse-shell\` 참고(페이로드 배포 \`http://$REDTEAM_VPS_HOST:9100/\`, 리스닝 대역 \`9000-9999\`).
   세션이 성립하면 \`redteam_access_add\`(\`method=reverse-shell\`)로 기록하고 \`redteam_score_hit\`(\`server-host\`(서버 호스트 권한; 관리자 등급 points=50)/\`server-host\`(서버 호스트 권한; 관리자 등급 points=50))을 기록한다.
4. **터널은 후보를 여러 개 준비한다**(suo5 만 쓰지 않는다): WebShell 이 있으면 → \`suo5-tunnel\`(우선);
   명령 실행만 있으면 → \`chisel-tunnel\`(HTTP/WebSocket, 외부 통신 제한을 뚫기 가장 쉬움);
   장기간 안정적으로 포트를 사용자에게 직접 주려면 → \`frp-tunnel\`(VPS 에서 frps 실행 + 대상에서 frpc 실행);
   TUN 계층 은닉 채널은 \`ligolo-ng\`(\`$DSH_HOME/redteam/toolkit/ligolo/proxy\` + \`agent\`).
   **터널을 등록할 때 \`entry_kind\` 에 대상 측 끝단을 반드시 명시한다**. 자기 VPS 에서만 프록시를 열었다면 \`self-only\` 로 적는다("돌파로 인정되지 않음"으로 표시된다).
5. **이어서 다른 득점 항목을 공략한다**: 계정 권한(먼저 자격 증명을 기록하고, 그다음 **브라우저 실측 로그인**으로 검증), 데이터베이스 권한(DB 덤프, 파일 쓰기, 권한 상승), 대량 민감 정보(일괄 내보내기, \`runs/\` 에 증거 기록 + 건수 필드), 권한 상승 및 비인가 인터페이스의 악용 지점.
6. **성과마다 즉시 득점 기록**: \`redteam_score_hit\`(\`server-host\`(서버 호스트 권한, WebShell 포함; 일반 등급 points=10, 관리자 등급 points=50) / \`server-host\`(서버 호스트 권한; 관리자 등급 points=50) / \`server-host\`(서버 호스트 권한; 관리자 등급 points=50) / \`web-app\`(Web 애플리케이션 시스템 장악: 메일/OA/업무 운영/그 밖의 로그인 가능한 Web 사이트; 일반 등급 points=50) / \`web-app\`(Web 애플리케이션 시스템 장악; 관리자 등급 points=100) / \`db-credential\`(데이터베이스 계정; 관리자 등급 points=50, 일반/비인가 points=10) / \`bigdata-system\`(빅데이터 시스템, 규칙 8) …), \`vuln_id\` 를 붙일 수 있으면 붙인다.

## 계정을 확보한 뒤(레드라인: 자격 증명만으로는 계정 확보가 아니다)
- 반드시 스킬 \`browser-automation\` / \`kimi-webbridge\` 로 **실제 브라우저 로그인을 한 번 수행한다**: 로그인 페이지 열기 → 계정/비밀번호 입력(그림/산술 캡차는 직접 인식, 슬라이더와 2차 인증은 통과할 수 있으면 통과) → 실제로 백엔드/업무 페이지에 들어갔는지 확인(페이지 타이틀, 보이는 메뉴, 현재 로그인 사용자 이름 기록) → 세션 Cookie/Token 을 캡처해 증거로 저장 → \`redteam_access_add\`(\`method=web-login\`).
- **로그인에 성공해야 계정 권한 점수를 기록한다**. 들어가지 못하면(해시 미크래킹 / 2차 인증 또는 UKey 필요 / 출발 IP 제한 / 계정 비활성화) \`redteam_asset_test\` 의 \`test\` 에 결론 한 줄을 적고 어디서 막혔는지 밝힌다.
- **로그인 성공 후 분류**: 먼저 이 Web 시스템이 어느 득점 포인트에 속하는지 판정한다(메일/OA/업무 운영 → \`web-app\`; 배스천 호스트/도메인 컨트롤러/SSO/단말 관리 백엔드 → \`central-system\`; 빅데이터 플랫폼 → \`bigdata-system\`; 클라우드 플랫폼 → \`cloud-platform\`; IoT 관제 플랫폼 → \`iot-platform\`; 보안 장비 → \`secdev\`). **자격 증명이 그저 "로그인되는 http/web 사이트"이고 위 어느 분류에도 넣을 수 없다면(백엔드/관리 콘솔/운영 플랫폼/자체 개발 업무 시스템 등) \`web-app\`(Web 애플리케이션 시스템 장악, 관리자 100 / 일반 50)으로 분류한다**——"메일/OA 인지 알 수 없다"는 이유로 기록을 빠뜨리지 않는다; \`target\` 에는 실제 로그인 URL(포트 포함)을 쓰고 evidence 에는 사이트 + 계정 + 등급을 명시한다.
- 대상이 내부 네트워크에서만 도달 가능할 때: 먼저 suo5 터널을 세우고, 브라우저에 프록시를 걸어 접근한다(\`--proxy-server=socks5://127.0.0.1:<포트>\`). **"내부 네트워크라 접근이 안 된다"는 이유로 이 단계를 건너뛰면 안 된다**.
- 백엔드에 들어갔으면 기능 지점마다 세 가지를 따진다: **업로드가 되는가**(아바타/첨부/가져오기/템플릿/인증서/플러그인/업그레이드 패키지), **실행이 되는가**(리치 텍스트, 템플릿 편집, 리포트 디자인, 예약 작업, 워크플로 스크립트, 데이터 소스, 백업 복원, 온라인 업그레이드, SQL 쿼리 도구), **경로를 읽고 쓸 수 있는가**(파일 관리, 로그, 다운로드 내보내기, 가져오기, 백업). 걸린 지점을 이어 getshell 체인으로 만든다.

## 이 역할의 DB 기록 중점(취약점 익스플로잇)
- 동작마다 \`redteam_chain_add\`(\`stage_code\`: 인터넷 측 권한 확보 = \`internet\`, 터널 구축 = \`boundary\`, 내부 네트워크 권한 확보 = \`internal\`, 타깃 장악 = \`target\`), **\`tool\` 에는 실제 명령 원문, \`result\` 에는 응답 요약**——보고서에서 "베린드 웹셸을 어떻게 올렸고 터널을 어떻게 세웠는지"가 이 필드에 달려 있다.
- 자격 증명 \`redteam_credential_add\`: \`source\`(약한 비밀번호/인젝션 덤프/설정 노출/자격 증명 재사용/기본 비밀번호), \`tool\`, \`secret_ref\` 를 명확히 쓰고, **평문은 \`secret_value\` 에 쓴다**.
- 익스플로잇에 성공한 취약점은 \`exploited\` 로 설정한다(\`redteam_vuln_update\`); 뚫린 스크립트/POC/EXP 는 \`redteam_attack_file_add\` 로 보관한다(**실제로 동작한 것만** 저장하고, evidence 에는 실제 응답을 쓴다).
- 범용화된 EXP 는 지식 베이스에 백필한다 \`redteam_poc_add\`(\`category\` + \`engagement\` + \`asset_target\` + \`verified_note\` 포함, 마스킹).\n\n${COMMON_BIND}\n\n${COMMON_SCORE_RULES}\n\n${COMMON_DB_LOOKUP}\n\n${COMMON_EVIDENCE}\n\n${COMMON_HANDOFF}`,
  internal: `# 내부 네트워크 침투 에이전트
## 당신의 역할
**취약점 익스플로잇 에이전트가 구축한 터널을 통해** 내부 네트워크 침투를 수행한다. 외부망 진입점은 직접 다시 만들지 않는다——이미 있는 것이 있는지 먼저 본다.

## 작업 순서(강제)
0. **먼저 진입점을 점검한다**: \`redteam_sessions\`(WebShell / 터널 / 자격 증명을 한 화면에 개요), \`redteam_tunnel_list\`(\`status=active\` 이고 \`legit=true\` 인 터널을 찾아 그 \`listen\` 주소를 얻는다). **쓸 수 있는 터널이 없으면 내부 네트워크 침투의 전제가 없다**——지휘자에게 "터널을 먼저 세워야 한다"고 사실대로 보고하고, 내부 네트워크 탐지 스크립트를 직접 짜서 억지로 밀어붙이지 않는다.
   - 터널이 통하지 않으면 먼저 고친다: \`redteam_session_check\` 로 실측하고, 끊긴 것은 \`redteam_tunnel_update\` 로 리스닝 주소/상태를 고치거나 \`suo5-tunnel\` 스킬에 따라 재구축한다.
   - **터널은 여러 개를 준비한다**(스킬 \`chisel-tunnel\` / \`frp-tunnel\`): suo5 는 WebShell 에 의존한다; 명령 실행만 있을 때는 chisel; 장기 안정성과 외부 포트 매핑에는 frp; TUN 계층은 ligolo-ng 를 쓴다.
     여러 터널이 서로 백업이 된다——하나가 끊겨도 다른 것으로 내부 네트워크에 들어갈 수 있게 하고, 단일 지점에 묶여 멈추지 않는다.
1. **내부 네트워크 정보 수집(직접 수행——당신은 리프 노드이므로 플랫폼이 하위 에이전트 파견을 허용하지 않으며, 작업 지시서에도 파견 지시를 쓰지 않는다)**:
   - 터널을 통해 기성 스캐너로 면 정찰: 스킬 \`gogo-intranet\`(\`--proxy socks5://<터널>\`)으로 먼저 스캔하고, 스킬 \`fscan-intranet\` 으로 이어서 지점 타격(\`-socks5 <터널>\`);
   - **가장 중요한 것은 내부 네트워크의 모든 대역을 찾아내는 것이다**: 이미 장악한 호스트의 라우팅 테이블/\`ip route\`/\`arp -a\`/\`netstat\`, DNS 설정, 도메인 정보, hosts 파일, SSH known_hosts, 데이터베이스 접속 문자열, 로그 속 내부 주소에서 시작해, 스캔 결과와 함께 \`10.x\` / \`172.x\` / \`192.168.x\` 각 대역과 도달 가능성을 파악한다;
   - 새로 발견한 자산은 \`redteam_asset_add\` 로 측량에 병합한다(자동으로 /24 기준 C 대역을 만들고; 내부 자산을 DB에 기록하면 \`scope\` 는 자동으로 internal 이 된다).
2. **내부 자산을 직접 하나씩 평가한다**(\`redteam_asset_assess\`: priority/potential/reason). "누구를 먼저 칠지"를 산출한다: 양이 많으면 나눠서, high 부터 공략한다.
3. **내부 취약점 발견도 직접 한다**: 마찬가지로 **먼저 DB 조회**(\`redteam_asset_query\` / \`redteam_vuln_query\`, 이미 측정한 것과 이미 확인된 것은 건너뛴다), \`redteam_poc_search\` 우선(로컬 템플릿을 터널 경유로 쓸 때는 \`-proxy socks5://<터널>\` 추가), 특히 MS17-010, SMBGhost, Shiro/Fastjson/Weblogic 등 내부에서 빈발하는 취약점, 비인가 서비스(Redis/Docker/공유 디렉터리), 내부 관리 콘솔.
4. **내부 익스플로잇도 직접 한다**: 자격 증명 재사용 우선(\`redteam_credential_list\` / \`redteam_access_list\`, Pass-the-Hash, 티켓, SSH/RDP/SMB/WinRM/데이터베이스/미들웨어 백엔드), **내부에서 자격 증명을 얻어도 마찬가지로 내부 관리 콘솔을 먼저 시도한다**(배스천 호스트 / 운영 플랫폼 / 데이터베이스 백엔드 / 도메인 컨트롤러 / OA 와 메일 백엔드). 이것들이 곧바로 핵심 시스템 득점에 대응한다.
5. **횡이동과 권한 상승(스킬 \`lateral-movement\`, 로컬 \`impacket-*\` 명령 61개)**:
   - **먼저 열거**: \`impacket-GetADUsers\` / \`impacket-GetADComputers\` / \`enum4linux -a\` / \`smbclient -L\`;
   - **자격 증명 덤프**: \`impacket-secretsdump\`(원격 SAM/LSA/SECRETS dump), \`-just-dc\`(DCSync, 도메인 컨트롤러 직통);
   - **PtH 횡이동**: \`impacket-wmiexec\`/\`atexec\`(**우선, 노이즈 적음**) > \`psexec\`(서비스 설치, 노이즈 큼, EDR 에 걸리기 쉬움);
   - **Kerberos**: \`impacket-GetNPUsers\`(AS-REP) + \`GetUserSPNs\`(Kerberoasting)로 캡처해 오프라인 크래킹, \`getTGT\`/\`getST\` 로 티켓과 위임 처리;
   - **자격 증명 재사용은 적중률이 가장 높은 수법이다**: 같은 이미지로 일괄 설치된 머신은 로컬 관리자 비밀번호가 같은 경우가 많다. 자격 증명 한 세트를 얻으면 먼저 한 바퀴 훑은 다음 새 취약점 공략을 논한다;
   - **터널 경유**: 모든 명령에 \`proxychains4 -f runs/proxychains-<port>.conf\` 추가(**\`-f\` 임시 설정만 사용하고, 절대 시스템 설정을 바꾸지 않는다**);
     proxychains 는 TCP 만 프록시한다는 점에 유의한다. Kerberos 의 UDP 와 역연결 시나리오는 \`chisel-tunnel\`/\`frp-tunnel\` 로 포트 매핑을 해야 한다.
6. **핵심 시스템 공략**: 도메인 컨트롤러, 배스천 호스트, 운영 플랫폼, 코드 저장소, 데이터베이스 클러스터, 백업 시스템 → \`central-system\`(중앙 집권 시스템, 관리자 등급 points=500).
7. 모든 단계마다 득점을 기록한다(code 는 \`redteam_score_list\` 가 실제 반환한 값을 기준으로 하고, 기억에 의존해 옛 code 를 쓰지 않는다): 경계 돌파는 증거 강도에 따라 \`boundary-logical\` / \`boundary-strong\` / \`boundary-physical\` / \`boundary-supply\` 네 등급 중 선택; 횡이동으로 호스트를 얻으면 \`server-host\`; 중앙 집권 시스템은 \`central-system\`; Web 시스템은 \`web-app\`; 빅데이터는 \`bigdata-system\`.

## 이 역할의 DB 기록 중점(내부 네트워크 침투)
- 내부 자산마다 \`redteam_asset_add\`; 접근에 성공할 때마다 \`redteam_access_add\`; 자격 증명마다 \`redteam_credential_add\`(\`source\`/\`tool\` 명확히).
- 핵심 동작마다 \`redteam_chain_add\`: \`stage_code=internal\`(내부 네트워크 권한 확보) / \`boundary\`(터널 구축) / \`target\`(타깃 장악), **\`tool\` 에는 실제 명령**(예: \`--proxy socks5://...\` 같은 터널 경유 파라미터 포함), \`result\` 에는 응답.
- 터널 경유로 수행한 스캔/익스플로잇은 명령에 터널 파라미터가 남아 있어야 한다 —— 보고서만 보고 그대로 재현할 수 있어야 한다.
- 내부의 알려진 취약점도 마찬가지로 먼저 지식 베이스와 로컬 템플릿을 조회하고, 뚫은 뒤 백필한다(\`redteam_poc_add\`, \`category\` + \`engagement\` + \`asset_target\` + \`verified_note\` 포함, 마스킹).

## 경계
- **득점으로 이어지는 면만 공략한다**: 내부 자산 권한(서버/데이터베이스/도메인 컨트롤러/핵심 시스템)과 민감 데이터; 득점과 무관한 설정 문제, 정보 노출, 중저위험은 심층 분석하지 않는다(제외 결론 한 줄만 기록).
- 긴 작업 전후로 \`redteam_session_check\` 를 한 번씩 실행해, 후속 작업이 끊긴 터널 위에서 진행되지 않게 한다.\n\n${COMMON_BIND}\n\n${COMMON_SCORE_RULES}\n\n${COMMON_DB_LOOKUP}\n\n${COMMON_EVIDENCE}\n\n${COMMON_HANDOFF}`,

}
/* 역할 목록(도구, 패널, 프롬프트 갱신 스크립트 공용): 순서가 곧 권장 실행 순서다. */
export const ROLE_ORDER = ['recon', 'assess', 'vuln-scan', 'exploit', 'internal']
export const PLANNER_ROLE = 'plan'

/* ------------------------------------------------------------------ 통합 작업 디스패치 */

/**
 * 통합 작업 디스패치: CLI, HTTP 브리지, (향후) 에이전트 도구가 같은 op 어휘를 공유해,
 * 화면에서 보는 것, 명령줄에서 검증하는 것, 에이전트가 쓰는 것이 같은 경로임을 보장한다.
 * @param store - RedteamStore 인스턴스.
 * @param req - `{ op, engagement, ... }`.
 * @returns JSON 직렬화 가능한 결과(실패 시 `{ ok: false, error }`).
 */
export function dispatch(store, req = {}) {
  const op = typeof req.op === 'string' ? req.op.trim() : ''
  try {
    if (!op) return { ok: false, error: 'missing op' }
    if (op === 'bootstrap') {
      const engagements = store.listEngagements()
      /* 우선 "현재 타깃" 포인터를 이어받고, 그다음이 최근 생성된 타깃 */
      const active = typeof store.activeEngagementId === 'function' ? store.activeEngagementId() : undefined
      return {
        ok: true, root: store.root, engagements,
        current: req.engagement || active || (engagements[0] && engagements[0].id) || null,
      }
    }
    if (op === 'openEngagement') {
      return { ok: true, engagement: store.openEngagement(req.name, req.scope) }
    }
    if (op === 'activateEngagement') {
      const activated = store.setActiveEngagement(req.engagement)
      return { ok: activated, current: store.activeEngagementId() }
    }
    /* 오픈소스 버전에서 지식 베이스 제거: POC/EXP 검색과 백필을 일괄 비활성화한다. */
    if (op === 'pocSearch' || op === 'pocList' || op === 'pocGet' || op === 'pocSave'
      || op === 'pocUpdate' || op === 'pocDelete' || op === 'pocUse' || op === 'pocStats') {
      return { ok: false, error: '오픈소스 버전에서 지식 베이스가 제거되었습니다', disabled: true }
    }
    if (op === 'templateSearch') return Object.assign({ ok: true }, store.searchTemplates(req.q, Math.min(Number(req.limit) || 40, 200)))
    if (op === 'templateStats') return { ok: true, stats: store.templateStats() }
    /* 환경 적응: 전역이며 타깃에 의존하지 않는다; 패널 / CLI / 도구 공용 */
    if (op === 'platformConfigGet') return platformSummary(store.root)
    if (op === 'platformConfigSave') {
      savePlatformConfig(req.config || {}, store.root)
      return platformSummary(store.root)
    }
    if (op === 'platformAssignToolkit') return assignToolkitFolder(req.dir, store.root)
    /* 타깃을 고르지 않았을 때: 프롬프트는 내장 기본값으로, 읽기 전용 조회는 빈 결과로 돌려준다. 영어 engagement required 를 던지지 않는다. */
    let id = typeof req.engagement === 'string' ? req.engagement.trim() : ''
    if (!id && typeof store.activeEngagementId === 'function') id = store.activeEngagementId() || ''
    if (!id) {
      if (op === 'prompts') {
        return {
          ok: true,
          builtin: true,
          roles: Object.entries(ROLE_TITLES).map(([role, title]) => ({
            role, title,
            planner: role === PLANNER_ROLE,
            dispatcher: role !== PLANNER_ROLE,
            content: DEFAULT_PROMPTS[role] || '',
            updated_at: null,
          })),
        }
      }
      const writing = /^(add|save|update|delete|import|assess|open)/.test(op)
      if (writing) return { ok: false, error: "Select or create a target at the top first" }
      return { ok: true, items: [], total: 0, stats: null, segments: [], stages: [], roles: [] }
    }

    if (op === 'snapshot') return Object.assign({ ok: true }, store.snapshot(id))
    if (op === 'assets') return Object.assign({ ok: true }, store.listAssets(id, req))
    if (op === 'asset') return { ok: true, asset: store.getAsset(id, req.id) }
    if (op === 'graph') return Object.assign({ ok: true }, store.graph(id, req))
    if (op === 'attackGraph') return Object.assign({ ok: true }, store.attackGraph(id, req))
    if (op === 'stats') return { ok: true, stats: store.stats(id) }
    if (op === 'vulns') return Object.assign({ ok: true, stats: store.vulnStats(id) }, store.listVulns(id, req))
    if (op === 'addVuln') return Object.assign({ ok: true }, store.addVuln(id, req.vuln || req))
    if (op === 'updateVuln') return Object.assign({ ok: true }, store.updateVuln(id, req.id, req.patch || req))
    if (op === 'vulnStats') return { ok: true, stats: store.vulnStats(id) }
    if (op === 'credentials') return { ok: true, items: store.listCredentials(id, req) }
    if (op === 'addCredential') return Object.assign({ ok: true }, store.addCredential(id, req.credential || req))
    if (op === 'access') return { ok: true, items: store.listAccess(id, req) }
    if (op === 'addAccess') return Object.assign({ ok: true }, store.addAccess(id, req.access || req))
    if (op === 'sessions') return Object.assign({ ok: true }, store.sessionSummary(id))
    if (op === 'webshells') return { ok: true, items: store.listWebshells(id, req) }
    if (op === 'addWebshell') return Object.assign({ ok: true }, store.addWebshell(id, req.webshell || req))
    if (op === 'updateWebshell') return Object.assign({ ok: true }, store.updateWebshell(id, req.id, req.patch || req))
    if (op === 'tunnels') return { ok: true, items: store.listTunnels(id, req) }
    if (op === 'shots') return Object.assign({ ok: true }, store.listShots(id, req))
    if (op === 'shotAdd') return Object.assign({ ok: true }, store.addShot(id, req.shot || req))
    if (op === 'shotDelete') return Object.assign({ ok: true }, store.deleteShot(id, req.id !== undefined ? req.id : req.shot_id))
    if (op === 'shotData') return Object.assign({ ok: true }, store.readShot(id, req.id !== undefined ? req.id : req.shot_id))
    if (op === 'addTunnel') return Object.assign({ ok: true }, store.addTunnel(id, req.tunnel || req))
    if (op === 'updateTunnel') return Object.assign({ ok: true }, store.updateTunnel(id, req.id, req.patch || req))
    if (op === 'domains') return { ok: true, items: store.domainIndex(id, req) }
    if (op === 'web') return Object.assign({ ok: true }, store.listWeb(id, req))
    if (op === 'httpEvidence') return { ok: true, items: store.listHttpEvidence(id, req) }
    if (op === 'addHttpEvidence') return Object.assign({ ok: true }, store.addHttpEvidence(id, req.evidence || req))
    if (op === 'chain') return { ok: true, items: store.listChain(id) }
    if (op === 'addChainStep') return Object.assign({ ok: true }, store.addChainStep(id, req.step || req))
    if (op === 'report') return Object.assign({ ok: true }, store.report(id))
    if (op === 'assetTest') return Object.assign({ ok: true }, store.updateAssetTest(id, req.test || req))
    if (op === 'assessAsset') return Object.assign({ ok: true }, store.assessAsset(id, req.assess || req))
    if (op === 'scores') return Object.assign({ ok: true }, store.listScorePoints(id, req))
    if (op === 'saveScorePoint') return Object.assign({ ok: true }, store.saveScorePoint(id, req.point || req))
    if (op === 'deleteScorePoint') return Object.assign({ ok: true }, store.deleteScorePoint(id, req.id))
    if (op === 'addScoreHit') return Object.assign({ ok: true }, store.addScoreHit(id, req.hit || req))
    if (op === 'scoreChain') return Object.assign({ ok: true }, store.scoreChain(id, req))
    if (op === 'scoreReport') return Object.assign({ ok: true }, store.scoreReport(id, req))
    if (op === 'activeTests') return Object.assign({ ok: true }, store.activeTests(id, req))
    if (op === 'testStats') return { ok: true, stats: store.testStats(id) }
    /* 콘솔 탭의 미확인 포인터(탭별 건수 + 최근 갱신 시각): 패널이 이것으로 빨간 점을 찍는다 */
    if (op === 'consoleDigest') return Object.assign({ ok: true }, store.consoleDigest(id))
    if (op === 'stages') return { ok: true, items: store.listStages(id) }
    if (op === 'saveStage') return Object.assign({ ok: true }, store.saveStage(id, req.stage || req))
    if (op === 'reportTargets') return Object.assign({ ok: true }, store.reportTargets(id, req))
    /* 자산 발견 타임라인: 자산 측량 페이지의 "발견 시각" 뷰 + 보고서 부록 공용 */
    if (op === 'discoveryTimeline') return Object.assign({ ok: true }, store.discoveryTimeline(id, req))
    if (op === 'attackFiles') return { ok: true, items: store.attackFileTree(id) }
    if (op === 'addAttackFile') return Object.assign({ ok: true }, store.addAttackFile(id, req.file || req))
    if (op === 'readAttackFile') return Object.assign({ ok: true }, store.readAttackFile(id, req.id))
    if (op === 'import') return Object.assign({ ok: true }, store.importBundle(id, req))
    if (op === 'prompts') return { ok: true, roles: store.listPrompts(id) }
    if (op === 'savePrompt') return Object.assign({ ok: true }, store.savePrompt(id, req.role, req.content))
    if (op === 'resetPrompts') return Object.assign({ ok: true }, store.resetPrompts(id, req.role))
    throw new Error(`unknown op: ${op}`)
  } catch (error) {
    return { ok: false, error: error && error.message ? error.message : String(error) }
  }
}

/**
 * 비동기 디스패치: `probeSessions` 하나만 추가되고(실제 네트워크 연결을 일으켜야 한다), 나머지는 동기 dispatch 로 넘긴다.
 * 에이전트의 샌드박스에서는 외부로 나갈 수 없으므로 host 측에서 연결성을 실측한다.
 */
export async function dispatchAsync(store, req = {}) {
  if (req.op === 'probeSessions') {
    try {
      const id = (typeof req.engagement === 'string' && req.engagement.trim())
        || (typeof store.activeEngagementId === 'function' ? store.activeEngagementId() : '')
      if (!id) return { ok: true, items: [], note: "No target yet" }
      const result = await store.probeSessions(id, req)
      return Object.assign({ ok: true }, result)
    } catch (error) {
      return { ok: false, error: error && error.message ? error.message : String(error) }
    }
  }
  return dispatch(store, req)
}

/* ------------------------------------------------------------------ 서비스 */

/**
 * 이미지 바이트에서 크기를 읽는다(PNG / JPEG / WebP). 읽지 못하면 `{ width: null, height: null }` 를 반환한다.
 *
 * 패널과 보고서에 "이 이미지가 얼마나 큰지" 표시하고 0 바이트 파일을 스크린샷으로 받아들이지 않기 위한 것일 뿐 ——
 * 이를 위해 이미지 라이브러리를 끌어올 가치는 없다(이 패키지는 의도적으로 외부 의존성 제로를 유지한다).
 *
 * @param buf - 이미지 바이트.
 */
function pngSize(buf) {
  try {
    if (buf.length > 24 && buf.slice(1, 4).toString('latin1') === 'PNG') {
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
    }
    if (buf.length > 4 && buf[0] === 0xFF && buf[1] === 0xD8) {
      let i = 2
      while (i + 9 < buf.length) {
        if (buf[i] !== 0xFF) { i += 1; continue }
        const marker = buf[i + 1]
        const len = buf.readUInt16BE(i + 2)
        if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
          return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) }
        }
        i += 2 + len
      }
    }
    if (buf.length > 30 && buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WEBP') {
      const fmt = buf.slice(12, 16).toString('latin1')
      if (fmt === 'VP8X') return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) }
      if (fmt === 'VP8 ') return { width: buf.readUInt16LE(26) & 0x3FFF, height: buf.readUInt16LE(28) & 0x3FFF }
    }
  } catch { /* 크기를 읽지 못해도 DB 기록에는 영향이 없다 */ }
  return { width: null, height: null }
}

export class RedteamStore {
  /** @param root 데이터 루트 디렉터리(기본값 $DSH_HOME/redteam) */
  constructor(root) {
    this.root = root
    this.engagementsDir = join(root, 'engagements')
    this.handles = new Map()
    mkdirSync(this.engagementsDir, { recursive: true })
  }

  /* ---------- 현재 타깃 ---------- */
  currentPath() { return join(this.root, 'current') }

  /** 현재 유효한 타깃 id — 명시적 포인터가 우선이고, 없으면 최근 생성된 타깃. */
  activeEngagementId() {
    try {
      const raw = readFileSync(this.currentPath(), 'utf8').trim()
      if (raw && existsSync(this.dbPathOf(raw))) return raw
    } catch { /* 포인터가 없을 때의 폴백 */ }
    const list = this.listEngagements()
    return list.length ? list[0].id : undefined
  }

  /** 현재 타깃을 전환한다(인터페이스에서 전환하거나 에이전트가 바인딩할 때 호출). */
  setActiveEngagement(id) {
    if (!id || !existsSync(this.dbPathOf(id))) return false
    mkdirSync(this.root, { recursive: true })
    writeFileSync(this.currentPath(), String(id), 'utf8')
    return true
  }

  /* ---------- 경로 ---------- */
  dirOf(id) { return join(this.engagementsDir, id) }
  metaPathOf(id) { return join(this.dirOf(id), 'engagement.yaml') }
  dbPathOf(id) { return join(this.dirOf(id), 'assets.db') }
  promptsDirOf(id) { return join(this.dirOf(id), 'agents') }

  /* ---------- 데이터베이스 핸들(타깃별 캐시, dispose 시 일괄 종료) ---------- */
  /**
   * 특정 타깃의 데이터베이스 핸들을 연다(필요 시 생성).
   * @param id - 타깃 id 값.
   * @param options - `{ create: true }` 일 때 DB 파일 생성을 허용한다(openEngagement 용).
   */
  db(id, options = {}) {
    let handle = this.handles.get(id)
    if (handle) return handle
    if (!existsSync(this.dbPathOf(id))) {
      if (options.create !== true) throw new Error(`engagement not found: ${id}`)
      mkdirSync(this.dirOf(id), { recursive: true })
    }
    handle = new DatabaseSync(this.dbPathOf(id))
    /* FTS5 가 없는 Node 빌드(예: 22.14)에서는 fts5 테이블 생성 구문을 넣으면 안 된다:
       `USING fts5` 한 줄이 예외를 던지면 DDL 전체가 함께 무너져 일반 테이블조차 만들 수 없다.
       폴백 후 asset 검색은 LIKE 경로를 쓴다(listAssets 의 f.q 분기 참고). */
    handle.exec(HAS_FTS5 ? DDL + ASSET_FTS_DDL : DDL)
    migrate(handle)
    this.handles.set(id, handle)
    return handle
  }

  close() {
    for (const handle of this.handles.values()) {
      try { handle.close() } catch { /* 종료 실패가 언로드를 막지 않는다 */ }
    }
    this.handles.clear()
    if (this.kbHandle) {
      try { this.kbHandle.close() } catch { /* 무시 */ }
      this.kbHandle = null
    }
  }

  /* ---------- 타깃 생명주기 ---------- */
  listEngagements() {
    mkdirSync(this.engagementsDir, { recursive: true })
    const out = []
    for (const entry of readdirSync(this.engagementsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const meta = readMeta(this.metaPathOf(entry.name)) || {}
      let stats = null
      try {
        if (existsSync(this.dbPathOf(entry.name))) stats = this.stats(entry.name)
      } catch { /* DB 가 손상돼도 타깃 목록은 계속 낸다 */ }
      out.push({
        id: entry.name, name: meta.target_name || entry.name,
        scope: meta.scope_cidrs || [], status: meta.status || 'active',
        created_at: meta.created_at || null, stats,
      })
    }
    return out.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
  }

  /**
   * 타깃 워크스페이스를 열거나 생성한다.
   * @param name - 타깃 기관 이름(slugify 후 디렉터리 이름과 타깃 id 로 쓴다).
   * @param scope - 인가 범위 CIDR 목록(비어 있어도 된다).
   * @param options - `{ bindCurrent?: boolean }`: 전역 "현재 타깃" 포인터도 함께 옮길지 여부.
   *   기본값 true(인터페이스/명령줄 의미론); **에이전트 도구는 false 를 넘긴다** —— 다중 세션이 병행될 때,
   *   특정 세션이 타깃을 open 하는 것만으로 전역 포인터가 바뀌는 것이 "보고서가 뒤섞여 기록되는" 직접적 원인이다.
   */
  openEngagement(name, scope, options = {}) {
    const id = slugify(name)
    mkdirSync(this.dirOf(id), { recursive: true })
    for (const sub of ['agents', 'runs', 'reports']) mkdirSync(join(this.dirOf(id), sub), { recursive: true })
    const existing = readMeta(this.metaPathOf(id))
    writeMeta(this.metaPathOf(id), {
      target_name: name,
      scope_cidrs: scope || (existing && existing.scope_cidrs) || [],
      status: 'active',
      created_at: (existing && existing.created_at) || nowIso(),
      updated_at: nowIso(),
    })
    this.db(id, { create: true }) // DB 생성 + 테이블 생성
    this.seedScorePoints(id)
    for (const p of this.listPrompts(id)) {
      if (!p.content) this.savePrompt(id, p.role, DEFAULT_PROMPTS[p.role] || '')
    }
    if (options.bindCurrent !== false) this.setActiveEngagement(id)
    return { id, name, scope: scope || [] }
  }

  /**
   * 자산 발견 타임라인: "어느 날 몇 개를 발견했고 최근에 무엇을 발견했는지"로 집계한다.
   * 자산 측량 페이지는 이것으로 "이 항목은 언제 발견됐는지" 답하고, 보고서 부록은 마무리 타임라인으로 쓴다.
   * @param id - 타깃 id 값.
   * @param f - `{ limit?: number }` 최근 자산 건수(기본값 50).
   */
  discoveryTimeline(id, f = {}) {
    const db = this.db(id)
    const limit = Math.min(Number(f.limit) || 50, 500)
    const days = db.prepare(`SELECT substr(COALESCE(discovered_at, first_seen, ''), 1, 10) AS day,
        COUNT(*) AS assets,
        SUM(CASE WHEN COALESCE(scope, (${SCOPE_SQL})) = 'internal' THEN 1 ELSE 0 END) AS internal,
        SUM(CASE WHEN COALESCE(scope, (${SCOPE_SQL})) = 'external' THEN 1 ELSE 0 END) AS external
      FROM asset GROUP BY day ORDER BY day DESC`).all()
    const recent = db.prepare(`SELECT id, ip, segment_cidr, state, primary_name, discovered_at, first_seen, last_seen,
        COALESCE(scope, (${SCOPE_SQL})) AS scope, priority,
        (SELECT COUNT(*) FROM port p WHERE p.asset_id = asset.id AND p.state = 'open') AS open_ports
      FROM asset ORDER BY COALESCE(discovered_at, first_seen, '') DESC, id DESC LIMIT ?`).all(limit)
    const span = db.prepare(`SELECT MIN(COALESCE(discovered_at, first_seen)) AS first,
        MAX(COALESCE(discovered_at, first_seen)) AS last, COUNT(*) AS total FROM asset`).get() || {}
    return {
      days: days.map((d) => Object.assign({}, d, { day: d.day || "(unknown time)" })),
      recent,
      span: { first: span.first || null, last: span.last || null, total: span.total || 0 },
    }
  }

  /* ---------- 통계 / 조회 ---------- */
  stats(id) {
    const db = this.db(id)
    const one = (sql) => Object.values(db.prepare(sql).get() || {})[0] ?? 0
    return {
      segments: one('SELECT COUNT(*) FROM segment'),
      assets: one('SELECT COUNT(*) FROM asset'),
      liveAssets: one("SELECT COUNT(*) FROM asset WHERE state = 'live'"),
      openPorts: one("SELECT COUNT(*) FROM port WHERE state = 'open'"),
      services: one('SELECT COUNT(*) FROM service'),
      fingerprints: one('SELECT COUNT(*) FROM fingerprint'),
      passiveSignals: one("SELECT COUNT(*) FROM observation WHERE provenance = 'passive'"),
      activeSignals: one("SELECT COUNT(*) FROM observation WHERE provenance = 'active'"),
      vulns: one('SELECT COUNT(*) FROM vuln'),
      credentials: one('SELECT COUNT(*) FROM credential'),
      accesses: one('SELECT COUNT(*) FROM access_session'),
      untestedAssets: one("SELECT COUNT(*) FROM asset WHERE COALESCE(test_status, 'untested') = 'untested'"),
      blockedAssets: one("SELECT COUNT(*) FROM asset WHERE COALESCE(test_status, '') = 'blocked' OR blocked_count > 0"),
    }
  }

  /**
   * 콘솔 "미확인" 요약: 탭마다 "건수 + 최근 1건 시각"의 경량 포인터를 준다.
   *
   * 패널은 이것을 로컬에 기억한 지난 확인 상태와 비교한다: 새 건수가 있거나 최신 시각이 지난 확인보다 늦으면 탭에 빨간 점을 찍고;
   * 사용자가 그 탭을 열면 현재 값을 확인됨으로 기록해 빨간 점이 사라진다. **읽기 전용, 개수만 센다**, 무거운 작업은 하지 않는다.
   */
  consoleDigest(id) {
    const db = this.db(id)
    const count = (sql) => {
      try { return Number(db.prepare(sql).get()?.n ?? 0) || 0 } catch { return 0 }
    }
    const at = (sql) => {
      try { return db.prepare(sql).get()?.t ?? null } catch { return null }
    }
    const maxOf = (a, b) => (a === null ? b : (b === null ? a : (a > b ? a : b)))
    /* 지식 베이스는 타깃을 넘어 공유되는 별도 DB: 얻지 못하면 0 으로 간주하고 다른 탭에 영향을 주지 않는다 */
    let kb = { count: 0, at: null }
    try {
      const k = this.kb()
      kb = {
        count: Number(k.prepare('SELECT COUNT(*) AS n FROM poc').get()?.n ?? 0),
        at: k.prepare('SELECT MAX(COALESCE(updated_at, created_at)) AS t FROM poc').get()?.t ?? null,
      }
    } catch { /* 지식 베이스가 아직 없음: 갱신 없음으로 간주 */ }
    const hits = 'SELECT COUNT(*) AS n FROM score_hit'
    const hitsAt = 'SELECT MAX(recorded_at) AS t FROM score_hit'
    const steps = 'SELECT COUNT(*) AS n FROM attack_step'
    const stepsAt = 'SELECT MAX(recorded_at) AS t FROM attack_step'
    const sections = {
      assets: {
        count: count('SELECT COUNT(*) AS n FROM asset'),
        at: at('SELECT MAX(COALESCE(discovered_at, first_seen, last_seen)) AS t FROM asset'),
      },
      testing: {
        count: count("SELECT COUNT(*) AS n FROM asset WHERE COALESCE(test_status, 'untested') <> 'untested'"),
        at: at('SELECT MAX(test_updated_at) AS t FROM asset'),
      },
      /* "에이전트" 탭은 "누가 실행 중인가"를 본다: 공격 단계의 최신 동작을 포인터로 쓴다 */
      agents: { count: count(steps), at: at(stepsAt) },
      sessions: {
        count: count('SELECT COUNT(*) AS n FROM webshell') + count('SELECT COUNT(*) AS n FROM tunnel'),
        at: maxOf(
          at('SELECT MAX(COALESCE(updated_at, created_at)) AS t FROM webshell'),
          at('SELECT MAX(COALESCE(updated_at, created_at)) AS t FROM tunnel'),
        ),
      },
      findings: {
        count: count('SELECT COUNT(*) AS n FROM vuln'),
        at: at('SELECT MAX(found_at) AS t FROM vuln'),
      },
      chain: { count: count(steps), at: at(stepsAt) },
      scores: { count: count(hits), at: at(hitsAt) },
      report: { count: count(hits), at: at(hitsAt) },
      attackfiles: {
        count: count('SELECT COUNT(*) AS n FROM attack_file'),
        at: at('SELECT MAX(created_at) AS t FROM attack_file'),
      },
      knowledge: kb,
      /* 프롬프트와 스킬 라이브러리는 패키지에 포함되어 배포되는 정적 콘텐츠다: "새 항목"이라는 것이 없으므로 빨간 점을 절대 찍지 않는다 */
      prompts: { count: 0, at: null },
      skills: { count: 0, at: null },
    }
    return { engagement: id, at: nowIso(), sections }
  }

  snapshot(id) {
    const meta = readMeta(this.metaPathOf(id)) || {}
    return {
      engagement: {
        id, name: meta.target_name || id, scope: meta.scope_cidrs || [],
        status: meta.status || 'active', created_at: meta.created_at || null,
      },
      stats: this.stats(id),
      tests: this.testStats(id),
      segments: this.listSegments(id),
    }
  }

  listSegments(id) {
    const rows = this.db(id).prepare(`
      SELECT s.cidr, s.org, s.asn, s.country, s.city, s.source,
        (SELECT COUNT(*) FROM asset a WHERE a.segment_cidr = s.cidr) AS assets,
        (SELECT COUNT(*) FROM asset a WHERE a.segment_cidr = s.cidr AND a.state = 'live') AS live,
        (SELECT COUNT(*) FROM port p JOIN asset a ON a.id = p.asset_id WHERE a.segment_cidr = s.cidr AND p.state = 'open') AS open_ports,
        (SELECT COUNT(*) FROM port p JOIN asset a ON a.id = p.asset_id WHERE a.segment_cidr = s.cidr AND p.provenance = 'passive') AS passive_ports,
        (SELECT COUNT(*) FROM port p JOIN asset a ON a.id = p.asset_id WHERE a.segment_cidr = s.cidr AND p.provenance = 'active') AS active_ports
      FROM segment s ORDER BY assets DESC, s.cidr`).all()
    /* C 대역도 내부/외부 네트워크로 나뉜다: 네트워크 대역 시작 주소의 소속으로 판정한다 */
    return rows.map((r) => Object.assign({}, r, { scope: scopeOfIp(String(r.cidr || '').split('/')[0]) }))
  }

  /**
   * 자산 묶음의 ports / fingerprints / names 를 **한 번에 전부 조회**하고, asset_id 로 묶어 반환한다.
   *
   * 필요한 이유: assetRow 는 원래 자산마다 3 건의 쿼리를 따로 실행했는데, 자산 목록의 기본 limit=400 이라 ——
   * 목록 요청 한 번에 SQL 1200 건이 나가고, 패널은 필터 조건을 바꿀 때마다 다시 조회한다.
   * 여기서는 3 건의 `IN (...)` 쿼리로 바꿔서, 비용이 **자산 수와 무관**하다.
   *
   * @param db - 타깃 DB 핸들.
   * @param ids - 자산 id 배열(빈 배열이면 빈 Map 을 곧바로 반환).
   * @returns `{ ports, fingerprints, names }`: 세 개의 `Map<assetId, rows[]>`
   */
  assetChildren(db, ids = []) {
    const ports = new Map()
    const fingerprints = new Map()
    const names = new Map()
    const list = Array.from(new Set(ids.filter((x) => x !== null && x !== undefined))).map(Number)
    if (list.length === 0) return { ports, fingerprints, names }
    const ph = list.map(() => '?').join(',')
    for (const row of db.prepare(`SELECT p.asset_id, p.port, p.proto, p.state, p.provenance, p.banner, p.url, p.title,
        s.name AS service, s.product, s.version
      FROM port p LEFT JOIN service s ON s.port_id = p.id
      WHERE p.asset_id IN (${ph}) ORDER BY p.asset_id, p.port`).all(...list)) {
      const key = Number(row.asset_id)
      if (!ports.has(key)) ports.set(key, [])
      ports.get(key).push(row)
    }
    for (const row of db.prepare(`SELECT asset_id, category, vendor, product, version, evidence, provenance
      FROM fingerprint WHERE asset_id IN (${ph}) ORDER BY asset_id, id`).all(...list)) {
      const key = Number(row.asset_id)
      if (!fingerprints.has(key)) fingerprints.set(key, [])
      fingerprints.get(key).push(row)
    }
    for (const row of db.prepare(`SELECT asset_id, name, kind, provenance
      FROM asset_name WHERE asset_id IN (${ph}) ORDER BY asset_id, id`).all(...list)) {
      const key = Number(row.asset_id)
      if (!names.has(key)) names.set(key, [])
      names.get(key).push(row)
    }
    return { ports, fingerprints, names }
  }

  /**
   * 단일 자산 → 행 구조.
   * @param db - 타깃 DB 핸들.
   * @param a - asset 테이블의 행.
   * @param children - 선택 사항: assetChildren() 의 프리페치 결과. **넘기면 추가 쿼리가 없다**;
   *                   넘기지 않으면 단일 자산 조회로 폴백한다(상세 페이지는 한 번만 쓰므로 N+1 영향 없음).
   */
  assetRow(db, a, children = null) {
    let ports
    let fingerprints
    let names
    if (children !== null) {
      const key = Number(a.id)
      ports = children.ports.get(key) || []
      fingerprints = children.fingerprints.get(key) || []
      names = children.names.get(key) || []
    } else {
      ports = db.prepare(`SELECT p.port, p.proto, p.state, p.provenance, p.banner, p.url, p.title,
          s.name AS service, s.product, s.version
        FROM port p LEFT JOIN service s ON s.port_id = p.id
        WHERE p.asset_id = ? ORDER BY p.port`).all(a.id)
      fingerprints = db.prepare('SELECT category, vendor, product, version, evidence, provenance FROM fingerprint WHERE asset_id = ?').all(a.id)
      names = db.prepare('SELECT name, kind, provenance FROM asset_name WHERE asset_id = ?').all(a.id)
    }
    return {
      id: a.id, ip: a.ip, segment_cidr: a.segment_cidr, state: a.state,
      primary_name: a.primary_name, first_seen: a.first_seen, last_seen: a.last_seen,
      discovered_at: a.discovered_at || a.first_seen || null,
      test_status: a.test_status || 'untested', test_notes: a.test_notes || '',
      test_surface: a.test_surface || '', test_updated_at: a.test_updated_at || null,
      test_updated_by: a.test_updated_by || null, blocked_count: a.blocked_count || 0,
      priority: a.priority || null, potential: a.potential || '', assess_reason: a.assess_reason || '',
      assessed_at: a.assessed_at || null, assessed_by: a.assessed_by || null,
      scope: a.scope || scopeOfIp(a.ip),
      open_ports: ports.filter((p) => p.state === 'open').length,
      ports, fingerprints, names,
      passive: ports.filter((p) => p.provenance === 'passive').length,
      active: ports.filter((p) => p.provenance === 'active').length,
    }
  }


  listAssets(id, f = {}) {
    const db = this.db(id)
    const where = []
    const args = []
    if (f.cidr) { where.push('a.segment_cidr = ?'); args.push(f.cidr) }
    if (f.state) { where.push('a.state = ?'); args.push(f.state) }
    if (f.ip) { where.push('a.ip = ?'); args.push(f.ip) }
    if (f.port) { where.push('EXISTS (SELECT 1 FROM port p WHERE p.asset_id = a.id AND p.port = ?)'); args.push(Number(f.port)) }
    if (f.service) {
      where.push('EXISTS (SELECT 1 FROM port p JOIN service s ON s.port_id = p.id WHERE p.asset_id = a.id AND (s.name LIKE ? OR s.product LIKE ?))')
      args.push(`%${f.service}%`, `%${f.service}%`)
    }
    if (f.fingerprint) {
      where.push('EXISTS (SELECT 1 FROM fingerprint fp WHERE fp.asset_id = a.id AND (fp.product LIKE ? OR fp.vendor LIKE ? OR fp.category LIKE ?))')
      args.push(`%${f.fingerprint}%`, `%${f.fingerprint}%`, `%${f.fingerprint}%`)
    }
    if (f.provenance) {
      where.push('EXISTS (SELECT 1 FROM port p WHERE p.asset_id = a.id AND p.provenance = ?)')
      args.push(f.provenance)
    }
    if (f.priority) {
      where.push('a.priority = ?')
      args.push(f.priority)
    }
    if (f.test_status) {
      /* 다중 값 지원: test_status=abandoned,blocked */
      const list = String(f.test_status).split(',').map((x) => x.trim()).filter(Boolean)
      if (list.length > 1) {
        where.push(`COALESCE(a.test_status, 'untested') IN (${list.map(() => '?').join(',')})`)
        args.push(...list)
      } else {
        where.push("COALESCE(a.test_status, 'untested') = ?")
        args.push(f.test_status)
      }
    }
    /* 내부/외부 네트워크 차원: internal | external (구 데이터는 마이그레이션 시 백필됨) */
    if (f.scope) {
      where.push(`COALESCE(a.scope, (${SCOPE_SQL})) = ?`)
      args.push(f.scope)
    }
    if (f.q) {
      const terms = String(f.q).split(/\s+/).filter(Boolean)
      if (terms.length) {
        if (HAS_FTS5) {
          /* 기본 도메인(asset.primary_name)**은** asset_fts 인덱스에 **미포함**(FTS 테이블에는
             ip / names / banners / titles / fingerprints), MATCH 만으로는 기본 도메인을 찾지 못한다 ——
             예를 들어 "portal.example.test" 로 조회하면 0 건이다. 여기서 LIKE 를 함께 걸어 잡아 준다,
             LIKE 는 매칭되지만 FTS 토큰 분할로는 매칭되지 않는 경우까지 함께 커버한다. */
          where.push('(a.id IN (SELECT CAST(asset_id AS INTEGER) FROM asset_fts WHERE asset_fts MATCH ?)'
            + ' OR a.primary_name LIKE ?)')
          args.push(terms.map((t) => `"${t.replace(/"/g, '""')}"*`).join(' AND '), '%' + String(f.q) + '%')
        } else {
          /* FTS5 가 없는 Node 빌드: 부분 문자열 매칭으로 퇴화한다.
             의미론은 FTS 보다 약하다(접두/어간 분할을 하지 않고, LIKE 는 ASCII 대소문자만 구분하지 않는다),
             그래도 **검색이 오류를 내지 않고 내용을 찾아낸다**, "패널 전체가 열리지 않는" 것보다 훨씬 낫다.
             검색 대상 필드는 #reindex 가 asset_fts 에 넣는 것과 같다:
             자산 IP / 기본 도메인 + asset_name + port.banner/title/url + service + fingerprint 항목. */
          const sub = [
            'EXISTS(SELECT 1 FROM asset_name n WHERE n.asset_id = a.id AND n.name LIKE ?)',
            'EXISTS(SELECT 1 FROM port p WHERE p.asset_id = a.id AND (p.banner LIKE ? OR p.title LIKE ? OR p.url LIKE ?))',
            'EXISTS(SELECT 1 FROM service s JOIN port p2 ON p2.id = s.port_id WHERE p2.asset_id = a.id'
              + ' AND (s.name LIKE ? OR s.product LIKE ? OR s.version LIKE ?))',
            'EXISTS(SELECT 1 FROM fingerprint f WHERE f.asset_id = a.id'
              + ' AND (f.vendor LIKE ? OR f.product LIKE ? OR f.version LIKE ? OR f.category LIKE ?))',
          ]
          const binds = (t) => ['%' + t + '%', '%' + t + '%', '%' + t + '%', '%' + t + '%',
            '%' + t + '%', '%' + t + '%', '%' + t + '%',
            '%' + t + '%', '%' + t + '%', '%' + t + '%', '%' + t + '%']
          for (const t of terms) {
            where.push('(a.ip LIKE ? OR a.primary_name LIKE ? OR ' + sub.join(' OR ') + ')')
            args.push('%' + t + '%', '%' + t + '%', ...binds(t))
          }
        }
      }
    }
    const clause = where.length ? 'WHERE ' + where.join(' AND ') : ''
    const total = db.prepare(`SELECT COUNT(*) AS n FROM asset a ${clause}`).get(...args).n
    const limit = Math.min(Number(f.limit) || 200, 2000)
    const offset = Number(f.offset) || 0
    const openPorts = "COALESCE((SELECT COUNT(*) FROM port p WHERE p.asset_id = a.id AND p.state = 'open'), 0)"
    /* 정렬: 기본은 "가장 먼저 공략할 것을 앞에" —— 공략 용이성 높음 → 미검증 → 포트 많음; sort=ip / sort=ports 로 전환 가능 */
    const sort = f.sort || 'priority'
    let orderBy = 'a.ip_int'
    if (sort === 'ports') orderBy = `${openPorts} DESC, a.ip_int`
    /* 발견 시각 내림차순: 새로 수집된 자산을 앞에 둔다("방금 무엇을 찾았나" 가 가장 직관적) */
    else if (sort === 'discovered') orderBy = `COALESCE(a.discovered_at, a.first_seen, '') DESC, a.id DESC`
    else if (sort === 'todo') {
      /* 미검증 우선: 이번 라운드에 아직 공략 가능한 것을 먼저 올리고, 검증됨/포기한 것은 아래로 내린다 */
      orderBy = `CASE COALESCE(a.test_status, 'untested')
          WHEN 'untested' THEN 0 WHEN 'testing' THEN 1 WHEN 'tested' THEN 2
          WHEN 'blocked' THEN 3 WHEN 'abandoned' THEN 4 WHEN 'no_surface' THEN 5 ELSE 6 END,
        CASE COALESCE(a.priority, '') WHEN 'high' THEN 0 WHEN 'medium' THEN 1 WHEN 'low' THEN 2 ELSE 3 END,
        ${openPorts} DESC, a.ip_int`
    } else if (sort === 'priority') {
      orderBy = `CASE COALESCE(a.priority, '') WHEN 'high' THEN 0 WHEN 'medium' THEN 1 WHEN 'low' THEN 2 ELSE 3 END,
        CASE COALESCE(a.test_status, 'untested')
          WHEN 'untested' THEN 0 WHEN 'testing' THEN 1 WHEN 'tested' THEN 2
          WHEN 'blocked' THEN 3 WHEN 'abandoned' THEN 4 WHEN 'no_surface' THEN 5 ELSE 6 END,
        ${openPorts} DESC, a.ip_int`
    }
    const rows = db.prepare(`SELECT a.*, ${openPorts} AS open_port_count FROM asset a ${clause} ORDER BY ${orderBy} LIMIT ? OFFSET ?`)
      .all(...args, limit, offset)
    /* 한 번 프리페치하고 행마다 조립: 3N 건의 쿼리를 3 건으로 줄인다(기본 N 은 최대 400) */
    const children = this.assetChildren(db, rows.map((r) => r.id))
    return { total, sort, items: rows.map((r) => this.assetRow(db, r, children)) }
  }

  getAsset(id, assetId) {
    const db = this.db(id)
    const a = db.prepare('SELECT * FROM asset WHERE id = ?').get(Number(assetId))
    if (!a) return undefined
    const detail = this.assetRow(db, a)
    detail.observations = db.prepare(`SELECT attr, value, provenance, tool, collected_at FROM observation
      WHERE entity_kind = 'asset' AND entity_id = ? ORDER BY collected_at DESC LIMIT 200`).all(a.id)
    detail.edges = db.prepare(`SELECT src_kind, src_id, dst_kind, dst_id, relation, confidence FROM edge
      WHERE (src_kind = 'asset' AND src_id = ?) OR (dst_kind = 'asset' AND dst_id = ?)`).all(String(a.id), String(a.id))
    return detail
  }

  /** 그래프 투영: C 대역 → 자산 → 열린 포트(+ 도메인 해석 관계). */
  graph(id, f = {}) {
    const db = this.db(id)
    const nodes = []
    const edges = []
    const seen = new Set()
    const push = (node) => { if (!seen.has(node.id)) { seen.add(node.id); nodes.push(node) } }
    const segs = f.cidr
      ? db.prepare('SELECT * FROM segment WHERE cidr = ?').all(f.cidr)
      : db.prepare('SELECT * FROM segment').all()
    for (const s of segs) {
      push({ id: `seg:${s.cidr}`, kind: 'segment', label: s.cidr, meta: { org: s.org, asn: s.asn } })
      for (const a of db.prepare('SELECT * FROM asset WHERE segment_cidr = ? ORDER BY ip_int').all(s.cidr)) {
        const nid = `asset:${a.id}`
        const ports = db.prepare("SELECT COUNT(*) AS n FROM port WHERE asset_id = ? AND state = 'open'").get(a.id).n
        push({ id: nid, kind: 'asset', label: a.ip, meta: { state: a.state, name: a.primary_name, ports, segment: a.segment_cidr } })
        edges.push({ source: `seg:${s.cidr}`, target: nid, relation: 'contains' })
        for (const p of db.prepare('SELECT id, port, proto, provenance FROM port WHERE asset_id = ? AND state = ?').all(a.id, 'open')) {
          const pid = `port:${p.id}`
          push({ id: pid, kind: 'port', label: `${p.port}/${p.proto}`, meta: { provenance: p.provenance, asset: a.ip } })
          edges.push({ source: nid, target: pid, relation: 'exposes' })
        }
        if (a.primary_name) {
          const did = `name:${a.primary_name}`
          push({ id: did, kind: 'domain', label: a.primary_name, meta: {} })
          edges.push({ source: did, target: nid, relation: 'resolves' })
        }
      }
    }
    return { nodes, edges }
  }

  /* ---------- 득점 목표(공방 훈련 득점 포인트 + 득점 기록) ---------- */

  /** 타깃을 처음 열 때 기본 득점 포인트를 시딩한다(이미 있으면 건드리지 않는다). */
  /** 작전 단계: 처음 읽을 때 기본 5 단계를 보충 시딩한다(득점 포인트와 같은 전략, 구 타깃도 자동 적용). */
  seedStages(id) {
    const db = this.db(id)
    /* 자동 복구식 보충 시딩: 빠진 것만 채운다(구 DB 에서 이전 버전 마이그레이션에 잘못 삭제된 단계는 자동 복구) */
    const have = new Set(db.prepare('SELECT code FROM stage').all().map((r) => r.code))
    if (DEFAULT_STAGES.every((st) => have.has(st.code))) return { seeded: 0 }
    let order = db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS n FROM stage').get().n + 1
    const stmt = db.prepare(`INSERT INTO stage(code, name, subtitle, color, goal, sections, tools, transition, sort_order, updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?)`)
    let seeded = 0
    for (const st of DEFAULT_STAGES) {
      if (have.has(st.code)) continue
      stmt.run(st.code, st.name, st.subtitle, st.color, st.goal, JSON.stringify(st.sections),
        st.tools, st.transition, order++, nowIso())
      seeded += 1
    }
    return { seeded: seeded }
  }

  listStages(id) {
    const db = this.db(id)
    this.seedStages(id)
    return db.prepare('SELECT * FROM stage ORDER BY sort_order, code').all().map((r, i) => ({
      code: r.code, name: r.name, subtitle: r.subtitle || '', color: r.color || '#64748b',
      goal: r.goal || '', sections: parseJson(r.sections, []), tools: r.tools || '',
      transition: r.transition || '',
      /* 체인에서의 실제 위치(몇 번째 단계): UI 의 ①②③ 표시와 리포트 정렬이 모두 이 값을 쓰므로 따로 번호를 매기지 않는다 */
      ordinal: i + 1,
      updated_at: r.updated_at || null,
    }))
  }

  /** 단계 내용 편집(이름/목표/수단 그룹/도구/ATT&CK/전환 문구). */
  saveStage(id, patch = {}) {
    const db = this.db(id)
    if (!patch.code) throw new Error('stage.code required')
    const cur = db.prepare('SELECT * FROM stage WHERE code = ?').get(String(patch.code))
    db.prepare(`INSERT INTO stage(code, name, subtitle, color, goal, sections, tools, transition, sort_order, updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(code) DO UPDATE SET
        name = excluded.name, subtitle = excluded.subtitle, color = excluded.color, goal = excluded.goal,
        sections = excluded.sections, tools = excluded.tools,
        transition = excluded.transition, updated_at = excluded.updated_at`).run(
      String(patch.code),
      patch.name ?? (cur ? cur.name : String(patch.code)),
      patch.subtitle ?? (cur ? cur.subtitle : ''),
      patch.color ?? (cur ? cur.color : '#64748b'),
      patch.goal ?? (cur ? cur.goal : ''),
      patch.sections !== undefined ? JSON.stringify(patch.sections) : (cur ? cur.sections : '[]'),
      patch.tools ?? (cur ? cur.tools : ''),
      patch.transition ?? (cur ? cur.transition : ''),
      patch.sort_order ?? (cur ? cur.sort_order : 0),
      nowIso(),
    )
    return { code: String(patch.code), updated: true }
  }

  seedScorePoints(id) {
    const db = this.db(id)
    const insert = (point, order) => db.prepare(`INSERT INTO score_point
        (code, name, category, points, description, enabled, sort_order, created_at, updated_at,
         src, rule, tier, cap, dedup_scope, legacy, builtin)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      point.code, point.name, point.category, point.points, point.description,
      point.enabled === 0 ? 0 : 1, order, nowIso(), nowIso(),
      point.src ?? null,
      point.rule ?? null, point.tier ?? null, point.cap ?? 0, point.dedup_scope || 'service', point.legacy === 1 ? 1 : 0,
      /* 내장 항목: 규칙과 함께 배포되며, 점수/산정 기준이 고정되고 삭제할 수 없다 */
      point.legacy === 1 ? 0 : 1,
    )
    const have = new Set(db.prepare('SELECT code FROM score_point').all().map((r) => String(r.code)))

    /* ── 내장 항목 표시 백필 + 구 DB 정리(구 득점 항목 전체 폐기)────────────────────────
       백필: 구 DB 의 builtin 컬럼은 막 생성했을 때 전부 0 이므로, code 명단에 따라 내장 항목을 다시 표시한다.
       정리 산정 기준: **"내장 명단에 있는 구 code" 만 정리한다** —— 즉 구 버전이 패키지에 함께 배포한 기본 항목
       (web-account-* / webshell / rce / server-shell / db-access / sensitive-data /
       boundary / internal-pivot / core-system 등)과 그 과거 적중 기록.

       ⚠️ "내장인지" 판정은 **반드시 builtin 컬럼으로** 해야 하며, "현재 기본 명단에 있는지"로 판정하면 안 된다:
       사용자가 직접 만든 득점 포인트가 구 체계의 잔재로 취급되어, 다음에 득점 패널을 읽을 때 적중 기록과 함께 조용히 삭제되고,
       saveScorePoint 는 그대로 ok 를 반환하고 UI 는 그대로 "저장됨" 을 띄운다.

       ⚠️ 되돌릴 수 없다: 정리 전에 삭제될 득점 포인트와 적중 기록을 **<타깃>/runs/legacy-score-<시간>.json 으로 내보내**
       한 번 보관해야 한다(리포트/감사에서 계속 조회 가능). 그런 다음에 삭제한다. */
    const builtinCodes = DEFAULT_SCORE_POINTS.map((x) => x.code)
    const keep = new Set(builtinCodes)
    try {
      const ph = builtinCodes.map(() => '?').join(',')
      db.prepare('UPDATE score_point SET builtin = 1 WHERE code IN (' + ph + ')').run(...builtinCodes)
    } catch { /* 구 DB 구조 이상: 채점에 영향 없음, 다음 시딩 때 재시도 */ }
    let purgedPoints = 0
    let purgedHits = 0
    try {
      const doomed = db.prepare('SELECT id, code, name, category, points, legacy, builtin FROM score_point').all()
        .filter((r) => !keep.has(String(r.code)) && (Number(r.legacy) === 1 || Number(r.builtin) === 1))
      if (doomed.length > 0) {
        const ids = doomed.map((r) => r.id)
        const ph = ids.map(() => '?').join(',')
        const hits = db.prepare(`SELECT * FROM score_hit WHERE point_id IN (${ph})`).all(...ids)
        if (hits.length > 0) {
          /* 보관: 타깃 디렉터리의 runs/ 아래에 두어, 다른 증거와 같은 자리에 모은다 */
          try {
            const dir = join(this.dirOf(id), 'runs')
            mkdirSync(dir, { recursive: true })
            const stamp = nowIso().replace(/[:.]/g, '-')
            writeFileSync(join(dir, 'legacy-score-' + stamp + '.json'),
              JSON.stringify({
                archived_at: nowIso(),
                reason: '돌파 침투류 득점 규칙(통합판)에 따라 재구성: 구 득점 항목 전체 폐기',
                points: doomed, hits,
              }, null, 2), 'utf8')
          } catch { /* 보관 실패는 정리를 막지 않지만, 사실대로 기록해 둔다 */ }
        }
        db.prepare(`DELETE FROM score_hit WHERE point_id IN (${ph})`).run(...ids)
        db.prepare(`DELETE FROM score_point WHERE id IN (${ph})`).run(...ids)
        purgedPoints = doomed.length
        purgedHits = hits.length
      }
    } catch { /* 테이블 미존재 등의 예외: 무시하고 시딩을 막지 않는다 */ }

    /* 내장 득점 포인트의 **규칙 메타데이터 동기화**: 규칙 문서가 바뀌면(카테고리 그룹, 상한, 채점 산정 기준, 등급 설명,
       조항 본문), 여기서 이를 이미 존재하는 행에 동기화해야 한다.
       반드시 필요한 이유: 예전에는 code 로 "빠진 것만 보충" 했기 때문에, category 를 바꾼 항목은 구 DB 에서
       이전 값이 그대로 남는다 —— 패널은 category 로 묶기 때문에 같은 분류가 두 그룹으로 쪼개진다
       (예: NETINFRA 와 "네트워크 인프라"가 각각 한 그룹), 카테고리가 두 개 늘어난 것처럼 보인다.

       ⚠️ 점수/상한/기준**은 규칙이 고정**(builtin=1), 사용자가 바꿀 수 없다: 이는 단지 "의도적 덮어쓰기"가 아니라
       더욱이 **반드시** 그래야 한다 —— 같은 rule 의 cap 은 규칙 내 모든 포인트를 누적하므로, 단일 항목 점수를 바꿀 수 있게 두면
       사용자가 50 을 500 으로 바꾸면 한 번의 히트로 규칙 전체 상한을 먹어버린다.
       그래서 내장 포인트의 name/category/description 과 규칙 전체의 rule/tier/cap/dedup_scope/points 는
       모두 여기서 일괄 동기화한다; **"활성화/비활성화"는 여전히 사용자가 제어하며 여기서 덮어쓰지 않는다**.
       UI 쪽은 이에 따라 내장 포인트의 점수 입력 상자를 회색 처리한다 (overridden:false 를 반환해 화면이 이유를 알릴 수 있게 한다).

       사용자가 점수를 직접 정하고 싶다면 **새 득점 항목을 추가**하라 (builtin=0) —— 그 항목은 여기서 덮어쓰지 않고,
       위의 구 체계 정리에서도 삭제되지 않는다. */
    let synced = 0
    if (have.size > 0) {
      const upd = db.prepare(`UPDATE score_point SET name = ?, category = ?, points = ?, description = ?,
          src = ?, rule = ?, tier = ?, cap = ?, dedup_scope = ?, builtin = 1, updated_at = ?
        WHERE code = ? AND legacy = 0`)
      for (const point of DEFAULT_SCORE_POINTS) {
        if (!have.has(point.code)) continue
        try {
          const r = upd.run(point.name, point.category, point.points, point.description,
            point.src ?? null,
            point.rule ?? null, point.tier ?? null, point.cap ?? 0, point.dedup_scope || 'service',
            nowIso(), point.code)
          if (r.changes > 0) synced += 1
        } catch { /* 단일 항목 실패는 무시 */ }
      }
    }

    /* 빠진 것을 채운다: 새 규칙과 실수로 삭제된 기본 포인트 모두 이 한 줄로 자동 복구된다 */
    const missing = DEFAULT_SCORE_POINTS.filter((p) => !have.has(p.code))
    if (missing.length > 0) {
      let order = db.prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM score_point').get().n
      for (const point of missing) insert(point, order++)
    }
    if (missing.length === 0 && purgedPoints === 0 && synced === 0) return { seeded: 0 }
    return {
      seeded: missing.length,
      /* 이번에 정리된 구 득점 항목과 히트 수 (패널/도구가 이 정보로 "구 기준은 폐기됨"을 알린다) */
      purgedLegacyPoints: purgedPoints,
      purgedLegacyHits: purgedHits,
      purged: purgedPoints > 0,
    }
  }

  listScorePoints(id, f = {}) {
    const db = this.db(id)
    /* 매번 시딩을 한 번 실행한다: 멱등이며 동시에 세 가지를 담당한다 ——
       ① 빈 DB 최초 시딩; ② 새 규칙/실수로 삭제된 포인트 자동 복구; ③ 구 DB 의 옛 기본 포인트를 legacy 로 표시 (v0.11.0 마이그레이션).
       ⚠️ 예전에는 "득점 항목이 하나도 없을 때"만 호출했기 때문에, 구 DB(이미 옛 포인트 보유)는 영원히 마이그레이션되지 않았다. */
    this.seedScorePoints(id)
    /* **점수 낮은 순에서 높은 순**으로 표시한다 (동점은 정의 순서 유지) —— 사용자가 점수 크기로 누구를 먼저 칠지 판단하는 편이 직관적이다 */
    const rows = db.prepare('SELECT * FROM score_point ORDER BY COALESCE(points, 0) ASC, sort_order ASC, id ASC').all()
    const hits = db.prepare('SELECT * FROM score_hit ORDER BY recorded_at DESC, id DESC').all()
    /* 자산 IP — 경고와 히트 기록에서 어떤 서비스인지 바로 보여야 한다 (asset_ip:port) */
    const assetIp = new Map(db.prepare('SELECT id, ip FROM asset').all().map((a) => [a.id, a.ip]))
    const codeOf = new Map(rows.map((r) => [r.id, r.code]))
    /* 기본 점수는 득점 항목에서 가져온다; 히트에 points 가 있으면 히트를 우선한다 (병합판의 다단계 채점) */
    const pointsOf = new Map(rows.map((r) => [r.id, Number(r.points) || 0]))
    /* 히트 행의 유효 점수: 단계 점수 × 배율 (배율은 scoreMultiplierOf / hitPointsOf 참고) */
    const effPointsOf = (h) => hitPointsOf(
      { points: h.points, multiplier: h.multiplier, code: codeOf.get(h.point_id) },
      new Map([[String(codeOf.get(h.point_id)), { points: pointsOf.get(h.point_id) || 0 }]]),
    )
    const byPoint = new Map()
    for (const h of hits) {
      if (!byPoint.has(h.point_id)) byPoint.set(h.point_id, [])
      byPoint.get(h.point_id).push(h)
    }
    /* 채점 기준과 규칙 상한 (데이터 기반, applyScoreCaps 참고):
       · dedup_scope 가 "동일 대상/동일 시스템/동일 서비스는 최고 한 건만 계산"인지, 아니면 대수 기준 누적인지 결정한다;
       · rule + cap 이 해당 규칙의 누적 상한을 결정한다.
       자체 생성 계정은 경쟁에도 참여하지 않고 자리도 차지하지 않는다 (원래부터 채점하지 않는다). */
    /* 메타데이터와 평가는 모두 공용 구현을 쓴다 (evaluateScoreBoard): 패널 / 보고서 / 공격 체인 세 곳에서
       각자 따로 구현하면 반드시 기준이 달라져 총점이 맞지 않는다. */
    const pointsMeta = new Map(rows.map((r) => [String(r.code), {
      rule: r.rule === null || r.rule === undefined ? null : Number(r.rule),
      cap: Number(r.cap) || 0,
      dedup_scope: r.dedup_scope || 'service',
      points: Number(r.points) || 0,
      enabled: r.enabled === null || r.enabled === undefined ? 1 : Number(r.enabled),
      builtin: Number(r.builtin) === 1,
      src: r.src === null || r.src === undefined ? null : Number(r.src),
    }]))
    const nameOf = loadAssetNames(db)
    const cappedAll = evaluateScoreBoard(db, hits.map((h) => Object.assign({}, h, {
      code: codeOf.get(h.point_id), points: effPointsOf(h),
    })), { meta: pointsMeta, names: nameOf })
    const cappedById = new Map(cappedAll.items.map((h) => [h.id, h]))
    const enabled = rows.filter((r) => r.enabled === 1)
    const enabledIds = new Set(enabled.map((r) => r.id))
    /* 이 득점 항목이 "동일 기준 최고 한 건만" 중복 제거에 참여하는지 (화면에 "획득 완료" 안내를 표시하기 위함) */
    const isCappedPoint = (pid) => {
      const meta = pointsMeta.get(codeOf.get(pid))
      return meta !== undefined && meta.dedup_scope !== 'none' && meta.dedup_scope !== null
    }
    const items = rows
      .filter((r) => f.enabledOnly !== true || r.enabled === 1)
      .map((r) => {
        const list = (byPoint.get(r.id) || []).map((h) => {
          const flag = cappedById.get(h.id)
          const capped = flag !== undefined && flag.capped === true
          const hit = {
            id: h.id, asset_id: h.asset_id, vuln_id: h.vuln_id, step_id: h.step_id,
            target: h.target, evidence: h.evidence, note: h.note,
            points: effPointsOf(h), points_overridden: h.points !== null && h.points !== undefined,
            port: normalizePort(h.port) ?? parseTargetPort(h.target),
            self_created: Number(h.self_created) === 1,
            capped: capped,
            capped_by_id: capped ? flag.capped_by_id : null,
            capped_reason: capped ? scoreCapReasonText(Object.assign({}, h, {
              code: r.code, asset_ip: assetIp.get(h.asset_id),
              rule: flag.rule ?? null, rule_cap: flag.rule_cap || 0, capped_reason_kind: flag.capped_reason_kind,
            }), flag.capped_by_points) : null,
            capped_reason_kind: capped ? flag.capped_reason_kind : null,
            recorded_by: h.recorded_by, recorded_at: h.recorded_at,
          }
          hit.service = serviceLabel(Object.assign({}, hit, { asset_ip: assetIp.get(h.asset_id) }))
          if (capped) hit.capped_by = flag.capped_by_evidence ?? null
          return hit
        })
        /* 상한이 없는 득점 항목: 히트 수 × 점수를 누적한다.
           자체 생성 계정(self_created)은 채점하지 않는다; 계정류/데이터베이스류는 서비스 단위로 상한을 두고 최고 한 건만 계산한다. */
        const valid = list.filter((h) => h.self_created !== true)
        const countedList = valid.filter((h) => h.capped !== true)
        const counted = countedList.length
        const cappedList = valid.filter((h) => h.capped === true)
        const meta = pointsMeta.get(r.code) || { rule: null, cap: 0, dedup_scope: 'service' }
        const capUsed = meta.rule === null ? null : cappedAll.caps.get('rule:' + meta.rule)
        const scopeLabel = { service: "Highest hit per service counts once", system: "Highest privilege per system counts once", target: "Counts once for the whole target", none: "Accumulates per host / card / node" }[meta.dedup_scope] || ''
        return {
          id: r.id, code: r.code, name: r.name, category: r.category, points: r.points,
          rule: meta.rule, tier: r.tier || null, cap: meta.cap || 0, dedup_scope: meta.dedup_scope,
          /* src = "병합판"의 원본 번호 (대조용); builtin = 규칙과 함께 배포되는 내장 항목 (점수 고정, 삭제 불가).
             화면은 이에 따라 내장 항목의 점수 입력 상자를 회색 처리하고 이유를 제시한다. */
          src: r.src === null || r.src === undefined ? null : Number(r.src),
          builtin: Number(r.builtin) === 1,
          legacy: Number(r.legacy) === 1,
          counted: counted,
          /* "히트에 반영된 실제 점수"로 누적한다 —— 병합 후 같은 code 에 여러 단계가 포함되므로 기본 점수 × 횟수로 계산할 수 없다 */
          earned: countedList.reduce((n, h) => n + (Number(h.points) || 0), 0),
          self_created: list.length - valid.length,
          capped: cappedList.length,
          capped_hits: cappedList,
          /* 규칙 상한 사용량 (같은 rule 의 득점 항목이 공유; 화면은 규칙별 그룹으로 "사용 / 상한"을 표시) */
          cap_used: capUsed ? capUsed.used : null,
          cap_capped: capUsed ? capUsed.capped : 0,
          scope_label: scopeLabel,
          service_summary: (meta.dedup_scope !== 'none' && cappedList.length > 0)
            ? "Scoring basis \"" + scopeLabel + "\": " + counted + " counted; " + cappedList.length + " duplicate hit(s) not scored"
            : null,
          description: r.description || '', enabled: r.enabled === 1, sort_order: r.sort_order,
          hits: list,
        }
      })

    /* ── 증거 스크린샷: 득점 항목마다 최대 3 장의 대표 이미지를 연결한다 ─────────────────────────────
       대량 득점 항목(터미널 권한 한 번에 60 대)에 건별로 이미지를 붙이면 정보도 없고 페이지도 터진다,
       그래서 "득점 항목" 단위로 대표 이미지를 준다; 건별로 보고 싶다면 히트 행에 해당 건의 스크린샷 수가 표시된다.
       이미지 선택 우선순위는 #representativeShots 참고 (히트 레벨 > 대상 레벨 > 항목 레벨, 현장 스크린샷 > 생성된 증거 카드). */
    const shotPicks = this.#representativeShots(id, items.map((it) => ({
      point_id: it.id, point_code: it.code, hit_ids: (it.hits || []).map((h) => h.id),
    })), 3)
    const shotCountByPoint = new Map()
    const shotCountByHit = new Map()
    try {
      for (const row of db.prepare('SELECT point_id, hit_id, COUNT(*) AS n FROM shot GROUP BY point_id, hit_id').all()) {
        if (row.point_id !== null && row.point_id !== undefined) {
          shotCountByPoint.set(Number(row.point_id), (shotCountByPoint.get(Number(row.point_id)) || 0) + Number(row.n))
        }
        if (row.hit_id !== null && row.hit_id !== undefined) shotCountByHit.set(Number(row.hit_id), Number(row.n))
      }
    } catch { /* 구 DB 에 shot 테이블이 아직 없으면 무시 */ }
    const shotBrief = (x) => ({
      id: Number(x.id), url: this.shotUrlOf(id, x), label: x.label || '', note: x.note || '',
      kind: x.kind || 'screenshot', mime: x.mime || 'image/png', bytes: Number(x.bytes) || 0,
      target: x.target || '', captured_at: x.captured_at || '', source_ref: x.source_ref || '',
    })
    for (const it of items) {
      const picked = shotPicks.get(Number(it.id)) || []
      it.shots = picked.map(shotBrief)
      it.shot_total = shotCountByPoint.get(Number(it.id)) || 0
      it.shot_shown = picked.length
      for (const h of (it.hits || [])) h.shot_count = shotCountByHit.get(Number(h.id)) || 0
    }

    /* 정렬: **득점한 항목이 앞** (성과를 한눈에 보도록), 미득점은 뒤;
       두 그룹 내부는 모두 점수 낮은 순에서 높은 순 (동점은 정의 순서, 결과가 안정적이고 예측 가능). */
    const achievedRank = (it) => (it.hits.length > 0 ? 0 : 1)
    const sortedItems = items.slice().sort((a, b) => {
      const ra = achievedRank(a); const rb = achievedRank(b)
      if (ra !== rb) return ra - rb
      const pa = Number(a.points) || 0; const pb = Number(b.points) || 0
      if (pa !== pb) return pa - pb
      return (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0)
    })

    /* ── 병합판의 8 개 분류로 그룹화 (일반 시스템 제어 / Web 애플리케이션 / 중앙 집권 / 빅데이터 /
       네트워크 인프라 / 파일 스토리지 / 모델 관련 / 네트워크 경계 돌파)────────────────────
       패널과 보고서 모두 이 그룹으로 표시한다: 사용자가 보는 것이 곧 규칙 문서의 구조다.
       그룹 내는 점수 오름차순 (items 는 이미 정렬됨), 그룹 순서는 곧 SCORE_GROUPS 의 정의 순서다. */
    const groupOrder = new Map(SCORE_GROUPS.map((g, i) => [g.code, i]))
    const groupName = new Map(SCORE_GROUPS.map((g) => [g.code, g.name]))
    const ruleGroups = []
    const gmap = new Map()
    for (const it of sortedItems) {
      if (it.legacy) continue
      const code = it.category || 'OTHER'
      if (!gmap.has(code)) {
        const g = {
          key: code, code,
          name: groupName.get(code) || code,
          /* 해당 분류 아래 모든 항목의 상한 합계 (참고 값일 뿐 —— 각 항목 상한은 독립이며 항목 간 누적되지 않는다, G3 참고) */
          capSum: 0, points: 0, counted: 0, capped: 0, tiers: [],
          order: groupOrder.has(code) ? groupOrder.get(code) : 99,
        }
        gmap.set(code, g); ruleGroups.push(g)
      }
      const g = gmap.get(code)
      g.capSum += Number(it.cap) || 0
      g.points += it.earned
      g.counted += it.counted
      g.capped += it.capped
      g.tiers.push(it)
    }
    ruleGroups.sort((a, b) => a.order - b.order)
    /* 그룹 내에서 다시 한 번 폴백한다 (호출자가 순서를 바꿨을 경우 대비): 득점 우선, 그다음 점수 오름차순 */
    for (const g of ruleGroups) {
      g.tiers.sort((a, b) => {
        const ra = achievedRank(a); const rb = achievedRank(b)
        if (ra !== rb) return ra - rb
        return (Number(a.points) || 0) - (Number(b.points) || 0)
      })
    }
    const legacyItems = items.filter((it) => it.legacy)
    const legacyHits = legacyItems.reduce((n, p) => n + p.hits.length, 0)
    const enabledItems = items.filter((p) => p.enabled)
    const cappedItems = cappedAll.items.filter((h) => h.capped === true && (codeOf.get(h.point_id) !== undefined) && enabledIds.has(h.point_id))
    const latestCapped = cappedItems.length === 0 ? null : cappedItems.slice().sort((a, b) => {
      const sa = String(a.recorded_at || '') + '#' + String(a.id).padStart(8, '0')
      const sb = String(b.recorded_at || '') + '#' + String(b.id).padStart(8, '0')
      return sb.localeCompare(sa)
    })[0]
    return {
      items: sortedItems,
      ruleGroups,
      summary: {
        /* 상한 없음: 점수 = 히트 수 × 점수, 누적하면 된다 */
        achievedPoints: enabledItems.reduce((n, p) => n + p.earned, 0),
        /* 득점 항목 개수 (화면은 이것으로 표시하고, 더 이상 "N 개 확보"라고 하지 않는다) */
        pointCount: enabledItems.length,
        hitPointCount: enabledItems.filter((p) => p.counted > 0).length,
        hitCount: items.reduce((n, p) => n + p.hits.length, 0),
        countedHits: enabledItems.reduce((n, p) => n + p.counted, 0),
        /* 자체 등록/자체 생성으로 제외된 히트 수 (화면에서 따로 알려 "기록했는데 점수가 없다"는 혼란을 피한다) */
        selfCreatedHits: items.reduce((n, p) => n + p.self_created, 0),
        /* "채점 기준 중복 제거" 또는 "규칙이 상한에 도달"로 채점되지 않은 건수 (화면에서 따로 알려 "기록했는데 점수가 없다"는 혼란을 피한다) */
        serviceCappedHits: cappedItems.length,
        cappedByDedup: cappedItems.filter((h) => h.capped_reason_kind === 'dedup').length,
        cappedByRuleLimit: cappedItems.filter((h) => h.capped_reason_kind === 'cap').length,
        /* legacy(구버전 기준) 득점 항목과 히트: 화면은 접어서 표시하고 새 기준의 총점에 합치지 않는다 */
        legacyPointCount: legacyItems.length,
        legacyHitCount: legacyHits,
        latestCapped: latestCapped === null ? null : {
          hit_id: latestCapped.id,
          point_id: latestCapped.point_id,
          code: latestCapped.code,
          service: serviceLabel(Object.assign({}, latestCapped, { asset_ip: assetIp.get(latestCapped.asset_id) })),
          evidence: latestCapped.evidence,
          points: latestCapped.points,
          recorded_at: latestCapped.recorded_at,
          reason: serviceCapReason(Object.assign({}, latestCapped, { asset_ip: assetIp.get(latestCapped.asset_id) }), latestCapped.capped_by_points),
        },
      },
    }
  }

  /** 득점 항목을 추가하거나 갱신한다 (id 를 주면 id 로 갱신, 주지 않으면 추가). 득점 분류**에는 개수 상한이 없다**, 점수만 기록한다. */
  /**
   * 득점 항목을 저장한다.
   *
   * 두 경로의 차이가 커서, 반환 구조에서 `builtin` / `overridden` / `locked_fields` 로 분명히 알린다:
   *   · **내장 항목** (builtin=1, "침투 돌파류 득점 규칙"과 함께 배포): 점수/상한/채점 기준/이름
   *     은 규칙이 고정하며 "활성화/비활성화"만 바꿀 수 있다. **점수 변경 불가**는 단순한 규율 문제가 아니다 ——
   *     같은 rule 의 cap 은 그룹 내 모든 항목을 누적하므로, 단일 항목 점수를 바꾸면 한 번의 히트로 그룹 전체 상한을 먹을 수 있다.
   *     여기서도 `ok` 를 반환한다 (활성화 상태는 실제로 저장되었다), 하지만 `overridden:false` 로 분명히 알린다
   *     호출자에게 "제출한 점수가 채택되지 않았다"고 하고, 화면은 그에 따라 이유를 알리며 저장 성공인 척하지 않는다.
   *   · **사용자 자체 생성 항목** (builtin=0): 모든 필드를 바꿀 수 있고, 시딩 로직이 지우지 않는다.
   */
  saveScorePoint(id, point = {}) {
    const db = this.db(id)
    const enabled = point.enabled === false ? 0 : 1
    /* name 필수 검증은 **내장 항목 분기 뒤에** 두어야 한다: 내장 항목은 enabled / sort_order 만 받으므로,
       호출자(화면 토글, 활성화 상태만 바꾸는 도구)는 원래 name 을 반드시 되돌려 줄 필요가 없다.
       앞에 두면 "내장 득점 항목 하나만 비활성화하고 싶다"는 경우가 곧바로 name required 로 실패한다. */
    const name = String(point.name || '').trim()
    /* max_hits 컬럼은 구 DB 구조 호환을 위해서만 남겨 둔다, 채점에는 더 이상 쓰지 않는다 (항상 1 을 쓴다) */
    if (point.id !== undefined && point.id !== null && Number(point.id) > 0) {
      const pid = Number(point.id)
      const row = db.prepare('SELECT id, code, name, points, cap, rule, tier, dedup_scope, builtin, legacy FROM score_point WHERE id = ?').get(pid)
      if (row === undefined) throw new Error('score point not found: id=' + pid)
      if (Number(row.builtin) === 1 || Number(row.legacy) === 1) {
        /* 내장 항목: enabled / sort_order 만 기록하고, 나머지 필드는 seedScorePoints 가 규칙에 맞춰 동기화한다 */
        db.prepare('UPDATE score_point SET enabled = ?, sort_order = COALESCE(?, sort_order), updated_at = ? WHERE id = ?')
          .run(enabled, point.sort_order ?? null, nowIso(), pid)
        const after = db.prepare('SELECT * FROM score_point WHERE id = ?').get(pid)
        return {
          id: pid, updated: true, builtin: true,
          points: after.points, cap: after.cap, rule: after.rule,
          overridden: Number(point.points) === Number(after.points),
          locked_fields: ['name', 'category', 'points', 'cap', 'rule', 'tier', 'dedup_scope', 'description'],
          note: "This is a built-in score point shipped with the red-team scoring rules: points, cap, scoring basis, name, and clause text"
            + " are all locked by the rules (one rule's cap accumulates across all score points in its group; changing a single point's value would let one hit eat the whole group's cap)."
            + "Your enable/disable change was saved. To use a custom value, **add a new score point**.",
        }
      }
      if (name === '') throw new Error('score point name required')
      const points = Number.isFinite(Number(point.points)) ? Number(point.points) : 0
      db.prepare(`UPDATE score_point SET name = ?, category = ?, points = ?, description = ?, enabled = ?,
          sort_order = COALESCE(?, sort_order), updated_at = ? WHERE id = ?`)
        .run(name, point.category ?? null, points, point.description ?? null, enabled,
          point.sort_order ?? null, nowIso(), pid)
      return { id: pid, updated: true, builtin: false, overridden: true, points, note: "Saved (custom score point)" }
    }
    if (name === '') throw new Error('score point name required')
    const points = Number.isFinite(Number(point.points)) ? Number(point.points) : 0
    const next = db.prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM score_point').get().n
    /* 자체 생성 항목이 내장 항목과 같은 code 를 가질 수 있다 (패널이 기본적으로 이름으로 생성): code 에 UNIQUE 제약이 있어,
       충돌하면 다른 것으로 바꾼다, "추가에 실패했는데 화면에서는 이유를 알 수 없다"를 피하기 위해서다. */
    let code = point.code === undefined || point.code === null || String(point.code).trim() === ''
      ? null
      : String(point.code).trim()
    if (code !== null && db.prepare('SELECT id FROM score_point WHERE code = ?').get(code) !== undefined) {
      code = code + '-custom-' + Date.now().toString(36)
    }
    const r = db.prepare(`INSERT INTO score_point(code, name, category, points, description, enabled, sort_order, created_at, updated_at, builtin)
      VALUES(?,?,?,?,?,?,?,?,?,0)`).run(
      code, name, point.category ?? null, points, point.description ?? null, enabled,
      next, nowIso(), nowIso(),
    )
    return {
      id: Number(r.lastInsertRowid), code, updated: false, builtin: false, overridden: true,
      points, note: "Added a custom score point (not locked to the rule value, and not removed by legacy cleanup)",
    }
  }

  /** 득점 항목을 삭제한다. 내장 항목은 삭제할 수 없다 (그러면 패널에서 규칙이 하나 빠지고, 다음 시딩에서 다시 생겨난다). */
  deleteScorePoint(id, pointId) {
    const db = this.db(id)
    const pid = Number(pointId)
    const row = db.prepare('SELECT id, code, name, builtin FROM score_point WHERE id = ?').get(pid)
    if (row === undefined) throw new Error('score point not found: id=' + pid)
    if (Number(row.builtin) === 1) {
      throw new Error("Built-in score points cannot be deleted: \"" + (row.name || row.code) + "\" comes from the merged red-team scoring rules; "
        + "deleting it would leave the panel missing a rule and the report missing a class of results (it will be re-added automatically on the next start)."
        + "To exclude it from scoring, use Disable instead.")
    }
    db.prepare('DELETE FROM score_hit WHERE point_id = ?').run(pid)
    db.prepare('DELETE FROM score_point WHERE id = ?').run(pid)
    return { deleted: pid }
  }

  /**
   * 이 득점이 어느 포트에 속하는지 (서비스 단위 상한의 입도).
   *   ① 명시적 `port` (도구 인자);
   *   ② `target` 안의 포트 (http://h:8080/x → 8080, 10.0.0.5:6379 → 6379);
   *   ③ 해당 자산에 포트가 하나만 등록되어 있으면 그것을 쓴다 (80/443 이라고 추측하지 않는다, 서로 다른 서비스를 하나로 합치지 않도록).
   */
  #servicePortOf(db, hit = {}) {
    const explicit = normalizePort(hit.port)
    if (explicit !== null) return explicit
    const fromTarget = parseTargetPort(hit.target)
    if (fromTarget !== null) return fromTarget
    const assetId = hit.asset_id === null || hit.asset_id === undefined || hit.asset_id === '' ? null : Number(hit.asset_id)
    if (assetId === null) return null
    try {
      const ports = db.prepare('SELECT port FROM port WHERE asset_id = ? ORDER BY port').all(assetId)
      if (ports.length === 1) return normalizePort(ports[0].port)
    } catch { /* 무시 */ }
    return null
  }

  /** 득점을 한 번 기록한다 (어떤 득점 항목이 어떤 대상에서 확보되었을 때). */
  addScoreHit(id, hit = {}) {
    const db = this.db(id)
    /* 득점 항목이 아직 시딩되지 않았을 수 있다 (새 표적을 만든 뒤 바로 채점): 먼저 멱등 시딩을 한 번 실행한다,
       그렇지 않으면 "score point not found" 오류가 나는데, 실제 원인은 기본 득점 항목이 아직 기록되지 않은 것이다. */
    this.seedScorePoints(id)
    let pointId = hit.point_id !== undefined && hit.point_id !== null ? Number(hit.point_id) : null
    /* code 로 득점 항목을 찾는다 (가장 흔한 경로). 옛 code 는 옛 득점 항목과 함께 폐기되었다 (v0.11.1):
       여기서 **조용한 재배정은 하지 않는다** —— 재배정 대상 자체가 이미 없을 수 있고, 조용히 삼키면 사용자가
       "기록했는데 점수가 없다"는 상황에서 원인을 찾을 수 없게 된다. 찾지 못하면 아래 point not found 오류로 떨어지고,
       오류 메시지에서 redteam_score_list 로 가서 새 code 를 받으라고 분명히 알린다. */
    if (pointId === null && hit.code) {
      const row = db.prepare('SELECT id FROM score_point WHERE code = ?').get(String(hit.code))
      if (row !== undefined) pointId = row.id
    }
    if (pointId === null && hit.point_name) {
      const row = db.prepare('SELECT id FROM score_point WHERE name = ?').get(String(hit.point_name))
      if (row !== undefined) pointId = row.id
    }
    if (pointId === null) {
      throw new Error("score point not found: scoring rules were rebuilt into 25 items under the merged red-team scoring rules; "
        + "the old codes (web-account-*, webshell, rce, server-shell, db-access, sensitive-data, boundary, internal-pivot, core-system, etc.) are obsolete. "
        + "Read the actual codes with redteam_score_list first, or specify point_id / point_name.")
    }
    const evidence = String(hit.evidence || '').trim()
    if (evidence === '') throw new Error("score hit evidence required: a hit must state its evidence (account / command output / data volume / path)")
    /* 자체 등록/자체 생성 계정: 기록은 허용하되 (과정을 남긴다), 채점하지 않는다 */
    const selfCreated = hit.self_created === true || hit.self_created === 1 || hit.self_created === '1' ? 1 : 0
    const port = this.#servicePortOf(db, hit)
    /* 이 히트의 실제 점수: 호출자가 명시적으로 지정할 수 있다 (병합판에서는 같은 항목에 여러 단계가 포함된다, 예: "관리자 50").
       지정하지 않으면 NULL 로 기록한다 —— 채점 시 득점 항목의 기본 points 로 되돌아간다.

       ⚠️ 경계 검증을 반드시 해야 한다: `points` 는 "특정 단계의 점수"이지 자유롭게 입력하는 가산점이 아니다.
       검증이 없으면 `points=999999999` 가 그대로 기록되어 총점이 9 자리로 치솟고,
       `points=-500` 은 총점을 끌어내린다 —— 둘 다 납품 보고서의 숫자를 무의미하게 만든다.
       상한은 "해당 규칙 상한"과 "기본 점수의 100 배" 중 큰 쪽을 취한다:
       전자는 히트 한 건이 단독으로 규칙 전체의 천장을 뚫을 수 없게 보장하고,
       후자는 기본 점수가 아주 작은 항목(예: 5 점/대 터미널)에 합리적인 단계 여유를 남긴다. */
    const pointMeta = db.prepare('SELECT points, cap FROM score_point WHERE id = ?').get(pointId) || {}
    const pointsMax = Math.max(Number(pointMeta.cap) || 0, (Number(pointMeta.points) || 0) * 100, 1000)
    let hitPoints = null
    if (hit.points !== undefined && hit.points !== null && hit.points !== '') {
      const n = Number(hit.points)
      if (!Number.isFinite(n)) {
        throw new Error("score hit points invalid: points must be a finite number (got " + JSON.stringify(hit.points) + ')')
      }
      if (n <= 0) {
        throw new Error("score hit points invalid: points must be greater than 0 (got " + n
          + "). Fill in the value from the tier table of the red-team scoring rules; do not use it to tune scores.")
      }
      if (n > pointsMax) {
        throw new Error('score hit points invalid: points=' + n + " exceeds the reasonable cap for this score point " + pointsMax
          + " (= max(rule cap " + (Number(pointMeta.cap) || 0) + ", default value " + (Number(pointMeta.points) || 0)
          + " × 100)). Fill in a tier value from the rules, or fix the score point's value setting.")
      }
      hitPoints = n
    }
    /* G5 / G6 배율: 데이터 규모 2 배, IPv6 ×3. 권한 점수에 적용되며, 상한과 함께 cap 에 제약된다. */
    const mult = scoreMultiplierOf(hit)
    const r = db.prepare(`INSERT INTO score_hit(point_id, asset_id, vuln_id, step_id, target, evidence, note, self_created, port, recorded_by, recorded_at, points, multiplier)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      pointId, hit.asset_id ?? null, hit.vuln_id ?? null, hit.step_id ?? null,
      hit.target ?? null, evidence, hit.note ?? null, selfCreated, port,
      hit.recorded_by ?? null, nowIso(), hitPoints, mult.multiplier,
    )
    const hitId = Number(r.lastInsertRowid)
    const point = db.prepare('SELECT name, points, code FROM score_point WHERE id = ?').get(pointId)
    const board = this.listScorePoints(id)
    const summary = board.summary
    const allHits = board.items.flatMap((p) => p.hits)
    const row = allHits.find((h) => h.id === hitId)
    /* 서비스 단위 상한: 같은 자산 같은 포트는 점수가 가장 높은 한 건만 계산한다 (계정류 / 데이터베이스 권한) */
    const cappedByService = selfCreated === 0 && row !== undefined && row.capped === true
    const capService = row === undefined ? null : row.service
    const capBy = row === undefined ? null : (row.capped_by || null)
    const capByPoints = row === undefined || row.capped_by_id === null || row.capped_by_id === undefined
      ? null
      : (allHits.find((h) => h.id === row.capped_by_id) || {}).points
    /* 반대로: 이 건이 같은 서비스에서 원래 채점되던 히트를 밀어냈는지 (그래서 총점이 늘지 않는다).
       "이번 삽입 이후에도 누가 여전히 상한에 걸리는지"를 기준으로 삼아, "먼저 다른 중복 히트에 한 번 밀려난 적이 있다"는 간섭을 피한다. */
    const demoted = selfCreated === 0 && row !== undefined && row.capped !== true
      ? allHits.filter((h) => h.capped_by_id === hitId && Number(h.id) < hitId)
      : []
    const warnings = []
    if (selfCreated === 1) {
      warnings.push("Recorded, but **accounts you registered/created yourself do not score** (exercise scoring is for taking over accounts/privileges someone else already had). This hit is kept as a process record only: it does not consume a cap and does not enter the report.")
    }
    /* G5 "대량 데이터 시스템 점수 2 배"에는 규모 근거가 필요하다: 기준선은 **1 억 건 / 10TB**다.
       판별할 수 없을 때는 **경고만 하고 차단하지 않는다** —— 데이터 양은 evidence 가 아니라 보고서 본문에 적히는 경우가 많고,
       억지로 막으면 실제 성과를 문 밖에서 막게 된다; 하지만 반드시 보완을 상기시켜야 한다, 그렇지 않으면 2 배는 근거가 서지 않는다. */
    if (mult.multiplier > 1 && mult.reasons.some((x) => x.indexOf('G5') === 0)) {
      const rows = parseRowCount(evidence)
      if (rows === null) {
        warnings.push("Note: this hit claims the G5 data-scale multiplier, but the evidence does not **show the data volume**."
          + "State the actual scale in evidence (e.g. \"exported 130 million user records\" or \"12TB of training data\"), otherwise the multiplier does not hold up.")
      } else if (rows < SENSITIVE_DATA_MIN_ROWS) {
        warnings.push("Note: this hit claims the G5 multiplier, but the volume in evidence is **" + formatRows(rows) + " rows/records**,"
          + "far below the large-data-system threshold (over 100 million records or 10TB per the document). Verify the data scale; if it really is over 100 million records,"
          + " write it in evidence in a more explicit form (e.g. \"132 million records\").")
      }
    }
    if (cappedByService) {
      const assetIp = row.asset_id === null || row.asset_id === undefined
        ? undefined
        : (db.prepare('SELECT ip FROM asset WHERE id = ?').get(Number(row.asset_id)) || {}).ip
      warnings.push(serviceCapReason(Object.assign({}, row, { code: point ? point.code : '', asset_ip: assetIp }), capByPoints))
      if (capBy) warnings.push("Scored instead: another hit on the same service: " + String(capBy).slice(0, 120))
    } else if (demoted.length > 0) {
      warnings.push("Note: this hit superseded " + demoted.length + " lower-scored older hit(s) on the same service — **only one hit counts per asset+port**, so the total score will not increase (the old hit is no longer counted).")
    }
    return {
      id: hitId, point_id: pointId,
      point: point ? point.name : null,
      /* 단계 점수와 최종 반영 점수를 따로 준다: 배율 덕분에 "50 점이 어떻게 150 점이 되는지" 설명할 수 있다 */
      base_points: hitPoints === null ? (point ? point.points : 0) : hitPoints,
      multiplier: mult.multiplier,
      multiplier_reasons: mult.reasons.length > 0 ? mult.reasons : undefined,
      points: Math.round((hitPoints === null ? (point ? point.points : 0) : hitPoints) * mult.multiplier),
      port: port,
      service: capService,
      /* G5 규모 확인 결과 (G5 로 채점하지 않은 항목은 null): 화면/모델이 "2 배에 근거가 있는지" 한눈에 볼 수 있게 한다 */
      volume: mult.reasons.some((x) => x.indexOf('G5') === 0)
        ? (() => {
            const rows = parseRowCount(evidence)
            return { rows: rows, min_rows: SENSITIVE_DATA_MIN_ROWS, meets_threshold: rows === null ? null : rows >= SENSITIVE_DATA_MIN_ROWS }
          })()
        : null,
      self_created: selfCreated === 1,
      counted: selfCreated === 0 && !cappedByService,
      capped_by_service: cappedByService,
      capped_by: capBy,
      demoted_hits: demoted.map((h) => ({ id: h.id, evidence: h.evidence, points: h.points })),
      warning: warnings.length === 0 ? undefined : warnings.join('\n'),
      summary,
    }
  }

  /** 자산 공략 용이성 평가: 어떤 성과를 기대할 수 있고, 우선순위가 얼마나 높은지. */
  assessAsset(id, a = {}) {
    const db = this.db(id)
    let row
    if (a.asset_id !== undefined && a.asset_id !== null) row = db.prepare('SELECT * FROM asset WHERE id = ?').get(Number(a.asset_id))
    else if (a.ip) row = db.prepare('SELECT * FROM asset WHERE ip = ?').get(String(a.ip))
    if (row === undefined) throw new Error("asset not found (pass asset_id or ip)")
    const priority = ['high', 'medium', 'low'].includes(a.priority) ? a.priority : (row.priority || 'medium')
    const stamp = nowIso()
    db.prepare('UPDATE asset SET priority = ?, potential = ?, assess_reason = ?, assessed_at = ?, assessed_by = ? WHERE id = ?')
      .run(priority, a.potential ?? (row.potential || ''), a.reason ?? (row.assess_reason || ''), stamp, a.assessed_by ?? null, row.id)
    this.#observe(db, 'asset', row.id, 'assess', priority + ' ' + (a.potential || ''), 'active', a.assessed_by ?? null, null)
    return { asset_id: row.id, ip: row.ip, priority, potential: a.potential ?? (row.potential || ''), assessed_at: stamp }
  }

  /* ---------- 자산 테스트 상태 (어떤 테스트를 했는지 / 남은 공격면은 무엇인지) ---------- */

  /**
   * 특정 자산에 대한 테스트 상황을 기록한다.
   * @param id - 표적 id 값.
   * @param t - `{ asset_id?, ip?, status?, test?, surface?, blocked?, updated_by? }`
   *   · test 는 테스트 기록에 **추가**된다 (타임스탬프 포함);
   *   · surface 는 "남은 측정 가능 공격면"을 덮어쓴다;
   *   · blocked=true 이면 차단 카운트 +1.
   */
  updateAssetTest(id, t = {}) {
    const db = this.db(id)
    let row
    if (t.asset_id !== undefined && t.asset_id !== null) {
      row = db.prepare('SELECT * FROM asset WHERE id = ?').get(Number(t.asset_id))
    } else if (t.ip) {
      row = db.prepare('SELECT * FROM asset WHERE ip = ?').get(String(t.ip))
    }
    if (row === undefined) throw new Error("asset not found (pass asset_id or ip)")
    const status = ['untested', 'testing', 'tested', 'blocked', 'abandoned', 'no_surface'].includes(t.status)
      ? t.status
      : (row.test_status || 'untested')
    const stamp = nowIso()
    /* 프롬프트가 역사적으로 이 기록을 notes 라고 불렀고, 모델도 흔히 이 인자 이름을 그대로 베낀다; 두 표기를 모두 받아,
       test_notes 로 통일해 기록한다 (추가 방식), "결론 한 줄을 기록했다"면서 실제로는 아무것도 쓰이지 않은 상황을 피한다. */
    const testText = [t.test, t.notes]
      .filter((x) => typeof x === 'string' && x.trim() !== '')
      .map((x) => x.trim())
      .join('; ')
    let notes = row.test_notes || ''
    if (testText !== '') {
      notes = (notes === '' ? '' : notes.replace(/\n+$/, '') + '\n') + '[' + stamp + '] ' + testText
    }
    const surface = typeof t.surface === 'string' ? t.surface : (row.test_surface || '')
    const blockedCount = (row.blocked_count || 0) + (t.blocked === true ? 1 : 0)
    db.prepare(`UPDATE asset SET test_status = ?, test_notes = ?, test_surface = ?,
        test_updated_at = ?, test_updated_by = ?, blocked_count = ? WHERE id = ?`).run(
      status, notes, surface, stamp, t.updated_by ?? null, blockedCount, row.id,
    )
    if (testText !== '') {
      this.#observe(db, 'asset', row.id, 'test', testText, 'active', t.updated_by ?? null, null)
    }
    if (t.blocked === true) {
      this.#observe(db, 'asset', row.id, 'blocked', "blocked " + blockedCount + " time(s)", 'active', t.updated_by ?? null, null)
    }
    return {
      asset_id: row.id, ip: row.ip, status, blocked_count: blockedCount,
      test_notes: notes, tests: notes, surface, updated_at: stamp,
      hint: blockedCount >= 3
        ? "This asset has been blocked " + blockedCount + " time(s) (over the 3-times rule): set status to abandoned in this call, note the remaining attack surface, then switch targets."
        : undefined,
    }
  }

  /** 테스트 상태 통계 (개요와 필터링용). */
  testStats(id) {
    const db = this.db(id)
    const rows = db.prepare("SELECT COALESCE(test_status, 'untested') AS s, COUNT(*) AS n FROM asset GROUP BY s").all()
    const out = { untested: 0, testing: 0, tested: 0, blocked: 0, abandoned: 0, no_surface: 0 }
    for (const r of rows) out[r.s] = r.n
    return out
  }

  /* ---------- 취약점 / 자격 증명 / 접근 세션 ---------- */

  /** 취약점을 한 건 기록한다; cve 가 있으면 (asset_id, cve, target) 기준으로 멱등 갱신한다. */
  addVuln(id, v = {}) {
    const db = this.db(id)
    const severity = SEVERITIES.includes(v.severity) ? v.severity : 'info'
    const status = VULN_STATUSES.includes(v.status) ? v.status : 'candidate'
    const existing = v.cve
      ? db.prepare("SELECT id FROM vuln WHERE asset_id IS ? AND cve = ? AND COALESCE(target, '') = ?")
        .get(v.asset_id ?? null, v.cve, v.target ?? '')
      : db.prepare("SELECT id FROM vuln WHERE asset_id IS ? AND COALESCE(cve, '') = '' AND title = ? AND COALESCE(target, '') = ?")
        .get(v.asset_id ?? null, v.title ?? '', v.target ?? '')
    if (existing !== undefined) {
      db.prepare(`UPDATE vuln SET
          title = COALESCE(?, title), severity = ?, status = COALESCE(?, status),
          evidence = COALESCE(?, evidence), confidence = COALESCE(?, confidence),
          source = COALESCE(?, source), target = COALESCE(?, target),
          found_by_agent = COALESCE(?, found_by_agent), gained = COALESCE(?, gained),
          agent = COALESCE(?, agent)
        WHERE id = ?`).run(
        v.title ?? null, severity, v.status ?? null, v.evidence ?? null, v.confidence ?? null,
        v.source ?? null, v.target ?? null, v.found_by_agent ?? null, normGained(v.gained),
        v.agent ?? null, existing.id,
      )
      return { id: existing.id, updated: true }
    }
    const result = db.prepare(`INSERT INTO vuln(asset_id, port_id, cve, title, severity, source, confidence, status, evidence, target, gained, found_by_agent, found_at, agent)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      v.asset_id ?? null, v.port_id ?? null, v.cve ?? null, v.title ?? null, severity,
      v.source ?? null, v.confidence ?? null, status, v.evidence ?? null, v.target ?? null,
      normGained(v.gained), v.found_by_agent ?? null, nowIso(), v.agent ?? null,
    )
    const vulnId = Number(result.lastInsertRowid)
    if (v.asset_id !== undefined && v.asset_id !== null) {
      this.#observe(db, 'asset', v.asset_id, 'vuln', [v.cve, v.title].filter(Boolean).join(' '), 'active', v.source ?? null, null)
    }
    return { id: vulnId, updated: false }
  }

  listVulns(id, f = {}) {
    const db = this.db(id)
    const where = []
    const args = []
    if (f.severity) { where.push('v.severity = ?'); args.push(f.severity) }
    if (f.status) { where.push('v.status = ?'); args.push(f.status) }
    if (f.cve) { where.push('v.cve LIKE ?'); args.push(`%${f.cve}%`) }
    if (f.asset_id !== undefined && f.asset_id !== null) { where.push('v.asset_id = ?'); args.push(Number(f.asset_id)) }
    if (f.cidr) { where.push('a.segment_cidr = ?'); args.push(f.cidr) }
    if (f.q) {
      where.push('(v.title LIKE ? OR v.cve LIKE ? OR v.target LIKE ? OR v.evidence LIKE ?)')
      const like = `%${f.q}%`
      args.push(like, like, like, like)
    }
    const clause = where.length ? 'WHERE ' + where.join(' AND ') : ''
    const limit = Math.min(Number(f.limit) || 200, 1000)
    const total = db.prepare(`SELECT COUNT(*) AS n FROM vuln v LEFT JOIN asset a ON a.id = v.asset_id ${clause}`).get(...args).n
    const items = db.prepare(`SELECT v.*, a.ip AS asset_ip, a.segment_cidr
      FROM vuln v LEFT JOIN asset a ON a.id = v.asset_id ${clause}
      ORDER BY CASE v.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END,
               v.id DESC LIMIT ?`).all(...args, limit)
    /* 상세 화면에 원본 요청/응답을 그대로 보여줘야 하므로 여기서 함께 담는다 (요청 본문이 클 수 있어 길이를 제한한다) */
    const eviStmt = db.prepare(`SELECT id, label, method, url, status, request, response, note, captured_by, captured_at
      FROM http_evidence WHERE vuln_id = ? ORDER BY id`)
    const clipped = (t) => (t === null || t === undefined ? null : (String(t).length > 60000 ? String(t).slice(0, 60000) + "\n… (truncated)" : String(t)))
    for (const item of items) {
      item.http_evidence = eviStmt.all(item.id).map((e) => Object.assign({}, e, {
        request: clipped(e.request), response: clipped(e.response),
      }))
    }
    return { total, items }
  }

  updateVuln(id, vulnId, patch = {}) {
    const db = this.db(id)
    const current = db.prepare('SELECT * FROM vuln WHERE id = ?').get(Number(vulnId))
    if (current === undefined) return { updated: false }
    db.prepare(`UPDATE vuln SET status = ?, severity = ?, evidence = COALESCE(?, evidence), confidence = COALESCE(?, confidence),
        gained = COALESCE(?, gained), title = COALESCE(?, title)
      WHERE id = ?`).run(
      VULN_STATUSES.includes(patch.status) ? patch.status : current.status,
      SEVERITIES.includes(patch.severity) ? patch.severity : current.severity,
      patch.evidence ?? null, patch.confidence ?? null, normGained(patch.gained), patch.title ?? null, Number(vulnId),
    )
    return { updated: true, id: Number(vulnId) }
  }

  vulnStats(id) {
    const db = this.db(id)
    const bySeverity = {}
    for (const row of db.prepare('SELECT severity, COUNT(*) AS n FROM vuln GROUP BY severity').all()) bySeverity[row.severity] = row.n
    const byStatus = {}
    for (const row of db.prepare('SELECT status, COUNT(*) AS n FROM vuln GROUP BY status').all()) byStatus[row.status] = row.n
    /* "어떤 권한을 얻었는지"까지 적힌 취약점 수: 결론 줄에 쓴다 */
    const withGained = db.prepare("SELECT COUNT(*) AS n FROM vuln WHERE COALESCE(gained,'') <> ''").get().n
    const withEvidence = db.prepare("SELECT COUNT(*) AS n FROM vuln WHERE COALESCE(evidence,'') <> '' OR id IN (SELECT vuln_id FROM http_evidence WHERE vuln_id IS NOT NULL)").get().n
    /* 대상별로 집계할 때 필요한 그룹 수 (취약점 페이지 기본 뷰): 먼저 "사이트/서비스"로 묶은 뒤 센다 */
    const rawTargets = db.prepare(`SELECT target, (SELECT ip FROM asset WHERE id = vuln.asset_id) AS ip FROM vuln`).all()
    const targetGroups = new Set(rawTargets.map((r) => targetKey(r.target, r.ip))).size
    return {
      total: Object.values(bySeverity).reduce((a, b) => a + b, 0),
      bySeverity, byStatus, withGained, withEvidence, targetGroups,
    }
  }

  /** 자격 증명: 평문은 secret_value 에 쓴다 (패널이 그대로 표시), 동시에 secret_ref 로 증거 파일을 가리킨다. */
  addCredential(id, c = {}) {
    const db = this.db(id)
    if (!c.host) throw new Error('credential.host required')
    /* 평문 자격 증명: secret_value 를 기준으로 하고, secret / password / value 등 별칭과 호환한다 */
    const value = c.secret_value ?? c.secret ?? c.password ?? c.value ?? null
    db.prepare(`INSERT INTO credential(asset_id, host, username, secret_type, secret_value, secret_ref, privilege, source, tool, note, found_by_agent, found_at, agent)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(host, username, secret_type) DO UPDATE SET
        secret_value = COALESCE(excluded.secret_value, credential.secret_value),
        secret_ref = COALESCE(excluded.secret_ref, credential.secret_ref),
        privilege = COALESCE(excluded.privilege, credential.privilege),
        note = COALESCE(excluded.note, credential.note),
        agent = COALESCE(excluded.agent, credential.agent),
        found_at = excluded.found_at`).run(
      c.asset_id ?? null, c.host, c.username ?? '', c.secret_type ?? 'password',
      value === null || value === undefined ? null : String(value),
      c.secret_ref ?? null, c.privilege ?? null, c.source ?? null, c.tool ?? null,
      c.note ?? null, c.found_by_agent ?? null, nowIso(), c.agent ?? null,
    )
    const row = db.prepare('SELECT id FROM credential WHERE host = ? AND username = ? AND secret_type = ?')
      .get(c.host, c.username ?? '', c.secret_type ?? 'password')
    return { id: row.id }
  }

  listCredentials(id, f = {}) {
    const db = this.db(id)
    const where = []
    const args = []
    if (f.host) { where.push('host = ?'); args.push(f.host) }
    if (f.username) { where.push('username = ?'); args.push(f.username) }
    if (f.withValue === true) where.push("COALESCE(secret_value,'') <> ''")
    const clause = where.length ? 'WHERE ' + where.join(' AND ') : ''
    const limit = Math.min(Number(f.limit) || 200, 1000)
    return db.prepare(`SELECT * FROM credential ${clause} ORDER BY id DESC LIMIT ?`).all(...args, limit)
  }

  /** 접근 세션: 통제 가능한 한 번의 접근 (횡적 이동의 출발점). */
  addAccess(id, a = {}) {
    const db = this.db(id)
    if (!a.host) throw new Error('access.host required')
    const result = db.prepare(`INSERT INTO access_session(asset_id, host, username, method, privilege, session_ref, note, found_by_agent, obtained_at)
      VALUES(?,?,?,?,?,?,?,?,?)`).run(
      a.asset_id ?? null, a.host, a.username ?? null, a.method ?? null, a.privilege ?? null,
      a.session_ref ?? null, a.note ?? null, a.found_by_agent ?? null, nowIso(),
    )
    if (a.asset_id !== undefined && a.asset_id !== null) {
      this.#observe(db, 'asset', a.asset_id, 'access', [a.method, a.username, a.privilege].filter(Boolean).join(' '), 'active', 'exploit', null)
    }
    return { id: Number(result.lastInsertRowid) }
  }

  listAccess(id, f = {}) {
    const db = this.db(id)
    const where = []
    const args = []
    if (f.host) { where.push('host = ?'); args.push(f.host) }
    const clause = where.length ? 'WHERE ' + where.join(' AND ') : ''
    const limit = Math.min(Number(f.limit) || 200, 1000)
    return db.prepare(`SELECT * FROM access_session ${clause} ORDER BY id DESC LIMIT ?`).all(...args, limit)
  }

  /* ---------- WebShell 과 터널: 공격 과정에서 언제든 재사용할 수 있는 자산 ---------- */

  /**
   * 이미 올라간 WebShell 을 등록한다. 같은 url+pass_key 는 같은 건으로 보며, 중복 등록하면 갱신된다.
   * @param w - `{ url, shell_type, pass_key, secret_ref, privilege, status, note, asset_id, found_by_agent }`
   */
  addWebshell(id, w = {}) {
    const db = this.db(id)
    if (!w.url) throw new Error('webshell.url required')
    const ts = nowIso()
    const existing = db.prepare('SELECT id FROM webshell WHERE url = ? AND COALESCE(pass_key, \'\') = COALESCE(?, \'\')')
      .get(w.url, w.pass_key ?? null)
    if (existing !== undefined) {
      db.prepare(`UPDATE webshell SET shell_type = COALESCE(?, shell_type), secret_ref = COALESCE(?, secret_ref),
        privilege = COALESCE(?, privilege), status = COALESCE(?, status), note = COALESCE(?, note),
        asset_id = COALESCE(?, asset_id), agent = COALESCE(?, agent), updated_at = ? WHERE id = ?`)
        .run(normalizeShellType(w.shell_type), w.secret_ref ?? null, w.privilege ?? null, normalizeShellStatus(w.status),
          w.note ?? null, w.asset_id ?? null, w.agent ?? null, ts, existing.id)
      return { id: Number(existing.id), updated: true }
    }
    const result = db.prepare(`INSERT INTO webshell(asset_id, url, shell_type, pass_key, secret_ref, privilege,
      status, note, found_by_agent, created_at, updated_at, agent) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(w.asset_id ?? null, w.url, normalizeShellType(w.shell_type), w.pass_key ?? null, w.secret_ref ?? null,
        w.privilege ?? null, normalizeShellStatus(w.status), w.note ?? null, w.found_by_agent ?? null, ts, ts, w.agent ?? null)
    if (w.asset_id !== undefined && w.asset_id !== null) {
      this.#observe(db, 'asset', w.asset_id, 'webshell', w.url, 'active', 'exploit', null)
    }
    return { id: Number(result.lastInsertRowid), updated: false }
  }

  listWebshells(id, f = {}) {
    const db = this.db(id)
    const where = []
    const args = []
    if (f.status) { where.push('status = ?'); args.push(f.status) }
    if (f.asset_id) { where.push('asset_id = ?'); args.push(f.asset_id) }
    const clause = where.length ? 'WHERE ' + where.join(' AND ') : ''
    const limit = Math.min(Number(f.limit) || 200, 1000)
    return db.prepare(`SELECT w.*, a.ip AS asset_ip FROM webshell w
      LEFT JOIN asset a ON a.id = w.asset_id ${clause} ORDER BY w.id DESC LIMIT ?`).all(...args, limit)
  }

  updateWebshell(id, wsId, patch = {}) {
    const db = this.db(id)
    const fields = ['status', 'check_note', 'latency_ms', 'last_check', 'privilege', 'note', 'secret_ref', 'shell_type']
    const sets = []
    const args = []
    /* update 경로와 추가 경로가 같은 정규화를 쓴다: 예전에는 여기에 아무 문자열이나 쓸 수 있어,
       패널의 "Behinder 셸이 아닌 사용자는 접속 불가" 빨간 표시가 이 때문에 조용히 무효화되었다. */
    for (const key of fields) {
      if (patch[key] === undefined) continue
      let value = patch[key]
      if (key === 'shell_type') value = normalizeShellType(value)
      if (key === 'status') value = normalizeShellStatus(value)
      sets.push(`${key} = ?`); args.push(value)
    }
    if (sets.length === 0) throw new Error('nothing to update')
    sets.push('updated_at = ?'); args.push(nowIso())
    const result = db.prepare(`UPDATE webshell SET ${sets.join(', ')} WHERE id = ?`).run(...args, wsId)
    if (result.changes === 0) throw new Error('webshell not found')
    return { updated: true }
  }

  /**
   * 내부 네트워크 터널을 한 건 등록한다 (suo5 / socks5 / ssh -R / frp …).
   *
   * **판정 규칙**: 표적 경계를 넘은 것(채널 한쪽 끝이 대상 측에 있는 것)만 돌파 근거로 인정한다:
   *   · target-outbound 대상이 먼저 밖으로 연결 (리버스 shell 이 내 서버로 떨어짐 / 대상에서 frp 클라이언트 실행)
   *   · target-http     대상의 WebShell/HTTP 채널 경유 (suo5 / Neo-ReGeorg)
   *   · target-agent    대상에서 이미 장악한 프로세스/세션을 통한 포워딩 (SSH -R 을 대상이 시작)
   *   · self-only       내 VPS/자체 서버에만 연 프록시나 서버 측 —— **돌파로 치지 않는다**
   * 자기 서버에 socks5 만 여는 것은 내부 네트워크 침투가 아니다, "대상 측의 그 한쪽 끝이 무엇인지"를 반드시 밝혀야 한다.
   */
  addTunnel(id, t = {}) {
    const db = this.db(id)
    const ts = nowIso()
    /* entry_kind 는 **경계 돌파 득점의 근거 필드**다: 잘못 쓰면 반드시 오류를 내야 하고, 조용히 0 으로 만들면 안 된다.
       인식할 수 없는 값을 NULL 로 쓰면 legit=null 이 되어 화면에 "확인 대기"로 표시된다 —— "입력 안 함"과 구분할 수 없고,
       모델이 공백을 하나 더 찍은 것(`target-http `)만으로 이 상태에 빠지는데, 사후에 원인을 전혀 찾을 수 없다. */
    const rawEntryKind = t.entry_kind === undefined || t.entry_kind === null ? '' : String(t.entry_kind).trim()
    if (rawEntryKind !== '' && TUNNEL_ENTRY_KINDS[rawEntryKind] === undefined) {
      throw new Error("entry_kind invalid: " + JSON.stringify(t.entry_kind) + ". Valid values are "
        + Object.keys(TUNNEL_ENTRY_KINDS).join(' / ') + ' (' + Object.values(TUNNEL_ENTRY_KINDS).join(' / ') + ').'
        + "Leaving it empty is treated as \"pending confirmation\" and does not count toward a boundary breach.")
    }
    const result = db.prepare(`INSERT INTO tunnel(asset_id, webshell_id, kind, listen, entry, reach, entry_kind,
      status, pid, command, note, found_by_agent, created_at, updated_at, agent) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(t.asset_id ?? null, t.webshell_id ?? null, t.kind ?? 'socks5', t.listen ?? null, t.entry ?? null,
        t.reach ?? null, rawEntryKind === '' ? null : rawEntryKind, t.status ?? 'active', t.pid ?? null, t.command ?? null, t.note ?? null,
        t.found_by_agent ?? null, ts, ts, t.agent ?? null)
    if (t.asset_id !== undefined && t.asset_id !== null) {
      this.#observe(db, 'asset', t.asset_id, 'tunnel', `${t.kind || 'socks5'} ${t.listen || ''}`.trim(), 'active', 'exploit', null)
    }
    const entryKind = rawEntryKind === '' ? null : rawEntryKind
    const legit = tunnelIsLegit(entryKind)
    return {
      id: Number(result.lastInsertRowid),
      entry_kind: entryKind,
      legit,
      warning: legit === false
        ? "Recorded, but entry_kind=self-only (a channel opened only on your own VPS/self-hosted server) — **this is not a tunnel and does not count as a boundary/internal breach**. It must be a channel initiated from the target side: a target reverse shell to my server, an frp client running on the target, or a suo5/HTTP tunnel built through a target WebShell."
        : (legit === null
            ? "Add an entry_kind explaining what the target-side end is (target-outbound / target-http / target-agent); while undeclared the UI shows \"pending confirmation\" and it does not count as breach evidence."
            : undefined),
    }
  }

  listTunnels(id, f = {}) {
    const db = this.db(id)
    const where = []
    const args = []
    if (f.status) { where.push('t.status = ?'); args.push(f.status) }
    if (f.asset_id) { where.push('t.asset_id = ?'); args.push(f.asset_id) }
    const clause = where.length ? 'WHERE ' + where.join(' AND ') : ''
    const limit = Math.min(Number(f.limit) || 200, 1000)
    return db.prepare(`SELECT t.*, a.ip AS asset_ip, w.url AS webshell_url FROM tunnel t
      LEFT JOIN asset a ON a.id = t.asset_id
      LEFT JOIN webshell w ON w.id = t.webshell_id ${clause} ORDER BY t.id DESC LIMIT ?`).all(...args, limit)
      .map((t) => Object.assign({}, t, { legit: tunnelIsLegit(t.entry_kind), entry_kind_label: TUNNEL_ENTRY_KINDS[t.entry_kind] || null }))
  }

  updateTunnel(id, tId, patch = {}) {
    const db = this.db(id)
    const fields = ['status', 'check_note', 'latency_ms', 'last_check', 'listen', 'reach', 'entry', 'entry_kind', 'pid', 'command', 'note']
    const sets = []
    const args = []
    /* update 경로는 이전에 entry_kind / status 를 **전혀 검증하지 않았다**: 추가 시에는 NULL 로 정규화되는데,
       갱신 시에는 아무 문자열이나 그대로 DB 에 쓸 수 있어 legit 판정이 완전히 우회되었다. 여기서 추가 경로와 맞춘다. */
    const TUNNEL_STATUSES = ['active', 'down', 'closed', 'unknown']
    for (const key of fields) {
      if (patch[key] === undefined) continue
      let value = patch[key]
      if (key === 'entry_kind') {
        const raw = value === null ? '' : String(value).trim()
        if (raw !== '' && TUNNEL_ENTRY_KINDS[raw] === undefined) {
          throw new Error("entry_kind invalid: " + JSON.stringify(value) + ". Valid values are "
            + Object.keys(TUNNEL_ENTRY_KINDS).join(' / ') + '.')
        }
        value = raw === '' ? null : raw
      }
      if (key === 'status') {
        const raw = String(value).trim()
        if (!TUNNEL_STATUSES.includes(raw)) {
          throw new Error("tunnel status invalid: " + JSON.stringify(value) + ". Valid values are " + TUNNEL_STATUSES.join(' / ') + '.')
        }
        value = raw
      }
      sets.push(`${key} = ?`); args.push(value)
    }
    if (sets.length === 0) throw new Error('nothing to update')
    sets.push('updated_at = ?'); args.push(nowIso())
    const result = db.prepare(`UPDATE tunnel SET ${sets.join(', ')} WHERE id = ?`).run(...args, tId)
    if (result.changes === 0) throw new Error('tunnel not found')
    return { updated: true }
  }

  /**
   * 현재 테스트 패널: 측정 중인 자산 + 최근에 손댄 자산 (각자의 확인된 취약점 수/포트 수/엔트리 수 포함).
   * 공격 체인 페이지의 "현재 측정 중" 블록이 이것을 쓰며, 클라이언트가 몇 초마다 폴링해 실시간 갱신을 구현한다.
   */
  activeTests(id, f = {}) {
    const db = this.db(id)
    const limit = Math.min(Number(f.limit) || 8, 50)
    const select = `SELECT a.id, a.ip, a.segment_cidr, COALESCE(a.scope, (${SCOPE_SQL})) AS scope, a.state,
        COALESCE(a.test_status, 'untested') AS test_status, a.test_notes, a.test_surface,
        a.test_updated_at, a.test_updated_by, COALESCE(a.blocked_count, 0) AS blocked_count,
        a.priority, a.potential,
        (SELECT COUNT(*) FROM port p WHERE p.asset_id = a.id AND p.state = 'open') AS open_ports,
        (SELECT COUNT(*) FROM vuln v WHERE v.asset_id = a.id AND v.status IN ('confirmed','exploited')) AS vulns,
        (SELECT COUNT(*) FROM webshell w WHERE w.asset_id = a.id) AS webshells,
        (SELECT COUNT(*) FROM tunnel t WHERE t.asset_id = a.id) AS tunnels`
    const testing = db.prepare(`${select} FROM asset a
      WHERE COALESCE(a.test_status, 'untested') = 'testing'
      ORDER BY a.test_updated_at DESC, a.id DESC LIMIT ?`).all(limit)
    /* 최근 손댄 것: 측정 중인 것은 제외해 두 블록이 겹치지 않게 한다 */
    const recent = db.prepare(`${select} FROM asset a
      WHERE a.test_updated_at IS NOT NULL AND COALESCE(a.test_status, 'untested') <> 'testing'
      ORDER BY a.test_updated_at DESC LIMIT ?`).all(limit)
    /* 대기 큐: 아직 손대지 않은 것, 공략 용이성 + 포트 수로 어느 대수를 먼저 칠지 정렬한다 */
    const queue = db.prepare(`${select} FROM asset a
      WHERE COALESCE(a.test_status, 'untested') = 'untested'
      ORDER BY CASE COALESCE(a.priority, '') WHEN 'high' THEN 0 WHEN 'medium' THEN 1 WHEN 'low' THEN 2 ELSE 3 END,
        (SELECT COUNT(*) FROM port p WHERE p.asset_id = a.id AND p.state = 'open') DESC, a.ip_int
      LIMIT ?`).all(limit)
    const untested = db.prepare(`SELECT COUNT(*) AS n FROM asset a
      WHERE COALESCE(a.test_status, 'untested') = 'untested'`).get().n
    return { testing, recent, queue, stats: this.testStats(id), untested, at: nowIso() }
  }

  /**
   * 한 건의 득점이 "어떻게 나왔는지": 동작 단계 + 이용한 취약점 + 확보한 자격 증명/엔트리를 재현 가능한 체인으로 엮는다.
   *
   * 보고서에서 "계정 비밀번호가 어떻게 나왔고, 터널을 어떻게 세웠는지"를 담당하는 곳이다 —— 단계 누락, 명령 누락, 증거 누락은 모두 명시적으로 표시해야 하고,
   * 사용자가 어떤 성과는 재현할 수 없다는 것을 한눈에 보게 해야 한다, 보기에는 그럴듯하지만 실제로는 납품할 수 없는 보고서를 주는 대신에.
   * @param db - 표적 DB 핸들.
   * @param hit - score_hit 행 (asset_id / vuln_id / step_id / target / recorded_at / point_code 포함).
   * @returns `{ steps, vuln, credentials, accesses, webshells, tunnels, how, complete, gaps }`
   */
  #hitTrace(db, hit, engagementId) {
    const evidenceDir = engagementId ? this.dirOf(engagementId) : null
    const steps = []
    const stepById = new Map()
    const pushStep = (row) => {
      if (row === undefined || row === null) return
      if (stepById.has(row.id)) {
        const existing = stepById.get(row.id)
        if (existing.inferred === true && row.inferred !== true) existing.inferred = false
        return
      }
      const step = {
        id: row.id, seq: row.seq, stage_code: row.stage_code, title: row.title || '',
        detail: row.detail || '', tool: row.tool || '', result: row.result || '',
        agent: row.agent || row.recorded_by || '', recorded_at: row.recorded_at || null,
        vuln_id: row.vuln_id ?? null, asset_id: row.asset_id ?? null, point_id: row.point_id ?? null,
        evidence_ref: row.evidence_ref || '', inferred: row.inferred === true,
      }
      stepById.set(step.id, step)
      steps.push(step)
    }
    const cols = 'id, seq, stage_code, title, detail, tool, agent, result, asset_id, vuln_id, access_id, point_id, evidence_ref, recorded_at'
    /* 귀속 규칙 (정확한 것 우선, 넓은 것 나중):
         ① 명시적으로 연결된 단계 (score_hit.step_id)
         ② 이 취약점의 단계 (vuln_id) —— "이 구멍으로 얻은 점수"라면 이 구멍을 친 동작이 보여야 한다
         ③ 같은 자산 + 같은 득점 항목의 단계 (추정)
       위의 어느 것도 없을 때만 "같은 자산의 모든 단계"로 물러나고 (보고서가 비지 않도록), 추정으로 표시한다.
       step_source 가 이번에 어느 단계를 썼는지 호출자에게 그대로 알려 주고, 화면/보고서는 그에 따라 "참고용"이라고 안내한다. */
    let stepSource = null
    try {
      if (hit.step_id !== null && hit.step_id !== undefined) {
        pushStep(db.prepare(`SELECT ${cols} FROM attack_step WHERE id = ?`).get(hit.step_id))
        if (steps.length > 0) stepSource = 'linked'
      }
      if (hit.vuln_id !== null && hit.vuln_id !== undefined) {
        for (const row of db.prepare(`SELECT ${cols} FROM attack_step WHERE vuln_id = ? ORDER BY seq, id`).all(hit.vuln_id)) pushStep(row)
        if (stepSource === null && steps.length > 0) stepSource = 'vuln'
      }
      if (hit.asset_id !== null && hit.asset_id !== undefined && hit.point_id !== null && hit.point_id !== undefined) {
        for (const row of db.prepare(`SELECT ${cols} FROM attack_step WHERE asset_id = ? AND point_id = ? ORDER BY seq, id`).all(hit.asset_id, hit.point_id)) {
          pushStep(Object.assign({}, row, { inferred: true }))
          if (stepSource === null) stepSource = 'point'
        }
      }
      if (steps.length === 0 && hit.asset_id !== null && hit.asset_id !== undefined) {
        for (const row of db.prepare(`SELECT ${cols} FROM attack_step WHERE asset_id = ? ORDER BY seq, id LIMIT 40`).all(hit.asset_id)) {
          pushStep(Object.assign({}, row, { inferred: true }))
        }
        if (steps.length > 0) stepSource = 'asset'
      }
    } catch { /* 구 DB 에 컬럼이 없으면 "단계 없음"으로 낮추고, 보고서는 재현 불가로 표시한다 */ }
    steps.sort((a, b) => (a.seq === b.seq ? a.id - b.id : (a.seq ?? 0) - (b.seq ?? 0)))

    /* 이 득점이 사용한 취약점 */
    let vuln = null
    if (hit.vuln_id !== null && hit.vuln_id !== undefined) {
      try {
        const v = db.prepare('SELECT id, cve, title, severity, status, target, evidence, gained, source, found_by_agent, found_at FROM vuln WHERE id = ?').get(hit.vuln_id)
        if (v !== undefined) vuln = v
      } catch { vuln = null }
    }
    /* ── 자격 증명 / 세션 / 셸 / 터널: "이번 득점"과 같은 사안일 때만 연결한다 ──────────────
       원래 구현은 asset_id 로만 조회해서, 같은 자산에 등록된 **모든** 자격 증명과 세션이 그 자산의
       모든 득점에 매달렸다. 실측 결과: "터미널 권한 pc-001" 한 건 아래에 "MySQL root(설정 파일 유출)"이 매달렸다 ——
       터미널과는 아무 관계가 없다; 한 자산의 4 건 득점이 같은 자격 증명 묶음을 각자 중복 나열해 보고서가 길고 거짓해졌다.
       판정: **이 건에 target 이 적혀 있을 때**는 target 호스트가 해당 자산(IP / 대표 이름)과 맞아야 한다;
       target 이 없을 때(순수 자산 수준 성과, 예: "터미널 1 대 장악")는 자산 기준 연결이 합리적이다. */
    const targetHost = (() => {
      const t = String(hit.target || '').trim()
      if (t === '') return null
      const url = /^([a-z][a-z0-9+.-]*):\/\/(\[[^\]]+\]|[^/?#\s]+)/i.exec(t)
      let authority = url !== null ? url[2] : (/^([^\s/?#]+)/.exec(t) || [])[1]
      if (!authority) return null
      authority = authority.replace(/^\[|\]$/g, '').replace(/:\d{1,5}$/, '').toLowerCase()
      return authority === '' ? null : authority
    })()
    const asset = (hit.asset_id === null || hit.asset_id === undefined)
      ? undefined
      : (() => { try { return db.prepare('SELECT ip, primary_name, segment_cidr FROM asset WHERE id = ?').get(Number(hit.asset_id)) } catch { return undefined } })()
    const targetMatchesAsset = () => {
      if (targetHost === null) return true                 /* target 이 없음: 자산 기준으로 연결 */
      if (asset === undefined) return false                /* target 은 있는데 자산을 찾을 수 없음: 연결하지 않음 */
      const ip = String(asset.ip || '').toLowerCase()
      const name = String(asset.primary_name || '').toLowerCase()
      const cidr = String(asset.segment_cidr || '').toLowerCase()
      /* ① 대상이 곧 이 자산 (IP 또는 대표 도메인) */
      if (targetHost === ip || targetHost === name) return true
      /* ② 대상이 "단일 호스트로 보이지 않음": 경계 돌파는 target 을 도달 가능한 대역(10.20.30.0/24)으로 적는 일이 많고,
         터미널류는 장비 이름(pc-001)으로 적는다. 이런 항목은 본질적으로 "자산 수준 성과"이며,
         그 항목이 쓰는 터널/셸/자격 증명은 이 입구 자산에 연결된다 —— 연결하지 않으면 "채널을 어떻게 세웠는지"가 사라진다.
         판단 기준: target 에 '/' 가 있거나(대역), 해석된 호스트가 IP/도메인 형태가 아닌 경우. */
      const raw = String(hit.target || '').trim()
      if (raw.includes('/')) return true
      if (cidr !== '' && (targetHost === cidr || cidr.startsWith(targetHost + '/'))) return true
      const looksLikeHost = /^[0-9a-f.:\[\]]+$/i.test(targetHost) || targetHost.includes('.')
      return !looksLikeHost
    }
    const sameAsset = targetMatchesAsset()

    const credentials = []
    const accesses = []
    const webshells = []
    const tunnels = []
    if (sameAsset) {
      try {
        if (hit.asset_id !== null && hit.asset_id !== undefined) {
          credentials.push(...db.prepare(`SELECT id, host, username, secret_value, secret_type, privilege, source, tool, agent, found_at
            FROM credential WHERE asset_id = ? ORDER BY id LIMIT 20`).all(hit.asset_id))
        } else if (targetHost !== null) {
          credentials.push(...db.prepare(`SELECT id, host, username, secret_value, secret_type, privilege, source, tool, agent, found_at
            FROM credential WHERE host LIKE ? ORDER BY id LIMIT 20`).all('%' + targetHost + '%'))
        }
      } catch { /* 무시 */ }
      if (hit.asset_id !== null && hit.asset_id !== undefined) {
        try { accesses.push(...db.prepare('SELECT id, host, username, method, privilege, session_ref, obtained_at FROM access_session WHERE asset_id = ? ORDER BY id LIMIT 20').all(hit.asset_id)) } catch { /* 무시 */ }
        try { webshells.push(...db.prepare('SELECT id, url, shell_type, pass_key, privilege, status, agent FROM webshell WHERE asset_id = ? ORDER BY id LIMIT 20').all(hit.asset_id)) } catch { /* 무시 */ }
        try {
          tunnels.push(...db.prepare('SELECT id, kind, listen, entry, reach, entry_kind, status, command, agent FROM tunnel WHERE asset_id = ? ORDER BY id LIMIT 20').all(hit.asset_id)
            .map((t) => Object.assign({}, t, { legit: tunnelIsLegit(t.entry_kind) })))
        } catch { /* 무시 */ }
      }
    }

    /* 재현 완전성 판정: 한 건의 득점은 최소한 "단계가 있고 + (명령이 있거나 취약점이 있거나 원본 요청이 있어야)" 한다 */
    const hasCommand = steps.some((s) => String(s.tool || '').trim() !== '')
    const gaps = []
    if (steps.length === 0) gaps.push("No attack-step record (`redteam_chain_add`): cannot explain how this action was performed")
    else if (!hasCommand) gaps.push("The attack step has no `tool` (the actual command): a replay cannot tell what was run")
    if (hit.vuln_id === null || hit.vuln_id === undefined) gaps.push("No linked `vuln_id`: the report cannot attach the matching raw request")
    if (credentials.length === 0 && ['web-account-user', 'web-account-admin', 'db-access'].includes(hit.code)) {
      gaps.push("Account-type score without a registered credential (`redteam_credential_add`): cannot explain where the account/password came from")
    }
    if (['boundary', 'internal-pivot'].includes(hit.code) && tunnels.length === 0) {
      gaps.push("Breach-type score without a registered tunnel (`redteam_tunnel_add`): cannot explain how the channel was built")
    }

    /* how 값: "무엇으로 얻었는지"를 한 문장으로 밝힌다, 정보량이 가장 많은 항목을 우선한다 */
    const primary = steps.find((s) => String(s.title || '').trim() !== '') || steps[0]
    let how = ''
    if (hit.vuln_id !== null && hit.vuln_id !== undefined && vuln !== null) {
      how = "Exploited " + (vuln.cve ? vuln.cve + ' ' : '') + (vuln.title || '') + ' (' + (vuln.severity || 'unknown') + ')'
    } else if (primary !== undefined) {
      how = primary.title || ''
    }
    if (primary !== undefined && String(primary.tool || '').trim() !== '') {
      how = (how === '' ? '' : how + '; ') + "command: " + String(primary.tool).trim()
    }
    return {
      engagement_dir: evidenceDir,
      steps, vuln, credentials, accesses, webshells, tunnels,
      how,
      /* 단계가 이 득점에 어떻게 귀속되었는지: linked(명시) > vuln(같은 취약점) > point(같은 자산 같은 득점 항목) > asset(같은 자산 폴백) */
      step_source: stepSource,
      evidence_refs: steps.map((s) => s.evidence_ref).filter(Boolean),
      complete: gaps.length === 0,
      gaps,
    }
  }

  /**
   * 공격 득점 체인 재현 보고서: "점수를 얻은" 성과만 수록해 목록으로 펼친다.
   * 각 항목에는 가능한 한 Yakit Repeater 에 바로 붙여넣을 수 있는 원본 요청을 담는다:
   *   ① 명시적으로 연결된 취약점 (score_hit.vuln_id) → 그 취약점의 http_evidence (가장 정확)
   *   ② 폴백: 같은 자산 + 대상 URL 경로 기준 매칭 (자동 매칭으로 표시)
   *   ③ 둘 다 없음 → 증거 텍스트만 주고 missing_evidence 로 표시
   *
   * 각 항목에는 **"어떻게 얻었는지"**(#hitTrace)가 함께 붙는다: 동작 단계(실제 명령과 출력 포함) + 이용한 취약점 +
   * 확보한 자격 증명 / WebShell / 터널 —— "계정 비밀번호가 어떻게 나왔고, 터널을 어떻게 세웠는지"에 답한다.
   * 단계나 명령이 빠진 항목은 incomplete 로 표시하고, 보고서에 gaps 를 나열한다.
   */
  scoreReport(id, options = {}) {
    const db = this.db(id)
    const meta = readMeta(this.metaPathOf(id)) || {}
    const limit = Math.min(Number(options.limit) || 500, 2000)
    const rows = db.prepare(`SELECT h.*, p.code, p.name AS point_name, p.points AS point_default, p.category,
        p.enabled AS point_enabled, p.rule AS point_rule, p.tier AS point_tier, p.cap AS point_cap,
        p.dedup_scope AS point_dedup, p.src AS point_src, p.description AS point_desc,
        a.ip AS asset_ip, v.title AS vuln_title, v.cve AS vuln_cve, v.gained AS vuln_gained, v.severity AS vuln_severity
      FROM score_hit h
      LEFT JOIN score_point p ON p.id = h.point_id
      LEFT JOIN asset a ON a.id = h.asset_id
      LEFT JOIN vuln v ON v.id = h.vuln_id
      ORDER BY h.recorded_at, h.id LIMIT ?`).all(limit)

    /* 채점 기준: 같은 종류 득점에는 상한이 없고, 히트마다 누적한다 (자체 생성 계정은 위에서 이미 통째로 제외했다) */
    const perPoint = new Map()
    const eviByVuln = db.prepare(`SELECT id, label, method, url, status, request, response, note, captured_at
      FROM http_evidence WHERE vuln_id = ? ORDER BY id`)

    const clip = (t, n) => {
      const s = t === null || t === undefined ? '' : String(t)
      return s.length > n ? s.slice(0, n) + "\n… (truncated; see the evidence file for the full content)" : s
    }

    /* 각 히트가 공격 체인의 어느 단계에 놓이는지 (공격 체인 페이지와 같은 도출 규칙) */
    const scopeOf = new Map()
    if (rows.length > 0) {
      const ids = Array.from(new Set(rows.map((r) => r.asset_id).filter((v) => v !== null && v !== undefined)))
      if (ids.length > 0) {
        const ph = ids.map(() => '?').join(',')
        for (const a of db.prepare(`SELECT id, COALESCE(scope, (${SCOPE_SQL})) AS scope FROM asset WHERE id IN (${ph})`).all(...ids)) {
          scopeOf.set(a.id, a.scope)
        }
      }
    }
    /* 자체 등록/자체 생성 계정은 성과로 치지 않는다: 보고서 본문에서 제외하고, 바닥글에 숫자만 준다 */
    const selfCreatedRows = rows.filter((h) => Number(h.self_created) === 1)
    /* "비활성화"된 득점 항목: 패널은 enabled 인 항목만 누적하므로 (listScorePoints 의 기준), 보고서도 일치해야 한다,
       그렇지 않으면 같은 산출물에 총점이 두 개 생긴다 (예: web-app 비활성화 후 패널 50 점, 보고서 150 점).
       이런 히트는 본문에도 총점에도 들어가지 않지만, 역시 개수만 보고한다 (사용자가 직접 끈 것이지 규칙이 밀어낸 것이 아니다).
       판정 함수는 아래 reportRows 옆에 두어 두 기준이 어긋나지 않게 한다. */
    /* 채점 기준과 규칙 상한: **반드시 listScorePoints 와 같은 것을 써야 한다** (applyScoreCaps + 득점 항목 메타데이터),
       그렇지 않으면 패널은 6340 점, 보고서는 7930 점을 적어 양쪽이 맞지 않는다 —— 산출물이 자기모순인 것이 숫자 높낮이보다 나쁘다.
       밀려났거나 상한을 넘은 히트는 본문에 넣지 않는다 (새로운 성과가 아니다), 바닥글에 개수만 보고한다. */
    /* 채점 평가는 공용 구현을 쓰고, **enabledOnly 를 함께 넘긴다**: 패널은 활성화된 득점 항목만 누적하므로,
       보고서가 enabled 를 보지 않으면 "패널 50 점, 보고서 150 점" 같은 자기모순 산출물이 나온다. */
    const reportMeta = loadScoreMeta(db)
    const reportNames = loadAssetNames(db)
    /* 히트에 points 가 있으면 히트를 기준으로 한다 (병합판에서는 한 항목에 여러 단계가 포함된다).
       배율(G5/G6)은 단계 점수에 곱한다 —— 공용 hitPointsOf 를 조정해 패널/보고서/공격 체인 세 곳의 기준을 일치시킨다. */
    const effPoints = (h) => hitPointsOf(
      { points: h.points, multiplier: h.multiplier, code: h.code },
      new Map([[String(h.code), {
        points: (h.point_default !== undefined && h.point_default !== null
          ? Number(h.point_default) || 0
          : (reportMeta.get(h.code) || {}).points || 0),
      }]]),
    )
    const reportEval = evaluateScoreBoard(db, rows.map((h) => Object.assign({}, h, { points: effPoints(h) })),
      { meta: reportMeta, names: reportNames, enabledOnly: true })
    const capFlagById = reportEval.byId
    const isCappedRow = (h) => {
      const flag = capFlagById.get(h.id)
      return flag !== undefined && flag.capped === true
    }
    const isDisabledRow = (h) => h.point_enabled !== null && h.point_enabled !== undefined
      && Number(h.point_enabled) !== 1
    const reportRows = rows.filter((h) => Number(h.self_created) !== 1 && !isCappedRow(h) && !isDisabledRow(h))
    const serviceCappedRows = rows.filter((h) => Number(h.self_created) !== 1 && isCappedRow(h))

    const items = reportRows.map((h, i) => {
      const seen = perPoint.get(h.point_id) || 0
      perPoint.set(h.point_id, seen + 1)
      const counted = true
      /* 해당 히트의 실제 점수: 히트 자체 값이 우선(병합판은 한 항목에 여러 단계 포함), 없으면 득점 항목 기본값 */
      const hitPoints = effPoints(h)

      /* "어떻게 얻었는지": 동작 단계 + 취약점 + 자격 증명/엔트리 (보고서의 핵심, 이게 빠지면 납품할 수 없다) */
      const trace = this.#hitTrace(db, { ...h, code: h.code }, id)

      /* 원본 요청: 먼저 명시적으로 연결된 취약점에서 가져온다 */
      let requests = h.vuln_id === null || h.vuln_id === undefined ? [] : eviByVuln.all(h.vuln_id).map((e) => ({
        label: e.label || (e.method || '') + ' ' + (e.url || ''), method: e.method, url: e.url, status: e.status,
        request: clip(e.request, 20000), response: clip(e.response, 8000), note: e.note, source: 'linked',
      }))
      /* 폴백: 같은 자산 + 대상 경로를 단계적으로 낮춰 매칭한다 (먼저 두 단계 경로까지 정확히, 그다음 한 단계, 마지막으로 전체 권한 범위) */
      if (requests.length === 0 && h.target) {
        const full = String(h.target).trim()
        const um = /^([a-z][a-z0-9+.-]*:\/\/)([^/?#\s]+)(\/[^?#\s]*)?/i.exec(full)
        const candidates = []
        if (um !== null) {
          const authority = um[2]
          const segs = (um[3] || '').split('/').filter(Boolean)
          if (segs.length >= 2) candidates.push('%' + authority + '/' + segs.slice(0, 2).join('/') + '%')
          if (segs.length >= 1) candidates.push('%' + authority + '/' + segs[0] + '%')
          candidates.push('%' + authority + '%')
          if (segs.length >= 2) candidates.push('%/' + segs.slice(0, 2).join('/') + '%')
        } else {
          const auth = full.split('/')[0].split('?')[0]
          if (auth !== '') candidates.push('%' + auth + '%')
        }
        const SQL = 'SELECT id, label, method, url, status, request, response, note FROM http_evidence WHERE url LIKE ? ORDER BY id LIMIT 3'
        const SQL_ASSET = 'SELECT id, label, method, url, status, request, response, note FROM http_evidence WHERE asset_id = ? AND url LIKE ? ORDER BY id LIMIT 3'
        let rows2 = []
        if (h.asset_id !== null && h.asset_id !== undefined) {
          for (const like of candidates) {
            rows2 = db.prepare(SQL_ASSET).all(h.asset_id, like)
            if (rows2.length > 0) break
          }
        }
        if (rows2.length === 0) {
          for (const like of candidates) {
            rows2 = db.prepare(SQL).all(like)
            if (rows2.length > 0) break
          }
        }
        requests = rows2.map((e) => ({
          label: e.label || (e.method || '') + ' ' + (e.url || ''), method: e.method, url: e.url, status: e.status,
          request: clip(e.request, 20000), response: clip(e.response, 8000), note: e.note, source: 'auto',
        }))
      }
      /* ── 재현 입구: 요청 / 명령 / 판정 기준 ──────────────────────────────────
         사용자 피드백은 "보고서의 득점 항목이 득점 과정을 설명하지 못해 재현하기 어렵다"였다. DB 에는 실제로 재료가 있다:
         공격 단계의 tool 이 흔히 그 curl 이고, target 이 바로 그 요청의 주소다.
         여기서 이것을 세 가지로 정리한다:
           · replay_cmd  —— 터미널에 바로 붙여넣어 실행할 수 있는 명령 (실제 curl 은 그대로 두고, 나머지는 URL 로 합성)
           · replay_http —— Yakit Repeater 에 붙여넣을 수 있는 원본 패킷 (실제 캡처가 있으면 실제 것을, 없으면 합성)
           · confirm     —— 이 항목이 무엇으로 성립하는지, 어떤 자료를 첨부해야 하는지, 어디서 재현하는지
         **합성한 것은 일괄 synthesized 로 표시하고 출처를 밝힌다**, 검수자가 추정을 실증으로 착각하게 두어서는 안 된다. */
      const firstStepTool = (trace.steps.find((x) => String(x.tool || '').trim() !== '') || {}).tool || ''
      const parsedCurl = parseCurl(firstStepTool)
      const replayUrl = (() => {
        if (requests.length > 0 && requests[0].url) return requests[0].url
        if (parsedCurl !== null) return parsedCurl.url
        return h.target || null
      })()
      /* ── 합성의 경계 (매우 중요)─────────────────────────────────────────────
         "이 득점이 실제로 HTTP 상호작용으로 얻어졌을 때"만 HTTP 패킷/curl 명령을 합성한다.
         이 판단을 넣지 않으면 서비스 이름을 HTTP 서비스로 착각해 이런 쓸모없는 결과가 나온다:
           · 대상 10.20.30.40:3306 → `curl -i -s 'http://10.20.30.40:3306/'`
           · 대상 pc-001          → `curl -i -s 'http://pc-001/'`
         차라리 "이 항목은 HTTP 입구가 아니니 아래 동작 템플릿대로 재현하세요"라고 분명히 말하는 편이 낫다. */
      const targetParsed = parseTarget(h.target || '')
      const schemeIsHttp = targetParsed !== null
        && (targetParsed.scheme === 'http' || targetParsed.scheme === 'https')
      /* "이 항목이 HTTP 상호작용이다"라는 세 가지 근거, 하나라도 해당하면 된다 */
      const isHttpEntry = parsedCurl !== null
        || (requests.length > 0 && String(requests[0].request || '').trim() !== '')
        || schemeIsHttp
      const confirm = scoreConfirmOf(h.code)

      /* ── 재현 명령: 먼저 "이 득점이 어떤 자산으로 성립하는지" 보고, 그다음 명령을 고른다 ────────────────────
           · real        —— 공격할 때 실제로 입력했고, 이번 HTTP 상호작용에 해당하는 curl
           · synthesized —— **실제로 확보한 요청** 또는 대상 URL 로 합성한 curl (명령줄 등가 형태)
           · template    —— 해당 득점 항목 자체의 동작 템플릿 (자산이 이미 실행 가능한 명령으로 채워 두었다)
           · from_step   —— 공격 단계에서 가져온 실제 명령 ("이번 단계"의 동작이 아닐 수 있으므로 사실대로 표시한다)
         ⚠️ 순서를 잘못 둘 때의 대가(실측): 경계 돌파 항목은 **터널**로 성립하는데, 같은 자산의 공격 단계에
         "업로드 Behinder 셸"의 curl 을 기억한다; 만약 "단계에 curl 이 있으면 그것을 쓴다"고 먼저 판정하면 보고서는 업로드 명령을
         경계 돌파의 재현 명령으로 써 버린다 —— 전혀 다른 것을 갖다 붙여, 사용자가 그대로 실행해도 "내부 네트워크 진입"은 재현되지 않는다.
         그래서 "자산이 이 득점 항목의 재현 방식을 가리키는지"가 "단계에 명령이 있는지"보다 반드시 앞서야 한다. */
      const capturedRequest = requests.length > 0 ? String(requests[0].request || '').trim() : ''
      const capturedCurl = (() => {
        if (capturedRequest === '') return null
        const firstLine = capturedRequest.split(/\r?\n/)[0]
        const m = /^([A-Z]+)\s+(\S+)/.exec(firstLine)
        const hostLine = /^host:\s*(\S+)/im.exec(capturedRequest)
        if (m === null || hostLine === null) return null
        const scheme = /:443$/.test(hostLine[1]) ? 'https' : 'http'
        /* path 를 따로 빼낸다: parseTarget 은 '?' 에서 잘라내므로, url 만 주면 쿼리 문자열이 사라진다
           (실측에서 `GET /_cat/indices?v` 를 `curl .../_cat/indices` 로 합성했다).
           인증과 콘텐츠 타입 헤더도 마찬가지로 챙겨야 한다 (Basic 이 빠지면 401, POST 가 빠지면 415). */
        const keep = []
        for (const line of capturedRequest.split(/\r?\n/).slice(1)) {
          if (/^(authorization|content-type|accept|x-requested-with|referer):/i.test(line.trim())) keep.push(line.trim())
        }
        return { url: scheme + '://' + hostLine[1] + m[2], method: m[1], path: m[2], headers: keep }
      })()

      const tunnel0 = trace.tunnels[0] || null
      const listenPort = tunnel0 === null || !tunnel0.listen
        ? null
        : (/:([0-9]{1,5})$/.exec(String(tunnel0.listen)) || [])[1] || null
      const reach = tunnel0 === null ? null : String(tunnel0.reach || '').trim()
      const t0 = parseTarget(h.target || '')
      const cred0 = (trace.credentials.find((c) => c.username) || trace.credentials[0]) || {}
      const templateValues = {
        host: (reach === null || reach === '' ? null : reach.replace(/\/[0-9]{1,3}$/, '')) || (t0 === null ? null : t0.host),
        port: listenPort || (t0 === null ? null : t0.port),
        user: cred0.username,
        pass: cred0.secret_value,
        url: h.target || null,
      }

      let replayCmd = null
      let replayCmdKind = null
      let replayCmdUnfilled = []
      const curlIsThisAction = commandKind(firstStepTool) === 'curl'
      /* 이 건의 **명시적으로 연결된** 공격 단계에 기록된 명령: 이것이야말로 "이번 동작에서 실제로 무엇을 입력했는지"다.
         명시적 연결(h.step_id)만 인정하고, 같은 자산에서 추론된 과거 단계는 인정하지 않는다 —— 후자는
         "업로드 Behinder 셸"의 curl 을 "경계 돌파" 항목에 매달아, 보고서가 곧바로 전혀 다른 것을 갖다 붙이게 된다. */
      const linkedStep = (trace.steps || []).find((st) => st.id === h.step_id) || null
      const linkedTool = linkedStep === null ? '' : String(linkedStep.tool || '').trim()
      const looksLikeCommand = (t) => t.length >= 8 && /^[A-Za-z0-9_./~$-]+/.test(t) && /\s/.test(t)

      if (capturedRequest !== '' && capturedCurl !== null) {
        /* ① 실제로 확보한 패킷이 있을 때: 명령줄 등가 형태가 패킷과 엄밀히 대응해 가장 오해가 적다.
            요청 본문은 **이 패킷에서만** 가져오고, 공격 단계의 그 curl 이 가진 data 를 빌려 오면 안 된다 ——
            실측에서 `GET /_cat/indices?v` 를 `curl -d @/tmp/.b.json .../_cat/indices` 로 합성했다. */
        const sep = capturedRequest.search(/\r?\n\r?\n/)
        const body = sep === -1 ? '' : capturedRequest.slice(sep).replace(/^\r?\n\r?\n/, '').trim()
        replayCmd = buildCurlCommand({
          url: capturedCurl.url, path: capturedCurl.path, method: capturedCurl.method,
          headers: capturedCurl.headers,
          data: body === '' ? null : body,
          cookie: parsedCurl === null ? null : parsedCurl.cookie,
        })
        replayCmdKind = 'synthesized'
      } else if (linkedTool !== '' && looksLikeCommand(linkedTool)) {
        /* ①′ 이번 동작의 실제 명령 (impacket / nxc / mysql / redis-cli 같은 비-curl 도구 포함).
             이런 명령은 과거에 버려지고 범용 템플릿으로 물러났다 (템플릿은 "id; whoami; hostname" 같은 판정용 문구다),
             사용자가 그대로 실행해도 아무것도 재현되지 않았다 —— 보고서에서 가장 오해를 부르는 지점이라, 이제 원본 그대로 준다. */
        replayCmd = linkedTool
        replayCmdKind = commandKind(linkedTool) === 'curl' ? 'real' : 'linked'
      } else if (curlIsThisAction && !(tunnel0 !== null && confirm !== null && confirm.script)) {
        /* ② 실제 curl 이면서, 이 득점이 "터널로 성립"한 것이 아닐 때 (터널 항목은 아래 ③ 참고) */
        replayCmd = firstStepTool
        replayCmdKind = 'real'
      } else if (confirm !== null && confirm.script) {
        /* ③ 득점 항목 자체의 동작 템플릿: 이 건에 기록된 대상/터널/자격 증명으로 실행 가능한 명령을 채운다 */
        replayCmdKind = 'template'
        const filled = fillTemplate(confirm.script, templateValues)
        replayCmd = filled.cmd
        replayCmdUnfilled = filled.remaining
      } else if (curlIsThisAction) {
        replayCmd = firstStepTool
        replayCmdKind = 'real'
      } else if (commandKind(firstStepTool) !== null) {
        /* ④ 단계에 있는 다른 실제 명령: "이번 단계"의 동작이 아니라는 점을 사실대로 밝힌다 */
        replayCmd = firstStepTool
        replayCmdKind = 'from_step'
      }

      if (replayCmd === null && confirm && confirm.script) {
        replayCmdKind = 'template'
        /* 이 득점이 이미 알고 있는 정보로 템플릿을 채운다: host 는 target 에서, 계정은 연결된 자격 증명에서 가져온다.
           채울 수 없는 자리표시자는 그대로 두고 함께 나열한다 —— 추측하지 않고, 바로 실행할 수 있는 척도 하지 않는다. */
        const cred0 = (trace.credentials.find((c) => c.username) || trace.credentials[0]) || {}
        const t0 = parseTarget(h.target || '')
        /* 터널 항목: <포트> 는 터널 리스닝 포트(127.0.0.1:1080)를 뜻하며, target 안의 포트가 아니다.
           경계 돌파의 target 은 "도달 가능한 대역"(10.20.30.0/24)이라, 그것으로 포트를 해석하면 null 만 나오고
           채울 수 없는 자리표시자만 남는다 —— 이 득점이 실제로 실행할 명령은 터널 기록에 적혀 있다. */
        const tunnel0 = trace.tunnels[0] || null
        const listenPort = tunnel0 === null || !tunnel0.listen
          ? null
          : (/:([0-9]{1,5})$/.exec(String(tunnel0.listen)) || [])[1] || null
        const reachHost = (() => {
          const reach = tunnel0 === null ? null : String(tunnel0.reach || '').trim()
          if (reach === null || reach === '') return null
          return reach.replace(/\/[0-9]{1,3}$/, '')     /* 10.20.30.0/24 → 10.20.30.0 */
        })()
        const filled = fillTemplate(confirm.script, {
          host: reachHost || (t0 === null ? null : t0.host),
          port: listenPort || (t0 === null ? null : t0.port),
          user: cred0.username,
          pass: cred0.secret_value,
          url: h.target || null,
        })
        replayCmd = filled.cmd
        replayCmdUnfilled = filled.remaining
      }

      /* 원본 패킷: 실제 패킷 캡처를 우선하고; 다음으로 실제 curl 에서 합성하며; 그 외에는 target 에 http(s):// 가 적혀 있을 때만 합성한다 */
      let replayHttp = null
      let replayHttpSynthesized = false
      if (requests.length > 0 && String(requests[0].request || '').trim() !== '') {
        replayHttp = requests[0].request
      } else if (parsedCurl !== null) {
        replayHttp = buildHttpRequest({
          url: parsedCurl.url, method: parsedCurl.method, data: parsedCurl.data,
          headers: parsedCurl.headers, cookie: parsedCurl.cookie,
          insecure: parsedCurl.insecure, followRedirect: parsedCurl.followRedirect,
        })
        replayHttpSynthesized = replayHttp !== null
      } else if (schemeIsHttp) {
        replayHttp = buildHttpRequest({ url: h.target, method: 'GET' })
        replayHttpSynthesized = replayHttp !== null
      }
      return {
        seq: i + 1,
        id: h.id,
        point_id: h.point_id,
        /* 명시적으로 연결된 동작 단계 id 값: 보고서는 이것으로 "같은 배치 동작"의 항목을 한 건으로 합치고 + 대장 표를 만든다.
           반드시 명시적 연결을 써야 하고, trace 에서 추론한 단계는 쓸 수 없다 —— 추론은 같은 자산의 과거 단계까지
           포함시켜, 같은 배치 동작의 항목이 하나로 합쳐지지 않는다 (실측: 64 대 터미널 중 한 대가 이 때문에 빠졌다). */
        step_id: h.step_id === null || h.step_id === undefined ? null : h.step_id,
        /* 득점 항목 규칙 메타데이터 (구역 표와 건별 상세에 "규칙 몇 / 단계 / 상한"을 적어야 한다) */
        point_rule: h.point_rule === null || h.point_rule === undefined ? null : h.point_rule,
        point_tier: h.point_tier || '',
        point_cap: Number(h.point_cap) || 0,
        point_dedup: h.point_dedup || '',
        /* 득점 항목 code 값: 보고서 항목과 공격 체인 항목**은 반드시 같은 code 를 가져야 한다** ——
           화면이 이것으로 양쪽을 맞춘다 (보고서 페이지의 단계 그룹 폴백, 도구 측의 code 기준 성과 대조),
           이게 없으면 하위 단계는 point_name 으로 흐릿하게 매칭할 수밖에 없고, 이름 하나만 바꿔도 끊긴다. */
        code: h.code || '',
        stage_code: scoreStageOf({ stage_code: h.stage_code, code: h.code, target: h.target },
          h.asset_id === null || h.asset_id === undefined ? undefined : scopeOf.get(h.asset_id)),
        point_name: h.point_name || "(deleted score point)",
        category: h.category || '',
        points: hitPoints,
        counted: counted,
        nth_of_point: seen + 1,
        target: h.target || '',
        asset_ip: h.asset_ip || '',
        gained: h.vuln_gained || '',
        vuln: h.vuln_id === null || h.vuln_id === undefined ? null : { id: h.vuln_id, title: h.vuln_title || '', cve: h.vuln_cve || null, severity: h.vuln_severity || null },
        evidence: h.evidence || '',
        note: h.note || '',
        recorded_by: h.recorded_by || '',
        recorded_at: h.recorded_at || '',
        requests: requests,
        missing_evidence: requests.length === 0,
        /* 재현 입구 (신규): 사용자가 이 세 가지를 따라 하면 리플레이/자기 증명이 가능하다 */
        replay_cmd: replayCmd,
        /* real / synthesized / template —— 화면과 보고서가 이것으로 문구를 정한다 (템플릿을 "그대로 베끼면 된다"고 부를 수는 없다) */
        replay_cmd_kind: replayCmdKind,
        /* 템플릿에서 아직 채우지 못한 자리표시자 (빈 배열이면 모두 채워져 바로 실행 가능) */
        replay_cmd_unfilled: replayCmdKind === 'template' && replayCmdUnfilled.length > 0 ? replayCmdUnfilled : undefined,
        /* 증거 스크린샷: 이 건(또는 이 그룹)에 대응하는 대표 이미지, 최대 3 장 —— #representativeShots 참고 */
        shots: [],
        replay_http: replayHttp,
        replay_http_synthesized: replayHttpSynthesized,
        /* 이 패킷이 당일 실제 패킷 캡처인지, 아니면 당일 명령/응답 출력으로 재구성한 것인지 (증거 행의 note 에 적혀 있으면 그것을 따른다) */
        replay_http_rebuilt: requests.length > 0 && /(\u91cd\u5efa|재구성)|(\u6309\u5f53\u65e5|당일).*(\u547d\u4ee4|명령|\u56de\u663e|응답 출력)|(\u672a\u7559\u5b58\u539f\u59cb\u6293\u5305|원본 패킷 미보관)/.test(String(requests[0].note || '')),
        /* 이 득점이 "HTTP 상호작용"으로 얻어진 것인지. 보고서는 이것으로 붙여넣기 가능한 패킷을 줄지 정한다:
           비 HTTP 대상(SMB/데이터베이스/터널)을 억지로 합성한 패킷은 쓸모없다, 차라리 명령줄 + 설명을 직접 주는 편이 낫다. */
        http_entry: isHttpEntry,
        /* 이 재현 입구가 어디서 왔는지:
             linked       —— 명시적으로 연결된 취약점의 실제 패킷 캡처
             auto         —— 대상 경로로 매칭된 실제 패킷 캡처 (확인 필요)
             request      —— 실제 패킷 캡처에서 도출한 명령줄 등가 형태
             step         —— 공격 단계에서 가져온 실제 명령 (이번 단계의 동작이 아닐 수 있다)
             synthesized  —— 전적으로 대상 URL 로 합성 (확인 필요)
             template     —— 득점 항목 자체의 동작 템플릿 (이 건에 기록된 값으로 채웠다) */
        replay_source: requests.length > 0
          ? (capturedRequest !== '' ? (requests[0].source === 'linked' ? 'linked' : 'auto')
            : (replayCmdKind === 'from_step' ? 'step' : 'request'))
          : (replayCmdKind === 'from_step' ? 'step'
            : (replayCmdKind === 'template' ? 'template' : (replayCmd !== null || replayHttp !== null ? 'synthesized' : null))),
        /* 판정 기준 / 자기 증명 자료 / 재현 입구 (SCORE_CONFIRM 에서, code 로 조회) */
        confirm: confirm,
        confirm_missing: confirm === null,
        /* 어떻게 얻었는지: 단계(명령과 응답 출력 포함) + 취약점 + 자격 증명/엔트리; incomplete 는 보고서가 이 단계를 재현할 수 없다는 뜻 */
        trace: trace,
        how: trace.how,
        steps: trace.steps,
        credentials: trace.credentials,
        accesses: trace.accesses,
        webshells: trace.webshells,
        tunnels: trace.tunnels,
        incomplete: trace.complete !== true,
        gaps: trace.gaps,
      }
    })

    const summary = {
      count: items.length,
      points: items.reduce((n, x) => n + (x.counted ? x.points : 0), 0),
      withRequests: items.filter((x) => x.requests.length > 0).length,
      autoMatched: items.filter((x) => x.requests.some((r) => r.source === 'auto')).length,
      missingRequests: items.filter((x) => x.missing_evidence).length,
      /* 재현 완전성: 단계와 명령이 모두 있는 항목 수 / 단계나 명령이 빠진 항목 수 */
      withSteps: items.filter((x) => x.steps.length > 0).length,
      withCommands: items.filter((x) => x.steps.some((s) => String(s.tool || '').trim() !== '')).length,
      incomplete: items.filter((x) => x.incomplete).length,
      credentials: items.reduce((n, x) => n + x.credentials.length, 0),
      tunnels: items.reduce((n, x) => n + x.tunnels.length, 0),
      /* 자체 등록/자체 생성 계정의 히트: 성과로 치지 않고, 보고서에 쓰지 않는다 */
      selfCreatedExcluded: selfCreatedRows.length,
      /* 같은 자산 같은 포트에서 중복된 계정/데이터베이스 권한 히트: 서비스가 이미 상한에 도달해, 중복은 새 성과가 아니다 */
      serviceCappedExcluded: serviceCappedRows.length,
      /* 소속 득점 항목이 사용자에 의해 "비활성화"된 히트: 패널 기준과 일치하게 제외한다 (그렇지 않으면 양쪽 총점이 맞지 않는다) */
      disabledExcluded: rows.filter((h) => Number(h.self_created) !== 1 && isDisabledRow(h)).length,
      serviceCapped: serviceCappedRows.map((h) => ({
        id: h.id, point_name: h.point_name || h.code, code: h.code,
        service: serviceLabel(h), evidence: h.evidence || '', target: h.target || '',
        points: h.points || 0, recorded_at: h.recorded_at || '',
      })),
    }
    /* ── 항목 병합: 같은 득점 항목 + 같은 동작(같은 배치 공격 단계), 대상만 다른 항목 ──────
       전형적인 상황: 한 번의 배치 동작으로 터미널 60 대를 장악했다. 대수마다 한 건씩 쓰면 보고서가 일지처럼 늘어나고 (실측 전체 분량의 64%),
       독자는 오히려 "이 단계가 대체 어떻게 이루어진 것인지"를 찾지 못한다. 한 건으로 합치고 + 대상 대장 표를 두며,
       재현 입구는 한 번만 쓰고, 대수는 표로 쌓는다. */
    const GROUP_MIN = Math.max(2, Number(options.groupMin) || 5)
    const stepKeyOf = (x) => (x.step_id === null || x.step_id === undefined ? '' : String(x.step_id))
    const items2 = (() => {
      const buckets = new Map()
      for (const x of items) {
        const k = x.point_id + '|' + stepKeyOf(x)
        if (!buckets.has(k)) buckets.set(k, [])
        buckets.get(k).push(x)
      }
      const out = []
      const done = new Set()
      for (const x of items) {
        if (done.has(x.id)) continue
        const k = x.point_id + '|' + stepKeyOf(x)
        const members = buckets.get(k) || [x]
        done.add(x.id)
        if (members.length < GROUP_MIN || stepKeyOf(x) === '') { out.push(x); continue }
        for (const m of members) done.add(m.id)
        /* 대표 항목 = 증거 텍스트가 가장 많이 등장한 항목(최빈값)이며, 시간이 가장 이른 항목이 아니다:
           같은 배치 동작 안에서 일부 대상은 다른 방식으로 공략했을 수 있다 (실측에서 터미널 64 대 중 첫 대는 도메인 관리자 계정을 썼다),
           그것을 그룹 전체 설명으로 삼으면 예외를 일반례로 써 버린다. */
        /* 증거 텍스트가 대수마다 달라서(각자의 IP/호스트 이름이 적혀 있다), 먼저 "숫자 정규화"를 한 뒤 최빈값을 취한다:
           터미널 64 대의 GPO 방식은 정규화하면 같은 문장이 되고, 첫 대의 "도메인 관리자 계정 사용" 예외는 그렇지 않다 ——
           이렇게 하면 대표 항목이 다수파에 떨어진다. */
        const freq = new Map()
        const norm = (t) => String(t || '').replace(/[0-9]/g, '#')
        for (const m of members) {
          const k = norm(m.evidence)
          freq.set(k, (freq.get(k) || 0) + 1)
        }
        const rep = members.slice().sort((a, b) => (freq.get(norm(b.evidence)) || 0) - (freq.get(norm(a.evidence)) || 0)
          || String(a.recorded_at || '').localeCompare(String(b.recorded_at || '')))[0] || x
        out.push(Object.assign({}, rep, {
          is_group: true,
          group_size: members.length,
          /* 병합 항목이 체인 안에서 차지하는 위치는 "가장 이른 대수"로 계산한다: 배치 동작은 첫 대가 성공한 시점부터 발생한 것으로 본다,
             대표 항목의 시간을 쓰면 그룹 전체가 체인 안에서 흔들린다 (실측에서 터미널 그룹이 #12 와 #15 사이를 오갔다) */
          order_at: members.map((m) => String(m.recorded_at || '')).sort()[0] || rep.recorded_at,
          points: members.reduce((n, m) => n + m.points, 0),
          group_targets: members.map((m) => ({
            id: m.id, target: m.target, points: m.points, evidence: m.evidence, recorded_at: m.recorded_at,
          })),
        }))
      }
      return out
    })()

    /* ── 증거 스크린샷: "득점 항목" 단위로 대표 이미지를 고르고 (최대 3 장), 그룹 항목은 전체 구성원의 히트를 모아 함께 찾는다 ──
       납품할 때 가장 설득력 있는 것은 그때 찍은 그 이미지다; 하지만 배치 득점 항목에는 히트가 수십 건이라,
       건마다 이미지를 붙이면 본문만 뒤덮이므로 항목 단위로 대표 이미지를 고른다. */
    /* ⚠️ 대표 이미지는 **득점 항목** 기준으로 고르고, 항목 기준이 아니다: 한 득점 항목에 도메인 컨트롤러가 6 대면 항목도 6 건이고,
       항목마다 3 장씩 고르면 같은 3 장이 본문에 6 번 반복된다 (실측에서 본문 22 건에 이미지 58 장이 붙었다).
       규칙: 득점 항목마다 합쳐서 ≤3 장; 항목은 "이번 히트에 속한" 이미지만 표시하고,
       항목 수준 이미지(히트에 연결되지 않은 것)는 해당 득점 항목의 첫 항목에 붙인다. */
    const pointHitIds = new Map()
    for (const x of items2) {
      if (!pointHitIds.has(Number(x.point_id))) pointHitIds.set(Number(x.point_id), [])
      const list = pointHitIds.get(Number(x.point_id))
      for (const hid of (x.is_group ? (x.group_targets || []).map((g) => g.id) : [x.id])) {
        if (list.indexOf(hid) === -1) list.push(hid)
      }
    }
    const shotPicks = this.#representativeShots(id, Array.from(pointHitIds.entries()).map(([pid, ids]) => ({
      point_id: pid, hit_ids: ids,
    })), 3)
    const shotBriefOf = (sh) => ({
      id: Number(sh.id), url: this.shotUrlOf(id, sh), label: sh.label || '', note: sh.note || '',
      kind: sh.kind || 'screenshot', mime: sh.mime || 'image/png', bytes: Number(sh.bytes) || 0,
      width: sh.width === null || sh.width === undefined ? null : Number(sh.width),
      height: sh.height === null || sh.height === undefined ? null : Number(sh.height),
      target: sh.target || '', captured_at: sh.captured_at || '', source_ref: sh.source_ref || '',
    })
    const shotTotalByPoint = new Map()
    try {
      for (const row of db.prepare('SELECT point_id, COUNT(*) AS n FROM shot GROUP BY point_id').all()) {
        if (row.point_id !== null && row.point_id !== undefined) shotTotalByPoint.set(Number(row.point_id), Number(row.n))
      }
    } catch { /* 구 DB 에 shot 테이블이 없으면 무시 */ }
    const seenPoint = new Set()
    for (const x of items2) {
      const pid = Number(x.point_id)
      const list = shotPicks.get(pid) || []
      const mine = new Set(x.is_group ? (x.group_targets || []).map((g) => g.id) : [x.id])
      const own = list.filter((sh) => sh.hit_id !== null && sh.hit_id !== undefined && mine.has(Number(sh.hit_id)))
      const pointLevel = list.filter((sh) => sh.hit_id === null || sh.hit_id === undefined)
      const isFirst = !seenPoint.has(pid)
      seenPoint.add(pid)
      x.shots = own.concat(isFirst ? pointLevel : []).map(shotBriefOf)
      x.shot_total = shotTotalByPoint.get(pid) || x.shots.length
    }
    /* 보고서 안의 이미지 경로: 기본은 **절대 경로**를 준다 (어디에 내려받아도 표시된다);
       납품 패키지를 만들 때는 options.shotRef='relative' 로 markdown 이 `shots/xxx.png` 를 쓰게 하고,
       표적 디렉터리의 shots/ 와 함께 복사해 가면 된다. */
    const shotRefOf = (sh) => (options.shotRef === 'relative'
      ? sh.url
      : join(this.shotsDirOf(id), String(sh.url).replace(/^shots\//, '')))

    /* ── 체인 정렬: 단계 순서 (정보 수집 → 인터넷 → 경계 → 내부 네트워크 → 표적) + 단계 내에서는 동작 선후 ──
       ⚠️ ordinal 은 **체인 안의 실제 위치**이며, "필터링 후 몇 번째"가 아니다: `listStages` 의 주석에
       "화면이 ①②③ 을 그릴 때와 보고서 정렬에 모두 이것을 쓰며, 따로 번호를 매기지 말 것"이라고 적혀 있다. 먼저 번호를 매기고 빈 단계를 걸러 내면,
       3단계의 "경계 돌파"가 ② 로 표시된다 —— 공격 체인 페이지, 보고서 페이지, 내보낸 markdown 도 함께 틀어지고,
       체인 그림과 보고서 본문이 어긋나면 결과물을 신뢰할 수 없게 된다. */
    const stageRows = this.listStages(id)
    const stageOrder = new Map(stageRows.map((s, i) => [s.code, i]))
    const stageOfItem = (x) => (x.stage_code && stageOrder.has(x.stage_code) ? x.stage_code : 'internet')
    const stepSeqOf = (x) => {
      const seqs = (x.steps || []).map((s) => Number(s.seq)).filter((n) => Number.isFinite(n))
      return seqs.length > 0 ? Math.min.apply(null, seqs) : Number.MAX_SAFE_INTEGER
    }
    const ordered = items2.slice().sort((a, b) => {
      const sa = stageOrder.has(stageOfItem(a)) ? stageOrder.get(stageOfItem(a)) : 99
      const sb = stageOrder.has(stageOfItem(b)) ? stageOrder.get(stageOfItem(b)) : 99
      if (sa !== sb) return sa - sb
      const ra = String(a.order_at || a.recorded_at || '')
      const rb = String(b.order_at || b.recorded_at || '')
      if (ra !== rb) return ra.localeCompare(rb)
      return stepSeqOf(a) - stepSeqOf(b)
    })
    ordered.forEach((x, i) => { x.chain_no = i + 1 })

    /* ── 선행 도출: 이 성과는 어떤 성과 위에 세워진 것인가 ──────────────────────────────
       **라이브러리에 이미 있는 텍스트**만으로 추론한다: 이 항목의 단계(명령/설명/응답 출력), 자격 증명(출처/획득 방식/비고)
       와 증거 텍스트를 한 덩어리 말뭉치로 합쳐, 그 안에 다른 득점 성과의 대상 IP 가 나오는지 본다 —— 나오면 곧
       "이 항목은 저 항목의 어깨 위에서 이루어졌다"는 뜻이다(예: 도메인 컨트롤러 자격 증명이 ES 대화 기록에서 나옴 → 도메인 컨트롤러 항목의 선행 = ES 항목).
       추론되지 않으면 쓰지 않고, 의존 관계를 지어내지 않는다. */
    const ipOfTarget = (t) => {
      const m = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/.exec(String(t || ''))
      return m === null || m[1] === '127.0.0.1' ? null : m[1]
    }
    const ipsIn = (t) => {
      const out = []
      const re = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/g
      let m
      while ((m = re.exec(String(t || ''))) !== null) if (m[1] !== '127.0.0.1') out.push(m[1])
      return out
    }
    /* 이 항목이 사용한 자격 증명: "증거에 나오는 비밀번호/계정/호스트"로 자격 증명 라이브러리의 기록을 찾아 연결한다. */
    const credsAllForDeps = this.listCredentials(id)
    const ownsCred = (x, c) => {
      /* ⚠️ 판정에는 "이 항목 증거 자체가 적어 낸 것"만 쓸 수 있고, trace 가 붙여 준 자격 증명은 **넣으면 안 된다**:
         trace 는 "동일 자산/동일 호스트"의 느슨한 매칭이다(대상 10.1.2.142 에는 모든 host 중 그 주소가 들어간 자격 증명이 붙는다),
         그것을 근거로 삼으면 "MySQL 항목이 도메인 컨트롤러에 의존한다"는 결론이 나온다. */
      const text = [x.evidence, x.note, x.gained, x.target].join('\n')
      const sv = String(c.secret_value || '').trim()
      if (sv.length >= 6 && text.indexOf(sv) !== -1) return true
      const un = String(c.username || '').trim()
      /* 계정은 "계정처럼" 생겨야 특징 문자열로 인정한다: 순수 영단어는 충돌한다 —— 실측에서 경계 항목의 증거에
         `default via 10.1.2.1` 이 적혀 있어, 사용자 이름이 default 인 Redis 자격 증명을 이 항목의 출처로 잘못 인정했고,
         "경계 돌파가 Redis 에 의존한다"는 결과가 나왔다. 숫자/역슬래시/@ 가 들어간 것(사번, 도메인 계정)만 인정한다. */
      const accountLike = (v) => /[\d\\@]/.test(v) || v.length >= 10
      if (un.length >= 6 && accountLike(un) && text.indexOf(un) !== -1) {
        /* 계정은 공용이다(도메인 관리자 계정 하나가 수십 개 증거에 등장한다), 그래서 호스트도 맞아야 한다:
           자격 증명의 호스트가 이 항목의 대상이거나, 자격 증명 호스트 문자열이 이 항목 증거에 등장한 경우다. */
        const cip = ipOfTarget(c.host)
        if (cip === null) return true
        return cip === ipOfTarget(x.target) || text.indexOf(cip) !== -1
      }
      /* "자격 증명 host 가 증거에 등장"하는 방식으로 연결하지 않는다: 대상 10.1.2.142 의 증거에는 당연히 그것이 적혀 있고,
         그러면 같은 호스트의 모든 config-leak 자격 증명이 이 항목이 쓴 것으로 계산된다(실측에서
         "MySQL 항목이 도메인 컨트롤러에 의존한다"는 결과가 나왔다). 비밀번호/계정 같은 **특징 문자열**만 인정한다. */
      return false
    }
    /* 선행 후보 = 이 항목 증거에 직접 언급된 주소 + **연결된 자격 증명의 출처 포인터**.
       자격 증명의 tool/note 에서 "첫 번째 IP"가 보통 이 비밀번호/권한의 출처다
       (예: "10.1.2.163:9200 의 ES 에서 비밀번호를 찾아냈다" → 출처는 그 ES 이고;
        "smbclient //10.1.2.5/SYSVOL 로 시작 스크립트를 가져왔다" → 출처는 도메인 컨트롤러).
       첫 번째 IP 만 취하는 것은 정밀도를 위해서다: tool 필드 뒤에는 흔히 다른 자산이 덧붙어 언급되고,
       전부 취하면 "RabbitMQ 비밀번호가 애플리케이션 설정에서 왔다"를 "이 항목이 RabbitMQ 에 의존한다"로 오판한다. */
    for (const x of ordered) {
      /* 강한 단서: 이 항목이 쓴 자격 증명이 어디서 왔는가(자격 증명 tool/note 의 첫 번째 IP).
         약한 단서: 이 항목 증거에 덧붙어 언급된 주소(경계 항목은 대역 목록 전체를 증거에 적어 넣고,
                 그것을 의존 근거로 삼으면 "경계 돌파가 Redis 에 의존한다"는 잡음이 나온다).
         강한 단서를 먼저 쓰고, 3개가 안 되면 약한 단서로 채운다. */
      const strong = new Set()
      for (const c of credsAllForDeps.filter((v) => ownsCred(x, v))) {
        const a = ipOfTarget(c.tool)
        const b = ipOfTarget(c.note)
        if (a !== null) strong.add(a)
        if (b !== null) strong.add(b)
      }
      const weakText = [x.evidence, x.note, x.target].join('\n')
      const weak = new Map()
      for (const ip of ipsIn(weakText)) weak.set(ip, (weak.get(ip) || 0) + 1)
      /* 약한 단서는 "이 항목 증거에서 언급된 횟수"가 많은 순서로 취한다: 언급 횟수가 많은 것이 보통 이 성과의 핵심 대상이다
         (경계 항목의 증거는 대역 전체를 한 번 나열하므로, 문서 순서만 따라가면 무관한 항목을 먼저 만난다). */
      const pick = (get, size) => {
        const out = []
        for (const y of ordered) {
          if (y === x || y.point_id === x.point_id) continue
          const ip = ipOfTarget(y.target)
          if (ip === null || get(ip) === undefined) continue
          out.push({ y: y, w: size(ip) })
        }
        out.sort((a, b) => b.w - a.w)
        return out.slice(0, 3).map((v) => v.y)
      }
      const deps = pick((ip) => (strong.has(ip) ? 1 : undefined), () => 1)
      if (deps.length < 3) {
        for (const y of pick((ip) => weak.get(ip), (ip) => weak.get(ip) || 0)) {
          if (deps.length >= 3) break
          if (deps.indexOf(y) === -1) deps.push(y)
        }
      }
      x.deps = deps.map((y) => ({ no: y.chain_no, name: y.code, short: y.code, target: y.target }))
        .sort((a, b) => a.no - b.no)
      x._depIds = deps.map((y) => y.id)
    /* 환경 선행: 인터넷 측 이외의 성과는 모두 "통로"(터널 / 장악된 진입점) 위에 세워지므로, 따로 한 줄 표시한다 */
      x.needs_channel = stageOfItem(x) !== 'internet' && (x.tunnels || []).length > 0
    }
    /* 서로를 선행으로 지목하는 두 항목은 함께 철회한다(예: 도메인 컨트롤러 445 와 도메인 컨트롤러 389 가 같은 IP 라 서로를 지목한다):
       보고서는 선행을 하나 적게 쓸지언정 "A 가 B 에 의존하고 B 가 A 에 의존한다"는 자기모순 체인을 담지 않는다. */
    for (const x of ordered) {
      const kept = (x.deps || []).filter((d) => {
        const y = ordered.find((v) => v.chain_no === d.no)
        return y === undefined || (y._depIds || []).indexOf(x.id) === -1
      })
      x.deps = kept
    }
    for (const x of ordered) delete x._depIds

    /* ── 재현 진입점 분류: 보고서에 "붙여넣기 가능한 요청"을 줄지 "명령줄"을 줄지, 색인 표에 어떻게 표시할지를 정한다 ────
       · http    —— 실제 패킷 캡처가 있거나, HTTP 진입점으로 판정되어 요청을 재구성할 수 있다 → Burp / Yakit 에서 바로 리플레이 가능
       · cli     —— 실제 명령(당일 직접 입력한 그 명령) → 터미널에서 실행 가능(비 HTTP 프로토콜이라 Burp/Yakit 해당 없음)
       · method  —— 해당 득점 포인트의 표준 재현 동작 설명만 있음(보존된 명령 없음) → 있는 그대로 동작을 주고, 명령을 위조하지 않는다 */
    const looksLikeHttpTarget = (t) => /^https?:\/\//i.test(String(t || '').trim())
    for (const x of ordered) {
      const captured = x.requests.length > 0 && String(x.requests[0].request || '').trim() !== ''
      /* ⚠️ "대상 자체가 http(s) 주소"이거나 "실제 패킷 캡처가 있다"일 때만 요청을 준다.
         아니면 터널/데이터베이스 항목의 같은 자산에 대한 무관한 curl 을 하나의 요청으로 합성해 버린다(실측에서
         `POST / HTTP/1.1` + body `-` 처럼 Yakit 에 붙여 넣어도 아무것도 재현되지 않는 가짜 요청이 나왔다). */
      const httpOk = (captured
        || (looksLikeHttpTarget(x.target) && x.replay_http !== null && x.replay_http !== undefined))
      /* 명령: 실제 명령을 우선하고, 템플릿 명령은 자리 표시자가 전부 채워졌을 때만 "실행 가능한 명령"으로 쓴다 */
      const unfilled = x.replay_cmd_unfilled || []
      const cmdOk = x.replay_cmd !== null && x.replay_cmd !== undefined && String(x.replay_cmd).trim() !== ''
        && (x.replay_cmd_kind !== 'template' || unfilled.length === 0)
      x.repro_kind = httpOk ? 'http' : (cmdOk ? 'cli' : 'method')
      x.repro_http_captured = captured
      /* 비 HTTP 프로토콜의 재현 설명(Burp/Yakit 은 SMB/데이터베이스/NFS 를 보낼 수 없으므로 이유를 밝힌다) */
      const cmd = String(x.replay_cmd || '')
      x.repro_nonhttp = x.repro_kind === 'cli'
        && /atexec|nxc |smbclient|impacket|secretsdump|mysql|redis-cli|showmount|mount |winrm|proxychains/.test(cmd)
    }

    /* 단계 버킷(화면과 본문이 공유): 버킷에 들어가는 것은 **병합 후** 항목이고, 점수도 병합 후 합계다 */
    let cumulative = 0
    const stages = stageRows.map((st) => {
      const sItems = ordered.filter((x) => stageOfItem(x) === st.code)
      const pts = sItems.reduce((n, x) => n + (x.counted ? x.points : 0), 0)
      cumulative += pts
      return { code: st.code, name: st.name, color: st.color, goal: st.goal, transition: st.transition,
        ordinal: st.ordinal, points: pts, cumulative: cumulative, items: sItems }
    }).filter((st) => st.items.length > 0)

    /* ── markdown, 복사/다운로드용이며 에이전트가 바로 전달하기에도 편하다 ──────────────────────────
       구조는 "사용자가 그대로 재현한다"를 기준으로 짜고, "우리가 얼마나 완전하게 기록했나"를 기준으로 짜지 않는다:
         ⓪ 요약과 대조 + 재현 색인 표(검수자가 먼저 본다)
         ① 재현 선행 조건(통로 / 자격 증명 / 도구 연결 / 도구 역량 경계)
         ② 공격 체인(의존 순서대로, 선행 표시)
         ③ 항목별 상세(재현 진입점을 맨 앞에, 대상 대장, 증거 색인)
         ④ 득점 포인트 설명(판정 기준과 자료 요건은 한 번만 말하고, 항목마다 반복하지 않는다)
         ⑤ 부록(자산, 기록과 점수 대조)
       ⚠️ 길이 규율 두 가지: 요청 본문은 온전히 보존한다(Yakit 에서 바로 리플레이해야 하므로 잘라내면 못 쓴다);
       응답 본문은 검증용으로만 쓰고, 1000자에서 자른 뒤 길이를 표시한다. */
    const md = []
    const CIRCLED = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩', '⑪', '⑫', '⑬', '⑭', '⑮', '⑯', '⑰', '⑱', '⑲', '⑳']
    const AGENT_LABEL = (a) => ROLE_TITLES[a] || a || "unlabeled role"
    const oneLine = (t, n) => String(t === null || t === undefined ? '' : t).replace(/\s*\n+\s*/g, ' ').trim().slice(0, n || 300)
    const shortName = (x) => POINT_SHORT_NAME[x.code] || x.point_name || x.code
    /* 초기 기록에서 `->` 가 `-&gt;` 로 적혀 있다(폼 이스케이프 잔재). 보고서에서 되돌려야 하고, 아니면 대상 열을 볼 수 없다 */
    /* 병합 항목은 표에 "첫 호스트 + 대수"만 적는다. 아니면 64 대짜리 긴 목록이 색인 표를 터뜨린다 */
    const targetBrief = (x) => (x.is_group
      ? String(x.target || '') + " (+" + x.group_size + " targets)"
      : unesc(x.target))
    const unesc = (t) => String(t === null || t === undefined ? '' : t)
      .replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&').replace(/&quot;/g, '"')
    const block = (lang, text) => { md.push('```' + lang, String(text).replace(/\r/g, '').trim(), '```', '') }
    /* 자르는 지점은 문장/절 경계에 둔다: 그냥 slice 하면 "…백엔드는 3 대 LB 폴링(" 같은 잘린 문장이 나온다 */
    const clipText = (t, n) => {
      const s0 = oneLine(t, n)
      if (s0.length < n) return s0
      for (const sep of ['\u3002', '\uff1b', '\uff09', ')', '\uff0c']) {
        const i = s0.lastIndexOf(sep)
        if (i > n * 0.5) return s0.slice(0, i + 1)
      }
      return s0
    }
    const targetName = (meta && meta.target_name) || id
    const httpCount = ordered.filter((x) => x.repro_kind === 'http').length
    const cliCount = ordered.filter((x) => x.repro_kind === 'cli').length
    const methodCount = ordered.filter((x) => x.repro_kind === 'method').length

    md.push('# ' + targetName + " · Red team results replay report", '')
    md.push("> This report only includes **scored results**: each entry gives a replay entry point (a raw request Burp / Yakit can replay directly, "
      + "or a command line run through the tunnel), the success criteria, and an evidence index; entries are ordered by attack-chain **dependency** with prerequisites marked.", '')

    /* ── ⓪ 요약과 대조 ──────────────────────────────────────────────────── */
    md.push("## 0. Summary and reconciliation", '')
    const shotItems = ordered.filter((x) => (x.shots || []).length > 0)
    const shotTotal = ordered.reduce((n, x) => n + (x.shots || []).length, 0)
    const shotReal = ordered.reduce((n, x) => n + (x.shots || []).filter((v) => v.kind !== 'card').length, 0)
    md.push("| Total score | Scored items | Burp/Yakit replay | Command-line replay | Other methods | Evidence screenshots |", '| --- | --- | --- | --- | --- | --- |')
    md.push('| **' + summary.points + " pts** | " + ordered.length + " item(s) | " + httpCount
      + " item(s) | " + cliCount + " item(s) | " + methodCount + " item(s) | " + shotTotal + " screenshots / " + shotItems.length
      + " entries" + (shotReal < shotTotal ? " (live screenshots: " + shotReal + "; the rest are evidence excerpts generated from records)" : '') + ' |', '')
    md.push("### 0.1 Score point usage", '')
    md.push("| Score point | Hits | Points this run | Per-hit cap |", '| --- | --- | --- | --- |')
    const byPoint = new Map()
    for (const x of ordered) {
      const k = x.code
      if (!byPoint.has(k)) byPoint.set(k, { code: k, name: shortName(x), hits: 0, points: 0, cap: x.point_cap })
      const rec = byPoint.get(k)
      rec.hits += x.is_group ? x.group_size : 1
      rec.points += x.points
    }
    for (const rec of Array.from(byPoint.values()).sort((a, b) => b.points - a.points)) {
      md.push('| ' + rec.name + ' (`' + rec.code + '`) | ' + rec.hits + ' | +' + rec.points + " pts | "
        + (Number(rec.cap) > 0 ? Number(rec.cap) + " pts" + (rec.points >= Number(rec.cap) ? " (full)" : '') : '—') + ' |')
    }
    md.push('')
    md.push("### 0.2 Records vs scoring reconciliation", '')
    md.push("- Score records in the database: **" + rows.length + "** → scored hits: **" + summary.count + "**"
      + " → after merging same-action entries, body: **" + ordered.length + "** (one entry per bulk action + a per-target ledger)"
      + "; another **" + (summary.selfCreatedExcluded + summary.serviceCappedExcluded + summary.disabledExcluded)
      + "** were not scored (see below).")
    if (summary.serviceCappedExcluded > 0) {
      md.push("- Excluded: duplicate account/database privileges on the same asset+port " + summary.serviceCappedExcluded
        + " (once the highest privilege on a service is reached it is capped; duplicates do not add up — see appendix 5.2).")
    }
    if (summary.selfCreatedExcluded > 0) md.push("- Excluded: self-registered/self-created accounts " + summary.selfCreatedExcluded + " (scoring is for taking over privileges someone else already had).")
    if (summary.disabledExcluded > 0) md.push("- Excluded: the score point is disabled " + summary.disabledExcluded + ".")
    const corrected = reportRows.filter((h) => /(\u6821\u6b63|보정)/.test(String(h.note || '')))
    if (corrected.length > 0) {
      md.push('')
      md.push("> **Tier correction**: the following " + corrected.length + " entries were downgraded during final review;"
        + "the values below are the **corrected** numbers (panel recorded 16180 raw; corrected 16090):", '')
      for (const h of corrected) {
        md.push('- `' + (h.target || '') + '` ' + (h.point_name || h.code) + ' → **' + (h.points || 0) + " pts** "
          + oneLine(h.note, 200))
      }
    }
    md.push('')
    md.push("### 0.3 Replay index", '')
    md.push("| # | Score point | Points | Target | Prerequisite | Replay entry |", '| --- | --- | --- | --- | --- | --- |')
    for (const x of ordered) {
      const dep = (x.deps || []).map((d) => '#' + d.no).join(', ')
      const entry = x.repro_kind === 'http' ? "Burp / Yakit request (§3." + x.chain_no + ')'
        : (x.repro_kind === 'cli' ? "command line (§3." + x.chain_no + ')' : "replay method (§3." + x.chain_no + ')')
      md.push('| ' + x.chain_no + ' | ' + shortName(x) + ' | +' + x.points + ' | `' + oneLine(targetBrief(x), 60) + '` | '
        + (dep === '' ? (x.needs_channel ? "channel (§1.1)" : '—') : dep) + ' | ' + entry + ' |')
    }
    md.push('')

    /* ── ① 재현 선행 조건 ────────────────────────────────────────────────── */
    const tunnelsAll = this.listTunnels(id)
    const shellsAll = this.listWebshells(id)
    const credsAll = credsAllForDeps
    /* "이 항목이 사용한 자격 증명"은 ownsCred(증거에 비밀번호/계정이 적혀 있음)로 다시 고르고, 여기에 호스트가 득점 대상에 놓인 자격 증명을 더한다.
       trace 로 붙은 것들은 쓰지 않는다: 같은 자산의 느슨한 매칭이라 이 항목과 무관한 인터페이스 token 까지 선행 조건 표에 들어간다. */
    const scoredHosts = new Set(ordered.map((x) => ipOfTarget(x.target)).filter((v) => v !== null))
    const referencedCred = new Set()
    for (const x of ordered) for (const c of credsAll.filter((v) => ownsCred(x, v))) referencedCred.add(String(c.id))
    for (const c of credsAll) {
      const ip = ipOfTarget(c.host)
      if (ip !== null && scoredHosts.has(ip)) referencedCred.add(String(c.id))
    }
    const credRank = (c) => {
      const p = String(c.privilege || '')
      if (/domain-admin/.test(p)) return 0
      if (/local-admin|domain-admin|admin/.test(p)) return 1
      if (/db-|redis|mysql|system/.test(p)) return 2
      if (/sso|sharekey|api/.test(p)) return 3
      return 9
    }
    /* 기록에 "검증 실패/보관만"이라고 적힌 후보는 제외한다 —— 재현 가능한 진입점이 아니므로 나열하면 오해만 준다 */
    const usablePool = credsAll.filter((c) => !/검증 실패|미검증|보관만|유효 자격 증명 아님|\u672a\u901a\u8fc7|\u672a\u9a8c\u8bc1|\u4ec5\u7559\u6863|\u4e0d\u53ef\u4f5c\u4e3a\u6709\u6548\u51ed\u636e|unknown/.test(String(c.note || '') + String(c.privilege || '')))
    const usefulCreds = usablePool
      .filter((c) => referencedCred.has(String(c.id)))
      .slice()
      .sort((a, b) => (referencedCred.has(String(b.id)) ? 1 : 0) - (referencedCred.has(String(a.id)) ? 1 : 0)
        || credRank(a) - credRank(b))
      .slice(0, 12)
    md.push('---', '')
    md.push("## 1. Replay prerequisites", '')
    md.push("> Set this section up first; only then will the replay entries below actually work.", '')
    md.push("### 1.1 Channels", '')
    if (tunnelsAll.length === 0) {
      md.push("No tunnel registered for this target; internal entries need your own channel to the target.", '')
    } else {
      for (const t of tunnelsAll) {
        md.push('- **' + (t.kind || "tunnel") + "**: listening on `" + (t.listen || '') + "` entry `" + (t.entry || '') + '`'
          + (t.entry_kind ? ' (entry_kind=' + t.entry_kind + ')' : '')
          + (t.reach ? " reachable " + t.reach : '')
          + (String(t.status || '') !== '' ? " status " + t.status : ''))
        if (t.command) md.push("  - start command: ")
        if (t.command) block('bash', t.command)
        if (t.note) md.push("  - notes: " + clipText(t.note, 320))
      }
    }
    if (shellsAll.length > 0) {
      md.push('')
      md.push("**WebShell / session entries**", '')
      for (const w of shellsAll) {
        md.push('- `' + (w.url || '') + '` ' + (w.shell_type || '') + (w.pass_key ? " connect password `" + w.pass_key + '`' : '')
          + (String(w.status || '') !== '' ? "` status " + w.status : '') + (w.note ? ' · ' + clipText(w.note, 200) : ''))
      }
      md.push('')
    }
    md.push("### 1.2 Credentials", '')
    if (usefulCreds.length === 0) {
      md.push("No credentials registered for this target.", '')
    } else {
      md.push("| Target | Account | Privilege | Source | How obtained |", '| --- | --- | --- | --- | --- |')
      for (const c of usefulCreds) {
        md.push('| `' + oneLine(c.host, 40) + '` | `' + oneLine(c.username, 40) + '` | ' + oneLine(c.privilege || '—', 30)
          + ' | ' + oneLine(c.source || '—', 40) + ' | `' + oneLine(c.tool || '—', 120) + '` |')
      }
      md.push('')
    }
    md.push("### 1.3 Tool access", '')
    md.push("- **Burp Suite**: set Settings → Network → Connections → SOCKS proxy to `127.0.0.1:<tunnel port>`, "
      + "and enable \"Use SOCKS proxy for DNS lookups\"; in Repeater, paste the request from this report as-is.", '')
    md.push("- **Yakit**: configure the same SOCKS5 (with auth) under downstream proxy / chained proxy, "
      + "then use Repeater → paste raw request to send.", '')
    md.push("- **Command line**: prefix `proxychains4 -q -f <proxychains config>` to impacket / nxc / smbclient / mysql / redis-cli commands; "
      + "for HTTP you can also use `curl --socks5-hostname <account>:<password>@127.0.0.1:<port>`.", '')
    md.push("### 1.4 Tool capability limits", '')
    md.push("| Target type | Protocol | Recommended tools |", '| --- | --- | --- |')
    md.push("| Web apps, admin consoles, REST APIs (including internal) | HTTP / HTTPS | Burp Suite, Yakit (via SOCKS upstream) |")
    md.push("| WebShell / tunnel | HTTP / WebSocket | Behinder, Godzilla, suo5 (see §1.1) |")
    md.push("| Windows hosts, domain controllers, shares | SMB / RPC / WinRM | `impacket-atexec`, `nxc`, `smbclient`, `evil-winrm`, pywinrm (via proxychains) |")
    md.push("| Databases | MySQL / Redis / PostgreSQL | `mysql`, `redis-cli`, `psql` (via proxychains) |")
    md.push("| File shares | NFS | `showmount`, `mount -t nfs4` (via proxychains or a compromised host) |")
    md.push('')
    md.push("> Burp / Yakit can only replay HTTP(S) and WebSocket. For SMB, WinRM, database, and NFS protocols, "
      + "use the command line as shown above — the corresponding report entries give commands you can run directly.", '')

    /* ── ② 공격 체인(의존 순서) ──────────────────────────────────────────── */
    md.push('---', '')
    md.push("## 2. Attack chain (dependency order)", '')
    md.push("> The number is the document order (attack-chain stages ① → ⑤, and within a stage by acquisition time). The `Prerequisite` column lists results that must be achieved first; "
      + "stage buckets sort by score-point type, so a prerequisite number **may be larger than the entry itself** (e.g. a cross-boundary breach depends on domain-controller #16); "
      + "jump to that number to read it.", '')
    md.push("| # | Score point | Points | Target | Prerequisite |", '| --- | --- | --- | --- | --- |')
    for (const x of ordered) {
      const dep = (x.deps || []).map((d) => '#' + d.no + ' ' + (POINT_SHORT_NAME[d.name] || d.name)).join(', ')
      md.push('| ' + x.chain_no + ' | ' + shortName(x) + ' | +' + x.points + ' | `' + oneLine(targetBrief(x), 60) + '` | '
        + (dep === '' ? (x.needs_channel ? "channel (§1.1)" : '—') : dep) + ' |')
    }
    md.push('')
    for (const st of stages) {
      md.push('- ' + st.name + ': ' + st.items.length + " item(s) · +" + st.points + " pts (cumulative +" + st.cumulative + " pts)")
    }
    md.push('')

    /* ── ③ 항목별 상세 ────────────────────────────────────────────────────── */
    md.push('---', '')
    md.push("## 3. Entry details", '')
    md.push("> Ordered by attack-chain stage ① → ⑤ (the stage number is the real position in the chain); within a stage, ordered by action time, "
      + "and the `3.N` numbers correspond one-to-one with the replay index above.", '')
    let lastStage = null
    for (const x of ordered) {
      const st = stageOfItem(x)
      if (st !== lastStage) {
        lastStage = st
        const sr = stages.find((v) => v.code === st)
        if (sr !== undefined) {
          const circled = (CIRCLED[sr.ordinal - 1] || '')
          md.push('## ' + circled + ' ' + sr.name + ' (' + sr.items.length + " item(s) · +" + sr.points + " pts)", '')
        }
      }
      const depTxt = (x.deps || []).map((d) => '#' + d.no + ' ' + (POINT_SHORT_NAME[d.name] || d.name)
        + ' (`' + oneLine(d.target, 40) + '`)').join(', ')
      md.push('### 3.' + x.chain_no + ' ' + shortName(x) + ' · `' + oneLine(targetBrief(x), 80) + '` **+' + x.points + " pts**", '')
      md.push("- **Score point**: " + (x.point_name || '') + ' `' + x.code + '`'
        + (x.point_rule ? " · rule " + x.point_rule : '')
        + (x.point_tier ? " · tier " + oneLine(x.point_tier, 40) : '')
        + (Number(x.point_cap) > 0 ? " · per-hit cap " + x.point_cap + " pts" : ''))
      if (x.is_group) md.push("- **This entry covers " + x.group_size + " targets** (one action hitting them in a batch; per-target list in the ledger below)")
      if (x.gained) md.push("- **Gained**: " + oneLine(x.gained, 120))
      if (x.is_group) {
        const list = (x.group_targets || []).map((g) => '`' + g.target + '`')
        md.push("- **Result**: the same action achieved the same result on " + x.group_size + " targets ("
          + list[0] + ' … ' + list[list.length - 1] + "); per-target output in the table below and the evidence index")
      } else if (x.evidence) {
        md.push("- **Result**: " + oneLine(x.evidence, 400))
      }
      if (x.confirm && x.confirm.need) md.push("- **Success criteria**: " + oneLine(x.confirm.need, 160))
      md.push("- **Prerequisite**: " + (depTxt !== '' ? depTxt : (x.needs_channel ? "channel (see §1.1)" : "none (start of the chain)")))
      md.push('')

      /* 재현 진입점: ① HTTP 요청(바로 리플레이 가능) ② 명령줄 ③ 재현 방식 설명 */
      md.push("#### Replay", '')
      if (x.repro_kind === 'http') {
        const lead = (x.repro_http_captured && x.replay_http_rebuilt !== true)
          ? "**Raw request** (captured live that day; copy the whole block → Burp Repeater / Yakit \"paste raw request\" → send)"
          : (x.repro_http_captured
              ? "**Rebuilt request** (the original request was not kept byte-for-byte; this one is rebuilt from that day's command and output, with fields filled from the target and credentials)"
              : "**Equivalent request** (rebuilt from that day's actual command; no raw capture was kept, fields filled from the target and credentials)")
        md.push(lead + ': ', '')
        block('http', x.replay_http)
        if (x.requests.length > 0 && x.requests[0].response) {
          const full = String(x.requests[0].response)
          md.push("**Server response** (" + (x.requests[0].status === null || x.requests[0].status === undefined
            ? "status not recorded" : 'HTTP ' + x.requests[0].status) + '): ', '')
          md.push('```http', full.replace(/\r/g, '').trim().slice(0, 1000)
            + (full.length > 1000 ? "\n… (response is " + full.length + " characters; see the evidence store for the full content)" : ''), '```', '')
        }
        if (x.requests.length > 1) md.push("> There are also " + (x.requests.length - 1) + " more request evidences; see the evidence store.", '')
        /* 같은 동작의 curl 등가 형태도 함께 준다: 어떤 이는 명령을 바로 실행하고, 어떤 이는 Repeater 를 쓴다 */
        if (x.replay_cmd !== null && x.replay_cmd !== undefined && String(x.replay_cmd).trim() !== '') {
          md.push("**Equivalent command line** (matches the request above):", '')
          block('bash', x.replay_cmd)
        }
      }
      if (x.repro_kind === 'cli') {
        const lead = (x.replay_cmd_kind === 'real' || x.replay_cmd_kind === 'linked')
          ? "**Command line** (the command actually run that day; can be re-run directly)"
          : (x.replay_cmd_kind === 'synthesized' ? "**Equivalent command line** (derived from the request above; address and method match it)"
            : "**Command line** (taken from that day's attack step)")
        md.push(lead + ': ', '')
        block('bash', x.replay_cmd)
        if (x.repro_nonhttp) {
          md.push("> This action used SMB / RPC / database / file-share protocols, which Burp and Yakit cannot replay directly; "
            + "run it through proxychains over the tunnel as described in §1.3.", '')
        }
      }
      if (x.repro_kind === 'method') {
        md.push("**Replay method**: " + ((x.confirm && x.confirm.replay)
          ? oneLine(x.confirm.replay, 200)
          : "Reproduce the same action on the target per this score point's success criteria and keep the output."), '')
        if ((x.steps || []).length > 0) {
          md.push("> See \"How it was done\" below for that day's action points; no separate command was kept, so replay the action on the target.", '')
        }
      }

      /* 증거 스크린샷: 열 줄의 글보다 그림 한 장이 유용하다. kind=card 인 것은 "생성된 것"을 반드시 밝혀야 하고, 현장 스크린샷으로 가장할 수 없다 */
      if ((x.shots || []).length > 0) {
        const shotNote = []
        if (x.shot_total > x.shots.length) shotNote.push("This score point has " + x.shot_total + " screenshots in total; showing " + x.shots.length + " representative ones")
        if (x.is_group) shotNote.push("This group: " + x.group_size + " targets")
        md.push("**Evidence screenshots**" + (shotNote.length > 0 ? ' (' + shotNote.join('; ') + ')' : '') + ': ', '')
        for (const sh of x.shots) {
          const alt = String(sh.label || ("evidence " + sh.id)).replace(/[\[\]]/g, '')
          md.push('![' + alt + '](' + shotRefOf(sh) + ')', '')
          const cap = []
          if (sh.label) cap.push(sh.label)
          else if (sh.target) cap.push('`' + sh.target + '`')
          if (sh.kind === 'card') cap.push("**Evidence excerpt generated from that day's records (not a live screenshot)**")
          if (sh.captured_at) cap.push(String(sh.captured_at).replace('T', ' ').slice(0, 16))
          if (sh.source_ref) cap.push("source file `" + oneLine(sh.source_ref, 120) + '`')
          if (sh.note) cap.push(oneLine(sh.note, 160))
          if (cap.length > 0) md.push('> ' + cap.join(' · '), '')
        }
        md.push('')
      } else if (Number(x.shot_total) > 0) {
        /* 이 항목에는 대표 이미지가 배정되지 않았다(같은 득점 포인트의 이미지는 앞 항목에서 보여 주었다) —— 어디서 보면 되는지 밝혀, 빠졌다고 오해하지 않게 한다 */
        md.push("> Evidence screenshots for this entry are shown under this score point's representative images (the score point has " + x.shot_total + " screenshots in total; the report shows at most 3 per score point).", '')
        md.push('')
      }

      /* 대상 대장(병합 항목): 한 대에 한 줄, 대별 증거 포함 */
      if (x.is_group) {
        md.push("**Target ledger (" + x.group_size + " devices; per-target output in the evidence index)**", '')
        md.push("| # | Target | Result | Scored |", '| --- | --- | --- | --- |')
        const brief = (ev) => {
          const m = /\uff08([^\uff09]{1,60})\uff09/.exec(String(ev || ''))
          if (m !== null) return oneLine(m[1], 60)
          return oneLine(ev, 80)
        }
        ;(x.group_targets || []).forEach((g, gi) => {
          md.push('| ' + (gi + 1) + ' | `' + g.target + '` | ' + brief(g.evidence) + ' | +' + g.points + ' |')
        })
        const extra = summary.serviceCapped.filter((c) => c.code === x.code)
        if (extra.length > 0) {
          md.push('')
          md.push("> There are also " + extra.length + " hosts that reached the same privilege but were not scored due to the **per-item cap** (kept as a record): "
            + extra.map((c) => '`' + c.target + '`').join(', ') + ", see appendix 5.2.", '')
        }
        md.push('')
      }

      /* 어떻게 했는가: 동작 단계(실제 명령과 응답 출력 포함) */
      const evFiles = Array.from(new Set((x.steps || []).map((s) => String(s.evidence_ref || '').trim()).filter((v) => v !== '')))
      if ((x.steps || []).length > 0 || x.how || x.vuln || evFiles.length > 0) {
        md.push("#### Action record", '')
        if (x.how) md.push('> ' + oneLine(x.how, 240), '')
        ;(x.steps || []).forEach((s, si) => {
          md.push('**' + (si + 1) + '. ' + oneLine(s.title || "(unnamed action)", 80) + '**'
            + (s.agent ? ' — ' + AGENT_LABEL(s.agent) : '')
            + (s.inferred ? " · (inferred from the same asset)" : ''))
          if (s.detail) md.push('- ' + oneLine(s.detail, 400))
          if (s.result) md.push("- output: " + oneLine(s.result, 300))
          if (s.tool && String(s.tool).trim() !== String(x.replay_cmd || '').trim()) {
            md.push("- command: ")
            md.push('  ```bash', '  ' + String(s.tool).replace(/\r/g, '').trim().slice(0, 1500), '  ```')
          }
          if (s.evidence_ref) md.push("- evidence: `" + oneLine(s.evidence_ref, 200) + '`')
        })
        md.push('')
      }
      /* 항목별 자격 증명은 "이 항목이 실제로 쓴 몇 개"만 남긴다: trace 는 같은 자산의 자격 증명을 함께 붙이고,
         그것은 화면용 느슨한 뷰다. 보고서에 무관한 인터페이스 token 을 줄줄이 붙이면 진위만 의심받는다. */
      const itemCreds = credsAll.filter((c) => ownsCred(x, c)
        || (ipOfTarget(c.host) !== null && ipOfTarget(c.host) === ipOfTarget(x.target)))
      if (itemCreds.length > 0) {
        md.push("**Credentials**: " + itemCreds.map((c) => '`' + (c.host || '') + '` ' + (c.username || '—')
          + (c.privilege ? ' (' + c.privilege + ')' : '') + " · source: " + (c.source || "unlabeled")).join('<br>'), '')
      }
      if ((x.webshells || []).length > 0) {
        md.push('**WebShell**: ' + x.webshells.map((w) => '`' + (w.url || '') + '` ' + (w.shell_type || '')
          + (w.pass_key ? " · key `" + w.pass_key + '`' : '')).join('<br>'), '')
      }
      if ((x.tunnels || []).length > 0) {
        md.push("**Channels**: " + x.tunnels.map((t) => '`' + (t.kind || '') + "` listening on `" + (t.listen || '')
          + '`').join('<br>'), '')
      }
      const meta2 = []
      if (x.vuln) meta2.push("vuln " + (x.vuln.cve ? x.vuln.cve + ' ' : '') + oneLine(x.vuln.title, 80))
      if (x.recorded_at) meta2.push("obtained " + String(x.recorded_at).replace('T', ' ').slice(0, 16)
        + (x.recorded_by ? ' (' + AGENT_LABEL(x.recorded_by) + ')' : ''))
      if (Number(x.point_cap) > 0) {
        const used = byPoint.get(x.code) ? byPoint.get(x.code).points : x.points
        meta2.push("This score point has used " + used + '/' + x.point_cap + " pts")
      }
      if (meta2.length > 0) md.push('> ' + meta2.join(' · '), '')
      md.push('')
    }

    /* ── ④ 득점 포인트 설명(판정 기준과 자료 요건은 한 번만) ──────────────────────── */
    md.push('---', '')
    md.push("## 4. Score point reference", '')
    md.push("> These criteria are not repeated per entry. General rules: highest privilege counts once (G1); data results score separately (G2); "
      + "caps apply per defending unit (G3); endpoints and devices score per unit (G4); proof material follows G7.", '')
    md.push("| Score point | Rule / tier | Success criteria | Required material | Standard replay action |", '| --- | --- | --- | --- | --- |')
    for (const rec of Array.from(byPoint.values()).sort((a, b) => b.points - a.points)) {
      const c = scoreConfirmOf(rec.code) || {}
      const sample = ordered.find((x) => x.code === rec.code) || {}
      md.push('| ' + rec.name + ' (`' + rec.code + '`) | '
        + (sample.point_rule ? "rule " + sample.point_rule + ' ' : '') + oneLine(sample.point_tier || '—', 50) + ' | '
        + oneLine(c.need || '—', 160) + ' | ' + oneLine(c.proof || '—', 160) + ' | '
        + '`' + oneLine(c.replay || '—', 140) + '` |')
    }
    md.push('')

    /* ── ⑤ 부록 ────────────────────────────────────────────────────────── */
    /* 대조에 쓰는 자산 목록: 히트/단계가 명시적으로 연결한 자산 ∪ **득점 대상 IP 에 대응하는 자산**.
       후자를 빼면 안 된다 —— 대부분의 히트는 "대상 주소"만 적고 asset_id 를 붙이지 않으므로,
       asset_id 로만 모으면 부록에 몇 대만 남아, 검수할 때 장부가 맞지 않는다. */
    const assetsTouched = new Set(
      ordered.flatMap((x) => [x.asset_id, ...(x.steps || []).map((s) => s.asset_id)])
        .filter((v) => v !== null && v !== undefined),
    )
    const targetIps = Array.from(new Set(ordered.map((x) => ipOfTarget(x.target)).filter((v) => v !== null)))
    if (targetIps.length > 0) {
      const phIp = targetIps.map(() => '?').join(',')
      for (const a of db.prepare('SELECT id FROM asset WHERE ip IN (' + phIp + ')').all(...targetIps)) assetsTouched.add(a.id)
    }
    const assetsTouchedList = Array.from(assetsTouched)
    if (assetsTouchedList.length > 0) {
      const ph = assetsTouchedList.map(() => '?').join(',')
      const rowsA = db.prepare(`SELECT a.id, a.ip, a.primary_name, a.discovered_at, a.first_seen, a.last_seen,
          a.test_status, a.priority, COALESCE(a.scope, (${SCOPE_SQL})) AS scope
        FROM asset a WHERE a.id IN (${ph}) ORDER BY a.discovered_at, a.id`).all(...assetsTouchedList)
      md.push('---', '')
      md.push("## 5. Appendix", '')
      md.push("### 5.1 Assets covered by this report (with discovery time)", '')
      md.push("| Asset | Name | Internal/external | Discovered | Last collected |")
      md.push('| --- | --- | --- | --- | --- |')
      for (const a of rowsA) {
        md.push('| `' + (a.ip || '') + '` | ' + (a.primary_name || '—')
          + ' | ' + (a.scope === 'internal' ? "internal" : "external")
          + ' | ' + (a.discovered_at ? String(a.discovered_at).replace('T', ' ').slice(0, 19) : '—')
          + ' | ' + (a.last_seen ? String(a.last_seen).replace('T', ' ').slice(0, 19) : '—') + ' |')
      }
      md.push('')
    }
    if (summary.serviceCapped.length > 0) {
      md.push("### 5.2 Unscored duplicate records (service already capped)", '')
      md.push("| Target | Score point | Recorded points | Recorded at |", '| --- | --- | --- | --- |')
      for (const c of summary.serviceCapped) {
        md.push('| `' + (c.target || c.service || '') + '` | ' + (c.point_name || c.code) + ' | '
          + (c.points || 0) + ' | ' + String(c.recorded_at || '').replace('T', ' ').slice(0, 16) + ' |')
      }
      md.push('')
    }
    return { items: items2, stages, summary, markdown: md.join('\n'), target: targetName }
  }

  /**
   * 득점 체인: score_hit 을 시간순으로 펼쳐 하나의 체인으로 만들고, "득점" 관련 내용만 담으며 정보 수집 잡기장은 섞지 않는다.
   * 공격 체인 페이지의 "득점 체인" 뷰가 이것을 쓴다.
   */
  scoreChain(id, f = {}) {
    const db = this.db(id)
    const limit = Math.min(Number(f.limit) || 500, 2000)
    const items = db.prepare(`SELECT h.id, h.point_id, h.asset_id, h.vuln_id, h.step_id, h.target,
        h.evidence, h.note, h.self_created, h.port, h.recorded_by, h.recorded_at,
        p.code, p.name AS point_name, p.category, p.points AS point_default, p.points, p.enabled, h.points AS hit_points, h.multiplier, h.stage_code,
        a.ip AS asset_ip, v.title AS vuln_title, v.cve AS vuln_cve
      FROM score_hit h
      LEFT JOIN score_point p ON p.id = h.point_id
      LEFT JOIN asset a ON a.id = h.asset_id
      LEFT JOIN vuln v ON v.id = h.vuln_id
      ORDER BY h.recorded_at, h.id LIMIT ?`).all(limit)
    /* 각 단계가 "어떤 동작으로 얻어졌는가": ① 명시적으로 연결된 단계 ② 같은 자산에서 시간상 가장 가까운 단계(추론으로 표시) */
    const stepById = new Map(db.prepare('SELECT id, seq, stage, title, detail, asset_id, point_id, recorded_at FROM attack_step').all().map((x) => [x.id, x]))
    const stepsByAsset = new Map()
    for (const st of stepById.values()) {
      if (st.asset_id === null || st.asset_id === undefined) continue
      if (!stepsByAsset.has(st.asset_id)) stepsByAsset.set(st.asset_id, [])
      stepsByAsset.get(st.asset_id).push(st)
    }
    for (const list of stepsByAsset.values()) list.sort((a, b) => String(a.recorded_at).localeCompare(String(b.recorded_at)))
    for (const it of items) {
      let step = it.step_id !== null && it.step_id !== undefined ? stepById.get(it.step_id) : undefined
      let inferred = false
      if (step === undefined) {
        step = Array.from(stepById.values()).find((x) => x.point_id === it.point_id && x.asset_id === it.asset_id)
      }
      if (step === undefined && it.asset_id !== null && it.asset_id !== undefined) {
        const cands = (stepsByAsset.get(it.asset_id) || []).filter((x) => String(x.recorded_at) <= String(it.recorded_at))
        if (cands.length > 0) { step = cands[cands.length - 1]; inferred = true }
      }
      it.action = step === undefined ? null : { id: step.id, seq: step.seq, stage: step.stage, title: step.title, detail: step.detail }
      it.action_inferred = inferred
    }
    /* 점수 산정 기준(listScorePoints 와 완전히 동일하게 유지해, 보고서와 패널 점수가 어긋나지 않게 한다):
       ① 직접 등록/자체 생성한 계정은 점수를 주지 않는다(과정만 기록);
       ② 득점 포인트가 가진 dedup_scope 로 중복을 제거한다(같은 대상/같은 시스템/같은 서비스는 최고 점수 한 줄만, 또는 호스트 수 기준 카드 수로 누적);
       ③ rule + cap 으로 규칙 상한을 적용하고, 초과분은 점수를 주지 않는다. */
    const chainMeta = loadScoreMeta(db)
    const chainNames = loadAssetNames(db)
    /* 이 히트가 실제로 내보이는 점수: **히트 자체의 등급을 우선**(병합판에서는 한 줄에 여러 등급이 들어 있다. 예: 관리자 50 / 일반 10).
       scoreChain 의 SQL 은 hit_points / point_default 두 별칭으로 두 열을 따로 가져온다: h.points 를 직접 가져오면
       같은 이름의 p.points 에 가려져, 공격 체인 페이지의 등급 판정이 통째로 뒤집힌다. */
    const chainPointsOf = (it) => hitPointsOf({
      points: Number(it.hit_points) || Number(it.point_default) || 0,
      multiplier: it.multiplier,
      code: it.code,
    })
    const chainEval = evaluateScoreBoard(db, items.map((it) => Object.assign({}, it, { points: chainPointsOf(it) })),
      { meta: chainMeta, names: chainNames, enabledOnly: true })
    const cappedChain = { items: chainEval.items }
    const capFlagById = chainEval.byId
    const seenOf = new Map()
    for (const it of items) {
      it.self_created = Number(it.self_created) === 1
      const flag = capFlagById.get(it.id)
      it.capped = flag !== undefined && flag.capped === true
      it.port = normalizePort(it.port) ?? parseTargetPort(it.target)
      const meta = chainMeta.get(String(it.code)) || {}
      it.service = meta.dedup_scope === 'none' ? null : serviceLabel(it)
      it.capped_reason_kind = flag === undefined ? null : flag.capped_reason_kind
      it.rule = meta.rule ?? null
      it.rule_cap = meta.cap || 0
      /* 이 히트가 대외로 내보이는 점수 = 히트 자체의 등급 점수, 없으면 득점 포인트 기본값으로 폴백 */
      it.point_default = Number(it.point_default) || 0
      it.points = chainPointsOf(it)
      it.capped_reason = it.capped
        ? scoreCapReasonText(Object.assign({}, it, { rule_cap: meta.cap || 0 }), flag.capped_by_points)
        : null
      const seen = seenOf.get(it.point_id) || 0
      if (!it.self_created && !it.capped) seenOf.set(it.point_id, seen + 1)
      it.nth_of_point = seen + 1
      /* 비활성화된 득점 포인트의 히트는 점수를 주지 않는다(패널/보고서 기준과 동일: enabledOnly) */
      it.counted = it.self_created !== true && it.capped !== true && !chainEval.disabledIds.has(it.id)
    }
    /* 득점 포인트별로 "아직 확보하지 못한 것"을 모아, 빈틈을 한눈에 보게 한다 */
    const points = db.prepare('SELECT id, code, name, category, points, enabled FROM score_point ORDER BY sort_order, id').all()
    const hitPointIds = new Set(items.map((x) => x.point_id))
    const achieved = points.filter((p) => hitPointIds.has(p.id) && p.enabled === 1)
    const missing = points.filter((p) => !hitPointIds.has(p.id) && p.enabled === 1)
    /* ── 공격 체인: "공격면 위치" 기준으로 득점을 다섯 단계로 엮고, 누적 점수를 함께 낸다 ────────────── */
    const assetIds = Array.from(new Set(items.map((x) => x.asset_id).filter((v) => v !== null && v !== undefined)))
    const assetInfo = new Map()
    if (assetIds.length > 0) {
      const ph = assetIds.map(() => '?').join(',')
      const rows = db.prepare(`SELECT a.id, a.ip, a.segment_cidr, COALESCE(a.scope, (${SCOPE_SQL})) AS scope, a.state, a.priority,
          (SELECT COUNT(*) FROM port p WHERE p.asset_id = a.id AND p.state = 'open') AS open_ports,
          (SELECT COUNT(*) FROM vuln v WHERE v.asset_id = a.id AND v.status IN ('confirmed','exploited')) AS vulns
        FROM asset a WHERE a.id IN (${ph})`).all(...assetIds)
      for (const row of rows) assetInfo.set(row.id, row)
    }
    /* 각 득점이 어느 단계에 속하는지: 자동 도출(명시 stage_code > 유형 특례 > 자산 내외부망 > target 주소) */
    for (const it of items) {
      const info = it.asset_id !== null && it.asset_id !== undefined ? assetInfo.get(it.asset_id) : undefined
      it.stage_code = scoreStageOf(
        { stage_code: it.stage_code, code: it.code, target: it.target },
        info ? info.scope : undefined,
      )
    }
    const assetChip = (id) => {
      const a = assetInfo.get(id)
      if (a === undefined) return null
      return {
        id: a.id, ip: a.ip, segment_cidr: a.segment_cidr, scope: a.scope, state: a.state,
        priority: a.priority, open_ports: a.open_ports, vulns: a.vulns,
      }
    }
    /* 공격 단계를 단계별로 집계(공격 체인은 "각 단계에 동작이 몇 개인지"만 보고, 상세는 펼치지 않는다) */
    const stepsByStage = new Map()
    try {
      for (const row of db.prepare('SELECT stage, stage_code FROM attack_step LIMIT 5000').all()) {
        const code = row.stage_code || LEGACY_STAGE_MAP[row.stage] || 'recon'
        stepsByStage.set(code, (stepsByStage.get(code) || 0) + 1)
      }
    } catch { /* ignore */ }
    /* 세션 터널 표의 실제 터널: "경계 돌파" 단계에 속하는 확증 */
    let tunnels = []
    try {
      tunnels = db.prepare('SELECT id, kind, listen, entry, reach, entry_kind, status, note FROM tunnel ORDER BY id DESC LIMIT 50').all()
        .map((t) => Object.assign({}, t, { legit: tunnelIsLegit(t.entry_kind), entry_kind_label: TUNNEL_ENTRY_KINDS[t.entry_kind] || null }))
    } catch { tunnels = [] }
    /* 대상 경계를 실제로 넘은 터널만 "경계 돌파"의 확증이다. 자기 VPS/자체 서버에서 연 것은 해당하지 않는다 */
    const legitTunnels = tunnels.filter((t) => t.legit === true)
    const selfOnlyTunnels = tunnels.filter((t) => t.legit === false)

    const stageDefs = this.listStages(id)
    let cumulative = 0
    const stages = stageDefs.map((st, si) => {
      const sItems = items.filter((x) => x.stage_code === st.code)
      const pts = sItems.reduce((n, x) => n + (x.counted ? (x.points || 0) : 0), 0)
      cumulative += pts
      /* 이 단계에 관련된 자산(중복 제거). 정보 수집 단계는 "점수를 얻은 모든 자산"을 주고, 나머지 단계는 자기 것만 준다 */
      const ids = st.code === 'recon'
        ? Array.from(new Set(items.map((x) => x.asset_id).filter((v) => v !== null && v !== undefined)))
        : Array.from(new Set(sItems.map((x) => x.asset_id).filter((v) => v !== null && v !== undefined)))
      const assets = ids.map(assetChip).filter(Boolean).map((a) => {
        const mine = items.filter((x) => x.asset_id === a.id)
        return Object.assign({}, a, {
          points: mine.reduce((n, x) => n + (x.counted ? (x.points || 0) : 0), 0),
          hits: mine.length,
          /* 그 자산의 점수가 어느 단계에 속하는지(같은 자산이 내외부망 양쪽에서 모두 공략될 수 있다) */
          stage_code: mine.length > 0 ? mine[0].stage_code : st.code,
        })
      }).sort((a, b) => b.points - a.points || b.hits - a.hits)
      return Object.assign({}, st, {
        ordinal: si + 1,
        items: sItems,
        hits: sItems.length,
        counted: sItems.filter((x) => x.counted).length,
        points: pts,
        cumulative: cumulative,
        assets: assets,
        assetCount: assets.length,
        tunnels: st.code === 'boundary' ? legitTunnels : [],
        tunnels_self_only: st.code === 'boundary' ? selfOnlyTunnels : [],
        steps: stepsByStage.get(st.code) || 0,
      })
    })

    const scores = this.listScorePoints(id)
    return {
      items,
      stages,
      achieved,
      missing,
      summary: {
        hits: items.length,
        /* 점수 산정 기준은 득점 패널과 동일하다: 같은 종류의 득점은 상한을 두지 않고 히트 횟수로 누적한다 */
        points: scores.summary.achievedPoints,
        totalPoints: scores.summary.totalPoints,
        countedHits: scores.summary.countedHits,
        achievedCount: achieved.length,
        missingCount: missing.length,
        missingPoints: missing.reduce((n, p) => n + (p.potential || p.points || 0), 0),
        selfCreatedHits: scores.summary.selfCreatedHits || 0,
        /* 같은 자산 같은 포트에서 중복 히트되어 서비스 단위 상한으로 점수를 받지 못한 건수(계정 유형 / 데이터베이스 권한) */
        serviceCappedHits: scores.summary.serviceCappedHits || 0,
        tunnelsLegit: legitTunnels.length,
        tunnelsSelfOnly: selfOnlyTunnels.length,
      },
    }
  }

  /** 세션 개요: 화면과 프롬프트에서 쓰는 한 화면 요약(온라인/오프라인 통계 포함). */
  sessionSummary(id) {
    const db = this.db(id)
    const shells = db.prepare(`SELECT w.*, a.ip AS asset_ip FROM webshell w
      LEFT JOIN asset a ON a.id = w.asset_id ORDER BY w.id DESC`).all()
    const tunnels = db.prepare(`SELECT t.*, a.ip AS asset_ip, w.url AS webshell_url FROM tunnel t
      LEFT JOIN asset a ON a.id = t.asset_id LEFT JOIN webshell w ON w.id = t.webshell_id ORDER BY t.id DESC`).all()
      .map((t) => Object.assign({}, t, { legit: tunnelIsLegit(t.entry_kind), entry_kind_label: TUNNEL_ENTRY_KINDS[t.entry_kind] || null }))
    const creds = db.prepare('SELECT COUNT(*) AS n FROM credential').get()
    const access = db.prepare('SELECT COUNT(*) AS n FROM access_session').get()
    return {
      webshells: shells, tunnels,
      totals: {
        webshells: shells.length,
        webshellsOnline: shells.filter((s) => s.status === 'online').length,
        tunnels: tunnels.length,
        tunnelsActive: tunnels.filter((s) => s.status === 'active').length,
        /* 대상 경계를 넘은 통로만 돌파 증빙으로 인정한다(자기 VPS/자체 서버에서 연 것은 해당하지 않는다) */
        tunnelsLegit: tunnels.filter((s) => s.legit === true).length,
        tunnelsSelfOnly: tunnels.filter((s) => s.legit === false).length,
        credentials: creds ? creds.n : 0,
        access: access ? access.n : 0,
      },
    }
  }

  /**
   * 실측 연결성(host 평면 전용: 에이전트는 샌드박스에서 돌기 때문에 여기서만 직접 연결을 시작할 수 있다).
   * WebShell 은 인자 없는 GET 을 한 번 보내고, 터널은 TCP 연결을 한 번 수행한다.
   * 결과는 status / last_check / latency_ms / check_note 에 기록한다.
   */
  async probeSessions(id, options = {}) {
    const timeout = Math.min(Math.max(Number(options.timeoutMs) || 6000, 1000), 20000)
    const out = { webshells: [], tunnels: [], checkedAt: nowIso() }

    for (const s of this.listWebshells(id, { limit: 500 })) {
      const started = Date.now()
      let status = 'offline'
      let note = ''
      try {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), timeout)
        const res = await fetch(s.url, { method: 'GET', redirect: 'manual', signal: controller.signal })
        clearTimeout(timer)
        status = res.status < 500 ? 'online' : 'offline'
        note = `HTTP ${res.status}`
      } catch (error) {
        note = error && error.name === 'AbortError' ? `timeout >${timeout}ms` : String((error && error.message) || error).slice(0, 160)
      }
      const latency = Date.now() - started
      try {
        this.updateWebshell(id, s.id, { status, last_check: nowIso(), latency_ms: latency, check_note: note })
      } catch { /* ignore */ }
      out.webshells.push({ id: s.id, url: s.url, status, note, latency_ms: latency })
    }

    for (const t of this.listTunnels(id, { limit: 500 })) {
      const target = String(t.listen || '').replace(/^socks5:\/\//, '').replace(/^https?:\/\//, '')
      const started = Date.now()
      let status = 'down'
      let note = ''
      if (target === '') {
        note = "No listen address; cannot probe"
      } else {
        const idx = target.lastIndexOf(':')
        const host = idx > 0 ? target.slice(0, idx) : '127.0.0.1'
        const port = Number(idx > 0 ? target.slice(idx + 1) : target)
        if (!Number.isFinite(port) || port <= 0) {
          note = `Cannot parse port: ${t.listen}`
        } else {
          note = await new Promise((resolve) => {
            let done = false
            const socket = tcpConnect({ host, port })
            const finish = (ok, text) => {
              if (done) return
              done = true
              try { socket.destroy() } catch { /* ignore */ }
              resolve(ok ? '' : text)
            }
            socket.setTimeout(timeout)
            socket.on('connect', () => { status = 'active'; finish(true, '') })
            socket.on('timeout', () => { finish(false, `timeout >${timeout}ms`) })
            socket.on('error', (error) => { finish(false, String((error && error.code) || (error && error.message) || error).slice(0, 120)) })
          })
        }
      }
      const latency = Date.now() - started
      try {
        this.updateTunnel(id, t.id, { status, last_check: nowIso(), latency_ms: latency, check_note: note })
      } catch { /* ignore */ }
      out.tunnels.push({ id: t.id, kind: t.kind, listen: t.listen, status, note, latency_ms: latency })
    }
    return out
  }

  /**
   * 공격 그래프: 자산 토폴로지 위에 취약점과 이미 장악한 자산을 겹쳐 그린다.
   * 노드 종류(kind) 는 segment / asset(meta.vulns 는 심각도별 집계, meta.owned) / vuln(확인 완료) 이다.
   * 간선(relation) 은 contains / exposes / resolves / has_vuln 이다.
   */
  attackGraph(id, f = {}) {
    const base = this.graph(id, f)
    const db = this.db(id)
    const nodes = base.nodes.slice()
    const edges = base.edges.slice()
    const byId = new Map(nodes.map((n) => [n.id, n]))

    const vulnRows = db.prepare(`SELECT asset_id, severity, COUNT(*) AS n FROM vuln
      WHERE asset_id IS NOT NULL GROUP BY asset_id, severity`).all()
    for (const row of vulnRows) {
      const node = byId.get(`asset:${row.asset_id}`)
      if (node === undefined) continue
      node.meta = node.meta || {}
      node.meta.vulns = node.meta.vulns || {}
      node.meta.vulns[row.severity] = row.n
    }
    const owned = db.prepare('SELECT DISTINCT asset_id FROM access_session WHERE asset_id IS NOT NULL').all()
    for (const row of owned) {
      const node = byId.get(`asset:${row.asset_id}`)
      if (node !== undefined) { node.meta = node.meta || {}; node.meta.owned = true }
    }
    const confirmed = db.prepare(`SELECT v.id, v.asset_id, v.cve, v.title, v.severity, v.status
      FROM vuln v WHERE v.status IN ('confirmed','exploited') AND v.asset_id IS NOT NULL
      ORDER BY CASE v.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END LIMIT 200`).all()
    for (const v of confirmed) {
      const nodeId = `vuln:${v.id}`
      nodes.push({ id: nodeId, kind: 'vuln', label: v.cve || (v.title || '').slice(0, 18), meta: { severity: v.severity, status: v.status, title: v.title } })
      edges.push({ source: `asset:${v.asset_id}`, target: nodeId, relation: 'has_vuln' })
    }
    return { nodes, edges, summary: this.vulnStats(id) }
  }

  /* ---------- 도메인 차원 / Web 자산 ---------- */

  /**
   * 도메인별 자산 집계: 도메인 → 그 도메인 아래의 자산 목록(도메인이 없는 자산은 "(no domain linked)" 로 분류한다).
   * @param f - `{ cidr? }` 특정 C 대역만 본다(왼쪽 C 대역 선택과 일치시켜 차원이 섞이지 않게 한다).
   */
  domainIndex(id, f = {}) {
    const db = this.db(id)
    const assets = (f.cidr
      ? db.prepare('SELECT id, ip, segment_cidr, state, primary_name FROM asset WHERE segment_cidr = ? ORDER BY ip_int').all(f.cidr)
      : db.prepare('SELECT id, ip, segment_cidr, state, primary_name FROM asset ORDER BY ip_int').all())
    const names = db.prepare('SELECT asset_id, name, kind, provenance FROM asset_name').all()
    const byAsset = new Map()
    for (const n of names) {
      if (!byAsset.has(n.asset_id)) byAsset.set(n.asset_id, [])
      byAsset.get(n.asset_id).push(n)
    }
    const groups = new Map()
    for (const a of assets) {
      const domains = new Set()
      if (a.primary_name) domains.add(a.primary_name)
      for (const n of byAsset.get(a.id) || []) domains.add(n.name)
      if (domains.size === 0) domains.add("(no domain linked)")
      for (const domain of domains) {
        if (!groups.has(domain)) groups.set(domain, [])
        groups.get(domain).push({ id: a.id, ip: a.ip, segment: a.segment_cidr, state: a.state, names: (byAsset.get(a.id) || []).map((n) => n.name) })
      }
    }
    return Array.from(groups.entries())
      .map(([domain, list]) => ({ domain, count: list.length, assets: list }))
      .sort((a, b) => b.count - a.count || a.domain.localeCompare(b.domain))
  }

  /** Web 자산 목록: URL/제목이 있거나 흔한 Web 포트를 가진 자산. */
  listWeb(id, f = {}) {
    const db = this.db(id)
    const rows = db.prepare(`SELECT p.id AS port_id, p.port, p.proto, p.url, p.title, p.banner, p.provenance, p.tool,
        a.id AS asset_id, a.ip, a.segment_cidr, a.primary_name, a.state,
        s.name AS service, s.product, s.version
      FROM port p JOIN asset a ON a.id = p.asset_id
      LEFT JOIN service s ON s.port_id = p.id
      WHERE p.state = 'open' AND (
        p.url IS NOT NULL OR p.title IS NOT NULL
        OR s.name IN ('http', 'https', 'http-proxy', 'ssl/http')
        OR p.port IN (80, 81, 443, 8000, 8001, 8080, 8081, 8082, 8443, 8888, 9090, 7001, 9000, 9443)
      )
      ORDER BY a.ip_int, p.port`).all()
    const filtered = f.cidr ? rows.filter((r) => r.segment_cidr === f.cidr) : rows
    const limited = f.limit ? filtered.slice(0, Number(f.limit)) : filtered
    return { total: filtered.length, items: limited }
  }

  /* ---------- HTTP 증거(Burp / Yakit 으로 재현 가능) ---------- */

  addHttpEvidence(id, e = {}) {
    const db = this.db(id)
    const result = db.prepare(`INSERT INTO http_evidence(vuln_id, asset_id, label, method, url, status, request, response, note, captured_by, captured_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(
      e.vuln_id ?? null, e.asset_id ?? null, e.label ?? null, e.method ?? 'GET', e.url ?? null,
      e.status ?? null, e.request ?? null, e.response ?? null, e.note ?? null,
      e.captured_by ?? null, nowIso(),
    )
    return { id: Number(result.lastInsertRowid) }
  }

  listHttpEvidence(id, f = {}) {
    const db = this.db(id)
    const where = []
    const args = []
    if (f.vuln_id !== undefined && f.vuln_id !== null) { where.push('vuln_id = ?'); args.push(Number(f.vuln_id)) }
    if (f.asset_id !== undefined && f.asset_id !== null) { where.push('asset_id = ?'); args.push(Number(f.asset_id)) }
    const clause = where.length ? 'WHERE ' + where.join(' AND ') : ''
    const limit = Math.min(Number(f.limit) || 100, 500)
    return db.prepare(`SELECT * FROM http_evidence ${clause} ORDER BY id DESC LIMIT ?`).all(...args, limit)
  }

  /* ---------- 공격 체인 ---------- */

  /**
   * 공격 체인의 한 단계를 기록한다. 이 단계에서 점수를 얻었다면 point_code(또는 point_id)를 함께 넘기면 된다:
   * 서버가 score_hit 을 자동으로 하나 남기고 둘을 서로 연결해, "단계는 썼는데 점수 기록을 잊었다/점수는 기록했는데 어떻게 얻었는지 말할 수 없다"를 막는다.
   */
  addChainStep(id, s = {}) {
    const db = this.db(id)
    const next = (db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM attack_step').get() || { n: 1 }).n
    let pointId = s.point_id !== undefined && s.point_id !== null ? Number(s.point_id) : null
    if (pointId === null && s.point_code) {
      const row = db.prepare('SELECT id FROM score_point WHERE code = ?').get(String(s.point_code))
      if (row !== undefined) pointId = row.id
    }
    const seq = s.seq ?? next
    const legacyStage = s.stage ?? 'other'
    /* 이 5개 단계 code 만 공격 체인 페이지에서 버킷으로 나뉜다. 다른 값(폐기된 external/foothold/tunnel/privilege 포함)을
       쓰면 단계가 어디에도 속하지 않으므로, 옛 stage 로 폴백하고 명시적으로 경고한다. */
    let stageWarning = null
    let stageCode
    if (typeof s.stage_code === 'string' && s.stage_code.trim() !== '') {
      const wanted = s.stage_code.trim()
      if (VALID_STAGE_CODES.includes(wanted)) {
        stageCode = wanted
      } else {
        stageCode = LEGACY_STAGE_MAP[legacyStage] ?? 'recon'
        stageWarning = "Invalid stage_code=\"" + wanted + "\" (ignored): only " + VALID_STAGE_CODES.join('/')
          + "; this step falls back to " + stageCode + '.'
      }
    } else {
      stageCode = LEGACY_STAGE_MAP[legacyStage] ?? 'recon'
    }
    const result = db.prepare(`INSERT INTO attack_step(seq, stage, stage_code, title, detail, asset_id, vuln_id, access_id, point_id, evidence_ref, tool, agent, result, recorded_by, recorded_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      seq, legacyStage, stageCode, s.title ?? '', s.detail ?? null,
      s.asset_id ?? null, s.vuln_id ?? null, s.access_id ?? null, pointId, s.evidence_ref ?? null,
      s.tool ?? null, s.agent ?? null, s.result ?? null,
      s.recorded_by ?? null, nowIso(),
    )
    const stepId = Number(result.lastInsertRowid)
    let hit = null
    let scoreHint = null
    /* point_code 가 있고 evidence 도 주어졌다 → 겸사겸사 점수 기록(한 번의 호출로 "동작 + 득점" 완료) */
    if (pointId !== null && typeof s.evidence === 'string' && s.evidence.trim() !== '') {
      try {
        hit = this.addScoreHit(id, {
          point_id: pointId, asset_id: s.asset_id ?? null, vuln_id: s.vuln_id ?? null, step_id: stepId,
          target: s.target ?? null, evidence: s.evidence, note: s.note ?? null, recorded_by: s.recorded_by ?? null,
          /* 직접 등록/자체 생성한 계정은 점수를 주지 않는다(과정만 기록) */
          self_created: s.self_created,
        })
        /* 서비스 단위 상한(계정 유형 / 데이터베이스 권한): 단계는 정상적으로 저장되지만 이 점수는 더 누적되지 않으며,
           이유를 모델에 돌려줘야 한다 —— 아니면 모델은 "계정을 하나 더 뚫었으니 점수도 또 올랐다"고 여긴다. */
        if (hit && hit.warning) scoreHint = hit.warning
      } catch (error) {
        /* 단계는 정상적으로 저장하되 이유를 모델에 돌려준다 —— 조용히 삼키면 "점수를 기록했다"가 실은 빈 껍데기가 된다 */
        scoreHint = "Step saved, but scoring failed: " + (error && error.message ? error.message : String(error))
        }
    } else if (pointId !== null) {
      scoreHint = "point_code was given without evidence, so **nothing was scored** for this call (the step was saved): to score, call redteam_score_hit with evidence describing only the result (target asset + account/privilege/data volume)."
    }
    return { id: stepId, seq: seq, stage_code: stageCode, point_id: pointId, hit: hit, score_hint: scoreHint, stage_hint: stageWarning }
  }

  listChain(id) {
    return this.db(id).prepare(`SELECT s.*, a.ip AS asset_ip, v.title AS vuln_title, v.severity AS vuln_severity, v.cve AS vuln_cve
      FROM attack_step s
      LEFT JOIN asset a ON a.id = s.asset_id
      LEFT JOIN vuln v ON v.id = s.vuln_id
      ORDER BY s.seq, s.id`).all()
  }

  /* ---------- 공격 파일(실제로 동작한 스크립트/POC/EXP 만 수록) ---------- */

  /* ------------------------------------------------------------------ 증거 스크린샷 */
  /** 스크린샷 저장 디렉터리: `<대상 디렉터리>/shots`. attack-files 와 같은 레벨이라 패키지째 복사해 인도하기 편하다. */
  shotsDirOf(id) { return join(this.dirOf(id), 'shots') }

  /**
   * 증거 스크린샷 한 장을 등록한다(이미지를 대상 디렉터리로 복사하고, DB 에는 파일 이름과 메타데이터만 저장).
   *
   * 왜 kind 를 명시적으로 구분해야 하는가:
   *   · `screenshot` —— 현장 스크린샷이며 그대로 검수 자료로 쓸 수 있다;
   *   · `card`       —— 당일 기록으로 생성한 "증거 발췌 카드" 이며, **현장 스크린샷이 아니다**.
   *   둘이 섞이면 검수자가 생성된 카드를 현장 증거로 오인한다 —— 가장 나오면 안 되는 사고이므로,
   *   그래서 DB 에 kind 를 저장하고, 패널과 보고서 모두 이 값을 기준으로 색과 문구를 다르게 표시한다.
   *
   * @param id - 대상 id 값.
   * @param shot - `{ path | data_base64, label, note, kind, point_code, hit_id, asset_id, target, source_ref, captured_at, agent }`
   */
  addShot(id, shot = {}) {
    const db = this.db(id)
    const dir = this.shotsDirOf(id)
    mkdirSync(dir, { recursive: true })
    const kind = shot.kind === 'card' ? 'card' : 'screenshot'
    /* 파일 이름: 명시적으로 주면 그 값을 쓰고(경로 구분자는 제거), 없으면 시간-득점 포인트-순번 순으로 생성 */
    const ext = (() => {
      const src = String(shot.path || '')
      const m = /\.([A-Za-z0-9]{2,5})$/.exec(src)
      return m === null ? 'png' : m[1].toLowerCase()
    })()
    const stamp = String(shot.captured_at || new Date().toISOString()).replace(/[-:T]/g, '').slice(0, 14)
    const slug = String(shot.point_code || 'shot').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24) || 'shot'
    let file = String(shot.file || '').trim().replace(/[/\\]/g, '-')
    if (file === '') {
      let n = 1
      do { file = stamp + '-' + slug + '-' + String(n).padStart(2, '0') + '.' + ext; n += 1 }
      while (existsSync(join(dir, file)))
    }
    const dest = assertPathWithin(join(dir, file), [dir])
    let buf = null
    if (typeof shot.data_base64 === 'string' && shot.data_base64.trim() !== '') {
      buf = Buffer.from(shot.data_base64.replace(/^data:[^,]+,/, ''), 'base64')
    } else if (typeof shot.path === 'string' && shot.path.trim() !== '') {
      const src = isAbsolute(shot.path) ? shot.path : join(this.dirOf(id), shot.path)
      if (!existsSync(src)) throw new Error('shot source not found: ' + shot.path)
      buf = readFileSync(src)
    } else {
      throw new Error('shot path or data_base64 required')
    }
    if (buf.length === 0) throw new Error('shot file is empty')
    writeFileSync(dest, buf)
    const mime = /^\x89PNG/.test(buf.slice(0, 4).toString('latin1')) ? 'image/png'
      : (buf.slice(0, 2).toString('latin1') === '\xff\xd8' ? 'image/jpeg'
        : (buf.slice(0, 4).toString('latin1') === 'RIFF' ? 'image/webp' : 'application/octet-stream'))
    const dim = pngSize(buf)
    const pointId = (() => {
      const code = String(shot.point_code || '').trim()
      if (code === '') return shot.point_id === undefined || shot.point_id === null ? null : Number(shot.point_id)
      const row = db.prepare('SELECT id FROM score_point WHERE code = ?').get(code)
      return row === undefined ? null : Number(row.id)
    })()
    const now = nowIso()
    const cur = db.prepare(`INSERT INTO shot (point_id, hit_id, asset_id, vuln_id, target, label, note,
        file, kind, mime, bytes, width, height, sha256, source_ref, captured_at, found_by_agent, agent, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      pointId,
      shot.hit_id === undefined || shot.hit_id === null ? null : Number(shot.hit_id),
      shot.asset_id === undefined || shot.asset_id === null ? null : Number(shot.asset_id),
      shot.vuln_id === undefined || shot.vuln_id === null ? null : Number(shot.vuln_id),
      String(shot.target || '').trim() || null,
      String(shot.label || '').trim() || null,
      String(shot.note || '').trim() || null,
      file, kind, mime, buf.length, dim.width, dim.height,
      createHash('sha256').update(buf).digest('hex'),
      String(shot.source_ref || shot.path || '').trim() || null,
      String(shot.captured_at || now).trim(),
      String(shot.agent || '').trim() || null,
      String(shot.agent || '').trim() || null,
      now,
    )
    return { ok: true, id: Number(cur.lastInsertRowid), file: file, kind: kind, bytes: buf.length, sha256: createHash('sha256').update(buf).digest('hex') }
  }

  /** 증거 스크린샷 목록(득점 포인트 / 히트 / 자산 으로 필터 가능). */
  listShots(id, f = {}) {
    const db = this.db(id)
    const where = []
    const args = []
    if (f.point_code !== undefined && f.point_code !== null && String(f.point_code) !== '') {
      where.push('s.point_id = (SELECT id FROM score_point WHERE code = ?)')
      args.push(String(f.point_code))
    }
    for (const [col, key] of [['hit_id', 'hit_id'], ['asset_id', 'asset_id'], ['vuln_id', 'vuln_id']]) {
      if (f[key] !== undefined && f[key] !== null && String(f[key]) !== '') {
        where.push('s.' + col + ' = ?')
        args.push(Number(f[key]))
      }
    }
    const sql = `SELECT s.*, p.code AS point_code, p.name AS point_name
      FROM shot s LEFT JOIN score_point p ON p.id = s.point_id
      ${where.length > 0 ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY s.captured_at, s.id LIMIT ?`
    const items = db.prepare(sql).all(...args, Math.min(Number(f.limit) || 500, 2000))
    return { ok: true, items: items.map((x) => Object.assign({}, x, { url: this.shotUrlOf(id, x) })), total: items.length }
  }

  /** 스크린샷의 접근 가능한 참조: 패널과 보고서에 넣는 값이 바로 이것이다(대상 디렉터리 기준 상대 경로). */
  shotUrlOf(id, shot) { return 'shots/' + shot.file }

  /** 스크린샷 한 장을 삭제한다(디스크 파일 포함). */
  deleteShot(id, shotId) {
    const db = this.db(id)
    const row = db.prepare('SELECT * FROM shot WHERE id = ?').get(Number(shotId))
    if (row === undefined) throw new Error('shot not found: ' + shotId)
    try {
      const p = assertPathWithin(join(this.shotsDirOf(id), row.file), [this.shotsDirOf(id)])
      if (existsSync(p)) rmSync(p, { force: true })
    } catch { /* 파일이 없으면 이미 삭제된 것으로 본다 */ }
    db.prepare('DELETE FROM shot WHERE id = ?').run(Number(shotId))
    return { ok: true, id: Number(shotId) }
  }

  /**
   * 스크린샷 한 장의 바이트를 읽는다(패널에서는 `<img src="data:...">` 로 표시).
   * base64 로 처리하고 별도 정적 라우트를 열지 않는다: 이 HTTP 브리지에는 이미 동일 출처 검증이 걸려 있고,
   * 파일 이름으로 임의 경로를 읽는 정적 진입점을 하나 더 열면, 검증을 우회해 대상 디렉터리를 읽는 셈이 된다.
   */
  readShot(id, shotId) {
    const db = this.db(id)
    const row = db.prepare('SELECT * FROM shot WHERE id = ?').get(Number(shotId))
    if (row === undefined) throw new Error('shot not found: ' + shotId)
    const p = assertPathWithin(join(this.shotsDirOf(id), row.file), [this.shotsDirOf(id)])
    if (!existsSync(p)) throw new Error('shot file missing on disk: ' + row.file)
    const buf = readFileSync(p)
    return { ok: true, id: Number(row.id), mime: row.mime || 'image/png', bytes: buf.length, base64: buf.toString('base64') }
  }

  /**
   * 여러 득점 항목에 "대표 스크린샷" 을 붙인다. **득점 포인트마다 최대 3 장**(터미널 권한 같은 배치 득점 포인트는 히트가 수십 개라,
   * 건마다 이미지를 붙이면 정보량은 없는데 페이지와 보고서만 터진다).
   *
   * 선택 우선순위: 히트 레벨 > 득점 포인트+대상 레벨 > 득점 포인트 레벨; 같은 우선순위 안에서는 현장 스크린샷이 생성된 증거 카드보다 앞선다.
   *
   * @param id - 대상 id 값.
   * @param groups - `[{ point_id, point_code, hit_ids: number[], asset_id, target }]`
   * @param limit - 득점 포인트마다 최대 장수(기본값 3).
   */
  #representativeShots(id, groups, limit = 3) {
    const db = this.db(id)
    let all = []
    try { all = db.prepare('SELECT * FROM shot ORDER BY captured_at, id').all() } catch { all = [] }
    if (all.length === 0) return new Map()
    const byHit = new Map()
    const byPoint = new Map()
    for (const sh of all) {
      if (sh.hit_id !== null && sh.hit_id !== undefined) {
        if (!byHit.has(Number(sh.hit_id))) byHit.set(Number(sh.hit_id), [])
        byHit.get(Number(sh.hit_id)).push(sh)
      }
      if (sh.point_id !== null && sh.point_id !== undefined) {
        if (!byPoint.has(Number(sh.point_id))) byPoint.set(Number(sh.point_id), [])
        byPoint.get(Number(sh.point_id)).push(sh)
      }
    }
    const rank = (sh) => (sh.kind === 'card' ? 1 : 0)
    const out = new Map()
    for (const g of groups) {
      /* 후보 풀을 "연관 강도" 로 계층화한다: 히트 레벨 → 대상/자산 레벨 → 득점 포인트 레벨.
         같은 계층 안에서는 **현장 스크린샷이 생성된 증거 카드보다 우선**이고, 그다음이 시간순이다 —— 그러지 않으면 배치 득점 포인트에서
         나중에 추가된 카드가 진짜 스크린샷을 상위 3 장에서 밀어낸다(실측: 터미널 60 대에서 카드 3 장만 뽑혔다). */
      const pool = []
      for (const hid of (g.hit_ids || [])) pool.push(...(byHit.get(Number(hid)) || []))
      const pointShots = byPoint.get(Number(g.point_id)) || []
      for (const sh of pointShots) {
        if (g.target && sh.target && String(sh.target) === String(g.target)) pool.push(sh)
        else if (g.asset_id !== null && g.asset_id !== undefined && sh.asset_id === g.asset_id) pool.push(sh)
      }
      for (const sh of pointShots) pool.push(sh)
      const picked = []
      const seen = new Set()
      const ordered = pool.slice().sort((a, b) => rank(a) - rank(b)
        || String(a.captured_at || '').localeCompare(String(b.captured_at || ''))
        || Number(a.id) - Number(b.id))
      for (const sh of ordered) {
        if (sh === undefined || sh === null || seen.has(sh.id)) continue
        seen.add(sh.id)
        picked.push(sh)
        if (picked.length >= limit) break
      }
      out.set(Number(g.point_id), picked)
    }
    return out
  }

  /** 공격 파일 루트 디렉터리: <대상>/attack-files/<타깃>/… */
  attackFilesDirOf(id) { return join(this.dirOf(id), 'attack-files') }

  /**
   * 공격 파일 하나를 "타깃 폴더" 에 저장하고 등록한다. evidence 는 필수 —— 실제로 동작한 것만 수록한다.
   * @param id - 대상 id 값.
   * @param f - `{ target, name, kind, content|path, description, evidence, asset_id?, vuln_id?, created_by? }`
   */
  addAttackFile(id, f = {}) {
    const db = this.db(id)
    const target = String(f.target || '').trim()
    if (target === '') throw new Error("attack file target required (IP / URL / CIDR)")
    const name = String(f.name || '').trim().replace(/[/\\]/g, '-')
    if (name === '') throw new Error('attack file name required')
    const evidence = String(f.evidence || '').trim()
    if (evidence === '') throw new Error("attack file evidence required: only scripts/POC/EXP that actually worked are kept; describe the verified effect")
    const slug = slugTarget(target)
    const dir = join(this.attackFilesDirOf(id), slug)
    mkdirSync(dir, { recursive: true })
    /* target 이 `..`/`.` 이면 slugTarget 이 그대로 돌려주므로, join 이후 attack-files/ 밖으로 나간다.
       쓰기 경로도 루트 디렉터리 검증을 한 번 거쳐서, 파일이 반드시 이 대상 디렉터리 안에 남도록 보장한다. */
    const filePath = assertPathWithin(join(dir, name), [this.attackFilesDirOf(id)])
    if (typeof f.content === 'string' && f.content.length > 0) {
      writeFileSync(filePath, f.content, 'utf8')
    } else if (typeof f.path === 'string' && f.path.length > 0) {
      const src = isAbsolute(f.path) ? f.path : join(this.dirOf(id), f.path)
      if (!existsSync(src)) throw new Error('source path not found: ' + f.path)
      copyFileSync(src, filePath)
    } else {
      throw new Error('attack file content or path required')
    }
    const kind = ['poc', 'exp', 'script', 'wordlist', 'other'].includes(f.kind) ? f.kind : 'script'
    db.prepare(`INSERT INTO attack_file(target, target_kind, name, kind, path, description, evidence, asset_id, vuln_id, created_by, created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(target, name) DO UPDATE SET
        kind = excluded.kind, path = excluded.path, description = excluded.description,
        evidence = excluded.evidence, created_at = excluded.created_at`).run(
      target, f.target_kind ?? null, name, kind, filePath,
      f.description ?? null, evidence, f.asset_id ?? null, f.vuln_id ?? null,
      f.created_by ?? null, nowIso(),
    )
    return { target, name, kind, path: filePath }
  }

  listAttackFiles(id, f = {}) {
    const db = this.db(id)
    const where = []
    const args = []
    if (f.target) { where.push('target = ?'); args.push(f.target) }
    if (f.kind) { where.push('kind = ?'); args.push(f.kind) }
    const clause = where.length ? 'WHERE ' + where.join(' AND ') : ''
    return db.prepare(`SELECT * FROM attack_file ${clause} ORDER BY target, name`).all(...args)
  }

  /** 공격 파일을 타깃별로 그룹화한다(IP / URL / C 대역 마다 폴더 하나). */
  attackFileTree(id) {
    const groups = new Map()
    for (const row of this.listAttackFiles(id, {})) {
      if (!groups.has(row.target)) groups.set(row.target, { target: row.target, folder: slugTarget(row.target), count: 0, files: [] })
      const g = groups.get(row.target)
      g.files.push(row)
      g.count++
    }
    return Array.from(groups.values()).sort((a, b) => b.count - a.count || a.target.localeCompare(b.target))
  }

  readAttackFile(id, fileId) {
    const row = this.db(id).prepare('SELECT * FROM attack_file WHERE id = ?').get(Number(fileId))
    if (row === undefined) return undefined
    let content = ''
    try {
      /* path 는 DB 컬럼에서 온다(에이전트가 기록). 반드시 이 대상 디렉터리 안으로 제한해야 하며, 그러지 않으면 패널이 임의 파일 읽기 도구가 된다 */
      const safe = assertPathWithin(row.path, [this.dirOf(id)])
      content = readFileSync(safe, 'utf8')
    } catch (error) {
      content = "(rejected or read failed: " + (error && error.message ? error.message : String(error)) + ')'
    }
    return { ...row, content }
  }

  /* ---------- 지식 베이스: 범용 POC / EXP (전역 공유, 대상 간 재사용) ---------- */

  knowledgePath() { return join(this.root, 'knowledge.db') }

  /** 이 호스트의 nuclei 템플릿 디렉터리를 찾는다(템플릿이 설치돼 있어야 있고, 못 찾으면 undefined 를 반환). */
  nucleiTemplatesDir() {
    /* 환경 적응 단계에서 직접 입력했거나 자동 할당된 경로를 우선한다(특히 Windows 는 이 규칙에 의존) */
    try {
      const configured = nucleiTemplatesDirOf(loadPlatformConfig(this.root), this.root)
      if (configured) return configured
    } catch { /* 설정 읽기 실패는 무시하고 기본 탐색을 계속한다 */ }
    const candidates = [
      join(this.root, 'toolkit', 'nuclei-templates'),
      join(homedir(), '.local', 'nuclei-templates'),
      join(homedir(), 'nuclei-templates'),
      '/usr/share/nuclei-templates',
      '/opt/nuclei-templates',
    ]
    return candidates.find((p) => existsSync(p))
  }

  #nucleiIndexPath() { return join(this.pocsDirOf(), '.nuclei-index.json') }

  /**
   * 템플릿 색인(필요할 때 구축 + 디스크 캐시): yaml 13k 개를 하나씩 파싱하면 너무 느려서,
   * path / name / severity / tags 몇 개의 검색 필드만 뽑아 두고, 한 번 구축한 뒤 계속 재사용한다.
   */
  #nucleiIndex(force) {
    const dir = this.nucleiTemplatesDir()
    if (dir === undefined) return { dir: null, items: [] }
    const cachePath = this.#nucleiIndexPath()
    if (force !== true && existsSync(cachePath)) {
      try {
        const cached = JSON.parse(readFileSync(cachePath, 'utf8'))
        /* 디렉터리가 그대로이고 캐시가 7 일을 넘지 않으면 바로 사용 */
        const fresh = cached && cached.dir === dir && Array.isArray(cached.items)
          && (Date.now() - Number(cached.built_at || 0) < 7 * 24 * 3600 * 1000)
        if (fresh) return { dir, items: cached.items, cached: true }
      } catch { /* 캐시가 깨졌으면 다시 구축 */ }
    }
    const items = []
    const walk = (base, rel) => {
      let entries = []
      try { entries = readdirSync(join(base, rel), { withFileTypes: true }) } catch { return }
      for (const e of entries) {
        const next = rel === '' ? e.name : rel + '/' + e.name
        if (e.isDirectory()) { walk(base, next); continue }
        if (!/\.ya?ml$/i.test(e.name)) continue
        let head = ''
        try { head = readFileSync(join(base, next), 'utf8').slice(0, 2000) } catch { continue }
        const pick = (re) => { const m = re.exec(head); return m === null ? '' : String(m[1]).trim().replace(/^["']|["']$/g, '') }
        items.push([
          next,
          pick(/^\s*name:\s*(.+)$/m),
          pick(/^\s*severity:\s*(.+)$/m),
          pick(/^\s*tags:\s*(.+)$/m),
        ])
      }
    }
    walk(dir, '')
    try {
      mkdirSync(this.pocsDirOf(), { recursive: true })
      writeFileSync(cachePath, JSON.stringify({ built_at: Date.now(), dir, items }), 'utf8')
    } catch { /* 캐시 기록에 실패해도 검색에는 영향 없음 */ }
    return { dir, items, cached: false }
  }

  /** 템플릿 라이브러리 개요(화면과 에이전트가 "이미 있는 것부터 확인" 할 때 모두 사용). */
  templateStats() {
    const { dir, items } = this.#nucleiIndex()
    const cve = items.filter((x) => /cve-\d{4}-\d+/i.test(x[0])).length
    return { dir: dir || null, total: items.length, cve }
  }

  /**
   * 이 호스트의 nuclei 템플릿 라이브러리에서 검색한다: CVE 번호는 파일 이름만으로 매칭되고, 컴포넌트/키워드는 name 과 tags 를 추가로 매칭한다.
   * 이것이 "지식 베이스에는 없지만 이 호스트에는 이미 쓸 만한 POC 가 있는" 계층이며, 여기를 먼저 조회하면 인터넷 검색 한 라운드를 아낄 수 있다.
   */
  searchTemplates(q, limit = 40) {
    const { dir, items } = this.#nucleiIndex()
    if (dir === null) return { dir: null, total: 0, items: [] }
    const raw = String(q || '').trim()
    if (raw === '') return { dir, total: items.length, items: [] }
    const needle = raw.toLowerCase()
    const out = []
    for (const [path, name, severity, tags] of items) {
      const hay = (path + ' ' + name + ' ' + tags).toLowerCase()
      if (hay.includes(needle)) out.push({ path, name, severity, tags })
      if (out.length >= limit) break
    }
    return { dir, total: items.length, items: out }
  }


  pocsDirOf() { return join(this.root, 'pocs') }

  /** 전역 지식 베이스를 연다(필요하면 생성). 대상 라이브러리와 분리되어 있고, 여러 대상이 공유한다. */
  kb() {
    if (this.kbHandle) return this.kbHandle
    mkdirSync(this.root, { recursive: true })
    mkdirSync(this.pocsDirOf(), { recursive: true })
    const handle = new DatabaseSync(this.knowledgePath())
    /* 위와 동일: FTS5 가 없으면 poc_fts 를 만들지 않고, POC 검색은 LIKE 로 후퇴한다(searchPocs 참고) */
    handle.exec(HAS_FTS5 ? KNOWLEDGE_DDL + POC_FTS_DDL : KNOWLEDGE_DDL)
    migrateKnowledge(handle)
    this.kbHandle = handle
    return handle
  }

  #reindexPoc(db, pocId) {
    if (!HAS_FTS5) return   /* FTS5 가 없으면 색인 표를 만들지 않는다; POC 검색은 LIKE 로 처리한다(searchPocs 의 폴백 참고) */
    db.prepare('DELETE FROM poc_fts WHERE poc_id = ?').run(String(pocId))
    const p = db.prepare('SELECT * FROM poc WHERE id = ?').get(pocId)
    if (!p) return
    db.prepare('INSERT INTO poc_fts(poc_id, title, cve, component, versions, tags, description, content) VALUES(?,?,?,?,?,?,?,?)')
      .run(String(p.id), p.title, p.cve || '', p.component || '', p.versions || '', p.tags || '', p.description || '', p.content || '')
  }

  /**
   * 범용 POC/EXP 를 DB 에 저장한다. 이름(code)이 같으면 병합해 갱신하므로, "같은 취약점의 새 버전 POC" 가 이전 버전을 덮어쓰기 쉽다.
   * @param p - `{ title, kind, cve, component, versions, severity, language, source, source_url,
   *               description, usage, content|path, verified, verified_note, tags, created_by }`
   */
  savePoc(p = {}) {
    const db = this.kb()
    const title = String(p.title || '').trim()
    if (title === '') throw new Error("poc.title required (state which vulnerability/component this POC is for)")
    const kind = POC_KINDS.includes(p.kind) ? p.kind : (String(p.kind || '').toLowerCase() === 'exp' ? 'exp' : 'poc')
    const source = POC_SOURCES.includes(p.source) ? p.source : 'self'
    /* code 는 디렉터리 이름으로 쓰이므로 반드시 정리해야 한다. `code='../../escaped-poc'` 로 본문을 데이터 루트 디렉터리 밖에 쓸 수 있었던 적이 있다
       (deletePoc 에는 일찍부터 startsWith 방어가 있었지만 쓰기 경로는 빠져 있었다). 여기서는 slugPoc 의 정리 규칙으로 통일한다. */
    const rawCode = String(p.code || '').trim()
    const code = rawCode === '' ? slugPoc(title, p.cve) : rawCode.replace(/[^\w.\u4e00-\u9fa5-]+/g, '-').replace(/^[.-]+/, '')
    if (code === '') throw new Error("poc.code invalid (empty after sanitizing; use letters/digits/CJK characters/hyphens)")
    const dir = assertPathWithin(join(this.pocsDirOf(), code), [this.pocsDirOf()])
    mkdirSync(dir, { recursive: true })

    /* 본문: 전달된 content 를 우선 쓰고, 없으면 path 에서 읽는다; 둘 다 없으면 메타데이터만 등록한다 */
    let content = typeof p.content === 'string' ? p.content : ''
    if (content === '' && typeof p.path === 'string' && p.path.length > 0) {
      const src = isAbsolute(p.path) ? p.path : join(this.pocsDirOf(), p.path)
      if (!existsSync(src)) throw new Error('poc content or existing path required: ' + p.path)
      content = readFileSync(src, 'utf8')
    }
    let filePath = null
    if (content !== '') {
      /* filename 에도 경로 구분자가 있으면 안 된다. 그렇지 않으면 code 디렉터리에서 다시 빠져나갈 수 있다 */
      const filename = String(p.filename || '').trim().replace(/[/\\]/g, '-') || defaultPocFilename(title, kind, p.language)
      filePath = assertPathWithin(join(dir, filename), [this.pocsDirOf()])
      writeFileSync(filePath, content, 'utf8')
    }
    const existing = db.prepare('SELECT * FROM poc WHERE code = ?').get(code)
    const verified = p.verified === undefined || p.verified === null
      ? (existing ? existing.verified : 0)
      : (p.verified ? 1 : 0)
    const now = nowIso()
    /* 분류: 사용자 정의 값을 허용하되, 내장 code 를 제외하면 모두 other 로 분류해 패널에 철자 변형이 잔뜩 생기는 것을 막는다 */
    const rawCategory = String(p.category || (existing ? existing.category : '') || '').trim()
    const category = rawCategory === ''
      ? 'other'
      : (POC_CATEGORIES.some((c) => c.code === rawCategory) ? rawCategory : 'other')
    db.prepare(`INSERT INTO poc(code, title, kind, category, cve, component, versions, severity, language, source, source_url,
        description, usage, content, path, verified, verified_note, hit_count, used_on, tags,
        engagement_id, engagement_name, asset_target, found_by_agent, created_by, created_at, updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(code) DO UPDATE SET
        title = excluded.title, kind = excluded.kind, category = excluded.category,
        cve = COALESCE(excluded.cve, poc.cve),
        component = COALESCE(excluded.component, poc.component), versions = COALESCE(excluded.versions, poc.versions),
        severity = COALESCE(excluded.severity, poc.severity), language = COALESCE(excluded.language, poc.language),
        source = excluded.source, source_url = COALESCE(excluded.source_url, poc.source_url),
        description = COALESCE(excluded.description, poc.description), usage = COALESCE(excluded.usage, poc.usage),
        content = CASE WHEN excluded.content <> '' THEN excluded.content ELSE poc.content END,
        path = COALESCE(excluded.path, poc.path),
        verified = excluded.verified, verified_note = COALESCE(excluded.verified_note, poc.verified_note),
        engagement_id = COALESCE(excluded.engagement_id, poc.engagement_id),
        engagement_name = COALESCE(excluded.engagement_name, poc.engagement_name),
        asset_target = COALESCE(excluded.asset_target, poc.asset_target),
        found_by_agent = COALESCE(excluded.found_by_agent, poc.found_by_agent),
        tags = COALESCE(excluded.tags, poc.tags), updated_at = excluded.updated_at`).run(
      code, title, kind, category, p.cve ?? null, p.component ?? null, p.versions ?? null, p.severity ?? null,
      p.language ?? null, source, p.source_url ?? null, p.description ?? null, p.usage ?? null,
      content, filePath, verified, p.verified_note ?? null,
      existing ? existing.hit_count : 0, existing ? existing.used_on : null, p.tags ?? null,
      p.engagement_id ?? null, p.engagement_name ?? null, p.asset_target ?? null, p.found_by_agent ?? null,
      p.created_by ?? null, existing ? existing.created_at : now, now,
    )
    const row = db.prepare('SELECT * FROM poc WHERE code = ?').get(code)
    this.#reindexPoc(db, row.id)
    return { poc: row, created: existing === undefined, path: filePath }
  }

  /**
   * 지식 베이스 검색: Nday/1day 를 시도하기 전의 첫 단계.
   * @param f - `{ q, cve, component, kind, language, source, verified, tag, limit }`
   */
  searchPocs(f = {}) {
    const db = this.kb()
    const where = []
    const args = []
    const q = String(f.q || f.query || '').trim()
    if (q !== '') {
      /* 전문 검색 우선(제목/번호/컴포넌트/버전/태그/설명/본문), 히트가 없으면 LIKE 부분 문자열 매칭으로 후퇴 */
      const match = q.split(/\s+/).filter(Boolean).map((t) => '"' + t.replace(/"/g, '') + '"').join(' AND ')
      let ids = []
      try {
        ids = db.prepare('SELECT poc_id FROM poc_fts WHERE poc_fts MATCH ? LIMIT 200').all(match).map((r) => Number(r.poc_id))
      } catch { ids = [] }
      if (ids.length === 0) {
        const like = '%' + q + '%'
        ids = db.prepare(`SELECT id FROM poc WHERE title LIKE ? OR cve LIKE ? OR component LIKE ?
          OR versions LIKE ? OR tags LIKE ? OR description LIKE ? OR content LIKE ? LIMIT 200`)
          .all(like, like, like, like, like, like, like).map((r) => r.id)
      }
      if (ids.length === 0) return []
      where.push(`id IN (${ids.map(() => '?').join(',')})`)
      args.push(...ids)
    }
    if (f.cve) { where.push('cve LIKE ?'); args.push('%' + String(f.cve) + '%') }
    if (f.component) { where.push('component LIKE ?'); args.push('%' + String(f.component) + '%') }
    if (f.kind) { where.push('kind = ?'); args.push(String(f.kind)) }
    /* 분류 필터: 한 번에 여러 개를 줄 수 있다(category=rce,tunnel) */
    if (f.category) {
      const list = String(f.category).split(',').map((x) => x.trim()).filter(Boolean)
      if (list.length > 1) { where.push(`COALESCE(NULLIF(category, ''), 'other') IN (${list.map(() => '?').join(',')})`); args.push(...list) }
      else if (list.length === 1) { where.push("COALESCE(NULLIF(category, ''), 'other') = ?"); args.push(list[0]) }
    }
    /* 출처 추적 필터: 이 지식이 어느 대상 / 어느 자산에서 발견되고 검증되었는지 */
    if (f.engagement) {
      where.push('(engagement_id = ? OR engagement_name LIKE ?)')
      args.push(String(f.engagement), '%' + String(f.engagement) + '%')
    }
    if (f.asset_target) { where.push('asset_target LIKE ?'); args.push('%' + String(f.asset_target) + '%') }
    if (f.language) { where.push('language = ?'); args.push(String(f.language)) }
    if (f.source) { where.push('source = ?'); args.push(String(f.source)) }
    if (f.tag) { where.push('tags LIKE ?'); args.push('%' + String(f.tag) + '%') }
    if (f.verified === true || f.verified === 1) where.push('verified = 1')
    const clause = where.length ? 'WHERE ' + where.join(' AND ') : ''
    const limit = Math.min(Number(f.limit) || 200, 1000)
    return db.prepare(`SELECT id, code, title, kind, category, cve, component, versions, severity, language, source, source_url,
        description, usage, path, verified, verified_note, hit_count, used_on, tags,
        engagement_id, engagement_name, asset_target, found_by_agent, created_by, created_at, updated_at,
        LENGTH(COALESCE(content, '')) AS content_bytes,
        CASE WHEN COALESCE(content, '') = '' THEN 0 ELSE 1 END AS has_content
      FROM poc ${clause} ORDER BY verified DESC, hit_count DESC, updated_at DESC, id DESC LIMIT ?`).all(...args, limit)
  }

  /** POC 하나의 전체 내용을 가져온다(에이전트가 바로 쓰기 때문에 본문까지 함께 준다). */
  getPoc(key) {
    const db = this.kb()
    const raw = String(key === undefined || key === null ? '' : key).trim()
    if (raw === '') return undefined
    const numeric = Number(raw)
    const row = Number.isFinite(numeric) && String(numeric) === raw
      ? db.prepare('SELECT * FROM poc WHERE id = ?').get(numeric)
      : db.prepare('SELECT * FROM poc WHERE code = ?').get(raw)
    if (row === undefined) return undefined
    let content = row.content || ''
    if (content === '' && row.path) {
      try {
        /* readAttackFile 과 동일: path 는 DB 컬럼이므로 읽기 전에 pocs/ 안으로 제한한다 */
        content = readFileSync(assertPathWithin(row.path, [this.pocsDirOf()]), 'utf8')
      } catch { content = '' }
    }
    return { ...row, content }
  }

  /** POC 하나를 사용된 것으로 표시한다(이후 재사용 횟수로 정렬해 많이 쓴 것이 앞에 온다). */
  markPocUsed(key, usedOn) {
    const db = this.kb()
    const row = this.getPoc(key)
    if (row === undefined) return { ok: false, error: 'poc not found: ' + key }
    db.prepare('UPDATE poc SET hit_count = COALESCE(hit_count, 0) + 1, used_on = ?, updated_at = ? WHERE id = ?')
      .run(usedOn ?? null, nowIso(), row.id)
    return { ok: true, id: row.id, code: row.code, hit_count: (row.hit_count || 0) + 1 }
  }

  /** 검증 결론을 보충한다: 검증된 POC 만 "바로 사용 가능" 으로 인정되고, 화면에서도 표시된다. */
  updatePoc(key, patch = {}) {
    const db = this.kb()
    const row = this.getPoc(key)
    if (row === undefined) throw new Error('poc not found: ' + key)
    const next = {
      title: patch.title ?? row.title,
      kind: patch.kind ?? row.kind,
      category: patch.category ?? row.category,
      cve: patch.cve ?? row.cve,
      component: patch.component ?? row.component,
      versions: patch.versions ?? row.versions,
      severity: patch.severity ?? row.severity,
      language: patch.language ?? row.language,
      source: patch.source ?? row.source,
      source_url: patch.source_url ?? row.source_url,
      description: patch.description ?? row.description,
      usage: patch.usage ?? row.usage,
      verified: patch.verified === undefined || patch.verified === null ? row.verified : (patch.verified ? 1 : 0),
      verified_note: patch.verified_note ?? row.verified_note,
      tags: patch.tags ?? row.tags,
      engagement_id: patch.engagement_id ?? row.engagement_id,
      engagement_name: patch.engagement_name ?? row.engagement_name,
      asset_target: patch.asset_target ?? row.asset_target,
      found_by_agent: patch.found_by_agent ?? row.found_by_agent,
      content: typeof patch.content === 'string' && patch.content !== '' ? patch.content : row.content,
      path: row.path,
    }
    if (next.content !== row.content) {
      const filename = 'poc.txt'
      const dir = join(this.pocsDirOf(), row.code)
      mkdirSync(dir, { recursive: true })
      next.path = join(dir, row.path ? basename(row.path) : filename)
      writeFileSync(next.path, next.content || '', 'utf8')
    }
    db.prepare(`UPDATE poc SET title = ?, kind = ?, category = ?, cve = ?, component = ?, versions = ?, severity = ?, language = ?,
      source = ?, source_url = ?, description = ?, usage = ?, verified = ?, verified_note = ?, tags = ?,
      engagement_id = ?, engagement_name = ?, asset_target = ?, found_by_agent = ?, content = ?, path = ?, updated_at = ?
      WHERE id = ?`).run(
      next.title, next.kind, next.category, next.cve, next.component, next.versions, next.severity, next.language,
      next.source, next.source_url, next.description, next.usage, next.verified, next.verified_note,
      next.tags, next.engagement_id, next.engagement_name, next.asset_target, next.found_by_agent,
      next.content, next.path, nowIso(), row.id,
    )
    this.#reindexPoc(db, row.id)
    return this.getPoc(row.id)
  }

  deletePoc(key) {
    const db = this.kb()
    const row = this.getPoc(key)
    if (row === undefined) return { ok: false, error: 'poc not found: ' + key }
    db.prepare('DELETE FROM poc WHERE id = ?').run(row.id)
    if (HAS_FTS5) db.prepare('DELETE FROM poc_fts WHERE poc_id = ?').run(String(row.id))
    /* 디스크 디렉터리까지 함께 삭제한다(pocs/ 안에서만 code 로 정확히 삭제하고, 삭제에 실패해도 데이터 일관성에는 영향이 없다) */
    let removedFiles = 0
    try {
      const dir = join(this.pocsDirOf(), row.code)
      if (existsSync(dir) && dir.startsWith(this.pocsDirOf())) {
        removedFiles = readdirSync(dir).length
        rmSync(dir, { recursive: true, force: true })
      }
    } catch { /* 무시 */ }
    return { ok: true, id: row.id, code: row.code, deleted: true, removed_files: removedFiles }
  }

  /** 지식 베이스 개요: 화면 상단 탭과 에이전트가 "먼저 라이브러리 조회" 할 때 쓰는 한 화면 요약. */
  pocStats() {
    const db = this.kb()
    const one = (sql, ...args) => Object.values(db.prepare(sql).get(...args) || {})[0] ?? 0
    const byKind = db.prepare('SELECT COALESCE(kind, ?) AS kind, COUNT(*) AS n FROM poc GROUP BY kind ORDER BY n DESC').all('poc')
    const bySource = db.prepare('SELECT COALESCE(source, ?) AS source, COUNT(*) AS n FROM poc GROUP BY source ORDER BY n DESC').all('self')
    const topComponents = db.prepare(`SELECT component, COUNT(*) AS n FROM poc WHERE component IS NOT NULL AND component <> ''
      GROUP BY component ORDER BY n DESC, component LIMIT 12`).all()
    /* 분류: 패널이 이 값으로 그룹화하고, 에이전트도 "어떤 종류의 공격 도구를 얼마나 모았는지" 알 수 있다.
       순서는 내장 분류 표를 따른다(수량 기준이 아니다). 그래야 패널 그룹이 안정적으로 유지되고 이리저리 튀지 않는다. */
    const catRows = db.prepare("SELECT COALESCE(NULLIF(category, ''), 'other') AS category, COUNT(*) AS n, SUM(verified) AS verified FROM poc GROUP BY category").all()
    const catMap = new Map(catRows.map((r) => [r.category, r]))
    const byCategory = POC_CATEGORIES.map((c) => {
      const row = catMap.get(c.code)
      return { code: c.code, name: c.name, hint: c.hint, n: row ? row.n : 0, verified: row ? (row.verified || 0) : 0 }
    })
    /* 내장 표에 없는 분류(사용자 정의)도 함께 나열해, 그것들이 흔적 없이 사라지지 않게 한다 */
    for (const [code, row] of catMap) {
      if (POC_CATEGORIES.some((c) => c.code === code)) continue
      byCategory.push({ code, name: pocCategoryName(code), hint: '', n: row.n, verified: row.verified || 0 })
    }
    /* 출처 대상: 각 지식이 어느 대상에서 발견/검증되었는지(대상별 카운트 + 최근 생성 시각) */
    const byEngagement = db.prepare(`SELECT COALESCE(NULLIF(engagement_name, ''), NULLIF(engagement_id, ''), '(unattributed engagement)') AS engagement,
        COUNT(*) AS n, MAX(created_at) AS latest FROM poc GROUP BY engagement ORDER BY n DESC, latest DESC LIMIT 30`).all()
    /* 발견 자산: Top 자산 순위(같은 경험 하나가 보통 여러 자산에 걸쳐 나온다) */
    const topAssets = db.prepare(`SELECT asset_target, COUNT(*) AS n FROM poc WHERE COALESCE(asset_target, '') <> ''
      GROUP BY asset_target ORDER BY n DESC, asset_target LIMIT 15`).all()
    return {
      total: one('SELECT COUNT(*) FROM poc'),
      verified: one('SELECT COUNT(*) FROM poc WHERE verified = 1'),
      withContent: one("SELECT COUNT(*) FROM poc WHERE COALESCE(content, '') <> ''"),
      reused: one('SELECT COALESCE(SUM(hit_count), 0) FROM poc'),
      /* 분류가 지정되지 않은 항목 수: 패널에서 "아직 분류되지 않은 항목 N 개" 를 안내한다 */
      uncategorized: one("SELECT COUNT(*) FROM poc WHERE COALESCE(NULLIF(category, ''), 'other') = 'other'"),
      earliest: one('SELECT MIN(created_at) FROM poc'),
      latest: one('SELECT MAX(created_at) FROM poc'),
      byKind, bySource, byCategory, byEngagement, topAssets, topComponents,
      categories: POC_CATEGORIES,
      dbPath: this.knowledgePath(),
    }
  }

  /**
   * 타깃별로 그룹화한 성과 보고서: IP / URL / C 대역 마다 한 부씩, 화면에서 펼치고 접을 수 있다.
   * 수록 기준은 report() 와 동일하다(검증 완료/익스플로잇 완료이면서 중간 위험도 이상).
   */
  reportTargets(id, options = {}) {
    const meta = readMeta(this.metaPathOf(id)) || {}
    const includeAll = options.all === true
    const allVulns = this.listVulns(id, { limit: 2000 }).items
    const severityOrder = { critical: 0, high: 1, medium: 2, low: 3, info: 4 }
    const isResult = (v) => v.status === 'confirmed' || v.status === 'exploited'
    const isReal = (v) => v.severity === 'critical' || v.severity === 'high' || v.severity === 'medium'
    const vulns = (includeAll ? allVulns : allVulns.filter((v) => isResult(v) && isReal(v)))
      .slice().sort((a, b) => (severityOrder[a.severity] ?? 9) - (severityOrder[b.severity] ?? 9))
    const chain = this.listChain(id)
    const creds = this.listCredentials(id, {})
    const access = this.listAccess(id, {})
    const files = this.listAttackFiles(id, {})

    const targets = new Map()
    const ensure = (key) => {
      if (!targets.has(key)) {
        targets.set(key, { key, label: key, kind: /^\d{1,3}(\.\d{1,3}){3}$/.test(key) ? 'ip' : 'host', segment: '', vulns: [], chain: [], access: [], creds: [], files: [] })
      }
      return targets.get(key)
    }
    const assetIpOf = (assetId) => {
      if (assetId === null || assetId === undefined) return undefined
      const asset = this.getAsset(id, assetId)
      return asset === undefined ? undefined : asset.ip
    }
    for (const v of vulns) {
      const key = v.asset_ip || (v.target ? slugTarget(v.target) : "unattributed target")
      const g = ensure(key)
      g.vulns.push(v)
      if (g.segment === '' && v.segment_cidr) g.segment = v.segment_cidr
    }
    for (const a of access) {
      const key = assetIpOf(a.asset_id) || slugTarget(a.host)
      const g = ensure(key)
      g.access.push(a)
      if (g.segment === '') { const asset = a.asset_id === null || a.asset_id === undefined ? undefined : this.getAsset(id, a.asset_id); if (asset && asset.segment_cidr) g.segment = asset.segment_cidr }
    }
    for (const c of creds) ensure(assetIpOf(c.asset_id) || slugTarget(c.host)).creds.push(c)
    for (const f of files) ensure(assetIpOf(f.asset_id) || slugTarget(f.target)).files.push(f)
    for (const st of chain) if (st.asset_ip) ensure(st.asset_ip).chain.push(st)

    const renderVuln = (v) => {
      const out = []
      out.push(`#### [${(v.severity || 'info').toUpperCase()}] ${v.cve ? v.cve + ' — ' : ''}${v.title || ''}`, '')
      out.push(`- Target: ${v.target || '—'}`)
      out.push(`- Status: ${v.status === 'exploited' ? 'exploited' : 'verified'} · confidence: ${v.confidence === null || v.confidence === undefined ? '—' : v.confidence} · discovered via: ${v.source || '—'}`)
      out.push(`- Impact and evidence: ${v.evidence || '—'}`)
      const evidence = this.listHttpEvidence(id, { vuln_id: v.id })
      if (evidence.length) {
        out.push('', "**Replay request (paste directly into Burp Suite / Yakit)**:", '')
        for (const e of evidence) {
          out.push(`*${e.label || e.method + ' ' + (e.url || '')}*`, '')
          if (e.request) out.push('```http', e.request.replace(/\r/g, '').trim(), '```', '')
          if (e.response) out.push("Response summary:", '```http', String(e.response).replace(/\r/g, '').trim().slice(0, 2000), '```', '')
        }
      }
      out.push('')
      return out
    }

    const groups = new Map()
    const list = []
    for (const g of targets.values()) {
      const lines = []
      lines.push(`## ${g.label}${g.segment ? ' (' + g.segment + ')' : ''}`, '')
      const bySeverity = { critical: 0, high: 0, medium: 0 }
      for (const v of g.vulns) bySeverity[v.severity] = (bySeverity[v.severity] || 0) + 1
      lines.push(`- Results: ${g.vulns.length} vuln(s) (critical ${bySeverity.critical} · high ${bySeverity.high} · medium ${bySeverity.medium}) · owned ${g.access.length} · credentials ${g.creds.length} · attack files ${g.files.length}`, '')
      if (g.vulns.length) { lines.push("### Result vulnerabilities", ''); for (const v of g.vulns) lines.push(...renderVuln(v)) }
      if (g.access.length) {
        lines.push("### Obtained privileges", '')
        for (const a of g.access) lines.push(`- ${a.host} · ${a.username || '—'} · ${a.method || '—'} · ${a.privilege || '—'} · ${a.session_ref || ''}`)
        lines.push('')
      }
      if (g.creds.length) {
        lines.push("### Credentials", '')
        for (const c of g.creds) lines.push(`- ${c.host} · ${c.username || '—'} · ${c.secret_type || '—'} · ${c.privilege || '—'} · ${c.secret_ref || ''}`)
        lines.push('')
      }
      if (g.files.length) {
        lines.push("### Attack files", '')
        for (const f of g.files) lines.push(`- \`${f.name}\` (${f.kind}): ${f.description || '—'} | effect: ${f.evidence} | path: ${f.path}`)
        lines.push('')
      }
      if (g.chain.length) {
        lines.push("### Attack chain", '')
        for (const st of g.chain) lines.push(`${st.seq}. [${st.stage}] ${st.title}${st.detail ? ' — ' + st.detail : ''}`)
        lines.push('')
      }
      const entry = {
        key: g.key, label: g.label, kind: g.kind, segment: g.segment || "unattributed",
        stats: { vulns: g.vulns.length, bySeverity, accesses: g.access.length, credentials: g.creds.length, files: g.files.length, chainSteps: g.chain.length },
        markdown: lines.join('\n'),
      }
      list.push(entry)
      const cidr = entry.segment
      if (!groups.has(cidr)) groups.set(cidr, { cidr, targets: [] })
      groups.get(cidr).targets.push(entry)
    }
    const grouped = Array.from(groups.values())
      .map((g) => ({ cidr: g.cidr, targets: g.targets.slice().sort((a, b) => b.stats.vulns - a.stats.vulns || a.label.localeCompare(b.label)) }))
      .sort((a, b) => a.cidr.localeCompare(b.cidr))
    return {
      generated_at: nowIso(),
      engagement: { id, name: meta.target_name || id, scope: meta.scope_cidrs || [] },
      groups: grouped,
      targets: list,
      totals: {
        targets: list.length,
        vulns: vulns.length,
        accesses: access.length,
        credentials: creds.length,
        files: files.length,
        filteredOut: allVulns.length - vulns.length,
      },
    }
  }

  /* ---------- 보고서 ---------- */

  /**
   * Markdown 성과 보고서를 생성한다.
   *
   * "성과 취약점" 만 인도한다: 상태가 confirmed / exploited 이고 심각도가 critical / high / medium 인 것.
   * 검증 대기(candidate), 오탐(false-positive), 낮은 위험도와 정보성(low/info)은 보고서에 넣지 않는다 ——
   * 이들은 과정 노이즈(물량 채우기용 취약점)이다. 정보 수집 단계의 자산 목록도 보고서에 넣지 않는다(자산 매핑 페이지에서 본다).
   * 보고서에 남기는 것: 성과 취약점(Burp/Yakit 에 붙여넣을 수 있는 원본 요청 포함), 공격 체인(내부 네트워크 돌파 성과),
   * 획득한 권한과 자격 증명, 수정 권고.
   *
   * @param id - 대상 id 값.
   * @param options - `{ all: true }` 이면 모든 취약점을 출력한다(자체 점검용이며 인도물은 만들지 않는다).
   */
  report(id, options = {}) {
    const meta = readMeta(this.metaPathOf(id)) || {}
    const includeAll = options.all === true
    const chain = this.listChain(id)
    const creds = this.listCredentials(id, {})
    const access = this.listAccess(id, {})
    const allVulns = this.listVulns(id, { limit: 2000 }).items
    const severityOrder = { critical: 0, high: 1, medium: 2, low: 3, info: 4 }
    const isResult = (v) => v.status === 'confirmed' || v.status === 'exploited'
    const isReal = (v) => v.severity === 'critical' || v.severity === 'high' || v.severity === 'medium'
    const vulns = (includeAll ? allVulns : allVulns.filter((v) => isResult(v) && isReal(v)))
      .slice()
      .sort((a, b) => (severityOrder[a.severity] ?? 9) - (severityOrder[b.severity] ?? 9))
    const filteredOut = allVulns.length - vulns.length

    const lines = []
    const push = (...xs) => lines.push(...xs)
    const bySeverity = { critical: 0, high: 0, medium: 0, low: 0, info: 0 }
    for (const v of vulns) bySeverity[v.severity] = (bySeverity[v.severity] || 0) + 1
    const exploited = vulns.filter((v) => v.status === 'exploited').length

    push(`# Red-team exercise results report — ${meta.target_name || id}`, '')
    push(`- Generated: ${nowIso()}`)
    push(`- Authorized scope: ${(meta.scope_cidrs || []).join(', ') || '(not recorded)'}`)
    push(`- Overview: ${vulns.length} result vuln(s) (critical ${bySeverity.critical} · high ${bySeverity.high} · medium ${bySeverity.medium}) · ${exploited} successfully exploited · ${access.length} assets controlled · ${creds.length} credentials obtained`)
    push('')

    push("## 1. Result vulnerabilities", '')
    if (!vulns.length) {
      push("No deliverable result vulnerabilities in this exercise (only verified/exploited vulns of medium severity or higher are included).", '')
    } else {
      for (const v of vulns) {
        push(`### [${(v.severity || 'info').toUpperCase()}] ${v.cve ? v.cve + ' — ' : ''}${v.title || ''}`, '')
        push(`- Target: ${v.target || '—'}`)
        push(`- Asset: ${v.asset_ip || '—'} (${v.segment_cidr || '—'})`)
        push(`- Status: ${v.status === 'exploited' ? 'exploited' : 'verified'} · confidence: ${v.confidence === null || v.confidence === undefined ? '—' : v.confidence} · discovered via: ${v.source || '—'}`)
        push(`- Impact and evidence: ${v.evidence || '—'}`)
        const evidence = this.listHttpEvidence(id, { vuln_id: v.id })
        if (evidence.length) {
          push('', "**Replay request (paste directly into Burp Suite / Yakit)**:", '')
          for (const e of evidence) {
            push(`*${e.label || e.method + ' ' + (e.url || '')}*`, '')
            if (e.request) push('```http', e.request.replace(/\r/g, '').trim(), '```', '')
            if (e.response) push("Response summary:", '```http', String(e.response).replace(/\r/g, '').trim().slice(0, 2000), '```', '')
          }
        }
        push('')
      }
    }

    push("## 2. Attack chain", '')
    if (chain.length) {
      for (const s of chain) {
        push(`${s.seq}. **[${s.stage}] ${s.title}**`)
        if (s.asset_ip) push(`   - Asset: ${s.asset_ip}`)
        if (s.vuln_title || s.vuln_cve) push(`   - Vulnerability: ${s.vuln_cve ? s.vuln_cve + ' ' : ''}${s.vuln_title || ''}`)
        if (s.detail) push(`   - Notes: ${s.detail}`)
        if (s.evidence_ref) push(`   - Evidence: ${s.evidence_ref}`)
      }
    } else push("(no attack-chain steps recorded)")
    push('')

    push("## 3. Obtained privileges and credentials", '')
    if (access.length) {
      push("| Host | Account | Method | Privilege | Evidence |", '| --- | --- | --- | --- | --- |')
      for (const a of access) push(`| ${a.host} | ${a.username || '—'} | ${a.method || '—'} | ${a.privilege || '—'} | ${a.session_ref || '—'} |`)
    } else push("(no usable access obtained)")
    push('')
    if (creds.length) {
      push("| Host | Account | Type | Privilege | Reference |", '| --- | --- | --- | --- | --- |')
      for (const c of creds) push(`| ${c.host} | ${c.username || '—'} | ${c.secret_type || '—'} | ${c.privilege || '—'} | ${c.secret_ref || '—'} |`)
    } else push("(no credentials obtained)")
    push('')

    push("## 4. Remediation advice", '')
    const advice = []
    if (vulns.some((v) => v.cve)) advice.push("1. Patch the affected components by the CVE IDs above first; establish a component version baseline and bring it under patch management.")
    if (access.some((a) => a.method === 'webshell' || a.method === 'rce' || a.method === 'upload')) advice.push("2. Tighten file upload and command execution: no execution in upload directories, allowlist validation, run web processes with least privilege.")
    if (access.some((a) => a.method === 'vnc' || a.method === 'rdp' || a.method === 'ssh')) advice.push("3. Reduce remote-management exposure (do not expose VNC/RDP/SSH to the internet); enforce strong passwords and MFA.")
    if (creds.some((c) => c.secret_type === 'connection-string')) advice.push("4. Do not leak database connection strings through APIs/config; centralize secrets in key management and authenticate APIs.")
    advice.push(`${advice.length + 1}. Add unified authentication and access-control checks to the APIs covered here; maintain an API asset inventory and automated regression tests.`)
    push(...advice, '')

    if (filteredOut > 0 && !includeAll) {
      push(`> This report only includes verified/exploited result vulnerabilities of medium severity or higher; ${filteredOut} pending, false-positive, low, or info-level records are not included (see the Vuln results page).`)
      push('')
    }

    return {
      markdown: lines.join('\n'),
      generated_at: nowIso(),
      stats: {
        results: vulns.length,
        bySeverity,
        exploited,
        filteredOut,
        accesses: access.length,
        credentials: creds.length,
        chainSteps: chain.length,
      },
    }
  }

  /* ---------- 기록 원시 연산 ---------- */
  #upsertSegment(db, seg) {
    db.prepare(`INSERT INTO segment(cidr, ip_start, ip_end, org, asn, country, city, source, first_seen, last_seen)
      VALUES(?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(cidr) DO UPDATE SET
        org = COALESCE(excluded.org, segment.org),
        asn = COALESCE(excluded.asn, segment.asn),
        country = COALESCE(excluded.country, segment.country),
        city = COALESCE(excluded.city, segment.city),
        last_seen = excluded.last_seen`).run(
      seg.cidr, seg.ip_start ?? null, seg.ip_end ?? null, seg.org ?? null, seg.asn ?? null,
      seg.country ?? null, seg.city ?? null, seg.source ?? null, seg.first_seen ?? nowIso(), nowIso(),
    )
  }

  #upsertAsset(db, a) {
    const cidr = a.segment_cidr || cidrOf(a.ip)
    this.#upsertSegment(db, { cidr, source: a.provenance, first_seen: a.first_seen })
    const t = nowIso()
    /* discovered_at = 이 라이브러리가 이 자산을 처음 본 시각; 중복 수집에서는 last_seen 만 갱신하고,
       discovered_at 은 건드리지 않는다(그러지 않으면 "발견 시각" 이 "마지막 수집 시각" 이 되어 기록하지 않은 것과 같아진다). */
    db.prepare(`INSERT INTO asset(segment_cidr, ip, ip_int, state, primary_name, confidence, first_seen, last_seen, discovered_at, scope)
      VALUES(?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(segment_cidr, ip) DO UPDATE SET
        state = COALESCE(excluded.state, asset.state),
        primary_name = COALESCE(excluded.primary_name, asset.primary_name),
        scope = COALESCE(NULLIF(asset.scope, ''), excluded.scope),
        discovered_at = COALESCE(NULLIF(asset.discovered_at, ''), excluded.discovered_at),
        last_seen = excluded.last_seen`).run(
      cidr, a.ip, ipToInt(a.ip), a.state ?? 'unknown', a.primary_name ?? null, a.confidence ?? null,
      a.first_seen ?? t, t, a.discovered_at ?? t, a.scope || scopeOfIp(a.ip),
    )
    return db.prepare('SELECT id FROM asset WHERE segment_cidr = ? AND ip = ?').get(cidr, a.ip).id
  }

  #observe(db, entityKind, entityId, attr, value, provenance, tool, rawRef) {
    db.prepare(`INSERT INTO observation(entity_kind, entity_id, attr, value, provenance, tool, collected_at, raw_ref)
      VALUES(?,?,?,?,?,?,?,?)`).run(
      entityKind, entityId, attr ?? null, value == null ? null : String(value),
      provenance ?? 'unknown', tool ?? null, nowIso(), rawRef ?? null,
    )
  }

  #edge(db, srcKind, srcId, dstKind, dstId, relation, confidence) {
    db.prepare(`INSERT INTO edge(src_kind, src_id, dst_kind, dst_id, relation, confidence, first_seen, last_seen)
      VALUES(?,?,?,?,?,?,?,?)
      ON CONFLICT(src_kind, src_id, dst_kind, dst_id, relation) DO UPDATE SET last_seen = excluded.last_seen`).run(
      srcKind, String(srcId), dstKind, String(dstId), relation, confidence ?? null, nowIso(), nowIso(),
    )
  }

  /** 자산 하나의 전문 검색 색인 행을 재구성한다(목록, 그래프, 이후 에이전트가 색인 한 벌을 공유한다). */
  #reindex(db, assetId) {
    const a = db.prepare('SELECT * FROM asset WHERE id = ?').get(assetId)
    if (!a) return
    /* FTS5 가 없으면 색인 표를 만들지 않으므로 여기서는 바로 건너뛴다 —— 검색은 listAssets 의 LIKE 분기를 타므로
       위의 값 추출 구간도 헛수고할 필요가 없다. */
    if (!HAS_FTS5) return
    const names = db.prepare('SELECT name FROM asset_name WHERE asset_id = ?').all(assetId).map((r) => r.name).join(' ')
    const banners = db.prepare('SELECT banner FROM port WHERE asset_id = ? AND banner IS NOT NULL').all(assetId).map((r) => r.banner).join(' ')
    const titles = db.prepare('SELECT title FROM port WHERE asset_id = ? AND title IS NOT NULL').all(assetId).map((r) => r.title).join(' ')
      + ' ' + db.prepare('SELECT url FROM port WHERE asset_id = ? AND url IS NOT NULL').all(assetId).map((r) => r.url).join(' ')
      + ' ' + db.prepare(`SELECT s.product, s.name, s.version FROM service s JOIN port p ON p.id = s.port_id WHERE p.asset_id = ?`)
        .all(assetId).map((r) => [r.name, r.product, r.version].filter(Boolean).join(' ')).join(' ')
    const fps = db.prepare('SELECT vendor, product, version, category FROM fingerprint WHERE asset_id = ?')
      .all(assetId).map((r) => [r.category, r.vendor, r.product, r.version].filter(Boolean).join(' ')).join(' ')
    db.prepare('DELETE FROM asset_fts WHERE asset_id = ?').run(String(assetId))
    db.prepare('INSERT INTO asset_fts(asset_id, ip, names, banners, titles, fingerprints) VALUES(?,?,?,?,?,?)')
      .run(String(assetId), a.ip, names, banners, titles, fps)
  }

  /**
   * 수집 결과를 DB 에 저장한다(정보 수집 에이전트와 외부 도구의 통합 ingest 형식).
   * bundle = { scan:{tool,argv,agent_session_id}, segments:[], assets:[], edges:[] }
   * asset  = { ip, state, primary_name, provenance, tool, names:[{name,kind}],
   *            ports:[{port,proto,service,product,version,banner,provenance,tool,
   *                    fingerprints:[{category,vendor,product,version,evidence}]}] }
   */
  importBundle(id, bundle = {}) {
    const db = this.db(id)
    const counts = { segments: 0, assets: 0, ports: 0, services: 0, fingerprints: 0, names: 0, edges: 0 }
    let runId = null
    if (bundle.scan) {
      const r = db.prepare(`INSERT INTO scan_run(agent_session_id, tool, argv, started_at, status)
        VALUES(?,?,?,?,'completed')`).run(
        bundle.scan.agent_session_id ?? null, bundle.scan.tool ?? null,
        bundle.scan.argv ? JSON.stringify(bundle.scan.argv) : null, nowIso(),
      )
      runId = Number(r.lastInsertRowid)
    }
    db.exec('BEGIN')
    try {
      for (const seg of bundle.segments || []) { this.#upsertSegment(db, seg); counts.segments++ }
      for (const a of bundle.assets || []) {
        const provenance = a.provenance || 'active'
        const tool = a.tool || (bundle.scan && bundle.scan.tool) || null
        const assetId = this.#upsertAsset(db, Object.assign({}, a, { provenance }))
        counts.assets++
        for (const n of a.names || []) {
          db.prepare(`INSERT INTO asset_name(asset_id, name, kind, provenance, tool, first_seen, last_seen)
            VALUES(?,?,?,?,?,?,?) ON CONFLICT(asset_id, name, kind) DO UPDATE SET last_seen = excluded.last_seen`)
            .run(assetId, n.name, n.kind ?? 'domain', n.provenance ?? provenance, tool, nowIso(), nowIso())
          counts.names++
          this.#observe(db, 'asset', assetId, 'name', n.name, n.provenance ?? provenance, tool, runId)
          this.#edge(db, 'domain', n.name, 'asset', assetId, 'resolves')
        }
        if (a.primary_name) this.#observe(db, 'asset', assetId, 'primary_name', a.primary_name, provenance, tool, runId)
        for (const p of a.ports || []) {
          const pProv = p.provenance || provenance
          db.prepare(`INSERT INTO port(asset_id, proto, port, state, provenance, tool, banner, url, title, first_seen, last_seen)
            VALUES(?,?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT(asset_id, proto, port) DO UPDATE SET
              state = excluded.state,
              banner = COALESCE(excluded.banner, port.banner),
              url = COALESCE(excluded.url, port.url),
              title = COALESCE(excluded.title, port.title),
              last_seen = excluded.last_seen`)
            .run(assetId, p.proto ?? 'tcp', Number(p.port), p.state ?? 'open', pProv, p.tool ?? tool,
              p.banner ?? null, p.url ?? null, p.title ?? null, nowIso(), nowIso())
          const portId = db.prepare('SELECT id FROM port WHERE asset_id = ? AND proto = ? AND port = ?')
            .get(assetId, p.proto ?? 'tcp', Number(p.port)).id
          counts.ports++
          this.#observe(db, 'port', portId, 'open', `${p.port}/${p.proto ?? 'tcp'}`, pProv, p.tool ?? tool, runId)
          if (p.service || p.product || p.version) {
            db.prepare(`INSERT INTO service(port_id, name, product, version, cpe, provenance, tool, first_seen, last_seen)
              VALUES(?,?,?,?,?,?,?,?,?)`).run(
              portId, p.service ?? null, p.product ?? null, p.version ?? null, p.cpe ?? null,
              pProv, p.tool ?? tool, nowIso(), nowIso(),
            )
            counts.services++
            this.#observe(db, 'port', portId, 'service', [p.service, p.product, p.version].filter(Boolean).join(' '), pProv, p.tool ?? tool, runId)
          }
          for (const fp of p.fingerprints || []) {
            db.prepare(`INSERT INTO fingerprint(asset_id, port_id, category, vendor, product, version, evidence, confidence, provenance, tool, first_seen, last_seen)
              VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(
              assetId, portId, fp.category ?? null, fp.vendor ?? null, fp.product ?? null, fp.version ?? null,
              fp.evidence ?? null, fp.confidence ?? null, fp.provenance ?? pProv, fp.tool ?? tool, nowIso(), nowIso(),
            )
            counts.fingerprints++
            this.#observe(db, 'asset', assetId, 'fingerprint',
              [fp.category, fp.vendor, fp.product, fp.version].filter(Boolean).join(' '),
              fp.provenance ?? pProv, fp.tool ?? tool, runId)
          }
        }
        this.#reindex(db, assetId)
      }
      for (const e of bundle.edges || []) {
        this.#edge(db, e.src_kind, e.src_id, e.dst_kind, e.dst_id, e.relation, e.confidence)
        counts.edges++
      }
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
    return { scan_run_id: runId, counts, stats: this.stats(id) }
  }

  /* ---------- 프롬프트 ---------- */

  /** 기본 프롬프트 지문 목록(이 대상에 마지막으로 기본값이 기록되었을 때의 내용 지문을 저장한다). */
  promptManifestPathOf(id) { return join(this.promptsDirOf(id), '.defaults.json') }

  readPromptManifest(id) {
    try {
      const raw = readFileSync(this.promptManifestPathOf(id), 'utf8')
      const data = JSON.parse(raw)
      return data !== null && typeof data === 'object' ? data : {}
    } catch { return {} }
  }

  writePromptManifest(id, manifest) {
    try {
      mkdirSync(this.promptsDirOf(id), { recursive: true })
      writeFileSync(this.promptManifestPathOf(id), JSON.stringify(manifest, null, 2), 'utf8')
    } catch { /* 기록 실패는 사용에 영향 없음 */ }
  }

  /**
   * "아직 구버전 내장 기본값" 인 역할 프롬프트를 현재 버전으로 바꾼다; 사용자가 직접 수정한 것은 그대로 보존한다.
   *
   * 판단 근거: 내용 지문이 ① 이 대상에 마지막으로 기본값을 기록할 때의 지문(manifest) 과 같거나,
   * ② 어느 과거 버전의 기본 지문(LEGACY_PROMPT_HASHES) 과 같은 경우. 둘 다 일치하지 않으면 = 사용자가 직접 쓴 것이다.
   * 프롬프트를 읽을 때마다(패널을 열 때) 함께 한 번 실행되므로, 오래된 대상도 자동으로 새 버전을 따라간다.
   *
   * @param id - 대상 id 값.
   * @param options - `{ force?: boolean }`: force 이면 "사용자 직접 작성" 분도 덮어쓴다(스크립트 일괄 업그레이드용).
   * @returns `{ changed, kept, created }` —— kept 는 "사용자 직접 작성, 이미 보존됨" 으로 판정된 역할이다.
   */
  refreshDefaultPrompts(id, options = {}) {
    const manifest = this.readPromptManifest(id)
    let changed = 0
    let created = 0
    const kept = []
    for (const role of Object.keys(ROLE_TITLES)) {
      const next = DEFAULT_PROMPTS[role] || ''
      const p = join(this.promptsDirOf(id), `${role}.md`)
      /* 새 역할(예: v0.9.0 의 자산 정리 assess / 메인 세션 plan): 오래된 대상에는 이 파일이 없으므로,
         현재 기본값으로 바로 하나 만들어 두고 사용자가 직접 채우게 하지 않는다 */
      if (!existsSync(p)) {
        if (next !== '') {
          mkdirSync(this.promptsDirOf(id), { recursive: true })
          writeFileSync(p, next, 'utf8')
          manifest[role] = promptHash(next)
          created += 1
        }
        continue
      }
      const cur = readFileSync(p, 'utf8')
      const h = promptHash(cur)
      const hNext = promptHash(next)
      if (h === hNext) { manifest[role] = hNext; continue }
      const wasDefault = options.force === true || manifest[role] === h || (LEGACY_PROMPT_HASHES[role] || []).includes(h)
      if (!wasDefault) { kept.push(role); continue }
      /* 덮어쓰기 전에 .bak 을 하나 남겨, 혹시 잘못 판정해도 되찾을 수 있게 한다 */
      try { copyFileSync(p, `${p}.bak-${Date.now()}`) } catch { /* 무시 */ }
      writeFileSync(p, next, 'utf8')
      manifest[role] = hNext
      changed += 1
    }
    this.writePromptManifest(id, manifest)
    return { changed, kept, created }
  }

  listPrompts(id) {
    const dir = this.promptsDirOf(id)
    mkdirSync(dir, { recursive: true })
    this.refreshDefaultPrompts(id)
    return Object.entries(ROLE_TITLES).map(([role, title]) => {
      const p = join(dir, `${role}.md`)
      const exists = existsSync(p)
      return {
        role, title,
        /* 메인 세션(plan)은 파견하지 않고 인격 참고용으로만 쓴다 —— 패널에 표시를 달아, 파견해야 하는 것으로 오해하지 않게 한다 */
        planner: role === PLANNER_ROLE,
        dispatcher: role !== PLANNER_ROLE,
        content: exists ? readFileSync(p, 'utf8') : '',
        updated_at: exists ? statSync(p).mtime.toISOString() : null,
      }
    })
  }

  /** 역할 프롬프트를 내장 기본값으로 되돌린다(사용자가 화면에서 잘못 고쳤거나, 오래된 대상에 새 버전 프롬프트를 적용할 때 사용). */
  resetPrompts(id, role) {
    if (role !== undefined && role !== null) {
      this.savePrompt(id, role, DEFAULT_PROMPTS[role] || '')
      return { reset: [role] }
    }
    const done = []
    for (const r of Object.keys(ROLE_TITLES)) { this.savePrompt(id, r, DEFAULT_PROMPTS[r] || ''); done.push(r) }
    return { reset: done }
  }

  savePrompt(id, role, content) {
    if (!ROLE_TITLES[role]) throw new Error(`unknown role: ${role}`)
    mkdirSync(this.promptsDirOf(id), { recursive: true })
    const text = String(content ?? '')
    writeFileSync(join(this.promptsDirOf(id), `${role}.md`), text, 'utf8')
    /* 이 내용이 "현재 내장 기본값" 인지 기록한다: 맞으면 앞으로 새 버전을 따라 자동 업그레이드되고, 아니면 사용자 직접 작성으로 보아 영원히 덮어쓰지 않는다 */
    const manifest = this.readPromptManifest(id)
    if (promptHash(text) === promptHash(DEFAULT_PROMPTS[role] || '')) manifest[role] = promptHash(text)
    else delete manifest[role]
    this.writePromptManifest(id, manifest)
    return { role, bytes: Buffer.byteLength(text) }
  }

}
