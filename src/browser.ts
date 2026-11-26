/**
 * 浏览器验收的后端。tester 的 browser 工具只认一套命令（与 DevEye CLI 的写法一致）：
 *   navigate goto <url> [--wait-for <css>] · navigate back|reload · open <url>
 *   snapshot [--interactive-only] [--compact] · page-info · accessibility · tabs
 *   click|hover|check|uncheck --uid eN · type --uid eN "文本" [--enter] · select --uid eN "选项"
 *   keyboard|press <键> · scroll [up|down] [--uid eN]
 *   wait --text "文字" | --selector <css> | --url-contains <s> [--timeout <ms>]
 *   console [--level error|warning] · network [--status 4xx|5xx|failed] · screenshot [-o 文件] [--full] · eval "<表达式>"
 *
 * 两种实现：
 * - BuiltinBrowser（默认）：Agent Hub 自带，基于 playwright-core + 本机 Chrome，不依赖任何外部工具。
 *   每次验收一个独立的浏览器上下文（cookie / 存储隔离），共用一个浏览器进程。
 * - DevEyeBrowser：装了 DevEye 时可选，转发给 deveye CLI（Hub 托管其服务端）。
 */
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";

export interface BrowserResult { ok: boolean; text: string }
export interface BrowserBackend {
  readonly name: string;
  /** 能否为验收建浏览器（找到 Chrome / 装了 DevEye 且配置了扩展） */
  available(): boolean;
  create(runId: string): Promise<string | null>;
  exec(runId: string, args: string[], signal?: AbortSignal): Promise<BrowserResult>;
  destroy(runId: string): Promise<void>;
  close(): Promise<void>;
}

/** 本机 Chrome / Chromium 的常见位置 */
const CHROME_PATHS: Record<string, string[]> = {
  darwin: ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium", "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"],
  linux: ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/snap/bin/chromium", "/usr/bin/microsoft-edge"],
  win32: ["C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe", "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"],
};
export function findChrome(explicit?: string | null): string | null {
  if (explicit) return existsSync(explicit) ? explicit : null;
  return (CHROME_PATHS[process.platform] ?? []).find((p) => existsSync(p)) ?? null;
}

/** 解析 --flag value / --flag（布尔）与位置参数 */
export function parseArgs(args: string[]): { pos: string[]; flags: Record<string, string | true> } {
  const pos: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let n = 0; n < args.length; n++) {
    const a = args[n];
    if (a.startsWith("--") || (a.startsWith("-") && a.length === 2 && !/^-\d/.test(a))) {
      const key = a.replace(/^-+/, "");
      const next = args[n + 1];
      const boolean = ["interactive-only", "compact", "enter", "full", "clear", "submit", "viewport-only"].includes(key);
      if (!boolean && next !== undefined && !next.startsWith("--")) { flags[key] = next; n++; } else flags[key] = true;
    } else pos.push(a);
  }
  return { pos, flags };
}

interface Session { context: BrowserContext; page: Page; console: { type: string; text: string }[]; network: { status: number | string; method: string; url: string }[]; shots: number; inflight: number; lastNet: number }

