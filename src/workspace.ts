/**
 * 工作目录：每个工作项在仓库的独立 git worktree（分支 agent/<编号>）中执行，互不干扰。
 * 只在「项目绑定了仓库 + 已配置 GitHub Token + 智能体使用 CLI 底座」时启用。
 */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { GitHub } from "./github.ts";

interface Proj { id: string; repo: { fullName: string; defaultBranch?: string } | null }

/** Hub 运行时写进工作目录的配置文件（含任务令牌）：提交时排除 */
export const HUB_FILES = [".gemini/settings.json", ".pi/mcp.json"];

/** 需要工作目录的扩展工具：读写文件、检索代码、执行命令 */
export const WORKSPACE_TOOLS = ["read_file", "write_file", "list_files", "search_repo", "run_command"];

/**
 * 依赖锁文件、压缩产物这类生成文件：不计入改动行数（安全护栏的「改动行数上限」针对的是人要评审的代码）。
 * 动辄几千行的 package-lock.json 不该让一个项目骨架被拦下。
 */
const GENERATED = [/(^|\/)(package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|uv\.lock|poetry\.lock|Pipfile\.lock|pdm\.lock|Cargo\.lock|go\.sum|composer\.lock|Gemfile\.lock)$/, /\.min\.(js|css)$/, /\.(js|css)\.map$/];
export const isGeneratedFile = (path: string) => GENERATED.some((re) => re.test(path));

/** 测试代码：测试目录（__tests__ / tests / test / spec / e2e）和 *.test.* / *.spec.* / test_*.py / *_test.go 等 */
const TESTS = [/(^|\/)(__tests__|__mocks__|tests?|specs?|e2e|cypress|playwright)\//, /\.(test|spec|e2e)\.[cm]?[jt]sx?$/, /(^|\/)test_[^/]+\.py$/, /_test\.(py|go)$/, /(^|\/)conftest\.py$/];
export const isTestFile = (path: string) => TESTS.some((re) => re.test(path));

/**
 * 解析 `git diff --numstat`：分开统计需要评审的改动与生成文件（二进制文件记为 0 行）。
 * 测试代码计入 additions / deletions，另在 tests 里单独统计（安全护栏的行数上限不算测试，测试写得充分不该被拦）。
 */
export function diffStat(numstat: string): { files: number; additions: number; deletions: number; generated: { files: number; lines: number }; tests: { files: number; lines: number } } {
  const out = { files: 0, additions: 0, deletions: 0, generated: { files: 0, lines: 0 }, tests: { files: 0, lines: 0 } };
  for (const line of numstat.split("\n")) {
    const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line.trim());
    if (!m) continue;
    const add = m[1] === "-" ? 0 : Number(m[1]);
    const del = m[2] === "-" ? 0 : Number(m[2]);
    // 重命名形如 a/{x => y}/b 或 x => y：取新路径判断
    const path = m[3].replace(/\{[^}]*=> ([^}]*)\}/, "$1").replace(/^.* => /, "");
    out.files++;
    if (isGeneratedFile(path)) { out.generated.files++; out.generated.lines += add + del; }
    else {
      out.additions += add; out.deletions += del;
      if (isTestFile(path)) { out.tests.files++; out.tests.lines += add + del; }
    }
  }
  return out;
}

function git(args: string[], cwd: string): Promise<string> {
  return new Promise((res, rej) => {
    execFile("git", args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }, maxBuffer: 20 * 1024 * 1024 }, (err, stdout, stderr) => {
      // 有的 git 提示（如 nothing to commit）写在 stdout 里
      if (err) rej(new Error((stderr.trim() || stdout.trim() || err.message).replace(/x-access-token:[^@]+@/g, "x-access-token:***@").slice(0, 400)));
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
  /** 测试用：把远端换成本地仓库（默认是带令牌的 GitHub 地址） */
  remoteUrl: ((p: Proj) => string) | null = null;
  constructor(root: string, token: () => string | null) {
    this.root = resolve(root);
    this.token = token;
  }
  /**
   * 是否给这个智能体准备独立工作目录：
   * - CLI 底座必须有（它们是按目录干活的）
   * - 内置循环只有在开启文件/命令类工具时才需要，否则不该在服务器上开目录
   */
  enabledFor(p: Proj | undefined, agent: { runtime?: string; builtinTools?: string[] } | undefined): boolean {
    if (!p?.repo || !this.token() || !agent) return false;
    if (agent.runtime && agent.runtime !== "builtin") return true;
    return (agent.builtinTools ?? []).some((t) => WORKSPACE_TOOLS.includes(t));
  }
  private repoDir(p: Proj) { return join(this.root, "repos", p.repo!.fullName.replace("/", "__")); }
  dir(p: Proj, key: string) { return join(this.root, "worktrees", p.repo!.fullName.replace("/", "__"), key); }
  private url(p: Proj) { return this.remoteUrl ? this.remoteUrl(p) : `https://x-access-token:${this.token()}@github.com/${p.repo!.fullName}.git`; }

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
    // Hub 为 Gemini / pi 写在工作目录里的 MCP 配置含任务令牌，绝不能提交
    for (const rel of HUB_FILES) {
      const f = join(dir, rel);
      if (existsSync(f) && readFileSync(f, "utf8").includes("HUB_TASK_ID")) await git(["restore", "--staged", "--", rel], dir).catch(() => {});
    }
    // 只看暂存区：未跟踪的 Hub 配置（.pi/、.gemini/）不算；智能体自己已经提交过时暂存区为空，直接跳过
    const staged = await git(["diff", "--cached", "--name-only"], dir);
    if (staged) await git(["-c", "user.name=agent-hub", "-c", "user.email=agent-hub@users.noreply.github.com", "commit", "-m", message], dir);
    const base = p.repo!.defaultBranch ?? "main";
    // 先把最新的主干合进来：并行开发时主干可能已经前进了。测试与评审要基于合并后的代码，PR 也不会带着冲突提上去
    await git(["fetch", this.url(p), `+refs/heads/${base}:refs/remotes/origin/${base}`], dir);
    const upToDate = await git(["merge-base", "--is-ancestor", `origin/${base}`, "HEAD"], dir).then(() => true, () => false);
    if (!upToDate) {
      try {
        await git(["-c", "user.name=agent-hub", "-c", "user.email=agent-hub@users.noreply.github.com", "merge", "--no-edit", `origin/${base}`], dir);
      } catch {
        // 有冲突：撤销这次合并，把冲突文件交给智能体自己解决（它最了解自己的改动）
        const files = (await git(["diff", "--name-only", "--diff-filter=U"], dir).catch(() => "")).split("\n").filter(Boolean);
        await git(["merge", "--abort"], dir).catch(() => {});
        return { branch, conflict: files.length ? files : ["（未能列出冲突文件）"] };
      }
    }
    const ahead = await git(["rev-list", "--count", `origin/${base}..HEAD`], dir);
    if (ahead === "0") return null;
    await git(["push", "--force-with-lease", this.url(p), `HEAD:refs/heads/${branch}`], dir);
    return { branch, ...diffStat(await git(["diff", "--numstat", `origin/${base}...HEAD`], dir)) };
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
