/**
 * 工作项服务：项目（工作空间）、工作项、评论、生命周期、项目负责人、安全护栏、预算、项目知识。
 *
 * 生命周期：需求理解 → 计划 → 执行 → 测试 → 评审。
 * - 智能体每完成一个阶段调用 report_phase；Hub 校验顺序并决定下一步
 * - 需求不够具体时，report_phase(understand) 会挂起，直到人确认需求
 * - 执行完成后，Hub 把验收交给测试队列，report_phase(do) 挂起到测试结果出来
 * - 测试不通过回到执行修复；评审不通过重新理解需求（新一轮）；最多 3 轮
 * 人只参与需求确认与最终验收，其余由 AI（含项目负责人）完成。
 */
import { z } from "zod";
import type { Store } from "./db.ts";
import type { Runtime } from "./runtime.ts";
import type { HubEvent, Task } from "./types.ts";
import { assessRequirement } from "./quality.ts";
import { byPriority, priorityRank } from "./priority.ts";
import { pickDevRole } from "./roles.ts";
import type { Notifier } from "./notify.ts";
import type { Settings } from "./settings.ts";
import type { CiStatus, GitHub } from "./github.ts";
import { pickState, statusForStateType, type Linear, type LinearState } from "./linear.ts";
import type { Workspace } from "./workspace.ts";

export const PHASES = ["understand", "plan", "do", "test", "review"] as const;
export type Phase = (typeof PHASES)[number];
export const PHASE_LABEL: Record<string, string> = { understand: "需求理解", plan: "计划", do: "执行", test: "测试", review: "评审" };
const STATUS_LABEL: Record<string, string> = { backlog: "待规划", todo: "待办", in_progress: "进行中", in_review: "待审核", done: "完成", canceled: "已取消" };
const PRIORITY_LABEL = ["无优先级", "紧急", "高", "中", "低"];
const MAX_CYCLES = 3;
const MAX_FIXES = 3;
const ME = "我";
const TERMINAL = new Set(["completed", "failed", "cancelled"]);
const now = () => new Date().toISOString();

export interface PhaseRec { cycle: number; phase: Phase; result: "active" | "pass" | "fail" | "blocked" | "cancelled"; note: string; startedAt: string; endedAt: string | null; qaRun?: string }
export interface PR { number: number; branch: string; state: "open" | "merged" | "closed" | "reverted"; checks: "pending" | "passing" | "failing"; tests: string | null; additions: number; deletions: number; /** GitHub 上的真实 CI 结果（PR 最新提交） */ ci?: CiStatus | null; /** 锁文件等生成文件的改动（不计入 additions / deletions） */ generated?: { files: number; lines: number }; files: number; reviewed?: boolean; guard?: string | null; mergedAt?: string; revert?: number; simulated?: boolean }
export interface Issue {
  id: number; projectId: string; number: number; title: string; description: string; status: string; priority: number;
  assignee: string | null; labels: string[]; parentId: number | null; createdBy: string; createdAt: string; updatedAt: string;
  github: { number: number; state: "open" | "closed"; syncedAt: string; /** 是否已打上「待审核」标签 */ reviewed?: boolean } | null;
  /** creator / assignee 是 Linear 侧的真名，只读镜像：Hub 的 assignee 是智能体名，两者不能互相覆盖 */
  linear: { id: string; identifier: string; url: string; state: "open" | "closed"; stateId?: string; priority?: number; syncedAt: string; localStatus?: string; creator?: { id: string; name: string } | null; assignee?: { id: string; name: string } | null;
    /** 自动执行记录：claimed = 当前的智能体指派来自自动执行；fired = 本次进入范围已触发过（离开范围后清零）；warned = 运行中离开范围已提示过 */
    auto?: { claimed?: boolean; fired?: boolean; warned?: boolean } } | null;
  pr: PR | null; phases: PhaseRec[]; cycle: number; phase: Phase | null;
  blocked: string[] | null; reqConfirmed?: boolean; budgetHold?: boolean; lifecycleDone?: boolean;
  /** 依赖的工作项 id：全部完成（或 PR 已合并）后才会开始执行 */
  dependsOn?: number[];
  /** 因基础设施原因（重启、运行失败、提前收工）中断时所在的阶段：下次运行从这里继续，不新开一轮 */
  resumeFrom?: Phase | null;
  /** 因 CI 未通过被自动交回开发智能体的次数（上限 2） */
  ciFixes?: number;
  /** 因与主干冲突被自动交回开发智能体的次数（上限 2） */
  mergeFixes?: number;
  /** 人已经批准合并（点了合并，只是因为冲突没合进去）：解决冲突后测试与 CI 通过就直接合并，不再要人二次审核 */
  mergeApproved?: { by: string; at: string } | null;
  /** 正在等依赖（已提示过），依赖满足后自动开始 */
  waitingDeps?: boolean;
  /** 因「空闲时重启」被挂起，重启后自动开始 */
  waitingRestart?: boolean;
}
export interface Comment { id: number; issueId: number; author: string; kind: "user" | "agent" | "lead" | "system"; body: string; runId: string | null; createdAt: string }
export interface Lead { agent: string; mode: "off" | "on_demand" | "autopilot"; duties: { flow: boolean; review: boolean; bugs: boolean; testing: boolean }; mergePolicy: "auto" | "manual"; dailyRuns: number; runsToday: number; runsDay?: string; activity: { at: string; text: string }[] }
export interface LinearBinding {
  teamId: string; teamKey: string; teamName: string;
  mode: "two_way" | "import" | "push" | "off";
  importScope: "all" | "label"; importLabel: string;
  pushNew: boolean; postDeliverable: boolean;
  lastSyncAt: string | null; pendingRemote: number;
  /** 自动执行范围：哪些 Linear issue 不用人指派就交给智能体。缺省 = 不自动 */
  autoRun?: LinearAutoRun;
  /**
   * 上次与 Linear 对齐时 Hub 这边的状态。
   * 判断"要不要回推"只看它：本地状态没变就不推。
   * 之前用 stateId 比对，而 started 类型下 In Progress / In Review 会互相串，
   * 导致刚导入或刚恢复的 issue 被降级。
   */
  localStatus?: string;
}
export interface Project {
  id: string; name: string; key: string; description: string; createdAt: string; nextNumber: number;
  repo: { fullName: string; defaultBranch?: string } | null;
  sync: {
    mode: "two_way" | "import" | "push" | "off"; importScope: "all" | "label"; importLabel: string; pushNew: boolean; postDeliverable: boolean;
    /** 工作项来源：从哪个系统导入。github = 仓库 issue，linear = Linear 团队 issue，both = 两边都导，manual = 只手动创建 */
    source?: "github" | "linear" | "manual";
  };
  linear: LinearBinding | null;
  lastSyncAt: string | null; pendingRemote: number; lead: Lead;
  /** previewCmd：在工作项 worktree 里启动本分支预览的命令（拿到 PREVIEW_PORT / PREVIEW_API_PORT / HUB_ISSUE_SLUG），用于浏览器验收 */
  env: { baseUrl: string; preview: string; accounts: string[]; previewCmd?: string };
  /** 演示模式下模拟的远端 issue */
  simRemote?: { number: number; title: string; body: string; labels: string[] }[];
  simGhNext?: number;
}

export class WorkError extends Error {
  status: number;
  constructor(m: string, status = 400) { super(m); this.status = status; }
}

/**
 * Linear issue 的自动执行范围。
 * - scope：off 不自动（要人在 Hub 里指派）；all 团队里所有 issue；assignees 只做指派给这些 Linear 成员的
 * - states：issue 处于哪些状态时才接手（Hub 状态名，对应 Linear 的 Backlog / Todo / In Progress），默认只认 todo
 */
export interface LinearAutoRun { scope: "off" | "all" | "assignees"; assignees: { id: string; name: string }[]; states: string[] }
export const LINEAR_AUTO_STATES = ["backlog", "todo", "in_progress"] as const;
const normalizeAutoRun = (a?: Partial<LinearAutoRun> | null): LinearAutoRun => ({
  scope: a?.scope === "all" || a?.scope === "assignees" ? a.scope : "off",
  assignees: (Array.isArray(a?.assignees) ? a.assignees : []).filter((x) => x && typeof x.id === "string" && x.id).map((x) => ({ id: x.id, name: String(x.name ?? x.id) })),
  states: Array.isArray(a?.states) ? [...new Set(a.states.filter((s) => (LINEAR_AUTO_STATES as readonly string[]).includes(s)))] : ["todo"],
});

const defaultLinear = (team: { id: string; key: string; name: string }): LinearBinding => ({ teamId: team.id, teamKey: team.key, teamName: team.name, mode: "two_way", importScope: "all", importLabel: "agent", pushNew: true, postDeliverable: true, lastSyncAt: null, pendingRemote: 0 });
/** 增量同步的起点：上次同步时间往前留 2 分钟重叠，防止时钟偏差漏掉变更（重复的会被去重） */
/**
 * Linear 状态 → Hub 状态。started 要区分「进行中」和「待审核」，
 * statusForStateType 对 started 返回 null（那是给"只推不拉"的老逻辑用的），
 * 拉回时必须补上，否则远端从 Backlog 恢复成 In Review 时本地永远停在待规划。
 */
export function remoteStatusOf(st?: { type?: string; name?: string } | null): "backlog" | "todo" | "in_progress" | "in_review" | "done" | "canceled" | null {
  switch (st?.type) {
    case "triage":
    case "backlog": return "backlog";
    case "unstarted": return "todo";
    case "started": return /review|审核|reviewed/i.test(st.name ?? "") ? "in_review" : "in_progress";
    case "completed": return "done";
    case "canceled": return "canceled";
    default: return null;
  }
}

const sinceFor = (iso: string | null | undefined) => (iso ? new Date(new Date(iso).getTime() - 120_000).toISOString() : null);
const defaultLead = (mode: Lead["mode"] = "off"): Lead => ({ agent: "project-lead", mode, duties: { flow: true, review: true, bugs: true, testing: true }, mergePolicy: "auto", dailyRuns: 20, runsToday: 0, activity: [] });

export interface QAPort {
  enqueue(issue: ReturnType<Work["view"]>, trigger: string): string;
  wait(runId: string, signal?: AbortSignal): Promise<{ passed: boolean; note: string; cases: number }>;
  runsFor(key: string): { id: string; status: string; cases: { status: string | null }[] }[];
}

export class Work {
  private store: Store;
  private runtime: Runtime;
  private notify: Notifier;
  private settings: Settings;
  private github: GitHub;
  private linear: Linear;
  private workspace: Workspace;
  /** Linear 工作流状态缓存（按团队，5 分钟） */
  private linearStates = new Map<string, { at: number; states: LinearState[] }>();
  qa: QAPort | null = null;
  readonly simulate: boolean;
  /** 等待人确认需求的挂起调用 */
  private confirmWaiters = new Map<number, (answer: string) => void>();
  /** 正在准备 worktree 的工作项，防止重复启动 */
  private preparing = new Set<number>();
  /** 续跑提醒次数（按任务） */
  private nudges = new Map<string, number>();

  constructor(store: Store, runtime: Runtime, deps: { notify: Notifier; settings: Settings; github: GitHub; linear: Linear; workspace: Workspace; simulate: boolean }) {
    this.store = store;
    this.runtime = runtime;
    this.notify = deps.notify;
    this.settings = deps.settings;
    this.github = deps.github;
    this.linear = deps.linear;
    this.workspace = deps.workspace;
    this.simulate = deps.simulate;
    runtime.events.on("event", (e: HubEvent) => {
      if (e.type === "task" && e.task.issueId != null && e.task.parentId === null && TERMINAL.has(e.task.status)) {
        // 收尾（交付评论、负责人审核、等 CI、合并）是异步的：计数，空闲重启要等它处理完
        this.finishing++;
        void this.onRunFinished(e.task).finally(() => { this.finishing--; });
      }
    });
    runtime.setHooks({
      continuation: (task) => this.continuation(task),
      systemExtra: (task, agent) => this.systemExtra(task, agent),
    });
    this.registerTools();
    this.reconcile();
  }

  // ======================= 基础读写 =======================
  private emit(type: string, extra: Record<string, unknown> = {}) { this.runtime.events.emit("event", { type: "work", kind: type, ...extra } as unknown as HubEvent); }
  projectsRaw(): Project[] { return this.store.docList<Project>("projects"); }
  proj(id: string): Project | undefined { return this.store.docGet<Project>("projects", id); }
  private saveProj(p: Project) { this.store.docPut("projects", p.id, p); }
  /**
   * 工作项与评论的快照缓存。
   * view() 会为每个工作项查一次 issues / comments，全表扫描的次数随工作项数量平方增长：
   * 300 个工作项 ≈ 9 万次 JSON 解析，事件循环被占满，连 /health 都要几十秒。
   * 这里一次性读出来分组复用，写操作后立刻失效；再加一个很短的 TTL 兜底，
   * 万一有没覆盖到的写入路径，最多陈旧 250ms。
   */
  private snap: { at: number; issues: Issue[]; comments: Map<number, Comment[]> } | null = null;
  private snapshot() {
    const t = Date.now();
    if (this.snap && t - this.snap.at < 250) return this.snap;
    const issues = this.store.docList<Issue>("issues");
    const comments = new Map<number, Comment[]>();
    for (const c of this.store.docList<Comment>("comments")) {
      const arr = comments.get(c.issueId);
      if (arr) arr.push(c); else comments.set(c.issueId, [c]);
    }
    this.snap = { at: t, issues, comments };
    return this.snap;
  }
  private invalidate() { this.snap = null; }
  private issues(): Issue[] { return this.snapshot().issues; }
  private getIssue(id: number): Issue | undefined { return this.store.docGet<Issue>("issues", id); }
  private save(i: Issue) { i.updatedAt = now(); this.store.docPut("issues", i.id, i); this.invalidate(); }
  key(i: Issue) { return `${this.proj(i.projectId)?.key ?? "?"}-${i.number}`; }
  private comments(issueId: number): Comment[] { return this.snapshot().comments.get(issueId) ?? []; }
  find(ref: string | number): Issue {
    let i: Issue | undefined;
    if (typeof ref === "number" || /^\d+$/.test(String(ref))) i = this.getIssue(Number(ref));
    else {
      const m = /^([A-Za-z][A-Za-z0-9]*)-(\d+)$/.exec(String(ref).trim());
      const p = m && this.projectsRaw().find((x) => x.key.toUpperCase() === m[1].toUpperCase());
      i = p ? this.issues().find((x) => x.projectId === p.id && x.number === Number(m![2])) : undefined;
    }
    if (!i) throw new WorkError(`工作项 ${ref} 不存在`, 404);
    return i;
  }
  addComment(issueId: number, author: string, kind: Comment["kind"], body: string, runId: string | null = null): Comment {
    const c: Comment = { id: this.store.nextSeq("comment"), issueId, author, kind, body, runId, createdAt: now() };
    this.store.docPut("comments", c.id, c);
    this.invalidate();
    return c;
  }
  private runsOf(issueId: number): Task[] { return this.store.listTasks({ issueId, rootsOnly: true, limit: 200 }).reverse(); }
  private activeRun(issueId: number): Task | undefined { return this.runsOf(issueId).find((t) => !TERMINAL.has(t.status)); }

