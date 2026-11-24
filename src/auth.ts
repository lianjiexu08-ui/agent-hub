/**
 * 访问控制：账号登录（用户名 + 密码），签发 HttpOnly 会话 Cookie。
 * - 仍兼容 API 调用方的 Authorization: Bearer <token> 与 ?token=（MCP / 脚本用）
 * - 会话签名用服务器端的密钥，改密码后旧会话立即失效
 * - 登录失败按来源地址限速，避免被暴力猜
 */
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE = "hub_session";
const SESSION_TTL_MS = 7 * 24 * 3600_000;

export interface Security {
  /** 账号密码登录；不设置时不启用登录 */
  user: string;
  password: string;
  /** API 令牌（Bearer / ?token=），与登录并存 */
  token?: string;
}

export const loginEnabled = (s?: Security | null): s is Security => !!s?.password;

const b64 = (s: string) => Buffer.from(s).toString("base64url");
const sign = (payload: string, secret: string) => createHmac("sha256", secret).update(payload).digest("base64url");

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** 签发会话：payload 带用户名与到期时间，整体做 HMAC */
export function issueSession(user: string, secret: string, ttlMs = SESSION_TTL_MS): string {
  const payload = b64(JSON.stringify({ u: user, exp: Date.now() + ttlMs, n: randomUUID().slice(0, 8) }));
  return `${payload}.${sign(payload, secret)}`;
}

/** 校验会话：签名正确且未过期 */
export function verifySession(cookie: string | null | undefined, secret: string): { user: string; exp: number } | null {
  if (!cookie) return null;
  const value = cookie.startsWith(`${SESSION_COOKIE}=`) ? cookie.slice(SESSION_COOKIE.length + 1).split(";")[0] : cookie;
  const [payload, mac] = value.split(".");
  if (!payload || !mac) return null;
  if (!safeEqual(mac, sign(payload, secret))) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { u?: string; exp?: number };
    if (!data.u || !data.exp || data.exp < Date.now()) return null;
    return { user: data.u, exp: data.exp };
  } catch {
    return null;
  }
}

/** 校验账号密码；两者都用常量时间比较 */
export function checkPassword(input: { user?: string; password?: string }, s: Security): boolean {
  const user = (input.user ?? "").trim();
  const pass = input.password ?? "";
  return safeEqual(user, s.user) && safeEqual(pass, s.password);
}

export function sessionCookie(value: string, ttlMs = SESSION_TTL_MS): string {
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(ttlMs / 1000)}`;
}
export const clearedCookie = () => `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;

/** 读取请求里的会话 cookie */
export function cookieOf(header: string | undefined | null): string | null {
  if (!header) return null;
  const hit = header.split(";").map((x) => x.trim()).find((x) => x.startsWith(`${SESSION_COOKIE}=`));
  return hit ?? null;
}

/** 简单的登录限速：同一来源 5 分钟内连续失败 5 次，锁 60 秒 */
export class LoginThrottle {
  private hits = new Map<string, { n: number; firstAt: number; until: number }>();
  blocked(key: string): number {
    const h = this.hits.get(key);
    if (!h?.until || h.until <= Date.now()) return 0;
    return Math.ceil((h.until - Date.now()) / 1000);
  }
  fail(key: string) {
    const now = Date.now();
    let h = this.hits.get(key);
    // 过了锁定期或超过统计窗口就重新计数
    if (!h || (h.until && h.until <= now) || now - h.firstAt > 5 * 60_000) h = { n: 0, firstAt: now, until: 0 };
    h.n += 1;
    if (h.n >= 5) { h.until = now + 60_000; h.n = 0; h.firstAt = now; }
    this.hits.set(key, h);
  }
  ok(key: string) { this.hits.delete(key); }
}
