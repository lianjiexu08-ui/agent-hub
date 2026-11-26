/**
 * 管家的 CLI 通道：没有可用的模型 API 连接时，借本机已登录的 Claude Code（`claude -p`）回答。
 *
 * - 一次消息起一个 `claude -p` 进程，对话历史由调用方拼进 prompt（CLI 侧不保留会话）。
 * - 管家自己的工具（查项目、出计划卡片……）通过现有的任务级 MCP 桥（mcp-task.ts）暴露给 CLI：
 *   这里登记一个「虚拟会话」，桥按会话 id 回调 /internal/tasks/<id>/*，服务端从 virtualSessions 里找到处理函数。
 *   访问凭据沿用任务级令牌（HMAC(进程密钥, 会话 id)），只能调用本会话的工具。
 * - 关掉 Claude Code 的全部内置工具（--tools ""）、只加载这一个 MCP（--strict-mcp-config），
 *   并用 --system-prompt 替换掉默认的编程助手人设：管家不读写文件、不执行命令。
 */
import { spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { killProcessTree } from "./cli.ts";

const BRIDGE = resolve(fileURLToPath(new URL("./mcp-task.ts", import.meta.url)));

export interface VirtualTool { name: string; description: string; input_schema: Record<string, unknown> }
export interface VirtualSession { tools: VirtualTool[]; invoke(name: string, input: unknown): Promise<string> }
/** 进行中的虚拟会话：server.ts 的 /internal/tasks/:id/* 先查这里，查不到再交给运行时 */
export const virtualSessions = new Map<string, VirtualSession>();

export interface CliChatConfig {
  /** claude 可执行文件路径；null 表示本机没有 */
  bin: () => Promise<string | null>;
  hubUrl: () => string;
  /** 给会话签发任务级令牌 */
  taskToken: (id: string) => string;
  tmpDir: string;
}

/** 测试可替换：默认真正启动进程 */
export type Spawner = (bin: string, args: string[], opts: { cwd: string; signal: AbortSignal }) => Promise<{ stdout: string; stderr: string; code: number | null }>;
const defaultSpawner: Spawner = (bin, args, opts) => new Promise((res, rej) => {
  const p = spawn(bin, args, { cwd: opts.cwd, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: "agent-hub-butler" } });
  let stdout = "", stderr = "";
  p.stdout.on("data", (b) => { stdout += String(b); });
  p.stderr.on("data", (b) => { stderr = (stderr + String(b)).slice(-4000); });
  const onAbort = () => killProcessTree(p, "SIGKILL");
  opts.signal.addEventListener("abort", onAbort, { once: true });
  p.on("error", (e) => { opts.signal.removeEventListener("abort", onAbort); rej(e); });
  p.on("close", (code) => { opts.signal.removeEventListener("abort", onAbort); res({ stdout, stderr, code }); });
});

/** 长驻进程需要的最小子进程接口（测试里用假的实现） */
export interface ChildLike {
  stdin: { write(s: string): unknown; end(): unknown } | null;
  stdout: { on(ev: "data", fn: (b: Buffer | string) => void): unknown } | null;
  stderr?: { on(ev: "data", fn: (b: Buffer | string) => void): unknown } | null;
  on(ev: "close", fn: (code: number | null) => void): unknown;
  on(ev: "error", fn: (e: Error) => void): unknown;
  kill(sig?: NodeJS.Signals): boolean;
  pid?: number;
}
export type ProcSpawner = (bin: string, args: string[], opts: { cwd: string }) => ChildLike;
const defaultProcSpawner: ProcSpawner = (bin, args, opts) =>
  spawn(bin, args, { cwd: opts.cwd, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: "agent-hub-butler" } });

/**
 * 长驻的 Claude Code 会话（`--input-format stream-json`）：进程常驻，消息一条条写进 stdin，
 * 每轮以一个 result 事件结束。省掉每条消息的进程启动与 MCP 连接，后续轮次还能命中提示缓存。
 *
 * - 串行：同一时刻只跑一轮，后到的排队。
 * - 闲置 idleMs 自动退出；单轮超时、进程崩溃时整个会话作废，下次由调用方重新起一个。
 * - 工具回调走虚拟会话，处理函数每轮替换（管家每轮收集自己的卡片）。
 */
