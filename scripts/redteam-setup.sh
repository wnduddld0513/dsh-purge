#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# 레드팀 모드 원클릭 환경 구성 —— 처음 사용할 때는 이 한 줄이면 충분
#
#   bash $DSH_HOME/redteam/setup.sh            # 대화형 안내 (권장)
#   bash $DSH_HOME/redteam/setup.sh --yes      # 완전 자동, 없는 것은 모두 설치 (VPS/key 는 기존 값 사용)
#   bash $DSH_HOME/redteam/setup.sh --check    # 점검만 하고 설치하지 않음 (CI / 문제 해결용)
#
# 네 가지를 한다:
#   ① 도구 설치: 레드팀 스킬이 쓰는 바이너리를 $DSH_HOME/redteam/toolkit/ 에 채운다
#   ② 스킬 설치: 스킬 디렉터리가 존재하고 보이는지 확인한다 (스킬은 패키지에 동봉되어 배포되며, 여기서는 점검과 안내만 한다)
#   ③ 설정 수집: 사용자에게 FOFA_KEY(측량)와 VPS 로그인 방식(리버스 Shell 착지)을 안내해 받는다
#   ④ 통로 검증: 페이로드 서비스, 템플릿 라이브러리, 바이너리 실행 가능성을 실제로 확인하고 마지막에 완료 표시를 쓴다
#
# 설계 원칙:
#   · **멱등**: 언제든 다시 실행 가능, 이미 설치된 것은 다시 설치하지 않는다 (--force 가 있어야 강제로 다시 받는다)
#   · **의존성 없음**: curl / python3 / tar / unzip 만 쓰고 Node 도 필요 없다
#   · **URL 을 추측하지 않음**: 전부 GitHub releases/latest API 로 실제 자산을 받는다
#   · **조용히 실패하지 않음**: 매 단계 결론을 출력하고, 마지막에 점검표를 준다
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
TK="$DSH_HOME/redteam/toolkit"
ENV_FILE="$DSH_HOME/.env"
MARKER="$DSH_HOME/redteam/.setup-complete"
LOG_DIR="$DSH_HOME/redteam"
LOG="$LOG_DIR/setup.log"
ASSUME_YES=0
CHECK_ONLY=0
FORCE=0

for arg in "$@"; do
  case "$arg" in
    --yes|-y)   ASSUME_YES=1 ;;
    --check)    CHECK_ONLY=1 ;;
    --force)    FORCE=1 ;;
    -h|--help)  sed -n '2,20p' "$0"; exit 0 ;;
  esac
done

mkdir -p "$TK" "$LOG_DIR"

# ── 출력 도구 ────────────────────────────────────────────────────────────────
C_OK=$'\033[32m'; C_WARN=$'\033[33m'; C_ERR=$'\033[31m'; C_DIM=$'\033[2m'; C_OFF=$'\033[0m'
say()  { printf '%s\n' "$*" | tee -a "$LOG"; }

# 실행 환경 경고: 이 스크립트는 이 컴퓨터에 VPS 개인 키, WebShell 웹셸과 스캐너를 남기므로, 훈련 전용 환경에서만 돌려야 한다
if [ -z "${REDTEAM_NO_VM_WARN:-}" ]; then
  say ""
  say "⚠️  레드팀 모드는 [훈련 전용 Kali 가상 머신]에서 실행하세요, 일상 업무용 PC/호스트 머신에서 돌리지 마세요:"
  say "    · 이 컴퓨터에 VPS 개인 키, Behinder/Godzilla 웹셸과 각종 스캐너가 남아, 보안 소프트웨어/EDR 이 차단하며 일상 환경을 오탐으로 건드릴 수 있습니다;"
  say "    · 스캔과 브루트포스 트래픽이 평소 쓰는 출구 IP 로 나가, 정상적인 인터넷 사용과 IP 평판에 영향을 줍니다;"
  say "    · 훈련이 끝나면 가상 머신을 그냥 버리는 것이 가장 깔끔합니다. (REDTEAM_NO_VM_WARN=1 을 설정하면 이 안내를 건너뜁니다)"
  say ""
fi
ok()   { say "  ${C_OK}✓${C_OFF} $*"; }
warn() { say "  ${C_WARN}!${C_OFF} $*"; }
bad()  { say "  ${C_ERR}✗${C_OFF} $*"; }
dim()  { say "  ${C_DIM}$*${C_OFF}"; }
head_() { say ""; say "── $* ──────────────────────────────────────────"; }

