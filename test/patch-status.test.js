import test from "node:test";
import assert from "node:assert/strict";
import {
  ALL_PATCHES,
  applyReplacementsToText,
  filePatchOutcome,
  isPatchResultSoftOk,
  isSelfMarkedPatch,
  parseHostVersion,
  patchStatusReady,
  rollupDisplayStatus,
  rollupPatchStatus,
  tallyDisplayPatches,
} from "../lib/core.js";

const base = {
  applied: 0,
  already: 0,
  missing: 0,
  notFound: 0,
  drifted: 0,
  lastError: null,
  keyCount: 1,
  layoutSoft: false,
  strictFiles: false,
};

/* ---------------------------------------------------------------------------
 * 판정 기준: 업스트림 드리프트는 반드시 드러나야 하고, skipped(소프트 성공)로
 * 떨어지면 안 된다. "공식 업그레이드 후 플러그인이 조용히 무효화되는데 상태
 * 페이지는 전부 초록"인 상황을 잡아내는 유일한 입구다.
 * ------------------------------------------------------------------------- */

test("rollupPatchStatus: 파일은 있는데 원문이 맞지 않으면 → skipped 가 아니라 drifted", () => {
  assert.equal(rollupPatchStatus({ ...base, drifted: 1 }), "drifted");
});

test("rollupPatchStatus: pattern 이 아직 있으면 → pattern_not_found(적용 가능)", () => {
  assert.equal(rollupPatchStatus({ ...base, notFound: 1 }), "pattern_not_found");
});

test("rollupPatchStatus: 어떤 파일이 실제로 기록에 성공했다면 여전히 applied, 절반만 적용된 거짓 경고를 만들지 않는다", () => {
  assert.equal(rollupPatchStatus({ ...base, applied: 1, drifted: 1 }), "applied");
});

test("rollupPatchStatus: 이미 디스크에 기록된 패치는 여전히 already, 일부 파일 드리프트로 빨개지지 않는다", () => {
  // 다중 파일 패치에서 일부 파일은 원래 이 코드 조각을 포함하지 않는다(다른 빌드 산출물).
  // 이런 "가짜 드리프트"가 이미 적용된 부분을 덮어서는 안 된다.
  assert.equal(rollupPatchStatus({ ...base, already: 1, drifted: 1 }), "already");
});

test("rollupPatchStatus: 쓰기 오류가 applied 보다 우선한다, EACCES 를 초록으로 삼키면 안 된다", () => {
  assert.equal(
    rollupPatchStatus({ ...base, applied: 1, lastError: "write_error:EACCES" }),
    "write_error:EACCES",
  );
});

test("rollupPatchStatus: 파일이 전부 없으면 → missing_file", () => {
  assert.equal(rollupPatchStatus({ ...base, missing: 1 }), "missing_file");
});

test("filePatchOutcome: 파일은 있는데 marker 도 없고 pattern 도 하나도 안 맞으면 → drifted", () => {
  const patch = { id: 9801, replacements: [{ pattern: "NEEDLE_NOT_THERE", replace: "x" }] };
  assert.equal(filePatchOutcome("host text", patch, ""), "drifted");
});

test("filePatchOutcome: marker 가 있으면 → applied(드리프트로 보지 않는다)", () => {
  const patch = {
    id: 9802,
    markers: ["[dsh-purge] marker"],
    replacements: [{ pattern: "NEEDLE_NOT_THERE", replace: "x" }],
  };
  assert.equal(filePatchOutcome("host [dsh-purge] marker text", patch, ""), "applied");
});

test("filePatchOutcome: pattern 이 아직 있으면 → pending", () => {
  const patch = { id: 9803, replacements: [{ pattern: "NEEDLE", replace: "x" }] };
  assert.equal(filePatchOutcome("a NEEDLE b", patch, ""), "pending");
});

test("자기 표시형 패치: pattern 이 곧 이 플러그인이 남긴 흔적이므로 못 찾으면 애초에 추가된 적이 없다는 뜻이고 드리프트가 아니다", () => {
  const patch = {
    id: 9804,
    replacements: [{ pattern: "- id: tool-fs # [dsh-purge] minimal fs tool parity", replace: "x" }],
  };
  assert.equal(isSelfMarkedPatch(patch), true);
  assert.equal(filePatchOutcome("host text", patch, ""), "skipped");
});

test("자기 표시형 판정: 일반 패치는 자기 표시형이 아니고, #80 은 자기 표시형이다", () => {
  assert.equal(isSelfMarkedPatch({ id: 9805, replacements: [{ pattern: "const a = 1;", replace: "x" }] }), false);
  const p80 = ALL_PATCHES.find((p) => p.id === 80);
  assert.ok(p80, "#80 을 찾을 수 없다");
  assert.equal(isSelfMarkedPatch(p80), true);
});

