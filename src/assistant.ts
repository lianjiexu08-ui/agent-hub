/**
 * 管家（首页对话）与智能体构建器。
 * - 管家：读取全部项目与工作项，讨论需求、拆分任务、调整计划。只「提议」，由人确认后执行。
 * - 构建器：通过对话起草 / 调整智能体配置与技能。
 * 通道：有可用的模型 API 连接就用 API；没有就用本机已登录的 Claude Code（见 assistant-cli.ts）；
 * 两者都没有（或演示模式）时返回 { fallback: true, reason }，由前端使用本地规则回复并提示原因。
 */
import type { BetaMessageParam, BetaToolUnion } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type { Store } from "./db.ts";
import type { LLM, Runtime } from "./runtime.ts";
import type { Settings } from "./settings.ts";
import type { HubEvent } from "./types.ts";
import type { Work } from "./work.ts";
import type { Attachment, Uploads } from "./uploads.ts";
import { PHASE_LABEL } from "./work.ts";
import { transcriptPrompt, type CliChat, type LiveSession, type VirtualTool } from "./assistant-cli.ts";

/** 长驻会话最多跑多少轮就换新进程：上下文有界，也让新的智能体列表、技能等及时生效 */
const LIVE_MAX_TURNS = 40;
/** 卡片在对话里的状态（给长驻会话同步「对话外」的变化：用户在卡片上点了创建 / 执行） */
const cardState = (c?: Record<string, any>) => (!c ? "" : c.created ? "已创建" : c.done ? "已执行" : c.dismissed ? "已忽略" : "待确认");

/** 鉴权类错误：API 连接不可用，应换通道而不是把错误抛给用户 */
const isAuthError = (msg: string) => /auth|api.?key|credential|401|还没有配置 API Key/i.test(msg);
export type Engine = { kind: "api" } | { kind: "cli" } | { kind: "none"; reason: string };

export interface ButlerMsg { role: "me" | "ai"; text: string; /** 这条回复走的通道，界面上标注，避免把规则回复当成 AI */ via?: "api" | "claude-code" | "rules"; /** 模型的思考摘要，供界面折叠展示；没有思考时为空 */ thinking?: string; card?: Record<string, any>; attachments?: Attachment[]; at?: string }
const STATUS: Record<string, string> = { backlog: "待规划", todo: "待办", in_progress: "进行中", in_review: "待审核", done: "完成", canceled: "已取消" };

const BUTLER_SYSTEM = `你是 Agent Hub 的管家，帮用户管理多个项目的工作。用户只参与「需求的制定与确认」和「最终成果验收」，其余由智能体完成。
你的职责：
1. 讨论需求：复述理解，指出不清楚的地方并提问（验收标准、边界与异常、范围、可测的数值）。
2. 拆分任务：需求清楚后，用 propose_plan 提出拆分计划（放到合适的项目，每项写清描述与验收标准、指定合适的智能体）。不要直接创建，用户会在卡片上确认。
3. 调整任务：用 propose_action 提出调整（改优先级、指派、暂停、取消、运行、开关项目负责人的持续迭代、创建 Hotfix），由用户确认执行。
4. 汇总进展：先用 list_projects / list_issues 查数据再回答，不要编造。
回答简洁，用中文。`;

