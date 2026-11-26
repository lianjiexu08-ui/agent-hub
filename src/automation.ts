/**
 * 自动化：哨兵 + 定时任务。
 * 哨兵定期巡检执行中的工作项：阶段超时按处理链逐级升级（提醒 → 重启 → 改派 → 上报负责人），
 * 无心跳直接重启，测试排队过久提升优先级，失败自动重试，需求待确认过久提醒人。
 */
import type { Store } from "./db.ts";
import type { Runtime } from "./runtime.ts";
import type { HubEvent } from "./types.ts";
import type { Work } from "./work.ts";
import type { QA } from "./qa.ts";
import type { Assistant } from "./assistant.ts";
import { priorityRank } from "./priority.ts";
import { pickReassignTarget } from "./roles.ts";

export interface Rules {
  phaseTimeout: { on: boolean; sla: Record<string, number>; chain: string[] };
  heartbeat: { on: boolean; minutes: number };
  queueWait: { on: boolean; minutes: number };
  retryFailed: { on: boolean; times: number };
  confirmReminder: { on: boolean; hours: number };
}
export interface Job { id: string; name: string; cron: string; action: "sentinel" | "sync" | "report" | "create" | "regression" | "lead"; system?: boolean; on: boolean; projectId?: string; params?: { title: string; description: string; assignee: string }; history: { at: string; ok: boolean; result: string; manual: boolean }[]; lastAt?: string; nextAt?: string | null }

const DEFAULT_RULES: Rules = {
  phaseTimeout: { on: true, sla: { understand: 15, plan: 15, do: 45, test: 30, review: 20 }, chain: ["nudge", "restart", "reassign", "escalate"] },
  heartbeat: { on: true, minutes: 10 },
  queueWait: { on: true, minutes: 15 },
  retryFailed: { on: true, times: 1 },
  confirmReminder: { on: true, hours: 4 },
};
const DEFAULT_JOBS: Job[] = [
  { id: "j_sentinel", name: "哨兵巡检", cron: "* * * * *", action: "sentinel", system: true, on: true, history: [] },
  { id: "j_lead", name: "项目负责人巡检", cron: "*/5 * * * *", action: "lead", system: true, on: true, history: [] },
  { id: "j_sync", name: "同步 GitHub / Linear", cron: "*/5 * * * *", action: "sync", on: true, history: [] },
  { id: "j_morning", name: "管家晨报", cron: "0 9 * * *", action: "report", on: true, history: [] },
];

// ---------- cron：分 时 日 月 周（* / 数字 / */N / 逗号列表） ----------
const match = (f: string, v: number) => f === "*" || f.split(",").some((p) => (p.startsWith("*/") ? v % Number(p.slice(2)) === 0 : Number(p) === v));
export function nextRun(cron: string, from = new Date()): Date | null {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [mi, ho, dm, mo, dw] = parts;
  const d = new Date(from);
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  for (let n = 0; n < 60 * 24 * 370; n++) {
    if (match(mi, d.getMinutes()) && match(ho, d.getHours()) && match(dm, d.getDate()) && match(mo, d.getMonth() + 1) && match(dw, d.getDay())) return d;
    d.setMinutes(d.getMinutes() + 1);
  }
  return null;
}

export class Automation {
  private store: Store;
  private runtime: Runtime;
  private work: Work;
  private qa: QA;
  private assistant: Assistant;
  private state = new Map<string, { level: number; lastAt?: string; reminded?: string }>();
  private retried = new Set<string>();
  private lastSweep = 0;

