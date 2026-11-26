/**
 * 运行底座检测：智能体除了用内置的 Claude API 循环，也可以交给成熟的 CLI 智能体执行。
 * 这里检测 Hub 所在机器（部署后即服务器）上安装了哪些 CLI 及其版本。
 */
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir, hostname, platform } from "node:os";
import { join } from "node:path";

const CONFIG_DIRS: Record<string, string> = {
  "claude-code": ".claude",
  codex: ".codex",
  gemini: ".gemini",
  pi: ".pi",
};

export interface RuntimeLogin {
  ok: boolean;
  /** 登录方式或状态说明，例如「OAuth 登录」「2 个供应商已配置 Key」 */
  method: string;
}

export interface RuntimeInfo {
  id: string;
  name: string;
  bin: string;
  installed: boolean;
  path: string | null;
  version: string | null;
  /** 是否已登录 / 已配置凭据（读的是各 CLI 自己的登录状态，不复制密钥） */
  login?: RuntimeLogin | null;
}

/** bin 来自固定列表，不接受外部输入 */
const CLIS = [
  { id: "claude-code", name: "Claude Code", bin: "claude" },
  { id: "codex", name: "Codex CLI", bin: "codex" },
  { id: "gemini", name: "Gemini CLI", bin: "gemini" },
  { id: "pi", name: "pi", bin: "pi" },
] as const;

function exec(file: string, args: string[], timeout = 8000): Promise<string | null> {
  return new Promise((resolve) => {
    // codex debug models 在新版本里会连同模型说明一起输出（已接近 1MB），默认 maxBuffer 会直接截断
    execFile(file, args, { timeout, env: process.env, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err && !stdout) return resolve(null);
      resolve(`${stdout || stderr}`.trim());
    });
  });
}

let cache: { at: number; data: { host: string; platform: string; runtimes: RuntimeInfo[] } } | null = null;

/**
 * CLI 可能装在 nvm / fnm 这类只加在登录 shell 里的目录下（本机 claude 就在 nvm 的 bin 里）。
 * 守护进程自己的 PATH 往往看不到它们，所以用登录 shell 解析一次并缓存 30 分钟；
 * PATH、HOME 等关键环境变量变化时立即失效。
 */
const SHELL_TTL = 30 * 60_000;
const shellCache = new Map<string, { at: number; fingerprint: string; paths: Map<string, string | null> }>();

function envFingerprint() {
  return [process.env.PATH, process.env.HOME, process.env.SHELL, process.env.NVM_DIR].join("\u0000");
}

/** 用登录 shell 一次性解析多个命令的位置（找不到的记为 null） */
export async function resolveBins(bins: string[], opts: { shell?: string; now?: number } = {}): Promise<Map<string, string | null>> {
  const fingerprint = envFingerprint();
  const key = [...bins].sort().join(",");
  const hit = shellCache.get(key);
  const now = opts.now ?? Date.now();
  if (hit && hit.fingerprint === fingerprint && now - hit.at < SHELL_TTL) return hit.paths;

  const shell = opts.shell ?? process.env.SHELL ?? "/bin/bash";
  const script = `for b in ${bins.map((b) => b.replace(/[^A-Za-z0-9._-]/g, "")).join(" ")}; do printf '%s\\t' "$b"; command -v "$b" || printf '\\n'; done`;
  let out = await exec(shell, ["-lc", script], 10_000);
  if (!out) out = await exec("/bin/sh", ["-c", script], 10_000); // 登录 shell 不可用时退回
  const paths = new Map<string, string | null>();
  for (const line of (out ?? "").split("\n")) {
    const [name, path] = line.split("\t");
    if (name) paths.set(name, path?.trim() || null);
  }
  for (const b of bins) if (!paths.has(b)) paths.set(b, null);
  shellCache.set(key, { at: now, fingerprint, paths });
  return paths;
}

/** 清空登录 shell 解析缓存（测试或用户手动重新检测时用） */
export function resetShellCache() { shellCache.clear(); }

