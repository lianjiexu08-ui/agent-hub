/**
 * 真实 CI 结果：汇总 check runs；CI 失败时人合并会被拦下，可以确认后「仍然合并」。用本地假 GitHub 服务。
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { Store } from "../src/db.ts";
import { Runtime } from "../src/runtime.ts";
import { Settings } from "../src/settings.ts";
import { Notifier } from "../src/notify.ts";
import { GitHub, summarizeChecks } from "../src/github.ts";
import { Linear } from "../src/linear.ts";
import { Workspace } from "../src/workspace.ts";
import { Work } from "../src/work.ts";
import { simulatedLLM } from "../src/simulate.ts";

test("汇总 check runs：失败优先，其次未完成；跳过算通过；没有 CI 记为 none", () => {
  const run = (name: string, status: string, conclusion: string | null) => ({ name, status, conclusion });
  assert.equal(summarizeChecks("s", []).state, "none");
  assert.equal(summarizeChecks("s", [run("a", "completed", "success"), run("b", "completed", "skipped")]).state, "passing");
  const p = summarizeChecks("s", [run("a", "completed", "success"), run("b", "in_progress", null)]);
  assert.deepEqual([p.state, p.pending], ["pending", ["b"]]);
  const f = summarizeChecks("s", [run("a", "completed", "failure"), run("b", "in_progress", null), run("c", "completed", "timed_out")]);
  assert.deepEqual([f.state, f.failed], ["failing", ["a", "c"]]);
});

let conclusion = "failure";
const merged: number[] = [];
const server = createServer((req, res) => {
  const send = (d: unknown) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(d)); };
  const url = req.url ?? "";
  if (url === "/repos/x/y") return send({ full_name: "x/y", default_branch: "main" });
  if (url === "/repos/x/y/pulls/18" && req.method === "GET") return send({ merge_commit_sha: null, base: { ref: "main" }, head: { sha: "abc1234" } });
  if (url.startsWith("/repos/x/y/commits/abc1234/check-runs")) return send({ check_runs: [{ name: "backend", status: "completed", conclusion: "success" }, { name: "compose smoke", status: "completed", conclusion }] });
  if (url === "/repos/x/y/pulls/18/merge" && req.method === "PUT") { merged.push(18); return send({ merged: true }); }
  res.statusCode = 404; send({ message: "Not Found" });
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
after(() => server.close());

test("CI 失败：人合并被拦下并说明哪个 job；确认后可以仍然合并", async () => {
  const store = new Store(":memory:");
  const settings = new Settings(store);
  const runtime = new Runtime(store, simulatedLLM({ delayMs: [1, 1] }), { maxConcurrency: 1, maxDepth: 1, maxHops: 1 });
  const github = new GitHub(() => "tok", `http://127.0.0.1:${(server.address() as { port: number }).port}`);
  const work = new Work(store, runtime, { notify: new Notifier(store, () => settings.get().notify), settings, github, linear: new Linear(() => null), workspace: new Workspace("/tmp/agent-hub-test-ws", () => null), simulate: false });
  const p = work.saveProject({ name: "演示", key: "CI" });
  await work.connectRepo(p.id, "x/y");
  const v = await work.create({ projectId: p.id, title: "归一化", status: "backlog" });
  const i = work.find(v.key);
  i.status = "in_review";
  i.pr = { number: 18, branch: "agent/ci-1", state: "open", checks: "passing", tests: "6/6", additions: 10, deletions: 0, files: 1 };
  store.docPut("issues", i.id, i);

  await assert.rejects(work.mergePR(v.key), /CI 未通过（compose smoke）/);
  assert.deepEqual(merged, [], "没有合并");
  assert.equal(work.find(v.key).pr!.ci!.state, "failing", "结果记在 PR 上，界面可见");
  await work.mergePR(v.key, true);
  assert.deepEqual(merged, [18]);
  assert.equal(work.find(v.key).status, "done");
});

test("细粒度令牌读不了 check runs：改读 Actions 的运行与 job，同一工作流只看最新一次", async () => {
  const srv = createServer((req, res) => {
    const send = (code: number, d: unknown) => { res.statusCode = code; res.setHeader("content-type", "application/json"); res.end(JSON.stringify(d)); };
    const url = req.url ?? "";
    if (url === "/repos/x/y/pulls/18") return send(200, { merge_commit_sha: null, base: { ref: "main" }, head: { sha: "def5678" } });
    if (url.includes("/check-runs")) return send(403, { message: "Resource not accessible by personal access token" });
    if (url.startsWith("/repos/x/y/actions/runs?head_sha=def5678")) return send(200, { workflow_runs: [
      { id: 1, name: "CI", created_at: "2026-11-25T10:00:00Z" },
      { id: 2, name: "CI", created_at: "2026-11-25T11:00:00Z" }, // 重跑：以这次为准
    ] });
    if (url.startsWith("/repos/x/y/actions/runs/1/jobs")) return send(200, { jobs: [{ name: "compose smoke", status: "completed", conclusion: "failure" }] });
    if (url.startsWith("/repos/x/y/actions/runs/2/jobs")) return send(200, { jobs: [{ name: "compose smoke", status: "completed", conclusion: "success" }, { name: "backend", status: "in_progress", conclusion: null }] });
    send(404, { message: "Not Found" });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  try {
    const gh = new GitHub(() => "tok", `http://127.0.0.1:${(srv.address() as { port: number }).port}`);
    const ci = await gh.ciStatus("x/y", 18);
    assert.deepEqual([ci.state, ci.source, ci.pending, ci.failed], ["pending", "actions", ["backend"], []]);
  } finally { srv.close(); }
});

test("人点合并遇到冲突：不受自动处理次数上限约束，总是交回开发", async () => {
  const srv = createServer((req, res) => {
    const send = (code: number, d: unknown) => { res.statusCode = code; res.setHeader("content-type", "application/json"); res.end(JSON.stringify(d)); };
    const url = req.url ?? "";
    if (url === "/repos/x/y") return send(200, { full_name: "x/y", default_branch: "main" });
    if (url === "/repos/x/y/pulls/30" && req.method === "GET") return send(200, { merge_commit_sha: null, base: { ref: "main" }, head: { sha: "c0ffee1" } });
    if (url.includes("/check-runs")) return send(200, { check_runs: [] });
    if (url === "/repos/x/y/pulls/30/merge") return send(405, { message: "Pull Request has merge conflicts" });
    send(404, { message: "Not Found" });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  try {
    const store = new Store(":memory:");
    store.upsertAgent((await import("../src/types.ts")).AgentSchema.parse({ name: "developer", description: "d" }));
    const settings = new Settings(store);
    const runtime = new Runtime(store, simulatedLLM({ delayMs: [200, 300] }), { maxConcurrency: 2, maxDepth: 1, maxHops: 1 });
    const github = new GitHub(() => "tok", `http://127.0.0.1:${(srv.address() as { port: number }).port}`);
    const work = new Work(store, runtime, { notify: new Notifier(store, () => settings.get().notify), settings, github, linear: new Linear(() => null), workspace: new Workspace("/tmp/agent-hub-test-ws", () => null), simulate: false });
    const p = work.saveProject({ name: "演示", key: "MC" });
    await work.connectRepo(p.id, "x/y");
    const v = await work.create({ projectId: p.id, title: "归一化", status: "backlog" });
    for (let n = 1; n <= 3; n++) {
      const i = work.find(v.key);
      for (const t of runtime["store"].listTasks({ status: "running" })) runtime.cancel(t.id);
      Object.assign(i, { status: "in_review", assignee: "developer", pr: { number: 30, branch: "agent/mc-1", state: "open", checks: "passing", tests: "1/1", additions: 1, deletions: 0, files: 1 } });
      store.docPut("issues", i.id, i);
      await assert.rejects(work.mergePR(v.key), new RegExp(`已安排 developer 合并主干.*第 ${n} 次`));
    }
    assert.equal(work.find(v.key).mergeFixes, 3, "超过 2 次仍然交回");
    for (const t of runtime["store"].listTasks({ status: "running" })) runtime.cancel(t.id);
  } finally { srv.close(); }
});

test("等 CI 期间：进度实时写进 PR，工作项不出现在「需要你处理」", async () => {
  let calls = 0;
  const srv = createServer((req, res) => {
    const send = (d: unknown) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(d)); };
    const url = req.url ?? "";
    if (url === "/repos/x/y") return send({ full_name: "x/y", default_branch: "main" });
    if (url === "/repos/x/y/pulls/24") return send({ merge_commit_sha: null, base: { ref: "main" }, head: { sha: "5e5e5e5" } });
    if (url.includes("/check-runs")) { calls++; return send({ check_runs: [{ name: "backend", status: calls < 3 ? "in_progress" : "completed", conclusion: calls < 3 ? null : "success" }] }); }
    res.statusCode = 404; send({});
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  try {
    const store = new Store(":memory:");
    const settings = new Settings(store);
    const runtime = new Runtime(store, simulatedLLM({ delayMs: [1, 1] }), { maxConcurrency: 1, maxDepth: 1, maxHops: 1 });
    const github = new GitHub(() => "tok", `http://127.0.0.1:${(srv.address() as { port: number }).port}`);
    const work = new Work(store, runtime, { notify: new Notifier(store, () => settings.get().notify), settings, github, linear: new Linear(() => null), workspace: new Workspace("/tmp/agent-hub-test-ws", () => null), simulate: false });
    const p = work.saveProject({ name: "演示", key: "WC" });
    await work.connectRepo(p.id, "x/y");
    const v = await work.create({ projectId: p.id, title: "网关", status: "backlog" });
    const i = work.find(v.key);
    Object.assign(i, { status: "in_review", pr: { number: 24, branch: "agent/wc-1", state: "open", checks: "passing", tests: "5/5", additions: 1, deletions: 0, files: 1 } });
    store.docPut("issues", i.id, i);
    assert.equal(work.attention().length, 1, "等 CI 之前：待验收");
    // 轮询间隔放宽到 300ms，留出足够的「等待中」窗口；不靠固定的 sleep，等到第一次结果写进 PR 再检查
    const waiting = work["waitCi"](work.find(v.key), 10_000, 300) as Promise<{ state: string }>;
    for (const t0 = Date.now(); !work.find(v.key).pr!.ci && Date.now() - t0 < 5000;) await new Promise((r) => setTimeout(r, 10));
    assert.equal(work.attention().length, 0, "等 CI 期间不打扰人");
    assert.equal(work.find(v.key).pr!.ci!.state, "pending", "进度写进 PR");
    assert.equal((await waiting).state, "passing");
    assert.equal(work.attention().length, 1, "等完恢复");
  } finally { srv.close(); }
});

test("CI 未通过：交回开发智能体修复（附失败 job 链接），最多 2 次，之后交给人", async () => {
  const srv = createServer((req, res) => {
    const send = (d: unknown) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(d)); };
    const url = req.url ?? "";
    if (url === "/repos/x/y") return send({ full_name: "x/y", default_branch: "main" });
    if (url === "/repos/x/y/pulls/35") return send({ merge_commit_sha: null, base: { ref: "main" }, head: { sha: "bad5eed" } });
    if (url.includes("/check-runs")) return send({ check_runs: [{ name: "compose smoke", status: "completed", conclusion: "failure", html_url: "https://github.com/x/y/actions/runs/1/job/2" }] });
    if (url.endsWith("/files")) return send([]);
    res.statusCode = 404; send({});
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  try {
    const store = new Store(":memory:");
    store.upsertAgent((await import("../src/types.ts")).AgentSchema.parse({ name: "backend-dev", description: "d" }));
    const settings = new Settings(store);
    const runtime = new Runtime(store, simulatedLLM({ delayMs: [300, 400] }), { maxConcurrency: 2, maxDepth: 1, maxHops: 1 });
    const github = new GitHub(() => "tok", `http://127.0.0.1:${(srv.address() as { port: number }).port}`);
    const work = new Work(store, runtime, { notify: new Notifier(store, () => settings.get().notify), settings, github, linear: new Linear(() => null), workspace: new Workspace("/tmp/agent-hub-test-ws", () => null), simulate: false });
    const p = work.saveProject({ name: "演示", key: "CF" });
    await work.connectRepo(p.id, "x/y");
    work.setLead(p.id, { mode: "on_demand", mergePolicy: "auto" });
    const v = await work.create({ projectId: p.id, title: "并发上限", status: "backlog" });
    const deliver = async () => {
      for (const t of store.listTasks({ status: "running" })) runtime.cancel(t.id);
      const i = work.find(v.key);
      Object.assign(i, { status: "in_review", assignee: "backend-dev", lifecycleDone: true, pr: { number: 35, branch: "agent/cf-1", state: "open", checks: "passing", tests: "3/3", additions: 10, deletions: 0, files: 1, ci: { state: "failing", sha: "bad5eed", failed: ["compose smoke"], pending: [], checkedAt: new Date().toISOString(), failedUrls: ["https://github.com/x/y/actions/runs/1/job/2"] } } });
      store.docPut("issues", i.id, i);
      await work["afterDeliver"](work.find(v.key));
    };
    await deliver();
    const after1 = work.find(v.key);
    assert.equal(after1.ciFixes, 1);
    assert.equal(after1.pr!.guard ?? null, null, "交回修复，不挂护栏等人");
    const bodies = () => work.detail(v.key).activity.map((c) => c.body).join("\n");
    assert.match(bodies(), /CI 没有通过：compose smoke（提交 bad5eed）[\s\S]*actions\/runs\/1\/job\/2[\s\S]*gh run view --log-failed/);
    assert.match(bodies(), /已交回 backend-dev 查看日志并修复（第 1 次）/);
    await deliver();
    assert.equal(work.find(v.key).ciFixes, 2);
    await deliver();
    const after3 = work.find(v.key);
    assert.equal(after3.ciFixes, 2, "超过 2 次不再自动交回");
    assert.match(after3.pr!.guard ?? "", /CI 未通过（compose smoke）/, "交给人");
    assert.equal(after3.pr!.state, "open", "始终没有合并");
    for (const t of store.listTasks({ status: "running" })) runtime.cancel(t.id);
  } finally { srv.close(); }
});

test("CI 失败日志摘要：挑出报错、失败用例和断言，去掉时间戳", async () => {
  const { failureExcerpt } = await import("../src/github.ts");
  const log = [
    "2026-11-26T22:52:16.98Z   ✓  1 [chromium] › e2e/chapter2.spec.ts:23:1 › 主流程 (4.9s)",
    ...Array.from({ length: 50 }, (_, n) => `2026-11-26T22:52:17.00Z noise ${n}`),
    "2026-11-26T22:52:39.59Z   ✘  5 [chromium] › e2e/voice.spec.ts:85:1 › 语音建单 (14.0s)",
    "2026-11-26T22:52:55.84Z     Error: expect(locator).toContainText(expected) failed",
    "2026-11-26T22:52:55.84Z     > 94 |     await expect(user).toContainText('用户 · 语音')",
  ].join("\n");
  const out = failureExcerpt(log);
  assert.match(out, /✘  5 \[chromium\] › e2e\/voice\.spec\.ts/);
  assert.match(out, /Error: expect\(locator\)/);
  assert.doesNotMatch(out, /noise 10/);
  assert.doesNotMatch(out, /2026-11-26T/);
});
