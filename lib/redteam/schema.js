import { DatabaseSync } from 'node:sqlite'
/* 득점/판정 규칙의 유일한 구현은 score-rules.js 이고, 이 파일에는 DDL 과 마이그레이션만 둡니다.
   migrate() 에서 쓰는 parseTargetPort 도 거기서 가져오며, 더 이상 사본을 두지 않습니다. */
import { parseTargetPort } from './score-rules.js'

/**
 * 팩트 DB schema 와 증분 마이그레이션(의존성 없음).
 *
 * core.js 에서 분리해 낸 모듈: **DDL 과 마이그레이션이 "데이터 형상"의 유일한 정의처**이며,
 * "이 데이터를 어떻게 쓰는가"(RedteamStore 의 메서드)와 분리한 뒤로는,
 * schema 를 볼 때 500 줄의 득점 로직을 넘지 않아도 되고, 테이블 구조를 고쳐도 업무 코드를 건드리지 않습니다.
 *
 * 두 곳의 마이그레이션은 같은 원칙을 따릅니다: **먼저 PRAGMA 를 조회한 뒤 ADD COLUMN**, 반복 실행 가능하며 구 DB 는 재생성하지 않습니다.
 * 테이블 구조를 읽지 못하면 일괄로 "이 열이 없음"으로 처리하고(false 반환), ensure 가 ALTER 를 시도하게 넘깁니다;
 * 반대로 "열이 이미 존재"로 보면 마이그레이션이 조용히 건너뛰어져, 장애 지점이 "마이그레이션 실패"에서 원격 SQL 실행처로 옮겨갑니다.
 */

/* ------------------------------------------------------------------ FTS5 지원 감지 */

/**
 * 이 머신의 `node:sqlite` 에 FTS5 가 있는지 여부.
 *
 * **반드시 감지해야 합니다**: FTS5 는 컴파일 시점 옵션이라 Node 빌드마다 다릅니다 ——
 * Node 22.14 의 `node:sqlite` 에는 없고(`no such module: fts5`) 22.23 에는 있습니다.
 * 그래서 존재를 전제할 수 없습니다: CI 와 로컬 Node 버전이 다르면 DDL 전체를 만들 수 없습니다.
 * 의미: FTS5 가 없을 때만 LIKE 검색으로 폴백하며, FTS5 가 있는 머신은 동작이 전혀 바뀌지 않습니다.
 *
 * `REDTEAM_NO_FTS5=1` 로 폴백 경로를 강제할 수 있습니다: CI 의 Node 가 FTS5 가 있는 버전으로 바뀌면
 * 폴백 분기를 아무도 실행하지 않게 되므로, 능동적으로 발동할 스위치를 남겨 둬야 합니다(test/fts-fallback.test.mjs 참고).
 */
export const HAS_FTS5 = (() => {
  if (process.env.REDTEAM_NO_FTS5 === '1') return false
  try {
    const probe = new DatabaseSync(':memory:')
    try {
      probe.exec('CREATE VIRTUAL TABLE __fts5_probe USING fts5(x)')
      return true
    } finally {
      probe.close()
    }
  } catch {
    return false
  }
})()

/* ------------------------------------------------------------------ FTS 가상 테이블 DDL */

/**
 * 전문 검색 가상 테이블 두 개. **따로 내보냅니다**. FTS5 에 의존하기 때문입니다:
 * FTS5 가 없는 빌드에서 테이블을 만들면 `no such module: fts5` 를 던져 DDL 전체를 함께 무너뜨립니다.
 * 호출 측은 `HAS_FTS5` 에 따라 DDL 에 넣을지 결정합니다(core.js 의 db() / kb() 참고).
 */
export const ASSET_FTS_DDL = `
CREATE VIRTUAL TABLE IF NOT EXISTS asset_fts USING fts5(
  asset_id UNINDEXED, ip, names, banners, titles, fingerprints
);
`

export const POC_FTS_DDL = `
CREATE VIRTUAL TABLE IF NOT EXISTS poc_fts USING fts5(
  poc_id UNINDEXED, title, cve, component, versions, tags, description, content
);
`

/* ------------------------------------------------------------------ 대상 라이브러리 schema */

export const DDL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS scan_run (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_session_id TEXT, tool TEXT, argv TEXT,
  started_at TEXT, finished_at TEXT, status TEXT DEFAULT 'running'
);

CREATE TABLE IF NOT EXISTS segment (
  cidr TEXT PRIMARY KEY, ip_start TEXT, ip_end TEXT,
  org TEXT, asn TEXT, country TEXT, city TEXT,
  source TEXT, first_seen TEXT, last_seen TEXT
);

CREATE TABLE IF NOT EXISTS asset (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  segment_cidr TEXT NOT NULL, ip TEXT NOT NULL, ip_int INTEGER,
  state TEXT DEFAULT 'unknown', primary_name TEXT, confidence REAL,
  first_seen TEXT, last_seen TEXT, discovered_at TEXT,
  test_status TEXT DEFAULT 'untested', test_notes TEXT, test_surface TEXT,
  test_updated_at TEXT, test_updated_by TEXT, blocked_count INTEGER DEFAULT 0,
  priority TEXT, potential TEXT, assess_reason TEXT, assessed_at TEXT, assessed_by TEXT,
  UNIQUE(segment_cidr, ip)
);

CREATE TABLE IF NOT EXISTS asset_name (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_id INTEGER NOT NULL, name TEXT NOT NULL, kind TEXT,
  provenance TEXT, tool TEXT, first_seen TEXT, last_seen TEXT,
  UNIQUE(asset_id, name, kind)
);

CREATE TABLE IF NOT EXISTS port (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_id INTEGER NOT NULL, proto TEXT DEFAULT 'tcp', port INTEGER NOT NULL,
  state TEXT DEFAULT 'open', provenance TEXT, tool TEXT, banner TEXT,
  url TEXT, title TEXT,
  first_seen TEXT, last_seen TEXT,
  UNIQUE(asset_id, proto, port)
);