/** 在页面里给可交互元素编号（data-hub-uid=eN），返回列表；每次快照重新编号 */
const SNAPSHOT_JS = `(() => {
  const old = document.querySelectorAll('[data-hub-uid]');
  old.forEach((el) => el.removeAttribute('data-hub-uid'));
  const sel = 'a[href],button,input:not([type=hidden]),textarea,select,summary,[role=button],[role=link],[role=checkbox],[role=radio],[role=tab],[role=menuitem],[role=option],[role=switch],[role=textbox],[role=combobox],[role=slider],[contenteditable=""],[contenteditable=true],[tabindex]:not([tabindex="-1"])';
  const visible = (el) => {
    const s = getComputedStyle(el);
    if (s.visibility === 'hidden' || s.display === 'none' || el.closest('[aria-hidden=true]')) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const text = (s) => (s || '').replace(/\\s+/g, ' ').trim();
  const labelOf = (el) => {
    if (el.getAttribute('aria-label')) return el.getAttribute('aria-label');
    const by = el.getAttribute('aria-labelledby');
    if (by) return by.split(' ').map((id) => document.getElementById(id)?.innerText || '').join(' ');
    if (el.id) { const l = document.querySelector('label[for="' + CSS.escape(el.id) + '"]'); if (l) return l.innerText; }
    const wrap = el.closest('label'); if (wrap && wrap !== el) return wrap.innerText;
    const item = el.closest('.el-form-item'); if (item) { const l = item.querySelector('.el-form-item__label'); if (l) return l.innerText; }
    return el.getAttribute('placeholder') || el.innerText || el.getAttribute('title') || el.getAttribute('alt') || (el.tagName === 'INPUT' && ['button','submit'].includes(el.type) ? el.value : '') || '';
  };
  const roleOf = (el) => {
    const r = el.getAttribute('role'); if (r) return r;
    const t = el.tagName.toLowerCase();
    if (t === 'a') return 'link';
    if (t === 'button' || t === 'summary') return 'button';
    if (t === 'select') return 'combobox';
    if (t === 'textarea') return 'textbox';
    if (t === 'input') { const ty = (el.type || 'text').toLowerCase(); return ty === 'checkbox' ? 'checkbox' : ty === 'radio' ? 'radio' : ['button','submit','reset'].includes(ty) ? 'button' : ty === 'range' ? 'slider' : 'textbox'; }
    if (el.isContentEditable) return 'textbox';
    return 'generic';
  };
  const out = [];
  let n = 0;
  for (const el of document.querySelectorAll(sel)) {
    if (!visible(el)) continue;
    const uid = 'e' + (++n);
    el.setAttribute('data-hub-uid', uid);
    const role = roleOf(el);
    const item = { uid, role, name: text(labelOf(el)).slice(0, 80) };
    if (role === 'textbox' || role === 'combobox') item.value = el.type === 'password' ? (el.value ? '••••' : '') : text(el.value ?? el.innerText).slice(0, 60);
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') item.disabled = true;
    if (el.checked || el.getAttribute('aria-checked') === 'true' || el.getAttribute('aria-selected') === 'true') item.checked = true;
    out.push(item);
  }
  const alerts = [...document.querySelectorAll('[role=alert],[role=status],.el-message,.el-notification,.el-form-item__error,.el-alert')]
    .filter(visible).map((el) => text(el.innerText)).filter(Boolean).slice(0, 10);
  const headings = [...document.querySelectorAll('h1,h2,h3')].filter(visible).map((el) => el.tagName.toLowerCase() + ' ' + text(el.innerText)).slice(0, 20);
  return { title: document.title, url: location.href, items: out, alerts, headings, body: text(document.body?.innerText).slice(0, 3000) };
})()`;

interface SnapshotData { title: string; url: string; items: { uid: string; role: string; name: string; value?: string; disabled?: boolean; checked?: boolean }[]; alerts: string[]; headings: string[]; body: string }

function formatSnapshot(s: SnapshotData, interactiveOnly: boolean): string {
  const lines = [`页面：${s.title || "（无标题）"}（${s.url}）`];
  if (s.alerts.length) lines.push(`提示：${s.alerts.join(" ｜ ")}`);
  if (!interactiveOnly && s.headings.length) lines.push("标题：", ...s.headings.map((h) => `  ${h}`));
  lines.push("---");
  for (const it of s.items) {
    const extra = [it.value !== undefined ? `="${it.value}"` : "", it.disabled ? "[disabled]" : "", it.checked ? "[checked]" : ""].filter(Boolean).join(" ");
    lines.push(`[${it.uid}] ${it.role} "${it.name}"${extra ? ` ${extra}` : ""}`);
  }
  if (!s.items.length) lines.push("（没有可交互元素）");
  if (!interactiveOnly) lines.push("---", `正文：${s.body}`);
  return lines.join("\n");
}

export class BuiltinBrowser implements BrowserBackend {
  readonly name = "builtin";
  private browser: Promise<Browser> | null = null;
  private sessions = new Map<string, Session>();
  private opts: { headless: () => boolean; chromePath: () => string | null; shotDir: string };
  constructor(opts: BuiltinBrowser["opts"]) { this.opts = opts; }

  available() { return !!findChrome(this.opts.chromePath()); }

