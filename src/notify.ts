/**
 * 通知：站内通知中心 + Webhook 推送（飞书 / 企业微信 / Slack / 通用 JSON）。
 * 只推送需要人参与或知情的事：需求待确认、等你验收、护栏拦截、Hotfix 上线、预算熔断。
 */
import type { Store } from "./db.ts";

export type NotifyKind = "confirm" | "review" | "guard" | "hotfix" | "budget";
export interface Channel { id: string; name: string; type: "inapp" | "feishu" | "wecom" | "slack" | "webhook"; url: string; on: boolean; builtin?: boolean }
export interface NotifyConfig { channels: Channel[]; events: Record<NotifyKind, boolean>; publicUrl: string }
export interface Notification { id: number; at: string; kind: NotifyKind; title: string; body: string; key: string | null; read: boolean; sent: string[]; errors?: string[] }

export const DEFAULT_NOTIFY: NotifyConfig = {
  channels: [
    { id: "inapp", name: "站内通知", type: "inapp", url: "", on: true, builtin: true },
    { id: "feishu", name: "飞书群机器人", type: "feishu", url: "", on: false },
    { id: "wecom", name: "企业微信机器人", type: "wecom", url: "", on: false },
    { id: "slack", name: "Slack", type: "slack", url: "", on: false },
    { id: "webhook", name: "通用 Webhook", type: "webhook", url: "", on: false },
  ],
  events: { confirm: true, review: true, guard: true, hotfix: true, budget: true },
  publicUrl: "",
};

export function payloadFor(type: Channel["type"], text: string) {
  if (type === "feishu") return { msg_type: "text", content: { text } };
  if (type === "wecom") return { msgtype: "text", text: { content: text } };
  if (type === "slack") return { text };
  return { text };
}

export class Notifier {
  private store: Store;
  private config: () => NotifyConfig;
  onPush: (n: Notification) => void = () => {};
  constructor(store: Store, config: () => NotifyConfig) {
    this.store = store;
    this.config = config;
  }
  list(): Notification[] {
    return this.store.docList<Notification>("notifications").sort((a, b) => b.id - a.id).slice(0, 100);
  }
  unread() { return this.list().filter((n) => !n.read).length; }
  readAll() {
    for (const n of this.store.docList<Notification>("notifications")) if (!n.read) this.store.docPut("notifications", n.id, { ...n, read: true });
  }
  push(kind: NotifyKind, title: string, body: string, key: string | null) {
    const cfg = this.config();
    if (!cfg.events[kind]) return;
    const recent = this.list().find((x) => x.kind === kind && x.key === key && Date.now() - new Date(x.at).getTime() < 90_000);
    if (recent && key) return;
    const targets = cfg.channels.filter((c) => c.on && (c.builtin || c.url));
    const n: Notification = { id: Date.now() * 1000 + Math.floor(Math.random() * 1000), at: new Date().toISOString(), kind, title, body, key, read: false, sent: targets.map((c) => c.name) };
    this.store.docPut("notifications", n.id, n);
    const old = this.store.docList<Notification>("notifications").sort((a, b) => b.id - a.id).slice(200);
    for (const o of old) this.store.docDelete("notifications", o.id);
    this.onPush(n);
    const link = cfg.publicUrl && key ? `\n${cfg.publicUrl.replace(/\/$/, "")}/#issue=${key}` : "";
    for (const c of targets.filter((c) => !c.builtin)) void this.send(c, `【Agent Hub】${title}\n${body}${link}`).catch((e) => this.store.docPut("notifications", n.id, { ...n, errors: [...(n.errors ?? []), `${c.name}：${e.message}`] }));
  }
  async send(c: Channel, text: string) {
    const res = await fetch(c.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payloadFor(c.type, text)), signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  }
}
