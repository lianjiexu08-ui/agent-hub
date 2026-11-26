import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/db.ts";
import { Runtime } from "../src/runtime.ts";
import { simulatedLLM } from "../src/simulate.ts";
import { AgentSchema } from "../src/types.ts";

test("CLI 运行中：对话记录边跑边存（节流），界面不用等运行结束", async () => {
  const store = new Store(":memory:");
  store.upsertAgent(AgentSchema.parse({ name: "fe", description: "fe", runtime: "pi" }));
  const runtime = new Runtime(store, simulatedLLM({ delayMs: [1, 1] }), { maxConcurrency: 1, maxDepth: 1, maxHops: 1 });
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  runtime.cli = {
    run: async (_task, _agent, ctx) => {
      const t: { role: "user" | "assistant"; content: string }[] = [{ role: "user", content: "做页面" }];
      t.push({ role: "assistant", content: "先读代码" }); ctx.progress?.(t as never);
      t.push({ role: "assistant", content: "开始写组件" }); ctx.progress?.(t as never);
      await gate; // 运行还没结束
      return { result: "完成", transcript: [...t, { role: "assistant", content: "完成" }] as never };
    },
  };
  const task = runtime.submit("fe", "做页面");
  const t0 = Date.now();
  while (store.getMessages(task.id).length < 3) {
    if (Date.now() - t0 > 4000) throw new Error("运行中没有存下对话记录");
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(store.getTask(task.id)!.status, "running");
  assert.equal(store.getMessages(task.id).length, 3, "两次连续推送合并成一次写入（最新的完整记录）");
  release();
  const done = await runtime.waitFor(task.id, 3000);
  assert.equal(done.status, "completed");
  assert.equal(store.getMessages(task.id).length, 4, "结束时写入完整记录");
});
