/**
 * GitHub 同步：远端关闭 / 重新打开拉回、分页读取（本地假 REST 服务）。
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
import { AgentSchema } from "../src/types.ts";

type GhI = { number: number; title: string; body: string; state: "open" | "closed"; state_reason: string | null; labels: { name: string }[]; updated_at: string };
const sinceSeen: string[] = [];
const touch = (i: GhI) => { i.updated_at = new Date().toISOString(); };
// 150 个 open issue，用来验证分页
const issues: GhI[] = Array.from({ length: 150 }, (_, n) => ({ number: n + 1, title: `issue ${n + 1}`, body: "", state: "open", state_reason: null, labels: [], updated_at: new Date(Date.now() - 3600_000).toISOString() }));
const patches: { n: number; body: unknown }[] = [];
/** 打/摘标签的调用记录，用来验证「待审核」标签是否同步 */
const labelCalls: { method: string; n: number; labels?: string[]; label?: string }[] = [];
const server = createServer(async (req, res) => {
  let body = "";
  for await (const c of req) body += c;
  const url = new URL(req.url!, "http://x");
  res.setHeader("content-type", "application/json");
  if (req.method === "GET" && url.pathname === "/repos/o/r") return res.end(JSON.stringify({ default_branch: "main", full_name: "o/r" }));
  if (req.method === "GET" && url.pathname === "/repos/o/r/issues") {
    const st = url.searchParams.get("state");
    const page = Number(url.searchParams.get("page") ?? 1);
    const since = url.searchParams.get("since");
    if (since) sinceSeen.push(since);
    const list = issues.filter((i) => (st === "all" || i.state === "open") && (!since || i.updated_at > since));
    return res.end(JSON.stringify(list.slice((page - 1) * 100, page * 100)));
  }
  const m = /^\/repos\/o\/r\/issues\/(\d+)$/.exec(url.pathname);
  if (req.method === "PATCH" && m) { patches.push({ n: Number(m[1]), body: JSON.parse(body) }); return res.end("{}"); }
  const add = /^\/repos\/o\/r\/issues\/(\d+)\/labels$/.exec(url.pathname);
  if (req.method === "POST" && add) { labelCalls.push({ method: "POST", n: Number(add[1]), labels: JSON.parse(body).labels }); return res.end("[]"); }
  const del = /^\/repos\/o\/r\/issues\/(\d+)\/labels\/(.+)$/.exec(url.pathname);
  if (req.method === "DELETE" && del) { labelCalls.push({ method: "DELETE", n: Number(del[1]), label: decodeURIComponent(del[2]) }); return res.end("{}"); }
  res.statusCode = 404; res.end("{}");
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
after(() => server.close());

test("GitHub：分页导入全部 open issue；远端关闭 / not planned / 重新打开拉回本地", async () => {
  const store = new Store(":memory:");
  store.upsertAgent(AgentSchema.parse({ name: "developer" }));
  const settings = new Settings(store);
  const github = new GitHub(() => "ghp_test", base);
  const runtime = new Runtime(store, simulatedLLM({ delayMs: [1, 2] }), { maxConcurrency: 2, maxDepth: 2, maxHops: 2 });
  const work = new Work(store, runtime, { notify: new Notifier(store, () => settings.get().notify), settings, github, linear: new Linear(() => null), workspace: new Workspace("/tmp/agent-hub-test-ws", () => null), simulate: false });
  const p = work.saveProject({ name: "GH", key: "GH" });
  await work.connectRepo(p.id, "o/r");

  assert.match(await work.sync(p.id), /导入 150 个/);
  const gh = (n: number) => work.list(p.id).find((i) => i.github?.number === n)!;

  issues[0].state = "closed"; issues[0].state_reason = "completed"; touch(issues[0]);
  issues[1].state = "closed"; issues[1].state_reason = "not_planned"; touch(issues[1]);
  patches.length = 0;
  assert.match(await work.sync(p.id), /拉回远端变更 2 个/);
  assert.equal(gh(1).status, "done");
  assert.equal(gh(2).status, "canceled");
  assert.equal(patches.length, 0, "拉回的状态不再推回 GitHub");

  issues[0].state = "open"; issues[0].state_reason = null; touch(issues[0]);
  sinceSeen.length = 0;
  await work.sync(p.id, { incremental: true });
  assert.ok(sinceSeen.length >= 2, "增量同步带 since");
  assert.equal(gh(1).status, "todo");
  assert.equal(gh(1).github!.state, "open");
});


test("GitHub：完成全流程进入待审核时打 in-review 标签，完成后摘掉", async () => {
  const store = new Store(":memory:");
  store.upsertAgent(AgentSchema.parse({ name: "developer" }));
  const settings = new Settings(store);
  const github = new GitHub(() => "ghp_test", base);
  const runtime = new Runtime(store, simulatedLLM({ delayMs: [1, 2] }), { maxConcurrency: 2, maxDepth: 2, maxHops: 2 });
  const work = new Work(store, runtime, { notify: new Notifier(store, () => settings.get().notify), settings, github, linear: new Linear(() => null), workspace: new Workspace("/tmp/agent-hub-test-ws", () => null), simulate: false });
  const p = work.saveProject({ name: "REV", key: "REV" });
  await work.connectRepo(p.id, "o/r");
  await work.sync(p.id);
  const item = work.list(p.id).find((i) => i.github?.number === 3)!;

  labelCalls.length = 0;
  await work.update(item.key, { status: "in_review" });
  assert.deepEqual(labelCalls, [{ method: "POST", n: 3, labels: ["in-review"] }], "进入待审核时打标签");
  assert.equal(work.find(item.key).github!.reviewed, true);

  labelCalls.length = 0;
  await work.update(item.key, { status: "done" });
  assert.ok(labelCalls.some((c) => c.method === "DELETE" && c.n === 3 && JSON.stringify(c).includes("in-review")), "完成后摘掉标签");
  assert.equal(work.find(item.key).github!.reviewed, false);

  // 重复设置同一状态不应重复调用
  labelCalls.length = 0;
  await work.update(item.key, { status: "done" });
  assert.equal(labelCalls.length, 0, "状态没变就不重复打接口");
});