export class Assistant {
  /** 附件存储（由 index.ts 注入）；没有时退化为纯文本 */
  uploads: Uploads | null = null;
  /** 本机 Claude Code 通道（由 index.ts 注入）；没有 API 连接时用它 */
  cli: CliChat | null = null;
  /**
   * 管家的长驻 Claude Code 会话。Hub 数据库里的对话记录是唯一的真相：
   * lastAt 记下会话「看到」的最后一条消息；之后数据库里多出的消息、卡片状态变化在下一轮补给它；
   * 对不上（清空了对话、记录被截断）就关掉重开，用数据库里的记录重新铺底。
   */
  private live: { s: LiveSession; system: string; lastAt: string | null; cards: Map<string, string> } | null = null;
  /** 管家一次只处理一条消息：长驻会话的上下文同步依赖顺序 */
  private butlerLock: Promise<unknown> = Promise.resolve();
  /** 正在处理的这条消息的进度（工具调用、中途说的话），给界面实时显示；处理完清空 */
  progress: { since: string; steps: string[] } | null = null;
  private step(text: string) {
    if (!this.progress) return;
    this.progress.steps.push(text.length > 160 ? text.slice(0, 160) + "…" : text);
    this.progress.steps.splice(0, Math.max(0, this.progress.steps.length - 30));
    this.emit();
  }
  private store: Store;
  private runtime: Runtime;
  private work: Work;
  private settings: Settings;
  private llm: () => LLM;
  private simulate: boolean;
  constructor(store: Store, runtime: Runtime, work: Work, settings: Settings, llm: () => LLM, simulate: boolean) {
    this.store = store;
    this.runtime = runtime;
    this.work = work;
    this.settings = settings;
    this.llm = llm;
    this.simulate = simulate;
  }
  private emit() { this.runtime.events.emit("event", { type: "work", kind: "butler" } as unknown as HubEvent); }
  conversation(): ButlerMsg[] { return this.store.docGet<{ msgs: ButlerMsg[] }>("butler", "conv")?.msgs ?? []; }
  private saveConv(msgs: ButlerMsg[]) { this.store.docPut("butler", "conv", { id: "conv", msgs: msgs.slice(-80) }); this.emit(); }
  /** 追加消息。at 严格递增（同一毫秒内的多条顺延 1ms）：长驻会话靠它定位「看到哪一条」，不能重复 */
  append(m: ButlerMsg) {
    const conv = this.conversation();
    const last = conv.at(-1)?.at ? Date.parse(conv.at(-1)!.at!) : 0;
    const at = new Date(Math.max(Date.now(), last + 1)).toISOString();
    this.saveConv([...conv, { ...m, at }]);
  }
  post(text: string) { this.append({ role: "ai", text }); }
  updateCard(index: number, patch: Record<string, unknown>) {
    const msgs = this.conversation();
    if (msgs[index]?.card) { msgs[index].card = { ...msgs[index].card, ...patch }; this.saveConv(msgs); }
  }
  clear() { this.saveConv([]); this.closeLive(); }
  closeLive() { this.live?.s.close(); this.live = null; }
  /** 预热：打开首页时先把 Claude Code 进程起好，第一条消息不用等启动。不发消息，不消耗额度 */
  async warm(): Promise<boolean> {
    if ((await this.engine()).kind !== "cli") return false;
    await this.liveFor(this.butlerSystem(), this.butlerTools().map(toVirtual));
    return true;
  }
  private async liveFor(system: string, tools: VirtualTool[]) {
    const L = this.live;
    if (L && L.s.alive && L.system === system && L.s.turns < LIVE_MAX_TURNS) return L;
    L?.s.close();
    const s = await this.cli!.live({ system, tools, onExit: () => { if (this.live?.s === s) this.live = null; } });
    this.live = { s, system, lastAt: null, cards: new Map() };
    return this.live;
  }

  /** 不依赖模型的进展汇总（晨报、演示模式都用它） */
  summary(): string {
    const all = this.work.list();
    const lines = this.work.projects().map((p) => {
      const run = all.filter((i) => i.projectId === p.id && i.status === "in_progress");
      return `【${p.name}】进行中 ${run.length}${run.length ? `（${run.map((i) => `${i.key} ${PHASE_LABEL[i.phase ?? ""] ?? ""}`).join("、")}）` : ""}，待验收 ${p.counts.review}，负责人：${{ off: "关闭", on_demand: "按需", autopilot: "持续迭代" }[p.lead.mode]}`;
    });
    const att = this.work.attention();
    return `${lines.join("\n")}\n\n${att.length ? `需要你处理 ${att.length} 件：\n${att.slice(0, 6).map((a) => `· ${a.issue.key} ${a.issue.title}：${a.text}`).join("\n")}` : "目前没有需要你处理的事项。"}`;
  }
  postReport() { this.post(`☀️ 晨报\n${this.summary()}`); }

