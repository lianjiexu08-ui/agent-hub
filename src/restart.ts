/**
 * 服务重启：由正在运行的进程拉起一个新的自己，然后退出。
 * 新进程会重试绑定端口，直到旧进程释放（避免 EADDRINUSE）。
 *
 * 说明：重启会中断正在运行的任务。重启后启动流程会把这些任务标记为失败，
 * 由工作项 reconcile 与哨兵按原有规则重试或上报，不会留下「永远运行中」的记录。
 */
import { spawn } from "node:child_process";
import { mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";

export interface RestartSpec {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  detached: boolean;
  stdio: "inherit" | "ignore";
  /** 有值时新进程的输出追加写到这个文件，而不是继承本进程的（见 spawnReplacement） */
  logFile?: string;
}

/** 生成新进程的启动参数（纯函数，便于测试） */
export function restartSpec(
  argv: string[] = process.argv.slice(1),
  o: { execPath?: string; cwd?: string; env?: NodeJS.ProcessEnv; logFile?: string } = {},
): RestartSpec {
  return {
    command: o.execPath ?? process.execPath,
    args: argv,
    cwd: o.cwd ?? process.cwd(),
    // 标记为重启：新进程据此在端口被占用时重试，而不是直接失败
    env: { ...(o.env ?? process.env), HUB_RESTART: "1" },
    detached: true,
    stdio: "inherit",
    logFile: o.logFile,
  };
}

/** 拉起替代进程并解除与本进程的关系（父进程随后自行退出） */
export function spawnReplacement(spec: RestartSpec = restartSpec()) {
  // 继承输出有隐患：最初启动 Hub 的终端 / 管道可能早就关了，新进程一写日志就因 EPIPE 退出，而且不留痕迹。
  // 给了日志文件就写到文件里
  let stdio: RestartSpec["stdio"] | ["ignore", number, number] = spec.stdio;
  if (spec.logFile) {
    try { mkdirSync(dirname(spec.logFile), { recursive: true }); const fd = openSync(spec.logFile, "a"); stdio = ["ignore", fd, fd]; }
    catch { stdio = "ignore"; }
  }
  const child = spawn(spec.command, spec.args, { cwd: spec.cwd, env: spec.env, detached: spec.detached, stdio });
  child.unref();
  return child;
}
