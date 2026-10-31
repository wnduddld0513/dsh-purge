import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  parseAllowBuildLine,
  formatAllowBuildLine,
  validateAllowBuildRewrite,
  purgePnpmBuildSpecs,
  rewritePnpmAllowBuilds,
  ensurePnpmAllowBuild,
  ensureProfileBodyInsert,
  classifyPatchBody,
  INSERT_BLOCK,
} from "../lib/profile-insert.js";

const MASTER_URL = "https://codeload.github.com/YuJunZhiXue/dsh-purge/tar.gz/refs/heads/master";
const COMMIT_URL = "https://codeload.github.com/YuJunZhiXue/dsh-purge/tar.gz/abc1234567890";

function withTempProfile(lockText) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-purge-test-"));
  if (lockText !== undefined) {
    fs.writeFileSync(path.join(dir, "pnpm-lock.yaml"), lockText, "utf8");
  }
  return dir;
}

function withTempPatch(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-purge-patch-"));
  if (content !== undefined) {
    fs.writeFileSync(path.join(dir, "cordis.patch.yml"), content, "utf8");
  }
  return dir;
}

/** 주석과 빈 줄을 제거한 뒤 최상위 `- insert:` 그룹 수를 센다(두 번째 문서가 되었는지 판정). */
function topLevelInsertGroups(text) {
  const lines = String(text || "").split(/\r?\n/);
  let count = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    if (/^-\s*insert:\s*$/.test(line)) count += 1;
  }
  return count;
}

test("URL 키 파싱이 콜론에서 잘리지 않는다", () => {
  const parsed = parseAllowBuildLine(`  dsh-purge@${MASTER_URL}: true`);
  assert.equal(parsed.key, `dsh-purge@${MASTER_URL}`);
  assert.equal(parsed.value, "true");
});

test("기형 키도 통째로 파싱한다(자가 치유 시 일괄 폐기)", () => {
  assert.deepEqual(parseAllowBuildLine("  dsh-purge@https: true"), {
    key: "dsh-purge@https",
    value: "true",
  });
  assert.deepEqual(parseAllowBuildLine("  dsh-purge@1.1.81: true"), {
    key: "dsh-purge@1.1.81",
    value: "true",
  });
});

test("행 끝에 값이 없는 `key:` 는 빈 값으로 파싱된다", () => {
  assert.deepEqual(parseAllowBuildLine("  dsh-purge@https:"), {
    key: "dsh-purge@https",
    value: "",
  });
  assert.deepEqual(parseAllowBuildLine("  dsh-purge:"), {
    key: "dsh-purge",
    value: "",
  });
});

test("따옴표로 감싼 키도 예전처럼 파싱한다", () => {
  const spec = `dsh-purge@${MASTER_URL}`;
  for (const line of [`  "${spec}": true`, `  '${spec}': true`]) {
    assert.deepEqual(parseAllowBuildLine(line), { key: spec, value: "true" });
  }
});

test("URL 키는 따옴표와 함께 기록되고 round-trip 이 무손실이다", () => {
  const spec = `dsh-purge@${MASTER_URL}`;
  const line = formatAllowBuildLine(spec);
  assert.equal(line, `  "${spec}": true`);
  assert.deepEqual(parseAllowBuildLine(line), { key: spec, value: "true" });
  // URL 이 들어 있지 않은 키는 따옴표 없이 유지되고 round-trip 도 무손실이다
  const plain = formatAllowBuildLine("dsh-purge");
  assert.equal(plain, "  dsh-purge: true");
  assert.deepEqual(parseAllowBuildLine(plain), { key: "dsh-purge", value: "true" });
});

test("오염된 allowBuilds 를 재작성하면 기대 키만 남는다", () => {
  const polluted = [
    "packages:",
    "  - '.'",
    "",
    "allowBuilds:",
    "  cpu-features: true",
    "  ssh2: true",
    "  dsh-purge: true",
    "  dsh-purge@1.1.81: true",
    "  dsh-purge@https: true",
    "  dsh-purge@https: true",
    `  dsh-purge@${MASTER_URL}: true`,
    "",
  ].join("\n");
  const next = rewritePnpmAllowBuilds(polluted);
  const keys = next.split("\n").filter((line) => parseAllowBuildLine(line)).map((line) => parseAllowBuildLine(line).key);
  // 기대 키: 맨 패키지 이름만(#185, 더 이상 URL 키를 쓰지 않는다)
  const wanted = ["cpu-features", "ssh2", ...purgePnpmBuildSpecs()];
  assert.deepEqual([...new Set(keys)], wanted);
  // 기형 레거시 키는 하나도 남지 않는다
  for (const bad of [`dsh-purge@1.1.81`, `dsh-purge@https`]) {
    assert.equal(keys.includes(bad), false, `should drop ${bad}`);
  }
  // 중복 등장했던 `dsh-purge@https` 는 wanted 의 정확한 키에서만 나올 수 있고, 중복되지 않는다
  assert.equal(keys.filter((key) => key.startsWith("dsh-purge")).length, purgePnpmBuildSpecs().length);
  // 보존 구간의 구조도 여전히 유효하다
  assert.equal(validateAllowBuildRewrite(next), true);
});

