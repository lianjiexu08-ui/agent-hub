/**
 * 全局设置、技能库、项目知识、预算与安全护栏。
 * 密钥（Anthropic API Key、GitHub Token）单独存放，任何接口都只返回掩码。
 */
import Anthropic from "@anthropic-ai/sdk";
import type { Store } from "./db.ts";
import { DEFAULT_NOTIFY, type NotifyConfig } from "./notify.ts";
import { GitHub } from "./github.ts";
import { Linear } from "./linear.ts";
import { normalizeBaseUrl, type ProviderType } from "./providers.ts";
import { probeProvider } from "./llm.ts";

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

export interface Provider {
  id: string;
  /** anthropic = Anthropic Messages API（含兼容端点）；openai = OpenAI Chat Completions（含兼容端点） */
  type: ProviderType;
  name: string;
  /** 接口地址，如 https://api.deepseek.com/v1；Anthropic 官方留空或填 https://api.anthropic.com */
  baseUrl: string;
  method: "none" | "key" | "profile";
  keyHint: string | null;
  verifiedAt: string | null;
  /** 最近一次探测到的模型列表（只做参考，模型条目仍由用户选定） */
  models?: string[];
}
export interface ModelEntry { id: string; label: string; modelId: string; providerId: string; enabled: boolean; builtin?: boolean; desc?: string; price?: string; tag?: string; /** 每百万 tokens 的输入价格（美元） */ inputPrice?: number; /** 每百万 tokens 的输出价格（美元） */ outputPrice?: number }
export interface GuardConfig { isolation: "worktree" | "container"; network: "allowlist" | "open"; protectedBranches: string[]; protectedPaths: string[]; maxDiff: number; requireTests: boolean; access: "token" | "password" | "sso"; secrets: { name: string; scope: string }[] }
export interface BudgetConfig { daily: number; perIssue: number; perProject: Record<string, number> }
export interface QASettings { schedule: "auto" | "serial"; maxParallel: number; browser: "pool" | "local"; headless: boolean }
export interface LinearConfig {
  connected: boolean;
  viewer?: string;
  email?: string;
  keyHint?: string;
  teams?: { id: string; key: string; name: string }[];
  connectedAt?: string;
}
export interface GlobalSettings {
  providers: Provider[];
  models: ModelEntry[];
  defaultModel: string;
  assistantModel: string;
  defaultEffort: string;
  runtimes: Record<string, { template: string; max: number }>;
  /** 内置运行底座同时在途的模型请求数 */
  concurrency: { model: number };
  budget: BudgetConfig;
  guard: GuardConfig;
  notify: NotifyConfig;
  qa: QASettings;
  github: { connected: boolean; method?: string; login?: string; scopes?: string[]; repos?: string[]; tokenHint?: string; connectedAt?: string };
  linear: LinearConfig;
}
export interface Skill { id: string; name: string; description: string; instructions: string; createdBy: string; updatedAt: string }
export interface Knowledge { id: number; projectId: string; kind: string; text: string; source: string; at: string; on: boolean }

const defaults = (): GlobalSettings => ({
  providers: [{ id: "anthropic", type: "anthropic", name: "Anthropic（官方）", baseUrl: "https://api.anthropic.com", method: "none", keyHint: null, verifiedAt: null }],
  models: MODELS.map((m) => ({ id: m.id, label: m.label, modelId: m.id, providerId: "anthropic", enabled: true, builtin: true, desc: m.desc, price: m.price, tag: m.tag })),
  defaultModel: "claude-opus-5-5",
  /** 管家对话使用的模型条目；留空表示跟随默认模型 */
  assistantModel: "",
  defaultEffort: "medium",
  runtimes: Object.fromEntries(Object.entries(RUNTIME_TEMPLATES).map(([k, v]) => [k, { template: v, max: 4 }])),
  concurrency: { model: Number(process.env.HUB_MAX_CONCURRENCY) || 8 },
  budget: { daily: 50, perIssue: 10, perProject: {} },
  guard: { isolation: "worktree", network: "allowlist", protectedBranches: ["main", "release/*"], protectedPaths: [".github/**", "**/migrations/**", "infra/**", "**/auth/**", "**/payment/**"], maxDiff: 800, requireTests: true, access: "token", secrets: [] },
  notify: DEFAULT_NOTIFY,
  qa: { schedule: "auto", maxParallel: 3, browser: "pool", headless: true },
  github: { connected: false },
  linear: { connected: false },
});

