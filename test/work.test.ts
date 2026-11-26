/**
 * 工作项生命周期的集成测试：真实的服务端逻辑 + 脚本化模型（不访问网络）。
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/db.ts";
import { Runtime } from "../src/runtime.ts";
import { Settings } from "../src/settings.ts";
import { Notifier } from "../src/notify.ts";
import { GitHub } from "../src/github.ts";
import { Linear } from "../src/linear.ts";
import { Workspace } from "../src/workspace.ts";
import { Work } from "../src/work.ts";
import { QA } from "../src/qa.ts";
import { simulatedLLM } from "../src/simulate.ts";
import { AgentSchema } from "../src/types.ts";
import { assessRequirement } from "../src/quality.ts";
import { nextRun } from "../src/automation.ts";

const qas: QA[] = [];
after(() => qas.forEach((q) => q.stop()));

function setup(opts: { reviewFailRate?: number; qaFail?: boolean | null } = {}) {
  const store = new Store(":memory:");
  for (const name of ["developer", "writer", "tester", "project-lead"]) store.upsertAgent(AgentSchema.parse({ name, description: name, delegation: name === "project-lead" ? "any" : "none" }));
  const settings = new Settings(store);
  const notify = new Notifier(store, () => settings.get().notify);
  const github = new GitHub(() => null);
  const workspace = new Workspace("/tmp/agent-hub-test-ws", () => null);
  const runtime = new Runtime(store, simulatedLLM({ delayMs: [5, 15], reviewFailRate: opts.reviewFailRate ?? 0 }), { maxConcurrency: 8, maxDepth: 3, maxHops: 3 });
  const work = new Work(store, runtime, { notify, settings, github, linear: new Linear(() => null), workspace, simulate: true });
  const qa = new QA(store, runtime, settings, (id) => work.proj(id), true, { stepMs: 2 });
  qa.forceFail = opts.qaFail ?? false;
  work.qa = qa;
  qas.push(qa);
  return { store, settings, notify, work, qa, runtime };
}
const GOOD = "从 CSV 批量创建工作项。\n\n验收标准：\n- 支持标题、描述、负责人、优先级四列\n- 格式错误的行给出行号提示，其余行照常导入\n- 一次最多 500 行";
async function until(fn: () => boolean, ms = 20_000) {
  const t0 = Date.now();
  while (!fn()) { if (Date.now() - t0 > ms) throw new Error("等待超时"); await new Promise((r) => setTimeout(r, 20)); }
}

test("需求质量评分：具体的需求通过门禁，简略的需求被拦下", () => {
  assert.ok(assessRequirement({ title: "批量导入", description: GOOD }).score >= 60);
  const q = assessRequirement({ title: "定价页改版", description: "三档套餐对比表 + 常见问题。" });
  assert.ok(q.score < 60);
  assert.ok(q.questions.length >= 2);
});

test("生命周期：指派后自动执行，走完五个阶段进入待审核，并通知人验收", async () => {
  const { work, notify } = setup();
  const p = work.saveProject({ name: "演示", key: "DEMO" });
  const v = await work.create({ projectId: p.id, title: "工作项支持批量导入 CSV", description: GOOD, assignee: "developer" });
  await until(() => work.list().find((i) => i.key === v.key)!.status === "in_review");
  const i = work.list().find((x) => x.key === v.key)!;
  assert.deepEqual(i.phases.map((r) => `${r.phase}:${r.result}`), ["understand:pass", "plan:pass", "do:pass", "test:pass", "review:pass"]);
  assert.ok(i.cost > 0);
  assert.ok(notify.list().some((n) => n.kind === "review" && n.key === v.key));
  assert.ok(work.detail(v.key).activity.some((c) => c.kind === "agent"));
});

test("需求门禁：评分不足时暂停，人确认需求后继续", async () => {
  const { work, notify } = setup();
  const p = work.saveProject({ name: "演示", key: "DEMO" });
  const v = await work.create({ projectId: p.id, title: "定价页改版", description: "三档套餐对比表 + 常见问题。", assignee: "writer" });
  await until(() => !!work.list().find((i) => i.key === v.key)!.blocked);
  assert.ok(work.attention().some((a) => a.kind === "confirm" && a.issue.key === v.key));
  assert.ok(notify.list().some((n) => n.kind === "confirm"));
  work.confirmRequirement(v.key, "验收标准：\n- 三档套餐对比表\n- 常见问题 6 条");
  await until(() => work.list().find((i) => i.key === v.key)!.status === "in_review");
  const i = work.list().find((x) => x.key === v.key)!;
  assert.equal(i.phases[0].result, "pass");
  assert.match(i.description, /需求确认/);
});

test("测试不通过：回到执行修复；连续 3 次不通过开始新一轮", async () => {
  const { work, qa } = setup({ qaFail: true });
  const p = work.saveProject({ name: "演示", key: "DEMO" });
  const v = await work.create({ projectId: p.id, title: "工作项支持批量导入 CSV", description: GOOD, assignee: "developer" });
  await until(() => work.list().find((i) => i.key === v.key)!.cycle >= 2);
  qa.forceFail = false;
  await until(() => work.list().find((i) => i.key === v.key)!.status === "in_review");
  const seq = work.list().find((x) => x.key === v.key)!.phases.map((r) => `${r.cycle}${r.phase}:${r.result}`);
  assert.deepEqual(seq.slice(0, 9), ["1understand:pass", "1plan:pass", "1do:pass", "1test:fail", "1do:pass", "1test:fail", "1do:pass", "1test:fail", "2understand:pass"]);
});

test("评审不通过：沉淀为项目知识，并重新理解需求开始新一轮", async () => {
  const { work, settings } = setup({ reviewFailRate: 1 });
  const p = work.saveProject({ name: "演示", key: "DEMO" });
  const v = await work.create({ projectId: p.id, title: "工作项支持批量导入 CSV", description: GOOD, assignee: "developer" });
  await until(() => work.list().find((i) => i.key === v.key)!.status === "in_review");
  const i = work.list().find((x) => x.key === v.key)!;
  assert.equal(i.cycle, 2);
  assert.ok(i.phases.some((r) => r.cycle === 1 && r.phase === "review" && r.result === "fail"));
  assert.ok(settings.knowledge(p.id).some((k) => k.kind === "教训" && k.source === "自动沉淀"));
});

test("Hotfix：跳过需求门禁；涉及受保护路径时不自动合并并通知人", async () => {
  const { work, notify } = setup();
  const p = work.saveProject({ name: "演示", key: "DEMO" });
  await work.connectRepo(p.id, "example/demo");
  work.setLead(p.id, { mode: "on_demand" });
  const v = await work.create({ projectId: p.id, title: "登录接口认证失败", hotfix: true });
  await until(() => { const i = work.list().find((x) => x.key === v.key)!; return i.status === "in_review" && !!i.pr?.guard; });
  const i = work.list().find((x) => x.key === v.key)!;
  assert.equal(i.pr!.state, "open");
  assert.match(i.pr!.guard!, /auth/);
  assert.ok(notify.list().some((n) => n.kind === "guard"));
  await work.mergePR(v.key);
  assert.equal(work.list().find((x) => x.key === v.key)!.status, "done");
});

test("自动合并与回滚：负责人审核通过后合并；回滚后回到待规划", async () => {
  const { work } = setup();
  const p = work.saveProject({ name: "演示", key: "DEMO" });
  await work.connectRepo(p.id, "example/demo");
  work.setLead(p.id, { mode: "on_demand" });
  const v = await work.create({ projectId: p.id, title: "工作项支持批量导入 CSV", description: GOOD, assignee: "developer" });
  await until(() => work.list().find((x) => x.key === v.key)!.pr?.state === "merged");
  assert.equal(work.list().find((x) => x.key === v.key)!.status, "in_review");
  await work.rollback(v.key);
  const i = work.list().find((x) => x.key === v.key)!;
  assert.equal(i.pr!.state, "reverted");
  assert.equal(i.status, "backlog");
});

test("预算熔断：超过每日预算时不再发起运行", async () => {
  const { work, settings, notify } = setup();
  settings.patch({ budget: { daily: 0.000001, perIssue: 10, perProject: {} } });
  const p = work.saveProject({ name: "演示", key: "DEMO" });
  const a = await work.create({ projectId: p.id, title: "工作项支持批量导入 CSV", description: GOOD, assignee: "developer" });
  await until(() => work.list().find((x) => x.key === a.key)!.cost > 0);
  const b = await work.create({ projectId: p.id, title: "第二个工作项", description: GOOD, assignee: "developer" });
  const i = work.list().find((x) => x.key === b.key)!;
  assert.equal(i.status, "todo");
  assert.ok(i.budgetHold);
  assert.ok(notify.list().some((n) => n.kind === "budget"));
});

test("智能体只能把状态推进到待审核", async () => {
  const { work } = setup();
  const p = work.saveProject({ name: "演示", key: "DEMO" });
  const v = await work.create({ projectId: p.id, title: "x", description: "" });
  await assert.rejects(() => work.update(v.key, { status: "done" }, "developer"), /最多推进到 in_review/);
});

test("cron：下次运行时间", () => {
  const n = nextRun("0 9 * * *", new Date("2026-11-24T08:30:00"))!;
  assert.equal(n.getHours(), 9);
  assert.equal(n.getMinutes(), 0);
  assert.equal(nextRun("*/5 * * * *", new Date("2026-11-24T08:31:00"))!.getMinutes(), 35);
  assert.equal(nextRun("bad"), null);
});

