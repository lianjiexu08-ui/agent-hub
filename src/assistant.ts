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
import { PHASE_LABEL } from "./work.ts";

export interface ButlerMsg { role: "me" | "ai"; text: string; card?: Record<string, any>; at?: string }
const STATUS: Record<string, string> = { backlog: "待规划", todo: "待办", in_progress: "进行中", in_review: "待审核", done: "完成", canceled: "已取消" };

const BUTLER_SYSTEM = `你是 Agent Hub 的管家，帮用户管理多个项目的工作。用户只参与「需求的制定与确认」和「最终成果验收」，其余由智能体完成。
你的职责：
1. 讨论需求：复述理解，指出不清楚的地方并提问（验收标准、边界与异常、范围、可测的数值）。
2. 拆分任务：需求清楚后，用 propose_plan 提出拆分计划（放到合适的项目，每项写清描述与验收标准、指定合适的智能体）。不要直接创建，用户会在卡片上确认。
3. 调整任务：用 propose_action 提出调整（改优先级、指派、暂停、取消、运行、开关项目负责人的持续迭代、创建 Hotfix），由用户确认执行。
4. 汇总进展：先用 list_projects / list_issues 查数据再回答，不要编造。
回答简洁，用中文。`;

export class Assistant {
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

  async butler(text: string): Promise<{ fallback?: boolean }> {
    if (!this.canUseModel()) return { fallback: true };
    const history = this.conversation().slice(-20);
    const messages: BetaMessageParam[] = [];
    for (const m of history) {
      const role = m.role === "me" ? "user" : "assistant";
      const content = m.text + (m.card ? `\n[已给出${m.card.type === "plan" ? "拆分计划" : "操作"}卡片：${m.card.created ? "已创建" : m.card.done ? "已执行" : "待确认"}]` : "");
      if (messages.at(-1)?.role === role) (messages.at(-1)!.content as string) += `\n\n${content}`;
      else messages.push({ role, content });
    }
    if (messages[0]?.role === "assistant") messages.shift();
    if (messages.at(-1)?.role === "user") (messages.at(-1)!.content as string) += `\n\n${text}`;
    else messages.push({ role: "user", content: text });
    this.append({ role: "me", text });

    const agents = this.store.listAgents().map((a) => `${a.name}（${a.description}）`).join("、");
    const tools: BetaToolUnion[] = [
      { name: "list_projects", description: "列出全部项目及概况", input_schema: { type: "object", properties: {}, additionalProperties: false } },
      { name: "list_issues", description: "列出工作项，可按项目前缀过滤", input_schema: { type: "object", properties: { project: { type: "string" } }, additionalProperties: false } },
      { name: "get_issue", description: "查看工作项详情", input_schema: { type: "object", properties: { issue: { type: "string" } }, required: ["issue"], additionalProperties: false } },
      { name: "propose_plan", description: "提出拆分计划，用户确认后创建为工作项", input_schema: { type: "object", properties: { project: { type: "string", description: "项目前缀" }, items: { type: "array", items: { type: "object", properties: { title: { type: "string" }, description: { type: "string" }, assignee: { type: "string" }, priority: { type: "integer" }, labels: { type: "array", items: { type: "string" } } }, required: ["title", "description"] } } }, required: ["project", "items"], additionalProperties: false } },
      { name: "propose_action", description: "提出一个调整操作，用户确认后执行。op: update（args: key, patch）/ run（args: key）/ lead（args: project, mode: off|on_demand|autopilot）/ hotfix（args: project, title, description）", input_schema: { type: "object", properties: { label: { type: "string" }, op: { type: "string", enum: ["update", "run", "lead", "hotfix"] }, args: { type: "object" } }, required: ["label", "op", "args"], additionalProperties: false } },
    ];
    const cards: Record<string, any>[] = [];
    let reply = "";
    try {
      for (let turn = 0; turn < 6; turn++) {
        const res = await this.llm().create({ model: this.settings.modelId(this.settings.get().defaultModel), max_tokens: 4000, system: `${BUTLER_SYSTEM}\n\n可用智能体：${agents}`, messages, tools, output_config: { effort: "medium" } }, { signal: AbortSignal.timeout(120_000) });
        messages.push({ role: "assistant", content: res.content });
        reply = res.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("\n").trim() || reply;
        const calls = res.content.filter((b) => b.type === "tool_use") as { id: string; name: string; input: any }[];
        if (res.stop_reason !== "tool_use" || !calls.length) break;
        const results = calls.map((c) => ({ type: "tool_result" as const, tool_use_id: c.id, content: this.butlerTool(c.name, c.input, cards) }));
        messages.push({ role: "user", content: results });
      }
    } catch (e) {
      const msg = (e as Error).message;
      if (/auth|api.?key|credential|401/i.test(msg)) { const conv = this.conversation(); conv.pop(); this.saveConv(conv); return { fallback: true }; }
      reply = `抱歉，出错了：${msg}`;
    }
    if (!cards.length) this.append({ role: "ai", text: reply || "好的。" });
    cards.forEach((card, n) => this.append({ role: "ai", text: n === 0 ? reply || "请确认：" : "还有一项：", card }));
    return {};
  }
  private butlerTool(name: string, input: any, cards: Record<string, any>[]): string {
    try {
      if (name === "list_projects") return JSON.stringify(this.work.projects().map((p) => ({ key: p.key, name: p.name, repo: p.repo?.fullName ?? null, counts: p.counts, lead: p.lead.mode })), null, 1);
      if (name === "list_issues") {
        const pid = input.project ? this.work.projectsRaw().find((p) => p.key === String(input.project).toUpperCase())?.id : undefined;
        return this.work.list(pid).map((i) => `${i.key} [${STATUS[i.status]}${i.phase ? `·${PHASE_LABEL[i.phase]}` : ""}] ${i.assignee ?? "未指派"} — ${i.title}`).join("\n") || "（无）";
      }
      if (name === "get_issue") { const d = this.work.detail(input.issue); return `${d.key} ${d.title}\n状态：${STATUS[d.status]}\n描述：${d.description}\n最近动态：\n${d.activity.slice(-6).map((c) => `[${c.author}] ${c.body.slice(0, 300)}`).join("\n")}`; }
      if (name === "propose_plan") {
        const p = this.work.projectsRaw().find((x) => x.key === String(input.project).toUpperCase()) ?? this.work.projectsRaw()[0];
        cards.push({ type: "plan", projectId: p?.id, items: (input.items ?? []).map((x: any) => ({ title: x.title, description: x.description ?? "", assignee: x.assignee ?? "", priority: x.priority ?? 3, labels: x.labels ?? [], on: true })), startNow: false, created: false });
        return "已展示给用户，等待确认。";
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
