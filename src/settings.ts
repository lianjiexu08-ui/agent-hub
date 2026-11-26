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
export interface GuardConfig { isolation: "worktree" | "container"; network: "allowlist" | "open"; protectedBranches: string[]; protectedPaths: string[]; maxDiff: number; requireTests: boolean;
  /**
   * 资深评审代替人放行：只因「改动超过行数上限」或「涉及这些受保护路径」被拦时，交给 agent 对整个 PR 做一次评审，
   * 结论通过就照常自动合并，否则带着意见交回开发。测试 / CI 不过、涉及其余受保护路径仍然要人。
   */
  reviewer?: { agent: string; size: boolean; paths: string[] } | null; access: "token" | "password" | "sso"; secrets: { name: string; scope: string }[] }
export interface BudgetConfig { daily: number; perIssue: number; perProject: Record<string, number> }
export interface QASettings { schedule: "auto" | "serial"; maxParallel: number; browser: "pool" | "local"; headless: boolean;
  /** 浏览器验收用哪个驱动：builtin = Hub 内置（playwright-core + 本机 Chrome，默认）；deveye = 外部 DevEye（需单独安装） */
  engine?: "builtin" | "deveye";
  /** 内置驱动用的 Chrome / Chromium 路径；不填则自动查找常见安装位置 */
  chromePath?: string;
  /** DevEye Chrome 扩展的 dist 目录（engine = deveye 时需要） */
  deveyeExtension?: string }
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
  /** max：这个底座同时运行的进程数；providers：按模型厂商（模型名「/」前的部分，如 kimi-coding）单独限制并发 */
  runtimes: Record<string, { template: string; max: number; providers?: Record<string, number> }>;
  /** 内置运行底座同时在途的模型请求数 */
  concurrency: { model: number };
  /**
   * CLI 底座的兜底：智能体配置的模型用不了（额度用完、并发超限、鉴权失败、厂商故障）时，按顺序换成下一个能用的底座和模型重跑这一步。
   * model 为空表示用该 CLI 的默认模型。
   */
  fallback: { on: boolean; chain: { runtime: string; model: string }[] };
  budget: BudgetConfig;
  guard: GuardConfig;
  notify: NotifyConfig;
  qa: QASettings;
  github: { connected: boolean; method?: string; login?: string; scopes?: string[]; repos?: string[]; tokenHint?: string; connectedAt?: string; /** 「待审核」在 GitHub 上用哪个标签表示 */ reviewLabel?: string };
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
  fallback: { on: true, chain: [{ runtime: "pi", model: "zai/glm-5.4" }, { runtime: "pi", model: "kimi-coding/k3.1-pro" }, { runtime: "claude-code", model: "" }] },
  budget: { daily: 50, perIssue: 10, perProject: {} },
  guard: { isolation: "worktree", network: "allowlist", protectedBranches: ["main", "release/*"], protectedPaths: [".github/**", "**/migrations/**", "infra/**", "**/auth/**", "**/payment/**"], maxDiff: 800, requireTests: true, access: "token", secrets: [] },
  notify: DEFAULT_NOTIFY,
  qa: { schedule: "auto", maxParallel: 3, browser: "pool", headless: true, engine: "builtin" },
  github: { connected: false, reviewLabel: "in-review" },
  linear: { connected: false },
});

