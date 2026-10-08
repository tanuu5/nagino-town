// usage から費用を計算する（config/pricing.json の単価、100万トークンあたり USD）
import { round6 } from "../util.js";

function tierFor(pricing, model, promptTokens) {
  const m = pricing.models[model];
  if (!m) throw new Error(`料金表にないモデル: ${model}`);
  for (const t of m.tiers) {
    if (t.max_prompt_tokens == null || promptTokens <= t.max_prompt_tokens) return t;
  }
  return m.tiers[m.tiers.length - 1];
}

/** API の usage から実際の費用を計算する */
export function costFromUsage(pricing, model, usage) {
  const input = usage.input_tokens || 0;
  const output = usage.output_tokens || 0;
  const cacheRead = usage.cache_read_input_tokens || 0;
  const cacheCreate = usage.cache_creation_input_tokens || 0;
  let cw5 = cacheCreate;
  let cw1h = 0;
  if (usage.cache_creation && typeof usage.cache_creation === "object") {
    cw5 = usage.cache_creation.ephemeral_5m_input_tokens || 0;
    cw1h = usage.cache_creation.ephemeral_1h_input_tokens || 0;
    // 内訳の合計が合わないときは、多い方（全体）を 5 分として数える
    if (cw5 + cw1h < cacheCreate) cw5 = cacheCreate - cw1h;
  }
  const prompt = input + cacheRead + cacheCreate;
  const t = tierFor(pricing, model, prompt);
  const usd =
    (input * t.input + output * t.output + cacheRead * t.cache_read + cw5 * t.cache_write_5m + cw1h * t.cache_write_1h) / 1e6;
  return { usd: round6(usd), promptTokens: prompt, tierMax: t.max_prompt_tokens };
}

/** 送る前の最悪の費用（キャッシュが効かず、max_tokens いっぱいに出力した場合） */
export function worstCaseCost(pricing, model, estInputTokens, maxTokens) {
  const t = tierFor(pricing, model, estInputTokens);
  // キャッシュ書き込みは入力より高いので、入力全部が書き込みになった場合で数える
  const inRate = Math.max(t.input, t.cache_write_5m);
  return round6((estInputTokens * inRate + maxTokens * t.output) / 1e6);
}