CREATE TABLE IF NOT EXISTS service (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  port_id INTEGER NOT NULL, name TEXT, product TEXT, version TEXT, cpe TEXT,
  provenance TEXT, tool TEXT, first_seen TEXT, last_seen TEXT
);

CREATE TABLE IF NOT EXISTS fingerprint (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_id INTEGER NOT NULL, port_id INTEGER,
  category TEXT, vendor TEXT, product TEXT, version TEXT,
  evidence TEXT, confidence REAL, provenance TEXT, tool TEXT,
  first_seen TEXT, last_seen TEXT
);

CREATE TABLE IF NOT EXISTS observation (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_kind TEXT NOT NULL, entity_id INTEGER NOT NULL,
  attr TEXT, value TEXT, provenance TEXT, tool TEXT,
  scan_run_id INTEGER, collected_at TEXT, raw_ref TEXT
);

CREATE TABLE IF NOT EXISTS edge (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  src_kind TEXT NOT NULL, src_id TEXT NOT NULL,
  dst_kind TEXT NOT NULL, dst_id TEXT NOT NULL,
  relation TEXT NOT NULL, confidence REAL, scan_run_id INTEGER,
  first_seen TEXT, last_seen TEXT,
  UNIQUE(src_kind, src_id, dst_kind, dst_id, relation)
);

CREATE TABLE IF NOT EXISTS tag (
  entity_kind TEXT NOT NULL, entity_id INTEGER NOT NULL, tag TEXT NOT NULL,
  note TEXT, created_by TEXT, created_at TEXT,
  PRIMARY KEY (entity_kind, entity_id, tag)
);

CREATE TABLE IF NOT EXISTS vuln (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_id INTEGER, port_id INTEGER, cve TEXT, title TEXT, severity TEXT,
  source TEXT, confidence REAL, status TEXT, evidence TEXT, target TEXT,
  found_by_agent TEXT, found_at TEXT, gained TEXT, agent TEXT
);

/* 득점 항목: 공방 드릴 득점 규칙에서 오며, 사용자가 편집할 수 있습니다(점수, 활성화, 분류). */
CREATE TABLE IF NOT EXISTS score_point (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT UNIQUE,
  name TEXT NOT NULL,
  category TEXT,
  points INTEGER DEFAULT 0,
  max_hits INTEGER DEFAULT 1,
  description TEXT,
  enabled INTEGER DEFAULT 1,
  sort_order INTEGER DEFAULT 0,
  created_at TEXT, updated_at TEXT,
  /* ── "돌파 침입류 득점 규칙"에 따라 추가한 판정 필드(v0.11.0)────────────────────
     rule 값: 규칙 번호(RULE 1…25); **같은 rule 의 득점 항목은 해당 규칙의 득점 상한을 공유합니다**
     tier 값: 같은 규칙 안의 등급(일반 권한/관리자 권한/가점…), 패널과 보고서가 이 값으로 그룹해 표시합니다
     cap 값: 해당 rule 의 누적 득점 상한(0 = 상한 없음)
     dedup_scope 값: 득점 기준 service(같은 자산의 같은 포트는 가장 높은 한 건만 인정) / system(같은 시스템은 최고 권한 한 번만 인정)
                  / target(대상 전체에서 한 번만 인정) / none(대수/카드/노드 단위로 누적)
     legacy 값: 1 = 구버전 득점 항목(마이그레이션 후 보존하되 비활성화, 역사 참조용이며 새 기준 득점에는 참여하지 않음) */
  /* src 값: "돌파 침입류 득점 규칙(병합판)"의 원래 번호(병합 행은 첫 원 번호를 기록), 원본 표와 대조하는 용도로만 사용 */
  src INTEGER,
  rule INTEGER,
  tier TEXT,
  cap INTEGER DEFAULT 0,
  dedup_scope TEXT DEFAULT 'service',
  legacy INTEGER DEFAULT 0,
  /* builtin 값: 1 = "돌파 침입류 득점 규칙"과 함께 배포되는 내장 득점 항목(점수/상한/기준이 규칙에 고정되고,
     사용자는 "활성화/비활성화"만 바꿀 수 있음); 0 = 사용자가 만든 항목(자유롭게 편집 가능하며 시딩 로직이 지우지 않음).
     내장 여부 판정은 **반드시 이 플래그를 봐야 하며**, code 명단으로 판단하면 안 됩니다: 사용자가 만든 득점 항목이 구 체계 잔재로 판정되면
     다음 득점 패널 조회 때 적중과 함께 삭제되지만, 쓰기 측은 여전히 성공을 반환합니다. */
  builtin INTEGER DEFAULT 0
);

/* 득점 기록: 어떤 득점 항목이 어떤 대상에서 달성됨 */
/* 작전 단계: 전체 체인 공격 경로도의 다섯 단계(내용 편집 가능) */
CREATE TABLE IF NOT EXISTS stage (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  subtitle TEXT,
  color TEXT,
  goal TEXT,
  sections TEXT,
  tools TEXT,
  transition TEXT,
  sort_order INTEGER DEFAULT 0,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS score_hit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  point_id INTEGER NOT NULL,
  asset_id INTEGER, vuln_id INTEGER, step_id INTEGER, target TEXT,
  evidence TEXT, note TEXT,
  self_created INTEGER DEFAULT 0,
  port INTEGER,
  recorded_by TEXT, recorded_at TEXT,
  /* 이번 적중의 실제 점수(NULL = 득점 항목의 기본 points 사용).
     "병합판"은 같은 항목의 여러 등급을 한 줄로 합쳤습니다(예: 서버 호스트 권한 "일반 10 / 관리자 50",
     도메인 컨트롤 "1급 50 / 2급 20"), **등급 차이는 각각의 적중 행에만 담을 수 있고**,
     그렇지 않으면 "권한은 높은 것만 한 번 계산"을 표현할 수 없습니다. */
  points INTEGER,
  /* 배율: G5 데이터 규모 2배(×2) / G6 IPv6 성과 ×3. **권한 점수에 적용**되며,
     points 와 곱한 뒤 상한 누적에 참여합니다. 저장하는 이유는 패널과 보고서가 "이 항목이 왜 200 점인지" 설명할 수 있게 하기 위함이고,
     읽는 사람이 점수 계산이 틀렸다고 오해하지 않게 하기 위함입니다. */
  multiplier REAL DEFAULT 1
);

