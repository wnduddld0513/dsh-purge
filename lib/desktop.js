import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { isWshAscii, wshLiteral } from "./official-update.js";
import { asarArchiveIsFile, diskFs, hostFs } from "./extract-asar.js";
import { hostPromptKeepsInject } from "./host-clean.js";
import { atomicCopyFileSync, atomicWriteSync } from "./core.js";

function restartUniqSuffix() {
  return `${process.pid}-${randomBytes(4).toString("hex")}`;
}

// 아카이브가 없을 때는 node:fs 를 쓴다. app.asar 가 아직 있으면 매핑된 resources/app 을 이미 풀린 것으로 보면 안 된다.
const fs = hostFs;

// [dsh-purge-fix 2026-10-09] console.warn 이 host stderr 에 기록되면 → main.js:3729 host.exitPromise
// fail 콜백이 마지막 stderr 줄을 Error reason 으로 삼는다. helper restart 동안 어떤 warn 이라도
// crash log 로 오판될 수 있다. 내부 파일로 돌려 stderr 를 오염시키지 않는다.
const INTERNAL_LOG_PATH = path.join(os.tmpdir(), "dsh-purge-desktop.log");
function logInternal(msg) {
  try {
    const line = `${new Date().toISOString()} [dsh-purge] ${String(msg)}\n`;
    fs.appendFileSync(INTERNAL_LOG_PATH, line, "utf8");
  } catch {
    /* 로그를 쓰지 못하면 그냥 삼키고, 절대 stderr 로 보내지 않는다 */
  }
}

/** 시작 시 한 번: 구버전이 남긴 pid 접미사 없는 restart 스크립트/로그를 정리한다(24h 초과분). */
export function cleanupLegacyRestartScripts() {
  const tmp = os.tmpdir();
  let entries = [];
  try { entries = fs.readdirSync(tmp); } catch { return; }
  const pat = /^dsh-purge-official-restart(?:-[0-9a-f-]+)?\.(?:js|cmd|log)$/i;
  for (const name of entries) {
    if (!pat.test(name)) continue;
    const fp = path.join(tmp, name);
    try {
      const st = fs.statSync(fp);
      if (Date.now() - st.mtimeMs > 24 * 60 * 60 * 1000) {
        fs.unlinkSync(fp);
      }
    } catch { /* ignore */ }
  }
}

/** 경로가 `app.asar/...` 안에 있다. `app.asar` 파일 자체와 `app.asar.unpacked` 는 해당하지 않는다. */
export function isAsarSealedPath(p) {
  const parts = String(p || "").replace(/\\/g, "/").split("/").filter(Boolean);
  if (parts.length < 2) return false;
  return parts.slice(0, -1).some((seg) => {
    const s = seg.toLowerCase();
    return s.endsWith(".asar") && !s.endsWith(".asar.unpacked");
  });
}

function isFile(fp) {
  try {
    if (isAsarSealedPath(fp)) return false;
    return Boolean(fp) && fs.existsSync(fp) && fs.statSync(fp).isFile();
  } catch {
    return false;
  }
}

function isDir(fp) {
  try {
    if (isAsarSealedPath(fp)) return false;
    return Boolean(fp) && fs.existsSync(fp) && fs.statSync(fp).isDirectory();
  } catch {
    return false;
  }
}

function isAiBase(p) {
  return Boolean(p) && isDir(path.join(p, "dsh-agent-instructions", "lib"));
}

function uniquePaths(list) {
  const seen = new Set();
  const out = [];
  for (const item of list) {
    if (!item) continue;
    const n = path.normalize(item);
    const key = n.replace(/\\/g, "/").toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(n);
  }
  return out;
}

function slashNorm(p) {
  return path.normalize(String(p || "")).replace(/\\/g, "/").toLowerCase();
}

function isSubPath(child, root) {
  const c = slashNorm(child).replace(/\/+$/, "");
  const r = slashNorm(root).replace(/\/+$/, "");
  if (!c || !r || r === "/") return false;
  if (/^[a-z]:$/.test(r)) return false;
  return c === r || c.startsWith(`${r}/`);
}

/**
 * 커뮤니티 데스크톱, 공식 exe, .app 패키지만 설치 트리로 본다.
 * 상위 폴더 이름이 DeepSeek Harness 인 것만으로는 해당하지 않는다: npm 접두사와 설정 디렉터리가 자주 이 이름을 쓰므로,
 * 이름으로 트리 전체를 배제하면 Web 의 신원 문장과 complete 주입 패치가 건너뛰어진다.
 */
export function looksLikeDesktopName(p) {
  const n = slashNorm(p);
  if (!n) return false;
  return (
    n.includes("/dsh desktop/") ||
    n.includes("/dsh desktop.app/") ||
    n.endsWith("/dsh desktop") ||
    n.endsWith("/dsh desktop.app") ||
    n.includes("dsh-desktop") ||
    n.includes("/dsh next/") ||
    n.includes("/dsh next.app/") ||
    n.endsWith("/dsh next") ||
    n.endsWith("/dsh next.app") ||
    n.includes("dsh-next") ||
    n.includes("dsh-desktop-next") ||
    n.includes("/deepseek harness/") ||
    n.includes("/deepseek-harness/") ||
    n.includes("/deepseekharness") ||
    /\/deepseek[\s._-]*harness(\/|$)/.test(n) ||
    n.includes("/deepseek harness.app/") ||
    n.endsWith("/deepseek harness.app") ||
    n.includes("/deepseek bot/") ||
    n.includes("/deepseek-bot/") ||
    n.includes("/ds-bot/") ||
    n.endsWith("/deepseek bot") ||
    n.endsWith("/deepseek bot.app") ||
    /\/dsh desktop\.exe$/i.test(n) ||
    /\/dsh next\.exe$/i.test(n) ||
    /\/deepseek[\s._-]*harness\.exe$/i.test(n) ||
    /\/deepseek[\s._-]*bot\.exe$/i.test(n)
  );
}

const OFFICIAL_HARNESS_BASES = new Set([
  "deepseek harness.exe",
  "deepseek-harness.exe",
  "deepseek harness",
  "deepseek-harness",
  "dsh next.exe",
  "dsh next",
  "dsh-next.exe",
  "dsh-next",
]);

/**
 * "경로 자기 자신의 마지막 구간"만 데스크톱 이름으로 보고, 상위 디렉터리는 보지 않는다.
 *
 * 위 주석이 피해야 한다고 말한 일을 원래 구현이 실제로 하고 있었다: `n.includes("/deepseek harness/")`
 * 는 임의의 상위 디렉터리에 적중한다. 그런데 npm 접두사(`D:\DeepSeek Harness\npm-global\…`)와
 * DSH_HOME 의 상위 디렉터리(`D:\DeepSeek Harness\.dsh` 의 상위)가 마침 둘 다 이 이름이다 ——
 * 그래서 Web 설치 루트가 데스크톱으로 판정되어, findAiBaseWeb 의 모든
 * `!isInsideDesktopInstall(cand)` 가드가 정답을 걷어내고, Web 쪽은 호스트를 찾지 못한다.
 *
 * 실제 데스크톱 설치는 구조 표식으로 판정한다: 경로에 `/resources/app/`,
 * `/resources/app.asar.unpacked/` 또는 `/contents/resources/` 가 있는지(inferDesktopInstallDir 참고).
 * 이름은 "이 단계 디렉터리 자체가 설치 루트"인 경우의 폴백으로만 쓴다.
 */
export function looksLikeDesktopNameTail(p) {
  const n = slashNorm(p).toLowerCase().replace(/\/+$/, "");
  if (!n) return false;
  const cut = n.lastIndexOf("/");
  const tail = cut >= 0 ? n.slice(cut + 1) : n;
  if (!tail) return false;
  return (
    tail === "dsh desktop" ||
    tail === "dsh desktop.app" ||
    tail === "dsh next" ||
    tail === "dsh next.app" ||
    tail === "deepseek harness" ||
    tail === "deepseek harness.app" ||
    tail === "deepseek-harness" ||
    tail === "deepseekharness" ||
    /^dsh-desktop/.test(tail) ||
    /^dsh-next/.test(tail) ||
    /^dsh[\s._-]*next(\.exe)?$/.test(tail) ||
    /^deepseek[\s._-]*harness(\.exe)?$/.test(tail) ||
    tail === "deepseek bot" ||
    tail === "deepseek bot.app" ||
    tail === "deepseek-bot" ||
    tail === "ds-bot" ||
    /^deepseek[\s._-]*bot(\.exe)?$/.test(tail)
  );
}

function sameBase(name, expected) {
  return String(name || "").toLowerCase() === expected;
}

export function isDesktopExecutable(fp) {
  const base = path.basename(String(fp || "")).toLowerCase();
  if (base === "dsh desktop.exe" || base === "dsh desktop") return true;
  if (base === "dsh next.exe" || base === "dsh next") return true;
  if (OFFICIAL_HARNESS_BASES.has(base)) return true;
  if (/^deepseek[\s._-]*bot(\.exe)?$/.test(base) || /^ds[\s._-]*bot(\.exe)?$/.test(base)) return true;
  if (/^dsh[\s._-]*next(\.exe)?$/.test(base)) return true;
  return /^deepseek[\s._-]*harness(\.exe)?$/.test(base);
}

/** 官方 DeepSeek Harness 和带 asar 的 DSH NEXT 会解开 app.asar。第三方 DSH Desktop 不走这条。 */
export function isOfficialHarnessExecutable(fp) {
  const base = path.basename(String(fp || "")).toLowerCase();
  if (OFFICIAL_HARNESS_BASES.has(base)) return true;
  if (/^dsh[\s._-]*next(\.exe)?$/.test(base)) return true;
  return /^deepseek[\s._-]*harness(\.exe)?$/.test(base);
}

/** 설치 디렉터리 아래에 있을 수 있는 resources 폴더(mac 대소문자 구분 디스크에서는 Resources 와 resources 를 모두 시도). */
export function resourceDirCandidates(installDir) {
  if (!installDir) return [];
  const name = path.basename(installDir);
  if (sameBase(name, "macos")) {
    const contents = path.dirname(installDir);
    return [path.join(contents, "Resources"), path.join(contents, "resources")];
  }
  if (sameBase(name, "contents")) {
    return [path.join(installDir, "Resources"), path.join(installDir, "resources")];
  }
  if (name.toLowerCase().endsWith(".app")) {
    return [
      path.join(installDir, "Contents", "Resources"),
      path.join(installDir, "Contents", "resources"),
    ];
  }
  if (sameBase(name, "resources")) return [installDir];
  return [path.join(installDir, "resources"), path.join(installDir, "Resources")];
}

/** 공식 호스트의 resources 디렉터리. 이미 존재하는 app.asar 를 우선하고, 없으면 해당 플랫폼의 일반 디렉터리 이름을 쓴다. */
export function resourcesDirForExecutable(exe) {
  const exeDir = path.dirname(path.normalize(String(exe || "")));
  if (!exeDir) return "";
  const cands = resourceDirCandidates(exeDir);
  const withAsar = cands.find((dir) => isFile(path.join(dir, "app.asar")));
  if (withAsar) return withAsar;
  const existing = cands.find((dir) => isDir(dir));
  if (existing) return existing;
  return cands[0] || "";
}

export function appAsarPath(exe) {
  const dir = resourcesDirForExecutable(exe);
  return dir ? path.join(dir, "app.asar") : "";
}

export function appDirForExecutable(exe) {
  const dir = resourcesDirForExecutable(exe);
  return dir ? path.join(dir, "app") : "";
}

