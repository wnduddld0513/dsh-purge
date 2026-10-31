import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ipToInt, isIpv6, cidrOf, scopeOfIp, slugify, slugTarget, defaultPocFilename,
} from "../lib/redteam/ip-utils.js";

test("ipToInt 는 IPv4 를 32비트 정수로 변환한다", () => {
  assert.equal(ipToInt("10.0.0.1"), 167772161);
  assert.equal(ipToInt("192.168.1.1"), 3232235777);
  assert.equal(ipToInt("0.0.0.0"), 0);
});

test("ipToInt 는 IPv4 가 아니면 null 을 돌려준다", () => {
  assert.equal(ipToInt(""), null);
  assert.equal(ipToInt("abc"), null);
  assert.equal(ipToInt(null), null);
  assert.equal(ipToInt("1.2.3"), null);
});

test("isIpv6 는 IPv6 리터럴을 식별한다", () => {
  assert.equal(isIpv6("2001:db8::1"), true);
  assert.equal(isIpv6("::1"), true);
  assert.equal(isIpv6("::ffff:192.0.2.1"), true);
  assert.equal(isIpv6("10.0.0.1"), false);
  assert.equal(isIpv6(""), false);
});

test("cidrOf 는 네트워크 대역으로 정규화한다", () => {
  assert.equal(cidrOf("10.0.0.5"), "10.0.0.0/24");
  assert.equal(cidrOf("::1"), "0:0:0:0::/64");
  assert.equal(cidrOf("not-an-ip"), "not-an-ip");
});

test("scopeOfIp 는 내부망과 외부망을 구분한다", () => {
  assert.equal(scopeOfIp("10.1.2.3"), "internal");
  assert.equal(scopeOfIp("192.168.1.1"), "internal");
  assert.equal(scopeOfIp("127.0.0.1"), "internal");
  assert.equal(scopeOfIp("172.16.0.1"), "internal");
  assert.equal(scopeOfIp("172.32.0.1"), "external");
  assert.equal(scopeOfIp("8.8.8.8"), "external");
  assert.equal(scopeOfIp("fc00::1"), "internal");
  assert.equal(scopeOfIp("2001:db8::1"), "external");
});

test("slugify 는 slug 로 정규화한다", () => {
  assert.equal(slugify("Hello World!"), "hello-world");
  // CJK 문자는 유니코드 문자(\p{L})라 보존되고, 공백만 하이픈이 된다.
  assert.equal(slugify("  \u4e2d\u6587 \u7a7a\u683c  "), "\u4e2d\u6587-\u7a7a\u683c");
});

test("slugTarget 은 대상을 정규화한다", () => {
  assert.equal(slugTarget("10.0.0.5"), "10.0.0.5");
  assert.equal(slugTarget("10.0.0.5:8080"), "10.0.0.5");
  assert.equal(slugTarget("https://example.com/path"), "example.com");
  assert.equal(slugTarget(""), "unknown");
});

test("defaultPocFilename 은 언어에 따라 확장자를 고른다", () => {
  assert.equal(defaultPocFilename("t", "x", "python"), "poc.py");
  assert.equal(defaultPocFilename("t", "x", "go"), "poc.go");
  assert.equal(defaultPocFilename("t", "template", ""), "poc.yaml");
  assert.equal(defaultPocFilename("t", "x", ""), "poc.txt");
});
