/**
 * 网络 / 服务端抖动类错误：连接超时、连接被重置、DNS 临时失败、网关 5xx、限流、模型过载。
 * 这类错误重试大概率就好，不该让一次运行失败、更不该让工作项从头再来。
 */
const TRANSIENT = /timed? ?out|timeout|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|EPIPE|socket hang up|UND_ERR|fetch failed|network|concurren(?:t|cy) (?:request )?limit|overloaded|rate.?limit|too many requests|\b(429|500|502|503|504|529)\b/i;

/** 订阅 / 接口额度用完（如「5 小时额度」）：要等到恢复时间，短间隔重试没用，交给工作项层面「等额度恢复后续跑」 */
const QUOTA = /usage limit|quota|limit (?:reached|exceeded)|额度|限额/i;

export function isTransientError(e: unknown): boolean {
  const err = e as { name?: string; status?: number; message?: string; cause?: { code?: string; message?: string } } | string | null | undefined;
  if (!err) return false;
  if (typeof err === "string") return TRANSIENT.test(err) && !QUOTA.test(err);
  if (err.name === "AbortError") return false; // 人主动停止
  if (QUOTA.test(err.message ?? "")) return false;
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

/**
 * 运行失败是不是模型订阅 / 接口的额度用完了（5 小时额度、限流等）。是的话返回预计恢复的时间，否则 null。
 * 认得的写法：「reset at 2026-11-26 16:16:42」（无时区按本机时间）、ISO 时间、「limit reached|<unix 秒>」（Claude Code）、
 * 「try again in 30 minutes / 45s」「resets in 2h」；认出是额度问题但没给时间时，按 15 分钟后再试。
 */
export function quotaReset(error: string | null | undefined, failedAt: Date = new Date()): Date | null {
  const e = error ?? "";
  if (!/usage limit|rate.?limit|quota|limit (?:reached|exceeded)|too many requests|\b429\b|额度|限额|限流/i.test(e)) return null;
  const at = e.match(/reset(?:s)? (?:at|on)\s*:?\s*(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)/i);
  if (at) { const d = new Date(at[1].replace(" ", "T")); if (!isNaN(+d)) return d; }
  const epoch = e.match(/limit reached\|(\d{10})/i);
  if (epoch) return new Date(Number(epoch[1]) * 1000);
  const rel = e.match(/(?:try again|retry|reset(?:s)?) in (?:about )?(\d+(?:\.\d+)?)\s*(h|hours?|m|min(?:ute)?s?|s|sec(?:ond)?s?)\b/i);
  if (rel) { const n = Number(rel[1]); const unit = rel[2][0].toLowerCase(); return new Date(+failedAt + n * (unit === "h" ? 3_600_000 : unit === "m" ? 60_000 : 1000)); }
  return new Date(+failedAt + 15 * 60_000);
}

/**
 * 是不是「这个模型 / 厂商现在用不了」：额度用完、并发超限、鉴权失败、网络或服务端故障（CLI 自己已经重试过了）。
 * 这类失败换一个底座或模型就能继续；任务本身的问题（测试不过、需求不清、超过轮数）不算。
 */
export function providerDown(error: string | null | undefined): boolean {
  const e = error ?? "";
  return !!quotaReset(e) || isTransientError(e) || /\b(401|403)\b|unauthori[sz]ed|forbidden|access_terminated|authentication|invalid.{0,20}api.?key|api.?key.{0,20}invalid|not logged in|please run .{0,20}login|credit balance/i.test(e);
}

/** 用不了的模型多久内不再派活：额度按预计恢复时间，其他情况先避开几分钟 */
export function downUntil(error: string | null | undefined, now = new Date()): number {
  const q = quotaReset(error, now);
  if (q) return +q;
  if (/concurren(?:t|cy) (?:request )?limit/i.test(error ?? "")) return +now + 2 * 60_000;
  if (isTransientError(error)) return +now + 3 * 60_000;
  return +now + 30 * 60_000; // 鉴权类：要人处理，半小时内别再用
}
