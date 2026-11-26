/**
 * CLI 运行底座：在工作目录中以非交互模式启动 Claude Code / Codex / Gemini CLI / pi。
 * - 命令模板来自设置（占位符：{prompt} {system} {model} {mcp_config}）
 * - Hub 的工具通过任务级 MCP 桥（src/mcp-task.ts）提供给 CLI
 * - 解析流式 JSON 输出：生成对话记录，每行输出视为一次心跳
 */
import { spawn, type ChildProcess } from "node:child_process";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { BetaMessageParam } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type { CliExecutor } from "./runtime.ts";
import type { Settings } from "./settings.ts";
import type { Agent, Task } from "./types.ts";
import { splitArgs } from "./qa.ts";
import { cliReceipt, recordReceipt } from "./receipt.ts";
import type { Store } from "./db.ts";
import { PrioritySlots } from "./slots.ts";

const BRIDGE = resolve(fileURLToPath(new URL("./mcp-task.ts", import.meta.url)));
/** Hub 工具（report_phase 等测试、需求确认等人）可能阻塞很久：CLI 侧的 MCP 工具超时放到 24 小时 */
export const HUB_TOOL_TIMEOUT_MS = 24 * 3600_000;

/**
 * 有些 CLI 没有「追加系统提示词」的参数（例如 codex）。这类底座把角色设定与技能目录
 * 直接并进 prompt，保证智能体拿得到 Hub 的提示词，而不是只收到一句任务。
 */
export function promptWithSystem(template: string, system: string, input: string): string {
  if (/\{system\}/.test(template) || !system.trim()) return input;
  return `${system.trim()}\n\n---\n\n${input}`;
}

/**
 * 终止整棵进程树。CLI 会再拉起 npm / git / 测试进程，只杀直接子进程会留下孤儿进程
 * 继续写工作目录（尤其在回收 worktree 前后，会把目录删到一半）。非 Windows 用独立进程组。
 */
export function killProcessTree(child: { pid?: number; kill(sig?: NodeJS.Signals | number): boolean }, signal: NodeJS.Signals = "SIGTERM") {
  const pid = child.pid;
  if (!pid) return;
  if (process.platform !== "win32") {
    try { process.kill(-pid, signal); return; } catch { /* 不是进程组长时退回单进程 */ }
  }
  try { child.kill(signal); } catch { /* 已退出 */ }
}

/** Claude Code 的原生技能格式：.claude/skills/<id>/SKILL.md（frontmatter + 正文） */
export function skillMarkdown(skill: { id: string; name: string; description: string; instructions: string }): string {
  const name = skill.id.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 64);
  const desc = (skill.description || skill.name).replace(/\s+/g, " ").slice(0, 200);
  return `---\nname: ${name}\ndescription: ${desc}\n---\n\n# ${skill.name}\n\n${skill.instructions}\n`;
}

/**
 * 把含 Hub 任务令牌的配置写进工作目录（CLI 只从项目目录读它）。原来有同名文件就先备份，返回的函数负责还原。
 * 这些文件在提交时会被排除（workspace.ts 的 HUB_FILES），不会进 PR。
 */
export function placeHubFile(cwd: string, rel: string, content: unknown): () => void {
  const file = join(cwd, rel);
  const before = existsSync(file) ? readFileSync(file, "utf8") : null;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(content, null, 2), { mode: 0o600 });
  return () => {
    try {
      if (before === null) rmSync(file, { force: true });
      else writeFileSync(file, before);
    } catch { /* 工作目录已被回收 */ }
  };
}

export class CliRunner implements CliExecutor {
  private settings: Settings;
  private tmp: string;
  private hubUrl: () => string;
  private cwdFor: (task: Task) => string | null;
  /** 任务级令牌签发：任务桥用它回调 /internal，不再需要把 HUB_TOKEN 交给 CLI */
  private taskToken: ((taskId: string) => string) | null;
  private slots = new Map<string, PrioritySlots>();
  private store: Store | null = null;
  /** 任务所属工作项的编号（测试任务取被测工作项）：注入 HUB_ISSUE_KEY，方便项目按工作项隔离测试库、端口等 */
  private issueKeyFor: (task: Task) => string | null;
  constructor(settings: Settings, opts: { tmpDir: string; hubUrl: () => string; cwdFor: (task: Task) => string | null; store?: Store; taskToken?: (taskId: string) => string; issueKeyFor?: (task: Task) => string | null }) {
    this.issueKeyFor = opts.issueKeyFor ?? (() => null);
    this.taskToken = opts.taskToken ?? null;
    this.settings = settings;
    this.store = opts.store ?? null;
    this.tmp = resolve(opts.tmpDir);
    this.hubUrl = opts.hubUrl;
    this.cwdFor = opts.cwdFor;
  }

