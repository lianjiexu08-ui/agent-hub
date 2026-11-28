/**
 * 验收（测试阶段）被重启打断：测试由 Hub 在 report_phase(do) 里跑，智能体汇报不了「测试」。
 * 恢复时退回执行阶段末尾，让智能体重新 report_phase(do) 触发验收，而不是让它「接着测试」然后提前收工。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
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

test("重启时正在验收：退回执行阶段，续跑提示要求重新 report_phase(do)", async () => {
  const store = new Store(":memory:");
  store.upsertAgent(AgentSchema.parse({ name: "developer", description: "developer" }));
  const settings = new Settings(store);
  const runtime = new Runtime(store, simulatedLLM({ delayMs: [5000, 6000] }), { maxConcurrency: 1, maxDepth: 1, maxHops: 1 });
  const work = new Work(store, runtime, { notify: new Notifier(store, () => settings.get().notify), settings, github: new GitHub(() => null), linear: new Linear(() => null), workspace: new Workspace("/tmp/agent-hub-test-ws", () => null), simulate: false });
  const p = work.saveProject({ name: "演示", key: "RT" });
  const v = await work.create({ projectId: p.id, title: "审计日志", status: "backlog" });
  const i = work.find(v.key);
  const t0 = new Date().toISOString();
  Object.assign(i, { status: "in_progress", assignee: "developer", cycle: 1, phase: "test", phases: [
    { phase: "do", cycle: 1, result: "pass", startedAt: t0, endedAt: t0, note: "" },
    { phase: "test", cycle: 1, result: "active", startedAt: t0, endedAt: null, note: "" },
  ] });
  store.docPut("issues", i.id, i);
  (work as unknown as { reconcile: () => void }).reconcile();
  const cur = work.find(v.key);
  assert.equal(cur.phase, "do");
  assert.equal(cur.retest, true);
  assert.equal(cur.phases.find((r) => r.phase === "test")?.result, "cancelled");
  const input = (work as unknown as { continueInput: (x: typeof cur) => string }).continueInput(cur);
  assert.match(input, /report_phase\(phase="do"\)/);
  assert.match(input, /不要自己汇报测试阶段/);
  // 不让 3 秒后的自动续跑真的拉起运行
  cur.status = "done";
  store.docPut("issues", cur.id, cur);
});
