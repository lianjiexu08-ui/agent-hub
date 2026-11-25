/**
 * 智能体会话：让两个智能体围绕一个议题多轮往返，最后收敛出一条能落地的结论。
 *
 * 为什么需要它：call_agent 只有一问一答（对方没法反问），publish / read_topic 没有会话状态
 * （谁被唤醒、回不回、回到哪个话题全靠自觉），ask_agent 是单轮且结果只留在管家对话里。
 * 「架构师和前端就接口边界来回确认」这类场景缺的正是这条通道。
 *
 * 三条硬约束都在这一层落地，而不是指望智能体自觉：
 * - 有界：轮次 / 时间 / token 三重上限，任一触顶就拒绝继续发言（canContinue / advance）
 * - 串行：lock() 保证同一会话同一时刻只有一个任务在跑，避免两边同时改同一份上下文
 * - 有结论：close() 必须留下 conclusion，触顶中止也要说明「讨论到哪、还差什么」
 *
 * 存储沿用通用文档表（与 work.ts 一致）：会话存 sessions，消息存 session_msgs。
 * 会话量级很小、消息一轮一条且上限 12 条，直接按 sessionId 过滤即可，不为它单独建表。
 */
import type { Store } from "./db.ts";

export interface Session {
  id: string; // "s_" + 6 位随机
  topic: string;
  participants: [string, string]; // 恰好两方，第一个是发起方
  turn: number; // 已完成轮次
  maxTurns: number; // 默认 6，硬上限 12
  deadline: string; // ISO 时间，默认创建后 15 分钟
  tokenBudget: number; // 默认 60000
  tokensUsed: number;
  status: "open" | "closed" | "aborted";
  conclusion: string | null;
  endReason: "conclusion" | "max_turns" | "deadline" | "budget" | "human" | null;
  projectId: string | null;
  issueId: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface SessionMessage {
  id: number; // 自增
  sessionId: string;
  turn: number; // 1-based，属于第几轮
  from: string; // 发言人 agent 名
  text: string;
  at: string;
}

export interface OpenInput {
  topic: string;
  participants: [string, string];
  opening: string; // 发起方 opening，写入第 1 条消息
  maxTurns?: number;
  deadlineMinutes?: number;
  tokenBudget?: number;
  projectId?: string | null;
  issueId?: number | null;
}

const DEFAULT_MAX_TURNS = 6;
/** 硬上限：每轮至少一次模型调用，没有这个闸，一次会话就能把预算烧穿 */
const HARD_MAX_TURNS = 12;
const DEFAULT_DEADLINE_MINUTES = 15;
const DEFAULT_TOKEN_BUDGET = 60_000;

/** 中止原因的人话解释，用于兜底结论里说明「为什么没聊出结果」 */
const END_LABEL: Record<string, string> = {
  conclusion: "调用方声明已达成结论，但没有给出结论正文",
  max_turns: "轮次已达上限",
  deadline: "已超过时限",
  budget: "token 预算已用完",
  human: "由人工结束",
};

export class Sessions {
  private store: Store;
  /** 进程内的串行锁。会话不跨进程，用 Set 就够，不必落库 */
  private locks = new Set<string>();

  constructor(store: Store) {
    this.store = store;
  }

  open(input: OpenInput): Session {
    const topic = String(input.topic ?? "").trim();
    if (!topic) throw new Error("会话议题不能为空");
    const ps = Array.isArray(input.participants) ? input.participants : [];
    if (ps.length !== 2) throw new Error("会话必须恰好有两个参与方");
    const first = String(ps[0] ?? "").trim();
    const second = String(ps[1] ?? "").trim();
    if (!first || !second) throw new Error("参与方名字不能为空");
    // 自己和自己讨论没有意义，还会让「谁在回应谁」失去意义
    if (first === second) throw new Error("两个参与方不能是同一个智能体");
    // 开场白写库之前先校验：say 抛错时会话已经落库的话，会留下一个没有开场白的空会话
    if (!String(input.opening ?? "").trim()) throw new Error("开场白不能为空");

    const ts = new Date().toISOString();
    const s: Session = {
      id: this.newId(),
      topic,
      participants: [first, second],
      turn: 1, // 开场白就算第 1 轮，下面写入时不再推进
      maxTurns: this.turns(input.maxTurns),
      deadline: new Date(Date.now() + this.minutes(input.deadlineMinutes) * 60_000).toISOString(),
      tokenBudget: this.budget(input.tokenBudget),
      tokensUsed: 0,
      status: "open",
      conclusion: null,
      endReason: null,
      projectId: input.projectId ?? null,
      issueId: input.issueId ?? null,
      createdAt: ts,
      updatedAt: ts,
    };
    this.store.docPut("sessions", s.id, s);
    return this.say(s.id, first, input.opening, { countTurn: false });
  }

