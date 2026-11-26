/**
 * 管家的通道选择：API → 本机 Claude Code → 规则回复。
 * Claude Code 用假的 spawner 代替：它按 CLI 的行为通过虚拟会话回调管家的工具，再返回 JSON 结果。
 */
import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { Store } from "../src/db.ts";
import { Runtime } from "../src/runtime.ts";
import { Settings } from "../src/settings.ts";
import { Notifier } from "../src/notify.ts";
import { GitHub } from "../src/github.ts";
import { Linear } from "../src/linear.ts";
import { Workspace } from "../src/workspace.ts";
import { Work } from "../src/work.ts";
import { Assistant } from "../src/assistant.ts";
import { CliChat, parseResult, transcriptPrompt, virtualSessions, type ChildLike, type ProcSpawner, type Spawner } from "../src/assistant-cli.ts";
import { createApp } from "../src/server.ts";
import { taskToken, TASK_TOKEN_HEADER } from "../src/auth.ts";
import { simulatedLLM } from "../src/simulate.ts";
import type { LLM } from "../src/runtime.ts";

const savedKey = process.env.ANTHROPIC_API_KEY;
beforeEach(() => { delete process.env.ANTHROPIC_API_KEY; });
after(() => { if (savedKey !== undefined) process.env.ANTHROPIC_API_KEY = savedKey; });

const runtimes: Runtime[] = [];
after(() => runtimes.forEach((r) => void r.mcp.closeAll()));

/** 记录每次启动 CLI 的参数；按脚本回调工具后返回结果 */
type Call = { bin: string; args: string[]; tools: string[] };
function fakeClaude(script: (invoke: (name: string, input: unknown) => Promise<string>) => Promise<string>, calls: Call[]): Spawner {
  return async (bin, args) => {
    const cfgIdx = args.indexOf("--mcp-config");
    let tools: string[] = [];
    let result: string;
    if (cfgIdx >= 0) {
      const cfg = JSON.parse(readFileSync(args[cfgIdx + 1], "utf8"));
      const id = cfg.mcpServers.hub.env.HUB_TASK_ID as string;
      const v = virtualSessions.get(id)!;
      tools = v.tools.map((t) => t.name);
      result = await script((n, i) => v.invoke(n, i));
    } else result = await script(async () => "（没有工具）");
    calls.push({ bin, args, tools });
    return { stdout: JSON.stringify({ type: "result", is_error: false, result, total_cost_usd: 0.01 }), stderr: "", code: 0 };
  };
}

/**
 * 假的长驻 Claude Code：每收到一条 stdin 消息，按脚本回调虚拟会话里的工具，再输出 result 事件。
 * 脚本抛错表示进程崩溃（退出码 1）。
 */
type Live = { args: string[]; inputs: string[]; ended: boolean };
function fakeLive(script: (text: string, invoke: (name: string, input: unknown) => Promise<string>) => Promise<string>, procs: Live[]): ProcSpawner {
  return (_bin, args) => {
    const rec: Live = { args, inputs: [], ended: false };
    procs.push(rec);
    const ee = new EventEmitter();
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const cfgIdx = args.indexOf("--mcp-config");
    const id = cfgIdx >= 0 ? JSON.parse(readFileSync(args[cfgIdx + 1], "utf8")).mcpServers.hub.env.HUB_TASK_ID as string : "";
    let closed = false;
    const close = (code: number | null) => { if (!closed) { closed = true; ee.emit("close", code); } };
    const child: ChildLike = {
      stdin: {
        write: (line: string) => {
          const text = JSON.parse(line).message.content as string;
          rec.inputs.push(text);
          void script(text, (n, i) => virtualSessions.get(id)!.invoke(n, i)).then(
            (out) => stdout.emit("data", `${JSON.stringify({ type: "system", subtype: "init" })}\n${JSON.stringify({ type: "result", is_error: false, result: out })}\n`),
            (e: Error) => { stderr.emit("data", e.message); close(1); },
          );
          return true;
        },
        end: () => { rec.ended = true; setImmediate(() => close(0)); return true; },
      },
      stdout, stderr,
      on: ((ev: string, fn: (...a: any[]) => void) => { ee.on(ev, fn); return child; }) as ChildLike["on"],
      kill: () => { close(null); return true; },
    };
    return child;
  };
}