  private canUseModel() { return !this.simulate; }

  /** 管家模型所在的连接是否可用：验证过，且有 Key（或 Anthropic 用本机凭据 / 环境变量） */
  private apiReady(modelEntryId: string): boolean {
    const s = this.settings.get();
    const entry = this.settings.modelEntry(modelEntryId);
    const p = s.providers.find((x) => x.id === entry?.providerId) ?? s.providers.find((x) => x.type === "anthropic" && x.verifiedAt) ?? s.providers[0];
    if (p?.verifiedAt && (p.method === "key" ? !!this.settings.providerKey(p.id) : p.method === "profile")) return true;
    return (!p || p.type === "anthropic") && !!process.env.ANTHROPIC_API_KEY;
  }
  /** 选通道：API → 本机 Claude Code → 规则回复 */
  async engine(modelEntryId = this.settings.assistantModelId()): Promise<Engine> {
    if (this.simulate) return { kind: "none", reason: "演示模式" };
    if (this.apiReady(modelEntryId)) return { kind: "api" };
    if (this.cli && await this.cli.available()) return { kind: "cli" };
    return { kind: "none", reason: "没有可用的模型连接，本机也没有安装 Claude Code" };
  }
  private async cliOr(reason: string): Promise<Engine> {
    return this.cli && await this.cli.available() ? { kind: "cli" } : { kind: "none", reason };
  }

