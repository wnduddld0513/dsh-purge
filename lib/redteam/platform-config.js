/**
 * 레드팀 플랫폼 적응 설정(플러그인 내부, .ps1 없음)
 *
 * 저장 위치: `$DSH_HOME/redteam/config.json`
 * 용도:
 *   · Windows / 비 Kali 머신에서, 사용자가 도구 절대 경로나 검색 디렉터리를 채운다;
 *   · preflight / 스킬 가용성 / nuclei 템플릿 디렉터리가 모두 이곳을 지난다;
 *   · 공식 `$DSH_HOME/skills` 에 아무것도 쓰지 않는다.
 *
 * Z3r0 를 참고: 시스템 설정을 한곳에 모으고 UI 에서 바꿀 수 있게(FOFA / 경로류), shell 부트스트랩에만 의존하지 않는다.
 */
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { homedir, platform as osPlatform } from 'node:os'
import { delimiter, isAbsolute, join, resolve, sep } from 'node:path'

/** 설정 파일 경로. */
export function configPathOf(root) {
  return join(root || redteamRoot(), 'config.json')
}

export function redteamRoot() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'redteam')
}

/** 기본 툴박스 디렉터리. */
export function defaultToolkitDir(root) {
  return join(root || redteamRoot(), 'toolkit')
}

/**
 * 내장 도구 목록: id → 가능한 실행 파일 이름(Windows .exe 포함).
 * 사용자는 config.tools[id] 에 절대 경로를 채워 덮어쓸 수 있고; binDirs 에 통째 툴 디렉터리를 넣을 수도 있다.
 */
export const TOOL_CATALOG = [
  { id: 'nmap', label: 'Nmap', names: ['nmap.exe', 'nmap'] },
  { id: 'nuclei', label: 'Nuclei', names: ['nuclei.exe', 'nuclei'] },
  { id: 'masscan', label: 'Masscan', names: ['masscan.exe', 'masscan'] },
  { id: 'fscan', label: 'fscan', names: ['fscan.exe', 'fscan'] },
  { id: 'gogo', label: 'gogo', names: ['gogo.exe', 'gogo'] },
  { id: 'suo5', label: 'suo5', names: ['suo5.exe', 'suo5-windows-amd64.exe', 'suo5-linux-amd64', 'suo5'] },
  { id: 'frpc', label: "frp client", names: ['frpc.exe', 'frpc'] },
  { id: 'frps', label: "frp server", names: ['frps.exe', 'frps'] },
  { id: 'chisel', label: 'chisel', names: ['chisel.exe', 'chisel'] },
  { id: 'ffuf', label: 'ffuf', names: ['ffuf.exe', 'ffuf'] },
  /* names 는 후보 파일 이름이며, 특정 머신의 절대 경로가 아니다. adapt 는 배포판에서 흔한 별칭이고, 디렉터리에서 발견될 때만 쓴다. */
  { id: 'httpx', label: 'httpx', names: ['httpx-toolkit', 'pd-httpx', 'httpx.exe', 'httpx'], rejectPython: true, adapt: [/^httpx-toolkit$/, /^pd-httpx$/, /^httpx$/] },
  { id: 'dnsx', label: 'dnsx', names: ['dnsx.exe', 'dnsx'] },
  { id: 'subfinder', label: 'subfinder', names: ['subfinder.exe', 'subfinder'] },
  { id: 'ksubdomain', label: 'ksubdomain', names: ['ksubdomain.exe', 'ksubdomain'] },
  { id: 'impacket', label: "impacket (folder or entrypoint)", names: ['impacket-secretsdump', 'impacket-secretsdump.exe', 'secretsdump.py', 'impacket'], adapt: [/^impacket-secretsdump$/, /^secretsdump\.py$/] },
]

const EMPTY = () => ({
  version: 1,
  /* auto | windows | linux —— auto 는 Node process.platform 을 따른다 */
  platform: 'auto',
  toolkitDir: '',
  nucleiTemplatesDir: '',
  /* 추가 검색 디렉터리: 사용자 자신의 Kali 툴킷 / 포터블 도구 폴더 */
  binDirs: [],
  /* id → 절대 경로; 빈 문자열은 미지정을 뜻한다 */
  tools: Object.fromEntries(TOOL_CATALOG.map((t) => [t.id, ''])),
  env: {
    FOFA_KEY: '',
    REDTEAM_VPS_HOST: '',
    REDTEAM_VPS_KEY: '',
  },
  notes: '',
  /* 사용자가 "도구를 당분간 설정하지 않음" 을 확인하면 정상 대화를 허용한다 */
  envAdaptSkip: false,
  /* 사용자가 환경 적응에서 저장/폴더 배정을 한 번이라도 했다 */
  envAdaptConfigured: false,
  updated_at: null,
})