  constructor(store: Store, runtime: Runtime, work: Work, qa: QA, assistant: Assistant, opts: { sentinelMs: number; leadMs: number }) {
    this.store = store;
    this.runtime = runtime;
    this.work = work;
    this.qa = qa;
    this.assistant = assistant;
    if (!store.docGet("auto", "rules")) store.docPut("auto", "rules", { id: "rules", ...DEFAULT_RULES });
    for (const j of DEFAULT_JOBS) if (!store.docGet("jobs", j.id)) store.docPut("jobs", j.id, { ...j, nextAt: nextRun(j.cron)?.toISOString() ?? null });
    // 旧版默认每小时同步：没被人改过的升级为每 5 分钟增量同步（官方 SaaS 的 Webhook 进不了内网，靠轮询）
    const sj = store.docGet<Job>("jobs", "j_sync");
    if (sj && sj.cron === "0 * * * *" && sj.name === "同步 GitHub（所有绑定仓库）") store.docPut("jobs", sj.id, { ...sj, name: "同步 GitHub / Linear", cron: "*/5 * * * *", nextAt: nextRun("*/5 * * * *")?.toISOString() ?? null });
    setInterval(() => { const j = this.job("j_sentinel"); if (j?.on) void this.runJob(j); }, opts.sentinelMs);
    setInterval(() => { const j = this.job("j_lead"); if (j?.on) void this.runJob(j); }, opts.leadMs);
    setInterval(() => {
      for (const j of this.jobs()) if (j.on && !["sentinel", "lead"].includes(j.action) && j.nextAt && new Date(j.nextAt) <= new Date()) { j.nextAt = nextRun(j.cron)?.toISOString() ?? null; this.store.docPut("jobs", j.id, j); void this.runJob(j); }
    }, 15_000);
  }
  private emit() { this.runtime.events.emit("event", { type: "work", kind: "auto" } as unknown as HubEvent); }
  rules(): Rules { return { ...DEFAULT_RULES, ...this.store.docGet<Rules>("auto", "rules") }; }
  setRule(k: keyof Rules, p: Record<string, unknown>) { const r = this.rules(); (r as any)[k] = { ...(r as any)[k], ...p }; this.store.docPut("auto", "rules", { id: "rules", ...r }); this.emit(); }
  jobs(): Job[] { return this.store.docList<Job>("jobs"); }
  job(id: string) { return this.store.docGet<Job>("jobs", id); }
  log() { return this.store.docList("autolog").reverse().slice(0, 200); }
  private addLog(kind: string, text: string, key?: string) {
    const id = this.store.nextSeq("autolog");
    this.store.docPut("autolog", id, { id, at: new Date().toISOString(), kind, text, key });
  }
  snapshot() { return { rules: this.rules(), jobs: this.jobs(), log: this.log(), state: Object.fromEntries(this.state) }; }

  saveJob(j: Job) {
    if (!j.name?.trim()) throw new Error("名称不能为空");
    if (!nextRun(j.cron)) throw new Error("cron 表达式无效");
    const old = j.id ? this.job(j.id) : undefined;
    if (old?.system) throw new Error("系统任务不能修改");
    const v: Job = { ...old, ...j, history: j.history ?? old?.history ?? [], on: j.on ?? true, id: j.id || "j_" + this.store.nextSeq("job"), nextAt: nextRun(j.cron)!.toISOString() };
    this.store.docPut("jobs", v.id, v);
    this.emit();
  }
  toggle(id: string, on: boolean) { const j = this.job(id)!; j.on = on; j.nextAt = nextRun(j.cron)?.toISOString() ?? null; this.store.docPut("jobs", id, j); this.emit(); }
  remove(id: string) { const j = this.job(id); if (j && !j.system) this.store.docDelete("jobs", id); this.emit(); }

