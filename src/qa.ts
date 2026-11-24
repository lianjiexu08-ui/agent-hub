/**
 * 测试队列：生命周期的「测试」阶段由这里排队执行。
 * - 调度：自动（互不冲突的并行）/ 串行；冲突 = 同一环境下测试账号相同，或会修改同一类数据
 * - 真实模式：由 tester 智能体执行验收，逐条 report_case；服务器装有 DevEye 时可用 browser 工具操作浏览器
 * - 演示模式：模拟逐步执行
 */
import { execFile } from "node:child_process";
import type { Store } from "./db.ts";
import type { Runtime } from "./runtime.ts";
import type { Settings } from "./settings.ts";
import type { HubEvent, Task } from "./types.ts";
import type { Project, QAPort } from "./work.ts";
import { z } from "zod";
import { priorityRank } from "./priority.ts";

interface Step { desc: string; cmd: string; status: "passed" | "failed" | "skipped" | null; ms?: number; error?: string | null; found?: string; at?: string; locate?: boolean; assert?: boolean }
interface Case { id: string; criterion: number | null; kind: "browser" | "unit" | "check" | "health"; title: string; mutates: string[]; status: "passed" | "failed" | "running" | "skipped" | null; steps: Step[]; note?: string }
export interface QARun {
  id: string; issueKey: string; title: string; projectId: string; pr: number | null; hotfix: boolean; priority: number;
  status: "queued" | "running" | "passed" | "failed" | "cancelled"; trigger: string; browser: string | null; env: string; account: string | null;
  mutates: string[]; cases: Case[]; queuedAt: string; startedAt?: string; endedAt?: string; wait: string | null; cursor: { c: number; s: number } | null;
  simulated: boolean; taskId?: string; failAt?: number; boosted?: boolean;
}
type IssueLike = { key: string; title: string; description: string; labels: string[]; projectId: string; pr: { number: number } | null; priority: number; quality: { criteria: string[] } };

const WEB = /页面|首页|导航|按钮|登录|博客|表单|移动端|样式|展示|定价|seo|前端|UI/i;
const now = () => new Date().toISOString();
const MUT_LABEL: Record<string, string> = { orders: "订单", session: "登录会话", content: "内容" };

export function detectDevEye(): Promise<boolean> {
  return new Promise((r) => execFile("/bin/sh", ["-c", "command -v deveye"], (e, out) => r(!e && !!out.trim())));
}

export class QA implements QAPort {
  private store: Store;
  private runtime: Runtime;
  private settings: Settings;
  private proj: (id: string) => Project | undefined;
  private simulate: boolean;
  deveye = false;
  private waiters = new Map<string, ((r: { passed: boolean; note: string; cases: number }) => void)[]>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private browsers: { id: string; status: "idle" | "busy"; runId: string | null }[] = [];
  private ticker: ReturnType<typeof setInterval>;
  /** 测试 / 关闭时停止调度 */
  stop() { clearInterval(this.ticker); this.timers.forEach(clearTimeout); }
  /** 强制下一次验收通过或失败（测试用） */
  forceFail: boolean | null = null;

  private stepMs: number;
  constructor(store: Store, runtime: Runtime, settings: Settings, proj: (id: string) => Project | undefined, simulate: boolean, opts: { stepMs?: number } = {}) {
    this.stepMs = opts.stepMs ?? 450;
    this.store = store;
    this.runtime = runtime;
    this.settings = settings;
    this.proj = proj;
    this.simulate = simulate;
    // 重启后，执行中的验收重新排队
    for (const r of this.runs().filter((r) => r.status === "running")) { r.status = "queued"; r.cases.forEach((c) => { c.status = null; c.steps.forEach((s) => (s.status = null)); }); this.save(r); }
    runtime.events.on("event", (e: HubEvent) => {
      if (e.type === "task" && ["completed", "failed", "cancelled"].includes(e.task.status)) {
        const r = this.runs().find((x) => x.taskId === e.task.id && x.status === "running");
        if (r) this.finishReal(r, e.task);
      }
    });
    this.registerTools();
    this.ticker = setInterval(() => this.tick(), 1000);
  }
  private emit() { this.runtime.events.emit("event", { type: "work", kind: "qa" } as unknown as HubEvent); }
  runs(): QARun[] { return this.store.docList<QARun>("qa_runs"); }
  run(id: string) { return this.store.docGet<QARun>("qa_runs", id); }
  private save(r: QARun) { this.store.docPut("qa_runs", r.id, r); }
  runsFor(key: string) { return this.runs().filter((r) => r.issueKey === key).reverse(); }
  state() { return { runs: this.runs().slice(-200), settings: this.settings.get().qa, browsers: this.browsers, deveye: this.deveye }; }

