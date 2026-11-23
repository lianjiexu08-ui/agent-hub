/**
 * 任务级 MCP 桥（stdio）：CLI 底座（Claude Code 等）通过它调用 Hub 的工具，
 * 如 report_phase、comment_issue、load_skill、call_agent。以当前任务的身份执行。
 * 环境变量：HUB_URL、HUB_TASK_ID、HUB_TOKEN（可选）
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const HUB = process.env.HUB_URL ?? "http://127.0.0.1:18790";
const TASK = process.env.HUB_TASK_ID ?? "";
const headers = { "content-type": "application/json", ...(process.env.HUB_TOKEN ? { authorization: `Bearer ${process.env.HUB_TOKEN}` } : {}) };

const server = new Server({ name: "agent-hub-task", version: "0.3.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => {
  const res = await fetch(`${HUB}/internal/tasks/${TASK}/tools`, { headers });
  const defs = (await res.json()) as { name: string; description?: string; input_schema: Record<string, unknown> }[];
  return { tools: defs.map((d) => ({ name: d.name, description: d.description ?? "", inputSchema: { type: "object", ...d.input_schema } })) };
});
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const res = await fetch(`${HUB}/internal/tasks/${TASK}/tool`, { method: "POST", headers, body: JSON.stringify({ name: req.params.name, input: req.params.arguments ?? {} }) });
  const out = (await res.json()) as { content: unknown; isError?: boolean; error?: string };
  const text = out.error ?? (typeof out.content === "string" ? out.content : JSON.stringify(out.content));
  return { content: [{ type: "text", text }], isError: !!out.isError || !!out.error };
});
await server.connect(new StdioServerTransport());
