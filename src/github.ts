/** GitHub REST 客户端（Personal Access Token）。Token 只保存在服务端。 */
export interface GhIssue { number: number; title: string; body: string | null; state: string; state_reason?: string | null; labels: (string | { name: string })[]; pull_request?: unknown }

export class GitHub {
  private token: () => string | null;
  private base: string;
  constructor(token: () => string | null, base = "https://api.github.com") {
    this.token = token;
    this.base = base;
  }
  available() { return !!this.token(); }
  async req<T = any>(method: string, path: string, body?: unknown): Promise<T> {
    const t = this.token();
    if (!t) throw new Error("未配置 GitHub Token");
    const res = await fetch(this.base + path, {
      method,
      headers: { authorization: `Bearer ${t}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "agent-hub", ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`GitHub ${method} ${path} → ${res.status}: ${text.slice(0, 200)}`);
    return (text ? JSON.parse(text) : null) as T;
  }
  user() { return this.req<{ login: string }>("GET", "/user"); }
  async repos(): Promise<string[]> {
    const list = await this.req<{ full_name: string }[]>("GET", "/user/repos?per_page=100&sort=updated");
    return list.map((r) => r.full_name);
  }
  repo(full: string) { return this.req<{ default_branch: string; full_name: string }>("GET", `/repos/${full}`); }
  /** 分页读取 issue（不含 PR）。state=all 时用于拉回远端的关闭 / 重新打开；since 只取此后有更新的 */
  async listIssues(full: string, opts: { state?: "open" | "all"; since?: string | null; maxPages?: number } = {}): Promise<GhIssue[]> {
    const out: GhIssue[] = [];
    const q = `state=${opts.state ?? "open"}&per_page=100${opts.since ? `&since=${encodeURIComponent(opts.since)}` : ""}`;
    for (let page = 1; page <= (opts.maxPages ?? 20); page++) {
      const list = await this.req<GhIssue[]>("GET", `/repos/${full}/issues?${q}&page=${page}`);
      out.push(...list.filter((i) => !i.pull_request));
      if (list.length < 100) break;
    }
    return out;
  }
  createIssue(full: string, title: string, body: string, labels: string[] = []) { return this.req<GhIssue>("POST", `/repos/${full}/issues`, { title, body, labels }); }
  setIssueState(full: string, n: number, state: "open" | "closed", reason?: "completed" | "not_planned") { return this.req("PATCH", `/repos/${full}/issues/${n}`, { state, ...(state === "closed" && reason ? { state_reason: reason } : {}) }); }
  comment(full: string, n: number, body: string) { return this.req("POST", `/repos/${full}/issues/${n}/comments`, { body }); }
  createPR(full: string, o: { title: string; head: string; base: string; body: string }) { return this.req<{ number: number }>("POST", `/repos/${full}/pulls`, o); }
  mergePR(full: string, n: number) { return this.req("PUT", `/repos/${full}/pulls/${n}/merge`, { merge_method: "squash" }); }
  pr(full: string, n: number) { return this.req<{ merge_commit_sha: string | null; base: { ref: string } }>("GET", `/repos/${full}/pulls/${n}`); }
  async prFiles(full: string, n: number): Promise<string[]> {
    const files = await this.req<{ filename: string }[]>("GET", `/repos/${full}/pulls/${n}/files?per_page=100`);
    return files.map((f) => f.filename);
  }
}