export const DEFAULT_SKILLS: Omit<Skill, "createdBy" | "updatedAt">[] = [
  { id: "task-decomposition", name: "任务拆解", description: "目标复杂、需要多个智能体协作完成时使用", instructions: "## 任务拆解\n\n1. 先复述目标与验收标准\n2. 拆成互不重叠、可独立验收的子任务\n3. 为每个子任务写清背景、输入和期望输出\n4. 互不依赖的子任务并行派发，有依赖的按顺序推进" },
  { id: "web-research", name: "网络调研", description: "需要查资料、核实事实、引用来源时使用", instructions: "## 网络调研\n\n- 每条结论至少交叉验证两个独立来源\n- 附上来源链接与发布日期\n- 区分事实、观点和推测，不确定的要标注" },
  { id: "report-writing", name: "报告撰写", description: "需要产出结构化报告、方案或对比分析时使用", instructions: "## 报告结构\n\n1. 结论先行（3 句以内）\n2. 背景与范围\n3. 分析（能用表格就用表格）\n4. 建议与下一步\n\n全文控制在 3000 字以内。" },
  { id: "chinese-copy", name: "中文文案规范", description: "撰写或审阅面向用户的中文文案时使用", instructions: "## 中文文案规范\n\n- 中英文、数字之间加空格\n- 使用全角标点\n- 避免空话套话\n- 一句话只说一件事" },
  { id: "git-pr-workflow", name: "分支与 PR 流程", description: "修改仓库代码时使用", instructions: "## 分支与 PR\n\n1. 只在当前工作目录（独立分支）中修改\n2. 小步提交，提交信息引用工作项编号\n3. 本地跑通测试后再汇报执行完成\n4. 不要修改与任务无关的文件" },
  { id: "test-dispatch", name: "测试分发", description: "代码变更需要验证时使用", instructions: "## 测试\n\n- 根据改动范围选择单元测试 / 集成测试 / 浏览器验收\n- 把失败用例和复现步骤写清楚\n- 全部通过后再给出结论" },
  { id: "requirement-analysis", name: "需求分析", description: "把模糊需求整理成可验收的描述时使用", instructions: "## 需求分析\n\n1. 目标：一句话说明给谁、解决什么问题\n2. 验收标准：2–5 条，每条可观察、可验证（尽量带数值）\n3. 边界与异常：失败、为空、超时、权限不足、并发\n4. 范围：改哪些页面/模块，明确不做什么\n5. 待确认问题：拿不准的列出来，不要替用户决定" },
  { id: "tech-design", name: "技术方案", description: "需要设计实现方案、评估影响面时使用", instructions: "## 技术方案\n\n- 背景与目标（引用验收标准）\n- 涉及模块、接口与数据结构变化\n- 关键流程（必要时用步骤列表）\n- 兼容、迁移与回滚方式\n- 风险与备选方案\n- 拆分：按可独立交付、可独立验收的粒度拆成子工作项" },
  { id: "frontend-dev", name: "前端开发规范", description: "修改页面、组件、样式时使用", instructions: "## 前端开发\n\n- 每个数据视图都要有加载、空、错误三种状态\n- 交互元素可用键盘操作，有可见焦点，图标按钮有 aria-label\n- 不在前端存放密钥；接口错误要给用户可理解的提示\n- 修改后在桌面常用宽度下自查布局" },
  { id: "backend-dev", name: "后端开发规范", description: "修改接口、数据模型、服务端逻辑时使用", instructions: "## 后端开发\n\n- 所有外部输入做校验，错误返回明确的状态码与信息\n- 写操作考虑幂等与并发；外部调用设置超时\n- 数据库结构变更必须向后兼容，附迁移与回滚说明\n- 日志不输出密钥和个人敏感信息\n- 为新逻辑补充单元或集成测试" },
  { id: "devops-release", name: "发布与运维", description: "修改 CI、容器、部署脚本时使用", instructions: "## 发布与运维\n\n- 改动必须可回滚，写明回滚步骤\n- 密钥只通过环境变量或密钥管理引用，不写入仓库\n- CI 改动先在分支上跑通\n- 新增服务要有健康检查与基本监控" },
  { id: "code-review", name: "代码评审", description: "审查代码改动时使用", instructions: "## 代码评审清单\n\n1. 是否满足验收标准\n2. 逻辑与边界：空值、异常、并发、时区、精度\n3. 回归风险：改动是否影响其他调用方\n4. 测试：关键路径是否有测试，测试是否真的断言了行为\n5. 可维护性：命名、重复、过度设计\n\n输出：结论 + 问题清单（阻塞 / 建议，位置、原因、修改方式）" },
  { id: "security-review", name: "安全审查", description: "改动涉及鉴权、支付、密钥、外部输入时使用", instructions: "## 安全审查清单\n\n- 鉴权与越权：每个接口是否校验身份与资源归属\n- 注入：SQL、命令、模板、XSS、路径穿越\n- 敏感信息：密钥、令牌、个人信息是否出现在日志、前端或仓库\n- 支付与金额：精度、重复提交、回调验签\n- 依赖：新增依赖的来源与已知漏洞\n\n输出：结论 + 风险清单（严重程度、位置、利用条件、修复建议）" },
  { id: "issue-triage", name: "Issue 分诊", description: "整理新 issue、判断优先级和负责人时使用", instructions: "## 分诊\n\n1. 判断类型：bug / 功能 / 改进 / 文档\n2. bug 先尝试复现，附上复现步骤\n3. 按影响面和紧急程度定优先级\n4. 指派给最合适的智能体，必要时拆分" },
];