/* 자격 증명: secret_value 는 평문 비밀번호/키를 저장하고(패널이 그대로 표시해 언제든 재사용 가능), secret_ref 는 runs/ 아래의 증거 파일을 가리킵니다.
   주의: 이 DB 는 이 머신에만 있으며, DB 파일이나 내보낸 내용을 어떤 저장소에도 커밋하면 안 됩니다. */
CREATE TABLE IF NOT EXISTS credential (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_id INTEGER, host TEXT, username TEXT, secret_type TEXT,
  secret_value TEXT, secret_ref TEXT,
  privilege TEXT, source TEXT, tool TEXT, note TEXT,
  found_by_agent TEXT, found_at TEXT, agent TEXT,
  UNIQUE(host, username, secret_type)
);

/* 접근 세션: 입구를 확보한 뒤의 통제된 접근 1회 기록(횡적 이동의 시작점) */
CREATE TABLE IF NOT EXISTS access_session (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_id INTEGER, host TEXT, username TEXT, method TEXT, privilege TEXT,
  session_ref TEXT, note TEXT, found_by_agent TEXT, obtained_at TEXT
);

/* WebShell, 이미 올라간 통제 가능한 입구. 에이전트가 언제든 재사용할 수 있어 "끝까지 가서 webshell 이 있는 걸 잊는" 일을 막습니다 */
CREATE TABLE IF NOT EXISTS webshell (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_id INTEGER, url TEXT NOT NULL, shell_type TEXT, pass_key TEXT,
  secret_ref TEXT, privilege TEXT,
  status TEXT DEFAULT 'unknown', last_check TEXT, check_note TEXT, latency_ms INTEGER,
  note TEXT, found_by_agent TEXT, created_at TEXT, updated_at TEXT, agent TEXT,
  UNIQUE(url, pass_key)
);

/* 내부 네트워크 터널: suo5 / socks5 / ssh -R / frp 등. 입구, 리스닝 주소, 도달 가능한 대역을 기록 */
CREATE TABLE IF NOT EXISTS tunnel (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_id INTEGER, webshell_id INTEGER, kind TEXT, listen TEXT,
  entry TEXT, reach TEXT,
  entry_kind TEXT,
  status TEXT DEFAULT 'unknown', last_check TEXT, check_note TEXT, latency_ms INTEGER,
  pid TEXT, command TEXT, note TEXT, found_by_agent TEXT, created_at TEXT, updated_at TEXT, agent TEXT
);

/* HTTP 증거: 원본 요청/응답. Burp Suite / Yakit 에 그대로 붙여 재현할 수 있습니다 */
CREATE TABLE IF NOT EXISTS http_evidence (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  vuln_id INTEGER, asset_id INTEGER, label TEXT,
  method TEXT, url TEXT, status INTEGER,
  request TEXT, response TEXT, note TEXT,
  captured_by TEXT, captured_at TEXT
);

/* 공격 파일: 특정 대상에서 실제로 통한 스크립트/POC/EXP(검증된 유효한 것만 수록) */
CREATE TABLE IF NOT EXISTS attack_file (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  target TEXT NOT NULL, target_kind TEXT, name TEXT NOT NULL, kind TEXT,
  path TEXT NOT NULL, description TEXT, evidence TEXT,
  asset_id INTEGER, vuln_id INTEGER, created_by TEXT, created_at TEXT,
  UNIQUE(target, name)
);

/* 공격 체인 단계: 사람/에이전트가 기록한 체인 노드로, 공격 체인 페이지와 보고서에 사용합니다.
   tool/agent/result 세 열은 "이 단계를 어떻게 했는지"의 증빙입니다: 보고서에 계정과 비밀번호가 어떻게 나왔는지,
   터널을 어떻게 세웠는지를 단계의 도구와 명령 원문으로 밝힙니다. */
CREATE TABLE IF NOT EXISTS attack_step (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  seq INTEGER, stage TEXT, title TEXT, detail TEXT,
  asset_id INTEGER, vuln_id INTEGER, access_id INTEGER, point_id INTEGER,
  evidence_ref TEXT, tool TEXT, agent TEXT, result TEXT,
  recorded_by TEXT, recorded_at TEXT
);

/* 증거 스크린샷: 득점 성과의 "눈에 보이는" 자료.
   저장 위치: <대상 디렉터리>/shots/, DB 에는 파일명과 메타데이터만 저장합니다 —— 이미지는 SQLite 에 넣지 않습니다.
   kind 값: screenshot 현장 스크린샷; card 기록에서 생성한 증거 발췌 카드로, 보고서에서는 구분해 표기해야 합니다. */
CREATE TABLE IF NOT EXISTS shot (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  point_id INTEGER, hit_id INTEGER, asset_id INTEGER, vuln_id INTEGER,
  target TEXT, label TEXT, note TEXT,
  file TEXT NOT NULL,
  kind TEXT DEFAULT 'screenshot',
  mime TEXT, bytes INTEGER, width INTEGER, height INTEGER, sha256 TEXT,
  source_ref TEXT, captured_at TEXT, found_by_agent TEXT, agent TEXT, created_at TEXT,
  UNIQUE(file)
);


