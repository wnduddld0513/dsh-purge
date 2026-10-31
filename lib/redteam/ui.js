/**
 * RedTeam 콘솔 —— Host 측
 *
 * 역할: 브라우저 측에 Package 전용 HTTP 브리지 `POST /redteam/api` 를 제공한다:
 *   · 자산 라이브러리 관련 op 는 `ctx.redteam`(dsh-redteam-store 가 게시한 프로세스 수준 서비스)로 넘긴다;
 *   · 세션 연결성 op(probeSessions)는 host 측에서 실제로 TCP/HTTP 프로브를 보낸다;
 *   · 스킬 카탈로그 op(skillCatalog / skillRead)는 `ctx.skills` 를 직접 읽어 레드팀 preset
 *     의 standing scope 로 디렉터리를 잡는다——스킬은 DSH 네이티브 skill 체계가 관리한다($DSH_HOME/skills,
 *     프로젝트 .dsh/skills, .agents/skills), 콘솔은 조회만 한다.
 *
 * webServer 를 쓰고 typert/@Remote 를 쓰지 않는 이유: 이 패키지와 store 패키지 모두 의도적으로 외부 의존성 0 을 유지한다
 * (profile 아래에서 node_modules 를 해석할 수 없다), 명명 라우트가 최소이면서 안정적인 접점이다.
 * 교차 출처 요청은 Origin/Host 검사로 막는다(동일 출처 POST 만 통과).
 */
import { fileURLToPath } from 'node:url'
import { resolve, join } from 'node:path'
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { spawn, execFileSync } from 'node:child_process'
import { request as httpsRequest } from 'node:https'
import { dispatch, dispatchAsync } from './store-core.js'
/* 스킬 사용 가능 여부 판정은 redteam_preflight 와 같은 구현을 공유한다(환경 변수 / 로컬 경로 / 자리표시자) */
import { checkSkill, officialSkillSummaries, skillLibraryOf, summarizeSkills } from './skill-availability.js'
import { maxAgentsOf, maxAgentsSourceOf, saveMaxAgents, DEFAULT_MAX_AGENTS, MAX_AGENTS_LIMIT } from './settings.js'
import {
  loadPlatformConfig, mergeConfigEnv, redteamRoot, envAdaptStatus, markEnvAdaptSkip,
  platformSummary, savePlatformConfig, assignToolkitFolder,
} from './platform-config.js'

/** DSH_HOME - 명시적 환경 변수 우선; Windows 에서 HOME 은 흔히 비어 있어 homedir() 로 폴백한다. */
function dshHomeOf() {
  if (process.env.DSH_HOME) return process.env.DSH_HOME
  return join(homedir(), '.dsh')
}

/**
 * 이 패키지에 내장된 스킬 디렉터리 후보.
 * 데스크톱이 profile/node_modules 심볼릭 링크로 로드할 때 import.meta.url 만으로 상대 경로를 이으면
 * 존재하지 않는 위치를 가리킬 수 있다(공백 경로, 해석되지 않은 junction); 그래서 여러 경로를 탐지하고 realpath 한다.
 * index.js 에서 packagePaths 를 가져오지 않아 cordis 플러그인 진입점과 서로 끌어당기지 않는다.
 */
/** `$DSH_HOME` 의 두 가지 가능한 출처(플러그인 프로세스 env 와 호스트 dshHomePath 가 쓰는 home 은 갈라진다). */
function dshHomeCandidates() {
  const out = []
  const push = (p) => { if (p && !out.includes(p)) out.push(p) }
  push(process.env.DSH_HOME)
  push(join(homedir(), '.dsh'))
  return out
}

function resolvePluginSkillsDir() {
  const candidates = []
  try {
    const root = fileURLToPath(new URL('../..', import.meta.url))
    candidates.push(join(root, 'skills', 'redteam'))
  } catch { /* ignore */ }
  try {
    candidates.push(resolve(fileURLToPath(new URL('../../skills/redteam/', import.meta.url))))
  } catch { /* ignore */ }
  /* installBundledSkills 기록 위치: 패키지 내부 경로가 무효여도 스킬을 나열할 수 있다. 두 후보 home 을 모두 탐지한다. */
  for (const home of dshHomeCandidates()) {
    candidates.push(join(home, 'redteam', 'skills'))
    for (const profile of ['desktop', 'web', 'headless']) {
      candidates.push(join(home, 'profiles', profile, 'node_modules', 'dsh-purge', 'skills', 'redteam'))
    }
  }
  /* 공식 $DSH_HOME/skills 는 스캔하지 않는다: 스킬은 이 패키지 / 동기화 사본만 인정한다(업스트림 플러그인 패키지 내 배포와 일치). */
  for (const raw of candidates) {
    if (!raw) continue
    try {
      if (!existsSync(raw)) continue
      const real = realpathSync(raw)
      const md = readdirSync(real).filter((f) => f.endsWith('.md'))
      if (md.length > 0 || /skills[/\\]redteam$/i.test(real) || /[/\\]skills$/i.test(real)) return real
    } catch { /* try next */ }
  }
  return null
}

const PLUGIN_SKILLS_DIR = resolvePluginSkillsDir()

function readOfficialSkill(name) {
  if (typeof name !== 'string' || name.length === 0) return { ok: false, error: 'name 파라미터가 없습니다' }
  const found = officialSkillSummaries().find((skill) => skill.name === name)
  if (!found) return { ok: false, error: '스킬이 존재하지 않습니다: ' + name }
  return {
    ok: true,
    name: found.name,
    description: found.description,
    whenToUse: '',
    provider: 'dsh',
    source: 'official',
    path: found.path,
    content: found.content,
    library: 'official',
  }
}

function officialCatalogItems() {
  return officialSkillSummaries().map((skill) => ({
    name: skill.name,
    description: skill.description,
    whenToUse: '',
    provider: 'dsh',
    source: 'official',
    dir: skill.resourceBase && skill.resourceBase.path,
    path: skill.path,
    modelInvocable: true,
    userInvocable: true,
    fromPlugin: false,
    library: 'official',
    availability: 'listed',
    problems: [],
    needs_user: [],
  }))
}

function withBothLibraries(payload) {
  if (!payload || payload.ok === false || !Array.isArray(payload.items)) return payload
  const redteam = payload.items.map((item) => Object.assign({ library: 'redteam' }, item, {
    library: item.library === 'official' ? 'official' : 'redteam',
  }))
  const seen = new Set(redteam.filter((item) => item.library === 'official').map((item) => item.name))
  const official = officialCatalogItems().filter((item) => !seen.has(item.name))
  const items = redteam.concat(official)
  return Object.assign({}, payload, {
    items,
    total: items.length,
    libraries: {
      redteam: items.filter((item) => item.library !== 'official').length,
      official: items.filter((item) => item.library === 'official').length,
    },
  })
}
/** 디렉터리 비교는 정규화가 필요하다: 레지스트리는 `/a/b/skills` 를 주지만 URL 로 이으면 끝 슬래시가 붙을 수 있다. */
const sameDir = (a, b) => {
  if (a === null || b === null) return false
  try {
    const left = existsSync(a) ? realpathSync(a) : resolve(a)
    const right = existsSync(b) ? realpathSync(b) : resolve(b)
    return left === right
  } catch {
    try { return resolve(a) === resolve(b) } catch { return false }
  }
}

