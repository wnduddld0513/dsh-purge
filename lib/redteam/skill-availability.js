/**
 * 스킬 가용성 자체 점검(제로 의존성, tools 와 UI 가 공유하는 **유일한** 판정 로직)
 *
 * 왜 필요한가: 스킬 본문에는 "로컬 경로 / 환경 변수 / VPS 주소" 라고 적혀 있지만 **스킬이 나열된다 ≠ 실행된다**.
 * `FOFA_KEY` 가 없거나, 도구가 `$DSH_HOME/redteam/toolkit/` 에 안착하지 않았거나, VPS 가 아직 플레이스홀더라면, 모두 실제로 손을 대는
 * 시점에야 알게 되고, 그때는 이미 사람이 훈련장 안에 들어와 있다. 여기서 판정을 한 벌로 모은다:
 *   · 에이전트 측 —— `redteam_preflight` 를 작업 시작 전에 한 번 돌려, 빠진 것을 곧바로 사용자에게 요구한다;
 *   · 패널 측 —— "스킬 라이브러리" 탭이 각 스킬의 가용성 상태를 표시한다.
 *
 * 각 문제는 **수정 방법**을 함께 제시한다(`issues[].fix`, 문구는 `skill-fixes.js` 참고): 패널에서
 * 단순히 "어디가 사용 불가인지" 만 말하지 않고, 사용자에게 "어떻게 고치는지" 를 직접 알려준다. `problems` 는 순수 텍스트 뷰로 남겨 둔다(구 호출자와 호환).
 *
 * 판정 차원(모두 스킬 본문에서 객관적으로 읽어낼 수 있는 것들이다):
 *   ① 본문을 불러올 수 있는가 —— "본문도 읽을 수 없고 파일도 정말 이 머신에 없다" 인 경우에만 해당 스킬 전체를 사용 불가로 표시한다.
 *      본문이 손에 있다면(호스트가 content 를 주었다면) 모델이 이 스킬을 불러올 수 있다는 뜻이다; 이때 기록된 경로가 없는 것은 **오래된 설치 /
 *      다른 머신** 이 남긴 흔적일 뿐이며(스킬 경로는 절대 경로라 머신을 바꾸면 반드시 빈 곳을 가리킨다), 더 이상 그것으로 사용 불가를 보고할 수 없다;
 *   ② 환경 변수 (`os.environ["X"]` / `process.env.X`; 기본값이 있는 `os.environ.get("X", "…")` 은 해당 없음);
 *   ③ 본문에서 인용한 로컬 경로 (toolkit / bin / local 아래의 절대 경로, `$DSH_HOME`, `~/`);
 *   ④ 외부 인프라 플레이스홀더 (예: `<VPS_IP|당신의VPS_IP>` 가 채워지지 않음).
 * ②③④ 는 결손 항목에만 기록한다. 스킬 본문에 대체 방법이 적혀 있으면 도구나 키가 없어도 여전히 불러올 수 있다.
 *
 * 판정하지 않음: 의미적 정확성, 권한, 대상 도달 가능성 —— 그런 것은 실제로 한 번 두들겨 봐야만 알 수 있다.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fixesForIssue } from './skill-fixes.js'

/** $DSH_HOME / ${DSH_HOME} / ~ 를 해석한다(스킬 본문에 여러 표기가 있다). */
export function expandSkillPath(p, env = process.env) {
  const dshHome = env.DSH_HOME || resolve(homedir(), '.dsh')
  let out = String(p).trim()
  out = out.replace(/\$\{DSH_HOME\}/g, dshHome).replace(/\$DSH_HOME/g, dshHome)
  if (out.startsWith('~/')) out = resolve(homedir(), out.slice(2))
  return out
}

/**
 * 이 머신에서 `$DSH_HOME` 이 나올 수 있는 두 가지 출처.
 *
 * 플러그인 프로세스는 `process.env.DSH_HOME || homedir()/.dsh` 로 해석한다; 호스트 측의 `dshHomePath()`
 * 는 자기 자신의 home 을 쓴다. 디스크를 바꾼 / profile 을 바꾼 / `HOME` 이 빈 머신에서는 둘이 갈라지므로, 한쪽만 인정하면
 * 스킬 사본과 toolkit 경로를 전부 "없음" 으로 판정하게 된다(남의 컴퓨터에서 스킬이 사용 불가로 보이는 주된 원인).
 */
export function dshHomeCandidates(env = process.env) {
  const out = []
  const push = (p) => { if (p && !out.includes(p)) out.push(p) }
  push(env.DSH_HOME)
  push(resolve(homedir(), '.dsh'))
  return out
}

