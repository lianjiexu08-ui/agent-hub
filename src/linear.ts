/**
 * Linear GraphQL 客户端（Personal API Key）。
 * 只暴露同步需要的少量操作：团队成员、工作流状态、issue 的读取/创建/更新、评论。
 * Token 只保存在服务端，接口只返回掩码。
 */
export interface LinearViewer {
  id: string;
  name: string;
  email: string;
}
export interface LinearTeam {
  id: string;
  key: string;
  name: string;
}
export interface LinearState {
  id: string;
  name: string;
  /** triage / backlog / unstarted / started / completed / canceled */
  type: string;
  position: number;
}
/** Linear 上的真人。只在导入方向使用：Hub 的负责人是智能体，两者不是一回事 */
export interface LinearUser {
  id: string;
  name: string;
}
export interface LinearIssue {
  id: string;
  identifier: string;
  title: string;
  description: string;
  priority: number;
  url: string;
  updatedAt: string;
  state: LinearState;
  labels: string[];
  /** 创建人。Linear 侧只读字段，只能导入不能回推 */
  creator?: LinearUser | null;
  /** 指派人。可能为 null（大量历史单没有指派人），为 null 不代表「该清空」 */
  assignee?: LinearUser | null;
}
export interface LinearIssueRef {
  id: string;
  identifier: string;
  url: string;
  state: LinearState;
}

/** 工作项状态 → Linear 工作流状态类型 */
export function stateTypeForStatus(status: string): string {
  switch (status) {
    case "backlog": return "backlog";
    case "todo": return "unstarted";
    case "in_progress":
    case "in_review": return "started";
    case "done": return "completed";
    case "canceled": return "canceled";
    default: return "unstarted";
  }
}

/** Linear 状态类型 → 远端改动后工作项应处的状态；started 不强行改本地（执行由 Hub 驱动） */
export function statusForStateType(type: string): "backlog" | "todo" | "done" | "canceled" | null {
  switch (type) {
    case "triage":
    case "backlog": return "backlog";
    case "unstarted": return "todo";
    case "completed": return "done";
    case "canceled": return "canceled";
    default: return null;
  }
}

/** 在团队的工作流状态里挑一个最贴近工作项状态的；找不到时按相邻类型回退 */
export function pickState(states: LinearState[], status: string): LinearState | undefined {
  const want = stateTypeForStatus(status);
  const byPosition = (a: LinearState, b: LinearState) => a.position - b.position;
  const pool = states.filter((s) => s.type === want).sort(byPosition);
  if (pool.length) {
    // 待审核优先用名字里带 review/审核 的状态
    return status === "in_review" ? pool.find((s) => /review|审核/i.test(s.name)) ?? pool[0] : pool[0];
  }
  const fallback: Record<string, string[]> = {
    backlog: ["triage", "unstarted"],
    unstarted: ["backlog", "triage", "started"],
    started: ["unstarted", "backlog"],
    completed: ["started"],
    canceled: ["completed", "started"],
  };
  for (const type of fallback[want] ?? []) {
    const hit = states.find((s) => s.type === type);
    if (hit) return hit;
  }
  return states.slice().sort(byPosition)[0];
}

export class Linear {
  private token: () => string | null;
  private endpoint: string;
  constructor(token: () => string | null, endpoint = "https://api.linear.app/graphql") {
    this.token = token;
    this.endpoint = endpoint;
  }
  available() { return !!this.token(); }

