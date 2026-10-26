/**
 * RedTeam 자산 라이브러리 —— Cordis Host 플러그인 셸
 *
 * 역할: {@link RedteamStore} 를 프로세스 수준 서비스 `ctx.redteam` 으로 공개해
 *   · 클라이언트 UI(dsh-redteam-ui 의 HTTP 브리지를 거침)
 *   · 각 역할 에이전트의 도구 행(preset 계층, ctx.redteam 주입)
 * 가 같은 SQLite 사실 DB 를 함께 읽게 한다.
 *
 * 계층 소속은 host 이다. 자산 데이터는 세션을 넘어 이후 취약점 탐지/익스플로잇/내부 네트워크 에이전트가 공유해야 하므로,
 * 서비스 인스턴스는 프로세스 수준에서 유일해야 하고 preset 에 넣을 수 없다.
 *
 * 외부 의존성 없음: node: 내장 모듈만 쓰므로, profile 에서 node_modules 를 찾지 못하는 상황을 피한다.
 */
import { join } from 'node:path'
import { homedir } from 'node:os'
import { readFileSync } from 'node:fs'
import { RedteamStore } from './store-core.js'

/** Cordis 플러그인 이름. */
export const name = 'redteam-store'

/** 하드 의존성 없음: 데이터 계층이 다른 서비스에 기대지 않고도 활성화된다. */
export const inject = []

/**
 * 데이터 루트 디렉터리 해석: 명시적 설정 > REDTEAM_HOME > $DSH_HOME/redteam (왼쪽이 우선).
 * 조합 계층에서는 보통 `!!js dshHomePath('redteam')` 로 절대 경로를 바로 넘긴다.
 */
function resolveRoot(config) {
  if (config && typeof config.root === 'string' && config.root.length > 0) return config.root
  if (process.env.REDTEAM_HOME) return process.env.REDTEAM_HOME
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'redteam')
}

/**
 * 이 플러그인 자신의 패키지 이름과 버전(UI 의 "버전 + 자동 업데이트" 에 쓴다).
 *
 * 두 곳을 모두 시도하는 이유: 마켓 패키지 `dsh-redteam-mode` 의 package.json 은 이 파일과 같은 위치에 있고
 * (생성된 lib/), 이 패키지를 단독으로 마운트할 때는 한 단계 위에 있다. 읽지 못하면 null 을 반환하고,
 * UI 는 "버전 미확인" 으로 표시하며 어떤 기능에도 영향을 주지 않는다.
 */
function readSelfPackage() {
  for (const rel of ['../package.json', '../../package.json']) {
    try {
      const pkg = JSON.parse(readFileSync(new URL(rel, import.meta.url), 'utf8'))
      if (pkg && typeof pkg.name === 'string' && typeof pkg.version === 'string') {
        return {
          name: pkg.name,
          version: pkg.version,
          description: typeof pkg.description === 'string' ? pkg.description : '',
          homepage: typeof pkg.homepage === 'string' ? pkg.homepage : null,
        }
      }
    } catch { /* 다음 후보로 */ }
  }
  return null
}

/**
 * @param ctx - 플러그인 컨텍스트.
 * @param config - `{ root?: string }`.
 */
export function apply(ctx, config = {}) {
  const root = resolveRoot(config)
  const store = new RedteamStore(root)
  /* 패키지 신원은 store 에 매달린다: UI 브리지 계층(redteam-ui)의 버전 표시와 업데이트 로직이 모두 여기에서 읽으므로,
     생성물에 버전 번호를 하드코딩하지 않아도 된다. */
  const self = readSelfPackage()
  if (self !== null) {
    try { store.plugin = Object.freeze(self) } catch { /* 무시 */ }
  }

  // 서비스는 fiber 언마운트와 함께 닫힌다: 모든 SQLite 핸들을 같은 지점에서 해제한다.
  ctx.effect(() => () => store.close())

  ctx.provide('redteam', store)
}

export { RedteamStore }
