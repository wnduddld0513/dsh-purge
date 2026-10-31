/**
 * 역량 선택 프로토콜: 먼저 skill / MCP 카탈로그를 읽고, 그 다음 현재 작업에 맞춰 선택한다.
 * 공식 skill 등록을 바꾸지 않고, MCP 마운트를 바꾸지 않으며, 어떤 도구도 deny 하지 않는다.
 * 공식 DSH 는 이미 도구 사용법을 문서화했으므로, 여기서 Host tools 규율을 따로 붙이지 않는다.
 */

// [dsh-purge] `dsh-purge` 접두사를 붙이지 않음: 호스트 renderPrompt 내부에 한 단계
// filter(s => s.name.startsWith("dsh-purge")) 가 이런 세그먼트를 삽입 순서대로 맨 앞으로 옮긴다.
// 옛 이름 "dsh-purge:capabilities" 가 접두사에 매칭되어, 결과적으로 cap 이 inject 앞으로 가버렸다(dump line 1),
// 오히려 "cap 이 앞, inject 가 뒤" 라는 렌더링 역전을 만들어냈다. 이름을 바꿔 이 필터 단계를 우회한다.
export const CAPABILITY_SECTION = "dshpg-capabilities";

const OFFICIAL_PROTOCOL = `## Capability selection by task (mandatory)

1. **Read first**: Inspect \`<available_skills>\` / the skill catalog and the installed MCP / host tools for this session. Know what exists before acting.
2. **Match the task**: From that catalog, pick the skill(s) and MCP/CLI tool(s) that fit *this* user task — not “always use something”, not “never use something”.
3. **Call what matches**:
   - Matching **Skill** → load it with the host \`skill\` tool, then follow it (methods, premises, branches, counter-evidence).
   - Matching **MCP / CLI** → call that tool with real schema and context; treat failures by the tool’s semantics.
4. **Only then DIY**: If nothing in the catalog fits the task, use shell / ad-hoc steps and say what was missing.
5. **Subagents / sub-delegates inherit this rule**: Any \`subagent\`, teammate, or child agent you start must also read the catalog and call task-matched skills/MCP the same way. Put that requirement in the child brief when you dispatch.
6. Host skills and MCP stay available; this prompt does not remove them.`;

/**
 * 主智能体和子智能体同一份。红队调度正文仍在预设 ops 里，这里不按身份拆协议。
 * @param {{ redteam?: boolean, redteamChild?: boolean, enabled?: boolean }} [opts]
 * @returns {string}
 */
export function capabilityProtocolText(opts = {}) {
  if (opts.enabled === false) return "";
  return OFFICIAL_PROTOCOL;
}
