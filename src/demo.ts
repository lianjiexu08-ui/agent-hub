/**
 * 写入一批示例调用记录（任务树 + 完整对话记录），用于在面板「调用记录」里查看效果。
 * 用法：node src/demo.ts        （写入 HUB_DB，默认 ./agent-hub.db；可在服务运行时执行）
 *       node src/demo.ts --clear （删除之前写入的示例数据）
 */
import { randomUUID } from "node:crypto";
import type { BetaMessageParam } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { Store } from "./db.ts";
import type { Task, TaskSource, TaskStatus } from "./types.ts";

const DEMO_TAG = "[示例]";
const store = new Store(process.env.HUB_DB ?? "./agent-hub.db");

if (process.argv.includes("--clear")) {
  const n = store.db.prepare(`DELETE FROM tasks WHERE root_id IN (SELECT id FROM tasks WHERE input LIKE ?)`).run(`${DEMO_TAG}%`).changes;
  console.log(`已删除 ${n} 条示例任务`);
  process.exit(0);
}

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
let toolSeq = 0;
const tid = () => `toolu_demo_${++toolSeq}`;

interface Spec {
  agent: string;
  input: string;
  status: TaskStatus;
  source?: TaskSource;
  hops?: number;
  result?: string;
  error?: string;
  turns: number;
  tokens: [number, number];
  start: number; // 多少分钟前开始
  dur: number; // 持续分钟
  messages: (calls: Map<string, string>) => BetaMessageParam[];
  children?: Spec[];
}

/** 先建子任务拿到结果，再生成父任务的对话记录（父对话里引用子任务结果） */
function insert(spec: Spec, parent?: Task): Task {
  const id = randomUUID();
  const task = store.insertTask({
    id,
    agent: spec.agent,
    input: parent ? spec.input : `${DEMO_TAG} ${spec.input}`,
    status: "pending",
    result: null,
    error: null,
    parentId: parent?.id ?? null,
    rootId: parent?.rootId ?? id,
    depth: parent ? parent.depth + 1 : 0,
    hops: spec.hops ?? 0,
    source: spec.source ?? (parent ? "delegate" : "api"),
    issueId: null,
  });
  const results = new Map<string, string>();
  for (const child of spec.children ?? []) {
    const c = insert(child, task);
    results.set(child.agent + ":" + child.input.slice(0, 12), c.result ?? c.error ?? "");
  }
  store.updateTask(id, {
    status: spec.status,
    result: spec.result ?? null,
    error: spec.error ?? null,
    turns: spec.turns,
    inputTokens: spec.tokens[0],
    outputTokens: spec.tokens[1],
  });
  store.saveMessages(id, spec.messages(results));
  store.db
    .prepare(`UPDATE tasks SET created_at = ?, updated_at = ? WHERE id = ?`)
    .run(minutesAgo(spec.start), minutesAgo(spec.start - spec.dur), id);
  return store.getTask(id)!;
}

type Content = NonNullable<BetaMessageParam["content"]>;
const user = (content: Content): BetaMessageParam => ({ role: "user", content });
const ai = (content: Content): BetaMessageParam => ({ role: "assistant", content });
const text = (t: string) => ({ type: "text" as const, text: t });
const call = (id: string, name: string, input: unknown) => ({ type: "tool_use" as const, id, name, input });
const result = (id: string, content: string, isError = false) => ({ type: "tool_result" as const, tool_use_id: id, content, ...(isError ? { is_error: true } : {}) });

