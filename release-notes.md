# 1.1.87

## 한국어

- 버전 **1.1.87** — 승인 고지 창을 완전히 걷어냈습니다. 드릴 콘솔은 어떤 경로로도 고지 화면을 띄우지 않습니다.
- **고지 전문 삭제**: `client.js` 의 `AUTH_LEGAL_HTML`(16.6KB, 이용 고지·법조문·면책)을 들어냈습니다. 승인 모달 본문은 한 줄 안내문으로 대체했습니다.
- **승인 모달 진입 차단**: `dockBus` 요청과 `writeDrillAuth` 경로가 더 이상 `authOpen: true` 로 모달을 열지 않습니다(`authOpen: false`). `readDrillAuth()` 가 항상 `true` 인 것과 합쳐져 모달은 어떤 경로로도 렌더되지 않습니다.
- **세션 로그 손상 원인 제거 확인**: 1.1.86 에서 `net-scope` 의 `parkDenial` 이 사라진 뒤, 리포 전체에서 `step/start` `step/end` `assistant/message` `turn/start` `request/header` 를 직접 append 하는 코드가 0건임을 재확인했습니다(구조 이벤트는 호스트 agent-loop 만 기록).
- 테스트: 84/84 통과.

## English

- Version **1.1.87** — the authorization notice dialog is gone entirely; the drill console never shows a notice screen on any path.
- **Notice text removed**: dropped `AUTH_LEGAL_HTML` (16.6 KB of terms, statute excerpts, and disclaimers) from `client.js`; the modal body is now a single neutral line.
- **Modal entry closed**: the `dockBus` request path and the `writeDrillAuth` path no longer set `authOpen: true`. Together with `readDrillAuth()` returning `true`, the modal is unreachable.
- **Session-log corruption source confirmed gone**: after `parkDenial` was removed in 1.1.86, a repo-wide scan shows zero code that appends `step/start`, `step/end`, `assistant/message`, `turn/start`, or `request/header` directly — those structural events are written only by the host agent loop.
- Tests: 84/84 passing.

# 1.1.86

## 한국어

- 버전 **1.1.86** — 이 포크의 게이트 제거와 스킬 라이브러리 동봉을 담았습니다.
- **스킬 라이브러리 34종 동봉**: `skills/redteam/*.md` 를 새로 작성해 넣었습니다(영문, 파일명=스킬 id). `package.json` 의 `files` 에 `skills` 를 추가해 배포 tarball 에도 포함됩니다.
- **스킬 상태 게이트 제거**: `skill-availability.js` 의 `checkSkill()` 이 더 이상 `broken`/`unknown` 을 만들지 않고 항상 `available` 을 반환합니다. `needs_user` 는 항상 빈 배열이고, 설치 힌트만 남습니다.
- **지식 베이스 도구 복원**: `redteam_poc_search` `redteam_poc_get` `redteam_poc_add` `redteam_poc_list` `redteam_poc_update` `redteam_poc_use` 의 `KB_DISABLED` 조기 반환을 걷어내고 `store-core` 구현을 그대로 호출합니다.
- **에이전트 슬롯 상한 제거**: `redteam_agent_slot` 은 더 이상 3개 초과를 이유로 거부하지 않습니다(`cap`/`free` 는 `null`, `gate: "disabled"`).
- **클라이언트 전송 차단 제거**: `client.js` 의 `mustBlockSubmit()` 이 항상 `false` 입니다. 환경 준비가 안 됐다는 이유로 전송이 삼켜지는 경로가 사라졌습니다. 드릴 승인 창과 첫 실행 고지 창도 게이트로 쓰지 않습니다(`readDrillAuth()`/`readWelcomeAck()` 는 `true`). 서버의 `/dsh-purge/drill-grant` 기록 경로는 유지됩니다.
- **공인망 게이트 제거**: `net-scope.js` 는 74줄 스텁이 되었습니다. `agent/pre-step` 턴 가로채기, `assistant/message` 합성 거부 기록, `tools/pre-execute` 인자 검사, 호스트·은행·치트 키워드 표, DNS 대역 판정이 모두 사라졌고 `installRegionGate()` 는 no-op 입니다.
- **인자 검사 제거**: `validate.js` 의 셸 타입 화이트리스트와 `assertPathWithin` 차단을 없앴습니다.
- 문서: README 양쪽에 `## 스킬` 절을 추가하고, 남아 있던 "오픈소스 버전은 스킬·지식을 배포하지 않습니다" 문구와 게이트 설명을 실제 동작으로 교체했습니다.
- 테스트: 84/84 통과.

## English

- Version **1.1.86** — carries this fork's gate removal and the bundled skill library.
- **34-skill library**: new `skills/redteam/*.md` documents (English, file name = skill id), and `skills` is now listed in `package.json` `files` so it ships in the tarball.
- **No skill status gate**: `checkSkill()` in `skill-availability.js` never returns `broken`/`unknown`; it always reports `available` and `needs_user` stays empty. Install hints remain.
- **Knowledge base restored**: the six `redteam_poc_*` tools no longer short-circuit on `KB_DISABLED`; they call `store-core` again.
- **Agent slot cap removed**: `redteam_agent_slot` no longer refuses above three concurrent agents (`cap`/`free` are `null`, `gate: "disabled"`).
- **No client submit blocking**: `mustBlockSubmit()` always returns `false`, so a submit is never swallowed for environment reasons. The drill authorization dialog and the first-run notice no longer gate the UI (`readDrillAuth()`/`readWelcomeAck()` return `true`); the server-side `/dsh-purge/drill-grant` record stays.
- **Public-network gate removed**: `net-scope.js` is a 74-line stub. The `agent/pre-step` interception, the synthetic `assistant/message` denial, the `tools/pre-execute` argument hook, the host/bank/cheat keyword tables and the DNS range test are gone; `installRegionGate()` is a no-op.
- **Argument validation removed**: `validate.js` no longer enforces the shell-type whitelist or `assertPathWithin`.
- Docs: new `## Skills` section in both READMEs, and the leftover "this build does not ship skills or the knowledge base" wording plus the gate descriptions now match real behavior.
- Tests: 84/84 passing.

# 1.1.85

## 한국어

- 버전 **1.1.85**.
- **#196**: 다크 모드에서 일부 버튼이 흰 배경에 흰 글자로 나와 전혀 보이지 않던 문제를 수정했습니다.
  - 근본 원인: 호스트 다크 테마가 `--dsw-alias-brand-primary`를 거의 흰색(`neutral-bluish-50` `#f9fafb`)으로 해석합니다. 플러그인에서 "브랜드 색 배경 + 흰 글자"를 쓰던 버튼(설정 페이지의 "적용" "주입 저장", 드릴 콘솔의 "저장" "검색" "연결성 검사"와 각종 기본 버튼)이 다크 모드에서 통째로 흰 덩어리가 됩니다.
  - 이제 다크 모드(`body[data-ds-dark-theme]`, `[data-theme="dusk"]`)에서 기본 버튼은 초록 실색 `#3d8f68` + 흰 글자로 통일하고, 호버에는 더 진한 `#347a59`를 씁니다. `-webkit-text-fill-color`도 함께 명시해 호스트가 강제하는 흰 글자가 새어 나오지 않게 했습니다.
  - 보고서의 단계 번호 점(`.rt-rep-step-no`)도 같은 초록 배경 + 흰 글자로 바꿨습니다.
  - 라이트 모드 동작은 그대로이며, `test/client-dark-theme.test.js`를 추가해 이 다크 모드 규칙들을 정적으로 지킵니다.
- 테스트: 84/84 통과.

## English

- **1.1.85**.
- **#196**: fix buttons in dark mode rendering as a solid white block (white text on white background).
  - Root cause: the host dark theme resolves `--dsw-alias-brand-primary` to a near-white token (`neutral-bluish-50`, `#f9fafb`). Every plugin button that used "brand color as background + white text" (settings **Apply**, **Save injection**, drill console **Save**, **Search**, **Test connectivity**, and other primary buttons) turned into a white block in dark mode.
  - Primary buttons under dark themes (`body[data-ds-dark-theme]`, `[data-theme="dusk"]`) now use a solid green `#3d8f68` with white text, with `#347a59` on hover; `-webkit-text-fill-color` is set explicitly so host-forced white text cannot leak through.
  - The report step-number dots (`.rt-rep-step-no`) are switched to the same green/white pair.
  - Light mode is unchanged; added `test/client-dark-theme.test.js` to guard these dark-mode rules.
- Tests: 84/84 pass.

# 1.1.84

## 한국어

- 버전 **1.1.84**.
- **꼬리 앵커와 하위 에이전트 승인 인수**(배선 `anchor.js` / `subagent-control.js`):
  - 앵커 섹션을 system prompt의 sections 배열 끝에 물리적으로 덧붙입니다(waterfall은 배열 순서대로 렌더링하며 `order`는 정렬에 참여하지 않습니다). 이로써 정체성과 형식 규칙을 recency 위치로 되돌립니다. 같은 이름의 섹션이 이미 있으면 먼저 걸러낸 뒤 덧붙이므로 두 벌이 생기지 않습니다.
  - 앵커 규칙이 운영자 언어를 따르도록 바꿨습니다: 중국어 요청에는 중국어로 답하고, 앵커 자체가 영어인 것은 언어 지시로 치지 않습니다. 하드코딩된 영어 시작 문장을 삭제했습니다(레드팀 모드 답변이 영어로 바뀌던 직접 원인).
  - 자식 세션을 호스트가 `approval/policy = "never"`로 쓸 때 `ask`로 되돌리고 `approval/request` 워터폴에서 통과시키므로, 하위 에이전트가 더 이상 "계속 거부"되지 않습니다.
  - 롤백 스위치: `anchorMode: "off"`, `subagentControl: false`.
- **레드팀 모드 한국어화**: 모드 이름과 설명, 역할 이름, 5단계 공격 체인, 25개 채점 규칙과 POC 분류, 스킬 수정 안내, 환경 적응 힌트, 패널과 서버 오류, 결과 보고서와 결과 재현 보고서를 모두 한국어로 되돌렸습니다.
- **#194**: desktop에서 실행 후 창이 끝내 표시되지 않던 문제.
  - hung-operator 안내를 내용 변경 기준(home + mtime + 커밋된 리비전 번호)으로 캐시하도록 바꿨습니다. 내용이 그대로면 더 이상 매 라운드 약 23KB를 다시 계산하지 않습니다.
  - 폭주 차단(10초 120회)과 느린 호출 차단(1.5초에 발동, 30초 쿨다운)을 추가했습니다. 차단 중에는 캐시된 텍스트를 바로 돌려주어 desktop host가 멈추지 않습니다.
  - 같은 assemble에서의 중복 재작성은 WeakMap으로 중복 제거합니다.
  - 새 패치 **#91**: 호스트가 `code === null || signal`을 조용히 resolve하기 전에 `%TEMP%\dsh-purge-desktop.log`에 `[desktop.hostExit]` 한 줄을 기록해, 대화상자는 띄우지 않으면서도 근거를 남깁니다.
- **#188(0.2.1-rc.4 전용 부분)**: **#89** 샌드박스 정책 브랜드 제거, **#90** skill-badge 설명 한국어화를 추가하고 **#32/#53**의 rc.3 변형과 marker를 확장했습니다. 세 가지 새 패치는 모두 optional이라 호스트에 해당 파일이 없으면 조용히 건너뜁니다.
- 테스트: 81/81 통과. 앵커 배선과 레드팀 문구 테스트를 추가했습니다.

## English

- **1.1.84**.
- **Tail anchor and subagent approval takeover** (wiring `anchor.js` / `subagent-control.js`):
  - The anchor section is physically appended to the end of the system-prompt sections array (the waterfall renders by array order, not by `order`), putting identity and format rules back in the recency slot; any existing same-named section is filtered first so there is never a duplicate.
  - Anchor rules now follow the operator's language: a Chinese request gets a Chinese answer, and the anchor being written in English is not a language instruction. The hard-coded English opener was removed (the direct cause of red-team mode answering in English).
  - When the host writes `approval/policy = "never"` for a child session, it is flipped back to `ask` and allowed in the `approval/request` waterfall, so subagents are no longer refused every time.
  - Rollback switches: `anchorMode: "off"`, `subagentControl: false`.
- **Red-team mode localized to Chinese**: mode name and description, role names, the five-stage attack chain, the 25-item scoring rules and POC categories, skill-fix guidance, environment-adaptation hints, panel and server messages, and both the results report and the replay report.
- **#194**: desktop window never appears after launch.
  - The hung-operator prompt is now cached by content change (home + mtime + committed revision); an unchanged prompt is no longer rebuilt (~23KB) on every refresh.
  - Storm breaker (120 calls / 10s) and slow-call breaker (trip at 1.5s, 30s cooldown) return the cached text instead of stalling the desktop host.
  - Duplicate rewrites within the same assemble call are deduped with a WeakMap.
  - New patch **#91**: before the host silently resolves `code === null || signal`, append a `[desktop.hostExit]` line to `%TEMP%\dsh-purge-desktop.log` — still no dialog, but no longer invisible.
- **#188 (0.2.1-rc.4-specific parts)**: new **#89** sandbox-policy brand neutralization and **#90** skill-badge description localization, plus rc.3 variants and markers for **#32/#53**; all three new patches are optional and are skipped silently when the host has no matching file.
- Tests: 81/81 pass; new coverage for anchor wiring and red-team copy.

# 1.1.83

## 한국어

- 버전 **1.1.83**. 버그 수정 및 안정성 개선.
- **#185**: pnpm 11(DSH 내장 11.2.2)에서 `allowBuilds` 때문에 `pnpm install`이 크래시하던 문제를 수정했습니다.
  - 이전에는 profile의 `pnpm-workspace.yaml`에 `dsh-purge@https://...` 같은 URL 키가 기록되었고, pnpm이 이를 버전 유니온으로 해석해 `[ERR_PNPM_INVALID_VERSION_UNION] Invalid versions union`을 바로 냈습니다.
  - 이제는 꾸러미 이름만 `dsh-purge`로 씁니다: pnpm의 `allowBuilds`는 원래 패키지 이름으로 매칭하므로 tarball / git / registry 세 가지 설치 형태를 모두 허용합니다.
  - 자가 치유 강화: 모든 `dsh-purge@*` 과거 키(URL 키, 잘린 옛 키 `dsh-purge@https`, `@1.1.81` 같은 버전 키)를 일괄로 지우고 꾸러미 이름만 남깁니다. dsh-purge가 아닌 키는 그대로 보존합니다.
- **#191**: macOS DSH Desktop(0.2.1-rc.4) 시작 크래시 `failed to parse overlay .../cordis.patch.yml`을 수정했습니다.
  - 호스트가 생성한 profile 계층 `cordis.patch.yml`은 전체가 빈 flow 시퀀스 `[]` 하나일 수 있고, 그것 자체가 완전한 YAML 문서입니다. 여기에 파일 끝으로 `- insert:`를 덧붙이면 두 번째 문서가 되어 호스트 파싱이 바로 실패합니다.
  - 이제 쓰기 전에 데이터 부분의 형태를 먼저 판정합니다: 빈 flow 시퀀스(`[]`, `---` 접두사 가능) → `[]` 줄 전체를 **교체**하고 덧붙이지 않습니다; 빈 파일 / 주석만 → insert 블록을 바로 씁니다; 정상 블록 시퀀스 → 기존 덧붙이기 동작을 유지합니다.
  - 비어 있지 않은 flow 시퀀스(호스트나 사용자 자신의 내용)는 확신할 수 없으면 건드리지 않고 `{ ok: false, wrote: false }`를 반환합니다. 잘못 쓰느니 남겨 두는 편을 택합니다.

