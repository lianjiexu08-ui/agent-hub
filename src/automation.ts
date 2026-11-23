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
  { id: "j_sync", name: "同步 GitHub（所有绑定仓库）", cron: "0 * * * *", action: "sync", on: true, history: [] },
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

  constructor(store: Store, runtime: Runtime, work: Work, qa: QA, assistant: Assistant, opts: { sentinelMs: number; leadMs: number }) {
    this.store = store;
    this.runtime = runtime;
    this.work = work;
    this.qa = qa;
    this.assistant = assistant;
    if (!store.docGet("auto", "rules")) store.docPut("auto", "rules", { id: "rules", ...DEFAULT_RULES });
    for (const j of DEFAULT_JOBS) if (!store.docGet("jobs", j.id)) store.docPut("jobs", j.id, { ...j, nextAt: nextRun(j.cron)?.toISOString() ?? null });
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
        const ps = this.work.projectsRaw().filter((p) => p.repo && p.sync.mode !== "off");
        for (const p of ps) await this.work.sync(p.id);
        result = `已同步 ${ps.length} 个仓库`;
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
      const chain = noBeat && st.level === 0 ? ["restart", ...R.phaseTimeout.chain.filter((a) => a !== "restart" && a !== "nudge")] : R.phaseTimeout.chain;
      const action = chain[Math.min(st.level, chain.length - 1)];
      const reason = noBeat ? `${Math.round(x.idleMin)} 分钟无心跳` : `「${x.phase}」已 ${Math.round(x.phaseMin)} 分钟（时限 ${sla} 分钟）`;
      const to = this.store.listAgents().map((a) => a.name).find((n) => n !== x.agent && ["developer", "orchestrator"].includes(n)) ?? x.agent;
      await this.work.sentinelAct(x.key, action, { minutes: Math.round(Math.max(x.phaseMin, x.idleMin)), to });
      this.addLog(action, `${x.key} ${reason} → ${{ nudge: "提醒", restart: "重启当前阶段", reassign: `改派给 ${to}`, escalate: "上报项目负责人" }[action]}`, x.key);
      st.level++;
      st.lastAt = new Date().toISOString();
      acted++;
    }
    if (R.queueWait.on) for (const r of this.qa.runs().filter((r) => r.status === "queued" && !r.boosted)) {
      const m = (Date.now() - new Date(r.queuedAt).getTime()) / 60000;
      if (m >= R.queueWait.minutes) { r.boosted = true; r.hotfix = true; this.store.docPut("qa_runs", r.id, r); this.addLog("boost", `${r.issueKey} 验收排队 ${Math.round(m)} 分钟，已提升优先级`, r.issueKey); acted++; }
    }
    if (R.retryFailed.on) for (const i of this.work.list().filter((i) => i.status === "todo" && i.lastRun?.status === "failed" && !this.retried.has(i.lastRun.id))) {
      this.retried.add(i.lastRun!.id);
      const tries = i.runs;
      if (/需求|预算|轮仍未通过/.test(i.lastRun!.error ?? "") || tries > R.retryFailed.times + 1) continue;
      if (await this.work.retryFailed(i.key)) { this.addLog("retry", `${i.key} 运行失败（${(i.lastRun!.error ?? "").slice(0, 40)}），自动重试`, i.key); acted++; }
    }
    if (acted) this.emit();
    return acted;
  }
}
