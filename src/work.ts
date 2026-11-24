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
import type { GitHub } from "./github.ts";
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
export interface PR { number: number; branch: string; state: "open" | "merged" | "closed" | "reverted"; checks: "pending" | "passing" | "failing"; tests: string | null; additions: number; deletions: number; files: number; reviewed?: boolean; guard?: string | null; mergedAt?: string; revert?: number; simulated?: boolean }
export interface Issue {
  id: number; projectId: string; number: number; title: string; description: string; status: string; priority: number;
  assignee: string | null; labels: string[]; parentId: number | null; createdBy: string; createdAt: string; updatedAt: string;
  github: { number: number; state: "open" | "closed"; syncedAt: string } | null;
  linear: { id: string; identifier: string; url: string; state: "open" | "closed"; stateId?: string; priority?: number; syncedAt: string } | null;
  pr: PR | null; phases: PhaseRec[]; cycle: number; phase: Phase | null;
  blocked: string[] | null; reqConfirmed?: boolean; budgetHold?: boolean; lifecycleDone?: boolean;
}
export interface Comment { id: number; issueId: number; author: string; kind: "user" | "agent" | "lead" | "system"; body: string; runId: string | null; createdAt: string }
export interface Lead { agent: string; mode: "off" | "on_demand" | "autopilot"; duties: { flow: boolean; review: boolean; bugs: boolean; testing: boolean }; mergePolicy: "auto" | "manual"; dailyRuns: number; runsToday: number; runsDay?: string; activity: { at: string; text: string }[] }
export interface LinearBinding {
  teamId: string; teamKey: string; teamName: string;
  mode: "two_way" | "import" | "push" | "off";
  importScope: "all" | "label"; importLabel: string;
  pushNew: boolean; postDeliverable: boolean;
  lastSyncAt: string | null; pendingRemote: number;
}
export interface Project {
  id: string; name: string; key: string; description: string; createdAt: string; nextNumber: number;
  repo: { fullName: string; defaultBranch?: string } | null;
  sync: { mode: "two_way" | "import" | "push" | "off"; importScope: "all" | "label"; importLabel: string; pushNew: boolean; postDeliverable: boolean };
  linear: LinearBinding | null;
  lastSyncAt: string | null; pendingRemote: number; lead: Lead;
  env: { baseUrl: string; preview: string; accounts: string[] };
  /** 演示模式下模拟的远端 issue */
  simRemote?: { number: number; title: string; body: string; labels: string[] }[];
  simGhNext?: number;
}

export class WorkError extends Error {
  status: number;
  constructor(m: string, status = 400) { super(m); this.status = status; }
}