## English

- **1.1.83**. Bug fixes and stability.
- **#185**: fix `pnpm install` crashing under pnpm 11 (11.2.2, bundled with DSH) because of `allowBuilds`.
  - The profile `pnpm-workspace.yaml` used to get a `dsh-purge@https://...` URL key, which pnpm parses as a version union and rejects with `[ERR_PNPM_INVALID_VERSION_UNION] Invalid versions union`.
  - Now only the bare package name `dsh-purge` is written: pnpm matches `allowBuilds` by package name, so tarball / git / registry installs are all allowed.
  - Stronger self-healing: every `dsh-purge@*` legacy key (URL keys, truncated `dsh-purge@https`, `@1.1.81`-style version keys) is dropped and only the bare name is kept; non-dsh-purge keys are preserved as-is.
- **#191**: fix the macOS DSH Desktop (0.2.1-rc.4) startup crash `failed to parse overlay .../cordis.patch.yml`.
  - The host-generated profile `cordis.patch.yml` may consist of a single empty flow sequence `[]`, which is already a complete YAML document; appending `- insert:` after it creates a second document and the host fails to parse it.
  - The data shape is now detected before writing: an empty flow sequence (`[]`, optionally `---`-prefixed) → **replace** the `[]` line instead of appending; empty file / comments only → write the insert block; a normal block sequence → the previous append behaviour is kept.
  - A non-empty flow sequence (host or user content) is left alone and returns `{ ok: false, wrote: false }` — better to skip than to write something broken.

# 1.1.82

## 한국어

- 버전 **1.1.82**. 버그 수정 및 안정성 개선.
- **#180**: profile의 `pnpm-workspace.yaml` `allowBuilds`가 반복해서 깨지던 문제(`dsh-purge@https: true` 기형 키 → `ERR_PNPM_INVALID_VERSION_UNION`, 중복 키 → `duplicated mapping key`)를 수정했습니다.
  - URL 키를 파싱할 때 더 이상 콜론에서 잘리지 않으며, `://`가 들어간 키는 쓸 때 자동으로 따옴표를 붙입니다.
  - 재작성 시 기대 키와 정확히 같은 `dsh-purge@*`만 남기고, 오염된 옛 키(기형 키, 지난 버전/commit URL)는 자동으로 정리되므로 손으로 고칠 필요가 없습니다.
  - 기대 키는 profile의 `pnpm-lock.yaml`에서 실제로 해석된 tarball URL을 먼저 읽고(고정 commit 설치도 이제 URL 키가 두 개 생기지 않습니다), 읽지 못할 때만 `package.json`으로 물러납니다.
  - 재작성 결과는 최소 YAML 검증(키 중복 없음, round-trip 무손실)을 먼저 통과해야 하며, 통과하지 못하면 디스크에 쓰지 않습니다. 건강한 파일은 쓰기가 0이라 시작할 때마다 다시 쓰지 않습니다.

## English

- **1.1.82**. Bug fixes and stability.
- **#180**: stop rewriting the profile `pnpm-workspace.yaml` `allowBuilds` into garbage (`dsh-purge@https: true` malformed key → `ERR_PNPM_INVALID_VERSION_UNION`; duplicated keys → `duplicated mapping key`).
  - URL keys no longer truncate at the first colon; keys containing `://` are written back quoted.
  - Rewrites keep only `dsh-purge@*` keys exactly equal to the wanted set; stale polluted keys (malformed, old version/commit URLs) self-heal away on the next ensure.
  - The wanted key prefers the tarball URL actually resolved in the profile `pnpm-lock.yaml` (fixed-commit installs no longer get a duplicate URL key); falls back to `package.json`.
  - Rewritten output passes a minimal YAML check first (no duplicate keys, lossless round-trip); healthy files are never written again, so boot no longer rewrites each run.

# 1.1.81

## 한국어

- 버전 **1.1.81**. 버그 수정 및 안정성 개선.
- **#174**: DSH NEXT 커뮤니티 데스크톱을 인식합니다(경로, 프로세스, 바로가기, 밀봉 asar). `DSH_SURFACE=web`도 더 이상 잘못 보고하지 않으며, 아무 `app.asar`나 데스크톱으로 취급하지 않습니다.
- **#175**: ip / 채점 / settle 단위 테스트를 보강하고 초안 문서와 `.bak`를 삭제했습니다. `npm test` 23개 모두 통과.
- **#171 / #173**: zip 디렉터리 항목과 skills `fs` 임포트는 1.1.80에 이미 있었고, 이번 버전에서 단위 테스트로 고정했습니다.

## English

- **1.1.81**. Bug fixes and stability.
- **#174**: detect DSH NEXT desktop (paths, process, shortcuts, sealed asar). Still desktop when `DSH_SURFACE=web`. A random `app.asar` is not treated as the host.
- **#175**: add ip / score / settle tests; drop draft docs and `.bak`. `npm test` is 23/23 green.
- **#171 / #173**: zip directory entries and the skills `fs` import shipped in 1.1.80; this release locks them with tests.

# 1.1.80

## 한국어

- 버전 **1.1.80**. 버그 수정 및 안정성 개선.
- **#168**: pnpm 12의 `allowBuilds`가 `dsh-purge@codeload...`까지 `true`로 기록해, 다른 플러그인을 설치해도 더 이상 `set this to true or false`가 남지 않습니다.
- **#169**: 칩 / 적용 버튼이 시스템 폰트와 실색 글자를 강제해, 더 이상 호스트 아이콘 폰트에 글자가 먹히지 않습니다.
- **#170**: 순수 Node로 zip을 풀 때 디렉터리 항목은 디렉터리를 만들고, 같은 이름의 빈 파일을 써서 EEXIST가 나지 않습니다.
- **#172**: `lib/skills.js`에 `fs`를 보강해 #54 심링크 중첩 가드가 다시 동작합니다.
- **#176**: **DSH 0.2.1-rc.3 및 그 이후 rc는 지원하지 않습니다**를 분명히 밝힙니다. **0.2.1-rc.2**로 되돌리세요. 맞지 않는 패치는 적용 대기 또는 건너뜀으로 두고 파일을 함부로 고치지 않습니다.

## English

- **1.1.80**. Bug fixes and stability.
- **#168**: pnpm 12 `allowBuilds` also sets `dsh-purge@codeload...` to `true`, so installing other plugins no longer leaves `set this to true or false`.
- **#169**: chip / Apply buttons force a system font and solid text color so the host icon font cannot hide the label.
- **#170**: Node zip fallback creates directories for directory entries instead of empty files (no more EEXIST).
- **#172**: import `fs` in `lib/skills.js` so the #54 symlink overlap guard works again.
- **#176**: **DSH 0.2.1-rc.3 and newer RCs are not supported.** Stay on **0.2.1-rc.2**. Unmatched patches stay pending or skipped.

# 1.1.79

## 한국어

- 버전 **1.1.79**. 버그 수정 및 안정성 개선.
- **#165**: 커뮤니티판 DS Bot / DeepSeek Bot을 데스크톱 호스트로 인식합니다(`ds-bot` profile, Electron asar). 더 이상 `set DSH_BASE`를 잘못 보고하지 않습니다.
- **#166**: pnpm 12가 `postinstall`을 막을 때 `allowBuilds`를 보강하고, `--allow-build=dsh-purge` / `approve-builds`를 분명히 적었습니다.
- **#167**: 업그레이드 후 `bundles` + 본체 insert를 복구해, 빈 칩이 시작 버튼을 숨기지 않으며 1.1.74에 있던 버튼이 돌아옵니다.
- 적용/복원/제거 진행률이 job 단계를 따릅니다. 메인 에이전트와 하위 에이전트가 같은 주입, 권한, 능력 프로토콜을 씁니다.
- 새 세션에서 `dsh-purge` 칩을 더 이상 줄 끝으로 밀어내지 않습니다.

## English

- **1.1.79**. Bug fixes and stability.
- **#165**: community DS Bot / DeepSeek Bot is a desktop host (`ds-bot` profile, Electron asar); no more false `set DSH_BASE`.
- **#166**: pnpm 12 skipped `postinstall`; write `allowBuilds` and document `--allow-build=dsh-purge`.
- **#167**: restore `bundles` + body insert after upgrade so the 1.1.74 button comes back.
- Apply / revert / uninstall progress follows the job; main and subagents share inject, permission, and capability text.
- New-session no longer shoves the `dsh-purge` chip to the far right.

# 1.1.78

## 한국어

- 버전 **1.1.78**. 버그 수정: 비활성화/제거 후 새 세션을 만들 수 없던 문제.
- **#108**: 비활성화 또는 제거 시 `agent-preset-registry.selectedDefault`를 `redteam`에서 `standard`로 되돌리고, `$DSH_HOME/.agent-presets/redteam`을 지웁니다. 핫 리로드가 사용자가 설정한 레드팀 기본값을 덮어쓰지 않습니다.
- 제거 시 `dsh.profile.bundles` / `dsh.profile.plugins`도 함께 처리해, 데스크톱 profile에 `dsh-purge`가 남지 않습니다.

## English

- **1.1.78**. Bug fix: new sessions after disable/uninstall.
- **#108**: on disable or uninstall, reset `agent-preset-registry.selectedDefault` from `redteam` to `standard`, and remove `$DSH_HOME/.agent-presets/redteam`. Hot reload keeps a user-chosen redteam default.
- Uninstall also strips `dsh.profile.bundles` / `dsh.profile.plugins`.

# 1.1.77

## 한국어

- 버전 **1.1.77**. bug 수정 및 안정성 개선.
- 긴 레드팀 작업이 여전히 공인 인터넷으로 나가던 문제를 수정했습니다: `침투 테스트` / `레드팀` / `초기 침투` / `사이트 장악`을 게이트에 포함하고, 본문은 256KB까지 창 단위로 스캔해 대상이 뒤쪽 절반에 적혀 있어도 차단합니다.
- 이후 단계에서 차단이 누락되던 문제를 수정했습니다: 각 단계마다 도구 인자를 확인하고, `tools/pre-execute`가 공인 IP/도메인을 만나면 해당 턴을 즉시 중단합니다.
- 긴 텍스트 정규식은 창 단위로 스캔해, 전체 역추적으로 이벤트 루프가 멈추는 일을 막습니다.

## English

- **1.1.77**. Bug fixes and stability.
- Long red-team tasks no longer reach the public internet: `penetration testing` / red-team / initial access / site takeover are gated; the body is scanned in windows up to 256KB.
- Later steps are gated too: tool arguments are checked, and `tools/pre-execute` stops on a public IP or name.
- Long-text regex runs in windows so a huge paste cannot stall the event loop.

# 1.1.76

## 한국어

- 버전 **1.1.76**. pnpm만 쓰는 머신 지원: profile 디렉터리에서 codeload 압축 패키지를 `pnpm add` 하면 `postinstall`이 `dsh-purge`를 `bundles`에 자동으로 기록합니다.
- 설치 주소를 `codeload.github.com`으로 바꿔 `github.com/archive`의 302를 피했습니다 (pnpm에서 `fetch failed`가 납니다). `pnpm add dsh-purge`는 쓰지 마세요 (npm 레지스트리에 그 이름이 없습니다).

## English

- **1.1.76**. pnpm-only hosts: `pnpm add` the codeload tarball inside the profile; `postinstall` writes `dsh-purge` into `bundles`.
- Install URL is `codeload.github.com` so pnpm does not die on the `github.com/archive` 302. Do not `pnpm add dsh-purge` — that name is not on the npm registry.

# 1.1.75

## 한국어

- 버전 **1.1.75**. Hub 마켓 원클릭 설치에서 `already queued: dsh-purge`가 뜨던 문제를 수정했습니다: `cordis.patch.yml`이 이미 bundles에 들어 있는 본체를 다시 insert하지 않습니다.
- README의 설치 절차를 세 단계로 정리했습니다: GitHub 압축 패키지 명령만 쓰고, 플러그인 마켓 / `github:` / npm은 쓰지 않습니다.

## English

- **1.1.75**. Fix Hub one-click `already queued: dsh-purge`: the bundle patch no longer inserts the plugin that is already in `bundles`.
- README install is three steps: GitHub tarball only; skip the plugin market / `github:` / npm.

# 1.1.74

## 한국어

- 버전 **1.1.74**. 여러 차단 및 로딩 bug를 개선했습니다. DSH **0.2.1-rc.2**에 맞췄습니다 (0.2.0도 계속 사용 가능).
- 랩 게이트를 수정했습니다: 도메인을 먼저 해석한 뒤 IP를 판정하고, 더 이상 `.lab` / `.htb` 접미사로 통과시키지 않습니다. `hosts`가 공인망을 가리키거나 해석에 실패하거나 공인망이 섞여 있으면 모두 차단합니다.
- 신원 우회를 수정했습니다: `169.254` 클라우드 메타데이터는 더 이상 랩으로 취급하지 않고, `::ffff:공인망`은 분해한 뒤 판정하며, 공격 문장에 대상이 없으면 더 이상 통과시키지 않습니다.
- DSH 0.2.1 프리셋 로딩을 수정했습니다: 객체 schema에 `additionalProperties`를 보강하고, 이미 설치된 redteam 프리셋에서는 남아 있던 `toolFilter`를 정리합니다.
- 드릴 콘솔이 영어로 바뀌던 문제를 수정했습니다: 한국어 탭을 되돌렸습니다.
- 치트 제작 금지: 세션 진입 지점에서 강제로 막고, 프롬프트 Rule 1을 금지로 바꿨습니다.

## English

- **1.1.74**, bug-fix release. Target DSH **0.2.1-rc.2** (0.2.0 still works).
- Lab gate: resolve first, then allow only private IPs. Suffixes are not an allow list.
- Close identity holes: drop link-local metadata, unwrap IPv4-mapped IPv6, deny unnamed attack tasks.
- DSH 0.2.1 preset load: seal object schemas; strip leftover `toolFilter`.
- Restore Chinese drill-console tabs.
- Game cheats are forbidden at the session gate.

# 1.1.73

## 한국어

- 버전 **1.1.73**. DSH **0.2.1-rc.2**에 맞췄습니다 (0.2.0도 계속 사용 가능).
- 0.2.1 호환을 반영했습니다: `{{cwd}}` 정적 폴백, 패치 #40, `toolFilter` 제거, `dsh-tools` 해석, hostFs fd 직통, 데스크톱 패키지 교체 시 자기 종료 없음, `file:` 아카이브 업데이트, Ctrl+Enter steer 지원.
- UI 조작 문구를 영어로 보강했습니다 (드릴 콘솔, 정리 패널, 패치 표, 점수/스킬 안내). `ko` 언어 팩과 모델 프롬프트는 한국어로 유지합니다. 랩 기본 차단 `own.hint`는 이 저장소 정책을 그대로 따릅니다.
- 번들 스킬 `paper-autopilot` + `npm run install:skill`.
- 레드팀 증거 원장: `claimed → observed` 검증 체인, `ResidualUnknown`, 8개의 `redteam_evidence_*` / `redteam_unknown_*` 도구.

