/**
 * 由 hub 自己充当 MCP 客户端，连接 stdio / HTTP 的 MCP 服务器，
 * 把其工具转成智能体可调用的客户端工具。连接按需建立并缓存，配置变更后自动重连。
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { McpServer } from "./types.ts";
import type { ToolOutput } from "./tools.ts";

export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

interface Conn {
  key: string;
  client: Client;
  tools: McpToolInfo[];
}

export class McpManager {
  private conns = new Map<string, Promise<Conn>>();

  /** 获取（必要时建立）连接 */
  private connect(server: McpServer): Promise<Conn> {
    const key = JSON.stringify(server);
    const existing = this.conns.get(server.name);
    if (existing) {
      return existing.then(
        (c) => (c.key === key ? c : this.reset(server.name).then(() => this.connect(server))),
        () => this.reset(server.name).then(() => this.connect(server)),
      );
    }
    const p = this.open(server, key);
    this.conns.set(server.name, p);
    p.catch(() => {
      if (this.conns.get(server.name) === p) this.conns.delete(server.name);
    });
    return p;
  }

  private async open(server: McpServer, key: string): Promise<Conn> {
    const client = new Client({ name: "agent-hub", version: "0.2.0" });
    const transport =
      server.transport === "stdio"
        ? new StdioClientTransport({
            command: server.command,
            args: server.args,
            env: { ...(process.env as Record<string, string>), ...server.env },
            cwd: server.cwd,
            stderr: "ignore",
          })
        : new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: server.headers } });
    client.onclose = () => {
      void this.conns.get(server.name)?.then((c) => {
        if (c.client === client) this.conns.delete(server.name);
      });
    };
    await client.connect(transport, { timeout: 30_000 });

    const tools: McpToolInfo[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor ? { cursor } : undefined, { timeout: 30_000 });
      for (const t of page.tools) tools.push({ name: t.name, description: t.description, inputSchema: t.inputSchema });
      cursor = page.nextCursor;
    } while (cursor);
    return { key, client, tools };
  }

  async listTools(server: McpServer): Promise<McpToolInfo[]> {
    return (await this.connect(server)).tools;
  }

  async callTool(server: McpServer, tool: string, args: unknown, signal: AbortSignal): Promise<ToolOutput> {
    const { client } = await this.connect(server);
    const res = await client.callTool(
      { name: tool, arguments: (args ?? {}) as Record<string, unknown> },
      undefined,
      { signal, timeout: server.timeoutMs, resetTimeoutOnProgress: true },
    );
    return toToolOutput(res);
  }

  async reset(name: string) {
    const p = this.conns.get(name);
    this.conns.delete(name);
    if (p) await p.then((c) => c.client.close()).catch(() => {});
  }

  async closeAll() {
    await Promise.all([...this.conns.keys()].map((n) => this.reset(n)));
  }
}

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/** MCP CallToolResult -> Claude tool_result 内容 */
function toToolOutput(res: Record<string, unknown>): ToolOutput {
  const isError = res.isError === true;
  const items = Array.isArray(res.content) ? (res.content as Record<string, unknown>[]) : [];
  if (!items.length) {
    const structured = res.structuredContent ?? res.toolResult;
    return { content: structured === undefined ? "(empty result)" : JSON.stringify(structured), isError };
  }
  const blocks: Exclude<ToolOutput["content"], string> = [];
  for (const item of items) {
    if (item.type === "text") blocks.push({ type: "text", text: String(item.text) });
    else if (item.type === "image" && IMAGE_TYPES.has(String(item.mimeType)))
      blocks.push({
        type: "image",
        source: {
          type: "base64",
          media_type: item.mimeType as "image/png" | "image/jpeg" | "image/gif" | "image/webp",
          data: String(item.data),
        },
      });
    else if (item.type === "resource") {
      const r = item.resource as Record<string, unknown>;
      blocks.push({ type: "text", text: typeof r.text === "string" ? r.text : `[resource ${r.uri}]` });
    } else blocks.push({ type: "text", text: `[${item.type} content omitted]` });
  }
  return { content: blocks, isError };
}
