/**
 * 演示模式（HUB_SIMULATE=1）的脚本化模型：不需要 API Key，就能看到完整流程。
 * - 工作项运行：依次调用 report_phase 推进生命周期；第 1 轮评审有一定概率不通过，演示返工
 * - 测试运行：逐条 report_case
 * - 其他：直接给出简短结论
 * 它走的是真实的服务端逻辑，只有「模型的回复」是脚本化的。
 */
import type { BetaMessage, BetaMessageParam, MessageCreateParamsNonStreaming } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type { LLM } from "./runtime.ts";

let seq = 0;
const lastToolResult = (messages: BetaMessageParam[]): string | null => {
  const last = messages.at(-1);
  if (!last || last.role !== "user" || typeof last.content === "string") return null;
  const r = (last.content as { type: string; content?: unknown }[]).filter((b) => b.type === "tool_result").at(-1);
  if (!r) return null;
  return typeof r.content === "string" ? r.content : JSON.stringify(r.content);
};
const firstUser = (messages: BetaMessageParam[]) => { const m = messages[0]; return typeof m?.content === "string" ? m.content : ""; };
const NOTES: Record<string, string[]> = {
  understand: ["明确目标与验收标准，没有待确认项", "梳理出 3 条验收标准与 1 个边界情况"],
  plan: ["拆成 4 个步骤：调研现状 → 实现 → 自测 → 整理交付", "先改核心逻辑，再补测试与说明"],
  do: ["按计划完成主要产出，附关键依据", "完成改动并自测通过"],
  review: ["对照验收标准逐条自查，全部满足", "满足全部验收标准"],
};
const pick = <T>(a: T[]) => a[Math.floor(Math.random() * a.length)];

export function simulatedLLM(opts: { delayMs?: [number, number]; reviewFailRate?: number } = {}): LLM {
  const [lo, hi] = opts.delayMs ?? [900, 2200];
  const reviewFailRate = opts.reviewFailRate ?? 0.35;
  return {
    async create(params: MessageCreateParamsNonStreaming, { signal }) {
      await new Promise<void>((res, rej) => {
        const t = setTimeout(res, lo + Math.random() * (hi - lo));
        signal.addEventListener("abort", () => { clearTimeout(t); rej(new Error("aborted")); }, { once: true });
      });
      const tools = new Set((params.tools ?? []).map((t) => ("name" in t ? t.name : "")));
      const msgs = params.messages;
      const res = lastToolResult(msgs);
      const lastUser = msgs.at(-1);
      const content: unknown[] = [];
      const call = (name: string, input: unknown) => content.push({ type: "tool_use", id: `toolu_sim_${++seq}`, name, input });
      const say = (text: string) => content.push({ type: "text", text });

      if (tools.has("report_phase")) {
        const text = res ?? (typeof lastUser?.content === "string" ? lastUser.content : "");
        const m = /进入「(需求理解|计划|执行|评审)」|当前阶段是「(需求理解|计划|执行|评审)」|report_phase\(phase="(\w+)"\)|回到「执行」|重新理解需求/.exec(text);
        if (/生命周期完成/.test(text)) say(`## 交付\n\n- 已按描述与验收标准完成「${/工作项 \S+：(.+)/.exec(firstUser(msgs))?.[1] ?? "本工作项"}」\n- 关键结论与验证方式见各阶段记录\n\n（演示模式：模型回复为脚本生成）`);
        else {
          const map: Record<string, string> = { 需求理解: "understand", 计划: "plan", 执行: "do", 评审: "review" };
          let phase = m?.[1] ? map[m[1]] : m?.[2] ? map[m[2]] : m?.[3] ?? (/回到「执行」/.test(text) ? "do" : "understand");
          if (/已记录 understand|已记录「需求理解」/.test(text)) phase = "plan";
          const cycle2 = msgs.filter((x) => x.role === "user" && JSON.stringify(x.content).includes("开始第")).length;
          const fail = phase === "review" && cycle2 === 0 && Math.random() < reviewFailRate;
          say(phase === "do" && /测试未通过/.test(text) ? "根据测试反馈修复问题。" : `完成「${phase}」。`);
          call("report_phase", { phase, result: fail ? "fail" : "pass", note: fail ? pick(["结论缺少量化依据", "遗漏了一项验收标准"]) : pick(NOTES[phase] ?? ["完成"]) });
        }
      } else if (tools.has("report_case")) {
        const ids = [...firstUser(msgs).matchAll(/- (\w+)：/g)].map((x) => x[1]);
        const done = msgs.filter((x) => x.role === "assistant").length;
        if (done < ids.length) call("report_case", { case_id: ids[done], status: "passed", note: "按用例执行，结果符合预期" });
        else say("全部用例已执行完毕。");
      } else say(`（演示模式）已完成：${firstUser(msgs).split("\n")[0].slice(0, 60)}`);

      return { id: `msg_sim_${seq}`, type: "message", role: "assistant", model: params.model, content, stop_reason: content.some((b) => (b as { type: string }).type === "tool_use") ? "tool_use" : "end_turn", stop_details: null, usage: { input_tokens: 1800 + Math.floor(Math.random() * 1500), output_tokens: 200 + Math.floor(Math.random() * 400) } } as unknown as BetaMessage;
    },
  };
}