function isWinLike(cfg) {
  const p = (cfg && cfg.platform) || 'auto'
  if (p === 'windows') return true
  if (p === 'linux') return false
  return osPlatform() === 'win32'
}

export function loadPlatformConfig(root) {
  const base = EMPTY()
  const file = configPathOf(root)
  if (!existsSync(file)) return Object.assign({}, base, { path: file, exists: false })
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    const tools = Object.assign({}, base.tools, raw.tools && typeof raw.tools === 'object' ? raw.tools : {})
    const env = Object.assign({}, base.env, raw.env && typeof raw.env === 'object' ? raw.env : {})
    const binDirs = Array.isArray(raw.binDirs)
      ? raw.binDirs.map((x) => String(x || '').trim()).filter(Boolean)
      : []
    return {
      version: Number(raw.version) || 1,
      platform: ['auto', 'windows', 'linux'].includes(raw.platform) ? raw.platform : 'auto',
      toolkitDir: typeof raw.toolkitDir === 'string' ? raw.toolkitDir.trim() : '',
      nucleiTemplatesDir: typeof raw.nucleiTemplatesDir === 'string' ? raw.nucleiTemplatesDir.trim() : '',
      binDirs,
      tools,
      env,
      notes: typeof raw.notes === 'string' ? raw.notes : '',
      envAdaptSkip: !!raw.envAdaptSkip,
      envAdaptConfigured: !!raw.envAdaptConfigured,
      updated_at: raw.updated_at || null,
      path: file,
      exists: true,
    }
  } catch (error) {
    return Object.assign({}, base, {
      path: file,
      exists: true,
      error: error && error.message ? error.message : String(error),
    })
  }
}

export function savePlatformConfig(patch, root) {
  const dir = root || redteamRoot()
  mkdirSync(dir, { recursive: true })
  const prev = loadPlatformConfig(dir)
  const next = {
    version: 1,
    platform: ['auto', 'windows', 'linux'].includes(patch.platform) ? patch.platform : (prev.platform || 'auto'),
    toolkitDir: typeof patch.toolkitDir === 'string' ? patch.toolkitDir.trim() : (prev.toolkitDir || ''),
    nucleiTemplatesDir: typeof patch.nucleiTemplatesDir === 'string'
      ? patch.nucleiTemplatesDir.trim()
      : (prev.nucleiTemplatesDir || ''),
    binDirs: Array.isArray(patch.binDirs)
      ? patch.binDirs.map((x) => String(x || '').trim()).filter(Boolean)
      : (prev.binDirs || []),
    tools: Object.assign({}, prev.tools || {}, patch.tools && typeof patch.tools === 'object' ? patch.tools : {}),
    env: Object.assign({}, prev.env || {}, patch.env && typeof patch.env === 'object' ? patch.env : {}),
    notes: typeof patch.notes === 'string' ? patch.notes : (prev.notes || ''),
    envAdaptSkip: patch.envAdaptSkip !== undefined ? !!patch.envAdaptSkip : !!prev.envAdaptSkip,
    envAdaptConfigured: patch.envAdaptConfigured !== undefined
      ? !!patch.envAdaptConfigured
      : !!prev.envAdaptConfigured,
    updated_at: new Date().toISOString(),
  }
  /* 빈 tools 키는 catalog 전체를 유지해, 패널 편집을 쉽게 한다 */
  for (const t of TOOL_CATALOG) {
    if (next.tools[t.id] === undefined || next.tools[t.id] === null) next.tools[t.id] = ''
    else next.tools[t.id] = String(next.tools[t.id]).trim()
  }
  const file = configPathOf(dir)
  writeFileSync(file, JSON.stringify(next, null, 2), 'utf8')
  return loadPlatformConfig(dir)
}

/** 적용되는 툴박스 루트. */
export function toolkitDirOf(cfg, root) {
  const c = cfg || loadPlatformConfig(root)
  if (c.toolkitDir) return resolve(c.toolkitDir)
  return defaultToolkitDir(root)
}