const defaultLinear = (team: { id: string; key: string; name: string }): LinearBinding => ({ teamId: team.id, teamKey: team.key, teamName: team.name, mode: "two_way", importScope: "all", importLabel: "agent", pushNew: true, postDeliverable: true, lastSyncAt: null, pendingRemote: 0 });
/** 增量同步的起点：上次同步时间往前留 2 分钟重叠，防止时钟偏差漏掉变更（重复的会被去重） */
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
      if (e.type === "task" && e.task.issueId != null && e.task.parentId === null && TERMINAL.has(e.task.status)) void this.onRunFinished(e.task);
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
  private issues(): Issue[] { return this.store.docList<Issue>("issues"); }
  private getIssue(id: number): Issue | undefined { return this.store.docGet<Issue>("issues", id); }
  private save(i: Issue) { i.updatedAt = now(); this.store.docPut("issues", i.id, i); }
  key(i: Issue) { return `${this.proj(i.projectId)?.key ?? "?"}-${i.number}`; }
  private comments(issueId: number): Comment[] { return this.store.docList<Comment>("comments").filter((c) => c.issueId === issueId); }
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
    return c;
  }
  private runsOf(issueId: number): Task[] { return this.store.listTasks({ issueId, rootsOnly: true, limit: 200 }).reverse(); }
  private activeRun(issueId: number): Task | undefined { return this.runsOf(issueId).find((t) => !TERMINAL.has(t.status)); }

  view(i: Issue) {
    const p = this.proj(i.projectId);
    const runs = this.runsOf(i.id);
    const kids = this.issues().filter((x) => x.parentId === i.id && x.status !== "canceled");
    const last = runs.at(-1);
    const q = assessRequirement(i);
    return {
      ...i, key: this.key(i), projectName: p?.name ?? "", projectKey: p?.key ?? "",
      github: i.github && p?.repo ? { ...i.github, url: `https://github.com/${p.repo.fullName}/issues/${i.github.number}`, repo: p.repo.fullName } : null,
      pr: i.pr && p?.repo ? { ...i.pr, url: `https://github.com/${p.repo.fullName}/pull/${i.pr.number}` } : i.pr,
      comments: this.comments(i.id).filter((c) => c.kind !== "system").length,
      runs: runs.length, activeRuns: runs.filter((r) => !TERMINAL.has(r.status)).length,
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
    if (!p) p = { id: "p_" + Math.random().toString(36).slice(2, 8), name: "", key, description: "", createdAt: now(), nextNumber: 1, repo: null, sync: { mode: "off", importScope: "all", importLabel: "agent", pushNew: true, postDeliverable: true }, linear: null, lastSyncAt: null, pendingRemote: 0, lead: defaultLead(), env: { baseUrl: "", preview: "", accounts: [] } };
    p.name = input.name.trim();
    p.key = key;
    p.description = input.description ?? p.description;
    if (input.sync) p.sync = { ...p.sync, ...input.sync };
    if (input.env) p.env = { ...p.env, ...input.env };
    if (input.linear !== undefined) {
      p.linear = input.linear === null ? null : { ...(p.linear ?? defaultLinear({ id: "", key: "", name: "" })), ...input.linear };
      if (p.linear?.teamId) this.linearStates.delete(p.linear.teamId);
    }
    this.saveProj(p);
    this.emit("project");
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
    p.pendingRemote = p.simRemote?.length ?? 0;
    this.syncLog(id, "ok", `已绑定仓库 ${fullName}`);
    this.saveProj(p);
    this.emit("project");
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
  private canPush = (p?: Project) => !!p?.repo && (p.sync.mode === "two_way" || p.sync.mode === "push");
  private canImport = (p?: Project) => !!p?.repo && (p.sync.mode === "two_way" || p.sync.mode === "import");

  /** 同步：导入 GitHub 新 issue、推送标记需要同步的工作项、对齐 open/closed 状态 */
  /** incremental：只读上次同步后有更新的 issue（定时同步用）；否则全量 */
  async sync(id: string, opts: { incremental?: boolean } = {}): Promise<string> {
    const p = this.proj(id);
    if (!p?.repo) throw new WorkError("项目尚未绑定 GitHub 仓库");
    if (p.sync.mode === "off") throw new WorkError("同步已关闭，请先在同步设置里开启");
    let imported = 0, skipped = 0, pushed = 0, states = 0, pulled = 0;
    const mine = this.issues().filter((i) => i.projectId === id);
    // 拉回远端的关闭 / 重新打开（只看上次同步后有更新的 issue）
    if (this.canImport(p) && this.github.available()) {
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
        if (await this.pushState(i)) states++;
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
  private async pushState(i: Issue): Promise<string | null> {
    const p = this.proj(i.projectId);
    if (!i.github || !this.canPush(p)) return null;
    const want = ["done", "canceled"].includes(i.status) ? "closed" : "open";
    i.github.syncedAt = now();
    if (i.github.state === want) { this.save(i); return null; }
    if (this.github.available()) await this.github.setIssueState(p!.repo!.fullName, i.github.number, want, i.status === "canceled" ? "not_planned" : "completed").catch((e) => this.syncLog(p!.id, "warn", `更新 #${i.github!.number} 状态失败：${e.message}`));
    i.github.state = want;
    this.save(i);
    return want === "closed" ? `↗ 已关闭 GitHub #${i.github.number}${i.status === "canceled" ? "（not planned）" : ""}` : `↗ 已重新打开 GitHub #${i.github.number}`;
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
    if (to === "todo") void this.maybeAutoRun(this.getIssue(i.id)!, "远端同步");
    if (to === "done" || to === "canceled") this.recycle(this.getIssue(i.id), "远端已关闭");
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
    this.linearStates.delete(teamId);
    this.saveProj(p);
    this.syncLog(id, "ok", `已绑定 Linear 团队 ${team.name}（${team.key}）`);
    this.emit("project");
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
        const stateChanged = !!r.state && r.state.id !== i.linear.stateId;
        const prioChanged = (r.priority ?? 0) !== (i.linear.priority ?? i.priority);
        if (!stateChanged && !prioChanged) continue;
        const notes: string[] = [];
        if (prioChanged && r.priority !== i.priority) { notes.push(`优先级 ${PRIORITY_LABEL[i.priority]} → ${PRIORITY_LABEL[r.priority ?? 0]}`); i.priority = r.priority ?? 0; }
        const closed = r.state?.type === "completed" || r.state?.type === "canceled";
        i.linear = { ...i.linear, stateId: r.state?.id, priority: r.priority ?? 0, state: closed ? "closed" : "open", syncedAt: now() };
        let to = stateChanged ? statusForStateType(r.state.type) : null;
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
        const i = this.newIssue(p, { title: r.title || "(无标题)", description: r.description ?? "", labels: r.labels, priority: r.priority ?? 0, createdBy: "Linear 导入" });
        i.linear = { id: r.id, identifier: r.identifier, url: r.url, state: "open", stateId: r.state?.id, priority: r.priority ?? 0, syncedAt: now() };
        this.save(i);
        this.addComment(i.id, "system", "system", `从 Linear ${r.identifier} 导入`);
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
    const text = `Linear 同步完成：导入 ${imported} 个${skipped ? `（${skipped} 个不在导入范围内，已跳过）` : ""}、拉回远端变更 ${pulled} 个、写回 ${pushed} 个`;
    this.syncLog(id, "ok", text);
    this.emit("sync");
    return text;
  }

  private async pushLinearNew(i: Issue): Promise<string | null> {
    const p = this.proj(i.projectId);
    const cfg = p?.linear;
    if (!cfg || i.linear || !this.canPushLinear(p)) return null;
    const created = await this.linear.createIssue({ teamId: cfg.teamId, title: i.title, description: i.description, priority: i.priority });
    i.linear = { id: created.id, identifier: created.identifier, url: created.url, state: "open", stateId: created.state?.id, priority: i.priority, syncedAt: now() };
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
    if (i.linear.stateId === target.id && i.linear.priority === i.priority) return null;
    await this.linear.updateIssue(i.linear.id, { stateId: target.id, priority: i.priority });
    const closed = ["done", "canceled"].includes(i.status);
    i.linear = { ...i.linear, stateId: target.id, priority: i.priority, state: closed ? "closed" : "open", syncedAt: now() };
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
      const bug = L.duties.bugs && its.filter((i) => i.labels.includes("bug") && !i.assignee && ["backlog", "todo"].includes(i.status)).sort(byPriority)[0];
      if (bug) {
        bug.assignee = pickDevRole(this.store, bug, L.agent);
        this.addComment(bug.id, L.agent, "lead", `分诊：判定为 bug，指派给 ${bug.assignee} 修复。`);
        bug.status = "todo";
        this.save(bug);
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
      ...this.view(i),
      parent: i.parentId && this.getIssue(i.parentId) ? this.view(this.getIssue(i.parentId)!) : null,
      childList: this.issues().filter((x) => x.parentId === i.id).map((x) => this.view(x)),
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

  async create(input: { projectId: string; title: string; description?: string; status?: string; priority?: number; assignee?: string | null; labels?: string[]; parent?: string | null; github?: boolean; linear?: boolean; hotfix?: boolean }, actor = ME): Promise<ReturnType<Work["view"]>> {
    const p = this.proj(input.projectId);
    if (!p) throw new WorkError("请先选择项目");
    if (!input.title?.trim()) throw new WorkError("标题不能为空");
    const i = this.newIssue(p, {
      title: input.title.trim(), description: input.description ?? "", priority: input.priority ?? 0, labels: input.labels ?? [],
      assignee: this.checkAssignee(input.assignee), parentId: input.parent ? this.find(input.parent).id : null, createdBy: actor,
      status: input.status || undefined,
    });
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
    this.addComment(i.id, "system", "system", `${actor} 创建了${input.hotfix ? " ⚡ Hotfix" : "工作项"}${n ? `，并创建了 GitHub #${n}` : ""}${ln ? `，并创建了 Linear ${ln}` : ""}`);
    this.emit("issue");
    await this.maybeAutoRun(i, actor);
    return this.view(this.getIssue(i.id)!);
  }

  async update(ref: string | number, patch: { title?: string; description?: string; status?: string; priority?: number; assignee?: string | null; labels?: string[]; parent?: string | null }, actor = ME) {
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
    const ch: string[] = [];
    if (i.status !== before.status) ch.push(`状态 ${STATUS_LABEL[before.status]} → ${STATUS_LABEL[i.status]}`);
    if (i.assignee !== before.assignee) ch.push(`负责人 ${before.assignee ?? "无"} → ${i.assignee ?? "无"}`);
    if (i.priority !== before.priority) ch.push(`优先级 ${PRIORITY_LABEL[before.priority]} → ${PRIORITY_LABEL[i.priority]}`);
    if (i.status === "done" && before.status !== "done" && i.pr?.state === "open") await this.merge(i, actor).catch((e) => ch.push(`合并 PR 失败：${e.message}`));
    this.save(i);
    const gh = i.status !== before.status ? await this.pushState(i).catch(() => null) : null;
    const ln = await this.pushLinearState(i).catch(() => null);
    if (ch.length) this.addComment(i.id, "system", "system", `${actor} 修改了${ch.join("，")}${gh ? `；${gh}` : ""}${ln ? `；Linear → ${ln}` : ""}`);
    // 把执行中的工作项挪出「进行中」= 停止当前运行
    const ar = this.activeRun(i.id);
    if (ar && before.status === "in_progress" && i.status !== "in_progress") this.runtime.cancel(ar.id);
    this.emit("issue");
    if (i.assignee !== before.assignee || (i.status === "todo" && before.status !== "todo")) await this.maybeAutoRun(this.getIssue(i.id)!, actor);
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
  private enterPhase(i: Issue, phase: Phase) {
    i.phases.push({ cycle: i.cycle, phase, result: "active", note: "", startedAt: now(), endedAt: null });
    i.phase = phase;
  }
  /** 开始一次运行。resume = 从当前阶段继续（哨兵重启、需求确认后恢复） */
  async startRun(i: Issue, by: string, opts: { resume?: boolean; hops?: number } = {}): Promise<Task | null> {
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
    if (!opts.resume || !i.phase) {
      i.cycle = (i.cycle ?? 0) + 1;
      i.lifecycleDone = false;
      this.enterPhase(i, "understand");
    }
    i.status = "in_progress";
    this.save(i);
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
        this.addComment(i.id, "system", "system", `✕ 准备工作目录失败，未开始执行：${(e as Error).message}`);
        this.emit("issue");
        return null;
      } finally {
        this.preparing.delete(i.id);
      }
    }
    const task = this.runtime.submit(i.assignee!, this.buildInput(i, opts.resume), { source: "issue", issueId: i.id, hops: opts.hops ?? 0, priority: i.priority });
    this.addComment(i.id, "system", "system", opts.resume ? `▶ ${i.assignee} 从「${PHASE_LABEL[i.phase!]}」继续（由 ${by} 触发）` : `▶ ${i.assignee} 开始执行（由 ${by} 触发），第 ${i.cycle} 轮`, task.id);
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
    if (resume && i.phase) parts.push(`## 进度\n这是第 ${i.cycle} 轮，此前阶段的结论：\n${i.phases.filter((r) => r.cycle === i.cycle && r.result === "pass").map((r) => `- ${PHASE_LABEL[r.phase]}：${r.note}`).join("\n") || "（无）"}\n请从「${PHASE_LABEL[i.phase]}」阶段继续。`);
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
        const answer = await new Promise<string>((resolve, reject) => {
          this.confirmWaiters.set(i.id, resolve);
          signal.addEventListener("abort", () => { this.confirmWaiters.delete(i.id); reject(new Error("已取消")); }, { once: true });
        });
        return `需求已由人确认，补充信息：\n${answer}\n\n已进入「计划」阶段。${PHASE_HINT.plan}`;
      }
    }
    rec.result = input.result;
    rec.endedAt = now();
    rec.note = input.note.slice(0, 500);

    if (rec.phase === "do") {
      // 有代码改动：提交并创建 / 更新 PR
      const prMsg = await this.afterDo(i, task).catch((e) => `（提交代码失败：${e.message}）`);
      this.enterPhase(i, "test");
      this.save(i);
      this.emit("issue");
      if (!this.qa) { const t = i.phases.at(-1)!; t.result = "pass"; t.endedAt = now(); t.note = "未配置测试队列，跳过"; this.enterPhase(i, "review"); this.save(i); return `${prMsg ?? ""}测试队列未启用，直接进入「评审」。${PHASE_HINT.review}`; }
      const t = i.phases.at(-1)!;
      t.qaRun = this.qa.enqueue(this.view(i), i.labels.includes("hotfix") ? "hotfix" : "lifecycle");
      this.save(i);
      this.emit("issue");
      const res = await this.qa.wait(t.qaRun, signal);
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
  private async afterDo(i: Issue, task: Task): Promise<string | null> {
    const p = this.proj(i.projectId)!;
    const agent = this.store.getAgent(task.agent);
    if (this.workspace.enabledFor(p, agent)) {
      const res = await this.workspace.commitAndPush(p, this.key(i), `${this.key(i)}: ${i.title}`);
      if (!res) return null;
      const pr = i.pr?.state === "open" ? i.pr : await this.github.createPR(p.repo!.fullName, { title: `${this.key(i)}: ${i.title}`, head: res.branch, base: p.repo!.defaultBranch ?? "main", body: `${i.description}\n\n${i.github ? `Closes #${i.github.number}` : ""}` }).then((r) => ({ number: r.number, branch: res.branch, state: "open" as const, checks: "pending" as const, tests: null, additions: res.additions, deletions: res.deletions, files: res.files }));
      i.pr = { ...pr, additions: res.additions, deletions: res.deletions, files: res.files };
      this.save(i);
      this.addComment(i.id, "system", "system", `↗ 已提交 PR #${i.pr.number}（${res.branch}），+${res.additions} −${res.deletions}，${res.files} 个文件`);
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
      await this.pushLinearState(i).catch(() => null);
      await this.afterDeliver(i);
    } else {
      const act = i.phases.findLast((r) => r.result === "active" || r.result === "blocked");
      if (act) { act.result = task.status === "cancelled" ? "cancelled" : "fail"; act.endedAt = now(); act.note ||= task.status === "cancelled" ? "已停止" : task.error ?? ""; }
      i.phase = null;
      i.blocked = null;
      const msg = task.status === "cancelled" ? "■ 运行已停止。可修改后重新运行。" : task.status === "completed" ? "✕ 智能体没有走完生命周期就结束了。可重新运行。" : `✕ 运行失败：${task.error}。可修改后重新运行。`;
      this.addComment(i.id, "system", "system", msg, task.id);
      if (i.status === "in_progress") i.status = "todo";
      this.save(i);
      await this.pushLinearState(i).catch(() => null);
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
    if (!lead && !hot) {
      this.save(i);
      this.notify.push("review", `${key} 等你最终验收`, i.title, key);
      this.emit("issue");
      return;
    }
    const L = lead ?? defaultLead("on_demand");
    const p = this.proj(i.projectId)!;
    const lastQa = this.qa?.runsFor(key).find((r) => r.status === "passed");
    if (L.duties.testing && lastQa) lines.push(`🧪 测试：验收 ${lastQa.cases.length}/${lastQa.cases.length} 通过（见测试板块）。`);
    const gv = i.pr ? await this.guardCheck(i) : null;
    if (i.pr) i.pr.reviewed = true;
    if (gv) {
      i.pr!.guard = gv;
      lines.push(`🛡 安全护栏：${gv}。未自动合并，需要你确认后合并 PR #${i.pr!.number}。`);
      this.leadLog(p, `${key} 被安全护栏拦截（${gv}），等待你确认合并`);
      this.notify.push("guard", `${key} 被安全护栏拦截`, `${i.title}：${gv}。需要你确认后合并 PR #${i.pr!.number}。`, key);
    } else if ((L.mergePolicy === "auto" || hot) && i.pr && i.pr.state === "open") {
      try {
        await this.merge(i, L.agent);
        if (hot) {
          lines.push(`AI 验收通过，已合并 PR #${i.pr.number} 并上线。你可以事后查看，如有问题可回滚。`);
          i.status = "done";
          await this.pushState(i);
          await this.pushLinearState(i).catch(() => null);
          this.recycle(i, "Hotfix 已合并上线");
          this.leadLog(p, `⚡ Hotfix ${key}：AI 验收通过，已合并 PR #${i.pr.number} 并完成`);
          this.notify.push("hotfix", `⚡ ${key} 已上线`, `${i.title}：测试通过，AI 验收后已合并 PR #${i.pr.number}。`, key);
        } else {
          lines.push(`审核通过，已合并 PR #${i.pr.number}。等待你最终验收。`);
          this.leadLog(p, `审核 ${key} 通过，已合并 PR #${i.pr.number}，等待你最终验收`);
          this.notify.push("review", `${key} 等你最终验收`, `${i.title}：测试与 AI 审核已通过，PR #${i.pr.number} 已合并。`, key);
        }
      } catch (e) {
        lines.push(`合并 PR #${i.pr.number} 失败：${(e as Error).message}。请手动处理。`);
        this.notify.push("review", `${key} 合并失败，需要你处理`, (e as Error).message, key);
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

  private async guardCheck(i: Issue): Promise<string | null> {
    const G = this.settings.guard();
    if (!i.pr) return null;
    if (G.requireTests && i.pr.checks === "failing") return "测试未通过";
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
    this.addComment(i.id, "system", "system", `↗ ${by} 合并了 PR #${i.pr.number}（${i.pr.branch}）`);
  }
  async mergePR(ref: string | number) {
    const i = this.find(ref);
    if (!i.pr || i.pr.state !== "open") throw new WorkError("没有可合并的 PR");
    if (i.pr.checks === "failing" && this.settings.guard().requireTests) throw new WorkError("测试未通过，按安全护栏规则禁止合并");
    await this.merge(i, ME);
    i.pr.guard = null;
    const before = i.status;
    if (i.status !== "done") { i.status = "done"; const gh = await this.pushState(i); this.addComment(i.id, "system", "system", `${ME} 修改了状态 ${STATUS_LABEL[before]} → 完成${gh ? `；${gh}` : ""}`); }
    this.save(i);
    await this.pushLinearState(i).catch(() => null);
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
    await this.pushState(i);
    this.save(i);
    await this.pushLinearState(i).catch(() => null);
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
  async sentinelAct(ref: string, action: string, extra: { minutes?: number; to?: string } = {}) {
    const i = this.find(ref);
    const run = this.activeRun(i.id);
    const p = this.proj(i.projectId)!;
    const label = PHASE_LABEL[i.phase ?? ""] ?? "";
    if (action === "nudge") this.addComment(i.id, "sentinel", "system", `🛡 哨兵：「${label}」阶段已 ${extra.minutes} 分钟无进展，已记录并继续观察`);
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
    this.addComment(i.id, "sentinel", "system", "🛡 哨兵：上次运行失败（非需求问题），自动重试");
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
      const act = i.phases.findLast((r) => r.result === "active" || r.result === "blocked");
      if (act) { act.result = "cancelled"; act.endedAt = now(); act.note = "服务重启，运行中断"; }
      i.phase = null;
      i.blocked = null;
      i.status = "todo";
      this.save(i);
      this.addComment(i.id, "system", "system", "服务重启，进行中的运行已中断。可重新运行（哨兵会自动重试）。");
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
      input_schema: { type: "object", properties: { title: { type: "string" }, description: { type: "string", description: "背景、要求和验收标准" }, assignee: { type: "string" }, status: { type: "string", enum: ["backlog", "todo"] }, priority: { type: "integer" }, labels: { type: "array", items: { type: "string" } }, project: { type: "string" } }, required: ["title"], additionalProperties: false },
    }, wrap(z.object({ title: z.string(), description: z.string().optional(), assignee: z.string().optional(), status: z.enum(["backlog", "todo"]).optional(), priority: z.number().int().min(0).max(4).optional(), labels: z.array(z.string()).optional(), project: z.string().optional() }), async (input, task, agent) => {
      const ctx = this.ctxIssue(task);
      const pid = input.project ? this.projectsRaw().find((p) => p.key === input.project!.toUpperCase())?.id : ctx?.projectId ?? this.projectsRaw()[0]?.id;
      if (!pid) throw new Error("找不到项目");
      const v = await this.create({ projectId: pid, title: input.title, description: input.description, assignee: input.assignee, status: input.status, priority: input.priority, labels: input.labels, parent: ctx ? String(ctx.id) : null }, agent);
      return `已创建 ${v.key}`;
    }));
    this.runtime.addTool({
      name: "update_issue",
      description: "更新工作项的标题、描述、状态（最多到 in_review）、负责人、优先级或标签。",
      input_schema: { type: "object", properties: { issue: ref, title: { type: "string" }, description: { type: "string" }, status: { type: "string", enum: ["backlog", "todo", "in_progress", "in_review"] }, assignee: { type: "string" }, priority: { type: "integer" }, labels: { type: "array", items: { type: "string" } } }, required: ["issue"], additionalProperties: false },
    }, wrap(z.object({ issue: z.string(), title: z.string().optional(), description: z.string().optional(), status: z.string().optional(), assignee: z.string().optional(), priority: z.number().int().optional(), labels: z.array(z.string()).optional() }), async ({ issue, ...patch }, _t, agent) => `已更新 ${(await this.update(issue, patch, agent)).key}`));
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

function globMatch(glob: string, path: string): boolean {
  const re = new RegExp("^" + glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*\/?/g, "§").replace(/\*/g, "[^/]*").replace(/§/g, ".*") + "$");
  return re.test(path);
}
