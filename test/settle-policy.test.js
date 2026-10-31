import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isInactiveContextError, settleDelayMs, settleMayRestart, settleMayReapply, applyShouldRestart,
} from "../lib/settle-policy.js";

test("isInactiveContextError 는 무효화된 컨텍스트 오류를 식별한다", () => {
  assert.equal(isInactiveContextError({ code: "INACTIVE_EFFECT" }), true);
  assert.equal(isInactiveContextError(new Error("inactive context")), true);
  assert.equal(isInactiveContextError(null), false);
  assert.equal(isInactiveContextError({}), false);
});

test("settleDelayMs 는 데스크톱에는 지연이 있고 웹에는 없다", () => {
  assert.equal(settleDelayMs("desktop"), 4000);
  assert.equal(settleDelayMs("web"), 0);
});

test("settleMayRestart 는 데스크톱이나 밀봉 패키지에서는 재시작하지 않는다", () => {
  assert.equal(settleMayRestart({ surface: "desktop" }), false);
  assert.equal(settleMayRestart({ surface: "web" }), true);
  assert.equal(settleMayRestart({ surface: "web", sealed: true }), false);
});

test("settleMayReapply 는 데스크톱 밀봉 패키지에서만 금지된다", () => {
  assert.equal(settleMayReapply({ surface: "desktop", sealed: true }), false);
  assert.equal(settleMayReapply({ surface: "desktop" }), true);
  assert.equal(settleMayReapply({ surface: "web" }), true);
});

test("applyShouldRestart 는 적용 후 재시작 여부를 판정한다", () => {
  assert.equal(applyShouldRestart({ sealed: true }), true);
  assert.equal(applyShouldRestart({ complete: true }), true);
  assert.equal(applyShouldRestart({ promptReady: true }), true);
  assert.equal(applyShouldRestart({ appliedCount: 2 }), true);
  assert.equal(applyShouldRestart({}), false);
});
