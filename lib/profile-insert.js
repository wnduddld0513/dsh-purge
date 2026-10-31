/**
 * 사용자 레이어 profile/cordis.patch.yml 의 본체 insert (#154 / #159 / #191).
 *
 * 패키지 내부 overlay 는 이미 큐에 들어간 행의 inject/config 만 고치고, insert 를 또 하지 않는다
 * (Hub 에 이미 큐에 들어가면 already queued). postinstall 과 드릴 하위 행 모두 이 경로를 지난다:
 * 행이 없으면 한 줄 쓴다.
 *
 * #191: 파일 자체가 하나의 완전한 문서일 때(호스트가 생성한 빈 flow 시퀀스 `[]`), 더 덧붙이면
 * 두 번째 문서가 되어 호스트 기동 시 파싱이 실패한다.
 */
import fs from "node:fs";
import path from "node:path";

export const PURGE_NAME = "dsh-purge";

export const INSERT_BLOCK = [
  "- insert:",
  "    - id: dsh-purge",
  "      name: dsh-purge",
  "      inject: [systemPrompt, tools]",
  "      config:",
  "        enabled: true",
  "        stripMnemon: true",
  "        capabilityProtocol: true",
  "        hooksDenyBypass: true",
  "",
].join("\n");

export function profileHasPurgeBodyInsert(text) {
  const lines = String(text || "").split(/\r?\n/);
  let insertIndent = -1;
  for (const line of lines) {
    if (/^-\s*insert:\s*$/.test(line) || /^\s+-\s*insert:\s*$/.test(line)) {
      insertIndent = (line.match(/^[ \t]*/) || [""])[0].length;
      continue;
    }
    if (insertIndent < 0) continue;
    const indent = (line.match(/^[ \t]*/) || [""])[0].length;
    const trimmed = line.trim();
    if (trimmed && indent <= insertIndent && /^-\s/.test(trimmed)) {
      insertIndent = -1;
      if (/^-\s*insert:\s*$/.test(trimmed)) {
        insertIndent = indent;
      }
      continue;
    }
    // 본체 행: id: dsh-purge, 또는 사용자가 #159 로 임시 우회해 쓴 dsh-purge-main / name: dsh-purge
    if (/^-\s*id:\s*dsh-purge(-main)?\s*$/.test(trimmed)) return true;
    if (/^-\s*name:\s*dsh-purge\s*$/.test(trimmed)) return true;
  }
  return false;
}

/**
 * cordis.patch.yml 의 데이터 부분 형태를 판정한다 (#191).
 *
 * 호스트가 생성한 profile 레이어 patch 파일은 전체가 빈 flow 시퀀스 `[]` 하나일 수 있고,
 * 그것은 **하나의 완전한 YAML 문서**다. 파일 끝에 `- insert:` 를 덧붙이면 두 번째 문서가 되어
 * 호스트 기동 시 "end of the stream or a document separator is expected" 파싱 오류가 난다.
 *
 * 마지막 문서의 루트 노드 타입만 본다(추가 내용은 마지막 문서에 들어간다):
 *   - "empty"        데이터 행 없음 (빈 파일 / 주석과 빈 줄만)
 *   - "empty-flow"   데이터 부분이 정확히 빈 flow 시퀀스 `[]` (`---` 접두사 허용)
 *   - "block-seq"    정상 블록 시퀀스 (최상위 `- ...`), 기존 추가 동작 유지
 *   - "flow-seq"     비어 있지 않은 flow 시퀀스 (호스트/사용자 내용, 건드리면 안 됨)
 *   - "unknown"      기타 형태 (최상위 매핑 등), 확신할 수 없으면 쓰지 않는다
 */
