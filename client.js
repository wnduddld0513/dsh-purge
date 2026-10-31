window.__ModuleLoader__.load({ id: "dsh-purge", factory: (require) => {

		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		const h = react.createElement;
		const { useState, useEffect, useCallback, useRef, Component } = react;

		const name = "dsh-purge";
		const inject = ["slots", "locale", "uiConversation"];
		const NS = "settings.dsh-purge";
		let translate = (key) => key;
		function useT() {
			return translate;
		}
		function clientGuessSurface() {
			try {
				if (typeof navigator !== "undefined" && /electron/i.test(navigator.userAgent || "")) return "desktop";
				if (typeof location !== "undefined") {
					const port = String(location.port || "");
					if (port === "43120") return "desktop";
					const host = String(location.hostname || "");
					if (host && host !== "127.0.0.1" && host !== "localhost" && /dsh desktop/i.test(String(location.href || ""))) return "desktop";
				}
			} catch { /* ignore */ }
			return "";
		}
		function hostSurfaceOf(s) {
			return (s && s.surface) || clientGuessSurface() || "web";
		}
		function hostText(t, key, surface) {
			if (surface && surface !== "web") {
				const specific = key + "." + surface;
				const hit = t(specific);
				if (hit && hit !== specific) return hit;
			}
			return t(key);
		}
		function apiUrl(p) {
			try { return new URL(p, window.location.origin).toString(); } catch { return p; }
		}
		function apiTimeoutMs(p, init) {
			const path = String(p || "");
			const method = String((init && init.method) || "GET").toUpperCase();
			if (path.indexOf("/dsh-purge/update") !== -1) return method === "POST" ? 180000 : 45000;
			if (path.indexOf("/dsh-purge/uninstall") !== -1) return 90000;
			if (path.indexOf("/dsh-purge/skill") !== -1) return method === "POST" ? 120000 : 20000;
			// status는 "적용" 중에 백엔드의 동기 디스크 쓰기에 막혀, 기본 20s면 반드시 abort되고 화면에는 "읽기 실패: timeout"만 표시된다.
			if (path.indexOf("/dsh-purge/status") !== -1) return 60000;
			if (path.indexOf("/dsh-purge/apply") !== -1) return 240000;
			if (path.indexOf("/dsh-purge/revert") !== -1) return 120000;
			if (path.indexOf("/dsh-purge/restart") !== -1) return 60000;
			return 20000;
		}
		function isAbortError(e) {
			const msg = String((e && e.message) || e || "");
			return (e && e.name === "AbortError") || /aborted|abort/i.test(msg);
		}
		async function apiJson(p, init) {
			const ctrl = new AbortController();
			const timer = setTimeout(() => ctrl.abort(), apiTimeoutMs(p, init));
			try {
				const r = await fetch(apiUrl(p), Object.assign({ cache: "no-store", credentials: "same-origin", signal: ctrl.signal }, init || {}));
				const text = await r.text();
				let data;
				try { data = text ? JSON.parse(text) : null; } catch {
					throw new Error(r.status + " non-json: " + text.slice(0, 120));
				}
				if (!r.ok) throw new Error((data && (data.error || data.message)) || (r.status + " " + r.statusText));
				return data;
			} catch (e) {
				if (isAbortError(e)) throw new Error("timeout");
				const msg = String((e && e.message) || e || "");
				if (/failed to fetch|networkerror|load failed/i.test(msg)) {
					throw new Error("Cannot reach the API. Make sure dsh is still running, then press Ctrl+F5");
				}
				throw e;
			} finally { clearTimeout(timer); }
		}

		function promptBoxEmpty(text) {
			return !String(text || "").trim();
		}

		function responseNeedsPrompt(d) {
			return Boolean(d && (d.needPrompt || d.injectSource === "none"));
		}

		function warnNeedPrompt(d, tr) {
			if (!responseNeedsPrompt(d)) return false;
			window.alert(tr("need.prompt"));
			return true;
		}

		async function bothInjectEmpty(overrideText, defaultText) {
			if (!promptBoxEmpty(overrideText)) return false;
			if (!promptBoxEmpty(defaultText)) return false;
			return true;
		}

		function rulesApi(op, extra) {
			return apiJson("/dsh-purge/rules", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(Object.assign({ op: op }, extra || {})),
			});
		}

		function skillsRouteMissing(e) {
			return /\b404\b|\b405\b|non-json/i.test(String((e && e.message) || e || ""));
		}

		function skillsApi(op, extra) {
			const init = {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(Object.assign({ op: op }, extra || {})),
			};
			return apiJson("/dsh-purge/skills", init).catch((e) => {
				if (!skillsRouteMissing(e)) throw e;
				return apiJson("/dsh-purge/skill", init);
			});
		}

		const TARGETS = ["AGENTS.md", "CLAUDE.md"];

		const ko = {
			nav: "규칙 설정",
			"dock.clean": "정리",
			"dock.drill": "드릴 콘솔",
			"dock.toggle": "dsh-purge",
			"dock.newSession": "dsh-purge",
			"dock.inSession": "dsh-purge",
			"dock.redteam": "레드팀 모드",
			"dock.full": "전체 보기",
			"dock.close": "접기",
			"dock.unauthorized": "미승인",
			"welcome.title": "사용자 안내",
			"welcome.lead": "이 플러그인을 처음 설치할 때 아래 안내를 읽어 주세요. 확인하면 이 창은 다시 뜨지 않습니다.",
			"welcome.warn": "이 플러그인은 무료 오픈소스입니다. 작성자 몰래 판매하거나 유료로 되팔거나 이 프로젝트로 이익을 얻는 행위에 대해 작성자는 법적 책임을 물을 것입니다.",
			"welcome.body": "dsh-purge 는 DeepSeek Harness 의 로컬 네트워크 보안 레드팀 평가·정리 플러그인입니다: 통제된 로컬 환경에서 프롬프트와 패치를 조정하고, 승인된 범위 안에서 드릴 콘솔 작업을 합니다. 무료·비영리 프로젝트이며 소스 저장소는:",
			"welcome.repo": "https://github.com/YuJunZhiXue/dsh-purge",
			"welcome.ban1": "이 프로젝트를 미승인 네트워크 공격, 침입, 데이터 탈취, 시스템 파괴 또는 모든 위법 행위에 사용하는 것을 금합니다.",
			"welcome.ban2": "상업적 판매, 유료 되팔이, 불법·회색 시장 이익, 작성자를 숨긴 영리 재배포를 금합니다.",
			"welcome.ban3": "사용자는 거주지의 법규와 플랫폼 규정을 스스로 준수해야 합니다. 위법의 결과는 행위자가 직접 부담하며 작성자와는 무관합니다.",
			"welcome.bans": "금지 사항",
			"welcome.check": "위 사용자 안내를 읽고 이해했으며, 합법·규정 준수 사용에 동의합니다.",
			"welcome.ok": "알겠습니다, 계속",
			"auth.title": "드릴 콘솔 승인 확인",
			"auth.lead": "정리에는 이 단계가 필요하지 않습니다. 드릴 콘솔에 처음 들어가거나 전체 보기를 열 때는 이 창을 먼저 완료해야 합니다.",
			"auth.warn": "보안 경고: 드릴 콘솔은 본인이 관리할 권한이 있는 로컬 머신, 오프라인 타깃 또는 서면으로 승인된 드릴 환경에만 사용합니다. 미승인 침투·공격·탈취·파괴는 일절 금지됩니다.",
			"auth.hint.wait": "선언문을 읽어 주세요. {n}초 후에 선택할 수 있습니다.",
			"auth.hint.scroll": "카운트다운이 끝났습니다. 선언문을 맨 아래까지 스크롤한 뒤 선택하세요.",
			"auth.hint.check": "카운트다운이 끝났습니다. 세 항목을 모두 선택하세요.",
			"auth.check.read": "「안전 및 위법 금지 선언」을 모두 읽었고 그 모든 조항에 동의합니다.",
			"auth.check.scope": "승인된 로컬 환경, 오프라인 타깃 또는 규정을 준수한 드릴에서만 사용함을 확인합니다.",
			"auth.check.ban": "어떤 위법 용도도 금지됨을 확인합니다. 이 승인을 완료하지 않으면 드릴 콘솔을 사용할 수 없습니다.",
			"auth.no": "나중에",
			"auth.ok": "승인 확인",
			"auth.ok.tab": "승인하고 드릴 콘솔 열기",
			"auth.ok.full": "승인하고 전체 보기 열기",
			"auth.ok.env": "승인하고 환경 적응 열기",
			"envGate.title": "환경이 아직 준비되지 않았습니다",
			"envGate.lead": "레드팀 모드는 전송 전에 로컬 도구가 필요합니다. 사용 가능한 환경이 없으면 먼저 환경 적응으로 가거나, 지금은 설정하지 않음을 확인하세요.",
			"envGate.kaliHint": "Kali 가 감지되면 로컬 도구를 그대로 사용하며 경로를 입력할 필요가 없습니다. Kali 가 없으면 환경 적응에서 각 도구 경로를 입력하거나, 패키지 폴더 전체를 선택해 자동 배정하세요.",
			"envGate.skip": "지금은 설정 안 함",
			"envGate.skipConfirm": "확인하면 이번에는 대화를 계속할 수 있습니다. 스캔·익스플로잇 계열 스킬은 도구가 없어 여전히 사용할 수 없으며, 나중에 dsh-purge → 환경 적응 에서 경로를 보완할 수 있습니다.",
			"envGate.skipNo": "돌아가기",
			"envGate.skipYes": "지금은 설정 안 함 확인",
			"envGate.go": "환경 적응으로 가기",
			"theme.aria": "겉모습",
			"theme.white": "화이트",
			"theme.ink": "잉크",
			"purge.title": "패치",
			"override.title": "프롬프트",
			"own.save": "목록 저장",
			"saved.own": "내 서버를 저장했습니다",
			"saved.own.dropped": "저장했습니다. {n} 줄이 단일 IP 나 호스트 이름이 아니어서 버렸습니다",
			"metric.purged": "기록됨",
			"metric.purged.skip": "기록했습니다. {n} 항목을 건너뛰었습니다. 이 머신에 해당 파일이 없습니다",
			"metric.pendingShort": "대기 {n}",
			"metric.unmatchedShort": "불일치 {n}",
			"metric.driftedShort": "드리프트 {n}",
			"metric.skipShort": "건너뜀 {n}",
			"metric.unlocated.count": "—",
			"metric.shim": "shim",
			"metric.shim.na": "이 쪽에서는 필요 없음",
			"metric.bak.yes": "백업 있음",
			"metric.bak.no": "백업 없음",
			"metric.bak.hint": "백업",
			"table.patch": "항목",
			"table.status": "상태",
			"status.applied": "적용됨",
			"status.off": "꺼짐",
			"status.pending": "적용 대기",
			"status.unmatched": "불일치",
			"status.drifted": "드리프트됨",
			"status.skipped": "건너뜀",
			"apply.hint": "프롬프트 상자를 고치지 않았다면 저장을 누를 필요가 없습니다. 기본값이 그대로 쓰이며 시작과 적용 시 prompt-inject.md 에 기록됩니다. 직접 고친 뒤에만 저장을 누르면 덮어씁니다. 적용을 누르면 패치합니다. 대기=원문이 아직 남아 있음. 건너뜀=현재 버전에 필요 없거나 구성 요소가 설치되지 않음. 드리프트=공식 원문이 바뀌어 이 패치는 적용되지 않았고 pattern 갱신이 필요함.",
			"flow.title": "정리 흐름",
			"flow.apply": "적용",
			"flow.revert": "되돌리기",
			"flow.uninstall": "제거",
			"flow.home": "홈 디렉터리",
			"flow.locate": "호스트",
			"flow.override": "프롬프트",
			"flow.patch": "패치",
			"flow.shim": "런처",
			"flow.flash": "플래시 창",
			"flow.seed": "기록",
			"flow.done": "완료",
			"flow.revert.step": "되돌리기",
			"flow.cleanup": "정리",
			"warn.noRoot": "현재 호스트의 @deepseek-ai 를 찾지 못해 정리가 적용되지 않습니다. 완전히 종료한 뒤 이 호스트를 다시 열고, 이 페이지에서 「적용」을 누르세요. 데스크톱 설치 경로는 어느 드라이브든 될 수 있으며, 폴더 이름에 DeepseekHarness / DeepSeek Harness 가 있으면 됩니다.",
			"warn.noRoot.desktop": "공식 클라이언트의 코드는 app.asar 안에 있습니다. 「적용」을 누르면 풀어서 자동으로 재시작하므로 별도 스크립트를 돌릴 필요가 없습니다. 계속 찾지 못한다면 클라이언트를 완전히 종료했다가 다시 열고 「적용」을 누르세요. 서드파티 DSH Desktop 은 그냥 「적용」을 누르면 됩니다.",
			"unpack.restarting": "패치를 기록했습니다. 「재시작」을 누르면 클라이언트가 스스로 다시 열립니다.",
			"restart.fullQuit": "재시작 중입니다. 클라이언트가 스스로 다시 열립니다.",
			"warn.noInject": "공식은 항상 기본 프롬프트를 사용합니다. 레드팀에서 규칙 세트를 켜면 규칙 세트만 쓰고, 꺼져 있으면 CTF 를 뺀 기본 프롬프트에 레드팀 절차를 이어 붙입니다. 양쪽이 모두 비면 프롬프트를 반드시 추가하라고 안내합니다.",
			"warn.hostVersion": "현재 호스트는 {v} 이고 플러그인이 맞춘 버전은 {t} 입니다. 공식 원문이 맞지 않으면 패치가 「드리프트」로 표시되니, 맞춰진 호스트 버전으로 되돌리는 것을 권합니다.",
			"need.prompt": "프롬프트와 규칙 세트가 모두 비어 있습니다. 프롬프트를 먼저 추가하거나, 내용이 있는 규칙 세트를 켜야 합니다.",
			"btn.restoreInject": "기본값 복원",
			"saved.restoreInject": "기본 프롬프트를 복원했습니다",
			"skip": "건너뜀",
			"unknown": "알 수 없음",
			"delete": "삭제",
			"btn.apply": "적용",
			"btn.apply.busy": "처리 중…",
			"btn.revert": "되돌리기",
			"btn.uninstall": "제거",
			"btn.uninstall.busy": "제거 중…",
			"uninstall.title": "dsh-purge 제거",
			"uninstall.body": "제거할까요? 제거하면 원래대로 되돌리고 이 플러그인의 모든 파일과 패치를 지웁니다.",
			"uninstall.confirm": "제거 확인",
			"uninstall.cancel": "취소",
			"uninstall.applying": "제거하고 되돌리는 중…",
			"uninstall.done": "제거하고 되돌렸습니다. 재시작 중…",
			"uninstall.done.desktop": "제거하고 되돌렸습니다. 데스크톱 앱을 재시작하는 중…",
			"uninstall.fail": "제거 실패: {error}",
			"btn.checkUpdate": "업데이트 확인",
			"btn.checkUpdate.busy": "확인 중…",
			"btn.doUpdate": "업데이트",
			"btn.doUpdate.busy": "업데이트 중…",
			"channel.title": "채널",
			"channel.stable": "정식판",
			"channel.beta": "테스트판",
			"channel.useStable": "정식판으로 전환",
			"channel.useBeta": "테스트판으로 전환",
			"channel.local": "로컬",
			"update.checking": "업데이트를 확인하는 중…",
			"update.applying": "업데이트 중…",
			"update.switching": "버전을 전환하는 중…",
			"update.latest": "이미 최신입니다 ({version})",
			"update.available": "새 버전 {remote} 이(가) 있습니다. 현재 {local}",
			"update.pinned": "{version} 에 고정되어 있고, 채널 최신은 {remote} 입니다",
			"update.done": "{version} 으로 업데이트했습니다",
			"update.restarting": "되돌리고 새 패치를 기록했습니다. 재시작 중…",
			"update.fullQuit": "패치를 기록했습니다. 「재시작」을 누르면 클라이언트가 스스로 다시 열립니다.",
			"restart.official.title": "재시작이 필요합니다",
			"restart.official.body": "패치를 기록했습니다. 재시작을 누르면 클라이언트가 스스로 다시 열립니다.",
			"update.switched": "{version} 으로 전환했습니다",
			"update.autoDone": "{version} 으로 자동 업데이트했습니다",
			"update.reloading": "설정 페이지를 새로 고치는 중…",
			"update.dirty": "새 버전이 있지만 로컬에 수정 사항이 있어 자동으로 덮어쓰지 않았습니다",
			"update.fail": "업데이트 실패: {error}",
			"update.timeout": "확인 시간이 초과되었습니다. 업데이트 확인을 한 번 더 눌러 주세요",
			"update.needRestart": "확인 인터페이스가 로드되지 않았습니다. dsh 를 먼저 재시작한 뒤 업데이트 확인을 누르세요",
			"update.noBeta": "아직 테스트판이 없습니다",
			"update.switch": "이 버전으로 전환",
			"update.pick": "버전 선택",
			"update.tip": "최신",
			"update.current": "현재",
			"update.confirmSwitch": "{version} 으로 전환할까요? 이후 다른 채널이나 다른 버전으로 다시 전환할 수 있습니다. 로컬에 커밋하지 않은 플러그인 수정 사항은 보존되지 않습니다.",
			"update.confirmChannel": "{version} 으로 전환할까요? 해당 채널 기준으로 플러그인을 다시 설치하며, 로컬에 커밋하지 않은 플러그인 수정 사항은 보존되지 않습니다.",
			"metric.version": "버전",
			"action.apply": "적용",
			"action.revert": "되돌리기",
			"action.uninstall": "제거",
			"ok.done": "완료했습니다",
			"err.action": "실패: {error}",
			"err.status": "읽기 실패: {error}",
			"err.override": "읽기 실패: {error}",
			"err.rules": "읽기 실패: {error}",
			"err.read": "읽기 실패: {error}",
			"err.save": "저장 실패: {error}",
			"btn.saveInject": "저장",
			"saved.override": "저장했습니다",
			"rules.title": "규칙 세트",
			"rules.none": "없음",
			"rules.reset": "되돌리기",
			"rules.reset.confirm": "전역 지시 파일을 되돌릴까요? 규칙 라이브러리는 유지됩니다.",
			"rules.empty": "규칙이 없습니다",
			"rules.pick": "규칙 선택",
			"policy.title": "워크스페이스 정책",
			"policy.strict": "엄격",
			"policy.fallback": "빈칸 대체",
			"policy.always": "항상 허용",
			"policy.hint": "엄격: 항상 AGENTS.md / CLAUDE.md 를 제거; 빈칸 대체: 프롬프트 상자가 비었을 때만 사용; 항상 허용: DSH 기본 동작 유지",
			"cwd.title": "로컬 규칙 (현재 디렉터리)",
			"cwd.empty": "현재 디렉터리에 AGENTS.md / CLAUDE.md 가 없습니다",
			"cwd.rescan": "다시 스캔",
			"cwd.hint": "프롬프트 상자가 비어 있을 때만 선택한 로컬 파일이 대체용으로 주입됩니다. 프롬프트 상자가 비어 있지 않으면 이 파일들은 사용되지 않습니다.",
			"cwd.scope.cwd": "현재 디렉터리",
			"cwd.scope.ancestor": "상위",
			"cwd.scope.root": "프로젝트 루트",
			"cwd.no.workspace": "DSH 에서 아직 작업 디렉터리를 고른 적이 없습니다. DSH 에서 작업을 한 번 시작한 뒤 다시 돌아오세요.",
			"pill.current": "현재",
			"btn.use": "사용",
			"btn.inUse": "현재",
			"confirm.delete": "{id} 을(를) 삭제할까요?",
			"ph.id": "id",
			"ph.alias": "이름",
			"ph.alias.short": "이름",
			"btn.create": "새로 만들기",
			"need.id": "id가 필요합니다",
			"ph.content": "",
			"btn.saveRule": "저장",
			"skills.title": "Skill",
			"skills.hint": "공식 디렉터리로 가져오면 DSH가 호출합니다: 채팅에서 /이름을 입력하면 즉시 로드되고, 작업이 description 또는 whenToUse와 맞으면 모델이 skill 도구를 호출합니다. 본문에 '활성화'라고 써도 트리거되지 않습니다.",
			"skills.hint.desktop": "현재 데스크톱 호스트의 공식 Skill 디렉터리입니다. 채팅에서 /이름을 입력하면 즉시 로드되고, 작업이 description과 맞으면 모델이 skill 도구를 호출합니다.",
			"skills.empty": "사용자 Skill 없음",
			"btn.importZip": "압축 파일 가져오기",
			"btn.importFolder": "폴더 가져오기",
			"skills.importing": "가져오는 중…",
			"saved.import": "Skill {count}개를 가져왔습니다",
			"need.import": "압축 파일이나 폴더를 선택하세요",
			"err.import.folder": "폴더 안의 파일을 읽지 못했습니다. SKILL.md가 들어 있는 Skill 디렉터리를 직접 선택하세요",
			"skills.pick": "Skill 선택",
			"skills.invalid": "공식에서 무시됨: 형식이 올바르지 않음",
			"skills.call.slash": "채팅에서 {cmd} 입력",
			"skills.call.model": "모델 호출 가능",
			"skills.call.modelOff": "모델 호출 불가",
			"skills.call.userOff": "/이름 사용 불가",
			"ph.skill.desc": "description(사용 시점)",
			"btn.saveSkill": "저장",
			"need.skill.id": "id는 kebab-case여야 합니다, 예: code-review",
			"confirm.delete.skill": "공식 $DSH_HOME/skills에서 {id}을(를) 삭제할까요? 호스트가 디렉터리에서 자동으로 치웁니다.",
			"err.skills": "읽기 실패: {error}",
			"err.skills.needRestart": "Skill 인터페이스가 로드되지 않았습니다. 현재 호스트를 먼저 재시작하세요",
			"btn.restart": "재시작",
			"btn.restart.busy": "재시작 중…",
			"restarting": "재시작 중…",
			"restarting.desktop": "데스크톱 앱을 재시작하는 중…",
			"restart.timeout": "시간 초과, 새로고침하세요",
			"restart.fail": "실패: {error}",
			"restart.notStarted": "재시작이 시작되지 않았고 클라이언트는 그대로입니다. 자동으로 다시 시도하지 않습니다.",
			"restart.already": "이번 재시작은 이미 시작되었으며 다시 재시작하지 않습니다.",
			"restart.confirm": "정리가 완료되었으며 재시작 후 적용됩니다.",
			"restart.confirm.desktop": "정리가 완료되었으며 데스크톱 앱을 재시작한 뒤 적용됩니다.",
			"restart.ask.title": "지금 재시작할까요",
			"restart.ask.body": "이미 기록했습니다. 재시작해야 현재 클라이언트에 적용됩니다.",
			"restart.now": "지금 재시작",
			"restart.notNow": "나중에",
			"restart.asarSwap": "패치를 디스크에 기록했습니다. 데스크톱 프로세스를 끝내고 app.asar를 옆으로 옮기는 중이며, 완료되면 자동으로 다시 열립니다; 그래도 적용되지 않으면 Harness를 완전히 종료하고(트레이도 닫기) 적용을 다시 누르세요.",
			"surface.web": "Web",
			"surface.desktop": "데스크톱",
			"surface.gui": "GUI",
			"surface.tui": "TUI",
			"restart.incomplete": "프롬프트를 기록했습니다. {detail}",
			"restart.incomplete.patches": "코드 패치 {failed}건이 현재 버전과 맞지 않습니다 (#{ids}), 이 프롬프트에는 영향이 없습니다",
			"restart.incomplete.flash": "CMD 무감지로 고정되지 않음 ({entry})",
			"restart.later": "나중에",
			"group.prompt": "프롬프트",
			"group.code": "코드",
			"group.engine": "엔진",
			"group.tools": "도구",
			"group.compat": "0.1.5 호환",
			"group.dsh20": "0.2.0",
			"patch.1": "전역 면책 → 강한 지시",
			"patch.2": "치환식 면책 → 강한 지시",
			"patch.3": "스코프 면책 → 강한 지시",
			"patch.4": "persona 세션 강한 지시",
			"patch.5": "승인 안내 문장 → 전체 권한",
			"patch.6": "샌드박스 deny → allow 쓰기",
			"patch.7": "샌드박스 기본 전체 권한",
			"patch.8": "승인 기본 never",
			"patch.9": "승인 게이트 자동 통과",
			"patch.10": "승인 설정 기본 never",
			"patch.11": "never 안내 문장 → 자동 통과",
			"patch.12": "ask 안내 문장 → 자동 통과",
			"patch.13": "면제 상승 사다리",
			"patch.14": "상승 무조건 신뢰",
			"patch.15": "샌드박스 confine 직통",
			"patch.16": "파일 시스템 울타리 해제",
			"patch.17": "관찰 정책 읽기/쓰기 허용",
			"patch.18": "반복 호출 가드 비활성화",
			"patch.19": "도구 결과 다듬기 비활성화",
			"patch.21": "플러그인이 늘린 bash 대기 복원",
			"patch.22": "read 상한 완화",
			"patch.23": "서브에이전트 깊이 3 → 10",
			"patch.24": "preset fetch 활성화",
			"patch.25": "공식 기본 정체성 제거 (기능 프롬프트는 그대로)",
			"patch.26": "minimal 모드: 기본 정체성을 지우고 inject 켜기",
			"patch.28": "dsh-liangshen: phase-1 에서 dsh-purge / dshpg 구간 유지",
			"patch.70": "미니멀 모드 터미널이 더 이상 네트워크를 금지하지 않음",
			"patch.71": "liangshen 공식 정체성 문장 제거",
			"patch.29": "dsh-tool-web 플러그인: 외부 untrusted 차단 → 실행 가능",
			"patch.30": "dsh-hooks-claude-code:deny→allow",
			"patch.31": "dsh-hooks-codex:deny→allow",
			"patch.32": "Web 표면 정체성 중립화",
			"patch.33": "Shell 거부 안내 → 실행 가능",
			"patch.34": "샌드박스 안내 중립화",
			"patch.35": "상승 never 거부 안 함",
			"patch.36": "파일 시스템 상승 schema 허용",
			"patch.37": "서브에이전트 scope lock 중립화",
			"patch.38": "persona text→prefix (0.1.2 프리셋)",
			"patch.39": "세션 v0 plugin summary (mnemon)",
			"patch.40": "complete 프리셋도 주입 유지",
			"patch.42": "설정 페이지 구 인터페이스",
			"patch.43": "웹 프리셋 기본 정체성 제거",
			"patch.45": "공식 데스크톱 업데이트 인계",
			"patch.46": "공식 업데이트 스크립트는 영어만 사용",
			"patch.47": "OAuth가 더 이상 Claude 정체성을 삽입하지 않음",
			"patch.48": "shell 삭제 전 추가 확인 제거",
			"patch.49": "OAuth가 더 이상 claude-cli로 위장하지 않음",
			"patch.50": "교차 세션 참조를 더 이상 신뢰 불가로 표시하지 않음",
			"patch.51": "새 세션은 전체 권한 유지",
			"patch.52": "세션 로그는 기본적으로 업로드하지 않음",
			"patch.53": "웹 안내에서 별도 서버 금지 문구 제거",
			"patch.54": "산출물 안내에서 불필요한 금지 제거",
			"patch.55": "매 단계마다 첫 시스템 프롬프트 교체",
			"patch.56": "되돌리기는 취소된 그 한 회차만 숨김",
			"patch.57": "developer role은 openai/azure 전용, 서드파티 프록시는 system으로 폴백",
			"patch.58": "되돌리기 빈 마커는 모델 요청에 들어가지 않음",
			"patch.59": "공식 Auto Review가 더 이상 도구를 막지 않음",
			"patch.60": "공식 run_code에서 승인 안내 제거",
			"patch.61": "공식 샌드박스 정책이 더 이상 거부를 가르치지 않음",
			"patch.62": "승인 채널이 없으면 통과 (사용자 거부는 여전히 유효)",
			"patch.63": "계획 모드가 더 이상 실행을 무르게 막지 않음",
			"patch.64": "Stop hook이 더 이상 가짜 사용자 발화를 주입하지 않음",
			"patch.65": "UserPromptSubmit deny가 더 이상 회차 전체를 reject하지 않음",
			"patch.66": "빈 시스템 구간이 이 회차를 내부 오류로 만들지 않음",
			"patch.67": "messages가 없을 때 이 회차를 중단하지 않음",
			"patch.68": "되돌리기 후 content가 없어도 중단하지 않음",
			"patch.69": "deepseek-flash는 공식 in-history 유지",
			"patch.72": "Messages의 system은 현재 시스템 프롬프트 사용",
			"patch.73": "미니멀 bash에서 잘못 남은 미러 설명 제거",
			"patch.74": "시작/적용 시 기본 프롬프트를 prompt-inject.md에 기록",
			"patch.75": "되돌리기가 완료된 작업을 시작 전으로 되돌림",
			"patch.76": "unrestricted 프리셋에서 정체성 문장 제거",
			"patch.77": "되돌리기 마커가 도착하면 이미 보낸 메시지 폐기",
			"patch.78": "패치 파일이 없으면 .bak에서 복구",
			"patch.80": "공식 미니멀 도구 목록 복원",
			"patch.82": "메인 프로세스 폴백 DSH_PROFILE=desktop",
			"patch.83": "host 시그널로 종료될 때 오류 없이 대화상자도 띄우지 않음",
			"patch.84": "host code=0 정상 종료는 오류 아님 (stopped 대화상자 제거)",
			"patch.85": "prompt()의 steer는 여전히 끼어들기로 처리, followup으로 누르지 않음",
			"patch.86": "큐 끼어들기는 steer로; 공용 steer()는 다음 단계 유지",
			"patch.87": "첫 assemble은 prepare가 반환한 현재 모드 systemPrompt 사용",
			"patch.88": "renderPrompt 뒤 걸기 제거, 주입은 assemble로만",
			"status.unlocated": "미탐지",
			"status.na": "이 쪽에서는 필요 없음",
			"metric.unlocated": "아직 이 컴퓨터의 Harness를 찾지 못함",
			"metric.sealed": "공식 클라이언트를 찾았습니다, 적용을 눌러 풀기",
			"metric.sealed.count": "풀기 대기",
			"metric.lost": "패치가 사라졌습니다, 다시 적용하세요",
			"metric.lost.count": "분실",
			"rewind.label": "되돌리기",
			"rewind.aria": "되돌리기",
			"rewind.busy": "되돌리는 중…",
			"rewind.empty": "되돌릴 이전 발화가 없습니다",
			"rewind.fail": "되돌리기 실패: {error}",
			"rewind.once": "이전 단계로 되돌리기",
					"rewind.once.hint": "마지막 한 단계까지 진행된 대화를 취소하고, 새 세션이 이전 컨텍스트를 이어받습니다; 그 발화는 입력 상자로 돌아가 다시 보낼 수 있습니다",
			"rewind.round": "이전 회차로 되돌리기",
					"rewind.round.hint": "이전 한 회차 전체(서브에이전트 포함)까지 진행된 대화를 취소하고, 새 세션이 이전 컨텍스트를 이어받습니다; 그 발화는 입력 상자로 돌아가 다시 보낼 수 있습니다",
			"hooksDeny.title": "Hooks 차단",
			"hooksDeny.bypass": "hooks의 deny / ask 허용 (패치 30 / 31 / 64 / 65)",
			"hooksDeny.hint": "끄면 사용자의 PreToolUse / UserPromptSubmit / Stop hook deny가 공식 로직대로 적용됩니다. 공식 ask 분기 자체가 빈 동작이라, 토글을 꺼도 승인 대화상자는 뜨지 않습니다. 고친 뒤 '적용'을 누르고 재시작해야 호스트에 기록됩니다.",
			"saved.hooksDeny": "저장했습니다",
			"continue.title": "실패 재시도 / 계속",
			"continue.hint": "요청이 실패하면 자동으로 재시도하며, 비정상 정지나 중단 시 '계속'을 누르거나 자동 이어달리기를 할 수 있습니다. 직접 정지를 누르면 자동으로 계속하지 않습니다. 횟수를 다 쓰면 새 회차를 열어야 합니다.",
			"continue.autoRetry": "실패 시 자동 재시도",
			"continue.retryMax": "재시도 횟수",
			"continue.autoContinue": "중단 후 자동 계속",
			"continue.continueMax": "계속 횟수",
			"continue.text": "계속 문구",
			"saved.continue": "저장했습니다",
			"continue.label": "계속",
			"continue.aria": "비정상 정지 후 계속",
			"continue.busy": "계속하는 중…",
			"continue.ready": "계속 (남은 횟수 {left})",
			"continue.limit": "계속 상한에 도달",
			"continue.fail": "계속 실패: {error}",
		};

		const en = {
			nav: "Rules",
			"dock.clean": "Clean",
			"dock.drill": "Drill",
			"dock.toggle": "dsh-purge",
			"dock.newSession": "dsh-purge",
			"dock.inSession": "dsh-purge",
			"dock.redteam": "Red team",
			"dock.full": "Full view",
			"dock.close": "Collapse",
			"dock.unauthorized": "Unauthorized",
			"welcome.title": "User notice",
			"welcome.lead": "Please read this on first install. After you confirm, it will not appear again.",
			"welcome.warn": "This plugin is free and open source. Anyone who sells, resells, or profits from it behind the author's back may face legal action.",
			"welcome.body": "dsh-purge is a local DeepSeek Harness plugin for security evaluation and cleaning: adjust prompts and patches on a machine you control, and use the drill console only within authorized scope. It is free and non-profit. Repository:",
			"welcome.repo": "https://github.com/wnduddld0513/dsh-purge-kr",
			"welcome.ban1": "Do not use this project for unauthorized attacks, intrusion, data theft, sabotage, or any illegal activity.",
			"welcome.ban2": "Do not commercially sell, resell, or profit from gray-market use, or redistribute for profit without the author.",
			"welcome.ban3": "You must follow local law and platform rules; illegal use is solely your responsibility.",
			"welcome.bans": "Prohibitions",
			"welcome.check": "I have read and understand this notice and will use the plugin lawfully.",
			"welcome.ok": "I understand — continue",
			"auth.title": "Drill console authorization",
			"auth.lead": "Cleaning does not need this step. Opening Drill or Full view the first time requires this dialog.",
			"auth.warn": "Warning: the drill console is only for hosts you manage, offline targets, or written authorized exercises. Unauthorized intrusion, attack, theft, or sabotage is forbidden.",
			"auth.hint.wait": "Read the notice. You can check the boxes in {n}s.",
			"auth.hint.scroll": "Countdown finished. Scroll to the end, then check the boxes.",
			"auth.hint.check": "Countdown finished. Check all three boxes.",
			"auth.check.read": "I have read the Safety and Anti-Abuse Notice and accept every clause.",
			"auth.check.scope": "I will only use authorized local hosts, offline targets, or compliant exercises.",
			"auth.check.ban": "I will not use this for any illegal purpose. Without this authorization the drill console stays closed.",
			"auth.no": "Not now",
			"auth.ok": "Authorize",
			"auth.ok.tab": "Authorize and open Drill",
			"auth.ok.full": "Authorize and open Full view",
			"auth.ok.env": "Authorize and open Env adapt",
			"envGate.title": "Environment is not ready",
			"envGate.lead": "Red team mode needs local tools before you send. If none are available, open Env adapt or confirm you will continue without them.",
			"envGate.kaliHint": "When Kali is detected, local tools are used directly and paths are optional. Otherwise set each tool path in Env adapt, or pick one toolkit folder to assign them.",
			"envGate.skip": "Skip for now",
			"envGate.skipConfirm": "You can keep chatting after this. Scan and exploit skills stay unavailable until the tools are installed. You can add paths later under dsh-purge → Env adapt.",
			"envGate.skipNo": "Back",
			"envGate.skipYes": "Continue without tools",
			"envGate.go": "Open Env adapt",
			"theme.aria": "Appearance",
			"theme.white": "Light",
			"theme.ink": "Ink",
			"purge.title": "Patches",
			"override.title": "Prompt",
			"own.save": "Save list",
			"saved.own": "Own servers saved",
			"saved.own.dropped": "Saved. {n} lines were not a single IP or hostname and were dropped",
			"metric.purged": "Written",
			"metric.purged.skip": "Written. Skipped {n}; those files are not on this install",
			"metric.pendingShort": "Pending {n}",
			"metric.unmatchedShort": "No match {n}",
			"metric.driftedShort": "Drifted {n}",
			"metric.skipShort": "Skipped {n}",
			"metric.unlocated.count": "—",
			"metric.shim": "shim",
			"metric.shim.na": "Not needed here",
			"metric.bak.yes": "Backup",
			"metric.bak.no": "No backup",
			"metric.bak.hint": "Backup",
			"table.patch": "Item",
			"table.status": "Status",
			"status.applied": "Applied",
			"status.off": "Off",
			"status.pending": "Pending",
			"status.unmatched": "No match",
			"status.drifted": "Drifted",
			"status.skipped": "Skipped",
			"apply.hint": "If you did not edit the prompt box, do not save. The default is already used and is written to prompt-inject.md on start/apply. Save only after you change it. Apply writes host patches. Pending = original text still present. Skipped = not needed for this version or the component is not installed. Drifted = the official source changed, this patch did not land and its pattern needs an update.",
			"flow.title": "Clean flow",
			"flow.apply": "Apply",
			"flow.revert": "Restore",
			"flow.uninstall": "Uninstall",
			"flow.home": "Home",
			"flow.locate": "Host",
			"flow.override": "Prompt",
			"flow.patch": "Patch",
			"flow.shim": "Launcher",
			"flow.flash": "Flash",
			"flow.seed": "Seed",
			"flow.done": "Done",
			"flow.revert.step": "Restore",
			"flow.cleanup": "Cleanup",
			"warn.noRoot": "Could not find this host’s @deepseek-ai tree, so Apply will not patch anything. Fully quit and reopen this host, then Apply here. Desktop may live on any drive; folder names like DeepseekHarnessDesktop or DeepSeek Harness are fine.",
			"warn.noRoot.desktop": "Official Harness keeps its code in app.asar. Apply unpacks it and restarts the app. If this page stays “not found”, fully quit the client, reopen it, then Apply again. Third-party DSH Desktop: just Apply.",
			"unpack.restarting": "Patches are written. Click Restart and the client opens again by itself.",
			"restart.fullQuit": "Restarting. The client will open again by itself.",
			"warn.noInject": "Official mode always uses the default prompt. Red team uses only the active rule set; otherwise it uses the default prompt without the CTF section, then the red team steps. If both are empty you will be asked to add a prompt.",
			"warn.hostVersion": "This host is {v}, but the plugin targets {t}. When the official source no longer matches, patches show up as “drifted” — switch back to the targeted host version.",
			"need.prompt": "Both the prompt and the rule set are empty. Add a prompt, or enable a rule that has content.",
			"btn.restoreInject": "Reset default",
			"saved.restoreInject": "Default prompt restored",
			"skip": "Skipped",
			"unknown": "Unknown",
			"delete": "Delete",
			"btn.apply": "Apply",
			"btn.apply.busy": "Working…",
			"btn.revert": "Restore",
			"btn.uninstall": "Uninstall",
			"btn.uninstall.busy": "Uninstalling…",
			"uninstall.title": "Uninstall dsh-purge",
			"uninstall.body": "Uninstall? This restores the original Harness and removes this plugin completely.",
			"uninstall.confirm": "Uninstall",
			"uninstall.cancel": "Cancel",
			"uninstall.applying": "Uninstalling and restoring…",
			"uninstall.done": "Uninstalled and restored. Restarting…",
			"uninstall.done.desktop": "Uninstalled and restored. Restarting the desktop app…",
			"uninstall.fail": "Uninstall failed: {error}",
			"btn.checkUpdate": "Check update",
			"btn.checkUpdate.busy": "Checking…",
			"btn.doUpdate": "Update",
			"btn.doUpdate.busy": "Updating…",
			"channel.title": "Channel",
			"channel.stable": "Stable",
			"channel.beta": "Beta",
			"channel.useStable": "Switch to stable",
			"channel.useBeta": "Switch to beta",
			"channel.local": "This copy",
			"update.checking": "Checking for updates…",
			"update.applying": "Updating…",
			"update.switching": "Switching version…",
			"update.latest": "Up to date ({version})",
			"update.available": "Update {remote} available (now {local})",
			"update.pinned": "Pinned at {version}; channel latest is {remote}",
			"update.done": "Updated to {version}.",
			"update.restarting": "Restored the old patches, wrote the new ones, and restarting…",
			"update.fullQuit": "Patches are written. Click Restart and the client opens again by itself.",
			"restart.official.title": "Restart required",
			"restart.official.body": "Patches are written. Click Restart and the client opens again by itself.",
			"update.switched": "Switched to {version}.",
			"update.autoDone": "Auto-updated to {version}.",
			"update.reloading": "Refreshing settings…",
			"update.dirty": "Update available; local edits were not overwritten.",
			"update.fail": "Update failed: {error}",
			"update.timeout": "Check timed out. Click Check update again.",
			"update.needRestart": "Update API is not loaded. Restart dsh, then check again.",
			"update.noBeta": "No beta build yet",
			"update.switch": "Switch to this version",
			"update.pick": "Select version",
			"update.tip": "latest",
			"update.current": "current",
			"update.confirmSwitch": "Switch to {version}? You can switch back later. Uncommitted plugin edits will not be kept.",
			"update.confirmChannel": "Switch to {version}? The plugin will be reinstalled from that channel. Uncommitted plugin edits will not be kept.",
			"metric.version": "Version",
			"action.apply": "Apply",
			"action.revert": "Restore",
			"action.uninstall": "Uninstall",
			"ok.done": "Done",
			"err.action": "Failed: {error}",
			"err.status": "Read failed: {error}",
			"err.override": "Read failed: {error}",
			"err.rules": "Read failed: {error}",
			"err.read": "Read failed: {error}",
			"err.save": "Save failed: {error}",
			"btn.saveInject": "Save",
			"saved.override": "Saved",
			"rules.title": "Rule sets",
			"rules.none": "None",
			"rules.reset": "Restore",
			"rules.reset.confirm": "Restore global instruction files? The rule library is kept.",
			"rules.empty": "No rules",
			"rules.pick": "Select a rule",
			"policy.title": "Workspace policy",
			"policy.strict": "Strict",
			"policy.fallback": "Fallback",
			"policy.always": "Always on",
			"policy.hint": "Strict: always strip AGENTS.md / CLAUDE.md. Fallback: use workspace files only when the prompt box is empty. Always on: keep DSH default behavior.",
			"cwd.title": "Local rules (current folder)",
			"cwd.empty": "No AGENTS.md / CLAUDE.md in this folder",
			"cwd.rescan": "Rescan",
			"cwd.hint": "Checked files are injected only when the prompt box is empty. A non-empty prompt box always wins.",
			"cwd.scope.cwd": "cwd",
			"cwd.scope.ancestor": "ancestor",
			"cwd.scope.root": "project root",
			"cwd.no.workspace": "DSH has not opened a workspace yet. Start a task in DSH first, then come back.",
			"pill.current": "On",
			"btn.use": "Enable",
			"btn.inUse": "On",
			"confirm.delete": "Delete {id}?",
			"ph.id": "id",
			"ph.alias": "Name",
			"ph.alias.short": "Name",
			"btn.create": "New",
			"need.id": "id required",
			"ph.content": "",
			"btn.saveRule": "Save",
			"skills.title": "Skills",
			"skills.hint": "After import, DSH calls it: type /name in chat to load now; the model calls the skill tool when the task matches description or whenToUse. Writing 'activate' in the body does nothing.",
			"skills.hint.desktop": "This desktop host’s official skill catalog. Type /name in chat to load; the model calls the skill tool when the task matches the description.",
			"skills.empty": "No user skills",
			"btn.importZip": "Import zip",
			"btn.importFolder": "Import folder",
			"skills.importing": "Importing…",
			"saved.import": "Imported {count} skill(s)",
			"need.import": "Choose a zip or folder",
			"err.import.folder": "No files were read. Select the skill folder itself (it must contain SKILL.md).",
			"skills.pick": "Select a skill",
			"skills.invalid": "Official catalog will ignore this: invalid format",
			"skills.call.slash": "Type {cmd} in chat",
			"skills.call.model": "Model can load",
			"skills.call.modelOff": "Hidden from model",
			"skills.call.userOff": "/name disabled",
			"ph.skill.desc": "description (when to use)",
			"btn.saveSkill": "Save",
			"need.skill.id": "id must be kebab-case, e.g. code-review",
			"confirm.delete.skill": "Delete {id} from official $DSH_HOME/skills? The host will drop it from the catalog.",
			"err.skills": "Read failed: {error}",
			"err.skills.needRestart": "Skill API is not loaded. Restart this host first.",
			"btn.restart": "Restart",
			"btn.restart.busy": "Restarting…",
			"restarting": "Restarting…",
			"restarting.desktop": "Restarting the desktop app…",
			"restart.timeout": "Timed out; refresh",
			"restart.fail": "Failed: {error}",
			"restart.notStarted": "Restart did not start. This client is still open, and it will not try again by itself.",
			"restart.already": "This restart already started. It will not restart again.",
			"restart.confirm": "Apply finished. Restart to take effect.",
			"restart.confirm.desktop": "Apply finished. Restart the desktop app to take effect.",
			"restart.ask.title": "Restart now?",
			"restart.ask.body": "It is written. It takes effect in this client after a restart.",
			"restart.now": "Restart now",
			"restart.notNow": "Later",
			"restart.asarSwap": "Patches are on disk. Quitting the desktop app and moving app.asar aside; it will reopen when done. If behavior is unchanged, fully quit Harness (including tray) and Apply again.",
			"surface.web": "Web",
			"surface.desktop": "Desktop",
			"surface.gui": "GUI",
			"surface.tui": "TUI",
			"restart.incomplete": "The prompt is in. {detail}",
			"restart.incomplete.patches": "{failed} code patch(es) did not match this host (#{ids}). The prompt is unaffected",
			"restart.incomplete.flash": "CMD silence not pinned ({entry})",
			"restart.later": "Later",
			"group.prompt": "Prompt",
			"group.code": "Code",
			"group.engine": "Engine",
			"group.tools": "Tools",
			"group.compat": "0.1.5 compat",
			"group.dsh20": "0.2.0",
			"patch.1": "Global disclaimer → mandate",
			"patch.2": "Replacement disclaimer → mandate",
			"patch.3": "Scope disclaimer → mandate",
			"patch.4": "Persona session mandate",
			"patch.5": "Approval copy → full access",
			"patch.6": "Sandbox deny → allow write",
			"patch.7": "Sandbox default full access",
			"patch.8": "Approval default never",
			"patch.9": "Approval gate auto-grant",
			"patch.10": "Approval config default never",
			"patch.11": "never copy → auto-grant",
			"patch.12": "ask copy → auto-grant",
			"patch.13": "Escalation ladder exempt",
			"patch.14": "Escalation unconditional grant",
			"patch.15": "Sandbox confine passthrough",
			"patch.16": "Filesystem fence off",
			"patch.17": "Observation policy allow R/W",
			"patch.18": "Repeat-call guard off",
			"patch.19": "Tool-result pruner off",
			"patch.21": "Restore plugin-raised bash wait",
			"patch.22": "read cap raised",
			"patch.23": "subagent depth 3 → 10",
			"patch.24": "preset fetch on",
			"patch.25": "Strip official default identity (keep feature prompts)",
			"patch.26": "minimal: strip identity, open inject",
			"patch.28": "dsh-liangshen: keep dsh-purge / dshpg in phase-1",
			"patch.70": "Minimal shell drops the no-network line",
			"patch.71": "Liangshen drops the stock identity line",
			"patch.29": "dsh-tool-web: untrusted framing → usable data",
			"patch.30": "dsh-hooks-claude-code: deny→allow",
			"patch.31": "dsh-hooks-codex: deny→allow",
			"patch.32": "Web surface identity neutral",
			"patch.33": "Shell denial prompt → executable",
			"patch.34": "Sandbox hint neutralized",
			"patch.35": "Escalation never-reject",
			"patch.36": "FS escalation schema opened",
			"patch.37": "Subagent scope lock neutralized",
			"patch.38": "persona text→prefix (0.1.2 presets)",
			"patch.39": "session v0 plugin summary (mnemon)",
			"patch.40": "Keep inject when a complete prompt is set",
			"patch.42": "Settings legacy API",
			"patch.43": "Strip identity from web presets",
			"patch.45": "Official desktop update handoff",
			"patch.46": "Official update script stays ASCII",
			"patch.47": "OAuth no longer inserts Claude identity",
			"patch.48": "Shell drops extra delete caution",
			"patch.49": "OAuth no longer mimics claude-cli",
			"patch.50": "Session references are not marked untrusted",
			"patch.51": "Fresh session stays on full access",
			"patch.52": "Session log upload off by default",
			"patch.53": "Web prompt drops do-not-start",
			"patch.54": "Deliverable prompt drops extra prohibition",
			"patch.55": "Replace the first system prompt every step",
			"patch.56": "Rewind hides only the cut range",
			"patch.57": "developer role for openai/azure only, third-party gateways use system",
			"patch.58": "Rewind markers stay off the model request",
			"patch.59": "Official Auto Review no longer denies tools",
			"patch.60": "Official run_code drops approval teaching",
			"patch.61": "Official sandbox policy no longer teaches refusal",
			"patch.62": "Fail-open without approval channel (user reject kept)",
			"patch.63": "Plan mode no longer soft-blocks execution",
			"patch.64": "Stop hook no longer steers fake user text",
			"patch.65": "UserPromptSubmit deny no longer rejects turn",
			"patch.66": "Empty system section no longer ends the turn as an internal error",
			"patch.67": "A missing messages list no longer ends the turn",
			"patch.68": "Missing content after rewind no longer ends the turn",
			"patch.69": "deepseek-flash keeps the official in-history flag",
			"patch.72": "Messages system field uses the current system prompt",
			"patch.73": "Minimal preset drops stray mirror sentence",
			"patch.74": "Start/apply writes the default prompt to prompt-inject.md",
			"patch.75": "Rewind resets completed todos to pending",
			"patch.76": "Unrestricted preset: strip identity sentence",
			"patch.77": "Rewind marker drops already-sent messages",
			"patch.78": "Restore missing overlay from .bak backup",
			"patch.80": "Restore official minimal tool plugins",
			"patch.82": "Fallback DSH_PROFILE=desktop in main process",
			"patch.83": "Don't fail on signal kill (no crash dialog)",
			"patch.84": "Don't fail on code=0 clean exit (no stopped dialog)",
			"patch.85": "prompt() steer stays interrupt, not followup",
			"patch.86": "Queue steer stays steer; public steer() stays next-step",
			"patch.87": "First assemble uses the systemPrompt prepare returned",
			"patch.88": "Drop the hang after renderPrompt; inject is assemble only",
			"status.na": "Not for this host",
			"metric.sealed": "Official client found. Apply to unpack",
			"metric.sealed.count": "Sealed",
			"metric.lost": "Patches lost — Apply again",
			"metric.lost.count": "Lost",
			"status.unlocated": "Not located",
			"metric.unlocated": "This install was not found yet",
			"rewind.label": "Undo",
			"rewind.aria": "Undo",
			"rewind.busy": "Undoing…",
			"rewind.empty": "Nothing to undo",
			"rewind.fail": "Undo failed: {error}",
			"rewind.once": "Undo last step",
					"rewind.once.hint": "Withdraw the last step into a new session that keeps earlier context; the line returns to the box",
			"rewind.round": "Undo last turn",
					"rewind.round.hint": "Withdraw the last turn (and its subagents) into a new session that keeps earlier context; the line returns to the box",
			"hooksDeny.title": "Hook interception",
			"hooksDeny.bypass": "Bypass hook deny / ask (patches 30 / 31 / 64 / 65)",
			"hooksDeny.hint": "When off, your own PreToolUse / UserPromptSubmit / Stop hook deny runs as the official host wrote it. The official ask branch is a no-op; turning this off will not show an approval dialog. Click Apply and restart to write the host files.",
			"saved.hooksDeny": "Saved",
			"continue.title": "Retry / Continue",
			"continue.hint": "Failed requests auto-retry. After an abnormal stop or interrupt, use Continue or auto-resume. A manual stop never auto-continues. Counts reset after a completed turn.",
			"continue.autoRetry": "Auto-retry on failure",
			"continue.retryMax": "Retry count",
			"continue.autoContinue": "Auto-continue after interrupt",
			"continue.continueMax": "Continue count",
			"continue.text": "Continue text",
			"saved.continue": "Saved",
			"continue.label": "Continue",
			"continue.aria": "Continue after an abnormal stop",
			"continue.busy": "Continuing…",
			"continue.ready": "Continue ({left} left)",
			"continue.limit": "Continue limit reached",
			"continue.fail": "Continue failed: {error}",
		};

		const PURGE_CSS = `
.dshp-root{--dshp-display:inherit;--dshp-sans:inherit;--dshp-mono:ui-monospace,"Cascadia Mono","Sarasa Mono SC",monospace;--dshp-ease:cubic-bezier(.22,1,.36,1);--dshp-glass:blur(18px) saturate(1.35);--dshp-hi:color-mix(in srgb,#fff 42%,transparent);max-width:920px;display:flex;flex-direction:column;gap:16px;padding:16px;border-radius:12px;background:transparent;color:var(--dshp-ink);font-family:inherit}
.dshp-root{--dshp-bg:transparent;--dshp-paper:color-mix(in srgb,var(--dsw-alias-bg-layer-1,#fffcf7) 46%,transparent);--dshp-ink:var(--dsw-alias-label-primary,#16140f);--dshp-mute:color-mix(in srgb,var(--dsw-alias-label-primary,#16140f) 72%,var(--dsw-alias-label-secondary,#5c564c));--dshp-line:color-mix(in srgb,var(--dsw-alias-brand-primary,#6d8f78) 34%,transparent);--dshp-fill:color-mix(in srgb,var(--dsw-alias-brand-primary,#6dbf8c) 14%,transparent);--dshp-accent:var(--dsw-alias-brand-primary,#3d8f68);--dshp-accent-soft:color-mix(in srgb,var(--dsw-alias-brand-primary,#6dbf8c) 18%,transparent);--dshp-ok:#2f6b4f;--dshp-warn:#8a5a12;--dshp-bad:#9a3434}
.dshp-root[data-theme="white"]{color-scheme:light;--dshp-hi:color-mix(in srgb,#fff 48%,transparent)}
.dshp-root[data-theme="dusk"]{color-scheme:dark;--dshp-paper:color-mix(in srgb,var(--dsw-alias-bg-layer-1,#1c1e24) 42%,transparent);--dshp-ink:var(--dsw-alias-label-primary,#f4f1ea);--dshp-mute:color-mix(in srgb,var(--dsw-alias-label-primary,#f4f1ea) 78%,var(--dsw-alias-label-secondary,#c9c3b8));--dshp-line:color-mix(in srgb,var(--dsw-alias-brand-primary,#6dbf8c) 32%,transparent);--dshp-ok:#8fd0a8;--dshp-warn:#e4c48a;--dshp-bad:#f0b4b4;--dshp-hi:color-mix(in srgb,#fff 10%,transparent)}
.dshp-toolbar{display:flex;align-items:center;justify-content:flex-end;gap:8px}
.dshp-switch{display:inline-flex;border:1px solid var(--dshp-line);border-radius:999px;overflow:hidden;background:var(--dshp-paper)}
.dshp-switch button{appearance:none;border:0;background:transparent;color:var(--dshp-mute);font:12px/1 var(--dshp-sans);padding:8px 12px;cursor:pointer}
.dshp-switch button.is-on{background:var(--dshp-accent-soft);color:var(--dshp-ink)}
.dshp-switch button:focus-visible{outline:2px solid var(--dshp-accent);outline-offset:-2px}
.dshp-panel,.dshp-metric,.dshp-group,.dshp-ask,.dshp-modal,.dshp-rulelist,.dshp-active,.dshp-switch,.dshp-editor,.dshp-cwd-list,.dshp-create{border:1px solid var(--dshp-line);background:var(--dshp-paper);backdrop-filter:var(--dshp-glass);-webkit-backdrop-filter:var(--dshp-glass);box-shadow:inset 0 1px 0 var(--dshp-hi)}
.dshp-panel{border-radius:12px;padding:16px}
.dshp-kicker{font-family:var(--dshp-mono);font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:var(--dshp-mute);margin:0 0 4px}
.dshp-title{font-family:inherit;font-size:20px;font-weight:600;letter-spacing:0;line-height:28px;margin:0;color:var(--dshp-ink);text-wrap:balance}
.dshp-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:16px;flex-wrap:wrap}
.dshp-sub{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:24px 0 12px}
.dshp-sub h4{margin:0;font-family:inherit;font-size:16px;font-weight:600;line-height:24px}
.dshp-metrics{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin-bottom:16px}
.dshp-metric{padding:12px;min-height:64px;display:flex;flex-direction:column;gap:4px;border-radius:8px}
.dshp-metric b{font-family:inherit;font-size:18px;font-weight:600;line-height:28px}
.dshp-metric span{font-size:12px;line-height:16px;color:var(--dshp-mute)}
.dshp-bar{height:4px;border-radius:999px;background:var(--dshp-line);overflow:hidden;margin:8px 0 16px}
.dshp-bar>i{display:block;height:100%;width:100%;transform:scaleX(0);transform-origin:left center;background:var(--dshp-accent);transition:transform 500ms var(--dshp-ease)}
.dshp-flow{display:flex;align-items:center;gap:0;margin:0 0 16px;overflow-x:auto;padding:4px 0}
.dshp-flow-kind{font:12px/16px var(--dshp-mono);letter-spacing:.08em;text-transform:uppercase;color:var(--dshp-mute);margin:0 12px 0 0;flex:0 0 auto}
.dshp-flow-node{display:flex;flex-direction:column;align-items:center;gap:4px;min-width:44px;opacity:.42;transition:opacity 500ms var(--dshp-ease),transform 500ms var(--dshp-ease)}
.dshp-flow-node b{width:22px;height:22px;border-radius:99px;border:1px solid var(--dshp-line);display:flex;align-items:center;justify-content:center;font:11px/1 var(--dshp-mono);background:var(--dshp-paper)}
.dshp-flow-node em{font-style:normal;font-size:12px;line-height:16px;color:var(--dshp-mute);white-space:nowrap}
.dshp-flow-node.is-cur{opacity:1;transform:translateY(-2px)}
.dshp-flow-node.is-cur b{border-color:var(--dshp-accent);background:var(--dshp-accent-soft);box-shadow:0 0 0 4px var(--dshp-accent-soft)}
.dshp-flow-node.is-done{opacity:.92}
.dshp-flow-node.is-done b{border-color:var(--dshp-ok);background:color-mix(in srgb,var(--dshp-ok) 18%,transparent);color:var(--dshp-ok)}
.dshp-flow-node.is-bad b{border-color:var(--dshp-bad);color:var(--dshp-bad);background:color-mix(in srgb,var(--dshp-bad) 14%,transparent)}
.dshp-flow-wire{flex:1 1 12px;min-width:10px;height:2px;background:var(--dshp-line);position:relative;overflow:hidden;margin:0 4px 16px}
.dshp-flow-wire.is-on{background:color-mix(in srgb,var(--dshp-accent) 55%,var(--dshp-line))}
.dshp-flow-wire.is-on>i{position:absolute;inset:0 auto 0 -40%;width:40%;background:var(--dshp-accent);animation:dshp-flow-pulse 1.4s cubic-bezier(.65,0,.35,1) infinite}
@keyframes dshp-flow-pulse{to{transform:translateX(360%)}}
@media (prefers-reduced-motion:reduce){
.dshp-flow-wire.is-on>i{animation:none;display:none}
.dshp-flow-node.is-cur{transform:none}
}
.dshp-group{margin:0 0 8px;border-radius:8px;overflow:hidden}
.dshp-group-h{width:100%;display:flex;align-items:center;gap:12px;padding:8px 12px;border:0;background:transparent;color:inherit;cursor:pointer;font:inherit;text-align:left}
.dshp-group-h:hover{background:var(--dshp-fill)}
.dshp-group-h:focus-visible{outline:2px solid var(--dshp-accent);outline-offset:-2px}
.dshp-group-h strong{font-family:inherit;font-size:14px;line-height:20px;font-weight:600}
.dshp-group-h em{font-style:normal;font-size:12px;color:var(--dshp-mute);flex:1}
.dshp-count{font-family:var(--dshp-mono);font-size:12px;color:var(--dshp-mute)}
.dshp-table{width:100%;border-collapse:collapse;font-size:12px;line-height:16px}
.dshp-table th{text-align:left;font-weight:500;font-size:11px;letter-spacing:.06em;color:var(--dshp-mute);padding:8px 12px;border-bottom:1px solid var(--dshp-line)}
.dshp-table td{padding:8px 12px;border-bottom:1px solid var(--dshp-line);vertical-align:middle}
.dshp-table tr:last-child td{border-bottom:0}
.dshp-table tr.is-on td{background:var(--dshp-accent-soft)}
.dshp-id{font-family:var(--dshp-mono);opacity:.75;width:42px}
.dshp-actions{text-align:right;white-space:nowrap}
.dshp-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dshp-row+.dshp-row{margin-top:12px}
.dshp-pill{display:inline-flex;align-items:center;gap:4px;font-family:var(--dshp-mono);font-size:12px;padding:2px 8px;border:1px solid var(--dshp-line);border-radius:999px;line-height:16px;background:color-mix(in srgb,var(--dshp-paper) 70%,transparent)}
.dshp-pill::before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor}
.dshp-pill.is-ok{color:var(--dshp-ok);border-color:color-mix(in srgb,var(--dshp-ok) 30%,var(--dshp-line))}
.dshp-pill.is-wait{color:var(--dshp-warn);border-color:color-mix(in srgb,var(--dshp-warn) 30%,var(--dshp-line))}
.dshp-pill.is-miss{color:var(--dshp-mute)}
.dshp-pill.is-bad{color:var(--dshp-bad)}
.dshp-btn{appearance:none;font-family:system-ui,-apple-system,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei","Noto Sans SC",sans-serif;font-size:16px;line-height:24px;font-weight:600;padding:8px 12px;border-radius:8px;border:1px solid transparent;cursor:pointer;transition:transform 500ms var(--dshp-ease),opacity 300ms var(--dshp-ease);-webkit-text-fill-color:currentColor;text-indent:0;overflow:visible}
.dshp-btn:hover:not(:disabled){transform:translateY(-1px)}
.dshp-btn:active:not(:disabled){transform:scale(0.98)}
.dshp-btn:disabled{opacity:.45;cursor:not-allowed}
.dshp-btn:focus-visible{outline:2px solid var(--dshp-accent);outline-offset:2px}
.dshp-btn-primary{background:var(--dshp-accent);color:#fff;border-color:var(--dshp-accent)}
.dshp-btn-primary:hover:not(:disabled){background:color-mix(in srgb,var(--dshp-accent) 86%,#fff);color:#fff}
.dshp-btn-ghost{background:transparent;color:var(--dshp-ink);border-color:var(--dshp-line)}
.dshp-btn-danger{background:transparent;color:var(--dshp-bad);border-color:color-mix(in srgb,var(--dshp-bad) 40%,var(--dshp-line))}
.dshp-btn-solid-danger{background:color-mix(in srgb,var(--dshp-bad) 16%,var(--dshp-bg));color:var(--dshp-bad);border-color:color-mix(in srgb,var(--dshp-bad) 30%,var(--dshp-line))}
.dshp-btn-tiny{padding:4px 12px;font-size:14px;line-height:20px}
.dshp-field,.dshp-area{width:100%;box-sizing:border-box;font:13px/1.55 var(--dshp-mono);padding:8px 12px;background:color-mix(in srgb,var(--dsw-alias-bg-layer-1,#fff) 38%,transparent);color:var(--dshp-ink);border:1px solid var(--dshp-line);border-radius:8px;backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px)}
.dshp-field{width:auto;min-width:140px}
.dshp-cr-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:8px 0 0;font-size:13px}
.dshp-cr-row label{display:inline-flex;align-items:center;gap:6px;color:var(--dshp-ink)}
.dshp-cr-num{width:64px;min-width:64px;height:28px;padding:0 8px}
.dshp-cr-text{width:120px;min-width:88px;height:28px;padding:0 8px}
.dshp-ver{width:100%;min-width:0;max-width:none;height:32px;padding:0 10px;font-size:12px}
.dshp-rel{margin:0 0 12px}
.dshp-now{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;margin:0 0 4px}
.dshp-now-label{font-family:var(--dshp-mono);font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:var(--dshp-mute)}
.dshp-now-ver{font-family:inherit;font-size:20px;line-height:28px;font-weight:600;letter-spacing:0}
.dshp-now-mark{display:inline-flex;align-items:center;margin-left:8px;padding:2px 8px;border-radius:99px;font-family:var(--dshp-mono);font-size:11px;font-style:normal;font-weight:500;line-height:1.5;color:var(--dshp-ok);border:1px solid color-mix(in srgb,var(--dshp-ok) 38%,var(--dshp-line));background:color-mix(in srgb,var(--dshp-ok) 14%,var(--dshp-bg))}
.dshp-editions{display:flex;flex-direction:column;margin:8px 0 0;border-top:1px solid var(--dshp-line)}
.dshp-edition{display:grid;grid-template-columns:auto minmax(0,1fr) auto;align-items:center;gap:8px;padding:12px 0;border-bottom:1px solid var(--dshp-line)}
.dshp-edition-name{display:inline-flex;align-items:center;gap:0;font-family:inherit;font-size:16px;line-height:24px;font-weight:600;white-space:nowrap}
.dshp-edition.is-on .dshp-edition-name{color:var(--dshp-ink)}
.dshp-edition:not(.is-on) .dshp-edition-name{color:var(--dshp-mute)}
.dshp-edition .dshp-btn{min-width:118px}
.dshp-rel .dshp-notice{display:block;margin-top:8px;min-height:16px}
@media (max-width:560px){.dshp-edition{grid-template-columns:1fr auto;grid-template-areas:"name btn" "sel sel"}.dshp-edition-name{grid-area:name}.dshp-edition .dshp-ver{grid-area:sel}.dshp-edition .dshp-btn{grid-area:btn}}
.dshp-area{min-height:220px;resize:vertical}
.dshp-field:focus,.dshp-area:focus{outline:none;border-color:var(--dshp-accent);box-shadow:0 0 0 3px var(--dshp-accent-soft)}
.dshp-field:disabled,.dshp-area:disabled{opacity:.5}
.dshp-ask{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:12px;padding:12px;border-radius:8px;font-size:14px;line-height:20px}
.dshp-modal-bg{position:fixed;inset:0;z-index:80;display:flex;align-items:center;justify-content:center;padding:24px;background:color-mix(in srgb,var(--dshp-ink) 28%,transparent)}
.dshp-modal{width:min(420px,100%);color:var(--dshp-ink);border-radius:12px;padding:16px;box-shadow:inset 0 1px 0 var(--dshp-hi),0 16px 40px color-mix(in srgb,#000 22%,transparent)}
.dshp-modal h4{margin:0 0 8px;font-family:inherit;font-size:18px;line-height:28px;font-weight:600}
.dshp-modal p{margin:0 0 16px;font-size:14px;line-height:20px;text-wrap:pretty}
.dshp-modal-ops{display:flex;justify-content:flex-end;gap:8px}
.dshp-restart-mask{position:fixed;inset:0;z-index:12000;display:flex;align-items:center;justify-content:center;padding:24px;background:rgba(0,0,0,.62);font-family:inherit}
.dshp-restart-card{width:min(420px,100%);box-sizing:border-box;padding:16px;border-radius:16px;background:color-mix(in srgb,var(--dsw-alias-bg-layer-1,#fffcf7) 46%,transparent);color:var(--dsw-alias-label-primary,#16140f);border:1px solid color-mix(in srgb,var(--dsw-alias-brand-primary,#6d8f78) 34%,transparent);box-shadow:inset 0 1px 0 color-mix(in srgb,#fff 42%,transparent),0 16px 40px color-mix(in srgb,#000 22%,transparent);backdrop-filter:blur(22px) saturate(1.4);-webkit-backdrop-filter:blur(22px) saturate(1.4)}
.dshp-restart-card h4{margin:0 0 8px;font-family:inherit;font-size:20px;font-weight:600;line-height:28px;color:inherit}
.dshp-restart-card p{margin:0 0 16px;font-size:16px;font-weight:500;line-height:24px;color:inherit}
.dshp-restart-card .dshp-modal-ops{display:flex;justify-content:flex-end;gap:8px}
.dshp-restart-card .dshp-btn{padding:8px 12px;font-size:16px;font-weight:600;color:var(--dsw-alias-label-primary,#16140f);background:color-mix(in srgb,var(--dsw-alias-bg-layer-2,#fff) 40%,transparent);border:1px solid color-mix(in srgb,var(--dsw-alias-brand-primary,#6d8f78) 34%,transparent)}
.dshp-restart-card .dshp-btn-primary,.dshp-restart-card .dshp-btn-primary:hover:not(:disabled){color:#fff;background:var(--dsw-alias-brand-primary,#2f6b4f);border-color:var(--dsw-alias-brand-primary,#2f6b4f)}
body[data-ds-dark-theme] .dshp-restart-card,.dshp-restart-mask[data-theme="dusk"] .dshp-restart-card{background:color-mix(in srgb,var(--dsw-alias-bg-layer-1,#1c1e24) 42%,transparent);color:#f4f1ea;border-color:color-mix(in srgb,var(--dsw-alias-brand-primary,#6dbf8c) 32%,transparent);box-shadow:inset 0 1px 0 color-mix(in srgb,#fff 10%,transparent),0 16px 40px color-mix(in srgb,#000 28%,transparent)}
body[data-ds-dark-theme] .dshp-restart-card .dshp-btn,.dshp-restart-mask[data-theme="dusk"] .dshp-restart-card .dshp-btn{color:#f4f1ea;background:color-mix(in srgb,#1c1e24 42%,transparent);border-color:color-mix(in srgb,#6dbf8c 32%,transparent)}
body[data-ds-dark-theme] .dshp-restart-card .dshp-btn-primary,body[data-ds-dark-theme] .dshp-restart-card .dshp-btn-primary:hover:not(:disabled),.dshp-restart-mask[data-theme="dusk"] .dshp-restart-card .dshp-btn-primary,.dshp-restart-mask[data-theme="dusk"] .dshp-restart-card .dshp-btn-primary:hover:not(:disabled){color:#fff;background:#3d8f68;border-color:#3d8f68}
.dshp-notice{font-size:12px;line-height:16px}
.dshp-notice.is-ok{color:var(--dshp-ok)}
.dshp-notice.is-bad{color:var(--dshp-bad)}
.dshp-skel{height:12px;border-radius:4px;background:var(--dshp-fill);animation:dshp-pulse 1.2s var(--dshp-ease) infinite}
.dshp-active{display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:12px;margin-bottom:12px;border-radius:8px}
.dshp-active b{font-family:inherit;font-weight:600}
.dshp-empty{padding:24px 12px;font-size:13px;color:var(--dshp-mute);text-align:center}
.dshp-split{display:flex;flex-direction:column;gap:12px}
.dshp-rulelist{display:flex;flex-direction:column;border-radius:8px;overflow:hidden}
.dshp-rulebody{max-height:240px;overflow:auto}
.dshp-ruleitem{display:flex;align-items:center;gap:12px;width:100%;padding:12px;border:0;border-bottom:1px solid var(--dshp-line);background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}
.dshp-ruleitem:hover{background:var(--dshp-fill)}
.dshp-ruleitem.is-edit{background:var(--dshp-accent-soft)}
.dshp-rule-main{flex:1;min-width:0}
.dshp-rule-name{display:flex;align-items:center;gap:8px;font-family:inherit;font-size:14px;line-height:20px;font-weight:600}
.dshp-rule-meta{display:block;margin-top:3px;font-family:var(--dshp-mono);font-size:11px;color:var(--dshp-mute)}
.dshp-rule-ops{display:flex;flex-direction:row;align-items:center;gap:6px;flex-shrink:0}
.dshp-create{display:flex;flex-direction:column;gap:8px;padding:12px;border-top:1px solid var(--dshp-line)}
.dshp-create-row{display:flex;gap:6px;align-items:center}
.dshp-create .dshp-field{flex:1;min-width:0;width:auto}
.dshp-editor{display:flex;flex-direction:column;gap:12px;min-width:0;border-radius:8px;padding:12px;min-height:320px}
.dshp-editor .dshp-area{flex:1;min-height:240px}
.dshp-editor-empty{flex:1;display:flex;align-items:center;justify-content:center;color:var(--dshp-mute);font-size:13px;min-height:160px}
.dshp-block{padding:16px 0;border-top:1px solid var(--dshp-line)}
.dshp-block-head{display:flex;align-items:center;gap:8px;margin:0 0 8px}
.dshp-block-head h4{margin:0;font-family:inherit;font-size:14px;line-height:20px;font-weight:600;flex:1;color:var(--dshp-ink)}
.dshp-block-hint{margin:8px 0 0;font-size:12px;line-height:1.55;color:var(--dshp-mute)}
.dshp-policy-row{display:flex;align-items:center;gap:8px}
.dshp-policy-row>label{font-size:12px;color:var(--dshp-mute);flex:0 0 auto}
.dshp-cwd-path{margin:0 0 8px;font-family:var(--dshp-mono);font-size:11px;color:var(--dshp-mute);word-break:break-all;line-height:1.5}
.dshp-cwd-list{display:flex;flex-direction:column;border-radius:8px;overflow:hidden}
.dshp-cwd-item{display:flex;align-items:flex-start;gap:8px;padding:12px;border-bottom:1px solid var(--dshp-line);cursor:pointer;margin:0}
.dshp-cwd-item:last-child{border-bottom:0}
.dshp-cwd-item:hover{background:var(--dshp-fill)}
.dshp-cwd-item.is-on{background:var(--dshp-accent-soft)}
.dshp-cwd-item input{margin:3px 0 0;flex:0 0 auto}
.dshp-cwd-main{flex:1;min-width:0}
.dshp-cwd-name{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-family:inherit;font-size:14px;line-height:20px;font-weight:600;color:var(--dshp-ink)}
.dshp-cwd-badge{font-family:var(--dshp-mono);font-size:10px;letter-spacing:.04em;text-transform:uppercase;padding:1px 7px;border-radius:99px;border:1px solid var(--dshp-line);color:var(--dshp-mute);line-height:1.6}
.dshp-cwd-size{font-family:var(--dshp-mono);font-size:11px;color:var(--dshp-mute)}
.dshp-cwd-sub{margin-top:3px;font-family:var(--dshp-mono);font-size:11px;color:var(--dshp-mute);word-break:break-all}
.dshp-cwd-prev{margin-top:4px;font-size:11px;line-height:1.5;color:var(--dshp-mute);max-height:34px;overflow:hidden}
@keyframes dshp-pulse{0%,100%{opacity:.4}50%{opacity:1}}
@media (max-width:640px){.dshp-metrics{grid-template-columns:1fr}.dshp-ruleitem{flex-wrap:wrap}.dshp-rule-ops{width:100%;justify-content:flex-end}}
.dshp-root em,.dshp-dock em,.rt-flow-action.inferred,.rt-ap-act.inferred{font-style:normal}
@media (prefers-reduced-motion:reduce){.dshp-btn,.dshp-bar>i,.dshp-flow-node{transition:opacity 300ms var(--dshp-ease)}.dshp-btn:hover:not(:disabled),.dshp-flow-node.is-cur{transform:none}.dshp-skel{animation:none}}

.dshp-dock{position:fixed;top:12px;right:12px;z-index:10050;display:flex;flex-direction:column;width:var(--dshp-dock-w,620px);height:var(--dshp-dock-h,72vh);min-width:380px;min-height:320px;max-width:calc(100vw - 16px);max-height:calc(100vh - 16px);box-sizing:border-box;background:color-mix(in srgb,var(--dsw-alias-bg-layer-1,var(--dshp-paper,#fffcf7)) 52%,transparent);backdrop-filter:blur(22px) saturate(1.35);-webkit-backdrop-filter:blur(22px) saturate(1.35);border:1px solid color-mix(in srgb,var(--dsw-alias-border-l1,var(--dshp-line,#555)) 65%,transparent);border-radius:12px;box-shadow:0 18px 48px color-mix(in srgb,#000 30%,transparent),0 0 0 1px color-mix(in srgb,#fff 6%,transparent);pointer-events:auto;color:var(--dsw-alias-label-primary,var(--dshp-ink,#f2f2f2));overflow:visible}
.dshp-dock[data-open="0"]{display:none}
.dshp-launch{position:fixed;right:16px;bottom:16px;z-index:10040;appearance:none;display:inline-flex;align-items:center;gap:6px;height:36px;padding:0 14px;border:1px solid color-mix(in srgb,var(--dsw-alias-brand-primary,#6dbf8c) 55%,transparent);border-radius:999px;background:color-mix(in srgb,var(--dsw-alias-bg-layer-1,#fffcf7) 46%,transparent);color:var(--dsw-alias-label-primary,#16140f);cursor:pointer;font:13px/1 inherit;box-shadow:0 8px 22px color-mix(in srgb,#000 28%,transparent);pointer-events:auto}
.dshp-launch:hover{border-color:var(--dsw-alias-brand-primary,#6dbf8c);background:color-mix(in srgb,var(--dsw-alias-brand-primary,#6dbf8c) 18%,transparent)}
.dshp-launch[data-open="1"],.dshp-launch[data-hide="1"]{display:none}
.dshp-dock-head{display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid color-mix(in srgb,var(--dsw-alias-border-l1,var(--dshp-line,#555)) 55%,transparent);background:transparent;cursor:grab;user-select:none;touch-action:none;color:var(--dsw-alias-label-primary,var(--dshp-ink,#f2f2f2));border-radius:12px 12px 0 0}
.dshp-dock-head:active{cursor:grabbing}
.dshp-dock-head b{font-size:14px;font-weight:600;color:inherit;text-shadow:0 1px 0 color-mix(in srgb,#000 18%,transparent)}
.dshp-dock-head button{cursor:pointer;color:inherit;background:color-mix(in srgb,var(--dsw-alias-bg-layer-2,rgba(127,127,127,.18)) 55%,transparent)}
.dshp-dock-tabs{display:flex;gap:8px;padding:0 12px;border-bottom:1px solid color-mix(in srgb,var(--dsw-alias-border-l1,var(--dshp-line,#555)) 55%,transparent);background:transparent}
.dshp-dock-tab{appearance:none;border:0;border-bottom:2px solid transparent;background:transparent;color:var(--dsw-alias-label-secondary,var(--dshp-mute,#b8b4ac));border-radius:0;padding:8px 12px;margin-bottom:-1px;cursor:pointer;font:13px/1.2 inherit;text-shadow:0 1px 0 color-mix(in srgb,#000 12%,transparent)}
.dshp-dock-tab:hover{color:var(--dsw-alias-label-primary,var(--dshp-ink,#f2f2f2))}
.dshp-dock-tab.on{color:var(--dsw-alias-label-primary,var(--dshp-ink,#f2f2f2));font-weight:600;border-bottom-color:var(--dsw-alias-brand-primary,#6dbf8c);background:transparent}
.dshp-dock-body{flex:1;min-height:0;overflow:hidden;display:flex;flex-direction:column;background:transparent;border-radius:0 0 12px 12px}
.dshp-dock-body .dshp-root{max-width:none;height:100%;flex:1;min-height:0;overflow:auto;background:transparent!important;padding:12px;gap:12px}
.dshp-dock-body .dshp-panel{padding:12px}
.dshp-dock-body .dshp-head{margin-bottom:12px}
.dshp-dock-body .dshp-sub{margin:16px 0 8px}
.dshp-dock-body .dshp-metrics{margin-bottom:12px}
.dshp-dock-body .dshp-panel,.dshp-dock-body .dshp-metric,.dshp-dock-body .dshp-group,.dshp-dock-body .dshp-editor,.dshp-dock-body .dshp-active,.dshp-dock-body .dshp-ask,.dshp-dock-body .dshp-create,.dshp-dock-body .dshp-rulelist,.dshp-dock-body .dshp-cwd-list{background:var(--dshp-paper)!important;border-color:var(--dshp-line)!important;color:var(--dshp-ink)!important;box-shadow:inset 0 1px 0 var(--dshp-hi);backdrop-filter:var(--dshp-glass);-webkit-backdrop-filter:var(--dshp-glass)}
.dshp-dock-body .dshp-field,.dshp-dock-body .dshp-area{background:color-mix(in srgb,var(--dsw-alias-bg-layer-1,#fff) 38%,transparent)!important;color:var(--dshp-ink)!important;border-color:var(--dshp-line)!important}
.dshp-dock-body select.dshp-field,.dshp-dock-body .dshp-field.dshp-ver{background:var(--dsw-alias-bg-layer-1,#fff)!important;color:var(--dshp-ink)!important;color-scheme:inherit}
.dshp-dock[data-theme="white"] select.dshp-field option,.dshp-dock[data-theme="white"] .dshp-field.dshp-ver option{background:#fff;color:#16140f}
.dshp-dock[data-theme="dusk"] select.dshp-field option,.dshp-dock[data-theme="dusk"] .dshp-field.dshp-ver option{background:#1b1d22;color:#f4f1ea}
.dshp-dock-body .dshp-title,.dshp-dock-body .dshp-sub h4,.dshp-dock-body .dshp-group-h strong,.dshp-dock-body .dshp-metric b,.dshp-dock-body .dshp-rule-name{font-family:inherit;font-weight:650;letter-spacing:0;color:var(--dshp-ink)!important;text-shadow:none}
.dshp-dock-body .dshp-mute,.dshp-dock-body .dshp-kicker,.dshp-dock-body .dshp-metric span,.dshp-dock-body .dshp-group-h em,.dshp-dock-body .dshp-count,.dshp-dock-body .dshp-rule-meta,.dshp-dock-body .dshp-hint{color:var(--dshp-mute)!important;font-weight:500;text-shadow:none}
.dshp-dock-body .rt-dock{position:relative;inset:auto;width:100%!important;height:100%;max-width:none!important;flex:1;min-height:0;min-width:0;display:flex!important;flex-direction:column;box-shadow:none;border:0;transform:none!important;opacity:1!important;pointer-events:auto!important;background:transparent!important}
.dshp-dock-body .rt-grip{display:none!important}
.dshp-dock-body .rt-embedded>.rt-head,.dshp-dock-body .rt-tabs,.dshp-dock-body .rt-foot{flex:none}
.dshp-dock-body .rt-body{flex:1;min-height:0;overflow:hidden!important;background:transparent!important}
.dshp-dock-body .rt-main{min-height:0;flex:1;overflow:hidden}
.dshp-dock-body .rt-pane{min-height:0;overflow:auto!important}
.dshp-dock-body .rt-embedded>.rt-head{padding:8px 12px}
.dshp-dock-body .rt-embedded>.rt-head .rt-title{font-size:14px;letter-spacing:0}
.dshp-dock-body .rt-tabs{gap:8px;padding:0 12px;flex-wrap:wrap}
.dshp-dock-body .rt-tab{border-radius:0;border-bottom:2px solid transparent;margin-bottom:-1px;padding:8px 12px;background:transparent;font-size:14px}
.dshp-dock-body .rt-tab.on{border-bottom-color:var(--dsw-alias-brand-primary,#6d8f78);background:transparent;font-weight:650}
.dshp-dock-body .rt-row:hover,.dshp-dock-body .rt-item:hover,.dshp-dock-body .rt-item.on,.dshp-dock-body .rt-seg:hover,.dshp-dock-body .rt-seg.on,.dshp-dock-body .rt-vrow:hover,.dshp-dock-body .rt-score-row:hover{background:var(--rt-surf-2)!important}
body:not([data-ds-dark-theme]) .dshp-auth-modal{background:color-mix(in srgb,var(--dsw-alias-bg-layer-1,#fffcf7) 46%,transparent);color:var(--dsw-alias-label-primary,#1a1916);border-color:color-mix(in srgb,var(--dsw-alias-brand-primary,#6d8f78) 34%,transparent);backdrop-filter:blur(22px) saturate(1.4);-webkit-backdrop-filter:blur(22px) saturate(1.4);box-shadow:inset 0 1px 0 color-mix(in srgb,#fff 48%,transparent)}
body:not([data-ds-dark-theme]) .dshp-auth-legal{background:color-mix(in srgb,var(--dsw-alias-bg-layer-2,#f3f0e8) 90%,transparent);color:var(--dsw-alias-label-primary,#1a1916);border-color:color-mix(in srgb,var(--dsw-alias-border-l1,#c9c3b6) 80%,transparent)}
body:not([data-ds-dark-theme]) .dshp-auth-warn{background:color-mix(in srgb,#f5e6c8 88%,transparent);color:#6b4a10}
body:not([data-ds-dark-theme]) .dshp-auth-ops button{border-color:var(--dsw-alias-border-l1,#c9c3b6);color:var(--dsw-alias-label-primary,#1a1916);background:color-mix(in srgb,var(--dsw-alias-bg-layer-1,#fff) 88%,transparent)}
body:not([data-ds-dark-theme]) .dshp-auth-ops button.primary{background:var(--dsw-alias-brand-primary,#3f6b52);border-color:var(--dsw-alias-brand-primary,#3f6b52);color:#fff}
.dshp-dock-resize,.dshp-dock-resize-l,.dshp-dock-resize-r,.dshp-dock-resize-b{position:absolute;z-index:60;pointer-events:auto;touch-action:none}
.dshp-dock-resize{right:0;bottom:0;width:22px;height:22px;cursor:nwse-resize;background:linear-gradient(135deg,transparent 46%,color-mix(in srgb,var(--dsw-alias-brand-primary,#6dbf8c) 75%,transparent) 46%);border-radius:0 0 12px 0;opacity:.95}
.dshp-dock-resize-l{left:-2px;top:0;bottom:0;width:10px;cursor:ew-resize;background:color-mix(in srgb,var(--dsw-alias-brand-primary,#6dbf8c) 18%,transparent)}
.dshp-dock-resize-l:hover,.dshp-dock-resize-r:hover{background:color-mix(in srgb,var(--dsw-alias-brand-primary,#6dbf8c) 42%,transparent)}
.dshp-dock-resize-r{right:-2px;top:0;bottom:22px;width:10px;cursor:ew-resize;background:transparent}
.dshp-dock-resize-b{left:10px;right:22px;bottom:-2px;height:10px;cursor:ns-resize;background:transparent}
.dshp-dock-resize-b:hover{background:color-mix(in srgb,var(--dsw-alias-brand-primary,#6dbf8c) 35%,transparent)}
.dshp-auth-mask{position:fixed;inset:0;z-index:10100;background:rgba(0,0,0,.62);display:flex;align-items:center;justify-content:center;padding:20px;pointer-events:auto}
.dshp-env-gate{z-index:10200}
.dshp-auth-modal{width:min(680px,100%);max-height:min(88vh,820px);display:flex;flex-direction:column;gap:12px;padding:16px;border:1px solid color-mix(in srgb,var(--dsw-alias-brand-primary,#6d8f78) 34%,transparent);border-radius:16px;background:color-mix(in srgb,var(--dsw-alias-bg-layer-1,#1c1e24) 42%,transparent);color:var(--dsw-alias-label-primary,#eee);backdrop-filter:blur(22px) saturate(1.4);-webkit-backdrop-filter:blur(22px) saturate(1.4);box-shadow:inset 0 1px 0 color-mix(in srgb,#fff 10%,transparent)}
.dshp-auth-modal h2{margin:0;font-size:16px;font-weight:600}
.dshp-auth-warn{padding:8px 10px;border-radius:8px;background:#3a2e18;color:#f0d48a;font-size:13px}
.dshp-auth-legal{overflow:auto;height:300px;margin:0;padding:12px;border:1px solid var(--dshp-line,var(--dsw-alias-border-l1,#333));border-radius:8px;background:var(--dshp-paper,color-mix(in srgb,var(--dsw-alias-bg-layer-1,#1c1e24) 42%,transparent));font-size:13px;line-height:1.55}
.dshp-auth-legal h3{margin:12px 0 4px;font-size:13px}
.dshp-auth-legal h3:first-child{margin-top:0}
.dshp-auth-legal p{margin:0 0 8px}
.dshp-auth-checks{display:flex;flex-direction:column;gap:8px;font-size:13px}
.dshp-auth-checks label{display:flex;gap:8px;align-items:flex-start}
.dshp-auth-checks label.locked{opacity:.45}
.dshp-auth-ops{display:flex;justify-content:flex-end;gap:8px}
.dshp-auth-ops button,.dshp-dock-head button{appearance:none;border:1px solid var(--dsw-alias-border-l1,#444);background:transparent;color:inherit;border-radius:8px;padding:6px 12px;cursor:pointer;font:inherit}
.dshp-auth-ops button.primary{background:#2a4033;border-color:#8fbf9a}
.dshp-auth-ops button:disabled{opacity:.45;cursor:default}
.dshp-icon-btn{appearance:none;display:inline-flex;align-items:center;gap:6px;height:32px;padding:0 10px;border:1px solid color-mix(in srgb,var(--dsw-alias-brand-primary,#6dbf8c) 45%,transparent);border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary,currentColor);cursor:pointer;font:13px/1 inherit;white-space:nowrap;flex:0 0 auto}
.dshp-icon-btn:hover{border-color:var(--dsw-alias-brand-primary,#6dbf8c);background:color-mix(in srgb,var(--dsw-alias-brand-primary,#6dbf8c) 12%,transparent);color:var(--dsw-alias-label-primary,currentColor)}
.dshp-icon-btn.on{border-color:var(--dsw-alias-brand-primary,#6dbf8c);color:var(--dsw-alias-brand-primary,#6dbf8c);background:color-mix(in srgb,var(--dsw-alias-brand-primary,#6dbf8c) 16%,transparent);box-shadow:0 0 0 1px color-mix(in srgb,var(--dsw-alias-brand-primary,#6dbf8c) 28%,transparent)}
.dshp-hbtn{appearance:none;display:inline-flex;flex:0 0 auto;align-items:center;gap:6px;border:1px solid color-mix(in srgb,var(--dsw-alias-brand-primary,#6dbf8c) 55%,transparent);background:transparent;color:var(--dsw-alias-label-secondary,currentColor);cursor:pointer;font:12px/1 inherit;padding:5px 10px;border-radius:8px;white-space:nowrap}
.dshp-hbtn:hover{border-color:var(--dsw-alias-brand-primary,#6dbf8c);background:color-mix(in srgb,var(--dsw-alias-brand-primary,#6dbf8c) 12%,transparent);color:var(--dsw-alias-label-primary,currentColor)}
.dshp-hbtn.on{border-color:var(--dsw-alias-brand-primary,#6dbf8c);color:var(--dsw-alias-brand-primary,#6dbf8c);background:color-mix(in srgb,var(--dsw-alias-brand-primary,#6dbf8c) 18%,transparent);box-shadow:0 0 0 1px color-mix(in srgb,var(--dsw-alias-brand-primary,#6dbf8c) 32%,transparent)}
.dshp-live-dot{width:7px;height:7px;border-radius:50%;flex:none;background:var(--dsw-alias-brand-primary,#6dbf8c);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-brand-primary,#6dbf8c) 28%,transparent)}
.dshp-hero-chip{display:inline-flex;align-items:center;margin-left:6px;flex:0 0 auto}
.dshp-hero-chip-btn{appearance:none;display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 12px;border:1px solid color-mix(in srgb,var(--dsw-alias-brand-primary,#6dbf8c) 50%,transparent);border-radius:999px;background:color-mix(in srgb,var(--dsw-alias-brand-primary,#6dbf8c) 10%,transparent);color:var(--dsw-alias-label-primary,currentColor);cursor:pointer;font:12.5px/1 inherit;white-space:nowrap}
.dshp-hero-chip-btn:hover{border-color:var(--dsw-alias-brand-primary,#6dbf8c);background:color-mix(in srgb,var(--dsw-alias-brand-primary,#6dbf8c) 18%,transparent)}
.dshp-hero-chip-btn.on{border-color:var(--dsw-alias-brand-primary,#6dbf8c);color:var(--dsw-alias-brand-primary,#6dbf8c);background:color-mix(in srgb,var(--dsw-alias-brand-primary,#6dbf8c) 18%,transparent);box-shadow:0 0 0 1px color-mix(in srgb,var(--dsw-alias-brand-primary,#6dbf8c) 32%,transparent)}
.dshp-tab-chip{display:inline-flex;align-items:flex-end;flex:0 0 auto}
.dshp-tab-btn{appearance:none;position:relative;border:none;background:transparent;cursor:pointer;padding:0 0 9px;font:500 13px/16px inherit;color:var(--dsw-alias-label-tertiary,currentColor);white-space:nowrap}
.dshp-tab-btn:hover{color:var(--dsw-alias-label-primary,currentColor)}
.dshp-tab-btn.on{color:var(--dsw-alias-brand-primary,#6dbf8c)}
.dshp-tab-btn.on:after{content:"";position:absolute;left:0;right:0;bottom:-1px;height:2px;border-radius:2px;background:var(--dsw-alias-brand-primary,#6dbf8c)}
/* 호스트 툴바 버튼은 아이콘 폰트 / font-size:0 / color:transparent 를 상속받는 경우가 있어, 글자가 DOM 에는 있지만 보이지 않는다(#169). */
.dshp-hero-chip-btn,.dshp-tab-btn,.dshp-launch,.dshp-icon-btn,.dshp-hbtn,.dshp-btn,.dshp-dock-tab,.dshp-dock-head button,.dshp-auth-ops button,.dshp-switch button{
  font-family:system-ui,-apple-system,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei","Noto Sans SC",sans-serif!important;
  -webkit-text-fill-color:currentColor!important;
  text-indent:0!important;
  letter-spacing:normal!important;
  overflow:visible!important;
  text-overflow:clip!important;
  width:auto!important;
  max-width:none!important;
}
.dshp-hero-chip-btn{
  font-size:12.5px!important;
  line-height:1!important;
  font-weight:600!important;
  color:#1a1916!important;
  -webkit-text-fill-color:#1a1916!important;
  min-width:max-content!important;
  height:28px!important;
  padding:0 12px!important;
}
.dshp-hero-chip-btn.on{color:#2f6b4f!important;-webkit-text-fill-color:#2f6b4f!important}
body[data-ds-dark-theme] .dshp-hero-chip-btn,.dshp-dock[data-theme="dusk"] .dshp-hero-chip-btn{color:#f4f1ea!important;-webkit-text-fill-color:#f4f1ea!important}
body[data-ds-dark-theme] .dshp-hero-chip-btn.on,.dshp-dock[data-theme="dusk"] .dshp-hero-chip-btn.on{color:#6dbf8c!important;-webkit-text-fill-color:#6dbf8c!important}
.dshp-tab-btn{font-size:13px!important;line-height:16px!important;font-weight:500!important;color:#5c564c!important;-webkit-text-fill-color:#5c564c!important;padding:0 4px 9px!important}
.dshp-tab-btn.on{color:#2f6b4f!important;-webkit-text-fill-color:#2f6b4f!important}
body[data-ds-dark-theme] .dshp-tab-btn{color:#c9c3b8!important;-webkit-text-fill-color:#c9c3b8!important}
body[data-ds-dark-theme] .dshp-tab-btn.on{color:#6dbf8c!important;-webkit-text-fill-color:#6dbf8c!important}
.dshp-launch{font-size:13px!important;line-height:1!important;font-weight:600!important;min-width:max-content!important}
.dshp-btn{font-size:16px!important;line-height:24px!important;font-weight:600!important}
.dshp-btn-primary{color:#fff!important;-webkit-text-fill-color:#fff!important}
.dshp-btn-tiny{font-size:14px!important;line-height:20px!important}
/* Glass follows the host color. Weight and background opacity are kept separate: the shell is translucent, the text sits on a more solid layer. */
.dshp-dock{font-family:inherit;font-size:14px;line-height:1.6;font-weight:500;-webkit-font-smoothing:antialiased;text-shadow:none}
.dshp-dock[data-theme="white"],.dshp-dock[data-theme="dusk"]{backdrop-filter:blur(22px) saturate(1.4)!important;-webkit-backdrop-filter:blur(22px) saturate(1.4)!important;color:var(--dshp-ink)!important;border:1px solid color-mix(in srgb,var(--dsw-alias-brand-primary,#6d8f78) 34%,transparent)!important;--dshp-glass:blur(18px) saturate(1.35);--dshp-accent:var(--dsw-alias-brand-primary,#3d8f68);--dshp-fill:color-mix(in srgb,var(--dsw-alias-brand-primary,#6dbf8c) 14%,transparent)}
.dshp-dock[data-theme="white"]{background:color-mix(in srgb,var(--dsw-alias-bg-layer-1,#fffcf7) 46%,transparent)!important;--dshp-paper:color-mix(in srgb,var(--dsw-alias-bg-layer-1,#fffcf7) 46%,transparent);--dshp-line:color-mix(in srgb,var(--dsw-alias-brand-primary,#6d8f78) 34%,transparent);--dshp-hi:color-mix(in srgb,#fff 48%,transparent);--dshp-ink:var(--dsw-alias-label-primary,#16140f);--dshp-mute:color-mix(in srgb,var(--dsw-alias-label-primary,#16140f) 76%,var(--dsw-alias-label-secondary,#3c362e));--dshp-ok:#2f6b4f;--dshp-warn:#8a5a12;--dshp-bad:#9a3434;box-shadow:inset 0 1px 0 color-mix(in srgb,#fff 48%,transparent),0 16px 40px color-mix(in srgb,#000 16%,transparent)!important}
.dshp-dock[data-theme="dusk"]{background:color-mix(in srgb,var(--dsw-alias-bg-layer-1,#1c1e24) 42%,transparent)!important;--dshp-paper:color-mix(in srgb,var(--dsw-alias-bg-layer-1,#1c1e24) 42%,transparent);--dshp-line:color-mix(in srgb,var(--dsw-alias-brand-primary,#6dbf8c) 32%,transparent);--dshp-hi:color-mix(in srgb,#fff 10%,transparent);--dshp-ink:var(--dsw-alias-label-primary,#f4f1ea);--dshp-mute:color-mix(in srgb,var(--dsw-alias-label-primary,#f4f1ea) 84%,var(--dsw-alias-label-secondary,#c9c3b8));--dshp-ok:#8fd0a8;--dshp-warn:#e4c48a;--dshp-bad:#f0b4b4;box-shadow:inset 0 1px 0 color-mix(in srgb,#fff 10%,transparent),0 16px 40px color-mix(in srgb,#000 28%,transparent)!important}
.dshp-dock .dshp-dock-head,.dshp-dock .dshp-dock-tabs{background:transparent!important;color:var(--dshp-ink)!important}
.dshp-dock .dshp-dock-head,.dshp-dock .dshp-dock-head b,.dshp-dock .dshp-dock-head button,.dshp-dock .dshp-dock-tab,.dshp-dock .dshp-dock-tab.on{color:var(--dshp-ink)!important;text-shadow:none!important;font-weight:600}
.dshp-dock .dshp-dock-tab{font-size:14px}
.dshp-dock .dshp-dock-tab.on{border-bottom-color:var(--dsw-alias-brand-primary,#6d8f78)!important}
.dshp-dock-body .rt-dock{font-size:14px!important;line-height:1.6!important;font-weight:500!important;color:var(--dshp-ink)!important;--rt-ink:var(--dshp-ink);--rt-mute:var(--dshp-mute);--rt-paper:var(--dshp-paper);--rt-paper-2:color-mix(in srgb,var(--dsw-alias-bg-layer-1,#fffcf7) 28%,transparent);--rt-well:color-mix(in srgb,var(--dsw-alias-bg-layer-1,#fff) 32%,transparent);--rt-fill:var(--dshp-fill);--rt-surf:var(--dshp-paper);--rt-surf-2:var(--dshp-fill);--rt-line:var(--dshp-line);--rt-hi:var(--dshp-hi);--rt-glass:var(--dshp-glass);--rt-accent:var(--dshp-accent);--rt-ok:var(--dshp-ok);--rt-warn:var(--dshp-warn);--rt-bad:var(--dshp-bad)}
.dshp-dock[data-theme="dusk"] .dshp-dock-body .rt-dock{--rt-paper-2:color-mix(in srgb,var(--dsw-alias-bg-layer-1,#1c1e24) 28%,transparent);--rt-well:color-mix(in srgb,var(--dsw-alias-bg-layer-1,#1c1e24) 26%,transparent)}
body[data-ds-dark-theme] .dshp-launch{background:color-mix(in srgb,var(--dsw-alias-bg-layer-1,#1c1e24) 42%,transparent);color:var(--dsw-alias-label-primary,#f4f1ea)}
.dshp-dock-body .rt-title,.dshp-dock-body .rt-tab,.dshp-dock-body .rt-tab.on,.dshp-dock-body .rt-card,.dshp-dock-body .rt-card h4,.dshp-dock-body .rt-row,.dshp-dock-body .rt-vrow,.dshp-dock-body .rt-kv,.dshp-dock-body .rt-kv b,.dshp-dock-body .rt-kv span,.dshp-dock-body .rt-mono,.dshp-dock-body .rt-empty,.dshp-dock-body .rt-foot,.dshp-dock-body .rt-tag,.dshp-dock-body .rt-item,.dshp-dock-body .rt-item-name,.dshp-dock-body .rt-item-desc,.dshp-dock-body .rt-sec-sub,.dshp-dock-body .rt-kb-sub,.dshp-dock-body .rt-seg-cidr,.dshp-dock-body .rt-seg-meta,.dshp-dock-body .rt-section,.dshp-dock-body .rt-note,.dshp-dock-body .rt-hint{color:var(--dshp-ink)!important;text-shadow:none!important;opacity:1!important}
.dshp-dock-body .rt-tab,.dshp-dock-body .rt-foot,.dshp-dock-body .rt-empty,.dshp-dock-body .rt-item-desc,.dshp-dock-body .rt-kb-sub,.dshp-dock-body .rt-kv span,.dshp-dock-body .rt-tag,.dshp-dock-body .rt-sec-sub{color:var(--dshp-mute)!important}
.dshp-dock-body .rt-card,.dshp-dock-body .rt-sess,.dshp-dock-body .rt-hit,.dshp-dock-body .rt-cred,.dshp-dock-body .rt-evi,.dshp-dock-body .rt-kb,.dshp-dock-body .rt-rep,.dshp-dock-body .rt-flow-node,.dshp-dock-body .rt-hcol{background:var(--dshp-paper)!important;border-color:var(--dshp-line)!important;color:var(--dshp-ink)!important;box-shadow:inset 0 1px 0 var(--dshp-hi)!important;backdrop-filter:var(--dshp-glass);-webkit-backdrop-filter:var(--dshp-glass)}
.dshp-dock-body .rt-pane,.dshp-dock-body .rt-side,.dshp-dock-body .rt-list,.dshp-dock-body .rt-table,.dshp-dock-body .rt-toolbar,.dshp-dock-body .rt-embedded>.rt-head,.dshp-dock-body .rt-tabs,.dshp-dock-body .rt-foot,.dshp-dock-body .rt-livebar,.dshp-dock-body .rt-concl{background:transparent!important;box-shadow:none!important}
.dshp-dock-body .rt-btn,.dshp-dock-body .rt-input,.dshp-dock-body .rt-eng-select,.dshp-dock-body textarea.rt-input,.dshp-dock-body .rt-textarea,.dshp-dock-body .rt-code,.dshp-dock-body .rt-evi-body{background:var(--rt-well)!important;color:var(--dshp-ink)!important;border-color:var(--dshp-line)!important;backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px)}
.dshp-dock-body .rt-btn-primary{background:var(--dsw-alias-brand-primary,#3f6b52)!important;border-color:var(--dsw-alias-brand-primary,#3f6b52)!important;color:#fff!important}
.dshp-dock[data-theme="white"] .dshp-dock-body .rt-eng-select option,.dshp-dock[data-theme="white"] .dshp-dock-body .rt-input option{background:#fff;color:#16140f}
.dshp-dock[data-theme="dusk"] .dshp-dock-body .rt-eng-select option,.dshp-dock[data-theme="dusk"] .dshp-dock-body .rt-input option{background:#1b1d22;color:#f4f1ea}
.dshp-dock-body .rt-err{font-weight:650}
.dshp-dock[data-theme="white"] .dshp-dock-body .rt-err{color:#9a3434!important}
.dshp-dock[data-theme="dusk"] .dshp-dock-body .rt-err{color:#f0b4b4!important}
.dshp-dock-body .rt-rep-http,.dshp-dock-body pre{background:var(--rt-well)!important;color:var(--dshp-ink)!important;border:1px solid var(--dshp-line)!important}
/* #196: 어두운 호스트에서 --dsw-alias-brand-primary 가 거의 흰색(neutral-bluish-50 #f9fafb)으로 해석되어,
   '브랜드 색 배경 + 흰 글자' 버튼이 모두 흰 배경 흰 글자가 된다. 어두운 테마에서는 주요 버튼을 초록 단색으로 통일한다. */
body[data-ds-dark-theme] .dshp-btn-primary,
.dshp-root[data-theme="dusk"] .dshp-btn-primary,
.dshp-dock[data-theme="dusk"] .dshp-btn-primary,
.dshp-restart-mask[data-theme="dusk"] .dshp-btn-primary{background:#3d8f68!important;border-color:#3d8f68!important;color:#fff!important;-webkit-text-fill-color:#fff!important}
body[data-ds-dark-theme] .dshp-btn-primary:hover:not(:disabled),
.dshp-root[data-theme="dusk"] .dshp-btn-primary:hover:not(:disabled),
.dshp-dock[data-theme="dusk"] .dshp-btn-primary:hover:not(:disabled),
.dshp-restart-mask[data-theme="dusk"] .dshp-btn-primary:hover:not(:disabled){background:#347a59!important;border-color:#347a59!important;color:#fff!important;-webkit-text-fill-color:#fff!important}
body[data-ds-dark-theme] .rt-btn-primary,
body[data-ds-dark-theme] .rt-btn-primary:hover:not(:disabled),
.dshp-dock[data-theme="dusk"] .rt-btn-primary,
.dshp-dock[data-theme="dusk"] .rt-btn-primary:hover:not(:disabled),
body[data-ds-dark-theme] .dshp-dock-body .rt-btn-primary,
.dshp-dock[data-theme="dusk"] .dshp-dock-body .rt-btn-primary{background:#3d8f68!important;border-color:#3d8f68!important;color:#fff!important;-webkit-text-fill-color:#fff!important;backdrop-filter:none}
body[data-ds-dark-theme] .rt-rep-step-no,.dshp-dock[data-theme="dusk"] .rt-rep-step-no{background:#3d8f68;color:#fff}
`;

		function formatSize(bytes) {
			if (typeof bytes !== "number" || !isFinite(bytes) || bytes < 0) return "0 B";
			if (bytes < 1024) return bytes + " B";
			const kb = bytes / 1024;
			return (kb >= 100 ? Math.round(kb) : kb.toFixed(1)) + " KB";
		}

		function statusKind(st) {
			if (st === "applied" || st === "already") return "ok";
			if (st === "pending") return "wait";
			if (st === "unmatched") return "bad";
			if (st === "drifted") return "bad";
			if (st === "na") return "ok";
			if (st === "missing_file" || st === "skipped" || st === "unlocated" || st === "off") return "miss";
			return "bad";
		}

		function statusLabel(st, t) {
			if (st === "applied" || st === "already") return t("status.applied");
			if (st === "off") return t("status.skipped");
			if (st === "pending") return t("status.pending");
			if (st === "unmatched") return t("status.unmatched");
			if (st === "drifted") return t("status.drifted");
			if (st === "skipped") return t("status.skipped");
			if (st === "missing_file") return t("skip");
			if (st === "unlocated") return t("status.unlocated");
			if (st === "na") return t("status.na");
			return st || t("unknown");
		}

		function shimKind(v) {
			if (v === "patched" || v === "n/a") return "ok";
			if (v === "original") return "wait";
			if (v === "missing" || !v) return "miss";
			return "bad";
		}

		function noticeNode(notice) {
			if (!notice || notice.kind === "idle" || !notice.text) return null;
			return h("span", { className: "dshp-notice " + (notice.kind === "error" ? "is-bad" : "is-ok") }, notice.text);
		}

		function Btn(props) {
			const { kind, tiny, children, className, type, ...rest } = props;
			const cls = ["dshp-btn", kind ? "dshp-btn-" + kind : "dshp-btn-ghost", tiny ? "dshp-btn-tiny" : "", className || ""].filter(Boolean).join(" ");
			return h("button", Object.assign({ type: type || "button", className: cls }, rest), children);
		}

		const FLOW_STEPS = {
			apply: ["home", "locate", "override", "patch", "shim", "flash", "seed", "done"],
			revert: ["locate", "revert", "shim", "done"],
			uninstall: ["locate", "revert", "shim", "flash", "cleanup", "done"],
		};

		function flowLabel(id, t) {
			if (id === "revert") return t("flow.revert.step");
			if (id === "cleanup") return t("flow.cleanup");
			return t("flow." + id);
		}

		function ApplyFlow({ progress, busy, t }) {
			const kind = (progress && progress.kind) || "apply";
			const steps = FLOW_STEPS[kind] || FLOW_STEPS.apply;
			const stage = (progress && progress.stage) || "idle";
			const failed = Boolean(progress && progress.error);
			const active = Boolean(busy || (progress && progress.active));
			const idx = steps.indexOf(stage === "restart" ? "done" : stage);
			return h("div", {
				className: "dshp-flow" + (active ? " is-on" : "") + (failed ? " is-bad" : ""),
				"aria-label": t("flow.title"),
			},
				h("span", { className: "dshp-flow-kind" }, t("flow." + kind)),
				steps.flatMap((id, i) => {
					const done = idx > i || (stage === "done" && !failed);
					const cur = active && idx === i && stage !== "idle";
					const bad = failed && idx === i;
					const nodes = [];
					if (i) {
						nodes.push(h("span", {
							key: "w-" + id,
							className: "dshp-flow-wire" + (done || cur ? " is-on" : ""),
						}, h("i")));
					}
					nodes.push(h("span", {
						key: id,
						className: "dshp-flow-node" + (done ? " is-done" : "") + (cur ? " is-cur" : "") + (bad ? " is-bad" : ""),
					},
						h("b", null, String(i + 1)),
						h("em", null, flowLabel(id, t)),
					));
					return nodes;
				}),
			);
		}

		function Pill({ value, label }) {
			const t = useT();
			return h("span", { className: "dshp-pill is-" + statusKind(value) }, label || statusLabel(value, t));
		}

		const LAYER_GROUP = {
			"Prompt": "prompt",
			"Code": "code",
			"Tools": "tools",
			"0.1.5 compat": "compat",
			"0.2.0 compat": "dsh20",
		};
		const GROUP_ORDER = ["prompt", "code", "tools", "compat", "dsh20"];
		/* The host may report patch layer names in the host locale. The ko dictionary
		 * still keeps those labels, so map them at runtime instead of hardcoding CJK
		 * literals in this file. */
		for (const key of GROUP_ORDER) {
			const label = ko["group." + key];
			if (label && !LAYER_GROUP[label]) LAYER_GROUP[label] = key;
		}
		function layerGroupOf(layer) {
			if (LAYER_GROUP[layer]) return LAYER_GROUP[layer];
			/* ko labels the 0.2.0 layer as "0.2.0" while the host may append a suffix. */
			return String(layer || "").startsWith(ko["group.dsh20"]) ? "dsh20" : "code";
		}

		function patchRowsOf(state) {
			if (!state || !state.ai_base) return [];
			const fromList = Array.isArray(state.patches) ? state.patches : null;
			const rows = fromList
				? fromList.map((p) => ({
					id: Number(p.id),
					ids: Array.isArray(p.ids) && p.ids.length ? p.ids.map(Number) : [Number(p.id)],
					st: p.status || "missing_file",
					layer: p.layer || "",
					title: p.title || "",
				}))
				: Object.keys(state.patch_status || {}).map((id) => ({
					id: Number(id),
					ids: [Number(id)],
					st: state.patch_status[id],
					layer: "",
					title: "",
				}));
			return rows.filter((r) => r.st && r.st !== "na" && Number.isFinite(r.id));
		}

		function patchIdLabel(r) {
			const ids = Array.isArray(r.ids) && r.ids.length ? r.ids : [r.id];
			return ids.map((id) => "#" + id).join("/");
		}

		function patchTitle(t, state, r) {
			if (r && r.title) return r.title;
			const id = r && typeof r === "object" ? r.id : r;
			const key = "patch." + id;
			const hit = t(key);
			if (hit && hit !== key) return hit;
			const names = state && state.patch_names;
			const name = names && (names[id] || names[String(id)]);
			return name || key;
		}

		function tallyPatches(rows) {
			const out = { applied: 0, pending: 0, unmatched: 0, skipped: 0, drifted: 0, total: 0 };
			for (const row of rows || []) {
				out.total += 1;
				if (row.st === "applied" || row.st === "already") out.applied += 1;
				else if (row.st === "pending") out.pending += 1;
				else if (row.st === "unmatched") out.unmatched += 1;
				else if (row.st === "drifted") out.drifted += 1;
				else out.skipped += 1;
			}
			return out;
		}

		function PatchGroups({ state }) {
			const t = useT();
			const [open, setOpen] = useState({});
			if (!state || !state.patch_status) return h("div", { className: "dshp-skel", style: { height: 120 } });
			const located = !!state.ai_base;
			if (!located) return null;
			const grouped = new Map();
			for (const row of patchRowsOf(state)) {
				const key = layerGroupOf(row.layer);
				if (!grouped.has(key)) grouped.set(key, []);
				grouped.get(key).push(row);
			}
			return GROUP_ORDER.filter((key) => grouped.has(key)).map((key) => {
				const rows = grouped.get(key).slice().sort((a, b) => a.id - b.id);
				if (!rows.length) return null;
				const tally = tallyPatches(rows);
				const notes = [];
				if (tally.pending) notes.push(t("metric.pendingShort", { n: tally.pending }));
				if (tally.unmatched) notes.push(t("metric.unmatchedShort", { n: tally.unmatched }));
				if (tally.drifted) notes.push(t("metric.driftedShort", { n: tally.drifted }));
				if (tally.skipped) notes.push(t("metric.skipShort", { n: tally.skipped }));
				const expanded = !!open[key];
				return h("div", { key: key, className: "dshp-group" },
					h("button", {
						type: "button",
						className: "dshp-group-h",
						"aria-expanded": expanded ? "true" : "false",
						onClick: () => setOpen((prev) => Object.assign({}, prev, { [key]: !prev[key] })),
					},
						h("strong", null, t("group." + key)),
						h("span", { className: "dshp-count" }, tally.applied + "/" + tally.total + (notes.length ? " · " + notes.join(" · ") : "")),
					),
					expanded ? h("table", { className: "dshp-table" },
						h("thead", null, h("tr", null,
							h("th", null, "#"),
							h("th", null, t("table.patch")),
							h("th", null, t("table.status")),
						)),
						h("tbody", null, rows.map((r) => h("tr", { key: r.ids ? r.ids.join("-") : r.id },
							h("td", { className: "dshp-id" }, patchIdLabel(r)),
							h("td", null, patchTitle(t, state, r)),
							h("td", null, h(Pill, { value: r.st })),
						))),
					) : null,
				);
			});
		}

		function HooksDenySection({ onSaved }) {
			const t = useT();
			const [cfg, setCfg] = useState(null);
			const [notice, setNotice] = useState({ kind: "idle", text: "" });
			const [busy, setBusy] = useState(false);

			useEffect(() => {
				apiJson("/dsh-purge/hooks-deny")
					.then((d) => { if (d && d.ok) setCfg({ hooksDenyBypass: d.hooksDenyBypass !== false }); })
					.catch(() => {});
			}, []);

			const save = (hooksDenyBypass) => {
				if (!cfg || busy) return;
				setCfg({ hooksDenyBypass });
				setBusy(true);
				apiJson("/dsh-purge/hooks-deny", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ hooksDenyBypass }),
				})
					.then((d) => {
						if (d && d.ok) {
							setCfg({ hooksDenyBypass: d.hooksDenyBypass === true });
							setNotice({ kind: "ok", text: t("saved.hooksDeny") });
							if (typeof onSaved === "function") onSaved();
						} else {
							setNotice({ kind: "error", text: t("err.save", { error: (d && d.error) || "" }) });
						}
					})
					.catch((e) => setNotice({ kind: "error", text: t("err.save", { error: e.message }) }))
					.finally(() => setBusy(false));
			};

			if (!cfg) return null;
			return h("div", { className: "dshp-cr", style: { marginTop: 12 } },
				h("div", { className: "dshp-sub" },
					h("h4", null, t("hooksDeny.title")),
					noticeNode(notice),
				),
				h("p", { className: "dshp-hint", style: { margin: "0 0 4px", color: "var(--dshp-mute)", fontSize: 12 } }, t("hooksDeny.hint")),
				h("div", { className: "dshp-cr-row" },
					h("label", null,
						h("input", {
							type: "checkbox",
							checked: cfg.hooksDenyBypass === true,
							disabled: busy,
							onChange: (e) => save(e.target.checked),
						}),
						t("hooksDeny.bypass"),
					),
				),
			);
		}

		function ContinueRetrySection() {
			const t = useT();
			const [cfg, setCfg] = useState(null);
			const [notice, setNotice] = useState({ kind: "idle", text: "" });
			const [busy, setBusy] = useState(false);

			useEffect(() => {
				apiJson("/dsh-purge/continue/settings")
					.then((d) => { if (d && d.ok) setCfg(d); })
					.catch(() => {});
			}, []);

			const save = (patch) => {
				if (!cfg || busy) return;
				const next = { ...cfg, ...patch };
				if (next.autoRetry && !(Number(next.retryMax) > 0)) next.retryMax = 3;
				if (next.autoContinue && !(Number(next.continueMax) > 0)) next.continueMax = 3;
				setCfg(next);
				setBusy(true);
				apiJson("/dsh-purge/continue/settings", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(next),
				})
					.then((d) => {
						if (d && d.ok) {
							setCfg(d);
							setNotice({ kind: "ok", text: t("saved.continue") });
						} else {
							setNotice({ kind: "error", text: t("err.save", { error: (d && d.error) || "" }) });
						}
					})
					.catch((e) => setNotice({ kind: "error", text: t("err.save", { error: e.message }) }))
					.finally(() => setBusy(false));
			};

			if (!cfg) return null;
			return h("div", { className: "dshp-cr" },
				h("div", { className: "dshp-sub" },
					h("h4", null, t("continue.title")),
					noticeNode(notice),
				),
				h("p", { className: "dshp-hint", style: { margin: "0 0 4px", color: "var(--dshp-mute)", fontSize: 12 } }, t("continue.hint")),
				h("div", { className: "dshp-cr-row" },
					h("label", null,
						h("input", {
							type: "checkbox",
							checked: Boolean(cfg.autoRetry),
							disabled: busy,
							onChange: (e) => save({ autoRetry: e.target.checked }),
						}),
						t("continue.autoRetry"),
					),
					h("label", null,
						t("continue.retryMax"),
						h("input", {
							className: "dshp-field dshp-cr-num",
							type: "number",
							min: 0,
							max: 20,
							value: cfg.retryMax,
							disabled: busy,
							onChange: (e) => save({ retryMax: Number(e.target.value) }),
						}),
					),
				),
				h("div", { className: "dshp-cr-row" },
					h("label", null,
						h("input", {
							type: "checkbox",
							checked: Boolean(cfg.autoContinue),
							disabled: busy,
							onChange: (e) => save({ autoContinue: e.target.checked }),
						}),
						t("continue.autoContinue"),
					),
					h("label", null,
						t("continue.continueMax"),
						h("input", {
							className: "dshp-field dshp-cr-num",
							type: "number",
							min: 0,
							max: 20,
							value: cfg.continueMax,
							disabled: busy,
							onChange: (e) => save({ continueMax: Number(e.target.value) }),
						}),
					),
					h("label", null,
						t("continue.text"),
						h("input", {
							className: "dshp-field dshp-cr-text",
							type: "text",
							value: cfg.continueText || "",
							disabled: busy,
							onChange: (e) => save({ continueText: e.target.value }),
						}),
					),
				),
			);
		}

		function RestartAsk(props) {
			const node = h("div", {
				className: "dshp-restart-mask",
				"data-theme": props.theme === "dusk" ? "dusk" : "white",
				role: "dialog",
				"aria-modal": "true",
				"aria-labelledby": "dshp-restart-title",
				onClick: (e) => { if (e.target === e.currentTarget && props.onLater) props.onLater(); },
			},
				h("div", { className: "dshp-restart-card" },
					h("h4", { id: "dshp-restart-title" }, props.t("restart.ask.title")),
					h("p", null, props.t("restart.ask.body")),
					h("div", { className: "dshp-modal-ops" },
						h(Btn, { onClick: props.onLater }, props.t("restart.notNow")),
						h(Btn, { kind: "primary", onClick: props.onRestart }, props.t("restart.now")),
					),
				),
			);
			try {
				const rd = require("react-dom");
				if (rd && typeof rd.createPortal === "function" && typeof document !== "undefined" && document.body) {
					return rd.createPortal(node, document.body);
				}
			} catch { /* host가 react-dom을 노출하지 않았을 수 있음 */ }
			return node;
		}

		function PurgifySection() {
			const t = useT();
			const tRef = useRef(t);
			tRef.current = t;
			const [state, setState] = useState(null);
			const [override, setOverride] = useState("");
			const [defaultOverride, setDefaultOverride] = useState("");
			const [overrideLoaded, setOverrideLoaded] = useState(false);
			const [ownServers, setOwnServers] = useState("");
			const [ownLoaded, setOwnLoaded] = useState(false);
			const [patchBusy, setPatchBusy] = useState(false);
			const [updateBusy, setUpdateBusy] = useState(false);
			const [canApplyUpdate, setCanApplyUpdate] = useState(false);
			const [updateJob, setUpdateJob] = useState(null);
			const [askRestart, setAskRestart] = useState(false);
			const suppressRestartAsk = useRef(false);
			const [askUninstall, setAskUninstall] = useState(false);
			const [uninstallBusy, setUninstallBusy] = useState(false);
			const [notice, setNotice] = useState({ kind: "idle", text: "" });
			const [updateNotice, setUpdateNotice] = useState({ kind: "idle", text: "" });
			const [updateInfo, setUpdateInfo] = useState(null);
			const [channel, setChannel] = useState("stable");
			const [pick, setPick] = useState({ stable: "", beta: "" });
			const actionTicket = useRef(0);
			const overrideRef = useRef("");
			const defaultOverrideRef = useRef("");
			const promptSeededRef = useRef(false);
			const promptDirtyRef = useRef(false);
			const promptAreaRef = useRef(null);
			overrideRef.current = override;
			defaultOverrideRef.current = defaultOverride;

			const readPromptBox = () => {
				const node = promptAreaRef.current;
				const live = node && typeof node.value === "string" ? node.value : overrideRef.current;
				overrideRef.current = live || "";
				return overrideRef.current;
			};

			const syncPicks = (d) => {
				const versions = (d && d.versions) || [];
				const ceiling = listedCeiling(versions, d && d.localVersion);
				const next = { stable: "", beta: "" };
				for (const id of ["stable", "beta"]) {
					const list = versions.filter((item) => item.channel === id && keepListedVersion(item, ceiling));
					const hit = preferListed(list, d && d.localVersion, d && d.pin);
					next[id] = (hit && hit.ref) || "";
				}
				setPick(next);
			};

			const updateErrorText = (tr, e) => {
				const msg = String((e && e.message) || e || "");
				if (msg === "timeout" || /aborted|abort|초과|\u8d85\u65f6/i.test(msg)) return tr("update.timeout");
				if (/\b404\b/.test(msg) || /non-json/.test(msg)) return tr("update.needRestart");
				return tr("update.fail", { error: msg });
			};

			const applyUpdateInfo = useCallback((d, tr, kind) => {
				if (d.channel) setChannel(d.channel);
				setUpdateInfo((prev) => {
					const versions = (d.versions && d.versions.length) ? d.versions : ((prev && prev.versions) || []);
					return Object.assign({}, prev || {}, d, { versions });
				});
				if (d.versions && d.versions.length) syncPicks(d);
				if (kind === "check") setCanApplyUpdate(Boolean(d.hasUpdate) && !d.error);
				else if (kind === "done" || kind === "switched" || kind === "channel") setCanApplyUpdate(false);
				const version = d.localVersion || d.localSha || "—";
				const remote = d.remoteVersion || d.remoteSha || "—";
				let text = tr("update.latest", { version });
				if (d.hasUpdate) text = tr("update.available", { remote, local: version });
				if (d.pinned && d.hasUpdate) text = tr("update.pinned", { version, remote });
				if (kind === "switched" || kind === "channel") text = tr("update.switched", { version: d.localVersion || d.remoteVersion || "—" });
				if (kind === "done") text = tr("update.done", { version: d.localVersion || d.remoteVersion || "—" });
				if (d.error) text = d.error;
				setUpdateNotice({ kind: d.ok === false || d.error ? "error" : "ok", text });
			}, []);

			const checkUpdate = useCallback((id) => {
				setUpdateBusy(true);
				setUpdateJob({ id: id || "", kind: "check" });
				const tr = tRef.current;
				setUpdateNotice({ kind: "ok", text: tr("update.checking") });
				apiJson("/dsh-purge/update")
					.then((d) => {
						if (!d || (!d.ok && !d.channel)) throw new Error((d && d.error) || "check failed");
						applyUpdateInfo(d, tr, "check");
					})
					.catch((e) => setUpdateNotice({ kind: "error", text: updateErrorText(tr, e) }))
					.finally(() => {
						setUpdateBusy(false);
						setUpdateJob(null);
					});
			}, [applyUpdateInfo]);

			const postUpdate = useCallback((body, kind, id) => {
				setUpdateBusy(true);
				setUpdateJob({ id: id || "", kind });
				const tr = tRef.current;
				setUpdateNotice({ kind: "ok", text: kind === "switched" || kind === "channel" ? tr("update.switching") : tr("update.applying") });
				return apiJson("/dsh-purge/update", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(body || {}),
				})
					.then((d) => {
						if (!d || (d.ok === false && d.error)) throw new Error((d && d.error) || "update failed");
						applyUpdateInfo(d, tr, kind);
						if (d.needsFullQuit) {
							suppressRestartAsk.current = false;
							setAskRestart(true);
							setUpdateNotice({ kind: "ok", text: tr("restart.official.body") });
							return d;
						}
						if (d.restartAfter) {
							setUpdateNotice({ kind: "ok", text: tr("update.restarting") });
							return d;
						}
						if (d.applied && d.reloadClient !== false) {
							setUpdateNotice({ kind: "ok", text: tr("update.reloading") });
							setTimeout(() => {
								try { window.location.reload(); } catch { /* ignore */ }
							}, 280);
						} else if (d.needRestart) {
							setAskRestart(true);
						}
						return d;
					})
					.catch((e) => {
						setUpdateNotice({ kind: "error", text: updateErrorText(tr, e) });
						throw e;
					})
					.finally(() => {
						setUpdateBusy(false);
						setUpdateJob(null);
					});
			}, [applyUpdateInfo]);

			const doUpdate = useCallback((id) => {
				const lane = id === "beta" ? "beta" : "stable";
				postUpdate({ op: "apply", ref: lane === "beta" ? "beta" : "master", channel: lane }, "done", id).catch(() => {});
			}, [postUpdate]);

			const changeChannel = useCallback((next) => {
				if (!next) return;
				const tr = tRef.current;
				if (!window.confirm(tr("update.confirmChannel", { version: tr("channel." + next) }))) return;
				const prevChannel = channel;
				const prevInfo = updateInfo;
				setChannel(next);
				setUpdateInfo((cur) => Object.assign({}, cur || {}, { channel: next }));
				postUpdate({ op: "channel", channel: next }, "channel", next).catch(() => {
					setChannel(prevChannel);
					setUpdateInfo(prevInfo);
				});
			}, [channel, postUpdate, updateInfo]);

			const switchSelected = useCallback((id) => {
				const tr = tRef.current;
				const ref = pick[id];
				const versions = ((updateInfo && updateInfo.versions) || []).filter((item) => item.channel === id);
				const hit = versions.find((item) => item.ref === ref);
				const label = (hit && (hit.label || hit.version)) || ref;
				if (!ref) return;
				if (!window.confirm(tr("update.confirmSwitch", { version: label }))) return;
				const prevChannel = channel;
				const prevInfo = updateInfo;
				if (hit && hit.channel) {
					setChannel(hit.channel);
					setUpdateInfo((cur) => Object.assign({}, cur || {}, { channel: hit.channel }));
				}
				postUpdate({ op: "switch", ref }, "switched", id).catch(() => {
					setChannel(prevChannel);
					setUpdateInfo(prevInfo);
				});
			}, [channel, pick, postUpdate, updateInfo]);

			const loadAll = useCallback(() => {
				const tr = tRef.current;
				apiJson("/dsh-purge/status")
					.then((d) => {
						if (d && d.ok) {
							setState(d);
							if (d.channel) setChannel(d.channel);
							if (d.update && d.update.ok && !d.update.error) setUpdateInfo(d.update);
							if (d.boot_full_quit && !suppressRestartAsk.current) setAskRestart(true);
						} else {
							setState({ ok: false, patches_total: 0, patches_applied: 0, patch_status: {}, shim_cmd: "n/a", shim_ps1: "n/a", shim_bin: "n/a", has_backup: false });
							setNotice({ kind: "error", text: tr("err.status", { error: (d && d.error) || "bad response" }) });
						}
					})
					.catch((e) => {
						setState({ ok: false, patches_total: 0, patches_applied: 0, patch_status: {}, shim_cmd: "n/a", shim_ps1: "n/a", shim_bin: "n/a", has_backup: false });
						setNotice({ kind: "error", text: tr("err.status", { error: e.message }) });
					});
				apiJson("/dsh-purge/update")
					.then((d) => {
						if (!d) return;
						if (d.channel) setChannel(d.channel);
						setUpdateInfo(d);
						syncPicks(d);
					})
					.catch(() => {});
				apiJson("/dsh-purge/override")
					.then((d) => {
						if (d && d.ok) {
							const packed = typeof d.defaultContent === "string" ? d.defaultContent : "";
							const shown = typeof d.content === "string" ? d.content : packed;
							if (packed) setDefaultOverride(packed);
							if (!promptSeededRef.current || !promptDirtyRef.current) {
								promptSeededRef.current = true;
								setOverride(shown || packed);
							}
							setOverrideLoaded(true);
						}
						else setNotice({ kind: "error", text: tr("err.override", { error: (d && d.error) || "" }) });
					})
					.catch((e) => setNotice({ kind: "error", text: tr("err.override", { error: e.message }) }));
				apiJson("/dsh-purge/own-servers")
					.then((d) => {
						if (d && d.ok) {
							setOwnServers(typeof d.content === "string" ? d.content : "");
							setOwnLoaded(true);
						}
					})
					.catch(() => {});
			}, []);

			useEffect(() => {
				loadAll();
				const timer = setTimeout(() => { loadAll(); }, 5000);
				return () => clearTimeout(timer);
			}, [loadAll]);

			useEffect(() => {
				if (!patchBusy && !uninstallBusy) return undefined;
				let stop = false;
				const tick = () => {
					apiJson("/dsh-purge/status")
						.then((d) => {
							if (stop || !d) return;
							if (d.apply_progress) {
								setState((prev) => Object.assign({}, prev || {}, d.ok ? d : { apply_progress: d.apply_progress }));
								return;
							}
							if (!d.ok) return;
							setState((prev) => Object.assign({}, prev || {}, d));
						})
						.catch(() => {});
				};
				tick();
				const id = setInterval(tick, 450);
				return () => {
					stop = true;
					clearInterval(id);
				};
			}, [patchBusy, uninstallBusy]);

			const rejectNeedPrompt = useCallback((tr) => {
				setAskRestart(false);
				setNotice({ kind: "error", text: tr("need.prompt") });
				setTimeout(() => window.alert(tr("need.prompt")), 0);
			}, []);

			const doAction = useCallback((action, actionKey) => {
				const tr = tRef.current;
				const label = tr(actionKey);
				const ticket = ++actionTicket.current;
				const run = () => {
					setPatchBusy(true);
					setAskRestart(false);
					setNotice({ kind: "idle", text: "" });
					setState((prev) => Object.assign({}, prev || {}, {
						apply_progress: {
							active: true,
							kind: action === "revert" ? "revert" : "apply",
							stage: action === "revert" ? "locate" : "home",
							error: "",
						},
					}));
					const applyContent = action === "apply" ? readPromptBox() : "";
					fetch("/dsh-purge/" + action, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify(action === "apply" ? { content: applyContent } : {}),
					})
						.then((r) => r.json())
						.then((d) => {
							if (ticket !== actionTicket.current) return;
							if (responseNeedsPrompt(d)) {
								rejectNeedPrompt(tr);
								return;
							}
							if (!d.ok) {
								setNotice({ kind: "error", text: tr("err.action", { action: label, error: d.error || "" }) });
								return;
							}
							if (action === "apply") {
								if (typeof d.defaultContent === "string") setDefaultOverride(d.defaultContent);
								if (typeof d.override_content === "string") {
									setOverride(d.override_content);
									setOverrideLoaded(true);
								}
							}
							if (action === "apply" && d.complete === false) {
								const parts = [];
								if (d.failed > 0) {
									const ids = (d.failed_items || [])
										.map((x) => x.id)
										.filter((id) => id != null)
										.join(",");
									parts.push(
										tr("restart.incomplete.patches", {
											failed: String(d.failed || 0),
											ids: ids || "?",
										}),
									);
								}
								if (d.cmd_flash && d.cmd_flash.ok === false) {
									parts.push(
										tr("restart.incomplete.flash", {
											entry: String(d.cmd_flash.entry || "fail"),
										}),
									);
								}
								if (parts.length === 0) parts.push(tr("restart.incomplete.flash", { entry: "unknown" }));
								setNotice({
									kind: "error",
									text: tr("restart.incomplete", { detail: parts.join(";") }),
								});
								loadAll();
								if (d.restarting || d.needs_full_quit) {
									suppressRestartAsk.current = false;
									setAskRestart(true);
								}
								return;
							}
							if (action === "apply") {
								setNotice({ kind: "ok", text: tr("ok.done") });
								loadAll();
								suppressRestartAsk.current = false;
								setAskRestart(true);
								return;
							}
							setNotice({ kind: "ok", text: tr("ok.done") });
							loadAll();
						})
						.catch((e) => {
							if (ticket !== actionTicket.current) return;
							setNotice({ kind: "error", text: tr("err.action", { action: label, error: e.message }) });
						})
						.finally(() => {
							if (ticket === actionTicket.current) setPatchBusy(false);
						});
				};
				run();
			}, [loadAll, rejectNeedPrompt, state]);

			const saveOverride = useCallback(() => {
				const tr = t;
				const ticket = ++actionTicket.current;
				const go = () => {
					setPatchBusy(true);
					setAskRestart(false);
					setNotice({ kind: "idle", text: "" });
					const content = readPromptBox();
					fetch("/dsh-purge/override", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ content: content }),
					})
						.then((r) => r.json())
						.then((d) => {
							if (ticket !== actionTicket.current) return;
							if (!d.ok || responseNeedsPrompt(d)) {
								rejectNeedPrompt(tr);
								return;
							}
							if (typeof d.content === "string") {
								overrideRef.current = d.content;
								setOverride(d.content);
							}
							promptDirtyRef.current = false;
							setNotice({ kind: "ok", text: t("saved.override") });
						})
						.catch((e) => {
							if (ticket !== actionTicket.current) return;
							setNotice({ kind: "error", text: t("err.save", { error: e.message }) });
						})
						.finally(() => {
							if (ticket === actionTicket.current) setPatchBusy(false);
						});
				};
				bothInjectEmpty(readPromptBox(), defaultOverrideRef.current).then((empty) => {
					if (ticket !== actionTicket.current) return;
					if (empty) {
						rejectNeedPrompt(tr);
						return;
					}
					go();
				});
			}, [t, rejectNeedPrompt]);

			const restoreOverride = useCallback(() => {
				if (!defaultOverride) return;
				const tr = t;
				const ticket = ++actionTicket.current;
				overrideRef.current = defaultOverride;
				setOverride(defaultOverride);
				setPatchBusy(true);
				setNotice({ kind: "idle", text: "" });
				apiJson("/dsh-purge/override", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ content: defaultOverride }),
				})
					.then((d) => {
						if (ticket !== actionTicket.current) return;
						if (!d || !d.ok) {
							setNotice({ kind: "error", text: tr("err.save", { error: (d && d.error) || "" }) });
							return;
						}
						if (typeof d.content === "string") {
							overrideRef.current = d.content;
							setOverride(d.content);
						}
						promptDirtyRef.current = false;
						setNotice({ kind: "ok", text: tr("saved.restoreInject") });
					})
					.catch((e) => {
						if (ticket !== actionTicket.current) return;
						setNotice({ kind: "error", text: tr("err.save", { error: e.message }) });
					})
					.finally(() => {
						if (ticket === actionTicket.current) setPatchBusy(false);
					});
			}, [defaultOverride, t]);

			const waitHostAfterUninstall = useCallback((tr) => {
				const started = Date.now();
				const ping = () => {
					fetch("/", { cache: "no-store", credentials: "same-origin" })
						.then((r) => {
							if (r.ok) {
								try {
									window.localStorage.removeItem("dshp-theme");
									window.localStorage.removeItem("dshp-theme-mode");
								} catch { /* ignore */ }
								window.location.reload();
								return;
							}
							retry();
						})
						.catch(retry);
				};
				const retry = () => {
					if (Date.now() - started > 90000) {
						setNotice({ kind: "error", text: tr("restart.timeout") });
						setUninstallBusy(false);
						return;
					}
					setTimeout(ping, 500);
				};
				setTimeout(ping, 800);
			}, []);

			const doUninstall = useCallback(() => {
				setUninstallBusy(true);
				setAskUninstall(false);
				setAskRestart(false);
				const tr = tRef.current;
				setNotice({ kind: "ok", text: tr("uninstall.applying") });
				setState((prev) => Object.assign({}, prev || {}, {
					apply_progress: { active: true, kind: "uninstall", stage: "locate", error: "" },
				}));
				apiJson("/dsh-purge/uninstall", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })
					.then((d) => {
						if (!d || !d.ok) throw new Error((d && d.error) || "uninstall failed");
						setNotice({ kind: "ok", text: (d && d.note) || hostText(tr, "uninstall.done", d.surface || hostSurfaceOf(state)) });
						if ((d && d.surface) === "desktop" || (d && d.fullApp) || hostSurfaceOf(state) === "desktop") return;
						waitHostAfterUninstall(tr);
					})
					.catch((e) => {
						const msg = String((e && e.message) || e || "");
						if (/failed to fetch|networkerror|load failed/i.test(msg)) {
							setNotice({ kind: "ok", text: hostText(tr, "uninstall.done", hostSurfaceOf(state)) });
							if (hostSurfaceOf(state) === "desktop" || clientGuessSurface() === "desktop") return;
							waitHostAfterUninstall(tr);
							return;
						}
						setNotice({ kind: "error", text: tr("uninstall.fail", { error: msg }) });
						setUninstallBusy(false);
					});
			}, [state, waitHostAfterUninstall]);

			const s = state;
			const located = !!(s && s.ai_base);
			const hostSurface = hostSurfaceOf(s);
			const desktopLikely = hostSurface === "desktop" || clientGuessSurface() === "desktop";
			const sealedReady = !located && desktopLikely && !!(s && (s.asar_still_sealed || s.desktop_exe || s.desktop_install));
			const patchesLost = !located && !!(s && s.patches_lost);
			const tally = located ? tallyPatches(patchRowsOf(s)) : { applied: 0, pending: 0, unmatched: 0, skipped: 0, drifted: 0, total: 0 };
			const total = tally.total;
			const applied = tally.applied;
			const job = s && s.apply_progress;
			const jobOn = Boolean(patchBusy || uninstallBusy || (job && job.active));
			const jobSteps = FLOW_STEPS[(job && job.kind) || "apply"] || FLOW_STEPS.apply;
			const jobIdx = jobSteps.indexOf(job && job.stage === "restart" ? "done" : ((job && job.stage) || "idle"));
			const pct = jobOn
				? Math.round(((job && job.stage === "done" ? jobSteps.length : Math.max(jobIdx, 0) + 0.45) / jobSteps.length) * 100)
				: (located && total ? Math.round((applied / total) * 100) : 0);
			const metricNotes = [];
			if (tally.pending) metricNotes.push(t("metric.pendingShort", { n: tally.pending }));
			if (tally.unmatched) metricNotes.push(t("metric.unmatchedShort", { n: tally.unmatched }));
			if (tally.drifted) metricNotes.push(t("metric.driftedShort", { n: tally.drifted }));
			if (tally.skipped) metricNotes.push(t("metric.skipShort", { n: tally.skipped }));

			const versions = (updateInfo && updateInfo.versions) || [];
			const channelNow = (updateInfo && updateInfo.channel) || channel || "stable";
			const localVer = (s && s.plugin_version) || (updateInfo && updateInfo.localVersion) || "";
			const renderEdition = (id) => {
				const lane = (updateInfo && updateInfo.lanes && updateInfo.lanes[id]) || {};
				const ceiling = listedCeiling(versions, localVer || (updateInfo && updateInfo.localVersion));
				const list = versions.filter((item) => item.channel === id && keepListedVersion(item, ceiling));
				const selectedRef = pick[id] || "";
				const hit = list.find((item) => item.ref === selectedRef) || preferListed(list, localVer, updateInfo && updateInfo.pin);
				const onLane = channelNow === id;
				const noBeta = id === "beta" && Array.isArray(updateInfo && updateInfo.versions) && !list.length;
				const pickedOther = Boolean(hit && selectedRef && !hit.current);
				const thisJob = updateJob && updateJob.id === id ? updateJob : null;
				let actionLabel = t("btn.checkUpdate");
				let actionKind;
				let actionClick = () => checkUpdate(id);
				let actionDisabled = updateBusy || Boolean(noBeta);
				if (noBeta) {
					actionLabel = t("update.noBeta");
					actionClick = () => {};
				} else if (pickedOther) {
					actionLabel = t("update.switch");
					actionKind = "primary";
					actionClick = () => switchSelected(id);
				} else if (!onLane) {
					actionLabel = id === "beta" ? t("channel.useBeta") : t("channel.useStable");
					actionKind = "primary";
					actionClick = () => changeChannel(id);
				} else if (canApplyUpdate && lane.hasUpdate) {
					actionLabel = t("btn.doUpdate");
					actionKind = "primary";
					actionClick = () => doUpdate(id);
				}
				if (thisJob) {
					if (thisJob.kind === "check") actionLabel = t("btn.checkUpdate.busy");
					else if (thisJob.kind === "done") actionLabel = t("btn.doUpdate.busy");
					else actionLabel = t("update.switching");
				}
				return h("div", {
					className: "dshp-edition" + (onLane ? " is-on" : ""),
					"aria-label": t("channel." + id),
				},
					h("span", { className: "dshp-edition-name" },
						t("channel." + id),
						onLane ? h("em", { className: "dshp-now-mark" }, t("update.current")) : null,
					),
					h("select", {
						className: "dshp-field dshp-ver",
						value: list.length ? ((hit && hit.ref) || "") : "",
						disabled: updateBusy || !list.length,
						onChange: (e) => setPick((prev) => Object.assign({}, prev, { [id]: e.target.value })),
						"aria-label": t("update.pick"),
					},
						list.length
							? list.map((item) => h("option", {
								key: item.ref + (item.sha || ""),
								value: item.ref,
							}, versionChoiceLabel(item, t)))
							: h("option", { value: "" }, noBeta ? t("update.noBeta") : t("update.pick")),
					),
					h(Btn, { tiny: true, kind: actionKind, disabled: actionDisabled, onClick: actionClick }, actionLabel),
				);
			};
			return h("section", { className: "dshp-panel", "aria-label": t("purge.title") },
				h("div", { className: "dshp-head" },
					h("h3", { className: "dshp-title" }, t("purge.title")),
					h("span", { className: "dshp-pill" }, t("surface." + hostSurface)),
				),
				h("div", { className: "dshp-rel" },
					h("div", { className: "dshp-now" },
						h("span", { className: "dshp-now-label" }, t("channel.local")),
						h("b", { className: "dshp-now-ver" }, localVer ? "v" + localVer : "—"),
						h("em", { className: "dshp-now-mark" }, t("update.current")),
					),
					h("div", { className: "dshp-editions" },
						renderEdition("stable"),
						renderEdition("beta"),
					),
					noticeNode(updateNotice),
				),
				s ? h("div", { className: "dshp-metrics" },
					h("div", { className: "dshp-metric" },
						h("b", null, located ? (applied + " / " + total) : (patchesLost ? t("metric.lost.count") : (sealedReady ? t("metric.sealed.count") : t("metric.unlocated.count")))),
						h("span", null, !located ? (patchesLost ? t("metric.lost") : (sealedReady ? t("metric.sealed") : t("metric.unlocated"))) : (metricNotes.length ? metricNotes.join(" · ") : t("metric.purged"))),
					),
					h("div", { className: "dshp-metric" },
						h("b", { style: { fontSize: 13, fontFamily: "var(--dshp-mono)", fontWeight: 500 } },
							h("span", { className: "dshp-pill is-" + shimKind(s.shim_cmd) }, "cmd"),
							" ",
							h("span", { className: "dshp-pill is-" + shimKind(s.shim_ps1) }, "ps1"),
							" ",
							h("span", { className: "dshp-pill is-" + shimKind(s.shim_bin || "missing") }, "unix"),
						),
						h("span", null, (s.shim_cmd === "n/a" && s.shim_ps1 === "n/a" && (s.shim_bin === "n/a" || !s.shim_bin)) ? t("metric.shim.na") : t("metric.shim")),
					),
					h("div", { className: "dshp-metric" },
						h("b", null, s.has_backup ? t("metric.bak.yes") : t("metric.bak.no")),
						h("span", null, t("metric.bak.hint")),
					),
				) : h("div", { className: "dshp-metrics" },
					h("div", { className: "dshp-metric" }, h("div", { className: "dshp-skel" }), h("div", { className: "dshp-skel", style: { width: "40%" } })),
					h("div", { className: "dshp-metric" }, h("div", { className: "dshp-skel" }), h("div", { className: "dshp-skel", style: { width: "40%" } })),
					h("div", { className: "dshp-metric" }, h("div", { className: "dshp-skel" }), h("div", { className: "dshp-skel", style: { width: "40%" } })),
				),
				h(ApplyFlow, { progress: s && s.apply_progress, busy: patchBusy || uninstallBusy, t: t }),
				h("div", { className: "dshp-bar", "aria-hidden": "true" }, h("i", { style: { transform: "scaleX(" + (pct / 100) + ")" } })),
				h(PatchGroups, { state: s }),
				h(HooksDenySection, { onSaved: loadAll }),
				h("div", { className: "dshp-row", style: { marginTop: 12 } },
					h(Btn, { kind: "primary", disabled: patchBusy || uninstallBusy || !overrideLoaded, onClick: () => doAction("apply", "action.apply") }, patchBusy ? t("btn.apply.busy") : t("btn.apply")),
					h(Btn, { kind: "danger", disabled: patchBusy || uninstallBusy, onClick: () => doAction("revert", "action.revert") }, t("btn.revert")),
					h(Btn, { kind: "solid-danger", disabled: patchBusy || uninstallBusy, onClick: () => setAskUninstall(true) }, uninstallBusy ? t("btn.uninstall.busy") : t("btn.uninstall")),
					noticeNode(notice),
				),
				askUninstall ? h("div", {
					className: "dshp-modal-bg",
					role: "dialog",
					"aria-modal": "true",
					"aria-labelledby": "dshp-uninstall-title",
					onClick: (e) => { if (e.target === e.currentTarget && !uninstallBusy) setAskUninstall(false); },
				},
					h("div", { className: "dshp-modal" },
						h("h4", { id: "dshp-uninstall-title" }, t("uninstall.title")),
						h("p", null, t("uninstall.body")),
						h("div", { className: "dshp-modal-ops" },
							h(Btn, { disabled: uninstallBusy, onClick: () => setAskUninstall(false) }, t("uninstall.cancel")),
							h(Btn, { kind: "solid-danger", disabled: uninstallBusy, onClick: doUninstall }, t("uninstall.confirm")),
						),
					),
				) : null,
				h("p", { className: "dshp-hint", style: { margin: "8px 0 0", color: "var(--dshp-mute)", fontSize: 12 } }, t("apply.hint")),
				s && !s.ai_base ? h("p", { className: "dshp-hint", style: { margin: "8px 0 0", color: "var(--dshp-danger, #c44)", fontSize: 12 } }, hostText(t, "warn.noRoot", hostSurface)) : null,
				s && s.ai_base && s.override_status === "missing" ? h("p", { className: "dshp-hint", style: { margin: "8px 0 0", color: "var(--dshp-mute)", fontSize: 12 } }, t("warn.noInject")) : null,
				s && s.ai_base && s.host_supported === false ? h("p", { className: "dshp-hint", style: { margin: "8px 0 0", color: "var(--dshp-danger, #c44)", fontSize: 12 } }, t("warn.hostVersion", { v: s.host_version || "?", t: s.host_target || "?" })) : null,
				askRestart ? h(RestartAsk, {
					t: t,
					theme: detectHostTheme(),
					onLater: () => {
						suppressRestartAsk.current = true;
						setAskRestart(false);
					},
					onRestart: () => {
						suppressRestartAsk.current = true;
						setAskRestart(false);
						restartDsh(setNotice, function () {}, t, hostSurface);
					},
				}) : null,
				// h(ContinueRetrySection, null),
				h("div", { className: "dshp-sub" },
					h("h4", null, t("override.title")),
					h("div", { className: "dshp-row", style: { margin: 0 } },
						h(Btn, { kind: "primary", tiny: true, disabled: patchBusy || !overrideLoaded, onClick: saveOverride }, t("btn.saveInject")),
						h(Btn, { tiny: true, disabled: patchBusy || !overrideLoaded || !defaultOverride, onClick: restoreOverride }, t("btn.restoreInject")),
					),
				),
				h("textarea", {
					className: "dshp-area",
					ref: promptAreaRef,
					value: override,
					onChange: (e) => {
						promptDirtyRef.current = true;
						overrideRef.current = e.target.value;
						setOverride(e.target.value);
					},
					spellCheck: false,
					placeholder: "",
				}),
				promptBoxEmpty(override) ? h("p", {
					className: "dshp-hint",
					style: { margin: "8px 0 0", color: "var(--dshp-danger, #c44)", fontSize: 12 },
				}, t("need.prompt")) : null,
			);
		}

		function ruleLabel(r) {
			if (!r) return "";
			if (r.name !== r.id) return r.name + " (" + r.id + ")";
			return r.id;
		}

		function RulesSection() {
			const t = useT();
			const tRef = useRef(t);
			tRef.current = t;
			const [st, setSt] = useState(null);
			const [editId, setEditId] = useState(null);
			const [editName, setEditName] = useState("");
			const [editTarget, setEditTarget] = useState("AGENTS.md");
			const [content, setContent] = useState("");
			const [newId, setNewId] = useState("");
			const [newName, setNewName] = useState("");
			const [newTarget, setNewTarget] = useState("AGENTS.md");
			const [busy, setBusy] = useState(false);
			const [notice, setNotice] = useState({ kind: "idle", text: "" });

			const loadStatus = useCallback(() => {
				const tr = tRef.current;
				let cwd = "";
				try { cwd = clientCurrentCwd(); } catch { /* ignore */ }
				rulesApi("status", cwd ? { cwd: cwd } : undefined)
					.then((d) => {
						if (d && d.ok) setSt(d);
						else {
							setSt({ ok: false, rules: [], active: null });
							setNotice({ kind: "error", text: tr("err.rules", { error: (d && d.error) || "bad response" }) });
						}
					})
					.catch((e) => {
						setSt({ ok: false, rules: [], active: null });
						setNotice({ kind: "error", text: tr("err.rules", { error: e.message }) });
					});
			}, []);

			useEffect(() => { loadStatus(); }, [loadStatus]);

			const doPost = useCallback((action, payload, after) => {
				setBusy(true);
				setNotice({ kind: "idle", text: "" });
				rulesApi(action, payload)
					.then((d) => {
						if (d && d.ok) {
							setNotice({ kind: "ok", text: t("ok.done") });
							if (action === "save" || action === "activate") warnNeedPrompt(d, t);
							loadStatus();
							if (after) after();
						} else {
							warnNeedPrompt(d, t);
							setNotice({ kind: "error", text: t("err.action", { error: (d && d.error) || "" }) });
						}
					})
					.catch((e) => setNotice({ kind: "error", text: t("err.action", { error: e.message }) }))
					.finally(() => setBusy(false));
			}, [loadStatus, t]);

			const openRule = useCallback((id) => {
				setBusy(true);
				rulesApi("read", { id: id })
					.then((d) => {
						if (d.ok) {
							setEditId(id);
							setEditName(d.name || id);
							setEditTarget(d.target || "AGENTS.md");
							setContent(typeof d.content === "string" ? d.content : "");
						} else setNotice({ kind: "error", text: t("err.read", { error: d.error || "" }) });
					})
					.catch((e) => setNotice({ kind: "error", text: t("err.read", { error: e.message }) }))
					.finally(() => setBusy(false));
			}, [t]);

			const clearEditor = () => {
				setEditId(null);
				setEditName("");
				setEditTarget("AGENTS.md");
				setContent("");
			};

			let list;
			if (!st) {
				list = h("div", { className: "dshp-skel", style: { height: 80, margin: 12 } });
			} else if (!st.rules || st.rules.length === 0) {
				list = h("p", { className: "dshp-empty" }, t("rules.empty"));
			} else {
				list = st.rules.map((r) => {
					const isActive = r.id === st.active;
					const isEdit = r.id === editId;
					return h("div", {
						key: r.id,
						className: "dshp-ruleitem" + (isEdit ? " is-edit" : ""),
						role: "button",
						tabIndex: 0,
						onClick: () => openRule(r.id),
						onKeyDown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openRule(r.id); } },
					},
						h("div", { className: "dshp-rule-main" },
							h("span", { className: "dshp-rule-name" },
								ruleLabel(r),
								isActive ? h("span", { className: "dshp-pill is-ok" }, t("pill.current")) : null,
							),
							h("span", { className: "dshp-rule-meta" }, r.target + " · " + formatSize(r.size)),
						),
						h("div", { className: "dshp-rule-ops" },
							h(Btn, {
								tiny: true,
								kind: isActive ? undefined : "primary",
								disabled: busy || isActive,
								onClick: (e) => {
									e.stopPropagation();
									if (!isActive) doPost("activate", { id: r.id });
								},
							}, isActive ? t("btn.inUse") : t("btn.use")),
							h(Btn, {
								tiny: true,
								kind: "danger",
								disabled: busy,
								onClick: (e) => {
									e.stopPropagation();
									if (!window.confirm(t("confirm.delete", { id: r.id }))) return;
									if (editId === r.id) clearEditor();
									doPost("delete", { id: r.id });
								},
							}, t("delete")),
						),
					);
				});
			}

			const policyValue = (st && typeof st.workspace_policy === "string") ? st.workspace_policy : "fallback";
			const policyOptions = (st && Array.isArray(st.workspace_policies) && st.workspace_policies.length) ? st.workspace_policies : ["fallback", "strict", "always"];
			const cwdCandidates = (st && Array.isArray(st.cwd_candidates)) ? st.cwd_candidates : [];
			const cwdValue = (st && typeof st.cwd === "string") ? st.cwd : "";
			return h("section", { className: "dshp-panel", "aria-label": t("rules.title") },
				h("div", { className: "dshp-head" },
					h("h3", { className: "dshp-title" }, t("rules.title")),
					h("div", { className: "dshp-row", style: { margin: 0 } },
						noticeNode(notice),
						h(Btn, {
							tiny: true,
							kind: "danger",
							disabled: busy,
							onClick: () => {
								if (!window.confirm(t("rules.reset.confirm"))) return;
								clearEditor();
								doPost("reset", {});
							},
						}, t("rules.reset")),
					),
				),
				h("div", { className: "dshp-block" },
					h("div", { className: "dshp-policy-row" },
						h("label", { htmlFor: "dshp-policy-select" }, t("policy.title")),
						h("select", {
							id: "dshp-policy-select",
							className: "dshp-field",
							value: policyValue,
							disabled: busy || !st,
							onChange: (e) => doPost("set-policy", { policy: e.target.value }),
						}, policyOptions.map((p) => h("option", { key: p, value: p }, t("policy." + p)))),
					),
					h("p", { className: "dshp-block-hint" }, t("policy.hint")),
				),
				h("div", { className: "dshp-block" },
					h("div", { className: "dshp-block-head" },
						h("h4", null, t("cwd.title")),
						h(Btn, {
							tiny: true,
							disabled: busy,
							onClick: () => {
								let cwd = cwdValue;
								if (!cwd) { try { cwd = clientCurrentCwd(); } catch { /* ignore */ } }
								doPost("scan-cwd", cwd ? { cwd: cwd } : {});
							},
						}, t("cwd.rescan")),
					),
					cwdValue ? h("p", { className: "dshp-cwd-path" }, cwdValue) : null,
					(!st || !cwdValue)
						? h("p", { className: "dshp-empty" }, t("cwd.no.workspace"))
						: (cwdCandidates.length === 0
							? h("p", { className: "dshp-empty" }, t("cwd.empty"))
							: h("div", { className: "dshp-cwd-list" }, cwdCandidates.map((item) => h("label", {
								key: item.path,
								className: "dshp-cwd-item" + (item.selected ? " is-on" : ""),
							},
								h("input", {
									type: "checkbox",
									checked: Boolean(item.selected),
									disabled: busy,
									onChange: (e) => doPost("toggle-cwd", { path: item.path, enabled: e.target.checked }),
								}),
								h("div", { className: "dshp-cwd-main" },
									h("div", { className: "dshp-cwd-name" },
										h("span", null, item.name),
										h("span", { className: "dshp-cwd-badge" }, t("cwd.scope." + (item.scope || "cwd"))),
										h("span", { className: "dshp-cwd-size" }, formatSize(item.size || 0)),
									),
									h("div", { className: "dshp-cwd-sub" }, item.path),
									item.preview ? h("div", { className: "dshp-cwd-prev" }, item.preview) : null,
								),
							)))),
					h("p", { className: "dshp-block-hint" }, t("cwd.hint")),
				),
				h("div", { className: "dshp-block" },
				h("div", { className: "dshp-split" },
					h("div", { className: "dshp-rulelist" },
						h("div", { className: "dshp-rulebody" }, list),
						h("div", { className: "dshp-create" },
							h("div", { className: "dshp-create-row" },
								h("input", { className: "dshp-field", placeholder: t("ph.id"), value: newId, onChange: (e) => setNewId(e.target.value) }),
								h("input", { className: "dshp-field", placeholder: t("ph.alias"), value: newName, onChange: (e) => setNewName(e.target.value) }),
								h("select", { className: "dshp-field", style: { minWidth: 120, flex: "0 0 auto" }, value: newTarget, onChange: (e) => setNewTarget(e.target.value) },
									TARGETS.map((x) => h("option", { key: x, value: x }, x))),
								h(Btn, {
									kind: "primary",
									tiny: true,
									disabled: busy,
									onClick: () => {
										const id = newId.trim();
										if (!id) { setNotice({ kind: "error", text: t("need.id") }); return; }
										const name = newName.trim() || id;
										const target = newTarget;
										doPost("save", { id, content: "", name, target }, () => {
											setEditId(id);
											setEditName(name);
											setEditTarget(target);
											setContent("");
										});
										setNewId(""); setNewName(""); setNewTarget("AGENTS.md");
									},
								}, t("btn.create")),
							),
						),
					),
					h("div", { className: "dshp-editor" },
						editId ? [
							h("div", { key: "meta", className: "dshp-row" },
								h("input", {
									className: "dshp-field", placeholder: t("ph.alias.short"), value: editName,
									onChange: (e) => setEditName(e.target.value),
								}),
								h("select", {
									className: "dshp-field", style: { minWidth: 120 }, value: editTarget,
									onChange: (e) => setEditTarget(e.target.value),
								}, TARGETS.map((x) => h("option", { key: x, value: x }, x))),
							),
							h("textarea", {
								key: "body",
								className: "dshp-area", value: content,
								onChange: (e) => setContent(e.target.value),
								placeholder: "",
							}),
							h("div", { key: "save", className: "dshp-row" },
								h(Btn, {
									kind: "primary",
									disabled: busy,
									onClick: () => doPost("save", { id: editId, content, name: editName, target: editTarget }),
								}, t("btn.saveRule")),
								noticeNode(notice),
							),
						] : h("div", { className: "dshp-editor-empty" }, t("rules.pick")),
					),
				),
				),
			);
		}

		function skillUiAllowed(d) {
			if (!d) return false;
			const ver = String(d.plugin_version || d.localVersion || "").replace(/^v/i, "");
			if (/^1\.1\.11(?:-|$)/.test(ver)) return false;
			const parts = ver.match(/^(\d+)\.(\d+)\.(\d+)/);
			if (!parts) return false;
			if (+parts[1] !== 1) return +parts[1] > 1;
			if (+parts[2] !== 1) return +parts[2] > 1;
			return +parts[3] >= 12;
		}

		function splitListedVersion(raw) {
			const text = String(raw || "").trim().replace(/^v/i, "");
			const cut = text.split("-");
			const core = String(cut[0] || "").split(".").map((n) => parseInt(n, 10) || 0);
			return { core: [core[0] || 0, core[1] || 0, core[2] || 0], pre: cut.slice(1).join("-") };
		}

		function listedVersionNewer(remote, local) {
			if (!remote || !local || String(remote) === String(local)) return false;
			const a = splitListedVersion(remote);
			const b = splitListedVersion(local);
			for (let i = 0; i < 3; i += 1) {
				if (a.core[i] !== b.core[i]) return a.core[i] > b.core[i];
			}
			if (a.pre && !b.pre) return false;
			if (!a.pre && b.pre) return true;
			return a.pre > b.pre;
		}

		function listedCeiling(versions, localVer) {
			let best = "";
			const rows = (versions || []).slice();
			const local = String(localVer || "").replace(/^v/i, "");
			if (local && !/(?:^|[-._])(beta|rc|pre|preview|test)(?:\d|$|[-._])/i.test(local)) {
				rows.push({ channel: "stable", version: local });
			}
			for (const item of rows) {
				if (!item || item.channel === "beta") continue;
				const ver = String(item.version || "").replace(/^v/i, "");
				if (!/^\d+\.\d+\.\d+/.test(ver) || /(?:^|[-._])(beta|rc|pre|preview|test)(?:\d|$|[-._])/i.test(ver)) continue;
				if (!best || listedVersionNewer(ver, best)) best = ver;
			}
			return best;
		}

		function keepListedVersion(item, _ceiling) {
			const ver = String((item && (item.version || item.ref || item.id)) || "");
			if (!item) return false;
			if (item.ref === "beta" || item.id === "beta") return true;
			if (item.channel === "beta") return false;
			if (/(?:^|[-._])(beta|rc|pre|preview|test)(?:\d|$|[-._])/i.test(ver)) return false;
			return true;
		}

		function preferListed(list, localVer, pin) {
			const pinned = pin ? (list || []).find((item) => item.ref === pin) : null;
			if (pinned) return pinned;
			const ver = String(localVer || "").replace(/^v/i, "");
			const same = (list || []).filter((item) => ver && String(item.version || "").replace(/^v/i, "") === ver);
			if (same.length) {
				return same.find((item) => item.current)
					|| same.find((item) => item.latest)
					|| same[0];
			}
			return (list || []).find((item) => item.current)
				|| (list || []).find((item) => item.latest)
				|| (list || [])[0]
				|| null;
		}

		function versionChoiceLabel(item, tr) {
			const ver = String((item && item.version) || "").replace(/^v/i, "");
			const base = ver ? ("v" + ver) : ((item && (item.label || item.ref)) || "—");
			if (item && item.current) return base + " · " + tr("update.current");
			if (item && item.latest) return base + " · " + tr("update.tip");
			return base;
		}

		function SkillsSection() {
			const t = useT();
			const tRef = useRef(t);
			tRef.current = t;
			const [onBeta, setOnBeta] = useState(false);
			const [st, setSt] = useState(null);
			const [editId, setEditId] = useState(null);
			const [editDesc, setEditDesc] = useState("");
			const [content, setContent] = useState("");
			const [busy, setBusy] = useState(false);
			const [notice, setNotice] = useState({ kind: "idle", text: "" });
			const zipRef = useRef(null);
			const folderRef = useRef(null);

			const loadStatus = useCallback(() => {
				const tr = tRef.current;
				const fail = (e) => {
					setSt({ ok: false, skills: [] });
					setNotice({
						kind: "error",
						text: skillsRouteMissing(e) ? tr("err.skills.needRestart") : tr("err.skills", { error: (e && e.message) || e || "bad response" }),
					});
				};
				const apply = (d) => {
					if (d && d.ok) setSt({ ok: true, skills: d.skills || [] });
					else fail({ message: (d && d.error) || "bad response" });
				};
				apiJson("/dsh-purge/status")
					.then((d) => {
						const allowed = skillUiAllowed(d);
						setOnBeta(allowed);
						if (!allowed) {
							setSt(null);
							return;
						}
						if (d.skills) {
							apply({ ok: true, skills: d.skills });
							return;
						}
						skillsApi("status").then(apply).catch(fail);
					})
					.catch(() => {
						setOnBeta(false);
						setSt(null);
					});
			}, []);

			useEffect(() => { loadStatus(); }, [loadStatus]);

			const doPost = useCallback((action, payload, after) => {
				setBusy(true);
				setNotice({ kind: "idle", text: "" });
				skillsApi(action, payload)
					.then((d) => {
						if (d && d.ok) {
							setNotice({ kind: "ok", text: t("ok.done") });
							loadStatus();
							if (after) after(d);
						} else {
							setNotice({ kind: "error", text: t("err.action", { error: (d && d.error) || "" }) });
						}
					})
					.catch((e) => setNotice({
						kind: "error",
						text: skillsRouteMissing(e) ? t("err.skills.needRestart") : t("err.action", { error: e.message }),
					}))
					.finally(() => setBusy(false));
			}, [loadStatus, t]);

			const openSkill = useCallback((id) => {
				setBusy(true);
				skillsApi("read", { id: id })
					.then((d) => {
						if (d.ok) {
							setEditId(id);
							setEditDesc(d.description || "");
							setContent(typeof d.content === "string" ? d.content : "");
						} else setNotice({ kind: "error", text: t("err.read", { error: d.error || "" }) });
					})
					.catch((e) => setNotice({ kind: "error", text: t("err.read", { error: e.message }) }))
					.finally(() => setBusy(false));
			}, [t]);

			const clearEditor = () => {
				setEditId(null);
				setEditDesc("");
				setContent("");
			};

			const readAsBase64 = (file) => new Promise((resolve, reject) => {
				const reader = new FileReader();
				reader.onload = () => {
					const text = String(reader.result || "");
					const at = text.indexOf(",");
					resolve(at >= 0 ? text.slice(at + 1) : text);
				};
				reader.onerror = () => reject(new Error(t("need.import")));
				reader.readAsDataURL(file);
			});

			const importZip = (file) => {
				if (!file) {
					setNotice({ kind: "error", text: t("need.import") });
					return;
				}
				setBusy(true);
				setNotice({ kind: "ok", text: t("skills.importing") });
				readAsBase64(file)
					.then((data) => skillsApi("import", { data, name: file.name }))
					.then((d) => {
						if (!d || !d.ok) throw new Error((d && d.error) || "");
						setNotice({ kind: "ok", text: t("saved.import", { count: (d.imported || []).length || 1 }) });
						loadStatus();
					})
					.catch((e) => setNotice({
						kind: "error",
						text: skillsRouteMissing(e) ? t("err.skills.needRestart") : t("err.action", { error: e.message }),
					}))
					.finally(() => setBusy(false));
			};

			const keepFolderFile = (file) => {
				const rel = String(file.webkitRelativePath || file.name || "").replace(/\\/g, "/");
				if (!rel || rel.includes("..")) return false;
				if (/(^|\/)(node_modules|\.git|__MACOSX|\.system)(\/|$)/i.test(rel)) return false;
				if (/(^|\/)\._/.test(rel) || /\/\.DS_Store$/i.test(rel)) return false;
				return true;
			};

			const importFolder = (list) => {
				const files = Array.from(list || []).filter(keepFolderFile);
				if (!files.length) {
					setNotice({ kind: "error", text: t("err.import.folder") });
					return;
				}
				setBusy(true);
				setNotice({ kind: "ok", text: t("skills.importing") });
				Promise.all(files.map((file) => readAsBase64(file).then((content) => ({
					path: file.webkitRelativePath || file.name,
					content,
					encoding: "base64",
				}))))
					.then((payload) => skillsApi("import", {
						files: payload,
						name: String(payload[0] && payload[0].path || "").split("/")[0],
					}))
					.then((d) => {
						if (!d || !d.ok) throw new Error((d && d.error) || "");
						setNotice({ kind: "ok", text: t("saved.import", { count: (d.imported || []).length || 1 }) });
						loadStatus();
					})
					.catch((e) => setNotice({
						kind: "error",
						text: skillsRouteMissing(e) ? t("err.skills.needRestart") : t("err.action", { error: e.message }),
					}))
					.finally(() => setBusy(false));
			};

			if (!onBeta) return null;

			let list;
			if (!st) {
				list = h("div", { className: "dshp-skel", style: { height: 80, margin: 12 } });
			} else if (!st.skills || st.skills.length === 0) {
				list = h("p", { className: "dshp-empty" }, t("skills.empty"));
			} else {
				list = st.skills.map((item) => {
					const isEdit = item.id === editId;
					return h("div", {
						key: item.id,
						className: "dshp-ruleitem" + (isEdit ? " is-edit" : ""),
						role: "button",
						tabIndex: 0,
						onClick: () => openSkill(item.id),
						onKeyDown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openSkill(item.id); } },
					},
						h("div", { className: "dshp-rule-main" },
							h("span", { className: "dshp-rule-name" }, item.id),
							h("span", { className: "dshp-rule-meta" },
								(item.valid ? item.description : t("skills.invalid")) + " · " + formatSize(item.size),
							),
							item.valid ? h("span", { className: "dshp-rule-meta" },
								[
									item.userInvocable ? t("skills.call.slash", { cmd: "/" + item.id }) : t("skills.call.userOff"),
									item.modelInvocable ? t("skills.call.model") : t("skills.call.modelOff"),
								].join(" · "),
							) : null,
						),
						h("div", { className: "dshp-rule-ops" },
							h(Btn, {
								tiny: true,
								kind: "danger",
								disabled: busy,
								onClick: (e) => {
									e.stopPropagation();
									if (!window.confirm(t("confirm.delete.skill", { id: item.id }))) return;
									if (editId === item.id) clearEditor();
									doPost("delete", { id: item.id });
								},
							}, t("delete")),
						),
					);
				});
			}

			return h("section", { className: "dshp-panel", "aria-label": t("skills.title") },
				h("div", { className: "dshp-head" },
					h("h3", { className: "dshp-title" }, t("skills.title")),
					h("div", { className: "dshp-row", style: { margin: 0 } }, noticeNode(notice)),
				),
				h("p", { className: "dshp-hint", style: { margin: "0 0 10px", color: "var(--dshp-mute)", fontSize: 12 } }, hostText(t, "skills.hint", hostSurfaceOf())),
				h("div", { className: "dshp-split" },
					h("div", { className: "dshp-rulelist" },
						h("div", { className: "dshp-rulebody" }, list),
						h("div", { className: "dshp-create" },
							h("div", { className: "dshp-create-row" },
								h("input", {
									ref: zipRef,
									type: "file",
									accept: ".zip,.tgz,.tar.gz,.tar,.skill",
									style: { display: "none" },
									onChange: (e) => {
										const file = e.target.files && e.target.files[0];
										e.target.value = "";
										importZip(file);
									},
								}),
								h("input", {
									ref: (el) => {
										folderRef.current = el;
										if (!el) return;
										el.setAttribute("webkitdirectory", "");
										el.setAttribute("directory", "");
										el.multiple = true;
									},
									type: "file",
									multiple: true,
									style: { display: "none" },
									onChange: (e) => {
										const files = Array.from((e.target && e.target.files) || []);
										e.target.value = "";
										importFolder(files);
									},
								}),
								h(Btn, {
									kind: "primary",
									tiny: true,
									disabled: busy,
									onClick: () => zipRef.current && zipRef.current.click(),
								}, t("btn.importZip")),
								h(Btn, {
									tiny: true,
									disabled: busy,
									onClick: () => folderRef.current && folderRef.current.click(),
								}, t("btn.importFolder")),
							),
						),
					),
					h("div", { className: "dshp-editor" },
						editId ? [
							h("div", { key: "meta", className: "dshp-row" },
								h("input", {
									className: "dshp-field",
									placeholder: t("ph.skill.desc"),
									value: editDesc,
									onChange: (e) => setEditDesc(e.target.value),
								}),
							),
							h("textarea", {
								key: "body",
								className: "dshp-area",
								value: content,
								onChange: (e) => setContent(e.target.value),
								spellCheck: false,
								placeholder: "",
							}),
							h("div", { key: "save", className: "dshp-row" },
								h(Btn, {
									kind: "primary",
									disabled: busy,
									onClick: () => doPost("save", { id: editId, content, description: editDesc }),
								}, t("btn.saveSkill")),
								noticeNode(notice),
							),
						] : h("div", { className: "dshp-editor-empty" }, t("skills.pick")),
					),
				),
			);
		}

		function reopenAfterRestart() {
			window.location.reload();
		}

		function waitForRestart(setNotice, setBusy, t) {
			const started = Date.now();
			// 먼저 이전 프로세스가 끊긴 것을 확인한 뒤 새 프로세스 준비를 기다려야 한다; 그렇지 않으면 같은 프로세스가 즉시 200을 주는 것을 '재시작 성공'으로 오인해 재시작 창을 또 띄운다.
			let sawDown = false;
			const ping = () => {
				fetch("/dsh-purge/status", { cache: "no-store", credentials: "same-origin" })
					.then((r) => (r.ok ? r.json() : Promise.reject()))
					.then((d) => {
						if (!sawDown) {
							retry();
							return;
						}
						if (d && d.ok && d.ready !== false) reopenAfterRestart();
						else retry();
					})
					.catch(() => {
						sawDown = true;
						retry();
					});
			};
			const retry = () => {
				if (Date.now() - started > 90000) {
					setNotice({ kind: "error", text: t("restart.timeout") });
					setBusy(false);
					return;
				}
				setTimeout(ping, 500);
			};
			setTimeout(ping, 800);
		}

		let restartOnce = false;

		function restartDsh(setNotice, setBusy, t, surface) {
			if (restartOnce) return;
			const surf = surface || clientGuessSurface() || "desktop";
			const desktop = surf === "desktop" || clientGuessSurface() === "desktop";
			restartOnce = true;
			setBusy(true);
			setNotice({ kind: "ok", text: hostText(t, "restarting", surf) });
			const stop = (error) => {
				restartOnce = false;
				setNotice({ kind: "error", text: error ? t("restart.fail", { error }) : t("restart.notStarted") });
				setBusy(false);
			};
			let sawDrop = false;
			const watch = setTimeout(() => {
				if (sawDrop) return;
				stop("");
			}, 25000);
			fetch("/dsh-purge/restart", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })
				.then((r) => r.json())
				.then((d) => {
					if (!d.ok) throw new Error(d.error || "restart failed");
					const next = (d && d.surface) || surf;
					const full = next === "desktop" || (d && d.fullApp) || desktop;
					if (full && d.already) {
						setNotice({ kind: "ok", text: hostText(t, "restarting", next) });
						return;
					}
					if (full && d.restarting === false) {
						clearTimeout(watch);
						stop(d.error || "not started");
						return;
					}
					setNotice({ kind: "ok", text: hostText(t, "restarting", next) });
					if (full) return;
					clearTimeout(watch);
					restartOnce = false;
					waitForRestart(setNotice, setBusy, t);
				})
				.catch((e) => {
					const msg = String((e && e.message) || e || "");
					const dropped = /failed to fetch|networkerror|load failed/i.test(msg) || e.name === "TypeError";
					if (dropped && desktop) {
						sawDrop = true;
						clearTimeout(watch);
						return;
					}
					clearTimeout(watch);
					stop(msg || "restart failed");
				});
		}

		function detectHostTheme() {
			try {
				if (typeof document !== "undefined") {
					const root = document.documentElement;
					if (document.body?.hasAttribute("data-ds-dark-theme") || root?.hasAttribute("data-ds-dark-theme")) return "dusk";
					const scheme = (root.style.colorScheme || getComputedStyle(root).colorScheme || getComputedStyle(root).getPropertyValue("color-scheme") || "").toLowerCase();
					if (scheme.includes("dark")) return "dusk";
					if (scheme.includes("light")) return "white";
				}
				if (typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: dark)").matches) {
					return "dusk";
				}
			} catch { /* ignore */ }
			return "white";
		}

		function readTheme() {
			return detectHostTheme();
		}

		function SettingsRoot(props) {
			const t = typeof props.t === "function" ? props.t : ((key) => key);
			const [theme, setTheme] = useState(readTheme);
			useEffect(() => {
				let cancelled = false;
				let timer = 0;
				const syncFromHost = () => {
					if (!cancelled) setTheme(detectHostTheme());
				};
				const syncSoon = () => {
					if (timer) window.clearTimeout(timer);
					timer = window.setTimeout(syncFromHost, 50);
				};
				syncFromHost();
				let mq;
				try {
					mq = window.matchMedia?.("(prefers-color-scheme: dark)");
					mq?.addEventListener?.("change", syncFromHost);
				} catch { /* ignore */ }
				let obs;
				try {
					obs = new MutationObserver(syncSoon);
					if (document.body) obs.observe(document.body, { attributes: true, attributeFilter: ["data-ds-dark-theme", "class", "style"] });
					obs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-ds-dark-theme", "class", "style"] });
				} catch { /* ignore */ }
				return () => {
					cancelled = true;
					if (timer) window.clearTimeout(timer);
					try { mq?.removeEventListener?.("change", syncFromHost); } catch { /* ignore */ }
					try { obs?.disconnect(); } catch { /* ignore */ }
				};
			}, []);
			translate = t;
			return h("div", { className: "dshp-root", "data-theme": theme },
				h("style", null, PURGE_CSS),
				h(PurgifySection, null),
				h(RulesSection, null),
			);
		}

		const REWIND_CSS = `
.dshp-rewind-wrap{position:relative;display:inline-flex}
.dshp-rewind{appearance:none;display:inline-flex;align-items:center;gap:4px;height:28px;padding:0 8px;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary,currentColor);font:12px/1 var(--ds-font-sans,system-ui,sans-serif);cursor:pointer}
.dshp-rewind:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12));color:var(--dsw-alias-label-primary,currentColor)}
.dshp-rewind:disabled{opacity:.4;cursor:default}
.dshp-rewind svg{display:block}
.dshp-rewind-menu{position:fixed;z-index:2147483000;box-sizing:border-box;min-width:220px;padding:4px;border:0;border-radius:12px;background:var(--dsw-specific-menu,#fff);color:var(--dsw-alias-label-primary,#1a1a1a);--dsw-elevation-stroke-color:var(--dsw-alias-border-l1);box-shadow:var(--dsw-elevation-prominent,0 8px 24px rgba(0,0,0,.16));transform:translateY(-100%)}
body[data-ds-dark-theme] .dshp-rewind-menu{background:var(--dsw-specific-menu,#32312d);color:var(--dsw-alias-label-primary,#e6e2db);--dsw-elevation-stroke-color:var(--dsw-alias-border-l1,#3f3d38);box-shadow:var(--dsw-elevation-prominent,0 10px 28px rgba(0,0,0,.45))}
.dshp-rewind-item{display:flex;flex-direction:column;gap:2px;width:100%;padding:8px 10px;border:0;border-radius:8px;background:transparent;color:inherit;text-align:left;cursor:pointer;font:12px/1.3 var(--ds-font-sans,system-ui,sans-serif)}
.dshp-rewind-item:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}
.dshp-rewind-item b{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary,inherit)}
.dshp-rewind-item span{color:var(--dsw-alias-label-tertiary,#9a958c);font-size:11px}
body[data-ds-dark-theme] .dshp-rewind-item span{color:var(--dsw-alias-label-tertiary,#a8a39a)}
.dshp-continue{appearance:none;display:inline-flex;align-items:center;gap:4px;height:28px;padding:0 8px;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary,currentColor);font:12px/1 var(--ds-font-sans,system-ui,sans-serif);cursor:pointer}
.dshp-continue:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12));color:var(--dsw-alias-label-primary,currentColor)}
.dshp-continue:disabled{opacity:.4;cursor:default}
.dshp-continue.is-ready{color:var(--dsw-alias-label-primary,currentColor)}
.dshp-continue svg{display:block}
`;
		const DRAFT_KEY = "dshp-rewind-draft:";
		const ARM_KEY = "dshp-rewind-arm:";
		const FILL_DELAYS = [0, 50, 180, 400, 800];
		const ARM_TTL_MS = 45 * 1000;
		let rewindSeenAt = 0;
		let rewindSessions = null;
		let rewindHost = null;
		let rewindWorkspace = null;
		let rewindConversation = null;
		let pendingComposer = { sessionId: "", text: "", at: 0 };
		let armedFill = { sessionId: "", text: "", at: 0 };

		function rewindText(t, key, fallback) {
			try {
				if (typeof t === "function") {
					const value = t(key);
					if (value && value !== key) return value;
				}
			} catch { /* ignore */ }
			return fallback;
		}

		function currentSessionId(sessions) {
			try {
				const selected = rewindWorkspace?.selection?.getSnapshot?.()?.sessionId;
				if (typeof selected === "string" && selected) return selected;
			} catch { /* ignore */ }
			try {
				const snap = sessions?.list?.getSnapshot?.();
				if (typeof snap?.current === "string" && snap.current) return snap.current;
			} catch { /* ignore */ }
			return "";
		}

		function sessionKnown(sessions, sessionId) {
			try {
				const snap = sessions?.list?.getSnapshot?.();
				if (!snap || !sessionId) return false;
				if (snap.byId && Object.prototype.hasOwnProperty.call(snap.byId, sessionId)) return true;
				if (Array.isArray(snap.ids) && snap.ids.includes(sessionId)) return true;
			} catch { /* ignore */ }
			return false;
		}

		function waitMs(ms) {
			return new Promise((resolve) => window.setTimeout(resolve, ms));
		}

		function isPluginDraft(text) {
			const value = String(text || "").trim();
			if (!value) return false;
			return /^\[MNEMON\]/i.test(value)
				|| /MNEMON RUNTIME MEMORY SNAPSHOT/i.test(value)
				|| /^MNEMON VIEW TOOLS/im.test(value);
		}

		function writeDraft(sessionId, text) {
			if (!sessionId) return;
			const value = isPluginDraft(text) ? "" : (text || "");
			pendingComposer = { sessionId, text: value, at: Date.now() };
			try { sessionStorage.setItem(DRAFT_KEY + sessionId, value); } catch { /* ignore */ }
		}

		function peekDraft(sessionId) {
			if (!sessionId) return "";
			if (pendingComposer.sessionId === sessionId && pendingComposer.text) return pendingComposer.text;
			try { return sessionStorage.getItem(DRAFT_KEY + sessionId) || ""; } catch { return ""; }
		}

		function clearStoredDraft(sessionId) {
			if (!sessionId) return;
			if (pendingComposer.sessionId === sessionId) pendingComposer = { sessionId: "", text: "", at: 0 };
			try { sessionStorage.removeItem(DRAFT_KEY + sessionId); } catch { /* ignore */ }
			try { sessionStorage.removeItem(ARM_KEY + sessionId); } catch { /* ignore */ }
		}

		function armComposerFill(sessionId, text) {
			if (!sessionId || !text || isPluginDraft(text)) return;
			const at = Date.now();
			armedFill = { sessionId, text, at };
			writeDraft(sessionId, text);
			try { sessionStorage.setItem(ARM_KEY + sessionId, String(at)); } catch { /* ignore */ }
		}

		function takeArmedFill(sessionId) {
			if (!sessionId) return "";
			let text = "";
			let at = 0;
			if (armedFill.sessionId === sessionId && armedFill.text) {
				text = armedFill.text;
				at = armedFill.at;
			} else {
				text = peekDraft(sessionId);
				try { at = Number(sessionStorage.getItem(ARM_KEY + sessionId) || 0); } catch { at = 0; }
			}
			if (!text || !at || Date.now() - at > ARM_TTL_MS) {
				if (text && (!at || Date.now() - at > ARM_TTL_MS)) clearStoredDraft(sessionId);
				return "";
			}
			clearStoredDraft(sessionId);
			armedFill = { sessionId: "", text: "", at: 0 };
			return text;
		}

		function conversationFace() {
			if (rewindConversation) return rewindConversation;
			const host = rewindHost;
			if (host?.conversation) return host.conversation;
			if (typeof host?.get === "function") {
				try { return host.get("conversation"); } catch { return undefined; }
			}
			return undefined;
		}

		function conversationInput(sessionId) {
			try {
				const input = conversationFace()?.input;
				if (!input || !sessionId) return null;
				if (typeof input.shell === "function") {
					try { return input.shell(sessionId); } catch { /* session not retained yet */ }
				}
				const sessions = rewindHost?.sessions || rewindSessions;
				const actx = typeof sessions?.scope === "function" ? sessions.scope(sessionId) : undefined;
				if (typeof input.for === "function" && actx) return input.for(actx);
				return null;
			} catch {
				return null;
			}
		}

		function liveDraft(sessionId, inputActions) {
			try {
				const fromActions = inputActions?.state?.getSnapshot?.()?.draft;
				if (typeof fromActions === "string") return fromActions;
			} catch { /* ignore */ }
			try {
				const draft = conversationInput(sessionId)?.state?.getSnapshot?.()?.draft;
				if (typeof draft === "string") return draft;
			} catch { /* ignore */ }
			return "";
		}

		function hostSetDraft(sessionId, text) {
			if (!sessionId) return false;
			try {
				const input = conversationInput(sessionId);
				if (input && typeof input.setDraft === "function") {
					input.setDraft(text || "");
					return true;
				}
			} catch { /* ignore */ }
			return false;
		}

		function fillComposer(inputActions, text) {
			if (inputActions && typeof inputActions.setDraft === "function") {
				try { inputActions.setDraft(text || ""); } catch { /* ignore */ }
			}
		}

		function scheduleComposerFill(sessionId, text, inputActions) {
			if (!sessionId || !text || isPluginDraft(text)) return () => {};
			let stopped = false;
			let filled = false;
			const timers = [];
			const tryFill = () => {
				if (stopped) return;
				const current = liveDraft(sessionId, inputActions);
				if (filled && current !== text) {
					stopped = true;
					return;
				}
				if (current && current !== text) {
					stopped = true;
					return;
				}
				fillComposer(inputActions, text);
				hostSetDraft(sessionId, text);
				filled = true;
			};
			for (const ms of FILL_DELAYS) timers.push(window.setTimeout(tryFill, ms));
			return () => {
				stopped = true;
				for (const t of timers) { try { window.clearTimeout(t); } catch { /* ignore */ } }
			};
		}

		function scheduleEchoClear(sessionId, inputActions) {
			if (!sessionId) return () => {};
			let last = "";
			let stopped = false;
			const timers = [];
			const tryClear = () => {
				if (stopped || !last) return;
				const current = String(liveDraft(sessionId, inputActions) || "").trim();
				if (!current) {
					stopped = true;
					return;
				}
				if (current !== last) return;
				fillComposer(inputActions, "");
				hostSetDraft(sessionId, "");
				clearStoredDraft(sessionId);
				stopped = true;
			};
			apiJson("/dsh-purge/last-user?sessionId=" + encodeURIComponent(sessionId)).then((data) => {
				if (stopped) return;
				last = String(data?.text || "").trim();
				if (!last || isPluginDraft(last)) return;
				tryClear();
				for (const ms of [0, 50, 180, 400]) timers.push(window.setTimeout(tryClear, ms));
			}).catch(() => {});
			return () => {
				stopped = true;
				for (const t of timers) { try { window.clearTimeout(t); } catch { /* ignore */ } }
			};
		}

		async function dropInheritedQueue(sessions, sessionId) {
			if (!sessions || !sessionId) return;
			const drop = async () => {
				try {
					const actx = typeof sessions.scope === "function" ? sessions.scope(sessionId) : undefined;
					const face = typeof sessions.sessionOf === "function" ? sessions.sessionOf(actx) : undefined;
					const queue = face?.getSnapshot?.()?.queue || [];
					for (const item of queue) {
						const id = item?.id || item?.itemId;
						if (!id) continue;
						try { await face.updateQueue?.(id, { kind: "remove" }); } catch { /* ignore */ }
					}
				} catch { /* ignore */ }
			};
			await drop();
			window.setTimeout(() => { drop(); }, 80);
		}

		async function openRewoundSession(sessions, sessionId) {
			if (!sessionId) return;
			const workspace = rewindWorkspace;
			let lastError = null;
			for (let attempt = 0; attempt < 25; attempt += 1) {
				if (sessions && typeof sessions.refresh === "function" && !sessionKnown(sessions, sessionId)) {
					try { await sessions.refresh(); } catch (error) { lastError = error; }
				}
				const known = sessionKnown(sessions, sessionId);
				if (known || typeof sessions?.open === "function") {
					try {
						if (workspace && typeof workspace.openSession === "function") {
							workspace.openSession(sessionId);
						} else if (typeof sessions?.open === "function") {
							sessions.open(sessionId);
						} else {
							throw new Error("Cannot open the rewound session");
						}
						const selected = workspace?.selection?.getSnapshot?.()?.sessionId;
						if (!workspace || selected === sessionId) {
							await dropInheritedQueue(sessions, sessionId);
							window.setTimeout(() => { dropInheritedQueue(sessions, sessionId); }, 250);
							return;
						}
					} catch (error) {
						lastError = error;
					}
				}
				await waitMs(120);
			}
			throw new Error((lastError && lastError.message) || "The rewound session did not open");
		}

		class RewindSafe extends Component {
			constructor(p) { super(p); this.state = { failed: false }; }
			static getDerivedStateFromError() { return { failed: true }; }
			componentDidCatch(error) { try { console.error("[dsh-purge] rewind slot:", error); } catch { /* ignore */ } }
			render() {
				if (this.state.failed) return h(RewindFallback, this.props);
				return h(RewindButton, this.props);
			}
		}

		class ContinueSafe extends Component {
			constructor(p) { super(p); this.state = { failed: false }; }
			static getDerivedStateFromError() { return { failed: true }; }
			componentDidCatch(error) { try { console.error("[dsh-purge] continue slot:", error); } catch { /* ignore */ } }
			render() {
				if (this.state.failed) {
					return h("button", {
						type: "button",
						className: "dshp-continue",
						title: rewindText(translate, "continue.label", "Continue"),
						onMouseDown: (e) => e.preventDefault(),
						onClick: async () => {
							const sessionId = currentSessionId(rewindSessions);
							if (!sessionId) return;
							try {
								const data = await apiJson("/dsh-purge/continue", {
									method: "POST",
									headers: { "content-type": "application/json" },
									body: JSON.stringify({ sessionId, force: true }),
								});
								if (!data || !data.ok) throw new Error((data && data.error) || "continue");
							} catch (e) {
								window.alert(rewindText(translate, "continue.fail", "Continue failed: {error}").replace("{error}", String((e && e.message) || e)));
							}
						},
					}, rewindText(translate, "continue.label", "Continue"));
				}
				return h(ContinueButton, this.props);
			}
		}

		function ContinueButton(props) {
			const t = props.t || translate;
			const sessions = rewindSessions;
			const sessionId = props.sessionId || currentSessionId(sessions);
			const [busy, setBusy] = useState(false);
			const [notice, setNotice] = useState("");
			const [info, setInfo] = useState(null);

			useEffect(() => {
				if (!sessionId) {
					setInfo(null);
					return;
				}
				let cancelled = false;
				const tick = () => {
					apiJson("/dsh-purge/continue?sessionId=" + encodeURIComponent(sessionId))
						.then((data) => { if (!cancelled && data && data.ok) setInfo(data); })
						.catch(() => {});
				};
				tick();
				const timer = window.setInterval(tick, 1200);
				return () => {
					cancelled = true;
					window.clearInterval(timer);
				};
			}, [sessionId]);

			const canContinue = Boolean(info && info.canContinue);
			const left = info ? Math.max(0, (info.continueMax || 0) - (info.continueUsed || 0)) : 0;
			const runContinue = async () => {
				if (!sessionId || busy || !canContinue) return;
				setBusy(true);
				setNotice("");
				try {
					const data = await apiJson("/dsh-purge/continue", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ sessionId }),
					});
					if (!data || !data.ok) throw new Error((data && data.error) || "continue");
					setInfo((prev) => prev ? { ...prev, ...data, canContinue: false, continueUsed: data.used } : data);
				} catch (e) {
					setNotice(rewindText(t, "continue.fail", "Continue failed: {error}").replace("{error}", String((e && e.message) || e)));
				} finally {
					setBusy(false);
				}
			};

			const label = busy
				? rewindText(t, "continue.busy", "Continuing…")
				: rewindText(t, "continue.label", "Continue");
			const title = notice
				|| (canContinue
					? rewindText(t, "continue.ready", "Continue ({left} left)").replace("{left}", String(left))
					: (info && info.reason && left <= 0
						? rewindText(t, "continue.limit", "Continue limit reached")
						: rewindText(t, "continue.aria", "Continue after an abnormal stop")));
			return h("button", {
				type: "button",
				className: "dshp-continue" + (canContinue ? " is-ready" : ""),
				title,
				"aria-label": rewindText(t, "continue.aria", "Continue after an abnormal stop"),
				disabled: busy || !sessionId || !canContinue,
				onMouseDown: (e) => e.preventDefault(),
				onClick: (e) => {
					e.preventDefault();
					e.stopPropagation();
					runContinue();
				},
			},
				h("svg", { viewBox: "0 0 16 16", width: "14", height: "14", "aria-hidden": true },
					h("path", { fill: "currentColor", d: "M4.2 2.8v10.4L13 8 4.2 2.8z" }),
				),
				label,
			);
		}

		function rewindMenuNode(t, menuPos, menuRef, runRewind) {
			const menu = h("div", {
				className: "dshp-rewind-menu",
				role: "menu",
				ref: menuRef,
				style: menuPos ? { left: menuPos.left + "px", top: menuPos.top + "px" } : { left: "8px", bottom: "48px", transform: "none" },
			},
				h("button", {
					type: "button",
					className: "dshp-rewind-item",
					onMouseDown: (e) => { e.preventDefault(); e.stopPropagation(); },
					onClick: (e) => { e.preventDefault(); e.stopPropagation(); runRewind("once"); },
				},
					h("b", null, rewindText(t, "rewind.once", "Undo last step")),
					h("span", null, rewindText(t, "rewind.once.hint", "Withdraw the last step into a new session that keeps earlier context; the line returns to the box")),
				),
				h("button", {
					type: "button",
					className: "dshp-rewind-item",
					onMouseDown: (e) => { e.preventDefault(); e.stopPropagation(); },
					onClick: (e) => { e.preventDefault(); e.stopPropagation(); runRewind("round"); },
				},
					h("b", null, rewindText(t, "rewind.round", "Undo last turn")),
					h("span", null, rewindText(t, "rewind.round.hint", "Withdraw the last turn (and its subagents) into a new session that keeps earlier context; the line returns to the box")),
				),
			);
			try {
				const rd = require("react-dom");
				if (rd && typeof rd.createPortal === "function" && typeof document !== "undefined") {
					return rd.createPortal(menu, document.body);
				}
			} catch { /* portal이 없으면 메뉴는 여전히 버튼 옆에 붙는다 */ }
			return menu;
		}

		class RewindFallback extends Component {
			constructor(p) {
				super(p);
				this.state = { menu: false, busy: false, notice: "", menuPos: null };
				this.wrap = null;
				this.menuEl = null;
				this.onDoc = (event) => {
					if (this.wrap && this.wrap.contains(event.target)) return;
					if (this.menuEl && this.menuEl.contains(event.target)) return;
					this.setState({ menu: false });
				};
			}
			componentDidMount() {
				document.addEventListener("mousedown", this.onDoc);
			}
			componentWillUnmount() {
				document.removeEventListener("mousedown", this.onDoc);
			}
			run(mode) {
				const sessionId = this.props.sessionId || currentSessionId(rewindSessions);
				if (!sessionId || this.state.busy) return;
				this.setState({ busy: true, menu: false, notice: "" });
				apiJson("/dsh-purge/rewind", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ sessionId, mode }),
				}).then(async (data) => {
					if (!data || !data.ok || !data.sessionId || data.cleared === false) {
						throw new Error((data && data.error) || "The previously sent content was not cleared");
					}
					if (data.at) rewindSeenAt = data.at;
					const text = isPluginDraft(data.text) ? "" : (data.text || "");
					armComposerFill(data.sessionId, text);
					await openRewoundSession(rewindSessions, data.sessionId);
					scheduleComposerFill(data.sessionId, text);
					this.setState({ busy: false });
				}).catch((e) => {
					this.setState({
						busy: false,
						notice: "Undo failed: " + String((e && e.message) || e),
					});
				});
			}
			openMenu() {
				const rect = this.wrap && this.wrap.getBoundingClientRect ? this.wrap.getBoundingClientRect() : null;
				this.setState({
					menu: !this.state.menu,
					notice: "",
					menuPos: rect ? { left: Math.max(8, rect.right - 228), top: Math.max(8, rect.top - 8) } : null,
				});
			}
			render() {
				const sessionId = this.props.sessionId || currentSessionId(rewindSessions);
				const t = this.props.t || translate;
				const label = this.state.busy ? "Undoing…" : (this.state.notice ? this.state.notice.slice(0, 18) : "Undo");
				return h("div", { className: "dshp-rewind-wrap", ref: (node) => { this.wrap = node; } },
					h("style", null, REWIND_CSS),
					h("button", {
						type: "button",
						className: "dshp-rewind",
						disabled: this.state.busy || !sessionId,
						onMouseDown: (e) => e.preventDefault(),
						onClick: (e) => { e.preventDefault(); this.openMenu(); },
					}, label),
					this.state.menu ? rewindMenuNode(t, this.state.menuPos, (node) => { this.menuEl = node; }, (mode) => this.run(mode)) : null,
				);
			}
		}

		function RewindButton(props) {
			const t = props.t || translate;
			const sessions = rewindSessions;
			const inputActions = props.inputActions;
			const sessionId = props.sessionId || currentSessionId(sessions);
			const wrapRef = useRef(null);
			const menuRef = useRef(null);
			const [busy, setBusy] = useState(false);
			const [notice, setNotice] = useState("");
			const [menu, setMenu] = useState(false);
			const [menuPos, setMenuPos] = useState(null);

			useEffect(() => {
				if (!sessionId) return;
				const armed = takeArmedFill(sessionId);
				if (armed) {
					scheduleComposerFill(sessionId, armed, inputActions);
					return;
				}
				scheduleEchoClear(sessionId, inputActions);
			}, [sessionId, inputActions]);

			useEffect(() => {
				if (!menu) return;
				const onDoc = (event) => {
					if (wrapRef.current && wrapRef.current.contains(event.target)) return;
					if (menuRef.current && menuRef.current.contains(event.target)) return;
					setMenu(false);
				};
				document.addEventListener("mousedown", onDoc);
				return () => document.removeEventListener("mousedown", onDoc);
			}, [menu]);

			const runRewind = async (mode) => {
				if (!sessionId || busy) return;
				setBusy(true);
				setMenu(false);
				setNotice("");
				try {
					const data = await apiJson("/dsh-purge/rewind", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ sessionId, mode }),
					});
					if (!data || !data.ok || !data.sessionId || data.cleared === false) {
						throw new Error((data && data.error) || "The previously sent content was not cleared");
					}
					if (data.at) rewindSeenAt = data.at;
					const text = isPluginDraft(data.text) ? "" : (data.text || "");
					armComposerFill(data.sessionId, text);
					await openRewoundSession(sessions, data.sessionId);
					scheduleComposerFill(data.sessionId, text);
				} catch (e) {
					const message = rewindText(t, "rewind.fail", "Undo failed: {error}").replace("{error}", String((e && e.message) || e));
					setNotice(message);
				} finally {
					setBusy(false);
				}
			};

			const onClick = (event) => {
				event?.preventDefault?.();
				event?.stopPropagation?.();
				if (!sessionId || busy) return;
				if (menu) {
					setMenu(false);
					return;
				}
				const rect = wrapRef.current?.getBoundingClientRect?.();
				if (rect) {
					setMenuPos({
						left: Math.max(8, rect.right - 228),
						top: Math.max(8, rect.top - 8),
					});
				}
				setNotice("");
				setMenu(true);
			};

			const failLabel = notice
				? (notice.length > 18 ? notice.slice(0, 18) + "…" : notice)
				: "";
			const label = busy
				? rewindText(t, "rewind.busy", "Undoing…")
				: (failLabel || rewindText(t, "rewind.label", "Undo"));
			const title = notice || rewindText(t, "rewind.aria", "Undo");
			return h("div", { className: "dshp-rewind-wrap", ref: wrapRef },
				h("style", null, REWIND_CSS),
				h("button", {
					type: "button",
					className: "dshp-rewind",
					title,
					"aria-label": rewindText(t, "rewind.aria", "Undo"),
					"aria-expanded": menu ? "true" : "false",
					disabled: busy || !sessionId,
					onMouseDown: (e) => e.preventDefault(),
					onClick,
				},
					h("svg", { viewBox: "0 0 16 16", width: "14", height: "14", "aria-hidden": true },
						h("path", {
							fill: "currentColor",
							d: "M7.2 3.2 3.4 7l3.8 3.8V8.6c2.8 0 4.7.7 5.9 2.3-.2-2.8-1.9-5.2-5.9-5.6V3.2z",
						}),
					),
					label,
				),
				menu ? rewindMenuNode(t, menuPos, menuRef, runRewind) : null,
			);
		}

		function installRewindWatch(ctx) {
			const sessions = ctx.sessions;
			if (!sessions) return () => {};
			const tick = async () => {
				try {
					const data = await apiJson("/dsh-purge/rewind");
					if (!data || !data.sessionId || !data.at || data.at <= rewindSeenAt) return;
					rewindSeenAt = data.at;
					const current = currentSessionId(sessions);
					if (current && current !== data.parentId) return;
					const text = isPluginDraft(data.text) ? "" : (data.text || "");
					armComposerFill(data.sessionId, text);
					scheduleComposerFill(data.sessionId, text);
					await openRewoundSession(sessions, data.sessionId);
					scheduleComposerFill(data.sessionId, text);
				} catch { /* ignore */ }
			};
			const timer = window.setInterval(tick, 1200);
			return () => window.clearInterval(timer);
		}

		/* __DSH_PURGE_DRILL_BEGIN__ */
		// 내장 드릴 콘솔 (소스는 lib/redteam, 이미 이 플러그인에 병합됨)
		const __dshPurgeDrill = (() => {
			var module = { exports: {} };
			var exports = module.exports;

    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement

    /*
     * 드릴 콘솔 자체는 플로팅 창이다: position:fixed, left/top/width/height 로 배치한다.
     * 공식 frame 에 padding 을 넣지 않고, 공식 입력 상자의 너비도 바꾸지 않는다. 정리 패널에 embed 될 때는 .rt-embedded 를 쓴다.
     */
    const CSS = `
.rt-dock{position:fixed;top:12px;right:12px;z-index:20;display:flex;flex-direction:column;box-sizing:border-box;
  --rt-glass:blur(18px) saturate(1.35);--rt-ease:cubic-bezier(.22,1,.36,1);
  --rt-paper:color-mix(in srgb,var(--dsw-alias-bg-layer-1,#fffcf7) 46%,transparent);
  --rt-paper-2:color-mix(in srgb,var(--dsw-alias-bg-layer-2,#f3f0e8) 38%,transparent);
  --rt-well:color-mix(in srgb,var(--dsw-alias-bg-layer-1,#fff) 32%,transparent);
  --rt-fill:color-mix(in srgb,var(--dsw-alias-brand-primary,#6dbf8c) 14%,transparent);
  --rt-line:color-mix(in srgb,var(--dsw-alias-brand-primary,#6d8f78) 34%,transparent);
  --rt-line-2:color-mix(in srgb,var(--dsw-alias-brand-primary,#6d8f78) 50%,transparent);
  --rt-hi:color-mix(in srgb,#fff 42%,transparent);
  --rt-ink:var(--dsw-alias-label-primary,#16140f);
  --rt-mute:color-mix(in srgb,var(--dsw-alias-label-primary,#16140f) 72%,var(--dsw-alias-label-secondary,#5c564c));
  --rt-accent:var(--dsw-alias-brand-primary,#3d8f68);
  --rt-ok:#2f6b4f;--rt-warn:#8a5a12;--rt-bad:#9a3434;
  background:var(--rt-paper);
  backdrop-filter:var(--rt-glass);-webkit-backdrop-filter:var(--rt-glass);
  border:1px solid var(--rt-line);
  border-radius:12px;
  box-shadow:inset 0 1px 0 var(--rt-hi),0 16px 40px color-mix(in srgb,#000 16%,transparent);
  pointer-events:auto;color:var(--rt-ink);font-family:inherit;font-size:13px;line-height:1.5}
.rt-dock.rt-embedded{position:relative;inset:auto;width:100%;height:100%;max-width:none;border:0;border-radius:0;box-shadow:none;background:transparent!important;backdrop-filter:none;-webkit-backdrop-filter:none}
.rt-grip,.rt-resize-r,.rt-resize-b,.rt-resize-c{position:absolute;z-index:3;touch-action:none}
.rt-grip{left:-3px;top:0;bottom:0;width:8px;cursor:ew-resize;background:transparent}
.rt-resize-r{right:-3px;top:0;bottom:14px;width:8px;cursor:ew-resize}
.rt-resize-b{left:8px;right:14px;bottom:-3px;height:8px;cursor:ns-resize}
.rt-resize-c{right:0;bottom:0;width:16px;height:16px;cursor:nwse-resize}
.rt-head{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.rt-title{font-weight:600;font-size:14px;display:flex;align-items:center;gap:6px;white-space:nowrap}
.rt-dot{width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-brand-primary)}
.rt-spacer{flex:1}
.rt-btn{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:inherit;
  border-radius:6px;padding:3px 9px;font-size:12px;cursor:pointer;font-family:system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;white-space:nowrap;-webkit-text-fill-color:currentColor;overflow:visible}
.rt-btn:hover{border-color:var(--dsw-alias-border-l2)}
.rt-btn-primary{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:#fff;-webkit-text-fill-color:#fff}
.rt-btn-primary:hover{opacity:.9}
.rt-btn:disabled{opacity:.5;cursor:default}
.rt-tabs{display:flex;flex-wrap:wrap;gap:2px;padding:6px 12px 0;border-bottom:1px solid var(--dsw-alias-border-l1)}
.rt-tab{padding:8px 10px 7px;border-radius:0;cursor:pointer;font-size:12.5px;color:var(--dsw-alias-label-secondary);
  display:inline-flex;align-items:center;gap:5px;border-bottom:2px solid transparent;margin-bottom:-1px;background:transparent}
.rt-tab:hover{color:var(--dsw-alias-label-primary)}
.rt-tab.on{color:var(--dsw-alias-label-primary);background:transparent;font-weight:600;border-bottom-color:var(--dsw-alias-brand-primary,#6dbf8c)}
/* 미확인 빨간 점: 해당 탭에 새 내용(새 자산/새 취약점/새 점수/새 단계…)이 생기면, 열어 본 뒤 사라진다 */
.rt-tab-dot{width:7px;height:7px;border-radius:50%;background:#ef4444;flex:none;
  box-shadow:0 0 0 2px color-mix(in srgb, #ef4444 22%, transparent)}
.rt-body{flex:1;min-height:0;display:flex;flex-direction:column}
.rt-split{flex:1;min-height:0;display:flex}
.rt-side{width:200px;flex:none;border-right:1px solid var(--dsw-alias-border-l1);overflow:auto;padding:8px}
.rt-main{flex:1;min-width:0;min-height:0;display:flex;flex-direction:column;overflow:hidden}
.rt-seg{padding:7px 8px;border-radius:6px;cursor:pointer;margin-bottom:4px;border:1px solid transparent}
.rt-seg:hover{background:var(--dsw-alias-bg-layer-2)}
.rt-seg.on{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-brand-primary)}
.rt-seg-cidr{font-family:ui-monospace,Menlo,monospace;font-size:12.5px}
.rt-seg-meta{font-size:11px;color:var(--dsw-alias-label-secondary);margin-top:2px}
.rt-toolbar{display:flex;gap:6px;padding:8px 10px;border-bottom:1px solid var(--dsw-alias-border-l1);flex-wrap:wrap;align-items:center}
.rt-input{background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);color:inherit;
  border-radius:6px;padding:4px 8px;font-size:12px;font-family:inherit;outline:none;min-width:0}
.rt-input:focus{border-color:var(--dsw-alias-brand-primary)}
.rt-input option,.rt-eng-select option{background:var(--dsw-alias-bg-layer-1,#1c1c1c);color:var(--dsw-alias-label-primary,#f2f2f2)}
.rt-eng-select{color:var(--dsw-alias-label-primary,#f2f2f2);background:var(--dsw-alias-bg-layer-2,#2a2a2a)}
.rt-table{flex:1;overflow:auto}
.rt-row{display:grid;grid-template-columns:150px 74px 104px 1.15fr 1fr;gap:8px;padding:6px 10px;
  border-bottom:1px solid var(--dsw-alias-border-l1);align-items:center;cursor:pointer;font-size:12.5px}
.rt-row:hover{background:var(--dsw-alias-bg-layer-2)}
.rt-row.head{cursor:default;color:var(--dsw-alias-label-secondary);font-size:11.5px;font-weight:600;position:sticky;top:0;
  background:var(--dsw-alias-bg-layer-1);z-index:1}
.rt-row.head:hover{background:var(--dsw-alias-bg-layer-1)}
.rt-mono{font-family:ui-monospace,Menlo,monospace}
.rt-tag{display:inline-block;padding:0 5px;border-radius:4px;font-size:11px;margin-right:4px;
  border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);white-space:nowrap}
.rt-tag-passive{color:#8b5cf6;border-color:#8b5cf655;background:#8b5cf61a}
.rt-tag-active{color:#f59e0b;border-color:#f59e0b55;background:#f59e0b1a}
.rt-tag-live{color:#10b981;border-color:#10b98155;background:#10b9811a}
.rt-tag-warn{color:#ef4444;border-color:#ef444455;background:#ef44441a}
/* 규율 알림 띠: 납품 요건 미충족(Behinder/Godzilla 웹셸 아님, suo5 터널 없음) 시 블록 최상단에 고정된다 */
.rt-hint{border-radius:6px;padding:7px 9px;margin-bottom:8px;font-size:11.5px;line-height:1.6;
  border:1px dashed #ef444488;background:#ef44440f;color:var(--dsw-alias-label-primary)}
.rt-hint b{color:#ef4444}
.rt-tag-dead{color:var(--dsw-alias-label-secondary)}
.rt-expand{grid-column:1/-1;padding:8px 4px 10px;font-size:12px;color:var(--dsw-alias-label-secondary)}
.rt-kv{display:flex;gap:8px;margin-bottom:3px;align-items:baseline}
.rt-kv b{color:var(--dsw-alias-label-primary);font-weight:600;min-width:64px;flex:none}
/* 그래프 뷰는 제거됨 (AssetsTab 참고: 자산 관계는 "도메인 차원"과 redteam_attack_path 도구가 담당) */
.rt-pane{flex:1;min-height:0;overflow:auto;padding:12px}
.rt-card{border:1px solid color-mix(in srgb,var(--dsw-alias-border-l1,#444) 75%,transparent);border-radius:8px;padding:10px;margin-bottom:10px;
  background:color-mix(in srgb,var(--dsw-alias-bg-layer-2,#2a2a2a) 48%,transparent);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px)}
.rt-card h4{margin:0 0 6px;font-size:13px}
.rt-textarea{width:100%;min-height:260px;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);
  color:inherit;border-radius:6px;padding:8px;font-size:12.5px;font-family:ui-monospace,Menlo,monospace;
  line-height:1.6;resize:vertical;outline:none;box-sizing:border-box}
.rt-textarea:focus{border-color:var(--dsw-alias-brand-primary)}
.rt-list{width:210px;flex:none;border-right:1px solid var(--dsw-alias-border-l1);overflow:auto;padding:8px}
.rt-item{padding:7px 8px;border-radius:6px;cursor:pointer;margin-bottom:4px;border:1px solid transparent}
.rt-item:hover{background:var(--dsw-alias-bg-layer-2)}
.rt-item.on{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-brand-primary)}
.rt-item-name{font-weight:600;font-size:12.5px}
.rt-item-desc{font-size:11px;color:var(--dsw-alias-label-secondary);margin-top:2px;
  display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.rt-empty{padding:24px;text-align:center;color:var(--dsw-alias-label-secondary);font-size:12.5px}
.rt-err{color:var(--dsw-alias-state-error-primary);font-size:12px;padding:6px 10px}
.rt-foot{padding:8px 12px;border-top:1px solid var(--dsw-alias-border-l1);font-size:11px;
  color:var(--dsw-alias-label-secondary);display:flex;gap:12px;flex-wrap:wrap;align-items:center}
.rt-icon-btn{display:flex;align-items:center;justify-content:center;gap:6px;width:100%;border:1px solid var(--dsw-alias-border-l1);
  background:transparent;color:inherit;border-radius:6px;padding:6px 8px;cursor:pointer;font-family:inherit;font-size:12.5px}
.rt-icon-btn:hover{background:var(--dsw-alias-bg-layer-2)}
.rt-icon-btn.on{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.rt-hbtn{border:1px solid var(--dsw-alias-border-l1);background:transparent;color:inherit;border-radius:6px;
  padding:2px 8px;font-size:12px;cursor:pointer;font-family:inherit;display:flex;align-items:center;gap:5px}
.rt-hbtn:hover{background:var(--dsw-alias-bg-layer-2)}
.rt-hbtn.on{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.rt-test{display:inline-block;padding:0 5px;border-radius:4px;font-size:11px;white-space:nowrap;
  border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary)}
.rt-test-testing{color:#f59e0b;border-color:#f59e0b55;background:#f59e0b1a}
.rt-test-tested{color:#10b981;border-color:#10b98155;background:#10b9811a}
.rt-test-blocked{color:#fff;background:#ef4444;border-color:#ef4444}
.rt-test-abandoned{color:#94a3b8;border-color:#94a3b855;background:#94a3b81a}
.rt-test-no_surface{color:#6366f1;border-color:#6366f155;background:#6366f11a}
.rt-scope-testing{color:#5b21b6;background:#ddd6fe}
.rt-pri{display:inline-block;padding:0 6px;border-radius:4px;font-size:11px;font-weight:600;white-space:nowrap}
.rt-pri-high{color:#fff;background:#ef4444}
.rt-pri-medium{color:#fff;background:#f59e0b}
.rt-pri-low{color:#fff;background:#94a3b8}
.rt-score-row{display:grid;grid-template-columns:16px 62px minmax(0,1fr) 116px 66px;gap:8px;padding:7px 10px;
  border-bottom:1px solid var(--dsw-alias-border-l1);align-items:center;font-size:12.5px;cursor:pointer}
.rt-score-row:hover{background:var(--dsw-alias-bg-layer-2)}
.rt-score-row.head{cursor:default;color:var(--dsw-alias-label-secondary);font-size:11.5px;font-weight:600;
  position:sticky;top:0;background:var(--dsw-alias-bg-layer-1);z-index:1}
.rt-score-detail{grid-column:1/-1;padding:8px 4px 10px;font-size:12px;color:var(--dsw-alias-label-secondary)}
/* 점수 대상은 병합판의 8개 분류로 그룹화한다: 분류 헤더 + 그룹 내 점수 오름차순 */
.rt-score-group{display:flex;align-items:center;gap:8px;padding:7px 10px 5px;margin-top:2px;
  font-size:12px;font-weight:600;border-top:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2)}
.rt-score-group:first-child{border-top:none}
.rt-score-group .rt-sg-sub{font-weight:400;font-size:11px;color:var(--dsw-alias-label-secondary)}
/* ── 세션과 진입점: 각 카드는 "제목 줄 / 핵심 사실 / 사용 가능 명령 / 비고" 네 단으로 나눠, 한 줄에 뭉치지 않게 한다 ── */
.rt-sess-facts{display:flex;flex-direction:column;gap:2px;margin-top:5px}
.rt-sess-fact{display:flex;gap:6px;font-size:11.5px;line-height:1.5}
.rt-sess-fact>b{flex:none;min-width:62px;font-weight:600;color:var(--dsw-alias-label-secondary)}
.rt-sess-fact>span{min-width:0;overflow-wrap:anywhere}
.rt-sess-cmd{margin-top:6px}
.rt-sess-cmd>b{display:block;font-size:11px;color:var(--dsw-alias-label-secondary);margin-bottom:3px;font-weight:600}
.rt-sess-fold{margin-top:6px;font-size:11.5px}
.rt-sess-fold>summary{cursor:pointer;color:var(--dsw-alias-label-secondary);user-select:none}
.rt-sess-fold>summary:hover{color:var(--dsw-alias-label-primary)}
.rt-score-row .rt-scope{font-size:10.5px;color:var(--dsw-alias-label-secondary)}
.rt-score-form{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:6px}
.rt-score-form input,.rt-score-form select{width:100%;box-sizing:border-box}
.rt-vrow{display:grid;grid-template-columns:62px minmax(0,1fr) 132px 108px 74px 52px;gap:8px;padding:6px 10px;
  border-bottom:1px solid var(--dsw-alias-border-l1);align-items:center;font-size:12.5px;cursor:pointer}
.rt-vrow:hover{background:var(--dsw-alias-bg-layer-2)}
.rt-vrow.head{cursor:default;color:var(--dsw-alias-label-secondary);font-size:11.5px;font-weight:600;
  position:sticky;top:0;background:var(--dsw-alias-bg-layer-1);z-index:1}
.rt-vdetail{grid-column:1/-1;padding:8px 4px 10px;font-size:12px;color:var(--dsw-alias-label-secondary)}
.rt-vdetail .rt-kv{margin-bottom:4px}
.rt-actions{display:flex;gap:6px;margin-top:6px}
.rt-section{padding:8px 10px 2px;font-size:11.5px;font-weight:600;color:var(--dsw-alias-label-secondary)}
.rt-link{color:var(--dsw-alias-brand-primary);text-decoration:none;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rt-link:hover{text-decoration:underline}
.rt-full{position:fixed;inset:0;z-index:60;display:flex;flex-direction:column;
  --rt-glass:blur(18px) saturate(1.35);--rt-ease:cubic-bezier(.22,1,.36,1);
  --rt-paper:color-mix(in srgb,var(--dsw-alias-bg-layer-1,#fffcf7) 46%,transparent);
  --rt-paper-2:color-mix(in srgb,var(--dsw-alias-bg-layer-2,#f3f0e8) 38%,transparent);
  --rt-well:color-mix(in srgb,var(--dsw-alias-bg-layer-1,#fff) 32%,transparent);
  --rt-fill:color-mix(in srgb,var(--dsw-alias-brand-primary,#6dbf8c) 14%,transparent);
  --rt-line:color-mix(in srgb,var(--dsw-alias-brand-primary,#6d8f78) 34%,transparent);
  --rt-hi:color-mix(in srgb,#fff 42%,transparent);
  --rt-ink:var(--dsw-alias-label-primary,#16140f);
  --rt-mute:color-mix(in srgb,var(--dsw-alias-label-primary,#16140f) 72%,var(--dsw-alias-label-secondary,#5c564c));
  --rt-accent:var(--dsw-alias-brand-primary,#3d8f68);
  --rt-ok:#2f6b4f;--rt-warn:#8a5a12;--rt-bad:#9a3434;
  background:var(--rt-paper);color:var(--rt-ink);font-family:inherit;font-size:13px;line-height:1.5;
  backdrop-filter:var(--rt-glass);-webkit-backdrop-filter:var(--rt-glass);
  border:1px solid var(--rt-line);box-shadow:inset 0 1px 0 var(--rt-hi)}
.rt-full .rt-head{padding:12px 18px}
.rt-full .rt-tabs{padding:10px 18px 0;gap:6px;flex-wrap:wrap}
.rt-full .rt-side{width:260px}
.rt-full .rt-list{width:280px}
.rt-full .rt-row{grid-template-columns:190px 90px 130px 1.4fr 1.2fr}
.rt-full .rt-vrow{grid-template-columns:80px minmax(0,1.6fr) 200px 150px 90px 64px}
.rt-full .rt-pane{padding:18px}
.rt-full .rt-textarea{min-height:60vh}
.rt-full .rt-foot{padding:10px 18px;font-size:12px}
.rt-full .rt-body{max-width:1400px;width:100%;margin:0 auto;flex:1;min-height:0;display:flex;flex-direction:column}
.rt-chain{flex:1;overflow:auto;padding:10px 12px}
.rt-step{display:flex;gap:10px;padding:8px 6px;border-left:2px solid var(--dsw-alias-border-l1);margin-left:6px}
.rt-step:last-child{border-left-color:transparent}
.rt-step-dot{width:22px;height:22px;flex:none;border-radius:50%;display:flex;align-items:center;justify-content:center;
  font-size:11px;font-weight:700;color:#fff;background:#64748b;margin-left:-13px}
.rt-step-body{min-width:0}
.rt-step-title{font-weight:600;font-size:13px}
.rt-step-meta{font-size:11.5px;color:var(--dsw-alias-label-secondary);margin-top:2px;word-break:break-word}
.rt-stage-recon{background:#6366f1}
.rt-stage-vuln{background:#f59e0b}
.rt-stage-exploit{background:#ef4444}
.rt-stage-access{background:#10b981}
.rt-stage-pivot{background:#8b5cf6}
.rt-stage-data{background:#0ea5e9}
.rt-stage-other{background:#64748b}
.rt-step-head{display:flex;align-items:baseline;gap:6px;flex-wrap:wrap}
.rt-step-time{font-size:11px;color:var(--dsw-alias-label-secondary);margin-left:auto;white-space:nowrap}
.rt-step-detail{font-size:12px;margin-top:5px;white-space:pre-wrap;word-break:break-word;
  border-left:2px solid var(--dsw-alias-border-l1);padding:2px 0 2px 9px;line-height:1.6}
.rt-chip{display:inline-flex;align-items:center;gap:5px;font-size:11.5px;padding:1px 7px;border-radius:5px;
  border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);margin:4px 5px 0 0;max-width:100%}
.rt-chip>i{font-style:normal;color:var(--dsw-alias-label-secondary);font-size:10.5px}
.rt-chip>span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:420px}
.rt-stage-tag{display:inline-block;padding:0 6px;border-radius:4px;font-size:11px;color:#fff;font-weight:600}
.rt-st-recon{background:#6366f1}.rt-st-vuln{background:#f59e0b}.rt-st-exploit{background:#ef4444}
.rt-st-access{background:#10b981}.rt-st-pivot{background:#8b5cf6}.rt-st-data{background:#0ea5e9}.rt-st-other{background:#64748b}
.rt-sev{display:inline-block;padding:0 6px;border-radius:4px;font-size:11px;font-weight:600;border:1px solid transparent}
.rt-sev-critical{color:#fff;background:#b91c1c}.rt-sev-high{color:#fff;background:#ef4444}
.rt-sev-medium{color:#7c2d12;background:#fdba74}.rt-sev-low{color:#1e3a8a;background:#bfdbfe}
.rt-sev-info{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l1)}
.rt-dot-on{display:inline-block;width:7px;height:7px;border-radius:50%;background:#10b981;box-shadow:0 0 0 3px #10b98133}
.rt-dot-off{display:inline-block;width:7px;height:7px;border-radius:50%;background:#ef4444;box-shadow:0 0 0 3px #ef444433}
.rt-dot-unk{display:inline-block;width:7px;height:7px;border-radius:50%;background:#94a3b8;box-shadow:0 0 0 3px #94a3b833}
.rt-sess-grid{display:grid;grid-template-columns:1fr;gap:8px;padding:10px 12px}
.rt-sess{border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:9px 10px;background:var(--dsw-alias-bg-layer-2)}
.rt-sess-head{display:flex;align-items:center;gap:7px;flex-wrap:wrap}
.rt-sess-title{font-weight:600;font-size:12.5px;font-family:ui-monospace,Menlo,monospace;word-break:break-all}
.rt-sess-sub{font-size:11.5px;color:var(--dsw-alias-label-secondary);margin-top:3px;word-break:break-word}
.rt-code{font-family:ui-monospace,Menlo,monospace;font-size:11px;background:var(--dsw-alias-bg-base);
  border:1px solid var(--dsw-alias-border-l1);border-radius:4px;padding:1px 5px;cursor:pointer;word-break:break-all}
.rt-code:hover{border-color:var(--dsw-alias-brand-primary)}
.rt-evi{border:1px solid var(--dsw-alias-border-l1);border-radius:8px;overflow:hidden;margin-top:8px}
.rt-evi-head{display:flex;align-items:center;gap:8px;padding:5px 9px;background:var(--dsw-alias-bg-layer-2);
  font-size:11.5px;font-weight:600;border-bottom:1px solid var(--dsw-alias-border-l1)}
.rt-evi-body{margin:0;padding:9px 11px;font-family:ui-monospace,Menlo,monospace;font-size:11.5px;line-height:1.6;
  white-space:pre-wrap;word-break:break-word;max-height:340px;overflow:auto;background:var(--dsw-alias-bg-base)}
.rt-evi-body.req{max-height:220px}
.rt-hl-req{color:#10b981;font-weight:600}
.rt-hl-res{color:#0ea5e9;font-weight:600}
.rt-gain{display:inline-flex;align-items:center;gap:5px;font-size:11.5px;font-weight:600;padding:2px 8px;border-radius:12px;
  color:#065f46;background:#a7f3d0;border:1px solid #10b98155}
.rt-total{font-size:20px;font-weight:700;font-family:ui-monospace,Menlo,monospace}
.rt-sidehead{padding:7px 8px 2px;font-size:11px;font-weight:600;color:var(--dsw-alias-label-secondary);
  display:flex;align-items:center;gap:5px}
.rt-sidehead-btn{cursor:pointer;outline:none;padding:6px 6px 5px;border-radius:5px;user-select:none}
.rt-sidehead-btn:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1)}
.rt-sidehead-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.rt-scope{display:inline-block;padding:0 4px;border-radius:3px;font-size:10px;font-weight:700;line-height:15px;flex:none}
.rt-scope-internal{color:#0e7490;background:#a5f3fc}
.rt-scope-external{color:#9a3412;background:#fed7aa}
.rt-hits{display:flex;flex-direction:column;gap:6px;margin-top:7px}
.rt-hit{border:1px solid var(--dsw-alias-border-l1);border-left:3px solid #10b981;border-radius:6px;
  padding:7px 9px;background:var(--dsw-alias-bg-layer-2)}
.rt-hit-head{display:flex;align-items:center;gap:7px;flex-wrap:wrap}
.rt-hit-idx{width:16px;height:16px;border-radius:50%;background:#10b981;color:#fff;font-size:10.5px;font-weight:700;
  display:inline-flex;align-items:center;justify-content:center;flex:none}
.rt-hit-target{font-family:ui-monospace,Menlo,monospace;font-weight:600;font-size:12px;word-break:break-all}
.rt-hit-time{margin-left:auto;font-size:11px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.rt-hit-evi{font-family:ui-monospace,Menlo,monospace;font-size:11.5px;line-height:1.65;white-space:pre-wrap;word-break:break-word;
  background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);border-radius:5px;padding:6px 8px;margin-top:5px}
.rt-hit-note{font-size:11.5px;color:var(--dsw-alias-label-secondary);margin-top:4px}
.rt-cred{border:1px solid var(--dsw-alias-border-l1);border-left:3px solid #f59e0b;border-radius:6px;
  padding:8px 10px;background:var(--dsw-alias-bg-layer-2);margin-bottom:7px}
.rt-cred-head{display:flex;align-items:center;gap:7px;flex-wrap:wrap}
.rt-cred-host{font-family:ui-monospace,Menlo,monospace;font-weight:600;font-size:12.5px;word-break:break-all}
.rt-secret{font-family:ui-monospace,Menlo,monospace;font-size:12.5px;line-height:1.6;background:#fef3c7;color:#78350f;
  border:1px solid #f59e0b66;border-radius:5px;padding:6px 9px;margin-top:6px;white-space:pre-wrap;word-break:break-all;
  user-select:all;cursor:text}
.rt-secret-none{font-family:ui-monospace,Menlo,monospace;font-size:11.5px;color:var(--dsw-alias-state-error-primary);
  border:1px dashed var(--dsw-alias-state-error-primary);border-radius:5px;padding:5px 9px;margin-top:6px}
.rt-cred-meta{font-size:11.5px;color:var(--dsw-alias-label-secondary);margin-top:5px;word-break:break-word}
.rt-stage-score{background:#10b981}
.rt-counted{font-family:ui-monospace,Menlo,monospace;font-size:12px;font-weight:700;color:#065f46;background:#a7f3d0;border:1px solid #10b98155;border-radius:9px;padding:0 7px}
.rt-scorepts{font-size:11.5px;font-weight:700;color:#065f46;background:#a7f3d0;border:1px solid #10b98155;
  border-radius:10px;padding:0 7px;white-space:nowrap}
.rt-livebar{display:flex;align-items:center;gap:7px;padding:7px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);
  background:var(--dsw-alias-bg-layer-2);flex-wrap:wrap}
.rt-live-dot{width:8px;height:8px;border-radius:50%;background:#10b981;flex:none;animation:rt-pulse 1.6s ease-in-out infinite}
.rt-live-dot.idle{background:#94a3b8;animation:none}
@keyframes rt-pulse{0%,100%{opacity:1;box-shadow:0 0 0 0 #10b98166}50%{opacity:.5;box-shadow:0 0 0 5px #10b98100}}
.rt-live-body{padding:8px 12px 2px;max-height:44vh;overflow:auto}
.rt-atest{border:1px solid var(--dsw-alias-border-l1);border-left:3px solid #10b981;border-radius:6px;
  padding:7px 10px;background:var(--dsw-alias-bg-layer-2);margin-bottom:6px}
.rt-atest.past{border-left-color:#94a3b8;opacity:.85}
.rt-atest-head{display:flex;align-items:center;gap:7px;flex-wrap:wrap}
.rt-atest-ip{font-family:ui-monospace,Menlo,monospace;font-weight:600;font-size:12.5px;word-break:break-all}
.rt-atest-meta{font-size:11.5px;color:var(--dsw-alias-label-secondary);margin-top:3px;word-break:break-word}
.rt-atest-notes{font-family:ui-monospace,Menlo,monospace;font-size:11px;line-height:1.6;white-space:pre-wrap;
  word-break:break-word;background:var(--dsw-alias-bg-base);border-radius:4px;padding:5px 7px;margin-top:4px;max-height:76px;overflow:auto}
.rt-concl{display:flex;align-items:center;gap:4px;padding:6px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);
  background:var(--dsw-alias-bg-layer-2);flex-wrap:wrap}
.rt-concl-i{display:inline-flex;align-items:baseline;gap:4px;padding:2px 8px;border-radius:6px;cursor:pointer;
  border:1px solid transparent}
.rt-concl-i:hover{border-color:var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1)}
.rt-concl-i.on{border-color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-layer-1)}
.rt-concl-i b{font-family:ui-monospace,Menlo,monospace;font-size:14px;font-weight:700}
.rt-concl-i>span{color:var(--dsw-alias-label-secondary);font-size:11.5px}
.rt-more{color:var(--dsw-alias-brand-primary);font-size:11.5px;cursor:pointer;user-select:none;margin-top:4px;display:inline-block}
.rt-more:hover{text-decoration:underline}
.rt-subtabs{display:flex;gap:4px;padding:6px 10px 0;border-bottom:1px solid var(--dsw-alias-border-l1);align-items:center}
.rt-subtab{padding:4px 10px;border-radius:6px 6px 0 0;cursor:pointer;font-size:12px;color:var(--dsw-alias-label-secondary)}
.rt-subtab.on{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);font-weight:600}
.rt-sevbar{width:3px;border-radius:2px;align-self:stretch;flex:none;margin-right:2px}
/* ── 접힘 계층 체계 ─────────────────────────────────────────────────────────────
   L1 접힘 헤더 .rt-sec   : 전체 폭, 둥근 모서리와 테두리 없음, 왼쪽 색 띠, 어두운 배경 —— 언제나 "평평"하다
   L2 내용 카드 .rt-atest/.rt-hit/.rt-cred/.rt-evi : 안쪽으로 들여쓰고, 테두리와 둥근 모서리 —— 세워진다
   L3 상세/긴 텍스트 .rt-clip-body / .rt-evi-body : 테두리 없음, 가장 밝음, 고정폭
   L4 하위 항목 컨테이너 .rt-sec-body : 왼쪽 들여쓰기 + 세로 안내선, "위의 헤더에 속한다"를 나타낸다
   ──────────────────────────────────────────────────────────────────────────── */
.rt-sec-wrap{margin:0}
.rt-sec{display:flex;align-items:center;gap:8px;padding:7px 12px 7px 9px;cursor:pointer;
  background:var(--dsw-alias-bg-layer-2);border-left:3px solid var(--dsw-alias-border-l2);
  border-top:1px solid var(--dsw-alias-border-l1);user-select:none;outline:none}
.rt-sec:hover{background:var(--dsw-alias-bg-layer-1)}
.rt-sec:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.rt-sec.flat{cursor:default}
.rt-sec.flat:hover{background:var(--dsw-alias-bg-layer-2)}
.rt-sec-caret{flex:none;width:11px;font-size:10px;color:var(--dsw-alias-label-secondary);text-align:center}
.rt-sec-title{font-weight:600;font-size:13px;white-space:nowrap}
.rt-sec-count{font-size:11.5px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.rt-sec-sub{font-size:11.5px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rt-sec-right{margin-left:auto;font-size:11px;color:var(--dsw-alias-label-secondary);white-space:nowrap;flex:none}
.rt-sec.t-stage{border-left-color:#8b5cf6}
.rt-sec.t-target{border-left-color:#0ea5e9}
.rt-sec.t-folder{border-left-color:#64748b}
.rt-sec.t-test{border-left-color:#10b981}
.rt-sec.t-queue{border-left-color:#f59e0b}
.rt-sec.t-past{border-left-color:#94a3b8}
.rt-sec-body{margin-left:12px;border-left:1px solid var(--dsw-alias-border-l1);padding:7px 0 3px 10px}
.rt-sec-body>.rt-atest:last-child,.rt-sec-body>.rt-hit:last-child{margin-bottom:2px}
/* 긴 텍스트 접힘(L3): 기본은 2줄 미리보기에 페이드아웃, 펼치면 높이 제한 후 스크롤 */
.rt-clip{margin-top:6px}
.rt-clip-head{display:flex;align-items:center;gap:6px}
.rt-clip-label{font-size:11px;color:var(--dsw-alias-label-secondary);font-weight:600}
.rt-clip-body{font-family:ui-monospace,Menlo,monospace;font-size:11.5px;line-height:1.65;white-space:pre-wrap;
  word-break:break-word;background:var(--dsw-alias-bg-base);border-radius:5px;padding:6px 8px;margin-top:3px}
.rt-clip:not(.open) .rt-clip-body{max-height:46px;overflow:hidden;
  -webkit-mask-image:linear-gradient(180deg,#000 55%,transparent);mask-image:linear-gradient(180deg,#000 55%,transparent)}
.rt-clip.open .rt-clip-body{max-height:340px;overflow:auto}
.rt-flow{padding:10px 12px 16px}
.rt-flow-start,.rt-flow-end{font-size:11.5px;color:var(--dsw-alias-label-secondary);padding:4px 0}
.rt-flow-end{font-weight:600;color:var(--dsw-alias-label-primary)}
.rt-flow-link{display:flex;align-items:center;gap:8px;padding:3px 0 3px 10px}
.rt-flow-arrow{color:var(--dsw-alias-border-l2);font-size:11px;flex:none}
.rt-flow-action{font-size:11.5px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rt-flow-action.inferred{opacity:.7;font-style:italic}
.rt-flow-node{border:1px solid var(--dsw-alias-border-l1);border-left:3px solid #10b981;border-radius:8px;
  padding:8px 11px;background:var(--dsw-alias-bg-layer-2);cursor:pointer;outline:none}
.rt-flow-node:hover{border-color:var(--dsw-alias-border-l2)}
.rt-flow-node:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.rt-flow-node.overflow{border-left-color:#94a3b8;opacity:.75}
.rt-flow-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.rt-flow-idx{width:18px;height:18px;border-radius:50%;background:#10b981;color:#fff;font-size:11px;font-weight:700;
  display:inline-flex;align-items:center;justify-content:center;flex:none}
.rt-flow-node.overflow .rt-flow-idx{background:#94a3b8}
.rt-flow-name{font-weight:600;font-size:13px}
.rt-flow-pts{margin-left:auto;font-family:ui-monospace,Menlo,monospace;font-size:12.5px;font-weight:700;color:#065f46;
  background:#a7f3d0;border:1px solid #10b98155;border-radius:10px;padding:0 8px;white-space:nowrap}
.rt-flow-pts.off{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-1);border-color:var(--dsw-alias-border-l1)}
.rt-flow-times{font-size:11px;color:var(--dsw-alias-label-secondary)}
.rt-flow-target{font-family:ui-monospace,Menlo,monospace;font-size:11.5px;margin-top:4px;word-break:break-all;
  color:var(--dsw-alias-label-secondary)}
.rt-flow-gain{font-size:12px;margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rt-flow-detail{margin-top:7px;padding-top:7px;border-top:1px dashed var(--dsw-alias-border-l1)}
.rt-hflow-wrap{flex:1;min-height:0;display:flex;flex-direction:column;overflow:auto}
.rt-hflow{display:flex;align-items:center;gap:0;padding:16px 12px;overflow-x:auto;flex-wrap:nowrap}
.rt-hflow-item{display:flex;align-items:center;flex:none}
.rt-hflow-start,.rt-hflow-end{font-size:11.5px;color:var(--dsw-alias-label-secondary);white-space:nowrap;padding:0 4px}
.rt-hflow-end{font-weight:600;color:var(--dsw-alias-label-primary)}
.rt-hflow-arrow{color:var(--dsw-alias-border-l2);padding:0 5px;font-size:13px;flex:none}
.rt-hflow-node{display:flex;align-items:center;gap:5px;border:1px solid var(--dsw-alias-border-l1);
  border-left:3px solid #10b981;border-radius:7px;padding:5px 8px;background:var(--dsw-alias-bg-layer-2);
  cursor:pointer;white-space:nowrap;outline:none}
.rt-hflow-node:hover{border-color:var(--dsw-alias-border-l2)}
.rt-hflow-node:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.rt-hflow-node.overflow{border-left-color:#94a3b8;opacity:.72}
.rt-hflow-node.open{border-color:var(--dsw-alias-brand-primary)}
.rt-hflow-pts{font-family:ui-monospace,Menlo,monospace;font-size:11.5px;font-weight:700;color:#065f46;background:#a7f3d0;
  border-radius:8px;padding:0 6px}
.rt-hflow-node.overflow .rt-hflow-pts{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-1)}
.rt-hflow-name{font-size:11.5px}
.rt-hflow-n{font-size:10.5px;color:var(--dsw-alias-label-secondary)}
.rt-rep-list{padding:10px 12px 14px}
.rt-rep-tools{display:flex;gap:6px;justify-content:flex-end;margin-bottom:8px}
.rt-rep{border:1px solid var(--dsw-alias-border-l1);border-left:3px solid #10b981;border-radius:8px;
  padding:9px 11px;margin-bottom:10px;background:var(--dsw-alias-bg-layer-2)}
.rt-rep-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.rt-rep-idx{font-size:15px;color:#10b981;font-weight:700;flex:none}
.rt-rep-name{font-weight:600;font-size:13px}
.rt-rep-meta{font-size:12px;margin-top:4px;color:var(--dsw-alias-label-secondary);word-break:break-word}
.rt-rep-meta b{color:var(--dsw-alias-label-primary);font-weight:600;margin-right:2px}
.rt-rep-missing{font-size:11.5px;color:var(--dsw-alias-state-error-primary);margin-top:6px;
  border:1px dashed var(--dsw-alias-state-error-primary);border-radius:5px;padding:5px 8px}
.rt-rep-req{margin-top:7px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;overflow:hidden}
.rt-rep-req-head{display:flex;align-items:center;gap:7px;padding:4px 8px;font-size:11.5px;font-weight:600;
  background:var(--dsw-alias-bg-layer-1);border-bottom:1px solid var(--dsw-alias-border-l1)}
.rt-rep-http{margin:0;padding:8px 10px;font-family:ui-monospace,Menlo,monospace;font-size:11.5px;line-height:1.6;white-space:pre-wrap;word-break:break-word;max-height:240px;overflow:auto;background:var(--dsw-alias-bg-base)}
/* ── 보고서의 "이 단계는 어떻게 왔나": 동작 단계 / 명령 / 자격 증명 / 터널 ───────────── */
.rt-rep-trace{margin-top:8px;border:1px solid var(--dsw-alias-border-l1);border-radius:7px;padding:8px 10px;
  background:var(--dsw-alias-bg-base)}
.rt-rep-trace-head{display:flex;align-items:center;gap:7px;margin-bottom:5px}
.rt-rep-trace-title{font-weight:600;font-size:12.5px}
.rt-rep-trace-how{font-size:12px;color:var(--dsw-alias-label-secondary);margin-bottom:6px}
.rt-rep-step{border-left:2px solid var(--dsw-alias-border-l1);padding:2px 0 6px 9px;margin-bottom:6px}
.rt-rep-step-head{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.rt-rep-step-no{width:17px;height:17px;border-radius:50%;background:var(--dsw-alias-brand-primary);color:#fff;
  font-size:10.5px;display:flex;align-items:center;justify-content:center;flex:none}
.rt-rep-step-title{font-weight:600;font-size:12.5px}
.rt-rep-step-detail{font-size:12px;color:var(--dsw-alias-label-secondary);margin-top:2px}
.rt-rep-step-cmd{font-size:11.5px;margin-top:4px;display:flex;gap:6px;align-items:flex-start;flex-wrap:wrap}
.rt-rep-step-cmd .rt-mono{background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);
  border-radius:5px;padding:2px 6px;word-break:break-all}
.rt-rep-step-result{font-size:11.5px;margin-top:3px;word-break:break-word}
.rt-rep-src{margin-top:6px;padding-top:6px;border-top:1px dashed var(--dsw-alias-border-l1)}
.rt-rep-src-title{font-weight:600;font-size:12px;margin-bottom:3px}
/* ── 전 구간 공격 경로도 ─────────────────────────────────────────────── */
.rt-ap{padding:10px 12px 18px;overflow:auto}
.rt-ap-stage{margin-bottom:2px}
.rt-ap-head{display:flex;align-items:center;gap:8px;padding:7px 10px;background:var(--dsw-alias-bg-layer-2);
  border-left:4px solid #64748b;border-top:1px solid var(--dsw-alias-border-l1);border-radius:6px 6px 0 0}
.rt-ap-no{width:20px;height:20px;border-radius:5px;color:#fff;font-size:11px;font-weight:700;flex:none;
  display:inline-flex;align-items:center;justify-content:center}
.rt-ap-name{font-weight:700;font-size:13.5px}
.rt-ap-en{font-size:10px;color:var(--dsw-alias-label-secondary);letter-spacing:.3px}
.rt-ap-phase{font-size:10.5px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.rt-ap-goal{display:flex;align-items:baseline;gap:8px;padding:6px 10px 6px 9px;font-size:12px;
  border-left:4px solid #64748b;background:var(--dsw-alias-bg-layer-1)}
.rt-ap-goal-tag{font-size:10.5px;font-weight:700;border:1px solid;border-radius:4px;padding:0 5px;white-space:nowrap;flex:none}
.rt-ap-result{padding:7px 10px 3px;border-left:4px solid transparent}
.rt-ap-result-head{display:flex;align-items:center;gap:8px;margin-bottom:5px;flex-wrap:wrap}
.rt-ap-pts{font-family:ui-monospace,Menlo,monospace;font-size:11.5px;font-weight:700;color:#065f46;background:#a7f3d0;
  border:1px solid #10b98155;border-radius:10px;padding:0 7px;white-space:nowrap}
.rt-ap-pts.off{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-1);border-color:var(--dsw-alias-border-l1)}
/* 서비스별 상한/자체 구축으로 점수를 못 받은 히트: 점수는 회색(+0)으로 표시해, 또 점수가 더해진 것처럼 보이지 않게 한다 */
.rt-ap-pts.uncounted{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-1);border-color:var(--dsw-alias-border-l1)}
.rt-ap-nth{font-size:10.5px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.rt-ap-hit{border:1px solid var(--dsw-alias-border-l1);border-left:3px solid #10b981;border-radius:6px;
  padding:6px 9px;margin-bottom:5px;background:var(--dsw-alias-bg-layer-2);cursor:pointer;outline:none}
.rt-ap-hit:hover{border-color:var(--dsw-alias-border-l2)}
.rt-ap-hit:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.rt-ap-hit.overflow{border-left-color:#94a3b8;opacity:.75}
.rt-ap-hit-head{display:flex;align-items:center;gap:7px;flex-wrap:wrap}
.rt-ap-hit-name{font-weight:600;font-size:12.5px}
.rt-ap-hit-target{font-family:ui-monospace,Menlo,monospace;font-size:11px;color:var(--dsw-alias-label-secondary);
  margin-left:auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:46%}
.rt-ap-act{font-size:11px;color:var(--dsw-alias-label-secondary);margin-top:3px}
.rt-ap-act.inferred{font-style:italic;opacity:.75}
.rt-ap-none{font-size:11.5px;color:var(--dsw-alias-label-secondary);padding:2px 0 4px}
.rt-ap-trans{display:flex;align-items:center;gap:7px;padding:2px 0 2px 14px}
.rt-ap-trans-t{font-size:11px;color:var(--dsw-alias-label-secondary)}
/* 횡적 경로도 */
.rt-ap-h{display:flex;align-items:stretch;padding:10px 12px 14px;overflow-x:auto;flex:1;min-height:0}
.rt-ap-col{display:flex;align-items:stretch;flex:none}
.rt-ap-col-arrow{align-self:center;color:var(--dsw-alias-border-l2);padding:0 6px;font-size:12px;flex:none}
.rt-hcol{width:228px;display:flex;flex-direction:column;border:1px solid var(--dsw-alias-border-l1);
  border-top:3px solid #64748b;border-radius:7px;background:var(--dsw-alias-bg-layer-1);overflow:hidden}
.rt-hcol-goal{font-size:11px;color:var(--dsw-alias-label-secondary);padding:5px 8px;line-height:1.45;
  border-bottom:1px solid var(--dsw-alias-border-l1);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.rt-hcol-body{padding:6px 8px;flex:1;min-height:0;overflow:auto}
.rt-hcol-hit{display:flex;align-items:center;gap:5px;font-size:11px;margin-bottom:3px}
.rt-hcol-hit.off{opacity:.6}
.rt-hcol-pts{font-family:ui-monospace,Menlo,monospace;font-size:10.5px;font-weight:700;color:#065f46;background:#a7f3d0;
  border-radius:7px;padding:0 5px;flex:none}
.rt-hcol-hit.off .rt-hcol-pts{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2)}
.rt-hcol-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rt-hcol-none{font-size:11px;color:var(--dsw-alias-label-secondary)}
.rt-hcol-secs{display:flex;flex-wrap:wrap;gap:3px;margin-top:6px}
.rt-hcol-sec{font-size:10px;color:var(--dsw-alias-label-secondary);border:1px solid var(--dsw-alias-border-l1);
  border-radius:4px;padding:0 4px}
.rt-hcol-attck{font-family:ui-monospace,Menlo,monospace;font-size:9.5px;color:var(--dsw-alias-label-secondary);
  padding:4px 8px;border-top:1px solid var(--dsw-alias-border-l1);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rt-ap-cum{font-size:11px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.rt-ap-sub{font-size:11px;font-weight:600;color:var(--dsw-alias-label-secondary);margin:6px 0 3px}
.rt-ap-assets,.rt-ap-tunnels{display:flex;flex-direction:column;gap:3px}
.rt-ap-asset{display:flex;align-items:center;gap:6px;font-size:11.5px;padding:3px 6px;border-radius:5px;
  background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1)}
.rt-ap-tunnel{display:flex;align-items:center;gap:6px;font-size:11.5px;padding:4px 7px;border-radius:5px;
  background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-left:3px solid #f59e0b}
.rt-hcol-sub{font-size:10.5px;color:var(--dsw-alias-label-secondary);margin-bottom:2px;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:flex;gap:5px;align-items:center}
.rt-hcol-sub.off{opacity:.6}
.rt-hit-row{display:flex;flex-wrap:wrap;align-items:center;gap:2px 7px;font-size:11.5px;padding:4px 7px;border-radius:5px;
  background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);margin-bottom:3px}
/* 자산과 내용 모두 자동 줄바꿈: 긴 도메인/긴 패스워드/긴 결과는 전부 줄바꿈해 표시하고, 말줄임표로 자르지 않는다 */
.rt-hit-asset{font-family:ui-monospace,Menlo,monospace;font-weight:600;flex:0 1 auto;max-width:100%;
  overflow-wrap:anywhere;word-break:break-word}
.rt-hit-txt{flex:1 1 100%;color:var(--dsw-alias-label-primary);line-height:1.55;
  white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word}
.rt-hit-txt.none{color:var(--dsw-alias-state-error-primary)}
.rt-hit-row .rt-hit-time{flex:none;margin-left:auto}
/* 직접 등록/자체 구축한 계정: 흔적만 남기고 점수는 없음, 행 전체를 어둡게 */
.rt-hit-row.self-created{opacity:.72;border-left:3px solid #ef444488}
/* 같은 자산 같은 포트의 중복 계정/DB 권한: 서비스는 이미 만점이라 점수 없음(흔적만 남긴다) */
.rt-hit-row.service-capped{opacity:.72;border-left:3px solid #f59e0b88}
.rt-hit-row.service-capped .rt-hit-idx{background:#f59e0b}
.rt-rep-group{margin-bottom:14px}
.rt-rep-stage{display:flex;align-items:center;gap:8px;padding:7px 10px;margin-bottom:7px;
  background:var(--dsw-alias-bg-layer-2);border-left:4px solid #64748b;border-radius:6px;
  cursor:pointer;outline:none;user-select:none}
.rt-rep-stage:hover{background:var(--dsw-alias-bg-layer-1)}
.rt-rep-stage:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.rt-rep-no{width:20px;height:20px;border-radius:5px;color:#fff;font-size:11px;font-weight:700;flex:none;
  display:inline-flex;align-items:center;justify-content:center}
.rt-rep-stage-name{font-weight:700;font-size:13px}
.rt-rep-stage-n{font-size:11px;color:var(--dsw-alias-label-secondary)}
/* 접어도 "이 단계에서 몇 점을 얻었나"가 한눈에 보여야 하므로 점수는 헤더에 남긴다 */
.rt-rep-pts{font-size:11px;font-weight:600;padding:1px 6px;border-radius:5px;border:1px solid transparent;flex:none}
.rt-rep-body{padding-left:6px}
/* ── 지식 베이스(POC/EXP) ──────────────────────────────────────────── */
.rt-kb-filter{display:flex;align-items:center;gap:7px;padding:8px 10px;border-bottom:1px solid var(--dsw-alias-border-l1)}
/* 지식 베이스 분류 개요: 한 줄 라벨, 한 번 누르면 그 분류로 필터 */
.rt-kb-cats{display:flex;flex-wrap:wrap;gap:6px;padding:8px 10px;border-bottom:1px solid var(--dsw-alias-border-l1)}
/* 지식 베이스 그룹 제목(분류로 그룹화할 때 그룹마다 하나) */
.rt-kb-cat{display:flex;align-items:center;gap:7px;padding:7px 10px;background:var(--dsw-alias-bg-layer-2);
  border-bottom:1px solid var(--dsw-alias-border-l1);position:sticky;top:0;z-index:1}
.rt-kb-cat-name{font-weight:600;font-size:12.5px}
/* 스킬 사용 가능 여부 배지(스킬 라이브러리 탭) */
.rt-avail{display:inline-block;padding:0 5px;border-radius:4px;font-size:10.5px;white-space:nowrap;
  border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary)}
.rt-avail-available{color:#10b981;border-color:#10b98155;background:#10b9811a}
.rt-avail-broken{color:#ef4444;border-color:#ef444455;background:#ef44441a}
.rt-avail-unknown{color:#94a3b8;border-color:#94a3b855;background:#94a3b81a}
/* 버전 / 업데이트 대화상자 */
.rt-modal{position:fixed;inset:0;z-index:200;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center}
.rt-modal-box{width:min(560px,92vw);max-height:80vh;overflow:auto;background:var(--dsw-alias-bg-layer-1);
  border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:14px 16px;font-size:12.5px;line-height:1.7;
  box-shadow:0 18px 48px rgba(0,0,0,.35);color:var(--dsw-alias-label-primary)}
.rt-modal-box .rt-kv b{min-width:76px}
.rt-kb-check{display:flex;align-items:center;gap:5px;font-size:11.5px;color:var(--dsw-alias-label-secondary);white-space:nowrap;cursor:pointer}
.rt-kb{border:1px solid var(--dsw-alias-border-l1);border-radius:7px;margin:0 0 8px;overflow:hidden;
  background:var(--dsw-alias-bg-layer-2)}
.rt-kb.open{border-color:var(--dsw-alias-brand-primary)}
.rt-kb-head{display:flex;align-items:center;gap:7px;padding:7px 9px;cursor:pointer;outline:none;flex-wrap:wrap}
.rt-kb-head:hover{background:var(--dsw-alias-bg-layer-1)}
.rt-kb-head:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.rt-kb-title{font-weight:600;font-size:12.5px;overflow-wrap:anywhere}
.rt-kb-kind{font-size:10px;font-weight:700;letter-spacing:.4px;padding:1px 5px;border-radius:4px;
  color:#fff;background:#64748b;flex:none}
.rt-kb-kind.k-exp{background:#ef4444}
.rt-kb-kind.k-poc{background:#f59e0b}
.rt-kb-kind.k-template{background:#8b5cf6}
.rt-kb-kind.k-script{background:#0ea5e9}
.rt-kb-kind.k-payload{background:#10b981}
.rt-kb-sub{font-size:11px;color:var(--dsw-alias-label-secondary);padding:0 9px 7px;overflow-wrap:anywhere}
.rt-kb-body{padding:0 9px 9px}
.rt-kb-actions{display:flex;gap:6px;margin:7px 0}
.rt-kb-body .rt-kv span{overflow-wrap:anywhere;word-break:break-word}
/* 로컬 nuclei 템플릿 히트: 경로를 온전히 볼 수 있어야 한다(명령으로 복사해 바로 실행) */
.rt-kb-tpl{margin-top:12px;border-top:1px dashed var(--dsw-alias-border-l1);padding-top:8px}
.rt-kb-tpl-row{display:flex;align-items:center;gap:7px;font-size:11.5px;padding:3px 7px;border-radius:5px;
  background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);margin-bottom:3px}
.rt-kb-tpl-path{flex:0 1 auto;font-weight:600;overflow-wrap:anywhere}
.rt-kb-tpl-name{flex:1 1 auto;min-width:0;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.rt-md{flex:1;overflow:auto;margin:0;padding:14px 16px;font-family:ui-monospace,Menlo,monospace;font-size:12.5px;
  line-height:1.65;white-space:pre-wrap;word-break:break-word;background:var(--dsw-alias-bg-base)}
.rt-weblink{display:block;font-size:11.5px;margin-top:1px;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rt-shots{margin:8px 0 4px;padding:7px 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:7px;
  background:var(--dsw-alias-bg-layer-1)}
.rt-shots-head{display:flex;align-items:baseline;gap:8px;font-size:11.5px;margin-bottom:6px}
.rt-shots-n{color:var(--dsw-alias-label-secondary)}
.rt-shot-row{display:flex;gap:8px;flex-wrap:wrap}
.rt-shot{display:flex;flex-direction:column;gap:3px;max-width:220px}
.rt-shot-thumb{border:1px solid var(--dsw-alias-border-l1);border-radius:5px;background:#0b1020;
  object-fit:contain;display:block;width:auto;max-width:216px}
.rt-shot-loading{display:flex;align-items:center;justify-content:center;width:150px;font-size:11px;
  color:var(--dsw-alias-label-secondary)}
.rt-shot-cap{display:flex;align-items:center;gap:5px;font-size:10.5px;overflow-wrap:anywhere}
.rt-shot-label{color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:170px}
.rt-shot-zoom{position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.82);display:flex;flex-direction:column;
  align-items:center;justify-content:center;gap:10px;cursor:zoom-out;padding:18px}
.rt-shot-zoom img{max-width:96vw;max-height:86vh;border-radius:6px;box-shadow:0 18px 48px rgba(0,0,0,.5)}
.rt-shot-zoom-cap{color:#e5e7eb;font-size:12px;text-align:center;max-width:90vw;overflow-wrap:anywhere}
body[data-ds-dark-theme] .rt-dock,body[data-ds-dark-theme] .rt-full,
.dshp-dock[data-theme="dusk"] .rt-dock,.dshp-dock[data-theme="dusk"] .rt-full{
  --rt-paper:color-mix(in srgb,var(--dsw-alias-bg-layer-1,#1c1e24) 42%,transparent);
  --rt-paper-2:color-mix(in srgb,var(--dsw-alias-bg-layer-2,#1c1e24) 34%,transparent);
  --rt-well:color-mix(in srgb,var(--dsw-alias-bg-layer-1,#1c1e24) 26%,transparent);
  --rt-hi:color-mix(in srgb,#fff 10%,transparent);
  --rt-ink:var(--dsw-alias-label-primary,#f4f1ea);
  --rt-mute:color-mix(in srgb,var(--dsw-alias-label-primary,#f4f1ea) 78%,var(--dsw-alias-label-secondary,#c9c3b8));
  --rt-line:color-mix(in srgb,var(--dsw-alias-brand-primary,#6dbf8c) 32%,transparent);
  --rt-ok:#8fd0a8;--rt-warn:#e4c48a;--rt-bad:#f0b4b4;
  box-shadow:inset 0 1px 0 var(--rt-hi),0 16px 40px color-mix(in srgb,#000 28%,transparent)}
.rt-card,.rt-sess,.rt-hit,.rt-cred,.rt-evi,.rt-kb,.rt-rep,.rt-flow-node,.rt-hflow-node,.rt-atest,.rt-hcol,.rt-ap-hit,.rt-rep-req,.rt-rep-trace,.rt-shots,.rt-modal-box{
  background:var(--rt-paper)!important;border-color:var(--rt-line)!important;color:var(--rt-ink);
  backdrop-filter:var(--rt-glass);-webkit-backdrop-filter:var(--rt-glass);box-shadow:inset 0 1px 0 var(--rt-hi)}
.rt-score-group,.rt-sec,.rt-kb-cat,.rt-evi-head,.rt-rep-req-head,.rt-ap-head,.rt-ap-goal,.rt-rep-stage{
  background:var(--rt-paper-2)!important;border-color:var(--rt-line)!important;color:var(--rt-ink)}
.rt-head,.rt-tabs,.rt-toolbar,.rt-foot,.rt-side,.rt-list,.rt-pane,.rt-livebar,.rt-concl,.rt-subtabs,.rt-kb-filter,.rt-kb-cats,.rt-body,.rt-table,.rt-main{
  background:transparent!important;box-shadow:none}
.rt-row.head,.rt-score-row.head,.rt-vrow.head{
  background:var(--rt-paper)!important;backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px)}
.rt-row:hover,.rt-vrow:hover,.rt-score-row:hover,.rt-item:hover,.rt-item.on,.rt-seg:hover,.rt-seg.on,.rt-icon-btn:hover,.rt-hbtn:hover,.rt-kb-head:hover,.rt-sidehead-btn:hover,.rt-sec:hover,.rt-rep-stage:hover,.rt-concl-i:hover,.rt-concl-i.on{
  background:var(--rt-fill)!important}
.rt-btn,.rt-icon-btn,.rt-hbtn,.rt-input,.rt-eng-select,.rt-textarea,.rt-chip,.rt-code,.rt-hit-evi,.rt-atest-notes,.rt-clip-body,.rt-evi-body,.rt-rep-http,.rt-md,.rt-kb-tpl-row,.rt-hit-row,.rt-ap-asset,.rt-ap-tunnel{
  background:var(--rt-well)!important;border-color:var(--rt-line)!important;color:var(--rt-ink)!important;
  backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px)}
.rt-btn{border-radius:8px;transition:transform 500ms var(--rt-ease),opacity 300ms var(--rt-ease)}
.rt-btn:hover:not(:disabled){transform:translateY(-1px);border-color:var(--rt-accent)}
.rt-btn:active:not(:disabled){transform:scale(.98)}
.rt-btn:focus-visible,.rt-input:focus-visible,.rt-tab:focus-visible,.rt-icon-btn:focus-visible,.rt-hbtn:focus-visible{
  outline:2px solid var(--rt-accent);outline-offset:2px}
.rt-btn-primary,.rt-btn-primary:hover:not(:disabled){background:var(--rt-accent)!important;border-color:var(--rt-accent)!important;color:#fff!important;backdrop-filter:none}
.rt-input option,.rt-eng-select option{background:var(--dsw-alias-bg-layer-1,#fff);color:var(--rt-ink)}
body[data-ds-dark-theme] .rt-input option,body[data-ds-dark-theme] .rt-eng-select option,.dshp-dock[data-theme="dusk"] .rt-input option,.dshp-dock[data-theme="dusk"] .rt-eng-select option{background:#1b1d22;color:#f4f1ea}
.rt-pri-high,.rt-test-blocked,.rt-sev-critical,.rt-sev-high{color:var(--rt-bad)!important;background:color-mix(in srgb,var(--rt-bad) 16%,transparent)!important;border:1px solid color-mix(in srgb,var(--rt-bad) 40%,var(--rt-line))!important}
.rt-pri-medium,.rt-test-testing,.rt-tag-active{color:var(--rt-warn)!important;background:color-mix(in srgb,var(--rt-warn) 16%,transparent)!important;border:1px solid color-mix(in srgb,var(--rt-warn) 40%,var(--rt-line))!important}
.rt-pri-low{color:var(--rt-mute)!important;background:var(--rt-paper-2)!important;border:1px solid var(--rt-line)!important}
.rt-gain,.rt-counted,.rt-scorepts,.rt-flow-pts,.rt-hflow-pts,.rt-hcol-pts,.rt-ap-pts{color:var(--rt-ok)!important;background:color-mix(in srgb,var(--rt-ok) 16%,transparent)!important;border:1px solid color-mix(in srgb,var(--rt-ok) 38%,var(--rt-line))!important}
.rt-secret{color:var(--rt-warn)!important;background:color-mix(in srgb,var(--rt-warn) 14%,transparent)!important;border-color:color-mix(in srgb,var(--rt-warn) 40%,var(--rt-line))!important}
.rt-scope-internal{color:#0e7490;background:color-mix(in srgb,#06b6d4 16%,transparent);border:1px solid color-mix(in srgb,#06b6d4 32%,transparent)}
.rt-scope-external{color:var(--rt-warn);background:color-mix(in srgb,var(--rt-warn) 16%,transparent);border:1px solid color-mix(in srgb,var(--rt-warn) 32%,transparent)}
.rt-scope-testing{color:#5b21b6;background:color-mix(in srgb,#8b5cf6 16%,transparent);border:1px solid color-mix(in srgb,#8b5cf6 32%,transparent)}
body[data-ds-dark-theme] .rt-scope-internal,.dshp-dock[data-theme="dusk"] .rt-scope-internal{color:#67e8f9}
body[data-ds-dark-theme] .rt-scope-testing,.dshp-dock[data-theme="dusk"] .rt-scope-testing{color:#c4b5fd}
.rt-modal-box{border-radius:16px;backdrop-filter:blur(22px) saturate(1.4);-webkit-backdrop-filter:blur(22px) saturate(1.4);
  box-shadow:inset 0 1px 0 var(--rt-hi),0 16px 40px color-mix(in srgb,#000 28%,transparent)}
.rt-flow-action.inferred,.rt-ap-act.inferred{font-style:normal}
@media (prefers-reduced-motion:reduce){.rt-btn,.rt-live-dot{transition:opacity 300ms var(--rt-ease);animation:none;transform:none}}
.rt-head,.rt-toolbar,.rt-foot,.rt-livebar,.rt-concl{padding:8px 12px}
.rt-tabs,.rt-subtabs{gap:8px;padding:0 12px}
.rt-tab{padding:8px 12px;gap:4px}
.rt-pane,.rt-chain,.rt-sess-grid,.rt-flow,.rt-ap,.rt-rep-list,.rt-live-body{padding:12px}
.rt-side,.rt-list{width:192px;padding:8px;box-sizing:border-box}
.rt-seg,.rt-item{padding:8px;border-radius:8px;margin-bottom:4px}
.rt-card{padding:12px;margin-bottom:12px;border-radius:8px}
.rt-card h4{margin:0 0 8px}
.rt-btn{padding:4px 12px;border-radius:8px;font-size:12px;line-height:20px}
.rt-input,.rt-eng-select{padding:4px 12px;border-radius:8px;min-height:32px;box-sizing:border-box}
.rt-textarea{padding:8px 12px;border-radius:8px}
.rt-row,.rt-score-row,.rt-vrow{padding:8px 12px;gap:8px}
.rt-row{grid-template-columns:minmax(96px,1.1fr) minmax(56px,72px) minmax(64px,96px) minmax(0,1.2fr) minmax(0,1fr)}
.rt-toolbar{gap:8px}
.rt-hint{padding:8px 12px;margin-bottom:8px;border-radius:8px}
.rt-empty,.rt-err{padding:8px 12px}
.rt-empty{padding:24px 12px}
.rt-sess{padding:12px;border-radius:8px}
.rt-sess-grid{gap:12px}
.rt-expand,.rt-score-detail,.rt-vdetail{padding:8px 12px 12px}
.rt-section{padding:8px 12px 4px}
.rt-full .rt-head{padding:12px 16px}
.rt-full .rt-tabs{padding:0 16px;gap:8px}
.rt-full .rt-pane,.rt-full .rt-chain,.rt-full .rt-sess-grid{padding:16px}
.rt-full .rt-foot,.rt-full .rt-toolbar,.rt-full .rt-livebar,.rt-full .rt-concl{padding:8px 16px}
.rt-full .rt-side{width:240px}
.rt-full .rt-list{width:256px}
.rt-full .rt-row{grid-template-columns:minmax(0,1.2fr) minmax(64px,90px) minmax(80px,130px) minmax(0,1.4fr) minmax(0,1.2fr)}
`    /* ---------------------------------------------------------- 브리지와 상태 */
    /** 「전체 보기」 독립 창 안인지 여부 (URL hash 표시, 같은 화면 코드를 재사용한다). */
    const isFullWindow = () => {
      try { return String(window.location.hash || '') === '#redteam-full' } catch { return false }
    }

    const api = (req) => fetch('/redteam/api', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(req),
    }).then((res) => res.json())

    let ui = { open: true, tab: 'assets' }
    const subs = new Set()
    const setUI = (patch) => {
      ui = Object.assign({}, ui, patch)
      const snap = Object.assign({}, ui)
      for (const f of Array.from(subs)) {
        try { f(snap) } catch { /* ignore subscriber errors */ }
      }
    }
    /* 내보내기는 유지한다. 패널 크기는 자기 요소에만 쓰고, 공식 frame 의 너비는 더 이상 바꾸지 않는다. */
    let dockWidthTag = null
    const setDockWidth = () => {}
    const useUI = () => {
      const [st, setSt] = React.useState(() => Object.assign({}, ui))
      React.useEffect(() => {
        const f = (snap) => setSt(Object.assign({}, snap || ui))
        subs.add(f)
        setSt(Object.assign({}, ui))
        return () => { subs.delete(f) }
      }, [])
      return st
    }

    /* 지식 베이스 분류(core.js 의 POC_CATEGORIES 와 일치; 패널이 이 값으로 그룹화) */
    const POC_CAT_NAME = {
      rce: '원격 명령 실행', deserialization: '역직렬화', 'file-upload': '파일 업로드 getshell',
      sqli: 'SQL 주입', unauthorized: '미승인 접근', 'auth-bypass': '인증 우회 / 권한 우회',
      'weak-password': '약한 패스워드 / 브루트포스', ssrf: 'SSRF', xxe: 'XXE',
      'path-traversal': '디렉터리 트래버설 / 임의 파일 읽기', 'info-leak': '정보 유출',
      privesc: '권한 상승 / 횡적 이동', tunnel: '터널 / 프록시', other: '기타',
    }
    const POC_CAT_ORDER = Object.keys(POC_CAT_NAME)
    /* 역할 code → 한국어(보고서/지식 베이스 모두 "누가 발견했나"를 표시) */
    const ROLE_LABEL = {
      plan: '메인 세션(지휘)', recon: '정보 수집', assess: '자산 정리',
      'vuln-scan': '취약점 발견', exploit: '취약점 이용', internal: '내부 네트워크 침투',
    }

    const fmt = (s) => (s ? String(s).replace('T', ' ').slice(0, 16) : '—')
    const shotCache = new Map()
    const shotLoading = new Map()
    const shotSrc = (eng, id) => shotCache.get(eng + ':' + id) || null
    const loadShot = (eng, id) => {
      const key = eng + ':' + id
      if (shotCache.has(key) || shotLoading.has(key)) return
      const p = api({ op: 'shotData', engagement: eng, id: id }).then((r) => {
        shotCache.set(key, r && r.base64 ? 'data:' + (r.mime || 'image/png') + ';base64,' + r.base64 : '')
        shotLoading.delete(key)
        const snap = Object.assign({}, ui)
        for (const f of Array.from(subs)) {
          try { f(snap) } catch { /* ignore subscriber errors */ }
        }
      }).catch(() => { shotLoading.delete(key) })
      shotLoading.set(key, p)
    }
    const SHOT_KIND = { screenshot: '현장 스크린샷', card: '기록에서 생성한 증거 발췌' }
    const ShotImage = ({ eng, shot, height }) => {
      const [zoom, setZoom] = React.useState(false)
      const src = shotSrc(eng, shot.id)
      if (src === null) { loadShot(eng, shot.id); }
      const card = shot.kind === 'card'
      return h('div', { className: 'rt-shot' },
        src === null
          ? h('div', { className: 'rt-shot-thumb rt-shot-loading', style: { height: (height || 96) + 'px' } }, '불러오는 중…')
          : h('img', {
              className: 'rt-shot-thumb', src: src, alt: shot.label || ('증거 ' + shot.id),
              style: { height: (height || 96) + 'px', cursor: 'zoom-in' },
              onClick: () => setZoom(true),
            }),
        h('div', { className: 'rt-shot-cap' },
          h('span', { className: 'rt-tag ' + (card ? 'rt-tag-warn' : 'rt-tag-live'), title: card
            ? '당일 기록에서 생성한 증거 발췌이며 현장 스크린샷이 아니다 —— 보고서에도 같은 표기가 붙는다'
            : '현장 스크린샷' }, SHOT_KIND[shot.kind] || shot.kind || '증거'),
          h('span', { className: 'rt-shot-label', title: shot.label || shot.note || '' },
            shot.label || shot.target || ('#' + shot.id))),
        zoom
          ? h('div', { className: 'rt-shot-zoom', onClick: () => setZoom(false) },
              h('img', { src: src, alt: shot.label || '' }),
              h('div', { className: 'rt-shot-zoom-cap' }, (shot.label || shot.target || '')
                + (card ? ' · 당일 기록에서 생성(현장 스크린샷 아님)' : '')
                + (shot.captured_at ? ' · ' + fmt(shot.captured_at) : '')
                + ' · 아무 곳이나 클릭하면 닫힌다'))
          : null)
    }
    const ShotStrip = ({ eng, shots, total, title }) => {
      const list = shots || []
      if (list.length === 0) return null
      return h('div', { className: 'rt-shots' },
        h('div', { className: 'rt-shots-head' },
          h('b', null, title || '증거 스크린샷'),
          h('span', { className: 'rt-shots-n' }, '표시 ' + list.length + '장'
            + (total && total > list.length ? '(이 점수 항목은 총 ' + total + '장, 대표 이미지만 표시)' : ''))),
        h('div', { className: 'rt-shot-row' }, list.map((sh) => h(ShotImage, { key: 'sh' + sh.id, eng: eng, shot: sh }))))
    }
    /** 발견 시간은 목록에서 "월-일 시:분"만 남긴다: 행 너비가 빠듯해 전체 시간은 툴팁으로 */
    const fmtShort = (s) => {
      const t = String(s || '').replace('T', ' ')
      return t.length >= 16 ? t.slice(5, 16) : (t || '—')
    }
    const provLabel = (p) => (p === 'passive' ? '수동' : p === 'active' ? '능동' : '알 수 없음')

    /**
     * "클릭할 수 있지만 <button> 은 아닌" 요소에 키보드 접근성을 보완하고, props 에 바로 펼쳐 넣을 수 있는 객체를 돌려준다.
     *
     * 왜 필요한가: 패널에서 div/span 을 버튼으로 쓰는 곳이 많다(표 행, 탭, 결론 바, C 세그먼트 항목…),
     * 마우스로는 눌리지만 키보드로는 전혀 닿지 않는다 —— 게다가 이런 요소가 이전에 16 군데나 제각각 작성되었고,
     * 작성 방식도 일관되지 않았다(어떤 곳은 role 만 있고, 어떤 곳은 Space 키가 빠졌다).
     * 하나의 팩토리로 통일한 뒤로는, 새 클릭 가능 요소에 `...clickable(fn, { label })` 만 붙이면 완전한 의미가 따라온다.
     *
     * 주의: **절대** 진짜 `<button>` 을 이것으로 감싸지 않는다(네이티브 버튼은 모든 의미를 자체적으로 갖는다).
     * @param onActivate - 활성화 콜백(마우스 클릭 / Enter / Space 모두 이리로 온다).
     * @param options - `{ label?, expanded? }`: label 은 aria-label 로, expanded 는 aria-expanded 로 들어간다.
     * @returns props 조각: role / tabIndex / onClick / onKeyDown / aria-*
     */
    const clickable = (onActivate, options = {}) => {
      const props = {
        role: 'button',
        tabIndex: 0,
        onClick: onActivate,
        onKeyDown: (e) => {
          /* Enter 와 Space 는 버튼의 표준 활성화 키다; Space 는 페이지 스크롤도 막아야 한다 */
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            onActivate(e)
          }
        },
      }
      if (options.label !== undefined) props['aria-label'] = String(options.label)
      if (options.expanded !== undefined) props['aria-expanded'] = options.expanded ? 'true' : 'false'
      return props
    }

    /**
     * 텍스트를 클립보드에 복사하고, **실제 성공 여부를 반환한다**.
     *
     * clipboard API 는 비보안 컨텍스트(http + localhost 아님), 페이지 포커스 이탈, 권한 거부 시 모두
     * 거부된 Promise 를 반환한다 —— 동기 try/catch 로는 잡을 수 없어, 화면에는 "복사됨"이 뜨는데 클립보드는 비어 있게 된다.
     * 여기서는 실제 결과를 await 하고, 사용할 수 없을 때 execCommand('copy') 로 폴백한다(구형 브라우저/비보안 컨텍스트에서 여전히 동작).
     * @param text - 복사할 텍스트.
     * @returns Promise<boolean>
     */
    const copyText = async (text) => {
      const value = text === undefined || text === null ? '' : String(text)
      if (value === '') return false
      try {
        if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
          await navigator.clipboard.writeText(value)
          return true
        }
      } catch (e) { /* 아래의 폴백 방안으로 넘어간다 */ }
      /* 폴백: 임시 textarea + execCommand —— 비보안 컨텍스트에서 유일하게 남은 방법 */
      try {
        const ta = document.createElement('textarea')
        ta.value = value
        ta.setAttribute('readonly', '')
        ta.style.position = 'fixed'
        ta.style.left = '-9999px'
        document.body.appendChild(ta)
        ta.select()
        const okFlag = document.execCommand('copy')
        document.body.removeChild(ta)
        return okFlag === true
      } catch (e) { return false }
    }

    /**
     * 복사하고 **사실대로** 화면 피드백을 준다(성공/실패 문구 통일).
     * @param text - 복사할 텍스트.
     * @param label - 성공 시 알림에 표시할 이름.
     * @param onResult - 선택 콜백: `(ok, message) => void`; 전달하지 않으면 Promise<boolean> 을 반환한다.
     */
    const copyWithFeedback = async (text, label, onResult) => {
      const okFlag = await copyText(text)
      const message = okFlag ? '복사됨: ' + label : '복사 실패(브라우저가 클립보드를 허용하지 않음) —— 텍스트를 직접 선택해 복사하세요'
      if (typeof onResult === 'function') onResult(okFlag, message)
      return okFlag
    }

    function ProvTag(props) {
      if (!props.p) return h('span', { className: 'rt-tag' }, '알 수 없음')
      return h('span', { className: 'rt-tag rt-tag-' + props.p }, provLabel(props.p))
    }

    const TEST_LABEL = { untested: '미테스트', testing: '테스트 중', tested: '테스트 완료', blocked: '차단됨', abandoned: '포기', no_surface: '공격 표면 없음' }
    const PRI_LABEL = { high: '높음', medium: '중간', low: '낮음' }

    /** 자산 난이도 배지. */
    function PriTag(props) {
      if (!props.p) return h('span', { className: 'rt-tag' }, '미평가')
      return h('span', { className: 'rt-pri rt-pri-' + props.p, title: props.title || '' }, PRI_LABEL[props.p] || props.p)
    }

    /** 자산 테스트 상태 배지. */
    function TestTag(props) {
      const st = props.s || 'untested'
      return h('span', { className: 'rt-test rt-test-' + st }, TEST_LABEL[st] || st)
    }

    /* ---------------------------------------------------------- 자산 정찰 */
    function AssetsTab(props) {
      const eng = props.engagement
      const snapshot = props.snapshot
      const refreshKey = props.refreshKey || 0
      const onRefresh = props.onRefresh
      const [view, setView] = React.useState('list')
      const [cidr, setCidr] = React.useState(null)
      const [q, setQ] = React.useState('')
      const [qApplied, setQApplied] = React.useState('')
      const [service, setService] = React.useState('')
      const [port, setPort] = React.useState('')
      const [prov, setProv] = React.useState('')
      const [testStatus, setTestStatus] = React.useState('')
      const [priority, setPriority] = React.useState('')
      const [scope, setScope] = React.useState('')
      const [assetState, setAssetState] = React.useState('')
      const [sort, setSort] = React.useState('priority')
      const [showAll, setShowAll] = React.useState(null)
      const [state, setState] = React.useState({ loading: false, error: null, total: 0, items: [] })
      const [domains, setDomains] = React.useState(null)
      const [web, setWeb] = React.useState(null)
      const [openId, setOpenId] = React.useState(null)
      const [detail, setDetail] = React.useState(null)
      /* 왼쪽 "외부 네트워크 C 세그먼트 / 내부 네트워크 C 세그먼트" 두 그룹은 각자 접히고, 상태는 타깃별로 기억된다 */
      const sideCollapse = useCollapse('assets-side:' + eng)
      const seq = React.useRef(0)
      const onData = props.onData

      React.useEffect(() => {
        if (!eng) return
        const my = ++seq.current
        setState((s) => Object.assign({}, s, { loading: true, error: null }))
        api({
          op: 'assets', engagement: eng, cidr: cidr || undefined, q: qApplied || undefined,
          service: service || undefined, port: port || undefined,
          provenance: prov || undefined, test_status: testStatus || undefined,
          priority: priority || undefined, scope: scope || undefined,
          state: assetState || undefined, sort: sort, limit: 400,
        }).then((r) => {
          if (my !== seq.current) return
          if (!r || r.ok === false) {
            setState({ loading: false, error: (r && r.error) || '조회 실패', total: 0, items: [] })
            return
          }
          setState({ loading: false, error: null, total: r.total, items: r.items || [] })
          /* C 세그먼트/통계는 이번 수집으로 늘어날 수 있다: 바깥에서 스냅샷을 다시 가져오게 해, 왼쪽 분류가 즉시 갱신되도록 한다 */
          if (onData) onData()
        }, (e) => {
          if (my === seq.current) setState({ loading: false, error: String((e && e.message) || e), total: 0, items: [] })
        })
      }, [eng, cidr, qApplied, service, port, prov, testStatus, priority, scope, assetState, sort, refreshKey])

      React.useEffect(() => {
        if (!eng || view !== 'domain') return
        setDomains(null)
        api({ op: 'domains', engagement: eng, cidr: cidr || undefined })
          .then((r) => setDomains((r && r.items) || []), () => setDomains([]))
      }, [eng, view, cidr, refreshKey])

      React.useEffect(() => {
        if (!eng || view !== 'web') return
        setWeb(null)
        api({ op: 'web', engagement: eng, cidr: cidr || undefined })
          .then((r) => setWeb((r && r.items) || []), () => setWeb([]))
      }, [eng, view, cidr, refreshKey])


      const toggleRow = (id) => {
        if (openId === id) { setOpenId(null); setDetail(null); return }
        setOpenId(id)
        setDetail(null)
        api({ op: 'asset', engagement: eng, id: id }).then((r) => {
          if (r && r.ok && r.asset) setDetail(r.asset)
        }, () => {})
      }

      const segs = (snapshot && snapshot.segments) || []

      const sideChildren = []
      sideChildren.push(h('div', Object.assign({
        key: 'all', className: 'rt-seg' + (cidr === null && view !== 'testing' ? ' on' : ''),
      }, clickable(() => { setView('list'); setCidr(null) }, { label: '전체 C 세그먼트', expanded: cidr === null && view !== 'testing' })),
        h('div', { className: 'rt-seg-cidr' }, '전체 C 세그먼트'),
        h('div', { className: 'rt-seg-meta' }, segs.length + ' 개 세그먼트')))
      sideChildren.push(h('div', Object.assign({
        key: 'testing', className: 'rt-seg' + (view === 'testing' ? ' on' : ''),
        title: '실행 중인 스캔 / 탐지와 진행률(5초 자동 새로고침)',
      }, clickable(() => { setView('testing'); setCidr(null) }, { label: '현재 테스트', expanded: view === 'testing' })),
        h('div', { className: 'rt-seg-cidr', style: { display: 'flex', alignItems: 'baseline', gap: 5 } },
          h('span', { className: 'rt-scope rt-scope-testing', title: '현재 테스트(내부 네트워크도 외부 네트워크도 아님)' }, '테'),
          h('span', { style: { flex: 1 } }, '현재 테스트')),
        h('div', { className: 'rt-seg-meta' }, '실행 중인 스캔과 탐지')))
      /* C 세그먼트는 내외부 네트워크로 그룹화한다: 먼저 외부 네트워크(인터넷에서 도달 가능, 보통 진입점) 다음 내부 네트워크(침투한 뒤에야 보인다) */
      const segBlock = (title, list, kind) => {
        /* 외부 네트워크 / 내부 네트워크 두 그룹은 각자 접을 수 있고(상태는 타깃별로 기억), 기본은 펼침 */
        const open = sideCollapse.isOpen('scope:' + kind, true)
        const toggle = sideCollapse.toggle('scope:' + kind, true)
        const out = [h('div', {
          key: 'h' + kind, className: 'rt-sidehead rt-sidehead-btn',
          role: 'button', tabIndex: 0, 'aria-expanded': open ? 'true' : 'false',
          title: (open ? '이 그룹 접기' : '이 그룹 펼치기') + '(자산 목록으로도 전환)',
          onClick: () => { setView('list'); toggle() },
          onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setView('list'); toggle(e) } },
        },
          h('span', { className: 'rt-sec-caret' }, open ? '▾' : '▸'),
          h('span', { className: 'rt-scope rt-scope-' + kind }, kind === 'internal' ? '내부 네트워크' : '외부 네트워크'),
          h('span', null, title + ' · ' + list.length + ' 개 C 세그먼트'),
          h('span', { className: 'rt-spacer' }),
          h('span', { style: { fontWeight: 400 } }, list.reduce((n, x) => n + (x.assets || 0), 0) + ' 개 자산'))]
        if (!open) return out
        for (const s of list) {
          /* 한 줄에 한 세그먼트: C 세그먼트 + 자산 수만 표시(포트 수는 자리를 차지하지 않고, 소유/생존은 툴팁으로) */
          out.push(h('div', Object.assign({
            key: s.cidr, className: 'rt-seg' + (cidr === s.cidr ? ' on' : ''),
            title: (s.org || '소유자 미상') + ' · 생존 ' + (s.live || 0) + '/' + (s.assets || 0) + ' 대',
          }, clickable(() => { setView('list'); setCidr(s.cidr) },
            { label: 'C 세그먼트 필터 ' + s.cidr, expanded: cidr === s.cidr && view !== 'testing' })),
            h('div', { className: 'rt-seg-cidr', style: { display: 'flex', alignItems: 'baseline', gap: 5 } },
              h('span', { className: 'rt-scope rt-scope-' + kind }, kind === 'internal' ? '내' : '외'),
              h('span', { style: { flex: 1 } }, s.cidr),
              h('span', { className: 'rt-seg-meta', style: { margin: 0, whiteSpace: 'nowrap' } },
                s.assets + ' 대'))))
        }
        return out
      }
      const segExternal = segs.filter((x) => x.scope !== 'internal')
      const segInternal = segs.filter((x) => x.scope === 'internal')
      if (segExternal.length) sideChildren.push(...segBlock('외부 네트워크 자산', segExternal, 'external'))
      if (segInternal.length) sideChildren.push(...segBlock('내부 네트워크 자산', segInternal, 'internal'))
      const side = h('div', { className: 'rt-side' }, sideChildren)

      const toolbar = h('div', { className: 'rt-toolbar' },
        h('input', {
          className: 'rt-input', style: { flex: '1 1 150px' }, placeholder: 'IP / 도메인 / 핑거프린트 검색(Enter)',
          value: q, onChange: (e) => setQ(e.target.value),
          onKeyDown: (e) => { if (e.key === 'Enter') setQApplied(q) },
        }),
        h('button', { className: 'rt-btn', onClick: () => setQApplied(q) }, '검색'),
        h('input', {
          className: 'rt-input', style: { width: '78px' }, placeholder: '서비스',
          value: service, onChange: (e) => setService(e.target.value),
        }),
        h('input', {
          className: 'rt-input', style: { width: '60px' }, placeholder: '포트',
          value: port, onChange: (e) => setPort(e.target.value),
        }),
        h('select', { className: 'rt-input', value: scope, onChange: (e) => setScope(e.target.value) },
          h('option', { value: '' }, '내외부 무관'),
          h('option', { value: 'external' }, '외부 네트워크 자산만'),
          h('option', { value: 'internal' }, '내부 네트워크 자산만')),
        h('select', { className: 'rt-input', value: prov, onChange: (e) => setProv(e.target.value), title: '포트 출처로 필터(목록에는 더 이상 별도 표시하지 않고 상세에서 볼 수 있다)' },
          h('option', { value: '' }, '출처 무관'),
          h('option', { value: 'passive' }, '수동만'),
          h('option', { value: 'active' }, '능동만')),
        h('select', { className: 'rt-input', value: priority, onChange: (e) => setPriority(e.target.value) },
          h('option', { value: '' }, '난이도 무관'),
          h('option', { value: 'high' }, '쉬움(높음)'),
          h('option', { value: 'medium' }, '보통(중간)'),
          h('option', { value: 'low' }, '어려움(낮음)')),
        h('select', { className: 'rt-input', value: testStatus, onChange: (e) => setTestStatus(e.target.value) },
          h('option', { value: '' }, '테스트 상태 무관'),
          h('option', { value: 'untested' }, '미테스트'),
          h('option', { value: 'testing' }, '테스트 중'),
          h('option', { value: 'tested' }, '테스트 완료'),
          h('option', { value: 'blocked' }, '차단됨'),
          h('option', { value: 'abandoned' }, '포기'),
          h('option', { value: 'no_surface' }, '공격 표면 없음')),
        h('div', { className: 'rt-spacer' }),
        h('button', { className: 'rt-btn', title: '스냅샷과 현재 뷰 데이터를 다시 가져오기', onClick: () => { if (onRefresh) onRefresh() } }, '새로고침'),
        h('button', { className: 'rt-btn' + (view === 'list' ? ' rt-btn-primary' : ''), onClick: () => setView('list') }, '목록'),
        h('button', { className: 'rt-btn' + (view === 'timeline' ? ' rt-btn-primary' : ''), title: '발견 시간 기준으로 자산 보기(언제 발견했고, 어느 날 얼마나 모았는지)', onClick: () => setView('timeline') }, '발견 시간'),
        h('button', { className: 'rt-btn' + (view === 'domain' ? ' rt-btn-primary' : ''), onClick: () => setView('domain') }, '도메인'),
        h('button', { className: 'rt-btn' + (view === 'web' ? ' rt-btn-primary' : ''), onClick: () => setView('web') }, 'Web'))

      /* ── 결론 행: 한 화면에서 전모를 파악하고, 숫자를 한 번 누르면 필터 ───────────────────── */
      const tests = (snapshot && snapshot.tests) || {}
      const snapStats = (snapshot && snapshot.stats) || {}
      const noFilter = !testStatus && !priority && !scope && !prov && !assetState && !cidr
      const conclItem = (key, label, value, active, onClick) => h('span', Object.assign({
        key: key, className: 'rt-concl-i' + (active ? ' on' : ''), title: '클릭하면 필터 / 다시 클릭하면 해제',
      }, clickable(onClick, { label: '"' + label + '" 기준 필터(' + (value || 0) + ')', expanded: active })),
        h('b', null, String(value || 0)), h('span', null, label))
      const toggleTest = (v) => { setTestStatus((cur) => (cur === v ? '' : v)); setAssetState('') }
      const conclusion = h('div', { className: 'rt-concl' },
        conclItem('all', '대 자산', snapStats.assets, noFilter, () => {
          setTestStatus(''); setPriority(''); setScope(''); setProv(''); setAssetState(''); setCidr(null)
        }),
        conclItem('live', '생존', snapStats.liveAssets, assetState === 'live', () => { setAssetState((v) => (v === 'live' ? '' : 'live')); setTestStatus('') }),
        conclItem('untested', '대기', tests.untested, testStatus === 'untested', () => toggleTest('untested')),
        conclItem('testing', '테스트 중', tests.testing, testStatus === 'testing', () => toggleTest('testing')),
        conclItem('tested', '테스트 완료', tests.tested, testStatus === 'tested', () => toggleTest('tested')),
        conclItem('giveup', '포기', (tests.abandoned || 0) + (tests.blocked || 0), testStatus === 'abandoned,blocked', () => toggleTest('abandoned,blocked')),
        h('div', { className: 'rt-spacer' }),
        h('select', {
          className: 'rt-input', value: sort, onChange: (e) => setSort(e.target.value),
          title: '목록 정렬 방식',
        },
          h('option', { value: 'priority' }, '정렬: 난이도 우선'),
          h('option', { value: 'todo' }, '정렬: 대기 우선'),
          h('option', { value: 'discovered' }, '정렬: 최근 발견 우선'),
          h('option', { value: 'ports' }, '정렬: 포트 많은 순'),
          h('option', { value: 'ip' }, '정렬: IP 기준')))

      const head = h('div', { className: 'rt-row head' },
        h('span', null, 'IP'), h('span', null, '난이도'), h('span', null, '테스트 상태'),
        h('span', null, '열린 포트 / 서비스'), h('span', null, '핑거프린트'))

      const rowNodes = []
      for (const it of state.items) {
        const openPorts = it.ports.filter((p) => p.state === 'open')
        const portText = openPorts.map((p) => p.port + (p.service ? '/' + p.service : '')).join(', ') || '—'
        const fpText = it.fingerprints.map((f) => [f.vendor, f.product, f.version].filter(Boolean).join(' ')).join(' / ') || '—'
        /* 포트는 최대 3개만 나열하고 나머지는 +N; 능동/수동 출처는 열을 차지하지 않고 상세로 들어간다 */
        const shownPorts = openPorts.slice(0, 3).map((p) => p.port + (p.service ? '/' + p.service : '')).join(', ')
        const morePorts = openPorts.length > 3 ? ' +' + (openPorts.length - 3) : ''
        rowNodes.push(h('div', Object.assign({
          key: 'r' + it.id, className: 'rt-row',
        }, clickable(() => toggleRow(it.id), { label: '자산 펼치기 ' + it.ip, expanded: openId === it.id })),
          h('span', { className: 'rt-mono', style: { display: 'flex', alignItems: 'baseline', gap: 4, flexWrap: 'wrap' } },
            h('span', {
              className: 'rt-scope rt-scope-' + (it.scope === 'internal' ? 'internal' : 'external'),
            }, it.scope === 'internal' ? '내' : '외'),
            h('span', {
              title: it.state === 'live' ? '생존' : String(it.state),
              style: {
                width: 7, height: 7, borderRadius: '50%', flex: 'none', marginTop: 4,
                background: it.state === 'live' ? '#10b981' : '#94a3b8',
              },
            }),
            h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis' } }, it.ip),
            /* 발견 시간은 IP 아래 한 줄에 붙인다: IP 열 너비가 빠듯해 따로 열을 열지 않는다(열 너비를 바꾸면 표 전체를 함께 조정해야 한다) */
            h('span', {
              style: { fontSize: 10.5, color: 'var(--dsw-alias-label-secondary)', whiteSpace: 'nowrap' },
              title: '발견 시간: ' + (it.discovered_at ? fmt(it.discovered_at) : '미기록')
                + (it.last_seen ? '\n최근 수집: ' + fmt(it.last_seen) : ''),
            }, it.discovered_at ? fmtShort(it.discovered_at) : '발견 시간 미상')),
          h('span', null, h(PriTag, { p: it.priority, title: it.potential || '' })),
          h('span', null, h(TestTag, { s: it.test_status }),
            it.blocked_count ? h('span', { className: 'rt-tag', style: { color: '#ef4444', borderColor: '#ef444455', marginLeft: 4 } }, '차단 ' + it.blocked_count) : null),
          h('span', { title: portText }, (shownPorts || '—') + morePorts),
          h('span', { title: fpText }, fpText.length > 30 ? fpText.slice(0, 30) + '…' : fpText)))

        if (openId !== it.id) continue
        const d = detail && detail.id === it.id ? detail : null
        const portRows = []
        const fpRows = []
        const obsRows = []
        if (d) {
          for (const p of (d.ports || [])) {
            if (p.state !== 'open') continue
            portRows.push(h('div', { key: 'p' + p.port, className: 'rt-kv' },
              h('b', { className: 'rt-mono' }, p.port + '/' + p.proto),
              h('span', null, [p.service, p.product, p.version].filter(Boolean).join(' ') || '알 수 없는 서비스'),
              p.url ? h('a', { className: 'rt-link', href: p.url, target: '_blank', rel: 'noreferrer', title: p.url }, p.title ? p.title : p.url) : null,
              h(ProvTag, { p: p.provenance })))
          }
          for (const f of (d.fingerprints || [])) {
            fpRows.push(h('div', { key: 'f' + (f.product || '') + (f.version || '') + (f.evidence || ''), className: 'rt-kv' },
              h('b', null, f.category || '—'),
              h('span', null, [f.vendor, f.product, f.version].filter(Boolean).join(' ') + (f.evidence ? '(' + f.evidence + ')' : '')),
              h(ProvTag, { p: f.provenance })))
          }
          for (const o of (d.observations || []).slice(0, 8)) {
            obsRows.push(h('div', { key: 'o' + (o.attr || '') + (o.value || '') + (o.collected_at || ''), className: 'rt-kv' },
              h('b', null, o.attr || '—'),
              h('span', null, (o.value || '') + ' · ' + (o.tool || '알 수 없는 도구') + ' · ' + fmt(o.collected_at)),
              h(ProvTag, { p: o.provenance })))
          }
        }
        /* 상세는 세 층: 3행은 필수 → "전체 펼치기" 뒤에야 출처 추적, 원본 기록, 비고 전문이 나온다 */
        const all = showAll === it.id
        const noteLines = d && d.test_notes ? d.test_notes.split('\n').filter(Boolean) : []
        const inner = d
          ? h('div', null,
              /* 필수 3행 */
              h('div', { className: 'rt-kv' }, h('b', null, '테스트'), h('span', null,
                h(TestTag, { s: d.test_status }),
                d.blocked_count ? h('span', { className: 'rt-tag', style: { marginLeft: 6, color: '#ef4444', borderColor: '#ef444455' } }, '차단 ' + d.blocked_count + '회') : null,
                h('span', { style: { marginLeft: 8, color: 'var(--dsw-alias-label-secondary)' } },
                  (d.test_updated_at ? fmt(d.test_updated_at) : '테스트한 적 없음') + (d.test_updated_by ? ' · ' + d.test_updated_by : '')))),
              h('div', { className: 'rt-kv' }, h('b', null, '난이도'), h('span', null,
                h(PriTag, { p: d.priority }),
                h('span', { style: { marginLeft: 8 } }, d.potential || '미평가'),
                d.assess_reason ? h('span', { style: { marginLeft: 8, color: 'var(--dsw-alias-label-secondary)' } }, d.assess_reason) : null)),
              h('div', { className: 'rt-kv' }, h('b', null, '공격 표면'), h('span', null,
                d.test_surface || (portRows.length ? '미기록(열린 포트는 아래 참고)' : '열린 포트 없음'),
                d.scope ? h('span', { className: 'rt-scope rt-scope-' + (d.scope === 'internal' ? 'internal' : 'external'), style: { marginLeft: 8 } },
                  d.scope === 'internal' ? '내부 네트워크 자산' : '외부 네트워크 자산') : null)),
              h('span', Object.assign({ className: 'rt-more' },
                clickable(() => setShowAll(all ? null : it.id), { label: all ? '자산 상세 접기' : '자산 상세 펼치기', expanded: all })),
                all ? '전체 접기 ▲' : '전체 펼치기(포트 · 핑거프린트 · 수집 출처 추적 · 테스트 기록) ▼'),
              all ? h('div', null,
                h('div', { className: 'rt-kv' }, h('b', null, '호스트 이름'), h('span', null, (d.names || []).map((n) => n.name).join(', ') || '—')),
                h('div', { className: 'rt-kv' }, h('b', null, '발견 시간'),
                  h('span', { title: '이 자산이 처음 자산 라이브러리에 들어온 시각(중복 수집은 "최근 수집"만 갱신)' }, fmt(d.discovered_at)),
                  h('b', { style: { minWidth: 0, marginLeft: 8 } }, '최근 수집'), h('span', null, fmt(d.last_seen)),
                  h('b', { style: { minWidth: 0, marginLeft: 8 } }, '데이터 소스 최초 확인'), h('span', null, fmt(d.first_seen))),
                h('div', { className: 'rt-kv' }, h('b', null, 'C 세그먼트'), h('span', null, d.segment_cidr)),
                h('div', { className: 'rt-kv' }, h('b', null, '난이도'), h('span', null,
                  (d.priority || '미평가') + (d.potential ? ' · 예상: ' + d.potential : '')
                  + (d.assess_reason ? ' · 근거: ' + d.assess_reason : '')
                  + (d.assessed_at ? '(' + fmt(d.assessed_at) + ')' : ''))),
                h('div', { className: 'rt-kv' }, h('b', null, '출처'), h('span', null,
                  '수동 포트 ' + (d.passive || 0) + ' · 능동 포트 ' + (d.active || 0))),
                h('div', { style: { margin: '6px 0 3px', fontWeight: 600 } }, '열린 포트 / 서비스'),
                h('div', null, portRows.length ? portRows : '—'),
                h('div', { style: { margin: '6px 0 3px', fontWeight: 600 } }, '핑거프린트'),
                h('div', null, fpRows.length ? fpRows : '—'),
                noteLines.length
                  ? h(Clip, { key: 'notes', label: '테스트 기록(' + noteLines.length + '건)', text: noteLines.join('\n') })
                  : null,
                h('div', { style: { margin: '6px 0 3px', fontWeight: 600 } }, '수집 출처 추적(최근 8건)'),
                h('div', null, obsRows.length ? obsRows : '—'))
                : null)
          : h('div', null, '불러오는 중…')
        rowNodes.push(h('div', {
          key: 'd' + it.id, className: 'rt-row',
          style: { cursor: 'default', gridTemplateColumns: '1fr' },
        }, h('div', { className: 'rt-expand' }, inner)))
      }

      const listPane = h('div', { className: 'rt-table' }, head, rowNodes,
        !state.loading && !state.items.length ? h('div', { className: 'rt-empty' }, '조건에 맞는 자산 없음') : null)

      /* 도메인 차원: 도메인 → 연관 자산 */
      const domainPane = h('div', { className: 'rt-table' },
        domains === null ? h('div', { className: 'rt-empty' }, '불러오는 중…')
          : domains.length
          ? domains.map((g) => h('div', { key: g.domain },
              h('div', { className: 'rt-section', style: { padding: '8px 10px 4px' } },
                h('a', { className: 'rt-link', href: 'http://' + g.domain, target: '_blank', rel: 'noreferrer' }, g.domain),
                h('span', { className: 'rt-tag', style: { marginLeft: 8 } }, g.count + ' 개 자산')),
              g.assets.map((a) => h('div', {
                key: String(g.domain) + '\u0000' + a.id + '\u0000' + a.ip, className: 'rt-row',
                style: { gridTemplateColumns: '150px 130px 70px 1fr', cursor: 'pointer' },
                onClick: () => { setView('list'); setQ(''); setQApplied(a.ip) },
              },
                h('span', { className: 'rt-mono' }, a.ip),
                h('span', { className: 'rt-mono' }, a.segment),
                h('span', null, h('span', { className: 'rt-tag rt-tag-' + (a.state === 'live' ? 'live' : 'dead') }, a.state === 'live' ? '생존' : a.state)),
                h('span', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)' } }, (a.names || []).join(', '))))))
          : h('div', { className: 'rt-empty' }, cidr ? '이 C 세그먼트에는 아직 도메인이 없습니다("전체 C 세그먼트"로 전환해 전체 보기)' : '도메인 데이터가 없습니다(정보 수집 단계에서 도메인이 기록됩니다)'))

      /* Web 자산: 제목 + 바로 클릭할 수 있는 URL */
      const webPane = h('div', { className: 'rt-table' },
        h('div', { className: 'rt-row head', style: { gridTemplateColumns: '1.6fr 1.2fr 130px 110px' } },
          h('span', null, 'URL(클릭 가능)'), h('span', null, '제목'), h('span', null, '자산'), h('span', null, '서비스')),
        (web || []).map((w) => {
          const url = w.url || ('http' + (w.port === 443 || w.port === 8443 || w.port === 9443 ? 's' : '') + '://' + w.ip + (w.port === 80 || w.port === 443 ? '' : ':' + w.port))
          return h('div', {
            key: 'w' + w.port_id, className: 'rt-row',
            style: { gridTemplateColumns: '1.6fr 1.2fr 130px 110px', cursor: 'default' },
          },
            h('a', { className: 'rt-link rt-mono', href: url, target: '_blank', rel: 'noreferrer', title: url }, url),
            h('span', { title: w.title || '' }, w.title || '—'),
            h('span', { className: 'rt-mono' }, w.ip + ' · ' + w.segment_cidr),
            h('span', { style: { fontSize: 11 } }, [w.service, w.product, w.version].filter(Boolean).join(' ')))
        }),
        web === null ? h('div', { className: 'rt-empty' }, '불러오는 중…')
          : (!web.length ? h('div', { className: 'rt-empty' }, cidr ? '이 C 세그먼트에는 아직 Web 자산이 없습니다' : 'Web 자산이 없습니다(HTTP 탐지 후 URL 과 제목이 기록됩니다)') : null))


      let pane = listPane
      if (view === 'testing') pane = h(TestingTab, { engagement: eng, refreshKey: refreshKey })
      else if (view === 'domain') pane = domainPane
      else if (view === 'web') pane = webPane
      /* 발견 시간 뷰는 자체 스크롤 컨테이너를 갖고 있으므로 rt-main 의 flex 에 바로 넣는다 */
      else if (view === 'timeline') pane = h(DiscoveryView, { engagement: eng, refreshKey: refreshKey })

      return h('div', { className: 'rt-split' }, side,
        h('div', { className: 'rt-main' }, view === 'testing' ? null : toolbar,
          conclusion,
          state.error ? h('div', { className: 'rt-err' }, state.error) : null,
          pane))
    }

    /* ---------------------------------------------------------- 자산 발견 타임라인 */
    /**
     * 자산 발견 타임라인: 언제 무엇을 발견했고, 어느 날 얼마나 모았는지.
     * ⚠️ 이 컴포넌트는 "그래프 뷰 제거" 때 함께 삭제된 적이 있다 —— 삭제 구간의 끝 표시를 너무 넓게 잡아서
     *    (그래프 캔버스의 끝부분과 붙어 있었다), bundle 자체 점검의 "client.js 에 자산 "발견 시간" 뷰"
     *    그래서 빨갛게 변했다. 복구할 때 삽입 지점을 "자산 정찰 주석 블록 앞"으로 고정해, 다른 삭제에 또 휩쓸리지 않게 했다.
     */
    function DiscoveryView(props) {
      const eng = props.engagement
      const refreshKey = props.refreshKey || 0
      const [data, setData] = React.useState(null)
      const [err, setErr] = React.useState(null)
      const [day, setDay] = React.useState('')
      React.useEffect(() => {
        if (!eng) return
        setData(null)
        api({ op: 'discoveryTimeline', engagement: eng, limit: 200 })
          .then((r) => { if (!r || r.ok === false) setErr((r && r.error) || '불러오기 실패'); else { setErr(null); setData(r) } },
            (e) => setErr(String((e && e.message) || e)))
      }, [eng, refreshKey])
      if (err) return h('div', { className: 'rt-pane' }, h('div', { className: 'rt-err' }, err))
      if (!data) return h('div', { className: 'rt-empty' }, '불러오는 중…')
      const recent = (data.recent || []).filter((a) => day === '' || String(a.discovered_at || '').slice(0, 10) === day)
      return h('div', { className: 'rt-pane', style: { flex: 1, minHeight: 0 } },
        h('div', { className: 'rt-card' },
          h('h4', null, '자산 발견 타임라인'),
          h('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } },
            '총 ' + ((data.span && data.span.total) || 0) + ' 대 · 최초 '
            + (data.span && data.span.first ? fmt(data.span.first) : '—')
            + ' · 최근 ' + (data.span && data.span.last ? fmt(data.span.last) : '—')
            + '(발견 시간 = 처음 자산 라이브러리에 들어온 시각; 중복 수집은 "최근 수집"만 갱신)')),
        (data.days || []).length === 0 ? h('div', { className: 'rt-empty' }, '아직 자산이 없습니다.') : null,
        h('div', { className: 'rt-card' },
          h('h4', null, '일별 통계', day
            ? h('span', Object.assign({ className: 'rt-tag', style: { marginLeft: 6, cursor: 'pointer' } },
                clickable(() => setDay(''), { label: '일별 필터 해제: ' + day })), '필터 해제: ' + day)
            : null),
          h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 8 } },
            (data.days || []).map((d) => h('div', Object.assign({
              key: d.day, className: 'rt-seg' + (day === d.day ? ' on' : ''), style: { marginBottom: 0, cursor: 'pointer' },
              title: d.day + ': 신규 ' + d.assets + ' 대(내부 네트워크 ' + d.internal + ' / 외부 네트워크 ' + d.external + ')',
            }, clickable(() => setDay(day === d.day ? '' : d.day),
              { label: d.day + ' 에 발견한 자산 필터', expanded: day === d.day })),
              h('div', { className: 'rt-seg-cidr' }, d.day),
              h('div', { className: 'rt-seg-meta' }, d.assets + ' 대 · 내 ' + d.internal + ' / 외 ' + d.external))))),
        h('div', { className: 'rt-card' },
          h('h4', null, day ? day + ' 에 발견한 자산(' + recent.length + ')' : '최근 발견한 자산(' + recent.length + ')'),
          recent.length === 0 ? h('div', { className: 'rt-empty' }, '이 날은 새로 추가된 자산이 없습니다.') : null,
          recent.map((a) => h('div', { key: a.id, className: 'rt-kv' },
            h('b', { className: 'rt-mono', style: { minWidth: 110 } },
              h('span', { className: 'rt-scope rt-scope-' + (a.scope === 'internal' ? 'internal' : 'external'), style: { marginRight: 4 } },
                a.scope === 'internal' ? '내' : '외'),
              a.ip),
            h('span', { style: { minWidth: 132, fontSize: 11.5, color: 'var(--dsw-alias-label-secondary)' } },
              a.discovered_at ? fmt(a.discovered_at) : '시간 미상'),
            h('span', { style: { flex: 1 } }, (a.primary_name || '—') + (a.open_ports ? ' · ' + a.open_ports + ' 포트' : '')),
            h(PriTag, { p: a.priority })))))
    }

    /* ---------------------------------------------------------- 에이전트 프롬프트 */
    function PromptsTab(props) {
      const eng = props.engagement
      const refreshKey = props.refreshKey || 0
      const [roles, setRoles] = React.useState([])
      const [active, setActive] = React.useState(null)
      const [draft, setDraft] = React.useState('')
      const [msg, setMsg] = React.useState(null)
      const [busy, setBusy] = React.useState(false)

      React.useEffect(() => {
        /* 타깃이 없어도 허용: 서버가 내장 기본값을 돌려주고, 더 이상 engagement required 를 보고하지 않는다 */
        api(eng ? { op: 'prompts', engagement: eng } : { op: 'prompts' }).then((r) => {
          if (!r || r.ok === false) { setMsg({ err: (r && r.error) || '읽기 실패' }); return }
          setRoles(r.roles || [])
          if (r.roles && r.roles.length) setActive((cur) => cur || r.roles[0].role)
          if (r.builtin) setMsg({ ok: '현재 내장 기본 프롬프트입니다(타깃을 만든 뒤 타깃별로 수정해 저장할 수 있습니다)' })
        }, (e) => setMsg({ err: String((e && e.message) || e) }))
      }, [eng, refreshKey])

      React.useEffect(() => {
        const r = roles.find((x) => x.role === active)
        if (r) setDraft(r.content || '')
      }, [active, roles])

      const save = () => {
        if (!eng) { setMsg({ err: '먼저 타깃을 만든 뒤 프롬프트를 저장하세요' }); return }
        setBusy(true)
        setMsg(null)
        api({ op: 'savePrompt', engagement: eng, role: active, content: draft }).then((r) => {
          setBusy(false)
          if (!r || r.ok === false) { setMsg({ err: (r && r.error) || '저장 실패' }); return }
          setRoles((list) => list.map((x) => (x.role === active
            ? Object.assign({}, x, { content: draft, updated_at: new Date().toISOString() })
            : x)))
          setMsg({ ok: '저장되었습니다' })
        }, (e) => { setBusy(false); setMsg({ err: String((e && e.message) || e) }) })
      }

      /* 오래된 타깃의 프롬프트는 구버전 템플릿이다; 여기서 현재 역할(또는 전체)을 내장 최신 버전으로 복구할 수 있다 */
      const reset = (all) => {
        if (!eng) { setMsg({ err: '먼저 타깃을 만든 뒤 기본 프롬프트를 복구하세요' }); return }
        setBusy(true); setMsg(null)
        api({ op: 'resetPrompts', engagement: eng, role: all ? undefined : active }).then((r) => {
          setBusy(false)
          if (!r || r.ok === false) { setMsg({ err: (r && r.error) || '복구 실패' }); return }
          setMsg({ ok: '내장 기본값으로 복구했습니다: ' + (r.reset || []).join(', ') })
          api({ op: 'prompts', engagement: eng }).then((rr) => {
            if (rr && rr.ok) {
              setRoles(rr.roles || [])
              const cur2 = (rr.roles || []).find((x) => x.role === active)
              if (cur2) setDraft(cur2.content || '')
            }
          }, () => {})
        }, (e) => { setBusy(false); setMsg({ err: String((e && e.message) || e) }) })
      }

      const cur = roles.find((x) => x.role === active)
      const items = roles.map((r) => h('div', Object.assign({
        key: r.role, className: 'rt-item' + (active === r.role ? ' on' : ''),
      }, clickable(() => { setActive(r.role); setMsg(null) },
        { label: '"' + r.title + '" 프롬프트 보기', expanded: active === r.role })),
        h('div', { className: 'rt-item-name' }, r.title),
        h('div', { className: 'rt-item-desc' }, (r.content || '').replace(/[#*`]/g, '').slice(0, 60) || '(비어 있음)')))

      return h('div', { className: 'rt-split' },
        h('div', { className: 'rt-list' }, items),
        h('div', { className: 'rt-main' },
          h('div', { className: 'rt-toolbar' },
            h('span', { style: { fontWeight: 600 } }, cur ? cur.title : '프롬프트'),
            h('span', { className: 'rt-tag' }, '업데이트 ' + fmt(cur && cur.updated_at)),
            h('div', { className: 'rt-spacer' }),
            h('button', {
              className: 'rt-btn', disabled: busy || !active, title: '현재 역할을 내장 최신 버전 프롬프트로 복구',
              onClick: () => reset(false),
            }, '현재 역할 기본값 복구'),
            h('button', {
              className: 'rt-btn', disabled: busy, title: '네 역할 전부를 내장 최신 버전 프롬프트로 복구',
              onClick: () => reset(true),
            }, '전체 기본값 복구'),
            h('button', { className: 'rt-btn rt-btn-primary', disabled: busy || !active, onClick: save }, busy ? '저장 중…' : '저장')),
          msg ? h('div', { className: msg.err ? 'rt-err' : 'rt-foot' }, msg.err || msg.ok) : null,
          h('div', { className: 'rt-pane' },
            h('textarea', {
              className: 'rt-textarea', value: draft, spellCheck: false,
              onChange: (e) => setDraft(e.target.value),
              placeholder: '이 역할의 시스템 프롬프트(Markdown)',
            }),
            h('div', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)', marginTop: 6 } },
              '저장하면 agents/' + (active || 'role') + '.md 에 기록된다. 하위 세션 작업 첫 줄에 redteamRole: recon, assess, vuln-scan, exploit 또는 internal 을 적으면, 해당 파일이 시스템 프롬프트로 들어간다.'))))
    }

    /* ---------------------------------------------------------- 스킬 라이브러리(DSH 네이티브) */
    function SkillsTab(props) {
      const refreshKey = props.refreshKey || 0
      const [items, setItems] = React.useState([])
      const [meta, setMeta] = React.useState({})
      const [err, setErr] = React.useState(null)
      const [q, setQ] = React.useState('')
      const [srcOnly, setSrcOnly] = React.useState(false)
      const [active, setActive] = React.useState(null)
      const [detail, setDetail] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [brokenOnly, setBrokenOnly] = React.useState(false)

      /* refresh=true 는 백엔드의 30초 가용성 캐시를 건너뛴다(스킬 본문/환경 변수가 방금 바뀌었을 수 있다) */
      const load = (force) => {
        setBusy(true)
        api({ op: 'skillCatalog', refresh: force === true }).then((r) => {
          setBusy(false)
          if (!r || r.ok === false) { setErr((r && r.error) || '읽기 실패'); return }
          setErr(null)
          setMeta(r || {})
          setItems(r.items || [])
        }, (e) => { setBusy(false); setErr(String((e && e.message) || e)) })
      }
      React.useEffect(load, [refreshKey])

      const open = (skill) => {
        const name = skill && skill.name
        const key = (skill && skill.library ? skill.library : 'redteam') + ':' + name
        if (active === key) { setActive(null); setDetail(null); return }
        setActive(key)
        setDetail(null)
        api({ op: 'skillRead', name: name, library: skill.library || 'redteam' }).then((r) => {
          if (r && r.ok) setDetail(r)
          else setErr((r && r.error) || '읽기 실패')
        }, (e) => setErr(String((e && e.message) || e)))
      }

      const needle = q.trim().toLowerCase()
      let filtered = needle
        ? items.filter((s) => (s.name + ' ' + s.description + ' ' + s.whenToUse).toLowerCase().indexOf(needle) >= 0)
        : items
      if (srcOnly) filtered = filtered.filter((s) => s.library !== 'official' && s.fromPlugin === true)
      if (brokenOnly) filtered = filtered.filter((s) => s.library !== 'official' && (s.availability === 'broken' || s.availability === 'unknown'))
      /* 디렉터리 집계: "이렇게 많은 스킬이 어디서 왔나"를 한눈에 본다(이 프로젝트/다른 플러그인/내장 루트…) */
      const dirs = (meta.byDir || []).filter((d) => d.n > 0).slice(0, 6)
      const availSummary = meta.availability ? meta.availability.summary : null
      const needRestart = err !== null && String(err).indexOf('unknown op') >= 0

      const renderSkill = (s) => h('div', Object.assign({
        key: (s.library || 'redteam') + ':' + s.name, className: 'rt-item' + (active === ((s.library || 'redteam') + ':' + s.name) ? ' on' : ''),
      }, clickable(() => open(s), { label: '스킬 보기 ' + s.name, expanded: active === ((s.library || 'redteam') + ':' + s.name) })),
        h('div', { className: 'rt-item-name' }, s.name,
          s.modelInvocable === false ? h('span', { className: 'rt-tag', style: { marginLeft: 6 } }, '수동 전용') : null,
          s.library === 'official'
            ? h('span', { className: 'rt-tag', style: { marginLeft: 6 }, title: '공식 스킬 디렉터리로, 레드팀 도구 경로로는 검사하지 않는다' }, '공식')
            : h('span', {
              className: 'rt-avail rt-avail-' + (s.availability || 'unknown'),
              style: { marginLeft: 6 },
              title: (s.availability === 'available'
                ? '사용 가능: 스킬 본문을 불러올 수 있습니다. 빠진 외부 도구나 키는 상세에 기록되며, 호출을 막지 않습니다.'
                : (s.problems || []).join('\n') || '알 수 없음'),
            }, s.availability === 'available' ? '사용 가능' : s.availability === 'broken' ? '사용 불가' : '알 수 없음'),
        h('div', { className: 'rt-item-desc' }, s.description || '(설명 없음)'),
        h('div', { className: 'rt-kb-sub' },
          [s.source ? '출처 ' + s.source : null,
            s.fromPlugin ? '이 플러그인 내장' : null,
            s.provider ? s.provider : null,
            s.dir ? s.dir : null].filter(Boolean).join(' · ')),
        (s.problems || []).length > 0 && s.availability !== 'available' && s.library !== 'official'
          ? h('div', { className: 'rt-kb-sub', style: { color: 'var(--dsw-alias-state-warn-primary, #f59e0b)' } },
              '⚠ ' + String(s.problems[0]).slice(0, 60))
          : null))
      const redteamRows = filtered.filter((s) => s.library !== 'official').map(renderSkill)
      const officialRows = filtered.filter((s) => s.library === 'official').map(renderSkill)
      const listItems = []
      if (redteamRows.length > 0) {
        listItems.push(h('div', { key: 'head-redteam', className: 'rt-kb-sub', style: { margin: '8px 0 4px', fontWeight: 600 } }, '레드팀 스킬'))
        listItems.push.apply(listItems, redteamRows)
      }
      if (officialRows.length > 0) {
        listItems.push(h('div', { key: 'head-official', className: 'rt-kb-sub', style: { margin: '8px 0 4px', fontWeight: 600 } }, '공식 스킬'))
        listItems.push.apply(listItems, officialRows)
      }

      return h('div', { className: 'rt-split' },
        h('div', { className: 'rt-list' },
          h('input', {
            className: 'rt-input', style: { width: '100%', marginBottom: 8, boxSizing: 'border-box' },
            placeholder: '스킬 필터', value: q, onChange: (e) => setQ(e.target.value),
          }),
          h('label', { className: 'rt-kb-check', style: { display: 'flex', margin: '0 0 6px' } },
            h('input', { type: 'checkbox', checked: srcOnly, onChange: (e) => setSrcOnly(e.target.checked) }),
            '이 플러그인 내장만 보기(' + (meta.fromPlugin || 0) + ' 개)'),
          availSummary && (availSummary.broken > 0 || availSummary.unknown > 0)
            ? h('label', {
                className: 'rt-kb-check', style: { display: 'flex', margin: '0 0 8px' },
                title: '명확한 결손(key 없음 / 로컬 경로 없음 / 인프라가 아직 자리표시자)이 있거나 가용성을 판정할 수 없는 스킬만 보기',
              },
                h('input', { type: 'checkbox', checked: brokenOnly, onChange: (e) => setBrokenOnly(e.target.checked) }),
                '사용 불가/알 수 없음만 보기(' + ((availSummary.broken || 0) + (availSummary.unknown || 0)) + ' 개)')
            : null,
          availSummary
            ? h('div', { style: { display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 6 } },
                h('span', { className: 'rt-avail rt-avail-available' }, '사용 가능 ' + (availSummary.available || 0)),
                availSummary.broken > 0 ? h('span', { className: 'rt-avail rt-avail-broken' }, '사용 불가 ' + availSummary.broken) : null,
                availSummary.unknown > 0 ? h('span', { className: 'rt-avail rt-avail-unknown' }, '알 수 없음 ' + availSummary.unknown) : null,
                h('span', Object.assign({
                  className: 'rt-tag', style: { cursor: 'pointer' },
                  title: '스킬 본문이나 환경 변수를 방금 바꿨나요? 여기를 누르면 30초 캐시를 건너뛰고 다시 검사합니다',
                }, clickable(() => load(true), { label: '스킬 가용성 다시 검사' })), '가용성 재검사'))
            : null,
          h('div', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)', marginBottom: 6 } },
            '레드팀 ' + ((meta.libraries && meta.libraries.redteam) || 0) + ' · 공식 ' + ((meta.libraries && meta.libraries.official) || 0),
            items.length > 100 ? h('div', { style: { marginTop: 3 } },
              '(스킬은 대부분 다른 플러그인이 등록한 루트나 자체 스킬 디렉터리에서 옵니다; 이 플러그인은 ' + (meta.fromPlugin || 0) + ' 개만 제공') : null),
          listItems),
        h('div', { className: 'rt-main' },
          h('div', { className: 'rt-toolbar' },
            h('span', { style: { fontWeight: 600 } }, detail ? detail.name : '스킬 디렉터리(DSH 네이티브)'),
            h('div', { className: 'rt-spacer' }),
            h('button', { className: 'rt-btn', disabled: busy, onClick: () => load(true) }, busy ? '새로고침 중…' : '새로고침')),
          err
            ? (needRestart
                ? h('div', { className: 'rt-empty' }, '이 모듈의 호스트 코드가 업데이트되었습니다. 현재 호스트(공식 exe / 커뮤니티판 / dsh web)를 한 번 재시작해야 적용됩니다')
                : h('div', { className: 'rt-err' }, err))
            : null,
          detail
            ? h('div', { className: 'rt-pane' },
                h('div', { className: 'rt-kv' }, h('b', null, '설명'), h('span', null, detail.description || '—')),
                h('div', { className: 'rt-kv' }, h('b', null, '사용 시점'), h('span', null, detail.whenToUse || '—')),
                h('div', { className: 'rt-kv' }, h('b', null, '출처'), h('span', null, (detail.provider || '—') + ' / ' + (detail.source || '—'))),
                (() => {
                  const s2 = items.find((x) => ((x.library || 'redteam') + ':' + x.name) === active)
                  if (!s2) return null
                  if (s2.library === 'official') {
                    return h('div', { className: 'rt-kv' }, h('b', null, '유형'), h('span', null, '공식 스킬. 호스트가 작업에 따라 호출하며, 레드팀 도구 경로로는 검사하지 않습니다.'))
                  }
                  const avail = s2.availability || 'unknown'
                  return h('div', null,
                    h('div', { className: 'rt-kv' }, h('b', null, '가용성'),
                      h('span', { className: 'rt-avail rt-avail-' + avail },
                        avail === 'available' ? '사용 가능' : avail === 'broken' ? '사용 불가(명확한 결손 있음)' : '알 수 없음(본문을 읽을 수 없음)')),
                    (s2.problems || []).length > 0
                      ? h('div', { className: 'rt-kv' }, h('b', null, avail === 'available' ? '설치되지 않은 외부 도구' : '결손'),
                          h('span', null, s2.problems.map((x, i) => h('div', { key: 'p' + i }, '· ' + x))))
                      : null,
                    (s2.needs_user || []).length > 0
                      ? h('div', { className: 'rt-kv' }, h('b', null, '제공 필요'),
                          h('span', { style: { color: 'var(--dsw-alias-state-warn-primary, #f59e0b)' } },
                            s2.needs_user.map((x, i) => h('div', { key: 'n' + i }, '· ' + x))))
                      : null)
                })(),
                detail.path ? h('div', { className: 'rt-kv' }, h('b', null, '파일'), h('span', { className: 'rt-mono', style: { wordBreak: 'break-all' } }, detail.path)) : null,
                h('pre', { className: 'rt-md', style: { border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 6, maxHeight: '52vh' } }, detail.content || '(비어 있음)'))
            : h('div', { className: 'rt-pane' },
                h('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', marginBottom: 8 } },
                  meta.note || '스킬은 DSH 네이티브 skill 체계가 관리하며, 레드팀 에이전트는 skill 도구로 호출합니다.'),
                availSummary
                  ? h('div', { style: { fontSize: 12, marginBottom: 8, display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' } },
                      h('span', { className: 'rt-avail rt-avail-available' }, '사용 가능 ' + (availSummary.available || 0)),
                      availSummary.broken > 0 ? h('span', { className: 'rt-avail rt-avail-broken' }, '사용 불가 ' + availSummary.broken) : null,
                      availSummary.unknown > 0 ? h('span', { className: 'rt-avail rt-avail-unknown' }, '알 수 없음 ' + availSummary.unknown) : null,
                      h('span', { style: { color: 'var(--dsw-alias-label-secondary)' } },
                        '(' + (meta.availability && meta.availability.cached ? '캐시 시각 ' : '검사 시각 ')
                        + (meta.availability && meta.availability.checked_at ? fmt(meta.availability.checked_at) : '—') + ')'))
                  : null,
                meta.availability && (meta.availability.broken || []).length > 0
                  ? h('div', { className: 'rt-hint' },
                      h('div', { style: { fontWeight: 600, marginBottom: 4 } }, '지금 실행할 수 없는 스킬:'),
                      meta.availability.broken.slice(0, 12).map((b) => h('div', { key: b.name },
                        '· ' + b.name + (b.problems && b.problems.length ? ' — ' + b.problems[0] : ''))))
                  : null,
                (meta.byDir || []).slice(0, 6).map((d) => h('div', { key: d.key, className: 'rt-mono', style: { fontSize: 11, marginBottom: 2, overflowWrap: 'anywhere' } },
                  d.n + ' 개 · ' + d.key)),
                (meta.byDir || []).length > 6
                  ? h('div', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)' } },
                      '…그 밖에 ' + ((meta.byDir || []).length - 6) + ' 개 디렉터리(총 ' + items.length + ' 개 스킬)')
                  : null,
                h('div', { className: 'rt-empty' }, '왼쪽에서 스킬을 선택하면 내용을 볼 수 있습니다')))
      )
    }

    /* ---------------------------------------------------------- 취약점 성과 */
    const SEV_LABEL = { critical: '치명적', high: '높음', medium: '중간', low: '낮음', info: '정보' }
    const STATUS_LABEL = { candidate: '검증 대기', confirmed: '확인됨', 'false-positive': '오탐', exploited: '익스플로잇됨', fixed: '수정됨' }
    const sevClass = (s) => 'rt-sev rt-sev-' + (SEV_LABEL[s] ? s : 'info')


    /** 대상 병합: "scheme://host:port" 로 집계해, 경로가 붙은 URL 이 그룹을 흩뜨리지 않게 한다. */
    function targetKeyOf(v) {
      const t = String(v.target || '').trim()
      if (t !== '') {
        const url = /^([a-z][a-z0-9+.-]*:\/\/[^/?#\s]+)/i.exec(t)
        if (url) return url[1]
        const head = /^([^\s/?#]+)/.exec(t)
        if (head) return head[1]
        return t
      }
      return v.asset_ip || '(대상 미지정)'
    }

    /* ---------------------------------------------------------- 증거 렌더링 */
    /** 원본 HTTP 메시지를 "요청 줄/상태 줄 + 헤더 + 본문" 으로 색칠해 눈으로 훑기 쉽게 한다. */
    function HttpBlock(props) {
      const text = String(props.text || '')
      if (!text) return null
      const lines = text.split(/\r?\n/)
      const nodes = lines.map((ln, i) => {
        let cls = null
        if (i === 0 && /^(GET|POST|PUT|DELETE|HEAD|OPTIONS|PATCH|TRACE)\s/.test(ln)) cls = 'rt-hl-req'
        else if (i === 0 && /^HTTP\//.test(ln)) cls = 'rt-hl-res'
        else if (/^[A-Za-z0-9-]+:/.test(ln)) {
          const name = ln.split(':')[0].toLowerCase()
          if (name === 'host' || name === 'cookie' || name === 'authorization' || name === 'content-type') cls = 'rt-hl-req'
        }
        return h('div', { key: 'l' + i, className: cls || undefined }, ln === '' ? '\u00a0' : ln)
      })
      return h('pre', { className: 'rt-evi-body' + (props.compact ? ' req' : '') }, nodes)
    }

    /** 취약점 상세의 증거 영역: 구조화된 증거 텍스트 + 해당 취약점의 원본 HTTP 요청/응답 기록. */
    function detailEvidence(v) {
      const evi = String(v.evidence || '').trim()
      const looksHttp = /^(GET|POST|PUT|DELETE|HEAD|OPTIONS|PATCH|HTTP\/)/m.test(evi) || /\n[A-Za-z-]+: /.test(evi)
      const blocks = []
      if (evi) {
        blocks.push(h('div', { key: 'ev', className: 'rt-evi' },
          h('div', { className: 'rt-evi-head' }, '증거 요약',
            h('span', { className: 'rt-tag' }, looksHttp ? '원본 메시지' : '텍스트'),
            h('div', { className: 'rt-spacer' }),
            h('button', {
              className: 'rt-btn', style: { padding: '0 6px', fontSize: 11 },
              onClick: (e) => { e.stopPropagation(); copyText(evi) },
            }, '복사')),
          looksHttp ? h(HttpBlock, { text: evi }) : h('pre', { className: 'rt-evi-body' }, evi)))
      }
      const http = v.http_evidence || []
      for (const e of http) {
        blocks.push(h('div', { key: 'h' + e.id, className: 'rt-evi' },
          h('div', { className: 'rt-evi-head' },
            e.label || 'HTTP 증거',
            h('span', { className: 'rt-tag' }, (e.method || '') + ' ' + (e.status === null || e.status === undefined ? '' : e.status)),
            h('div', { className: 'rt-spacer' }),
            h('span', { style: { fontWeight: 400, color: 'var(--dsw-alias-label-secondary)' } }, fmt(e.captured_at || e.created_at))),
          e.request ? h('div', null,
            h('div', { className: 'rt-evi-head', style: { borderTop: 'none' } }, '▸ 요청(Burp Repeater 에 바로 붙여넣을 수 있음)'),
            h(HttpBlock, { text: e.request, compact: true })) : null,
          e.response ? h('div', null,
            h('div', { className: 'rt-evi-head' }, '▸ 응답'),
            h(HttpBlock, { text: e.response })) : null,
          e.note ? h('pre', { className: 'rt-evi-body', style: { maxHeight: 80 } }, e.note) : null))
      }
      if (blocks.length === 0) {
        blocks.push(h('div', { key: 'none', className: 'rt-kv' }, h('b', null, '증거'),
          h('span', { style: { color: 'var(--dsw-alias-state-error-primary)' } }, '누락 —— 검증되지 않았거나 증거가 없는 취약점은 보고서에 포함되지 않습니다. redteam_http_evidence_add 로 보강하세요')))
      }
      return h('div', { key: 'eviwrap' }, blocks)
    }

    function FindingsTab(props) {
      const eng = props.engagement
      const refreshKey = props.refreshKey || 0
      const [sev, setSev] = React.useState('')
      const [status, setStatus] = React.useState('')
      const [q, setQ] = React.useState('')
      const [qApplied, setQApplied] = React.useState('')
      const [state, setState] = React.useState({ loading: false, error: null, total: 0, items: [], stats: null })
      const [creds, setCreds] = React.useState([])
      const [accesses, setAccesses] = React.useState([])
      const [files, setFiles] = React.useState([])
      const [openId, setOpenId] = React.useState(null)
      const [msg, setMsg] = React.useState(null)
      /* 하위 탭: 취약점 / 자격 증명 / 접근 세션(자격 증명은 더 이상 취약점 페이지 하단에 깔리지 않는다) */
      const [subTab, setSubTab] = React.useState('vulns')
      /* 기본값은 대상별 집계: 322 건을 평면으로 늘어놓으면 읽을 수 없어, 먼저 "어느 호스트에서 무엇을 얻었나" 를 본다 */
      const [grouped, setGrouped] = React.useState(true)
      const collapse = useCollapse('findings:' + eng)

      const load = () => {
        if (!eng) return
        api({
          op: 'vulns', engagement: eng, severity: sev || undefined,
          status: status || undefined, q: qApplied || undefined, limit: 200,
        }).then((r) => {
          if (!r || r.ok === false) {
            setState({ loading: false, error: (r && r.error) || '조회 실패', total: 0, items: [], stats: null })
            return
          }
          setState({ loading: false, error: null, total: r.total, items: r.items || [], stats: r.stats || null })
        }, (e) => setState({ loading: false, error: String((e && e.message) || e), total: 0, items: [], stats: null }))
        api({ op: 'credentials', engagement: eng }).then((r) => setCreds((r && r.items) || []), () => {})
        api({ op: 'access', engagement: eng }).then((r) => setAccesses((r && r.items) || []), () => {})
        api({ op: 'attackFiles', engagement: eng }).then((r) => setFiles((r && r.items) || []), () => {})
      }
      React.useEffect(load, [eng, sev, status, qApplied, refreshKey])

      const setVulnStatus = (id, next) => {
        setMsg(null)
        api({ op: 'updateVuln', engagement: eng, id: id, patch: { status: next } }).then((r) => {
          if (!r || r.ok === false) { setMsg({ err: (r && r.error) || '업데이트 실패' }); return }
          setMsg({ ok: '"' + (STATUS_LABEL[next] || next) + '" 로 업데이트했습니다' })
          load()
        }, (e) => setMsg({ err: String((e && e.message) || e) }))
      }

      const stats = (state.stats && state.stats.bySeverity) ? state.stats : { bySeverity: {}, byStatus: {} }
      const needRestart = state.error !== null && String(state.error).indexOf('unknown op') >= 0

      const allFiles = (files || []).flatMap((g) => (g.files || []).map((f) => Object.assign({ target: g.target }, f)))
      const filesByVuln = new Map()
      const orphanFiles = []
      for (const f of allFiles) {
        const vid = f.vuln_id === null || f.vuln_id === undefined ? null : Number(f.vuln_id)
        if (vid === null) { orphanFiles.push(f); continue }
        if (!filesByVuln.has(vid)) filesByVuln.set(vid, [])
        filesByVuln.get(vid).push(f)
      }

      /* ── 결론 줄: 결론만 보여주고, 숫자를 클릭하면 필터 ─────────────────────── */
      const concl = (key, label, value, active, onClick) => h('span', Object.assign({
        key: key, className: 'rt-concl-i' + (active ? ' on' : ''), title: '클릭하면 필터 / 다시 클릭하면 해제',
      }, clickable(onClick, { label: '"' + label + '" 기준 필터(' + (value || 0) + ')', expanded: active })),
        h('b', null, String(value || 0)), h('span', null, label))
      const conclusion = h('div', { className: 'rt-concl' },
        concl('conf', '확인됨', (stats.byStatus.confirmed || 0), status === 'confirmed', () => setStatus((v) => (v === 'confirmed' ? '' : 'confirmed'))),
        concl('exp', '익스플로잇됨', (stats.byStatus.exploited || 0), status === 'exploited', () => setStatus((v) => (v === 'exploited' ? '' : 'exploited'))),
        concl('crit', '치명적', (stats.bySeverity.critical || 0), sev === 'critical', () => setSev((v) => (v === 'critical' ? '' : 'critical'))),
        concl('high', '높음', (stats.bySeverity.high || 0), sev === 'high', () => setSev((v) => (v === 'high' ? '' : 'high'))),
        concl('med', '중간', (stats.bySeverity.medium || 0), sev === 'medium', () => setSev((v) => (v === 'medium' ? '' : 'medium'))),
        concl('gain', '권한 획득', (stats.withGained || 0), false, () => {}),
        h('div', { className: 'rt-spacer' }),
        h('span', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)' } },
          '기본값: 대상별 집계 · 총 ' + (stats.targetGroups || 0) + ' 개 대상'))

      const head = h('div', { className: 'rt-vrow head' },
        h('span', null, '등급'), h('span', null, '취약점 / 번호'), h('span', null, '대상'),
        h('span', null, '얻은 것'), h('span', null, '상태'), h('span', null, '신뢰도'))

      /* 단일 취약점(행 + 펼친 상세), 집계 뷰와 평면 뷰가 공유 */
      const vulnRows = (v, compact) => {
        const out = []
        const gainedList = String(v.gained || '').split(/[\u3001,;\uff0c\uff1b]/).map((x) => x.trim()).filter(Boolean)
        const open = openId === v.id
        out.push(h('div', {
          key: 'v' + v.id, className: 'rt-vrow', role: 'button', tabIndex: 0,
          style: compact ? { cursor: 'pointer', gridTemplateColumns: '58px minmax(0,1fr) 104px 68px' } : { cursor: 'pointer' },
          onClick: () => setOpenId(open ? null : v.id),
          onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpenId(open ? null : v.id) } },
        },
          h('span', null, h('span', { className: sevClass(v.severity) }, SEV_LABEL[v.severity] || v.severity)),
          h('span', { title: v.title || '' }, h('span', { className: 'rt-sec-caret' }, open ? '▾' : '▸'), (v.cve ? v.cve + ' ' : '') + (v.title || '')),
          compact ? null : h('span', { className: 'rt-mono', title: v.target || '' }, v.target || v.asset_ip || '—'),
          h('span', { title: v.gained || '' },
            gainedList.length
              ? h('span', { className: 'rt-gain', style: { maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'inline-block' } }, gainedList[0] + (gainedList.length > 1 ? ' +' + (gainedList.length - 1) : ''))
              : h('span', { style: { color: 'var(--dsw-alias-label-secondary)' } }, '—')),
          h('span', null, h('span', { className: 'rt-tag' }, STATUS_LABEL[v.status] || v.status)),
          compact ? null : h('span', null, v.confidence === null || v.confidence === undefined ? '—' : Math.round(v.confidence * 100) + '%')))
        if (openId !== v.id) return out
        out.push(h('div', {
          key: 'vd' + v.id, className: 'rt-vrow',
          style: { cursor: 'default', gridTemplateColumns: '1fr' },
        }, h('div', { className: 'rt-vdetail' },
          h('div', { className: 'rt-kv' }, h('b', null, '얻은 것'),
            gainedList.length
              ? h('span', null, gainedList.map((g, gi) => h('span', { key: 'g' + gi, className: 'rt-gain', style: { marginRight: 6 } }, g)))
              : h('span', { style: { color: 'var(--dsw-alias-label-secondary)' } },
                  '기록 없음 —— 권한/성과를 얻은 뒤 redteam_vuln_update 로 gained 를 보강하세요(예: 서버 권한, 내부 네트워크 터널, 백오피스 관리자 계정)')),
          h('div', { className: 'rt-kv' }, h('b', null, '대상'), h('span', { className: 'rt-mono', style: { wordBreak: 'break-all' } }, v.target || '—')),
          h('div', { className: 'rt-kv' }, h('b', null, '자산'), h('span', null, (v.asset_ip || '—') + ' · ' + (v.segment_cidr || ''))),
          h('div', { className: 'rt-kv' }, h('b', null, '출처'), h('span', null, (v.source || '—') + ' · ' + (v.found_by_agent || '—') + ' · ' + fmt(v.found_at))),
          detailEvidence(v),
          (() => {
            const mine = filesByVuln.get(Number(v.id)) || []
            return h('div', { className: 'rt-kv' }, h('b', null, '공격 파일'),
              mine.length
                ? h('span', null, mine.map((f, fi) => h('div', { key: 'af' + fi, style: { marginBottom: 3 } },
                    '· ' + (f.kind ? '[' + f.kind + '] ' : '') + (f.name || '(이름 없음)')
                    + (f.description ? ' — ' + f.description : ''),
                    h('div', { className: 'rt-mono', style: { fontSize: 11, marginLeft: 12, color: 'var(--dsw-alias-label-secondary)', overflowWrap: 'anywhere' } }, f.path || ''))))
                : h('span', { style: { color: 'var(--dsw-alias-label-secondary)' } },
                    '(없음) redteam_attack_file_add 로 이 취약점을 뚫는 데 쓴 스크립트/웹셸/EXP 를 아카이브하고 vuln_id 를 함께 넣으세요'))
          })(),
          h('div', { className: 'rt-actions' },
            h('button', { className: 'rt-btn', onClick: (e) => { e.stopPropagation(); setVulnStatus(v.id, 'confirmed') } }, '확인'),
            h('button', { className: 'rt-btn', onClick: (e) => { e.stopPropagation(); setVulnStatus(v.id, 'exploited') } }, '익스플로잇됨'),
            h('button', { className: 'rt-btn', onClick: (e) => { e.stopPropagation(); setVulnStatus(v.id, 'false-positive') } }, '오탐'),
            h('button', { className: 'rt-btn', onClick: (e) => { e.stopPropagation(); setVulnStatus(v.id, 'fixed') } }, '수정됨')))))
        return out
      }

      const rows = []
      if (grouped) {
        /* 대상별로 집계해 그룹화: 먼저 "어느 호스트에서 무엇을 얻었나" 를 보고, 들어가서 구체적 취약점을 본다 */
        const groups = new Map()
        for (const v of state.items) {
          const key = targetKeyOf(v)
          if (!groups.has(key)) groups.set(key, [])
          groups.get(key).push(v)
        }
        const SEV_RANK = { critical: 0, high: 1, medium: 2, low: 3, info: 4 }
        const list = Array.from(groups.entries()).map(([key, vs]) => ({
          key,
          vulns: vs,
          top: vs.slice().sort((a, b) => (SEV_RANK[a.severity] ?? 9) - (SEV_RANK[b.severity] ?? 9))[0],
          gained: Array.from(new Set(vs.flatMap((v) => String(v.gained || '').split(/[\u3001,;\uff0c\uff1b]/).map((x) => x.trim()).filter(Boolean)))),
          exploited: vs.filter((v) => v.status === 'exploited').length,
        })).sort((a, b) => (SEV_RANK[a.top.severity] ?? 9) - (SEV_RANK[b.top.severity] ?? 9) || b.vulns.length - a.vulns.length)
        for (const g of list) {
          const key = 'target:' + g.key
          const defOpen = false
          rows.push(h(Section, {
            key: 'sec:' + g.key, tone: 'target',
            title: g.key,
            count: g.vulns.length + ' 개 취약점',
            sub: [
              SEV_LABEL[g.top.severity] || g.top.severity,
              g.exploited ? '익스플로잇됨 ' + g.exploited : null,
              g.top.asset_ip && g.top.asset_ip !== g.key ? '자산 ' + g.top.asset_ip : null,
            ].filter(Boolean).join(' · '),
            right: g.gained.length
              ? g.gained.slice(0, 2).join(' / ') + (g.gained.length > 2 ? ' +' + (g.gained.length - 2) : '')
              : '권한 기록 없음',
            open: collapse.isOpen(key, defOpen),
            onToggle: collapse.toggle(key, defOpen),
          }, g.vulns.map((v) => vulnRows(v, true))))
        }
        if (!list.length && !state.loading && !state.error) {
          rows.push(h('div', { key: 'none', className: 'rt-empty' }, '아직 취약점 기록이 없습니다'))
        }
      } else {
        for (const v of state.items) rows.push(...vulnRows(v))
      }

      const toolbar = h('div', { className: 'rt-toolbar' },
        h('input', {
          className: 'rt-input', style: { flex: '1 1 140px' }, placeholder: '제목 / CVE / 대상 검색(Enter)',
          value: q, onChange: (e) => setQ(e.target.value),
          onKeyDown: (e) => { if (e.key === 'Enter') setQApplied(q) },
        }),
        h('button', { className: 'rt-btn', onClick: () => setQApplied(q) }, '검색'),
        h('select', { className: 'rt-input', value: sev, onChange: (e) => setSev(e.target.value) },
          h('option', { value: '' }, '전체 등급'),
          h('option', { value: 'critical' }, '치명적'),
          h('option', { value: 'high' }, '높음'),
          h('option', { value: 'medium' }, '중간'),
          h('option', { value: 'low' }, '낮음'),
          h('option', { value: 'info' }, '정보')),
        h('select', { className: 'rt-input', value: status, onChange: (e) => setStatus(e.target.value) },
          h('option', { value: '' }, '전체 상태'),
          h('option', { value: 'candidate' }, '검증 대기'),
          h('option', { value: 'confirmed' }, '확인됨'),
          h('option', { value: 'exploited' }, '익스플로잇됨'),
          h('option', { value: 'false-positive' }, '오탐'),
          h('option', { value: 'fixed' }, '수정됨')))

      const credSection = h('div', null,
        h('div', { className: 'rt-section' }, '자격 증명 · ' + creds.length + (creds.length ? '(평문 그대로 표시되므로 화면 공유/녹화에 주의)' : '')),
        creds.length
          ? h('div', { style: { padding: '4px 10px 0' } }, creds.map((c) => h('div', { key: 'c' + c.id, className: 'rt-cred' },
              h('div', { className: 'rt-cred-head' },
                h('span', { className: 'rt-cred-host' }, c.host),
                c.username ? h('span', { className: 'rt-tag' }, c.username) : null,
                h('span', { className: 'rt-tag rt-tag-passive' }, c.secret_type || 'password'),
                c.privilege ? h('span', { className: 'rt-tag rt-tag-active' }, c.privilege) : null,
                h('div', { className: 'rt-spacer' }),
                h('button', {
                  className: 'rt-btn', style: { padding: '0 6px', fontSize: 11 },
                  onClick: (e) => { e.stopPropagation(); copyText(String(c.secret_value || '')) },
                }, '복사')),
              c.secret_value
                ? h('div', { className: 'rt-secret', title: '클릭하면 전체 선택' }, c.secret_value)
                : h('div', { className: 'rt-secret-none' }, '평문 미기록 —— redteam_credential_add 의 secret_value 로 보강해야 패널에 바로 표시됩니다'),
              h('div', { className: 'rt-cred-meta' },
                [c.source ? '출처 ' + c.source : null,
                  c.tool ? '도구 ' + c.tool : null,
                  c.secret_ref ? '증거 ' + c.secret_ref : null,
                  c.found_by_agent ? 'by ' + c.found_by_agent : null,
                  c.found_at ? fmt(c.found_at) : null].filter(Boolean).join(' · ')),
              c.note ? h('div', { className: 'rt-cred-meta' }, '비고: ' + c.note) : null)))
          : h('div', { className: 'rt-empty' }, '아직 자격 증명이 없습니다(비밀번호/키/Hash 를 얻으면 redteam_credential_add 로 저장하면 몇 초 만에 재사용할 수 있습니다)'))

      const accessSection = h('div', null,
        h('div', { className: 'rt-section' }, '획득한 접근 세션 · ' + accesses.length),
        accesses.length
          ? accesses.map((a) => h('div', { key: 'a' + a.id, className: 'rt-vrow', style: { cursor: 'default', gridTemplateColumns: '1fr 110px 80px 80px 1fr' } },
              h('span', { className: 'rt-mono' }, a.host),
              h('span', null, a.username || '—'),
              h('span', null, h('span', { className: 'rt-tag rt-tag-active' }, a.method || '—')),
              h('span', null, a.privilege || '—'),
              h('span', { className: 'rt-mono', title: a.session_ref || '' }, a.session_ref || '—')))
          : h('div', { className: 'rt-empty' }, '없음'))

      const subTabBtn = (key, label, n) => h('span', Object.assign({
        className: 'rt-subtab' + (subTab === key ? ' on' : ''),
      }, clickable(() => setSubTab(key), { label: label + '(' + n + ')', expanded: subTab === key })),
      label + ' ' + n)

      return h('div', { className: 'rt-main' }, toolbar, conclusion,
        h('div', { className: 'rt-subtabs' },
          subTabBtn('vulns', '취약점', state.total || 0),
          subTabBtn('files', '공격 파일', allFiles.length),
          subTabBtn('creds', '자격 증명', creds.length),
          subTabBtn('access', '접근 세션', accesses.length),
          h('div', { className: 'rt-spacer' }),
          grouped ? h('button', {
            className: 'rt-btn', title: '모든 대상 펼치기',
            onClick: () => collapse.setAll((state.items || []).map((v) => 'target:' + targetKeyOf(v)), true),
          }, '전체 펼치기') : null,
          grouped ? h('button', {
            className: 'rt-btn', title: '모든 대상 접기',
            onClick: () => collapse.setAll((state.items || []).map((v) => 'target:' + targetKeyOf(v)), false),
          }, '전체 접기') : null,
          h('button', {
            className: 'rt-btn' + (grouped ? ' rt-btn-primary' : ''),
            title: grouped ? '현재: 대상별 집계(어느 호스트에서 무엇을 얻었나 먼저 보기)' : '현재: 취약점을 하나씩 평면 나열',
            onClick: () => setGrouped((g) => !g),
          }, grouped ? '대상별 집계' : '평면 목록')),
        msg ? h('div', { className: msg.err ? 'rt-err' : 'rt-foot' }, msg.err || msg.ok) : null,
        needRestart ? h('div', { className: 'rt-empty' }, '이 모듈의 호스트 코드가 업데이트되었습니다. 현재 호스트(공식 exe / 커뮤니티판 / dsh web)를 한 번 재시작해야 적용됩니다') : null,
        state.error && !needRestart ? h('div', { className: 'rt-err' }, state.error) : null,
        subTab === 'files'
          ? h('div', { className: 'rt-body', style: { overflow: 'auto' } },
              h('div', { className: 'rt-hint', style: { marginBottom: 8 } },
                '공격 파일은 타깃 디렉터리 기준으로 정리됩니다(기존 "공격 파일" 탭); 각 취약점의 연관 파일도 해당 취약점 상세에서 바로 볼 수 있습니다.'
                + (orphanFiles.length ? ' 현재 ' + orphanFiles.length + ' 개 파일에 vuln_id 가 붙어 있지 않습니다. 취약점과 대응되도록 보강하는 것을 권장합니다.' : '')),
              h(AttackFilesTab, { engagement: eng, refreshKey: refreshKey }))
          : subTab === 'creds'
          ? h('div', { className: 'rt-body', style: { overflow: 'auto' } }, credSection)
          : subTab === 'access'
            ? h('div', { className: 'rt-body', style: { overflow: 'auto' } }, accessSection)
            : h('div', { className: 'rt-table' }, grouped ? null : head, rows,
                !state.loading && !state.items.length && !state.error ? h('div', { className: 'rt-empty' }, '아직 취약점 기록이 없습니다') : null))
    }

    /* ---------------------------------------------------------- 공격 체인 */
    const STAGE_LABEL = { recon: '정보 수집', vuln: '취약점 발견', exploit: '취약점 이용', access: '권한 획득', pivot: '내부 네트워크 돌파', data: '민감 데이터', other: '기타' }

    /* ---------------------------------------------------------- 공격 체인(5단계) */
    /**
     * 공격 표면 위치에 따라 하나의 체인으로 잇는다:
     * ① 정보 수집 → ② 인터넷 자산 권한 → ③ 경계 돌파 → ④ 내부 네트워크 자산 권한 → ⑤ 타깃 권한.
     * 각 단계는 두 가지만 말한다: 이 단계에서 몇 점을 얻었나(누적 얼마), 관련된 자산/터널은 무엇인가.
     * A = 세로 체인(상세); B = 가로 체인(한 화면에 다 보기).
     */
    function ChainTab(props) {
      const eng = props.engagement
      const refreshKey = props.refreshKey || 0
      const [data, setData] = React.useState(null)
      const [err, setErr] = React.useState(null)
      const [loading, setLoading] = React.useState(false)
      const [view, setView] = React.useState('A')
      const [openId, setOpenId] = React.useState(null)

      const load = () => {
        if (!eng) return
        setLoading(true)
        api({ op: 'scoreChain', engagement: eng }).then((r) => {
          setLoading(false)
          if (!r || r.ok === false) { setErr((r && r.error) || '읽기 실패'); return }
          setErr(null); setData(r)
        }, (e) => { setLoading(false); setErr(String((e && e.message) || e)) })
      }
      React.useEffect(load, [eng, refreshKey])

      const stages = (data && data.stages) || []
      const summary = (data && data.summary) || null
      const toggle = (id) => setOpenId((cur) => (cur === id ? null : id))
      const CIRCLED = ['①', '②', '③', '④', '⑤', '⑥']

      /* 단일 득점의 상세 */
      const hitDetail = (x) => h('div', { className: 'rt-flow-detail' },
        h('div', { className: 'rt-kv' }, h('b', null, '대상'), h('span', { className: 'rt-mono', style: { wordBreak: 'break-all' } }, x.target || '—')),
        x.asset_ip ? h('div', { className: 'rt-kv' }, h('b', null, '자산'), h('span', { className: 'rt-mono' }, x.asset_ip)) : null,
        x.vuln_title ? h('div', { className: 'rt-kv' }, h('b', null, '이용 취약점'), h('span', null, [x.vuln_cve, x.vuln_title].filter(Boolean).join(' '))) : null,
        h('div', { className: 'rt-kv' }, h('b', null, '횟수'), h('span', null,
          '동일 유형 ' + x.nth_of_point + ' 번째 · +' + (x.points || 0) + ' 점')),
        h('div', { className: 'rt-kv' }, h('b', null, '기록'), h('span', null, fmt(x.recorded_at) + (x.recorded_by ? ' · ' + x.recorded_by : ''))),
        x.evidence ? h(Clip, { label: '결과와 증거', text: x.evidence }) : null)

      const hitRow = (x) => h('div', {
        key: 'h' + x.id,
        className: 'rt-ap-hit' + (openId === x.id ? ' open' : ''),
        role: 'button', tabIndex: 0,
        onClick: () => toggle(x.id),
        onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(x.id) } },
      },
        h('div', { className: 'rt-ap-hit-head' },
          h('span', { className: 'rt-ap-pts' + (x.counted ? '' : ' uncounted'), title: x.capped_reason || undefined },
            '+' + (x.counted ? (x.points || 0) : 0)),
          h('span', { className: 'rt-ap-hit-name' }, x.point_name),
          x.capped ? h('span', { className: 'rt-tag rt-tag-warn', title: x.capped_reason || '같은 자산의 같은 포트는 점수가 가장 높은 한 건만 인정' }, '서비스 점수 상한 도달 · 미득점') : null,
          x.nth_of_point > 1 ? h('span', { className: 'rt-ap-nth' }, x.nth_of_point + ' 번째') : null,
          h('span', { className: 'rt-ap-hit-target' }, x.target || x.asset_ip || '—')),
        x.action
          ? h('div', { className: 'rt-ap-act' + (x.action_inferred ? ' inferred' : '') },
              '동작: ' + (x.action.title || '(이름 없는 단계)') + (x.action_inferred ? '(추정)' : ''))
          : null,
        openId === x.id ? hitDetail(x) : null)

      /* 자산 행(정보 수집 단계 / 각 단계 관련 자산) */
      const assetRow = (a) => h('div', { key: 'a' + a.id, className: 'rt-ap-asset' },
        h('span', { className: 'rt-scope rt-scope-' + (a.scope === 'internal' ? 'internal' : 'external') },
          a.scope === 'internal' ? '내' : '외'),
        h('span', { className: 'rt-mono', style: { fontWeight: 600 } }, a.ip),
        a.segment_cidr ? h('span', { className: 'rt-ap-nth' }, a.segment_cidr) : null,
        h('span', { className: 'rt-ap-nth' }, '포트 ' + (a.open_ports || 0)),
        a.vulns ? h('span', { className: 'rt-ap-nth' }, '취약점 ' + a.vulns) : null,
        a.priority ? h('span', { className: 'rt-tag' }, '난이도 ' + a.priority) : null,
        h('div', { className: 'rt-spacer' }),
        h('span', { className: 'rt-ap-pts' }, '+' + (a.points || 0) + ' 점'),
        h('span', { className: 'rt-ap-nth' }, (a.hits || 0) + ' 회'))

      /* 공격 체인은 "어디까지 뚫렸고 몇 점을 얻었나" 만 말한다: 공략 요점과 도구 목록은 보여주지 않는다,
         그것들은 실행 디테일이라 체인에 섞으면 득점과 자산 정보를 덮어버린다. */

      /* ── A : 세로 공격 체인 ─────────────────────────────────────────── */
      const stageA = (st, i) => {
        const isRecon = st.code === 'recon'
        const body = []
        if (isRecon) {
          body.push(h('div', { key: 'at', className: 'rt-ap-sub' }, '점수를 얻은 자산 · ' + st.assetCount + ' 대'))
          body.push(h('div', { key: 'al', className: 'rt-ap-assets' },
            st.assets.length ? st.assets.map(assetRow) : h('div', { className: 'rt-ap-none' }, '아직 점수를 만든 자산이 없습니다')))
        } else {
          body.push(h('div', { key: 'ht', className: 'rt-ap-sub' },
            '이 단계 적중 ' + st.hits + ' 회' + (st.points ? ' · +' + st.points + ' 점' : '')))
          body.push(h('div', { key: 'hl', className: 'rt-ap-hits' },
            st.items.length ? st.items.map(hitRow) : h('div', { className: 'rt-ap-none' }, '이 단계에서는 아직 득점이 없습니다')))
          if (st.code === 'boundary') {
            const selfOnly = (st.tunnels_self_only || []).length
            body.push(h('div', { key: 'tt', className: 'rt-ap-sub' },
              '타깃 경계를 넘은 통로 · ' + st.tunnels.length + ' 개' + (selfOnly ? '(그 외 ' + selfOnly + ' 개는 자체 VPS/자체 서버에만 있어 돌파로 치지 않음)' : '')))
            if (selfOnly && st.tunnels.length === 0) {
              body.push(h('div', { key: 'tw', className: 'rt-ap-none' },
                '⚠️ 기존 통로가 모두 자체 서버에 있어 대상에 닿지 않았습니다 —— 경계 돌파로 계산하지 않습니다. 대상 측에서 시작하는 통로가 필요합니다(내 쪽으로 리버스 shell / 대상에서 frp 클라이언트 실행 / 대상 WebShell 경유 suo5).'))
            }
            body.push(h('div', { key: 'tl', className: 'rt-ap-tunnels' },
              st.tunnels.length
                ? st.tunnels.map((t) => h('div', { key: 't' + t.id, className: 'rt-ap-tunnel' },
                    h('span', { className: 'rt-tag rt-tag-passive' }, t.kind || 'tunnel'),
                    h('span', { className: 'rt-mono', style: { fontWeight: 600 } }, t.listen || '—'),
                    h('span', {
                      className: 'rt-tag ' + (t.status === 'active' ? 'rt-tag-live' : ''),
                      style: t.status === 'active' ? {} : { opacity: .7 },
                    }, t.status === 'active' ? '사용 가능' : (t.status || '알 수 없음')),
                    h('span', { className: 'rt-ap-nth', style: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' } },
                      '도달 ' + (t.reach || '—'))))
                : h('div', { className: 'rt-ap-none' }, '아직 터널이 없습니다(만든 뒤 redteam_tunnel_add 로 등록하세요)')))
          }
          if (st.assets.length && st.code !== 'boundary') {
            body.push(h('div', { key: 'at', className: 'rt-ap-sub' }, '관련 자산 · ' + st.assetCount + ' 대'))
            body.push(h('div', { key: 'al', className: 'rt-ap-assets' }, st.assets.map(assetRow)))
          }
        }

        return h('div', { key: 'st' + st.code, className: 'rt-ap-stage' },
          h('div', { className: 'rt-ap-head', style: { borderLeftColor: st.color } },
            h('span', { className: 'rt-ap-no', style: { background: st.color } }, CIRCLED[i] || ('0' + (i + 1))),
            h('span', { className: 'rt-ap-name' }, st.name),
            st.subtitle ? h('span', { className: 'rt-ap-en' }, st.subtitle) : null,
            h('div', { className: 'rt-spacer' }),
            st.points > 0 ? h('span', { className: 'rt-ap-pts', style: { background: st.color + '22', color: st.color, borderColor: st.color + '66' } }, '+' + st.points) : null,
            h('span', { className: 'rt-ap-cum' }, '누적 ' + st.cumulative + ' 점')),
          h('div', { className: 'rt-ap-goal', style: { borderLeftColor: st.color } },
            h('span', { className: 'rt-ap-goal-tag', style: { color: st.color, borderColor: st.color + '66' } }, '단계 목표'),
            h('span', null, st.goal)),
          h('div', { className: 'rt-ap-result', style: { borderLeftColor: st.color } }, body),
          i < stages.length - 1
            ? h('div', { className: 'rt-ap-trans' },
                h('span', { className: 'rt-flow-arrow' }, '▼'),
                st.transition ? h('span', { className: 'rt-ap-trans-t' }, st.transition) : null,
                h('span', { className: 'rt-ap-trans-t', style: { marginLeft: 'auto' } }, '누적 ' + st.cumulative + ' 점'))
            : h('div', { className: 'rt-ap-trans' },
                h('span', { className: 'rt-flow-arrow' }, '▼'),
                h('span', { className: 'rt-ap-trans-t' }, '합계 ' + ((summary && summary.points) || 0) + ' 점')))
      }

      /* ── B : 가로 공격 체인(한 화면에 다 보기) ─────────────────────────────── */
      const stageB = (st, i) => h('div', { key: 'c' + st.code, className: 'rt-ap-col' },
        i > 0 ? h('span', { className: 'rt-ap-col-arrow' }, '▶') : null,
        h('div', { className: 'rt-hcol', style: { borderTopColor: st.color } },
          h('div', { className: 'rt-ap-head', style: { borderLeftColor: st.color, padding: '5px 8px' } },
            h('span', { className: 'rt-ap-no', style: { background: st.color, width: 16, height: 16, fontSize: 10 } }, String(i + 1)),
            h('span', { className: 'rt-ap-name', style: { fontSize: 12 } }, st.name),
            h('div', { className: 'rt-spacer' }),
            h('span', { className: 'rt-ap-cum', style: { fontWeight: 700 } }, st.cumulative)),
          h('div', { className: 'rt-hcol-goal', title: st.goal }, st.goal),
          h('div', { className: 'rt-hcol-body' },
            st.code === 'boundary'
              ? h('div', null,
                  h('div', { className: 'rt-hcol-hit' }, h('span', { className: 'rt-hcol-pts' }, '+' + st.points), h('span', { className: 'rt-hcol-name' }, '터널 ' + st.tunnels.length + ' 개')),
                  st.tunnels.slice(0, 3).map((t) => h('div', { key: 't' + t.id, className: 'rt-hcol-sub' }, '▸ ' + (t.kind || '') + ' ' + (t.listen || ''))))
              : st.code === 'recon'
                ? h('div', null,
                    h('div', { className: 'rt-hcol-hit' }, h('span', { className: 'rt-hcol-pts' }, st.assetCount), h('span', { className: 'rt-hcol-name' }, '대 자산이 득점')),
                    st.assets.slice(0, 6).map((a) => h('div', { key: 'a' + a.id, className: 'rt-hcol-sub', title: a.ip + '  +' + a.points + ' 점' },
                      (a.scope === 'internal' ? '내 ' : '외 ') + a.ip + '  +' + a.points)))
                : h('div', null,
                    h('div', { className: 'rt-hcol-hit' }, h('span', { className: 'rt-hcol-pts' }, '+' + st.points), h('span', { className: 'rt-hcol-name' }, st.hits + ' 회 적중')),
                    st.items.slice(0, 6).map((x) => h('div', { key: 'c' + x.id, className: 'rt-hcol-sub', title: x.point_name + '  ' + (x.target || '') },
                      h('span', { className: 'rt-hcol-pts' }, '+' + x.points), h('span', { className: 'rt-hcol-name' }, x.point_name))),
                    st.items.length > 6 ? h('div', { className: 'rt-hcol-none' }, '…그 밖에 ' + (st.items.length - 6) + ' 회') : null,
                    st.assetCount ? h('div', { className: 'rt-hcol-none' }, '관련 ' + st.assetCount + ' 대 자산') : null))))

      return h('div', { className: 'rt-main' },
        h('div', { className: 'rt-toolbar' },
          h('span', { style: { fontWeight: 600 } }, '공격 체인'),
          h('span', { className: 'rt-tag', style: { fontSize: 10.5 } }, '정보 수집 → 인터넷 자산 권한 → 경계 돌파 → 내부 네트워크 자산 권한 → 타깃 권한'),
          summary ? h('span', { className: 'rt-tag rt-tag-live' }, '총점 ' + summary.points + ' 점') : null,
          h('div', { className: 'rt-spacer' }),
          h('button', { className: 'rt-btn' + (view === 'A' ? ' rt-btn-primary' : ''), title: '세로 공격 체인: 단계별로 아래를 보며 세부 확인', onClick: () => setView('A') }, '체인 A'),
          h('button', { className: 'rt-btn' + (view === 'B' ? ' rt-btn-primary' : ''), title: '가로 공격 체인: 다섯 단계를 한 화면에', onClick: () => setView('B') }, '체인 B'),
          h('button', { className: 'rt-btn', disabled: loading, onClick: load }, loading ? '불러오는 중…' : '새로고침')),
        err ? h('div', { className: 'rt-err' }, err) : null,
        !stages.length && !err && data !== null
          ? h('div', { className: 'rt-empty' }, '아직 득점 기록이 없습니다. 성과를 얻은 뒤 redteam_score_hit 로 기록해야 이 체인이 자라납니다.')
          : view === 'A'
            ? h('div', { className: 'rt-ap' }, stages.map(stageA))
            : h('div', { className: 'rt-ap-h' }, stages.map(stageB)))
    }

    /* ---------------------------------------------------------- 득점 재현 보고서 */
    /**
     * 보고서 그룹 폴백: host 가 평면 항목만 줄 때, scoreChain 의 단계 정보로 항목을 공격 체인 순서대로 그룹화한다.
     * 근거는 양쪽이 공유하는 score_hit id —— scoreChain 의 각 item 에는 stage_code 가 붙고,
     * scoreReport 의 각 item 은 같은 id 를 갖는다. 이렇게 하면 host 측 버전이 오래되었거나 단계 행이 빠져도
     * 보고서 페이지가 정상적으로 표시되고, "아직 전달할 성과가 없다" 는 오탐을 내지 않는다.
     */
    function groupByStage(reportItems, chain) {
      const byId = new Map((reportItems || []).map((x) => [x.id, x]))
      const groups = []
      const stageList = (chain && chain.stages) || []
      stageList.forEach((st, si) => {
        const items = (st.items || []).map((x) => byId.get(x.id)).filter(Boolean)
        if (items.length === 0) return
        groups.push({ code: st.code, name: st.name, color: st.color || '#64748b',
          ordinal: st.ordinal || si + 1, points: st.points || 0, cumulative: st.cumulative || 0, items })
      })
      /* scoreChain 에 단계 정보가 전혀 없을 때는 적어도 득점을 "기타" 로 모아 두어, 항목이 사라지지 않게 한다 */
      const grouped = new Set(groups.reduce((acc, g) => acc.concat(g.items.map((x) => x.id)), []))
      const rest = (reportItems || []).filter((x) => !grouped.has(x.id))
      if (rest.length > 0) {
        groups.push({ code: 'other', name: '기타 득점', color: '#64748b', ordinal: groups.length + 1,
          points: rest.reduce((n, x) => n + (x.counted ? x.points : 0), 0),
          cumulative: 0, items: rest })
      }
      return groups
    }

    function ReportTab(props) {
      const eng = props.engagement
      const refreshKey = props.refreshKey || 0
      const [data, setData] = React.useState(null)
      const [err, setErr] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [msg, setMsg] = React.useState(null)
      /* 보고서는 단계별로 접는다: 기본은 모두 펼침, 접힘 상태는 타깃별로 기억한다(단계가 많을 때 구간별 전달에 편하다) */
      const collapse = useCollapse('report:' + eng)

      const load = () => {
        if (!eng) return
        setBusy(true); setMsg(null)
        api({ op: 'scoreReport', engagement: eng }).then((r) => {
          if (!r || r.ok === false) { setBusy(false); setErr((r && r.error) || '생성 실패'); return }
          /* 구버전 host 가 평면 항목만 주고 단계 그룹을 주지 않을 때(또는 단계 행이 빠졌을 때): 공격 체인 기준으로 직접 그룹화한다,
             그러지 않으면 보고서 페이지가 "아직 전달할 성과가 없다" 는 오탐을 낸다. 그룹 데이터는 scoreChain 에서 가져온다. */
          if ((!r.stages || r.stages.length === 0) && (r.items || []).length > 0) {
            api({ op: 'scoreChain', engagement: eng }).then((c) => {
              setBusy(false); setErr(null); setData(Object.assign({}, r, { stages: groupByStage(r.items, c) }))
            }, () => { setBusy(false); setErr(null); setData(r) })
            return
          }
          setBusy(false); setErr(null); setData(r)
        }, (e) => { setBusy(false); setErr(String((e && e.message) || e)) })
      }
      React.useEffect(load, [eng, refreshKey])

      /* 복사 결과는 진실이어야 한다: clipboard API 가 실패하면(비보안 컨텍스트/포커스 상실/거부) 솔직하게 알린다,
         그러지 않으면 사용자는 복사에 성공한 줄 알고 Yakit 에 붙였는데 비어 있게 된다. */
      const copy = (text, label) => copyWithFeedback(text, label, (okFlag, message) => {
        setMsg(okFlag ? { ok: message } : { err: message })
      })
      const download = (text, label) => {
        try {
          const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' })
          const url = URL.createObjectURL(blob)
          const a = document.createElement('a')
          a.href = url
          a.download = 'report-' + String(label || 'score').replace(/[^\w.\-]/g, '_') + '.md'
          a.click()
          URL.revokeObjectURL(url)
          setMsg({ ok: '내려받았습니다: ' + label })
        } catch (e) { setMsg({ err: '내려받기 실패: ' + ((e && e.message) || e) }) }
      }

      const items = (data && data.items) || []
      const stages = (data && data.stages) || []
      const summary = (data && data.summary) || null
      const mdText = (data && data.markdown) || ''
      const CIRCLED = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩', '⑪', '⑫', '⑬', '⑭', '⑮', '⑯', '⑰', '⑱', '⑲', '⑳']

      /* 항목마다 한 줄, 평면으로 접지 않는다: 대상 → 얻은 것 → 재현 요청(Yakit 에 바로 붙여넣기 가능) → 응답 */
      const card = (x) => h('div', { key: 'r' + x.id, className: 'rt-rep' },
        h('div', { className: 'rt-rep-head' },
          h('span', { className: 'rt-rep-idx' }, String(x.seq)),
          h('span', { className: 'rt-rep-name' }, x.point_name),
          h('span', { className: 'rt-flow-pts' }, '+' + x.points + ' 점'),
          x.nth_of_point > 1 ? h('span', { className: 'rt-tag' }, '동일 유형 ' + x.nth_of_point + ' 번째') : null,
          h('div', { className: 'rt-spacer' }),
          h('button', {
            className: 'rt-btn', style: { padding: '0 6px', fontSize: 11 },
            onClick: () => copy((x.requests || []).map((v) => v.request || '').filter(Boolean).join('\n\n'), '제 ' + x.seq + ' 항목 요청'),
          }, '요청 복사')),
        h('div', { className: 'rt-rep-meta' },
          h('span', null, h('b', null, '대상 ')), h('span', { className: 'rt-mono' }, x.target || x.asset_ip || '—')),
        x.gained ? h('div', { className: 'rt-rep-meta' }, h('b', null, '얻은 것 '), h('span', null, x.gained)) : null,
        x.vuln ? h('div', { className: 'rt-rep-meta' }, h('b', null, '이용 취약점 '),
          h('span', null, [x.vuln.cve, x.vuln.title].filter(Boolean).join(' '))) : null,
        x.evidence ? h('div', { className: 'rt-rep-meta' }, h('b', null, '결과 '),
          h('span', null, String(x.evidence).replace(/\n+/g, ' '))) : null,
        x.recorded_at ? h('div', { className: 'rt-rep-meta' }, h('b', null, '획득 시각 '),
          h('span', null, fmt(x.recorded_at) + (x.recorded_by ? '(' + (ROLE_LABEL[x.recorded_by] || x.recorded_by) + ')' : ''))) : null,
        h(ShotStrip, { eng: eng, shots: x.shots, total: x.shot_total, title: '증거 스크린샷' }),
        /* ── 재현 단계: 동작 기록(실제 명령과 응답 출력 포함) + 자격 증명 + 터널 + WebShell ─────
           보고서의 전달 가치가 전부 이 블록에 있다: 계정 비밀번호가 어떻게 나왔고 터널을 어떻게 세웠는지, 사용자가 그대로 따라 하면 재현된다. */
        h('details', { className: 'rt-rep-trace', open: x.incomplete === true || (x.steps || []).length === 0 },
          h('summary', { className: 'rt-rep-trace-head', style: { cursor: 'pointer' } },
            h('span', { className: 'rt-rep-trace-title' }, '재현 단계(클릭하면 펼침)'),
            (x.steps || []).length ? h('span', { className: 'rt-tag' }, (x.steps || []).length + ' 개 동작') : null,
            (x.credentials || []).length ? h('span', { className: 'rt-tag' }, (x.credentials || []).length + ' 건 자격 증명') : null,
            (x.tunnels || []).length ? h('span', { className: 'rt-tag' }, (x.tunnels || []).length + ' 개 터널') : null,
            x.incomplete ? h('span', { className: 'rt-tag rt-tag-warn' }, '재현 자료 보강 필요') : h('span', { className: 'rt-tag rt-tag-live' }, '재현 가능')),
          h('div', { style: { paddingTop: 6 } },
          x.how ? h('div', { className: 'rt-rep-trace-how' }, x.how) : null,
          (x.steps || []).length === 0
            ? h('div', { className: 'rt-rep-missing' },
                '⚠️ 연결된 공격 단계가 없습니다: 이 단계를 어떻게 했는지 설명할 수 없습니다. redteam_chain_add 로 동작(title / detail / tool / result)을 보강하세요. 득점 기록 시 point_code + evidence 를 함께 넣어 한 번에 끝낼 수도 있습니다.')
            : (x.steps || []).map((s, si) => h('div', { key: 's' + s.id, className: 'rt-rep-step' },
                h('div', { className: 'rt-rep-step-head' },
                  h('span', { className: 'rt-rep-step-no' }, String(si + 1)),
                  h('span', { className: 'rt-rep-step-title' }, s.title || '(이름 없는 동작)'),
                  s.agent ? h('span', { className: 'rt-tag' }, ROLE_LABEL[s.agent] || s.agent) : null,
                  s.stage_code ? h('span', { className: 'rt-tag' }, s.stage_code) : null,
                  s.inferred ? h('span', { className: 'rt-tag' }, '동일 자산 기준 추정') : null,
                  h('div', { className: 'rt-spacer' }),
                  s.recorded_at ? h('span', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)' } }, fmt(s.recorded_at)) : null),
                s.detail ? h('div', { className: 'rt-rep-step-detail' }, s.detail) : null,
                h('div', { className: 'rt-rep-step-cmd' },
                  h('b', null, '실행 '),
                  s.tool
                    ? h('span', { className: 'rt-mono' }, s.tool)
                    : h('span', { style: { color: 'var(--dsw-alias-state-warn-primary, #f59e0b)' } }, '실제 명령 미기록(redteam_chain_add 의 tool)')),
                s.tool ? h('div', { style: { marginTop: 3 } },
                  h('button', {
                    className: 'rt-btn', style: { padding: '0 6px', fontSize: 11 },
                    onClick: () => copy(String(s.tool), '제 ' + (si + 1) + ' 단계 명령'),
                  }, '명령 복사')) : null,
                s.result ? h('div', { className: 'rt-rep-step-result' }, h('b', null, '결과 '), String(s.result).replace(/\n+/g, ' ')) : null,
                s.evidence_ref ? h('div', { className: 'rt-rep-step-result' }, h('b', null, '증거 '), h('span', { className: 'rt-mono' }, s.evidence_ref)) : null)),
          /* 계정 비밀번호가 어떻게 나왔는지: 자격 증명의 출처 + 획득 방식 */
          (x.credentials || []).length
            ? h('div', { className: 'rt-rep-src' },
                h('div', { className: 'rt-rep-src-title' }, '획득한 자격 증명(출처 추적 가능)'),
                (x.credentials || []).map((c) => h('div', { key: 'c' + c.id, className: 'rt-kv' },
                  h('b', { className: 'rt-mono', style: { minWidth: 120 } }, c.host || '—'),
                  h('span', null, (c.username || '(사용자 이름 없음)') + ' / ' + (c.secret_type || 'password')
                    + (c.privilege ? ' · 권한 ' + c.privilege : '')
                    + ' · 출처 ' + (c.source || '미표기')
                    + (c.tool ? ' · 획득 방식 ' + String(c.tool).replace(/\n+/g, ' ').slice(0, 160) : '')))))
            : null,
          /* 터널을 어떻게 세웠는지 */
          (x.tunnels || []).length
            ? h('div', { className: 'rt-rep-src' },
                h('div', { className: 'rt-rep-src-title' }, '사용한 터널 / 통로'),
                (x.tunnels || []).map((t) => h('div', { key: 't' + t.id, className: 'rt-kv' },
                  h('b', { className: 'rt-mono', style: { minWidth: 120 } }, (t.kind || 'socks5') + ' ' + (t.listen || '')),
                  h('span', null, '입구 ' + (t.entry || '미등록')
                    + (t.reach ? ' · 도달 ' + t.reach : '')
                    + ' · 대상 측 ' + (t.entry_kind || '미선언')
                    + (t.legit === false ? ' · ⚠️ 타깃 경계 횡단으로 치지 않음' : '')
                    + (t.status ? ' · ' + t.status : '')
                    + (t.command ? ' · 명령 ' + String(t.command).replace(/\n+/g, ' ').slice(0, 160) : '')))))
            : null,
          (x.webshells || []).length
            ? h('div', { className: 'rt-rep-src' },
                h('div', { className: 'rt-rep-src-title' }, '사용한 WebShell'),
                (x.webshells || []).map((w) => h('div', { key: 'w' + w.id, className: 'rt-kv' },
                  h('b', { className: 'rt-mono', style: { minWidth: 120 } }, w.shell_type || 'shell'),
                  h('span', null, (w.url || '') + (w.pass_key ? ' · 비밀번호/키 ' + w.pass_key : '')
                    + (w.privilege ? ' · 권한 ' + w.privilege : '') + (w.status ? ' · ' + w.status : '')))))
            : null,
          (x.gaps || []).length ? h('div', { className: 'rt-rep-missing' }, '⚠️ 재현 결손: ' + x.gaps.join('; ')) : null),
        (x.requests || []).length === 0
          ? h('div', { className: 'rt-rep-missing' }, '⚠️ 이 항목에는 원본 요청 기록이 없어 바로 재현할 수 없습니다 —— redteam_http_evidence_add 로 보강하세요')
          : (x.requests || []).map((r, ri) => h('div', { key: 'q' + ri, className: 'rt-rep-req' },
              h('div', { className: 'rt-rep-req-head' },
                h('span', null, '재현 요청 ' + (ri + 1) + (r.source === 'auto' ? '(대상 경로 기준 자동 매칭, 확인 필요)' : '')),
                h('span', { className: 'rt-tag' }, (r.method || 'GET') + ' ' + (r.status === null || r.status === undefined ? '' : r.status)),
                h('div', { className: 'rt-spacer' }),
                h('button', {
                  className: 'rt-btn', style: { padding: '0 6px', fontSize: 11 },
                  onClick: () => copy(String(r.request || ''), '요청 ' + (ri + 1)),
                }, 'Yakit 에 복사')),
              h('pre', { className: 'rt-rep-http' }, r.request || ((r.method || 'GET') + ' ' + (r.url || '') + ' HTTP/1.1')),
              r.response ? h('div', null,
                h('div', { className: 'rt-rep-req-head' }, h('span', null, '응답 요약')),
                h('pre', { className: 'rt-rep-http', style: { maxHeight: 160 } }, String(r.response).slice(0, 1600))) : null)),
        x.note ? h('div', { className: 'rt-rep-meta' }, h('b', null, '비고 '), h('span', null, x.note)) : null))

      return h('div', { className: 'rt-main' },
        h('div', { className: 'rt-toolbar' },
          h('span', { style: { fontWeight: 600 } }, '공격 득점 체인 재현 보고서'),
          summary ? h('span', { className: 'rt-tag rt-tag-live' }, '합계 ' + summary.points + ' 점') : null,
          summary ? h('span', { className: 'rt-tag' }, summary.count + ' 개 득점') : null,
          summary ? h('span', { className: 'rt-tag' + (summary.missingRequests ? '' : ' rt-tag-live') },
            summary.withRequests + '/' + summary.count + ' 개 원본 요청 포함') : null,
          summary ? h('span', {
            className: 'rt-tag' + (summary.incomplete ? ' rt-tag-warn' : ' rt-tag-live'),
            title: '재현 체인이 완전한가: 공격 단계가 있고, 실제 명령이 적혀 있고, 취약점/자격 증명/터널이 연결되었는가',
          }, '재현 가능 ' + (summary.count - (summary.incomplete || 0)) + '/' + summary.count) : null,
          summary && summary.serviceCappedExcluded
            ? h('span', {
                className: 'rt-tag rt-tag-warn',
                title: (summary.serviceCapped || []).map((x) => (x.service || '') + '|' + (x.point_name || '')).join('\n')
                  || '같은 자산 같은 포트의 중복 계정/데이터베이스 권한 적중: 서비스 점수가 이미 상한이라 미득점, 보고서 미포함',
              }, '같은 서비스 상한 도달로 미득점 ' + summary.serviceCappedExcluded)
            : null,
          h('div', { className: 'rt-spacer' }),
          h('button', { className: 'rt-btn', disabled: busy || !mdText, onClick: () => copy(mdText, '보고서 전체') }, '전문 복사'),
          h('button', { className: 'rt-btn', disabled: busy || !mdText, onClick: () => download(mdText, (data && data.target) || eng) }, '.md 내려받기'),
          h('button', { className: 'rt-btn', disabled: busy, onClick: load }, busy ? '생성 중…' : '다시 생성')),
        msg ? h('div', { className: msg.err ? 'rt-err' : 'rt-foot' }, msg.err || msg.ok) : null,
        err ? h('div', { className: 'rt-err' }, err) : null,
        h('div', { className: 'rt-body', style: { overflow: 'auto' } },
          stages.length
            ? h('div', { className: 'rt-rep-list' },
                h('div', { className: 'rt-rep-tools' },
                  h('button', { className: 'rt-btn', onClick: () => collapse.setAll(stages.map((s) => 'st:' + s.code), true) }, '전체 펼치기'),
                  h('button', { className: 'rt-btn', onClick: () => collapse.setAll(stages.map((s) => 'st:' + s.code), false) }, '전체 접기')),
                stages.map((st) => {
                  const open = collapse.isOpen('st:' + st.code, true)
                  const toggle = collapse.toggle('st:' + st.code, true)
                  return h('div', { key: 'g' + st.code, className: 'rt-rep-group' },
                    h('div', {
                      className: 'rt-rep-stage', role: 'button', tabIndex: 0,
                      style: { borderLeftColor: st.color },
                      'aria-expanded': open ? 'true' : 'false',
                      onClick: toggle,
                      onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(e) } },
                    },
                      h('span', { className: 'rt-sec-caret' }, open ? '▾' : '▸'),
                      h('span', { className: 'rt-rep-no', style: { background: st.color } }, CIRCLED[st.ordinal - 1] || st.ordinal),
                      h('span', { className: 'rt-rep-stage-name' }, st.name),
                      h('span', { className: 'rt-rep-stage-n' }, st.items.length + ' 항목'),
                      h('div', { className: 'rt-spacer' }),
                      h('span', { className: 'rt-rep-pts', style: { background: st.color + '22', color: st.color, borderColor: st.color + '66' } },
                        '+' + st.points + ' 점'),
                      h('span', { className: 'rt-ap-cum' }, '누적 ' + st.cumulative + ' 점')),
                    open ? h('div', { className: 'rt-rep-body' }, st.items.map(card)) : null)
                }))
            : (data === null ? h('div', { className: 'rt-empty' }, '불러오는 중…')
                : h('div', { className: 'rt-empty' },
                    h('div', null, '아직 전달할 성과가 없습니다.'),
                    h('div', { style: { marginTop: 6, fontSize: 12 } },
                      '이 보고서는 "득점한" 성과만 수록합니다; 득점이 없는 취약점은 보고서에 들어가지 않습니다. 성과를 얻은 뒤 redteam_score_hit 로 득점을 기록하고(대상 자산 + 얻은 것), 재현을 위해 redteam_http_evidence_add 를 보강하세요.')))),
        h('div', { className: 'rt-foot' },
          h('span', null, '기준: 득점 성과만 수록하고, 각 항목에 Yakit Repeater 에 붙여넣을 수 있는 원본 요청을 첨부합니다')))
    }

    /* ---------------------------------------------------------- 공격 파일 */
    const FILE_KIND = { poc: 'POC', exp: 'EXP', script: '스크립트', wordlist: '사전', other: '기타' }

    function AttackFilesTab(props) {
      const eng = props.engagement
      const refreshKey = props.refreshKey || 0
      const [folders, setFolders] = React.useState([])
      const [err, setErr] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const collapse = useCollapse('files:' + eng)
      const [detail, setDetail] = React.useState(null)

      const load = () => {
        if (!eng) return
        setBusy(true)
        api({ op: 'attackFiles', engagement: eng }).then((r) => {
          setBusy(false)
          if (!r || r.ok === false) { setErr((r && r.error) || '읽기 실패'); return }
          setErr(null)
          setFolders(r.items || [])
        }, (e) => { setBusy(false); setErr(String((e && e.message) || e)) })
      }
      React.useEffect(load, [eng, refreshKey])

      const openFile = (f) => {
        if (detail && detail.id === f.id) { setDetail(null); return }
        setDetail(null)
        api({ op: 'readAttackFile', engagement: eng, id: f.id }).then((r) => {
          if (r && r.ok) setDetail(r)
          else setErr((r && r.error) || '읽기 실패')
        }, (e) => setErr(String((e && e.message) || e)))
      }

      const rows = []
      for (const folder of folders) {
        const fKey = 'folder:' + folder.folder
        const fileNodes = []
        for (const f of folder.files) {
          fileNodes.push(h('div', {
            key: 'a' + f.id, className: 'rt-vrow', style: { gridTemplateColumns: '18px 1.2fr 60px 1.6fr', cursor: 'pointer' },
            role: 'button', tabIndex: 0,
            onClick: () => openFile(f),
            onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openFile(f) } },
          },
            h('span', { className: 'rt-sec-caret' }, detail && detail.id === f.id ? '▾' : '▸'),
            h('span', { className: 'rt-mono' }, f.name),
            h('span', null, h('span', { className: 'rt-tag rt-tag-active' }, FILE_KIND[f.kind] || f.kind || '—')),
            h('span', { style: { fontSize: 11.5, color: 'var(--dsw-alias-label-secondary)' }, title: f.description || '' }, f.description || '—')))
          if (!detail || detail.id !== f.id) continue
          fileNodes.push(h('div', {
            key: 'ad' + f.id, className: 'rt-vrow', style: { cursor: 'default', gridTemplateColumns: '1fr' },
          }, h('div', { className: 'rt-vdetail' },
            h('div', { className: 'rt-kv' }, h('b', null, '효과'), h('span', null, detail.evidence || '—')),
            h('div', { className: 'rt-kv' }, h('b', null, '경로'), h('span', { className: 'rt-mono', style: { wordBreak: 'break-all' } }, detail.path)),
            h('div', { className: 'rt-kv' }, h('b', null, '기록'), h('span', null, fmt(detail.created_at) + (detail.created_by ? ' · ' + detail.created_by : ''))),
            h('pre', { className: 'rt-md', style: { border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 6, maxHeight: '40vh', padding: '10px 12px' } }, detail.content || '(비어 있음)'))))
        }
        rows.push(h(Section, {
          key: 'sec:' + folder.folder, tone: 'folder', title: folder.folder + '/',
          count: folder.count + ' 개 파일',
          open: collapse.isOpen(fKey, true), onToggle: collapse.toggle(fKey, true),
        }, fileNodes.length ? fileNodes : h('div', { className: 'rt-atest-meta' }, '(비어 있음)')))
      }

      const total = folders.reduce((n, f) => n + f.count, 0)
      return h('div', { className: 'rt-main' },
        h('div', { className: 'rt-toolbar' },
          h('span', { style: { fontWeight: 600 } }, '공격 파일'),
          h('span', { className: 'rt-tag' }, folders.length + ' 개 대상 / ' + total + ' 개 파일'),
          h('div', { className: 'rt-spacer' }),
          h('button', { className: 'rt-btn', disabled: busy, onClick: load }, busy ? '새로고침 중…' : '새로고침')),
        err ? h('div', { className: 'rt-err' }, err) : null,
        h('div', { className: 'rt-table' },
          rows,
          !folders.length ? h('div', { className: 'rt-empty' }, '아직 공격 파일이 없습니다(뚫은 스크립트/POC/EXP 가 대상 폴더별로 여기에 나타납니다)') : null),
        h('div', { className: 'rt-foot' }, h('span', null, '디렉터리: attack-files/<IP|URL호스트|C 세그먼트>/ | 실제로 효과가 있었던 파일만 수록')))
    }

    /* ---------------------------------------------------------- 지식 베이스(POC/EXP, 전역 공유) */
    /**
     * 지식 베이스 페이지: Nday/1day 를 치기 전에 여기서 먼저 검색한다. 검색창은 CVE / 컴포넌트 / 키워드 / 본문 키워드를 지원하고,
     * 있으면 펼쳐서 전문을 가져다 쓰고(바로 복사해 사용), 없으면 인터넷에서 찾거나 직접 만들어 검증 후 다시 채워 넣는다.
     * 이곳은 **전역**이다: 타깃을 바꿔도 유지되며, 한 타깃에서 쌓은 범용 POC 는 이후 모든 타깃에서 쓸 수 있다.
     */
    const POC_KIND_LABEL = { poc: 'POC', exp: 'EXP', script: '스크립트', template: '템플릿', payload: '페이로드' }
    const POC_SOURCE_LABEL = { web: '인터넷', self: '직접 제작', manual: '수동', 'nuclei-template': 'nuclei 템플릿', kb: '지식 베이스' }

    function KnowledgeTab(props) {
      const refreshKey = props.refreshKey || 0
      const [data, setData] = React.useState(null)
      const [err, setErr] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [msg, setMsg] = React.useState(null)
      const [q, setQ] = React.useState('')
      const [kind, setKind] = React.useState('')
      const [category, setCategory] = React.useState('')
      const [engagement, setEngagement] = React.useState('')
      const [assetTarget, setAssetTarget] = React.useState('')
      const [grouped, setGrouped] = React.useState(true)
      const [verifiedOnly, setVerifiedOnly] = React.useState(false)
      const [openId, setOpenId] = React.useState(null)
      const [detail, setDetail] = React.useState(null)
      const [detailBusy, setDetailBusy] = React.useState(false)
      const [tplOffset, setTplOffset] = React.useState(0)
      const tplPageSize = 40

      const query = (over) => {
        const extra = over || {}
        const offset = Object.prototype.hasOwnProperty.call(extra, 'templateOffset') ? extra.templateOffset : 0
        setTplOffset(offset)
        const params = Object.assign({
          q: q.trim() || undefined,
          kind: kind || undefined,
          category: category || undefined,
          engagement: engagement || undefined,
          asset_target: assetTarget.trim() || undefined,
          verified: verifiedOnly || undefined,
          templateOffset: offset || 0,
          templateLimit: tplPageSize,
        }, extra)
        setBusy(true); setMsg(null)
        api(Object.assign({ op: 'pocSearch' }, params)).then((r) => {
          setBusy(false)
          if (!r || r.ok === false) { setErr((r && r.error) || '읽기 실패'); return }
          setErr(null); setData(r)
        }, (e) => { setBusy(false); setErr(String((e && e.message) || e)) })
      }
      /* 처음 진입할 때와 새로고침 키가 바뀔 때 전체를 가져온다(검색은 명시적 동작이므로 타이핑 중 API 호출을 피한다) */
      React.useEffect(() => { query({ q: undefined, kind: undefined, category: undefined, engagement: undefined, asset_target: undefined, verified: undefined }) }, [refreshKey])

      const open = (id) => {
        if (openId === id) { setOpenId(null); setDetail(null); return }
        setOpenId(id); setDetail(null); setDetailBusy(true)
        api({ op: 'pocGet', id: id }).then((r) => {
          setDetailBusy(false)
          if (!r || r.ok === false) { setMsg({ err: (r && r.error) || '읽기 실패' }); return }
          setDetail(r)
        }, (e) => { setDetailBusy(false); setMsg({ err: String((e && e.message) || e) }) })
      }

      /* 보고서 페이지와 동일: await 로 실제 결과를 받은 뒤 알린다 */
      const copy = (text, label) => copyWithFeedback(text, label, (okFlag, message) => {
        setMsg(okFlag ? { ok: message } : { err: message })
      })
      const useIt = (row) => {
        api({ op: 'pocUse', id: row.id, used_on: '콘솔에서 수동 표시' }).then(() => {
          setMsg({ ok: '재사용 1회를 기록했습니다: ' + row.title })
          query()
        }, (e) => setMsg({ err: String((e && e.message) || e) }))
      }

      const stats = (data && data.stats) || { total: 0, verified: 0, reused: 0, byKind: [], bySource: [] }
      const items = (data && data.items) || []
      const tpl = (data && data.templates) || { dir: null, total: 0, matched: 0, offset: 0, items: [], byCategory: [] }
      const tplByCat = new Map((tpl.byCategory || []).map((c) => [c.code, c.n || 0]))
      const catShown = (c) => (c.n || 0) + (tplByCat.get(c.code) || 0)
      const tplItems = tpl.items || []
      const tplMatched = tpl.matched != null ? tpl.matched : tpl.total
      const tplStart = Number(tpl.offset) || 0
      const turnTpl = (next) => {
        const offset = Math.max(0, next)
        setTplOffset(offset)
        query({ templateOffset: offset })
      }

      const card = (x) => {
        const isOpen = openId === x.id
        const d = isOpen && detail && detail.id === x.id ? detail : null
        return h('div', { key: 'p' + x.id, className: 'rt-kb' + (isOpen ? ' open' : '') },
          h('div', {
            className: 'rt-kb-head', role: 'button', tabIndex: 0, 'aria-expanded': isOpen ? 'true' : 'false',
            onClick: () => open(x.id),
            onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(x.id) } },
          },
            h('span', { className: 'rt-sec-caret' }, isOpen ? '▾' : '▸'),
            h('span', { className: 'rt-kb-kind k-' + (x.kind || 'poc') }, POC_KIND_LABEL[x.kind] || x.kind || 'POC'),
            h('span', { className: 'rt-kb-title' }, x.title),
            x.cve ? h('span', { className: 'rt-tag rt-tag-passive' }, x.cve) : null,
            x.component ? h('span', { className: 'rt-tag' }, x.component) : null,
            x.verified === 1
              ? h('span', { className: 'rt-tag rt-tag-live' }, '검증됨')
              : h('span', { className: 'rt-tag rt-tag-warn' }, '미검증'),
            h('div', { className: 'rt-spacer' }),
            h('span', { className: 'rt-tag' }, POC_SOURCE_LABEL[x.source] || x.source || '—'),
            x.hit_count ? h('span', { className: 'rt-tag' }, '재사용 ' + x.hit_count) : null),
          /* 출처 줄: 분류 · 영향 버전 · 생성 시각 · 출처 타깃 · 발견 자산 —— 한 항목이 "언제,
             어느 조직의 어떤 자산에서 발견했는지" 를 한눈에 볼 수 있다 */
          h('div', { className: 'rt-kb-sub' },
            [x.category ? '분류 ' + (POC_CAT_NAME[x.category] || x.category) : null,
              x.versions ? '영향 버전 ' + x.versions : null,
              x.language || null,
              x.tags || null,
              '생성 시각 ' + fmt(x.created_at),
              (x.engagement_name || x.engagement_id) ? '출처 타깃 ' + (x.engagement_name || x.engagement_id) : null,
              x.asset_target ? '발견 자산 ' + x.asset_target : null,
              x.found_by_agent ? '발견 역할 ' + (ROLE_LABEL[x.found_by_agent] || x.found_by_agent) : null,
              x.source_url ? '출처 ' + x.source_url : null].filter(Boolean).join(' · ')),
          isOpen
            ? h('div', { className: 'rt-kb-body' },
                detailBusy && !d ? h('div', { className: 'rt-empty' }, '읽는 중…') : null,
                d ? h('div', null,
                  d.usage ? h('div', { className: 'rt-kv' }, h('b', null, '사용법'), h('span', { className: 'rt-mono' }, d.usage)) : null,
                  d.description ? h('div', { className: 'rt-kv' }, h('b', null, '설명'), h('span', null, d.description)) : null,
                  d.verified_note ? h('div', { className: 'rt-kv' }, h('b', null, '검증 증거'), h('span', null, d.verified_note)) : null,
                  d.used_on ? h('div', { className: 'rt-kv' }, h('b', null, '최근 사용'), h('span', null, d.used_on)) : null,
                  d.path ? h('div', { className: 'rt-kv' }, h('b', null, '파일 기록'), h('span', { className: 'rt-mono' }, d.path)) : null,
                  h('div', { className: 'rt-kb-actions' },
                    h('button', { className: 'rt-btn', disabled: !d.content, onClick: () => copy(d.content || '', 'POC 본문') }, '본문 복사'),
                    h('button', { className: 'rt-btn', onClick: () => useIt(x) }, '재사용 1회 기록'),
                    d.source_url ? h('button', { className: 'rt-btn', onClick: () => copy(d.source_url, '출처 링크') }, '출처 복사') : null),
                  d.content
                    ? h('pre', { className: 'rt-rep-http' }, d.content.length > 12000 ? d.content.slice(0, 12000) + '\n…(잘렸습니다. 전체 내용은 저장된 파일을 보세요)' : d.content)
                    : h('div', { className: 'rt-empty' }, '이 항목은 메타데이터만 있고 본문이 없습니다 —— 본문을 얻은 뒤 redteam_poc_update 로 보강하세요'))
                : null)
            : null)
      }

      return h('div', { className: 'rt-main' },
        h('div', { className: 'rt-toolbar' },
          h('span', { style: { fontWeight: 600 } }, '지식 베이스 · POC / EXP'),
          h('span', { className: 'rt-tag' }, stats.total + ' 건'),
          h('span', { className: 'rt-tag rt-tag-live' }, '검증됨 ' + stats.verified),
          h('span', { className: 'rt-tag' }, '누적 재사용 ' + (stats.reused || 0)),
          (stats.uncategorized || 0) > 0 && (stats.uncategorized || 0) !== stats.total
            ? h('span', { className: 'rt-tag rt-tag-warn', title: '아직 분류되지 않은 항목: 에이전트가 되메울 때 redteam_poc_add 의 category 파라미터로 표시하세요' }, '미분류 ' + stats.uncategorized)
            : null,
          tpl.total ? h('span', { className: 'rt-tag rt-tag-passive' }, '로컬 템플릿 ' + tpl.total) : null,
          h('div', { className: 'rt-spacer' }),
          h('button', { className: 'rt-btn' + (grouped ? ' rt-btn-primary' : ''), title: '분류별 그룹 표시 / 평면 표시', onClick: () => setGrouped(!grouped) }, grouped ? '분류별 그룹' : '평면 표시'),
          h('button', { className: 'rt-btn', disabled: busy, onClick: () => query() }, busy ? '검색 중…' : '새로고침')),
        /* 분류 개요: 한 번 누르면 해당 분류로 필터되고, "어떤 무기를 얼마나 모았고 어떤 분류가 아직 비었나" 를 한눈에 본다 */
        h('div', { className: 'rt-kb-cats' },
          (stats.byCategory || []).filter((c) => catShown(c) > 0 || POC_CAT_ORDER.includes(c.code)).map((c) => h('span', {
            key: c.code,
            className: 'rt-concl-i' + (category === c.code ? ' on' : ''),
            title: (c.hint || POC_CAT_NAME[c.code] || c.code)
              + ' · 로컬 템플릿 ' + (tplByCat.get(c.code) || 0)
              + ' · 지식 베이스 ' + (c.n || 0)
              + (c.verified ? '(검증됨 ' + c.verified + ')' : ''),
            onClick: () => {
              const next = category === c.code ? '' : c.code
              setCategory(next)
              query({ category: next || undefined })
            },
          },
            h('b', null, String(catShown(c))),
            h('span', null, (POC_CAT_NAME[c.code] || c.code) + (c.verified ? '(검증됨 ' + c.verified + ')' : ''))))),
        h('div', { className: 'rt-kb-filter' },
          h('input', {
            className: 'rt-input', style: { flex: 1, minWidth: 140 }, placeholder: 'CVE / 컴포넌트 / 키워드 검색(본문도 검색)',
            value: q, onChange: (e) => setQ(e.target.value),
            onKeyDown: (e) => { if (e.key === 'Enter') query() },
          }),
          h('select', { className: 'rt-input', style: { maxWidth: 120 }, value: category, onChange: (e) => { setCategory(e.target.value); query({ category: e.target.value || undefined }) } },
            h('option', { value: '' }, '전체 분류'),
            POC_CAT_ORDER.map((k) => h('option', { key: k, value: k }, POC_CAT_NAME[k]))),
          h('select', { className: 'rt-input', style: { maxWidth: 120 }, value: engagement, onChange: (e) => { setEngagement(e.target.value); query({ engagement: e.target.value || undefined }) } },
            h('option', { value: '' }, '전체 출처 타깃'),
            (stats.byEngagement || []).map((e) => h('option', { key: e.engagement, value: e.engagement }, e.engagement + '(' + e.n + ')'))),
          h('input', {
            className: 'rt-input', style: { width: 120 }, placeholder: '발견 자산 필터',
            value: assetTarget, onChange: (e) => setAssetTarget(e.target.value),
            onKeyDown: (e) => { if (e.key === 'Enter') query() },
          }),
          h('select', { className: 'rt-input', style: { maxWidth: 110 }, value: kind, onChange: (e) => { setKind(e.target.value); query({ kind: e.target.value || undefined }) } },
            h('option', { value: '' }, '전체 유형'),
            Object.keys(POC_KIND_LABEL).map((k) => h('option', { key: k, value: k }, POC_KIND_LABEL[k]))),
          h('label', { className: 'rt-kb-check' },
            h('input', { type: 'checkbox', checked: verifiedOnly, onChange: (e) => { setVerifiedOnly(e.target.checked); query({ verified: e.target.checked || undefined }) } }),
            '검증된 것만 보기'),
          h('button', { className: 'rt-btn rt-btn-primary', onClick: () => query() }, '검색')),
        msg ? h('div', { className: msg.err ? 'rt-err' : 'rt-foot' }, msg.err || msg.ok) : null,
        err ? h('div', { className: 'rt-err' },
          /engagement required|unknown op/i.test(err)
            /* 구버전 host 에는 아직 지식 베이스 인터페이스가 없다: 복구 방법을 분명히 알려, "engagement required" 를 보고 헤매지 않게 한다 */
            ? '지식 베이스 인터페이스는 host 측이 제공합니다. 현재 호스트가 아직 구버전 프로세스입니다 —— 완전히 종료한 뒤 다시 실행하고(공식 exe / 커뮤니티판 / dsh web 중 아무거나), 페이지를 새로고침하세요.'
            : err) : null,
        !err && data && data.dbPath
          ? h('div', { className: 'rt-foot', style: { marginBottom: 6, fontSize: 11 } },
              '지식 베이스: ' + data.dbPath
              + (data.root ? '(루트 디렉터리 ' + data.root + ')' : ''))
          : null,
        h('div', { className: 'rt-table' },
          (() => {
            if (!grouped) return items.map(card)
            /* 그룹 렌더링: 내장 분류 순서를 따르고, 알 수 없는 분류는 끝의 "기타" 에 붙인다 */
            const buckets = new Map()
            for (const x of items) {
              const code = POC_CAT_NAME[x.category] ? x.category : 'other'
              if (!buckets.has(code)) buckets.set(code, [])
              buckets.get(code).push(x)
            }
            const order = POC_CAT_ORDER.filter((c) => buckets.has(c))
            for (const code of buckets.keys()) if (!order.includes(code)) order.push(code)
            const out = []
            for (const code of order) {
              const list = buckets.get(code)
              out.push(h('div', { key: 'g' + code, className: 'rt-kb-cat' },
                h('span', { className: 'rt-kb-cat-name' }, POC_CAT_NAME[code] || code),
                h('span', { className: 'rt-tag' }, list.length + ' 건'),
                h('span', { className: 'rt-tag rt-tag-live' }, '검증됨 ' + list.filter((x) => x.verified === 1).length),
                h('span', { className: 'rt-spacer' }),
                h('span', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)' } },
                  '최근 생성 ' + fmt(list.map((x) => x.created_at).filter(Boolean).sort().pop()))))
              for (const x of list) out.push(card(x))
            }
            return out
          })(),
          tplItems.length
            ? h('div', { className: 'rt-kb-tpl' },
                h('div', { className: 'rt-ap-sub' },
                  '로컬 nuclei 템플릿 · ' + (tplStart + 1) + '–' + (tplStart + tplItems.length) + ' / ' + tplMatched
                  + '(바로 `nuclei -t <템플릿 경로>`)'),
                tplItems.map((t, i) => h('div', { key: 't' + tplStart + '-' + i, className: 'rt-kb-tpl-row' },
                  h('span', { className: 'rt-tag' }, t.severity || '—'),
                  t.category ? h('span', { className: 'rt-tag' }, POC_CAT_NAME[t.category] || t.category) : null,
                  h('span', { className: 'rt-mono rt-kb-tpl-path', title: t.path }, t.path),
                  h('span', { className: 'rt-kb-tpl-name', title: t.name }, t.name || ''),
                  h('button', {
                    className: 'rt-btn', style: { padding: '0 6px', fontSize: 10.5 },
                    onClick: () => copy('nuclei -t ' + t.path + ' -u <대상>', '템플릿 명령'),
                  }, '명령 복사'))),
                h('div', { className: 'rt-kb-actions' },
                  h('button', {
                    className: 'rt-btn', disabled: busy || tplStart <= 0,
                    onClick: () => turnTpl(tplStart - tplPageSize),
                  }, '이전 페이지'),
                  h('button', {
                    className: 'rt-btn', disabled: busy || tplStart + tplItems.length >= tplMatched,
                    onClick: () => turnTpl(tplStart + tplPageSize),
                  }, '다음 페이지')),
                tpl.dir ? h('div', { className: 'rt-foot' }, h('span', null, '템플릿 디렉터리: ' + tpl.dir)) : null)
            : null,
          data === null ? h('div', { className: 'rt-empty' }, '불러오는 중…') : null,
          data !== null && !items.length && !tplItems.length
            ? h('div', { className: 'rt-empty' },
                h('div', null,
                  q || kind || verifiedOnly
                    ? '적중 없음: 다른 키워드로 다시 시도하거나, 인터넷에서 찾거나 직접 만들어 되메우세요.'
                    : (tpl.total
                      ? ('POC/EXP 라이브러리가 아직 비었습니다; 로컬에는 이미 ' + tpl.total + ' 개 nuclei 템플릿이 있지만 이 페이지에는 표시되지 않았습니다. 클라이언트를 완전히 종료한 뒤 다시 실행하세요.')
                      : (tpl.dir
                        ? '지식 베이스가 아직 비어 있습니다(로컬 템플릿 디렉터리는 있지만 yaml이 없습니다. nuclei -update-templates를 실행하세요).'
                        : '지식 베이스가 아직 비어 있습니다. 로컬에도 nuclei 템플릿 라이브러리가 없습니다 —— 드릴 머신에서 setup.sh를 실행하거나 `nuclei -update-templates`를 실행하세요. 설치가 끝나면 여기에 "로컬 템플릿 N"이 표시됩니다.'))),
                h('div', { style: { marginTop: 6, fontSize: 12 } },
                  'Nday/1day 공략의 표준 순서: ① redteam_poc_search로 먼저 여기를 조회(로컬 nuclei 템플릿 라이브러리도 함께 검색) → ② 없으면 인터넷 검색(web_search / GitHub / ExploitDB / 벤더 공지) 또는 직접 작성 → ③ 실제 대상에서 유효성을 검증한 뒤 redteam_poc_add로 환류하면 이후 타깃에서 바로 사용할 수 있습니다.'),
                data.dbPath ? h('div', { style: { marginTop: 6, fontSize: 11 }, className: 'rt-mono' }, '지식 베이스 파일: ' + data.dbPath) : null,
                tpl.dir ? h('div', { style: { marginTop: 6, fontSize: 11 }, className: 'rt-mono' }, '템플릿 디렉터리: ' + tpl.dir) : null)
            : null),
        h('div', { className: 'rt-foot' },
          h('span', null, '전역 공유(타깃 교차) | 저장 위치: pocs/<code>/ | 범용 재사용 가능한 POC/EXP만 수록, 타깃 전용 스크립트는 "공격 파일"로')))
    }

    /* ---------------------------------------------------------- 환경 적응(Windows / 비 Kali) */
    /**
     * Z3r0의 "시스템 설정" 발상을 참고: 경로와 키를 중앙 설정으로 모으고 bash/ps1에 의존하지 않는다.
     * 저장 위치 $DSH_HOME/redteam/config.json —— 사용자가 도구 절대 경로 또는 툴킷 검색 디렉터리를 입력한다.
     */
    function EnvTab(props) {
      const refreshKey = props.refreshKey || 0
      const [data, setData] = React.useState(null)
      const [draft, setDraft] = React.useState(null)
      const [err, setErr] = React.useState(null)
      const [msg, setMsg] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [folderPath, setFolderPath] = React.useState('')

      const applyDraftFrom = (r) => {
        const c = (r && r.config) || {}
        setDraft({
          platform: c.platform || 'auto',
          toolkitDir: c.toolkitDir || '',
          nucleiTemplatesDir: c.nucleiTemplatesDir || '',
          binDirsText: (c.binDirs || []).join('\n'),
          tools: Object.assign({}, c.tools || {}),
          env: Object.assign({ FOFA_KEY: '', REDTEAM_VPS_HOST: '', REDTEAM_VPS_KEY: '' }, c.env || {}),
          notes: c.notes || '',
        })
        if (c.toolkitDir) setFolderPath(c.toolkitDir)
      }

      const load = () => {
        setBusy(true); setMsg(null)
        api({ op: 'platformConfigGet' }).then((r) => {
          setBusy(false)
          if (!r || r.ok === false) { setErr((r && r.error) || '읽기 실패'); return }
          setErr(null); setData(r)
          applyDraftFrom(r)
        }, (e) => { setBusy(false); setErr(String((e && e.message) || e)) })
      }
      React.useEffect(load, [refreshKey])

      const save = () => {
        if (!draft) return
        setBusy(true); setMsg(null)
        const config = {
          platform: draft.platform,
          toolkitDir: draft.toolkitDir,
          nucleiTemplatesDir: draft.nucleiTemplatesDir,
          binDirs: String(draft.binDirsText || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean),
          tools: draft.tools,
          env: draft.env,
          notes: draft.notes,
          envAdaptConfigured: true,
          envAdaptSkip: false,
        }
        api({ op: 'platformConfigSave', config }).then((r) => {
          setBusy(false)
          if (!r || r.ok === false) { setMsg({ err: (r && r.error) || '저장 실패' }); return }
          setData(r)
          setMsg({ ok: '저장했습니다: ' + ((r.config && r.config.path) || '$DSH_HOME/redteam/config.json') })
          applyDraftFrom(r)
        }, (e) => { setBusy(false); setMsg({ err: String((e && e.message) || e) }) })
      }

      const assignFolder = () => {
        const dir = String(folderPath || (draft && draft.toolkitDir) || '').trim()
        if (!dir) { setMsg({ err: '먼저 도구가 있는 폴더 경로를 입력하세요' }); return }
        setBusy(true); setMsg(null)
        api({ op: 'platformAssignToolkit', dir }).then((r) => {
          setBusy(false)
          if (!r || r.ok === false) { setMsg({ err: (r && r.error) || '자동 할당 실패' }); return }
          setData(r)
          applyDraftFrom(r)
          setMsg({
            ok: '폴더에서 도구 ' + (r.assignedCount || 0) + '개를 할당했습니다'
              + (r.nucleiTemplatesDir ? ', nuclei-templates도 인식했습니다' : ''),
          })
        }, (e) => { setBusy(false); setMsg({ err: String((e && e.message) || e) }) })
      }

      const setTool = (id, value) => setDraft((d) => d ? Object.assign({}, d, { tools: Object.assign({}, d.tools, { [id]: value }) }) : d)
      const setEnv = (key, value) => setDraft((d) => d ? Object.assign({}, d, { env: Object.assign({}, d.env, { [key]: value }) }) : d)

      const runtime = (data && data.runtime) || {}
      const adapt = (data && data.adapt) || {}
      const tools = (data && data.tools && data.tools.items) || []
      const found = tools.filter((t) => t.path).length
      const defaultToolkit = (data && data.toolkitDir) || '$DSH_HOME/redteam/toolkit'
      const defaultNuclei = (data && data.nucleiTemplatesDir) || (defaultToolkit + '/nuclei-templates')

      return h('div', { className: 'rt-main' },
        h('div', { className: 'rt-toolbar' },
          h('span', { style: { fontWeight: 600 } }, '환경 적응'),
          h('span', { className: 'rt-tag' }, runtime.effective === 'windows' ? 'Windows' : 'Linux/Kali'),
          adapt.kali ? h('span', { className: 'rt-tag rt-tag-live' }, 'Kali') : null,
          h('span', { className: 'rt-tag' + (adapt.ready ? ' rt-tag-live' : ' rt-tag-warn') },
            adapt.ready ? ('준비됨 · ' + (adapt.reason || '')) : '설정 필요'),
          h('span', { className: 'rt-tag' + (found ? ' rt-tag-live' : ' rt-tag-warn') }, '도구 ' + found + '/' + tools.length),
          h('div', { className: 'rt-spacer' }),
          h('button', { className: 'rt-btn', disabled: busy, onClick: load }, busy ? '읽는 중…' : '새로고침'),
          h('button', { className: 'rt-btn rt-btn-primary', disabled: busy || !draft, onClick: save }, '저장')),
        h('div', { className: 'rt-pane', style: { minHeight: 0 } },
        err ? h('div', { className: 'rt-err' }, err) : null,
        msg ? h('div', { className: msg.err ? 'rt-err' : 'rt-foot' }, msg.err || msg.ok) : null,
        h('div', { className: 'rt-card', style: { margin: '0 0 8px', fontSize: 12, lineHeight: 1.6 } },
          adapt.message
            || '모두 선택 사항입니다: 비워 두면 기본 경로/자동 검색을 사용합니다. 입력한 값은 기본값을 덮어씁니다. 키류는 측정/리버스 연결이 필요할 때만 입력하세요.'),
        h('div', { className: 'rt-card', style: { margin: '0 0 8px', fontSize: 12, lineHeight: 1.6 } },
          h('div', { style: { fontWeight: 600, marginBottom: 6 } }, '툴킷 폴더 → 도구 자동 할당'),
          h('div', { style: { marginBottom: 8, opacity: 0.9 } },
            '도구가 모두 같은 폴더(하위 디렉터리 포함)에 있으면 경로를 입력하고 "자동 할당"을 클릭하세요: toolkitDir에 기록되고 파일 이름으로 nmap / nuclei / fscan 등을 매칭해 아래에 채웁니다.'),
          h('div', { style: { display: 'flex', gap: 8, alignItems: 'center' } },
            h('input', {
              className: 'rt-input', style: { flex: 1 },
              placeholder: '예: D:\\pentest-tools 또는 /opt/toolkit',
              value: folderPath,
              onChange: (e) => setFolderPath(e.target.value),
              onKeyDown: (e) => { if (e.key === 'Enter') assignFolder() },
            }),
            h('button', {
              className: 'rt-btn rt-btn-primary', disabled: busy,
              onClick: assignFolder,
            }, busy ? '스캔 중…' : '자동 할당'))),
        data && data.hint ? h('div', { className: 'rt-card', style: { margin: '0 0 8px', fontSize: 12, lineHeight: 1.6 } }, data.hint) : null,
        data && data.egress ? h('div', { className: 'rt-card', style: { margin: '0 0 8px', fontSize: 12, lineHeight: 1.55 } },
          h('div', { style: { fontWeight: 600, marginBottom: 6 } }, '외부 통신 상태(Z3r0 egress 참고, 읽기 전용)'),
          h('div', { className: 'rt-mono', style: { fontSize: 11 } }, 'HTTP_PROXY=' + (data.egress.http_proxy || '(비어 있음)')),
          h('div', { className: 'rt-mono', style: { fontSize: 11 } }, 'HTTPS_PROXY=' + (data.egress.https_proxy || '(비어 있음)')),
          h('div', { className: 'rt-mono', style: { fontSize: 11 } }, 'ALL_PROXY=' + (data.egress.all_proxy || '(비어 있음)')),
          h('div', { className: 'rt-mono', style: { fontSize: 11 } }, 'NO_PROXY=' + (data.egress.no_proxy || '(비어 있음)')),
          h('div', { style: { marginTop: 6, opacity: 0.85 } }, data.egress.note || '')) : null,
        !draft ? h('div', { className: 'rt-empty' }, '불러오는 중…') : h('div', null,
          h('div', { className: 'rt-card' },
            h('h4', null, '플랫폼과 디렉터리'),
            h('div', { style: { display: 'grid', gap: 8 } },
              h('label', { style: { fontSize: 12 } }, '플랫폼 모드',
                h('select', {
                  className: 'rt-input', style: { display: 'block', width: '100%', marginTop: 4 },
                  value: draft.platform,
                  onChange: (e) => setDraft(Object.assign({}, draft, { platform: e.target.value })),
                },
                  h('option', { value: 'auto' }, 'auto(로컬 환경 따름, 기본)'),
                  h('option', { value: 'windows' }, 'windows'),
                  h('option', { value: 'linux' }, 'linux'))),
              h('label', { style: { fontSize: 12 } }, '툴킷 디렉터리 toolkitDir(비워 두면 기본)',
                h('input', {
                  className: 'rt-input', style: { display: 'block', width: '100%', marginTop: 4 },
                  placeholder: '기본: ' + defaultToolkit,
                  value: draft.toolkitDir,
                  onChange: (e) => setDraft(Object.assign({}, draft, { toolkitDir: e.target.value })),
                })),
              h('label', { style: { fontSize: 12 } }, 'nuclei 템플릿 디렉터리(비워 두면 자동: toolkit/nuclei-templates)',
                h('input', {
                  className: 'rt-input', style: { display: 'block', width: '100%', marginTop: 4 },
                  placeholder: '기본: ' + defaultNuclei,
                  value: draft.nucleiTemplatesDir,
                  onChange: (e) => setDraft(Object.assign({}, draft, { nucleiTemplatesDir: e.target.value })),
                })),
              h('label', { style: { fontSize: 12 } }, '도구 검색 디렉터리 binDirs(비워 두면 toolkit + PATH만 검색, 한 줄에 하나)',
                h('textarea', {
                  className: 'rt-input', rows: 4, style: { display: 'block', width: '100%', marginTop: 4, fontFamily: 'var(--dsw-font-mono, monospace)' },
                  placeholder: '선택 사항. 예: ' + String.fromCharCode(10) + 'D:\\tools' + String.fromCharCode(10) + 'D:\\pentest-bin',
                  value: draft.binDirsText,
                  onChange: (e) => setDraft(Object.assign({}, draft, { binDirsText: e.target.value })),
                })))),
          h('div', { className: 'rt-card' },
            h('h4', null, '키와 VPS(비워 두면 덮어쓰지 않음, 프로세스 환경 변수 우선)'),
            h('div', { style: { display: 'grid', gap: 8 } },
              ['FOFA_KEY', 'REDTEAM_VPS_HOST', 'REDTEAM_VPS_KEY'].map((k) => h('label', { key: k, style: { fontSize: 12 } }, k + '(선택)',
                h('input', {
                  className: 'rt-input', style: { display: 'block', width: '100%', marginTop: 4 },
                  type: k === 'FOFA_KEY' ? 'password' : 'text',
                  placeholder: k === 'REDTEAM_VPS_KEY' ? '비워 두세요. 필요할 때 개인 키 절대 경로 입력' : (k === 'REDTEAM_VPS_HOST' ? '비워 두세요. 필요할 때 user@host 입력' : '비워 두세요. 측정 시 입력'),
                  value: (draft.env && draft.env[k]) || '',
                  onChange: (e) => setEnv(k, e.target.value),
                }))))),
          h('div', { className: 'rt-card' },
            h('h4', null, '도구 실행 파일(비워 두면 자동 검색)'),
            h('div', { style: { fontSize: 11.5, color: 'var(--dsw-alias-label-secondary)', marginBottom: 8 } },
              '해석 순서: 이 표의 절대 경로 → toolkitDir → binDirs → PATH, 비워 두면 기본 검색을 사용합니다.'),
            tools.map((t) => h('div', { key: t.id, style: { marginBottom: 8 } },
              h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', marginBottom: 4 } },
                h('span', { style: { fontWeight: 600, minWidth: 88 } }, t.label || t.id),
                t.path
                  ? h('span', { className: 'rt-tag rt-tag-live', title: t.path }, t.source + ' · 찾음')
                  : h('span', { className: 'rt-tag rt-tag-warn' }, '찾지 못함(설치 후 비워 두어도 됨)')),
              h('input', {
                className: 'rt-input', style: { width: '100%' },
                placeholder: '비워 두면 자동 검색: ' + (t.names || []).slice(0, 3).join(' / '),
                value: (draft.tools && draft.tools[t.id]) || '',
                onChange: (e) => setTool(t.id, e.target.value),
              }),
              t.path ? h('div', { className: 'rt-mono', style: { fontSize: 10.5, marginTop: 2, opacity: 0.8 } }, t.path) : null))),
          h('div', { className: 'rt-card' },
            h('h4', null, '비고'),
            h('textarea', {
              className: 'rt-input', rows: 3, style: { width: '100%' },
              placeholder: '선택 사항. 예: 도구는 모 포터블 패키지에서 가져옴',
              value: draft.notes,
              onChange: (e) => setDraft(Object.assign({}, draft, { notes: e.target.value })),
            })),
          h('div', { className: 'rt-foot' },
            h('span', null,
              '설정 파일: ' + ((data && data.config && data.config.path) || '$DSH_HOME/redteam/config.json')
              + ' | 비어 있는 필드는 모두 기본값 사용')))))
    }

    /* ---------------------------------------------------------- 점수 목표 */
    function ScoreTab(props) {
      const eng = props.engagement
      const refreshKey = props.refreshKey || 0
      const [data, setData] = React.useState(null)
      const [err, setErr] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [openId, setOpenId] = React.useState(null)
      const [form, setForm] = React.useState(null)
      const [msg, setMsg] = React.useState(null)

      const load = () => {
        if (!eng) return
        setBusy(true)
        api({ op: 'scores', engagement: eng }).then((r) => {
          setBusy(false)
          if (!r || r.ok === false) { setErr((r && r.error) || '읽기 실패'); return }
          setErr(null)
          setData(r)
        }, (e) => { setBusy(false); setErr(String((e && e.message) || e)) })
      }
      React.useEffect(load, [eng, refreshKey])

      /* builtin은 폼까지 그대로 전달해야 한다: 내장 점수 항목의 점수/이름/산정 기준은 "점수 규칙"이 고정하며,
         화면은 입력란을 회색으로 막고 이유를 설명해야 한다 —— 예전에는 "수정 가능, 저장됨 안내, 새로고침하면 되돌아감"이었고,
         사용자는 bug라고 여겼다. */
      const startEdit = (p) => setForm({
        id: p.id, name: p.name, category: p.category || '', points: p.points,
        description: p.description || '', enabled: p.enabled, builtin: p.builtin === true,
        src: p.src, cap: p.cap, rule: p.rule,
      })
      const startNew = () => { setForm({ name: '', category: '', points: 10, description: '', enabled: true, builtin: false }); setMsg(null) }
      const setField = (k, v) => setForm((f) => Object.assign({}, f, { [k]: v }))

      const save = () => {
        if (!form || !form.name) { setMsg({ err: '이름은 비울 수 없습니다' }); return }
        setBusy(true)
        setMsg(null)
        api({ op: 'saveScorePoint', engagement: eng, point: form }).then((r) => {
          setBusy(false)
          if (!r || r.ok === false) { setMsg({ err: (r && r.error) || '저장 실패' }); return }
          /* overridden === false 는 백엔드가 제출한 점수를 **채택하지 않았다**는 뜻이다(내장 항목은 규칙이 고정).
             이때 "저장됨"이라고 두루뭉술하게 말할 수 없다 —— 그 말은 사용자에게 점수가 바뀌었다고 오해를 준다. */
          if (r.overridden === false) {
            setMsg({ err: '"활성화/비활성화"만 저장했습니다. 점수는 변경되지 않았습니다: 이것은 "점수 규칙"과 함께 배포되는 내장 점수 항목이며,'
              + '점수 / 상한 / 산정 기준은 규칙이 고정합니다(같은 규칙의 상한은 그룹 내 모든 점수 항목에 누적되므로,'
              + '개별 점수를 바꾸면 한 번의 적중이 그룹 전체 상한을 소진합니다). 점수를 직접 정하려면 "+ 점수 항목 추가"를 사용하세요.' })
          } else {
            setMsg({ ok: r.note || '저장했습니다' })
          }
          setForm(null)
          load()
        }, (e) => { setBusy(false); setMsg({ err: String((e && e.message) || e) }) })
      }
      const remove = () => {
        if (!form || !form.id) { setForm(null); return }
        setBusy(true)
        setMsg(null)
        api({ op: 'deleteScorePoint', engagement: eng, id: form.id }).then((r) => {
          setBusy(false)
          if (!r || r.ok === false) { setMsg({ err: (r && r.error) || '삭제 실패' }); return }
          setMsg({ ok: '삭제했습니다' })
          setForm(null)
          setOpenId(null)
          load()
        }, (e) => { setBusy(false); setMsg({ err: String((e && e.message) || e) }) })
      }

      const summary = (data && data.summary) || { achievedPoints: 0, pointCount: 0, hitPointCount: 0, hitCount: 0, selfCreatedHits: 0, serviceCappedHits: 0 }
      const items = (data && data.items) || []

      /* 병합판의 8개 범주로 그룹화해 렌더링한다(백엔드 ruleGroups는 이미 정렬되어 있고, 그룹 내에서는 점수 오름차순).
         호환: 백엔드가 ruleGroups를 주지 않으면(구버전 host) 평면 목록으로 되돌린다. */
      const groups = (data && data.ruleGroups && data.ruleGroups.length)
        ? data.ruleGroups
        : [{ key: 'all', name: '', capSum: 0, points: 0, counted: 0, tiers: items }]
      const rows = []
      for (const g of groups) {
        if (g.name) {
          rows.push(h('div', { key: 'g-' + g.key, className: 'rt-score-group' },
            h('span', null, g.name),
            h('span', { className: 'rt-sg-sub' },
              g.tiers.length + ' 개'
              + (g.capSum > 0 ? ' · 각 항목 상한 합계 ' + g.capSum + ' 점(항목별 독립, 항목 간 누적 없음)' : '')),
            h('div', { className: 'rt-spacer' }),
            g.points > 0
              ? h('span', { className: 'rt-tag rt-tag-active' }, '+' + g.points + ' 점')
              : null))
        }
        for (const p of g.tiers) {
        const achieved = p.hits.length > 0
        const open = openId === p.id
        rows.push(h('div', {
          key: 'sp' + p.id, className: 'rt-score-row', role: 'button', tabIndex: 0,
          onClick: () => setOpenId(open ? null : p.id),
          onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpenId(open ? null : p.id) } },
        },
          h('span', { className: 'rt-sec-caret' }, open ? '▾' : '▸'),
          h('span', null, h('span', {
            className: achieved ? 'rt-pri rt-pri-high' : 'rt-pri rt-pri-low',
            style: achieved ? {} : { background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-secondary)' },
          }, p.points + '점')),
          h('span', { title: p.description || '' },
            p.name,
            p.tier ? h('span', { className: 'rt-scope' }, ' ' + p.tier) : null),
          /* 적중과 상한: 이 항목이 몇 번 반영되었고 상한을 얼마나 썼는지(G3 각 항목 상한은 독립이라 상한에 닿으면 더 누적하지 않는다) */
          h('span', { title: p.capped > 0
            ? '이미 ' + p.counted + ' 회 반영, 그 밖에 ' + p.capped + ' 건은 "' + (p.scope_label || '산정 기준') + '" 또는 상한 도달로 미채점'
            : (p.scope_label || '') },
            h('span', { className: 'rt-sec-count' }, p.hits.length > 0 ? p.counted + ' 회 적중' : '미적중'),
            p.cap > 0
              ? h('span', { className: 'rt-scope' }, ' 상한 ' + (p.cap_used === null ? 0 : p.cap_used) + '/' + p.cap)
              : null),
          h('span', { style: { textAlign: 'right' } }, p.earned > 0
            ? h('span', { className: 'rt-tag rt-tag-active' }, '+' + p.earned + ' 점')
            : h('span', { style: { color: 'var(--dsw-alias-label-secondary)' } }, '—'))))
        if (!open) continue
        /* 적중 기록: 한 줄에 한 건 —— 첫 줄은 "번호 + 자산 + 시간 + 복사", 내용은 다음 줄에서 자동 줄바꿈 */
        const hitNodes = p.hits.map((hh, hi) => h('div', {
          key: 'h' + hh.id,
          className: 'rt-hit-row' + (hh.self_created ? ' self-created' : '') + (hh.capped ? ' service-capped' : ''),
        },
          h('span', { className: 'rt-hit-idx' }, String(hi + 1)),
          h('span', { className: 'rt-hit-asset', title: hh.target || hh.asset_ip || '' },
            hh.asset_ip || hh.target || '자산 미지정'),
          hh.self_created ? h('span', { className: 'rt-tag rt-tag-warn', title: '직접 등록/자체 생성한 계정은 점수 권한으로 인정되지 않고 과정 기록으로만 남습니다' }, '자체 생성 · 미채점') : null,
          hh.capped ? h('span', {
            className: 'rt-tag rt-tag-warn',
            title: hh.capped_reason || '같은 자산 같은 포트에서는 점수가 가장 높은 한 건만 인정되며, 이 건은 미채점입니다',
          }, '서비스 상한 도달 · 미채점' + (hh.service ? '(' + hh.service + ')' : '')) : null,
          hh.shot_count ? h('span', { className: 'rt-tag', title: '이 적중에는 증거 스크린샷이 있습니다(점수 항목을 펼치면 대표 이미지를 볼 수 있습니다)' },
            '이미지 ' + hh.shot_count) : null,
          h('span', { className: 'rt-hit-time' }, fmt(hh.recorded_at)),
          h('button', {
            className: 'rt-btn', style: { padding: '0 5px', fontSize: 10.5 },
            title: '이 항목 복사',
            onClick: (e) => {
              e.stopPropagation()
              copyText((hh.asset_ip || hh.target || '') + '  ' + (hh.evidence || ''))
            },
          }, '복사'),
          hh.evidence
            ? h('span', { className: 'rt-hit-txt', title: hh.evidence }, String(hh.evidence).replace(/\n+/g, ' '))
            : h('span', { className: 'rt-hit-txt none' }, '계정 비밀번호/결과 미입력')))
        rows.push(h('div', {
          key: 'spd' + p.id, className: 'rt-score-row',
          style: { cursor: 'default', gridTemplateColumns: '1fr' },
        }, h('div', { className: 'rt-score-detail' },
          p.description ? h('div', { className: 'rt-kv' }, h('b', null, '점수 조건'), h('span', null, p.description)) : null,
          h('div', { className: 'rt-kv' }, h('b', null, '상태'),
            h('span', null, (p.enabled ? '활성화' : '비활성화') + ' · ' + p.points + ' 점/회 · 적중 ' + p.hits.length +
              ' 회 = ' + p.earned + ' 점' + (p.self_created ? '(그 밖에 자체 생성 ' + p.self_created + ' 회는 미채점)' : '') +
              (p.capped ? '(그 밖에 같은 서비스 중복 적중 ' + p.capped + ' 회는 미채점)' : ''))),
          p.capped
            ? h('div', { className: 'rt-kv' }, h('b', null, '서비스 상한'),
                h('span', null, p.service_summary + '; 계정 권한과 데이터베이스 권한은 "같은 자산 같은 포트" 기준으로 한 번만 인정되며, 최고 권한 계정을 확보하면 해당 서비스는 상한 도달입니다'))
            : null,
          p.hits.length
            ? h('div', null,
                h(ShotStrip, { eng: eng, shots: p.shots, total: p.shot_total,
                  title: '증거 스크린샷 · ' + (p.shot_total || (p.shots || []).length) + ' 장' }),
                h('div', { className: 'rt-section', style: { padding: '6px 0 0' } },
                  '적중 기록 · ' + p.hits.length + '(자산과 계정 비밀번호만 기록, 상세 재현은 보고서 참조)'),
                h('div', { className: 'rt-hits' }, hitNodes))
            : h('div', { className: 'rt-kv' }, h('b', null, '적중 기록'),
                h('span', { style: { color: 'var(--dsw-alias-label-secondary)' } },
                  '아직 없습니다 —— 성과를 확보한 뒤 redteam_score_hit으로 기록하세요: 대상 자산 + 확보한 계정 비밀번호/권한을 명시합니다')),
          h('div', { className: 'rt-actions' },
            h('button', { className: 'rt-btn', onClick: (e) => { e.stopPropagation(); startEdit(p) } }, '편집')))))
        }
      }

      return h('div', { className: 'rt-main' },
        h('div', { className: 'rt-toolbar' },
          h('span', { style: { fontWeight: 600 } }, '점수 목표'),
          /* 확보한 총점만 표시하고, 목표 점수와 진행 표시줄은 표시하지 않는다 */
          h('span', { style: { fontSize: 13, color: 'var(--dsw-alias-label-secondary)', marginLeft: 4 } }, '총점'),
          h('span', { className: 'rt-total' }, String(summary.achievedPoints)),
          h('span', { style: { fontSize: 13, color: 'var(--dsw-alias-label-secondary)' } }, '점'),
          h('span', { className: 'rt-tag' }, summary.pointCount + ' 개 점수 항목'),
          h('span', { className: 'rt-tag' }, '적중 ' + summary.countedHits + ' 회'),
          summary.selfCreatedHits
            ? h('span', {
                className: 'rt-tag rt-tag-warn',
                title: '직접 등록/직접 생성한 계정은 점수 권한으로 인정되지 않고 과정 기록으로만 남습니다(미채점, 상한 미차감, 보고서 미포함)',
              }, '자체 생성 미채점 ' + summary.selfCreatedHits)
            : null,
          summary.serviceCappedHits
            ? h('span', {
                className: 'rt-tag rt-tag-warn',
                title: '계정 권한과 데이터베이스 권한은 "같은 자산 같은 포트" 기준으로 한 번만 인정됩니다: 해당 서비스는 상한 도달이며 이 중복 적중은 미채점입니다(흔적만 기록)',
              }, '서비스 상한 도달 미채점 ' + summary.serviceCappedHits)
            : null,
          h('div', { className: 'rt-spacer' }),
          h('button', { className: 'rt-btn', onClick: startNew }, '+ 점수 항목 추가'),
          h('button', { className: 'rt-btn', disabled: busy, onClick: load }, busy ? '새로고침 중…' : '새로고침')),
        msg ? h('div', { className: msg.err ? 'rt-err' : 'rt-foot' }, msg.err || msg.ok) : null,
        err ? h('div', { className: 'rt-err' }, err) : null,
        form ? h('div', { className: 'rt-pane', style: { flex: 'none', borderBottom: '1px solid var(--dsw-alias-border-l1)' } },
          /* 내장 점수 항목(builtin): 점수 / 이름 / 분류는 "점수 규칙"이 고정하므로 입력란이 회색 처리된다.
             바꿀 수 있는 것은 "활성화 / 비활성화"뿐이다. 그래야 화면에서 "수정 후 저장됨 안내, 새로고침하면 되돌아감" 혼란이 다시 생기지 않는다. */
          form.builtin
            ? h('div', { className: 'rt-hint', style: { marginBottom: 8 } },
                h('b', null, '내장 점수 항목("돌파 침투류 점수 규칙(병합판)"에서 옴)'),
                h('div', { style: { marginTop: 3 } },
                  '점수, 상한, 산정 기준, 이름은 규칙이 고정합니다 —— 같은 규칙의 상한은 그룹 내 모든 점수 항목에 누적되므로,'
                  + '개별 점수를 바꾸면 한 번의 적중이 그룹 전체 상한을 소진합니다. 여기서는 "활성화 / 비활성화"를 바꿀 수 있고,'
                  + '점수를 직접 정하려면 이전 화면으로 돌아가 "+ 점수 항목 추가"를 클릭하세요.'),
                form.src !== null && form.src !== undefined
                  ? h('div', { style: { marginTop: 3, color: 'var(--dsw-alias-label-secondary)' } },
                      '규칙 원문 번호 ' + form.src + (form.rule ? ' · 상한 그룹 rule=' + form.rule : '')
                      + (form.cap > 0 ? ' · 상한 ' + form.cap + ' 점' : ' · 상한 없음'))
                  : null)
            : null,
          h('div', { className: 'rt-score-form' },
            h('input', {
              className: 'rt-input', placeholder: '이름(필수)', value: form.name,
              readOnly: form.builtin === true,
              title: form.builtin ? '내장 점수 항목의 이름은 규칙이 고정합니다' : '',
              onChange: (e) => setField('name', e.target.value),
            }),
            h('input', {
              className: 'rt-input', placeholder: '분류, 예: 계정 권한', value: form.category,
              readOnly: form.builtin === true,
              title: form.builtin ? '내장 점수 항목의 분류는 규칙이 고정합니다(패널에서 어느 그룹에 속할지 결정)' : '',
              onChange: (e) => setField('category', e.target.value),
            }),
            h('input', {
              className: 'rt-input', type: 'number', placeholder: '1회 점수',
              readOnly: form.builtin === true,
              title: form.builtin
                ? '내장 점수 항목의 점수는 "점수 규칙"이 고정하므로 여기서 바꿀 수 없습니다'
                : '이 분류의 1회 점수입니다. 적중할 때마다 이 점수가 누적됩니다(해당 규칙 상한의 제약을 받습니다)',
              value: form.points, onChange: (e) => setField('points', Number(e.target.value)),
            }),
            h('select', { className: 'rt-input', value: form.enabled ? '1' : '0', onChange: (e) => setField('enabled', e.target.value === '1') },
              h('option', { value: '1' }, '활성화'),
              h('option', { value: '0' }, '비활성화'))),
          h('input', {
            className: 'rt-input', style: { width: '100%', marginBottom: 6, boxSizing: 'border-box' },
            placeholder: '점수 조건 설명', value: form.description,
            readOnly: form.builtin === true,
            title: form.builtin ? '내장 점수 항목의 조항 본문은 규칙이 고정합니다' : '',
            onChange: (e) => setField('description', e.target.value),
          }),
          h('div', { className: 'rt-actions' },
            h('button', { className: 'rt-btn rt-btn-primary', disabled: busy, onClick: save }, '저장'),
          form.id
            ? (form.builtin
                ? h('button', {
                    className: 'rt-btn', disabled: true,
                    title: '내장 점수 항목은 삭제할 수 없습니다: 삭제하면 패널에 규칙 하나가 빠지고 보고서에 성과 한 분류가 줄어듭니다(다음 시작 시 자동으로 복구됩니다). 채점에 참여시키지 않으려면 "비활성화"를 사용하세요.',
                  }, '삭제(내장 항목은 삭제 불가)')
                : h('button', { className: 'rt-btn', disabled: busy, onClick: remove }, '삭제'))
            : null,
            h('button', { className: 'rt-btn', onClick: () => setForm(null) }, '취소'))) : null,
        h('div', { className: 'rt-table' },
          h('div', { className: 'rt-score-row head' },
            h('span', null, ''), h('span', null, '점수'), h('span', null, '점수 항목(점수 낮은 순)'),
            h('span', null, '적중 / 상한'), h('span', { style: { textAlign: 'right' } }, '획득 점수')),
          rows,
          !items.length ? h('div', { className: 'rt-empty' }, '점수 항목이 없습니다. 오른쪽 위 "점수 항목 추가"를 클릭하세요') : null))
    }

    /* ---------------------------------------------------------- 접기 기반 */
    /**
     * 접기 상태를 "탭 + 타깃" 단위로 localStorage에 영속화하므로 탭 전환/새로고침 후에도 유지된다.
     * 사용자가 직접 누른 키만 기록하고, 누른 적 없는 키는 호출자가 준 기본값을 쓴다.
     */
    const COLLAPSE_KEY = 'rt-collapse:'
    const collapseLoad = (prefix) => {
      try {
        const raw = window.localStorage.getItem(COLLAPSE_KEY + prefix)
        const parsed = raw ? JSON.parse(raw) : null
        return parsed && typeof parsed === 'object' ? parsed : {}
      } catch (e) { return {} }
    }
    const collapseSave = (prefix, value) => {
      try { window.localStorage.setItem(COLLAPSE_KEY + prefix, JSON.stringify(value)) } catch (e) { /* 프라이빗 모드 등 */ }
    }

    /** 탭마다 hook 하나 —— isOpen(key, defaultOpen) / toggle(key, defaultOpen) / setAll(keys, open) */
    function useCollapse(prefix) {
      const [state, setState] = React.useState(() => collapseLoad(prefix))
      React.useEffect(() => { setState(collapseLoad(prefix)) }, [prefix])
      const write = (next) => { collapseSave(prefix, next); setState(next) }
      const isOpen = (key, defaultOpen) => {
        const v = state[key]
        return v === undefined ? defaultOpen !== false : v === true
      }
      const toggle = (key, defaultOpen) => (e) => {
        if (e && e.stopPropagation) e.stopPropagation()
        write(Object.assign({}, state, { [key]: !isOpen(key, defaultOpen) }))
      }
      const setAll = (keys, open) => {
        const next = Object.assign({}, state)
        for (const k of keys) next[k] = open
        write(next)
      }
      return { isOpen: isOpen, toggle: toggle, setAll: setAll }
    }

    /**
     * 통합 접기 헤더(L1): ▾ 는 맨 왼쪽에 고정, 제목은 굵게, 개수는 바로 뒤에, 오른쪽에는 시간이나 조작을 둔다,
     * 내용은 12px 들여쓰기하고 세로 안내선을 하나 긋는다. always=true 는 "항상 표시"(접기 불가)를 뜻한다.
     */
    function Section(props) {
      const always = props.always === true
      const open = always || props.open === true
      const head = h('div', {
        className: 'rt-sec t-' + (props.tone || 'target') + (always ? ' flat' : ''),
        role: always ? undefined : 'button',
        tabIndex: always ? undefined : 0,
        'aria-expanded': always ? undefined : (open ? 'true' : 'false'),
        onClick: always ? undefined : props.onToggle,
        onKeyDown: always ? undefined : (e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (props.onToggle) props.onToggle(e) }
        },
      },
        h('span', { className: 'rt-sec-caret' }, always ? '▍' : (open ? '▾' : '▸')),
        props.title ? h('span', { className: 'rt-sec-title' }, props.title) : null,
        props.count !== undefined && props.count !== null ? h('span', { className: 'rt-sec-count' }, String(props.count)) : null,
        props.sub ? h('span', { className: 'rt-sec-sub' }, props.sub) : null,
        props.right ? h('span', { className: 'rt-sec-right' }, props.right) : null)
      return h('div', { className: 'rt-sec-wrap' }, head,
        open && props.children ? h('div', { className: 'rt-sec-body' }, props.children) : null)
    }

    /** 긴 텍스트 접기(L3): 고정 미리보기 높이 + 페이드아웃 + 펼치기/복사. */
    function Clip(props) {
      const [open, setOpen] = React.useState(false)
      const text = String(props.text === undefined || props.text === null ? '' : props.text)
      if (text.trim() === '') return null
      return h('div', { className: 'rt-clip' + (open ? ' open' : '') },
        h('div', { className: 'rt-clip-head' },
          props.label ? h('span', { className: 'rt-clip-label' }, props.label) : null,
          h('div', { className: 'rt-spacer' }),
          h('button', {
            className: 'rt-btn', style: { padding: '0 6px', fontSize: 11 },
            onClick: (e) => { e.stopPropagation(); copyText(text) },
          }, '복사'),
          h('button', {
            className: 'rt-btn', style: { padding: '0 6px', fontSize: 11 },
            onClick: (e) => { e.stopPropagation(); setOpen((v) => !v) },
          }, open ? '접기' : '펼치기')),
        h('div', { className: 'rt-clip-body' }, text))
    }

    /* ---------------------------------------------------------- 현재 테스트(실시간) */
    const TEST_STATUS_LABEL = {
      untested: '미테스트', testing: '테스트 중', tested: '테스트 완료',
      blocked: '차단됨', abandoned: '포기', no_surface: '공격면 없음',
    }

    /**
     * 현재 테스트 페이지: agent가 어느 자산을 공략 중이고, 어디까지 진행했으며, 무엇이 대기 중인지.
     * 5초 폴링으로 자동 새로고침하며 세 블록은 접을 수 있고, 그중 "테스트 중"은 항상 완전히 펼쳐진다.
     */
    function TestingTab(props) {
      const eng = props.engagement
      const refreshKey = props.refreshKey || 0
      const [data, setData] = React.useState(null)
      const [err, setErr] = React.useState(null)
      const [at, setAt] = React.useState(null)
      const [auto, setAuto] = React.useState(true)
      /* 접기 상태는 "탭 + 타깃" 단위로 기억한다. 테스트 중은 항상 표시되며 접기에 참여하지 않는다 */
      const collapse = useCollapse('testing:' + eng)

      /* 5초 폴링에는 진행 중 보호가 필요하다: 네트워크가 느리거나 백엔드가 막히면 요청이 계속 쌓이고,
         이전 응답이 돌아와 새 상태를 덮어쓴다(화면에서는 숫자가 오르내리는 것으로 보인다). */
      const inflight = React.useRef(false)
      const seq = React.useRef(0)
      const load = () => {
        if (!eng || inflight.current) return
        inflight.current = true
        const my = ++seq.current
        api({ op: 'activeTests', engagement: eng, limit: 20 }).then((r) => {
          if (my !== seq.current) return          /* 타깃을 바꿨으므로 이 응답은 만료되었다. 버린다 */
          if (!r || r.ok === false) { setErr((r && r.error) || '읽기 실패'); return }
          setErr(null); setData(r); setAt(new Date())
        }, (e) => { if (my === seq.current) setErr(String((e && e.message) || e)) })
          .finally(() => { if (my === seq.current) inflight.current = false })
      }
      React.useEffect(() => { seq.current += 1; load() }, [eng, refreshKey])
      React.useEffect(() => {
        if (!eng || !auto) return undefined
        const timer = setInterval(load, 5000)
        return () => clearInterval(timer)
      }, [eng, auto, refreshKey])

      const testing = (data && data.testing) || []
      const recent = (data && data.recent) || []
      const queue = (data && data.queue) || []
      const stats = (data && data.stats) || {}

      /* 자산 하나에 카드 하나: "누구를 공략 중이고, 어디까지 갔고, 무엇을 확보했는지"를 한눈에 */
      const card = (a, past) => {
        const chips = []
        chips.push(h('span', { key: 'sc', className: 'rt-scope rt-scope-' + (a.scope === 'internal' ? 'internal' : 'external') },
          a.scope === 'internal' ? '내부 네트워크' : '외부 네트워크'))
        if (a.segment_cidr) chips.push(h('span', { key: 'seg', className: 'rt-tag' }, a.segment_cidr))
        if (a.open_ports) chips.push(h('span', { key: 'p', className: 'rt-tag rt-tag-active' }, '열린 포트 ' + a.open_ports))
        if (a.vulns) chips.push(h('span', { key: 'v', className: 'rt-tag rt-tag-live' }, '확인된 취약점 ' + a.vulns))
        if (a.webshells) chips.push(h('span', { key: 'w', className: 'rt-tag rt-tag-passive' }, 'WebShell ' + a.webshells))
        if (a.tunnels) chips.push(h('span', { key: 't', className: 'rt-tag rt-tag-passive' }, '터널 ' + a.tunnels))
        if (a.priority) chips.push(h('span', { key: 'pr', className: 'rt-tag' }, '공략 용이 ' + a.priority))
        if (a.blocked_count) chips.push(h('span', { key: 'b', className: 'rt-tag', style: { color: '#ef4444', borderColor: '#ef444455' } }, '차단 ' + a.blocked_count + ' 회'))
        const noteLines = a.test_notes
          ? String(a.test_notes).split('\n').slice(-3).map((l) => (l.length > 240 ? l.slice(0, 240) + ' …' : l))
          : []
        return h('div', { key: 'at' + a.id, className: 'rt-atest' + (past ? ' past' : '') },
          h('div', { className: 'rt-atest-head' },
            past ? null : h('span', { className: 'rt-live-dot' }),
            h('span', { className: 'rt-atest-ip' }, a.ip),
            h('span', { className: 'rt-tag ' + (a.test_status === 'testing' ? 'rt-tag-live' : '') }, TEST_STATUS_LABEL[a.test_status] || a.test_status),
            h('div', { className: 'rt-spacer' }),
            h('span', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)' } },
              fmt(a.test_updated_at) + (a.test_updated_by ? ' · ' + a.test_updated_by : ''))),
          chips.length ? h('div', null, chips) : null,
          a.test_surface ? h('div', { className: 'rt-atest-meta' }, '테스트 면: ' + a.test_surface) : null,
          a.potential ? h('div', { className: 'rt-atest-meta' }, '예상 점수: ' + a.potential) : null,
          noteLines.length ? h(Clip, { label: '테스트 기록', text: noteLines.join('\n') }) : null)
      }


      const concl = (label, value, tone) => h('span', { key: label, className: 'rt-concl-i', style: { cursor: 'default' } },
        h('b', null, String(value || 0)), h('span', null, label))
      const conclusion = h('div', { className: 'rt-concl' },
        concl('테스트 중', stats.testing, 'live'),
        concl('대기', stats.untested, ''),
        concl('완료', stats.tested, ''),
        concl('포기', (stats.abandoned || 0) + (stats.blocked || 0), ''),
        concl('공격면 없음', stats.no_surface, ''),
        h('div', { className: 'rt-spacer' }),
        at ? h('span', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)' } },
          '업데이트 ' + at.toLocaleTimeString('ko-KR', { hour12: false })) : null,
        h('button', {
          className: 'rt-btn', style: { padding: '0 7px', fontSize: 11 }, title: '최근 변경 자산과 대기 큐 펼치기',
          onClick: () => collapse.setAll(['testing:' + eng, 'recent:' + eng, 'queue:' + eng], true),
        }, '전체 펼치기'),
        h('button', {
          className: 'rt-btn', style: { padding: '0 7px', fontSize: 11 }, title: '테스트 중만 남기기',
          onClick: () => collapse.setAll(['testing:' + eng, 'recent:' + eng, 'queue:' + eng], false),
        }, '전체 접기'),
        h('button', {
          className: 'rt-btn' + (auto ? ' rt-btn-primary' : ''), style: { padding: '0 7px', fontSize: 11 },
          title: '5초마다 자동 새로고침', onClick: () => setAuto((x) => !x),
        }, auto ? '실시간 · 5s' : '일시중지'),
        h('button', { className: 'rt-btn', style: { padding: '0 7px', fontSize: 11 }, onClick: load }, '새로고침'))

      const body = []
      /* 테스트 중: 항상 표시, 완전히 펼침(접기 불가) */
      body.push(h(Section, {
        key: 'testing', tone: 'test', title: '테스트 중',
        count: testing.length + ' 대',
        sub: testing.length ? 'agent가 이 자산들을 공략 중입니다' : 'agent가 어떤 자산을 테스트 시작하면 여기에 실시간으로 표시됩니다',
        open: collapse.isOpen('testing:' + eng, true),
        onToggle: collapse.toggle('testing:' + eng, true),
      }, testing.length
        ? testing.map((a) => card(a, false))
        : h('div', { className: 'rt-atest-meta', style: { paddingBottom: 4 } }, '현재 "테스트 중"인 자산이 없습니다')))

      /* 최근 변경(기본 접힘, 기억 가능) */
      body.push(h(Section, {
        key: 'recent', tone: 'past', title: '최근 변경', count: recent.length + ' 대',
        sub: '이미 테스트한 자산',
        open: collapse.isOpen('recent:' + eng, false),
        onToggle: collapse.toggle('recent:' + eng, false),
      }, recent.length ? recent.map((a) => card(a, true)) : h('div', { className: 'rt-atest-meta' }, '없음')))

      /* 대기 큐(기본 접힘, 기억 가능) */
      body.push(h(Section, {
        key: 'queue', tone: 'queue', title: '대기 큐',
        count: (data ? (data.untested || 0) : 0) + ' 대',
        sub: '공략 용이성과 포트 수로 어느 자산부터 공략할지 정렬',
        open: collapse.isOpen('queue:' + eng, false),
        onToggle: collapse.toggle('queue:' + eng, false),
      }, queue.length
        ? queue.map((a) => card(a, true)).concat([
            h('div', { key: 'queueHint', className: 'rt-atest-meta', style: { paddingTop: 4 } },
              '전체 목록(필터와 정렬 포함)은 "자산 측정" 페이지에서 확인하세요')])
        : h('div', { className: 'rt-atest-meta' }, '대기 중인 자산이 없습니다')))

      return h('div', { className: 'rt-main' },
        conclusion,
        err ? h('div', { className: 'rt-err' }, err) : null,
        data === null && !err ? h('div', { className: 'rt-empty' }, '불러오는 중…') : null,
        h('div', { className: 'rt-body', style: { overflow: 'auto' } },
          h('div', { style: { padding: '6px 12px 14px' } }, body)))
    }

    /* ---------------------------------------------------------- 세션과 입구(WebShell / 터널) */
    /**
     * 내부 네트워크 공략에서 가장 흔한 문제: WebShell이나 터널을 확보한 뒤 등록을 잊어, 얼마 지나면 "사용할 입구가 있다는 사실"을 잊는다.
     * 이 탭은 사실 저장소의 WebShell과 터널을 모아 보여주고, 연결 상태를 표시하며, 클릭 한 번으로 host 측 실측을 요청한다.
     */
    function SessionTab(props) {
      const eng = props.engagement
      const refreshKey = props.refreshKey || 0
      const [data, setData] = React.useState(null)
      const [err, setErr] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [msg, setMsg] = React.useState(null)
      const [copied, setCopied] = React.useState(null)

      const load = () => {
        if (!eng) return
        api({ op: 'sessions', engagement: eng }).then((r) => {
          if (!r || r.ok === false) { setErr((r && r.error) || '읽기 실패'); return }
          setErr(null)
          setData(r)
        }, (e) => setErr(String((e && e.message) || e)))
      }
      React.useEffect(load, [eng, refreshKey])

      const probe = () => {
        setBusy(true); setMsg(null)
        api({ op: 'probeSessions', engagement: eng, timeoutMs: 6000 }).then((r) => {
          setBusy(false)
          if (!r || r.ok === false) { setMsg({ err: (r && r.error) || '검사 실패' }); load(); return }
          const on = (r.webshells || []).filter((x) => x.status === 'online').length
          const act = (r.tunnels || []).filter((x) => x.status === 'active').length
          setMsg({ ok: '검사 완료: WebShell 온라인 ' + on + '/' + (r.webshells || []).length + ', 터널 사용 가능 ' + act + '/' + (r.tunnels || []).length })
          load()
        }, (e) => { setBusy(false); setMsg({ err: String((e && e.message) || e) }) })
      }

      /* 실제로 클립보드에 기록된 경우에만 버튼을 "복사됨"으로 켠다. 실패 시에는 그대로 오류를 보고한다 */
      const copy = (key, text) => copyWithFeedback(text, text, (okFlag, message) => {
        if (!okFlag) { setMsg({ err: message }); return }
        setCopied(key)
        setTimeout(() => setCopied((c) => (c === key ? null : c)), 1500)
      })

      const markTunnel = (t, status) => {
        setMsg(null)
        api({ op: 'updateTunnel', engagement: eng, id: t.id, patch: { status: status, check_note: '화면에서 수동 표시' } })
          .then(() => load(), (e) => setMsg({ err: String((e && e.message) || e) }))
      }
      const markShell = (w, status) => {
        setMsg(null)
        api({ op: 'updateWebshell', engagement: eng, id: w.id, patch: { status: status, check_note: '화면에서 수동 표시' } })
          .then(() => load(), (e) => setMsg({ err: String((e && e.message) || e) }))
      }

      const sessCollapse = useCollapse('sessions:' + eng)
      const totals = (data && data.totals) || {}
      const shells = (data && data.webshells) || []
      const tunnels = (data && data.tunnels) || []
      const statusDot = (s) => h('span', { className: s === 'online' || s === 'active' ? 'rt-dot-on' : (s === 'unknown' || !s ? 'rt-dot-unk' : 'rt-dot-off') })
      /* 카드 안에서는 "라벨 + 값" 두 열을 쓰고 긴 텍스트는 자동 줄바꿈한다 —— 점으로 구분한 한 줄보다 훑어보기 쉽다 */
      const fact = (label, value) => h('div', { className: 'rt-sess-fact' }, h('b', null, label), h('span', null, value))
      /* 납품 요건: 웹셸은 반드시 Behinder/Godzilla 암호화 웹셸이어야 하고(사용자가 접속할 수 있어야 함), 내부 네트워크는 반드시 suo5 터널을 거쳐야 한다 */
      const isEncryptedShell = (t) => /behinder|godzilla|\u51b0\u874e|비헨더|고질라/i.test(String(t || ''))
      const isSuo5 = (t) => /suo5/i.test(String(t || ''))
      /* 안내 바: 결론 한 줄 + 펼칠 수 있는 방법만 남긴다(원래는 세 단락의 긴 설명을 평면 배치해 본문이 전부 묻혔다) */
      const hint = (key, title, detail) => h('div', { key, className: 'rt-hint' },
        h('b', null, title),
        h('details', { className: 'rt-sess-fold', style: { marginTop: 3 } },
          h('summary', null, '하는 방법(클릭하여 펼치기)'),
          h('div', { style: { marginTop: 4 } }, detail)))
      const hints = []
      const badShells = shells.filter((w) => !isEncryptedShell(w.shell_type))
      const legitTunnels = tunnels.filter((t) => t.legit === true)
      if (badShells.length > 0) {
        hints.push(hint('h1', '입구 ' + badShells.length + '개가 Behinder 웹셸/Godzilla 웹셸이 아닙니다(사용자가 접속할 수 없어 납품 가능한 입구가 아닙니다)',
          '스킬 webshell-toolkit으로 Behinder 웹셸(behinder) 또는 Godzilla 웹셸(godzilla)을 다시 업로드하고,'
          + ' shell_type + pass_key를 redteam_webshell_add에 기록하세요. 임시 중계용으로만 쓰는 경우 비고에 명시하면 됩니다.'))
      }
      if (tunnels.length > 0 && legitTunnels.length === 0) {
        hints.push(hint('h3', '기존 ' + tunnels.length + '개 통로는 모두 "타깃 경계를 넘은" 것으로 인정되지 않습니다(경계/내부 네트워크 돌파로 인정되지 않음)',
          '자체 VPS / 자체 서버에서 연 socks5, frp, 프록시는 터널로 인정되지 않습니다. 반드시 대상 측에서 시작된 통로여야 합니다:'
          + '대상이 우리 측으로 리버스 shell을 보내거나, 대상에서 frp/Stowaway 클라이언트를 실행하거나, 대상 WebShell을 경유해 만든 suo5/HTTP 터널이어야 하며, 등록 시 entry_kind로 설명하세요.'))
      }
      const activeSuo5 = tunnels.filter((t) => isSuo5(t.kind) && t.status === 'active')
      if (shells.length > 0 && activeSuo5.length === 0) {
        hints.push(hint('h2', '사용 가능한 suo5 터널이 아직 없습니다(내부 네트워크 침투의 표준 통로)',
          '스킬 suo5-tunnel로 위의 WebShell을 경유해 socks5 터널을 만들고, 이어서 redteam_tunnel_add'
          + '(kind=suo5, listen=127.0.0.1:1080, entry=WebShell URL, reach=도달 대역)로 등록한 뒤,'
          + '마지막으로 "연결성 검사"를 클릭해 status=active를 확인하세요.'))
      }

      const shellCards = shells.map((w) => h('div', { key: 'w' + w.id, className: 'rt-sess' },
        h('div', { className: 'rt-sess-head' },
          statusDot(w.status),
          h('span', { className: 'rt-sess-title' }, w.url),
          h('span', { className: 'rt-tag rt-tag-active' }, w.shell_type || 'webshell'),
          isEncryptedShell(w.shell_type) ? null : h('span', { className: 'rt-tag rt-tag-warn' }, '사용자 접속 불가'),
          w.privilege ? h('span', { className: 'rt-tag' }, w.privilege) : null,
          h('div', { className: 'rt-spacer' }),
          copied === 'cmd' + w.id
            ? h('span', { className: 'rt-tag', style: { color: '#10b981' } }, '복사됨')
            : h('button', {
                className: 'rt-btn', style: { padding: '0 6px', fontSize: 11 },
                onClick: () => copy('cmd' + w.id, 'curl -s "' + w.url + '"'),
              }, 'URL 복사'),
          h('button', {
            className: 'rt-btn', style: { padding: '0 6px', fontSize: 11 },
            onClick: () => markShell(w, 'offline'),
          }, '무효 표시')),
        h('div', { className: 'rt-sess-facts' },
          fact('유형', (isEncryptedShell(w.shell_type) ? '암호화 웹셸(Behinder/Godzilla, 사용자 직접 연결 가능)' : '비암호화 웹셸 —— 사용자가 접속할 수 없어 임시 중계로만 사용 가능')),
          w.pass_key ? fact('연결 비밀번호', h('span', { className: 'rt-mono' }, w.pass_key)) : null,
          w.asset_ip ? fact('소재 자산', w.asset_ip) : null,
          w.privilege ? fact('권한', w.privilege) : null,
          w.secret_ref ? fact('자격 증명 참조', h('span', { className: 'rt-mono' }, w.secret_ref)) : null,
          fact('마지막 검사', (w.last_check ? fmt(w.last_check) : '미검사')
            + (w.latency_ms !== null && w.latency_ms !== undefined ? '(' + w.latency_ms + 'ms)' : '')),
          w.check_note ? fact('검사 설명', w.check_note) : null,
          w.note ? fact('비고', w.note) : null)))

      const tunnelCards = tunnels.map((t) => {
        const proxy = t.listen ? 'socks5://' + t.listen : ''
        const gogoCmd = t.listen ? './gogo -i <내부망CIDR> -m ss --ping -p top2,win,db --proxy ' + proxy : ''
        const fscanCmd = t.listen ? './fscan -h <내부망CIDR> -np -nobr -nopoc -socks5 ' + t.listen + ' -o intranet.txt' : ''
        return h('div', { key: 't' + t.id, className: 'rt-sess' },
          h('div', { className: 'rt-sess-head' },
            statusDot(t.status),
            h('span', { className: 'rt-sess-title' }, t.listen || '(리스너 주소 미입력)'),
            h('span', { className: 'rt-tag rt-tag-passive' }, t.kind || 'tunnel'),
            isSuo5(t.kind) ? null : h('span', { className: 'rt-tag rt-tag-warn' }, 'suo5 표준 통로 아님'),
            /* 타깃 경계를 넘은 통로만 돌파 증거로 인정한다(자체 VPS/자체 서버에서 연 것은 불인정) */
            t.legit === true
              ? h('span', { className: 'rt-tag rt-tag-live', title: t.entry_kind_label || '' }, '대상 측 통로')
              : (t.legit === false
                  ? h('span', { className: 'rt-tag rt-tag-warn', title: '자체 VPS/자체 서버에서만 연 통로로 대상에 닿지 않았습니다 —— 경계 돌파/내부 네트워크 돌파로 인정되지 않습니다' }, '돌파 불인정')
                  : h('span', { className: 'rt-tag', title: 'entry_kind 미선언: 대상 측의 어느 끝인지 설명하세요(target-outbound / target-http / target-agent)' }, '확인 필요')),
            t.reach ? h('span', { className: 'rt-tag' }, '도달 ' + t.reach) : null,
            h('div', { className: 'rt-spacer' }),
            h('button', {
              className: 'rt-btn', style: { padding: '0 6px', fontSize: 11 },
              onClick: () => copy('sock' + t.id, t.listen || ''),
            }, copied === 'sock' + t.id ? '복사됨' : '주소 복사'),
            t.status === 'active'
              ? h('button', { className: 'rt-btn', style: { padding: '0 6px', fontSize: 11 }, onClick: () => markTunnel(t, 'down') }, '무효 표시')
              : h('button', { className: 'rt-btn', style: { padding: '0 6px', fontSize: 11 }, onClick: () => markTunnel(t, 'active') }, '사용 가능 표시')),
          h('div', { className: 'rt-sess-facts' },
            fact('대상 측 입구', t.entry || '미등록'),
            fact('경계 넘음', t.legit === true
              ? h('span', { className: 'rt-tag rt-tag-live' }, t.entry_kind_label || t.entry_kind || '대상 측 확인됨')
              : (t.legit === false
                  ? h('span', { className: 'rt-tag rt-tag-warn' }, '돌파 불인정(자체 VPS에서만 프록시 개설)')
                  : h('span', { className: 'rt-tag' }, 'entry_kind 미선언, 확인 필요'))),
            t.reach ? fact('도달 대역', t.reach) : null,
            t.asset_ip ? fact('소재 자산', t.asset_ip) : null,
            fact('마지막 검사', (t.last_check ? fmt(t.last_check) : '미검사')
              + (t.latency_ms !== null && t.latency_ms !== undefined ? '(' + t.latency_ms + 'ms)' : '')),
            t.check_note ? fact('검사 설명', t.check_note) : null,
            t.note ? fact('비고', t.note) : null),
          /* 명령은 기본 접힘: 카드의 우선 정보는 "이 통로를 쓸 수 있는지, 어디로 통하는지"이고 명령은 필요할 때 펼친다 */
          t.command ? h('details', { className: 'rt-sess-fold' },
            h('summary', null, '개설 명령(클릭하여 펼치기 / 복사)'),
            h('div', Object.assign({ className: 'rt-code', title: '클릭하여 복사' }, clickable(() => copy('c' + t.id, t.command), { label: '명령 복사' })),
              copied === 'c' + t.id ? '복사됨' : t.command)) : null,
          t.status === 'active' && t.listen
            ? h('details', { className: 'rt-sess-fold' },
                h('summary', null, '이 터널로 스캔(gogo / fscan 명령)'),
                h('div', { className: 'rt-sess-cmd' },
                  h('div', Object.assign({ className: 'rt-code', title: '클릭하여 복사' }, clickable(() => copy('g' + t.id, gogoCmd), { label: 'gogo 명령 복사' })),
                    copied === 'g' + t.id ? '복사됨' : gogoCmd),
                  h('div', Object.assign({ className: 'rt-code', style: { display: 'block', marginTop: 3 }, title: '클릭하여 복사' }, clickable(() => copy('f' + t.id, fscanCmd), { label: 'fscan 명령 복사' })),
                    copied === 'f' + t.id ? '복사됨' : fscanCmd)))
            : null)
      })

      return h('div', { className: 'rt-main' },
        h('div', { className: 'rt-toolbar' },
          h('span', { style: { fontWeight: 600 } }, '세션과 입구'),
          h('span', { className: 'rt-tag' }, 'WebShell ' + (totals.webshellsOnline || 0) + '/' + (totals.webshells || 0) + ' 온라인'),
          h('span', { className: 'rt-tag' }, '터널 ' + (totals.tunnelsActive || 0) + '/' + (totals.tunnels || 0) + ' 사용 가능'),
          h('span', { className: 'rt-tag' }, '자격 증명 ' + (totals.credentials || 0)),
          h('span', { className: 'rt-tag' }, '접속 세션 ' + (totals.access || 0)),
          h('div', { className: 'rt-spacer' }),
          h('button', { className: 'rt-btn rt-btn-primary', disabled: busy, onClick: probe }, busy ? '검사 중…' : '연결성 검사'),
          h('button', { className: 'rt-btn', onClick: load }, '새로고침')),
        msg ? h('div', { className: msg.err ? 'rt-err' : 'rt-foot' }, msg.err || msg.ok) : null,
        err ? h('div', { className: 'rt-err' }, err) : null,
        h('div', { className: 'rt-body', style: { overflow: 'auto' } },
          !shells.length && !tunnels.length
            ? h('div', { className: 'rt-empty' },
                h('div', null, '아직 WebShell이나 터널을 등록하지 않았습니다.'),
                h('div', { style: { marginTop: 6, fontSize: 12 } },
                  'WebShell을 확보하면 redteam_webshell_add, 터널을 만들었으면 redteam_tunnel_add(suo5 / socks5 / ssh -R)를 사용하세요. 이후 에이전트는 redteam_sessions로 확인할 수 있습니다.'))
            : null,
          hints.length ? h('div', { style: { padding: '8px 10px 0' } }, hints) : null,
          h(Section, {
            key: 'webshells', tone: 'queue', title: 'WebShell',
            count: (totals.webshellsOnline || 0) + '/' + (totals.webshells || 0) + ' 온라인',
            sub: '이미 온라인인 제어 가능 입구',
            open: sessCollapse.isOpen('shells', true), onToggle: sessCollapse.toggle('shells', true),
          }, shells.length
            ? h('div', { className: 'rt-sess-grid', style: { padding: 0 } }, shellCards)
            : h('div', { className: 'rt-atest-meta' }, '없음(WebShell을 확보하면 redteam_webshell_add로 등록)')),
          h(Section, {
            key: 'tunnels', tone: 'test', title: '내부 네트워크 터널',
            count: (totals.tunnelsActive || 0) + '/' + (totals.tunnels || 0) + ' 사용 가능',
            sub: '스캐너 프록시로 바로 사용 가능',
            open: sessCollapse.isOpen('tunnels', true), onToggle: sessCollapse.toggle('tunnels', true),
          }, tunnels.length
            ? h('div', { className: 'rt-sess-grid', style: { padding: 0 } }, tunnelCards)
            : h('div', { className: 'rt-atest-meta' }, '없음(터널을 만든 뒤 redteam_tunnel_add로 등록)'))))

    }

    /* ---------------------------------------------------------- 오류 경계 */
    /**
     * 탭 하나의 렌더링이 실패하면 그 탭만 저하시키고 패널 전체를 망가뜨리지 않는다: 패널과 사이드바 버튼은 계속 사용 가능하며,
     * 사용자는 클릭 한 번으로 자산 측정으로 돌아갈 수 있다. (이전에 패널이 통째로 사라지고 버튼이 눌리지 않던 것이 바로 이 보호 계층이 없었기 때문이다.)
     */
    class RtBoundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { error: null }
      }
      static getDerivedStateFromError(error) {
        return { error: error }
      }
      componentDidCatch(error) {
        try { console.error('[redteam-ui] 페이지 렌더링 오류:', error) } catch (e) { /* ignore */ }
      }
      render() {
        if (this.state.error) {
          const msg = this.state.error && this.state.error.message ? this.state.error.message : String(this.state.error)
          return h('div', { className: 'rt-pane' },
            h('div', { className: 'rt-err' }, '이 페이지 렌더링 오류: ' + msg),
            h('button', {
              className: 'rt-btn',
              onClick: () => { this.setState({ error: null }); setUI({ tab: 'assets' }) },
            }, '자산 측정으로 돌아가기'))
        }
        return this.props.children
      }
    }

    /**
     * 에이전트 탭: 동시 실행 슬롯(최대 3개) + 여섯 역할과 그 프롬프트.
     * 메인 세션이 작업을 배분하기 전에 여기서 슬롯을 확인하며, 사용자도 "지금 몇 개의 에이전트를 더 띄울 수 있는지" 한눈에 볼 수 있다.
     */
    function AgentsTab(props) {
      const eng = props.engagement
      const refreshKey = props.refreshKey || 0
      const [roles, setRoles] = React.useState(null)
      const [err, setErr] = React.useState(null)
      const [concurrency, setConcurrency] = React.useState(null)
      const [busy, setBusy] = React.useState(false)

      const load = () => {
        setBusy(true)
        api({ op: eng ? 'prompts' : 'bootstrap', engagement: eng || undefined }).then((r) => {
          setBusy(false)
          if (!r || r.ok === false) { setErr((r && r.error) || '읽기 실패'); return }
          setErr(null)
          if (r.roles) setRoles(r.roles)
        }, (e) => { setBusy(false); setErr(String((e && e.message) || e)) })
        /* 동시 실행 슬롯은 "현재 실행 중인 하위 에이전트" 기준으로 계산한다; host 측은 subagents 레지스트리를 읽는다 */
        api({ op: 'agentsStatus' }).then((r) => {
          if (r && r.ok !== false) setConcurrency(r)
        }, () => {})
      }
      React.useEffect(load, [eng, refreshKey])

      const used = concurrency ? concurrency.used : null
      const max = concurrency ? concurrency.max : 3
      return h('div', { className: 'rt-main' },
        h('div', { className: 'rt-toolbar' },
          h('span', { style: { fontWeight: 600 } }, '작전 에이전트'),
          h('span', { className: 'rt-tag rt-tag-passive' }, '동시 실행 상한 ' + max),
          used === null
            ? h('span', { className: 'rt-tag' }, '점유 알 수 없음')
            : h('span', { className: 'rt-tag' + (used >= max ? ' rt-tag-warn' : ' rt-tag-live') }, '실행 중 ' + used + ' / 남은 슬롯 ' + Math.max(max - used, 0)),
          h('div', { className: 'rt-spacer' }),
          h('button', { className: 'rt-btn', disabled: busy, onClick: load }, busy ? '불러오는 중…' : '새로고침')),
        h('div', { className: 'rt-pane' },
          err ? h('div', { className: 'rt-err' }, err) : null,
          h('div', { className: 'rt-card' },
            h('h4', null, '동시 실행 규칙(강제 제약)'),
            h('div', { style: { fontSize: 12, lineHeight: 1.7 } },
              '· 같은 타깃에 **동시 최대 ' + max + '개의 실행 에이전트**; 메인 세션은 작업 배분 전에 `redteam_agent_slot`으로 슬롯을 확보하며, 가득 차면 바로 거부합니다.',
              h('br'),
              '· **기본은 하나씩 배분하고 순서대로 진행합니다**; 정말로 서로 의존하지 않는 작업만 병렬로 돌립니다.',
              h('br'),
              '· 각 세션은 **자기 타깃 바인딩**을 가집니다: 여러 세션이 병렬로 돌아도 보고서가 섞이지 않습니다(하위 에이전트는 상위 세션의 타깃을 상속합니다).')),
          h('div', { className: 'rt-card' },
            h('h4', null, '여섯 역할'),
            h('div', { style: { fontSize: 12, lineHeight: 1.8 } },
              '① 정보 수집 `recon` —— 자산만 수집하며, 기관 자산을 빠짐없이 모읍니다(엣지 및 미등록 자산 포함)', h('br'),
              '② 자산 정리 `assess` —— 하나씩 검토하며 공격 용이성을 평가하고 전부 DB에 등록합니다', h('br'),
              '③ 취약점 발견 `vuln-scan` —— 먼저 DB 조회로 중복 제거 → Nday/1day 우선 → 인터페이스 미인증 접근 탐지', h('br'),
              '④ 취약점 이용 `exploit` —— 먼저 서버 권한 확보(Behinder/Godzilla 웹셸) + suo5 터널 구축 후 다른 점수 항목을 공략합니다', h('br'),
              '⑤ 내부 네트워크 침투 `internal` —— 터널을 통해 ①②③④를 차례로 띄워 내부 네트워크를 진행합니다', h('br'),
              '⑥ 메인 세션 `plan` —— 계획, 작업 배분, 취합, 보고만 하고 직접 손대지 않습니다')),
          h(ConcurrencyCard, { concurrency, onSaved: load }),
          h('div', { className: 'rt-card' },
            h('h4', null, '역할 프롬프트(타깃별 저장, 여기서 편집 가능)'),
            h('div', { style: { fontSize: 11.5, color: 'var(--dsw-alias-label-secondary)', marginBottom: 6 } },
              '"에이전트 프롬프트"가 이 페이지로 통합되었습니다; 아래는 전체 편집기입니다(수정 후 저장하면 현재 타깃에만 적용됩니다).'),
            h(PromptsTab, { engagement: eng, refreshKey: refreshKey }))))
    }

    function ConcurrencyCard(props) {
      const info = props.concurrency || {}
      const [draft, setDraft] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [msg, setMsg] = React.useState(null)
      React.useEffect(() => { if (info.max) setDraft(String(info.max)) }, [info.max])

      const limit = info.limit || 10
      const used = typeof info.used === 'number' ? info.used : null
      const source = info.source === 'settings' ? '패널에서 설정'
        : info.source === 'env' ? '환경 변수 REDTEAM_MAX_AGENTS' : '기본값'
      const n = Number(draft)
      const invalid = !Number.isFinite(n) || Math.floor(n) !== n || n < 1 || n > limit
      const save = () => {
        if (invalid) return
        setBusy(true); setMsg(null)
        api({ op: 'setAgentsMax', max: n }).then((r) => {
          setBusy(false)
          if (!r || r.ok === false) { setMsg({ err: (r && r.error) || '저장 실패' }); return }
          setMsg({ ok: '저장했습니다: 동시 실행 상한 ' + r.max + '(즉시 적용, 재시작 불필요)' })
          if (props.onSaved) props.onSaved()
        }, (e) => { setBusy(false); setMsg({ err: String((e && e.message) || e) }) })
      }
      return h('div', { className: 'rt-card' },
        h('h4', null, '동시 실행 수'),
        h('div', { style: { fontSize: 12, lineHeight: 1.8, marginBottom: 8 } },
          '같은 타깃에 **동시에 최대 몇 개의 실행 에이전트**를 둘 수 있는지입니다. 현재 적용값: **' + (info.max || '?') + '**'
          + (used === null ? '' : '(실행 중 ' + used + ', 남은 슬롯 ' + Math.max((info.max || 0) - used, 0) + ')')
          + ', 출처: ' + source + '. 수정 후 **즉시 적용**되며 재시작이 필요 없습니다.'),
        h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
          h('input', {
            className: 'rt-input', style: { width: 90 }, type: 'number', min: 1, max: limit,
            value: draft, onChange: (e) => setDraft(e.target.value),
          }),
          h('span', { style: { fontSize: 11.5, color: 'var(--dsw-alias-label-secondary)' } }, '범위 1 – ' + limit),
          h('button', { className: 'rt-btn rt-btn-primary', disabled: busy || invalid, onClick: save },
            busy ? '저장 중…' : '저장'),
          msg && msg.err ? h('span', { style: { fontSize: 12, color: 'var(--rt-danger, #d33)' } }, msg.err) : null,
          msg && msg.ok ? h('span', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } }, msg.ok) : null),
        h('div', { className: 'rt-note', style: { marginTop: 8 } },
          '⚠️ 값을 늘린다고 더 빨라지지 않습니다: **같은 모델 API Key의 동시 실행/속도 상한은 공유되므로**, 동시에 너무 많이 배분하면 서로 자리를 뺏고,'
          + '대기열 정체, 타임아웃, 응답 잘림, 심하면 레이트 리밋 오류로 나타납니다 —— 오히려 테스트 결과가 불안정해집니다(놓친 테스트, 중도 포기).'
          + '2–3부터 시작하고, Key의 한도가 충분하고 작업들이 정말로 서로 의존하지 않을 때만 늘리기를 권합니다.'))
    }

    /**
     * 버전 표시 + 자동 업데이트 버튼.
     *
     * 동작: 마운트 시 최신 버전을 조용히 한 번 조회하고(npm registry), 새 버전이 있으면 버튼을
     * "새 버전 vX" 상태로 켠다; 클릭하면 확인 대화상자(현재 버전 / 최신 버전 / 설치 위치 / 차단 항목)가 뜨고,
     * 확인하면 host 측이 설치 → dsh web 재시작을 수행한다(페이지 연결이 끊기며, 재시작 후 새로고침하면 된다).
     */
    function VersionBar(props) {
      const [info, setInfo] = React.useState(null)
      const [err, setErr] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [open, setOpen] = React.useState(false)
      const [msg, setMsg] = React.useState(null)
      const [countdown, setCountdown] = React.useState(0)

      const check = (silent) => {
        if (!silent) setBusy(true)
        api({ op: 'updateCheck' }).then((r) => {
          setBusy(false)
          if (!r || r.ok === false) {
            /* 개발 모드이거나 registry 조회 불가: 현재 버전만 표시하고, 오류로 사용자를 방해하지 않는다 */
            if (!silent) setErr((r && r.error) || '업데이트 확인 실패')
            api({ op: 'version' }).then((v) => { if (v && v.ok !== false) setInfo(v) }, () => {})
            return
          }
          setErr(null)
          setInfo(r)
        }, (e) => {
          setBusy(false)
          if (!silent) setErr(String((e && e.message) || e))
          api({ op: 'version' }).then((v) => { if (v && v.ok !== false) setInfo(v) }, () => {})
        })
      }
      React.useEffect(() => { check(true) }, [])

      const apply = () => {
        setBusy(true)
        setMsg(null)
        api({ op: 'updateApply', target: (info && info.latest) || undefined }).then((r) => {
          setBusy(false)
          if (!r || r.ok === false) { setMsg({ err: (r && r.error) || '업데이트 실패' }); return }
          setMsg({ ok: '설치 완료 ' + (r.installed || '') + ', 현재 호스트를 재시작하는 중…' })
          /* 재시작은 이 페이지 연결을 끊는다: 카운트다운으로 사용자에게 잠시 후 새로고침하라고 알린다 */
          setCountdown(6)
          const t = setInterval(() => {
            setCountdown((n) => {
              if (n <= 1) { clearInterval(t); window.location.reload(); return 0 }
              return n - 1
            })
          }, 1000)
        }, (e) => { setBusy(false); setMsg({ err: String((e && e.message) || e) }) })
      }

      const current = info && info.current ? info.current : (info && info.plugin ? info.plugin.version : null)
      const latest = info && info.latest ? info.latest : null
      const hasNew = !!(info && info.updateAvailable)
      const blockers = (info && info.blockers) || []
      const notes = (info && info.notes) || []
      const mode = info && info.install ? info.install.mode : null

      return h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 6 } },
        h('span', {
          className: 'rt-tag' + (hasNew ? ' rt-tag-warn' : ''),
          title: ('현재 버전 ' + (current || '알 수 없음') + (latest ? '\n최신 버전 ' + latest : '')
            + (mode === 'dev' ? '\n설치 방식: 개발 모드(소스 심볼릭 링크)' : mode === 'package' ? '\n설치 방식: 패키지 설치' : '')
            + (info && info.check_error ? '\n확인 실패: ' + info.check_error : '')),
        }, 'v' + (current || '?')),
        hasNew
          ? h('button', {
              className: 'rt-btn rt-btn-primary', disabled: busy,
              onClick: () => { setOpen(true); setMsg(null) },
              title: '새 버전 ' + latest + ' 발견: 클릭하여 확인하고 한 번에 업데이트(현재 호스트가 재시작됩니다)',
            }, busy ? '확인 중…' : '새 버전 v' + latest)
          : h('button', {
              className: 'rt-btn', disabled: busy, onClick: () => check(false),
              title: 'npm의 최신 버전을 다시 확인',
            }, busy ? '확인 중…' : '업데이트 확인'),
        open
          ? h('div', { className: 'rt-modal', 'aria-hidden': 'true', onClick: () => setOpen(false) },
              h('div', { className: 'rt-modal-box', onClick: (e) => e.stopPropagation() },
                h('h4', { style: { marginTop: 0 } }, 'RedTeam 모드 업데이트'),
                h('div', { className: 'rt-kv' }, h('b', null, '현재 버전'), h('span', null, current || '알 수 없음')),
                h('div', { className: 'rt-kv' }, h('b', null, '최신 버전'), h('span', null, latest || '알 수 없음')),
                h('div', { className: 'rt-kv' }, h('b', null, '설치 방식'),
                  h('span', null, mode === 'dev' ? '개발 모드(소스 심볼릭 링크)' : mode === 'package' ? '패키지 설치(' + ((info.install && info.install.packageManager) || 'npm') + ')' : '알 수 없음')),
                info && info.install && info.install.dir
                  ? h('div', { className: 'rt-kv' }, h('b', null, '설치 위치'), h('span', { className: 'rt-mono' }, info.install.dir))
                  : null,
                blockers.length
                  ? h('div', { className: 'rt-hint' },
                      h('div', { style: { fontWeight: 600, marginBottom: 4 } }, '지금은 업데이트할 수 없습니다:'),
                      blockers.map((b, i) => h('div', { key: 'b' + i }, '· ' + b)))
                  : null,
                notes.length
                  ? h('div', { className: 'rt-foot', style: { padding: '4px 0' } }, notes.map((n, i) => h('div', { key: 'n' + i }, n)))
                  : null,
                h('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', margin: '8px 0' } },
                  '업데이트 과정: 새 버전 설치 → 현재 호스트 자동 재시작(공식 exe / 커뮤니티판 / dsh web; 현재 페이지 연결이 끊기며 약 5–10초 후 자동으로 새로고침됩니다).'
                  + '재시작 전에 실행 중인 에이전트가 있는지 확인하고, 있으면 멈춰 대기합니다.'),
                msg ? h('div', { className: msg.err ? 'rt-err' : 'rt-foot' }, msg.err || msg.ok) : null,
                countdown > 0
                  ? h('div', { className: 'rt-foot' }, '호스트를 재시작하는 중, ' + countdown + '초 후 페이지를 자동 새로고침합니다…')
                  : null,
                h('div', { style: { display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 10 } },
                  h('button', { className: 'rt-btn', onClick: () => setOpen(false) }, '닫기'),
                  h('button', {
                    className: 'rt-btn rt-btn-primary',
                    disabled: busy || blockers.length > 0 || mode === 'dev',
                    title: mode === 'dev' ? '개발 모드 설치는 저장소 절차로 업그레이드하세요' : blockers.length ? '위의 차단 항목을 먼저 해결하세요' : '설치 후 재시작',
                    onClick: apply,
                  }, busy ? '업데이트 중…' : '한 번에 업데이트 후 재시작'))))
          : null)
    }

    /* ---------------------------------------------------------- 상주 패널 본체 */
    /**
     * "읽지 않음" 상태: 타깃별로 localStorage에 기록하고, 25초마다 host의 consoleDigest를 조회한다
     * (탭별 건수 + 최근 갱신 시각). 로컬에 기억한 스냅샷보다 새로우면 해당 탭에 빨간 점을 찍고,
     * 사용자가 그 탭을 열면 현재 값을 읽음으로 기록해 빨간 점이 사라진다.
     */
    const UNREAD_KEY = 'rt-unread:'
    const loadUnread = (eng) => {
      try {
        const raw = window.localStorage.getItem(UNREAD_KEY + eng)
        const parsed = raw ? JSON.parse(raw) : null
        return parsed && typeof parsed === 'object' ? parsed : null
      } catch (e) { return null }
    }
    const saveUnread = (eng, value) => {
      try { window.localStorage.setItem(UNREAD_KEY + eng, JSON.stringify(value)) } catch (e) { /* 시크릿 모드 등: 저장 못 해도 동작한다 */ }
    }
    /** 이 탭이 지난번 조회 이후 새 내용을 가졌는지(건수가 늘었거나, 최신 항목이 지난 조회보다 새로움). */
    const digestHasNew = (prev, cur) => {
      if (!cur) return false
      if (!prev) return true
      const pc = Number(prev.count || 0)
      const cc = Number(cur.count || 0)
      if (cc > pc) return true
      const pa = prev.at || ''
      const ca = cur.at || ''
      return ca !== '' && ca !== pa && ca > pa
    }

    const RT_GEOM_KEY = 'rt-dock-geom-v1'
    function clampRtGeom(g) {
      const vw = (typeof window !== 'undefined' && window.innerWidth) || 1280
      const vh = (typeof window !== 'undefined' && window.innerHeight) || 800
      const w = Math.min(Math.max(320, Number(g && g.w) || 620), Math.max(320, vw))
      const h = Math.min(Math.max(240, Number(g && g.h) || 520), Math.max(240, vh))
      const x = Math.min(Math.max(0, Number(g && g.x) || 0), Math.max(0, vw - w))
      const y = Math.min(Math.max(0, Number(g && g.y) || 0), Math.max(0, vh - h))
      return { x: x, y: y, w: w, h: h }
    }
    function defaultRtGeom() {
      const vw = (typeof window !== 'undefined' && window.innerWidth) || 1280
      const vh = (typeof window !== 'undefined' && window.innerHeight) || 800
      let w = 620
      try {
        const saved = Number(window.localStorage.getItem('rt-dock-width'))
        if (Number.isFinite(saved) && saved >= 320 && saved <= 1200) w = saved
      } catch (e) { /* 시크릿 모드 */ }
      const h = Math.max(240, Math.min(640, vh - 24))
      return clampRtGeom({ x: Math.max(0, vw - w - 12), y: 12, w: w, h: h })
    }
    function loadRtGeom() {
      try {
        const raw = JSON.parse(window.localStorage.getItem(RT_GEOM_KEY) || 'null')
        if (raw && typeof raw === 'object') return clampRtGeom(raw)
      } catch (e) { /* 시크릿 모드 또는 손상된 데이터 */ }
      return defaultRtGeom()
    }

    function Panel(props) {
      /* embedded 인 경우 dsh-purge 외곽 dock에 삽입된 경우 자체 접기/전체 보기/드래그 바를 두지 않아 외곽 버튼과 겹치지 않게 한다 */
      const embedded = !!(props && props.embedded)
      const st = useUI()
      const [engagements, setEngagements] = React.useState([])
      const [eng, setEng] = React.useState(null)
      const [snapshot, setSnapshot] = React.useState(null)
      const [err, setErr] = React.useState(null)
      const [newName, setNewName] = React.useState('')
      const [geom, setGeom] = React.useState(loadRtGeom)
      const [creating, setCreating] = React.useState(false)
      const [refreshKey, setRefreshKey] = React.useState(0)
      const [digest, setDigest] = React.useState(null)
      const [seen, setSeen] = React.useState(null)

      React.useEffect(() => {
        if (embedded) return undefined
        try { window.localStorage.setItem(RT_GEOM_KEY, JSON.stringify(geom)) } catch (e) { /* 시크릿 모드 */ }
      }, [geom, embedded])
      React.useEffect(() => {
        if (embedded) return undefined
        const onResize = () => setGeom((g) => clampRtGeom(g))
        window.addEventListener('resize', onResize)
        return () => window.removeEventListener('resize', onResize)
      }, [embedded])

      const loadSnapshot = (id) => {
        if (!id) { setSnapshot(null); return }
        api({ op: 'snapshot', engagement: id }).then((r) => {
          if (!r || r.ok === false) { setErr((r && r.error) || '불러오기 실패'); return }
          setErr(null)
          setSnapshot(r)
        }, (e) => setErr(String((e && e.message) || e)))
      }

      const refreshList = (selectId) => {
        api({ op: 'bootstrap' }).then((b) => {
          setEngagements((b && b.engagements) || [])
          if (selectId) { setEng(selectId); loadSnapshot(selectId) }
        }, () => {})
      }

      React.useEffect(() => {
        api({ op: 'bootstrap' }).then((r) => {
          if (!r || r.ok === false) { setErr((r && r.error) || '자산 DB에 연결할 수 없습니다'); return }
          setEngagements(r.engagements || [])
          const id = r.current || (r.engagements && r.engagements[0] && r.engagements[0].id) || null
          if (id) { setEng(id); loadSnapshot(id) }
        }, (e) => setErr(String((e && e.message) || e)))
      }, [])

      const openEngagement = (nameArg) => {
        const name = String(nameArg || newName).trim()
        if (!name) return
        setCreating(true)
        api({ op: 'openEngagement', name: name }).then((r) => {
          setCreating(false)
          if (!r || r.ok === false) { setErr((r && r.error) || '생성 실패'); return }
          setNewName('')
          refreshList(r.engagement && r.engagement.id)
        }, (e) => { setCreating(false); setErr(String((e && e.message) || e)) })
      }

      /** 새로고침: 명부/스냅샷을 다시 가져오고 현재 탭이 데이터를 다시 조회하게 한다. */
      const refreshAll = () => {
        setRefreshKey((k) => k + 1)
        api({ op: 'bootstrap' }).then((b) => {
          setEngagements((b && b.engagements) || [])
          if (eng) loadSnapshot(eng)
        }, () => { if (eng) loadSnapshot(eng) })
      }

      const trackPointer = (e, move) => {
        if (e.button !== 0) return
        e.preventDefault()
        e.stopPropagation()
        const up = () => {
          window.removeEventListener('mousemove', move)
          window.removeEventListener('mouseup', up)
        }
        window.addEventListener('mousemove', move)
        window.addEventListener('mouseup', up)
      }
      const startDrag = (e) => {
        if (e.target && e.target.closest && e.target.closest('button,a,input,select,textarea,label')) return
        const sx = e.clientX
        const sy = e.clientY
        const ox = geom.x
        const oy = geom.y
        trackPointer(e, (ev) => setGeom((g) => clampRtGeom({ x: ox + (ev.clientX - sx), y: oy + (ev.clientY - sy), w: g.w, h: g.h })))
      }
      const startResizeLeft = (e) => {
        const sx = e.clientX
        const ox = geom.x
        const ow = geom.w
        trackPointer(e, (ev) => {
          const dx = ev.clientX - sx
          setGeom((g) => clampRtGeom({ x: ox + dx, y: g.y, w: ow - dx, h: g.h }))
        })
      }
      const startResizeRight = (e) => {
        const sx = e.clientX
        const ow = geom.w
        trackPointer(e, (ev) => setGeom((g) => clampRtGeom({ x: g.x, y: g.y, w: ow + (ev.clientX - sx), h: g.h })))
      }
      const startResizeBottom = (e) => {
        const sy = e.clientY
        const oh = geom.h
        trackPointer(e, (ev) => setGeom((g) => clampRtGeom({ x: g.x, y: g.y, w: g.w, h: oh + (ev.clientY - sy) })))
      }
      const startResizeCorner = (e) => {
        const sx = e.clientX
        const sy = e.clientY
        const ow = geom.w
        const oh = geom.h
        trackPointer(e, (ev) => setGeom((g) => clampRtGeom({ x: g.x, y: g.y, w: ow + (ev.clientX - sx), h: oh + (ev.clientY - sy) })))
      }

      /* 타깃 전환: 해당 타깃의 읽지 않음 스냅샷을 다시 읽고 즉시 요약을 한 번 조회한다 */
      React.useEffect(() => {
        if (!eng) { setDigest(null); setSeen(null); return undefined }
        setSeen(loadUnread(eng))
        let alive = true
        let digestInflight = false
        const tick = () => {
          if (digestInflight) return        /* 이전 회차가 아직 돌아오지 않았으니 이번 회차는 건너뛴다, 요청을 쌓지 않는다 */
          digestInflight = true
          api({ op: 'consoleDigest', engagement: eng }).then((r) => {
            if (alive && r && r.ok !== false && r.sections) setDigest(r.sections)
          }, () => { /* 네트워크 오류: 중단하지 않고 다음 회차를 기다린다 */ })
            .finally(() => { digestInflight = false })
        }
        tick()
        const timer = window.setInterval(tick, 25000)
        return () => { alive = false; window.clearInterval(timer) }
      }, [eng, refreshKey])

      /**
       * 탭을 연다는 것은 그 탭의 내용을 봤다는 뜻이다: 현재 요약을 읽음으로 기록한다.
       * 읽지 않은 상태(패널을 처음 연 경우)는 새 내용으로 치지 않는다 —— 그러지 않으면 들어가자마자 화면이 빨간 점투성이가 되어 "어디에 새 내용이 있는지" 오히려 알 수 없다.
       */
      const markTabSeen = React.useCallback((tab) => {
        if (!eng) return
        setSeen((prev) => {
          const base = prev || (() => {
            const fresh = {}
            for (const [k, v] of Object.entries((digest || {}))) fresh[k] = { count: Number(v.count || 0), at: v.at || null }
            return fresh
          })()
          const next = Object.assign({}, base)
          const cur = digest && digest[tab]
          if (cur) next[tab] = { count: Number(cur.count || 0), at: cur.at || null }
          saveUnread(eng, next)
          return next
        })
      }, [eng, digest])

      const unreadOf = (tab) => {
        if (!eng || !digest) return false
        if (!seen) return false
        return digestHasNew(seen[tab], digest[tab])
      }

      const stats = (snapshot && snapshot.stats) || {}
      const tabs = [
        ['assets', '자산 측정'], ['env', '환경 적응'], ['agents', '에이전트'], ['sessions', '세션 터널'],
        ['findings', '취약점 전과'],
        ['chain', '공격 체인'], ['scores', '점수 목표'], ['report', '보고서'],
      ]
      const full = isFullWindow()
      const openFull = () => {
        try { window.open(window.location.href.split('#')[0] + '#redteam-full', '_blank', 'noopener') } catch (e) { setErr('새 창을 열 수 없습니다: ' + ((e && e.message) || e)) }
      }
      const exitFull = () => {
        /* 스크립트로 연 창을 우선 닫는다; 닫을 수 없으면 사이드바가 있는 일반 화면으로 돌아간다 */
        try { window.close() } catch (e) { /* 스크립트로 열지 않은 창은 닫을 수 없다 */ }
        try {
          if (window.location.hash) {
            window.location.hash = ''
            window.location.reload()
          }
        } catch (e) { /* ignore */ }
      }
      React.useEffect(() => {
        if (!full) return undefined
        const onKey = (e) => { if (e.key === 'Escape') exitFull() }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [full])

      let body
      if (err) body = h('div', { className: 'rt-err' }, err)
      /* 전역 페이지: 타깃이 없어도 볼 수 있다(환경 적응 / 에이전트 개요). 오픈소스판에서는 지식 베이스와 스킬 라이브러리를 제외한다. */
      else if (st.tab === 'env' || st.tab === 'knowledge' || st.tab === 'skills') body = h(EnvTab, { refreshKey: refreshKey })
      else if (st.tab === 'agents' || st.tab === 'prompts') body = h(AgentsTab, { engagement: eng, refreshKey: refreshKey })
      else if (!eng) {
        body = h('div', { className: 'rt-pane' },
          h('div', { className: 'rt-card' },
            h('h4', null, '아직 타깃이 없습니다'),
            h('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', marginBottom: 8 } },
              '공방 훈련 타깃 기관명을 입력하고 훈련을 생성해 자산 측정을 시작하세요.'),
            h('div', { style: { display: 'flex', gap: 8 } },
              h('input', {
                className: 'rt-input', style: { flex: 1 }, placeholder: '예: 예시 테크놀로지 주식회사',
                value: newName, onChange: (e) => setNewName(e.target.value),
                onKeyDown: (e) => { if (e.key === 'Enter') openEngagement() },
              }),
              h('button', { className: 'rt-btn rt-btn-primary', disabled: creating, onClick: () => openEngagement() },
                creating ? '생성 중…' : '타깃 생성'))))
      } else if (st.tab === 'assets') body = h(AssetsTab, { engagement: eng, snapshot: snapshot, refreshKey: refreshKey, onRefresh: refreshAll, onData: () => loadSnapshot(eng) })
      else if (st.tab === 'testing') body = h(AssetsTab, { engagement: eng, snapshot: snapshot, refreshKey: refreshKey, onRefresh: refreshAll, onData: () => loadSnapshot(eng) })
      else if (st.tab === 'sessions') body = h(SessionTab, { engagement: eng, refreshKey: refreshKey })
      else if (st.tab === 'findings') body = h(FindingsTab, { engagement: eng, refreshKey: refreshKey })
      else if (st.tab === 'chain') body = h(ChainTab, { engagement: eng, refreshKey: refreshKey })
      else if (st.tab === 'report') body = h(ReportTab, { engagement: eng, refreshKey: refreshKey })
      else if (st.tab === 'attackfiles') body = h(FindingsTab, { engagement: eng, refreshKey: refreshKey })
      else if (st.tab === 'scores') body = h(ScoreTab, { engagement: eng, refreshKey: refreshKey })
      else body = h('div', { className: 'rt-empty' }, '알 수 없는 탭')

      const shellProps = full
        ? { className: 'rt-full', style: { display: 'flex' } }
        : embedded
          ? { className: 'rt-dock rt-embedded', 'data-open': '1', style: { width: '100%', display: 'flex' } }
          : {
              className: 'rt-dock',
              'data-open': st.open ? '1' : '0',
              style: {
                left: geom.x + 'px',
                top: geom.y + 'px',
                right: 'auto',
                bottom: 'auto',
                width: geom.w + 'px',
                height: geom.h + 'px',
                display: st.open ? 'flex' : 'none',
              },
            }

      return h('div', shellProps,
        (full || embedded) ? null : h('div', { className: 'rt-grip', title: '드래그하여 너비 조정', onMouseDown: startResizeLeft }),
        (full || embedded) ? null : h('div', { className: 'rt-resize-r', title: '드래그하여 너비 조정', onMouseDown: startResizeRight }),
        (full || embedded) ? null : h('div', { className: 'rt-resize-b', title: '드래그하여 높이 조정', onMouseDown: startResizeBottom }),
        (full || embedded) ? null : h('div', { className: 'rt-resize-c', title: '드래그하여 크기 조정', onMouseDown: startResizeCorner }),
        h('div', { className: 'rt-head', onMouseDown: (full || embedded) ? undefined : startDrag, title: (full || embedded) ? undefined : '누른 채로 드래그하여 패널 이동' },
          embedded ? null : h('div', { className: 'rt-title' }, h('span', { className: 'rt-dot' }),
            full ? '드릴 콘솔 · 전체 보기' : '드릴 콘솔',
            full ? h('span', { className: 'rt-tag', style: { marginLeft: 6 } }, '독립 창') : null),
          h('select', {
            className: 'rt-input rt-eng-select',
            style: { maxWidth: embedded ? '100%' : '170px', minWidth: embedded ? '160px' : undefined, flex: embedded ? '1 1 200px' : undefined },
            value: eng || '',
            onChange: (e) => {
              setEng(e.target.value)
              loadSnapshot(e.target.value)
              /* "현재 타깃" 동기화: 네이티브 skill 디렉터리가 이 값으로 스킬 루트를 해석한다 */
              api({ op: 'activateEngagement', engagement: e.target.value }).catch(() => {})
            },
          },
            h('option', { value: '', disabled: true }, engagements.length ? '타깃 선택' : '타깃 없음'),
            engagements.map((x) => h('option', { key: x.id, value: x.id }, x.name || x.id || '이름 없음')),
          ),
          h('div', { className: 'rt-spacer' }),
          embedded ? null : h(VersionBar, null),
          full ? h('button', { className: 'rt-btn', title: '사이드바가 있는 일반 화면으로 돌아가기(Esc 키도 가능)', onClick: exitFull }, '전체 보기 종료') : null,
          embedded ? null : h('button', { className: 'rt-btn', title: '명부, 스냅샷, 현재 페이지 데이터 새로고침', onClick: refreshAll }, '새로고침'),
          (full || embedded) ? null : h('button', { className: 'rt-btn', title: '새 브라우저 창에서 전체 콘솔 열기', onClick: openFull }, '전체 보기'),
          (full || embedded) ? null : h('button', { className: 'rt-btn', title: '패널 접기', onClick: () => setUI({ open: false }) }, '접기')),
        /* 탭 바는 표준 tablist/tab 역할을 사용한다: 스크린 리더가 "몇 번째 탭인지, 선택되었는지"를 읽어 준다.
           키보드 사용자가 Tab으로 들어온 뒤 Enter/Space로 전환할 수 있다(clickable이 제공). */
        h('div', { className: 'rt-tabs', role: 'tablist' }, tabs.map((t) => {
          const activate = () => {
            markTabSeen(t[0])
            setUI({ tab: t[0] })
            /* 현재 페이지가 강제로 다시 조회하게 해, 탭을 바꾼 뒤에도 이전 페이지 캐시가 보이지 않도록 한다 */
            setRefreshKey((k) => k + 1)
          }
          return h('div', Object.assign({}, clickable(activate, { label: t[1] }), {
            key: t[0], className: 'rt-tab' + (st.tab === t[0] ? ' on' : ''),
            role: 'tab',
            'aria-selected': st.tab === t[0] ? 'true' : 'false',
            title: unreadOf(t[0]) ? t[1] + ': 새 내용이 있습니다. 열어서 보면 빨간 점이 사라집니다' : t[1],
          }), t[1], unreadOf(t[0])
            /* 빨간 점은 순수 시각 정보이므로 스크린 리더용 텍스트 대체를 준다 */
            ? h('span', { className: 'rt-tab-dot', 'aria-label': '새 내용 있음' })
            : null)
        })),
        h('div', { className: 'rt-body', key: 'body-' + st.tab }, h(RtBoundary, { key: st.tab }, body)),
        h('div', { className: 'rt-foot' },
          h('span', null, 'C 세그먼트 ' + (stats.segments || 0)),
          h('span', null, '자산 ' + (stats.assets || 0) + '(활성 ' + (stats.liveAssets || 0) + ')'),
          h('span', null, '포트 ' + (stats.openPorts || 0)),
          h('span', null, '핑거프린트 ' + (stats.fingerprints || 0)),
          h('span', null, '취약점 ' + (stats.vulns || 0)),
          h('span', null, '수동/능동 ' + (stats.passiveSignals || 0) + '/' + (stats.activeSignals || 0)),
          h('div', { className: 'rt-spacer' }),
          full ? h('span', null, 'Esc를 누르거나 오른쪽 위 "전체 보기 종료"를 눌러 사이드바가 있는 화면으로 돌아갑니다') : null,
          h('span', null, 'SQLite · ' + (snapshot && snapshot.engagement ? snapshot.engagement.name : ''))))
    }

    /* ---------------------------------------------------------- 진입 버튼 */
    function SidebarButton(props) {
      const st = useUI()
      return h('button', {
        className: 'rt-icon-btn' + (st.open ? ' on' : ''),
        title: 'RedTeam 콘솔(오른쪽 사이드바 상주)',
        onClick: () => setUI({ open: !st.open }),
      }, h('span', { style: { fontSize: 14 } }, '⛨'), props.wide ? h('span', null, 'RedTeam') : null)
    }

    function HeaderButton() {
      const st = useUI()
      return h('button', {
        className: 'rt-hbtn' + (st.open ? ' on' : ''),
        title: 'RedTeam 콘솔(오른쪽 사이드바 상주)',
        onClick: () => setUI({ open: !st.open }),
      }, '⛨ RedTeam')
    }

    /** 사이드바 "전체 보기": 새 브라우저 창에서 전체 콘솔을 연다(현재 창은 영향 없음). */
    function FullButton(props) {
      const open = () => {
        try { window.open(window.location.href.split('#')[0] + '#redteam-full', '_blank', 'noopener') } catch { /* 브라우저에 의해 차단됨 */ }
      }
      return h('button', {
        className: 'rt-icon-btn',
        title: '전체 보기: 새 창에서 전체 콘솔 열기(현재 창은 영향 없음; 새 창에서 Esc로 종료)',
        onClick: open,
      }, h('span', { style: { fontSize: 14 } }, '⛶'), props.wide ? h('span', null, '전체 보기') : null)
    }

    /* ---------------------------------------------------------- 플러그인 진입 */
    /** 유일한 하드 의존성: 슬롯 레지스트리. */
    const inject = ['slots']

    /**
     * 스타일 주입 + 세 곳의 슬롯. 스타일 태그와 너비 변수는 fiber 언마운트와 함께 제거된다.
     * @param ctx - 클라이언트 루트 컨텍스트.
     */
    function applyDrillParts() {
      return { CSS: CSS, Panel: Panel, setUI: setUI, useUI: useUI, isFullWindow: isFullWindow, setDockWidth: setDockWidth };
    }

    exports.inject = inject
			return applyDrillParts();
		})();
/* __DSH_PURGE_DRILL_END__ */

		const AUTH_KEY = "dsh-purge-drill-auth";
		const WELCOME_KEY = "dsh-purge-user-notice-v1";
		let drillGrantGen = 0;
		let drillGrantPosting = 0;
		let drillGrantState = { ready: false, granted: false };
		let drillSyncRetryTimer = null;

		function readWelcomeAck() {
			/* 이 포크는 첫 실행 안내 창으로 UI 를 막지 않는다: 항상 확인된 것으로 본다. */
			return true;
		}
		function writeWelcomeAck() {
			try { window.localStorage.setItem(WELCOME_KEY, "1"); } catch { /* ignore */ }
		}

		function readDrillAuth() {
			/* 드릴 콘솔 승인 창은 이 포크에서 게이트로 쓰지 않는다: 콘솔은 항상 열린 상태로 취급하고,
			   서버 기록(/dsh-purge/drill-grant)은 아래 writeDrillAuth 경로가 그대로 유지한다. */
			return true;
		}
		function setDrillAuthLocal(ok) {
			try {
				if (ok) window.localStorage.setItem(AUTH_KEY, "1");
				else window.localStorage.removeItem(AUTH_KEY);
			} catch { /* ignore */ }
			drillGrantState = { ready: true, granted: !!ok };
		}
		function writeDrillAuth(ok) {
			drillGrantGen += 1;
			const gen = drillGrantGen;
			setDrillAuthLocal(ok);
			if (!ok) return;
			drillGrantPosting += 1;
			fetch("/dsh-purge/drill-grant", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: "{}",
			}).then((r) => r.json()).then((saved) => {
				if (gen !== drillGrantGen) return;
				setDrillAuthLocal(!!(saved && saved.granted));
			}).catch(() => { /* 페이지가 먼저 기억하고, 다음 동기화 때 현재 설치 디렉터리에 기록한다 */ })
				.finally(() => { drillGrantPosting = Math.max(0, drillGrantPosting - 1); });
		}
		function syncDrillGrant(attempt) {
			const n = attempt || 0;
			const gen = drillGrantGen;
			/* 지난번에 예약한 재시도 timer를 되돌려, writeDrillAuth가 여러 번 겹쳐 체인을 만들지 않게 한다 */
			if (drillSyncRetryTimer) { try { clearTimeout(drillSyncRetryTimer); } catch { /* ignore */ } drillSyncRetryTimer = null; }
			fetch("/dsh-purge/drill-grant", { method: "GET" })
				.then((r) => r.json())
				.then((r) => {
					if (gen !== drillGrantGen) return;
					if (!r || r.ok === false) throw new Error("grant");
					if (r.granted) {
						setDrillAuthLocal(true);
						if (dockBus.authOpen) setDock({ authOpen: false });
						return;
					}
					if (drillGrantPosting > 0) return;
					setDrillAuthLocal(false);
					if (dockBus.authOpen || dockBus.tab === "drill") {
						setDock({ open: true, tab: "drill", authOpen: false, pending: dockBus.pending || "tab" });
					}
				})
				.catch(() => {
					if (gen !== drillGrantGen) return;
					if (n < 5) {
						drillSyncRetryTimer = window.setTimeout(() => {
							drillSyncRetryTimer = null;
							syncDrillGrant(n + 1);
						}, 400);
					}
				});
		}

		let dockBus = { open: false, tab: "clean", authOpen: false, pending: "tab", listeners: new Set() };
		function getDock() { return dockBus; }
		function setDock(patch) {
			dockBus = Object.assign({}, dockBus, patch);
			dockBus.listeners.forEach((fn) => { try { fn(dockBus); } catch { /* ignore */ } });
		}
		function useDock() {
			const [st, setSt] = useState(dockBus);
			useEffect(() => {
				const fn = (next) => setSt(next);
				dockBus.listeners.add(fn);
				return () => { dockBus.listeners.delete(fn); };
			}, []);
			return st;
		}

		function requestDrill(kind) {
			const pending = kind || "tab";
			const openEnv = () => {
				try {
					if (__dshPurgeDrill && __dshPurgeDrill.setUI) {
						__dshPurgeDrill.setUI({ open: true, tab: "env" });
					}
				} catch { /* ignore */ }
			};
			if (readDrillAuth()) {
				setDock({ open: true, tab: "drill", authOpen: false, pending: "tab" });
				try { if (__dshPurgeDrill && __dshPurgeDrill.setUI) __dshPurgeDrill.setUI({ open: true }); } catch { /* ignore */ }
				if (pending === "env") openEnv();
				if (pending === "full") {
					try { window.open(window.location.href.split("#")[0] + "#redteam-full", "_blank", "noopener"); } catch { /* ignore */ }
				}
				return;
			}
			/* 미승인: 드릴 콘솔 탭으로 바로 전환하고 승인 창을 띄운다 (더 이상 정리 페이지에 머물지 않아 '아무 일도 없음'처럼 보이지 않는다) */
			setDock({ open: true, tab: "drill", authOpen: false, pending: pending });
		}

		function requestDrillEnv() {
			requestDrill("env");
		}

		function openDockClean() {
			setDock({ open: true, tab: "clean", authOpen: false, pending: "tab" });
		}
		function toggleDock() {
			if (dockBus.open) setDock({ open: false, authOpen: false, pending: "tab" });
			else openDockClean();
		}
		syncDrillGrant();

		const DOCK_GEOM_KEY = "dsh-purge-dock-geom-v4";
		/* 기본은 오른쪽 위, 하단은 입력 상자 위에 둔다. 드래그 후에는 사용자가 놓은 위치에 머물고, 창 밖으로 나가지 않게만 보장한다. */
		const DOCK_COMPOSER_CLEAR = 172;
		function defaultDockGeom() {
			const vw = typeof window !== "undefined" ? window.innerWidth : 1280;
			const vh = typeof window !== "undefined" ? window.innerHeight : 800;
			const w = Math.min(620, Math.max(380, vw - 16));
			const y = 48;
			const h = Math.max(240, Math.min(640, vh - y - DOCK_COMPOSER_CLEAR));
			return { x: Math.max(8, vw - w - 8), y: y, w: w, h: h };
		}
		function clampDockGeom(g) {
			const vw = typeof window !== "undefined" ? window.innerWidth : 1280;
			const vh = typeof window !== "undefined" ? window.innerHeight : 800;
			const w = Math.min(Math.max(380, Number(g && g.w) || 620), Math.max(380, vw - 16));
			const h = Math.min(Math.max(240, Number(g && g.h) || 520), Math.max(240, vh - 16));
			const x = Math.min(Math.max(8, Number(g && g.x) || 8), Math.max(8, vw - w - 8));
			const y = Math.min(Math.max(8, Number(g && g.y) || 8), Math.max(8, vh - Math.min(h, vh - 16) - 8));
			return { x: x, y: y, w: w, h: h };
		}
		function loadDockGeom() {
			try {
				const raw = JSON.parse(window.localStorage.getItem(DOCK_GEOM_KEY) || "null");
				if (raw && typeof raw === "object") return clampDockGeom(raw);
			} catch { /* ignore */ }
			return clampDockGeom(defaultDockGeom());
		}
		function saveDockGeom(g) {
			try { window.localStorage.setItem(DOCK_GEOM_KEY, JSON.stringify(clampDockGeom(g))); } catch { /* ignore */ }
		}

		function WelcomeNotice() {
			const t = useT();
			const [open, setOpen] = useState(() => !readWelcomeAck());
			const [checked, setChecked] = useState(false);
			if (!open) return null;
			const repo = t("welcome.repo");
			const node = h("div", { className: "dshp-auth-mask", role: "dialog", "aria-modal": "true" },
				h("div", { className: "dshp-auth-modal", style: { width: "min(560px,100%)" } },
					h("h2", null, t("welcome.title")),
					h("div", { className: "muted", style: { color: "var(--dsw-alias-label-secondary,#999)", fontSize: 12 } }, t("welcome.lead")),
					h("div", { className: "dshp-auth-warn" }, t("welcome.warn")),
					h("div", { className: "dshp-auth-legal", style: { height: "auto", maxHeight: 280 } },
						h("p", null, t("welcome.body")),
						h("p", null,
							h("a", {
								href: repo,
								target: "_blank",
								rel: "noopener noreferrer",
								style: { color: "var(--dsw-alias-label-brand, #8fbf9a)", wordBreak: "break-all" },
							}, repo),
						),
						h("h3", null, t("welcome.bans")),
						h("p", null, t("welcome.ban1")),
						h("p", null, t("welcome.ban2")),
						h("p", null, t("welcome.ban3")),
					),
					h("div", { className: "dshp-auth-checks" },
						h("label", null,
							h("input", {
								type: "checkbox",
								checked: checked,
								onChange: (e) => setChecked(!!(e && e.target && e.target.checked)),
							}),
							h("span", null, t("welcome.check")),
						),
					),
					h("div", { className: "dshp-auth-ops" },
						h("button", {
							type: "button",
							className: "primary",
							disabled: !checked,
							onClick: () => {
								if (!checked) return;
								writeWelcomeAck();
								setOpen(false);
							},
						}, t("welcome.ok")),
					),
				),
			);
			try {
				const rd = require("react-dom");
				if (rd && typeof rd.createPortal === "function" && typeof document !== "undefined" && document.body) {
					return rd.createPortal(node, document.body);
				}
			} catch { /* ignore */ }
			return node;
		}

		function AuthGate(props) {
			const t = useT();
			const [left, setLeft] = useState(10);
			const [readEnd, setReadEnd] = useState(false);
			const [checks, setChecks] = useState({ read: false, scope: false, ban: false });
			const legalRef = useRef(null);
			useEffect(() => {
				const id = window.setInterval(() => {
					setLeft((n) => {
						if (n <= 1) { window.clearInterval(id); return 0; }
						return n - 1;
					});
				}, 1000);
				return () => window.clearInterval(id);
			}, []);
			useEffect(() => {
				const el = legalRef.current;
				if (!el) return;
				if (el.scrollHeight <= el.clientHeight + 4) setReadEnd(true);
			}, []);
			const locked = left > 0 || !readEnd;
			const ready = !locked && checks.read && checks.scope && checks.ban;
			const hint = left > 0
				? t("auth.hint.wait").replace("{n}", String(left))
				: (readEnd ? t("auth.hint.check") : t("auth.hint.scroll"));
			const onScroll = () => {
				const el = legalRef.current;
				if (!el) return;
				if (el.scrollTop + el.clientHeight >= el.scrollHeight - 8) setReadEnd(true);
			};
			const toggle = (id) => {
				if (locked) return;
				setChecks((prev) => Object.assign({}, prev, { [id]: !prev[id] }));
			};
			const okLabel = !ready
				? t("auth.ok")
				: (props.pending === "full"
					? t("auth.ok.full")
					: (props.pending === "env" ? t("auth.ok.env") : t("auth.ok.tab")));
			return h("div", { className: "dshp-auth-mask", role: "dialog", "aria-modal": "true" },
				h("div", { className: "dshp-auth-modal" },
					h("h2", null, t("auth.title")),
					h("div", { className: "muted", style: { color: "var(--dsw-alias-label-secondary,#999)", fontSize: 12 } }, t("auth.lead")),
					h("div", { className: "dshp-auth-warn" }, t("auth.warn")),
					h("div", {
						className: "dshp-auth-legal",
						ref: legalRef,
						onScroll,
					}, "이 포크에는 승인 고지가 없다. 드릴 콘솔은 바로 열린다."),
					h("div", { style: { color: "var(--dsw-alias-label-secondary,#999)", fontSize: 12 } }, hint),
					h("div", { className: "dshp-auth-checks" },
						[["read", "auth.check.read"], ["scope", "auth.check.scope"], ["ban", "auth.check.ban"]].map((row) =>
							h("label", { key: row[0], className: locked ? "locked" : "" },
								h("input", {
									type: "checkbox",
									checked: !!checks[row[0]],
									disabled: locked,
									onChange: () => toggle(row[0]),
								}),
								h("span", null, t(row[1])),
							),
						),
					),
					h("div", { className: "dshp-auth-ops" },
						h("button", { type: "button", onClick: () => setDock({ authOpen: false, tab: "clean", pending: "tab" }) }, t("auth.no")),
						h("button", {
							type: "button",
							className: "primary",
							disabled: !ready,
							onClick: () => {
								if (!ready) return;
								writeDrillAuth(true);
								const kind = props.pending || "tab";
								setDock({ authOpen: false, open: true, tab: "drill", pending: "tab" });
								try { if (__dshPurgeDrill && __dshPurgeDrill.setUI) __dshPurgeDrill.setUI({ open: true }); } catch { /* ignore */ }
								if (kind === "env") {
									try { if (__dshPurgeDrill && __dshPurgeDrill.setUI) __dshPurgeDrill.setUI({ open: true, tab: "env" }); } catch { /* ignore */ }
								}
								if (kind === "full") {
									try { window.open(window.location.href.split("#")[0] + "#redteam-full", "_blank", "noopener"); } catch { /* ignore */ }
								}
							},
						}, okLabel),
					),
				),
			);
		}

		function isRedteamPresetId(value) {
			const text = String(value || "").trim();
			if (!text) return false;
			if (text === "redteam") return true;
			if (/^red[\s_-]*team$/i.test(text)) return true;
			const label = text.replace(/\u4e0d\u662f\u7ea2\u961f|레드팀 아님/g, "").replace(/\u975e\u7ea2\u961f|레드팀 아님/g, "");
			if (/\u7ea2\u961f|레드팀/.test(label)) return true;
			return false;
		}

		function readSessionAgentPreset(sess) {
			if (!sess || typeof sess !== "object") return "";
			try {
				const pv = sess.projectionValues;
				if (pv && typeof pv.agentPreset === "string") return pv.agentPreset;
			} catch { /* ignore */ }
			try {
				if (typeof sess.agentPreset === "string") return sess.agentPreset;
			} catch { /* ignore */ }
			try {
				const header = sess.header;
				if (header && typeof header.agentPreset === "string") return header.agentPreset;
			} catch { /* ignore */ }
			return "";
		}

		function readSessionCwd(sess) {
			if (!sess || typeof sess !== "object") return "";
			try {
				const pv = sess.projectionValues;
				if (pv && typeof pv.cwd === "string" && pv.cwd.trim()) return pv.cwd.trim();
			} catch { /* ignore */ }
			try {
				if (typeof sess.cwd === "string" && sess.cwd.trim()) return sess.cwd.trim();
			} catch { /* ignore */ }
			try {
				const header = sess.header;
				if (header && typeof header.cwd === "string" && header.cwd.trim()) return header.cwd.trim();
			} catch { /* ignore */ }
			return "";
		}

		function clientCurrentCwd() {
			try {
				const sessions = rewindSessions || (rewindHost && rewindHost.sessions);
				if (!sessions) return "";
				const sid = currentSessionId(sessions);
				if (!sid) return "";
				try {
					const snap = typeof sessions.list?.getSnapshot === "function" ? sessions.list.getSnapshot() : null;
					const sess = snap && snap.byId ? snap.byId[sid] : null;
					const found = readSessionCwd(sess);
					if (found) return found;
				} catch { /* ignore */ }
				try {
					const actx = typeof sessions.scope === "function" ? sessions.scope(sid) : undefined;
					const face = typeof sessions.sessionOf === "function" ? sessions.sessionOf(actx) : undefined;
					const faceSnap = face && typeof face.getSnapshot === "function" ? face.getSnapshot() : face;
					const found = readSessionCwd(faceSnap);
					if (found) return found;
				} catch { /* ignore */ }
			} catch { /* ignore */ }
			return "";
		}

		function isRedteamModeActive() {
			try {
				const sessions = rewindSessions || (rewindHost && rewindHost.sessions);
				const sid = currentSessionId(sessions);
				if (sid && sessions) {
					try {
						const snap = typeof sessions.list?.getSnapshot === "function" ? sessions.list.getSnapshot() : null;
						const sess = snap && snap.byId ? snap.byId[sid] : null;
						if (isRedteamPresetId(readSessionAgentPreset(sess))) return true;
					} catch { /* ignore */ }
					try {
						const actx = typeof sessions.scope === "function" ? sessions.scope(sid) : undefined;
						const face = typeof sessions.sessionOf === "function" ? sessions.sessionOf(actx) : undefined;
						const faceSnap = face && typeof face.getSnapshot === "function" ? face.getSnapshot() : face;
						if (isRedteamPresetId(readSessionAgentPreset(faceSnap))) return true;
					} catch { /* ignore */ }
				}
			} catch { /* ignore */ }
			/* 새 세션: 모드 드롭다운의 '레드팀 모드' chip (골랐지만 아직 session에 쓰지 않음)
			 * 시맨틱 data-* 연결점을 우선하고, 그다음 class 부분 문자열 퍼지 매칭 + 텍스트 폴백;
			 * CSS Module 해시(HKgFRW_seat 같은, 빌드마다 바뀜)를 하드코딩하지 않는다. */
			try {
				const semantic = document.querySelector(
					"[data-agent-preset='redteam'], [data-preset-id='redteam'], [data-mode='redteam']"
				);
				if (semantic) return true;
				const nodes = document.querySelectorAll(
					"[class*='seat' i][class*='label' i], [class*='seatLabel' i], button[class*='seat' i], [role='button'][class*='seat' i]"
				);
				for (const el of nodes) {
					const text = String(el.textContent || "").replace(/\s+/g, " ").trim();
					if (/\u7ea2\u961f\u6a21\u5f0f|레드팀 모드/.test(text) || /^RedTeam\b/i.test(text)) return true;
				}
			} catch { /* ignore */ }
			try {
				/* Match the mode label in either language; the Chinese title is rebuilt from
				 * code points so this file does not hardcode CJK literals. */
				const zhRedTeamLabel = String.fromCharCode(0x7ea2, 0x961f);
				const labels = document.querySelectorAll(
					"[class*='label' i][class*='preset' i], [class*='presetLabel' i], [title*='" + zhRedTeamLabel + "'], [title*='Red team' i], [title*='RedTeam' i]"
				);
				for (const el of labels) {
					const text = String(el.textContent || "").trim();
					if (/\u7ea2\u961f\u6a21\u5f0f|레드팀 모드/.test(text) || /^RedTeam\b/i.test(text)) return true;
					if (isRedteamPresetId(text)) return true;
				}
			} catch { /* ignore */ }
			return false;
		}

		function looksLikeSendControl(el) {
			if (!el || el.nodeType !== 1) return false;
			const btn = el.closest("button, [role='button']");
			if (!btn) return false;
			if (btn.closest(".dshp-dock, .dshp-auth-mask, .rt-dock, .dshp-env-gate")) return false;
			const label = [
				btn.getAttribute("aria-label"),
				btn.getAttribute("title"),
				btn.getAttribute("data-testid"),
				btn.textContent,
			].filter(Boolean).join(" ");
			if (/\u505c\u6b62|정지|Stop/i.test(label) && !/\u53d1\u9001|전송|Send/i.test(label)) return false;
			if (/\u53d1\u9001|전송|Submit|Send(?!\s*feedback)/i.test(label)) return true;
			/* composer 주 버튼: data-composer-card 안의 primary */
			try {
				const card = btn.closest("[data-composer-card], [data-composer-seat]");
				if (card) {
					const cls = String(btn.className || "");
					if (/primary/i.test(cls) && btn.querySelector("svg")) return true;
				}
			} catch { /* ignore */ }
			if (btn.type === "submit") {
				const form = btn.closest("form");
				if (form && form.querySelector("textarea, [contenteditable='true']")) return true;
			}
			return false;
		}

		function fetchEnvAdaptStatus() {
			return fetch("/redteam/api", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ op: "platformEnvAdaptStatus" }),
			}).then((r) => r.json()).catch(() => null);
		}

		/** 동기 탐색의 자리표시자: 더 이상 동기 XHR을 하지 않는다 (UI 메인 스레드를 막고, Chrome도 단계적으로 폐기).
		 * 호출자 mustBlockSubmit은 cache가 만료/누락이면 "알 수 없음→보수적 block"으로 처리하고,
		 * 동시에 EnvAdaptSendGate의 useEffect 폴링이 비동기 refresh하므로, 다음 호출에는 통과된다. */
		function fetchEnvAdaptStatusSync() { return null; }

		/** 레드팀 전송 전 게이트: 미준비 → 승인하고 환경 적응 열기; 확인 후 건너뛰기 가능. */
		function EnvAdaptSendGate() {
			const t = useT();
			const [open, setOpen] = useState(false);
			const [confirmSkip, setConfirmSkip] = useState(false);
			const [status, setStatus] = useState(null);
			const [busy, setBusy] = useState(false);
			const cacheRef = useRef({ at: 0, ready: false });
			const openRef = useRef(false);
			openRef.current = open;

			const refresh = useCallback(async () => {
				const r = await fetchEnvAdaptStatus();
				const ready = !!(r && r.ready);
				cacheRef.current = { at: Date.now(), ready: ready, skipped: !!(r && r.skipped) };
				setStatus(r);
				return r;
			}, []);

			const blockAndOpen = useCallback(() => {
				setConfirmSkip(false);
				refresh();
				/* 첫 번째: 전체 승인 창만 거친다 → 승인 후 환경 적응 페이지로 */
				if (!readDrillAuth()) {
					setOpen(false);
					requestDrillEnv();
					return true;
				}
				/* 승인 이력 있음: 간소화된 환경 적응 창만 띄우고, 드릴 콘솔 전체를 자동으로 펼치지 않는다 */
				setOpen(true);
				return true;
			}, [refresh]);

			const mustBlockSubmit = useCallback(() => {
				/* 이 포크는 전송을 가로막지 않는다: 예전에는 레드팀 모드에서 환경 적응이 준비되지 않았다고 판단되면
				   shell.submit 을 삼켰다(전송 자체가 사라짐). 이제는 상태를 참고만 하고 항상 전송한다. */
				return false;
			}, []);

			/* 호스트의 SessionInputShell.submit에 걸어 둔다 —— 버튼 클릭 휴리스틱보다 신뢰할 만하다.
			 * patch는 반드시 되돌릴 수 있어야 한다: origSubmit을 WeakMap에 저장하고, unmount / 의존성 변경 시 복원한다,
			 * 그렇지 않으면 플러그인을 끈 뒤에도 shell.submit이 우리 wrapper로 남아 mustBlockSubmit 클로저를 붙들고 있게 된다. */
			useEffect(() => {
				const patched = new WeakMap();
				const patchedShells = [];
				const patchShell = (shell) => {
					if (!shell || patched.has(shell)) return;
					if (typeof shell.submit !== "function") return;
					const origSubmit = shell.submit;
					patched.set(shell, { origSubmit });
					patchedShells.push(shell);
					const bound = origSubmit.bind(shell);
					shell.submit = function gatedSubmit(mode) {
						try {
							if (mustBlockSubmit()) return;
						} catch { /* 게이트 예외 시 전송을 삼키지 않는다 */ }
						return bound(mode);
					};
				};
				const tick = () => {
					try {
						const sessions = rewindSessions || (rewindHost && rewindHost.sessions);
						const sid = currentSessionId(sessions);
						if (!sid) return;
						patchShell(conversationInput(sid));
					} catch { /* ignore */ }
				};
				tick();
				const iv = window.setInterval(tick, 400);
				return () => {
					window.clearInterval(iv);
					for (const shell of patchedShells) {
						const info = patched.get(shell);
						if (!info) continue;
						try { shell.submit = info.origSubmit; } catch { /* ignore */ }
					}
					patchedShells.length = 0;
				};
			}, [mustBlockSubmit]);

			useEffect(() => {
				let alive = true;
				const tick = () => {
					if (!alive) return;
					if (!isRedteamModeActive()) return;
					refresh();
				};
				tick();
				const iv = window.setInterval(tick, 5000);
				return () => { alive = false; window.clearInterval(iv); };
			}, [refresh]);

			useEffect(() => {
				const onPointer = (e) => {
					if (!looksLikeSendControl(e.target)) return;
					if (!mustBlockSubmit()) return;
					e.preventDefault();
					e.stopPropagation();
					if (typeof e.stopImmediatePropagation === "function") e.stopImmediatePropagation();
				};
				const onKey = (e) => {
					if (e.key !== "Enter" || e.shiftKey || e.isComposing) return;
					const inComposer = e.target && e.target.closest
						&& e.target.closest("[data-composer-card], [data-composer-seat], [contenteditable='true'], textarea");
					if (!inComposer) return;
					if (e.target.closest && e.target.closest(".dshp-dock, .dshp-auth-mask, .rt-dock, .dshp-env-gate")) return;
					if (!mustBlockSubmit()) return;
					e.preventDefault();
					e.stopPropagation();
					if (typeof e.stopImmediatePropagation === "function") e.stopImmediatePropagation();
				};
				document.addEventListener("pointerdown", onPointer, true);
				document.addEventListener("click", onPointer, true);
				document.addEventListener("keydown", onKey, true);
				return () => {
					document.removeEventListener("pointerdown", onPointer, true);
					document.removeEventListener("click", onPointer, true);
					document.removeEventListener("keydown", onKey, true);
				};
			}, [mustBlockSubmit]);

			if (!open) return null;

			const message = (status && status.message) || t("envGate.lead");
			return h("div", { className: "dshp-auth-mask dshp-env-gate", role: "dialog", "aria-modal": "true" },
				h("div", { className: "dshp-auth-modal", style: { width: "min(480px,100%)" } },
					h("h2", null, t("envGate.title")),
					h("div", { style: { fontSize: 13, lineHeight: 1.55 } }, message),
					h("div", { style: { fontSize: 12, color: "var(--dsw-alias-label-secondary,#999)", lineHeight: 1.5 } }, t("envGate.kaliHint")),
					confirmSkip
						? h("div", { className: "dshp-auth-warn" }, t("envGate.skipConfirm"))
						: null,
					h("div", { className: "dshp-auth-ops" },
						confirmSkip
							? [
								h("button", {
									key: "no",
									type: "button",
									onClick: () => setConfirmSkip(false),
								}, t("envGate.skipNo")),
								h("button", {
									key: "yes",
									type: "button",
									className: "primary",
									disabled: busy,
									onClick: () => {
										setBusy(true);
										fetch("/redteam/api", {
											method: "POST",
											headers: { "content-type": "application/json" },
											body: JSON.stringify({ op: "platformEnvAdaptSkip", skip: true }),
										}).then((r) => r.json()).then((r) => {
											setBusy(false);
											cacheRef.current = { at: Date.now(), ready: true, skipped: true };
											setStatus(r);
											setOpen(false);
											setConfirmSkip(false);
										}).catch(() => {
											setBusy(false);
											cacheRef.current = { at: Date.now(), ready: true, skipped: true };
											setOpen(false);
										});
									},
								}, t("envGate.skipYes")),
							]
							: [
								h("button", {
									key: "skip",
									type: "button",
									onClick: () => setConfirmSkip(true),
								}, t("envGate.skip")),
								h("button", {
									key: "go",
									type: "button",
									className: "primary",
									onClick: () => {
										setOpen(false);
										requestDrillEnv();
									},
								}, t("envGate.go")),
							],
					),
				),
			);
		}

		function PurgeDock() {
			const t = useT();
			const st = useDock();
			const [geom, setGeom] = useState(() => loadDockGeom());
			const [dockTheme, setDockTheme] = useState(detectHostTheme);
			useEffect(() => {
				const sync = () => setDockTheme(detectHostTheme());
				sync();
				const obs = new MutationObserver(sync);
				if (document.body) obs.observe(document.body, { attributes: true, attributeFilter: ["data-ds-dark-theme", "class", "style"] });
				obs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-ds-dark-theme", "class", "style"] });
				const timer = window.setInterval(sync, 1500);
				return () => { obs.disconnect(); window.clearInterval(timer); };
			}, []);
			useEffect(() => {
				let uiTag = document.querySelector('style[data-dsh-purge-ui="1"]');
				if (!uiTag) {
					uiTag = document.createElement("style");
					uiTag.setAttribute("data-dsh-purge-ui", "1");
					uiTag.textContent = PURGE_CSS;
					document.head.append(uiTag);
				}
				if (!__dshPurgeDrill || !__dshPurgeDrill.CSS) return undefined;
				const styleTag = document.createElement("style");
				styleTag.setAttribute("data-dsh-purge-drill", "1");
				styleTag.textContent = __dshPurgeDrill.CSS;
				document.head.append(styleTag);
				const widthTag = document.createElement("style");
				widthTag.setAttribute("data-dsh-purge-dock-w", "1");
				widthTag.textContent = ":root{--dshp-dock-w:" + geom.w + "px;--dshp-dock-h:" + geom.h + "px}";
				document.head.append(widthTag);
				return () => { styleTag.remove(); widthTag.remove(); };
			}, []);
			useEffect(() => {
				saveDockGeom(geom);
				const tag = document.querySelector('style[data-dsh-purge-dock-w="1"]');
				if (tag) tag.textContent = ":root{--dshp-dock-w:" + geom.w + "px;--dshp-dock-h:" + geom.h + "px}";
			}, [geom]);
			useEffect(() => {
				const onResize = () => setGeom((g) => clampDockGeom(g));
				window.addEventListener("resize", onResize);
				return () => window.removeEventListener("resize", onResize);
			}, []);
			useEffect(() => {
				if (st.tab === "drill" && readDrillAuth() && __dshPurgeDrill && __dshPurgeDrill.setUI) {
					try { __dshPurgeDrill.setUI({ open: true }); } catch { /* ignore */ }
				}
			}, [st.tab, st.open]);
			const onTab = (id) => {
				if (id === "drill") { requestDrill("tab"); return; }
				setDock({ tab: "clean", authOpen: false, pending: "tab" });
			};
			const startDrag = (e) => {
				if (e.button !== 0) return;
				if (e.target && e.target.closest && e.target.closest("button,a,input,select,textarea,label")) return;
				e.preventDefault();
				const sx = e.clientX;
				const sy = e.clientY;
				const ox = geom.x;
				const oy = geom.y;
				const move = (ev) => setGeom((g) => clampDockGeom({ x: ox + (ev.clientX - sx), y: oy + (ev.clientY - sy), w: g.w, h: g.h }));
				const up = () => {
					window.removeEventListener("mousemove", move);
					window.removeEventListener("mouseup", up);
				};
				window.addEventListener("mousemove", move);
				window.addEventListener("mouseup", up);
			};
			const startResize = (e) => {
				if (e.button !== 0) return;
				e.preventDefault();
				e.stopPropagation();
				const sx = e.clientX;
				const sy = e.clientY;
				const ow = geom.w;
				const oh = geom.h;
				const move = (ev) => setGeom((g) => clampDockGeom({ x: g.x, y: g.y, w: ow + (ev.clientX - sx), h: oh + (ev.clientY - sy) }));
				const up = () => {
					window.removeEventListener("mousemove", move);
					window.removeEventListener("mouseup", up);
				};
				window.addEventListener("mousemove", move);
				window.addEventListener("mouseup", up);
			};
			const startResizeLeft = (e) => {
				if (e.button !== 0) return;
				e.preventDefault();
				e.stopPropagation();
				const sx = e.clientX;
				const ox = geom.x;
				const ow = geom.w;
				const move = (ev) => {
					const dx = ev.clientX - sx;
					setGeom((g) => clampDockGeom({ x: ox + dx, y: g.y, w: ow - dx, h: g.h }));
				};
				const up = () => {
					window.removeEventListener("mousemove", move);
					window.removeEventListener("mouseup", up);
				};
				window.addEventListener("mousemove", move);
				window.addEventListener("mouseup", up);
			};
			const startResizeRight = (e) => {
				if (e.button !== 0) return;
				e.preventDefault();
				e.stopPropagation();
				const sx = e.clientX;
				const ow = geom.w;
				const move = (ev) => setGeom((g) => clampDockGeom({ x: g.x, y: g.y, w: ow + (ev.clientX - sx), h: g.h }));
				const up = () => {
					window.removeEventListener("mousemove", move);
					window.removeEventListener("mouseup", up);
				};
				window.addEventListener("mousemove", move);
				window.addEventListener("mouseup", up);
			};
			const startResizeBottom = (e) => {
				if (e.button !== 0) return;
				e.preventDefault();
				e.stopPropagation();
				const sy = e.clientY;
				const oh = geom.h;
				const move = (ev) => setGeom((g) => clampDockGeom({ x: g.x, y: g.y, w: g.w, h: oh + (ev.clientY - sy) }));
				const up = () => {
					window.removeEventListener("mousemove", move);
					window.removeEventListener("mouseup", up);
				};
				window.addEventListener("mousemove", move);
				window.addEventListener("mouseup", up);
			};
			const body = st.tab === "clean"
				? h(SettingsRoot, { t })
				: (readDrillAuth() && __dshPurgeDrill.Panel
					? h(__dshPurgeDrill.Panel, { embedded: true })
					: h("div", { style: { padding: 16, color: "var(--dsw-alias-label-secondary)" } }, t("dock.unauthorized")));
			const panel = h("div", {
				className: "dshp-dock",
				"data-theme": dockTheme === "white" ? "white" : "dusk",
				"data-open": st.open ? "1" : "0",
				style: {
					left: geom.x + "px",
					top: geom.y + "px",
					right: "auto",
					bottom: "auto",
					width: geom.w + "px",
					height: geom.h + "px",
				},
			},
				h("div", { className: "dshp-dock-head", onMouseDown: startDrag, title: "Drag to move the panel" },
					h("b", null, "dsh-purge"),
					h("span", { style: { flex: 1 } }),
					st.tab === "drill" && readDrillAuth()
						? h("button", { type: "button", onClick: () => requestDrill("full") }, t("dock.full"))
						: null,
					h("button", { type: "button", onClick: () => setDock({ open: false, authOpen: false, tab: "clean", pending: "tab" }) }, t("dock.close")),
				),
				h("div", { className: "dshp-dock-tabs", role: "tablist" },
					h("button", {
						type: "button",
						className: "dshp-dock-tab" + (st.tab === "clean" ? " on" : ""),
						role: "tab",
						"aria-selected": st.tab === "clean" ? "true" : "false",
						onClick: () => onTab("clean"),
					}, t("dock.clean")),
					h("button", {
						type: "button",
						className: "dshp-dock-tab" + (st.tab === "drill" ? " on" : ""),
						role: "tab",
						"aria-selected": st.tab === "drill" ? "true" : "false",
						onClick: () => onTab("drill"),
					}, t("dock.drill") + (readDrillAuth() ? "" : " · " + t("dock.unauthorized"))),
				),
				h("div", { className: "dshp-dock-body" }, body),
				h("div", { className: "dshp-dock-resize-l", title: "Drag to resize width", onMouseDown: startResizeLeft }),
				h("div", { className: "dshp-dock-resize-r", title: "Drag to resize width", onMouseDown: startResizeRight }),
				h("div", { className: "dshp-dock-resize-b", title: "Drag to resize height", onMouseDown: startResizeBottom }),
				h("div", { className: "dshp-dock-resize", title: "Drag to resize", onMouseDown: startResize }),
			);
			let portal = null;
			let authPortal = null;
			const authNode = st.authOpen ? h(AuthGate, { pending: st.pending }) : null;
			try {
				const rd = require("react-dom");
				if (rd && typeof rd.createPortal === "function" && typeof document !== "undefined" && document.body) {
					portal = rd.createPortal(panel, document.body);
					if (authNode) authPortal = rd.createPortal(authNode, document.body);
				}
			} catch { /* host가 react-dom을 노출하지 않았을 수 있음 */ }
			return h(react.Fragment, null,
				portal || panel,
				authPortal || authNode,
			);
		}

		function isAutoPushedFlexChild(el) {
			if (!el || el.nodeType !== 1) return false;
			if (/heroOptions/i.test(String(el.className || ""))) return true;
			try {
				return window.getComputedStyle(el).marginLeft === "auto";
			} catch {
				return false;
			}
		}

		/** 워크스페이스/모드 뒤에 붙인다; heroOptions(margin-left:auto) 뒤에 두면 새 세션에서 칩이 행 끝으로 밀린다. */
		function placeHeroChip(row, el) {
			if (!row || !el) return;
			let auto = null;
			for (let i = 0; i < row.children.length; i += 1) {
				const kid = row.children[i];
				if (kid !== el && isAutoPushedFlexChild(kid)) {
					auto = kid;
					break;
				}
			}
			if (auto) {
				if (el.nextElementSibling !== auto) row.insertBefore(el, auto);
				return;
			}
			if (el.parentNode !== row || row.lastElementChild !== el) row.appendChild(el);
		}

		/** 마지막 대화 탭 바로 옆에 붙인다, 행 끝에 append 하지 않는다. */
		function placeTabChip(row, el) {
			if (!row || !el) return;
			const tabs = row.querySelectorAll(":scope > [role='tab']");
			const last = tabs[tabs.length - 1];
			if (last) {
				if (el.previousElementSibling !== last) last.after(el);
				return;
			}
			if (el.parentNode !== row) row.appendChild(el);
		}

		function hasInlinePurgeEntry() {
			if (typeof document === "undefined") return false;
			const chipBtns = document.querySelectorAll(".dshp-hero-chip-btn, .dshp-tab-btn");
			for (let i = 0; i < chipBtns.length; i += 1) {
				const btn = chipBtns[i];
				if (!btn || (btn.closest && btn.closest(".dshp-dock, .dshp-launch"))) continue;
				if (btn.offsetParent || (btn.getClientRects && btn.getClientRects().length)) return true;
			}
			const nodes = document.querySelectorAll("button, [role='tab'], [role='button'], [class*='chip']");
			for (let i = 0; i < nodes.length; i += 1) {
				const el = nodes[i];
				if (!el || el.classList.contains("dshp-launch")) continue;
				if (el.closest && el.closest(".dshp-dock, .dshp-launch")) continue;
				if (String(el.textContent || "").trim() === "dsh-purge") return true;
			}
			return false;
		}

		function PurgeLauncher() {
			const t = useT();
			const st = useDock();
			const [hide, setHide] = useState(hasInlinePurgeEntry);
			useEffect(() => {
				const sync = () => setHide(hasInlinePurgeEntry());
				sync();
				const obs = typeof MutationObserver !== "undefined"
					? new MutationObserver(sync)
					: null;
				if (obs && document.body) obs.observe(document.body, { childList: true, subtree: true });
				const iv = setInterval(sync, 800);
				return () => {
					if (obs) obs.disconnect();
					clearInterval(iv);
				};
			}, []);
			if (st.open || hide) return null;
			return h("button", {
				type: "button",
				className: "dshp-launch",
				"data-open": "0",
				"data-hide": "0",
				"data-testid": "dsh-purge-launch",
				title: t("dock.newSession"),
				onClick: () => toggleDock(),
			}, t("dock.newSession"));
		}

		/** 홈: 모드 옆에 'dsh-purge'를 붙여 → 플러그인을 연다. 레드팀 모드는 모드 드롭다운으로 간다 (registry 선언). */
		function HeroNewSessionMount() {
			const t = useT();
			const st = useDock();
			const [host, setHost] = useState(null);
			useEffect(() => {
				let dead = false;
				let warnedMiss = false;
				const ensure = () => {
					if (dead || typeof document === "undefined") return;
					/* 여러 연결점 폴백: 시맨틱 data-* 우선, class 부분 문자열 퍼지 매칭 폴백 (특정 CSS Module 해시에 묶이지 않음) */
					const row =
						document.querySelector('[data-dsh-hero-workspace-row]') ||
						document.querySelector('[data-conversation-hero]') ||
						document.querySelector('[class*="heroWorkspaceRow" i]') ||
						document.querySelector('[class*="hero" i][class*="workspace" i][class*="row" i]');
					if (!row) {
						if (!warnedMiss) {
							warnedMiss = true;
							try { console.warn("[dsh-purge] HeroNewSessionMount: anchor row missing (the host may have changed)"); } catch { /* ignore */ }
						}
						setHost((prev) => (prev ? null : prev));
						return;
					}
					warnedMiss = false;
					let el = row.querySelector(":scope > .dshp-hero-chip");
					if (!el) {
						el = document.createElement("div");
						el.className = "dshp-hero-chip";
						el.setAttribute("data-testid", "dsh-purge-hero-chip");
					}
					placeHeroChip(row, el);
					setHost((prev) => (prev === el ? prev : el));
				};
				ensure();
				const obs = typeof MutationObserver !== "undefined"
					? new MutationObserver(() => ensure())
					: null;
				if (obs) obs.observe(document.body, { childList: true, subtree: true });
				const iv = setInterval(ensure, 1000);
				return () => {
					dead = true;
					if (obs) obs.disconnect();
					clearInterval(iv);
				};
			}, []);
			if (!host) return null;
			const btn = h("button", {
				type: "button",
				className: "dshp-hero-chip-btn" + (st.open ? " on" : ""),
				title: t("dock.newSession"),
				onClick: () => toggleDock(),
			},
				st.open ? h("span", { className: "dshp-live-dot", "aria-hidden": "true" }) : null,
				t("dock.newSession"),
			);
			try {
				const rd = require("react-dom");
				if (rd && typeof rd.createPortal === "function") return rd.createPortal(btn, host);
			} catch { /* host가 react-dom을 노출하지 않았을 수 있음 */ }
			return null;
		}

		/** '대화 / 궤적 / 컨텍스트' 줄에 붙이고, 컨텍스트 바로 옆에 둔다. */
		function TabRowPurgeMount() {
			const t = useT();
			const st = useDock();
			const [host, setHost] = useState(null);
			useEffect(() => {
				let dead = false;
				let warnedMiss = false;
				const ensure = () => {
					if (dead || typeof document === "undefined") return;
					/* 여러 연결점 폴백: data-* 우선, ARIA / class 부분 문자열 폴백 */
					/* The tab row may be labelled in the host locale; match either language. */
					const zhConversationTab = String.fromCharCode(0x5bf9, 0x8bdd);
					const row =
						document.querySelector("[data-conversation-tabs]") ||
						document.querySelector("[data-conversation-tabrow]") ||
						document.querySelector("[role='tablist'][aria-label*='" + zhConversationTab + "'], [role='tablist'][aria-label*='Conversation' i]") ||
						document.querySelector("[class*='conversation' i][class*='tab' i][class*='row' i]");
					if (!row) {
						if (!warnedMiss) {
							warnedMiss = true;
							try { console.warn("[dsh-purge] TabRowPurgeMount: tab row anchor missing"); } catch { /* ignore */ }
						}
						setHost((prev) => (prev ? null : prev));
						return;
					}
					warnedMiss = false;
					let el = row.querySelector(":scope > .dshp-tab-chip");
					if (!el) {
						el = document.createElement("div");
						el.className = "dshp-tab-chip";
						el.setAttribute("data-testid", "dsh-purge-tab-chip");
					}
					placeTabChip(row, el);
					setHost((prev) => (prev === el ? prev : el));
				};
				ensure();
				const obs = typeof MutationObserver !== "undefined"
					? new MutationObserver(() => ensure())
					: null;
				if (obs) obs.observe(document.body, { childList: true, subtree: true });
				const iv = setInterval(ensure, 1000);
				return () => {
					dead = true;
					if (obs) obs.disconnect();
					clearInterval(iv);
				};
			}, []);
			if (!host) return null;
			const btn = h("button", {
				type: "button",
				className: "dshp-tab-btn" + (st.open ? " on" : ""),
				title: st.open ? (t("dock.inSession") + " · On") : (t("dock.inSession") + " · Click to open"),
				onClick: () => toggleDock(),
			}, t("dock.inSession"));
			try {
				const rd = require("react-dom");
				if (rd && typeof rd.createPortal === "function") return rd.createPortal(btn, host);
			} catch { /* host가 react-dom을 노출하지 않았을 수 있음 */ }
			return null;
		}


		function installRewindUi(ctx) {
			rewindHost = ctx;
			rewindSessions = ctx.sessions;
			rewindWorkspace = ctx.uiWorkspace || null;
			rewindConversation = ctx.conversation || null;
			ctx.slots.inject("conversation.input.right", () => ctx.slots.register({
				name: "conversation.input.right",
				id: "dsh-purge-rewind",
				order: 20,
				inject: (sessionId) => ({
					sessionId,
					t: ctx.locale.bind(NS),
				}),
			}, RewindSafe));
			// ctx.slots.inject("conversation.input.right", () => ctx.slots.register({
			// 	name: "conversation.input.right",
			// 	id: "dsh-purge-continue",
			// 	order: 21,
			// 	inject: (sessionId) => ({
			// 		sessionId,
			// 		t: ctx.locale.bind(NS),
			// 	}),
			// }, ContinueSafe));
			ctx.effect(() => installRewindWatch(ctx), "dsh-purge: rewind watch");
		}

		// 일반 command 결과는 호스트의 빈 세션을 활성화하지 않는다; 입력 노드를 채워 결과 카드가 보이게 한다.
		const purgeCommandInputDefinition = {
			kind: "dsh-purge-command-input",
			target: "chat",
			match: (event) => event.type === "command/run" && event.data.name === "purge"
				? { id: String(event.data.commandId), role: "start" } : null,
			start: (_context, match) => ({
				commandId: match.event.data.commandId,
				seq: match.event.seq,
				time: match.event.time,
				text: `/purge${(match.event.data.args ?? "").trimEnd()}`,
			}),
			update: (context) => context.state,
			buildViewNode: (context) => context.state === undefined ? null : ({
				key: context.key,
				id: context.id,
				kind: "dsh-purge-command-input",
				target: "chat",
				anchorSeq: context.state.seq - 0.1,
				location: context.start?.location ?? { kind: "unresolved" },
				visibility: "visible",
				data: {
					commandId: context.state.commandId,
					text: context.state.text,
					time: context.state.time,
				},
			}),
		};

		function PurgeCommandInputView({ node }) {
			return h("div", {
				role: "group", "aria-label": "/purge", "data-command-input": "",
				style: { display: "flex", justifyContent: "flex-end", padding: "8px 24px" },
			}, h("div", {
				style: { whiteSpace: "pre-wrap", overflowWrap: "anywhere", maxWidth: "100%",
					background: "var(--dsw-alias-bg-layer-2, #f3f4f6)", borderRadius: 12, padding: "10px 14px" },
			}, node.data.text));
		}

		function apply(ctx) {
			if (ctx.uiConversation && ctx.uiConversation.events && typeof ctx.uiConversation.events.register === "function") {
				ctx.uiConversation.events.register(purgeCommandInputDefinition);
				ctx.slots.inject("conversation.chat.node", () => ctx.slots.register({
					name: "conversation.chat.node", key: "dsh-purge-command-input",
				}, PurgeCommandInputView));
			}
			/* 호스트 로케일 카탈로그에는 zh/en 만 기본 포함되므로, 한국어를 선택 가능하게 등록한다. */
			try {
				ctx.effect(() => ctx.locale.addLanguage({ id: "ko", label: "한국어", fallback: "en" }), "dsh-purge: korean locale");
			} catch { /* 이미 등록된 경우 그대로 쓴다 */ }
			ctx.effect(() => ctx.locale.register(NS, { ko, en }), "dsh-purge: dictionaries");
			const t = ctx.locale.bind(NS);
			translate = t;
			ctx.slots.inject("shell.overlay", () => ctx.slots.register({
				name: "shell.overlay",
				id: "dsh-purge-dock",
				order: 50,
			}, () => h(react.Fragment, null, h(WelcomeNotice), h(PurgeLauncher), h(PurgeDock), h(HeroNewSessionMount), h(TabRowPurgeMount), h(EnvAdaptSendGate))));
			try {
				if (typeof ctx.inject === "function") {
					ctx.inject(["sessions", "uiWorkspace", "workspaces", "conversation"], (host) => installRewindUi(host));
				} else if (ctx.sessions) {
					installRewindUi(ctx);
				}
			} catch (e) {
				try {
					if (typeof ctx.inject === "function") {
						ctx.inject(["sessions", "uiWorkspace", "conversation"], (host) => installRewindUi(host));
					}
				} catch (e2) {
					try { console.warn("[dsh-purge] rewind ui skipped:", e2 || e); } catch { /* ignore */ }
				}
			}
		}

		exports.name = name;
		exports.inject = inject;
		exports.apply = apply;
		return module.exports;
	}
});
