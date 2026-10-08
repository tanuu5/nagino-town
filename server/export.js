// ログを Markdown にする（記事の素材用）
const KIND = {
  say: "発言",
  action: "行動",
  fail: "失敗",
  event: "出来事",
  heaven: "天の声",
  meeting: "集会",
  vote: "投票",
  reflection: "振り返り",
  news: "新聞",
  thought: "内心",
  system: "—",
};

export function logMarkdown(cfg, logs, runId) {
  const short = Object.fromEntries(cfg.characters.residents.map((r) => [r.name, r.short]));
  const L = [`# 凪野町ログ（run ${runId}）`, "", "AI だけの街シミュレーションの記録です。「内心」は口に出していない本音です。", ""];
  let day = null;
  for (const e of logs) {
    if (e.day !== day) {
      day = e.day;
      L.push("", `## ${day}日目`, "");
    }
    const who = e.who ? `【${short[e.who] || e.who}${e.to ? `→${short[e.to] || e.to}` : ""}】` : "";
    const body = e.kind === "say" || (e.kind === "meeting" && e.who) ? `「${e.text}」` : e.text;
    let line = `- ${e.time} ${KIND[e.kind] || e.kind} ${who}${body}`;
    if (e.thought) line += `（内心：${e.thought}）`;
    L.push(line);
  }
  L.push("");
  return L.join("\n");
}
