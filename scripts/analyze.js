// run の記録（llm_calls.jsonl・events.jsonl）を集計する。
// 使い方：npm run analyze -- 20261008-225744   （run 名を省くと最新の run）
import fs from "node:fs";
import path from "node:path";
import { RUNS_DIR } from "../server/paths.js";
import { RUN_ID_RE } from "../server/record.js";

let runId = process.argv[2];
if (!runId) {
  runId = fs
    .readdirSync(RUNS_DIR)
    .filter((d) => RUN_ID_RE.test(d) && fs.existsSync(path.join(RUNS_DIR, d, "llm_calls.jsonl")))
    .sort()
    .pop();
}
if (!runId || !RUN_ID_RE.test(runId)) {
  console.error("run 名を YYYYMMDD-HHMMSS の形で指定してください");
  process.exit(1);
}
const dir = path.join(RUNS_DIR, runId);
const readJsonl = (f) =>
  fs.existsSync(f)
    ? fs
        .readFileSync(f, "utf8")
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l))
    : [];
const calls = readJsonl(path.join(dir, "llm_calls.jsonl"));
const events = readJsonl(path.join(dir, "events.jsonl"));
const meta = JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf8"));

const pct = (a, b) => (b ? `${((a / b) * 100).toFixed(1)}%` : "—");
const usd = (x) => `$${x.toFixed(4)}`;

function summarize(list) {
  const s = { sends: list.length, invalidSends: 0, requests: 0, firstOk: 0, retryOk: 0, failed: 0, refusals: 0, apiErrors: 0, input: 0, cacheWrite: 0, cacheRead: 0, output: 0, cost: 0, ms: 0, est: 0, actual: 0, withUsage: 0 };
  for (const c of list) {
    if (!c.valid) s.invalidSends++;
    if (c.attempt === 1) {
      s.requests++;
      if (c.valid) s.firstOk++;
    } else if (c.valid) s.retryOk++;
    else s.failed++;
    if (c.stop_reason === "refusal") s.refusals++;
    if (!c.usage && c.mode === "real") s.apiErrors++;
    if (c.usage) {
      s.withUsage++;
      s.input += c.usage.input_tokens;
      s.cacheWrite += c.usage.cache_creation_input_tokens;
      s.cacheRead += c.usage.cache_read_input_tokens;
      s.output += c.usage.output_tokens;
      s.est += c.est_input_tokens;
      s.actual += c.usage.input_tokens + c.usage.cache_creation_input_tokens + c.usage.cache_read_input_tokens;
    }
    s.cost += c.cost_usd || 0;
    s.ms += c.duration_ms || 0;
  }
  return s;
}

const roles = [...new Set(calls.map((c) => c.role))];
const rows = [["役割", "論理", "送信", "検証の失敗（送信あたり）", "最終的な失敗→wait", "キャッシュのヒット率", "入力", "書き込み", "読み込み", "出力", "費用", "平均の所要"]];
const all = summarize(calls);
for (const r of [...roles, "（合計）"]) {
  const s = r === "（合計）" ? all : summarize(calls.filter((c) => c.role === r));
  const prompt = s.input + s.cacheWrite + s.cacheRead;
  rows.push([
    r,
    s.requests,
    s.sends,
    `${s.invalidSends}（${pct(s.invalidSends, s.sends)}）`,
    `${s.failed}（${pct(s.failed, s.requests)}）`,
    pct(s.cacheRead, prompt),
    s.input,
    s.cacheWrite,
    s.cacheRead,
    s.output,
    usd(s.cost),
    `${(s.ms / Math.max(1, s.sends) / 1000).toFixed(1)}s`,
  ]);
}

console.log(`# run ${runId}（${meta.mode}）`);
console.log("");
console.log("| " + rows[0].join(" | ") + " |");
console.log("|" + rows[0].map(() => "---").join("|") + "|");
for (const r of rows.slice(1)) console.log("| " + r.join(" | ") + " |");
console.log("");
console.log(`- 拒否（refusal）：${all.refusals} 回、API エラー：${all.apiErrors} 回`);
if (all.withUsage) console.log(`- 送る前の入力の見積もり ÷ 実際の入力：${(all.est / all.actual).toFixed(2)}（1 より大きければ多めに見積もっている）`);

// 検証の失敗の理由
const reasons = {};
for (const c of calls.filter((c) => !c.valid)) for (const e of c.errors) {
  const k = e.replace(/「[^」]*」/g, "「…」").replace(/[0-9]+/g, "N").slice(0, 60);
  reasons[k] = (reasons[k] || 0) + 1;
}
if (Object.keys(reasons).length) {
  console.log("- 検証の失敗の理由：");
  for (const [k, v] of Object.entries(reasons).sort((a, b) => b[1] - a[1])) console.log(`  - ${k}（${v}）`);
}

// 町のようす
const logs = events.filter((e) => e.type === "log").map((e) => e.entry);
const kinds = {};
for (const l of logs) kinds[l.kind] = (kinds[l.kind] || 0) + 1;
const convs = events.filter((e) => e.type === "conversation").map((e) => e.conv);
const lens = convs.map((c) => c.lines.length);
console.log(`- ログ：${Object.entries(kinds).map(([k, v]) => `${k} ${v}`).join("、")}`);
console.log(`- 会話：${convs.length} 回、発言数の平均 ${(lens.reduce((a, b) => a + b, 0) / Math.max(1, lens.length)).toFixed(1)}、12発言まで話し尽くした会話 ${lens.filter((n) => n >= 12).length} 回`);
// 切り詰める前の字数は、返事の原文から数える
const thoughts = [];
const says = [];
for (const c of calls) {
  if (!c.valid || c.schema !== "action") continue;
  try {
    const v = JSON.parse(c.response);
    if (v.thought) thoughts.push([...v.thought].length);
    if (v.say) says.push([...v.say].length);
  } catch {
    // 読めない返事は数えない
  }
}
if (says.length) console.log(`- 発言の字数：平均 ${(says.reduce((a, b) => a + b, 0) / says.length).toFixed(1)}、60字を超えて切り詰めた割合 ${pct(says.filter((n) => n > 60).length, says.length)}`);
if (thoughts.length) console.log(`- 内心の字数：平均 ${(thoughts.reduce((a, b) => a + b, 0) / thoughts.length).toFixed(1)}、40字を超えて切り詰めた割合 ${pct(thoughts.filter((n) => n > 40).length, thoughts.length)}`);
const lastTick = events.filter((e) => e.type === "tick").pop();
if (lastTick) console.log(`- 最後の状態：${lastTick.snapshot.day}日目 ${lastTick.snapshot.time}（${lastTick.snapshot.status}）`);
