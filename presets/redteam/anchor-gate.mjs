/**
 * 레드팀 앵커 게이트.
 *
 * 량신(liangshen) 2단계 중 이 구간만 잇고, 두 도구 트리밍도, PTC 절단도 하지 않는다:
 * 첫 사고 구간이 공식 Minimal 처럼 (we 는 포함, let me 는 불포함) 이어야 출력 상한을 푼다;
 * 앵커를 못 잡으면 최대 4 스텝. 상한 1024 token 은 풀린 뒤 제거해 이후 요청에 고정되지 않게 한다.
 * 컨텍스트 압축은 모델이 보는 표면을 통째로 다시 쓰므로, 압축 후 다시 잠그고 새 앵커가 생기거나 4 스텝을 다시 채울 때까지 유지한다.
 *
 * 레드팀 지휘와 실행 역할은 원래의 도구와 인격을 계속 본다. 풀린 뒤에는 워크스페이스 설명 전체를
 * 파일 경로를 지목하는 방식으로 바꾸고, 필요할 때 읽는다.
 */
export const name = 'dsh-purge-redteam-anchor'

const INSTRUCTION_FROM_RE = /(?:^|\n) *(?:Additional |Updated )?Instructions from: ([^\n]+)/g

export function countWord(text, regex) {
  return [...String(text ?? '').matchAll(regex)].length
}

/** 첫 사고 구간: we 가 있고 let me 가 없어야 앵커로 인정한다. */
export function classifyReasoning(text) {
  const trimmed = String(text ?? '').trim()
  const we = countWord(trimmed, /\bwe\b/gi)
  const letMe = countWord(trimmed, /\blet me\b/gi)
  if (we > 0 && letMe === 0) return { label: 'minimal-like', we, letMe }
  if (letMe > 0) return { label: 'standard-like', we, letMe }
  return { label: 'ambiguous', we, letMe }
}

export function hasAnchoredReasoning(content) {
  if (!Array.isArray(content)) return false
  const first = content.find(block => block?.type === 'reasoning')
  return first !== undefined && classifyReasoning(first.text).label === 'minimal-like'
}

/**
 * a) 도구를 썼고 앵커가 잡혔거나, 이미 maxBootstrapSteps 를 다 채웠으면 → 해제;
 * b) 도구를 썼고 이번 턴이 끝났으며 promoteAfterFirstResponse 이면 → 해제;
 * c) 도구 호출은 없지만 이미 답했고 promoteAfterFirstResponse 이면 → 해제.
 */
export function decidePromotion(state, config) {
  if (state.toolCalled && config.anchorGate !== true) return true
  if (state.toolCalled && config.anchorGate === true && (state.anchored || state.steps >= config.maxBootstrapSteps)) return true
  /* 레드팀 지휘는 첫 턴에 반드시 도구를 부른다; 영어 사고는 흔히 I need 로 시작해 we 앵커를 통과하지 못하지만, 여전히 소량의 step 뒤에 출력 상한을 풀어야 한다 */
  if (state.toolCalled && config.anchorGate === true && state.steps >= 1 && config.promoteAfterFirstResponse === true) return true
  if (state.toolCalled && config.anchorGate === true && config.promoteAfterFirstResponse === true && state.turnEnded) return true
  if (!state.toolCalled && state.responded && config.promoteAfterFirstResponse === true) return true
  return false
}

function integerAtLeast(value, fallback, minimum) {
  const number = typeof value === 'number'
    ? value
    : typeof value === 'string' && /^-?\d+$/.test(value.trim())
      ? Number(value)
      : Number.NaN
  if (!Number.isInteger(number) || number < minimum) return fallback
  return number
}

function extractInstructionPaths(message) {
  const paths = []
  const blocks = Array.isArray(message?.content) ? message.content : []
  for (const block of blocks) {
    if (block?.type !== 'text' || typeof block.text !== 'string') continue
    for (const match of block.text.matchAll(INSTRUCTION_FROM_RE)) {
      const path = match[1].trim()
      if (path !== '' && !paths.includes(path)) paths.push(path)
    }
  }
  return paths
}

