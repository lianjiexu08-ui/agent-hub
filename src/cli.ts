/**
 * CLI 运行底座：在工作目录中以非交互模式启动 Claude Code / Codex / Gemini CLI / pi。
 * - 命令模板来自设置（占位符：{prompt} {system} {model} {mcp_config}）
 * - Hub 的工具通过任务级 MCP 桥（src/mcp-task.ts）提供给 CLI
 * - 解析流式 JSON 输出：生成对话记录，每行输出视为一次心跳
 */
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { BetaMessageParam } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type { CliExecutor } from "./runtime.ts";
import type { Settings } from "./settings.ts";
import type { Agent, Task } from "./types.ts";
import { splitArgs } from "./qa.ts";

const BRIDGE = resolve(fileURLToPath(new URL("./mcp-task.ts", import.meta.url)));

export class CliRunner implements CliExecutor {
  private settings: Settings;
  private tmp: string;
  private hubUrl: () => string;
  private cwdFor: (task: Task) => string | null;
  private active = new Map<string, number>();
  constructor(settings: Settings, opts: { tmpDir: string; hubUrl: () => string; cwdFor: (task: Task) => string | null }) {
    this.settings = settings;
    this.tmp = resolve(opts.tmpDir);
    this.hubUrl = opts.hubUrl;
    this.cwdFor = opts.cwdFor;
  }

  async run(task: Task, agent: Agent, ctx: { system: string; signal: AbortSignal; heartbeat: () => void }) {
    const rt = agent.runtime;
    const cfg = this.settings.get().runtimes[rt];
    if (!cfg?.template) throw new Error(`运行底座 ${rt} 没有配置启动命令`);
    const n = this.active.get(rt) ?? 0;
    if (n >= (cfg.max || 1)) throw new Error(`运行底座 ${rt} 已达并发上限 ${cfg.max}`);
    this.active.set(rt, n + 1);
    try { return await this.exec(task, agent, cfg.template, ctx); }
    finally { this.active.set(rt, (this.active.get(rt) ?? 1) - 1); }
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

    const vars: Record<string, string> = { prompt: task.input, system: ctx.system, model: agent.cliModel, mcp_config: mcpFile };
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
    await new Promise<void>((res, rej) => {
      const child = spawn(cmd, rest, { cwd, env: { ...process.env, ...this.settings.secretEnv() }, stdio: ["ignore", "pipe", "pipe"] });
      let buf = "";
      child.stdout.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (l) { try { onLine(l); } catch (e) { child.kill(); rej(e); } } } });
      child.stderr.on("data", (d) => { stderr = (stderr + d).slice(-4000); ctx.heartbeat(); });
      child.on("error", (e) => rej(new Error(`无法启动 ${cmd}：${e.message}`)));
      child.on("close", (code) => { if (buf.trim()) { try { onLine(buf.trim()); } catch {} } code === 0 ? res() : rej(new Error(`${cmd} 退出码 ${code}：${stderr.trim().split("\n").slice(-3).join(" ")}`)); });
      ctx.signal.addEventListener("abort", () => child.kill("SIGTERM"), { once: true });
    });
    const final = result || lastText || raw.trim().split("\n").slice(-20).join("\n");
    if (transcript.length === 1) transcript.push({ role: "assistant", content: [{ type: "text", text: final }] });
    return { result: final, cost, inputTokens: inTok, outputTokens: outTok, transcript };
  }
}
