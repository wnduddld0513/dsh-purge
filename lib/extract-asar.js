import nodeFs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

let cachedDiskFs;

/**
 * 실제 디스크 위의 fs 를 가리킨다.
 * Electron 내장 fs 는 `resources/app` 을 아직 남아 있는 `app.asar` 로 매핑한다,
 * 그 안에 새 파일을 만들면 ENOENT 가 난다. 디렉터리를 풀 때, 그리고 아카이브가 남아 있을 때 패치할 때 이 경로를 쓴다.
 * Electron 이 아닌 환경에는 original-fs 가 없으므로 node:fs 로 물러난다.
 */
export function diskFs() {
  if (cachedDiskFs) return cachedDiskFs;
  process.noDeprecation = true;
  try {
    cachedDiskFs = createRequire(import.meta.url)("original-fs");
  } catch {
    cachedDiskFs = nodeFs;
  }
  return cachedDiskFs;
}

/**
 * asar 판정 캐시(기동 성능 수정 / F14 + F17).
 *
 * `asarShadowsPath()` 는 호출될 때마다 최대 12 계층을 위로 탐색하고, 계층마다 original-fs 시스템 콜을 1~2 회 부른다,
 * 그래서 hostFs 를 거치는 **매번의** 호출이 약 25 회의 시스템 콜이 된다. 실측:
 *   - findAiBaseWeb 의 폴백 디렉터리 스캔 6 만 개 디렉터리: 순수 node:fs 6.2 s → 이 계층을 거치면 94 s;
 *   - 폴백 스캔을 고친 뒤에도, 남은 모듈 로딩 구간에서 이 프로브 자체가 여전히 호스트 기동 CPU 의 24% 를 차지한다
 *     (4117 ms / 17226 ms).
 *
 * 캐시는 두 단계로 나뉜다:
 *   1) 영속 단계: 5 s 생존 기간. hostFs 를 거치는 **쓰기 작업** 이 한 번이라도 있으면 즉시 비운다; 플러그인이 직접 app.asar 를 옮기는
 *      함수들(renameAsarAside / extractAsarToSide / commitExtractedDir / …)도 명시적으로 비운다.
 *      프로세스 밖의 공식 업데이터가 app.asar 를 교체하는 경우는 5 s 생존 기간이 폴백으로 받쳐 주고, 공식 업데이트 후에는 원래 호스트도 재시작된다.
 *   2) 스코프 단계: withFsProbeCache() 로 명시적으로 열고 닫는 강한 캐시. 스코프 안에서는 파일 시스템을 바꾸지 않는다,
 *      디렉터리 재귀 스캔처럼 십만 번 호출이 몰리는 일회성 버스트에 쓴다.
 */

const PROBE_TTL_MS = 5000;
const PROBE_MAX_ENTRIES = 400000;

let probePersist = null;
let probePersistEpoch = 0;
let probeScope = null;

/** asar 판정 캐시를 전부 버린다. app.asar 를 바꿀 수 있는 작업 뒤에는 반드시 호출해야 한다. */
export function invalidateAsarProbes() {
  probePersist = new Map();
  probePersistEpoch = Date.now();
}

function activeProbes() {
  if (probeScope) return probeScope;
  const now = Date.now();
  if (!probePersist || now - probePersistEpoch >= PROBE_TTL_MS) invalidateAsarProbes();
  return probePersist;
}

/** 주어진 동기 함수 안에서 강한 캐시를 켠다(스코프 안에서 파일 시스템을 바꾸면 안 된다). 재진입 가능. */
export function withFsProbeCache(fn) {
  if (probeScope) return fn();
  probeScope = new Map();
  try {
    return fn();
  } finally {
    probeScope = null;
  }
}

