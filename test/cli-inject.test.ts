/**
 * CLI 底座注入：没有系统提示词参数的底座（codex）把角色设定并入 prompt；
 * Claude Code 原生技能文件的格式。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { promptWithSystem, skillMarkdown } from "../src/cli.ts";

test("注入：模板有 {system} 时不动 prompt；没有时并入", () => {
  const sys = "你是后端工程师。\n\n## 可用技能\n- code-review";
  assert.equal(promptWithSystem('claude -p "{prompt}" --append-system-prompt "{system}"', sys, "修个 bug"), "修个 bug");
  const codex = promptWithSystem('codex exec --json -m {model} "{prompt}"', sys, "修个 bug");
  assert.ok(codex.startsWith("你是后端工程师。"));
  assert.ok(codex.endsWith("修个 bug"));
  assert.ok(codex.includes("---"));
  assert.equal(promptWithSystem('codex exec "{prompt}"', "   ", "原样"), "原样", "没有系统提示词时保持原样");
});

test("技能文件：Claude Code 的 SKILL.md 格式", () => {
  const md = skillMarkdown({ id: "Code_Review", name: "代码评审", description: "审查改动\n多行说明", instructions: "1. 看验收标准" });
  assert.match(md, /^---\nname: code-review\ndescription: 审查改动 多行说明\n---\n\n# 代码评审\n/);
  assert.match(md, /1\. 看验收标准/);
  assert.ok(skillMarkdown({ id: "x".repeat(100), name: "n", description: "d", instructions: "i" }).match(/name: (\w|-)+/)![1].length <= 64);
});
