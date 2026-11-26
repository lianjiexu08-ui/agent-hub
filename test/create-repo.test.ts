/**
 * 新建 GitHub 仓库并绑定：用本地假 GitHub 服务，不访问网络。
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { Store } from "../src/db.ts";
import { Runtime } from "../src/runtime.ts";
import { Settings } from "../src/settings.ts";
import { Notifier } from "../src/notify.ts";
import { GitHub } from "../src/github.ts";
import { Linear } from "../src/linear.ts";
import { Workspace } from "../src/workspace.ts";
import { Work } from "../src/work.ts";
import { simulatedLLM } from "../src/simulate.ts";

const created: { path: string; body: Record<string, unknown> }[] = [];
const existing = new Set(["me/taken"]);
/** 设为 true 时创建接口返回 403（模拟令牌权限不够） */
let forbid = false;

const server = createServer(async (req, res) => {
  let raw = "";
  for await (const c of req) raw += c;
  const send = (code: number, data: unknown) => { res.statusCode = code; res.setHeader("content-type", "application/json"); res.end(JSON.stringify(data)); };
  const url = req.url ?? "";
  if (req.method === "GET" && url === "/user") return send(200, { login: "me" });
  if (req.method === "GET" && url.startsWith("/user/orgs")) return send(200, [{ login: "acme" }]);
  if (req.method === "POST" && (url === "/user/repos" || /^\/orgs\/[^/]+\/repos$/.test(url))) {
    if (forbid) return send(403, { message: "Resource not accessible by personal access token" });
    const body = JSON.parse(raw);
    const owner = url === "/user/repos" ? "me" : decodeURIComponent(url.split("/")[2]);
    const full = `${owner}/${body.name}`;
    if (existing.has(full)) return send(422, { message: "Repository creation failed.", errors: [{ message: "name already exists on this account" }] });
    existing.add(full);
    created.push({ path: url, body });
    return send(201, { full_name: full, default_branch: "main" });
  }
  const m = /^\/repos\/([^/]+\/[^/]+)$/.exec(url);
  if (req.method === "GET" && m && existing.has(m[1])) return send(200, { full_name: m[1], default_branch: "main" });
  send(404, { message: "Not Found" });
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
after(() => server.close());

function setup() {
  const store = new Store(":memory:");
  const settings = new Settings(store);
  const g = settings.get();
  g.github = { connected: true, method: "pat", login: "me", scopes: ["repo"], repos: ["me/old"], tokenHint: "ghp_…test", connectedAt: new Date().toISOString() };
  store.docPut("settings", "global", { id: "global", ...g });
  const runtime = new Runtime(store, simulatedLLM({ delayMs: [1, 1] }), { maxConcurrency: 2, maxDepth: 2, maxHops: 2 });
  const work = new Work(store, runtime, { notify: new Notifier(store, () => settings.get().notify), settings, github: new GitHub(() => "ghp_test", base), linear: new Linear(() => null), workspace: new Workspace("/tmp/agent-hub-test-ws", () => null), simulate: false });
  return { work, settings };
}

test("可选归属：自己的账号 + 所在组织", async () => {
  const { work } = setup();
  assert.deepEqual(await work.githubOwners(), [{ login: "me", org: false }, { login: "acme", org: true }]);
});

test("新建仓库：默认私有、带 README 初始化，建好后绑定并加入可选列表", async () => {
  const { work, settings } = setup();
  const p = work.saveProject({ name: "从零开始", key: "ZERO", description: "一个新项目" });
  created.length = 0;
  const repo = await work.createRepo(p.id, { owner: "me", name: "zero-app" });
  assert.equal(repo?.fullName, "me/zero-app");
  assert.equal(created[0].path, "/user/repos");
  assert.equal(created[0].body.auto_init, true, "空仓库没有默认分支，必须初始化");
  assert.equal(created[0].body.private, true, "默认私有");
  assert.equal(created[0].body.description, "一个新项目");
  assert.equal(work.proj(p.id)!.repo?.fullName, "me/zero-app");
  assert.equal(work.proj(p.id)!.repo?.defaultBranch, "main");
  assert.equal(settings.get().github.repos?.[0], "me/zero-app");
  await assert.rejects(work.createRepo(p.id, { owner: "me", name: "another" }), /已绑定 me\/zero-app/);
});

test("建到组织下、公开仓库", async () => {
  const { work } = setup();
  const p = work.saveProject({ name: "组织项目", key: "ORG" });
  created.length = 0;
  await work.createRepo(p.id, { owner: "acme", org: true, name: "site", private: false });
  assert.equal(created[0].path, "/orgs/acme/repos");
  assert.equal(created[0].body.private, false);
  assert.equal(work.proj(p.id)!.repo?.fullName, "acme/site");
});

test("出错时给出能看懂的原因，且项目不绑定", async () => {
  const { work } = setup();
  const p = work.saveProject({ name: "出错", key: "ERR" });
  await assert.rejects(work.createRepo(p.id, { owner: "me", name: "bad name!" }), /只能包含字母/);
  await assert.rejects(work.createRepo(p.id, { owner: "me", name: ".." }), /只能包含字母/);
  await assert.rejects(work.createRepo(p.id, { owner: "me", name: "taken" }), /已存在/);
  forbid = true;
  try { await assert.rejects(work.createRepo(p.id, { owner: "me", name: "fresh" }), /没有创建仓库的权限/); }
  finally { forbid = false; }
  assert.equal(work.proj(p.id)!.repo, null);
});
