import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { Store } from "./db.ts";
import { Runtime, anthropicLLM, type LLM } from "./runtime.ts";
import { createApp } from "./server.ts";
import { AgentSchema, McpServerSchema, ToolSchema } from "./types.ts";
import { Settings } from "./settings.ts";
import { Notifier } from "./notify.ts";
import { GitHub } from "./github.ts";
import { Workspace } from "./workspace.ts";
import { Work } from "./work.ts";
import { QA, detectDevEye } from "./qa.ts";
import { CliRunner } from "./cli.ts";
import { Assistant } from "./assistant.ts";
import { Automation } from "./automation.ts";
import { simulatedLLM } from "./simulate.ts";
import { buildApi } from "./api.ts";
import { seedDemo, seedDefault } from "./seed.ts";

const env = (k: string, d: string) => process.env[k] ?? d;
const simulate = process.env.HUB_SIMULATE === "1";
const dataDir = env("HUB_DATA", "./data");
mkdirSync(dataDir, { recursive: true });
const port = Number(env("PORT", "18790"));
const hostname = env("HOST", "127.0.0.1");

const store = new Store(env("HUB_DB", join(dataDir, "agent-hub.db")));
const interrupted = store.failInterrupted();
if (interrupted) console.warn(`标记了 ${interrupted} 个因重启中断的任务为 failed`);

// 首次启动时从种子文件导入智能体、工具和 MCP 服务器
const seed = env("HUB_SEED", "./agents.seed.json");
if (store.listAgents().length === 0 && existsSync(seed)) {
  const raw = JSON.parse(readFileSync(seed, "utf8"));
  const data = Array.isArray(raw) ? { agents: raw } : raw;
  ToolSchema.array().parse(data.tools ?? []).forEach((t) => store.upsertTool(t));
  McpServerSchema.array().parse(data.mcpServers ?? []).forEach((s) => store.upsertMcpServer(s));
  AgentSchema.array().parse(data.agents ?? []).forEach((a) => store.upsertAgent(a));
  console.log(`从 ${seed} 导入了 ${data.agents?.length ?? 0} 个智能体`);
}

const settings = new Settings(store);
const notifier = new Notifier(store, () => settings.get().notify);
const github = new GitHub(settings.githubToken);
const workspace = new Workspace(join(dataDir, "workspaces"), settings.githubToken);

// 模型调用：演示模式用脚本化模型；否则每次按设置里的凭据创建客户端，并把模型条目 id 映射为实际模型 ID
const sim = simulatedLLM();
const llm: LLM = {
  create: (params, opts) => simulate ? sim.create(params, opts) : anthropicLLM(settings.anthropicClient()).create({ ...params, model: settings.modelId(params.model) }, opts),
};
const runtime = new Runtime(store, llm, {
  maxConcurrency: Number(env("HUB_MAX_CONCURRENCY", "4")),
  maxDepth: Number(env("HUB_MAX_DEPTH", "4")),
  maxHops: Number(env("HUB_MAX_HOPS", "3")),
});
runtime.forceBuiltin = simulate;

const work = new Work(store, runtime, { notify: notifier, settings, github, workspace, simulate });
const qa = new QA(store, runtime, settings, (id) => work.proj(id), simulate);
work.qa = qa;
void detectDevEye().then((ok) => { qa.deveye = ok; });
runtime.cli = new CliRunner(settings, {
  tmpDir: join(dataDir, "tmp"),
  hubUrl: () => `http://127.0.0.1:${port}`,
  cwdFor: (task) => {
    if (task.issueId == null) return null;
    const v = work.list().find((i) => i.id === task.issueId);
    const p = v && work.proj(v.projectId);
    return v && p && workspace.enabledFor(p, store.getAgent(task.agent)) ? workspace.dir(p, v.key) : null;
  },
});
const assistant = new Assistant(store, runtime, work, settings, () => llm, simulate);
const automation = new Automation(store, runtime, work, qa, assistant, { sentinelMs: simulate ? 8000 : 60_000, leadMs: simulate ? 12_000 : 300_000 });

if (work.projectsRaw().length === 0) {
  if (simulate) await seedDemo(work, settings, store);
  else seedDefault(work);
}

runtime.events.on("event", (e) => {
  if (e.type === "task" && ["completed", "failed", "cancelled"].includes(e.task.status))
    console.log(`[task] ${e.task.agent} ${e.task.id.slice(0, 8)} ${e.task.status}${e.task.error ? " - " + e.task.error : ""}`);
});

const api = buildApi({ store, runtime, settings, notifier, work, qa, automation, assistant, simulate });
if (!["127.0.0.1", "localhost", "::1"].includes(hostname) && !process.env.HUB_TOKEN)
  console.warn("警告：服务监听在非本机地址且未设置 HUB_TOKEN。智能体可以在服务器上执行命令，请务必设置 HUB_TOKEN 并通过 HTTPS 访问。");
serve({ fetch: createApp(store, runtime, process.env.HUB_TOKEN, api).fetch, port, hostname }, () =>
  console.log(`agent-hub listening on http://${hostname}:${port}${simulate ? "（演示模式：模型回复为脚本生成）" : ""}`),
);
for (const sig of ["SIGINT", "SIGTERM"] as const)
  process.on(sig, () => void runtime.mcp.closeAll().finally(() => process.exit(0)));
