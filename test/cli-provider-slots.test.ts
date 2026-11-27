/**
 * 同一底座下按模型厂商单独限并发：Kimi 满了只让 Kimi 的任务排队，GLM 的任务照常拿到槽位。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { CliRunner } from "../src/cli.ts";
import { Store } from "../src/db.ts";
import { Settings } from "../src/settings.ts";

test("按厂商限并发：Kimi 满了不堵 GLM，释放后排队的 Kimi 任务拿到槽位", async () => {
  const settings = new Settings(new Store(":memory:"));
  settings.patch({ runtimes: { pi: { template: "pi", max: 4, providers: { "kimi-coding": 1 } } } });
  const cli = new CliRunner(settings, { tmpDir: "/tmp", hubUrl: () => "", cwdFor: () => null });
  const sig = new AbortController().signal;
  const k1 = await cli.acquire("pi", 1, sig, "kimi-coding/k3.1-pro");
  let k2got = false;
  const k2 = cli.acquire("pi", 1, sig, "kimi-coding/k3.1-pro").then((r) => { k2got = true; return r; });
  const g = await Promise.race([cli.acquire("pi", 1, sig, "zai/glm-5.4"), new Promise((r) => setTimeout(() => r(null), 500))]);
  assert.ok(g, "GLM 不受 Kimi 上限影响");
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(k2got, false, "第二个 Kimi 任务在排队");
  assert.equal(cli.stats().pi.running, 2, "排队的 Kimi 任务没有占底座槽位");
  k1();
  (await k2)();
  assert.equal(k2got, true);
});