test("测试队列：高优先级的工作项先执行", async () => {
  const { work, qa, settings } = setup();
  settings.patch({ qa: { schedule: "serial", maxParallel: 1, browser: "local", headless: true } });
  const p = work.saveProject({ name: "演示", key: "DEMO" });
  const low = await work.create({ projectId: p.id, title: "低优先级", description: GOOD, priority: 4 });
  const high = await work.create({ projectId: p.id, title: "高优先级", description: GOOD, priority: 1 });
  const lowRun = qa.enqueue(work.view(work.find(low.key)), "manual");
  const highRun = qa.enqueue(work.view(work.find(high.key)), "manual");
  qa.tick();
  assert.equal(qa.run(highRun)?.priority, 1);
  assert.equal(qa.run(highRun)?.status, "running");
  assert.equal(qa.run(lowRun)?.status, "queued");
  qa.cancel(lowRun);
  qa.cancel(highRun);
});

test("工作项执行：任务继承工作项优先级", async () => {
  const { work, store } = setup();
  const p = work.saveProject({ name: "演示", key: "DEMO" });
  const v = await work.create({ projectId: p.id, title: "紧急修复", description: GOOD, priority: 1, assignee: "developer" });
  await until(() => work.list().find((i) => i.key === v.key)!.status === "in_review");
  const issue = work.find(v.key);
  const run = store.listTasks({ issueId: issue.id, rootsOnly: true })[0];
  assert.equal(run.priority, 1);
});

