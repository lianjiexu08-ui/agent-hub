/**
 * 工作项优先级：0 无 · 1 紧急 · 2 高 · 3 中 · 4 低（与 Linear 一致）。
 *
 * 调度统一按 rank 升序：紧急 → 高 → 中 → 低 → 无。
 * 运行槽位、测试队列、负责人分诊、任务中心展示都用这一套顺序。
 */
export const priorityRank = (p: number | null | undefined): number =>
  typeof p === "number" && p >= 1 && p <= 4 ? p : 5;

/** Array.sort 用：高优先级在前；同优先级由调用方再按时间等条件排序 */
export const byPriority = (a: { priority?: number | null }, b: { priority?: number | null }): number =>
  priorityRank(a.priority) - priorityRank(b.priority);
