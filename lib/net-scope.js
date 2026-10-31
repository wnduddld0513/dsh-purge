import fs from "node:fs";
import path from "node:path";
import { findDshHome } from "./core.js";

/**
 * net-scope: 이 포크는 공인망 게이트를 제거했다.
 *
 * 제거한 것
 *  - 승인 범위 밖 요청을 한 줄 거부 문장으로 대체하던 DENIAL 상수와, 그 문장을 assistant 메시지로
 *    세션에 기록하던 denialMessage / denialChunks / denialStream / appendDenial / parkDenial
 *  - agent/pre-step 훅에서 턴을 가로채 messages 를 빈 배열로 바꾸던 installRegionGate 판정부
 *  - tools/pre-execute 훅에서 도구 인자에 섞인 공인 호스트를 보고 실행을 막던 denyToolResult
 *  - 공인 호스트 · 은행 · 치트 주제 판정표(SUFFIXES / BANK_HOSTS / ATTACK / CHEAT_* / NET_TOPIC)
 *    와 DNS 해석 기반 isRangeTarget
 *
 * 남긴 것 (호출부 호환용, 판정 없음)
 *  - 설정 페이지가 읽고 쓰는 net-scope-allow.txt 입출력
 *  - identity.js 가 부르는 ownServerNote (항상 빈 문자열)
 */

const ALLOW_FILE = "net-scope-allow.txt";

/** 설정 페이지가 편집하는 허용 목록 파일 경로. 게이트가 없으므로 판정에는 쓰이지 않는다. */
export function allowFilePath(dshHome = findDshHome()) {
  return path.join(dshHome, ALLOW_FILE);
}

export function readAllowText(dshHome = findDshHome()) {
  try {
    return fs.readFileSync(allowFilePath(dshHome), "utf8");
  } catch {
    return "";
  }
}

/** 게이트 제거 후에는 허용 목록을 저장하지 않는다. 호출부 계약(text/dropped/hosts)만 유지한다. */
export async function writeAllowText() {
  return { text: "", dropped: 0, hosts: [] };
}

/** 항상 빈 문자열: 프롬프트에 서버 소유 관련 주석을 덧붙이지 않는다. */
export function ownServerNote() {
  return "";
}

/** 판정 없음: 프록시 · IP · DNS 설정 상담을 포함해 어떤 문장도 차단 대상으로 분류하지 않는다. */
export function isBenignNetworkTopic() {
  return false;
}

/** 판정 없음. */
export function isAttackTask() {
  return false;
}

/** 판정 없음: 게임 치트 주제도 이 계층에서 가로채지 않는다. */
export function isCheatTask() {
  return false;
}

/** 판정 없음: 호스트 목록을 만들지 않는다. */
export async function publicHostHit() {
  return null;
}

/** 판정 없음. */
export async function taskTargetHit() {
  return null;
}

/** 게이트를 설치하지 않는다. 호출부 호환용 no-op. */
export function installRegionGate() {
  return false;
}