test("purge 가 아닌 키는 그대로 보존되고, allowBuilds 구간이 없으면 추가된다", () => {
  const base = "packages:\n  - '.'\n";
  const next = rewritePnpmAllowBuilds(base);
  assert.equal(next.startsWith("packages:\n  - '.'\n\nallowBuilds:\n"), true);
  // 추가되는 것은 기대 키(맨 패키지 이름 + package.json 의 tarball)
  for (const spec of purgePnpmBuildSpecs()) {
    const escaped = formatAllowBuildLine(spec).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    assert.match(next, new RegExp(`^${escaped}$`, "m"));
  }
  const withSection = "allowBuilds:\n  cpu-features: true\n  ssh2: true\n";
  const next2 = rewritePnpmAllowBuilds(withSection);
  assert.match(next2, /^ {2}cpu-features: true$/m);
  assert.match(next2, /^ {2}ssh2: true$/m);
});

test("쓰기 전 검증: 최상위 키 중복 / allowBuilds 키 중복 / 파싱할 수 없는 행은 무효로 판정한다", () => {
  assert.equal(validateAllowBuildRewrite("packages:\n  - '.'\n\npackages:\n  - \"..\"\n"), false);
  assert.equal(validateAllowBuildRewrite("allowBuilds:\n  cpu-features: true\n  cpu-features: true\n"), false);
  // 키-값 구분자가 없는 맨 행은 파싱되지 않으므로 검증이 반드시 막아야 한다
  assert.equal(validateAllowBuildRewrite("allowBuilds:\n  \u4e0d\u662f\u952e\u503c\u5bf9\n"), false);
  assert.equal(validateAllowBuildRewrite("allowBuilds:\n# \u6ce8\u91ca\u884c\u653e\u884c\n  ssh2: true\n"), true);
});

test("기대 키는 맨 패키지 이름뿐이고 URL 키를 포함하지 않는다(#185)", () => {
  // pnpm 11 은 `dsh-purge@https://...` 를 만나면 ERR_PNPM_INVALID_VERSION_UNION 을 낸다.
  // allowBuilds 는 패키지 이름으로 매칭하면 충분하므로 tarball / git / registry 설치 모두 허용된다
  assert.deepEqual(purgePnpmBuildSpecs(), ["dsh-purge"]);
  const dir = withTempProfile([
    "lockfileVersion: '9.0'",
    "",
    "importers:",
    "",
    "  .:",
    "    dependencies:",
    "      dsh-purge:",
    `        specifier: ${COMMIT_URL}`,
    `        version: dsh-purge@${COMMIT_URL}`,
    "",
  ].join("\n"));
  assert.deepEqual(purgePnpmBuildSpecs(dir), ["dsh-purge"]);
});

test("입력에 URL 키만 있으면 재작성 후 맨 패키지 이름만 남는다", () => {
  const onlyUrl = [
    "allowBuilds:",
    `  "dsh-purge@${MASTER_URL}": true`,
    `  dsh-purge@${MASTER_URL}: true`,
    "",
  ].join("\n");
  const next = rewritePnpmAllowBuilds(onlyUrl);
  const keys = next.split("\n").filter((line) => parseAllowBuildLine(line)).map((line) => parseAllowBuildLine(line).key);
  assert.deepEqual(keys, ["dsh-purge"]);
  assert.equal(next.includes("dsh-purge@"), false);
  assert.equal(next.split("\n").some((line) => line === "  dsh-purge: true"), true);
  assert.equal(validateAllowBuildRewrite(next), true);
});

