import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import type { Store } from "./db.ts";
import type { Uploads } from "./uploads.ts";
import { checkPassword, clearedCookie, cookieOf, issueSession, LoginThrottle, loginEnabled, loginUser, sessionCookie, sessionSecret, verifySession, type Security } from "./auth.ts";
import type { Runtime } from "./runtime.ts";
import { readFileSync } from "node:fs";
import { detectRuntimeModels, detectRuntimes, verifyRuntimeModels } from "./runtimes.ts";
import { AgentSchema, McpServerSchema, ToolSchema, type HubEvent } from "./types.ts";

const PANEL_PATH = new URL("../public/index.html", import.meta.url);
const ASSET_DIR = new URL("../public/assets/", import.meta.url);
const ASSET_TYPES: Record<string, string> = { ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8" };

const SubmitTask = z.object({
  agent: z.string(),
  input: z.string().min(1),
  /** true 时阻塞到任务结束再返回 */
  wait: z.boolean().default(false),
  timeoutMs: z.number().int().positive().max(3_600_000).optional(),
});

const Publish = z.object({ content: z.string().min(1), sender: z.string().default("user") });

export interface AppExtras { state(): Promise<unknown>; rpc(method: string, args: unknown[]): Promise<unknown>; uploads?: Uploads }

export function createApp(store: Store, runtime: Runtime, security?: Security, extras?: AppExtras) {
  const app = new Hono();

  app.onError((err, c) => {
    if (err instanceof z.ZodError) return c.json({ error: "参数不合法：" + err.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("；"), issues: err.issues }, 400);
    const status = (err as { status?: number }).status;
    return c.json({ error: err.message }, (status === 404 || status === 409 ? status : 400) as 400);
  });

  // ---------- 登录（账号密码） ----------
  const throttle = new LoginThrottle();
  /** 首次登录后是否还需要用户自己设置账号密码 */
  const needsSetup = (s: Security) => !!s.credentials && !s.credentials.initialized;
  app.get("/api/session", (c) => {
    if (!security) return c.json({ authenticated: true, loginEnabled: false });
    const setup = needsSetup(security);
    const s = verifySession(cookieOf(c.req.header("cookie")), sessionSecret(security));
    if (!s) return c.json({ authenticated: false, loginEnabled: true, needsSetup: setup });
    return c.json({ authenticated: true, user: s.user, loginEnabled: true, needsSetup: setup });
  });
  app.post("/api/logout", (c) => {
    c.header("set-cookie", clearedCookie());
    return c.json({ ok: true });
  });

  // 鉴权：账号会话（Cookie）或 API 令牌（Bearer / ?token=）二选一
  // 注意：不要写成 loginEnabled(security)，类型守卫在已收窄的类型上会把分支推成 never
  const hasLogin = !!security?.password || !!security?.credentials?.initialized;
  const needsAuth = !!security && (hasLogin || !!security.token);
  if (needsAuth && security) {
    const cfg = security;
    app.use("*", async (c, next) => {
      const p = c.req.path;
      // 页面、静态资源、健康检查与登录接口本身不需要鉴权
      if (p === "/" || p === "/health" || p.startsWith("/assets/") || p === "/api/session" || p === "/api/login") return next();
      const bearer = c.req.header("authorization");
      const byToken = !!cfg.token && (bearer === `Bearer ${cfg.token}` || c.req.query("token") === cfg.token);
      const session = hasLogin ? verifySession(cookieOf(c.req.header("cookie")), sessionSecret(cfg)) : null;
      if (!byToken && !session) return c.json({ error: "unauthorized" }, 401);
      return next();
    });
  }

  /** 首次登录后设置自己的账号与密码；已登录才能调用，设置完成后会话按新密钥重新签发 */
  app.post("/api/setup", async (c) => {
    if (!security?.credentials) return c.json({ error: "未启用账号登录" }, 400);
    const body = (await c.req.json().catch(() => ({}))) as { user?: string; password?: string };
    const user = (body.user ?? "").trim();
    const password = body.password ?? "";
    if (!user || user.length > 32) return c.json({ error: "账号不能为空，且不超过 32 个字符" }, 400);
    if (/\s/.test(user)) return c.json({ error: "账号不能包含空格" }, 400);
    if (password.length < 6) return c.json({ error: "密码至少 6 位" }, 400);
    if (password.length > 128) return c.json({ error: "密码最多 128 位" }, 400);
    security.credentials.set(user, password);
    c.header("set-cookie", sessionCookie(issueSession(user, sessionSecret(security))));
    return c.json({ ok: true, user });
  });
  app.post("/api/login", async (c) => {
    if (!security) return c.json({ error: "未启用账号登录" }, 400);
    const ip = c.req.header("x-forwarded-for")?.split(",")[0].trim() || c.req.header("x-real-ip") || "local";
    const wait = throttle.blocked(ip);
    if (wait) return c.json({ error: `尝试过于频繁，请 ${wait} 秒后再试` }, 429);
    const body = (await c.req.json().catch(() => ({}))) as { user?: string; password?: string };
    if (!checkPassword(body, security)) {
      throttle.fail(ip);
      return c.json({ error: "用户名或密码不正确" }, 401);
    }
    throttle.ok(ip);
    const user = loginUser(security);
    c.header("set-cookie", sessionCookie(issueSession(user, sessionSecret(security))));
    return c.json({ ok: true, user, needsSetup: needsSetup(security) });
  });

  app.get("/health", (c) => c.json({ ok: true }));
  /** 上传附件（截图 / 文件）。一次最多 10 个，单个 20 MB */
  app.post("/api/upload", async (c) => {
    if (!extras) return c.json({ error: "附件功能未启用" }, 500);
    const body = await c.req.parseBody({ all: true });
    const files = Object.values(body).flat().filter((v): v is File => typeof v === "object" && v !== null && "arrayBuffer" in v && "name" in v);
    if (!files.length) return c.json({ error: "没有收到文件" }, 400);
    if (files.length > 10) return c.json({ error: "一次最多上传 10 个文件" }, 400);
    const saved = [];
    for (const f of files) {
      const buf = Buffer.from(await f.arrayBuffer());
      saved.push(extras.uploads!.save({ name: f.name, type: f.type, size: f.size, arrayBuffer: async () => buf.buffer as ArrayBuffer }, buf));
    }
    return c.json({ attachments: saved }, 201);
  });
  /** 读取附件（图片按原 mime 返回，其它按下载） */
  app.get("/uploads/:id", (c) => {
    if (!extras) return c.notFound();
    const got = extras.uploads!.read(c.req.param("id"));
    if (!got) return c.notFound();
    return c.newResponse(new Uint8Array(got.data), 200, {
      "content-type": got.meta.mime,
      "cache-control": "private, max-age=86400",
      "content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(got.meta.name)}`,
    });
  });

  app.get("/runtimes", async (c) => c.json(await detectRuntimes(c.req.query("refresh") === "1")));
  /** 某个 CLI 底座可用的模型（refresh=1 强制重新检测） */
  app.get("/runtimes/:id/models", async (c) => {
    const id = c.req.param("id");
    if (!["claude-code", "codex", "gemini", "pi", "builtin"].includes(id)) return c.json({ error: "unknown runtime" }, 404);
    if (id === "builtin") {
      const models = (await import("./settings.ts")).MODELS.map((m) => ({ id: m.id, name: m.label }));
      return c.json({ models, source: "内置模型列表", detectedAt: new Date().toISOString() });
    }
    const data = await detectRuntimeModels(id, { force: c.req.query("refresh") === "1" });
    const verify = c.req.query("verify") === "1" ? await verifyRuntimeModels(id) : null;
    return c.json(verify ? { ...data, verify } : data);
  });

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
  // ---------- 前端静态资源（无构建：styles.css / app.js） ----------
  app.get("/assets/:file", (c) => {
    const file = c.req.param("file");
    const type = ASSET_TYPES[file.slice(file.lastIndexOf("."))];
    if (!/^[A-Za-z0-9._-]+$/.test(file) || !type) return c.notFound();
    try {
      return c.body(readFileSync(new URL(file, ASSET_DIR)), 200, { "content-type": type, "cache-control": "no-cache" });
    } catch {
      return c.notFound();
    }
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
    return c.json({ ...task, children, receipt: store.docGet("receipts", task.id) ?? null, ...(withMessages ? { messages: store.getMessages(task.id) } : {}) });
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
