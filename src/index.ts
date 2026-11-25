import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { Store } from "./db.ts";
import { Runtime, anthropicLLM, type LLM } from "./runtime.ts";
import { makeLLM } from "./llm.ts";
import { setPriceResolver } from "./pricing.ts";
import { createApp } from "./server.ts";
import { AgentSchema, McpServerSchema, ToolSchema } from "./types.ts";
import { Settings } from "./settings.ts";
import { Notifier } from "./notify.ts";
import { GitHub } from "./github.ts";
import { Linear } from "./linear.ts";
import { Workspace } from "./workspace.ts";
import { Work } from "./work.ts";
import { QA, detectDevEye } from "./qa.ts";
import { CliRunner } from "./cli.ts";
import { Assistant } from "./assistant.ts";
import { Automation } from "./automation.ts";
import { simulatedLLM } from "./simulate.ts";
import { buildApi } from "./api.ts";
import { detectRuntimes, resetRuntimeCaches } from "./runtimes.ts";
import { restartSpec, spawnReplacement } from "./restart.ts";
import { Uploads } from "./uploads.ts";
import type { Security } from "./auth.ts";
import { Credentials } from "./credentials.ts";
import { importSeed, seedDemo } from "./seed.ts";
import { registerToolbox } from "./toolbox.ts";
import { Sessions } from "./session.ts";
import { registerSessionTools } from "./session-tools.ts";

const env = (k: string, d: string) => process.env[k] ?? d;
const simulate = process.env.HUB_SIMULATE === "1";
const dataDir = env("HUB_DATA", "./data");
mkdirSync(dataDir, { recursive: true });
const port = Number(env("PORT", "18790"));
const hostname = env("HOST", "127.0.0.1");

const store = new Store(env("HUB_DB", join(dataDir, "agent-hub.db")));
const interrupted = store.failInterrupted();
if (interrupted) console.warn(`标记了 ${interrupted} 个因重启中断的任务为 failed`);

// 从种子文件导入智能体、工具和 MCP 服务器：首次启动全部导入；之后只补种子里新增的角色（删掉的不会回来）
const seed = env("HUB_SEED", "./agents.seed.json");
if (existsSync(seed)) {
  const raw = JSON.parse(readFileSync(seed, "utf8"));
  const data = Array.isArray(raw) ? { agents: raw } : raw;
  const added = importSeed(store, data);
  if (added.length) console.log(`从 ${seed} 导入了 ${added.length} 个智能体：${added.join("、")}`);
}

const settings = new Settings(store);
const notifier = new Notifier(store, () => settings.get().notify);
const github = new GitHub(settings.githubToken);
const linear = new Linear(settings.linearToken);
const workspace = new Workspace(join(dataDir, "workspaces"), settings.githubToken);

// 模型调用：演示模式用脚本化模型；否则按模型条目找到所属连接（Anthropic 或 OpenAI 兼容）并路由
const sim = simulatedLLM();
const router = makeLLM(settings);
// 自定义模型按设置里填的价格估算花费；没填的沿用内置价格表
setPriceResolver((id) => { const m = settings.modelEntry(id); return m?.inputPrice != null && m?.outputPrice != null ? [m.inputPrice, m.outputPrice] : null; });
const llm: LLM = {
  create: (params, opts) => (simulate ? sim.create(params, opts) : router.create(params, opts)),
};
const runtime = new Runtime(store, llm, {
  maxConcurrency: settings.get().concurrency.model,
  maxDepth: Number(env("HUB_MAX_DEPTH", "4")),
  maxHops: Number(env("HUB_MAX_HOPS", "3")),
});
runtime.forceBuiltin = simulate;

const work = new Work(store, runtime, { notify: notifier, settings, github, linear, workspace, simulate });
const qa = new QA(store, runtime, settings, (id) => work.proj(id), simulate);
work.qa = qa;
void detectDevEye().then((ok) => { qa.deveye = ok; });
runtime.cli = new CliRunner(settings, {
  store,
  tmpDir: join(dataDir, "tmp"),
  hubUrl: () => `http://127.0.0.1:${port}`,
  cwdFor: (task) => {
    if (task.issueId == null) return null;
    const v = work.list().find((i) => i.id === task.issueId);
    const p = v && work.proj(v.projectId);
    return v && p && workspace.enabledFor(p, store.getAgent(task.agent)) ? workspace.dir(p, v.key) : null;
  },
});
// 可选的文件 / 命令 / 知识检索工具：按智能体的 builtinTools 逐个开启
registerToolbox(runtime, { work, workspace, store, settings });
// 智能体会话：两个智能体围绕一个议题多轮往返，收敛出一条结论。
// driver 用 callAgent 起独立任务，不挂在发起方任务树下，避免嵌套过深。
const sessions = new Sessions(store);
registerSessionTools(runtime, sessions, async (agent, input, o) => {
  const r = await runtime.callAgent(agent, input, { timeoutMs: o?.timeoutMs, priority: 2 });
  if (r.error) throw new Error(`智能体 ${agent} 调用失败：${r.error}`);
  const task = store.getTask(r.taskId);
  const tokens = task ? task.inputTokens + task.outputTokens : 0;
  return { text: r.result ?? "", tokens };
});
const assistant = new Assistant(store, runtime, work, settings, () => llm, simulate);
const automation = new Automation(store, runtime, work, qa, assistant, { sentinelMs: simulate ? 8000 : 60_000, leadMs: simulate ? 12_000 : 300_000 });