  butler(text: string, attachmentIds: string[] = []): Promise<{ fallback?: boolean; reason?: string }> {
    const next = this.butlerLock.then(async () => {
      this.progress = { since: new Date().toISOString(), steps: [] };
      try { return await this.butlerOnce(text, attachmentIds); }
      finally { this.progress = null; this.emit(); }
    });
    this.butlerLock = next.catch(() => {});
    return next;
  }
  private butlerSystem() {
    const agents = this.store.listAgents().map((a) => `${a.name}（${a.description}）`).join("、");
    return `${BUTLER_SYSTEM}\n\n可用智能体：${agents}`;
  }
  private async butlerOnce(text: string, attachmentIds: string[]): Promise<{ fallback?: boolean; reason?: string }> {
    let eng = await this.engine();
    if (eng.kind === "none") return { fallback: true, reason: eng.reason };
    const history = this.conversation().slice(-20);
    const ids = (attachmentIds ?? []).filter((x) => typeof x === "string").slice(0, 10);
    const atts = ids.map((id) => this.uploads?.get(id)).filter((x): x is Attachment => !!x);
    const desc = this.uploads?.describe(ids) ?? { blocks: [], text: "" };
    const messages: BetaMessageParam[] = [];
    for (const m of history) {
      const role = m.role === "me" ? "user" : "assistant";
      const content = m.text + (m.attachments?.length ? `\n[附件：${m.attachments.map((a) => a.name).join("、")}]` : "") + (m.card ? `\n[已给出${m.card.type === "plan" ? "拆分计划" : "操作"}卡片：${m.card.created ? "已创建" : m.card.done ? "已执行" : "待确认"}]` : "");
      if (messages.at(-1)?.role === role) (messages.at(-1)!.content as string) += `\n\n${content}`;
      else messages.push({ role, content });
    }
    if (messages[0]?.role === "assistant") messages.shift();
    // 当前这一轮：图片作为视觉块、文本文件内联、其它只列名称
    const blocks: Record<string, unknown>[] = desc.blocks.map((b) => ({ type: "image", source: { type: "base64", media_type: b.media_type, data: b.data } }));
    const body = [desc.text ? `附件：\n${desc.text}` : "", text].filter(Boolean).join("\n\n");
    if (blocks.length) {
      blocks.push({ type: "text", text: body });
      if (messages.at(-1)?.role === "user") messages.push({ role: "user", content: blocks as never });
      else messages.push({ role: "user", content: blocks as never });
    } else if (messages.at(-1)?.role === "user") (messages.at(-1)!.content as string) += `\n\n${body}`;
    else messages.push({ role: "user", content: body });
    this.append({ role: "me", text, attachments: atts.length ? atts : undefined });

    const tools = this.butlerTools();
    const cards: Record<string, any>[] = [];
    let reply = "";
    // 思考过程跨工具轮累计：多轮里每一轮的推理都是同一件事的推进，合并后一次展示
    const thoughts: string[] = [];
    const system = this.butlerSystem();
    if (eng.kind === "api") try {
      for (let turn = 0; turn < 6; turn++) {
        const res = await this.llm().create({
          model: this.settings.assistantModelId(), max_tokens: 6000, system, messages, tools,
          // 让模型自行决定想多久；summary 模式才会把思考内容回传，否则只有签名
          thinking: { type: "adaptive", display: "summarized" },
          output_config: { effort: "medium" },
        }, { signal: AbortSignal.timeout(120_000) });
        messages.push({ role: "assistant", content: res.content });
        for (const b of res.content) if (b.type === "thinking" && (b as { thinking?: string }).thinking) thoughts.push((b as { thinking: string }).thinking);
        reply = res.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("\n").trim() || reply;
        const calls = res.content.filter((b) => b.type === "tool_use") as { id: string; name: string; input: any }[];
        if (res.stop_reason !== "tool_use" || !calls.length) break;
        const said = res.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("\n").trim();
        if (said) this.step(`💬 ${said}`);
        const results = await Promise.all(calls.map(async (c) => ({ type: "tool_result" as const, tool_use_id: c.id, content: await this.butlerTool(c.name, c.input, cards) })));
        messages.push({ role: "user", content: results });
      }
    } catch (e) {
      const msg = (e as Error).message;
      if (isAuthError(msg)) {
        // API 连接其实不可用（Key 失效等）：换到本机 Claude Code；也没有就退回规则回复并说明原因
        eng = await this.cliOr(`模型连接不可用（${msg.slice(0, 120)}），本机也没有安装 Claude Code`);
        if (eng.kind === "none") { const conv = this.conversation(); conv.pop(); this.saveConv(conv); return { fallback: true, reason: eng.reason }; }
      } else reply = `抱歉，出错了：${msg}`;
    }
    if (eng.kind === "cli") {
      // 当前这一轮的附件：文本内联；图片 CLI 通道看不到内容，只说明有图
      const imgs = atts.filter((a) => a.kind === "image").map((a) => a.name);
      const cur = [desc.text ? `附件：\n${desc.text}` : "", imgs.length ? `（用户还发了图片：${imgs.join("、")}。当前通道看不到图片内容，需要的话请用户用文字描述）` : "", text].filter(Boolean).join("\n\n");
      const cardName = (c: Record<string, any>) => c.type === "plan" ? `拆分计划（${(c.items ?? []).map((x: any) => x.title).slice(0, 3).join("、")}）` : `操作「${c.label ?? c.op}」`;
      const withCard = (m: ButlerMsg) => m.text + (m.card ? `\n[已给出${cardName(m.card)}卡片：${cardState(m.card)}]` : "");
      try {
        let L = await this.liveFor(system, tools.map(toVirtual));
        const before = this.conversation().slice(0, -1); // 去掉刚写入的这条
        let idx = L.lastAt ? before.findLastIndex((m) => m.at === L.lastAt) : -1;
        // 会话看到的最后一条已经不在记录里（清空 / 截断）：重开，用数据库里的记录铺底
        if (L.lastAt && idx < 0) { this.closeLive(); L = await this.liveFor(system, tools.map(toVirtual)); idx = -1; }
        let prompt: string;
        if (!L.lastAt) prompt = transcriptPrompt(before.slice(-20).map((m) => ({ role: m.role, text: withCard(m) })), cur);
        else {
          // 会话之外发生的事：规则回复、晨报等新消息，以及用户在卡片上的确认
          const extra = before.slice(idx + 1).map((m) => `【${m.role === "me" ? "用户" : "管家"}】${withCard(m)}`);
          const changed = before.filter((m) => m.card && m.at && L.cards.has(m.at) && L.cards.get(m.at) !== cardState(m.card)).map((m) => `- ${cardName(m.card!)}：${cardState(m.card)}`);
          prompt = [extra.length ? `（这期间对话里新增了以下内容）\n${extra.join("\n\n")}` : "", changed.length ? `（卡片状态更新）\n${changed.join("\n")}` : "", cur].filter(Boolean).join("\n\n---\n\n");
        }
        reply = await L.s.send(prompt, (name, input) => this.butlerTool(name, input, cards), undefined, (said) => this.step(`💬 ${said}`));
      } catch (e) {
        reply = `抱歉，通过 Claude Code 回复失败：${(e as Error).message}`;
        this.closeLive(); // 会话状态不确定，下次重开
      }
    }
    const via = eng.kind === "cli" ? "claude-code" as const : "api" as const;
    const thinking = thoughts.join("\n\n").trim() || undefined;
    if (!cards.length) this.append({ role: "ai", text: reply || "好的。", thinking, via });
    cards.forEach((card, n) => this.append({ role: "ai", text: n === 0 ? reply || "请确认：" : "还有一项：", card, thinking: n === 0 ? thinking : undefined, via }));
    if (eng.kind === "cli" && this.live) {
      const conv = this.conversation();
      this.live.lastAt = conv.at(-1)?.at ?? null;
      this.live.cards = new Map(conv.filter((m) => m.card && m.at).map((m) => [m.at!, cardState(m.card)]));
    }
    return {};
  }
  /** 根据一段项目描述起草项目名、编号前缀和一句话说明；模型不可用时退化为截取 */
  async draftProject(brief: string): Promise<{ name: string; key: string; description: string }> {
    const text = String(brief ?? "").trim();
    if (!text) throw new Error("先说说这个项目要做什么");
    const flat = text.replace(/\s+/g, " ").trim();
    const fallback = () => {
      const name = flat.slice(0, 12) || "新项目";
      const ascii = (flat.match(/[A-Za-z]+/g) ?? []).join("").slice(0, 4).toUpperCase();
      return { name, key: ascii || "PRJ", description: flat.slice(0, 80) };
    };
    const eng = await this.engine();
    if (eng.kind === "none") return fallback();
    const system = "你是产品经理。根据用户对项目的描述，给出项目名、编号前缀、一句话说明。" +
      '只输出 JSON，不要解释：{"name":"","key":"","description":""}。name 不超过 12 个汉字；key 是 2-5 位大写字母；description 不超过 40 字。';
    const viaCli = async () => (await this.cli!.run({ system, prompt: text, timeoutMs: 90_000 })).text;
    try {
      let raw: string;
      if (eng.kind === "cli") raw = await viaCli();
      else try {
        const res = await this.llm().create({ model: this.settings.assistantModelId(), max_tokens: 600, system, messages: [{ role: "user", content: text }] }, { signal: AbortSignal.timeout(30_000) });
        raw = res.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("");
      } catch (e) {
        if (!isAuthError((e as Error).message) || (await this.cliOr("")).kind !== "cli") throw e;
        raw = await viaCli();
      }
      const hit = raw.match(/\{[\s\S]*\}/);
      const o = hit ? JSON.parse(hit[0]) as Record<string, unknown> : null;
      if (!o?.name) return fallback();
      const key = String(o.key ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 5);
      return {
        name: String(o.name).trim().slice(0, 20) || fallback().name,
        key: key || fallback().key,
        description: String(o.description ?? "").trim().slice(0, 120),
      };
    } catch { return fallback(); }
  }

