/**
 * 模型路由：按模型条目找到它所属的连接，选择对应的协议实现。
 * - anthropic：Anthropic SDK（官方或兼容端点）
 * - openai：OpenAI 兼容的 Chat Completions
 * 上层（运行时、管家、测试）只依赖 LLM 接口，传入的是「模型条目 id」。
 */
import Anthropic from "@anthropic-ai/sdk";
import type { LLM } from "./runtime.ts";
import type { Settings } from "./settings.ts";
import { openaiLLM } from "./openai.ts";

export function makeLLM(settings: Settings): LLM {
  return {
    async create(params, opts) {
      const entry = settings.modelEntry(params.model);
      const providers = settings.get().providers;
      const provider = providers.find((p) => p.id === entry?.providerId) ?? providers.find((p) => p.type === "anthropic" && p.verifiedAt) ?? providers[0];
      const model = entry?.modelId ?? params.model;
      if (provider?.type === "openai") {
        const key = settings.providerKey(provider.id) ?? "";
        if (!key) throw new Error(`连接「${provider.name}」还没有配置 API Key`);
        return openaiLLM({ baseUrl: provider.baseUrl || "https://api.openai.com/v1", apiKey: key }).create({ ...params, model }, opts);
      }
      // Anthropic：有 Key 用 Key，否则交给 SDK 读取环境变量或本机登录凭据
      const apiKey = provider ? settings.providerKey(provider.id) : null;
      const client = new Anthropic({ ...(apiKey ? { apiKey } : {}), ...(provider?.baseUrl && provider.baseUrl !== "https://api.anthropic.com" ? { baseURL: provider.baseUrl } : {}) });
      return client.beta.messages.create({ ...params, model }, opts);
    },
  };
}

/** 探测连接可用性并返回可用模型列表 */
export async function probeProvider(p: { type: "anthropic" | "openai"; baseUrl: string }, key: string | null): Promise<string[]> {
  if (p.type === "openai") {
    const { listOpenAIModels } = await import("./openai.ts");
    return listOpenAIModels(p.baseUrl, key ?? "");
  }
  const client = new Anthropic({ ...(key ? { apiKey: key } : {}), ...(p.baseUrl && p.baseUrl !== "https://api.anthropic.com" ? { baseURL: p.baseUrl } : {}) });
  const page = await client.models.list({ limit: 50 });
  return page.data.map((m) => m.id);
}
