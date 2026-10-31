import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const client = readFileSync(join(root, "client.js"), "utf8");

function rule(selector) {
	const at = client.indexOf(selector);
	if (at < 0) return "";
	const brace = client.indexOf("{", at);
	const end = client.indexOf("}", brace);
	return brace < 0 || end < 0 ? "" : client.slice(brace + 1, end);
}

test("#196 어두운 호스트의 기본 버튼이 더 이상 거의 흰색인 브랜드 배경을 쓰지 않는다", () => {
	// 호스트 다크 모드에서 --dsw-alias-brand-primary = #f9fafb 이므로 그대로 배경으로 쓰면 흰 배경에 흰 글자가 된다.
	for (const selector of [
		'body[data-ds-dark-theme] .dshp-btn-primary',
		'.dshp-root[data-theme="dusk"] .dshp-btn-primary',
		'.dshp-dock[data-theme="dusk"] .dshp-btn-primary',
		'body[data-ds-dark-theme] .rt-btn-primary',
		'.dshp-dock[data-theme="dusk"] .rt-btn-primary',
		'.dshp-dock[data-theme="dusk"] .dshp-dock-body .rt-btn-primary',
	]) {
		const body = rule(selector);
		assert.match(body, /background:#3d8f68!important/, selector);
		assert.match(body, /color:#fff!important/, selector);
	}
});

test("#196 어두운 테마에서 기본 버튼 호버 시에도 읽을 수 있는 배경색을 유지한다", () => {
	const body = rule('body[data-ds-dark-theme] .dshp-btn-primary:hover:not(:disabled)');
	assert.match(body, /background:#347a59!important/);
});

test("#196 보고서 단계 번호 원형 마커는 어두운 테마에서도 초록 배경에 흰 글자를 유지한다", () => {
	const at = client.indexOf('body[data-ds-dark-theme] .rt-rep-step-no,.dshp-dock[data-theme="dusk"] .rt-rep-step-no');
	assert.notEqual(at, -1);
	const body = client.slice(at, client.indexOf("}", at));
	assert.match(body, /background:#3d8f68/);
	assert.match(body, /color:#fff/);
});
