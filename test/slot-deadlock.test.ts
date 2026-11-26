/**
 * CLI 槽位：任务阻塞等待别的任务时让出槽位，否则「占着槽位等」和「等槽位开始」互相卡死。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/db.ts";
import { Runtime } from "../src/runtime.ts";
import { PrioritySlots } from "../src/slots.ts";
import { simulatedLLM } from "../src/simulate.ts";
import { AgentSchema } from "../src/types.ts";

function setup(limit: number) {
  const store = new Store(":memory:");
  for (const name of ["dev", "tester"]) store.upsertAgent(AgentSchema.parse({ name, description: name, runtime: "claude-code", delegation: "any" }));
  const runtime = new Runtime(store, simulatedLLM({ delayMs: [1, 1] }), { maxConcurrency: 4, maxDepth: 3, maxHops: 3 });
  const slots = new PrioritySlots(limit);
  let peak = 0;
  runtime.cli = {
    acquire: async (_rt, priority, signal) => {
      const release = await slots.acquire(priority, signal);
      peak = Math.max(peak, slots.running);
      return release;
    },
    // dev：像 report_phase(do) 那样，提交一个 tester 任务并阻塞等它的结果
    run: async (task) => {
      if (task.agent === "dev") {
        const child = runtime.submit("tester", `测 ${task.input}`);
        const done = await runtime.waiting(task.id, () => runtime.waitFor(child.id, 5000));
        return { result: `dev 完成，测试：${done.result}` };
      }
      await new Promise((r) => setTimeout(r, 20));
      return { result: "通过" };
    },
  };
  return { runtime, slots, peak: () => peak };
}

test("并发上限 1：开发任务等测试时让出槽位，测试能开始，开发再拿回槽位收尾", async () => {
  const { runtime, slots, peak } = setup(1);
  const dev = runtime.submit("dev", "S2T-2");
  const done = await runtime.waitFor(dev.id, 5000);
  assert.equal(done.status, "completed");
  assert.equal(done.result, "dev 完成，测试：通过");
  assert.equal(peak(), 1, "任何时刻都不超过上限");
  assert.equal(slots.running, 0, "全部归还");
});

test("并发上限 2、两个开发任务同时等测试（S2T-2 / S2T-6 的实际情况）：不再卡死", async () => {
  const { runtime, slots } = setup(2);
  const a = runtime.submit("dev", "S2T-2");
  const b = runtime.submit("dev", "S2T-6");
  const [x, y] = await Promise.all([runtime.waitFor(a.id, 5000), runtime.waitFor(b.id, 5000)]);
  assert.deepEqual([x.status, y.status], ["completed", "completed"]);
  assert.equal(slots.running, 0);
});
