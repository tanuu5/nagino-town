// 画面の操作。サーバーとは SSE（/api/events）と POST /api/control だけでやりとりする。
// AI の文字列を画面に出すときは必ず textContent を使う（innerHTML は使わない）。
import { TownMap } from "./map.js";

const $ = (id) => document.getElementById(id);

const state = {
  hello: null,
  snap: null,
  chars: [],
  charByName: {},
  logs: [],
  newspapers: {},
  cost: null,
  mode: "mock",
  replay: null,
  speed: 1,
  status: "ready",
  showThought: false,
  filter: "",
  cardFor: null,
  modalKind: null,
};

const map = new TownMap($("map"));

// ---------- 小さな道具 ----------
function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") e.className = v;
    else if (k === "text") e.textContent = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined && v !== false) e.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children) if (c != null) e.append(c);
  return e;
}

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

function money(x) {
  if (x == null) return "—";
  return "$" + (x < 0.01 && x > 0 ? x.toFixed(4) : x.toFixed(3));
}

let toastTimer = 0;
function toast(text) {
  const t = $("toast");
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 2600);
}

async function control(body) {
  try {
    const res = await fetch("/api/control", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const out = await res.json();
    if (!out.ok && out.error) toast(out.error);
    return out;
  } catch {
    toast("サーバーにつながりません");
    return { ok: false };
  }
}

function download(name, blob) {
  const url = URL.createObjectURL(blob);
  const a = el("a", { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function nameShort(n) {
  return (state.charByName[n] && state.charByName[n].short) || n;
}

// ---------- SSE ----------
function connect() {
  const es = new EventSource("/api/events");
  es.addEventListener("hello", (e) => onHello(JSON.parse(e.data)));
  es.addEventListener("snapshot", (e) => onSnapshot(JSON.parse(e.data)));
  es.addEventListener("log", (e) => onLog(JSON.parse(e.data)));
  es.addEventListener("status", (e) => onStatus(JSON.parse(e.data)));
  es.addEventListener("cost", (e) => onCost(JSON.parse(e.data)));
  es.addEventListener("newspaper", (e) => onNewspaper(JSON.parse(e.data), true));
  es.addEventListener("speed", (e) => setSpeed(JSON.parse(e.data).speed));
  es.addEventListener("toast", (e) => toast(JSON.parse(e.data).text));
  es.addEventListener("replay", (e) => {
    state.replay = JSON.parse(e.data);
    renderControls();
  });
  es.onerror = () => setStatusText("サーバーとの接続が切れました。再接続を試みています…", true);
}

function onHello(h) {
  state.hello = h;
  state.mode = h.mode;
  state.replay = h.replay;
  state.chars = h.characters;
  state.charByName = Object.fromEntries(h.characters.map((c) => [c.name, c]));
  state.logs = [];
  state.newspapers = {};
  map.setWorld(h.world, h.characters);
  setSpeed(h.speed);
  const modeEl = $("mode");
  modeEl.textContent = h.mode === "real" ? "REAL" : h.mode === "replay" ? "再生" : "MOCK";
  modeEl.className = `mode ${h.mode}`;
  modeEl.title = h.modeNote || "";
  $("stage-note").textContent = h.modeNote || "";
  // ログの絞り込み
  const sel = $("log-filter");
  clear(sel);
  sel.append(el("option", { value: "", text: "全員" }), el("option", { value: "@events", text: "出来事だけ" }));
  for (const c of h.characters) sel.append(el("option", { value: c.name, text: c.short }));
  sel.value = "";
  state.filter = "";
  clear($("log"));
  for (const l of h.logs) onLog(l, true);
  for (const n of h.newspapers) onNewspaper(n, false);
  if (h.cost) onCost(h.cost);
  else {
    $("cost-run").textContent = "—";
    $("cost-ledger").textContent = "—";
    $("cost-run-cap").textContent = "";
    $("cost-ledger-cap").textContent = "";
  }
  if (h.snapshot) onSnapshot(h.snapshot);
  if (h.snapshot) onStatus({ status: h.mode === "replay" ? "replay" : h.snapshot.status, reason: h.snapshot.statusReason });
  renderControls();
}

function onSnapshot(s) {
  state.snap = s;
  map.update(s);
  $("clock").textContent = `${s.day}日目 ${s.time}`;
  if (state.cardFor) renderCard(state.cardFor);
  if (state.hello && state.mode !== "replay") {
    state.status = s.status;
    renderControls();
  }
}

function setStatusText(text, alert) {
  const st = $("status");
  st.textContent = text;
  st.className = alert ? "status alert" : "status";
}

const STATUS_LABEL = {
  ready: "準備できました。「再生」で1日目の朝が始まります",
  running: "進行中",
  paused: "一時停止中",
  dayend: "1日の終わり：振り返りと新聞を準備中…",
  day_waiting: "1日が終わりました。「次の日へ」で進みます",
  finished: "町の3日間が終わりました",
  stopped: "停止しました",
  replay: "再生中",
};

function onStatus(s) {
  state.status = s.status;
  const alert = s.status === "stopped";
  setStatusText(s.reason ? `${STATUS_LABEL[s.status] || s.status}：${s.reason}` : STATUS_LABEL[s.status] || s.status, alert);
  renderControls();
  if (s.status === "day_waiting" || s.status === "finished") {
    const days = Object.keys(state.newspapers).map(Number);
    if (days.length && state.mode !== "replay") openNewspaper(Math.max(...days));
  }
}

function onCost(c) {
  state.cost = c;
  $("cost-run").textContent = money(c.run_usd);
  $("cost-run-cap").textContent = ` / $${c.run_cap_usd}`;
  $("cost-ledger").textContent = money(c.ledger_usd);
  $("cost-ledger-cap").textContent = ` / $${c.ledger_cap_usd}`;
  const warn = c.run_usd >= c.run_cap_usd * 0.8 || c.ledger_usd >= c.ledger_cap_usd * 0.9 || !!c.stop_reason;
  $("cost").className = warn ? "cost warn" : "cost";
  const st = c.stats || {};
  $("cost").title =
    `今回の費用 / 上限、台帳の累計 / 上限\n` +
    `呼び出し ${st.requests || 0} 回（送信 ${st.calls || 0}、再試行で合格 ${st.validRetry || 0}、失敗 ${st.failed || 0}）\n` +
    (c.mode === "mock" ? `mock の推定（real なら）：$${c.mock_shadow_usd}` : `キャッシュ読み込み ${st.cacheRead || 0} トークン`);
}

// ---------- ログ ----------
function logMatches(l) {
  if (!state.filter) return true;
  if (state.filter === "@events") return ["event", "heaven", "meeting", "news", "system"].includes(l.kind);
  return l.who === state.filter || l.to === state.filter;
}

function renderLogItem(l) {
  const li = el("li", { class: l.kind, "data-who": l.who || "", "data-to": l.to || "" });
  li.append(el("span", { class: "t", text: `${l.day}日 ${l.time}` }));
  if (l.who && state.charByName[l.who]) {
    const c = state.charByName[l.who];
    const dot = el("span", { class: "dot" });
    dot.style.background = c.color;
    li.append(dot, el("span", { class: "who", text: l.to ? `${c.short}→${nameShort(l.to)}` : c.short }));
  }
  const text = l.kind === "say" || (l.kind === "meeting" && l.speech) ? l.text : l.text;
  li.append(el("span", { class: "txt", text }));
  if (l.kind === "meeting" && l.speech) li.classList.add("say");
  if (l.thought) li.append(el("span", { class: "thought-line", text: `内心：${l.thought}` }));
  if (l.detail) li.title = l.detail;
  return li;
}

function onLog(l, quiet) {
  state.logs.push(l);
  if (state.logs.length > 3000) state.logs.splice(0, state.logs.length - 3000);
  const box = $("log");
  if (logMatches(l)) {
    box.append(renderLogItem(l));
    while (box.childElementCount > 1500) box.removeChild(box.firstChild);
    if (stickToBottom || quiet) box.scrollTop = box.scrollHeight;
  }
  if (quiet) return;
  if ((l.kind === "say" || (l.kind === "meeting" && l.who)) && l.who) map.addBubble(l.who, l.text, l.kind === "meeting" ? "meeting" : "say");
  if (l.thought && l.who && ["say", "action", "meeting", "vote"].includes(l.kind)) map.addBubble(l.who, l.thought, "thought");
  if (l.kind === "heaven") toast(l.text);
}

// 一番下を見ているあいだだけ、新しいログに合わせて自動でスクロールする
let stickToBottom = true;
$("log").addEventListener("scroll", () => {
  const box = $("log");
  stickToBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
});

function rerenderLog() {
  const box = $("log");
  clear(box);
  const items = state.logs.filter(logMatches).slice(-1500);
  for (const l of items) box.append(renderLogItem(l));
  box.scrollTop = box.scrollHeight;
}

// ---------- 操作ボタン ----------
function setSpeed(s) {
  state.speed = s;
  map.tickMs = (state.hello ? state.hello.world.time.tick_seconds_1x * 1000 : 3000) / s;
  const seg = $("speed");
  clear(seg);
  const speeds = state.hello ? state.hello.speeds : [1, 4];
  for (const v of speeds) {
    seg.append(
      el("button", {
        type: "button",
        class: v === s ? "on" : "",
        text: `${v}倍`,
        "aria-pressed": v === s ? "true" : "false",
        onclick: () => control({ cmd: "speed", speed: v }),
      }),
    );
  }
}

function renderControls() {
  const replay = state.mode === "replay";
  const st = state.status;
  const running = replay ? !!(state.replay && state.replay.playing) : st === "running";
  const blocked = ["day_waiting", "finished", "stopped", "dayend"].includes(st);
  $("btn-play").disabled = running || (!replay && blocked);
  $("btn-pause").disabled = !running;
  $("btn-step").disabled = running || (!replay && blocked);
  $("btn-next").hidden = replay || st !== "day_waiting";
  $("btn-replay-exit").hidden = !replay;
  $("btn-replay").hidden = replay;
  $("btn-new").hidden = replay || !(st === "finished" || st === "stopped");
  for (const b of document.querySelectorAll("[data-heaven]")) b.disabled = replay || st === "finished" || st === "stopped";
  $("btn-logmd").disabled = false;
}

$("btn-play").addEventListener("click", () => control({ cmd: state.mode === "replay" ? "replay_play" : "play" }));
$("btn-pause").addEventListener("click", () => control({ cmd: state.mode === "replay" ? "replay_pause" : "pause" }));
$("btn-step").addEventListener("click", () => control({ cmd: state.mode === "replay" ? "replay_step" : "step" }));
$("btn-next").addEventListener("click", () => control({ cmd: "next_day" }));
$("btn-replay-exit").addEventListener("click", () => control({ cmd: "replay_exit" }));
$("btn-new").addEventListener("click", () => {
  if (window.confirm("新しい町を始めますか？（今の町の記録は runs/ に残ります）")) control({ cmd: "new_town" });
});

$("toggle-thought").addEventListener("change", (e) => {
  state.showThought = e.target.checked;
  map.showThought = state.showThought;
  document.body.classList.toggle("show-thought", state.showThought);
  if (stickToBottom) $("log").scrollTop = $("log").scrollHeight;
  if (state.cardFor) renderCard(state.cardFor);
});

$("log-filter").addEventListener("change", (e) => {
  state.filter = e.target.value;
  rerenderLog();
});

for (const b of document.querySelectorAll("[data-heaven]")) {
  b.addEventListener("click", () => {
    const type = b.getAttribute("data-heaven");
    if (type === "letter") openLetterForm();
    else if (type === "free") openFreeForm();
    else control({ cmd: "heaven", type });
  });
}

// ---------- 書き出し ----------
function stamp() {
  const s = state.snap;
  return s ? `day${s.day}_${s.time.replace(":", "")}` : "town";
}

$("btn-png").addEventListener("click", () => {
  map.draw();
  $("map").toBlob(async (blob) => {
    if (!blob) return toast("画像にできませんでした");
    download(`nagino_${stamp()}.png`, blob);
    if (state.mode !== "replay") {
      try {
        const res = await fetch("/api/export/map", { method: "POST", headers: { "Content-Type": "image/png" }, body: blob });
        const out = await res.json();
        if (out.ok) toast(`runs/ にも保存しました：${out.file}`);
      } catch {
        // ダウンロードはできているので黙る
      }
    }
  }, "image/png");
});

$("btn-logmd").addEventListener("click", async () => {
  if (state.mode !== "replay") {
    const res = await fetch("/api/export/log", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    const out = await res.json();
    if (out.ok) {
      download(`nagino_log_${stamp()}.md`, new Blob([out.markdown], { type: "text/markdown" }));
      toast(`runs/ にも保存しました：${out.file}`);
      return;
    }
  }
  // 再生モードや記録がまだ無いとき：画面にあるログから作る
  const lines = ["# 凪野町ログ", ""];
  for (const l of state.logs) {
    const who = l.who ? `【${nameShort(l.who)}${l.to ? "→" + nameShort(l.to) : ""}】` : "";
    lines.push(`- ${l.day}日 ${l.time} ${who}${l.text}${l.thought ? `（内心：${l.thought}）` : ""}`);
  }
  download(`nagino_log_${stamp()}.md`, new Blob([lines.join("\n") + "\n"], { type: "text/markdown" }));
});

$("btn-news").addEventListener("click", () => {
  const days = Object.keys(state.newspapers).map(Number);
  if (!days.length) return toast("まだ新聞はありません（1日の終わりに出ます）");
  openNewspaper(Math.max(...days));
});

$("btn-replay").addEventListener("click", async () => {
  const res = await fetch("/api/runs");
  const out = await res.json();
  const body = openModal("過去の記録を再生", "runs");
  if (!out.runs.length) {
    body.append(el("p", { class: "muted", text: "再生できる記録はまだありません。" }));
    return;
  }
  body.append(el("p", { class: "muted", text: "API は呼びません。費用はかかりません。" }));
  const ul = el("ul", { class: "runs" });
  for (const r of out.runs) {
    ul.append(
      el(
        "li",
        {},
        el("button", {
          class: "btn small",
          type: "button",
          text: `${r.id}（${r.mode}、${Math.round(r.size / 1024)}KB）`,
          onclick: async () => {
            closeModal();
            await control({ cmd: "replay_start", run: r.id });
          },
        }),
      ),
    );
  }
  body.append(ul);
});

// ---------- モーダル ----------
function openModal(title, kind) {
  state.modalKind = kind;
  $("modal-title").textContent = title;
  const body = $("modal-body");
  clear(body);
  $("modal").hidden = false;
  return body;
}

function closeModal() {
  $("modal").hidden = true;
  state.cardFor = null;
  state.modalKind = null;
}

$("modal").addEventListener("click", (e) => {
  if (e.target.getAttribute && e.target.getAttribute("data-close")) closeModal();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !$("modal").hidden) closeModal();
});

// ---------- 人物カード ----------
$("map").addEventListener("click", (e) => {
  const who = map.hit(e.clientX, e.clientY);
  if (!who) return;
  state.cardFor = who;
  renderCard(who);
});

function stat(k, v, meter) {
  const box = el("div", { class: "stat" }, el("div", { class: "k", text: k }), el("div", { class: "v", text: v }));
  if (meter != null) {
    const m = el("div", { class: "bar-meter" });
    const s = el("span");
    s.style.width = `${Math.max(0, Math.min(100, meter * 100))}%`;
    m.append(s);
    box.append(m);
  }
  return box;
}

function renderCard(name) {
  const s = state.snap;
  if (!s) return;
  const r = s.residents.find((o) => o.name === name);
  const c = state.charByName[name];
  if (!r || !c) return;
  const body = state.modalKind === "card" && !$("modal").hidden ? $("modal-body") : openModal("", "card");
  state.cardFor = name;
  $("modal-title").textContent = `${c.name}（${c.age_job}）`;
  const scroll = body.scrollTop;
  clear(body);
  const wrap = el("div", { class: "card" });
  const grid = el("div", { class: "card-grid" });
  const items = Object.entries(r.items)
    .filter(([k, v]) => v > 0 && k !== "パン")
    .map(([k, v]) => `${k}${v}`)
    .join("、");
  grid.append(
    stat("いる場所", r.active ? r.loc : "（まだ町にいない）"),
    stat("所持金", `${r.coins} コイン`),
    stat("空腹度", `${r.hunger} / 10`, r.hunger / 10),
    stat("パン", `${r.items["パン"] || 0} 個${items ? `（ほか：${items}）` : ""}`),
    stat("気分", r.mood),
    stat("記憶", `${r.memoryCount} / ${r.memoryLimit} 件（忘れた ${r.forgotten}）`),
  );
  wrap.append(grid);
  wrap.append(el("h3", { text: "今の予定" }), el("p", { text: r.plan || "—" }));
  if (r.goal) wrap.append(el("h3", { text: "今日の目標（振り返りから）" }), el("p", { text: r.goal }));
  if (state.showThought) {
    if (r.thought) wrap.append(el("h3", { text: "最近の内心" }), el("p", { text: r.thought }));
    wrap.append(
      el("div", { class: "secret" }, el("strong", { text: "秘密：" }), document.createTextNode(c.secret), el("br"), el("strong", { text: "表向きの目的：" }), document.createTextNode(c.public_goal), el("br"), el("strong", { text: "集会の初めの意向：" }), document.createTextNode(c.meeting_initial)),
    );
  } else {
    wrap.append(el("p", { class: "muted", text: "「内心を表示」を入れると、内心と秘密も見られます。" }));
  }
  // 関係値
  wrap.append(el("h3", { text: "関係（-5〜+5）" }));
  for (const o of state.chars) {
    if (o.name === name) continue;
    const v = r.relations[o.name] || 0;
    const track = el("div", { class: "rel-track" });
    const bar = el("span");
    const half = 50;
    const w = Math.abs(v) * 10;
    bar.style.left = `${v >= 0 ? half : half - w}%`;
    bar.style.width = `${w}%`;
    bar.style.background = v >= 0 ? "#2f6b57" : "#c0432a";
    track.append(bar);
    wrap.append(el("div", { class: "rel" }, el("span", { text: o.short }), track, el("span", { text: v > 0 ? `+${v}` : String(v) })));
  }
  // 記憶
  wrap.append(el("h3", { text: "最近の記憶（重要度と新しさの上位10件）" }));
  const ul = el("ul");
  for (const m of r.memories) ul.append(el("li", { text: `[${m.day}日 ${m.time}] ${m.text}（${m.source}・重要度${m.importance}）` }));
  if (!r.memories.length) ul.append(el("li", { class: "muted", text: "まだない" }));
  wrap.append(ul);
  // 思い込み
  wrap.append(el("h3", { text: "振り返りで作った思い込み" }));
  const ub = el("ul");
  for (const b of r.beliefs) ub.append(el("li", { text: `${b.day}日目：${nameShort(b.about)}について — ${b.text}` }));
  if (!r.beliefs.length) ub.append(el("li", { class: "muted", text: "まだない（1日の終わりに作られます）" }));
  wrap.append(ub);
  body.append(wrap);
  body.scrollTop = scroll;
}

// ---------- 新聞 ----------
function onNewspaper(n, fresh) {
  state.newspapers[n.day] = n;
  if (fresh && state.mode === "replay") openNewspaper(n.day);
}

function renderMarkdown(md, root) {
  // 決まった形の Markdown だけを、要素と textContent で組み立てる
  let ul = null;
  for (const line of md.split("\n")) {
    if (line.startsWith("- ")) {
      if (!ul) {
        ul = el("ul");
        root.append(ul);
      }
      ul.append(el("li", { text: line.slice(2) }));
      continue;
    }
    ul = null;
    if (!line.trim()) continue;
    if (line.startsWith("### ")) root.append(el("h3", { text: line.slice(4) }));
    else if (line.startsWith("## ")) root.append(el("h2", { text: line.slice(3) }));
    else if (line.startsWith("# ")) root.append(el("h1", { text: line.slice(2) }));
    else if (line === "---") root.append(el("hr"));
    else root.append(el("p", { text: line }));
  }
}

function openNewspaper(day) {
  const n = state.newspapers[day];
  if (!n) return;
  const body = openModal(`凪野町報 ${day}日目号`, "news");
  const tabs = el("div", { class: "tabs" });
  for (const d of Object.keys(state.newspapers).map(Number).sort()) {
    tabs.append(el("button", { type: "button", class: d === day ? "btn small primary" : "btn small", text: `${d}日目`, onclick: () => openNewspaper(d) }));
  }
  tabs.append(
    el("button", {
      type: "button",
      class: "btn small",
      text: "Markdown を保存",
      onclick: () => download(`nagino_newspaper_day${day}.md`, new Blob([n.markdown], { type: "text/markdown" })),
    }),
  );
  if (state.status === "day_waiting" && state.mode !== "replay") {
    tabs.append(el("button", { type: "button", class: "btn small accent", text: "次の日へ", onclick: () => (closeModal(), control({ cmd: "next_day" })) }));
  }
  body.append(tabs);
  if (n.file) body.append(el("p", { class: "muted", text: `保存先：runs/${n.run || (state.hello && state.hello.run) || "（run）"}/${n.file}` }));
  const box = el("div", { class: "news" });
  renderMarkdown(n.markdown, box);
  body.append(box);
}

// ---------- 天の声のフォーム ----------
function openLetterForm() {
  const body = openModal("差出人不明の手紙を届ける", "letter");
  const sel = el("select", { id: "f-to" }, el("option", { value: "", text: "おまかせ（ランダム）" }));
  for (const c of state.chars) sel.append(el("option", { value: c.name, text: c.short }));
  const max = state.hello ? state.hello.world.heaven.free_text_max : 120;
  const ta = el("textarea", { id: "f-text", rows: "3", maxlength: String(max), placeholder: "空欄なら、決まった文面からランダムに選びます" });
  body.append(
    el("div", { class: "form-row" }, el("label", { for: "f-to", text: "宛先" }), sel),
    el("div", { class: "form-row" }, el("label", { for: "f-text", text: `手紙の文（${max}字まで）` }), ta),
    el("button", { type: "button", class: "btn primary", text: "届ける", onclick: () => (control({ cmd: "heaven", type: "letter", to: sel.value, text: ta.value }), closeModal()) }),
  );
}

function openFreeForm() {
  const body = openModal("自由入力の出来事", "free");
  const max = state.hello ? state.hello.world.heaven.free_text_max : 120;
  const input = el("input", { id: "f-free", type: "text", maxlength: String(max), placeholder: "例：港に大きな鯨が見えた" });
  const sel = el("select", { id: "f-place" }, el("option", { value: "", text: "町じゅう（全員が知る）" }));
  for (const p of state.hello.world.places) sel.append(el("option", { value: p.name, text: `${p.name}にいる人だけ` }));
  body.append(
    el("div", { class: "form-row" }, el("label", { for: "f-free", text: `出来事（1行、${max}字まで）` }), input),
    el("div", { class: "form-row" }, el("label", { for: "f-place", text: "誰が知るか" }), sel),
    el("button", {
      type: "button",
      class: "btn primary",
      text: "起こす",
      onclick: () => {
        if (!input.value.trim()) return toast("出来事の文を入れてください");
        control({ cmd: "heaven", type: "free", text: input.value, place: sel.value });
        closeModal();
      },
    }),
  );
  input.focus();
}

// フォントが読み込めたら描き直す（読み込めなくてもシステムフォントで描ける）
if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => map.draw());
connect();
