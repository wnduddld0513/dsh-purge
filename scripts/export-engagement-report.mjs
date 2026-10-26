#!/usr/bin/env node
/**
 * 한 타깃의 점수 보고서를 옮길 수 있는 전달 패키지로 내보낸다: `<outDir>/<타깃>-레드팀 성과 재현 보고서.md` + `<outDir>/shots/`.
 *
 * 패널에서 내려받은 markdown 은 증거 스크린샷이 절대 경로라 남에게 보내면 이미지가 깨진다.
 * 여기서 shots/ 를 출력 디렉터리로 함께 복사하고, markdown 은 상대 경로를 쓴다.
 *
 * 실행법:
 *   node scripts/export-engagement-report.mjs
 *   node scripts/export-engagement-report.mjs --out ~/전달/타깃이름
 *   node scripts/export-engagement-report.mjs --engagement <id>
 */
import { mkdirSync, writeFileSync, cpSync, rmSync, existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { RedteamStore } from "../lib/redteam/store-core.js";

const argv = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = argv.indexOf("--" + name);
  return i === -1 || argv[i + 1] === undefined ? fallback : argv[i + 1];
};

const root = process.env.REDTEAM_HOME || join(process.env.DSH_HOME || join(homedir(), ".dsh"), "redteam");
const store = new RedteamStore(root);
const id = argOf("engagement", store.activeEngagementId());
if (!id) {
  console.error("사용 가능한 타깃이 없다: 먼저 패널에서 만들거나 --engagement <id> 로 지정한다");
  process.exit(1);
}
const outDir = resolve(argOf("out", process.cwd()));
mkdirSync(outDir, { recursive: true });

const shotsSrc = join(root, "engagements", id, "shots");
const shotsDst = join(outDir, "shots");
if (existsSync(shotsSrc)) {
  rmSync(shotsDst, { recursive: true, force: true });
  cpSync(shotsSrc, shotsDst, { recursive: true });
}

const rep = store.scoreReport(id, { shotRef: "relative" });
const name = String(rep.target || id).replace(/[/\\:*?"<>|]/g, "_");
const outFile = join(outDir, name + "-레드팀 성과 재현 보고서.md");
writeFileSync(outFile, rep.markdown, "utf8");
store.close();

const imgs = (rep.markdown.match(/!\[[^\]]*\]\([^)]+\)/g) || []).length;
console.log("✓ 보고서: " + outFile);
console.log("  합계 " + rep.summary.points + " 점 · " + rep.items.length + " 개 본문 · 삽입 스크린샷 " + imgs + " 장"
  + (existsSync(shotsDst) ? " (shots/ " + readdirSync(shotsDst).length + " 개 파일, 보고서와 함께 복사해 가면 된다)" : ""));
