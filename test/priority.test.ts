import { test } from "node:test";
import assert from "node:assert/strict";
import { byPriority, priorityRank } from "../src/priority.ts";

test("优先级排序：紧急 → 高 → 中 → 低 → 无", () => {
  const xs = [{ priority: 0 }, { priority: 4 }, { priority: 1 }, { priority: 3 }, { priority: 2 }];
  assert.deepEqual(xs.sort(byPriority).map((x) => x.priority), [1, 2, 3, 4, 0]);
  assert.equal(priorityRank(1), 1);
  assert.equal(priorityRank(4), 4);
  assert.equal(priorityRank(0), 5);
  assert.equal(priorityRank(undefined), 5);
  assert.equal(priorityRank(null), 5);
  assert.equal(priorityRank(9), 5);
});
