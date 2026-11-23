// 测试用的最小 stdio MCP 服务器
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "echo", version: "0.0.1" });
server.registerTool(
  "add",
  { description: "两数相加", inputSchema: { a: z.number(), b: z.number() } },
  async ({ a, b }) => ({ content: [{ type: "text", text: String(a + b) }] }),
);
server.registerTool("boom", { description: "总是失败" }, async () => ({
  content: [{ type: "text", text: "kaboom" }],
  isError: true,
}));
await server.connect(new StdioServerTransport());
