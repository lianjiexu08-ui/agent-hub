/**
 * 工作项预览环境 + 浏览器：让测试阶段能真正打开页面验收。
 *
 * - 预览：在被测工作项的 worktree 里执行项目配置的预览命令（如 scripts/preview.sh），
 *   传入 PREVIEW_PORT / PREVIEW_API_PORT / HUB_ISSUE_SLUG，端口每次现分配，多个工作项可以同时预览。
 *   以「前端地址返回非 5xx」判断就绪；测试结束对整个进程组发 SIGTERM（5 秒后 SIGKILL）。
 * - 浏览器：交给 BrowserBackend（见 browser.ts）。默认是 Hub 内置的浏览器驱动（playwright-core + 本机 Chrome），
 *   可选 DevEye。每次验收一个独立的浏览器会话，测完销毁。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import type { BrowserBackend, BrowserResult } from "./browser.ts";

export interface PreviewHandle { url: string; port: number; apiPort: number; log: string; ready: boolean; error?: string }

/** 向系统要一个空闲端口 */
export function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createServer();
    s.once("error", rej);
    s.listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => res(p)); });
  });
}

/** 结束整个进程组（预览脚本会再拉起 uvicorn / vite 等子进程） */
function killGroup(child: ChildProcess, sig: NodeJS.Signals) {
  if (!child.pid) return;
  try { process.kill(-child.pid, sig); } catch { try { child.kill(sig); } catch { /* 已退出 */ } }
}

async function waitReady(url: string, child: ChildProcess, timeoutMs: number): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (child.exitCode !== null || child.signalCode !== null) return false;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(3000), redirect: "manual" });
      if (res.status < 500) return true;
    } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

export class Previews {
  private procs = new Map<string, ChildProcess>();
  /** 每次验收用的是哪个浏览器后端（中途切换设置也不影响已经建好的会话） */
  private sessions = new Map<string, BrowserBackend>();
  private opts: {
    tmpDir: string;
    /** 当前选用的浏览器后端 */
    backend: () => BrowserBackend;
    /** 全部后端（退出时都要关） */
    backends?: () => BrowserBackend[];
    readyTimeoutMs?: number;
  };
  constructor(opts: Previews["opts"]) { this.opts = opts; }

  /** 当前后端能为验收建浏览器 */
  hasBrowser() { return this.opts.backend().available(); }
  engine() { return this.opts.backend().name; }

  /** 启动预览：返回地址与日志尾部；失败时 ready=false 并带原因（不抛错，测试照常进行、退化为检查型验收） */
  async start(runId: string, cwd: string, cmd: string, env: Record<string, string>): Promise<PreviewHandle> {
    const port = await freePort();
    const apiPort = await freePort();
    const url = `http://127.0.0.1:${port}`;
    let log = "";
    const child = spawn("/bin/bash", ["-lc", cmd], {
      cwd, detached: true, stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...env, PREVIEW_PORT: String(port), PREVIEW_API_PORT: String(apiPort), CI: "1" },
    });
    this.procs.set(runId, child);
    const push = (b: Buffer) => { log = (log + String(b)).slice(-6000); };
    child.stdout?.on("data", push);
    child.stderr?.on("data", push);
    child.once("exit", () => { if (this.procs.get(runId) === child) this.procs.delete(runId); });
    const ready = await waitReady(url, child, this.opts.readyTimeoutMs ?? 180_000);
    if (!ready) {
      this.stop(runId);
      const why = child.exitCode !== null ? `预览命令已退出（退出码 ${child.exitCode}）` : "等待超时，前端地址一直不可访问";
      return { url, port, apiPort, log: log.slice(-2000), ready: false, error: why };
    }
    return { url, port, apiPort, log: log.slice(-2000), ready: true };
  }

  /** 为这次验收准备一个浏览器会话；不可用时返回 null（error 里是原因） */
  async browser(runId: string): Promise<string | null> {
    const b = this.opts.backend();
    if (!b.available()) return null;
    const id = await b.create(runId);
    if (id) this.sessions.set(runId, b);
    return id;
  }
  browserIdOf(runId: string) { return this.sessions.has(runId) ? runId : null; }

  /** 以 tester 的身份执行一条浏览器命令；这次验收还没有浏览器时先建一个 */
  async exec(runId: string, args: string[], signal?: AbortSignal): Promise<BrowserResult> {
    if (!this.sessions.has(runId)) {
      try { if (!(await this.browser(runId))) return { ok: false, text: "没有可用的浏览器（找不到 Chrome，或所选的 DevEye 不可用）" }; }
      catch (e) { return { ok: false, text: `浏览器启动失败：${(e as Error).message}` }; }
    }
    return this.sessions.get(runId)!.exec(runId, args, signal);
  }

  /** 测试结束：关预览、销毁浏览器会话 */
  stop(runId: string) {
    const child = this.procs.get(runId);
    if (child) {
      this.procs.delete(runId);
      killGroup(child, "SIGTERM");
      setTimeout(() => killGroup(child, "SIGKILL"), 5000).unref?.();
    }
    const b = this.sessions.get(runId);
    if (b) { this.sessions.delete(runId); void b.destroy(runId).catch(() => {}); }
  }

  /** Hub 退出时：关掉所有预览和浏览器 */
  async stopAll() {
    for (const id of [...this.procs.keys(), ...this.sessions.keys()]) this.stop(id);
    for (const b of this.opts.backends?.() ?? [this.opts.backend()]) await b.close().catch(() => {});
  }
}