CREATE INDEX IF NOT EXISTS ix_asset_segment ON asset(segment_cidr);
CREATE INDEX IF NOT EXISTS ix_asset_ip_int ON asset(ip_int);
CREATE INDEX IF NOT EXISTS ix_port_asset ON port(asset_id);
CREATE INDEX IF NOT EXISTS ix_port_port ON port(port);
CREATE INDEX IF NOT EXISTS ix_service_port ON service(port_id);
CREATE INDEX IF NOT EXISTS ix_service_name ON service(name, product, version);
CREATE INDEX IF NOT EXISTS ix_fp_asset ON fingerprint(asset_id);
CREATE INDEX IF NOT EXISTS ix_fp_product ON fingerprint(product, version);
CREATE INDEX IF NOT EXISTS ix_edge_src ON edge(src_kind, src_id);
CREATE INDEX IF NOT EXISTS ix_edge_dst ON edge(dst_kind, dst_id);
CREATE INDEX IF NOT EXISTS ix_obs_entity ON observation(entity_kind, entity_id);
CREATE INDEX IF NOT EXISTS ix_vuln_asset ON vuln(asset_id);
CREATE INDEX IF NOT EXISTS ix_vuln_sev ON vuln(severity, status);
CREATE INDEX IF NOT EXISTS ix_vuln_cve ON vuln(cve);
CREATE INDEX IF NOT EXISTS ix_cred_host ON credential(host);
CREATE INDEX IF NOT EXISTS ix_access_host ON access_session(host);
CREATE INDEX IF NOT EXISTS ix_webshell_status ON webshell(status);
CREATE INDEX IF NOT EXISTS ix_tunnel_status ON tunnel(status);
CREATE INDEX IF NOT EXISTS ix_shot_point ON shot(point_id);
CREATE INDEX IF NOT EXISTS ix_shot_hit ON shot(hit_id);
CREATE INDEX IF NOT EXISTS ix_shot_asset ON shot(asset_id);
CREATE INDEX IF NOT EXISTS ix_http_vuln ON http_evidence(vuln_id);
CREATE INDEX IF NOT EXISTS ix_http_asset ON http_evidence(asset_id);
CREATE INDEX IF NOT EXISTS ix_step_seq ON attack_step(seq, id);
CREATE INDEX IF NOT EXISTS ix_attack_target ON attack_file(target);
CREATE INDEX IF NOT EXISTS ix_score_hit_point ON score_hit(point_id);
/* 보고서/공격 체인은 시간순으로 적중을 가져옵니다(scoreReport 의 ORDER BY h.recorded_at, h.id) */
CREATE INDEX IF NOT EXISTS ix_score_hit_time ON score_hit(recorded_at, id);
/* 보고서의 "이 단계에 어떤 공격 단계가 연결됐는가"는 asset_id / vuln_id / step_id 로 역조회 */
CREATE INDEX IF NOT EXISTS ix_score_hit_vuln ON score_hit(vuln_id);
CREATE INDEX IF NOT EXISTS ix_score_hit_step ON score_hit(step_id);
/* 공격 단계를 자산/취약점으로 역조회(보고서 추적과 #hitTrace 의 폴백 귀인 모두 이곳을 씁니다) */
CREATE INDEX IF NOT EXISTS ix_step_asset ON attack_step(asset_id);
CREATE INDEX IF NOT EXISTS ix_step_vuln ON attack_step(vuln_id);
CREATE INDEX IF NOT EXISTS ix_step_recorded ON attack_step(recorded_at);
/* 자산을 C 대역 + 상태로 필터(자산 매핑 좌측에서 특정 C 대역을 클릭하면 이 인덱스) */
CREATE INDEX IF NOT EXISTS ix_asset_segment_state ON asset(segment_cidr, state);
/* http 증거는 대상 URL 로 LIKE 폴백 매칭(scoreReport 가 명시적 연관을 못 찾을 때 사용) */
CREATE INDEX IF NOT EXISTS ix_http_url ON http_evidence(url);
/* 터널/트로이 목마를 자산과 상태로 조회(세션 페이지와 공격 체인 모두 필요) */
CREATE INDEX IF NOT EXISTS ix_tunnel_asset ON tunnel(asset_id);
CREATE INDEX IF NOT EXISTS ix_webshell_asset ON webshell(asset_id);
CREATE INDEX IF NOT EXISTS ix_credential_asset ON credential(asset_id);
CREATE INDEX IF NOT EXISTS ix_access_asset ON access_session(asset_id);
CREATE INDEX IF NOT EXISTS ix_score_hit_asset ON score_hit(asset_id);

CREATE VIEW IF NOT EXISTS v_asset_summary AS
SELECT a.id, a.ip, a.segment_cidr, a.state, a.primary_name, a.first_seen, a.last_seen,
  (SELECT COUNT(*) FROM port p WHERE p.asset_id = a.id AND p.state = 'open') AS open_ports,
  (SELECT COUNT(*) FROM observation o WHERE o.entity_kind = 'asset' AND o.entity_id = a.id AND o.provenance = 'passive') AS passive_signals,
  (SELECT COUNT(*) FROM observation o WHERE o.entity_kind = 'asset' AND o.entity_id = a.id AND o.provenance = 'active') AS active_signals
FROM asset a;

CREATE VIEW IF NOT EXISTS v_asset_service AS
SELECT p.asset_id, p.port, p.proto, p.provenance AS port_provenance,
       s.name AS service, s.product, s.version, s.provenance AS service_provenance