test("고정 commit 설치: 재작성 후 맨 패키지 이름만 남고, 레거시 URL / 기형 키는 전부 정리된다", () => {
  const dir = withTempProfile([
    "lockfileVersion: '9.0'",
    "",
    "importers:",
    "",
    "  .:",
    "    dependencies:",
    "      dsh-purge:",
    `        specifier: ${COMMIT_URL}`,
    `        version: dsh-purge@${COMMIT_URL}`,
    "",
  ].join("\n"));
  const polluted = [
    "packages:",
    "  - '.'",
    "",
    "allowBuilds:",
    "  ssh2: true",
    `  dsh-purge@${MASTER_URL}: true`,
    `  "dsh-purge@${COMMIT_URL}": true`,
    "  dsh-purge@https: true",
    "",
  ].join("\n");
  const next = rewritePnpmAllowBuilds(polluted, dir);
  const keys = next.split("\n").filter((line) => parseAllowBuildLine(line)).map((line) => parseAllowBuildLine(line).key);
  assert.equal(keys.includes("dsh-purge"), true);
  assert.equal(keys.includes(`dsh-purge@${COMMIT_URL}`), false);
  assert.equal(keys.includes(`dsh-purge@${MASTER_URL}`), false);
  assert.equal(keys.includes("dsh-purge@https"), false);
  assert.equal(keys.includes("ssh2"), true);
  // 맨 패키지 이름만 쓰고 따옴표는 붙이지 않는다
  assert.equal(next.split("\n").some((line) => line === "  dsh-purge: true"), true);
});

test("멱등성: 건강한 파일은 재작성 출력이 입력과 같고, 쓰기가 일어나지 않는다", () => {
  const dir = withTempProfile();
  const fp = path.join(dir, "pnpm-workspace.yaml");
  const healthy = [
    "packages:",
    "  - '.'",
    "",
    "allowBuilds:",
    "  cpu-features: true",
    "  ssh2: true",
    "  dsh-purge: true",
    "",
  ].join("\n");
  fs.writeFileSync(fp, healthy, "utf8");
  const before = fs.readFileSync(fp, "utf8");
  assert.equal(rewritePnpmAllowBuilds(before, dir), before);
  const statBefore = fs.statSync(fp);
  const result = ensurePnpmAllowBuild(dir);
  assert.equal(result.wrote, false);
  assert.equal(result.ok, true);
  assert.equal(fs.readFileSync(fp, "utf8"), before);
  assert.equal(fs.statSync(fp).mtimeMs, statBefore.mtimeMs);
});

test("멱등성: 두 번째 ensure 는 디스크에 더 쓰지 않는다(자가 치유 후 수렴)", () => {
  const dir = withTempProfile();
  const fp = path.join(dir, "pnpm-workspace.yaml");
  const polluted = `allowBuilds:\n  ssh2: true\n  dsh-purge@https: true\n  dsh-purge@1.1.81: true\n`;
  fs.writeFileSync(fp, polluted, "utf8");
  const first = ensurePnpmAllowBuild(dir);
  assert.equal(first.wrote, true);
  const healed = fs.readFileSync(fp, "utf8");
  // 기형 레거시 키가 제거되었다
  assert.equal(healed.includes("dsh-purge@https"), false);
  assert.equal(healed.includes("dsh-purge@1.1.81"), false);
  // 맨 패키지 이름만 남는다
  assert.equal(healed.includes("  dsh-purge: true"), true);
  const second = ensurePnpmAllowBuild(dir);
  assert.equal(second.wrote, false);
  assert.equal(fs.readFileSync(fp, "utf8"), healed);
});

// ---- #191: cordis.patch.yml 이 `[]` 일 때 추가하면 호스트 기동 파싱이 실패한다 ----

test("patch 형태 분류: 빈 파일 / 빈 flow / 블록 시퀀스 / 비어 있지 않은 flow / 알 수 없음", () => {
  assert.equal(classifyPatchBody("").kind, "empty");
  assert.equal(classifyPatchBody("# \u53ea\u6709\u6ce8\u91ca\n\n").kind, "empty");
  assert.equal(classifyPatchBody("[]").kind, "empty-flow");
  assert.equal(classifyPatchBody("# c\n[]\n").kind, "empty-flow");
  assert.equal(classifyPatchBody("---\n[]\n").kind, "empty-flow");
  assert.equal(classifyPatchBody("- id: foo\n  name: foo\n").kind, "block-seq");
  assert.equal(classifyPatchBody("[a, b]\n").kind, "flow-seq");
  assert.equal(classifyPatchBody("foo: bar\n").kind, "unknown");
});