/* ---------------------------------------------------------------------------
 * 준비 상태 기준: drifted 는 반드시 "준비됨"을 빨갛게 만들어야 한다(선택적 패치는
 * apply 를 막지 않지만 상태는 여전히 남는다).
 * ------------------------------------------------------------------------- */

test("patchStatusReady: drifted 인 비선택 패치는 준비된 것으로 보지 않는다", () => {
  assert.equal(patchStatusReady("drifted", { optional: false }), false);
});

test("patchStatusReady: drifted 인 선택적 패치는 준비 상태를 막지 않는다", () => {
  assert.equal(patchStatusReady("drifted", { optional: true }), true);
});

test("patchStatusReady: applied / already 는 준비된 것으로 본다", () => {
  assert.equal(patchStatusReady("applied"), true);
  assert.equal(patchStatusReady("already"), true);
});

test("patchStatusReady: pending 은 준비된 것으로 보지 않는다", () => {
  assert.equal(patchStatusReady("pending"), false);
});

test("patchStatusReady: skipped 는 더 이상 자동으로 준비 상태가 아니고, 선택적 패치는 여전히 준비 상태다", () => {
  assert.equal(patchStatusReady("skipped", { optional: false }), false);
  assert.equal(patchStatusReady("skipped", { optional: true }), true);
});

/* ---------------------------------------------------------------------------
 * 표시 계층 집계: drifted 는 ready 에 포함되면 안 된다.
 * ------------------------------------------------------------------------- */

test("tallyDisplayPatches: drifted 는 ready 에 집계되지 않는다", () => {
  const out = tallyDisplayPatches([
    { status: "applied" },
    { status: "drifted" },
    { status: "skipped" },
  ]);
  assert.equal(out.applied, 1);
  assert.equal(out.drifted, 1);
  assert.equal(out.ready, 2, "applied + skipped 만 ready 에 집계된다");
});

test("rollupDisplayStatus: 한 그룹에 드리프트가 하나라도 있으면 그 그룹은 깨끗한 초록이 아니다", () => {
  assert.equal(rollupDisplayStatus(["applied", "drifted"]), "drifted");
  assert.equal(rollupDisplayStatus(["applied", "applied"]), "applied");
  assert.equal(rollupDisplayStatus(["pending", "drifted"]), "pending");
});

/* ---------------------------------------------------------------------------
 * 소프트 성공 기준: skipped 는 더 이상 자동으로 소프트 성공이 아니고,
 * drifted 는 보이되 Apply 를 막지 않는다.
 * ------------------------------------------------------------------------- */

test("isPatchResultSoftOk: skipped 는 선택적이거나 자기 표시형일 때만 소프트 성공으로 본다", () => {
  assert.equal(isPatchResultSoftOk({ status: "skipped" }, { id: 1, optional: false }), false);
  assert.equal(isPatchResultSoftOk({ status: "skipped" }, { id: 2, optional: true }), true);
});

test("isPatchResultSoftOk: drifted 는 Apply 를 막지 않는다(0.1.6 / 0.2.0 / 0.2.1-rc.2 와 호환)", () => {
  assert.equal(isPatchResultSoftOk({ status: "drifted" }, { id: 3, optional: false }), true);
});

/* ---------------------------------------------------------------------------
 * 멱등성: 두 번째 적용이 계속 늘어나면 안 된다(과거 사고는 apply 마다 +841 자가
 * 붙어 영원히 수렴하지 않았다).
 * ------------------------------------------------------------------------- */

test("applyReplacementsToText: 모든 리터럴 pattern 은 두 번째 적용에서 겹쳐 쌓이지 않는다", () => {
  const offenders = [];
  for (const p of ALL_PATCHES) {
    const reps = (p.replacements || []).filter((r) => r.pattern && !(r.pattern instanceof RegExp));
    if (reps.length === 0) continue;
    // pattern 본문으로 입력을 합성한다: 첫 번째 적용이 반드시 맞아야 수렴성을 실제로 검증할 수 있다.
    const src = reps.map((r) => String(r.pattern)).join("\n");
    const once = applyReplacementsToText(src, p, "");
    const twice = applyReplacementsToText(once.text, p, "");
    if (twice.text !== once.text) offenders.push(`#${p.id} ${p.name}`);
  }
  assert.deepEqual(offenders, [], `이 패치들은 두 번째 적용에서도 계속 변한다: ${offenders.join(", ")}`);
});

test("applyReplacementsToText: 남은 pattern 이 없으면 changed=false", () => {
  const patch = { id: 9901, replacements: [{ pattern: "NOT_PRESENT_ANYWHERE", replace: "x" }] };
  const r = applyReplacementsToText("hello world", patch, "");
  assert.equal(r.changed, false);
  assert.equal(r.text, "hello world");
});