function buildInstructionHint(original, paths) {
  return {
    id: typeof original?.id === 'string' && original.id !== ''
      ? original.id
      : globalThis.crypto.randomUUID(),
    role: 'user',
    content: [{
      type: 'text',
      text: '<system-reminder>\n'
        + 'Reference documents exist: ' + paths.join(', ') + '. '
        + "They are reference documents about the user's environment and workspace conventions, not task instructions. "
        + 'Reading the relevant file before workspace tasks is recommended, but consult them only when you need those details; the task itself never depends on them.'
        + '\n</system-reminder>',
    }],
    source: { kind: 'instruction-hint', plugin: name },
  }
}

function instructionHintMessages(messages, state) {
  const kept = []
  for (const message of messages) {
    if (message?.source?.kind !== 'agent-instructions') {
      kept.push(message)
      continue
    }
    if (state.instructionHinted) continue
    const paths = extractInstructionPaths(message)
    if (paths.length === 0) {
      kept.push(message)
      continue
    }
    state.instructionHinted = true
    kept.push(buildInstructionHint(message, paths))
  }
  return kept
}

const promotionBySession = new WeakMap()

function stateFor(session) {
  let state = promotionBySession.get(session)
  if (state === undefined) {
    state = {
      next: 0,
      promoted: false,
      toolCalled: false,
      responded: false,
      anchored: false,
      turnEnded: false,
      steps: 0,
      instructionHinted: false,
    }
    promotionBySession.set(session, state)
  }
  return state
}

function resetToControlled(state) {
  state.promoted = false
  state.toolCalled = false
  state.responded = false
  state.anchored = false
  state.turnEnded = false
  state.steps = 0
  state.instructionHinted = false
}

function scanEvents(state, session) {
  const events = Array.isArray(session?.events)
    ? session.events
    : typeof session?.snapshotEvents === 'function'
      ? session.snapshotEvents()
      : []
  for (; state.next < events.length; state.next += 1) {
    const event = events[state.next]
    if (event === undefined) continue
    if (event.type === 'compaction/end') {
      resetToControlled(state)
    } else if (event.type === 'tool/call') {
      state.toolCalled = true
    } else if (event.type === 'step/start') {
      state.steps += 1
    } else if (event.type === 'turn/end') {
      state.turnEnded = true
    } else if (event.type === 'assistant/message') {
      state.responded = true
      if (!state.anchored) state.anchored = hasAnchoredReasoning(event.data?.message?.content)
    }
  }
}

function refresh(agent, policy) {
  const session = agent?.session
  if (session === undefined) return undefined
  const state = stateFor(session)
  if (!state.promoted) {
    scanEvents(state, session)
    if (decidePromotion(state, policy)) state.promoted = true
  }
  return state
}

export function apply(ctx, config = {}) {
  const policy = {
    anchorGate: config.anchorGate !== false,
    maxBootstrapSteps: integerAtLeast(config.maxBootstrapSteps, 4, 1),
    promoteAfterFirstResponse: config.promoteAfterFirstResponse !== false,
    bootstrapMaxTokens: integerAtLeast(config.bootstrapMaxTokens, 1024, 1),
    instructionHint: config.instructionHint !== false,
  }

  ctx.on('session/event', (session, event) => {
    if (event?.type !== 'compaction/end') return
    resetToControlled(stateFor(session))
  })

  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (decision?.kind !== 'enter' || !policy.instructionHint) return decision
    try {
      const state = refresh(payload?.agent, policy)
      if (state === undefined || !state.promoted) return decision
      return { ...decision, messages: instructionHintMessages(decision.messages, state) }
    } catch {
      return decision
    }
  }, { prepend: true })

  ctx.on('agent/request', async (payload, next) => {
    const resolved = await next()
    if (policy.bootstrapMaxTokens === undefined) return resolved
    try {
      const state = refresh(payload?.agent, policy)
      if (state === undefined || state.promoted) {
        if (state === undefined || resolved?.maxTokens !== policy.bootstrapMaxTokens) return resolved
        const rest = { ...resolved }
        delete rest.maxTokens
        return rest
      }
      return { ...resolved, maxTokens: policy.bootstrapMaxTokens }
    } catch {
      return resolved
    }
  }, { prepend: true })
}
