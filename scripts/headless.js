// 画面なしで mock の町を最後まで走らせる確認用スクリプト（API は呼ばない）。
// 使い方：npm run headless            … 記録はメモリ上だけ
//         npm run headless -- --record … runs/ に記録を残す（再生モードの確認用）
import { loadConfig } from "../server/config.js";
import { LlmGateway } from "../server/llm/gateway.js";
import { Town } from "../server/sim/town.js";
import { RunRecorder } from "../server/record.js";

const record = process.argv.includes("--record");
const seedArg = process.argv.find((a) => a.startsWith("--seed="));

class MemoryRecorder {
  constructor() {
    this.id = "headless";
    this.counts = {};
    this.files = {};
  }
  bump(k) {
    this.counts[k] = (this.counts[k] || 0) + 1;
  }
  event(o) {
    this.bump(`event:${o.type}`);
  }
  llmCall() {
    this.bump("llm_call");
  }
  cost() {
    this.bump("cost");
  }
  writeVersioned(base, ext, content) {
    const name = `${base}_v1.${ext}`;
    this.files[name] = content;
    return name;
  }
  finish() {}
}

const cfg = loadConfig();
if (seedArg) cfg.world.seed = Number(seedArg.split("=")[1]);
const ledger = { total: 0, add() {} };
const rec = record ? new RunRecorder({ kind: "sim", mode: "mock", extraMeta: { seed: cfg.world.seed, headless: true } }) : new MemoryRecorder();
const gw = new LlmGateway({ cfg, mode: "mock", recorder: rec, ledger, mockLatency: [0, 0] });
const kinds = {};
const town = new Town({
  cfg,
  gateway: gw,
  recorder: rec,
  emit: (type, p) => {
    if (type === "log") kinds[p.kind] = (kinds[p.kind] || 0) + 1;
  },
  mockInvalidRate: 0.03,
});

// 天の声も一通り試す
const heavenAt = { "1:40": { type: "storm" }, "2:12": { type: "wallet" }, "2:30": { type: "oven" }, "2:44": { type: "letter", text: "" }, "3:8": { type: "free", text: "港に大きな鯨が見えた", place: "港" } };

const t0 = Date.now();
let ticks = 0;
town.setStatus("running");
while (!town.finished) {
  const key = `${town.day}:${town.tickIndex}`;
  if (heavenAt[key]) town.queueHeaven(heavenAt[key]);
  await town.tick();
  ticks++;
  if (town.status === "day_waiting") town.nextDay();
  if (town.status === "stopped") break;
  if (ticks > 1000) throw new Error("終わらない");
}

const snap = town.snapshot();
const st = gw.stats;
console.log(`ticks=${ticks} 終了=${town.status} (${town.statusReason}) 所要=${Date.now() - t0}ms`);
console.log(`呼び出し：論理${st.requests}回 / 送信${st.calls}回 / 1回目で合格${st.validFirst} / 再試行で合格${st.validRetry} / 失敗→wait ${st.failed}`);
console.log("役割別：", JSON.stringify(st.byRole));
console.log("ログの種類：", JSON.stringify(kinds));
console.log("集会：", JSON.stringify(town.meeting.result));
console.log("mock の推定費用（real なら）：$" + gw.mockShadowCost);
for (const r of snap.residents) {
  console.log(`  ${r.short}: ${r.loc} コイン${r.coins} 空腹${r.hunger} パン${r.items["パン"]} 記憶${r.memoryCount}/${r.memoryLimit}(忘${r.forgotten}) 思い込み${r.beliefs.length} 気分${r.mood}`);
}
console.log("新聞：", Object.keys(town.newspapers).map((d) => `${d}日目=${town.newspapers[d].file}`).join(", "));
if (rec instanceof MemoryRecorder) console.log("記録：", JSON.stringify(rec.counts));
else console.log("記録先：", rec.dir);