/** Cordis 플러그인 이름. */
export const name = 'dsh-purge-redteam-ui'

/**
 * 하드 의존성은 자산 라이브러리 + HTTP 만 남긴다.
 * skills / agentPresets 는 데스크톱에서 로드 순서가 늦거나 이름이 다르다; 하드 의존성으로 쓰면 전체
 * `/redteam/api` 가 등록되지 않아 UI 의 스킬 라이브러리/지식 라이브러리/SQLite 를 모두 읽을 수 없다.
 */
export const inject = ['redteam', 'webServer']

/** 요청 본문 상한(자산 가져오기가 클 수 있다). */
const MAX_BODY_BYTES = 8 * 1024 * 1024

/* ------------------------------------------------------------------ 버전과 업데이트 */

/** shell 명령을 실행하고 타임아웃을 건다; `{ code, stdout, stderr, timedOut }` 를 반환한다. */
function run(command, args, options = {}) {
  return new Promise((resolvePromise) => {
    let child
    try {
      /* ⚠️ 세 가지를 모두 겪었다:
         · env 는 반드시 process.env 를 명시적으로 넘겨야 한다 —— spawn 기본값은 빈 환경이라 빈 PATH 에서
           npm/pnpm 은 곧바로 `spawn npm ENOENT` 가 된다(버전 검사가 영원히 실패);
         · cwd 는 **실제로 존재하는** 디렉터리여야 한다 —— 없는 경로를 넘겨도 마찬가지로 ENOENT
           (오류가 "명령을 찾을 수 없음"처럼 보여 오판하기 쉽다);
         · Windows 에서 npm/npx/pnpm/yarn 은 모두 .cmd 배치 파일이라 Node 의 spawn 이
           shell 을 거치지 않으면 실행 파일을 찾지 못한다 —— 반드시 `shell: true`(또는 .cmd 확장자 추가)
           여야 PATHEXT 를 해석한다, 그렇지 않으면 레드팀 패널 "새 버전 확인"이 영원히 code=-1 이다. */
      const cwd = typeof options.cwd === 'string' && options.cwd !== '' && existsSync(options.cwd) ? options.cwd : undefined
      const isWin = process.platform === 'win32'
      const needsShim = isWin && /^(npm|npx|pnpm|pnpx|yarn)$/i.test(command)
      child = spawn(needsShim ? `${command}.cmd` : command, args, {
        cwd,
        env: options.env || process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: needsShim,
        windowsHide: isWin,
      })
    } catch (error) {
      resolvePromise({ code: -1, stdout: '', stderr: error && error.message ? error.message : String(error) })
      return
    }
    let stdout = ''
    let stderr = ''
    let settled = false
    const CHILD_IO_CAP = 1 << 20 // 자식 프로세스 stdout/stderr 각 1MB 상한, 통제 불능 자식 프로세스가 호스트를 OOM 시키는 것 방지
    const done = (value) => { if (!settled) { settled = true; resolvePromise(value) } }
    const cleanupPipes = () => {
      try { child.stdout.removeAllListeners(); child.stderr.removeAllListeners() } catch { /* ignore */ }
      try { child.stdout.destroy(); child.stderr.destroy() } catch { /* ignore */ }
    }
    // 자손 kill 처리: child.kill 은 직계 자식만 죽이고 손자(npm → node → tool)는 살아남는다. Windows 는 taskkill /T 로 트리를 죽인다,
    // POSIX 는 SIGKILL 폴백 + process group kill 시도.
    const killTree = () => {
      try { child.kill('SIGKILL') } catch { /* ignore */ }
      try {
        if (process.platform === 'win32' && child.pid) {
          execFileSync('taskkill', ['/T', '/F', '/PID', String(child.pid)], {
            stdio: 'ignore', windowsHide: true, timeout: 2000,
          })
        } else if (child.pid) {
          try { process.kill(-child.pid, 'SIGKILL') } catch { /* group leader 가 아니면 무시 */ }
        }
      } catch { /* taskkill 실패는 상관없다, child.kill 이 이미 먼저 실행됨 */ }
    }
    const timer = setTimeout(() => {
      killTree()
      cleanupPipes()
      done({ code: -1, stdout: stdout, stderr: stderr, timedOut: true })
    }, Math.max(Number(options.timeoutMs) || 30000, 1000))
    child.stdout.on('data', (c) => {
      if (settled) return
      if (stdout.length + c.length > CHILD_IO_CAP) {
        killTree()
        clearTimeout(timer); cleanupPipes()
        done({ code: -1, stdout, stderr, oversize: 'stdout' }); return
      }
      stdout += c.toString('utf8')
    })
    child.stderr.on('data', (c) => {
      if (settled) return
      if (stderr.length + c.length > CHILD_IO_CAP) {
        killTree()
        clearTimeout(timer); cleanupPipes()
        done({ code: -1, stdout, stderr, oversize: 'stderr' }); return
      }
      stderr += c.toString('utf8')
    })
    child.on('error', (error) => {
      clearTimeout(timer); cleanupPipes()
      done({ code: -1, stdout: stdout, stderr: String((error && error.message) || error) })
    })
    child.on('close', (code) => {
      clearTimeout(timer); cleanupPipes()
      done({ code: code === null ? -1 : code, stdout: stdout, stderr: stderr })
    })
  })
}

/** 이 플러그인 패키지 신원(store 셸이 package.json 을 읽은 뒤 붙인다; 읽지 못하면 "알 수 없는 버전"을 보고한다). */
function pluginIdentity(ctx) {
  const store = ctx.redteam
  const info = store && store.plugin ? store.plugin : null
  return {
    name: (info && info.name) || 'dsh-purge',
    version: (info && info.version) || null,
    description: (info && info.description) || '',
    homepage: (info && info.homepage) || null,
  }
}

/**
 * profile 디렉터리: DSH 의 `ctx.baseUrl` 이 바로 그것이다(loader.internal.import(name, profileDir) 의 base).
 * ⚠️ `ctx.baseUrl` 은 실제로 `file:///...` URL 이다 —— 그대로 경로로 join/existsSync 에 넘기면
 *    `node_modules` 가 URL 뒤에 붙고, `updatePreflight` 가 `devLinked` 를 영구히 true 로 판정하며,
 *    이후 패널의 "업데이트" 버튼이 영원히 회색으로 남는다. 반드시 fileURLToPath 로 시스템 경로로 되돌려야 한다.
 */
function profileDirOf(ctx) {
  try {
    const raw = ctx && typeof ctx.baseUrl === 'string' ? ctx.baseUrl : ''
    if (raw) return raw.startsWith('file://') ? fileURLToPath(raw) : raw
  } catch { /* 무시: 변환 실패 시 폴백 경로 */ }
  return join(dshHomeOf(), 'profiles', 'web')
}

/**
 * 환경 적응 op - 패널 EnvTab 이 `$DSH_HOME/redteam/config.json` 을 읽고 쓴다.
 * @returns JSON 결과, 또는 이 op 가 아님을 뜻하는 undefined 값.
 */
