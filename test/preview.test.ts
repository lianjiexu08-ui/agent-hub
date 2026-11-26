/**
 * 工作项预览：按端口启动本分支前后端、就绪判断、关闭整个进程组；QA 验收前起预览、建浏览器，结束时关闭。
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Previews } from "../src/preview.ts";
import { Store } from "../src/db.ts";
import { Runtime } from "../src/runtime.ts";
import { Settings } from "../src/settings.ts";
import { QA } from "../src/qa.ts";
import { simulatedLLM } from "../src/simulate.ts";
import { AgentSchema } from "../src/types.ts";

const noBrowser = { name: "none", available: () => false, create: async () => null, exec: async () => ({ ok: false, text: "" }), destroy: async () => {}, close: async () => {} };
const tmp = mkdtempSync(join(tmpdir(), "hub-preview-"));
const SERVER = `node -e "require('http').createServer((q,r)=>r.end(process.env.HUB_ISSUE_SLUG+':'+process.env.PREVIEW_API_PORT)).listen(process.env.PREVIEW_PORT)"`;

test("预览：拿到端口启动、就绪后可访问；关闭后端口释放", async () => {
  const pv = new Previews({ tmpDir: tmp, backend: () => noBrowser, readyTimeoutMs: 15_000 });
  const h = await pv.start("r1", tmp, SERVER, { HUB_ISSUE_SLUG: "s2t_13" });
  assert.equal(h.ready, true);
  assert.equal(await (await fetch(h.url)).text(), `s2t_13:${h.apiPort}`, "拿到了隔离用的变量和后端端口");
  pv.stop("r1");
  await new Promise((r) => setTimeout(r, 500));
  await assert.rejects(fetch(h.url, { signal: AbortSignal.timeout(2000) }), "进程组已结束");
});

test("预览失败：命令退出时返回原因和日志，不会卡住", async () => {
  const pv = new Previews({ tmpDir: tmp, backend: () => noBrowser, readyTimeoutMs: 15_000 });
  const h = await pv.start("r2", tmp, "echo 'vite: command not found' >&2; exit 3", {});
  assert.equal(h.ready, false);
  assert.match(h.error ?? "", /退出码 3/);
  assert.match(h.log, /vite: command not found/);
});

const qas: QA[] = [];
after(() => qas.forEach((q) => q.stop()));

test("验收前先起本分支预览、建浏览器，把地址交给 tester；结束时关闭", async () => {
  const store = new Store(":memory:");
  store.upsertAgent(AgentSchema.parse({ name: "tester", description: "t" }));
  const runtime = new Runtime(store, simulatedLLM({ delayMs: [5000, 6000] }), { maxConcurrency: 2, maxDepth: 1, maxHops: 1 });
  const env = { baseUrl: "", preview: "", accounts: ["preview / preview-pass-2026"], previewCmd: "scripts/preview.sh" };
  const qa = new QA(store, runtime, new Settings(store), () => ({ env }) as never, false, { stepMs: 1 });
  qas.push(qa);
  const calls: string[] = [];
  qa.previews = {
    start: async (_id: string, cwd: string, cmd: string, e: Record<string, string>) => { calls.push(`start ${cwd} ${cmd} ${e.HUB_ISSUE_SLUG}`); return { url: "http://127.0.0.1:5301", port: 5301, apiPort: 8301, log: "", ready: true }; },
    browser: async () => { calls.push("browser"); return "b-1"; },
    stop: (id: string) => calls.push(`stop ${id}`),
    hasBrowser: () => true,
    engine: () => "builtin",
    exec: async () => ({ ok: true, text: "" }),
  } as never;
  qa.worktreeFor = () => "/tmp/wt/S2T-13";
  const id = qa.enqueue({ key: "S2T-13", title: "对话工作台", description: "【验收标准】\n- 两轮对话后出现确认卡片\n- 点确认后显示工单号", labels: [], projectId: "p", pr: { number: 31 }, priority: 1, quality: { criteria: ["两轮对话后出现确认卡片", "点确认后显示工单号"] } } as never, "lifecycle");
  const t0 = Date.now();
  while (!qa.run(id)?.taskId) { if (Date.now() - t0 > 5000) throw new Error("没有交给 tester"); await new Promise((r) => setTimeout(r, 20)); }
  const r = qa.run(id)!;
  assert.deepEqual(calls.slice(0, 2), ["start /tmp/wt/S2T-13 scripts/preview.sh s2t_13", "browser"]);
  assert.equal(r.previewUrl, "http://127.0.0.1:5301");
  assert.equal(r.browserId, "b-1");
  assert.deepEqual(r.cases.map((c) => c.kind), ["browser", "browser", "health"], "有预览和浏览器：生成浏览器用例");
  const input = store.getTask(r.taskId!)!.input;
  assert.match(input, /测试环境：http:\/\/127\.0\.0\.1:5301（这个工作项分支的本地预览/);
  assert.match(input, /测试账号：preview \/ preview-pass-2026/);
  assert.match(input, /已为你准备好一个独立的无头浏览器/);
  qa.cancel(id);
  assert.ok(calls.includes(`stop ${id}`), "结束时关闭预览与浏览器");
});