/** 적용되는 nuclei 템플릿 디렉터리(비어 있을 수 있음). */
export function nucleiTemplatesDirOf(cfg, root) {
  const c = cfg || loadPlatformConfig(root)
  if (c.nucleiTemplatesDir && existsSync(c.nucleiTemplatesDir)) return resolve(c.nucleiTemplatesDir)
  return null
}

/**
 * 디렉터리에서 실행 파일 이름을 찾는다(한 단계 얕은 스캔 + 흔한 하위 디렉터리 bin/).
 */
function looksLikePythonCli(file) {
  let fd
  try {
    const buf = Buffer.alloc(96)
    fd = openSync(file, 'r')
    const n = readSync(fd, buf, 0, buf.length, 0)
    const head = buf.subarray(0, n).toString('utf8')
    return head.startsWith('#!') && /python/i.test(head)
  } catch {
    return false
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd) } catch { /* ignore */ }
    }
  }
}

function findInDir(dir, names, options = {}) {
  if (!dir || !existsSync(dir)) return null
  const tryOne = (base) => {
    for (const name of names) {
      const p = join(base, name)
      if (existsSync(p)) {
        try {
          const st = statSync(p)
          if (!st.isFile()) continue
          if (options.rejectPython && looksLikePythonCli(p)) continue
          return p
        } catch { /* continue */ }
      }
    }
    return null
  }
  const hit = tryOne(dir) || adaptInDir(dir, options)
  if (hit) return hit
  for (const sub of ['bin', 'Bins', 'tools', 'Tools']) {
    const nested = tryOne(join(dir, sub)) || adaptInDir(join(dir, sub), options)
    if (nested) return nested
  }
  return null
}

/** 정확한 파일 이름이 없을 때는 배포판 별칭으로 이 계층 디렉터리에서 대조한다. 맞아야 찾은 것으로 친다. */
function adaptInDir(dir, options) {
  const patterns = options.adapt
  if (!dir || !Array.isArray(patterns) || patterns.length === 0 || !existsSync(dir)) return null
  let names
  try { names = readdirSync(dir) } catch { return null }
  for (const pattern of patterns) {
    for (const name of names) {
      if (!pattern.test(String(name).toLowerCase())) continue
      const file = join(dir, name)
      try {
        if (!statSync(file).isFile()) continue
        if (options.rejectPython && looksLikePythonCli(file)) continue
        return file
      } catch { /* continue */ }
    }
  }
  return null
}

/** PATH 상의 which(동기 방식만, shell 을 spawn 하지 않는다). */
function findOnPath(names, env = process.env, options = {}) {
  const pathVar = env.PATH || env.Path || ''
  const parts = pathVar.split(delimiter).filter(Boolean)
  for (const part of parts) {
    const hit = findInDir(part, names, options)
    if (hit) return hit
  }
  return null
}

/** dsh 의 PATH 는 로그인 shell 보다 짧은 경우가 많다. Linux 에서는 배포판과 사용자 디렉터리를 더 보충한다. */
function linuxFallbackDirs(env = process.env) {
  const home = env.HOME || homedir()
  const dirs = ['/usr/local/sbin', '/usr/local/bin', '/usr/sbin', '/usr/bin', '/bin', '/snap/bin']
  if (home) {
    dirs.push(
      join(home, 'go', 'bin'),
      join(home, '.local', 'bin'),
      join(home, '.pdtm', 'go', 'bin'),
    )
  }
  return dirs
}

/**
 * 단일 도구 해석: 사용자 지정 경로 → toolkit → binDirs → PATH 순.
 * @returns `{ id, label, path, source: 'config'|'toolkit'|'binDir'|'path'|'missing', names }`
 */
