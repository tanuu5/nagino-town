// 起動：npm start → http://127.0.0.1:8787
import { loadConfig, applyRuntimeOverrides, scenarioInfo } from "./config.js";
import { hasApiKey, requestedMode, port as getPort } from "./env.js";
import { Ledger } from "./record.js";
import { Runner } from "./runner.js";
import { startHttp } from "./http.js";
import { logMarkdown } from "./export.js";
import { minToHhmm } from "./util.js";

const cfg = loadConfig({ scenario: process.env.SCENARIO });
const runtime = applyRuntimeOverrides(cfg, process.env);
const ledger = new Ledger();

// API キーは「あるかどうか」だけを見る。値は表示しない。
const want = requestedMode();
let mode = "mock";
let modeNote = "mock：API を呼ばずに、決まった型の行動をランダムに返します（費用 $0）";
if (want === "real") {
  if (hasApiKey()) {
    mode = "real";
    modeNote = "real：住人を Claude が演じます（API の費用がかかります）";
  } else {
    modeNote = "API キー（app/.env の TOWN_ANTHROPIC_API_KEY）が設定されていないため、mock で起動しました";
  }
}

const PORT = getPort();
let httpApi = null;
const broadcast = (type, payload) => httpApi && httpApi.broadcast(type, payload);
if (runtime.model_preset) modeNote += `（住人のモデル：${runtime.model_preset}）`;
if (cfg.scenario) modeNote += `／シナリオ：${cfg.scenario.title}`;
const runner = new Runner({ cfg, mode, modeNote, ledger, broadcast, mockLatency: [20, 120], mockInvalidRate: 0.03, runtime });

httpApi = startHttp({
  port: PORT,
  runner: () => runner,
  onClients: (n) => runner.setClients(n),
  exportLog: () => {
    if (runner.replay) return { ok: false, error: "再生モードではブラウザ側のダウンロードだけです" };
    if (!runner.rec.started) return { ok: false, error: "まだ記録がありません" };
    const md = logMarkdown(cfg, runner.town.logs, runner.rec.id);
    const file = runner.rec.writeVersioned("log", "md", md);
    return { ok: true, file, markdown: md };
  },
  exportMap: (png) => {
    if (runner.replay) return { ok: false, error: "再生モードではブラウザ側のダウンロードだけです" };
    if (!runner.rec.started) return { ok: false, error: "まだ記録がありません" };
    const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    if (png.length < 8 || !png.subarray(0, 8).equals(sig)) return { ok: false, error: "PNG ではありません" };
    const t = runner.town;
    const file = runner.rec.writeVersioned(`map_day${t.day}_${minToHhmm(t.minute).replace(":", "")}`, "png", png);
    return { ok: true, file };
  },
});

httpApi.server.on("listening", () => {
  console.log(`凪野町：http://127.0.0.1:${PORT} をブラウザで開いてください`);
  console.log(`モード：${mode}${want === "real" && mode !== "real" ? "（キー未設定のため mock）" : ""}`);
  console.log(`台帳の累計：$${ledger.total}（上限 $${cfg.budget.ledger_cap_usd}）、run の上限 $${cfg.budget.run_cap_usd}`);
  if (runtime.model_preset) console.log(`住人のモデル：${runtime.model_preset}（${runtime.effective_roles.action.model}）`);
  const sc = scenarioInfo(cfg);
  console.log(`シナリオ：${sc.name}（${sc.title}）`);
});
httpApi.server.on("error", (e) => {
  console.error(`サーバーを起動できませんでした：${e.message}`);
  process.exit(1);
});

function shutdown() {
  if (runner.rec.started) runner.rec.finish({ reason: "server_stopped", day: runner.town.day, time: runner.town.time });
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
