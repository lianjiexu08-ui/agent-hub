import { test } from "node:test";
import assert from "node:assert/strict";
import { diffStat, isGeneratedFile, isTestFile } from "../src/workspace.ts";

test("改动行数：锁文件与压缩产物不计入，单独统计", () => {
  const numstat = [
    "120\t4\tbackend/app/main.py",
    "8000\t0\tfrontend/package-lock.json",
    "3000\t10\tbackend/uv.lock",
    "-\t-\tfrontend/public/logo.png",
    "30\t2\tfrontend/src/{old => new}/App.vue",
    "5\t5\tdist/app.min.js",
  ].join("\n");
  assert.deepEqual(diffStat(numstat), { files: 6, additions: 150, deletions: 6, generated: { files: 3, lines: 11020 }, tests: { files: 0, lines: 0 } });
});

test("改动行数：测试代码计入总数，另外单独统计", () => {
  const numstat = [
    "700\t0\tfrontend/src/views/tickets/TicketListView.vue",
    "882\t0\tfrontend/src/__tests__/TicketListView.spec.ts",
    "100\t20\tbackend/tests/test_auth.py",
    "40\t0\tbackend/app/test_utils_helpers.py",
    "10\t0\tsrc/a.test.ts",
    "555\t0\tfrontend/package-lock.json",
  ].join("\n");
  const s = diffStat(numstat);
  assert.equal(s.additions + s.deletions, 1752);
  assert.deepEqual(s.tests, { files: 4, lines: 1052 }, "test_*.py 按 pytest 惯例算测试");
});

test("测试文件识别", () => {
  for (const f of ["frontend/src/__tests__/a.ts", "tests/x.py", "backend/tests/conftest.py", "src/a.spec.ts", "a.test.tsx", "app/test_x.py", "pkg/x_test.go", "e2e/login.ts"]) assert.ok(isTestFile(f), f);
  for (const f of ["src/testing.ts", "src/latest.ts", "app/contest.py", "src/views/Test.vue", "docs/testing.md"]) assert.ok(!isTestFile(f), f);
});

test("生成文件识别", () => {
  for (const f of ["package-lock.json", "a/b/pnpm-lock.yaml", "yarn.lock", "uv.lock", "poetry.lock", "go.sum", "x/app.min.css", "app.js.map"]) assert.ok(isGeneratedFile(f), f);
  for (const f of ["package.json", "pyproject.toml", "src/lock.ts", "docs/uv.lock.md", "min.js"]) assert.ok(!isGeneratedFile(f), f);
});