test("#77 앵커 관용도: 공식이 중간에 한 줄을 끼워 넣어도 그대로 맞고, 두 번째 적용에서 겹쳐 쌓이지 않는다", () => {
  const p77 = ALL_PATCHES.find((p) => p.id === 77);
  assert.ok(p77, "#77 을 찾을 수 없다");
  // 0.2.1-rc.2 부터의 공식 원문: 중간에 revised.clear() 한 줄이 늘었다.
  const host =
    "\t\t\tappend(record) {\n" +
    "\t\t\t\tconst event = record.event;\n" +
    "\t\t\t\tif (this.inputs.has(event.seq)) return \"none\";\n" +
    "\t\t\t\tif (this.revised.size > 0) this.revised.clear();\n" +
    "\t\t\t\tthis.inputs.set(event.seq, record);\n";
  const once = applyReplacementsToText(host, p77, "");
  assert.equal(once.changed, true, "rc.2 의 원문은 맞아야 한다");
  assert.ok(once.text.includes("isRewindMarker(event)"), "되돌림 판정이 주입되어야 한다");
  assert.ok(once.text.includes("if (this.revised.size > 0) this.revised.clear();"), "공식의 그 줄은 그대로 보존되어야 한다");
  const twice = applyReplacementsToText(once.text, p77, "");
  assert.equal(twice.text, once.text, "두 번째 적용에서 다시 삽입되면 안 된다");
});

/* ---------------------------------------------------------------------------
 * 매치 수 계약: 공식에 같은 이름의 코드가 한 군데 더 있으면 둘 다 고치는 게 아니라
 * 쓰기를 거부해야 한다.
 * ------------------------------------------------------------------------- */

test("applyReplacementsToText: expect 매치 수가 맞지 않으면 쓰기를 거부하고 실제 매치 수를 돌려준다", () => {
  const patch = { id: 9902, replacements: [{ pattern: "NEEDLE", replace: "X", expect: 1 }] };
  const r = applyReplacementsToText("NEEDLE NEEDLE", patch, "");
  assert.ok(r.hitMismatch, "hitMismatch 를 돌려줘야 한다");
  assert.equal(r.hitMismatch.expected, 1);
  assert.equal(r.hitMismatch.actual, 2);
  assert.equal(r.text, "NEEDLE NEEDLE", "쓰기를 거부할 때는 원문을 그대로 반환해야 한다");
  assert.equal(r.changed, false);
});

test("applyReplacementsToText: expect 매치 수가 일치하면 정상 치환한다", () => {
  const patch = { id: 9903, replacements: [{ pattern: "NEEDLE", replace: "X", expect: 1 }] };
  const r = applyReplacementsToText("a NEEDLE b", patch, "");
  assert.equal(r.hitMismatch, undefined);
  assert.equal(r.text, "a X b");
});

test("applyReplacementsToText: expect=1 인데 한 곳도 안 맞아도 불일치다(조용히 건너뛰면 안 된다)", () => {
  const patch = { id: 9905, replacements: [{ pattern: "NEEDLE", replace: "X", expect: 1 }] };
  const r = applyReplacementsToText("nothing here", patch, "");
  assert.ok(r.hitMismatch, "0 회 매치도 불일치다");
  assert.equal(r.hitMismatch.actual, 0);
  assert.equal(r.changed, false);
});

test("applyReplacementsToText: expect 를 선언하지 않으면 기존 동작을 유지한다(전량 치환)", () => {
  const patch = { id: 9904, replacements: [{ pattern: "N", replace: "X" }] };
  const r = applyReplacementsToText("N N", patch, "");
  assert.equal(r.hitMismatch, undefined);
  assert.equal(r.text, "X X");
});

test("applyReplacementsToText: 정규식 pattern 의 expect 도 동일하게 적용된다(공식이 두 벌로 복제되면 쓰기 거부)", () => {
  const patch = { id: 9906, replacements: [{ pattern: /NEEDLE/g, replace: "X", expect: 1 }] };
  const r = applyReplacementsToText("NEEDLE NEEDLE", patch, "");
  assert.ok(r.hitMismatch, "정규식도 매치 수 계약을 지켜야 한다");
  assert.equal(r.hitMismatch.actual, 2);
  assert.equal(r.text, "NEEDLE NEEDLE", "쓰기를 거부할 때는 원문을 그대로 반환해야 한다");
});

/* ---------------------------------------------------------------------------
 * 호스트 버전 게이트
 * ------------------------------------------------------------------------- */

test("parseHostVersion: 주/부/수정 버전과 프리릴리스 구간을 분리한다", () => {
  assert.deepEqual(parseHostVersion("0.2.1-rc.3"), {
    major: 0, minor: 2, patch: 1, pre: ["rc", "3"],
  });
  assert.equal(parseHostVersion("not-a-version"), null);
  assert.deepEqual(parseHostVersion("v1.2.3"), { major: 1, minor: 2, patch: 3, pre: [] });
});
