/**
 * 并发：同一个智能体并行执行多个任务；CLI 底座超过并发上限时排队（不失败），按优先级出队。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { BetaMessage } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { Store } from "../src/db.ts";
import { Runtime, type CliExecutor, type LLM } from "../src/runtime.ts";
import { PrioritySlots } from "../src/slots.ts";
import { AgentSchema, type Task } from "../src/types.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("槽位：上限、优先级出队、调大上限立即唤醒、排队时可取消", async () => {
  let limit = 1;
  const slots = new PrioritySlots(() => limit);
  const order: string[] = [];
  const r0 = await slots.acquire(3);
  const low = slots.acquire(4).then((rel) => { order.push("low"); return rel; });
  const high = slots.acquire(1).then((rel) => { order.push("high"); return rel; });
  const ctl = new AbortController();
  const gone = slots.acquire(2, ctl.signal);
  await sleep(5);
  assert.equal(slots.waiting, 3);
  ctl.abort();
  await assert.rejects(gone, /已取消/);
  r0();
  const rHigh = await high;
  assert.deepEqual(order, ["high"]);
  limit = 3; slots.pump();
  const rLow = await low;
  assert.deepEqual(order, ["high", "low"]);
  assert.equal(slots.running, 2);
  rHigh(); rLow();
  assert.equal(slots.running, 0);
});

test("同一个智能体：多个任务并行执行", async () => {
  let inflight = 0, peak = 0;
  const llm: LLM = {
    async create(params) {
      inflight++; peak = Math.max(peak, inflight);
      await sleep(40);
      inflight--;
      return { id: "m", type: "message", role: "assistant", model: params.model, content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", stop_details: null, usage: { input_tokens: 1, output_tokens: 1 } } as unknown as BetaMessage;
    },
  };
  const store = new Store(":memory:");
  store.upsertAgent(AgentSchema.parse({ name: "backend-dev" }));
  const runtime = new Runtime(store, llm, { maxConcurrency: 4, maxDepth: 2, maxHops: 2 });
  const tasks = Array.from({ length: 6 }, (_, n) => runtime.submit("backend-dev", `任务 ${n}`));
  const done = await Promise.all(tasks.map((t) => runtime.waitFor(t.id)));
  assert.ok(done.every((t) => t.status === "completed"));
  assert.equal(peak, 4, "同一智能体并行到模型并发上限");

  // 运行时调整并发上限
  peak = 0;
  runtime.setConcurrency(6);
  const more = Array.from({ length: 6 }, (_, n) => runtime.submit("backend-dev", `再来 ${n}`));
  await Promise.all(more.map((t) => runtime.waitFor(t.id)));
  assert.equal(peak, 6);
});

test("CLI 底座：超过并发上限时排队等待而不是失败，排队期间为 pending，按优先级出队", async () => {
  const slots = new PrioritySlots(() => 2);
  const started: string[] = [];
  let inflight = 0, peak = 0;
  const cli: CliExecutor = {
    acquire: (_rt, priority, signal) => slots.acquire(priority, signal),
    async run(task: Task) {
      started.push(task.input);
      inflight++; peak = Math.max(peak, inflight);
      await sleep(40);
      inflight--;
      return { result: `完成 ${task.input}` };
    },
  };
  const store = new Store(":memory:");
  store.upsertAgent(AgentSchema.parse({ name: "frontend-dev", runtime: "claude-code" }));
  const runtime = new Runtime(store, { create: async () => { throw new Error("不应调用内置模型"); } }, { maxConcurrency: 4, maxDepth: 2, maxHops: 2 });
  runtime.cli = cli;
  const a = runtime.submit("frontend-dev", "A", { priority: 3 });
  const b = runtime.submit("frontend-dev", "B", { priority: 3 });
  await sleep(10);
  const low = runtime.submit("frontend-dev", "低", { priority: 4 });
  const urgent = runtime.submit("frontend-dev", "紧急", { priority: 1 });
  await sleep(10);
  assert.equal(store.getTask(low.id)!.status, "pending", "排队中保持 pending，哨兵不会当成卡住");
  const all = await Promise.all([a, b, low, urgent].map((t) => runtime.waitFor(t.id)));
  assert.ok(all.every((t) => t.status === "completed"), all.map((t) => t.error).join(","));
  assert.equal(peak, 2);
  assert.deepEqual(started.slice(2), ["紧急", "低"]);

  // 排队中取消
  const x = runtime.submit("frontend-dev", "X");
  const y = runtime.submit("frontend-dev", "Y");
  const z = runtime.submit("frontend-dev", "Z");
  await sleep(10);
  runtime.cancel(z.id);
  const res = await Promise.all([x, y, z].map((t) => runtime.waitFor(t.id)));
  assert.deepEqual(res.map((t) => t.status), ["completed", "completed", "cancelled"]);
  assert.ok(!started.includes("Z"));
});
