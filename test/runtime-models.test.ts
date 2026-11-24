/**
 * 各 CLI 的模型检测：解析结果正确，且绝不带出 apiKey / baseUrl 等敏感信息。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseClaudeModels, parseCodexModels, parsePiModels } from "../src/runtimes.ts";

test("codex：解析模型目录，跳过不可见的模型", () => {
  const raw = JSON.stringify({
    models: [
      { slug: "gpt-5.6-sol", display_name: "GPT-5.6-Sol", visibility: "list", description: "最强" },
      { slug: "gpt-5.6-luna", display_name: "GPT-5.6-Luna", visibility: "hidden" },
      { slug: "gpt-5.5", visibility: "list" },
      { display_name: "没有 slug" },
    ],
  });
  const models = parseCodexModels(raw);
  assert.deepEqual(models.map((m) => m.id), ["gpt-5.6-sol", "gpt-5.5"]);
  assert.equal(models[0].name, "GPT-5.6-Sol");
  assert.equal(models[1].name, "gpt-5.5");
});

test("pi：模型标识带 provider 前缀（pi 只认 provider/model），同名模型不合并", () => {
  const raw = JSON.stringify({
    providers: {
      "cloudrouter-glm": {
        baseUrl: "http://10.0.0.1/v1",
        apiKey: "sk-secret-should-not-leak",
        models: [{ id: "glm-5.3", name: "GLM-5.3", contextWindow: 200000 }, { id: "glm-5.2" }],
      },
      other: { apiKey: "sk-another", models: [{ id: "glm-5.3" }, { id: "kimi-k3", contextWindow: 128000 }] },
    },
  });
  const models = parsePiModels(raw);
  assert.deepEqual(models.map((m) => m.id), ["cloudrouter-glm/glm-5.3", "cloudrouter-glm/glm-5.2", "other/glm-5.3", "other/kimi-k3"]);
  assert.match(models[0].note!, /cloudrouter-glm · 200k/);
  const json = JSON.stringify(models);
  assert.ok(!json.includes("sk-secret") && !json.includes("sk-another") && !json.includes("10.0.0.1"), "不泄露密钥与地址");
});

test("claude-code：别名 + 配置里的默认模型，不读令牌", () => {
  const settings = JSON.stringify({
    env: { ANTHROPIC_AUTH_TOKEN: "sk-token-should-not-leak", ANTHROPIC_MODEL: "claude-opus-5", ANTHROPIC_SMALL_FAST_MODEL: "claude-haiku-4-5-20251001" },
    model: "opus",
  });
  const models = parseClaudeModels(settings);
  const ids = models.map((m) => m.id);
  for (const a of ["opus", "sonnet", "haiku", "fable"]) assert.ok(ids.includes(a), a);
  assert.ok(ids.includes("claude-opus-5"));
  assert.ok(ids.includes("claude-haiku-4-5-20251001"));
  assert.equal(ids.filter((id) => id === "opus").length, 1, "别名不重复");
  assert.ok(!JSON.stringify(models).includes("sk-token"), "不泄露令牌");
  // 没有配置文件时只给别名
  assert.equal(parseClaudeModels(null).length, 4);
  // 配置损坏时不抛错
  assert.equal(parseClaudeModels("{not json").length, 4);
});