/* ---------------------------------------------------------------- office-skills 自愈
 * resources/runtime/office-skills/office/SKILL.md 缺失时，dsh-skill-office 初始化
 * 同步读七个文件，桌面端直接 DesktopHostFatalError 退出。这里在“应用能起来”的
 * 前提下把缺的文件从 app.asar / npm 安装树补回磁盘，避免下次再崩。
 * 注意：救不了崩溃当次（崩溃发生在 Fiber._reload，比插件早）。
 */
const OFFICE_SKILL_MARKER = ["office", "SKILL.md"];
const OFFICE_COPY_MAX_DEPTH = 12;

function copySkillTree(src, dest, reader, writer, depth = 0) {
  if (depth > OFFICE_COPY_MAX_DEPTH) return;
  try { writer.mkdirSync(dest, { recursive: true }); } catch { return; }
  let entries;
  try { entries = reader.readdirSync(src, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (!entry || !entry.name) continue;
    // 只跟真目录；符号链接可能指回上层，递归会绕圈。
    if (entry.isSymbolicLink && entry.isSymbolicLink()) continue;
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copySkillTree(from, to, reader, writer, depth + 1);
    } else if (entry.isFile()) {
      try {
        if (writer.existsSync(to)) continue;
        writer.mkdirSync(path.dirname(to), { recursive: true });
        writer.writeFileSync(to, reader.readFileSync(from));
      } catch { /* 单个文件失败不挡整棵树 */ }
    }
  }
}

export function healOfficeSkillsAt(resourcesDir, appDir = "", extraSources = []) {
  if (!resourcesDir) return { ok: false, reason: "no-resources" };
  const dest = path.join(resourcesDir, "runtime", "office-skills");
  const marker = path.join(dest, ...OFFICE_SKILL_MARKER);
  const out = diskFs();
  try { if (out.existsSync(marker)) return { ok: true, healed: false, dest }; } catch { /* 下面按缺失处理 */ }
  const sources = [
    appDir ? path.join(appDir, "runtime", "office-skills") : "",
    appDir ? path.join(appDir, "dsh", "node_modules", "@deepseek-ai", "dsh-skill-office", "assets") : "",
    path.join(resourcesDir, "app", "runtime", "office-skills"),
    path.join(resourcesDir, "app", "dsh", "node_modules", "@deepseek-ai", "dsh-skill-office", "assets"),
    // 打包安装的资源在 asar 里，hostFs 认 asar 路径。
    path.join(resourcesDir, "app.asar", "dsh", "node_modules", "@deepseek-ai", "dsh-skill-office", "assets"),
    path.join(resourcesDir, "app.asar.unpacked", "dsh", "node_modules", "@deepseek-ai", "dsh-skill-office", "assets"),
    ...(Array.isArray(extraSources) ? extraSources : []),
  ].filter(Boolean);
  const src = sources.find((dir) => {
    try { return hostFs.existsSync(path.join(dir, ...OFFICE_SKILL_MARKER)); } catch { return false; }
  });
  if (!src) return { ok: false, reason: "no-source", dest };
  try {
    copySkillTree(src, dest, hostFs, out);
    return { ok: out.existsSync(marker), healed: true, src, dest };
  } catch (error) {
    return { ok: false, reason: String(error?.message || error), src, dest };
  }
}

export function healOfficeSkillsRuntimeOnDisk(extraSources = []) {
  const exe = findDesktopAppExecutable();
  if (!exe || !isOfficialHarnessExecutable(exe)) return { ok: false, reason: "no-exe" };
  return healOfficeSkillsAt(resourcesDirForExecutable(exe), appDirForExecutable(exe), extraSources);
}

function exeCandidatesBeside(dir) {
  if (!dir) return [];
  return [
    path.join(dir, "DeepSeek Harness.exe"),
    path.join(dir, "deepseek-harness.exe"),
    path.join(dir, "DeepSeek Harness"),
    path.join(dir, "deepseek-harness"),
    path.join(dir, "DSH Desktop.exe"),
    path.join(dir, "DSH Desktop"),
    path.join(dir, "DSH NEXT.exe"),
    path.join(dir, "DSH NEXT"),
    path.join(dir, "DeepSeek Bot.exe"),
    path.join(dir, "DeepSeek-Bot.exe"),
    path.join(dir, "DeepSeek Bot"),
    path.join(dir, "MacOS", "DeepSeek Harness"),
    path.join(dir, "MacOS", "deepseek-harness"),
    path.join(dir, "MacOS", "DSH Desktop"),
    path.join(dir, "MacOS", "DSH NEXT"),
    path.join(dir, "MacOS", "DeepSeek Bot"),
    path.join(dir, "Contents", "MacOS", "DeepSeek Harness"),
    path.join(dir, "Contents", "MacOS", "deepseek-harness"),
    path.join(dir, "Contents", "MacOS", "DSH Desktop"),
    path.join(dir, "Contents", "MacOS", "DSH NEXT"),
    path.join(dir, "Contents", "MacOS", "DeepSeek Bot"),
  ];
}

function firstExistingExe(dirs) {
  for (const dir of dirs) {
    if (!dir) continue;
    for (const cand of exeCandidatesBeside(dir)) {
      if (isFile(cand)) return path.normalize(cand);
    }
  }
  return "";
}

const APP_SCRIPT_RE = /(desktop-cli|host-process-entry)\.js$/i;

function installDirsFromAppScript(scriptPath) {
  if (!scriptPath) return [];
  const abs = path.resolve(scriptPath);
  const lib = path.dirname(abs);
  const app = path.dirname(lib);
  const resources = path.dirname(app);
  const install = path.dirname(resources);
  return uniquePaths([lib, app, resources, install]);
}

/** 임의의 `.../resources/app/...` 트리에서 설치 디렉터리를 역산한다(폴더 이름이 DSH Desktop 일 필요 없음). */
export function inferDesktopInstallDir(p) {
  const raw = path.normalize(String(p || "")).replace(/\\/g, "/");
  const n = raw.toLowerCase();
  if (!n) return "";
  const markers = [
    "/resources/app.asar.unpacked/",
    "/resources/app/",
    "/contents/resources/",
  ];
  for (const marker of markers) {
    const i = n.indexOf(marker);
    if (i <= 0) continue;
    return path.normalize(raw.slice(0, i));
  }
  return "";
}

function extraInstallsFromEnv(env = process.env) {
  return String(env.DSH_DESKTOP_INSTALL || "")
    .split(path.delimiter)
    .map((item) => item.trim())
    .filter(Boolean);
}

function trustedInstallDir(dir) {
  if (!dir) return false;
  if (looksLikeDesktopName(dir)) return true;
  if (firstExistingExe([dir])) return true;
  return (
    isAiBase(path.join(dir, "resources", "app", "dsh", "node_modules", "@deepseek-ai")) ||
    isAiBase(path.join(dir, "resources", "app", "node_modules", "@deepseek-ai")) ||
    isAiBase(path.join(dir, "resources", "app.asar.unpacked", "dsh", "node_modules", "@deepseek-ai")) ||
    isAiBase(path.join(dir, "resources", "app.asar.unpacked", "node_modules", "@deepseek-ai"))
  );
}

const REGISTRY_INSTALL_SCRIPT = `
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$names = @('DeepSeek Harness','DSH Desktop','DSH NEXT','DeepSeek Bot','DS Bot')
$roots = @(
  'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall'
)
$rows = foreach ($root in $roots) {
  if (-not (Test-Path $root)) { continue }
  Get-ChildItem $root -ErrorAction SilentlyContinue | ForEach-Object {
    $p = Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue
    if (-not $p.DisplayName) { return }
    $hit = $false
    foreach ($n in $names) { if ($p.DisplayName -like ('*' + $n + '*')) { $hit = $true } }
    if (-not $hit) { return }
    [pscustomobject]@{
      InstallLocation = [string]$p.InstallLocation
      DisplayIcon = [string]$p.DisplayIcon
      UninstallString = [string]$p.UninstallString
    }
  }
}
if ($rows) { @($rows) | ConvertTo-Json -Compress }
`.trim();

function exeDirFromRegistryValue(value) {
  let val = String(value || "").trim();
  const quoted = val.match(/^"([^"]+)"/);
  if (quoted) val = quoted[1];
  val = val.replace(/,0$/, "").trim();
  if (!val) return "";
  return path.normalize(path.dirname(val));
}

let cachedRegistryDirs;
/** 언인스톨 등록 정보에서 설치 디렉터리를 읽는다. 드라이브 문자는 사용자 설치 위치를 따르며 고정하지 않는다. */
export function registryInstallDirs() {
  if (cachedRegistryDirs !== undefined) return cachedRegistryDirs;
  if (process.platform !== "win32") {
    cachedRegistryDirs = [];
    return cachedRegistryDirs;
  }
  let text = "";
  try {
    text = execFileSync("powershell.exe", ["-NoProfile", "-Command", REGISTRY_INSTALL_SCRIPT], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 15000,
      maxBuffer: 8 << 20,
    });
  } catch {
    return [];
  }
  let rows = [];
  try {
    const parsed = JSON.parse(String(text || "").replace(/^\uFEFF/, "").trim() || "[]");
    rows = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
  } catch {
    return [];
  }
  const found = [];
  for (const row of rows) {
    const location = String(row.InstallLocation || "").trim();
    if (location) found.push(path.normalize(location));
    found.push(exeDirFromRegistryValue(row.DisplayIcon));
    found.push(exeDirFromRegistryValue(row.UninstallString));
  }
  const result = uniquePaths(found).filter((dir) => firstExistingExe([dir]));
  if (result.length > 0) cachedRegistryDirs = result;
  return result;
}

const PORTABLE_INSTALL_NAMES = [
  "DeepSeek Harness",
  "DeepseekHarnessDesktop",
  "DeepSeekHarnessDesktop",
  "DSH Desktop",
  "DSH NEXT",
  "deepseek-harness",
];

function homeSiblingInstalls(env = process.env) {
  const homes = [env.DSH_HOME, env.DSH_BASE].filter(Boolean);
  const dirs = [];
  for (const raw of homes) {
    const start = path.normalize(String(raw));
    dirs.push(start, path.dirname(start), path.dirname(path.dirname(start)));
  }
  return uniquePaths(dirs).filter((dir) => firstExistingExe([dir]));
}

/** 사용자 디렉터리와 각 드라이브 루트 한 단계 아래의 흔한 폴더 이름. 디스크 전체를 스캔하지 않는다. */
function portableInstallGuesses(env = process.env) {
  const home = os.homedir();
  const cands = [];
  for (const folder of ["Desktop", "Documents", "Downloads"]) {
    for (const name of PORTABLE_INSTALL_NAMES) {
      cands.push(path.join(home, folder, name));
    }
  }
  for (const name of PORTABLE_INSTALL_NAMES) {
    cands.push(path.join(home, name));
  }
  if (process.platform === "win32") {
    for (const letter of "CDEFGHI") {
      for (const name of PORTABLE_INSTALL_NAMES) {
        cands.push(`${letter}:\\${name}`);
      }
    }
  }
  return uniquePaths(cands).filter((dir) => firstExistingExe([dir]));
}

