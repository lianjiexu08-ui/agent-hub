/**
 * worktree 回收：用真实的本地 git 仓库验证删除 worktree 与本地分支、清扫已结束的工作项。
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workspace } from "../src/workspace.ts";

const root = mkdtempSync(join(tmpdir(), "hub-ws-"));
after(() => rmSync(root, { recursive: true, force: true }));
const git = (args: string[], cwd: string) => execFileSync("git", args, { cwd, stdio: "pipe" }).toString().trim();
const p = { id: "p1", repo: { fullName: "o/r", defaultBranch: "main" } };

function seedRepo() {
  const repo = join(root, "repos", "o__r");
  mkdirSync(repo, { recursive: true });
  git(["init", "-q", "-b", "main"], repo);
  writeFileSync(join(repo, "a.txt"), "hi");
  git(["add", "."], repo);
  git(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"], repo);
  for (const key of ["HUB-1", "HUB-2"]) {
    const dir = join(root, "worktrees", "o__r", key);
    mkdirSync(join(dir, ".."), { recursive: true });
    git(["worktree", "add", "-q", "-b", `agent/${key.toLowerCase()}`, dir, "main"], repo);
  }
  return repo;
}

test("回收：删除 worktree 与本地分支，远端无关；不存在时返回 false", async () => {
  const repo = seedRepo();
  const ws = new Workspace(root, () => "token");
  assert.deepEqual(ws.keys(p).sort(), ["HUB-1", "HUB-2"]);
  assert.equal(await ws.remove(p, "HUB-1"), true);
  assert.ok(!existsSync(join(root, "worktrees", "o__r", "HUB-1")));
  assert.ok(!git(["branch", "--list", "agent/hub-1"], repo), "本地分支已删除");
  assert.ok(git(["branch", "--list", "agent/hub-2"], repo), "其他工作项不受影响");
  assert.ok(!git(["worktree", "list"], repo).includes("HUB-1"));
  assert.equal(await ws.remove(p, "HUB-1"), false);
  assert.deepEqual(ws.keys(p), ["HUB-2"]);
});

test("磁盘统计：按 worktree 统计占用，du 不可用时也能算出大小", async () => {
  const repo = join(root, "repos", "o__r");
  const ws = new Workspace(root, () => "token");
  const dir = join(root, "worktrees", "o__r", "HUB-3");
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "a.js"), "x".repeat(4096));
  writeFileSync(join(dir, "README.md"), "y".repeat(100));
  const usage = await ws.usage(p);
  const item = usage.find((u) => u.key === "HUB-3")!;
  assert.ok(item, "列出 HUB-3");
  assert.ok(item.bytes > 4000, `占用统计为正：${item.bytes}`);
  assert.ok(item.mtime, "有最后修改时间");
  assert.deepEqual(usage.map((u) => u.key).sort(), ["HUB-2", "HUB-3"], "已删除的目录不再出现");
  assert.ok(repo);
});
