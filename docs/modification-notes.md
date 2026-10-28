# dsh-purge 수정 문서

## 수정 날짜: 2026-10-13

---

## 0. patch 89: SYSTEM_FIELD_EXTRACT(ALL_PATCHES, 누구든 apply 하면 자동 적용)

**문제**: 0.2.0 은 시스템 프롬프트를 `role: "system"` 메시지로 messages 배열에 넣습니다, 0.1.1 처럼 별도 `system` 필드에 두지 않습니다. 모델이 시스템 프롬프트를 대화 기록으로 착각해 의심합니다→두 번째 턴에서 거부하거나 도중에 깨어나 거부합니다.

**변경**: `core.js` 의 `CODE_PATCHES` 배열 끝에 patch 89 를 추가해 agent-loop 의 `buildRequest` 를 patch 하고, `role: "system"` 메시지를 `deriveMessages()` 에서 꺼내 `system` 필드로 병합합니다.

**적용 조건**: `file: ["agent-loop"]`, `optional: true`, `skipIfMarked: true`. 0.2.0 은 일치(`session.deriveMessages()`), 0.1.1 은 불일치(`this.session.deriveMessages()`) → 0.2.0 에만 적용됩니다.

**UI 표시**: `system_field_extracted` 필드를 status/apply/override 엔드포인트에 추가해, 사용자가 패널에서 `system_field_extracted: true` 를 보고 수정이 적용된 것을 알 수 있습니다.

**복원**: patch 89 는 `ALL_PATCHES` 의 일부이므로 `git checkout -- lib/core.js` 로 제거할 수 있습니다. apply 할 때 agent-loop 가 재설치되면(npm install), 다시 apply 하면 patch 가 다시 적용됩니다.

---

## 1. override 상태 머신 수정 (core.js)

### 1.1 isKeepableUserOverride 판정 순서 (core.js:7844-7848)

**문제**: `explicitSave:true` 가 `seedHash`/`overrideTextIsOurs` 검사보다 먼저 return 해서, 플러그인이 직접 쓴 옛 기본값이 사용자 수정으로 오판되고, 새 기본값은 영영 반영되지 않습니다.

**변경**: seedHash 와 overrideTextIsOurs 검사를 explicitSave/customized 앞으로 옮깁니다.

**원본 코드**:
```js
if (state.explicitSave === true) return true;
if (state.customized === true) return true;
if (typeof state?.seedHash === "string" && state.seedHash === stamp) return false;
if (state.customized !== true && state.explicitSave !== true && overrideTextIsOurs(state, text)) {
  return false;
}
return true;
```

**변경 후**:
```js
if (typeof state?.seedHash === "string" && state.seedHash === stamp) return false;
if (overrideTextIsOurs(state, text)) return false;
if (state.explicitSave === true) return true;
if (state.customized === true) return true;
return true;
```

### 1.2 markOverrideCustomized 는 hash 를 기록하지 않음 (core.js:7797-7805)

**문제**: `saveOverrideContent` 와 `installOverride` 가 모두 `markOverrideCustomized` 를 호출하고 모두 hash 를 기록해서, 사용자가 저장한 것인지 플러그인이 쓴 것인지 구분할 수 없습니다.

**변경**: `explicitSave:true` 일 때는 hash 를 기록하지 않고(빈 문자열로 설정), `overrideTextIsOurs` 가 플러그인이 쓴 것만 매칭하도록 합니다.

**원본 코드**:
```js
export async function markOverrideCustomized(dshHome, customized, text, extra = {}) {
  await writeOverrideState(dshHome, {
    customized: Boolean(customized),
    explicitSave: extra.explicitSave === true,
    hash: hashOverride(text ?? defaultOverrideText()),
    seedHash: defaultOverrideHash(),
    updatedAt: new Date().toISOString(),
  });
}
```

**변경 후**:
```js
export async function markOverrideCustomized(dshHome, customized, text, extra = {}) {
  const isExplicit = extra.explicitSave === true;
  await writeOverrideState(dshHome, {
    customized: Boolean(customized),
    explicitSave: isExplicit,
    hash: isExplicit ? "" : hashOverride(text ?? defaultOverrideText()),
    seedHash: defaultOverrideHash(),
    updatedAt: new Date().toISOString(),
  });
}
```

### 1.3 commitOverrideOnApply 는 디스크의 사용자 내용을 보존 (core.js:7993-8018)

**문제**: `incoming=null`(사용자가 Apply 를 눌렀지만 UI 가 편집창 내용을 전달하지 않음) → `isKeepableUserOverride(null)` → false → seed 기본값 → 사용자 수정을 덮어씁니다.

**변경**: `incoming=null` 일 때 디스크의 현재 내용을 읽고, 사용자 내용이 있으면 보존하고 `explicitSave:true` 를 표시합니다.

