/**
 * MCP（stdio）入口：把 agent-hub 的 HTTP API 暴露给 Claude Code 等 MCP 客户端。
 * 需要 agent-hub 服务已在 HUB_URL 运行。
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const HUB_URL = process.env.HUB_URL ?? "http://127.0.0.1:18790";
const TOKEN = process.env.HUB_TOKEN;

async function hub(method: string, path: string, body?: unknown) {
  const res = await fetch(HUB_URL + path, {
    method,
    headers: { "content-type": "application/json", ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

const ok = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });

const server = new McpServer({ name: "agent-hub", version: "0.1.0" });

server.registerTool(
  "hub_list_agents",
  { description: "列出 agent-hub 中注册的所有智能体及其配置" },
  async () => ok(await hub("GET", "/agents")),
);

server.registerTool(
  "hub_upsert_agent",
  {
    description:
      "创建或更新一个智能体。delegation: 'any' | 'none' | 智能体名数组；subscribe: 订阅的总线主题；serverTools: ['web_search','web_fetch']；tools: 自定义工具名；mcp: MCP 服务器名",
    inputSchema: {
      name: z.string(),
      description: z.string().optional(),
      system: z.string().optional(),
      model: z.string().optional(),
      effort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
      delegation: z.union([z.literal("any"), z.literal("none"), z.array(z.string())]).optional(),
      subscribe: z.array(z.string()).optional(),
      serverTools: z.array(z.enum(["web_search", "web_fetch"])).optional(),
      maxTurns: z.number().int().optional(),
      tools: z.array(z.string()).optional(),
      mcp: z.array(z.string()).optional(),
    },
  },
  async (args) => ok(await hub("PUT", `/agents/${encodeURIComponent(args.name)}`, args)),
);

server.registerTool(
  "hub_upsert_tool",
  {
    description:
      "注册/更新一个 webhook 自定义工具。调用时 hub 会 POST {tool, input, context} 到 url，响应 JSON {content, isError?} 或纯文本。",
    inputSchema: {
      name: z.string(),
      description: z.string(),
      input_schema: z.record(z.string(), z.unknown()).optional(),
      url: z.string(),
      headers: z.record(z.string(), z.string()).optional(),
      timeoutMs: z.number().int().optional(),
    },
  },
  async (args) => ok(await hub("PUT", `/tools/${encodeURIComponent(args.name)}`, args)),
);

server.registerTool(
  "hub_upsert_mcp_server",
  {
    description:
      "注册/更新一个 MCP 服务器供智能体使用。transport=stdio 需 command/args/env；transport=http 需 url/headers。返回该服务器的工具列表以验证连接。",
    inputSchema: {
      name: z.string(),
      transport: z.enum(["stdio", "http"]),
      command: z.string().optional(),
      args: z.array(z.string()).optional(),
      env: z.record(z.string(), z.string()).optional(),
      cwd: z.string().optional(),
      url: z.string().optional(),
      headers: z.record(z.string(), z.string()).optional(),
    },
  },
  async (args) => {
    const saved = await hub("PUT", `/mcp-servers/${encodeURIComponent(args.name)}`, args);
    const tools = await hub("GET", `/mcp-servers/${encodeURIComponent(args.name)}/tools`).catch((e: Error) => e.message);
    return ok({ saved, tools });
  },
);

server.registerTool(
  "hub_run_task",
  {
    description: "把任务派给某个智能体。wait=true 时等待完成并返回结果（最多 timeoutMs），否则立即返回任务 id。",
    inputSchema: {
      agent: z.string(),
      input: z.string(),
      wait: z.boolean().optional(),
      timeoutMs: z.number().int().optional(),
    },
  },
  async (args) => ok(await hub("POST", "/tasks", args)),
);

server.registerTool(
  "hub_get_task",
  {
    description: "查看任务状态与结果；tree=true 时返回整棵委派调用树",
    inputSchema: { id: z.string(), tree: z.boolean().optional() },
  },
  async ({ id, tree }) => ok(await hub("GET", `/tasks/${id}${tree ? "/tree" : ""}`)),
);

server.registerTool(
  "hub_cancel_task",
  { description: "取消任务及其所有子任务", inputSchema: { id: z.string() } },
  async ({ id }) => ok(await hub("POST", `/tasks/${id}/cancel`)),
);

server.registerTool(
  "hub_publish",
  {
    description: "向消息总线主题发布消息，订阅该主题的智能体会被自动唤醒",
    inputSchema: { topic: z.string(), content: z.string() },
  },
  async ({ topic, content }) =>
    ok(await hub("POST", `/topics/${encodeURIComponent(topic)}/messages`, { content, sender: "mcp" })),
);

server.registerTool(
  "hub_read_topic",
  { description: "读取总线主题上的消息", inputSchema: { topic: z.string(), limit: z.number().int().optional() } },
  async ({ topic, limit }) => ok(await hub("GET", `/topics/${encodeURIComponent(topic)}/messages?limit=${limit ?? 50}`)),
);

await server.connect(new StdioServerTransport());
