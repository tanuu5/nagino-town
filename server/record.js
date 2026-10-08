// 実行ごとの記録（runs/YYYYMMDD-HHMMSS/）と、全 run の費用台帳（ledger/ledger.jsonl）。
// どちらも追記だけ。過去の run は書き換えない。
import fs from "node:fs";
import path from "node:path";
import { RUNS_DIR, LEDGER_DIR, LEDGER_FILE } from "./paths.js";
import { nowStamp, round6 } from "./util.js";
import { readConfigFiles } from "./config.js";

export const RUN_ID_RE = /^\d{8}-\d{6}$/;

export class RunRecorder {
  constructor({ kind, mode, extraMeta = {} }) {
    fs.mkdirSync(RUNS_DIR, { recursive: true });
    let d = new Date();
    let id = nowStamp(d);
    while (fs.existsSync(path.join(RUNS_DIR, id))) {
      d = new Date(d.getTime() + 1000);
      id = nowStamp(d);
    }
    this.id = id;
    this.dir = path.join(RUNS_DIR, id);
    fs.mkdirSync(path.join(this.dir, "config"), { recursive: true });
    for (const [name, text] of Object.entries(readConfigFiles())) {
      fs.writeFileSync(path.join(this.dir, "config", name), text);
    }
    this.writeJson("meta.json", {
      run: id,
      kind,
      mode,
      started_at: new Date().toISOString(),
      node: process.version,
      ...extraMeta,
    });
  }

  writeJson(name, obj) {
    fs.writeFileSync(path.join(this.dir, name), JSON.stringify(obj, null, 2) + "\n");
  }

  append(name, obj) {
    fs.appendFileSync(path.join(this.dir, name), JSON.stringify(obj) + "\n");
  }

  event(obj) {
    this.append("events.jsonl", obj);
  }

  llmCall(obj) {
    this.append("llm_calls.jsonl", obj);
  }

  cost(obj) {
    this.append("cost.jsonl", obj);
  }

  /** base_v1.ext, base_v2.ext ... と上書きせずに積む。保存したファイル名を返す */
  writeVersioned(base, ext, content) {
    for (let v = 1; v < 1000; v++) {
      const name = `${base}_v${v}.${ext}`;
      const file = path.join(this.dir, name);
      if (!fs.existsSync(file)) {
        fs.writeFileSync(file, content, { flag: "wx" });
        return name;
      }
    }
    throw new Error("版の番号が尽きました");
  }

  finish(extra = {}) {
    this.append("events.jsonl", { type: "run_end", at: new Date().toISOString(), ...extra });
  }
}

export class Ledger {
  constructor() {
    fs.mkdirSync(LEDGER_DIR, { recursive: true });
    this.total = 0;
    this.calls = 0;
    if (fs.existsSync(LEDGER_FILE)) {
      for (const line of fs.readFileSync(LEDGER_FILE, "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          const o = JSON.parse(line);
          if (typeof o.cost_usd === "number") {
            this.total += o.cost_usd;
            this.calls++;
          }
        } catch {
          // 壊れた行は数えない
        }
      }
    }
    this.total = round6(this.total);
  }

  add(entry) {
    fs.appendFileSync(LEDGER_FILE, JSON.stringify(entry) + "\n");
    this.total = round6(this.total + entry.cost_usd);
    this.calls++;
  }
}

/** 再生できる過去の run の一覧（新しい順） */
export function listRuns() {
  if (!fs.existsSync(RUNS_DIR)) return [];
  const out = [];
  for (const id of fs.readdirSync(RUNS_DIR)) {
    if (!RUN_ID_RE.test(id)) continue;
    const dir = path.join(RUNS_DIR, id);
    const ev = path.join(dir, "events.jsonl");
    if (!fs.existsSync(ev)) continue;
    let meta = {};
    try {
      meta = JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf8"));
    } catch {
      // meta が無くても再生はできる
    }
    if (meta.kind && meta.kind !== "sim") continue;
    out.push({ id, mode: meta.mode || "?", size: fs.statSync(ev).size });
  }
  return out.sort((a, b) => (a.id < b.id ? 1 : -1));
}