// 演示模式铺一套示例数据；正式模式下不自动建项目，由用户在界面上创建第一个项目
if (simulate && work.projectsRaw().length === 0) await seedDemo(work, settings, store);

runtime.events.on("event", (e) => {
  if (e.type === "task" && ["completed", "failed", "cancelled"].includes(e.task.status))
    console.log(`[task] ${e.task.agent} ${e.task.id.slice(0, 8)} ${e.task.status}${e.task.error ? " - " + e.task.error : ""}`);
});

/** 热重载：清空运行底座缓存、重新检测 CLI、补种新增角色。设置在每次使用时读取，无需额外动作 */
const reload = async () => {
  resetRuntimeCaches();
  const data = await detectRuntimes(true);
  if (existsSync(seed)) {
    try { importSeed(store, JSON.parse(readFileSync(seed, "utf8"))); } catch { /* 种子文件损坏不影响服务 */ }
  }
  return { runtimes: data.runtimes.filter((r) => r.installed).map((r) => `${r.name} ${r.version ?? ""}`.trim()), agents: store.listAgents().length };
};

/** 进程级重启：先回复请求，再拉起新进程并退出（新进程会重试绑定端口） */
const restart = () => {
  const spec = restartSpec();
  console.log(`[系统] 正在重启：${spec.command} ${spec.args.join(" ")}`);
  setTimeout(() => {
    try { spawnReplacement(spec); } catch (e) { console.error("[系统] 拉起新进程失败", e); return; }
    void runtime.mcp.closeAll().finally(() => process.exit(0));
  }, 150);
  return "正在重启";
};

const uploads = new Uploads(store, join(dataDir, "uploads"));
assistant.uploads = uploads;
const api = buildApi({ store, runtime, settings, notifier, work, qa, automation, assistant, simulate, reload, restart, uploads });
// 访问控制：账号登录（HUB_USER / HUB_PASSWORD，未设置密码时用 HUB_TOKEN 作密码）；HUB_TOKEN 同时留给 API / MCP 用。
// 用户首次登录后自己设置账号密码，写到 data/auth.json 并优先于环境变量（删掉该文件即退回初始密码）。
const credentials = new Credentials(join(dataDir, "auth.json"));
const security: Security = {
  user: process.env.HUB_USER || "admin",
  password: process.env.HUB_PASSWORD || process.env.HUB_TOKEN || "",
  token: process.env.HUB_TOKEN,
  credentials,
};
if (!["127.0.0.1", "localhost", "::1"].includes(hostname) && !security.password && !security.token && !credentials.initialized)
  console.warn("警告：服务监听在非本机地址且未设置登录密码或 HUB_TOKEN，任何人都能访问并让智能体执行命令。请设置 HUB_PASSWORD（或 HUB_TOKEN）。");
const fetch = createApp(store, runtime, security, { ...api, uploads }).fetch;
/** 监听端口；作为重启拉起的新进程时旧进程可能还没释放端口，重试若干次 */
function listen(attempt = 1) {
  const server = serve({ fetch, port, hostname }, () =>
    console.log(`agent-hub listening on http://${hostname}:${port}${simulate ? "（演示模式：模型回复为脚本生成）" : ""}`),
  );
  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE" && process.env.HUB_RESTART === "1" && attempt < 40) {
      try { server.close(); } catch { /* 已关闭 */ }
      setTimeout(() => listen(attempt + 1), 250);
      return;
    }
    console.error(`无法监听 ${hostname}:${port}：${err.message}`);
    process.exit(1);
  });
}
listen();

for (const sig of ["SIGINT", "SIGTERM"] as const)
  process.on(sig, () => void runtime.mcp.closeAll().finally(() => process.exit(0)));