  private slotsFor(rt: string) {
    let s = this.slots.get(rt);
    if (!s) { s = new PrioritySlots(() => this.settings.get().runtimes[rt]?.max || 1); this.slots.set(rt, s); }
    return s;
  }
  /** 超过并发上限时按优先级排队，而不是让任务失败 */
  acquire(rt: string, priority: number, signal: AbortSignal) { return this.slotsFor(rt).acquire(priority, signal); }
  /** 并发上限在设置里调大后，唤醒排队的任务 */
  pump() { for (const s of this.slots.values()) s.pump(); }
  stats() { return Object.fromEntries([...this.slots].map(([rt, s]) => [rt, { running: s.running, waiting: s.waiting }])); }

  // ---------- 子进程登记：Hub 退出 / 重启时一并结束，避免旧 CLI 继续改 worktree ----------
  /** 运行中的 CLI 子进程（独立进程组，Hub 退出时不会被系统自动带走） */
  private children = new Map<number, { child: ChildProcess; bin: string }>();
  private get pidFile() { return join(this.tmp, "cli-pids.json"); }
  private savePids() {
    try {
      mkdirSync(this.tmp, { recursive: true });
      writeFileSync(this.pidFile, JSON.stringify([...this.children].map(([pid, c]) => ({ pid, bin: c.bin }))));
    } catch { /* 记录失败不影响运行 */ }
  }
  private track(child: ChildProcess, bin: string) {
    if (!child.pid) return;
    const pid = child.pid;
    this.children.set(pid, { child, bin });
    this.savePids();
    child.once("close", () => { this.children.delete(pid); this.savePids(); });
  }
  /** 结束所有运行中的 CLI（含它们拉起的 npm / git / 测试进程）。Hub 退出、重启前调用 */
  killAll() {
    for (const { child } of this.children.values()) killProcessTree(child, "SIGTERM");
    const left = [...this.children.values()];
    // 给 5 秒体面退出；调用方通常紧接着 process.exit，所以同步再补一刀 SIGKILL 的定时器也保留
    if (left.length) setTimeout(() => left.forEach(({ child }) => killProcessTree(child, "SIGKILL")), 5000).unref?.();
    return left.length;
  }
  /**
   * 启动时清理上一个 Hub 进程留下的 CLI（Hub 被强杀、崩溃时 killAll 来不及执行）。
   * 只处理登记过、仍在运行、且命令确实是那个 CLI 的进程，避免误杀复用了同一进程号的无关进程。
   */
  reapOrphans(): number {
    let list: { pid: number; bin: string }[] = [];
    try { list = JSON.parse(readFileSync(this.pidFile, "utf8")); } catch { return 0; }
    let n = 0;
    for (const { pid, bin } of list) {
      let cmd = "";
      try { cmd = execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" }).trim(); } catch { continue; } // 已退出
      const name = bin.split("/").pop() ?? bin;
      if (!cmd || !cmd.split(/\s+/)[0].endsWith(name)) continue;
      try { process.kill(-pid, "SIGTERM"); n++; } catch { try { process.kill(pid, "SIGTERM"); n++; } catch { /* 无权限或已退出 */ } }
    }
    try { rmSync(this.pidFile, { force: true }); } catch { /* 无所谓 */ }
    return n;
  }

  async run(task: Task, agent: Agent, ctx: { system: string; signal: AbortSignal; heartbeat: () => void; progress?: (transcript: BetaMessageParam[]) => void }) {
    const cfg = this.settings.get().runtimes[agent.runtime];
    if (!cfg?.template) throw new Error(`运行底座 ${agent.runtime} 没有配置启动命令`);
    try { return await this.exec(task, agent, cfg.template, ctx); }
    finally { rmSync(join(this.tmp, task.id), { recursive: true, force: true }); } // 临时目录（MCP 配置等）用完即删
  }

  private async exec(task: Task, agent: Agent, template: string, ctx: { system: string; signal: AbortSignal; heartbeat: () => void; progress?: (transcript: BetaMessageParam[]) => void }) {
    const work = join(this.tmp, task.id);
    mkdirSync(work, { recursive: true });
    const cwd = this.cwdFor(task) ?? work;
    // 优先用任务级令牌（只能访问本任务的 /internal 接口）；没有签发器时才退回全局 HUB_TOKEN
    const auth = this.taskToken ? { HUB_TASK_TOKEN: this.taskToken(task.id) } : process.env.HUB_TOKEN ? { HUB_TOKEN: process.env.HUB_TOKEN } : {};
    const bridgeEnv = { HUB_URL: this.hubUrl(), HUB_TASK_ID: task.id, ...auth };
    // timeout：Gemini CLI 的 MCP 工具调用默认 10 分钟超时（单位毫秒），而 report_phase 要等测试跑完、需求确认要等人回复
    const mcp = { mcpServers: { hub: { command: process.execPath, args: [BRIDGE], env: bridgeEnv, timeout: HUB_TOOL_TIMEOUT_MS } } };
    const mcpFile = join(work, "mcp.json");
    writeFileSync(mcpFile, JSON.stringify(mcp, null, 2));
    // 没有 --mcp-config 参数的 CLI：把 Hub 的 MCP 桥写进工作目录里它会读的配置文件（运行结束还原，提交时排除，见 HUB_FILES）
    const restoreFiles: (() => void)[] = [];
    if (agent.runtime === "gemini") restoreFiles.push(placeHubFile(cwd, ".gemini/settings.json", mcp));
    // pi：读项目里的 .pi/mcp.json，需要 -a（信任本次运行的项目文件）才会加载。
    // 注意 pi 的 timeout 单位是秒（默认 60 秒，report_phase 等测试会超时）；按毫秒填会让定时器溢出、连接立刻失败
    if (agent.runtime === "pi") restoreFiles.push(placeHubFile(cwd, ".pi/mcp.json", { mcpServers: { hub: { ...mcp.mcpServers.hub, timeout: Math.floor(HUB_TOOL_TIMEOUT_MS / 1000) } } }));
    // Claude Code 原生技能：写进工作目录的 .claude/skills，并从 git 排除，运行结束再清理
    const skillsDir = agent.runtime === "claude-code" ? this.writeSkills(agent, cwd) : null;

    // pi 的 MCP 工具藏在 codemode 后面，告诉它去哪找 Hub 的工具
    const system = agent.runtime === "pi" ? `${ctx.system}\n\n## Hub 工具\nreport_phase、comment_issue、load_skill 等 Hub 工具由 MCP 服务器「hub」提供，工具名形如 mcp__hub__report_phase。生命周期每个阶段完成后必须调用它汇报。` : ctx.system;
    const finalPrompt = promptWithSystem(template, system, task.input);
    const vars: Record<string, string> = { prompt: finalPrompt, system, model: agent.cliModel, mcp_config: mcpFile };
    // 记录这次运行把哪些上下文交给了 CLI、以什么方式（只存元数据）
    if (this.store) {
      recordReceipt(this.store, cliReceipt({
        taskId: task.id, agent: agent.name, model: agent.cliModel || "（CLI 默认）", runtime: agent.runtime,
        system: ctx.system, input: task.input,
        systemDelivery: /\{system\}/.test(template) ? "system-param" : "prompt-inline",
        skills: (agent.skills ?? []).map((id) => ({ id, delivery: (skillsDir ? "native-file" : "catalog-tool") as "native-file" | "catalog-tool" })),
        tools: ["hub（MCP 桥：report_phase、comment_issue、load_skill 等）"],
        workdir: this.cwdFor(task), promptSent: finalPrompt,
      }));
    }
    let args = splitArgs(template);
    // 模型留空时去掉 --model / -m 参数
    if (!agent.cliModel) args = args.filter((a, i) => !(a === "{model}" || (["--model", "-m"].includes(a) && args[i + 1] === "{model}")));
    args = args.map((a) => a.replace(/\{(prompt|system|model|mcp_config)\}/g, (_, k) => vars[k] ?? ""));
    // pi 不信任项目文件时不会读 .pi/mcp.json，Hub 工具就接不上：老模板里没有 -a 的补上
    if (agent.runtime === "pi" && !args.some((a) => a === "-a" || a === "--approve")) args.splice(1, 0, "-a");
    const [cmd, ...rest] = args;

    const transcript: BetaMessageParam[] = [{ role: "user", content: task.input }];
    let result = "", cost: number | undefined, inTok = 0, outTok = 0, lastText = "", raw = "", stderr = "";
    const onLine = (line: string) => {
      ctx.heartbeat();
      raw = (raw + line + "\n").slice(-20000);
      let ev: any;
      try { ev = JSON.parse(line); } catch { return; }
      const before = transcript.length;
      try { handle(ev); } finally { if (transcript.length !== before) ctx.progress?.(transcript); }
    };
    const handle = (ev: any) => {
      // Claude Code stream-json
      if (ev.type === "assistant" && ev.message?.content) {
        const blocks = (ev.message.content as any[]).filter((b) => ["text", "tool_use"].includes(b.type)).map((b) => (b.type === "text" ? { type: "text", text: String(b.text) } : { type: "tool_use", id: b.id, name: b.name, input: b.input }));
        if (blocks.length) transcript.push({ role: "assistant", content: blocks as never });
        const t = blocks.filter((b) => b.type === "text").map((b: any) => b.text).join("\n");
        if (t) lastText = t;
      } else if (ev.type === "user" && Array.isArray(ev.message?.content)) {
        const blocks = (ev.message.content as any[]).filter((b) => b.type === "tool_result").map((b) => ({ type: "tool_result", tool_use_id: b.tool_use_id, content: typeof b.content === "string" ? b.content.slice(0, 4000) : JSON.stringify(b.content).slice(0, 4000) }));
        if (blocks.length) transcript.push({ role: "user", content: blocks as never });
      } else if (ev.type === "result") {
        if (ev.is_error) throw new Error(String(ev.result ?? "CLI 返回错误"));
        result = String(ev.result ?? "");
        if (typeof ev.total_cost_usd === "number") cost = ev.total_cost_usd;
        inTok = ev.usage?.input_tokens ?? inTok;
        outTok = ev.usage?.output_tokens ?? outTok;
      } else if (ev.type === "message_end" && ev.message && (ev.message.role === "assistant" || ev.message.role === "toolResult")) {
        // pi --mode json：每条消息结束时给出完整内容与用量
        const m = ev.message;
        if (m.role === "assistant") {
          const blocks = (Array.isArray(m.content) ? m.content : []).filter((b: any) => b.type === "text" || b.type === "toolCall")
            .map((b: any) => (b.type === "text" ? { type: "text", text: String(b.text) } : { type: "tool_use", id: String(b.id), name: String(b.name), input: b.arguments ?? {} }));
          if (blocks.length) transcript.push({ role: "assistant", content: blocks as never });
          const t = blocks.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n").trim();
          if (t) lastText = t;
          const u = m.usage ?? {};
          inTok += (u.input ?? 0) + (u.cacheRead ?? 0);
          outTok += u.output ?? 0;
          if (typeof u.cost?.total === "number") cost = (cost ?? 0) + u.cost.total;
          if (m.stopReason === "error" || m.errorMessage) throw new Error(String(m.errorMessage ?? "pi 返回错误"));
        } else {
          const text = (Array.isArray(m.content) ? m.content : []).map((b: any) => b.text ?? "").join("\n");
          transcript.push({ role: "user", content: [{ type: "tool_result", tool_use_id: String(m.toolCallId), content: text.slice(0, 4000) }] as never });
        }
      } else if (ev.type === "agent_end") {
        result = lastText;
      } else {
        // 其他 CLI：尽量提取文本
        const t = ev.response ?? ev.text ?? ev.content ?? ev.message?.content ?? ev.delta?.text;
        if (typeof t === "string" && t.trim()) lastText = t;
        if (typeof ev.result === "string") result = ev.result;
      }
    };
    try {
      await new Promise<void>((res, rej) => {
      // MCP_TOOL_TIMEOUT：Claude Code 等待 MCP 工具返回的上限，同样要容得下「等测试」「等人确认」
      // 并行的工作项共用本机服务（数据库、端口……）：给出工作项编号，项目可据此隔离（如测试库 s2t_test_s2t_6）
      const issueKey = this.issueKeyFor(task);
      const hubEnv = { HUB_TASK_ID: task.id, ...(issueKey ? { HUB_ISSUE_KEY: issueKey, HUB_ISSUE_SLUG: issueKey.toLowerCase().replace(/[^a-z0-9]+/g, "_") } : {}) };
      const child = spawn(cmd, rest, { cwd, env: { MCP_TOOL_TIMEOUT: String(HUB_TOOL_TIMEOUT_MS), ...process.env, ...this.settings.secretEnv(), ...hubEnv }, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
      this.track(child, cmd);
      let buf = "";
      child.stdout.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (l) { try { onLine(l); } catch (e) { killProcessTree(child, "SIGKILL"); rej(e); } } } });
      child.stderr.on("data", (d) => { stderr = (stderr + d).slice(-4000); ctx.heartbeat(); });
      let killTimer: ReturnType<typeof setTimeout> | null = null;
      const terminate = () => {
        killProcessTree(child, "SIGTERM");
        killTimer = setTimeout(() => killProcessTree(child, "SIGKILL"), 5000);
        killTimer.unref?.();
      };
      child.on("error", (e) => rej(new Error(`无法启动 ${cmd}：${e.message}`)));
      child.on("close", (code) => {
        if (killTimer) clearTimeout(killTimer);
        if (buf.trim()) { try { onLine(buf.trim()); } catch {} }
        code === 0 ? res() : rej(new Error(`${cmd} 退出码 ${code}：${stderr.trim().split("\n").slice(-3).join(" ") || "（无输出）"}`));
      });
      ctx.signal.addEventListener("abort", terminate, { once: true });
      });
    } finally {
      if (skillsDir) this.cleanSkills(agent, cwd); // 技能目录只在那次运行期间存在
      for (const r of restoreFiles) r();
    }
    const final = result || lastText || raw.trim().split("\n").slice(-20).join("\n");
    if (transcript.length === 1) transcript.push({ role: "assistant", content: [{ type: "text", text: final }] });
    return { result: final, cost, inputTokens: inTok, outputTokens: outTok, transcript };
  }

