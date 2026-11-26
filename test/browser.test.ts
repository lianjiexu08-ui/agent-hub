/**
 * Hub 内置浏览器驱动：真实启动本机 Chrome（找不到则跳过），按 tester 的命令写法操作一个本地页面。
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BuiltinBrowser, findChrome, parseArgs } from "../src/browser.ts";
import { splitArgs } from "../src/qa.ts";

const PAGE = `<!doctype html><html lang="zh-CN"><head><title>登录 · 演示</title></head><body>
<main><h1>欢迎</h1>
<form id="f"><label for="u">用户名</label><input id="u">
<label for="p">密码</label><input id="p" type="password">
<select id="role" aria-label="角色"><option>访客</option><option>管理员</option></select>
<button type="submit">登录</button></form>
<p id="msg" role="status"></p><input type="hidden" name="csrf"><button style="display:none">隐藏按钮</button></main>
<script>
document.getElementById('f').addEventListener('submit', async (e) => {
  e.preventDefault();
  const r = await fetch('/api/login', { method: 'POST' });
  document.getElementById('msg').textContent = document.getElementById('u').value === 'preview' ? '登录成功，角色：' + document.getElementById('role').value : '用户名或口令错误（' + r.status + '）';
  if (r.status >= 500) console.error('登录接口出错', r.status);
});
</script></body></html>`;

test("命令参数解析：位置参数、带值的选项、布尔选项", () => {
  assert.deepEqual(parseArgs(splitArgs('type --uid e7 "hello world" --enter')), { pos: ["type", "hello world"], flags: { uid: "e7", enter: true } });
  assert.deepEqual(parseArgs(splitArgs("snapshot --interactive-only --compact")), { pos: ["snapshot"], flags: { "interactive-only": true, compact: true } });
  assert.deepEqual(parseArgs(splitArgs("screenshot -o a.png --full")), { pos: ["screenshot"], flags: { o: "a.png", full: true } });
});

const chrome = findChrome();
test("内置驱动：打开页面、按编号输入 / 选择 / 点击、等待文字、读控制台和网络", { skip: !chrome && "本机没有 Chrome" }, async () => {
  let fail = true;
  const srv = createServer((req, res) => {
    if (req.url === "/api/login") { res.statusCode = fail ? 500 : 200; return res.end("{}"); }
    res.setHeader("content-type", "text/html; charset=utf-8"); res.end(PAGE);
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(srv.address() as { port: number }).port}/`;
  const shotDir = mkdtempSync(join(tmpdir(), "hub-shots-"));
  const b = new BuiltinBrowser({ headless: () => true, chromePath: () => null, shotDir });
  after(async () => { await b.close(); srv.close(); });
  const run = (cmd: string, id = "r1") => b.exec(id, splitArgs(cmd));
  assert.equal(b.available(), true);
  assert.equal(await b.create("r1"), "hub-r1");

  const nav = await run(`navigate goto ${url} --wait-for main`);
  assert.equal(nav.ok, true, nav.text);
  assert.match(nav.text, /页面：登录 · 演示/);
  assert.match(nav.text, /\[e1\] textbox "用户名" =""/);
  assert.match(nav.text, /\[e2\] textbox "密码"/);
  assert.match(nav.text, /\[e3\] combobox "角色" ="访客"/);
  assert.match(nav.text, /\[e4\] button "登录"/);
  assert.doesNotMatch(nav.text, /隐藏按钮|csrf/, "不可见元素和隐藏输入不编号");

  assert.equal((await run('type --uid e1 "nobody"')).ok, true);
  const clicked = await run("click --uid e4");
  assert.match(clicked.text, /已点击 e4[\s\S]*提示：用户名或口令错误（500）/, "操作后直接返回新快照，含状态提示");
  assert.match((await run("console --level error")).text, /登录接口出错 500/);
  assert.match((await run("network --status 5xx")).text, /^500 POST .*\/api\/login/m);

  fail = false;
  await run('type --uid e1 "preview"');
  await run('select --uid e3 "管理员"');
  await run('type --uid e2 "secret" --enter');
  const waited = await run('wait --text "登录成功" --timeout 5000');
  assert.equal(waited.ok, true, waited.text);
  const snap = await run("snapshot");
  assert.match(snap.text, /textbox "密码" ="••••"/, "密码不回显");
  assert.match(snap.text, /标题：\n {2}h1 欢迎/);
  assert.match(snap.text, /正文：.*登录成功，角色：管理员/);
  assert.equal((await run("eval \"document.documentElement.lang\"")).text, "zh-CN");

  const shot = await run("screenshot");
  assert.ok(existsSync(shot.text.replace("截图已保存：", "")), shot.text);

  const missing = await run('wait --text "不存在的文字" --timeout 500');
  assert.equal(missing.ok, false, "等不到时返回失败，不抛错");
  assert.match((await run("click --uid e99 --timeout 500")).text, /Timeout|超时|exceeded/i);
  assert.equal((await run("frobnicate")).ok, false);

  // 不同验收的会话相互隔离
  await b.create("r2");
  const other = await run(`navigate goto ${url}`, "r2");
  assert.match(other.text, /\[e1\] textbox "用户名" =""/, "新会话是干净的页面");
  await b.destroy("r2");
  assert.equal((await run("snapshot", "r2")).ok, false, "销毁后不能再用");
});
