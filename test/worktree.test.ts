/**
 * worktree 准备顺序：CLI 底座启动前 worktree 必须已经就绪；准备失败时不启动。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/db.ts";
import { Runtime, type CliExecutor } from "../src/runtime.ts";
import { Settings } from "../src/settings.ts";
import { Notifier } from "../src/notify.ts";
import { GitHub } from "../src/github.ts";
import { Linear } from "../src/linear.ts";
import { Work } from "../src/work.ts";
import type { Workspace } from "../src/workspace.ts";
import { AgentSchema } from "../src/types.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function setup(prepare: () => Promise<string>) {
  const store = new Store(":memory:");
  store.upsertAgent(AgentSchema.parse({ name: "backend-dev", runtime: "claude-code" }));
  const settings = new Settings(store);
  const ready = new Set<string>();
  const seenAtStart: boolean[] = [];
  const workspace = {
    enabledFor: () => true,
    prepare: async (_p: unknown, key: string) => { const d = await prepare(); ready.add(key); return d; },
    dir: (_p: unknown, key: string) => `/tmp/wt/${key}`,
    commitAndPush: async () => null,
  } as unknown as Workspace;
  const runtime = new Runtime(store, { create: async () => { throw new Error("不应调用内置模型"); } }, { maxConcurrency: 4, maxDepth: 2, maxHops: 2 });
  const cli: CliExecutor = { async run(task) { seenAtStart.push(ready.size > 0); await sleep(5); return { result: `完成 ${task.id}` }; } };
  runtime.cli = cli;
  const work = new Work(store, runtime, { notify: new Notifier(store, () => settings.get().notify), settings, github: new GitHub(() => null), linear: new Linear(() => null), workspace, simulate: false });
  const p = work.saveProject({ name: "WT", key: "WT" });
  const proj = work.proj(p.id)!;
  proj.repo = { fullName: "o/r", defaultBranch: "main" };
  store.docPut("projects", proj.id, proj);
  return { work, store, seenAtStart, projectId: p.id };
}

test("worktree：准备完成后才启动 CLI", async () => {
  const { work, store, seenAtStart, projectId } = setup(async () => { await sleep(100); return "/tmp/wt"; });
  const v = await work.create({ projectId, title: "接口超时", description: "验收标准：\n- 超时 3 秒返回错误\n- 有重试", assignee: "backend-dev" });
  const run = store.listTasks({ issueId: work.find(v.key).id, rootsOnly: true })[0];
  assert.ok(run, "已提交运行");
  await sleep(50);
  assert.deepEqual(seenAtStart, [true]);
});

test("worktree：准备失败时不启动，退回待办并说明原因", async () => {
  const { work, store, seenAtStart, projectId } = setup(async () => { throw new Error("clone 失败：权限不足"); });
  const v = await work.create({ projectId, title: "接口超时", description: "验收标准：\n- 超时 3 秒返回错误\n- 有重试", assignee: "backend-dev" });
  const i = work.find(v.key);
  assert.equal(i.status, "todo");
  assert.equal(store.listTasks({ issueId: i.id }).length, 0);
  assert.equal(seenAtStart.length, 0);
  assert.ok(work.detail(v.key).activity.some((c) => /准备工作目录失败.*权限不足/.test(c.body)));
});