export function classifyPatchBody(text) {
  const lines = String(text || "").replace(/\r\n/g, "\n").split("\n");
  const dataLines = [];
  for (let i = 0; i < lines.length; i += 1) {
    const trimmed = lines[i].trim();
    if (!trimmed) continue; // 빈 줄
    if (trimmed.startsWith("#")) continue; // 주석 행
    dataLines.push({ index: i, trimmed });
  }
  // `---` 로 여러 문서를 나누고 마지막 문서만 본다(추가 내용은 마지막 문서에 들어간다)
  const lastDoc = [];
  for (const item of dataLines) {
    if (item.trimmed === "---") {
      lastDoc.length = 0;
      continue;
    }
    lastDoc.push(item);
  }
  if (lastDoc.length === 0) return { kind: "empty", lines };
  // 빈 flow 시퀀스: `[]` / `[ ]`, 행 끝 주석 허용
  if (lastDoc.length === 1 && /^\[\s*\]\s*(#.*)?$/.test(lastDoc[0].trimmed)) {
    return { kind: "empty-flow", lines, emptyFlowIndex: lastDoc[0].index };
  }
  if (lastDoc[0].trimmed.startsWith("[")) return { kind: "flow-seq", lines };
  if (/^-(\s|$)/.test(lastDoc[0].trimmed)) {
    // 블록 시퀀스에 최상위 flow 시퀀스가 섞임 → 그 자체로 잘못된 YAML, 확신할 수 없으면 건드리지 않는다
    if (lastDoc.slice(1).some((item) => item.trimmed.startsWith("["))) return { kind: "unknown", lines };
    return { kind: "block-seq", lines };
  }
  return { kind: "unknown", lines };
}

export function ensureProfileBodyInsert(profileDir) {
  const fp = path.join(profileDir, "cordis.patch.yml");
  let text = "";
  try { text = fs.readFileSync(fp, "utf8"); } catch { text = ""; }
  if (profileHasPurgeBodyInsert(text)) {
    return { ok: true, wrote: false, path: fp };
  }
  const shape = classifyPatchBody(text);
  if (shape.kind === "empty-flow") {
    // `[]` 자체가 하나의 완전한 문서다: 그 행 전체를 insert 블록으로 바꾸고, 절대 두 번째 문서로 덧붙이지 않는다 (#191)
    const blockLines = INSERT_BLOCK.replace(/\n$/, "").split("\n");
    const out = [
      ...shape.lines.slice(0, shape.emptyFlowIndex),
      ...blockLines,
      ...shape.lines.slice(shape.emptyFlowIndex + 1),
    ].join("\n");
    fs.writeFileSync(fp, `${out.endsWith("\n") ? out : `${out}\n`}`, "utf8");
    return { ok: true, wrote: true, path: fp };
  }
  if (shape.kind === "flow-seq" || shape.kind === "unknown") {
    // 호스트 / 사용자 자신의 내용이므로, 건드리지 않는 편이 망치는 것보다 낫다 (#191)
    return { ok: false, wrote: false, path: fp };
  }
  // 빈 파일 / 주석만 → insert 블록을 바로 쓴다; 정상 블록 시퀀스 → 기존 추가 동작 유지
  const prefix = text && !text.endsWith("\n") ? "\n" : "";
  fs.writeFileSync(fp, `${text}${prefix}${text ? "\n" : ""}${INSERT_BLOCK}`, "utf8");
  return { ok: true, wrote: true, path: fp };
}

function readJson(fp) {
  try {
    return JSON.parse(fs.readFileSync(fp, "utf8"));
  } catch {
    return null;
  }
}

function profileOwnsPurge(dir) {
  const pkg = readJson(path.join(dir, "package.json"));
  const bundles = pkg?.dsh?.profile?.bundles;
  if (Array.isArray(bundles) && bundles.includes(PURGE_NAME)) return true;
  try {
    return fs.existsSync(path.join(dir, "node_modules", PURGE_NAME, "package.json"));
  } catch {
    return false;
  }
}

export function listProfileDirs(dshHome) {
  const root = path.join(dshHome || "", "profiles");
  const out = [];
  let names = [];
  try { names = fs.readdirSync(root); } catch { return out; }
  for (const name of names) {
    const dir = path.join(root, name);
    try {
      if (fs.statSync(dir).isDirectory()) out.push(dir);
    } catch { /* skip */ }
  }
  return out;
}

export function ensureProfileBundles(profileDir) {
  const fp = path.join(profileDir, "package.json");
  const pkg = readJson(fp);
  if (!pkg) return { ok: false, wrote: false, path: fp };
  pkg.dsh = pkg.dsh && typeof pkg.dsh === "object" ? pkg.dsh : {};
  pkg.dsh.profile = pkg.dsh.profile && typeof pkg.dsh.profile === "object" ? pkg.dsh.profile : {};
  const bundles = Array.isArray(pkg.dsh.profile.bundles) ? pkg.dsh.profile.bundles : [];
  if (bundles.includes(PURGE_NAME)) return { ok: true, wrote: false, path: fp };
  pkg.dsh.profile.bundles = [...bundles, PURGE_NAME];
  fs.writeFileSync(fp, `${JSON.stringify(pkg, null, 2)}\n`, "utf8");
  return { ok: true, wrote: true, path: fp };
}

/**
 * pnpm allowBuilds 기대 키 (#185).
 *
 * 맨 패키지 이름 `dsh-purge` 만 쓴다: pnpm 의 allowBuilds 는 패키지 이름으로 매칭하므로
 * tarball / git / registry 세 가지 설치 형태가 모두 허용된다. 반면 `dsh-purge@https://...` 같은 키는
 * pnpm 11 (DSH 내장 11.2.2) 에서 semver 파서가 버전 유니온으로 해석해
 * `[ERR_PNPM_INVALID_VERSION_UNION] Invalid versions union` 을 내고 install 이 깨진다.
 *
 * profileDir 인자는 구 호출 호환용으로만 남아 있고 실제로는 필요 없다 (#185).
 */
export function purgePnpmBuildSpecs(profileDir) {
  return [PURGE_NAME];
}

function isPurgeAllowBuildKey(key) {
  const name = String(key || "").replace(/^['"]|['"]$/g, "");
  return name === PURGE_NAME || name.startsWith(`${PURGE_NAME}@`);
}

/** 내보내기는 단위 테스트 round-trip 전용 (#180). */
export function parseAllowBuildLine(line) {
  const text = String(line || "").replace(/\r$/, "");
  // 따옴표로 감싼 경우: 키를 통째로 꺼낸다, URL 안의 콜론이 키를 자르지 않는다
  const quoted = text.match(/^[ \t]+(?:"([^"]+)"|'([^']+)')[ \t]*:[ \t]*(.*?)\s*$/);
  if (quoted) return { key: quoted[1] !== undefined ? quoted[1] : quoted[2], value: String(quoted[3] || "").trim() };
  // 따옴표 없는 키: 들여쓰기가 있어야 하고(최상위 키는 제외), 「콜론+공백(또는 행 끝)」에서만 자르며 마지막 위치를 쓴다 —
  // URL 안의 `:` 뒤에는 `/` 가 오므로 키가 끊기지 않는다; `dsh-purge@https: true`(기형 레거시 키)도 정상적으로 키+값으로 잘린다 (#180)
  if (!/^[ \t]+/.test(text)) return null;
  let split = -1;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== ":") continue;
    if (i + 1 >= text.length || /[ \t]/.test(text[i + 1])) split = i;
  }
  if (split < 0) return null;
  const key = text.slice(0, split).trim();
  if (!key) return null;
  return { key, value: text.slice(split + 1).trim() };
}

/** 내보내기는 단위 테스트 round-trip 전용 (#180). */
export function formatAllowBuildLine(key) {
  const name = String(key || "");
  // `://` 가 들어간 URL 키는 따옴표를 붙여 YAML 이 URL 안의 콜론을 구분자로 오해하지 않게 한다 (#180)
  if (name.includes("://")) return `  ${JSON.stringify(name)}: true`;
  return `  ${name}: true`;
}

/**
 * 재작성 전 최소 검증: 최상위 키, allowBuilds 구간 내 키 모두 중복이 없고, 각 키의 write-back 형식이
 * parseAllowBuildLine 으로 무손실 복원된다. 검증을 통과하지 못하면 디스크에 쓰지 않고, 사용자 파일을 건드리지 않는다 (#180).
 * 내보내기는 단위 테스트 전용 (#180).
 */
export function validateAllowBuildRewrite(text) {
  const lines = String(text || "").split("\n");
  let inAllow = false;
  let allowIndent = -1;
  const topKeys = new Set();
  const allowKeys = new Set();
  for (const line of lines) {
    if (!line.trim()) continue;
    const trimmed = line.trim();
    if (trimmed.startsWith("#")) continue; // 주석 행은 그대로 보존하고 검증에 참여하지 않는다
    if (/^\S/.test(line)) {
      inAllow = /^allowBuilds[ \t]*:/.test(line);
      allowIndent = -1;
      const m = line.match(/^(\S+?)[ \t]*:/);
      if (!m) return false;
      if (topKeys.has(m[1])) return false;
      topKeys.add(m[1]);
      continue;
    }
    if (!inAllow) continue;
    const indent = (line.match(/^[ \t]*/) || [""])[0].length;
    if (allowIndent < 0) allowIndent = indent;
    if (indent < allowIndent) {
      // 들여쓰기가 allowBuilds 의 하위 키 레벨 위로 돌아갔으므로 구간이 끝났다
      inAllow = false;
      continue;
    }
    const parsed = parseAllowBuildLine(line);
    if (!parsed || !parsed.key) return false;
    const name = parsed.key;
    if (allowKeys.has(name)) return false;
    // write-back 한 행에서 같은 키가 무손실로 파싱되어야 한다
    if (parseAllowBuildLine(formatAllowBuildLine(name))?.key !== name) return false;
    allowKeys.add(name);
  }
  return true;
}

/**
 * dsh-purge 를 true 로 써서 다른 플러그인을 설치해도 ERR_PNPM_IGNORED_BUILDS 가 나지 않게 한다 (#168).
 *
 * #185: 맨 패키지 이름만 쓴다. `dsh-purge@https://...` 같은 키는 pnpm 11 에서 버전 유니온으로 해석되어
 * ERR_PNPM_INVALID_VERSION_UNION 을 유발하고 install 을 깨뜨린다.
 * 자가 치유 시 모든 `dsh-purge@*` 레거시 키(URL 키, 옛 절단 키 `dsh-purge@https`,
 * `@1.1.81` 같은 버전 키)는 전부 버리고 맨 패키지 이름만 남긴다; purge 가 아닌 키는 그대로 보존한다.
 */
export function rewritePnpmAllowBuilds(raw, profileDir) {
  const wanted = purgePnpmBuildSpecs(profileDir);
  const wantedSet = new Set(wanted);
  const text = String(raw || "").replace(/\r\n/g, "\n");
  const wantedBlock = wanted.map(formatAllowBuildLine);
  if (!text.trim()) {
    return `allowBuilds:\n${wantedBlock.join("\n")}\n`;
  }
  const lines = text.split(/\r?\n/);
  let start = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (/^allowBuilds[ \t]*:/.test(lines[i])) {
      start = i;
      break;
    }
  }
  if (start < 0) {
    const prefix = text.endsWith("\n") ? "" : "\n";
    return `${text}${prefix}\nallowBuilds:\n${wantedBlock.join("\n")}\n`;
  }
  let end = lines.length;
  const kept = [];
  const seen = new Set();
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim()) {
      end = i;
      break;
    }
    if (/^\S/.test(line)) {
      end = i;
      break;
    }
    const trimmed = line.trim();
    if (trimmed.startsWith("#")) {
      kept.push(line);
      continue;
    }
    const parsed = parseAllowBuildLine(line);
    if (!parsed) {
      kept.push(line);
      continue;
    }
    if (isPurgeAllowBuildKey(parsed.key)) {
      // 기대 키와 정확히 같은 행만 남기고 중복은 제거; 나머지 레거시 purge 키는 버린다 (#180 자가 치유)
      if (!wantedSet.has(parsed.key) || seen.has(parsed.key)) continue;
      kept.push(formatAllowBuildLine(parsed.key));
      seen.add(parsed.key);
      continue;
    }
    // purge 가 아닌 키는 그대로 보존; 같은 키 중복(pnpm 이 duplicated mapping key 를 낸다)은 첫 번째만 남긴다
    if (seen.has(parsed.key)) continue;
    seen.add(parsed.key);
    kept.push(line);
  }
  for (let i = 0; i < wanted.length; i += 1) {
    if (!seen.has(wanted[i])) {
      kept.push(wantedBlock[i]);
      seen.add(wanted[i]);
    }
  }
  const next = [...lines.slice(0, start + 1), ...kept, ...lines.slice(end)].join("\n");
  return next.endsWith("\n") ? next : `${next}\n`;
}

