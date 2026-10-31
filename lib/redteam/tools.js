/**
 * RedTeam 에이전트 도구 모음(preset 평면)
 *
 * 이 줄들은 `tools` 에 모델이 볼 수 있는 도구만 등록하며 스스로 어떤 서비스도 게시하지 않으므로 isolate realm 이 필요 없다;
 * 이들이 해석하는 것은 host 평면의 `ctx.redteam`(dsh-redteam-store 가 게시하는 프로세스 수준 인스턴스)이다.
 *
 * 설계 규약:
 *   · 쓰기는 예외 없이 redteam_asset_add / redteam_asset_link 를 거치며, 에이전트가 SQL 을 직접 건드리지 않는다;
 *   · 모든 발견에는 provenance(passive|active)와 tool 이 붙어 UI 의 출처 표기가 신뢰할 만하게 유지된다;
 *   · **대상은 루트 세션 단위로 격리된다**: 바인딩 키는 세션의 루트 조상 id 이고, 하위 에이전트는
 *     `session.header.parentSession` 을 따라 부모 세션의 대상을 상속한다 —— 여러 세션이 병렬로 돌아도 서로 섞여 쓰이지 않고,
 *     보고서가 다른 대상의 성과로 오염되지 않는다(v0.9.0 이전의 전역 "현재 대상" 포인터가 바로 섞여 쓰기의 근원이었다);
 *   · 동시성 하드 제약: `redteam_agent_slot` 은 `ctx.subagents.listChildren` 의 실제 실행 수로
 *     "같은 대상에 실행 에이전트 최대 3 개"를 걸어 두고, 초과하면 곧바로 거부하며 프롬프트의 자율에 기대지 않는다.
 */
import { createRequire } from 'node:module'
import { existsSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { ROLE_TITLES, PLANNER_ROLE, ROLE_ORDER } from './store-core.js'
/* 스킬 사용 가능성 판정 구현은 하나뿐이다: 패널의 "스킬 라이브러리" 탭과 여기서 공용한다(해당 파일 헤더 주석 참고) */
import { bundledSkillSummaries, checkSkill, summarizeSkills, expandSkillPath, redteamSummariesForCheck } from './skill-availability.js'
import {
  loadPlatformConfig,
  mergeConfigEnv,
  platformSummary,
  toolkitDirOf,
} from './platform-config.js'
import { maxAgentsOf, DEFAULT_MAX_AGENTS, MAX_AGENTS_LIMIT } from './settings.js'
import { EvidenceLedger, UnknownRegistry } from './evidence-ledger.mjs'

/**
 * link: 소스 패키지가 profile node_modules 트리 안에 없어서, 정적 import `@deepseek-ai/dsh-tools` 는
 * 해석에 실패한다 → 프리셋 줄의 fiber 가 undefined(never started) → "레드팀 모드" 전체가 드롭다운에서 걸러진다.
 * 여기서는 실행 중인 dsh / profile 경로에서 createRequire 한다.
 */
function addCandidate(list, pkg) {
  if (!pkg) return
  const norm = String(pkg).replace(/\\/g, '/')
  if (!list.includes(norm)) list.push(norm)
}

function considerBin(list, bin) {
  if (!bin) return
  let text = String(bin).replace(/\\/g, '/')
  try { text = realpathSync(bin).replace(/\\/g, '/') } catch { /* 해석할 수 없으면 원래 경로를 그대로 쓴다 */ }
  const needle = '/node_modules/@deepseek-ai/dsh/'
  const at = text.lastIndexOf(needle)
  if (at >= 0) addCandidate(list, text.slice(0, at + needle.length - 1) + '/package.json')
  const nm = text.lastIndexOf('/node_modules/')
  if (nm >= 0) addCandidate(list, join(text.slice(0, nm), 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))
  const dir = dirname(text)
  /* npm 전역의 argv 는 흔히 …/bin/dsh 이고, 실제 패키지는 옆의 lib/node_modules 에 있다. */
  addCandidate(list, join(dir, '..', 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))
  addCandidate(list, join(dir, '..', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))
}

function loadDefineTool() {
  const candidates = []
  try {
    const req = createRequire(import.meta.url)
    const mod = req('@deepseek-ai/dsh-tools')
    const fn = mod && (mod.defineTool || (mod.default && mod.default.defineTool))
    if (typeof fn === 'function') return fn
  } catch { /* 플러그인 자신의 node_modules 에 없으니 호스트를 다시 훑는다 */ }
  try { considerBin(candidates, process.argv[1]) } catch { /* ignore */ }
  try { considerBin(candidates, process.execPath) } catch { /* ignore */ }
  const homes = [process.env.DSH_HOME, join(homedir(), '.dsh')].filter(Boolean)
  for (const home of homes) {
    addCandidate(candidates, join(home, 'package.json'))
    for (const profile of ['web', 'desktop', 'default']) {
      addCandidate(candidates, join(home, 'profiles', profile, 'package.json'))
      addCandidate(candidates, join(home, 'profiles', profile, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))
    }
  }
  const resources = process.resourcesPath || ''
  const exeDir = process.execPath ? dirname(process.execPath) : ''
  const desktopRoots = [
    resources,
    exeDir ? join(exeDir, 'resources') : '',
    exeDir,
  ].filter(Boolean)
  for (const root of desktopRoots) {
    addCandidate(candidates, join(root, 'app', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))
    addCandidate(candidates, join(root, 'app', 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))
    addCandidate(candidates, join(root, 'app.asar.unpacked', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))
    addCandidate(candidates, join(root, 'app.asar.unpacked', 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))
  }
  addCandidate(candidates, join(process.cwd(), 'package.json'))
  addCandidate(candidates, join('D:', 'DeepSeek Harness', 'npm-global', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))
  for (const pkg of candidates) {
    try {
      if (!pkg || !existsSync(pkg)) continue
      const mod = createRequire(pkg)('@deepseek-ai/dsh-tools')
      const fn = mod && (mod.defineTool || (mod.default && mod.default.defineTool))
      if (typeof fn === 'function') return fn
    } catch { /* try next */ }
  }
  throw new Error('dsh-purge/redteam/tools: cannot resolve @deepseek-ai/dsh-tools from host')
}

const defineToolRaw = loadDefineTool()

/** 0.2.1: 어떤 type=object 든 additionalProperties 를 반드시 명시해야 하며, 그렇지 않으면 레드팀 프리셋 전체가 로드에 실패한다. */
function sealObjectSchemas(node) {
  if (!node || typeof node !== 'object') return node
  if (Array.isArray(node)) {
    for (const item of node) sealObjectSchemas(item)
    return node
  }
  if (node.type === 'object' && node.additionalProperties === undefined) {
    node.additionalProperties = node.properties ? false : true
  }
  if (node.properties) {
    for (const key of Object.keys(node.properties)) sealObjectSchemas(node.properties[key])
  }
  if (node.items) sealObjectSchemas(node.items)
  if (node.additionalProperties && typeof node.additionalProperties === 'object') {
    sealObjectSchemas(node.additionalProperties)
  }
  return node
}

function defineTool(spec) {
  if (spec && spec.parameters) sealObjectSchemas(spec.parameters)
  const tool = defineToolRaw(spec)
  if (tool && tool.parameters) sealObjectSchemas(tool.parameters)
  if (tool && tool.inputSchema) sealObjectSchemas(tool.inputSchema)
  if (tool && tool.schema) sealObjectSchemas(tool.schema)
  return tool
}

/** Cordis 플러그인 이름. */
export const name = 'dsh-purge-redteam-tools'

/** 하드 의존 도구 레지스트리; `redteam` 은 host 평면에서 store 가 게시하고, 프리셋 영역 안에서는 소프트 조회를 쓴다. */
export const inject = ['tools']

/** 루트 세션 id → engagementId 바인딩(한 세션 안에서는 안정적; 프로세스 재시작 후에는 agent 가 다시 바인딩한다). */
const bindings = new Map()

/** 동시성 게이트: 루트 세션 id → Map(하위 에이전트 키 → 예약 타임스탬프). 하위 에이전트가 끝나면 자동으로 해제된다. */
const reservations = new Map()

/** FIFO cap: 긴 세션에서 무효화된 session id 가 무한히 늘지 않도록 상한을 둔다. 가장 오래된 항목부터 밀려난다(FIFO, 대략 LRU). */
const BINDINGS_CAP = 500
const RESERVATIONS_CAP = 500
function capMap(m, cap) {
  const origSet = m.set.bind(m)
  m.set = (k, v) => {
    if (!m.has(k) && m.size >= cap) {
      const first = m.keys().next().value
      if (first !== undefined) m.delete(first)
    }
    return origSet(k, v)
  }
}
capMap(bindings, BINDINGS_CAP)
capMap(reservations, RESERVATIONS_CAP)

/** 동시성 상한: 호출할 때마다 settings.json → REDTEAM_MAX_AGENTS → 기본값 3 을 읽는다. */
function maxAgentsNow(ctx) {
  const root = (() => { try { return ctx.redteam.root } catch { return undefined } })()
  return maxAgentsOf(root, process.env)
}

/** 한 번의 호출에 대한 세션 해석 결과. */
function sessionInfoOf(exec) {
  const agent = exec && exec.agent
  const session = agent && agent.session
  if (session === undefined || session === null) return {}
  const id = session.id === undefined ? undefined : String(session.id)
  let parentId
  try {
    const header = session.header
    parentId = header && header.parentSession !== undefined && header.parentSession !== null
      ? String(header.parentSession)
      : undefined
  } catch { parentId = undefined }
  return { id: id, parentId: parentId, session: session }
}

/** 세션 id(구 호출 지점 호환). */
function sessionOf(exec) {
  return sessionInfoOf(exec).id
}

/**
 * "루트 세션" 해석: parentSession 을 따라 최상위 세션 id 까지 거슬러 올라간다.
 * 메인 세션이 파생한 하위 에이전트는 따라서 같은 바인딩 키를 공유하고, **서로 다른 메인 세션끼리는 자연히 격리된다**.
 * 지나온 세션 id 를 함께 반환해 바인딩을 하위 세션에 캐시하기 쉽게 한다.
 */
function resolveRootSession(session) {
  const chain = []
  let cur = session
  let guard = 0
  while (cur !== undefined && cur !== null && guard < 64) {
    const info = sessionInfoOf({ agent: { session: cur } })
    if (info.id === undefined) break
    chain.push(info.id)
    if (info.parentId === undefined || info.parentId === '') break
    let parent
    try {
      const store = cur.store
      parent = store && typeof store.get === 'function' ? store.get(info.parentId) : undefined
    } catch { parent = undefined }
    if (parent === undefined || parent === null) {
      /* 부모 세션이 메모리에 없다(회수됨 / 콜드 스타트): 부모 id 자체가 안정적인 루트 키다 */
      return { rootId: info.parentId, chain: chain.concat([info.parentId]) }
    }
    cur = parent
    guard += 1
  }
  return { rootId: chain.length > 0 ? chain[chain.length - 1] : undefined, chain: chain }
}

/** 바인딩 키 + 세션 체인. */
function bindingKeyOf(exec) {
  const info = sessionInfoOf(exec)
  if (info.id === undefined) return { rootId: undefined, sessionId: undefined, chain: [] }
  const resolved = resolveRootSession(info.session)
  const rootId = resolved.rootId === undefined ? info.id : resolved.rootId
  return { rootId, sessionId: info.id, chain: resolved.chain }
}

/**
 * 이번 호출이 어느 대상에 작용해야 하는지 해석한다(세션 격리판).
 *
 * 순서: ① 명시적으로 전달된 값 → ② 이 세션/부모 체인의 바인딩 → ③ 전역 "현재 대상" 포인터
 * (다른 세션이 점유하지 않았을 때만; 점유 중이면 오류를 내고 명시적 바인딩을 안내한다, **절대 조용히 섞어 쓰지 않는다**).
 *
 * "아무거나 하나 고르기" 대신 오류를 던지는 것은 의도된 선택이다: 여러 세션이 병렬로 돌 때 대상을 잘못 고르면 = A 기관의 성과를
 * B 기관의 라이브러리에 기록하고, A 의 보고서에 B 의 데이터가 나타난다(이것이 다중 세션 격리가 필요한 이유다).
 */
function resolveEngagement(store, exec, explicit) {
  if (typeof explicit === 'string' && explicit.length > 0) return explicit
  const { rootId, sessionId, chain } = bindingKeyOf(exec)
  const keys = Array.from(new Set([rootId, sessionId, ...chain].filter(Boolean)))
  for (const key of keys) {
    const bound = bindings.get(key)
    if (typeof bound === 'string' && bound.length > 0) return bound
  }
  if (typeof store.activeEngagementId === 'function') {
    const active = store.activeEngagementId()
    if (active !== undefined) {
      const holder = Array.from(bindings.entries()).find(([k, v]) => v === active && !keys.includes(k))
      if (holder !== undefined) {
        throw new Error(
          '이 세션은 아직 대상을 바인딩하지 않았는데 전역 "현재 대상"' + active + ' 은(는) 다른 세션이 점유 중입니다;'
          + '여러 세션이 같은 대상 라이브러리에 섞여 쓰이지 않도록 명시적으로 바인딩하세요: redteam_engagement_open(새로 만들기/열기)'
          + ' 또는 redteam_session_bind(기존 대상에 바인딩).',
        )
      }
      for (const key of keys) bindings.set(key, active)
      return active
    }
  }
  const list = store.listEngagements()
  if (list.length === 1) {
    for (const key of keys) bindings.set(key, list[0].id)
    return list[0].id
  }
  throw new Error('아직 대상이 바인딩되지 않았습니다: 먼저 redteam_engagement_open 을 호출해 대상 기관 이름을 전달하세요')
}

/** 현재 세션의 바인딩 관계(redteam_session_info 와 패널 표시용). */
function bindingViewOf(exec) {
  const info = sessionInfoOf(exec)
  const { rootId, chain } = bindingKeyOf(exec)
  return {
    session_id: info.id ?? null,
    parent_session: info.parentId ?? null,
    root_session: rootId ?? null,
    session_chain: chain,
    is_subagent: info.parentId !== undefined,
    bound_engagement: rootId !== undefined ? (bindings.get(rootId) ?? null) : null,
  }
}

/** 쉼표/공백으로 구분된 목록 → 중복 제거 배열. */
function splitList(value) {
  return String(value || '').split(/[,\uff0c\s]+/).map((x) => x.trim()).filter(Boolean)
}

/** 한 줄 자산을 모델이 읽을 수 있는 압축 구조로 만든다(라이브러리 원본 데이터를 통째로 컨텍스트에 넣지 않기 위해). */
function compactAsset(a) {
  return {
    id: a.id,
    ip: a.ip,
    segment: a.segment_cidr,
    state: a.state,
    name: a.primary_name,
    names: a.names.map((n) => n.name),
    ports: a.ports.filter((p) => p.state === 'open')
      .map((p) => p.port + '/' + p.proto + (p.service ? ' ' + [p.service, p.product, p.version].filter(Boolean).join(' ') : '') + ' [' + p.provenance + ']'),
    fingerprints: a.fingerprints.map((f) => [f.category, f.vendor, f.product, f.version].filter(Boolean).join(' ') + ' [' + f.provenance + ']'),
    passive: a.passive,
    active: a.active,
    /* 발견 시각: 이 자산이 이 라이브러리에 처음 들어온 시각(패널과 보고서 모두 이 값으로 타임라인을 정렬한다) */
    discovered_at: a.discovered_at,
    first_seen: a.first_seen,
    last_seen: a.last_seen,
    test_status: a.test_status,
    priority: a.priority,
  }
}

const text = (value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }]

/** 역할 code 의 유효 값 설명(도구 description 에 기록되어 모델이 추측할 필요가 없다). */
const ROLE_HINT = '역할 code 는 ' + ROLE_ORDER.map((r) => '`' + r + '`(' + ROLE_TITLES[r] + ')').join(', ')

function bindKeysOf(exec) {
  const { rootId, sessionId, chain } = bindingKeyOf(exec)
  return Array.from(new Set([rootId, sessionId, ...chain].filter(Boolean)))
}

/** 실시간 동시성 점유: subagents 레지스트리에서 "정말로 돌고 있는" 직접 하위 세션 수를 읽는다. */
async function liveRunningChildren(ctx, rootSessionId) {
  const subagents = ctx.get('subagents')
  if (subagents === undefined || subagents === null || typeof subagents.listChildren !== 'function') {
    return { available: false, running: 0, error: 'subagents 레지스트리를 사용할 수 없다(실제 동시성 수를 대조할 수 없어 예약 수로만 집계한다)' }
  }
  try {
    const entries = await subagents.listChildren(rootSessionId)
    const rows = Array.isArray(entries) ? entries : []
    const running = rows.filter((e) => e && e.kind === 'child' && e.activity === 'running')
    return {
      available: true,
      running: running.length,
      running_labels: running.map((e) => e.label || e.id).slice(0, 20),
      total_children: rows.filter((e) => e && e.kind === 'child').length,
    }
  } catch (error) {
    return { available: false, running: 0, error: '하위 세션 나열 실패: ' + (error && error.message ? error.message : String(error)) }
  }
}

