/**
 * CLI 底座兜底：智能体的模型用不了（并发超限、额度用完、鉴权失败）时换兜底链里下一个能用的模型重跑；
 * 之后一段时间内新任务直接走兜底，不再先失败一次。任务本身的错误不换模型。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/db.ts";
import { Runtime, type CliExecutor } from "../src/runtime.ts";
import { AgentSchema } from "../src/types.ts";
import { providerDown } from "../src/transient.ts";

const KIMI_BUSY = `403: {"message":"You've reached your concurrent request limit. Please wait for your ongoing requests to finish and try again.","type":"access_terminated_error"}`;

function setup(fail: (model: string, input: string) => string | null) {
  const calls: { input: string; runtime: string; model: string; fresh?: boolean }[] = [];
  const cli: CliExecutor = {
    fallbacks: (a) => [{ runtime: "pi", model: "zai/glm-5.4" }, { runtime: "claude-code", model: "" }].filter((c) => !(c.runtime === a.runtime && c.model === a.cliModel)),
    run: async (task, agent, ctx) => {
      calls.push({ input: task.input, runtime: agent.runtime, model: agent.cliModel, fresh: ctx.fresh });
      const err = fail(agent.cliModel, task.input);
      if (err) throw new Error(err);
      return { result: `${agent.runtime}:${agent.cliModel}` };
    },
  };
  const store = new Store(":memory:");
  store.upsertAgent(AgentSchema.parse({ name: "backend-dev", runtime: "pi", cliModel: "kimi-coding/k3.1-pro" }));
  const runtime = new Runtime(store, { create: async () => { throw new Error("不应调用内置模型"); } }, { maxConcurrency: 4, maxDepth: 2, maxHops: 2 });
  runtime.cli = cli;
  const notes: string[] = [];
  runtime.setHooks({ fallback: (_t, from, to) => notes.push(`${from} → ${to}`) });
  return { runtime, calls, notes };
}

test("Kimi 并发超限：自动改用 GLM 跑完；随后的任务直接走 GLM", async () => {
  const { runtime, calls, notes } = setup((m) => (m.startsWith("kimi") ? KIMI_BUSY : null));
  const a = await runtime.waitFor(runtime.submit("backend-dev", "A").id);
  assert.equal(a.status, "completed", a.error ?? "");
  assert.equal(a.result, "pi:zai/glm-5.4");
  assert.deepEqual(notes, ["pi kimi-coding/k3.1-pro → pi zai/glm-5.4"]);
  assert.equal(calls[1].fresh, false, "同一个底座（pi）换模型可以续原来的会话");
  const b = await runtime.waitFor(runtime.submit("backend-dev", "B").id);
  assert.equal(b.result, "pi:zai/glm-5.4");
  assert.deepEqual(calls.filter((c) => c.input === "B").map((c) => c.model), ["zai/glm-5.4"], "Kimi 在冷却期内，不再先失败一次");
});

test("GLM 也额度用完：换到 Claude Code，开新会话", async () => {
  const { runtime, calls } = setup((m) => (m ? `429: Usage limit reached for 5 hour. Your limit will reset at 2099-01-01 00:00:00` : null));
  const a = await runtime.waitFor(runtime.submit("backend-dev", "A").id);
  assert.equal(a.result, "claude-code:");
  assert.deepEqual(calls.map((c) => c.model), ["kimi-coding/k3.1-pro", "zai/glm-5.4", ""]);
  assert.equal(calls[2].fresh, true, "跨底座不续别家 CLI 的会话");
});

test("任务本身的错误不换模型；全部不可用时照常失败", async () => {
  const own = setup(() => "已进行 3 轮仍未通过");
  const a = await own.runtime.waitFor(own.runtime.submit("backend-dev", "A").id);
  assert.equal(a.status, "failed");
  assert.equal(own.calls.length, 1);
  const all = setup(() => "401 Unauthorized: invalid api key");
  const b = await all.runtime.waitFor(all.runtime.submit("backend-dev", "B").id);
  assert.equal(b.status, "failed");
  assert.equal(all.calls.length, 3, "每个候选都试了一次");
});

test("providerDown 识别", () => {
  for (const e of [KIMI_BUSY, "429 Too Many Requests", "401 Unauthorized", "Invalid API key · Please run /login", "fetch failed"]) assert.ok(providerDown(e), e);
  for (const e of ["已进行 3 轮仍未通过", "需求不清楚", "agent backend-dev was deleted"]) assert.ok(!providerDown(e), e);
});