ask() { # ask <안내문> <기본값>  → 사용자 입력을 되돌려준다 (tty 가 없거나 --yes 이면 기본값 사용)
  local prompt="$1" def="${2:-}"
  if [ "$ASSUME_YES" = 1 ] || [ ! -t 0 ]; then printf '%s' "$def"; return; fi
  local ans
  printf '%s' "$prompt" > /dev/tty
  [ -n "$def" ] && printf ' [%s]' "$def" > /dev/tty
  printf ': ' > /dev/tty
  read -r ans < /dev/tty || ans=""
  printf '%s' "${ans:-$def}"
}

ask_secret() { # 에코 없이 읽기
  local prompt="$1"
  if [ "$ASSUME_YES" = 1 ] || [ ! -t 0 ]; then printf ''; return; fi
  local ans
  printf '%s: ' "$prompt" > /dev/tty
  read -rs ans < /dev/tty || ans=""
  printf '\n' > /dev/tty
  printf '%s' "$ans"
}

# ── 도구 함수 ────────────────────────────────────────────────────────────────
have() { command -v "$1" >/dev/null 2>&1; }

gh_api() { # gh_api <repo> → releases/latest JSON 출력 (gh token 이 있으면 사용, 할당량이 높다)
  local repo="$1" tok=""
  have gh && tok="$(gh auth token 2>/dev/null || true)"
  if [ -n "$tok" ]; then
    curl -s -m 30 -H "Authorization: Bearer $tok" "https://api.github.com/repos/$repo/releases/latest"
  else
    curl -s -m 30 "https://api.github.com/repos/$repo/releases/latest"
  fi
}

dl_asset() { # dl_asset <repo> <asset-regex> <출력 경로> [실행 파일]
  local repo="$1" pat="$2" out="$3" chmod_x="${4:-1}"
  if [ -s "$out" ] && [ "$FORCE" != 1 ]; then ok "이미 존재함 $(basename "$out")"; return 0; fi
  local json url name
  json="$(gh_api "$repo")"
  read -r name url <<<"$(printf '%s' "$json" | python3 -c "
import json,sys,re
pat=re.compile(sys.argv[1], re.I)
try: j=json.load(sys.stdin)
except Exception: sys.exit(1)
for a in j.get('assets') or []:
    if pat.search(a['name']): print(a['name'], a['browser_download_url']); break
" "$pat")"
  if [ -z "${url:-}" ]; then bad "$repo 에 일치하는 자산 없음 ($pat)"; return 1; fi
  # API 가 선언한 바이트 수: 다운로드 후 반드시 한 바이트도 달라서는 안 된다, 아니면 잘린 것이다 (조용한 손상이 다운로드 실패보다 더 위험하다——
  # 파일은 있고 실행 권한도 있는데, 실행하면 아무것도 하지 않는다. gowitness 에서 겪었다: 7MB 가 적었고, 실행하면 출력도 산출물도 없었다)
  local want
  want="$(printf '%s' "$json" | python3 -c "
import json,sys,re
pat=re.compile(sys.argv[1], re.I)
try: j=json.load(sys.stdin)
except Exception: sys.exit(0)
for a in j.get('assets') or []:
    if pat.search(a['name']): print(a.get('size') or 0); break
" "$pat")"
  dim "다운로드 $name (기대 ${want:-?} 바이트)"
  if curl -sL --retry 3 --retry-delay 2 --fail -m 600 "$url" -o "$out"; then
    local got; got="$(stat -c%s "$out" 2>/dev/null || echo 0)"
    if [ -n "$want" ] && [ "$want" != "0" ] && [ "$got" != "$want" ]; then
      bad "$name 다운로드 불완전: 기대 $want 바이트, 실제 $got (잘림), 삭제했으니 다시 실행하세요"
      rm -f "$out"; return 1
    fi
    [ "$chmod_x" = 1 ] && chmod +x "$out" 2>/dev/null
    ok "$name → $out ($got 바이트, 공식과 일치)"
  else
    bad "$name 다운로드 실패 (curl 종료 코드 $?)"; return 1
  fi
}

