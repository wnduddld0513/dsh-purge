/**
 * dsh-purge 드릴 콘솔 자체 부트스트랩(host 측 절반)
 *
 * 자산 라이브러리, 도구, 프리셋, 스킬이 모두 이 플러그인 디렉터리 안에 있다. 이 파일이 담당하는 것:
 *   1. 최초로 `presets/redteam` 을 `$DSH_HOME/.agent-presets/redteam/` 에 안착시킨다
 *   2. 패키지 동봉 스킬을 `$DSH_HOME/redteam/skills` 에 안착시키고, 프리셋이 `dshHomePath` 로 그것을 가리키게 한다
 *   3. 사용자 프리셋이 이미 있으면 무효 경로 / 옛 패키지 이름만 고치고, 통째로 덮어쓰지 않는다
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readPresetDefinition } from './preset-composition.js'
import { scheduleClearOwnedSelectedDefault } from '../preset-default.js'
import { ensureAllProfileBodyInserts } from '../profile-insert.js'

/** Cordis 플러그인 이름. */
export const name = 'dsh-purge-redteam'

/** "liangshen" 과 일관: agentPresets 에 하드 의존하지 않고, 준비되면 소프트하게 가져와 선언한다. */
export const inject = []

/** 모드 드롭다운의 프리셋 id (디렉터리 이름 / registry id). */
const REDTEAM_PRESET_ID = 'redteam'

/** 플러그인 루트 디렉터리 (lib/redteam → 두 단계 위). */
export function packagePaths() {
  const root = fileURLToPath(new URL('../..', import.meta.url))
  return {
    root,
    presets: join(root, 'presets'),
    presetDir: join(root, 'presets', 'redteam'),
    skills: join(root, 'skills', 'redteam'),
    setupScript: join(root, 'scripts', 'redteam-setup.sh'),
  }
}

/** 환경 데이터 디렉터리 (store/tools 가 쓰는 것과 같은 규약). */
export function redteamDataDir() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'redteam')
}

/**
 * 패키지에 동봉되어 배포되는 환경 설치 스크립트를 `$DSH_HOME/redteam/setup.sh` 에 안착시킨다.
 *
 * 마켓 패키지 사용자는 설치 후 node_modules 만 있고 저장소는 디스크에 없다; 사전 점검이 "저장소에서 스크립트를 가져온다" 고만 말하면,
 * 사용자는 스크립트를 얻지 못하고 최초 안내가 끊긴다. 그래서 스크립트는 패키지를 따라가고, 시작할 때 실행 가능한 사본 하나를 안착시킨다.
 * 의미: 대상이 없으면 → 설치; 있지만 내용이 다르면 → 덮어쓰기(스크립트에는 사용자가 바꿀 상태가 없다);
 *       내용이 같으면 → 그대로 둔다(매번 시작할 때 디스크에 쓰는 것을 피한다).
 *
 * @returns `{ action: 'installed'|'updated'|'kept'|'missing', path }`
 */
export function installSetupScript() {
  const paths = packagePaths()
  const target = join(redteamDataDir(), 'setup.sh')
  if (!existsSync(paths.setupScript)) return { action: 'missing', path: target }
  let wanted
  try {
    wanted = readFileSync(paths.setupScript, 'utf8')
  } catch {
    return { action: 'missing', path: target }
  }
  try {
    mkdirSync(redteamDataDir(), { recursive: true })
    if (existsSync(target)) {
      let current
      try { current = readFileSync(target, 'utf8') } catch { current = '' }
      if (current === wanted) {
        /* 권한이 외부에서 바뀌었을 수 있으니 여기서 함께 되돌려 둔다(스크립트는 바로 bash 로 실행되어야 한다) */
        try { chmodSync(target, 0o755) } catch { /* 무시 */ }
        return { action: 'kept', path: target }
      }
      writeFileSync(target, wanted, { encoding: 'utf8', mode: 0o755 })
      return { action: 'updated', path: target }
    }
    writeFileSync(target, wanted, { encoding: 'utf8', mode: 0o755 })
    return { action: 'installed', path: target }
  } catch (error) {
    return { action: 'missing', path: target, error: error && error.message ? error.message : String(error) }
  }
}