// ---------- 1. 总调度：并行委派 + 二级委派 + 联网搜索 ----------
const RESEARCH = "要点（均附来源）：\n1. Milvus：分布式架构，十亿级向量，运维组件较多\n2. Qdrant：Rust 实现，过滤查询强，单机性能好\n3. pgvector：Postgres 扩展，运维最简单，HNSW 下中等规模够用\n4. Weaviate：内置模块化向量化，生态完整\n\n来源：各项目官方文档与 benchmark 页面（2026-10）";
const DIMENSIONS = "| 维度 | 权重 | 说明 |\n|---|---|---|\n| 性能 | 30% | QPS、P99 延迟、召回率 |\n| 过滤能力 | 20% | 标量过滤与向量检索结合 |\n| 扩展性 | 20% | 数据规模、水平扩展 |\n| 运维成本 | 20% | 组件数量、托管选项 |\n| 生态 | 10% | SDK、社区、集成 |";
const REPORT = "# 2026 向量数据库选型报告\n\n**结论**：中小规模（千万级以内）推荐 pgvector；需要复杂过滤选 Qdrant；十亿级再考虑 Milvus。\n\n## 对比\n| 产品 | 性能 | 过滤 | 扩展性 | 运维 |\n|---|---|---|---|---|\n| Milvus | ★★★★ | ★★★ | ★★★★★ | ★★ |\n| Qdrant | ★★★★ | ★★★★★ | ★★★★ | ★★★★ |\n| pgvector | ★★★ | ★★★ | ★★★ | ★★★★★ |\n| Weaviate | ★★★★ | ★★★★ | ★★★★ | ★★★ |";
{
  const [l, r1, r2, w] = [tid(), tid(), tid(), tid()];
  insert({
    agent: "orchestrator",
    input: "调研 2026 年主流向量数据库，并写一份选型对比报告",
    status: "completed",
    result: REPORT,
    turns: 4,
    tokens: [48210, 3920],
    start: 95,
    dur: 9,
    children: [
      {
        agent: "researcher",
        input: "调研 Milvus、Qdrant、pgvector、Weaviate 四个向量数据库的架构、性能和运维特点，每条结论附来源。",
        status: "completed",
        result: RESEARCH,
        turns: 2,
        tokens: [21530, 1180],
        start: 94,
        dur: 5,
        messages: () => {
          const s = "srvtoolu_demo_1";
          return [
            user("调研 Milvus、Qdrant、pgvector、Weaviate 四个向量数据库的架构、性能和运维特点，每条结论附来源。"),
            ai([
              text("先搜索各项目的官方 benchmark 和架构说明。"),
              { type: "server_tool_use", id: s, name: "web_search", input: { query: "Milvus Qdrant pgvector Weaviate benchmark 2026" } } as never,
              { type: "web_search_tool_result", tool_use_id: s, content: [] } as never,
              text(RESEARCH),
            ]),
          ];
        },
      },
      {
        agent: "reviewer",
        input: "列出评估向量数据库的关键维度和权重，整理成表格。",
        status: "completed",
        result: DIMENSIONS,
        turns: 3,
        tokens: [9840, 860],
        start: 94,
        dur: 4,
        children: [
          {
            agent: "writer",
            input: "把下面的评估维度整理成 Markdown 表格：性能、过滤能力、扩展性、运维成本、生态，并给出权重。",
            status: "completed",
            result: DIMENSIONS,
            turns: 1,
            tokens: [2120, 410],
            start: 93,
            dur: 1,
            messages: () => [user("把下面的评估维度整理成 Markdown 表格：性能、过滤能力、扩展性、运维成本、生态，并给出权重。"), ai([text(DIMENSIONS)])],
          },
        ],
        messages: (res) => {
          const c = tid();
          return [
            user("列出评估向量数据库的关键维度和权重，整理成表格。"),
            ai([text("维度我来定，表格交给 writer 整理。"), call(c, "call_agent", { agent: "writer", task: "把下面的评估维度整理成 Markdown 表格：性能、过滤能力、扩展性、运维成本、生态，并给出权重。" })]),
            user([result(c, [...res.values()][0] ?? "")]),
            ai([text(DIMENSIONS)]),
          ];
        },
      },
      {
        agent: "writer",
        input: "根据调研要点和评估维度，写一份结论先行的选型报告，3000 字以内。",
        status: "completed",
        result: REPORT,
        turns: 1,
        tokens: [6930, 1650],
        start: 89,
        dur: 3,
        messages: () => [user("根据调研要点和评估维度，写一份结论先行的选型报告，3000 字以内。"), ai([text(REPORT)])],
      },
    ],
    messages: (res) => {
      const vals = [...res.values()];
      return [
        user(`${DEMO_TAG} 调研 2026 年主流向量数据库，并写一份选型对比报告`),
        ai([text("先看看团队里有哪些智能体。"), call(l, "list_agents", {})]),
        user([result(l, JSON.stringify([{ name: "researcher", description: "调研员" }, { name: "reviewer", description: "审稿人" }, { name: "writer", description: "写手" }], null, 2))]),
        ai([
          text("拆成两部分并行：researcher 负责调研，reviewer 负责定评估维度。"),
          call(r1, "call_agent", { agent: "researcher", task: "调研 Milvus、Qdrant、pgvector、Weaviate 四个向量数据库的架构、性能和运维特点，每条结论附来源。" }),
          call(r2, "call_agent", { agent: "reviewer", task: "列出评估向量数据库的关键维度和权重，整理成表格。" }),
        ]),
        user([result(r1, vals[0]), result(r2, vals[1])]),
        ai([text("资料齐了，交给 writer 成文。"), call(w, "call_agent", { agent: "writer", task: "根据调研要点和评估维度，写一份结论先行的选型报告，3000 字以内。" })]),
        user([result(w, vals[2])]),
        ai([text(REPORT)]),
      ];
    },
  });
}

