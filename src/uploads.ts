/**
 * 聊天附件：图片（截图）与文件。
 * 存在 <data>/uploads 下，元数据记在 docs/uploads；接口只返回 URL 与描述信息。
 * 限制单个 20 MB、一次最多 10 个；文件名只用于展示，落盘用生成的 id，避免路径穿越。
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import type { Store } from "./db.ts";

export interface Attachment {
  id: string;
  name: string;
  mime: string;
  size: number;
  url: string;
  /** image = 可直接给模型看；text = 可内联进提示词；other = 只给名称与链接 */
  kind: "image" | "text" | "other";
  createdBy?: string;
  at: string;
}

export const MAX_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_FILES_PER_UPLOAD = 10;
/** 内联进提示词的文本文件大小上限 */
const MAX_INLINE_TEXT = 100 * 1024;

const TEXT_EXT = /\.(txt|md|markdown|json|ya?ml|toml|ini|conf|env|csv|tsv|log|xml|html?|css|scss|js|mjs|cjs|ts|tsx|jsx|vue|svelte|py|rb|go|rs|java|kt|swift|php|sh|bash|zsh|sql|diff|patch|lock)$/i;

export function classify(name: string, mime: string): Attachment["kind"] {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("text/") || /json|xml|yaml|csv|javascript|typescript/.test(mime) || TEXT_EXT.test(name)) return "text";
  return "other";
}

const safeName = (s: string) => s.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").slice(0, 120) || "file";

export class Uploads {
  private store: Store;
  private dir: string;
  constructor(store: Store, dir: string) {
    this.store = store;
    this.dir = dir;
    mkdirSync(dir, { recursive: true });
  }

  private filePath(id: string, name: string) { return join(this.dir, `${id}${extname(name).slice(0, 12)}`); }

  /** 保存一个上传文件，返回附件元数据 */
  save(file: { name: string; type: string; size: number; arrayBuffer(): Promise<ArrayBuffer> }, data: Buffer, by?: string): Attachment {
    if (data.length > MAX_FILE_BYTES) throw new Error(`文件「${file.name}」超过 20 MB 上限`);
    const id = randomUUID().replace(/-/g, "").slice(0, 12);
    const name = safeName(file.name || "file");
    const mime = file.type || "application/octet-stream";
    const path = this.filePath(id, name);
    writeFileSync(path, data);
    const a: Attachment = {
      id, name, mime, size: data.length, url: `/uploads/${id}`, kind: classify(name, mime),
      createdBy: by, at: new Date().toISOString(),
    };
    this.store.docPut("uploads", id, { ...a, path });
    return a;
  }

  get(id: string): Attachment | null {
    const r = this.store.docGet<Attachment & { path: string }>("uploads", id);
    if (!r) return null;
    const { path: _p, ...rest } = r;
    return rest;
  }

  /** 读取文件内容（同时校验元数据存在，避免任意路径读取） */
  read(id: string): { meta: Attachment; data: Buffer } | null {
    const r = this.store.docGet<Attachment & { path: string }>("uploads", id);
    if (!r || !existsSync(r.path)) return null;
    const { path, ...meta } = r;
    return { meta, data: readFileSync(path) };
  }

  remove(id: string) {
    const r = this.store.docGet<Attachment & { path: string }>("uploads", id);
    if (r && existsSync(r.path)) rmSync(r.path, { force: true });
    this.store.docDelete("uploads", id);
  }

  /** 把附件转成提示词片段：图片走视觉块，文本内联，其它只列名称 */
  describe(ids: string[]): { blocks: { type: "image"; media_type: string; data: string }[]; text: string } {
    const blocks: { type: "image"; media_type: string; data: string }[] = [];
    const lines: string[] = [];
    for (const id of ids.slice(0, MAX_FILES_PER_UPLOAD)) {
      const got = this.read(id);
      if (!got) { lines.push(`- （附件 ${id} 不存在）`); continue; }
      const { meta, data } = got;
      if (meta.kind === "image") {
        blocks.push({ type: "image", media_type: meta.mime, data: data.toString("base64") });
        lines.push(`- 图片：${meta.name}（${Math.round(meta.size / 1024)} KB，已作为图片一并发送）`);
      } else if (meta.kind === "text" && data.length <= MAX_INLINE_TEXT) {
        lines.push(`- 文件：${meta.name}\n\`\`\`\n${data.toString("utf8").slice(0, MAX_INLINE_TEXT)}\n\`\`\``);
      } else {
        lines.push(`- 文件：${meta.name}（${Math.round(meta.size / 1024)} KB，${meta.mime}，地址 ${meta.url}，内容未内联）`);
      }
    }
    return { blocks, text: lines.join("\n") };
  }
}