  private launch(): Promise<Browser> {
    if (!this.browser) {
      const executablePath = findChrome(this.opts.chromePath());
      if (!executablePath) return Promise.reject(new Error("找不到 Chrome：请安装 Chrome，或在测试设置里填写 Chrome 路径"));
      this.browser = chromium.launch({ executablePath, headless: this.opts.headless() }).then((b) => {
        b.on("disconnected", () => { this.browser = null; });
        return b;
      });
      this.browser.catch(() => { this.browser = null; });
    }
    return this.browser;
  }

  async create(runId: string): Promise<string | null> {
    await this.destroy(runId);
    const browser = await this.launch();
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-CN", timezoneId: "Asia/Shanghai" });
    const page = await context.newPage();
    const s: Session = { context, page, console: [], network: [], shots: 0, inflight: 0, lastNet: 0 };
    page.on("request", () => { s.inflight++; s.lastNet = Date.now(); });
    const done = () => { s.inflight = Math.max(0, s.inflight - 1); s.lastNet = Date.now(); };
    page.on("requestfinished", done);
    page.on("console", (m) => {
      // 「Failed to load resource」这类消息本身不带地址，补上出错的资源，方便判断是否无害（如 favicon）
      const where = /^Failed to load resource/.test(m.text()) && m.location().url ? `：${m.location().url}` : "";
      s.console.push({ type: m.type(), text: `${m.text()}${where}`.slice(0, 500) });
      s.console.splice(0, Math.max(0, s.console.length - 200));
    });
    page.on("pageerror", (e) => s.console.push({ type: "error", text: `未捕获异常：${e.message}`.slice(0, 500) }));
    page.on("response", (r) => { if (r.status() >= 400) s.network.push({ status: r.status(), method: r.request().method(), url: r.url().slice(0, 300) }); });
    page.on("requestfailed", (r) => { done(); s.network.push({ status: `failed（${r.failure()?.errorText ?? "?"}）`, method: r.method(), url: r.url().slice(0, 300) }); });
    this.sessions.set(runId, s);
    return `hub-${runId}`;
  }

  async destroy(runId: string) {
    const s = this.sessions.get(runId);
    this.sessions.delete(runId);
    await s?.context.close().catch(() => {});
  }

  async close() {
    for (const id of [...this.sessions.keys()]) await this.destroy(id);
    const b = this.browser;
    this.browser = null;
    await (await b?.catch(() => null))?.close().catch(() => {});
  }

  async exec(runId: string, args: string[], signal?: AbortSignal): Promise<BrowserResult> {
    const s = this.sessions.get(runId);
    if (!s) return { ok: false, text: "这次验收没有可用的浏览器" };
    const work = this.run(s, runId, args);
    const aborted = new Promise<BrowserResult>((res) => signal?.addEventListener("abort", () => res({ ok: false, text: "已取消" }), { once: true }));
    try { return await Promise.race([work, aborted]); }
    catch (e) { return { ok: false, text: (e as Error).message.split("\n").slice(0, 6).join("\n").slice(0, 1500) }; }
  }

  private async snapshot(page: Page, interactiveOnly: boolean): Promise<string> {
    return formatSnapshot(await page.evaluate(SNAPSHOT_JS) as SnapshotData, interactiveOnly);
  }
  /** 操作后等页面稳定（进行中的请求都结束且安静 300ms，最多 5 秒），再返回可交互元素快照（省一次 snapshot 调用） */
  private async after(s: Session, what: string): Promise<BrowserResult> {
    const t0 = Date.now();
    await s.page.waitForTimeout(150);
    while (Date.now() - t0 < 5000 && (s.inflight > 0 || Date.now() - s.lastNet < 300)) await s.page.waitForTimeout(100);
    await s.page.waitForLoadState("domcontentloaded", { timeout: 3000 }).catch(() => {});
    return { ok: true, text: `${what}\n\n${await this.snapshot(s.page, true)}` };
  }

