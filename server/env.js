// app/.env から必要な3つの値だけを取り出す。
// - 値は process.env に入れない（子プロセスへ渡らないように）。
// - キーの値はどこにも表示しない。外に出すのは「設定されているか」の真偽だけ。
import fs from "node:fs";
import util from "node:util";
import { ENV_FILE } from "./paths.js";

const WANTED = ["TOWN_ANTHROPIC_API_KEY", "LLM_MODE", "PORT"];

function parse(text) {
  if (typeof util.parseEnv === "function") return util.parseEnv(text);
  // Node 20.12 未満向けの最小限の読み取り（KEY=VALUE の行だけ）
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

let cached = null;

function load() {
  if (cached) return cached;
  let values = {};
  let fileFound = false;
  try {
    const text = fs.readFileSync(ENV_FILE, "utf8");
    fileFound = true;
    const all = parse(text);
    for (const k of WANTED) if (typeof all[k] === "string") values[k] = all[k].trim();
  } catch {
    // .env が無いのは正常（mock で起動する）
  }
  cached = { values, fileFound };
  return cached;
}

/** API キーが設定されているか（値は返さない） */
export function hasApiKey() {
  const k = load().values.TOWN_ANTHROPIC_API_KEY;
  return typeof k === "string" && k.length > 0;
}

/** SDK に渡すときだけ使う。ログや画面には絶対に出さないこと。 */
export function getApiKeyForClient() {
  return load().values.TOWN_ANTHROPIC_API_KEY || null;
}

/** 実行モード。環境変数 LLM_MODE が .env より優先。既定は mock。 */
export function requestedMode() {
  const v = (process.env.LLM_MODE || load().values.LLM_MODE || "mock").toLowerCase();
  return v === "real" ? "real" : "mock";
}

export function port() {
  const raw = process.env.PORT || load().values.PORT || "";
  const n = Number.parseInt(raw, 10);
  return Number.isInteger(n) && n > 1024 && n < 65536 ? n : 8787;
}

export function envFileFound() {
  return load().fileFound;
}