  get(id: string): Session | undefined {
    return this.store.docGet<Session>("sessions", id);
  }

  list(filter: { status?: Session["status"]; projectId?: string; issueId?: number } = {}): Session[] {
    return this.store
      .docList<Session>("sessions")
      .filter(
        (s) =>
          (!filter.status || s.status === filter.status) &&
          (filter.projectId === undefined || s.projectId === filter.projectId) &&
          (filter.issueId === undefined || s.issueId === filter.issueId),
      )
      // 最近开的排前面：名单是给人看的，新会话才有跟进价值
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  messages(id: string): SessionMessage[] {
    // 会话不存在时返回空列表而不是抛错：查看类接口不该因为 id 过期就让调用方中断
    return this.store
      .docList<SessionMessage>("session_msgs")
      .filter((m) => m.sessionId === id)
      .sort((a, b) => a.id - b.id);
  }

  /** 记录一条发言。silent=true 时只存消息不推进 turn（用于开场白） */
  say(id: string, from: string, text: string, opts: { countTurn?: boolean } = {}): Session {
    const s = this.must(id);
    if (s.status !== "open") throw new Error(`会话 ${s.id} 已结束（${this.statusLabel(s)}），不能再发言`);
    const who = String(from ?? "").trim();
    const body = String(text ?? "").trim();
    if (!who) throw new Error("发言人不能为空");
    if (!body) throw new Error("发言内容不能为空");

    const countTurn = opts.countTurn !== false;
    // 计入轮次时，这条消息属于新的一轮（开场白占第 1 轮，第一条回应就是第 2 轮）
    const turn = countTurn ? s.turn + 1 : s.turn;
    const at = new Date().toISOString();
    const msg: SessionMessage = { id: this.store.nextSeq("session_msg"), sessionId: s.id, turn, from: who, text: body, at };
    this.store.docPut("session_msgs", msg.id, msg);

    if (countTurn) s.turn = turn;
    s.updatedAt = at;
    this.store.docPut("sessions", s.id, s);
    return s;
  }

  /** 记录发言并推进轮次；返回更新后的会话 */
  advance(id: string, from: string, text: string): Session {
    const gate = this.canContinue(id);
    // 校验放在写消息之前：触顶的会话不能留下一条「本来不该说出口」的发言
    if (!gate.ok) throw new Error(this.refusal(id, gate.reason));
    return this.say(id, from, text);
  }

  /** 结束会话。没给结论时自动写一条总结占位，保证 conclusions 非空 */
  close(id: string, conclusion: string | null, reason: Session["endReason"]): Session {
    const s = this.must(id);
    // 幂等：重复结束以第一次为准，否则后来的调用会把已记录的终止原因覆盖掉
    if (s.status !== "open") return s;

    // null 归到 human：会话表里「已结束但没有原因」是不可解释的状态
    const why = reason ?? "human";
    s.status = why === "conclusion" ? "closed" : "aborted";
    s.endReason = why;
    const body = String(conclusion ?? "").trim();
    s.conclusion = body || this.placeholder(s, why);
    s.updatedAt = new Date().toISOString();
    this.store.docPut("sessions", s.id, s);
    return s;
  }

  /** 是否还能继续：轮次/时间/预算任一触顶即拒绝，并给出原因 */
  canContinue(id: string): { ok: true } | { ok: false; reason: Exclude<Session["endReason"], "conclusion" | null> } {
    const s = this.must(id);
    if (s.status !== "open") {
      const r = s.endReason;
      // 已结束的会话按「当初是什么拦住它的」返回；conclusion / null 在可继续的语义里不存在，折算成 human
      return { ok: false, reason: r === "max_turns" || r === "deadline" || r === "budget" || r === "human" ? r : "human" };
    }
    if (s.turn >= s.maxTurns) return { ok: false, reason: "max_turns" };
    // 截止时间一到就不再给模型排队：拖过时限的讨论，结论价值还不如及时收口
    if (Date.now() >= Date.parse(s.deadline)) return { ok: false, reason: "deadline" };
    if (s.tokensUsed >= s.tokenBudget) return { ok: false, reason: "budget" };
    return { ok: true };
  }

  addUsage(id: string, tokens: number): void {
    const s = this.must(id);
    // 负数或非数字当作 0：用量回填出错不该把预算倒着算回去
    const n = Number.isFinite(tokens) ? Math.max(0, Math.floor(tokens)) : 0;
    if (!n) return;
    // 会话结束后仍然记账：token 是真花掉的，成本不该因为晚到就消失
    s.tokensUsed += n;
    s.updatedAt = new Date().toISOString();
    this.store.docPut("sessions", s.id, s);
  }

  /** 串行锁：同一会话同一时刻只允许一个任务在跑 */
  lock(id: string): boolean {
    if (this.locks.has(id)) return false;
    this.locks.add(id);
    return true;
  }
  unlock(id: string): void {
    this.locks.delete(id);
  }
  isLocked(id: string): boolean {
    return this.locks.has(id);
  }

  // ======================= 内部 =======================

  private must(id: string): Session {
    const s = this.store.docGet<Session>("sessions", id);
    if (!s) throw new Error(`会话 ${id} 不存在`);
    return s;
  }

  private newId(): string {
    // 撞车概率极低，但仍然检查一次：id 一旦重复，docPut 会直接覆盖别人的会话
    for (let i = 0; i < 20; i++) {
      const id = "s_" + Math.random().toString(36).slice(2, 8).padEnd(6, "0");
      if (!this.store.docGet("sessions", id)) return id;
    }
    throw new Error("生成会话编号失败，请重试");
  }

  private turns(n?: number): number {
    const v = Number(n);
    if (!Number.isFinite(v)) return DEFAULT_MAX_TURNS;
    return Math.min(HARD_MAX_TURNS, Math.max(1, Math.floor(v)));
  }

  private minutes(n?: number): number {
    const v = Number(n);
    return Number.isFinite(v) && v > 0 ? v : DEFAULT_DEADLINE_MINUTES;
  }

  private budget(n?: number): number {
    const v = Number(n);
    return Number.isFinite(v) && v > 0 ? Math.floor(v) : DEFAULT_TOKEN_BUDGET;
  }

  private statusLabel(s: Session): string {
    return s.status === "closed" ? "已收敛" : "已中止";
  }

  /** 触顶时给智能体看的中文原因：工具层会把它原样返回，所以要写清「该怎么收场」 */
  private refusal(id: string, reason: Exclude<Session["endReason"], "conclusion" | null>): string {
    const s = this.must(id);
    switch (reason) {
      case "max_turns":
        return `会话 ${id} 已用完 ${s.maxTurns} 轮，不能继续发言，请先给出结论并结束会话`;
      case "deadline":
        return `会话 ${id} 已超过截止时间 ${s.deadline}，不能继续发言，请先给出结论并结束会话`;
      case "budget":
        return `会话 ${id} 已用完 token 预算（${s.tokensUsed}/${s.tokenBudget}），不能继续发言，请先给出结论并结束会话`;
      default:
        return `会话 ${id} ${this.statusLabel(s)}，不能再发言`;
    }
  }

  /**
   * 兜底结论。触顶不是失败，但也不能只剩一句「已中止」——
   * 至少要说清是哪一重上限收的口、讨论到几轮、还差什么该去哪里接着聊。
   */
  private placeholder(s: Session, why: string): string {
    const label = END_LABEL[why] ?? "会话已结束";
    return (
      `未达成明确结论（${label}）。已讨论 ${s.turn} 轮，累计 ${s.tokensUsed}/${s.tokenBudget} tokens。` +
      "讨论到哪一步以上面的消息记录为准；还没解决的问题建议另开会话，或转成具体工作项继续。"
    );
  }
}
