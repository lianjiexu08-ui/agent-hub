import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/db.ts";
import { buildApi, type Services } from "../src/api.ts";
import { AgentSchema } from "../src/types.ts";

test("一键切换运行底座：只改用内置底座的智能体，CLI 模型清空", async () => {
  const store = new Store(":memory:");
  store.upsertAgent(AgentSchema.parse({ name: "pm", description: "pm" }));
  store.upsertAgent(AgentSchema.parse({ name: "qa", description: "qa", runtime: "builtin" }));
  store.upsertAgent(AgentSchema.parse({ name: "dev", description: "dev", runtime: "codex", cliModel: "gpt-x" }));
  const events = { emit: () => true };
  const api = buildApi({ store, runtime: { events } } as unknown as Services);
  assert.equal(await api.rpc("studio.switchRuntime", ["builtin", "claude-code"]), 2);
  assert.deepEqual(store.listAgents().map((a) => [a.name, a.runtime, a.cliModel]).sort(), [["dev", "codex", "gpt-x"], ["pm", "claude-code", ""], ["qa", "claude-code", ""]]);
  await assert.rejects(api.rpc("studio.switchRuntime", ["builtin", "nope"]), /未知的运行底座/);
});
