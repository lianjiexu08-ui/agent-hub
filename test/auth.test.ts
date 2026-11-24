/**
 * 账号登录：会话签名、密码校验、限速，以及服务端的登录流程与鉴权边界。
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/db.ts";
import { Runtime } from "../src/runtime.ts";
import { simulatedLLM } from "../src/simulate.ts";
import { createApp } from "../src/server.ts";
import { checkPassword, issueSession, LoginThrottle, SESSION_COOKIE, verifySession } from "../src/auth.ts";

const SECRET = "s3cret";

test("会话：签发与校验；篡改或过期都拒绝", () => {
  const c = issueSession("admin", SECRET);
  assert.deepEqual(verifySession(c, SECRET)?.user, "admin");
  assert.equal(verifySession(c, "other"), null, "密钥不对");
  const [payload, mac] = c.split(".");
  assert.equal(verifySession(`${payload}.${mac.slice(0, -2)}xx`, SECRET), null, "签名被改");
  assert.equal(verifySession(undefined, SECRET), null);
  assert.equal(verifySession(issueSession("admin", SECRET, -1000), SECRET), null, "已过期");
  // 能从完整的 Cookie 头里解析
  assert.equal(verifySession(`${SESSION_COOKIE}=${c}; other=1`, SECRET)?.user, "admin");
});

test("密码校验：用户名与密码都要对", () => {
  const s = { user: "admin", password: "p@ss" };
  assert.equal(checkPassword({ user: "admin", password: "p@ss" }, s), true);
  assert.equal(checkPassword({ user: "admin", password: "nope" }, s), false);
  assert.equal(checkPassword({ user: "root", password: "p@ss" }, s), false);
  assert.equal(checkPassword({}, s), false);
});

test("限速：连续失败 5 次后锁定", () => {
  const t = new LoginThrottle();
  for (let n = 0; n < 4; n++) { t.fail("ip"); assert.equal(t.blocked("ip"), 0); }
  t.fail("ip");
  assert.ok(t.blocked("ip") > 0, "第 5 次后锁定");
  t.ok("ip");
  assert.equal(t.blocked("ip"), 0, "登录成功后解锁");
});

const store = new Store(":memory:");
const runtime = new Runtime(store, simulatedLLM({ delayMs: [1, 1] }), { maxConcurrency: 2, maxDepth: 2, maxHops: 2 });
const extras = { state: async () => ({ ok: true }), rpc: async () => null };
const app = createApp(store, runtime, { user: "admin", password: SECRET, token: "api-token" }, extras);
after(() => void runtime.mcp.closeAll());

const cookieFrom = (res: Response) => (res.headers.get("set-cookie") ?? "").split(";")[0];

test("登录流程：未登录 401，登录后带 Cookie 可访问，Bearer 令牌仍可用", async () => {
  assert.deepEqual(await (await app.request("/api/session")).json(), { authenticated: false, loginEnabled: true });
  assert.equal((await app.request("/api/state")).status, 401);
  assert.equal((await app.request("/assets/app.js")).status, 200, "静态资源不需要登录");

  const bad = await app.request("/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ user: "admin", password: "wrong" }) });
  assert.equal(bad.status, 401);

  const ok = await app.request("/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ user: "admin", password: SECRET }) });
  assert.equal(ok.status, 200);
  const cookie = cookieFrom(ok);
  assert.match(cookie, new RegExp(`^${SESSION_COOKIE}=`));
  assert.ok((ok.headers.get("set-cookie") ?? "").includes("HttpOnly"));

  const withCookie = await app.request("/api/state", { headers: { cookie } });
  assert.equal(withCookie.status, 200);
  assert.equal((await app.request("/api/state", { headers: { cookie: `${SESSION_COOKIE}=forged.deadbeef` } })).status, 401);

  assert.equal((await app.request("/api/state", { headers: { authorization: "Bearer api-token" } })).status, 200);
  assert.equal((await app.request("/api/state?token=api-token")).status, 200);

  const out = await app.request("/api/logout", { method: "POST", headers: { cookie } });
  assert.ok((out.headers.get("set-cookie") ?? "").includes("Max-Age=0"));
});