  /**
   * 工作项视图。
   * 列表场景（看板、/api/state）只给描述摘要：仓库导入的 issue 正文常有几 KB，
   * 几百个工作项全量下发会让每次刷新都传几 MB，拖慢整个页面。
   * 需要完整正文的地方（详情抽屉、智能体读取）传 full。
   */
  view(i: Issue, full = false) {
    const p = this.proj(i.projectId);
    const runs = this.runsOf(i.id);
    const kids = this.issues().filter((x) => x.parentId === i.id && x.status !== "canceled");
    const last = runs.at(-1);
    const q = assessRequirement(i);
    const body = i.description ?? "";
    const deps = (i.dependsOn ?? []).map((id) => this.getIssue(id)).filter((d): d is Issue => !!d)
      .map((d) => ({ key: this.key(d), title: d.title, status: d.status, met: this.depMet(d) }));
    return {
      ...i, key: this.key(i), projectName: p?.name ?? "", projectKey: p?.key ?? "",
      deps, waitingDeps: deps.some((d) => !d.met),
      description: full ? body : body.slice(0, 600),
      descriptionTruncated: !full && body.length > 600,
      descriptionLength: body.length,
      github: i.github && p?.repo ? { ...i.github, url: `https://github.com/${p.repo.fullName}/issues/${i.github.number}`, repo: p.repo.fullName } : null,
      pr: i.pr && p?.repo ? { ...i.pr, url: `https://github.com/${p.repo.fullName}/pull/${i.pr.number}` } : i.pr,
      comments: this.comments(i.id).filter((c) => c.kind !== "system").length,
      runs: runs.length, activeRuns: runs.filter((r) => !TERMINAL.has(r.status)).length, failStreak: this.failStreak(i, runs),
      /** 运行已提交但还在等并发槽位 */
      queued: !!last && last.status === "pending",
      lastRun: last ? { id: last.id, status: last.status === "pending" ? "running" : last.status, error: last.error, agent: last.agent, startedAt: last.createdAt } : null,
      children: { total: kids.length, done: kids.filter((x) => x.status === "done").length },
      cost: runs.reduce((s, r) => s + this.runCost(r), 0),
      quality: q,
    };
  }
  private runCost(t: Task): number {
    return t.cost + this.store.listTasks({ rootId: t.id, limit: 500 }).filter((x) => x.id !== t.id).reduce((s, x) => s + x.cost, 0);
  }