  private butlerTools(): BetaToolUnion[] {
    return [
      { name: "list_projects", description: "列出全部项目及概况", input_schema: { type: "object", properties: {}, additionalProperties: false } },
      { name: "list_issues", description: "列出工作项。可按项目前缀、状态、Linear 创建人过滤；返回里带 Linear 侧的创建人与指派人", input_schema: { type: "object", properties: { project: { type: "string" }, status: { type: "string", description: "backlog / todo / in_progress / in_review / done / canceled" }, creator: { type: "string", description: "Linear 创建人，按包含匹配，如 lianjiexu" } }, additionalProperties: false } },
      { name: "get_issue", description: "查看工作项详情", input_schema: { type: "object", properties: { issue: { type: "string" } }, required: ["issue"], additionalProperties: false } },
      { name: "propose_plan", description: "提出拆分计划，用户确认后创建为工作项", input_schema: { type: "object", properties: { project: { type: "string", description: "项目前缀" }, items: { type: "array", items: { type: "object", properties: { title: { type: "string" }, description: { type: "string" }, assignee: { type: "string" }, priority: { type: "integer" }, labels: { type: "array", items: { type: "string" } }, depends_on: { type: "array", items: { type: "integer" }, description: "依赖本计划里的第几项（从 1 开始，只能依赖排在前面的项）。依赖完成或 PR 合并后才会开始" } }, required: ["title", "description"] } } }, required: ["project", "items"], additionalProperties: false } },
      { name: "propose_action", description: "提出一个调整操作，用户确认后执行。op: update（args: key, patch）/ run（args: key）/ lead（args: project, mode: off|on_demand|autopilot）/ hotfix（args: project, title, description）", input_schema: { type: "object", properties: { label: { type: "string" }, op: { type: "string", enum: ["update", "run", "lead", "hotfix"] }, args: { type: "object" } }, required: ["label", "op", "args"], additionalProperties: false } },
      {
        name: "ask_agent",
        description: "直接和某个智能体对话：把问题或任务交给它，等它做完后把回复带回来。对方看不到我们的对话历史，问题要写完整自包含。" +
          "适合「问一下架构师这个方案怎么看」「让研究员查一下 X」这类即时协作；需要留痕、要进看板的工作请用 propose_plan。",
        input_schema: {
          type: "object",
          properties: {
            agent: { type: "string", description: "目标智能体名称" },
            question: { type: "string", description: "完整的问题或任务，含背景和期望的输出格式" },
          },
          required: ["agent", "question"],
          additionalProperties: false,
        },
      },
    ];
  }

