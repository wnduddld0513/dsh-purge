import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseTargetPort, tunnelIsLegit, parseRowCount, applyScoreCaps, scoreServiceKey,
} from "../lib/redteam/score-rules.js";

test("parseTargetPort 는 포트를 파싱한다", () => {
  assert.equal(parseTargetPort("http://h:8080/x"), 8080);
  assert.equal(parseTargetPort("10.0.0.5:6379"), 6379);
  assert.equal(parseTargetPort("http://h/x"), null);
  assert.equal(parseTargetPort("10.0.0.5:99999"), null);
  assert.equal(parseTargetPort(""), null);
});

test("tunnelIsLegit 는 터널이 표적 경계를 넘는지 판정한다", () => {
  assert.equal(tunnelIsLegit("self-only"), false);
  assert.equal(tunnelIsLegit("target-outbound"), true);
  assert.equal(tunnelIsLegit(""), null);
  assert.equal(tunnelIsLegit(null), null);
});

test("parseRowCount 는 증거에서 데이터 규모를 파싱한다", () => {
  // 소스(lib/redteam/score-rules.js)는 중국어 규모 단위와 한국어 단위를 모두 인정한다.
  // 계약 보존을 위해 중국어 픽스처는 이스케이프 표기로 남긴다.
  assert.equal(parseRowCount("120 \u4e07\u6761"), 1200000);
  assert.equal(parseRowCount("1300\u4e07\u884c"), 13000000);
  assert.equal(parseRowCount("2.5\u4e07\u884c"), 25000);
  assert.equal(parseRowCount("1200000 records"), 1200000);
  assert.equal(parseRowCount(""), null);
  // 규모 단위가 없는 맨 숫자는 데이터 규모로 오인하지 않는다.
  assert.equal(parseRowCount("\u5bc6\u7801\u662f 123456"), null);
});

test("scoreServiceKey 는 같은 서비스를 하나의 키로 묶는다", () => {
  assert.equal(scoreServiceKey({ target: "http://h:8080" }), "th:8080");
  assert.equal(scoreServiceKey({ target: "10.0.0.5:6379" }), "t10.0.0.5:6379");
  assert.equal(scoreServiceKey({}), null);
});

test("applyScoreCaps 는 같은 서비스에서 최고 권한 점수만 계산한다", () => {
  const pointsByCode = new Map([
    ["web-account-admin", { rule: 1, cap: 20, dedup_scope: "service", points: 20 }],
    ["web-account-user", { rule: 1, cap: 20, dedup_scope: "service", points: 10 }],
  ]);
  const rows = [
    { id: 1, code: "web-account-user", points: 10, target: "http://h:8080" },
    { id: 2, code: "web-account-admin", points: 20, target: "http://h:8080" },
  ];
  const r = applyScoreCaps(rows, pointsByCode);
  assert.equal(r.capped, 1);
  const byId = Object.fromEntries(r.items.map((x) => [x.id, x]));
  assert.equal(byId[1].capped, true);
  assert.equal(byId[1].capped_reason_kind, "dedup");
  assert.equal(byId[1].capped_by_id, 2);
  assert.equal(byId[2].capped, false);
});

test("applyScoreCaps 는 규칙 상한 누적에서 상한에 도달하면 막는다", () => {
  const pointsByCode = new Map([
    ["web-account-admin", { rule: 1, cap: 20, dedup_scope: "service", points: 20 }],
  ]);
  const rows = [
    { id: 1, code: "web-account-admin", points: 20, target: "http://h1:80" },
    { id: 2, code: "web-account-admin", points: 20, target: "http://h2:80" },
  ];
  const r = applyScoreCaps(rows, pointsByCode);
  assert.equal(r.capped, 1);
  const byId = Object.fromEntries(r.items.map((x) => [x.id, x]));
  assert.equal(byId[1].capped, false);
  assert.equal(byId[2].capped, true);
  assert.equal(byId[2].capped_reason_kind, "cap");
});
