/**
 * 工作目录：每个工作项在仓库的独立 git worktree（分支 agent/<编号>）中执行，互不干扰。
 * 只在「项目绑定了仓库 + 已配置 GitHub Token + 智能体使用 CLI 底座」时启用。
 */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
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

  async prepare(p: Proj, key: string): Promise<string> {
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
  async commitAndPush(p: Proj, key: string, message: string) {
    const dir = this.dir(p, key);
    if (!existsSync(dir)) return null;
    const branch = `agent/${key.toLowerCase()}`;
    await git(["add", "-A"], dir);
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
  async revert(p: Proj, prNumber: number, gh: GitHub): Promise<number> {
    const info = await gh.pr(p.repo!.fullName, prNumber);
    if (!info.merge_commit_sha) throw new Error("找不到合并提交");
    const key = `revert-${prNumber}`;
    const dir = await this.prepare(p, key);
    await git(["-c", "user.name=agent-hub", "-c", "user.email=agent-hub@users.noreply.github.com", "revert", "--no-edit", info.merge_commit_sha], dir);
    const branch = `agent/${key}`;
    await git(["push", "--force-with-lease", this.url(p), `HEAD:refs/heads/${branch}`], dir);
    const pr = await gh.createPR(p.repo!.fullName, { title: `Revert #${prNumber}`, head: branch, base: info.base.ref, body: `回滚 #${prNumber}` });
    await gh.mergePR(p.repo!.fullName, pr.number);
    return pr.number;
  }
}
