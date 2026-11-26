/**
 * 交付策略：本地合并（不推远端）与基线分支。用本地裸仓库代替 GitHub，跑真实的 git。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workspace } from "../src/workspace.ts";
import { baseOf, deliveryOf } from "../src/work.ts";

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" }).trim();

function setup() {
  const root = mkdtempSync(join(tmpdir(), "hub-dl-"));
  const remote = join(root, "remote.git");
  git(root, "init", "--bare", "-b", "main", remote);
  // 本机开发仓库：在 dev 上，有一个没推上去的提交
  const local = join(root, "local");
  git(root, "clone", remote, local);
  writeFileSync(join(local, "app.txt"), "v1\n");
  git(local, "add", "-A"); git(local, "commit", "-m", "init"); git(local, "push", "-q", "origin", "HEAD:main");
  git(local, "checkout", "-q", "-b", "dev");
  writeFileSync(join(local, "dev-only.txt"), "only on local dev\n");
  git(local, "add", "-A"); git(local, "commit", "-m", "dev 上未推送的提交");
  const ws = new Workspace(join(root, "ws"), () => "token");
  ws.remoteUrl = () => remote;
  const p = { id: "p", repo: { fullName: "x/y", defaultBranch: "main" }, delivery: { baseBranch: "dev", mode: "local", localPath: local } };
  return { ws, p, remote, local };
}

test("交付策略默认值：老项目没有 delivery 时等同开 PR 到默认分支", () => {
  const p = { repo: { fullName: "x/y", defaultBranch: "main" } };
  assert.equal(deliveryOf(p).mode, "pr");
  assert.equal(baseOf(p), "main");
  assert.equal(baseOf({ ...p, delivery: { baseBranch: "dev", mode: "local", localPath: "/x", afterMerge: "" } }), "dev");
});

test("本地交付：从本机 dev 拉基线、不推远端、评审后合进本机 dev", async () => {
  const { ws, p, remote, local } = setup();
  const dir = await ws.prepare(p, "OPS-9");
  assert.equal(readFileSync(join(dir, "dev-only.txt"), "utf8"), "only on local dev\n", "基线取自本机 dev（含未推送提交），不是远端 main");
  writeFileSync(join(dir, "app.txt"), "v2 by agent\n");
  const res = await ws.commitAndPush(p, "OPS-9", "OPS-9: 改 app");
  assert.ok(res && !("conflict" in res && res.conflict));
  assert.throws(() => git(remote, "rev-parse", "--verify", "agent/ops-9"), "本地交付不推远端");

  const out = await ws.mergeLocal(p, "OPS-9", local, "dev", "OPS-9: 改 app");
  assert.ok(out.commit);
  assert.equal(readFileSync(join(local, "app.txt"), "utf8"), "v2 by agent\n", "改动已进本机 dev 工作区（热加载可见）");
  assert.equal(git(local, "rev-parse", "--abbrev-ref", "HEAD"), "dev");
  assert.throws(() => git(remote, "rev-parse", "--verify", "dev"), "远端没有被推任何东西");
});

test("本地交付：本机仓库不在基线分支上时拒绝合并", async () => {
  const { ws, p, local } = setup();
  const dir = await ws.prepare(p, "OPS-10");
  writeFileSync(join(dir, "app.txt"), "x\n");
  await ws.commitAndPush(p, "OPS-10", "OPS-10");
  git(local, "checkout", "-q", "main");
  await assert.rejects(ws.mergeLocal(p, "OPS-10", local, "dev", "OPS-10"), /不是 dev/);
  assert.equal(readFileSync(join(local, "app.txt"), "utf8"), "v1\n", "没动本机仓库");
});

test("本地交付：冲突时撤销合并，本机仓库保持原样", async () => {
  const { ws, p, local } = setup();
  const dir = await ws.prepare(p, "OPS-11");
  writeFileSync(join(dir, "app.txt"), "agent\n");
  await ws.commitAndPush(p, "OPS-11", "OPS-11");
  writeFileSync(join(local, "app.txt"), "human\n");
  git(local, "commit", "-qam", "人在本地也改了");
  const head = git(local, "rev-parse", "HEAD");
  await assert.rejects(ws.mergeLocal(p, "OPS-11", local, "dev", "OPS-11"), /已撤销/);
  assert.equal(git(local, "rev-parse", "HEAD"), head);
  assert.equal(git(local, "status", "--porcelain"), "", "不留半合并状态");
});
