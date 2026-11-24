import { test } from "node:test";
import assert from "node:assert/strict";
import type {
  BetaMessage,
  BetaMessageParam,
  MessageCreateParamsNonStreaming,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { Store } from "../src/db.ts";
import { Runtime, type LLM } from "../src/runtime.ts";
import { AgentSchema } from "../src/types.ts";

type Block = { type: "text"; text: string } | { type: "tool_use"; name: string; input: unknown };
/** 脚本化假模型：根据智能体名和当前消息决定输出 */
type Script = (ctx: { agent: string; messages: BetaMessageParam[]; params: MessageCreateParamsNonStreaming }) => Block[];

let seq = 0;
function fakeLLM(scripts: Record<string, Script>, delayMs = 5): LLM & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async create(params, { signal }) {
      const agent = /智能体「(.+?)」/.exec(String(params.system))![1];
      calls.push(agent);
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, delayMs);
        signal.addEventListener("abort", () => (clearTimeout(t), reject(new Error("aborted"))));
      });
      const blocks = scripts[agent]({ agent, messages: params.messages, params });
      const content = blocks.map((b) => (b.type === "tool_use" ? { ...b, id: `toolu_${++seq}` } : b));
      return {
        id: `msg_${seq}`,
        type: "message",
        role: "assistant",
        model: params.model,
        content,
        stop_reason: blocks.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn",
        stop_details: null,
        usage: { input_tokens: 10, output_tokens: 5 },
      } as unknown as BetaMessage;
    },
  };
}

/** 取最后一条 user 消息里的 tool_result 文本 */
function toolResults(messages: BetaMessageParam[]): string[] | null {
  const last = messages.at(-1)!;
  if (!Array.isArray(last.content)) return null;
  const r = last.content.filter((b) => b.type === "tool_result");
  const flat = (c: unknown) =>
    typeof c === "string" ? c : (c as { type: string; text?: string }[]).map((x) => x.text ?? `[${x.type}]`).join("");
  return r.length ? r.map((b) => flat((b as { content: unknown }).content)) : null;
}

const text = (t: string): Block => ({ type: "text", text: t });
const call = (name: string, input: unknown): Block => ({ type: "tool_use", name, input });

function setup(
  agents: object[],
  scripts: Record<string, Script>,
  opts: { maxConcurrency?: number; maxDepth?: number; maxHops?: number; llmDelay?: number } = {},
) {
  const store = new Store(":memory:");
  agents.forEach((a) => store.upsertAgent(AgentSchema.parse(a)));
  const llm = fakeLLM(scripts, opts.llmDelay ?? 5);
  const runtime = new Runtime(store, llm, {
    maxConcurrency: opts.maxConcurrency ?? 4,
    maxDepth: opts.maxDepth ?? 3,
    maxHops: opts.maxHops ?? 3,
  });
  return { store, runtime, llm };
}

test("中心编排：并行委派两个 worker 并汇总", async () => {
  const { runtime, store } = setup(
    [
      { name: "boss", delegation: "any" },
      { name: "a", delegation: "none" },
      { name: "b", delegation: "none" },
    ],
    {
      boss: ({ messages }) => {
        const r = toolResults(messages);
        if (!r) return [call("call_agent", { agent: "a", task: "做 A" }), call("call_agent", { agent: "b", task: "做 B" })];
        return [text(`汇总：${r.join(" + ")}`)];
      },
      a: () => [text("A 完成")],
      b: () => [text("B 完成")],
    },
  );
  const task = runtime.submit("boss", "目标", { priority: 2 });
  const done = await runtime.waitFor(task.id);
  assert.equal(done.status, "completed");
  assert.equal(done.result, "汇总：A 完成 + B 完成");
  const children = store.listTasks({ parentId: task.id });
  assert.equal(children.length, 2);
  assert.ok(children.every((c) => c.depth === 1 && c.rootId === task.id && c.source === "delegate" && c.priority === 2));
});

test("调度优先级：槽位紧张时高优先级先获得执行机会", async () => {
  const started: string[] = [];
  const { runtime } = setup(
    [{ name: "long", delegation: "none" }, { name: "low", delegation: "none" }, { name: "high", delegation: "none" }],
    {
      long: () => { started.push("long"); return [text("long")]; },
      low: () => { started.push("low"); return [text("low")]; },
      high: () => { started.push("high"); return [text("high")]; },
    },
    { maxConcurrency: 1, llmDelay: 60 },
  );
  const first = runtime.submit("long", "占住唯一的执行槽", { priority: 3 });
  await new Promise((r) => setTimeout(r, 10)); // 等它真正拿到槽位
  const low = runtime.submit("low", "低优先级", { priority: 4 });
  const high = runtime.submit("high", "高优先级", { priority: 1 });
  await Promise.all([runtime.waitFor(first.id), runtime.waitFor(low.id), runtime.waitFor(high.id)]);
  assert.deepEqual(started, ["long", "high", "low"]);
  assert.equal(low.priority, 4);
  assert.equal(high.priority, 1);
});

test("对等调用：无权限的委派返回工具错误", async () => {
  const { runtime } = setup(
    [
      { name: "x", delegation: ["y"] },
      { name: "y", delegation: "none" },
      { name: "z", delegation: "none" },
    ],
    {
      x: ({ messages }) => {
        const r = toolResults(messages);
        return r ? [text(r[0])] : [call("call_agent", { agent: "z", task: "hi" })];
      },
      y: () => [text("y")],
      z: () => [text("z")],
    },
  );
  const done = await runtime.waitFor(runtime.submit("x", "go").id);
  assert.match(done.result!, /没有权限/);
});