    /** 把挂载的技能写成 Claude Code 原生技能目录；返回创建的目录（失败时返回 null，不影响运行） */
  private writeSkills(agent: Agent, cwd: string): string | null {
    const ids = agent.skills ?? [];
    if (!ids.length) return null;
    const root = join(cwd, ".claude", "skills");
    try {
      for (const id of ids) {
        const skill = this.settings.skill(id);
        if (!skill) continue;
        const dir = join(root, skill.id.toLowerCase().replace(/[^a-z0-9-]/g, "-"));
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "SKILL.md"), skillMarkdown(skill));
      }
      this.excludeFromGit(cwd, ".claude/skills/");
      return root;
    } catch {
      return null;
    }
  }

  /** 加进仓库本地的 .git/info/exclude（不产生任何提交） */
  private excludeFromGit(cwd: string, entry: string) {
    try {
      const rel = execFileSync("git", ["-C", cwd, "rev-parse", "--git-path", "info/exclude"], { encoding: "utf8" }).trim();
      if (!rel) return;
      const file = rel.startsWith("/") ? rel : join(cwd, rel);
      const prev = existsSync(file) ? readFileSync(file, "utf8") : "";
      if (!prev.split("\n").includes(entry)) {
        mkdirSync(join(file, ".."), { recursive: true });
        writeFileSync(file, `${prev}${prev && !prev.endsWith("\n") ? "\n" : ""}${entry}\n`);
      }
    } catch {
      /* 不是 git 目录：不需要排除 */
    }
  }

  /** 运行结束后删掉本次写入的技能目录（保留用户自己的技能文件） */
  private cleanSkills(agent: Agent, cwd: string) {
    if (agent.runtime !== "claude-code" || !(agent.skills ?? []).length) return;
    const root = join(cwd, ".claude", "skills");
    try {
      for (const id of agent.skills) {
        const dir = join(root, id.toLowerCase().replace(/[^a-z0-9-]/g, "-"));
        rmSync(dir, { recursive: true, force: true });
      }
      if (existsSync(root) && !readdirSync(root).length) rmSync(root, { recursive: true, force: true });
    } catch {
      /* 清理失败不影响结果 */
    }
  }
}
