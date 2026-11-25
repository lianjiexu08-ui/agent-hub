/**
 * 会话层的单元测试：只验证 src/session.ts 的规则，不涉及工具层与模型调用。
 *
 * 每条用例都用 ":memory:" 独立建库：消息序号、会话列表都是全库共享的，
 * 复用同一个库会让上一条用例的数据串进下一条，断言就失去意义。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/db.ts";
import { Sessions, type OpenInput } from "../src/session.ts";

function setup() {
  const store = new Store(":memory:");
  return { store, sessions: new Sessions(store) };
}

/** 默认参数放在一处，用例只覆盖自己关心的字段，读起来才知道差异在哪 */
function opening(overrides: Partial<OpenInput> = {}): OpenInput {
  return {
    topic: "前后端的接口边界怎么划",
    participants: ["architect", "frontend"],
    opening: "我先给结论：按资源划分，前端只依赖契约。",
    ...overrides,
  };
}

test("创建会话：id 前缀、轮次为 1、开场白成为第 1 条消息", () => {
  const { store, sessions } = setup();
  const input = opening();
  const before = Date.now();
  const s = sessions.open(input);
  const after = Date.now();

  assert.match(s.id, /^s_\w{6}$/, "id 是 s_ 加 6 位随机");
  assert.equal(s.topic, input.topic);
  assert.deepEqual(s.participants, ["architect", "frontend"]);
  assert.equal(s.turn, 1, "开场白已经占掉第 1 轮");
  assert.equal(s.maxTurns, 6, "轮次默认 6");
  assert.equal(s.tokenBudget, 60_000, "token 预算默认 60k");
  assert.equal(s.tokensUsed, 0);
  assert.equal(s.status, "open");
  assert.equal(s.conclusion, null);
  assert.equal(s.endReason, null);
  assert.equal(s.projectId, null);
  assert.equal(s.issueId, null);

  // 默认 15 分钟截止，允许创建前后几毫秒的误差
  const ttl = Date.parse(s.deadline);
  assert.ok(ttl >= before + 15 * 60_000 - 1000, "截止时间不早于 15 分钟后");
  assert.ok(ttl <= after + 15 * 60_000 + 1000, "截止时间不晚于 15 分钟后");

  const msgs = sessions.messages(s.id);
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].sessionId, s.id);
  assert.equal(msgs[0].turn, 1);
  assert.equal(msgs[0].from, "architect", "开场白由发起方说出");
  assert.equal(msgs[0].text, input.opening);
  assert.ok(msgs[0].id > 0);

  assert.deepEqual(sessions.get(s.id), s);
  assert.deepEqual(store.docGet("sessions", s.id), s, "会话已落库");
});

test("创建时校验：参与方重复或议题为空都拒绝，且不留半截会话", () => {
  const { sessions } = setup();
  assert.throws(() => sessions.open(opening({ participants: ["architect", "architect"] })), /参与方|同一个|重复/);
  assert.throws(() => sessions.open(opening({ topic: "" })), /议题|主题|为空/);
  assert.throws(() => sessions.open(opening({ topic: "   " })), /议题|主题|为空/);
  assert.equal(sessions.list().length, 0, "校验失败不能留下一个没有开场白的空会话");
});

test("轮次推进：连续 advance 到 maxTurns 后拒绝继续", () => {
  const { sessions } = setup();
  const s = sessions.open(opening()); // 默认 6 轮，开场白是第 1 轮

  for (let turn = s.turn + 1; turn <= s.maxTurns; turn++) {
    const who = turn % 2 === 0 ? "architect" : "frontend";
    assert.equal(sessions.advance(s.id, who, `第 ${turn} 轮发言`).turn, turn);
  }
  assert.equal(sessions.get(s.id)!.turn, 6);

  const msgs = sessions.messages(s.id);
  assert.equal(msgs.length, 6, "每条发言一条消息");
  assert.equal(msgs.at(-1)!.turn, 6);

  assert.deepEqual(sessions.canContinue(s.id), { ok: false, reason: "max_turns" });

  // 触顶后不能再发言，也不能因此多出一条消息
  assert.throws(() => sessions.advance(s.id, "architect", "还想再说一句"));
  assert.equal(sessions.messages(s.id).length, 6);
});

test("轮次硬上限：传入更大的 maxTurns 也会被截到 12", () => {
  const { sessions } = setup();
  assert.equal(sessions.open(opening({ maxTurns: 99 })).maxTurns, 12);
  assert.equal(sessions.open(opening({ maxTurns: 3 })).maxTurns, 3, "上限以内按调用方给的来");
});

test("超时：deadline 已过则拒绝继续", () => {
  const { store, sessions } = setup();
  const s = sessions.open(opening({ deadlineMinutes: 30 }));
  assert.ok(Date.parse(s.deadline) - Date.now() > 29 * 60_000, "自定义时限生效");

  // 直接把截止时间改成过去，等价于「聊了半小时还没收敛」
  store.docPut("sessions", s.id, { ...sessions.get(s.id)!, deadline: new Date(Date.now() - 1000).toISOString() });
  assert.deepEqual(sessions.canContinue(s.id), { ok: false, reason: "deadline" });
  assert.throws(() => sessions.advance(s.id, "frontend", "再补充一点"));
});