export function resolveTool(id, options = {}) {
  const root = options.root || redteamRoot()
  const cfg = options.config || loadPlatformConfig(root)
  const env = options.env || process.env
  const def = TOOL_CATALOG.find((t) => t.id === id)
  if (!def) {
    return { id, label: id, path: null, source: 'missing', names: [] }
  }
  const configured = cfg.tools && typeof cfg.tools[id] === 'string' ? cfg.tools[id].trim() : ''
  if (configured) {
    const abs = isAbsolute(configured) ? configured : resolve(configured)
    if (existsSync(abs)) {
      return { id, label: def.label, path: abs, source: 'config', names: def.names }
    }
    return { id, label: def.label, path: null, source: 'missing', names: def.names, configured: abs, note: "Configured path not found: " + abs }
  }
  const findOpts = { rejectPython: !!def.rejectPython, adapt: def.adapt }
  const toolkit = toolkitDirOf(cfg, root)
  const fromToolkit = findInDir(toolkit, def.names, findOpts)
  if (fromToolkit) return { id, label: def.label, path: fromToolkit, source: 'toolkit', names: def.names }

  for (const dir of cfg.binDirs || []) {
    const hit = findInDir(dir, def.names, findOpts)
    if (hit) return { id, label: def.label, path: hit, source: 'binDir', names: def.names, binDir: dir }
  }

  const fromPath = findOnPath(def.names, env, findOpts)
  if (fromPath) return { id, label: def.label, path: fromPath, source: 'path', names: def.names }

  if (!isWinLike(cfg)) {
    for (const dir of linuxFallbackDirs(env)) {
      const hit = findInDir(dir, def.names, findOpts)
      if (hit) return { id, label: def.label, path: hit, source: 'path', names: def.names }
    }
  }

  return { id, label: def.label, path: null, source: 'missing', names: def.names }
}

export function resolveAllTools(options = {}) {
  return TOOL_CATALOG.map((t) => resolveTool(t.id, options))
}

/**
 * 설정의 env 를 effectiveEnv 에 병합한다(프로세스 / .env 에 이미 있는 값이 우선, 덮어쓰지 않는다).
 */
export function mergeConfigEnv(effectiveEnv, cfg) {
  const out = Object.assign({}, effectiveEnv || {})
  const env = (cfg && cfg.env) || {}
  for (const [k, v] of Object.entries(env)) {
    if (typeof v !== 'string') continue
    const val = v.trim()
    if (val === '') continue
    if (out[k] === undefined || out[k] === '') out[k] = val
  }
  return out
}

/**
 * 플랫폼 요약: 패널과 preflight 에 쓴다.
 */
export function platformSummary(root) {
  const cfg = loadPlatformConfig(root)
  const win = isWinLike(cfg)
  const tools = resolveAllTools({ root, config: cfg })
  const found = tools.filter((t) => t.path)
  const missing = tools.filter((t) => !t.path)
  const toolkit = toolkitDirOf(cfg, root)
  const nuclei = nucleiTemplatesDirOf(cfg, root)
    || (existsSync(join(toolkit, 'nuclei-templates')) ? join(toolkit, 'nuclei-templates') : null)
  const adapt = envAdaptStatus(root)
  return {
    ok: true,
    config: cfg,
    runtime: {
      nodePlatform: osPlatform(),
      effective: win ? 'windows' : 'linux',
      windows: win,
      sep,
    },
    toolkitDir: toolkit,
    toolkitExists: existsSync(toolkit),
    nucleiTemplatesDir: nuclei,
    tools: {
      total: tools.length,
      found: found.length,
      missing: missing.length,
      items: tools,
    },
    adapt,
    hint: adapt.kali
      ? "Kali detected. System packages are recognized by their distro filenames: impacket-secretsdump, httpx-toolkit (the Python /usr/bin/httpx is not treated as a scanner). fscan, gogo, suo5, frp, chisel, dnsx, subfinder and ksubdomain are not shipped with Kali, so they show as not found unless they are in /usr/bin or ~/go/bin."
      : (win
        ? "Currently adapted for Windows: run in a Kali VM, or fill in tool paths / auto-assign a whole-folder toolkit on this page. For the egress proxy see \"Egress status\" below."
        : "Currently adapted for Linux: use setup.sh to install the toolkit, or fill paths in manually / auto-assign a whole-folder toolkit on this page. For the egress proxy see \"Egress status\" below."),
    egress: {
      http_proxy: process.env.HTTP_PROXY || process.env.http_proxy || '',
      https_proxy: process.env.HTTPS_PROXY || process.env.https_proxy || '',
      all_proxy: process.env.ALL_PROXY || process.env.all_proxy || '',
      no_proxy: process.env.NO_PROXY || process.env.no_proxy || '',
      note: "Read-only view of the process environment; changing the system/terminal proxy requires a host restart. For per-command proxies use the cn-proxy-pool skill — it does not change this machine's network config.",
    },
  }
}

