import { z } from "zod";

/** 委派策略：any = 可调用任意智能体；none = 不能调用；string[] = 白名单 */
export const AgentSchema = z.object({
  name: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
  description: z.string().default(""),
  system: z.string().default(""),
  model: z.string().default("claude-opus-5-5"),
  effort: z.enum(["low", "medium", "high", "xhigh", "max"]).default("medium"),
  delegation: z.union([z.literal("any"), z.literal("none"), z.array(z.string())]).default("none"),
  /** 订阅的总线主题；主题上有新消息时自动为本智能体创建任务 */
  subscribe: z.array(z.string()).default([]),
  /** 可选的 Anthropic 服务端工具 */
  serverTools: z.array(z.enum(["web_search", "web_fetch"])).default([]),
  maxTurns: z.number().int().min(1).max(200).default(30),
  /** 引用的自定义工具（/tools 中注册的名称） */
  tools: z.array(z.string()).default([]),
  /** 引用的 MCP 服务器（/mcp-servers 中注册的名称），其全部工具都会提供给智能体 */
  mcp: z.array(z.string()).default([]),
  /** 挂载的技能 id */
  skills: z.array(z.string()).default([]),
  /** 运行底座：builtin（Hub 内置循环）或 claude-code / codex / gemini / pi */
  runtime: z.string().default("builtin"),
  /** CLI 底座使用的模型名（留空为 CLI 默认） */
  cliModel: z.string().default(""),
});
export type Agent = z.infer<typeof AgentSchema>;

export const BUILTIN_TOOL_NAMES = [
  "list_agents",
  "call_agent",
  "publish",
  "read_topic",
  "web_search",
  "web_fetch",
  "list_issues",
  "get_issue",
  "create_issue",
  "update_issue",
  "comment_issue",
  "report_phase",
  "load_skill",
  "browser",
  "report_case",
];
const NAME = /^[a-zA-Z0-9_-]{1,64}$/;

/**
 * 自定义工具：以 HTTP webhook 形式实现。
 * 调用时 POST {input, context: {taskId, agent}}；响应为 JSON {content: string, isError?: boolean} 或纯文本。
 */
export const ToolSchema = z.object({
  name: z
    .string()
    .regex(NAME)
    .refine((n) => !BUILTIN_TOOL_NAMES.includes(n) && !n.startsWith("mcp__"), "与内置工具名冲突"),
  description: z.string().min(1),
  input_schema: z.record(z.string(), z.unknown()).default({ type: "object", properties: {} }),
  url: z.string().url(),
  headers: z.record(z.string(), z.string()).default({}),
  timeoutMs: z.number().int().positive().max(600_000).default(60_000),
});
export type Tool = z.infer<typeof ToolSchema>;

export const McpServerSchema = z.discriminatedUnion("transport", [
  z.object({
    name: z.string().regex(/^[a-zA-Z0-9_-]{1,32}$/),
    transport: z.literal("stdio"),
    command: z.string().min(1),
    args: z.array(z.string()).default([]),
    env: z.record(z.string(), z.string()).default({}),
    cwd: z.string().optional(),
    timeoutMs: z.number().int().positive().max(600_000).default(120_000),
  }),
  z.object({
    name: z.string().regex(/^[a-zA-Z0-9_-]{1,32}$/),
    transport: z.literal("http"),
    url: z.string().url(),
    headers: z.record(z.string(), z.string()).default({}),
    timeoutMs: z.number().int().positive().max(600_000).default(120_000),
  }),
]);
export type McpServer = z.infer<typeof McpServerSchema>;

export type TaskStatus = "pending" | "running" | "completed" | "failed" | "cancelled";
export type TaskSource = "api" | "delegate" | "bus" | "issue" | "qa" | "assistant";

export interface Task {
  id: string;
  agent: string;
  input: string;
  status: TaskStatus;
  result: string | null;
  error: string | null;
  parentId: string | null;
  rootId: string;
  depth: number;
  /** 总线触发链的跳数，用来防止订阅环路无限触发 */
  hops: number;
  source: TaskSource;
  /** 该运行所属的工作项 */
  issueId: number | null;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  /** 估算花费（美元） */
  cost: number;
  createdAt: string;
  updatedAt: string;
}

export interface BusMessage {
  id: number;
  topic: string;
  sender: string;
  content: string;
  taskId: string | null;
  hops: number;
  createdAt: string;
}

// ======================= 工作项（Issue） =======================

export const ISSUE_STATUSES = ["backlog", "todo", "in_progress", "in_review", "done", "canceled"] as const;
export type IssueStatus = (typeof ISSUE_STATUSES)[number];
/** 智能体只能把状态推进到 in_review，done / canceled 由人决定 */
export const AGENT_ISSUE_STATUSES = ["backlog", "todo", "in_progress", "in_review"] as const;

/** 0 无 · 1 紧急 · 2 高 · 3 中 · 4 低（与 Linear 一致） */
export const PrioritySchema = z.number().int().min(0).max(4);

export interface Issue {
  id: number;
  key: string;
  title: string;
  description: string;
  status: IssueStatus;
  priority: number;
  assignee: string | null;
  labels: string[];
  parentId: number | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface IssueComment {
  id: number;
  issueId: number;
  author: string;
  /** user / agent / system */
  kind: "user" | "agent" | "system";
  body: string;
  runId: string | null;
  createdAt: string;
}

export const IssueCreateSchema = z.object({
  title: z.string().min(1).max(300),
  description: z.string().default(""),
  status: z.enum(ISSUE_STATUSES).optional(),
  priority: PrioritySchema.default(0),
  assignee: z.string().nullable().optional(),
  labels: z.array(z.string()).default([]),
  /** 父工作项的 key 或数字 id */
  parent: z.union([z.string(), z.number()]).nullable().optional(),
});
export type IssueCreate = z.input<typeof IssueCreateSchema>;

export const IssueUpdateSchema = z.object({
  title: z.string().min(1).max(300).optional(),
  description: z.string().optional(),
  status: z.enum(ISSUE_STATUSES).optional(),
  priority: PrioritySchema.optional(),
  assignee: z.string().nullable().optional(),
  labels: z.array(z.string()).optional(),
  parent: z.union([z.string(), z.number()]).nullable().optional(),
});
export type IssueUpdate = z.input<typeof IssueUpdateSchema>;

export type HubEvent =
  | { type: "task"; task: Task }
  | { type: "bus"; message: BusMessage }
  | { type: "issue"; issue: Issue }
  | { type: "comment"; comment: IssueComment };