test("빈 파일: insert 블록을 그대로 쓴다", () => {
  const dir = withTempPatch(undefined);
  const fp = path.join(dir, "cordis.patch.yml");
  const result = ensureProfileBodyInsert(dir);
  assert.equal(result.ok, true);
  assert.equal(result.wrote, true);
  assert.equal(fs.readFileSync(fp, "utf8"), INSERT_BLOCK);
});

test("주석과 빈 줄만 있는 경우: insert 블록을 쓰고 주석은 보존한다", () => {
  const dir = withTempPatch("# overrides, disables, and insertions\n\n");
  const fp = path.join(dir, "cordis.patch.yml");
  const result = ensureProfileBodyInsert(dir);
  assert.equal(result.ok, true);
  assert.equal(result.wrote, true);
  const text = fs.readFileSync(fp, "utf8");
  assert.equal(text.includes("# overrides, disables, and insertions"), true);
  assert.equal(text.includes("- insert:"), true);
  assert.equal(topLevelInsertGroups(text), 1);
});

test("주석 + `[]`: `[]` 가 insert 블록으로 치환되고 주석은 보존되며 두 번째 문서가 되지 않는다", () => {
  const dir = withTempPatch("# overrides, disables, and insertions\n[]\n");
  const fp = path.join(dir, "cordis.patch.yml");
  const result = ensureProfileBodyInsert(dir);
  assert.equal(result.ok, true);
  assert.equal(result.wrote, true);
  const text = fs.readFileSync(fp, "utf8");
  assert.equal(text.includes("[]"), false);
  assert.equal(text.includes("# overrides, disables, and insertions"), true);
  assert.equal(text.includes("- insert:"), true);
  // 최상위 `- insert:` 그룹이 하나뿐 → 두 번째 문서가 되지 않았다
  assert.equal(topLevelInsertGroups(text), 1);
});

test("`---` 접두사 + `[]`: 마찬가지로 치환되고 두 번째 문서가 되지 않는다", () => {
  const dir = withTempPatch("---\n[]\n");
  const fp = path.join(dir, "cordis.patch.yml");
  const result = ensureProfileBodyInsert(dir);
  assert.equal(result.ok, true);
  assert.equal(result.wrote, true);
  const text = fs.readFileSync(fp, "utf8");
  assert.equal(text.includes("[]"), false);
  assert.equal(topLevelInsertGroups(text), 1);
});

test("정상 블록 시퀀스: 기존 추가 동작을 그대로 따른다", () => {
  const original = "- id: foo\n  name: foo\n";
  const dir = withTempPatch(original);
  const fp = path.join(dir, "cordis.patch.yml");
  const result = ensureProfileBodyInsert(dir);
  assert.equal(result.ok, true);
  assert.equal(result.wrote, true);
  const text = fs.readFileSync(fp, "utf8");
  assert.equal(text.startsWith(original), true);
  assert.equal(text.includes("- insert:"), true);
  assert.equal(topLevelInsertGroups(text), 1);
});

test("비어 있지 않은 flow 시퀀스: 호스트 내용은 건드리지 않고 ok:false 를 돌려준다", () => {
  const original = "[a, b]\n";
  const dir = withTempPatch(original);
  const fp = path.join(dir, "cordis.patch.yml");
  const result = ensureProfileBodyInsert(dir);
  assert.equal(result.ok, false);
  assert.equal(result.wrote, false);
  assert.equal(fs.readFileSync(fp, "utf8"), original);
});

test("이미 dsh-purge 본체 행이 있는 경우: 쓰기가 일어나지 않는다", () => {
  const original = "- insert:\n    - id: dsh-purge\n      name: dsh-purge\n";
  const dir = withTempPatch(original);
  const fp = path.join(dir, "cordis.patch.yml");
  const result = ensureProfileBodyInsert(dir);
  assert.equal(result.ok, true);
  assert.equal(result.wrote, false);
  assert.equal(fs.readFileSync(fp, "utf8"), original);
});

test("`[]` 치환 후 멱등성: ensure 를 한 번 더 실행해도 쓰기가 없다", () => {
  const dir = withTempPatch("# c\n[]\n");
  const fp = path.join(dir, "cordis.patch.yml");
  const first = ensureProfileBodyInsert(dir);
  assert.equal(first.wrote, true);
  const healed = fs.readFileSync(fp, "utf8");
  const second = ensureProfileBodyInsert(dir);
  assert.equal(second.wrote, false);
  assert.equal(fs.readFileSync(fp, "utf8"), healed);
});
