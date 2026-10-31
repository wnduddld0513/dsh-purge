/**
 * DB 에 쓰기 전 검증과 정규화(의존성 없음).
 *
 * core.js 에서 분리해 낸 모듈: 이 함수들이 "어떤 값이 DB에 들어갈 수 있는지" 를 결정하고,
 * 보안 경계가 여기에 있으므로(경로 순회, 잘못된 enum), 한곳에 모아 따로 읽고 따로 시험할 가치가 있다.
 */

import { resolve, sep } from 'node:path'

export const WEBSHELL_TYPES = ['behinder', 'godzilla', 'antSword', 'antsword', 'custom']
export const WEBSHELL_STATUSES = ['online', 'offline', 'dead', 'unknown']

/**
 * 웹셸 타입 정규화: 대소문자를 구분하지 않으며, 중국어 별칭(비하인더/고질라/안트소드)도 허용한다.
 * 알아보지 못하면 원문을 조용히 저장하지 않고 오류를 던진다 —— 패널의 "사용자가 연결할 수 없음" 빨간 표시와 세션 페이지의 접속 비밀번호 복사
 * 가 모두 이 필드로 판정하므로, 잘못 입력된 값이 들어가도 오류는 나지 않고 이 두 곳의 판정만 조용히 무력화된다.
 * @param value - 원본 값(비어 있어도 됨).
 * @returns 정규화된 값 또는 null(빈 값은 정상 = 미선언).
 */
export function normalizeShellType(value) {
  const raw = value === undefined || value === null ? '' : String(value).trim()
  if (raw === '') return null
  const lower = raw.toLowerCase()
  if (/behinder|冰蝎/.test(lower)) return 'behinder'
  if (/godzilla|哥斯拉/.test(lower)) return 'godzilla'
  if (/antsword|蚁剑/.test(lower)) return 'antSword'
  if (lower === 'custom' || lower === 'custom-shell' || /自定义|自研/.test(raw)) return 'custom'
  throw new Error("webshell shell_type 非法：" + JSON.stringify(value)
    + '。交付要求是**冰蝎马（behinder）/ 哥斯拉马（godzilla）**（用户要能自己连上）；'
    + '其它类型请填 custom（只作临时中转，面板会标"用户连不上"）。')
}

/** 웹셸 상태 정규화(UI 는 online/offline/unknown 세 상태로 표시). */
export function normalizeShellStatus(value) {
  const raw = String(value === undefined || value === null ? '' : value).trim().toLowerCase()
  const aliases = { up: 'online', alive: 'online', down: 'offline', failed: 'offline', removed: 'dead' }
  const normalized = aliases[raw] || raw
  if (normalized === '') return 'online'
  if (!WEBSHELL_STATUSES.includes(normalized)) {
    throw new Error("webshell status 非法：" + JSON.stringify(value) + "。合法值只有 " + WEBSHELL_STATUSES.join(" / ") + "。")
  }
  return normalized
}


/**
 * 경로는 허용된 루트 디렉터리 안에 있어야 한다(디렉터리 순회 방지).
 *
 * 왜 필요한가: `readAttackFile` / `pocGet` 이 읽는 것은 **데이터베이스의 path 컬럼**이고,
 * 그 컬럼은 에이전트가 `addAttackFile` / `savePoc` 을 거쳐 직접 써 넣은 값 —— 즉 신뢰할 수 없는 입력이다.
 * 여기에 `/etc/passwd` 나 `~/.ssh/id_rsa` 가 들어 있으면 패널에서 한 번 클릭하는 것만으로 파일이 브라우저로 읽혀 온다.
 * `deletePoc` 에는 이미 startsWith 방어가 있었지만 읽기 경로와 쓰기 경로는 빠져 있었고, 여기에서 하나의 공용 구현으로 보완한다.
 * @param target - 검증할 경로.
 * @param allowedRoots - 허용된 루트 디렉터리(배열).
 * @returns 정규화된 절대 경로.
 * @throws 범위를 벗어나면 오류를 던진다(호출 측은 "찾을 수 없음" 으로 처리하고, 조용히 내용을 반환하지 않는다).
 */
export function assertPathWithin(target, allowedRoots) {
  const abs = resolve(String(target || ""))
  const roots = (allowedRoots || []).filter((r) => typeof r === "string" && r !== "").map((r) => resolve(r))
  const okFlag = roots.some((root) => abs === root || abs.startsWith(root + sep))
  if (!okFlag) {
    throw new Error("path outside allowed roots: " + abs
      + "（允许的根：" + roots.join(", ") + "）。这条记录的文件路径不在本靶标目录内，已拒绝读取。")
  }
  return abs
}
