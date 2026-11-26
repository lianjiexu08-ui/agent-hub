/**
 * 服务端目录浏览：给「本机仓库目录」这类配置项选路径用。
 * 只列目录名，不读文件内容；范围限制在运行 Hub 的用户主目录内，越界直接拒绝。
 */
import { execFile } from "node:child_process";
import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";

export interface DirEntry { name: string; path: string; git: boolean; branch: string | null }

const ROOT = () => realpathSync(homedir());
/** 隐藏目录与依赖目录不列：几千个 node_modules 子目录只会淹没真正要找的仓库 */
const SKIP = new Set(["node_modules", ".git", ".cache", ".npm", ".nvm", ".pnpm-store", "dist", ".output", ".nuxt"]);

function inside(p: string): string {
  const root = ROOT();
  const abs = realpathSync(resolve(p || root));
  const r = relative(root, abs);
  if (r.startsWith("..") || resolve(root, r) !== abs) throw new Error(`只能浏览主目录（${root}）以内的路径`);
  return abs;
}

function branchOf(dir: string): Promise<string | null> {
  return new Promise((res) => execFile("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: dir, timeout: 3000 }, (e, out) => res(e ? null : out.trim() || null)));
}

export async function listDirs(path?: string): Promise<{ path: string; root: string; parent: string | null; git: boolean; branch: string | null; dirs: DirEntry[] }> {
  const abs = inside(path ?? "");
  if (!statSync(abs).isDirectory()) throw new Error("不是目录");
  const root = ROOT();
  const names = readdirSync(abs, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith(".") && !SKIP.has(d.name))
    .map((d) => d.name).sort((a, b) => a.localeCompare(b)).slice(0, 300);
  const dirs = await Promise.all(names.map(async (name) => {
    const p = join(abs, name);
    const git = existsSync(join(p, ".git"));
    return { name, path: p, git, branch: git ? await branchOf(p) : null };
  }));
  // 仓库排前面：要找的通常就是它们
  dirs.sort((a, b) => Number(b.git) - Number(a.git) || a.name.localeCompare(b.name));
  const git = existsSync(join(abs, ".git"));
  return { path: abs, root, parent: abs === root ? null : dirname(abs), git, branch: git ? await branchOf(abs) : null, dirs };
}
