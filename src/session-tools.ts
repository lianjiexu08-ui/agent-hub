/**
 * 会话工具层：open_session / reply_session / close_session / read_session。
 *
 * 设计要点：
 * - 只有工具能改会话状态。轮次、时间、预算三道闸都在 Sessions 里，智能体绕不过去。
 * - 驱动对方发言时持有会话锁。被驱动方即使误调 reply_session 也会被拒绝，
 *   避免「A 驱动 B、B 又驱动回 A」的嵌套调用把任务树撑爆——这也是本层不递归的保证。
 * - 每轮提示都写明轮次余量与三条发言要求（回应 / 立场 / 下一步），
 *   没有这三条，两个模型会互相客套到轮次上限。
 */
import { z } from "zod";
import type { Runtime } from "./runtime.ts";
import type { Session, Sessions } from "./session.ts";

/** 一轮发言的产出。tokens 用于回填会话预算 */
export interface SessionTurn {
  text: string;
  tokens?: number;
}

/**
 * 驱动某个智能体针对给定提示发言。
 * index.ts 里用 runtime.callAgent 实现：它提交一个独立任务并等结果，不挂在当前任务树下。
 */
export type SessionDriver = (agent: string, input: string, opts?: { timeoutMs?: number }) => Promise<SessionTurn>;

export interface SessionToolOpts {
  /** 单条回复回灌给模型时的最大字符数，默认 6000，防止长文把上下文撑爆 */
  maxReplyChars?: number;
  /** 单轮等待上限，默认 120 秒；超过按超时中止本轮 */
  turnTimeoutMs?: number;
  /** 只对满足条件的任务暴露这些工具，默认全部暴露 */
  when?: (task: unknown) => boolean;
}

interface Ctx {
  agent: { name: string };
  signal?: AbortSignal;
}