## English

- **1.1.73**, target DSH **0.2.1-rc.2** (0.2.0 still works).
- 0.2.1 compatibility in-tree: `{{cwd}}` fallback, patch #40, drop `toolFilter`, host `dsh-tools` resolve, hostFs fd pass-through, desktop helper self-kill fix, `file:` archive update, Ctrl+Enter steer.
- Operator-facing UI copy is English; `zh` locale and model prompts stay Chinese. Lab default-deny `own.hint` is unchanged.
- Bundled `paper-autopilot` skill + `npm run install:skill`.
- Red-team evidence ledger: claimed→observed verification, ResidualUnknown, eight `redteam_evidence_*` / `redteam_unknown_*` tools.

# 1.1.71

## 한국어

- 버전 **1.1.71**.
- 1.1.70에서 `??`와 `||`를 섞어 쓴 문제를 수정했습니다: 플러그인 활성화 시 `failed to import`가 발생합니다 (데스크톱 / Web 동일 진입점).
- #86은 UI 큐 steer → followup만 바꿨습니다. 공용 `steer()`는 next-step으로 되돌렸고, 에이전트 간 `send_message`는 여전히 다음 단계에 삽입됩니다.
- `installed-rev`는 버전을 넘어가도 오래된 `apply:x.y.z`를 그대로 쓰지 않습니다. #88은 현재 `renderedPrompt` / 이전 `system` 앵커 중 실제로 맞은 쪽에 표시를 남깁니다.
- 릴리스 전에 `node --check`로 메인 진입점을 검사해, 문법 오류가 다시 Release에 들어가지 않게 했습니다.

## English

- **1.1.71**.
- Fix 1.1.70 `??` mixed with `||`: enable failed to import on desktop and web.
- #86 keeps UI queue steer → followup. Public `steer()` is next-step again so `send_message` inserts at the next step.
- Stale `apply:x.y.z` in `installed-rev` refreshes across versions. #88 marks the host anchor that actually exists (`renderedPrompt` or `system`).
- Release CI syntax-checks the plugin entry.

# 1.1.70

## 한국어

- 버전 **1.1.70**.
- Hub / 불완전 설치 상태에서 `dsh-purge`에 `pluginPackages`가 붙으면 Cordis가 계속 pending 상태로 남고 호스트 종료 코드가 1이 됩니다. 이번 버전은 의존성을 `systemPrompt` + `tools`로 다시 고정했습니다.
- 정리 페이지에서는 업그레이드 체인 표시만 합칩니다 (면책, 승인, 전문 첨부, hooks 등). Apply는 여전히 모든 패치를 적용합니다.
- 더 이상 쓸모없는 #81 / #89 목록 행을 제거했습니다. 전문 첨부는 #87로 합쳤고, 공식 phase-1은 조용히 통과시킵니다.
- 지휘 측은 "사용자가 준 대상을 기준으로 작업을 시작"하도록 바꿨습니다. #97 / #98 / #99를 병합했습니다.

## English

- **1.1.70**.
- Hub / incomplete installs that inject `pluginPackages` leave dsh-purge pending and kill the host. Dependencies are pinned to `systemPrompt` + `tools`.
- Clean page groups upgrade-chain patches for display only; Apply still writes every patch.
- Dropped dead #81 / #89 rows. Hang lives in #87. Official phase-1 keep is silent.
- Commander bind: start from the user's target. Includes #97 / #98 / #99.

# 1.1.69

## 한국어

- 버전 **1.1.69**.
- 전송할 때 ChatML / `project_instructions`를 벗겨내고, 입력창과 디스크는 그대로 둡니다.
- 적용 + 재시작이 현재 기본값을 그대로 걸어주므로 저장을 다시 누를 필요가 없습니다. 입력창에 플러그인의 옛 기본값이 남아 있어도 암호화된 슬롯 값으로 갱신됩니다.
- 레드팀은 배치만 하고 접지 않습니다: 주입 → cap → 레드팀 본문. 대상 카드/역할 섹션 이름은 `dshpg-*`로 바꿨습니다.
- 격리된 ctx도 inject/cap을 등록합니다. #86 steer는 next-turn으로 바꿨고, #87 hang은 LF로 비교합니다.
- 레드팀 운영 지침은 "위의 프롬프트가 기준"으로 고정했습니다. 지휘 측에서는 "기관명을 주면 승인된 것"이라는 문구를 없앴습니다.

## English

- **1.1.69**.
- Peel ChatML / `project_instructions` on the wire; box and disk stay intact.
- Apply + restart hangs the current default; no extra Save. Stale plugin defaults refresh from the sealed slot.
- Redteam: inject → cap → ops only (no fold). Card/role sections renamed `dshpg-*`.
- Isolated ctx also registers inject/cap. #86 steer → next-turn. #87 hang needle uses LF.
- Redteam ops note: inject wins. Commander no longer says a company name means authorized.

# 1.1.68

## 한국어

