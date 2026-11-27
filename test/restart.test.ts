/**
 * 服务重启：新进程的启动参数正确（同一命令、同一目录、带重启标记）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { restartSpec } from "../src/restart.ts";

test("重启参数：沿用当前命令与参数，标记 HUB_RESTART 以便重试端口", () => {
  const spec = restartSpec(["src/index.ts"], { execPath: "/usr/bin/node", cwd: "/srv/hub", env: { PATH: "/bin", HUB_DATA: "/data" } });
  assert.equal(spec.command, "/usr/bin/node");
  assert.deepEqual(spec.args, ["src/index.ts"]);
  assert.equal(spec.cwd, "/srv/hub");
  assert.equal(spec.env.HUB_RESTART, "1");
  assert.equal(spec.env.HUB_DATA, "/data", "保留原有环境变量");
  assert.equal(spec.detached, true, "脱离父进程，父进程退出后继续运行");
  assert.equal(spec.stdio, "inherit");
});

test("重启参数：不修改传入的环境对象", () => {
  const env = { PATH: "/bin" };
  restartSpec([], { env });
  assert.equal((env as Record<string, string>).HUB_RESTART, undefined);
});

test("重启：给了日志文件时新进程的输出写进文件，不依赖可能已关闭的终端", async () => {
  const { mkdtempSync, readFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { spawnReplacement } = await import("../src/restart.ts");
  const log = join(mkdtempSync(join(tmpdir(), "hub-restart-")), "logs", "hub.log");
  const spec = restartSpec(["-e", "console.log('新进程已启动')"], { execPath: process.execPath, cwd: process.cwd(), env: process.env, logFile: log });
  const child = spawnReplacement(spec);
  await new Promise((r) => child.once("exit", r));
  assert.match(readFileSync(log, "utf8"), /新进程已启动/);
});