  private buildCases(i: IssueLike): Case[] {
    const web = WEB.test(`${i.title}${i.description}`) || !!this.proj(i.projectId)?.env.baseUrl;
    const mut = (t: string) => (/提交|创建|删除|支付|订单|登录|注册/.test(t) ? [/支付|订单/.test(t) ? "orders" : /登录|注册/.test(t) ? "session" : "content"] : []);
    const cases: Case[] = i.quality.criteria.map((c, n) => web ? {
      id: `c${n + 1}`, criterion: n, kind: "browser", title: c, mutates: mut(c), status: null,
      steps: [
        { desc: "打开页面", cmd: "deveye navigate goto {url} --wait-for main", status: null },
        { desc: "获取可交互元素快照，定位目标元素", cmd: "deveye snapshot --interactive-only --compact", status: null, locate: true },
        { desc: n % 2 ? "输入测试数据" : "点击目标元素", cmd: n % 2 ? 'deveye type --uid e{uid} "测试数据" --enter' : "deveye click --uid e{uid}", status: null },
        { desc: "等待结果出现", cmd: 'deveye wait --text "成功" --timeout 8000', status: null },
        { desc: `断言：${c}`, cmd: "deveye screenshot -o shots/{run}-{case}.png", status: null, assert: true },
      ],
    } : {
      id: `c${n + 1}`, criterion: n, kind: i.labels.includes("bug") ? "unit" : "check", title: c, mutates: [], status: null,
      steps: [{ desc: "准备", cmd: "pnpm test:setup", status: null }, { desc: `验证：${c}`, cmd: `pnpm vitest run -t "${c.slice(0, 16)}"`, status: null, assert: true }],
    });
    if (web) cases.push({ id: "health", criterion: null, kind: "health", title: "页面健康检查（控制台 / 网络 / 无障碍）", mutates: [], status: null, steps: [
      { desc: "控制台无报错", cmd: "deveye console --level error --compact", status: null, assert: true },
      { desc: "关键接口无 5xx", cmd: "deveye network --status 5xx --compact", status: null, assert: true },
      { desc: "无障碍审计无严重问题", cmd: "deveye accessibility --compact", status: null, assert: true },
    ] });
    return cases;
  }
  private envFor(r: QARun) { const e = this.proj(r.projectId)?.env; return r.pr && e?.preview ? e.preview.replace("{pr}", String(r.pr)) : e?.baseUrl || "CI"; }

  enqueue(i: IssueLike, trigger: string): string {
    const cases = this.buildCases(i);
    const r: QARun = { id: "qr_" + this.store.nextSeq("qa"), issueKey: i.key, title: i.title, projectId: i.projectId, pr: i.pr?.number ?? null, hotfix: i.labels.includes("hotfix"), priority: i.priority ?? 0, status: "queued", trigger, browser: null, env: "", account: null, mutates: [...new Set(cases.flatMap((c) => c.mutates))], cases, queuedAt: now(), wait: "等待调度", cursor: null, simulated: this.simulate };
    r.env = this.envFor(r);
    this.save(r);
    this.emit();
    setTimeout(() => this.tick(), 20);
    return r.id;
  }
  rerun(id: string, issue: IssueLike) { return this.enqueue(issue, "manual"); }
  cancel(id: string) {
    const r = this.run(id);
    if (!r || !["queued", "running"].includes(r.status)) return;
    if (r.taskId) this.runtime.cancel(r.taskId);
    this.finish(r, "cancelled");
  }
  wait(id: string, signal?: AbortSignal) {
    return new Promise<{ passed: boolean; note: string; cases: number }>((resolve, reject) => {
      const r = this.run(id);
      if (r && !["queued", "running"].includes(r.status)) return resolve(this.result(r));
      const list = this.waiters.get(id) ?? [];
      list.push(resolve);
      this.waiters.set(id, list);
      signal?.addEventListener("abort", () => { this.cancel(id); reject(new Error("已取消")); }, { once: true });
    });
  }
  private result(r: QARun) {
    const ok = r.cases.filter((c) => c.status === "passed").length;
    const bad = r.cases.find((c) => c.status === "failed");
    const err = bad?.note ?? bad?.steps.find((s) => s.status === "failed")?.error ?? r.status;
    return { passed: r.status === "passed", cases: r.cases.length, note: r.status === "passed" ? `验收 ${ok}/${r.cases.length} 通过${r.browser ? `（${r.browser === "local" ? "远程 Chrome" : "浏览器 " + r.browser}）` : r.env === "CI" ? "（CI）" : ""}` : r.status === "cancelled" ? "验收已取消" : `验收 ${ok}/${r.cases.length} 通过；「${bad?.title ?? "?"}」未通过：${err}` };
  }

