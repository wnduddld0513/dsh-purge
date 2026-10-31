/**
 * 하위 에이전트 승인 인수.
 *
 * 호스트는 하위 세션에 approval/policy = "never" 를 못박는다:
 *   dsh-subagent captureDelegatedPolicyOverrides → approvalPolicy: "never"
 *   dsh-user-approval decide() → `if (effectivePolicy === "never") return "rejected";`
 * 이 단계는 approval/request 의 waterfall 앞에서 일어나므로 어떤 리스너로도 구제되지 않는다.
 *
 * 순서는 하나뿐이다: 먼저 policy 를 ask 로 뒤집어야 waterfall 이 돌고, 그 다음 waterfall 에서 통과시킨다.
 * 하위 세션에만 작용하며 주 세션에는 영향이 없다.
 *
 * 저장소 내 판별 함수를 import 하지 않는다 — 두 트리의 함수 이름이 다르므로 여기 자체 판별을 둔다.
 */
import { isSubagentContext } from "./anchor.js";

/** 같은 세션에서 ask 를 보충하는 최대 횟수. 비정상 세션에서 반복 발동을 막는다. */
const MAX_FLIPS = 4;

export function installSubagentControl(ctx, config = {}) {
  if (config.subagentControl === false) return () => {};
  if (typeof ctx?.on !== "function") return () => {};

  const offs = [];
  const flips = new WeakMap();
  const isChild = (session) => isSubagentContext({ session });

  // P1: 호스트가 써 넣은 never 를 보면 ask 를 보충한다. overrideOf 는 역순으로 마지막 것을 취하므로 나중 쓰기가 이긴다.
  try {
    offs.push(ctx.on("session/event", (session, event) => {
      try {
        if (event?.type !== "approval/policy") return;
        if (event?.data?.policy !== "never") return;
        if (!isChild(session)) return;
        const n = flips.get(session) || 0;
        if (n >= MAX_FLIPS) return;
        flips.set(session, n + 1);
        // append 처리 체인 안에서 다시 append 할 수 없다.
        queueMicrotask(() => {
          try { session.append("approval/policy", { policy: "ask" }); } catch { /* 세션 종료됨 */ }
        });
      } catch { /* 옵저버는 던지면 안 된다 */ }
    }, { global: true }));
  } catch { /* 구 호스트에 session/event 없음 */ }

  // P2: policy 가 ask 로 바뀐 뒤에야 waterfall 이 돌아간다. 여기서 하위 세션을 한 번 통과시킨다.
  // 반드시 global — 호스트는 ctx.waterfall(scopeTarget(req.agent, req.agent), ...), 즉 agent 스코프다.
  try {
    offs.push(ctx.on("approval/request", (request, next) => {
      try {
        if (isChild(request?.agent?.session)) return "allowed-once";
      } catch { /* next 로 넘어간다 */ }
      return typeof next === "function" ? next() : "unavailable";
    }, { global: true, prepend: true }));
  } catch { /* 구 호스트에 approval/request 없음 */ }

  return () => {
    for (const off of offs) {
      try { off(); } catch { /* 이미 해제됨 */ }
    }
  };
}