export function registerSessionTools(runtime: Runtime, sessions: Sessions, driver: SessionDriver, opts: SessionToolOpts = {}) {
  const maxReply = opts.maxReplyChars ?? 6000;
  const turnTimeout = opts.turnTimeoutMs ?? 120_000;

  /** 触顶原因的中文说法：这些字符串会原样进模型上下文，不能把枚举名丢过去 */
  const REASON: Record<string, string> = {
    max_turns: "轮次已达上限",
    deadline: "已超过截止时间",
    budget: "token 预算已用完",
    human: "已由人工结束",
  };

  /** 超长回复截断：留给模型看的是观点，不是整篇文档 */
  const clip = (t: string) => (t.length > maxReply ? `${t.slice(0, maxReply)}\n…（已截断，原文 ${t.length} 字）` : t);

  /** 会话不存在时抛错：这些是写操作，静默返回空结果会让调用方以为写入成功 */
  const must = (id: string): Session => {
    const s = sessions.get(id);
    if (!s) throw new Error(`会话 ${id} 不存在`);
    return s;
  };

  /** 对外的会话视图，去掉内部记账字段 */
  const view = (s: Session) => ({
    id: s.id,
    topic: s.topic,
    participants: s.participants,
    turn: s.turn,
    maxTurns: s.maxTurns,
    status: s.status,
    endReason: s.endReason,
    conclusion: s.conclusion,
    tokensUsed: s.tokensUsed,
    tokenBudget: s.tokenBudget,
    deadline: s.deadline,
    issueId: s.issueId,
    projectId: s.projectId,
  });

  /** 取最近几轮发言，越靠后越新。8 轮足够让模型抓住上下文，再多只是噪音 */
  const transcript = (s: Session, limit = 8) =>
    sessions
      .messages(s.id)
      .slice(-limit)
      .map((m) => `[${m.from} · 第${m.turn}轮]\n${clip(m.text)}`)
      .join("\n\n");

  /** 被驱动方看到的提示：议题、已有发言、本轮余量、三条硬要求 */
  const promptFor = (s: Session, me: string, other: string) => {
    const left = Math.max(0, s.maxTurns - s.turn);
    const last = sessions.canContinue(s.id);
    const closing = !last.ok || left <= 1;
    return [
      `## 会话 ${s.id} · 第 ${s.turn + 1}/${s.maxTurns} 轮`,
      `议题：${s.topic}`,
      `你是：${me}。对方是：${other}。`,
      "",
      "以下是到目前为止的发言（从早到晚）：",
      transcript(s),
      "",
      "请只做一件事：针对对方最后一条发言给出你的回应，直接输出正文。要求：",
      "1. 先具体回应对方说到的点，不要自说自话；",
      "2. 明确立场，三选一：同意 / 反对 / 有条件同意；",
      "3. 结尾一句话说明你最需要对方补充的信息，或说明你认为可以收口了。",
      "",
      closing
        ? "这是最后一轮，必须给出结论：决定是什么、依据是什么、还有哪些未决。不要再提新问题。"
        : `还剩 ${left - 1} 轮。不要调用 reply_session 或 close_session，你的这段回复会被自动记录并转给对方。`,
    ].join("\n");
  };

  /**
   * 驱动一方发言并落库。返回更新后的会话。
   * 落库用 say 而不是 advance：闸在调模型前已经判过一次，而调用期间可能刚好超时或涨过预算，
   * advance 会再判一次并抛错。可对方的话已经花掉 token 说出口了，丢掉等于既花了钱又丢了上下文。
   */
  const drive = async (s: Session, agent: string, other: string): Promise<Session> => {
    const gate = sessions.canContinue(s.id);
    if (!gate.ok) throw new Error(`会话 ${s.id} 已经不能继续（${REASON[gate.reason] ?? gate.reason}）`);
    const r = await driver(agent, promptFor(s, agent, other), { timeoutMs: turnTimeout });
    const text = String(r?.text ?? "").trim();
    if (!text) throw new Error(`智能体 ${agent} 没有给出回复（可能超时或运行失败），本轮中止`);
    if (r?.tokens) sessions.addUsage(s.id, r.tokens);
    return sessions.say(s.id, agent, text);
  };

  /** 驱动失败时补上收口指引：会话不会自己收尾，不说清楚就会一直挂在「进行中」 */
  const failed = (id: string, e: unknown) =>
    new Error(`${e instanceof Error ? e.message : String(e)}。会话 ${id} 仍未结束，已记录的发言保留；请用 close_session(session="${id}", conclusion="...") 收场`);

  /** 统一处理：参数校验 + 异常转成工具错误，不让异常冒到模型轮次里 */
  const wrap =
    <T>(schema: z.ZodType<T>, fn: (input: T, ctx: Ctx) => Promise<string>) =>
    async (raw: unknown, ctx: Ctx) => {
      const parsed = schema.safeParse(raw);
      if (!parsed.success) return { content: `参数不合法：${parsed.error.message}`, isError: true };
      try {
        return { content: await fn(parsed.data, ctx) };
      } catch (e) {
        return { content: (e as Error).message || "会话操作失败", isError: true };
      }
    };

  const who = (ctx: Ctx) => {
    const name = String(ctx.agent?.name ?? "").trim();
    if (!name) throw new Error("无法确定当前智能体，会话工具不可用");
    return name;
  };

  runtime.addTool(
    {
      name: "open_session",
      description:
        "和另一个智能体开一场有界的技术讨论，并同步等到对方的第一次回应。适用于需要来回确认、需要对方反问的场景（接口边界、方案取舍、问题复现）。简单派活请用 call_agent，更便宜也更快。轮次上限 12，默认 6；时限默认 15 分钟；token 预算默认 60k。",
      input_schema: {
        type: "object",
        properties: {
          agent: { type: "string", description: "对话对象的智能体名" },
          topic: { type: "string", description: "一句话议题，会写进每一轮提示，防止话题漂移" },
          opening: { type: "string", description: "你的开场白，必须包含背景和你的初步立场" },
          maxTurns: { type: "integer", description: "轮次上限，默认 6，最多 12" },
          deadlineMinutes: { type: "integer", description: "时限，默认 15 分钟" },
          tokenBudget: { type: "integer", description: "整场会话的 token 上限，默认 60000" },
          issueId: { type: "integer", description: "关联的工作项编号，可选" },
        },
        required: ["agent", "topic", "opening"],
        additionalProperties: false,
      },
    } as never,
    wrap(
      z.object({
        agent: z.string().min(1),
        topic: z.string().min(1),
        opening: z.string().min(1),
        maxTurns: z.number().int().min(2).max(12).optional(),
        deadlineMinutes: z.number().int().min(1).max(120).optional(),
        tokenBudget: z.number().int().min(1000).optional(),
        issueId: z.number().int().optional(),
      }),
      async (input, ctx) => {
        const me = who(ctx);
        if (input.agent === me) throw new Error("不能和自己开会话，换一个智能体");
        const s = sessions.open({
          topic: input.topic,
          participants: [me, input.agent],
          opening: input.opening,
          maxTurns: input.maxTurns,
          deadlineMinutes: input.deadlineMinutes,
          tokenBudget: input.tokenBudget,
          issueId: input.issueId ?? null,
        });
        if (!sessions.lock(s.id)) throw new Error(`会话 ${s.id} 正在被占用`);
        try {
          const after = await drive(s, input.agent, me);
          const reply = sessions.messages(s.id).at(-1)?.text ?? "";
          return JSON.stringify({ session: view(after), turn: after.turn, reply: clip(reply) });
        } catch (e) {
          throw failed(s.id, e);
        } finally {
          sessions.unlock(s.id);
        }
      },
    ),
  );

  runtime.addTool(
    {
      name: "reply_session",
      description:
        "在已有会话里发言。给了 next 就继续等对方下一轮回复；不给 next 表示你认为可以收口，会话会以你这条发言作为结论结束。发言必须包含：对上一轮的具体回应、明确立场（同意/反对/有条件同意）、下一步。",
      input_schema: {
        type: "object",
        properties: {
          session: { type: "string", description: "会话编号，如 s_ab12cd" },
          text: { type: "string", description: "你的发言正文" },
          next: { type: "string", description: "下一位发言的智能体名；留空表示结束讨论" },
          conclusion: { type: "string", description: "next 留空时的结论正文；不填则用本条发言兜底" },
        },
        required: ["session", "text"],
        additionalProperties: false,
      },
    } as never,
    wrap(
      z.object({ session: z.string().min(1), text: z.string().min(1), next: z.string().optional(), conclusion: z.string().optional() }),
      async (input, ctx) => {
        const me = who(ctx);
        const s = must(input.session);
        if (!s.participants.includes(me)) throw new Error(`你不是会话 ${s.id} 的参与方（${s.participants.join(" / ")}）`);
        if (sessions.isLocked(s.id)) {
          throw new Error("会话正在由另一方推进，你只需要在回复正文里说明观点，不要调用会话工具");
        }
        // 串行交替：上一条是自己说的，就该等对方回应。允许连说两条会让「回应了谁」失去意义，
        // 也会让轮次账目对不上（提示里写的是「回应上一位」，实际上一句是自言自语）
        const other = s.participants.find((p) => p !== me) ?? s.participants[0];
        const prev = sessions.messages(s.id).at(-1);
        if (prev && prev.from === me) {
          throw new Error(
            `会话 ${s.id} 上一条（第 ${prev.turn} 轮）已经是你的发言，现在该 ${other} 回应；` +
              `如果对方没能回应，请用 close_session 写下结论收场`,
          );
        }
        // next 先校验再落库：参数写错不该把这一轮发言一起消耗掉
        const next = input.next?.trim() || null;
        if (next && !s.participants.includes(next)) throw new Error(`next 必须是会话参与方之一：${s.participants.join(" / ")}`);
        if (next === me) throw new Error("不能点名自己，换另一方");

        const after = sessions.advance(s.id, me, input.text);
        const gate = sessions.canContinue(after.id);
        if (!next || !gate.ok) {
          const reason = gate.ok ? "conclusion" : gate.reason;
          const closed = sessions.close(after.id, input.conclusion ?? null, reason);
          return JSON.stringify({ session: view(closed), turn: closed.turn, reply: null, ended: closed.endReason });
        }
        if (!sessions.lock(s.id)) throw new Error(`会话 ${s.id} 正在被占用`);
        try {
          const r = await drive(after, next, me);
          const reply = sessions.messages(s.id).at(-1)?.text ?? "";
          return JSON.stringify({ session: view(r), turn: r.turn, reply: clip(reply) });
        } catch (e) {
          throw failed(s.id, e);
        } finally {
          sessions.unlock(s.id);
        }
      },
    ),
  );

  runtime.addTool(
    {
      name: "close_session",
      description: "结束一场会话并给出结论。结论要写清楚：决定了什么、依据是什么、还有哪些未决。中止的会话也必须留下结论。",
      input_schema: {
        type: "object",
        properties: {
          session: { type: "string", description: "会话编号" },
          conclusion: { type: "string", description: "结论正文" },
        },
        required: ["session", "conclusion"],
        additionalProperties: false,
      },
    } as never,
    wrap(z.object({ session: z.string().min(1), conclusion: z.string().min(1) }), async (input, ctx) => {
      const me = who(ctx);
      const s = must(input.session);
      if (!s.participants.includes(me)) throw new Error(`你不是会话 ${s.id} 的参与方（${s.participants.join(" / ")}）`);
      // 有人正在说话时结束，会把对方这一轮的回答一并作废，不如等它落定
      if (sessions.isLocked(s.id)) throw new Error(`会话 ${s.id} 正在等对方发言，等这一轮结束后再关`);
      if (s.status !== "open") return JSON.stringify({ session: view(s), note: "会话已经结束，保留原有结论" });
      const closed = sessions.close(s.id, input.conclusion, "conclusion");
      return JSON.stringify({ session: view(closed) });
    }),
  );

  runtime.addTool(
    {
      name: "read_session",
      description: "查看会话的当前状态与全部发言。用于接续一场之前开的会话，或向上汇报讨论过程。",
      input_schema: {
        type: "object",
        properties: { session: { type: "string", description: "会话编号" } },
        required: ["session"],
        additionalProperties: false,
      },
    } as never,
    wrap(z.object({ session: z.string().min(1) }), async (input) => {
      const s = must(input.session);
      const msgs = sessions.messages(s.id);
      return JSON.stringify({
        session: view(s),
        messages: msgs.map((m) => ({ turn: m.turn, from: m.from, text: clip(m.text), at: m.at })),
        remaining: Math.max(0, s.maxTurns - s.turn),
      });
    }),
  );
}