// ---------- 2. 消息总线触发：writer 发布稿件 → reviewer 审阅 → writer 修改 ----------
{
  const p = tid();
  insert({
    agent: "reviewer",
    input: "总线主题「drafts」收到一条来自 writer 的新消息（#3）：\n\n官网首页文案初稿：让一群智能体，像团队一样协作……",
    status: "completed",
    source: "bus",
    hops: 1,
    result: "已把审阅意见发布到 reviews。",
    turns: 2,
    tokens: [5210, 620],
    start: 60,
    dur: 2,
    messages: () => [
      user(`${DEMO_TAG} 总线主题「drafts」收到一条来自 writer 的新消息（#3）：\n\n官网首页文案初稿：让一群智能体，像团队一样协作……`),
      ai([text("副标题偏长，卖点缺少具体场景。"), call(p, "publish", { topic: "reviews", content: "1. 副标题压到 20 字以内\n2. 每个卖点配一个具体场景\n3. 避免「赋能」等空话" })]),
      user([result(p, "已发布到 reviews（#4）")]),
      ai([text("已把审阅意见发布到 reviews。")]),
    ],
  });
  insert({
    agent: "writer",
    input: "总线主题「reviews」收到一条来自 reviewer 的新消息（#4）：\n\n1. 副标题压到 20 字以内……",
    status: "completed",
    source: "bus",
    hops: 2,
    result: "终稿：\n主标题：让一群智能体，像团队一样协作\n副标题：拆解、派活、验收，一站完成。",
    turns: 1,
    tokens: [3880, 290],
    start: 57,
    dur: 1,
    messages: () => [
      user(`${DEMO_TAG} 总线主题「reviews」收到一条来自 reviewer 的新消息（#4）：\n\n1. 副标题压到 20 字以内……`),
      ai([text("终稿：\n主标题：让一群智能体，像团队一样协作\n副标题：拆解、派活、验收，一站完成。")]),
    ],
  });
}

// ---------- 3. 工作项触发：按生命周期推进（report_phase） ----------
{
  const ids = Array.from({ length: 6 }, tid);
  const phases: [string, string, string][] = [
    ["understand", "pass", "需要 QPS、召回率、内存三项指标，注明来源"],
    ["plan", "pass", "先查官方 benchmark，再用 ann-benchmarks 交叉验证"],
    ["do", "pass", "整理出 3 个产品的指标表"],
    ["test", "fail", "pgvector 的内存数据缺少来源"],
    ["do", "pass", "补充 pgvector 官方文档中的内存估算公式与链接"],
    ["test", "pass", "所有数据可追溯，单位统一"],
  ];
  const msgs: BetaMessageParam[] = [
    user(`${DEMO_TAG} 你被分配了工作项 HUB-2：收集主流向量数据库的性能基准\n\n## 描述\n汇总公开 benchmark（QPS、召回率、内存占用），注明来源。\n\n请按生命周期推进：需求理解 → 计划 → 执行 → 测试 → 评审，每个阶段结束时调用 report_phase。`),
  ];
  phases.forEach(([phase, res, note], n) => {
    msgs.push(ai([text(n === 4 ? "测试没通过，回到执行修复。" : ""), call(ids[n], "report_phase", { phase, result: res, note })].filter((b) => b.type !== "text" || b.text)));
    const next = res === "fail" ? "回到「执行」修复" : ["进入「计划」", "进入「执行」", "进入「测试」", "", "进入「测试」", "进入「评审」"][n];
    msgs.push(user([result(ids[n], `已记录「${phase}」：${res === "pass" ? "通过" : "不通过"}。${next}`)]));
  });
  const rv = tid();
  msgs.push(ai([call(rv, "report_phase", { phase: "review", result: "pass", note: "满足全部验收标准" })]));
  msgs.push(user([result(rv, "生命周期完成。请输出最终交付内容，它会作为评论写回工作项。")]));
  msgs.push(ai([text("## 性能基准汇总\n\n| 产品 | QPS（1M·768d） | Recall@10 |\n|---|---|---|\n| Milvus | ~2,400 | 0.95 |\n| Qdrant | ~1,900 | 0.97 |\n| pgvector (HNSW) | ~800 | 0.94 |")]));
  insert({
    agent: "researcher",
    input: "你被分配了工作项 HUB-2：收集主流向量数据库的性能基准",
    status: "completed",
    source: "issue",
    result: "## 性能基准汇总（略）",
    turns: 8,
    tokens: [36400, 2210],
    start: 40,
    dur: 12,
    messages: () => msgs,
  });
}