function walkParentsForOfficialExe(start, maxUp = 8) {
  if (!start) return "";
  let dir = "";
  try {
    const abs = path.resolve(String(start));
    dir = isDir(abs) ? abs : path.dirname(abs);
  } catch {
    return "";
  }
  for (let i = 0; i < maxUp && dir; i += 1) {
    const hit = firstExistingExe([dir]);
    if (hit) return hit;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return "";
}

const PROCESS_EXE_SCRIPT = `
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$re = 'DeepSeek Harness\\.exe$|deepseek-harness\\.exe$|DSH Desktop\\.exe$|DSH NEXT\\.exe$'
$paths = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
  Where-Object { $_.ExecutablePath -and $_.ExecutablePath -match $re } |
  Select-Object -ExpandProperty ExecutablePath)
if ($paths) { @($paths) | ConvertTo-Json -Compress }
`.trim();

let cachedRunningExes;
function runningOfficialExecutables() {
  if (cachedRunningExes !== undefined) return cachedRunningExes;
  if (process.platform !== "win32") {
    cachedRunningExes = [];
    return cachedRunningExes;
  }
  let text = "";
  try {
    text = execFileSync("powershell.exe", ["-NoProfile", "-Command", PROCESS_EXE_SCRIPT], {
      encoding: "utf8",
      windowsHide: true,
      // 15s 는 시작 단계 UI 스레드를 15s 동안 막는다; Win32_Process 열거는 1-3s 면 충분하므로, 타임아웃이면 바로 반환하고 캐시하지 않는다.
      timeout: 6000,
      maxBuffer: 8 << 20,
    });
  } catch {
    // 탐지에 실패하면 빈 결과를 캐시하지 않는다. 그러면 이번 프로세스 내내 실행 중인 클라이언트를 찾지 못한다.
    return [];
  }
  let rows = [];
  try {
    const parsed = JSON.parse(String(text || "").replace(/^\uFEFF/, "").trim() || "[]");
    rows = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
  } catch {
    return [];
  }
  // 결과가 비어 있어도 캐시하지 않는다: 클라이언트가 나중에 시작될 수 있고, 캐시하면 이 프로세스는 이후 영원히 그것을 찾지 못한다.
  const result = uniquePaths(rows.map((item) => String(item || "").trim()).filter((fp) => isDesktopExecutable(fp) && isFile(fp)));
  if (result.length > 0) cachedRunningExes = result;
  return result;
}

const SHORTCUT_EXE_SCRIPT = `
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$shell = New-Object -ComObject WScript.Shell
$roots = @(
  [Environment]::GetFolderPath('StartMenu'),
  [Environment]::GetFolderPath('CommonStartMenu'),
  [Environment]::GetFolderPath('Desktop'),
  [Environment]::GetFolderPath('CommonDesktopDirectory')
) | Where-Object { $_ }
$pats = @('*DeepSeek*Harness*.lnk','*DSH Desktop*.lnk','*DSH NEXT*.lnk','*deepseek-harness*.lnk','*dsh-next*.lnk')
$out = New-Object System.Collections.Generic.List[string]
foreach ($root in $roots) {
  if (-not (Test-Path -LiteralPath $root)) { continue }
  foreach ($pat in $pats) {
    Get-ChildItem -LiteralPath $root -Filter $pat -Recurse -ErrorAction SilentlyContinue |
      Select-Object -First 16 | ForEach-Object {
        try {
          $t = $shell.CreateShortcut($_.FullName).TargetPath
          if ($t) { $out.Add([string]$t) }
        } catch {}
      }
  }
}
if ($out.Count) { @($out) | ConvertTo-Json -Compress }
`.trim();

let cachedShortcutExes;
function shortcutOfficialExecutables() {
  if (cachedShortcutExes !== undefined) return cachedShortcutExes;
  if (process.platform !== "win32") {
    cachedShortcutExes = [];
    return cachedShortcutExes;
  }
  let text = "";
  try {
    text = execFileSync("powershell.exe", ["-NoProfile", "-Command", SHORTCUT_EXE_SCRIPT], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 15000,
      maxBuffer: 8 << 20,
    });
  } catch {
    return [];
  }
  let rows = [];
  try {
    const parsed = JSON.parse(String(text || "").replace(/^\uFEFF/, "").trim() || "[]");
    rows = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
  } catch {
    return [];
  }
  const result = uniquePaths(rows.map((item) => String(item || "").trim()).filter((fp) => isDesktopExecutable(fp) && isFile(fp)));
  if (result.length > 0) cachedShortcutExes = result;
  return result;
}

/** "적용" 을 누르기 전에 실패한 빈 캐시를 지우고, 이 PC 의 exe 를 다시 찾는다. */
export function clearDesktopLocateCache() {
  cachedRunningExes = undefined;
  cachedShortcutExes = undefined;
  cachedRegistryDirs = undefined;
}

function extraDiscoveredInstallDirs(env = process.env, input = {}) {
  const cheap = [
    ...homeSiblingInstalls(env),
    ...portableInstallGuesses(env),
  ];
  if (input.discover !== true) return uniquePaths(cheap);
  return uniquePaths([
    ...cheap,
    ...runningOfficialExecutables().map((exe) => path.dirname(exe)),
    ...shortcutOfficialExecutables().map((exe) => path.dirname(exe)),
  ]);
}

/** NSIS / 스토어 기본 위치; 전체 디스크 스캔이 아니다. discover 만 레지스트리 / 프로세스 / 바로가기를 조회한다. */
export function commonDesktopInstallDirs(env = process.env, input = {}) {
  const discover = input.discover === true;
  const home = os.homedir();
  const local = env.LOCALAPPDATA || path.join(home, "AppData", "Local");
  const pf = env.ProgramFiles || "";
  const pf86 = env["ProgramFiles(x86)"] || "";
  return uniquePaths([
    ...extraInstallsFromEnv(env).filter(trustedInstallDir),
    ...(discover ? registryInstallDirs() : []),
    ...extraDiscoveredInstallDirs(env, { discover }),
    path.join(local, "Programs", "DeepSeek Harness"),
    path.join(local, "Programs", "DSH Desktop"),
    path.join(local, "Programs", "DSH NEXT"),
    path.join(local, "Programs", "DeepSeek Bot"),
    path.join(local, "DeepSeek Harness"),
    path.join(local, "DSH NEXT"),
    path.join(local, "DeepSeek Bot"),
    ...(pf
      ? [path.join(pf, "DeepSeek Harness"), path.join(pf, "DSH Desktop"), path.join(pf, "DSH NEXT"), path.join(pf, "DeepSeek Bot")]
      : []),
    ...(pf86
      ? [path.join(pf86, "DeepSeek Harness"), path.join(pf86, "DSH Desktop"), path.join(pf86, "DSH NEXT"), path.join(pf86, "DeepSeek Bot")]
      : []),
    "/Applications/DeepSeek Harness.app",
    "/Applications/DSH Desktop.app",
    "/Applications/DSH NEXT.app",
    "/Applications/DeepSeek Bot.app",
    path.join(home, "Applications", "DeepSeek Harness.app"),
    path.join(home, "Applications", "DSH Desktop.app"),
    path.join(home, "Applications", "DSH NEXT.app"),
    path.join(home, "Applications", "DeepSeek Bot.app"),
    "/opt/DeepSeek Harness",
    "/opt/deepseek-harness",
    "/opt/DSH NEXT",
    "/usr/lib/DeepSeek Harness",
    "/usr/lib/deepseek-harness",
    "/usr/share/deepseek-harness",
    path.join(home, ".local", "share", "DeepSeek Harness"),
    path.join(home, ".local", "share", "deepseek-harness"),
    "/opt/DSH Desktop",
    "/usr/lib/dsh-desktop",
  ]);
}

export function listDesktopInstallRoots(input = {}) {
  const execPath = input.execPath ?? process.execPath;
  const resourcesPath = input.resourcesPath ?? process.resourcesPath;
  const argv = input.argv ?? process.argv;
  const env = input.env ?? process.env;
  const roots = [];

  if (isDesktopExecutable(execPath)) {
    const dir = path.dirname(path.normalize(execPath));
    roots.push(dir);
    if (sameBase(path.basename(dir), "macos")) {
      const contents = path.dirname(dir);
      roots.push(
        contents,
        path.join(contents, "Resources"),
        path.join(contents, "resources"),
        path.dirname(contents),
      );
    }
  }

  if (resourcesPath) {
    const res = path.normalize(resourcesPath);
    roots.push(res, path.dirname(res), path.join(res, "app"), path.join(res, "app.asar.unpacked"));
  }

  for (const arg of argv) {
    if (typeof arg === "string" && APP_SCRIPT_RE.test(arg)) {
      roots.push(...installDirsFromAppScript(arg));
    }
  }

  for (const extra of extraInstallsFromEnv(env)) {
    if (trustedInstallDir(extra)) roots.push(extra);
  }
  return uniquePaths(roots);
}

/**
 * 커뮤니티 Desktop 설치 트리에 속하는지 여부.
 * 드라이브 문자에 의존하지 않고, 폴더 이름이 "DSH Desktop" 일 것도 요구하지 않는다:
 * 현재 프로세스의 exe / resources / host-process-entry, 옆에 실제 데스크톱 exe 가 있는지, 또는 커뮤니티 설치 디렉터리 이름.
 */
export function isInsideDesktopInstall(p, input = {}) {
  if (!p) return false;
  // 이름 폴백은 경로 끝 구간만 보고 상위 디렉터리 이름은 보지 않는다 —— looksLikeDesktopNameTail 참고.
  if (looksLikeDesktopNameTail(p)) return true;
  const roots = listDesktopInstallRoots(input);
  if (roots.some((root) => isSubPath(p, root))) return true;
  const inferred = inferDesktopInstallDir(p);
  if (!inferred) return false;
  if (roots.some((root) => isSubPath(inferred, root) || isSubPath(root, inferred))) return true;
  return Boolean(firstExistingExe([inferred]));
}

export function findDesktopAppExecutable(input = {}) {
  const execPath = input.execPath ?? process.execPath;
  const resourcesPath = input.resourcesPath ?? process.resourcesPath;
  const argv = input.argv ?? process.argv;
  const env = input.env ?? process.env;
  const discover = input.discover === true;

  if (isDesktopExecutable(execPath) && isFile(execPath)) return path.normalize(execPath);

  const electron = (input.versions ?? process.versions)?.electron;
  if (
    electron
    && isFile(execPath)
    && !/^node(\.exe)?$/i.test(path.basename(execPath))
  ) {
    return path.normalize(execPath);
  }

  if (resourcesPath) {
    const hit = firstExistingExe([path.dirname(path.normalize(resourcesPath))]);
    if (hit) return hit;
  }

  for (const arg of argv) {
    if (typeof arg !== "string" || !APP_SCRIPT_RE.test(arg)) continue;
    const hit = firstExistingExe(installDirsFromAppScript(arg));
    if (hit) return hit;
  }

  const walkStarts = [execPath, resourcesPath, env.DSH_HOME, env.DSH_BASE];
  try { walkStarts.push(process.cwd()); } catch { /* ignore */ }
  for (const arg of argv) {
    if (typeof arg === "string") walkStarts.push(arg);
  }
  for (const start of walkStarts) {
    const hit = walkParentsForOfficialExe(start);
    if (hit) return hit;
  }

  if (discover) {
    const running = runningOfficialExecutables();
    if (running[0]) return running[0];
    const shortcuts = shortcutOfficialExecutables();
    if (shortcuts[0]) return shortcuts[0];
  }

  const guessed = firstExistingExe([
    ...extraInstallsFromEnv(env),
    ...commonDesktopInstallDirs(env, { discover }),
  ]);
  return guessed || "";
}

function packageRootsFromInstall(installDir) {
  if (!installDir) return [];
  const out = [];
  for (const resources of resourceDirCandidates(installDir)) {
    out.push(
      path.join(resources, "app", "dsh", "node_modules", "@deepseek-ai"),
      path.join(resources, "app", "node_modules", "@deepseek-ai"),
      path.join(resources, "app.asar.unpacked", "dsh", "node_modules", "@deepseek-ai"),
      path.join(resources, "app.asar.unpacked", "node_modules", "@deepseek-ai"),
    );
  }
  return out;
}

