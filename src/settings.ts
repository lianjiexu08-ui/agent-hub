/**
 * 全局设置、技能库、项目知识、预算与安全护栏。
 * 密钥（Anthropic API Key、GitHub Token）单独存放，任何接口都只返回掩码。
 */
import Anthropic from "@anthropic-ai/sdk";
import type { Store } from "./db.ts";
import { DEFAULT_NOTIFY, type NotifyConfig } from "./notify.ts";
import { GitHub } from "./github.ts";

export const MODELS = [
  { id: "claude-opus-5-5", label: "Claude Opus 5.5", tag: "默认", desc: "综合能力强，适合大多数智能体和多步骤任务", price: "$4 / $20 每百万 tokens" },
  { id: "claude-fable-5-2", label: "Claude Fable 5.2", tag: "最强", desc: "最难的推理与长程任务；更慢、更贵", price: "$8 / $40 每百万 tokens" },
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", tag: "均衡", desc: "速度与能力兼顾，适合日常写作和编码", price: "$2 / $10 每百万 tokens" },
  { id: "claude-haiku-5-5", label: "Claude Haiku 5.5", tag: "最快", desc: "简单、高频任务，成本最低", price: "$0.10 / $0.50 每百万 tokens" },
];
export const RUNTIME_TEMPLATES: Record<string, string> = {
  "claude-code": 'claude -p "{prompt}" --output-format stream-json --verbose --model {model} --append-system-prompt "{system}" --mcp-config {mcp_config} --permission-mode bypassPermissions',
  codex: 'codex exec --json -m {model} "{prompt}"',
  gemini: 'gemini -p "{prompt}" -o stream-json -m {model} --approval-mode yolo',
  pi: 'pi -p --mode json --model {model} --append-system-prompt "{system}" "{prompt}"',
};

export interface Provider { id: string; type: "anthropic"; name: string; method: "none" | "key" | "profile"; keyHint: string | null; verifiedAt: string | null }
export interface ModelEntry { id: string; label: string; modelId: string; providerId: string; enabled: boolean; builtin?: boolean; desc?: string; price?: string; tag?: string }
export interface GuardConfig { isolation: "worktree" | "container"; network: "allowlist" | "open"; protectedBranches: string[]; protectedPaths: string[]; maxDiff: number; requireTests: boolean; access: "token" | "password" | "sso"; secrets: { name: string; scope: string }[] }
export interface BudgetConfig { daily: number; perIssue: number; perProject: Record<string, number> }
export interface QASettings { schedule: "auto" | "serial"; maxParallel: number; browser: "pool" | "local"; headless: boolean }
export interface GlobalSettings {
  providers: Provider[];
  models: ModelEntry[];
  defaultModel: string;
  defaultEffort: string;
  runtimes: Record<string, { template: string; max: number }>;
  budget: BudgetConfig;
  guard: GuardConfig;
  notify: NotifyConfig;
  qa: QASettings;
  github: { connected: boolean; method?: string; login?: string; scopes?: string[]; repos?: string[]; tokenHint?: string; connectedAt?: string };
}
export interface Skill { id: string; name: string; description: string; instructions: string; createdBy: string; updatedAt: string }
export interface Knowledge { id: number; projectId: string; kind: string; text: string; source: string; at: string; on: boolean }

const defaults = (): GlobalSettings => ({
  providers: [{ id: "anthropic", type: "anthropic", name: "Anthropic", method: "none", keyHint: null, verifiedAt: null }],
  models: MODELS.map((m) => ({ id: m.id, label: m.label, modelId: m.id, providerId: "anthropic", enabled: true, builtin: true, desc: m.desc, price: m.price, tag: m.tag })),
  defaultModel: "claude-opus-5-5",
  defaultEffort: "medium",
  runtimes: Object.fromEntries(Object.entries(RUNTIME_TEMPLATES).map(([k, v]) => [k, { template: v, max: 2 }])),
  budget: { daily: 50, perIssue: 10, perProject: {} },
  guard: { isolation: "worktree", network: "allowlist", protectedBranches: ["main", "release/*"], protectedPaths: [".github/**", "**/migrations/**", "infra/**", "**/auth/**", "**/payment/**"], maxDiff: 800, requireTests: true, access: "token", secrets: [] },
  notify: DEFAULT_NOTIFY,
  qa: { schedule: "auto", maxParallel: 3, browser: "pool", headless: true },
  github: { connected: false },
});

