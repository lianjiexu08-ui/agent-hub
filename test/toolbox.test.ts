/**
 * 工具与技能：路径限制、工具目录一致性、智能体 schema、内置技能迁移。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { safeJoin } from "../src/toolbox.ts";
import { WORKSPACE_TOOLS } from "../src/workspace.ts";
import { AgentSchema, BUILTIN_TOOL_META, BUILTIN_TOOL_NAMES, OPTIONAL_BUILTIN_TOOL_NAMES } from "../src/types.ts";
import { Settings } from "../src/settings.ts";
import { Store } from "../src/db.ts";

test("路径限制：只能访问工作目录内，越界与符号无关的 ../ 都拒绝", () => {
  const root = mkdtempSync(join(tmpdir(), "hub-ws-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "a.ts"), "x");

  assert.equal(safeJoin(root, "src/a.ts"), join(root, "src", "a.ts"));
  assert.equal(safeJoin(root, "./src/../src/a.ts"), join(root, "src", "a.ts"), "目录内往返允许");
  assert.equal(safeJoin(root, "."), root);

  assert.throws(() => safeJoin(root, "../etc/passwd"), /只能访问工作目录内/);
  assert.throws(() => safeJoin(root, "src/../../outside"), /只能访问工作目录内/);
  assert.throws(() => safeJoin(root, "/etc/passwd"), /只能访问工作目录内/, "绝对路径同样拒绝");
});

test("工具目录：元数据与名单一致，不重名，不遗漏", () => {
  const names = BUILTIN_TOOL_META.map((t) => t.name);
  assert.equal(new Set(names).size, names.length, "没有重复条目");
  for (const optional of OPTIONAL_BUILTIN_TOOL_NAMES) {
    const meta = BUILTIN_TOOL_META.find((t) => t.name === optional);
    assert.ok(meta, `${optional} 必须在工具目录里`);
    assert.equal(meta!.always, false, `${optional} 属于需要手动开启的工具`);
    assert.notEqual(meta!.risk, "none", `${optional} 有副作用，必须标注风险`);
  }
  for (const meta of BUILTIN_TOOL_META) {
    const known = BUILTIN_TOOL_NAMES.includes(meta.name) || (OPTIONAL_BUILTIN_TOOL_NAMES as readonly string[]).includes(meta.name);
    if (meta.group !== "文件" && meta.group !== "执行") assert.ok(known, `${meta.name} 不在任何工具名单里`);
  }
  // 文件/命令类工具必须要求工作目录，否则会在服务器任意位置读写
  for (const t of ["read_file", "write_file", "list_files", "search_repo", "run_command"]) {
    assert.ok(WORKSPACE_TOOLS.includes(t), `${t} 必须要求工作目录`);
  }
});

test("智能体 schema：builtinTools 默认空，只接受已知工具名", () => {
  const base = { name: "x" };
  assert.deepEqual(AgentSchema.parse(base).builtinTools, [], "默认不给扩展工具");
  const ok = AgentSchema.parse({ ...base, builtinTools: ["read_file", "run_command"] });
  assert.deepEqual(ok.builtinTools, ["read_file", "run_command"]);
  assert.throws(() => AgentSchema.parse({ ...base, builtinTools: ["rm_rf"] }), /invalid|Invalid/);
});

test("内置技能：旧模板被升级为完整规范，用户改过的不动", () => {
  const store = new Store(":memory:");
  // 模拟升级前的库：一条旧模板、一条被用户改过的
  store.docPut("skills", "code-review", { id: "code-review", name: "代码评审", description: "x", instructions: "## 代码评审清单\n\n1. 是否满足验收标准", createdBy: "内置", updatedAt: "2026-01-01T00:00:00.000Z" });
  store.docPut("skills", "chinese-copy", { id: "chinese-copy", name: "我的文案规范", description: "自定义", instructions: "## 我们团队的文案\n\n" + "细则。".repeat(200), createdBy: "内置", updatedAt: "2026-01-01T00:00:00.000Z" });
  store.docPut("meta", "seed-skills", { id: "seed-skills", skills: ["code-review", "chinese-copy"] });

  new Settings(store);

  const review = store.docGet<{ instructions: string }>("skills", "code-review")!;
  assert.ok(review.instructions.length > 800, "旧模板被替换成长文");
  assert.match(review.instructions, /检查清单/, "新版包含检查清单");
  assert.match(review.instructions, /输出模板/, "新版包含输出模板");

  const mine = store.docGet<{ name: string; instructions: string }>("skills", "chinese-copy")!;
  assert.equal(mine.name, "我的文案规范", "用户改过的保留原样");
  assert.match(mine.instructions, /我们团队的文案/);

  // 新增的两个技能被补进来
  assert.ok(store.docGet("skills", "test-design"), "新增测试设计");
  assert.ok(store.docGet("skills", "debugging"), "新增故障排查");

  // 再启动一次不应重复覆盖
  const before = store.docGet<{ updatedAt: string }>("skills", "code-review")!.updatedAt;
  new Settings(store);
  assert.equal(store.docGet<{ updatedAt: string }>("skills", "code-review")!.updatedAt, before, "迁移幂等");
});

test("工具箱：读写、检索、执行都限定在工作目录内，并把结果返回给模型", async () => {
  const { registerToolbox } = await import("../src/toolbox.ts");
  const root = mkdtempSync(join(tmpdir(), "hub-tb-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "hello.ts"), "export const hello = 1;\n");

  const store = new Store(":memory:");
  store.upsertAgent(AgentSchema.parse({ name: "coder", builtinTools: ["read_file", "write_file", "list_files", "search_repo", "run_command"] }));
  store.upsertAgent(AgentSchema.parse({ name: "plain" }));

  const tools = new Map<string, { run: Function; when?: Function }>();
  const fakeRuntime = { addTool: (def: { name: string }, run: Function, when?: Function) => tools.set(def.name, { run, when }) } as never;

  const deps = {
    store,
    settings: { get: () => ({ guard: { isolation: "worktree", network: "allowlist" } }), knowledge: () => [] },
    work: { list: () => [{ id: "1", key: "P-1", projectId: "p1" }], proj: () => ({ id: "p1", repo: { fullName: "a/b" } }), projects: () => [{ id: "p1", key: "P" }] },
    workspace: { enabledFor: (_p: unknown, a: { builtinTools?: string[] }) => (a.builtinTools ?? []).length > 0, dir: () => root },
  } as never;
  registerToolbox(fakeRuntime, deps);

  const ctx = (agent: string, signal = new AbortController().signal) => ({ task: { issueId: "1", agent } as never, agent: { name: agent }, signal });

  // 没开启的智能体：工具注册了但不会出现在它的工具表里
  for (const name of ["read_file", "write_file", "list_files", "search_repo", "run_command"]) {
    const when = tools.get(name)!.when as Function;
    assert.equal(when({ issueId: "1" }, { name: "plain", builtinTools: [] }), false, `${name} 对未开启的智能体不可用`);
    assert.equal(when({ issueId: "1" }, { name: "coder", builtinTools: ["read_file", "write_file", "list_files", "search_repo", "run_command"] }), true);
  }

  const read = tools.get("read_file")!.run;
  const write = tools.get("write_file")!.run;
  const list = tools.get("list_files")!.run;
  const search = tools.get("search_repo")!.run;
  const run = tools.get("run_command")!.run;

  assert.match((await read({ path: "src/hello.ts" }, ctx("coder"))).content, /export const hello = 1/);
  assert.equal((await read({ path: "../secret" }, ctx("coder"))).isError, true, "越界读取被拒");

  assert.match((await write({ path: "src/new.ts", content: "x" }, ctx("coder"))).content, /已写入 src\/new.ts/);
  assert.match((await read({ path: "src/new.ts" }, ctx("coder"))).content, /^x$/);

  assert.match((await list({ depth: 2 }, ctx("coder"))).content, /src\//);
  assert.match((await search({ query: "hello" }, ctx("coder"))).content, /src\/hello\.ts/);

  const out = await run({ command: "pwd && echo ok" }, ctx("coder"));
  assert.equal(out.isError, undefined);
  assert.match(out.content, /ok/);
  assert.ok(out.content.trim().split("\n").length >= 2, "包含命令回显与输出");

  const bad = await run({ command: "ls /nonexistent-dir-xyz" }, ctx("coder"));
  assert.equal(bad.isError, true, "失败命令返回错误而不是抛异常");
});
