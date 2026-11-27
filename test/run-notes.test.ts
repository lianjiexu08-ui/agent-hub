/**
 * 运行期间的新留言：智能体下一次调用 Hub 工具时附在结果后面，每条只给一次；自己的留言和系统消息不算。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/db.ts";
import { Runtime } from "../src/runtime.ts";
import { Settings } from "../src/settings.ts";
import { Notifier } from "../src/notify.ts";
import { GitHub } from "../src/github.ts";
import { Linear } from "../src/linear.ts";
import { Workspace } from "../src/workspace.ts";
import { Work } from "../src/work.ts";
import { simulatedLLM } from "../src/simulate.ts";
import { AgentSchema } from "../src/types.ts";

test("运行中的新留言随下一次工具结果转交，只给一次", async () => {
  const store = new Store(":memory:");
  store.upsertAgent(AgentSchema.parse({ name: "developer", description: "d" }));
  const settings = new Settings(store);
  const runtime = new Runtime(store, simulatedLLM({ delayMs: [1, 1] }), { maxConcurrency: 2, maxDepth: 1, maxHops: 1 });
  const work = new Work(store, runtime, { notify: new Notifier(store, () => settings.get().notify), settings, github: new GitHub(() => null), linear: new Linear(() => null), workspace: new Workspace("/tmp/agent-hub-test-ws", () => null), simulate: false });
  const p = work.saveProject({ name: "演示", key: "RN" });
  const v = await work.create({ projectId: p.id, title: "A", status: "backlog" });
  const i = work.find(v.key);
  const task = { id: "t1", issueId: i.id, parentId: null, agent: "developer", createdAt: new Date(Date.now() - 1000).toISOString() } as never;
  assert.equal(work["newNotes"](task), "");
  work.comment(v.key, "迁移编号改成接在 main 最新之后");
  work.comment(v.key, "我自己的进展", "developer");
  const out = work["newNotes"](task);
  assert.match(out, /新留言[\s\S]*迁移编号改成接在 main 最新之后/);
  assert.doesNotMatch(out, /我自己的进展/);
  assert.equal(work["newNotes"](task), "", "已经转交过的不再重复");
});
