/**
 * 工作项预览环境 + 浏览器：让测试阶段能真正打开页面验收。
 *
 * - 预览：在被测工作项的 worktree 里执行项目配置的预览命令（如 scripts/preview.sh），
 *   传入 PREVIEW_PORT / PREVIEW_API_PORT / HUB_ISSUE_SLUG，端口每次现分配，多个工作项可以同时预览。
 *   以「前端地址返回非 5xx」判断就绪；测试结束对整个进程组发 SIGTERM（5 秒后 SIGKILL）。
 * - 浏览器：Hub 自己托管一个 DevEye 服务端（前台子进程、专用端口 9899，状态文件与 socket 按端口独立，
 *   不影响用户自己在 9888 开的 DevEye），每次测试新建一个无头浏览器实例，测完销毁。
 *   tester 的 browser 工具带上 DEVEYE_SERVER / DEVEYE_BROWSER_ID。
 *   需要 DevEye 包含 fix/server-daemon-port-isolation（托管浏览器能连非默认端口、状态文件按端口隔离）。
 */
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdirSync } from "node:fs";

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
  private browsers = new Map<string, string>();
  private devEye: ChildProcess | null = null;
  private devEyeReady: Promise<boolean> | null = null;
  private opts: {
    tmpDir: string;
    /** DevEye Chrome 扩展的 dist 目录；没有则不做浏览器 */
    extensionPath: () => string | null;
    /** Hub 托管的 DevEye 服务端端口 */
    devEyePort?: number;
    readyTimeoutMs?: number;
  };
  constructor(opts: Previews["opts"]) { this.opts = opts; }

  /** 配置了 DevEye 扩展目录且目录存在：才能为验收建浏览器 */
  hasExtension() { const e = this.opts.extensionPath(); return !!e && existsSync(e); }
  get devEyeServer() { return `ws://127.0.0.1:${this.opts.devEyePort ?? 9899}`; }

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

  /** 为这次测试准备一个无头浏览器；DevEye 不可用时返回 null */
  async browser(runId: string): Promise<string | null> {
    if (!(await this.ensureDevEye())) return null;
    const out = await this.deveye(["browser", "create", "--headless", "--json"], {}, 60_000);
    const id = (() => { try { const j = JSON.parse(out.text.slice(out.text.indexOf("{"))); return j.browserId ?? j.id ?? null; } catch { return null; } })();
    if (id) this.browsers.set(runId, id);
    return id;
  }

  /** 测试结束：关预览、销毁浏览器 */
  stop(runId: string) {
    const child = this.procs.get(runId);
    if (child) {
      this.procs.delete(runId);
      killGroup(child, "SIGTERM");
      setTimeout(() => killGroup(child, "SIGKILL"), 5000).unref?.();
    }
    const b = this.browsers.get(runId);
    if (b) { this.browsers.delete(runId); void this.deveye(["browser", "destroy", b], {}, 20_000); }
  }

  /** Hub 退出时：关掉所有预览和托管的 DevEye 服务端 */
  stopAll() {
    for (const id of [...this.procs.keys()]) this.stop(id);
    if (this.devEye) killGroup(this.devEye, "SIGTERM");
  }

  /** 以 tester 的身份执行 DevEye 命令（指向 Hub 托管的服务端与这次测试的浏览器） */
  deveye(args: string[], env: Record<string, string>, timeoutMs = 60_000, signal?: AbortSignal): Promise<{ ok: boolean; text: string }> {
    return new Promise((resolve) => {
      const child = execFile("deveye", args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, DEVEYE_SERVER: this.devEyeServer, ...env } },
        (e, stdout, stderr) => resolve({ ok: !e, text: `${stdout}${stderr}`.slice(0, 8000) }));
      signal?.addEventListener("abort", () => child.kill(), { once: true });
    });
  }
  browserIdOf(runId: string) { return this.browsers.get(runId) ?? null; }

  /** 托管的 DevEye 服务端：没在跑就以前台子进程启动（带扩展目录，才能管理浏览器） */
  private ensureDevEye(): Promise<boolean> {
    if (this.devEye && this.devEye.exitCode === null && this.devEyeReady) return this.devEyeReady;
    const ext = this.opts.extensionPath();
    if (!ext || !existsSync(ext)) return Promise.resolve(false);
    mkdirSync(this.opts.tmpDir, { recursive: true });
    const port = this.opts.devEyePort ?? 9899;
    // 专用端口上已经有 Hub 之前起的服务端（比如 Hub 重启过）：直接复用
    this.devEyeReady = this.deveye(["browser", "list", "--json"], {}, 5000).then(async (probe) => probe.ok || this.spawnDevEye(ext, port));
    return this.devEyeReady;
  }
  private spawnDevEye(ext: string, port: number): Promise<boolean> {
    // 非默认端口的 PID / 信息 / 日志文件和 IPC socket 都按端口独立（/tmp/deveye-<port>.sock），不会覆盖用户自己那份
    const child = spawn("deveye", ["server", "start", "--port", String(port), "--extension-path", ext], { detached: true, stdio: "ignore" });
    this.devEye = child;
    child.once("exit", () => { if (this.devEye === child) { this.devEye = null; this.devEyeReady = null; } });
    this.devEyeReady = (async () => {
      for (let n = 0; n < 30; n++) {
        if (child.exitCode !== null) return false;
        const r = await this.deveye(["browser", "list", "--json"], {}, 5000);
        if (r.ok) return true;
        await new Promise((res) => setTimeout(res, 500));
      }
      return false;
    })();
    return this.devEyeReady;
  }
}
