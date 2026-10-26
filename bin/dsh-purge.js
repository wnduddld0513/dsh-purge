#!/usr/bin/env node

import * as core from "../lib/core.js";
import * as rules from "../lib/rules.js";

const args = process.argv.slice(2);

function printStatus(state) {
  const out = [];
  out.push("dsh-purge 상태 / Status");
  out.push("  호스트 / surface " + (state.surface || "web"));
  out.push("  DSH_HOME      " + state.dsh_home);
  if (state.desktop_install) out.push("  데스크톱 설치       " + state.desktop_install);
  if (state.ai_base) {
    out.push("  플러그인 루트 / root  " + state.ai_base);
    for (const [key, fp] of Object.entries(state.files)) {
      out.push(`    ${key.padEnd(22)} ${fp}`);
    }
  } else {
    out.push("  플러그인 루트 / root  " + core.missingAiBaseMessage());
  }
  out.push(`  shim 디렉터리      ${state.shim_dir || "미탐지 / not found"}`);
  out.push(`  백업 / backup  ${state.has_backup ? "있음 / yes" : "없음 / no"}`);
  out.push(`  주입 파일       ${state.override_path}`);
  out.push(`  주입 상태       ${state.override_status}`);
  out.push("");
  out.push(`  패치 ${state.patches_applied}/${core.ALL_PATCHES.length} 정리됨, ${state.patches_pending} 정리 대기`);
  for (const p of core.ALL_PATCHES) {
    const s = state.patch_status[p.id];
    const mark = s === "applied" ? "✓" : s === "pending" ? "✗" : "·";
    out.push(`    ${mark} [#${String(p.id).padEnd(2)}] ${p.name.padEnd(30)} ${p.layer}/${p.layer_en} — ${s}`);
  }
  out.push("");
  out.push(`  shim: dsh.cmd=${state.shim_cmd}  dsh.ps1=${state.shim_ps1}  dsh=${state.shim_bin}`);
  return out.join("\n");
}

