/** 首次启动时的初始数据：演示模式写入一组示例项目和工作项（会立即开始执行），正常模式只建一个空项目。 */
import type { Store } from "./db.ts";
import type { Settings } from "./settings.ts";
import type { Work } from "./work.ts";

export function seedDefault(work: Work) {
  work.saveProject({ name: "我的项目", key: "PRJ", description: "第一个项目。可以在项目设置里绑定 GitHub 仓库。" });
}

export async function seedDemo(work: Work, settings: Settings, store: Store) {
  const hub = work.saveProject({ name: "Agent Hub", key: "HUB", description: "多智能体调度平台本身的研发" });
  const web = work.saveProject({ name: "官网改版", key: "WEB", description: "官网文案、页面与 SEO", env: { baseUrl: "https://staging.example.com", preview: "https://web-pr-{pr}.preview.example.com", accounts: ["qa-user-1", "qa-user-2"] } });
  const kb = work.saveProject({ name: "内部知识库", key: "KB", description: "内部文档整理（未绑定仓库）" });
  await work.connectRepo(hub.id, "example/agent-hub");
  await work.connectRepo(web.id, "example/website");
  work.setLead(hub.id, { mode: "autopilot" });
  work.setLead(web.id, { mode: "on_demand" });
  const H = work.proj(hub.id)!;
  H.simRemote = [{ number: 27, title: "调度失败时的重试策略", body: "模型返回 529 时应该指数退避重试。\n\n验收标准：\n- 最多重试 3 次，退避 1s/2s/4s\n- 重试过程写入任务日志", labels: ["bug", "agent"] }];
  H.pendingRemote = 1;
  store.docPut("projects", H.id, H);
  const W = work.proj(web.id)!;
  W.simRemote = [{ number: 44, title: "移动端导航错位", body: "iPhone 尺寸下导航菜单遮挡标题。\n\n验收标准：\n- 375px 宽度下导航不遮挡标题\n- 菜单可正常展开收起", labels: ["bug", "agent"] }];
  W.pendingRemote = 1;
  store.docPut("projects", W.id, W);

  settings.addKnowledge(hub.id, "约定", "TypeScript + Node 原生类型剥离，不使用 enum 和参数属性；导入路径带 .ts 后缀。");
  settings.addKnowledge(hub.id, "架构", "调度核心在 src/runtime.ts；工作项与生命周期在 src/work.ts。");
  settings.addKnowledge(web.id, "约定", "文案遵循「中文文案规范」技能；副标题不超过 20 字。");

  const mk = (projectId: string, title: string, description: string, o: { assignee?: string; priority?: number; labels?: string[]; status?: string } = {}) =>
    work.create({ projectId, title, description, priority: o.priority ?? 3, assignee: o.assignee ?? null, labels: o.labels ?? [], status: o.status }, "我");
  await mk(hub.id, "工作项支持批量导入 CSV", "从 CSV 批量创建工作项。\n\n验收标准：\n- 支持标题、描述、负责人、优先级四列\n- 格式错误的行给出行号提示，其余行照常导入\n- 一次最多 500 行", { assignee: "developer", priority: 2, labels: ["功能"] });
  await mk(hub.id, "2026 向量数据库选型报告", "为知识库检索选型向量数据库。\n\n验收标准：\n- 覆盖 Milvus / Qdrant / pgvector / Weaviate\n- 对比性能、过滤能力、运维成本，给出量化依据\n- 给出推荐方案与理由", { assignee: "researcher", priority: 2, labels: ["调研"] });
  await mk(hub.id, "竞品动态周报自动化", "每周一汇总三家竞品的发布动态。", { labels: ["自动化"], priority: 4 });
  await mk(hub.id, "接入公司知识库 MCP", "让 researcher 能检索内部文档。", { labels: ["基建"], priority: 1, status: "todo" });
  await mk(web.id, "官网首页文案改版", "突出「多智能体协作」卖点，语气专业但不生硬。\n\n验收标准：\n- 主标题 + 副标题 + 3 个卖点\n- 副标题不超过 20 字\n- 移动端 375px 下不换行错位", { assignee: "writer", labels: ["文案"] });
  await mk(web.id, "定价页改版", "三档套餐对比表 + 常见问题。", { assignee: "writer", priority: 2, labels: ["页面"] });
  await mk(kb.id, "梳理知识库目录结构", "按部门 / 主题两级整理现有文档。", { labels: ["整理"] });
}
