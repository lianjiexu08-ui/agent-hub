import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import type {
  BetaMessage,
  BetaMessageParam,
  BetaToolResultBlockParam,
  BetaToolUnion,
  MessageCreateParamsNonStreaming,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { z } from "zod";
import type { Store } from "./db.ts";
import { McpManager } from "./mcp-client.ts";
import { buildExternalTools, type ExternalTools, type ToolHandler, type ToolOutput } from "./tools.ts";
import type { Agent, BusMessage, HubEvent, Task, TaskSource } from "./types.ts";
import { costOf } from "./pricing.ts";
import { priorityRank } from "./priority.ts";
import { PrioritySlots } from "./slots.ts";
import { builtinReceipt, recordReceipt } from "./receipt.ts";
import { backoffMs, isTransientError, sleep } from "./transient.ts";

/** 非内置运行底座（Claude Code 等 CLI）的执行器 */
export interface CliExecutor {
  /** 取得该运行底座的一个进程槽位（超过并发上限时按优先级排队） */
  acquire?(runtime: string, priority: number, signal: AbortSignal): Promise<() => void>;
  run(task: Task, agent: Agent, ctx: { system: string; signal: AbortSignal; heartbeat: () => void; /** 运行中的对话记录（增量，给界面实时看） */ progress?: (transcript: BetaMessageParam[]) => void }): Promise<{ result: string; cost?: number; inputTokens?: number; outputTokens?: number; transcript?: BetaMessageParam[] }>;
}

export interface RuntimeHooks {
  /** 智能体结束回合时调用；返回字符串则作为用户消息续跑 */
  continuation?(task: Task, finalText: string): string | null;
  /** 追加到系统提示词的内容（技能目录等） */
  systemExtra?(task: Task, agent: Agent): string;
}

/** 可替换的模型调用接口，方便测试时注入假模型 */
export interface LLM {
  create(params: MessageCreateParamsNonStreaming, opts: { signal: AbortSignal }): Promise<BetaMessage>;
}

export function anthropicLLM(client = new Anthropic()): LLM {
  return {
    create: (params, opts) => client.beta.messages.create(params, { signal: opts.signal }),
  };
}

export interface RuntimeOptions {
  maxConcurrency: number; // 同时在途的模型请求数
  maxDepth: number; // call_agent 委派链最大深度
  maxHops: number; // 总线触发链最大跳数
}

const TERMINAL = new Set(["completed", "failed", "cancelled"]);

const CallAgentInput = z.object({ agent: z.string(), task: z.string().min(1) });
const PublishInput = z.object({ topic: z.string().min(1), content: z.string().min(1) });
const ReadTopicInput = z.object({ topic: z.string().min(1), limit: z.number().int().min(1).max(200).optional() });

class ToolError extends Error {}

export class Runtime {
  readonly events = new EventEmitter();
  private sem: PrioritySlots;
  private modelLimit: number;
  private controllers = new Map<string, AbortController>();
  private store: Store;
  private llm: LLM;
  private opts: RuntimeOptions;
  readonly mcp: McpManager;
  /** 由其他模块注册的内置工具（所有智能体可用），如工作项工具 */
  private extraTools = new Map<string, { def: BetaToolUnion; run: ToolHandler; when?: (task: Task, agent: Agent) => boolean }>();
  private hooks: RuntimeHooks = {};
  cli: CliExecutor | null = null;
  /** 演示模式：忽略智能体的运行底座，全部走内置循环（脚本化模型） */
  forceBuiltin = false;

  constructor(store: Store, llm: LLM, opts: RuntimeOptions, mcp = new McpManager()) {
    this.store = store;
    this.llm = llm;
    this.opts = opts;
    this.mcp = mcp;
    this.modelLimit = opts.maxConcurrency;
    this.sem = new PrioritySlots(() => this.modelLimit);
    this.events.setMaxListeners(0);
  }

  // ======================= 对外 API =======================

  /** 注册一个对所有智能体可用的内置工具 */
  addTool(def: BetaToolUnion & { name: string }, run: ToolHandler, when?: (task: Task, agent: Agent) => boolean) {
    this.extraTools.set(def.name, { def, run, when });
  }

  /** 调整内置运行底座同时在途的模型请求数（设置里修改后立即生效） */
  setConcurrency(n: number) {
    this.modelLimit = Math.max(1, Math.floor(n) || 1);
    this.sem.pump();
  }
  concurrency() {
    return { model: { limit: this.modelLimit, running: this.sem.running, waiting: this.sem.waiting } };
  }

  setHooks(h: RuntimeHooks) {
    this.hooks = { ...this.hooks, ...h };
  }

  /** 设置里更换 API Key 等情况下替换模型客户端 */
  setLLM(llm: LLM) {
    this.llm = llm;
  }

  /** 供 CLI 底座通过 MCP 桥调用 Hub 的工具（以某个任务的身份） */
  async invokeTool(taskId: string, name: string, input: unknown): Promise<ToolOutput> {
    const task = this.store.getTask(taskId);
    if (!task || TERMINAL.has(task.status)) throw new Error("任务不存在或已结束");
    const agent = this.store.getAgent(task.agent);
    if (!agent) throw new Error("智能体不存在");
    const signal = this.controllers.get(taskId)?.signal ?? new AbortController().signal;
    this.touch(taskId);
    const extra = this.extraTools.get(name);
    if (extra && (!extra.when || extra.when(task, agent))) return extra.run(input, { task, agent, signal });
    return { content: await this.runTool(name, input, agent, task) };
  }

  /** 供 CLI 桥列出某任务可用的 Hub 工具 */
  toolDefsFor(taskId: string): BetaToolUnion[] {
    const task = this.store.getTask(taskId);
    const agent = task && this.store.getAgent(task.agent);
    return task && agent ? this.toolsFor(agent, task).filter((t) => !("type" in t && t.type && t.type !== "custom")) : [];
  }

  /** 心跳：更新任务的 updated_at，哨兵据此判断是否卡住 */
  touch(id: string) {
    this.store.updateTask(id, {});
  }

  /** 结束一个运行中的任务（由工作项生命周期等调用） */
  fail(id: string, error: string) {
    this.controllers.get(id)?.abort();
    this.finish(id, { status: "failed", error });
  }

  /** 创建任务并异步开始执行，立即返回任务记录 */
  submit(
    agentName: string,
    input: string,
    meta: { parent?: Task; source?: TaskSource; hops?: number; issueId?: number | null; priority?: number } = {},
  ): Task {
    if (!this.store.getAgent(agentName)) throw new Error(`unknown agent: ${agentName}`);
    const id = randomUUID();
    const task = this.store.insertTask({
      id,
      agent: agentName,
      input,
      status: "pending",
      result: null,
      error: null,
      parentId: meta.parent?.id ?? null,
      rootId: meta.parent?.rootId ?? id,
      depth: meta.parent ? meta.parent.depth + 1 : 0,
      hops: meta.hops ?? 0,
      source: meta.source ?? "api",
      issueId: meta.issueId ?? null,
      priority: meta.priority ?? meta.parent?.priority ?? 0,
    });
    this.emitTask(task);
    this.enqueueReady(task);
    return task;
  }

  /**
   * 直接调用一个智能体并等待结果（管家、外部入口用）。
   * 与智能体之间的 call_agent 不同：这里没有父任务，也不受 delegation 限制，
   * 调用方拿到的是最终回复文本。
   */
  /** CLI 任务持有的进程槽位（可在阻塞等待时让出） */
  private slotHandles = new Map<string, { release: () => void; reacquire: () => Promise<void> }>();
  /**
   * 阻塞等待别的工作（等测试、等委派的子任务、等人确认需求）期间让出 CLI 槽位，结束后再拿回。
   * 否则「占着槽位等待」的任务会和「等槽位才能开始」的任务互相卡死：
   * 例如 Claude Code 并发上限 2、两个开发任务都在等测试，tester 永远拿不到槽位。
   * 非 CLI 任务（内置底座按模型请求限流）直接执行 fn。
   */
  async waiting<T>(taskId: string, fn: () => Promise<T>): Promise<T> {
    const h = this.slotHandles.get(taskId);
    if (!h) return fn();
    h.release();
    try { return await fn(); }
    finally { await h.reacquire().catch(() => {}); } // 拿回时被取消：任务本身也已取消，交给原有流程收尾
  }

  async callAgent(agentName: string, input: string, opts: { timeoutMs?: number; priority?: number } = {}): Promise<{ taskId: string; status: string; result: string | null; error: string | null; timedOut: boolean }> {
    if (!this.store.getAgent(agentName)) throw new Error(`智能体 ${agentName} 不存在`);
    const task = this.submit(agentName, input, { source: "api", hops: 0, priority: opts.priority ?? 2 });
    const done = await this.waitFor(task.id, opts.timeoutMs ?? 120_000);
    const timedOut = !TERMINAL.has(done.status);
    return { taskId: task.id, status: done.status, result: done.result ?? null, error: done.error ?? null, timedOut };
  }

  /** 模型调用遇到网络抖动时退避重试，最多约 7 分钟；其他错误原样抛出 */
  private async createWithRetry<T>(taskId: string, fn: () => Promise<T>, signal: AbortSignal): Promise<T> {
    for (let n = 0; ; n++) {
      try { return await fn(); }
      catch (e) {
        if (signal.aborted || n >= 6 || !isTransientError(e)) throw e;
        const wait = backoffMs(n) * 1000;
        console.warn(`[task] ${taskId.slice(0, 8)} 模型调用网络异常（${String((e as Error).message ?? e).slice(0, 80)}），${wait / 1000} 秒后第 ${n + 1} 次重试`);
        this.touch(taskId);
        await sleep(wait, signal);
      }
    }
  }

  /** 等待任务结束（completed / failed / cancelled） */
  waitFor(id: string, timeoutMs?: number): Promise<Task> {
    const current = this.store.getTask(id);
    if (!current) return Promise.reject(new Error(`unknown task: ${id}`));
    if (TERMINAL.has(current.status)) return Promise.resolve(current);
    return new Promise((resolve) => {
      const done = (t: Task) => {
        clearTimeout(timer);
        resolve(t);
      };
      const timer = timeoutMs
        ? setTimeout(() => {
            this.events.off(`done:${id}`, done);
            resolve(this.store.getTask(id)!);
          }, timeoutMs)
        : undefined;
      this.events.once(`done:${id}`, done);
    });
  }

  /** 取消任务，连带取消其所有未结束的子任务 */
  cancel(id: string): Task | undefined {
    const task = this.store.getTask(id);
    if (!task) return undefined;
    for (const child of this.store.listTasks({ parentId: id, limit: 1000 })) {
      if (!TERMINAL.has(child.status)) this.cancel(child.id);
    }
    if (!TERMINAL.has(task.status)) {
      this.controllers.get(id)?.abort();
      this.finish(id, { status: "cancelled", error: "cancelled" });
    }
    return this.store.getTask(id);
  }

  /** 向总线发布消息，并为订阅该主题的智能体创建任务 */
  publish(topic: string, content: string, from: { sender: string; task?: Task; hops?: number }): BusMessage {
    const hops = from.hops ?? 0;
    const msg = this.store.publish({ topic, sender: from.sender, content, taskId: from.task?.id ?? null, hops });
    this.events.emit("event", { type: "bus", message: msg } satisfies HubEvent);

    if (hops >= this.opts.maxHops) return msg; // 防止订阅环路无限触发
    for (const agent of this.store.listAgents()) {
      if (!agent.subscribe.includes(topic) || agent.name === from.sender) continue;
      this.submit(
        agent.name,
        `总线主题「${topic}」收到一条来自 ${from.sender} 的新消息（#${msg.id}）：\n\n${content}\n\n` +
          `请按你的职责处理。如需回应，可用 publish 工具发布到相应主题。`,
        { source: "bus", hops: hops + 1, priority: from.task?.priority ?? 0 },
      );
    }
    return msg;
  }

  // ======================= 执行循环 =======================

  /** 同一批提交的任务按优先级启动，避免先提交的低优先级任务抢先占满槽位 */
  private ready: Task[] = [];
  private readyTimer: ReturnType<typeof setTimeout> | null = null;
  private enqueueReady(task: Task) {
    this.ready.push(task);
    if (this.readyTimer) return;
    this.readyTimer = setTimeout(() => {
      this.readyTimer = null;
      const batch = this.ready.sort((a, b) => priorityRank(a.priority) - priorityRank(b.priority));
      this.ready = [];
      for (const t of batch) void this.execute(t.id);
    }, 0);
  }

  private async execute(id: string) {
    const task = this.store.getTask(id);
    if (!task || task.status !== "pending") return;
    const agent = this.store.getAgent(task.agent);
    if (!agent) return this.finish(id, { status: "failed", error: `agent ${task.agent} was deleted` });

    const controller = new AbortController();
    this.controllers.set(id, controller);
    const viaCli = !!agent.runtime && agent.runtime !== "builtin" && !this.forceBuiltin;
    // CLI 底座：先排队拿进程槽位，排队期间保持 pending（哨兵不会把它当成卡住）
    let releaseCli: (() => void) | null = null;
    if (viaCli && this.cli?.acquire) {
      try { releaseCli = await this.cli.acquire(agent.runtime, task.priority, controller.signal); }
      catch { this.controllers.delete(id); return; } // 排队时被取消，cancel() 已写入状态
      if (controller.signal.aborted || this.store.getTask(id)?.status !== "pending") { releaseCli(); this.controllers.delete(id); return; }
      // 阻塞等待其它任务时可以让出槽位（见 waiting()）
      const cli = this.cli;
      this.slotHandles.set(id, {
        release: () => { const r = releaseCli; releaseCli = null; r?.(); },
        // 拿回槽位用最高优先级：手上的活做了一半，应先于新任务收尾
        reacquire: async () => { if (!releaseCli) releaseCli = await cli.acquire!(agent.runtime, 1, controller.signal); },
      });
    }
    this.emitTask(this.store.updateTask(id, { status: "running" }));

    const system = this.systemFor(agent) + (this.hooks.systemExtra?.(task, agent) ?? "");
    let inputTokens = 0;
    let outputTokens = 0;
    let cost = 0;

    if (viaCli) {
      try {
        if (!this.cli) throw new Error(`运行底座 ${agent.runtime} 不可用`);
        // 对话记录边跑边存（最多每 2 秒一次）：CLI 运行动辄几十分钟，不能等结束才让人看到它在做什么
        let lastSave = 0;
        let pending: BetaMessageParam[] | null = null;
        let timer: NodeJS.Timeout | null = null;
        const flush = () => {
          timer = null;
          if (!pending || controller.signal.aborted) return;
          this.store.saveMessages(id, pending);
          pending = null;
          lastSave = Date.now();
          const t = this.store.getTask(id);
          if (t) this.emitTask(t);
        };
        const progress = (transcript: BetaMessageParam[]) => {
          pending = transcript.slice();
          if (timer) return;
          timer = setTimeout(flush, Math.max(0, 2000 - (Date.now() - lastSave)));
        };
        const out = await this.cli.run(task, agent, { system, signal: controller.signal, heartbeat: () => this.touch(id), progress }).finally(() => { if (timer) clearTimeout(timer); });
        if (controller.signal.aborted) return;
        if (out.transcript) this.store.saveMessages(id, out.transcript);
        this.store.updateTask(id, { inputTokens: out.inputTokens ?? 0, outputTokens: out.outputTokens ?? 0, cost: out.cost ?? 0, turns: 1 });
        return this.finish(id, { status: "completed", result: out.result });
      } catch (err) {
        if (controller.signal.aborted) return;
        return this.finish(id, { status: "failed", error: describeError(err) });
      } finally {
        releaseCli?.();
        this.slotHandles.delete(id);
        this.controllers.delete(id);
      }
    }

    try {
      const external = await buildExternalTools(agent, this.store, this.mcp);
      const tools = [...this.toolsFor(agent, task), ...external.defs];
      const input = external.warnings.length
        ? `${task.input}\n\n[系统提示] 以下配置的工具当前不可用：\n- ${external.warnings.join("\n- ")}`
        : task.input;
      const messages: BetaMessageParam[] = [{ role: "user", content: input }];
      this.store.saveMessages(id, messages);
      recordReceipt(
        this.store,
        builtinReceipt({
          taskId: id, agent: agent.name, model: agent.model, system, input,
          tools: tools.map((t) => ("name" in t ? String(t.name) : String((t as { type?: string }).type ?? "?"))),
          skills: agent.skills ?? [], knowledge: (input.match(/^- \[/gm) ?? []).length,
        }),
      );

      for (let turn = 1; turn <= agent.maxTurns; turn++) {
        if (controller.signal.aborted) return;

        // 排队等模型槽位、以及长时间的模型调用期间每 30 秒更新心跳，避免被哨兵误判为卡住
        const beat = setInterval(() => this.touch(id), 30_000);
        // 网络抖动（连接超时、5xx、限流、过载）就地重试，不让整次运行失败——对话进度都在内存里，失败就白跑了
        const response = await this.sem.run(() => this.createWithRetry(id, () =>
          this.llm.create(
            {
              model: agent.model,
              max_tokens: 16000,
              system,
              messages,
              ...(tools.length ? { tools } : {}),
              output_config: { effort: agent.effort },
              cache_control: { type: "ephemeral" },
              // 安全分类器拒答时由服务端自动切换到回退模型
              betas: ["server-side-fallback-2026-07-01"],
              fallbacks: "default",
            },
            { signal: controller.signal },
          ), controller.signal), task.priority, controller.signal).finally(() => clearInterval(beat));

        inputTokens +=
          response.usage.input_tokens +
          (response.usage.cache_read_input_tokens ?? 0) +
          (response.usage.cache_creation_input_tokens ?? 0);
        outputTokens += response.usage.output_tokens;
        cost += costOf(agent.model, response.usage);
        messages.push({ role: "assistant", content: response.content });
        this.store.saveMessages(id, messages);
        this.emitTask(this.store.updateTask(id, { turns: turn, inputTokens, outputTokens, cost }));

        switch (response.stop_reason) {
          case "end_turn":
          case "stop_sequence": {
            const more = this.hooks.continuation?.(this.store.getTask(id)!, finalText(response));
            if (more) {
              messages.push({ role: "user", content: more });
              this.store.saveMessages(id, messages);
              continue;
            }
            return this.finish(id, { status: "completed", result: finalText(response) });
          }
          case "pause_turn":
            continue; // 服务端工具未跑完，原样回传继续
          case "tool_use": {
            const results = await this.runTools(response, agent, this.store.getTask(id)!, external, controller.signal);
            if (controller.signal.aborted) return;
            messages.push({ role: "user", content: results });
            this.store.saveMessages(id, messages);
            continue;
          }
          case "refusal":
            return this.finish(id, {
              status: "failed",
              error: `model refused (${response.stop_details?.category ?? "unknown"})`,
            });
          default:
            return this.finish(id, { status: "failed", error: `stopped: ${response.stop_reason}` });
        }
      }
      this.finish(id, { status: "failed", error: `exceeded maxTurns (${agent.maxTurns})` });
    } catch (err) {
      if (controller.signal.aborted) return; // cancel() 已经写入状态
      this.finish(id, { status: "failed", error: describeError(err) });
    } finally {
      this.controllers.delete(id);
    }
  }

  private finish(id: string, patch: { status: Task["status"]; result?: string; error?: string }) {
    const current = this.store.getTask(id);
    if (!current || TERMINAL.has(current.status)) return;
    const task = this.store.updateTask(id, { status: patch.status, result: patch.result ?? null, error: patch.error ?? null });
    this.emitTask(task);
    this.events.emit(`done:${id}`, task);
  }

  private emitTask(task: Task) {
    this.events.emit("event", { type: "task", task } satisfies HubEvent);
  }

  // ======================= 工具 =======================

  private canCall(agent: Agent, target: string): boolean {
    if (agent.delegation === "any") return true;
    if (agent.delegation === "none") return false;
    return agent.delegation.includes(target);
  }

  private toolsFor(agent: Agent, task?: Task): BetaToolUnion[] {
    const tools: BetaToolUnion[] = [];
    if (agent.delegation !== "none") {
      tools.push(
        {
          name: "list_agents",
          description: "列出你可以调用的其他智能体及其职责说明。",
          input_schema: { type: "object", properties: {}, additionalProperties: false },
        },
        {
          name: "call_agent",
          description:
            "把一个子任务交给另一个智能体执行，并等待它返回结果。对方看不到你的上下文，task 里要写清楚背景、要求和期望的输出格式。" +
            "多个互不依赖的子任务请在同一轮里并行发起多次调用。",
          input_schema: {
            type: "object",
            properties: {
              agent: { type: "string", description: "目标智能体名称" },
              task: { type: "string", description: "完整、自包含的任务描述" },
            },
            required: ["agent", "task"],
            additionalProperties: false,
          },
          strict: true,
        },
      );
    }
    tools.push(
      {
        name: "publish",
        description: "向共享消息总线的某个主题发布消息。订阅该主题的智能体会被自动唤醒处理。",
        input_schema: {
          type: "object",
          properties: { topic: { type: "string" }, content: { type: "string" } },
          required: ["topic", "content"],
          additionalProperties: false,
        },
        strict: true,
      },
      {
        name: "read_topic",
        description: "读取消息总线上某个主题最近的消息（黑板）。",
        input_schema: {
          type: "object",
          properties: { topic: { type: "string" }, limit: { type: "integer", description: "默认 20" } },
          required: ["topic"],
          additionalProperties: false,
        },
      },
    );
    for (const { def, when } of this.extraTools.values()) if (!when || (task && when(task, agent))) tools.push(def);
    if (agent.serverTools.includes("web_search")) tools.push({ type: "web_search_20260209", name: "web_search", max_uses: 5 });
    if (agent.serverTools.includes("web_fetch")) tools.push({ type: "web_fetch_20260209", name: "web_fetch", max_uses: 5 });
    return tools;
  }

  private systemFor(agent: Agent): string {
    const parts = [agent.system.trim()];
    parts.push(
      `\n\n---\n你是多智能体协作服务中的智能体「${agent.name}」。` +
        (agent.delegation !== "none"
          ? "你可以用 call_agent 把子任务交给其他智能体，先用 list_agents 了解有哪些智能体。"
          : "") +
        "你可以通过 publish / read_topic 使用共享消息总线。" +
        "完成任务后，直接给出最终结果作为回复。",
    );
    return parts.join("").trim();
  }

  /** 并行执行一轮里的所有工具调用，结果放在同一条 user 消息里返回 */
  private async runTools(
    response: BetaMessage,
    agent: Agent,
    task: Task,
    external: ExternalTools,
    signal: AbortSignal,
  ): Promise<BetaToolResultBlockParam[]> {
    const calls = response.content.filter((b) => b.type === "tool_use");
    return Promise.all(
      calls.map(async (call): Promise<BetaToolResultBlockParam> => {
        try {
          const extra = this.extraTools.get(call.name);
          const handler = (extra && (!extra.when || extra.when(task, agent)) ? extra.run : undefined) ?? external.handlers.get(call.name);
          const out: ToolOutput = handler
            ? await handler(call.input, { task, agent, signal })
            : { content: await this.runTool(call.name, call.input, agent, task) };
          return {
            type: "tool_result",
            tool_use_id: call.id,
            content: out.content,
            ...(out.isError ? { is_error: true } : {}),
          };
        } catch (err) {
          return { type: "tool_result", tool_use_id: call.id, content: describeError(err), is_error: true };
        }
      }),
    );
  }

  private async runTool(name: string, rawInput: unknown, agent: Agent, task: Task): Promise<string> {
    switch (name) {
      case "list_agents": {
        const list = this.store
          .listAgents()
          .filter((a) => this.canCall(agent, a.name))
          .map((a) => ({ name: a.name, description: a.description, self: a.name === agent.name }));
        return JSON.stringify(list, null, 2);
      }
      case "call_agent": {
        const input = parse(CallAgentInput, rawInput);
        if (!this.canCall(agent, input.agent)) throw new ToolError(`你没有权限调用智能体 ${input.agent}`);
        if (!this.store.getAgent(input.agent)) throw new ToolError(`智能体 ${input.agent} 不存在，先用 list_agents 查看`);
        if (task.depth + 1 > this.opts.maxDepth)
          throw new ToolError(`委派深度已达上限 ${this.opts.maxDepth}，请自己完成这部分工作`);
        const child = this.submit(input.agent, input.task, { parent: task, source: "delegate", hops: task.hops });
        const done = await this.waiting(task.id, () => this.waitFor(child.id));
        if (done.status !== "completed") throw new ToolError(`${input.agent} 执行失败（${done.status}）：${done.error}`);
        return done.result ?? "";
      }
      case "publish": {
        const input = parse(PublishInput, rawInput);
        const msg = this.publish(input.topic, input.content, { sender: agent.name, task, hops: task.hops });
        return `已发布到 ${input.topic}（#${msg.id}）`;
      }
      case "read_topic": {
        const input = parse(ReadTopicInput, rawInput);
        const msgs = this.store.readTopic(input.topic, { limit: input.limit ?? 20 });
        if (!msgs.length) return `主题 ${input.topic} 暂无消息`;
        return msgs.map((m) => `#${m.id} [${m.createdAt}] ${m.sender}: ${m.content}`).join("\n\n");
      }
      default:
        throw new ToolError(`未知工具 ${name}`);
    }
  }
}

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const r = schema.safeParse(input);
  if (!r.success) throw new ToolError(`参数不合法：${r.error.message}`);
  return r.data;
}

function finalText(msg: BetaMessage): string {
  return msg.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

function describeError(err: unknown): string {
  if (err instanceof Anthropic.APIError) return `Claude API error ${err.status ?? ""}: ${err.message}`;
  return err instanceof Error ? err.message : String(err);
}
