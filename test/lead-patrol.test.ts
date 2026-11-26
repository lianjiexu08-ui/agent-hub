/**
 * 负责人例行巡检要花一次完整的模型调用：工作项状态没变、上次巡检没结束、或间隔太短时跳过。
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

test("巡检：状态没变不重复巡检；有变化且间隔够了才巡检", async () => {
  const store = new Store(":memory:");
  store.upsertAgent(AgentSchema.parse({ name: "project-lead", description: "l" }));
  const settings = new Settings(store);
  const runtime = new Runtime(store, simulatedLLM({ delayMs: [1, 1] }), { maxConcurrency: 2, maxDepth: 1, maxHops: 1 });
  const work = new Work(store, runtime, { notify: new Notifier(store, () => settings.get().notify), settings, github: new GitHub(() => null), linear: new Linear(() => null), workspace: new Workspace("/tmp/agent-hub-test-ws", () => null), simulate: false });
  work.patrolGapMs = 0;
  const p = work.saveProject({ name: "演示", key: "LP" });
  work.setLead(p.id, { mode: "autopilot" });
  await work.create({ projectId: p.id, title: "A", status: "backlog" });
  const patrols = () => store.listTasks({}).filter((t) => t.agent === "project-lead").length;
  await work.leadTick();
  assert.equal(patrols(), 1);
  await work.leadTick();
  assert.equal(patrols(), 1, "上次巡检还在跑");
  await runtime.waitFor(store.listTasks({}).find((t) => t.agent === "project-lead")!.id);
  await work.leadTick();
  assert.equal(patrols(), 1, "工作项状态没变，不再巡检");
  await work.create({ projectId: p.id, title: "B", status: "backlog" });
  await work.leadTick();
  assert.equal(patrols(), 2, "有变化，再巡检一次");
  work.patrolGapMs = 3600_000;
  await runtime.waitFor(store.listTasks({}).filter((t) => t.agent === "project-lead").at(-1)!.id);
  await work.create({ projectId: p.id, title: "C", status: "backlog" });
  await work.leadTick();
  assert.equal(patrols(), 2, "间隔不到，跳过");
});
