/**
 * 哨兵：阶段超时但心跳正常（还在干活，只是慢）时，只提醒和上报，不重启 / 改派；没有心跳才重启。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/db.ts";
import { Automation } from "../src/automation.ts";

// 构造函数会注册定时器：测试里让它们不阻止进程退出
const realSetInterval = globalThis.setInterval;
globalThis.setInterval = ((fn: () => void, ms: number) => { const t = realSetInterval(fn, ms); t.unref(); return t; }) as typeof setInterval;

function setup(h: { phaseMin: number; idleMin: number }, issues: unknown[] = []) {
  const store = new Store(":memory:");
  const acts: string[] = [];
  const work = {
    health: () => [{ key: "S2T-11", title: "前端框架", projectId: "p", agent: "frontend-dev", phase: "do", phaseMin: h.phaseMin, idleMin: h.idleMin, blocked: false, blockedMin: 0, testing: false }],
    list: () => issues,
    sentinelAct: async (_k: string, action: string, extra: { alive?: boolean }) => { acts.push(`${action}${extra.alive ? "(alive)" : ""}`); },
    retryFailed: async (k: string) => { acts.push(`retry ${k}`); return true; },
    resumeBudgetHeld: async () => 0,
    sweepWorkspaces: async () => 0,
  };
  const qa = { runs: () => [] };
  const auto = new Automation(store, { events: { emit: () => true } } as never, work as never, qa as never, {} as never, { sentinelMs: 1e9, leadMs: 1e9 });
  return { auto, acts, h };
}

test("超时但心跳正常：提醒一次，过半个时限再上报，不重启也不改派", async () => {
  const { auto, acts } = setup({ phaseMin: 50, idleMin: 0 }); // do 阶段默认时限 45 分钟
  for (let n = 0; n < 5; n++) await auto.sentinel(); // 每分钟巡检一次
  assert.deepEqual(acts, ["nudge(alive)"], "紧接着的几次巡检不升级");
  const st = auto["state"].get("S2T-11")!;
  st.lastAt = new Date(Date.now() - 30 * 60000).toISOString(); // 过了半个时限
  await auto.sentinel();
  await auto.sentinel();
  assert.deepEqual(acts, ["nudge(alive)", "escalate(alive)"], "上报后不再重复");
  st.lastAt = new Date(Date.now() - 60 * 60000).toISOString();
  await auto.sentinel();
  assert.ok(!acts.some((a) => a.startsWith("restart") || a.startsWith("reassign")));
});

test("没有心跳（真卡住）：直接重启", async () => {
  const { auto, acts } = setup({ phaseMin: 20, idleMin: 15 });
  await auto.sentinel();
  assert.deepEqual(acts, ["restart"]);
});

test("基础设施原因中断（有续跑点）的运行即使显示「已取消」也自动重试；人主动停止的不重试", async () => {
  const issues = [
    { key: "S2T-11", status: "todo", priority: 1, runs: 1, lastRun: { id: "r1", status: "cancelled" }, resumeFrom: "review" },
    { key: "S2T-12", status: "todo", priority: 1, runs: 1, lastRun: { id: "r2", status: "cancelled" }, resumeFrom: null },
  ];
  const { auto, acts } = setup({ phaseMin: 0, idleMin: 0 }, issues);
  await auto.sentinel();
  assert.deepEqual(acts.filter((a) => a.startsWith("retry")), ["retry S2T-11"]);
});

test("自动重试上限按连续失败次数：跑过很多轮的工作项，只要最近只失败一次就重试", async () => {
  const issues = [
    { key: "S2T-19", status: "todo", priority: 1, runs: 5, failStreak: 1, lastRun: { id: "r9", status: "failed", error: "x" }, resumeFrom: "do" },
    { key: "S2T-30", status: "todo", priority: 1, runs: 2, failStreak: 2, lastRun: { id: "r8", status: "failed", error: "y" }, resumeFrom: "do" },
  ];
  const { auto, acts } = setup({ phaseMin: 0, idleMin: 0 }, issues);
  await auto.sentinel();
  assert.deepEqual(acts.filter((a) => a.startsWith("retry")), ["retry S2T-19"], "连续失败 2 次的不再自动重试");
});

test("额度用完：恢复时间之前不重试，到点后重试", async () => {
  const issues = [
    { key: "S2T-12", status: "todo", priority: 1, runs: 3, failStreak: 0, lastRun: { id: "q1", status: "failed", error: "Usage limit reached" }, resumeFrom: "do", quotaUntil: new Date(Date.now() + 600_000).toISOString() },
    { key: "S2T-13", status: "todo", priority: 1, runs: 3, failStreak: 0, lastRun: { id: "q2", status: "failed", error: "Usage limit reached" }, resumeFrom: "do", quotaUntil: new Date(Date.now() - 1000).toISOString() },
  ];
  const { auto, acts } = setup({ phaseMin: 0, idleMin: 0 }, issues);
  await auto.sentinel();
  assert.deepEqual(acts.filter((a) => a.startsWith("retry")), ["retry S2T-13"]);
  issues[0].quotaUntil = new Date(Date.now() - 1000).toISOString();
  await auto.sentinel();
  assert.deepEqual(acts.filter((a) => a.startsWith("retry")), ["retry S2T-13", "retry S2T-12"], "到点后补上");
});