export async function detectRuntimes(force = false) {
  if (!force && cache && Date.now() - cache.at < 60_000) return cache.data;
  const resolved = await resolveBins(CLIS.map((c) => c.bin));
  const runtimes = await Promise.all(
    CLIS.map(async (c): Promise<RuntimeInfo> => {
      const path = resolved.get(c.bin) ?? null;
      const version = path ? ((await exec(path, ["--version"]))?.split("\n")[0] ?? null) : null;
      return { ...c, installed: !!path, path, version };
    }),
  );
  const homes = runtimeHomes();
  const claudePath = resolved.get("claude") ?? null;
  const claudeAuth = claudePath ? parseClaudeAuth(await exec(claudePath, ["auth", "status"], 12_000)) : null;
  const data = {
    host: hostname(),
    platform: platform(),
    runtimes: runtimes.map((r) => ({
      ...r,
      home: homes[r.id] ?? null,
      login: r.id === "claude-code" ? claudeAuth : runtimeLogin(r.id),
    })),
  };
  cache = { at: Date.now(), data };
  return data;
}

/**
 * 本地 CLI 的配置信息：配置目录、是否有登录状态、默认模型（只读非敏感字段，不读密钥）。
 */
function readDefaultModel(id: string, dir: string): string | null {
  try {
    if (id === "codex") {
      const toml = readFileSync(join(dir, "config.toml"), "utf8");
      return /^\s*model\s*=\s*["']([^"']+)["']/m.exec(toml)?.[1] ?? null;
    }
    if (id === "claude-code") {
      const json = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"));
      return typeof json.model === "string" ? json.model : null;
    }
    if (id === "pi" || id === "gemini") {
      for (const f of ["config.json", "settings.json"]) {
        if (!existsSync(join(dir, f))) continue;
        const json = JSON.parse(readFileSync(join(dir, f), "utf8"));
        const m = json.model ?? json.defaultModel ?? json.default_model;
        if (typeof m === "string") return m;
      }
    }
  } catch {
    /* 配置不存在或格式不同：不影响检测 */
  }
  return null;
}

/** 解析 `claude auth status` 的 JSON */
export function parseClaudeAuth(raw: string | null): RuntimeLogin | null {
  if (!raw) return null;
  try {
    const j = JSON.parse(raw) as { loggedIn?: boolean; authMethod?: string };
    if (typeof j.loggedIn !== "boolean") return null;
    const method = j.authMethod === "oauth_token" ? "OAuth 登录" : j.authMethod === "api_key" ? "API Key" : (j.authMethod ?? "");
    return { ok: j.loggedIn, method: j.loggedIn ? method || "已登录" : "未登录" };
  } catch {
    return null;
  }
}

/** 解析 codex 的 auth.json：有 tokens 是 ChatGPT 登录，只有 OPENAI_API_KEY 是 Key 登录。只判断键是否存在，不读值 */
export function parseCodexAuth(raw: string | null): RuntimeLogin | null {
  if (!raw) return null;
  try {
    const j = JSON.parse(raw) as { tokens?: unknown; OPENAI_API_KEY?: unknown };
    if (j.tokens) return { ok: true, method: "ChatGPT 登录" };
    if (j.OPENAI_API_KEY) return { ok: true, method: "OpenAI API Key" };
    return { ok: false, method: "未登录" };
  } catch {
    return null;
  }
}

/** 解析 pi 的 models.json：统计配置了 Key 的供应商 */
export function parsePiAuth(raw: string | null): RuntimeLogin | null {
  if (!raw) return null;
  try {
    const j = JSON.parse(raw) as { providers?: Record<string, { apiKey?: string }> };
    const all = Object.entries(j.providers ?? {});
    const withKey = all.filter(([, c]) => !!c?.apiKey).length;
    return withKey ? { ok: true, method: `${withKey} 个供应商已配置 Key` } : { ok: false, method: "供应商未配置 Key" };
  } catch {
    return null;
  }
}

/** pi 的 auth.json 里登录了哪些供应商（只取键名） */
export function piAuthProviders(raw: string): string[] {
  try {
    const j = JSON.parse(raw) as Record<string, unknown>;
    return Object.entries(j).filter(([, v]) => v && typeof v === "object").map(([k]) => k);
  } catch {
    return [];
  }
}

/**
 * 解析 `pi --list-models` 的表格：provider  model  context  max-out  ...
 * 列出的是所有已登录供应商的模型（内置目录 + models.json 自定义的）。
 */