function handlePlatformOp(store, request) {
  const op = request && request.op
  if (op !== 'platformConfigGet' && op !== 'platformConfigSave' && op !== 'platformAssignToolkit'
    && op !== 'platformEnvAdaptStatus' && op !== 'platformEnvAdaptSkip') {
    return undefined
  }
  const root = (store && store.root) || redteamRoot()
  // EnvAdaptSendGate 폴링 준비 완료 / "나중에 구성"; 분기가 없으면 프런트엔드는 영원히 ready 를 받지 못한다.
  if (op === 'platformEnvAdaptStatus') return Object.assign({ ok: true }, envAdaptStatus(root))
  if (op === 'platformEnvAdaptSkip') {
    return Object.assign({ ok: true }, markEnvAdaptSkip(root, request.skip === undefined ? true : !!request.skip))
  }
  if (op === 'platformConfigGet') return platformSummary(root)
  if (op === 'platformConfigSave') {
    savePlatformConfig(request.config || {}, root)
    return platformSummary(root)
  }
  return assignToolkitFolder(request.dir, root)
}

/** profile 의 package.json 을 읽는다(의존성 선언 + dsh.profile.bundles). */
function readProfilePackage(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  } catch { return null }
}

/** 패키지 관리자: profile 에 pnpm-lock / pnpm-workspace 가 있으면 pnpm, 없으면 npm 을 쓴다. */
function packageManagerOf(dir) {
  if (existsSync(join(dir, 'pnpm-lock.yaml')) || existsSync(join(dir, 'pnpm-workspace.yaml'))) return 'pnpm'
  return 'npm'
}

/**
 * 업데이트 사전 검사: 설치된 것이 배포판인지(profile 에서 이 패키지 이름을 해석할 수 있는지),
 * 실행 중인 에이전트가 있는지(업데이트는 dsh web 을 재시작하므로 그것들을 끊는다).
 */
async function updatePreflight(ctx) {
  const dir = profileDirOf(ctx)
  const pkg = pluginIdentity(ctx)
  const profilePkg = readProfilePackage(dir)
  const deps = (profilePkg && profilePkg.dependencies) || {}
  const declared = typeof deps[pkg.name] === 'string' ? deps[pkg.name] : null
  const installedDir = join(dir, 'node_modules', pkg.name)
  const blockers = []
  const notes = []

  /* ① 개발 상태(소스 심볼릭 링크): profile 에 이 패키지 이름이 없다 → 패키지 관리자로 업데이트할 수 없다 */
  const devLinked = declared === null && !existsSync(join(installedDir, 'package.json'))
  if (devLinked) {
    blockers.push("이것은 **개발 모드 설치**입니다(profile 의존성에 " + pkg.name + " 가 없고, 소스 심볼릭 링크 또는 수동 마운트 상태). 패키지 관리자 업데이트가 적용되지 않습니다.")
    notes.push("개발 모드 설치는 리포지터리 안에서 업그레이드하세요: `git pull && npm run build:client`, 그다음 DeepSeek Harness 를 재시작합니다.")
  }

  /* ② 실행 중인 에이전트가 있다: 재시작이 그것들을 끊는다 */
  let running = []
  try {
    const subagents = ctx.get('subagents')
    const sessions = ctx.get('sessions')
    if (subagents !== undefined && subagents !== null && sessions !== undefined && sessions !== null && typeof sessions.list === 'function') {
      const roots = sessions.list().filter((s) => {
        const header = s && s.header
        return header && (header.parentSession === undefined || header.parentSession === null)
      })
      for (const root of roots) {
        try {
          const kids = await subagents.listChildren(root.id)
          for (const k of Array.isArray(kids) ? kids : []) {
            if (k && k.kind === 'child' && k.activity === 'running') running.push({ session: String(root.id), label: k.label || String(k.id) })
          }
        } catch { /* 세션 하나를 읽지 못해도 나머지에 영향 없다 */ }
      }
    }
  } catch { /* 레지스트리를 쓸 수 없으면 막지 않는다(보호 계층이 하나 줄 뿐) */ }
  if (running.length > 0) {
    blockers.push("현재 " + running.length + " 개 에이전트가 실행 중입니다(" + running.map((r) => r.label).join(', ') + "): 업데이트는 현재 호스트를 재시작해 이 작업들을 중단시키므로, 모두 끝난 뒤에 업데이트하세요.")
  }
  return { dir, declared, packageManager: packageManagerOf(dir), devLinked, running, blockers, notes }
}

