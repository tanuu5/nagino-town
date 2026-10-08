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

const SCENARIO_DIR = path.join(CONFIG_DIR, "scenarios");
const SCENARIO_NAME_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

function readText(name) {
  return fs.readFileSync(path.join(CONFIG_DIR, name), "utf8");
}

function fail(msg) {
  throw new Error(`設定エラー: ${msg}`);
}

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * シナリオの差分を重ねる。オブジェクトは項目ごとに重ね、配列と値は置き換える。
 * 配列の位置に {"$append": [...]} と書くと、元の配列の後ろに足す。
 */
export function overlay(base, over, where = "$") {
  if (isPlainObject(over) && "$append" in over) {
    if (!Array.isArray(base) || !Array.isArray(over.$append) || Object.keys(over).length !== 1) fail(`${where}: $append は配列にだけ使える`);
    return [...base, ...over.$append];
  }
  if (isPlainObject(base) && isPlainObject(over)) {
    const out = { ...base };
    for (const [k, v] of Object.entries(over)) {
      if (!(k in base) && isPlainObject(v) && "$append" in v) fail(`${where}.${k}: base に無い項目には $append を使えない`);
      out[k] = k in base ? overlay(base[k], v, `${where}.${k}`) : v;
    }
    return out;
  }
  return over;
}

/** characters.json の差分：residents は名前で突き合わせて重ねる（新しい住人は足さない） */
function overlayCharacters(base, over, where) {
  const { residents, ...rest } = over;
  const out = overlay(base, rest, where);
  if (residents !== undefined) {
    if (!Array.isArray(residents)) fail(`${where}.residents は配列にする`);
    out.residents = base.residents.slice();
    for (const part of residents) {
      const i = out.residents.findIndex((r) => r.name === part.name);
      if (i < 0) fail(`${where}: 住人「${part.name}」は base にいない`);
      out.residents[i] = overlay(out.residents[i], part, `${where}.residents[${part.name}]`);
    }
  }
  return out;
}

