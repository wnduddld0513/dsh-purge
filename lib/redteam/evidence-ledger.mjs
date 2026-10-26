/**
 * 레드팀 증거 원장(REA 의 Evidence 사상을 실전에 살려 쓴 것이지, 그대로 베낀 것이 아니다)
 *
 * rea 의 Evidence 는 "정적 분석 결론"에 내용 주소를 부여하는 방식이다——observed/derived/inferred
 * 세 단계 신뢰도이고, 각 결론마다 SHA-256 의미 해시가 붙는다.
 *
 * 여기서는 레드팀 의미론으로 바꾼다:
 * · `claimed`   = 서브에이전트가 구두로 보고한 "내가 확보했다"——빨간 단어이므로 지휘 에이전트는 절대 그대로 믿으면 안 된다
 * · `observed`  = 실제 도구 응답 출력/데이터베이스 기록으로 확인된 것——지휘 에이전트가 대조한 뒤 채택한다
 * · `derived`   = observed 증거에서 추론해 낸 것
 * · `inferred`  = 서브에이전트/지휘 에이전트의 추측이며, 반드시 표시해야 한다
 *
 * 각 evidence 에는 `ev_id = "ev_" + sha256(정규화된 의미)` 가 있다——같은 내용이면 해시가 반드시 같고,
 * 한 글자만 바뀌어도 해시가 달라지므로, 저장 시 "서브에이전트가 말한 A 와 저장소에 기록된 A 가 정말 같은지" 검증할 수 있다.
 *
 * ResidualUnknown 은 rea 에서 배워 왔지만 의미를 바꿨다: rea 는 "분석이 닿지 못한 미지"를 기록하는 데 쓰고,
 * 여기서는 "레드팀 작전에서 아직**끝나지 않았고 증거가 아직 부족한** 문제"를 기록한다——예를 들어 "이 내부 네트워크 장비의
 * 22 포트가 SSH 일 수 있지만 아직 자격 증명을 찾지 못했다" 같은 것이다.
 *
 * 이 모듈은 의존성이 없고, Node 내장 crypto/sqlite 만 의존한다. 어떤 Cordis 서비스에도 의존하지 않는다.
 */

import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'

/* ── 신뢰도와 권위 열거 ──────────────────────────────────────────────── */

export const EVIDENCE_CONFIDENCE = ['claimed', 'observed', 'derived', 'inferred']

export const EVIDENCE_AUTHORITY = [
  'tool-output',      // 직접 도구 응답 출력 (nmap/fscan/curl 원본 출력)
  'database-record',  // 저장소에 이미 있는 행 (SELECT 로 조회한 것)
  'screenshot',       // 현장 스크린샷
  'request-replay',   // HTTP 원본 요청 재전송 성공
  'subagent-report',  // 서브에이전트 보고 (= claimed, 반드시 대조해야 한다)
  'operator-input',   // 사용자/운영자 제공
]

/** 서브에이전트 보고는 검증을 거쳐야만 claimed 에서 observed 로 승격할 수 있다 */
export const CONFIDENCE_REQUIRES_VERIFICATION = new Set(['claimed', 'inferred'])

/* ── 해시 도구 ──────────────────────────────────────────────────────── */

/** 정규화 JSON 은 키를 코드 포인트 순으로 정렬해, 의미가 같으면 해시도 반드시 같게 만든다 */
const canonicalize = (value) => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`
  const keys = Object.keys(value).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(value[k])}`).join(',')}}`
}

/** evidence 의 의미 해시를 계산해, "ev_" 접두사가 붙은 hex digest 를 돌려준다 */
export const evidenceId = (semantic) => {
  const canonical = canonicalize(semantic)
  return 'ev_' + createHash('sha256').update(canonical, 'utf8').digest('hex')
}

/* ── Evidence DDL (독립된 테이블이고, 기존 schema 는 건드리지 않는다) ─── */

export const EVIDENCE_LEDGER_DDL = `
CREATE TABLE IF NOT EXISTS evidence (
  ev_id TEXT PRIMARY KEY,
  confidence TEXT NOT NULL CHECK(confidence IN ('claimed','observed','derived','inferred')),
  authority TEXT NOT NULL,
  operation TEXT NOT NULL,
  parameters TEXT NOT NULL DEFAULT '{}',
  result TEXT NOT NULL,
  raw_ref TEXT,
  limitations TEXT NOT NULL DEFAULT '[]',
  supporting_ev_ids TEXT NOT NULL DEFAULT '[]',
  recorded_by TEXT,
  recorded_at TEXT,
  source_agent TEXT,
  engagement_id TEXT
);
CREATE INDEX IF NOT EXISTS ix_evidence_operation ON evidence(operation);
CREATE INDEX IF NOT EXISTS ix_evidence_confidence ON evidence(confidence);
CREATE INDEX IF NOT EXISTS ix_evidence_engagement ON evidence(engagement_id);

