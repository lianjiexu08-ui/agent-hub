/** 每百万 tokens 的美元价格（输入 / 输出），用于估算花费与预算控制 */
const PRICES: Record<string, [number, number]> = {
  "claude-fable-5-2": [8, 40],
  "claude-opus-5-5": [4, 20],
  "claude-opus-5": [5, 25],
  "claude-sonnet-5-5": [2, 10],
  "claude-haiku-5-5": [0.1, 0.5],
};

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

export function costOf(model: string, u: Usage): number {
  const [i, o] = PRICES[model] ?? [4, 20];
  const cacheRead = u.cache_read_input_tokens ?? 0;
  const cacheWrite = u.cache_creation_input_tokens ?? 0;
  return (u.input_tokens * i + cacheRead * i * 0.1 + cacheWrite * i * 1.25 + u.output_tokens * o) / 1_000_000;
}
