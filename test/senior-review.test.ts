/**
 * 资深评审代替人放行：只因改动超过行数上限被拦时，交给设置里的评审智能体看整个 PR；
 * 通过就自动合并，需要修改就带着意见交回开发；没开这个设置时照旧等人。
 */
import { test } from "node:test";
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

async function scenario(verdict: string | null, files = ["backend/app/x.py"]) {
  const merged: number[] = [];
  const srv = createServer((req, res) => {
    const send = (d: unknown, code = 200) => { res.statusCode = code; res.setHeader("content-type", "application/json"); res.end(JSON.stringify(d)); };
    const url = req.url ?? "";
    if (url === "/repos/x/y") return send({ full_name: "x/y", default_branch: "main" });
    if (url === "/repos/x/y/pulls/50") return send({ merge_commit_sha: null, base: { ref: "main" }, head: { sha: "h1" } });
    if (url.startsWith("/repos/x/y/compare/")) return send({ behind_by: 0 });
    if (url.includes("/check-runs")) return send({ check_runs: [{ name: "backend", status: "completed", conclusion: "success" }] });
    if (url.startsWith("/repos/x/y/pulls/50/files")) return send(files.map((filename) => ({ filename })));
    if (url === "/repos/x/y/pulls/50/merge") { merged.push(50); return send({ merged: true }); }
    send({}, 404);
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const store = new Store(":memory:");
  for (const n of ["developer", "code-reviewer"]) store.upsertAgent(AgentSchema.parse({ name: n, description: n }));
  const settings = new Settings(store);
  if (verdict !== null) settings.patch({ guard: { ...settings.guard(), reviewer: { agent: "code-reviewer", size: true, paths: ["**/migrations/**"] } } });
  const runtime = new Runtime(store, simulatedLLM({ delayMs: [5000, 6000] }), { maxConcurrency: 2, maxDepth: 1, maxHops: 1 });
  const asked: string[] = [];
  runtime.callAgent = async (_a: string, input: string) => { asked.push(input); return { taskId: "t", status: "completed", result: verdict ?? "", error: null, timedOut: false }; };
  const github = new GitHub(() => "tok", `http://127.0.0.1:${(srv.address() as { port: number }).port}`);
  const work = new Work(store, runtime, { notify: new Notifier(store, () => settings.get().notify), settings, github, linear: new Linear(() => null), workspace: new Workspace("/tmp/agent-hub-test-ws", () => null), simulate: false });
  const p = work.saveProject({ name: "演示", key: "SR" });
  await work.connectRepo(p.id, "x/y");
  work.setLead(p.id, { mode: "on_demand", mergePolicy: "auto" });
  const v = await work.create({ projectId: p.id, title: "推送", status: "backlog" });
  const i = work.find(v.key);
  Object.assign(i, { status: "in_review", assignee: "developer", lifecycleDone: true, pr: { number: 50, branch: "agent/sr-1", state: "open", checks: "passing", tests: "1/1", additions: 2000, deletions: 0, files: 3 } });
  store.docPut("issues", i.id, i);
  await work["afterDeliver"](work.find(v.key));
  const out = { work, merged, asked, i: work.find(v.key), log: work.detail(v.key).activity.map((a: { body: string }) => a.body).join("\n") };
  for (const t of store.listTasks({})) runtime.cancel(t.id);
  srv.close();
  return out;
}

test("改动超限、资深评审通过：自动合并", async () => {
  const s = await scenario("看过了，没有阻塞问题。\n结论：通过");
  assert.deepEqual(s.merged, [50]);
  assert.equal(s.asked.length, 1);
  assert.match(s.asked[0], /PR #50.*超过自动合并上限/s);
  assert.match(s.log, /资深评审通过/);
});

test("资深评审需要修改：不合并，交回开发", async () => {
  const s = await scenario("1. 迁移编号冲突\n结论：需要修改");
  assert.deepEqual(s.merged, []);
  assert.equal(s.i.seniorReviews, 1);
  assert.equal(s.i.resumeFrom, "do");
  assert.match(s.log, /需要修改，已交回 developer/);
});

test("允许的受保护路径（迁移）也由资深评审放行；其余受保护路径仍要人", async () => {
  const ok = await scenario("结论：通过", ["backend/migrations/versions/0008.py"]);
  assert.deepEqual(ok.merged, [50]);
  const ci = await scenario("结论：通过", [".github/workflows/ci.yml"]);
  assert.deepEqual(ci.merged, [], ".github 仍然要人确认");
  assert.equal(ci.asked.length, 0);
  assert.match(ci.i.pr!.guard ?? "", /受保护路径 \.github/);
});

test("没开资深评审：照旧等人确认", async () => {
  const s = await scenario(null);
  assert.deepEqual(s.merged, []);
  assert.equal(s.asked.length, 0);
  assert.match(s.i.pr!.guard ?? "", /超过自动合并上限/);
});