FROM port p LEFT JOIN service s ON s.port_id = p.id;
`

/* ------------------------------------------------------------------ 지식 베이스 schema */

export const KNOWLEDGE_DDL = `
CREATE TABLE IF NOT EXISTS poc (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL,                -- 안정 식별자(slug). 에이전트가 직접 인용할 수 있습니다
  title TEXT NOT NULL,
  kind TEXT,                         -- poc | exp | script | template | payload
  category TEXT,                     -- 분류: rce / deserialization / file-upload / sqli / unauthorized / auth-bypass / weak-password / ssrf / xxe / path-traversal / file-read / info-leak / privesc / tunnel / other
  cve TEXT,                          -- CVE / CNVD / 벤더 번호
  component TEXT,                    -- 컴포넌트/제품(Weblogic, Shiro, Weaver OA…)
  versions TEXT,                     -- 영향 버전
  severity TEXT,
  language TEXT,                     -- python | go | java | bash | http | nuclei | js | php
  source TEXT,                       -- web | self | manual | nuclei-template | kb
  source_url TEXT,
  description TEXT,
  usage TEXT,                        -- 사용법/명령줄 예시
  content TEXT,                      -- 본문(스크립트 / POC / 원본 요청)
  path TEXT,                         -- 저장 위치(pocs/<code>/<file>). 에이전트가 바로 cat 할 수 있습니다
  verified INTEGER DEFAULT 0,        -- 실제 검증 여부
  verified_note TEXT,                -- 검증 증거(어느 대상, 어떤 응답 출력)
  hit_count INTEGER DEFAULT 0,       -- 재사용된 횟수
  used_on TEXT,                      -- 최근 사용 위치(대상)
  -- 출처 추적: 이 지식이 어느 대상, 어느 자산에서 발견/검증되었는지(생성 시각은 created_at)
  engagement_id TEXT,
  engagement_name TEXT,
  asset_target TEXT,
  found_by_agent TEXT,
  tags TEXT,
  created_by TEXT, created_at TEXT, updated_at TEXT,
  UNIQUE(code)
);
CREATE INDEX IF NOT EXISTS ix_poc_cve ON poc(cve);
CREATE INDEX IF NOT EXISTS ix_poc_component ON poc(component);
CREATE INDEX IF NOT EXISTS ix_poc_kind ON poc(kind, verified);
/* 주의: 분류 / 출처 대상 두 인덱스는 **여기에 쓸 수 없습니다** —— 구 knowledge.db 의 poc 테이블에는 아직
   이 두 열이 없어서, CREATE INDEX 가 exec(DDL) 단계에서 곧바로
   "no such column: category" 를 던지고, 열을 추가하는 마이그레이션조차 실행되지 않습니다. migrateKnowledge() 가 열을 채운 뒤에 생성합니다. */
