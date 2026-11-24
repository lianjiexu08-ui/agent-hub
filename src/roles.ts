/**
 * 研发角色路由：按工作项的标签和内容选择最合适的实现角色。
 * 角色不存在（被删除或改名）时依次回退，最后回退到 developer / 调用方给的兜底。
 */
import type { Store } from "./db.ts";

export const DEV_ROLES = ["frontend-dev", "backend-dev", "devops", "developer"] as const;

const RULES: { role: string; label: RegExp; text: RegExp }[] = [
  { role: "devops", label: /^(devops|ci|infra|deploy|部署|运维)$/i, text: /\bCI\b|流水线|部署|发布|docker|k8s|kubernetes|helm|监控|告警|infra|workflow|nginx|证书/i },
  { role: "frontend-dev", label: /^(frontend|fe|ui|前端|页面|样式)$/i, text: /前端|页面|首页|组件|样式|css|布局|导航|按钮|表单|移动端|响应式|react|vue|交互|看板|弹窗|抽屉|首屏|LCP/i },
  { role: "backend-dev", label: /^(backend|be|api|后端|接口|数据库)$/i, text: /后端|接口|\bAPI\b|数据库|迁移|SQL|服务端|队列|调度|重试|鉴权|权限|缓存|定时任务|webhook|同步|导入|导出|性能/i },
];

/** 选实现角色：先看标签，再看标题和描述；都没命中用 developer */
export function pickDevRole(store: Store, issue: { title: string; description?: string; labels?: string[] }, fallback: string | null = null): string | null {
  const exists = (n: string) => !!store.getAgent(n);
  const labels = issue.labels ?? [];
  for (const r of RULES) if (labels.some((l) => r.label.test(l)) && exists(r.role)) return r.role;
  const text = `${issue.title}\n${issue.description ?? ""}`;
  for (const r of RULES) if (r.text.test(text) && exists(r.role)) return r.role;
  if (exists("developer")) return "developer";
  const any = DEV_ROLES.find(exists);
  return any ?? fallback;
}

/** 哨兵改派：换一个能干同类活的其他开发角色 */
export function pickReassignTarget(store: Store, current: string, issue?: { title: string; description?: string; labels?: string[] }): string {
  const exists = (n: string) => n !== current && !!store.getAgent(n);
  const preferred = issue ? pickDevRole(store, issue) : null;
  if (preferred && exists(preferred)) return preferred;
  for (const n of ["developer", ...DEV_ROLES, "orchestrator"]) if (exists(n)) return n;
  return current;
}