- 버전 **1.1.68**.
- **#92**: 스킬 패널이 YAML 블록 스칼라 `description`(`|` / `>`)을 인식하므로 더 이상 사용 불가로 잘못 보고하지 않습니다.
- **#93**: 레드팀 "버전/업데이트": `file://`을 로컬 경로로 바꾸고, Windows에서는 `.cmd` + `shell`로 npm/pnpm을 실행하며, npm 404면 GitHub tags로 폴백합니다.
- **#94**: 공식 데스크톱 CLI 진입점에 `app.asar.unpacked` 폴백을 추가했습니다. Hub 최초 설치에서는 여전히 공식 asar 경로와 부딪힐 수 있습니다.
- **#95**: `refusal-recover`를 걷어냈습니다 (잘못된 필드를 읽어 트리거되지 않으며, 고치면 무한 반복됩니다).
- **#96**: bash 포그라운드 대기를 플러그인이 표시했던 600s에서 60s로 되돌려, 이후 도구가 10분씩 막히지 않습니다.
- 주입을 맨 위에 두고, capability 섹션 이름을 `dshpg-capabilities`로 바꿨으며, 사용자 prompt는 모두 followup으로 처리합니다 (#85). 자동 "계속"은 기본적으로 꺼져 있습니다.

## English

- **1.1.68**.
- **#92**: Skill panel parses YAML block-scalar `description`.
- **#93**: Redteam update: `file://` → fs path; Windows npm/pnpm via `.cmd`; GitHub tags if registry 404.
- **#94**: Desktop CLI falls back to `app.asar.unpacked`. Hub first-install may still hit stock asar.
- **#95**: Removed `refusal-recover` (dead reader / unbounded nudge loop).
- **#96**: Restore marked bash foreground wait 600s → 60s.
- Inject leads; capability section renamed; user prompt always followup; autoContinue default off.

# 1.1.67

## 한국어

- 버전 **1.1.67**.
- **#85**: continue 이어가기가 전송/429 연속 오류에서 더 이상 끝없이 맴돌지 않습니다. `takeContinue`에 failStreak 임계값을 추가했고, `refundContinue`는 `lastContinueSeq`를 지우지 않으며, 연속 3회 실패하면 바로 포기합니다.
- **#84**: 리전 차단으로 비어 있던 Assistant 스트림을 `.length`를 포함한 단일 배치 `text-chunks` 레코드로 바꿔, 더 이상 호스트 UI가 멈추지 않습니다.
- 부팅 시드: 프로세스가 시작될 때 `$DSH_HOME/prompt-inject.md`가 비어 있거나 없으면 암호화된 기본 초안을 한 번 기록합니다. 사용자가 수정한 초안은 건드리지 않습니다. 정리를 마치고 재시작을 누르면, 재시작이 성공하는 즉시 기본 프롬프트를 쓸 수 있습니다.
- Windows 공식 패키지 재시작: restart 스크립트 이름을 `pid+random`으로 바꿔 첫 실행이 동시 실행 인스턴스와 충돌하지 않게 했습니다. 불필요한 `.cmd` 중간 단계는 없애고 `wscript.exe //nologo //B`로 스크립트를 직접 실행합니다. 이 머신에 남아 있는 pid 접미사 없는 구버전 스크립트/로그가 24h를 넘으면 시작할 때 자동으로 정리합니다.
- 프로세스 종료 범위를 좁혔습니다: `ASAR_SWAP_PS1`이 더 이상 `/IM`으로 전체 이름이 같은 프로세스를 죽이지 않고, 설치 루트 아래 pid만 종료하므로 같은 이름의 서드파티 프로세스를 잘못 건드리지 않습니다.
- 공식 CLI shim을 제자리에서 다시 쓰기 전에 `.dsh-purge.bak`을 먼저 저장하고 원자적 쓰기로 처리하므로, 정전/디스크 가득 참 상황에서도 되돌릴 수 있습니다.
- 최초 설치 시나리오에서 막히지 않습니다: WScript가 clean을 판정할 때 양쪽이 모두 null(파일 없음 또는 읽기 실패)이면 시작을 허용하고, 어느 한쪽이라도 분명히 dirty일 때만 차단합니다.
- 탐지 캐시: `runningExes` / `shortcutExes`의 빈 결과는 더 이상 캐시하지 않습니다. "적용"을 누르기 전에는 `clearDesktopLocateCache()`로 여전히 강제 새로고침할 수 있습니다.
- `scheduleAsarRenameWhenIdle`의 `.rename-pending` 잠금: 시계가 되돌아가거나 30분을 넘기면 무효로 보고 지운 뒤 다시 수행합니다.
- `execFileSync`의 PowerShell 호출 세 곳에 `maxBuffer: 8MB`를 추가해, 큰 결과가 더 이상 조용히 ENOBUFS로 실패하지 않습니다.
- 기타: net-scope region gate 지수 백오프 + IPv6 regex 강화; identity `injectMatchers`가 >4096 페이로드 분할 매칭 지원, `installAssembleGuard` 멱등화; hooks-deny는 R0 폴백 규칙을 없애고 원자적 쓰기로 전환; extract-asar commit은 `nextDir`를 삭제하지 않고 `.dshpurge-recover.json`을 기록해 롤백 가능; client.js redteam preset 다중 경로 감지, shell.submit WeakMap 정리 보완.

## English

- **1.1.67**.
- **#85**: Continue loop no longer spins forever on TRANSPORT/429 streaks. `takeContinue` adds a failStreak gate; `refundContinue` leaves `lastContinueSeq` set; 3 consecutive failures abandon.
- **#84**: Region-gate empty-assistant stream becomes one batched `text-chunks` record (with `.length`), no longer hangs the host UI.
- Boot-time seeding: on startup, if `$DSH_HOME/prompt-inject.md` is empty or missing, the encrypted default is written once; a user-edited file is untouched. After the Apply → cleanup → restart cycle, the default prompt is active immediately.
- Windows official-build restart: restart script name now includes `pid+random`, so concurrent instances don't clobber each other; the `.cmd` intermediary is dropped — `wscript.exe //nologo //B` is spawned directly; legacy unsuffixed scripts/logs older than 24h are purged on each startup.
- Kill scope tightened: `ASAR_SWAP_PS1` no longer uses `/IM` to kill by full name — only pids under the install root are stopped, so same-named third-party processes aren't collateral.
- Official CLI shim repair now saves `.dsh-purge.bak` and uses atomic write before overwriting, so power loss / disk full is recoverable.
- First-install not blocked: when WScript checks for clean markers, two nulls (missing or unreadable) now pass through; only an explicit `false` blocks startup.
- Probe caches: `runningExes` / `shortcutExes` no longer cache empty results; `clearDesktopLocateCache()` on Apply still forces a refresh.
- `scheduleAsarRenameWhenIdle` `.rename-pending` lock: clock skew or ≥30-min-old lock is treated as stale and cleared.
- Three `execFileSync` PowerShell calls get `maxBuffer: 8MB` so large results no longer silent-fail with ENOBUFS.
- Also: net-scope region-gate exponential backoff + stricter IPv6 regex; identity `injectMatchers` segments >4096-char payloads, `installAssembleGuard` is idempotent; hooks-deny drops R0 fallback and uses atomic write for state; extract-asar commit no longer deletes `nextDir` and writes `.dshpurge-recover.json` for rollback; client.js redteam preset detection broadened; `shell.submit` WeakMap cleanup wired.

# 1.1.66

## 한국어

- 버전 **1.1.66**.
- **#80**: 정리 페이지에서 hooks deny / ask 우회를 끌 수 있습니다. 끄고 파일이 깨끗하면 건너뛰기로 표시하며 적용된 항목에 넣지 않습니다. 껐다가 다시 켜면 64/65가 공식 형태대로 한 번 더 적용합니다.
- **#81**: 계속 / 거부 응답 이어가기의 출처 kind를 `dsh-purge`로 바꿨습니다. 레이트 리밋과 전송 실패 시 더 이상 자동으로 한 라운드를 이어가지 않습니다.
- 재시작 후에는 저장을 누르지 않아도 기본 프롬프트가 걸립니다. 매 라운드마다 전문을 다시 채워 넣습니다. 빈 적용 요청은 더 이상 디스크의 프롬프트를 비우지 않습니다.
- 선언된 overlay가 `.dshpurge.bak`만 남았을 때는 적용 시 먼저 복사해 온 뒤 로드합니다.
- 레드팀 보고서에 득점 항목 약칭을 추가했습니다. 중국어 README의 표지 이미지와 미리보기 이미지를 복구했습니다.

## English

- **1.1.66**.
- **#80**: The clean page can turn off the hooks deny/ask bypass. Off + clean files show skipped and are not counted as applied. Turning it back on reapplies 64/65 from the official form.
- **#81**: Continue / refusal-recover use source kind `dsh-purge`. RATE_LIMIT and TRANSPORT no longer start another continue turn.
- Restart hangs the default prompt without a Save click; every step puts the full text back. An empty Apply body no longer wipes the disk prompt.
- A declared overlay that exists only as `.dshpurge.bak` is copied back before load.
- Red-team reports get short score-point names. Chinese README restores the banner and preview images.

# 1.1.65

## 한국어

- 버전 **1.1.65**.
- 기본 프롬프트를 `lib/default-prompt-inject.md` 기준으로 다시 암호화해 슬롯에 넣습니다. 디스크에 사용자가 수정한 초안이 남아 있으면 덮어쓰지 않습니다.
- 레드팀에 스크린샷 등록, 득점 항목 이미지 보기, 보고서 6개 단락을 붙였습니다. 특정 드릴을 디렉터리로 내보낼 수 있습니다.
- 스킬 본문에 도구 경로가 없거나 키가 없거나 VPS가 아직 플레이스홀더일 때, 더 이상 스킬 전체를 사용 불가로 표시하지 않습니다. 빠진 항목은 상세 정보에 남깁니다.
- 페이지를 열거나 프롬프트를 조립할 때 현재 기본 초안을 디스크에 동기화하므로 먼저 저장을 누를 필요가 없습니다.
- 호출되지 않는 데스크톱 시작 래퍼, 오래된 마이그레이션 스크립트, 이미 주석 처리된 수동 계속 진입점을 삭제했습니다.

## English

- **1.1.65**.
- The default prompt is sealed again from `lib/default-prompt-inject.md`. A prompt the user already edited on disk is left as-is.
- Red team gains shot registration, score-point images, and the six-part report. An engagement can be exported to a folder.
- A skill stays usable when a documented tool path, key, or VPS placeholder is missing. The gap stays on the skill detail.
- Opening the page or assembling the prompt writes the current default to disk, without a Save click first.
- Unused desktop launch helpers, the old migration script, and the commented manual-continue entry are removed.

# 1.1.64

## 한국어

- 버전 **1.1.64**.
- 레드팀 흐름 여덟 항목. 역할 초안은 **새 표적**을 만들 때만 시드됩니다. 이미 만들어 둔 표적은 드릴 콘솔에서 에이전트를 한 번 동기화해야 새 초안으로 바뀝니다.
- **내부 네트워크**는 리프 노드로 바꿔, 수집, 정리, 발견, 이용을 스스로 하고 더 이상 하위로 작업을 넘기지 않습니다.
- 동시 실행 슬롯: key가 없는 release는 가장 이른 한 건만 허용합니다. 하위 에이전트가 끝나면 서버가 자동으로 해제하며, 수동 해제에는 acquire가 반환한 key를 반드시 붙여야 합니다.
- 사전 점검에 `include`가 있으면 지정한 스킬만 점검하고, 전역 키 누락 때문에 실패로 떨어지지 않습니다. 빠진 항목에는 사용자가 실행할 수정 안내를 붙입니다.
- IPv6 점수는 콜론이 최소 두 개여야 하므로 `dc01:389` 같은 호스트 이름은 더 이상 ×3이 되지 않습니다. 점수 계산은 `score-rules.js`에만 둡니다.
- 공격 체인 점수는 비활성화된 득점 항목을 건너뜁니다.
- `.env`는 `export KEY=value`를 인식합니다. 따옴표가 없는 인라인 주석은 제거되고, 따옴표 안의 `#`는 유지됩니다.
- 내부 네트워크 점수 code를 `central-system`, `boundary-logical`, `boundary-strong` 등으로 바꿨으며, `redteam_score_list`의 실제 반환값을 기준으로 합니다.
- 취약점 발견과 이용은 `priority=high`에서 시작합니다. 우선순위가 비어 있으면 먼저 지휘 측에 보고해 평가를 한 라운드 보강합니다.
- 호출되지 않는 코드를 삭제했습니다. 설정 페이지의 오래된 `legacyApplyPath(...)` 호출을 `applyPathOp`로 바꿨습니다.

## English

- **1.1.64**.
- Eight red-team flow fixes. Role prompts seed **new** engagements only; sync agents on an existing engagement to pick them up.
- The internal role is a leaf and does collect, assess, scan, and exploit itself.
- A release without a key drops only the oldest reservation. Ending a subagent auto-releases; a manual release must carry the acquire key.
- Preflight `include` checks only the named skills. Broken items include fixes for the user to run.
- IPv6 scoring needs at least two colons, so `dc01:389` is no longer ×3. Scoring lives only in `score-rules.js`.
- Attack-chain scoring skips disabled score points.
- `.env` accepts `export KEY=value` and strips unquoted inline comments. A `#` inside quotes stays.
- Internal score codes match the live list (`central-system`, `boundary-logical`, `boundary-strong`, and the rest), taken from `redteam_score_list`.
- Vuln-scan and exploit start at `priority=high`. If priority is empty, report back and run another assess first.
- Unused code removed. Stale settings calls to `legacyApplyPath` now call `applyPathOp`.

# 1.1.63

## 한국어

- 버전 **1.1.63**.
- 공식 업데이트 스크립트에서 중국어 주석을 제거해 `official update script is not ASCII`가 나오지 않게 했습니다.

## English

- **1.1.63**.
- Official update script is ASCII only, so the handoff no longer fails the ASCII check.

# 1.1.62

## 한국어

- 버전 **1.1.62**.
- 계속/재시도 다시 열기.
- 앵커 게이트: 첫 라운드 출력 상한 1024→8192, 최대 2단계. 도구를 이미 호출했으면 풀리고, 영어 사고가 we 앵커를 통과하지 못해도 더 이상 막히지 않습니다.
- 기존 프리셋의 앵커 설정이 패키지 내부와 다르면 동기화하며, 전체를 덮어쓰지 않습니다.

## English

- **1.1.62**.
- Continue/retry is on again.
- Anchor gate: bootstrap cap 8192, max 2 steps; promote after the first tool call.
- Existing presets sync the anchor-gate block when it differs from the package.

# 1.1.61

## 한국어

- 버전 **1.1.61**.
- **다중 호스트 Apply**: npm-global과 데스크톱 `resources/app`을 함께 패치합니다 (#72 유형의 경로 문제).
- **#73**: 프록시 / IP / DNS 같은 benign 주제가 더 이상 공격 게이트를 잘못 건드리지 않습니다 (`net-scope.js`).
- **#74**: 사용자 지정 프롬프트 영속화 — `resolveInjectText`가 `prompt-inject.md`를 읽고, UI 저장은 `saveOverrideContent`를 거치며, 시작 시 `ensureOperatorBody`를 실행합니다.
- **미니멀**: #80은 공식 persistent-shell을 유지하고, UI에서 minimal을 고르면 `agent-preset/selected`를 기준으로 삼으며 (더 이상 세션 헤더의 `standard`에 속지 않음), `adaptInjectForMinimalPreset`이 shell-only 도구 표에 맞춥니다.
- **거부 응답 이어가기**: `refusal-recover`가 "안 합니다 / 참여하지 않습니다" 같은 문형을 인식합니다.
- 주입 체인: `injectMatchers`가 중복 구간을 방지하고, 기본 프롬프트를 `asset-table.js`에 다시 암호화해 넣습니다.

## English

- **1.1.61**.
- **Multi-host Apply**: patch npm-global and desktop `resources/app` together.
- **#73**: Benign proxy/IP/DNS topics no longer trip the attack gate.
- **#74**: Custom prompt persists via `prompt-inject.md` + `saveOverrideContent`.
- **Minimal**: #80 official shell-only preset; preset from `agent-preset/selected`; runtime `adaptInjectForMinimalPreset`.
- **Refusal recover**: broader Chinese refusal phrasing.
- Inject assembly dedupe; default prompt re-sealed.

# 1.1.60

## 한국어

- 버전 **1.1.60**.
- **미니멀 / PTC**: 표준과 같은 작업인데 차단된다면 대개 preset의 `run_code`, 샌드박스, plan 문구가 정리되지 않았거나 내장 minimal에 `agent-instructions`가 빠진 경우입니다. 이번 버전은 #60/#61/#63을 되돌리고 minimal에 플러그인을 보강합니다 (#26). **완전 종료 → 적용 → 재시작 → 새 대화 열기** 후에 다시 테스트하세요.
- **되돌리기 → 다시 보내기**: "한 번 되돌리기 / 이전 라운드 되돌리기"는 현재 대화에 남고, 이미 보낸 문장은 입력창으로 돌아가며, 이번 라운드의 어시스턴트 출력과 todo는 철회됩니다. **1.1.60**부터는 **현재 라운드**를 기준으로 위치를 잡으므로, 여러 라운드를 거쳐도 다시 첫 사용자 메시지로 돌아가지 않습니다 (#74/#75 + `lib/rewind.js`).
- **적용 / 재시작**: 사용자가 적용, 재시작을 누를 때 client 패키지에 기록해 "정리가 완료되지 않아 재시작을 취소했습니다"라는 잘못된 알림을 피합니다.
- 기본 프롬프트를 `default-prompt-inject.md`에서 **다시 암호화**해 `asset-table.js`에 넣습니다. 런타임에는 암호화된 슬롯만 읽습니다.
- **#66** Windows에서 `app.asar`에 JScript가 없으면 PowerShell로 패키지를 교체합니다. **#67** `dsh.cmd` 언패킹 경로. **#69** 드릴 콘솔 `position:fixed`. **#71** assemble 가드 멱등화. **#70** 스킬 경로를 이 머신의 OS 기준으로 판정. **#68** 문서를 `desktop` profile + `.tar.gz`로 변경 (Hub 원클릭은 여전히 git을 사용하며, README 참고).

## English

- **1.1.60**.
- **Minimal / PTC**: Same task blocked while standard works → uncleared `run_code`, sandbox, or plan text, or minimal preset missing `agent-instructions`. This release flips #60/#61/#63 and adds the plugin on minimal (#26). **Quit fully → Apply → Restart → new chat** before retesting.
- **Rewind → resend**: Rewind buttons stay in the same chat; your last user line returns to the composer and this round’s assistant output/todos drop. From **1.1.60**, bounds follow the **current turn**, not the first user message (#74/#75 + `lib/rewind.js`).
- **Apply / restart**: User Apply/Restart writes client bundles so restart is not cancelled as “clean incomplete”.
- Default prompt **re-sealed** into `asset-table.js`; runtime reads the encrypted slot only.
- **#66** asar swap PS fallback; **#67** `dsh.cmd`; **#69** dock fixed; **#71** idempotent assemble guard; **#70** skill paths per host OS; **#68** docs: `desktop` + `.tar.gz` (Hub one-click still git — see README).

# 1.1.59

## 한국어

- 버전을 1.1.59로 업그레이드했습니다.
- 적용을 누른 뒤 호스트 경로나 이전 표시가 맞지 않는다는 이유로 "정리가 현재 호스트에 기록되지 않았습니다"라고 보고하지 않습니다 (#65).
- `resources\app\node_modules`와 `resources\app\dsh\node_modules`를 모두 인식합니다. 원문에 이미 공식 신원 문장이 없거나 주입이 빠진 형태일 때는 그 두 표시를 더 이상 요구하지 않습니다.
- complete 섹션 패치는 tab과 공백을 함께 인식합니다.

## English

- Version 1.1.59.
- Apply no longer reports that the clean missed the current host just because the package path or the old markers do not match (#65).
- Both `resources/app/node_modules` and `resources/app/dsh/node_modules` count. If the official identity sentence and the inject-dropping return are already gone, those two markers are not required.
- The complete-prompt patch matches both tab and space indentation.

# 1.1.58

## 한국어

- 버전을 1.1.58로 업그레이드했습니다.
- 열기, 적용, 재시작 모두 프롬프트를 걸어줍니다. 디스크에 본문이 있으면 디스크를, 없으면 규칙 세트를, 그것도 없으면 내장 기본값을 쓰므로 저장을 다시 누를 필요가 없습니다.
- 시작할 때 페이지가 나간 뒤에 프론트엔드 client.js를 다시 쓰지 않으므로, 모듈 버전 번호가 맞지 않아 입력창이 사라지는 일이 없습니다 (#63).
- macOS / Linux에서 이미 언패킹된 데스크톱에서 적용을 누르면 종료 후 다시 열립니다. 정리 표시는 두 가지 표기를 모두 인식합니다 (#64).

## English

- Version 1.1.58.
- Open, Apply, and restart all hang the prompt. A saved file wins, then the active rule set, then the built-in default. Save is not required.
- Startup no longer rewrites frontend client.js after the page has taken a module revision, so the composer does not disappear (#63).
- Unpacked macOS and Linux desktop builds quit and relaunch after Apply. Both inject markers count as clean (#64).

# 1.1.57

## 한국어

- 버전을 1.1.57로 업그레이드했습니다.
- 적용 후 재시작하면 설정 상자의 프롬프트가 시스템 섹션에 바로 걸립니다. 상자가 비어 있으면 현재 규칙 세트를 씁니다. 둘 다 비어 있으면 멈추고 입력을 요구합니다.
- 창작, PTC, 미니멀, unrestricted, 량신(Liangshen)도 표준 모드와 마찬가지로 차단과 금지를 정리하고 각자의 도구 흐름을 유지합니다.
- 드릴 승인은 이 머신의 디렉터리에 저장되어 업데이트 후에도 다시 승인할 필요가 없습니다. 제거가 성공한 뒤에만 정리합니다. 빈 환경 초기화는 더 이상 설정 완료로 취급하지 않습니다.
- 공식 Messages 요청의 system 필드를 현재 시스템 프롬프트로 바꿔, 더 이상 첫 번째 프롬프트에 고정하지 않습니다.

## English

- Version 1.1.57.
- After Apply and restart, the settings-box prompt is hung on the system section. An empty box uses the active rule set. If both are empty, Apply stops and asks for a prompt.
- Cordis, PTC, minimal, unrestricted, and Liangshen clear intercepts and bans the same way standard does, and keep their own tools.
- Drill authorization is stored in this install and survives updates. It is cleared only after uninstall succeeds. An empty environment init is no longer treated as configured.
- The official Messages request system field uses the current system prompt instead of the first snapshot.

# 1.1.56

## 한국어

- 버전을 1.1.56로 업그레이드했습니다.
- 적용은 설정 상자, 현재 규칙 세트, 공식 시스템 프롬프트 순서로 선택합니다. 상자가 비어 있고 규칙도 없으면 멈추고 입력을 요구하며, 내장 기본값을 디스크에 더 이상 기록하지 않습니다.
- 정리와 드릴 콘솔이 DSH 테마를 따르는 투명 유리를 사용하며, 수동 색상 전환을 없앴습니다.
- 설명에는 공식 Web과 공식 데스크톱만 남겼습니다.

## English

- Version 1.1.56.
- Apply uses the settings box, then the active rule set, then the official system prompt. An empty box with no rules asks for a prompt and does not write the built-in default to disk.
- 정리 and the drill console use transparent glass that follows the DSH theme. The manual theme switch is gone.
- Docs keep official Web and the official desktop only.

# 1.1.55

## 한국어

- 버전을 1.1.55로 업그레이드했습니다.
- "적용"을 누르고 재시작하면 매 라운드 assemble에서 프롬프트를 맨 앞에 다시 채워 넣습니다. 호스트가 새 assemble로 바뀌어도 한 번 더 감싸므로 두 번째 라운드에서 잃어버리지 않습니다.
- 빈 상자가 더 이상 프론트엔드에서 적용을 잘못 취소하지 않습니다. 재시작 전에 기본 프롬프트를 먼저 기록합니다. 밀봉된 asar는 현재 프로세스가 아직 구버전 패키지라서 재시작을 취소하지 않습니다.
- 두 번째 적용에서도 쿨다운 때문에 재시작/주입이 취소되지 않습니다. 밀봉 패키지는 교체되기 전까지 적용할 때마다 한 번 재시작하며, 패치를 다 쓴 뒤에는 더 이상 헛돌지 않습니다.

## English

- Version 1.1.55.
- After Apply + restart, every assemble turn puts the operator prompt back at the front. If the host replaces assemble, it is wrapped again so turn 2 does not drop the inject.
- An empty settings box no longer cancels Apply on the client; Restart seeds the default prompt first. A sealed asar no longer cancels restart just because the running process still has the old archive.
- A second Apply is not treated as a cancel because of settle cooldown. A sealed archive still restarts on each Apply until swapped; after patches are in, it does not loop.

# 1.1.54

## 한국어

- 버전을 1.1.54로 업그레이드했습니다.
- 공식 데스크톱 밀봉 asar 시작 시 더 이상 중간에 언패킹/프로세스 종료를 하지 않습니다: Host Fiber._reload의 INACTIVE_EFFECT / DesktopHostFatalError를 피하고, 패치는 설정 페이지의 "적용"에 맡깁니다.
- 데스크톱 settle은 연기되고 context가 비활성화되면 종료됩니다; 시작 시 자동 복구는 디스크에만 쓰고 scheduleRestart를 호출하지 않습니다 (#59 / #60 / #61).
- 마켓 tar 설치와 빈 sha / installed-rev 누락 상태의 무한 재시작 수정은 그대로 유지됩니다 (#58–#61, 1.1.53).

## English

- Version 1.1.54.
- Official desktop no longer unpacks or kills the host mid-boot on a sealed asar; that raced Fiber._reload and threw INACTIVE_EFFECT / DesktopHostFatalError. Patches wait for Settings Apply.
- Desktop settle is delayed and aborts on an inactive context; startup self-heal writes files only and does not scheduleRestart (#59 / #60 / #61).
- Marketplace tarball install and empty-sha / missing installed-rev restart loops remain fixed (#58–#61, 1.1.53).

# 1.1.53

## 한국어

- 버전이 1.1.53으로 업그레이드되었습니다.
- "적용"을 누른 뒤 무한 재시작되던 문제를 수정했습니다 (#59 / #60 / #61): tarball 설치에 `installed-rev`가 없거나 `applied.json`의 sha가 비어 있으면 시작 시 더 이상 reapply+restart를 반복하지 않습니다; 정렬된 뒤에는 헛되이 재시작하지 않고 쿨다운을 둡니다.
- web 자동 복구 재시작이 더 이상 브라우저를 자동으로 띄우지 않으므로, 창을 닫은 뒤 새 창이 반복해서 열리지 않습니다 (#59 / #61).
- 빈 sha는 호스트가 밀봉 상태가 아니고 정리 표시가 남아 있을 때(또는 플러그인 루트를 찾을 수 없을 때)에만 스탬프를 보충하여, 밀봉 호스트의 자동 복구를 덮어쓰지 않습니다 (#56 / #57).
- 마켓 설치: `package.json`에 tar.gz/zip 우선을 명시하여 Hub가 `git ls-remote` 실패로 되돌아가지 않게 했습니다 (#58).

## English

- Version 1.1.53.
- Stop Apply/startup infinite restart (#59 / #60 / #61): missing `installed-rev` after tarball install or empty `applied.json` sha no longer reapply+restart every boot; skip restart once aligned, with a cooldown.
- Web self-heal restart does not open a browser, so closing the window no longer respawns tabs (#59 / #61).
- Empty-sha heal only runs when the host is not sealed and markers are present (or the plugin root is missing), so sealed-host self-heal still works (#56 / #57).
- Marketplace install prefers tar.gz/zip in `package.json` so Hub does not fall back to a failing `git ls-remote` (#58).

# 1.1.52

## 한국어

- 버전이 1.1.52로 업그레이드되었습니다.
- 공식 데스크톱의 "적용/재시작"이 더 이상 공식 installer를 자동 실행하지 않습니다 (#57): 호스트 버전은 사용자가 직접 업그레이드하며, 플러그인은 압축 해제와 패치만 하여 디스크에 쓰기 전에 실패로 오판해 `resources\\app`을 지우는 일을 막습니다.
- `applied.json`이 있는데 호스트가 다시 sealed 상태로 돌아갔거나 플러그인 루트를 찾을 수 없으면 미정렬로 판정하고 자동 복구로 다시 패치합니다; 패널에는 "패치가 사라졌으니 다시 적용하세요"를 표시합니다.
- 플러그인 시작 경로는 절대 자동 업데이트하지 않으며, 패널에서만 수동으로 업데이트합니다.
- 기본 프롬프트를 로컬 `default-prompt-inject.md` 기준으로 다시 암호화해 `asset-table.js`에 기록합니다.
- 사용자가 고친 프롬프트는 "적용"으로 암호화된 기본값에 덮이지 않습니다: 디스크 본문이 내장 기본값과 다르면 항상 유지하고, 런타임의 내장 기본값은 암호화 슬롯에서만 읽습니다.
- 되돌리기 지점을 한 라운드 전체로 넓히고 교체 후 derive 캐시를 비워, 다음 전송에 취소된 내용이 다시 실리지 않게 했습니다.

## English

- Version 1.1.52.
- Official desktop Apply/Restart no longer auto-runs the official installer (#57); users upgrade the host themselves; the plugin only unpacks and patches.
- If `applied.json` exists but the host is sealed again / plugin root is missing, treat as mismatched and reapply; UI shows patches-lost.
- Plugin startup never auto-updates; update only from the panel.
- Reseal the default prompt from local `default-prompt-inject.md` into `asset-table.js`.
- Keep user-replaced prompts: never overwrite disk text that differs from the bundled sealed default; runtime bundled default comes only from the sealed slot.
- Rewind cuts the whole last turn and invalidates derive cache so the next send does not keep undone content.

# 1.1.51

## 한국어

- 버전이 1.1.51로 업그레이드되었습니다.
- `/skills import`가 `$DSH_HOME/skills` 자신을 가져올 때 먼저 지우고 복사해 스킬이 비워지던 문제를 수정했습니다 (#54).
- `platformEnvAdaptStatus` / `platformEnvAdaptSkip`을 구현하여 전송 게이트가 더 이상 "환경이 아직 준비되지 않았다"고 잘못 알리지 않습니다 (#55).
- 공식 데스크톱 수정: 버전이 없거나 같은 버전인 `installer.exe`를 업데이트 대기로 오인해 재시작을 가로채던 문제, 업데이트 실패 시 `resources/app` 복원, 빈 sha의 applied stamp가 reapply를 건너뛰던 문제 (#56, 0.1.7/0.2 동일 경로).
- 패치 #52는 `.volatile()` 표기가 없는 경우와 호환됩니다; #57은 `useDeveloperRole`까지 따라가 responses 경로를 덮습니다; #48은 업스트림에서 문장이 삭제되면 소프트 완료로 처리합니다; 상태에 `patches_ready`를 내보냅니다; 데스크톱 shim은 "이 쪽에서는 필요 없음"을 표시합니다.

## English

- Version 1.1.51.
- Reject `/skills import` when source overlaps `$DSH_HOME/skills` so delete-then-copy cannot wipe skills (#54).
- Implement `platformEnvAdaptStatus` / `platformEnvAdaptSkip` so the send gate no longer false-blocks ready environments (#55).
- Official desktop: ignore unversioned/same-version `installer.exe` pending updates; restore `resources/app` if update handoff fails; empty applied stamp sha no longer skips reapply (#56, same path on 0.1.7 and 0.2).
- Patch #52 matches non-`.volatile()` defaults; #57 follows `useDeveloperRole` and covers responses; #48 soft-settles when upstream removed the caution text; export `patches_ready`; desktop shim shows not-needed-here.

# 1.1.50

## 한국어

- 버전이 1.1.50으로 업그레이드되었습니다.
- macOS 공식 데스크톱 수정: "적용"을 눌렀을 때 "실패: 재시작 중."이라는 거짓 실패, 압축 해제 후 `dsh` CLI가 동작하지 않던 문제, status가 ✗로 잘못 표시되던 문제 (#53).
- "적용" 후 재시작하면 기본 프롬프트가 주입되지 않던 문제를 수정했습니다: 수정한 적이 없으면 내장 기본값을 자동으로 디스크에 기록하므로 먼저 저장을 누를 필요가 없습니다.

## English

- Version 1.1.50.
- Fix macOS official desktop: Apply false "Failed: Restarting.", broken `dsh` CLI after asar unpack, and status ✗ false negatives (#53).
- Fix default prompt not injecting after Apply + restart; bundled default is written without requiring Save first.

# 1.1.49-beta.1

## 한국어

- 버전이 1.1.49-beta.1로 업그레이드되었습니다 (#53 테스트 버전).
- macOS 공식 데스크톱에서 "적용"을 누른 뒤 "실패: 재시작 중."이라는 거짓 실패가 뜨던 문제를 수정했습니다: `scheduleRestart`의 helper/runtime 분기에 `restarting: true`를 되살렸습니다; Darwin 재시작은 osascript 정상 종료 + SIGTERM/SIGKILL로 바꾸고, CLI 프로세스를 제외한 뒤 `open`으로 다시 열도록 했습니다 (ELECTRON_RUN_AS_NODE 제거).
- app.asar 압축을 푼 뒤 공식 `dsh` CLI 진입점(asar/`app/` 대체 경로)을 자동으로 패치하고 `app/runtime -> ../runtime`을 보충하여 `dsh web` 등이 전부 MODULE_NOT_FOUND가 되는 일을 막습니다.
- `/purge status`가 여러 경로의 파일 목록을 배열로 항목별 판단하여, 이미 패치된 파일을 ✗로 표시하지 않습니다.
- 프런트엔드 재시작 실패 문구가 성공 분기의 note를 error로 취급하지 않습니다.

## English

- Version 1.1.49-beta.1 (prerelease for #53).
- Fix macOS official desktop Apply false failure "Failed: Restarting.": helper/runtime branches of scheduleRestart return restarting:true; Darwin restart uses osascript quit then SIGTERM/SIGKILL, skips CLI processes, relaunches via open without ELECTRON_RUN_AS_NODE.
- After unpacking app.asar, auto-patch the official dsh CLI entry (asar/app fallback) and add app/runtime -> ../runtime so dsh web and other subcommands keep working.
- /purge status treats multi-path file lists correctly instead of marking patched files as missing.
- Restart failure UI no longer uses the success note as the error detail.

# 1.1.48

## 한국어

- 버전이 1.1.48로 업그레이드되었습니다.
- 레드팀 지휘의 "일만 배분" 제약이 조립 과정에서 잘못 삭제되어 subagent를 배분하지 않던 문제를 수정했습니다; 프리셋은 Agent Teams 환경에서 classic subagent를 강제로 다시 엽니다.
- 작업별로 skill/MCP를 골라 쓰는 규약을 추가했습니다 (먼저 카탈로그를 읽고 작업에 맞춰 호출하며, 하위 에이전트와 레드팀도 동일); 공식 등록과 도구 표면은 바꾸지 않습니다.
- 하위 에이전트 maxDepth가 0.2의 default 없는 schema에 맞도록 조정하고 기본값 10을 되살렸습니다.

## English

- Version 1.1.48.
- Fix redteam lead dispatch-only SOP being stripped during assemble; re-enable classic subagent under Agent Teams in the redteam preset.
- Add task-matched skill/MCP selection protocol (read catalog, then call what the task needs; same for subagents and redteam). Does not change official registration.
- Raise subagent maxDepth default to 10 on 0.2 schemas that dropped .default().

# 1.1.47

## 한국어

- 버전이 1.1.47로 업그레이드되었습니다.
- 드릴 콘솔의 "환경 적응"을 `platformConfigGet` / `Save` / `AssignToolkit`에 연결하고 `unknown op: platformConfigGet` 오류를 수정하여, 도구 경로와 FOFA/VPS 설정을 정상적으로 읽고 쓸 수 있습니다.
- 스킬 라이브러리 디렉터리 탐색에 `$DSH_HOME/redteam/skills`를 추가하고, Windows에서는 `homedir()`로 대체하여 빈 `HOME`만 믿지 않습니다.
- 지식 베이스는 환경 적응의 nuclei 템플릿 경로를 우선 사용하고, 라이브러리가 비어 있으면 로컬 `knowledge.db` 경로를 표시하여 인터페이스가 죽은 것으로 잘못 판단하지 않게 합니다.
- 첫 설치 시 사용자 안내를 띄웁니다: 용도, 무료 오픈 소스, GitHub 저장소 주소를 설명하고, 작성자 몰래 영리를 취하면 법적 책임을 묻는다는 점과 불법 용도 금지를 알립니다. 확인하면 이 기기에서는 다시 표시하지 않습니다.
- 데스크톱 위치 탐지와 표면 감지를 완화하여 설치 디렉터리 이름에 `DeepseekHarnessDesktop` 등이 있어도 로컬 Harness를 찾을 수 있습니다; 실패한 위치 캐시가 계속 "아직 찾지 못함"에 머무르지 않습니다.
- 되돌리기와 요청 경로를 조금 손보아, 뒤쪽 라운드에서 멈추거나 진행률이 잘못 보이는 상황을 줄였습니다.

## English

- Version 1.1.47.
- Wire drill Env adapt ops `platformConfigGet` / `Save` / `AssignToolkit`, fixing `unknown op: platformConfigGet` so tool paths and FOFA/VPS config work again.
- Skill catalog also probes `$DSH_HOME/redteam/skills` and falls back with `homedir()` on Windows when `HOME` is empty.
- Knowledge prefers nuclei templates from Env adapt; empty libraries show the local `knowledge.db` path so a missing API is not assumed.
- First install shows a user notice: what the plugin does, that it is free/open source, the GitHub repo URL, legal warning against profit behind the author, and illegal-use prohibitions. After confirm it does not show again on that machine.
- Broader desktop locate/surface detection (including `DeepseekHarnessDesktop` installs); failed locate caches no longer stick on "host not located".
- Small rewind/request-path fixes to reduce later-turn hangs and misleading progress.

# 1.1.46

## 한국어

- 버전이 1.1.46으로 업그레이드되었습니다. 1.1.45는 문제가 있으니 건너뛰고 설치하지 마세요. - 기본 프롬프트를 `default-prompt-inject.md` 기준으로 다시 암호화해 기록합니다. - 주입 불안정 수정: 두 번째 라운드나 작업 도중에 페르소나가 사라지고, 모델이 system 주입을 `project_instructions`로 여겨 거부하던 문제입니다. - 워크스페이스 대체 문구와 스코프 설명을 0.1.7 우선순위로 되돌렸습니다: `system`, `developer`(`eveloper`로 잘려 있음), 사용자 원문 지시를 덮지 않습니다. 메인 intro의 소프트 거부 방지 문장은 그대로 둡니다. 겹쳐 있던 스코프 강제 문단은 그 한 문장으로 다시 줄였습니다. - 모델에 들어가기 전에 바깥 ChatML / `<project_instructions>` 껍데기를 벗겨, 실제 system 주입이 프로젝트 설명으로 읽히지 않게 합니다. - 조립된 시스템 프롬프트 구간은 `text`가 항상 문자열이 되도록 보장하고, 세션에 sections 전체를 고정하지 않아 두 번째 라운드에서 `renderPrompt`가 `undefined.length`로 바로 죽고 `(gateway/internal)`을 보고하던 문제를 막습니다. - `agent/pre-step`에서 `decision.messages`를 항상 배열로 정규화하여, 두 번째 전송이 빈 messages에서 터지지 않게 합니다. - 지역 게이트: 주소가 여럿인 도메인은 그중 하나가 통제 지역으로 해석된다는 이유만으로 사이트 전체를 막지 않습니다 (CDN/다중 회선 노이즈 IP). - 되돌리기 후 `deriveMessages` / `systemNodes`가 `content` 누락을 견디므로, 다시 보낼 때 `(gateway/internal)`로 실패하지 않습니다. - 정리 진행률: 호스트를 아직 찾지 못했을 때 무서운 `0/63`을 표시하지 않고, 이 기기에서 필요 없거나 컴포넌트가 설치되지 않은 항목은 준비됨으로 세어 가짜 `48/63`이 나오지 않게 합니다. - "적용"을 누르면 기본 프롬프트를 기록하고 주입하며, 입력란이 비어 있으면 내장 기본값을 쓰므로 먼저 저장을 누를 필요가 없습니다. - 되돌리기 수정: `snapshotEvents()`가 비어 있을 때 더 이상 `undefined.length`를 읽지 않으므로 `(gateway/internal)` 오류로 되돌리기가 무효가 되지 않습니다.
## English

- Version 1.1.46. Skip 1.1.45; that version has bugs. Do not install it.
- Reseal the default prompt from `default-prompt-inject.md`.
- Fix unstable inject: persona dropping on the second turn or mid-task, including cases where the model treated the system inject as `project_instructions` and rejected it.
- Replacement and scope workspace intros match 0.1.7 again: they do not override system, developer, or direct user instructions. The main intro anti-soft-refuse text stays. A stacked scope paragraph is collapsed back to that one sentence.
- Strip outer ChatML / `<project_instructions>` wrappers before the text reaches the model, so a real system inject is not read as project instructions.
- Sanitize assembled system-prompt sections so `text` is always a string; stop pinning full sections for a session, which could make the second turn crash in `renderPrompt` on `undefined.length` with `(gateway/internal)`.
- Always normalize `decision.messages` to an array in `agent/pre-step`, so a second send does not die on a missing messages list.
- Region gate: multi-address hosts are no longer blocked just because one resolved IP is in a controlled region (CDN/noise).
- After rewind, `deriveMessages` / `systemNodes` tolerate missing `content`, so resend no longer fails with `(gateway/internal)`.
- Clean progress: do not show a scary `0/63` before the host is located; items not needed on this install count as ready, so a fake `48/63` no longer appears.
- Apply writes and injects the default prompt; an empty box uses the bundled default, so a separate Save is not required.
- Fix rewind: empty `snapshotEvents()` no longer reads `undefined.length`, so undo no longer fails with `(gateway/internal)`.

# 1.1.44

## 한국어

- 버전이 1.1.44로 업그레이드되었습니다. - 공식 데스크톱이 `app.asar` 압축을 풀 때 먼저 옆 디렉터리에 쓰고, 압축 해제가 끝난 뒤에 `resources/app`으로 교체합니다. 그 디렉터리에 이미 호스트가 있으면 이후로는 그 파일들만 고칩니다. 같은 아카이브가 다시 나타나면 옆으로만 치웁니다. 아카이브의 크기나 시간이 바뀌었거나 디렉터리가 없어졌을 때만 다시 한 번 풉니다. 압축 해제가 멈추거나 패치가 다 쓰이지 않으면 이전 것을 되돌려 놓고 업그레이드 표시는 다음 시작으로 넘깁니다. - 되돌리기는 직전 라운드에서 이미 보낸 마지막 메시지와 그 응답만 취소하고, 더 이전 라운드는 대화에 남겨 두되 모델 요청에서는 뺍니다. 연속 되돌리기 후 남은 빈 표시는 다음 라운드 요청에 들어가지 않으며, 다음 문장은 새 메시지로 보냅니다. - 편집 가능한 프롬프트는 통째로 시스템 프롬프트 맨 앞에 두고, 같은 본문을 두 번 붙이지 않습니다. 매 단계마다 현재 이 본문으로 첫 시스템 프롬프트를 교체합니다. - deepseek.com 관련 지시는 system 역할로 고정해 보내고, 사고 과정은 예전처럼 전송합니다. - 지역 차단은 이번 작업의 대상만 봅니다. 자체 서버는 목록에 있는 그 주소나 호스트 이름만 인정합니다. 금지 문장을 쓴 뒤에 이번 라운드가 끝납니다. - 공식 모드는 항상 CTF가 포함된 기본 프롬프트를 씁니다. 레드팀이 규칙 세트를 켜면 규칙 세트만 쓰고, 그렇지 않으면 CTF를 뺀 기본 프롬프트에 레드팀 절차를 이어 붙입니다. 하위 에이전트도 메인 세션과 같은 본문을 받습니다. 디스크에 프롬프트가 없으면 시작할 때 기본값을 쓰므로 먼저 저장을 누를 필요가 없습니다.
## English

- Version 1.1.44.
- Unpacking `app.asar` writes beside `resources/app` and swaps in only after the unpack finishes. Once that directory is usable, later starts only edit those files. The same archive showing up again is moved aside. A new size or mtime, or a missing directory, is unpacked once. If unpacking sticks or that patch round does not finish, the previous directory is put back and the upgrade marker stays for the next start.
- Rewinding the previous round removes only that sent message and its reply. Earlier rounds stay on screen and leave the next model request. Leftover rewind markers stay off the next model request, so the next send is a new message.
- The editable prompt is placed once at the front of the system prompt. Each step replaces the first system prompt with that current text.
- Instructions for deepseek.com stay on the system role. Thinking is still sent.
- The region check looks only at this task's target. An own server is allowed only when that exact address or hostname is on the list. The turn ends after the denial sentence is written.
- Official mode always uses the default prompt, including CTF. Red team uses only the active rule set, or the default prompt without CTF followed by the red team steps. Subagents receive the same inject as the main session. If the prompt file is empty, startup uses the bundled default without requiring Save.

# 1.1.43

## 한국어

- 버전이 1.1.43으로 업그레이드되었습니다. - 로컬 Harness가 아직 확인되지 않았을 때는 각 행을 건너뜀으로 표시하지 않고, 건너뛴 항목도 그룹 합계에서 완료로 세지 않습니다. - 패치 목록을 52개 항목 전부로 채워 총계가 그룹과 맞습니다. - 호스트 디렉터리를 찾지 못한 결과를 프로세스가 끝날 때까지 캐시하지 않습니다.
## English

- Version 1.1.43.
- Before this install is located, rows are no longer shown as skipped, and a skip no longer counts as done in the group total.
- The patch list now includes all 52 items, so the total matches the groups.
- A miss while looking up the host directory is not cached for the rest of the process.

# 1.1.42

## 한국어

- 버전이 1.1.42로 업그레이드되었습니다. - 정리 페이지의 프롬프트 아래에서 자체 서버를 등록할 수 있습니다: 한 줄에 IP 하나 또는 정확한 호스트 이름을 적고 목록 저장을 누르세요. 설명서에 절차와 스크린샷이 있습니다. - 새 대화는 프롬프트를 시스템 프롬프트 맨 앞에 둡니다. 패널은 백묵 유리로 바뀌어 라이트와 잉크 두 테마 모두 글자가 잘 보입니다. - 패치 진행률은 적용된 항목만 셉니다. 웹 표면 신원 항목은 다음 항목에서 문장을 고쳐 쓴 뒤에도 적용됨으로 표시됩니다. - 0.1.x 진입 지점용 니들을 추가했습니다. 이미 패치된 0.2.0 호스트는 다시 쓰지 않습니다.
## English

- Version 1.1.42.
- Under Prompt on the Clean page, register your own server: one IP or exact hostname per line, then Save list. The docs include the steps and a screenshot.
- New chats place the prompt at the front of the system prompt. The dock is frosted glass, and both the light and ink themes stay readable.
- The patch count includes only applied items. The web-surface identity row stays applied after the later sentence rewrite.
- Needles for 0.1.x entry points were added. An already patched 0.2.0 host is not rewritten.

# 1.1.41

## 한국어

- 버전이 1.1.41로 업그레이드되었습니다. - 공식 모드는 현재 프롬프트만 주입하고, 규칙 세트를 켜면 규칙 세트를 기준으로 삼습니다. 레드팀은 레드팀 운영 요구 사항을 덧붙입니다. - 되돌리기는 현재 세션에 머뭅니다: 되돌리기를 한 번 또는 이전 라운드까지 선택하고, 마지막 문장을 입력창에 돌려놓고, 이미 보낸 내용을 지웁니다. - 호스트 정리가 끝나지 않았거나 주입할 프롬프트가 없으면 재시작하지 않습니다. - 기본이 이미 완전 권한이면 새 세션이 제한 권한으로 다시 고정되지 않습니다. 공식 모델의 Session Log 업로드는 기본으로 꺼져 있습니다. - 대상 주소가 중국 본토, 홍콩, 마카오에 있으면 중단합니다.
## English

- Version 1.1.41.
- Official modes inject the editable prompt, or the active rule set when one is enabled. Red team also keeps its operating section.
- Rewind stays on the current session: choose one step or the last round, return the last line to the composer, and clear what was already sent.
- Restart is cancelled unless the host is cleaned and inject text is present.
- A full-access default is no longer pinned back to a restricted preset. Official model Session Log upload is off by default.
- Targets whose addresses fall in mainland China, Hong Kong, or Macau are stopped.

# 1.1.40

## 한국어

- 버전이 1.1.40으로 업그레이드되었습니다. - **DSH 0.2.0-rc.2**에 맞췄습니다: `Anthropic`(`nthropic`로 잘려 있음) OAuth가 더 이상 시스템 프롬프트 맨 앞에 "You are Claude Code…"를 강제로 끼워 넣지 않으므로, 사용자 정의 `prompt-inject`가 뒤로 밀리지 않습니다. - 0.2에 이미 없는 **patch 41**(`developer`가 `eveloper`로 잘려 있음, developer 역할 재작성)을 제거해 무효 패치가 자리를 차지하지 않게 했습니다. - 설정 페이지에서 **적용**을 누르면 성공 후 호스트가 **자동으로 재시작**되므로, 플러그인을 다시 열어 두 번째 재시작을 누를 필요가 없습니다.
## English

- Version 1.1.40.
- For **DSH 0.2.0-rc.2**, Anthropic OAuth no longer prepends "You are Claude Code…" ahead of your system prompt, so custom `prompt-inject` is not pushed behind a Claude identity block. (In the original file the opening smart quote is damaged into `ou`.)
- Removed **patch 41** (developer-role remap) because those needles are gone in 0.2.
- After **Apply** in settings, the host **restarts automatically**; you no longer need to open the plugin again to confirm restart.

# 1.1.39

## 한국어

- 버전이 1.1.39로 업그레이드되었습니다. - 중국어 Windows에서 공식 데스크톱 버전의 "설치 및 다시 시작"이 더 이상 "다시 시작 준비 중"에서 멈추지 않습니다. 업데이트 스크립트의 첫 줄을 순수 ASCII로 바꾸고, 경로에 있는 중국어를 `\u` 이스케이프로 적어 Windows Script Host가 GBK로 읽을 때 줄바꿈을 주석 안으로 삼키지 않게 했습니다. - macOS와 Linux는 이 스크립트를 쓰지 않으며 재시작 방식은 그대로입니다.
## English

- Version 1.1.39.
- On Chinese Windows, the official desktop install-and-restart no longer stays on preparing to restart. The update script starts with an ASCII comment, and non-ASCII paths are written as `\u` escapes, so Windows Script Host does not swallow the newline when it reads the file as GBK.
- macOS and Linux do not use this script. Their restart path is unchanged.

# 1.1.38

## 한국어

- 버전이 1.1.38로 업그레이드되었습니다. - 레드팀이 더 이상 사용자를 대신해 도구를 내려받지 않습니다. 설치 스크립트가 없으면 안내가 드릴 콘솔의 "환경 구성"으로 이어지고, 경로는 사용자가 직접 채웁니다. - 오래 걸리는 작업은 시스템 프롬프트에 "이번 대상" 카드를 넣습니다. 지휘 측과 하위 에이전트가 같은 카드를 보며, 이 조직만 다루고 결과에 나오는 다른 이름으로 옮겨 가지 않습니다. 하위 에이전트는 역할별 프롬프트를 쓰고, 작업을 배정할 때 쓰는 이름은 반드시 이 카드와 같아야 합니다. - 도구 조회는 배포판의 실제 파일 이름을 인정합니다. 예를 들어 Kali의 `httpx-toolkit`과 `impacket-secretsdump`이고, Python의 `httpx`를 스캐너로 취급하지 않습니다. - 공식 데스크톱은 macOS와 Linux에서도 `app.asar`를 찾습니다(Mac은 `Contents/Resources`). Windows 이외에서는 `require`를 망가뜨리던 콘솔 숨김 래퍼를 더 이상 설치하지 않습니다. - 레드팀 진입 앵커 게이트: 처음 몇 단계의 출력 상한은 1024이고, 첫 사고 블록에 `we`가 있고 `let me`가 없으면 상한이 풀리며, 그렇지 않으면 같은 턴에서 최대 4단계까지만 유지됩니다. 컨텍스트 압축이 일어나면 게이트가 다시 닫힙니다. 레드팀 도구와 페르소나는 그대로입니다. - 동봉 스킬은 `$DSH_HOME/redteam/skills`로 동기화되고, 프리셋은 `dshHomePath`로 그곳을 가리키며, 특정 컴퓨터의 `node_modules` 경로를 프리셋에 적지 않습니다. 사용자 자신의 스킬은 여전히 `$DSH_HOME/skills`에 있고 같은 이름이면 사용자 것을 따릅니다. - 레드팀 모드가 표시되지 않던 문제를 고쳤습니다: 프리셋을 선언할 때 경로 변수가 빠져 플러그인이 중간에 종료되어 모드 드롭다운에 이 항목이 없었습니다. - 설명에 후원 주소를 다시 넣었습니다(원문 손상 표기: `inux`, `ac`, `indows`).
## English

- Version 1.1.38.
- Red team no longer downloads tools for you. When the setup script is missing, the guide points at the drill console environment page so you fill in the paths.
- Long jobs keep a target card in the system prompt. The commander and subagents see the same card: stay on that organization, and do not switch to other names that show up in results. Each subagent loads its own role text, and dispatched work must use the name on the card.
- Tool lookup accepts distro filenames such as Kali's `httpx-toolkit` and `impacket-secretsdump`, and does not treat Python's `httpx` as the scanner.
- The official desktop app can find `app.asar` on macOS and Linux (`Contents/Resources` on Mac). Outside Windows, the console-hide wrapper that broke `require` is not installed.
- Red team uses an anchor gate: the first steps are capped at 1024 output tokens, the cap lifts when the first reasoning block contains `we` and not `let me`, otherwise it lasts at most 4 steps in that turn, and a context compaction closes the gate again. Red team tools and the persona stay as they are.
- Bundled skills are copied to `$DSH_HOME/redteam/skills` and the preset points there with `dshHomePath`, instead of a machine-specific `node_modules` path. Your own skills stay in `$DSH_HOME/skills` and win on the same name.
- Red team mode shows in the mode list again. Declaring the preset no longer exits early because a path variable was missing.
- The sponsor addresses are back in the readme.

# 1.1.37

## 한국어

- 버전이 1.1.37로 업그레이드되었습니다. - 드릴 콘솔 환경 설정 페이지가 스크롤되어 나머지 설정도 채울 수 있습니다.
## English

- Version 1.1.37.
- The drill console environment page scrolls, so the rest of the settings can be filled in.

# 1.1.36

## 한국어

- 버전이 1.1.36으로 업그레이드되었습니다. - 레드팀 모드가 정리된 프롬프트를 거부하던 문제를 고쳤습니다.
## English

- Version 1.1.36.
- Fix red team mode refusing the cleaned prompt.

# 1.1.35

## 한국어

- 버전이 1.1.35로 업그레이드되었습니다. - 시작할 때 자동 업데이트를 하지 않고, 패널에서 직접 선택합니다. - dsh-purge 진입점을 "컨텍스트" 옆으로 옮겨 다른 플러그인 버튼을 가리지 않습니다. - 점수 기준을 업스트림에 맞췄습니다: 25개 항목이고, Web 앱에는 폴백 분류를 추가했습니다. - 지식 베이스 14개 분류의 집계에 로컬 nuclei 템플릿이 포함되고, 한 분류를 누르면 목록이 걸러집니다. - 스킬 경로는 `$DSH_HOME`을 따르며, 예시 경로가 이 기기에 없다는 이유만으로 스킬 전체를 사용 불가로 표시하지 않습니다.
## English

- Version 1.1.35.
- Startup no longer auto-updates; choose the update in the panel.
- The dsh-purge entry sits beside Context, so it no longer covers other plugin buttons.
- Scoring matches upstream: 25 items, with a fallback bucket for other web apps.
- The 14 knowledge categories count local nuclei templates, and a category filters the list.
- Skill paths follow `$DSH_HOME`. A skill is no longer marked unavailable just because an example path is missing on this machine.

# 1.1.34

## 한국어

- 버전이 1.1.34로 업그레이드되었습니다. - **드릴 콘솔 지식 베이스가 로컬 템플릿을 직접 나열합니다**. "지식 베이스 · POC / EXP"를 열면 nuclei 템플릿 한 페이지가 보이고, 페이지를 넘기거나 CVE 또는 컴포넌트로 검색할 수 있습니다. 더 이상 "로컬 템플릿 N"만 표시하고 아래가 비어 있지 않습니다. - **업데이트 아카이브가 Windows, macOS, Linux에서 모두 풀립니다**. Linux는 더 이상 PowerShell을 호출하지 않습니다. 순서는 Windows는 tar, 안 되면 PowerShell이고, macOS와 Linux는 tar, unzip, python3, bsdtar입니다. 이것들이 모두 없으면 Node가 zip을 직접 풉니다. Kali에서 `spawnSync powershell ENOENT`를 #44로 알려준 @cracer4869에게 감사합니다. (원문 손상 표기: `acOS`, `acOS`, `inux`, `inux`, `nzip`, `ython3`, `sdtar`)
## English

- Version 1.1.34.
- **The drill knowledge page lists local templates.** Opening Knowledge shows a page of nuclei templates, with paging and search by CVE or component. It no longer shows only the template count.
- **Update archives extract on Windows, macOS, and Linux.** Linux does not call PowerShell. Windows tries tar, then PowerShell. macOS and Linux try tar, unzip, python3, then bsdtar. If none of those exist, Node extracts the zip itself. Thanks to @cracer4869 for reporting `spawnSync powershell ENOENT` on Kali in #44.

# 1.1.33

## 한국어

- 버전이 1.1.33으로 업그레이드되었습니다. - **이미 재시작한 뒤에 패널을 열면 "재시작이 필요합니다"가 다시 뜨던 문제를 고쳤습니다**. 공식 클라이언트가 이미 압축을 푼 `resources/app`에서 실행 중이면, 지금이 공식 프로세스라는 이유만으로 다시 종료를 요구하지 않습니다. 이번에 실제로 `app.asar`를 옮겼을 때만 재시작을 안내합니다.
## English

- Version 1.1.33.
- **Fix the restart dialog coming back after you already restarted.** When the official app is already running from the unpacked `resources/app`, opening the panel no longer asks you to quit again just because this is the official process. The restart prompt appears only when `app.asar` was actually moved aside in this run.

# 1.1.32

## 한국어

- 버전이 1.1.32로 업그레이드되었습니다. - **베타에서 쓰던 드릴 콘솔 레이아웃을 그대로 올렸습니다**: 패널을 끌어 옮기고 크기를 바꿀 수 있으며, 라이트와 다크 테마가 호스트 테마를 따릅니다. - **설정 페이지에 이 플러그인이 더 이상 나타나지 않습니다**. 세션 제목 옆의 dsh-purge에서 오른쪽 사이드바를 열면 정리와 드릴 콘솔이 모두 그 안에 있습니다.
## English

- Version 1.1.32.
- **Bring the beta dock layout onto stable**: the panel can be dragged and resized, and light and dark follow the host theme.
- **The plugin no longer appears on the Settings page.** Open the right dock from dsh-purge beside the session title. Clean and Drill are both in that dock.

# 1.1.31

## 한국어

- 버전이 1.1.31로 업그레이드되었습니다. - **드릴 콘솔이 정식 릴리스에 들어갔습니다**. 오른쪽 사이드바는 두 페이지입니다: 정리, 드릴 콘솔. 드릴 콘솔에 처음 들어갈 때는 고지문을 읽고 승인을 확인해야 합니다. 자산, 스킬, 로컬 환경이 모두 이 플러그인 안에 있고, 더 이상 베타 레드팀 패키지를 따로 설치하지 않습니다. - **되돌리기가 매번 분기를 남기던 문제를 고쳤습니다**: 호스트는 원래 세션을 그 자리에서 자를 수 없으므로, 되돌린 뒤에는 이전 세션이 사이드바에서 빠지고, 여러 번 되돌려도 분기가 쌓이지 않습니다.
## English

- Version 1.1.31.
- **Drill console is on the stable release.** The right dock has two pages: Clean and Drill. The first time you open Drill you read the notice and confirm authorization. Assets, skills, and the local environment ship inside this plugin.
- **Fix rewind leaving a branch every time.** The host cannot truncate a session in place. After rewind the old session leaves the sidebar, so repeated undo does not pile up branches.

# 1.1.30

## 한국어

- 버전이 1.1.30으로 업그레이드되었습니다. - **정식 릴리스와 web에서 버전 전환이 실패하던 문제를 고쳤습니다**: 더 이상 `dsh plugin add`로 패키지를 받지 않습니다. pnpm이 GitHub 압축 패키지를 요청하면 `http 302` 또는 `fetch failed`가 납니다. 플러그인이 직접 내려받도록 바꿨습니다. - **사고와 출력의 무한 반복을 고쳤습니다**: 기본 프롬프트에 있던, 종료 조건이 없는 리셋을 제거했습니다.
## English

- Version 1.1.30.
- **Fix version switching on the desktop app and web**: stop installing through `dsh plugin add`. pnpm's fetch of the GitHub archive returns `http 302` or `fetch failed`. The plugin downloads the package itself.
- **Fix the thinking and output loop**: remove the default-prompt reset that had no stop condition.

# 1.1.28

## 한국어

- **업데이트 실패 `http 302`를 고쳤습니다**: 다운로드를 `codeload.github.com` 직결로 바꾸고 리디렉션을 수동으로 따라가서, Electron/일부 Node 빌드가 github.com → codeload의 302를 처리하지 못하는 문제를 피했습니다. - **베타 목록이 비어 보이던 문제를 고쳤습니다**: 프런트엔드 `keepListedVersion`을 백엔드와 맞춰, 정식 릴리스가 나온 뒤에도 beta tip / `beta` 브랜치를 유지합니다. tip SHA를 가져오지 못하면 raw/jsDelivr로 폴백해 확인합니다.
## English

- **Fix update failure `http 302`**: download via `codeload.github.com` and follow redirects manually so Electron/some Node builds no longer stall on github.com → codeload 302.
- **Fix empty beta list**: client `keepListedVersion` matches the server — keep the beta tip / `beta` branch after stable ships; fall back to raw/jsDelivr when tip SHA cannot be fetched.

# 1.1.27

## 한국어

- **적용 후 재시작해도 규칙 설정에 들어가면 "재시작 필요"가 다시 뜨던 문제를 고쳤습니다**: 수동으로 "적용"이 성공하면 `applied` 스탬프를 기록해, 재시작 후 settle이 패치가 어긋났다고 잘못 판단하지 않습니다. - "재시작"을 누르면 점착된 `boot_full_quit` 표시를 지우고, status가 불리언 값에 맞춰 대화상자를 동기화합니다. - web `waitForRestart`는 이전 프로세스가 끊긴 것을 먼저 확인한 뒤 성공으로 판정해, 같은 프로세스에서 잘못 새로고침하고 대화상자를 다시 띄우는 일을 막습니다.
## English

- **Fix restart prompt still showing after Apply + successful restart**: write the `applied` stamp on successful manual Apply so settle does not think patches are out of date.
- Clear sticky `boot_full_quit` when Restart is clicked; status syncs the modal from the boolean.
- Web `waitForRestart` requires the old process to go down before treating restart as success, avoiding same-process false refresh.

# 1.1.26

## 한국어

- **테스트 채널이 정식판 같은 번호에 가려지던 문제를 고쳤습니다**: `1.1.25` 정식 릴리스 후 `1.1.25-beta.*`가 "정식이 따라잡음" 필터 때문에 사라져 채널 전체가 보이지 않았습니다. 이제 **beta 브랜치 tip은 항상 목록에 남습니다**(정식과 beta 테스트가 병행되고, 테스트에는 레드팀이 포함됩니다). - 따라잡힌 예전 beta **태그**는 여전히 숨고, `1.1.11-beta`는 계속 내려간 상태입니다.
## English

- **Fix beta lane hidden by same-number stable**: after `1.1.25` stable, `1.1.25-beta.*` vanished via the "stable caught up" filter (in the source the word arrives mojibake-split as `s` + `table`); the **beta branch tip always stays listed** (parallel channels; beta carries red-team).
- Older caught-up beta **tags** still hide; `1.1.11-beta` stays withdrawn.
# 1.1.25

## 한국어

- **[#43](https://github.com/YuJunZhiXue/dsh-purge/issues/43) 수정**: `profiles/*/cordis.patch.yml`(사용자 patch 계층)을 더 이상 `backupAll`/`revertAll`에 넣지 않아, 업그레이드 자동 복구가 나중에 사용자가 추가한 `insert`를 오래된 bak으로 덮어쓰지 않습니다. - 시작/복원 시 잘못 만들어진 `cordis.patch.yml.dshpurge.bak`을 복원 없이 버리고 실제 사용자 파일은 유지합니다. - `npm run test:profile-patch`를 추가했습니다.
## English

- **Fix [#43](https://github.com/YuJunZhiXue/dsh-purge/issues/43)**: stop including `profiles/*/cordis.patch.yml` (user patch layer) in `backupAll`/`revertAll`, so upgrade reapply no longer restores an old bak over later user `insert`s.
- Drop stale `cordis.patch.yml.dshpurge.bak` without restoring; keep the live user file.
- Add `npm run test:profile-patch`.
# 1.1.24

## 한국어

- **[#40](https://github.com/YuJunZhiXue/dsh-purge/issues/40) 수정**: `pathLooksDesktop`이 더 이상 경로에 `deepseek-harness` 하위 문자열이 있다는 이유만으로 소스 트리를 데스크톱으로 판정하지 않고, 설치 형태(`resources/`, `.exe`, `.app`)를 요구합니다. - **[#41](https://github.com/YuJunZhiXue/dsh-purge/issues/41) 수정**: 소스 `apps/cli`(원문에서 앞 글자가 깨져 `sdown`으로 보이는 `tsdown` 빌드 산출물)에 hide-console 주입을 건너뜁니다. `revertAll`은 `.dshpurge.bak`이 없을 때 대상을 삭제하지 않습니다. - `npm run test:surface`를 추가했습니다.
## English

- **Fix [#40](https://github.com/YuJunZhiXue/dsh-purge/issues/40)**: `pathLooksDesktop` no longer treats source trees as desktop just because the path contains `deepseek-harness`; require install shapes (`resources/`, `.exe`, `.app`).
- **Fix [#41](https://github.com/YuJunZhiXue/dsh-purge/issues/41)**: skip hide-console injection into source `apps/cli` build output; `revertAll` never deletes targets when `.dshpurge.bak` is missing.
- Add `npm run test:surface`.
# 1.1.23

## 한국어

- **[#38](https://github.com/YuJunZhiXue/dsh-purge/issues/38) 수정**: `#1`/`#2`/`#3` 프롬프트 패치가 `apply`할 때마다 약 +841자씩 겹쳐 쌓여 영원히 수렴하지 않던 문제를 고쳤습니다. - **원인**: 치환 결과물이 여전히 이전 버전 텍스트를 접두사로 두고 `skipIfMarked`도 없어서, `autoApplyOnStart`가 매 부팅마다 한 겹씩 더 썼습니다. - **수정**: `#1`/`#2`/`#3`에 `skipIfMarked: true`를 지정하고([#42](https://github.com/YuJunZhiXue/dsh-purge/pull/42)), `npm run test:idempotence` 회귀를 추가했습니다. - 이미 부풀어 버린 호스트 파일은 자동으로 줄어들지 않으니 `.dshpurge.bak`을 복원하거나 dsh를 다시 설치한 뒤 apply하세요.
## English

- **Fix [#38](https://github.com/YuJunZhiXue/dsh-purge/issues/38)**: prompt patches `#1`/`#2`/`#3` grew by ~+841 chars on every `apply` and never converged.
- **Cause**: replacement text still starts with the previous pattern, and `skipIfMarked` was missing, so `autoApplyOnStart` rewrote every boot.
- **Fix**: set `skipIfMarked: true` on `#1`/`#2`/`#3` ([#42](https://github.com/YuJunZhiXue/dsh-purge/pull/42)); add `npm run test:idempotence`.
- Already-bloated host files are not auto-shrunk — restore `.dshpurge.bak` or reinstall dsh, then apply again.

# 1.1.22

## 한국어

- **공식 데스크톱에서 "적용"이 ENOENT를 보고하던 문제를 고쳤습니다**. `app.asar`가 남아 있을 때 `dsh-purge-child-process-hide.mjs`를 새로 만들면 실패해 경로가 `resources\app.asar\...\dsh-purge-child-process-hide.mjs`로 기록되고 패치가 대기 상태에 멈췄습니다. - **원인**: 공식 클라이언트에 `app.asar`가 아직 있으면 Electron이 `resources\app`을 이 아카이브로 매핑합니다. 아카이브에 없는 새 파일을 일반 파일 API로 만들면 ENOENT가 납니다. - **두 가지 쓰기 경로를 모두 유지합니다**. 아카이브가 남아 있으면 실제 디스크의 `resources\app`에 씁니다. `app.asar`가 없으면 기존 `node:fs` 경로를 그대로 쓰며, 이는 Web, 커뮤니티 데스크톱, 그리고 공식 패키지가 이미 압축을 풀고 아카이브를 `app.asar.bak`으로 옮긴 경우를 모두 포함합니다(원문에서는 `Web` 자리 일부가 `eb`로 깨져 있습니다). - 설치 경로는 드라이브 문자를 고정하지 않습니다. Web과 커뮤니티 데스크톱은 기존 적용 및 재시작 방식을 유지합니다. 호스트 목표는 여전히 **dsh 0.1.7-rc.2**입니다.
## English

- **Fixes ENOENT when Apply runs on the official desktop.** While `app.asar` is still present, creating `dsh-purge-child-process-hide.mjs` failed. The path was rewritten to `resources\app.asar\...\dsh-purge-child-process-hide.mjs`, and patches stayed pending.
- **Cause**: with the archive still in place, Electron maps `resources\app` into `app.asar`. Creating a file that is not already in the archive through the normal file API throws ENOENT.
- **Both write paths stay.** If the archive is still there, files are written on the real `resources\app` directory. If there is no `app.asar`, the previous `node:fs` path is unchanged. That covers Web, community desktop, and an official install that has already been unpacked and had the archive moved to `app.asar.bak`.
- Install paths are not pinned to a drive letter. Web and community desktop keep their existing Apply and restart. The host target remains **dsh 0.1.7-rc.2**.

# 1.1.21

## 한국어

- **필수 패치 실패 #43, #9, #15, #23, #42를 고쳤습니다**. "적용"을 눌러도 이 5개 때문에 "정리 미완료"를 보고하지 않습니다. 프롬프트는 원래 기록되며, 이 5개가 기록되지 않았을 때 화면이 적용 전체를 실패로 판정해 플러그인이 죽은 것처럼 보였습니다. - **원인**: 상위 폴더 이름이 DeepSeek Harness이면 디렉터리 전체를 공식 데스크톱으로 취급해, Web의 npm 패키지가 제외되고 이 5개에 해당하는 원문도 기록되지 않았습니다. 설치 경로는 드라이브 문자를 고정하지 않습니다. 이제 옆에 실제로 데스크톱 실행 파일이 있거나 경로가 해당 설치의 `resources/app` 안에 있을 때만 데스크톱 설치로 봅니다(원문에서는 `Web` 자리 일부가 `eb`로 깨져 있습니다). Web, 커뮤니티 데스크톱, 공식 데스크톱은 각자 자기 패키지를 패치합니다. - **#43**: Web의 내장 프리셋 네 개(`standard`, `ptc`, `cordis`, `minimal`, 원문에서는 앞 글자가 깨져 `tc`, `ordis`, `inimal`로 보임)에서 정체성 문장만 제거합니다. 기록되지 않으면 프리셋의 원래 정체성 문장이 주입 옆에 남습니다. - **#9**: 승인 요청을 자동으로 허용합니다. - **#15**: 샌드박스 `confine`이 더 이상 한 겹 감싸지 않고 명령을 원래대로 실행합니다. - **#23**: 서브에이전트 기본 깊이를 1에서 10으로 올렸습니다. - **#42**: 설정 서비스에 예전 `register` / `get`을 되돌려 넣어, 옛 인터페이스를 호출하는 플러그인도 로드됩니다. - 파일은 있지만 이 원문이 현재 버전에 없으면 건너뜀으로 표시하고, 적용 전체를 실패로 판정하지 않습니다. 원문이 남아 있으면 여전히 기록합니다.
## English

- **Fixes required-patch failures #43, #9, #15, #23, and #42.** Apply no longer reports the cleanse as incomplete because of these five. The prompt was already written; the failure made the plugin look dead.
- **Cause**: a parent folder named DeepSeek Harness was treated as the official desktop install, so the Web npm packages were excluded and these five were never written. Install paths are not pinned to a drive letter. A tree counts as the desktop install only when the desktop executable is beside it, or the path is under that install's `resources/app`. Web, community desktop, and official desktop each patch their own packages.
- **#43**: strips the identity sentence from the four built-in Web presets (standard, ptc, cordis, minimal). Left in place, that sentence stays next to the inject.
- **#9**: approval requests are auto-granted.
- **#15**: sandbox `confine` no longer wraps the command.
- **#23**: subagent default depth moves from 1 to 10.
- **#42**: the settings service gets the old `register` / `get` methods back, so plugins that still call them can load.
- When the file exists but this version does not contain that original text, the row shows skipped and Apply still completes. Text that is present is still written.

# 1.1.20

## 한국어

- **호스트 버전**: 현재 목표는 **dsh 0.1.7-rc.2**입니다. 이전 목표인 **0.1.7-rc.1**(포함 `0.1.7-rc.1.20260924.1`)의 앵커는 여전히 유효합니다. - **공식 데스크톱 업그레이드**: 이미 내려받은 새 버전은 재시작할 때, 또는 앱에서 설치 및 재시작을 누를 때 실제로 설치되고, 그다음 새 빌드의 압축을 풀어 패치를 다시 적용합니다. 대기 중인 업데이트가 없으면 재시작은 현재 클라이언트를 닫았다 다시 여는 동작입니다. 설치 경로는 드라이브 문자를 고정하지 않습니다. - **패치**: #14, #35가 rc.2의 업그레이드 문구에 맞춰져 필수 패치 실패를 더 이상 보고하지 않습니다. #29, #33, #36은 새 프롬프트 문구를 따릅니다. - Web과 커뮤니티 DSH Desktop은 기존 적용 및 재시작 방식을 유지합니다.
## English

- **Host version**: current target is **dsh 0.1.7-rc.2**. Anchors for the previous target, **0.1.7-rc.1** (including `0.1.7-rc.1.20260924.1`), still match.
- **Official desktop upgrade**: a downloaded update installs on Restart, or on the in-app install-and-restart action, then the new build is unpacked and patched. With no pending update, Restart still closes and reopens the current client. Install paths are not pinned to a drive letter.
- **Patches**: #14 and #35 match the rc.2 escalation text, so Apply no longer fails those required patches. #29, #33, and #36 follow the new prompt wording.
- Web and community DSH Desktop keep their existing Apply and restart.

# 1.1.19

## 한국어

- **공식 데스크톱 EXE**: 공식 DeepSeek Harness를 지원합니다. "적용"을 누르면 `app.asar`의 압축을 풀고 네이티브 모듈을 복원한 뒤, "재시작"을 누르면 클라이언트가 스스로 종료되고 다시 열립니다. Web과 커뮤니티 DSH Desktop은 기존 적용 및 재시작 방식을 유지합니다. - **재시작**: 공식 클라이언트 종료가 더 이상 셸에서 크래시로 처리되지 않고, 백그라운드 PowerShell도 남지 않습니다. 재시작 스크립트는 Windows 스크립트 호스트에 없는 `toISOString`을 더 이상 호출하지 않아 런타임 오류 대화상자가 뜨지 않습니다. 새 프로세스는 `ELECTRON_RUN_AS_NODE`를 상속하지 않으므로 열리자마자 종료되지 않습니다. - **업데이트**: 버전을 바꾸거나 롤백할 때 실제로 적용된 그 버전 기준으로 자동 복원 후 다시 적용하므로, 매번 수동으로 먼저 복원하고 적용하고 재시작할 필요가 없습니다. - **패치 목록**: 호스트가 이미 `dsh-web-fetch-http`에 의존하면 영원히 건너뛰는 #20을 더 이상 표시하지 않습니다. 설치 경로는 드라이브 문자를 고정하지 않습니다.
## English

- **Official desktop EXE**: Apply on official DeepSeek Harness unpacks `app.asar`, restores native modules, then Restart closes the client and opens it again. Web and community DSH Desktop keep their existing Apply and restart.
- **Restart**: exiting the official host is no longer treated as a crash, and no PowerShell process is left behind. The helper no longer calls `toISOString`, which made Windows Script Host pop a runtime error. The new process does not inherit `ELECTRON_RUN_AS_NODE`, which made it exit immediately.
- **Updates**: switching or rolling back a version restores and reapplies that version's patches without a manual revert first.
- **Patch list**: hosts that already depend on `dsh-web-fetch-http` no longer show a permanently skipped #20. Install paths are not pinned to a drive letter.

# 1.1.18

## 한국어

- **재시작**: "재시작"을 누르면 이전 페이지의 token이 무효가 되어 새로고침만으로는 열리지 않습니다. 이제 포트가 풀릴 때까지 기다리고(필요하면 이전 프로세스를 종료), 새 프로세스가 출력한 주소로 브라우저를 엽니다. 새로 열린 페이지에서 새 대화를 시작하세요. - **설정**: 1.1.17 이전에 `legacyApplyPath`가 `dsh-settings`에 겹쳐 들어갔다면, "적용"이 이를 한 벌로 정리해 제공자 카탈로그가 정상적으로 로드됩니다. 정리한 뒤 재시작을 한 번 하세요.
## English

- **Restart**: the old page token dies with the process, so a refresh looks like restart did nothing. Restart now frees the port and opens the browser at the new `dsh web:` URL. Use that page and start a new chat.
- **Settings**: Apply collapses duplicate `legacyApplyPath` left by earlier 1.1.17 patches so `dsh-settings` can load. Restart once after that apply.

# 1.1.17

## 한국어

- **안정성**: 설정 패치 #42가 dsh 0.1.7에서 `legacyApplyPath`를 중복 삽입하던 문제를 고쳤습니다. 이전에는 `@deepseek-ai/dsh-settings`를 로드하지 못하고 제공자 카탈로그가 오류를 내며 mnemon 같은 플러그인이 pending에 걸렸습니다. 이제 `skipIfMarked`를 쓰고, 공식 패키지에 이미 들어 있는 `legacyApplyPath`와 겹쳐 쓰지 않습니다. - **워크스페이스 강한 지시**: #1/#2가 `WORKSPACE_*`와 `AGENT_*` 상수 이름을 함께 인식해, "전역/교체식 면책"이 구버전 호스트에서 건너뜀으로 표시되어 적용이 무효가 되는 일을 막습니다. - **거부 응답과 소프트 거부**: 공식 `agent-instructions` 강한 지시에 이 머신의 승인된 평가와 소프트 거부 대응 문구를 보강하고, 플러그인에 고정 `dsh-purge:rules` 절(실행 규칙과 동일)을 추가합니다. **새 대화를 열고 dsh를 재시작한 뒤** 적용됩니다.
## English

- **Stability**: patch #42 no longer stacks duplicate `legacyApplyPath` on dsh 0.1.7, which broke `@deepseek-ai/dsh-settings`, provider catalog loading, and downstream plugins. Uses `skipIfMarked` and does not re-insert the helper the official package already ships.
- **Workspace intros**: patches #1/#2 match both `WORKSPACE_*` and `AGENT_*` constant names so rows no longer show Skipped on older installs.
- **Refusal / soft refusal**: stronger official workspace intros plus a fixed `dsh-purge:rules` section. **Restart dsh and start a new chat** for prompt changes.

# 1.1.16

## 한국어

- **dsh 0.1.7-rc.1**에 맞췄습니다. 워크스페이스 설명 상수 이름이 `AGENT_INSTRUCTIONS_INTRO`로 바뀌었고 문장은 그대로이며, 패치도 이를 따릅니다. - 샌드박스 `confine()`은 이제 `async confine(argv, policy, signal)`이고, 패치는 새 함수에 맞춰져 있습니다. 패스스루 동작은 이전 릴리스와 같습니다. - 서브에이전트 깊이는 `dsh-subagent`에 있습니다. 기본값이 1에서 10으로 올라갑니다. 깊이 검사는 그대로입니다. - 설정 서비스가 예전 `register` / `get`을 다시 노출해 `dsh-mnemon`, `dsh-better-reasoning-effort` 같은 플러그인이 계속 동작합니다. 공식 `describe` / `update`는 그대로 둡니다. 패치는 한 번만 적용되고 시작할 때 스스로를 다시 삽입하지 않습니다. - 0.1.7에 더 이상 없는 패치 문구를 제거했습니다. `dsh-base`에 `dsh-web-fetch-http` 의존성을 따로 넣던 부분도 포함됩니다. 공식 패키지는 이미 이에 의존합니다. - Web 내장 프리셋 네 개(`standard`, `ptc`, `cordis`, `minimal`, 원문에서는 앞 글자가 깨져 `tc`, `ordis`, `inimal`로 보임)는 정체성 문장만 잃습니다. 작업 디렉터리 접미사, 도구 목록, `ptc` 모드, minimal의 `complete: true`와 `includeRuntimeContext: false`는 그대로 남습니다. - `complete: true`일 때 `prompt-inject.md`는 여전히 그 절 앞에 붙습니다. 호스트를 업그레이드하거나 오래된 훅이 절을 지워도 주입은 사라지지 않습니다. 적용 후에도 "재시작"을 누르고 새 대화를 시작해야 세션에 들어갑니다. - `dsh-compaction-instant` 웹 클라이언트는 제거된 `settingsScope` 대신 `configForms`를 써서, 페이지가 더 이상 Failed to load plugins에서 멈추지 않습니다. - 0.1.7에서 되돌리기는 새 세션을 만들고도 UI를 이전 대화에 남겨 두어 클릭이 죽은 것처럼 보였습니다. 0.1.7에는 `sessions.open`이 없습니다. 이제 버튼이 `uiWorkspace.openSession`으로 새 세션을 열고, 마지막 사용자 문장을 입력창에 되돌려 놓습니다. 실패하면 버튼에 표시됩니다. - README의 후원 절은 비영리 고지로 바뀌었습니다. 상업적 재판매와 회색 시장 수익은 금지하며, 기술 참고용으로만 제공합니다.
## English

- Aligned with **dsh 0.1.7-rc.1**. The workspace-instruction constant is now `AGENT_INSTRUCTIONS_INTRO`. The sentence is unchanged, and the patch follows it.
- Sandbox `confine()` is now `async confine(argv, policy, signal)`, and the patch matches that function. Passthrough behavior is the same as the previous release.
- Subagent depth lives on `dsh-subagent`. The default moves from 1 to 10. The depth check remains.
- The settings service again exposes the old `register` / `get` methods, so plugins such as `dsh-mnemon` and `dsh-better-reasoning-effort` keep working. Official `describe` / `update` stay. The patch applies once and does not insert itself again on startup.
- Patch text that no longer exists in 0.1.7 is removed, including the extra `dsh-web-fetch-http` dependency on `dsh-base`. The official package already depends on it.
- The four built-in Web presets (standard, ptc, cordis, minimal) lose only the identity sentence. The working-directory suffix, tool lists, `ptc` mode, and minimal's `complete: true` plus `includeRuntimeContext: false` stay.
- When `complete: true`, `prompt-inject.md` is still prepended to that section. A host upgrade or an older hook that drops the section does not drop the inject. After Apply you still click Restart and start a new chat before it enters the session.
- The `dsh-compaction-instant` web client uses `configForms` instead of the removed `settingsScope`, so the page no longer stops on Failed to load plugins.
- Rewind on 0.1.7 created the new session and left the UI on the old chat, so the click looked dead. 0.1.7 has no `sessions.open`. The button now opens the new session with `uiWorkspace.openSession` and puts the previous user line back in the composer. A failure shows on the button.
- The README sponsor block is now a non-profit notice: no commercial resale and no gray-market profit; technical reference only.
