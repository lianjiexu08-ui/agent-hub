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