function probeKey(kind, p) {
  return kind + String(p).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

function probeAsarFileIn(dir) {
  try {
    const asar = path.join(dir, "app.asar");
    return diskFs().existsSync(asar) && diskFs().statSync(asar).isFile();
  } catch {
    return false;
  }
}

function asarFileIn(dir) {
  if (!dir) return false;
  const cache = activeProbes();
  const k = probeKey("f:", dir);
  const hit = cache.get(k);
  if (hit !== undefined) return hit;
  const v = probeAsarFileIn(dir);
  if (cache.size < PROBE_MAX_ENTRIES) cache.set(k, v);
  return v;
}

function computeAsarShadows(raw) {
  let dir = path.normalize(raw);
  for (let i = 0; i < 12; i += 1) {
    const base = path.basename(dir).toLowerCase();
    if ((base === "app" || base.endsWith(".asar")) && asarFileIn(path.dirname(dir))) return true;
    if (asarFileIn(dir)) return true;
    const parent = path.dirname(dir);
    if (!parent || parent === dir) break;
    dir = parent;
  }
  return false;
}

/** 이 경로는 Electron 이 옆의 app.asar 로 매핑한다. 이미 풀렸고 아카이브가 옮겨졌으면 거짓. */
export function asarShadowsPath(targetPath) {
  const raw = String(targetPath || "").trim();
  if (!raw) return false;
  const cache = activeProbes();
  const k = probeKey("s:", raw);
  const hit = cache.get(k);
  if (hit !== undefined) return hit;
  const v = computeAsarShadows(raw);
  if (cache.size < PROBE_MAX_ENTRIES) cache.set(k, v);
  return v;
}

/**
 * 호스트 파일이 어느 fs 를 쓰는지.
 * app.asar 가 없으면(Web, 서드파티 데스크톱, 공식 패키지가 이미 풀리고 아카이브가 옮겨진 경우) 계속 node:fs 를 쓴다.
 * 아카이브가 남아 있고 Electron 이 resources/app 을 매핑해 넣는 경우에는 실제 디스크로 바꾼다.
 */
export function fsFor(targetPath) {
  return asarShadowsPath(targetPath) ? diskFs() : nodeFs;
}

function fsForPair(left, right) {
  return asarShadowsPath(left) || asarShadowsPath(right) ? diskFs() : nodeFs;
}

// 이 메서드들은 파일 시스템을 바꾸고 app.asar 를 새로 만들거나 지울 수 있으므로, 호출 전에 프로브 캐시를 무효화해야 한다.
// openSync 는 일부러 넣지 않았다: 대개 읽기 전용으로 열기 때문에 넣으면 캐시가 날아간다.
const HOST_WRITE = new Set([
  "writeFileSync", "mkdirSync", "chmodSync", "unlinkSync", "rmSync",
  "renameSync", "appendFileSync", "symlinkSync", "copyFileSync",
]);

function route(method, pair) {
  const isWrite = HOST_WRITE.has(method);
  return (first, ...rest) => {
    if (isWrite) invalidateAsarProbes();
    const f = pair ? fsForPair(first, rest[0]) : fsFor(first);
    return f[method](first, ...rest);
  };
}

const HOST_SYNC = [
  "existsSync", "statSync", "lstatSync", "readFileSync", "writeFileSync",
  "readdirSync", "mkdirSync", "realpathSync", "chmodSync", "unlinkSync",
  "rmSync", "renameSync", "appendFileSync", "openSync", "symlinkSync",
  "accessSync", "truncateSync", "utimesSync",
];

// 이것들은 경로가 아니라 fd 를 받는다. route() 로 보내면 숫자 fd 를 경로로 보고 asar 를 탐지한다(#150).
const HOST_FD = [
  "closeSync", "readSync", "writeSync", "fsyncSync", "fstatSync", "futimesSync",
];

/** 경로에 따라 node:fs 또는 실제 디스크를 자동 선택한다. 패치, 탐지, 상태 모두 이 하나를 거친다. */
export const hostFs = {
  copyFileSync: route("copyFileSync", true),
  promises: {
    readFile: (p, ...args) => fsFor(p).promises.readFile(p, ...args),
    writeFile: (p, ...args) => { invalidateAsarProbes(); return fsFor(p).promises.writeFile(p, ...args); },
    mkdir: (p, ...args) => { invalidateAsarProbes(); return fsFor(p).promises.mkdir(p, ...args); },
    unlink: (p, ...args) => { invalidateAsarProbes(); return fsFor(p).promises.unlink(p, ...args); },
    rm: (p, ...args) => { invalidateAsarProbes(); return fsFor(p).promises.rm(p, ...args); },
    copyFile: (src, dest, ...args) => { invalidateAsarProbes(); return fsForPair(src, dest).promises.copyFile(src, dest, ...args); },
    rename: (src, dest, ...args) => { invalidateAsarProbes(); return fsForPair(src, dest).promises.rename(src, dest, ...args); },
  },
};
for (const method of HOST_SYNC) hostFs[method] = route(method, false);
for (const method of HOST_FD) hostFs[method] = (fd, ...args) => nodeFs[method](fd, ...args);

/** Electron 은 app.asar 를 디렉터리로 위장한다. 아카이브를 읽으려면 original-fs 를 거쳐야 하고, 그렇지 않으면 isFile 이 거짓이 되어 풀 수 없다. */
function archiveFs() {
  return diskFs();
}

function renameBusy(error) {
  const code = error && error.code;
  return code === "EBUSY" || code === "EPERM" || code === "EACCES";
}

export function renameAsarAside(asarPath) {
  // 이 단계는 app.asar 의 유무를 직접 바꾸므로 asar 판정 캐시를 즉시 무효화해야 한다.
  invalidateAsarProbes();
  const afs = archiveFs();
  if (!asarPath || !afs.existsSync(asarPath)) return { renamed: false };
  const bak = `${asarPath}.bak`;
  try {
    if (afs.existsSync(bak)) afs.rmSync(bak, { force: true });
    afs.renameSync(asarPath, bak);
    return { renamed: true, bak };
  } catch (error) {
    if (renameBusy(error)) return { renamed: false, busy: true, bak };
    throw error;
  }
}

export function asarArchiveIsFile(p) {
  try {
    const afs = archiveFs();
    return Boolean(p) && afs.existsSync(p) && afs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** 크기와 수정 시간으로 같은 아카이브인지 알아본다. */
export function asarFileIdentity(asarPath) {
  try {
    const st = archiveFs().statSync(asarPath);
    if (!st.isFile()) return null;
    return { size: st.size, mtimeMs: Math.round(st.mtimeMs) };
  } catch {
    return null;
  }
}

export function sameAsarIdentity(left, right) {
  return Boolean(
    left && right
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs,
  );
}

/**
 * 사용 가능한 디렉터리에 같은 아카이브가 짝지어져 있으면: 풀지 않는다.
 * 디렉터리가 없거나, 기록해 둔 아카이브 크기/시간이 바뀌었으면: 한 번 푼다.
 * 업그레이드 표시가 다른 아카이브와 만나도 마찬가지로 한 번 푼다. 디렉터리가 있고, 기록도 없고, 업그레이드도 아니면: 이 아카이브를 우선 인정하고 풀지 않는다.
 */
export function shouldExtractAsar({ usable, identity, recorded, upgrade }) {
  if (!identity) return false;
  if (!usable) return true;
  const same = sameAsarIdentity(identity, recorded);
  if (upgrade && !same) return true;
  if (recorded && !same) return true;
  return false;
}

function readHeader(fd, afs) {
  const pre = Buffer.alloc(16);
  if (afs.readSync(fd, pre, 0, 16, 0) !== 16) throw new Error("asar header truncated");
  if (pre.readUInt32LE(0) !== 4) throw new Error("not an asar archive");
  const headerSize = pre.readUInt32LE(4);
  const jsonSize = pre.readUInt32LE(12);
  if (!headerSize || !jsonSize || jsonSize > 256 * 1024 * 1024) throw new Error("asar header size invalid");
  const jsonBuf = Buffer.alloc(jsonSize);
  if (afs.readSync(fd, jsonBuf, 0, jsonSize, 16) !== jsonSize) throw new Error("asar header short");
  return {
    header: JSON.parse(jsonBuf.toString("utf8")),
    dataOffset: 8 + headerSize,
  };
}

function walk(node, prefix, out) {
  const files = node && node.files;
  if (!files) return;
  for (const [name, info] of Object.entries(files)) {
    const rel = prefix ? `${prefix}/${name}` : name;
    if (info && info.files) walk(info, rel, out);
    else if (info) out.push({ rel, info });
  }
}

function copyRange(afs, fd, offset, size, outPath) {
  const outFs = diskFs();
  const out = outFs.openSync(outPath, "w");
  try {
    const buf = Buffer.alloc(Math.min(1024 * 1024, Math.max(size, 1)));
    let left = size;
    let pos = offset;
    while (left > 0) {
      const n = afs.readSync(fd, buf, 0, Math.min(buf.length, left), pos);
      if (n <= 0) throw new Error(`asar short read at ${outPath}`);
      outFs.writeSync(out, buf, 0, n);
      pos += n;
      left -= n;
    }
  } finally {
    outFs.closeSync(out);
  }
}

/** asar 에서 unpacked 로 표시된 네이티브 파일은 아카이브 본문에 없다. 디렉터리를 풀어 기동하기 전에 resources/app 에 채워 넣어야 한다. */
export function overlayAsarUnpacked(asarPath, destDir) {
  const outFs = diskFs();
  const unpacked = `${asarPath}.unpacked`;
  if (!destDir || !outFs.existsSync(unpacked)) return { copied: 0, missing: true };
  let copied = 0;
  const walk = (dir) => {
    for (const ent of outFs.readdirSync(dir, { withFileTypes: true })) {
      const from = path.join(dir, ent.name);
      const to = path.join(destDir, path.relative(unpacked, from));
      if (ent.isDirectory()) {
        outFs.mkdirSync(to, { recursive: true });
        walk(from);
      } else if (ent.isFile()) {
        if (outFs.existsSync(to)) continue;
        outFs.mkdirSync(path.dirname(to), { recursive: true });
        outFs.copyFileSync(from, to);
        copied += 1;
      }
    }
  };
  walk(unpacked);
  return { copied };
}

function discardDir(dir) {
  if (!dir) return;
  try { diskFs().rmSync(dir, { recursive: true, force: true }); } catch { /* 남은 디렉터리는 다음에 정리한다 */ }
}

/** 대상 옆 디렉터리로 푼다. 실패하면 반쯤 만든 것을 지우고, 이미 쓰고 있는 것에는 손대지 않는다. */
export function extractAsarToSide(asarPath, destDir) {
  const next = `${destDir}.dshpurge-next`;
  discardDir(next);
  try {
    const count = extractAsar(asarPath, next);
    return { next, count };
  } catch (error) {
    discardDir(next);
    throw error;
  }
}

function restoreFromPrev(fs, destDir, prev) {
  if (!prev || fs.existsSync(destDir)) return false;
  try {
    fs.renameSync(prev, destDir);
    return true;
  } catch {
    return false;
  }
}

/** 풀기가 끝난 뒤에야 옛 디렉터리를 옮기고 새 디렉터리로 바꾼다. 바꾸지 못하면 옛 디렉터리를 되돌려 놓고, 그래도 실패하면 recover.json 을 써서 nextDir 를 남겨 다음 재시도에 쓴다. */
export function commitExtractedDir(destDir, nextDir) {
  const fs = diskFs();
  if (!nextDir || !fs.existsSync(nextDir)) throw new Error("풀어 둔 디렉터리가 없습니다");
  let prev = "";
  if (fs.existsSync(destDir)) {
    prev = `${destDir}.dshpurge-prev`;
    if (fs.existsSync(prev)) prev = `${destDir}.dshpurge-prev-${Date.now()}`;
    fs.renameSync(destDir, prev);
  }
  try {
    fs.renameSync(nextDir, destDir);
  } catch (error) {
    const restored = restoreFromPrev(fs, destDir, prev);
    const recoverFp = `${destDir}.dshpurge-recover.json`;
    try {
      fs.writeFileSync(recoverFp, JSON.stringify({
        when: new Date().toISOString(),
        destDir,
        nextDir,
        prev,
        prevRestored: restored,
        error: String(error?.message || error),
      }, null, 2));
    } catch { /* 구조 정보는 best effort */ }
    const err = new Error(
      `commitExtractedDir failed; nextDir kept at ${nextDir}, prev at ${prev}, recover=${recoverFp}: ${error && error.message || error}`
    );
    err.cause = error;
    err.recover = recoverFp;
    throw err;
  }
  return { prev };
}

/** 업그레이드 스크립트가 미리 옮겨 둔 옛 디렉터리. 패치를 다 쓰지 못했을 때 이것으로 되돌린다. */
export function newestPreservedDir(destDir) {
  const fs = diskFs();
  const parent = path.dirname(destDir);
  const prefix = `${path.basename(destDir)}.dshpurge-prev`;
  let names = [];
  try { names = fs.readdirSync(parent); } catch { return ""; }
  let best = "";
  let bestTime = -1;
  for (const name of names) {
    if (name !== prefix && !name.startsWith(`${prefix}-`)) continue;
    const full = path.join(parent, name);
    let time = 0;
    try { time = fs.statSync(full).mtimeMs; } catch { continue; }
    if (time >= bestTime) {
      best = full;
      bestTime = time;
    }
  }
  return best;
}

/** 패치를 다 쓰지 못했을 때, 방금 옮긴 옛 디렉터리를 제자리에 돌려놓는다. */
export function restoreExtractedDir(destDir, prev) {
  const fs = diskFs();
  if (!prev || !fs.existsSync(prev)) return false;
  let failed = "";
  if (fs.existsSync(destDir)) {
    failed = `${destDir}.dshpurge-failed-${Date.now()}`;
    fs.renameSync(destDir, failed);
  }
  try {
    fs.renameSync(prev, destDir);
  } catch (error) {
    if (failed && !fs.existsSync(destDir)) {
      try { fs.renameSync(failed, destDir); } catch { /* 옛 디렉터리는 여전히 prev 에 있다 */ }
    }
    throw error;
  }
  if (failed) {
    try { fs.rmSync(failed, { recursive: true, force: true }); } catch { /* 깨진 디렉터리를 남겨도 되돌려 놓은 쪽에는 영향이 없다 */ }
  }
  return true;
}

export function extractAsar(asarPath, destDir) {
  const afs = archiveFs();
  const fd = afs.openSync(asarPath, "r");
  let count = 0;
  try {
    const { header, dataOffset } = readHeader(fd, afs);
    const entries = [];
    walk(header, "", entries);
    const outFs = diskFs();
    outFs.mkdirSync(destDir, { recursive: true });
    for (const entry of entries) {
      const info = entry.info;
      const outPath = path.join(destDir, ...entry.rel.split("/"));
      outFs.mkdirSync(path.dirname(outPath), { recursive: true });
      if (info.unpacked) continue;
      if (typeof info.link === "string") {
        // symlink 대상은 해석한 뒤 destDir 을 벗어나면 안 된다(경계 이탈 방지, asar 출처를 신뢰할 수 없을 때)
        const linkResolved = path.resolve(path.dirname(outPath), info.link);
        const destResolved = path.resolve(destDir);
        const inside = linkResolved === destResolved
          || linkResolved.startsWith(destResolved + path.sep);
        if (!inside) {
          // 대상이 destDir 밖이면 건너뛴다(주 프로그램 원본 파일은 아직 아카이브 안에 있다)
          continue;
        }
        try {
          outFs.symlinkSync(info.link, outPath);
        } catch {
          // 링크를 만들 수 없으면 건너뛴다, 주 프로그램 파일은 아직 아카이브 안에 있다
        }
        continue;
      }
      const size = Number(info.size || 0);
      const offset = dataOffset + Number(info.offset || 0);
      if (size === 0) {
        outFs.writeFileSync(outPath, Buffer.alloc(0));
      } else {
        copyRange(afs, fd, offset, size, outPath);
      }
      count += 1;
    }
  } finally {
    afs.closeSync(fd);
  }
  return count;
}