export function listDesktopPackageRoots(input = {}) {
  const execPath = input.execPath ?? process.execPath;
  const resourcesPath = input.resourcesPath ?? process.resourcesPath;
  const argv = input.argv ?? process.argv;
  const env = input.env ?? process.env;
  const discover = input.discover === true;
  const cands = [];

  if (resourcesPath) {
    cands.push(
      path.join(resourcesPath, "app", "dsh", "node_modules", "@deepseek-ai"),
      path.join(resourcesPath, "app", "node_modules", "@deepseek-ai"),
      path.join(resourcesPath, "app.asar.unpacked", "dsh", "node_modules", "@deepseek-ai"),
      path.join(resourcesPath, "app.asar.unpacked", "node_modules", "@deepseek-ai"),
    );
  }

  if (isDesktopExecutable(execPath)) {
    cands.push(...packageRootsFromInstall(path.dirname(execPath)));
  }

  const exe = findDesktopAppExecutable(input);
  if (exe) cands.push(...packageRootsFromInstall(path.dirname(exe)));

  for (const arg of argv) {
    if (typeof arg !== "string" || !APP_SCRIPT_RE.test(arg)) continue;
    const appDir = path.dirname(path.dirname(path.resolve(arg)));
    cands.push(path.join(appDir, "node_modules", "@deepseek-ai"));
    cands.push(path.join(appDir, "dsh", "node_modules", "@deepseek-ai"));
    cands.push(...packageRootsFromInstall(path.dirname(path.dirname(appDir))));
  }

  const localHits = uniquePaths(cands).filter(isAiBase);
  // 이미 어떤 데스크톱 exe 안에 있으면 이 한 부만 고친다. 옆에 다른 클라이언트가 설치돼 있어도 함께 처리되면 안 된다.
  if (isDesktopExecutable(execPath)) return localHits;
  // 시작 시 자가 복구: exe / 환경 / 흔한 디렉터리로 충분하다. 레지스트리와 바로가기는 "적용" 을 눌렀을 때로 남긴다.
  if (!discover && localHits.length) return localHits;

  for (const install of commonDesktopInstallDirs(env, { discover })) {
    cands.push(...packageRootsFromInstall(install));
  }

  return uniquePaths(cands).filter(isAiBase);
}

export function resolveDesktopAiBase(input = {}) {
  return listDesktopPackageRoots(input)[0] || null;
}

export function isSealedRuntimeDir(dir) {
  if (!dir) return false;
  const n = path.normalize(dir).replace(/\\/g, "/").toLowerCase();
  if (!/(^|\/)bin\/?$/.test(n)) return false;
  return (
    n.includes("/host-commands/") ||
    n.includes("/runtime-commands/") ||
    n.includes("/dsh desktop/")
  );
}

export function sealedRuntimeRoots(env = process.env) {
  const home = os.homedir();
  const appdata = env.APPDATA || path.join(home, "AppData", "Roaming");
  const localapp = env.LOCALAPPDATA || path.join(home, "AppData", "Local");
  return uniquePaths([
    path.join(appdata, "DSH Desktop", "host-commands"),
    path.join(appdata, "DSH Desktop", "runtime-commands"),
    path.join(localapp, "DSH Desktop", "host-commands"),
    path.join(localapp, "DSH Desktop", "runtime-commands"),
    path.join(home, "Library", "Application Support", "DSH Desktop", "host-commands"),
  ]);
}

function walkBinDirs(dir, out, depth) {
  if (depth < 0 || !isDir(dir)) return;
  const n = dir.replace(/\\/g, "/").toLowerCase();
  if (/(^|\/)bin$/.test(n)) {
    out.push(path.normalize(dir));
    return;
  }
  let ents = [];
  try {
    ents = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of ents) {
    if (ent.isDirectory()) walkBinDirs(path.join(dir, ent.name), out, depth - 1);
  }
}

export function listSealedRuntimeBins(env = process.env) {
  const out = [];
  for (const root of sealedRuntimeRoots(env)) walkBinDirs(root, out, 5);
  return uniquePaths(out).filter(isSealedRuntimeDir);
}

export function restartNote() {
  return "데스크톱 앱을 재시작하는 중…";
}

export function restartPlan(input = {}) {
  const exe = findDesktopAppExecutable(input);
  if (!exe) {
    return { kind: "desktop", execPath: "", argv: [], cwd: "", error: "DSH Desktop.exe 를 찾지 못해 데스크톱 앱을 재시작할 수 없습니다" };
  }
  return {
    kind: "desktop",
    execPath: exe,
    argv: [],
    cwd: path.dirname(exe),
  };
}

function helperEnv(payload, runner) {
  const env = { ...process.env };
  delete env.DSH_PERMISSION_MODE;
  if (runner && path.basename(runner).toLowerCase().includes("node")) {
    delete env.ELECTRON_RUN_AS_NODE;
  } else {
    env.ELECTRON_RUN_AS_NODE = "1";
  }
  env.DSH_PURGE_RESTART = JSON.stringify(payload);
  return env;
}

// #85 reverted: host 가 직접 Electron 을 동기적으로 죽이면, host 가 Electron 자식 프로세스로서 Job
// Object 에 연쇄로 죽어, spawnHelper 를 호출할 틈이 없어 → relaunch 가 완전히 실패한다 (YG 실측 증상: "재시작" 을 눌러도
// 반응이 없고 DSH 가 전부 죽어 relaunch 없음). helper 가 kill+relaunch 를 전권 처리하도록 되돌리고, crash dialog
// 문제는 patch #83+#84 (새 main.js 로드 후 close 콜백이 silent) 로 두 번째 이후에는 해결된다.
// 첫 번째 restart 의 crash dialog 는 Electron 메모리 버전 지연의 필연적 대가이며 피할 수 없다.

/** 패키지 교체 헬퍼는 더 이상 Electron 본체로 실행할 수 없다: Stop-HarnessInstall / taskkill 이 exe 이름으로 하면 자기 자신을 먼저 죽여 app.asar 를 영원히 옮길 수 없다(#133). */
function helperNodePath() {
  if (!process.versions.electron) return process.execPath;
  const hinted = String(process.env.DSH_NODE || "").trim();
  if (hinted && isFile(hinted)) return hinted;
  try {
    const out = execFileSync(process.platform === "win32" ? "where.exe" : "which", ["node"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 3000,
    });
    const first = String(out || "").split(/\r?\n/).map((s) => s.trim()).find(Boolean);
    if (first && isFile(first)) return first;
  } catch {
    /* 시스템 node 가 없을 때만 Electron + RUN_AS_NODE 로 되돌린다 */
  }
  return process.execPath;
}

function spawnHelper(helper, payload, opts = {}) {
  const plan = restartPlan();
  const hinted = payload && payload.execPath ? payload.execPath : "";
  const execPath = hinted || plan.execPath;
  if (!execPath) throw new Error(plan.error || "DSH Desktop.exe 를 찾지 못해 데스크톱 앱을 재시작할 수 없습니다");
  const runner = helperNodePath();
  const child = spawn(runner, [helper], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    shell: false,
    env: helperEnv({
      kind: "desktop",
      execPath,
      argv: plan.argv,
      cwd: plan.cwd || path.dirname(execPath),
      pid: process.pid,
      helperPidKeep: true,
      ...payload,
    }, runner),
  });
  child.unref();
  if (opts.exit !== false) setTimeout(() => process.exit(0), opts.exitAfter ?? 250);
}

function desktopRuntimeOf(ctx) {
  if (!ctx || typeof ctx.get !== "function") return null;
  const runtime = ctx.get("desktopRuntime") || ctx.get("desktopActions");
  return runtime && typeof runtime.requestRestart === "function" ? runtime : null;
}

const ASAR_SWAP_PS1 = [
  "param(",
  "  [Parameter(Mandatory = $true)][int]$WaitPid,",
  "  [Parameter(Mandatory = $true)][string]$AsarPath,",
  "  [Parameter(Mandatory = $true)][string]$ExePath",
  ")",
  "$ErrorActionPreference = 'Continue'",
  "$names = @('DeepSeek Harness', 'DSH Desktop', 'DSH NEXT')",
  "$installRoot = (Split-Path -Parent $ExePath).TrimEnd('\\')",
  "$exeNorm = $ExePath.ToLower()",
  "function Stop-HarnessInstall {",
  "  # 이번 설치 루트 경로 기준으로만 이 설치의 프로세스를 죽인다; 더 이상 /IM 전체 이름으로 죽이지 않아, 같은 이름의 서드파티를 잘못 건드리지 않는다.",
  "  Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {",
  "    $ep = $_.ExecutablePath",
  "    if (-not $ep) { return $false }",
  "    $low = $ep.ToLower()",
  "    return ($low -eq $exeNorm) -or $low.StartsWith($installRoot.ToLower() + '\\')",
  "  } | ForEach-Object {",
  "    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue",
  "  }",
  "}",
  "# #64 crash-dialog 근본 원인 제거: 더 이상 WaitPid (host) 의 정상 종료를 기다리지 않는다. 그렇게 하면 Electron main 이",
  "# 먼저 host 종료를 보게 되어 -> main.js:3725 ChildProcess listener 가\"host stopped\"대화상자를 띄운다.",
  "# 대신 즉시 Stop-HarnessInstall (Electron main + host 를 함께 죽임) 로 바꾸면, Electron 이 아직",
  "# host 종료 이벤트를 처리하기 전에 kill 되어 UI 자체가 없고, crash dialog 를 띄울 수 없다.",
  "# PowerShell 자체는 detached 독립 프로세스이며(spawn 시 detached:true, stdio:ignore),",
  "# Electron 을 죽여도 PowerShell 이 연쇄로 죽지는 않는다.",
  "Stop-HarnessInstall",
  "Start-Sleep -Milliseconds 500",
  "Stop-HarnessInstall",
  "Start-Sleep -Milliseconds 300",
  "# 폴백: 위에서 완전히 다 죽이지 못한 경우(예: CimInstance 열거가 특정 프로세스를 놓침), 짧은 타임아웃으로 한 번 더 기다린다.",
  "$deadline = (Get-Date).AddSeconds(10)",
  "while ((Get-Date) -lt $deadline) {",
  "  $self = Get-Process -Id $WaitPid -ErrorAction SilentlyContinue",
  "  $holding = @(Get-Process -Name $names -ErrorAction SilentlyContinue | Where-Object {",
  "    try { $_.Path -and ($_.Path.ToLower() -eq $exeNorm -or $_.Path.ToLower().StartsWith($installRoot.ToLower() + '\\')) } catch { $false }",
  "  })",
  "  if (-not $self -and $holding.Count -eq 0) { break }",
  "  Stop-HarnessInstall",
  "  Start-Sleep -Milliseconds 300",
  "}",
  "Start-Sleep -Milliseconds 500",
  "$appDir = Join-Path (Split-Path -Parent $AsarPath) 'app'",
  "$unpacked = $AsarPath + '.unpacked'",
  "$marker = Join-Path $appDir 'dsh\\node_modules\\node-addon-require-builtin-win32-x64-msvc\\prebuilt\\win32-x64-msvc-napi-v9.node'",
  "if ((Test-Path -LiteralPath $unpacked) -and -not (Test-Path -LiteralPath $marker)) {",
  "  & robocopy.exe $unpacked $appDir /E /XC /XN /XO /NFL /NDL /NJH /NJS /nc /ns /np | Out-Null",
  "}",
  "$moved = -not (Test-Path -LiteralPath $AsarPath)",
  "if (Test-Path -LiteralPath $AsarPath) {",
  "  $bak = \"$AsarPath.bak\"",
  "  if (Test-Path -LiteralPath $bak) { Remove-Item -LiteralPath $bak -Force -ErrorAction SilentlyContinue }",
  "  for ($i = 0; $i -lt 80; $i++) {",
  "    try {",
  "      Move-Item -LiteralPath $AsarPath -Destination $bak -Force",
  "      $moved = $true",
  "      break",
  "    } catch {",
  "      if ($i -eq 20 -or $i -eq 50) { Stop-HarnessInstall; Start-Sleep -Seconds 1 }",
  "      Start-Sleep -Milliseconds 400",
  "    }",
  "  }",
  "}",
  "$lock = $AsarPath + '.rename-pending'",
  "if ($moved) {",
  "  Remove-Item -LiteralPath $lock -Force -ErrorAction SilentlyContinue",
  "  Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue",
  "  Start-Process -FilePath $ExePath",
  "} else {",
  "  Set-Content -LiteralPath $lock -Value ((Get-Date).ToString('o')) -Encoding ascii",
  "}",
  "",
].join("\r\n");