untar_all() { # untar_all <tarfile> <디렉터리> <기대하는 바이너리 이름...> → 전부 풀어 <디렉터리>/ 에 펼친다
  local tf="$1" dir="$2"; shift 2
  ( cd "$dir" && tar xzf "$tf" 2>/dev/null ) || { bad "$(basename "$tf") 압축 해제 실패"; return 1; }
  local name found sz
  for name in "$@"; do
    found="$(find "$dir" -maxdepth 3 -type f -name "$name" ! -name "*.tar.gz" 2>/dev/null | head -1)"
    if [ -n "$found" ]; then
      [ "$(dirname "$found")" != "$dir" ] && mv -f "$found" "$dir/$name"
      chmod +x "$dir/$name"
      sz="$(stat -c%s "$dir/$name" 2>/dev/null || echo 0)"
      # 스모크 테스트: 버전/도움말을 실제로 한 번 실행해, 실행되지 않으면 (잘림/.so 누락) 그 자리에서 보고한다
      if "$dir/$name" --version >/dev/null 2>&1 || "$dir/$name" -version >/dev/null 2>&1 \
         || "$dir/$name" -h >/dev/null 2>&1 || "$dir/$name" --help >/dev/null 2>&1; then
        ok "$name 준비 완료 ($sz 바이트, 스모크 테스트 통과)"
      else
        warn "$name 준비 완료 ($sz 바이트) 이나 스모크 테스트 무응답 —— 직접 한 번 실행해 확인하세요: $dir/$name --help"
      fi
    else
      bad "$name 을 패키지 안에서 찾지 못함"
    fi
  done
}

verify_bin() { # verify_bin <경로> → 실행되면 0 반환 (잘린 바이너리는 여기서 걸러진다)
  local p="$1"
  [ -x "$p" ] || return 1
  timeout 15 "$p" --version >/dev/null 2>&1 && return 0
  timeout 15 "$p" -version  >/dev/null 2>&1 && return 0
  timeout 15 "$p" -h        >/dev/null 2>&1 && return 0
  timeout 15 "$p" --help    >/dev/null 2>&1 && return 0
  timeout 15 "$p" version   >/dev/null 2>&1 && return 0
  return 1
}

# 설치 전 점검: 파일은 있는데 실행되지 않으면 (잘림/의존성 누락) → 삭제하고, 아래 설치 분기가 다시 받게 한다.
# 왜 반드시 이렇게 해야 하는가: 이전에는 "파일이 실행 가능한지"만 판정해서, 잘린 바이너리 (파일도 있고 권한도 맞는데
# 실행하면 출력이 없는 것) 가 계속 디스크에 남았다; 그리고 스크립트는 "다시 실행할 때 --force 를 붙이라"고 안내했지만, 실제로 --force 는 다시 받지 않았다,
# 안내와 동작이 어긋남 → 사용자가 안내대로 해도 고칠 수 없었다. "깨진 파일을 자동으로 지우고 다시 설치"로 바꿔, 한 번 다시 실행하면 스스로 복구된다.
doctor() { # doctor <경로> <이름>
  if [ -e "$1" ] && ! verify_bin "$1"; then
    warn "$2 이 손상되었거나 잘렸습니다 (실행되지 않음), 삭제 후 다시 다운로드합니다"
    rm -f "$1"
  fi
}

# ─────────────────────────────────────────────────────────────────────────────
head_ "레드팀 모드 환경 점검 $(date '+%F %T')"
say "DSH_HOME = $DSH_HOME"
say "도구함   = $TK"

# ═══ ① 도구 설치 ════════════════════════════════════════════════════════════
head_ "① 도구 설치 (없는 것만 받는다)"

# --- PATH 에 이미 있는 시스템 도구 (Kali 기본 제공, 점검만) ---
PATHD="nmap masscan nuclei sqlmap ffuf feroxbuster gobuster hydra john hashcat wpscan nikto whatweb amass theHarvester msfconsole searchsploit proxychains4 socat nc tmux"
MISSING_PATH=""
for t in $PATHD; do have "$t" || MISSING_PATH="$MISSING_PATH $t"; done
if [ -n "$MISSING_PATH" ]; then
  warn "PATH 누락: $MISSING_PATH"
  dim "이것들은 대부분 Kali 기본 패키지입니다, apt 로 보충하세요: sudo apt install -y$MISSING_PATH"
else
  ok "PATH 시스템 도구 모두 있음 (nmap/masscan/nuclei/sqlmap/ffuf/feroxbuster/gobuster/hydra/hashcat/john/wpscan/nikto/whatweb/msfconsole…)"
fi