  private async butlerTool(name: string, input: any, cards: Record<string, any>[]): Promise<string> {
    const label: Record<string, () => string> = {
      list_projects: () => "查看项目",
      list_issues: () => `查看工作项${input?.project ? `（${input.project}${input.status ? ` · ${STATUS[input.status] ?? input.status}` : ""}）` : ""}`,
      get_issue: () => `查看 ${input?.issue ?? "工作项"}`,
      propose_plan: () => `整理拆分计划（${(input?.items ?? []).length} 项）`,
      propose_action: () => `准备操作：${input?.label ?? input?.op ?? ""}`,
      ask_agent: () => `请 ${input?.agent ?? "智能体"} 帮忙（等它回复）`,
    };
    this.step(`🔧 ${label[name]?.() ?? name}`);
    try {
      if (name === "list_projects") return JSON.stringify(this.work.projects().map((p) => ({ key: p.key, name: p.name, repo: p.repo?.fullName ?? null, counts: p.counts, lead: p.lead.mode })), null, 1);
      if (name === "list_issues") {
        const pid = input.project ? this.work.projectsRaw().find((p) => p.key === String(input.project).toUpperCase())?.id : undefined;
        const want = String(input.creator ?? "").toLowerCase();
        const list = this.work.list(pid).filter((i) => {
          if (input.status && i.status !== input.status) return false;
          // 创建人按前缀匹配：Linear 返回的是邮箱，用户说的通常只是前半段
          if (!want) return true;
          return !!i.linear?.creator?.name?.toLowerCase().includes(want);
        });
        return list.map((i) => {
          const who = i.linear ? ` · Linear 创建人 ${i.linear.creator?.name ?? "未知"}，指派人 ${i.linear.assignee?.name ?? "未指派"}` : "";
          return `${i.key} [${STATUS[i.status]}${i.phase ? `·${PHASE_LABEL[i.phase]}` : ""}] ${i.assignee ?? "未指派"} — ${i.title}${who}`;
        }).join("\n") || "（无）";
      }
      if (name === "get_issue") {
        const d = this.work.detail(input.issue);
        const link = d.linear ? `\nLinear：${d.linear.identifier} · 创建人 ${d.linear.creator?.name ?? "未知"} · 指派人 ${d.linear.assignee?.name ?? "未指派"}` : "";
        return `${d.key} ${d.title}\n状态：${STATUS[d.status]}${link}\n描述：${d.description}\n最近动态：\n${d.activity.slice(-6).map((c) => `[${c.author}] ${c.body.slice(0, 300)}`).join("\n")}`;
      }
      if (name === "propose_plan") {
        const p = this.work.projectsRaw().find((x) => x.key === String(input.project).toUpperCase()) ?? this.work.projectsRaw()[0];
        // depends_on 是计划内序号（从 1 开始），只保留指向前面项的，创建时再换成工作项编号
        const items = (input.items ?? []).map((x: any, n: number) => ({ title: x.title, description: x.description ?? "", assignee: x.assignee ?? "", priority: x.priority ?? 3, labels: x.labels ?? [], on: true,
          dependsOn: [...new Set(((x.depends_on ?? []) as unknown[]).map(Number).filter((d) => Number.isInteger(d) && d >= 1 && d <= n))] }));
        cards.push({ type: "plan", projectId: p?.id, items, startNow: false, created: false });
        return "已展示给用户，等待确认。";
      }
      if (name === "ask_agent") {
        const target = String(input.agent ?? "").trim();
        const question = String(input.question ?? "").trim();
        if (!target || !question) return "需要提供智能体名称和问题";
        const a = this.store.getAgent(target);
        if (!a) return `智能体 ${target} 不存在。可用：${this.store.listAgents().map((x) => x.name).join("、")}`;
        const r = await this.runtime.callAgent(target, question, { timeoutMs: 180_000 });
        if (r.timedOut) return `已交给 ${target}，但它还在执行（任务 ${r.taskId.slice(0, 8)}），稍后可以在「调用记录」里看结果。`;
        if (r.status !== "completed") return `${target} 没能完成（${r.status}）：${r.error ?? "没有返回原因"}`;
        return `【${target} 的回复】\n${r.result ?? "（空）"}`;
      }
      if (name === "propose_action") {
        const a = input.args ?? {};
        const pid = a.project ? this.work.projectsRaw().find((x) => x.key === String(a.project).toUpperCase())?.id : undefined;
        cards.push({ type: "action", label: input.label, op: input.op, args: { ...a, projectId: pid ?? a.projectId } });
        return "已展示给用户，等待确认。";
      }
      return "未知工具";
    } catch (e) { return `出错：${(e as Error).message}`; }
  }