function setup(opts: { cli?: boolean; llm?: LLM } = {}) {
  const store = new Store(":memory:");
  const settings = new Settings(store);
  const runtime = new Runtime(store, simulatedLLM({ delayMs: [1, 1] }), { maxConcurrency: 2, maxDepth: 2, maxHops: 2 });
  runtimes.push(runtime);
  const work = new Work(store, runtime, { notify: new Notifier(store, () => settings.get().notify), settings, github: new GitHub(() => null), linear: new Linear(() => null), workspace: new Workspace("/tmp/agent-hub-test-ws", () => null), simulate: false });
  work.saveProject({ name: "官网", key: "WEB" });
  const failing: LLM = { create: async () => { throw new Error("401 authentication_error: invalid x-api-key"); } };
  const assistant = new Assistant(store, runtime, work, settings, () => opts.llm ?? failing, false);
  const calls: Call[] = [];
  const cli = new CliChat({ bin: async () => (opts.cli === false ? null : "/usr/local/bin/claude"), hubUrl: () => "http://127.0.0.1:1", taskToken: (id) => `tok-${id}`, tmpDir: "/tmp/agent-hub-test-butler" });
  assistant.cli = cli;
  return { store, settings, assistant, cli, calls };
}

test("解析 claude -p 的 JSON 结果；未登录给出明确原因", () => {
  assert.deepEqual(parseResult('{"type":"result","is_error":false,"result":" 你好 ","total_cost_usd":0.02}', "", 0), { text: "你好", cost: 0.02 });
  assert.throws(() => parseResult('{"type":"result","is_error":true,"result":"Credit balance is too low"}', "", 1), /Claude Code 返回错误：Credit balance/);
  assert.throws(() => parseResult("", "Invalid API key · Please run /login", 1), /未登录或登录已失效/);
});

test("对话历史拼进 prompt", () => {
  assert.equal(transcriptPrompt([], "你好"), "你好");
  const p = transcriptPrompt([{ role: "me", text: "做个博客" }, { role: "ai", text: "要支持标签吗？" }], "要");
  assert.match(p, /【用户】做个博客\n\n【管家】要支持标签吗？/);
  assert.match(p, /【用户的新消息】\n要$/);
});

test("没有 API 连接也没有 Claude Code：退回规则回复，并说明原因", async () => {
  const { assistant } = setup({ cli: false });
  assert.equal((await assistant.engine()).kind, "none");
  const r = await assistant.butler("你好");
  assert.equal(r.fallback, true);
  assert.match(r.reason ?? "", /没有可用的模型连接/);
  assert.equal(assistant.conversation().length, 0, "规则回复由前端写入，这里不留半截消息");
});

test("没有 API 连接时走本机长驻 Claude Code：只开放管家工具，卡片照常生成，后续轮次复用进程", async () => {
  const { assistant, cli } = setup();
  assert.equal((await assistant.engine()).kind, "cli");
  const procs: Live[] = [];
  let turn = 0;
  cli.procSpawner = fakeLive(async (_text, invoke) => {
    turn++;
    if (turn === 1) {
      assert.match(await invoke("list_projects", {}), /"key": "WEB"/);
      await invoke("propose_plan", { project: "WEB", items: [{ title: "博客列表页", description: "验收：分页", assignee: "developer", priority: 2 }] });
      return "我拆成了 1 个工作项，请确认。";
    }
    return `第 ${turn} 轮`;
  }, procs);
  await assistant.butler("给官网加个博客");
  const args = procs[0].args;
  assert.equal(args[args.indexOf("--input-format") + 1], "stream-json", "长驻：从 stdin 连续读消息");
  assert.equal(args[args.indexOf("--tools") + 1], "", "关闭全部内置工具");
  assert.ok(args.includes("--strict-mcp-config"));
  assert.equal(args[args.indexOf("--allowedTools") + 1], "mcp__hub");
  assert.match(args[args.indexOf("--system-prompt") + 1], /你是 Agent Hub 的管家/);
  const conv = assistant.conversation();
  assert.equal(conv[1].via, "claude-code");
  assert.equal(conv[1].text, "我拆成了 1 个工作项，请确认。");
  assert.equal(conv[1].card?.items[0].title, "博客列表页");

  // 第二轮：同一个进程，只发新消息，不再重复整段历史
  await assistant.butler("优先级改成高");
  assert.equal(procs.length, 1, "没有重新起进程");
  assert.equal(procs[0].inputs[1], "优先级改成高");

  // 用户在卡片上点了创建：下一轮把状态变化告诉它
  assistant.updateCard(1, { created: true });
  await assistant.butler("好了吗");
  assert.match(procs[0].inputs[2], /（卡片状态更新）\n- 拆分计划（博客列表页）：已创建/);
  assert.match(procs[0].inputs[2], /好了吗$/);

  // 对话外新增的消息（如规则回复、晨报）也会补给它
  assistant.post("☀️ 晨报\n一切正常");
  await assistant.butler("收到");
  assert.match(procs[0].inputs[3], /（这期间对话里新增了以下内容）\n【管家】☀️ 晨报/);
  assert.equal(procs.length, 1);
});