`

/* ------------------------------------------------------------------ 지식 베이스 분류 */



/**
 * 지식 베이스 분류(득점 항목/공격 표면 기준과 정렬): 에이전트가 채울 때 반드시 하나를 골라야 하며,
 * 패널이 이 값으로 그룹해, 사용자가 수백 건을 평면으로 보지 않고 "분류별로" 볼 수 있습니다.
 */
const POC_CATEGORIES = [
  { code: 'rce', name: '远程命令执行', hint: '框架/中间件/组件 RCE、表达式注入、模板注入' },
  { code: 'deserialization', name: '反序列化', hint: 'Java/PHP/.NET 反序列化链、fastjson/jackson 等' },
  { code: 'file-upload', name: '文件上传 getshell', hint: '上传绕过、解析漏洞、二次渲染、竞争' },
  { code: 'sqli', name: 'SQL 注入', hint: '注入点验证、拖库、写文件、提权' },
  { code: 'unauthorized', name: '未授权访问', hint: '未鉴权接口/服务（Redis、Docker、Actuator、Swagger 调用）' },
  { code: 'auth-bypass', name: '认证绕过 / 越权', hint: '登录绕过、JWT 缺陷、越权读写、逻辑缺陷' },
  { code: 'weak-password', name: '弱口令 / 口令爆破', hint: '管理端弱口令、数据库弱口令、默认口令' },
  { code: 'ssrf', name: 'SSRF', hint: '服务端请求伪造、云元数据、内网探测跳板' },
  { code: 'xxe', name: 'XXE', hint: 'XML 外部实体读取与 SSRF' },
  { code: 'path-traversal', name: '目录穿越 / 任意文件读取', hint: '路径穿越、任意文件读、源码/配置读取' },
  { code: 'info-leak', name: '信息泄露', hint: '配置/凭据/源码/备份泄露（能升级为得分的那些）' },
  { code: 'privesc', name: '提权 / 横向', hint: '本地提权、凭据复用、Pass-the-Hash、横向工具' },
  { code: 'tunnel', name: '隧道 / 代理', hint: 'suo5、frp、chisel、Neo-ReGeorg、内网代理' },
  { code: 'other', name: '其它', hint: '不属于上面任何一类（写清用途）' },
]
export { POC_CATEGORIES }

/** 분류 code → 표시 이름(알 수 없는 값은 그대로 반환하며 사용자 정의를 허용합니다). */
export function pocCategoryName(code) {
  const hit = POC_CATEGORIES.find((c) => c.code === String(code || ''))
  return hit ? hit.name : (code ? String(code) : '未归类')
}

/**
 * 구 항목의 분류 추정(마이그레이션 시 category 가 빈 항목에 표시).
 * 근거는 code/title/component 안의 키워드입니다 —— 적중하면 그 분류로, 모두 빗나가면 `other` 로 갑니다.
 * 순서가 곧 우선순위입니다: 구체적일수록 앞에 옵니다(예: "임의 파일 업로드"가 일반적인 "업로드"보다 우선).
 * 새로 쓰는 항목은 `redteam_poc_add` 의 `category` 인자가 결정하며, 이곳을 거치지 않습니다.
 */
export function guessPocCategory(text) {
  const t = String(text || '').toLowerCase()
  const has = (...words) => words.some((w) => t.includes(w))
  if (has('역직렬화', '\u53cd\u5e8f\u5217\u5316', 'deserial', 'shiro', 'fastjson', 'weblogic', 'log4j', 'jackson')) return 'deserialization'
  if (has('파일 업로드', '\u6587\u4ef6\u4e0a\u4f20', 'file-upload', 'fileupload', 'upload', 'getshell', 'webshell', '웹셸 기록', '\u5199\u9a6c')) return 'file-upload'
  if (has('sql 인젝션', 'sql \u6ce8\u5165', 'sqli', 'sql\u6ce8\u5165', '인젝션 탈취', '\u6ce8\u5165\u62d6\u5e93', 'union select')) return 'sqli'
  if (has('약한 비밀번호', '\u5f31\u53e3\u4ee4', '무차별 대입', '\u7206\u7834', 'brute', '기본 비밀번호', '\u9ed8\u8ba4\u53e3\u4ee4', '기본 자격 증명', '\u9ed8\u8ba4\u51ed\u636e', 'hydra')) return 'weak-password'
  if (has('터널', '\u96a7\u9053', 'socks', 'suo5', 'frp', 'chisel', 'regeorg', '프록시', '\u4ee3\u7406')) return 'tunnel'
  if (has('권한 미검사', '\u672a\u6388\u6743', 'unauth', '인증 불필요', '\u514d\u8ba4\u8bc1', '인가 불필요', '\u514d\u9274\u6743', '검증 없음', '\u672a\u9274\u6743', '무인증', '\u65e0\u9274\u6743')) return 'unauthorized'
  if (has('권한 초과', '\u8d8a\u6743', '인증 우회', '\u8ba4\u8bc1\u7ed5\u8fc7', '인가 우회', '\u9274\u6743\u7ed5\u8fc7', 'jwt', '로직 취약점', '\u903b\u8f91\u6f0f\u6d1e', '캡차 우회', '\u9a8c\u8bc1\u7801\u7ed5\u8fc7', 'auth-bypass')) return 'auth-bypass'
  if (has('rce', '명령 실행', '\u547d\u4ee4\u6267\u884c', '코드 실행', '\u4ee3\u7801\u6267\u884c', '표현식 주입', '\u8868\u8fbe\u5f0f\u6ce8\u5165', '템플릿 주입', '\u6a21\u677f\u6ce8\u5165', 'ssti', '명령어 주입', '\u547d\u4ee4\u6ce8\u5165', '원격 실행', '\u8fdc\u7a0b\u6267\u884c')) return 'rce'
  if (has('ssrf', '서버 측 요청 위조', '\u670d\u52a1\u7aef\u8bf7\u6c42\u4f2a\u9020')) return 'ssrf'
  if (has('xxe', '외부 엔티티', '\u5916\u90e8\u5b9e\u4f53')) return 'xxe'
  if (has('임의 파일 읽기', '\u4efb\u610f\u6587\u4ef6\u8bfb', '파일 읽기', '\u6587\u4ef6\u8bfb\u53d6', '디렉터리 순회', '\u76ee\u5f55\u7a7f\u8d8a', '경로 순회', '\u8def\u5f84\u7a7f\u8d8a', 'path traversal', 'lfi', '임의 파일 다운로드', '\u4efb\u610f\u6587\u4ef6\u4e0b\u8f7d')) return 'path-traversal'
  if (has('권한 상승', '\u63d0\u6743', '측면 이동', '\u6a2a\u5411', 'pass-the-hash', 'mimikatz', 'impacket', '자격 증명 재사용', '\u51ed\u636e\u590d\u7528')) return 'privesc'
  if (has('정보 유출', '\u4fe1\u606f\u6cc4\u9732', '설정 유출', '\u914d\u7f6e\u6cc4\u9732', '민감 정보', '\u654f\u611f\u4fe1\u606f', '소스 유출', '\u6e90\u7801\u6cc4\u9732', '유출', '\u6cc4\u9732', 'leak')) return 'info-leak'
  return 'other'
}

/* ------------------------------------------------------------------ 대상 라이브러리 마이그레이션 */

/**
 * 경량 마이그레이션: 기존 DB 에 열을 보충합니다. 먼저 PRAGMA 를 조회한 뒤 ADD COLUMN 하며, 반복 실행해도 안전합니다.
 * 새 열을 추가할 때만 수행되므로, 구 대상 라이브러리는 재생성할 필요가 없습니다.
 */
export function migrate(db) {
  const has = (table, column) => {
    try {
      return db.prepare(`PRAGMA table_info(${table})`).all().some((row) => row.name === column)
    } catch {
      /* 테이블 구조를 읽지 못하면 반드시 false 를 반환해야 합니다(= "이 열이 없음"). ensure 가 ALTER 를 시도하게 하기 위함입니다.
         true 를 반환하면 마이그레이션이 조용히 건너뛰어지고, 이후 코드가 새 열 기준으로 SQL 을 써서 장애가 원격 SQL 오류로
         나타나고, 마이그레이션 실패로는 보이지 않습니다. */
      return false
    }
  }
  const ensure = (table, column, ddl) => {
    if (has(table, column)) return false
    try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`) } catch { /* 동시 마이그레이션 시 무시 */ }
    return true
  }
  ensure('vuln', 'target', 'TEXT')
  ensure('vuln', 'found_by_agent', 'TEXT')
  ensure('vuln', 'found_at', 'TEXT')
  ensure('port', 'url', 'TEXT')
  ensure('port', 'title', 'TEXT')
  ensure('asset', 'test_status', "TEXT DEFAULT 'untested'")
  ensure('asset', 'test_notes', 'TEXT')
  ensure('asset', 'test_surface', 'TEXT')
  ensure('asset', 'test_updated_at', 'TEXT')
  ensure('asset', 'test_updated_by', 'TEXT')
  ensure('asset', 'blocked_count', 'INTEGER DEFAULT 0')
  ensure('asset', 'priority', 'TEXT')
  ensure('asset', 'potential', 'TEXT')
  ensure('asset', 'assess_reason', 'TEXT')
  ensure('asset', 'assessed_at', 'TEXT')
  ensure('asset', 'assessed_by', 'TEXT')
  /* 발견 시각: 이 자산이 **이 DB 에 처음 들어온** 시각(반복 수집으로 갱신되지 않아 "언제 발견했는지" 알 수 있음).
     first_seen(데이터 소스/도구가 준 최초 등장 시각)과는 다른 값이며, 둘 다 남깁니다. */
  ensure('asset', 'discovered_at', 'TEXT')
  /* 이 기록을 만든 에이전트 역할(recon/assess/vuln-scan/exploit/internal),
     보고서에 "누가 발견했고 어떻게 확보했는지"를 밝혀야 합니다 */
  ensure('vuln', 'agent', 'TEXT')
  ensure('credential', 'agent', 'TEXT')
  ensure('webshell', 'agent', 'TEXT')
  ensure('tunnel', 'agent', 'TEXT')
  /* 공격 단계: 어떤 도구/명령을 썼고 누가 기록했는지. 보고서의 "터널을 어떻게 세웠고 트로이 목마를 어떻게 올렸는지"를 이 세 열로 밝힙니다 */
  ensure('attack_step', 'tool', 'TEXT')
  ensure('attack_step', 'agent', 'TEXT')
  ensure('attack_step', 'result', 'TEXT')
  /* 내부/외부망 차원: internal(내부 네트워크/사설 주소) | external(인터넷 도달 가능). 수동 지정이 자동 도출보다 우선 */
  ensure('asset', 'scope', 'TEXT')
  /* 이 취약점으로 무엇을 얻었는지: 계정 권한 / 서버 권한 / 내부 네트워크 터널 / 득점 항목 등 */
  ensure('vuln', 'gained', 'TEXT')
  /* 자격 증명 평문: 패널이 비밀번호를 직접 표시하므로 참조만 저장하지 않습니다(DB 는 로컬이며 내보내기/커밋 금지) */
  ensure('credential', 'secret_value', 'TEXT')
  /* 득점 항목을 "돌파 침입류 득점 규칙"에 맞춰 재구성(v0.11.0):
     rule/tier/cap/dedup_scope 가 "규칙 번호 + 등급 + 해당 규칙 상한 + 득점 기준"을 담습니다.
     구 DB 는 열을 보충한 뒤 seedScorePoints() 가 한 번만 마이그레이션합니다(구 기본 항목은 legacy 로 돌려 비활성화하고, 25 개 규칙의 득점 항목을 추가),
     사용자가 만든 득점 항목과 모든 과거 적중은 그대로 보존합니다. */
  ensure('score_point', 'rule', 'INTEGER')
  ensure('score_point', 'tier', 'TEXT')
  ensure('score_point', 'cap', 'INTEGER DEFAULT 0')
  ensure('score_point', 'dedup_scope', "TEXT DEFAULT 'service'")
  ensure('score_point', 'legacy', 'INTEGER DEFAULT 0')
  /* builtin 값: 내장 항목과 사용자 생성 항목을 구분(schema 주석 참고).
     구 DB 는 우선 0 으로 열을 만들고, 이후 seedScorePoints 가 DEFAULT_SCORE_POINTS 의 code 명단으로 백필합니다. */
  ensure('score_point', 'builtin', 'INTEGER DEFAULT 0')
  ensure('score_point', 'src', 'INTEGER')
  /* G5 / G6 배율(구 DB 는 열 보충, 기본 1 = 확대 없음) */
  ensure('score_hit', 'multiplier', 'REAL DEFAULT 1')
  /* 적중 행마다 점수를 지님(병합판이 등급을 한 줄로 합친 뒤 필수, score_hit 테이블 주석 참고) */
  ensure('score_hit', 'points', 'INTEGER')
  /* 득점 분류에는 개수 상한이 없음(max_hits 열은 구 DB 구조 호환용으로만 남기며 득점 계산에는 쓰지 않음) */
  /* 득점 ↔ 취약점/단계 연관: 보고서의 원본 요청 조회와 흐름도 연결선에 사용 */
  ensure('score_hit', 'vuln_id', 'INTEGER')
  ensure('score_hit', 'step_id', 'INTEGER')
  ensure('attack_step', 'point_id', 'INTEGER')
  /* 공격 체인을 새로 만들었음: 구 5단계 행은 전부 무효이며 attck 열은 제거 */
  try {
    /* 주의: 'target' 은 신구 두 판에서 이름이 같으므로 반드시 이름으로 구분해야 합니다. 그렇지 않으면 두 번째 열 때 새 버전 단계가 삭제됩니다 */
    db.prepare("DELETE FROM stage WHERE code IN ('external','foothold','tunnel','privilege')").run()
    db.prepare("DELETE FROM stage WHERE code = 'target' AND name = '\u9776\u6807\u7cfb\u7edf\u6743\u9650'").run()
    db.prepare("DELETE FROM stage WHERE code NOT IN ('recon','internet','boundary','internal','target')").run()
  } catch { /* 테이블이 아직 없으므로 무시 */ }
  if (has('stage', 'attck')) {
    try { db.exec('ALTER TABLE stage DROP COLUMN attck') } catch { /* 구 SQLite 가 지원하지 않으면 유지 */ }
  }
  /* 공격 단계의 단계 값: 구 값은 이전 판의 단계 code 이므로, legacy stage 기준으로 다시 매핑되도록 비웁니다.
     주의: 'target' 은 새 판에서도 여전히 유효한 단계(⑤ 대상 권한)이므로 함께 지우면 안 됩니다 —— 그러면 열 때마다
     대상이 "⑤ 를 명시 지정"한 단계와 득점을 자동 도출로 되돌리게 됩니다. */
  try {
    db.prepare("UPDATE attack_step SET stage_code = NULL WHERE stage_code IN ('external','foothold','tunnel','privilege')").run()
    db.prepare("UPDATE score_hit SET stage_code = NULL WHERE stage_code IN ('external','foothold','tunnel','privilege')").run()
  } catch { /* 무시 */ }
  /* 단계 귀속은 각 득점별로 자동 도출하도록 바뀌었고, 득점 항목의 stage_code 는 폐기 */
  if (has('score_point', 'stage_code')) {
    try { db.exec('ALTER TABLE score_point DROP COLUMN stage_code') } catch { /* 무시 */ }
  }
  /* 블루팀 관점을 작전 단계에서 제거했습니다: 구 DB 는 이 열을 삭제합니다(실패하면 무시하며 사용에는 영향 없음) */
  if (has('stage', 'blue_team')) {
    try { db.exec('ALTER TABLE stage DROP COLUMN blue_team') } catch { /* 구 SQLite 가 지원하지 않으면 유지 */ }
  }
  /* 단계 귀속: 득점 적중이 명시적으로 덮어쓸 수 있음(기본은 자동 도출); 공격 단계는 소속 단계를 기록 */
  ensure('score_hit', 'stage_code', 'TEXT')
  /* 자체 생성 계정 표시: 직접 가입/직접 만든 계정은 득점 권한으로 치지 않고 과정 기록으로만 남깁니다(구 데이터 기본 0) */
  ensure('score_hit', 'self_created', 'INTEGER DEFAULT 0')
  /* 득점이 어느 "서비스"에 속하는지: 계정 계열 득점은 (자산, 포트) 단위로 상한이 걸리고, 같은 서비스는 최고 권한 한 번만 인정합니다.
     포트는 쓸 때 해석합니다(도구가 넘긴 port → target 안의 포트 → 해당 자산에 유일하게 등록된 포트); 구 데이터는 대상을 열 때 target 기준으로 한 번 백필합니다. */
  ensure('score_hit', 'port', 'INTEGER')
  try {
    const p = db.prepare("SELECT COUNT(*) AS n FROM score_hit WHERE port IS NULL AND target IS NOT NULL AND target <> ''").get().n
    if (p > 0) {
      const upd = db.prepare('UPDATE score_hit SET port = ? WHERE id = ?')
      for (const row of db.prepare("SELECT id, target FROM score_hit WHERE port IS NULL AND target IS NOT NULL AND target <> ''").all()) {
        const port = parseTargetPort(row.target)
        if (port !== null) upd.run(port, row.id)
      }
    }
  } catch { /* 테이블이 아직 없으므로 무시 */ }
  /* 터널 입구 귀속: 이 통로가 실제로 대상 경계를 넘었는지 판정(self-only 는 돌파로 치지 않음) */
  ensure('tunnel', 'entry_kind', 'TEXT')
  if (ensure('attack_step', 'stage_code', 'TEXT')) {
    try {
      const stmt = db.prepare('UPDATE attack_step SET stage_code = ? WHERE stage = ?')
      for (const [legacy, code] of Object.entries(LEGACY_STAGE_MAP)) stmt.run(code, legacy)
    } catch { /* 무시 */ }
  }
  /* 구 DB 백필: IP 귀속으로 내부/외부망을 자동 구분 */
  try {
    db.exec(`UPDATE asset SET scope = (${SCOPE_SQL}) WHERE scope IS NULL OR scope = ''`)
  } catch { /* 최초 DB 생성 시 테이블이 비어 있으므로 무시 */ }
  /* 구 DB 발견 시각 백필: discovered_at 이 없으면 first_seen 으로 대체(빈 값보다 낫습니다) */
  try {
    db.exec("UPDATE asset SET discovered_at = COALESCE(first_seen, last_seen) WHERE discovered_at IS NULL OR discovered_at = ''")
  } catch { /* 무시 */ }
}

