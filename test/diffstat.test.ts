import { test } from "node:test";
import assert from "node:assert/strict";
import { diffStat, isGeneratedFile } from "../src/workspace.ts";

test("改动行数：锁文件与压缩产物不计入，单独统计", () => {
  const numstat = [
    "120\t4\tbackend/app/main.py",
    "8000\t0\tfrontend/package-lock.json",
    "3000\t10\tbackend/uv.lock",
    "-\t-\tfrontend/public/logo.png",
    "30\t2\tfrontend/src/{old => new}/App.vue",
    "5\t5\tdist/app.min.js",
  ].join("\n");
  assert.deepEqual(diffStat(numstat), { files: 6, additions: 150, deletions: 6, generated: { files: 3, lines: 11020 } });
});

test("生成文件识别", () => {
  for (const f of ["package-lock.json", "a/b/pnpm-lock.yaml", "yarn.lock", "uv.lock", "poetry.lock", "go.sum", "x/app.min.css", "app.js.map"]) assert.ok(isGeneratedFile(f), f);
  for (const f of ["package.json", "pyproject.toml", "src/lock.ts", "docs/uv.lock.md", "min.js"]) assert.ok(!isGeneratedFile(f), f);
});
