/**
 * 模型层：OpenAI 兼容协议转换、模型路由、连接探测与模型列表。
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { Store } from "../src/db.ts";
import { Settings } from "../src/settings.ts";
import { makeLLM } from "../src/llm.ts";
import { toOpenAIMessages, toOpenAITools, openaiLLM, listOpenAIModels } from "../src/openai.ts";
import type { MessageCreateParamsNonStreaming } from "@anthropic-ai/sdk/resources/beta/messages/messages";

type Seen = { model: string; messages: any[]; tools?: any[]; auth?: string };
const seen: Seen[] = [];
/** 假服务的回复模式：tool = 返回工具调用；text = 返回文本 */
let mode: "tool" | "text" = "tool";
const server = createServer(async (req, res) => {
  let body = "";
  for await (const c of req) body += c;
  res.setHeader("content-type", "application/json");
  const auth = req.headers.authorization;
  if (req.url?.endsWith("/models")) {
    if (auth !== "Bearer k-test") { res.statusCode = 401; return res.end(JSON.stringify({ error: { message: "invalid key" } })); }
    return res.end(JSON.stringify({ data: [{ id: "deepseek-chat" }, { id: "deepseek-reasoner" }] }));
  }
  if (req.url?.endsWith("/chat/completions")) {
    const b = JSON.parse(body);
    seen.push({ model: b.model, messages: b.messages, tools: b.tools, auth });
    if (mode === "tool" && b.tools?.length) {
      return res.end(JSON.stringify({ id: "c1", model: b.model, choices: [{ finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "read_topic", arguments: "{\"topic\":\"drafts\"}" } }] } }], usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 40 } } }));
    }
    return res.end(JSON.stringify({ id: "c2", model: b.model, choices: [{ finish_reason: "stop", message: { role: "assistant", content: "好的" } }], usage: { prompt_tokens: 10, completion_tokens: 2 } }));
  }
  res.statusCode = 404; res.end("{}");
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
after(() => server.close());

const params = (model: string): MessageCreateParamsNonStreaming => ({
  model,
  max_tokens: 1024,
  system: "你是助手",
  messages: [
    { role: "user", content: "看看 drafts" },
    { role: "assistant", content: [{ type: "text", text: "我来查" }, { type: "tool_use", id: "t1", name: "read_topic", input: { topic: "drafts" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "有一条消息" }, { type: "text", text: "继续" }] },
  ],
  tools: [
    { name: "read_topic", description: "读取主题", input_schema: { type: "object", properties: { topic: { type: "string" } }, required: ["topic"] } },
    { type: "web_search_20260209", name: "web_search", max_uses: 5 },
  ] as never,
} as MessageCreateParamsNonStreaming);

test("转换：Anthropic 消息与工具 → OpenAI 格式", () => {
  const msgs = toOpenAIMessages(params("m"));
  assert.equal(msgs[0].role, "system");
  assert.deepEqual(msgs.map((m) => m.role), ["system", "user", "assistant", "tool", "user"]);
  const asst = msgs[2] as { content: string; tool_calls: { id: string; function: { name: string; arguments: string } }[] };
  assert.equal(asst.content, "我来查");
  assert.equal(asst.tool_calls[0].id, "t1");
  assert.equal(asst.tool_calls[0].function.arguments, "{\"topic\":\"drafts\"}");
  assert.equal((msgs[3] as { tool_call_id: string }).tool_call_id, "t1");
  const tools = toOpenAITools(params("m").tools);
  assert.equal(tools.length, 1, "服务端工具被跳过");
  assert.equal(tools[0].function.name, "read_topic");
});

test("调用：工具调用与文本回复都能翻译回 Anthropic 格式", async () => {
  mode = "tool";
  seen.length = 0;
  const llm = openaiLLM({ baseUrl: base, apiKey: "k-test" });
  const first = await llm.create(params("deepseek-chat"), { signal: new AbortController().signal });
  assert.equal(first.stop_reason, "tool_use");
  const tu = first.content.find((b) => b.type === "tool_use") as { name: string; input: unknown; id: string };
  assert.equal(tu.name, "read_topic");
  assert.deepEqual(tu.input, { topic: "drafts" });
  assert.equal(first.usage.input_tokens, 60, "缓存命中的部分单独计");
  assert.equal(first.usage.cache_read_input_tokens, 40);
  assert.equal(seen[0].model, "deepseek-chat");
  assert.equal(seen[0].auth, "Bearer k-test");
  assert.equal((seen[0].tools as unknown[]).length, 1);

  mode = "text";
  const second = await llm.create(params("deepseek-chat"), { signal: new AbortController().signal });
  assert.equal(second.stop_reason, "end_turn");
  assert.equal((second.content[0] as { text: string }).text, "好的");
});

test("路由：按模型条目选择连接与协议；OpenAI 连接缺 Key 时明确报错", async () => {
  const store = new Store(":memory:");
  const settings = new Settings(store);
  const g = settings.get();
  g.providers.push({ id: "ds", type: "openai", name: "DeepSeek", baseUrl: base, method: "key", keyHint: "k-…", verifiedAt: new Date().toISOString() });
  g.models.push({ id: "m_ds", label: "DeepSeek Chat", modelId: "deepseek-chat", providerId: "ds", enabled: true });
  store.docPut("settings", "global", { id: "global", ...g });
  store.docPut("secrets", "global", { "provider:ds": "k-test" });
  const llm = makeLLM(settings);
  mode = "tool";
  seen.length = 0;
  const res = await llm.create(params("m_ds"), { signal: new AbortController().signal });
  assert.equal(res.stop_reason, "tool_use");
  assert.equal(seen.at(-1)!.model, "deepseek-chat", "条目 id 被解析成真实模型名");

  store.docPut("secrets", "global", {});
  await assert.rejects(makeLLM(settings).create(params("m_ds"), { signal: new AbortController().signal }), /还没有配置 API Key/);
});

test("探测：列出 OpenAI 兼容服务的模型；错误的 Key 报错", async () => {
  assert.deepEqual(await listOpenAIModels(base, "k-test"), ["deepseek-chat", "deepseek-reasoner"]);
  await assert.rejects(listOpenAIModels(base, "bad"), /invalid key/);

  const store = new Store(":memory:");
  const settings = new Settings(store);
  const p = await settings.verifyProvider(null, { name: "DS", type: "openai", baseUrl: base + "/", method: "key", key: "k-test" });
  assert.equal(p.type, "openai");
  assert.equal(p.baseUrl, base, "末尾斜杠被去掉");
  assert.equal(p.method, "key");
  assert.equal(p.keyHint?.includes("k-test"), false, "只显示掩码");
  assert.deepEqual(p.models, ["deepseek-chat", "deepseek-reasoner"]);
  assert.equal(JSON.stringify(settings.get()).includes("k-test"), false, "Key 不进设置快照");
});