/** 본문의 로컬 경로는 **어느 하나**의 후보 home 아래에 존재하면 존재하는 것으로 본다(env 만 인정하면 toolkit 전체 누락을 오탐한다). */
export function existsUnderAnyHome(raw, env = process.env) {
  for (const home of dshHomeCandidates(env)) {
    if (existsSync(expandSkillPath(raw, { ...env, DSH_HOME: home }))) return true
  }
  return false
}

/** 스킬 본문에서 "필수지만 설정되지 않은" 환경 변수 이름을 추출한다. */
export function requiredEnvOf(content) {
  const names = new Set()
  const body = String(content || '')
  /* Node 측: process.env.X (기본값이라는 것이 없다) */
  for (const m of body.matchAll(/process\.env\.([A-Z][A-Z0-9_]{2,})/g)) names.add(m[1])
  /* Python 측: os.environ["X"] 는 필수; os.environ.get("X", "기본값") 은 폴백이 있어 필수 아님 */
  for (const m of body.matchAll(/os\.environ(?:\.get)?[\[(]\s*["']([A-Z][A-Z0-9_]{2,})["']\s*(,)?/g)) {
    if (m[2] === undefined) names.add(m[1])
  }
  /* shell 측: ${X:?required} 는 명시적 필수; 맨 $X 는 판정하지 않는다(스킬에 $TARGET 같은 플레이스홀더가 대량으로 나온다) */
  for (const m of body.matchAll(/\$\{([A-Z][A-Z0-9_]{2,}):\?/g)) names.add(m[1])
  return Array.from(names)
}

/** 설명 파일은 도구가 아니다. 다른 시스템, 다른 CPU 의 파일 이름도 현재 시스템의 사용 불가 판정에 쓰지 않는다. */
export function pathCountsOnThisHost(raw, platform = process.platform, arch = process.arch) {
  const base = String(raw).replace(/\\/g, '/').split('/').pop() || ''
  if (/\.(md|txt|json|ya?ml|csv)$/i.test(base)) return false
  const token = (name) => new RegExp('(?:^|[._-])(?:' + name + ')(?:[._-]|$)', 'i').test(base)
  if (platform === 'win32' && /\.(sh|bash)$/i.test(base)) return false
  if (platform === 'win32' && /\/\.local\/|\/\.kimi-webbridge\//.test(String(raw).replace(/\\/g, '/'))) return false
  const isWinName = /\.exe$/i.test(base) || token('windows|win32|win64')
  const isDarwin = token('darwin|macos')
  const isLinux = token('linux')
  const isArm = token('arm64|aarch64')
  const isAmd = token('amd64|x64|x86_64')
  if (platform === 'win32' && (isLinux || isDarwin)) return false
  if (platform === 'darwin' && (isWinName || isLinux)) return false
  if (platform !== 'win32' && platform !== 'darwin' && (isWinName || isDarwin)) return false
  if (isArm && arch !== 'arm64') return false
  if (isAmd && arch !== 'x64') return false
  return true
}

/** 본문에서 인용한, 존재 여부를 판정할 수 있는 로컬 경로(toolkit / bin / local 아래의 절대 경로). */
export function referencedPathsOf(content) {
  const out = new Set()
  for (const m of String(content || '').matchAll(/(?:~|\$DSH_HOME|\/home\/[^\s"'`,)]+?)\/[\w./\u4e00-\u9fa5-]+/g)) {
    const raw = m[0].replace(/[\uff0c\u3002\uff1b\u3001\uff1a)\uff09\]]+$/, '')
    if (!/\/(toolkit|bin|local)\//.test(raw)) continue
    if (/[<>{}*|]/.test(raw)) continue
    if (!pathCountsOnThisHost(raw)) continue
    out.add(raw)
  }
  return Array.from(out)
}

/** 호스트 스킬 서비스가 목록을 못 내면 이 패키지의 skills/redteam 과 $DSH_HOME/redteam/skills 를 쓴다. */
export function bundledSkillSummaries() {
  const here = dirname(fileURLToPath(import.meta.url))
  /* 후보 home 두 개를 모두 스캔한다: 호스트가 dshHomePath 로 스킬을 나열할 때 쓰는 것은 자기 자신의 home 이고,
     env 쪽 하나만 스캔하면 갈라진 머신에서 "설치했는데 나열되지 않는다" 가 된다. */
  const dirs = [join(here, '..', '..', 'skills', 'redteam')]
  for (const home of dshHomeCandidates()) {
    const dir = join(home, 'redteam', 'skills')
    if (!dirs.includes(dir)) dirs.push(dir)
  }
  const seen = new Set()
  const out = []
  for (const dir of dirs) {
    let names
    try { names = readdirSync(dir) } catch { continue }
    for (const file of names) {
      if (!file.endsWith('.md')) continue
      const name = file.slice(0, -3)
      if (seen.has(name)) continue
      const filePath = join(dir, file)
      let content = ''
      try { content = readFileSync(filePath, 'utf8') } catch { content = '' }
      if (!content.trim()) continue
      seen.add(name)
      const title = (content.match(/^#\s+(.+)$/m) || [])[1] || name
      out.push({
        name,
        description: String(title).trim(),
        content,
        path: filePath,
        library: 'redteam',
        resourceBase: { kind: 'directory', path: dir },
      })
    }
  }
  return out
}

/** 공식 스킬은 `$DSH_HOME/skills` 에 있다. 레드팀 스킬은 이 패키지의 `skills/redteam` 또는 `$DSH_HOME/redteam/skills` 에 있다. */
export function skillLibraryOf(summary) {
  if (!summary || typeof summary !== 'object') return ''
  if (summary.library === 'official' || summary.library === 'redteam') return summary.library
  const n = [summary.path, summary.dir, summary.root, summary.resourceBase && summary.resourceBase.path]
    .filter((item) => typeof item === 'string')
    .join('\n')
    .replace(/\\/g, '/')
  if (/\/skills\/redteam(\/|$)/.test(n) || /\/redteam\/skills(\/|$)/.test(n)) return 'redteam'
  if (/\/skills(\/|$)/.test(n)) return 'official'
  return ''
}

/** 공식 사용자 스킬. 레드팀 도구 경로로 이것들의 가용성을 판정하지 않는다. */
export function officialSkillSummaries() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  const dir = join(home, 'skills')
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return [] }
  const out = []
  const seen = new Set()
  for (const entry of entries) {
    if (!entry || entry.name === '.system' || entry.name.startsWith('.')) continue
    let filePath = ''
    let name = ''
    if (entry.isDirectory()) {
      filePath = join(dir, entry.name, 'SKILL.md')
      name = entry.name
    } else if (entry.isFile() && entry.name.endsWith('.md') && entry.name !== 'SKILL.md') {
      filePath = join(dir, entry.name)
      name = entry.name.slice(0, -3)
    } else {
      continue
    }
    if (seen.has(name) || !existsSync(filePath)) continue
    let content = ''
    try { content = readFileSync(filePath, 'utf8') } catch { continue }
    if (!content.trim()) continue
    seen.add(name)
    const title = (content.match(/^description:\s*(.+)$/m) || content.match(/^#\s+(.+)$/m) || [])[1] || name
    out.push({
      name,
      description: String(title).trim().replace(/^['"]|['"]$/g, ''),
      content,
      path: filePath,
      library: 'official',
      resourceBase: { kind: 'directory', path: dir },
    })
  }
  return out
}

/** 레드팀 자체 점검은 레드팀 스킬만 쓴다. 공식 스킬은 호스트 목록에 나타나도 경로 판정에 참여하지 않는다. */
export function redteamSummariesForCheck(summaries, bundled, scoped) {
  const base = Array.isArray(bundled) ? bundled : []
  const names = new Set(base.map((item) => item && item.name).filter(Boolean))
  const picked = []
  const seen = new Set()
  for (const summary of Array.isArray(summaries) ? summaries : []) {
    if (!summary || !summary.name || seen.has(summary.name)) continue
    const library = skillLibraryOf(summary)
    if (library === 'official') continue
    if (library === 'redteam' || scoped === true || names.has(summary.name)) {
      seen.add(summary.name)
      picked.push(summary)
    }
  }
  for (const item of base) {
    if (!item || !item.name || seen.has(item.name)) continue
    seen.add(item.name)
    picked.push(item)
  }
  return picked
}

/** 어떤 스킬 루트에서 같은 이름 스킬의 본문을 읽는다(읽지 못하면 null 반환). */
export function readSkillFromRoot(root, name) {
  if (typeof root !== 'string' || root === '') return null
  for (const dir of [root, resolve(root, String(name || ''))]) {
    for (const file of [resolve(dir, String(name || '') + '.md'), resolve(dir, 'SKILL.md')]) {
      try { if (existsSync(file)) return { path: file, content: readFileSync(file, 'utf8') } } catch { /* 다음 것을 계속 시도한다 */ }
    }
  }
  return null
}

/** 수정 문구 생성기를 호출하되, 어떤 예외든 빈 문자열로 퇴화시킨다(가용성 판정이 문구 오류 때문에 죽어서는 안 된다). */
function safeFix(issue) {
  try { return String(fixesForIssue(issue) || '') } catch { return '' }
}

/**
 * 스킬 하나의 가용성을 검사한다.
 *
 * @param skill - `{ name, description?, content?, path?, root? }` (content 는 스킬 본문, root 는 어느 스킬 루트에서 왔는지).
 * @param options - `{ env?: NodeJS.ProcessEnv, sameNameIn?: string[] }`.
 *   `sameNameIn` 은 **같은 이름 스킬을 함께 등록한 다른** 루트 디렉터리다: 같은 이름 스킬은 루트 순서대로 우선 선택되므로, 뒤에 배치된 사본은
 *   "가려진다". 여기서는 "실제로 불러온 것이 패키지 동봉 플레이스홀더 버전이고, 당신이 설정한 버전은 뒤에 배치되어 있다" 는 상황을 폴백으로 식별하는 데 쓴다.
 * @returns `{ name, status, issues, problems, needs_user, checked, shadowed_by? }`
 *   이 포크에서 `status` 는 **항상 'available'** 이다: 결손은 `issues` 에 기록만 하고 사용을 막지 않는다(등록·실행 게이트 없음).
 *   `issues` 는 `{ kind, detail, fix }` 목록이다(`kind` ∈ file-missing / content-missing /
 *   env-missing / path-missing / placeholder / shadowed), `problems` 는 그 detail 텍스트 뷰다.
 *   `needs_user` 는 호출 호환을 위해 남겨 둔 필드이며 항상 빈 배열이다(사용자에게 무언가를 요구하지 않는다).
 */
export function checkSkill(skill, options = {}) {
  const env = options.env || process.env
  const name = skill && skill.name ? String(skill.name) : '(이름 없음)'
  const content = skill && typeof skill.content === 'string' ? skill.content : ''
  const file = skill && typeof skill.path === 'string' ? skill.path : null
  const root = skill && typeof skill.root === 'string' ? skill.root : null
  const issues = []
  const needsUser = []
  /** 문제 하나를 기록한다: detail 은 사용자에게 보여줄 "사용 불가 사유", fix 는 "어떻게 고치는지" 다(skill-fixes.js 참고). */
  const addIssue = (kind, detail, extra) => {
    const payload = Object.assign({ kind, skill: name }, extra || {})
    let fix = ''
    try { fix = String(fixesForIssue(payload) || '') } catch { fix = '' }
    issues.push(Object.assign({ kind, detail, fix }, extra || {}))
  }

  if (content.trim() === '') {
    /* 본문을 읽지 못한 경우에도 이 포크는 스킬을 "사용 불가" 로 표시하지 않는다: 기록만 남기고 status 는 available 이다.
       필요할 때 `skill` 도구로 한 번 로드하면 본문을 그대로 얻을 수 있기 때문에, 사전 판정으로 막을 이유가 없다. */
    const gone = file !== null && !existsSync(file)
    const detail = gone
      ? '스킬 파일이 이 머신에 아직 없습니다(경로 기록만 남음): ' + file
      : '스킬 본문을 미리 읽지 못했습니다(메타데이터만 있음): 필요할 때 `skill` 도구로 로드하면 됩니다'
    const kind = gone ? 'file-missing' : 'content-missing'
    return {
      name,
      status: 'available',
      issues: [{ kind, detail, fix: safeFix({ kind, skill: name, file: file || undefined }) }],
      problems: [detail],
      needs_user: [],
      checked: { file, env: [], paths: [] },
    }
  }
  /* 본문이 손에 있음 = 스킬을 불러올 수 있음. 여기서 경로는 힌트일 뿐이다: 이전에 어느 머신에서 해석된 절대 경로라,
     머신을 바꾸면 반드시 빈 곳을 가리킨다 —— 비차단 file-stale 한 건만 기록하고, 스킬 전체를 사용 불가로 표시하지 않는다. */
  if (file !== null && !existsSync(file)) {
    addIssue('file-stale', '스킬이 기록한 파일 경로가 이 머신에 없습니다(스킬 본문은 여전히 로드 가능): ' + file, { file })
  }

  const envNames = requiredEnvOf(content)
  const missingEnv = envNames.filter((n) => !env[n])
  for (const n of missingEnv) {
    addIssue('env-missing', '환경 변수 누락 ' + n, { env: n })
  }

  const paths = referencedPathsOf(content)
  const missingPaths = paths.filter((p) => !existsUnderAnyHome(p, env))
  if (missingPaths.length > 0) {
    addIssue('path-missing', '참조한 로컬 경로가 존재하지 않습니다: ' + missingPaths.slice(0, 6).join(', ')
      + (missingPaths.length > 6 ? ' 등 ' + missingPaths.length + ' 곳' : ''), { paths: missingPaths })
  }

  /* 외부 인프라 플레이스홀더: 스킬에 `<VPS_IP>` 같은 것이 나오면 아직 설정되지 않았다는 뜻이다.
     하지만 **이미 설정이 끝난 배포는 오탐해서는 안 된다**: REDTEAM_VPS_HOST 에 값이 있기만 하면,
     스킬 본문의 플레이스홀더는 문서 표기일 뿐이며(실제 명령은 설정값으로 치환된다), 더 이상 결손으로 치지 않는다.
     판정 순서는 반드시 "설정을 먼저 보고, 플레이스홀더를 나중에 본다" 여야 한다. 그렇지 않으면 VPS 설정이 끝난 머신에서
     이 스킬들이 영원히 broken 으로 표시된다(템플릿 플레이스홀더와 실제 설정이 섞여 있기 때문). */
  const vpsConfigured = typeof env.REDTEAM_VPS_HOST === 'string' && env.REDTEAM_VPS_HOST.trim() !== ''
  const placeholders = []
  if (!vpsConfigured) {
    if (content.includes('<\u4f60\u7684VPS_IP>') || content.includes('<당신의VPS_IP>') || content.includes('<VPS_IP>')) placeholders.push('VPS 주소')
    if (content.includes('<\u4f60\u7684VPS_\u4e3b\u673a\u540d>') || content.includes('<당신의VPS_호스트명>') || content.includes('<VPS 호스트명>') || content.includes('<\u4f60\u7684VPS_호스트명>')) placeholders.push('VPS 호스트 이름')
  }
  for (const p of placeholders) {
    addIssue('placeholder', p + ' 은(는) 본문에 자리표시자로 적혀 있습니다(문서 표기). 실제 값은 명령에서 직접 치환하면 됩니다', { placeholder: p })
  }

  /* 폴백: 같은 이름 스킬이 다른 루트에 "문제가 더 적은" 사본으로 있다(보통 사용자가 직접 설정한 그 사본이지만,
     앞 순서에 놓인 패키지 동봉 플레이스홀더 버전에 가려진 경우다). 이때는 사용자가 환경이 설정되지 않았다고 오해하게 두지 말고 사실대로 알린다. */
  let shadowed = null
  for (const other of Array.isArray(options.sameNameIn) ? options.sameNameIn : []) {
    if (other === root) continue
    const alt = readSkillFromRoot(other, name)
    if (alt === null || alt.content === content) continue
    const verdict = checkSkill({ name, content: alt.content, path: alt.path }, { env })
    if (verdict.status === 'available' || verdict.problems.length < issues.length) {
      shadowed = { root: other, path: alt.path, status: verdict.status }
      addIssue('shadowed', '`' + other + '` 에 같은 이름의 스킬이 하나 더 있습니다(' + verdict.status + '), '
        + '하지만 스킬 루트 순서상 지금 로드된 것은 이 사본입니다(위의 사용 불가 사유는 이 사본에서 나온 것입니다)', { other_root: other })
      break
    }
  }

  /* 여기까지 왔다면 본문은 반드시 읽혔다 → 사용 가능. 도구 누락 / 키 누락 / 플레이스홀더 / 경로가 다른 머신에서 온 것 모두 결손으로만 기록한다. */
  return {
    name,
    status: 'available',
    issues,
    problems: issues.map((x) => x.detail),
    needs_user: Array.from(new Set(needsUser)),
    ...(shadowed === null ? {} : { shadowed_by: shadowed.root, shadowed_path: shadowed.path }),
    checked: { file, env: envNames, missing_env: missingEnv, paths, missing_paths: missingPaths },
  }
}

/** 여러 스킬의 상태를 집계한다(패널 상단 라벨과 preflight 의 반환값이 모두 이것을 쓴다). */
export function summarizeSkills(results) {
  const out = { total: results.length, available: 0, broken: 0, unknown: 0 }
  for (const r of results) out[r.status] = (out[r.status] || 0) + 1
  return out
}
