/**
 * Linear 自动执行范围：按指派人 + 状态决定哪些 issue 不用人指派就交给智能体。
 * 用本地假 GraphQL 服务，不访问网络。
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { Store } from "../src/db.ts";
import { Runtime } from "../src/runtime.ts";
import { Settings } from "../src/settings.ts";
import { Notifier } from "../src/notify.ts";
import { GitHub } from "../src/github.ts";
import { Linear, type LinearState } from "../src/linear.ts";
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
type Person = { id: string; name: string };
const ME: Person = { id: "u-me", name: "我" };
const BOB: Person = { id: "u-bob", name: "Bob" };
type Remote = { id: string; identifier: string; title: string; stateId: string; labels: string[]; assignee: Person | null; updatedAt: string };

/** 每个测试一套独立的远端数据 */
let remote: Remote[] = [];
const touch = (id: string, patch: Partial<Remote>) => Object.assign(remote.find((r) => r.id === id)!, patch, { updatedAt: new Date(Date.now() + 1000).toISOString() });
const st = (id: string) => STATES.find((s) => s.id === id)!;

const server = createServer(async (req, res) => {
  let body = "";
  for await (const c of req) body += c;
  const { query, variables } = JSON.parse(body);
  const ok = (data: unknown) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ data })); };
  if (query.includes("members(")) return ok({ team: { members: { nodes: [ME, BOB, { id: "u-amy", name: "Amy" }] } } });
  if (query.includes("states(")) return ok({ team: { states: { nodes: STATES } } });
  if (query.includes("issues(")) {
    const nodes = remote.map((r) => ({ id: r.id, identifier: r.identifier, title: r.title, description: "验收标准：\n- 页面正常\n- 无报错", priority: 3, url: `https://linear.app/x/${r.identifier}`, updatedAt: r.updatedAt, state: st(r.stateId), creator: null, assignee: r.assignee, labels: { nodes: r.labels.map((name) => ({ name })) } }));
    return ok({ team: { issues: { nodes, pageInfo: { hasNextPage: false, endCursor: null } } } });
  }
  if (query.includes("issueUpdate")) {
    // 上一个用例里还在跑的任务可能回写已被替换掉的 issue：照常应答，别让请求挂到超时
    const r = remote.find((x) => x.id === variables.id) ?? { id: variables.id, identifier: "ENG-0", stateId: variables.input.stateId ?? "s-todo" };
    if (variables.input.stateId) r.stateId = variables.input.stateId;
    return ok({ issueUpdate: { success: true, issue: { id: r.id, identifier: r.identifier, url: "", state: st(r.stateId) } } });
  }
  if (query.includes("commentCreate")) return ok({ commentCreate: { success: true } });
  res.statusCode = 400;
  res.end(JSON.stringify({ errors: [{ message: "unknown query" }] }));
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}/graphql`;
const qas: QA[] = [];
after(() => { qas.forEach((q) => q.stop()); server.close(); });

async function setup(issues: Remote[]) {
  remote = issues;
  const store = new Store(":memory:");
  for (const name of ["developer", "frontend-dev", "tester", "project-lead"]) store.upsertAgent(AgentSchema.parse({ name, description: name }));
  const settings = new Settings(store);
  const runtime = new Runtime(store, simulatedLLM({ delayMs: [40, 60], reviewFailRate: 0 }) /* 足够慢：测试里「停止」时运行一定还在进行 */, { maxConcurrency: 8, maxDepth: 3, maxHops: 3 });
  const work = new Work(store, runtime, { notify: new Notifier(store, () => settings.get().notify), settings, github: new GitHub(() => null), linear: new Linear(() => "lin_api_test", endpoint), workspace: new Workspace("/tmp/agent-hub-test-ws", () => null), simulate: true });
  const qa = new QA(store, runtime, settings, (id) => work.proj(id), true, { stepMs: 1 });
  qa.forceFail = false;
  work.qa = qa;
  qas.push(qa);
  const g = settings.get();
  g.linear = { connected: true, viewer: "Tester", keyHint: "lin_…test", teams: [{ id: "team-1", key: "ENG", name: "Engineering" }], connectedAt: new Date().toISOString() };
  store.docPut("settings", "global", { id: "global", ...g });
  const p = work.saveProject({ name: "演示", key: "DEMO" });
  await work.connectLinear(p.id, "team-1");
  const byId = (lid: string) => work.list(p.id).find((i) => i.linear?.id === lid)!;
  const setAuto = (autoRun: unknown) => work.saveProject({ name: "演示", key: "DEMO", linear: { ...work.proj(p.id)!.linear!, autoRun } as never }, p.id);
  return { work, p, byId, setAuto };
}
const now = () => new Date().toISOString();
const issue = (n: number, stateId: string, assignee: Person | null, labels: string[] = []): Remote =>
  ({ id: `lin-${n}`, identifier: `ENG-${n}`, title: `页面问题 ${n}`, stateId, labels, assignee, updatedAt: now() });
async function until(fn: () => boolean, ms = 20_000) {
  const t0 = Date.now();
  while (!fn()) { if (Date.now() - t0 > ms) throw new Error("等待超时"); await new Promise((r) => setTimeout(r, 15)); }
}

test("默认不自动：导入后不指派、不执行", async () => {
  const { work, p, byId } = await setup([issue(1, "s-todo", ME)]);
  await work.syncLinear(p.id);
  assert.equal(byId("lin-1").assignee, null);
  assert.equal(byId("lin-1").status, "todo");
});

test("只做指定成员的 issue，且只认所选状态（默认 Todo）", async () => {
  const { work, p, byId, setAuto } = await setup([issue(1, "s-todo", ME), issue(2, "s-todo", BOB), issue(3, "s-backlog", ME), issue(4, "s-todo", null)]);
  setAuto({ scope: "assignees", assignees: [ME], states: ["todo"] });
  const msg = await work.syncLinear(p.id);
  assert.match(msg, /自动开始执行 1 个/);
  assert.ok(byId("lin-1").assignee, "我的 Todo：自动指派");
  assert.equal(byId("lin-1").status, "in_progress");
  assert.equal(byId("lin-2").assignee, null, "别人的 Todo：不碰");
  assert.equal(byId("lin-3").assignee, null, "我的 Backlog：不在所选状态");
  assert.equal(byId("lin-4").assignee, null, "未指派的：不碰");

  // 在 Linear 上把 Backlog 拖到 Todo → 下次同步接手
  touch("lin-3", { stateId: "s-todo" });
  await work.syncLinear(p.id, { incremental: true });
  await until(() => byId("lin-3").status === "in_progress");

  // 状态可配置：把 Backlog 也纳入后，Backlog 里我的 issue 也会接手
  remote.push(issue(5, "s-backlog", ME));
  setAuto({ scope: "assignees", assignees: [ME], states: ["backlog", "todo"] });
  await work.syncLinear(p.id);
  await until(() => byId("lin-5").status === "in_progress");
});

test("全部自动：团队里所选状态的 issue 都接手", async () => {
  const { work, p, byId, setAuto } = await setup([issue(1, "s-todo", ME), issue(2, "s-todo", BOB), issue(3, "s-todo", null), issue(4, "s-backlog", BOB)]);
  setAuto({ scope: "all", states: ["todo"] });
  await work.syncLinear(p.id);
  for (const id of ["lin-1", "lin-2", "lin-3"]) assert.equal(byId(id).status, "in_progress", id);
  assert.equal(byId("lin-4").assignee, null);
});

test("离开范围：没在跑的取消自动指派；手动取消后不会被反复接回", async () => {
  const { work, p, byId, setAuto } = await setup([issue(1, "s-todo", ME), issue(2, "s-todo", ME)]);
  setAuto({ scope: "assignees", assignees: [ME], states: ["todo"] });
  await work.syncLinear(p.id);
  // 停掉 lin-1 的运行：回到 Todo，指派还在
  await work.stop(byId("lin-1").key);
  await until(() => byId("lin-1").status === "todo" && remote.find((r) => r.id === "lin-1")!.stateId === "s-todo");
  assert.ok(byId("lin-1").assignee);
  // Linear 上改派给 Bob → 取消自动指派，不再执行
  touch("lin-1", { assignee: BOB });
  await work.syncLinear(p.id, { incremental: true });
  assert.equal(byId("lin-1").assignee, null);
  assert.equal(byId("lin-1").status, "todo");

  // lin-2：停下后人在 Hub 里手动取消指派，再同步也不会被自动接回
  await work.stop(byId("lin-2").key);
  await until(() => byId("lin-2").status === "todo" && remote.find((r) => r.id === "lin-2")!.stateId === "s-todo");
  await work.update(byId("lin-2").key, { assignee: null });
  await work.syncLinear(p.id);
  assert.equal(byId("lin-2").assignee, null, "本次进入范围已经触发过一次");
});

test("bug 自动分诊也遵守自动执行范围", async () => {
  const { work, p, byId, setAuto } = await setup([issue(1, "s-todo", BOB, ["bug"]), issue(2, "s-todo", ME, ["bug"])]);
  // 先只导入，不自动执行
  await work.syncLinear(p.id);
  work.setLead(p.id, { mode: "on_demand" });
  setAuto({ scope: "assignees", assignees: [ME], states: ["backlog"] }); // 状态故意不含 Todo
  await work.leadTick();
  assert.equal(byId("lin-1").assignee, null, "Bob 的 bug：不在范围");
  assert.equal(byId("lin-2").assignee, null, "我的 bug，但状态不在范围");
  setAuto({ scope: "assignees", assignees: [ME], states: ["todo"] });
  await until(() => byId("lin-2").status === "in_progress");
  await work.leadTick();
  assert.equal(byId("lin-1").assignee, null, "Bob 的 bug 仍然不碰");
});

test("可选成员：团队成员列表", async () => {
  const { work, p } = await setup([]);
  const m = await work.linearMembers(p.id);
  assert.deepEqual(m.map((x) => x.id).sort(), ["u-amy", "u-bob", "u-me"]);
});
