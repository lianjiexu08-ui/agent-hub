import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { Store } from "../src/db.ts";
import { Runtime } from "../src/runtime.ts";
import { Settings } from "../src/settings.ts";
import { QA } from "../src/qa.ts";
import { simulatedLLM } from "../src/simulate.ts";
import { call } from "../src/mcp-task.ts";

test("任务桥的请求不设超时：慢响应也能拿到结果（全局 fetch 5 分钟就断开）", async () => {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => setTimeout(() => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ echo: JSON.parse(body || "null"), method: req.method })); }, 300));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/x`;
  try {
    assert.deepEqual(await call("POST", url, { name: "report_phase" }), { echo: { name: "report_phase" }, method: "POST" });
    assert.deepEqual(await call("GET", url), { echo: null, method: "GET" });
  } finally { server.close(); }
});

test("重启后：生命周期里的验收取消（没人等结果了），手动发起的重新排队", () => {
  const store = new Store(":memory:");
  const base = { title: "t", projectId: "p", pr: null, hotfix: false, priority: 0, browser: null, env: "CI", account: null, mutates: [], queuedAt: new Date().toISOString(), wait: null, cursor: { c: 0, s: 0 }, simulated: false };
  const cases = () => [{ id: "c1", criterion: 0, kind: "check", title: "a", mutates: [], status: "running", steps: [{ desc: "d", cmd: "", status: "passed" }] }, { id: "c2", criterion: 1, kind: "check", title: "b", mutates: [], status: null, steps: [] }];
  store.docPut("qa_runs", "r1", { ...base, id: "r1", issueKey: "S2T-2", status: "running", trigger: "lifecycle", cases: cases() });
  store.docPut("qa_runs", "r2", { ...base, id: "r2", issueKey: "S2T-6", status: "queued", trigger: "lifecycle", cases: cases() });
  store.docPut("qa_runs", "r3", { ...base, id: "r3", issueKey: "S2T-9", status: "running", trigger: "manual", cases: cases() });
  const runtime = new Runtime(store, simulatedLLM({ delayMs: [1, 1] }), { maxConcurrency: 1, maxDepth: 1, maxHops: 1 });
  const qa = new QA(store, runtime, new Settings(store), () => undefined, false);
  const r = (id: string) => qa.run(id)!;
  assert.equal(r("r1").status, "cancelled");
  assert.deepEqual(r("r1").cases.map((c) => c.status), ["skipped", "skipped"]);
  assert.match(r("r1").cases[0].note ?? "", /服务重启/);
  assert.equal(r("r2").status, "cancelled", "排队中的生命周期验收也取消");
  assert.equal(r("r3").status, "queued", "手动发起的重新排队");
  assert.deepEqual(r("r3").cases.map((c) => c.status), [null, null]);
  qa.stop();
});