/** 이 머신이 Kali / 같은 계열 드릴 배포판인지 탐지한다. */
export function detectKali() {
  if (osPlatform() !== 'linux') {
    return { kali: false, source: null, detail: "Not a Linux host" }
  }
  try {
    const text = readFileSync('/etc/os-release', 'utf8')
    if (/ID\s*=\s*"?kali"?/i.test(text) || /ID_LIKE\s*=[^\n]*kali/i.test(text) || /NAME\s*=\s*".*Kali/i.test(text)) {
      return { kali: true, source: 'os-release', detail: "os-release identifies Kali" }
    }
  } catch { /* ignore */ }
  const markers = [
    '/usr/share/kali-menu',
    '/etc/apt/sources.list.d/kali.list',
    '/usr/share/kali-defaults',
  ]
  for (const p of markers) {
    if (existsSync(p)) return { kali: true, source: 'paths', detail: p }
  }
  return { kali: false, source: null, detail: null }
}

const NAME_TO_IDS = (() => {
  const map = new Map()
  for (const t of TOOL_CATALOG) {
    for (const name of t.names) {
      const key = String(name).toLowerCase()
      if (!map.has(key)) map.set(key, [])
      map.get(key).push(t.id)
    }
  }
  return map
})()

/**
 * 폴더 안에서 도구 이름을 재귀 스캔하고(깊이 제한), id → 절대 경로를 반환한다.
 */
export function scanFolderForTools(dir, options = {}) {
  const maxDepth = Math.min(Math.max(Number(options.maxDepth) || 4, 1), 6)
  const maxFiles = Math.min(Math.max(Number(options.maxFiles) || 8000, 100), 20000)
  const root = resolve(String(dir || '').trim())
  const assigned = {}
  const hits = []
  if (!root || !existsSync(root)) {
    return { ok: false, error: "Folder not found: " + root, assigned, hits }
  }
  let st
  try { st = statSync(root) } catch {
    return { ok: false, error: "Cannot read folder: " + root, assigned, hits }
  }
  if (!st.isDirectory()) {
    return { ok: false, error: "Not a folder: " + root, assigned, hits }
  }

  let scanned = 0
  const ranks = {}
  const walk = (base, depth) => {
    if (scanned >= maxFiles || depth > maxDepth) return
    let entries
    try { entries = readdirSync(base, { withFileTypes: true }) } catch { return }
    for (const ent of entries) {
      if (scanned >= maxFiles) break
      const name = ent.name
      if (!name || name === '.' || name === '..') continue
      if (name.startsWith('.') || name === 'node_modules' || name === '.git') continue
      const full = join(base, name)
      let isDir = false
      let isFile = false
      try {
        if (typeof ent.isDirectory === 'function') {
          isDir = ent.isDirectory()
          isFile = ent.isFile()
        } else {
          const s = statSync(full)
          isDir = s.isDirectory()
          isFile = s.isFile()
        }
      } catch { continue }
      if (isDir) {
        walk(full, depth + 1)
        continue
      }
      if (!isFile) continue
      scanned += 1
      const key = name.toLowerCase()
      const ids = NAME_TO_IDS.get(key)
      if (!ids) continue
      for (const id of ids) {
        const def = TOOL_CATALOG.find((t) => t.id === id)
        if (def && def.rejectPython && looksLikePythonCli(full)) continue
        const rank = def ? def.names.findIndex((n) => n.toLowerCase() === key) : 99
        const prevRank = ranks[id] === undefined ? 99 : ranks[id]
        if (assigned[id] && rank >= prevRank) continue
        ranks[id] = rank < 0 ? 99 : rank
        assigned[id] = full
        hits.push({ id, path: full, name })
      }
    }
  }
  walk(root, 0)

  /* nuclei-templates 디렉터리도 겸사겸사 인식한다 */
  let nucleiTemplatesDir = ''
  const tryNuclei = [
    join(root, 'nuclei-templates'),
    join(root, 'nuclei', 'templates'),
  ]
  for (const p of tryNuclei) {
    if (existsSync(p)) {
      try {
        if (statSync(p).isDirectory()) { nucleiTemplatesDir = p; break }
      } catch { /* ignore */ }
    }
  }

  return {
    ok: true,
    dir: root,
    scanned,
    assigned,
    hits,
    nucleiTemplatesDir,
    assignedCount: Object.keys(assigned).length,
  }
}

/**
 * 통째 툴 폴더를 config 에 기록한다: toolkitDir + 매칭된 tools 경로.
 */