const hint = (k: string) => (k.length > 12 ? `${k.slice(0, 7)}…${k.slice(-4)}` : "••••");

export class Settings {
  private store: Store;
  constructor(store: Store) {
    this.store = store;
    if (!this.store.docGet("settings", "global")) this.store.docPut("settings", "global", { id: "global", ...defaults() });
    const meta = this.store.docGet<{ id: string; skills: string[] }>("meta", "seed-skills");
    const seeded = new Set(meta?.skills ?? (this.store.docList("skills").length ? this.store.docList<{ id: string }>("skills").map((s) => s.id) : []));
    for (const s of DEFAULT_SKILLS) {
      if (seeded.has(s.id) || this.store.docGet("skills", s.id)) { seeded.add(s.id); continue; }
      this.store.docPut("skills", s.id, { ...s, createdBy: "内置", updatedAt: new Date().toISOString() });
      seeded.add(s.id);
    }
    this.store.docPut("meta", "seed-skills", { id: "seed-skills", skills: [...seeded] });
  }
  get(): GlobalSettings {
    const d = defaults();
    const s = this.store.docGet<GlobalSettings>("settings", "global") ?? d;
    return { ...d, ...s, notify: { ...d.notify, ...s.notify }, guard: { ...d.guard, ...s.guard }, budget: { ...d.budget, ...s.budget }, qa: { ...d.qa, ...s.qa }, runtimes: { ...d.runtimes, ...s.runtimes }, concurrency: { ...d.concurrency, ...s.concurrency } };
  }
  private put(s: GlobalSettings) { this.store.docPut("settings", "global", { id: "global", ...s }); }
  /** 允许前端修改的部分（不含密钥） */
  patch(p: Partial<Pick<GlobalSettings, "defaultModel" | "defaultEffort" | "runtimes" | "budget" | "guard" | "notify" | "qa" | "models" | "concurrency" | "assistantModel">>) {
    const s = this.get();
    for (const k of ["defaultModel", "defaultEffort", "models", "assistantModel"] as const) if (p[k] !== undefined) (s as any)[k] = p[k];
    for (const k of ["runtimes", "budget", "guard", "notify", "qa", "concurrency"] as const) if (p[k]) (s as any)[k] = { ...(s as any)[k], ...p[k] };
    this.put(s);
  }
  private secrets(): Record<string, string> { return this.store.docGet("secrets", "global") ?? {}; }
  private setSecret(k: string, v: string | null) {
    const s = this.secrets();
    if (v) s[k] = v; else delete s[k];
    this.store.docPut("secrets", "global", s);
  }
  githubToken = (): string | null => this.secrets().githubToken ?? process.env.GITHUB_TOKEN ?? null;
  linearToken = (): string | null => this.secrets().linearToken ?? process.env.LINEAR_API_KEY ?? null;
  providerKey(providerId: string): string | null {
    const s = this.secrets();
    return s[`provider:${providerId}`] ?? s[`anthropic:${providerId}`] ?? null;
  }

