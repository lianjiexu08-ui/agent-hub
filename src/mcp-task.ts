/**
 * 任务级 MCP 桥（stdio）：CLI 底座（Claude Code 等）通过它调用 Hub 的工具，
 * 如 report_phase、comment_issue、load_skill、call_agent。以当前任务的身份执行。
 * 环境变量：HUB_URL、HUB_TASK_ID、HUB_TASK_TOKEN（任务级令牌，优先）或 HUB_TOKEN（兼容旧配置）
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

const HUB = process.env.HUB_URL ?? "http://127.0.0.1:18790";
const TASK = process.env.HUB_TASK_ID ?? "";
const headers: Record<string, string> = {
  "content-type": "application/json",
  ...(process.env.HUB_TASK_TOKEN ? { "x-hub-task-token": process.env.HUB_TASK_TOKEN } : {}),
  ...(process.env.HUB_TOKEN ? { authorization: `Bearer ${process.env.HUB_TOKEN}` } : {}),
};

/**
 * 不设超时的 HTTP 请求。不用全局 fetch：它（undici）默认 5 分钟收不到响应头就断开，
 * 而 report_phase(do) 要等测试跑完、需求确认要等人回复，都可能远超 5 分钟。
 */
export function call(method: "GET" | "POST", url: string, body?: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = (u.protocol === "https:" ? httpsRequest : httpRequest)(u, { method, headers: { ...headers, ...(data ? { "content-length": Buffer.byteLength(data) } : {}) } }, (res) => {
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", (c) => { raw += c; });
      res.on("end", () => {
        try { resolve(JSON.parse(raw)); } catch { reject(new Error(`Hub 返回非 JSON（HTTP ${res.statusCode}）：${raw.slice(0, 200)}`)); }
      });
    });
    req.setTimeout(0);
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

const server = new Server({ name: "agent-hub-task", version: "0.3.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => {
  const defs = (await call("GET", `${HUB}/internal/tasks/${TASK}/tools`)) as { name: string; description?: string; input_schema: Record<string, unknown> }[];
  return { tools: defs.map((d) => ({ name: d.name, description: d.description ?? "", inputSchema: { type: "object", ...d.input_schema } })) };
});
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const out = (await call("POST", `${HUB}/internal/tasks/${TASK}/tool`, { name: req.params.name, input: req.params.arguments ?? {} })) as { content: unknown; isError?: boolean; error?: string };
  const text = out.error ?? (typeof out.content === "string" ? out.content : JSON.stringify(out.content));
  return { content: [{ type: "text", text }], isError: !!out.isError || !!out.error };
});
// 作为脚本运行时才连 stdio（测试里只导入 call）
if (TASK) await server.connect(new StdioServerTransport());