export function assignToolkitFolder(dir, root) {
  const scan = scanFolderForTools(dir)
  if (!scan.ok) return Object.assign({ ok: false }, scan)
  const prev = loadPlatformConfig(root)
  const tools = Object.assign({}, prev.tools || {})
  for (const [id, path] of Object.entries(scan.assigned)) {
    tools[id] = path
  }
  const binDirs = Array.isArray(prev.binDirs) ? prev.binDirs.slice() : []
  if (!binDirs.includes(scan.dir)) binDirs.unshift(scan.dir)
  const patch = {
    toolkitDir: scan.dir,
    binDirs,
    tools,
    envAdaptConfigured: true,
    envAdaptSkip: false,
  }
  if (scan.nucleiTemplatesDir) patch.nucleiTemplatesDir = scan.nucleiTemplatesDir
  const cfg = savePlatformConfig(patch, root)
  const summary = platformSummary(root)
  return {
    ok: true,
    assigned: scan.assigned,
    assignedCount: scan.assignedCount,
    hits: scan.hits,
    scanned: scan.scanned,
    dir: scan.dir,
    nucleiTemplatesDir: scan.nucleiTemplatesDir || null,
    config: cfg,
    tools: summary.tools,
    adapt: summary.adapt,
  }
}

/**
 * 레드팀 전송 전 환경 게이트 상태.
 * Kali → 바로 준비됨; 그렇지 않으면 도구 설정/배정이 필요하거나, 사용자가 건너뛰기를 확인해야 한다.
 */
export function envAdaptStatus(root) {
  const cfg = loadPlatformConfig(root)
  const kaliInfo = detectKali()
  const tools = resolveAllTools({ root, config: cfg })
  const foundItems = tools.filter((t) => t.path)
  const missingItems = tools.filter((t) => !t.path)
  const found = foundItems.length
  const skipped = !!cfg.envAdaptSkip
  /* 기록된 경로만 설정된 것으로 친다. 단독 envAdaptConfigured 는 빈 자동 초기화일 수 있다. */
  const savedPaths = !!(cfg.toolkitDir && String(cfg.toolkitDir).trim())
    || (cfg.binDirs && cfg.binDirs.length > 0)
    || TOOL_CATALOG.some((t) => cfg.tools && cfg.tools[t.id] && String(cfg.tools[t.id]).trim())

  let reason = 'need-config'
  let ready = false
  let message = ''

  if (kaliInfo.kali) {
    ready = true
    reason = 'kali'
    message = "Kali detected; by default the local tools are used directly (PATH / default lookup)."
  } else if (skipped) {
    ready = true
    reason = 'skipped'
    message = "You chose to skip tool setup for now; chat works normally (scanning skills may be unavailable)."
  } else if (savedPaths) {
    ready = true
    reason = 'configured'
    message = "Saved tool paths are still in place; updating the plugin will not ask you to reconfigure. Found " + found + '/' + tools.length + " tools so far."
  } else if (found >= 2) {
    ready = true
    reason = 'tools-found'
    message = "This machine already finds " + found + " tools, so it counts as ready."
  } else {
    ready = false
    reason = 'need-config'
    message = "Kali not detected and tools are not configured. Open dsh-purge → Environment setup and fill in paths or pick a whole-folder toolkit to auto-assign; you can also confirm skip-setup for now and keep chatting."
  }

  return {
    ok: true,
    ready,
    reason,
    message,
    kali: !!kaliInfo.kali,
    kaliSource: kaliInfo.source,
    kaliDetail: kaliInfo.detail,
    skipped,
    configured: savedPaths,
    found,
    missing: missingItems.length,
    total: tools.length,
    foundIds: foundItems.map((t) => t.id),
    missingIds: missingItems.map((t) => t.id),
  }
}

export function markEnvAdaptSkip(root, skip = true) {
  savePlatformConfig({ envAdaptSkip: !!skip }, root)
  return envAdaptStatus(root)
}

export default {
  TOOL_CATALOG,
  configPathOf,
  redteamRoot,
  loadPlatformConfig,
  savePlatformConfig,
  resolveTool,
  resolveAllTools,
  platformSummary,
  mergeConfigEnv,
  toolkitDirOf,
  nucleiTemplatesDirOf,
  detectKali,
  scanFolderForTools,
  assignToolkitFolder,
  envAdaptStatus,
  markEnvAdaptSkip,
}
