/** 재시작 전에 시스템 프롬프트 파일을 본다: 표시가 찍혀 있거나, 현재 원문에 그 옛 차단 지점 두 곳이 이미 없다. */
export function hostPromptKeepsInject(text) {
  const body = String(text || "");
  const identityMarked = body.includes("[dsh-purge] identity stripped");
  const injectMarked = body.includes("[dsh-purge] complete prompt keeps waterfall inject")
    || body.includes("[dsh-purge] complete prompt keeps inject")
    || body.includes("[dsh-purge] fold-complete inject first");
  if (identityMarked && injectMarked) return true;
  // 빈 파일이거나 이 모듈이 아니면, 이미 정리된 것으로 볼 수 없다.
  if (!body.includes("system-prompt/assemble")) return false;
  const identityLeft = body.includes("You are an AI agent powered by DeepSeek Harness.");
  // 0.2.0/0.2.1 모두 complete 분기에 `: [completeSection],` 를 쓴다; 0.2.1 만 그 앞에 requiredContexts 줄이 하나 더 있다.
  const dropsInject = body.includes("transformed.sections : [completeSection]")
    || body.includes(": [completeSection]");
  return !identityLeft && !dropsInject;
}
