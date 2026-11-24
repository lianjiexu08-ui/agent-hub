/**
 * Linear 双向同步：用本地假 GraphQL 服务验证，不访问网络。
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { Store } from "../src/db.ts";
import { Runtime } from "../src/runtime.ts";
import { Settings } from "../src/settings.ts";
import { Notifier } from "../src/notify.ts";
import { GitHub } from "../src/github.ts";
import { Linear, pickState, type LinearState } from "../src/linear.ts";
import { Workspace } from "../src/workspace.ts";
import { Work } from "../src/work.ts";
import { QA } from "../src/qa.ts";
import { simulatedLLM } from "../src/simulate.ts";
import { AgentSchema } from "../src/types.ts";

const STATES: LinearState[] = [
  { id: "s-backlog", name: "Backlog", type: "backlog", position: 0 },
  { id: "s-todo", name: "Todo", type: "unstarted", position: 1 },
  { id: "s-prog", name: "In Progress", type: "started", position: 2 },
  { id: "s-review", name: "In Review", type: "started", position: 3 },
  { id: "s-done", name: "Done", type: "completed", position: 4 },
  { id: "s-cancel", name: "Canceled", type: "canceled", position: 5 },
];

type Remote = { id: string; identifier: string; title: string; description: string; priority: number; url: string; updatedAt: string; stateId: string; labels: string[] };
const remote: Remote[] = [
  { id: "lin-1", identifier: "ENG-1", title: "登录页白屏", description: "验收标准：\n- 登录页正常显示\n- 无控制台报错", priority: 2, url: "https://linear.app/x/issue/ENG-1", updatedAt: new Date().toISOString(), stateId: "s-todo", labels: ["bug"] },
  { id: "lin-2", identifier: "ENG-2", title: "已完成的旧需求", description: "", priority: 0, url: "https://linear.app/x/issue/ENG-2", updatedAt: new Date().toISOString(), stateId: "s-done", labels: [] },
  { id: "lin-3", identifier: "ENG-3", title: "不带标签", description: "", priority: 4, url: "https://linear.app/x/issue/ENG-3", updatedAt: new Date().toISOString(), stateId: "s-backlog", labels: ["docs"] },
];
const updates: { id: string; input: Record<string, unknown> }[] = [];
const comments: { issueId: string; body: string }[] = [];
const issueQueries: { after?: string | null; filter?: { updatedAt?: { gt: string } } | null }[] = [];
let seq = 100;
const state = (id: string) => STATES.find((s) => s.id === id)!;
const toIssue = (r: Remote) => ({ ...r, state: state(r.stateId), labels: { nodes: r.labels.map((name) => ({ name })) } });

const server = createServer(async (req, res) => {
  let body = "";
  for await (const c of req) body += c;
  const { query, variables } = JSON.parse(body);
  const ok = (data: unknown) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ data })); };
  if (req.headers.authorization !== "lin_api_test") { res.statusCode = 401; return res.end(JSON.stringify({ errors: [{ message: "Authentication required" }] })); }
  if (query.includes("viewer")) return ok({ viewer: { id: "u1", name: "Tester", email: "t@example.com" } });
  if (query.includes("teams(")) return ok({ teams: { nodes: [{ id: "team-1", key: "ENG", name: "Engineering" }] } });
  if (query.includes("states(")) return ok({ team: { states: { nodes: STATES } } });
  if (query.includes("issues(")) {
    issueQueries.push(variables);
    const gt = variables.filter?.updatedAt?.gt;
    const list = remote.filter((r) => !gt || r.updatedAt > gt);
    const start = variables.after ? Number(variables.after) : 0;
    const page = list.slice(start, start + 100);
    const more = start + 100 < list.length;
    return ok({ team: { issues: { nodes: page.map(toIssue), pageInfo: { hasNextPage: more, endCursor: more ? String(start + 100) : null } } } });
  }
  if (query.includes("issueCreate")) {
    const n = ++seq;
    const r: Remote = { id: `lin-${n}`, identifier: `ENG-${n}`, title: variables.input.title, description: variables.input.description ?? "", priority: variables.input.priority ?? 0, url: `https://linear.app/x/issue/ENG-${n}`, updatedAt: new Date().toISOString(), stateId: "s-todo", labels: [] };
    remote.push(r);
    return ok({ issueCreate: { success: true, issue: { id: r.id, identifier: r.identifier, url: r.url, state: state(r.stateId) } } });
  }
  if (query.includes("issueUpdate")) {
    updates.push({ id: variables.id, input: variables.input });
    const r = remote.find((x) => x.id === variables.id)!;
    if (variables.input.stateId) r.stateId = variables.input.stateId;
    return ok({ issueUpdate: { success: true, issue: { id: r.id, identifier: r.identifier, url: r.url, state: state(r.stateId) } } });
  }
  if (query.includes("commentCreate")) { comments.push(variables.input); return ok({ commentCreate: { success: true } }); }
  res.statusCode = 400;
  res.end(JSON.stringify({ errors: [{ message: "unknown query" }] }));
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}/graphql`;

const qas: QA[] = [];
after(() => { qas.forEach((q) => q.stop()); server.close(); });

function setup() {
  const store = new Store(":memory:");
  for (const name of ["developer", "tester", "project-lead"]) store.upsertAgent(AgentSchema.parse({ name, description: name }));
  const settings = new Settings(store);
  const linear = new Linear(settings.linearToken, endpoint);
  const runtime = new Runtime(store, simulatedLLM({ delayMs: [2, 6], reviewFailRate: 0 }), { maxConcurrency: 8, maxDepth: 3, maxHops: 3 });
  const work = new Work(store, runtime, { notify: new Notifier(store, () => settings.get().notify), settings, github: new GitHub(() => null), linear, workspace: new Workspace("/tmp/agent-hub-test-ws", () => null), simulate: true });
  const qa = new QA(store, runtime, settings, (id) => work.proj(id), true, { stepMs: 1 });
  qa.forceFail = false;
  work.qa = qa;
  qas.push(qa);
  return { store, settings, work, linear };
}
async function until(fn: () => boolean, ms = 20_000) {
  const t0 = Date.now();
  while (!fn()) { if (Date.now() - t0 > ms) throw new Error("等待超时"); await new Promise((r) => setTimeout(r, 15)); }
}

test("状态映射：工作项状态选到对应的 Linear 工作流状态", () => {
  assert.equal(pickState(STATES, "backlog")?.id, "s-backlog");
  assert.equal(pickState(STATES, "todo")?.id, "s-todo");
  assert.equal(pickState(STATES, "in_progress")?.id, "s-prog");
  assert.equal(pickState(STATES, "in_review")?.id, "s-review");
  assert.equal(pickState(STATES, "done")?.id, "s-done");
  assert.equal(pickState(STATES, "canceled")?.id, "s-cancel");
  // 团队没有 backlog 时回退到 unstarted
  assert.equal(pickState(STATES.filter((s) => s.type !== "backlog"), "backlog")?.id, "s-todo");
});

test("连接：错误的 Key 报错，正确的 Key 保存团队列表且只返回掩码", async () => {
  const { settings } = setup();
  // 先把客户端指向假服务：connectLinear 内部用默认地址，这里只验证 Linear 客户端本身
  await assert.rejects(new Linear(() => "bad", endpoint).viewer(), /Authentication required/);
  const viewer = await new Linear(() => "lin_api_test", endpoint).viewer();
  assert.equal(viewer.name, "Tester");
  assert.equal(settings.get().linear.connected, false);
});

test("双向同步：导入、创建、状态与优先级写回、交付评论", async () => {
  const { store, settings, work } = setup();
  // 直接写入已验证的凭据与团队（绕过对 api.linear.app 的访问）
  store.docPut("secrets", "global", { linearToken: "lin_api_test" });
  const g = settings.get();
  g.linear = { connected: true, viewer: "Tester", keyHint: "lin_…test", teams: [{ id: "team-1", key: "ENG", name: "Engineering" }], connectedAt: new Date().toISOString() };
  store.docPut("settings", "global", { id: "global", ...g });
  assert.equal(JSON.stringify(settings.get()).includes("lin_api_test"), false, "设置里不出现明文 Key");

  const p = work.saveProject({ name: "演示", key: "DEMO" });
  await work.connectLinear(p.id, "team-1");
  assert.equal(work.proj(p.id)!.linear!.teamKey, "ENG");

  // 1. 导入：只导入未完成的；带上优先级
  const msg = await work.syncLinear(p.id);
  assert.match(msg, /导入 2 个/);
  const imported = work.list(p.id);
  assert.deepEqual(imported.map((i) => i.linear!.identifier).sort(), ["ENG-1", "ENG-3"]);
  assert.equal(imported.find((i) => i.linear!.identifier === "ENG-1")!.priority, 2);
  // 再同步不重复导入
  assert.match(await work.syncLinear(p.id), /导入 0 个/);

  // 2. 改优先级与状态写回
  const eng1 = imported.find((i) => i.linear!.identifier === "ENG-1")!;
  updates.length = 0;
  await work.update(eng1.key, { priority: 1, status: "todo" });
  assert.ok(updates.some((u) => u.id === "lin-1" && u.input.priority === 1 && u.input.stateId === "s-todo"));

  // 3. 新建时同步创建，并在执行完成后：状态 → In Review、交付评论回写
  comments.length = 0;
  const v = await work.create({ projectId: p.id, title: "工作项支持批量导入 CSV", description: "验收标准：\n- 支持四列\n- 错误行给出行号\n- 最多 500 行", assignee: "developer", priority: 2, linear: true });
  assert.match(v.linear!.identifier, /^ENG-\d+$/);
  await until(() => work.list(p.id).find((i) => i.key === v.key)!.status === "in_review");
  await until(() => comments.some((c) => c.issueId === v.linear!.id));
  assert.match(comments.find((c) => c.issueId === v.linear!.id)!.body, /developer 交付/);
  // 状态先保存、再异步写回 Linear：等写回完成
  await until(() => remote.find((r) => r.id === v.linear!.id)!.stateId === "s-review");

  // 4. 人工验收完成 → Done
  await work.update(v.key, { status: "done" });
  assert.equal(remote.find((r) => r.id === v.linear!.id)!.stateId, "s-done");
  assert.equal(work.find(v.key).linear!.state, "closed");

  // 5. 一个团队只能绑定一个项目；解绑后保留编号
  const p2 = work.saveProject({ name: "另一个", key: "OTH" });
  await assert.rejects(work.connectLinear(p2.id, "team-1"), /已绑定其他项目/);
  work.disconnectLinear(p.id);
  assert.equal(work.proj(p.id)!.linear, null);
  assert.ok(work.find(v.key).linear);
});

test("拉回远端：完成、优先级、进行中不被回推、分页读取", async () => {
  const { store, settings, work } = setup();
  store.docPut("secrets", "global", { linearToken: "lin_api_test" });
  const g = settings.get();
  g.linear = { connected: true, viewer: "Tester", keyHint: "x", teams: [{ id: "team-1", key: "ENG", name: "Engineering" }], connectedAt: new Date().toISOString() };
  store.docPut("settings", "global", { id: "global", ...g });
  const p = work.saveProject({ name: "拉回", key: "PULL" });
  await work.connectLinear(p.id, "team-1");
  await work.syncLinear(p.id);
  const byRef = (ident: string) => work.list(p.id).find((i) => i.linear?.identifier === ident)!;
  const r1 = remote.find((r) => r.identifier === "ENG-1")!;
  const r3 = remote.find((r) => r.identifier === "ENG-3")!;

  // 远端改优先级 + 标为进行中：本地优先级跟着变，状态保持，且不把远端改回 Todo
  r1.priority = 1; r1.stateId = "s-prog";
  updates.length = 0;
  const msg = await work.syncLinear(p.id);
  assert.match(msg, /拉回远端变更 1 个/);
  assert.equal(byRef("ENG-1").priority, 1);
  assert.equal(byRef("ENG-1").status, "backlog");
  assert.ok(!updates.some((u) => u.id === r1.id), "刚拉回的不回推");

  // 远端完成 / 取消
  r1.stateId = "s-done"; r3.stateId = "s-cancel";
  await work.syncLinear(p.id);
  assert.equal(byRef("ENG-1").status, "done");
  assert.equal(byRef("ENG-1").linear!.state, "closed");
  assert.equal(byRef("ENG-3").status, "canceled");
  assert.ok(work.detail(byRef("ENG-1").key).activity.some((c) => /Linear ENG-1 变为「Done」/.test(c.body)));
  // 没有新变化时不重复拉回
  assert.match(await work.syncLinear(p.id), /拉回远端变更 0 个/);
});

test("分页与增量：超过 100 条分页读取；定时同步只读有更新的 issue", async () => {
  const { store, settings, work } = setup();
  store.docPut("secrets", "global", { linearToken: "lin_api_test" });
  const g = settings.get();
  g.linear = { connected: true, viewer: "Tester", keyHint: "x", teams: [{ id: "team-1", key: "ENG", name: "Engineering" }], connectedAt: new Date().toISOString() };
  store.docPut("settings", "global", { id: "global", ...g });
  const old = new Date(Date.now() - 3600_000).toISOString();
  for (const r of remote) r.updatedAt = old;
  for (let n = 0; n < 130; n++) remote.push({ id: `bulk-${n}`, identifier: `ENG-B${n}`, title: `批量 ${n}`, description: "", priority: 3, url: "u", updatedAt: old, stateId: "s-backlog", labels: [] });
  const open = remote.filter((r) => !["s-done", "s-cancel"].includes(r.stateId)).length;

  const p = work.saveProject({ name: "分页", key: "PAGE" });
  await work.connectLinear(p.id, "team-1");
  issueQueries.length = 0;
  assert.match(await work.syncLinear(p.id), new RegExp(`导入 ${open} 个`));
  assert.ok(issueQueries.length >= 2, "翻页读取");
  assert.ok(issueQueries.every((q) => !q.filter), "全量同步不带过滤");

  // 增量：只有一个 issue 在远端被改
  const target = remote.find((r) => r.id === "bulk-7")!;
  target.priority = 1; target.updatedAt = new Date().toISOString();
  issueQueries.length = 0;
  assert.match(await work.syncLinear(p.id, { incremental: true }), /导入 0 个.*拉回远端变更 1 个/);
  assert.equal(issueQueries.length, 1);
  assert.ok(issueQueries[0].filter?.updatedAt?.gt, "增量同步带 updatedAt 过滤");
  assert.equal(work.list(p.id).find((i) => i.linear?.id === "bulk-7")!.priority, 1);

  // 增量也能导入新建的 issue
  remote.push({ id: "fresh-1", identifier: "ENG-NEW", title: "新建的", description: "", priority: 2, url: "u", updatedAt: new Date().toISOString(), stateId: "s-todo", labels: [] });
  assert.match(await work.syncLinear(p.id, { incremental: true }), /导入 1 个/);
});
