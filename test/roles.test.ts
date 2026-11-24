import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Store } from "../src/db.ts";
import { Settings, DEFAULT_SKILLS } from "../src/settings.ts";
import { importSeed } from "../src/seed.ts";
import { pickDevRole, pickReassignTarget } from "../src/roles.ts";
import { AgentSchema } from "../src/types.ts";

const seed = JSON.parse(readFileSync(new URL("../agents.seed.json", import.meta.url), "utf8"));

test("种子：研发角色齐全，委派对象与技能都存在", () => {
  const names = new Set(seed.map((a: { name: string }) => a.name));
  for (const n of ["product-manager", "architect", "frontend-dev", "backend-dev", "devops", "code-reviewer", "security-auditor", "developer", "tester", "project-lead"]) assert.ok(names.has(n), n);
  const skills = new Set(DEFAULT_SKILLS.map((s) => s.id));
  for (const a of AgentSchema.array().parse(seed)) {
    for (const s of a.skills) assert.ok(skills.has(s), `${a.name} 引用了不存在的技能 ${s}`);
    if (Array.isArray(a.delegation)) for (const d of a.delegation) assert.ok(names.has(d), `${a.name} 委派给不存在的 ${d}`);
  }
});

test("种子：老实例补上新增角色；有导入记录后，人删掉的不会回来", () => {
  const store = new Store(":memory:");
  // 模拟老实例：只有最早的 7 个角色，没有导入记录
  for (const a of seed.slice(0, 7)) store.upsertAgent(AgentSchema.parse(a));
  const added = importSeed(store, { agents: seed });
  assert.ok(added.includes("backend-dev") && added.includes("code-reviewer"));
  assert.ok(!added.includes("developer"), "已存在的不覆盖");
  assert.equal(store.listAgents().length, seed.length);
  store.deleteAgent("devops");
  assert.deepEqual(importSeed(store, { agents: seed }), [], "再次启动不重复导入、不恢复被删的");
  assert.equal(store.getAgent("devops"), undefined);
});

test("技能：老实例补上新增的内置技能，删掉的不会回来", () => {
  const store = new Store(":memory:");
  store.docPut("skills", "task-decomposition", { id: "task-decomposition", name: "x" });
  new Settings(store);
  assert.ok(store.docGet("skills", "code-review"));
  store.docDelete("skills", "code-review");
  new Settings(store);
  assert.equal(store.docGet("skills", "code-review"), undefined);
});

test("角色路由：按标签和内容选择开发角色，缺失时回退", () => {
  const store = new Store(":memory:");
  importSeed(store, { agents: seed });
  assert.equal(pickDevRole(store, { title: "移动端导航错位", labels: ["bug"] }), "frontend-dev");
  assert.equal(pickDevRole(store, { title: "调度失败时的重试策略", description: "模型返回 529 时指数退避" }), "backend-dev");
  assert.equal(pickDevRole(store, { title: "CI 偶发超时" }), "devops");
  assert.equal(pickDevRole(store, { title: "随便改改", labels: ["backend"] }), "backend-dev");
  assert.equal(pickDevRole(store, { title: "README 补充快速开始" }), "developer");
  store.deleteAgent("frontend-dev");
  assert.equal(pickDevRole(store, { title: "首页样式调整" }), "developer");
  assert.equal(pickReassignTarget(store, "backend-dev", { title: "接口超时" }), "developer");
  assert.equal(pickReassignTarget(store, "developer", { title: "接口超时" }), "backend-dev");
});