# --- 도구함 바이너리 (동봉/다운로드) ---
declare -A BIN=(
  [fscan]="$TK/fscan/fscan"
  [gogo]="$TK/gogo/gogo"
  [suo5]="$TK/suo5/suo5-linux-amd64"
  [chisel]="$TK/chisel/chisel"
  [frpc]="$TK/frp/frpc"
  [frps]="$TK/frp/frps"
  [subfinder]="$TK/subfinder/subfinder"
  [dnsx]="$TK/dnsx/dnsx"
  [naabu]="$TK/naabu/naabu"
  [httpx]="$TK/httpx/httpx"
  [ksubdomain]="$TK/ksubdomain/ksubdomain"
  [ligolo-proxy]="$TK/ligolo/proxy"
  [ligolo-agent]="$TK/ligolo/agent"
  [gowitness]="$TK/gowitness/gowitness"
)

if [ "$CHECK_ONLY" != 1 ]; then
  # fscan / gogo (내부 네트워크 침투 주력, 중국산 도구, GitHub release 사용)
  doctor "${BIN[fscan]}" fscan
  [ -x "${BIN[fscan]}" ] || { mkdir -p "$TK/fscan"; dl_asset "shadow1ng/fscan" "fscan_linux_amd64|linux_amd64.*\.(zip|tar\.gz)$" "$TK/fscan/fscan.zip" 0; }
  [ -x "${BIN[gogo]}" ] || dim "gogo 는 https://github.com/chainreactors/gogo/releases 에서 직접 받아야 한다 (표준 명명 자산 없음)"

  # suo5 (WebShell 터널 핵심)
  doctor "${BIN[suo5]}" suo5
  [ -x "${BIN[suo5]}" ] || { mkdir -p "$TK/suo5"; dl_asset "zema1/suo5" "suo5-linux-amd64" "${BIN[suo5]}"; }

  # chisel
  doctor "${BIN[chisel]}" chisel
  if [ ! -x "${BIN[chisel]}" ]; then
    mkdir -p "$TK/chisel"
    dl_asset "jpillora/chisel" "chisel_.*linux_amd64\.gz$" "$TK/chisel/chisel.gz" 0 && gunzip -f "$TK/chisel/chisel.gz" && mv -f "$TK/chisel/chisel" "${BIN[chisel]}" && chmod +x "${BIN[chisel]}"
  fi

  # frp (frpc + frps, 같은 release 패키지 안에)
  doctor "${BIN[frpc]}" frpc; doctor "${BIN[frps]}" frps
  if [ ! -x "${BIN[frpc]}" ] || [ ! -x "${BIN[frps]}" ]; then
    mkdir -p "$TK/frp"
    dl_asset "fatedier/frp" "linux_amd64\.tar\.gz$" "$TK/frp/frp.tar.gz" 0 \
      && untar_all "$TK/frp/frp.tar.gz" "$TK/frp" frpc frps
  fi

  # ProjectDiscovery 세 가지
  doctor "${BIN[subfinder]}" subfinder
  [ -x "${BIN[subfinder]}" ] || { mkdir -p "$TK/subfinder"; dl_asset "projectdiscovery/subfinder" "linux_amd64\.zip$" "$TK/subfinder/s.zip" 0 && python3 -c "import zipfile;zipfile.ZipFile('$TK/subfinder/s.zip').extractall('$TK/subfinder')" && chmod +x "${BIN[subfinder]}"; }
  doctor "${BIN[dnsx]}" dnsx
  [ -x "${BIN[dnsx]}" ]      || { mkdir -p "$TK/dnsx";      dl_asset "projectdiscovery/dnsx"      "linux_amd64\.zip$" "$TK/dnsx/d.zip" 0      && python3 -c "import zipfile;zipfile.ZipFile('$TK/dnsx/d.zip').extractall('$TK/dnsx')"           && chmod +x "${BIN[dnsx]}"; }
  doctor "${BIN[naabu]}" naabu
  [ -x "${BIN[naabu]}" ]     || { mkdir -p "$TK/naabu";     dl_asset "projectdiscovery/naabu"     "linux_amd64\.zip$" "$TK/naabu/n.zip" 0     && python3 -c "import zipfile;zipfile.ZipFile('$TK/naabu/n.zip').extractall('$TK/naabu')"         && chmod +x "${BIN[naabu]}"; }
  doctor "${BIN[httpx]}" httpx
  [ -x "${BIN[httpx]}" ]     || { mkdir -p "$TK/httpx";     dl_asset "projectdiscovery/httpx"     "linux_amd64\.zip$" "$TK/httpx/h.zip" 0     && python3 -c "import zipfile;zipfile.ZipFile('$TK/httpx/h.zip').extractall('$TK/httpx')"         && chmod +x "${BIN[httpx]}"; }
  if [ -x "${BIN[httpx]}" ]; then
    mkdir -p "$HOME/.local/bin"
    printf '#!/usr/bin/env bash\nexec "%s" "$@"\n' "${BIN[httpx]}" > "$HOME/.local/bin/pd-httpx"
    chmod +x "$HOME/.local/bin/pd-httpx"
    ok "pd-httpx wrapper -> ${BIN[httpx]}"
  fi

  # ksubdomain (무상태 서브도메인 브루트포스)
  doctor "${BIN[ksubdomain]}" ksubdomain
  [ -x "${BIN[ksubdomain]}" ] || { mkdir -p "$TK/ksubdomain"; dl_asset "knownsec/ksubdomain" "linux.*\.zip$" "$TK/ksubdomain/k.zip" 0 && python3 -c "import zipfile;zipfile.ZipFile('$TK/ksubdomain/k.zip').extractall('$TK/ksubdomain')" && chmod +x "${BIN[ksubdomain]}"; }

  # ligolo-ng (TUN 터널 대안)
  doctor "${BIN[ligolo-proxy]}" ligolo-proxy; doctor "${BIN[ligolo-agent]}" ligolo-agent
  if [ ! -x "${BIN[ligolo-proxy]}" ] || [ ! -x "${BIN[ligolo-agent]}" ]; then
    mkdir -p "$TK/ligolo"
    dl_asset "nicocha30/ligolo-ng" "proxy_.*linux_amd64\.tar\.gz$" "$TK/ligolo/proxy.tar.gz" 0 \
      && untar_all "$TK/ligolo/proxy.tar.gz" "$TK/ligolo" proxy
    dl_asset "nicocha30/ligolo-ng" "agent_.*linux_amd64\.tar\.gz$" "$TK/ligolo/agent.tar.gz" 0 \
      && untar_all "$TK/ligolo/agent.tar.gz" "$TK/ligolo" agent
  fi

  # gowitness (대량 스크린숏 증거 보존)
  doctor "${BIN[gowitness]}" gowitness
  [ -x "${BIN[gowitness]}" ] || { mkdir -p "$TK/gowitness"; dl_asset "sensepost/gowitness" "gowitness-[0-9.]+-linux-amd64$" "${BIN[gowitness]}"; }

  # OneForAll (서브도메인 수집, 소스 + venv)
  OF_DIR="$TK/oneforall/OneForAll-0.4.5"
  if [ ! -f "$OF_DIR/oneforall.py" ]; then
    mkdir -p "$TK/oneforall"
    dim "OneForAll 소스 다운로드 v0.4.5"
    curl -sL --retry 3 -m 300 "https://github.com/shmilylty/OneForAll/archive/refs/tags/v0.4.5.tar.gz" -o "$TK/oneforall/of.tar.gz" \
      && python3 -c "import tarfile;tarfile.open('$TK/oneforall/of.tar.gz').extractall('$TK/oneforall')" 2>/dev/null \
      && ok "OneForAll 소스 준비 완료" || bad "OneForAll 소스 다운로드 실패"
  else
    ok "OneForAll 소스 이미 존재"
  fi
  # venv 의존성 (첫 실행 약 1-2 분)
  if [ -f "$OF_DIR/oneforall.py" ] && [ ! -x "$OF_DIR/.venv/bin/python" ]; then
    dim "OneForAll 용 venv 를 만들고 의존성 설치 (약 1-2 분)"
    ( cd "$OF_DIR" && python3 -m venv .venv >/dev/null 2>&1 \
      && .venv/bin/python -m pip install -q --no-cache-dir --upgrade pip setuptools wheel >/dev/null 2>&1 \
      && .venv/bin/python -m pip install -q --no-cache-dir requests exrex fire beautifulsoup4 dnspython loguru tqdm PySocks tenacity termcolor treelib colorama future "SQLAlchemy<2" >/dev/null 2>&1 ) \
      && ok "OneForAll 의존성 준비 완료" || warn "OneForAll 의존성 설치 실패 (서브도메인 수집은 subfinder + ksubdomain 으로 대체)"
  elif [ -x "$OF_DIR/.venv/bin/python" ]; then
    ok "OneForAll venv 이미 존재"
  fi