/** pnpm 11/12 는 기본적으로 postinstall 을 막는다(ERR_PNPM_IGNORED_BUILDS). profile 의 allowBuilds 에 써 두면 다음 add 때 스크립트가 돌아간다. */
export function ensurePnpmAllowBuild(profileDir) {
  const fp = path.join(profileDir, "pnpm-workspace.yaml");
  let text = "";
  try { text = fs.readFileSync(fp, "utf8"); } catch { text = ""; }
  const current = String(text || "").replace(/\r\n/g, "\n");
  const next = rewritePnpmAllowBuilds(current, profileDir);
  if (next === current) return { ok: true, wrote: false, path: fp };
  // 쓰기 전 검증을 통과하지 못하면 디스크에 쓰지 않고 현상을 유지한다 (#180)
  if (!validateAllowBuildRewrite(next)) return { ok: false, wrote: false, path: fp, reason: "allowBuilds-invalid" };
  fs.writeFileSync(fp, next, "utf8");
  return { ok: true, wrote: true, path: fp };
}

/** bundles / node_modules 에는 설치됐지만 insert 가 빠진 profile 에 본체 행을 채워 넣는다. */
export function ensureAllProfileBodyInserts(dshHome) {
  return ensureAllProfileInstall(dshHome).map((item) => ({
    dir: item.dir,
    ok: item.ok,
    wrote: Boolean(item.insert?.wrote),
    path: item.insert?.path || path.join(item.dir || "", "cordis.patch.yml"),
    error: item.error,
  }));
}

/** bundles + 본체 insert + pnpm allowBuilds. postinstall 이 건너뛰어지고 업그레이드가 overlay 를 덮어쓴 뒤에도 이 경로로 버튼을 되찾는다. */
export function ensureAllProfileInstall(dshHome) {
  const results = [];
  for (const dir of listProfileDirs(dshHome)) {
    if (!profileOwnsPurge(dir)) continue;
    try {
      const bundles = ensureProfileBundles(dir);
      const insert = ensureProfileBodyInsert(dir);
      const pnpm = ensurePnpmAllowBuild(dir);
      results.push({ dir, ok: true, bundles, insert, pnpm });
    } catch (error) {
      results.push({
        dir,
        ok: false,
        error: error && error.message ? error.message : String(error),
      });
    }
  }
  return results;
}
