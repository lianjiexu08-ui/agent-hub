/** GitHub REST 客户端（Personal Access Token）。Token 只保存在服务端。 */
export interface GhIssue { number: number; title: string; body: string | null; state: string; state_reason?: string | null; labels: (string | { name: string })[]; pull_request?: unknown }

export interface CiStatus { state: "passing" | "failing" | "pending" | "none" | "unknown"; sha: string; failed: string[]; pending: string[]; checkedAt: string; /** state = unknown 时读不到的原因 */ error?: string; /** 结果来自哪个接口 */ source?: "checks" | "actions" }
/** 汇总 check runs：cancelled / timed_out / action_required 也算失败（需要人看） */
export function summarizeChecks(sha: string, runs: { name: string; status: string; conclusion: string | null }[]): CiStatus {
  const ok = new Set(["success", "neutral", "skipped"]);
  const failed = runs.filter((r) => r.status === "completed" && !ok.has(r.conclusion ?? "")).map((r) => r.name);
  const pending = runs.filter((r) => r.status !== "completed").map((r) => r.name);
  const state = !runs.length ? "none" : failed.length ? "failing" : pending.length ? "pending" : "passing";
  return { state, sha, failed, pending, checkedAt: new Date().toISOString() };
}

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

  /**
   * 当前令牌的身份与权限范围。
   * classic token 会在 x-oauth-scopes 头里返回实际勾选的 scope；
   * 细粒度令牌没有这个头（null），表示权限由"选中的仓库 + 仓库权限"决定。
   */
  async viewer(): Promise<{ login: string; scopes: string[] | null }> {
    const t = this.token();
    if (!t) throw new Error("未配置 GitHub Token");
    const res = await fetch(`${this.base}/user`, {
      headers: { authorization: `Bearer ${t}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "agent-hub" },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`GitHub GET /user → ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const body = (await res.json()) as { login: string };
    const header = res.headers.get("x-oauth-scopes");
    return { login: body.login, scopes: header == null ? null : header.split(",").map((x) => x.trim()).filter(Boolean) };
  }

  /**
   * 可见的仓库：个人、协作者、以及**所在组织的仓库**都会返回（取决于令牌授权）。
   * 分页取全，避免仓库多时后面的组织仓库被截断。
   */
  async repos(maxPages = 10): Promise<string[]> {
    const out: string[] = [];
    for (let page = 1; page <= maxPages; page++) {
      const list = await this.req<{ full_name: string }[]>("GET", `/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member&page=${page}`);
      out.push(...list.map((r) => r.full_name));
      if (list.length < 100) break;
    }
    return [...new Set(out)];
  }
  /** 令牌可见的组织（新建仓库时可选的归属） */
  async orgs(): Promise<string[]> {
    const list = await this.req<{ login: string }[]>("GET", "/user/orgs?per_page=100");
    return list.map((o) => o.login);
  }
  /**
   * 新建仓库。auto_init 会生成带 README 的初始提交：Hub 给工作项开分支要基于默认分支，
   * 完全空的仓库没有默认分支，第一次运行就会失败。
   */
  createRepo(input: { org?: string | null; name: string; private: boolean; description?: string }) {
    const body = { name: input.name, private: input.private, description: input.description ?? "", auto_init: true };
    return this.req<{ full_name: string; default_branch: string }>("POST", input.org ? `/orgs/${encodeURIComponent(input.org)}/repos` : "/user/repos", body);
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
  /** 给 issue 打标签（不存在的标签会自动创建） */
  addLabels(full: string, n: number, labels: string[]) { return this.req("POST", `/repos/${full}/issues/${n}/labels`, { labels }); }
  /** 移除标签；标签本来就不存在时 GitHub 返回 404，调用方忽略即可 */
  removeLabel(full: string, n: number, label: string) { return this.req("DELETE", `/repos/${full}/issues/${n}/labels/${encodeURIComponent(label)}`); }
  createPR(full: string, o: { title: string; head: string; base: string; body: string }) { return this.req<{ number: number }>("POST", `/repos/${full}/pulls`, o); }
  mergePR(full: string, n: number) { return this.req("PUT", `/repos/${full}/pulls/${n}/merge`, { merge_method: "squash" }); }
  pr(full: string, n: number) { return this.req<{ merge_commit_sha: string | null; base: { ref: string }; head: { sha: string } }>("GET", `/repos/${full}/pulls/${n}`); }
  /**
   * PR 最新提交的 CI 结果（GitHub Actions 等 check runs）。
   * 任何一个失败 → failing；还有没跑完的 → pending；全部成功 / 跳过 → passing；没有配置 CI → none。
   */
  async ciStatus(full: string, n: number): Promise<CiStatus> {
    const { head } = await this.pr(full, n);
    try {
      const d = await this.req<{ check_runs: { name: string; status: string; conclusion: string | null }[] }>("GET", `/repos/${full}/commits/${head.sha}/check-runs?per_page=100`);
      return { ...summarizeChecks(head.sha, d.check_runs), source: "checks" };
    } catch (e) {
      // 细粒度令牌读不了 check runs（403 Resource not accessible）：改读 GitHub Actions 的运行与 job（需要 Actions: Read）
      if (!/→ (403|404)/.test((e as Error).message)) throw e;
    }
    const runs = await this.req<{ workflow_runs: { id: number; name: string; run_attempt?: number; created_at: string }[] }>("GET", `/repos/${full}/actions/runs?head_sha=${head.sha}&per_page=50`);
    // 同一个工作流可能被重跑：每个工作流只看最新的一次
    const latest = new Map<string, { id: number; created_at: string }>();
    for (const r of runs.workflow_runs) { const cur = latest.get(r.name); if (!cur || r.created_at > cur.created_at) latest.set(r.name, r); }
    const jobs: { name: string; status: string; conclusion: string | null }[] = [];
    for (const r of latest.values()) {
      const d = await this.req<{ jobs: { name: string; status: string; conclusion: string | null }[] }>("GET", `/repos/${full}/actions/runs/${r.id}/jobs?per_page=100`);
      jobs.push(...d.jobs);
    }
    return { ...summarizeChecks(head.sha, jobs), source: "actions" };
  }
  async prFiles(full: string, n: number): Promise<string[]> {
    const files = await this.req<{ filename: string }[]>("GET", `/repos/${full}/pulls/${n}/files?per_page=100`);
    return files.map((f) => f.filename);
  }
}