export class LiveSession {
  readonly id = `butler-${randomUUID()}`;
  /** 已完成的轮数（调用方据此定期换新进程，避免上下文无限增长） */
  turns = 0;
  private proc: ChildLike | null = null;
  private dir: string;
  private buf = "";
  private stderr = "";
  private queue: Promise<unknown> = Promise.resolve();
  private pending: { resolve: (t: string) => void; reject: (e: Error) => void } | null = null;
  private handler: (name: string, input: unknown) => Promise<string> = async () => "当前没有进行中的对话";
  private onText: ((said: string) => void) | null = null;
  private idle: NodeJS.Timeout | null = null;
  private dead = false;
  private idleMs: number;
  constructor(bin: string, cfg: CliChatConfig, o: { system: string; tools: VirtualTool[]; idleMs?: number; spawner?: ProcSpawner; onExit?: () => void }) {
    this.idleMs = o.idleMs ?? 10 * 60_000;
    this.dir = join(resolve(cfg.tmpDir), this.id);
    mkdirSync(this.dir, { recursive: true });
    const args = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--system-prompt", o.system, "--tools", "", "--no-session-persistence", "--strict-mcp-config"];
    if (o.tools.length) {
      virtualSessions.set(this.id, { tools: o.tools, invoke: (n, i) => this.handler(n, i) });
      const file = join(this.dir, "mcp.json");
      const env = { HUB_URL: cfg.hubUrl(), HUB_TASK_ID: this.id, HUB_TASK_TOKEN: cfg.taskToken(this.id) };
      writeFileSync(file, JSON.stringify({ mcpServers: { hub: { command: process.execPath, args: [BRIDGE], env } } }), { mode: 0o600 });
      args.push("--mcp-config", file, "--allowedTools", "mcp__hub");
    }
    const p = (o.spawner ?? defaultProcSpawner)(bin, args, { cwd: this.dir });
    this.proc = p;
    p.stdout?.on("data", (b) => this.onData(String(b)));
    p.stderr?.on("data", (b) => { this.stderr = (this.stderr + String(b)).slice(-2000); });
    const end = (why: string) => {
      if (this.dead) return;
      this.dead = true;
      this.cleanup();
      this.pending?.reject(new Error(/log ?in|auth|unauthori|credential/i.test(this.stderr) ? `Claude Code 未登录或登录已失效：${this.stderr.trim().slice(-300)}` : `Claude Code 进程已退出（${why}）${this.stderr.trim() ? `：${this.stderr.trim().slice(-300)}` : ""}`));
      this.pending = null;
      o.onExit?.();
    };
    p.on("close", (code) => end(`退出码 ${code ?? "-"}`));
    p.on("error", (e) => end(e.message));
    this.touch();
  }
  get alive() { return !this.dead; }

  private onData(s: string) {
    this.buf += s;
    let i: number;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line.startsWith("{")) continue;
      let e: { type?: string; is_error?: boolean; result?: string; message?: { content?: { type: string; text?: string }[] } };
      try { e = JSON.parse(line); } catch { continue; }
      // 中途的话（工具调用前的说明）：转给调用方显示进度；最终回复以 result 为准
      if (e.type === "assistant" && this.onText) {
        const said = (e.message?.content ?? []).filter((b) => b.type === "text" && b.text?.trim()).map((b) => b.text!.trim()).join("\n");
        const usesTool = (e.message?.content ?? []).some((b) => b.type === "tool_use");
        if (said && usesTool) this.onText(said);
      }
      if (e.type !== "result" || !this.pending) continue;
      const p = this.pending;
      this.pending = null;
      if (e.is_error) p.reject(new Error(`Claude Code 返回错误：${String(e.result ?? "").slice(0, 400)}`));
      else p.resolve(String(e.result ?? "").trim());
    }
  }
  private touch() {
    if (this.idle) clearTimeout(this.idle);
    this.idle = setTimeout(() => this.close(), this.idleMs);
    this.idle.unref?.();
  }

  /** 发一条消息，等这一轮结束；invoke 处理本轮里的工具调用 */
  send(text: string, invoke: (name: string, input: unknown) => Promise<string>, timeoutMs = 180_000, onText?: (said: string) => void): Promise<string> {
    const run = async () => {
      if (this.dead) throw new Error("Claude Code 会话已结束");
      this.handler = invoke;
      this.onText = onText ?? null;
      const timer = { t: null as NodeJS.Timeout | null };
      try {
        return await new Promise<string>((res, rej) => {
          this.pending = { resolve: res, reject: rej };
          // 超时说明进程卡住了：整个会话作废，交给调用方重建
          timer.t = setTimeout(() => { this.pending = null; rej(new Error("Claude Code 响应超时")); this.close(); }, timeoutMs);
          this.proc!.stdin!.write(JSON.stringify({ type: "user", message: { role: "user", content: text } }) + "\n");
        });
      } finally {
        if (timer.t) clearTimeout(timer.t);
        this.turns++;
        this.touch();
      }
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => {});
    return next;
  }

  /** 关闭：先关 stdin 让它正常退出，3 秒后仍在就强杀整个进程组 */
  close() {
    if (this.dead) return;
    this.dead = true;
    const p = this.proc;
    this.cleanup();
    this.pending?.reject(new Error("Claude Code 会话已关闭"));
    this.pending = null;
    try { p?.stdin?.end(); } catch { /* 已关闭 */ }
    if (p) setTimeout(() => { try { killProcessTree(p as never, "SIGKILL"); } catch { /* 已退出 */ } }, 3000).unref?.();
  }
  private cleanup() {
    if (this.idle) clearTimeout(this.idle);
    virtualSessions.delete(this.id);
    rmSync(this.dir, { recursive: true, force: true });
  }
}