else
  dim "--check 모드: 설치 건너뜀"
fi

# ═══ ② nuclei 템플릿 ═════════════════════════════════════════════════════════
head_ "② nuclei 템플릿 라이브러리"
NT="$HOME/.local/nuclei-templates"
if [ -d "$NT" ]; then
  NTC="$(find "$NT" -name '*.yaml' 2>/dev/null | wc -l | tr -d ' ')"
  ok "템플릿 라이브러리 준비 완료: $NT ($NTC 개 템플릿)"
  [ "$NTC" -lt 1000 ] && warn "템플릿 수가 적습니다, 한 번 실행하세요: nuclei -update-templates"
elif have nuclei; then
  if [ "$CHECK_ONLY" != 1 ]; then
    dim "템플릿 라이브러리 최초 업데이트 (약 100MB, 1-3 분)"
    nuclei -update-templates >/dev/null 2>&1 && ok "템플릿 라이브러리 설치 완료 ($NT)" || bad "템플릿 업데이트 실패, 나중에 직접 실행하세요: nuclei -update-templates"
  else
    warn "템플릿 라이브러리 없음 (nuclei -update-templates 실행)"
  fi
else
  warn "nuclei 미설치, 건너뜀"
fi

# ═══ ③ 설정: FOFA_KEY 와 VPS ══════════════════════════════════════════════
head_ "③ 설정 (FOFA 측량 key + VPS 로그인 방식)"

