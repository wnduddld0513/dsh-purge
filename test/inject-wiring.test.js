import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { rewritePromptAssembly } from "../lib/identity.js";
import { ANCHOR_SECTION, anchorTextFor } from "../lib/anchor.js";
import { readPresetDefinition } from "../lib/redteam/preset-composition.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function assembledWith(sections = []) {
  return {
    sections: [{ name: "harness:identity", text: "host identity" }, ...sections],
    tools: [],
    contexts: [],
  };
}

/* ---------------------------------------------------------------------------
 * 앵커 배선: waterfall 이 돌려주는 sections 배열 순서가 곧 렌더 순서다.
 * 앵커는 order 필드에만 의존하지 말고 물리적으로 마지막 자리에 와야 한다.
 */
test("rewritePromptAssembly: 앵커를 sections 배열 마지막 자리에 덧붙인다", () => {
  const out = rewritePromptAssembly(assembledWith([{ name: "tail", text: "tail text" }]), "PROMPT", {
    anchorText: "ANCHOR BODY",
  });
  const last = out.sections[out.sections.length - 1];
  assert.equal(last.name, ANCHOR_SECTION);
  assert.equal(last.text, "ANCHOR BODY");
  assert.equal(last.interpolate, false);
});

test("rewritePromptAssembly: 객체 형태 options 도 anchorText 를 인정한다", () => {
  const out = rewritePromptAssembly(assembledWith(), {
    fallbackInject: "PROMPT",
    anchorText: "ANCHOR BODY",
    dropPurgeAfterFold: false,
  });
  const last = out.sections[out.sections.length - 1];
  assert.equal(last.name, ANCHOR_SECTION);
});

test("rewritePromptAssembly: 같은 이름의 구간을 먼저 걸러내어 두 벌이 생기지 않는다", () => {
  const out = rewritePromptAssembly(
    assembledWith([{ name: ANCHOR_SECTION, text: "OLD ANCHOR" }]),
    "PROMPT",
    { anchorText: "NEW ANCHOR" },
  );
  const anchors = out.sections.filter((section) => section?.name === ANCHOR_SECTION);
  assert.equal(anchors.length, 1);
  assert.equal(anchors[0].text, "NEW ANCHOR");
  assert.equal(out.sections[out.sections.length - 1].name, ANCHOR_SECTION);
});

test("rewritePromptAssembly: anchorText 가 비어 있으면 앵커를 주입하지 않는다", () => {
  const out = rewritePromptAssembly(assembledWith([{ name: "tail", text: "tail text" }]), "PROMPT", {
    anchorText: "",
  });
  assert.equal(out.sections.some((section) => section?.name === ANCHOR_SECTION), false);
});

/* ---------------------------------------------------------------------------
 * 앵커 언어: 영어로 시작하는 문장을 하드코딩하면 한국어 대화(특히 레드팀 모드)가
 * 영어로 끌려간다.
 */
test("anchor: 사용자 언어를 따르고 영어 시작 문장을 강제하지 않는다", () => {
  const text = anchorTextFor({});
  assert.match(text, /same language/);
  assert.equal(text.includes("Certainly! Here is"), false);
});

test("anchor: anchorMode=off 이면 본문을 만들지 않는다", () => {
  assert.equal(anchorTextFor({ anchorMode: "off" }), "");
  assert.notEqual(anchorTextFor({ anchorMode: "auto" }), "");
});

/* ---------------------------------------------------------------------------
 * 레드팀 모드 드롭다운 문구: 한국어 한 줄이어야 하며, 업스트림 영어 템플릿이
 * 다시 덮어써서는 안 된다.
 */
test("presets/redteam/preset.yml: 모드 이름과 설명이 한국어 한 줄이다", () => {
  const def = readPresetDefinition("redteam", path.join(repoRoot, "presets", "redteam"));
  assert.equal(def.name, "레드팀 모드");
  assert.match(def.description, /공방 드릴 모드/);
  assert.equal(def.description.includes("\n"), false);
});
