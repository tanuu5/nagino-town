// 住人の記憶。埋め込みは使わず、重要度・新しさ・いまの相手や場所との関係で選ぶ。
import { cleanText, clamp, minToHhmm } from "../util.js";

let nextId = 1;

/** 記憶の出どころを文にする */
export function sourceLabel(src) {
  switch (src.type) {
    case "self":
      return "自分で見た";
    case "heard":
      return `${src.from}から聞いた`;
    case "talk":
      return `${src.from}との会話`;
    case "overheard":
      return "立ち聞き";
    case "thought":
      return "自分で考えた";
    case "reflection":
      return "振り返り";
    case "letter":
      return "手紙";
    case "news":
      return "新聞";
    default:
      return "?";
  }
}

export function addMemory(res, { day, minute, text, importance, source, kind = "memory" }, limits) {
  const item = {
    id: nextId++,
    day,
    minute,
    abs: (day - 1) * 1440 + minute,
    text: cleanText(text, limits.max_text_chars),
    importance: clamp(Math.round(Number(importance) || 1), 1, 10),
    source,
    kind,
  };
  if (!item.text) return null;
  res.memory.push(item);
  forget(res);
  return item;
}

/** 上限を超えたら、重要度が低く古いものから忘れる */
function forget(res) {
  const limit = res.memoryLimit;
  if (res.memory.length <= limit) return;
  const sorted = res.memory.slice().sort((a, b) => a.importance - b.importance || a.abs - b.abs);
  const drop = new Set(sorted.slice(0, res.memory.length - limit).map((m) => m.id));
  res.forgotten += drop.size;
  res.memory = res.memory.filter((m) => !drop.has(m.id));
}

/**
 * 呼び出しに渡す記憶を選ぶ。
 * score = 重要度 + 新しさ（半減期） + 関係（いまの場所・居合わせた人の名前を含む）
 */
export function retrieve(res, { nowAbs, place, people }, k, w, aliases) {
  const keys = [place, ...people.flatMap((n) => aliases[n] || [n])].filter(Boolean);
  const scored = res.memory.map((m) => {
    const ageH = Math.max(0, (nowAbs - m.abs) / 60);
    const recency = Math.pow(0.5, ageH / w.recency_half_life_hours);
    const rel = keys.some((key) => m.text.includes(key)) ? 1 : 0;
    const score = w.weight_importance * (m.importance / 10) + w.weight_recency * recency + w.weight_relevance * rel;
    return { m, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored
    .slice(0, k)
    .map((s) => s.m)
    .sort((a, b) => a.abs - b.abs);
}

export function formatMemory(m, dayStartMin) {
  return `[${m.day}日目 ${minToHhmm(m.minute)}] ${m.text}（${sourceLabel(m.source)}）`;
}

/** 人物カード用：重要度と新しさの上位 n 件 */
export function topForCard(res, n, nowAbs) {
  return res.memory
    .map((m) => ({ m, s: m.importance / 10 + Math.pow(0.5, Math.max(0, nowAbs - m.abs) / 60 / 6) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, n)
    .map(({ m }) => ({ day: m.day, time: minToHhmm(m.minute), text: m.text, importance: m.importance, source: sourceLabel(m.source) }));
}
