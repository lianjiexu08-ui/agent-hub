import { test } from "node:test";
import assert from "node:assert/strict";
import { assessRequirement, extractCriteria } from "../src/quality.ts";
import { Store } from "../src/db.ts";
import { Runtime } from "../src/runtime.ts";
import { Settings } from "../src/settings.ts";
import { QA } from "../src/qa.ts";
import { simulatedLLM } from "../src/simulate.ts";

// 管家拆出来的真实格式：先「要做的事」再「验收标准」
const DESC = `【依赖】无

【背景】S2T 仓库目前是空的。

【要做的事】
1. 目录：backend/、frontend/、docs/。
2. 后端：用 pyproject 管理依赖。
3. 前端：vitest + @vue/test-utils；空首页能跑起来。

【验收标准】
- 全新环境按 README 执行后，GET /healthz 返回 200。
- make test 通过。
- make lint 通过（ruff、mypy、eslint、vue-tsc）。
- CI 在 PR 上自动运行并通过。`;

test("验收标准只取「验收标准」小节，不把「要做的事」当成验收标准", () => {
  assert.deepEqual(extractCriteria(DESC), ["全新环境按 README 执行后，GET /healthz 返回 200。", "make test 通过。", "make lint 通过（ruff、mypy、eslint、vue-tsc）。", "CI 在 PR 上自动运行并通过。"]);
  const q = assessRequirement({ title: "01 项目骨架", description: DESC });
  assert.equal(q.aiCriteria, false);
  assert.equal(q.criteria.length, 4);
});

test("其它写法：Markdown 标题、冒号小节、带括号的小节名；没有小节时退回全文列表", () => {
  assert.deepEqual(extractCriteria("## 要做\n- a\n- b\n## 验收标准\n- x\n- y\n## 备注\n- z"), ["x", "y"]);
  assert.deepEqual(extractCriteria("做个页面\n验收标准：\n1. 能打开\n2. 无报错"), ["能打开", "无报错"]);
  assert.deepEqual(extractCriteria("【要做的事】\n- a\n【验收标准（pytest，假模型）】\n- 测 1\n- 测 2"), ["测 1", "测 2"]);
  assert.deepEqual(extractCriteria("- 第一条\n- 第二条"), ["第一条", "第二条"]);
});

test("真实模式：没有测试地址或没有 DevEye 时不生成浏览器用例", () => {
  const store = new Store(":memory:");
  const settings = new Settings(store);
  const runtime = new Runtime(store, simulatedLLM({ delayMs: [1, 1] }), { maxConcurrency: 1, maxDepth: 1, maxHops: 1 });
  let env = { baseUrl: "", preview: "", accounts: [] as string[] };
  const qa = new QA(store, runtime, settings, () => ({ env }) as never, false);
  const issue = { key: "S2T-1", title: "01 项目骨架：前端页面", description: DESC, labels: [], projectId: "p", pr: null, priority: 1, quality: assessRequirement({ title: "x", description: DESC }) };
  const build = () => (qa as unknown as { buildCases(i: typeof issue): { kind: string }[] }).buildCases(issue);
  qa.deveye = true;
  assert.deepEqual(build().map((c) => c.kind), ["check", "check", "check", "check"], "有 DevEye 但没有测试地址");
  env = { baseUrl: "http://localhost:5173", preview: "", accounts: [] };
  qa.deveye = false;
  assert.ok(build().every((c) => c.kind === "check"), "有地址但没有 DevEye");
  qa.deveye = true;
  assert.deepEqual(build().map((c) => c.kind), ["browser", "browser", "browser", "browser", "health"]);
  qa.stop();
});
