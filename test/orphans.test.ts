import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/db.ts";
import { Settings } from "../src/settings.ts";
import { CliRunner } from "../src/cli.ts";

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const exited = (p: ReturnType<typeof spawn>) => new Promise<void>((r) => (p.exitCode !== null || p.signalCode !== null ? r() : p.once("exit", () => r())));

test("启动时清理上次遗留的 CLI 进程；进程号对不上命令时不误杀", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "hub-orphan-"));
  const orphan = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
  const bystander = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
  try {
    // 遗留记录：一个确实是 sleep（应清理），一个登记成 claude 但实际是 sleep（进程号被复用，不能动）
    writeFileSync(join(tmp, "cli-pids.json"), JSON.stringify([{ pid: orphan.pid, bin: "sleep" }, { pid: bystander.pid, bin: "claude" }, { pid: 999999, bin: "sleep" }]));
    const runner = new CliRunner(new Settings(new Store(":memory:")), { tmpDir: tmp, hubUrl: () => "", cwdFor: () => null });
    assert.equal(runner.reapOrphans(), 1);
    await exited(orphan);
    assert.equal(alive(orphan.pid!), false, "遗留的 CLI 被结束");
    assert.equal(alive(bystander.pid!), true, "命令对不上的进程不动");
    assert.equal(existsSync(join(tmp, "cli-pids.json")), false, "记录清空");
    assert.equal(runner.reapOrphans(), 0, "没有记录时什么都不做");
  } finally {
    try { process.kill(-orphan.pid!, "SIGKILL"); } catch { /* 已结束 */ }
    try { process.kill(-bystander.pid!, "SIGKILL"); } catch { /* 已结束 */ }
  }
});
