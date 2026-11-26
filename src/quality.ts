/**
 * 需求质量评估：目标 / 验收标准 / 边界与异常 / 范围 / 可测性。
 * 规则打分，作为「是否需要先向人确认需求」的门禁；评分低于 60 会在需求理解阶段暂停提问。
 */
export interface Quality {
  score: number;
  dims: { name: string; ok: boolean; tip: string }[];
  criteria: string[];
  aiCriteria: boolean;
  questions: string[];
}

const QUESTIONS: Record<string, string> = {
  目标清晰: "这项工作最终要达成什么效果？",
  验收标准: "做到什么程度算完成？请列出 2–5 条可验证的标准",
  边界与异常: "失败、为空、超时等情况应该怎么处理？",
  范围: "涉及哪些页面或模块？有没有明确不做的部分？",
  可测性: "有没有具体数值，比如性能、数量、兼容的设备？",
};

const isBullet = (l: string) => /^[-*·•]|^\d+[.、)]/.test(l);
const stripBullet = (l: string) => l.replace(/^[-*·•]\s*|^\d+[.、)]\s*/, "");
/** 小节标题：【xxx】、## xxx、或单独一行以冒号结尾 */
const isHeading = (l: string) => /^【[^】]+】|^#{1,6}\s|^[^-*·•\d].{0,20}[：:]$/.test(l);
/**
 * 验收标准：描述里有「验收标准 / 验收条件 / Acceptance」小节时只取那一节的列表项，
 * 否则退回全文的列表项（老格式）。不分节时会把「要做的事」误当成验收标准。
 */
export function extractCriteria(desc: string): string[] {
  const lines = desc.split("\n").map((l) => l.trim());
  const start = lines.findIndex((l) => /验收(标准|条件)|acceptance criteria/i.test(l) && (isHeading(l) || /^【|^#|[：:]/.test(l)));
  if (start >= 0) {
    const out: string[] = [];
    for (const l of lines.slice(start + 1)) {
      if (!l) continue;
      if (isHeading(l) && !isBullet(l)) break;
      if (isBullet(l)) out.push(stripBullet(l));
    }
    if (out.length) return out;
  }
  return lines.filter(isBullet).map(stripBullet);
}

export function assessRequirement(i: { title: string; description?: string }): Quality {
  const desc = i.description ?? "";
  const d = `${i.title}\n${desc}`;
  const bullets = extractCriteria(desc);
  const hasCriteria = /验收|标准|应当|必须|需要满足/.test(d) && bullets.length >= 2;
  const dims = [
    { name: "目标清晰", ok: i.title.length >= 4, tip: "一句话说明要达成什么" },
    { name: "验收标准", ok: hasCriteria, tip: "列出可逐条验证的标准" },
    { name: "边界与异常", ok: /异常|失败|错误|超时|边界|为空|最多|最少|兼容|上限/.test(d), tip: "失败、为空、超时等情况怎么处理" },
    { name: "范围", ok: /范围|不包括|仅|只|页面|模块|接口|字段|列/.test(d), tip: "改哪些地方、不改哪些地方" },
    { name: "可测性", ok: /\d/.test(desc) || hasCriteria, tip: "有具体数值或可观察的结果" },
  ];
  const w = [15, 35, 20, 15, 15];
  const score = Math.min(100, Math.round(dims.reduce((s, x, n) => s + (x.ok ? w[n] : 0), 0) + Math.min(10, desc.length / 20)));
  const criteria = hasCriteria ? bullets.slice(0, 10) : [`${i.title.replace(/[：:].*$/, "")}的主流程可以正常完成`, "异常输入或失败时有明确提示", "页面无控制台报错，关键接口无 5xx"];
  return { score, dims, criteria, aiCriteria: !hasCriteria, questions: dims.filter((x) => !x.ok).map((x) => QUESTIONS[x.name]) };
}