/** 사용자 preset 루트 (dsh-agent-presets 의 USER_PRESET_DIR 와 일관 유지). */
export function userPresetRoot() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, '.agent-presets')
}

/**
 * 프리셋 템플릿에 있는 스킬 디렉터리 플레이스홀더 (build.mjs 가 패키징 프리셋에 써 넣고, 배치 시점에 치환된다).
 * 확장자 등을 다른 형태로 쓰면 안 되고, 그렇지 않으면 치환이 누락된다.
 */
const SKILLS_PLACEHOLDER = '{{REDTEAM_SKILLS_DIR}}'

/** customSkillDirs 에서 "이 패키지의 skills/ 디렉터리처럼 보이는" 그 줄 (옛 절대 경로 / 플레이스홀더 모두 해당). */
function isSkillsDirLine(line) {
  const text = line.trim().replace(/^-\s*/, '')
  if (text === SKILLS_PLACEHOLDER) return true
  return /[/\\](dsh-redteam-mode|redteam-bundle)[/\\]skills\/?$/.test(text)
    || /[/\\]vendor[/\\]redteam[/\\]skills\/?$/.test(text)
    || /[/\\]skills[/\\]redteam\/?$/.test(text)
}

/** 프리셋에서 패키지 동봉 스킬을 가리키는 그 줄. 로드할 때 현재 DSH_HOME 으로 해석하며, 로컬 절대 경로를 쓰지 않는다. */
const BUNDLED_SKILLS_EXPR = "!!js dshHomePath('redteam/skills')"

/**
 * 플레이스홀더나 하드코딩된 로컬 경로를 `dshHomePath('redteam/skills')` 로 바꾼다.
 *
 * 플레이스홀더가 YAML 에 남으면 객체로 해석되어 프리셋 전체가 걸리지 않는다. 하드코딩하면
 * `profiles/desktop/node_modules/...` 는 이 한 대의 데스크톱 설치에서만 성립하고,
 * Web, 다른 머신, 설치 위치를 바꾼 경우에는 모두 빈 곳을 가리킨다. 스킬 파일은 installBundledSkills 가
 * `$DSH_HOME/redteam/skills` 에 놓는다.
 */
function renderSkillsDir(text) {
  if (text.includes(SKILLS_PLACEHOLDER)) {
    return { text: text.split(SKILLS_PLACEHOLDER).join(BUNDLED_SKILLS_EXPR), changed: true, reason: 'placeholder' }
  }
  let changed = false
  const out = text.split('\n').map((line) => {
    if (!isSkillsDirLine(line)) return line
    const indent = /^(\s*)/.exec(line)[1]
    const wanted = indent + '- ' + BUNDLED_SKILLS_EXPR
    if (line === wanted) return line
    changed = true
    return wanted
  }).join('\n')
  return { text: out, changed, reason: changed ? 'stale-path' : 'none' }
}

/**
 * 스킬 동기화 대상 디렉터리 (첫 번째가 주 대상이고, 나머지는 "겸사겸사 사본을 하나 더 두는" 것).
 *
 * `$DSH_HOME` 에는 두 가지 가능한 출처가 있다: 플러그인 프로세스의 `process.env.DSH_HOME || homedir()/.dsh` ,
 * 그리고 호스트 `dshHomePath()` 가 해석해 내는 home 이다. 디스크를 바꾼 / profile 을 바꾼 / `HOME` 이 빈 머신에서는 둘이
 * 갈라진다 —— 스킬은 한쪽에만 안착하고, 프리셋이 다른 쪽을 가리키면 "설치했는데 나열되지 않음 / 사용 불가로 표시" 가 된다.
 * 그래서: 주 대상은 반드시 쓰고, 다른 후보 home 은 이 머신에 실제로 존재할 때만 사본을 하나 더 둔다(없는 home 을 만들어 내지 않는다).
 */
