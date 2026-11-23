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
import { AgentSchema } from "./types.ts";
import { detectRuntimes } from "./runtimes.ts";

export interface Services { store: Store; runtime: Runtime; settings: Settings; notifier: Notifier; work: Work; qa: QA; automation: Automation; assistant: Assistant; simulate: boolean }

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
    tools: store.listTools(),
    mcpServers: store.listMcpServers(),
    runtimes: await detectRuntimes(),
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
    "work.mergePR": (ref) => work.mergePR(ref),
    "work.rollback": (ref) => work.rollback(ref),
    "work.pushToGithub": (ref) => work.pushToGithub(ref),
    "work.saveProject": (input, orig) => work.saveProject(input, orig),
    "work.deleteProject": (id) => work.deleteProject(id),
    "work.connectRepo": (id, full) => work.connectRepo(id, full),
    "work.disconnectRepo": (id) => work.disconnectRepo(id),
    "work.sync": (id) => work.sync(id),
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
    "settings.patch": (p) => settings.patch(p),
    "settings.verifyProvider": (id, f) => settings.verifyProvider(id, f),
    "settings.removeProvider": (id) => settings.removeProvider(id),
    "settings.saveModel": (m) => settings.saveModel(m),
    "settings.removeModel": (id) => settings.removeModel(id),
    "settings.connectGithub": (token) => settings.connectGithub(token),
    "settings.refreshGithubRepos": () => settings.refreshGithubRepos(),
    "settings.disconnectGithub": () => settings.disconnectGithub(),
    "settings.addSecret": (name, value, scope) => settings.addSecret(name, value, scope),
    "settings.removeSecret": (name) => settings.removeSecret(name),
    "settings.testChannel": async (id) => { const c = settings.get().notify.channels.find((x) => x.id === id); if (!c?.url) throw new Error("先填写地址"); await notifier.send(c, "【Agent Hub】测试消息：通知渠道配置成功"); },
    "runtimes.detect": () => detectRuntimes(true),
    "studio.saveAgent": (a, orig) => saveAgent(a, orig),
    "studio.deleteAgent": (n) => store.deleteAgent(n),
    "studio.saveSkill": (sk, orig) => settings.saveSkill(sk, orig),
    "studio.deleteSkill": (id) => { settings.deleteSkill(id); for (const a of store.listAgents().filter((a) => a.skills.includes(id))) store.upsertAgent({ ...a, skills: a.skills.filter((x) => x !== id) }); },
    "knowledge.add": (pid, kind, text) => settings.addKnowledge(pid, kind, text),
    "knowledge.toggle": (id, on) => settings.toggleKnowledge(id, on),
    "knowledge.remove": (id) => settings.removeKnowledge(id),
    "notify.readAll": () => notifier.readAll(),
    "assistant.butler": (text) => assistant.butler(text),
    "assistant.append": (m) => assistant.append(m),
    "assistant.updateCard": (i, p) => assistant.updateCard(i, p),
    "assistant.clear": () => assistant.clear(),
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
