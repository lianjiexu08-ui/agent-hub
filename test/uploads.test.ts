/**
 * 聊天附件：保存、读取、分类与提示词展开；大小与数量限制。
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/db.ts";
import { Uploads, classify, MAX_FILE_BYTES } from "../src/uploads.ts";

const dir = mkdtempSync(join(tmpdir(), "hub-up-"));
after(() => rmSync(dir, { recursive: true, force: true }));

const store = new Store(":memory:");
const up = new Uploads(store, dir);
const file = (name: string, type: string) => ({ name, type, size: 0, arrayBuffer: async () => new ArrayBuffer(0) });

test("分类：图片 / 文本 / 其它", () => {
  assert.equal(classify("shot.png", "image/png"), "image");
  assert.equal(classify("notes.md", ""), "text");
  assert.equal(classify("config.yaml", "application/x-yaml"), "text");
  assert.equal(classify("data.csv", "text/csv"), "text");
  assert.equal(classify("app.zip", "application/zip"), "other");
});

test("保存与读取：落盘用生成的 id，文件名只用于展示", () => {
  const a = up.save(file("../../etc/passwd", "text/plain"), Buffer.from("hello"));
  assert.notEqual(a.name, "../../etc/passwd", "文件名被清洗");
  assert.equal(a.kind, "text");
  assert.match(a.url, /^\/uploads\/[a-z0-9]+$/);
  const got = up.read(a.id)!;
  assert.equal(got.data.toString("utf8"), "hello");
  assert.equal(got.meta.name, a.name);
  assert.equal(up.get(a.id)?.size, 5);
  assert.equal(up.read("nope"), null);
  up.remove(a.id);
  assert.equal(up.get(a.id), null);
});

test("超过 20 MB 拒绝", () => {
  const big = Buffer.alloc(MAX_FILE_BYTES + 1);
  assert.throws(() => up.save(file("big.bin", "application/octet-stream"), big), /超过 20 MB/);
});

test("展开：图片走视觉块、文本内联、其它只列名称", () => {
  const img = up.save(file("shot.png", "image/png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const txt = up.save(file("notes.md", "text/markdown"), Buffer.from("# 标题\n内容"));
  const zip = up.save(file("pkg.zip", "application/zip"), Buffer.from([1, 2, 3]));
  const d = up.describe([img.id, txt.id, zip.id, "missing"]);
  assert.equal(d.blocks.length, 1);
  assert.equal(d.blocks[0].media_type, "image/png");
  assert.ok(Buffer.from(d.blocks[0].data, "base64").equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])));
  assert.match(d.text, /图片：shot\.png/);
  assert.match(d.text, /# 标题/);
  assert.match(d.text, /pkg\.zip/);
  assert.match(d.text, /附件 missing 不存在/);
  assert.ok(!readFileSync(join(dir, `${img.id}.png`)).length === false);
});