function skillSyncTargets() {
  const homes = []
  const push = (p) => { if (p && !homes.includes(p)) homes.push(p) }
  push(process.env.DSH_HOME)
  push(join(homedir(), '.dsh'))
  const primary = join(redteamDataDir(), 'skills')
  const dirs = [primary]
  for (const home of homes) {
    if (!existsSync(home)) continue
    const dir = join(home, 'redteam', 'skills')
    if (!dirs.includes(dir)) dirs.push(dir)
  }
  return dirs
}

/**
 * 패키지 안의 `skills/redteam/*.md` 를 `$DSH_HOME/redteam/skills` 로 동기화한다(갈라질 때는 두 home 에 모두 사본을 둔다).
 * 같은 이름 파일은 패키지 안 내용으로 덮어쓴다. 사용자 자신의 사본은 `$DSH_HOME/skills` 에 있고 여기서 바꾸지 않는다.
 */
export function installBundledSkills() {
  const paths = packagePaths()
  const targets = skillSyncTargets()
  if (!existsSync(paths.skills)) return { action: 'missing', path: targets[0], copied: 0 }
  const files = readdirSync(paths.skills).filter((f) => f.endsWith('.md'))
  let copied = 0
  for (const target of targets) {
    mkdirSync(target, { recursive: true })
    for (const file of files) {
      const wanted = readFileSync(join(paths.skills, file))
      const dest = join(target, file)
      let same = false
      try { same = readFileSync(dest).equals(wanted) } catch { same = false }
      if (same) continue
      writeFileSync(dest, wanted)
      if (target === targets[0]) copied += 1
    }
  }
  return { action: copied > 0 ? 'updated' : 'kept', path: targets[0], copied, targets }
}

/** 옛 조합은 프리셋 전체를 broken 으로 표시한다(worker-thread 미설치 / tools 가 redteam 에 하드 의존). */
function needsCompositionRepair(presetFile) {
  if (!existsSync(presetFile)) return true
  try {
    const text = readFileSync(presetFile, 'utf8')
    if (!text.includes('id: workflow-ptc')) return true
    if (/name:\s*'@deepseek-ai\/dsh-workflow-worker-thread'[\s\S]{0,80}?config:\s*\n\s*provider:\s*spawn/.test(text)
      && !/name:\s*'@deepseek-ai\/dsh-workflow-worker-thread'\s*\n\s*disabled:\s*true/.test(text)) {
      return true
    }
    return false
  } catch {
    return true
  }
}

