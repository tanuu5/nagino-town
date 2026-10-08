// config/*.json を読み、検査し、使いやすい形にまとめる。
import fs from "node:fs";
import path from "node:path";
import { CONFIG_DIR } from "./paths.js";
import { hhmmToMin } from "./util.js";

const EFFORTS = ["low", "medium", "high", "xhigh", "max"];

// 2026-10-08 に公式ドキュメントで確かめた、モデルごとに通る thinking の組み合わせ（decisions_v1.md 2.3）
const MODEL_RULES = {
  "claude-haiku-5-5": { allowed: [null, "adaptive", "disabled"], maxEffortFor: { disabled: "high" } },
  "claude-sonnet-5-5": { allowed: [null, "adaptive", "between_tools"], maxEffortFor: { between_tools: "high" } },
  "claude-opus-5-5": { allowed: [null, "adaptive"], maxEffortFor: {} },
};

function readJson(name) {
  const file = path.join(CONFIG_DIR, name);
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function fail(msg) {
  throw new Error(`設定エラー: ${msg}`);
}

export function checkRoleConfig(where, rc, pricing) {
  if (!rc || typeof rc.model !== "string") fail(`${where}: model がありません`);
  const rules = MODEL_RULES[rc.model];
  if (!rules) fail(`${where}: ${rc.model} は検査表にないモデルです（config.js の MODEL_RULES に足してください）`);
  if (!pricing.models[rc.model]) fail(`${where}: ${rc.model} の料金が pricing.json にありません`);
  if (!EFFORTS.includes(rc.effort)) fail(`${where}: effort "${rc.effort}" は使えません`);
  const t = rc.thinking ? rc.thinking.type : null;
  if (!rules.allowed.includes(t)) fail(`${where}: ${rc.model} は thinking "${t}" を受け付けません（400 になります）`);
  const maxE = t ? rules.maxEffortFor[t] : null;
  if (maxE && EFFORTS.indexOf(rc.effort) > EFFORTS.indexOf(maxE)) {
    fail(`${where}: ${rc.model} で thinking "${t}" を使えるのは effort ${maxE} 以下です`);
  }
  if (!Number.isInteger(rc.max_tokens) || rc.max_tokens < 256) fail(`${where}: max_tokens が小さすぎます`);
}

export function loadConfig() {
  const characters = readJson("characters.json");
  const world = readJson("world.json");
  const models = readJson("models.json");
  const pricing = readJson("pricing.json");
  const budget = readJson("budget.json");

  const residents = characters.residents;
  if (!Array.isArray(residents) || residents.length === 0) fail("characters.json に住人がいません");
  const names = residents.map((r) => r.name);
  if (new Set(names).size !== names.length) fail("住人の名前が重複しています");
  const placeNames = world.places.map((p) => p.name);
  for (const r of residents) {
    if (!placeNames.includes(r.home)) fail(`${r.name} の home「${r.home}」が場所にありません`);
    for (const w of r.work_places) if (!placeNames.includes(w)) fail(`${r.name} の職場「${w}」が場所にありません`);
    if (!(r.name in world.work_pay_per_hour)) fail(`${r.name} の時給が world.json にありません`);
  }
  for (const rel of characters.relations) {
    if (!names.includes(rel.from) || !names.includes(rel.to)) fail(`関係値の名前が不正です: ${rel.from}→${rel.to}`);
  }
  const options = world.meeting.options;
  for (const k of ["day_start", "day_end"]) if (hhmmToMin(world.time[k]) == null) fail(`time.${k} が HH:MM ではありません`);

  // モデルの組み合わせを検査（通らないなら起動しない）
  for (const [role, rc] of Object.entries(models.roles)) checkRoleConfig(`roles.${role}`, rc, pricing);
  for (const [who, ov] of Object.entries(models.overrides || {})) {
    if (!names.includes(who)) fail(`overrides の「${who}」は住人ではありません`);
    for (const role of ["action", "talk"]) {
      if (ov[role]) checkRoleConfig(`overrides.${who}.${role}`, { ...models.roles[role], ...ov[role] }, pricing);
    }
  }

  const derived = {
    names,
    placeNames,
    options,
    // 行動 JSON の target に使う許可リスト（空文字＝対象なし）
    targets: ["", ...placeNames, ...names, ...options],
    items: ["", "コイン", "パン", "海図", "財布"],
    actions: ["move", "talk", "work", "buy", "give", "eat", "rest", "wait", "vote"],
    dayStartMin: hhmmToMin(world.time.day_start),
    dayEndMin: hhmmToMin(world.time.day_end),
  };
  derived.ticksPerDay = Math.round((derived.dayEndMin - derived.dayStartMin) / world.time.tick_minutes);

  return { characters, world, models, pricing, budget, derived };
}

/** 住人と役割から、実際に使う呼び出し設定を返す（上書きを反映） */
export function roleConfigFor(cfg, role, residentName) {
  const base = cfg.models.roles[role];
  const ov = residentName && cfg.models.overrides && cfg.models.overrides[residentName];
  if (ov && ov[role]) return { ...base, ...ov[role] };
  return base;
}

/** run の記録用に、読み込んだ設定の原文をそのまま返す */
export function readConfigFiles() {
  const out = {};
  for (const f of fs.readdirSync(CONFIG_DIR)) {
    if (f.endsWith(".json")) out[f] = fs.readFileSync(path.join(CONFIG_DIR, f), "utf8");
  }
  return out;
}
