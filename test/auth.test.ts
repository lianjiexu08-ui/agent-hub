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
import { Credentials } from "../src/credentials.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
  assert.deepEqual(await (await app.request("/api/session")).json(), { authenticated: false, loginEnabled: true, needsSetup: false });
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


test("凭证文件：scrypt 校验、持久化，改密码即换会话密钥", () => {
  const dir = mkdtempSync(join(tmpdir(), "hub-cred-"));
  const file = join(dir, "auth.json");
  const c = new Credentials(file);
  assert.equal(c.initialized, false);
  assert.equal(c.user, null);

  c.set("alice", "hunter22");
  assert.equal(c.initialized, true);
  assert.equal(c.user, "alice");
  assert.equal(c.verify("alice", "hunter22"), true);
  assert.equal(c.verify("alice", "hunter23"), false, "密码不对");
  assert.equal(c.verify("bob", "hunter22"), false, "账号不对");
  assert.equal(c.verify("alice", ""), false, "空密码");

  const reloaded = new Credentials(file);
  assert.equal(reloaded.verify("alice", "hunter22"), true, "重新加载后仍可登录");
  const first = reloaded.secret;
  reloaded.set("alice", "another-pass");
  assert.notEqual(reloaded.secret, first, "改密码换密钥，旧会话失效");
  assert.equal(reloaded.verify("alice", "another-pass"), true);
});

test("初始密码与用户凭证：用户设置过以后以凭证为准", () => {
  const dir = mkdtempSync(join(tmpdir(), "hub-cred-"));
  const cred = new Credentials(join(dir, "auth.json"));
  const s = { user: "admin", password: "initial", credentials: cred };
  assert.equal(checkPassword({ user: "admin", password: "initial" }, s), true, "未设置前用初始密码");
  cred.set("lianjie", "newpass123");
  assert.equal(checkPassword({ user: "admin", password: "initial" }, s), false, "初始密码失效");
  assert.equal(checkPassword({ user: "lianjie", password: "newpass123" }, s), true);
  assert.equal(checkPassword({ user: "lianjie", password: "initial" }, s), false);
});

test("首次登录初始化：必须已登录才能设置，设置后以新账号密码登录", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hub-cred-"));
  const cred = new Credentials(join(dir, "auth.json"));
  const setupApp = createApp(store, runtime, { user: "admin", password: "init-pass", credentials: cred }, extras);

  const first = await (await setupApp.request("/api/session")).json() as { needsSetup: boolean };
  assert.equal(first.needsSetup, true, "还没初始化");

  const anon = await setupApp.request("/api/setup", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ user: "owner", password: "passw0rd" }),
  });
  assert.equal(anon.status, 401, "未登录不能设置");

  const login = await setupApp.request("/api/login", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ user: "admin", password: "init-pass" }),
  });
  assert.equal(login.status, 200);
  assert.equal((await login.clone().json() as { needsSetup: boolean }).needsSetup, true, "登录后仍提示初始化");
  const cookie = cookieFrom(login);

  const weak = await setupApp.request("/api/setup", {
    method: "POST", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ user: "owner", password: "123" }),
  });
  assert.equal(weak.status, 400, "密码太短");

  const blank = await setupApp.request("/api/setup", {
    method: "POST", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ user: "   ", password: "passw0rd" }),
  });
  assert.equal(blank.status, 400, "账号为空");

  const ok = await setupApp.request("/api/setup", {
    method: "POST", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ user: "owner", password: "passw0rd" }),
  });
  assert.equal(ok.status, 200);
  const newCookie = cookieFrom(ok);
  assert.match(newCookie, new RegExp(`^${SESSION_COOKIE}=`), "重新签发会话");
  assert.equal((await setupApp.request("/api/state", { headers: { cookie: newCookie } })).status, 200);

  const oldPass = await setupApp.request("/api/login", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ user: "admin", password: "init-pass" }),
  });
  assert.equal(oldPass.status, 401, "初始密码失效");

  const fresh = await setupApp.request("/api/login", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ user: "owner", password: "passw0rd" }),
  });
  assert.equal(fresh.status, 200);
  const after = await (await setupApp.request("/api/session", { headers: { cookie: cookieFrom(fresh) } })).json() as { needsSetup: boolean; user: string };
  assert.equal(after.needsSetup, false);
  assert.equal(after.user, "owner");
});
