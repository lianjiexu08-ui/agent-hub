/**
 * 账号凭证：部署时用环境变量（HUB_USER / HUB_PASSWORD）作为初始密码，
 * 用户在首次登录后可以自己设置账号与密码，设置后写到 data/auth.json 并优先于环境变量。
 *
 * - 只存 scrypt 哈希与随机盐，不存明文
 * - 同时存一个随机会话密钥：改密码就换密钥，旧会话立即失效
 * - 忘记密码时删掉 auth.json 即可退回环境变量里的初始密码
 */
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface CredentialsData {
  user: string;
  salt: string;
  hash: string;
  /** 会话签名密钥，与密码分开存，改密码时重新生成 */
  secret: string;
  updatedAt: string;
}

const KEY_LEN = 32;
const hashOf = (password: string, salt: string) => scryptSync(password, salt, KEY_LEN);

export class Credentials {
  readonly file: string;
  private data: CredentialsData | null = null;
  constructor(file: string) {
    this.file = file;
    try {
      if (existsSync(file)) {
        const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<CredentialsData>;
        if (raw.user && raw.salt && raw.hash && raw.secret) this.data = raw as CredentialsData;
      }
    } catch {
      // 文件损坏时当作未初始化，仍可用环境变量的初始密码登录后重新设置
      this.data = null;
    }
  }
  /** 用户是否已经自己设置过账号密码 */
  get initialized() { return !!this.data; }
  get user() { return this.data?.user ?? null; }
  get secret() { return this.data?.secret ?? null; }

  verify(user: string, password: string): boolean {
    if (!this.data || !password) return false;
    const a = Buffer.from(hashOf(password, this.data.salt));
    const b = Buffer.from(this.data.hash, "hex");
    const sameUser = Buffer.from(user) .equals(Buffer.from(this.data.user));
    return sameUser && a.length === b.length && timingSafeEqual(a, b);
  }

  set(user: string, password: string): CredentialsData {
    const salt = randomBytes(16).toString("hex");
    const data: CredentialsData = {
      user,
      salt,
      hash: hashOf(password, salt).toString("hex"),
      secret: randomBytes(32).toString("hex"),
      updatedAt: new Date().toISOString(),
    };
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(data, null, 2), { mode: 0o600 });
    this.data = data;
    return data;
  }
}