// ---------- 4. 失败：模型过载 ----------
insert({
  agent: "writer",
  input: "写一段 200 字的产品介绍，面向技术负责人。",
  status: "failed",
  error: "Claude API error 529: Overloaded",
  turns: 0,
  tokens: [0, 0],
  start: 30,
  dur: 1,
  messages: () => [user(`${DEMO_TAG} 写一段 200 字的产品介绍，面向技术负责人。`)],
});

// ---------- 5. 工具出错后自行恢复 ----------
{
  const [a, b] = [tid(), tid()];
  insert({
    agent: "orchestrator",
    input: "让 translator 把首页文案翻成英文",
    status: "completed",
    result: "Let a team of agents work like a real team — plan, delegate, review, all in one place.",
    turns: 3,
    tokens: [8120, 540],
    start: 20,
    dur: 2,
    children: [
      {
        agent: "writer",
        input: "把这句中文翻译成英文：拆解、派活、验收，一站完成。",
        status: "completed",
        result: "Plan, delegate, review — all in one place.",
        turns: 1,
        tokens: [1210, 60],
        start: 19,
        dur: 1,
        messages: () => [user("把这句中文翻译成英文：拆解、派活、验收，一站完成。"), ai([text("Plan, delegate, review — all in one place.")])],
      },
    ],
    messages: () => [
      user(`${DEMO_TAG} 让 translator 把首页文案翻成英文`),
      ai([call(a, "call_agent", { agent: "translator", task: "把首页文案翻成英文" })]),
      user([result(a, "智能体 translator 不存在，先用 list_agents 查看", true)]),
      ai([text("没有 translator，改由 writer 翻译。"), call(b, "call_agent", { agent: "writer", task: "把这句中文翻译成英文：拆解、派活、验收，一站完成。" })]),
      user([result(b, "Plan, delegate, review — all in one place.")]),
      ai([text("Let a team of agents work like a real team — plan, delegate, review, all in one place.")]),
    ],
  });
}

// ---------- 6. 被取消：父任务取消后子任务一并取消 ----------
{
  const c = tid();
  insert({
    agent: "orchestrator",
    input: "持续监控三家竞品的发布动态，每小时汇总一次",
    status: "cancelled",
    error: "cancelled",
    turns: 1,
    tokens: [4410, 380],
    start: 8,
    dur: 3,
    children: [
      {
        agent: "researcher",
        input: "抓取三家竞品官网 changelog 的最新条目。",
        status: "cancelled",
        error: "cancelled",
        turns: 0,
        tokens: [0, 0],
        start: 7,
        dur: 2,
        messages: () => [user("抓取三家竞品官网 changelog 的最新条目。")],
      },
    ],
    messages: () => [
      user(`${DEMO_TAG} 持续监控三家竞品的发布动态，每小时汇总一次`),
      ai([text("先让 researcher 抓取最新动态。"), call(c, "call_agent", { agent: "researcher", task: "抓取三家竞品官网 changelog 的最新条目。" })]),
    ],
  });
}

console.log("已写入 6 组示例调用记录。打开面板「调用记录」查看；node src/demo.ts --clear 可删除。");
