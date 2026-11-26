/**
 * 网络 / 服务端抖动类错误：连接超时、连接被重置、DNS 临时失败、网关 5xx、限流、模型过载。
 * 这类错误重试大概率就好，不该让一次运行失败、更不该让工作项从头再来。
 */
const TRANSIENT = /timed? ?out|timeout|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|EPIPE|socket hang up|UND_ERR|fetch failed|network|overloaded|rate.?limit|too many requests|\b(429|500|502|503|504|529)\b/i;

export function isTransientError(e: unknown): boolean {
  const err = e as { name?: string; status?: number; message?: string; cause?: { code?: string; message?: string } } | string | null | undefined;
  if (!err) return false;
  if (typeof err === "string") return TRANSIENT.test(err);
  if (err.name === "AbortError") return false; // 人主动停止
  if (typeof err.status === "number" && [408, 429, 500, 502, 503, 504, 529].includes(err.status)) return true;
  return TRANSIENT.test(`${err.message ?? ""} ${err.cause?.code ?? ""} ${err.cause?.message ?? ""}`);
}

/** 第 n 次重试前等多久：5s、15s、30s、60s、120s、180s…（封顶 3 分钟） */
export const backoffMs = (n: number) => [5, 15, 30, 60, 120][n] ?? 180;

/** 可被中止的等待 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((res, rej) => {
    if (signal?.aborted) return rej(Object.assign(new Error("aborted"), { name: "AbortError" }));
    const t = setTimeout(res, ms);
    signal?.addEventListener("abort", () => { clearTimeout(t); rej(Object.assign(new Error("aborted"), { name: "AbortError" })); }, { once: true });
  });
}