test("清空对话后重开进程；进程崩溃后下一条消息自动重建", async () => {
  const { assistant, cli } = setup();
  const procs: Live[] = [];
  let crash = false;
  cli.procSpawner = fakeLive(async (text) => { if (crash) throw new Error("boom"); return `回：${text.slice(-4)}`; }, procs);
  await assistant.butler("第一条");
  await assistant.butler("第二条");
  assistant.clear();
  assert.equal(procs[0].ended, true, "清空时关闭旧进程");
  await assistant.butler("新话题");
  assert.equal(procs.length, 2);
  assert.equal(procs[1].inputs[0], "新话题", "清空后没有旧历史可铺");

  crash = true;
  await assistant.butler("会崩");
  assert.match(assistant.conversation().at(-1)!.text, /通过 Claude Code 回复失败：Claude Code 进程已退出（退出码 1）：boom/);
  crash = false;
  await assistant.butler("恢复了吗");
  assert.equal(procs.length, 3, "崩溃后重建");
  assert.match(procs[2].inputs[0], /【用户】新话题/, "新进程用数据库里的记录铺底");
  assert.match(procs[2].inputs[0], /【用户的新消息】\n恢复了吗$/);
  assert.equal(assistant.conversation().at(-1)!.text, "回：恢复了吗");
  assistant.closeLive();
});

test("预热：起好进程但不发消息；第一条消息直接复用", async () => {
  const { assistant, cli } = setup();
  const procs: Live[] = [];
  cli.procSpawner = fakeLive(async () => "你好", procs);
  assert.equal(await assistant.warm(), true);
  assert.equal(procs.length, 1);
  assert.equal(procs[0].inputs.length, 0, "预热不消耗额度");
  await assistant.warm();
  assert.equal(procs.length, 1, "重复预热不起新进程");
  await assistant.butler("你好");
  assert.equal(procs.length, 1);
  assert.equal(procs[0].inputs[0], "你好");
  assistant.closeLive();
});

test("同时发来的两条消息排队处理，不会交错", async () => {
  const { assistant, cli } = setup();
  const procs: Live[] = [];
  cli.procSpawner = fakeLive(async (text) => { await new Promise((r) => setTimeout(r, 20)); return `回：${text}`; }, procs);
  await Promise.all([assistant.butler("A"), assistant.butler("B")]);
  const texts = assistant.conversation().map((m) => m.text);
  assert.deepEqual(texts, ["A", "回：A", "B", "回：B"]);
  assistant.closeLive();
});

test("API 连接存在但鉴权失败：自动换到 Claude Code，而不是静默规则回复", async () => {
  const { store, settings, assistant, cli } = setup();
  const s = settings.get();
  const p = s.providers[0];
  Object.assign(p, { method: "key", verifiedAt: new Date().toISOString(), keyHint: "sk-…bad" });
  store.docPut("settings", "global", { id: "global", ...s });
  store.docPut("secrets", "global", { [`provider:${p.id}`]: "sk-bad" });
  assert.equal((await assistant.engine()).kind, "api");
  const procs: Live[] = [];
  cli.procSpawner = fakeLive(async () => "你好，我在。", procs);
  const r = await assistant.butler("你好");
  assert.equal(r.fallback, undefined);
  assert.equal(assistant.conversation().at(-1)?.via, "claude-code");
  assert.equal(procs.length, 1);
  assistant.closeLive();
});

test("API 可用时不启动 CLI", async () => {
  const ok: LLM = { create: async () => ({ content: [{ type: "text", text: "API 回复" }], stop_reason: "end_turn" }) as never };
  const { store, settings, assistant, cli, calls } = setup({ llm: ok });
  const s = settings.get();
  Object.assign(s.providers[0], { method: "key", verifiedAt: new Date().toISOString() });
  store.docPut("settings", "global", { id: "global", ...s });
  store.docPut("secrets", "global", { [`provider:${s.providers[0].id}`]: "sk-good" });
  cli.spawner = fakeClaude(async () => "不该走到这里", calls);
  await assistant.butler("你好");
  assert.equal(calls.length, 0);
  assert.equal(assistant.conversation().at(-1)?.via, "api");
  assert.equal(assistant.conversation().at(-1)?.text, "API 回复");
});

test("「让管家起草」项目也能走 Claude Code", async () => {
  const { assistant, cli, calls } = setup();
  cli.spawner = fakeClaude(async () => '好的：{"name":"博客系统","key":"BLOG","description":"支持 Markdown 的博客"}', calls);
  const d = await assistant.draftProject("做一个支持 Markdown 的博客");
  assert.deepEqual(d, { name: "博客系统", key: "BLOG", description: "支持 Markdown 的博客" });
  assert.equal(calls[0].args.includes("--mcp-config"), false, "起草不需要工具");
});

