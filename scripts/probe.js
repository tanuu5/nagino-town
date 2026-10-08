// フェーズ0の動作確認：本番と同じ形の呼び出しを1回だけ送る。
// 使い方：
//   npm run probe                 … 送らずに、送る内容の大きさと最悪の費用だけを表示する
//   npm run probe -- --yes        … Haiku 5.5 に「行動の決定」を1回送る（$0.001 未満の見込み）
//   npm run probe -- --yes --role=reflection   … Sonnet 5.5 の振り返りを1回（数セント）
//   npm run probe -- --yes --role=newspaper    … Opus 5.5 の新聞を1回（数セント〜$0.4 以下）
// 記録は runs/（日時）/ と ledger/ledger.jsonl に残る。キーの値は表示しない。
import { loadConfig, roleConfigFor, applyRuntimeOverrides } from "../server/config.js";
import { hasApiKey, envFileFound } from "../server/env.js";
import { LlmGateway } from "../server/llm/gateway.js";
import { worstCaseCost } from "../server/llm/pricing.js";
import { Town } from "../server/sim/town.js";
import { RunRecorder, Ledger } from "../server/record.js";

const yes = process.argv.includes("--yes");
const roleArg = (process.argv.find((a) => a.startsWith("--role=")) || "--role=action").split("=")[1];
if (!["action", "reflection", "newspaper"].includes(roleArg)) {
  console.error("--role は action・reflection・newspaper のどれか");
  process.exit(1);
}

const cfg = loadConfig();
const runtime = applyRuntimeOverrides(cfg, process.env); // MODEL_PRESET で住人のモデルを切り替えて確かめられる
const rc = roleConfigFor(cfg, roleArg, cfg.derived.names[0]);
console.log(`役割：${rc.label}（${roleArg}） モデル：${rc.model} effort：${rc.effort} thinking：${rc.thinking ? rc.thinking.type : "既定"} max_tokens：${rc.max_tokens}`);

if (!yes) {
  // 送らずに見積もりだけ
  const fake = { id: "dry-run", event() {}, llmCall() {}, cost() {}, writeVersioned: () => "dry", finish() {} };
  const gw = new LlmGateway({ cfg, mode: "mock", recorder: fake, ledger: { total: 0, add() {} }, mockLatency: [0, 0] });
  const town = new Town({ cfg, gateway: gw, recorder: fake });
  town.startOfDay();
  const r = town.res.get(cfg.derived.names[0]);
  const ctx = town.situationContext(r, "action", {});
  ctx.memories = town.memoriesFor(r, cfg.world.memory.retrieve_top_k);
  const { situation } = await import("../server/sim/prompts.js");
  const fit = gw.fits([town.rulesText, town.personaText[r.name]], situation(ctx), town.schema);
  console.log(`（行動の決定の場合）送る入力の見積もり：約${fit.est}トークン、最悪の費用：$${worstCaseCost(cfg.pricing, rc.model, fit.est, rc.max_tokens)}`);
  console.log(`API キー：${hasApiKey() ? "設定あり" : envFileFound() ? "app/.env はあるが TOWN_ANTHROPIC_API_KEY が空" : "app/.env がない"}`);
  console.log("実際に送るには --yes を付けてください。");
  process.exit(0);
}

if (!hasApiKey()) {
  console.error("API キーが設定されていません。app/.env.example を app/.env にコピーし、TOWN_ANTHROPIC_API_KEY= の後ろにキーを書いてください。");
  process.exit(1);
}

const ledger = new Ledger();
const rec = new RunRecorder({ kind: "probe", mode: "real", extraMeta: { role: roleArg, runtime } });
const gw = new LlmGateway({ cfg, mode: "real", recorder: rec, ledger });
const town = new Town({ cfg, gateway: gw, recorder: rec });
town.startOfDay();
const r = town.res.get(cfg.derived.names[0]);

const t0 = Date.now();
let value = null;
try {
  if (roleArg === "action") value = (await town.askResident(r, "action")).value;
  else if (roleArg === "reflection") {
    await town.reflectOne(r);
    value = { beliefs: r.beliefs, goal: r.goal, diary: r.diary };
  } else {
    await town.writeNewspaper();
    value = town.newspapers[1] ? town.newspapers[1].json : null;
  }
} catch (e) {
  console.error(`失敗：${e.message}`);
}
const st = gw.stats;
console.log(`所要 ${Date.now() - t0}ms、送信 ${st.calls} 回、検証：1回目で合格 ${st.validFirst}／再試行で合格 ${st.validRetry}／失敗 ${st.failed}／拒否 ${st.refusals}／API エラー ${st.apiErrors}`);
console.log(`トークン：入力 ${st.input}、出力 ${st.output}、キャッシュ書き込み ${st.cacheWrite}、キャッシュ読み込み ${st.cacheRead}`);
console.log(`費用：$${gw.runCost}（台帳の累計 $${ledger.total}）`);
console.log("返ってきた値：");
console.log(JSON.stringify(value, null, 2));
console.log(`記録：${rec.dir}`);
rec.finish({ probe: roleArg });
