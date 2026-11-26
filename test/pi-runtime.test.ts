/**
 * pi 运行底座：检测（登录、模型）与运行（MCP 桥、-a、输出解析）。用假的 pi 脚本，不调用真实模型。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parsePiListModels, piAuthProviders } from "../src/runtimes.ts";
import { CliRunner } from "../src/cli.ts";
import { Store } from "../src/db.ts";
import { Settings } from "../src/settings.ts";
import { AgentSchema, type Task } from "../src/types.ts";

test("pi --list-models 表格解析；auth.json 只取供应商名", () => {
  const raw = [
    "provider     model                      context  max-out  thinking  images",
    "deepseek     deepseek-v4-pro            1M       384K     yes       no",
    "kimi-coding  k3.1-pro                   1.0M     1.0M     yes       yes",
    "zai          glm-5.4                    1M       131.1K   yes       yes",
    "",
  ].join("\n");
  assert.deepEqual(parsePiListModels(raw).map((m) => m.id), ["deepseek/deepseek-v4-pro", "kimi-coding/k3.1-pro", "zai/glm-5.4"]);
  assert.equal(parsePiListModels(raw)[2].note, "zai · 1M 上下文");
  assert.deepEqual(piAuthProviders(JSON.stringify({ "kimi-coding": { type: "api_key", key: "sk-secret" }, zai: { type: "api_key", key: "x" } })), ["kimi-coding", "zai"]);
  assert.deepEqual(piAuthProviders("not json"), []);
});

test("pi 运行：带 -a，写入并清理 .pi/mcp.json（含 Hub 桥），解析回复与用量", async () => {
  const root = mkdtempSync(join(tmpdir(), "hub-pi-"));
  const bin = join(root, "bin");
  const cwd = join(root, "wt");
  mkdirSync(bin); mkdirSync(cwd);
  const seen = join(root, "seen.json");
  // 假 pi：记录参数与当时的 .pi/mcp.json，再按 pi --mode json 的格式输出事件
  writeFileSync(join(bin, "pi"), `#!/usr/bin/env node
const fs = require("fs");
const cfg = fs.existsSync(".pi/mcp.json") ? JSON.parse(fs.readFileSync(".pi/mcp.json", "utf8")) : null;
fs.writeFileSync(${JSON.stringify(seen)}, JSON.stringify({ args: process.argv.slice(2), cfg }));
const out = (e) => console.log(JSON.stringify(e));
out({ type: "session", id: "s1" });
out({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "先汇报" }, { type: "toolCall", id: "c1", name: "codemode", arguments: { code: "x" } }], usage: { input: 100, output: 10, cacheRead: 50, cost: { total: 0 } }, stopReason: "toolUse" } });
out({ type: "message_end", message: { role: "toolResult", toolCallId: "c1", content: [{ type: "text", text: "已记录" }] } });
out({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "完成了，PR 已提交" }], usage: { input: 20, output: 5, cost: { total: 0 } }, stopReason: "stop" } });
out({ type: "agent_end", messages: [] });
`);
  chmodSync(join(bin, "pi"), 0o755);
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath}`;
  try {
    const store = new Store(":memory:");
    const runner = new CliRunner(new Settings(store), { tmpDir: join(root, "tmp"), hubUrl: () => "http://127.0.0.1:1", cwdFor: () => cwd, taskToken: (id) => `tok-${id}` });
    const agent = AgentSchema.parse({ name: "frontend-dev", description: "d", runtime: "pi", cliModel: "zai/glm-5.4" });
    const task = { id: "t-pi-1", agent: "frontend-dev", input: "做页面" } as unknown as Task;
    const sizes: number[] = [];
    const out = await runner.run(task, agent, { system: "你是前端", signal: new AbortController().signal, heartbeat: () => {}, progress: (t) => sizes.push(t.length) });
    assert.deepEqual(sizes, [2, 3, 4], "每来一条消息就把对话记录推给界面（不必等运行结束）");
    const s = JSON.parse(readFileSync(seen, "utf8")) as { args: string[]; cfg: { mcpServers: { hub: { env: Record<string, string> } } } };
    assert.ok(s.args.includes("-a"), "带 -a 才会读项目里的 .pi/mcp.json");
    assert.equal(s.args[s.args.indexOf("--model") + 1], "zai/glm-5.4");
    assert.match(s.args[s.args.indexOf("--append-system-prompt") + 1], /mcp__hub__report_phase/, "告诉模型 Hub 工具在哪");
    assert.equal(s.cfg.mcpServers.hub.env.HUB_TASK_ID, "t-pi-1");
    assert.equal(s.cfg.mcpServers.hub.env.HUB_TASK_TOKEN, "tok-t-pi-1");
    // pi 的 timeout 单位是秒：24 小时 = 86400。按毫秒填会让定时器溢出、连接立刻失败（实测踩过）
    assert.equal((s.cfg.mcpServers.hub as unknown as { timeout: number }).timeout, 86400);
    assert.equal(existsSync(join(cwd, ".pi/mcp.json")), false, "运行结束清理掉");
    assert.equal(out.result, "完成了，PR 已提交");
    assert.deepEqual([out.inputTokens, out.outputTokens, out.cost], [170, 15, 0]);
    assert.equal(out.transcript?.filter((m) => m.role === "assistant").length, 2);
  } finally { process.env.PATH = oldPath; }
});

test("工作目录里原本就有 .pi/mcp.json：运行期间替换，结束后原样还原", async () => {
  const { placeHubFile } = await import("../src/cli.ts");
  const cwd = mkdtempSync(join(tmpdir(), "hub-pi-own-"));
  mkdirSync(join(cwd, ".pi"));
  writeFileSync(join(cwd, ".pi/mcp.json"), '{"mcpServers":{"mine":{}}}');
  const restore = placeHubFile(cwd, ".pi/mcp.json", { mcpServers: { hub: { env: { HUB_TASK_ID: "x" } } } });
  assert.match(readFileSync(join(cwd, ".pi/mcp.json"), "utf8"), /HUB_TASK_ID/);
  restore();
  assert.equal(readFileSync(join(cwd, ".pi/mcp.json"), "utf8"), '{"mcpServers":{"mine":{}}}');
});
