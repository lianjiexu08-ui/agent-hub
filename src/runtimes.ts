/**
 * 运行底座检测：智能体除了用内置的 Claude API 循环，也可以交给成熟的 CLI 智能体执行。
 * 这里检测 Hub 所在机器（部署后即服务器）上安装了哪些 CLI 及其版本。
 */
import { execFile } from "node:child_process";
import { hostname, platform } from "node:os";

export interface RuntimeInfo {
  id: string;
  name: string;
  bin: string;
  installed: boolean;
  path: string | null;
  version: string | null;
}

/** bin 来自固定列表，不接受外部输入 */
const CLIS = [
  { id: "claude-code", name: "Claude Code", bin: "claude" },
  { id: "codex", name: "Codex CLI", bin: "codex" },
  { id: "gemini", name: "Gemini CLI", bin: "gemini" },
  { id: "pi", name: "pi", bin: "pi" },
] as const;

function exec(file: string, args: string[], timeout = 8000): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout, env: process.env }, (err, stdout, stderr) => {
      if (err && !stdout) return resolve(null);
      resolve(`${stdout || stderr}`.trim());
    });
  });
}

let cache: { at: number; data: { host: string; platform: string; runtimes: RuntimeInfo[] } } | null = null;

export async function detectRuntimes(force = false) {
  if (!force && cache && Date.now() - cache.at < 60_000) return cache.data;
  const runtimes = await Promise.all(
    CLIS.map(async (c): Promise<RuntimeInfo> => {
      const path = (await exec("/bin/sh", ["-c", `command -v ${c.bin}`]))?.split("\n")[0] || null;
      const version = path ? ((await exec(path, ["--version"]))?.split("\n")[0] ?? null) : null;
      return { ...c, installed: !!path, path, version };
    }),
  );
  const data = { host: hostname(), platform: platform(), runtimes };
  cache = { at: Date.now(), data };
  return data;
}