export const DEFAULT_SKILLS: Omit<Skill, "createdBy" | "updatedAt">[] = [
  { id: "task-decomposition", name: "任务拆解", description: "目标复杂、需要多个智能体协作完成时使用", instructions: "## 任务拆解\n\n1. 先复述目标与验收标准\n2. 拆成互不重叠、可独立验收的子任务\n3. 为每个子任务写清背景、输入和期望输出\n4. 互不依赖的子任务并行派发，有依赖的按顺序推进" },
  { id: "web-research", name: "网络调研", description: "需要查资料、核实事实、引用来源时使用", instructions: "## 网络调研\n\n- 每条结论至少交叉验证两个独立来源\n- 附上来源链接与发布日期\n- 区分事实、观点和推测，不确定的要标注" },
  { id: "report-writing", name: "报告撰写", description: "需要产出结构化报告、方案或对比分析时使用", instructions: "## 报告结构\n\n1. 结论先行（3 句以内）\n2. 背景与范围\n3. 分析（能用表格就用表格）\n4. 建议与下一步\n\n全文控制在 3000 字以内。" },
  { id: "chinese-copy", name: "中文文案规范", description: "撰写或审阅面向用户的中文文案时使用", instructions: "## 中文文案规范\n\n- 中英文、数字之间加空格\n- 使用全角标点\n- 避免空话套话\n- 一句话只说一件事" },
  { id: "git-pr-workflow", name: "分支与 PR 流程", description: "修改仓库代码时使用", instructions: "## 分支与 PR\n\n1. 只在当前工作目录（独立分支）中修改\n2. 小步提交，提交信息引用工作项编号\n3. 本地跑通测试后再汇报执行完成\n4. 不要修改与任务无关的文件" },
  { id: "test-dispatch", name: "测试分发", description: "代码变更需要验证时使用", instructions: "## 测试\n\n- 根据改动范围选择单元测试 / 集成测试 / 浏览器验收\n- 把失败用例和复现步骤写清楚\n- 全部通过后再给出结论" },
  { id: "issue-triage", name: "Issue 分诊", description: "整理新 issue、判断优先级和负责人时使用", instructions: "## 分诊\n\n1. 判断类型：bug / 功能 / 改进 / 文档\n2. bug 先尝试复现，附上复现步骤\n3. 按影响面和紧急程度定优先级\n4. 指派给最合适的智能体，必要时拆分" },
];

const hint = (k: string) => (k.length > 12 ? `${k.slice(0, 7)}…${k.slice(-4)}` : "••••");

export class Settings {
  private store: Store;
  constructor(store: Store) {
    this.store = store;
    if (!this.store.docGet("settings", "global")) this.store.docPut("settings", "global", { id: "global", ...defaults() });
    if (!this.store.docList("skills").length) for (const s of DEFAULT_SKILLS) this.store.docPut("skills", s.id, { ...s, createdBy: "内置", updatedAt: new Date().toISOString() });
  }
  get(): GlobalSettings {
    const d = defaults();
    const s = this.store.docGet<GlobalSettings>("settings", "global") ?? d;
    return { ...d, ...s, notify: { ...d.notify, ...s.notify }, guard: { ...d.guard, ...s.guard }, budget: { ...d.budget, ...s.budget }, qa: { ...d.qa, ...s.qa }, runtimes: { ...d.runtimes, ...s.runtimes } };
  }
  private put(s: GlobalSettings) { this.store.docPut("settings", "global", { id: "global", ...s }); }
  /** 允许前端修改的部分（不含密钥） */
  patch(p: Partial<Pick<GlobalSettings, "defaultModel" | "defaultEffort" | "runtimes" | "budget" | "guard" | "notify" | "qa" | "models">>) {
    const s = this.get();
    for (const k of ["defaultModel", "defaultEffort", "models"] as const) if (p[k] !== undefined) (s as any)[k] = p[k];
    for (const k of ["runtimes", "budget", "guard", "notify", "qa"] as const) if (p[k]) (s as any)[k] = { ...(s as any)[k], ...p[k] };
    this.put(s);
  }
  private secrets(): Record<string, string> { return this.store.docGet("secrets", "global") ?? {}; }
  private setSecret(k: string, v: string | null) {
    const s = this.secrets();
    if (v) s[k] = v; else delete s[k];
    this.store.docPut("secrets", "global", s);
  }
  githubToken = (): string | null => this.secrets().githubToken ?? process.env.GITHUB_TOKEN ?? null;
  anthropicKey(providerId = "anthropic"): string | null { return this.secrets()[`anthropic:${providerId}`] ?? null; }

