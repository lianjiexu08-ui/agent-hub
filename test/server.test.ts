/**
 * HTTP 层冒烟测试：面板与拆分后的静态资源，不访问网络。
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/db.ts";
import { Runtime } from "../src/runtime.ts";
import { simulatedLLM } from "../src/simulate.ts";
import { createApp } from "../src/server.ts";

const store = new Store(":memory:");
const runtime = new Runtime(store, simulatedLLM({ delayMs: [1, 1] }), { maxConcurrency: 2, maxDepth: 2, maxHops: 2 });
const app = createApp(store, runtime);
after(() => void runtime.mcp.closeAll());

test("面板返回 HTML，并引用拆分后的样式与脚本", async () => {
  const res = await app.request("/");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /text\/html/);
  const html = await res.text();
  assert.match(html, /<link rel="stylesheet" href="\/assets\/styles\.css">/);
  assert.match(html, /<script src="\/assets\/app\.js" defer><\/script>/);
  assert.ok(!html.includes("<style>"), "样式已从 index.html 拆出");
});

test("静态资源：CSS 与 JS 可直接访问且类型正确", async () => {
  const css = await app.request("/assets/styles.css");
  assert.equal(css.status, 200);
  assert.match(css.headers.get("content-type") ?? "", /text\/css/);
  assert.match(await css.text(), /--accent/);

  const js = await app.request("/assets/app.js");
  assert.equal(js.status, 200);
  assert.match(js.headers.get("content-type") ?? "", /javascript/);
  assert.match(await js.text(), /function showView/);
});

test("静态资源：未知文件与路径穿越返回 404", async () => {
  for (const path of ["/assets/missing.js", "/assets/..%2F..%2Fpackage.json", "/assets/..%2Fsrc%2Fserver.ts", "/assets/app.txt"]) {
    const res = await app.request(path);
    assert.equal(res.status, 404, path);
  }
});