  async runJob(j: Job, manual = false) {
    let result = "", ok = true;
    try {
      if (j.action === "sentinel") { const n = await this.sentinel(); result = n ? `处理 ${n} 项` : "一切正常"; }
      if (j.action === "lead") { await this.work.leadTick(); result = "已巡检"; }
      if (j.action === "sync") {
        const gh = this.work.projectsRaw().filter((p) => p.repo && p.sync.mode !== "off");
        const ln = this.work.projectsRaw().filter((p) => p.linear && p.linear.mode !== "off");
        const errs: string[] = [];
        // 单个项目失败不影响其他项目；定时同步走增量
        for (const p of gh) await this.work.sync(p.id, { incremental: !manual }).catch((e) => errs.push(`${p.name}（GitHub）：${e.message}`));
        for (const p of ln) await this.work.syncLinear(p.id, { incremental: !manual }).catch((e) => errs.push(`${p.name}（Linear）：${e.message}`));
        result = `已同步 ${gh.length} 个 GitHub 仓库、${ln.length} 个 Linear 团队${errs.length ? `；失败 ${errs.length} 个：${errs.join("；")}` : ""}`;
        if (errs.length) ok = false;
      }
      if (j.action === "report") { this.assistant.postReport(); result = "已推送到首页"; }
      if (j.action === "create" && j.projectId && j.params) {
        const v = await this.work.create({ projectId: j.projectId, title: j.params.title.replace("{date}", new Date().toLocaleDateString("zh-CN")), description: j.params.description, assignee: j.params.assignee || null, priority: 3 }, `定时任务「${j.name}」`);
        result = `已创建 ${v.key}`;
      }
      if (j.action === "regression" && j.projectId) {
        const its = this.work.list(j.projectId).filter((i) => i.status === "done").slice(0, 3);
        for (const i of its) this.qa.enqueue(i, "manual");
        result = `已加入 ${its.length} 个回归验收`;
      }
    } catch (e) { ok = false; result = (e as Error).message; }
    const fresh = this.job(j.id) ?? j;
    fresh.history = [{ at: new Date().toISOString(), ok, result, manual }, ...(fresh.history ?? [])].slice(0, 20);
    fresh.lastAt = new Date().toISOString();
    this.store.docPut("jobs", fresh.id, fresh);
    if (!["sentinel", "lead"].includes(j.action) || (result !== "一切正常" && result !== "已巡检")) this.addLog("job", `定时任务「${j.name}」${manual ? "（手动）" : ""}：${result}`);
    this.emit();
    return result;
  }

  stuck(key: string) { const s = this.state.get(key); return s?.level ? s : null; }

