/**
 * 工作目录：每个工作项在仓库的独立 git worktree（分支 agent/<编号>）中执行，互不干扰。
 * 只在「项目绑定了仓库 + 已配置 GitHub Token + 智能体使用 CLI 底座」时启用。
 */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { GitHub } from "./github.ts";

interface Proj { id: string; repo: { fullName: string; defaultBranch?: string } | null }

function git(args: string[], cwd: string): Promise<string> {
  return new Promise((res, rej) => {
    execFile("git", args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }, maxBuffer: 20 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) rej(new Error((stderr || err.message).replace(/x-access-token:[^@]+@/g, "x-access-token:***@").slice(0, 400)));
      else res(stdout.trim());
    });
  });
}

export class Workspace {
  readonly root: string;
  private token: () => string | null;
  /** 同一仓库的 clone / fetch / worktree / commit / push 串行，避免多个工作项并发时抢 .git 锁 */
  private locks = new Map<string, Promise<unknown>>();
  private withRepo<T>(p: Proj, fn: () => Promise<T>): Promise<T> {
    const key = p.repo!.fullName;
    const prev = this.locks.get(key) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    this.locks.set(key, next);
    void next.finally(() => { if (this.locks.get(key) === next) this.locks.delete(key); }).catch(() => {});
    return next;
  }
  constructor(root: string, token: () => string | null) {
    this.root = resolve(root);
    this.token = token;
  }
  enabledFor(p: Proj | undefined, agent: { runtime?: string } | undefined): boolean {
    return !!p?.repo && !!this.token() && !!agent?.runtime && agent.runtime !== "builtin";
  }
  private repoDir(p: Proj) { return join(this.root, "repos", p.repo!.fullName.replace("/", "__")); }
  dir(p: Proj, key: string) { return join(this.root, "worktrees", p.repo!.fullName.replace("/", "__"), key); }
  private url(p: Proj) { return `https://x-access-token:${this.token()}@github.com/${p.repo!.fullName}.git`; }

  prepare(p: Proj, key: string): Promise<string> { return this.withRepo(p, () => this.prepareUnlocked(p, key)); }
  private async prepareUnlocked(p: Proj, key: string): Promise<string> {
    const repo = this.repoDir(p);
    const base = p.repo!.defaultBranch ?? "main";
    if (!existsSync(join(repo, ".git"))) {
      mkdirSync(join(this.root, "repos"), { recursive: true });
      await git(["clone", "--no-tags", this.url(p), repo], this.root);
    } else await git(["fetch", this.url(p), `+refs/heads/${base}:refs/remotes/origin/${base}`], repo);
    const dir = this.dir(p, key);
    if (!existsSync(dir)) {
      mkdirSync(join(dir, ".."), { recursive: true });
      await git(["worktree", "add", "-B", `agent/${key.toLowerCase()}`, dir, `origin/${base}`], repo);
    }
    return dir;
  }

  /** 提交并推送改动；没有改动返回 null */
  commitAndPush(p: Proj, key: string, message: string) { return this.withRepo(p, () => this.commitAndPushUnlocked(p, key, message)); }
  private async commitAndPushUnlocked(p: Proj, key: string, message: string) {
    const dir = this.dir(p, key);
    if (!existsSync(dir)) return null;
    const branch = `agent/${key.toLowerCase()}`;
    await git(["add", "-A"], dir);
    // Hub 为 Gemini CLI 写在工作目录里的 MCP 配置含访问令牌，绝不能提交
    const hubFile = join(dir, ".gemini", "settings.json");
    if (existsSync(hubFile) && readFileSync(hubFile, "utf8").includes("HUB_TASK_ID")) await git(["restore", "--staged", "--", ".gemini/settings.json"], dir).catch(() => {});
    const staged = await git(["status", "--porcelain"], dir);
    if (staged) await git(["-c", "user.name=agent-hub", "-c", "user.email=agent-hub@users.noreply.github.com", "commit", "-m", message], dir);
    const base = p.repo!.defaultBranch ?? "main";
    const ahead = await git(["rev-list", "--count", `origin/${base}..HEAD`], dir);
    if (ahead === "0") return null;
    await git(["push", "--force-with-lease", this.url(p), `HEAD:refs/heads/${branch}`], dir);
    const stat = await git(["diff", "--shortstat", `origin/${base}...HEAD`], dir);
    const num = (re: RegExp) => Number(re.exec(stat)?.[1] ?? 0);
    return { branch, files: num(/(\d+) files? changed/), additions: num(/(\d+) insertions?/), deletions: num(/(\d+) deletions?/) };
  }