/** 0.2.1 에서 toolFilter 폐기: 옛 사용자 프리셋에 남아 있으면 레드팀 모드 전체 로딩이 실패한다. */
function stripToolFilter(text) {
  const lines = String(text || '').split(/\r?\n/)
  const out = []
  let skipIndent = null
  let changed = false
  for (const line of lines) {
    if (skipIndent !== null) {
      const indent = (/^(\s*)/.exec(line) || ['', ''])[1].length
      if (line.trim() !== '' && indent > skipIndent) {
        changed = true
        continue
      }
      skipIndent = null
    }
    const block = /^(\s*)toolFilter:\s*(?:#.*)?$/.exec(line)
    if (block) {
      skipIndent = block[1].length
      changed = true
      continue
    }
    if (/^\s*toolFilter:\s+\S/.test(line)) {
      changed = true
      continue
    }
    out.push(line)
  }
  return { text: out.join('\n'), changed }
}

/**
 * 독립 레드팀 패키지에서 dsh-purge 로 옮긴 뒤, 프리셋의 도구 줄 패키지 이름도 함께 바꿔야 한다.
 * 두 가지 역사적 이름을 모두 인정해야 한다: `dsh-redteam-mode/tools` 와 `<임의의 fork 접두사>/redteam/tools`
 * (`dsh-purge-community/redteam/tools` 포함), 모두 dsh-purge/redteam/tools 로 통일한다.
 * 한 가지를 덜 인정하면 옛 프리셋이 영원히 옛 패키지 이름에 머물고, 매번 시작할 때 `never started` 를 보고한다.
 */
const TOOLS_PACKAGE_RE = /^([ \t]*name:[ \t]*)(['"]?)([^\s'"#]*(?:\/redteam\/tools|-mode\/tools))\2([ \t]*)$/gm
const TOOLS_PACKAGE_CANONICAL = 'dsh-purge/redteam/tools'

function renderToolsPackage(text) {
  const source = String(text || '')
  let changed = false
  const next = source.replace(
    TOOLS_PACKAGE_RE,
    (line, head, quote, value, tail) => {
      if (value === TOOLS_PACKAGE_CANONICAL) return line
      changed = true
      return head + quote + TOOLS_PACKAGE_CANONICAL + quote + tail
    },
  )
  return { text: changed ? next : source, changed }
}

/**
 * 자동 복구: 지휘 책임 제목 + Agent Teams profile 아래에서 classic subagent 를 강제로 다시 활성화.
 * 사용자 프리셋을 통째로 덮어쓰지 않고, 작업 배분이 실패하게 만드는 몇 군데만 고친다.
 */
function repairDelegation(text) {
  let next = String(text || "")
  let changed = false
  if (next.includes("\u4f60\u662f\u8c01\u3001\u4f60\u4e0d\u505a\u4ec0\u4e48") || next.includes("## 당신은 누구이고, 무엇을 하지 않는가")) {
    next = next.split("\u4f60\u662f\u8c01\u3001\u4f60\u4e0d\u505a\u4ec0\u4e48").join("## 지휘 책임(하드 제약)").split("## 당신은 누구이고, 무엇을 하지 않는가").join("## 지휘 책임(하드 제약)")
    changed = true
  }
  const mark = "**반드시 네이티브 `subagent` 도구로 작업을 배분해야 한다**"
  if ((next.includes("\u6307\u6325\u804c\u8d23") || next.includes("## 지휘 책임")) && !next.includes(mark)) {
    const needle = "`redteam_session_info`."
    const at = next.indexOf(needle)
    if (at >= 0) {
      next =
        next.slice(0, at + needle.length) +
        "\n      " + mark +
        "; Agent Teams 의 `spawn_teammate` 로 바꾸지 마라(레드팀 역할 원고 / 동시성 게이트 / 리프 제약이 모두 `subagent` 경로에 걸려 있다)." +
        next.slice(at + needle.length)
      changed = true
    }
  }
  for (const id of [
    "tool-subagent-control",
    "tool-subagent-list-agents",
    "tool-subagent",
    "tool-subagent-fork",
  ]) {
    const idLine = `- id: ${id}`
    let from = 0
    while (from < next.length) {
      const at = next.indexOf(idLine, from)
      if (at < 0) break
      const endId = at + idLine.length
      const ch = next[endId] || "\n"
      // tool-subagent 가 tool-subagent-control / fork / codex 를 오매칭하지 않도록 한다
      if (ch !== "\n" && ch !== "\r" && ch !== " " && ch !== "\t") {
        from = endId
        continue
      }
      const after = endId
      const rest = next.slice(after)
      const endRel = rest.search(/\n[ \t]*- id: /)
      const block = endRel < 0 ? rest : rest.slice(0, endRel)
      if (/disabled:\s*false/.test(block)) break
      if (/disabled:\s*true/.test(block)) {
        const patched = block.replace(/disabled:\s*true/, "disabled: false")
        next = next.slice(0, after) + patched + next.slice(after + block.length)
        changed = true
        break
      }
      const indentMatch = /\n([ \t]+)name:/.exec(block)
      const indent = indentMatch ? indentMatch[1] : "      "
      next = next.slice(0, after) + `\n${indent}disabled: false` + next.slice(after)
      changed = true
      break
    }
  }
  return { text: next, changed }
}

/** 패키지 내 앵커 게이트를 프리셋 템플릿과 대조하기 위한 마커로, 기존 사용자 프리셋에 한 줄을 보충하고 통째로 덮어쓰지 않는 데 쓴다. */
const ANCHOR_ROW_MARK = '- id: anchor-gate'
const ANCHOR_BLOCK_START = '# 앵커 게이트:'  // 프리셋 템플릿의 실제 제목
const REDTEAM_TOOLS_MARK = '- id: redteam-tools'

function anchorBlockBounds(ymlText) {
  const start = ymlText.indexOf(ANCHOR_BLOCK_START)
  const end = ymlText.indexOf(REDTEAM_TOOLS_MARK)
  if (start === -1 || end === -1 || start >= end) return null
  return { start, end }
}

function readAnchorBlockFromTemplate() {
  let template = ''
  try {
    template = readFileSync(join(packagePaths().presetDir, 'agent.cordis.yml'), 'utf8')
  } catch {
    return null
  }
  const bounds = anchorBlockBounds(template)
  if (!bounds) return null
  return template.slice(bounds.start, bounds.end).trim()
}

/**
 * 앵커 게이트 스크립트는 매번 패키지 내 사본으로 덮어쓴다(사용자가 바꿀 상태가 없다).
 * YAML 의 앵커 설정 블록이 패키지 내 템플릿과 일치하지 않을 때도 교체하며(bootstrapMaxTokens 등), 나머지 preset 본문은 유지한다.
 * @returns {'inserted'|'updated'|'config-updated'|'kept'|'missing'}
 */
function syncAnchorGate(targetDir) {
  const src = join(packagePaths().presetDir, 'anchor-gate.mjs')
  const dest = join(targetDir, 'anchor-gate.mjs')
  if (!existsSync(src)) return 'missing'
  mkdirSync(targetDir, { recursive: true })
  const wanted = readFileSync(src, 'utf8')
  let current = ''
  try { current = readFileSync(dest, 'utf8') } catch { current = '' }
  let script = 'kept'
  if (current !== wanted) {
    writeFileSync(dest, wanted, 'utf8')
    script = 'updated'
  }
  const presetFile = join(targetDir, 'agent.cordis.yml')
  if (!existsSync(presetFile)) return script
  let text
  try { text = readFileSync(presetFile, 'utf8') } catch { return script }
  const templateBlock = readAnchorBlockFromTemplate()
  if (!templateBlock) return script
  const nl = text.includes('\r\n') ? '\r\n' : '\n'
  const rendered = templateBlock.replace(/\r\n/g, '\n').replace(/\n/g, nl)

  if (text.includes(ANCHOR_ROW_MARK)) {
    const bounds = anchorBlockBounds(text)
    if (!bounds) return script
    const currentBlock = text.slice(bounds.start, bounds.end).trim()
    if (currentBlock === rendered.trim()) return script
    const next = text.slice(0, bounds.start) + rendered + nl + nl + text.slice(bounds.end)
    writeFileSync(presetFile, next, 'utf8')
    return script === 'updated' ? 'updated' : 'config-updated'
  }

  const at = text.indexOf(REDTEAM_TOOLS_MARK)
  const next = at === -1
    ? text.replace(/\s*$/, '') + nl + nl + rendered + nl
    : text.slice(0, at) + rendered + nl + nl + text.slice(at)
  writeFileSync(presetFile, next, 'utf8')
  return 'inserted'
}

/**
 * 패키지 내 프리셋을 사용자 preset 루트에 배치한다.
 *
 * 의미 (v0.9.0 부터):
 *   · 대상이 없으면 → 전체 설치(플레이스홀더를 실제 경로로 치환);
 *   · 대상이 이미 존재 → **기본적으로 사용자 내용을 덮어쓰지 않지만 자동 복구한다**: 안에 아직
 *     `{{REDTEAM_SKILLS_DIR}}` 가 남아 있거나, 하드코딩된 로컬 스킬 경로가 있으면 `dshHomePath('redteam/skills')` 로 바꾼다.
 *     앵커 게이트 스크립트는 갱신되고, 그 줄이 빠져 있으면 보충된다. 나머지 내용은 유지된다.
 *   · `force: true` 일 때만 패키지 내 템플릿으로 전체를 덮어쓴다.
 *
 * @param options - `{ force?: boolean, log?: (msg: string) => void }`
 * @returns `{ action: 'installed'|'kept'|'repaired', dir, skillsDir, skills, repaired? }`
 */
export function installPreset(options = {}) {
  const paths = packagePaths()
  const bundled = installBundledSkills()
  const target = join(userPresetRoot(), 'redteam')
  const log = options.log ?? (() => {})
  const skillCount = existsSync(paths.skills)
    ? readdirSync(paths.skills).filter((f) => f.endsWith('.md')).length
    : 0
  const presetFile = join(target, 'agent.cordis.yml')

  if (existsSync(presetFile) && options.force !== true) {
    /* 자동 복구: 플레이스홀더가 치환되지 않음 / 스킬 디렉터리가 무효가 된 옛 패키지 경로를 가리킴 → 그 자리에서 고친다 */
    let text
    try {
      text = readFileSync(presetFile, 'utf8')
    } catch (error) {
      log(`${presetFile} 읽기 실패: ${error && error.message ? error.message : String(error)}`)
      return { action: 'kept', dir: target, skillsDir: bundled.path, skills: skillCount }
    }
    const rendered = renderSkillsDir(text)
    const tools = renderToolsPackage(rendered.text)
    const filter = stripToolFilter(tools.text)
    const delegation = repairDelegation(filter.text)
    const next = delegation.text
    if (rendered.changed || tools.changed || filter.changed || delegation.changed) {
      writeFileSync(presetFile, next.replace(/\r\n/g, '\n').replace(/\r/g, '\n'), 'utf8')
      log(
        (rendered.changed
          ? (rendered.reason === 'placeholder'
            ? '프리셋에 아직 ' + SKILLS_PLACEHOLDER + ' 가 남아 있습니다(프리셋 전체 마운트가 실패합니다)'
            : '프리셋의 스킬 디렉터리가 로컬 절대 경로로 적혀 있습니다')
            + ', dshHomePath(\'redteam/skills\') 로 변경했습니다'
          : '')
        + (tools.changed ? (rendered.changed ? ';' : '') + '도구 패키지 이름을 dsh-purge/redteam/tools 로 변경했습니다' : '')
        + (filter.changed
          ? ((rendered.changed || tools.changed) ? ';' : '') + '0.2.1 에서 폐기된 toolFilter 를 제거했습니다'
          : '')
        + (delegation.changed
          ? ((rendered.changed || tools.changed || filter.changed) ? ';' : '') + '지휘 작업 배분 제약을 수정하고 subagent 를 다시 활성화했습니다'
          : ''),
      )
    }
    const anchor = syncAnchorGate(target)
    if (anchor === 'inserted') log('기존 프리셋에 앵커 게이트를 보충했습니다(나머지 내용은 유지)')
    else if (anchor === 'updated') log('앵커 게이트 스크립트를 업데이트했습니다')
    else if (anchor === 'config-updated') log('앵커 게이트 설정을 동기화했습니다(bootstrapMaxTokens / maxBootstrapSteps 등)')
    const repaired = [
      rendered.changed ? rendered.reason : null,
      tools.changed ? 'tools-package' : null,
      filter.changed ? 'toolFilter' : null,
      delegation.changed ? 'delegation' : null,
      anchor === 'inserted' ? 'anchor-gate' : null,
      anchor === 'updated' ? 'anchor-script' : null,
      anchor === 'config-updated' ? 'anchor-config' : null,
    ].filter(Boolean)
    if (repaired.length > 0) {
      return {
        action: 'repaired', dir: target, skillsDir: bundled.path, skills: skillCount,
        repaired: repaired.join('+'),
      }
    }
    log(`사용자 자신의 프리셋 ${target} 이 이미 있어 그대로 유지합니다(덮어쓰려면: REDTEAM_PRESET_REFRESH=1 로 한 번 시작)`)
    return { action: 'kept', dir: target, skillsDir: bundled.path, skills: skillCount }
  }

  mkdirSync(target, { recursive: true })
  for (const file of readdirSync(paths.presetDir)) {
    const text = readFileSync(join(paths.presetDir, file), 'utf8')
    const rendered = renderToolsPackage(renderSkillsDir(text).text).text
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
    writeFileSync(join(target, file), rendered, 'utf8')
  }
  syncAnchorGate(target)
  log(`프리셋이 ${target} 에 설치되었습니다(동봉 스킬 ${skillCount} 개, 디렉터리 ${bundled.path})`)
  return { action: 'installed', dir: target, skillsDir: bundled.path, skills: skillCount }
}

/**
 * @param ctx - 플러그인 컨텍스트.
 */
export function apply(ctx) {
  try {
    const home = process.env.DSH_HOME || join(homedir(), '.dsh')
    const healed = ensureAllProfileBodyInserts(home)
    for (const item of healed) {
      if (item.wrote) {
        ctx.logger?.info?.('redteam-mode: 본체 insert 를 보충했습니다 %s (다음 시작 시 메인 플러그인 로드)', item.path)
      }
    }
  } catch { /* 자가 복구 실패가 프리셋 적용을 막지는 않는다 */ }

  const paths = packagePaths()
  let result
  try {
    result = installPreset({
      force: process.env.REDTEAM_PRESET_REFRESH === '1'
        || needsCompositionRepair(join(userPresetRoot(), 'redteam', 'agent.cordis.yml')),
      log: (msg) => ctx.logger?.info?.('redteam-mode: ' + msg),
    })
  } catch (error) {
    ctx.logger?.error?.('redteam-mode: 프리셋 설치 실패: %s', error && error.message ? error.message : String(error))
    result = { action: 'failed', dir: join(userPresetRoot(), 'redteam'), skillsDir: join(redteamDataDir(), 'skills'), skills: 0 }
  }
  let setupResult
  try {
    setupResult = installSetupScript()
  } catch (error) {
    setupResult = { action: 'missing', error: error && error.message ? error.message : String(error) }
  }
  if (setupResult.action === 'installed' || setupResult.action === 'updated') {
    ctx.logger?.info?.('redteam-mode: 환경 설치 스크립트 준비 완료 %s(%s)', setupResult.path, setupResult.action)
  }

  /*
   * Web 0.1.7+ 모드 드롭다운은 agent-preset registry.register() 만 인식하므로,
   * 디스크의 .agent-presets 를 스캔해도 드롭다운에 나타나지 않는다("liangshen" 도 동일).
   */
  const statusFile = join(redteamDataDir(), 'preset-declare.json')
  const writeStatus = (patch) => {
    try {
      mkdirSync(redteamDataDir(), { recursive: true })
      let prev = {}
      try { prev = JSON.parse(readFileSync(statusFile, 'utf8')) } catch { /* first */ }
      writeFileSync(statusFile, JSON.stringify({ ...prev, ...patch, at: new Date().toISOString() }, null, 2), 'utf8')
    } catch { /* ignore */ }
  }
  writeStatus({ ok: false, phase: 'apply-start', skillsDir: result.skillsDir, presetDir: result.dir })

  let releaseDeclared
  let closed = false
  const softRegistry = () => {
    try {
      if (ctx.agentPresets && typeof ctx.agentPresets.register === 'function') return ctx.agentPresets
    } catch { /* without inject */ }
    try {
      const reg = ctx.get('agentPresets')
      if (reg && typeof reg.register === 'function') return reg
    } catch { /* missing */ }
    return null
  }
  const undeclare = async () => {
    const dispose = releaseDeclared
    releaseDeclared = undefined
    if (!dispose) return
    try { await dispose() } catch (error) {
      ctx.logger?.warn?.('redteam-mode: undeclare failed: %s', error?.message || String(error))
    }
  }
  const buildDefinition = () => {
    const fromDisk = join(userPresetRoot(), 'redteam')
    if (!existsSync(join(fromDisk, 'agent.cordis.yml'))) {
      installPreset({ force: false, log: () => {} })
    }
    const readyDir = existsSync(join(userPresetRoot(), 'redteam', 'agent.cordis.yml'))
      ? join(userPresetRoot(), 'redteam')
      : paths.presetDir
    return readPresetDefinition(REDTEAM_PRESET_ID, readyDir)
  }
  const registerOnce = (registry) => {
    let definition
    try {
      definition = buildDefinition()
    } catch (error) {
      writeStatus({ ok: false, phase: 'read-failed', error: error?.message || String(error) })
      ctx.logger?.warn?.('redteam-mode: read preset failed: %s', error?.message || String(error))
      return
    }
    writeStatus({
      ok: false,
      phase: 'registering',
      id: definition.id,
      name: definition.name,
      plugins: Array.isArray(definition.plugins) ? definition.plugins.length : -1,
    })
    Promise.resolve()
      .then(async () => {
        await undeclare()
        releaseDeclared = await registry.register(definition)
        let broken = null
        try {
          const row = (await registry.list()).find((p) => p.id === REDTEAM_PRESET_ID)
          broken = row?.broken || null
        } catch { /* ignore */ }
        writeStatus({
          ok: !broken,
          phase: broken ? 'registered-broken' : 'registered',
          id: definition.id,
          name: definition.name,
          plugins: Array.isArray(definition.plugins) ? definition.plugins.length : -1,
          broken,
        })
        if (broken) ctx.logger?.warn?.('redteam-mode: declared but broken: %s', broken)
        else ctx.logger?.info?.('redteam-mode: declared for mode dropdown: %s', definition.name || REDTEAM_PRESET_ID)
      })
      .catch((error) => {
        writeStatus({ ok: false, phase: 'register-failed', error: error?.message || String(error) })
        ctx.logger?.warn?.('redteam-mode: register failed: %s', error?.message || String(error))
      })
  }

  ctx.effect(() => {
    let tries = 0
    const tick = () => {
      if (closed) return true
      tries += 1
      const registry = softRegistry()
      if (!registry) {
        writeStatus({ ok: false, phase: 'waiting-registry', tries })
        return false
      }
      registerOnce(registry)
      return true
    }
    let timer
    let stop
    if (!tick()) {
      timer = setInterval(() => {
        if (tick()) {
          clearInterval(timer)
          timer = undefined
          if (stop) clearTimeout(stop)
        }
      }, 400)
      if (typeof timer.unref === 'function') timer.unref()
      stop = setTimeout(() => {
        if (timer) {
          clearInterval(timer)
          timer = undefined
          writeStatus({ ok: false, phase: 'timeout-waiting-registry', tries })
        }
      }, 45000)
      try { stop.unref?.() } catch { /* ignore */ }
    }
    return () => {
      closed = true
      if (timer) clearInterval(timer)
      if (stop) clearTimeout(stop)
      try { scheduleClearOwnedSelectedDefault({ ctx }) } catch { /* 기본값 정리 실패가 비활성화를 막지는 않는다 */ }
      void undeclare()
    }
  }, 'dsh-purge-redteam: declare agent preset')

  ctx.provide('redteamMode', Object.freeze({ paths, preset: result, setup: setupResult }))
  ctx.logger?.info?.(
    'redteam-mode: 준비 완료(데이터 디렉터리 기본값 $DSH_HOME/redteam; 프리셋 %s; 스킬 디렉터리 %s)',
    result.dir, result.skillsDir,
  )
}

export default { name, inject, apply }