  /** 内置运行底座使用的客户端：优先使用设置里验证过的 Key，否则读取环境变量或 ant 登录凭据 */
  anthropicClient(): Anthropic {
    const p = this.get().providers.find((x) => x.method === "key" && x.verifiedAt);
    const key = p ? this.anthropicKey(p.id) : null;
    return key ? new Anthropic({ apiKey: key }) : new Anthropic();
  }
  async verifyProvider(id: string | null, f: { name?: string; method: "key" | "profile"; key?: string }) {
    const s = this.get();
    let p = s.providers.find((x) => x.id === id);
    if (!p) { p = { id: "conn_" + Math.random().toString(36).slice(2, 7), type: "anthropic", name: "Anthropic", method: "none", keyHint: null, verifiedAt: null }; s.providers.push(p); }
    if (f.method === "key") {
      const key = f.key?.trim() || this.anthropicKey(p.id);
      if (!key) throw new Error("请填写 API Key");
      await new Anthropic({ apiKey: key }).models.list({ limit: 1 });
      this.setSecret(`anthropic:${p.id}`, key);
      Object.assign(p, { method: "key", keyHint: hint(key), verifiedAt: new Date().toISOString() });
    } else {
      await new Anthropic().models.list({ limit: 1 });
      Object.assign(p, { method: "profile", keyHint: null, verifiedAt: new Date().toISOString() });
    }
    if (f.name?.trim()) p.name = f.name.trim();
    this.put(s);
    return p;
  }
  removeProvider(id: string) {
    const s = this.get();
    if (s.models.some((m) => m.providerId === id)) throw new Error("还有模型使用这个连接，先移除或改用其他连接");
    s.providers = s.providers.filter((p) => p.id !== id);
    this.setSecret(`anthropic:${id}`, null);
    this.put(s);
  }
  saveModel(m: ModelEntry) {
    const s = this.get();
    if (!m.label?.trim() || !m.modelId?.trim()) throw new Error("显示名称和模型 ID 都不能为空");
    const i = s.models.findIndex((x) => x.id === m.id);
    if (i >= 0) s.models[i] = { ...s.models[i], ...m };
    else s.models.push({ ...m, id: m.id || "m_" + Math.random().toString(36).slice(2, 7), enabled: true, providerId: m.providerId || s.providers[0]?.id });
    this.put(s);
  }
  removeModel(id: string) {
    const s = this.get();
    s.models = s.models.filter((m) => m.id !== id || m.builtin);
    this.put(s);
  }
  /** 模型条目 id → 实际调用的模型 ID */
  modelId(entryId: string) { return this.get().models.find((m) => m.id === entryId)?.modelId ?? entryId; }

