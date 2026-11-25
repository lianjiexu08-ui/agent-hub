/**
 * 管家（首页对话）与智能体构建器。
 * - 管家：读取全部项目与工作项，讨论需求、拆分任务、调整计划。只「提议」，由人确认后执行。
 * - 构建器：通过对话起草 / 调整智能体配置与技能。
 * 演示模式或没有可用模型时返回 { fallback: true }，由前端使用本地规则回复。
 */
import type { BetaMessageParam, BetaToolUnion } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type { Store } from "./db.ts";
import type { LLM, Runtime } from "./runtime.ts";
import type { Settings } from "./settings.ts";
import type { HubEvent } from "./types.ts";
import type { Work } from "./work.ts";
import type { Attachment, Uploads } from "./uploads.ts";
import { PHASE_LABEL } from "./work.ts";

export interface ButlerMsg { role: "me" | "ai"; text: string; /** 模型的思考摘要，供界面折叠展示；没有思考时为空 */ thinking?: string; card?: Record<string, any>; attachments?: Attachment[]; at?: string }
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
  append(m: ButlerMsg) { this.saveConv([...this.conversation(), { ...m, at: new Date().toISOString() }]); }
  post(text: string) { this.append({ role: "ai", text }); }
  updateCard(index: number, patch: Record<string, unknown>) {
    const msgs = this.conversation();
    if (msgs[index]?.card) { msgs[index].card = { ...msgs[index].card, ...patch }; this.saveConv(msgs); }
  }
  clear() { this.saveConv([]); }

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

  async butler(text: string, attachmentIds: string[] = []): Promise<{ fallback?: boolean }> {
    if (!this.canUseModel()) return { fallback: true };
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

    const agents = this.store.listAgents().map((a) => `${a.name}（${a.description}）`).join("、");
    const tools: BetaToolUnion[] = [
      { name: "list_projects", description: "列出全部项目及概况", input_schema: { type: "object", properties: {}, additionalProperties: false } },
      { name: "list_issues", description: "列出工作项。可按项目前缀、状态、Linear 创建人过滤；返回里带 Linear 侧的创建人与指派人", input_schema: { type: "object", properties: { project: { type: "string" }, status: { type: "string", description: "backlog / todo / in_progress / in_review / done / canceled" }, creator: { type: "string", description: "Linear 创建人，按包含匹配，如 lianjiexu" } }, additionalProperties: false } },
      { name: "get_issue", description: "查看工作项详情", input_schema: { type: "object", properties: { issue: { type: "string" } }, required: ["issue"], additionalProperties: false } },
      { name: "propose_plan", description: "提出拆分计划，用户确认后创建为工作项", input_schema: { type: "object", properties: { project: { type: "string", description: "项目前缀" }, items: { type: "array", items: { type: "object", properties: { title: { type: "string" }, description: { type: "string" }, assignee: { type: "string" }, priority: { type: "integer" }, labels: { type: "array", items: { type: "string" } } }, required: ["title", "description"] } } }, required: ["project", "items"], additionalProperties: false } },
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
    const cards: Record<string, any>[] = [];
    let reply = "";
    // 思考过程跨工具轮累计：多轮里每一轮的推理都是同一件事的推进，合并后一次展示
    const thoughts: string[] = [];
    try {
      for (let turn = 0; turn < 6; turn++) {
        const res = await this.llm().create({
          model: this.settings.assistantModelId(), max_tokens: 6000, system: `${BUTLER_SYSTEM}\n\n可用智能体：${agents}`, messages, tools,
          // 让模型自行决定想多久；summary 模式才会把思考内容回传，否则只有签名
          thinking: { type: "adaptive", display: "summarized" },
          output_config: { effort: "medium" },
        }, { signal: AbortSignal.timeout(120_000) });
        messages.push({ role: "assistant", content: res.content });
        for (const b of res.content) if (b.type === "thinking" && (b as { thinking?: string }).thinking) thoughts.push((b as { thinking: string }).thinking);
        reply = res.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("\n").trim() || reply;
        const calls = res.content.filter((b) => b.type === "tool_use") as { id: string; name: string; input: any }[];
        if (res.stop_reason !== "tool_use" || !calls.length) break;
        const results = await Promise.all(calls.map(async (c) => ({ type: "tool_result" as const, tool_use_id: c.id, content: await this.butlerTool(c.name, c.input, cards) })));
        messages.push({ role: "user", content: results });
      }
    } catch (e) {
      const msg = (e as Error).message;
      if (/auth|api.?key|credential|401/i.test(msg)) { const conv = this.conversation(); conv.pop(); this.saveConv(conv); return { fallback: true }; }
      reply = `抱歉，出错了：${msg}`;
    }
    const thinking = thoughts.join("\n\n").trim() || undefined;
    if (!cards.length) this.append({ role: "ai", text: reply || "好的。", thinking });
    cards.forEach((card, n) => this.append({ role: "ai", text: n === 0 ? reply || "请确认：" : "还有一项：", card, thinking: n === 0 ? thinking : undefined }));
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
    if (!this.canUseModel()) return fallback();
    try {
      const res = await this.llm().create({
        model: this.settings.assistantModelId(),
        max_tokens: 600,
        system: "你是产品经理。根据用户对项目的描述，给出项目名、编号前缀、一句话说明。" +
          '只输出 JSON，不要解释：{"name":"","key":"","description":""}。name 不超过 12 个汉字；key 是 2-5 位大写字母；description 不超过 40 字。',
        messages: [{ role: "user", content: text }],
      }, { signal: AbortSignal.timeout(30_000) });
      const raw = res.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("");
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

  private async butlerTool(name: string, input: any, cards: Record<string, any>[]): Promise<string> {
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
        cards.push({ type: "plan", projectId: p?.id, items: (input.items ?? []).map((x: any) => ({ title: x.title, description: x.description ?? "", assignee: x.assignee ?? "", priority: x.priority ?? 3, labels: x.labels ?? [], on: true })), startNow: false, created: false });
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
    if (!this.canUseModel()) return { fallback: true };
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
    try {
      for (let turn = 0; turn < 4; turn++) {
        const res = await this.llm().create({ model: this.settings.modelId(this.settings.get().defaultModel), max_tokens: 6000, system, messages, tools, output_config: { effort: "medium" } }, { signal: AbortSignal.timeout(120_000) });
        messages.push({ role: "assistant", content: res.content });
        reply = res.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("\n").trim() || reply;
        const calls = res.content.filter((b) => b.type === "tool_use") as { id: string; input: any }[];
        if (res.stop_reason !== "tool_use" || !calls.length) break;
        for (const c of calls) {
          const { new_skills, ...patch } = c.input ?? {};
          for (const [k, v] of Object.entries(patch)) { draft[k] = v; changed.add(["skills"].includes(k) ? "skills" : ["model", "effort", "runtime", "cliModel"].includes(k) ? "model" : ["serverTools", "delegation"].includes(k) ? "tools" : k); }
          for (const s of new_skills ?? []) { newSkills.push({ ...s, createdBy: "AI 助手" }); draft.skills = [...new Set([...(draft.skills ?? []), s.id])]; changed.add("skills"); }
        }
        messages.push({ role: "user", content: calls.map((c) => ({ type: "tool_result" as const, tool_use_id: c.id, content: "已更新草稿" })) });
      }
    } catch (e) {
      const msg = (e as Error).message;
      if (/auth|api.?key|credential|401/i.test(msg)) return { fallback: true };
      reply = `抱歉，出错了：${msg}`;
    }
    return { reply: reply || "已更新草稿。", draft, newSkills, changed: [...changed] };
  }
}
