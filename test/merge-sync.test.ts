/**
 * 合并前同步主干：PR 落后主干（期间别的 PR 合进去了）时先 Update branch，等 CI 对合并结果重新跑完再合并；
 * 合在一起 CI 不过就交回开发，不把坏代码合进主干。用本地假 GitHub 服务。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
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

async function scenario(afterSync: "success" | "failure", checksDelay = 0) {
  let head = "old0001";
  let newChecks = 0;
  const calls: string[] = [];
  const srv = createServer((req, res) => {
    const send = (d: unknown, code = 200) => { res.statusCode = code; res.setHeader("content-type", "application/json"); res.end(JSON.stringify(d)); };
    const url = req.url ?? "";
    if (url === "/repos/x/y") return send({ full_name: "x/y", default_branch: "main" });
    if (url === "/repos/x/y/pulls/40" && req.method === "GET") return send({ merge_commit_sha: null, base: { ref: "main" }, head: { sha: head } });
    if (url.startsWith("/repos/x/y/compare/")) return send({ behind_by: head === "old0001" ? 2 : 0 });
    if (url === "/repos/x/y/pulls/40/update-branch") { calls.push("update"); setTimeout(() => { head = "new0002"; }, 30); return send({ message: "Updating" }, 202); }
    if (url.startsWith("/repos/x/y/actions/workflows")) return send({ total_count: 1 });
    if (url.includes("/check-runs")) {
      // GitHub 过一会儿才在新提交上建出检查
      if (url.includes("new0002") && newChecks++ < checksDelay) return send({ check_runs: [] });
      return send({ check_runs: [{ name: "backend", status: "completed", conclusion: url.includes("new0002") ? afterSync : "success" }] });
    }
    if (url === "/repos/x/y/pulls/40/merge") { calls.push(`merge ${head}`); return send({ merged: true }); }
    send({}, 404);
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const store = new Store(":memory:");
  store.upsertAgent(AgentSchema.parse({ name: "developer", description: "d" }));
  const settings = new Settings(store);
  const runtime = new Runtime(store, simulatedLLM({ delayMs: [5000, 6000] }), { maxConcurrency: 2, maxDepth: 1, maxHops: 1 });
  const github = new GitHub(() => "tok", `http://127.0.0.1:${(srv.address() as { port: number }).port}`);
  const work = new Work(store, runtime, { notify: new Notifier(store, () => settings.get().notify), settings, github, linear: new Linear(() => null), workspace: new Workspace("/tmp/agent-hub-test-ws", () => null), simulate: false });
  work.syncPollMs = 20;
  const p = work.saveProject({ name: "演示", key: "MS" });
  await work.connectRepo(p.id, "x/y");
  const v = await work.create({ projectId: p.id, title: "推送", status: "backlog" });
  const i = work.find(v.key);
  Object.assign(i, { status: "in_review", assignee: "developer", lifecycleDone: true, pr: { number: 40, branch: "agent/ms-1", state: "open", checks: "passing", tests: "1/1", additions: 1, deletions: 0, files: 1 } });
  store.docPut("issues", i.id, i);
  return { work, calls, key: v.key, close: () => { for (const t of store.listTasks({})) runtime.cancel(t.id); srv.close(); } };
}

test("落后主干：先同步主干、等 CI 通过，再合并合并后的提交", async () => {
  const s = await scenario("success");
  try {
    await s.work.mergePR(s.key);
    assert.deepEqual(s.calls, ["update", "merge new0002"]);
    assert.match(s.work.detail(s.key).activity.map((a: { body: string }) => a.body).join("\n"), /落后主干 2 个提交/);
  } finally { s.close(); }
});

test("同步主干后 CI 不过：不合并，交回开发修复并保留批准", async () => {
  const s = await scenario("failure");
  try {
    await assert.rejects(s.work.mergePR(s.key), /合进 PR 后 CI 未通过（backend）.*已交回 developer/);
    assert.deepEqual(s.calls, ["update"], "没有合并");
    const i = s.work.find(s.key);
    assert.ok(["todo", "in_progress"].includes(i.status), "退回执行阶段");
    assert.ok(i.mergeApproved, "修好后直接合并");
  } finally { s.close(); }
});

test("交付收尾被重启打断（PR 开着、没审核完）：启动时重新收尾并合并", async () => {
  const s = await scenario("success");
  try {
    const w = s.work as unknown as { find: (k: string) => { id: number; pr: { reviewed?: boolean } }; setLead: (p: string, l: object) => void; reconcile: () => void; list: () => { projectId: string }[] };
    w.setLead(w.list()[0].projectId, { mode: "on_demand", mergePolicy: "auto" });
    w.reconcile();
    for (let t = 0; t < 100 && !s.calls.some((c) => c.startsWith("merge")); t++) await new Promise((r) => setTimeout(r, 50));
    assert.ok(s.calls.some((c) => c.startsWith("merge")), s.calls.join(","));
  } finally { s.close(); }
});

test("同步主干后检查还没建出来：不当成没有 CI，等它出来；失败就不合并", async () => {
  const s = await scenario("failure", 3);
  try {
    await assert.rejects(s.work.mergePR(s.key), /合进 PR 后 CI 未通过（backend）/);
    assert.deepEqual(s.calls, ["update"], "没有在检查出来之前合并");
  } finally { s.close(); }
});
