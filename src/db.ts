import { DatabaseSync } from "node:sqlite";
import type { BetaMessageParam } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import {
  AgentSchema,
  McpServerSchema,
  ToolSchema,
  type Agent,
  type BusMessage,
  type Issue,
  type IssueComment,
  type IssueStatus,
  type McpServer,
  type Task,
  type Tool,
} from "./types.ts";

const now = () => new Date().toISOString();

export class Store {
  db: DatabaseSync;
  /** 工作项编号前缀，如 HUB-12 */
  readonly issuePrefix: string;

  constructor(path: string, issuePrefix = "HUB") {
    this.issuePrefix = issuePrefix;
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS agents (
        name TEXT PRIMARY KEY,
        config TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        agent TEXT NOT NULL,
        input TEXT NOT NULL,
        status TEXT NOT NULL,
        result TEXT,
        error TEXT,
        parent_id TEXT,
        root_id TEXT NOT NULL,
        depth INTEGER NOT NULL,
        hops INTEGER NOT NULL,
        source TEXT NOT NULL,
        priority INTEGER NOT NULL DEFAULT 0,
        turns INTEGER NOT NULL DEFAULT 0,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        messages TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_id);
      CREATE INDEX IF NOT EXISTS idx_tasks_root ON tasks(root_id);
      CREATE TABLE IF NOT EXISTS bus (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        topic TEXT NOT NULL,
        sender TEXT NOT NULL,
        content TEXT NOT NULL,
        task_id TEXT,
        hops INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_bus_topic ON bus(topic, id);
      CREATE TABLE IF NOT EXISTS tools (name TEXT PRIMARY KEY, config TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS mcp_servers (name TEXT PRIMARY KEY, config TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS issues (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL,
        priority INTEGER NOT NULL DEFAULT 0,
        assignee TEXT,
        labels TEXT NOT NULL DEFAULT '[]',
        parent_id INTEGER REFERENCES issues(id) ON DELETE SET NULL,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_issues_status ON issues(status);
      CREATE INDEX IF NOT EXISTS idx_issues_parent ON issues(parent_id);
      CREATE TABLE IF NOT EXISTS issue_comments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        issue_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
        author TEXT NOT NULL,
        kind TEXT NOT NULL,
        body TEXT NOT NULL,
        run_id TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_comments_issue ON issue_comments(issue_id, id);
    `);
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec(`CREATE TABLE IF NOT EXISTS docs (col TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (col, id))`);
    const tcols = this.db.prepare(`PRAGMA table_info(tasks)`).all() as { name: string }[];
    if (!tcols.some((c) => c.name === "cost")) this.db.exec(`ALTER TABLE tasks ADD COLUMN cost REAL NOT NULL DEFAULT 0`);
    // 旧库迁移：tasks 增加 issue_id
    const cols = this.db.prepare(`PRAGMA table_info(tasks)`).all() as { name: string }[];
    if (!cols.some((c) => c.name === "issue_id")) this.db.exec(`ALTER TABLE tasks ADD COLUMN issue_id INTEGER`);
    if (!cols.some((c) => c.name === "priority")) this.db.exec(`ALTER TABLE tasks ADD COLUMN priority INTEGER NOT NULL DEFAULT 0`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_issue ON tasks(issue_id)`);
  }

  // ---------- agents ----------
  upsertAgent(agent: Agent): Agent {
    const parsed = AgentSchema.parse(agent);
    this.db
      .prepare(
        `INSERT INTO agents(name, config, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET config = excluded.config, updated_at = excluded.updated_at`,
      )
      .run(parsed.name, JSON.stringify(parsed), now());
    return parsed;
  }

  getAgent(name: string): Agent | undefined {
    const row = this.db.prepare(`SELECT config FROM agents WHERE name = ?`).get(name) as
      | { config: string }
      | undefined;
    return row ? AgentSchema.parse(JSON.parse(row.config)) : undefined;
  }

  listAgents(): Agent[] {
    const rows = this.db.prepare(`SELECT config FROM agents ORDER BY name`).all() as { config: string }[];
    return rows.map((r) => AgentSchema.parse(JSON.parse(r.config)));
  }

  deleteAgent(name: string): boolean {
    return this.db.prepare(`DELETE FROM agents WHERE name = ?`).run(name).changes > 0;
  }

  // ---------- tools / mcp servers（同构的「名称 -> 配置」表） ----------
  private upsertConfig(table: string, name: string, config: unknown) {
    this.db
      .prepare(
        `INSERT INTO ${table}(name, config, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET config = excluded.config, updated_at = excluded.updated_at`,
      )
      .run(name, JSON.stringify(config), now());
  }
  private getConfig(table: string, name: string): unknown {
    const row = this.db.prepare(`SELECT config FROM ${table} WHERE name = ?`).get(name) as { config: string } | undefined;
    return row ? JSON.parse(row.config) : undefined;
  }
  private listConfigs(table: string): unknown[] {
    return (this.db.prepare(`SELECT config FROM ${table} ORDER BY name`).all() as { config: string }[]).map((r) =>
      JSON.parse(r.config),
    );
  }
  private deleteConfig(table: string, name: string): boolean {
    return this.db.prepare(`DELETE FROM ${table} WHERE name = ?`).run(name).changes > 0;
  }

  upsertTool(tool: Tool): Tool {
    const parsed = ToolSchema.parse(tool);
    this.upsertConfig("tools", parsed.name, parsed);
    return parsed;
  }
  getTool(name: string): Tool | undefined {
    const c = this.getConfig("tools", name);
    return c ? ToolSchema.parse(c) : undefined;
  }
  listTools(): Tool[] {
    return this.listConfigs("tools").map((c) => ToolSchema.parse(c));
  }
  deleteTool(name: string) {
    return this.deleteConfig("tools", name);
  }

  upsertMcpServer(server: McpServer): McpServer {
    const parsed = McpServerSchema.parse(server);
    this.upsertConfig("mcp_servers", parsed.name, parsed);
    return parsed;
  }
  getMcpServer(name: string): McpServer | undefined {
    const c = this.getConfig("mcp_servers", name);
    return c ? McpServerSchema.parse(c) : undefined;
  }
  listMcpServers(): McpServer[] {
    return this.listConfigs("mcp_servers").map((c) => McpServerSchema.parse(c));
  }
  deleteMcpServer(name: string) {
    return this.deleteConfig("mcp_servers", name);
  }

  // ---------- tasks ----------
  insertTask(t: Omit<Task, "createdAt" | "updatedAt" | "turns" | "inputTokens" | "outputTokens" | "cost">): Task {
    const ts = now();
    this.db
      .prepare(
        `INSERT INTO tasks(id, agent, input, status, result, error, parent_id, root_id, depth, hops, source, issue_id, priority, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(t.id, t.agent, t.input, t.status, t.result, t.error, t.parentId, t.rootId, t.depth, t.hops, t.source, t.issueId, t.priority, ts, ts);
    return this.getTask(t.id)!;
  }

  updateTask(
    id: string,
    patch: Partial<Pick<Task, "status" | "result" | "error" | "turns" | "inputTokens" | "outputTokens" | "cost">>,
  ): Task {
    const cols: Record<string, string> = {
      status: "status",
      result: "result",
      error: "error",
      turns: "turns",
      inputTokens: "input_tokens",
      outputTokens: "output_tokens",
      cost: "cost",
    };
    const sets: string[] = [];
    const vals: (string | number | null)[] = [];
    for (const [k, v] of Object.entries(patch)) {
      sets.push(`${cols[k]} = ?`);
      vals.push(v as string | number | null);
    }
    sets.push(`updated_at = ?`);
    vals.push(now(), id);
    this.db.prepare(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
    return this.getTask(id)!;
  }

  saveMessages(id: string, messages: BetaMessageParam[]) {
    this.db.prepare(`UPDATE tasks SET messages = ?, updated_at = ? WHERE id = ?`).run(JSON.stringify(messages), now(), id);
  }

  getMessages(id: string): BetaMessageParam[] {
    const row = this.db.prepare(`SELECT messages FROM tasks WHERE id = ?`).get(id) as { messages: string } | undefined;
    return row ? JSON.parse(row.messages) : [];
  }

  getTask(id: string): Task | undefined {
    const row = this.db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(id);
    return row ? rowToTask(row) : undefined;
  }

  listTasks(
    filter: { status?: string; rootId?: string; parentId?: string; rootsOnly?: boolean; issueId?: number; limit?: number } = {},
  ): Task[] {
    const where: string[] = [];
    const vals: (string | number)[] = [];
    if (filter.issueId !== undefined) (where.push("issue_id = ?"), vals.push(filter.issueId));
    if (filter.rootsOnly) where.push("parent_id IS NULL");
    if (filter.status) (where.push("status = ?"), vals.push(filter.status));
    if (filter.rootId) (where.push("root_id = ?"), vals.push(filter.rootId));
    if (filter.parentId) (where.push("parent_id = ?"), vals.push(filter.parentId));
    vals.push(filter.limit ?? 100);
    const sql = `SELECT * FROM tasks ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY created_at DESC LIMIT ?`;
    return this.db.prepare(sql).all(...vals).map(rowToTask);
  }

  /** 启动时把上次进程中断的任务标记为失败（MVP 不做断点续跑） */
  failInterrupted(): number {
    return Number(
      this.db
        .prepare(
          `UPDATE tasks SET status = 'failed', error = 'interrupted by service restart', updated_at = ?
           WHERE status IN ('pending', 'running')`,
        )
        .run(now()).changes,
    );
  }

  // ---------- issues ----------
  issueKey(id: number) {
    return `${this.issuePrefix}-${id}`;
  }

  /** 接受 "HUB-12"、"12" 或 12 */
  resolveIssueId(ref: string | number): number | undefined {
    if (typeof ref === "number") return ref;
    const m = /^(?:[A-Za-z]+-)?(\d+)$/.exec(ref.trim());
    return m ? Number(m[1]) : undefined;
  }

  insertIssue(i: Omit<Issue, "id" | "key" | "createdAt" | "updatedAt">): Issue {
    const ts = now();
    const res = this.db
      .prepare(
        `INSERT INTO issues(title, description, status, priority, assignee, labels, parent_id, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(i.title, i.description, i.status, i.priority, i.assignee, JSON.stringify(i.labels), i.parentId, i.createdBy, ts, ts);
    return this.getIssue(Number(res.lastInsertRowid))!;
  }

  updateIssueRow(
    id: number,
    patch: Partial<Pick<Issue, "title" | "description" | "status" | "priority" | "assignee" | "labels" | "parentId">>,
  ): Issue {
    const cols: Record<string, string> = {
      title: "title",
      description: "description",
      status: "status",
      priority: "priority",
      assignee: "assignee",
      labels: "labels",
      parentId: "parent_id",
    };
    const sets: string[] = [];
    const vals: (string | number | null)[] = [];
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) continue;
      sets.push(`${cols[k]} = ?`);
      vals.push(k === "labels" ? JSON.stringify(v) : (v as string | number | null));
    }
    sets.push("updated_at = ?");
    vals.push(now(), id);
    this.db.prepare(`UPDATE issues SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
    return this.getIssue(id)!;
  }

  getIssue(id: number): Issue | undefined {
    const row = this.db.prepare(`SELECT * FROM issues WHERE id = ?`).get(id);
    return row ? this.rowToIssue(row) : undefined;
  }

  listIssues(
    filter: { status?: IssueStatus[]; assignee?: string; parentId?: number; q?: string; limit?: number } = {},
  ): Issue[] {
    const where: string[] = [];
    const vals: (string | number)[] = [];
    if (filter.status?.length) {
      where.push(`status IN (${filter.status.map(() => "?").join(",")})`);
      vals.push(...filter.status);
    }
    if (filter.assignee) (where.push("assignee = ?"), vals.push(filter.assignee));
    if (filter.parentId !== undefined) (where.push("parent_id = ?"), vals.push(filter.parentId));
    if (filter.q) (where.push("(title LIKE ? OR description LIKE ?)"), vals.push(`%${filter.q}%`, `%${filter.q}%`));
    vals.push(filter.limit ?? 500);
    // 优先级：紧急(1) 最前，无(0) 最后
    const sql = `SELECT * FROM issues ${where.length ? "WHERE " + where.join(" AND ") : ""}
      ORDER BY CASE priority WHEN 0 THEN 5 ELSE priority END, updated_at DESC LIMIT ?`;
    return this.db.prepare(sql).all(...vals).map((r) => this.rowToIssue(r));
  }

  deleteIssue(id: number): boolean {
    return this.db.prepare(`DELETE FROM issues WHERE id = ?`).run(id).changes > 0;
  }

  addComment(c: Omit<IssueComment, "id" | "createdAt">): IssueComment {
    const res = this.db
      .prepare(`INSERT INTO issue_comments(issue_id, author, kind, body, run_id, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(c.issueId, c.author, c.kind, c.body, c.runId, now());
    return rowToComment(this.db.prepare(`SELECT * FROM issue_comments WHERE id = ?`).get(res.lastInsertRowid));
  }

  listComments(issueId: number, limit = 500): IssueComment[] {
    return this.db
      .prepare(`SELECT * FROM (SELECT * FROM issue_comments WHERE issue_id = ? ORDER BY id DESC LIMIT ?) ORDER BY id`)
      .all(issueId, limit)
      .map(rowToComment);
  }

  /** 每个工作项的评论数与活跃运行数（看板卡片用） */
  issueStats(): Map<number, { comments: number; activeRuns: number; runs: number }> {
    const out = new Map<number, { comments: number; activeRuns: number; runs: number }>();
    const get = (id: number) => out.get(id) ?? (out.set(id, { comments: 0, activeRuns: 0, runs: 0 }), out.get(id)!);
    for (const r of this.db.prepare(`SELECT issue_id, COUNT(*) AS n FROM issue_comments GROUP BY issue_id`).all() as any[])
      get(r.issue_id).comments = r.n;
    for (const r of this.db
      .prepare(
        `SELECT issue_id, COUNT(*) AS n, SUM(status IN ('pending','running')) AS active FROM tasks WHERE issue_id IS NOT NULL GROUP BY issue_id`,
      )
      .all() as any[]) {
      get(r.issue_id).runs = r.n;
      get(r.issue_id).activeRuns = Number(r.active);
    }
    return out;
  }

  private rowToIssue(r: any): Issue {
    return {
      id: Number(r.id),
      key: this.issueKey(Number(r.id)),
      title: r.title,
      description: r.description,
      status: r.status,
      priority: r.priority,
      assignee: r.assignee,
      labels: JSON.parse(r.labels),
      parentId: r.parent_id,
      createdBy: r.created_by,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  // ---------- 通用文档（项目、工作项、评论、测试记录、设置等） ----------
  docGet<T = any>(col: string, id: string | number): T | undefined {
    const r = this.db.prepare(`SELECT data FROM docs WHERE col = ? AND id = ?`).get(col, String(id)) as { data: string } | undefined;
    return r ? JSON.parse(r.data) : undefined;
  }
  docPut(col: string, id: string | number, data: unknown) {
    this.db.prepare(`INSERT INTO docs(col, id, data, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(col, id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`).run(col, String(id), JSON.stringify(data), now());
  }
  docList<T = any>(col: string): T[] {
    return (this.db.prepare(`SELECT data FROM docs WHERE col = ? ORDER BY rowid`).all(col) as { data: string }[]).map((r) => JSON.parse(r.data));
  }
  docDelete(col: string, id: string | number) {
    this.db.prepare(`DELETE FROM docs WHERE col = ? AND id = ?`).run(col, String(id));
  }
  docDeleteWhere(col: string, pred: (d: any) => boolean) {
    for (const d of this.docList(col)) if (pred(d)) this.docDelete(col, d.id);
  }
  nextSeq(name: string): number {
    const n = (this.docGet<{ id: string; n: number }>("seq", name)?.n ?? 0) + 1;
    this.docPut("seq", name, { id: name, n });
    return n;
  }

  // ---------- bus ----------
  publish(m: Omit<BusMessage, "id" | "createdAt">): BusMessage {
    const res = this.db
      .prepare(`INSERT INTO bus(topic, sender, content, task_id, hops, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(m.topic, m.sender, m.content, m.taskId, m.hops, now());
    const row = this.db.prepare(`SELECT * FROM bus WHERE id = ?`).get(res.lastInsertRowid);
    return rowToBus(row);
  }

  readTopic(topic: string, opts: { afterId?: number; limit?: number } = {}): BusMessage[] {
    const rows = this.db
      .prepare(`SELECT * FROM (SELECT * FROM bus WHERE topic = ? AND id > ? ORDER BY id DESC LIMIT ?) ORDER BY id`)
      .all(topic, opts.afterId ?? 0, opts.limit ?? 50);
    return rows.map(rowToBus);
  }

  listTopics(): { topic: string; count: number; lastId: number }[] {
    return this.db
      .prepare(`SELECT topic, COUNT(*) AS count, MAX(id) AS lastId FROM bus GROUP BY topic ORDER BY topic`)
      .all() as { topic: string; count: number; lastId: number }[];
  }
}

function rowToTask(r: any): Task {
  return {
    id: r.id,
    agent: r.agent,
    input: r.input,
    status: r.status,
    result: r.result,
    error: r.error,
    parentId: r.parent_id,
    rootId: r.root_id,
    depth: r.depth,
    hops: r.hops,
    source: r.source,
    issueId: r.issue_id ?? null,
    priority: r.priority ?? 0,
    turns: r.turns,
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    cost: r.cost ?? 0,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function rowToBus(r: any): BusMessage {
  return {
    id: Number(r.id),
    topic: r.topic,
    sender: r.sender,
    content: r.content,
    taskId: r.task_id,
    hops: r.hops,
    createdAt: r.created_at,
  };
}

function rowToComment(r: any): IssueComment {
  return {
    id: Number(r.id),
    issueId: r.issue_id,
    author: r.author,
    kind: r.kind,
    body: r.body,
    runId: r.run_id,
    createdAt: r.created_at,
  };
}