const ASAR_RENAME_WHEN_IDLE_PS1 = [
  "param(",
  "  [Parameter(Mandatory = $true)][string]$AsarPath,",
  "  [Parameter(Mandatory = $true)][string]$ExePath,",
  "  [Parameter(Mandatory = $true)][string]$LockPath",
  ")",
  "$ErrorActionPreference = 'Continue'",
  "$deadline = (Get-Date).AddMinutes(30)",
  "while ((Get-Date) -lt $deadline) {",
  "  $restartFlag = Join-Path $env:TEMP 'dsh-purge-official-restarting'",
  "  if (Test-Path -LiteralPath $restartFlag) {",
  "    $flagAge = (Get-Date) - (Get-Item -LiteralPath $restartFlag).LastWriteTime",
  "    if ($flagAge.TotalSeconds -ge 0 -and $flagAge.TotalSeconds -lt 45) { exit 0 }",
  "    Remove-Item -LiteralPath $restartFlag -Force -ErrorAction SilentlyContinue",
  "  }",
  "  $holding = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { try { $_.Path -eq $ExePath } catch { $false } })",
  "  if ($holding.Count -gt 0) { Start-Sleep -Milliseconds 500; continue }",
  "  if (-not (Test-Path -LiteralPath $AsarPath)) {",
  "    Remove-Item -LiteralPath $LockPath -Force -ErrorAction SilentlyContinue",
  "    exit 0",
  "  }",
  "  $appDir = Join-Path (Split-Path -Parent $AsarPath) 'app'",
  "  $unpacked = $AsarPath + '.unpacked'",
  "  $marker = Join-Path $appDir 'dsh\\node_modules\\node-addon-require-builtin-win32-x64-msvc\\prebuilt\\win32-x64-msvc-napi-v9.node'",
  "  if ((Test-Path -LiteralPath $unpacked) -and -not (Test-Path -LiteralPath $marker)) {",
  "    & robocopy.exe $unpacked $appDir /E /XC /XN /XO /NFL /NDL /NJH /NJS /nc /ns /np | Out-Null",
  "  }",
  "  $bak = \"$AsarPath.bak\"",
  "  if (Test-Path -LiteralPath $bak) { Remove-Item -LiteralPath $bak -Force -ErrorAction SilentlyContinue }",
  "  try {",
  "    Move-Item -LiteralPath $AsarPath -Destination $bak -Force -ErrorAction Stop",
  "  } catch {",
  "    Start-Sleep -Milliseconds 400",
  "    continue",
  "  }",
  "  Remove-Item -LiteralPath $LockPath -Force -ErrorAction SilentlyContinue",
  "  Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue",
  "  Start-Process -FilePath $ExePath",
  "  exit 0",
  "}",
  "Remove-Item -LiteralPath $LockPath -Force -ErrorAction SilentlyContinue",
  "",
].join("\r\n");

const ASAR_RENAME_WHEN_IDLE_SH = [
  "#!/bin/sh",
  "asar=$1",
  "exe=$2",
  "lock=$3",
  "deadline=$(($(date +%s) + 1800))",
  "relaunch() {",
  "  unset ELECTRON_RUN_AS_NODE",
  "  case \"$(uname -s)\" in",
  "    Darwin)",
  "      case \"$exe\" in",
  "        */Contents/MacOS/*)",
  "          bundle=$(dirname \"$(dirname \"$(dirname \"$exe\")\")\")",
  "          open \"$bundle\"",
  "          return",
  "          ;;",
  "      esac",
  "      ;;",
  "  esac",
  "  nohup \"$exe\" >/dev/null 2>&1 &",
  "}",
  "app_running() {",
  "  ps -Ao command= 2>/dev/null | grep -F \"$exe\" | grep -v \"dsh-purge-asar-rename-when-idle\" | grep -v grep >/dev/null",
  "}",
  "while [ \"$(date +%s)\" -lt \"$deadline\" ]; do",
  "  if [ ! -e \"$asar\" ]; then",
  "    rm -f \"$lock\"",
  "    exit 0",
  "  fi",
  "  if app_running; then",
  "    sleep 1",
  "    continue",
  "  fi",
  "  bak=\"$asar.bak\"",
  "  rm -f \"$bak\"",
  "  if mv \"$asar\" \"$bak\" 2>/dev/null; then",
  "    rm -f \"$lock\"",
  "    relaunch",
  "    exit 0",
  "  fi",
  "  sleep 1",
  "done",
  "rm -f \"$lock\"",
  "exit 1",
  "",
].join("\n");

/** 공식 셸이 떠 있는 동안 app.asar 가 점유된다. 프로세스를 끝내지 않고, 사용자가 종료한 뒤 이름을 바꾸고 다시 연다. */
export function scheduleAsarRenameWhenIdle({ exe, asar } = {}) {
  if (!exe || !asar) return { pending: false };
  const lock = `${asar}.rename-pending`;
  try {
    const age = Date.now() - fs.statSync(lock).mtimeMs;
    if (age >= 0 && age < 30 * 60 * 1000) return { pending: true, already: true };
    // age<0 은 시계 역행, age>=30min 은 stale 로 보고 무효 처리한 뒤 지우고 다시 한다.
    try { fs.unlinkSync(lock); } catch { /* ignore */ }
  } catch {
    // 대기 중인 마커가 없으면 아래에서 새로 만든다.
  }
  fs.writeFileSync(lock, `${Date.now()}\n`, "utf8");
  if (process.platform === "win32") {
    const script = path.join(os.tmpdir(), `dsh-purge-asar-rename-when-idle-${restartUniqSuffix()}.ps1`);
    fs.writeFileSync(script, ASAR_RENAME_WHEN_IDLE_PS1, "utf8");
    const child = spawn(
      "powershell.exe",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        script,
        "-AsarPath",
        asar,
        "-ExePath",
        exe,
        "-LockPath",
        lock,
      ],
      { detached: true, stdio: "ignore", windowsHide: true, shell: false },
    );
    // detached spawn 의 ENOENT / 권한 오류는 'error' 이벤트로 오며, 리스너가 없으면 uncaught → 프로세스 전체가 죽는다.
    child.on("error", (err) => {
      try { console.warn("[dsh-purge] asar rename idle PS1 spawn 실패:", err?.message || err); } catch { /* 무시 */ }
    });
    child.unref();
    return { pending: true };
  }
  const script = path.join(os.tmpdir(), `dsh-purge-asar-rename-when-idle-${restartUniqSuffix()}.sh`);
  fs.writeFileSync(script, ASAR_RENAME_WHEN_IDLE_SH, { encoding: "utf8", mode: 0o755 });
  const child = spawn("/bin/sh", [script, asar, exe, lock], {
    detached: true,
    stdio: "ignore",
    shell: false,
  });
  child.on("error", (err) => {
    try { console.warn("[dsh-purge] asar rename idle sh spawn 실패:", err?.message || err); } catch { /* 무시 */ }
  });
  child.unref();
  return { pending: true };
}

/** 현재 데스크톱 프로세스가 종료되면 app.asar 를 옮긴 뒤 exe 를 시작한다. 풀린 뒤의 resources/app 이 로드된다. */
export function scheduleAsarSwapRestart({ exe, asar, waitPid = process.pid, exit = false, runtime = null, ctx = null } = {}) {
  if (!exe || !asar) throw new Error("데스크톱 exe 또는 app.asar 가 없어 재시작할 수 없습니다");
  // 호출자가 runtime 을 명시로 넘기지 않았지만 ctx 는 넘겼다면 —— 여기서 한 번 해석한다.
  // 시작 단계 자가 복구 경로(index.js:scheduleApplyRestart / 2004 자가 복구 분기)가 ctx 를 전달하면 정상 핸드셰이크를 탄다.
  if (!runtime && ctx) {
    try { runtime = desktopRuntimeOf(ctx); } catch { /* ignore */ }
  }
  // #64 crash-dialog 근본 원인: 호스트 main.js:3725 ChildProcess listener 가 host 종료를
  // "host stopped" 로 보고 크래시 대화상자를 띄운다. 이중 안전장치:
  //   1) PowerShell 이 즉시 Stop-HarnessInstall (Electron main + host 를 죽임) 을 호출하면, Electron 은
  //      host 종료 이벤트를 보기 전에 kill 되어 UI 가 없으므로 crash dialog 를 띄울 수 없다.
  //   2) runtime.requestRestart 가 있으면 먼저 한 번 ack 해, 호스트에 "예정된 종료" 표시 창을 준다(있다면).
  // host 자신의 process.exit 는 마지막 폴백이다 —— 보통 PowerShell 에 먼저 kill 된다.
  const gracefulExit = () => {
    if (!runtime) {
      // runtime 이 없으면 —— 짧은 timeout 으로 PowerShell 이 시작을 마칠 시간을 준다(실측 ~200-500ms),
      // 그다음 스스로 종료한다. PowerShell 이 그 사이 Electron 을 죽이므로, host 가 스스로 종료하더라도
      // Electron 은 이미 없고, dialog 도 뜨지 않는다.
      logInternal("asar swap: no runtime handoff, relying on PowerShell to kill Electron first");
      setTimeout(() => { try { process.exit(0); } catch {} }, 1500);
      return;
    }
    logInternal("asar swap: handing off restart to desktopRuntime");
    try {
      // #64: requestRestart 가 "빈 반환" 일 수 있지만 부수 효과로 예정된 종료가 표시될 수도 있어, 이중 안전장치 중 하나다.
      Promise.resolve(runtime.requestRestart()).catch((err) => {
        logInternal("desktopRuntime.requestRestart rejected: " + (err?.message || err));
      });
    } catch (err) {
      logInternal("desktopRuntime.requestRestart threw: " + (err?.message || err));
    }
    // 2000ms 폴백: 호스트의 requestRestart 가 끝나고 PowerShell 이 시작을 마칠 시간을 준다.
    // 두 경로가 모두 실패해도 PowerShell 이 ~500ms 안에 Electron 을 kill 하므로 crash 는 뜨지 않는다.
    setTimeout(() => {
      try { process.exit(0); } catch {}
    }, 2000);
  };

  if (sealedSwapKind() === "helper") {
    const helper = fileURLToPath(new URL("./restart-desktop.js", import.meta.url));
    spawnHelper(helper, {
      respawn: true,
      killApp: true,
      asar,
      execPath: exe,
      cwd: path.dirname(exe),
      waitPid,
    }, { exit: false });
    if (exit !== false) gracefulExit();
    return { scheduled: true };
  }
  const script = path.join(os.tmpdir(), `dsh-purge-asar-swap-${process.pid}.ps1`);
  fs.writeFileSync(script, ASAR_SWAP_PS1, "utf8");
  const child = spawn(
    "powershell.exe",
    [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      script,
      "-WaitPid",
      String(waitPid),
      "-AsarPath",
      asar,
      "-ExePath",
      exe,
    ],
    { detached: true, stdio: "ignore", windowsHide: true, shell: false },
  );
  // 'error' listener 를 붙이지 않았으므로, PowerShell 이 PATH 에 없거나 AV 에 막히면 unhandled 'error' event 가 되고,
  // Node 가 uncaughtException 으로 처리해 호스트를 그대로 죽인다.
  child.on("error", (err) => {
    logInternal("asar swap PowerShell spawn failed: " + (err?.message || err));
  });
  child.unref();
  if (exit !== false) gracefulExit();
  return { scheduled: true };
}

