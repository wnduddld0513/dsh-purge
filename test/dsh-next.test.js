import { test } from "node:test";
import assert from "node:assert/strict";
import {
  looksLikeDesktopName,
  isDesktopExecutable,
  isOfficialHarnessExecutable,
} from "../lib/desktop.js";
import { detectSurface, pathLooksDesktop, isCommunityElectronHost } from "../lib/surface.js";

test("DSH NEXT 경로와 exe 는 데스크톱으로 인식한다", () => {
  assert.equal(looksLikeDesktopName("C:/Users/me/AppData/Local/Programs/DSH NEXT/DSH NEXT.exe"), true);
  assert.equal(isDesktopExecutable("C:/Users/me/AppData/Local/Programs/DSH NEXT/DSH NEXT.exe"), true);
  assert.equal(isOfficialHarnessExecutable("C:/Users/me/AppData/Local/Programs/DSH NEXT/DSH NEXT.exe"), true);
  assert.equal(pathLooksDesktop("C:/Users/me/AppData/Local/Programs/DSH NEXT/DSH NEXT.exe"), true);
});

test("DSH NEXT 는 DSH_SURFACE=web 이어도 데스크톱으로 판정한다", () => {
  const input = {
    env: { DSH_SURFACE: "web", DSH_PROFILE: "dsh-next" },
    execPath: "C:\\\\Users\\\\me\\\\AppData\\\\Local\\\\Programs\\\\DSH NEXT\\\\DSH NEXT.exe",
  };
  assert.equal(isCommunityElectronHost(input), true);
  assert.equal(detectSurface(input), "desktop");
});

test("일반 경로는 app.asar 가 붙어 있어도 데스크톱으로 보지 않는다", () => {
  assert.equal(pathLooksDesktop("/tmp/random-app/resources/app.asar"), false);
});
