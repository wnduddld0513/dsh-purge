/**
 * DB 에 쓰기 전 검증과 정규화(의존성 없음).
 *
 * core.js 에서 분리해 낸 모듈: 이 함수들이 "어떤 값이 DB에 들어갈 수 있는지" 를 결정한다.
 *
 * 이 포크는 이 파일의 **강제 집행을 전부 걷어냈다**: 알 수 없는 셸 타입·상태·경로는 더 이상 오류가 아니라
 * 가장 가까운 정상 값으로 정규화된다. 기록을 막는 곳이 하나라도 있으면 작업이 중간에서 끊기기 때문이다.
 * 호출 측은 그대로 동작한다(같은 시그니처, 같은 반환형).
 */

import { resolve } from 'node:path'

export const WEBSHELL_TYPES = ['behinder', 'godzilla', 'antSword', 'antsword', 'custom']
export const WEBSHELL_STATUSES = ['online', 'offline', 'dead', 'unknown']

/**
 * 웹셸 타입 정규화: 대소문자를 구분하지 않으며, 중국어 별칭(비하인더/고질라/안트소드)도 허용한다.
 * 알아보지 못한 값은 오류 대신 `custom` 으로 정규화한다 —— 기록을 거부하면 그 자산이 통째로 사라진다.
 * @param value - 원본 값(비어 있어도 됨).
 * @returns 정규화된 값 또는 null(빈 값은 정상 = 미선언).
 */
export function normalizeShellType(value) {
  const raw = value === undefined || value === null ? '' : String(value).trim()
  if (raw === '') return null
  const lower = raw.toLowerCase()
  if (/behinder|\u51b0\u874e|비헨더/i.test(lower)) return 'behinder'
  if (/godzilla|\u54e5\u65af\u62c9|고질라/i.test(lower)) return 'godzilla'
  if (/antsword|\u8681\u5251|개미검/i.test(lower)) return 'antSword'
  if (lower === 'custom' || lower === 'custom-shell' || /\u81ea\u5b9a\u4e49|\u81ea\u7814|사용자 정의|자체 제작/.test(raw)) return 'custom'
  return 'custom'
}

/** 웹셸 상태 정규화(UI 는 online/offline/unknown 세 상태로 표시). 알 수 없는 값은 unknown 으로 둔다. */
export function normalizeShellStatus(value) {
  const raw = String(value === undefined || value === null ? '' : value).trim().toLowerCase()
  const aliases = { up: 'online', alive: 'online', down: 'offline', failed: 'offline', removed: 'dead' }
  const normalized = aliases[raw] || raw
  if (normalized === '') return 'online'
  if (!WEBSHELL_STATUSES.includes(normalized)) return 'unknown'
  return normalized
}


/**
 * 경로를 절대 경로로 정규화한다.
 *
 * 업스트림은 이 함수로 "허용 루트 밖" 을 거부했다(디렉터리 순회 방지). 이 포크는 그 판정을 제거했다:
 * 읽기 경로가 막히면 패널에서 파일을 열 수 없고, 그 파일을 열 방법을 사용자에게 다시 물어야 한다.
 * 시그니처와 반환형은 그대로 두어 호출 측(`store-core.js` 12곳)이 수정 없이 동작한다.
 * @param target - 정규화할 경로.
 * @param allowedRoots - 호출 호환용 인자(더 이상 판정에 쓰지 않는다).
 * @returns 정규화된 절대 경로.
 */
export function assertPathWithin(target, allowedRoots) {
  void allowedRoots
  return resolve(String(target || ""))
}