CREATE TABLE IF NOT EXISTS residual_unknown (
  unk_id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL DEFAULT 1,
  question TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open'
    CHECK(status IN ('open','investigating','blocked','contradicted','resolved')),
  severity TEXT NOT NULL DEFAULT 'medium'
    CHECK(severity IN ('low','medium','high','critical')),
  domain TEXT NOT NULL DEFAULT 'general',
  scope_digest TEXT,
  supporting_ev_ids TEXT NOT NULL DEFAULT '[]',
  contradicting_ev_ids TEXT NOT NULL DEFAULT '[]',
  required_authority TEXT,
  required_confidence TEXT,
  recommended_probe TEXT,
  resolution TEXT,
  recorded_by TEXT,
  recorded_at TEXT,
  resolved_at TEXT,
  engagement_id TEXT
);
CREATE INDEX IF NOT EXISTS ix_unknown_status ON residual_unknown(status);
CREATE INDEX IF NOT EXISTS ix_unknown_engagement ON residual_unknown(engagement_id);
`

/* ── EvidenceLedger 클래스 ───────────────────────────────────────────── */

/**
 * 특정 타깃 SQLite 핸들에 붙는 증거 원장.
 *
 * 사용법:
 *   import { EvidenceLedger, EVIDENCE_LEDGER_DDL } from './evidence-ledger.mjs'
 *   const ledger = new EvidenceLedger(db)   // db 는 타깃 데이터베이스의 DatabaseSync 핸들
 *   ledger.record({ operation: 'nmap_scan', result: {...}, ... })
 *
 * 데이터베이스를 직접 open/close 하지 않아 이중 소유권을 피한다; RedteamStore.db() 가 관리하는 핸들을 넘긴다.
 */
export class EvidenceLedger {
  /** @param db DatabaseSync 핸들 (이미 열려 있고 migrate 까지 끝난 상태) */
  constructor(db) {
    this.db = db
    this.db.exec(EVIDENCE_LEDGER_DDL)
  }

  /**
   * evidence 한 건을 기록한다.
   *
   * @param {object} input
   * @param {string} input.operation       작업 이름 (예: "nmap_scan", "suo5_tunnel_established")
   * @param {object} input.parameters      호출 파라미터 (정규화를 거쳐 해시에 참여한다)
   * @param {object} input.result          정규화 결과 (해시에 참여한다)
   * @param {string} [input.confidence]    기본값 'observed'
   * @param {string} [input.authority]     기본값 'tool-output'
   * @param {string[]} [input.limitations] 기본값 []
   * @param {string[]} [input.supporting_ev_ids] 기본값 []
   * @param {string} [input.recorded_by]   누가 기록했는지 (지휘 에이전트/서브 역할 이름)
   * @param {string} [input.source_agent]  어느 서브에이전트가 산출했는지
   * @param {string} [input.engagement_id] 타깃 id
   *
   * @returns {{ok:true, ev_id:string, duplicate:boolean}|{ok:false, error:string}}
   */
  record(input) {
    const {
      operation,
      parameters = {},
      result,
      confidence = 'observed',
      authority = 'tool-output',
      limitations = [],
      supporting_ev_ids = [],
      recorded_by,
      source_agent,
      engagement_id,
      raw_ref,
    } = input

    if (!operation || typeof operation !== 'string') {
      return { ok: false, error: 'operation is required and must be a string' }
    }
    if (result === undefined || result === null) {
      return { ok: false, error: 'result is required' }
    }
    if (!EVIDENCE_CONFIDENCE.includes(confidence)) {
      return { ok: false, error: `confidence must be one of ${EVIDENCE_CONFIDENCE.join(',')}` }
    }
    if (!EVIDENCE_AUTHORITY.includes(authority)) {
      return { ok: false, error: `authority must be one of ${EVIDENCE_AUTHORITY.join(',')}` }
    }

    const semantic = {
      operation,
      parameters: sanitizeForHash(parameters),
      result: sanitizeForHash(result),
      confidence,
      authority,
      limitations,
      supporting_ev_ids: [...supporting_ev_ids].sort(),
    }
    const ev_id = evidenceId(semantic)

    try {
      const existing = this.db
        .prepare('SELECT ev_id FROM evidence WHERE ev_id = ?')
        .get(ev_id)
      if (existing) return { ok: true, ev_id, duplicate: true }

      this.db
        .prepare(
          `INSERT INTO evidence
           (ev_id, confidence, authority, operation, parameters, result,
            raw_ref, limitations, supporting_ev_ids,
            recorded_by, recorded_at, source_agent, engagement_id)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          ev_id,
          confidence,
          authority,
          operation,
          JSON.stringify(parameters),
          JSON.stringify(result),
          raw_ref ?? null,
          JSON.stringify(limitations),
          JSON.stringify(supporting_ev_ids),
          recorded_by ?? null,
          new Date().toISOString(),
          source_agent ?? null,
          engagement_id ?? null,
        )
      return { ok: true, ev_id, duplicate: false }
    } catch (err) {
      return { ok: false, error: String(err.message ?? err) }
    }
  }

  /** ev_id 로 evidence 한 건을 가져온다 (JSON 필드는 이미 파싱된 상태) */
  get(ev_id) {
    try {
      const row = this.db
        .prepare('SELECT * FROM evidence WHERE ev_id = ?')
        .get(ev_id)
      if (!row) return undefined
      return parseEvidenceRow(row)
    } catch {
      return undefined
    }
  }

  /**
   * 대조: 서브에이전트가 "내가 X 를 해서 Y 를 얻었다"고 말할 때, 지휘 에이전트가 이것으로 검증한다.
   * { matched: true } 또는 { matched: false, expected_ev_id, actual_ev_id } 를 돌려준다
   */
  verify(input) {
    const { operation, parameters = {}, result, confidence = 'observed', authority = 'tool-output', limitations = [], supporting_ev_ids = [] } = input
    const semantic = {
      operation,
      parameters: sanitizeForHash(parameters),
      result: sanitizeForHash(result),
      confidence,
      authority,
      limitations,
      supporting_ev_ids: [...supporting_ev_ids].sort(),
    }
    const expected_ev_id = evidenceId(semantic)
    const found = this.get(expected_ev_id)
    return found
      ? { matched: true, ev_id: expected_ev_id }
      : { matched: false, expected_ev_id, actual_ev_id: null, note: 'no matching evidence in ledger' }
  }

  /**
   * claimed / inferred 를 observed 로 승격한다.
   * 레드팀 시나리오: 서브에이전트가 webshell 이 올라갔다고 보고하면(claimed), 지휘 에이전트가 curl 로 실제 확인한 뒤 승격한다.
   *
   * @returns {{ok:true, ev_id:string}|{ok:false, error:string}}
   */
  upgrade(input) {
    const { claimed_ev_id, verified_by, verified_result } = input
    const existing = this.get(claimed_ev_id)
    if (!existing) return { ok: false, error: `evidence not found: ${claimed_ev_id}` }
    if (existing.confidence === 'observed') return { ok: true, ev_id: claimed_ev_id }
    if (!CONFIDENCE_REQUIRES_VERIFICATION.has(existing.confidence)) {
      return { ok: false, error: `confidence '${existing.confidence}' does not require upgrade` }
    }

    // existing 은 이미 parseEvidenceRow 가 처리한 행이다: JSON 필드가 이미 객체이므로 두 번 parse 하지 않는다.
    return this.record({
      operation: existing.operation,
      parameters: existing.parameters,
      result: verified_result ?? existing.result,
      confidence: 'observed',
      authority: existing.authority === 'subagent-report' ? 'tool-output' : existing.authority,
      limitations: existing.limitations,
      supporting_ev_ids: [...existing.supporting_ev_ids, claimed_ev_id],
      recorded_by: verified_by ?? 'coordinator',
      source_agent: existing.source_agent,
      engagement_id: existing.engagement_id,
    })
  }

  /** 필터 조건을 만족하는 evidence 를 나열한다 (페이지 단위) */
  list(filter = {}) {
    const { operation, confidence, engagement_id, limit = 50, offset = 0 } = filter
    const conditions = []
    const params = []
    if (operation) { conditions.push('operation = ?'); params.push(operation) }
    if (confidence) { conditions.push('confidence = ?'); params.push(confidence) }
    if (engagement_id) { conditions.push('engagement_id = ?'); params.push(engagement_id) }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
    try {
      const rows = this.db
        .prepare(`SELECT * FROM evidence ${where} ORDER BY recorded_at DESC LIMIT ? OFFSET ?`)
        .all(...params, limit, offset)
      return rows.map(parseEvidenceRow)
    } catch (err) {
      return { error: String(err.message ?? err) }
    }
  }

  /**
   * 원장 안 claimed / inferred 의 **총 건수** (검증까지 끝나 닫힌 것도 포함).
   * 감사와 디버깅용이다; "아직 몇 건이 검증되지 않았는지" 알고 싶으면 countUnresolvedClaims 를 쓴다.
   */
  countUnverified(engagement_id) {
    try {
      const row = this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM evidence
           WHERE confidence IN ('claimed','inferred') AND engagement_id = ?`,
        )
        .get(engagement_id)
      return row?.n ?? 0
    } catch {
      return 0
    }
  }

  /**
   * 현재 타깃에 **어떤 observed 증거도 링크되어 있지 않은** claimed / inferred 가 몇 건인지.
   *
   * countUnverified 와의 차이: claimed 기록은 감사 규율상 영구 보존해야 한다(승격해도 체인이 끊기지 않는다),
   * 그래서 claimed 를 그냥 세면 전부 검증된 뒤에도 양수가 나온다——그것은 지휘 에이전트가 원하는 숫자가 아니다.
   * 여기서는 supporting_ev_ids 로 역추적한다: 어떤 claimed 이 임의의 observed 한 건의
   * supporting_ev_ids 에 들어 있으면 "검증되어 닫힌 것"으로 본다.
   *
   * 0 을 돌려주면 = 모든 서브에이전트 보고를 직접 검증했다는 뜻이다.
   */
  countUnresolvedClaims(engagement_id) {
    try {
      const rows = this.db
        .prepare(
          `SELECT ev_id FROM evidence
           WHERE confidence IN ('claimed','inferred') AND engagement_id = ?`,
        )
        .all(engagement_id)
      if (rows.length === 0) return 0
      /* 모든 observed 증거가 참조한 상위 ev_id 를 모은다 (= 검증되어 닫힌 claimed) */
      const closed = new Set()
      const observed = this.db
        .prepare(
          `SELECT supporting_ev_ids FROM evidence
           WHERE confidence = 'observed' AND engagement_id = ?`,
        )
        .all(engagement_id)
      for (const row of observed) {
        let ids = []
        try { ids = JSON.parse(row.supporting_ev_ids) } catch { /* 잘못된 데이터는 무시한다 */ }
        for (const x of ids) closed.add(x)
      }
      return rows.filter((r) => !closed.has(r.ev_id)).length
    } catch {
      return 0
    }
  }
}

/* ── ResidualUnknown (레드팀 의미론: 미해결이고 증거가 아직 부족한 작전 문제) ──── */

export class UnknownRegistry {
  constructor(db) {
    this.db = db
    this.db.exec(EVIDENCE_LEDGER_DDL) // 테이블 존재를 보장한다 (EvidenceLedger 와 DDL 을 공유한다)
  }

  /**
   * "아직 해결되지 않은" 작전 문제를 기록한다.
   *
   * 예:
   *   unk.record({
   *     question: '10.0.3.7:22 의 SSH 자격 증명은 무엇인가?',
   *     severity: 'high',
   *     domain: 'internal-recon',
   *     recommended_probe: 'hydra -l root -P /wordlists/ssh.txt 10.0.3.7 ssh',
   *   })
   */
  record(input) {
    const {
      question,
      severity = 'medium',
      domain = 'general',
      recommended_probe,
      supporting_ev_ids = [],
      engagement_id,
      recorded_by = 'coordinator',
    } = input

    if (!question || typeof question !== 'string') {
      return { ok: false, error: 'question is required' }
    }
    if (!['low', 'medium', 'high', 'critical'].includes(severity)) {
      return { ok: false, error: `severity must be low|medium|high|critical` }
    }

    const unk_id = 'unk_' + createHash('sha256')
      .update(canonicalize({ question: question.replace(/\s+/gu, ' ').trim(), domain }))
      .digest('hex')

    try {
      const existing = this.db
        .prepare('SELECT unk_id FROM residual_unknown WHERE unk_id = ?')
        .get(unk_id)
      if (existing) return { ok: true, unk_id, duplicate: true }

      this.db
        .prepare(
          `INSERT INTO residual_unknown
           (unk_id, revision, question, status, severity, domain,
            supporting_ev_ids, recommended_probe, recorded_by, recorded_at, engagement_id)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          unk_id,
          1,
          question.trim(),
          'open',
          severity,
          domain,
          JSON.stringify(supporting_ev_ids),
          recommended_probe ?? null,
          recorded_by,
          new Date().toISOString(),
          engagement_id ?? null,
        )
      return { ok: true, unk_id, duplicate: false }
    } catch (err) {
      return { ok: false, error: String(err.message ?? err) }
    }
  }

  /** resolved(증거가 충분하다) 또는 contradicted(잘못된 것으로 드러났다) 로 표시한다 */
  resolve(unk_id, disposition, resolution, resolved_by = 'coordinator') {
    if (!['resolved', 'contradicted', 'withdrawn'].includes(disposition)) {
      return { ok: false, error: 'disposition must be resolved|contradicted|withdrawn' }
    }
    try {
      this.db
        .prepare(
          `UPDATE residual_unknown
           SET status = ?, resolution = ?, resolved_at = ?
           WHERE unk_id = ?`,
        )
        .run(disposition, resolution ?? null, new Date().toISOString(), unk_id)
      return { ok: true, unk_id }
    } catch (err) {
      return { ok: false, error: String(err.message ?? err) }
    }
  }

  /** 현재 미해결 unknowns 를 나열한다 (지휘 에이전트가 다음에 누구를 보낼지 결정한다) */
  list(filter = {}) {
    const { status, severity, engagement_id, limit = 50, offset = 0 } = filter
    const conditions = []
    const params = []
    if (status) { conditions.push('status = ?'); params.push(status) }
    if (severity) { conditions.push('severity = ?'); params.push(severity) }
    if (engagement_id) { conditions.push('engagement_id = ?'); params.push(engagement_id) }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
    try {
      return this.db
        .prepare(`SELECT * FROM residual_unknown ${where} ORDER BY recorded_at DESC LIMIT ? OFFSET ?`)
        .all(...params, limit, offset)
        .map(parseUnknownRow)
    } catch (err) {
      return { error: String(err.message ?? err) }
    }
  }
}

/* ── 내부 도구 ──────────────────────────────────────────────────────── */

function parseEvidenceRow(row) {
  return {
    ...row,
    parameters: safeJsonParse(row.parameters, {}),
    result: safeJsonParse(row.result, null),
    limitations: safeJsonParse(row.limitations, []),
    supporting_ev_ids: safeJsonParse(row.supporting_ev_ids, []),
  }
}

function parseUnknownRow(row) {
  return {
    ...row,
    supporting_ev_ids: safeJsonParse(row.supporting_ev_ids, []),
    contradicting_ev_ids: safeJsonParse(row.contradicting_ev_ids, []),
  }
}

function safeJsonParse(text, fallback) {
  try {
    return JSON.parse(text)
  } catch {
    return fallback
  }
}

/** 해시에 넣기 전에 함수/undefined/BigInt 처럼 JSON 으로 표현할 수 없는 값을 제거한다 */
function sanitizeForHash(value) {
  if (value === undefined) return null
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'function') return '[function]'
  if (typeof value === 'symbol') return '[symbol]'
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(sanitizeForHash)
  const out = {}
  for (const [k, v] of Object.entries(value)) out[k] = sanitizeForHash(v)
  return out
}
