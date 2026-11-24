/**
 * 模型供应商：两种协议 + 常见厂商预设。
 * - anthropic：Anthropic Messages API（官方或兼容端点，如 DeepSeek / Kimi / 智谱的 Anthropic 兼容地址）
 * - openai：OpenAI Chat Completions（官方或兼容端点，覆盖 DeepSeek、通义、Kimi、智谱、豆包、硅基流动、OpenRouter、Ollama、vLLM 等）
 */
export type ProviderType = "anthropic" | "openai";

export interface ProviderPreset {
  /** 预设标识，同时作为新建连接时的默认名称 */
  key: string;
  name: string;
  type: ProviderType;
  baseUrl: string;
  /** 申请 Key 的地址 */
  docs?: string;
  /** 该协议下的注意事项 */
  note?: string;
}

export const PRESETS: ProviderPreset[] = [
  { key: "anthropic", name: "Anthropic（官方）", type: "anthropic", baseUrl: "https://api.anthropic.com", docs: "https://platform.claude.com", note: "需要 Claude API Key；使用服务器上的 ant 登录凭据时可留空" },
  { key: "deepseek-anthropic", name: "DeepSeek（Anthropic 兼容）", type: "anthropic", baseUrl: "https://api.deepseek.com/anthropic", docs: "https://platform.deepseek.com" },
  { key: "moonshot-anthropic", name: "Kimi / 月之暗面（Anthropic 兼容）", type: "anthropic", baseUrl: "https://api.moonshot.cn/anthropic", docs: "https://platform.moonshot.cn" },
  { key: "zhipu-anthropic", name: "智谱 GLM（Anthropic 兼容）", type: "anthropic", baseUrl: "https://open.bigmodel.cn/api/anthropic", docs: "https://open.bigmodel.cn" },
  { key: "dashscope-anthropic", name: "通义千问（Anthropic 兼容）", type: "anthropic", baseUrl: "https://dashscope.aliyuncs.com/apps/anthropic", docs: "https://bailian.console.aliyun.com" },
  { key: "openai", name: "OpenAI（官方）", type: "openai", baseUrl: "https://api.openai.com/v1", docs: "https://platform.openai.com" },
  { key: "deepseek", name: "DeepSeek", type: "openai", baseUrl: "https://api.deepseek.com/v1", docs: "https://platform.deepseek.com" },
  { key: "moonshot", name: "Kimi / 月之暗面", type: "openai", baseUrl: "https://api.moonshot.cn/v1", docs: "https://platform.moonshot.cn" },
  { key: "zhipu", name: "智谱 GLM", type: "openai", baseUrl: "https://open.bigmodel.cn/api/paas/v4", docs: "https://open.bigmodel.cn" },
  { key: "dashscope", name: "通义千问 / 百炼", type: "openai", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", docs: "https://bailian.console.aliyun.com" },
  { key: "ark", name: "豆包 / 火山方舟", type: "openai", baseUrl: "https://ark.cn-beijing.volces.com/api/v3", docs: "https://console.volcengine.com/ark" },
  { key: "siliconflow", name: "硅基流动", type: "openai", baseUrl: "https://api.siliconflow.cn/v1", docs: "https://cloud.siliconflow.cn" },
  { key: "minimax", name: "MiniMax", type: "openai", baseUrl: "https://api.minimax.chat/v1", docs: "https://platform.minimaxi.com" },
  { key: "openrouter", name: "OpenRouter", type: "openai", baseUrl: "https://openrouter.ai/api/v1", docs: "https://openrouter.ai" },
  { key: "gemini", name: "Gemini（OpenAI 兼容）", type: "openai", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", docs: "https://aistudio.google.com" },
  { key: "ollama", name: "Ollama（本地）", type: "openai", baseUrl: "http://127.0.0.1:11434/v1", note: "本机推理，Key 可随意填写" },
  { key: "vllm", name: "vLLM / 自建服务", type: "openai", baseUrl: "http://127.0.0.1:8000/v1", note: "自建 OpenAI 兼容服务，Key 按部署要求填写" },
  { key: "custom", name: "自定义", type: "openai", baseUrl: "", note: "填写完整的 Base URL，需包含版本路径（如以 /v1 结尾）" },
];

/** 去掉末尾斜杠；anthropic 协议若填了 /v1 也兼容（SDK 会自己补） */
export function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

/** 拼接 OpenAI 兼容端点的路径，避免重复 /v1 */
export function openaiUrl(baseUrl: string, path: string): string {
  const base = normalizeBaseUrl(baseUrl);
  return `${base}${base.endsWith("/v1") ? "" : "/v1"}${path}`;
}
