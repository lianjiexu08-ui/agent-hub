import { test } from "node:test";
import assert from "node:assert/strict";
import { pickCriteria } from "../src/work.ts";
import { assessRequirement } from "../src/quality.ts";

test("需求缺验收标准时，从需求理解汇报里取出标准；写回后评分里不再是 AI 推断", () => {
  const note = "目标：新增分组健康阈值告警。\n\n验收标准：\n1. 超过阈值 5 分钟内发出 webhook 告警\n2. 恢复后发一条恢复通知\n- 同一分组 30 分钟内不重复告警\n\n不确定的点：\n- 阈值默认多少？";
  const c = pickCriteria(note);
  assert.deepEqual(c, ["超过阈值 5 分钟内发出 webhook 告警", "恢复后发一条恢复通知", "同一分组 30 分钟内不重复告警"]);
  const desc = `给分组加健康告警。\n\n## 验收标准\n${c.map((x) => `- ${x}`).join("\n")}`;
  const q = assessRequirement({ title: "分组健康告警", description: desc });
  assert.equal(q.aiCriteria, false);
  assert.deepEqual(q.criteria, c);
});
