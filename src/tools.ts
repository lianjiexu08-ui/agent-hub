import type {
  BetaImageBlockParam,
  BetaTextBlockParam,
  BetaToolUnion,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type { Store } from "./db.ts";
import type { McpManager } from "./mcp-client.ts";
import type { Agent, Task, Tool } from "./types.ts";

export interface ToolOutput {
  content: string | Array<BetaTextBlockParam | BetaImageBlockParam>;
  isError?: boolean;
}

export interface ToolContext {
  task: Task;
  agent: Agent;
  signal: AbortSignal;
}

export type ToolHandler = (input: unknown, ctx: ToolContext) => Promise<ToolOutput>;

export interface ExternalTools {
  defs: BetaToolUnion[];
  handlers: Map<string, ToolHandler>;
  /** 配置了但不可用的工具/服务器，会告知模型 */
  warnings: string[];
}

/** 为智能体组装自定义 webhook 工具和 MCP 工具 */
export async function buildExternalTools(agent: Agent, store: Store, mcp: McpManager): Promise<ExternalTools> {
  const out: ExternalTools = { defs: [], handlers: new Map(), warnings: [] };

  for (const name of agent.tools) {
    const tool = store.getTool(name);
    if (!tool) {
      out.warnings.push(`自定义工具 ${name} 未注册`);
      continue;
    }
    out.defs.push({
      name: tool.name,
      description: tool.description,
      input_schema: tool.input_schema as { type: "object" },
    });
    out.handlers.set(tool.name, (input, ctx) => callWebhook(tool, input, ctx));
  }

  // 各 MCP 服务器并行连接，单个失败不影响其他
  const servers = agent.mcp.map((name) => ({ name, server: store.getMcpServer(name) }));
  const listed = await Promise.all(
    servers.map(async ({ name, server }) => {
      if (!server) return { name, error: "未注册" };
      try {
        return { name, server, tools: await mcp.listTools(server) };
      } catch (err) {
        return { name, error: err instanceof Error ? err.message : String(err) };
      }
    }),
  );
  for (const entry of listed) {
    if (!("tools" in entry) || !entry.tools || !entry.server) {
      out.warnings.push(`MCP 服务器 ${entry.name} 不可用：${"error" in entry ? entry.error : ""}`);
      continue;
    }
    const server = entry.server;
    for (const t of entry.tools) {
      const name = mcpToolName(server.name, t.name);
      if (out.handlers.has(name)) continue;
      out.defs.push({
        name,
        description: `[MCP:${server.name}] ${t.description ?? t.name}`.slice(0, 4000),
        input_schema: { type: "object", ...t.inputSchema },
      });
      out.handlers.set(name, (input, ctx) => mcp.callTool(server, t.name, input, ctx.signal));
    }
  }
  return out;
}

/** mcp__<server>__<tool>，满足 Claude 工具名约束 ^[a-zA-Z0-9_-]{1,64}$ */
export function mcpToolName(server: string, tool: string): string {
  return `mcp__${server}__${tool.replace(/[^a-zA-Z0-9_-]/g, "_")}`.slice(0, 64);
}

async function callWebhook(tool: Tool, input: unknown, ctx: ToolContext): Promise<ToolOutput> {
  const res = await fetch(tool.url, {
    method: "POST",
    headers: { "content-type": "application/json", ...tool.headers },
    body: JSON.stringify({ tool: tool.name, input, context: { taskId: ctx.task.id, agent: ctx.agent.name } }),
    signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(tool.timeoutMs)]),
  });
  const text = await res.text();
  if (!res.ok) return { content: `HTTP ${res.status}: ${text.slice(0, 2000)}`, isError: true };
  if ((res.headers.get("content-type") ?? "").includes("application/json")) {
    try {
      const json = JSON.parse(text);
      if (json && typeof json === "object" && "content" in json) {
        const c = json.content;
        return { content: typeof c === "string" ? c : JSON.stringify(c), isError: json.isError === true };
      }
      return { content: JSON.stringify(json) };
    } catch {
      /* 落到纯文本 */
    }
  }
  return { content: text || "(empty response)" };
}