# 기존 값 (환경 변수 우선, 그다음 .env 파일)
cur_env() { # cur_env <NAME> → 현재 적용되는 값 출력 (변수가 설정되지 않아도 오류 없음)
  local n="$1" v=""
  v="${!n-}"                                   # 반드시 - 를 붙인다: set -u 아래에서 미정의 변수는 즉시 중단된다
  [ -n "$v" ] && { printf '%s' "$v"; return; }
  [ -f "$ENV_FILE" ] && grep -E "^${n}=" "$ENV_FILE" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '"'
}
env_set() { # env_set <NAME> <VALUE> → $DSH_HOME/.env 쓰기/갱신, 권한 600
  local n="$1" v="$2"
  mkdir -p "$(dirname "$ENV_FILE")"; touch "$ENV_FILE"; chmod 600 "$ENV_FILE"
  if grep -qE "^${n}=" "$ENV_FILE" 2>/dev/null; then
    python3 - "$ENV_FILE" "$n" "$v" <<'PY'
import sys
path, name, value = sys.argv[1], sys.argv[2], sys.argv[3]
lines = open(path, encoding='utf-8').read().splitlines()
out, done = [], False
for line in lines:
    if line.startswith(name + '='):
        out.append(f'{name}={value}'); done = True
    else:
        out.append(line)
if not done: out.append(f'{name}={value}')
open(path, 'w', encoding='utf-8').write('\n'.join(out) + '\n')
PY
  else
    printf '%s=%s\n' "$n" "$v" >> "$ENV_FILE"
  fi
}

# --- FOFA_KEY ---
FOFA_NOW="$(cur_env FOFA_KEY)"
if [ -n "$FOFA_NOW" ]; then
  ok "FOFA_KEY 설정됨 (${FOFA_NOW:0:4}…${FOFA_NOW: -4}, 길이 ${#FOFA_NOW})"
  dim "출처: $([ -n "${FOFA_KEY:-}" ] && echo '환경 변수' || echo "$ENV_FILE")"
  if [ "$CHECK_ONLY" != 1 ] && [ "$ASSUME_YES" != 1 ]; then
    NEW="$(ask_secret 'FOFA_KEY 갱신 (엔터만 누르면 기존 값 유지)')"
    [ -n "$NEW" ] && env_set FOFA_KEY "$NEW" && ok "FOFA_KEY 갱신됨"
  fi
else
  warn "FOFA_KEY 미설정 —— 자산 측량 (fofa-recon 스킬) 이 저하된다"
  dim "발급: https://fofa.info 로그인 → 개인 센터 → API Key (개인판 10,000 회/월, 1 초 1 회)"
  dim "저하 대체: crt.sh 인증서 투명성 + subfinder/ksubdomain + 패시브 DNS (스킬 passive-recon / recon-pipeline)"
  if [ "$CHECK_ONLY" != 1 ]; then
    NEW="$(ask_secret 'FOFA_KEY 붙여넣기 (비우면 건너뛰고, 나중에 setup.sh 로 다시 설정 가능)')"
    if [ -n "$NEW" ]; then
      env_set FOFA_KEY "$NEW"; ok "FOFA_KEY 를 $ENV_FILE 에 기록했습니다 (dsh web 재시작 후 적용)"
      # 즉시 유효성 검증 한 번
      RESP="$(curl -s -m 20 "https://fofa.info/api/v1/info/my?key=$NEW" 2>/dev/null)"
      if printf '%s' "$RESP" | grep -q '"error":false'; then
        ok "FOFA_KEY 검증 통과"
      else
        warn "FOFA_KEY 검증 실패: $(printf '%s' "$RESP" | head -c 120)"
      fi
    else
      warn "FOFA_KEY 건너뜀 (측량 능력 저하, 언제든 이 스크립트를 다시 실행해 보충 가능)"
    fi
  fi