export function parsePiListModels(raw: string): RuntimeModel[] {
  const out: RuntimeModel[] = [];
  const seen = new Set<string>();
  for (const line of raw.split("\n")) {
    const cols = line.trim().split(/\s{2,}|\t+/).filter(Boolean);
    if (cols.length < 2 || /^provider$/i.test(cols[0]) || /^-+$/.test(cols[0])) continue;
    const [provider, model, context] = cols;
    if (!/^[\w.-]+$/.test(provider) || !/^[\w./:-]+$/.test(model)) continue;
    const id = `${provider}/${model}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, name: model, note: `${provider}${context ? ` · ${context} 上下文` : ""}` });
  }
  return out;
}

/** 解析 `pi auth check --provider X --model Y` 的输出 */
export function parsePiAuthCheck(raw: string | null): { ok: boolean; note: string } {
  const text = (raw ?? "").trim();
  const first = text.split("\n").map((x) => x.trim()).filter(Boolean)[0] ?? "";
  const ok = /^ready$/i.test(first);
  return { ok, note: ok ? "ready" : first.slice(0, 160) || "没有输出" };
}

/** 每个 CLI 在本机的登录状态（读配置目录，不读取也不返回任何密钥内容） */
export function runtimeLogin(id: string): RuntimeLogin | null {
  const dir = join(homedir(), CONFIG_DIRS[id] ?? "");
  try {
    if (id === "codex") {
      const f = join(dir, "auth.json");
      return existsSync(f) ? parseCodexAuth(readFileSync(f, "utf8")) : { ok: false, method: "未登录" };
    }
    if (id === "pi") {
      // 登录凭据在 auth.json（pi auth login 写入，只看有哪些供应商，不读内容）；models.json 里也可能直接配了 apiKey
      const auth = join(dir, "agent", "auth.json");
      const providers = existsSync(auth) ? piAuthProviders(readFileSync(auth, "utf8")) : [];
      if (providers.length) return { ok: true, method: `已登录 ${providers.join("、")}` };
      const f = join(dir, "agent", "models.json");
      return existsSync(f) ? parsePiAuth(readFileSync(f, "utf8")) : { ok: false, method: "未登录任何供应商（pi auth login）" };
    }
    if (id === "gemini") {
      if (!existsSync(join(dir, "oauth_creds.json"))) return { ok: false, method: "未登录" };
      return { ok: true, method: "Google 登录" };
    }
  } catch {
    return null;
  }
  return null;
}

/** 每个 CLI 在本机的配置概况（目录是否存在、默认模型），用于设置页展示与「直接用本地登录」 */
export function runtimeHomes() {
  return Object.fromEntries(
    Object.entries(CONFIG_DIRS).map(([id, name]) => {
      const dir = join(homedir(), name);
      const exists = existsSync(dir);
      return [id, { dir, exists, model: exists ? readDefaultModel(id, dir) : null }];
    }),
  );
}

/**
 * 各 CLI 可用模型的检测。
 * - codex：`codex debug models` 直接输出模型目录（JSON）
 * - pi：读 ~/.pi/agent/models.json 里配置的各 provider 模型
 * - claude-code：没有列模型的命令，给别名（opus / sonnet / haiku / fable）与配置里的默认模型
 * - gemini：未安装时返回空
 * 只返回模型标识与显示名，绝不返回 apiKey、baseUrl 等敏感信息。
 */
export interface RuntimeModel {
  id: string;
  name?: string;
  note?: string;
}

export interface RuntimeModels {
  models: RuntimeModel[];
  /** 检测方式与注意事项 */
  source: string;
  detectedAt: string;
}

/** 解析 codex debug models 的输出 */
export function parseCodexModels(raw: string): RuntimeModel[] {
  const j = JSON.parse(raw) as { models?: { slug?: string; display_name?: string; visibility?: string; description?: string }[] };
  return (j.models ?? [])
    .filter((m) => m.slug && (m.visibility === undefined || m.visibility === "list"))
    .map((m) => ({ id: String(m.slug), name: m.display_name ?? String(m.slug), note: m.description }));
}

/** 解析 pi 的 models.json（providers → models）。
 * 注意：pi 的 --model 需要 `provider/model` 形式，只写模型名会解析失败（auth check 返回 invalid），
 * 所以这里返回带 provider 前缀的完整标识；不同 provider 下的同名模型也不会被去重掉。
 */
export function parsePiModels(raw: string): RuntimeModel[] {
  const j = JSON.parse(raw) as { providers?: Record<string, { models?: { id?: string; name?: string; contextWindow?: number }[] }> };
  const out: RuntimeModel[] = [];
  const seen = new Set<string>();
  for (const [provider, cfg] of Object.entries(j.providers ?? {})) {
    for (const m of cfg.models ?? []) {
      if (!m.id) continue;
      const id = `${provider}/${m.id}`;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({ id, name: m.name ?? m.id, note: `${provider}${m.contextWindow ? ` · ${Math.round(m.contextWindow / 1000)}k 上下文` : ""}` });
    }
  }
  return out;
}

/** Claude Code 的模型别名，以及配置里的默认模型（只读 model 字段，不读令牌） */
export function parseClaudeModels(settingsJson: string | null): RuntimeModel[] {
  const out: RuntimeModel[] = ["opus", "sonnet", "haiku", "fable"].map((id) => ({ id, name: id, note: "别名" }));
  try {
    const j = settingsJson ? (JSON.parse(settingsJson) as { model?: string; env?: { ANTHROPIC_MODEL?: string; ANTHROPIC_SMALL_FAST_MODEL?: string } }) : null;
    const extra = [j?.env?.ANTHROPIC_MODEL, j?.env?.ANTHROPIC_SMALL_FAST_MODEL, j?.model].filter((x): x is string => !!x && !["opus", "sonnet", "haiku", "fable"].includes(x));
    for (const id of [...new Set(extra)]) out.unshift({ id, name: id, note: "来自本机配置" });
  } catch {
    /* 配置不可读时只给别名 */
  }
  return out;
}

const verifyCache = new Map<string, { at: number; data: Record<string, { ok: boolean; note: string }> }>();

/**
 * 逐个验证模型是否真的可用。目前只有 pi 提供这样的命令：
 *   pi auth check --provider <provider> --model <model>  → 输出 ready 或具体错误（例如 model_not_found）
 * 其它底座没有对等命令，返回 null 表示「未知」，不要当成失败。
 */
export async function verifyRuntimeModels(id: string): Promise<Record<string, { ok: boolean; note: string }> | null> {
  if (id !== "pi") return null;
  const hit = verifyCache.get(id);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.data;
  const list = await detectRuntimeModels(id);
  const queue = [...list.models];
  const out: Record<string, { ok: boolean; note: string }> = {};
  await Promise.all(Array.from({ length: 4 }, async () => {
    for (;;) {
      const m = queue.shift();
      if (!m) return;
      const at = m.id.indexOf("/");
      if (at < 0) continue;
      const raw = await exec("pi", ["auth", "check", "--provider", m.id.slice(0, at), "--model", m.id.slice(at + 1)], 25_000);
      out[m.id] = parsePiAuthCheck(raw);
    }
  }));
  verifyCache.set(id, { at: Date.now(), data: out });
  return out;
}

const modelCache = new Map<string, { at: number; data: RuntimeModels }>();

/** 清空所有运行底座相关的缓存：重新加载配置或升级 CLI 后调用 */
export function resetRuntimeCaches() {
  cache = null;
  shellCache.clear();
  modelCache.clear();
  verifyCache.clear();
}

export async function detectRuntimeModels(id: string, opts: { force?: boolean } = {}): Promise<RuntimeModels> {
  const hit = modelCache.get(id);
  if (!opts.force && hit && Date.now() - hit.at < 5 * 60_000) return hit.data;
  const home = join(homedir(), CONFIG_DIRS[id] ?? "");
  let models: RuntimeModel[] = [];
  let source = "";
  if (id === "codex") {
    const raw = await exec("codex", ["debug", "models"], 20_000);
    if (raw) { try { models = parseCodexModels(raw); source = "codex debug models"; } catch { source = "codex 输出无法解析"; } }
    else source = "无法运行 codex debug models";
  } else if (id === "pi") {
    // 优先用 pi 自己列出的可用模型（含已登录供应商的内置目录）；拿不到时退回 models.json
    const raw = await exec("pi", ["--list-models"], 30_000);
    if (raw) models = parsePiListModels(raw);
    if (models.length) source = "pi --list-models";
    else {
      try {
        models = parsePiModels(readFileSync(join(home, "agent", "models.json"), "utf8"));
        source = "~/.pi/agent/models.json";
      } catch { source = "没有读到 pi 的模型配置"; }
    }
  } else if (id === "claude-code") {
    let json: string | null = null;
    try { json = readFileSync(join(home, "settings.json"), "utf8"); } catch { /* 无配置 */ }
    models = parseClaudeModels(json);
    source = "别名 + 本机配置（实际可用模型取决于登录账号）";
  } else {
    source = "该底座暂不支持模型检测";
  }
  const data: RuntimeModels = { models, source, detectedAt: new Date().toISOString() };
  modelCache.set(id, { at: Date.now(), data });
  return data;
}