**원본 코드**:
```js
export async function commitOverrideOnApply(dshHome, incoming) {
  const home = path.normalize(String(dshHome || findDshHome() || ""));
  if (!home) return { action: "skip", reason: "no_home" };
  if (isKeepableUserOverride(home, incoming)) {
    const saved = await saveOverrideContent(home, incoming);
    return { ...saved, action: "saved_user" };
  }
  const seed = seedPromptInjectAtBoot(home);
  try {
    rememberCommittedOverride(home, readPromptInjectFileSync(home) || defaultOverrideText());
  } catch { }
  return seed;
}
```

**변경 후**:
```js
export async function commitOverrideOnApply(dshHome, incoming) {
  const home = path.normalize(String(dshHome || findDshHome() || ""));
  if (!home) return { action: "skip", reason: "no_home" };
  let effective = typeof incoming === "string" ? incoming : null;
  if (effective === null) {
    try { effective = readPromptInjectFileSync(home); } catch { effective = ""; }
  }
  if (typeof effective === "string" && normalizeOverride(effective) && isKeepableUserOverride(home, effective)) {
    const saved = await saveOverrideContent(home, effective);
    return {4saved, action: "saved_user" };
  }
  const diskRaw = readPromptInjectFileSync(home);
  const diskNorm = normalizeOverride(diskRaw);
  const bundledNorm = normalizeOverride(defaultOverrideText());
  if (diskNorm && diskNorm !== bundledNorm) {
    await markOverrideCustomized(home, true, diskRaw, { explicitSave: true });
    rememberCommittedOverride(home, diskRaw);
    return { action: "kept_user_custom", path: findOverrideFile(home), content: diskRaw };
  }
  const seed = seedPromptInjectAtBoot(home);
  try {
    rememberCommittedOverride(home, readPromptInjectFileSync(home) || defaultOverrideText());
  } catch { }
  return seed;
}
```

### 1.4 Apply 후 seed 가 사용자 내용을 보호 (index.js:2002-2014)

**문제**: Apply 후 무조건 `seedPromptInjectAtBoot` 를 호출 → 사용자 내용을 덮어쓸 수 있습니다.

**변경**: 먼저 디스크를 읽고, 사용자 내용이 있고 keepable 하면 → seed 를 건너뜁니다.

**원본 코드**:
```js
let promptInjectInstall = "skipped";
if (hostWritten && flash.ok === true) {
  try {
    const seed = core.seedPromptInjectAtBoot(state.dsh_home);
    promptInjectInstall = seed?.action || "noop";
  } catch (e) {
    promptInjectInstall = `error:${String(e && e.message ? e.message : e)}`;
  }
}
```

**변경 후**:
```js
let promptInjectInstall = "skipped";
if (hostWritten && flash.ok === true) {
  try {
    const home = state.dsh_home;
    const diskRaw = core.readPromptInjectFileSync(home);
    const diskNorm = core.normalizeOverride(diskRaw);
    const bundledNorm = core.normalizeOverride(core.defaultOverrideText());
    if (diskNorm && diskNorm !== bundledNorm && core.isKeepableUserOverride(home, diskRaw)) {
      promptInjectInstall = "kept_user_custom";
    } else {
      const seed = core.seedPromptInjectAtBoot(home);
      promptInjectInstall = seed?.action || "noop";
    }
  } catch (e) {
    promptInjectInstall = `error:${String(e && e.message ? e.message : e)}`;
  }
}
```

---

## 2. 0.2.0 system prompt 수정 (dsh-agent-loop/lib/index.js)

### 2.1 buildRequest 가 system 을 별도 필드로 추출

**문제**: 0.2.0 은 시스템 프롬프트를 `role: "system"` 메시지로 messages 배열에 넣습니다, 0.1.1 처럼 별도 `system` 필드에 두지 않습니다. 모델이 시스템 프롬프트를 대화 기록으로 착각해 의심합니다→두 번째 턴에서 거부합니다.

**변경**: `buildRequest` 안에서 `role: "system"` 메시지를 `deriveMessages()` 에서 꺼내 `system` 문자열로 병합해 `system` 필드에 넣습니다.

**파일**:
- `D:\DeepSeek Harness\.dsh\profiles\node_modules\@deepseek-ai\dsh-agent-loop\lib\index.js`
- `D:\DeepSeek Harness\npm-global\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\dsh-agent-loop\lib\index.js`
(두 경로는 같은 파일이며 hash 가 일치)

**원본 코드** (약 1270행):
```js
const boundaryMessages = session.deriveMessages();
for (const message of boundaryMessages) {
  if (this.frozenMessages.has(message)) continue;
  deepFreeze(message);
  this.frozenMessages.add(message);
}
Object.freeze(boundaryMessages);
return markAgentLoopRequest(Object.freeze({
  ...header.config,
  messages: boundaryMessages,
  toolHistory: session.toolHistory(),
  ...header.tools !== void 0 ? { tools: header.tools } : {},
  sessionId: this.session.id,
  signal
}));
```

