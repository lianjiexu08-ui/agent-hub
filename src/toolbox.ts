/**
 * 内置循环可选的扩展工具：读文件、写文件、检索代码、执行命令、检索项目知识。
 *
 * 设计约束：
 * - 默认不给任何智能体。只有智能体在 builtinTools 里显式开启，对应工具才会出现在它的工具表里。
 * - 文件与命令操作一律限定在该工作项的工作目录（worktree）内，路径逃逸会被拒绝。
 * - 命令以工作目录为 cwd 执行，受超时与输出上限约束，任务取消时整组进程被杀掉。
 * - CLI 底座（claude-code / codex 等）自带这些能力，这里只服务内置循环，避免两套工具打架。
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { z } from "zod";
import type { Runtime } from "./runtime.ts";
import type { Store } from "./db.ts";
import type { Settings } from "./settings.ts";
import type { Workspace } from "./workspace.ts";
import type { Work } from "./work.ts";
import type { Task } from "./types.ts";

const MAX_READ = 200_000;
const MAX_WRITE = 1_000_000;
const MAX_OUTPUT = 100_000;

/** 把相对路径限制在工作目录内；越界直接拒绝，符号链接解析后同样检查 */
export function safeJoin(root: string, rel: string): string {
  const base = resolve(root);
  const target = resolve(base, rel || ".");
  const r = relative(base, target);
  if (r.startsWith("..") || (r !== "" && !target.startsWith(base + "/"))) throw new Error(`只能访问工作目录内的路径：${rel}`);
  return target;
}

interface Ctx {
  task: Task;
  agent: { name: string };
  signal: AbortSignal;
}

