/**
 * 上下文回执：记录什么交给了智能体、以什么方式、多大；只存元数据。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/db.ts";
import { builtinReceipt, cliReceipt, readReceipt, recordReceipt } from "../src/receipt.ts";

test("回执：内置底座记录系统提示词、任务输入、技能与工具", () => {
  const r = builtinReceipt({
    taskId: "t1", agent: "backend-dev", model: "claude-opus-5-5",
    system: "你是后端工程师", input: "修个 bug", tools: ["report_phase", "read_topic"], skills: ["code-review"], knowledge: 2,
  });
  assert.equal(r.runtime, "builtin");
  assert.equal(r.systemBytes, Buffer.byteLength("你是后端工程师"));
  assert.equal(r.sources[0].delivery, "system-param");
  assert.ok(r.sources.some((s) => s.kind === "技能" && s.delivery === "catalog-tool"));
  assert.ok(r.sources.some((s) => s.kind === "项目知识"));
  assert.deepEqual(r.tools, ["report_phase", "read_topic"]);
});

test("回执：CLI 底座区分系统提示词走参数还是并入输入，技能区分原生文件", () => {
  const param = cliReceipt({ taskId: "t2", agent: "frontend-dev", model: "（CLI 默认）", runtime: "claude-code", system: "sys", input: "in", systemDelivery: "system-param", skills: [{ id: "code-review", delivery: "native-file" }], tools: ["hub"], workdir: "/tmp/wt/HUB-1", promptSent: "in" });
  assert.equal(param.sources[0].delivery, "system-param");
  assert.equal(param.sources.find((s) => s.kind === "技能")!.delivery, "native-file");
  assert.equal(param.workdir, "/tmp/wt/HUB-1");
  const inline = cliReceipt({ taskId: "t3", agent: "backend-dev", model: "m", runtime: "codex", system: "sys", input: "in", systemDelivery: "prompt-inline", skills: [], tools: [], workdir: null, promptSent: "sys\n\n---\n\nin" });
  assert.equal(inline.sources[0].delivery, "prompt-inline");
  assert.ok(inline.promptBytes > inline.systemBytes);
});

test("回执：按任务存取，不保存 prompt 正文", () => {
  const store = new Store(":memory:");
  const r = builtinReceipt({ taskId: "t4", agent: "a", model: "m", system: "秘密系统提示词", input: "秘密输入", tools: [], skills: [], knowledge: 0 });
  recordReceipt(store, r);
  const got = readReceipt(store, "t4")!;
  assert.equal(got.agent, "a");
  const json = JSON.stringify(got);
  assert.ok(!json.includes("秘密系统提示词"), "正文不落库");
  assert.ok(!json.includes("秘密输入"));
  assert.equal(readReceipt(store, "nope"), null);
});