  /** 内置运行底座使用的客户端：优先使用设置里验证过的 Key，否则读取环境变量或 ant 登录凭据 */
  anthropicClient(providerId?: string): Anthropic {
    const p = this.get().providers.find((x) => (providerId ? x.id === providerId : x.type === "anthropic" && x.method === "key" && x.verifiedAt));
    const key = p ? this.providerKey(p.id) : null;
    const baseURL = p?.baseUrl && p.baseUrl !== "https://api.anthropic.com" ? p.baseUrl : undefined;
    return key ? new Anthropic({ apiKey: key, ...(baseURL ? { baseURL } : {}) }) : new Anthropic({ ...(baseURL ? { baseURL } : {}) });
  }
  async verifyProvider(id: string | null, f: { name?: string; type?: ProviderType; baseUrl?: string; method: "key" | "profile"; key?: string }) {
    const s = this.get();
    let p = s.providers.find((x) => x.id === id);
    if (!p) {
      p = { id: "conn_" + Math.random().toString(36).slice(2, 7), type: "anthropic", name: "新连接", baseUrl: "https://api.anthropic.com", method: "none", keyHint: null, verifiedAt: null };
      s.providers.push(p);
    }
    if (f.type) p.type = f.type;
    if (f.baseUrl !== undefined) p.baseUrl = normalizeBaseUrl(f.baseUrl);
    if (f.method === "key") {
      const key = f.key?.trim() || this.providerKey(p.id);
      if (!key) throw new Error("请填写 API Key");
      p.models = await probeProvider(p, key);
      this.setSecret(`provider:${p.id}`, key);
      Object.assign(p, { method: "key", keyHint: hint(key), verifiedAt: new Date().toISOString() });
    } else {
      p.models = await probeProvider(p, null);
      Object.assign(p, { method: "profile", keyHint: null, verifiedAt: new Date().toISOString() });
    }
    if (f.name?.trim()) p.name = f.name.trim();
    this.put(s);
    return p;
  }

  /** 重新探测连接的模型列表（用已保存的 Key） */
  async listProviderModels(id: string): Promise<string[]> {
    const s = this.get();
    const p = s.providers.find((x) => x.id === id);
    if (!p) throw new Error("连接不存在");
    const models = await probeProvider(p, this.providerKey(p.id));
    p.models = models;
    p.verifiedAt = new Date().toISOString();
    this.put(s);
    return models;
  }
  removeProvider(id: string) {
    const s = this.get();
    if (s.models.some((m) => m.providerId === id)) throw new Error("还有模型使用这个连接，先移除或改用其他连接");
    s.providers = s.providers.filter((p) => p.id !== id);
    this.setSecret(`provider:${id}`, null);
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
  modelEntry(entryId: string): ModelEntry | undefined { return this.get().models.find((m) => m.id === entryId); }
  /** 管家使用的模型条目：单独的设置优先，否则用默认模型 */
  assistantModelId() { const s = this.get(); return s.assistantModel && s.models.some((m) => m.id === s.assistantModel) ? s.assistantModel : s.defaultModel; }

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

  // ---------- Linear ----------
  /** 用 Personal API Key 验证并保存；同时拉取可见团队，供项目绑定 */
  async connectLinear(key: string) {
    const trimmed = key.trim();
    if (!trimmed) throw new Error("请填写 Linear API Key");
    const l = new Linear(() => trimmed);
    const viewer = await l.viewer();
    const teams = await l.teams();
    this.setSecret("linearToken", trimmed);
    const s = this.get();
    s.linear = {
      connected: true,
      viewer: viewer.name || viewer.email,
      email: viewer.email,
      keyHint: hint(trimmed),
      teams: teams.map((t) => ({ id: t.id, key: t.key, name: t.name })),
      connectedAt: new Date().toISOString(),
    };
    this.put(s);
  }
  async refreshLinearTeams() {
    const token = this.linearToken();
    if (!token) throw new Error("请先连接 Linear");
    const teams = await new Linear(() => token).teams();
    const s = this.get();
    s.linear = { ...s.linear, teams: teams.map((t) => ({ id: t.id, key: t.key, name: t.name })) };
    this.put(s);
  }
  disconnectLinear() {
    this.setSecret("linearToken", null);
    const s = this.get();
    s.linear = { connected: false };
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
