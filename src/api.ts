/**
 * 前端使用的数据快照与 RPC 方法表。
 * - GET /api/state：前端需要的全部数据（不含任何密钥）
 * - POST /api/rpc：{ method, args }，只开放下面白名单里的方法
 */
import type { Store } from "./db.ts";
import type { Runtime } from "./runtime.ts";
import type { Settings } from "./settings.ts";
import type { Notifier } from "./notify.ts";
import type { Work } from "./work.ts";
import type { QA } from "./qa.ts";
import type { Automation } from "./automation.ts";
import type { Assistant } from "./assistant.ts";
import { AgentSchema, BUILTIN_TOOL_META, McpServerSchema, ToolSchema } from "./types.ts";
import { detectRuntimes } from "./runtimes.ts";
import { PRESETS } from "./providers.ts";

import type { Uploads } from "./uploads.ts";
export interface Services {
  uploads?: Uploads;
  store: Store; runtime: Runtime; settings: Settings; notifier: Notifier; work: Work; qa: QA; automation: Automation; assistant: Assistant; simulate: boolean; /** 热重载：重新读配置并重新检测运行底座 */ reload?: () => Promise<unknown>; /** 进程级重启：拉起新进程后退出；idle = 等运行中的工作项结束再重启 */ restart?: (mode?: "now" | "idle") => unknown; cancelRestart?: () => unknown; restartState?: () => unknown }

/** 掩码占位：保存时遇到它表示"沿用原值" */
const MASK = "••••";

