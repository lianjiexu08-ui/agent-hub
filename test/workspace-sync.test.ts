/**
 * 提交前合并主干：用本地裸仓库代替 GitHub，跑真实的 git。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workspace } from "../src/workspace.ts";

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" }).trim();

function setup() {
  const root = mkdtempSync(join(tmpdir(), "hub-ws-"));
  const remote = join(root, "remote.git");
  git(root, "init", "--bare", "-b", "main", remote);
  // 另一个「开发者」的克隆：用来往主干推新提交
  const other = join(root, "other");
  git(root, "clone", remote, other);
  writeFileSync(join(other, "app.txt"), "line1\nline2\nline3\n");
  writeFileSync(join(other, "shared.txt"), "a\n");
  git(other, "add", "-A"); git(other, "commit", "-m", "init"); git(other, "push", "origin", "HEAD:main");
  const ws = new Workspace(join(root, "ws"), () => "token");
  ws.remoteUrl = () => remote;
  const p = { id: "p", repo: { fullName: "x/y", defaultBranch: "main" } };
  const pushMain = (file: string, body: string) => { git(other, "pull", "-q", "origin", "main"); writeFileSync(join(other, file), body); git(other, "commit", "-am", `main: ${file}`); git(other, "push", "-q", "origin", "HEAD:main"); };
  return { ws, p, remote, pushMain };
}

test("主干前进但没有冲突：提交前自动合并主干，PR 基于最新主干", async () => {
  const { ws, p, remote, pushMain } = setup();
  const dir = await ws.prepare(p, "S2T-2");
  writeFileSync(join(dir, "app.txt"), "line1 changed\nline2\nline3\n");
  pushMain("shared.txt", "a\nb from main\n");
  const res = await ws.commitAndPush(p, "S2T-2", "S2T-2: 改 app");
  assert.ok(res && !("conflict" in res && res.conflict), "没有冲突");
  assert.equal(readFileSync(join(dir, "shared.txt"), "utf8"), "a\nb from main\n", "主干的改动已合进来");
  // 推上去的分支包含主干最新提交
  const mainHead = git(remote, "rev-parse", "main");
  git(remote, "merge-base", "--is-ancestor", mainHead, "agent/s2t-2");
  assert.equal(res && "files" in res ? res.files : -1, 1, "改动统计只算自己的改动（相对主干）");
});

test("主干前进且冲突：撤销合并、列出冲突文件，不推送", async () => {
  const { ws, p, remote, pushMain } = setup();
  const dir = await ws.prepare(p, "S2T-6");
  writeFileSync(join(dir, "app.txt"), "line1 by agent\nline2\nline3\n");
  pushMain("app.txt", "line1 by main\nline2\nline3\n");
  const res = await ws.commitAndPush(p, "S2T-6", "S2T-6: 改 app");
  assert.deepEqual(res && "conflict" in res ? res.conflict : null, ["app.txt"]);
  assert.equal(git(dir, "status", "--porcelain"), "", "合并已撤销，工作区干净（自己的改动已提交在本地）");
  assert.equal(readFileSync(join(dir, "app.txt"), "utf8"), "line1 by agent\nline2\nline3\n");
  assert.throws(() => git(remote, "rev-parse", "--verify", "agent/s2t-6"), "冲突时不推送");
  // 智能体解决冲突后再次提交：成功推送
  git(dir, "fetch", "-q", remote, "+refs/heads/main:refs/remotes/origin/main");
  try { git(dir, "merge", "origin/main"); } catch { /* 预期冲突 */ }
  writeFileSync(join(dir, "app.txt"), "line1 by agent and main\nline2\nline3\n");
  git(dir, "commit", "-am", "合并主干并解决冲突");
  const again = await ws.commitAndPush(p, "S2T-6", "S2T-6: 改 app");
  assert.ok(again && !("conflict" in again && again.conflict));
  assert.ok(git(remote, "rev-parse", "--verify", "agent/s2t-6"));
});

test("智能体自己已经提交、工作目录只剩 Hub 的 pi 配置：照常推送，不因「没有可提交的内容」失败", async () => {
  const { ws, p, remote } = setup();
  const dir = await ws.prepare(p, "S2T-13");
  writeFileSync(join(dir, "app.txt"), "line1 by agent\nline2\nline3\n");
  git(dir, "commit", "-am", "agent 自己提交");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(join(dir, ".pi"), { recursive: true });
  writeFileSync(join(dir, ".pi", "mcp.json"), '{"env":{"HUB_TASK_ID":"t1","HUB_TASK_TOKEN":"secret"}}');
  const res = await ws.commitAndPush(p, "S2T-13", "S2T-13: 工作台");
  assert.ok(res && !("conflict" in res && res.conflict), "推送成功");
  assert.ok(git(remote, "rev-parse", "--verify", "agent/s2t-13"));
  assert.throws(() => git(remote, "cat-file", "-e", "agent/s2t-13:.pi/mcp.json"), "含令牌的 pi 配置没有提交");
});

test("智能体自己推过分支、之后又改了历史：Hub 推送不因 stale info 被拒", async () => {
  const { ws, p, remote, pushMain } = setup();
  const dir = await ws.prepare(p, "S2T-32");
  writeFileSync(join(dir, "app.txt"), "line1 v1\nline2\nline3\n");
  git(dir, "commit", "-am", "v1");
  git(dir, "push", "-q", remote, "HEAD:refs/heads/agent/s2t-32"); // 智能体自己推送
  git(dir, "commit", "--amend", "-qm", "v1 改写"); // 又改写了提交
  pushMain("shared.txt", "a\nmain moved\n");
  const res = await ws.commitAndPush(p, "S2T-32", "S2T-32: 推送");
  assert.ok(res && !("conflict" in res && res.conflict), "推送成功");
  assert.equal(git(remote, "rev-parse", "agent/s2t-32"), git(dir, "rev-parse", "HEAD"), "远端分支是 Hub 合并主干后的最新提交");
});
