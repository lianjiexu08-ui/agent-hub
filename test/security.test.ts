import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/db.ts";
import { Runtime } from "../src/runtime.ts";
import { simulatedLLM } from "../src/simulate.ts";
import { createApp } from "../src/server.ts";
import { Credentials } from "../src/credentials.ts";
import { isCrossSite, taskToken, TASK_TOKEN_HEADER } from "../src/auth.ts";

const store = new Store(":memory:");
const runtime = new Runtime(store, simulatedLLM({ delayMs: [1, 1] }), { maxConcurrency: 2, maxDepth: 2, maxHops: 2 });
const calls: string[] = [];
const extras = { state: async () => ({ ok: true }), rpc: async (m: string) => { calls.push(m); return null; } };
after(() => void runtime.mcp.closeAll());

const json = { "content-type": "application/json" };
const rpcBody = JSON.stringify({ method: "knowledge.add", args: ["x", "note", "t"] });
const cookieFrom = (res: Response) => (res.headers.get("set-cookie") ?? "").split(";")[0];
/** 免密码模式（未设置密码与令牌，也没初始化账号） */
const openApp = () => {
  const cred = new Credentials(join(mkdtempSync(join(tmpdir(), "hub-sec-")), "auth.json"));
  return createApp(store, runtime, { user: "admin", password: "", credentials: cred }, extras);
};

test("来源判断：外站 / 不透明来源 / cross-site 拒绝，同源与无 Origin 放行", () => {
  assert.equal(isCrossSite({ origin: "https://evil.example", host: "127.0.0.1:18790" }), true);
  assert.equal(isCrossSite({ origin: "null", host: "127.0.0.1:18790" }), true);
  assert.equal(isCrossSite({ secFetchSite: "cross-site", host: "127.0.0.1:18790" }), true);
  assert.equal(isCrossSite({ origin: "http://127.0.0.1:18790", host: "127.0.0.1:18790" }), false);
  assert.equal(isCrossSite({ host: "127.0.0.1:18790" }), false, "curl / MCP 不带 Origin");
});

test("免密码模式：跨站请求与非 JSON 的 RPC 被拒绝，同源请求正常", async () => {
  const app = openApp();
  calls.length = 0;
  const evil = await app.request("/api/rpc", { method: "POST", headers: { ...json, origin: "https://evil.example", host: "localhost" }, body: rpcBody });
  assert.equal(evil.status, 403);
  const plain = await app.request("/api/rpc", { method: "POST", headers: { "content-type": "text/plain" }, body: rpcBody });
  assert.equal(plain.status, 415, "text/plain 是无需预检的简单请求，必须拒绝");
  const evilSetup = await app.request("/api/setup", { method: "POST", headers: { ...json, origin: "https://evil.example", host: "localhost" }, body: JSON.stringify({ user: "x", password: "123456" }) });
  assert.equal(evilSetup.status, 403, "外站不能抢先设置账号");
  assert.deepEqual(calls, [], "被拒绝的请求没有执行任何方法");

  const same = await app.request("/api/rpc", { method: "POST", headers: { ...json, origin: "http://localhost", host: "localhost" }, body: rpcBody });
  assert.equal(same.status, 200);
  assert.deepEqual(calls, ["knowledge.add"]);
});

test("免密码模式下设置账号密码后立即上锁，不需要重启", async () => {
  const app = openApp();
  assert.equal((await app.request("/api/state")).status, 200, "设置前开放");
  const res = await app.request("/api/setup", { method: "POST", headers: json, body: JSON.stringify({ user: "owner", password: "passw0rd" }) });
  assert.equal(res.status, 200);
  assert.equal((await app.request("/api/state")).status, 401, "设置后未登录即拒绝");
  assert.equal((await app.request("/api/state", { headers: { cookie: cookieFrom(res) } })).status, 200, "设置时签发的会话可用");
  const again = await app.request("/api/setup", { method: "POST", headers: json, body: JSON.stringify({ user: "evil", password: "passw0rd" }) });
  assert.equal(again.status, 401, "上锁后未登录不能改账号");
});

test("任务桥：只设登录密码（无 HUB_TOKEN）时凭任务级令牌回调，且令牌只对本任务有效", async () => {
  const secret = "internal-secret-for-test";
  const app = createApp(store, runtime, { user: "admin", password: "pw-only", internalSecret: secret }, extras);
  const path = (id: string) => `/internal/tasks/${id}/tools`;
  assert.equal((await app.request(path("task-a"))).status, 401, "无令牌拒绝");
  assert.equal((await app.request(path("task-a"), { headers: { [TASK_TOKEN_HEADER]: taskToken("task-a", secret) } })).status, 200);
  assert.equal((await app.request(path("task-b"), { headers: { [TASK_TOKEN_HEADER]: taskToken("task-a", secret) } })).status, 401, "不能拿 A 的令牌访问 B");
  assert.equal((await app.request("/api/state", { headers: { [TASK_TOKEN_HEADER]: taskToken("task-a", secret) } })).status, 401, "任务令牌不能访问其它接口");
  assert.equal((await app.request(path("task-a"), { headers: { [TASK_TOKEN_HEADER]: taskToken("task-a", "other-secret") } })).status, 401, "其它进程签发的令牌无效");
});
