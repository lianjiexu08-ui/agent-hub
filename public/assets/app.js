const $ = (s) => document.querySelector(s);
/** 安全构建 DOM：字符串子节点一律作为文本 */
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className = v;
    else el.setAttribute(k, v);
  }
  for (const c of children.flat(Infinity)) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}
/** 替换子节点：与 h() 一样深度展开数组、忽略 null/false，字符串作为文本 */
function fill(el, ...children) {
  el.replaceChildren(...children.flat(Infinity).filter((c) => c != null && c !== false).map((c) => (c instanceof Node ? c : String(c))));
  return el;
}
const STATUS = { pending: "等待", running: "运行中", completed: "完成", failed: "失败", cancelled: "已取消" };
/** 键值网格：每个单元格都包一层元素，避免文本节点合并 */
const kv = (pairs, attrs = {}) => h("div", { class: "kv", ...attrs }, pairs.map((x) => (x instanceof Node ? x : h("span", {}, x))));
const badge = (s) => h("span", { class: `badge s-${s}` }, STATUS[s] ?? s);
const ago = (iso) => {
  const s = (Date.now() - new Date(iso)) / 1000;
  return s < 60 ? `${Math.floor(s)} 秒前` : s < 3600 ? `${Math.floor(s / 60)} 分钟前` : s < 86400 ? `${Math.floor(s / 3600)} 小时前` : new Date(iso).toLocaleString();
};
const dur = (t) => {
  const s = Math.round((new Date(t.updatedAt) - new Date(t.createdAt)) / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${s % 60}s`;
};
const short = (s, n = 80) => (s.length > n ? s.slice(0, n) + "…" : s);
const fmtTok = (n) => (n >= 1000 ? (n / 1000).toFixed(1) + "k" : String(n));

// ---------- 登录状态 ----------
// 访问控制由服务端用 HttpOnly Cookie 维护；前端只判断是否已登录并渲染登录页。
let session = { checked: false, authenticated: true, loginEnabled: false, user: null };
async function checkSession() {
  try {
    const res = await fetch("/api/session", { cache: "no-store" });
    if (res.ok) session = { checked: true, ...(await res.json()) };
  } catch {
    session = { checked: true, authenticated: false, loginEnabled: true, user: null };
  }
  return session;
}
async function api(path, opts = {}) {
  const res = await fetch(path, { ...opts, headers: { "content-type": "application/json", ...(opts.headers || {}) } });
  if (res.status === 401) {
    showLogin("登录已过期，请重新登录");
    throw new Error("unauthorized");
  }
  if (res.status === 204) return null;
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}
function updateAuthButton() {
  const b = $("#tokenBtn");
  if (!b) return;
  b.textContent = session.loginEnabled ? (session.authenticated ? "退出" : "登录") : "";
  b.style.display = session.loginEnabled ? "" : "none";
}
/** 登录页：左右分栏。左侧讲清楚产品做什么（五段研发流程），右侧是克制的登录表单 */
const AUTH_MARK = '<svg viewBox="0 0 24 24" class="auth-logo" aria-hidden="true" focusable="false">'
  + '<g fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round">'
  + '<path d="M12 8.8V4.2"/><path d="M9.4 13.3 5.3 16.6"/><path d="M14.6 13.3l4.1 3.3"/></g>'
  + '<circle cx="12" cy="12" r="3.2" fill="currentColor"/>'
  + '<g fill="currentColor"><circle cx="12" cy="3.4" r="1.5"/><circle cx="4.4" cy="17.6" r="1.5"/><circle cx="19.6" cy="17.6" r="1.5"/></g>'
  + '</svg>';

/** 与任务中心的生命周期一致：理解 → 设计 → 开发 → 测试 → 评审 */
const AUTH_STAGES = [
  ["01", "需求理解", "澄清边界与验收标准"],
  ["02", "方案设计", "拆任务、定接口、排优先级"],
  ["03", "并行开发", "每个任务独立工作区"],
  ["04", "自动验收", "跑测试，不通过就退回重做"],
  ["05", "评审合并", "人工把关后合并到主干"],
];

const authField = (label, el, forId) => h("div", { class: "auth-field" },
  h("label", { class: "auth-label", for: forId }, label), el);

function showLogin(message = "") {
  if ($("#loginScreen")) {
    const el = $("#loginError");
    if (el) el.textContent = message;
    return;
  }
  const user = h("input", { id: "loginUser", class: "auth-input-el", "aria-label": "账号", autocomplete: "username", spellcheck: "false" });
  user.value = session.user || "admin";
  const pass = h("input", { id: "loginPass", class: "auth-input-el", type: "password", "aria-label": "密码", autocomplete: "current-password" });
  const reveal = h("button", { type: "button", class: "auth-reveal", title: "显示密码", "aria-label": "显示密码", onclick: () => {
    const show = pass.type === "password";
    pass.type = show ? "text" : "password";
    reveal.textContent = show ? "隐藏" : "显示";
    reveal.title = show ? "隐藏密码" : "显示密码";
    pass.focus();
  } }, "显示");
  const errEl = h("div", { id: "loginError", class: "auth-error", role: "alert" }, message);
  const btn = h("button", { class: "auth-submit login-submit", type: "submit" }, h("span", {}, "登录"), h("span", { class: "auth-spin", "aria-hidden": "true" }));

  const form = h("form", { class: "auth-form", onsubmit: async (e) => {
    e.preventDefault();
    btn.disabled = true; btn.classList.add("busy");
    errEl.textContent = "";
    try {
      const res = await fetch("/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ user: user.value.trim(), password: pass.value }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "登录失败");
      session = { checked: true, authenticated: true, loginEnabled: true, user: data.user, needsSetup: !!data.needsSetup };
      $("#loginScreen")?.remove();
      updateAuthButton();
      try { await refreshState(); } catch { /* 下面会重试 */ }
      connect();
      initIssues();
      await loadAll();
      renderAssigneeFilter();
      renderBoard();
      await route();
      landing();
    } catch (err) {
      errEl.textContent = err.message;
      btn.disabled = false; btn.classList.remove("busy");
      pass.focus(); pass.select();
    }
  } },
    authField("账号", h("div", { class: "auth-control" }, user), "loginUser"),
    authField("密码", h("div", { class: "auth-control" }, pass, reveal), "loginPass"),
    errEl,
    btn);

  const brand = h("div", { class: "auth-brand" });
  brand.innerHTML = AUTH_MARK + '<span class="auth-wordmark">Agent Hub</span>';
  const pitch = h("div", { class: "auth-pitch" },
    h("h2", { class: "auth-headline" },
      h("span", {}, "把研发流程交给"),
      h("span", {}, "一支智能体团队")),
    h("p", { class: "auth-lede" }, "需求拆解、并行开发、自动验收到评审合并，全部在同一个工作台上流转；每一步的产物与记录都可追溯。"),
    h("ul", { class: "auth-stages" }, ...AUTH_STAGES.map(([n, name, note]) => h("li", {},
      h("span", { class: "auth-stage-idx" }, n),
      h("span", { class: "auth-stage-name" }, name),
      h("span", { class: "auth-stage-note" }, note)))));
  const aside = h("aside", { class: "auth-aside" }, brand, pitch,
    h("p", { class: "auth-aside-foot" }, h("span", { class: "auth-dot", "aria-hidden": "true" }), "本地部署 · 数据与密钥不出内网"));

  const main = h("main", { class: "auth-main" },
    h("div", { class: "auth-panel" },
      h("h1", { class: "auth-title" }, "登录"),
      h("p", { class: "auth-sub" }, "使用管理员账号继续"),
      form,
      h("p", { class: "auth-note" }, "连续输错 5 次将锁定 60 秒")),
    h("footer", { class: "auth-foot" }, h("span", {}, "Agent Hub"), h("span", {}, "v1.0.0")));

  document.body.append(h("div", { id: "loginScreen", class: "auth" }, aside, main));
  setTimeout(() => (user.value ? pass : user).focus());
}

/** 首次登录后弹窗：把部署时的初始密码换成自己的账号密码 */
function setupField(label, el, forId) {
  return h("div", { class: "setup-field" }, h("label", { class: "setup-label", for: forId }, label), el);
}

function showSetupModal() {
  if ($("#setupModal")) return;
  const user = h("input", { id: "setupUser", class: "setup-input", "aria-label": "账号", autocomplete: "username", spellcheck: "false", maxlength: "32" });
  user.value = session.user || "admin";
  const pass = h("input", { id: "setupPass", class: "setup-input", type: "password", "aria-label": "新密码", autocomplete: "new-password" });
  const pass2 = h("input", { id: "setupPass2", class: "setup-input", type: "password", "aria-label": "确认密码", autocomplete: "new-password" });
  const err = h("div", { class: "setup-error", role: "alert" });
  const save = h("button", { class: "setup-save", type: "submit" }, "保存并继续");

  const skip = () => {
    try { sessionStorage.setItem("hub_setup_skipped", "1"); } catch { /* 隐私模式 */ }
    $("#setupModal")?.remove();
    if (!modelsReady()) gotoModelSettings();
  };

  const form = h("form", { class: "setup-form", onsubmit: async (e) => {
    e.preventDefault();
    err.textContent = "";
    const name = user.value.trim();
    if (!name) { err.textContent = "账号不能为空"; user.focus(); return; }
    if (pass.value.length < 6) { err.textContent = "密码至少 6 位"; pass.focus(); pass.select(); return; }
    if (pass.value !== pass2.value) { err.textContent = "两次输入的密码不一致"; pass2.focus(); pass2.select(); return; }
    save.disabled = true;
    try {
      const res = await fetch("/api/setup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ user: name, password: pass.value }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "保存失败");
      session.needsSetup = false;
      session.user = data.user;
      $("#setupModal")?.remove();
      toast("账号与密码已更新，下次请用新密码登录", "review");
      if (!modelsReady()) gotoModelSettings();
    } catch (e2) {
      err.textContent = e2.message;
      save.disabled = false;
    }
  } },
    setupField("账号", user, "setupUser"),
    setupField("新密码", pass, "setupPass"),
    setupField("确认密码", pass2, "setupPass2"),
    err,
    h("div", { class: "setup-actions" },
      h("button", { type: "button", class: "setup-later", onclick: skip }, "稍后再说"),
      save));

  document.body.append(h("div", { id: "setupModal", class: "setup-overlay", role: "dialog", "aria-modal": "true", "aria-labelledby": "setupTitle",
    onkeydown: (e) => { if (e.key === "Escape") skip(); } },
    h("div", { class: "setup-card" },
      h("h2", { id: "setupTitle", class: "setup-title" }, "设置你的账号与密码"),
      h("p", { class: "setup-sub" }, "当前使用的是部署时的初始密码。首次登录请换成自己的账号和密码，保存后初始密码立即失效。"),
      form,
      h("p", { class: "setup-note" }, "密码至少 6 位。凭证以 scrypt 哈希保存在服务器的 data/auth.json，忘记时删除该文件即可退回初始密码。"))));
  setTimeout(() => pass.focus());
}

/** 给设置页的某个区块加锚点，便于直接滚过去 */
const withId = (el, id = "settings-models") => { el.id = id; return el; };

/** 是否已有可用的模型连接：配置过 API Key 或用本机登录并验证通过 */
function modelsReady() {
  const st = settings.get();
  const hasProvider = (st?.providers ?? []).some((p) => (p.method === "key" || p.method === "profile") && p.verifiedAt);
  const hasRuntime = (S.runtimes?.runtimes ?? []).some((r) => r.id !== "builtin" && r.installed);
  return hasProvider || hasRuntime;
}

/** 还没有可用的模型连接时，直接落到「设置 → 模型」，并滚到模型区块 */
function gotoModelSettings() {
  showView("settings");
  requestAnimationFrame(() => $("#settings-models")?.scrollIntoView({ block: "start", behavior: "smooth" }));
}

/** 进入界面后的落地页：先初始化账号，再看模型连接是否已配置 */
function landing() {
  // 地址栏里已经有明确的视图（用户刷新前就在别的页面）就不要抢回来
  if (/view=|issue=|task=/.test(location.hash)) return;
  if (session.needsSetup) {
    let skipped = false;
    try { skipped = sessionStorage.getItem("hub_setup_skipped") === "1"; } catch { /* 隐私模式 */ }
    if (!skipped) { showSetupModal(); return; }
  }
  if (!modelsReady()) gotoModelSettings();
}

async function logout() {
  try { await fetch("/api/logout", { method: "POST" }); } catch { /* 忽略 */ }
  try { sessionStorage.removeItem("hub_setup_skipped"); } catch { /* 隐私模式 */ }
  session = { checked: true, authenticated: false, loginEnabled: true, user: null };
  location.reload();
}

$("#tokenBtn").onclick = () => (session.authenticated ? logout() : showLogin());


// ---------- 状态 ----------
const state = { roots: [], selRoot: null, selNode: null, tree: null, topics: [], selTopic: null, agents: [] };

// ---------- 视图切换 ----------
document.querySelectorAll("nav button").forEach((b) => (b.onclick = () => showView(b.dataset.view)));

// ---------- 任务列表 ----------
async function loadRoots() {
  const st = $("#statusFilter").value;
  state.roots = await api(`/tasks?roots=1&limit=100${st ? "&status=" + st : ""}`);
  renderRoots();
}
/** 这个智能体实际用什么在跑：内置循环报模型名，CLI 底座报底座名与指定的模型 */
function agentRuntimeLabel(name) {
  const a = (S.agents ?? []).find((x) => x.name === name);
  if (!a) return "";
  const rt = a.runtime ?? "builtin";
  if (rt === "builtin") return `内置 · ${modelShort(a.model)}`;
  return `${rtDef(rt).short}${a.cliModel ? ` · ${modelShort(a.cliModel)}` : " · 默认模型"}`;
}
function renderRoots() {
  const list = $("#rootList");
  fill(list, 
    ...(state.roots.length ? state.roots.map((t) =>
      h("div", { class: "task-item" + (t.id === state.selRoot ? " sel" : ""), onclick: () => selectRoot(t.id) },
        h("div", { class: "row" }, badge(t.status), h("b", {}, t.agent),
          agentRuntimeLabel(t.agent) ? h("span", { class: "model-chip", title: "执行这次调用使用的模型与底座" }, agentRuntimeLabel(t.agent)) : null,
          t.source !== "api" ? h("span", { class: "tag" }, t.source) : null,
          h("span", { class: "muted", style: "margin-left:auto;font-size:12px" }, ago(t.createdAt))),
        h("div", { class: "input" }, t.input))) : [h("div", { class: "empty" }, "暂无任务")]),
  );
}
$("#statusFilter").onchange = loadRoots;

async function selectRoot(id, nodeId = id) {
  state.selRoot = id;
  state.selNode = nodeId;
  history.replaceState(null, "", "#task=" + id);
  renderRoots();
  await loadTree();
  await loadDetail();
}

// ---------- 调用树 ----------
async function loadTree() {
  if (!state.selRoot) return;
  state.tree = await api(`/tasks/${state.selRoot}/tree`);
  renderTree();
}
function flatten(n, out = []) { out.push(n); n.children.forEach((c) => flatten(c, out)); return out; }
function renderTree() {
  const t = state.tree;
  if (!t) return;
  const all = flatten(t);
  const count = (s) => all.filter((x) => x.status === s).length;
  const tokIn = all.reduce((a, x) => a + x.inputTokens, 0), tokOut = all.reduce((a, x) => a + x.outputTokens, 0);
  const stat = (k, v, cls = "") => h("div", { class: "stat" }, h("div", { class: "k" }, k), h("div", { class: "v " + cls }, v));
  fill($("#treeHeader"), 
    h("div", { class: "hud" },
      stat("状态", STATUS[t.status], "s-" + t.status),
      stat("任务数", all.length),
      stat("进行中", count("running") + count("pending")),
      stat("失败", count("failed"), count("failed") ? "s-failed" : ""),
      stat("深度", Math.max(...all.map((x) => x.depth))),
      stat("输入 tokens", fmtTok(tokIn)),
      stat("输出 tokens", fmtTok(tokOut))),
    ...(["pending", "running"].includes(t.status)
      ? [h("div", { class: "hud-actions", style: "margin:-4px 0 12px" }, h("button", { class: "danger", onclick: () => cancel(t.id) }, "终止整棵树"))]
      : []));
  const node = (n) => h("li", {},
    h("div", { class: "node " + n.status + (n.id === state.selNode ? " sel" : ""), onclick: () => { state.selNode = n.id; renderTree(); loadDetail(); } },
      badge(n.status), h("span", { class: "agent" }, n.agent),
      h("span", { class: "snippet" }, n.status === "completed" && n.result ? "→ " + short(n.result, 120) : n.error ? "✕ " + short(n.error, 120) : short(n.input, 120)),
      h("span", { class: "tag" }, `${n.turns} 轮 · ${dur(n)}`)),
    n.children.length ? h("ul", {}, n.children.map(node)) : null);
  fill($("#tree"), h("ul", {}, node(t)));
}

// ---------- 详情 ----------
async function loadDetail() {
  if (!state.selNode) return;
  const t = await api(`/tasks/${state.selNode}?messages=1`);
  const el = $("#detail");
  fill(el, 
    h("div", { class: "detail-head" }, badge(t.status), h("b", {}, t.agent),
      ["pending", "running"].includes(t.status) ? h("button", { class: "danger", style: "margin-left:auto", onclick: () => cancel(t.id) }, "取消") : null),
    kv(["ID", h("code", {}, t.id), "来源", `${t.source} · 深度 ${t.depth} · 总线跳数 ${t.hops}`,
      "用时", `${dur(t)} · ${t.turns} 轮`, "Tokens", `入 ${fmtTok(t.inputTokens)} / 出 ${fmtTok(t.outputTokens)}`,
      "创建", new Date(t.createdAt).toLocaleString()], { style: "margin-top:8px" }),
    receiptBlock(t.receipt),
    h("div", { class: "section-title" }, "输入"), h("pre", {}, t.input),
    h("div", {}, t.result ? [h("div", { class: "section-title" }, "结果"), h("pre", {}, t.result)] : null),
    h("div", {}, t.error ? [h("div", { class: "section-title s-failed" }, "错误"), h("pre", {}, t.error)] : null),
    h("div", { class: "section-title" }, "对话记录"),
    renderTranscript(t.messages || []),
  );
}
/** 上下文回执：这次运行把什么交给了智能体、以什么方式 */
function receiptBlock(r) {
  if (!r) return h("div", { class: "muted", style: "font-size:12px;margin-top:6px" }, "没有这次运行的上下文回执（旧记录或未接入的底座）");
  const kb = (n) => (n ? `${(n / 1024).toFixed(1)} KB` : "—");
  const DELIVERY = { "system-param": "系统提示词参数", "prompt-inline": "并入输入", "native-file": "原生技能文件", "catalog-tool": "工具按需加载", embedded: "内嵌在输入中", none: "未投递" };
  return h("details", { class: "case", style: "margin-top:12px" },
    h("summary", {}, h("b", {}, "上下文回执"), h("span", { class: "muted", style: "font-size:12px" }, `${r.runtime} · ${r.agent} · ${r.model}`)),
    h("div", { class: "steps-list", style: "padding-top:6px" },
      kv(["角色提示词", `${kb(r.systemBytes)} · ${DELIVERY[r.sources?.find((x) => x.kind === "角色提示词")?.delivery] ?? "—"}`,
          "任务输入", kb(r.promptBytes),
          r.workdir ? "工作目录" : null, r.workdir ? h("code", { class: "muted", style: "font-size:11.5px" }, r.workdir) : null,
          "工具", `${r.tools?.length ?? 0} 个：${(r.tools ?? []).slice(0, 8).join("、")}${(r.tools?.length ?? 0) > 8 ? "…" : ""}`],
        { style: "margin-bottom:8px" }),
      h("table", { class: "lc-table" },
        h("tr", {}, h("th", {}, "内容"), h("th", {}, "投递方式"), h("th", {}, "大小"), h("th", {}, "说明")),
        (r.sources ?? []).map((x) => h("tr", { style: "cursor:default" },
          h("td", {}, x.kind), h("td", {}, DELIVERY[x.delivery] ?? x.delivery), h("td", {}, kb(x.bytes)), h("td", { class: "muted", style: "font-size:12px" }, x.detail ?? "")))),
      h("div", { class: "muted", style: "font-size:11.5px;margin-top:6px" }, "只记录投递方式与大小，不保存提示词和技能正文。")));
}
function toolResultText(c) {
  if (typeof c === "string") return c;
  return (c || []).map((b) => (b.type === "text" ? b.text : `[${b.type}]`)).join("\n");
}
function renderTranscript(messages) {
  if (messages.length <= 1) return h("div", { class: "muted" }, "暂无");
  return h("div", {}, messages.slice(1).map((m) => {
    const blocks = typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content;
    const items = blocks.map((b) => {
      switch (b.type) {
        case "text": return b.text.trim() ? h("div", { class: "text" }, b.text) : null;
        case "thinking": return b.thinking ? h("details", {}, h("summary", { class: "muted" }, "思考"), h("div", { class: "text muted" }, b.thinking)) : null;
        case "tool_use": case "server_tool_use":
          return h("div", { class: "tool" }, h("b", {}, "⚙ " + b.name), h("pre", {}, JSON.stringify(b.input, null, 2)));
        case "tool_result":
          return h("details", { class: "tool" + (b.is_error ? " err" : "") }, h("summary", {}, h("b", {}, b.is_error ? "✕ 工具错误" : "↩ 工具结果"), " ", h("span", { class: "muted" }, short(toolResultText(b.content), 80))), h("pre", {}, toolResultText(b.content)));
        case "fallback": return h("div", { class: "muted" }, `↪ ${b.from?.model} 拒答，已由 ${b.to?.model} 接续`);
        default: return b.type.endsWith("_tool_result") ? h("div", { class: "tool muted" }, `↩ ${b.type}`) : null;
      }
    }).filter(Boolean);
    if (!items.length) return null;
    return h("div", { class: "msg " + m.role }, h("div", { class: "role" }, m.role === "assistant" ? "智能体" : "输入 / 工具结果"), items);
  }));
}
async function cancel(id) {
  if (!confirm("确定取消该任务及其所有子任务？")) return;
  await api(`/tasks/${id}/cancel`, { method: "POST" });
  loadTree(); loadDetail(); loadRoots();
}

// ---------- 新任务 ----------
async function loadAgents() {
  state.agents = await api("/agents");
  const sel = $("#newAgent");
  if (!sel) return;
  const prev = sel.value;
  fill(sel, ...state.agents.map((a) => h("option", { value: a.name }, `${a.name} — ${short(a.description, 30)}`)));
  if (prev) sel.value = prev;
}

// ---------- 总线 ----------
async function loadTopics() {
  state.topics = await api("/topics");
  if (!state.selTopic && state.topics.length) state.selTopic = state.topics[0].topic;
  fill($("#topicList"), ...(state.topics.length ? state.topics.map((t) =>
    h("div", { class: "task-item" + (t.topic === state.selTopic ? " sel" : ""), onclick: () => { state.selTopic = t.topic; loadTopics(); } },
      h("div", { class: "row" }, h("b", {}, t.topic), h("span", { class: "tag", style: "margin-left:auto" }, t.count)))) : [h("div", { class: "empty" }, "暂无主题")]));
  if (state.selTopic) {
    $("#pubTopic").value ||= state.selTopic;
    const msgs = await api(`/topics/${encodeURIComponent(state.selTopic)}/messages?limit=200`);
    fill($("#busMessages"), ...msgs.reverse().map((m) => h("div", { class: "bus-msg" },
      h("div", { class: "row" }, h("b", {}, m.sender), h("span", { class: "tag" }, "#" + m.id), m.hops ? h("span", { class: "tag" }, `跳数 ${m.hops}`) : null,
        h("span", { class: "muted", style: "margin-left:auto;font-size:12px" }, ago(m.createdAt))),
      h("div", { class: "text" }, m.content))));
  }
}
$("#pubBtn").onclick = async () => {
  const topic = $("#pubTopic").value.trim(), content = $("#pubContent").value.trim();
  if (!topic || !content) return;
  await api(`/topics/${encodeURIComponent(topic)}/messages`, { method: "POST", body: JSON.stringify({ content, sender: "panel" }) });
  $("#pubContent").value = "";
  state.selTopic = topic;
  loadTopics();
};

// ---------- 配置 ----------
// ---------- 实时更新 ----------
let es, timers = {};
const debounce = (k, fn, ms = 250) => { clearTimeout(timers[k]); timers[k] = setTimeout(fn, ms); };
function connect() {
  es?.close();
  es = new EventSource("/events");
  es.onopen = () => { $("#dot").classList.add("on"); $("#connText").textContent = "已连接"; };
  es.onerror = () => { $("#dot").classList.remove("on"); $("#connText").textContent = "重新连接中…"; };
  es.addEventListener("task", (ev) => {
    const { task } = JSON.parse(ev.data);
    if (!task.parentId) debounce("roots", loadRoots);
    if (task.rootId === state.selRoot) debounce("tree", loadTree);
    if (task.id === state.selNode) debounce("detail", loadDetail, 400);
    if (viewActive("center")) debounce("center", renderCenter, 500);
  });
  es.addEventListener("bus", () => { if ($("#view-bus").classList.contains("active")) debounce("bus", loadTopics); });
  // 工作项、测试、自动化等状态变化：重新拉取快照；关键事件给出提示
  es.addEventListener("work", (ev) => {
    const e = JSON.parse(ev.data);
    if (e.kind === "run_finished") {
      if (e.status === "completed") toast(`✓ ${e.key} 已交付`, "review");
      else if (e.status === "failed") toast(`✕ ${e.key} 运行失败`, "err");
      else if (e.status === "cancelled") toast(`■ ${e.key} 已停止`);
    }
    if (e.kind === "phase" && e.result === "fail") toast(`${e.key} ${e.phase === "test" ? "测试未通过，回到执行修复" : "评审未通过，开始新一轮"}`, "err");
    throttleState();
  });
  es.addEventListener("task", (ev) => { const { task } = JSON.parse(ev.data); if (task.issueId != null || task.source === "qa") throttleState(); });
}

async function loadAll() {
  try { await Promise.all([loadAgents(), loadRoots()]); } catch (e) { console.error(e); }
  // 地址栏的恢复统一交给 route()：这里再跑一次会把子选择（studio、tab）覆盖成默认值
}
// ======================= 工作项 =======================
const IS = {
  statuses: [
    { id: "backlog", label: "待规划", icon: "◌" },
    { id: "todo", label: "待办", icon: "○" },
    { id: "in_progress", label: "进行中", icon: "◐" },
    { id: "in_review", label: "待审核", icon: "◉" },
    { id: "done", label: "完成", icon: "●" },
    { id: "canceled", label: "已取消", icon: "⊘" },
  ],
  priorities: ["无优先级", "紧急", "高", "中", "低"],
};
/** 进行中工作项的生命周期：测试不通过回到「执行」修复；评审不通过重新理解需求（新一轮）；最多 3 轮 */
const PHASES = [
  { id: "understand", label: "需求理解" },
  { id: "plan", label: "计划" },
  { id: "do", label: "执行" },
  { id: "test", label: "测试" },
  { id: "review", label: "评审" },
];
const MAX_CYCLES = 3;
const MAX_FIXES = 3; // 同一轮内测试不通过最多修复次数，超过则视为本轮失败、重新理解需求
const phaseLabel = (id) => PHASES.find((p) => p.id === id)?.label ?? id;
const statusOf = (id) => IS.statuses.find((s) => s.id === id) ?? { id, label: id, icon: "?" };
const ME = "我";
/** 0 无 · 1 紧急 · 2 高 · 3 中 · 4 低；调度与展示统一按 rank 升序 */
const prioOrder = (p) => (p >= 1 && p <= 4 ? p : 5);

/**
 * 模拟后端：规则与后端设计一致——
 * 有负责人且进入「待办」即自动执行 → 进行中；完成后结果写成评论 → 待审核；失败/停止 → 退回待办。
 * 接入真实后端时，把 issuesApi 换成调用 /issues 接口的实现即可（方法签名保持一致）。
 */
// ======================= 数据层：后端状态缓存 + RPC =======================
/** S 是 GET /api/state 的快照；修改通过 RPC，完成后重新拉取并通知各视图刷新 */
let S = { projects: [], syncLogs: {}, issues: [], agents: [], skills: [], settings: null, qa: { runs: [], settings: {}, browsers: [], browserReady: false, engine: null, deveyeInstalled: false }, auto: { rules: {}, jobs: [], log: [], state: {} }, notifications: [], knowledge: [], costs: [], attention: [], health: [], butler: [], tools: [], mcpServers: [], runtimes: null, simulate: false };
const simulateMode = () => S?.simulate === true;
const dataListeners = new Set();
async function rpc(method, ...args) {
  const r = await api("/api/rpc", { method: "POST", body: JSON.stringify({ method, args }) });
  return r?.result;
}
let refreshing = null, refreshAgain = false;
/**
 * 事件驱动的整体刷新：节流到最多每 2.5 秒一次（期间的事件合并到下一次）。
 * 多个智能体同时在跑时进度事件几乎不断，用防抖会变成一个刷新接一个刷新，把服务器压满。
 */
let stateTimer = null, stateLast = 0;
function throttleState() {
  if (stateTimer) return;
  const wait = Math.max(0, 2500 - (Date.now() - stateLast));
  stateTimer = setTimeout(() => { stateTimer = null; stateLast = Date.now(); refreshState(); }, wait);
}
function refreshState() {
  if (refreshing) { refreshAgain = true; return refreshing; }
  refreshing = (async () => {
    try { S = await api("/api/state"); }
    finally { refreshing = null; }
    dataListeners.forEach((fn) => { try { fn({ type: "refresh" }); } catch (e) { console.error(e); } });
    if (refreshAgain) { refreshAgain = false; refreshState(); }
  })();
  return refreshing;
}
async function act(method, ...args) {
  const r = await rpc(method, ...args);
  await refreshState();
  return r;
}
const demoFlag = (style = "margin-left:auto") => (S.simulate ? h("span", { class: "proto-flag", style, title: "HUB_SIMULATE=1：模型回复由脚本生成，其余均为真实的服务端逻辑" }, "演示模式") : null);

const issuesApi = {
  onChange: (fn) => dataListeners.add(fn),
  projects: () => S.projects,
  project: (id) => S.projects.find((p) => p.id === id) ?? null,
  syncLog: (id) => S.syncLogs[id] ?? [],
  leadActivity: (id) => (S.projects.find((p) => p.id === id)?.lead.activity ?? []).slice().reverse(),
  attention: (pid) => S.attention.filter((a) => !pid || a.issue.projectId === pid),
  health: () => S.health,
  costs: () => S.costs,
  async list(pid) { return S.issues.filter((i) => !pid || i.projectId === pid); },
  activity: (limit, pid) => rpc("work.activity", limit, pid),
  detail: (ref) => rpc("work.detail", ref),
  create: (input) => act("work.create", input),
  update: (ref, patch) => act("work.update", ref, patch),
  comment: (ref, body) => act("work.comment", ref, body),
  run: (ref) => act("work.run", ref),
  stop: (ref) => act("work.stop", ref),
  remove: (ref) => act("work.remove", ref),
  confirmRequirement: (ref, answer) => act("work.confirmRequirement", ref, answer),
  /** 合并 PR：CI 未通过时服务端会拒绝并说明，人确认是 CI 自身的问题后可以「仍然合并」 */
  mergePR: async (ref) => {
    try { return await act("work.mergePR", ref); }
    catch (e) {
      if (!/CI 未通过/.test(e.message) || !confirm(`${e.message}\n\n确定仍然合并吗？`)) throw e;
      return act("work.mergePR", ref, true);
    }
  },
  rollback: (ref) => act("work.rollback", ref),
  pushToGithub: (ref) => act("work.pushToGithub", ref),
  saveProject: (input, orig) => act("work.saveProject", input, orig),
  deleteProject: (id) => act("work.deleteProject", id),
  connectRepo: (id, full) => act("work.connectRepo", id, full),
  disconnectRepo: (id) => act("work.disconnectRepo", id),
  githubOwners: () => act("work.githubOwners"),
  createRepo: (id, input) => act("work.createRepo", id, input),
  sync: (id) => act("work.sync", id),
  setLead: (id, patch) => act("work.setLead", id, patch),
  connectLinear: (id, teamId) => act("work.connectLinear", id, teamId),
  disconnectLinear: (id) => act("work.disconnectLinear", id),
  syncLinear: (id) => act("work.syncLinear", id),
  linearMembers: (id) => act("work.linearMembers", id),
  linearMe: () => act("work.linearMe"),
  pushToLinear: (ref) => act("work.pushToLinear", ref),
};


// ---------- 小部件 ----------
const ui = { view: "board", q: "", assignee: "", showCanceled: false, openKey: null, feedbackOpen: false, pendingDrawer: false, draft: "", feedbackDraft: "" };

/** 看板筛选条件存在本机：刷新、换视图回来都保持原样（按浏览器分别保存，不进服务端） */
const UI_PREFS_KEY = "hub_ui_prefs";
function saveUiPrefs() {
  try { localStorage.setItem(UI_PREFS_KEY, JSON.stringify({ assignee: ui.assignee, showCanceled: ui.showCanceled })); } catch { /* 隐私模式 */ }
}
function loadUiPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem(UI_PREFS_KEY) || "{}");
    if (typeof p.assignee === "string") ui.assignee = p.assignee;
    if (typeof p.showCanceled === "boolean") ui.showCanceled = p.showCanceled;
  } catch { /* 解析失败就用默认值 */ }
  const box = $("#showCanceled");
  if (box) box.checked = ui.showCanceled;
}
const hasAgent = (n) => (S.agents ?? []).some((a) => a.name === n);
const agentNames = () => (studio.agents().length ? studio.agents() : state.agents.length ? state.agents : [{ name: "orchestrator" }, { name: "researcher" }, { name: "reviewer" }, { name: "writer" }]).map((a) => a.name);
const hue = (s) => [...s].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 360, 7);
const avatar = (name) => name
  ? h("span", { class: "avatar", title: name, style: `--hue:${hue(name)}` }, name[0].toUpperCase())
  : h("span", { class: "avatar none", title: "未指派" }, "—");
const prio = (p) => p === 1 ? h("span", { class: "prio p1", title: "紧急" }, "!")
  : p === 0 ? h("span", { class: "prio p0", title: "无优先级" }, "···")
  : h("span", { class: "prio", title: IS.priorities[p] }, [1, 2, 3].map((n) => h("i", { class: n <= 5 - p ? "on" : "" })));
const sicon = (s) => h("span", { class: "sicon st-" + s, title: statusOf(s).label }, statusOf(s).icon);
function select(options, value, onchange, attrs = {}) {
  const el = h("select", { ...attrs, onchange: (e) => onchange(e.target.value) }, options.map(([v, l]) => h("option", { value: v }, l)));
  el.value = String(value ?? "");
  return el;
}
const statusOptions = () => IS.statuses.map((s) => [s.id, `${s.icon} ${s.label}`]);
const prioOptions = () => IS.priorities.map((l, i) => [i, l]);
const assigneeOptions = () => [["", "未指派"], ...agentNames().map((n) => [n, n])];
/**
 * 右下角提示。文字里提到了某张工作项（如 OPS-470），或显式传了 key，就可以点击直接打开它。
 * 鼠标停在上面时不自动消失。
 */
function toast(msg, kind = "", opts = {}) {
  const text = String(msg ?? "");
  const known = (k) => !!(S.issues ?? []).some((i) => i.key === k);
  const key = opts.key ?? (text.match(/\b[A-Z][A-Z0-9]{1,5}-\d+\b/g) ?? []).find(known) ?? null;
  const el = h("div", { class: "toast " + kind + (key ? " link" : ""), role: key ? "button" : null, tabindex: key ? "0" : null, title: key ? `点击打开 ${key}` : null,
    onclick: key ? () => { el.remove(); openIssue(key); } : null,
    onkeydown: key ? (e) => { if (e.key === "Enter") { el.remove(); openIssue(key); } } : null },
    text, key ? h("span", { class: "toast-go" }, "打开 →") : null);
  $("#toasts").append(el);
  while ($("#toasts").children.length > 3) $("#toasts").firstChild.remove();
  let left = key ? 7000 : 4200, t0 = Date.now();
  let timer = setTimeout(() => el.remove(), left);
  el.addEventListener("mouseenter", () => { clearTimeout(timer); left -= Date.now() - t0; });
  el.addEventListener("mouseleave", () => { t0 = Date.now(); timer = setTimeout(() => el.remove(), Math.max(1500, left)); });
}
const fail = (err) => toast(err.message || String(err), "err");

/** 去掉 Markdown 标记，用于一行摘要 */
const plainMd = (t) => String(t ?? "").replace(/\*\*|__|`/g, "").replace(/^#+\s*/gm, "");
/**
 * 生命周期按「轮」展示：后端的一轮里，测试不通过会回到执行再交付一次。界面上每次交付算一轮，
 * 五个阶段各一格：返工的那一轮里「理解」「计划」沿用上一轮，执行、测试、评审是这一轮自己的。
 * 重启 / 网络造成的中断不单列，记在所属那一轮上。
 */
function lifecycleRounds(d) {
  const out = [];
  for (const cy of [...new Set(d.phases.map((r) => r.cycle))].sort((a, b) => a - b)) {
    const recs = d.phases.filter((r) => r.cycle === cy);
    const head = (ph) => recs.filter((r) => r.phase === ph).at(-1);
    const parts = [];
    let cur = null;
    for (const r of recs) {
      if (r.phase !== "do" && r.phase !== "test") continue;
      if (r.phase === "do" && r.result === "cancelled") { if (cur) cur.interrupts++; continue; }
      if (r.phase === "do" && (!cur || cur.test)) { cur = { dos: [], test: null, interrupts: 0 }; parts.push(cur); }
      if (!cur) continue;
      if (r.phase === "do") cur.dos.push(r); else cur.test = r;
    }
    if (!parts.length) parts.push({ dos: [], test: null, interrupts: 0 });
    parts.forEach((pt, k) => {
      const last = k === parts.length - 1;
      const doRec = pt.dos.findLast((x) => x.result !== "cancelled") ?? pt.dos.at(-1);
      const cell = (ph, rec, inherit) => ({ phase: PHASES.find((p) => p.id === ph), rec, state: inherit ? "inherit" : rec ? rec.result : "pending" });
      const run = pt.test?.qaRun ? qa.run(pt.test.qaRun) : null;
      out.push({
        n: out.length + 1,
        why: k > 0 ? "测试未通过后返工" : out.length > 0 ? "评审未通过后重来" : "",
        interrupts: pt.interrupts,
        run,
        fails: run ? run.cases.filter((c) => c.status === "failed") : [],
        cells: [
          cell("understand", k === 0 ? head("understand") : null, k > 0),
          cell("plan", k === 0 ? head("plan") : null, k > 0),
          cell("do", doRec),
          cell("test", pt.test),
          cell("review", last ? head("review") : null),
        ],
      });
    });
  }
  return out;
}
/** 某一轮各阶段的状态：pass / fail / active / cancelled / pending */
function cycleCells(i, cycle) {
  return PHASES.map((p) => {
    const rec = i.phases.filter((r) => r.cycle === cycle && r.phase === p.id).at(-1);
    return { phase: p, rec, state: rec ? rec.result : "pending" };
  });
}
function miniSteps(i) {
  if (!i.phases.length || !["in_progress", "in_review"].includes(i.status)) return null;
  const cells = cycleCells(i, i.cycle);
  const cur = i.phase ? phaseLabel(i.phase) : i.status === "in_review" ? "评审通过" : "";
  return h("div", {},
    h("div", { class: "steps", title: cells.map((c) => `${c.phase.label}：${{ pass: "通过", fail: "未通过", active: "进行中", cancelled: "已停止", pending: "未开始" }[c.state]}`).join("\n") },
      cells.map((c) => h("i", { class: c.state }))),
    h("div", { class: "steps-label" }, i.phase ? h("b", {}, cur) : h("span", {}, cur), i.cycle > 1 ? h("span", {}, `第 ${i.cycle} 轮`) : null));
}
const CELL_TEXT = { pass: "通过", fail: "未通过", active: "进行中", cancelled: "已停止", blocked: "待确认", pending: "—", inherit: "沿用上一轮" };
const phaseCell = (c) => h("div", { class: "cell " + c.state, title: c.rec?.note || "" },
  h("span", { class: "st" }, CELL_TEXT[c.state]),
  c.state === "active" ? h("span", { class: "note" }, ago(c.rec.startedAt)) : c.rec?.note ? h("span", { class: "note" }, c.rec.note) : null);


// ---------- 运行中心 ----------
const viewActive = (v) => $("#view-" + v)?.classList.contains("active");
async function renderCenter() {
  if (!viewActive("center")) return;
  const [all, feed, liveTasks] = await Promise.all([
    issuesApi.list(), issuesApi.activity(25),
    api("/tasks?status=running&limit=200").catch(() => []),
  ]);
  const byPrio = (a, b) => prioOrder(a.priority) - prioOrder(b.priority) || b.updatedAt.localeCompare(a.updatedAt);
  const inProgress = all.filter((i) => i.status === "in_progress").sort(byPrio);
  const review = all.filter((i) => i.status === "in_review").sort(byPrio);
  const activeRuns = all.reduce((n, i) => n + i.activeRuns, 0);
  const retrying = inProgress.filter((i) => i.cycle > 1);
  const failed = all.filter((i) => i.status === "todo" && i.lastRun?.status === "failed");
  const phaseCount = (p) => inProgress.filter((i) => i.phase === p).length;
  const tile = (cls, k, v, d, onclick) => h("div", { class: "tile " + cls, style: onclick ? "cursor:pointer" : "", onclick }, h("div", { class: "k" }, k), h("div", { class: "v" }, v), d ? h("div", { class: "d" }, d) : null);
  const goIssue = (k) => { location.hash = "#issue=" + k; };

  // 每个智能体在做什么
  const agents = agentNames().map((name) => {
    const doing = inProgress.filter((i) => i.assignee === name);
    const runs = liveTasks.filter((t) => t.agent === name && !t.issueId);
    const a = studio.agent?.(name);
    return h("div", { class: "agent-row" },
      h("span", { class: "busy-dot" + (doing.length || runs.length ? " on" : "") }), avatar(name),
      h("div", { class: "meta" },
        h("div", { class: "t" }, name, a ? h("span", { class: "model-chip" }, (a.runtime ?? "builtin") === "builtin" ? modelShort(a.model) : rtDef(a.runtime).short) : null),
        h("div", { class: "s" }, doing.length || runs.length
          ? [doing.map((i, n) => [n ? "；" : "", h("a", { onclick: () => goIssue(i.key) }, i.key), ` ${phaseLabel(i.phase) ?? ""}阶段${i.cycle > 1 ? `（第 ${i.cycle} 轮）` : ""}`]),
             runs.length ? `${doing.length ? "；" : ""}${runs.length} 个临时运行` : null]
          : "空闲")),
      review.filter((i) => i.assignee === name).length ? h("span", { class: "tag" }, `待验收 ${review.filter((i) => i.assignee === name).length}`) : null);
  });

  fill($("#center"),
    h("div", { class: "center-head" }, h("h2", {}, "任务中心"),
      h("span", { class: "muted" }, "所有项目的工作项由同一批智能体执行 · 实时刷新"), demoFlag("")),
    h("div", { class: "tiles" },
      tile("running", "进行中的工作项", inProgress.length, PHASES.map((p) => `${p.label} ${phaseCount(p.id)}`).join(" · ")),
      tile("running", "执行中的运行", activeRuns + liveTasks.filter((t) => !t.issueId).length, `工作项 ${activeRuns} · 临时派发 ${liveTasks.filter((t) => !t.issueId).length}`),
      tile("review", "等待你验收", review.length, review.length ? "点击查看" : "暂无", review.length ? () => goIssue(review[0].key) : null),
      tile(retrying.length || failed.length ? "bad" : "", "返工 / 失败", `${retrying.length} / ${failed.length}`, "返工：进入第 2 轮及以上；失败：运行失败退回待办")),
    h("div", { class: "center-block" },
      h("div", { class: "bh" }, "执行队列", h("span", { class: "muted" }, "进行中的工作项按当前阶段排列；测试不通过回到执行，评审不通过回到需求理解；评审通过后离开队列，进入工作项的「待审核」")),
      phaseBoard(all)),
    h("div", { class: "center-grid" },
      h("div", { class: "center-block" }, h("div", { class: "bh" }, "智能体状态", h("span", { class: "muted" }, `${agents.length} 个`)), h("div", { class: "panel-box" }, agents)),
      h("div", { class: "center-block" }, h("div", { class: "bh" }, "最近动态"),
        h("div", { class: "panel-box" }, feed.length ? feed.map((c) => h("div", { class: "feed-row" + (/未通过|失败/.test(c.body) ? " fail" : ""), onclick: () => goIssue(c.key), title: c.body },
          h("span", { class: "ikey" }, c.key), h("span", { class: "b" }, c.kind === "agent" ? `${c.author} 交付：${c.body.split("\n")[0]}` : c.kind === "user" ? `${c.author}：${c.body}` : c.body),
          h("span", { class: "time" }, ago(c.createdAt)))) : h("div", { class: "empty" }, "暂无动态")))));
}
function renderIssuesView() { renderBoard(); renderCenter(); }
setInterval(() => { if (viewActive("center")) renderCenter(); }, 15000);

// ---------- 看板 ----------
async function renderBoard() {
  renderProjBar();
  const cur = curProject();
  if (!cur) return fill($("#board"), h("div", { class: "empty-board" },
    h("div", { style: "font-size:15px;font-weight:600;margin-bottom:6px" }, "还没有项目"),
    h("div", { class: "muted", style: "font-size:13px;margin-bottom:14px" }, "项目是工作空间：工作项、看板、负责人和仓库绑定都在项目下面。先创建一个，再往里放任务。"),
    h("button", { class: "primary", onclick: () => openNewProject() }, "创建第一个项目")));
  const all = await issuesApi.list(cur.id);
  const q = ui.q.trim().toLowerCase();
  const visible = all.filter((i) =>
    (!q || `${i.key} ${i.title} ${i.description} ${i.labels.join(" ")}`.toLowerCase().includes(q)) &&
    (!ui.assignee || (ui.assignee === "__none" ? !i.assignee : i.assignee === ui.assignee)));
  const order = (p) => (p === 0 ? 5 : p);
  const cols = IS.statuses.filter((s) => ui.showCanceled || s.id !== "canceled");
  fill($("#board"), ...cols.map((s) => {
    const items = visible.filter((i) => i.status === s.id).sort((a, b) => order(a.priority) - order(b.priority) || b.updatedAt.localeCompare(a.updatedAt));
    const col = h("div", { class: "bcol", "data-status": s.id },
      h("div", { class: "bcol-head" }, sicon(s.id), h("span", {}, s.label), h("span", { class: "count" }, items.length),
        h("button", { class: "icon-btn", title: `在「${s.label}」新建`, onclick: () => openCreate({ status: s.id }) }, "+")),
      h("div", { class: "bcol-body" }, items.length ? items.map(issueCard) : h("div", { class: "bcol-empty" }, q || ui.assignee ? "没有匹配的工作项" : "拖拽卡片到这里")));
    col.addEventListener("dragover", (e) => { e.preventDefault(); col.classList.add("over"); });
    col.addEventListener("dragleave", (e) => { if (!col.contains(e.relatedTarget)) col.classList.remove("over"); });
    col.addEventListener("drop", (e) => {
      e.preventDefault();
      col.classList.remove("over");
      const k = e.dataTransfer.getData("text/plain");
      const it = all.find((x) => x.key === k);
      if (it && it.status !== s.id) issuesApi.update(k, { status: s.id }).catch(fail);
    });
    return col;
  }));
}
function issueCard(i) {
  return h("div", {
      class: `icard${i.live?.tone === "run" ? " running" : ""}${i.status === "done" ? " done" : ""}${ui.openKey === i.key ? " sel" : ""}`,
      draggable: "true",
      ondragstart: (e) => { e.dataTransfer.setData("text/plain", i.key); e.currentTarget.classList.add("dragging"); },
      ondragend: (e) => e.currentTarget.classList.remove("dragging"),
      onclick: () => openIssue(i.key),
    },
    h("div", { class: "icard-top" }, prio(i.priority), h("span", { class: "ikey" }, i.key),
      i.live ? h("span", { class: `lstate ${i.live.tone}`, title: i.live.title || i.live.text }, i.live.text)
        : i.status === "todo" && !i.assignee ? h("span", { class: "lstate wait" }, "待指派") : null,
      h("span", { style: "margin-left:auto" }, avatar(i.assignee))),
    h("div", { class: "ititle" }, i.title),
    i.now ? h("div", { class: "inow", title: `${i.now.who}${i.now.step ? ` · ${i.now.step}` : ""}\n${i.now.action}` },
      h("span", { class: "spin" }), h("b", {}, i.now.who), h("span", { class: "act" }, i.now.action),
      h("span", { class: "el", "data-since": i.now.since }, elapsed(i.now.since))) : null,
    h("div", { class: "imeta" },
      i.labels.map((l) => h("span", { class: "label" + (l === "hotfix" ? " hot" : "") }, l === "hotfix" ? "⚡ HOTFIX" : l)),
      i.children.total ? h("span", { class: "tag", title: "子工作项完成度" }, `◫ ${i.children.done}/${i.children.total}`) : null,
      i.comments ? h("span", { class: "tag", title: "评论" }, `✎ ${i.comments}`) : null,
      ghTag(i.github), linearTag(i.linear),
      i.pr ? h("span", { class: "gh" + (i.pr.state === "merged" ? " closed" : ""), title: `${prName(i.pr)}（${i.pr.state === "merged" ? "已合并" : "待合并"}）` }, "⑂", prName(i.pr)) : null),
    miniSteps(i));
}

// ---------- 详情抽屉 ----------
async function openIssue(k) {
  if (ui.openKey !== k) { ui.feedbackOpen = false; ui.draft = ""; ui.feedbackDraft = ""; }
  if (ui.openKey !== k) drawerSig = "";
  ui.openKey = k;
  ui.focusReturn = document.activeElement;
  history.replaceState(null, "", "#issue=" + k);
  $("#drawer").classList.add("open");
  $("#drawer").setAttribute("aria-hidden", "false");
  $("#scrim").classList.add("open");
  await renderDrawer(true);
  renderBoard();
  $("#drawer").focus({ preventScroll: true });
}
function closeDrawer() {
  ui.openKey = null;
  $("#drawer").classList.remove("open");
  $("#drawer").setAttribute("aria-hidden", "true");
  if (!$("#qaDrawer").classList.contains("open")) $("#scrim").classList.remove("open");
  history.replaceState(null, "", "#view=issues");
  renderBoard();
  restoreFocus();
}
/** 正在就地编辑标题/描述/标签时不重绘，等失焦后再刷新，避免吞掉输入 */
function refreshDrawer() {
  if (!ui.openKey) return;
  const a = document.activeElement;
  if (a && $("#drawer").contains(a) && a.dataset.keep) { ui.pendingDrawer = true; return; }
  renderDrawer();
}
let drawerSig = "";
let drawerBusy = false;
let drawerDirty = false;
async function renderDrawer(force = false) {
  if (!ui.openKey) return;
  // 进行中的工作项每秒都有状态事件；整体重绘会让抽屉闪烁。串行化，并且只在结构真的变了时重绘
  if (drawerBusy) { drawerDirty = true; return; }
  drawerBusy = true;
  try {
  let d;
  try { d = await issuesApi.detail(ui.openKey); } catch { return closeDrawer(); }
  if (d.key !== ui.openKey) return; // 请求返回前已经切到别的单
  // 指纹只取「会改变界面结构」的字段：相对时间每秒都在变，不能拿来判断
  const sig = JSON.stringify([
    d.id, d.status, d.phase, d.cycle, d.assignee, d.priority, d.labels, d.blocked, d.activeRuns,
    d.lastRun?.status, d.lastRun?.id, d.pr?.state, d.pr?.checks, d.comments, d.now?.who, d.now?.action, d.now?.step, d.live?.text,
    (d.activity ?? []).length, (d.deps ?? []).map((x) => x.met), d.github?.state, d.linear?.syncedAt,
  ]);
  if (!force && sig === drawerSig) return;
  drawerSig = sig;
  ui.pendingDrawer = false;
  if (d.projectId !== curProject()?.id) setProject(d.projectId, { keepDrawer: true });
  // 评论框/反馈框：重绘后恢复焦点与光标
  const refocus = $("#drawer").contains(document.activeElement) ? document.activeElement.dataset.focusId : null;
  const set = (patch) => issuesApi.update(d.key, patch).catch(fail);
  const all = await issuesApi.list(d.projectId);
  const isDesc = (x) => { for (let p = x; p; p = all.find((y) => y.id === p.parentId)) if (p.id === d.id) return true; return false; };

  // 情境操作条：根据状态给出下一步最可能的动作
  let bar;
  if (d.blocked && d.leadDeciding) {
    bar = h("div", { class: "actionbar live-bar" }, h("span", { class: "live" }, "确认中"),
      h("span", { class: "hint" }, `${d.assignee} 提了 ${d.blocked.length} 个需求问题，项目负责人正在回答；拿不准的会转给你`));
  } else if (d.blocked) {
    const ans = h("textarea", { class: "feedback", "data-focus-id": "reqans", placeholder: "逐条回答上面的问题，会补充进需求描述…（⌘↵ 提交）", oninput: (e) => (ui.reqDraft = e.target.value) }, ui.reqDraft ?? "");
    const go = async () => { const a = ans.value.trim(); if (!a) return ans.focus(); ui.reqDraft = ""; ans.blur(); await issuesApi.confirmRequirement(d.key, a); toast(`${d.key} 需求已确认，继续执行`, "ok"); };
    ans.addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) go(); });
    bar = h("div", { class: "actionbar review", style: "border-color:color-mix(in srgb,var(--cancelled) 45%,var(--border));background:color-mix(in srgb,var(--cancelled) 6%,var(--panel))" },
      h("span", { class: "hint", style: "flex-basis:100%" }, h("b", { style: "color:var(--text)" }, `⏸ ${d.assignee} 在等你确认需求`), "（需求越具体，交付和测试越准确）"),
      h("ol", { style: "margin:0;padding-left:20px;font-size:13px;flex-basis:100%" }, d.blocked.map((q) => h("li", {}, q))),
      ans, h("div", { class: "row", style: "width:100%;justify-content:flex-end" }, h("button", { class: "primary", onclick: go }, "确认需求并继续")));
  } else if (d.activeRuns) {
    bar = h("div", { class: "actionbar live-bar" }, h("span", { class: "live" }, d.live?.text ?? "执行中"),
      d.now ? h("span", { class: "hint now-line" }, h("span", { class: "spin" }), h("b", {}, d.now.who), d.now.step ? h("span", { class: "muted" }, ` · ${d.now.step}`) : null,
          h("span", {}, ` · ${d.now.action}`), h("span", { class: "muted", "data-since": d.now.since }, ` · ${elapsed(d.now.since)}`))
        : h("span", { class: "hint" }, `${d.assignee} 正在处理，完成后结果会出现在下方动态里`),
      h("button", { class: "danger", onclick: () => issuesApi.stop(d.key).catch(fail) }, "■ 停止"));
  } else if (d.status === "in_review") {
    const fb = h("textarea", { class: "feedback", "data-focus-id": "feedback", placeholder: "写下修改意见，智能体会按意见重做…（⌘↵ 提交）", oninput: (e) => (ui.feedbackDraft = e.target.value) }, ui.feedbackDraft);
    const sendBack = async () => {
      const body = fb.value.trim();
      if (!body) return fb.focus();
      ui.feedbackOpen = false;
      ui.feedbackDraft = "";
      fb.blur();
      try { await issuesApi.comment(d.key, body); await issuesApi.update(d.key, { status: "todo" }); } catch (e) { fail(e); }
    };
    fb.addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) sendBack(); });
    bar = h("div", { class: "actionbar review" },
      h("span", { class: "hint" }, d.pr?.state === "merged" ? `已通过测试与 AI 审核，${prName(d.pr)} 已合并，等待你最终验收` : `${d.assignee ?? "智能体"} 已交付，等待你最终验收`),
      d.pr?.state === "open"
        ? h("button", { class: "primary", disabled: d.pr.checks === "passing" ? null : "", onclick: () => issuesApi.mergePR(d.key).then(() => toast(`已合并 ${prName(d.pr)}，${d.key} 完成`, "ok")).catch(fail) }, d.pr.local === "local" ? "✓ 验收并合并到本地" : `✓ 验收并合并 ${prName(d.pr)}`)
        : h("button", { class: "primary", onclick: () => set({ status: "done" }) }, "✓ 最终验收通过"),
      h("button", { onclick: () => { ui.feedbackOpen = !ui.feedbackOpen; renderDrawer(); } }, "↩ 退回修改"),
      ui.feedbackOpen ? [fb, h("div", { class: "row", style: "width:100%;justify-content:flex-end" },
        h("button", { class: "primary", onclick: sendBack }, d.assignee ? "退回并重新执行" : "退回"))] : null);
    if (ui.feedbackOpen && !refocus) setTimeout(() => fb.focus());
  } else if (d.status === "done" || d.status === "canceled") {
    bar = h("div", { class: "actionbar" }, h("span", { class: "hint" }, `已${statusOf(d.status).label}`),
      h("button", { onclick: () => set({ status: "todo" }) }, "重新打开"));
  } else if (!d.assignee) {
    bar = h("div", { class: "actionbar" }, h("span", { class: "hint" }, "指派给一个智能体，放入「待办」后会自动开始执行"),
      select(assigneeOptions(), "", (v) => v && set({ assignee: v, status: "todo" }), { style: "width:auto" }));
  } else {
    bar = h("div", { class: "actionbar" },
      h("span", { class: "hint" }, d.status === "backlog" ? `在「待规划」中，不会自动执行` : d.lastRun?.status === "failed" ? "上次运行失败，可调整描述后重试" : `由 ${d.assignee} 负责`),
      h("button", { class: "primary", onclick: () => issuesApi.run(d.key).catch(fail) }, d.lastRun ? "▶ 重新运行" : "▶ 运行"));
  }

  const titleIn = h("input", { class: "title-input", "data-keep": "1", value: d.title, onchange: (e) => e.target.value.trim() && set({ title: e.target.value.trim() }) });
  const desc = h("textarea", { class: "desc", "data-keep": "1", placeholder: "描述背景、要求和验收标准（智能体只能看到这里和讨论记录）", onchange: (e) => set({ description: e.target.value }) }, d.description);
  const composer = h("textarea", { "data-focus-id": "composer", placeholder: "评论…（⌘↵ 发送）", oninput: (e) => (ui.draft = e.target.value) }, ui.draft);
  const send = async () => {
    const body = composer.value.trim();
    if (!body) return;
    ui.draft = "";
    composer.value = "";
    await issuesApi.comment(d.key, body).catch(fail);
  };
  composer.addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) send(); });

  const time = (iso) => h("span", { class: "time", title: new Date(iso).toLocaleString() }, ago(iso));
  const runBadge = (s) => h("span", { class: "badge s-" + (s === "cancelled" ? "cancelled" : s) }, STATUS[s] ?? s);

  const keepScroll = $("#drawer").scrollTop;
  fill($("#drawer"), 
    h("div", { class: "dr-head" },
      h("a", { onclick: () => { closeDrawer(); showView("project"); }, title: "项目设置" }, d.projectName), h("span", {}, "/"),
      sicon(d.status), h("span", {}, d.key),
      d.parent ? [h("span", {}, "‹"), h("a", { onclick: () => openIssue(d.parent.key) }, `${d.parent.key} ${short(d.parent.title, 24)}`)] : null,
      h("span", { style: "margin-left:auto" }),
      h("button", { class: "danger", title: "删除", onclick: async () => { if (confirm(`删除 ${d.key}？`)) { await issuesApi.remove(d.key).catch(fail); closeDrawer(); } } }, "删除"),
      h("button", { title: "关闭（Esc）", onclick: closeDrawer }, "✕")),
    titleIn,
    bar,
    h("div", { class: "props" },
      h("label", {}, "状态"), select(statusOptions(), d.status, (v) => set({ status: v })),
      h("label", {}, "负责人"), select(assigneeOptions(), d.assignee ?? "", (v) => set({ assignee: v || null })),
      h("label", {}, "优先级"), select(prioOptions(), d.priority, (v) => set({ priority: Number(v) })),
      h("label", {}, "标签"), h("input", { "data-keep": "1", value: d.labels.join(", "), placeholder: "用逗号分隔", onchange: (e) => set({ labels: e.target.value.split(/[,，]/).map((x) => x.trim()).filter(Boolean) }) }),
      h("label", {}, "父工作项"), select([["", "无"], ...all.filter((x) => !isDesc(x)).map((x) => [x.key, `${x.key} ${short(x.title, 30)}`])], d.parent?.key ?? "", (v) => set({ parent: v || null })),
      h("label", {}, "依赖"), h("div", {},
        d.deps?.length ? h("div", { class: "row", style: "gap:8px;flex-wrap:wrap;margin-bottom:4px" }, d.deps.map((x) =>
          h("a", { class: "link", style: "font-size:12.5px", title: x.title, onclick: () => openIssue(x.key) }, `${x.met ? "✅" : "⏳"} ${x.key} ${short(x.title, 16)}`))) : null,
        h("input", { "data-keep": "1", value: (d.deps ?? []).map((x) => x.key).join(", "), placeholder: "依赖的工作项编号，用逗号分隔，如 S2T-1, S2T-2",
          onchange: (e) => set({ dependsOn: e.target.value.split(/[,，\s]+/).map((x) => x.trim()).filter(Boolean) }) }),
        h("div", { class: "help" }, "依赖全部完成（或 PR 合并）后才会开始执行")),
      h("label", {}, "GitHub"), d.github
        ? h("div", { class: "row" }, ghTag(d.github), h("span", { class: "muted", style: "font-size:12.5px" }, `${d.github.state === "closed" ? "已关闭" : "open"} · ${ago(d.github.syncedAt)}同步`),
            h("a", { class: "link", style: "font-size:12.5px", href: d.github.url, target: "_blank", rel: "noopener" }, "在 GitHub 打开"))
        : curProject()?.repo
          ? h("div", { class: "row" }, h("span", { class: "muted", style: "font-size:12.5px" }, "未关联"),
              ["two_way", "push"].includes(curProject().sync.mode) ? h("button", { onclick: () => issuesApi.pushToGithub(d.key).then(() => toast("已在 GitHub 创建 issue", "ok")).catch(fail) }, "创建 GitHub issue") : null)
          : h("span", { class: "muted", style: "font-size:12.5px" }, "项目未绑定仓库"),
      h("label", {}, "Linear"), d.linear
        ? h("div", { class: "row" }, linearTag(d.linear), h("span", { class: "muted", style: "font-size:12.5px" }, `${d.linear.state === "closed" ? "已关闭" : "open"} · ${ago(d.linear.syncedAt)}同步`),
            h("a", { class: "link", style: "font-size:12.5px", href: d.linear.url, target: "_blank", rel: "noopener" }, "在 Linear 打开"),
            (d.linear.creator || d.linear.assignee) ? h("span", { class: "muted", style: "font-size:12.5px" },
              [d.linear.creator ? `创建人 ${d.linear.creator.name}` : null, d.linear.assignee ? `指派人 ${d.linear.assignee.name}` : "未指派"].filter(Boolean).join(" · ")) : null)
        : curProject()?.linear
          ? h("div", { class: "row" }, h("span", { class: "muted", style: "font-size:12.5px" }, "未关联"),
              linearPushable(curProject()) ? h("button", { onclick: () => issuesApi.pushToLinear(d.key).then(() => toast("已在 Linear 创建 issue", "ok")).catch(fail) }, "创建 Linear issue") : null)
          : h("span", { class: "muted", style: "font-size:12.5px" }, "项目未绑定 Linear")),
    d.phases.length ? (() => {
      const rounds = lifecycleRounds(d);
      return [
        h("div", { class: "section-title" }, `生命周期 · ${d.phase ? `${phaseLabel(d.phase)}中，` : ""}共 ${rounds.length} 轮`),
        h("div", { class: "lc-cycles" }, rounds.slice().reverse().map((rd) => {
          const failed = rd.cells.find((c) => c.state === "fail");
          const live = rd.cells.some((c) => c.state === "active");
          return h("div", { class: "lc-cycle" },
            h("div", { class: "hd" }, h("b", { style: "color:var(--text)" }, `第 ${rd.n} 轮`),
              rd.why ? h("span", { class: "muted", style: "font-size:12px" }, rd.why) : null,
              live ? h("span", { class: "live" }, "进行中") : failed ? h("span", { class: "warn" }, `${failed.phase.label}未通过`) : rd.cells.every((c) => ["pass", "inherit"].includes(c.state)) ? h("span", { class: "s-completed", style: "font-size:12px" }, "全部通过") : null,
              rd.interrupts ? h("span", { class: "muted", style: "font-size:11.5px" }, `中途中断 ${rd.interrupts} 次（重启 / 网络），已接着跑`) : null,
              rd.run ? h("a", { class: "link", style: "margin-left:auto;font-size:12px", onclick: () => openRun(rd.run.id) }, `验收记录与截图（${caseCount(rd.run)}）→`) : null),
            h("div", { class: "grid5" }, rd.cells.map((c) => h("div", {}, h("div", { class: "muted", style: "font-size:11.5px;margin-bottom:2px" }, c.phase.label), phaseCell(c)))),
            rd.fails.length ? h("ul", { class: "a-fails" }, rd.fails.map((c) => h("li", {}, h("b", {}, `${c.id} `), short(plainMd(c.title), 90), c.note ? h("div", { class: "muted" }, short(plainMd(c.note), 260)) : null))) : null);
        }))];
    })() : null,
    prSection(d),
    (() => { const runs = qa.runsFor(d.key); return runs.length ? [h("div", { class: "section-title" }, `测试 ${runs.length}`),
      runs.map((r) => h("div", { class: "run-row", onclick: () => openRun(r.id) }, runBadge2(r.status), h("span", {}, `用例 ${caseCount(r)}`),
        h("span", { class: "tag" }, r.trigger === "post-merge" ? "合并后页面验收" : r.trigger === "manual" ? "手动重跑" : "交付验收"),
        h("span", { class: "muted", style: "font-size:12px" }, r.browser === "local" ? "远程 Chrome" : r.browser ? `浏览器 ${r.browser}` : r.env === "CI" ? "CI" : "排队中"),
        r.wait && r.status === "queued" ? h("span", { class: "muted", style: "font-size:12px" }, r.wait) : null, h("span", { class: "time" }, ago(r.endedAt ?? r.queuedAt))))] : null; })(),
    (() => { const q = assessRequirement(d); return h("div", { class: "section-title" }, "描述 · ", h("span", { class: "score " + (q.score >= 80 ? "hi" : q.score >= 60 ? "mid" : "lo"), title: q.dims.map((x) => `${x.ok ? "✓" : "✕"} ${x.name}`).join("\n") }, `需求评分 ${q.score}`),
      q.dims.some((x) => !x.ok) ? h("span", { class: "muted", style: "font-weight:400" }, ` 缺少：${q.dims.filter((x) => !x.ok).map((x) => x.name).join("、")}`) : null); })(), desc,
    h("div", { class: "section-title" }, `子工作项 ${d.childList.length ? `${d.children.done}/${d.children.total}` : ""}`),
    h("div", {}, d.childList.map((c) => h("div", { class: "sub-row", onclick: () => openIssue(c.key) },
      sicon(c.status), h("span", { class: "ikey" }, c.key), h("span", { class: "t" }, c.title),
      c.activeRuns ? h("span", { class: "live" }, "执行中") : null, avatar(c.assignee)))),
    h("div", { class: "row", style: "margin-top:4px" }, h("a", { class: "link", onclick: () => openCreate({ parent: d.key, assignee: "" }) }, "+ 添加子工作项")),
    h("div", {}, d.runList.length ? [h("div", { class: "section-title" }, `运行记录 ${d.runList.length}`),
      d.runList.map((r) => h("div", { class: "run-row", title: "查看这次运行的调用树和对话记录", onclick: () => { closeDrawer(); location.hash = "#task=" + r.id; } },
        runBadge(r.status), h("span", { class: "who" }, avatar(r.agent), r.agent), h("code", { class: "muted" }, r.id),
        r.error ? h("span", { class: "s-failed", style: "font-size:12px" }, short(r.error, 40)) : null, time(r.startedAt)))] : null),
    h("div", { class: "section-title" }, "动态"),
    h("div", { class: "timeline" }, d.activity.map((c) => c.kind === "system"
      ? h("div", { class: "ev-sys" }, h("span", {}, c.body), time(c.createdAt))
      : h("div", { class: "ev-card " + c.kind },
          h("div", { class: "head" }, avatar(c.author), h("b", {}, c.author), c.kind === "agent" ? h("span", { class: "tag" }, "交付") : c.kind === "lead" ? h("span", { class: "tag" }, "项目负责人") : null, time(c.createdAt)),
          h("div", { class: "text" }, c.body)))),
    h("div", { class: "composer" }, composer, h("div", { class: "row" }, h("button", { onclick: send }, "发送"))),
  );
  if (refocus) {
    const el = $(`#drawer [data-focus-id="${refocus}"]`);
    if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); }
  }
  if (keepScroll) $("#drawer").scrollTop = keepScroll;
  } finally {
    drawerBusy = false;
    if (drawerDirty) { drawerDirty = false; void renderDrawer(); }
  }
}

// ---------- 新建弹窗 ----------
function openCreate(preset = {}) {
  const f = {};
  f.title = h("input", { class: "title-input", placeholder: "工作项标题" });
  f.desc = h("textarea", { class: "desc", placeholder: "描述背景、要求和验收标准…\n智能体只能看到这里写的内容，越具体越好。" });
  const hint = h("span", { class: "hint" });
  const val = { status: preset.status ?? "", priority: 0, assignee: preset.assignee ?? "", parent: preset.parent ?? "" };
  const upd = () => {
    const st = val.status || (val.assignee ? "todo" : "backlog");
    const go = val.assignee && st === "todo";
    hint.className = "hint" + (go ? " go" : "");
    hint.textContent = go ? `⚡ 创建后 ${val.assignee} 会立即开始执行` : val.assignee ? `进入「${statusOf(st).label}」，不会自动执行` : `进入「${statusOf(st).label}」，指派智能体后才会执行`;
  };
  const submit = async () => {
    const title = f.title.value.trim();
    if (!title) return f.title.focus();
    try {
      const i = await issuesApi.create({ projectId: curProject()?.id, title, description: f.desc.value, status: val.status || undefined, priority: Number(val.priority), assignee: val.assignee || null, parent: val.parent || null, github: val.github, linear: val.linear });
      closeModal();
      toast(`已创建 ${i.key}`, "ok");
    } catch (e) { fail(e); }
  };
  [f.title, f.desc].forEach((el) => el.addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit(); }));
  f.title.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.metaKey && !e.ctrlKey) { e.preventDefault(); f.desc.focus(); } });
  const proj = curProject();
  if (!proj) return openNewProject();
  const pushable = proj.repo && ["two_way", "push"].includes(proj.sync.mode);
  val.github = pushable && proj.sync.pushNew;
  val.linear = linearPushable(proj) && proj.linear.pushNew;
  issuesApi.list(proj.id).then((all) => {
    fill($("#modal"), h("div", { class: "modal", onclick: (e) => e.stopPropagation() },
      h("div", { class: "dr-head" }, pbadge(proj), h("span", {}, `${proj.name} · 新建工作项`), preset.parent ? h("span", {}, `· 子项 of ${preset.parent}`) : null),
      f.title, f.desc,
      h("div", { class: "modal-props" },
        select([["", "状态：自动"], ...statusOptions()], val.status, (v) => ((val.status = v), upd())),
        select(assigneeOptions().map(([v, l]) => [v, v ? `负责人：${l}` : "负责人：未指派"]), val.assignee, (v) => ((val.assignee = v), upd())),
        select(prioOptions().map(([v, l]) => [v, `优先级：${l}`]), val.priority, (v) => (val.priority = v)),
        select([["", "父工作项：无"], ...all.map((x) => [x.key, `父：${x.key} ${short(x.title, 18)}`])], val.parent, (v) => (val.parent = v))),
      pushable ? checkboxP(val.github, (on) => (val.github = on), `同时在 GitHub（${proj.repo.fullName}）创建 issue`) : null,
      linearPushable(proj) ? checkboxP(val.linear, (on) => (val.linear = on), `同时在 Linear（${proj.linear.teamName}）创建 issue`) : null,
      h("div", { class: "modal-foot" }, hint, h("button", { onclick: closeModal }, "取消"), h("button", { class: "primary", onclick: submit }, "创建 ⌘↵"))));
    upd();
    $("#modal").classList.add("open"); $("#modal").setAttribute("aria-hidden", "false");
    setTimeout(() => f.title.focus());
  });
}
function closeModal(force) {
  if (force !== true && bd.open && bd.msgs.some((m) => m.role === "me") && !confirm("关闭后这次对话和草稿会丢失，确定关闭？")) return;
  const wasOpen = $("#modal").classList.contains("open");
  bd.open = false;
  $("#modal").classList.remove("open", "builder-wrap");
  $("#modal").setAttribute("aria-hidden", "true");
  fill($("#modal"), );
  if (wasOpen) restoreFocus();
}
$("#modal").addEventListener("click", closeModal);

// ---------- 事件与快捷键 ----------
issuesApi.onChange(() => {
  renderProjectSwitch();
  renderIssuesView();
  if (viewActive("home")) debounce("home", renderHome, 150);
  if (viewActive("project")) debounce("project", renderProjectPage, 200);
  refreshDrawer();
});
$("#drawer").addEventListener("focusout", () => setTimeout(() => {
  if (ui.pendingDrawer && !$("#drawer").contains(document.activeElement)) renderDrawer();
}));
$("#scrim").addEventListener("click", () => { if (qaOpen) closeRun(); if (ui.openKey) closeDrawer(); });
$("#issueSearch").addEventListener("input", (e) => { ui.q = e.target.value; renderIssuesView(); });
$("#showCanceled").addEventListener("change", (e) => { ui.showCanceled = e.target.checked; saveUiPrefs(); renderBoard(); });
$("#newIssueBtn").onclick = () => openCreate();
$("#hotfixBtn").onclick = () => openHotfix();

/** Hotfix：紧急修复，创建后直接进入「进行中」并开始执行 */
function openHotfix(preset = {}) {
  const proj = curProject();
  if (!proj) return openNewProject();
  const title = h("input", { class: "title-input", placeholder: "要紧急修复的问题，如「支付回调超时导致订单卡住」" });
  title.value = preset.title ?? "";
  const desc = h("textarea", { class: "desc", placeholder: "现象、影响范围、复现步骤、期望结果…" }, preset.description ?? "");
  const val = { assignee: "", github: !!proj.repo && ["two_way", "push"].includes(proj.sync.mode), linear: linearPushable(proj) };
  const submit = async () => {
    if (!title.value.trim()) return title.focus();
    try {
      const i = await issuesApi.create({ projectId: proj.id, title: title.value.trim(), description: desc.value, assignee: val.assignee || null, github: val.github, hotfix: true, linear: val.linear });
      closeModal(true);
      toast(`⚡ ${i.key} 已创建，${i.assignee ?? "智能体"} 开始处理`, "err");
    } catch (e) { fail(e); }
  };
  [title, desc].forEach((el) => el.addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit(); }));
  fill($("#modal"), h("div", { class: "modal", onclick: (e) => e.stopPropagation() },
    h("div", { class: "dr-head" }, pbadge(proj), h("span", {}, `${proj.name} · `), h("span", { class: "label hot" }, "⚡ HOTFIX")),
    title, desc,
    h("div", { class: "modal-props" },
      select([["", "负责人：按内容自动选择"], ...agentNames().map((n) => [n, `负责人：${n}`])], val.assignee, (v) => (val.assignee = v)),
      val.github ? checkboxP(val.github, (on) => (val.github = on), `同时在 GitHub（${proj.repo.fullName}）创建 issue`) : null,
      linearPushable(proj) ? checkboxP(val.linear, (on) => (val.linear = on), `同时在 Linear（${proj.linear.teamName}）创建 issue`) : null),
    h("div", { class: "modal-foot" }, h("span", { class: "hint go", style: "color:var(--failed)" }, "直接进入「进行中」，紧急优先级，照常走完测试与评审"),
      h("button", { onclick: () => closeModal() }, "取消"), h("button", { class: "primary", style: "background:var(--failed);border-color:var(--failed)", onclick: submit }, "创建并立即开始 ⌘↵"))));
  $("#modal").classList.add("open"); $("#modal").setAttribute("aria-hidden", "false");
  setTimeout(() => title.focus());
}
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if ($("#modal").classList.contains("open")) closeModal();
    else if (qaOpen) closeRun();
    else if (ui.openKey) closeDrawer();
    return;
  }
  if (/INPUT|TEXTAREA|SELECT/.test(e.target.tagName) || e.metaKey || e.ctrlKey || e.altKey) return;
  if (!$("#view-issues").classList.contains("active") || $("#modal").classList.contains("open")) return;
  if (e.key === "c" || e.key === "C") { e.preventDefault(); openCreate(); }
  if (e.key === "/") { e.preventDefault(); $("#issueSearch").focus(); }
});
function renderAssigneeFilter() {
  const el = select([["", "全部负责人"], ["__none", "未指派"], ...agentNames().map((n) => [n, n])], ui.assignee, (v) => { ui.assignee = v; saveUiPrefs(); renderIssuesView(); }, { id: "issueAssignee" });
  $("#issueAssignee").replaceWith(el);
}
function initIssues() {
  renderProjectSwitch();
  renderHome();
  loadRuntimes();
  renderBell();
  renderAssigneeFilter();
  renderBoard();
  const m = /issue=([\w-]+)/.exec(location.hash);
  if (m) openIssue(m[1]);
}

// ======================= 智能体工作室 =======================
const MODELS = [
  { id: "claude-opus-5-5", name: "Claude Opus 5.5", tag: "默认", desc: "综合能力强，适合大多数智能体和多步骤任务", price: "$4 / $20 每百万 tokens" },
  { id: "claude-fable-5-2", name: "Claude Fable 5.2", tag: "最强", desc: "最难的推理与长程任务；更慢、更贵", price: "$8 / $40 每百万 tokens" },
  { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", tag: "均衡", desc: "速度与能力兼顾，适合日常写作和编码", price: "$2 / $10 每百万 tokens" },
  { id: "claude-haiku-5-5", name: "Claude Haiku 5.5", tag: "最快", desc: "简单、高频任务，成本最低", price: "$0.10 / $0.50 每百万 tokens" },
];
const modelShort = (id) => modelLabel(id).replace("Claude ", "");
const EFFORTS = [["low", "低 · 简单任务，最快"], ["medium", "中 · 默认"], ["high", "高 · 复杂任务"], ["xhigh", "很高 · 长程编码与多步骤任务"], ["max", "最高 · 不计成本"]];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const studio = {
  init() {},
  agents: () => S.agents.map((a) => ({ runtime: "builtin", cliModel: "", skills: [], ...a })),
  skills: () => S.skills,
  agent: (n) => studio.agents().find((a) => a.name === n),
  skill: (id) => S.skills.find((s) => s.id === id),
  usage: (id) => studio.agents().filter((a) => (a.skills ?? []).includes(id)).map((a) => a.name),
  saveAgent: (a, orig) => act("studio.saveAgent", a, orig ?? null),
  deleteAgent: (n) => act("studio.deleteAgent", n),
  saveSkill: (s, orig) => act("studio.saveSkill", s, orig ?? null),
  deleteSkill: (id) => act("studio.deleteSkill", id),
  nextSkillId() { let n = S.skills.length + 1; while (S.skills.some((s) => s.id === "skill-" + n)) n++; return "skill-" + n; },
};

// ---------- 工作室状态 ----------
const st = { sel: { kind: "agent", id: null }, draft: null, orig: null, attachTo: null, realTools: [], realMcp: [] };
const clone = (x) => JSON.parse(JSON.stringify(x));
const isDirty = () => st.draft != null && (st.sel.id == null || JSON.stringify(st.draft) !== st.orig);
function loadDraft() {
  const { kind, id } = st.sel;
  if (kind === "agent") st.draft = id ? clone(studio.agent(id) ?? null) : null;
  else if (kind === "skill") st.draft = id ? clone(studio.skill(id) ?? null) : { id: studio.nextSkillId(), name: "", description: "", instructions: "", createdBy: ME };
  else st.draft = null;
  st.orig = JSON.stringify(st.draft);
}
function selectStudio(kind, id, opts = {}) {
  if (isDirty() && !confirm("有未保存的修改，确定离开？")) return;
  st.sel = { kind, id };
  st.attachTo = opts.attachTo ?? null;
  loadDraft();
  renderStudio();
  $("#studioMain").scrollTop = 0;
  if (viewActive("config")) setHash("config", { studio: kind, sel: id });
}
function touch() {
  const bar = $("#savebar");
  if (bar) bar.classList.toggle("clean", !isDirty());
}

/** 重新拉取自定义工具与 MCP 列表。保存/删除后必须调用，否则列表要等重新进入视图才更新 */
async function reloadStudioData() {
  try { [st.realTools, st.realMcp] = await Promise.all([api("/tools"), api("/mcp-servers")]); } catch { /* 拉取失败时保留旧数据 */ }
}

async function loadConfig() {
  await reloadStudioData();
  if (!st.sel.id && st.sel.kind === "agent") { st.sel.id = studio.agents()[0]?.name ?? null; loadDraft(); }
  renderStudio();
}

function renderStudio() {
  renderStudioSide();
  const { kind } = st.sel;
  const main = $("#studioMain");
  if (kind === "agent" && st.draft) fill(main, h("div", { class: "studio-inner" }, agentEditor()));
  else if (kind === "skill" && st.draft) fill(main, h("div", { class: "studio-inner" }, skillEditor()));
  else if (kind === "tools") fill(main, h("div", { class: "studio-inner" }, toolsView()));
  else if (kind === "mcp") fill(main, h("div", { class: "studio-inner" }, mcpView()));
  else fill(main, h("div", { class: "empty" }, "在左侧选择一个智能体或技能"));
}

function renderStudioSide() {
  const sel = (k, id) => st.sel.kind === k && st.sel.id === id;
  fill($("#studioSide"), 
    h("div", { class: "side-head" }, h("span", {}, `智能体 ${studio.agents().length}`),
      h("button", { onclick: () => openBuilder(null), title: "通过与 AI 对话创建" }, "✦ 新建")),
    studio.agents().map((a) => h("div", { class: "side-item" + (sel("agent", a.name) ? " sel" : ""), onclick: () => selectStudio("agent", a.name) },
      avatar(a.name),
      h("div", { class: "meta" }, h("div", { class: "t" }, a.name, h("span", { class: "model-chip" }, (a.runtime ?? "builtin") === "builtin" ? modelShort(a.model) : rtDef(a.runtime).short)),
        h("div", { class: "s" }, a.description || "—")))),
    h("div", { class: "side-head" }, h("span", {}, `技能 ${studio.skills().length}`),
      h("button", { onclick: () => selectStudio("skill", null), title: "从空白开始写" }, "+ 新建"),
      h("button", { onclick: () => openSkillImporter(), title: "粘贴一段技能说明或给一个地址，由 AI 整理成技能" }, "✦ AI 新建")),
    studio.skills().map((s) => h("div", { class: "side-item" + (sel("skill", s.id) ? " sel" : ""), onclick: () => selectStudio("skill", s.id) },
      h("span", { class: "skill-icon" }, "✦"),
      h("div", { class: "meta" }, h("div", { class: "t" }, s.name), h("div", { class: "s" }, `${studio.usage(s.id).length} 个智能体在用 · ${s.description || "—"}`)))),
    st.sel.kind === "skill" && st.sel.id == null
      ? h("div", { class: "side-item sel" }, h("span", { class: "skill-icon" }, "✦"), h("div", { class: "meta" }, h("div", { class: "t" }, st.draft?.name || "新技能"), h("div", { class: "s" }, "未保存")))
      : null,
    h("div", { class: "side-head" }, h("span", {}, "连接")),
    h("div", { class: "side-item" + (st.sel.kind === "tools" ? " sel" : ""), onclick: () => selectStudio("tools", "tools") },
      h("span", { class: "skill-icon", style: "color:var(--muted);background:var(--panel-2)" }, "⚙"), h("div", { class: "meta" }, h("div", { class: "t" }, "工具目录"), h("div", { class: "s" }, `内置 ${(S.builtinTools ?? []).length} 个 · 自定义 ${st.realTools.length} 个`))),
    h("div", { class: "side-item" + (st.sel.kind === "mcp" ? " sel" : ""), onclick: () => selectStudio("mcp", "mcp") },
      h("span", { class: "skill-icon", style: "color:var(--muted);background:var(--panel-2)" }, "⇄"), h("div", { class: "meta" }, h("div", { class: "t" }, "MCP 服务器"), h("div", { class: "s" }, `${st.realMcp.length} 个服务器`))),
    null,
  );
}

// ---------- 表单小部件 ----------
const section = (title, desc, ...body) => h("div", { class: "ed-section" }, h("div", { class: "lbl" }, h("b", {}, title), desc ? h("span", {}, desc) : null), h("div", { class: "fields" }, body));
const field = (label, input, help) => h("div", { class: "field" }, h("label", {}, label), input, help ? h("div", { class: "help" }, help) : null);
function textIn(obj, key, attrs = {}) {
  const tag = attrs.multiline ? "textarea" : "input";
  const { multiline, ...rest } = attrs;
  const el = h(tag, { ...rest, oninput: (e) => { obj[key] = e.target.value; touch(); } }, multiline ? obj[key] : null);
  if (!multiline) el.value = obj[key] ?? "";
  return el;
}
function listIn(obj, key, placeholder) {
  const el = h("input", { placeholder, oninput: (e) => { obj[key] = e.target.value.split(/[,，]/).map((x) => x.trim()).filter(Boolean); touch(); } });
  el.value = obj[key].join(", ");
  return el;
}
function checkbox(checked, onchange, label, small) {
  const input = h("input", { type: "checkbox", onchange: (e) => { onchange(e.target.checked); touch(); } });
  input.checked = checked;
  return h("label", { class: "check" }, input, h("span", {}, label, small ? h("small", {}, small) : null));
}
const toggleIn = (arr, v, on) => { const i = arr.indexOf(v); if (on && i < 0) arr.push(v); if (!on && i >= 0) arr.splice(i, 1); };
/** 从「设置 → 模型」里已启用的模型中选择；当前绑定的模型若已停用也会显示出来 */
function modelPicker(d) {
  const list = settings.models().filter((m) => m.enabled || m.id === d.model);
  const wrap = h("div", { class: "models" }, list.map((m) => {
    const prov = settings.provider(m.providerId);
    return h("div", {
        class: "model-opt" + (d.model === m.id ? " sel" : "") + (prov?.verifiedAt || simulateMode() ? "" : " warn"), "data-id": m.id,
        onclick: () => { d.model = m.id; wrap.querySelectorAll(".model-opt").forEach((x) => x.classList.toggle("sel", x.dataset.id === m.id)); touch(); },
      },
      h("div", { class: "n" }, m.label, m.tag ? h("span", { class: "model-chip" }, m.tag) : null),
      h("div", { class: "d" }, m.enabled ? (m.desc ?? m.modelId) : "已在设置中停用，请改选其他模型"),
      h("div", { class: "p" }, `${prov?.name ?? "—"} · ${simulateMode() ? "演示模式" : prov?.verifiedAt ? (m.price ?? m.modelId) : "连接未配置凭据"}`));
  }));
  return h("div", {}, wrap, h("div", { class: "help", style: "margin-top:6px" }, "模型和凭据在 ", h("a", { class: "link", onclick: () => showView("settings") }, "设置 → 模型"), " 中统一管理"));
}
function savebar(label, onSave, onCancel) {
  return h("div", { class: "savebar" + (isDirty() ? "" : " clean"), id: "savebar" },
    h("span", { class: "hint" }, label), h("button", { onclick: onCancel }, st.sel.id ? "放弃修改" : "取消"), h("button", { class: "primary", onclick: onSave }, st.sel.id ? "保存" : "创建"));
}

// ---------- 智能体编辑 ----------
function agentEditor() {
  const d = st.draft;
  const others = studio.agents().filter((a) => a.name !== st.sel.id);
  const deleg = d.delegation === "any" ? "any" : d.delegation === "none" ? "none" : "list";
  const skillChips = h("div", { class: "chips" },
    d.skills.map((id) => {
      const s = studio.skill(id);
      return h("span", { class: "chip", title: s?.description ?? "", onclick: () => selectStudio("skill", id) },
        h("span", { class: "skill-icon" }, "✦"), s?.name ?? id,
        h("span", { class: "x", title: "移除", onclick: (e) => { e.stopPropagation(); toggleIn(d.skills, id, false); renderStudio(); touch(); } }, "×"));
    }),
    select([["", "+ 添加已有技能"], ...studio.skills().filter((s) => !d.skills.includes(s.id)).map((s) => [s.id, s.name])], "",
      (v) => { if (v) { d.skills.push(v); renderStudio(); touch(); } }, { style: "width:auto" }),
    h("a", { class: "link", style: "font-size:13px", onclick: () => selectStudio("skill", null, { attachTo: st.sel.id }) }, "+ 新建技能"));

  const save = async () => {
    try {
      const orig = st.sel.id;
      const a = await studio.saveAgent(d, orig);
      st.sel.id = a.name;
      loadDraft();
      renderStudio();
      renderAssigneeFilter();
      toast(`已保存 ${a.name}`, "ok");
    } catch (e) { fail(e); }
  };
  return [
    h("div", { class: "ed-head" },
      h("span", { class: "avatar lg", style: `--hue:${hue(d.name || "?")}` }, (d.name || "?")[0].toUpperCase()),
      h("div", {}, h("h2", {}, st.sel.id, h("span", { class: "model-chip" }, (studio.agent(st.sel.id)?.runtime ?? "builtin") === "builtin" ? modelShort(studio.agent(st.sel.id)?.model) : `${rtDef(studio.agent(st.sel.id)?.runtime).short}${studio.agent(st.sel.id)?.cliModel ? " · " + studio.agent(st.sel.id).cliModel : ""}`)), h("div", { class: "sub" }, studio.agent(st.sel.id)?.description || "—")),
      h("div", { class: "actions" },
        h("button", { onclick: () => { if (isDirty() && !confirm("放弃未保存的修改，用 AI 调整？")) return; loadDraft(); openBuilder(st.sel.id); } }, "✦ 用 AI 调整"),
        h("button", { class: "danger", onclick: () => {
          if (!confirm(`删除智能体 ${st.sel.id}？`)) return;
          studio.deleteAgent(st.sel.id).then(() => {
            st.sel = { kind: "agent", id: studio.agents()[0]?.name ?? null };
            loadDraft(); renderStudio(); renderAssigneeFilter();
          }).catch(fail);
        } }, "删除"))),
    section("基本信息", "名称用于指派和委派，描述会展示给其他智能体，帮助它们判断该找谁。",
      field("名称", textIn(d, "name", { placeholder: "如 weekly-reporter" }), "字母、数字、- 和 _"),
      field("描述", textIn(d, "description", { placeholder: "一句话说明它负责什么" }))),
    section("运行底座", "这个智能体实际在哪里运行。编码类任务建议交给 Claude Code 等 CLI 智能体，在项目仓库的独立工作目录里改代码、提 PR。",
      runtimePicker(d)),
    section("模型", (d.runtime ?? "builtin") === "builtin" ? "不同智能体可以用不同模型：难题用强模型，高频简单任务用快模型。" : `由 ${rtDef(d.runtime).name} 调用模型。`,
      (d.runtime ?? "builtin") === "builtin"
        ? [modelPicker(d), field("思考强度", select(EFFORTS, d.effort, (v) => { d.effort = v; touch(); }, { style: "max-width:320px" }), "越高越仔细，也越慢、越贵")]
        : cliModelField(d)),
    section("技能", "技能是可复用的专业指令。智能体平时只看到技能名称和「何时使用」，需要时才加载完整指令。", skillChips),
    section("系统提示词", "定义角色、职责、工作方式和输出要求。",
      textIn(d, "system", { multiline: true, class: "prompt-area", placeholder: "你是……负责……" })),
    section("协作", "能否把子任务交给其他智能体，以及订阅哪些消息主题。",
      field("委派", select([["none", "不能委派"], ["any", "可以委派给任何智能体"], ["list", "只能委派给指定智能体"]], deleg, (v) => {
        d.delegation = v === "list" ? [] : v;
        renderStudio(); touch();
      }, { style: "max-width:320px" })),
      deleg === "list" ? h("div", { class: "checks" }, others.map((o) => checkbox(d.delegation.includes(o.name), (on) => toggleIn(d.delegation, o.name, on), o.name, o.description))) : null,
      field("订阅主题", listIn(d, "subscribe", "如 drafts, reviews（逗号分隔）"), "主题上有新消息时自动唤醒这个智能体")),
    section("工具", "内置工具始终可用；文件、命令类会真的在服务器上读写执行，按需开启。",
      field("始终可用", (() => {
        const meta = (S.builtinTools ?? []).filter((t) => t.always);
        const byGroup = {};
        for (const t of meta) (byGroup[t.group] ??= []).push(t.name);
        return h("div", { class: "chips" }, Object.entries(byGroup).map(([g, names]) => h("span", { class: "chip", style: "padding:0 8px;cursor:default", title: names.join("、") }, `${g} ${names.length}`)));
      })(), "协作、工作项、流程、检索类；具体清单见左侧「工具目录」"),
      h("div", { class: "checks" },
        checkbox(d.serverTools.includes("web_search"), (on) => toggleIn(d.serverTools, "web_search", on), "联网搜索", "web_search，由 Anthropic 服务端执行"),
        checkbox(d.serverTools.includes("web_fetch"), (on) => toggleIn(d.serverTools, "web_fetch", on), "网页抓取", "web_fetch，读取对话中出现的链接")),
      field("扩展工具", builtinToolToggles(d),
        "开启文件或命令工具后，这个任务会在项目仓库的独立工作目录里执行；命令受超时与输出上限约束，路径不能逃出该目录"),
      field("自定义工具", st.realTools.length
        ? h("div", { class: "checks" }, st.realTools.map((t) => checkbox(d.tools.includes(t.name), (on) => toggleIn(d.tools, t.name, on), t.name, t.description)))
        : h("div", { class: "muted", style: "font-size:13px" }, "还没有注册 webhook 工具")),
      field("MCP 服务器", st.realMcp.length
        ? h("div", { class: "checks" }, st.realMcp.map((m) => checkbox(d.mcp.includes(m.name), (on) => toggleIn(d.mcp, m.name, on), m.name, m.transport === "stdio" ? m.command : m.url)))
        : h("div", { class: "muted", style: "font-size:13px" }, "还没有注册 MCP 服务器"))),
    section("高级", null,
      field("最大轮数", (() => { const el = h("input", { type: "number", min: 1, max: 200, style: "max-width:120px", oninput: (e) => { d.maxTurns = Number(e.target.value) || 30; touch(); } }); el.value = d.maxTurns; return el; })(),
        "单次运行中与模型往返的上限，防止失控")),
    savebar("有未保存的修改", save, () => { loadDraft(); renderStudio(); }),
  ];
}

// ---------- 技能编辑 ----------
function skillEditor() {
  const d = st.draft;
  const isNew = st.sel.id == null;
  const users = isNew ? [] : studio.usage(st.sel.id);
  const save = async () => {
    try {
      const s = await studio.saveSkill(d, st.sel.id);
      if (isNew && st.attachTo) {
        const a = clone(studio.agent(st.attachTo));
        if (a && !a.skills.includes(s.id)) { a.skills.push(s.id); await studio.saveAgent(a, a.name); }
        toast(`已创建技能「${s.name}」并添加到 ${st.attachTo}`, "ok");
        st.sel = { kind: "agent", id: st.attachTo };
        st.attachTo = null;
      } else {
        toast(isNew ? `已创建技能「${s.name}」` : `已保存「${s.name}」`, "ok");
        st.sel = { kind: "skill", id: s.id };
      }
      loadDraft();
      renderStudio();
    } catch (e) { fail(e); }
  };
  const cancel = () => {
    if (isNew) { st.draft = null; const back = st.attachTo; st.attachTo = null; st.sel = back ? { kind: "agent", id: back } : { kind: "agent", id: studio.agents()[0]?.name }; loadDraft(); renderStudio(); }
    else { loadDraft(); renderStudio(); }
  };
  return [
    h("div", { class: "ed-head" },
      h("span", { class: "skill-icon lg" }, "✦"),
      h("div", {}, h("h2", {}, isNew ? "新建技能" : studio.skill(st.sel.id)?.name),
        h("div", { class: "sub" }, isNew ? (st.attachTo ? `创建后会添加到 ${st.attachTo}` : "可复用的专业指令，可挂到任意智能体上") : `${users.length} 个智能体在用 · 创建者 ${d.createdBy ?? ME}`)),
      !isNew ? h("div", { class: "actions" }, h("button", { class: "danger", onclick: () => {
        if (!confirm(`删除技能「${d.name}」？${users.length ? `\n${users.join("、")} 将不再使用它。` : ""}`)) return;
        studio.deleteSkill(st.sel.id).then(() => {
          st.sel = { kind: "agent", id: studio.agents()[0]?.name };
          loadDraft(); renderStudio();
        }).catch(fail);
      } }, "删除")) : null),
    section("基本信息", "「何时使用」决定智能体在什么情况下加载这个技能，写得越具体越准。",
      field("名称", textIn(d, "name", { placeholder: "如 周报模板" })),
      field("标识", textIn(d, "id", { placeholder: "如 weekly-report" }), "英文标识，智能体通过它加载技能"),
      field("何时使用", textIn(d, "description", { placeholder: "如 生成周报、月报等定期汇报时使用" }))),
    section("指令", "加载技能后智能体会读到的完整内容，支持 Markdown。可以写步骤、模板、检查清单、示例。",
      textIn(d, "instructions", { multiline: true, class: "prompt-area", placeholder: "## 步骤\n\n1. …\n2. …" })),
    !isNew ? section("使用者", "在智能体的「技能」里添加或移除。",
      users.length ? h("div", { class: "chips" }, users.map((n) => h("span", { class: "chip", onclick: () => selectStudio("agent", n) }, avatar(n), n, h("span", { style: "width:4px" }))))
        : h("div", { class: "muted", style: "font-size:13px" }, "还没有智能体使用这个技能")) : null,
    savebar(isNew ? "新技能尚未创建" : "有未保存的修改", save, cancel),
  ];
}

/**
 * 用一段现成的技能素材建技能：粘贴 prompt 正文，或给一个地址由服务器抓取。
 * 整理结果先进编辑器，用户确认后再保存——AI 起草的东西不该直接进库。
 */
function openSkillImporter() {
  const text = h("textarea", { class: "prompt-area", style: "min-height:160px", placeholder: "把技能说明粘进来。可以是一段 prompt、一份规范、一个检查清单……" });
  const url = h("input", { placeholder: "或者填一个 https 地址，如 https://…/skill.md（可选）" });
  const note = h("span", { class: "muted", style: "font-size:12.5px" });
  const go = async (btn) => {
    if (!text.value.trim() && !url.value.trim()) return note.textContent && toast("先粘贴内容或填地址", "err");
    btn.disabled = true; note.textContent = "正在整理…";
    try {
      const d = await rpc("assistant.draftSkill", { text: text.value, url: url.value.trim() });
      closeModal(true);
      selectStudio("skill", null);
      // 已经存在同名标识时加后缀，避免直接覆盖别人的技能
      let id = d.id;
      while (studio.skill(id)) id = `${d.id}-${Math.random().toString(36).slice(2, 6)}`;
      st.draft = { id, name: d.name, description: d.description, instructions: d.instructions, createdBy: ME };
      renderStudio();
      toast(`已整理成技能「${d.name}」，确认后保存`, "ok");
    } catch (e) { note.textContent = ""; fail(e); } finally { btn.disabled = false; }
  };
  const submit = h("button", { class: "primary", onclick: (e) => go(e.currentTarget) }, "交给 AI 整理");
  fill($("#modal"), h("div", { class: "modal", onclick: (e) => e.stopPropagation() },
    h("div", { class: "dr-head" }, h("span", {}, "用 AI 新建技能")),
    h("div", { class: "fields" },
      text,
      h("div", { class: "row", style: "gap:10px;align-items:center" }, url),
      h("div", { class: "help" }, "地址只支持 https，由 Hub 服务器抓取后整理；整理结果先进编辑器，不会直接入库。")),
    h("div", { class: "modal-foot" }, note, h("span", { style: "margin-left:auto" }),
      h("button", { onclick: () => closeModal() }, "取消"), submit)));
  $("#modal").classList.add("open"); $("#modal").setAttribute("aria-hidden", "false");
  setTimeout(() => text.focus());
}

// ---------- 工具 / MCP（真实数据，只读） ----------
/** 可选的内置工具：默认全关，按智能体开启。risk 决定标记颜色 */
function builtinToolToggles(d) {
  const meta = (S.builtinTools ?? []).filter((t) => t.always === false);
  d.builtinTools ??= [];
  if (!meta.length) return h("div", { class: "muted", style: "font-size:13px" }, "没有可选的扩展工具");
  return h("div", { class: "checks" }, meta.map((t) => {
    const marked = t.risk === "exec" ? h("span", { class: "err-text" }, "可执行命令")
      : t.risk === "write" ? h("span", { style: "color:var(--accent)" }, "可写文件")
      : null;
    return checkbox(d.builtinTools.includes(t.name), (on) => toggleIn(d.builtinTools, t.name, on), t.name,
      h("span", {}, t.desc, marked ? h("span", { style: "margin-left:6px;font-size:11.5px" }, `· ${marked.textContent}`) : null));
  }));
}

function toolsView() {
  const meta = S.builtinTools ?? [];
  const groups = [...new Set(meta.map((t) => t.group))];
  const usageOf = (name, always) => {
    if (always) return "全部智能体";
    const names = studio.agents().filter((a) => (a.builtinTools ?? []).includes(name)).map((a) => a.name);
    return names.length ? names.join("、") : "未启用";
  };
  const riskTag = (r) => (r === "exec" ? h("span", { class: "tag", style: "color:var(--failed);border-color:currentColor" }, "执行")
    : r === "write" ? h("span", { class: "tag", style: "color:var(--accent);border-color:currentColor" }, "写入")
    : r === "read" ? h("span", { class: "tag" }, "只读") : null);

  const form = sg.toolForm;
  const toolForm = form ? (() => {
    const f = { name: "", description: "", url: "", timeoutMs: 60000, input_schema: '{"type":"object","properties":{}}', ...form };
    const name = h("input", { placeholder: "如 lookup_order（字母数字下划线）", oninput: (e) => (f.name = e.target.value) });
    name.value = f.name;
    const desc = h("input", { placeholder: "一句话说明这个工具做什么", oninput: (e) => (f.description = e.target.value) });
    desc.value = f.description;
    const url = h("input", { placeholder: "https://example.com/hooks/lookup_order", oninput: (e) => (f.url = e.target.value) });
    url.value = f.url;
    const timeout = h("input", { type: "number", min: 1, max: 600, style: "max-width:120px", oninput: (e) => (f.timeoutMs = Number(e.target.value) * 1000 || 60000) });
    timeout.value = Math.round(f.timeoutMs / 1000);
    const schema = h("textarea", { class: "prompt-area", style: "min-height:110px;font-family:var(--mono)", oninput: (e) => (f.input_schema = e.target.value) }, f.input_schema);
    const status = h("span", { style: "font-size:12.5px" });
    const save = async () => {
      let parsed;
      try { parsed = JSON.parse(f.input_schema || "{}"); }
      catch { status.className = "err-text"; status.textContent = "input_schema 不是合法 JSON"; return; }
      status.className = "muted"; status.textContent = "保存中…";
      try {
        await rpc("studio.saveTool", { name: f.name.trim(), description: f.description.trim(), url: f.url.trim(), timeoutMs: f.timeoutMs, input_schema: parsed, headers: {} });
        sg.toolForm = null;
        await Promise.all([refreshState(), reloadStudioData()]); renderStudio();
        toast(`已保存工具 ${f.name}`, "ok");
      } catch (err) { status.className = "err-text"; status.textContent = err.message; }
    };
    return h("div", { class: "card" },
      h("div", { class: "ttl" }, form.name ? `编辑 ${form.name}` : "新建自定义工具"),
      field("名称", name, "调用时模型看到的名字，不能与内置工具重名"),
      field("说明", desc, "模型据此判断什么时候调用，写清楚输入输出"),
      field("地址", url, "Hub 会 POST {input, context:{taskId, agent}} 到这个地址，期望返回 {content} 或纯文本"),
      field("超时", h("div", { class: "row" }, timeout, h("span", { class: "muted", style: "font-size:12.5px" }, "秒"))),
      field("input_schema", schema, "JSON Schema，描述参数结构"),
      h("div", { class: "row" },
        h("button", { class: "primary", onclick: save }, "保存"),
        h("button", { onclick: () => { sg.toolForm = null; renderStudio(); } }, "取消"),
        status));
  })() : null;

  return [
    h("div", { class: "ed-head" }, h("div", {}, h("h2", {}, "工具目录"), h("div", { class: "sub" }, "智能体能调用的全部能力：内置的始终可用，扩展的按智能体开启"))),
    h("div", { class: "ed-section" }, h("div", { class: "lbl" }, h("b", {}, "内置工具"), h("span", {}, "由 Hub 直接实现，不需要额外依赖")),
      h("div", { class: "fields" }, groups.map((g) => h("div", {},
        h("b", { style: "font-size:13px" }, g),
        h("table", { class: "map-table", style: "width:100%;margin-top:6px" },
          h("tr", {}, h("th", {}, "工具"), h("th", {}, "作用"), h("th", {}, "级别"), h("th", {}, "谁在用")),
          meta.filter((t) => t.group === g).map((t) => h("tr", {},
            h("td", {}, h("code", {}, t.name)),
            h("td", { style: "font-size:12.5px" }, t.desc),
            h("td", {}, riskTag(t.risk) ?? h("span", { class: "muted", style: "font-size:12px" }, "无副作用")),
            h("td", { class: "muted", style: "font-size:12px;max-width:260px" }, usageOf(t.name, t.always))))))))),
    h("div", { class: "ed-section" }, h("div", { class: "lbl" }, h("b", {}, "自定义工具"), h("span", {}, `HTTP webhook 实现，${st.realTools.length} 个`)),
      h("div", { class: "fields" },
        st.realTools.length ? h("div", { class: "grid" }, st.realTools.map((t) => h("div", { class: "card" },
          h("div", { class: "row" }, h("b", {}, t.name), h("span", { style: "margin-left:auto" }),
            h("button", { onclick: () => { sg.toolForm = { ...t, input_schema: JSON.stringify(t.input_schema, null, 2) }; renderStudio(); } }, "编辑"),
            h("button", { class: "danger", onclick: () => { if (!confirm(`删除工具 ${t.name}？使用它的智能体会失去这个能力。`)) return; rpc("studio.deleteTool", t.name).then(async () => { await Promise.all([refreshState(), reloadStudioData()]); renderStudio(); toast("已删除", "ok"); }).catch(fail); } }, "删除")),
          h("div", { class: "muted" }, t.description),
          kv(["URL", h("code", {}, t.url), "超时", `${t.timeoutMs} ms`], { style: "margin-top:6px" }),
          h("details", {}, h("summary", { class: "muted" }, "input_schema"), h("pre", {}, JSON.stringify(t.input_schema, null, 2))))))
          : h("div", { class: "muted", style: "font-size:13px" }, "还没有自定义工具。适合把内部系统的查询能力接进来，例如查订单、查日志、触发构建。"),
        toolForm ?? h("div", {}, h("a", { class: "link", style: "font-size:13px", onclick: () => { sg.toolForm = {}; renderStudio(); } }, "+ 新建自定义工具")))),
  ];
}
/** 常用 MCP 服务器预设：点一下就把表单填好，只留需要用户决定的部分（令牌、路径、连接串） */
const MCP_PRESETS = [
  { name: "playwright", label: "Playwright", desc: "浏览器自动化：打开页面、点击、填表、截图、读控制台与网络请求。验收前端改动最有用。", transport: "stdio", command: "npx", args: "-y\n@playwright/mcp@latest", env: "", needs: null },
  { name: "context7", label: "Context7 文档", desc: "按库名查最新版本文档，避免模型用过期 API。", transport: "stdio", command: "npx", args: "-y\n@upstash/context7-mcp@latest", env: "", needs: null },
  { name: "sequential-thinking", label: "结构化思考", desc: "把复杂问题拆成可回溯的推理步骤，适合排障与方案权衡。", transport: "stdio", command: "npx", args: "-y\n@modelcontextprotocol/server-sequential-thinking", env: "", needs: null },
  { name: "memory", label: "长期记忆", desc: "跨会话保存实体与关系，适合需要记住项目约定的智能体。", transport: "stdio", command: "npx", args: "-y\n@modelcontextprotocol/server-memory", env: "MEMORY_FILE_PATH=<改成服务器上一个可写路径>", needs: "填一个可写路径" },
  { name: "filesystem", label: "文件系统", desc: "按目录读写文件。Hub 已内置 worktree 内的读写工具，这个用于访问额外目录。", transport: "stdio", command: "npx", args: "-y\n@modelcontextprotocol/server-filesystem\n<改成要开放的绝对路径>", env: "", needs: "填要开放的目录" },
  { name: "postgres", label: "PostgreSQL", desc: "只读查询数据库，适合排查数据问题、核对线上状态。", transport: "stdio", command: "npx", args: "-y\n@modelcontextprotocol/server-postgres\npostgresql://user:pass@host:5432/db", env: "", needs: "替换连接串" },
  { name: "fetch", label: "网页抓取", desc: "抓取网页并转成 Markdown。需要服务器装有 uv。", transport: "stdio", command: "uvx", args: "mcp-server-fetch", env: "", needs: "需要 uv" },
  { name: "github-remote", label: "GitHub（托管）", desc: "GitHub 官方远程 MCP，读写 issue、PR、代码。", transport: "http", url: "https://api.githubcopilot.com/mcp/", headers: "Authorization: Bearer <粘贴 GitHub 令牌>", needs: "填 GitHub 令牌" },
  { name: "github", label: "GitHub（本地）", desc: "GitHub MCP 的本地实现，用 npx 启动。", transport: "stdio", command: "npx", args: "-y\n@modelcontextprotocol/server-github", env: "GITHUB_PERSONAL_ACCESS_TOKEN=<粘贴 GitHub 令牌>", needs: "填 GitHub 令牌" },
];

function mcpView() {
  const form = sg.mcpForm;
  const linesOf = (pairs) => pairs.map(([k, v]) => `${k}=${v}`).join("\n");
  const mcpForm = form ? (() => {
    const f = { name: "", transport: "stdio", command: "", args: "", env: "", url: "", headers: "", timeoutMs: 120000, ...form };
    const name = h("input", { placeholder: "如 github（字母数字下划线）", oninput: (e) => (f.name = e.target.value) });
    name.value = f.name;
    const transport = select([["stdio", "stdio：在服务器上启动一个进程"], ["http", "http：连接远程 MCP 服务"]], f.transport, (v) => { f.transport = v; sg.mcpForm = { ...f }; renderStudio(); }, { style: "max-width:340px" });

    const command = h("input", { placeholder: "npx", oninput: (e) => (f.command = e.target.value) });
    command.value = f.command;
    const args = h("textarea", { class: "prompt-area", style: "min-height:56px;font-family:var(--mono)", placeholder: "每行一个参数，例如：\n-y\n@modelcontextprotocol/server-github", oninput: (e) => (f.args = e.target.value) }, f.args);
    const env = h("textarea", { class: "prompt-area", style: "min-height:56px;font-family:var(--mono)", placeholder: "每行一个，KEY=VALUE，例如：\nGITHUB_PERSONAL_ACCESS_TOKEN=github_pat_xxx", oninput: (e) => (f.env = e.target.value) }, f.env);
    const url = h("input", { placeholder: "https://api.githubcopilot.com/mcp/", oninput: (e) => (f.url = e.target.value) });
    url.value = f.url;
    const headers = h("textarea", { class: "prompt-area", style: "min-height:56px;font-family:var(--mono)", placeholder: "每行一个，KEY: VALUE，例如：\nAuthorization: Bearer github_pat_xxx", oninput: (e) => (f.headers = e.target.value) }, f.headers);
    const timeout = h("input", { type: "number", min: 1, max: 600, style: "max-width:120px", oninput: (e) => (f.timeoutMs = Number(e.target.value) * 1000 || 120000) });
    timeout.value = Math.round(f.timeoutMs / 1000);
    const status = h("span", { style: "font-size:12.5px" });

    const save = async () => {
      const parsePairs = (text, sep) => Object.fromEntries(text.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => {
        const i = l.indexOf(sep);
        return i < 0 ? ["", ""] : [l.slice(0, i).trim(), l.slice(i + sep.length).trim()];
      }).filter(([k]) => k));
      const payload = f.transport === "stdio"
        ? { name: f.name.trim(), transport: "stdio", command: f.command.trim(), args: f.args.split("\n").map((x) => x.trim()).filter(Boolean), env: parsePairs(f.env, "="), timeoutMs: f.timeoutMs }
        : { name: f.name.trim(), transport: "http", url: f.url.trim(), headers: parsePairs(f.headers, ":"), timeoutMs: f.timeoutMs };
      status.className = "muted"; status.textContent = "保存中…";
      try {
        await rpc("studio.saveMcp", payload);
        sg.mcpForm = null;
        await Promise.all([refreshState(), reloadStudioData()]); renderStudio();
        toast(`已保存 MCP 服务器 ${f.name}`, "ok");
      } catch (err) { status.className = "err-text"; status.textContent = err.message; }
    };

    return h("div", { class: "card" },
      h("div", { class: "ttl" }, form.name ? `编辑 ${form.name}` : "新建 MCP 服务器"),
      h("div", { class: "muted", style: "font-size:12.5px;margin-bottom:6px" }, "从下方「常用服务器」点一个预设可以自动填好，也可以手动填写。"),
      field("名称", name, "智能体通过这个名字勾选它"),
      field("传输方式", transport, "stdio 会在服务器上启动进程；http 连接远程服务，可带认证头"),
      f.transport === "stdio"
        ? [field("命令", command, "可执行文件，如 npx、uvx、node"), field("参数", args), field("环境变量", env, "只保存在服务端，不会显示回浏览器")]
        : [field("地址", url), field("请求头", headers, "用于认证，只保存在服务端")],
      field("超时", h("div", { class: "row" }, timeout, h("span", { class: "muted", style: "font-size:12.5px" }, "秒"))),
      h("div", { class: "row" },
        h("button", { class: "primary", onclick: save }, "保存"),
        h("button", { onclick: () => { sg.mcpForm = null; renderStudio(); } }, "取消"),
        status));
  })() : null;

  return [
    h("div", { class: "ed-head" }, h("div", {}, h("h2", {}, "MCP 服务器"), h("div", { class: "sub" }, "Hub 作为 MCP 客户端连接外部工具服务；注册后在智能体的「工具」里勾选启用"))),
    h("div", { class: "ed-section" }, h("div", { class: "fields" },
      h("div", { class: "callout" },
        h("div", {}, h("b", {}, "这里的 GitHub 只给智能体用，不会让 Hub 获得仓库授权。"),
          h("div", { class: "muted", style: "font-size:12.5px;margin-top:4px" },
            "绑定仓库、克隆代码、提交 PR 由 Hub 自己做，需要在「设置 → 集成与通知 → GitHub」或「项目设置」里单独连接。两处可以用同一个令牌。"))))),
    h("div", { class: "ed-section" }, h("div", { class: "lbl" }, h("b", {}, "已注册"), h("span", {}, `${st.realMcp.length} 个服务器`)),
      h("div", { class: "fields" },
        st.realMcp.length ? h("div", { class: "grid" }, st.realMcp.map((m) => {
          const out = h("div", {});
          const used = studio.agents().filter((a) => (a.mcp ?? []).includes(m.name)).map((a) => a.name);
          return h("div", { class: "card" },
            h("div", { class: "row" }, h("b", {}, m.name), h("span", { class: "tag" }, m.transport),
              h("span", { style: "margin-left:auto" }),
              h("button", { onclick: async (e) => {
                e.target.disabled = true; fill(out, h("span", { class: "muted" }, "连接中…"));
                try { const ts = await api(`/mcp-servers/${m.name}/tools`); fill(out, h("div", { class: "s-completed" }, `✓ ${ts.length} 个工具`), h("div", { class: "muted", style: "font-size:13px" }, ts.map((t) => t.name).join(", "))); }
                catch (err) { fill(out, h("div", { class: "s-failed" }, err.message)); }
                e.target.disabled = false;
              } }, "检测连接"),
              h("button", { onclick: () => {
                sg.mcpForm = m.transport === "stdio"
                  ? { ...m, args: (m.args ?? []).join("\n"), env: linesOf(Object.entries(m.env ?? {})) }
                  : { ...m, headers: linesOf(Object.entries(m.headers ?? {})), command: "", args: "", env: "" };
                renderStudio();
              } }, "编辑"),
              h("button", { class: "danger", onclick: () => {
                if (!confirm(`删除 ${m.name}？${used.length ? `${used.join("、")} 将失去这些工具。` : ""}`)) return;
                rpc("studio.deleteMcp", m.name).then(async () => { await Promise.all([refreshState(), reloadStudioData()]); renderStudio(); toast("已删除", "ok"); }).catch(fail);
              } }, "删除")),
            h("code", { class: "muted" }, m.transport === "stdio" ? [m.command, ...(m.args ?? [])].join(" ") : m.url),
            used.length ? h("div", { class: "muted", style: "font-size:12px;margin-top:6px" }, `使用者：${used.join("、")}`) : h("div", { class: "muted", style: "font-size:12px;margin-top:6px" }, "还没有智能体使用"),
            out);
        })) : h("div", { class: "muted", style: "font-size:13px" }, "还没有注册 MCP 服务器。"),
        mcpForm ?? h("div", {}, h("a", { class: "link", style: "font-size:13px", onclick: () => { sg.mcpForm = {}; renderStudio(); } }, "+ 新建 MCP 服务器")))),
    h("div", { class: "ed-section" }, h("div", { class: "lbl" }, h("b", {}, "常用服务器"), h("span", {}, "点「填入」把表单填好，需要令牌或路径的已标出")),
      h("div", { class: "fields" }, h("div", { class: "grid" }, MCP_PRESETS.map((p) => {
        const registered = st.realMcp.some((m) => m.name === p.name);
        return h("div", { class: "card" },
          h("div", { class: "row" }, h("b", {}, p.label), h("span", { class: "tag" }, p.transport),
            registered ? h("span", { class: "tag", style: "color:var(--accent);border-color:currentColor" }, "已注册") : null,
            h("span", { style: "margin-left:auto" }),
            h("button", { onclick: () => {
              sg.mcpForm = { name: p.name, transport: p.transport, command: p.command ?? "", args: p.args ?? "", env: p.env ?? "", url: p.url ?? "", headers: p.headers ?? "", timeoutMs: 180000 };
              renderStudio();
              $("#studioMain").scrollTop = 0;
            } }, registered ? "重新填入" : "填入")),
          h("div", { class: "muted", style: "font-size:12.5px;margin-top:4px" }, p.desc),
          p.needs ? h("div", { class: "muted", style: "font-size:12px;margin-top:4px" }, `需要：${p.needs}`) : null);
      })))),
  ];
}

// ======================= AI 构建器 =======================
const bd = { open: false, mode: "create", target: null, draft: null, newSkills: [], msgs: [], busy: false, changed: new Set(), turn: 0, input: "" };
const BLANK_AGENT = () => ({ name: "", description: "", model: settings.get().defaultModel, effort: settings.get().defaultEffort, system: "", skills: [], delegation: "none", subscribe: [], serverTools: [], tools: [], mcp: [], maxTurns: 30 });
const TEMPLATES = [
  { re: /周报|日报|月报|汇报|总结/, name: "weekly-reporter", model: "claude-sonnet-5-5", effort: "medium", why: "例行写作，Sonnet 又快又省",
    description: "汇总一段时间的工作进展，生成结构化周报", reuse: ["chinese-copy"],
    newSkills: [{ id: "weekly-report", name: "周报模板", description: "生成周报、月报等定期汇报时使用", instructions: "## 周报结构\n\n1. 本周完成（按项目分组，尽量量化）\n2. 进行中与风险\n3. 下周计划\n4. 需要的支持" }],
    ask: ["工作记录从哪里来？手动粘贴、工作项看板，还是某个 MCP 工具？", "按团队还是按个人出周报？"] },
  { re: /代码|审查|review|\bpr\b|重构|bug/i, name: "code-reviewer", model: "claude-opus-5-5", effort: "high", why: "代码审查需要较强推理",
    description: "审查代码变更，指出缺陷、风险与改进建议", reuse: [],
    newSkills: [{ id: "code-review-checklist", name: "代码审查清单", description: "审查代码变更时使用", instructions: "## 审查清单\n\n- 正确性：边界条件、错误处理、并发\n- 安全：输入校验、权限、敏感信息\n- 可维护性：命名、重复、复杂度\n- 测试：是否覆盖新增逻辑\n\n按严重程度从高到低输出。" }],
    ask: ["主要审查哪些语言或仓库？", "需要它直接给出修改补丁，还是只提意见？"] },
  { re: /客服|答疑|faq|咨询|问答|售后/i, name: "support-agent", model: "claude-haiku-5-5", effort: "low", why: "高频简单问答，Haiku 最快最省",
    description: "回答用户的常见问题，必要时转人工", reuse: ["chinese-copy"],
    newSkills: [{ id: "support-playbook", name: "答疑话术", description: "回复用户咨询时使用", instructions: "## 答疑原则\n\n1. 先确认问题，再给答案\n2. 答案控制在 3 句以内，附操作步骤\n3. 涉及退款、账号安全时转人工\n4. 不确定就说不确定，不要编造" }],
    ask: ["知识来源是什么？文档链接还是知识库 MCP？", "遇到答不了的问题，转给谁？"] },
  { re: /翻译|英文|日文|translate/i, name: "translator", model: "claude-sonnet-5-5", effort: "medium", why: "翻译质量与速度兼顾",
    description: "在中英文之间翻译文档，保持术语一致", reuse: [],
    newSkills: [{ id: "glossary-translation", name: "术语表翻译", description: "翻译含专业术语的文档时使用", instructions: "## 翻译要求\n\n- 术语优先使用术语表中的译法\n- 保留原文格式（标题、列表、代码块）\n- 意译优先于直译，但不增删信息" }],
    ask: ["主要是哪两种语言互译？", "有没有必须统一的术语表？"] },
  { re: /调研|研究|资料|竞品|分析|行业/, name: "analyst", model: "claude-opus-5-5", effort: "high", why: "调研需要多步推理和联网", serverTools: ["web_search", "web_fetch"],
    description: "围绕给定问题做调研分析，输出带来源的结论", reuse: ["web-research", "report-writing"], newSkills: [],
    ask: ["调研结果给谁看？需要多深入？", "有没有指定的信息来源或需要排除的来源？"] },
];
const GENERIC = { name: "assistant", model: "claude-opus-5-5", effort: "medium", why: "默认模型，综合能力最均衡", description: "", reuse: [], newSkills: [],
  ask: ["它的产出交给谁、以什么格式？", "需要联网，或者调用其他智能体吗？"] };
const SUGGESTS = ["帮我做一个每周写周报的助手", "一个审查代码的智能体", "客服答疑，要快要省", "做竞品调研并出报告"];

function uniqueName(base) { let n = base, i = 2; while (studio.agent(n)) n = `${base}-${i++}`; return n; }
function uniqueSkillId(base) { let n = base, i = 2; while (studio.skill(n) || bd.newSkills.some((s) => s.id === n)) n = `${base}-${i++}`; return n; }
const bSkill = (id) => bd.newSkills.find((s) => s.id === id) ?? studio.skill(id);
const skillNames = (ids) => ids.map((id) => `「${bSkill(id)?.name ?? id}」`).join("、") || "暂无";

function mockBuilderReply(text) {
  const d = bd.draft;
  const ch = (k) => bd.changed.add(k);
  if (bd.turn++ === 0 && bd.mode === "create") {
    const t = TEMPLATES.find((x) => x.re.test(text)) ?? GENERIC;
    d.name = uniqueName(t.name);
    d.description = t.description || text.slice(0, 40);
    d.model = t.model;
    d.effort = t.effort;
    d.serverTools = [...(t.serverTools ?? [])];
    d.system = `你是${d.description ? "负责「" + d.description + "」的智能体" : "一个智能体"}。\n\n## 用户的要求\n${text}\n\n## 工作方式\n- 先确认输入是否完整，缺信息时明确指出\n- 按相关技能的指令完成工作\n- 输出结构清晰，结论先行`;
    bd.newSkills = t.newSkills.map((s) => ({ ...s, id: uniqueSkillId(s.id), createdBy: "AI 助手" }));
    d.skills = [...t.reuse.filter((id) => studio.skill(id)), ...bd.newSkills.map((s) => s.id)];
    ["name", "model", "skills", "system", "tools"].forEach(ch);
    return `好的，我在右侧起草了「${d.name}」：\n\n· 职责：${d.description}\n· 模型：${modelShort(d.model)}（${t.why}）\n· 技能：${skillNames(d.skills)}${bd.newSkills.length ? "（标「新」的会随智能体一起创建）" : ""}\n\n还想确认两点：\n1. ${t.ask[0]}\n2. ${t.ask[1]}\n\n直接回复就行，也可以说「换成 Haiku」「加一个技能：xxx」「名字叫 xxx」。`;
  }
  const notes = [];
  const lower = text.toLowerCase();
  const m = MODELS.find((x) => lower.includes(x.id.split("-")[1]));
  if (m && m.id !== d.model) { d.model = m.id; ch("model"); notes.push(`模型换成了 ${m.name}：${m.desc}。`); }
  const nm = /(?:名字|名称|叫做?|改名为?)\s*[「"“']?([a-zA-Z0-9_-]{2,40})/.exec(text);
  if (nm) { d.name = nm[1]; ch("name"); notes.push(`名称改为 ${nm[1]}。`); }
  const sk = /(?:加|添加|新增|创建|新建)(?:一个|个)?技能[：:\s]*(.+)/.exec(text);
  if (sk) {
    const name = sk[1].split(/[，。,.\n]/)[0].trim().slice(0, 20) || "新技能";
    const s = { id: uniqueSkillId(studio.nextSkillId()), name, description: `需要「${name}」相关能力时使用`, createdBy: "AI 助手",
      instructions: `## ${name}\n\n（根据对话起草，可在「技能」里继续完善）\n\n1. 明确输入与期望输出\n2. 按步骤执行，每步自检\n3. 输出前对照验收标准检查` };
    bd.newSkills.push(s);
    d.skills.push(s.id);
    ch("skills");
    notes.push(`新建了技能「${name}」并挂到这个智能体上，指令先起草了一版，之后可以在「技能」里细改。`);
  } else {
    const reuse = studio.skills().find((s) => text.includes(s.name) && !d.skills.includes(s.id));
    if (reuse) { d.skills.push(reuse.id); ch("skills"); notes.push(`挂上了已有技能「${reuse.name}」。`); }
  }
  if (/去掉|移除|删掉/.test(text)) {
    const rm = d.skills.find((id) => text.includes(bSkill(id)?.name ?? "\u0000"));
    if (rm) { toggleIn(d.skills, rm, false); ch("skills"); notes.push(`移除了技能「${bSkill(rm).name}」。`); }
  }
  if (/联网|搜索|上网|查资料/.test(text) && !d.serverTools.includes("web_search")) { toggleIn(d.serverTools, "web_search", true); toggleIn(d.serverTools, "web_fetch", true); ch("tools"); notes.push("开启了联网搜索和网页抓取。"); }
  if (/委派|调用其他|分派|找其他/.test(text) && d.delegation === "none") { d.delegation = "any"; ch("tools"); notes.push("允许它把子任务委派给其他智能体。"); }
  if (/深入|仔细|更强|多想/.test(text)) { d.effort = "high"; ch("model"); notes.push("思考强度调到「高」。"); }
  if (/更快|省钱|便宜|成本/.test(text) && !m) { d.model = "claude-haiku-5-5"; d.effort = "low"; ch("model"); notes.push("为了更快更省，换成 Haiku 5.5，思考强度「低」。"); }
  if (!notes.length) {
    d.system = (d.system ? d.system + "\n\n" : "") + `## 补充要求\n${text}`;
    ch("system");
    notes.push("已把这条要求写进系统提示词。");
  }
  return `${notes.join("\n")}\n\n还有要调整的吗？满意的话点右下角「${bd.mode === "edit" ? "应用修改" : "创建智能体"}」。`;
}

function openBuilder(target) {
  Object.assign(bd, {
    open: true, mode: target ? "edit" : "create", target, draft: target ? clone(studio.agent(target)) : BLANK_AGENT(),
    newSkills: [], busy: false, changed: new Set(), turn: 0, input: "",
    msgs: [{ role: "ai", text: target
      ? `已载入「${target}」的当前配置（右侧）。想怎么调整？比如换模型、加一个技能、改写职责。`
      : "你好！描述一下你想要的智能体：它负责什么、产出什么、需要哪些能力。\n我会边聊边在右侧起草配置，技能也可以在对话里一起创建。" }],
  });
  fill($("#modal"), h("div", { class: "builder", onclick: (e) => e.stopPropagation() },
    h("div", { class: "b-head" }, h("span", { class: "ai-mark" }, "✦"),
      h("b", {}, target ? `用 AI 调整 · ${target}` : "用 AI 创建智能体"),
      demoFlag(""),
      h("span", { style: "margin-left:auto" }), h("button", { onclick: () => closeModal() }, "✕")),
    h("div", { class: "b-chat" }, h("div", { class: "b-msgs", id: "bMsgs" }), h("div", { class: "suggests", id: "bSuggests" }),
    h("div", { class: "b-input" },
        h("textarea", { id: "bInput", placeholder: "描述你的需要…（Enter 发送，Shift+Enter 换行）", oninput: (e) => (bd.input = e.target.value),
          onkeydown: (e) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); bSend(e.target.value); } } }),
        h("button", { class: "primary", onclick: () => bSend($("#bInput").value) }, "发送"))),
    h("div", { class: "b-draft", id: "bDraft" })));
  $("#modal").classList.add("open", "builder-wrap"); $("#modal").setAttribute("aria-hidden", "false");
  renderBMsgs();
  renderBDraft();
  setTimeout(() => $("#bInput")?.focus());
}

function renderBMsgs() {
  const box = $("#bMsgs");
  if (!box) return;
  fill(box, ...bd.msgs.map((m) => m.role === "ai"
      ? h("div", { class: "ai-row" }, h("span", { class: "ai-mark" }, "✦"), h("div", { class: "bubble ai" }, m.text))
      : h("div", { class: "bubble me" }, m.text)),
    ...(bd.busy ? [h("div", { class: "ai-row" }, h("span", { class: "ai-mark" }, "✦"), h("div", { class: "bubble ai typing" }, "正在思考"))] : []));
  box.scrollTop = box.scrollHeight;
  const sug = bd.mode === "create" && bd.turn === 0 ? SUGGESTS : bd.mode === "edit" && bd.turn === 0 ? ["换成 Sonnet", "加一个技能：输出前自检", "需要联网查资料"] : [];
  fill($("#bSuggests"), ...sug.map((s) => h("button", { onclick: () => bSend(s) }, s)));
}

function renderBDraft() {
  const d = bd.draft;
  const fl = (k) => (bd.changed.has(k) ? " flash" : "");
  const name = h("input", { placeholder: "名称（如 weekly-reporter）", oninput: (e) => (d.name = e.target.value.trim()) });
  name.value = d.name;
  const desc = h("input", { placeholder: "一句话描述", oninput: (e) => (d.description = e.target.value) });
  desc.value = d.description;
  const deleg = d.delegation === "any" ? "可委派给任何智能体" : d.delegation === "none" ? "不能委派" : `可委派给 ${d.delegation.join("、")}`;
  const commit = async () => {
    try {
      if (!d.name) throw new Error("先给智能体起个名称");
      for (const s of bd.newSkills.filter((s) => d.skills.includes(s.id) && !studio.skill(s.id))) await studio.saveSkill(s, null);
      const a = await studio.saveAgent(d, bd.mode === "edit" ? bd.target : null);
      const created = bd.mode === "create";
      closeModal(true);
      toast(created ? `已创建智能体 ${a.name}` : `已更新 ${a.name}`, "ok");
      st.sel = { kind: "agent", id: a.name };
      loadDraft();
      renderStudio();
      renderAssigneeFilter();
    } catch (e) { fail(e); }
  };
  fill($("#bDraft"), 
    h("div", { class: "card" + fl("name") },
      h("div", { class: "ttl" }, bd.mode === "edit" ? "调整后的配置" : "草稿"),
      h("div", { class: "row", style: "flex-wrap:nowrap" }, h("span", { class: "avatar lg", style: `--hue:${hue(d.name || "?")}` }, (d.name || "?")[0].toUpperCase()),
        h("div", { style: "flex:1;display:flex;flex-direction:column;gap:6px" }, name, desc))),
    h("div", { class: "card" + fl("model") }, h("div", { class: "ttl" }, "模型"),
      h("div", { class: "row" }, h("b", {}, MODELS.find((m) => m.id === d.model)?.name ?? d.model), h("span", { class: "model-chip" }, `思考强度 ${EFFORTS.find((e) => e[0] === d.effort)?.[1].split(" ·")[0]}`))),
    h("div", { class: "card" + fl("skills") }, h("div", { class: "ttl" }, `技能 ${d.skills.length}`),
      d.skills.length ? h("div", { class: "chips" }, d.skills.map((id) => {
        const s = bSkill(id);
        const isNew = bd.newSkills.some((x) => x.id === id);
        return h("span", { class: "chip" + (isNew ? " new" : ""), title: s?.instructions ?? "" }, h("span", { class: "skill-icon" }, "✦"), s?.name ?? id,
          isNew ? h("span", { class: "newtag" }, "新") : null,
          h("span", { class: "x", onclick: () => { toggleIn(d.skills, id, false); renderBDraft(); } }, "×"));
      })) : h("div", { class: "muted", style: "font-size:13px" }, "还没有技能")),
    h("div", { class: "card" + fl("tools") }, h("div", { class: "ttl" }, "工具与协作"),
      h("div", { style: "font-size:13px" }, [d.serverTools.includes("web_search") ? "联网搜索" : null, d.serverTools.includes("web_fetch") ? "网页抓取" : null, deleg].filter(Boolean).join(" · "))),
    h("details", { class: "card" + fl("system"), open: bd.changed.has("system") || null }, h("summary", { class: "ttl", style: "margin:0" }, "系统提示词"),
      h("pre", { style: "margin-top:8px" }, d.system || "（空）")),
    h("div", { class: "b-foot" }, h("span", { class: "hint" }, bd.mode === "edit" ? "应用后立即生效" : "创建后可在表单里继续细改"),
      h("button", { class: "primary", onclick: commit }, bd.mode === "edit" ? "应用修改" : "创建智能体")),
  );
  bd.changed.clear();
}

async function bSend(text) {
  text = (text ?? "").trim();
  if (!text || bd.busy) return;
  bd.msgs.push({ role: "me", text });
  bd.busy = true;
  bd.input = "";
  const input = $("#bInput");
  if (input) input.value = "";
  renderBMsgs();
  let reply;
  try {
    const r = await rpc("assistant.builder", { mode: bd.mode, draft: bd.draft, history: bd.msgs.slice(0, -1).map((m) => ({ role: m.role, text: m.text })), text });
    if (r?.fallback) reply = mockBuilderReply(text);
    else {
      reply = r.reply;
      Object.assign(bd.draft, r.draft);
      for (const sk of r.newSkills ?? []) if (!bd.newSkills.some((x) => x.id === sk.id)) bd.newSkills.push(sk);
      for (const k of r.changed ?? []) bd.changed.add(k);
      bd.turn++;
    }
  } catch (e) { reply = `出错了：${e.message}`; }
  if (!bd.open) return;
  bd.msgs.push({ role: "ai", text: reply });
  bd.busy = false;
  renderBMsgs();
  renderBDraft();
}

// ======================= 全局设置（密钥只保存在服务端） =======================
const settings = {
  get: () => S.settings,
  provider: (id) => S.settings.providers.find((p) => p.id === id),
  models: () => S.settings.models,
  model: (id) => S.settings?.models.find((m) => m.id === id),
  enabledModels: () => S.settings.models.filter((m) => m.enabled),
  /** 界面里会直接修改 S.settings 的对象再调用 patch，这里把可修改的部分整体提交 */
  patch(p = {}) {
    Object.assign(S.settings, p);
    const x = S.settings;
    return act("settings.patch", { defaultModel: x.defaultModel, defaultEffort: x.defaultEffort, models: x.models, runtimes: x.runtimes, budget: x.budget, guard: x.guard, notify: x.notify, qa: x.qa, concurrency: x.concurrency, fallback: x.fallback }).catch(fail);
  },
  verifyProvider: (id, f) => act("settings.verifyProvider", id ?? null, f),
  removeProvider: (id) => act("settings.removeProvider", id),
  listProviderModels: (id) => act("settings.listProviderModels", id),
  saveModel: (m) => act("settings.saveModel", m),
  removeModel: (id) => act("settings.removeModel", id),
  githubPAT: (token) => act("settings.connectGithub", token),
  disconnectGithub: () => act("settings.disconnectGithub"),
  connectLinear: (token) => act("settings.connectLinear", token),
  refreshLinearTeams: () => act("settings.refreshLinearTeams"),
  disconnectLinear: () => act("settings.disconnectLinear"),
};
const modelLabel = (id) => settings.model(id)?.label ?? MODELS.find((m) => m.id === id)?.name ?? id;

// ======================= 通用：视图切换 =======================
const VIEW_TITLES = { home: "首页", issues: "工作项", center: "任务中心", testing: "测试", automation: "自动化", insights: "洞察", tasks: "调用记录", bus: "总线消息", config: "智能体与工具", project: "项目设置", settings: "设置" };
/** 把视图与子选择写进地址栏；刷新后 route() 据此恢复 */
function setHash(view, params = {}) {
  const q = new URLSearchParams({ view });
  for (const [k, v] of Object.entries(params)) if (v != null && v !== "") q.set(k, String(v));
  const next = "#" + q.toString();
  if (location.hash !== next) history.replaceState(null, "", next);
}

/** 当前视图的子选择，供 showView 写回地址栏 */
function hashParamsOf(v) {
  if (v === "settings") return { tab: sg.tab };
  if (v === "config") return { studio: st.sel.kind, sel: st.sel.id };
  return {};
}

function showView(v) {
  const navV = v === "bus" ? "tasks" : v;
  document.querySelectorAll("nav button").forEach((x) => {
    const on = x.dataset.view === navV;
    x.classList.toggle("active", on);
    if (on) x.setAttribute("aria-current", "page"); else x.removeAttribute("aria-current");
  });
  document.querySelectorAll(".view").forEach((x) => x.classList.toggle("active", x.id === "view-" + v));
  if (v === "tasks") { if (state.selRoot) history.replaceState(null, "", "#task=" + state.selRoot); }
  else if (v !== "issues" || !ui.openKey) setHash(v, hashParamsOf(v));
  if (v === "home") renderHome();
  if (v === "issues") renderBoard();
  if (v === "center") renderCenter();
  if (v === "bus") loadTopics();
  if (v === "config") loadConfig();
  if (v === "project") renderProjectPage();
  if (v === "settings") { renderSettings(); if (!rtState.data) loadRuntimes().then(() => viewActive("settings") && renderSettings()); }
  if (v === "automation") renderAutomation();
  if (v === "insights") renderInsights();
  if (v === "testing") renderTesting();
  document.title = `${VIEW_TITLES[v] ?? ""}${VIEW_TITLES[v] ? " · " : ""}Agent Hub`;
}
const GH_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>';
const ghIcon = () => { const e = h("span", { class: "ghi" }); e.innerHTML = GH_ICON; return e; };
const ghTag = (g) => g ? h("span", { class: "gh" + (g.state === "closed" ? " closed" : ""), title: `GitHub ${g.repo ?? ""} #${g.number}（${g.state === "closed" ? "已关闭" : "open"}）` }, ghIcon(), `#${g.number}`) : null;
/** 轻量 Markdown：先整体转义再按行处理，避免把模型输出当 HTML 执行。只覆盖常用语法。 */
function mdHtml(src) {
  const esc = (t) => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const inline = (t) => esc(t)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
    .replace(/~~([^~]+)~~/g, "<del>$1</del>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  const lines = String(src ?? "").split("\n");
  const out = [];
  let list = null;
  let i = 0;
  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
  const blockStart = /^\s*(```|#{1,4}\s|>\s?|[-*+]\s|\d+[.)]\s)/;
  while (i < lines.length) {
    const line = lines[i];
    const fence = line.match(/^\s*```/);
    if (fence) {
      closeList();
      const body = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) body.push(lines[i++]);
      i++;
      out.push(`<pre><code>${esc(body.join("\n"))}</code></pre>`);
      continue;
    }
    if (!line.trim()) { closeList(); i++; continue; }
    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) { closeList(); const n = heading[1].length; out.push(`<h${n}>${inline(heading[2])}</h${n}>`); i++; continue; }
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) { closeList(); out.push("<hr>"); i++; continue; }
    if (/^\s*>\s?/.test(line)) { closeList(); out.push(`<blockquote>${inline(line.replace(/^\s*>\s?/, ""))}</blockquote>`); i++; continue; }
    const ul = line.match(/^\s*[-*+]\s+(.*)$/);
    if (ul) { if (list !== "ul") { closeList(); out.push("<ul>"); list = "ul"; } out.push(`<li>${inline(ul[1])}</li>`); i++; continue; }
    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ol) { if (list !== "ol") { closeList(); out.push("<ol>"); list = "ol"; } out.push(`<li>${inline(ol[1])}</li>`); i++; continue; }
    closeList();
    const para = [line];
    i++;
    while (i < lines.length && lines[i].trim() && !blockStart.test(lines[i])) para.push(lines[i++]);
    out.push(`<p>${para.map(inline).join("<br>")}</p>`);
  }
  closeList();
  return out.join("");
}
/** 渲染成 Markdown 的气泡：内容由 mdHtml 产出，样式靠 .md 关掉 pre-wrap */
const mdEl = (text, cls = "bubble ai md") => { const el = h("div", { class: cls }); el.innerHTML = mdHtml(text); return el; };

/**
 * 后台事件（运行进度、同步）会频繁触发整页重绘，重绘会把正在展开的下拉框、正在输入的框直接拆掉。
 * 焦点在容器里的表单控件上时先不重绘，失焦后补一次。返回 true 表示这次被挂起了。
 */
const editHold = new Map();
/** 正处于展开状态的下拉框：选完（change）或失焦就算收起。选完后用户操作触发的重绘不能被拦 */
let openSelect = null;
document.addEventListener("mousedown", (e) => { if (e.target instanceof HTMLSelectElement) openSelect = e.target; }, true);
document.addEventListener("keydown", (e) => { if (e.target instanceof HTMLSelectElement && [" ", "Enter", "ArrowDown", "ArrowUp"].includes(e.key)) openSelect = e.target; }, true);
document.addEventListener("change", (e) => { if (e.target === openSelect) openSelect = null; }, true);
document.addEventListener("blur", (e) => { if (e.target === openSelect) openSelect = null; }, true);
function holdWhileEditing(container, rerender) {
  const a = document.activeElement;
  const box = typeof container === "string" ? $(container) : container;
  if (!a || !box || !box.contains(a)) return false;
  const editing = a.tagName === "SELECT" ? a === openSelect : ["INPUT", "TEXTAREA"].includes(a.tagName) && !["checkbox", "radio", "button"].includes(a.type);
  if (!editing) return false;
  if (!editHold.get(box)) {
    editHold.set(box, true);
    a.addEventListener("blur", () => { editHold.set(box, false); setTimeout(rerender, 0); }, { once: true });
  }
  return true;
}
/**
 * 服务器目录选择器：Hub 跑在服务器上，浏览器打不开服务器的文件夹，所以由服务端列目录。
 * onPick(path, info) 选中后回调；info 带是否 git 仓库与当前分支。
 */
function openDirPicker(start, onPick, opts = {}) {
  let cur = null;
  const body = h("div", { class: "dirpick" });
  const go = async (path) => {
    fill(body, h("div", { class: "muted", style: "padding:16px" }, "读取中…"));
    try { cur = await rpc("fs.listDirs", path || ""); }
    catch (e) { if (path) return go(""); fill(body, h("div", { class: "err-text", style: "padding:16px" }, e.message)); return; }
    const crumbs = [];
    let acc = cur.root;
    crumbs.push(h("a", { class: "link", onclick: () => go(cur.root) }, "~"));
    for (const seg of cur.path.slice(cur.root.length).split("/").filter(Boolean)) {
      acc = `${acc}/${seg}`;
      const p = acc;
      crumbs.push(h("span", { class: "muted" }, " / "), h("a", { class: "link", onclick: () => go(p) }, seg));
    }
    fill(body,
      h("div", { class: "dirpick-path" }, crumbs,
        cur.git ? h("span", { class: "tag", style: "margin-left:8px" }, `git · ${cur.branch ?? "?"}`) : null),
      h("div", { class: "dirpick-list" },
        cur.parent ? h("div", { class: "dirpick-row", onclick: () => go(cur.parent) }, h("span", {}, "↰"), h("span", {}, "上一级")) : null,
        cur.dirs.length ? cur.dirs.map((d) => h("div", { class: "dirpick-row", onclick: () => go(d.path), title: d.path },
          h("span", {}, d.git ? "⑂" : "▸"), h("span", { class: "n" }, d.name),
          d.git ? h("span", { class: "tag" }, d.branch ?? "git") : null))
          : h("div", { class: "muted", style: "padding:12px" }, "没有子目录")));
    pickBtn.disabled = opts.requireGit && !cur.git ? "" : null;
    hint.textContent = opts.requireGit && !cur.git ? "当前目录不是 git 仓库" : cur.git ? `仓库当前在 ${cur.branch} 分支` : "";
  };
  const hint = h("span", { class: "muted", style: "font-size:12.5px" });
  const pickBtn = h("button", { class: "primary", onclick: () => { if (!cur) return; closeModal(true); onPick(cur.path, cur); } }, "选择这个目录");
  fill($("#modal"), h("div", { class: "modal", style: "width:min(640px,calc(100vw - 32px))", onclick: (e) => e.stopPropagation() },
    h("div", { class: "dr-head" }, h("span", {}, opts.title ?? "选择服务器上的目录")),
    body,
    h("div", { class: "modal-foot" }, hint, h("span", { style: "margin-left:auto" }), h("button", { onclick: () => closeModal() }, "取消"), pickBtn)));
  $("#modal").classList.add("open"); $("#modal").setAttribute("aria-hidden", "false");
  go(start);
}
/**
 * 流转规则：Hub 自己建的单推不推；Hub 开始做 / 做完可提测时，Linear 改成什么状态、指派给谁。
 * 状态和成员都从 Linear 团队实时读，选「自动 / 不改」就保持原来的行为。
 */
const flowCache = { states: {}, loading: {} };
function flowRules(p) {
  const F = { agentPush: { linear: !!p.linear?.pushNew, github: false, ...(p.flow?.agentPush ?? {}) }, start: { stateId: null, assignee: null, ...(p.flow?.start ?? {}) }, deliver: { stateId: null, assignee: null, ...(p.flow?.deliver ?? {}) } };
  const save = (patch) => issuesApi.saveProject({ name: p.name, key: p.key, flow: patch }, p.id).then(() => { renderProjectPage(); toast("流转规则已保存", "ok"); }).catch(fail);
  if (!flowCache.states[p.id] && !flowCache.loading[p.id]) {
    flowCache.loading[p.id] = true;
    rpc("work.linearTeamStates", p.id).then((x) => { flowCache.states[p.id] = x ?? []; }).catch(() => { flowCache.states[p.id] = []; }).finally(() => { flowCache.loading[p.id] = false; renderProjectPage(); });
  }
  if (!lg.members[p.id] && !lg.loading[p.id]) {
    lg.loading[p.id] = true;
    issuesApi.linearMembers(p.id).then((m) => { lg.members[p.id] = m ?? []; }).catch(() => { lg.members[p.id] = []; }).finally(() => { lg.loading[p.id] = false; renderProjectPage(); });
  }
  const states = flowCache.states[p.id] ?? [];
  const members = lg.members[p.id] ?? [];
  const stateSel = (stage, auto) => select([["", `自动（${auto}）`], ...states.map((x) => [x.id, x.name])], F[stage].stateId ?? "",
    (v) => save({ [stage]: { stateId: v || null } }), { style: "max-width:220px" });
  const whoSel = (stage) => {
    const cur = F[stage].assignee;
    const opts = [["", "不改指派人"], ...members.map((m) => [m.id, m.name])];
    if (cur && !members.some((m) => m.id === cur.id)) opts.push([cur.id, cur.name]);
    return select(opts, cur?.id ?? "", (v) => save({ [stage]: { assignee: v ? (members.find((m) => m.id === v) ?? cur) : null } }), { style: "max-width:260px" });
  };
  return field("流转规则", h("div", { class: "fields", style: "gap:12px" },
    h("div", { class: "checks" },
      checkboxP(F.agentPush.linear, (on) => save({ agentPush: { linear: on } }), "智能体自己建的单推到 Linear", "比如拆出来的子单，会挂在父单下面、指派人跟父单一致"),
      p.repo ? checkboxP(F.agentPush.github, (on) => save({ agentPush: { github: on } }), "智能体自己建的单也推到 GitHub issue") : null),
    h("table", { class: "map-table" },
      h("tr", {}, h("th", {}, "时机"), h("th", {}, "Linear 状态"), h("th", {}, "指派给")),
      h("tr", {}, h("td", {}, "Hub 开始做"), h("td", {}, stateSel("start", "In Progress 类")), h("td", {}, whoSel("start"))),
      h("tr", {}, h("td", {}, "Hub 做完，可以提测"), h("td", {}, stateSel("deliver", "名称含 Review 的状态")), h("td", {}, whoSel("deliver")))),
    h("div", { class: "help" }, (p.delivery?.mode ?? "pr") === "local"
      ? "「做完」= 已合并到本地开发分支且页面验收通过。指派给测试同学时，对方会在 Linear 收到通知。提测通过在 Linear 改 Done 即完成；打回请改回进行中并写评论，Hub 会带着评论退回给智能体。"
      : "「做完」= 交付并通过审核。指派给测试同学时，对方会在 Linear 收到通知。"),
    !states.length && !flowCache.loading[p.id] ? h("div", { class: "muted", style: "font-size:12.5px" }, "没有读到 Linear 团队的状态，先检查 Linear 连接") : null),
    "同一阶段同一轮只改一次，不会反复改指派人。");
}
/** 「只导入指派给指定成员的」的成员勾选：成员列表来自 Linear 团队 */
function importAssigneePicker(p, cfg, save) {
  const list = lg.members[p.id];
  if (!list && !lg.loading[p.id]) {
    lg.loading[p.id] = true;
    issuesApi.linearMembers(p.id).then((m) => { lg.members[p.id] = m ?? []; }).catch(() => { lg.members[p.id] = []; }).finally(() => { lg.loading[p.id] = false; renderProjectPage(); });
  }
  const cur = cfg.importAssignees ?? [];
  const chosen = new Set(cur.map((x) => x.id));
  const pool = [...cur, ...(list ?? []).filter((m) => !chosen.has(m.id))];
  if (!pool.length) return h("div", { class: "muted", style: "font-size:12.5px" }, list ? "没有读到团队成员" : "正在读取团队成员…");
  return h("div", { class: "checks" }, ...pool.map((m) => checkboxP(chosen.has(m.id),
    (on) => save({ importAssignees: on ? [...cur.filter((x) => x.id !== m.id), m] : cur.filter((x) => x.id !== m.id) }), m.name)));
}
/** 已用时间：12 秒 / 3 分钟 / 1 小时 5 分 */
function elapsed(iso) {
  const sec = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 1000));
  if (sec < 60) return `${sec} 秒`;
  const m = Math.floor(sec / 60);
  return m < 60 ? `${m} 分钟` : `${Math.floor(m / 60)} 小时 ${m % 60} 分`;
}
setInterval(() => document.querySelectorAll("[data-since]").forEach((el) => {
  const t = elapsed(el.dataset.since);
  el.textContent = el.classList.contains("el") ? t : ` · ${t}`;
}), 1000);
/** PR 的显示名：本地交付 / 只推分支时没有 PR 编号，显示分支 */
const prName = (pr) => !pr ? "" : pr.local === "local" ? `本地分支 ${pr.branch}` : pr.local === "branch" ? `分支 ${pr.branch}` : `PR #${pr.number}`;
const linearTag = (l) => l ? h("span", { class: "gh lin" + (l.state === "closed" ? " closed" : ""), title: `Linear ${l.identifier}` }, h("span", { class: "lin-mark", "aria-hidden": "true" }), l.identifier) : null;
const linearPushable = (p) => !!p?.linear && ["two_way", "push"].includes(p.linear.mode);
const pbadge = (p) => h("span", { class: "pbadge", style: `--hue:${hue(p?.key ?? "?")}` }, (p?.key ?? "?").slice(0, 3));
const SYNC_MODES = [["two_way", "双向同步"], ["import", "仅从 GitHub 导入"], ["push", "仅推送到 GitHub"], ["off", "关闭同步"]];

// ======================= 项目切换 =======================
ui.project = (() => { try { return localStorage.getItem("hubProject"); } catch { return null; } })();
const curProject = () => issuesApi.project(ui.project) ?? issuesApi.projects()[0] ?? null;
function setProject(id, opts = {}) {
  ui.project = id;
  try { localStorage.setItem("hubProject", id); } catch {}
  if (ui.openKey && !opts.keepDrawer) closeDrawer();
  renderProjectSwitch();
  renderBoard();
  if (viewActive("project")) renderProjectPage();
}
function renderProjectSwitch() {
  const p = curProject();
  if (p && ui.project !== p.id) ui.project = p.id;
  fill($("#projBtn"), p ? [pbadge(p), h("span", { class: "n" }, p.name), h("span", { class: "caret" }, "▾")] : h("span", {}, "选择项目"));
  fill($("#projMenu"),
    h("div", { class: "mh" }, "项目（工作空间）"),
    issuesApi.projects().map((x) => h("div", { class: "mi", onclick: () => { closeMenu(); setProject(x.id); if (!viewActive("issues") && !viewActive("project")) showView("issues"); } },
      pbadge(x),
      h("div", { class: "meta" }, h("div", {}, h("b", {}, x.name), " ", h("span", { class: "muted", style: "font-size:12px" }, x.key)),
        h("div", { class: "s" }, x.repo ? [ghIcon(), " ", x.repo.fullName] : "未绑定仓库", ` · 进行中 ${x.counts.inProgress} · 未完成 ${x.counts.open}`)),
      x.id === p?.id ? h("span", { class: "tick" }, "✓") : null)),
    h("div", { class: "sep" }),
    h("div", { class: "mi", onclick: () => { closeMenu(); showView("project"); } }, h("span", { class: "muted" }, "⚙"), "项目设置"),
    h("div", { class: "mi", onclick: () => { closeMenu(); openNewProject(); } }, h("span", { class: "muted" }, "+"), "新建项目"));
}
const closeMenu = () => $("#projMenu").classList.remove("open");
$("#projBtn").addEventListener("click", (e) => { e.stopPropagation(); renderProjectSwitch(); $("#projMenu").classList.toggle("open"); });
document.addEventListener("click", (e) => { if (!$("#projSwitch").contains(e.target)) closeMenu(); });
$("#settingsBtn").addEventListener("click", () => showView("settings"));

/** 看板顶部的项目 / 同步信息条 */
function renderProjBar() {
  const p = curProject();
  if (!p) return fill($("#projBar"));
  // 工作项只有一个权威来源，所以同步按钮也只有一个：按来源喊对应的同步
  const src = p.sync?.source ?? (p.linear ? "linear" : p.repo ? "github" : "manual");
  const ghOn = !!p.repo && p.sync.mode !== "off";
  const lnOn = !!p.linear && p.linear.mode !== "off";
  const jobs = [];
  if (src === "linear" && lnOn) jobs.push(["Linear", () => issuesApi.syncLinear(p.id)]);
  else if (src === "github" && ghOn) jobs.push(["GitHub", () => issuesApi.sync(p.id)]);
  else if (src === "manual") {
    // 手动来源没有可导入的，但绑定了系统且开了推送的话，可以把本地改动推出去
    if (ghOn && ["two_way", "push"].includes(p.sync.mode)) jobs.push(["GitHub", () => issuesApi.sync(p.id)]);
    if (lnOn && ["two_way", "push"].includes(p.linear.mode)) jobs.push(["Linear", () => issuesApi.syncLinear(p.id)]);
  }
  const syncBtn = jobs.length
    ? h("button", { title: `从${jobs.map((j) => j[0]).join("、")}拉取最新变更并写回本地改动`, onclick: async (e) => {
        const btn = e.currentTarget;
        const label = btn.textContent;
        btn.disabled = true;
        btn.textContent = "同步中…";
        const out = [];
        try {
          for (const [name, fn] of jobs) {
            try { out.push(await fn()); } catch (err) { out.push(`${name}：${err.message}`); }
          }
          toast(out.join("；"), "ok");
          await refreshState();
          renderIssuesView();
        } catch (err) { fail(err); }
        finally { btn.disabled = false; btn.textContent = label; }
      } }, `⟳ 同步 ${jobs.map((j) => j[0]).join(" / ")}`)
    : null;
  const lastSync = src === "linear" ? p.linear?.lastSyncAt : p.lastSyncAt;
  const modeLabel = src === "linear"
    ? LINEAR_MODES.find((m) => m[0] === p.linear?.mode)?.[1]
    : SYNC_MODES.find((m) => m[0] === p.sync.mode)?.[1];
  fill($("#projBar"),
    h("span", { class: "gh" }, ghIcon(), p.repo ? p.repo.fullName : "未绑定仓库"),
    h("span", {}, "·"),
    h("span", {}, src === "linear" ? "issue 来自 Linear" : src === "github" ? "issue 来自 GitHub" : "仅手动创建"),
    modeLabel && (src === "linear" ? lnOn : ghOn) ? h("span", {}, `· ${modeLabel}`) : null,
    lastSync ? h("span", {}, `· ${ago(lastSync)}同步`) : null,
    src === "github" && p.pendingRemote && p.sync.mode !== "push" && ghOn ? h("span", { class: "tag", title: "GitHub 上有尚未导入的 issue" }, `${p.pendingRemote} 个待导入`) : null,
    p.linear ? h("span", { class: "gh lin", title: `Linear 团队 ${p.linear.teamName}` }, h("span", { class: "lin-mark", "aria-hidden": "true" }), p.linear.teamKey) : null,
    syncBtn);
}

// ======================= 新建 GitHub 仓库（新建项目弹窗与项目设置页共用） =======================
const ghOwners = { list: null, loading: false, error: "" };
/** 仓库名建议：项目名里的英文单词，否则用前缀 */
const suggestRepoName = (name, key) => ((name || "").match(/[A-Za-z0-9]+/g) ?? []).join("-").toLowerCase() || (key || "").toLowerCase();
/**
 * 归属 / 仓库名 / 公开私有 三个字段。nr = { owner, name, private }，就地修改。
 * 归属列表首次用到时才去读（需要访问 GitHub），读完调用 rerender 重绘。
 */
function newRepoFields(nr, rerender) {
  if (!ghOwners.list && !ghOwners.loading && !ghOwners.error) {
    ghOwners.loading = true;
    issuesApi.githubOwners().then((l) => { ghOwners.list = l ?? []; }).catch((e) => { ghOwners.error = e.message; }).finally(() => { ghOwners.loading = false; rerender(); });
  }
  const owners = ghOwners.list ?? [];
  if (!nr.owner && owners.length) nr.owner = owners[0].login;
  const owner = owners.length
    ? select(owners.map((o) => [o.login, o.org ? `${o.login}（组织）` : o.login]), nr.owner, (v) => (nr.owner = v), { style: "max-width:200px" })
    : h("span", { class: "muted", style: "font-size:12.5px" }, ghOwners.error ? `读取账号失败：${ghOwners.error}` : "读取账号…");
  const name = h("input", { placeholder: "仓库名，如 my-app", style: "max-width:220px", oninput: (e) => (nr.name = e.target.value.trim()) });
  name.value = nr.name ?? "";
  const vis = select([["private", "私有"], ["public", "公开"]], nr.private === false ? "public" : "private", (v) => (nr.private = v !== "public"), { style: "max-width:100px" });
  return h("div", {},
    h("div", { class: "row", style: "gap:6px;align-items:center" }, owner, h("span", { class: "muted" }, "/"), name, vis),
    h("div", { class: "muted", style: "font-size:12.5px;margin-top:6px" }, "会带 README 初始化（空仓库没有默认分支，智能体开不了工作分支），建好后自动绑定到本项目"));
}
const ownerIsOrg = (login) => !!ghOwners.list?.find((o) => o.login === login)?.org;

// ======================= 新建项目 =======================
function openNewProject() {
  const gh = settings.get().github;
  const used = new Set(issuesApi.projects().filter((x) => x.repo).map((x) => x.repo.fullName));
  // 表单状态独立存着：切换运行方式会重绘，不能把用户已经填的内容弄丢
  const st = { brief: "", name: "", key: "", description: "", mode: "local", repo: "", repoMode: gh.connected && !gh.repos?.length ? "new" : "existing", newRepo: { owner: "", name: "", private: true } };

  const body = () => {
    const brief = h("textarea", { rows: 3, placeholder: "说说这个项目要做什么，比如：给官网加一个博客模块，支持 Markdown 和标签，第一期先能发布文章",
      oninput: (e) => (st.brief = e.target.value) });
    brief.value = st.brief;
    const name = h("input", { class: "title-input", placeholder: "项目名称，如 官网改版", oninput: (e) => { st.name = e.target.value; if (!st.keyTouched) { st.key = (st.name.match(/[A-Za-z]+/g) ?? []).join("").slice(0, 4).toUpperCase(); renderKey(); } } });
    name.value = st.name;
    const key = h("input", { placeholder: "编号前缀，如 WEB", style: "max-width:180px;text-transform:uppercase", oninput: (e) => { st.keyTouched = true; st.key = e.target.value.toUpperCase(); } });
    key.value = st.key;
    const renderKey = () => { key.value = st.key; };
    const desc = h("input", { placeholder: "一句话描述（可选）", oninput: (e) => (st.description = e.target.value) });
    desc.value = st.description;

    const asking = h("span", { class: "muted", style: "font-size:12.5px" });
    const draftBtn = h("button", { onclick: async (e) => {
      if (!st.brief.trim()) return toast("先说说这个项目要做什么", "err");
      e.target.disabled = true; asking.textContent = "管家正在起草…";
      try {
        const d = await rpc("assistant.draftProject", st.brief);
        st.name = d.name || st.name; st.key = (d.key || st.key).toUpperCase(); st.description = d.description || st.description;
        name.value = st.name; key.value = st.key; desc.value = st.description;
        asking.textContent = "已起草，可以改";
      } catch (err) { asking.textContent = ""; fail(err); } finally { e.target.disabled = false; }
    } }, "让管家起草");

    const modeBtn = (m, label, hint) => h("button", { class: st.mode === m ? "primary" : "", style: "text-align:left;flex:1;padding:10px 14px;height:auto",
      onclick: () => { st.mode = m; redraw(); } },
      h("div", { style: "font-weight:600" }, label), h("div", { style: "font-size:12px;opacity:.75;margin-top:2px;font-weight:400" }, hint));

    const repoBlock = st.mode !== "github" ? null : !gh.connected
      ? h("div", { class: "callout warn", style: "margin-top:10px" },
          h("div", {}, h("b", {}, "还没有连接 GitHub")),
          h("div", { class: "muted", style: "font-size:12.5px;margin-top:4px" },
            "可以先建项目，之后在「项目设置 → GitHub 仓库」里补令牌和仓库；不影响现在开始干。"))
      : (() => {
          const tab = (m, label) => h("button", { class: st.repoMode === m ? "primary" : "", onclick: () => { st.repoMode = m; if (m === "new" && !st.newRepo.name) st.newRepo.name = suggestRepoName(st.name, st.key); redraw(); } }, label);
          const tabs = h("div", { class: "row", style: "gap:6px;margin-top:10px" }, tab("existing", "选择已有仓库"), tab("new", "新建仓库"));
          if (st.repoMode === "new") return h("div", {}, tabs, h("div", { style: "margin-top:10px" }, newRepoFields(st.newRepo, redraw)));
          const pick = select([["", "选择仓库…"], ...gh.repos.map((r) => [r, used.has(r) ? `${r}（已绑定其他项目）` : r])], st.repo, (v) => (st.repo = v), { style: "max-width:360px;margin-top:10px" });
          [...pick.options].forEach((o) => { if (used.has(o.value)) o.disabled = true; });
          return h("div", {}, tabs, pick, h("div", { class: "muted", style: "font-size:12.5px;margin-top:6px" }, `以 ${gh.login} 的身份访问`));
        })();

    const wrap = h("div", { class: "modal", onclick: (e) => e.stopPropagation() },
      h("div", { class: "dr-head" }, h("span", {}, "新建项目")),
      h("div", { class: "fields" },
        brief,
        h("div", { class: "row", style: "gap:10px;align-items:center" }, draftBtn, asking)),
      name,
      h("div", { class: "modal-props" }, key, desc),
      h("div", { style: "margin-top:14px" }, h("div", { style: "font-size:12.5px;color:var(--muted);margin-bottom:8px" }, "代码放在哪"),
        h("div", { class: "row", style: "gap:10px;align-items:stretch" },
          modeBtn("local", "仅本地", "在服务器的工作区里开发，不往 GitHub 推代码"),
          modeBtn("github", "绑定 GitHub", "工作项与 issue 同步，智能体在仓库里改代码并提 PR"))),
      repoBlock,
      h("div", { class: "modal-foot" }, h("span", { class: "hint" }, "工作项编号会以前缀开头，如 WEB-1"),
        h("button", { onclick: () => closeModal() }, "取消"), h("button", { class: "primary", onclick: submit }, "创建")));
    return wrap;
  };

  const redraw = () => fill($("#modal"), body());

  const submit = async () => {
    if (!st.name.trim() || !st.key.trim()) return toast("名称和编号前缀都要填", "err");
    const creating = st.mode === "github" && gh.connected && st.repoMode === "new";
    if (creating && !st.newRepo.name) return toast("填一下新仓库的名字", "err");
    let p;
    try {
      p = await issuesApi.saveProject({ name: st.name.trim(), key: st.key.trim().toUpperCase(), description: st.description.trim() });
    } catch (e) { return fail(e); }
    // 项目已经建好；仓库这一步失败时不回滚项目，去项目设置页重试即可
    let bound = null, repoErr = null;
    try {
      if (creating) bound = (await issuesApi.createRepo(p.id, { owner: st.newRepo.owner, org: ownerIsOrg(st.newRepo.owner), name: st.newRepo.name, private: st.newRepo.private }))?.fullName;
      else if (st.mode === "github" && st.repo) { await issuesApi.connectRepo(p.id, st.repo); bound = st.repo; }
    } catch (e) { repoErr = e; }
    closeModal(true);
    setProject(p.id);
    showView("project");
    if (repoErr) toast(`已创建 ${p.name}，但仓库没建好：${repoErr.message}。可以在项目设置里重试`, "err");
    else toast(bound ? `已创建 ${p.name} 并${creating ? "新建、" : ""}绑定 ${bound}` : `已创建 ${p.name}（本地）`, "ok");
  };

  redraw();
  $("#modal").classList.add("open"); $("#modal").setAttribute("aria-hidden", "false");
}

// ======================= 项目设置页 =======================
const pg = { draft: null, orig: null, pid: null, repoPick: "", newRepo: null };
function renderProjectPage() {
  if (holdWhileEditing("#projectPage", renderProjectPage)) return;
  const p = curProject();
  if (!p) return fill($("#projectPage"), h("div", { class: "empty" }, "还没有项目"), h("div", { style: "text-align:center" }, h("button", { class: "primary", onclick: openNewProject }, "新建项目")));
  if (pg.pid !== p.id) pg.newRepo = null;
  if (pg.pid !== p.id || !pg.draft) { pg.pid = p.id; pg.draft = { name: p.name, key: p.key, description: p.description, sync: { ...p.sync }, delivery: { baseBranch: "", mode: "pr", localPath: "", afterMerge: "", ...(p.delivery ?? {}) } }; pg.orig = JSON.stringify(pg.draft); }
  const d = pg.draft;
  const dirty = () => JSON.stringify(d) !== pg.orig;
  const bar = h("div", { class: "savebar" + (dirty() ? "" : " clean"), id: "pgSave" }, h("span", { class: "hint" }, "有未保存的修改"),
    h("button", { onclick: () => { pg.draft = null; renderProjectPage(); } }, "放弃修改"),
    h("button", { class: "primary", onclick: async () => { try { await issuesApi.saveProject(d, p.id); pg.draft = null; renderProjectPage(); renderProjectSwitch(); renderBoard(); toast("项目设置已保存", "ok"); } catch (e) { fail(e); } } }, "保存"));
  const touchP = () => $("#pgSave")?.classList.toggle("clean", !dirty());
  const inp = (obj, k, attrs = {}) => { const el = h("input", { ...attrs, oninput: (e) => { obj[k] = attrs.upper ? e.target.value.toUpperCase() : e.target.value; touchP(); } }); el.value = obj[k] ?? ""; return el; };
  const gh = settings.get().github;
  const log = issuesApi.syncLog(p.id);

  let repoBlock;
  if (p.repo) {
    repoBlock = h("div", { class: "callout" }, ghIcon(), h("b", {}, p.repo.fullName), h("span", { class: "ok-text" }, "已绑定"),
      h("span", { style: "margin-left:auto" }),
      h("a", { class: "link", href: `https://github.com/${p.repo.fullName}`, target: "_blank", rel: "noopener" }, "在 GitHub 打开"),
      h("button", { class: "danger", onclick: async () => { if (confirm(`解绑 ${p.repo.fullName}？已关联的工作项会保留 GitHub 编号，但不再同步。`)) { await issuesApi.disconnectRepo(p.id); pg.draft = null; renderProjectPage(); } } }, "解绑"));
  } else if (!gh.connected) {
    // Hub 绑仓库用的是它自己的令牌；MCP 里的 GitHub 只给智能体调 API，两者不通用，这里直接给输入框避免来回跳
    const tok = h("input", { type: "password", autocomplete: "off", placeholder: "ghp_… 或 github_pat_…", style: "max-width:320px" });
    const st = h("span", { style: "font-size:12.5px" });
    repoBlock = h("div", { class: "fields" },
      h("div", { class: "callout warn" },
        h("div", {}, h("b", {}, "需要 Hub 自己的 GitHub 令牌才能绑定仓库。"),
          h("div", { class: "muted", style: "font-size:12.5px;margin-top:4px" },
            "这和 MCP 里的 GitHub 是两回事：MCP 让智能体能调 GitHub API，绑仓库、克隆、提 PR 由 Hub 自己做，需要单独授权。"))),
      h("div", { class: "row", style: "flex-wrap:nowrap" }, tok,
        h("button", { class: "primary", onclick: async (e) => {
          if (!tok.value.trim()) { st.className = "err-text"; st.textContent = "先填令牌"; return; }
          e.target.disabled = true; st.className = "muted"; st.textContent = "验证中…";
          try {
            await settings.githubPAT(tok.value.trim());
            pg.draft = null; renderProjectPage();
            toast("GitHub 已连接，可以选仓库了", "ok");
          } catch (err) { st.className = "err-text"; st.textContent = err.message; e.target.disabled = false; }
        } }, "验证并连接")),
      h("div", { class: "help" },
        "令牌在 ", h("a", { class: "link", href: "https://github.com/settings/tokens/new", target: "_blank", rel: "noopener" }, "GitHub → Settings → Developer settings"),
        " 创建，勾 repo（私有仓库）或 public_repo；要改 CI 再加 workflow。"),
      st);
  } else {
    const used = new Set(issuesApi.projects().filter((x) => x.repo).map((x) => x.repo.fullName));
    const pick = select([["", "选择仓库…"], ...gh.repos.map((r) => [r, used.has(r) ? `${r}（已绑定其他项目）` : r])], pg.repoPick, (v) => (pg.repoPick = v), { style: "max-width:320px" });
    [...pick.options].forEach((o) => { if (used.has(o.value)) o.disabled = true; });
    const bindRow = h("div", { class: "row" }, pick,
      h("button", { class: "primary", onclick: async () => {
        if (!pg.repoPick) return toast("先选择一个仓库", "err");
        try { await issuesApi.connectRepo(p.id, pg.repoPick); pg.repoPick = ""; pg.draft = null; renderProjectPage(); renderProjectSwitch(); toast("已绑定仓库，点「立即同步」导入 issue", "ok"); } catch (e) { fail(e); }
      } }, "绑定"),
      pg.newRepo ? null : h("button", { onclick: () => { pg.newRepo = { owner: "", name: suggestRepoName(p.name, p.key), private: true }; renderProjectPage(); } }, "新建仓库"),
      h("span", { class: "muted", style: "font-size:12.5px" }, `以 ${gh.login} 的身份访问`));
    const nr = pg.newRepo;
    repoBlock = !nr ? bindRow : h("div", { class: "fields" }, bindRow,
      h("div", { class: "callout" },
        h("div", { style: "flex:1" }, h("b", {}, "新建仓库"), h("div", { style: "margin-top:8px" }, newRepoFields(nr, renderProjectPage)),
          h("div", { class: "row", style: "gap:8px;margin-top:10px" },
            h("button", { class: "primary", onclick: async (e) => {
              if (!nr.name) return toast("填一下仓库名", "err");
              e.target.disabled = true; e.target.textContent = "创建中…";
              try {
                const r = await issuesApi.createRepo(p.id, { owner: nr.owner, org: ownerIsOrg(nr.owner), name: nr.name, private: nr.private });
                pg.newRepo = null; pg.draft = null; renderProjectPage(); renderProjectSwitch();
                toast(`已新建并绑定 ${r?.fullName ?? nr.name}`, "ok");
              } catch (err) { e.target.disabled = false; e.target.textContent = "创建并绑定"; fail(err); }
            } }, "创建并绑定"),
            h("button", { onclick: () => { pg.newRepo = null; renderProjectPage(); } }, "取消")))));
  }

  fill($("#projectPage"), h("div", { class: "studio-inner" },
    h("div", { class: "ed-head" }, pbadge(p),
      h("div", {}, h("h2", {}, p.name, h("span", { class: "model-chip" }, p.key)), h("div", { class: "sub" }, `${p.counts.total} 个工作项 · 进行中 ${p.counts.inProgress} · 待验收 ${p.counts.review}`)),
      h("div", { class: "actions" }, h("button", { onclick: () => showView("issues") }, "打开看板"))),
    section("基本信息", "前缀用于工作项编号。修改前缀后，所有编号会随之变化（如 HUB-3 → AH-3）。",
      field("名称", inp(d, "name")),
      field("编号前缀", inp(d, "key", { upper: 1, style: "max-width:180px;text-transform:uppercase" }), "2–6 位大写字母或数字"),
      field("描述", inp(d, "description"))),
    section("GitHub 仓库", "一个项目对应一个仓库（一个仓库也只能绑定一个项目）。绑定是为了让智能体在这里改代码、推分支、提 PR；issue 是否从 GitHub 导入，由下面的「工作项来源」单独决定。", repoBlock),
    section("交付策略", "智能体改完的代码合到哪、怎么合。不同项目流程不同：有的开 PR 进主干，有的只合本地开发分支、再由人提测。提测与发版始终由人完成，Hub 不会触发。", (() => {
      const dv = d.delivery;
      const base = dv.baseBranch || p.repo?.defaultBranch || "main";
      const modes = [
        ["local", "合并到本机仓库（不推远端）"],
        ["pr", "推分支并开 PR"],
        ["branch", "只推分支，不开 PR"],
      ];
      const mainWarn = dv.mode === "pr" && /^(main|master)$/.test(base)
        ? h("div", { class: "callout warn", style: "margin-top:8px" }, h("div", {}, h("b", {}, `PR 会开向 ${base}。`),
            h("div", { class: "muted", style: "font-size:12.5px;margin-top:4px" }, "很多仓库合进主干就会触发发版流水线。如果你的流程是先进开发分支，把基线分支改成 dev。")))
        : null;
      return h("div", { class: "fields" },
        field("基线分支", inp(dv, "baseBranch", { placeholder: p.repo?.defaultBranch || "main", style: "max-width:220px" }),
          `智能体从这个分支拉代码，改完合回这个分支。留空用仓库默认分支（${p.repo?.defaultBranch || "main"}）`),
        field("交付方式", select(modes, dv.mode, (v) => { dv.mode = v; touchP(); renderProjectPage(); }, { style: "max-width:320px" })),
        dv.mode === "local" ? field("本机仓库目录", h("div", { class: "row", style: "gap:8px;flex-wrap:nowrap" },
            inp(dv, "localPath", { placeholder: "点右边「选择…」浏览服务器目录，或直接粘贴路径" }),
            h("button", { onclick: () => openDirPicker(dv.localPath, (path, info) => {
              dv.localPath = path; touchP(); renderProjectPage();
              if (info.branch && info.branch !== base) toast(`这个仓库当前在 ${info.branch} 分支，合并时要求停在 ${base} 上`, "err");
              else toast(`已选择 ${path}（${info.branch} 分支）`, "ok");
            }, { requireGit: true, title: "选择本机仓库目录" }) }, "选择…")),
          `合并进这个目录当前检出的 ${base} 分支；目录必须正停在 ${base} 上，否则拒绝合并。有冲突会自动撤销，不留半合并状态`) : null,
        dv.mode === "local" ? field("合并后执行", inp(dv, "afterMerge", { placeholder: "可选，如 pm2 restart opscenter；dev 服务热加载可留空" }), "在本机仓库目录里执行") : null,
        field("合并方式", select([["manual", "手动：验收通过后由我确认合并"], ["auto", "自动：测试与评审通过后直接合并"]], p.lead?.mergePolicy ?? "auto",
          (v) => issuesApi.setLead(p.id, { mergePolicy: v }).then(() => toast(v === "manual" ? "改为手动合并" : "改为自动合并", "ok")).catch(fail), { style: "max-width:360px" }),
          "立即生效，不需要点保存"),
        mainWarn);
    })()),
    section("工作项来源", "工作项只能有一个权威来源，二选一：从 Linear 导入，或从 GitHub 的 issue 导入。两者互斥——同一件活在两边各有一份，改哪边算数就说不清了。绑定 GitHub 仓库只影响代码与 PR，不改变这里的选择。", (() => {
        const cur = d.sync.source ?? (p.linear ? "linear" : p.repo ? "github" : "manual");
        const opts = [
          ["linear", p.linear ? `Linear 团队 · ${p.linear.teamName}` : "Linear 团队（还没绑定）"],
          ["github", p.repo ? `GitHub 仓库 · ${p.repo.fullName} 的 issue` : "GitHub 仓库（还没绑定）"],
          ["manual", "只手动创建，不导入"],
        ];
        const el = select(opts, cur, (v) => {
          if (v === "github" && !p.repo) return toast("先绑定 GitHub 仓库", "err");
          if (v === "linear" && !p.linear) return toast("先绑定 Linear 团队", "err");
          // 换来源只影响往后的导入；已经导入的工作项不会自动删，提示一下免得以为是 bug
          const imported = issuesApi.projects().find((x) => x.id === p.id)?.counts?.total ?? 0;
          d.sync.source = v;
          if (v === "github") d.sync.mode = d.sync.mode === "off" ? "two_way" : d.sync.mode;
          if (v === "linear" && d.linear) d.linear.mode = d.linear.mode === "off" ? "two_way" : d.linear.mode;
          touchP(); renderProjectPage();
          if (imported) toast(`来源已切换。已导入的 ${imported} 个工作项不受影响，需要清理请在工作项页批量删除`, "ok");
        }, { style: "max-width:420px" });
        return h("div", { class: "row" }, el, h("button", {
          onclick: async (e) => {
            const src = d.sync.source ?? (p.linear ? "linear" : p.repo ? "github" : "manual");
            if (src === "manual") return toast("当前来源是「仅手动创建」，没有可导入的", "err");
            e.target.disabled = true; e.target.textContent = "导入中…";
            try {
              toast(await (src === "github" ? issuesApi.sync(p.id) : issuesApi.syncLinear(p.id)), "ok");
              renderProjectPage(); renderBoard();
            } catch (err) { fail(err); }
            finally { e.target.disabled = false; e.target.textContent = "立即导入"; }
          },
        }, "立即导入"));
      })()),
    section("GitHub 同步", p.repo ? `工作项与 ${p.repo.fullName} 的 issue 如何互相同步。` : "绑定仓库后才能开启同步。下面的设置只影响 GitHub，Linear 有自己的一组。",
      (() => {
        const src = d.sync.source ?? (p.linear ? "linear" : p.repo ? "github" : "manual");
        if (src === "github") return null;
        return h("div", { class: "callout" },
          h("div", {}, h("b", {}, "当前来源是「" + (src === "linear" ? "Linear 团队" : "仅手动创建") + "」，不会从 GitHub 导入 issue。"),
            h("div", { class: "muted", style: "font-size:12.5px;margin-top:4px" }, "但下面的推送设置仍然有效：本地新建或改动的、已关联 GitHub 的工作项，照样会把状态写回 GitHub；智能体也在这里改代码、提 PR。要让 issue 也来自 GitHub，把上面的来源改过来（Linear 那边会停止导入）。")));
      })(),
      field("同步方向", select(SYNC_MODES, d.sync.mode, (v) => { d.sync.mode = v; touchP(); renderProjectPage(); }, { style: "max-width:320px", disabled: p.repo ? null : "" }),
        p.repo ? "" : "绑定仓库后可开启"),
      (d.sync.source ?? (p.linear ? "linear" : p.repo ? "github" : "manual")) === "github" && ["two_way", "import"].includes(d.sync.mode)
        ? field("导入范围", h("div", { class: "row" },
            select([["all", "所有 open 的 issue"], ["label", "只导入带指定标签的 issue"]], d.sync.importScope, (v) => { d.sync.importScope = v; touchP(); renderProjectPage(); }, { style: "max-width:260px" }),
            d.sync.importScope === "label" ? inp(d.sync, "importLabel", { placeholder: "标签，如 agent", style: "max-width:160px" }) : null), "导入后进入「待规划」，指派智能体后才会执行")
        : null,
      ["two_way", "push"].includes(d.sync.mode) ? h("div", { class: "checks" },
        checkboxP(d.sync.pushNew, (on) => { d.sync.pushNew = on; touchP(); }, "新建工作项时默认同时创建 GitHub issue", "新建时可单独取消勾选"),
        checkboxP(d.sync.postDeliverable, (on) => { d.sync.postDeliverable = on; touchP(); }, "智能体的交付结果回写为 GitHub 评论")) : null,
      field("状态映射", h("table", { class: "map-table" },
        h("tr", {}, h("th", {}, "工作项状态"), h("th", {}, "GitHub issue")),
        h("tr", {}, h("td", {}, "待规划 / 待办 / 进行中"), h("td", {}, "open")),
        h("tr", {}, h("td", {}, "待审核"), h("td", {}, h("code", {}, "open"), " + ", h("code", {}, S.github?.reviewLabel || "in-review"), " 标签")),
        h("tr", {}, h("td", {}, "完成"), h("td", {}, "closed（completed）")),
        h("tr", {}, h("td", {}, "已取消"), h("td", {}, "closed（not planned）"))), "GitHub 只有 open / closed，所以「待审核」用标签表示：进入待审核时打上、离开时摘掉。GitHub 上关闭或重新打开 issue 时，工作项状态也会对应变化")),
    linearSection(p),
    leadSection(p),
    section("同步记录", p.lastSyncAt ? `上次同步：${new Date(p.lastSyncAt).toLocaleString()}` : "还没有同步过",
      h("div", { class: "row" }, h("button", { disabled: p.repo && p.sync.mode !== "off" ? null : "", onclick: async (e) => {
        e.target.disabled = true; e.target.textContent = "同步中…";
        try { toast(await issuesApi.sync(p.id), "ok"); } catch (err) { fail(err); }
        renderProjectPage();
      } }, "立即同步"), p.pendingRemote ? h("span", { class: "muted", style: "font-size:12.5px" }, `GitHub 上有 ${p.pendingRemote} 个 issue 尚未导入`) : null),
      log.length ? h("div", {}, log.slice(0, 10).map((l) => h("div", { class: "log-row " + l.kind }, h("span", { class: "time", style: "margin-left:0;min-width:80px" }, ago(l.at)), h("span", {}, l.text)))) : null),
    section("危险操作", null, h("div", {}, h("button", { class: "danger", onclick: async () => {
      if (!confirm(`删除项目「${p.name}」及其全部 ${p.counts.total} 个工作项？此操作不可撤销（不会删除 GitHub 上的 issue）。`)) return;
      await issuesApi.deleteProject(p.id);
      pg.draft = null;
      setProject(issuesApi.projects()[0]?.id ?? null);
      renderProjectPage();
    } }, "删除项目"))),
    bar));
}
const LINEAR_MODES = [["two_way", "双向同步"], ["import", "仅从 Linear 导入"], ["push", "仅推送到 Linear"], ["off", "关闭同步"]];
const lg = { teamPick: "", members: {}, loading: {} };
const AUTO_SCOPES = [["off", "不自动：在 Hub 里指派智能体后才执行"], ["all", "全部自动：团队里的 issue 都交给智能体"], ["assignees", "只做指定成员的 issue"]];
const AUTO_STATES = [["backlog", "Backlog（待规划）"], ["todo", "Todo（待办）"], ["in_progress", "In Progress（进行中）"]];
/** Linear 自动执行范围：谁的 issue、处于什么状态时，不用人指派就交给智能体 */
function linearAutoField(p, cfg, save) {
  const A = { scope: "off", assignees: [], states: ["todo"], ...(cfg.autoRun ?? {}) };
  const put = (patch) => save({ autoRun: { ...A, ...patch } });
  const parts = [select(AUTO_SCOPES, A.scope, (v) => put({ scope: v }), { style: "max-width:360px" })];
  if (A.scope === "assignees") {
    const list = lg.members[p.id];
    if (!list && !lg.loading[p.id]) {
      lg.loading[p.id] = true;
      issuesApi.linearMembers(p.id).then((m) => { lg.members[p.id] = m ?? []; }).catch(() => { lg.members[p.id] = []; }).finally(() => { lg.loading[p.id] = false; renderProjectPage(); });
    }
    const chosen = new Set(A.assignees.map((x) => x.id));
    const pool = list ?? A.assignees;
    parts.push(pool.length
      ? h("div", { class: "checks" }, ...pool.map((m) => checkboxP(chosen.has(m.id), (on) => put({ assignees: on ? [...A.assignees.filter((x) => x.id !== m.id), m] : A.assignees.filter((x) => x.id !== m.id) }), m.name)))
      : h("div", { class: "muted", style: "font-size:12.5px" }, list ? "没有读到团队成员，先同步一次 Linear 再来选" : "正在读取团队成员…"));
    if (!A.assignees.length) parts.push(h("div", { class: "callout warn" }, "还没有选择成员，目前不会自动执行任何 issue。"));
  }
  if (A.scope !== "off") {
    const states = new Set(A.states);
    parts.push(h("div", { class: "muted", style: "font-size:12.5px;margin-top:6px" }, "处于以下状态时接手："),
      h("div", { class: "checks" }, ...AUTO_STATES.map(([v, t]) => checkboxP(states.has(v), (on) => put({ states: on ? [...A.states.filter((x) => x !== v), v] : A.states.filter((x) => x !== v) }), t))));
    if (!A.states.length) parts.push(h("div", { class: "callout warn" }, "没有勾选任何状态，目前不会自动执行任何 issue。"));
  }
  return field("自动执行", h("div", {}, ...parts),
    "命中范围的 issue 会按内容选研发角色并开始执行，bug 自动分诊也遵守这个范围。改派给范围外的人或拖出所选状态：还没开跑的取消自动指派，正在跑的不打断。你在 Hub 里手动指派、手动运行不受限制");
}
function linearSection(p) {
  const L = settings.get().linear ?? { connected: false };
  if (!L.connected) return section("Linear", "项目绑定一个 Linear 团队后，工作项与 Linear issue 双向同步。",
    h("div", { class: "callout warn" }, "还没有连接 Linear。", h("button", { class: "primary", onclick: () => { sg.tab = "integrations"; showView("settings"); } }, "去设置连接")));
  if (!p.linear) {
    const used = new Set(issuesApi.projects().filter((x) => x.linear).map((x) => x.linear.teamId));
    const pick = select([["", "选择团队…"], ...(L.teams ?? []).map((t) => [t.id, used.has(t.id) ? `${t.name}（${t.key}，已绑定其他项目）` : `${t.name}（${t.key}）`])], lg.teamPick, (v) => (lg.teamPick = v), { style: "max-width:320px" });
    [...pick.options].forEach((o) => { if (used.has(o.value)) o.disabled = true; });
    return section("Linear", "一个项目对应一个 Linear 团队（一个团队也只能绑定一个项目）。",
      h("div", { class: "row" }, pick,
        h("button", { class: "primary", onclick: async () => {
          if (!lg.teamPick) return toast("先选择一个团队", "err");
          try { await issuesApi.connectLinear(p.id, lg.teamPick); lg.teamPick = ""; pg.draft = null; renderProjectPage(); toast("已绑定 Linear 团队，点「同步 Linear」导入 issue", "ok"); } catch (e) { fail(e); }
        } }, "绑定"),
        h("span", { class: "muted", style: "font-size:12.5px" }, `以 ${L.viewer} 的身份访问`)));
  }
  const cfg = p.linear;
  const save = (patch) => issuesApi.saveProject({ name: p.name, key: p.key, linear: { ...cfg, ...patch } }, p.id).then(() => renderProjectPage()).catch(fail);
  const label = h("input", { placeholder: "标签，如 agent", style: "max-width:160px", value: cfg.importLabel, onchange: (e) => save({ importLabel: e.target.value.trim() || "agent" }) });
  return section("Linear", "工作项与 Linear issue 同步：导入 open issue、新建时同步创建、状态与优先级写回、交付结果回写评论。",
    h("div", { class: "callout" }, h("span", { class: "lin-mark", "aria-hidden": "true" }), h("b", {}, cfg.teamName), h("span", { class: "tag" }, cfg.teamKey), h("span", { class: "ok-text" }, "已绑定"),
      h("span", { style: "margin-left:auto" }),
      h("button", { disabled: cfg.mode === "off" ? "" : null, onclick: async (e) => {
        e.target.disabled = true; e.target.textContent = "同步中…";
        try { toast(await issuesApi.syncLinear(p.id), "ok"); } catch (err) { fail(err); }
        renderProjectPage();
      } }, "同步 Linear"),
      h("button", { class: "danger", onclick: async () => { if (confirm(`解绑 Linear 团队 ${cfg.teamName}？已关联的工作项会保留 Linear 编号，但不再同步。`)) { await issuesApi.disconnectLinear(p.id); renderProjectPage(); } } }, "解绑")),
    (() => {
      const src = p.sync.source ?? (p.linear ? "linear" : p.repo ? "github" : "manual");
      if (src === "linear") return null;
      return h("div", { class: "callout" },
        h("div", {}, h("b", {}, "当前来源是「" + (src === "github" ? "GitHub 仓库" : "仅手动创建") + "」，不会从 Linear 导入 issue。"),
          h("div", { class: "muted", style: "font-size:12.5px;margin-top:4px" }, "但下面的推送设置仍然有效：本地新建或改动的、已关联 Linear 的工作项，会把状态写回 Linear。要让 issue 来自 Linear，把上面的来源改过来。")));
    })(),
    field("同步方向", select(LINEAR_MODES, cfg.mode, (v) => save({ mode: v }), { style: "max-width:320px" })),
    (p.sync.source ?? (p.linear ? "linear" : p.repo ? "github" : "manual")) === "linear" && ["two_way", "import"].includes(cfg.mode)
      ? field("导入范围", h("div", { class: "fields", style: "gap:8px" },
          h("div", { class: "row" },
            select([["all", "所有未完成的 issue"], ["label", "只导入带指定标签的 issue"], ["assignee", "只导入指派给指定成员的 issue"]], cfg.importScope, async (v) => {
              // 切到「按指派人」且还没选人时，默认选当前连接 Linear 的账号（也就是「我」）
              if (v === "assignee" && !(cfg.importAssignees ?? []).length) {
                const me = await issuesApi.linearMe().catch(() => null);
                return save({ importScope: v, importAssignees: me ? [{ id: me.id, name: me.name }] : [] });
              }
              save({ importScope: v });
            }, { style: "max-width:280px" }),
            cfg.importScope === "label" ? label : null),
          cfg.importScope === "assignee" ? importAssigneePicker(p, cfg, save) : null),
          cfg.importScope === "assignee" ? "按 Linear 上的指派人筛选；只影响以后的新导入，已经导入的工作项不会删除" : "导入后进入「待规划」，保留 Linear 优先级")
      : null,
    ["two_way", "import"].includes(cfg.mode) ? linearAutoField(p, cfg, save) : null,
    ["two_way", "push"].includes(cfg.mode) ? h("div", { class: "checks" },
      checkboxP(cfg.pushNew, (on) => save({ pushNew: on }), "新建工作项时默认同时创建 Linear issue", "新建时可单独取消勾选"),
      checkboxP(cfg.postDeliverable, (on) => save({ postDeliverable: on }), "智能体的交付结果回写为 Linear 评论")) : null,
    ["two_way", "push"].includes(cfg.mode) ? flowRules(p) : null,
    field("状态映射", h("table", { class: "map-table" },
      h("tr", {}, h("th", {}, "工作项状态"), h("th", {}, "Linear 状态类型")),
      h("tr", {}, h("td", {}, "待规划"), h("td", {}, "Backlog")),
      h("tr", {}, h("td", {}, "待办"), h("td", {}, "Unstarted（Todo）")),
      h("tr", {}, h("td", {}, "进行中 / 待审核"), h("td", {}, "Started（待审核优先匹配名称含 Review 的状态）")),
      h("tr", {}, h("td", {}, "完成"), h("td", {}, "Completed")),
      h("tr", {}, h("td", {}, "已取消"), h("td", {}, "Canceled"))), "优先级 1 紧急 · 2 高 · 3 中 · 4 低 与 Linear 一致。Hub 里的修改实时写回；Linear 上的完成、取消、重新打开和优先级修改在下次同步时拉回"),
    h("div", { class: "muted", style: "font-size:12.5px" }, cfg.lastSyncAt ? `上次同步：${new Date(cfg.lastSyncAt).toLocaleString()}${cfg.pendingRemote ? ` · ${cfg.pendingRemote} 个不在导入范围内` : ""}` : "还没有同步过"));
}
function checkboxP(checked, onchange, label, small) {
  const input = h("input", { type: "checkbox", onchange: (e) => onchange(e.target.checked) });
  input.checked = checked;
  return h("label", { class: "check" }, input, h("span", {}, label, small ? h("small", {}, small) : null));
}

// ======================= 设置页：模型服务 / 模型 / GitHub =======================
const sg = { editing: null, modelForm: null, toolForm: null, mcpForm: null };
function renderSettings() {
  if (holdWhileEditing("#settingsPage", renderSettings)) return;
  const S = settings.get();
  const usage = (mid) => studio.agents().filter((a) => a.model === mid).map((a) => a.name);
  const provStatus = (p) => simulateMode()
    ? h("span", { class: "muted", style: "font-size:12.5px" }, "演示模式 · 脚本化模型，无需凭据")
    : p.verifiedAt
      ? h("span", { class: "ok-text", style: "font-size:12.5px" }, p.method === "key" ? `✓ 已验证 · ${p.keyHint}` : "✓ 使用本机 ant 登录凭据")
      : h("span", { class: "err-text", style: "font-size:12.5px" }, "未配置凭据");

  // 连接编辑表单：协议、Base URL、API Key，保存前探测可用模型
  const presets = S.providerPresets ?? [];
  const provForm = (p) => {
    const f = {
      name: p?.name ?? "",
      type: p?.type ?? "anthropic",
      baseUrl: p?.baseUrl ?? "https://api.anthropic.com",
      method: p?.method === "profile" ? "profile" : "key",
      key: "",
    };
    const name = h("input", { placeholder: "连接名称，如 DeepSeek（团队）", oninput: (e) => (f.name = e.target.value) });
    name.value = f.name;
    const baseUrl = h("input", { placeholder: "https://api.deepseek.com/v1", oninput: (e) => (f.baseUrl = e.target.value) });
    baseUrl.value = f.baseUrl;
    const key = h("input", { type: "password", autocomplete: "off", placeholder: p?.keyHint ? `当前：${p.keyHint}（留空则不修改）` : "sk-…", oninput: (e) => (f.key = e.target.value) });
    const presetSel = select([["", "选择常用服务，自动填好地址与协议…"], ...presets.map((x) => [x.key, `${x.name} · ${x.type === "anthropic" ? "Anthropic 协议" : "OpenAI 协议"}`])], "", (v) => {
      const pr = presets.find((x) => x.key === v);
      if (!pr) return;
      f.type = pr.type;
      f.baseUrl = pr.baseUrl;
      if (!f.name) { f.name = pr.name; name.value = pr.name; }
      baseUrl.value = pr.baseUrl;
      typeSel.value = pr.type;
      note.textContent = pr.note ?? "";
      doc.textContent = pr.docs ? `申请 Key：${pr.docs}` : "";
    }, { style: "max-width:360px" });
    const typeSel = select([["anthropic", "Anthropic 协议（Messages API 及其兼容接口）"], ["openai", "OpenAI 协议（Chat Completions 及其兼容接口）"]], f.type, (v) => (f.type = v), { style: "max-width:360px" });
    const note = h("div", { class: "help", style: "min-height:16px" });
    const doc = h("div", { class: "help" });
    const methodCards = h("div", { class: "radio-row" },
      [["key", "API Key", "在服务商控制台创建的密钥；也可以填自建服务的令牌"], ["profile", "本机登录凭据", "仅 Anthropic 官方：使用服务器上 ant auth login 的登录状态"]].map(([v, t, d]) =>
        h("div", { class: "radio-card" + (f.method === v ? " sel" : ""), onclick: (e) => {
          f.method = v;
          e.currentTarget.parentElement.querySelectorAll(".radio-card").forEach((c, i) => c.classList.toggle("sel", i === (v === "key" ? 0 : 1)));
          keyField.style.display = v === "key" ? "" : "none";
        } }, h("b", {}, t), h("span", {}, d))));
    const keyField = field("API Key", key, "密钥只保存在服务端，页面上只显示掩码");
    keyField.style.display = f.method === "key" ? "" : "none";
    const status = h("span", { style: "font-size:12.5px" });
    const probed = h("div", { class: "chips", style: "margin-top:6px" });
    const showModels = (list) => fill(probed, ...(list?.length ? [
      h("span", { class: "muted", style: "font-size:12.5px;margin-right:4px" }, `探测到 ${list.length} 个模型：`),
      ...list.slice(0, 24).map((id) => h("button", { class: "chip", style: "padding:0 8px", title: "添加为模型条目", onclick: () => { sg.modelForm = { label: id, modelId: id, providerId: p?.id }; renderSettings(); } }, id)),
    ] : []));
    if (p?.models?.length) showModels(p.models);
    return h("div", { class: "card", style: "margin-top:8px" }, h("div", { class: "fields" },
      field("常用服务", presetSel, "选择后自动填好协议与 Base URL，也可以手动填写任意兼容地址"),
      field("名称", name),
      field("协议", typeSel),
      field("Base URL", baseUrl, "OpenAI 协议需要包含版本路径（通常以 /v1 结尾）；Anthropic 协议填站点根地址即可"),
      note, methodCards, keyField, doc,
      h("div", { class: "row" }, status, h("span", { style: "margin-left:auto" }),
        h("button", { onclick: () => { sg.editing = null; renderSettings(); } }, "取消"),
        h("button", { class: "primary", onclick: async (e) => {
          if (f.method === "key" && !f.key && p?.keyHint) f.key = undefined;
          e.target.disabled = true; status.className = "muted"; status.textContent = "正在连接并拉取模型列表…";
          try {
            await settings.verifyProvider(p?.id, f);
            sg.editing = null; renderSettings(); toast("连接已验证并保存", "ok");
          } catch (err) { status.className = "err-text"; status.textContent = err.message; e.target.disabled = false; }
        } }, "验证并保存")),
      h("div", {}, h("a", { class: "link", style: "font-size:12.5px", onclick: async (e) => {
        if (!p?.id) return;
        e.target.textContent = "拉取中…";
        try { await act("settings.listProviderModels", p.id); renderSettings(); toast("模型列表已刷新", "ok"); }
        catch (err) { e.target.textContent = "重新拉取模型"; fail(err); }
      } }, "重新拉取模型列表")),
      probed));
  };

  // 添加 / 编辑模型
  const modelForm = () => {
    const m = sg.modelForm;
    const provider = S.providers.find((p) => p.id === (m.providerId ?? S.providers[0]?.id)) ?? S.providers[0];
    const known = [...new Set([...(provider?.models ?? []), ...MODELS.map((x) => x.id)])];
    const label = h("input", { placeholder: "显示名称，如 DeepSeek Chat", oninput: (e) => (m.label = e.target.value) });
    label.value = m.label ?? "";
    const custom = h("input", { placeholder: "模型 ID", oninput: (e) => (m.modelId = e.target.value) });
    custom.value = m.modelId ?? "";
    return h("div", { class: "card", style: "margin-top:8px" }, h("div", { class: "fields" },
      field("使用的连接", select(S.providers.map((p) => [p.id, `${p.name}${p.type === "openai" ? "（OpenAI 协议）" : "（Anthropic 协议）"}`]), m.providerId ?? S.providers[0]?.id, (v) => { m.providerId = v; renderSettings(); }, { style: "max-width:360px" })),
      field("模型 ID", h("div", { class: "row" }, select([["", known.length ? "从该连接的模型中选…" : "先验证连接以拉取模型…"], ...known.map((id) => [id, id])], "", (v) => { if (v) { m.modelId = v; custom.value = v; if (!m.label) { m.label = v; label.value = v; } } }, { style: "max-width:320px" }), custom), "可以直接填写服务商文档里的模型名"),
      field("显示名称", label),
      h("div", { class: "row", style: "justify-content:flex-end" },
        h("button", { onclick: () => { sg.modelForm = null; renderSettings(); } }, "取消"),
        h("button", { class: "primary", onclick: () => settings.saveModel({ providerId: m.providerId ?? S.providers[0]?.id, ...m }).then(() => { sg.modelForm = null; renderSettings(); toast("模型已保存", "ok"); }).catch(fail) }, "保存"))));
  };

  // GitHub
  let ghBlock;
  const gh = S.github;
  if (gh.connected) {
    ghBlock = h("div", { class: "fields" },
      h("div", { class: "acct" }, avatar(gh.login), h("div", {}, h("b", {}, gh.login), h("div", { class: "muted", style: "font-size:12.5px" },
        `Personal Access Token · ${gh.tokenHint} · ${ago(gh.connectedAt)}`)),
        h("span", { style: "margin-left:auto" }),
        h("button", { onclick: () => rpc("settings.refreshGithubRepos").then(refreshState).then(() => { renderSettings(); toast("已刷新仓库列表", "ok"); }).catch(fail) }, "刷新仓库"),
        h("button", { class: "danger", onclick: () => settings.disconnectGithub().then(() => { renderSettings(); toast("已断开 GitHub"); }).catch(fail) }, "断开")),
      field("权限范围", h("div", { class: "chips" }, gh.scopes.map((s) => h("span", { class: "tag" }, s)))),
      field("可访问的仓库", h("div", { class: "chips" }, gh.repos.map((r) => h("span", { class: "chip", style: "padding:0 8px;cursor:default" }, ghIcon(), r))),
        "项目设置里绑定仓库时，从这些仓库中选择"));
  } else {
    const tok = h("input", { type: "password", autocomplete: "off", placeholder: "ghp_… 或 github_pat_…" });
    const st2 = h("span", { style: "font-size:12.5px" });
    ghBlock = h("div", { class: "fields" },
      h("div", { class: "radio-row" },
        h("div", { class: "radio-card", style: "cursor:default" }, h("b", {}, "Personal Access Token"),
          h("span", {}, "推荐 fine-grained token，授权到需要的仓库，权限：Contents、Issues、Pull requests 读写，Metadata 只读"),
          h("div", { class: "row", style: "margin-top:10px;flex-wrap:nowrap" }, tok,
            h("button", { onclick: async (e) => {
              e.target.disabled = true; st2.className = "muted"; st2.textContent = "验证中…";
              try { await settings.githubPAT(tok.value); renderSettings(); toast("GitHub 已连接", "ok"); }
              catch (err) { st2.className = "err-text"; st2.textContent = err.message; e.target.disabled = false; }
            } }, "验证")), st2)));
  }

  // Linear
  let lnBlock;
  const L = S.linear ?? { connected: false };
  if (L.connected) {
    lnBlock = h("div", { class: "fields" },
      h("div", { class: "acct" }, avatar(L.viewer), h("div", {}, h("b", {}, L.viewer), h("div", { class: "muted", style: "font-size:12.5px" },
        `Personal API Key · ${L.keyHint} · ${ago(L.connectedAt)}`)),
        h("span", { style: "margin-left:auto" }),
        h("button", { onclick: () => settings.refreshLinearTeams().then(() => { renderSettings(); toast("已刷新团队列表", "ok"); }).catch(fail) }, "刷新团队"),
        h("button", { class: "danger", onclick: () => settings.disconnectLinear().then(() => { renderSettings(); toast("已断开 Linear"); }).catch(fail) }, "断开")),
      field("可访问的团队", h("div", { class: "chips" }, (L.teams ?? []).map((t) => h("span", { class: "chip", style: "padding:0 8px;cursor:default" }, h("span", { class: "lin-mark", "aria-hidden": "true" }), `${t.name}（${t.key}）`))),
        "项目设置里绑定团队时，从这些团队中选择"));
  } else {
    const tok = h("input", { type: "password", autocomplete: "off", placeholder: "lin_api_…" });
    const st3 = h("span", { style: "font-size:12.5px" });
    lnBlock = h("div", { class: "fields" },
      h("div", { class: "radio-row" },
        h("div", { class: "radio-card", style: "cursor:default" }, h("b", {}, "Personal API Key"),
          h("span", {}, "在 Linear → Settings → Security & access → Personal API keys 创建；需要读写 issue 与评论的权限"),
          h("div", { class: "row", style: "margin-top:10px;flex-wrap:nowrap" }, tok,
            h("button", { onclick: async (e) => {
              e.target.disabled = true; st3.className = "muted"; st3.textContent = "验证中…";
              try { await settings.connectLinear(tok.value); renderSettings(); toast("Linear 已连接", "ok"); }
              catch (err) { st3.className = "err-text"; st3.textContent = err.message; e.target.disabled = false; }
            } }, "验证")), st3)));
  }

  const enabled = S.models.filter((m) => m.enabled);

  // 自定义模型服务：没有可用运行底座时使用
  const customService = h("div", {},
    S.providers.map((p) => sg.editing === p.id ? provForm(p) : h("div", { class: "callout", style: "margin-bottom:6px" },
      h("span", { class: "ai-mark" }, "A"), h("div", {}, h("b", {}, p.name), h("div", {}, provStatus(p))),
      h("span", { style: "margin-left:auto" }),
      h("span", { class: "muted", style: "font-size:12.5px" }, `${S.models.filter((m) => m.providerId === p.id).length} 个模型`),
      h("button", { onclick: () => { sg.editing = p.id; renderSettings(); } }, p.verifiedAt ? "修改" : "配置"),
      S.providers.length > 1 ? h("button", { class: "danger", onclick: () => settings.removeProvider(p.id).then(renderSettings).catch(fail) }, "移除") : null)),
    sg.editing === "new" ? provForm(null) : h("div", {}, h("a", { class: "link", style: "font-size:13px", onclick: () => { sg.editing = "new"; renderSettings(); } }, "+ 添加连接")),
    h("div", { class: "muted", style: "font-size:12px" }, "支持两种协议：Anthropic（Messages API）与 OpenAI（Chat Completions）。官方与兼容端点都可以，例如 DeepSeek、Kimi、智谱、通义、豆包、SiliconFlow、OpenRouter、Ollama、vLLM 等。"));

  fill($("#settingsPage"), h("div", { class: "studio-inner" },
    h("div", { class: "ed-head" }, h("div", {}, h("h2", {}, "设置"), h("div", { class: "sub" }, "全局配置，所有项目共用")),
      h("div", { class: "actions" }, demoFlag(""))),
    runtimesSection(customService),
    withId(section("模型", "内置运行底座（走自定义模型服务）的智能体只能绑定这里已启用的模型，默认模型用于新建智能体；CLI 底座的模型见上方对应卡片。",
      h("table", { class: "map-table", style: "width:100%" },
        h("tr", {}, h("th", {}, "模型"), h("th", {}, "连接"), h("th", {}, "智能体"), h("th", {}, "启用"), h("th", {}, "默认"), h("th", {})),
        S.models.map((m) => {
          const en = h("input", { type: "checkbox", onchange: (e) => {
            if (!e.target.checked && usage(m.id).length && !confirm(`${usage(m.id).join("、")} 正在使用该模型，停用后它们需要改用其他模型。继续？`)) { e.target.checked = true; return; }
            m.enabled = e.target.checked; settings.patch({}); renderSettings();
          } });
          en.checked = m.enabled;
          const df = h("input", { type: "radio", name: "defModel", onchange: () => { settings.patch({ defaultModel: m.id }); renderSettings(); } });
          df.checked = S.defaultModel === m.id;
          if (!m.enabled) df.disabled = true;
          const prov = settings.provider(m.providerId);
          return h("tr", {},
            h("td", {}, h("b", {}, m.label), h("div", { class: "muted", style: "font-size:12px;font-family:var(--mono)" }, m.modelId), m.price ? h("div", { class: "muted", style: "font-size:11.5px" }, m.price) : null),
            h("td", {}, prov?.name ?? "—", simulateMode() ? h("div", { class: "muted", style: "font-size:12px" }, "演示模式无需凭据") : prov && !prov.verifiedAt ? h("div", { class: "err-text", style: "font-size:12px" }, "未配置凭据") : null),
            h("td", { style: "font-size:12.5px" }, usage(m.id).join("、") || h("span", { class: "muted" }, "—")),
            h("td", {}, en), h("td", {}, df),
            h("td", {}, h("a", { class: "link", style: "font-size:12.5px", onclick: () => { sg.modelForm = { ...m }; renderSettings(); } }, "编辑"),
              !m.builtin ? [" ", h("a", { class: "link", style: "font-size:12.5px;color:var(--failed)", onclick: () => { if (usage(m.id).length) return fail(new Error("还有智能体在用这个模型")); settings.removeModel(m.id).then(renderSettings).catch(fail); } }, "删除")] : null));
        })),
      sg.modelForm ? modelForm() : h("div", {}, h("a", { class: "link", style: "font-size:13px", onclick: () => { sg.modelForm = {}; renderSettings(); } }, "+ 添加模型")),
      field("默认思考强度", select(EFFORTS, S.defaultEffort, (v) => settings.patch({ defaultEffort: v }), { style: "max-width:320px" }), `已启用 ${enabled.length} 个模型`))),
    section("GitHub", "用于项目绑定仓库、同步 issue、提交和合并 PR。", ghBlock),
    section("Linear", "用于项目绑定 Linear 团队，工作项与 Linear issue 双向同步。", lnBlock),
  ));
}

// ======================= 运行中心：按阶段的队列看板 =======================
/** 进行中的工作项按当前阶段分到五列；评审通过后离开队列，进入工作项的「待审核」 */
function phaseBoard(all) {
  const running = all.filter((i) => i.status === "in_progress");
  const order = (p) => (p === 0 ? 5 : p);
  return h("div", { class: "qboard" }, PHASES.map((ph) => {
    const hot = (i) => (i.labels.includes("hotfix") ? 0 : 1);
    const items = running.filter((i) => (i.phase ?? "understand") === ph.id).sort((a, b) => prioOrder(a.priority) - prioOrder(b.priority) || hot(a) - hot(b) || b.updatedAt.localeCompare(a.updatedAt));
    return h("div", { class: "bcol qcol" },
      h("div", { class: "bcol-head" }, h("span", { class: "qdot q-" + ph.id }), h("span", {}, ph.label), h("span", { class: "count" }, items.length)),
      h("div", { class: "bcol-body" }, items.length ? items.map((i) => {
        const cur = i.phases.filter((r) => r.result === "active").at(-1);
        const fixes = i.phases.filter((r) => r.cycle === i.cycle && r.phase === "test" && r.result === "fail").length;
        const prevFail = i.phases.filter((r) => r.cycle === i.cycle - 1 && r.result === "fail").at(-1);
        return h("div", { class: "icard running", onclick: () => { location.hash = "#issue=" + i.key; } },
          h("div", { class: "icard-top" }, pbadge({ key: i.projectKey }), h("span", { class: "ikey" }, i.key),
            prio(i.priority), i.labels.includes("hotfix") ? h("span", { class: "label hot" }, "⚡ HOTFIX") : null, h("span", { style: "margin-left:auto" }, avatar(i.assignee))),
          h("div", { class: "ititle" }, i.title),
          h("div", { class: "imeta" },
            i.cycle > 1 ? h("span", { class: "cycle-tag warn", title: prevFail ? `上轮${phaseLabel(prevFail.phase)}未通过：${prevFail.note}` : "" }, `第 ${i.cycle} 轮`) : null,
            fixes ? h("span", { class: "cycle-tag warn" }, `测试返工 ${fixes} 次`) : null,
            typeof auto !== "undefined" && auto.stuck(i.key) ? h("span", { class: "cycle-tag warn", style: "color:var(--failed)" }, `⚠ 哨兵处理中（${auto.stuck(i.key).level} 次）`) : null,
            cur ? h("span", { class: "muted", style: "font-size:11.5px;margin-left:auto" }, `本阶段 ${ago(cur.startedAt).replace("前", "")}`) : null),
          miniSteps(i));
      }) : h("div", { class: "bcol-empty" }, "空闲")));
  }));
}

// ======================= 首页：管家 =======================
const butler = { get msgs() { return S.butler; } };
/** 卡片（拆分计划等）的编辑会延迟同步到服务端 */
let butlerSaveT = null;
function saveButler() {
  clearTimeout(butlerSaveT);
  butlerSaveT = setTimeout(() => S.butler.forEach((m, i) => { if (m.card) rpc("assistant.updateCard", i, m.card).catch(() => {}); }), 300);
}
let butlerBusy = false;
const BUTLER_SUGGESTS = ["汇总一下各项目进展", "官网要加一个博客模块，支持 Markdown 和标签", "把 WEB-3 优先级调成紧急", "开启官网改版的持续迭代"];
/** 按项目前缀匹配的关键词（示例项目）；其他项目按名称或前缀匹配 */
const PROJ_HINTS = { WEB: /官网|网站|首页|页面|博客|seo|定价|移动端|web/i, HUB: /调度|智能体|平台|hub|任务中心|重试|队列|看板/i, KB: /知识库|内部文档|kb/i };

function detectProject(text) {
  const ps = issuesApi.projects();
  for (const p of ps) if (text.includes(p.name) || new RegExp(`\\b${p.key}\\b`, "i").test(text)) return p;
  for (const p of ps) if (PROJ_HINTS[p.key]?.test(text)) return p;
  return null;
}
const PRIO_WORDS = [[/紧急/, 1], [/高/, 2], [/中/, 3], [/低/, 4]];

/** 本地规则回复：演示模式或没有可用模型时使用（正常情况下由服务端的 Claude 回答） */
async function butlerReply(text) {
  const all = await issuesApi.list();
  const lastPlan = [...butler.msgs].reverse().find((m) => m.card?.type === "plan");

  // 1. 确认上一份计划
  if (lastPlan && !lastPlan.card.created && /^(确认|可以|好的?|没问题|创建|就这样|ok)/i.test(text.trim())) {
    const keys = await createPlan(lastPlan.card);
    return { text: `已创建 ${keys.join("、")}。${lastPlan.card.startNow ? "有负责人的已进入待办并开始执行，" : "都放在「待规划」，"}可以在任务中心看执行进度。` };
  }

  // 2. 进展汇总
  if (/进展|状态|汇总|怎么样|情况|概况/.test(text) && !/[A-Za-z]{2,6}-\d+/.test(text)) {
    const att = issuesApi.attention();
    const lines = issuesApi.projects().map((p) => {
      const its = all.filter((i) => i.projectId === p.id);
      const run = its.filter((i) => i.status === "in_progress");
      const phaseTxt = run.map((i) => `${i.key} ${phaseLabel(i.phase) ?? ""}`).join("、");
      return `【${p.name}】进行中 ${run.length}${phaseTxt ? `（${phaseTxt}）` : ""}，待验收 ${p.counts.review}，负责人：${{ off: "关闭", on_demand: "按需", autopilot: "持续迭代" }[p.lead?.mode ?? "off"]}`;
    });
    return { text: `${lines.join("\n")}\n\n${att.length ? `需要你处理 ${att.length} 件：\n${att.slice(0, 5).map((a) => `· ${a.issue.key} ${a.issue.title}：${a.text}`).join("\n")}` : "目前没有需要你处理的事项。"}` };
  }

  // 2.5 Hotfix
  if (/hotfix|紧急修复|线上.*(问题|故障|bug|挂了|报错)|马上修/i.test(text) && !/[A-Za-z]{2,6}-\d+/.test(text)) {
    const p = detectProject(text) ?? curProject();
    const title = text.replace(/hotfix|请?(帮我)?(紧急修复|马上修)一下?/gi, "").replace(/[\s，,。！!、]+$/, "").trim().slice(0, 40) || "紧急修复";
    return { text: `收到，这是紧急问题。我会在「${p.name}」创建 Hotfix，指派给 developer，创建后直接进入「进行中」开始处理，照常走完测试和评审。确认吗？`,
      card: { type: "action", label: `⚡ Hotfix · ${p.key}：${title}`, op: "hotfix", args: { projectId: p.id, title, description: `来源：与管家的对话\n${text}` } } };
  }

  // 3. 负责人模式
  const leadOn = /(开启|打开|启动|恢复).*(持续|自动|迭代)/.test(text);
  const leadOff = /(关闭|停止|暂停).*(持续|自动|迭代|负责人)/.test(text);
  if (leadOn || leadOff) {
    const p = detectProject(text) ?? curProject();
    const mode = leadOn ? "autopilot" : "off";
    return { text: `${leadOn ? "开启后，负责人会持续巡检「" + p.name + "」：分诊新 issue、修 bug、提出并推进改进项，每天最多 " + p.lead.dailyRuns + " 次运行。" : "关闭后，负责人不再主动处理「" + p.name + "」。"}确认执行吗？`,
      card: { type: "action", label: `${p.name}：负责人${leadOn ? "开启持续迭代" : "关闭"}`, op: "lead", args: { projectId: p.id, mode } } };
  }

  // 4. 调整某个工作项
  const ref = /([A-Za-z]{2,6})-(\d+)/.exec(text);
  if (ref) {
    const k = `${ref[1].toUpperCase()}-${ref[2]}`;
    const it = all.find((i) => i.key === k);
    if (!it) return { text: `没找到 ${k}，确认一下编号？` };
    const agent = agentNames().find((n) => text.includes(n));
    const pw = PRIO_WORDS.find(([re]) => re.test(text.replace(/优先级/g, "")));
    if (/优先级|紧急/.test(text) && pw) return { text: `把 ${k}「${it.title}」的优先级改为「${IS.priorities[pw[1]]}」？`, card: { type: "action", label: `${k} 优先级 → ${IS.priorities[pw[1]]}`, op: "update", args: { key: k, patch: { priority: pw[1] } } } };
    if (agent) return { text: `把 ${k} 交给 ${agent}，并放入待办立即开始执行？`, card: { type: "action", label: `${k} 指派给 ${agent} 并开始`, op: "update", args: { key: k, patch: { assignee: agent, status: "todo" } } } };
    if (/取消/.test(text)) return { text: `取消 ${k}「${it.title}」？`, card: { type: "action", label: `取消 ${k}`, op: "update", args: { key: k, patch: { status: "canceled" } } } };
    if (/暂停|停止|先停/.test(text)) return { text: `停止 ${k} 当前的运行，放回待规划？`, card: { type: "action", label: `停止 ${k}`, op: "update", args: { key: k, patch: { status: "backlog" } } } };
    if (/开始|运行|执行|重跑|重试/.test(text)) return { text: `让 ${it.assignee ?? "（未指派）"} 开始执行 ${k}？`, card: { type: "action", label: `运行 ${k}`, op: "run", args: { key: k } } };
    return { text: `${k}「${it.title}」\n状态：${statusOf(it.status).label}${it.phase ? `（${phaseLabel(it.phase)}阶段，第 ${it.cycle} 轮）` : ""}\n负责人：${it.assignee ?? "未指派"}　优先级：${IS.priorities[it.priority]}${it.pr ? `\nPR #${it.pr.number}：${it.pr.state === "merged" ? "已合并" : "待合并"}` : ""}\n\n要怎么调整？比如「优先级调高」「交给 developer」「先暂停」。` };
  }

  // 5. 上一份计划还没确认时，默认把消息当作补充；明确说「另外 / 新需求 / 再加一个」才算新需求
  if (lastPlan && !lastPlan.card.created && !/另外|新需求|再加一个|另一个需求|还有一个需求/.test(text)) {
    lastPlan.card.items.forEach((x) => (x.description += `\n补充：${text}`));
    lastPlan.card.note = (lastPlan.card.note ? lastPlan.card.note + "；" : "") + text;
    return { text: "已把这条补充写进上面计划里每个工作项的描述。还有要调整的吗？确认的话说「确认」或点卡片上的创建按钮。" };
  }

  // 6. 新需求 → 拆分计划
  if (text.length >= 8) {
    const p = detectProject(text) ?? curProject();
    const feat = (/(?:加|做|新增|增加|支持|实现|开发|写)(?:一个|一套|个)?([^，。,.！!？?\n]{2,18})/.exec(text)?.[1] ?? text.slice(0, 14)).trim();
    let items;
    if (/调研|分析|对比|竞品|研究/.test(text)) items = [
      { title: `${feat}：调研与资料收集`, assignee: "researcher", priority: 2, labels: ["调研"] },
      { title: `${feat}：撰写分析报告`, assignee: "writer", priority: 3, labels: ["文档"] },
      { title: `${feat}：报告评审`, assignee: "reviewer", priority: 3, labels: [] },
    ];
    else if (/文案|文章|翻译|周报|介绍/.test(text) && !/页面|功能|模块/.test(text)) items = [
      { title: `${feat}：初稿`, assignee: "writer", priority: 2, labels: ["文案"] },
      { title: `${feat}：审稿`, assignee: "reviewer", priority: 3, labels: ["文案"] },
    ];
    else items = [
      { title: `${feat}：方案设计`, assignee: hasAgent("architect") ? "architect" : "developer", priority: 2, labels: ["设计"] },
      { title: `${feat}：功能实现`, assignee: hasAgent("frontend-dev") && /页面|前端|展示|样式|博客|首页/.test(text) ? "frontend-dev" : hasAgent("backend-dev") && /接口|后端|数据|调度|同步/.test(text) ? "backend-dev" : "developer", priority: 2, labels: ["开发"] },
      { title: `${feat}：测试用例与验证`, assignee: "tester", priority: 3, labels: ["测试"] },
      ...(p?.id === "p_web" || /页面|展示|文案/.test(text) ? [{ title: `${feat}：页面文案`, assignee: "writer", priority: 3, labels: ["文案"] }] : []),
    ];
    items.forEach((x) => { x.description = `来源：与管家的需求讨论\n需求：${text}`; x.on = true; });
    return {
      text: `我理解的需求是：${feat}。\n建议放在「${p?.name ?? "当前项目"}」，先拆成 ${items.length} 个工作项（见下方卡片，标题、负责人、优先级都可以直接改）。\n\n还想确认两点：\n1. 有没有必须满足的验收标准，比如性能、兼容的浏览器或设备？\n2. 这次要不要一起上线，还是先做方案评审？\n\n直接回答即可，我会补进工作项描述；没问题就说「确认」。`,
      card: { type: "plan", projectId: p?.id, items, startNow: false, created: false },
    };
  }
  return { text: "可以多说一点吗？比如要做什么、属于哪个项目、希望什么时候完成。\n也可以让我：汇总各项目进展、调整某个工作项（如「把 WEB-3 优先级调成紧急」）、开启或关闭某个项目的持续迭代。" };
}

async function createPlan(card) {
  const keys = [];
  // 计划内序号（从 1 开始）→ 已创建的工作项编号；没勾选的项不创建，依赖它的项也就不再依赖它
  const byIndex = new Map();
  for (const [n, x] of card.items.entries()) {
    if (!x.on || !x.title.trim()) continue;
    const dependsOn = (x.dependsOn ?? []).map((d) => byIndex.get(d)).filter(Boolean);
    const i = await issuesApi.create({ projectId: card.projectId, title: x.title.trim(), description: x.description, priority: Number(x.priority), assignee: x.assignee || null, labels: x.labels, dependsOn, status: card.startNow ? undefined : "backlog", github: !!issuesApi.project(card.projectId)?.repo && issuesApi.project(card.projectId).sync.pushNew, linear: linearPushable(issuesApi.project(card.projectId)) && issuesApi.project(card.projectId).linear.pushNew });
    keys.push(i.key);
    byIndex.set(n + 1, i.key);
  }
  card.created = keys;
  saveButler();
  return keys;
}
/** 执行一张卡片，不负责提示与重绘，供单张和批量共用 */
async function execCard(card) {
  if (card.op === "update") await issuesApi.update(card.args.key, card.args.patch);
  if (card.op === "run") await issuesApi.run(card.args.key);
  if (card.op === "lead") await issuesApi.setLead(card.args.projectId, { mode: card.args.mode });
  if (card.op === "hotfix") {
    const p = issuesApi.project(card.args.projectId);
    const i = await issuesApi.create({ ...card.args, assignee: null, hotfix: true, github: !!p?.repo && ["two_way", "push"].includes(p.sync.mode), linear: linearPushable(p) });
    card.label += `（${i.key}）`;
  }
  card.done = true;
}
async function runAction(card) {
  try {
    await execCard(card);
    saveButler();
    renderHome();
    toast(`已执行：${card.label}`, "ok");
  } catch (e) { fail(e); }
}
/** 待确认的卡片 */
const pendingActions = () => butler.msgs.map((m) => m.card).filter((c) => c?.type === "action" && !c.done && !c.dismissed);
/** 一次执行全部待确认卡片：批量改状态不该让人点十几下 */
async function runAllActions() {
  const cards = pendingActions();
  if (!cards.length) return;
  let ok = 0;
  const errs = [];
  for (const c of cards) {
    try { await execCard(c); ok++; } catch (e) { errs.push(`${c.label}：${e.message}`); }
  }
  saveButler();
  await refreshState();
  renderHome();
  if (errs.length) toast(`完成 ${ok} 项，失败 ${errs.length} 项：${errs[0]}`, "err");
  else toast(`已执行 ${ok} 项`, "ok");
}

function planCard(m) {
  const c = m.card;
  if (c.created) return h("div", { class: "pcard done" }, h("div", { class: "pc-head" }, "✓ 已创建 ", c.created.map((k, n) => [n ? "、" : "", h("a", { class: "link", href: "#issue=" + k }, k)])));
  const projSel = select(issuesApi.projects().map((p) => [p.id, `${p.key} · ${p.name}`]), c.projectId, (v) => { c.projectId = v; saveButler(); }, { style: "width:auto" });
  const start = h("input", { type: "checkbox", onchange: (e) => { c.startNow = e.target.checked; saveButler(); } });
  start.checked = c.startNow;
  return h("div", { class: "pcard" },
    h("div", { class: "pc-head" }, h("b", {}, "拆分计划"), h("span", { class: "muted" }, "创建到"), projSel),
    c.items.map((x) => {
      const on = h("input", { type: "checkbox", onchange: (e) => { x.on = e.target.checked; saveButler(); } });
      on.checked = x.on;
      const t = h("input", { class: "pc-title", oninput: (e) => { x.title = e.target.value; saveButler(); } });
      t.value = x.title;
      return h("div", { class: "pc-row" }, on, h("span", { class: "muted", style: "font-size:12px;min-width:22px" }, `#${c.items.indexOf(x) + 1}`), t,
        x.dependsOn?.length ? h("span", { class: "tag", title: "依赖这些项完成后才开始" }, `依赖 ${x.dependsOn.map((d) => "#" + d).join(" ")}`) : null,
        select(assigneeOptions(), x.assignee ?? "", (v) => { x.assignee = v; saveButler(); }, { style: "width:auto" }),
        select(prioOptions(), x.priority, (v) => { x.priority = Number(v); saveButler(); }, { style: "width:auto" }));
    }),
    c.note ? h("div", { class: "muted", style: "font-size:12.5px" }, `已补充：${c.note}`) : null,
    h("div", { class: "pc-foot" }, h("label", { class: "chk" }, start, c.items.some((x) => x.dependsOn?.length) ? "创建后立即开始（有依赖的项等依赖完成后自动开始）" : "创建后立即开始执行"), h("span", { style: "margin-left:auto" }),
      h("button", { class: "primary", onclick: async () => {
        const keys = await createPlan(c);
        await rpc("assistant.append", { role: "ai", text: `已创建 ${keys.join("、")}。` });
        await refreshState();
        renderHome();
        toast(`已创建 ${keys.length} 个工作项`, "ok");
      } }, `创建 ${c.items.filter((x) => x.on).length} 个工作项`)));
}
function actionCard(m) {
  const c = m.card;
  return h("div", { class: "pcard" + (c.done || c.dismissed ? " done" : "") },
    h("div", { class: "pc-head" }, h("b", {}, c.label)),
    c.done ? h("div", { class: "ok-text", style: "font-size:13px" }, "✓ 已执行") : c.dismissed ? h("div", { class: "muted", style: "font-size:13px" }, "已取消") :
      h("div", { class: "pc-foot" }, h("span", { style: "margin-left:auto" }),
        h("button", { onclick: () => { c.dismissed = true; saveButler(); renderHome(); } }, "取消"),
        h("button", { class: "primary", onclick: () => runAction(c) }, "执行")));
}

// ======================= 管家对话：附件（截图 / 文件） =======================
const homeAtt = { pending: [] };
async function uploadFiles(files) {
  const list = [...(files ?? [])].filter(Boolean);
  if (!list.length) return;
  const fd = new FormData();
  for (const f of list.slice(0, 10)) fd.append("file", f, f.name || "截图.png");
  const res = await fetch("/api/upload", { method: "POST", body: fd });
  let data = null;
  try { data = await res.json(); } catch { /* 非 JSON */ }
  if (!res.ok) throw new Error(data?.error || `上传失败（HTTP ${res.status}）`);
  homeAtt.pending.push(...(data.attachments ?? []));
  renderHome();
}
/** 待发送的附件：图片显示缩略图，文件显示名称 */
// 登录改成了会话 Cookie：同源的图片请求会自动带上，不需要再拼令牌（旧的全局 token 已不存在，引用它会直接报错）
const attUrl = (u) => u;
function attachChips(list, onRemove) {
  if (!list?.length) return null;
  return h("div", { class: "att-chips" }, list.map((a, n) => h("span", { class: "att-chip", title: `${a.name} · ${Math.max(1, Math.round((a.size ?? 0) / 1024))} KB` },
    a.kind === "image" ? h("img", { src: attUrl(a.url), alt: a.name }) : h("span", { style: "max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" }, `📄 ${a.name}`),
    onRemove ? h("button", { title: "移除", onclick: (e) => { e.stopPropagation(); onRemove(n); } }, "×") : null)));
}

let butlerDraft = "";
/**
 * 管家输入框只创建一次、每次重绘复用同一个节点：首页会随运行进度频繁重绘，
 * 每次新建输入框会清掉正在打的字、打断中文输入法组字、丢掉光标。
 */
let homeInputNode = null;
let homeInputWrap = null, homeAttachBtn = null, homeSendBtn = null;
/**
 * 按顺序更新子节点，但已经在位的常驻节点原地不动：只删除不再需要的、在常驻节点前后插入新的。
 * 与 fill 不同，它不会把常驻节点摘下再放回（摘下会失去焦点、打断输入法）。
 */
function patchChildren(parent, ...nodes) {
  const list = nodes.flat(Infinity).filter((c) => c != null && c !== false).map((c) => (c instanceof Node ? c : document.createTextNode(String(c))));
  const keep = new Set(list);
  for (const c of [...parent.childNodes]) if (!keep.has(c)) c.remove();
  let ref = parent.firstChild;
  for (const n of list) {
    if (n === ref) { ref = ref.nextSibling; continue; }
    parent.insertBefore(n, ref);
  }
  return parent;
}
function homeInputEl() {
  if (homeInputNode) return homeInputNode;
  homeInputNode = h("textarea", { id: "homeInput", placeholder: "和管家说说你的想法…（Enter 发送，Shift+Enter 换行；可以直接粘贴截图或文件）",
    oninput: (e) => (butlerDraft = e.target.value),
    onpaste: (e) => { const fs = [...(e.clipboardData?.files ?? [])]; if (fs.length) { e.preventDefault(); uploadFiles(fs).catch(fail); } },
    ondragover: (e) => { e.preventDefault(); e.currentTarget.classList.add("drop"); },
    ondragleave: (e) => e.currentTarget.classList.remove("drop"),
    ondrop: (e) => { e.preventDefault(); e.currentTarget.classList.remove("drop"); const fs = [...(e.dataTransfer?.files ?? [])]; if (fs.length) uploadFiles(fs).catch(fail); },
    onkeydown: (e) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendButler(e.target.value); } } });
  homeInputNode.value = butlerDraft;
  return homeInputNode;
}
/** 管家对话默认只渲染最近 20 条，更早的折叠在顶部，滚到顶或点按钮再往前加载 */
let butlerShown = 20;
/** 上次渲染时的消息总数：用来判断「有没有新消息」和「对话是否被清空」 */
let butlerSeen = 0;
/** 加载更早消息后要恢复的滚动锚点，避免一加载就跳走 */
let butlerRestore = null;
async function sendButler(text) {
  text = (text ?? "").trim();
  const atts = homeAtt.pending.slice();
  if ((!text && !atts.length) || butlerBusy) return;
  const ids = atts.map((a) => a.id);
  homeAtt.pending = [];
  butlerDraft = "";
  S.butler.push({ role: "me", text: text || "（发送了附件）", attachments: atts.length ? atts : undefined });
  butlerBusy = true;
  const inp = $("#homeInput");
  if (inp) inp.value = "";
  renderHome();
  try {
    const r = await rpc("assistant.butler", text, ids);
    if (r?.fallback) {
      S.butler.pop();
      const reply = await butlerReply(text || "我发了附件，你看一下");
      // 明确告诉用户这不是 AI 回复，以及怎么接上模型
      const note = `> 当前没有可用的模型${r.reason ? `（${r.reason}）` : ""}，下面是按关键词匹配的规则回复。到「设置 → 模型接入」配置模型 API，或在本机安装并登录 Claude Code 后，管家会用 AI 回答。\n\n`;
      await rpc("assistant.append", { role: "me", text: text || "（发送了附件）", attachments: atts.length ? atts : undefined });
      await rpc("assistant.append", { role: "ai", ...reply, text: note + reply.text, via: "rules" });
    }
  } catch (e) { fail(e); }
  butlerBusy = false;
  await refreshState();
  renderHome();
}

/** 打开首页时预热管家的 Claude Code 进程（服务端判断是否需要；不发消息、不消耗额度）。一分钟最多一次 */
let butlerWarmAt = 0;
function warmButler() {
  if (Date.now() - butlerWarmAt < 60_000) return;
  butlerWarmAt = Date.now();
  rpc("assistant.warm").catch(() => {});
}

async function renderHome() {
  if (!viewActive("home")) return;
  if (document.activeElement === openSelect && holdWhileEditing("#homeChat", renderHome)) return;
  warmButler();
  // 注意：这里拿到的还是上一轮的节点。fill 之后会换成新节点，
  // 所以「是否贴底」必须现在算，不能等替换完成后再读新节点的 scrollTop（永远是 0）
  const prevBox = $("#homeMsgs");
  const nearBottom = !prevBox || prevBox.scrollHeight - prevBox.scrollTop - prevBox.clientHeight < 40;
  const prevH = prevBox?.scrollHeight ?? 0;
  const prevTop = prevBox?.scrollTop ?? 0;
  const total = butler.msgs.length;
  if (total < butlerSeen) butlerShown = 20; // 清空或回滚时回到默认窗口
  const shown = Math.min(butlerShown, total);
  const visible = butler.msgs.slice(total - shown);
  const hasOlder = total > shown;
  const grew = total > butlerSeen;
  const all = await issuesApi.list();
  const att = issuesApi.attention();
  const projects = issuesApi.projects();
  const leadFeed = projects.flatMap((p) => issuesApi.leadActivity(p.id).slice(0, 6).map((a) => ({ ...a, p }))).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 8);
  const MODE = { off: ["关闭", ""], on_demand: ["按需", "s-running"], autopilot: ["持续迭代", "s-completed"] };

  const hr = new Date().getHours();
  const welcome = butler.msgs.length ? null : h("div", { class: "hero" },
    h("h1", {}, `${hr < 6 ? "夜深了" : hr < 12 ? "早上好" : hr < 18 ? "下午好" : "晚上好"}，今天想推进什么？`),
    h("p", {}, projects.length
      ? `我是管家，能看到全部 ${projects.length} 个项目的工作项和执行情况。和我说说需求，我来拆成工作项放进对应项目；也可以让我调整任务、汇总进展，或开关项目负责人的持续迭代。`
      : "我是管家。现在还没有项目——先创建一个项目（工作项、看板和仓库绑定都在项目下面），然后把想法告诉我，我来拆成工作项。",
      projects.length ? null : h("div", { style: "margin-top:12px" }, h("button", { class: "primary", onclick: () => openNewProject() }, "创建第一个项目"))));
  const fileInput = h("input", { id: "homeFile", type: "file", multiple: "true", style: "display:none", onchange: (e) => { uploadFiles(e.target.files).catch(fail); e.target.value = ""; } });
  const msgs = visible.map((m) => m.role === "me"
    ? h("div", { class: "bubble me" }, m.text, attachChips(m.attachments))
    : h("div", { class: "ai-row" }, h("span", { class: "ai-mark" }, "✦"), h("div", { class: "ai-col" },
        m.thinking ? h("details", { class: "think" },
          h("summary", {}, "思考过程", h("span", { class: "muted" }, ` ${m.thinking.length} 字`)),
          h("div", { class: "think-body" }, m.thinking)) : null,
        mdEl(m.text),
        m.card?.type === "plan" ? planCard(m) : m.card?.type === "action" ? actionCard(m) : null,
        // 标注回复来自哪个通道：规则回复不能让人误以为是 AI
        m.via ? h("div", { class: "muted", style: "font-size:11.5px;margin-top:4px" }, { api: "模型 API", "claude-code": "本机 Claude Code", rules: "规则回复（未连接模型）" }[m.via] ?? "") : null)));

  patchChildren($("#homeChat"),
    h("div", { class: "home-chat-head" }, h("span", { class: "ai-mark" }, "✦"), h("b", {}, "管家"), h("span", { class: "muted" }, "讨论需求 · 拆分任务 · 调整计划"),
      h("span", { style: "margin-left:auto" }),
      (() => {
        const cur = S.settings.assistantModel || "";
        const opts = [["", `模型：跟随默认（${modelLabel(S.settings.defaultModel)}）`], ...S.settings.models.filter((m) => m.enabled).map((m) => [m.id, `模型：${m.label}`])];
        return select(opts, cur, (v) => {
          S.settings.assistantModel = v;
          act("settings.setAssistantModel", v).then(() => toast(v ? `管家已切换到 ${modelLabel(v)}` : "管家已跟随默认模型", "ok")).catch(fail);
        }, { style: "width:auto;max-width:260px", title: "管家对话使用的模型" });
      })(),
      demoFlag(),
      butler.msgs.length ? h("button", { style: S.simulate ? "" : "margin-left:auto", onclick: () => { if (confirm("清空与管家的对话？")) act("assistant.clear").then(renderHome); } }, "清空") : null),
    h("div", { class: "b-msgs", id: "homeMsgs" },
      hasOlder ? h("button", { class: "load-older", onclick: () => { butlerShown += 20; butlerRestore = { h: prevH, top: prevTop }; renderHome(); } },
        `加载更早的对话（还有 ${total - shown} 条）`) : null,
      welcome, msgs,
      // 管家在处理（本页发的，或别处发起、服务端还在跑）：显示它此刻在做什么
      butlerBusy || S.butlerProgress ? h("div", { class: "ai-row" }, h("span", { class: "ai-mark" }, "✦"), h("div", { class: "ai-col" },
        S.butlerProgress?.steps?.length ? h("div", { class: "muted", style: "font-size:12.5px;display:flex;flex-direction:column;gap:3px;margin-bottom:6px" },
          S.butlerProgress.steps.map((s) => h("div", {}, s))) : null,
        h("div", { class: "bubble ai typing" }, S.butlerProgress ? `正在处理 · ${Math.max(1, Math.round((Date.now() - Date.parse(S.butlerProgress.since)) / 1000))} 秒` : "正在思考"))) : null),
    (() => {
      const pend = pendingActions();
      if (pend.length < 2) return null;
      return h("div", { class: "bulk-bar" },
        h("span", {}, `有 ${pend.length} 项等你确认`),
        h("span", { style: "margin-left:auto" }),
        h("button", { onclick: () => { pend.forEach((c) => (c.dismissed = true)); saveButler(); renderHome(); } }, "全部取消"),
        h("button", { class: "primary", onclick: runAllActions }, `全部执行（${pend.length}）`));
    })(),
    (() => {
      // 输入区是常驻节点：只替换附件条，输入框与按钮原地不动（不会丢焦点、不会打断输入法）
      homeInputWrap ??= h("div", { class: "b-input" });
      patchChildren(homeInputWrap, [
        fileInput,
        attachChips(homeAtt.pending, (n) => { homeAtt.pending.splice(n, 1); renderHome(); }),
        homeInputEl(),
        homeAttachBtn ??= h("button", { title: "添加图片或文件（也可以直接粘贴、拖进来）", onclick: () => $("#homeFile")?.click(), style: "padding:0 12px" }, "📎"),
        homeSendBtn ??= h("button", { class: "primary", onclick: () => sendButler($("#homeInput").value) }, "发送"),
      ]);
      return homeInputWrap;
    })());

  const box = $("#homeMsgs");
  if (butlerRestore) {
    // 往前加载：新内容的增量高度要补回去，视口停在原来那句话上
    box.scrollTop = box.scrollHeight - butlerRestore.h + butlerRestore.top;
    butlerRestore = null;
  } else if (nearBottom || grew || !prevBox) box.scrollTop = box.scrollHeight;
  else box.scrollTop = prevTop;
  butlerSeen = total;
  // 滚到顶自动往前加载一段
  box.addEventListener("scroll", () => {
    if (!hasOlder || box.scrollTop > 24) return;
    butlerShown += 20;
    butlerRestore = { h: box.scrollHeight, top: box.scrollTop };
    renderHome();
  });

  fill($("#homeSide"),
    h("div", { class: "center-block" }, h("div", { class: "bh" }, "项目", h("span", { class: "muted" }, `${projects.length} 个`),
        h("a", { class: "link", style: "margin-left:auto;font-weight:400;font-size:12.5px", onclick: openNewProject }, "+ 新建")),
      h("div", { class: "panel-box" }, projects.map((p) => {
        const its = all.filter((i) => i.projectId === p.id);
        const run = its.filter((i) => i.status === "in_progress");
        const prs = its.filter((i) => i.pr?.state === "open").length;
        const m = MODE[p.lead?.mode ?? "off"];
        return h("div", { class: "proj-row", onclick: () => { setProject(p.id); showView("issues"); } },
          pbadge(p),
          h("div", { class: "meta" },
            h("div", { class: "t" }, p.name, p.repo ? h("span", { class: "gh" }, ghIcon(), p.repo.fullName) : h("span", { class: "muted", style: "font-size:12px" }, "未绑定仓库")),
            h("div", { class: "s" }, `进行中 ${run.length} · 待验收 ${p.counts.review}${prs ? ` · 待合并 PR ${prs}` : ""} · 未完成 ${p.counts.open}`),
            run.length ? h("div", { class: "phase-dots" }, PHASES.map((ph) => { const n = run.filter((i) => i.phase === ph.id).length; return n ? h("span", { class: "tag" }, `${ph.label} ${n}`) : null; })) : null),
          h("span", { class: "badge " + m[1], title: "项目负责人" }, `负责人 · ${m[0]}`));
      }))),
    h("div", { class: "center-block" }, h("div", { class: "bh" }, "需要你处理", h("span", { class: "muted" }, `${att.length} 件 · 只有需求确认和最终验收需要你`)),
      h("div", { class: "panel-box" }, att.length ? att.slice(0, 8).map((a) => h("div", { class: "feed-row" + (a.kind === "failed" ? " fail" : ""), onclick: () => { location.hash = "#issue=" + a.issue.key; } },
        h("span", { class: "ikey" }, a.issue.key), h("span", { class: "b" }, `${a.issue.title} · ${a.text}`),
        h("button", { onclick: (e) => { e.stopPropagation(); location.hash = "#issue=" + a.issue.key; } }, a.kind === "confirm" ? "去确认" : a.kind === "review" ? "去验收" : "查看")))
        : h("div", { class: "empty", style: "padding:20px" }, "没有待处理的事项"))),
    h("div", { class: "center-block" }, h("div", { class: "bh" }, "项目负责人动态"),
      h("div", { class: "panel-box" }, leadFeed.length ? leadFeed.map((a) => h("div", { class: "feed-row", onclick: () => { setProject(a.p.id); showView("project"); } },
        h("span", { class: "ikey" }, a.p.key), h("span", { class: "b", title: a.text }, a.text), h("span", { class: "time" }, ago(a.at))))
        : h("div", { class: "empty", style: "padding:20px" }, "负责人还没有动作"))));
}

// ======================= 项目设置：项目负责人 =======================
function leadSection(p) {
  const L = p.lead;
  const set = (patch) => issuesApi.setLead(p.id, patch).then(() => { renderProjectPage(); });
  const modes = [["off", "关闭", "不主动处理，只在你分配工作项时执行"], ["on_demand", "按需", "处理流转、审核、bug 修复和测试分发，不主动提新工作"], ["autopilot", "持续迭代", "在按需基础上，主动巡检项目、提出改进并推进"]];
  const lim = h("input", { type: "number", min: 1, max: 500, style: "max-width:120px", onchange: (e) => set({ dailyRuns: Number(e.target.value) || 20 }) });
  lim.value = L.dailyRuns;
  const log = issuesApi.leadActivity(p.id);
  return section("项目负责人", "以项目为单位负责迭代：issue 状态流转与审核、bug 修复、测试分发，以及（持续迭代模式下）主动推进项目。",
    field("由谁担任", select(agentNames().map((n) => [n, n]), L.agent, (v) => set({ agent: v }), { style: "max-width:320px" }), "建议使用 project-lead，可在「智能体与工具」里调整它的提示词与技能"),
    field("工作模式", h("div", { class: "radio-row" }, modes.map(([v, t, d]) => h("div", { class: "radio-card" + (L.mode === v ? " sel" : ""), onclick: () => set({ mode: v }) }, h("b", {}, t), h("span", {}, d))))),
    L.mode !== "off" ? [
      field("职责", h("div", { class: "checks" },
        checkboxP(L.duties.flow, (on) => set({ duties: { flow: on } }), "状态流转", "跟进卡住的工作项，推动进入下一阶段"),
        checkboxP(L.duties.review, (on) => set({ duties: { review: on } }), "审核交付", "智能体交付后先由负责人审核，再交给你验收"),
        checkboxP(L.duties.bugs, (on) => set({ duties: { bugs: on } }), "bug 修复", "带 bug 标签且未指派的工作项，自动指派给 developer 修复"),
        checkboxP(L.duties.testing, (on) => set({ duties: { testing: on } }), "测试分发", "有代码改动时分发给 tester 验证，结果写到 PR 上"))),
      field("合并方式", h("span", { class: "muted", style: "font-size:13px" }, `${L.mergePolicy === "manual" ? "手动：验收通过后由你确认合并" : "自动：测试与评审通过后直接合并"}（在上面「交付策略」里修改）`)),
      field("每日运行上限", h("div", { class: "row" }, lim, h("span", { class: "muted", style: "font-size:12.5px" }, `今天已用 ${L.runsToday} 次`)), "负责人发起的运行（修 bug、改进项）超过上限后暂停，次日恢复"),
    ] : null,
    field("最近动作", log.length ? h("div", {}, log.slice(0, 8).map((l) => h("div", { class: "log-row" }, h("span", { class: "time", style: "margin-left:0;min-width:80px" }, ago(l.at)), h("span", {}, l.text))))
      : h("span", { class: "muted", style: "font-size:13px" }, "暂无")));
}

// ======================= 详情：代码变更 =======================
function prSection(d) {
  if (!d.pr) return null;
  const pr = d.pr;
  const state = pr.state === "reverted" ? h("span", { class: "badge s-cancelled" }, `已回滚（#${pr.revert}）`) : pr.state === "merged" ? h("span", { class: "badge s-completed" }, "已合并") : pr.state === "closed" ? h("span", { class: "badge s-cancelled" }, "已关闭") : h("span", { class: "badge s-running" }, "待合并");
  const checks = pr.checks === "passing" ? h("span", { class: "ok-text", style: "font-size:12.5px" }, `✓ 检查通过${pr.tests ? `（测试 ${pr.tests}）` : ""}`) : pr.checks === "failing" ? h("span", { class: "err-text", style: "font-size:12.5px" }, "✕ 检查未通过") : h("span", { class: "muted", style: "font-size:12.5px" }, "检查进行中…");
  // GitHub 上真实的 CI（PR 最新提交）：和 Hub 自己的验收分开显示
  const ci = !pr.ci || pr.ci.state === "none" ? null
    : pr.ci.state === "passing" ? h("span", { class: "ok-text", style: "font-size:12.5px", title: `提交 ${pr.ci.sha.slice(0, 7)}` }, "✓ CI 通过")
    : pr.ci.state === "failing" ? h("span", { class: "err-text", style: "font-size:12.5px", title: `提交 ${pr.ci.sha.slice(0, 7)}` }, `✕ CI 未通过：${pr.ci.failed.join("、")}`)
    : pr.ci.state === "unknown" ? h("span", { class: "warn", style: "font-size:12.5px", title: pr.ci.error }, "⚠ 无法读取 CI")
    : h("span", { class: "muted", style: "font-size:12.5px" }, `CI 进行中：${pr.ci.pending.join("、")}`);
  return [h("div", { class: "section-title" }, "代码变更"),
    h("div", { class: "callout" }, ghIcon(), h("b", {}, prName(pr)), state, h("code", { class: "muted" }, pr.branch),
      h("span", { class: "muted", style: "font-size:12.5px" }, h("span", { class: "ok-text" }, `+${pr.additions}`), " ", h("span", { class: "err-text" }, `−${pr.deletions}`), ` · ${pr.files} 个文件`),
      checks, ci, h("span", { style: "margin-left:auto" }),
      pr.url ? h("a", { class: "link", style: "font-size:12.5px", href: pr.url, target: "_blank", rel: "noopener" }, "在 GitHub 查看") : null,
      pr.state === "open" ? h("button", { class: "primary", disabled: pr.checks === "passing" ? null : "", onclick: () => issuesApi.mergePR(d.key).then(() => toast(`已合并 PR #${pr.number}，${d.key} 完成`, "ok")).catch(fail) }, "合并 PR") : null)];
}

// ======================= 测试（浏览器验收） =======================
/** 需求质量评估（服务端返回的 quality 优先；新建草稿等没有 quality 时在本地计算，规则与服务端一致） */
function assessRequirement(i) {
  if (i.quality) return i.quality;
  const d = `${i.title}\n${i.description ?? ""}`;
  const lines = (i.description ?? "").split("\n").map((l) => l.trim());
  const bullets = lines.filter((l) => /^[-*·]|^\d+[.、]/.test(l)).map((l) => l.replace(/^[-*·]\s*|^\d+[.、]\s*/, ""));
  const hasCriteria = /验收|标准|应当|必须|需要满足/.test(d) && bullets.length >= 2;
  const dims = [
    { name: "目标清晰", ok: i.title.length >= 4, tip: "一句话说明要达成什么" },
    { name: "验收标准", ok: hasCriteria, tip: "列出可逐条验证的标准" },
    { name: "边界与异常", ok: /异常|失败|错误|超时|边界|为空|最多|最少|兼容/.test(d), tip: "失败、为空、超时等情况怎么处理" },
    { name: "范围", ok: /范围|不包括|仅|只|页面|模块|接口/.test(d), tip: "改哪些地方、不改哪些地方" },
    { name: "可测性", ok: /\d/.test(i.description ?? "") || hasCriteria, tip: "有具体数值或可观察的结果" },
  ];
  const w = [15, 35, 20, 15, 15];
  const score = Math.round(dims.reduce((s, x, n) => s + (x.ok ? w[n] : 0), 0) + Math.min(10, (i.description ?? "").length / 20));
  const criteria = hasCriteria ? bullets.slice(0, 6) : [
    `${i.title.replace(/[：:].*$/, "")}的主流程可以正常完成`,
    "异常输入或失败时有明确提示",
    "页面无控制台报错，关键接口无 5xx",
  ];
  const questions = dims.filter((x) => !x.ok).map((x) => ({ 目标清晰: "这项工作最终要达成什么效果？", 验收标准: "做到什么程度算完成？请列出 2–5 条可验证的标准", 边界与异常: "失败、为空、超时等情况应该怎么处理？", 范围: "涉及哪些页面或模块？有没有明确不做的部分？", 可测性: "有没有具体数值，比如性能、数量、兼容的设备？" }[x.name]));
  return { score: Math.min(100, score), dims, criteria, aiCriteria: !hasCriteria, questions };
}

const qa = {
  onChange: (fn) => dataListeners.add(fn),
  get: () => ({ ...S.qa, envs: Object.fromEntries(S.projects.map((p) => [p.id, p.env])) }),
  settings: () => S.qa.settings,
  runs: (pid) => S.qa.runs.filter((r) => !pid || r.projectId === pid),
  run: (id) => S.qa.runs.find((r) => r.id === id),
  runsFor: (key) => S.qa.runs.filter((r) => r.issueKey === key).slice().reverse(),
  enqueue: (issue) => act("qa.enqueue", issue.key),
  rerun: (id) => act("qa.rerun", id),
  cancel: (id) => act("qa.cancel", id),
  setSettings: (p) => { Object.assign(S.qa.settings, p); return act("qa.setSettings", p).catch(fail); },
  setEnv: (pid, p) => act("qa.setEnv", pid, p).catch(fail),
};

// ---------- 模拟截图（SVG 线框图，标出定位到的元素） ----------
function shotSvg(run, c, s, n) {
  const fail = s.status === "failed";
  const page = run.env?.startsWith("http") ? run.env.replace(/^https?:\/\//, "") : "localhost";
  const y = 150 + (n % 3) * 46;
  const color = fail ? "#dc2626" : "#16a34a";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 480 300"><rect width="480" height="300" fill="#f8fafc"/><rect width="480" height="28" fill="#e2e8f0"/><circle cx="14" cy="14" r="4" fill="#f87171"/><circle cx="28" cy="14" r="4" fill="#fbbf24"/><circle cx="42" cy="14" r="4" fill="#4ade80"/><rect x="60" y="7" width="360" height="14" rx="7" fill="#fff"/><text x="70" y="18" font-size="9" fill="#64748b" font-family="sans-serif">${page}</text><rect x="0" y="28" width="480" height="34" fill="#1e293b"/><rect x="16" y="40" width="60" height="10" rx="2" fill="#94a3b8"/><rect x="300" y="40" width="40" height="10" rx="2" fill="#64748b"/><rect x="350" y="40" width="40" height="10" rx="2" fill="#64748b"/><rect x="400" y="38" width="60" height="14" rx="3" fill="#6366f1"/><text x="24" y="92" font-size="15" font-weight="bold" fill="#0f172a" font-family="sans-serif">${run.title.slice(0, 22).replace(/[<&]/g, "")}</text><rect x="24" y="104" width="300" height="8" rx="2" fill="#cbd5e1"/><rect x="24" y="118" width="250" height="8" rx="2" fill="#cbd5e1"/><rect x="24" y="150" width="200" height="30" rx="4" fill="#fff" stroke="#cbd5e1"/><rect x="24" y="196" width="200" height="30" rx="4" fill="#fff" stroke="#cbd5e1"/><rect x="24" y="242" width="96" height="30" rx="4" fill="#6366f1"/><text x="48" y="261" font-size="11" fill="#fff" font-family="sans-serif">提交</text><rect x="260" y="150" width="196" height="122" rx="6" fill="#e2e8f0"/>${fail ? `<rect x="260" y="230" width="196" height="26" rx="4" fill="#fee2e2" stroke="#dc2626"/><text x="270" y="247" font-size="10" fill="#b91c1c" font-family="sans-serif">网络错误，请重试</text>` : ""}<rect x="${n % 2 ? 22 : 22}" y="${n % 3 === 2 ? 240 : y - 2}" width="${n % 3 === 2 ? 100 : 204}" height="34" rx="5" fill="none" stroke="${color}" stroke-width="2.5"/><rect x="${n % 3 === 2 ? 22 : 22}" y="${(n % 3 === 2 ? 240 : y - 2) - 16}" width="62" height="14" rx="3" fill="${color}"/><text x="${n % 3 === 2 ? 27 : 27}" y="${(n % 3 === 2 ? 240 : y - 2) - 5}" font-size="9" fill="#fff" font-family="monospace">${(s.found ?? `e${12 + n}`).split(" ")[0]} ${fail ? "✕" : "✓"}</text></svg>`;
  return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
}

// ======================= 测试板块 UI =======================
const tq = { tab: "queue", project: "", showDone: false };
const RUN_STATUS = { queued: ["排队中", "s-pending"], running: ["执行中", "s-running"], passed: ["通过", "s-completed"], failed: ["未通过", "s-failed"], cancelled: ["已取消", "s-cancelled"] };
const runBadge2 = (s) => h("span", { class: "badge " + RUN_STATUS[s][1] }, RUN_STATUS[s][0]);
const caseCount = (r) => `${r.cases.filter((c) => c.status === "passed").length}/${r.cases.length}`;
const runDur = (a, b) => { if (!a) return "—"; const s = Math.round(((b ? new Date(b) : new Date()) - new Date(a)) / 1000); return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${s % 60}s`; };

async function renderTesting() {
  if (!viewActive("testing")) return;
  if (holdWhileEditing("#testingPage", renderTesting)) return;
  const S = qa.settings();
  const runs = qa.runs(tq.project || undefined);
  const queued = runs.filter((r) => r.status === "queued").sort((a, b) => prioOrder(a.priority) - prioOrder(b.priority) || Number(b.hotfix) - Number(a.hotfix) || a.queuedAt.localeCompare(b.queuedAt));
  const running = runs.filter((r) => r.status === "running");
  const done = runs.filter((r) => !["queued", "running"].includes(r.status)).sort((a, b) => (b.endedAt ?? "").localeCompare(a.endedAt ?? ""));
  const recent = done.slice(0, 30);
  const rate = recent.length ? Math.round((recent.filter((r) => r.status === "passed").length / recent.length) * 100) : 0;
  const all = await issuesApi.list(tq.project || undefined);
  const active = all.filter((i) => ["in_progress", "in_review", "todo"].includes(i.status));
  const qs = active.map((i) => [i, assessRequirement(i)]);
  const covered = qs.reduce((n, [i, q]) => n + q.criteria.filter((_, k) => qa.runsFor(i.key).some((r) => r.cases.some((c) => c.criterion === k && c.status === "passed"))).length, 0);
  const totalCrit = qs.reduce((n, [, q]) => n + q.criteria.length, 0);
  const tile = (cls, k, v, d) => h("div", { class: "tile " + cls }, h("div", { class: "k" }, k), h("div", { class: "v" }, v), d ? h("div", { class: "d" }, d) : null);
  const tabs = [["queue", "执行队列"], ["coverage", "覆盖"], ["quality", "需求质量"], ["env", "环境与浏览器"]];

  fill($("#testingPage"),
    h("div", { class: "center-head" }, h("h2", {}, "测试"),
      h("div", { class: "seg" }, tabs.map(([v, l]) => h("button", { class: tq.tab === v ? "on" : "", onclick: () => { tq.tab = v; renderTesting(); } }, l))),
      demoFlag()),
    h("div", { class: "tiles" },
      tile("running", "排队 / 执行中", `${queued.length} / ${running.length}`, `调度：${S.schedule === "auto" ? "无冲突时并行" : "串行"} · ${S.browser === "local" ? "远程 Chrome" : `浏览器池 ${S.maxParallel} 个`}`),
      tile(rate >= 80 ? "" : "bad", "近期通过率", `${rate}%`, `最近 ${recent.length} 次验收`),
      tile(totalCrit && covered / totalCrit < 0.7 ? "bad" : "", "验收标准覆盖", totalCrit ? `${Math.round((covered / totalCrit) * 100)}%` : "—", `${covered}/${totalCrit} 条标准已有通过的用例`),
      tile(qs.some(([, q]) => q.score < 60) ? "bad" : "", "需求待完善", qs.filter(([, q]) => q.score < 60).length, "评分低于 60 的进行中 / 待办工作项")),
    tq.tab === "queue" ? queueView(queued, running, done, S)
      : tq.tab === "coverage" ? coverageView(qs)
      : tq.tab === "quality" ? qualityView(qs)
      : envView(S));
}

const ISSUE_STAGE = { in_review: ["已进入评审", "s-review"], done: ["已交付", "s-completed"], canceled: ["已取消", "s-cancelled"], in_progress: ["执行中", "s-running"], todo: ["回到待办", "s-pending"], backlog: ["待规划", "s-pending"] };
function runCard(r) {
  const issue = (S.issues ?? []).find((i) => i.key === r.issueKey);
  const stage = issue ? ISSUE_STAGE[issue.status] : null;
  // 验收完成后标出工作项去了哪个阶段，避免看起来还卡在测试
  const stageTag = r.status === "passed" && stage ? h("span", { class: "badge " + stage[1], title: `工作项当前：${stage[0]}` }, stage[0]) : null;
  const cur = r.cursor && r.cases[r.cursor.c];
  const curStep = cur?.steps[r.cursor.s];
  const last = r.status === "running" ? [...r.cases].reverse().flatMap((c) => [...c.steps].reverse().map((s) => [c, s])).find(([, s]) => s.status) : null;
  return h("div", { class: "icard qcard" + (r.status === "running" ? " running" : ""), onclick: () => openRun(r.id) },
    h("div", { class: "icard-top" }, pbadge({ key: issuesApi.project(r.projectId)?.key }), h("span", { class: "ikey" }, r.issueKey),
      r.priority >= 1 ? prio(r.priority) : null, r.hotfix ? h("span", { class: "label hot" }, "⚡ HOTFIX") : null, stageTag, h("span", { style: "margin-left:auto" }, runBadge2(r.status))),
    h("div", { class: "ititle" }, r.title),
    h("div", { class: "imeta" },
      h("span", { class: "tag" }, `${r.cases.length} 个用例`),
      r.env && r.env !== "CI" ? h("span", { class: "tag", title: r.env }, r.pr ? `预览 PR #${r.pr}` : "staging") : h("span", { class: "tag" }, "CI"),
      r.account ? h("span", { class: "tag" }, r.account) : null,
      r.mutates.length ? h("span", { class: "tag", title: "会修改的数据" }, `写：${r.mutates.join(",")}`) : null),
    r.status === "queued" && r.wait ? h("div", { class: "qwait" }, "⏳ ", r.wait) : null,
    r.status === "running" ? h("div", { class: "qlive" },
      last && r.simulated ? h("img", { class: "qthumb", src: shotSvg(r, last[0], last[1], r.cases.indexOf(last[0])), alt: "" }) : null,
      h("div", { style: "min-width:0;flex:1" },
        h("div", { class: "muted", style: "font-size:11.5px" }, `用例 ${r.cursor.c + 1}/${r.cases.length} · ${r.browser === "local" ? "远程 Chrome" : r.browser ? "浏览器 " + r.browser : "CI"}`),
        h("div", { style: "font-size:12.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" }, curStep?.desc ?? ""),
        h("code", { class: "muted", style: "font-size:11px;display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" }, curStep?.cmd.replace("{url}", r.env).replace(/\{uid\}/, 12 + r.cursor.c * 3) ?? ""))) : null,
    ["passed", "failed"].includes(r.status) ? h("div", { class: "imeta" }, h("span", { class: r.status === "passed" ? "ok-text" : "err-text", style: "font-size:12px" }, `用例 ${caseCount(r)} 通过`), h("span", { class: "muted", style: "font-size:11.5px;margin-left:auto" }, `${runDur(r.startedAt, r.endedAt)} · ${ago(r.endedAt)}`)) : null);
}

function queueView(queued, running, done, S) {
  // 已完成的验收是历史记录：默认收起，避免看起来像任务仍停在测试阶段
  const doneCol = !tq.showDone
    ? h("div", { class: "bcol tq-done-collapsed" },
        h("div", { class: "bcol-head" }, h("span", { class: "qdot q-review" }), "已完成（历史）", h("span", { class: "count" }, done.length),
          h("button", { class: "icon-btn", style: "margin-left:auto;font-size:12px", onclick: () => { tq.showDone = true; renderTesting(); } }, "显示")),
        h("div", { class: "bcol-body" }, h("div", { class: "bcol-empty" }, "验收通过后工作项会自动进入「评审」，这里只保留历史记录")))
    : h("div", { class: "bcol" }, h("div", { class: "bcol-head" }, h("span", { class: "qdot q-review" }), "已完成（历史）", h("span", { class: "count" }, done.length),
        h("button", { class: "icon-btn", style: "margin-left:auto;font-size:12px", onclick: () => { tq.showDone = false; renderTesting(); } }, "隐藏")),
        h("div", { class: "bcol-body" }, done.length ? done.slice(0, 20).map(runCard) : h("div", { class: "bcol-empty" }, "暂无")));
  const lanes = S.browser === "local" ? ["local"] : Array.from({ length: S.maxParallel }, (_, n) => `b-${n + 1}`);
  const ci = running.filter((r) => !r.browser);
  return h("div", { class: "tq" },
    h("div", { class: "bcol" }, h("div", { class: "bcol-head" }, h("span", { class: "qdot q-understand" }), "排队中", h("span", { class: "count" }, queued.length)),
      h("div", { class: "bcol-body" }, queued.length ? queued.map(runCard) : h("div", { class: "bcol-empty" }, "没有排队的验收"))),
    h("div", { class: "bcol tq-running" }, h("div", { class: "bcol-head" }, h("span", { class: "qdot q-do" }), "执行中", h("span", { class: "count" }, running.length),
        h("span", { class: "muted", style: "font-weight:400;font-size:12px;margin-left:auto" }, S.schedule === "auto" ? "互不冲突的验收并行执行" : "串行执行")),
      h("div", { class: "bcol-body" },
        lanes.map((b) => {
          const r = running.find((x) => x.browser === b);
          return h("div", { class: "lane" }, h("div", { class: "lane-head" }, h("span", { class: "busy-dot" + (r ? " on" : "") }), b === "local" ? "远程 Chrome（你的浏览器经 DevEye 扩展连接）" : `浏览器 ${b}${S.headless ? " · 无界面" : ""}`),
            r ? runCard(r) : h("div", { class: "bcol-empty" }, "空闲"));
        }),
        ci.length ? h("div", { class: "lane" }, h("div", { class: "lane-head" }, h("span", { class: "busy-dot on" }), "CI（自动化测试，不占浏览器）"), ci.map(runCard)) : null)),
    doneCol);
}

function coverageView(qs) {
  if (!qs.length) return h("div", { class: "panel-box" }, h("div", { class: "empty" }, "没有进行中或待验收的工作项"));
  return h("div", { class: "cov-list" }, qs.map(([i, q]) => {
    const runs = qa.runsFor(i.key);
    const last = runs[0];
    const rows = q.criteria.map((c, k) => {
      const hit = runs.flatMap((r) => r.cases.filter((x) => x.criterion === k).map((x) => ({ r, x })));
      const ok = hit.find(({ x }) => x.status === "passed");
      const bad = !ok && hit.find(({ x }) => x.status === "failed");
      return h("tr", {}, h("td", {}, c), h("td", {}, hit.length ? `${hit.length} 次` : "—"),
        h("td", {}, ok ? h("span", { class: "ok-text" }, "✓ 已覆盖") : bad ? h("span", { class: "err-text" }, "✕ 未通过") : h("span", { class: "muted" }, "未覆盖")));
    });
    const n = q.criteria.filter((_, k) => runs.some((r) => r.cases.some((x) => x.criterion === k && x.status === "passed"))).length;
    return h("div", { class: "panel-box cov" },
      h("div", { class: "cov-head", onclick: () => { location.hash = "#issue=" + i.key; } }, h("span", { class: "ikey" }, i.key), h("b", {}, i.title), sicon(i.status),
        h("span", { class: "covbar", title: `${n}/${q.criteria.length}` }, h("i", { style: `width:${(n / q.criteria.length) * 100}%` })), h("span", { class: "muted", style: "font-size:12px" }, `${n}/${q.criteria.length}`),
        last ? h("span", { style: "margin-left:auto" }, runBadge2(last.status)) : h("span", { class: "muted", style: "margin-left:auto;font-size:12px" }, "尚未测试")),
      q.aiCriteria ? h("div", { class: "cov-note" }, "需求里没有明确的验收标准，以下由 AI 推断，建议在需求确认时补充") : null,
      h("table", { class: "map-table", style: "width:100%" }, h("tr", {}, h("th", {}, "验收标准"), h("th", { style: "width:80px" }, "被测次数"), h("th", { style: "width:100px" }, "状态")), rows,
        h("tr", {}, h("td", { class: "muted" }, "附加：页面健康检查（控制台 / 网络 / 无障碍）"), h("td", {}, "—"), h("td", { class: "muted" }, i.projectId === "p_web" ? "每次自动执行" : "不适用"))));
  }));
}

function qualityView(qs) {
  const rows = qs.slice().sort((a, b) => a[1].score - b[1].score);
  return h("div", {},
    h("div", { class: "muted", style: "font-size:12.5px;margin-bottom:8px" }, "需求不够具体时，智能体会在「需求理解」阶段暂停并向你提问；评分 ≥ 60 才会继续计划与执行。"),
    h("div", { class: "panel-box" }, h("table", { class: "lc-table", style: "border:none" },
      h("thead", {}, h("tr", {}, h("th", {}, "工作项"), h("th", {}, "评分"), ["目标清晰", "验收标准", "边界与异常", "范围", "可测性"].map((d) => h("th", {}, d)), h("th", {}, "状态"))),
      h("tbody", {}, rows.map(([i, q]) => h("tr", { onclick: () => { location.hash = "#issue=" + i.key; } },
        h("td", {}, h("div", { class: "lc-title" }, h("span", { class: "ikey" }, i.key), i.title)),
        h("td", {}, h("span", { class: "score " + (q.score >= 80 ? "hi" : q.score >= 60 ? "mid" : "lo") }, q.score)),
        q.dims.map((d) => h("td", {}, d.ok ? h("span", { class: "ok-text" }, "✓") : h("span", { class: "err-text", title: d.tip }, "✕"))),
        h("td", { style: "font-size:12.5px" }, i.blocked ? h("span", { class: "warn" }, "等待你确认") : i.reqConfirmed ? h("span", { class: "ok-text" }, "已确认") : q.score >= 60 ? h("span", { class: "muted" }, "可执行") : h("span", { class: "muted" }, "执行时会提问"))))))));
}

function envView(S) {
  const set = (p) => { qa.setSettings(p); renderTesting(); };
  const db = qa.get();
  return h("div", { class: "center-grid" },
    h("div", { class: "center-block" }, h("div", { class: "bh" }, "浏览器"),
      h("div", { class: "panel-box", style: "padding:14px" }, h("div", { class: "fields" },
        h("div", { class: "radio-row" },
          h("div", { class: "radio-card" + (S.browser === "pool" ? " sel" : ""), onclick: () => set({ browser: "pool" }) }, h("b", {}, "服务器上的浏览器"), h("span", {}, "Hub 在服务器上用本机 Chrome 为每次验收开一个独立的浏览器会话（cookie、存储互不干扰），可并行验收")),
          h("div", { class: "radio-card" + (S.browser === "local" ? " sel" : ""), onclick: () => set({ browser: "local" }) }, h("b", {}, "远程 Chrome"), h("span", {}, "你电脑上的 Chrome 安装 DevEye 扩展后连接到服务器，在你眼前执行，一次一个"))),
        S.browser === "pool" ? [
          field("并行浏览器数", (() => { const el = h("input", { type: "number", min: 1, max: 8, style: "max-width:100px", onchange: (e) => set({ maxParallel: Math.max(1, Math.min(8, Number(e.target.value) || 1)) }) }); el.value = S.maxParallel; return el; })(), "同时最多运行的验收数量"),
          checkboxP(S.headless, (on) => set({ headless: on }), "无界面模式（headless）", "关闭后会弹出可见的浏览器窗口"),
          field("浏览器驱动", select([["builtin", "内置（推荐）：Hub 自带，直接驱动本机 Chrome"], ["deveye", "DevEye：需单独安装 DevEye"]], S.engine ?? "builtin", (v) => set({ engine: v }), { style: "max-width:360px" }),
            (S.engine ?? "builtin") === "deveye" ? (db.engine === "deveye" ? "✓ 已就绪：Hub 会托管 DevEye 服务端，为每次验收创建无头浏览器" : "DevEye 不可用，暂时改用内置驱动。需要本机能运行 deveye 命令，并填写下面的扩展目录")
              : db.browserReady ? "✓ 已就绪：找到了本机 Chrome" : "没有找到 Chrome：请安装 Google Chrome，或在下面填写 Chrome / Chromium 的路径"),
          (S.engine ?? "builtin") === "deveye"
            ? field("DevEye 扩展目录", (() => { const el = h("input", { placeholder: "/path/to/DevEye/packages/chrome-extension/dist", onchange: (e) => set({ deveyeExtension: e.target.value.trim() }) }); el.value = S.deveyeExtension ?? ""; return el; })(), "DevEye Chrome 扩展构建产物（dist）的目录")
            : field("Chrome 路径", (() => { const el = h("input", { placeholder: "留空自动查找，如 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome", onchange: (e) => set({ chromePath: e.target.value.trim() }) }); el.value = S.chromePath ?? ""; return el; })(), "Chrome、Chromium、Edge 均可"),
        ] : h("div", { class: "callout" }, h("span", { class: "busy-dot on" }), db.deveyeInstalled ? "服务器上已安装 DevEye" : "服务器上未检测到 DevEye（deveye 命令）", h("span", { class: "muted", style: "font-size:12.5px" }, "在 DevEye 扩展里填写服务器地址（ws://<服务器>:9888）和令牌")),
        field("调度方式", select([["auto", "自动：互不冲突的验收并行执行"], ["serial", "串行：一次只执行一个"]], S.schedule, (v) => set({ schedule: v }), { style: "max-width:360px" }), "冲突判断：同一环境下测试账号相同，或会修改同一类数据（订单、登录会话、内容）"),
        S.browser === "pool" ? field("实例", db.browsers.length ? h("div", { class: "chips" }, db.browsers.map((b) => h("span", { class: "tag" }, `${b.id} · ${b.status === "busy" ? "执行中" : "空闲"}`))) : h("span", { class: "muted", style: "font-size:12.5px" }, "按需创建，空闲超时后自动回收")) : null))),
    h("div", { class: "center-block" }, h("div", { class: "bh" }, "测试环境", h("span", { class: "muted" }, "按项目配置")),
      h("div", { class: "panel-box" }, issuesApi.projects().map((p) => {
        const e = db.envs[p.id] ?? { baseUrl: "", preview: "", accounts: [] };
        const inp = (k, ph) => { const el = h("input", { placeholder: ph, onchange: (ev) => qa.setEnv(p.id, { [k]: ev.target.value }) }); el.value = e[k] ?? ""; return el; };
        const acc = h("input", { placeholder: "qa-user-1, qa-user-2", onchange: (ev) => qa.setEnv(p.id, { accounts: ev.target.value.split(/[,，]/).map((x) => x.trim()).filter(Boolean) }) });
        acc.value = (e.accounts ?? []).join(", ");
        return h("div", { class: "proj-row", style: "cursor:default" }, pbadge(p), h("div", { class: "meta fields", style: "gap:8px" }, h("b", {}, p.name),
          field("测试地址", inp("baseUrl", "https://staging.example.com")),
          field("PR 预览地址", inp("preview", "https://pr-{pr}.preview.example.com"), "有 PR 时优先在预览环境验收，{pr} 会替换为 PR 编号；不同 PR 互不冲突"),
          field("本地预览命令", inp("previewCmd", "scripts/preview.sh"), "配置后，每次验收前 Hub 在该工作项的 worktree 里执行这条命令，启动本分支的前后端，验收结束自动关闭。命令拿到 PREVIEW_PORT（前端）、PREVIEW_API_PORT（后端）、HUB_ISSUE_SLUG（用于隔离数据库等），需前台运行；就绪以前端地址可访问为准（最多 3 分钟）。优先于上面两个地址"),
          field("测试账号", acc, "会写进验收任务交给测试智能体，请只填测试专用账号")));
      }))));
}

// ---------- 验收详情（抽屉） ----------
let qaOpen = null;
function openRun(id) {
  qaOpen = id;
  runSig = "";
  ui.focusReturn = document.activeElement;
  $("#qaDrawer").classList.add("open");
  $("#qaDrawer").setAttribute("aria-hidden", "false");
  $("#scrim").classList.add("open");
  renderRun();
  $("#qaDrawer").focus({ preventScroll: true });
}
function closeRun() { qaOpen = null; $("#qaDrawer").classList.remove("open"); $("#qaDrawer").setAttribute("aria-hidden", "true"); if (!ui.openKey) $("#scrim").classList.remove("open"); restoreFocus(); }
/** 验收详情里人手动展开 / 收起的用例（按验收 id + 用例 id 记），重绘后保持 */
const runOpen = new Map();
let runSig = "";
function renderRun() {
  const r = qaOpen && qa.run(qaOpen);
  if (!r) return;
  // 内容没变就不重绘：结束的验收不会再变；进行中的只在步骤推进时重绘
  const sig = JSON.stringify([r.id, r.status, r.wait, r.cursor, r.cases.map((c) => [c.status, c.steps.length, c.steps.filter((x) => x.status).length])]);
  if (sig === runSig && $("#qaDrawer").children.length) return;
  runSig = sig;
  const keepScroll = $("#qaDrawer").scrollTop;
  const bad = r.cases.filter((c) => c.status === "failed").length;
  fill($("#qaDrawer"),
    h("div", { class: "dr-head" }, h("a", { onclick: () => { closeRun(); location.hash = "#issue=" + r.issueKey; } }, r.issueKey), h("span", {}, "/ 验收"), runBadge2(r.status),
      h("span", { style: "margin-left:auto" }),
      ["queued", "running"].includes(r.status) ? h("button", { class: "danger", onclick: () => { qa.cancel(r.id); } }, "取消") : h("button", { onclick: () => qa.rerun(r.id).then((nid) => { openRun(nid); toast("已重新加入验收队列"); }).catch(fail) }, "重新运行"),
      h("button", { onclick: closeRun }, "✕")),
    h("h2", { style: "margin:10px 0 6px;font-size:19px" }, r.title),
    kv(["触发", { lifecycle: "生命周期「测试」阶段", manual: "手动重跑", hotfix: "Hotfix", "post-merge": "合并到本地后的页面验收" }[r.trigger] ?? r.trigger,
      "浏览器", r.browser === "local" ? "远程 Chrome（你的浏览器经 DevEye 扩展连接）" : r.browser ? `内置浏览器 ${r.browser}` : r.env === "CI" ? "CI（不占浏览器）" : "待分配",
      "环境", h("code", {}, r.env ?? "—"), "测试账号", r.account ?? "—", "会修改", r.mutates.join("、") || "无",
      "用时", `${runDur(r.startedAt, r.endedAt)}${r.queuedAt && r.startedAt ? `（排队 ${runDur(r.queuedAt, r.startedAt)}）` : ""}`,
      "结果", ["passed", "failed"].includes(r.status) ? `用例 ${caseCount(r)} 通过${bad ? `，${bad} 个未通过` : ""}` : r.wait ?? "执行中…"]),
    r.status === "failed" ? h("div", { class: "callout warn", style: "margin-top:12px" }, "未通过的用例和复现步骤已写回工作项，智能体会回到「执行」阶段修复后重新验收。") : null,
    h("div", { class: "section-title" }, "用例"),
    r.cases.map((c, n) => h("details", { class: "case " + (c.status ?? "pending"),
      open: (runOpen.has(`${r.id}/${c.id}`) ? runOpen.get(`${r.id}/${c.id}`) : c.status === "failed" || (r.cursor && r.cursor.c === n)) || null,
      ontoggle: (e) => runOpen.set(`${r.id}/${c.id}`, e.currentTarget.open) },
      h("summary", {}, h("span", { class: "cst" }, { passed: "✓", failed: "✕", running: "●", skipped: "–" }[c.status] ?? "○"),
        h("span", { class: "ctitle" }, c.title), h("span", { class: "tag" }, { browser: "浏览器验收", unit: "自动化测试", check: "检查清单", health: "健康检查" }[c.kind]),
        c.criterion != null ? h("span", { class: "muted", style: "font-size:11.5px" }, `标准 ${c.criterion + 1}`) : null),
      h("div", { class: "steps-list" }, c.steps.map((s, k) => h("div", { class: "step " + (s.status ?? "pending") },
        h("div", { class: "sl" }, h("span", { class: "cst" }, { passed: "✓", failed: "✕", skipped: "–" }[s.status] ?? (r.cursor && r.cursor.c === n && r.cursor.s === k ? "●" : "○")),
          h("div", { style: "flex:1;min-width:0" }, h("div", {}, s.desc, s.ms ? h("span", { class: "muted", style: "font-size:11.5px" }, ` · ${s.ms}ms`) : null),
            h("code", { class: "scmd" }, "$ ", s.cmd.replace("{url}", r.env ?? "").replace("{uid}", 12 + n * 3).replace("{run}", r.id).replace("{case}", c.id)),
            s.found ? h("div", { class: "muted", style: "font-size:12px" }, `定位到：${s.found}`) : null,
            s.error ? h("div", { class: "err-text", style: "font-size:12.5px;margin-top:2px" }, s.error) : null),
          s.shot ? h("img", { class: "sshot", src: `/qa-shots/${s.shot}`, alt: "验收截图", loading: "lazy", onclick: (e) => zoomShot(e.target.src) })
            : r.simulated && c.kind === "browser" && s.status && s.status !== "skipped" && (s.assert || s.locate) ? h("img", { class: "sshot", src: shotSvg(r, c, s, n), alt: "截图", onclick: (e) => zoomShot(e.target.src) }) : null)))))));
  if (keepScroll) $("#qaDrawer").scrollTop = keepScroll;
}
function zoomShot(src) {
  fill($("#modal"), h("div", { class: "modal", style: "width:min(900px,calc(100vw - 32px))", onclick: (e) => e.stopPropagation() },
    h("div", { class: "dr-head" }, h("span", {}, "截图"), h("span", { style: "margin-left:auto" }), h("button", { onclick: () => closeModal() }, "✕")),
    h("img", { src, style: "width:100%;margin-top:10px;border:1px solid var(--border);border-radius:6px" })));
  $("#modal").classList.add("open"); $("#modal").setAttribute("aria-hidden", "false");
}
qa.onChange(() => {
  if (viewActive("testing")) debounce("testing", renderTesting, 120);
  if (qaOpen) debounce("qarun", renderRun, 80);
});

// ======================= 运行底座 =======================
/** 内置 = Hub 自己的 Claude API 循环；其余为在项目工作目录里以非交互模式运行的 CLI 智能体 */
const RUNTIME_DEFS = [
  { id: "builtin", name: "内置（Claude API）", short: "内置", desc: "Hub 自己的执行循环，工具由 Hub 提供，适合调研、写作、调度类任务", auth: "使用「模型服务」里的连接", verified: true },
  { id: "claude-code", name: "Claude Code", short: "Claude Code", desc: "成熟的编码智能体，读写代码、运行命令、提交 PR", auth: "使用服务器上 claude 的登录状态，或设置 ANTHROPIC_API_KEY", verified: true,
    template: 'claude -p "{prompt}" --output-format stream-json --verbose --model {model} --append-system-prompt "{system}" --mcp-config {mcp_config} --strict-mcp-config --permission-mode bypassPermissions',
    modelHint: "opus / sonnet / haiku，或完整模型 ID，如 claude-opus-5-5" },
  { id: "codex", name: "Codex CLI", short: "Codex", desc: "OpenAI 的编码智能体", auth: "使用服务器上 codex 的登录状态，或设置 OPENAI_API_KEY", verified: false,
    template: 'codex exec --json -m {model} "{prompt}"', modelHint: "填写 Codex 支持的模型名，留空用默认" },
  { id: "gemini", name: "Gemini CLI", short: "Gemini", desc: "Google 的命令行智能体", auth: "使用服务器上 gemini 的登录状态，或设置 GEMINI_API_KEY", verified: true,
    template: 'gemini -p "{prompt}" -o stream-json -m {model} --approval-mode yolo', modelHint: "填写 Gemini 支持的模型名，留空用默认" },
  { id: "pi", name: "pi", short: "pi", desc: "多模型编码助手，可切换不同提供商", auth: "使用 pi auth 登录对应提供商", verified: true,
    template: 'pi -p --mode json --model {model} --append-system-prompt "{system}" "{prompt}"', modelHint: "provider/id，如 anthropic/claude-opus-5-5" },
];
const rtDef = (id) => RUNTIME_DEFS.find((r) => r.id === (id ?? "builtin")) ?? RUNTIME_DEFS[0];
const rtState = { data: null, loading: false, error: null };
const rtModels = { cache: {}, loading: {} };
/** 各 CLI 底座可用模型的缓存（按需检测；服务端缓存 5 分钟） */
async function loadRuntimeModels(id, force = false) {
  if (rtModels.loading[id]) return rtModels.cache[id];
  if (!force && rtModels.cache[id]) return rtModels.cache[id];
  rtModels.loading[id] = true;
  try { rtModels.cache[id] = await api(`/runtimes/${id}/models?${force ? "refresh=1&" : ""}verify=1`); }
  catch (e) { rtModels.cache[id] = { models: [], source: `检测失败：${e.message}` }; }
  rtModels.loading[id] = false;
  return rtModels.cache[id];
}
/** 模型芯片：点一下就把该模型设为这个智能体使用的模型 */
/** 每个底座记住「展开更多」的状态：模型可能几十个，默认只铺一行，其余按需展开 */
const modelChipsOpen = {};
function modelChips(d, id, onPick) {
  const data = rtModels.cache[id];
  if (!data) {
    if (!rtModels.loading[id]) loadRuntimeModels(id).then(() => { if (st.draft?.runtime === id) renderStudio(); });
    return h("div", { class: "muted", style: "font-size:12px;margin-top:6px" }, "正在检测该底座可用的模型…");
  }
  const list = data.models ?? [];
  const verify = data.verify ?? {};
  // 验证失败的排在后面并标红：它们能列出来但实际调不通，混在一起会让人误选
  const bad = (m) => verify[m.id]?.ok === false;
  const sorted = [...list].sort((a, b) => Number(bad(a)) - Number(bad(b)));
  const open = !!modelChipsOpen[id];
  const shown = open ? sorted : sorted.slice(0, 14);
  const rest = sorted.length - shown.length;
  const chip = (m) => h("button", {
    class: "chip" + ((d.cliModel ?? "") === m.id ? " on" : "") + (bad(m) ? " bad" : ""),
    style: "padding:0 8px",
    title: [m.name, m.note, bad(m) ? `不可用：${verify[m.id].note}` : ""].filter(Boolean).join(" · "),
    onclick: () => { d.cliModel = m.id; onPick?.(m.id); touch(); renderStudio(); },
  }, m.name && m.name !== m.id ? m.name : m.id);
  return h("div", {},
    h("div", { class: "row", style: "gap:6px;margin-top:6px;flex-wrap:wrap" },
      h("span", { class: "muted", style: "font-size:12px" }, list.length ? `检测到 ${list.length} 个模型${list.filter(bad).length ? `（${list.filter(bad).length} 个不可用）` : ""}：` : "没有检测到模型"),
      ...shown.map(chip),
      rest > 0 ? h("a", { class: "link", style: "font-size:12px", onclick: () => { modelChipsOpen[id] = true; renderStudio(); } }, `展开其余 ${rest} 个`) : (open && sorted.length > 14 ? h("a", { class: "link", style: "font-size:12px", onclick: () => { modelChipsOpen[id] = false; renderStudio(); } }, "收起") : null),
      h("a", { class: "link", style: "font-size:12px;margin-left:4px", onclick: async (e) => { e.target.textContent = "检测中…"; await loadRuntimeModels(id, true); renderStudio(); } }, "重新检测")),
    h("div", { class: "help", style: "margin-top:4px" }, data.source ?? ""));
}

async function loadRuntimes(force = false) {
  if (rtState.loading) return;
  rtState.loading = true;
  try { rtState.data = await api(`/runtimes${force ? "?refresh=1" : ""}`); rtState.error = null; }
  catch (e) { rtState.error = e.message; }
  rtState.loading = false;
}
const rtInstalled = (id) => id === "builtin" ? true : rtState.data?.runtimes.find((r) => r.id === id)?.installed ?? null;
const rtCfg = (id) => { const S = settings.get(); S.runtimes ??= {}; return (S.runtimes[id] ??= { template: rtDef(id).template ?? "", max: 2 }); };

/** 设置页：运行底座 */
/** 等服务重启完成：以 /health 的启动时间变化为准（旧进程退出前 /health 也是 200），然后刷新页面 */
async function waitRestart(btn) {
  let boot = null;
  try { boot = (await (await fetch("/health", { cache: "no-store" })).json()).boot; } catch { /* 已经在重启 */ }
  const t0 = Date.now();
  // 空闲时重启可能要等很久（运行中的工作项结束），不设超时；立即重启 30 秒没起来就报错
  const limit = btn ? 30_000 : Infinity;
  const timer = setInterval(async () => {
    try {
      const h = await (await fetch("/health", { cache: "no-store" })).json();
      if (h.boot && h.boot !== boot) { clearInterval(timer); toast("服务已重启", "ok"); setTimeout(() => location.reload(), 400); return; }
    } catch { /* 还没起来 */ }
    if (Date.now() - t0 > limit) { clearInterval(timer); toast("重启超时，请检查服务器日志", "err"); if (btn) { btn.disabled = false; btn.textContent = "立即重启"; } }
  }, btn ? 800 : 3000);
}
function runtimesSection(customService) {
  const d = rtState.data;
  // 内置底座能否真正调用：模拟模式，或至少有一条验证过的连接
  const builtinReady = simulateMode() || (settings.get()?.providers ?? []).some((p) => (p.method === "key" || p.method === "profile") && p.verifiedAt);
  const card = (r) => {
    const info = d?.runtimes.find((x) => x.id === r.id);
    const cfg = r.id === "builtin" ? null : rtCfg(r.id);
    const loginTag = info?.installed && info.login ? (info.login.ok
      ? h("span", { class: "ok-text", style: "font-size:12.5px", title: "读的是该 CLI 自己的登录状态" }, `· ${info.login.method}`)
      : h("span", { class: "err-text", style: "font-size:12.5px", title: "在该机器上登录一次即可，Hub 不会保存密钥" }, `· ${info.login.method}`)) : null;
    const status = r.id === "builtin" ? (builtinReady
        ? h("span", { class: "ok-text", style: "font-size:12.5px" }, "✓ 始终可用")
        : h("span", { class: "err-text", style: "font-size:12.5px" }, "需先配置自定义模型服务"))
      : !d ? h("span", { class: "muted", style: "font-size:12.5px" }, rtState.loading ? "检测中…" : rtState.error ? `检测失败：${rtState.error}` : "未检测")
      : info?.installed ? h("span", { style: "font-size:12.5px" }, h("span", { class: "ok-text" }, `✓ 已安装 ${info.version ?? ""}`), loginTag)
        : h("span", { class: "err-text", style: "font-size:12.5px" }, "未安装");
    const tpl = cfg ? h("textarea", { class: "prompt-area", style: "min-height:54px", onchange: (e) => { cfg.template = e.target.value; settings.patch({}); toast("命令模板已保存", "ok"); } }, cfg.template) : null;
    const max = cfg ? (() => { const el = h("input", { type: "number", min: 1, max: 20, style: "width:70px", onchange: (e) => { cfg.max = Math.max(1, Number(e.target.value) || 1); settings.patch({}); } }); el.value = cfg.max; return el; })() : null;
    const used = studio.agents().filter((a) => (a.runtime ?? "builtin") === r.id).map((a) => a.name);
    const C = S.concurrency ?? {};
    const live = r.id === "builtin" ? C.model : C.cli?.[r.id];
    const liveTag = live && (live.running || live.waiting) ? h("span", { class: "tag", title: "当前运行中 / 排队中" }, `运行 ${live.running} · 排队 ${live.waiting}`) : null;
    const modelMax = r.id === "builtin" ? (() => { const el = h("input", { type: "number", min: 1, max: 64, style: "width:70px", "aria-label": "模型并发", onchange: (e) => { settings.get().concurrency = { ...(settings.get().concurrency ?? {}), model: Math.max(1, Number(e.target.value) || 1) }; settings.patch({}).then(() => toast("模型并发已更新，立即生效", "ok")); } }); el.value = settings.get().concurrency?.model ?? 8; return el; })() : null;
    const detected = r.id === "builtin" ? null : rtModels.cache[r.id]?.models?.length;
    return h("details", { class: "case", open: null },
      h("summary", {}, h("span", { class: "ai-mark", style: "width:22px;height:22px;font-size:11px" }, r.short[0]), h("span", { class: "ctitle" }, r.name), status,
        detected ? h("span", { class: "tag", title: "该底座检测到的可用模型数" }, `${detected} 个模型`) : null,
        used.length ? h("span", { class: "muted", style: "font-size:12px", title: used.join("、") }, `· ${used.length} 个智能体`) : null, liveTag),
      h("div", { class: "steps-list fields", style: "gap:8px" },
        h("div", { class: "muted", style: "font-size:12.5px" }, r.desc),
        info?.path ? field("路径", h("code", { class: "muted" }, info.path)) : null,
        r.id === "builtin" ? null : field("本地配置", info?.home?.exists
          ? h("div", { class: "row" }, h("code", { class: "muted", style: "font-size:12px" }, info.home.dir), info.home.model ? h("span", { class: "tag" }, `默认模型 ${info.home.model}`) : null)
          : h("span", { class: "muted", style: "font-size:12.5px" }, "未发现配置目录"),
          info?.home?.exists ? "直接用这台机器上已有的登录状态，Hub 不需要再存 Key；提示词与技能会按该 CLI 的方式注入" : "在这台机器上运行并登录该 CLI 后，这里会显示配置目录与默认模型"),
        field("认证", h("span", { style: "font-size:12.5px" }, r.auth)),
        tpl ? field("启动命令模板", tpl, `在项目仓库的独立工作目录中执行。占位符：{prompt} {system} {model} {mcp_config}（Hub 的调度工具通过 MCP 提供）${r.verified ? "" : "；该模板未在当前服务器上验证"}`) : null,
        max ? field("并发上限", h("div", { class: "row" }, max, h("span", { class: "muted", style: "font-size:12.5px" }, "同时运行的进程数（所有使用它的智能体共享，同一个智能体也可以同时跑多个任务）；超出的任务按优先级排队，调大后立即生效"))) : null,
        r.id !== "builtin" ? field("可用模型", (() => {
          const data = rtModels.cache[r.id];
          if (!data) {
            if (!rtModels.loading[r.id]) loadRuntimeModels(r.id).then(() => { if (viewActive("settings")) renderSettings(); });
            return h("span", { class: "muted", style: "font-size:12.5px" }, "正在检测…");
          }
          const list = data.models ?? [];
          const verify = data.verify ?? null;
          const bad = verify ? list.filter((m) => verify[m.id]?.ok === false).length : 0;
          return h("div", {},
            h("div", { class: "chips" }, list.length ? list.map((m) => {
              const v = verify?.[m.id];
              const badOne = v && v.ok === false;
              return h("span", { class: "chip" + (badOne ? " err-text" : ""), style: "padding:0 8px;cursor:default", title: v ? (v.ok ? "已验证可用" : `不可用：${v.note}`) : (m.note ?? "") },
                m.name && m.name !== m.id ? `${m.name}（${m.id}）` : m.id, badOne ? " ✕" : v ? " ✓" : null);
            }) : h("span", { class: "muted", style: "font-size:12.5px" }, "没有检测到可用模型")),
            verify && bad ? h("div", { class: "err-text", style: "font-size:12px;margin-top:4px" }, `${bad} 个模型经检测不可用（供应商返回的模型名不存在）；这些模型被智能体选中时会在启动后立刻失败，建议在下面改选可用的。`) : null,
            h("div", { class: "row", style: "margin-top:4px" },
              h("a", { class: "link", style: "font-size:12px", onclick: async (e) => { e.target.textContent = "检测中…"; await loadRuntimeModels(r.id, true); renderSettings(); } }, "重新检测"),
              h("span", { class: "muted", style: "font-size:12px" }, data.source ?? "")));
        })(), "在「智能体与工具」里给每个智能体选择具体使用哪个模型") : null,
        r.id === "builtin" && !builtinReady ? field("缺少凭据", h("div", {},
          h("div", { class: "row" },
            h("span", { class: "muted", style: "font-size:12.5px" }, "内置底座走 Anthropic Messages API，需要一条可用的连接"),
            h("button", { onclick: () => { sg.editing = settings.get().providers.find((p) => !p.verifiedAt)?.id ?? "new"; renderSettings(); } }, "去配置模型服务")),
          // 没有 API 连接、但本机有已登录的 CLI：一键把还在用内置底座的智能体切过去，不用逐个改
          (() => {
            const ready = (d?.runtimes ?? []).filter((x) => x.id !== "builtin" && x.installed && x.login?.ok);
            if (!ready.length || !used.length) return null;
            const target = ready.find((x) => x.id === "claude-code") ?? ready[0];
            return h("div", { class: "callout warn", style: "margin-top:8px" },
              h("div", { style: "flex:1" }, h("b", {}, `${used.length} 个智能体用的是内置底座，现在跑不起来：`), h("span", { class: "muted", style: "font-size:12.5px" }, used.join("、"))),
              h("button", { class: "primary", onclick: async (e) => {
                if (!confirm(`把这 ${used.length} 个智能体改用本机的 ${target.name}？`)) return;
                e.target.disabled = true;
                try { const n = await rpc("studio.switchRuntime", "builtin", target.id); await refreshState(); renderSettings(); toast(`已把 ${n} 个智能体改用 ${target.name}`, "ok"); }
                catch (err) { e.target.disabled = false; fail(err); }
              } }, `全部改用 ${target.name}`));
          })()),
          "也可以在「智能体与工具」里逐个修改") : null,
        modelMax ? field("模型并发", h("div", { class: "row" }, modelMax, h("span", { class: "muted", style: "font-size:12.5px" }, "同时在途的模型请求数，所有内置智能体共享；超出时按优先级排队，修改后立即生效")), "受 Anthropic 账号的速率限制约束，调太大会遇到 429") : null));
  };
  return section("模型接入", "模型有两个来源：本机已安装并登录的 CLI 底座，或自定义模型服务。有可用的底座就直接用它的模型，没有底座再接自定义服务。检测的是 Hub 所在的机器（部署后即服务器）。",
    h("div", { class: "callout" }, h("span", { class: "busy-dot on" }), h("b", {}, "执行节点"), h("span", {}, d ? `本节点 ${d.host}（${d.platform}）` : "本节点"),
      h("span", { style: "margin-left:auto" }), h("button", { disabled: "", title: "规划中：接入其他服务器作为执行节点" }, "+ 添加执行节点"),
      h("button", { onclick: async (e) => { e.target.disabled = true; e.target.textContent = "检测中…"; await loadRuntimes(true); renderSettings(); } }, "重新检测"),
      h("button", { onclick: async (e) => {
        e.target.disabled = true; e.target.textContent = "重新加载中…";
        try {
          const r = await rpc("system.reload");
          await refreshState(); renderSettings();
          toast(`已重新加载：${r?.runtimes?.length ?? 0} 个运行底座、${r?.agents ?? 0} 个智能体`, "ok");
        } catch (err) { fail(err); }
        finally { e.target.disabled = false; e.target.textContent = "重新加载配置"; }
      }, title: "重新读取配置、重新检测 CLI 与模型，不中断运行中的任务" }, "重新加载配置"),
      (() => {
        // 空闲时重启：等运行中的工作项结束再重启，不打断智能体；立即重启会中断它们（哨兵会重试）
        const pending = S.restartPending;
        if (pending) return h("span", { class: "row", style: "gap:6px" },
          h("span", { class: "warn" }, `⏳ 将在空闲时重启：还在等 ${pending.waiting} 个运行中的任务（含测试和子任务）`),
          h("button", { onclick: async () => { const n = await rpc("system.cancelRestart"); await refreshState(); renderSettings(); toast(n ? `已取消，放行了 ${n} 个挂起的工作项` : "已取消重启", "ok"); } }, "取消"));
        const running = (S.issues ?? []).filter((i) => i.activeRuns).length;
        return h("span", { class: "row", style: "gap:6px" },
          h("button", { title: "暂停开始新的工作项，等运行中的都结束后再重启；被挂起的工作项重启后自动开始", onclick: async () => {
            const msg = await rpc("system.restart", "idle");
            toast(msg, "review");
            await refreshState(); renderSettings();
            waitRestart(null);
          } }, "空闲时重启"),
          h("button", { class: "danger", onclick: async (e) => {
            if (!confirm(running ? `有 ${running} 个工作项正在运行，立即重启会中断它们（之后由哨兵重试）。确定立即重启？` : "立即重启服务？（约 1～3 秒）")) return;
            e.target.disabled = true; e.target.textContent = "重启中…";
            waitRestart(e.target);
            try { await rpc("system.restart", "now"); } catch { /* 重启时连接会断，属正常 */ }
          }, title: "结束当前进程并拉起新进程；运行中的任务会被中断" }, "立即重启"));
      })()),
    (() => {
      const ready = RUNTIME_DEFS.filter((r) => {
        if (r.id === "builtin") return builtinReady;
        const x = rtState.data?.runtimes.find((y) => y.id === r.id);
        return !!x?.installed && !!x?.login?.ok;
      }).map((r) => r.name);
      return h("div", { style: "display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;margin:2px 0 10px" },
        h("span", { class: ready.length ? "ok-text" : "err-text", style: "font-size:12.5px" },
          ready.length ? `当前可用的模型来源：${ready.join("、")}` : "当前没有可用的模型来源：先在本机登录一个底座，或在下面配置自定义模型服务"));
    })(),
    h("div", { style: "display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;margin:2px 0 6px" },
      h("b", { style: "font-size:13px" }, "运行底座"),
      h("span", { class: "muted", style: "font-size:12.5px" }, "已安装的直接可用；智能体选用哪个底座，就用哪个底座的模型")),
    h("div", {}, RUNTIME_DEFS.map(card)),
    fallbackBlock(),
    h("div", { style: "display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;margin:16px 0 6px" },
      h("b", { style: "font-size:13px" }, "自定义模型服务"),
      h("span", { class: "muted", style: "font-size:12.5px" }, "没有可用底座、或想用别的服务商时在这里配置；内置运行底座的智能体使用这里的模型")),
    customService);
}

/** 兜底换模型 + 按厂商限并发（CLI 底座） */
function fallbackBlock() {
  const S = settings.get();
  S.fallback ??= { on: true, chain: [] };
  const F = S.fallback;
  const toLines = () => F.chain.map((c) => `${c.runtime} ${c.model}`.trim()).join("\n");
  const chain = h("textarea", { rows: 4, style: "max-width:420px;font-family:var(--mono, monospace);font-size:12.5px", placeholder: "每行：底座 模型（模型留空 = 该 CLI 默认）\npi zai/glm-5.4\npi kimi-coding/k3.1-pro\nclaude-code" });
  chain.value = toLines();
  chain.onchange = () => {
    F.chain = chain.value.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => { const [runtime, ...m] = l.split(/\s+/); return { runtime, model: m.join(" ") }; });
    settings.patch(); toast("兜底顺序已保存", "ok");
  };
  const caps = Object.entries(S.runtimes ?? {}).flatMap(([rt, c]) => Object.entries(c.providers ?? {}).map(([p, n]) => `${rt} ${p} ${n}`));
  const capEl = h("textarea", { rows: 2, style: "max-width:420px;font-family:var(--mono, monospace);font-size:12.5px", placeholder: "每行：底座 厂商 并发数，如\npi kimi-coding 2" });
  capEl.value = caps.join("\n");
  capEl.onchange = () => {
    for (const c of Object.values(S.runtimes ?? {})) delete c.providers;
    for (const l of capEl.value.split("\n").map((x) => x.trim()).filter(Boolean)) {
      const [rt, p, n] = l.split(/\s+/);
      if (!rt || !p || !(Number(n) > 0)) return toast(`格式不对：${l}`, "err");
      const c = rtCfg(rt); (c.providers ??= {})[p] = Number(n);
    }
    settings.patch(); toast("厂商并发上限已保存", "ok");
  };
  const down = (S_STATE_DOWN() ?? []).map((d) => `${d.key.replace("|", " ")}（到 ${new Date(d.until).toLocaleTimeString()}）`);
  return h("div", { style: "margin:16px 0 6px" },
    h("div", { style: "display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;margin-bottom:6px" },
      h("b", { style: "font-size:13px" }, "兜底换模型"),
      h("span", { class: "muted", style: "font-size:12.5px" }, "智能体的模型用不了（额度用完、并发超限、鉴权失败、厂商故障）时，按下面的顺序换成下一个能用的继续这一步，并在工作项里留言")),
    h("div", { class: "checks" }, checkboxP(F.on, (on) => { F.on = on; settings.patch(); }, "开启兜底", "关闭后模型用不了就直接失败，等额度恢复后再续跑")),
    field("兜底顺序", chain, "从上到下依次尝试，跳过智能体自己正在用的那个；用不了的模型会暂时避开（额度按恢复时间，并发超限 2 分钟，鉴权失败 30 分钟）"),
    field("按厂商限并发", capEl, "同一底座下不同厂商的并发上限可以单独设（模型名「/」前的部分）。例如 Kimi 订阅只允许少量并发请求"),
    down.length ? h("div", { class: "warn", style: "font-size:12.5px" }, `暂时避开：${down.join("、")}`) : null);
}
const S_STATE_DOWN = () => S.modelsDown;

/** 智能体编辑：运行底座选择 + 对应的模型设置 */
function runtimePicker(d) {
  const wrap = h("div", { class: "models" }, RUNTIME_DEFS.map((r) => {
    const ok = rtInstalled(r.id);
    return h("div", { class: "model-opt" + ((d.runtime ?? "builtin") === r.id ? " sel" : "") + (ok === false ? " warn" : ""), onclick: () => { d.runtime = r.id; touch(); renderStudio(); } },
      h("div", { class: "n" }, r.name, r.id !== "builtin" ? h("span", { class: "model-chip" }, "CLI") : null),
      h("div", { class: "d" }, r.desc),
      h("div", { class: "p" }, ok === null ? "检测中…" : ok ? (r.id === "builtin" ? "始终可用" : `已安装 ${rtState.data?.runtimes.find((x) => x.id === r.id)?.version ?? ""}`) : "服务器上未安装"));
  }));
  return wrap;
}
function cliModelField(d) {
  const r = rtDef(d.runtime);
  const el = h("input", { placeholder: r.modelHint, oninput: (e) => { d.cliModel = e.target.value; touch(); } });
  el.value = d.cliModel ?? "";
  return field("模型", h("div", {}, el, modelChips(d, d.runtime, (id) => { el.value = id; })),
    `由 ${r.name} 调用，${r.auth}。留空用该 CLI 的默认模型；也可以直接填模型名。`);
}

// ======================= 自动化：哨兵 + 定时任务 =======================
const auto = (() => {
  // ---------- cron：支持 分 时 日 月 周 的常见写法（* / 数字 / */N / 逗号列表） ----------
  const match = (f, v) => f === "*" || f.split(",").some((p) => (p.startsWith("*/") ? v % Number(p.slice(2)) === 0 : Number(p) === v));
  function nextRun(cron, from = new Date()) {
    const [mi, ho, dm, mo, dw] = cron.trim().split(/\s+/);
    const d = new Date(from);
    d.setSeconds(0, 0);
    d.setMinutes(d.getMinutes() + 1);
    for (let n = 0; n < 60 * 24 * 370; n++) {
      if (match(mi, d.getMinutes()) && match(ho, d.getHours()) && match(dm, d.getDate()) && match(mo, d.getMonth() + 1) && match(dw, d.getDay())) return d;
      d.setMinutes(d.getMinutes() + 1);
    }
    return null;
  }
  function describe(cron) {
    const [mi, ho, , , dw] = cron.split(/\s+/);
    const W = "日一二三四五六";
    if (cron === "* * * * *") return "每分钟";
    if (/^\*\/\d+$/.test(mi) && ho === "*") return `每 ${mi.slice(2)} 分钟`;
    if (ho === "*" && /^\d+$/.test(mi)) return `每小时第 ${mi} 分`;
    if (/^\d+$/.test(ho) && /^\d+$/.test(mi)) return `${dw === "*" ? "每天" : `每周${dw.split(",").map((x) => W[x]).join("、")}`} ${ho.padStart(2, "0")}:${mi.padStart(2, "0")}`;
    return cron;
  }

  return {
    get: () => S.auto,
    onChange: (fn) => dataListeners.add(fn),
    describe, nextRun,
    stuck: (key) => (S.auto.state?.[key]?.level ? S.auto.state[key] : null),
    run: (id) => act("auto.run", id),
    saveJob: (j) => act("auto.saveJob", j),
    toggle: (id, on) => act("auto.toggle", id, on),
    remove: (id) => act("auto.remove", id),
    setRule: (k, p) => act("auto.setRule", k, p),
  };
})();

// ======================= 自动化页面 =======================
const au = { tab: "sentinel", edit: null };
const ACTIONS = [["create", "创建工作项"], ["regression", "回归测试（测试板块）"], ["sync", "同步 GitHub / Linear"], ["report", "管家汇总进展"], ["sentinel", "哨兵巡检"], ["lead", "项目负责人巡检"]];
const CRON_PRESETS = [["*/5 * * * *", "每 5 分钟"], ["0 * * * *", "每小时"], ["0 9 * * *", "每天 09:00"], ["0 18 * * 1-5".replace("1-5", "1,2,3,4,5"), "工作日 18:00"], ["0 10 * * 1", "每周一 10:00"]];
function renderAutomation() {
  if (holdWhileEditing("#automationPage", renderAutomation)) return;
  if (!viewActive("automation")) return;
  const A = auto.get();
  const health = issuesApi.health();
  const stuck = health.filter((x) => auto.stuck(x.key));
  const tabs = [["sentinel", "哨兵"], ["jobs", "定时任务"], ["log", "巡检记录"]];
  const tile = (cls, k, v, d) => h("div", { class: "tile " + cls }, h("div", { class: "k" }, k), h("div", { class: "v" }, v), d ? h("div", { class: "d" }, d) : null);
  const sentinelJob = A.jobs.find((j) => j.action === "sentinel");
  fill($("#automationPage"),
    h("div", { class: "center-head" }, h("h2", {}, "自动化"),
      h("div", { class: "seg" }, tabs.map(([v, l]) => h("button", { class: au.tab === v ? "on" : "", onclick: () => { au.tab = v; renderAutomation(); } }, l))),
      h("span", { class: "muted" }, "无人值守：哨兵定期巡检，发现卡住的任务自动处理，处理不了再逐级上报"),
      demoFlag()),
    h("div", { class: "tiles" },
      tile("running", "执行中的工作项", health.length, `心跳正常 ${health.filter((x) => x.idleMin < A.rules.heartbeat.minutes).length}`),
      tile(stuck.length ? "bad" : "", "哨兵处理中", stuck.length, stuck.map((x) => x.key).join("、") || "没有卡住的任务"),
      tile("", "上次巡检", sentinelJob?.lastAt ? ago(sentinelJob.lastAt) : "—", sentinelJob?.history[0]?.result ?? ""),
      tile("", "定时任务", A.jobs.filter((j) => j.on).length, `下一个：${(() => { const n = A.jobs.filter((j) => j.on && j.nextAt && j.action !== "sentinel").sort((a, b) => a.nextAt.localeCompare(b.nextAt))[0]; return n ? `${n.name} · ${new Date(n.nextAt).toLocaleString()}` : "—"; })()}`)),
    au.tab === "sentinel" ? sentinelView(A, health) : au.tab === "jobs" ? jobsView(A) : logView(A));
}
function sentinelView(A, health) {
  const R = A.rules;
  const num = (v, on, w = 70) => { const el = h("input", { type: "number", min: 1, style: `width:${w}px`, onchange: (e) => on(Math.max(1, Number(e.target.value) || 1)) }); el.value = v; return el; };
  const rule = (k, title, desc, body) => h("div", { class: "rule" },
    h("label", { class: "check", style: "flex:1" }, (() => { const c = h("input", { type: "checkbox", onchange: (e) => { auto.setRule(k, { on: e.target.checked }); renderAutomation(); } }); c.checked = R[k].on; return c; })(),
      h("span", {}, h("b", {}, title), h("small", {}, desc))), body ? h("div", { class: "rule-body" }, body) : null);
  return h("div", { class: "center-grid" },
    h("div", { class: "center-block" }, h("div", { class: "bh" }, "巡检规则"),
      h("div", { class: "panel-box" },
        rule("phaseTimeout", "阶段超时", "某个阶段持续太久，按处理链逐级升级：提醒智能体 → 重启当前阶段 → 改派 → 上报项目负责人",
          h("div", { class: "sla" }, PHASES.map((p) => h("label", {}, p.label, num(R.phaseTimeout.sla[p.id], (v) => auto.setRule("phaseTimeout", { sla: { ...R.phaseTimeout.sla, [p.id]: v } }), 60), "分钟")))),
        rule("heartbeat", "无心跳", "运行期间长时间没有任何输出或工具调用，视为卡住，直接重启当前阶段", h("label", {}, num(R.heartbeat.minutes, (v) => auto.setRule("heartbeat", { minutes: v })), " 分钟无心跳")),
        rule("queueWait", "测试排队过久", "验收在测试队列等待太久，自动提升优先级", h("label", {}, "排队超过 ", num(R.queueWait.minutes, (v) => auto.setRule("queueWait", { minutes: v })), " 分钟")),
        rule("retryFailed", "失败自动重试", "运行失败且不是需求问题（如模型过载、网络错误），自动重试", h("label", {}, "最多重试 ", num(R.retryFailed.times, (v) => auto.setRule("retryFailed", { times: v })), " 次")),
        rule("confirmReminder", "等你确认过久", "需求待确认太久，通过管家在首页提醒你（这是唯一会找你的规则）", h("label", {}, "超过 ", num(R.confirmReminder.hours, (v) => auto.setRule("confirmReminder", { hours: v })), " 小时")))),
    h("div", { class: "center-block" }, h("div", { class: "bh" }, "执行中的工作项", h("span", { class: "muted" }, "心跳与阶段耗时")),
      h("div", { class: "panel-box" }, health.length ? health.map((x) => {
        const st = auto.stuck(x.key);
        const sla = R.phaseTimeout.sla[x.phase] ?? 30;
        const bad = !x.blocked && !x.testing && (x.phaseMin >= sla || x.idleMin >= R.heartbeat.minutes);
        return h("div", { class: "feed-row" + (bad ? " fail" : ""), onclick: () => { location.hash = "#issue=" + x.key; } },
          h("span", { class: "busy-dot" + (x.idleMin < R.heartbeat.minutes ? " on" : "") }),
          h("span", { class: "ikey" }, x.key), h("span", { class: "b" }, `${x.title} · ${x.blocked ? "等待需求确认" : phaseLabel(x.phase)}`),
          h("span", { class: "muted", style: "font-size:12px;white-space:nowrap" }, x.blocked ? `${Math.round(x.blockedMin)} 分钟` : `阶段 ${Math.round(x.phaseMin)}/${sla} 分 · 心跳 ${Math.round(x.idleMin)} 分前`),
          st ? h("span", { class: "tag", style: "color:var(--cancelled)" }, `已处理 ${st.level} 次`) : null);
      }) : h("div", { class: "empty" }, "没有执行中的工作项"))));
}
function jobsView(A) {
  const e = au.edit;
  const form = e ? (() => {
    const name = h("input", { placeholder: "名称", oninput: (ev) => (e.name = ev.target.value) }); name.value = e.name ?? "";
    const cron = h("input", { placeholder: "cron：分 时 日 月 周", style: "max-width:200px;font-family:var(--mono)", oninput: (ev) => { e.cron = ev.target.value; hint.textContent = auto.nextRun(e.cron) ? `${auto.describe(e.cron)} · 下次 ${auto.nextRun(e.cron).toLocaleString()}` : "表达式无效"; } }); cron.value = e.cron ?? "0 9 * * *";
    const hint = h("span", { class: "muted", style: "font-size:12.5px" }, auto.nextRun(cron.value) ? `${auto.describe(cron.value)} · 下次 ${auto.nextRun(cron.value).toLocaleString()}` : "");
    e.params ??= { title: "", description: "", assignee: "" };
    const pt = h("input", { placeholder: "工作项标题，可用 {date}", oninput: (ev) => (e.params.title = ev.target.value) }); pt.value = e.params.title;
    const pd = h("textarea", { placeholder: "描述与验收标准（会参与需求评分，越具体越好）", oninput: (ev) => (e.params.description = ev.target.value) }, e.params.description);
    return h("div", { class: "card", style: "margin-bottom:12px" }, h("div", { class: "fields" },
      field("名称", name),
      field("执行时间", h("div", { class: "row" }, select([["", "常用…"], ...CRON_PRESETS], "", (v) => { if (v) { cron.value = v; e.cron = v; cron.dispatchEvent(new Event("input")); } }, { style: "width:auto" }), cron, hint)),
      field("动作", select(ACTIONS.filter((a) => !["sentinel", "lead"].includes(a[0])), e.action ?? "create", (v) => { e.action = v; renderAutomation(); }, { style: "max-width:280px" })),
      ["create", "regression"].includes(e.action ?? "create") ? field("项目", select(issuesApi.projects().map((p) => [p.id, `${p.key} · ${p.name}`]), e.projectId ?? curProject()?.id, (v) => (e.projectId = v), { style: "max-width:280px" })) : null,
      (e.action ?? "create") === "create" ? [field("工作项标题", pt), field("描述", pd), field("负责人", select([["", "交给项目负责人分派"], ...agentNames().map((n) => [n, n])], e.params.assignee, (v) => (e.params.assignee = v), { style: "max-width:280px" }))] : null,
      h("div", { class: "row", style: "justify-content:flex-end" }, h("button", { onclick: () => { au.edit = null; renderAutomation(); } }, "取消"),
        h("button", { class: "primary", onclick: () => auto.saveJob({ action: "create", projectId: curProject()?.id, ...e, cron: cron.value }).then(() => { au.edit = null; renderAutomation(); toast("定时任务已保存", "ok"); }).catch(fail) }, "保存"))));
  })() : h("div", { style: "margin-bottom:10px" }, h("button", { class: "primary", onclick: () => { au.edit = { action: "create", cron: "0 9 * * 1" }; renderAutomation(); } }, "+ 新建定时任务"));
  return [form, h("div", { class: "panel-box" }, h("table", { class: "lc-table", style: "border:none" },
    h("thead", {}, h("tr", {}, ["", "名称", "执行时间", "动作", "下次运行", "最近结果", ""].map((x) => h("th", {}, x)))),
    h("tbody", {}, A.jobs.map((j) => {
      const sw = h("input", { type: "checkbox", disabled: j.system ? "" : null, onchange: (ev) => { auto.toggle(j.id, ev.target.checked); renderAutomation(); } }); sw.checked = j.on;
      const last = j.history[0];
      return h("tr", { style: "cursor:default" },
        h("td", {}, sw),
        h("td", {}, h("b", {}, j.name), j.system ? h("span", { class: "tag", style: "margin-left:6px" }, "系统") : null,
          j.projectId ? h("div", { class: "muted", style: "font-size:12px" }, issuesApi.project(j.projectId)?.name ?? "") : null),
        h("td", {}, auto.describe(j.cron), h("div", { class: "muted", style: "font-size:11.5px;font-family:var(--mono)" }, j.cron)),
        h("td", { style: "font-size:12.5px" }, ACTIONS.find((a) => a[0] === j.action)?.[1]),
        h("td", { style: "font-size:12.5px" }, j.on && j.nextAt ? (["sentinel", "lead"].includes(j.action) ? "持续" : new Date(j.nextAt).toLocaleString()) : "—"),
        h("td", { style: "font-size:12.5px" }, last ? h("span", { class: last.ok ? "" : "err-text" }, `${last.result} · ${ago(last.at)}`) : h("span", { class: "muted" }, "尚未运行")),
        h("td", { style: "white-space:nowrap" }, h("button", { onclick: () => auto.run(j.id).then(() => { renderAutomation(); toast(`已运行「${j.name}」`, "ok"); }) }, "立即运行"),
          !j.system ? [" ", h("button", { onclick: () => { au.edit = JSON.parse(JSON.stringify(j)); renderAutomation(); } }, "编辑"), " ",
            h("button", { class: "danger", onclick: () => { if (confirm(`删除定时任务「${j.name}」？`)) { auto.remove(j.id); renderAutomation(); } } }, "删除")] : null));
    }))))];
}
function logView(A) {
  const K = { nudge: "提醒", restart: "重启", reassign: "改派", escalate: "上报", boost: "提速", retry: "重试", remind: "提醒你", job: "定时" };
  return h("div", { class: "panel-box" }, A.log.length ? A.log.slice(0, 100).map((l) => h("div", { class: "feed-row" + (["reassign", "escalate"].includes(l.kind) ? " fail" : ""), onclick: () => { if (l.key) location.hash = "#issue=" + l.key; } },
    h("span", { class: "tag" }, K[l.kind] ?? l.kind), h("span", { class: "b", title: l.text }, l.text), h("span", { class: "time" }, ago(l.at))))
    : h("div", { class: "empty" }, "还没有记录"));
}
auto.onChange(() => { if (viewActive("automation")) debounce("automation", renderAutomation, 150); });

// ======================= 通知 / 预算 / 安全护栏 / 项目知识 =======================
const usd = (n) => "$" + (Number(n) || 0).toFixed(2);
const NOTIFY_EVENTS = { confirm: "需求待确认", review: "等你最终验收", guard: "安全护栏拦截，需要你确认", hotfix: "Hotfix 已由 AI 验收上线", budget: "预算熔断" };
const notify = {
  get db() { return { channels: S.settings.notify.channels, events: S.settings.notify.events, items: S.notifications }; },
  save: () => settings.patch(),
  on: (fn) => dataListeners.add(fn),
  unread: () => S.notifications.filter((x) => !x.read).length,
  readAll: () => act("notify.readAll"),
};
const budget = {
  get db() { return S.settings.budget; },
  save: () => settings.patch(),
  spent(pid) { const day = new Date().toDateString(); return S.costs.filter((c) => new Date(c.startedAt).toDateString() === day && (!pid || c.projectId === pid)).reduce((s, c) => s + c.cost, 0); },
};
const guard = { get db() { return S.settings.guard; }, save: () => settings.patch() };
const knowledge = {
  list: (pid) => S.knowledge.filter((k) => k.projectId === pid).slice().reverse(),
  add: (pid, kind, text) => act("knowledge.add", pid, kind, text).catch(fail),
  toggle: (pid, id, on) => act("knowledge.toggle", id, on).catch(fail),
  remove: (pid, id) => act("knowledge.remove", id).catch(fail),
};

// ---------- 通知面板 ----------
function renderBell() {
  const n = notify.unread();
  $("#bellCount").textContent = n ? String(n) : "";
  if (!$("#notifPanel").classList.contains("open")) return;
  fill($("#notifPanel"),
    h("div", { class: "np-head" }, h("b", {}, "通知"), h("span", { class: "muted", style: "font-size:12px" }, "只有需要你参与或知情的事才会通知"),
      h("a", { class: "link", style: "margin-left:auto;font-size:12.5px", onclick: () => { closeNotif(); showView("settings"); sg.tab = "integrations"; renderSettings(); } }, "设置")),
    notify.db.items.length ? notify.db.items.slice(0, 30).map((x) => h("div", { class: "np-item" + (x.read ? "" : " unread"), onclick: () => { closeNotif(); if (x.key) location.hash = "#issue=" + x.key; } },
      h("span", { class: "np-dot k-" + x.kind }),
      h("div", { style: "flex:1;min-width:0" }, h("div", { class: "np-title" }, x.title), h("div", { class: "np-body" }, x.body),
        h("div", { class: "np-meta" }, ago(x.at), x.sent.length ? ` · 已推送：${x.sent.join("、")}` : " · 未配置推送渠道"))))
      : h("div", { class: "empty" }, "暂无通知"));
}
function closeNotif() { $("#notifPanel").classList.remove("open"); }
$("#bellBtn").addEventListener("click", (e) => {
  e.stopPropagation();
  const open = $("#notifPanel").classList.toggle("open");
  renderBell();
  if (open) setTimeout(() => notify.readAll(), 1200);
});
document.addEventListener("click", (e) => { if (!$("#notifPanel").contains(e.target)) closeNotif(); });
notify.on(renderBell);

// ======================= 设置页扩展：标签页 + 通知 / 预算 / 安全护栏 =======================
const SETTINGS_TABS = [["run", "运行与模型", ["模型接入", "模型"]], ["integrations", "集成与通知", ["GitHub", "Linear", "通知"]], ["safety", "预算与安全", ["预算", "安全护栏"]]];
sg.tab = "run";
function numIn(v, on, attrs = {}) { const el = h("input", { type: "number", min: 0, style: "max-width:120px", ...attrs, onchange: (e) => on(Number(e.target.value) || 0) }); el.value = v; return el; }
function listEditor(arr, onSave, placeholder) {
  const el = h("textarea", { class: "prompt-area", style: "min-height:84px", placeholder, onchange: (e) => { arr.splice(0, arr.length, ...e.target.value.split("\n").map((x) => x.trim()).filter(Boolean)); onSave(); } }, arr.join("\n"));
  return el;
}
function notifySection() {
  const N = notify.db;
  return section("通知", "你只参与需求确认和最终验收，这两类事会主动推送给你，不用一直盯着面板。",
    field("推送渠道", h("div", { class: "fields", style: "gap:8px" }, N.channels.map((c) => {
      const on = h("input", { type: "checkbox", disabled: c.builtin ? "" : null, onchange: (e) => { c.on = e.target.checked; notify.save(); renderSettings(); } });
      on.checked = c.on;
      const url = c.builtin ? null : h("input", { placeholder: c.type === "email" ? "接收邮箱，如 you@example.com" : "Webhook 地址", onchange: (e) => { c.url = e.target.value.trim(); notify.save(); } });
      if (url) url.value = c.url;
      return h("div", { class: "row", style: "flex-wrap:nowrap" }, h("label", { class: "check", style: "min-width:150px;align-items:center" }, on, h("span", {}, c.name)),
        url ?? h("span", { class: "muted", style: "font-size:12.5px" }, "面板内的通知中心，始终开启"),
        url ? h("button", { onclick: () => settings.patch().then(() => rpc("settings.testChannel", c.id)).then(() => toast(`已向「${c.name}」发送测试消息`, "ok")).catch(fail) }, "测试") : null);
    })), "飞书和企业微信可直接在消息里点击进入对应工作项"),
    field("通知哪些事", h("div", { class: "checks" }, Object.entries(NOTIFY_EVENTS).map(([k, label]) => checkboxP(N.events[k], (on) => { N.events[k] = on; notify.save(); }, label)))));
}
function budgetSection() {
  const B = budget.db;
  const meter = (spent, cap) => h("span", { class: "row", style: "gap:8px" }, h("span", { class: "covbar", style: "width:160px" }, h("i", { style: `width:${cap ? Math.min(100, (spent / cap) * 100) : 0}%;background:${cap && spent / cap > 0.85 ? "var(--failed)" : "var(--accent)"}` })),
    h("span", { class: "muted", style: "font-size:12.5px" }, `今日已用 ${usd(spent)}${cap ? ` / ${usd(cap)}` : ""}`));
  return section("预算", "全自动运行时的花费上限。超过后暂停发起新的运行并通知你，已在执行的会跑完当前阶段。",
    field("每日总预算（美元）", h("div", { class: "row" }, numIn(B.daily, (v) => { B.daily = v; budget.save(); renderSettings(); }), meter(budget.spent(), B.daily)), "填 0 表示不限制"),
    field("单个工作项上限", numIn(B.perIssue, (v) => { B.perIssue = v; budget.save(); }), "防止某个工作项反复返工消耗过多"),
    field("各项目每日预算", h("div", { class: "fields", style: "gap:8px" }, issuesApi.projects().map((p) => h("div", { class: "row" }, h("span", { style: "min-width:120px" }, p.name),
      numIn(B.perProject[p.id] ?? 0, (v) => { B.perProject[p.id] = v; budget.save(); renderSettings(); }), meter(budget.spent(p.id), B.perProject[p.id] ?? 0))))));
}
function guardSection() {
  const G = guard.db;
  const name = h("input", { placeholder: "名称，如 STRIPE_TEST_KEY", style: "max-width:240px" });
  const val = h("input", { type: "password", autocomplete: "off", placeholder: "值（只保存在服务端）", style: "max-width:240px" });
  return section("安全护栏", "智能体在服务器上自主执行命令、修改代码并合并 PR，这些规则限定它能做到哪一步。",
    field("执行隔离", h("div", { class: "radio-row" },
      [["worktree", "独立工作目录", "每个任务在仓库的独立 worktree 中执行，互不干扰，开销小"], ["container", "容器沙箱", "每个任务在一次性容器中执行，文件系统与网络隔离，更安全"]].map(([v, t, d]) =>
        h("div", { class: "radio-card" + (G.isolation === v ? " sel" : ""), onclick: () => { G.isolation = v; guard.save(); renderSettings(); } }, h("b", {}, t), h("span", {}, d))))),
    field("网络访问", select([["allowlist", "仅允许访问白名单域名（GitHub、包管理源、测试环境）"], ["open", "不限制"]], G.network, (v) => { G.network = v; guard.save(); }, { style: "max-width:420px" })),
    field("密钥", h("div", { class: "fields", style: "gap:6px" },
      G.secrets.map((s) => h("div", { class: "row" }, h("code", {}, s.name), h("span", { class: "muted", style: "font-size:12.5px" }, `${s.scope} · ••••••••`),
        h("a", { class: "link", style: "font-size:12.5px;color:var(--failed);margin-left:auto", onclick: () => act("settings.removeSecret", s.name).then(renderSettings).catch(fail) }, "移除"))),
      h("div", { class: "row" }, name, val, h("button", { onclick: () => { if (!/^[A-Z][A-Z0-9_]*$/.test(name.value)) return toast("名称用大写字母、数字和下划线", "err"); if (!val.value) return toast("请填写值", "err"); act("settings.addSecret", name.value, val.value).then(() => { renderSettings(); toast("已保存，值只存在服务端", "ok"); }).catch(fail); } }, "添加"))),
      "智能体只能按名称引用，由 Hub 在执行时注入；密钥值不会出现在提示词、日志和对话记录里"),
    field("受保护分支", listEditor(G.protectedBranches, guard.save, "每行一个，支持通配符"), "智能体不能直接推送到这些分支，只能通过 PR 合并"),
    field("受保护路径", listEditor(G.protectedPaths, guard.save, "每行一个，支持通配符"), "PR 改动涉及这些路径时不会自动合并，必须由你确认"),
    field("自动合并上限", h("div", { class: "row" }, numIn(G.maxDiff, (v) => { G.maxDiff = v; guard.save(); }), h("span", { class: "muted", style: "font-size:12.5px" }, "行（增加 + 删除），超过则需要你确认")), null),
    field("资深评审代替人放行", (() => {
      const R = G.reviewer ?? null;
      const set = (patch) => { G.reviewer = patch ? { agent: "code-reviewer", size: true, paths: [], ...(G.reviewer ?? {}), ...patch } : null; guard.save(); renderSettings(); };
      return h("div", { class: "fields", style: "gap:6px" },
        h("div", { class: "row" }, select([["", "不使用（被拦下的都等你确认）"], ...(state.agents ?? S.agents ?? []).map((a) => [a.name, a.name])], R?.agent ?? "", (v) => set(v ? { agent: v } : null), { style: "max-width:320px" })),
        R ? h("div", { class: "checks" }, checkboxP(R.size, (on) => set({ size: on }), "改动超过行数上限时", "由它看整个 PR，通过即合并")) : null,
        R ? field("它还可以放行的受保护路径", listEditor(R.paths, () => set({}), "从上面的受保护路径里挑，每行一个"), "例如 **/migrations/**；没列出的受保护路径仍然要你确认") : null);
    })(), "被安全护栏拦下、且测试与 CI 都通过时，先交给这个智能体（建议用最强的模型）对整个 PR 做一次资深评审：结论通过就自动合并，需要修改就带着意见交回开发。每个工作项最多 2 次，之后交给你"),
    h("div", { class: "checks" }, checkboxP(G.requireTests, (on) => { G.requireTests = on; guard.save(); }, "测试未通过时禁止合并", "包括 Hotfix")),
    field("回滚", h("span", { style: "font-size:13px" }, "已合并的 PR 可以在工作项详情里一键回滚：自动创建并合并 revert PR，工作项回到「待规划」。")),
    field("面板访问", select([["token", "访问令牌（HUB_TOKEN）"], ["password", "账号密码登录"], ["sso", "单点登录（规划中）"]], G.access, (v) => { G.access = v; guard.save(); }, { style: "max-width:320px" }), "部署到服务器后务必开启，并通过 HTTPS 访问"));
}
const _renderSettings = renderSettings;
renderSettings = function () {
  _renderSettings();
  const inner = $("#settingsPage .studio-inner");
  if (!inner) return;
  inner.append(...[notifySection(), budgetSection(), guardSection()].flat());
  const tabOf = (label) => SETTINGS_TABS.find((t) => t[2].includes(label))?.[0];
  inner.querySelectorAll(":scope > .ed-section").forEach((s) => { s.style.display = tabOf(s.querySelector(".lbl b")?.textContent) === sg.tab ? "" : "none"; });
  inner.querySelector(".ed-head")?.after(h("div", { class: "seg", style: "margin-bottom:6px" }, SETTINGS_TABS.map(([v, l]) => h("button", { class: sg.tab === v ? "on" : "", onclick: () => { sg.tab = v; setHash("settings", { tab: v }); renderSettings(); } }, l))));
};

// ======================= 项目页扩展：项目知识 =======================
const kg = { kind: "约定", text: "" };
const _renderProjectPage = renderProjectPage;
renderProjectPage = function () {
  _renderProjectPage();
  const p = curProject();
  const bar = $("#pgSave");
  if (!p || !bar) return;
  const items = knowledge.list(p.id);
  const ta = h("textarea", { placeholder: "一条约定、架构说明或教训…", style: "min-height:60px", oninput: (e) => (kg.text = e.target.value) }, kg.text);
  const sec = section("项目知识", "这个项目的长期上下文。智能体每次执行都会带上已启用的条目；评审未通过的原因会自动沉淀为「教训」，避免重复犯错。",
    h("div", { class: "panel-box" }, items.length ? items.map((k) => {
      const on = h("input", { type: "checkbox", onchange: (e) => knowledge.toggle(p.id, k.id, e.target.checked) });
      on.checked = k.on;
      return h("div", { class: "kn-row" }, on, h("span", { class: "tag kn-" + k.kind }, k.kind),
        h("div", { style: "flex:1;min-width:0" }, h("div", {}, k.text), h("div", { class: "muted", style: "font-size:11.5px;margin-top:2px" }, `${k.source} · ${ago(k.at)}`)),
        h("a", { class: "link", style: "font-size:12.5px;color:var(--muted)", onclick: () => { knowledge.remove(p.id, k.id); renderProjectPage(); } }, "删除"));
    }) : h("div", { class: "empty", style: "padding:20px" }, "还没有项目知识")),
    h("div", { class: "row", style: "align-items:flex-start;flex-wrap:nowrap" }, select([["约定", "约定"], ["架构", "架构"], ["教训", "教训"]], kg.kind, (v) => (kg.kind = v), { style: "width:auto" }), ta,
      h("button", { onclick: () => { if (!kg.text.trim()) return ta.focus(); knowledge.add(p.id, kg.kind, kg.text.trim()); kg.text = ""; renderProjectPage(); toast("已添加到项目知识", "ok"); } }, "添加")));
  bar.before(sec);
};

// ======================= 工作项详情扩展：验收视图 + 回滚 + 花费 =======================
function acceptancePanel(d) {
  const q = assessRequirement(d);
  const runs = qa.runsFor(d.key);
  const last = runs.find((r) => r.status === "passed") ?? runs[0];
  const env = qa.get().envs[d.projectId];
  const preview = d.pr && env?.preview ? env.preview.replace("{pr}", d.pr.number) : env?.baseUrl;
  const deliver = d.activity.filter((c) => c.kind === "agent").at(-1);
  const shots = last?.simulated ? last.cases.filter((c) => c.kind === "browser").flatMap((c, n) => c.steps.filter((s) => s.assert && s.status).map((s) => ({ src: shotSvg(last, c, s, n), title: c.title }))).slice(0, 4) : [];
  const crit = q.criteria.map((c, k) => {
    const hit = runs.flatMap((r) => r.cases.filter((x) => x.criterion === k));
    return { c, state: hit.some((x) => x.status === "passed") ? "pass" : hit.some((x) => x.status === "failed") ? "fail" : "none" };
  });
  const fact = (k, v, cls = "") => h("div", { class: "ac-fact" }, h("div", { class: "k" }, k), h("div", { class: "v " + cls }, v));
  return h("div", { class: "accept" },
    h("div", { class: "ac-title" }, "验收材料", h("span", { class: "muted" }, "AI 已完成测试与审核，以下供你做最终判断")),
    h("div", { class: "ac-facts" },
      fact("测试", last ? `${last.cases.filter((c) => c.status === "passed").length}/${last.cases.length} 通过` : "未运行", last?.status === "passed" ? "ok-text" : "err-text"),
      fact("AI 审核", d.pr?.guard ? "已拦截" : "通过", d.pr?.guard ? "err-text" : "ok-text"),
      fact("代码", d.pr ? `${prName(d.pr)} ${{ merged: "已合并", open: "待合并", reverted: "已回滚" }[d.pr.state] ?? ""}` : "无代码改动"),
      fact("返工", `${d.cycle} 轮`), fact("花费", usd(d.cost))),
    d.pr?.guard ? h("div", { class: "callout warn" }, `🛡 安全护栏：${d.pr.guard}。未自动合并，确认无误后点上方按钮合并。`) : null,
    preview ? h("div", { class: "row" }, h("span", { class: "muted", style: "font-size:12.5px" }, "预览"), h("a", { class: "link", href: preview, target: "_blank", rel: "noopener" }, preview)) : null,
    h("div", { class: "ac-sub" }, "验收标准"),
    h("div", {}, crit.map((x) => h("div", { class: "ac-crit" }, h("span", { class: x.state === "pass" ? "ok-text" : x.state === "fail" ? "err-text" : "muted" }, { pass: "✓", fail: "✕", none: "○" }[x.state]), h("span", {}, x.c),
      x.state === "none" ? h("span", { class: "muted", style: "font-size:12px;margin-left:auto" }, "未被测试覆盖，请人工确认") : null))),
    shots.length ? [h("div", { class: "ac-sub" }, "关键截图"), h("div", { class: "ac-shots" }, shots.map((s) => h("img", { src: s.src, title: s.title, onclick: () => zoomShot(s.src) })))] : null,
    deliver ? [h("div", { class: "ac-sub" }, "交付摘要"), h("div", { class: "text ac-deliver" }, deliver.body.split("\n").slice(0, 8).join("\n"))] : null,
    last ? h("div", {}, h("a", { class: "link", style: "font-size:12.5px", onclick: () => openRun(last.id) }, "查看完整测试报告 →")) : null);
}
const _renderDrawer = renderDrawer;
renderDrawer = async function () {
  await _renderDrawer();
  if (!ui.openKey) return;
  let d;
  try { d = await issuesApi.detail(ui.openKey); } catch { return; }
  const dr = $("#drawer");
  if (d.status === "in_review" && !dr.querySelector(".accept")) dr.querySelector(".actionbar")?.after(acceptancePanel(d));
  // 花费
  const props = dr.querySelector(".props");
  if (props && !props.querySelector(".cost-row")) props.append(h("label", { class: "cost-row" }, "花费"), h("div", { class: "row" }, h("span", {}, usd(d.cost)), h("span", { class: "muted", style: "font-size:12.5px" }, `${d.runs} 次运行 · ${d.cycle} 轮`)));
  // 回滚
  const call = [...dr.querySelectorAll(".callout")].find((c) => c.textContent.includes("PR #"));
  if (call && d.pr?.state === "merged" && !call.querySelector(".rb")) call.append(h("button", { class: "danger rb", onclick: () => { if (confirm(`回滚 PR #${d.pr.number}？会创建并合并 revert PR，工作项回到「待规划」。`)) issuesApi.rollback(d.key).then(() => toast(`已回滚 PR #${d.pr.number}`, "ok")).catch(fail); } }, "回滚"));
};

// ======================= 洞察：度量与复盘 / 成本 =======================
const ins = { tab: "metrics" };
async function renderInsights() {
  if (holdWhileEditing("#insightsPage", renderInsights)) return;
  if (!viewActive("insights")) return;
  const all = await issuesApi.list();
  const tile = (cls, k, v, d) => h("div", { class: "tile " + cls }, h("div", { class: "k" }, k), h("div", { class: "v" }, v), d ? h("div", { class: "d" }, d) : null);
  const bar = (ratio, color = "var(--accent)") => h("span", { class: "covbar", style: "width:110px" }, h("i", { style: `width:${Math.round(Math.max(0, Math.min(1, ratio)) * 100)}%;background:${color}` }));
  const pct = (a, b) => (b ? Math.round((a / b) * 100) + "%" : "—");
  const table = (heads, rows) => h("div", { class: "panel-box" }, h("table", { class: "lc-table", style: "border:none" }, h("thead", {}, h("tr", {}, heads.map((x) => h("th", {}, x)))), h("tbody", {}, rows.length ? rows : h("tr", {}, h("td", { colspan: heads.length, class: "muted" }, "暂无数据")))));
  const row = (cells, key) => h("tr", { style: key ? "" : "cursor:default", onclick: key ? () => { location.hash = "#issue=" + key; } : null }, cells.map((c) => h("td", {}, c)));

  const disk = ins.tab === "disk" ? await rpc("work.diskUsage") : null;
  let body;
  if (ins.tab === "metrics") {
    const fin = all.filter((i) => i.phases.length && ["in_review", "done"].includes(i.status));
    const clean = (i) => i.cycle === 1 && !i.phases.some((p) => p.result === "fail");
    const mins = (i) => { const a = i.phases[0]?.startedAt, b = i.phases.at(-1)?.endedAt; return a && b ? (new Date(b) - new Date(a)) / 60000 : 0; };
    const avg = (arr, f) => (arr.length ? arr.reduce((s, x) => s + f(x), 0) / arr.length : 0);
    const fails = all.flatMap((i) => i.phases.filter((p) => p.result === "fail").map((p) => ({ i, p })));
    const agents = [...new Set(fin.map((i) => i.assignee).filter(Boolean))].map((a) => { const its = fin.filter((i) => i.assignee === a); return { a, n: its.length, first: its.filter(clean).length, cyc: avg(its, (i) => i.cycle), cost: avg(its, (i) => i.cost) }; }).sort((x, y) => y.n - x.n);
    const buckets = [["低于 60", (s) => s < 60], ["60 – 79", (s) => s >= 60 && s < 80], ["80 以上", (s) => s >= 80]].map(([label, f]) => { const its = fin.filter((i) => f(assessRequirement(i).score)); return { label, n: its.length, first: its.filter(clean).length, cyc: avg(its, (i) => i.cycle) }; });
    body = [
      h("div", { class: "tiles" },
        tile("", "一次通过率", pct(fin.filter(clean).length, fin.length), `${fin.length} 个已交付的工作项中，${fin.filter(clean).length} 个没有任何返工`),
        tile("", "平均返工轮数", avg(fin, (i) => i.cycle).toFixed(1), "1.0 表示全部一轮完成"),
        tile("", "平均交付时长", `${Math.round(avg(fin, mins))} 分钟`, "从需求理解到评审通过"),
        tile(fails.length ? "bad" : "", "未通过次数", fails.length, `测试 ${fails.filter((f) => f.p.phase === "test").length} · 评审 ${fails.filter((f) => f.p.phase === "review").length}`)),
      h("div", { class: "center-grid" },
        h("div", { class: "center-block" }, h("div", { class: "bh" }, "需求质量与返工", h("span", { class: "muted" }, "需求越具体，返工越少")),
          table(["需求评分", "工作项", "一次通过率", "平均轮数"], buckets.map((b) => row([b.label, b.n, h("span", { class: "row", style: "gap:8px" }, bar(b.n ? b.first / b.n : 0, "var(--completed)"), pct(b.first, b.n)), b.n ? b.cyc.toFixed(1) : "—"])))),
        h("div", { class: "center-block" }, h("div", { class: "bh" }, "智能体表现"),
          table(["智能体", "交付", "一次通过率", "平均轮数", "平均花费"], agents.map((x) => row([h("span", { class: "who" }, avatar(x.a), x.a), x.n, h("span", { class: "row", style: "gap:8px" }, bar(x.first / x.n, "var(--completed)"), pct(x.first, x.n)), x.cyc.toFixed(1), usd(x.cost)]))))),
      h("div", { class: "center-block" }, h("div", { class: "bh" }, "复盘：未通过的原因", h("span", { class: "muted" }, "评审未通过的原因会自动沉淀到项目知识")),
        table(["工作项", "阶段", "原因", "轮次"], fails.slice(-12).reverse().map(({ i, p }) => row([h("span", {}, h("span", { class: "ikey" }, i.key), " ", i.title), phaseLabel(p.phase), h("span", { class: "err-text" }, p.note), `第 ${p.cycle} 轮`], i.key)))),
    ];
  } else if (ins.tab === "cost") {
    const costs = issuesApi.costs();
    const sum = (arr) => arr.reduce((s, c) => s + c.cost, 0);
    const total = sum(costs);
    const byProj = issuesApi.projects().map((p) => ({ p, v: sum(costs.filter((c) => c.projectId === p.id)), cap: budget.db.perProject[p.id] ?? 0, today: budget.spent(p.id) }));
    const byAgent = [...new Set(costs.map((c) => c.agent))].map((a) => ({ a, v: sum(costs.filter((c) => c.agent === a)), n: costs.filter((c) => c.agent === a).length })).sort((x, y) => y.v - x.v);
    const top = all.slice().sort((a, b) => b.cost - a.cost).slice(0, 8);
    const today = budget.spent();
    body = [
      h("div", { class: "tiles" },
        tile(budget.db.daily && today / budget.db.daily > 0.85 ? "bad" : "", "今日花费", usd(today), budget.db.daily ? `每日预算 ${usd(budget.db.daily)}，已用 ${pct(today, budget.db.daily)}` : "未设置每日预算"),
        tile("", "累计花费", usd(total), `${costs.length} 次运行`),
        tile("", "平均每个工作项", usd(all.length ? total / all.filter((i) => i.cost > 0).length : 0), `单项上限 ${usd(budget.db.perIssue)}`),
        tile("", "预算设置", h("a", { class: "link", style: "font-size:15px", onclick: () => { showView("settings"); sg.tab = "safety"; renderSettings(); } }, "去调整 →"), "超过预算会暂停新的运行并通知你")),
      h("div", { class: "center-grid" },
        h("div", { class: "center-block" }, h("div", { class: "bh" }, "按项目"),
          table(["项目", "累计", "今日 / 预算"], byProj.map((x) => row([x.p.name, usd(x.v), h("span", { class: "row", style: "gap:8px" }, bar(x.cap ? x.today / x.cap : 0, x.cap && x.today / x.cap > 0.85 ? "var(--failed)" : "var(--accent)"), `${usd(x.today)}${x.cap ? ` / ${usd(x.cap)}` : ""}`)])))),
        h("div", { class: "center-block" }, h("div", { class: "bh" }, "按智能体"),
          table(["智能体", "运行次数", "花费", "占比"], byAgent.map((x) => row([h("span", { class: "who" }, avatar(x.a), x.a), x.n, usd(x.v), h("span", { class: "row", style: "gap:8px" }, bar(total ? x.v / total : 0), pct(x.v, total))]))))),
      h("div", { class: "center-block" }, h("div", { class: "bh" }, "花费最高的工作项"),
        table(["工作项", "状态", "轮次", "运行", "花费"], top.filter((i) => i.cost > 0).map((i) => row([h("span", {}, h("span", { class: "ikey" }, i.key), " ", i.title), statusOf(i.status).label, i.cycle || "—", i.runs, usd(i.cost)], i.key)))),
    ];
  } else {
    const size = (n) => (!n ? "0" : n >= 1 << 30 ? `${(n / (1 << 30)).toFixed(1)} GB` : n >= 1 << 20 ? `${(n / (1 << 20)).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
    const items = (disk?.projects ?? []).flatMap((p) => p.items.map((x) => ({ ...x, p })));
    const total = items.reduce((n, x) => n + x.bytes, 0);
    const reclaimable = items.filter((x) => x.reclaimable).reduce((n, x) => n + x.bytes, 0);
    const clean = async (e) => {
      e.target.disabled = true; e.target.textContent = "清理中…";
      try {
        const r = await rpc("work.cleanWorkspaces");
        toast(`回收 ${r.removed} 个工作目录，释放 ${size(r.freed)}`, "ok");
        renderInsights();
      } catch (err) { fail(err); e.target.disabled = false; e.target.textContent = "清理可回收项"; }
    };
    body = [
      h("div", { class: "tiles" },
        tile("", "工作目录占用", size(total), `${items.length} 个 worktree`),
        tile(reclaimable > 0 ? "bad" : "", "可回收", size(reclaimable), "工作项已完成 / 已取消 / 已删除的目录"),
        tile("", "已结束但未回收", items.filter((x) => x.reclaimable).length, "自动清扫每小时一次，也可以立即清理"),
        tile("", "上次清扫", disk?.lastSweep ? ago(disk.lastSweep.at) : "还没有", disk?.lastSweep ? `回收了 ${disk.lastSweep.removed} 个` : "启用后每小时自动清扫")),
      h("div", { class: "row", style: "margin-bottom:14px" },
        h("button", { class: "primary", disabled: reclaimable ? null : "", onclick: clean }, "清理可回收项"),
        h("span", { class: "muted", style: "font-size:12.5px" }, "只删除 Hub 自己建的 worktree 与本地分支，远端分支和 PR 不受影响")),
      ...(disk?.projects ?? []).map((p) => {
        const rowOf = (x) => h("tr", { style: "cursor:default" },
          h("td", {}, h("span", { class: "ikey" }, x.key)),
          h("td", {}, x.status ? statusOf(x.status).label : h("span", { class: "muted" }, "工作项已删除")),
          h("td", {}, size(x.bytes)),
          h("td", { class: "muted", style: "font-size:12px" }, x.mtime ? ago(x.mtime) : "—"),
          h("td", {}, x.reclaimable ? h("span", { class: "tag" }, "可回收") : h("span", { class: "muted", style: "font-size:12px" }, "使用中")));
        return h("div", { class: "center-block" },
          h("div", { class: "bh" }, p.name, h("span", { class: "muted" }, `${p.items.length} 个目录 · ${size(p.total)}${p.reclaimable ? ` · 可回收 ${size(p.reclaimable)}` : ""}`)),
          table(["工作项", "状态", "占用", "最后修改", ""], p.items.map(rowOf)));
      }),
    ];
  }
  fill($("#insightsPage"),
    h("div", { class: "center-head" }, h("h2", {}, "洞察"),
      h("div", { class: "seg" }, [["metrics", "度量与复盘"], ["cost", "成本"], ["disk", "磁盘"]].map(([v, l]) => h("button", { class: ins.tab === v ? "on" : "", onclick: () => { ins.tab = v; renderInsights(); } }, l))),
      demoFlag()),
    body);
}
issuesApi.onChange(() => { if (viewActive("insights")) debounce("insights", renderInsights, 400); });

/** 关闭对话框后把焦点还给触发它的元素 */
function restoreFocus() {
  const el = ui.focusReturn;
  ui.focusReturn = null;
  if (el && document.contains(el) && typeof el.focus === "function") el.focus({ preventScroll: true });
}
/** 当前打开的对话框，用于把 Tab 键限制在内部 */
function openDialog() {
  if ($("#modal").classList.contains("open")) return $("#modal");
  if ($("#qaDrawer").classList.contains("open")) return $("#qaDrawer");
  if ($("#drawer").classList.contains("open")) return $("#drawer");
  return null;
}
document.addEventListener("keydown", (e) => {
  if (e.key !== "Tab") return;
  const host = openDialog();
  if (!host) return;
  const items = [...host.querySelectorAll('a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])')]
    .filter((el) => el.offsetParent !== null);
  if (!items.length) { e.preventDefault(); host.focus(); return; }
  const first = items[0], last = items.at(-1);
  if (e.shiftKey && (document.activeElement === first || document.activeElement === host)) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
});

/** 链接锚点路由：#issue=HUB-3 / #task=<id> / #view=bus（支持在页面内切换） */
async function route() {
  const hash = location.hash;
  const tab = showView;
  const issue = /issue=([\w-]+)/.exec(hash);
  const task = /task=([\w-]+)/.exec(hash);
  const view = /view=(\w+)/.exec(hash);
  closeModal();
  if (issue) { tab("issues"); history.replaceState(null, "", "#issue=" + issue[1]); openIssue(issue[1]); return; }
  if (ui.openKey) closeDrawer();
  if (task) {
    tab("tasks");
    try { const t = await api(`/tasks/${task[1]}`); selectRoot(t.rootId, t.id); } catch {}
    return;
  }
  if (view) {
    const v = view[1];
    const q = new URLSearchParams(hash.replace(/^#/, ""));
    if (v === "settings" && q.get("tab")) sg.tab = q.get("tab");
    if (v === "config" && q.get("studio")) {
      // 直接设置选择，不走 selectStudio（避免刷新时弹未保存确认）
      st.sel = { kind: q.get("studio"), id: q.get("sel") || null };
      st.attachTo = null;
      loadDraft();
    }
    tab(v);
    return;
  }
  tab("home");
}
window.addEventListener("hashchange", route);

(async () => {
  await checkSession();
  updateAuthButton();
  if (session.loginEnabled && !session.authenticated) { showLogin(); return; }
  try { await refreshState(); } catch (e) { console.error(e); }
  loadUiPrefs();
  connect();
  initIssues();
  await loadAll();
  renderAssigneeFilter();
  renderBoard();
  await route(); // 恢复刷新前的界面
  landing();
})();
setInterval(() => { if (state.tree && state.tree.status === "running") renderTree(); }, 5000);