  private async run(s: Session, runId: string, args: string[]): Promise<BrowserResult> {
    const { pos, flags } = parseArgs(args);
    const [cmd, ...rest] = pos;
    const page = s.page;
    const timeout = Math.min(Number(flags.timeout) || 15_000, 120_000);
    const el = () => {
      const uid = typeof flags.uid === "string" ? flags.uid : null;
      if (!uid) throw new Error("缺少 --uid（先用 snapshot 拿到元素编号）");
      return page.locator(`[data-hub-uid="${uid.replace(/[^\w-]/g, "")}"]`).first();
    };
    switch (cmd) {
      case "navigate":
      case "open": {
        const sub = cmd === "open" ? "goto" : rest[0];
        const url = cmd === "open" ? rest[0] : rest[1];
        if (sub === "back") { await page.goBack({ timeout }); return this.after(s, "已后退"); }
        if (sub === "reload") { await page.reload({ timeout }); return this.after(s, "已刷新"); }
        if (!url) throw new Error("用法：navigate goto <url>");
        await page.goto(url, { timeout, waitUntil: "domcontentloaded" });
        if (typeof flags["wait-for"] === "string") await page.locator(flags["wait-for"]).first().waitFor({ timeout });
        return this.after(s, `已打开 ${page.url()}`);
      }
      case "snapshot": return { ok: true, text: await this.snapshot(page, !!flags["interactive-only"]) };
      case "page-info": return { ok: true, text: `标题：${await page.title()}\n地址：${page.url()}\n视口：${JSON.stringify(page.viewportSize())}` };
      case "tabs": return { ok: true, text: `Tabs (1):\n● [1] ${await page.title()} (${page.url()})` };
      case "accessibility": return { ok: true, text: (await page.locator("body").ariaSnapshot({ timeout })).slice(0, 8000) };
      case "click": await el().click({ timeout }); return this.after(s, `已点击 ${flags.uid}`);
      case "hover": await el().hover({ timeout }); return this.after(s, `已悬停 ${flags.uid}`);
      case "check": await el().check({ timeout }); return this.after(s, `已勾选 ${flags.uid}`);
      case "uncheck": await el().uncheck({ timeout }); return this.after(s, `已取消勾选 ${flags.uid}`);
      case "type":
      case "fill": {
        const text = rest[0] ?? "";
        const target = el();
        await target.fill(text, { timeout }).catch(async () => { await target.click({ timeout }); await page.keyboard.type(text); });
        if (flags.enter || flags.submit) await target.press("Enter", { timeout });
        return this.after(s, `已在 ${flags.uid} 输入 ${text.length} 个字符${flags.enter || flags.submit ? "并回车" : ""}`);
      }
      case "select": {
        const v = rest[0] ?? "";
        await el().selectOption({ label: v }, { timeout }).catch(() => el().selectOption(v, { timeout }));
        return this.after(s, `已在 ${flags.uid} 选择 ${v}`);
      }
      case "keyboard":
      case "press": await page.keyboard.press(rest[0] ?? "Enter"); return this.after(s, `已按 ${rest[0] ?? "Enter"}`);
      case "scroll": {
        if (typeof flags.uid === "string") await el().scrollIntoViewIfNeeded({ timeout });
        else await page.mouse.wheel(0, (rest[0] ?? flags.direction) === "up" ? -800 : 800);
        return this.after(s, "已滚动");
      }
      case "wait": {
        if (typeof flags.text === "string") await page.getByText(flags.text).first().waitFor({ state: "visible", timeout });
        else if (typeof flags.selector === "string") await page.locator(flags.selector).first().waitFor({ state: "visible", timeout });
        else if (typeof flags["url-contains"] === "string") { const want = flags["url-contains"]; await page.waitForURL((u) => u.toString().includes(want), { timeout }); }
        else await page.waitForTimeout(Math.min(Number(rest[0]) || 1000, 10_000));
        return { ok: true, text: `等到了：${flags.text ?? flags.selector ?? flags["url-contains"] ?? "时间到"}` };
      }
      case "console": {
        const level = typeof flags.level === "string" ? flags.level : null;
        const list = s.console.filter((m) => !level || m.type === level || (level === "warning" && m.type === "warn"));
        return { ok: true, text: list.length ? list.map((m) => `[${m.type}] ${m.text}`).join("\n") : `没有${level ? ` ${level} 级别的` : ""}控制台消息` };
      }
      case "network": {
        const want = typeof flags.status === "string" ? flags.status : null;
        const list = s.network.filter((r) => !want || (want === "failed" ? typeof r.status === "string" : String(r.status).startsWith(want.replace(/x+$/i, ""))));
        return { ok: true, text: list.length ? list.map((r) => `${r.status} ${r.method} ${r.url}`).join("\n") : "没有异常的网络请求（状态码 ≥ 400 或失败）" };
      }
      case "screenshot": {
        mkdirSync(this.opts.shotDir, { recursive: true });
        const file = typeof flags.o === "string" || typeof flags.output === "string"
          ? join(this.opts.shotDir, String(flags.o ?? flags.output).replace(/[^\w.-]/g, "_"))
          : join(this.opts.shotDir, `${runId}-${++s.shots}.png`);
        await page.screenshot({ path: file, fullPage: !!flags.full, timeout });
        return { ok: true, text: `截图已保存：${file}` };
      }
      case "eval": {
        const v = await page.evaluate(rest.join(" "));
        return { ok: true, text: typeof v === "string" ? v.slice(0, 8000) : JSON.stringify(v, null, 1)?.slice(0, 8000) ?? "undefined" };
      }
      default:
        return { ok: false, text: `不支持的命令：${cmd ?? "（空）"}` };
    }
  }
}

