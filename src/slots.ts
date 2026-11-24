/**
 * 按优先级排队的并发槽位：上限可在运行时调整；槽位释放时先唤醒优先级高的等待者，
 * 同优先级按到达顺序。等待期间可被 AbortSignal 取消。
 */
import { priorityRank } from "./priority.ts";

interface Waiter { rank: number; seq: number; wake: () => void; fail: (e: Error) => void }

export class PrioritySlots {
  private active = 0;
  private seq = 0;
  private queue: Waiter[] = [];
  private limit: () => number;
  constructor(limit: number | (() => number)) {
    this.limit = typeof limit === "function" ? limit : () => limit;
  }
  get running() { return this.active; }
  get waiting() { return this.queue.length; }

  /** 取得一个槽位，返回释放函数（多次调用只释放一次） */
  async acquire(priority = 0, signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) throw new Error("已取消");
    if (this.active >= Math.max(1, this.limit()) || this.queue.length) {
      await new Promise<void>((wake, fail) => {
        const w: Waiter = { rank: priorityRank(priority), seq: this.seq++, wake, fail };
        this.queue.push(w);
        this.queue.sort((a, b) => a.rank - b.rank || a.seq - b.seq);
        signal?.addEventListener("abort", () => {
          const i = this.queue.indexOf(w);
          if (i >= 0) { this.queue.splice(i, 1); fail(new Error("已取消")); }
        }, { once: true });
        this.pump();
      });
    }
    this.active++;
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.active--;
      this.pump();
    };
  }

  async run<T>(fn: () => Promise<T>, priority = 0, signal?: AbortSignal): Promise<T> {
    const release = await this.acquire(priority, signal);
    try { return await fn(); } finally { release(); }
  }

  /** 上限调大后立即唤醒等待者 */
  pump() {
    while (this.queue.length && this.active + this.pending < Math.max(1, this.limit())) {
      const w = this.queue.shift()!;
      this.pending++;
      queueMicrotask(() => { this.pending--; w.wake(); });
    }
  }
  private pending = 0;
}