/** package.json 의 homepage/repository 에서 `owner/repo` 를 긁어낸다; 없으면 기본 저장소를 반환한다. */
function githubRepoOf(homepage) {
  const m = String(homepage || '').match(/github\.com[/:]+([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?(?:[/#?].*)?$/i)
  if (m) return `${m[1]}/${m[2]}`
  return 'wnduddld0513/dsh-purge-kr'
}

/** 소박한 JSON 가져오기(10 초 타임아웃, 30xx 자동 이동 없음——api.github.com 은 이동하지 않는다). */
function fetchJsonFromGithub(url) {
  return new Promise((resolveP) => {
    try {
      const req = httpsRequest(url, {
        method: 'GET',
        headers: {
          'user-agent': 'dsh-purge-updater',
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
        },
      }, (res) => {
        if (res.statusCode !== 200) {
          res.resume()
          resolveP({ ok: false, error: `HTTP ${res.statusCode}` })
          return
        }
        let body = ''
        const BODY_CAP = 1 << 20 // 1MB:github tags/releases JSON 은 보통 몇 KB~수십 KB,1MB 면 충분하고 OOM 방지에도 충분
        res.setEncoding('utf8')
        res.on('data', (chunk) => {
          if (body.length + chunk.length > BODY_CAP) {
            try { res.destroy(new Error('body too large')) } catch { /* 무시 */ }
            resolveP({ ok: false, error: '응답 본문이 너무 큽니다' })
            return
          }
          body += chunk
        })
        res.on('end', () => {
          try { resolveP({ ok: true, data: JSON.parse(body) }) }
          catch { resolveP({ ok: false, error: 'JSON 파싱에 실패했습니다' }) }
        })
      })
      // req.setTimeout 은 socket 이 할당된 뒤에야 적용되어 DNS 조회 단계의 멈춤에는 걸리지 않는다. 게다가 setTimeout 폴백.
      const extTimer = setTimeout(() => {
        try { req.destroy(new Error('timeout')) } catch { /* 무시 */ }
        resolveP({ ok: false, error: 'timeout' })
      }, 12000)
      req.setTimeout(10000, () => { try { req.destroy(new Error('timeout')) } catch { /* 무시 */ } })
      req.on('error', (e) => { clearTimeout(extTimer); resolveP({ ok: false, error: String(e && e.message || e) }) })
      req.on('close', () => clearTimeout(extTimer))
      req.end()
    } catch (e) {
      resolveP({ ok: false, error: String(e && e.message || e) })
    }
  })
}

/** 프리릴리스 버전 이름 인식: `-beta`/`-rc`/`-pre` 같은 것은 stable 로 치지 않는다. */
function isPrereleaseName(name) {
  return /[-._](?:alpha|beta|rc|pre|preview|dev|snapshot|test)(?:[-._\d]|$)/i.test(String(name || ''))
}

/** GitHub Tags 폴백: dsh-purge 는 npm 에 배포하지 않으므로 `npm view` 는 반드시 404 다. 안정 tag 만 폴백한다. */
async function checkLatestFromGithub(homepage) {
  const repo = githubRepoOf(homepage)
  const r = await fetchJsonFromGithub(`https://api.github.com/repos/${repo}/tags?per_page=50`)
  if (!r.ok || !Array.isArray(r.data)) return { ok: false, error: r.error || "GitHub 태그를 가져오지 못했습니다" }
  let latest = null
  for (const row of r.data) {
    const name = String(row && row.name || '').trim()
    if (!/^v?\d+\.\d+\.\d+/.test(name)) continue
    const ver = name.replace(/^v/, '')
    /* 프리릴리스 tag (1.2.0-beta.1, 2.0.0-rc1) 의 core 번호가 stable 보다 크면, 그대로 가져오면
       아직 정식 배포되지 않은 버전을 "최신"으로 취급하게 된다 —— update.js 의 latestStableVersion 기준을 재사용해
       건너뛴다. */
    if (isPrereleaseName(ver)) continue
    if (!latest || versionLess(latest, ver)) latest = ver
  }
  if (!latest) return { ok: false, error: "GitHub 에 사용 가능한 안정 버전 태그가 없습니다" }
  return { ok: true, latest, registry: 'github' }
}

/** npm registry 에서 최신 버전을 조회한다(패키지 관리자를 거쳐 자체 네트워크 스택을 피한다). dsh-purge 는 npm 에 없음 → GitHub 로 바로 간다. */
async function checkLatest(ctx, dir, name) {
  const pkg = pluginIdentity(ctx)
  const pm = packageManagerOf(dir)
  const args = ['view', name, 'version', '--json']
  const r = await run(pm, args, { cwd: dir, timeoutMs: 60000 })
  if (r.code === 0) {
    const raw = String(r.stdout || '').trim().replace(/^"|"$/g, '')
    const latest = raw.split('\n').map((x) => x.trim().replace(/^"|"$/g, '')).filter(Boolean).pop() || null
    if (latest) return { ok: true, latest, registry: pm }
  }
  /* npm 폴백 실패(가장 흔한 것은 404——dsh-purge 는 npmjs 에 아예 배포하지 않았다, 업스트림 issue #93) 또는 Windows
     PATH 가 설정되지 않은 ENOENT, 모두 GitHub Tags 로 간다: 이것이 이 저장소의 권위 있는 버전 소스다. */
  const gh = await checkLatestFromGithub(pkg.homepage)
  if (gh.ok) return gh
  const stderr = String(r.stderr || r.stdout || '').trim().slice(0, 400)
  return { ok: false, error: `Failed to query the latest version (${pm} view: ${stderr || 'code ' + r.code}; github: ${gh.error})` }
}

/** `a < b` (숫자 구간만 비교하면 충분하다; 프리릴리스 접미사는 "더 오래됨"으로 처리한다). */
function versionLess(a, b) {
  const parse = (v) => String(v || '').split('-')[0].split('.').map((x) => Number(x) || 0)
  const [x, y] = [parse(a), parse(b)]
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
    if ((x[i] || 0) < (y[i] || 0)) return true
    if ((x[i] || 0) > (y[i] || 0)) return false
  }
  return false
}

/**
 * 재시작 스크립트: 기존 프로세스가 종료되고 + 포트가 해제되기를 기다린 뒤, 같은 인자로 dsh web 을 다시 띄운다.
 *
 * 생성되는 것은 **자기 완결형 node 스크립트**다(shell 스크립트가 아니다), 이것이 세 가지를 한다:
 *   ① 기존 pid 가 종료되기를 기다린다(최대 60 초);
 *   ② 포트가 더 이상 리슨되지 않기를 기다린다(최대 30 초, net 으로 탐지, ss/lsof 에 의존하지 않는다);
 *   ③ spawn(command, ARGS_ARRAY) 로 argv 배열을 넘겨 새 프로세스를 띄운다.
 *
 * shell 을 쓰지 않는 이유: 원래 구현은 명령과 인자를 shell 문자열로 이어 붙여, 손으로 짠 인용부호 이스케이프가 필요했다
 * (작은따옴표 안에 작은따옴표, 큰따옴표를 다시 이스케이프), 어느 한 곳만 빠져도 명령 주입이다 ——
 * 그리고 이 스크립트는 바로 "프로그램이 생성하고, 사용자 신원으로 실행"되는 것이라 주입 표면이 가장 없어야 한다.
 * argv 배열을 spawn 에 넘긴 뒤에는 shell 이 전혀 개입하지 않아, 이스케이프 문제가 뿌리째 사라진다.
 *
 * @param pid - 현재 프로세스 pid (그것이 종료되기를 기다린다).
 * @param port - dsh web 포트 (해제되기를 기다린다).
 * @param command - 실행 파일 (보통 process.argv[0]).
 * @param args - 인자 배열 (process.argv.slice(1)).
 * @param logPath - 로그 파일 경로 (추가 기록).
 * @param cwd - 새 프로세스의 작업 디렉터리.
 * @returns 스크립트 본문.
 */
function restartScript(pid, port, command, args, logPath, cwd) {
  const payload = {
    oldPid: Number(pid),
    port: Number(port) || 0,
    command: String(command),
    args: args.map((a) => String(a)),
    log: String(logPath),
    cwd: String(cwd),
  }
  return [
    '#!/usr/bin/env node',
    '/* RedTeam 콘솔의 "자동 업데이트"가 생성: 기존 dsh web 이 종료된 뒤, 원래 argv 로 다시 띄운다.',
    '   인자는 배열 형태로 spawn 에 전달된다 —— shell 이 개입하지 않으므로 인용부호 이스케이프와 명령 주입 문제가 없다. */',
    "'use strict'",
    'const { spawn } = require("node:child_process")',
    'const { appendFileSync, mkdirSync } = require("node:fs")',
    'const { connect } = require("node:net")',
    'const { dirname } = require("node:path")',
    'const CFG = ' + JSON.stringify(payload, null, 2),
    '',
    'const log = (msg) => {',
    '  const line = "[" + new Date().toISOString() + "] " + msg + "\\n"',
    '  try { mkdirSync(dirname(CFG.log), { recursive: true }); appendFileSync(CFG.log, line) } catch (e) { /* 로그를 쓰지 못해도 재시작에 영향을 주면 안 된다 */ }',
    '}',
    '',
    'const sleep = (ms) => new Promise((r) => setTimeout(r, ms))',
    '',
    '/** 기존 프로세스가 아직 있는가 (kill -0 의 등가물). */',
    'const alive = (pid) => { try { process.kill(pid, 0); return true } catch (e) { return false } }',
    '',
    '/** 포트를 아직 누군가 리슨하고 있는가 (ss/lsof 에 의존하지 않는다). */',
    'const portBusy = (port) => new Promise((resolve) => {',
    '  if (!port) { resolve(false); return }',
    '  const sock = connect({ host: "127.0.0.1", port: port })',
    '  let done = false',
    '  const finish = (busy) => { if (!done) { done = true; try { sock.destroy() } catch (e) {} resolve(busy) } }',
    '  sock.setTimeout(800)',
    '  sock.on("connect", () => finish(true))',
    '  sock.on("timeout", () => finish(false))',
    '  sock.on("error", () => finish(false))',
    '})',
    '',
    'async function main() {',
    '  log("기존 프로세스 pid=" + CFG.oldPid + " 종료 대기…")',
    '  for (let i = 0; i < 60; i += 1) {',
    '    if (!alive(CFG.oldPid)) break',
    '    await sleep(1000)',
    '  }',
    '  for (let i = 0; i < 30; i += 1) {',
    '    if (!(await portBusy(CFG.port))) break',
    '    await sleep(1000)',
    '  }',
    '  log("시작: " + CFG.command + " " + CFG.args.join(" "))',
    '  const child = spawn(CFG.command, CFG.args, {',
    '    cwd: CFG.cwd,',
    '    detached: true,',
    '    stdio: ["ignore", "ignore", "ignore"],',
    '    env: process.env,',
    '  })',
    '  child.unref()',
    '  log("새 프로세스를 띄웠다 pid=" + child.pid)',
    '}',
    '',
    'main().catch((error) => { log("재시작 실패: " + (error && error.message ? error.message : String(error))) })',
    '',
  ].join('\n')
}

/** 업데이트 적용: 새 버전 설치 + 재시작 스크립트 생성 + 현재 프로세스 종료. */
async function applyUpdate(ctx, dir, name, targetVersion) {
  const pm = packageManagerOf(dir)
  const spec = targetVersion ? name + '@' + targetVersion : name
  const args = pm === 'pnpm' ? ['add', spec] : ['install', spec, '--save']
  const r = await run(pm, args, { cwd: dir, timeoutMs: 300000 })
  if (r.code !== 0) {
    return { ok: false, error: "Install failed (" + pm + ' ' + args.join(' ') + '): ' + String(r.stderr || r.stdout || '').trim().slice(0, 1200) }
  }
  /* 재시작: 현재 프로세스의 시작 명령을 그대로 다시 실행한다 */
  const argv = process.argv.slice()
  const command = argv[0]
  const rest = argv.slice(1)
  const port = (() => {
    try { return String(ctx.webServer.port) } catch { return '3080' }
  })()
  const root = (() => {
    try { return ctx.redteam.root } catch { return join(process.env.DSH_HOME || '.', 'redteam') }
  })()
  mkdirSync(root, { recursive: true })
  const logPath = join(root, 'update.log')
  const scriptPath = join(root, 'restart-dsh-web.sh')
  writeFileSync(scriptPath, restartScript(process.pid, port, command, rest, logPath, process.cwd()), { encoding: 'utf8', mode: 0o755 })
  const child = spawn(process.execPath, [scriptPath], { detached: true, stdio: 'ignore' })
  child.unref()
  /* 브라우저가 응답을 받을 틈을 준 뒤 종료한다 —— 새 프로세스는 스크립트가 원래 명령줄로 띄운다 */
  setTimeout(() => { process.exit(0) }, 1200).unref()
  return {
    ok: true, installed: spec, packageManager: pm,
    restart: { script: scriptPath, log: logPath, port, command: [command].concat(rest).join(' '), pid: process.pid },
  }
}


/** 전체 요청 본문을 읽는다; 상한을 넘으면 즉시 중단한다. */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let settled = false
    const done = (fn, arg) => { if (!settled) { settled = true; fn(arg) } }
    req.on('data', (chunk) => {
      if (settled) return
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        // Error 를 실은 destroy → socket 이 즉시 RST,client 가 계속 보내지 않는다,끝에서 끝까지 마무리.
        const err = new Error('request body too large')
        done(reject, err)
        try { req.destroy(err) } catch { /* 무시 */ }
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => done(resolve, Buffer.concat(chunks).toString('utf8')))
    req.on('error', (err) => done(reject, err))
  })
}

/** 통일된 JSON 응답. */
function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

/** 스킬 사용 가능 여부 캐시: `{ at, scope, byName: Map }`; 30 초 이내는 재사용. */
let skillAvailabilityCache = null
const SKILL_AVAILABILITY_TTL_MS = 30000

/**
 * Cordis 서비스를 안전하게 가져온다: inject 되지 않은 상태에서 ctx.get / 속성 접근은 모두 throw 하므로, 그것이 400 으로 올라오게 두면 안 된다.
 */
function softService(ctx, name) {
  if (!ctx) return undefined
  try {
    if (typeof ctx.get === 'function') return ctx.get(name)
  } catch { /* not injected */ }
  try {
    return ctx[name]
  } catch { /* proxy throw */ }
  return undefined
}

/**
 * 스킬별 사용 가능 여부(본문 읽기 → 공유 판정 모듈).
 * @param skillsSvc - 이미 얻은 skills 서비스 (null 가능).
 * @param list - `skills.list()` 의 반환값 (SkillSummary[]).
 * @param scope - 현재 스코프.
 * @param force - true 이면 빠른 조회 캐시를 건너뛴다.
 */
async function skillAvailabilityOf(skillsSvc, list, scope, force) {
  const now = Date.now()
  // cache key: 에 scope 서명을 포함한다. 프리셋을 바꾸면 scope 가 변하고, 오래된 cache 는 잘못된 스킬 사용 가능 여부 스냅숏에 대응할 수 있다.
  const scopeSig = scope == null ? '' : String(scope)
  if (!force && skillAvailabilityCache !== null
    && now - skillAvailabilityCache.at < SKILL_AVAILABILITY_TTL_MS
    && skillAvailabilityCache.size === list.length
    && skillAvailabilityCache.scope === scopeSig) {
    return { at: skillAvailabilityCache.at, cached: true, byName: skillAvailabilityCache.byName }
  }
  const rootsWith = new Map()
  for (const x of list) {
    const dir = x.resourceBase && x.resourceBase.kind === 'directory' ? x.resourceBase.path : null
    if (dir === null) continue
    if (!rootsWith.has(x.name)) rootsWith.set(x.name, [])
    if (!rootsWith.get(x.name).includes(dir)) rootsWith.get(x.name).push(dir)
  }
  const byName = new Map()
  for (const summary of list) {
    let def
    try {
      def = skillsSvc && typeof skillsSvc.get === 'function'
        ? await skillsSvc.get(summary.name, { scope })
        : undefined
    } catch { def = undefined }
    const path = def && typeof def.path === 'string'
      ? def.path
      : (summary.resourceBase && summary.resourceBase.kind === 'directory' ? summary.resourceBase.path : null)
    const root = summary.resourceBase && summary.resourceBase.kind === 'directory' ? summary.resourceBase.path : null
    const verdict = checkSkill({ name: summary.name, content: def && def.content, path, root },
      { env: mergeConfigEnv(process.env, loadPlatformConfig(redteamRoot())), sameNameIn: rootsWith.get(summary.name) || [] })
    byName.set(summary.name, verdict)
  }
  skillAvailabilityCache = { at: now, scope: scope == null ? '' : String(scope), size: list.length, byName }
  return { at: now, cached: false, byName }
}

/**
 * 스킬 카탈로그: 데스크톱은 기본으로 이 패키지의 `skills/redteam/*.md` 를 읽는다;
 * skills + agentPresets 가 모두 사용 가능할 때만 네이티브 레지스트리를 쓴다.
 */
async function handleSkillOp(ctx, request) {
  if (request.op !== 'skillCatalog' && request.op !== 'skillRead') return undefined

  /* 데스크톱에서는 "without inject" 가 올라오게 두면 안 된다: 일괄로 softService + 파일 폴백. */
  const skillsSvc = softService(ctx, 'skills')
  const presetsSvc = softService(ctx, 'agentPresets')

  let scope = null
  let registryReady = false
  if (skillsSvc && typeof skillsSvc.list === 'function' && presetsSvc) {
    const standing = presetsSvc.standingKeyFor
    if (typeof standing === 'function') {
      try {
        scope = await standing.call(presetsSvc, 'redteam')
        registryReady = scope != null
      } catch {
        registryReady = false
      }
    }
  }

  if (!registryReady) {
    return withBothLibraries(handleSkillOpFromPluginDir(request))
  }

  if (request.op === 'skillCatalog') {
    let list = []
    try {
      list = await skillsSvc.list({ scope })
    } catch {
      list = []
    }
    if (!Array.isArray(list) || list.length === 0) {
      return withBothLibraries(handleSkillOpFromPluginDir(request))
    }
    const redteamList = list.filter((s) => skillLibraryOf(s) !== 'official')
    const availability = await skillAvailabilityOf(skillsSvc, redteamList, scope, request.refresh === true)
    const pluginDir = resolvePluginSkillsDir()
    const bySource = new Map()
    const byDir = new Map()
    const items = list.map((s) => {
      const dir = s.resourceBase && s.resourceBase.kind === 'directory' ? s.resourceBase.path : null
      const name = dir === null ? "(not filesystem-sourced)" : dir
      byDir.set(name, (byDir.get(name) || 0) + 1)
      bySource.set(s.source, (bySource.get(s.source) || 0) + 1)
      const library = skillLibraryOf(s) === 'official' ? 'official' : 'redteam'
      const avail = availability.byName.get(s.name)
      return {
        name: s.name,
        description: s.description,
        whenToUse: s.whenToUse || '',
        provider: s.provider,
        source: s.source,
        dir: dir,
        modelInvocable: s.invocation ? s.invocation.modelInvocable !== false : true,
        userInvocable: s.invocation ? s.invocation.userInvocable !== false : true,
        fromPlugin: sameDir(dir, pluginDir),
        library,
        availability: library === 'official' ? 'listed' : (avail ? avail.status : 'unknown'),
        problems: library === 'official' ? [] : (avail ? avail.problems : ["Not checked"]),
        needs_user: library === 'official' ? [] : (avail ? avail.needs_user : []),
      }
    })
    const availSummary = summarizeSkills(Array.from(availability.byName.values()))
    return withBothLibraries({
      ok: true,
      total: items.length,
      fromPlugin: items.filter((x) => x.fromPlugin).length,
      availability: {
        summary: availSummary,
        checked_at: availability.at,
        cached: availability.cached,
        broken: Array.from(availability.byName.values()).filter((x) => x.status === 'broken')
          .map((x) => ({ name: x.name, problems: x.problems, needs_user: x.needs_user })),
        note: '사용 가능 = 스킬 파일이 존재하고 본문을 읽을 수 있음. 도구 누락, key 누락, VPS 자리표시자 미기입은 보완 항목으로만 기록하며, 스킬 전체를 사용 불가로 판정하지 않습니다.',
      },
      bySource: Array.from(bySource, ([k, n]) => ({ key: k, n })).sort((a, b) => b.n - a.n),
      byDir: Array.from(byDir, ([k, n]) => ({ key: k, n })).sort((a, b) => b.n - a.n),
      note: '레드팀 스킬과 공식 스킬은 서로 다른 라이브러리입니다: 도구 경로 검사는 레드팀 스킬에만 적용되고, 공식 스킬은 $DSH_HOME/skills 에 있으며 호스트가 작업에 따라 호출합니다.',
      items,
    })
  }
  if (request.library === 'official') return readOfficialSkill(request.name)
  if (typeof request.name !== 'string' || request.name.length === 0) {
    return { ok: false, error: 'name 파라미터가 없습니다' }
  }
  try {
    const skill = await skillsSvc.get(request.name, { scope })
    if (skill !== undefined) {
      return {
        ok: true,
        name: skill.name,
        description: skill.description,
        whenToUse: skill.whenToUse || '',
        provider: skill.provider,
        source: skill.source,
        path: skill.path || null,
        content: skill.content || '',
      }
    }
  } catch { /* fall through */ }
  return handleSkillOpFromPluginDir(request)
}

/** 이 패키지의 skills/redteam 디렉터리에서 스킬 카탈로그를 구성하고, 실제 사용 가능 여부 검사를 한다(호스트 skills 주입에 의존하지 않는다). */
function handleSkillOpFromPluginDir(request) {
  const dir = resolvePluginSkillsDir() || PLUGIN_SKILLS_DIR
  if (!dir || !existsSync(dir)) {
    return { ok: false, error: "패키지에 포함된 skills/redteam 디렉터리가 없고, 호스트의 skills 서비스도 사용할 수 없습니다" }
  }
  const files = readdirSync(dir).filter((f) => f.endsWith('.md'))
  const parseMeta = (text) => {
    const out = { description: '', whenToUse: '' }
    const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
    if (!m) {
      const first = String(text || '').split(/\r?\n/).find((l) => l.trim()) || ''
      out.description = first.replace(/^#\s*/, '').trim()
      return out
    }
    for (const line of m[1].split(/\r?\n/)) {
      const kv = /^(\w+)\s*:\s*(.*)$/.exec(line)
      if (!kv) continue
      if (kv[1] === 'description') out.description = kv[2].trim().replace(/^['"]|['"]$/g, '')
      if (kv[1] === 'when_to_use' || kv[1] === 'whenToUse') out.whenToUse = kv[2].trim().replace(/^['"]|['"]$/g, '')
    }
    return out
  }
  /* 환경 변수: 프로세스 + 플랫폼 config.json (빈 필드는 덮어쓰지 않는다) */
  const cfg = loadPlatformConfig(redteamRoot())
  const checkEnv = mergeConfigEnv(process.env, cfg)

  if (request.op === 'skillCatalog') {
    const byName = new Map()
    const items = files.map((file) => {
      const name = file.replace(/\.md$/i, '')
      const path = join(dir, file)
      let description = ''
      let whenToUse = ''
      let content = ''
      try {
        content = readFileSync(path, 'utf8')
        const meta = parseMeta(content)
        description = meta.description
        whenToUse = meta.whenToUse
      } catch { /* ignore */ }
      const verdict = checkSkill(
        { name, content, path, root: dir },
        { env: checkEnv },
      )
      byName.set(name, verdict)
      return {
        name,
        description,
        whenToUse,
        provider: 'dsh-purge',
        source: 'plugin',
        dir,
        modelInvocable: true,
        userInvocable: true,
        fromPlugin: true,
        library: 'redteam',
        availability: verdict.status,
        problems: verdict.problems,
        needs_user: verdict.needs_user,
      }
    }).sort((a, b) => a.name.localeCompare(b.name))
    const availSummary = summarizeSkills(Array.from(byName.values()))
    return withBothLibraries({
      ok: true,
      total: items.length,
      fromPlugin: items.length,
      availability: {
        summary: availSummary,
        checked_at: Date.now(),
        cached: false,
        broken: Array.from(byName.values()).filter((x) => x.status === 'broken')
          .map((x) => ({ name: x.name, problems: x.problems, needs_user: x.needs_user })),
        note: "이 패키지의 스킬 파일로 자체 점검합니다(환경 적응 config.json 포함). 도구 경로, key, VPS 자리표시자는 보완 항목으로만 기록하며, 스킬 전체를 사용 불가로 판정하지 않습니다.",
      },
      bySource: [{ key: 'plugin', n: items.length }],
      byDir: [{ key: dir, n: items.length }],
      note: "패키지에 포함된 skills/redteam 은 총 " + items.length + " 개 스킬입니다. 사용 가능 여부는 스킬 본문과 이 머신의 설정을 실제로 확인해 판단합니다.",
      items,
    })
  }
  if (request.library === 'official') return readOfficialSkill(request.name)
  if (typeof request.name !== 'string' || request.name.length === 0) {
    return { ok: false, error: 'name 파라미터가 없습니다' }
  }
  const file = join(dir, request.name.endsWith('.md') ? request.name : (request.name + '.md'))
  if (!existsSync(file)) return { ok: false, error: '스킬이 존재하지 않습니다: ' + request.name }
  let content = ''
  try { content = readFileSync(file, 'utf8') } catch (error) {
    return { ok: false, error: error && error.message ? error.message : String(error) }
  }
  const meta = parseMeta(content)
  return {
    ok: true,
    name: request.name.replace(/\.md$/i, ''),
    description: meta.description,
    whenToUse: meta.whenToUse,
    provider: 'dsh-purge',
    source: 'plugin',
    path: file,
    content,
  }
}

/**
 * 에이전트 동시 실행 상태("에이전트" 탭용): subagents 레지스트리에서 "실제로 돌고 있는" 하위 세션을 직접 읽는다.
 * 도구 계층의 `redteam_agent_slot` 과 같은 기준이지만, 여기서는 읽기만 하고 자리를 차지하지 않는다.
 * @param ctx - 플러그인 컨텍스트.
 * @param request - `{ op: 'agentsStatus' }`.
 * @returns JSON 결과, 또는 undefined 이면 이 op 가 아님을 뜻한다.
 */
async function handleAgentsOp(ctx, request) {
  if (request.op !== 'agentsStatus' && request.op !== 'setAgentsMax') return undefined
  const root = (() => { try { return ctx.redteam.root } catch { return undefined } })()
  if (request.op === 'setAgentsMax') {
    const next = saveMaxAgents(root, request.max)
    return {
      ok: true, max: next, source: 'settings', limit: MAX_AGENTS_LIMIT,
      note: "Saved as " + next + " concurrent executor agents. **Takes effect immediately** (new tasks are dispatched under the new limit; no dsh web restart needed).",
    }
  }
  const max = maxAgentsOf(root, process.env)
  const subagents = ctx.get('subagents')
  const sessions = ctx.get('sessions')
  if (subagents === undefined || subagents === null || sessions === undefined || sessions === null || typeof sessions.list !== 'function') {
    return { ok: false, error: "subagents / sessions registry unavailable: cannot read concurrent usage.", max }
  }
  const children = []
  try {
    const roots = sessions.list().filter((s) => {
      const header = s && s.header
      return header && (header.parentSession === undefined || header.parentSession === null)
    })
    for (const root of roots) {
      try {
        const kids = await subagents.listChildren(root.id)
        for (const k of Array.isArray(kids) ? kids : []) {
          if (k && k.kind === 'child') children.push({ parent: String(root.id), label: k.label || String(k.id), activity: k.activity, mode: k.mode })
        }
      } catch { /* 세션 하나를 읽지 못하면 건너뛴다 */ }
    }
  } catch (error) {
    return { ok: false, error: "Failed to list child sessions: " + (error && error.message ? error.message : String(error)), max }
  }
  const running = children.filter((c) => c.activity === 'running')
  return {
    ok: true, max, used: running.length, free: Math.max(max - running.length, 0),
    running: running.slice(0, 20), total_children: children.length,
    source: maxAgentsSourceOf(root, process.env),
    limit: MAX_AGENTS_LIMIT,
    default_max: DEFAULT_MAX_AGENTS,
    note: "Up to " + max + " executor agents run per session (target) at a time; tasks are dispatched in order by default.",
  }
}

/**
 * 버전과 업데이트 계열 op(패널 오른쪽 위의 "버전 + 자동 업데이트"용).
 * 자산 라이브러리는 건드리지 않고 profile 과 npm/pnpm 을 직접 다룬다; 전부 host 측에서 실행된다.
 * @param ctx - 플러그인 컨텍스트.
 * @param request - `{ op: 'version' | 'updateCheck' | 'updateApply', target? }`.
 * @returns JSON 결과, 또는 undefined 이면 업데이트 계열 op 가 아님을 뜻한다.
 */
async function handleUpdateOp(ctx, request) {
  if (!['version', 'updateCheck', 'updateApply'].includes(request.op)) return undefined
  const pkg = pluginIdentity(ctx)
  const pre = await updatePreflight(ctx)
  if (request.op === 'version') {
    const check = pre.devLinked ? null : await checkLatest(ctx, pre.dir, pkg.name)
    return {
      ok: true,
      plugin: pkg,
      install: {
        mode: pre.devLinked ? 'dev' : 'package',
        dir: pre.dir,
        declared: pre.declared,
        packageManager: pre.packageManager,
      },
      latest: check && check.ok ? check.latest : null,
      updateAvailable: check && check.ok && pkg.version ? versionLess(pkg.version, check.latest) : false,
      /* 로컬 버전이 registry 보다 더 새롭다: 이 컴퓨터에서 도는 것은 아직 배포되지 않은 개발 버전이다.
         이 경우를 구분하지 않으면, "업데이트 확인"이 계속 "이미 최신"을 표시해, "이 버전은 아예 배포되지 않았다"를 감춘다. */
      localAhead: check && check.ok && pkg.version ? versionLess(check.latest, pkg.version) : false,
      check_error: check && check.ok === false ? check.error : undefined,
      blockers: pre.blockers,
      notes: pre.notes,
      running_agents: pre.running,
    }
  }
  if (request.op === 'updateCheck') {
    const check = await checkLatest(ctx, pre.dir, pkg.name)
    if (check.ok !== true) return { ok: false, error: check.error, current: pkg.version, install: { mode: pre.devLinked ? 'dev' : 'package' } }
    const localAhead = pkg.version ? versionLess(check.latest, pkg.version) : false
    return {
      ok: true, current: pkg.version, latest: check.latest,
      updateAvailable: pkg.version ? versionLess(pkg.version, check.latest) : true,
      localAhead,
      install: { mode: pre.devLinked ? 'dev' : 'package', dir: pre.dir, packageManager: pre.packageManager },
      blockers: pre.blockers,
      notes: pre.notes.concat(localAhead
        ? ["The local version (" + pkg.version + ") is newer than the latest on npm (" + check.latest + "): "
           + "this is an unreleased development build, so package-manager updates do not apply (to roll back, specify a version explicitly)."]
        : []),
      running_agents: pre.running,
    }
  }
  /* updateApply */
  if (pre.blockers.length > 0) {
    return { ok: false, error: "지금은 업데이트할 수 없습니다: " + pre.blockers.join(' '), blockers: pre.blockers, notes: pre.notes }
  }
  /* target 이 `npm install <target>` 에 그대로 이어 붙는다: 검증하지 않으면 "임의 패키지 설치 후 프로세스 재시작"을
     브라우저 측 입력으로 노출된다. 순수 semver(v 접두사 허용)만 받아들이고, 나머지는 모두 거부하며 이유를 분명히 말한다. */
  const rawTarget = typeof request.target === 'string' ? request.target.trim() : ''
  if (rawTarget !== '' && !/^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(rawTarget)) {
    return {
      ok: false,
      current: pkg.version,
      error: "updateApply target must be a plain version number (e.g. 0.11.0); got " + JSON.stringify(rawTarget)
        + ". Package names, paths, URLs, and npm flags are not accepted — the value is passed to the package manager verbatim, which would let a remote page choose what gets installed.",
    }
  }
  const result = await applyUpdate(ctx, pre.dir, pkg.name, rawTarget || null)
  if (result.ok !== true) return Object.assign({ current: pkg.version }, result)
  return Object.assign({ current: pkg.version, latest: request.target || null }, result, {
    note: "Installed. Restarting the current host (the page disconnects for a few seconds; refresh after the restart to see the new version). Restart log: " + result.restart.log,
  })
}

/**
 * @param ctx - 플러그인 컨텍스트(redteam / webServer / skills / agentPresets 사용 가능이 이미 보장됨).
 */
export function apply(ctx) {
  const store = ctx.redteam

  /* 레드팀 세션 전송 후의 하드 폴백: 환경이 준비되지 않았으면 첫 단계를 reject 해 곧바로 착수하는 것을 막는다 */
  try {
    if (!ctx.__dshpEnvAdaptPreStep) {
      ctx.__dshpEnvAdaptPreStep = true
      const root = store && store.root ? store.root : redteamRoot()
      const hook = async (payload, next) => {
        try {
          const agent = payload && payload.agent
          const header = agent && agent.session && agent.session.header
          const preset = header && header.agentPreset
          if (preset === 'redteam') {
            const turn = Number(payload && payload.turn) || 0
            const step = Number(payload && payload.step) || 0
            if (turn <= 1 && step <= 1) {
              const status = envAdaptStatus(root)
              if (!status.ready) {
                return {
                  kind: 'reject',
                  reason: status.message
                    || "환경이 적응되지 않았습니다: dsh-purge → Env adapt 에서 도구를 설정하거나, 먼저 「잠시 건너뛰기」를 확인한 뒤 전송하세요.",
                  messages: [],
                }
              }
            }
          }
        } catch { /* 게이트 예외는 차단하지 않는다 */ }
        return next()
      }
      // ctx.effect 로 감싼다 → plugin dispose 시 hook 이 자동 해제된다,avoids 이벤트 핸들러가 남아 이미 내려간 코드를 트리거하는 일이 없다.
      // installed flag 로 중복 등록을 막는다(cordis 는 같은 handler 의 중복 등록을 허용하며, 그러면 여러 번 트리거된다).
      ctx.effect(() => {
        let installed = false
        let disposer = null
        const install = () => {
          if (installed) return
          try {
            disposer = ctx.on('agent/pre-step', hook, { global: true, prepend: true })
            installed = true
          } catch { /* ignore */ }
        }
        install()
        queueMicrotask(install)
        const timer = setTimeout(install, 800)
        return () => {
          clearTimeout(timer)
          try { if (typeof disposer === 'function') disposer() } catch { /* ignore */ }
          delete ctx.__dshpEnvAdaptPreStep
        }
      })
    }
  } catch { /* ignore */ }

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/redteam/api',
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'POST only' })
        return
      }
      /* 출처 검사: 로컬 루프백은 일괄 통과(공식 데스크톱의 Origin 은 흔히 app:// / file:// 이므로,
         예전 로직은 Origin.host 를 빈 값으로 판정한 뒤 곧바로 403 을 내, 스킬 라이브러리/지식 라이브러리/SQL 이 모두 끊겼다).
         루프백이 아닐 때만 Origin 과 Host 가 동일 출처일 것을 요구한다. */
      const remote = req.socket && req.socket.remoteAddress ? String(req.socket.remoteAddress) : ''
      const loopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1'
      const host = typeof req.headers.host === 'string' ? req.headers.host : ''
      const hostLocal = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(host)
      const origin = req.headers.origin
      const originOk = (() => {
        if (loopback) return true
        /* 공식 데스크톱: Origin 은 흔히 app:// / null, Host 는 여전히 127.0.0.1:port */
        if (hostLocal) {
          if (origin === undefined || origin === '' || origin === 'null') return true
          if (typeof origin === 'string' && /^app:/i.test(origin)) return true
          try {
            const oh = new URL(origin).host
            if (oh === host || oh === '' ) return true
          } catch { /* fall through */ }
        }
        if (typeof origin !== 'string' || origin === '') return false
        let originHost = null
        try { originHost = new URL(origin).host } catch { originHost = null }
        return originHost !== null && originHost === host
      })()
      if (!originOk) {
        sendJson(res, 403, { ok: false, error: 'cross-origin request rejected' })
        return
      }
      try {
        const raw = await readBody(req)
        const request = raw.trim() ? JSON.parse(raw) : {}
        const platformResult = handlePlatformOp(store, request)
        if (platformResult !== undefined) {
          sendJson(res, 200, platformResult)
          return
        }
        const agentsResult = await handleAgentsOp(ctx, request)
        if (agentsResult !== undefined) {
          sendJson(res, 200, agentsResult)
          return
        }
        const updateResult = await handleUpdateOp(ctx, request)
        if (updateResult !== undefined) {
          sendJson(res, 200, updateResult)
          return
        }
        let skillResult
        try {
          skillResult = await handleSkillOp(ctx, request)
        } catch (skillErr) {
          /* 데스크톱에서 inject 가 없을 때 절대 400 을 내지 않는다: 직접 파일 폴백 */
          if (request && (request.op === 'skillCatalog' || request.op === 'skillRead')) {
            skillResult = handleSkillOpFromPluginDir(request)
            if (!skillResult || skillResult.ok === false) {
              skillResult = {
                ok: false,
                error: "스킬을 읽지 못했습니다: " + (skillErr && skillErr.message ? skillErr.message : String(skillErr)),
              }
            }
          } else {
            throw skillErr
          }
        }
        sendJson(res, 200, skillResult === undefined ? await dispatchAsync(store, request) : skillResult)
      } catch (error) {
        sendJson(res, 400, { ok: false, error: error && error.message ? error.message : String(error) })
      }
    },
  }))
}