export function buildApi(s: Services) {
  const { store, settings, notifier, work, qa, automation, assistant } = s;
  const state = async () => ({
    simulate: s.simulate,
    projects: work.projects(),
    syncLogs: Object.fromEntries(work.projectsRaw().map((p) => [p.id, work.syncLogOf(p.id)])),
    issues: work.list(),
    agents: store.listAgents(),
    skills: settings.skills(),
    settings: settings.get(),
    qa: qa.state(),
    auto: automation.snapshot(),
    notifications: notifier.list(),
    knowledge: store.docList("knowledge"),
    costs: work.costs(),
    attention: work.attention(),
    health: work.health(),
    butler: assistant.conversation(),
    butlerProgress: assistant.progress,
    tools: store.listTools(),
    // MCP 的 env / headers 里常有令牌：只回传键名，值一律掩码
    mcpServers: store.listMcpServers().map((m) => ({
      ...m,
      env: m.transport === "stdio" ? Object.fromEntries(Object.keys(m.env ?? {}).map((k) => [k, MASK])) : {},
      headers: m.transport === "http" ? Object.fromEntries(Object.keys(m.headers ?? {}).map((k) => [k, MASK])) : {},
    })),
    runtimes: await detectRuntimes(),
    builtinTools: BUILTIN_TOOL_META,
    providerPresets: PRESETS,
    restartPending: s.restartState?.() ?? null,
    concurrency: { ...s.runtime.concurrency(), cli: (s.runtime.cli as { stats?: () => unknown } | null)?.stats?.() ?? {} },
  });

  const saveAgent = (a: Record<string, unknown>, orig?: string | null) => {
    const v = AgentSchema.parse(a);
    if (v.name !== orig && store.getAgent(v.name)) throw new Error(`已存在名为 ${v.name} 的智能体`);
    store.upsertAgent(v);
    if (orig && orig !== v.name) {
      store.deleteAgent(orig);
      for (const x of store.listAgents()) if (Array.isArray(x.delegation) && x.delegation.includes(orig)) store.upsertAgent({ ...x, delegation: x.delegation.map((n) => (n === orig ? v.name : n)) });
      for (const i of work.list().filter((i) => i.assignee === orig)) void work.update(i.key, { assignee: v.name });
    }
    return v;
  };
  const issueOfRun = (id: string) => { const r = qa.run(id); if (!r) throw new Error("验收不存在"); return work.view(work.find(r.issueKey)); };

  const methods: Record<string, (...args: any[]) => unknown> = {
    "work.detail": (ref) => work.detail(ref),
    "work.activity": (limit, pid) => work.activity(limit, pid),
    "work.create": (input) => work.create(input),
    "work.update": (ref, patch) => work.update(ref, patch),
    "work.comment": (ref, body) => work.comment(ref, body),
    "work.run": (ref) => work.run(ref),
    "work.stop": (ref) => work.stop(ref),
    "work.remove": (ref) => work.remove(ref),
    "work.confirmRequirement": (ref, answer) => work.confirmRequirement(ref, answer),
    "work.mergePR": (ref, force) => work.mergePR(ref, !!force),
    "work.rollback": (ref) => work.rollback(ref),
    "work.pushToGithub": (ref) => work.pushToGithub(ref),
    "work.saveProject": (input, orig) => work.saveProject(input, orig),
    "work.deleteProject": (id) => work.deleteProject(id),
    "work.connectRepo": (id, full) => work.connectRepo(id, full),
    "work.disconnectRepo": (id) => work.disconnectRepo(id),
    "work.githubOwners": () => work.githubOwners(),
    "work.createRepo": (id, input) => work.createRepo(id, input),
    "work.sync": (id) => work.sync(id),
    "work.connectLinear": (id, teamId) => work.connectLinear(id, teamId),
    "work.disconnectLinear": (id) => work.disconnectLinear(id),
    "work.syncLinear": (id) => work.syncLinear(id),
    "work.linearMembers": (id) => work.linearMembers(id),
    "work.diskUsage": () => work.diskUsage(),
    "work.cleanWorkspaces": () => work.cleanWorkspaces(),
    "work.receipt": (id) => store.docGet("receipts", id),
    "work.pushToLinear": (ref) => work.pushToLinear(ref),
    "work.setLead": (id, patch) => work.setLead(id, patch),
    "qa.enqueue": (key) => qa.enqueue(work.view(work.find(key)), "manual"),
    "qa.rerun": (id) => qa.enqueue(issueOfRun(id), "manual"),
    "qa.cancel": (id) => qa.cancel(id),
    "qa.setSettings": (p) => settings.patch({ qa: p }),
    "qa.setEnv": (pid, env) => { const p = work.proj(pid)!; return work.saveProject({ name: p.name, key: p.key, env }, pid); },
    "auto.run": (id) => automation.runJob(automation.job(id)!, true),
    "auto.saveJob": (j) => automation.saveJob(j),
    "auto.toggle": (id, on) => automation.toggle(id, on),
    "auto.remove": (id) => automation.remove(id),
    "auto.setRule": (k, p) => automation.setRule(k, p),
    "settings.patch": (p) => {
      settings.patch(p);
      s.runtime.setConcurrency(settings.get().concurrency.model);
      (s.runtime.cli as { pump?: () => void } | null)?.pump?.();
      // 调了预算：因熔断暂停的工作项立即重试（仍超限会继续等）
      if (p?.budget) void work.resumeBudgetHeld().catch(() => {});
    },
    "settings.verifyProvider": (id, f) => settings.verifyProvider(id, f),
    "settings.listProviderModels": (id) => settings.listProviderModels(id),
    "settings.setAssistantModel": (m) => settings.patch({ assistantModel: m ?? "" }),
    "assistant.draftProject": (brief) => assistant.draftProject(String(brief ?? "")),
    "assistant.draftSkill": (input) => assistant.draftSkill((input ?? {}) as { text?: string; url?: string }),
    "settings.removeProvider": (id) => settings.removeProvider(id),
    "settings.saveModel": (m) => settings.saveModel(m),
    "settings.removeModel": (id) => settings.removeModel(id),
    "settings.connectGithub": (token) => settings.connectGithub(token),
    "settings.refreshGithubRepos": () => settings.refreshGithubRepos(),
    "settings.disconnectGithub": () => settings.disconnectGithub(),
    "settings.connectLinear": (token) => settings.connectLinear(token),
    "settings.refreshLinearTeams": () => settings.refreshLinearTeams(),
    "settings.disconnectLinear": () => settings.disconnectLinear(),
    "settings.addSecret": (name, value, scope) => settings.addSecret(name, value, scope),
    "settings.removeSecret": (name) => settings.removeSecret(name),
    "settings.testChannel": async (id) => { const c = settings.get().notify.channels.find((x) => x.id === id); if (!c?.url) throw new Error("先填写地址"); await notifier.send(c, "【Agent Hub】测试消息：通知渠道配置成功"); },
    "runtimes.detect": () => detectRuntimes(true),
    "system.reload": () => s.reload?.(),
    "system.restart": (mode) => s.restart?.(mode === "idle" ? "idle" : "now"),
    "system.cancelRestart": () => s.cancelRestart?.(),
    "studio.saveAgent": (a, orig) => saveAgent(a, orig),
    "studio.deleteAgent": (n) => store.deleteAgent(n),
    /** 批量改运行底座：把用 from 的智能体都改成 to（CLI 模型留空，用该 CLI 的默认模型）。返回改了几个 */
    "studio.switchRuntime": (from, to) => {
      if (!["builtin", "claude-code", "codex", "gemini", "pi"].includes(String(to))) throw new Error(`未知的运行底座 ${to}`);
      const list = store.listAgents().filter((a) => (a.runtime ?? "builtin") === from);
      for (const a of list) store.upsertAgent(AgentSchema.parse({ ...a, runtime: to, cliModel: "" }));
      return list.length;
    },
    "studio.saveTool": (t) => store.upsertTool(ToolSchema.parse(t)),
    "studio.saveMcp": (raw) => {
      const parsed = McpServerSchema.parse(raw);
      // 界面回传的是掩码值：把这些键还原成已保存的真实值，避免编辑时把令牌覆盖成 ••••
      const prev = store.getMcpServer(parsed.name);
      const restore = (before: Record<string, string> | undefined, after: Record<string, string>) =>
        Object.fromEntries(Object.entries(after).map(([k, v]) => [k, v === MASK && before?.[k] ? before[k] : v]));
      if (parsed.transport === "stdio" && prev?.transport === "stdio") parsed.env = restore(prev.env, parsed.env);
      if (parsed.transport === "http" && prev?.transport === "http") parsed.headers = restore(prev.headers, parsed.headers);
      const saved = store.upsertMcpServer(parsed);
      void s.runtime.mcp.reset(parsed.name); // 改了配置就断开重连，下次使用时按新配置连
      return saved;
    },
    "studio.deleteMcp": (name) => {
      if (!store.deleteMcpServer(name)) throw new Error(`MCP 服务器 ${name} 不存在`);
      void s.runtime.mcp.reset(name);
      for (const a of store.listAgents().filter((x) => x.mcp.includes(name))) store.upsertAgent({ ...a, mcp: a.mcp.filter((x) => x !== name) });
      return { ok: true };
    },
    "studio.deleteTool": (n) => {
      if (!store.deleteTool(n)) throw new Error(`自定义工具 ${n} 不存在`);
      for (const a of store.listAgents().filter((x) => x.tools.includes(n))) store.upsertAgent({ ...a, tools: a.tools.filter((x) => x !== n) });
      return { ok: true };
    },
    "studio.saveSkill": (sk, orig) => settings.saveSkill(sk, orig),
    "studio.deleteSkill": (id) => { settings.deleteSkill(id); for (const a of store.listAgents().filter((a) => a.skills.includes(id))) store.upsertAgent({ ...a, skills: a.skills.filter((x) => x !== id) }); },
    "knowledge.add": (pid, kind, text) => settings.addKnowledge(pid, kind, text),
    "knowledge.toggle": (id, on) => settings.toggleKnowledge(id, on),
    "knowledge.remove": (id) => settings.removeKnowledge(id),
    "notify.readAll": () => notifier.readAll(),
    "assistant.butler": (text, attachments) => assistant.butler(text, attachments),
    "assistant.append": (m) => assistant.append(m),
    "assistant.updateCard": (i, p) => assistant.updateCard(i, p),
    "assistant.clear": () => assistant.clear(),
    "assistant.warm": () => assistant.warm(),
    "assistant.builder": (input) => assistant.builder(input),
  };
  const rpc = async (method: string, args: unknown[] = []) => {
    const fn = methods[method];
    if (!fn) throw new Error(`未知方法 ${method}`);
    const out = await fn(...args);
    s.runtime.events.emit("event", { type: "work", kind: "rpc" } as never);
    return out ?? { ok: true };
  };
  return { state, rpc };
}