async function main() {
  const mode = args.find((a) => ["--apply", "--revert", "--uninstall", "--status", "--edit", "--help"].includes(a));

  if (mode === "--help" || args.includes("-h")) {
    console.log(`dsh-purge 사용법:
  dsh-purge --status     상태 표시
  dsh-purge --apply      전체 정리 적용 (프롬프트+코드+shim+override)
  dsh-purge --revert     롤백 및 복원
  dsh-purge --uninstall  플러그인 제거 (적용된 경우 먼저 복원)
  dsh-purge --edit       주입 파일 prompt-inject.md 편집
  dsh-purge --help       도움말`);
    return;
  }

  const state = await core.gatherState();
  console.log(printStatus(state));
  console.log("");

  if (mode === "--apply") {
    if (!state.ai_base) {
      console.log("[ERROR] " + core.missingAiBaseMessage());
      console.log("  fix: DSH_BASE 를 dsh-agent-instructions/lib 를 포함한 @deepseek-ai 디렉터리로 지정하세요");
      process.exit(1);
    }
    const inject = rules.resolveInjectText(state.dsh_home);
    if (!inject.text) {
      console.log("[ERROR] 프롬프트와 규칙 세트가 모두 비어 있습니다, 먼저 프롬프트를 추가해야 합니다");
      process.exit(1);
    }
    const { hosts, report } = await core.applyPatchesAllHosts(core.ALL_PATCHES, {
      preserveClientBundles: false,
      forApply: true,
    });
    for (const h of hosts) console.log(`  호스트 / host → ${h.aiBase}`);
    for (const r of report) {
      const m = r.status === "applied" ? "✓ 정리됨" : r.status === "already" ? "- 최신 상태" : r.status === "missing_file" ? "⚠ 파일 없음" : `✗ ${r.status}`;
      console.log(`  ${m} patch #${String(r.patch_id).padEnd(2)} ${r.name}`);
    }
    const flashHost = hosts[0]?.aiBase || state.ai_base;
    const flash = core.silenceCmdFlash(flashHost);
    console.log(`  cmd-flash=${flash.entry} phase-1=${flash.phase1} ok=${flash.ok}`);
    if (hosts.length > 1) {
      console.log(`  다중 호스트 / multi-host: ${hosts.length} 개 @deepseek-ai 정리됨`);
    }
    console.log(inject.source === "rule"
      ? "  - 현재 규칙 세트를 사용하고 프롬프트 파일은 다시 쓰지 않습니다"
      : "  - 기존 프롬프트 파일을 사용합니다");
    if (state.shim_dir) {
      const r = await core.patchShim(state.shim_dir);
      for (const [fname, st] of Object.entries(r)) {
        if (st === "patched") console.log(`  ✓ shim ${fname} 주입 / injected`);
        else if (st === "already_patched") console.log(`  - shim ${fname} 이미 주입됨 / already injected`);
        else if (st === "missing") console.log(`  - shim ${fname} 없음 / missing`);
        else console.log(`  ⚠ shim ${fname}: ${st}`);
      }
    } else {
      console.log("  ⚠ shim 디렉터리를 찾지 못했습니다, 주입을 건너뜁니다");
    }
    console.log("");
    console.log("전체 완료 / All done — dsh 재시작 후 적용됩니다 / Restart dsh to take effect.");
  } else if (mode === "--revert") {
    if (state.ai_base || core.enumeratePatchAiBases().length) {
      const { reverted, errors } = await core.revertAllHosts();
      for (const p of reverted) console.log(`  ✓ 복원됨 / Reverted ${p}`);
      for (const [p, e] of errors) console.log(`  ⚠ 복원 실패 ${p}: ${e}`);
      if (reverted.length === 0) console.log("  - 복원할 패치 백업이 없습니다 / no patch backup");
    }
    if (state.shim_dir) {
      const r = await core.revertShim(state.shim_dir);
      for (const [fname, st] of Object.entries(r)) {
        if (st === "reverted" || st === "stripped_inject") console.log(`  ✓ shim ${fname}: ${st}`);
        else console.log(`  - shim ${fname}: ${st}`);
      }
    }
    console.log("");
    console.log("롤백 완료 / Revert done — dsh 재시작 후 복구됩니다 / restart to restore.");
    console.log("참고: prompt-inject.md 유지 (사용자 파일) / prompt-inject.md kept (user file)");
  } else if (mode === "--uninstall") {
    const { uninstallPurge } = await import("../lib/uninstall.js");
    const result = await uninstallPurge();
    if (result.applied) console.log("  패치가 감지되어 원본으로 복원했습니다.");
    else console.log("  적용된 패치가 감지되지 않았습니다, 그래도 플러그인 파일을 삭제합니다.");
    if (result.override?.removed) console.log(`  삭제됨 ${result.override.path}`);
    if (result.stripped?.length) console.log(`  profile 에서 제거: ${result.stripped.join(", ")}`);
    for (const e of result.errors || []) console.log(`  ⚠ ${e}`);
    if (!result.ok) {
      console.log("  제거 중단: 복원 실패, 플러그인 파일은 삭제되지 않았습니다.");
      process.exit(1);
    }
    console.log("");
    console.log("제거 완료. dsh 를 재시작하세요.");
  } else if (mode === "--edit") {
    const r = core.editOverride(state.dsh_home);
    if (!r.ok && r.needCreate) {
      await core.installOverride(state.dsh_home, true);
      console.log(`  ✓ 기본 주입 파일 생성됨: ${state.override_path}`);
      core.editOverride(state.dsh_home);
    } else {
      console.log(`  → ${r.editor} 로 주입 파일 열기 완료: ${r.path}`);
    }
    console.log("  편집 완료 후 dsh 를 재시작하면 적용됩니다.");
  } else {
    console.log("기본적으로 정리하지 않으며, --apply 로 정리를 적용합니다.");
  }
}

main().catch((e) => {
  console.error("[dsh-purge] error:", e);
  process.exit(1);
});