  /** 回滚已合并的 PR：基于合并提交创建 revert PR 并合并，返回新 PR 编号 */
  revert(p: Proj, prNumber: number, gh: GitHub): Promise<number> { return this.withRepo(p, () => this.revertUnlocked(p, prNumber, gh)); }
  private async revertUnlocked(p: Proj, prNumber: number, gh: GitHub): Promise<number> {
    const key = `revert-${prNumber}`;
    try { return await this.revertIn(p, prNumber, gh, key); }
    finally { await this.removeUnlocked(p, key).catch(() => {}); }
  }
  private async revertIn(p: Proj, prNumber: number, gh: GitHub, key: string): Promise<number> {
    const info = await gh.pr(p.repo!.fullName, prNumber);
    if (!info.merge_commit_sha) throw new Error("找不到合并提交");
    const dir = await this.prepareUnlocked(p, key);
    await git(["-c", "user.name=agent-hub", "-c", "user.email=agent-hub@users.noreply.github.com", "revert", "--no-edit", info.merge_commit_sha], dir);
    const branch = `agent/${key}`;
    await git(["push", "--force-with-lease", this.url(p), `HEAD:refs/heads/${branch}`], dir);
    const pr = await gh.createPR(p.repo!.fullName, { title: `Revert #${prNumber}`, head: branch, base: info.base.ref, body: `回滚 #${prNumber}` });
    await gh.mergePR(p.repo!.fullName, pr.number);
    return pr.number;
  }

  // ======================= 回收 =======================
  /** 删除某个工作项的 worktree 与本地分支（远端分支与 PR 不动）。不存在时什么都不做，返回是否删除了 */
  remove(p: Proj, key: string): Promise<boolean> {
    if (!p.repo || !existsSync(this.dir(p, key))) return Promise.resolve(false);
    return this.withRepo(p, () => this.removeUnlocked(p, key));
  }
  private async removeUnlocked(p: Proj, key: string): Promise<boolean> {
    const dir = this.dir(p, key);
    const repo = this.repoDir(p);
    if (!existsSync(dir)) return false;
    if (existsSync(join(repo, ".git"))) {
      await git(["worktree", "remove", "--force", dir], repo).catch(() => rmSync(dir, { recursive: true, force: true }));
      await git(["worktree", "prune"], repo).catch(() => {});
      await git(["branch", "-D", `agent/${key.toLowerCase()}`], repo).catch(() => {});
    } else rmSync(dir, { recursive: true, force: true });
    return true;
  }
  /** 当前存在的 worktree（工作项编号） */
  keys(p: Proj): string[] {
    if (!p.repo) return [];
    const base = join(this.root, "worktrees", p.repo.fullName.replace("/", "__"));
    return existsSync(base) ? readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name) : [];
  }

  /** 每个 worktree 的磁盘占用与最后修改时间（du 统计，失败时退回递归统计） */
  async usage(p: Proj): Promise<{ key: string; bytes: number; mtime: string | null }[]> {
    if (!p.repo) return [];
    const keys = this.keys(p);
    if (!keys.length) return [];
    const dirs = keys.map((k) => this.dir(p, k));
    const out = await new Promise<string | null>((resolve) => {
      execFile("du", ["-sk", ...dirs], { maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => resolve(err && !stdout ? null : stdout));
    });
    const sizes = new Map<string, number>();
    if (out) {
      for (const line of out.split("\n")) {
        const [kb, dir] = line.trim().split(/\t/);
        if (!dir) continue;
        sizes.set(dir, Number(kb) * 1024);
      }
    }
    const res: { key: string; bytes: number; mtime: string | null }[] = [];
    for (const [n, key] of keys.entries()) {
      const dir = dirs[n];
      let bytes = sizes.get(dir);
      if (bytes == null) bytes = dirSize(dir);
      let mtime: string | null = null;
      try { mtime = statSync(dir).mtime.toISOString(); } catch { /* 已删除 */ }
      res.push({ key, bytes, mtime });
    }
    return res;
  }

  /** 最近一次回收的统计（供界面展示） */
  lastSweep: { at: string; removed: number } | null = null;
}

/** 递归统计目录大小（du 不可用时的兜底） */
function dirSize(dir: string): number {
  let total = 0;
  try {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) total += dirSize(p);
      else if (e.isFile()) { try { total += statSync(p).size; } catch { /* 跳过 */ } }
    }
  } catch { /* 目录不可读 */ }
  return total;
}
