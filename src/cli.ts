/**
 * CLI 运行底座：在工作目录中以非交互模式启动 Claude Code / Codex / Gemini CLI / pi。
 * - 命令模板来自设置（占位符：{prompt} {system} {model} {mcp_config}）
 * - Hub 的工具通过任务级 MCP 桥（src/mcp-task.ts）提供给 CLI
 * - 解析流式 JSON 输出：生成对话记录，每行输出视为一次心跳
 */
import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
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

export class CliRunner implements CliExecutor {
  private settings: Settings;
  private tmp: string;
  private hubUrl: () => string;
  private cwdFor: (task: Task) => string | null;
  private slots = new Map<string, PrioritySlots>();
  private store: Store | null = null;
  constructor(settings: Settings, opts: { tmpDir: string; hubUrl: () => string; cwdFor: (task: Task) => string | null; store?: Store }) {
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

  async run(task: Task, agent: Agent, ctx: { system: string; signal: AbortSignal; heartbeat: () => void }) {
    const cfg = this.settings.get().runtimes[agent.runtime];
    if (!cfg?.template) throw new Error(`运行底座 ${agent.runtime} 没有配置启动命令`);
    try { return await this.exec(task, agent, cfg.template, ctx); }
    finally { rmSync(join(this.tmp, task.id), { recursive: true, force: true }); } // 临时目录（MCP 配置等）用完即删
  }

  private async exec(task: Task, agent: Agent, template: string, ctx: { system: string; signal: AbortSignal; heartbeat: () => void }) {
    const work = join(this.tmp, task.id);
    mkdirSync(work, { recursive: true });
    const cwd = this.cwdFor(task) ?? work;
    const bridgeEnv = { HUB_URL: this.hubUrl(), HUB_TASK_ID: task.id, ...(process.env.HUB_TOKEN ? { HUB_TOKEN: process.env.HUB_TOKEN } : {}) };
    const mcp = { mcpServers: { hub: { command: process.execPath, args: [BRIDGE], env: bridgeEnv } } };
    const mcpFile = join(work, "mcp.json");
    writeFileSync(mcpFile, JSON.stringify(mcp, null, 2));
    if (agent.runtime === "gemini") { mkdirSync(join(cwd, ".gemini"), { recursive: true }); writeFileSync(join(cwd, ".gemini", "settings.json"), JSON.stringify(mcp, null, 2)); }
    // Claude Code 原生技能：写进工作目录的 .claude/skills，并从 git 排除，运行结束再清理
    const skillsDir = agent.runtime === "claude-code" ? this.writeSkills(agent, cwd) : null;

    const finalPrompt = promptWithSystem(template, ctx.system, task.input);
    const vars: Record<string, string> = { prompt: finalPrompt, system: ctx.system, model: agent.cliModel, mcp_config: mcpFile };
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
    const [cmd, ...rest] = args;

    const transcript: BetaMessageParam[] = [{ role: "user", content: task.input }];
    let result = "", cost: number | undefined, inTok = 0, outTok = 0, lastText = "", raw = "", stderr = "";
    const onLine = (line: string) => {
      ctx.heartbeat();
      raw = (raw + line + "\n").slice(-20000);
      let ev: any;
      try { ev = JSON.parse(line); } catch { return; }
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
      } else {
        // 其他 CLI：尽量提取文本
        const t = ev.response ?? ev.text ?? ev.content ?? ev.message?.content ?? ev.delta?.text;
        if (typeof t === "string" && t.trim()) lastText = t;
        if (typeof ev.result === "string") result = ev.result;
      }
    };
    try {
      await new Promise<void>((res, rej) => {
      const child = spawn(cmd, rest, { cwd, env: { ...process.env, ...this.settings.secretEnv() }, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
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
