import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import type { Store } from "./db.ts";
import type { Runtime } from "./runtime.ts";
import { readFileSync } from "node:fs";
import { detectRuntimes } from "./runtimes.ts";
import { AgentSchema, McpServerSchema, ToolSchema, type HubEvent } from "./types.ts";

const PANEL_PATH = new URL("../public/index.html", import.meta.url);

const SubmitTask = z.object({
  agent: z.string(),
  input: z.string().min(1),
  /** true 时阻塞到任务结束再返回 */
  wait: z.boolean().default(false),
  timeoutMs: z.number().int().positive().max(3_600_000).optional(),
});

const Publish = z.object({ content: z.string().min(1), sender: z.string().default("user") });

export interface AppExtras { state(): Promise<unknown>; rpc(method: string, args: unknown[]): Promise<unknown> }

export function createApp(store: Store, runtime: Runtime, token?: string, extras?: AppExtras) {
  const app = new Hono();

  app.onError((err, c) => {
    if (err instanceof z.ZodError) return c.json({ error: "参数不合法：" + err.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("；"), issues: err.issues }, 400);
    const status = (err as { status?: number }).status;
    return c.json({ error: err.message }, (status === 404 || status === 409 ? status : 400) as 400);
  });

  if (token) {
    app.use("*", async (c, next) => {
      if (c.req.path === "/health" || c.req.path === "/") return next();
      // 浏览器 EventSource 无法设置请求头，所以也接受 ?token=
      const ok = c.req.header("authorization") === `Bearer ${token}` || c.req.query("token") === token;
      if (!ok) return c.json({ error: "unauthorized" }, 401);
      return next();
    });
  }

  app.get("/health", (c) => c.json({ ok: true }));
  app.get("/runtimes", async (c) => c.json(await detectRuntimes(c.req.query("refresh") === "1")));

  // ---------- 面板数据与操作 ----------
  if (extras) {
    app.get("/api/state", async (c) => c.json(await extras.state()));
    app.post("/api/rpc", async (c) => {
      const { method, args } = (await c.req.json()) as { method: string; args?: unknown[] };
      return c.json({ result: (await extras.rpc(method, args ?? [])) ?? null });
    });
  }

  // ---------- CLI 底座的任务级 MCP 桥 ----------
  app.get("/internal/tasks/:id/tools", (c) => c.json(runtime.toolDefsFor(c.req.param("id")).map((t) => ({ name: (t as { name: string }).name, description: (t as { description?: string }).description, input_schema: (t as { input_schema?: unknown }).input_schema ?? {} }))));
  app.post("/internal/tasks/:id/tool", async (c) => {
    const { name, input } = (await c.req.json()) as { name: string; input: unknown };
    try { return c.json(await runtime.invokeTool(c.req.param("id"), name, input)); }
    catch (e) { return c.json({ error: (e as Error).message, isError: true }); }
  });
  app.get("/", (c) => c.html(readFileSync(PANEL_PATH, "utf8"))); // 每次读取，改面板无需重启

  // ---------- agents ----------
  app.get("/agents", (c) => c.json(store.listAgents()));
  app.get("/agents/:name", (c) => {
    const agent = store.getAgent(c.req.param("name"));
    return agent ? c.json(agent) : c.json({ error: "not found" }, 404);
  });
  app.put("/agents/:name", async (c) => {
    const body = await c.req.json();
    const agent = AgentSchema.parse({ ...body, name: c.req.param("name") });
    return c.json(store.upsertAgent(agent));
  });
  app.post("/agents", async (c) => c.json(store.upsertAgent(AgentSchema.parse(await c.req.json())), 201));
  app.delete("/agents/:name", (c) =>
    store.deleteAgent(c.req.param("name")) ? c.body(null, 204) : c.json({ error: "not found" }, 404),
  );

  // ---------- 自定义工具（webhook） ----------
  app.get("/tools", (c) => c.json(store.listTools()));
  app.get("/tools/:name", (c) => {
    const tool = store.getTool(c.req.param("name"));
    return tool ? c.json(tool) : c.json({ error: "not found" }, 404);
  });
  app.put("/tools/:name", async (c) =>
    c.json(store.upsertTool(ToolSchema.parse({ ...(await c.req.json()), name: c.req.param("name") }))),
  );
  app.delete("/tools/:name", (c) =>
    store.deleteTool(c.req.param("name")) ? c.body(null, 204) : c.json({ error: "not found" }, 404),
  );

  // ---------- MCP 服务器 ----------
  app.get("/mcp-servers", (c) => c.json(store.listMcpServers()));
  app.get("/mcp-servers/:name", (c) => {
    const server = store.getMcpServer(c.req.param("name"));
    return server ? c.json(server) : c.json({ error: "not found" }, 404);
  });
  app.put("/mcp-servers/:name", async (c) => {
    const server = store.upsertMcpServer(McpServerSchema.parse({ ...(await c.req.json()), name: c.req.param("name") }));
    await runtime.mcp.reset(server.name);
    return c.json(server);
  });
  app.delete("/mcp-servers/:name", async (c) => {
    await runtime.mcp.reset(c.req.param("name"));
    return store.deleteMcpServer(c.req.param("name")) ? c.body(null, 204) : c.json({ error: "not found" }, 404);
  });
  /** 连接服务器并列出工具，用来检查配置是否可用 */
  app.get("/mcp-servers/:name/tools", async (c) => {
    const server = store.getMcpServer(c.req.param("name"));
    if (!server) return c.json({ error: "not found" }, 404);
    try {
      return c.json(await runtime.mcp.listTools(server));
    } catch (err) {
      return c.json({ error: `connect failed: ${err instanceof Error ? err.message : err}` }, 502);
    }
  });

  // ---------- tasks ----------
  app.post("/tasks", async (c) => {
    const body = SubmitTask.parse(await c.req.json());
    const task = runtime.submit(body.agent, body.input);
    if (!body.wait) return c.json(task, 202);
    return c.json(await runtime.waitFor(task.id, body.timeoutMs));
  });
  app.get("/tasks", (c) =>
    c.json(
      store.listTasks({
        status: c.req.query("status"),
        rootId: c.req.query("root"),
        parentId: c.req.query("parent"),
        rootsOnly: c.req.query("roots") === "1",
        limit: Number(c.req.query("limit") ?? 50),
      }),
    ),
  );
  app.get("/tasks/:id", (c) => {
    const task = store.getTask(c.req.param("id"));
    if (!task) return c.json({ error: "not found" }, 404);
    const children = store.listTasks({ parentId: task.id, limit: 1000 });
    const withMessages = c.req.query("messages") === "1";
    return c.json({ ...task, children, ...(withMessages ? { messages: store.getMessages(task.id) } : {}) });
  });
  /** 整棵调用树（以 root 为根） */
  app.get("/tasks/:id/tree", (c) => {
    const task = store.getTask(c.req.param("id"));
    if (!task) return c.json({ error: "not found" }, 404);
    const all = store.listTasks({ rootId: task.rootId, limit: 10_000 });
    const build = (id: string): unknown => {
      const t = all.find((x) => x.id === id)!;
      return { ...t, children: all.filter((x) => x.parentId === id).reverse().map((x) => build(x.id)) };
    };
    return c.json(build(task.rootId));
  });
  app.get("/tasks/:id/wait", async (c) => {
    const timeoutMs = Number(c.req.query("timeoutMs") ?? 60_000);
    return c.json(await runtime.waitFor(c.req.param("id"), Math.min(timeoutMs, 3_600_000)));
  });
  app.post("/tasks/:id/cancel", (c) => {
    const task = runtime.cancel(c.req.param("id"));
    return task ? c.json(task) : c.json({ error: "not found" }, 404);
  });

  // ---------- bus ----------
  app.get("/topics", (c) => c.json(store.listTopics()));
  app.get("/topics/:topic/messages", (c) =>
    c.json(
      store.readTopic(c.req.param("topic"), {
        afterId: Number(c.req.query("after") ?? 0),
        limit: Number(c.req.query("limit") ?? 50),
      }),
    ),
  );
  app.post("/topics/:topic/messages", async (c) => {
    const body = Publish.parse(await c.req.json());
    return c.json(runtime.publish(c.req.param("topic"), body.content, { sender: body.sender }), 201);
  });

  // ---------- 实时事件流 ----------
  app.get("/events", (c) =>
    streamSSE(c, async (stream) => {
      const onEvent = (e: HubEvent) => void stream.writeSSE({ event: e.type, data: JSON.stringify(e) });
      runtime.events.on("event", onEvent);
      stream.onAbort(() => {
        runtime.events.off("event", onEvent);
      });
      while (!stream.aborted) await stream.sleep(15_000).then(() => stream.writeSSE({ event: "ping", data: "" }));
    }),
  );

  return app;
}