test("需求门禁：项目负责人能定的直接代为确认，开发继续，不打扰人", async () => {
  const { work, notify, runtime } = setup();
  const p = work.saveProject({ name: "演示", key: "DEMO" });
  work.setLead(p.id, { mode: "on_demand", duties: { bugs: false } as never });
  (runtime as unknown as { callAgent: unknown }).callAgent = async () => ({ taskId: "x", status: "completed", error: null, timedOut: false,
    result: '好的。{"answer":"验收标准：\\n- 三档套餐对比表\\n- 常见问题 6 条","ask":[]}' });
  const v = await work.create({ projectId: p.id, title: "定价页改版", description: "三档套餐对比表 + 常见问题。", assignee: "writer" });
  await until(() => work.list().find((i) => i.key === v.key)!.status === "in_review");
  const i = work.list().find((x) => x.key === v.key)!;
  assert.match(i.description, /常见问题 6 条/);
  assert.ok(!notify.list().some((n) => n.kind === "confirm"), "没有通知人确认需求");
  assert.ok(work.detail(v.key).activity.some((c) => c.kind === "lead" && /代为确认/.test(c.body)));
});

test("需求门禁：项目负责人拿不准的只把剩下的问题转给人，人回答后与负责人的结论合并", async () => {
  const { work, notify, runtime } = setup();
  const p = work.saveProject({ name: "演示", key: "DEMO" });
  work.setLead(p.id, { mode: "on_demand", duties: { bugs: false } as never });
  (runtime as unknown as { callAgent: unknown }).callAgent = async () => ({ taskId: "x", status: "completed", error: null, timedOut: false,
    result: '{"answer":"- 三档套餐对比表","ask":["常见问题要几条，由谁提供内容？"]}' });
  const v = await work.create({ projectId: p.id, title: "定价页改版", description: "三档套餐对比表 + 常见问题。", assignee: "writer" });
  await until(() => { const i = work.list().find((x) => x.key === v.key)!; return !!i.blocked && !i.leadDeciding && i.blocked.length === 1; });
  assert.deepEqual(work.list().find((x) => x.key === v.key)!.blocked, ["常见问题要几条，由谁提供内容？"]);
  assert.ok(notify.list().some((n) => n.kind === "confirm"));
  assert.ok(work.attention().some((a) => a.kind === "confirm" && a.issue.key === v.key));
  work.confirmRequirement(v.key, "常见问题 6 条，运营提供");
  await until(() => work.list().find((i) => i.key === v.key)!.status === "in_review");
  const d = work.list().find((x) => x.key === v.key)!.description;
  assert.match(d, /三档套餐对比表/);
  assert.match(d, /运营提供/);
});