/** 예약분(subagents 레지스트리가 덮지 않는 부분, 예를 들어 방금 acquire 했지만 아직 뜨지 않은 것). */
function reservationList(rootId) {
  const map = reservations.get(rootId)
  if (map === undefined) return []
  return Array.from(map, ([key, at]) => ({ key, at }))
}

function addReservation(rootId, key) {
  if (!reservations.has(rootId)) reservations.set(rootId, new Map())
  reservations.get(rootId).set(key, Date.now())
}

function dropReservation(rootId, key) {
  const map = reservations.get(rootId)
  if (map === undefined) return false
  if (key === undefined) {
    /* key 가 없을 때는 가장 이른 항목 하나만 해제한다(도구 설명과 일치) —— 테이블을 통째로 비우면 다른 진행 중 예약까지 함께 풀려 정원이 초과 판매된다 */
    let oldestKey = null
    let oldestAt = Infinity
    for (const [k, at] of map) {
      if (at < oldestAt) { oldestAt = at; oldestKey = k }
    }
    return oldestKey !== null ? map.delete(oldestKey) : false
  }
  return map.delete(key)
}

/**
 * 이 기록을 산출한 에이전트 역할: 명시적으로 전달된 값이 우선이고, 없으면 기본적으로 메인 세션 기준으로 기록한다.
 * 이 값은 라이브러리의 `agent` 컬럼에 기록되며, 보고서에서 "이 단계는 누가 했는지"가 이 값으로 표시된다.
 */
function agentOf(args) {
  const raw = typeof args.agent === 'string' ? args.agent.trim() : ''
  return raw !== '' ? raw : PLANNER_ROLE
}

/** 라이브러리 쓰기 도구가 공용하는 agent 인자(역할 code 화이트리스트 안내는 description 에 기록한다). */
const AGENT_PARAM = {
  type: 'string',
  description: '[권장 입력] 이 기록을 산출한 역할 —— ' + ROLE_HINT
    + '. 보고서에서 이 값으로 "이 단계는 누가 했는지"를 표시하며, 비우면 메인 세션 기준으로 기록합니다.',
}

/**
 * store 계층에서 던진 예외를 구조화된 실패 반환으로 통일해 수렴한다.
 *
 * 필요한 이유: 같은 종류의 오류(객체 없음 / 인자가 유효하지 않음)가 이전에는 두 가지 형태였다 ——
 * 어떤 도구는 `return { ok:false, error }` 를, 어떤 도구는 그냥 던진다. 모델은 전자를 받으면 인자를 바꿔 재시도할 수 있지만,
 * 후자를 받으면 대개 이번 호출을 그냥 포기해 동작이 예측 불가능해진다. 전자로 통일하고, **원본 정보를 삼키지 않는다**.
 * @param tool - defineTool 의 반환값.
 * @returns try/catch 로 한 겹 감싼 같은 도구 정의.
 */
function withStructuredErrors(tool) {
  const inner = tool.execute
  if (typeof inner !== 'function') return tool
  return Object.assign({}, tool, {
    async execute(args, exec) {
      try {
        return await inner(args, exec)
      } catch (error) {
        const message = error && error.message ? error.message : String(error)
        /* 인자 계열 오류(유효하지 않은 값/필수 항목 누락)와 "객체를 찾을 수 없음"을 나눠 안내하여, 모델이 재시도할지 포기할지 판단하게 한다 */
        const kind = /\u975e\u6cd5|불법|invalid|required|\u4e0d\u80fd\u4e3a\u7a7a|필수 입력|not found|\u4e0d\u5b58\u5728|찾을 수 없음/i.test(message) ? 'bad_input' : 'failed'
        return JSON.stringify({
          ok: false,
          error: message,
          error_kind: kind,
          hint: kind === 'bad_input'
            ? '인자나 객체 식별자의 문제입니다: 인자 이름과 값을 확인하고(해당 *_list / *_query 도구로 실제 id 를 먼저 확인 가능), 고친 뒤 재시도하세요.'
            : '도구 실행에 실패했습니다. 오류 원문은 error 필드를 보세요; 조용히 건너뛰지 말고 먼저 사용자나 지휘자에게 걸린 지점을 설명하세요.',
        }, null, 2)
      }
    },
  })
}