export const DEFAULT_SKILLS: Omit<Skill, "createdBy" | "updatedAt">[] = [
  { id: "requirement-analysis", name: "需求分析", description: "把模糊需求整理成可验收的规格时使用", instructions: `## 需求分析

把一句模糊的要求变成可验收的规格。做的不是"复述需求"，而是消除歧义、锁定边界。

### 什么时候用
- 收到新需求、用户反馈、线上问题，还不确定要做成什么样
- 需求方给的是一句结论（"加个搜索"），缺少场景和边界

**不用在**：需求已经写明验收标准且无歧义时，直接进任务拆解。

### 前提：必须先拿到的事实
缺任何一项都先问，不要猜着往下做：

1. **谁在什么场景下用**——具体到角色和触发时机，不是"用户"
2. **现在他们怎么解决的**——手工、竞品、还是根本没有
3. **做完之后什么算成功**——可观测的指标或可复现的操作
4. **明确不做什么**——本期范围外的东西，写下来
5. **约束**：上线时间、兼容的旧版本、必须复用的系统、合规要求

### 步骤
1. **复述**：用一句话说清"谁，在什么情况下，要做什么，为了什么"。让需求方确认。
2. **列场景**：主流程 + 至少 3 个分支（空数据、无权限、失败重试、并发、超量）。每个分支写清楚期望行为。
3. **划边界**：把"本期做 / 本期不做 / 以后再说"三栏列出来。争议项直接归到"不做"。
4. **定义验收**：每条验收标准写成「给定…当…则…」的形式，能被测试直接转成用例。
5. **标不确定项**：技术上没把握、依赖外部系统、需要设计稿的，单独列出并标注谁来确认。

### 检查清单
- [ ] 一句话结论里没有"优化""完善""更好"这类无法验收的词
- [ ] 每条验收标准都能写出对应的测试用例
- [ ] 空数据、无权限、失败、超量四种情况都有明确行为
- [ ] 写清了本期不做什么
- [ ] 有争议或没把握的点已单独列出，没有藏在正文里
- [ ] 涉及数据的，写清了数据从哪来、存哪、保留多久

### 输出模板
\`\`\`
## 结论
<谁> 在 <场景> 下需要 <能力>，以便 <价值>。

## 现状
<现在怎么做的，哪里痛>

## 主流程
1. …

## 分支与边界
| 场景 | 期望行为 |
|---|---|
| 没有数据 | … |
| 无权限 | … |
| 请求失败 | … |
| 超量/并发 | … |

## 验收标准
- 给定 …，当 …，则 …
- 给定 …，当 …，则 …

## 本期不做
- …

## 待确认
- [ ] <问题> — 找 <谁> 确认
\`\`\`

### 常见错误
- 把需求方的**解决方案**当成需求（"加个导出按钮"背后可能是"我要每周给老板发数据"）
- 只写主流程，分支留到开发时再想——那时改代价最大
- 验收标准写成"功能正常可用"
- 把"以后再说"删掉而不是记下来，下一轮又从头吵一遍` },
  { id: "task-decomposition", name: "任务拆解", description: "目标复杂、需要多个子任务并行推进时使用", instructions: `## 任务拆解

把一份需求拆成能被不同人并行执行、且各自可独立验收的工作项。

### 什么时候用
- 需求已经明确，但工作量超过一个人一次能交付的规模
- 需要多个角色（前端、后端、测试）并行推进

**不用在**：单个小改动（一个文件、一个接口），直接做。

### 拆分的三条硬标准
每个子任务必须同时满足，否则继续拆或合并：

1. **可独立验收**——自己的验收标准不依赖别的子任务完成。做不到，说明边界划错了。
2. **可独立回滚**——出了问题能单独撤回，不影响其他子任务。
3. **上下文自包含**——只看这个任务的描述就能开工，不需要读别的任务。

### 步骤
1. **画出依赖图**：先列"谁必须在谁之前"。找到最长的依赖链，这是关键路径。
2. **按验收边界切**：不按技术分层切（"前端任务/后端任务"），按"一个完整可验证的行为"切。例如"商品列表支持按价格排序"而不是"写排序接口"+"写排序按钮"。
3. **标注并行组**：没有依赖的子任务放进同一批，同时派发。有依赖的按关键路径排。
4. **写清楚交接物**：接口约定、数据结构、事件名、错误码——凡是两个任务都要用的，在任务里写死，不要让两边各自猜。
5. **排优先级**：先能打通主流程的最小集合，再补分支和打磨。
6. **估规模**：单个任务超过一天工作量就该再拆。

### 检查清单
- [ ] 每个任务都能单独验收，验收标准写在任务里
- [ ] 没有"做接口"这类看不出交付物的任务
- [ ] 跨任务共用的契约（接口/字段/错误码）已经固定并写进任务
- [ ] 依赖关系明确，并行组分得出来
- [ ] 有一条能最快打通主流程的路径
- [ ] 每个任务的背景足够让对方不看别的任务也能开工

### 输出模板
\`\`\`
## 目标
<一句话>

## 依赖关系
A ──> C
B ──┘   （A、B 并行，C 依赖两者）

## 任务
### 1. <标题>   负责人：<角色>  优先级：高
背景：…
做什么：…
验收：给定 …，当 …，则 …
产出物：…
依赖：无
\`\`\`

### 常见错误
- 按技术层切分，导致每个任务都无法独立验收
- 只写"做什么"，不写"什么算做完"
- 接口约定放在某一个人的脑子里，另一个人只能猜
- 拆完没有关键路径，所有任务都标"紧急"` },
  { id: "tech-design", name: "技术方案", description: "需要设计实现方案、评估影响面时使用", instructions: `## 技术方案

把一个已确认的需求翻译成能直接照着写代码的设计。

### 什么时候用
- 改动涉及多个模块、数据结构或外部系统
- 有多种做法，需要说清为什么选这个
- 需要评估影响面和回滚方式

**不用在**：单文件小改动、纯文案或配置调整。

### 步骤
1. **确认输入**：需求、验收标准、现状代码。没读现状就写方案，几乎一定会漏掉已有的约定。
2. **列现状**：涉及的模块、现有接口、数据结构、调用方。这部分要给出文件路径和函数名，不要泛泛而谈。
3. **给方案**：一张图或一段流程说清数据怎么流。关键决策写清取舍——为什么不用另一种。
4. **定契约**：新增/修改的接口签名、请求响应示例、错误码、字段含义与可空性。
5. **说兼容**：老数据怎么办、老客户端怎么办、灰度或开关怎么设计。
6. **定回滚**：出问题时怎么退，退到哪一步，要不要数据修复。
7. **拆任务**：按可独立交付的粒度拆，写成工作项。

### 检查清单
- [ ] 方案里点了具体文件与函数，不是抽象描述
- [ ] 每个关键决策都写了"为什么不用另一种做法"
- [ ] 接口有完整的请求/响应示例，包含错误情况
- [ ] 考虑了老数据与老客户端的兼容
- [ ] 回滚步骤具体到命令或开关名
- [ ] 风险项标了影响面和触发条件
- [ ] 需要新增的依赖、配置、权限都列了出来

### 输出模板
\`\`\`
## 背景与目标
<引用验收标准>

## 现状
- 涉及模块：\`path/to/file.ts\` 的 \`fn()\`
- 现有数据结构：…

## 方案
<数据流 / 时序>

## 关键决策
| 决策 | 选择 | 放弃的方案 | 原因 |
|---|---|---|---|

## 接口
POST /api/…
请求：{ … }
响应 200：{ … }
响应 4xx：{ error: "…" }

## 兼容与迁移
…

## 回滚
1. 关闭开关 \`xxx\`
2. 回滚迁移：…

## 风险
| 风险 | 触发条件 | 影响 | 缓解 |
|---|---|---|---|

## 任务拆分
1. …
\`\`\`

### 常见错误
- 没读现有代码就设计，结果和已有的抽象重复或冲突
- 只写"用 Redis 缓存"，不写 key 设计、过期策略、击穿处理
- 接口不给示例，开发时各自理解
- 不提回滚，上线出问题只能干等` },
  { id: "frontend-dev", name: "前端开发规范", description: "修改页面、组件、样式、交互时使用", instructions: `## 前端开发规范

### 什么时候用
修改页面的结构、样式、交互或前端数据流时。

### 每个视图必须处理的四种状态
缺一不可，且要能肉眼区分：

1. **加载中**——骨架屏或明确的加载提示，不要空白页
2. **空**——说清为什么空，给出下一步动作（"还没有工作项，点这里新建"）
3. **错误**——人能看懂的原因 + 重试入口；技术细节放控制台或折叠区
4. **有数据**——正常渲染

### 交互
- 所有可点元素用 \`<button>\` / \`<a>\`，不要给 \`div\` 绑 click
- 键盘可完整操作：Tab 能到达、Enter/Space 能触发、Esc 能关闭浮层
- 焦点可见，不要 \`outline: none\` 了事
- 图标按钮必须有 \`aria-label\`
- 破坏性操作二次确认，且确认按钮不要是默认焦点
- 表单提交中禁用按钮并显示进度，避免重复提交

### 样式
- 用现有的设计令牌（颜色、间距、圆角），不硬编码色值
- 布局用 flex / grid，不用绝对定位拼版
- 长文本有截断策略（省略号或换行），不能让容器被撑破
- 数字用等宽数字字体对齐（\`font-variant-numeric: tabular-nums\`）
- 深色模式：新增颜色要同时在浅色和深色下检查对比度

### 数据与安全
- 密钥、内部地址、调试开关绝不进前端
- 用户输入渲染前转义；富文本用白名单
- 接口失败要区分"网络问题"和"业务拒绝"，给不同提示
- 列表分页或虚拟滚动，不要一次渲染上千条

### 检查清单
- [ ] 加载、空、错误、有数据四种状态都实现了
- [ ] 键盘能完成主要操作，焦点可见
- [ ] 图标按钮有 aria-label，图片有 alt
- [ ] 在 1280 / 1440 / 1920 宽度下布局正常
- [ ] 长标题、超长单词、空字段不会撑破布局
- [ ] 深色模式下对比度正常
- [ ] 没有把密钥或内部地址写进前端
- [ ] 提交类操作防重复点击

### 常见错误
- 只做"有数据"的路径，空和错的时候页面一片空白
- 用 \`div\` 当按钮，鼠标能用、键盘不能
- 硬编码颜色，深色模式下看不清
- 错误提示直接弹 \`err.message\`（含堆栈或英文原文）` },
  { id: "backend-dev", name: "后端开发规范", description: "修改接口、数据模型、服务端逻辑时使用", instructions: `## 后端开发规范

### 什么时候用
修改接口、数据模型、服务端逻辑、外部调用时。

### 接口
- 所有外部输入先校验再使用：类型、范围、长度、枚举、必填。校验失败返回 400 并说明哪个字段错。
- 错误响应结构统一：\`{ error: "人能看懂的原因", code?: "机器可判断的标识" }\`。不要把堆栈返回给客户端。
- 状态码用对：400 参数错、401 未认证、403 无权限、404 不存在、409 冲突、429 限流、5xx 才是服务端问题。
- 列表接口必须有分页和上限，默认值写死在代码里而不是靠客户端传。
- 写操作考虑幂等：重复提交同一个请求不应该产生两条记录。

### 鉴权与越权
- 每个接口都校验身份，不要依赖"前端不会传"。
- 拿资源前先校验归属：\`资源.ownerId === 当前用户.id\`，不能只按 id 查。
- 内部接口也要鉴权，内网不等于可信。

### 数据
- 结构变更必须向后兼容：先加字段（可空/有默认值），双写，再切读，最后删旧字段。
- 迁移脚本要有回滚路径，且能在已有数据上跑通。
- 查询注意 N+1；列表接口要么一次 JOIN 拿齐，要么批量查。
- 事务边界写清楚：哪些操作必须原子，失败时怎么补偿。
- 时间统一存 UTC，展示时再转本地时区。

### 外部调用
- 一律设超时（连接 + 读取）。没有超时的 HTTP 调用等于埋雷。
- 失败要区分可重试（超时、5xx、限流）与不可重试（4xx、业务拒绝）。
- 重试要有次数上限和退避，且只重试幂等操作。
- 第三方密钥只从环境变量或密钥管理读取，不进仓库、不进日志。

### 日志
- 记录能定位问题的上下文：请求 id、用户 id、关键参数（脱敏后）。
- 不打印令牌、密码、身份证、手机号、银行卡，不打印完整请求头。
- 错误日志带堆栈，业务日志带结果。

### 检查清单
- [ ] 每个入口都做了输入校验，错误信息指明字段
- [ ] 鉴权 + 资源归属校验都在
- [ ] 列表接口有分页上限
- [ ] 写接口考虑过重复提交
- [ ] 外部调用都有超时，重试有上限
- [ ] 数据变更向后兼容，附迁移与回滚
- [ ] 日志没有敏感信息
- [ ] 新逻辑有单元或集成测试，且断言了真实行为

### 常见错误
- 只校验"必填"，不校验类型和长度
- 按 id 查资源却不校验归属，改个 id 就能看别人的数据
- 迁移脚本只能在新库上跑
- 测试只断言状态码 200，不断言返回内容` },
  { id: "devops-release", name: "发布与运维", description: "修改 CI、容器、部署脚本、监控时使用", instructions: `## 发布与运维

### 什么时候用
修改 CI、容器、部署脚本、环境变量、监控告警时。

### 发布前
1. **能回滚**：写清楚回滚命令或操作步骤，并在发布前验证过回滚本身可用。
2. **可观测**：新增服务要有健康检查；关键路径要有日志和至少一个指标。
3. **配置外置**：环境相关的值（地址、端口、开关）走环境变量或配置中心，不写死。
4. **密钥**：只通过环境变量、密钥管理或 CI secret 注入；不写进仓库、不被 Hub 写进工作目录的配置文件。
5. **迁移先行**：有数据库变更时，先发布兼容双版本的迁移，再发布代码。

### 发布中
- 小步发布：一次只改一件事，便于定位问题。
- 灰度或分批：先小流量，观察错误率和延迟，再全量。
- 记录发布版本、时间、操作人、变更内容。

### 发布后
- 验证核心路径（不是只看进程起来了）。
- 观察 10 分钟关键指标：错误率、延迟、资源占用。
- 确认无误后再清理旧的兼容代码与开关。

### CI 配置
- 缓存依赖但不要在缓存里存密钥。
- 失败要能定位：日志分行、步骤命名清楚。
- 测试与构建分离，测试失败不产出制品。
- 不要把 CI 凭证暴露给 PR 构建（尤其是来自 fork 的 PR）。

### 检查清单
- [ ] 回滚步骤写过并演练过
- [ ] 健康检查存在且能反映真实可用性
- [ ] 新增配置都有默认值或启动时校验
- [ ] 密钥不在仓库、不在日志、不在镜像层里
- [ ] 数据库变更向后兼容，先于代码发布
- [ ] 有灰度或分批策略
- [ ] 发布后验证了核心路径

### 常见错误
- "回滚就是把上一个镜像拉回来"，但数据库迁移没回滚
- 健康检查只返回 200，不检查依赖是否可用
- 把密钥作为构建参数写进镜像历史
- 全量发布后再看监控` },
  { id: "code-review", name: "代码评审", description: "审查代码改动、合并 PR 前使用", instructions: `## 代码评审

目标是找出会导致线上问题或返工的缺陷，不是表达风格偏好。

### 什么时候用
审查别人（或智能体）提交的改动、合并 PR 前。

### 顺序（按发现缺陷的性价比）
1. **需求对不对**：改动是否真的解决了验收标准里的问题，有没有少做或多做。
2. **会坏吗**：空值、异常、边界、并发、时区、精度、字符集。
3. **影响别人吗**：调用方、序列化格式、数据库结构、缓存 key、公开接口。
4. **测了吗**：关键路径有测试吗，测试真的会失败吗（把实现改坏测试会不会红）。
5. **能维护吗**：命名、重复、过度抽象。放最后，且不要阻塞合并。

### 每条意见要包含
- **位置**：文件:行号
- **问题**：具体会发生什么，什么输入会触发
- **依据**：为什么这是问题（规范、既有约定、复现步骤）
- **建议**：怎么改，给一段可以直接用的代码或做法

### 分级
- **阻塞**：会导致数据错误、安全漏洞、线上故障、破坏兼容
- **建议**：可维护性、性能优化、更清晰的写法
- **提问**：不确定意图，请作者说明

### 检查清单
- [ ] 对照验收标准逐条确认
- [ ] 空/无/超长/并发/重复提交都想过
- [ ] 错误路径有处理，不是只处理成功
- [ ] 公开接口与数据格式的变化对调用方兼容
- [ ] 测试断言了行为，不是只跑通
- [ ] 没有新增硬编码的密钥、地址、魔法数字
- [ ] 日志与错误信息不含敏感数据

### 输出模板
\`\`\`
## 结论
<可合并 / 需修改后合并 / 需要重新设计>

## 阻塞项
1. \`path/file.ts:42\` — <问题>。触发条件：<输入>。建议：<改法>

## 建议项
- …

## 已确认
- 验收标准 1：已满足（依据）
\`\`\`

### 常见错误
- 只挑格式问题，漏掉并发和错误路径
- 意见只说"这里不太好"，不说会怎么坏
- 把个人风格当阻塞项
- 没跑过代码就给结论` },
  { id: "security-review", name: "安全审查", description: "改动涉及鉴权、支付、密钥、外部输入时使用", instructions: `## 安全审查

### 什么时候用
改动涉及鉴权、支付、密钥、文件上传、外部输入、反序列化、SQL/命令拼接时。不确定时按"要审"处理。

### 审查项（按真实利用可能性排序）

**1. 越权（最常见也最致命）**
- 每个接口是否校验了身份
- 是否校验了资源归属，而不只是"存在"
- 有没有"管理员接口只靠前端隐藏按钮"的情况
- 批量接口能否通过改 id 读到别人的数据

**2. 注入**
- SQL：是否全部参数化。字符串拼接即高危。
- 命令：\`exec\` 拼接用户输入。用参数数组，不用 shell 字符串。
- 路径穿越：\`../\` 能否逃出目标目录；符号链接是否解析后校验。
- XSS / 模板注入：用户输入是否进入 HTML 或模板。
- SSRF：服务端按用户给的 URL 发请求时，是否限制内网地址与协议。

**3. 敏感信息**
- 密钥、令牌是否出现在代码、仓库、日志、错误信息、前端 bundle
- 日志是否打印了身份证、手机号、银行卡、完整请求头
- 错误堆栈是否返回给客户端
- 备份与临时文件是否包含明文密钥

**4. 支付与金额**
- 金额用整数最小单位，不用浮点
- 回调必须验签，且校验金额与订单号
- 重复回调是否幂等
- 客户端传来的金额是否被服务端覆盖

**5. 依赖与配置**
- 新增依赖的来源、维护状态、已知漏洞
- CORS 是否放开了 \`*\` 且带凭证
- 会话 Cookie 是否 HttpOnly、SameSite、Secure
- 限流是否只在前端做
- 默认密码、调试接口、示例数据是否被带上线

### 检查清单
- [ ] 每个入口有身份校验 + 归属校验
- [ ] 所有 SQL 参数化，没有字符串拼接
- [ ] 命令执行用参数数组，用户输入不进入 shell 解释
- [ ] 文件路径解析后校验在允许目录内
- [ ] 用户输入进 HTML 前转义
- [ ] 服务端请求用户的 URL 时做了内网黑名单
- [ ] 日志与错误响应无敏感信息
- [ ] 密钥不在仓库、不在镜像、不在前端
- [ ] 支付回调验签且幂等
- [ ] 新增依赖检查过漏洞

### 输出模板
\`\`\`
## 结论
<可上线 / 修复后可上线 / 阻断>

## 风险清单
| 严重程度 | 位置 | 问题 | 利用条件 | 修复建议 |
|---|---|---|---|---|
| 高 | \`api/x.ts:30\` | 未校验归属 | 改 id 即可读他人数据 | 加 ownerId 校验 |

## 已确认安全
- …
\`\`\`

### 常见错误
- 只做关键词扫描，不顺着数据流看
- 把"前端做了校验"当成安全
- 报告里写"存在 SQL 注入风险"，不给具体位置和可复现条件
- 只看新增代码，忽略被改动函数的其他调用方` },
  { id: "test-design", name: "测试设计", description: "需要把需求转成测试用例、判断测够了没有时使用", instructions: `## 测试设计

### 什么时候用
需求要落地成测试用例、或需要判断"测够了没有"时。

### 分层
- **单元**：纯函数、边界计算、状态机。快、多、覆盖分支。
- **集成**：接口 + 数据库 + 外部依赖（用替身）。覆盖事务、鉴权、错误码。
- **端到端**：关键用户路径。少而精，只覆盖"坏了就是事故"的流程。

### 设计步骤
1. **列输入域**：正常值、边界值（0、-1、最大值、超长）、非法类型、空值、重复值。
2. **列状态**：初始、进行中、终态、异常中断、重入。
3. **列组合**：把"角色 × 资源归属 × 状态"做笛卡尔积，挑出有意义的组合（通常 20% 覆盖 80% 风险）。
4. **写期望**：每条用例写清输入、操作、期望结果——期望要具体到字段值，不是"成功"。
5. **补故障注入**：超时、断网、依赖返回 5xx、磁盘满、并发写。

### 必测的几类
- 空与不存在：查不到、列表为空、可选参数不传
- 边界：分页第一页/最后一页/超出范围、长度恰好等于上限
- 权限：无权限、越权、过期令牌
- 并发：同一资源同时修改、重复提交
- 幂等：同一请求发两次，结果一致
- 失败恢复：依赖失败后重试成功；部分失败不留脏数据

### 检查清单
- [ ] 每条验收标准至少有一条用例对应
- [ ] 空、边界、非法输入都有覆盖
- [ ] 权限与越权有正面和反面用例
- [ ] 重复提交与并发有覆盖
- [ ] 失败路径覆盖了，不只是成功路径
- [ ] 期望结果具体到字段，不是"返回成功"
- [ ] 用例之间互不依赖，可任意顺序执行

### 输出模板
\`\`\`
| 编号 | 场景 | 前置 | 操作 | 期望 |
|---|---|---|---|---|
| TC-1 | 正常创建 | 已登录 | 提交合法数据 | 201，返回 id，数据库有记录 |
| TC-2 | 缺必填 | 已登录 | 不传 title | 400，提示 title 必填 |
| TC-3 | 越权读 | 已登录为用户A | 读用户B的资源 | 403，不返回内容 |
\`\`\`

### 常见错误
- 只写"正常流程"用例
- 期望写成"成功"或"返回 200"
- 用例依赖执行顺序
- 不测失败与重试，线上第一次遇到就出事` },
  { id: "web-research", name: "网络调研", description: "需要查资料、核实事实、选型对比时使用", instructions: `## 网络调研

### 什么时候用
需要了解外部事实、选型对比、竞品做法、最新版本与限制时。

### 步骤
1. **先定问题**：把"调研 X"变成 3~5 个可回答的问题。例如"X 的许可协议是什么""X 在 1000 万行数据下的查询延迟"。
2. **优先一手来源**：官方文档、源码、release notes、基准测试的原始数据。二手文章只用来发现线索。
3. **交叉验证**：关键结论至少两个独立来源；版本相关的必须看发布日期，确认不是过期资料。
4. **记录可追溯**：每条结论后面附来源链接和访问日期。
5. **区分事实与判断**：把"官方文档说支持 10 万 QPS"和"我认为它适合我们"分开写。

### 搜索技巧
- 报错信息：去掉变量部分，只搜稳定片段，加引号
- 版本相关问题：带版本号和年份
- 中文资料少时用英文关键词，再回查官方 issue

### 检查清单
- [ ] 每个关键结论都有来源
- [ ] 核对了资料的时效性（版本、年份）
- [ ] 至少有一处交叉验证
- [ ] 明确标出了"没有找到答案"的问题
- [ ] 事实与个人判断分开表述

### 输出模板
\`\`\`
## 问题
1. …

## 结论
**Q1**：<答案>（来源：[标题](url)，2026-11）

## 未确认
- <问题>：只找到二手来源，建议自行验证

## 对我们的影响
<判断，标注为主观>
\`\`\`

### 常见错误
- 拿博客当依据，不看官方文档
- 引用过期版本的结论
- 只给结论不给来源，别人无法复核
- 把营销材料当性能数据` },
  { id: "report-writing", name: "报告撰写", description: "需要向人汇报进展、结论或分析结果时使用", instructions: `## 报告撰写

### 什么时候用
需要向人汇报进展、结论、分析结果时。

### 结构（结论先行）
1. **一句话结论**：读者只读这一句也该知道结果。
2. **关键数字**：3 个以内，直接给对比（"从 800ms 降到 120ms"而不是"性能提升明显"）。
3. **依据**：怎么得出的，数据来源、样本、口径。
4. **风险与未决**：还有什么不确定，谁来定。
5. **下一步**：谁、什么时候、做什么。

### 写作要求
- 每段只讲一件事，第一句就是这段的结论
- 用具体数字和名词，不用"较多""有所改善""尽快"
- 对比要有基准：和上周比、和目标比、和竞品比
- 表格用于并列信息，正文用于因果
- 篇幅控制在一屏能读完；细节放附录

### 检查清单
- [ ] 开头一句话说清了结论
- [ ] 每个判断都有数据或依据支撑
- [ ] 数字带单位和对比基准
- [ ] 风险和未决项单独列出
- [ ] 下一步有负责人和时间
- [ ] 没有"可能""大概""应该差不多"

### 输出模板
\`\`\`
## 结论
<一句话>

## 关键数据
- <指标>：<值>（对比 <基准>）

## 依据
<方法、样本、口径>

## 风险与未决
- <风险> — 影响 <范围>，需要 <谁> 决定

## 下一步
- [ ] <动作> — <负责人> — <时间>
\`\`\`

### 常见错误
- 按时间顺序写流水账，读者看不到结论
- 只报"做了什么"，不报"结果如何"
- 数字没有对比基准，读者无从判断好坏
- 把问题藏在最后一段` },
  { id: "chinese-copy", name: "中文文案规范", description: "撰写界面文案、错误提示、对外说明时使用", instructions: `## 中文文案规范

### 什么时候用
写界面文案、错误提示、通知、文档标题、对外说明时。

### 基本要求
- **说人话**：不用"该""此""予以""进行……操作"。写"删除"不写"执行删除操作"。
- **主谓宾完整**：按钮用动宾（"保存修改"），标题用名词（"工作项详情"），提示用完整句子。
- **术语统一**：同一个概念全文一个词。工作项就叫工作项，不要一会儿叫任务、一会儿叫卡片。
- **中英混排**：中英文之间加空格（"使用 GitHub 登录"）；英文专名保持原样，不翻译品牌名。
- **标点**：中文用全角标点；代码、路径、命令用反引号或等宽字体。

### 错误提示怎么写
三段结构：**发生了什么 → 为什么 → 怎么解决**

- 差：\`Error: ECONNREFUSED\`
- 好：\`连不上模型服务。请检查设置里的 Base URL 是否可访问，或稍后重试。\`

- 差：\`操作失败\`
- 好：\`保存失败：标题不能为空。\`

原则：
- 不把堆栈、英文异常、内部字段名直接展示给用户
- 不写"未知错误"——至少说清哪个操作失败
- 能给出下一步动作就给

### 语气
- 客观陈述，不用感叹号，不用"哦""啦"
- 不用"您"堆砌礼貌，也不用"亲"
- 不用夸张词：超强、极致、秒杀、颠覆
- 承认限制时直接说，不绕

### 长度
- 按钮：2~4 字（"保存""立即创建"）
- 菜单项：2~6 字
- 提示：一句话，不超过 40 字
- 说明段落：三句以内，超过就分点

### 检查清单
- [ ] 没有"进行""予以""相关""该"这类冗余词
- [ ] 同一概念全文用同一个词
- [ ] 中英文之间有空格的排版
- [ ] 错误提示说清了原因和解决办法
- [ ] 按钮是动宾结构，不是名词
- [ ] 没有感叹号和营销词

### 常见错误
- 直译英文文案，出现"点击这里以继续"
- 术语三种叫法混用
- 错误提示直接透出后端原始信息
- 标点中英混用（半角逗号配中文）` },
  { id: "git-pr-workflow", name: "分支与 PR 流程", description: "修改仓库代码、提交与合并 PR 时使用", instructions: `## 分支与 PR 流程

### 什么时候用
准备提交代码、开 PR、合并、回滚时。

### 分支
- 每个工作项一个分支：\`agent/<工作项编号>\`，从主干的默认分支切出
- 不在主干上直接提交；不共用别人的分支
- 提交前先同步主干，减少冲突

### 提交
- 一个提交做一件事；不要把格式化、重命名、功能改动混在一起
- 提交信息写"做了什么 + 为什么"，第一行不超过 50 字
- 不提交：密钥、本地配置、构建产物、调试代码、日志文件
- 提交前自查 \`git status\`，确认没有意外的文件

### PR
标题：\`<编号>: <一句话说明>\`

正文必须包含：
1. **改了什么**——从用户视角，不是文件清单
2. **为什么**——对应的工作项与验收标准
3. **怎么验证**——复现步骤或测试命令，最好附截图
4. **影响面**——是否改接口、数据结构、配置、依赖
5. **回滚方式**——怎么退

### 合并前
- [ ] CI 通过
- [ ] 至少一次代码评审，阻塞项已解决
- [ ] 没有冲突，且是最新主干
- [ ] 影响面已在 PR 里写明
- [ ] 需要迁移的已说明发布顺序

### 合并后
- 验证主干可用（不是只看合并成功）
- 删除临时分支
- 关联的工作项状态同步

### 回滚
- 用 revert 生成反向 PR，不直接改写主干历史
- 回滚 PR 说明里写清回滚原因和影响范围
- 数据变更的回滚单独处理，不能只回滚代码

### 常见错误
- 一个 PR 改十几个不相关的文件，评审无法聚焦
- PR 正文只写"修复 bug"
- 合并后不看主干是否还能跑
- 用 force push 覆盖别人的分支` },
  { id: "issue-triage", name: "Issue 分诊", description: "整理新工作项、判断类型优先级和负责人时使用", instructions: `## Issue 分诊

### 什么时候用
有新工作项进来、或需要判断"这个 bug 归谁、多急"时。

### 步骤
1. **判断类型**：缺陷 / 新功能 / 改进 / 文档 / 技术债。类型决定后续流程。
2. **复现（缺陷必做）**：写清环境、步骤、实际结果、期望结果。复现不了就标注"待补充信息"，不要凭猜测定级。
3. **定位影响面**：影响多少用户、是否阻塞主流程、有没有绕过方式、是否涉及数据或资金。
4. **定优先级**：
   - P1 紧急：主流程不可用、数据错误、安全问题
   - P2 高：核心功能受损但有绕过
   - P3 中：边缘功能、体验问题
   - P4 低：建议类、优化类
5. **指派**：按领域给最合适的角色；跨领域就拆成多个工作项。
6. **补全信息**：缺背景、缺验收标准的，先补齐再进入执行。

### 判断依据
- **是否阻塞**：用户能不能继续用
- **是否可绕过**：有没有临时替代
- **影响范围**：单用户 / 单租户 / 全部
- **是否可逆**：数据错了能不能修回来
- **时效**：有没有硬性时间点

### 检查清单
- [ ] 类型明确
- [ ] 缺陷有复现步骤，或明确标注无法复现
- [ ] 影响面与优先级有依据，不是凭感觉
- [ ] 指派的角色能独立完成，不需要再转手
- [ ] 描述里有验收标准
- [ ] 重复的工作项已合并，关联的已建立

### 常见错误
- 所有新问题都标 P1
- 缺陷没有复现步骤就派给开发
- 一个工作项里塞了三件不相关的事
- 只看标题就定级` },
  { id: "debugging", name: "故障排查", description: "出现报错、超时、数据不对等异常时使用", instructions: `## 故障排查

### 什么时候用
线上或本地出现异常：报错、白屏、超时、数据不对、任务卡住。

### 原则
先确认事实，再猜原因。每次只改一个变量。

### 步骤
1. **说清现象**：什么操作、什么输入、期望什么、实际什么。截图或日志原文，不要转述。
2. **圈定范围**：是全部还是部分用户？一直这样还是偶发？最近有什么变更（发布、配置、依赖升级）？
3. **看第一手证据**：服务端日志、浏览器控制台、网络面板、进程状态、磁盘与内存。不要先看二手总结。
4. **二分定位**：
   - 请求链路：从入口到出口，找出第一个异常的那一段
   - 代码路径：注释掉一半 / 加日志，缩小到函数
   - 变更历史：\`git log\` 找最近的改动，先怀疑它
5. **验证假设**：写一个能证伪的检查（"如果是 X，那么 Y 应该也能观察到"）。不要在没验证前就改代码。
6. **修复与回归**：修完确认原现象消失，同时确认没有引入新问题；补一条能覆盖这个场景的测试。

### 常见根因清单
- 空值 / undefined 访问
- 时区与日期格式
- 并发与竞态、未加锁的读改写
- 连接池耗尽、未释放的文件句柄
- 超时设置过短或没有超时
- 环境变量缺失或类型不对（字符串 "0" 判真）
- 缓存未失效，读到旧数据
- 权限或路径在不同用户下不一致
- 编码问题（UTF-8 / GBK）
- 数据量超过假设（分页失效、内存溢出）

### 检查清单
- [ ] 有可复现的最小步骤
- [ ] 看过原始日志，不是转述
- [ ] 确认了最近变更
- [ ] 假设经过验证，不是直接改代码试
- [ ] 修复后有回归测试
- [ ] 确认没有引入新问题

### 输出模板
\`\`\`
## 现象
<操作 → 实际 → 期望>

## 定位过程
1. 观察到 …
2. 排除 …
3. 确认 …

## 根因
<具体到文件与逻辑>

## 修复
<改了什么，为什么这样能解决>

## 验证
<怎么确认好了>
\`\`\`

### 常见错误
- 同时改五处再看效果，不知道是哪处生效
- 凭经验直接改，不验证假设
- 修复了表象，没找根因
- 修完不补测试，下次同样的问题再来一遍` },
  { id: "test-dispatch", name: "测试分发", description: "改动完成、需要决定用什么方式验证并派发测试时使用", instructions: `## 测试分发

### 什么时候用
代码改动完成，需要决定"用什么方式验证、交给谁验证"时。

**不用在**：纯文档、纯配置注释类改动。

### 按改动范围选验证方式
| 改动范围 | 最低验证 |
|---|---|
| 纯逻辑函数、计算、状态机 | 单元测试 |
| 接口、数据库、鉴权、事务 | 集成测试（含失败与权限用例） |
| 页面、表单、交互 | 端到端或浏览器验收，覆盖空/错/有数据 |
| 部署、CI、容器 | 在分支上跑通一次完整构建与启动 |
| 数据迁移 | 在真实规模的副本上跑一遍，并验证回滚 |

### 分发步骤
1. **定范围**：列出改动的模块与受影响的调用方。
2. **选层次**：上表 + 判断"坏了会不会是事故"。会，就补端到端。
3. **写用例**：具体用例设计见「测试设计」技能。
4. **派发**：把复现步骤、测试数据、期望结果一起给测试执行方；不要只说"测一下"。
5. **收结论**：通过的列通过项，失败的给失败用例编号、实际结果、日志或截图。
6. **判定**：全部关键用例通过才算完成；失败的退回执行阶段修复，并说明是哪个用例。

### 交付给测试方的信息
- 改动说明（用户视角）
- 环境与入口
- 测试数据（含边界值）
- 必测清单与优先级
- 已知限制或未完成的点

### 检查清单
- [ ] 验证层次与改动范围匹配
- [ ] 必测清单包含空、错误、权限、边界
- [ ] 测试方能独立复现，不需要再问
- [ ] 失败用例带编号与实际结果
- [ ] 结论明确：通过 / 不通过 + 原因

### 常见错误
- 只跑了一遍"正常流程"就说通过
- 把"测一下"派出去，不给数据和期望
- 失败用例只说"有问题"，不给复现步骤
- 跳过回归，改动影响了别的功能却没测` },
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
    // 内置技能正文升级过一次（从几条要点扩成完整作业规范）。
    // 只覆盖「仍是旧模板」的行：旧模板最长不到 400 字，被用户改写过的一律保留。
    const SEED_VERSION = 2;
    for (const s of DEFAULT_SKILLS) {
      const cur = this.store.docGet<Skill & { seedVersion?: number }>("skills", s.id);
      if (!cur || cur.seedVersion === SEED_VERSION) continue;
      const untouched = cur.createdBy === "内置" && (cur.instructions ?? "").length < 400;
      if (untouched) this.store.docPut("skills", s.id, { ...s, createdBy: "内置", seedVersion: SEED_VERSION, updatedAt: new Date().toISOString() });
      else this.store.docPut("skills", s.id, { ...cur, seedVersion: SEED_VERSION });
    }
  }
  get(): GlobalSettings {
    const d = defaults();
    const s = this.store.docGet<GlobalSettings>("settings", "global") ?? d;
    return { ...d, ...s, notify: { ...d.notify, ...s.notify }, guard: { ...d.guard, ...s.guard }, budget: { ...d.budget, ...s.budget }, qa: { ...d.qa, ...s.qa }, runtimes: { ...d.runtimes, ...s.runtimes }, concurrency: { ...d.concurrency, ...s.concurrency }, fallback: { ...d.fallback, ...s.fallback } };
  }
  private put(s: GlobalSettings) { this.store.docPut("settings", "global", { id: "global", ...s }); }
  /** 允许前端修改的部分（不含密钥） */
  patch(p: Partial<Pick<GlobalSettings, "defaultModel" | "defaultEffort" | "runtimes" | "budget" | "guard" | "notify" | "qa" | "models" | "concurrency" | "assistantModel" | "fallback">>) {
    const s = this.get();
    for (const k of ["defaultModel", "defaultEffort", "models", "assistantModel"] as const) if (p[k] !== undefined) (s as any)[k] = p[k];
    for (const k of ["runtimes", "budget", "guard", "notify", "qa", "concurrency", "fallback"] as const) if (p[k]) (s as any)[k] = { ...(s as any)[k], ...p[k] };
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
    const viewer = await gh.viewer();
    const repos = await gh.repos();
    this.setSecret("githubToken", token);
    const s = this.get();
    // classic token 显示真实 scope；细粒度令牌没有 scope 头，标成按仓库授权
    const scopes = viewer.scopes && viewer.scopes.length ? viewer.scopes : ["细粒度令牌：权限由选中的仓库决定"];
    s.github = { connected: true, method: "pat", login: viewer.login, scopes, repos, tokenHint: hint(token), connectedAt: new Date().toISOString() };
    this.put(s);
  }
  async refreshGithubRepos() {
    const t = this.githubToken();
    if (!t) return;
    const s = this.get();
    s.github.repos = await new GitHub(() => t).repos();
    this.put(s);
  }
  /** 新建仓库后加进可选列表，不必等手动刷新 */
  addGithubRepo(full: string) {
    const s = this.get();
    if (!s.github?.connected) return;
    s.github.repos = [full, ...(s.github.repos ?? []).filter((r: string) => r !== full)];
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
