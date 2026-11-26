/**
 * 工作项依赖：依赖完成（或 PR 合并）后才开始执行。用演示模式的脚本化模型跑完整生命周期。
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

const qas: QA[] = [];
after(() => qas.forEach((q) => q.stop()));

function setup(delayMs: [number, number] = [2, 6]) {
  const store = new Store(":memory:");
  for (const name of ["developer", "tester", "project-lead"]) store.upsertAgent(AgentSchema.parse({ name, description: name }));
  const settings = new Settings(store);
  const runtime = new Runtime(store, simulatedLLM({ delayMs, reviewFailRate: 0 }), { maxConcurrency: 8, maxDepth: 3, maxHops: 3 });
  const work = new Work(store, runtime, { notify: new Notifier(store, () => settings.get().notify), settings, github: new GitHub(() => null), linear: new Linear(() => null), workspace: new Workspace("/tmp/agent-hub-test-ws", () => null), simulate: true });
  const qa = new QA(store, runtime, settings, (id) => work.proj(id), true, { stepMs: 1 });
  qa.forceFail = false;
  work.qa = qa;
  qas.push(qa);
  const p = work.saveProject({ name: "演示", key: "DEP" });
  return { work, p, runtime, settings };
}
const DESC = "做一个功能。\n\n验收标准：\n- 页面正常显示\n- 接口返回 200\n- 有单元测试覆盖";
async function until(fn: () => boolean, ms = 20_000) {
  const t0 = Date.now();
  while (!fn()) { if (Date.now() - t0 > ms) throw new Error("等待超时"); await new Promise((r) => setTimeout(r, 15)); }
}

test("等依赖：依赖完成前不开始，完成后自动开始", async () => {
  const { work, p } = setup();
  const a = await work.create({ projectId: p.id, title: "A 骨架", description: DESC, status: "backlog" });
  const b = await work.create({ projectId: p.id, title: "B 功能", description: DESC, assignee: "developer", dependsOn: [a.key] });
  const vb = () => work.list(p.id).find((i) => i.key === b.key)!;
  assert.equal(vb().status, "todo", "有指派、但等依赖：停在待办");
  assert.equal(vb().waitingDeps, true);
  assert.deepEqual(vb().deps.map((d) => [d.key, d.met]), [[a.key, false]]);
  assert.match(work.detail(b.key).activity.map((c) => c.body).join("\n"), /⏸ 等待依赖 DEP-1「A 骨架」/);
  await assert.rejects(work.run(b.key), /还在等依赖：DEP-1/);

  await work.update(a.key, { status: "done" });
  await until(() => vb().status !== "todo");
  assert.equal(vb().waitingDeps, false);
  assert.match(work.detail(b.key).activity.map((c) => c.body).join("\n"), /▶ 依赖已全部完成（最后一个：DEP-1）/);
});

test("PR 合并即算依赖满足（不必等人最终验收）", async () => {
  const { work, p } = setup();
  await work.connectRepo(p.id, "example/dep");
  const a = await work.create({ projectId: p.id, title: "A 骨架", description: DESC, assignee: "developer" });
  const b = await work.create({ projectId: p.id, title: "B 功能", description: DESC, assignee: "developer", dependsOn: [a.key] });
  const v = (k: string) => work.list(p.id).find((i) => i.key === k)!;
  await until(() => v(a.key).status === "in_review" && !!v(a.key).pr);
  assert.equal(v(b.key).status, "todo", "A 还没合并，B 继续等");
  await work.mergePR(a.key);
  await until(() => v(b.key).status !== "todo");
});

test("多个依赖：全部满足才开始；移除依赖后立即开始", async () => {
  const { work, p } = setup();
  const a = await work.create({ projectId: p.id, title: "A", description: DESC, status: "backlog" });
  const c = await work.create({ projectId: p.id, title: "C", description: DESC, status: "backlog" });
  const b = await work.create({ projectId: p.id, title: "B", description: DESC, assignee: "developer", dependsOn: [a.key, c.key] });
  const vb = () => work.list(p.id).find((i) => i.key === b.key)!;
  await work.update(a.key, { status: "done" });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(vb().status, "todo", "还差 C");
  assert.deepEqual(vb().deps.map((d) => d.met), [true, false]);
  await work.update(b.key, { dependsOn: [a.key] });
  await until(() => vb().status !== "todo");
});

test("依赖校验：不能依赖自己、跨项目、成环", async () => {
  const { work, p } = setup();
  const p2 = work.saveProject({ name: "另一个", key: "OTH" });
  const a = await work.create({ projectId: p.id, title: "A", status: "backlog" });
  const b = await work.create({ projectId: p.id, title: "B", status: "backlog", dependsOn: [a.key] });
  const x = await work.create({ projectId: p2.id, title: "X", status: "backlog" });
  await assert.rejects(work.update(a.key, { dependsOn: [a.key] }), /不能依赖自己/);
  await assert.rejects(work.update(a.key, { dependsOn: [x.key] }), /不在同一个项目里/);
  await assert.rejects(work.update(a.key, { dependsOn: [b.key] }), /循环依赖：DEP-2 已经（间接）依赖 DEP-1/);
  const c = await work.create({ projectId: p.id, title: "C", status: "backlog", dependsOn: [b.key] });
  await assert.rejects(work.update(a.key, { dependsOn: [c.key] }), /循环依赖/, "间接成环也拒绝");
  assert.deepEqual(work.find(a.key).dependsOn ?? [], [], "被拒绝的修改不落库");
});

test("空闲时重启：暂停期间新的运行被挂起，恢复后自动开始", async () => {
  const { work, p } = setup();
  work.pauseStarts = true;
  const a = await work.create({ projectId: p.id, title: "A", description: DESC, assignee: "developer" });
  const va = () => work.list(p.id).find((i) => i.key === a.key)!;
  assert.equal(va().status, "todo");
  assert.equal(work.activeIssueRuns(), 0);
  assert.match(work.detail(a.key).activity.map((c) => c.body).join("\n"), /服务即将重启/);
  // 新进程启动：pauseStarts 默认 false，放行挂起的工作项
  work.pauseStarts = false;
  assert.equal(work.resumeParked(), 1);
  await until(() => va().status !== "todo");
  assert.equal(work.resumeParked(), 0, "不会重复放行");
});

test("运行失败后重试：从中断的阶段继续，不新开一轮；人主动停止的照常新开一轮", async () => {
  const { work, p, runtime } = setup([40, 60]);
  const a = await work.create({ projectId: p.id, title: "A", description: DESC, status: "backlog" });
  await work.update(a.key, { assignee: "developer", status: "todo" });
  const raw = () => work.find(a.key);
  await until(() => ["plan", "do"].includes(raw().phase ?? ""));
  const phase = raw().phase!;
  const run = work.detail(a.key).runList[0];
  runtime.fail(run.id, "连接中断");
  await until(() => raw().status === "todo");
  assert.equal(raw().resumeFrom, phase);
  await work.run(a.key);
  assert.equal(raw().cycle, 1, "仍是第 1 轮");
  assert.match(work.detail(a.key).activity.map((c) => c.body).join("\n"), /从「.+」继续.*仍是第 1 轮|接着上次的进度继续「.+」.*第 1 轮/);
  assert.equal(raw().resumeFrom, null);
  // 人主动停止：不记续跑点
  const r2 = work.detail(a.key).runList[0];
  runtime.cancel(r2.id);
  await until(() => raw().status === "todo");
  assert.ok(!raw().resumeFrom);
});

test("人已批准合并、只是解决了冲突：重新交付后测试通过就直接合并，不再二次审核", async () => {
  const { work, p, settings } = setup();
  settings.patch({ guard: { ...settings.get().guard, maxDiff: 1 } }); // 让护栏必定按改动行数拦下
  await work.connectRepo(p.id, "example/approved");
  await work.setLead(p.id, { mode: "on_demand", mergePolicy: "auto" });
  const a = await work.create({ projectId: p.id, title: "A", description: DESC, assignee: "developer" });
  const raw = () => work.find(a.key);
  await until(() => raw().status === "in_review");
  assert.match(raw().pr!.guard ?? "", /超过自动合并上限/, "第一次交付被护栏拦下，等人审核");
  // 人点了合并，但与主干冲突，交回开发（相当于 fixMergeConflict 由人触发时的状态）
  const i = raw();
  Object.assign(i, { status: "todo", lifecycleDone: false, resumeFrom: "do", mergeApproved: { by: "我", at: new Date().toISOString() } });
  i.pr!.guard = null;
  work["save"](i);
  await work.run(a.key);
  await until(() => raw().pr?.state === "merged");
  assert.equal(raw().mergeApproved, null, "合并后清掉批准记录");
  assert.match(work.detail(a.key).activity.map((c) => c.body).join("\n"), /已于 .* 批准合并，这次只是解决了与主干的冲突/);

  // 没有人批准过的，照样被拦
  const b = await work.create({ projectId: p.id, title: "B", description: DESC, assignee: "developer" });
  await until(() => work.find(b.key).status === "in_review");
  assert.equal(work.find(b.key).pr!.state, "open");
});

test("重启时交付收尾被打断：已走完生命周期的工作项进入审核，而不是打回待办", async () => {
  const { work, p } = setup();
  const a = await work.create({ projectId: p.id, title: "A", description: DESC, status: "backlog" });
  const i = work.find(a.key);
  Object.assign(i, { status: "in_progress", lifecycleDone: true, assignee: "developer", phase: null });
  work["save"](i);
  // 新进程：同一个库上重新构造 Work，构造时对账
  const store = work["store"];
  const again = new Work(store, work["runtime"], { notify: work["notify"], settings: work["settings"], github: work["github"], linear: work["linear"], workspace: work["workspace"], simulate: true });
  assert.equal(again.find(a.key).status, "in_review");
  await until(() => again.detail(a.key).activity.some((c) => /重新进行审核/.test(c.body)));
  assert.ok(!again.detail(a.key).activity.some((c) => /进行中的运行已中断/.test(c.body)));
});

test("预算熔断后：调高预算（或额度重置）时，被暂停的工作项自动继续", async () => {
  const { work, p, settings, runtime } = setup();
  // 先跑一个，制造一点花费
  const warm = await work.create({ projectId: p.id, title: "预热", description: DESC, assignee: "developer" });
  await until(() => work.find(warm.key).status === "in_review");
  settings.patch({ budget: { daily: 0.000001, perIssue: 0, perProject: {} } });
  const a = await work.create({ projectId: p.id, title: "A", description: DESC, assignee: "developer" });
  assert.equal(work.find(a.key).budgetHold, true, "被预算拦下");
  assert.equal(await work.resumeBudgetHeld(), 0, "预算没变：继续等，不重复评论");
  assert.equal(work.detail(a.key).activity.filter((c) => /预算熔断/.test(c.body)).length, 1);
  settings.patch({ budget: { daily: 1000, perIssue: 0, perProject: {} } });
  assert.equal(await work.resumeBudgetHeld(), 1);
  assert.equal(work.find(a.key).budgetHold, false);
  await until(() => work.find(a.key).status !== "todo");
  void runtime;
});

test("自动重试按「最近连续失败」计数：服务重启的中断不算，正常完成过的不影响以后重试", async () => {
  const { work, p, runtime } = setup([40, 60]);
  const a = await work.create({ projectId: p.id, title: "A", description: DESC, assignee: "developer" });
  const streak = () => work.list(p.id).find((i) => i.key === a.key)!.failStreak;
  const failCurrent = async (msg: string) => {
    await until(() => !!work.detail(a.key).runList[0] && work.detail(a.key).runList[0].status === "running");
    runtime.fail(work.detail(a.key).runList[0].id, msg);
    await until(() => work.find(a.key).status === "todo");
  };
  await failCurrent("interrupted by service restart");
  assert.equal(streak(), 0, "服务重启中断不算失败");
  await work.run(a.key);
  await failCurrent("模型调用超时");
  assert.equal(streak(), 1);
  await work.run(a.key);
  await failCurrent("又超时了");
  assert.equal(streak(), 2);
});