export function apply(ctx) {
  let store
  try {
    store = ctx.redteam
  } catch {
    store = undefined
  }
  if (!store) {
    try { store = ctx.get('redteam') } catch { store = undefined }
  }
  if (!store) {
    ctx.logger?.warn?.('redteam-tools: host ctx.redteam unavailable — tools will report store_missing')
    store = {
      openEngagement: () => { throw new Error('레드팀 자산 라이브러리를 사용할 수 없습니다') },
      listEngagements: () => [],
      stats: () => ({}),
    }
  }

  /* ── 하위 에이전트가 끝나면 동시성 정원을 자동 해제한다(모델이 release 호출을 기억하는지에 의존하지 않는다)──────────── */
  /* ctx.effect 로 감싼다 → plugin dispose 시 subagent/end 를 해제하고, 그렇지 않으면 handler 가 남고 핫 리로드 때 배로 늘어난다. */
  ctx.effect(() => {
    let disposer = null
    try {
      disposer = ctx.on('subagent/end', (info, parent) => {
        const parentSession = parent && parent.session
        const { rootId } = bindingKeyOf({ agent: { session: parentSession } })
        const childId = info && info.id !== undefined ? String(info.id) : undefined
        if (rootId === undefined) return
        if (childId !== undefined && dropReservation(rootId, childId)) return
        /* 레지스트리의 키가 runId 와 다를 수 있다: 시간 기준으로 가장 이른 예약 하나를 폴백으로 정리한다 */
        const map = reservations.get(rootId)
        if (map === undefined || map.size === 0) return
        let oldestKey
        let oldestAt = Number.POSITIVE_INFINITY
        for (const [key, at] of map) { if (at < oldestAt) { oldestAt = at; oldestKey = key } }
        if (oldestKey !== undefined) map.delete(oldestKey)
      })
    } catch { /* 이벤트를 쓸 수 없을 때는 자동 해제에만 영향을 주고, 수동 release 는 여전히 쓸 수 있다 */ }
    return () => { try { if (typeof disposer === 'function') disposer() } catch { /* ignore */ } }
  })

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_engagement_open',
    description: '단위 이름으로 공격 방어 드릴 대상을 열거나 생성하고, **현재 세션**을 그 대상에 바인딩합니다(하위 에이전트는 자동으로 상속합니다). 이후 모든 자산 도구는 기본적으로 이 대상에 작용합니다. 대상이 이미 있으면 그 자산 라이브러리를 재사용합니다. 기록되는 것은 이 세션의 바인딩이며, 다른 세션이 쓰고 있는 대상은 바꾸지 않습니다.',
    parameters: {
      target: { type: 'string', required: true, description: '대상 기관 이름, 예: "예시 테크놀로지 주식회사"' },
      scope: {
        type: 'array',
        description: '승인 범위 CIDR 목록(선택: 사용자가 주지 않으면 묻지 말고, 공개적으로 보이는 자산 범위를 기준으로 자율적으로 진행)',
        items: { type: 'string' },
      },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      /* bindCurrent: false —— 전역 "현재 대상" 포인터를 건드리지 않는다: 여러 세션이 병렬로 돌 때 그 포인터가 섞여 쓰기의 근원이다 */
      const engagement = store.openEngagement(args.target, args.scope, { bindCurrent: false })
      const keys = bindKeysOf(exec)
      for (const key of keys) bindings.set(key, engagement.id)
      const view = bindingViewOf(exec)
      return JSON.stringify({
        ok: true,
        engagement,
        stats: store.stats(engagement.id),
        session: view,
        note: '이 세션에 바인딩되었습니다(세션 격리: 다른 세션의 바인딩은 영향을 받지 않습니다); 하위 에이전트가 이 대상을 상속합니다.'
          + (view.is_subagent ? ' 주의: 이 세션은 하위 에이전트이므로 보통 다시 open 할 필요가 없고, 부모 세션의 대상을 그대로 상속하면 됩니다.' : ''),
      }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_session_bind',
    description: '**이미 존재하는** 대상을 현재 세션에 바인딩합니다(여러 세션이 병렬로 돌 때 사용: 각 세션이 자기 대상에 바인딩되어 서로 섞여 쓰이지 않습니다). 대상 id 또는 기관 이름을 쓸 수 있고, 생략하면 바인딩 가능한 대상을 나열합니다.',
    parameters: {
      engagement: { type: 'string', description: '대상 id 또는 기관 이름; 생략하면 후보만 나열합니다' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const list = store.listEngagements()
      const wanted = typeof args.engagement === 'string' ? args.engagement.trim() : ''
      if (wanted === '') {
        return JSON.stringify({
          ok: false,
          candidates: list.map((e) => ({ id: e.id, name: e.name, created_at: e.created_at, stats: e.stats })),
          note: 'engagement(대상 id 또는 기관 이름)를 전달해 바인딩을 완료하세요.',
        }, null, 2)
      }
      const hit = list.find((e) => e.id === wanted)
        || list.find((e) => String(e.name) === wanted)
        || list.find((e) => String(e.name).includes(wanted))
      if (hit === undefined) {
        return JSON.stringify({ ok: false, error: '대상이 존재하지 않습니다: ' + wanted, candidates: list.map((e) => e.id) }, null, 2)
      }
      const keys = bindKeysOf(exec)
      for (const key of keys) bindings.set(key, hit.id)
      return JSON.stringify({
        ok: true, engagement: { id: hit.id, name: hit.name },
        session: bindingViewOf(exec),
        note: '이 세션은 "' + hit.name + '"에 바인딩되었습니다; 이후 도구와 보고서는 모두 이 대상에만 작용합니다.',
      }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_session_info',
    description: '**현재 세션이 어느 대상에 바인딩되어 있는지** 확인합니다(세션 id, 부모 세션, 루트 세션, 바인딩 체인). 여러 세션이 동시에 작업을 시작할 때 먼저 이것을 실행해 다른 세션의 대상에 잘못 붙지 않았는지 확인하세요.',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(_args, exec) {
      const view = bindingViewOf(exec)
      const changed = view.bound_engagement !== null ? store.stats(view.bound_engagement) : null
      return JSON.stringify({
        ok: true, session: view, stats: changed,
        bindings_now: Array.from(bindings, ([k, v]) => ({ session: k, engagement: v })),
        note: '바인딩은 프로세스 내부 상태입니다: dsh 를 재시작하면 각 세션이 다시 한 번 바인딩해야 합니다(redteam_engagement_open / redteam_session_bind).',
      }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_preflight',
    description: '[작업 시작 전 반드시 한 번 실행]플랫폼 스킬 및 리소스 자체 점검: 레드팀 스킬마다 필요한 환경 변수(예: FOFA 자산 측량의 FOFA_KEY), 로컬 도구와 바이너리(suo5 / fscan / gogo / frp / 비헨더(Behinder) / 고질라(Godzilla) / nmap / nuclei…), 외부 인프라(리버스 Shell 에 쓰는 VPS)를 하나씩 확인합니다. available/broken 목록과 고장 난 스킬마다 "무엇이 없고, 어떻게 보충하는지"를 반환합니다. **key 나 VPS 가 없으면 사용자에게 바로 요청하거나 대체 방안으로 바꾸세요, 되는 척하지 마세요.**',
    parameters: {
      include: { type: 'string', description: '이 스킬들만 확인합니다(쉼표로 구분); 생략하면 모든 레드팀 스킬을 확인합니다' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args) {
      let skills
      try { skills = typeof ctx.get === 'function' ? ctx.get('skills') : null } catch { skills = null }
      const plat = platformSummary()
      const cfg = loadPlatformConfig()
      /* 환경 변수의 실제 출처: 프로세스 환경 + $DSH_HOME/.env + 플랫폼 config.json env */
      const envFile = expandSkillPath('$DSH_HOME/.env')
      const effectiveEnv = mergeConfigEnv({ ...process.env }, cfg)
      let envFileKeys = []
      try {
        if (existsSync(envFile)) {
          const { readFileSync } = await import('node:fs')
          for (const line of readFileSync(envFile, 'utf8').split('\n')) {
            /* shell 관용 표기와 호환: `export KEY=value`; 따옴표가 없는 줄 내 주석(`KEY=v # 비고`)은 벗겨낸다 */
            const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
            if (m === null) continue
            const key = m[1]
            let raw = m[2].trim()
            if (!/^["']/.test(raw)) raw = raw.replace(/\s+#.*$/, '')
            const value = raw.replace(/^["']|["']$/g, '').trim()
            if (value === '') continue
            envFileKeys.push(key)
            if (effectiveEnv[key] === undefined || effectiveEnv[key] === '') effectiveEnv[key] = value
          }
        }
      } catch { /* .env 를 읽지 못해도 주 흐름에는 영향이 없다 */ }

      const toolkit = toolkitDirOf(cfg)
      let toolkitEntries = []
      try {
        if (existsSync(toolkit)) {
          const { readdirSync } = await import('node:fs')
          toolkitEntries = readdirSync(toolkit).slice(0, 60)
        }
      } catch { /* 무시 */ }

      const redteamDir = expandSkillPath('$DSH_HOME/redteam')
      const markerFile = redteamDir + '/.setup-complete'
      const setupScript = redteamDir + '/setup.sh'
      const hasMarker = existsSync(markerFile)
      const hasSetupScript = existsSync(setupScript)
      const toolkitHint = '이 플러그인은 사용자를 대신해 도구를 내려받거나 설치하지 않습니다. Windows 이거나 setup.sh 가 없으면 드릴 콘솔 "환경 적응"에서 경로, FOFA_KEY, VPS 를 입력하세요; 로컬에 `$DSH_HOME/redteam/setup.sh` 가 있으면 사용자가 직접 `--check` 를 실행하고, 에이전트가 `--yes` 로 바이너리를 내려받게 하지 마세요.'
      let fofaKey = effectiveEnv.FOFA_KEY || ''
      const vpsKey = effectiveEnv.REDTEAM_VPS_KEY || (toolkit + (plat.runtime.windows ? '\\vps\\id_rsa' : '/vps/id_rsa'))
      const vpsHost = effectiveEnv.REDTEAM_VPS_HOST || ''
      const hasVps = existsSync(vpsKey)
      const missing = []
      if (fofaKey === '') missing.push('FOFA_KEY(자산 측량: "환경 적응" 페이지에 입력하거나 $DSH_HOME/.env 에 기록)')
      if (!hasVps) {
        missing.push(plat.runtime.windows
          ? 'VPS 개인 키("환경 적응"에서 REDTEAM_VPS_KEY 경로와 REDTEAM_VPS_HOST 를 입력; Windows 는 setup.sh 에 의존하지 않는다)'
          : 'VPS 로그인 방식 —— 개인 키를 ' + vpsKey + ' 에 두고 REDTEAM_VPS_HOST 를 설정하세요(절차는 스킬 redteam-setup 또는 드릴 콘솔 "환경 적응" 참고)')
      }
      const fofaShown = fofaKey.length > 8 ? fofaKey.slice(0, 4) + '…' + fofaKey.slice(-4) : '(설정됨)'
      const runtimeHint = plat.runtime.windows
        ? '현재는 **Windows 적응** 모드입니다: 드릴 콘솔 "환경 적응" 페이지에서 도구 경로/검색 디렉터리와 FOFA/VPS 를 설정하세요; Kali/`bash setup.sh` 가 있다고 가정하지 마세요. 전용 드릴 머신 사용을 권장하며, 일상 업무 PC 에 개인 키와 스캐너를 두지 마세요.'
        : '이 모드는 **드릴 전용 Kali 가상 머신**에서 실행할 것을 권장하며, 일상 업무 PC/호스트에서 실행하지 마세요'
          + '(로컬에 VPS 개인 키와 WebShell 트로이 목마를 두게 되고, 스캔 트래픽도 평소 쓰는 출구 IP 로 나간다; 드릴이 끝나면 가상 머신은 그대로 버리면 된다).'

      let checked = []
      let allBroken = []
      let allAvailable = []
      let broken = []
      let available = []
      let only = splitList(args.include)
      let unknownIncludes = []

      const bundledSkills = bundledSkillSummaries()
      const skillsMissing = skills === undefined || skills === null || typeof skills.list !== 'function'
      if (skillsMissing && bundledSkills.length === 0) {
        /* 데스크톱에는 흔히 skills inject 가 없다: 그래도 플랫폼 도구 탐지를 반환해 preflight 전체가 무용지물이 되지 않게 한다 */
        const toolMissing = (plat.tools.items || []).filter((t) => !t.path).map((t) => t.id)
        if (toolMissing.length) {
          missing.push('해석되지 않은 도구("환경 적응"에서 경로를 입력하거나 검색 디렉터리 추가): ' + toolMissing.slice(0, 12).join(', '))
        }
        const onboarding = {
          complete: hasMarker && missing.length === 0,
          runtime_hint: runtimeHint,
          first_run: !hasMarker,
          marker: { path: markerFile, exists: hasMarker },
          setup_script: { path: setupScript, exists: hasSetupScript },
          toolkit_hint: toolkitHint,
          configured: {
            fofa_key: fofaKey === '' ? 'missing' : 'configured(' + fofaShown + ')',
            vps_key: hasVps ? 'configured(' + vpsKey + ')' : 'missing',
            vps_host: vpsHost,
            env_file: { path: envFile, exists: existsSync(envFile), keys: envFileKeys },
            platform_config: { path: cfg.path, exists: !!cfg.exists },
          },
          missing,
        }
        return JSON.stringify({
          ok: missing.length === 0 && toolMissing.length === 0,
          onboarding,
          platform: plat,
          toolkit: { dir: toolkit, exists: existsSync(toolkit), entries: toolkitEntries, hint: toolkitHint },
          skills_root_hint: '호스트 skills 서비스를 사용할 수 없습니다: 스킬 본문 점검을 건너뛰고 플랫폼 도구 탐지만 반환합니다. "환경 적응"에서 경로를 설정하세요.',
          next: plat.runtime.windows
            ? '드릴 콘솔 "환경 적응"을 여세요: ① binDirs(당신의 도구 폴더) 또는 tools 경로를 하나씩 입력 ② FOFA_KEY / VPS 입력 ③ 저장 후 preflight 다시 실행. 사용자를 대신해 도구를 내려받지 마세요.'
            : (hasSetupScript
              ? '사용자가 직접 bash "$DSH_HOME/redteam/setup.sh" --check 를 실행하거나, "환경 적응"에서 경로를 직접 입력할 수 있습니다. 에이전트가 도구를 내려받게 하지 마세요.'
              : '로컬에 setup.sh 가 없는 것은 정상적인 상황입니다. 드릴 콘솔 "환경 적응"에서 경로를 직접 입력하거나, 스킬 redteam-setup 에 따라 항목별로 설정하세요.'),
        }, null, 2)
      }

      let summaries = []
      let fromBundle = skillsMissing
      let scoped = false
      if (fromBundle) {
        summaries = bundledSkills
      } else {
        try {
          let scope = null
          try {
            const presets = typeof ctx.get === 'function' ? ctx.get('agentPresets') : null
            if (presets && typeof presets.standingKeyFor === 'function') {
              scope = await presets.standingKeyFor('redteam')
            }
          } catch { scope = null }
          scoped = scope != null
          const listed = scoped ? await skills.list({ scope }) : await skills.list()
          summaries = redteamSummariesForCheck(listed, bundledSkills, scoped)
          fromBundle = summaries.every((item) => item && item.library === 'redteam' && item.content)
        } catch (error) {
          if (bundledSkills.length === 0) {
            return JSON.stringify({ ok: false, error: '스킬 디렉터리 읽기 실패: ' + (error && error.message ? error.message : String(error)), platform: plat }, null, 2)
          }
          summaries = bundledSkills
          fromBundle = true
        }
      }
      summaries = redteamSummariesForCheck(summaries, bundledSkills, scoped)
      const wanted = summaries.filter((s) => only.length === 0 || only.includes(s.name))
      /* include 일 때는 지목된 스킬만 점검한다: 그렇지 않으면 ok 가 무관한 broken 때문에 false 로 끌려 내려가, 모델이 대상 스킬이 고장 났다고 오해한다 */
      const toCheck = only.length > 0 ? wanted : summaries
      unknownIncludes = only.filter((n) => !summaries.some((s) => s.name === n))
      const rootsWith = new Map()
      for (const x of summaries) {
        const dir = x.resourceBase && x.resourceBase.kind === 'directory' ? x.resourceBase.path : null
        if (dir === null) continue
        if (!rootsWith.has(x.name)) rootsWith.set(x.name, [])
        if (!rootsWith.get(x.name).includes(dir)) rootsWith.get(x.name).push(dir)
      }
      for (const summary of toCheck) {
        let def
        if (!fromBundle && skills && typeof skills.get === 'function') {
          try { def = await skills.get(summary.name) } catch { def = undefined }
        }
        const path = def && typeof def.path === 'string'
          ? def.path
          : (typeof summary.path === 'string'
            ? summary.path
            : (summary.resourceBase && summary.resourceBase.kind === 'directory' ? summary.resourceBase.path : null))
        const root = summary.resourceBase && summary.resourceBase.kind === 'directory' ? summary.resourceBase.path : null
        const content = def && typeof def.content === 'string' && def.content.trim() !== ''
          ? def.content
          : summary.content
        const verdict = checkSkill({ name: summary.name, content, path, root },
          { env: effectiveEnv, sameNameIn: rootsWith.get(summary.name) || [] })
        checked.push(Object.assign({}, verdict, {
          title: summary.description,
          path,
          when_to_use: summary.whenToUse || '',
          needs_user: verdict.needs_user.map((n) => (n.startsWith('\u73af\u5883\u53d8\u91cf') || n.startsWith('환경 변수')
            ? n + (plat.runtime.windows ? '("환경 적응" 페이지에서 입력 가능)' : '(받은 뒤 export 하고 dsh web 재시작)')
            : n === 'VPS \u5730\u5740' || n === 'VPS 주소' || n === 'VPS \u4e3b\u673a\u540d' || n === 'VPS 호스트 이름'
              ? '리버스 Shell / 페이로드 전달에 쓰는 ' + n + ' (스킬 안에서는 아직 플레이스홀더)'
              : n)),
        }))
      }
      allBroken = checked.filter((s) => s.status === 'broken')
      allAvailable = checked.filter((s) => s.status === 'available')
      const shown = (x) => only.length === 0 || only.includes(x.name)
      broken = allBroken.filter(shown)
      available = allAvailable.filter(shown)
      const toolMissing = (plat.tools.items || []).filter((t) => !t.path)
      if (toolMissing.length) {
        missing.push('해석되지 않은 로컬 도구("환경 적응"에서 경로 입력): ' + toolMissing.slice(0, 10).map((t) => t.id).join(', '))
      }
      const needsUser = Array.from(new Set(broken.flatMap((s) => s.needs_user)))
      const onboarding = {
        complete: hasMarker && missing.length === 0 && allBroken.length === 0,
        runtime_hint: runtimeHint,
        first_run: !hasMarker,
        marker: { path: markerFile, exists: hasMarker },
        setup_script: { path: setupScript, exists: hasSetupScript },
        toolkit_hint: toolkitHint,
        configured: {
          fofa_key: fofaKey === '' ? 'missing' : 'configured(' + fofaShown + ')',
          vps_key: hasVps ? 'configured(' + vpsKey + ')' : 'missing',
          vps_host: vpsHost,
          env_file: { path: envFile, exists: existsSync(envFile), keys: envFileKeys },
          platform_config: { path: cfg.path, exists: !!cfg.exists },
        },
        missing,
      }
      let next
      if (plat.runtime.windows && (!hasMarker || missing.length > 0 || allBroken.length > 0)) {
        next = 'Windows 에서는 드릴 콘솔 "환경 적응"을 열어 toolkit/binDirs/tools 경로와 FOFA/VPS 를 설정하고, 저장한 뒤 redteam_preflight 를 다시 실행하세요; 스킬 본문에 경로가 없으면 해석된 도구의 절대 경로를 우선 사용하세요.'
      } else if (!hasMarker && !hasSetupScript) {
        next = '처음 사용이며, 로컬에 설치 스크립트 ' + setupScript + ' 가 없습니다(정상적인 상황이고 고장이 아닙니다).'
          + toolkitHint + ' onboarding.missing 을 한 번에 사용자에게 나열하세요; 다 채울 수 없으면 강등을 설명하세요: FOFA 가 없으면 crt.sh / 수동 DNS 를 쓰고, VPS 가 없으면 착지 없는 성과만 냅니다.'
      } else if (!hasMarker) {
        next = '**처음 사용**: 사용자가 직접 `bash ' + setupScript + ' --check` 를 실행하거나 드릴 콘솔 "환경 적응"을 열게 하세요. 에이전트가 --yes 로 도구를 내려받게 하지 마세요.'
      } else if (missing.length > 0) {
        next = '부족한 항목이 있습니다: onboarding.missing 을 한 번에 사용자에게 나열하세요. Windows 이거나 setup.sh 가 없으면 "환경 적응" 경로를 쓰고, 스크립트가 있어도 사용자만 직접 실행하게 하며 도구를 대신 내려받지 마세요.'
      } else if (allBroken.length > 0) {
        next = 'broken 안의 needs_user 를 한 번에 사용자에게 나열하세요; 다 채울 수 없으면 강등 방안을 설명하세요.'
      } else {
        next = '전부 사용 가능하니 작업을 시작할 수 있습니다.'
      }

      const summary = summarizeSkills(checked)
      return JSON.stringify({
        /* include 모드: ok 는 지목된 스킬의 점검 결과만 반영한다; 측량 key/VPS 등 missing 은 이와 무관하므로 참고로만 내리고 ok 를 끌어내리지 않는다 */
        ok: allBroken.length === 0 && (only.length > 0 || missing.length === 0),
        include: only.length > 0 ? { requested: only, unknown: unknownIncludes, note: 'ok 는 지목된 스킬만 포괄합니다; onboarding.missing 은 전역 참고이며 이번 ok 에 영향을 주지 않습니다' } : undefined,
        all_checked: { registry_total: summaries.length, checked: checked.length, broken: allBroken.length, available: allAvailable.length },
        onboarding,
        platform: plat,
        summary,
        checked: checked.length,
        available: available.map((s) => s.name),
        broken: broken.map((s) => ({ name: s.name, problems: s.problems, needs_user: s.needs_user,
          fixes: (s.issues || []).map((i) => i && i.fix).filter(Boolean),
          fix_note: '수정 단계는 사용자가 실행합니다("환경 적응" 페이지를 통해서도 가능); 당신이 도구를 내려받거나 설치하지 마세요.' })),
        unknown: checked.filter((s) => s.status === 'unknown').map((s) => s.name),
        toolkit: { dir: toolkit, exists: existsSync(toolkit), entries: toolkitEntries, hint: toolkitHint },
        skills_root_hint: '여기서는 레드팀 스킬만 확인합니다. 공식 스킬은 $DSH_HOME/skills 에 있으며, 레드팀 도구 경로로 사용 불가를 판정하지 않습니다.',
        next,
        needs_user_flat: needsUser,
        wanted_count: wanted.length,
      }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_agent_slot',
    description: '[메인 세션이 작업을 배분하기 전후에 사용]실행 에이전트의 동시성 게이트: 같은 대상에 **최대 동시 3 개**가 실행됩니다(REDTEAM_MAX_AGENTS 로 설정 가능). action=status 는 남은 정원과 누가 실행 중인지 보여 주고; action=acquire 는 정원 하나를 점유합니다(가득 차면 곧바로 거부되니, **재시도로 억지로 밀어 넣지 마세요**); action=release 는 해제합니다(하위 에이전트가 끝나면 서버에서도 자동 해제됩니다).',
    parameters: {
      action: { type: 'string', required: true, enum: ['status', 'acquire', 'release'], description: 'status 조회 / acquire 점유 / release 해제' },
      label: { type: 'string', description: 'acquire 할 때의 작업 라벨, 예: "정보 수집: 주 도메인과 C 대역"' },
      key: { type: 'string', description: 'release 할 때 해제할 키(생략하면 가장 이른 예약 하나를 해제)' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const { rootId, sessionId } = bindingKeyOf(exec)
      const owner = rootId ?? sessionId
      if (owner === undefined) {
        return JSON.stringify({ ok: false, error: '세션 id 를 얻지 못했습니다: 동시성을 집계할 수 없습니다(도구 호출에 agent 컨텍스트가 실려 있는지 확인하세요).' }, null, 2)
      }
      const live = await liveRunningChildren(ctx, owner)
      const reserved = reservationList(owner)
      /* 레지스트리에서 running 인 하위 세션은 이미 실행 중인 것을 포함한다; 예약은 "방금 자리를 잡았지만 아직 레지스트리에 나타나지 않은" 부분이며,
         둘 중 큰 값을 취해 중복 집계를 피하면서도 누락이 없게 한다 */
      const used = Math.max(live.running, reserved.length)
      const cap = maxAgentsNow(ctx)
      const free = Math.max(cap - used, 0)
      const base = {
        ok: true, max: cap, used, free,
        running_from_registry: live.running,
        running_labels: live.running_labels ?? [],
        reservations: reserved,
        registry_available: live.available,
        registry_note: live.available ? undefined : live.error,
      }
      if (args.action === 'status') {
        return JSON.stringify(Object.assign(base, {
          hint: free === 0
            ? '정원이 가득 찼습니다: 기존 에이전트가 보고한 뒤에 파견하세요(한 번에 하나씩, 순서대로 진행하는 것이 가장 안정적인 리듬입니다).'
            : '남은 자리 ' + free + ' 개입니다. 기본은 하나씩 파견이고, 정말로 서로 의존하지 않는 작업만 병렬로 하세요.',
        }), null, 2)
      }
      if (args.action === 'acquire') {
        if (free <= 0) {
          return JSON.stringify(Object.assign(base, {
            ok: false,
            error: '동시성이 가득 찼습니다(최대 ' + cap + ' 개): 지금은 새 에이전트를 파견할 수 없습니다. 먼저 현재 실행 중인 에이전트가 보고하기를 기다리거나, 이미 끝난 것을 release 하세요.',
          }), null, 2)
        }
        const key = (typeof args.label === 'string' && args.label.trim() !== '' ? args.label.trim() : 'slot') + '#' + Date.now()
        addReservation(owner, key)
        return JSON.stringify(Object.assign(base, { slot: key, used: used + 1, free: Math.max(cap - used - 1, 0) }, {
          hint: '자리를 잡았습니다(' + key + '). **파견한 뒤 잊지 마세요**: 하위 에이전트가 끝나면 자동으로 해제됩니다; 파견에 실패했다면(예: 도구 오류) redteam_agent_slot action=release key=' + key + ' 로 직접 해제하세요.',
        }), null, 2)
      }
      const dropped = dropReservation(owner, typeof args.key === 'string' && args.key.trim() !== '' ? args.key.trim() : undefined)
      return JSON.stringify(Object.assign(base, { ok: true, released: dropped, used: Math.max(used - (dropped ? 1 : 0), 0) }), null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_asset_add',
    description: '자산과 그 포트/서비스/핑거프린트를 자산 라이브러리에 기록합니다(멱등 upsert). 모든 발견에는 provenance 를 표시해야 합니다: 수동 수집은 passive, 능동 탐지는 active 로 하고 tool(데이터 소스 또는 도구 이름)도 함께 적습니다.',
    parameters: {
      engagement: { type: 'string', description: '대상 id; 생략하면 현재 세션에 바인딩된 대상을 씁니다' },
      ip: { type: 'string', required: true, description: '자산 IP(IPv4)' },
      state: { type: 'string', description: 'live | dead | unknown, 기본값 unknown' },
      primary_name: { type: 'string', description: '주 도메인/호스트 이름' },
      provenance: { type: 'string', required: true, enum: ['passive', 'active'], description: '이 발견의 출처: 수동 또는 능동' },
      tool: { type: 'string', description: '데이터 소스 또는 도구 이름, 예: crt.sh / nmap / nuclei / curl' },
      discovered_at: { type: 'string', description: '[선택] 이 자산의 발견 시각(ISO, 예: 2026-09-17T09:30:00Z). 비우면 "처음 라이브러리에 들어온 시각"으로 자동 기록합니다; 데이터 소스가 과거 최초 출현 시각을 주면 전달하는 편이 더 정확합니다. **반복 수집은 이 값을 덮어쓰지 않습니다**.' },
      first_seen: { type: 'string', description: '[선택] 데이터 소스/도구가 보고한 최초 출현 시각(발견 시각과 따로 기록)' },
      names: {
        type: 'array',
        description: '이 자산과 연관된 도메인/인증서 이름',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            name: { type: 'string', required: true },
            kind: { type: 'string', description: 'domain | hostname | cert_cn, 기본값 domain' },
            provenance: { type: 'string', enum: ['passive', 'active'] },
          },
        },
      },
      ports: {
        type: 'array',
        description: '열린 포트와 그 서비스/핑거프린트',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            port: { type: 'number', required: true },
            proto: { type: 'string', description: 'tcp(기본) | udp' },
            service: { type: 'string', description: '서비스 이름, 예: http / mysql' },
            product: { type: 'string', description: '제품 이름, 예: nginx' },
            version: { type: 'string', description: '버전, 예: 1.24.0' },
            banner: { type: 'string', description: '원본 banner 조각' },
            url: { type: 'string', description: 'Web 서비스에서 바로 접근 가능한 전체 URL, 예: https://oa.example.com:8443/portal' },
            title: { type: 'string', description: 'Web 페이지 제목(HTTP 탐지로 획득), 예: "Seeyon OA 로그인"' },
            provenance: { type: 'string', enum: ['passive', 'active'] },
            tool: { type: 'string' },
            fingerprints: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  category: { type: 'string', description: 'Web서버 | 미들웨어 | 프레임워크 | CMS | 데이터베이스 | VPN 게이트웨이 …' },
                  vendor: { type: 'string' },
                  product: { type: 'string' },
                  version: { type: 'string' },
                  evidence: { type: 'string', description: '판정 근거, 예: 응답 헤더 / 경로 / banner' },
                  confidence: { type: 'number', description: '0–1' },
                },
              },
            },
          },
        },
      },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const asset = {
        ip: args.ip, state: args.state, primary_name: args.primary_name,
        provenance: args.provenance, tool: args.tool,
        names: args.names, ports: args.ports,
        /* 발견 시각: 전달하지 않으면 서버가 "처음 라이브러리에 들어온 시각"으로 자동 기록한다;
           데이터 소스가 과거 시각(FOFA 의 first_seen 등)을 줄 수 있으면 전달하는 편이 보고서 타임라인이 더 정확하다 */
        discovered_at: args.discovered_at,
        first_seen: args.first_seen,
      }
      const result = store.importBundle(id, { scan: { tool: args.tool, argv: ['redteam_asset_add'] }, assets: [asset] })
      const written = store.listAssets(id, { ip: args.ip, limit: 1 }).items[0]
      return JSON.stringify({
        ok: true, engagement: id, counts: result.counts,
        asset: written ? compactAsset(written) : null,
        discovered_at: written ? written.discovered_at : null,
        hint: '이 자산의 발견 시각을 ' + (written && written.discovered_at ? written.discovered_at : '(알 수 없음)')
          + ' 로 기록했습니다; 반복 수집은 last_seen 만 갱신하며 발견 시각은 바꾸지 않습니다.',
      }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_asset_link',
    description: '자산 라이브러리에 관계 엣지를 하나 기록합니다(그래프와 이후 횡적 분석이 함께 사용합니다). relation 은 예컨대 resolves / exposes / contains / trusts / shares_cert 등입니다.',
    parameters: {
      engagement: { type: 'string' },
      src_kind: { type: 'string', required: true, description: 'segment | asset | domain | port …' },
      src_id: { type: 'string', required: true },
      dst_kind: { type: 'string', required: true },
      dst_id: { type: 'string', required: true },
      relation: { type: 'string', required: true },
      confidence: { type: 'number' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = store.importBundle(id, {
        edges: [{
          src_kind: args.src_kind, src_id: args.src_id,
          dst_kind: args.dst_kind, dst_id: args.dst_id,
          relation: args.relation, confidence: args.confidence,
        }],
      })
      return JSON.stringify({ ok: true, edges: result.counts.edges }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_asset_query',
    description: '자산 라이브러리를 검색합니다. C 대역, 포트, 서비스, 핑거프린트, 출처, 내외부망 차원(scope), 정렬(sort), 키워드(전문 검색, IP/도메인/banner/서비스/핑거프린트 포함)로 필터링할 수 있습니다. 자산마다 열린 포트와 핑거프린트, 내외부망 소속을 담은 압축 결과를 반환합니다.',
    parameters: {
      engagement: { type: 'string' },
      cidr: { type: 'string', description: 'C 대역, 예: 203.0.113.0/24' },
      port: { type: 'number', description: '열린 포트' },
      service: { type: 'string', description: '서비스/제품 이름 키워드, 예: nginx' },
      fingerprint: { type: 'string', description: '핑거프린트 키워드, 예: Tomcat / Spring' },
      provenance: { type: 'string', enum: ['passive', 'active'], description: '수동 또는 능동 출처만 보기' },
      q: { type: 'string', description: '전문 검색어(공백으로 여러 단어를 넣으면 AND)' },
      state: { type: 'string', enum: ['live', 'dead', 'unknown'] },
      scope: { type: 'string', enum: ['internal', 'external'], description: '내외부망 차원: internal=내부망/사설 주소, external=인터넷 도달 가능' },
      sort: { type: 'string', enum: ['priority', 'todo', 'ports', 'ip'], description: '정렬: priority=공략 용이성 우선(기본), todo=미탐지 우선, ports=포트 많은 순, ip=IP 순' },
      limit: { type: 'number', description: '반환 건수 상한, 기본 50, 최대 200' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const limit = Math.min(Number(args.limit) || 50, 200)
      const result = store.listAssets(id, {
        cidr: args.cidr, port: args.port, service: args.service,
        fingerprint: args.fingerprint, provenance: args.provenance,
        q: args.q, state: args.state, scope: args.scope, sort: args.sort, limit,
      })
      return JSON.stringify({
        ok: true, engagement: id, total: result.total, returned: result.items.length,
        items: result.items.map(compactAsset),
      }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_asset_get',
    description: '자산 하나의 전체 상세를 가져옵니다: 모든 포트와 서비스, 핑거프린트, 수집 추적 타임라인, 관계 엣지. 특정 대상을 깊이 분석할 때 사용합니다.',
    parameters: {
      engagement: { type: 'string' },
      id: { type: 'number', required: true, description: '자산 id(redteam_asset_query 결과에서 획득)' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const asset = store.getAsset(id, args.id)
      if (asset === undefined) return JSON.stringify({ ok: false, error: '자산이 존재하지 않습니다' })
      return JSON.stringify({ ok: true, asset }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_asset_stats',
    description: '자산 측량 개요: C 대역 수, 자산 수(생존), 열린 포트, 서비스, 핑거프린트, 수동/능동 추적 건수, 그리고 각 C 대역의 상세 내역.',
    parameters: { engagement: { type: 'string' } },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      return JSON.stringify({ ok: true, engagement: id, stats: store.stats(id), segments: store.listSegments(id) }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_asset_graph',
    description: '자산 그래프(C 대역 → 자산 → 열린 포트, 도메인 해석 엣지 포함)를 내보냅니다. 토폴로지 추론과 횡적 이동 경로 계획에 사용합니다. 노드 수가 상한을 넘으면 C 대역 단위로 범위를 좁힙니다.',
    parameters: {
      engagement: { type: 'string' },
      cidr: { type: 'string', description: '특정 C 대역의 부분 그래프만 가져오기' },
      maxNodes: { type: 'number', description: '노드 상한, 기본값 300' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const maxNodes = Math.min(Number(args.maxNodes) || 300, 1000)
      const graph = store.graph(id, { cidr: args.cidr })
      if (graph.nodes.length > maxNodes) {
        return JSON.stringify({
          ok: false,
          error: '그래프 노드가 너무 많습니다(' + graph.nodes.length + ' > ' + maxNodes + '), cidr 를 지정해 범위를 좁히세요',
          segments: store.listSegments(id).map((s) => ({ cidr: s.cidr, assets: s.assets })),
        }, null, 2)
      }
      return JSON.stringify({ ok: true, engagement: id, nodes: graph.nodes, edges: graph.edges }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_role_prompt',
    description: '특정 레드팀 역할의 현재 적용 중인 시스템 프롬프트를 가져옵니다. 열람 전용입니다. 작업을 파견할 때 전문을 과제에 옮겨 적지 마세요; subagent 의 prompt 첫 줄에 redteamRole: <code> 를 쓰면 역할 원고가 하위 세션 시스템 프롬프트에 들어갑니다.',
    parameters: {
      engagement: { type: 'string' },
      role: { type: 'string', required: true, /* 역할 화이트리스트는 **ROLE_ORDER 에서 파생**: 값을 4 개로 하드코딩했다가 assess 를 놓친 적이 있고,
          프리셋은 주 세션이 이 도구로 자산 정리 역할의 프롬프트를 가져오기를 명시했는데 —— 결과적으로 enum 이 그대로 거부해서,
          자산 정리 하위 에이전트는 역할 제약을 끝내 받지 못했다. 파생 이후에는 새 역할이 추가돼도 빠지지 않는다. */
      enum: ROLE_ORDER },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const found = store.listPrompts(id).find((p) => p.role === args.role)
      if (found === undefined) return JSON.stringify({ ok: false, error: '알 수 없는 역할입니다' })
      return JSON.stringify({
        ok: true, role: found.role, title: found.title,
        updated_at: found.updated_at, prompt: found.content,
      }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_roles',
    description: '레드팀 역할과 그 책임 제목을 나열합니다(정보 수집 / 취약점 탐지 / 취약점 익스플로잇 / 내부망 침투).',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute() {
      return JSON.stringify({
        ok: true,
        roles: Object.entries(ROLE_TITLES).map(([role, title]) => ({ role, title })),
      }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_asset_test',
    description: '특정 자산의 테스트 상황을 기록합니다: 이번에 어떤 테스트를 했는지(`test`, 추가식), 어떤 공격면이 남았는지(`surface`, 덮어쓰기식), 현재 테스트 상태, WAF 에 차단되었는지. **자산마다 테스트를 시작하기 전에 한 번 호출하고(status=testing), 테스트를 마쳤거나 포기했으면 다시 한 번 호출하세요**——자산 측량 페이지가 이를 근거로 "미테스트 / 테스트 중 / 테스트 완료 / 차단됨 / 포기됨 / 공격면 없음"을 표시합니다. 배제 결론, 로그인 실패 원인, 재테스트 사유는 모두 `test` 안에 적습니다.',
    parameters: {
      engagement: { type: 'string' },
      asset_id: { type: 'number', description: '자산 id(ip 와 둘 중 하나, asset_id 우선)' },
      ip: { type: 'string', description: '자산 IP' },
      status: { type: 'string', enum: ['untested', 'testing', 'tested', 'blocked', 'abandoned', 'no_surface'], description: '테스트 상태: 미테스트/테스트 중/테스트 완료/차단됨/포기됨/공격면 없음' },
      test: { type: 'string', description: '이번에 어떤 테스트를 했는지(**추가**되어 테스트 기록에 들어감, 예: "nmap 전체 포트 + nuclei cve 템플릿 + 인터페이스 권한 우회"). 배제 결론, 로그인 실패 원인, 재테스트 사유를 모두 여기에 적습니다.' },
      notes: { type: 'string', description: 'test 의 호환 별칭(옛 프롬프트에서 쓰던 표기), 효과는 test 와 같고 함께 테스트 기록에 추가됩니다.' },
      surface: { type: 'string', description: '아직 테스트할 공격면(덮어쓰기식, 예: "SMB 445 미테스트; Web /api 권한 우회 미실시")' },
      blocked: { type: 'boolean', description: '이번에 WAF/보호 장비에 차단되었는지(true 이면 차단 카운트 +1)' },
      updated_by: { type: 'string', description: '기록 역할, 예: recon / vuln-scan' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = store.updateAssetTest(id, { ...args, engagement: undefined })
      return JSON.stringify({ ok: true, engagement: id, ...result }, null, 2)
    },
  })))

  /* ================================================================== 취약점 탐지 */

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_vuln_add',
    description: '취약점 발견을 하나 기록합니다(취약점 탐지 역할). cve 가 있으면 (asset_id, cve, target) 기준으로 멱등 갱신합니다. severity 는 critical|high|medium|low|info 이고, status 는 candidate(검증 대기)|confirmed(검증 완료)|false-positive|exploited|fixed 입니다. 증거(요청/응답 조각, 재현 명령, 증거 파일 경로)를 반드시 첨부해야 합니다.',
    parameters: {
      engagement: { type: 'string' },
      agent: AGENT_PARAM,
      asset_id: { type: 'number', description: '자산 id(redteam_asset_query 에서 획득)' },
      cve: { type: 'string', description: 'CVE / CNVD 번호(번호가 없으면 생략 가능)' },
      title: { type: 'string', required: true, description: '취약점 제목' },
      severity: { type: 'string', required: true, enum: ['critical', 'high', 'medium', 'low', 'info'] },
      status: { type: 'string', enum: ['candidate', 'confirmed', 'false-positive', 'exploited', 'fixed'] },
      target: { type: 'string', description: '영향받는 대상, 예: https://host:443/path 또는 ip:port' },
      source: { type: 'string', description: '발견 방식: nuclei / sqlmap / curl / manual …' },
      confidence: { type: 'number', description: '0–1' },
      evidence: { type: 'string', description: '증거: 요청/응답 요약, 명령, 증거 파일 경로' },
      found_by_agent: { type: 'string', description: '발견 역할, 기본값 vuln-scan' },
      gained: { type: 'string', description: '[중요] 이 취약점으로 어떤 권한/성과를 얻었는지, 득점 기준의 짧은 라벨로 적고 여러 항목은 가운뎃점이나 쉼표로 구분하세요. 예: "서버 권한, 내부망 터널" "백엔드 관리자 계정" "데이터베이스 권한"' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = store.addVuln(id, { ...args, engagement: undefined, agent: agentOf(args), found_by_agent: args.found_by_agent || args.agent || 'vuln-scan' })
      return JSON.stringify({ ok: true, engagement: id, ...result, stats: store.vulnStats(id) }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_vuln_query',
    description: '취약점 라이브러리를 검색합니다: 심각도, 상태, CVE, 자산, C 대역 또는 키워드로 필터링합니다. 익스플로잇 대상 선정이나 오탐 확인에 사용합니다.',
    parameters: {
      engagement: { type: 'string' },
      severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low', 'info'] },
      status: { type: 'string', enum: ['candidate', 'confirmed', 'false-positive', 'exploited', 'fixed'] },
      cve: { type: 'string' },
      asset_id: { type: 'number' },
      cidr: { type: 'string' },
      q: { type: 'string', description: '제목/CVE/대상/증거 키워드' },
      limit: { type: 'number', description: '기본 50, 최대 200' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = store.listVulns(id, { ...args, engagement: undefined, limit: Math.min(Number(args.limit) || 50, 200) })
      return JSON.stringify({ ok: true, engagement: id, total: result.total, items: result.items, stats: store.vulnStats(id) }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_vuln_update',
    description: '취약점의 상태/심각도/증거를 갱신합니다(예: 검증 후 confirmed 로, 익스플로잇 성공 후 exploited 로, 오탐은 false-positive 로).',
    parameters: {
      engagement: { type: 'string' },
      id: { type: 'number', required: true, description: '취약점 id' },
      status: { type: 'string', enum: ['candidate', 'confirmed', 'false-positive', 'exploited', 'fixed'] },
      severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low', 'info'] },
      evidence: { type: 'string' },
      confidence: { type: 'number' },
      gained: { type: 'string', description: '이 취약점으로 얻은 권한/성과(득점 기준의 짧은 라벨, 여러 항목은 가운뎃점으로 구분)' },
      title: { type: 'string' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = store.updateVuln(id, args.id, { status: args.status, severity: args.severity, evidence: args.evidence, confidence: args.confidence, gained: args.gained, title: args.title })
      return JSON.stringify({ ok: result.updated, engagement: id, ...result, stats: store.vulnStats(id) }, null, 2)
    },
  })))

  /* ================================================================== 취약점 익스플로잇 / 내부망 침투 */

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_credential_add',
    description: '자격 증명을 하나 기록합니다(취약점 익스플로잇/내부망 침투 역할). **비밀번호/키의 평문을 secret_value 에 반드시 적어야 합니다**——패널이 언제든 재사용할 수 있도록 평문을 그대로 표시해야 하기 때문입니다; 동시에 secret_ref 로 runs/ 아래의 증거 파일을 가리키세요. 주의: 이 라이브러리는 이 PC 에만 있으며, 라이브러리 파일이나 내보낸 내용을 어떤 저장소에도 커밋해서는 안 됩니다.',
    parameters: {
      engagement: { type: 'string' },
      agent: AGENT_PARAM,
      host: { type: 'string', required: true, description: '소속 호스트(IP 또는 도메인)' },
      username: { type: 'string' },
      secret_type: { type: 'string', description: 'password | hash | key | token | connection-string, 기본값 password' },
      secret_value: { type: 'string', description: '[필수] 자격 증명 평문: 비밀번호 / Hash / 개인 키 / Token / 연결 문자열' },
      secret_ref: { type: 'string', description: '증거 참조 경로, 예: runs/cred-vnc-10.0.0.5.txt' },
      privilege: { type: 'string', description: '이 자격 증명의 권한 수준, 예: admin / user / db-read' },
      asset_id: { type: 'number' },
      source: { type: 'string', description: '출처: exploit / dump / config-leak …' },
      tool: { type: 'string' },
      note: { type: 'string' },
      found_by_agent: { type: 'string' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = store.addCredential(id, { ...args, engagement: undefined, agent: agentOf(args) })
      return JSON.stringify({ ok: true, engagement: id, ...result }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_shot_add',
    description: '증거 스크린샷을 등록합니다: 이미지를 대상 디렉터리로 복사하고 득점 항목/적중에 연결합니다(패널에서 득점 항목을 펼치면 그림이 보이고, 보고서에도 삽입됩니다). 일괄 득점 항목(예: 단말 권한)은 득점 항목마다 대표 이미지를 최대 3 장만 보여주면 되고, 장비마다 캡처할 필요는 없습니다.',
    parameters: {
      engagement: { type: 'string' },
      agent: AGENT_PARAM,
      path: { type: 'string', description: '이미지의 이 PC 상 경로(대상 디렉터리 기준 상대 경로 또는 절대 경로); data_base64 와 둘 중 하나' },
      data_base64: { type: 'string', description: '이미지 내용(base64, data: 접두사 허용); 스크린샷 도구가 파일로 저장하지 않았을 때 사용' },
      label: { type: 'string', description: '이미지 설명, 예: "도메인 컨트롤러 WEB-SHDC1 atexec 응답 출력 nt authority\\system"' },
      kind: { type: 'string', description: 'screenshot(현장 스크린샷, 기본) | card(기록에서 생성한 증거 발췌 카드, 보고서에 표시됨)' },
      point_code: { type: 'string', description: '연관된 득점 항목 code, 예: terminal-access / central-system' },
      hit_id: { type: 'number', description: '구체적인 득점 적중 하나에 연결(score_hit id); 지정하면 이 그림은 그 항목에만 붙습니다' },
      asset_id: { type: 'number' },
      target: { type: 'string', description: '이 그림에 대응하는 대상(IP / URL)' },
      note: { type: 'string', description: '보충 설명: 이 그림이 무엇을 증명하는지' },
      source_ref: { type: 'string', description: '원본 출처: 스크린샷 저장 경로 또는 runs/ 아래의 증거 파일' },
      captured_at: { type: 'string', description: '스크린샷 시각(ISO), 생략하면 현재 시각' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = store.addShot(id, { ...args, engagement: undefined, agent: agentOf(args) })
      return JSON.stringify({ ok: true, engagement: id, ...result }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_shot_list',
    description: '등록된 증거 스크린샷을 나열합니다(소속 득점 항목, 대상, 유형, 저장 파일 포함).',
    parameters: {
      engagement: { type: 'string' },
      point_code: { type: 'string' },
      hit_id: { type: 'number' },
      asset_id: { type: 'number' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      return JSON.stringify({ ok: true, engagement: id, ...store.listShots(id, {
        point_code: args.point_code, hit_id: args.hit_id, asset_id: args.asset_id,
      }) }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_shot_delete',
    description: '증거 스크린샷 한 장을 삭제합니다(디스크 파일 포함).',
    parameters: {
      engagement: { type: 'string' },
      id: { type: 'number', required: true, description: 'shot id(redteam_shot_list 에서 반환된 id)' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const eng = resolveEngagement(store, exec, args.engagement)
      return JSON.stringify({ ok: true, engagement: eng, ...store.deleteShot(eng, args.id) }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_credential_list',
    description: '수집한 자격 증명을 나열합니다(평문 secret_value 포함). 자격 증명 재사용과 횡적 이동에 사용합니다.',
    parameters: {
      engagement: { type: 'string' },
      host: { type: 'string' },
      username: { type: 'string' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      return JSON.stringify({ ok: true, engagement: id, items: store.listCredentials(id, { host: args.host, username: args.username }) }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_access_add',
    description: '성공적으로 획득한 접근 세션을 기록합니다(횡적 이동의 기점). method 예: vnc/rdp/ssh/web-shell/webshell/db 이고 privilege 예: admin/user/system 입니다.',
    parameters: {
      engagement: { type: 'string' },
      host: { type: 'string', required: true },
      username: { type: 'string' },
      method: { type: 'string', required: true, description: '접근을 획득한 방식' },
      privilege: { type: 'string' },
      asset_id: { type: 'number' },
      session_ref: { type: 'string', description: '세션/증거 참조, 예: runs/session-vnc-10.0.0.5.md' },
      note: { type: 'string' },
      found_by_agent: { type: 'string' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = store.addAccess(id, { ...args, engagement: undefined })
      return JSON.stringify({ ok: true, engagement: id, ...result }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_access_list',
    description: '획득한 접근 세션을 나열합니다.',
    parameters: {
      engagement: { type: 'string' },
      host: { type: 'string' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      return JSON.stringify({ ok: true, engagement: id, items: store.listAccess(id, { host: args.host }) }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_role_prompt_reset',
    description: '역할 시스템 프롬프트를 내장 기본값(최신 템플릿)으로 되돌립니다. 기존 대상에 최신 역할 프롬프트를 적용하고 싶을 때 쓰세요; role 을 생략하면 네 역할 모두 재설정합니다.',
    parameters: {
      engagement: { type: 'string' },
      role: { type: 'string', /* 역할 화이트리스트는 **ROLE_ORDER 에서 파생**: 값을 4 개로 하드코딩했다가 assess 를 놓친 적이 있고,
          프리셋은 주 세션이 이 도구로 자산 정리 역할의 프롬프트를 가져오기를 명시했는데 —— 결과적으로 enum 이 그대로 거부해서,
          자산 정리 하위 에이전트는 역할 제약을 끝내 받지 못했다. 파생 이후에는 새 역할이 추가돼도 빠지지 않는다. */
      enum: ROLE_ORDER },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = store.resetPrompts(id, args.role)
      return JSON.stringify({ ok: true, engagement: id, ...result }, null, 2)
    },
  })))

  /* ---------- WebShell 과 내부망 터널: 공략 중 언제든 재사용해 "나중에 가서 입구가 있다는 걸 잊는" 일을 피한다 ---------- */

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_sessions',
    description: '[매 결정 전후에 반드시 확인] 현재 재사용 가능한 모든 입구를 한 화면으로 개관합니다: 이미 올라간 WebShell, 쓸 수 있는 내부망 터널(수신 주소와 도달 가능 대역 포함), 자격 증명, 접근 세션과 함께 온라인/오프라인 통계를 제시합니다. 내부망을 공략하기 전에 여기를 먼저 보세요. 같은 바퀴를 다시 만들지 말고, 이미 있는 터널도 잊지 마세요.',
    parameters: { engagement: { type: 'string' } },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const summary = store.sessionSummary(id)
      return JSON.stringify({
        ok: true, engagement: id, totals: summary.totals,
        webshells: summary.webshells.map((w) => ({
          id: w.id, url: w.url, type: w.shell_type, pass_key: w.pass_key, privilege: w.privilege,
          status: w.status, asset_ip: w.asset_ip, last_check: w.last_check, note: w.note,
        })),
        tunnels: summary.tunnels.map((t) => ({
          id: t.id, kind: t.kind, listen: t.listen, entry: t.entry, reach: t.reach,
          entry_kind: t.entry_kind, legit: t.legit,
          status: t.status, asset_ip: t.asset_ip, command: t.command, last_check: t.last_check, note: t.note,
        })),
        hint: '터널 status=active 이면 스캐너에 바로 쓸 수 있습니다: -socks5 <listen> 또는 --proxy socks5://<listen>; webshell status=online 이면 해당 클라이언트로 연결하세요.'
          + ' 주의: legit=false(entry_kind=self-only, 자기 VPS/자체 서버에서만)는 **대상 경계를 넘은 것도, 돌파도 아닙니다**; legit=null 은 entry_kind 미선언이라는 뜻이니 redteam_tunnel_update 로 대상 측 그 한쪽 끝을 보완하세요.',
      }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_webshell_add',
    description: '이미 올라간 WebShell 을 등록합니다. **반드시 비헨더(Behinder) 암호화 웹셸 또는 고질라(Godzilla) 암호화 웹셸을 업로드해야 합니다**——사용자가 콘솔에서 해당 클라이언트로 직접 접속하므로, 원 라이너 마/자체 제작 마/MemShell 은 사용자가 접속할 수 없어 인도 가능한 입구로 치지 않습니다. shell_type 에는 godzilla | behinder 만 넣을 수 있습니다; 정말 다른 형식만 가능할 때는 other 를 넣고 note 에 이유를 밝히세요. 같은 url+pass_key 로 다시 등록하면 병합되어 갱신됩니다. 등록 후에는 모든 역할 에이전트가 재사용할 수 있으니 중복으로 공략하지 마세요.',
    parameters: {
      engagement: { type: 'string' },
      agent: AGENT_PARAM,
      url: { type: 'string', required: true, description: 'WebShell 전체 URL' },
      shell_type: { type: 'string', description: 'godzilla(고질라) | behinder(비헨더); 다른 형식일 때만 antsword/other 을 쓰고 이유를 밝히세요' },
      pass_key: { type: 'string', description: '연결 비밀번호 / 키(behinder 마는 pass, godzilla 는 key)' },
      privilege: { type: 'string', description: '현재 권한, 예: www-data / root / iis' },
      secret_ref: { type: 'string', description: '자격 증명/증거 참조, 예: runs/ws-10.0.0.5.txt(평문 비밀번호를 라이브러리에 적지 마세요)' },
      asset_id: { type: 'number' },
      note: { type: 'string' },
      found_by_agent: { type: 'string' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = store.addWebshell(id, { ...args, engagement: undefined, status: 'online', agent: agentOf(args) })
      return JSON.stringify({ ok: true, engagement: id, ...result }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_webshell_list',
    description: '등록된 WebShell 을 나열합니다(온라인 상태와 마지막 점검 시각 포함).',
    parameters: {
      engagement: { type: 'string' },
      status: { type: 'string', description: 'online | offline | unknown' },
      asset_id: { type: 'number' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      return JSON.stringify({ ok: true, engagement: id, items: store.listWebshells(id, args) }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_webshell_update',
    description: 'WebShell 상태(삭제/오프라인/권한 변경)를 갱신하거나 설명을 보충합니다.',
    parameters: {
      engagement: { type: 'string' },
      id: { type: 'number', required: true, description: 'WebShell 기록 id' },
      status: { type: 'string', description: 'online | offline | dead | unknown' },
      privilege: { type: 'string' },
      note: { type: 'string' },
      check_note: { type: 'string' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const eng = resolveEngagement(store, exec, args.engagement)
      const result = store.updateWebshell(eng, args.id, args)
      return JSON.stringify({ ok: true, engagement: eng, ...result }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_tunnel_add',
    description: '내부망 터널을 하나 등록합니다. **내부망으로 들어가려면 먼저 스킬 suo5-tunnel 로 WebShell/HTTP 를 통해 socks5(kind=suo5)를 세워야 합니다**; 터널이 없으면 내부망 탐지 스크립트를 직접 만들지 마세요. listen 에는 이 PC 에서 쓸 수 있는 주소(예: 127.0.0.1:1080)를, reach 에는 그 터널이 닿을 수 있는 대역을 적습니다. 등록 후 스캐너는 바로 -socks5 <listen> 을 쓸 수 있습니다.\n\n**레드라인: 자기 VPS / 자기가 구성한 서버는 터널로 치지 않습니다.** 자기 서버에서만 연 socks5, frp 서버, 프록시는 대상에 닿지 않았으므로 **대상 경계를 넘은 것도, 경계 돌파나 내부망 돌파도 아닙니다**(이런 경우 entry_kind=self-only 로 적으면 "돌파 아님"으로 표시됩니다). **대상 측의 그 한쪽 끝을 반드시 밝혀야 합니다**:\n· target-outbound — 대상이 먼저 우리 쪽으로 접속( **자기 서버가 대상의 리버스 shell 을 받음**, 대상에서 frp/Stowaway 클라이언트 실행);\n· target-http — 대상의 WebShell/HTTP 통로 경유(suo5, Neo-ReGeorg, reGeorg);\n· target-agent — 대상에서 이미 제어 중인 프로세스/세션을 통한 포워딩(대상이 시작한 SSH -R 등).',
    parameters: {
      engagement: { type: 'string' },
      agent: AGENT_PARAM,
      kind: { type: 'string', required: true, description: 'suo5(우선, WebShell/HTTP 경유) | socks5 | ssh-r | frp | chisel | other' },
      listen: { type: 'string', required: true, description: '로컬 수신 주소 host:port' },
      entry: { type: 'string', description: '입구: WebShell URL / 점프 호스트 / 명령' },
      reach: { type: 'string', description: '도달 가능 대역, 예: 10.0.0.0/8' },
      entry_kind: { type: 'string', description: '[중요] 통로의 대상 측 그 한쪽 끝이 무엇인지: target-outbound(대상이 우리 쪽으로 리버스 shell / 대상에서 frp 클라이언트 실행) | target-http(대상 WebShell 의 suo5/Neo-ReGeorg 경유) | target-agent(대상에서 제어 중인 프로세스로 포워딩) | self-only(자기 VPS/자체 서버에서만, **돌파 아님**)' },
      webshell_id: { type: 'number', description: '어느 WebShell 로 세웠는지' },
      asset_id: { type: 'number' },
      command: { type: 'string', description: '구성 명령, 재구성에 편리하도록' },
      pid: { type: 'string' },
      note: { type: 'string' },
      found_by_agent: { type: 'string' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = store.addTunnel(id, { ...args, engagement: undefined, status: 'active', agent: agentOf(args) })
      return JSON.stringify({ ok: true, engagement: id, ...result }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_tunnel_list',
    description: '등록된 내부망 터널을 나열합니다(상태, 수신 주소, 도달 가능 대역, entry_kind 와 legit 판정 포함). **legit=false 는 자기 VPS/자체 서버에서만 연 통로라 대상 경계를 넘지도, 돌파하지도 않았다는 뜻입니다**; legit=null 은 entry_kind 미선언입니다.',
    parameters: {
      engagement: { type: 'string' },
      status: { type: 'string', description: 'active | down | unknown' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      return JSON.stringify({ ok: true, engagement: id, items: store.listTunnels(id, args) }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_tunnel_update',
    description: '터널 상태(종료/무효/수신 주소 변경)를 갱신하거나 entry_kind 판정을 보완합니다. 터널을 다 썼으면 반드시 down 으로 표시하고 설명해 이후 오용을 막으세요. **옛 기록에 입구 귀속이 선언되지 않은 경우(legit=null, 화면에 "확인 대기" 표시), entry_kind 로 대상 측 그 한쪽 끝을 보완하세요**, 보완해야 돌파 증빙이 됩니다.',
    parameters: {
      engagement: { type: 'string' },
      id: { type: 'number', required: true },
      status: { type: 'string', description: 'active | down | closed | unknown' },
      listen: { type: 'string' },
      reach: { type: 'string' },
      entry: { type: 'string', description: '입구: WebShell URL / 점프 호스트 / 명령' },
      entry_kind: { type: 'string', description: '대상 측 그 한쪽 끝 보완 선언: target-outbound | target-http | target-agent | self-only(자기 서버에서만, 돌파 아님)' },
      note: { type: 'string' },
      check_note: { type: 'string' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const eng = resolveEngagement(store, exec, args.engagement)
      const result = store.updateTunnel(eng, args.id, args)
      return JSON.stringify({ ok: true, engagement: eng, ...result }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_session_check',
    description: '모든 WebShell 과 터널의 연결성을 실측합니다(host 측에서 실제 HTTP / TCP 연결을 일으킵니다. 온라인/오프라인 상태를 데이터베이스에 되씁니다. 작업 시작 전과 장시간 작업 후에 한 번씩 실행하세요.',
    parameters: {
      engagement: { type: 'string' },
      timeoutMs: { type: 'number', description: '단일 탐지 타임아웃, 기본값 6000ms' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = await store.probeSessions(id, { timeoutMs: args.timeoutMs })
      const online = result.webshells.filter((w) => w.status === 'online').length
      const active = result.tunnels.filter((t) => t.status === 'active').length
      return JSON.stringify({
        ok: true, engagement: id, checked_at: result.checkedAt,
        summary: `WebShell 온라인 ${online}/${result.webshells.length}, 터널 사용 가능 ${active}/${result.tunnels.length}`,
        webshells: result.webshells, tunnels: result.tunnels,
      }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_attack_path',
    description: '공격 그래프를 내보냅니다: 자산 토폴로지 + 취약점 노드 + 이미 제어한 자산(meta.owned). 횡적 이동 경로 계획과 전과 보고에 사용합니다. 노드가 너무 많으면 cidr 로 범위를 좁히세요.',
    parameters: {
      engagement: { type: 'string' },
      cidr: { type: 'string' },
      maxNodes: { type: 'number', description: '기본값 400' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const maxNodes = Math.min(Number(args.maxNodes) || 400, 1500)
      const graph = store.attackGraph(id, { cidr: args.cidr })
      if (graph.nodes.length > maxNodes) {
        return JSON.stringify({
          ok: false,
          error: '그래프 노드가 너무 많습니다(' + graph.nodes.length + ' > ' + maxNodes + '), cidr 를 지정해 범위를 좁히세요',
          summary: graph.summary,
        }, null, 2)
      }
      return JSON.stringify({
        ok: true, engagement: id, summary: graph.summary,
        owned: graph.nodes.filter((n) => n.meta && n.meta.owned).map((n) => n.label),
        nodes: graph.nodes, edges: graph.edges,
      }, null, 2)
    },
  })))

  /* ================================================================== 도메인 / Web 자산 */

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_web_list',
    description: 'Web 자산을 나열합니다(바로 접근 가능한 URL 과 페이지 제목 포함). Web 침투 전에 여기를 먼저 보고, 인터페이스부터 공략하세요.',
    parameters: {
      engagement: { type: 'string' },
      cidr: { type: 'string' },
      limit: { type: 'number' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = store.listWeb(id, { cidr: args.cidr, limit: args.limit })
      return JSON.stringify({
        ok: true, engagement: id, total: result.total,
        items: result.items.map((w) => ({
          url: w.url || ('http' + (w.port === 443 || w.port === 8443 || w.port === 9443 ? 's' : '') + '://' + w.ip + (w.port === 80 || w.port === 443 ? '' : ':' + w.port)),
          title: w.title, ip: w.ip, segment: w.segment_cidr, port: w.port,
          service: [w.service, w.product, w.version].filter(Boolean).join(' '),
          provenance: w.provenance, asset_id: w.asset_id,
        })),
      }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_domain_index',
    description: '도메인 차원으로 자산을 집계합니다: 각 도메인에 어떤 IP/자산이 연결되었는지. 주 도메인, 서브도메인, C 대역의 관계를 정리할 때 사용합니다.',
    parameters: { engagement: { type: 'string' } },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      return JSON.stringify({ ok: true, engagement: id, items: store.domainIndex(id) }, null, 2)
    },
  })))

  /* ================================================================== 득점 목표 */

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_score_list',
    description: '득점 목표 패널을 봅니다: 모든 득점 항목(이름/분류/점수/획득 여부/적중 증거)과 총점 진행률. **다음 단계를 계획할 때마다 여기를 먼저 보세요**, 점수 높낮이로 무엇을 먼저 공략할지 정합니다.',
    parameters: { engagement: { type: 'string' } },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = store.listScorePoints(id, {})
      /* 병합판의 8 개 분류로 묶어 반환한다: 에이전트가 "어떤 분류를 아직 공략하지 않았고, 항목별 상한을 얼마나 썼는지"를 한눈에 보도록 */
      const groups = (result.ruleGroups || []).map((g) => ({
        category: g.name,
        items: g.tiers.length,
        points: g.points,
        cap_sum: g.capSum,
      }))
      return JSON.stringify({
        ok: true, engagement: id, summary: result.summary,
        groups,
        items: result.items.map((p) => ({
          id: p.id, code: p.code, name: p.name, category: p.category, points: p.points,
          /* 병합판의 등급 설명(한 항목에 여러 등급이 있으면, 득점 시 points 인자로 이번 등급의 점수를 지정한다) */
          tier: p.tier, cap: p.cap, cap_used: p.cap_used, dedup_scope: p.dedup_scope,
          scope_label: p.scope_label,
          enabled: p.enabled, achieved: p.hits.length > 0, hits: p.hits.length,
          counted: p.counted, earned: p.earned,
          /* 그 항목이 득점 기준 / 상한 도달 때문에 점수로 잡히지 않은 건수(정지 신호로 삼고, 같은 항목을 계속 긁지 말 것) */
          capped: p.capped,
          /* 두 필드는 역할이 다르다: service_summary 는 "이 항목이 왜 적중이 있는데도 득점이 안 되는지"를 설명하는 통짜 문장이고;
             capped_reason 은 **적중 건별** 구체적 사유(hits[] 안)를 위해 남겨 두며, 요약으로 그것을 대신하지 말 것. */
          capped_summary: p.service_summary,
          evidence: p.hits.map((h) => (h.target ? h.target + ':' : '') + h.evidence).slice(0, 3),
        })),
      }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_score_hit',
    description: '득점을 한 번 기록합니다. 득점 규칙은 "돌파 침입류 득점 규칙(병합판)"에 따라 **25 항목**(1. 권한 획득 21 항목 + 2. 네트워크 경계 돌파 4 항목, 총 8 개 분류)으로 재구성되었고,'
      + '별도로 8 조의 범용 규칙 G1–G8 이 모든 항목에 가로로 적용됩니다. **득점 전에 `redteam_score_list` 로 실제 code 와 그 항목의 상한/기준을 먼저 읽으세요**, 기억에 의존해 적지 마세요.\n\n'
      + '**증거에는 결과만 적습니다**: 대상 자산 + 무엇을 얻었는지(계정/비밀번호/권한/데이터량). 획득 과정과 경로는 적지 마세요——과정은 공격 득점 체인의 단계가 담당합니다.'
      + '"어느 취약점으로 얻었는지"를 가리킬 수 있으면 vuln_id 를 함께 넣으세요. 보고서가 그 취약점의 원본 요청을 자동으로 첨부합니다.\n\n'
      + '**다등급 항목은 `points` 로 이번 등급의 점수를 지정합니다**: "병합판"은 같은 항목의 여러 등급을 한 줄로 합쳤습니다(예: "서버 호스트 권한" 일반 10 / 관리자 50,'
      + '"도메인 제어 권한" 1 급 50 / 2 급 20, "네트워크 장비 권한" 일반 100 / 관리자 200). 득점 시 `points` 에 이번 실제 등급의 점수를 넣고;'
      + '비우면 그 항목의 주 등급 기본값을 씁니다. **같은 시스템은 최고 권한으로 한 번만 집계합니다**(G1)——일반 등급으로 먼저 기록하고 나중에 관리자 등급으로 권한 상승했다면,'
      + '그리고 관리자 등급을 한 번 더 기록하면(points 에 높은 등급 값) 시스템이 일반 등급 기록을 자동으로 밀어냅니다.\n\n'
      + '**레드라인 1: 계정 계열 득점은 먼저 실제 로그인을 실측해야 합니다.** 계정/비밀번호를 얻었으면 브라우저(browser-automation / kimi-webbridge) 또는 동등한 세션으로'
      + '실제 로그인 성공과 페이지 상호작용 가능 여부를 실측한 뒤에야 계정 권한 점수를 기록합니다——**자격 증명만으로는 계정 획득이 아닙니다**; 로그인되지 않는 것은 redteam_asset_test 의 `test` 인자에 적으세요.\n\n'
      + '**레드라인 2: 자기가 등록한 계정은 득점 권한이 아닙니다.** 셀프 가입, 자기가 만든 사용자/역할/백엔드 계정, 자기가 자기에게 연 권한은 모두 인정되지 않습니다——'
      + '드릴 득점은 **남이 이미 가진** 계정과 권한을 획득하는 것을 대상으로 합니다. 이런 경우 self_created=true 로 기록하고(과정만 남김) 점수도, 건수도, 보고서도 잡지 않습니다.\n\n'
      + '**레드라인 3: 그 항목의 득점 기준(G1/G3)을 확인하세요.** 득점 항목마다 기준이 붙어 있습니다:'
      + '`같은 시스템은 최고 권한만 한 번`/`같은 서비스는 최고 한 건만`/`대상 전체에서 한 번만`(네트워크 경계 돌파)/`대수·카드·개수 단위 누적`(단말, 클라우드 노드, 연산 카드).'
      + '또한 항목마다 **상한**이 있습니다(예: 서버 호스트 600 점, Web 애플리케이션 2000 점, 중앙 집권 시스템 4000 점). 상한에 도달하면 같은 항목은 더 누적되지 않습니다(G3)——'
      + '반환값은 warning 으로 "상한 도달/밀려남"을 알려 주니, 이를 **정지 신호**로 삼아 다른 항목이나 다른 자산으로 넘어가고 같은 항목을 계속 긁지 마세요.\n\n'
      + '**데이터 성과는 따로 득점합니다(G2)**: 메일 데이터, 업무 데이터, 데이터 자산 등은 중요도에 따라 별도로 기록하며 권한 점수와 섞어 계산하지 않습니다;'
      + 'evidence 에는 **실제 데이터량**을 반드시 적어야 합니다(예: "사용자 데이터 1,320,000 건 추출").',
    parameters: {
      engagement: { type: 'string' },
      code: { type: 'string', description: '득점 항목 code(point_id / point_name 중 하나라도 가능); 먼저 redteam_score_list 로 실제 code 를 확인하세요' },
      point_id: { type: 'number' },
      point_name: { type: 'string' },
      points: { type: 'number', description: '[다등급 항목 필수] 이번 적중을 어느 등급으로 득점할지(예: 서버 호스트 권한은 일반 권한 10, 관리자 50; 도메인 제어는 1 급 50, 2 급 20). 비우면 그 항목의 주 등급 기본값을 씁니다.' },
      target: { type: 'string', description: '대상 자산: URL / ip:port / 호스트 이름(**포트를 포함**, 서비스/시스템 기준을 이것으로 판정)' },
      asset_id: { type: 'number', description: '대상 자산의 라이브러리 내 id' },
      port: { type: 'number', description: '[권장] 이 득점이 어느 포트에 해당하는지(기준 판정은 "자산 + 포트"; target 에 이미 포트가 있으면 생략 가능)' },
      vuln_id: { type: 'number', description: '[권장] 어느 취약점으로 얻은 점수인지(보고서가 이를 근거로 원본 요청을 첨부)' },
      step_id: { type: 'number', description: '대응하는 공격 체인 단계 id(선택)' },
      evidence: { type: 'string', required: true, description: '[필수] 결과: 얻은 것, 예: "백엔드 관리자 tomcat/Tomcat@2024(브라우저 로그인 실측 완료)" "데이터베이스 계정 root/xxx" "사용자 데이터 132 만 건 추출". 다등급 항목이면 등급을 밝히세요(예: "관리자 권한").' },
      self_created: { type: 'boolean', description: '[중요] 이 계정/권한이 **자기가 등록·자기가 생성**한 것인가? 그렇다면 true —— 과정 기록만 남기고 점수도, 보고서도 잡지 않습니다. 남이 이미 가진 계정/권한을 얻었으면 넣지 마세요(기본값 false).' },
      note: { type: 'string' },
      recorded_by: { type: 'string' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = store.addScoreHit(id, { ...args, engagement: undefined })
      return JSON.stringify({ ok: true, engagement: id, ...result }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_score_point_save',
    description: '득점 항목을 추가하거나 수정합니다(점수/이름/분류/설명/활성화). 사용자도 화면에서 편집하며, 에이전트는 필요할 때만 씁니다(예: 규칙에 아직 기록되지 않은 득점 항목을 발견했을 때). id 가 있으면 수정이고, id 가 없으면 추가입니다.',
    parameters: {
      engagement: { type: 'string' },
      id: { type: 'number', description: '기존 득점 항목 id(수정 시 전달)' },
      name: { type: 'string', required: true },
      code: { type: 'string', description: '짧은 코드(추가 시 지정 권장, 득점 기록에 편리)' },
      category: { type: 'string', description: '분류, 예: 계정 권한 / 서버 권한 / 데이터베이스 / 네트워크 돌파 / 데이터 / 핵심 목표' },
      points: { type: 'number', description: '점수' },
      description: { type: 'string', description: '득점 조건 설명' },
      enabled: { type: 'boolean' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = store.saveScorePoint(id, { ...args, engagement: undefined })
      return JSON.stringify({ ok: true, engagement: id, ...result }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_asset_assess',
    description: '자산에 "공략 용이성 평가"를 합니다: 어떤 성과를 낼 수 있을지(계정 권한/RCE/서버 권한/데이터베이스 권한/민감 데이터/경계 돌파), 우선순위가 얼마나 높은지, 판단 근거. 정보 수집을 마무리할 때 자산마다 한 번 호출해 지휘자가 가성비 순으로 정렬할 수 있게 합니다.',
    parameters: {
      engagement: { type: 'string' },
      asset_id: { type: 'number' },
      ip: { type: 'string' },
      priority: { type: 'string', enum: ['high', 'medium', 'low'], description: 'high 는 성과가 나기 쉬움 / medium 은 보통 / low 는 공략이 어렵거나 가치가 낮음' },
      potential: { type: 'string', description: '예상 성과, 예: "계정 권한+RCE" "데이터베이스 권한" "대량 민감 정보"' },
      reason: { type: 'string', description: '판단 근거: 핑거프린트 버전이 Nday 에 적중, 인터페이스 미인증, 약한 비밀번호, 데이터베이스 노출, WAF 강약 등' },
      assessed_by: { type: 'string' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = store.assessAsset(id, { ...args, engagement: undefined })
      return JSON.stringify({ ok: true, engagement: id, ...result }, null, 2)
    },
  })))

  /* ================================================================== 증거 / 공격 체인 / 보고서 */

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_http_evidence_add',
    description: 'HTTP 증거를 하나 저장합니다: 원본 요청과 응답. 보고서는 이를 Burp Suite / Yakit 에 붙여넣을 수 있는 원본 메시지로 렌더링하므로, request 는 완전하고 재전송 가능한 원본 요청이어야 합니다(요청 라인, Host 등 헤더, 필요 시 body 포함).',
    parameters: {
      engagement: { type: 'string' },
      vuln_id: { type: 'number', description: '연관된 취약점 id(지정 권장)' },
      asset_id: { type: 'number' },
      label: { type: 'string', description: '이 증거의 용도, 예: "권한 우회로 사용자 목록 읽기"' },
      method: { type: 'string', description: 'GET/POST/…' },
      url: { type: 'string' },
      status: { type: 'number', description: '응답 상태 코드' },
      request: { type: 'string', required: true, description: '원본 요청 전문(Burp 에 바로 붙여넣기 가능)' },
      response: { type: 'string', description: '응답 전문 또는 핵심 조각' },
      note: { type: 'string' },
      captured_by: { type: 'string', description: '수집 역할' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = store.addHttpEvidence(id, { ...args, engagement: undefined })
      return JSON.stringify({ ok: true, engagement: id, ...result }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_chain_add',
    description: '공격 체인 단계를 하나 기록합니다. **보고서의 "이 단계가 어떻게 나왔는가"는 전적으로 이 기록에 달려 있습니다**: 계정 비밀번호를 어떻게 얻었는지, 비헨더 웹셸을 어떻게 올렸는지, 터널을 어떻게 세웠는지를 모두 여기에 `tool`(실제 명령 원문) + `detail`(왜 그렇게 했고 단서가 어디서 왔는지) + `result`(실제 응답 출력/결과)로 밝혀 적어야 합니다. 공격 체인 페이지와 보고서는 seq 순으로 정렬해 보여줍니다.',
    parameters: {
      engagement: { type: 'string' },
      agent: AGENT_PARAM,
      stage: { type: 'string', required: true, enum: ['recon', 'vuln', 'exploit', 'access', 'pivot', 'data', 'other'], description: '동작 유형(호환 필드): recon 정보 수집 | vuln 취약점 발견 | exploit 익스플로잇 | access 권한 획득 | pivot 내부망 돌파 | data 민감 데이터 | other (기타). **단계 귀속은 stage_code 로** 하고, 이 필드는 옛 데이터 폴백에만 씁니다.' },
      title: { type: 'string', required: true, description: '이 단계가 무엇을 했는지 한 문장, 예: "백엔드 템플릿 업로드 지점으로 비헨더 웹셸 업로드" "suo5 로 socks5 터널 구성"' },
      detail: { type: 'string', description: '왜 그렇게 했고 단서가 어디서 왔는지, 예: "로그인 페이지에서 버전 Coremail XT 5.0 노출 → CVE-2023-xxxx 매칭 → 백엔드 템플릿 관리에서 업로드 가능"' },
      tool: { type: 'string', description: '[보고서 재현의 핵심] **실제 실행한 명령 원문**, 예: `nuclei -t CVE-2021-xxxx.yaml -u http://x`, `suo5-linux-amd64 -t http://x/shell.jsp -l 1080`, `sqlmap -u "http://x?id=1" --dump`. 이걸 적지 않으면 보고서에서 이 단계를 재현할 수 없습니다.' },
      result: { type: 'string', description: '[보고서 재현의 핵심] 실제 결과/응답 출력 요약, 예: `uid=0(root) gid=0(root)`, "200 반환, 사용자 데이터 1.2 만 건 포함", "백엔드 관리자 tomcat 로그인 성공"' },
      asset_id: { type: 'number' },
      vuln_id: { type: 'number' },
      access_id: { type: 'number' },
      evidence_ref: { type: 'string', description: '증거 파일/세션 참조, 예: runs/session-vnc.md' },
      recorded_by: { type: 'string' },
      point_code: { type: 'string', description: '[이 단계에서 득점했다면 기입] 득점 항목 code(예: rce / webshell / boundary). 서버가 자동으로 득점을 한 번 기록하고 단계와 득점을 서로 연결합니다. **evidence 를 함께 주지 않으면 득점되지 않습니다**(단계는 정상적으로 저장됨).' },
      stage_code: { type: 'string', enum: ['recon', 'internet', 'boundary', 'internal', 'target'], description: '소속 작전 단계(이 5 개만 유효한 값): recon(정보 수집) | internet(인터넷 자산 권한) | boundary(경계 돌파·터널 구축) | internal(내부망 자산 권한) | target(대상 시스템 권한). 다른 값(예: 외부 도구에서 흔한 external/foothold/tunnel/privilege)을 쓰면 무시되고 stage 기준 폴백으로 돌아가므로, 단계가 어디에도 속하지 않게 됩니다.' },
      evidence: { type: 'string', description: 'point_code 와 함께 사용: 이 득점으로 무엇을 얻었는지(대상 자산 + 계정/권한/데이터량)——**비우면 득점되지 않습니다**.' },
      self_created: { type: 'boolean', description: 'point_code 와 함께 사용: 이 단계에서 얻은 계정/권한이 **자기가 등록·자체 구축**한 것인가? 그렇다면 true(과정만 남기고 득점 없음)' },
      target: { type: 'string', description: 'point_code 와 함께 사용: 대상 자산' },
      seq: { type: 'number', description: '비우면 체인 끝에 자동으로 추가' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = store.addChainStep(id, { ...args, engagement: undefined, agent: agentOf(args), recorded_by: args.recorded_by || args.agent })
      /* 단계를 저장한 뒤 두 가지를 상기시킨다: 보고서에 쓸 tool/result 를 적었는지, 이 단계의 득점을 기록했는지 */
      const hints = []
      if (!args.tool) hints.push('이 단계에 `tool`(실제 명령)을 적지 않았습니다: 보고서의 "어떻게 했는지"가 공백이 되니, 명령을 적은 단계를 하나 보강하세요.')
      if (!args.result) hints.push('이 단계에 `result`(실제 응답 출력/결과)를 적지 않았습니다: 보고서 재현 시 "뚫렸는지"의 증거가 빠집니다.')
      if (result && result.score_hint) hints.push(result.score_hint)
      return JSON.stringify({ ok: true, engagement: id, ...result, hints: hints.length > 0 ? hints : undefined }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_chain',
    description: '전체 공격 체인을 단계 순서로 읽습니다. 보고와 체인이 닫혔는지(입구 → 권한 → 내부망 돌파) 점검할 때 사용합니다.',
    parameters: { engagement: { type: 'string' } },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      return JSON.stringify({ ok: true, engagement: id, items: store.listChain(id) }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_attack_file_add',
    description: '**실제로 효과가 있었던** 공격 파일(스크립트/POC/EXP/사전)을 대상 폴더에 저장해 재사용과 인도에 씁니다. 디렉터리 구조: attack-files/<IP|URL 호스트|C 대역>/<파일 이름>. evidence 는 필수이며 검증 효과를 명확히 적어야 합니다(예: "응답 출력 uid=0", "미승인 상태로 200 반환 및 데이터 포함")——**뚫지 못했거나 시도만 해 본 스크립트는 넣지 마세요**.',
    parameters: {
      engagement: { type: 'string' },
      target: { type: 'string', required: true, description: '대상: IP, URL 또는 C 대역(같은 IP 의 여러 포트는 그 IP 폴더로 모임)' },
      name: { type: 'string', required: true, description: '파일 이름, 예: cve-2021-22893.sh / vnc_brute.py' },
      kind: { type: 'string', enum: ['poc', 'exp', 'script', 'wordlist', 'other'], description: '유형: poc 검증 / exp 익스플로잇 / script 스크립트 / wordlist 사전' },
      description: { type: 'string', description: '이 파일이 하는 일(한 문장)' },
      evidence: { type: 'string', required: true, description: '유효성 증거: 실제로 뚫린 출력/응답/영향, 또는 대응하는 취약점/증거 id' },
      content: { type: 'string', description: '파일 내용(path 와 둘 중 하나)' },
      path: { type: 'string', description: '이미 있는 파일 경로(대상 디렉터리 기준 상대 경로 또는 절대 경로), 대상 폴더로 복사됩니다(content 와 둘 중 하나)' },
      asset_id: { type: 'number' },
      vuln_id: { type: 'number' },
      created_by: { type: 'string' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = store.addAttackFile(id, { ...args, engagement: undefined })
      return JSON.stringify({ ok: true, engagement: id, ...result }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_attack_file_list',
    description: '저장된 공격 파일을 나열합니다(대상 폴더별 그룹). 어떤 대상을 공략하기 전에 여기를 먼저 보고 같은 바퀴를 다시 만들지 마세요.',
    parameters: {
      engagement: { type: 'string' },
      target: { type: 'string', description: '특정 대상만 보기' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      if (args.target) return JSON.stringify({ ok: true, engagement: id, items: store.listAttackFiles(id, { target: args.target }) }, null, 2)
      return JSON.stringify({ ok: true, engagement: id, folders: store.attackFileTree(id) }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_report_targets',
    description: '[사용 중단, redteam_score_report 사용] 대상별 성과 보고서 조회( IP / URL / C 대역마다 한 부): 성과 취약점(Burp/Yakit 에 붙여넣을 수 있는 원본 요청 포함), 획득한 권한, 자격 증명, 공격 파일, 공격 체인. 대상별 보고나 특정 대상에 무엇이 빠졌는지 점검할 때 사용합니다.',
    parameters: {
      engagement: { type: 'string' },
      target: { type: 'string', description: '특정 대상의 보고서만 보기' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = store.reportTargets(id, {})
      const picked = args.target ? result.targets.filter((t) => t.key === args.target || t.label === args.target) : result.targets
      return JSON.stringify({
        ok: true, engagement: id, generated_at: result.generated_at, totals: result.totals,
        targets: picked.map((t) => ({ key: t.key, label: t.label, segment: t.segment, stats: t.stats })),
      }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_attack_chain',
    description: '공격 체인: 공격면 위치로 이어 붙인 다섯 단계 —— ① 정보 수집(인터넷 측) → ② 인터넷 자산 권한 → ③ 경계 돌파(터널 구축) → ④ 내부망 자산 권한 → ⑤ 대상 권한. 각 단계의 단계 목표, **실제로 얻은 점수와 누적 점수**, 관련 자산, 그리고 경계 돌파 단계의 실제 터널을 반환합니다. 작업 시작 시 \"지금 몇 번째 단계이고 다음에 어느 단계를 공략해야 하는지\"를 확인하고, 보고할 때는 단계별로 결론을 냅니다.',
    parameters: { engagement: { type: 'string' } },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const chain = store.scoreChain(id)
      return JSON.stringify({
        ok: true, engagement: id,
        totals: { points: chain.summary.points, totalPoints: chain.summary.totalPoints, hits: chain.summary.hits,
          /* 서비스 단위 상한(같은 자산 같은 포트는 한 번만 계산)에 걸려 득점되지 않은 건수: 계정 유형/데이터베이스 권한 */
          serviceCappedHits: chain.summary.serviceCappedHits || 0 },
        stages: (chain.stages || []).map((st) => ({
          code: st.code, name: st.name, goal: st.goal,
          points: st.points, cumulative: st.cumulative, counted: st.counted, hits: st.hits,
          steps: st.steps, tools: st.tools,
          methods: (st.sections || []).map((x) => x.label + ':' + (x.items || []).join(',')),
          scored: st.items.map((x) => ({ point: x.point_name, points: x.points, counted: x.counted, target: x.target,
            service: x.service || null, capped: x.capped === true, capped_reason: x.capped_reason || null })),
          assets: (st.assets || []).map((a) => a.ip + (a.scope === 'internal' ? '(내부망)' : '(외부망)') + ' 기여 ' + a.points + ' 점'),
          tunnels: (st.tunnels || []).map((t) => t.kind + ' ' + t.listen + ' [' + t.status + '] 도달 가능 ' + (t.reach || '—')),
        })),
        hint: '득점 단계는 자동으로 유도됩니다(core-system → 대상, boundary → 경계 돌파, 나머지는 자산의 내부망/외부망 귀속). 공격 체인 단계를 쓸 때 stage_code 를 붙여야( recon/internet/boundary/internal/target 만 허용) 단계 집계가 올바른 단계에 떨어지고, 다른 값을 쓰면 무시됩니다. 계정 권한과 데이터베이스 권한은 "같은 자산 같은 포트" 기준으로 상한이 적용됩니다: 한 서비스에서 최고 권한을 얻으면 만점이고, 같은 서비스에 중복으로 걸리면 capped=true 로 표시되고 득점되지 않습니다.',
      }, null, 2)
    },
  })))


  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_score_report',
    description: '공격 득점 체인 재현 보고서: "득점한" 성과만 수록하고(득점하지 못한 취약점은 보고서에 들어가지 않음), 각 항목에 Yakit Repeater 에 바로 붙여넣어 재현할 수 있는 원본 요청을 최대한 첨부합니다. 인도용 보고서가 필요할 때 redteam_report 대신 이걸 쓰세요.',
    parameters: {
      engagement: { type: 'string' },
      limit: { type: 'number', description: '최대 항목 수, 기본 500' },
      markdown: { type: 'boolean', description: 'true= markdown 전문 반환(기본 true); false= 항목 요약만 반환' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const r = store.scoreReport(id, { limit: args.limit })
      if (args.markdown === false) {
        return JSON.stringify({ ok: true, engagement: id, summary: r.summary,
          items: r.items.map((x) => ({ seq: x.seq, point: x.point_name, points: x.points, counted: x.counted,
            target: x.target, gained: x.gained, requests: x.requests.length, missing_evidence: x.missing_evidence })) }, null, 2)
      }
      return JSON.stringify({ ok: true, engagement: id, summary: r.summary, markdown: r.markdown }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_report',
    description: '[사용 중단, redteam_score_report 사용] 성과 보고서 생성(Markdown): **검증 완료/익스플로잇 완료이고 중위험 이상**인 성과 취약점(각 항목에 Burp/Yakit 에 붙여넣을 수 있는 원본 요청 첨부), 공격 체인, 획득한 권한과 자격 증명, 수정 권고만 수록합니다. 정보 수집 자산 목록, 검증 대기/오탐, 저위험과 정보성 경미 항목은 보고서에 나타나지 않습니다. 발견을 보고서에 넣고 싶다면: 먼저 redteam_vuln_update 로 confirmed(검증 통과) 또는 exploited(익스플로잇 성공)로 설정하고, redteam_http_evidence_add 로 원본 요청을 보강하세요.',
    parameters: { engagement: { type: 'string' } },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = store.report(id)
      return JSON.stringify({ ok: true, engagement: id, generated_at: result.generated_at, stats: result.stats, markdown: result.markdown }, null, 2)
    },
  })))

  /* 오픈소스 버전에서 지식 베이스 제거: 도구 이름은 유지하고, 실행하면 항상 비활성 응답을 반환한다. */
  const KB_DISABLED = JSON.stringify({ ok: false, error: '오픈소스 버전에서 지식 베이스가 제거되었습니다', disabled: true }, null, 2)

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_poc_search',
    description: '[Nday/1day 공략 전 첫 단계] 먼저 "기성품" 두 층을 조회합니다: ① **지식 베이스**(이 PC 에 축적된 범용 POC/EXP, 대상 간 공유, "검증됨 → 재사용 횟수" 순 정렬) ② **이 PC 의 nuclei 템플릿 라이브러리**(수만 개 템플릿, CVE/컴포넌트 이름으로 바로 적중). 적중하면 바로 사용합니다: 지식 베이스는 redteam_poc_get 으로 전문을 가져오고, 템플릿은 `nuclei -t <상대 경로>` 를 바로 실행합니다. **인터넷에서 다시 찾거나 새로 직접 만들지 마세요**. 두 층에 없을 때만 인터넷 검색이나 직접 작성으로 가고, 효과가 검증되면 redteam_poc_add 로 지식 베이스에 되돌려 채웁니다.',
    parameters: {
      q: { type: 'string', description: '키워드: 컴포넌트+버전, 취약점 이름, 경로 조각, 본문 안의 특징 문자열 모두 가능' },
      cve: { type: 'string', description: 'CVE / CNVD 번호, 예: CVE-2023-21839' },
      component: { type: 'string', description: '컴포넌트/제품 이름, 예: Weblogic, Shiro, Weaver OA, Nacos' },
      kind: { type: 'string', description: 'poc | exp | script | template | payload' },
      category: { type: 'string', description: '**분류**로 필터(다중 값 가능, 쉼표 구분): rce | deserialization | file-upload | sqli | unauthorized | auth-bypass | weak-password | ssrf | xxe | path-traversal | info-leak | privesc | tunnel | other' },
      engagement: { type: 'string', description: '**출처 대상**으로 필터(대상 id 또는 이름 키워드): "특정 기관에서 검증된" 경험만 보기' },
      asset_target: { type: 'string', description: '**발견 자산**으로 필터( IP / 도메인 / URL 조각)' },
      language: { type: 'string', description: 'python | go | java | bash | http | nuclei | js | php' },
      source: { type: 'string', description: 'web(인터넷) | self(직접 작성) | manual(수동) | nuclei-template' },
      verified: { type: 'boolean', description: 'true 이면 실측 검증된 것만 보기(이것들을 우선 사용)' },
      templateLimit: { type: 'number', description: '이 PC 의 nuclei 템플릿 최대 반환 개수, 기본 20' },
      limit: { type: 'number', description: '지식 베이스 항목 상한, 기본 200' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute() {
      return KB_DISABLED
      const items = store.searchPocs(args)
      const stats = store.pocStats()
      const q = args.q || args.cve || args.component || ''
      /* templateStats() / nucleiTemplatesDir() 모두 템플릿 디렉터리를 스캔한다: **한 번의 호출에서 한 번만 계산한다**.
         원래 이 짧은 구간에서 templateStats() 가 연달아 세 번 계산되었다(13k 템플릿 디렉터리를 매번 순회). */
      const tplStats = store.templateStats()
      const tpl = (q || args.category)
        ? store.searchTemplates(q, Math.min(Number(args.templateLimit) || 20, 100), 0, args.category || '')
        : { dir: tplStats.dir || store.nucleiTemplatesDir() || null, total: tplStats.total, items: [], byCategory: tplStats.byCategory }
      const hit = items.length > 0 || (tpl.items || []).length > 0
      return JSON.stringify({
        ok: true,
        knowledge_base: {
          total: stats.total, verified: stats.verified, reused: stats.reused,
          /* 분류 개요: 에이전트가 "어떤 무기를 얼마나 모았는지" 알게 하고, 무엇이 부족한지 파악하게 한다 */
          by_category: (stats.byCategory || []).filter((c) => c.n > 0).map((c) => c.name + ' ' + c.n + ' (검증됨 ' + c.verified + ')'),
          by_engagement: (stats.byEngagement || []).slice(0, 10).map((e) => e.engagement + ' ' + e.n),
        },
        local_templates: {
          dir: tplStats.dir, total: tplStats.total, cve_templates: tplStats.cve, matched: (tpl.items || []).length,
          by_category: (tplStats.byCategory || []).filter((c) => c.n > 0).map((c) => c.name + ' ' + c.n),
        },
        count: items.length,
        hint: hit
          ? '기성품 적중: 지식 베이스 항목은 redteam_poc_get 으로 전문을 가져오고, nuclei 템플릿은 `nuclei -t <템플릿 상대 경로>` 를 바로 씁니다. 사용 후 redteam_poc_use 로 재사용을 한 번 기록합니다.'
          : '지식 베이스와 이 PC 의 템플릿 라이브러리에 모두 없음: 인터넷 검색(web_search / GitHub / ExploitDB / 벤더 공지)이나 직접 작성으로 가고, 효과가 검증되면 반드시 redteam_poc_add 로 지식 베이스에 되돌려 채우세요(category + engagement + asset_target + verified_note 포함).',
        templates: (tpl.items || []).map((t) => ({ path: t.path, name: t.name, severity: t.severity, tags: t.tags })),
        items: items.map((x) => ({
          id: x.id, code: x.code, title: x.title, kind: x.kind, category: x.category, cve: x.cve, component: x.component,
          versions: x.versions, language: x.language, source: x.source, source_url: x.source_url,
          verified: x.verified === 1, verified_note: x.verified_note, hit_count: x.hit_count,
          /* 출처 추적: 어느 경험, 어느 대상, 어느 자산, 언제 만들어졌는지 */
          engagement: x.engagement_name || x.engagement_id || null, asset_target: x.asset_target || null,
          found_by_agent: x.found_by_agent || null, created_at: x.created_at,
          tags: x.tags, usage: x.usage, path: x.path, has_content: x.has_content === 1,
        })),
      }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_poc_get',
    description: '지식 베이스 POC/EXP 한 건의 **전체 내용**(본문 + 사용법 + 검증 기록 + 저장 경로)을 가져옵니다. 그대로 쓰거나 대상 전용 스크립트로 개조할 수 있습니다. id 를 주지 않으면 code(redteam_poc_search 반환의 code 필드)를 쓸 수 있습니다.',
    parameters: {
      id: { type: 'number', description: '지식 베이스 항목 id' },
      code: { type: 'string', description: '지식 베이스 항목의 안정 식별자(search 결과의 code)' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute() {
      return KB_DISABLED
      const row = store.getPoc(args.id !== undefined ? args.id : args.code)
      if (row === undefined) return JSON.stringify({ ok: false, error: '지식 베이스에 이 항목이 없습니다(먼저 redteam_poc_search 로 검색)' }, null, 2)
      return JSON.stringify({ ok: true, ...row }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_poc_add',
    description: '**범용 재사용 가능한** POC/EXP 를 지식 베이스에 넣습니다(대상 간 공유). 인터넷에서 가져온 것, 직접 만든 것, 이미 조정해 검증한 것을 모두 여기에 넣되——정말 유효한 것만 수록하고 출처와 검증 증거를 명확히 적습니다. 판단 기준: **다른 대상에도 쓸 수 있는** 것은 지식 베이스로; 이번 대상에만 유효한 스크립트는 redteam_attack_file_add(공격 파일 페이지)로. 같은 이름(같은 code)은 병합·갱신되므로 버전 업데이트에 쓸 수 있습니다.\n\n**되돌려 채우는 세 가지(빠지면 패널에 분류가 없고 출처를 추적할 수 없음)**: ① `category` 분류; ② `engagement` + `asset_target` —— 이 지식이 어느 대상, 어느 자산에서 발견·검증되었는지; ③ `verified` + `verified_note` 검증 증거.',
    parameters: {
      title: { type: 'string', required: true, description: '제목: 컴포넌트 + 취약점 이름/번호, 예: "Weblogic T3 역직렬화 CVE-2023-21839"' },
      kind: { type: 'string', description: 'poc(검증) | exp(익스플로잇) | script | template | payload' },
      category: { type: 'string', description: '[분류, 기입 권장] rce 원격 명령 실행 | deserialization 역직렬화 | file-upload 파일 업로드 getshell | sqli SQL 주입 | unauthorized 미승인 접근 | auth-bypass 인증 우회/권한 우회 | weak-password 약한 비밀번호 | ssrf | xxe | path-traversal 디렉터리 트래버설/임의 파일 읽기 | info-leak 정보 유출 | privesc 권한 상승/횡적 이동 | tunnel 터널/프록시 | other 기타' },
      cve: { type: 'string', description: 'CVE / CNVD 번호' },
      component: { type: 'string', description: '컴포넌트/제품 이름(컴포넌트별 검색에 편리)' },
      versions: { type: 'string', description: '영향받는 버전 범위' },
      severity: { type: 'string', description: 'critical | high | medium | low' },
      language: { type: 'string', description: 'python | go | java | bash | http | nuclei | js | php' },
      source: { type: 'string', description: 'web(인터넷에서 긁어옴) | self(직접 작성) | manual(수동) | nuclei-template' },
      source_url: { type: 'string', description: '출처 링크(인터넷 출처는 필수, 재확인용)' },
      description: { type: 'string', description: '이 POC 가 하는 일, 원리 요점, 전제 조건' },
      usage: { type: 'string', description: '사용법: 전체 명령행 예시 + 바꿔야 할 파라미터' },
      content: { type: 'string', description: '본문: 스크립트/POC 소스, 원본 요청 패킷, nuclei 템플릿, 호출 단계' },
      path: { type: 'string', description: '이 PC 에 이미 있는 파일 경로도 가능(pocs/ 기준 상대 경로 또는 절대 경로). 지식 베이스가 본문을 읽는다' },
      filename: { type: 'string', description: '본문 저장 파일 이름, 기본값은 언어에 따라 지정(poc.py / poc.sh / poc.yaml…)' },
      verified: { type: 'boolean', description: '실측 검증 여부(**실제 대상에서 검증한 경우에만 true 기입**)' },
      verified_note: { type: 'string', description: '검증 증거: 어느 대상에서, 어떤 응답 출력/결과, 인증이 필요한지' },
      engagement: { type: 'string', description: '[출처 대상] 이 지식이 어느 대상에서 발견/검증되었는지(대상 id 또는 기관 이름 기입)' },
      asset_target: { type: 'string', description: '[발견 자산] 구체적으로 어느 자산/어느 대상에서 검증에 성공했는지, 예: 10.1.2.3:8080 또는 http://oa.demo.com' },
      found_by_agent: { type: 'string', description: '이를 발견한 역할 code(recon / assess / vuln-scan / exploit / internal)' },
      tags: { type: 'string', description: '쉼표로 구분한 태그, 예: "java,역직렬화,rce"' },
      created_by: { type: 'string', description: '어느 역할/에이전트가 축적했는지' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute() {
      return KB_DISABLED
      /* engagement 라는 파라미터 이름은 이 도구에서 "출처 대상"을 뜻하며 "어느 대상에 작용하는지"가 아니다,
         그래서 resolveEngagement 를 타지 않는다; 이름 보정만 하고, id 와 중국어 이름을 모두 기록해 패널 분류에 쓰게 한다. */
      const payload = Object.assign({}, args)
      if (typeof args.engagement === 'string' && args.engagement.trim() !== '') {
        const wanted = args.engagement.trim()
        const hit = store.listEngagements().find((e) => e.id === wanted || String(e.name) === wanted || String(e.name).includes(wanted))
        payload.engagement_id = hit ? hit.id : wanted
        payload.engagement_name = hit ? hit.name : wanted
      }
      const r = store.savePoc(payload)
      const stats = store.pocStats()
      return JSON.stringify({
        ok: true, created: r.created, code: r.poc.code, path: r.path,
        category: r.poc.category, engagement: r.poc.engagement_name || r.poc.engagement_id || null,
        asset_target: r.poc.asset_target || null, created_at: r.poc.created_at,
        verified: r.poc.verified === 1,
        hint: '지식 베이스에 등록됨(분류: ' + (r.poc.category || 'other') + ', 생성 시각: ' + r.poc.created_at + '), '
          + '이후 어떤 대상의 에이전트든 redteam_poc_search 로 바로 적중할 수 있습니다; 지식 베이스 총 ' + stats.total + ' 건.',
      }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_poc_list',
    description: '지식 베이스의 POC/EXP 를 나열합니다(kind/source/component/verified 로 필터 가능, 조건이 없으면 전부). "우리가 이미 보유한 기성 무기가 무엇인지"를 점검해 중복 수집을 피할 때 사용합니다.',
    parameters: {
      kind: { type: 'string' }, source: { type: 'string' }, component: { type: 'string' },
      verified: { type: 'boolean' }, limit: { type: 'number' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute() {
      return KB_DISABLED
      const items = store.searchPocs(args)
      const stats = store.pocStats()
      return JSON.stringify({ ok: true, stats: { total: stats.total, verified: stats.verified, by_kind: stats.byKind, by_source: stats.bySource },
        count: items.length,
        items: items.map((x) => ({ id: x.id, code: x.code, title: x.title, kind: x.kind, cve: x.cve, component: x.component,
          language: x.language, source: x.source, verified: x.verified === 1, hit_count: x.hit_count, tags: x.tags })) }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_poc_update',
    description: '지식 베이스 항목 갱신: 검증 결론 보강(verified + verified_note), 영향 버전 수정, 사용법이나 본문 보강, 태그 변경. **실제 대상에서 검증을 통과했다면 반드시 돌아와 verified 를 true 로 두고 증거를 명확히 적으세요**——이후 에이전트는 검증된 것을 우선 사용합니다.',
    parameters: {
      id: { type: 'number', description: '지식 베이스 항목 id' },
      code: { type: 'string', description: '또는 code 로 항목 지정' },
      patch: {
        type: 'object', additionalProperties: true,
        description: '{ verified, verified_note, versions, usage, description, content, tags, severity, component, cve, source, source_url, language }',
      },
      verified: { type: 'boolean', description: '간편 표기: verified 를 직접 전달' },
      verified_note: { type: 'string', description: '간편 표기: 검증 증거를 직접 전달' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute() {
      return KB_DISABLED
      const patch = Object.assign({}, args.patch || {})
      if (args.verified !== undefined) patch.verified = args.verified
      if (args.verified_note !== undefined) patch.verified_note = args.verified_note
      const row = store.updatePoc(args.id !== undefined ? args.id : args.code, patch)
      return JSON.stringify({ ok: true, id: row.id, code: row.code, verified: row.verified === 1, verified_note: row.verified_note, updated_at: row.updated_at }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_poc_use',
    description: '지식 베이스 POC/EXP 의 재사용을 한 번 기록합니다(어느 대상/목표에 썼는지). 재사용 횟수가 높은 항목이 앞에 정렬되어, 이후 사용자가 실전을 거친 무기를 우선 고르기 쉽습니다.',
    parameters: {
      id: { type: 'number' },
      code: { type: 'string' },
      used_on: { type: 'string', description: '사용처: 대상 이름 / 목표 IP / URL' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute() {
      return KB_DISABLED
      const r = store.markPocUsed(args.id !== undefined ? args.id : args.code, args.used_on)
      return JSON.stringify(r, null, 2)
    },
  })))

  /* ================================================================== 자산 발견 타임라인 */

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_asset_timeline',
    description: '자산 "발견 시각" 뷰: 하루 단위로 "어느 날 자산을 얼마나 모았는지"를 집계하고(내부망/외부망 구분), 최근 발견한 자산을 나열합니다. "이 자산은 언제 발견되었는가"에 답하고, 정보 수집에 단층이 있는지 점검하며, 이번 수집의 마무리 대조에도 사용합니다.',
    parameters: {
      engagement: { type: 'string' },
      limit: { type: 'number', description: '최근 자산 건수, 기본 50' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const data = store.discoveryTimeline(id, { limit: args.limit })
      return JSON.stringify({
        ok: true, engagement: id,
        span: data.span,
        days: data.days,
        recent: data.recent.map((a) => ({
          id: a.id, ip: a.ip, scope: a.scope, state: a.state, name: a.primary_name,
          discovered_at: a.discovered_at, last_seen: a.last_seen, open_ports: a.open_ports, priority: a.priority,
        })),
        hint: '발견 시각 = 이 자산이 **처음으로 이 라이브러리에 들어온** 시각; 반복 수집은 last_seen 만 갱신합니다.'
          + '보고서 부록과 자산 매핑 페이지 모두 이 값을 기준으로 정렬합니다.',
      }, null, 2)
    },
  })))

  function ledgerOf(engagementId) {
    if (typeof store.db !== 'function') throw new Error('레드팀 자산 라이브러리를 사용할 수 없습니다')
    return new EvidenceLedger(store.db(engagementId))
  }
  function unknownsOf(engagementId) {
    if (typeof store.db !== 'function') throw new Error('레드팀 자산 라이브러리를 사용할 수 없습니다')
    return new UnknownRegistry(store.db(engagementId))
  }

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_evidence_record',
    description: '작전 증거를 하나 기록합니다. 핵심 규율: confidence 는 사실대로 적어야 합니다——claimed(하위 에이전트의 구두 보고, 그대로 신뢰 금지) / observed(직접 확인함) / derived( observed 에서 추론) / inferred(추측, 반드시 표기). ev_id 는 내용 해시로 생성되어 한 글자만 바뀌어도 달라지므로, 저장 후 변조 방지 대조에 쓸 수 있습니다. 관련 스킬은 evidence-discipline 입니다.',
    parameters: {
      engagement: { type: 'string' },
      operation: { type: 'string', required: true, description: '작업 이름, 예: "nmap_scan", "webshell_established", "sql_injection_confirmed"' },
      parameters: { type: 'object', additionalProperties: true, description: '호출 파라미터(JSON 객체, 해시에 포함됨)' },
      result: { type: 'object', additionalProperties: true, required: true, description: '정규화된 결과(JSON 객체, 해시에 포함됨)' },
      confidence: { type: 'string', description: 'claimed | observed | derived | inferred, 기본 observed' },
      authority: { type: 'string', description: 'tool-output | database-record | screenshot | request-replay | subagent-report | operator-input, 기본 tool-output' },
      limitations: { type: 'array', items: { type: 'string' }, description: '한계 설명, 예: ["Top1000 포트만 스캔"]' },
      supporting_ev_ids: { type: 'array', items: { type: 'string' }, description: '이 증거를 뒷받침하는 다른 ev_id' },
      source_agent: { type: 'string', description: '어느 하위 에이전트가 산출했는지( claimed 일 때 필수)' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = ledgerOf(id).record({
        operation: args.operation,
        parameters: args.parameters ?? {},
        result: args.result,
        confidence: args.confidence,
        authority: args.authority,
        limitations: args.limitations ?? [],
        supporting_ev_ids: args.supporting_ev_ids ?? [],
        source_agent: args.source_agent,
        recorded_by: agentOf(args),
        engagement_id: id,
      })
      return JSON.stringify({ ok: result.ok, engagement: id, ...result }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_evidence_verify',
    description: '하위 에이전트의 보고와 증거 원장이 일치하는지 대조합니다(hash 수준 대조). matched=false 이면 하위 에이전트가 말을 바꿨거나 과장했거나 라이브러리에 없다는 뜻입니다.',
    parameters: {
      engagement: { type: 'string' },
      operation: { type: 'string', required: true },
      parameters: { type: 'object', additionalProperties: true },
      result: { type: 'object', additionalProperties: true, required: true },
      confidence: { type: 'string' },
      authority: { type: 'string' },
      limitations: { type: 'array', items: { type: 'string' } },
      supporting_ev_ids: { type: 'array', items: { type: 'string' } },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = ledgerOf(id).verify({
        operation: args.operation,
        parameters: args.parameters ?? {},
        result: args.result,
        confidence: args.confidence ?? 'observed',
        authority: args.authority ?? 'tool-output',
        limitations: args.limitations ?? [],
        supporting_ev_ids: args.supporting_ev_ids ?? [],
      })
      return JSON.stringify({ ok: true, engagement: id, ...result }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_evidence_upgrade',
    description: 'claimed / inferred 를 observed 로 승격합니다. verified_result(직접 검증한 응답 출력/데이터)를 반드시 함께 전달해야 합니다.',
    parameters: {
      engagement: { type: 'string' },
      claimed_ev_id: { type: 'string', required: true, description: '승격할 증거 ID' },
      verified_result: { type: 'object', additionalProperties: true, description: '직접 검증한 실제 결과' },
      verified_by: { type: 'string', description: '누가 확인했는지, 기본 coordinator' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = ledgerOf(id).upgrade({
        claimed_ev_id: args.claimed_ev_id,
        verified_result: args.verified_result,
        verified_by: args.verified_by ?? agentOf(args),
      })
      return JSON.stringify({ ok: result.ok, engagement: id, ...result }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_evidence_list',
    description: '증거 원장 항목을 나열합니다( operation / confidence 로 필터 가능). 보고 전에 승격되지 않은 claimed 가 없는지 먼저 확인하세요.',
    parameters: {
      engagement: { type: 'string' },
      operation: { type: 'string' },
      confidence: { type: 'string', description: 'claimed | observed | derived | inferred' },
      limit: { type: 'number' },
      offset: { type: 'number' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const items = ledgerOf(id).list({
        operation: args.operation,
        confidence: args.confidence,
        engagement_id: id,
        limit: args.limit ?? 50,
        offset: args.offset ?? 0,
      })
      return JSON.stringify({ ok: true, engagement: id, items }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_unverified_count',
    description: '현재 대상에 아직 폐루프 검증되지 않은 claimed/inferred 가 몇 건인지 확인합니다. 0 보다 크게 반환되면 보고 시 미검증 건수를 반드시 알려야 합니다.',
    parameters: { engagement: { type: 'string' } },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const count = ledgerOf(id).countUnresolvedClaims(id)
      return JSON.stringify({
        ok: true, engagement: id, unverified_count: count,
        hint: count > 0 ? `아직 ${count} 건의 claimed/inferred 가 폐루프 검증되지 않았습니다, 보고할 때 "확보했다"고 말하지 마세요` : '모든 하위 에이전트 보고를 직접 검증해 폐루프했습니다',
      }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_unknown_record',
    description: '아직 해결되지 않은 작전 문제를 기록합니다. question+domain 이 같으면 중복 제거됩니다.',
    parameters: {
      engagement: { type: 'string' },
      question: { type: 'string', required: true },
      severity: { type: 'string', description: 'low | medium | high | critical, 기본 medium' },
      domain: { type: 'string', description: '예: internal-recon / boundary-break / lateral-movement' },
      recommended_probe: { type: 'string', description: '권장 검증 수단' },
      supporting_ev_ids: { type: 'array', items: { type: 'string' } },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = unknownsOf(id).record({
        question: args.question,
        severity: args.severity ?? 'medium',
        domain: args.domain ?? 'general',
        recommended_probe: args.recommended_probe,
        supporting_ev_ids: args.supporting_ev_ids ?? [],
        engagement_id: id,
        recorded_by: agentOf(args),
      })
      return JSON.stringify({ ok: result.ok, engagement: id, ...result }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_unknown_resolve',
    description: '미해결 문제를 resolved / contradicted / withdrawn 으로 표시합니다.',
    parameters: {
      engagement: { type: 'string' },
      unk_id: { type: 'string', required: true },
      disposition: { type: 'string', required: true, description: 'resolved | contradicted | withdrawn' },
      resolution: { type: 'string', description: '해결 설명' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = unknownsOf(id).resolve(args.unk_id, args.disposition, args.resolution, agentOf(args))
      return JSON.stringify({ ok: result.ok, engagement: id, ...result }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_unknown_list',
    description: '미해결 작전 문제를 나열합니다. 작업을 배분하기 전에 open 항목을 먼저 보세요.',
    parameters: {
      engagement: { type: 'string' },
      status: { type: 'string', description: 'open | investigating | blocked | contradicted | resolved' },
      severity: { type: 'string' },
      limit: { type: 'number' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const items = unknownsOf(id).list({
        status: args.status ?? 'open',
        severity: args.severity,
        engagement_id: id,
        limit: args.limit ?? 50,
      })
      return JSON.stringify({ ok: true, engagement: id, items }, null, 2)
    },
  })))
}