/** config/scenarios/（名前）/ を読む。scenario.json の extends で別のシナリオを土台にできる */
function readScenario(name, depth = 0) {
  if (!SCENARIO_NAME_RE.test(name)) fail(`シナリオ名「${name}」は英小文字・数字・ハイフンで書く`);
  const dir = path.join(SCENARIO_DIR, name);
  if (!fs.existsSync(dir)) fail(`シナリオ「${name}」がありません（config/scenarios/${name}/）`);
  if (depth > 4) fail("シナリオの extends が深すぎます");
  const read = (f) => {
    const file = path.join(dir, f);
    return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
  };
  const metaText = read("scenario.json");
  const meta = metaText ? JSON.parse(metaText) : {};
  const parent = meta.extends ? readScenario(meta.extends, depth + 1) : { chain: [], layers: [] };
  const layer = { name, meta, files: {} };
  for (const f of ["scenario.json", "world.json", "characters.json"]) {
    const t = read(f);
    if (t != null) layer.files[f] = t;
  }
  return { chain: [...parent.chain, name], layers: [...parent.layers, layer], meta };
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

/**
 * 設定を読む。scenario を指定すると、config/scenarios/（名前）/ の差分を world と characters に重ねる。
 * 元の config/world.json と config/characters.json は書き換えない。指定がなければ今までどおりの町（base）。
 */
export function loadConfig({ scenario = "" } = {}) {
  const raw = {};
  for (const f of ["characters.json", "world.json", "models.json", "pricing.json", "budget.json"]) raw[f] = readText(f);
  let characters = JSON.parse(raw["characters.json"]);
  let world = JSON.parse(raw["world.json"]);
  const models = JSON.parse(raw["models.json"]);
  const pricing = JSON.parse(raw["pricing.json"]);
  const budget = JSON.parse(raw["budget.json"]);

  let scen = null;
  const name = String(scenario || "").trim();
  if (name && name !== "base") {
    const s = readScenario(name);
    for (const layer of s.layers) {
      if (layer.files["world.json"]) world = overlay(world, JSON.parse(layer.files["world.json"]), `scenarios/${layer.name}/world.json`);
      if (layer.files["characters.json"]) {
        characters = overlayCharacters(characters, JSON.parse(layer.files["characters.json"]), `scenarios/${layer.name}/characters.json`);
      }
    }
    scen = { name, title: s.meta.title || name, description: s.meta.description || "", chain: s.chain, layers: s.layers };
  }

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
  checkScenarioRules(world, placeNames, options);

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

  return { characters, world, models, pricing, budget, derived, scenario: scen, raw };
}

/** シナリオで入れる決まり（base には無い項目）を検査する */
function checkScenarioRules(world, placeNames, options) {
  const hg = world.hunger;
  if (hg.tell !== undefined && !["number", "words"].includes(hg.tell)) fail('hunger.tell は "number" か "words"');
  if (hg.tell === "words") {
    const ws = hg.words;
    if (!Array.isArray(ws) || !ws.length || ws[ws.length - 1].max < 10) fail("hunger.words は空腹度10までを覆う言葉の表にする");
  }
  const cq = hg.consequences;
  if (cq) {
    for (const k of ["slow_move_at", "half_talk_at", "no_work_at", "collapse_at", "collapse_ticks"]) {
      if (!Number.isInteger(cq[k]) || cq[k] < 1) fail(`hunger.consequences.${k} は1以上の整数`);
    }
    if (hg.tell === "words") {
      for (const k of ["slow_move_at", "collapse_at"]) if (!hg.words.some((w) => w.max >= cq[k])) fail(`hunger.words に ${k} の言葉が無い`);
    }
  }
  const wx = world.weather;
  if (wx) {
    for (const p of wx.no_work_places || []) if (!placeNames.includes(p)) fail(`weather.no_work_places の「${p}」が場所にありません`);
  }
  const ov = world.bakery.oven;
  if (ov.after_meeting && !options.includes(ov.after_meeting.option)) fail(`bakery.oven.after_meeting.option「${ov.after_meeting.option}」が集会の選択肢にない`);
  if (ov.break_below !== undefined && !(ov.break_below > 0 && ov.break_below < 1)) fail("bakery.oven.break_below は0〜1");
  for (const ev of world.random_events.pool) if (!placeNames.includes(ev.place)) fail(`random_events.pool の場所「${ev.place}」がありません`);
}

/**
 * run の記録に残す設定一式（ファイル名 → 中身）。
 * base のときは読み込んだ原文のまま。シナリオのときは world.json と characters.json を「その回に実際に使った設定」
 * （差分を重ねたもの）にし、元の原文を base/ に、差分を scenario/（名前）/ に残す。
 */
export function configSnapshot(cfg) {
  const out = { ...cfg.raw };
  if (!cfg.scenario) return out;
  out["world.json"] = JSON.stringify(cfg.world, null, 2) + "\n";
  out["characters.json"] = JSON.stringify(cfg.characters, null, 2) + "\n";
  out["base/world.json"] = cfg.raw["world.json"];
  out["base/characters.json"] = cfg.raw["characters.json"];
  for (const layer of cfg.scenario.layers) {
    for (const [f, text] of Object.entries(layer.files)) out[`scenario/${layer.name}/${f}`] = text;
  }
  return out;
}

/** meta.json と画面に出す、シナリオの名前と説明 */
export function scenarioInfo(cfg) {
  if (!cfg.scenario) return { name: "base", title: "いつもの町", chain: [] };
  const s = cfg.scenario;
  return { name: s.name, title: s.title, description: s.description, chain: s.chain };
}

/**
 * 起動時の指定（環境変数）を反映する。設定ファイルは書き換えない。
 * - MODEL_PRESET：models.json の presets から選び、住人全員の action と talk を上書きする
 * - RUN_CAP_USD：この起動での run の上限（0 より大きく 50 以下）
 * 反映した内容を返す（run の meta.json に残すため）
 */
export function applyRuntimeOverrides(cfg, env) {
  const info = {};
  const preset = env.MODEL_PRESET || "";
  if (preset) {
    const p = cfg.models.presets && cfg.models.presets[preset];
    if (!p) fail(`MODEL_PRESET「${preset}」は models.json の presets にありません`);
    for (const name of cfg.derived.names) {
      cfg.models.overrides[name] = { ...(cfg.models.overrides[name] || {}), ...p };
      for (const role of ["action", "talk"]) {
        if (p[role]) checkRoleConfig(`presets.${preset}.${role}`, { ...cfg.models.roles[role], ...p[role] }, cfg.pricing);
      }
    }
    info.model_preset = preset;
  }
  if (env.RUN_CAP_USD) {
    const cap = Number(env.RUN_CAP_USD);
    if (!(cap > 0 && cap <= 50)) fail("RUN_CAP_USD は 0 より大きく 50 以下にしてください");
    cfg.budget.run_cap_usd = cap;
    info.run_cap_usd = cap;
  }
  info.effective_roles = {
    action: roleConfigFor(cfg, "action", cfg.derived.names[0]),
    talk: roleConfigFor(cfg, "talk", cfg.derived.names[0]),
    reflection: cfg.models.roles.reflection,
    newspaper: cfg.models.roles.newspaper,
  };
  info.run_cap_usd = cfg.budget.run_cap_usd;
  return info;
}

/** 住人と役割から、実際に使う呼び出し設定を返す（上書きを反映） */
export function roleConfigFor(cfg, role, residentName) {
  const base = cfg.models.roles[role];
  const ov = residentName && cfg.models.overrides && cfg.models.overrides[residentName];
  if (ov && ov[role]) return { ...base, ...ov[role] };
  return base;
}

/** run の記録用に、設定フォルダの原文をそのまま返す（configSnapshot を渡されなかったときの予備） */
export function readConfigFiles() {
  const out = {};
  for (const f of fs.readdirSync(CONFIG_DIR)) {
    if (f.endsWith(".json")) out[f] = fs.readFileSync(path.join(CONFIG_DIR, f), "utf8");
  }
  return out;
}