test("「用 AI 创建智能体」走 Claude Code：工具调用改草稿", async () => {
  const { assistant, cli, calls } = setup();
  cli.spawner = fakeClaude(async (invoke) => {
    await invoke("update_draft", { name: "doc-writer", description: "写文档" });
    return "已起草：doc-writer。";
  }, calls);
  const r = await assistant.builder({ mode: "create", draft: {}, history: [], text: "帮我建一个写文档的智能体" });
  assert.equal(r.reply, "已起草：doc-writer。");
  assert.equal(r.draft?.name, "doc-writer");
  assert.ok(r.changed?.includes("name"));
});

test("任务桥回调虚拟会话：需要本会话的令牌", async () => {
  const store = new Store(":memory:");
  const runtime = new Runtime(store, simulatedLLM({ delayMs: [1, 1] }), { maxConcurrency: 1, maxDepth: 1, maxHops: 1 });
  runtimes.push(runtime);
  const secret = "s3cret";
  const app = createApp(store, runtime, { user: "admin", password: "pw", internalSecret: secret });
  virtualSessions.set("butler-t1", { tools: [{ name: "list_projects", description: "列出项目", input_schema: { type: "object" } }], invoke: async (n) => `called ${n}` });
  try {
    const h = { [TASK_TOKEN_HEADER]: taskToken("butler-t1", secret) };
    assert.equal((await app.request("/internal/tasks/butler-t1/tools")).status, 401);
    assert.deepEqual(await (await app.request("/internal/tasks/butler-t1/tools", { headers: h })).json(), [{ name: "list_projects", description: "列出项目", input_schema: { type: "object" } }]);
    const r = await app.request("/internal/tasks/butler-t1/tool", { method: "POST", headers: { ...h, "content-type": "application/json" }, body: JSON.stringify({ name: "list_projects", input: {} }) });
    assert.deepEqual(await r.json(), { content: "called list_projects" });
  } finally { virtualSessions.delete("butler-t1"); }
});

test("拆分计划里的依赖：只保留指向前面项的序号", async () => {
  const { assistant, cli } = setup();
  const procs: Live[] = [];
  cli.procSpawner = fakeLive(async (_t, invoke) => {
    await invoke("propose_plan", { project: "WEB", items: [
      { title: "骨架", description: "d", depends_on: [2] },
      { title: "数据模型", description: "d", depends_on: [1, 1] },
      { title: "接口", description: "d", depends_on: [1, 2, 3, 9, 0] },
    ] });
    return "计划如下";
  }, procs);
  await assistant.butler("拆一下");
  const items = assistant.conversation().at(-1)!.card!.items;
  assert.deepEqual(items.map((x: { dependsOn: number[] }) => x.dependsOn), [[], [1], [1, 2]]);
  assistant.closeLive();
});

test("处理进度：工具调用与中途说的话实时可见，处理完清空", async () => {
  const { assistant, cli } = setup();
  const seen: string[][] = [];
  // 自制的假进程：先输出一条「边说边调工具」的 assistant 事件，再回调工具，最后给 result
  cli.procSpawner = (_bin, args) => {
    const ee = new EventEmitter(), stdout = new EventEmitter();
    const id = JSON.parse(readFileSync(args[args.indexOf("--mcp-config") + 1], "utf8")).mcpServers.hub.env.HUB_TASK_ID as string;
    const child: ChildLike = {
      stdin: {
        write: () => {
          void (async () => {
            stdout.emit("data", JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "我先看看现有项目。" }, { type: "tool_use", id: "t1", name: "mcp__hub__list_projects", input: {} }] } }) + "\n");
            await new Promise((r) => setTimeout(r, 5));
            await virtualSessions.get(id)!.invoke("list_projects", {});
            seen.push([...(assistant.progress?.steps ?? [])]);
            stdout.emit("data", JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "只有一个项目。" }] } }) + "\n");
            stdout.emit("data", JSON.stringify({ type: "result", is_error: false, result: "只有一个项目。" }) + "\n");
          })();
          return true;
        },
        end: () => { setImmediate(() => ee.emit("close", 0)); return true; },
      },
      stdout,
      on: ((ev: string, fn: (...a: any[]) => void) => { ee.on(ev, fn); return child; }) as ChildLike["on"],
      kill: () => { ee.emit("close", null); return true; },
    };
    return child;
  };
  await assistant.butler("有哪些项目");
  assert.deepEqual(seen[0], ["💬 我先看看现有项目。", "🔧 查看项目"]);
  assert.equal(assistant.progress, null, "处理完清空");
  assert.equal(assistant.conversation().at(-1)?.text, "只有一个项目。", "最终回复不重复记成进度");
  assistant.closeLive();
});