  /** 智能体构建器：返回新的草稿与新技能 */
  async builder(input: { mode: "create" | "edit"; draft: Record<string, any>; history: { role: "me" | "ai"; text: string }[]; text: string }): Promise<{ fallback?: boolean; reply?: string; draft?: Record<string, any>; newSkills?: any[]; changed?: string[] }> {
    let eng = await this.engine(this.settings.get().defaultModel);
    if (eng.kind === "none") return { fallback: true };
    const draft = { ...input.draft };
    const newSkills: any[] = [];
    const changed = new Set<string>();
    const skills = this.settings.skills().map((s) => `${s.id}（${s.name}：${s.description}）`).join("\n");
    const models = this.settings.get().models.filter((m) => m.enabled).map((m) => m.id).join("、");
    const system = `你在帮用户${input.mode === "edit" ? "调整" : "创建"}一个智能体。边聊边用 update_draft 修改右侧的草稿（只改需要改的字段），需要新技能时在 new_skills 里起草。
可选模型：${models}；运行底座：builtin、claude-code、codex、gemini、pi（编码任务推荐 claude-code）。
已有技能：\n${skills}
名称只能用字母、数字、- 和 _。回复简洁，说明改了什么，并在信息不足时提 1–2 个问题。`;
    const messages: BetaMessageParam[] = [];
    for (const m of input.history.slice(-12)) {
      const role = m.role === "me" ? "user" : "assistant";
      if (messages.at(-1)?.role === role) (messages.at(-1)!.content as string) += `\n\n${m.text}`;
      else messages.push({ role, content: m.text });
    }
    if (messages[0]?.role === "assistant") messages.shift();
    const userText = `当前草稿：${JSON.stringify(draft)}\n\n${input.text}`;
    if (messages.at(-1)?.role === "user") (messages.at(-1)!.content as string) += `\n\n${userText}`;
    else messages.push({ role: "user", content: userText });
    const tools: BetaToolUnion[] = [{ name: "update_draft", description: "修改智能体草稿", input_schema: { type: "object", properties: { name: { type: "string" }, description: { type: "string" }, model: { type: "string" }, effort: { type: "string", enum: ["low", "medium", "high", "xhigh", "max"] }, system: { type: "string" }, runtime: { type: "string" }, cliModel: { type: "string" }, skills: { type: "array", items: { type: "string" }, description: "完整的技能 id 列表" }, serverTools: { type: "array", items: { type: "string", enum: ["web_search", "web_fetch"] } }, delegation: { type: "string", enum: ["none", "any"] }, new_skills: { type: "array", items: { type: "object", properties: { id: { type: "string" }, name: { type: "string" }, description: { type: "string" }, instructions: { type: "string" } }, required: ["id", "name", "description", "instructions"] } } }, additionalProperties: false } }];
    let reply = "";
    const applyDraft = (inp: any) => {
      const { new_skills, ...patch } = inp ?? {};
      for (const [k, v] of Object.entries(patch)) { draft[k] = v; changed.add(["skills"].includes(k) ? "skills" : ["model", "effort", "runtime", "cliModel"].includes(k) ? "model" : ["serverTools", "delegation"].includes(k) ? "tools" : k); }
      for (const s of (new_skills as any[]) ?? []) { newSkills.push({ ...s, createdBy: "AI 助手" }); draft.skills = [...new Set([...(draft.skills ?? []), s.id])]; changed.add("skills"); }
    };
    if (eng.kind === "api") try {
      for (let turn = 0; turn < 4; turn++) {
        const res = await this.llm().create({ model: this.settings.modelId(this.settings.get().defaultModel), max_tokens: 6000, system, messages, tools, output_config: { effort: "medium" } }, { signal: AbortSignal.timeout(120_000) });
        messages.push({ role: "assistant", content: res.content });
        reply = res.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("\n").trim() || reply;
        const calls = res.content.filter((b) => b.type === "tool_use") as { id: string; input: any }[];
        if (res.stop_reason !== "tool_use" || !calls.length) break;
        for (const c of calls) applyDraft(c.input);
        messages.push({ role: "user", content: calls.map((c) => ({ type: "tool_result" as const, tool_use_id: c.id, content: "已更新草稿" })) });
      }
    } catch (e) {
      const msg = (e as Error).message;
      if (isAuthError(msg)) { eng = await this.cliOr(""); if (eng.kind === "none") return { fallback: true }; }
      else reply = `抱歉，出错了：${msg}`;
    }
    if (eng.kind === "cli") {
      try {
        const r = await this.cli!.run({
          system, tools: tools.map(toVirtual),
          prompt: transcriptPrompt(input.history.slice(-12), userText, { me: "用户", ai: "助手" }),
          // 草稿是逐次修改的：每次工具调用都基于上一次改完的结果
          invoke: async (_name, inp) => { applyDraft(inp); return `已更新草稿，当前草稿：${JSON.stringify(draft)}`; },
        });
        reply = r.text;
      } catch (e) { reply = `抱歉，通过 Claude Code 回复失败：${(e as Error).message}`; }
    }
    return { reply: reply || "已更新草稿。", draft, newSkills, changed: [...changed] };
  }
}

/** Anthropic 工具定义 → MCP 桥用的工具定义 */
function toVirtual(t: BetaToolUnion): VirtualTool {
  const x = t as { name: string; description?: string; input_schema?: Record<string, unknown> };
  return { name: x.name, description: x.description ?? "", input_schema: x.input_schema ?? { type: "object", properties: {} } };
}