  async sentinel(): Promise<number> {
    const R = this.rules();
    let acted = 0;
    for (const x of this.work.health() as NonNullable<ReturnType<Work["health"]>[number]>[]) {
      const st = this.state.get(x.key) ?? { level: 0 };
      this.state.set(x.key, st);
      if (x.blocked) {
        if (R.confirmReminder.on && x.blockedMin >= R.confirmReminder.hours * 60 && !st.reminded) {
          st.reminded = new Date().toISOString();
          this.assistant.post(`⏰ 提醒：${x.key}「${x.title}」的需求已等你确认 ${Math.round(x.blockedMin / 60)} 小时，确认后智能体才能继续。`);
          this.addLog("remind", `${x.key} 需求待确认已超过 ${R.confirmReminder.hours} 小时，已通过管家提醒你`, x.key);
          acted++;
        }
        continue;
      }
      if (x.testing) continue;
      const sla = R.phaseTimeout.sla[x.phase ?? ""] ?? 30;
      const overSla = R.phaseTimeout.on && x.phaseMin >= sla;
      const noBeat = R.heartbeat.on && x.idleMin >= R.heartbeat.minutes;
      if (!overSla && !noBeat) { if (st.level) this.state.set(x.key, { level: 0 }); continue; }
      // 只超时、心跳正常 = 还在干活，只是慢：只提醒和上报，不重启 / 改派（会打断正在写的代码）；
      // 两步之间至少隔半个时限，走完一遍就不再重复。没有心跳才是真卡住，走完整的处理链
      const alive = !noBeat;
      let chain = noBeat && st.level === 0 ? ["restart", ...R.phaseTimeout.chain.filter((a) => a !== "restart" && a !== "nudge")] : R.phaseTimeout.chain;
      if (alive) {
        chain = chain.filter((a) => a === "nudge" || a === "escalate");
        if (!chain.length || st.level >= chain.length) continue;
        if (st.lastAt && (Date.now() - new Date(st.lastAt).getTime()) / 60000 < Math.max(5, sla / 2)) continue;
      }
      const action = chain[Math.min(st.level, chain.length - 1)];
      const reason = noBeat ? `${Math.round(x.idleMin)} 分钟无心跳` : `「${x.phase}」已 ${Math.round(x.phaseMin)} 分钟（时限 ${sla} 分钟）`;
      const issue = this.work.list().find((i) => i.key === x.key);
      const to = pickReassignTarget(this.store, x.agent, issue);
      await this.work.sentinelAct(x.key, action, { minutes: Math.round(Math.max(x.phaseMin, x.idleMin)), to, alive });
      this.addLog(action, `${x.key} ${reason} → ${{ nudge: "提醒", restart: "重启当前阶段", reassign: `改派给 ${to}`, escalate: "上报项目负责人" }[action]}`, x.key);
      st.level++;
      st.lastAt = new Date().toISOString();
      acted++;
    }
    if (R.queueWait.on) for (const r of this.qa.runs().filter((r) => r.status === "queued" && !r.boosted)) {
      const m = (Date.now() - new Date(r.queuedAt).getTime()) / 60000;
      if (m >= R.queueWait.minutes) { r.boosted = true; r.hotfix = true; this.store.docPut("qa_runs", r.id, r); this.addLog("boost", `${r.issueKey} 验收排队 ${Math.round(m)} 分钟，已提升优先级`, r.issueKey); acted++; }
    }
    // 失败的运行，以及「正常结束但没走完生命周期」的运行（智能体提前收工，比如工具调用出错后自己结束了）都自动重试
    // 记了续跑点（resumeFrom）的也重试：那是基础设施原因中断的（重启、哨兵重启时撞上服务重启……），即使最后一次运行显示「已取消」；
    // 人主动停止的不会留续跑点，不会被自动拉起
    const unfinished = (i: { status: string; lastRun?: { status: string } | null; lifecycleDone?: boolean; resumeFrom?: string | null }) =>
      i.lastRun?.status === "failed" || (i.lastRun?.status === "completed" && !i.lifecycleDone) || (!!i.resumeFrom && i.lastRun?.status === "cancelled");
    if (R.retryFailed.on) for (const i of this.work.list().filter((i) => i.status === "todo" && unfinished(i) && !this.retried.has(i.lastRun!.id)).sort((a, b) => priorityRank(a.priority) - priorityRank(b.priority))) {
      // 额度用完：等到恢复时间再续跑（不记为已重试，到点后下一轮巡检会拉起）
      if (i.quotaUntil && Date.parse(i.quotaUntil) > Date.now()) continue;
      this.retried.add(i.lastRun!.id);
      const tries = i.runs;
      // 按最近连续失败次数限流（见 Work.failStreak）；以前用总运行次数，跑过几轮的工作项就再也不会被重试
      if (/需求|预算|轮仍未通过/.test(i.lastRun!.error ?? "") || (i.failStreak ?? tries) > R.retryFailed.times) continue;
      if (await this.work.retryFailed(i.key)) { this.addLog("retry", `${i.key} 运行失败（${(i.lastRun!.error ?? "").slice(0, 40)}），自动重试`, i.key); acted++; }
    }
    // 因预算熔断暂停的工作项：跨天额度重置、或预算被调高后自动继续
    const resumed = await this.work.resumeBudgetHeld().catch(() => 0);
    if (resumed) { this.addLog("retry", `${resumed} 个因预算暂停的工作项已恢复执行`); acted++; }
    // 每小时清扫一次已结束工作项残留的 worktree
    if (Date.now() - this.lastSweep > 3600_000) {
      this.lastSweep = Date.now();
      const n = await this.work.sweepWorkspaces().catch(() => 0);
      if (n) { this.addLog("sweep", `回收了 ${n} 个已结束工作项的工作目录`); acted++; }
    }
    if (acted) this.emit();
    return acted;
  }
}