  // ---------- 调度 ----------
  /** 浏览器验收的并发：远程 Chrome / 串行 / 真实 DevEye（单浏览器会话）时为 1 */
  private capacity() { const s = this.settings.get().qa; return s.browser === "local" || s.schedule === "serial" || (!this.simulate && this.deveye) ? 1 : s.maxParallel; }
  /** 不需要浏览器的验收（CI：单元测试 / 检查）不占浏览器，只受最大并行数限制 */
  private ciCapacity() { const s = this.settings.get().qa; return s.schedule === "serial" ? 1 : Math.max(1, s.maxParallel); }
  private conflict(a: QARun, b: QARun): string | null {
    if (a.env !== b.env || a.env === "CI") return null;
    const m = a.mutates.find((x) => b.mutates.includes(x));
    if (m) return `都会修改${MUT_LABEL[m] ?? m}数据`;
    if (a.account && a.account === b.account) return `测试账号 ${a.account} 正在被使用`;
    return null;
  }
  tick() {
    const s = this.settings.get().qa;
    let changed = false;
    const running = this.runs().filter((r) => r.status === "running");
    const queued = this.runs()
      .filter((r) => r.status === "queued")
      .sort((a, b) => priorityRank(a.priority) - priorityRank(b.priority) || Number(b.hotfix) - Number(a.hotfix) || a.queuedAt.localeCompare(b.queuedAt));
    for (const r of queued) {
      const prev = r.wait;
      const ci = this.envFor(r) === "CI";
      const busy = ci ? running.filter((x) => x.env === "CI").length >= this.ciCapacity() : running.filter((x) => x.env !== "CI").length >= this.capacity();
      if (ci && busy) r.wait = `并行已满（${this.ciCapacity()} 个 CI 验收）`;
      else if (busy) r.wait = s.browser === "local" ? "远程 Chrome 一次只执行一个验收" : s.schedule === "serial" ? "串行模式：等待前一个验收完成" : `并行已满（${this.capacity()} 个浏览器）`;
      else {
        r.env = this.envFor(r);
        const accounts = this.proj(r.projectId)?.env.accounts ?? [];
        const used = new Set(running.filter((x) => x.env === r.env).map((x) => x.account));
        r.account = accounts.find((a) => !used.has(a)) ?? accounts[0] ?? null;
        const c = running.map((x) => [x, this.conflict(x, r)] as const).find(([, why]) => why);
        if (c) r.wait = `与 ${c[0].issueKey} 冲突：${c[1]}`;
        else { r.wait = null; this.start(r); running.push(r); }
      }
      if (prev !== r.wait) { changed = true; this.save(r); }
    }
    if (changed) this.emit();
  }
  private browserFor(r: QARun): string | null {
    if (r.env === "CI") return null;
    const s = this.settings.get().qa;
    if (s.browser === "local") return "local";
    let b = this.browsers.find((x) => x.status === "idle");
    if (!b && this.browsers.length < s.maxParallel) { b = { id: `b-${this.browsers.length + 1}`, status: "idle", runId: null }; this.browsers.push(b); }
    if (!b) return null;
    b.status = "busy";
    b.runId = r.id;
    return b.id;
  }
  private start(r: QARun) {
    r.status = "running";
    r.startedAt = now();
    r.browser = this.browserFor(r);
    r.cursor = { c: 0, s: 0 };
    r.cases[0].status = "running";
    if (r.simulated) {
      const tries = this.runs().filter((x) => x.issueKey === r.issueKey && x.id !== r.id).length;
      const failRoll = this.forceFail ?? Math.random() < (tries ? 0.12 : 0.3);
      r.failAt = failRoll ? Math.floor(Math.random() * Math.max(1, r.cases.length - 1)) : -1;
      this.save(r);
      this.stepLater(r.id);
    } else {
      const agent = this.store.getAgent("tester") ? "tester" : this.store.listAgents()[0]?.name;
      if (!agent) return this.finish(r, "failed");
      const t = this.runtime.submit(agent, this.taskInput(r), { source: "qa" as Task["source"], priority: r.priority });
      r.taskId = t.id;
      this.save(r);
    }
    this.emit();
  }
  private taskInput(r: QARun) {
    return `请对工作项 ${r.issueKey}「${r.title}」做验收测试。\n\n测试环境：${r.env}${r.account ? `\n测试账号：${r.account}（密码通过 DevEye vault 引用，不要明文输出）` : ""}\n\n用例（逐条执行，每条完成后调用 report_case 汇报）：\n${r.cases.map((c) => `- ${c.id}：${c.title}`).join("\n")}\n\n${this.deveye && r.env !== "CI" ? "可以用 browser 工具执行 DevEye 命令操作浏览器（如 navigate goto <url>、snapshot --interactive-only、click --uid、type --uid、wait --text、console --level error）。" : "当前没有可用的浏览器，请根据交付内容和代码做检查型验收。"}\n全部用例汇报完后，用一句话给出总体结论。`;
  }
  private stepLater(id: string) { this.timers.set(id, setTimeout(() => this.step(id), this.stepMs + Math.random() * this.stepMs)); }
  private step(id: string) {
    const r = this.run(id);
    if (!r || r.status !== "running" || !r.cursor) return;
    const c = r.cases[r.cursor.c];
    const s = c.steps[r.cursor.s];
    s.ms = 250 + Math.floor(Math.random() * 900);
    s.at = now();
    if (s.locate) s.found = `e${12 + r.cursor.c * 3} ${["button「提交」", "textbox「搜索」", "link「详情」", "button「登录」"][r.cursor.c % 4]}`;
    const fail = !!s.assert && r.failAt === r.cursor.c;
    s.status = fail ? "failed" : "passed";
    if (fail) s.error = c.kind === "health" ? "控制台有 2 条报错：TypeError: Cannot read properties of undefined (reading 'map')" : c.kind === "browser" ? "断言失败：未找到文本「成功」，实际显示「网络错误，请重试」" : "核对未通过：交付内容缺少这一条标准要求的信息";
    r.cursor.s++;
    if (fail || r.cursor.s >= c.steps.length) {
      c.status = fail ? "failed" : "passed";
      if (fail) c.steps.slice(r.cursor.s).forEach((x) => (x.status = "skipped"));
      r.cursor = { c: r.cursor.c + 1, s: 0 };
      if (r.cursor.c < r.cases.length) r.cases[r.cursor.c].status = "running";
    }
    if (r.cursor.c >= r.cases.length) return this.finish(r);
    this.save(r);
    this.emit();
    this.stepLater(id);
  }
  private finishReal(r: QARun, t: Task) {
    for (const c of r.cases) if (c.status === null || c.status === "running") { c.status = "failed"; c.note = t.status === "completed" ? "测试智能体没有汇报这条用例" : `测试运行${t.status === "cancelled" ? "已取消" : `失败：${t.error}`}`; }
    this.finish(r);
  }
  private finish(r: QARun, status?: QARun["status"]) {
    clearTimeout(this.timers.get(r.id));
    this.timers.delete(r.id);
    r.status = status ?? (r.cases.some((c) => c.status === "failed") ? "failed" : "passed");
    r.endedAt = now();
    r.cursor = null;
    const b = this.browsers.find((x) => x.runId === r.id);
    if (b) { b.status = "idle"; b.runId = null; }
    this.save(r);
    const res = this.result(r);
    for (const w of this.waiters.get(r.id) ?? []) w(res);
    this.waiters.delete(r.id);
    this.emit();
    setTimeout(() => this.tick(), 30);
  }