/** 可选后端：DevEye（Hub 托管其服务端，专用端口 9899；需要 DevEye 支持非默认端口） */
export class DevEyeBrowser implements BrowserBackend {
  readonly name = "deveye";
  private ids = new Map<string, string>();
  private server: ChildProcess | null = null;
  private ready: Promise<boolean> | null = null;
  private opts: { extensionPath: () => string | null; installed: () => boolean; port?: number };
  constructor(opts: DevEyeBrowser["opts"]) { this.opts = opts; }
  private get url() { return `ws://127.0.0.1:${this.opts.port ?? 9899}`; }
  available() { const e = this.opts.extensionPath(); return this.opts.installed() && !!e && existsSync(e); }

  private cli(args: string[], env: Record<string, string> = {}, timeoutMs = 60_000, signal?: AbortSignal): Promise<BrowserResult> {
    return new Promise((resolve) => {
      const child = execFile("deveye", args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, DEVEYE_SERVER: this.url, ...env } },
        (e, stdout, stderr) => resolve({ ok: !e, text: `${stdout}${stderr}`.slice(0, 8000) }));
      signal?.addEventListener("abort", () => child.kill(), { once: true });
    });
  }
  private ensure(): Promise<boolean> {
    if (this.ready) return this.ready;
    const ext = this.opts.extensionPath();
    if (!ext) return Promise.resolve(false);
    this.ready = (async () => {
      if ((await this.cli(["browser", "list", "--json"], {}, 5000)).ok) return true; // Hub 之前起的还在
      const child = spawn("deveye", ["server", "start", "--port", String(this.opts.port ?? 9899), "--extension-path", ext], { detached: true, stdio: "ignore" });
      this.server = child;
      child.once("exit", () => { if (this.server === child) { this.server = null; this.ready = null; } });
      for (let n = 0; n < 30; n++) {
        if (child.exitCode !== null) return false;
        if ((await this.cli(["browser", "list", "--json"], {}, 5000)).ok) return true;
        await new Promise((r) => setTimeout(r, 500));
      }
      return false;
    })();
    this.ready.then((ok) => { if (!ok) this.ready = null; }).catch(() => { this.ready = null; });
    return this.ready;
  }
  async create(runId: string) {
    if (!(await this.ensure())) return null;
    const out = await this.cli(["browser", "create", "--headless", "--json"], {}, 60_000);
    let id: string | null = null;
    try { const j = JSON.parse(out.text.slice(out.text.indexOf("{"))); id = j.browserId ?? j.id ?? null; } catch { /* 输出不是 JSON */ }
    if (id) this.ids.set(runId, id);
    return id;
  }
  exec(runId: string, args: string[], signal?: AbortSignal) {
    const id = this.ids.get(runId);
    return id ? this.cli(args, { DEVEYE_BROWSER_ID: id }, 60_000, signal) : Promise.resolve({ ok: false, text: "这次验收没有可用的浏览器" });
  }
  async destroy(runId: string) {
    const id = this.ids.get(runId);
    this.ids.delete(runId);
    if (id) await this.cli(["browser", "destroy", id], {}, 20_000);
  }
  async close() {
    for (const id of [...this.ids.keys()]) await this.destroy(id);
    if (this.server?.pid) { try { process.kill(-this.server.pid, "SIGTERM"); } catch { this.server.kill("SIGTERM"); } }
  }
}