  private async gql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const token = this.token();
    if (!token) throw new Error("未配置 Linear API Key");
    const res = await fetch(this.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: token },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    let json: { data?: T; errors?: { message: string }[] };
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`Linear 返回非 JSON（HTTP ${res.status}）：${text.slice(0, 200)}`);
    }
    if (!res.ok || json.errors?.length) {
      throw new Error(`Linear API 错误：${json.errors?.map((e) => e.message).join("；") || `HTTP ${res.status}`}`);
    }
    return json.data as T;
  }

  async viewer(): Promise<LinearViewer> {
    const d = await this.gql<{ viewer: LinearViewer }>(`query Viewer { viewer { id name email } }`);
    return d.viewer;
  }

  async teams(): Promise<LinearTeam[]> {
    const d = await this.gql<{ teams: { nodes: LinearTeam[] } }>(
      `query Teams { teams(first: 100) { nodes { id key name } } }`,
    );
    return d.teams.nodes;
  }

  async states(teamId: string): Promise<LinearState[]> {
    const d = await this.gql<{ team: { states: { nodes: LinearState[] } } | null }>(
      `query TeamStates($id: String!) { team(id: $id) { states(first: 100) { nodes { id name type position } } } }`,
      { id: teamId },
    );
    if (!d.team) throw new Error("Linear 团队不存在或无权访问");
    return d.team.states.nodes;
  }

  /** 团队成员（供「只做指定人的 issue」选择） */
  async members(teamId: string): Promise<LinearUser[]> {
    const d = await this.gql<{ team: { members: { nodes: LinearUser[] } } | null }>(
      `query TeamMembers($id: String!) { team(id: $id) { members(first: 250) { nodes { id name } } } }`,
      { id: teamId },
    );
    if (!d.team) throw new Error("Linear 团队不存在或无权访问");
    return d.team.members.nodes.map((m) => ({ id: m.id, name: m.name }));
  }

  /** 团队的 issue，分页读取（是否导入由调用方按状态/标签过滤）；maxPages × 100 为上限 */
  async issues(teamId: string, opts: { updatedAfter?: string | null; maxPages?: number } = {}): Promise<LinearIssue[]> {
    const maxPages = opts.maxPages ?? 20;
    const filter = opts.updatedAfter ? { updatedAt: { gt: opts.updatedAfter } } : null;
    type Node = Omit<LinearIssue, "labels"> & { labels: { nodes: { name: string }[] } };
    const out: LinearIssue[] = [];
    let after: string | null = null;
    for (let page = 0; page < maxPages; page++) {
      const d: { team: { issues: { nodes: Node[]; pageInfo?: { hasNextPage: boolean; endCursor: string | null } } } | null } = await this.gql(
        `query TeamIssues($id: String!, $after: String, $filter: IssueFilter) {
          team(id: $id) {
            issues(first: 100, after: $after, filter: $filter) {
              nodes { id identifier title description priority url updatedAt state { id name type position } creator { id name } assignee { id name } labels { nodes { name } } }
              pageInfo { hasNextPage endCursor }
            }
          }
        }`,
        { id: teamId, after, filter },
      );
      if (!d.team) throw new Error("Linear 团队不存在或无权访问");
      out.push(...d.team.issues.nodes.map((x) => ({ ...x, labels: x.labels.nodes.map((l) => l.name) })));
      const info = d.team.issues.pageInfo;
      if (!info?.hasNextPage || !info.endCursor) break;
      after = info.endCursor;
    }
    return out;
  }

  async createIssue(input: { teamId: string; title: string; description?: string; priority?: number; stateId?: string }): Promise<LinearIssueRef> {
    const d = await this.gql<{ issueCreate: { success: boolean; issue: LinearIssueRef | null } }>(
      `mutation IssueCreate($input: IssueCreateInput!) {
        issueCreate(input: $input) { success issue { id identifier url state { id name type position } } }
      }`,
      { input },
    );
    if (!d.issueCreate.success || !d.issueCreate.issue) throw new Error("Linear 创建 issue 失败");
    return d.issueCreate.issue;
  }

  async updateIssue(id: string, input: { stateId?: string; priority?: number; title?: string; description?: string }): Promise<LinearIssueRef> {
    const d = await this.gql<{ issueUpdate: { success: boolean; issue: LinearIssueRef | null } }>(
      `mutation IssueUpdate($id: String!, $input: IssueUpdateInput!) {
        issueUpdate(id: $id, input: $input) { success issue { id identifier url state { id name type position } } }
      }`,
      { id, input },
    );
    if (!d.issueUpdate.success || !d.issueUpdate.issue) throw new Error("Linear 更新 issue 失败");
    return d.issueUpdate.issue;
  }

  /** 最近的评论（最新在后），用来把提测反馈带给智能体 */
  async recentComments(issueId: string, n = 8): Promise<{ body: string; user: string; createdAt: string }[]> {
    const d = await this.gql<{ issue: { comments: { nodes: { body: string; createdAt: string; user: { name: string } | null }[] } } | null }>(
      `query IssueComments($id: String!, $n: Int) { issue(id: $id) { comments(last: $n) { nodes { body createdAt user { name } } } } }`,
      { id: issueId, n },
    );
    return (d.issue?.comments.nodes ?? []).map((c) => ({ body: c.body, user: c.user?.name ?? "?", createdAt: c.createdAt })).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async comment(issueId: string, body: string): Promise<void> {
    const d = await this.gql<{ commentCreate: { success: boolean } }>(
      `mutation CommentCreate($input: CommentCreateInput!) { commentCreate(input: $input) { success } }`,
      { input: { issueId, body } },
    );
    if (!d.commentCreate.success) throw new Error("Linear 评论失败");
  }
}
