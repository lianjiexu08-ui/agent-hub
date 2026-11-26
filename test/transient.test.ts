import { test } from "node:test";
import assert from "node:assert/strict";
import { isTransientError, backoffMs } from "../src/transient.ts";

test("网络抖动类错误识别", () => {
  for (const e of [
    "Request timed out.: Connect Timeout Error (attempted address: console.cloudrouter.online:443, timeout: 10000ms) (UND_ERR_CONNECT_TIMEOUT)",
    "fetch failed", "socket hang up", "read ECONNRESET", "getaddrinfo EAI_AGAIN api.x", "529 overloaded_error", "HTTP 503 Service Unavailable", "429 Too Many Requests",
    '403: {"message":"You\'ve reached your concurrent request limit. Please wait for your ongoing requests to finish and try again.","type":"access_terminated_error"}',
  ]) assert.ok(isTransientError(e), e);
  assert.ok(isTransientError({ status: 502, message: "Bad Gateway" }));
  for (const e of ["已进行 3 轮仍未通过", "需求不清楚", "400 invalid_request_error: model not found", "cancelled",
    "429: Usage limit reached for 5 hour. Your limit will reset at 2026-11-26 16:16:42", "insufficient_quota: You exceeded your current quota"]) assert.ok(!isTransientError(e), e);
  assert.ok(!isTransientError({ status: 429, message: "Usage limit reached" }), "额度用完不是网络抖动，等恢复");
  assert.ok(!isTransientError({ name: "AbortError", message: "timeout" }), "人主动停止不重试");
  assert.equal(backoffMs(0), 5);
  assert.equal(backoffMs(99), 180);
});

test("Claude Code 的额度提示：5 小时 / 每周额度，按给出的时区算恢复时间", async () => {
  const { quotaReset, providerDown } = await import("../src/transient.ts");
  const at = new Date("2026-11-26T18:00:00Z"); // 上海 27 日 02:00
  const r = quotaReset("You've hit your 5-hour limit · resets 3:50am (Asia/Shanghai)", at)!;
  assert.equal(r.toISOString(), "2026-11-26T19:50:00.000Z", "上海 03:50");
  const pm = quotaReset("You've hit your 5-hour limit · resets 1pm (America/New_York)", at)!;
  assert.equal(pm.toISOString(), "2026-11-27T18:00:00.000Z", "纽约 27 日 13:00（冬令时 UTC-5）");
  const wk = quotaReset("You've hit your weekly limit · resets Mon 9am (Asia/Shanghai)", at)!;
  assert.equal(wk.toISOString(), "2026-11-30T01:00:00.000Z", "下周一上海 09:00");
  assert.ok(providerDown("You've hit your 5-hour limit · resets 3:50am (Asia/Shanghai)"));
});