  // ======================= 项目 =======================
  projects() {
    return this.projectsRaw().map((p) => {
      const its = this.issues().filter((i) => i.projectId === p.id);
      return { ...p, simRemote: undefined, counts: { total: its.length, open: its.filter((i) => !["done", "canceled"].includes(i.status)).length, inProgress: its.filter((i) => i.status === "in_progress").length, review: its.filter((i) => i.status === "in_review").length } };
    });
  }
  saveProject(input: { name: string; key: string; description?: string; sync?: Partial<Project["sync"]>; linear?: Partial<LinearBinding> | null; env?: Partial<Project["env"]> }, origId?: string): Project {
    const key = String(input.key ?? "").trim().toUpperCase();
    if (!input.name?.trim()) throw new WorkError("项目名称不能为空");
    if (!/^[A-Z][A-Z0-9]{1,5}$/.test(key)) throw new WorkError("前缀为 2–6 位大写字母或数字，且以字母开头");
    if (this.projectsRaw().some((p) => p.key === key && p.id !== origId)) throw new WorkError(`前缀 ${key} 已被其他项目使用`);
    let p = origId ? this.proj(origId) : undefined;
    if (!p) p = { id: "p_" + Math.random().toString(36).slice(2, 8), name: "", key, description: "", createdAt: now(), nextNumber: 1, repo: null, sync: { mode: "off", importScope: "all", importLabel: "agent", pushNew: true, postDeliverable: true, source: "manual" }, linear: null, lastSyncAt: null, pendingRemote: 0, lead: defaultLead(), env: { baseUrl: "", preview: "", accounts: [] } };
    p.name = input.name.trim();
    p.key = key;
    p.description = input.description ?? p.description;
    if (input.sync) p.sync = { ...p.sync, ...input.sync };
    if (input.env) p.env = { ...p.env, ...input.env };
    if (input.linear !== undefined) {
      p.linear = input.linear === null ? null : { ...(p.linear ?? defaultLinear({ id: "", key: "", name: "" })), ...input.linear };
      if (p.linear?.autoRun) p.linear.autoRun = normalizeAutoRun(p.linear.autoRun);
      if (p.linear?.teamId) this.linearStates.delete(p.linear.teamId);
    }
    this.saveProj(p);
    this.emit("project");
    // 改了自动执行范围：立即按新范围过一遍已导入的 issue，不必等下次同步
    if (input.linear?.autoRun) void this.linearAutoPass(p.id).catch(() => {});
    return p;
  }
  deleteProject(id: string) {
    for (const i of this.issues().filter((x) => x.projectId === id)) this.remove(i.id);
    this.store.docDelete("projects", id);
    this.emit("project");
  }
  async connectRepo(id: string, fullName: string) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(fullName)) throw new WorkError("仓库格式应为 owner/repo");
    if (this.projectsRaw().some((p) => p.id !== id && p.repo?.fullName === fullName)) throw new WorkError(`${fullName} 已绑定其他项目（一个仓库只能绑定一个项目）`);
    const p = this.proj(id)!;
    if (this.github.available()) {
      const info = await this.github.repo(fullName);
      p.repo = { fullName, defaultBranch: info.default_branch };
    } else if (this.simulate) {
      p.repo = { fullName, defaultBranch: "main" };
      p.simRemote = [{ number: 3, title: "README 补充快速开始", body: "新人反馈不知道如何启动。", labels: ["docs", "agent"] }, { number: 5, title: "CI 偶发超时", body: "e2e 测试偶尔超过 10 分钟。", labels: ["bug"] }];
      p.simGhNext = 6;
    } else throw new WorkError("请先在「设置 → GitHub」配置 Token");
    if (p.sync.mode === "off") p.sync.mode = "two_way";
    // 绑定仓库本身就是"要用这个来源"，所以从「仅手动」自动提升；
    // 已经选了 Linear 的不动——绑仓库是为了推代码，不是把 issue 来源改成 GitHub
    if (!p.sync.source || p.sync.source === "manual") p.sync.source = "github";
    p.pendingRemote = p.simRemote?.length ?? 0;
    this.syncLog(id, "ok", `已绑定仓库 ${fullName}`);
    this.saveProj(p);
    this.emit("project");
  }
  /** 新建仓库时可选的归属：自己的账号 + 所在组织 */
  async githubOwners(): Promise<{ login: string; org: boolean }[]> {
    const gh = this.settings.get().github;
    if (this.simulate && !this.github.available()) return [{ login: gh?.login || "demo", org: false }];
    if (!this.github.available()) throw new WorkError("请先在「设置 → 集成」连接 GitHub");
    const [me, orgs] = await Promise.all([this.github.user(), this.github.orgs().catch(() => [] as string[])]);
    return [{ login: me.login, org: false }, ...orgs.map((login) => ({ login, org: true }))];
  }

  /** 新建 GitHub 仓库（带 README 初始化）并绑定到项目 */
  async createRepo(id: string, input: { owner?: string | null; org?: boolean; name: string; private?: boolean; description?: string }) {
    const p = this.proj(id);
    if (!p) throw new WorkError("项目不存在", 404);
    if (p.repo) throw new WorkError(`项目已绑定 ${p.repo.fullName}，先解绑再新建`);
    const name = (input.name ?? "").trim();
    if (!/^[A-Za-z0-9._-]{1,100}$/.test(name) || /^\.+$/.test(name)) throw new WorkError("仓库名只能包含字母、数字、点、横线和下划线，最长 100 个字符");
    let full: string;
    if (this.simulate && !this.github.available()) {
      full = `${input.owner || this.settings.get().github?.login || "demo"}/${name}`;
    } else {
      if (!this.github.available()) throw new WorkError("请先在「设置 → 集成」连接 GitHub");
      try {
        const r = await this.github.createRepo({ org: input.org ? input.owner : null, name, private: input.private !== false, description: input.description ?? p.description });
        full = r.full_name;
      } catch (e) {
        const m = (e as Error).message;
        if (/→ 422/.test(m) && /already exists/i.test(m)) throw new WorkError(`仓库 ${input.owner ? input.owner + "/" : ""}${name} 已存在，换个名字，或直接选择已有仓库绑定`);
        if (/→ (403|404)/.test(m)) throw new WorkError("令牌没有创建仓库的权限：classic token 需要勾选 repo；细粒度令牌需要「All repositories」并给 Administration 读写权限（建到组织下还要组织允许）");
        throw new WorkError(`新建仓库失败：${m}`);
      }
    }
    this.settings.addGithubRepo(full);
    this.syncLog(id, "ok", `已新建仓库 ${full}${input.private === false ? "（公开）" : "（私有）"}`);
    await this.connectRepo(id, full);
    return this.proj(id)!.repo;
  }
  disconnectRepo(id: string) {
    const p = this.proj(id)!;
    this.syncLog(id, "warn", `已解绑仓库 ${p.repo?.fullName}；已关联的工作项保留 GitHub 编号但不再同步`);
    p.repo = null;
    p.sync.mode = "off";
    this.saveProj(p);
    this.emit("project");
  }
  private syncLog(projectId: string, kind: string, text: string) {
    this.store.docPut("synclog", this.store.nextSeq("synclog"), { id: Date.now(), projectId, at: now(), kind, text });
  }
  syncLogOf(projectId: string) { return this.store.docList("synclog").filter((l) => l.projectId === projectId).reverse().slice(0, 30); }
  /**
   * 工作项的权威来源，三选一，互斥。
   * GitHub 绑定只负责代码与 PR，不等于「issue 从 GitHub 来」——两边都导入会让同一件活在板上出现两次，
   * 也说不清哪边改了算数，所以这里不提供 both。老数据里的 both 折算成有 Linear 就用 Linear。
   */
  private sourceOf(p?: Project): "github" | "linear" | "manual" {
    const v = p?.sync.source as string | undefined;
    if (v === "github" || v === "linear" || v === "manual") return v;
    if (v === "both") return p?.linear ? "linear" : "github";
    if (p?.linear) return "linear";
    if (p?.repo) return "github";
    return "manual";
  }
  private fromGithub = (p?: Project) => this.sourceOf(p) === "github";
  private fromLinear = (p?: Project) => this.sourceOf(p) === "linear";

  private sourceLabel(p?: Project) {
    return { github: "GitHub 仓库", linear: "Linear 团队", manual: "仅手动创建" }[this.sourceOf(p)];
  }
  /** 定时任务挑选项目用：同步开着就要跑（导入或推送至少有一边有事做） */
  githubSyncable(p: Project): boolean { return !!p.repo && p.sync.mode !== "off"; }
  linearSyncable(p: Project): boolean { return !!p.linear && p.linear.mode !== "off"; }

  // 推送与导入解耦：来源决定「issue 从哪来」，推送只看同步方向。
  // 手工建的工作项在 Linear 项目里也应该能推到 GitHub，否则绑定仓库对这类项目没有意义。
  private canPush = (p?: Project) => !!p?.repo && (p.sync.mode === "two_way" || p.sync.mode === "push");
  private canImport = (p?: Project) => !!p?.repo && (p.sync.mode === "two_way" || p.sync.mode === "import") && this.fromGithub(p);

  /** 同步：导入 GitHub 新 issue、推送标记需要同步的工作项、对齐 open/closed 状态 */
  /** incremental：只读上次同步后有更新的 issue（定时同步用）；否则全量 */
  async sync(id: string, opts: { incremental?: boolean } = {}): Promise<string> {
    const p = this.proj(id);
    if (!p?.repo) throw new WorkError("项目尚未绑定 GitHub 仓库");
    if (p.sync.mode === "off") throw new WorkError("同步已关闭，请先在同步设置里开启");
    // 来源不是 GitHub 时不导入 issue，但只要开了推送，已关联的工作项状态照样写回
    if (!this.canImport(p) && !this.canPush(p)) throw new WorkError(`工作项来源是「${this.sourceLabel(p)}」，且未开启推送到 GitHub，没有可同步的内容`);
    let imported = 0, skipped = 0, pushed = 0, states = 0, pulled = 0;
    const mine = this.issues().filter((i) => i.projectId === id);
    const hasLinked = mine.some((i) => i.github);
    // 拉回远端的关闭 / 重新打开（只看上次同步后有更新的 issue；没有关联工作项时不必请求）
    if (hasLinked && (this.canImport(p) || this.canPush(p)) && this.github.available()) {
      const changed = await this.github.listIssues(p.repo.fullName, { state: "all", since: sinceFor(p.lastSyncAt) });
      for (const r of changed) {
        const i = mine.find((x) => x.github?.number === r.number);
        if (!i?.github || r.state === i.github.state) continue;
        const to = r.state === "closed" ? (r.state_reason === "not_planned" ? "canceled" : "done") : ["done", "canceled"].includes(i.status) ? "todo" : null;
        i.github = { ...i.github, state: r.state === "closed" ? "closed" : "open", syncedAt: now() };
        if (to) this.applyRemoteStatus(i, to, `GitHub #${r.number} ${r.state === "closed" ? "已关闭" : "被重新打开"}`);
        else this.save(i);
        pulled++;
      }
    }
    if (this.canImport(p)) {
      const remote = this.github.available()
        ? (await this.github.listIssues(p.repo.fullName, opts.incremental ? { state: "open", since: sinceFor(p.lastSyncAt) } : {})).map((r) => ({ number: r.number, title: r.title, body: r.body ?? "", labels: r.labels.map((l) => (typeof l === "string" ? l : l.name)) }))
        : p.simRemote ?? [];
      const keep: typeof remote = [];
      for (const r of remote) {
        if (mine.some((i) => i.github?.number === r.number)) continue;
        if (p.sync.importScope === "label" && !r.labels.includes(p.sync.importLabel)) { skipped++; keep.push(r); continue; }
        const i = this.newIssue(p, { title: r.title, description: r.body, labels: r.labels, priority: r.labels.includes("bug") ? 2 : 0, createdBy: "GitHub 导入" });
        i.github = { number: r.number, state: "open", syncedAt: now() };
        this.save(i);
        this.addComment(i.id, "system", "system", `从 GitHub #${r.number} 导入`);
        imported++;
      }
      if (!this.github.available()) p.simRemote = keep;
      if (!opts.incremental || !this.github.available()) p.pendingRemote = keep.length;
    }
    if (this.canPush(p)) {
      for (const i of this.issues().filter((x) => x.projectId === id)) {
        try { if (await this.pushState(i)) states++; }
        catch (e) { this.reportSyncError(i, `GitHub ${(e as Error).message}`); }
      }
    }
    const fresh = this.proj(id)!;
    fresh.lastSyncAt = now();
    fresh.pendingRemote = p.pendingRemote;
    if (p.simRemote) fresh.simRemote = p.simRemote;
    this.saveProj(fresh);
    const text = `同步完成：导入 ${imported} 个${skipped ? `（${skipped} 个不在导入范围内，已跳过）` : ""}、拉回远端变更 ${pulled} 个、推送 ${pushed} 个、更新状态 ${states} 个`;
    this.syncLog(id, "ok", text);
    this.emit("sync");
    return text;
  }
  private async pushNew(i: Issue): Promise<number | null> {
    const p = this.proj(i.projectId);
    if (!this.canPush(p) || i.github) return null;
    let n: number;
    if (this.github.available()) n = (await this.github.createIssue(p!.repo!.fullName, i.title, i.description, i.labels)).number;
    else { p!.simGhNext = (p!.simGhNext ?? 100) + 1; n = p!.simGhNext; this.saveProj(p!); }
    i.github = { number: n, state: "open", syncedAt: now() };
    return n;
  }
  /**
   * 把状态写回 GitHub。
   * GitHub 只有 open / closed，表达不了「待审核」，所以额外用一个标签（默认 in-review）承载：
   * 进入待审核时打上、离开时摘掉，让 GitHub 侧也能看出这张卡在等评审。
   */
  private async pushState(i: Issue): Promise<string | null> {
    const p = this.proj(i.projectId);
    if (!i.github || !this.canPush(p) || !p?.repo) return null;
    const notes: string[] = [];
    const want = ["done", "canceled"].includes(i.status) ? "closed" : "open";
    if (i.github.state !== want) {
      // 失败时向上抛：由调用方记录，不能悄悄把本地状态标成已同步
      if (this.github.available()) {
        await this.github.setIssueState(p.repo.fullName, i.github.number, want, i.status === "canceled" ? "not_planned" : "completed");
      }
      i.github = { ...i.github, state: want, syncedAt: now() };
      notes.push(want === "closed" ? `↗ 已关闭 GitHub #${i.github.number}${i.status === "canceled" ? "（not planned）" : ""}` : `↗ 已重新打开 GitHub #${i.github.number}`);
    }
    // 待审核标签
    const label = this.settings.get().github.reviewLabel || "in-review";
    const wantReview = i.status === "in_review";
    const hasReview = !!i.github.reviewed;
    if (wantReview !== hasReview && this.github.available()) {
      if (wantReview) await this.github.addLabels(p.repo.fullName, i.github.number, [label]);
      else await this.github.removeLabel(p.repo.fullName, i.github.number, label).catch(() => {});
      i.github = { ...i.github, reviewed: wantReview, syncedAt: now() };
      notes.push(wantReview ? `↗ GitHub #${i.github.number} 标记待审核（${label}）` : `↗ GitHub #${i.github.number} 移除待审核标记`);
    }
    if (!notes.length) { i.github.syncedAt = now(); this.save(i); return null; }
    this.save(i);
    return notes.join("；");
  }

  /** 已经报过的同步错误（按工作项），避免每次运行失败都刷一条评论 */
  private syncWarned = new Map<number, string>();

  private reportSyncError(i: Issue, msg: string) {
    if (this.syncWarned.get(i.id) === msg) return;
    this.syncWarned.set(i.id, msg);
    this.addComment(i.id, "system", "system", `⚠ 状态没能同步到远端：${msg}\n修好权限或配置后，点「同步」或再次修改状态即可重试。`);
    this.syncLog(i.projectId, "warn", `${this.key(i)} 同步失败：${msg}`);
  }

  /**
   * 工作项状态变化后同步到远端（GitHub issue 的 open/closed、Linear 的工作流状态与优先级）。
   * 返回成功提示（用于写进工作项动态）；失败时留下可见记录，不中断本地流程。
   * 注意：由远端事件驱动的状态变更（applyRemoteStatus）不要调用它，否则会来回覆盖。
   */
  private async syncStatusRemote(i: Issue): Promise<string[]> {
    const ok: string[] = [];
    const errs: string[] = [];
    const gh = await this.pushState(i).catch((e) => { errs.push(`GitHub ${(e as Error).message}`); return null; });
    if (gh) ok.push(gh);
    const ln = await this.pushLinearState(i).catch((e) => { errs.push(`Linear ${(e as Error).message}`); return null; });
    if (ln) ok.push(`↗ Linear → ${ln}`);
    if (errs.length) this.reportSyncError(i, errs.join("；"));
    else this.syncWarned.delete(i.id);
    return ok;
  }

  /**
   * 远端（GitHub / Linear）改了状态时更新工作项：不回推、不触发合并；
   * 离开「进行中」会停止当前运行，回到「待办」且已指派时会重新开始执行。
   */
  private applyRemoteStatus(i: Issue, to: string, why: string) {
    const before = i.status;
    if (before === to) { this.save(i); return; }
    i.status = to;
    if (["done", "canceled", "backlog"].includes(to)) { i.phase = null; i.blocked = null; }
    this.save(i);
    this.addComment(i.id, "system", "system", `↙ ${why}：状态 ${STATUS_LABEL[before]} → ${STATUS_LABEL[to]}`);
    const ar = this.activeRun(i.id);
    if (ar && before === "in_progress" && to !== "in_progress") this.runtime.cancel(ar.id);
    this.emit("issue");
    // 自动接手的 issue 已经离开自动执行范围（比如 Linear 上改派给了别人）就不再重启，交给 linearAutoPass 取消指派
    if (to === "todo" && !this.linearAutoOut(this.getIssue(i.id)!)) void this.maybeAutoRun(this.getIssue(i.id)!, "远端同步");
    if (to === "done" || to === "canceled") this.recycle(this.getIssue(i.id), "远端已关闭");
    if (to === "done") this.releaseDependents(i.id);
  }

  // ======================= worktree 回收 =======================
  /** 工作项结束（完成 / 取消 / 删除）且没有在跑的运行时，删除它的 worktree 与本地分支 */
  private recycle(i: Issue | undefined, why: string) {
    if (!i) return;
    const p = this.proj(i.projectId);
    if (!p?.repo) return;
    const key = this.key(i);
    void this.workspace.remove(p, key).then((done) => {
      if (done && this.getIssue(i.id)) this.addComment(i.id, "system", "system", `🧹 已回收工作目录（${why}）`);
    }).catch((e) => this.syncLog(p.id, "warn", `回收 ${key} 的工作目录失败：${e.message}`));
  }
  /** 磁盘占用：按项目列出 worktree、对应工作项状态与可回收量 */
  async diskUsage() {
    const rows: { id: string; name: string; key: string; total: number; reclaimable: number; items: { key: string; bytes: number; mtime: string | null; status: string | null; reclaimable: boolean }[] }[] = [];
    for (const p of this.projectsRaw().filter((x) => x.repo)) {
      const issues = new Map(this.issues().filter((i) => i.projectId === p.id).map((i) => [this.key(i), i]));
      const items = (await this.workspace.usage(p)).map((u) => {
        const i = issues.get(u.key);
        const done = !i || ["done", "canceled"].includes(i.status);
        return { ...u, status: i ? i.status : null, reclaimable: done && !(i && this.activeRun(i.id)) };
      }).sort((a, b) => b.bytes - a.bytes);
      rows.push({
        id: p.id, name: p.name, key: p.key,
        total: items.reduce((s, x) => s + x.bytes, 0),
        reclaimable: items.filter((x) => x.reclaimable).reduce((s, x) => s + x.bytes, 0),
        items,
      });
    }
    return { projects: rows, lastSweep: this.workspace.lastSweep ?? null };
  }

  /** 手动清理：回收所有可回收的 worktree，返回数量与释放的字节数 */
  async cleanWorkspaces() {
    const before = await this.diskUsage();
    const removable = before.projects.flatMap((p) => p.items.filter((x) => x.reclaimable).map((x) => ({ pid: p.id, key: x.key, bytes: x.bytes })));
    let removed = 0, freed = 0;
    for (const r of removable) {
      const proj = this.proj(r.pid);
      if (!proj) continue;
      if (await this.workspace.remove(proj, r.key).catch(() => false)) { removed++; freed += r.bytes; }
    }
    this.workspace.lastSweep = { at: now(), removed };
    if (removed) this.emit("sync");
    return { removed, freed };
  }

  /** 定期清扫：工作项已结束、已删除，或已不存在的 worktree 一并回收。返回回收的数量 */
  async sweepWorkspaces(): Promise<number> {
    let n = 0;
    for (const p of this.projectsRaw().filter((x) => x.repo)) {
      const byKey = new Map(this.issues().filter((i) => i.projectId === p.id).map((i) => [this.key(i), i]));
      for (const key of this.workspace.keys(p)) {
        const i = byKey.get(key);
        const live = i && !["done", "canceled"].includes(i.status);
        if (live || (i && this.activeRun(i.id)) || this.preparing.has(i?.id ?? -1)) continue;
        if (await this.workspace.remove(p, key).catch(() => false)) n++;
      }
    }
    return n;
  }

  // ======================= Linear 同步 =======================
  private canPushLinear = (p?: Project) => !!p?.linear && (p.linear.mode === "two_way" || p.linear.mode === "push");
  private canImportLinear = (p?: Project) => !!p?.linear && (p.linear.mode === "two_way" || p.linear.mode === "import");

  private async linearStatesFor(teamId: string): Promise<LinearState[]> {
    const hit = this.linearStates.get(teamId);
    if (hit && Date.now() - hit.at < 5 * 60_000) return hit.states;
    const states = await this.linear.states(teamId);
    this.linearStates.set(teamId, { at: Date.now(), states });
    return states;
  }

  async connectLinear(id: string, teamId: string) {
    const p = this.proj(id);
    if (!p) throw new WorkError("项目不存在", 404);
    const team = this.settings.get().linear.teams?.find((t) => t.id === teamId);
    if (!team) throw new WorkError("Linear 团队不存在，请先在设置里刷新团队列表");
    if (this.projectsRaw().some((x) => x.id !== id && x.linear?.teamId === teamId))
      throw new WorkError(`${team.name} 已绑定其他项目（一个 Linear 团队只能绑定一个项目）`);
    p.linear = defaultLinear(team);
    // 同上：绑定团队就是选定 Linear 作为 issue 来源
    if (!p.sync.source || p.sync.source === "manual") p.sync.source = "linear";
    this.linearStates.delete(teamId);
    this.saveProj(p);
    this.syncLog(id, "ok", `已绑定 Linear 团队 ${team.name}（${team.key}）`);
    this.emit("project");
  }

  // ---------- 自动执行范围 ----------
  private linearAuto(p?: Project): LinearAutoRun { return normalizeAutoRun(p?.linear?.autoRun); }
  /** 这个 issue 的 Linear 指派人是否在自动执行范围内 */
  private linearWhoOk(A: LinearAutoRun, i: Issue): boolean {
    if (A.scope === "all") return true;
    if (A.scope !== "assignees") return false;
    const who = i.linear?.assignee?.id;
    return !!who && A.assignees.some((x) => x.id === who);
  }
  /** 项目是否启用了自动执行范围（来源含 Linear、同步未关闭、范围不是 off） */
  private linearAutoOn(p?: Project): p is Project { return !!p?.linear && this.fromLinear(p) && p.linear.mode !== "off" && this.linearAuto(p).scope !== "off"; }
  /** 是否允许智能体不经人指派就接手这个工作项。非 Linear 工作项、或项目没启用范围时不限制 */
  private linearAutoAllows(i: Issue): boolean {
    const p = this.proj(i.projectId);
    if (!i.linear || !this.linearAutoOn(p)) return true;
    const A = this.linearAuto(p);
    return this.linearWhoOk(A, i) && A.states.includes(i.status);
  }
  /** 曾被自动接手、现在已不在范围内 */
  private linearAutoOut(i: Issue): boolean { return !!i.linear?.auto?.claimed && !this.linearAutoAllows(i); }

  private autoPassing = new Set<string>();
  /** 跑的过程中又被触发（同步完成、设置又改了）：跑完再补一次，不能丢 */
  private autoPassAgain = new Set<string>();
  /**
   * 按自动执行范围过一遍项目里的 Linear 工作项，返回本次开始执行的数量。
   * - 进入范围（指派人命中 + 状态命中）且还没有智能体：按内容选研发角色，指派并开始执行。每次进入范围只触发一次，
   *   所以你在 Hub 里手动取消指派后不会被反复接回去；在 Linear 上拖出再拖回范围才会重新触发。
   * - 离开范围：还没开跑的取消自动指派；正在跑的不打断，只留一条提示。
   */
  async linearAutoPass(id: string): Promise<number> {
    const p = this.proj(id);
    if (!this.linearAutoOn(p)) return 0;
    if (this.autoPassing.has(id)) { this.autoPassAgain.add(id); return 0; }
    this.autoPassing.add(id);
    let started = 0;
    try {
      const A = this.linearAuto(p);
      const ids = this.issues().filter((x) => x.projectId === id && x.linear?.state === "open").sort(byPriority).map((x) => x.id);
      for (const iid of ids) {
        const i = this.getIssue(iid);
        if (!i?.linear || ["done", "canceled"].includes(i.status)) continue;
        const st = i.linear.auto ?? {};
        const whoOk = this.linearWhoOk(A, i);
        const unstarted = ["backlog", "todo"].includes(i.status);
        const out = !whoOk || (unstarted && !A.states.includes(i.status));
        const who = i.linear.assignee?.name ?? "未指派";
        if (out) {
          if (!st.claimed && !st.fired) continue;
          const running = !!this.activeRun(i.id);
          const why = whoOk ? `状态「${STATUS_LABEL[i.status]}」不在自动执行范围内` : `Linear 指派人（${who}）不在自动执行范围内`;
          if (st.claimed && running && !st.warned) {
            this.addComment(i.id, "system", "system", `⚠ ${why}。当前运行不会被打断，如需停止请手动停止。`);
            st.warned = true;
          } else if (st.claimed && !running && unstarted && i.assignee) {
            this.addComment(i.id, "system", "system", `↩ ${why}，已取消自动指派（${i.assignee}）。`);
            i.assignee = null;
            st.claimed = false;
          }
          st.fired = false;
          i.linear.auto = st;
          this.save(i);
          continue;
        }
        if (!A.states.includes(i.status) || i.assignee || st.fired || this.activeRun(i.id)) continue;
        const agent = pickDevRole(this.store, i, null);
        if (!agent) continue;
        i.assignee = agent;
        i.linear.auto = { claimed: true, fired: true, warned: false };
        this.save(i);
        this.addComment(i.id, "system", "system", `⚡ Linear 自动执行：${A.scope === "all" ? "团队 issue" : `${who} 的 issue`}处于「${STATUS_LABEL[i.status]}」，指派给 ${agent} 并开始执行。`);
        await this.startRun(i, "Linear 自动执行");
        started++;
      }
    } finally { this.autoPassing.delete(id); }
    if (started) this.emit("issue");
    if (this.autoPassAgain.delete(id)) started += await this.linearAutoPass(id);
    return started;
  }

  /** 可选的 Linear 成员：团队成员 + 已导入 issue 上出现过的指派人（API 不可用时只返回后者） */
  async linearMembers(id: string): Promise<{ id: string; name: string }[]> {
    const p = this.proj(id);
    if (!p?.linear) return [];
    const seen = new Map<string, string>();
    for (const m of await this.linear.members(p.linear.teamId).catch(() => [])) seen.set(m.id, m.name);
    for (const i of this.issues()) if (i.projectId === id && i.linear?.assignee && !seen.has(i.linear.assignee.id)) seen.set(i.linear.assignee.id, i.linear.assignee.name);
    for (const a of this.linearAuto(p).assignees) if (!seen.has(a.id)) seen.set(a.id, a.name);
    return [...seen].map(([mid, name]) => ({ id: mid, name })).sort((a, b) => a.name.localeCompare(b.name));
  }

  disconnectLinear(id: string) {
    const p = this.proj(id);
    if (!p) throw new WorkError("项目不存在", 404);
    const name = p.linear?.teamName;
    p.linear = null;
    this.saveProj(p);
    this.syncLog(id, "warn", `已解绑 Linear 团队 ${name ?? ""}；已关联的工作项保留 Linear 编号但不再同步`);
    this.emit("project");
  }

  /** 同步：从 Linear 导入 open issue、把已关联工作项的状态/优先级写回、对齐关闭状态 */
  async syncLinear(id: string, opts: { incremental?: boolean } = {}): Promise<string> {
    const p = this.proj(id);
    if (!p) throw new WorkError("项目不存在", 404);
    const cfg = p.linear;
    if (!cfg) throw new WorkError("项目尚未绑定 Linear 团队");
    if (cfg.mode === "off") throw new WorkError("Linear 同步已关闭，请先在项目设置里开启");
    // 来源不是 Linear 时不导入，但只要开了推送，已关联的工作项照样写回
    if (!this.canImportLinear(p) && !this.canPushLinear(p)) throw new WorkError(`工作项来源是「${this.sourceLabel(p)}」，且未开启推送到 Linear，没有可同步的内容`);
    let imported = 0, skipped = 0, pushed = 0, pulled = 0;
    const mine = this.issues().filter((i) => i.projectId === id);
    const touched = new Set<number>();
    if (this.canImportLinear(p)) {
      const incremental = !!opts.incremental && !!cfg.lastSyncAt;
      const remote = await this.linear.issues(cfg.teamId, incremental ? { updatedAfter: sinceFor(cfg.lastSyncAt) } : {});
      // 已关联的：远端状态或优先级相对上次同步有变化时，以远端为准拉回
      for (const r of remote) {
        const i = mine.find((x) => x.linear?.id === r.id);
        if (!i?.linear) continue;
        // 直接比较「远端状态映射后」与本地状态：只看 stateId 会漏掉
        // stateId 已对齐、但本地 status 落后的历史数据（导入时被写成待规划的那批）
        const remoteStatus = remoteStatusOf(r.state);
        const stateChanged = !!remoteStatus && remoteStatus !== i.status;
        const prioChanged = (r.priority ?? 0) !== (i.linear.priority ?? i.priority);
        // 创建人/指派人只做镜像：以远端为准刷新，缺席（null）就记为 null，
        // 绝不反过来写 Linear——Hub 的 assignee 是智能体，写过去就是把别人的单改成陌生人
        const remoteCreator = r.creator ? { id: r.creator.id, name: r.creator.name } : null;
        const remoteAssignee = r.assignee ? { id: r.assignee.id, name: r.assignee.name } : null;
        const sameWho = (a: { id: string; name: string } | null | undefined, b: { id: string; name: string } | null) =>
          (a?.id ?? null) === (b?.id ?? null) && (a?.name ?? null) === (b?.name ?? null);
        const whoChanged = !sameWho(i.linear.creator, remoteCreator) || !sameWho(i.linear.assignee, remoteAssignee);
        if (!stateChanged && !prioChanged && !whoChanged) continue;
        const notes: string[] = [];
        if (prioChanged && r.priority !== i.priority) { notes.push(`优先级 ${PRIORITY_LABEL[i.priority]} → ${PRIORITY_LABEL[r.priority ?? 0]}`); i.priority = r.priority ?? 0; }
        const closed = r.state?.type === "completed" || r.state?.type === "canceled";
        i.linear = { ...i.linear, stateId: r.state?.id, priority: r.priority ?? 0, state: closed ? "closed" : "open", localStatus: i.status, syncedAt: now(), creator: remoteCreator, assignee: remoteAssignee };
        let to = stateChanged ? remoteStatus : null;
        // 远端回到未开始，但本地正在执行 / 待审核：保留本地进度，不打断
        if (to && ["backlog", "todo"].includes(to) && ["in_progress", "in_review"].includes(i.status)) to = null;
        if (to && to !== i.status) this.applyRemoteStatus(i, to, `Linear ${r.identifier} 变为「${r.state.name}」${notes.length ? `，${notes.join("，")}` : ""}`);
        else {
          this.save(i);
          if (notes.length) this.addComment(i.id, "system", "system", `↙ Linear ${r.identifier}：${notes.join("，")}`);
        }
        touched.add(i.id);
        pulled++;
      }
      for (const r of remote) {
        if (r.state?.type === "completed" || r.state?.type === "canceled") continue;
        if (mine.some((i) => i.linear?.id === r.id)) continue;
        if (cfg.importScope === "label" && !r.labels.includes(cfg.importLabel)) { skipped++; continue; }
        // 导入时必须按远端状态映射本地状态：否则本地默认「待规划」，
        // 紧接着的回推会把 Linear 上原本 Todo / In Progress 的 issue 覆盖成 Backlog。
        const mapped = remoteStatusOf(r.state) ?? "backlog";
        const i = this.newIssue(p, { title: r.title || "(无标题)", description: r.description ?? "", labels: r.labels, priority: r.priority ?? 0, status: mapped, createdBy: "Linear 导入" });
        i.linear = {
          id: r.id, identifier: r.identifier, url: r.url, state: "open", stateId: r.state?.id,
          priority: r.priority ?? 0, localStatus: mapped, syncedAt: now(),
          // 只读镜像：记下 Linear 上的真名，供展示。不写进 i.assignee（那是智能体名），也不回推
          creator: r.creator ? { id: r.creator.id, name: r.creator.name } : null,
          assignee: r.assignee ? { id: r.assignee.id, name: r.assignee.name } : null,
        };
        this.save(i);
        this.addComment(i.id, "system", "system", `从 Linear ${r.identifier} 导入`);
        touched.add(i.id); // 本轮回推跳过，避免把刚导入的状态写回去
        imported++;
      }
    }
    if (this.canPushLinear(p)) {
      for (const i of mine) {
        if (touched.has(i.id)) continue; // 本次刚从远端拉回，不回推
        const cur = this.getIssue(i.id);
        if (cur && await this.pushLinearState(cur).catch(() => null)) pushed++;
      }
    }
    const fresh = this.proj(id)!;
    if (fresh.linear) {
      fresh.linear.lastSyncAt = now();
      if (!opts.incremental) fresh.linear.pendingRemote = skipped;
      this.saveProj(fresh);
    }
    const auto = await this.linearAutoPass(id).catch(() => 0);
    const text = `Linear 同步完成：导入 ${imported} 个${skipped ? `（${skipped} 个不在导入范围内，已跳过）` : ""}、拉回远端变更 ${pulled} 个、写回 ${pushed} 个${auto ? `、自动开始执行 ${auto} 个` : ""}`;
    this.syncLog(id, "ok", text);
    this.emit("sync");
    return text;
  }

  private async pushLinearNew(i: Issue): Promise<string | null> {
    const p = this.proj(i.projectId);
    const cfg = p?.linear;
    if (!cfg || i.linear || !this.canPushLinear(p)) return null;
    const created = await this.linear.createIssue({ teamId: cfg.teamId, title: i.title, description: i.description, priority: i.priority });
    i.linear = { id: created.id, identifier: created.identifier, url: created.url, state: "open", stateId: created.state?.id, priority: i.priority, localStatus: i.status, syncedAt: now() };
    this.save(i);
    this.addComment(i.id, "system", "system", `↗ 已创建 Linear ${created.identifier}`);
    return created.identifier;
  }

  /** 把工作项的状态与优先级写回 Linear；没有变化时返回 null */
  private async pushLinearState(i: Issue): Promise<string | null> {
    const p = this.proj(i.projectId);
    const cfg = p?.linear;
    if (!cfg || !i.linear || !this.canPushLinear(p)) return null;
    const states = await this.linearStatesFor(cfg.teamId);
    const target = pickState(states, i.status);
    if (!target) return null;
    // 以「上次对齐时的本地状态」为准：本地没变就不推，避免把远端状态改回去
    const statusDirty = i.linear.localStatus !== i.status;
    const prioDirty = i.linear.priority !== i.priority;
    if (!statusDirty && !prioDirty) return null;
    if (statusDirty && i.linear.stateId === target.id) {
      // 本地状态变了但目标状态与远端一致：只需记下已对齐，不必请求
      i.linear = { ...i.linear, localStatus: i.status, priority: i.priority, syncedAt: now() };
      this.save(i);
      if (!prioDirty) return null;
    }
    await this.linear.updateIssue(i.linear.id, { stateId: target.id, priority: i.priority });
    const closed = ["done", "canceled"].includes(i.status);
    i.linear = { ...i.linear, stateId: target.id, priority: i.priority, localStatus: i.status, state: closed ? "closed" : "open", syncedAt: now() };
    this.save(i);
    return target.name;
  }

  async pushToLinear(ref: string | number) {
    const i = this.find(ref);
    const p = this.proj(i.projectId);
    if (!p?.linear) throw new WorkError("项目尚未绑定 Linear 团队");
    if (!this.canPushLinear(p)) throw new WorkError("当前同步方向不允许推送到 Linear");
    const id = await this.pushLinearNew(i);
    if (!id) throw new WorkError("这个工作项已经关联了 Linear issue");
    this.emit("issue");
  }

  // ======================= 项目负责人 =======================
  setLead(id: string, patch: Partial<Lead>) {
    const p = this.proj(id)!;
    const before = p.lead.mode;
    p.lead = { ...p.lead, ...patch, duties: { ...p.lead.duties, ...(patch.duties ?? {}) } };
    if (patch.mode && patch.mode !== before) this.leadLog(p, `工作模式：${{ off: "关闭", on_demand: "按需", autopilot: "持续迭代" }[patch.mode]}`);
    this.saveProj(p);
    this.emit("project");
  }
  /** 记录负责人动态并保存项目（p 须是调用方刚读取并修改过的最新对象） */
  private leadLog(p: Project, text: string) {
    p.lead.activity.push({ at: now(), text });
    p.lead.activity.splice(0, Math.max(0, p.lead.activity.length - 50));
    this.saveProj(p);
  }
  leadActivity(id: string) { return (this.proj(id)?.lead.activity ?? []).slice().reverse(); }
  private leadOf(i: Issue): Lead | null { const l = this.proj(i.projectId)?.lead; return l && l.mode !== "off" ? l : null; }

  /** 负责人巡检：分诊 bug；持续迭代模式下提出改进项 */
  async leadTick() {
    const day = new Date().toDateString();
    for (const p of this.projectsRaw()) {
      const L = p.lead;
      if (L.mode === "off") continue;
      if (L.runsDay !== day) { L.runsDay = day; L.runsToday = 0; this.saveProj(p); }
      if (L.runsToday >= L.dailyRuns) continue;
      const its = this.issues().filter((i) => i.projectId === p.id);
      const bug = L.duties.bugs && its.filter((i) => i.labels.includes("bug") && !i.assignee && ["backlog", "todo"].includes(i.status) && this.linearAutoAllows(i)).sort(byPriority)[0];
      if (bug) {
        bug.assignee = pickDevRole(this.store, bug, L.agent);
        this.addComment(bug.id, L.agent, "lead", `分诊：判定为 bug，指派给 ${bug.assignee} 修复。`);
        bug.status = "todo";
        this.save(bug);
        await this.syncStatusRemote(bug).catch(() => []);
        this.leadLog(p, `分诊 ${this.key(bug)}「${bug.title}」：bug，指派给 ${bug.assignee} 修复`);
        p.lead.runsToday++;
        this.saveProj(p);
        await this.startRun(bug, L.agent);
        this.emit("lead");
        continue;
      }
      if (L.mode !== "autopilot" || its.filter((i) => i.status === "in_progress").length >= 2) continue;
      if (this.simulate) {
        const pool = [["优化首屏加载", "首屏 LCP 偏高，压缩图片并延迟加载非关键资源。\n\n验收标准：\n- LCP 低于 2.5s\n- 页面功能不受影响"], ["补充关键流程的端到端测试", "为核心流程补充浏览器验收用例。\n\n验收标准：\n- 覆盖登录、创建、删除三条主流程\n- CI 中可重复运行"]]
          .filter(([t]) => !its.some((i) => i.title === t));
        if (!pool.length || Math.random() > 0.35) continue;
        const [title, description] = pool[0];
        const i = this.newIssue(p, { title, description, labels: ["负责人提议"], priority: 3, assignee: pickDevRole(this.store, { title, description }, L.agent), createdBy: L.agent, status: "todo" });
        this.addComment(i.id, L.agent, "lead", `持续迭代：发现改进点，创建本工作项。\n${description}`);
        this.leadLog(p, `持续迭代：提出并开始 ${this.key(i)}「${title}」`);
        await this.startRun(i, L.agent);
      } else {
        // 真实模式：让负责人智能体巡检项目，必要时用 create_issue 提出改进项
        if (!this.store.getAgent(L.agent)) continue;
        const open = its.filter((i) => !["done", "canceled"].includes(i.status)).map((i) => `- ${this.key(i)} [${STATUS_LABEL[i.status]}] ${i.title}`).join("\n");
        this.runtime.submit(L.agent, `你是项目「${p.name}」的负责人，正在做例行巡检。\n\n未完成的工作项：\n${open || "（无）"}\n\n如果发现明确、有价值且不与现有工作项重复的改进点，用 create_issue 提出至多 1 个（写清验收标准，指派给合适的智能体并设为 todo）；没有就直接回复「无需新增」。`, { source: "issue" });
        this.leadLog(p, "持续迭代：开始例行巡检");
      }
      p.lead.runsToday++;
      this.saveProj(p);
      this.emit("lead");
    }
  }

  // ======================= 工作项 =======================
  private newIssue(p: Project, o: Partial<Issue> & { title: string }): Issue {
    const fresh = this.proj(p.id)!;
    const i: Issue = {
      id: this.store.nextSeq("issue"), projectId: p.id, number: fresh.nextNumber++, title: o.title, description: o.description ?? "",
      status: o.status ?? (o.assignee ? "todo" : "backlog"), priority: o.priority ?? 0, assignee: o.assignee ?? null, labels: o.labels ?? [],
      parentId: o.parentId ?? null, createdBy: o.createdBy ?? ME, createdAt: now(), updatedAt: now(), github: null, linear: null, pr: null, phases: [], cycle: 0, phase: null, blocked: null,
    };
    this.saveProj(fresh);
    Object.assign(p, fresh);
    this.store.docPut("issues", i.id, i);
    return i;
  }
  list(projectId?: string) { return this.issues().filter((i) => !projectId || i.projectId === projectId).map((i) => this.view(i)); }
  detail(ref: string | number) {
    const i = this.find(ref);
    return {
      ...this.view(i, true),
      parent: i.parentId && this.getIssue(i.parentId) ? this.view(this.getIssue(i.parentId)!) : null,
      childList: this.issues().filter((x) => x.parentId === i.id).map((x) => this.view(x, true)),
      activity: this.comments(i.id),
      runList: this.runsOf(i.id).reverse().map((r) => ({ id: r.id, agent: r.agent, status: r.status === "pending" ? "running" : r.status, startedAt: r.createdAt, error: r.error, cost: this.runCost(r) })),
    };
  }
  activity(limit = 20, projectId?: string) {
    const its = new Map(this.issues().map((i) => [i.id, i]));
    return this.store.docList<Comment>("comments").filter((c) => its.has(c.issueId) && (!projectId || its.get(c.issueId)!.projectId === projectId))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit)
      .map((c) => ({ ...c, key: this.key(its.get(c.issueId)!), title: its.get(c.issueId)!.title }));
  }
  private checkAssignee(name: string | null | undefined): string | null {
    if (!name) return null;
    if (!this.store.getAgent(name)) throw new WorkError(`智能体 ${name} 不存在`);
    return name;
  }

  async create(input: { projectId: string; title: string; description?: string; status?: string; priority?: number; assignee?: string | null; labels?: string[]; parent?: string | null; github?: boolean; linear?: boolean; hotfix?: boolean; dependsOn?: (string | number)[] }, actor = ME): Promise<ReturnType<Work["view"]>> {
    const p = this.proj(input.projectId);
    if (!p) throw new WorkError("请先选择项目");
    if (!input.title?.trim()) throw new WorkError("标题不能为空");
    const i = this.newIssue(p, {
      title: input.title.trim(), description: input.description ?? "", priority: input.priority ?? 0, labels: input.labels ?? [],
      assignee: this.checkAssignee(input.assignee), parentId: input.parent ? this.find(input.parent).id : null, createdBy: actor,
      status: input.status || undefined,
    });
    if (input.dependsOn?.length) i.dependsOn = this.resolveDeps(i, input.dependsOn);
    if (input.hotfix) {
      i.labels = [...new Set(["hotfix", ...i.labels])];
      i.priority = 1;
      i.assignee ||= pickDevRole(this.store, i);
      i.status = "todo";
    }
    this.save(i);
    const n = input.github ? await this.pushNew(i).catch(() => null) : null;
    const ln = input.linear ? await this.pushLinearNew(i).catch(() => null) : null;
    this.save(i);
    const depNote = i.dependsOn?.length ? `，依赖 ${i.dependsOn.map((d) => this.key(this.getIssue(d)!)).join("、")}` : "";
    this.addComment(i.id, "system", "system", `${actor} 创建了${input.hotfix ? " ⚡ Hotfix" : "工作项"}${depNote}${n ? `，并创建了 GitHub #${n}` : ""}${ln ? `，并创建了 Linear ${ln}` : ""}`);
    this.emit("issue");
    await this.maybeAutoRun(i, actor);
    return this.view(this.getIssue(i.id)!);
  }

  async update(ref: string | number, patch: { title?: string; description?: string; status?: string; priority?: number; assignee?: string | null; labels?: string[]; parent?: string | null; dependsOn?: (string | number)[] }, actor = ME) {
    const i = this.find(ref);
    const before = { ...i };
    if (actor !== ME && patch.status && !["backlog", "todo", "in_progress", "in_review"].includes(patch.status)) throw new WorkError("智能体不能把状态设为完成或取消，最多推进到 in_review，由人验收");
    if (patch.title !== undefined) i.title = patch.title;
    if (patch.description !== undefined) i.description = patch.description;
    if (patch.status !== undefined) i.status = patch.status;
    if (patch.priority !== undefined) i.priority = patch.priority;
    if (patch.assignee !== undefined) i.assignee = this.checkAssignee(patch.assignee);
    if (patch.labels !== undefined) i.labels = patch.labels;
    if (patch.parent !== undefined) i.parentId = patch.parent ? this.find(patch.parent).id : null;
    const depsBefore = (before.dependsOn ?? []).join(",");
    if (patch.dependsOn !== undefined) i.dependsOn = this.resolveDeps(i, patch.dependsOn);
    const ch: string[] = [];
    if ((i.dependsOn ?? []).join(",") !== depsBefore) ch.push(`依赖 → ${i.dependsOn?.length ? i.dependsOn.map((d) => this.key(this.getIssue(d)!)).join("、") : "无"}`);
    if (i.status !== before.status) ch.push(`状态 ${STATUS_LABEL[before.status]} → ${STATUS_LABEL[i.status]}`);
    if (i.assignee !== before.assignee) ch.push(`负责人 ${before.assignee ?? "无"} → ${i.assignee ?? "无"}`);
    if (i.priority !== before.priority) ch.push(`优先级 ${PRIORITY_LABEL[before.priority]} → ${PRIORITY_LABEL[i.priority]}`);
    if (i.status === "done" && before.status !== "done" && i.pr?.state === "open") await this.merge(i, actor).catch((e) => ch.push(`合并 PR 失败：${e.message}`));
    this.save(i);
    // 状态或优先级变了就同步到远端；没变时不发请求
    const remote = i.status !== before.status || i.priority !== before.priority ? await this.syncStatusRemote(i) : [];
    if (ch.length) this.addComment(i.id, "system", "system", `${actor} 修改了${ch.join("，")}${remote.length ? `；${remote.join("；")}` : ""}`);
    // 把执行中的工作项挪出「进行中」= 停止当前运行
    const ar = this.activeRun(i.id);
    if (ar && before.status === "in_progress" && i.status !== "in_progress") this.runtime.cancel(ar.id);
    this.emit("issue");
    // 依赖被移除 / 调整后也要重新判断能不能开始
    if (i.assignee !== before.assignee || (i.status === "todo" && before.status !== "todo") || (i.dependsOn ?? []).join(",") !== depsBefore) await this.maybeAutoRun(this.getIssue(i.id)!, actor);
    if (i.status === "done" && before.status !== "done") this.releaseDependents(i.id);
    if (["done", "canceled"].includes(i.status) && i.status !== before.status) this.recycle(this.getIssue(i.id), i.status === "done" ? "已完成" : "已取消");
    return this.view(this.getIssue(i.id)!);
  }

  comment(ref: string | number, body: string, actor = ME) {
    const i = this.find(ref);
    if (!body?.trim()) throw new WorkError("评论不能为空");
    const c = this.addComment(i.id, actor, actor === ME ? "user" : "agent", body.trim());
    this.emit("comment");
    return c;
  }
  async run(ref: string | number) {
    const i = this.find(ref);
    if (!i.assignee) throw new WorkError("先指派一个智能体");
    if (this.activeRun(i.id)) throw new WorkError("已经在执行中", 409);
    const pending = this.depsPending(i);
    if (pending.length) throw new WorkError(`还在等依赖：${pending.map((d) => `${this.key(d)}「${d.title}」`).join("、")}。依赖完成（或 PR 合并）后会自动开始；要提前开始，先在工作项里移除依赖`);
    await this.startRun(i, ME);
  }
  stop(ref: string | number) { const r = this.activeRun(this.find(ref).id); if (r) this.runtime.cancel(r.id); }
  remove(ref: string | number) {
    const i = this.find(ref);
    const r = this.activeRun(i.id);
    if (r) this.runtime.cancel(r.id);
    const p = this.proj(i.projectId);
    if (p?.repo) void this.workspace.remove(p, this.key(i)).catch(() => {});
    this.store.docDelete("issues", i.id);
    this.invalidate();
    for (const x of this.issues().filter((x) => x.parentId === i.id)) { x.parentId = null; this.save(x); }
    this.store.docDeleteWhere("comments", (c) => c.issueId === i.id);
    this.emit("issue");
  }

  /** 需要人处理的事项：只有需求待确认与最终验收（负责人关闭时，失败也需要人处理） */
  attention(projectId?: string) {
    const out: { kind: string; issue: ReturnType<Work["view"]>; text: string }[] = [];
    for (const i of this.issues().filter((x) => !projectId || x.projectId === projectId)) {
      const v = this.view(i);
      const leadOff = this.proj(i.projectId)?.lead.mode === "off";
      if (i.blocked) out.push({ kind: "confirm", issue: v, text: `需求待确认：${i.blocked.length} 个问题` });
      else if (this.waitingCi.has(i.id)) continue; // Hub 在等 CI，结果出来后自动审核、合并或拦下，不需要人操作
      else if (i.status === "in_review") out.push({ kind: "review", issue: v, text: i.pr?.guard && i.pr.state === "open" ? `安全护栏拦截：${i.pr.guard}` : i.pr?.state === "merged" ? `最终验收（PR #${i.pr.number} 已由 AI 合并）` : i.pr?.state === "open" ? `验收并合并 PR #${i.pr.number}` : "最终验收" });
      else if (leadOff && i.status === "todo" && v.lastRun?.status === "failed") out.push({ kind: "failed", issue: v, text: "运行失败（项目负责人已关闭，需要你处理）" });
    }
    return out.sort((a, b) => priorityRank(a.issue.priority) - priorityRank(b.issue.priority));
  }

  confirmRequirement(ref: string | number, answer: string) {
    const i = this.find(ref);
    if (!i.blocked) return;
    this.addComment(i.id, ME, "user", answer);
    i.description = `${i.description}\n\n## 需求确认（补充）\n${answer}`.trim();
    i.blocked = null;
    i.reqConfirmed = true;
    const rec = i.phases.findLast((p) => p.result === "blocked");
    if (rec) { rec.result = "pass"; rec.endedAt = now(); rec.note = `需求已确认：${answer.slice(0, 40)}`; }
    this.enterPhase(i, "plan");
    this.save(i);
    const w = this.confirmWaiters.get(i.id);
    this.confirmWaiters.delete(i.id);
    if (w) w(answer);
    else if (i.assignee && !this.activeRun(i.id)) void this.startRun(i, ME, { resume: true });
    this.emit("issue");
  }

  // ======================= 执行与生命周期 =======================
  private async maybeAutoRun(i: Issue, by: string) {
    if (i.assignee && i.status === "todo" && !this.activeRun(i.id)) await this.startRun(i, by);
  }

  // ---------- 空闲时重启 ----------
  /** 为空闲重启暂停：不再开始新的工作项运行（进行中的生命周期、测试照常） */
  pauseStarts = false;
  /**
   * 还没结束的任务数（等它们都结束才重启）：不只是工作项的主运行，
   * 还有测试任务、委派出去的评审 / 审计子任务——主运行结束了它们可能还在跑。
   */
  activeIssueRuns(): number {
    return this.finishing + ["pending", "running"].reduce((n, status) => n + this.store.listTasks({ status, limit: 1000 }).length, 0);
  }
  /** 正在处理运行结束后的收尾（交付、审核、合并）的数量 */
  private finishing = 0;
  /** 重启后（或取消重启时）放行被挂起的工作项 */
  resumeParked(): number {
    const list = this.issues().filter((i) => i.waitingRestart);
    for (const i of list) {
      i.waitingRestart = false;
      this.save(i);
      void this.maybeAutoRun(i, "重启恢复");
    }
    if (list.length) this.emit("issue");
    return list.length;
  }

  /**
   * 因预算熔断暂停的工作项：预算调高、或跨天额度重置后重新尝试开始。
   * startRun 会再判一次预算，仍然超限时安静地继续等（不重复评论）。返回开始了几个。
   */
  async resumeBudgetHeld(): Promise<number> {
    let n = 0;
    for (const i of this.issues().filter((x) => x.budgetHold && x.status === "todo" && x.assignee && !this.activeRun(x.id))) {
      if (await this.startRun(i, "预算恢复")) n++;
    }
    return n;
  }

  /**
   * 最近连续失败了几次（自动重试的上限按它算，而不是按总运行次数——跑过几轮正常交付的工作项也该能重试）。
   * 因服务重启中断的不算；遇到正常完成的运行就停；最近一次「完成但没走完生命周期」算一次。
   */
  private failStreak(i: Issue, runs = this.runsOf(i.id)): number {
    let n = 0;
    for (const r of [...runs].reverse()) {
      if (r.status === "completed") { if (n === 0 && !i.lifecycleDone) n = 1; break; }
      if (r.status === "failed" && /interrupted by service restart/.test(r.error ?? "")) continue;
      if (TERMINAL.has(r.status)) n++;
    }
    return n;
  }

  // ---------- 依赖 ----------
  /** 依赖算满足：已完成，或 PR 已合并（代码已进主干，后续工作可以基于它） */
  private depMet(d: Issue) { return d.status === "done" || d.pr?.state === "merged"; }
  /** 还没满足的依赖（被删掉的依赖忽略） */
  private depsPending(i: Issue): Issue[] {
    return (i.dependsOn ?? []).map((id) => this.getIssue(id)).filter((d): d is Issue => !!d && !this.depMet(d));
  }
  /** 把编号 / id 解析成同项目的工作项 id；拒绝依赖自己、跨项目和循环依赖 */
  private resolveDeps(i: Issue, refs: (string | number)[]): number[] {
    const ids = [...new Set(refs.map((r) => this.find(r)))].map((d) => {
      if (d.id === i.id) throw new WorkError("工作项不能依赖自己");
      if (d.projectId !== i.projectId) throw new WorkError(`${this.key(d)} 不在同一个项目里，不能作为依赖`);
      return d.id;
    });
    // 循环检测：从每个依赖出发沿依赖链走，走回自己就是环
    const seen = new Set<number>();
    const walk = (id: number): boolean => {
      if (id === i.id) return true;
      if (seen.has(id)) return false;
      seen.add(id);
      return (this.getIssue(id)?.dependsOn ?? []).some(walk);
    };
    const loop = ids.find((id) => walk(id));
    if (loop != null) throw new WorkError(`循环依赖：${this.key(this.getIssue(loop)!)} 已经（间接）依赖 ${this.key(i)}`);
    return ids;
  }
  /** 某个工作项完成 / 合并后，唤醒依赖它、且依赖已全部满足的待办工作项 */
  private releaseDependents(depId: number) {
    setImmediate(() => {
      for (const x of this.issues().filter((x) => x.dependsOn?.includes(depId))) {
        if (x.status !== "todo" || !x.assignee || this.activeRun(x.id) || this.depsPending(x).length) continue;
        this.addComment(x.id, "system", "system", `▶ 依赖已全部完成（最后一个：${this.key(this.getIssue(depId)!)}），自动开始执行`);
        void this.startRun(x, "依赖完成");
      }
    });
  }
  private enterPhase(i: Issue, phase: Phase) {
    i.phases.push({ cycle: i.cycle, phase, result: "active", note: "", startedAt: now(), endedAt: null });
    i.phase = phase;
  }
  /** 开始一次运行。resume = 从当前阶段继续（哨兵重启、需求确认后恢复） */
  async startRun(i: Issue, by: string, opts: { resume?: boolean; hops?: number } = {}): Promise<Task | null> {
    // 即将空闲重启：新的运行先挂起，重启后自动开始（继续中的生命周期不受影响）
    if (this.pauseStarts && !opts.resume) {
      if (!i.waitingRestart) {
        i.waitingRestart = true;
        this.save(i);
        this.addComment(i.id, "system", "system", "⏸ 服务即将重启（等运行中的工作项结束），重启后自动开始");
        this.emit("issue");
      }
      return null;
    }
    // 依赖没满足就不开始（指派、负责人分诊、Linear 自动执行都走这里）；继续中的生命周期不受影响
    const pending = opts.resume ? [] : this.depsPending(i);
    if (pending.length) {
      if (!i.waitingDeps) {
        i.waitingDeps = true;
        this.save(i);
        this.addComment(i.id, "system", "system", `⏸ 等待依赖 ${pending.map((d) => `${this.key(d)}「${d.title}」`).join("、")} 完成（或 PR 合并）后自动开始`);
        this.emit("issue");
      }
      return null;
    }
    if (i.waitingDeps) { i.waitingDeps = false; this.save(i); }
    const why = this.settings.budgetBlocked(i.projectId, this.runsOf(i.id).reduce((s, r) => s + this.runCost(r), 0), this.costs());
    if (why) {
      if (!i.budgetHold) {
        i.budgetHold = true;
        this.save(i);
        this.addComment(i.id, "system", "system", `⛔ 预算熔断：${why}，暂不执行`);
        this.notify.push("budget", `${this.key(i)} 因预算熔断暂停`, `${i.title}：${why}。调整预算后可继续。`, this.key(i));
        this.emit("issue");
      }
      return null;
    }
    i.budgetHold = false;
    // 上次因基础设施原因中断：从中断的阶段继续，不新开一轮（轮次只留给「评审不通过、重来」）
    let resume = !!opts.resume;
    if (!resume && i.resumeFrom && i.cycle > 0) {
      this.enterPhase(i, i.resumeFrom);
      resume = true;
    }
    i.resumeFrom = null;
    if (!resume || !i.phase) {
      i.cycle = (i.cycle ?? 0) + 1;
      i.lifecycleDone = false;
      this.enterPhase(i, "understand");
    }
    i.status = "in_progress";
    this.save(i);
    // 状态变了就同步（Linear 上会显示为 Started）；失败只记录，不影响执行
    await this.syncStatusRemote(i).catch(() => []);
    // 先准备好 worktree 再启动：CLI 底座以 worktree 为工作目录，目录不存在会直接启动失败
    if (this.workspace.enabledFor(this.proj(i.projectId), this.store.getAgent(i.assignee!))) {
      if (this.preparing.has(i.id)) return null;
      this.preparing.add(i.id);
      this.emit("issue");
      try {
        await this.workspace.prepare(this.proj(i.projectId)!, this.key(i));
      } catch (e) {
        const cur = this.getIssue(i.id)!;
        const act = cur.phases.findLast((r) => r.result === "active");
        if (act) { act.result = "fail"; act.endedAt = now(); act.note = "准备工作目录失败"; }
        cur.phase = null;
        if (cur.status === "in_progress") cur.status = "todo";
        this.save(cur);
        await this.syncStatusRemote(cur).catch(() => []);
        this.addComment(i.id, "system", "system", `✕ 准备工作目录失败，未开始执行：${(e as Error).message}`);
        this.emit("issue");
        return null;
      } finally {
        this.preparing.delete(i.id);
      }
    }
    const task = this.runtime.submit(i.assignee!, this.buildInput(i, resume), { source: "issue", issueId: i.id, hops: opts.hops ?? 0, priority: i.priority });
    this.addComment(i.id, "system", "system", resume ? `▶ ${i.assignee} 从「${PHASE_LABEL[i.phase!]}」继续（由 ${by} 触发，仍是第 ${i.cycle} 轮）` : `▶ ${i.assignee} 开始执行（由 ${by} 触发），第 ${i.cycle} 轮`, task.id);
    this.emit("issue");
    return task;
  }

  private buildInput(i: Issue, resume = false): string {
    const p = this.proj(i.projectId)!;
    const parts = [`你被分配了工作项 ${this.key(i)}：${i.title}`, `项目：${p.name}　优先级：${PRIORITY_LABEL[i.priority]}${i.labels.length ? `　标签：${i.labels.join("、")}` : ""}`];
    if (i.parentId) { const par = this.getIssue(i.parentId); if (par) parts.push(`父工作项：${this.key(par)} ${par.title}\n${par.description.slice(0, 1500)}`); }
    parts.push(`## 描述\n${i.description.trim() || "（无）"}`);
    const knowledge = this.settings.knowledge(p.id).filter((k) => k.on);
    if (knowledge.length) parts.push(`## 项目知识（务必遵守）\n${knowledge.map((k) => `- [${k.kind}] ${k.text}`).join("\n")}`);
    const comments = this.comments(i.id).filter((c) => c.kind === "user" || c.kind === "lead").slice(-10);
    if (comments.length) parts.push(`## 讨论记录（较早 → 较新）\n${comments.map((c) => `[${c.author}] ${c.body.slice(0, 1500)}`).join("\n\n")}`);
    if (resume && i.phase) parts.push(`## 进度\n这是第 ${i.cycle} 轮，此前阶段的结论：\n${i.phases.filter((r) => r.cycle === i.cycle && r.result === "pass").map((r) => `- ${PHASE_LABEL[r.phase]}：${r.note}`).join("\n") || "（无）"}\n请从「${PHASE_LABEL[i.phase]}」阶段继续（工作目录里保留着之前的改动，先查看现状再接着做，不要从头重来）。`);
    parts.push(LIFECYCLE_GUIDE);
    return parts.join("\n\n");
  }

  private continuation(task: Task): string | null {
    if (task.issueId == null || task.parentId !== null) return null;
    const i = this.getIssue(task.issueId);
    if (!i || i.lifecycleDone || !i.phase) return null;
    const n = (this.nudges.get(task.id) ?? 0) + 1;
    this.nudges.set(task.id, n);
    if (n > 3) return null;
    return `你还在「${PHASE_LABEL[i.phase]}」阶段，生命周期没有走完。请继续完成当前阶段，并调用 report_phase(phase="${i.phase}") 汇报结论。`;
  }
  private systemExtra(task: Task, agent: { skills?: string[] }): string {
    const skills = (agent.skills ?? []).map((id) => this.settings.skill(id)).filter(Boolean) as { id: string; name: string; description: string }[];
    return skills.length ? `\n\n## 可用技能\n需要时用 load_skill 加载完整指令：\n${skills.map((s) => `- ${s.id}（${s.name}）：${s.description}`).join("\n")}` : "";
  }

  /** report_phase 的处理：校验顺序、门禁、测试、轮次 */
  private async reportPhase(task: Task, input: { phase: Phase; result: "pass" | "fail"; note: string }, signal: AbortSignal): Promise<string> {
    const i = this.getIssue(task.issueId!);
    if (!i) throw new WorkError("工作项不存在");
    const rec = i.phases.findLast((r) => r.result === "active");
    if (!rec || !i.phase) throw new WorkError("当前没有进行中的阶段");
    if (input.phase !== rec.phase) throw new WorkError(`当前阶段是「${PHASE_LABEL[rec.phase]}」，请先完成它再汇报（phase="${rec.phase}"）`);
    if (input.result === "fail" && rec.phase !== "review") throw new WorkError("只有评审阶段可以报告不通过；其他阶段请完成后再汇报");
    const key = this.key(i);

    // 需求门禁
    if (rec.phase === "understand" && i.cycle === 1 && !i.reqConfirmed && !i.labels.includes("hotfix")) {
      const q = assessRequirement(i);
      if (q.score < 60) {
        rec.result = "blocked";
        rec.note = `需求评分 ${q.score}，缺少：${q.dims.filter((d) => !d.ok).map((d) => d.name).join("、")}`;
        i.blocked = q.questions;
        this.save(i);
        this.addComment(i.id, task.agent, "agent", `⏸ 需求还不够具体（${q.score} 分），先确认几个问题：\n${q.questions.map((x, n) => `${n + 1}. ${x}`).join("\n")}`, task.id);
        this.notify.push("confirm", `${key} 需求待确认`, `${i.title}：${task.agent} 提了 ${q.questions.length} 个问题，回答后才会继续。`, key);
        this.emit("issue");
        const answer = await this.runtime.waiting(task.id, () => new Promise<string>((resolve, reject) => {
          this.confirmWaiters.set(i.id, resolve);
          signal.addEventListener("abort", () => { this.confirmWaiters.delete(i.id); reject(new Error("已取消")); }, { once: true });
        }));
        return `需求已由人确认，补充信息：\n${answer}\n\n已进入「计划」阶段。${PHASE_HINT.plan}`;
      }
    }
    rec.result = input.result;
    rec.endedAt = now();
    rec.note = input.note.slice(0, 500);

    if (rec.phase === "do") {
      // 有代码改动：提交并创建 / 更新 PR
      const out = await this.afterDo(i, task).catch((e) => `（提交代码失败：${e.message}）`);
      if (out && typeof out === "object") {
        // 和主干冲突：留在「执行」阶段，让智能体合并主干、解决冲突后再汇报
        rec.result = "active";
        rec.endedAt = null;
        rec.note = `与主干冲突：${out.conflict.join("、")}`;
        this.save(i);
        this.addComment(i.id, "system", "system", `⚠ 提交前合并最新主干时有冲突（${out.conflict.join("、")}），已退回执行阶段，由 ${task.agent} 解决`, task.id);
        this.emit("issue");
        const base = this.proj(i.projectId)?.repo?.defaultBranch ?? "main";
        return `你的改动已提交到本地分支，但主干（origin/${base}）在你开发期间有了新提交，合并时这些文件冲突：\n${out.conflict.map((f) => `- ${f}`).join("\n")}\n\n请在当前工作目录执行 \`git fetch origin ${base} && git merge origin/${base}\`，逐个解决冲突（保留双方都需要的改动），提交合并结果，确认测试仍然通过后，再调用 report_phase(phase="do") 重新汇报。不要用 rebase 或强推改写主干历史。`;
      }
      const prMsg = out;
      this.enterPhase(i, "test");
      this.save(i);
      this.emit("issue");
      if (!this.qa) { const t = i.phases.at(-1)!; t.result = "pass"; t.endedAt = now(); t.note = "未配置测试队列，跳过"; this.enterPhase(i, "review"); this.save(i); return `${prMsg ?? ""}测试队列未启用，直接进入「评审」。${PHASE_HINT.review}`; }
      const t = i.phases.at(-1)!;
      t.qaRun = this.qa.enqueue(this.view(i), i.labels.includes("hotfix") ? "hotfix" : "lifecycle");
      this.save(i);
      this.emit("issue");
      const res = await this.runtime.waiting(task.id, () => this.qa!.wait(t.qaRun!, signal));
      const cur = this.getIssue(i.id)!;
      const trec = cur.phases.findLast((r) => r.phase === "test" && r.result === "active")!;
      trec.result = res.passed ? "pass" : "fail";
      trec.endedAt = now();
      trec.note = res.note;
      if (cur.pr) { cur.pr.checks = res.passed ? "passing" : "failing"; cur.pr.tests = res.note.match(/\d+\/\d+/)?.[0] ?? null; }
      if (res.passed) { this.enterPhase(cur, "review"); this.save(cur); this.emit("issue"); return `${prMsg ?? ""}测试通过：${res.note}。\n已进入「评审」阶段。${PHASE_HINT.review}`; }
      const fixes = cur.phases.filter((r) => r.cycle === cur.cycle && r.phase === "test" && r.result === "fail").length;
      if (fixes < MAX_FIXES) {
        this.addComment(cur.id, "system", "system", `✕ 测试未通过：${res.note}。回到「执行」修复（本轮第 ${fixes} 次）`, task.id);
        this.enterPhase(cur, "do");
        this.save(cur);
        this.emit("phase", { key, result: "fail", phase: "test" });
        return `测试未通过：${res.note}\n请回到「执行」阶段修复这些问题，完成后再调用 report_phase(phase="do")。`;
      }
      return this.newRound(cur, task, `测试连续 ${fixes} 次未通过`);
    }
    if (rec.phase === "review") {
      if (input.result === "fail") {
        this.settings.addKnowledge(i.projectId, "教训", `${key}：${input.note}（评审未通过的原因，后续同类工作需避免）`, "自动沉淀");
        return this.newRound(i, task, `评审未通过：${input.note}`);
      }
      i.phase = null;
      i.lifecycleDone = true;
      this.save(i);
      this.emit("issue");
      return "生命周期完成。请输出最终交付内容（结论先行，说明做了什么、如何验证），它会作为评论写回工作项。然后结束。";
    }
    const next = PHASES[PHASES.indexOf(rec.phase) + 1];
    this.enterPhase(i, next);
    this.save(i);
    this.emit("issue");
    return `已记录「${PHASE_LABEL[rec.phase]}」。进入「${PHASE_LABEL[next]}」阶段。${PHASE_HINT[next]}`;
  }
  private newRound(i: Issue, task: Task, why: string): string {
    if (i.cycle >= MAX_CYCLES) {
      i.phase = null;
      this.save(i);
      this.runtime.fail(task.id, `已进行 ${MAX_CYCLES} 轮仍未通过（${why}）`);
      return "已达到最大轮次，本次运行结束。";
    }
    this.addComment(i.id, "system", "system", `✕ ${why}。重新理解需求，开始第 ${i.cycle + 1} 轮`, task.id);
    i.cycle += 1;
    this.enterPhase(i, "understand");
    this.save(i);
    this.emit("phase", { key: this.key(i), result: "fail", phase: "review" });
    return `${why}\n开始第 ${i.cycle} 轮：请重新理解需求（结合上面的原因），然后依次推进，先调用 report_phase(phase="understand")。`;
  }

  /** 执行阶段结束：CLI 底座在工作目录里有改动时提交并创建 PR；演示模式下模拟 PR */
  private async afterDo(i: Issue, task: Task): Promise<string | null | { conflict: string[] }> {
    const p = this.proj(i.projectId)!;
    const agent = this.store.getAgent(task.agent);
    if (this.workspace.enabledFor(p, agent)) {
      const res = await this.workspace.commitAndPush(p, this.key(i), `${this.key(i)}: ${i.title}`);
      if (!res) return null;
      if ("conflict" in res && res.conflict) return { conflict: res.conflict };
      const pr = i.pr?.state === "open" ? i.pr : await this.github.createPR(p.repo!.fullName, { title: `${this.key(i)}: ${i.title}`, head: res.branch, base: p.repo!.defaultBranch ?? "main", body: `${i.description}\n\n${i.github ? `Closes #${i.github.number}` : ""}` }).then((r) => ({ number: r.number, branch: res.branch, state: "open" as const, checks: "pending" as const, tests: null, additions: res.additions, deletions: res.deletions, files: res.files }));
      i.pr = { ...pr, additions: res.additions, deletions: res.deletions, files: res.files, generated: res.generated };
      this.save(i);
      this.addComment(i.id, "system", "system", `↗ 已提交 PR #${i.pr.number}（${res.branch}），+${res.additions} −${res.deletions}，${res.files} 个文件${res.generated.lines ? `（其中 ${res.generated.files} 个锁文件 / 生成文件共 ${res.generated.lines} 行，不计入改动行数）` : ""}`);
      return `已提交 PR #${i.pr.number}。`;
    }
    if (this.simulate && p.repo && (["developer", "frontend-dev", "backend-dev", "devops"].includes(task.agent) || i.labels.includes("bug")) && !i.pr) {
      const add = 20 + Math.floor(Math.random() * 180);
      p.simGhNext = (p.simGhNext ?? 100) + 1;
      this.saveProj(p);
      i.pr = { number: p.simGhNext, branch: `agent/${this.key(i).toLowerCase()}`, state: "open", checks: "pending", tests: null, additions: add, deletions: Math.floor(add / 5), files: 1 + Math.floor(Math.random() * 6), simulated: true };
      this.save(i);
      this.addComment(i.id, "system", "system", `↗ 已提交 PR #${i.pr.number}（${i.pr.branch}），+${i.pr.additions} −${i.pr.deletions}，${i.pr.files} 个文件`);
      return `已提交 PR #${i.pr.number}。`;
    }
    return null;
  }

  private async onRunFinished(task: Task) {
    const i = this.getIssue(task.issueId!);
    if (!i) return;
    this.nudges.delete(task.id);
    this.confirmWaiters.delete(i.id);
    const key = this.key(i);
    if (task.status === "completed" && i.lifecycleDone) {
      this.addComment(i.id, task.agent, "agent", task.result || "(无输出)", task.id);
      const p = this.proj(i.projectId);
      if (i.github && p?.sync.postDeliverable && this.canPush(p)) {
        if (this.github.available()) await this.github.comment(p.repo!.fullName, i.github.number, `**${task.agent} 交付：**\n\n${task.result ?? ""}`).catch(() => {});
        this.addComment(i.id, "system", "system", `↗ 交付内容已评论到 GitHub #${i.github.number}`);
      }
      if (i.linear && p?.linear?.postDeliverable && this.canPushLinear(p)) {
        await this.linear.comment(i.linear.id, `**${task.agent} 交付：**\n\n${task.result ?? ""}`).catch(() => {});
        this.addComment(i.id, "system", "system", `↗ 交付内容已评论到 Linear ${i.linear.identifier}`);
      }
      if (i.status === "in_progress") i.status = "in_review";
      this.save(i);
      await this.syncStatusRemote(i);
      await this.afterDeliver(i);
    } else {
      const act = i.phases.findLast((r) => r.result === "active" || r.result === "blocked");
      if (act) { act.result = task.status === "cancelled" ? "cancelled" : "fail"; act.endedAt = now(); act.note ||= task.status === "cancelled" ? "已停止" : task.error ?? ""; }
      // 不是人主动停止的（运行失败、提前收工）：记下中断的阶段，重试时接着做，不消耗轮次
      if (task.status !== "cancelled" && act) i.resumeFrom = resumePoint(act.phase);
      i.phase = null;
      i.blocked = null;
      const msg = task.status === "cancelled" ? "■ 运行已停止。可修改后重新运行。" : task.status === "completed" ? "✕ 智能体没有走完生命周期就结束了。可重新运行。" : `✕ 运行失败：${task.error}。可修改后重新运行。`;
      this.addComment(i.id, "system", "system", msg, task.id);
      if (i.status === "in_progress") i.status = "todo";
      this.save(i);
      await this.syncStatusRemote(i);
    }
    this.emit("run_finished", { key, status: task.status });
  }

  /** 交付后：项目负责人审核、护栏检查、按合并策略处理 PR、通知 */
  private async afterDeliver(i: Issue) {
    const key = this.key(i);
    const lead = this.leadOf(i);
    const hot = i.labels.includes("hotfix");
    const lines: string[] = [];
    if (i.pr && i.pr.checks !== "failing") i.pr.checks = "passing";
    // 以 GitHub 上真实的 CI 为准：还在跑就等一会儿（最多 15 分钟），结果写进 PR，护栏据此判断
    if (i.pr && !i.pr.simulated && i.pr.state === "open") {
      i.pr.ci = await this.waitCi(i);
      this.save(i);
    }
    if (!lead && !hot && !i.mergeApproved) {
      this.save(i);
      this.notify.push("review", `${key} 等你最终验收`, i.title, key);
      this.emit("issue");
      return;
    }
    const L = lead ?? defaultLead("on_demand");
    const p = this.proj(i.projectId)!;
    const lastQa = this.qa?.runsFor(key).find((r) => r.status === "passed");
    if (L.duties.testing && lastQa) lines.push(`🧪 测试：验收 ${lastQa.cases.length}/${lastQa.cases.length} 通过（见测试板块）。`);
    const ci = i.pr?.ci;
    if (ci?.state === "passing") lines.push("✅ CI：全部通过。");
    else if (ci?.state === "unknown") lines.push(`⚠ CI：无法读取（${ci.error}），请自行到 GitHub 确认。`);
    let gv = i.pr ? await this.guardCheck(i) : null;
    if (i.pr) i.pr.reviewed = true;
    // 人已批准过合并、这次只是解决了冲突：改动大小 / 受保护路径人已看过，不再拦；测试或 CI 失败仍然拦
    const approved = i.mergeApproved && gv && !/测试未通过|CI /.test(gv) ? i.mergeApproved : null;
    if (approved) gv = null;
    // CI 没过多半是代码问题：交回开发智能体看日志修复（最多 2 次），而不是停在人这里
    if (i.pr?.ci?.state === "failing" && await this.fixCiFailure(i, L.agent)) {
      lines.push(`❌ CI 未通过（${i.pr.ci.failed.join("、")}），已交回 ${i.assignee} 查看日志并修复（第 ${i.ciFixes} 次），修好后重新走测试和评审。`);
      this.addComment(i.id, L.agent, "lead", lines.join("\n"));
      this.save(i);
      this.emit("lead");
      return;
    }
    if (gv) {
      i.pr!.guard = gv;
      lines.push(`🛡 安全护栏：${gv}。未自动合并，需要你确认后合并 PR #${i.pr!.number}。`);
      this.leadLog(p, `${key} 被安全护栏拦截（${gv}），等待你确认合并`);
      this.notify.push("guard", `${key} 被安全护栏拦截`, `${i.title}：${gv}。需要你确认后合并 PR #${i.pr!.number}。`, key);
    } else if ((L.mergePolicy === "auto" || hot || approved) && i.pr && i.pr.state === "open") {
      if (approved) lines.push(`${approved.by}已于 ${approved.at.slice(0, 16).replace("T", " ")} 批准合并，这次只是解决了与主干的冲突，测试与 CI 通过后直接合并。`);
      try {
        await this.merge(i, L.agent);
        if (hot) {
          lines.push(`AI 验收通过，已合并 PR #${i.pr.number} 并上线。你可以事后查看，如有问题可回滚。`);
          i.status = "done";
          await this.syncStatusRemote(i);
          this.recycle(i, "Hotfix 已合并上线");
          this.leadLog(p, `⚡ Hotfix ${key}：AI 验收通过，已合并 PR #${i.pr.number} 并完成`);
          this.notify.push("hotfix", `⚡ ${key} 已上线`, `${i.title}：测试通过，AI 验收后已合并 PR #${i.pr.number}。`, key);
        } else {
          lines.push(`审核通过，已合并 PR #${i.pr.number}。等待你最终验收。`);
          this.leadLog(p, `审核 ${key} 通过，已合并 PR #${i.pr.number}，等待你最终验收`);
          this.notify.push("review", `${key} 等你最终验收`, `${i.title}：测试与 AI 审核已通过，PR #${i.pr.number} 已合并。`, key);
        }
      } catch (e) {
        if (isMergeConflict(e) && await this.fixMergeConflict(i, L.agent)) lines.push(`合并 PR #${i.pr.number} 时与主干冲突（评审期间主干有新提交），已安排 ${i.assignee} 合并主干、解决冲突后重新走测试和评审。`);
        else {
          lines.push(`合并 PR #${i.pr.number} 失败：${(e as Error).message}。请手动处理。`);
          this.notify.push("review", `${key} 合并失败，需要你处理`, (e as Error).message, key);
        }
      }
    } else {
      lines.push(`审核：交付符合验收标准。${i.pr?.state === "open" ? `等待你验收并合并 PR #${i.pr.number}。` : "等待你最终验收。"}`);
      this.leadLog(p, `审核 ${key}：通过，等待你验收`);
      this.notify.push("review", `${key} 等你最终验收`, `${i.title}：测试与 AI 审核已通过。`, key);
    }
    this.addComment(i.id, L.agent, "lead", lines.join("\n"));
    this.save(i);
    this.emit("lead");
  }

  /**
   * PR 与主干冲突：交回开发智能体，新一轮执行时提交前会先合并主干，冲突由它解决。
   * 最多自动处理 2 次，再冲突就交给人。返回是否已安排。
   */
  private async fixMergeConflict(i: Issue, by: string): Promise<boolean> {
    // 上限只约束自动合并（防止负责人自动合并陷入循环）；人点了合并就是明确要合，总是交回开发去解决
    if (!i.assignee || (by !== ME && (i.mergeFixes ?? 0) >= 2)) return false;
    i.mergeFixes = (i.mergeFixes ?? 0) + 1;
    i.status = "todo";
    i.lifecycleDone = false;
    i.resumeFrom = "do"; // 只需合并主干、解决冲突后重新提交，不必重新理解需求
    if (by === ME) i.mergeApproved = { by, at: now() };
    if (i.pr) i.pr.guard = null; // 旧的护栏结论作废，重新交付时重新判断
    this.save(i);
    const base = this.proj(i.projectId)?.repo?.defaultBranch ?? "main";
    this.addComment(i.id, by, "lead", `PR #${i.pr?.number} 与主干冲突，无法合并。请先 git merge origin/${base} 并解决冲突（保留双方需要的改动），确认测试通过后照常提交；其余工作已完成，不必重做。`);
    await this.syncStatusRemote(i).catch(() => []);
    this.emit("issue");
    void this.startRun(this.getIssue(i.id)!, by);
    return true;
  }

  /** 正在等 CI 结果的工作项（交付后由 Hub 自动处理，不需要人操作） */
  private waitingCi = new Set<number>();
  /** 等 PR 最新提交的 CI 跑完（最多 timeoutMs），返回最终 / 最新的结果；查不到时返回 null（不阻塞流程） */
  private async waitCi(i: Issue, timeoutMs = 15 * 60_000, everyMs = 30_000): Promise<CiStatus | null> {
    const p = this.proj(i.projectId);
    if (!i.pr || !p?.repo || !this.github.available()) return null;
    const t0 = Date.now();
    let last: CiStatus | null = null;
    // 等待期间：不进「需要你处理」（Hub 会自己处理），每次查到的进度写进 PR 给界面看
    this.waitingCi.add(i.id);
    try {
      for (;;) {
        // 读不到 CI 时不再静默当作「没有 CI」：记为 unknown 并写明原因（常见是令牌缺 Actions 读权限）
        last = await this.github.ciStatus(p.repo.fullName, i.pr.number).catch((e) => ({ state: "unknown" as const, sha: "", failed: [], pending: [], checkedAt: now(), error: ciReadError(e) }));
        const cur = this.getIssue(i.id);
        if (cur?.pr) { cur.pr.ci = last; this.save(cur); this.emit("issue"); }
        if (i.pr) i.pr.ci = last;
        if (last.state !== "pending" || Date.now() - t0 >= timeoutMs) return last;
        await new Promise((r) => setTimeout(r, everyMs));
      }
    } finally { this.waitingCi.delete(i.id); }
  }

  /** CI 未通过：交回开发智能体修复（从执行阶段继续），最多 2 次，再失败交给人。返回是否已安排 */
  private async fixCiFailure(i: Issue, by: string): Promise<boolean> {
    if (!i.assignee || !i.pr?.ci || (i.ciFixes ?? 0) >= 2) return false;
    const ci = i.pr.ci;
    i.ciFixes = (i.ciFixes ?? 0) + 1;
    i.status = "todo";
    i.lifecycleDone = false;
    i.resumeFrom = "do";
    this.save(i);
    const links = (ci.failedUrls ?? []).map((u) => `- ${u}`).join("\n");
    this.addComment(i.id, by, "lead", `PR #${i.pr.number} 的 CI 没有通过：${ci.failed.join("、")}（提交 ${ci.sha.slice(0, 7)}）。\n${links ? `${links}\n` : ""}请先查看失败日志（例如 \`gh run view --log-failed\` 或打开上面的链接），在工作目录里复现并修复，确认相关测试通过后照常提交；其余工作已完成，不必重做。`);
    await this.syncStatusRemote(i).catch(() => []);
    this.emit("issue");
    void this.startRun(this.getIssue(i.id)!, by);
    return true;
  }

  private async guardCheck(i: Issue): Promise<string | null> {
    const G = this.settings.guard();
    if (!i.pr) return null;
    if (G.requireTests && i.pr.checks === "failing") return "测试未通过";
    if (G.requireTests && i.pr.ci?.state === "failing") return `CI 未通过（${i.pr.ci.failed.join("、")}）`;
    if (G.requireTests && i.pr.ci?.state === "pending") return `CI 还没跑完（${i.pr.ci.pending.join("、")}），等它结束后再合并`;
    const n = i.pr.additions + i.pr.deletions;
    if (G.maxDiff && n > G.maxDiff) return `改动 ${n} 行，超过自动合并上限 ${G.maxDiff} 行`;
    const p = this.proj(i.projectId)!;
    let files: string[] = [];
    if (!i.pr.simulated && this.github.available() && p.repo) files = await this.github.prFiles(p.repo.fullName, i.pr.number).catch(() => []);
    const hit = files.length ? G.protectedPaths.find((g) => files.some((f) => globMatch(g, f))) : null;
    if (hit) return `改动涉及受保护路径 ${hit}`;
    if (!files.length) {
      // 拿不到文件列表（演示模式）时按标题和描述的关键词判断
      const RISK: [RegExp, string][] = [[/支付|订单|payment/i, "**/payment/**"], [/登录|认证|权限|auth/i, "**/auth/**"], [/迁移|migration|数据库结构/i, "**/migrations/**"], [/部署|CI|workflow/i, ".github/**"]];
      const r = RISK.find(([re, path]) => G.protectedPaths.includes(path) && re.test(`${i.title} ${i.description}`));
      if (r) return `改动可能涉及受保护路径 ${r[1]}`;
    }
    return null;
  }
  private async merge(i: Issue, by: string) {
    if (!i.pr || i.pr.state !== "open") return;
    const p = this.proj(i.projectId)!;
    if (!i.pr.simulated) {
      if (!this.github.available() || !p.repo) throw new Error("未配置 GitHub Token，无法合并");
      await this.github.mergePR(p.repo.fullName, i.pr.number);
    }
    i.pr.state = "merged";
    i.pr.mergedAt = now();
    i.mergeApproved = null;
    this.save(i);
    this.addComment(i.id, "system", "system", `↗ ${by} 合并了 PR #${i.pr.number}（${i.pr.branch}）`);
    this.releaseDependents(i.id);
  }
  async mergePR(ref: string | number, force = false) {
    const i = this.find(ref);
    if (!i.pr || i.pr.state !== "open") throw new WorkError("没有可合并的 PR");
    if (i.pr.checks === "failing" && this.settings.guard().requireTests) throw new WorkError("测试未通过，按安全护栏规则禁止合并");
    // 人点合并时再查一次 CI（PR 可能刚推了新提交）；失败时提示但由人决定（人可能判断是 CI 自身的问题）
    if (!i.pr.simulated) {
      const p = this.proj(i.projectId);
      const ci = p?.repo && this.github.available() ? await this.github.ciStatus(p.repo.fullName, i.pr.number).catch(() => null) : null;
      if (ci) { i.pr.ci = ci; this.save(i); }
      if (ci?.state === "failing" && this.settings.guard().requireTests && !force) throw new WorkError(`CI 未通过（${ci.failed.join("、")}）。确认是 CI 自身的问题、仍要合并，请选择「仍然合并」`, 409);
    }
    try { await this.merge(i, ME); }
    catch (e) {
      if (isMergeConflict(e)) {
        if (await this.fixMergeConflict(i, ME)) throw new WorkError(`PR #${i.pr.number} 与主干冲突，已安排 ${i.assignee} 合并主干、解决冲突后重新提交（第 ${i.mergeFixes} 次）。你已批准合并，解决后测试与 CI 通过会直接合并`, 409);
        throw new WorkError(`PR #${i.pr.number} 与主干冲突，而且没有可以交回的开发智能体（先指派一个），请手动处理`, 409);
      }
      throw e;
    }
    i.pr.guard = null;
    const before = i.status;
    if (i.status !== "done") {
      i.status = "done";
      this.save(i);
      const remote = await this.syncStatusRemote(i);
      this.addComment(i.id, "system", "system", `${ME} 修改了状态 ${STATUS_LABEL[before]} → 完成${remote.length ? `；${remote.join("；")}` : ""}`);
    }
    this.save(i);
    this.recycle(i, "PR 已合并，工作项完成");
    this.emit("issue");
  }
  async rollback(ref: string | number) {
    const i = this.find(ref);
    if (i.pr?.state !== "merged") throw new WorkError("没有可回滚的 PR");
    const p = this.proj(i.projectId)!;
    let n: number;
    if (!i.pr.simulated) n = await this.workspace.revert(p, i.pr.number, this.github);
    else { p.simGhNext = (p.simGhNext ?? 100) + 1; this.saveProj(p); n = p.simGhNext; }
    i.pr.state = "reverted";
    i.pr.revert = n;
    this.addComment(i.id, "system", "system", `↩ ${ME} 回滚了 PR #${i.pr.number}：已创建并合并 revert PR #${n}，工作项回到「待规划」`);
    i.status = "backlog";
    this.save(i);
    await this.syncStatusRemote(i);
    this.emit("issue");
  }
  async pushToGithub(ref: string | number) {
    const i = this.find(ref);
    const p = this.proj(i.projectId);
    if (!p?.repo) throw new WorkError("项目尚未绑定 GitHub 仓库");
    if (!this.canPush(p)) throw new WorkError("当前同步方向不允许推送到 GitHub");
    const n = await this.pushNew(i);
    this.save(i);
    this.addComment(i.id, "system", "system", `↗ 已创建 GitHub #${n}`);
    this.emit("issue");
  }

  // ======================= 哨兵用 =======================
  health() {
    return this.store.listTasks({ status: "running", limit: 500 }).filter((t) => t.issueId != null && t.parentId === null).map((t) => {
      const i = this.getIssue(t.issueId!);
      if (!i) return null;
      const rec = i.phases.findLast((p) => p.result === "active");
      const mins = (iso: string) => (Date.now() - new Date(iso).getTime()) / 60000;
      const lastChild = this.store.listTasks({ rootId: t.id, limit: 1 })[0];
      const beat = [t.updatedAt, lastChild?.updatedAt].filter(Boolean).sort().at(-1)!;
      return { key: this.key(i), title: i.title, projectId: i.projectId, agent: t.agent, phase: rec?.phase ?? null, phaseMin: rec ? mins(rec.startedAt) : 0, idleMin: mins(beat), blocked: !!i.blocked, blockedMin: i.blocked ? mins(i.phases.findLast((p) => p.result === "blocked")?.startedAt ?? t.createdAt) : 0, testing: rec?.phase === "test" };
    }).filter(Boolean);
  }
  async sentinelAct(ref: string, action: string, extra: { minutes?: number; to?: string; alive?: boolean } = {}) {
    const i = this.find(ref);
    const run = this.activeRun(i.id);
    const p = this.proj(i.projectId)!;
    const label = PHASE_LABEL[i.phase ?? ""] ?? "";
    if (action === "nudge") this.addComment(i.id, "sentinel", "system", extra.alive
      ? `🛡 哨兵：「${label}」阶段已进行 ${extra.minutes} 分钟，超过时限，但智能体仍在活动，不打断，继续观察`
      : `🛡 哨兵：「${label}」阶段已 ${extra.minutes} 分钟无进展，已记录并继续观察`);
    if ((action === "restart" || action === "reassign") && run) {
      if (action === "reassign" && extra.to) { this.addComment(i.id, "sentinel", "system", `🛡 哨兵：${i.assignee} 多次无响应，改派给 ${extra.to}`); i.assignee = extra.to; }
      else this.addComment(i.id, "sentinel", "system", `🛡 哨兵：${i.assignee} 无响应，重启「${label}」阶段（带上之前阶段的结论）`);
      this.runtime.cancel(run.id);
      const fresh = this.getIssue(i.id)!;
      fresh.assignee = i.assignee;
      // onRunFinished 会把当前阶段标记为已停止；这里重新进入同一阶段继续
      await new Promise((r) => setTimeout(r, 50));
      const again = this.getIssue(i.id)!;
      again.assignee = i.assignee;
      const last = again.phases.at(-1);
      if (last) this.enterPhase(again, last.phase);
      this.save(again);
      await this.startRun(again, "哨兵", { resume: true });
    }
    if (action === "escalate") {
      this.leadLog(p, `哨兵上报：${this.key(i)} 在「${label}」阶段卡住，已接手处理`);
      this.addComment(i.id, p.lead.agent, "lead", "收到哨兵上报，我来跟进这个工作项。");
    }
    this.emit("sentinel");
  }
  async retryFailed(ref: string) {
    const i = this.find(ref);
    if (i.status !== "todo" || !i.assignee || this.activeRun(i.id)) return false;
    const last = this.runsOf(i.id).at(-1);
    this.addComment(i.id, "sentinel", "system", last?.status === "completed" ? "🛡 哨兵：上次运行没有走完生命周期就结束了，自动重试"
      : last?.status === "cancelled" ? `🛡 哨兵：上次运行被中断（服务重启等），从「${PHASE_LABEL[i.resumeFrom ?? ""] ?? "中断处"}」继续`
      : "🛡 哨兵：上次运行失败（非需求问题），自动重试");
    await this.startRun(i, "哨兵");
    return true;
  }
  costs() {
    return this.store.listTasks({ limit: 5000 }).map((t) => {
      const root = t.parentId ? this.store.getTask(t.rootId) : t;
      const i = root?.issueId != null ? this.getIssue(root.issueId) : undefined;
      return { key: i ? this.key(i) : null, projectId: i?.projectId ?? null, agent: t.agent, cost: t.cost, startedAt: t.createdAt };
    });
  }

  /** 启动时：进行中但已无活跃运行的工作项（因重启中断）退回 todo */
  private reconcile() {
    for (const i of this.issues().filter((x) => x.status === "in_progress")) {
      if (this.activeRun(i.id)) continue;
      // 生命周期已经走完，只是交付收尾（审核、合并）被重启打断：补做收尾，而不是打回待办
      if (i.lifecycleDone) {
        i.status = "in_review";
        i.phase = null;
        this.save(i);
        this.addComment(i.id, "system", "system", "服务重启时交付收尾还没处理完，重新进行审核");
        setImmediate(() => void this.afterDeliver(this.getIssue(i.id)!).catch(() => {}));
        continue;
      }
      const act = i.phases.findLast((r) => r.result === "active" || r.result === "blocked");
      if (act) { act.result = "cancelled"; act.endedAt = now(); act.note = "服务重启，运行中断"; i.resumeFrom = resumePoint(act.phase); }
      i.phase = null;
      i.blocked = null;
      i.status = "todo";
      this.save(i);
      this.addComment(i.id, "system", "system", "服务重启，进行中的运行已中断。可重新运行（哨兵会自动重试）。");
      void this.syncStatusRemote(i).catch(() => []);
    }
  }

  // ======================= 智能体工具 =======================
  private ctxIssue(task: Task): Issue | undefined {
    const root = task.parentId ? this.store.getTask(task.rootId) : task;
    return root?.issueId != null ? this.getIssue(root.issueId) : undefined;
  }
  private registerTools() {
    const ref = { type: "string", description: "工作项编号，如 HUB-12" };
    const fmt = (i: Issue) => `${this.key(i)} [${STATUS_LABEL[i.status]}] P:${PRIORITY_LABEL[i.priority]} ${i.assignee ?? "未指派"} — ${i.title}`;
    const wrap = <T>(schema: z.ZodType<T>, fn: (input: T, task: Task, agent: string, signal: AbortSignal) => Promise<string> | string) =>
      async (raw: unknown, ctx: { task: Task; agent: { name: string }; signal: AbortSignal }) => {
        const parsed = schema.safeParse(raw);
        if (!parsed.success) return { content: `参数不合法：${parsed.error.message}`, isError: true };
        try { return { content: await fn(parsed.data, ctx.task, ctx.agent.name, ctx.signal) }; }
        catch (err) { return { content: err instanceof Error ? err.message : String(err), isError: true }; }
      };
    const isIssueRoot = (task: Task) => task.issueId != null && task.parentId === null && !!this.getIssue(task.issueId);

    this.runtime.addTool({
      name: "report_phase",
      description: "汇报当前生命周期阶段的结论（需求理解 understand → 计划 plan → 执行 do → 测试 test（由 Hub 自动执行）→ 评审 review）。每个阶段完成后必须调用；只有评审可以报告 fail。",
      input_schema: { type: "object", properties: { phase: { type: "string", enum: ["understand", "plan", "do", "review"] }, result: { type: "string", enum: ["pass", "fail"] }, note: { type: "string", description: "本阶段的结论摘要（1-3 句）" } }, required: ["phase", "result", "note"], additionalProperties: false },
    }, wrap(z.object({ phase: z.enum(PHASES), result: z.enum(["pass", "fail"]), note: z.string() }), (input, task, _a, signal) => this.reportPhase(task, input, signal)), (task) => isIssueRoot(task));

    this.runtime.addTool({
      name: "load_skill",
      description: "加载一个技能的完整指令（技能目录见系统提示）。",
      input_schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
    }, wrap(z.object({ id: z.string() }), ({ id }) => { const s = this.settings.skill(id); if (!s) throw new Error(`技能 ${id} 不存在`); return `# ${s.name}\n\n${s.instructions}`; }), (_t, agent) => (agent.skills ?? []).length > 0);

    this.runtime.addTool({
      name: "list_issues",
      description: "列出工作项。默认当前项目；可按状态、负责人、关键词过滤。",
      input_schema: { type: "object", properties: { project: { type: "string", description: "项目前缀，如 HUB" }, status: { type: "array", items: { type: "string" } }, assignee: { type: "string" }, query: { type: "string" } }, additionalProperties: false },
    }, wrap(z.object({ project: z.string().optional(), status: z.array(z.string()).optional(), assignee: z.string().optional(), query: z.string().optional() }), (i, task) => {
      const pid = i.project ? this.projectsRaw().find((p) => p.key === i.project!.toUpperCase())?.id : this.ctxIssue(task)?.projectId;
      const list = this.issues().filter((x) => (!pid || x.projectId === pid) && (!i.status?.length || i.status.includes(x.status)) && (!i.assignee || x.assignee === i.assignee) && (!i.query || `${x.title}${x.description}`.includes(i.query))).slice(0, 50);
      return list.length ? list.map(fmt).join("\n") : "没有符合条件的工作项";
    }));
    this.runtime.addTool({
      name: "get_issue",
      description: "查看工作项详情：描述、讨论记录、阶段结论。",
      input_schema: { type: "object", properties: { issue: ref }, required: ["issue"], additionalProperties: false },
    }, wrap(z.object({ issue: z.string() }), ({ issue }) => {
      const i = this.find(issue);
      return [fmt(i), `描述：\n${i.description || "（无）"}`, `阶段：\n${i.phases.map((r) => `第${r.cycle}轮 ${PHASE_LABEL[r.phase]}：${r.result} ${r.note}`).join("\n") || "（无）"}`,
        `讨论：\n${this.comments(i.id).filter((c) => c.kind !== "system").slice(-10).map((c) => `[${c.author}] ${c.body.slice(0, 800)}`).join("\n\n") || "（无）"}`].join("\n\n");
    }));
    this.runtime.addTool({
      name: "create_issue",
      description: "创建工作项（默认在当前工作项所属项目，处理中的工作项会作为父项）。指派给智能体且状态为 todo 会自动开始执行。priority: 0 无,1 紧急,2 高,3 中,4 低。",
      input_schema: { type: "object", properties: { title: { type: "string" }, description: { type: "string", description: "背景、要求和验收标准" }, assignee: { type: "string" }, status: { type: "string", enum: ["backlog", "todo"] }, priority: { type: "integer" }, labels: { type: "array", items: { type: "string" } }, depends_on: { type: "array", items: { type: "string" }, description: "依赖的工作项编号（如 S2T-1）：它们完成或 PR 合并后才会开始" }, project: { type: "string" } }, required: ["title"], additionalProperties: false },
    }, wrap(z.object({ title: z.string(), description: z.string().optional(), assignee: z.string().optional(), status: z.enum(["backlog", "todo"]).optional(), priority: z.number().int().min(0).max(4).optional(), labels: z.array(z.string()).optional(), project: z.string().optional(), depends_on: z.array(z.string()).optional() }), async (input, task, agent) => {
      const ctx = this.ctxIssue(task);
      const pid = input.project ? this.projectsRaw().find((p) => p.key === input.project!.toUpperCase())?.id : ctx?.projectId ?? this.projectsRaw()[0]?.id;
      if (!pid) throw new Error("找不到项目");
      const v = await this.create({ projectId: pid, title: input.title, description: input.description, assignee: input.assignee, status: input.status, priority: input.priority, labels: input.labels, parent: ctx ? String(ctx.id) : null, dependsOn: input.depends_on }, agent);
      return `已创建 ${v.key}`;
    }));
    this.runtime.addTool({
      name: "update_issue",
      description: "更新工作项的标题、描述、状态（最多到 in_review）、负责人、优先级或标签。",
      input_schema: { type: "object", properties: { issue: ref, title: { type: "string" }, description: { type: "string" }, status: { type: "string", enum: ["backlog", "todo", "in_progress", "in_review"] }, assignee: { type: "string" }, priority: { type: "integer" }, labels: { type: "array", items: { type: "string" } }, depends_on: { type: "array", items: { type: "string" }, description: "依赖的工作项编号；传空数组表示移除全部依赖" } }, required: ["issue"], additionalProperties: false },
    }, wrap(z.object({ issue: z.string(), title: z.string().optional(), description: z.string().optional(), status: z.string().optional(), assignee: z.string().optional(), priority: z.number().int().optional(), labels: z.array(z.string()).optional(), depends_on: z.array(z.string()).optional() }), async ({ issue, depends_on, ...patch }, _t, agent) => `已更新 ${(await this.update(issue, { ...patch, ...(depends_on ? { dependsOn: depends_on } : {}) }, agent)).key}`));
    this.runtime.addTool({
      name: "comment_issue",
      description: "在工作项下发表评论，用于记录进展、提问或交接。",
      input_schema: { type: "object", properties: { issue: ref, body: { type: "string" } }, required: ["issue", "body"], additionalProperties: false },
    }, wrap(z.object({ issue: z.string(), body: z.string().min(1) }), ({ issue, body }, _t, agent) => { this.comment(issue, body, agent); return "已评论"; }));
  }
}

const PHASE_HINT: Record<string, string> = {
  understand: "复述目标，列出验收标准和不确定的点。",
  plan: "拆成步骤，标注依赖与检查点。",
  do: "按计划完成工作；需要改代码时在当前工作目录中修改并保证能运行。",
  test: "由 Hub 安排测试，不需要你汇报。",
  review: "对照验收标准逐条自查，全部满足报告 pass，否则报告 fail 并写明原因。",
};
const LIFECYCLE_GUIDE = `## 工作方式（生命周期）
按顺序推进：需求理解 → 计划 → 执行 → 测试 → 评审。每个阶段完成后调用 report_phase 汇报结论：
1. understand：${PHASE_HINT.understand}
2. plan：${PHASE_HINT.plan}
3. do：${PHASE_HINT.do} 完成后 Hub 会自动安排测试，并把结果作为 report_phase 的返回告诉你。
4. review：${PHASE_HINT.review}
评审通过后，输出最终交付内容作为回复。`;

/** 中断后从哪个阶段继续：测试阶段由「执行」完成时的汇报触发，所以回到执行（代码已在，确认后重新汇报即可） */
const resumePoint = (p: Phase): Phase => (p === "test" ? "do" : p);
/** 读 CI 失败的原因，给人看的说法 */
function ciReadError(e: unknown): string {
  const m = (e as Error)?.message ?? String(e);
  if (/→ (403|404)/.test(m)) return "GitHub 令牌没有读取 CI 的权限：细粒度令牌需要勾选 Actions（Read）";
  return m.slice(0, 160);
}
/** GitHub 合并接口的冲突：405 Pull Request is not mergeable */
function isMergeConflict(e: unknown): boolean { return /→ 405|not mergeable|merge conflict/i.test((e as Error)?.message ?? ""); }
function globMatch(glob: string, path: string): boolean {
  const re = new RegExp("^" + glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*\/?/g, "§").replace(/\*/g, "[^/]*").replace(/§/g, ".*") + "$");
  return re.test(path);
}