  async connectGithub(token: string) {
    const gh = new GitHub(() => token);
    const user = await gh.user();
    const repos = await gh.repos();
    this.setSecret("githubToken", token);
    const s = this.get();
    s.github = { connected: true, method: "pat", login: user.login, scopes: ["Contents", "Issues", "Pull requests", "Metadata"], repos, tokenHint: hint(token), connectedAt: new Date().toISOString() };
    this.put(s);
  }
  async refreshGithubRepos() {
    const t = this.githubToken();
    if (!t) return;
    const s = this.get();
    s.github.repos = await new GitHub(() => t).repos();
    this.put(s);
  }
  disconnectGithub() {
    this.setSecret("githubToken", null);
    const s = this.get();
    s.github = { connected: false };
    this.put(s);
  }
  guard() { return this.get().guard; }
  addSecret(name: string, value: string, scope = "全部项目") {
    if (!/^[A-Z][A-Z0-9_]*$/.test(name)) throw new Error("名称用大写字母、数字和下划线");
    this.setSecret(`env:${name}`, value);
    const s = this.get();
    s.guard.secrets = [...s.guard.secrets.filter((x) => x.name !== name), { name, scope }];
    this.put(s);
  }
  removeSecret(name: string) {
    this.setSecret(`env:${name}`, null);
    const s = this.get();
    s.guard.secrets = s.guard.secrets.filter((x) => x.name !== name);
    this.put(s);
  }
  /** 注入给 CLI 底座的环境变量（按名称引用的密钥） */
  secretEnv(): Record<string, string> {
    return Object.fromEntries(Object.entries(this.secrets()).filter(([k]) => k.startsWith("env:")).map(([k, v]) => [k.slice(4), v]));
  }

  // ---------- 预算 ----------
  spent(costs: { cost: number; startedAt: string; projectId: string | null }[], projectId?: string) {
    const day = new Date().toDateString();
    return costs.filter((c) => new Date(c.startedAt).toDateString() === day && (!projectId || c.projectId === projectId)).reduce((s, c) => s + c.cost, 0);
  }
  budgetBlocked(projectId: string, issueCost: number, costs: { cost: number; startedAt: string; projectId: string | null }[]): string | null {
    const b = this.get().budget;
    if (b.daily && this.spent(costs) >= b.daily) return `今日总预算 $${b.daily} 已用完`;
    if (b.perProject[projectId] && this.spent(costs, projectId) >= b.perProject[projectId]) return `项目今日预算 $${b.perProject[projectId]} 已用完`;
    if (b.perIssue && issueCost >= b.perIssue) return `该工作项已花费 $${issueCost.toFixed(2)}，超过单项上限 $${b.perIssue}`;
    return null;
  }

  // ---------- 技能 ----------
  skills(): Skill[] { return this.store.docList<Skill>("skills"); }
  skill(id: string): Skill | undefined { return this.store.docGet<Skill>("skills", id); }
  saveSkill(s: Skill, orig?: string | null) {
    if (!s.name?.trim()) throw new Error("技能名称不能为空");
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(s.id)) throw new Error("技能标识只能包含字母、数字、- 和 _");
    if (s.id !== orig && this.skill(s.id)) throw new Error(`已存在标识为 ${s.id} 的技能`);
    if (orig && orig !== s.id) this.store.docDelete("skills", orig);
    const v = { ...s, name: s.name.trim(), updatedAt: new Date().toISOString() };
    this.store.docPut("skills", s.id, v);
    return v;
  }
  deleteSkill(id: string) { this.store.docDelete("skills", id); }

  // ---------- 项目知识 ----------
  knowledge(projectId: string): Knowledge[] { return this.store.docList<Knowledge>("knowledge").filter((k) => k.projectId === projectId).reverse(); }
  addKnowledge(projectId: string, kind: string, text: string, source = "手动") {
    if (!text.trim() || this.knowledge(projectId).some((k) => k.text === text)) return;
    const id = this.store.nextSeq("knowledge");
    this.store.docPut("knowledge", id, { id, projectId, kind, text: text.trim(), source, at: new Date().toISOString(), on: true });
  }
  toggleKnowledge(id: number, on: boolean) { const k = this.store.docGet<Knowledge>("knowledge", id); if (k) this.store.docPut("knowledge", id, { ...k, on }); }
  removeKnowledge(id: number) { this.store.docDelete("knowledge", id); }
}