  // ---------- 测试智能体的工具 ----------
  private registerTools() {
    const runOf = (task: Task) => this.runs().find((r) => r.taskId === (task.parentId ? task.rootId : task.id) && r.status === "running");
    this.runtime.addTool({
      name: "report_case",
      description: "汇报一条验收用例的结果。",
      input_schema: { type: "object", properties: { case_id: { type: "string" }, status: { type: "string", enum: ["passed", "failed"] }, note: { type: "string", description: "结论；失败时写明现象与复现步骤" } }, required: ["case_id", "status", "note"], additionalProperties: false },
    }, async (raw, { task }) => {
      const p = z.object({ case_id: z.string(), status: z.enum(["passed", "failed"]), note: z.string() }).safeParse(raw);
      if (!p.success) return { content: `参数不合法：${p.error.message}`, isError: true };
      const r = runOf(task);
      if (!r) return { content: "当前不在验收任务中", isError: true };
      const c = r.cases.find((x) => x.id === p.data.case_id);
      if (!c) return { content: `用例 ${p.data.case_id} 不存在，可用：${r.cases.map((x) => x.id).join("、")}`, isError: true };
      c.status = p.data.status;
      c.note = p.data.note;
      if (!c.steps.some((s) => s.status)) c.steps = [{ desc: p.data.note, cmd: "report_case", status: p.data.status, error: p.data.status === "failed" ? p.data.note : null, at: now() }];
      const next = r.cases.findIndex((x) => !x.status || x.status === "running");
      r.cursor = next >= 0 ? { c: next, s: 0 } : null;
      if (next >= 0) r.cases[next].status = "running";
      this.save(r);
      this.emit();
      return { content: `已记录 ${c.id}：${c.status}` };
    }, (task) => !!runOf(task));

    this.runtime.addTool({
      name: "browser",
      description: "执行一条 DevEye 浏览器命令（不含开头的 deveye），如：navigate goto https://example.com、snapshot --interactive-only --compact、click --uid e12、type --uid e7 \"文本\" --enter、wait --text \"成功\"、console --level error。",
      input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"], additionalProperties: false },
    }, async (raw, { task, signal }) => {
      const cmd = String((raw as { command?: string })?.command ?? "").trim();
      const args = splitArgs(cmd);
      const ALLOW = new Set(["navigate", "open", "snapshot", "screenshot", "click", "type", "fill-form", "select", "check", "hover", "scroll", "keyboard", "wait", "console", "network", "accessibility", "performance", "page-info", "dom", "eval", "tabs"]);
      if (!ALLOW.has(args[0] ?? "")) return { content: `不支持的命令：${args[0]}`, isError: true };
      const r = runOf(task);
      const started = Date.now();
      const out = await new Promise<{ ok: boolean; text: string }>((resolve) => {
        const child = execFile("deveye", args, { timeout: 60_000, maxBuffer: 4 * 1024 * 1024 }, (e, stdout, stderr) => resolve({ ok: !e, text: `${stdout}${stderr}`.slice(0, 8000) }));
        signal.addEventListener("abort", () => child.kill(), { once: true });
      });
      if (r?.cursor) {
        const c = r.cases[r.cursor.c];
        if (c.steps.every((s) => s.cmd !== "report_case")) {
          if (!c.steps.some((s) => s.at)) c.steps = [];
          c.steps.push({ desc: args[0], cmd: `deveye ${cmd}`, status: out.ok ? "passed" : "failed", ms: Date.now() - started, error: out.ok ? null : out.text.slice(0, 300), at: now() });
          this.save(r);
          this.emit();
        }
      }
      return { content: out.text || (out.ok ? "OK" : "命令失败"), isError: !out.ok };
    }, (task) => this.deveye && !!runOf(task));
  }
}

export function splitArgs(s: string): string[] {
  const out: string[] = [];
  let cur = "", q: string | null = null, has = false;
  for (const ch of s) {
    if (q) { if (ch === q) q = null; else cur += ch; continue; }
    if (ch === '"' || ch === "'") { q = ch; has = true; continue; }
    if (/\s/.test(ch)) { if (cur || has) out.push(cur); cur = ""; has = false; continue; }
    cur += ch;
  }
  if (cur || has) out.push(cur);
  return out;
}