fi

# --- VPS (리버스 Shell 착지와 중계) ---
VPS_KEY_NOW="$(cur_env REDTEAM_VPS_KEY)";   VPS_KEY_NOW="${VPS_KEY_NOW:-$TK/vps/id_rsa}"
VPS_HOST_NOW="$(cur_env REDTEAM_VPS_HOST)"
VPS_USER_NOW="$(cur_env REDTEAM_VPS_USER)"; VPS_USER_NOW="${VPS_USER_NOW:-ubuntu}"
say ""
if [ -f "$VPS_KEY_NOW" ]; then
  # 호스트 주소가 설정되지 않았을 때 (개인 키만 있고 user@host 가 없음), 스킬 안의 $REDTEAM_VPS_HOST 는 빈 값으로 해석된다
  # —— 반드시 여기서 다시 물어야 한다, 그렇지 않으면 "설정된 것처럼 보이지만" 명령이 돌지 않는다.
  if [ -z "$VPS_HOST_NOW" ]; then
    warn "개인 키는 있는데 VPS 주소가 없음 (REDTEAM_VPS_HOST 미설정) —— 스킬 안의 \$REDTEAM_VPS_HOST 는 빈 값이 된다"
    if [ "$CHECK_ONLY" != 1 ]; then
      ANS="$(ask 'VPS 호스트 주소 (IP 또는 도메인만 입력, 사용자 이름 기본값 '"$VPS_USER_NOW"')' '')"
      if [ -n "$ANS" ]; then
        env_set REDTEAM_VPS_HOST "$ANS"; env_set REDTEAM_VPS_USER "$VPS_USER_NOW"
        VPS_HOST_NOW="$ANS"; ok "VPS 주소를 $ENV_FILE 에 기록했습니다: $VPS_USER_NOW@$VPS_HOST_NOW"
      else
        warn "건너뜀 —— 리버스 Shell / 페이로드 전달 계열 스킬은 사용 불가로 표시된다"
      fi
    fi
  fi
fi
if [ -f "$VPS_KEY_NOW" ] && [ -n "$VPS_HOST_NOW" ]; then
  ok "VPS 로그인 방식 준비 완료: $VPS_USER_NOW@$VPS_HOST_NOW (개인 키 $VPS_KEY_NOW)"
  if ssh -i "$VPS_KEY_NOW" -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=8 "$VPS_USER_NOW@$VPS_HOST_NOW" 'echo ok' >/dev/null 2>&1; then
    ok "VPS SSH 연결 정상"
  else
    warn "VPS SSH 연결 불가 —— 리버스 Shell 과 페이로드 전달이 실패한다"
    dim "점검: 개인 키 권한 (chmod 600), 보안 그룹 22 포트, 사용자 이름이 맞는지"
  fi
elif [ ! -f "$VPS_KEY_NOW" ]; then
  warn "VPS 개인 키를 찾지 못함 ($VPS_KEY_NOW) —— 리버스 Shell 착지 능력 사용 불가"
  dim "공인 IP VPS 가 필요하다 (리버스 Shell 수신, 페이로드 중계, 터널 출구 역할)"
  if [ "$CHECK_ONLY" != 1 ]; then
    NEW_HOST="$(ask 'VPS 로그인 주소 (user@ip)' 'ubuntu@')"
    NEW_KEY="$(ask 'VPS 개인 키 경로' "$TK/vps/id_rsa")"
    if [ -n "$NEW_HOST" ] && [ -f "$NEW_KEY" ]; then
      env_set REDTEAM_VPS_HOST "$NEW_HOST"; env_set REDTEAM_VPS_KEY "$NEW_KEY"
      ok "VPS 로그인 방식 기록됨 ($NEW_HOST)"
      dim "개인 키를 $NEW_KEY 에 두고 chmod 600; 또는 우리에게 알려주면 직접 구성한다"
    else
      warn "VPS 설정 건너뜀 (VPS 가 없으면 착지가 필요 없는 성과만 가능: 계정, 데이터, 미승인 접근)"
    fi
  fi