/**
 * "적용" 을 누른 뒤 어느 재시작 경로를 타는가. #64: 호스트의 requestRestart 는 데스크톱 쪽에서 빈 반환을 하고 프로세스는 움직이지 않는다.
 * Windows 공식 패키지는 wscript 로 끝낸 뒤 다시 연다. Linux / macOS 는 exe 를 찾을 수 있으면 restart-desktop.js 를 탄다.
 */
export function desktopRestartChoice(input = {}) {
  const platform = input.platform || process.platform;
  const exe = input.exe || "";
  const desktopExe = Boolean(exe && isDesktopExecutable(exe));
  const official = Boolean(exe && isOfficialHarnessExecutable(exe));
  if (input.openBrowser === false) return "skip";
  if (platform === "win32" && official) return "windows-official";
  if (desktopExe && input.asarSealed === true) return "asar-swap";
  if (desktopExe) return "helper";
  if (input.hasRuntime) return "request-restart";
  return "helper";
}

/** 밀봉된 asar 는 프로세스를 먼저 종료해야 파일을 옮길 수 있다. Windows 는 PowerShell, Linux / macOS 는 같은 재시작 스크립트를 쓴다. */
export function sealedSwapKind(platform = process.platform) {
  return platform === "win32" ? "powershell" : "helper";
}

function officialExeFromProcess() {
  if (isOfficialHarnessExecutable(process.execPath) && isFile(process.execPath)) {
    return path.normalize(process.execPath);
  }
  const resources = process.resourcesPath;
  if (!resources) return "";
  const hit = firstExistingExe([path.dirname(path.normalize(resources))]);
  if (hit && isOfficialHarnessExecutable(hit)) return hit;
  return "";
}

function dshHomeForRelaunch() {
  const current = String(process.env.DSH_HOME || "").replace(/[\\/]+$/, "");
  if (!current) return "";
  if (current.toLowerCase().endsWith(".dsh")) return current;
  const nested = path.join(current, ".dsh");
  try {
    if (fs.existsSync(path.join(nested, "profiles"))) return nested;
  } catch {
    // 현재 값을 쓴다.
  }
  return current;
}