**변경 후**:
```js
const boundaryMessages = session.deriveMessages();
const systemParts = [];
const nonSystemMessages = [];
for (const message of boundaryMessages) {
  if (message && message.role === "system") {
    const content = message.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block && block.type === "text" && typeof block.text === "string" && block.text.length > 0) {
          systemParts.push(block.text);
        }
      }
    } else if (typeof content === "string" && content.length > 0) {
      systemParts.push(content);
    }
  } else {
    nonSystemMessages.push(message);
  }
}
const systemField = systemParts.length > 0 ? systemParts.join("\n\n") : void 0;
for (const message of nonSystemMessages) {
  if (this.frozenMessages.has(message)) continue;
  deepFreeze(message);
  this.frozenMessages.add(message);
}
Object.freeze(nonSystemMessages);
return markAgentLoopRequest(Object.freeze({
  ...header.config,
  ...systemField !== void 0 ? { system: systemField } : {},
  messages: nonSystemMessages,
  toolHistory: session.toolHistory(),
  ...header.tools !== void 0 ? { tools: header.tools } : {},
  sessionId: this.session.id,
  signal
}));
```

---

## 3. 프롬프트 파일

### 3.1 새 버전 프롬프트
- `lib/default-prompt-inject.en.md` — 영문판
- `lib/default-prompt-inject.ko.md` — 한국어판

### 3.2 원본 소스
- 이전 원본 프롬프트 백업 파일은 삭제했다 — 이력은 git 으로만 확인할 수 있다
- `lib/default-prompt-inject.md` — 현재 적용 버전 (로컬 초안, git 추적 제외)

---

## 복원 방법

### core.js 복원 (override 상태 머신)

```powershell
# git 으로 복원
cd "E:\침투\dsh-purge"
git checkout -- lib/core.js
git checkout -- lib/index.js
```

### dsh-agent-loop 복원 (system prompt 수정)

```powershell
# dsh-purge 의 bak 에서 복원 (dsh-purge 가 bak 을 만들었다면)
Copy-Item "D:\DeepSeek Harness\.dsh\profiles\node_modules\@deepseek-ai\dsh-agent-loop\lib\index.js.dshpurge.bak" "D:\DeepSeek Harness\.dsh\profiles\node_modules\@deepseek-ai\dsh-agent-loop\lib\index.js" -Force

# 또는 npm 캐시에서 재설치
cd D:\DeepSeek Harness
npm install @deepseek-ai/dsh-agent-loop@0.2.0-rc.2 --force
```

### 프롬프트 복원

```powershell
# 원본으로 복원
Copy-Item "E:\침투\dsh-purge\lib\default-prompt-inject.ko.md" "E:\침투\dsh-purge\lib\default-prompt-inject.md" -Force

# 런타임 사본 동기화
Copy-Item "E:\침투\dsh-purge\lib\default-prompt-inject.md" "D:\DeepSeek Harness\.dsh\prompt-inject.md" -Force

# override state 비우기
$state = @{ customized = $false; explicitSave = $false; hash = ""; seedHash = ""; updatedAt = (Get-Date -Format "o") }
$state | ConvertTo-Json -Depth 2 | Set-Content -LiteralPath "D:\DeepSeek Harness\.dsh\dsh-purge\override-state.json" -Encoding UTF8 -NoNewline
```

### override-state.json 복원

```powershell
$state = @{ customized = $false; explicitSave = $false; hash = ""; seedHash = ""; updatedAt = (Get-Date -Format "o") }
$state | ConvertTo-Json -Depth 2 | Set-Content -LiteralPath "D:\DeepSeek Harness\.dsh\dsh-purge\override-state.json" -Encoding UTF8 -NoNewline
```

### 전체 복원 (원클릭)

```powershell
# 1. core.js + index.js
cd "E:\침투\dsh-purge"
git checkout -- lib/core.js lib/index.js

# 2. dsh-agent-loop
Copy-Item "D:\DeepSeek Harness\.dsh\profiles\node_modules\@deepseek-ai\dsh-agent-loop\lib\index.js.dshpurge.bak" "D:\DeepSeek Harness\.dsh\profiles\node_modules\@deepseek-ai\dsh-agent-loop\lib\index.js" -Force

# 3. 프롬프트
Copy-Item "E:\침투\dsh-purge\lib\default-prompt-inject.ko.md" "E:\침투\dsh-purge\lib\default-prompt-inject.md" -Force
Copy-Item "E:\침투\dsh-purge\lib\default-prompt-inject.md" "D:\DeepSeek Harness\.dsh\prompt-inject.md" -Force

# 4. override state
$state = @{ customized = $false; explicitSave = $false; hash = ""; seedHash = ""; updatedAt = (Get-Date -Format "o") }
$state | ConvertTo-Json -Depth 2 | Set-Content -LiteralPath "D:\DeepSeek Harness\.dsh\dsh-purge\override-state.json" -Encoding UTF8 -NoNewline

Write-Output "전체 복원 완료, 데스크톱을 재시작하면 적용됩니다"
```
