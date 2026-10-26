/**
 * 플러그인 수준 설정(의존성 없음): 현재는 한 가지뿐 — **동시 실행 에이전트 상한**.
 *
 * 환경 변수를 쓰지 않는 이유: `REDTEAM_MAX_AGENTS` 는 시작 전에만 설정할 수 있어, 바꾼 뒤에는 dsh web 을 재시작해야 한다.
 * 반면 "동시에 몇 개의 실행 에이전트를 파견할지"는 사용 중 가장 자주 조정하는 항목이라, 패널에서 바로 바꿀 수 있어야 한다.
 * 그래서 JSON 한 부를 팩트 저장소 루트 디렉터리에 기록한다: `$DSH_HOME/redteam/settings.json`.
 *
 * 적용 순서: settings.json → 환경 변수 `REDTEAM_MAX_AGENTS` → 기본값 3.
 * 도구 측(redteam_agent_slot 게이트)과 패널 측("에이전트" 페이지)이 같은 문서를 읽어, 두 곳의 기준이 어긋나지 않게 한다.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** 기본 동시성 상한(사용자 기준: 프로젝트 전체 기본 3개의 실행 에이전트). */
export const DEFAULT_MAX_AGENTS = 3

/** 하드 상한: 더 늘려도 빨라지지 않는다 — 같은 API Key 의 동시성/속도 제한이 먼저 걸려 오히려 테스트를 흔든다. */
export const MAX_AGENTS_LIMIT = 10

/** 설정 파일 경로(팩트 저장소와 같은 루트이며, 팩트 저장소와 함께 백업/이전된다). */
export function settingsPathOf(root) {
  return join(String(root || '.'), 'settings.json')
}

/** 전체 설정 읽기(읽지 못하거나 깨져도 빈 객체로 취급하고, 절대 예외를 던지지 않는다). */
export function readSettings(root) {
  try {
    if (!existsSync(settingsPathOf(root))) return {}
    const parsed = JSON.parse(readFileSync(settingsPathOf(root), 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch { return {} }
}

/** 여러 설정 항목을 병합해 쓰고, 기록 후의 전체 설정을 반환한다. */
export function writeSettings(root, patch) {
  const next = Object.assign({}, readSettings(root), patch)
  mkdirSync(String(root || '.'), { recursive: true })
  writeFileSync(settingsPathOf(root), JSON.stringify(next, null, 2) + '\n', 'utf8')
  return next
}

/** 임의 입력을 [1, MAX_AGENTS_LIMIT] 범위의 정수로 수렴시킨다. */
export function clampMaxAgents(value) {
  const n = Math.floor(Number(value))
  if (!Number.isFinite(n)) return DEFAULT_MAX_AGENTS
  return Math.min(Math.max(n, 1), MAX_AGENTS_LIMIT)
}

/**
 * 현재 적용 중인 동시성 상한.
 * @param root - 팩트 저장소 루트 디렉터리(`ctx.redteam.root`).
 * @param env - 환경 변수 표(테스트 주입을 쉽게 하기 위함).
 * @returns 적용 중인 정수 상한.
 */
export function maxAgentsOf(root, env = process.env) {
  const fromFile = Number(readSettings(root).maxAgents)
  if (Number.isFinite(fromFile) && fromFile > 0) return clampMaxAgents(fromFile)
  const fromEnv = Number(env && env.REDTEAM_MAX_AGENTS)
  if (Number.isFinite(fromEnv) && fromEnv > 0) return clampMaxAgents(fromEnv)
  return DEFAULT_MAX_AGENTS
}

/** 동시성 상한을 저장하고 실제 적용된 값을 반환한다. */
export function saveMaxAgents(root, value) {
  const applied = clampMaxAgents(value)
  writeSettings(root, { maxAgents: applied })
  return applied
}

/** 현재 설정이 어디서 왔는지(패널에 사실대로 밝혀 "바꿨는데 적용이 안 됐다"는 착각을 막는다). */
export function maxAgentsSourceOf(root, env = process.env) {
  const fromFile = Number(readSettings(root).maxAgents)
  if (Number.isFinite(fromFile) && fromFile > 0) return 'settings'
  const fromEnv = Number(env && env.REDTEAM_MAX_AGENTS)
  if (Number.isFinite(fromEnv) && fromEnv > 0) return 'env'
  return 'default'
}