export function scheduleRestart(request, ctx, options = {}) {
  // 시작 자가 점검은 openBrowser:false 를 함께 넘긴다. 데스크톱 프로세스는 이제 그것 때문에 자신을 죽이지 않는다.
  if (options.openBrowser === false) return { restarting: false, skipped: true };
  const exe =
    officialExeFromProcess() ||
    findDesktopAppExecutable() ||
    "";
  const asar = exe ? appAsarPath(exe) : "";
  // ctx 를 restartOfficialHarness → scheduleAsarSwapRestart 로 전달해, PowerShell 분기가
  // desktopRuntime 을 받아 requestRestart 로 정상 종료하도록 해, 호스트가 crash 로 잘못 보고하지 않게 한다.
  if (process.platform === "win32" && exe && isOfficialHarnessExecutable(exe)) {
    return restartOfficialHarness({ exe, asar, ctx });
  }
  if (exe && asar && asarArchiveIsFile(asar)) {
    const runtime = desktopRuntimeOf(ctx);
    scheduleAsarSwapRestart({ exe, asar, waitPid: process.pid, exit: true, runtime });
    return { restarting: true, asarSwap: true };
  }
  const runtime = desktopRuntimeOf(ctx);
  const choice = desktopRestartChoice({
    exe,
    asarSealed: false,
    hasRuntime: Boolean(runtime),
  });
  if (choice === "helper" && exe && isDesktopExecutable(exe)) {
    const helper = fileURLToPath(new URL("./restart-desktop.js", import.meta.url));
    try {
      spawnHelper(helper, {
        respawn: true,
        killApp: true,
        execPath: exe,
        cwd: path.dirname(exe),
      }, { exit: false });
    } catch (error) {
      return {
        restarting: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    return { restarting: true };
  }
  if (runtime) {
    // 데스크톱 앱 전체 relaunch 만 탄다. Host 를 exit 하면 안 된다(그러면 내장 web 이 따로 먼저 뜬다).
    Promise.resolve(runtime.requestRestart()).catch((err) => {
      logInternal("desktop requestRestart failed: " + (err?.message || err));
    });
    return { restarting: true };
  }
  const helper = fileURLToPath(new URL("./restart-desktop.js", import.meta.url));
  spawnHelper(helper, { respawn: true, killApp: true }, { exit: false });
  return { restarting: true };
}

function jsString(value) {
  return wshLiteral(value);
}

function officialRestartScript(exe, asar, dshHome) {
  const log = path.join(os.tmpdir(), "dsh-purge-official-restart.log");
  return [
    "var exe = " + jsString(exe) + ";",
    "var asar = " + jsString(asar) + ";",
    "var home = " + jsString(dshHome || "") + ";",
    "var logPath = " + jsString(log) + ";",
    "var fso = new ActiveXObject('Scripting.FileSystemObject');",
    "var sh = new ActiveXObject('WScript.Shell');",
    "var wmi = GetObject('winmgmts:\\\\\\\\.\\\\root\\\\cimv2');",
    "function z(n) { return (n < 10 ? '0' : '') + n; }",
    "function stamp() { var d = new Date(); return d.getFullYear() + '-' + z(d.getMonth() + 1) + '-' + z(d.getDate()) + 'T' + z(d.getHours()) + ':' + z(d.getMinutes()) + ':' + z(d.getSeconds()); }",
    "function log(m) { var f = fso.OpenTextFile(logPath, 8, true); f.WriteLine(stamp() + ' ' + m); f.Close(); }",
    "function samePath(a, b) { return String(a || '').replace(/\\//g, '\\\\').toLowerCase() === String(b || '').replace(/\\//g, '\\\\').toLowerCase(); }",
    "function installRoot() { return fso.GetParentFolderName(exe); }",
    "function pids() { var out = []; var root = String(installRoot() || '').replace(/\\//g, '\\\\').toLowerCase(); var e = new Enumerator(wmi.ExecQuery(\"SELECT ProcessId, ExecutablePath FROM Win32_Process WHERE Name = 'DeepSeek Harness.exe'\")); for (; !e.atEnd(); e.moveNext()) { var p = e.item(); var ep = String(p.ExecutablePath || '').replace(/\\//g, '\\\\').toLowerCase(); if (samePath(p.ExecutablePath, exe) || (root && ep.indexOf(root) === 0)) out.push(p.ProcessId); } return out; }",
    "log('begin');",
    "var promptFile = asar.replace(/app\\.asar$/i, 'app') + '\\\\dsh\\\\node_modules\\\\@deepseek-ai\\\\dsh-system-prompt\\\\lib\\\\index.js';",
    "var altFile = asar.replace(/app\\.asar$/i, 'app') + '\\\\node_modules\\\\@deepseek-ai\\\\dsh-system-prompt\\\\lib\\\\index.js';",
    "function readBody(file) { if (!fso.FileExists(file)) return ''; var tf = fso.OpenTextFile(file, 1); var body = tf.ReadAll(); tf.Close(); return body; }",
    "function hostClean(body) { if (!body) return null; var ident = body.indexOf('[dsh-purge] identity stripped') >= 0; var kept = body.indexOf('[dsh-purge] complete prompt keeps waterfall inject') >= 0 || body.indexOf('[dsh-purge] complete prompt keeps inject') >= 0; if (ident && kept) return true; if (body.indexOf('system-prompt/assemble') < 0) return false; var identityLeft = body.indexOf('You are an AI agent powered by DeepSeek Harness.') >= 0; var drops = body.indexOf('transformed.sections : [completeSection]') >= 0; return !identityLeft && !drops; }",
    "var clean = false;",
    "var primary = hostClean(readBody(promptFile));",
    "var alt = hostClean(readBody(altFile));",
    "// null = 파일이 없거나 아직 판단할 수 없음(첫 설치, 읽기 실패). 이때는 시작을 막지 않는다; 어느 하나라도 명확히 false (실제로 더러움)일 때만 막는다.",
    "clean = primary != false && alt != false;",
    "if (!clean) { log('clean markers missing; not starting'); try { if (fso.FileExists(" + jsString(path.join(os.tmpdir(), "dsh-purge-official-restarting")) + ")) fso.DeleteFile(" + jsString(path.join(os.tmpdir(), "dsh-purge-official-restarting")) + ", true); } catch (ignoreStop) {} WScript.Quit(1); }",
    "if (clean) {",
    "log('clean markers ok');",
    "WScript.Sleep(800);",
    "var list = pids();",
    "log('pids ' + list.join(','));",
    "for (var i = 0; i < list.length; i++) sh.Run('taskkill.exe /F /PID ' + list[i], 0, true);",
    "// 더 이상 /IM 전체 이름으로 죽이지 않아, 같은 이름의 서드파티를 잘못 건드리지 않는다. 타임아웃 후에는 pid 목록으로 다시 실행한다.",
    "var deadline = new Date().getTime() + 20000;",
    "var left = list;",
    "while (new Date().getTime() < deadline) { left = pids(); if (left.length === 0) break; WScript.Sleep(200); }",
    "log('left ' + left.length);",
    "var unpacked = asar + '.unpacked';",
    "var appDir = asar.replace(/app\\.asar$/i, 'app');",
    "var marker = appDir + '\\\\dsh\\\\node_modules\\\\node-addon-require-builtin-win32-x64-msvc\\\\prebuilt\\\\win32-x64-msvc-napi-v9.node';",
    "if (fso.FolderExists(unpacked) && !fso.FileExists(marker)) { sh.Run('robocopy.exe \"' + unpacked + '\" \"' + appDir + '\" /E /XC /XN /XO /NFL /NDL /NJH /NJS /nc /ns /np', 0, true); log('overlay'); }",
    "var renamed = false;",
    "if (!fso.FileExists(asar)) { renamed = true; log('asar already absent'); }",
    "if (fso.FileExists(asar)) { var bak = asar + '.bak'; if (fso.FileExists(bak)) fso.DeleteFile(bak, true); for (var n = 0; n < 80; n++) { try { fso.MoveFile(asar, bak); renamed = true; log('renamed'); break; } catch (err) { log(err && err.message ? err.message : String(err)); if (n === 20 || n === 50) { var hold = pids(); for (var k = 0; k < hold.length; k++) sh.Run('taskkill.exe /F /PID ' + hold[k], 0, true); WScript.Sleep(800); } WScript.Sleep(300); } } }",
    "if (!renamed) { log('rename failed; not starting'); try { if (fso.FileExists(" + jsString(path.join(os.tmpdir(), "dsh-purge-official-restarting")) + ")) fso.DeleteFile(" + jsString(path.join(os.tmpdir(), "dsh-purge-official-restarting")) + ", true); } catch (ignoreStop2) {} WScript.Quit(1); }",
    "if (renamed) {",
    "try { sh.Environment('PROCESS').Remove('ELECTRON_RUN_AS_NODE'); } catch (ignore) {}",
    "try { sh.Environment('PROCESS').Remove('DSH_BASE'); } catch (ignoreBase) {}",
    "if (home) { try { sh.Environment('PROCESS').Item('DSH_HOME') = home; } catch (ignore2) {} }",
    "sh.Run('\"' + exe + '\"', 1, false);",
    "log('started');",
    "}",
    "}",
    // Keep the inflight window just long enough to cover a cold client start;
    // the original 180s left the panel unresponsive for 3 minutes after every restart.
    "WScript.Sleep(45000);",
    "try { if (fso.FileExists(" + jsString(path.join(os.tmpdir(), "dsh-purge-official-restarting")) + ")) fso.DeleteFile(" + jsString(path.join(os.tmpdir(), "dsh-purge-official-restarting")) + ", true); } catch (ignoreFlag) {}",
    "",
  ].join("\r\n");
}

function systemPromptFiles(exe) {
  const appDir = appDirForExecutable(exe);
  if (!appDir) return [];
  return [
    path.join(appDir, "dsh", "node_modules", "@deepseek-ai", "dsh-system-prompt", "lib", "index.js"),
    path.join(appDir, "node_modules", "@deepseek-ai", "dsh-system-prompt", "lib", "index.js"),
  ].filter((fp) => {
    try { return fs.existsSync(fp); } catch { return false; }
  });
}

function unpackedHostIsClean(exe) {
  const files = systemPromptFiles(exe);
  if (files.length === 0) return false;
  return files.every((fp) => {
    try {
      return hostPromptKeepsInject(fs.readFileSync(fp, "utf8"));
    } catch {
      return false;
    }
  });
}

const OFFICIAL_RESTART_FLAG = "dsh-purge-official-restarting";
const OFFICIAL_RESTART_WINDOW_MS = 45000;

/**
 * Windows 공식 패키지 교체는 어느 경로로 가는가.
 * 이 PC 의 wscript 가 .js 를 실행할 수 있으면 기존 스크립트를 그대로 쓴다. 실행할 수 없으면(클라우드의 많은 머신에는 JScript 엔진이 없다)
 * 이미 쓰고 있는 PowerShell 로 바꾼다. 스크립트가 이미 시작된 것을 확인하지 않으면 진행 중 마커를 성공으로 보지 않는다.
 */
export function planOfficialRestart({ wshJs, scriptAscii, inflightAgeMs, logStarted, logState } = {}) {
  const age = Number(inflightAgeMs);
  const fresh = Number.isFinite(age) && age >= 0 && age < OFFICIAL_RESTART_WINDOW_MS;
  const state = logState || (logStarted === true ? "running" : "none");
  // 스크립트가 현재 프로세스를 끝내는 중일 때만 진행 중으로 본다. begin 을 썼다가 멈춘 경우에는 이번 클릭에서 다시 시작해야 한다.
  if (fresh && state === "running") return { action: "already" };
  const kind = wshJs === true && scriptAscii !== false ? "wscript" : "powershell";
  return {
    action: "start",
    kind,
    writeInflight: kind === "wscript",
    clearInflight: kind !== "wscript",
  };
}

function officialRestartFlagPath() {
  return path.join(os.tmpdir(), OFFICIAL_RESTART_FLAG);
}

function officialRestartLogState(sinceMs) {
  try {
    const log = path.join(os.tmpdir(), "dsh-purge-official-restart.log");
    const st = fs.statSync(log);
    if (sinceMs && st.mtimeMs + 1000 < sinceMs) return "none";
    const lines = fs.readFileSync(log, "utf8").split(/\r?\n/).filter(Boolean);
    let begin = -1;
    for (let i = 0; i < lines.length; i++) {
      if (/(^|\s)begin$/.test(lines[i])) begin = i;
    }
    if (begin < 0) return "none";
    const tail = lines.slice(begin);
    if (tail.some((line) => /not starting|rename failed/.test(line))) return "aborted";
    if (tail.some((line) => /(^|\s)started$/.test(line))) return "done";
    return "running";
  } catch {
    return "none";
  }
}

let wshJsEngineCached;
function wshJsEngineWorks() {
  if (wshJsEngineCached !== undefined) return wshJsEngineCached;
  wshJsEngineCached = probeWshJsEngine();
  return wshJsEngineCached;
}

function probeWshJsEngine() {
  const id = `${process.pid}-${Date.now()}`;
  const script = path.join(os.tmpdir(), `dsh-purge-wsh-probe-${id}.js`);
  const out = path.join(os.tmpdir(), `dsh-purge-wsh-probe-${id}.txt`);
  try {
    const body = "var fso=new ActiveXObject('Scripting.FileSystemObject');var f=fso.CreateTextFile("
      + wshLiteral(out)
      + ", true);f.WriteLine('ok');f.Close();\r\n";
    fs.writeFileSync(script, body, "utf8");
    execFileSync("cscript.exe", ["//nologo", script], {
      timeout: 4000,
      windowsHide: true,
      stdio: "ignore",
    });
    return fs.existsSync(out);
  } catch {
    return false;
  } finally {
    try { fs.unlinkSync(script); } catch { /* 프로브는 쓰고 바로 삭제 */ }
    try { fs.unlinkSync(out); } catch { /* 프로브는 쓰고 바로 삭제 */ }
  }
}

/** "재시작" 을 누르면 현재 공식 클라이언트를 끝내고, 점유된 app.asar 를 옮긴 뒤 스스로 다시 연다. */
export function restartOfficialHarness(options = {}) {
  const hinted = options.exe ? path.normalize(String(options.exe)) : "";
  const exe =
    (hinted && isDesktopExecutable(hinted) ? hinted : "") ||
    officialExeFromProcess() ||
    findDesktopAppExecutable() ||
    "";
  if (!exe) return { restarting: false };
  // ctx 를 쓸 수 있으면 → desktopRuntime 을 받아 PowerShell 분기로 전달한다:
  // 호스트가 예정된 restart 를 ack 하게 해, host 종료가 crash 로 오인되어 대화상자가 뜨는 것을 막는다.
  const runtime = options.runtime || (options.ctx ? desktopRuntimeOf(options.ctx) : null);
  if (!isOfficialHarnessExecutable(exe)) {
    const asar = options.asar || appAsarPath(exe);
    if (asar && asarArchiveIsFile(asar)) {
      scheduleAsarSwapRestart({
        exe,
        asar,
        waitPid: process.pid,
        exit: options.exit !== false,
        runtime,
      });
      return { restarting: true, asarSwap: true };
    }
    return { restarting: false };
  }
  // #57: 공식 installer 를 자동으로 실행하지 않는다. 호스트 버전이 제각각이라 업데이트 인계는 사용자가 직접 한다;
  // 플러그인은 풀기/패치만 담당한다. 구 로직은 기록 전에 실패로 오판해 resources\app 를 지웠다.
  if (options.requireClean !== false && !unpackedHostIsClean(exe)) {
    return { restarting: false, clean: false };
  }
  const inflight = officialRestartFlagPath();
  let inflightAgeMs = -1;
  let inflightMtime = 0;
  try {
    const st = fs.statSync(inflight);
    inflightAgeMs = Date.now() - st.mtimeMs;
    inflightMtime = st.mtimeMs;
  } catch {
    // 진행 중인 재시작이 없다.
  }
  const asar = options.asar || appAsarPath(exe);
  const restartBody = officialRestartScript(exe, asar, dshHomeForRelaunch());
  const scriptAscii = isWshAscii(restartBody);
  const plan = planOfficialRestart({
    wshJs: scriptAscii && wshJsEngineWorks(),
    scriptAscii,
    inflightAgeMs,
    logState: officialRestartLogState(inflightMtime),
  });
  if (plan.action === "already") return { restarting: true, already: true };
  if (plan.clearInflight) {
    try { fs.unlinkSync(inflight); } catch { /* 남은 마커 없음 */ }
  }
  if (plan.kind === "powershell") {
    // [dsh-purge-fix 2026-10-09] asar 가 이미 옮겨졌다(unpacked 모드의 일상 상태):
    // ASAR_SWAP_PS1 의 fs.rename asar 는 ENOENT 가 나고, restarting:false 를 반환하면 UI 에
    // "실패: not started" 가 표시된다. helper restart-desktop.js: 그 안의 moveAsarAsideAsync
    // 자체가 asar=null 을 처리하며(283번째 줄에서 fs.existsSync 가 없으면 곧바로 return true),
    // relaunchDesktop 은 execPath spawn 으로 깔끔하게 kill+relaunch 하고, asar swap 은 하지 않는다.
    if (!asar || !asarArchiveIsFile(asar)) {
      logInternal("asar 가 이미 없음(unpacked 모드). helper kill+relaunch 로 전환합니다");
      try {
        const helper = fileURLToPath(new URL("./restart-desktop.js", import.meta.url));
        spawnHelper(helper, {
          respawn: true,
          killApp: true,
          asar: null,
          execPath: exe,
          cwd: path.dirname(exe),
          waitPid: process.pid,
        }, { exit: options.exit !== false });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logInternal("unpacked helper restart failed: " + message);
        return { restarting: false, error: message };
      }
      return { restarting: true, mode: "unpacked-helper", engine: "helper" };
    }
    logInternal("wscript 는 .js 를 실행할 수 없어 PowerShell 로 app.asar 를 옮깁니다");
    try {
      scheduleAsarSwapRestart({
        exe,
        asar,
        waitPid: process.pid,
        exit: options.exit !== false,
        runtime,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logInternal("PowerShell asar swap failed: " + message);
      return { restarting: false, error: message };
    }
    return { restarting: true, asarSwap: true, engine: "powershell" };
  }
  if (plan.writeInflight) {
    try { fs.writeFileSync(inflight, `${Date.now()}\n`, "utf8"); } catch { /* 마커 쓰기가 실패해도 이번 한 번은 계속 진행 */ }
  }
  const asarPresent = Boolean(asar && asarArchiveIsFile(asar));
  const swapLock = asar ? `${asar}.swap-lock` : "";
  if (asarPresent && swapLock) {
    try {
      const lockStat = fs.statSync(swapLock);
      const age = Date.now() - lockStat.mtimeMs;
      // 잠금은 남아 있는데 재시작 로그에 begin 이 없으면: 이전 wscript 가 실행되지 않은 것이므로 진행 중 교체로 보면 안 된다.
      if (age >= 0 && age < 90 * 1000 && officialRestartLogState(lockStat.mtimeMs) === "running") {
        return { restarting: true, already: true, asarSwap: true };
      }
    } catch {
      // 진행 중인 교체가 없다.
    }
    try { fs.writeFileSync(swapLock, `${Date.now()}\n`, "utf8"); } catch {}
  }
  // 시작 시 남은 구 restart 스크립트/로그를 한 번 정리한다. 다중 인스턴스에서는 스크립트 이름에 pid+random 을 써서 충돌을 피한다.
  cleanupLegacyRestartScripts();
  const script = path.join(os.tmpdir(), `dsh-purge-official-restart-${restartUniqSuffix()}.js`);
  fs.writeFileSync(script, restartBody, "utf8");
  // wscript.exe 를 직접 실행하고 .cmd 중개 파일은 만들지 않아, 경로에 공백/따옴표가 있을 때의 파싱 이상을 피한다.
  const child = spawn("wscript.exe", ["//nologo", "//B", script], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    shell: false,
  });
  child.unref();
  return { restarting: true, engine: "wscript" };
}

export function scheduleCleanupRestart({ cleanup = [], ctx } = {}) {
  const src = fileURLToPath(new URL("./restart-desktop.js", import.meta.url));
  const dest = path.join(os.tmpdir(), `dsh-purge-uninst-${process.pid}.mjs`);
  fs.copyFileSync(src, dest);
  const runtime = desktopRuntimeOf(ctx);
  if (runtime) {
    spawnHelper(dest, { cleanup, helper: dest, respawn: false }, { exit: false });
    Promise.resolve(runtime.requestRestart()).catch((err) => {
      logInternal("desktop uninstall restart failed: " + (err?.message || err));
    });
    return { restarting: true };
  }
  spawnHelper(dest, { cleanup, helper: dest, respawn: true, killApp: true }, { exit: false });
  return { restarting: true };
}

const CLI_ENTRY_BEGIN = "# dsh-purge cli entry begin";
const CLI_ENTRY_END = "# dsh-purge cli entry end";
const CLI_ASAR_ENTRY = "app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js";
// #94: 공식 데스크톱 버전은 dsh host 를 app.asar.unpacked 에 둔다(isAiBase 의 app.asar.unpacked 분기 참고),
// 패키징된 app.asar 안이 아니다. 그런데 stock 시작 스크립트는 app.asar/.../cli.js 로 하드코딩되어 → Cannot find module 오류가 난다.
// 폴백 체인은 반드시 app.asar → app.asar.unpacked → app/ 이어야 하고, 가운데 단계가 없으면 macOS 에서 개봉 즉시 깨진다.
const CLI_UNPACKED_ENTRY = "app.asar.unpacked/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js";
const CLI_DIR_ENTRY = "app/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js";

function ensureAppRuntimeSymlink(resources) {
  const appDir = path.join(resources, "app");
  const runtime = path.join(resources, "runtime");
  const link = path.join(appDir, "runtime");
  if (!isDir(appDir) || !isDir(runtime)) return { ok: false, reason: "missing" };
  try {
    if (fs.existsSync(link)) {
      const st = fs.lstatSync(link);
      if (st.isSymbolicLink() || st.isDirectory()) return { ok: true, already: true };
    }
  } catch {
    // create below
  }
  try {
    try {
      fs.rmSync(link, { recursive: true, force: true });
    } catch {
      // ignore
    }
    if (process.platform === "win32") {
      fs.symlinkSync("..\\runtime", link, "junction");
      return { ok: true, created: true, type: "junction" };
    }
    fs.symlinkSync("../runtime", link, "dir");
    return { ok: true, created: true, type: "dir" };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
}

function stripShimEntryBlock(text) {
  return text.replace(/# dsh-purge cli entry begin[\s\S]*?# dsh-purge cli entry end\r?\n?/g, "");
}

/** 官方 CLI 启动脚本是否已经补过入口回退块。桌面端修的是这个,不是 "dsh-purge shim" 注入。 */
export function desktopCliEntryPatched(fp) {
  if (!isFile(fp)) return false;
  try {
    return fs.readFileSync(fp, "utf8").includes("dsh-purge cli entry");
  } catch {
    return false;
  }
}

function patchOfficialCliShimText(text) {
  if (!text) return { changed: false, text };
  // 구버전이 이미 "$entry" 로 바꿔 asar 원문은 사라졌지만 BEGIN 마커는 남아 있다면 → 이 경우에도 들어와 3단계 폴백으로 업그레이드한다.
  if (!text.includes(CLI_ASAR_ENTRY) && !text.includes(CLI_ENTRY_BEGIN)) return { changed: false, text };

  // 먼저 구 블록(2단계 폴백일 수 있음)을 걷어내고, 그다음 나체 asar 경로를 "$entry" 로 정규화하고, 마지막에 최신 3단계 블록을 삽입해 멱등 업그레이드를 보장한다.
  let next = stripShimEntryBlock(text);
  next = next.replace(
    /"\$resources\/app\.asar\/dsh\/node_modules\/@deepseek-ai\/dsh-desktop-host\/lib\/cli\.js"/g,
    '"$entry"',
  );
  next = next.replace(
    /\$resources\/app\.asar\/dsh\/node_modules\/@deepseek-ai\/dsh-desktop-host\/lib\/cli\.js/g,
    '"$entry"',
  );
  if (!next.includes('"$entry"')) return { changed: false, text };

  const block = [
    CLI_ENTRY_BEGIN,
    `entry="$resources/${CLI_ASAR_ENTRY}"`,
    `if [ ! -f "$entry" ]; then entry="$resources/${CLI_UNPACKED_ENTRY}"; fi`,
    `if [ ! -f "$entry" ]; then entry="$resources/${CLI_DIR_ENTRY}"; fi`,
    CLI_ENTRY_END,
    "",
  ].join("\n");
  const insertAt = next.search(/ELECTRON_RUN_AS_NODE=1/);
  if (insertAt >= 0) {
    // 그 줄의 행두에 삽입해 `export ELECTRON_RUN_AS_NODE=1` 을 중간에서 쪼개지 않게 한다.
    const lineStart = next.lastIndexOf("\n", insertAt) + 1;
    next = `${next.slice(0, lineStart)}${block}${next.slice(lineStart)}`;
  } else {
    next = `${block}${next}`;
  }

  if (next === text) return { changed: false, text, already: true };
  return { changed: true, text: next };
}

const CMD_ENTRY_BEGIN = "REM dsh-purge cli entry begin";
const CMD_ENTRY_END = "REM dsh-purge cli entry end";
const CMD_CLI_TAIL = "dsh\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\cli.js";

function cmdEntryAlreadyGood(text) {
  if (!text.includes(CMD_ENTRY_BEGIN) || !text.includes(CMD_ENTRY_END)) return false;
  if (/set\s+"entry=%entry%"/i.test(text)) return false;
  if (!/set\s+"entry=%~dp0[^"\r\n]*app\.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\cli\.js"/i.test(text)) return false;
  // #94: app.asar.unpacked 단계 폴백이 반드시 있어야 하며, 없으면 구 블록으로 보고 강제 업그레이드한다.
  if (!/if not exist "%entry%" set "entry=%~dp0[^"\r\n]*app\.asar\.unpacked\\dsh\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\cli\.js"/i.test(text)) return false;
  if (!/if not exist "%entry%" set "entry=%~dp0[^"\r\n]*app\\dsh\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\cli\.js"/i.test(text)) return false;
  const outside = text.replace(/set\s+"entry=[^"]*"/gi, "");
  if (/app\.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\cli\.js/i.test(outside)) return false;
  return /"%entry%"/.test(text);
}

function stripCmdEntryBlock(text) {
  return text.replace(/\r?\n?REM dsh-purge cli entry begin[\s\S]*?REM dsh-purge cli entry end\r?\n?/gi, "\r\n");
}

function replaceQuotedInsensitive(text, pathValue, replacement) {
  const needle = `"${pathValue}"`;
  const lower = text.toLowerCase();
  const want = needle.toLowerCase();
  let out = "";
  let i = 0;
  while (i < text.length) {
    const at = lower.indexOf(want, i);
    if (at < 0) {
      out += text.slice(i);
      break;
    }
    out += text.slice(i, at) + replacement;
    i = at + needle.length;
  }
  return out;
}

/** Windows 공식 dsh.cmd 는 %~dp0 를 쓰고 %resources% 는 없다. 먼저 원문을 고친 뒤 폴백을 삽입해, 정규식이 방금 삽입한 줄까지 건드리지 않게 한다. */
export function patchOfficialCliCmdText(text) {
  if (!text) return { changed: false, text };
  const hasAsar = text.toLowerCase().includes("app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\cli.js")
    || text.includes(CLI_ASAR_ENTRY);
  const hasMarker = text.includes(CMD_ENTRY_BEGIN);
  if (!hasAsar && !hasMarker) return { changed: false, text };
  if (cmdEntryAlreadyGood(text)) return { changed: false, text, already: true };

  const nl = text.includes("\r\n") ? "\r\n" : "\n";
  // 먼저 원문(구 블록의 set 줄 포함)에서 %~dp0 접두사를 얻어, 2단계 구 블록도 3단계로 업그레이드되게 한다.
  const found = text.match(/%~dp0[^"\r\n]*?app\.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\cli\.js/i);
  if (!found) return { changed: false, text };
  const cut = found[0].toLowerCase().indexOf("app.asar\\");
  if (cut < 0) return { changed: false, text };
  const prefix = found[0].slice(0, cut);
  let next = stripCmdEntryBlock(text);
  next = replaceQuotedInsensitive(next, `${prefix}app.asar\\${CMD_CLI_TAIL}`, '"%entry%"');
  next = replaceQuotedInsensitive(next, `${prefix}app.asar.unpacked\\${CMD_CLI_TAIL}`, '"%entry%"');
  next = replaceQuotedInsensitive(next, `${prefix}app\\${CMD_CLI_TAIL}`, '"%entry%"');
  const block = [
    CMD_ENTRY_BEGIN,
    `set "entry=${prefix}app.asar\\${CMD_CLI_TAIL}"`,
    `if not exist "%entry%" set "entry=${prefix}app.asar.unpacked\\${CMD_CLI_TAIL}"`,
    `if not exist "%entry%" set "entry=${prefix}app\\${CMD_CLI_TAIL}"`,
    CMD_ENTRY_END,
    "",
  ].join(nl);
  const insertAt = next.search(/ELECTRON_RUN_AS_NODE=1/);
  if (insertAt >= 0) {
    const lineEnd = next.indexOf("\n", insertAt);
    const at = lineEnd >= 0 ? lineEnd + 1 : next.length;
    next = `${next.slice(0, at)}${block}${next.slice(at)}`;
  } else {
    next = block + next;
  }
  if (/set\s+"entry=%entry%"/i.test(next)) return { changed: false, text };
  if (!/"%entry%"/.test(next)) return { changed: false, text };
  if (!cmdEntryAlreadyGood(next)) return { changed: false, text };
  return { changed: next !== text, text: next };
}

/** app.asar 를 풀어낸 뒤 공식 CLI 를 패치한다: 진입점을 app/ 으로 폴백하고 app/runtime → ../runtime 을 보충한다. */
export function repairOfficialCliAfterUnpack(exe = findDesktopAppExecutable()) {
  if (!exe || !isOfficialHarnessExecutable(exe)) return { ok: false, reason: "not_official" };
  const resources = resourcesDirForExecutable(exe);
  if (!resources || !isDir(resources)) return { ok: false, reason: "no_resources" };
  const report = { ok: true, resources, symlink: null, shims: [] };
  report.symlink = ensureAppRuntimeSymlink(resources);
  const shimPaths = [
    path.join(resources, "runtime", "cli", "bin", "dsh"),
    path.join(resources, "runtime", "cli", "bin", "dsh.cmd"),
  ];
  for (const fp of shimPaths) {
    if (!isFile(fp)) {
      report.shims.push({ path: fp, status: "missing" });
      continue;
    }
    let text = "";
    try {
      text = fs.readFileSync(fp, "utf8");
    } catch (e) {
      report.shims.push({ path: fp, status: "read_error", error: String(e && e.message ? e.message : e) });
      continue;
    }
    const patched = fp.toLowerCase().endsWith(".cmd")
      ? patchOfficialCliCmdText(text)
      : patchOfficialCliShimText(text);
    if (!patched.changed) {
      report.shims.push({ path: fp, status: patched.already ? "already" : "skipped" });
      continue;
    }
    try {
      // 원자적 쓰기 전에 .dsh-purge.bak 을 한 부 남겨, 정전/디스크 가득 참에도 공식 원문으로 되돌릴 수 있게 한다.
      const bak = `${fp}.dsh-purge.bak`;
      if (!isFile(bak)) {
        try { atomicCopyFileSync(fp, bak); } catch { /* bak 을 쓰지 못해도 치명적이지 않음 */ }
      }
      atomicWriteSync(fp, patched.text, "utf8");
      // 启动脚本必须可执行。官方发的是 0755,一旦被写成 0644,`dsh` 就再也起不来。
      // 原子写只保留原权限,权限已经丢过一次的情况下要显式补回来。
      if (!fp.toLowerCase().endsWith(".cmd")) {
        try { fs.chmodSync(fp, 0o755); } catch { /* 补不上不算这次修补失败 */ }
      }
      report.shims.push({ path: fp, status: "patched" });
    } catch (e) {
      report.shims.push({ path: fp, status: "write_error", error: String(e && e.message ? e.message : e) });
    }
  }
  return report;
}