test("预算：tokensUsed 触到 tokenBudget 后拒绝继续", () => {
  const { sessions } = setup();
  const s = sessions.open(opening({ tokenBudget: 1000 }));

  sessions.addUsage(s.id, 600);
  assert.equal(sessions.get(s.id)!.tokensUsed, 600);
  assert.deepEqual(sessions.canContinue(s.id), { ok: true });

  sessions.addUsage(s.id, 600);
  assert.equal(sessions.get(s.id)!.tokensUsed, 1200);
  assert.deepEqual(sessions.canContinue(s.id), { ok: false, reason: "budget" });

  // 用量回填出错（负数）不能把预算倒着算回去
  sessions.addUsage(s.id, -500);
  assert.equal(sessions.get(s.id)!.tokensUsed, 1200);

  // 边界：恰好用光预算也算触顶（不是要「超过」才拦）
  const exact = sessions.open(opening({ tokenBudget: 100 }));
  sessions.addUsage(exact.id, 100);
  assert.deepEqual(sessions.canContinue(exact.id), { ok: false, reason: "budget" });
});

test("结束：close 带结论时收敛为 closed，且结论原样保存", () => {
  const { sessions } = setup();
  const s = sessions.open(opening());
  const conclusion = "接口按资源划分，前端只依赖契约，先冻结 v1。";

  const closed = sessions.close(s.id, conclusion, "conclusion");
  assert.equal(closed.status, "closed");
  assert.equal(closed.endReason, "conclusion");
  assert.equal(closed.conclusion, conclusion);
  assert.deepEqual(sessions.get(s.id), closed);

  assert.deepEqual(
    sessions.list({ status: "closed" }).map((x) => x.id),
    [s.id],
  );
});

test("中止也要有结论：close(null, 各种上限) 自动补一条总结", () => {
  const { sessions } = setup();

  // 最典型的中止场景：轮次用完
  const s = sessions.open(opening({ maxTurns: 3 }));
  sessions.advance(s.id, "frontend", "补充第一点");
  const aborted = sessions.close(s.id, null, "max_turns");
  assert.equal(aborted.status, "aborted");
  assert.equal(aborted.endReason, "max_turns");
  assert.notEqual(aborted.conclusion, null);
  assert.ok(aborted.conclusion!.length > 0, "兜底结论不能是空串");
  assert.match(aborted.conclusion!, /轮|上限|时限|预算/, "兜底结论要说明停在哪一步");

  // 其余中止原因同样不能留下空结论
  for (const reason of ["deadline", "budget", "human"] as const) {
    const x = sessions.open(opening());
    const r = sessions.close(x.id, null, reason);
    assert.equal(r.status, "aborted");
    assert.equal(r.endReason, reason);
    assert.ok(r.conclusion && r.conclusion.length > 0);
  }
});

test("已结束的会话不能再发言：advance 抛错且不写入消息", () => {
  const { sessions } = setup();
  const s = sessions.open(opening());
  sessions.close(s.id, "已达共识。", "conclusion");

  const before = sessions.messages(s.id).length;
  assert.throws(() => sessions.advance(s.id, "frontend", "结束之后还想补一句"));
  assert.equal(sessions.messages(s.id).length, before, "被拒绝的发言不能留在记录里");
  assert.equal(sessions.get(s.id)!.turn, 1, "轮次也不能被推进");
});

test("串行锁：同一会话同一时刻只允许一个执行者", () => {
  const { sessions } = setup();
  const s = sessions.open(opening());

  assert.equal(sessions.isLocked(s.id), false);
  assert.equal(sessions.lock(s.id), true);
  assert.equal(sessions.isLocked(s.id), true);
  assert.equal(sessions.lock(s.id), false, "第二次拿锁必须失败");

  sessions.unlock(s.id);
  assert.equal(sessions.isLocked(s.id), false);
  assert.equal(sessions.lock(s.id), true, "释放后可以重新拿锁");
  sessions.unlock(s.id);

  // 锁按会话隔离，一个会话被占用不影响另一个
  const other = sessions.open(opening({ topic: "另一个议题" }));
  assert.equal(sessions.lock(other.id), true);
  assert.equal(sessions.isLocked(s.id), false);
});

test("list 支持按状态、项目、工作项过滤", () => {
  const { sessions } = setup();
  const a = sessions.open(opening({ projectId: "p1", issueId: 7 }));
  const b = sessions.open(opening({ topic: "另一个议题", projectId: "p2" }));
  sessions.close(a.id, "有结论", "conclusion");

  const ids = (list: { id: string }[]) => list.map((x) => x.id).sort();
  assert.deepEqual(ids(sessions.list({ projectId: "p1" })), [a.id]);
  assert.deepEqual(ids(sessions.list({ issueId: 7 })), [a.id]);
  assert.deepEqual(ids(sessions.list({ status: "open" })), [b.id]);
  assert.deepEqual(ids(sessions.list({ status: "closed" })), [a.id]);
  assert.equal(sessions.list().length, 2, "不带过滤返回全部");
});