export class CliChat {
  private cfg: CliChatConfig;
  spawner: Spawner = defaultSpawner;
  /** 长驻会话用的进程启动器（测试可替换） */
  procSpawner: ProcSpawner = defaultProcSpawner;
  constructor(cfg: CliChatConfig) { this.cfg = cfg; }
  async available(): Promise<boolean> { return !!(await this.cfg.bin()); }

  /** 起一个长驻会话 */
  async live(o: { system: string; tools: VirtualTool[]; idleMs?: number; onExit?: () => void }): Promise<LiveSession> {
    const bin = await this.cfg.bin();
    if (!bin) throw new Error("本机没有安装 Claude Code");
    return new LiveSession(bin, this.cfg, { ...o, spawner: this.procSpawner });
  }

  /**
   * 跑一轮：CLI 自己完成工具循环，返回最终文本。
   * 工具调用通过 invoke 回到调用方（管家把卡片收集在自己的闭包里）。
   */
  async run(o: { system: string; prompt: string; tools?: VirtualTool[]; invoke?: (name: string, input: unknown) => Promise<string>; timeoutMs?: number }): Promise<{ text: string; cost?: number }> {
    const bin = await this.cfg.bin();
    if (!bin) throw new Error("本机没有安装 Claude Code");
    const id = `butler-${randomUUID()}`;
    const dir = join(resolve(this.cfg.tmpDir), id);
    mkdirSync(dir, { recursive: true });
    const args = ["-p", o.prompt, "--output-format", "json", "--system-prompt", o.system, "--tools", "", "--no-session-persistence"];
    const tools = o.tools ?? [];
    if (tools.length && o.invoke) {
      virtualSessions.set(id, { tools, invoke: o.invoke });
      const file = join(dir, "mcp.json");
      const env = { HUB_URL: this.cfg.hubUrl(), HUB_TASK_ID: id, HUB_TASK_TOKEN: this.cfg.taskToken(id) };
      writeFileSync(file, JSON.stringify({ mcpServers: { hub: { command: process.execPath, args: [BRIDGE], env } } }), { mode: 0o600 });
      // 只放行这一个 MCP 服务器的工具；-p 模式下没放行的工具会被直接拒绝
      args.push("--mcp-config", file, "--strict-mcp-config", "--allowedTools", "mcp__hub");
    } else args.push("--strict-mcp-config");
    const signal = AbortSignal.timeout(o.timeoutMs ?? 180_000);
    try {
      const r = await this.spawner(bin, args, { cwd: dir, signal });
      if (signal.aborted) throw new Error("Claude Code 响应超时");
      return parseResult(r.stdout, r.stderr, r.code);
    } finally {
      virtualSessions.delete(id);
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

/** 解析 `claude -p --output-format json` 的输出（一个 result 对象） */
export function parseResult(stdout: string, stderr: string, code: number | null): { text: string; cost?: number } {
  const line = stdout.trim().split("\n").reverse().find((l) => l.trim().startsWith("{"));
  let j: { type?: string; is_error?: boolean; result?: string; total_cost_usd?: number } | null = null;
  try { j = line ? JSON.parse(line) : null; } catch { j = null; }
  if (!j) {
    const why = (stderr || stdout).trim().slice(-400) || `退出码 ${code ?? "-"}`;
    throw new Error(/log ?in|login|auth|unauthori|credential/i.test(why) ? `Claude Code 未登录或登录已失效：${why}` : `Claude Code 没有返回结果：${why}`);
  }
  if (j.is_error) throw new Error(`Claude Code 返回错误：${String(j.result ?? "").slice(0, 400)}`);
  return { text: String(j.result ?? "").trim(), ...(typeof j.total_cost_usd === "number" ? { cost: j.total_cost_usd } : {}) };
}

/** 把多轮对话拼成一段 prompt：CLI 每次都是新会话 */
export function transcriptPrompt(history: { role: "me" | "ai"; text: string }[], current: string, labels = { me: "用户", ai: "管家" }): string {
  const past = history.filter((m) => m.text?.trim()).map((m) => `【${labels[m.role]}】${m.text.trim()}`).join("\n\n");
  return past ? `以下是此前的对话记录（供参考，不要重复回答）：\n\n${past}\n\n---\n\n【${labels.me}的新消息】\n${current}` : current;
}