test("委派深度上限阻止无限递归", async () => {
  const { runtime, store } = setup([{ name: "loop", delegation: "any" }], {
    loop: ({ messages }) => {
      const r = toolResults(messages);
      return r ? [text(`stop: ${r[0]}`)] : [call("call_agent", { agent: "loop", task: "再来一次" })];
    },
  });
  const root = runtime.submit("loop", "start");
  const done = await runtime.waitFor(root.id);
  assert.equal(done.status, "completed");
  const all = store.listTasks({ rootId: root.id });
  assert.equal(Math.max(...all.map((t) => t.depth)), 3);
});

test("消息总线：订阅者被唤醒，环路在 maxHops 处停止", async () => {
  const { runtime, store } = setup(
    [
      { name: "ping", subscribe: ["pong-topic"] },
      { name: "pong", subscribe: ["ping-topic"] },
    ],
    {
      ping: ({ messages }) => (toolResults(messages) ? [text("ok")] : [call("publish", { topic: "ping-topic", content: "ping" })]),
      pong: ({ messages }) => (toolResults(messages) ? [text("ok")] : [call("publish", { topic: "pong-topic", content: "pong" })]),
    },
  );
  runtime.publish("ping-topic", "开始", { sender: "user" });
  // 等所有任务结束
  for (let i = 0; i < 200; i++) {
    await new Promise((r) => setTimeout(r, 10));
    const tasks = store.listTasks();
    if (tasks.length && tasks.every((t) => ["completed", "failed"].includes(t.status))) break;
  }
  const tasks = store.listTasks();
  assert.equal(tasks.length, 3); // hops 1,2,3 后停止
  assert.deepEqual(tasks.map((t) => t.hops).sort(), [1, 2, 3]);
  assert.equal(store.readTopic("ping-topic").length + store.readTopic("pong-topic").length, 4);
});

test("取消会级联到子任务", async () => {
  const { runtime, store } = setup(
    [
      { name: "p", delegation: "any" },
      { name: "slow", delegation: "none" },
    ],
    {
      p: ({ messages }) => (toolResults(messages) ? [text("done")] : [call("call_agent", { agent: "slow", task: "慢活" })]),
      slow: () => [text("never")],
    },
  );
  const root = runtime.submit("p", "go");
  await new Promise((r) => setTimeout(r, 8)); // p 第一轮结束、子任务已创建
  const child = await (async () => {
    for (let i = 0; i < 50; i++) {
      const c = store.listTasks({ parentId: root.id })[0];
      if (c) return c;
      await new Promise((r) => setTimeout(r, 2));
    }
    throw new Error("no child");
  })();
  runtime.cancel(root.id);
  assert.equal(store.getTask(root.id)!.status, "cancelled");
  assert.equal(store.getTask(child.id)!.status, "cancelled");
});

test("请求参数：effort、fallbacks、工具集按配置生成", async () => {
  let captured: MessageCreateParamsNonStreaming | undefined;
  const { runtime } = setup([{ name: "w", effort: "low", serverTools: ["web_search"] }], {
    w: ({ params }) => ((captured = params), [text("hi")]),
  });
  await runtime.waitFor(runtime.submit("w", "x").id);
  assert.equal(captured!.model, "claude-opus-5-5");
  assert.deepEqual(captured!.output_config, { effort: "low" });
  assert.equal(captured!.fallbacks, "default");
  const names = captured!.tools!.map((t) => ("name" in t ? t.name : t.type));
  assert.deepEqual(names, ["publish", "read_topic", "web_search"]); // delegation none => 无 call_agent
});

test("自定义 webhook 工具与 MCP 工具", async () => {
  const { createServer } = await import("node:http");
  let webhookBody: any;
  const http = createServer((req, res) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      webhookBody = JSON.parse(data);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ content: `天气晴，城市=${webhookBody.input.city}` }));
    });
  });
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
  const port = (http.address() as { port: number }).port;

  let seenTools: string[] = [];
  const { runtime, store } = setup([{ name: "u", tools: ["weather"], mcp: ["echo", "missing"] }], {
    u: ({ messages, params }) => {
      seenTools = params.tools!.map((t) => ("name" in t ? t.name : t.type));
      const r = toolResults(messages);
      if (!r)
        return [
          call("weather", { city: "杭州" }),
          call("mcp__echo__add", { a: 2, b: 3 }),
          call("mcp__echo__boom", {}),
        ];
      return [text(r.join(" | "))];
    },
  });
  store.upsertTool({
    name: "weather",
    description: "查天气",
    input_schema: { type: "object", properties: { city: { type: "string" } } },
    url: `http://127.0.0.1:${port}/hook`,
    headers: {},
    timeoutMs: 5000,
  });
  store.upsertMcpServer({
    name: "echo",
    transport: "stdio",
    command: process.execPath,
    args: [new URL("./fixtures/echo-mcp.ts", import.meta.url).pathname],
    env: {},
    timeoutMs: 10_000,
  });
  try {
    const task = runtime.submit("u", "go");
    const done = await runtime.waitFor(task.id, 20_000);
    assert.equal(done.status, "completed", done.error ?? "");
    assert.ok(seenTools.includes("weather") && seenTools.includes("mcp__echo__add") && seenTools.includes("mcp__echo__boom"));
    assert.match(done.result!, /天气晴，城市=杭州/);
    assert.match(done.result!, /\| 5 \|/);
    assert.equal(webhookBody.context.agent, "u");
    // MCP 的 isError 透传为 tool_result.is_error；不可用的服务器以提示告知模型
    const msgs = store.getMessages(task.id);
    const results = (msgs[2].content as any[]).filter((b) => b.type === "tool_result");
    assert.equal(results[2].is_error, true);
    assert.match(String(msgs[0].content), /MCP 服务器 missing 不可用/);
  } finally {
    http.close();
    await runtime.mcp.closeAll();
  }
});