/* ------------------------------------------------------------------ 지식 베이스 마이그레이션 */

/**
 * 지식 베이스 경량 마이그레이션: 기존 knowledge.db 에 열을 보충합니다(분류 / 출처 추적).
 * 대상 라이브러리 마이그레이션처럼 먼저 PRAGMA 를 조회한 뒤 ADD COLUMN 하며, 반복 실행해도 안전하고 구 DB 는 재생성하지 않습니다.
 */
export function migrateKnowledge(db) {
  const has = (column) => {
    try {
      return db.prepare('PRAGMA table_info(poc)').all().some((row) => row.name === column)
    } catch { return true }
  }
  const ensure = (column, ddl) => {
    if (has(column)) return
    try { db.exec(`ALTER TABLE poc ADD COLUMN ${column} ${ddl}`) } catch { /* 동시 마이그레이션 시 무시 */ }
  }
  ensure('category', 'TEXT')
  ensure('engagement_id', 'TEXT')
  ensure('engagement_name', 'TEXT')
  ensure('asset_target', 'TEXT')
  ensure('found_by_agent', 'TEXT')
  try { db.exec('CREATE INDEX IF NOT EXISTS ix_poc_category ON poc(category)') } catch { /* 무시 */ }
  try { db.exec('CREATE INDEX IF NOT EXISTS ix_poc_engagement ON poc(engagement_id)') } catch { /* 무시 */ }
  /* 구 항목에 분류가 없음: code/제목/컴포넌트의 키워드로 하나를 추정(추정 로직은 한 곳뿐, guessPocCategory 참고) */
  try {
    const rows = db.prepare("SELECT id, code, title, component FROM poc WHERE COALESCE(category, '') = ''").all()
    const upd = db.prepare('UPDATE poc SET category = ? WHERE id = ?')
    for (const row of rows) {
      upd.run(guessPocCategory([row.code, row.title, row.component].filter(Boolean).join(' ')), row.id)
    }
  } catch { /* 무시 */ }
}
