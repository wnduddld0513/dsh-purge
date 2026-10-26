/**
 * IP / 텍스트 정규화 도구(순수 함수, 의존성 없음).
 *
 * core.js 에서 뽑아낸 첫 번째 모듈 중 하나: 이 함수들은 데이터베이스를 건드리지 않고, Store 인스턴스에도 의존하지 않지만,
 * 5000 줄짜리 core.js 에 흩어져 있어서 단위 테스트를 하려면 SQLite 까지 함께 로드해야 했다.
 * 분리해 낸 뒤로는 따로 테스트하고 따로 읽을 수 있으며, core.js 가 "사실 저장소 의미론" 에 집중하기도 쉬워졌다.
 *
 * 내보내기 표면은 원래와 완전히 같다(core.js 가 그대로 한 번 더 내보낸다), 그래서 호출부는 고칠 필요가 없다.
 */

/**
 * IPv4 → 32비트 정수(ORDER BY 의 자연 정렬에 사용).
 * IPv6 는 이 경로를 탈 수 없다(문자열 split('.') 은 한 조각만 나온다), null 을 반환한다 ——
 * ip_int 를 NULL 로 유지하고, 정렬은 ip 텍스트 기준으로 되돌리며, 0 을 지어내거나 주소를 망가뜨리지 않는다.
 */
export const ipToInt = (ip) => {
  const text = String(ip || '').trim()
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(text)) return null
  return text.split('.').reduce((n, o) => (n * 256 + Number(o)) >>> 0, 0)
}

/** IPv6 리터럴인지 여부(:: 축약과 IPv4-mapped 표기 포함). */
export function isIpv6(ip) {
  const text = String(ip || '').trim()
  if (!text.includes(':')) return false
  return /^[0-9a-fA-F:]+(:\d{1,3}(\.\d{1,3}){3})?$/.test(text) && text.split(':').length <= 9
}

/** IPv6 를 8개 그룹의 16진수로 펼친다(앞 4개 그룹으로 /64 를 계산할 때만 쓰며, 완전한 엄밀성은 추구하지 않는다). */
export function expandIpv6(ip) {
  const text = String(ip || '').trim().replace(/^\[|\]$/g, '')
  const [head, tail] = text.split('::')
  const left = head === '' ? [] : head.split(':')
  const right = tail === undefined || tail === '' ? [] : tail.split(':')
  const missing = 8 - left.length - right.length
  const groups = left.concat(new Array(Math.max(missing, 0)).fill('0')).concat(right)
  return groups.map((g) => (g === '' ? '0' : g.toLowerCase()))
}

/**
 * 이 IP 가 어느 "세그먼트" 에 속하는지(자산 매핑 왼쪽에서 C 세그먼트로 그룹화).
 *   · IPv4 → 앞 세 세그먼트 + .0/24 (원래 동작 유지);
 *   · IPv6 → 앞 네 그룹 + ::/64 (IPv6 의 "하나의 네트워크 세그먼트" 는 /64 이며, IPv4 의 /24 에 대응한다);
 *   · 판별할 수 없으면 → 원문을 반환하고, `2001:db8::1.0/24` 같은 괴상한 값을 절대 만들어 내지 않는다.
 *     무조건 split('.') 으로 ".0/24" 를 붙이면 안 된다: IPv6 자산은 오염된 CIDR 을 얻게 되고,
 *     패널 왼쪽에 가짜 세그먼트가 하나 늘어나며 자산 귀속도 틀어진다.
 */
export const cidrOf = (ip) => {
  const text = String(ip || '').trim()
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(text)) return text.split('.').slice(0, 3).join('.') + '.0/24'
  if (isIpv6(text)) {
    const groups = expandIpv6(text)
    return groups.slice(0, 4).join(':') + '::/64'
  }
  return text
}

/**
 * IP 가 내부 네트워크인지 외부 네트워크인지 판정한다(패널이 이것으로 "내부 C 세그먼트 / 외부 C 세그먼트" 로 그룹화한다).
 *   · IPv4:10/8,192.168/16,127/8,169.254/16,172.16-31/12,100.64-127/10(CGNAT);
 *   · IPv6 — ULA(fc00::/7) 와 링크 로컬(fe80::/10)을 내부 네트워크로 본다;
 *   · IPv4-mapped 인 ::ffff:a.b.c.d 는 껍데기를 벗긴 뒤 IPv4 로 판정한다.
 * @param ip - 판정할 주소.
 * @returns 'internal' | 'external'
 */