else
  warn "개인 키는 있는데 VPS 주소가 여전히 비어 있음 (REDTEAM_VPS_HOST 미설정) —— 리버스 Shell / 페이로드 전달 계열 스킬은 사용 불가로 판정된다"
  dim "보충 설정: $ENV_FILE 에 REDTEAM_VPS_HOST=<IP 또는 도메인> 과 REDTEAM_VPS_USER=<로그인 사용자> 를 적는다"
fi

# 환경 변수 적용 안내
if [ ! -f "$ENV_FILE" ] || ! grep -q 'FOFA_KEY' "$ENV_FILE" 2>/dev/null; then
  dim "안내: $ENV_FILE 은 dsh web 시작 시 로드된다; 수정 후 dsh web 을 재시작해야 이 프로세스에 적용된다"
fi

# ═══ ④ 점검표 ══════════════════════════════════════════════════════════════
head_ "④ 점검 (바이너리 실행 가능성)"
FAILED=""; WEAK=""
for name in "${!BIN[@]}"; do
  p="${BIN[$name]}"
  if [ ! -x "$p" ]; then bad "$name 누락 ($p)"; FAILED="$FAILED $name"; continue; fi
  # 실행 권한만으로는 통과가 아니다: --version/-version/-h 를 실제로 한 번 실행해 "잘린 바이너리"가 섞여 지나가지 않게 한다
  if timeout 15 "$p" --version >/dev/null 2>&1 || timeout 15 "$p" -version >/dev/null 2>&1 \
     || timeout 15 "$p" -h >/dev/null 2>&1 || timeout 15 "$p" --help >/dev/null 2>&1 \
     || timeout 15 "$p" version >/dev/null 2>&1; then
    ok "$name ($(stat -c%s "$p") 바이트, 스모크 통과)"
  else
    warn "$name 은 있으나 무응답 (잘림/의존성 누락 가능) —— --force 를 붙여 이 스크립트를 다시 실행해 재다운로드"
    WEAK="$WEAK $name"
  fi
done
[ -f "$TK/oneforall/OneForAll-0.4.5/oneforall.py" ] && ok "oneforall (소스)" || warn "oneforall (미설치, subfinder+ksubdomain 으로 대체 가능)"
[ -d "$TK/Behinder" ] && ok "Behinder (WebShell 전달)" || warn "Behinder 준비 안 됨"
[ -d "$TK/Godzilla" ] && ok "Godzilla (WebShell 전달)" || warn "Godzilla 준비 안 됨"
[ -d "$TK/AntSword" ] && ok "AntSword" || dim "AntSword 준비 안 됨 (선택)"

# ═══ ⑤ 완료 표시 ════════════════════════════════════════════════════════════
head_ "요약"
if [ -n "$FAILED" ]; then
  warn "다음 도구가 누락되어 관련 스킬이 저하된다: $FAILED"
elif [ -n "$WEAK" ]; then
  warn "다음 도구는 있으나 스모크를 통과하지 못했다 (--force 를 붙여 이 스크립트 재실행): $WEAK"
else
  ok "도구함 완전함 (모든 바이너리 스모크 통과)"
fi

if [ "$CHECK_ONLY" != 1 ]; then
  {
    echo "# 레드팀 모드 환경 완료 표시 —— setup.sh 가 기록"
    echo "completed_at=$(date -Iseconds)"
    echo "dsh_home=$DSH_HOME"
    echo "toolkit=$TK"
    echo "missing_tools=${FAILED:-none}"
    echo "fofa_key=$([ -n "$(cur_env FOFA_KEY)" ] && echo configured || echo missing)"
    echo "vps=$([ -f "$VPS_KEY_NOW" ] && echo configured || echo missing)"
  } > "$MARKER"
  ok "완료 표시 기록됨: $MARKER"
  dim "에이전트가 preflight 에서 이것을 읽어 환경이 준비되었는지 확인한다"
fi

say ""
say "다음 단계:"
say "  1) 방금 $ENV_FILE (FOFA_KEY / VPS) 을 수정했다면, dsh web 를 재시작해 이 프로세스가 새 값을 읽게 한다"
say "  2) 레드팀 모드로 들어가면, 지휘 에이전트의 첫 동작이 redteam_preflight 를 실행해 재확인한다"
say "  3) 대상 기관 이름을 주고 바로 착수한다"
say ""
say "로그: $LOG"
exit 0
