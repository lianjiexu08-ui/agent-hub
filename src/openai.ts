/**
 * OpenAI 兼容协议的模型调用：把运行时使用的 Anthropic 消息格式翻译成 Chat Completions，
 * 再把返回结果翻译回 Anthropic 的 BetaMessage。
 * 这样内置运行底座、管家、测试等上层代码都不用关心底层是哪家厂商。
 *
 * 支持：文本、多轮对话、工具调用（function calling）、用量统计。
 * 不支持：Anthropic 服务端工具（web_search / web_fetch）、prompt caching、thinking 块。
 */
import type {
  BetaMessage,
  BetaMessageParam,
  BetaToolUnion,
  MessageCreateParamsNonStreaming,
  BetaContentBlock,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type { LLM } from "./runtime.ts";
import { openaiUrl } from "./providers.ts";

type OAToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };
type OAMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string | ({ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } })[] }
  | { role: "assistant"; content: string | null; tool_calls?: OAToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

const textOf = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b) => (b && typeof b === "object" && (b as { type?: string }).type === "text" ? String((b as { text?: string }).text ?? "") : typeof b === "string" ? b : ""))
    .join("\n");
};

/** Anthropic 消息 → OpenAI 消息（tool_result 需要单独成一条 role=tool 的消息） */
export function toOpenAIMessages(params: MessageCreateParamsNonStreaming): OAMessage[] {
  const out: OAMessage[] = [];
  if (typeof params.system === "string" && params.system.trim()) out.push({ role: "system", content: params.system });
  for (const m of params.messages as BetaMessageParam[]) {
    const blocks = typeof m.content === "string" ? [{ type: "text", text: m.content }] : (m.content as { type: string; [k: string]: unknown }[]);
    if (m.role === "assistant") {
      const text = blocks.filter((b) => b.type === "text").map((b) => String(b.text ?? "")).join("\n");
      const calls = blocks.filter((b) => b.type === "tool_use").map((b) => ({ id: String(b.id), type: "function" as const, function: { name: String(b.name), arguments: JSON.stringify(b.input ?? {}) } }));
      out.push({ role: "assistant", content: text || null, ...(calls.length ? { tool_calls: calls } : {}) });
      continue;
    }
    // user：文本与图片合成一条，tool_result 各自成一条
    const texts: string[] = [];
    const images: { type: "image_url"; image_url: { url: string } }[] = [];
    for (const b of blocks) {
      if (b.type === "tool_result") out.push({ role: "tool", tool_call_id: String(b.tool_use_id), content: textOf(b.content) });
      else if (b.type === "text") texts.push(String(b.text ?? ""));
      else if (b.type === "image") {
        const src = (b as { source?: { type?: string; media_type?: string; data?: string } }).source;
        if (src?.type === "base64" && src.data) images.push({ type: "image_url", image_url: { url: `data:${src.media_type ?? "image/png"};base64,${src.data}` } });
        else texts.push("[图片]");
      }
    }
    if (images.length) out.push({ role: "user", content: [...(texts.length ? [{ type: "text" as const, text: texts.join("\n") }] : []), ...images] });
    else if (texts.length) out.push({ role: "user", content: texts.join("\n") });
  }
  return out;
}

/** 只保留自定义工具（有 name 与 input_schema）；服务端工具 OpenAI 协议没有对应物 */
export function toOpenAITools(tools: BetaToolUnion[] | undefined) {
  type Custom = { name: string; description?: string; input_schema?: Record<string, unknown> };
  const out: { type: "function"; function: { name: string; description: string; parameters: Record<string, unknown> } }[] = [];
  for (const raw of tools ?? []) {
    const t = raw as unknown as Custom;
    // 服务端工具（web_search / web_fetch）没有 name + input_schema，跳过
    if (typeof t?.name !== "string" || !t.input_schema) continue;
    out.push({ type: "function", function: { name: t.name, description: t.description ?? "", parameters: t.input_schema } });
  }
  return out;
}

export interface OpenAILLMOptions { baseUrl: string; apiKey: string; headers?: Record<string, string> }

export function openaiLLM(o: OpenAILLMOptions): LLM {
  return {
    async create(params, { signal }) {
      const body: Record<string, unknown> = {
        model: params.model,
        max_tokens: params.max_tokens,
        messages: toOpenAIMessages(params),
      };
      const tools = toOpenAITools(params.tools as BetaToolUnion[] | undefined);
      if (tools.length) body.tools = tools;
      const res = await fetch(openaiUrl(o.baseUrl, "/chat/completions"), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${o.apiKey}`,
          ...o.headers,
        },
        body: JSON.stringify(body),
        signal,
      });
      const text = await res.text();
      let json: Record<string, any>;
      try { json = JSON.parse(text); } catch { throw new Error(`模型服务返回非 JSON（HTTP ${res.status}）：${text.slice(0, 300)}`); }
      if (!res.ok || json.error) {
        const msg = json.error?.message ?? json.message ?? text.slice(0, 300);
        throw new Error(`模型服务错误（HTTP ${res.status}）：${msg}`);
      }
      const choice = json.choices?.[0];
      const msg = choice?.message ?? {};
      const content: BetaContentBlock[] = [];
      if (typeof msg.content === "string" && msg.content.trim()) content.push({ type: "text", text: msg.content } as BetaContentBlock);
      let hasTool = false;
      for (const c of msg.tool_calls ?? []) {
        hasTool = true;
        let input: unknown = {};
        try { input = JSON.parse(c.function?.arguments || "{}"); } catch { input = {}; }
        content.push({ type: "tool_use", id: c.id, name: c.function?.name, input } as BetaContentBlock);
      }
      if (!content.length) content.push({ type: "text", text: "" } as BetaContentBlock);
      const cached = json.usage?.prompt_tokens_details?.cached_tokens ?? 0;
      return {
        id: json.id ?? "oa",
        type: "message",
        role: "assistant",
        model: json.model ?? params.model,
        content,
        stop_reason: hasTool ? "tool_use" : choice?.finish_reason === "length" ? "max_tokens" : "end_turn",
        stop_details: null,
        usage: {
          input_tokens: Math.max(0, (json.usage?.prompt_tokens ?? 0) - cached),
          output_tokens: json.usage?.completion_tokens ?? 0,
          cache_read_input_tokens: cached,
          cache_creation_input_tokens: 0,
        },
      } as unknown as BetaMessage;
    },
  };
}

/** 列出 OpenAI 兼容服务的模型（GET /v1/models） */
export async function listOpenAIModels(baseUrl: string, apiKey: string, headers?: Record<string, string>): Promise<string[]> {
  const res = await fetch(openaiUrl(baseUrl, "/models"), {
    headers: { authorization: `Bearer ${apiKey}`, ...headers },
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  let json: { data?: { id: string }[]; error?: { message?: string } };
  try { json = JSON.parse(text); } catch { throw new Error(`模型服务返回非 JSON（HTTP ${res.status}）：${text.slice(0, 200)}`); }
  if (!res.ok || json.error) throw new Error(`模型服务错误（HTTP ${res.status}）：${json.error?.message ?? text.slice(0, 200)}`);
  return (json.data ?? []).map((m) => m.id).sort();
}