export function scopeOfIp(ip) {
  const s = String(ip || '')
  /* IPv6 — ULA(fc00::/7) 와 링크 로컬(fe80::/10)은 내부 네트워크; IPv4-mapped 인 ::ffff:a.b.c.d 는 껍데기를 벗긴 뒤 IPv4 로 판정 */
  const mapped = /^::ffff:(\d{1,3}(\.\d{1,3}){3})$/i.exec(s)
  if (mapped !== null) return scopeOfIp(mapped[1])
  if (/^f[cd][0-9a-f]{2}:/i.test(s) || /^fe[89ab][0-9a-f]:/i.test(s)) return 'internal'
  if (/^(10\.|192\.168\.|127\.|169\.254\.)/.test(s)) return 'internal'
  const m = /^172\.(\d{1,3})\./.exec(s)
  if (m !== null) {
    const n = Number(m[1])
    if (n >= 16 && n <= 31) return 'internal'
  }
  const c = /^100\.(\d{1,3})\./.exec(s)
  if (c !== null) {
    const n = Number(c[1])
    if (n >= 64 && n <= 127) return 'internal'
  }
  return 'external'
}

/** 임의의 이름을 slug 로 정규화한다(전부 소문자, 영숫자가 아닌 문자는 하이픈으로). */
export function slugify(name) {
  const s = String(name || '').trim().toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
  return s === '' ? 'engagement-' + Date.now() : s
}

/**
 * 대상(IP / URL / C 세그먼트)을 공격 파일 디렉터리 이름으로 정규화한다.
 *  · IP 또는 ip:port → IP만 취한다(같은 IP 의 여러 포트는 한 폴더로 묶는다)
 *  · URL → host 만 취한다(프로토콜, 포트, 경로 제거)
 *  · C 세그먼트 10.0.0.0/24 → 10.0.0.0_24
 */
export function slugTarget(target) {
  const raw = String(target || '').trim()
  if (raw === '') return 'unknown'
  const ipMatch = /^(\d{1,3}(?:\.\d{1,3}){3})(?::\d+)?$/.exec(raw)
  if (ipMatch !== null) return ipMatch[1]
  const urlMatch = /^https?:\/\/([^/?#]+)/i.exec(raw)
  const hostPort = urlMatch !== null ? urlMatch[1] : raw
  const host = hostPort.replace(/:(\d+)$/, '')
  return host.replace(/[^\w.\-]/g, '_').replace(/_+$/, '') || 'unknown'
}

/** 지식 베이스 항목의 안정적인 식별자를 생성한다: 컴포넌트 + 번호/제목, 에이전트가 바로 인용할 수 있게. */
export function slugPoc(title, cve) {
  const t = String(title || '').trim()
  const c = String(cve || '').trim()
  /* 제목에 이미 CVE 가 적혀 있는 경우가 많으니 다시 붙이지 않는다(그러면 code 가 xxx-cve-2023-21839-cve-2023-21839 가 된다) */
  const flat = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '')
  const base = (c !== '' && !flat(t).includes(flat(c))) ? c + ' ' + t : t
  const slug = base.toLowerCase()
    .replace(/cve[-_ ]?(\d{4})[-_ ]?(\d+)/g, 'cve-$1-$2')
    .replace(/[^\w\u4e00-\u9fa5.-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/, '')
  return slug === '' ? 'poc-' + Date.now() : slug
}

/** 언어에 맞춰 본문에 적절한 파일 이름을 준다(에이전트가 그대로 따라 실행할 수 있다). */
export function defaultPocFilename(title, kind, language) {
  const ext = {
    python: 'py', py: 'py', go: 'go', java: 'java', bash: 'sh', sh: 'sh', shell: 'sh',
    js: 'js', node: 'js', php: 'php', ruby: 'rb', powershell: 'ps1', http: 'http', nuclei: 'yaml', yaml: 'yaml',
  }[String(language || '').toLowerCase()]
  if (ext) return 'poc.' + ext
  if (kind === 'template') return 'poc.yaml'
  return 'poc.txt'
}

/** ISO 타임스탬프(출구를 통일해 테스트 주입을 쉽게 한다). */
export const nowIso = () => new Date().toISOString()
