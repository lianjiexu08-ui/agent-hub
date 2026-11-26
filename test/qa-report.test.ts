import { test, after } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/db.ts";
import { Runtime } from "../src/runtime.ts";
import { Settings } from "../src/settings.ts";
import { QA } from "../src/qa.ts";
import { simulatedLLM } from "../src/simulate.ts";

const qas: QA[] = [];
after(() => qas.forEach((q) => q.stop()));

test("验收失败报告：带上 tester 的复现、失败步骤与报错、截图路径，通过的用例一行带过", () => {
  const store = new Store(":memory:");
  const runtime = new Runtime(store, simulatedLLM({ delayMs: [1, 2] }), { maxConcurrency: 2, maxDepth: 2, maxHops: 2 });
  const qa = new QA(store, runtime, new Settings(store), () => undefined, true, { stepMs: 1 });
  qas.push(qa);
  store.docPut("qa_runs", "qr_1", {
    id: "qr_1", issueKey: "OPS-9", title: "t", projectId: "p", pr: null, hotfix: false, priority: 0, status: "failed", trigger: "lifecycle",
    browser: "b-1", env: "http://127.0.0.1:8100", account: null, mutates: [], queuedAt: "", wait: null, cursor: null, simulated: false,
    cases: [
      { id: "c1", criterion: 0, kind: "browser", title: "能看到总览", mutates: [], status: "passed", steps: [] },
      { id: "c2", criterion: 1, kind: "browser", title: "保存后刷新仍保留", mutates: [], status: "failed", note: "保存后刷新，勾选丢失；复现：打开弹窗→取消 D 组→保存→F5",
        steps: [{ desc: "click", cmd: "browser click --uid e12", status: "failed", error: "接口 PUT /scope 返回 500" }, { desc: "screenshot", cmd: "browser screenshot", status: "passed", shot: "qr_1-2.png" }] },
    ],
  });
  const r = qa.failureReport("qr_1", "/abs/shots");
  assert.match(r, /1\/2 通过/);
  assert.match(r, /✓ c1 能看到总览/);
  assert.match(r, /✕ c2 保存后刷新仍保留/);
  assert.match(r, /复现：打开弹窗/);
  assert.match(r, /browser click --uid e12/);
  assert.match(r, /PUT \/scope 返回 500/);
  assert.match(r, /\/abs\/shots\/qr_1-2\.png/);
  assert.match(r, /http:\/\/127\.0\.0\.1:8100/);
});