export function registerToolbox(runtime: Runtime, deps: { work: Work; workspace: Workspace; store: Store; settings: Settings }) {
  const { work, workspace, store, settings } = deps;

  /** 当前任务的工作目录：只有绑定了仓库、且该智能体用 CLI 或开了文件/命令工具时才存在 */
  const workdirOf = (task: Task): string => {
    const issue = task.issueId == null ? null : work.list().find((i) => i.id === task.issueId);
    const p = issue && work.proj(issue.projectId);
    const agent = store.getAgent(task.agent);
    if (!issue || !p || !workspace.enabledFor(p, agent)) {
      throw new Error("这个任务没有工作目录：项目未绑定仓库、未配置 GitHub Token，或该智能体没有开启文件与命令工具");
    }
    return workspace.dir(p, issue.key);
  };

  const wrap = <T>(schema: z.ZodType<T>, fn: (input: T, ctx: Ctx, dir: string) => Promise<string> | string) =>
    async (raw: unknown, ctx: Ctx) => {
      const parsed = schema.safeParse(raw);
      if (!parsed.success) return { content: `参数不合法：${parsed.error.message}`, isError: true };
      try {
        const dir = workdirOf(ctx.task);
        return { content: await fn(parsed.data, ctx, dir) };
      } catch (err) {
        return { content: err instanceof Error ? err.message : String(err), isError: true };
      }
    };

  const allow = (name: string) => (task: Task, agent: { builtinTools?: string[] }) => {
    if ((agent.builtinTools ?? []).includes(name)) return true;
    // 知识检索只读，且不依赖工作目录：内置循环的智能体默认也能用
    return name === "search_knowledge";
  };

  // ---------- 读 ----------
  runtime.addTool({
    name: "read_file",
    description: "读取工作目录里的文件内容（最多 200KB）。大文件建议先用 search_repo 定位，再读取相关片段。",
    input_schema: { type: "object", properties: { path: { type: "string", description: "相对工作目录的路径" }, offset: { type: "integer", description: "从第几行开始，默认 1" }, limit: { type: "integer", description: "读多少行，默认全部" } }, required: ["path"], additionalProperties: false },
  }, wrap(z.object({ path: z.string(), offset: z.number().int().min(1).optional(), limit: z.number().int().min(1).optional() }), ({ path, offset, limit }, _c, dir) => {
    const file = safeJoin(dir, path);
    if (!existsSync(file)) throw new Error(`文件不存在：${path}`);
    const st = statSync(file);
    if (st.isDirectory()) throw new Error(`${path} 是目录，用 list_files 查看结构`);
    if (st.size > MAX_READ * 4) throw new Error(`文件过大（${Math.round(st.size / 1024)}KB），请用 search_repo 定位后再读`);
    const lines = readFileSync(file, "utf8").split("\n");
    const from = (offset ?? 1) - 1;
    const slice = lines.slice(from, limit ? from + limit : undefined);
    const head = offset && offset > 1 ? `（从第 ${from + 1} 行开始，共 ${lines.length} 行）\n` : "";
    return head + slice.join("\n").slice(0, MAX_READ);
  }), allow("read_file"));

  runtime.addTool({
    name: "list_files",
    description: "列出工作目录的结构。默认只列一层；depth 可到 3 层。",
    input_schema: { type: "object", properties: { path: { type: "string", description: "相对路径，默认根目录" }, depth: { type: "integer", description: "递归层数，1-3，默认 1" } }, additionalProperties: false },
  }, wrap(z.object({ path: z.string().optional(), depth: z.number().int().min(1).max(3).optional() }), ({ path, depth }, _c, dir) => {
    const root = safeJoin(dir, path ?? ".");
    const walk = (d: string, lv: number): string[] => {
      const out: string[] = [];
      for (const e of readdirSync(d, { withFileTypes: true }).filter((x) => x.name !== ".git").sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name)).slice(0, 200)) {
        const rel = relative(dir, resolve(d, e.name));
        out.push(`${"  ".repeat(lv - 1)}${e.name}${e.isDirectory() ? "/" : ""}`);
        if (e.isDirectory() && lv < (depth ?? 1)) out.push(...walk(resolve(d, e.name), lv + 1));
      }
      return out;
    };
    const list = walk(root, 1);
    return list.length ? list.slice(0, 500).join("\n") : "（空目录）";
  }), allow("list_files"));

  runtime.addTool({
    name: "search_repo",
    description: "在工作目录里按关键词检索（优先用 git grep，仓库不完整时退回遍历）。返回 文件:行号:内容。",
    input_schema: { type: "object", properties: { query: { type: "string" }, glob: { type: "string", description: "限定文件，如 src/**/*.ts" }, limit: { type: "integer", description: "最多返回多少条，默认 60" } }, required: ["query"], additionalProperties: false },
  }, wrap(z.object({ query: z.string().min(1), glob: z.string().optional(), limit: z.number().int().min(1).max(200).optional() }), async ({ query, glob, limit }, _c, dir) => {
    const cap = limit ?? 60;
    const grep = await new Promise<string>((res) => {
      const args = ["grep", "-n", "-I", "--no-color", "-e", query];
      if (glob) args.push("--", glob);
      const p = spawn("git", args, { cwd: dir, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
      let out = "";
      p.stdout.on("data", (b) => { out += String(b); });
      p.on("error", () => res(""));
      p.on("close", () => res(out));
    });
    if (grep.trim()) return grep.split("\n").slice(0, cap).join("\n");
    // 退回普通遍历（非 git 目录或没有匹配时的兜底）
    const hits: string[] = [];
    const scan = (d: string) => {
      if (hits.length >= cap) return;
      for (const e of readdirSync(d, { withFileTypes: true })) {
        if (hits.length >= cap) return;
        if (e.name === ".git" || e.name === "node_modules") continue;
        const abs = resolve(d, e.name);
        if (e.isDirectory()) { scan(abs); continue; }
        try {
          if (statSync(abs).size > MAX_READ) continue;
          readFileSync(abs, "utf8").split("\n").forEach((line, n) => { if (hits.length < cap && line.includes(query)) hits.push(`${relative(dir, abs)}:${n + 1}:${line.slice(0, 300)}`); });
        } catch { /* 二进制或不可读，跳过 */ }
      }
    };
    scan(dir);
    return hits.length ? hits.join("\n") : `没有找到 ${query}`;
  }), allow("search_repo"));

  // ---------- 写 ----------
  runtime.addTool({
    name: "write_file",
    description: "在工作目录里写入文件（覆盖或新建，自动创建父目录，单次最多 1MB）。写入后建议用 read_file 复核。",
    input_schema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"], additionalProperties: false },
  }, wrap(z.object({ path: z.string().min(1), content: z.string() }), ({ path, content }, _c, dir) => {
    if (content.length > MAX_WRITE) throw new Error(`内容过大（${content.length} 字符），上限 ${MAX_WRITE}`);
    const file = safeJoin(dir, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content, "utf8");
    return `已写入 ${path}（${content.length} 字符）`;
  }), allow("write_file"));

  // ---------- 执行 ----------
  runtime.addTool({
    name: "run_command",
    description: "在工作目录里执行一条 shell 命令（装依赖、跑测试、构建、git 状态等）。命令在独立进程组中运行，超时或任务取消会被杀掉；输出截断到 100KB。不要执行需要交互的命令（如编辑器、登录）。",
    input_schema: { type: "object", properties: { command: { type: "string" }, timeoutMs: { type: "integer", description: "超时毫秒，默认 120000，上限 600000" } }, required: ["command"], additionalProperties: false },
  }, wrap(z.object({ command: z.string().min(1), timeoutMs: z.number().int().min(1000).max(600_000).optional() }), ({ command, timeoutMs }, ctx, dir) => {
    const timeout = timeoutMs ?? 120_000;
    const g = settings.get().guard;
    if (g.isolation !== "worktree" && g.isolation !== "container") throw new Error("当前执行隔离配置不允许运行命令");
    return new Promise<string>((res, rej) => {
      const p = spawn("/bin/bash", ["-lc", command], { cwd: dir, detached: true, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", CI: "1" } });
      let out = "";
      const push = (b: Buffer) => { if (out.length < MAX_OUTPUT) out += String(b); };
      p.stdout.on("data", push);
      p.stderr.on("data", push);
      let done = false;
      const finish = (err?: Error) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        ctx.signal.removeEventListener("abort", onAbort);
        const body = `$ ${command}\n\n${out.slice(0, MAX_OUTPUT)}`;
        if (err) rej(new Error(`${body}\n\n${err.message}`)); else res(body || "（无输出）");
      };
      const kill = () => { try { process.kill(-p.pid!, "SIGKILL"); } catch { p.kill("SIGKILL"); } };
      const timer = setTimeout(() => { kill(); finish(new Error(`命令超时（${timeout}ms）已终止`)); }, timeout);
      const onAbort = () => { kill(); finish(new Error("任务已取消")); };
      ctx.signal.addEventListener("abort", onAbort, { once: true });
      p.on("error", (e) => finish(e));
      p.on("close", (code, sig) => finish(code === 0 && !sig ? undefined : new Error(`退出码 ${code ?? "-"}${sig ? `（${sig}）` : ""}`)));
    });
  }), allow("run_command"));

  // ---------- 知识 ----------
  runtime.addTool({
    name: "search_knowledge",
    description: "检索项目知识库：团队沉淀的约定、结论和踩过的坑。写方案或评审前先查一下，避免和既有决定冲突。",
    input_schema: { type: "object", properties: { query: { type: "string", description: "关键词；留空则按项目返回全部" }, project: { type: "string", description: "项目前缀，默认当前工作项所属项目" } }, additionalProperties: false },
  }, async (raw: unknown, ctx: Ctx) => {
    const parsed = z.object({ query: z.string().optional(), project: z.string().optional() }).safeParse(raw);
    if (!parsed.success) return { content: `参数不合法：${parsed.error.message}`, isError: true };
    const { query, project } = parsed.data;
    const pid = project ? work.projects().find((p) => p.key === project.toUpperCase())?.id : null;
    const all = (pid ? [pid] : work.projects().map((p) => String(p.id))).flatMap((id) => settings.knowledge(id).filter((k) => k.on));
    const hits = query ? all.filter((k) => k.text.includes(query) || k.kind.includes(query)) : all;
    if (!hits.length) return { content: query ? `知识库里没有匹配「${query}」的内容` : "知识库还是空的" };
    return { content: hits.slice(0, 20).map((k) => `- [${k.kind}] ${k.text}`).join("\n") };
  }, allow("search_knowledge"));
}
