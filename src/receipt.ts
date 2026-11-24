/**
 * 上下文回执：每次运行记录「到底把什么交给了智能体、以什么方式、有多大」。
 * 只存元数据（种类、投递方式、字节数、名称），不存提示词或技能正文。
 *
 * 之所以需要它：提示词和技能现在有多种投递通道（系统提示词参数、并入输入、
 * 写成 CLI 原生技能文件、通过 Hub 工具按需加载），出了问题很难判断模型是否真的看到了。
 */
import type { Store } from "./db.ts";

export type Delivery = "system-param" | "prompt-inline" | "native-file" | "catalog-tool" | "embedded" | "none";

export interface ContextSource {
  /** 角色提示词 / 任务输入 / 技能 / 项目知识 / 工具清单 */
  kind: string;
  delivery: Delivery;
  bytes: number;
  /** 技能名、工具数量等简短说明 */
  detail?: string;
}

export interface ContextReceipt {
  taskId: string;
  at: string;
  /** builtin / claude-code / codex / ... */
  runtime: string;
  agent: string;
  model: string;
  promptBytes: number;
  systemBytes: number;
  sources: ContextSource[];
  /** 交给模型的工具名（内置 + 自定义 + MCP），最多记 40 个 */
  tools: string[];
  /** CLI 底座的工作目录（worktree） */
  workdir?: string | null;
  notes?: string[];
}

const bytes = (s: string | null | undefined) => Buffer.byteLength(s ?? "", "utf8");

export function recordReceipt(store: Store, r: ContextReceipt) {
  store.docPut("receipts", r.taskId, { ...r, id: r.taskId });
}

export function readReceipt(store: Store, taskId: string): ContextReceipt | null {
  return store.docGet<ContextReceipt>("receipts", taskId) ?? null;
}

/** 内置运行底座的回执：系统提示词走 API 参数，技能通过工具按需加载 */
export function builtinReceipt(o: {
  taskId: string; agent: string; model: string; system: string; input: string; tools: string[]; skills: string[]; knowledge: number;
}): ContextReceipt {
  const sources: ContextSource[] = [
    { kind: "角色提示词", delivery: "system-param", bytes: bytes(o.system), detail: "作为 system 参数传给模型" },
    { kind: "任务输入", delivery: "embedded", bytes: bytes(o.input), detail: "包含描述、讨论记录与项目知识" },
  ];
  if (o.knowledge) sources.push({ kind: "项目知识", delivery: "embedded", bytes: 0, detail: `${o.knowledge} 条，随任务输入一起发送` });
  if (o.skills.length) sources.push({ kind: "技能", delivery: "catalog-tool", bytes: 0, detail: `${o.skills.join("、")}（目录常驻，正文用 load_skill 加载）` });
  return {
    taskId: o.taskId, at: new Date().toISOString(), runtime: "builtin", agent: o.agent, model: o.model,
    promptBytes: bytes(o.input), systemBytes: bytes(o.system), sources, tools: o.tools.slice(0, 40),
  };
}

/** CLI 底座的回执：由 CliRunner 根据实际注入方式填写 */
export function cliReceipt(o: {
  taskId: string; agent: string; model: string; runtime: string; system: string; input: string;
  systemDelivery: Delivery; skills: { id: string; delivery: Delivery }[]; tools: string[]; workdir: string | null; promptSent: string;
}): ContextReceipt {
  const sources: ContextSource[] = [
    { kind: "角色提示词", delivery: o.systemDelivery, bytes: bytes(o.system), detail: o.systemDelivery === "system-param" ? "通过 CLI 的追加系统提示词参数" : "并入用户输入" },
    { kind: "任务输入", delivery: "embedded", bytes: bytes(o.input), detail: "作为这次运行的 prompt" },
  ];
  for (const s of o.skills) sources.push({ kind: "技能", delivery: s.delivery, bytes: 0, detail: s.id });
  return {
    taskId: o.taskId, at: new Date().toISOString(), runtime: o.runtime, agent: o.agent, model: o.model,
    promptBytes: bytes(o.promptSent), systemBytes: bytes(o.system), sources, tools: o.tools.slice(0, 40), workdir: o.workdir,
  };
}
