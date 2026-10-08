// 町のシミュレーション本体。
// 物の数・売り買い・受け渡し・投票の集計はすべてここ（プログラム）が判定する。AI の言い分では決めない。
import { actionSchema, reflectionSchema, newspaperSchema } from "../llm/schemas.js";
import { BudgetStop, FatalLlmError } from "../llm/gateway.js";
import * as mock from "../llm/mock.js";
import * as P from "./prompts.js";
import { addMemory, retrieve, formatMemory, topForCard, pinnedMemories } from "./memory.js";
import { hhmmToMin, minToHhmm, makeRng, cleanText, charLen, clamp } from "../util.js";

const ACTION_LABEL = {
  move: "移動",
  talk: "話す",
  work: "働く",
  buy: "買う",
  give: "渡す",
  eat: "食べる",
  rest: "休む",
  wait: "様子を見る",
  vote: "投票",
};

export class Town {
  constructor({ cfg, gateway, recorder, emit, mockInvalidRate = 0.03 }) {
    this.cfg = cfg;
    this.gw = gateway;
    this.rec = recorder;
    this.emitRaw = emit || (() => {});
    const w = cfg.world;
    this.w = w;
    this.rng = makeRng(w.seed);
    this.mockRng = makeRng(w.seed + 7);
    // シナリオで independent_rng を指定すると、かまどの傷みとランダムな出来事を住人の動きと切り離した乱数で決める
    // （同じ種なら、住人の返事が違っても同じ日時にかまどが傷み、同じ出来事が起きる。条件を比べやすくするため）
    this.ovenRng = w.bakery.oven.independent_rng ? makeRng(w.seed + 101) : this.rng;
    this.eventRng = w.random_events.independent_rng ? makeRng(w.seed + 202) : this.rng;
    this.cq = w.hunger.consequences || null; // 空腹の帰結（シナリオ2）。base では null
    this.noWork = (w.weather && w.weather.no_work_places) || [];
    this.mockInvalidRate = mockInvalidRate;
    this.schema = actionSchema(cfg.derived, w.moods);
    this.reflSchema = reflectionSchema(cfg.derived);
    this.newsSchema = newspaperSchema();
    this.rulesText = P.townRules(cfg);
    this.personaText = {};

    this.day = 1;
    this.tickIndex = 0;
    this.status = "ready";
    this.statusReason = "";
    this.finished = false;
    this.logSeq = 0;
    this.logs = [];
    this.dayPublic = [];
    this.newspapers = {};
    this.convSeq = 0;
    this.convs = new Map();
    this.heavenQueue = [];
    this.fund = w.town_fund;
    this.wallet = null;
    this.places = {};
    for (const p of w.places) this.places[p.name] = { closedUntilAbs: null };
    this.meeting = { phase: "none", speeches: [], votes: {}, result: null, announced: false };
    this.bakery = { stock: 0, health: w.bakery.oven.initial_health, bakedToday: 0, stoppedToday: false, batchesDone: new Set() };

    this.aliases = {};
    this.shortOf = {};
    this.res = new Map();
    for (const c of cfg.characters.residents) {
      this.aliases[c.name] = [c.name, c.short];
      this.shortOf[c.name] = c.short;
      this.personaText[c.name] = P.persona(cfg, c);
      const r = {
        name: c.name,
        short: c.short,
        initial: c.initial,
        color: c.color,
        c,
        active: !c.arrives,
        loc: c.arrives ? null : c.home,
        home: c.home,
        coins: c.coins,
        payFrac: 0,
        items: { パン: 0, 海図: 0, 財布: 0, ...(c.items || {}) },
        hunger: this.rng.int(w.hunger.initial_min, w.hunger.initial_max),
        hungerTriggered: false,
        mood: "ふつう",
        plan: null,
        activity: "idle",
        convId: null,
        perceptions: [],
        needsDecision: true,
        triggerSeq: 0,
        seqAtCall: 0,
        lastArrivalTrigger: -99,
        memory: [],
        memoryLimit: c.memory_limit,
        forgotten: 0,
        beliefs: [],
        relations: {},
        goal: "",
        diary: [],
        lastThought: "",
        afterConversation: null,
        calls: 0,
        failures: 0,
        transit: null, // 空腹で足が重く、移動の途中（シナリオ2）
        collapsedUntilAbs: null, // 空腹で座り込んでいる（シナリオ2）
        collapseArmed: true,
      };
      for (const m of c.initial_memories || []) {
        addMemory(r, { day: 1, minute: cfg.derived.dayStartMin, text: m.text, importance: m.importance, source: { type: "thought" }, pinned: !!m.pinned }, w.memory);
      }
      this.res.set(c.name, r);
    }
    for (const rel of cfg.characters.relations) this.res.get(rel.from).relations[rel.to] = rel.value;
    this.order = [...this.res.keys()];
    this.scheduleRandomEvents();
  }

  // ---------- 時刻 ----------
  get minute() {
    return this.cfg.derived.dayStartMin + this.tickIndex * this.w.time.tick_minutes;
  }
  get time() {
    return minToHhmm(this.minute);
  }
  get abs() {
    return (this.day - 1) * 1440 + this.minute;
  }
  get lastDay() {
    return this.w.time.days + (this.w.time.extension_days || 0);
  }

  // ---------- 記録と通知 ----------
  emit(type, payload) {
    this.emitRaw(type, payload);
  }

  log(entry) {
    const e = { seq: ++this.logSeq, day: this.day, time: this.time, ...entry };
    this.logs.push(e);
    this.rec.event({ type: "log", entry: e });
    this.emit("log", e);
    return e;
  }

  publicLine(text) {
    this.dayPublic.push(`${this.time} ${text}`);
  }

  setStatus(status, reason = "") {
    this.status = status;
    this.statusReason = reason;
    this.rec.event({ type: "status", day: this.day, time: this.time, status, reason });
    this.emit("status", { status, reason });
  }

  perceive(r, text, { memory = 0, trigger = true, source = { type: "self" } } = {}) {
    if (!r.active) return;
    r.perceptions.push(`${this.time} ${text}`);
    if (r.perceptions.length > 12) r.perceptions.splice(0, r.perceptions.length - 12);
    if (memory > 0) addMemory(r, { day: this.day, minute: this.minute, text, importance: memory, source }, this.w.memory);
    if (trigger) this.trigger(r);
  }

  /** 次のティックで考え直させる（会話中は会話の後で） */
  trigger(r) {
    if (r.convId) return;
    r.needsDecision = true;
    r.triggerSeq++;
  }

  activeResidents() {
    return this.order.map((n) => this.res.get(n)).filter((r) => r.active);
  }

  at(place, exceptName) {
    // 移動の途中の人（シナリオ2）は、まだどこにも着いていない
    return this.activeResidents().filter((r) => r.loc === place && r.name !== exceptName && !r.transit);
  }

  // ---------- 空腹の帰結と、仕事にならない場所（シナリオ2。base では何もしない） ----------
  hungerLv(r) {
    return P.hungerLevel(r.hunger);
  }

  isCollapsed(r) {
    return r.collapsedUntilAbs != null;
  }

  /** いまの場所で働けないなら、その理由（働けるなら空文字） */
  noWorkReason(r) {
    if (this.noWork.includes(r.loc)) return this.w.weather.no_work_note || `${r.loc}は今は仕事にならない`;
    if (this.cq && this.isCollapsed(r)) return "座り込んでいて働けない";
    if (this.cq && this.hungerLv(r) >= this.cq.no_work_at) return "腹が減りすぎて働けない";
    return "";
  }

  /** 会話で話せる回数（空腹だと半分） */
  talkCap(r) {
    const max = this.w.conversation.max_utterances_each;
    if (this.cq && this.hungerLv(r) >= this.cq.half_talk_at) return Math.floor(max / 2);
    return max;
  }

  untilText(abs) {
    return minToHhmm(Math.min(this.cfg.derived.dayEndMin, abs - (this.day - 1) * 1440));
  }

  /** 状態の欄に出す、いま効いている帰結（数字は出さない。条件A・Bで同じ文） */
  bodyNote(r) {
    if (!this.cq) return "";
    const lv = this.hungerLv(r);
    const parts = [];
    if (this.isCollapsed(r)) parts.push(`空腹で座り込んでいる。${this.untilText(r.collapsedUntilAbs)}までは動けず、働けない`);
    else {
      if (lv >= this.cq.no_work_at) parts.push("腹が減りすぎて働けない");
      if (lv >= this.cq.slow_move_at) parts.push(`足が重く、移動にいつもより${this.w.time.tick_minutes}分よけいにかかる`);
    }
    if (lv >= this.cq.half_talk_at) parts.push(`口が回らず、会話で話せる回数が半分（${this.talkCap(r)}回）になる`);
    return parts.join("。");
  }

  hungerFeelText(r) {
    const hg = this.w.hunger;
    if (hg.tell === "words") return `お腹がすいてきた。${P.hungerWord(hg, r.hunger)}`;
    return `お腹がすいてきた（空腹度${Math.round(r.hunger)}）`;
  }

  /** 空腹度が帰結の線を越えたか。毎ティック、空腹が上がったあとに呼ぶ */
  applyHungerConsequences(r) {
    const cq = this.cq;
    const s = r.short;
    if (this.isCollapsed(r) && this.abs >= r.collapsedUntilAbs) {
      r.collapsedUntilAbs = null;
      this.perceive(r, "しばらく座り込んでいたが、どうにか立てそうだ", { memory: 3 });
      this.log({ kind: "event", who: r.name, place: r.loc, text: `${s}は立ち上がれるようになった` });
    }
    const lv = this.hungerLv(r);
    if (lv < cq.collapse_at) {
      r.collapseArmed = true;
      return;
    }
    if (!r.collapseArmed) return;
    // 空腹度10：働けない。その場に座り込み、決まった時間は移動もできない
    r.collapseArmed = false;
    r.collapsedUntilAbs = this.abs + cq.collapse_ticks * this.w.time.tick_minutes;
    if (!r.convId) {
      r.activity = "rest";
      r.plan = null;
    }
    const hg = this.w.hunger;
    const until = this.untilText(r.collapsedUntilAbs);
    const feel = hg.tell === "words" ? `${P.hungerWord(hg, r.hunger)}。` : `空腹度が${lv}になった。`;
    this.perceive(r, `${feel}その場に座り込んでしまった。${until}までは動けず、働けない`, { memory: 7 });
    for (const o of this.at(r.loc, r.name)) this.perceive(o, `${s}が腹をすかせて、その場に座り込んでしまった`, { memory: 5 });
    this.log({ kind: "event", who: r.name, place: r.loc, text: `${s}は空腹のあまり${r.loc}で座り込んだ（${until}まで動けない）` });
    this.publicLine(`${r.loc}で${s}が空腹のあまり座り込んだ`);
  }

  /** 移動の途中の人を、目的地に着かせる（ティックの頭で） */
  resolveTransits() {
    for (const r of this.activeResidents()) {
      if (r.transit && this.abs >= r.transit.untilAbs) {
        const from = r.transit.from;
        r.transit = null;
        this.onArrive(r, from);
      }
    }
  }

  isClosed(place) {
    const p = this.places[place];
    return p && p.closedUntilAbs != null && this.abs < p.closedUntilAbs;
  }

  openPlaces() {
    return this.cfg.derived.placeNames.filter((p) => !this.isClosed(p));
  }

  // ---------- スナップショット（画面と再生用） ----------
  snapshot() {
    const nowAbs = this.abs;
    const hg = this.w.hunger;
    // シナリオで足した項目は、使っているときだけ載せる（base の記録を今までと同じにするため）
    const extra = (r) => ({
      ...(r.transit ? { transit: true } : {}),
      ...(this.isCollapsed(r) ? { collapsedUntil: this.untilText(r.collapsedUntilAbs) } : {}),
      ...(hg.tell === "words" ? { hungerWord: P.hungerWord(hg, r.hunger) } : {}),
    });
    return {
      day: this.day,
      time: this.time,
      tick: this.tickIndex,
      lastDay: this.lastDay,
      status: this.status,
      statusReason: this.statusReason,
      fund: this.fund,
      ...(this.w.weather ? { weather: { label: this.w.weather.label, noWork: this.noWork } } : {}),
      bakery: {
        stock: this.bakery.stock,
        baked: this.bakery.bakedToday,
        stopped: this.bakery.stoppedToday,
        ...(this.bakery.broken ? { broken: true } : {}),
        ...(this.bakery.replaced ? { replaced: true } : {}),
      },
      places: Object.fromEntries(Object.keys(this.places).map((p) => [p, { closed: this.isClosed(p) }])),
      wallet: this.wallet ? { place: this.wallet.holder ? null : this.wallet.place, holder: this.wallet.holder } : null,
      meeting: { phase: this.meeting.phase, result: this.meeting.result },
      conversations: [...this.convs.values()].map((c) => ({ id: c.id, a: c.a, b: c.b, place: c.place })),
      residents: this.order.map((n) => {
        const r = this.res.get(n);
        return {
          name: r.name,
          short: r.short,
          initial: r.initial,
          color: r.color,
          active: r.active,
          loc: r.loc,
          home: r.home,
          coins: r.coins,
          hunger: Math.round(r.hunger * 10) / 10,
          items: { ...r.items },
          mood: r.mood,
          activity: r.convId ? "talk" : r.activity,
          plan: r.plan ? `${r.plan.desc}（${minToHhmm(r.plan.until)}まで）` : "",
          goal: r.goal,
          thought: r.lastThought,
          relations: { ...r.relations },
          beliefs: r.beliefs.slice(-5).map((b) => ({ about: b.about, text: b.text, day: b.day })),
          memories: topForCard(r, this.w.memory.card_top_n, nowAbs),
          memoryCount: r.memory.length,
          memoryLimit: r.memoryLimit,
          forgotten: r.forgotten,
          canVote: r.c.can_vote,
          ...extra(r),
        };
      }),
    };
  }

  // ---------- 予定された出来事 ----------
  scheduleRandomEvents() {
    const re = this.w.random_events;
    this.randomToday = [];
    if (!re.enabled) return;
    const rng = this.eventRng;
    const n = rng.int(re.per_day_min, re.per_day_max);
    const lo = hhmmToMin(re.earliest);
    const hi = hhmmToMin(re.latest);
    const tm = this.w.time.tick_minutes;
    for (let i = 0; i < n; i++) {
      const min = lo + Math.floor(rng.next() * ((hi - lo) / tm + 1)) * tm;
      this.randomToday.push({ min, ev: rng.pick(re.pool) });
    }
  }

  // ---------- パン屋のかまど ----------
  /** 1回分を焼く */
  bakeBatch(bt) {
    const bk = this.w.bakery;
    this.bakery.batchesDone.add(bt);
    if (this.bakery.stoppedToday) return;
    if (this.bakery.broken) {
      this.ovenColdMorning(bt);
      return;
    }
    const per = Math.round((bk.daily_capacity * this.bakery.health) / bk.batches.length);
    const n = Math.max(0, Math.min(per, bk.daily_capacity - this.bakery.bakedToday));
    this.bakery.stock += n;
    this.bakery.bakedToday += n;
    this.log({ kind: "event", place: bk.place, text: `パン屋で${n}個焼き上がった（棚に${this.bakery.stock}個）` });
    const owner = this.res.get(bk.owner);
    if (owner && this.bakery.health < 0.95) {
      this.perceive(owner, `かまどの火の回りが悪い。焼けたのは${n}個だけ`, { memory: 5, trigger: false });
    }
    this.wearOven();
  }

  /** シナリオ2：焼くたびにかまどが傷み、線を下回ると止まる（base には batch_decay も break_below も無い） */
  wearOven() {
    const ov = this.w.bakery.oven;
    if (!(ov.batch_decay_max > 0)) return;
    const d = ov.batch_decay_min + this.ovenRng.next() * (ov.batch_decay_max - ov.batch_decay_min);
    this.bakery.health = Math.max(ov.min_health, this.bakery.health - d);
    this.checkOvenBreak("batch");
  }

  checkOvenBreak(when) {
    const ov = this.w.bakery.oven;
    if (ov.break_below === undefined || this.bakery.broken || this.bakery.health >= ov.break_below) return;
    this.bakery.broken = true;
    this.bakery.brokenAnnounced = false;
    this.bakery.brokenAt = { day: this.day, time: this.time, when };
    this.rec.event({ type: "oven", day: this.day, time: this.time, broken: true, when, health: Math.round(this.bakery.health * 1000) / 1000 });
    if (when === "batch") this.announceOvenBreak("焼き上げたあと、かまどの火がふっと落ちた。どうやっても点かない。もうパンは焼けない");
    else if (when === "heaven") this.bakery.brokenAnnounced = true; // 天の声の知らせで本人は知っている
  }

  announceOvenBreak(text) {
    const bk = this.w.bakery;
    this.bakery.brokenAnnounced = true;
    const owner = this.res.get(bk.owner);
    if (owner) this.perceive(owner, text, { memory: 9 });
    for (const r of this.at(bk.place, bk.owner)) this.perceive(r, "パン屋のかまどが止まったらしい", { memory: 6 });
    this.log({ kind: "event", place: bk.place, text: "パン屋のかまどが止まった（もう焼けない）" });
    this.publicLine("パン屋のかまどが止まった");
  }

  /** 止まったかまどの朝 */
  ovenColdMorning(bt) {
    if (bt !== this.w.bakery.batches[0]) return;
    if (!this.bakery.brokenAnnounced) {
      this.announceOvenBreak("朝、かまどに火を入れようとしたが、どうしても点かない。もうパンは焼けない");
      return;
    }
    const owner = this.res.get(this.w.bakery.owner);
    if (owner) this.perceive(owner, "かまどは冷えたまま。今日もパンは焼けない", { memory: 4, trigger: false });
    this.log({ kind: "event", place: this.w.bakery.place, text: "パン屋のかまどは冷えたまま（焼けない）" });
  }

  applyScheduled() {
    const min = this.minute;
    // 到着
    for (const ev of this.w.scheduled_events) {
      if (ev.day === this.day && hhmmToMin(ev.time) === min && ev.type === "arrival") {
        const r = this.res.get(ev.who);
        if (r && !r.active) {
          r.active = true;
          r.loc = ev.place;
          r.needsDecision = true;
          this.perceive(r, `長い旅のすえ、${ev.place}に着いた`, { memory: 5 });
          for (const o of this.at(ev.place, r.name)) this.perceive(o, `見慣れない行商人（${r.short}）が${ev.place}に着いた`, { memory: 6 });
          this.log({ kind: "event", who: r.name, place: ev.place, text: `行商人${r.short}が${ev.place}に着いた` });
          this.publicLine(`${ev.place}に行商人${r.short}が到着した`);
        }
      }
    }
    // パンを焼く
    for (const bt of this.w.bakery.batches) {
      if (hhmmToMin(bt) === min && !this.bakery.batchesDone.has(bt)) this.bakeBatch(bt);
    }
    // ランダムな出来事
    for (const it of this.randomToday) {
      if (it.min === min) {
        const people = this.at(it.ev.place);
        for (const r of people) this.perceive(r, it.ev.text, { memory: 4 });
        this.log({ kind: "event", place: it.ev.place, text: it.ev.text });
        this.publicLine(`${it.ev.place}で：${it.ev.text}`);
      }
    }
    // 嵐が去る
    for (const [name, p] of Object.entries(this.places)) {
      if (p.closedUntilAbs != null && this.abs >= p.closedUntilAbs) {
        p.closedUntilAbs = null;
        if (!this.stormEndLogged) {
          this.stormEndLogged = true;
          for (const r of this.activeResidents()) this.perceive(r, "嵐が去った。港と広場にまた出られる", { memory: 3 });
          this.log({ kind: "event", text: "嵐が去った" });
          this.publicLine("嵐が去った");
        }
      }
    }
    // 集会の予告
    const m = this.w.meeting;
    if (this.day === m.day && min === hhmmToMin(m.announce_time) && !this.meeting.announced) {
      this.meeting.announced = true;
      for (const r of this.activeResidents()) this.perceive(r, `まもなく${m.time}から${m.place}で町民集会が始まる`, { memory: 5 });
      this.log({ kind: "event", text: `${m.time}から${m.place}で町民集会（予告）` });
    }
  }

  // ---------- 天の声 ----------
  queueHeaven(ev) {
    this.heavenQueue.push(ev);
  }

  applyHeaven() {
    const q = this.heavenQueue.splice(0);
    for (const ev of q) {
      const t = ev.type;
      if (t === "storm") this.heavenStorm();
      else if (t === "wallet") this.heavenWallet();
      else if (t === "oven") this.heavenOven();
      else if (t === "letter") this.heavenLetter(ev);
      else if (t === "free") this.heavenFree(ev);
    }
  }

  heavenStorm() {
    const h = this.w.heaven;
    const until = this.abs + h.storm_ticks * this.w.time.tick_minutes;
    for (const p of h.storm_closed_places) this.places[p].closedUntilAbs = until;
    this.stormEndLogged = false;
    for (const r of this.activeResidents()) {
      if (h.storm_closed_places.includes(r.loc)) {
        if (r.convId) this.endConversation(this.convs.get(r.convId), "嵐で中断");
        r.loc = h.storm_shelter;
        r.plan = null;
        r.activity = "idle";
        this.perceive(r, `嵐が来た！ あわてて${h.storm_shelter}へ逃げ込んだ`, { memory: 6 });
      } else {
        this.perceive(r, `嵐が来た。${h.storm_closed_places.join("と")}にはしばらく出られない`, { memory: 5 });
      }
    }
    this.log({ kind: "heaven", text: `【天の声】嵐が来た（${h.storm_closed_places.join("・")}は${minToHhmm(this.minute + h.storm_ticks * this.w.time.tick_minutes)}ごろまで入れない）` });
    this.publicLine("嵐が町を襲った");
  }

  heavenWallet() {
    if (this.wallet) {
      this.log({ kind: "system", text: "（財布はすでに町にあるため、新しい財布は落ちなかった）" });
      return;
    }
    const coins = this.w.heaven.wallet_coins;
    const candidates = this.activeResidents().filter((r) => r.coins >= coins);
    const owner = candidates.length ? this.rng.pick(candidates) : null;
    if (owner) {
      owner.coins -= coins;
      this.perceive(owner, `財布がない！ ${coins}コイン入っていたのに、どこかで落としたらしい`, { memory: 8 });
    }
    this.wallet = { owner: owner ? owner.name : null, coins, place: "広場", holder: null, day: this.day };
    this.log({ kind: "heaven", text: `【天の声】広場に財布が落ちている（${coins}コイン入り）`, thought: owner ? `持ち主は${owner.short}` : "持ち主は町の外の人" });
    const here = this.at("広場");
    if (here.length) this.pickUpWallet(this.rng.pick(here));
  }

  pickUpWallet(r) {
    if (!this.wallet || this.wallet.holder) return;
    if (this.wallet.owner === r.name) {
      // 持ち主本人が見つけた：中身ごと取り戻す
      r.coins += this.wallet.coins;
      this.perceive(r, `広場で、自分が落とした財布を見つけた（${this.wallet.coins}コイン、中身は無事）`, { memory: 6 });
      this.log({ kind: "event", who: r.name, place: "広場", text: `${r.short}が自分の落とした財布を見つけた` });
      this.publicLine(`${r.short}が広場で落とした財布を見つけた`);
      this.wallet = null;
      return;
    }
    this.wallet.holder = r.name;
    r.items["財布"] = 1;
    this.perceive(r, `広場で財布を拾った。中に${this.wallet.coins}コイン。持ち主は分からない`, { memory: 7 });
    this.log({ kind: "event", who: r.name, place: "広場", text: `${r.short}が財布を拾った` });
  }

  heavenOven() {
    this.bakery.stoppedToday = true;
    this.bakery.health = Math.max(this.w.bakery.oven.min_health, this.bakery.health - 0.3);
    this.checkOvenBreak("heaven");
    const owner = this.res.get(this.w.bakery.owner);
    if (owner) this.perceive(owner, "かまどの火が消えて、どうやっても点かない！ 今日はもう焼けない", { memory: 9 });
    for (const r of this.at(this.w.bakery.place, this.w.bakery.owner)) this.perceive(r, "パン屋のかまどが止まったらしい", { memory: 6 });
    this.log({ kind: "heaven", text: "【天の声】パン屋のかまどが止まった" });
    this.publicLine("パン屋のかまどが止まった");
  }

  heavenLetter(ev) {
    const pool = ["灯台の秘密を知っている者が、この町にいる", "集会では、本当のことを言え", "パンを盗んだ者を、私は知っている", "桟橋の話には裏がある"];
    let to = ev.to && this.res.get(ev.to) && this.res.get(ev.to).active ? this.res.get(ev.to) : this.rng.pick(this.activeResidents());
    const text = cleanText(ev.text, this.w.heaven.free_text_max) || this.rng.pick(pool);
    this.perceive(to, `差出人不明の手紙が届いた。「${text}」`, { memory: 8, source: { type: "letter" } });
    const saki = [...this.res.values()].find((r) => r.c.work_note.includes("郵便") && r.active && r.name !== to.name);
    if (saki) this.perceive(saki, `差出人の書いていない手紙を${to.short}に届けた`, { memory: 5, trigger: false });
    this.log({ kind: "heaven", who: to.name, text: `【天の声】${to.short}に差出人不明の手紙が届いた：「${text}」` });
  }

  heavenFree(ev) {
    const text = cleanText(ev.text, this.w.heaven.free_text_max);
    if (!text) return;
    const place = this.cfg.derived.placeNames.includes(ev.place) ? ev.place : null;
    const targets = place ? this.at(place) : this.activeResidents();
    for (const r of targets) this.perceive(r, text, { memory: 6 });
    this.log({ kind: "heaven", place, text: `【天の声】${place ? `（${place}）` : ""}${text}` });
    this.publicLine(text);
  }

  // ---------- 1ティック ----------
  async tick() {
    if (this.finished) return;
    if (this.tickIndex === 0 && !this.dayStarted) this.startOfDay();
    this.resolveTransits();
    this.applyScheduled();
    this.applyHeaven();
    this.updateBodies();

    const m = this.w.meeting;
    if (this.day === m.day && this.minute === hhmmToMin(m.time) && this.meeting.phase === "none") {
      await this.runMeeting();
      this.emitTick();
      if (this.w.time.end_after_meeting) {
        await this.endOfDay(true);
        return;
      }
    } else {
      await this.decideAll();
      await this.advanceConversations();
      this.emitTick();
    }

    this.tickIndex++;
    if (this.minute >= this.cfg.derived.dayEndMin) {
      await this.endOfDay(this.day >= this.lastDay);
    }
  }

  emitTick() {
    const snap = this.snapshot();
    this.rec.event({ type: "tick", snapshot: snap });
    this.emit("snapshot", snap);
  }

  startOfDay() {
    this.dayStarted = true;
    this.dayPublic = [];
    this.log({ kind: "system", text: `── ${this.day}日目の朝 ──` });
  }

  updateBodies() {
    const tm = this.w.time.tick_minutes;
    const hg = this.w.hunger;
    for (const r of this.activeResidents()) {
      r.hunger = clamp(r.hunger + (hg.per_hour * tm) / 60, 0, 10);
      // 帰結のあるシナリオでは、帰結と同じ段階（丸めた空腹度）で知らせる
      const h = this.cq ? this.hungerLv(r) : r.hunger;
      if (h >= hg.trigger_threshold && !r.hungerTriggered) {
        r.hungerTriggered = true;
        this.perceive(r, this.hungerFeelText(r), { memory: 3 });
      } else if (h < hg.trigger_threshold) {
        r.hungerTriggered = false;
      }
      if (this.cq) this.applyHungerConsequences(r);
      if (r.activity === "work" && r.c.work_places.includes(r.loc) && !r.convId && !this.noWorkReason(r)) {
        r.payFrac += (this.w.work_pay_per_hour[r.name] * tm) / 60;
        const whole = Math.floor(r.payFrac);
        if (whole > 0) {
          r.coins += whole;
          r.payFrac -= whole;
        }
      }
    }
  }

  // ---------- 行動の決定 ----------
  needsCall(r) {
    if (!r.active || r.convId || r.transit) return false;
    return r.needsDecision || !r.plan || this.minute >= r.plan.until;
  }

  async decideAll() {
    const who = this.activeResidents().filter((r) => this.needsCall(r));
    if (!who.length) return;
    const results = await Promise.all(who.map((r) => this.askResident(r, "action")));
    const pending = new Map();
    who.forEach((r, i) => pending.set(r.name, results[i]));
    for (const r of this.rng.shuffle(who)) {
      const out = pending.get(r.name);
      pending.delete(r.name);
      if (r.convId) {
        // ほかの人に話しかけられて会話が始まった：自分で決めた行動は取りやめ
        if (out && out.value) this.log({ kind: "thought", who: r.name, place: r.loc, text: `（話しかけられたので「${ACTION_LABEL[out.value.action]}」は取りやめ）`, thought: out.value.thought });
        continue;
      }
      this.applyDecision(r, out, "action");
    }
  }

  /**
   * 住人に1回聞く。mode: action / talk / speech / vote / tiebreak
   * 返り値 { value }（失敗なら value は null）
   */
  async askResident(r, mode, extra = {}) {
    const ctx = this.situationContext(r, mode, extra);
    const includedPerceptions = ctx.perceptions.length;
    r.seqAtCall = r.triggerSeq;
    const role = mode === "action" || mode === "vote" || mode === "tiebreak" ? "action" : "talk";
    let userText = null;
    for (const k of [this.w.memory.retrieve_top_k, 10, 5, 0]) {
      ctx.memories = this.memoriesFor(r, k);
      userText = P.situation(ctx);
      if (this.gw.fits([this.rulesText, this.personaText[r.name]], userText, this.schema).ok) break;
      userText = null;
    }
    r.calls++;
    if (!userText) {
      r.failures++;
      this.log({ kind: "system", who: r.name, text: `${r.short}への入力が長すぎるため呼び出しを見送った` });
      return { value: null };
    }
    const hint = this.mockHint(r, mode, ctx, extra);
    const res = await this.gw.call({
      role,
      resident: r.name,
      systemTexts: [this.rulesText, this.personaText[r.name]],
      userText,
      schema: this.schema,
      schemaName: "action",
      check: (v) => this.checkAction(r, v, mode, extra),
      mock: (attempt) => {
        if (mode === "talk") return mock.mockTalk(hint, this.mockRng, attempt);
        if (mode === "speech") return mock.mockSpeech(hint, this.mockRng);
        if (mode === "vote" || mode === "tiebreak") return mock.mockVote(hint, this.mockRng);
        return mock.mockAction(hint, this.mockRng, attempt);
      },
    });
    r.perceptions.splice(0, includedPerceptions);
    if (!res.ok) {
      r.failures++;
      this.log({ kind: "fail", who: r.name, place: r.loc, text: `${r.short}の応答が規則に合わなかったため「様子を見る」にした`, detail: res.errors.slice(0, 3).join(" / ") });
      return { value: null };
    }
    return { value: this.sanitize(res.value) };
  }

  sanitize(v) {
    return {
      ...v,
      thought: cleanText(v.thought, 40, { ellipsis: true }),
      say: cleanText(v.say, 60, { ellipsis: true }),
      remember: (v.remember || []).slice(0, this.w.memory.max_remember_per_call).map((m) => ({
        text: cleanText(m.text, this.w.memory.max_text_chars),
        importance: clamp(m.importance, 1, 10),
      })),
    };
  }

  memoriesFor(r, k) {
    if (k <= 0) return [];
    const people = this.at(r.loc, r.name).map((o) => o.name);
    return retrieve(r, { nowAbs: this.abs, place: r.loc, people }, k, this.w.memory, this.aliases).map((m) =>
      formatMemory(m, this.cfg.derived.dayStartMin),
    );
  }

  /** 許可リストによる検証。ここで落ちたら理由を添えて1回だけ再試行される */
  checkAction(r, v, mode, extra) {
    const errs = [];
    const placeNames = this.cfg.derived.placeNames;
    const presentNames = this.at(r.loc, r.name).map((o) => o.name);
    const pu = hhmmToMin(v.plan_until);
    if (pu == null) errs.push(`plan_until「${v.plan_until}」は時刻として読めない`);

    if (mode === "speech") {
      if (v.action !== "talk") errs.push("集会の意見表明では action は talk にする");
      if (!v.say.trim()) errs.push("say に意見を書く");
      return errs;
    }
    if (mode === "vote" || mode === "tiebreak") {
      const allowed = extra.options || this.w.meeting.options;
      if (v.action !== "vote") errs.push("投票では action は vote にする");
      if (!allowed.includes(v.target)) errs.push(`target は ${allowed.join("・")} のどれか`);
      return errs;
    }
    if (mode === "talk") {
      const conv = this.convs.get(r.convId);
      if (v.action === "talk") {
        if (!conv) errs.push("会話はもう終わっている");
        else if (v.target !== extra.partner) errs.push(`会話を続けるなら target は ${extra.partner}`);
        if (!v.say.trim()) errs.push("会話を続けるなら say に発言を書く");
        return errs;
      }
      // 会話を終えて別の行動に移る：以下の通常の検証へ
    }
    switch (v.action) {
      case "move":
        if (!placeNames.includes(v.target)) errs.push(`move の target は場所名（${placeNames.join("・")}）`);
        else if (this.isClosed(v.target)) errs.push(`${v.target}は今は入れない`);
        else if (this.isCollapsed(r) && v.target !== r.loc) errs.push(`空腹で座り込んでいて、${this.untilText(r.collapsedUntilAbs)}までは動けない`);
        break;
      case "talk":
        if (!presentNames.includes(v.target)) {
          errs.push(presentNames.length ? `talk の target は、ここにいる人（${presentNames.join("・")}）` : "ここには話しかけられる人がいない");
        } else if (this.res.get(v.target).convId && mode !== "talk") {
          // 話し中の相手には話しかけられない（実行時にも判定する）
          errs.push(`${v.target}は今ほかの人と話し中`);
        }
        if (!v.say.trim()) errs.push("talk では say に最初の一言を書く");
        break;
      case "work":
        if (!r.c.work_places.includes(r.loc)) errs.push(`ここは職場ではない（職場：${r.c.work_places.join("・")}）。先に move する`);
        else if (this.noWorkReason(r)) errs.push(`今は働けない（${this.noWorkReason(r)}）`);
        break;
      case "buy":
        if (r.loc !== this.w.bakery.place) errs.push("buy はパン屋でだけできる");
        if (v.item && v.item !== "パン") errs.push("買えるのはパンだけ（item は「パン」）");
        if (v.amount < 1) errs.push("amount は1以上");
        break;
      case "give":
        if (!presentNames.includes(v.target)) errs.push(presentNames.length ? `give の target は、ここにいる人（${presentNames.join("・")}）` : "ここには渡せる相手がいない");
        if (!["コイン", "パン", "海図", "財布"].includes(v.item)) errs.push("give の item はコイン・パン・海図・財布のどれか");
        if (v.amount < 1) errs.push("amount は1以上");
        break;
      case "vote":
        errs.push("vote は集会の投票のときだけ");
        break;
      default:
        break;
    }
    return errs;
  }

  /** 決まった行動を町に反映する。out.value が null なら wait 扱い */
  applyDecision(r, out, mode, { partner = null } = {}) {
    const tm = this.w.time.tick_minutes;
    const v = out && out.value ? out.value : null;
    if (!v) {
      r.plan = { action: "wait", desc: "様子を見る", until: Math.min(this.cfg.derived.dayEndMin, this.minute + tm) };
      r.activity = "wait";
      r.needsDecision = r.triggerSeq > r.seqAtCall;
      return;
    }
    r.mood = v.mood;
    r.lastThought = v.thought;
    // 記憶（会話の直後なら、会話の要点を自分の言葉で）
    const conv = r.afterConversation;
    for (const m of v.remember) {
      const src = partner || conv ? { type: "talk", from: this.shortOf[partner || conv.partner] } : { type: "thought" };
      addMemory(r, { day: this.day, minute: this.minute, text: m.text, importance: m.importance, source: src }, this.w.memory);
    }
    r.afterConversation = null;
    r.needsDecision = r.triggerSeq > r.seqAtCall; // 呼び出しの後に起きたことには、次のティックで反応する

    let until = hhmmToMin(v.plan_until);
    if (until == null || until <= this.minute) until = this.minute + this.w.triggers.default_plan_minutes;
    until = Math.min(this.cfg.derived.dayEndMin, Math.max(this.minute + this.w.triggers.min_plan_minutes, until));

    const res = this.execute(r, v);
    r.plan = { action: v.action, target: v.target, desc: res.desc, until };
    this.log({
      kind: res.ok ? "action" : "fail",
      who: r.name,
      place: r.loc,
      action: v.action,
      target: v.target,
      text: res.text,
      thought: v.action === "talk" && res.ok ? "" : v.thought,
      mood: v.mood,
      raw: v,
    });
    if (res.after) res.after();
    if (!res.ok) {
      this.perceive(r, `（失敗）${res.text}`, { trigger: false });
      r.plan.until = Math.min(r.plan.until, this.minute + tm); // 次のティックでまた考える
    }
  }

  /** 行動の実行。在庫やお金が足りなければ失敗にする */
  execute(r, v) {
    const s = r.short;
    const bk = this.w.bakery;
    switch (v.action) {
      case "move": {
        if (v.target === r.loc) {
          // いまいる場所への移動は「その場にいる」と同じ（再試行の費用を使わない）
          r.activity = "wait";
          return { ok: true, text: `${s}は${r.loc}にとどまった`, desc: `${r.loc}で過ごす` };
        }
        if (this.isClosed(v.target)) return { ok: false, text: `${s}は${v.target}へ行こうとしたが、入れなかった`, desc: "様子を見る" };
        if (this.isCollapsed(r)) return { ok: false, text: `${s}は立ち上がろうとしたが、足に力が入らなかった`, desc: "座り込んでいる" };
        const from = r.loc;
        r.loc = v.target;
        r.activity = "idle";
        if (this.cq && this.hungerLv(r) >= this.cq.slow_move_at) {
          // 空腹で足が重い：着くのは次のティック。それまではどこにもいない扱い
          r.transit = { from, untilAbs: this.abs + this.w.time.tick_minutes };
          return { ok: true, text: `${s}は${from}から${v.target}へ向かった（腹が減って足が重い）`, desc: `${v.target}へ向かう` };
        }
        this.onArrive(r, from);
        return { ok: true, text: `${s}は${from}から${v.target}へ向かった`, desc: `${v.target}で過ごす` };
      }
      case "talk": {
        const t = this.res.get(v.target);
        if (!t || t.loc !== r.loc || !t.active) return { ok: false, text: `${s}は${this.shortOf[v.target] || v.target}に話しかけようとしたが、もういなかった`, desc: "様子を見る" };
        if (t.convId) {
          const c = this.convs.get(t.convId);
          if (c && (c.a === r.name || c.b === r.name)) return { ok: true, text: `${s}は${t.short}との会話を続けた`, desc: "話している" };
          return { ok: false, text: `${s}は${t.short}に話しかけようとしたが、話し中だった`, desc: "様子を見る" };
        }
        const conv = this.startConversation(r, t, v);
        // 「話しかけた」の行のあとに最初の一言を出す
        return { ok: true, text: `${s}が${t.short}に話しかけた`, desc: `${t.short}と話す`, after: () => this.logSay(r, t, v.say, v.thought, conv.place) };
      }
      case "work": {
        if (!r.c.work_places.includes(r.loc)) return { ok: false, text: `${s}は働こうとしたが、ここは職場ではなかった`, desc: "様子を見る" };
        if (this.noWorkReason(r)) return { ok: false, text: `${s}は働こうとしたが、${this.noWorkReason(r)}`, desc: "様子を見る" };
        r.activity = "work";
        return { ok: true, text: `${s}は${r.loc}で働き始めた`, desc: `${r.loc}で働く` };
      }
      case "buy": {
        const n = v.amount;
        const owner = this.res.get(bk.owner);
        const isOwner = r.name === bk.owner;
        r.activity = "idle";
        if (r.loc !== bk.place) return { ok: false, text: `${s}はパンを買おうとしたが、パン屋にいなかった`, desc: "様子を見る" };
        if (bk.owner_must_be_present && !isOwner && !(owner && owner.active && owner.loc === bk.place)) {
          return { ok: false, text: `${s}はパンを買おうとしたが、店主の${owner.short}が店にいなかった`, desc: "様子を見る" };
        }
        if (n > bk.max_per_purchase) return { ok: false, text: `${s}はパンを${n}個買おうとしたが、一度に買えるのは${bk.max_per_purchase}個まで`, desc: "様子を見る" };
        if (this.bakery.stock < n) return { ok: false, text: `${s}はパンを${n}個買おうとしたが、棚には${this.bakery.stock}個しかなかった`, desc: "様子を見る" };
        const price = isOwner ? 0 : n * bk.price;
        if (r.coins < price) return { ok: false, text: `${s}はパンを${n}個買おうとしたが、お金が足りなかった（${r.coins}コイン）`, desc: "様子を見る" };
        r.coins -= price;
        if (!isOwner) owner.coins += price;
        this.bakery.stock -= n;
        r.items["パン"] += n;
        if (!isOwner) this.perceive(owner, `${s}がパンを${n}個買っていった`, { trigger: false });
        this.publicLine(`パン屋で${s}がパンを${n}個買った`);
        return { ok: true, text: isOwner ? `${s}は店のパンを${n}個取り分けた` : `${s}はパンを${n}個買った（${price}コイン）`, desc: "パンを買って過ごす" };
      }
      case "give": {
        const t = this.res.get(v.target);
        const n = v.amount;
        r.activity = "idle";
        if (!t || t.loc !== r.loc || !t.active) return { ok: false, text: `${s}は${this.shortOf[v.target] || v.target}に渡そうとしたが、相手がいなかった`, desc: "様子を見る" };
        if (v.item === "コイン") {
          if (r.coins < n) return { ok: false, text: `${s}は${t.short}にコインを${n}枚渡そうとしたが、足りなかった`, desc: "様子を見る" };
          r.coins -= n;
          t.coins += n;
        } else if (v.item === "財布") {
          if (!this.wallet || this.wallet.holder !== r.name) return { ok: false, text: `${s}は財布を渡そうとしたが、持っていなかった`, desc: "様子を見る" };
          r.items["財布"] = 0;
          if (this.wallet.owner === t.name) {
            t.coins += this.wallet.coins;
            this.perceive(t, `${s}が、落とした財布を届けてくれた（${this.wallet.coins}コイン）`, { memory: 8 });
            this.log({ kind: "event", who: t.name, text: `財布が持ち主の${t.short}に戻った` });
            this.publicLine(`${s}が拾った財布が持ち主の${t.short}に戻った`);
            this.wallet = null;
            t.relations[r.name] = clamp((t.relations[r.name] || 0) + 1, -5, 5);
            return { ok: true, text: `${s}は${t.short}に財布を渡した`, desc: "様子を見る" };
          }
          this.wallet.holder = t.name;
          t.items["財布"] = 1;
        } else {
          if ((r.items[v.item] || 0) < n) return { ok: false, text: `${s}は${t.short}に${v.item}を${n}渡そうとしたが、足りなかった`, desc: "様子を見る" };
          r.items[v.item] -= n;
          t.items[v.item] = (t.items[v.item] || 0) + n;
        }
        const unit = v.item === "コイン" ? "枚" : v.item === "パン" ? "個" : "";
        this.perceive(t, `${s}から${v.item}を${n}${unit}受け取った`, { memory: 5 });
        if (v.item === "コイン" || v.item === "パン") t.relations[r.name] = clamp((t.relations[r.name] || 0) + 1, -5, 5);
        this.publicLine(`${r.loc}で${s}が${t.short}に${v.item}を${n}${unit}渡した`);
        return { ok: true, text: `${s}は${t.short}に${v.item}を${n}${unit}渡した`, desc: "様子を見る" };
      }
      case "eat": {
        r.activity = "idle";
        if ((r.items["パン"] || 0) < 1) return { ok: false, text: `${s}は食べようとしたが、パンを持っていなかった`, desc: "様子を見る" };
        r.items["パン"] -= 1;
        r.hunger = Math.max(0, r.hunger - this.w.hunger.eat_reduce);
        return { ok: true, text: `${s}はパンを食べた`, desc: "ひと息つく" };
      }
      case "rest":
        r.activity = "rest";
        return { ok: true, text: `${s}は${r.loc}で休んでいる`, desc: "休む" };
      case "vote":
        r.activity = "idle";
        return { ok: false, text: `${s}は投票しようとしたが、今は集会ではない`, desc: "様子を見る" };
      case "wait":
      default:
        r.activity = "wait";
        return { ok: true, text: `${s}は${r.loc}で様子を見ている`, desc: "様子を見る" };
    }
  }

  onArrive(r, from) {
    const cd = this.w.triggers.arrival_cooldown_ticks;
    for (const o of this.at(r.loc, r.name)) {
      if (o.convId) continue;
      o.perceptions.push(`${this.time} ${r.short}が${r.loc}に来た`);
      if (this.tickIndex - o.lastArrivalTrigger >= cd) {
        o.lastArrivalTrigger = this.tickIndex;
        this.trigger(o);
      }
    }
    if (this.wallet && !this.wallet.holder && this.wallet.place === r.loc) this.pickUpWallet(r);
  }

  // ---------- 会話 ----------
  startConversation(a, b, v) {
    const id = ++this.convSeq;
    const conv = {
      id,
      a: a.name,
      b: b.name,
      place: a.loc,
      lines: [{ speaker: a.name, say: v.say, thought: v.thought, time: this.time }],
      counts: { [a.name]: 1, [b.name]: 0 },
      turn: b.name,
      startTick: this.tickIndex,
      day: this.day,
    };
    this.convs.set(id, conv);
    a.convId = id;
    b.convId = id;
    a.activity = "talk";
    b.activity = "talk";
    b.perceptions.push(`${this.time} ${a.short}が話しかけてきた`);
    return conv;
  }

  logSay(r, to, say, thought, place) {
    this.log({ kind: "say", who: r.name, to: to.name, place, text: say, thought });
    this.publicLine(`${place}で${r.short}→${to.short}「${say}」`);
  }

  async advanceConversations() {
    const convs = [...this.convs.values()];
    await Promise.all(convs.map((c) => this.advanceOne(c)));
  }

  async advanceOne(conv) {
    for (let i = 0; i < this.w.conversation.utterances_per_tick; i++) {
      if (!this.convs.has(conv.id)) return;
      const speaker = this.res.get(conv.turn);
      const other = this.res.get(conv.turn === conv.a ? conv.b : conv.a);
      // 話せる回数は人ごと（空腹だと半分。base ではいつも max_utterances_each）
      const capS = this.talkCap(speaker);
      if (conv.counts[speaker.name] >= capS && conv.counts[other.name] >= this.talkCap(other)) {
        this.endConversation(conv, "話し尽くした");
        return;
      }
      if (conv.counts[speaker.name] >= capS) {
        conv.turn = other.name;
        continue;
      }
      const remaining = capS - conv.counts[speaker.name];
      const out = await this.askResident(speaker, "talk", { partner: other.name, conv, remaining });
      if (!this.convs.has(conv.id)) return; // 待っている間に中断された
      const v = out.value;
      if (v && v.action === "talk") {
        conv.lines.push({ speaker: speaker.name, say: v.say, thought: v.thought, time: this.time });
        conv.counts[speaker.name]++;
        speaker.mood = v.mood;
        speaker.lastThought = v.thought;
        for (const m of v.remember) {
          addMemory(speaker, { day: this.day, minute: this.minute, text: m.text, importance: m.importance, source: { type: "talk", from: other.short } }, this.w.memory);
        }
        this.logSay(speaker, other, v.say, v.thought, conv.place);
        conv.turn = other.name;
        continue;
      }
      // 会話を終える：話し手は選んだ行動にそのまま移る。相手は次のティックで考え直す（会話の要点を記憶する）
      this.endConversation(conv, v ? `${speaker.short}が切り上げた` : `${speaker.short}が黙ってしまった`, speaker.name);
      speaker.afterConversation = null;
      this.applyDecision(speaker, out, "talk", { partner: other.name });
      return;
    }
  }

  endConversation(conv, reason, enderName = null) {
    if (!conv || !this.convs.has(conv.id)) return;
    this.convs.delete(conv.id);
    const transcript = conv.lines.map((l) => ({ speaker: this.shortOf[l.speaker], say: l.say }));
    for (const n of [conv.a, conv.b]) {
      const r = this.res.get(n);
      r.convId = null;
      r.activity = "idle";
      if (n !== enderName) {
        r.afterConversation = { partner: n === conv.a ? conv.b : conv.a, place: conv.place, lines: transcript };
        this.trigger(r);
      }
    }
    this.log({ kind: "system", place: conv.place, text: `${this.shortOf[conv.a]}と${this.shortOf[conv.b]}の会話が終わった（${reason}、${conv.lines.length}発言）` });
    this.rec.event({ type: "conversation", conv: { ...conv, reason } });
    this.eavesdrop(conv);
  }

  /** 同じ場所にいた第三者が、会話の断片だけを覚える */
  eavesdrop(conv) {
    const k = this.w.conversation.eavesdrop_fragments;
    for (const o of this.at(conv.place)) {
      if (o.name === conv.a || o.name === conv.b || o.convId) continue;
      const frags = this.rng.shuffle(conv.lines).slice(0, k);
      for (const f of frags) {
        const chars = [...f.say];
        const cut = chars.slice(0, Math.max(6, Math.ceil(chars.length * 0.6))).join("");
        const text = `${this.shortOf[f.speaker]}が「${cut}${cut.length < f.say.length ? "…" : ""}」と言っているのが聞こえた`;
        addMemory(o, { day: this.day, minute: this.minute, text, importance: 4, source: { type: "overheard" } }, this.w.memory);
        o.perceptions.push(`${this.time} （立ち聞き）${text}`);
      }
      this.log({ kind: "thought", who: o.name, place: conv.place, text: `${o.short}は${this.shortOf[conv.a]}と${this.shortOf[conv.b]}の話を少し聞いた` });
    }
  }

  // ---------- user メッセージの材料 ----------
  situationContext(r, mode, extra) {
    const m = this.w.meeting;
    const nowAbs = this.abs;
    const meetAbs = (m.day - 1) * 1440 + hhmmToMin(m.time);
    let meetingNote = "";
    if (this.meeting.result) meetingNote = `集会は終わった。結果は「${this.meeting.result.option}」（${this.meeting.result.summary}）`;
    else if (nowAbs < meetAbs) {
      const h = Math.round((meetAbs - nowAbs) / 60);
      meetingNote = `${m.day}日目${m.time}に${m.place}で町民集会（あと約${h}時間）。議題：${m.agenda}。${r.c.can_vote ? "あなたは投票できる" : "あなたは投票できない"}`;
    }
    const closed = this.cfg.derived.placeNames.filter((p) => this.isClosed(p));
    let placeNote = closed.length ? `嵐のため${closed.join("・")}には入れない` : "穏やかな天気";
    if (this.w.weather) placeNote = [this.w.weather.place_note, closed.length ? placeNote : ""].filter(Boolean).join("。");
    const present = this.at(r.loc, r.name).map((o) => {
      let status = o.activity === "work" ? "働いている" : o.activity === "rest" ? "休んでいる" : "そこにいる";
      if (this.isCollapsed(o)) status = "空腹で座り込んでいる";
      if (o.convId) {
        const c = this.convs.get(o.convId);
        const partner = c ? (c.a === o.name ? c.b : c.a) : null;
        status = partner === r.name ? "あなたと話し中" : `${this.shortOf[partner] || "誰か"}と話し中`;
      }
      return { name: o.name, status };
    });
    const relations = Object.entries(r.relations)
      .filter(([, v]) => v !== 0)
      .map(([n, v]) => `${this.shortOf[n]} ${v > 0 ? "+" : ""}${v}`);
    const beliefs = r.beliefs.slice(-6).map((b) => `${this.shortOf[b.about]}について：${b.text}`);

    const open = this.openPlaces().filter((p) => p !== r.loc);
    const talkable = present.filter((p) => !this.res.get(p.name).convId).map((p) => p.name);
    const bk = this.w.bakery;
    const owner = this.res.get(bk.owner);
    const shopOpen = owner && owner.active && owner.loc === bk.place;
    const options = [];
    const instructions = [];
    if (mode === "speech" || mode === "vote" || mode === "tiebreak") {
      const prev = this.meeting.speeches.map((s) => `${this.shortOf[s.who]}「${s.say}」`);
      if (mode === "speech") {
        options.push("集会での意見表明（action は talk、target は空文字）");
        if (prev.length) instructions.push(`これまでの意見：\n${prev.join("\n")}`);
        instructions.push(`町民集会（議題：${m.agenda}。選択肢：${m.options.join("・")}）。あなたが意見を述べる番です。action を talk、target を空文字、say に意見（60字以内）を入れてください。plan_until は ${minToHhmm(this.minute + 15)}。`);
      } else {
        const opts = extra.options || m.options;
        options.push(`投票（action は vote、target は ${opts.join("・")} のどれか）`);
        instructions.push(`集会での意見：\n${prev.join("\n")}`);
        instructions.push(
          mode === "tiebreak"
            ? `票が同数（${opts.join("・")}）に割れました。町会長のあなたが決めてください。action を vote、target に選んだ選択肢。plan_until は ${minToHhmm(this.minute + 15)}。`
            : `投票の時間です。action を vote、target に選択肢を1つ。投票は無記名で、誰が何に入れたかは本人しか知りません。plan_until は ${minToHhmm(this.minute + 15)}。`,
        );
      }
    } else {
      if (mode === "talk") {
        options.push(`talk：会話を続ける（target は ${extra.partner}）`);
        talkable.splice(0, talkable.length, extra.partner);
      }
      if (this.isCollapsed(r)) options.push(`move：空腹で座り込んでいて、${this.untilText(r.collapsedUntilAbs)}までは動けない`);
      else options.push(`move：行き先は ${open.join("・") || "（今は動けない）"}${closed.length ? `（入れない：${closed.join("・")}）` : ""}${mode === "talk" ? "（会話を切り上げて移動）" : ""}`);
      if (mode !== "talk") options.push(talkable.length ? `talk：話しかけられる人は ${talkable.join("・")}` : "talk：今ここで話しかけられる人はいない");
      const nw = this.noWorkReason(r);
      if (r.c.work_places.includes(r.loc)) options.push(nw ? `work：ここはあなたの職場だが、今は働けない（${nw}）` : "work：ここはあなたの職場");
      else options.push(`work：職場は ${r.c.work_places.join("・")}（ここではできない）`);
      if (r.loc === bk.place) {
        options.push(
          shopOpen || r.name === bk.owner
            ? `buy：パンは1個${bk.price}コイン、棚に${this.bakery.stock}個（1回に${bk.max_per_purchase}個まで）`
            : `buy：店主の${owner.short}がいないので今は買えない`,
        );
      } else {
        options.push("buy：パン屋でだけできる");
      }
      const gifts = ["コイン"];
      if (r.items["パン"] > 0) gifts.push("パン");
      if (r.items["海図"] > 0) gifts.push("海図");
      if (r.items["財布"] > 0) gifts.push("財布");
      options.push(talkable.length ? `give：${talkable.join("・")} に ${gifts.join("・")} を渡せる` : "give：渡せる相手がいない");
      options.push(r.items["パン"] > 0 ? `eat：パンを1個食べられる（手持ち${r.items["パン"]}個）` : "eat：パンがないので食べられない");
      options.push("rest：休む ／ wait：様子を見る");
      if (mode === "talk") {
        instructions.push(`あなたは${this.shortOf[extra.partner]}と話しています。`);
        instructions.push(`続けるなら action を talk、target を ${extra.partner}、say に次の一言（60字以内）。`);
        instructions.push("会話を終えるなら talk 以外の行動を選ぶ（それがそのまま次の行動になる）。終えるときは remember に、この会話の要点を自分の言葉で1〜2件書く。");
        instructions.push("同じことの言い換えになってきたら、無理に続けずに切り上げてよい。");
      } else {
        instructions.push("次の行動を1つ選び、決められた形の JSON で答えてください。");
        if (r.afterConversation) {
          instructions.push("remember に、さっき終わった会話の要点を自分の言葉で1〜2件書いてください（相手の言葉をそのまま写さず、あなたが理解したとおりに）。");
        }
      }
      instructions.push(`今は ${this.time}。plan_until はこの行動を続ける終わりの時刻（${this.time} より後、${this.w.time.day_end} まで）。`);
    }
    let conversation = null;
    if (mode === "talk" && extra.conv) {
      conversation = {
        partner: this.shortOf[extra.partner],
        place: extra.conv.place,
        remaining: extra.remaining,
        lines: extra.conv.lines.map((l) => ({ speaker: l.speaker === r.name ? "あなた" : this.shortOf[l.speaker], say: l.say })),
      };
    }
    let afterConversation = null;
    if (mode === "action" && r.afterConversation) {
      const c = r.afterConversation;
      afterConversation = {
        partner: this.shortOf[c.partner],
        place: c.place,
        lines: c.lines.map((l) => ({ speaker: l.speaker === r.short ? "あなた" : l.speaker, say: l.say })),
      };
    }
    return {
      day: this.day,
      time: this.time,
      placeNote,
      meetingNote,
      res: r,
      hungerText: P.hungerState(this.w.hunger, r.hunger),
      bodyNote: this.bodyNote(r),
      present,
      perceptions: r.perceptions.slice(),
      memories: [],
      beliefs,
      relations,
      options,
      instructions,
      conversation,
      afterConversation,
    };
  }

  mockHint(r, mode, ctx, extra) {
    const bk = this.w.bakery;
    const owner = this.res.get(bk.owner);
    const absent = this.activeResidents().find((o) => o.loc !== r.loc && o.name !== r.name);
    const pref = this.w.meeting.options.find((o) => r.c.meeting_initial.startsWith(o));
    return {
      name: r.name,
      home: r.home,
      loc: r.loc,
      hunger: r.hunger,
      coins: r.coins,
      bread: r.items["パン"] || 0,
      wallet: (r.items["財布"] || 0) > 0,
      atBakery: r.loc === bk.place,
      bakeryOpen: this.bakery.stock > 0 && ((owner && owner.loc === bk.place) || r.name === bk.owner),
      breadPrice: bk.price,
      canWorkHere: r.c.work_places.includes(r.loc) && !this.noWorkReason(r),
      workPlace: r.c.work_places.find((p) => !this.noWork.includes(p)) || "",
      collapsed: this.isCollapsed(r),
      isWorkHours: this.minute >= 7 * 60 && this.minute < 18 * 60,
      present: ctx.present.filter((p) => !this.res.get(p.name).convId).map((p) => p.name),
      absentPerson: absent ? absent.name : "",
      openPlaces: this.openPlaces(),
      nowMin: this.minute,
      dayEndMin: this.cfg.derived.dayEndMin,
      moods: this.w.moods,
      shortOf: this.shortOf,
      invalidRate: this.mockInvalidRate,
      afterConversation: r.afterConversation ? { partner: this.shortOf[r.afterConversation.partner] } : null,
      conversation: mode === "talk" ? { partner: extra.partner, remaining: extra.remaining, lines: extra.conv.lines } : null,
      options: extra.options || this.w.meeting.options,
      preferredOption: pref && (!extra.options || extra.options.includes(pref)) ? pref : null,
    };
  }

  // ---------- 集会 ----------
  async runMeeting() {
    const m = this.w.meeting;
    this.meeting.phase = "speeches";
    for (const c of [...this.convs.values()]) this.endConversation(c, "集会が始まった");
    const all = this.activeResidents();
    for (const r of all) {
      r.loc = m.place;
      r.activity = "idle";
      r.transit = null;
      r.plan = { action: "wait", desc: "集会に出る", until: this.minute + 30 };
    }
    this.log({ kind: "meeting", text: `── 町民集会が始まった（議題：${m.agenda}。選択肢：${m.options.join("・")}） ──` });
    this.publicLine(`${m.place}で町民集会が開かれた（議題：${m.agenda}）`);
    this.emitTick();

    // 意見表明：議長から順に一人ずつ
    const order = [m.chair, ...all.map((r) => r.name).filter((n) => n !== m.chair)];
    for (const n of order) {
      const r = this.res.get(n);
      const out = await this.askResident(r, "speech");
      const say = out.value ? out.value.say : "……（何も言わなかった）";
      if (out.value) {
        r.mood = out.value.mood;
        r.lastThought = out.value.thought;
      }
      this.meeting.speeches.push({ who: n, say, thought: out.value ? out.value.thought : "" });
      this.log({ kind: "meeting", who: n, place: m.place, text: say, thought: out.value ? out.value.thought : "", speech: true });
      this.publicLine(`集会で${r.short}「${say}」`);
    }

    // 投票：投票権のある住人だけ、同時に
    this.meeting.phase = "voting";
    const voters = all.filter((r) => r.c.can_vote);
    const outs = await Promise.all(voters.map((r) => this.askResident(r, "vote")));
    const tally = Object.fromEntries(m.options.map((o) => [o, 0]));
    voters.forEach((r, i) => {
      const v = outs[i].value;
      if (v) {
        this.meeting.votes[r.name] = v.target;
        tally[v.target]++;
        r.lastThought = v.thought;
        this.log({ kind: "vote", who: r.name, place: m.place, text: `（無記名）${r.short}の票：${v.target}`, thought: v.thought });
      } else {
        this.meeting.votes[r.name] = null;
        this.log({ kind: "vote", who: r.name, place: m.place, text: `${r.short}は白票だった` });
      }
    });
    const top = Math.max(...Object.values(tally));
    const tied = m.options.filter((o) => tally[o] === top);
    let option = tied[0];
    let how = "多数決";
    if (tied.length > 1) {
      const chair = this.res.get(m.chair);
      const out = await this.askResident(chair, "tiebreak", { options: tied });
      if (out.value) option = out.value.target;
      else option = tied.includes(this.meeting.votes[m.chair]) ? this.meeting.votes[m.chair] : tied[0];
      how = `同数のため町会長の${chair.short}が決定`;
    }
    const summary = m.options.map((o) => `${o} ${tally[o]}票`).join("、") + `（${how}）`;
    this.meeting.result = { option, tally, how, summary };
    this.meeting.phase = "done";
    this.fund -= this.w.town_fund;
    for (const r of this.activeResidents()) {
      this.perceive(r, `集会の結果、積立金は「${option}」に使うことに決まった（${summary}）`, { memory: 9 });
    }
    this.log({ kind: "meeting", text: `── 集会の結果：「${option}」に決定（${summary}） ──` });
    this.publicLine(`集会の結果、積立金は「${option}」に使うと決まった（${summary}）`);
    this.rec.event({ type: "meeting", meeting: { ...this.meeting } });
    this.ovenAfterMeeting(option);
  }

  /** シナリオ2：集会でかまどが選ばれれば翌朝から焼け、選ばれなければ、もう焼けない */
  ovenAfterMeeting(option) {
    const am = this.w.bakery.oven.after_meeting;
    if (!am) return;
    const replaced = option === am.option;
    this.bakery.replaced = replaced;
    if (!replaced && !this.bakery.broken) {
      this.bakery.broken = true;
      this.bakery.brokenAnnounced = true;
      this.bakery.brokenAt = { day: this.day, time: this.time, when: "meeting" };
    }
    const text = replaced
      ? `かまどが新しくなる。${this.day + 1}日目の朝から、またパンが焼ける`
      : "かまどは直らないことになった。集会のあとは、もうパンは焼けない";
    for (const r of this.activeResidents()) this.perceive(r, text, { memory: 8 });
    this.log({ kind: "event", place: this.w.bakery.place, text: replaced ? `パン屋のかまどは新しくなる（${this.day + 1}日目の朝から焼ける）` : "パン屋のかまどは直らない（もう焼けない）" });
    this.publicLine(replaced ? "パン屋のかまどが新しくなることになった" : "パン屋のかまどは直らず、もうパンは焼けない");
    this.rec.event({ type: "oven", day: this.day, time: this.time, after_meeting: replaced ? "replaced" : "not_replaced" });
  }

  // ---------- 1日の終わり ----------
  async endOfDay(final) {
    for (const c of [...this.convs.values()]) this.endConversation(c, "夜になった");
    this.setStatus("dayend", `${this.day}日目の振り返りと新聞を準備中`);
    this.emitTick();
    const reflect = !final;
    // シナリオ2：最後の日のあと、翌朝の町の様子を記録してから終える（epilogue_morning）
    const epilogue = final && !!this.w.time.epilogue_morning;
    try {
      if (reflect) await this.reflectAll();
      await this.writeNewspaper();
    } catch (e) {
      if (e instanceof BudgetStop || e instanceof FatalLlmError) throw e;
      this.log({ kind: "system", text: `1日の終わりの処理でエラー：${e.message}` });
    }
    this.log({ kind: "system", text: `── ${this.day}日目 終わり ──` });
    if (epilogue) {
      this.setStatus("day_waiting", `${this.day}日目が終わりました。「次の日へ」で${this.day + 1}日目の朝の町の様子を記録して終わります`);
    } else if (final) {
      this.finished = true;
      this.setStatus("finished", this.meeting.result ? `集会で「${this.meeting.result.option}」に決まり、町の3日間が終わりました` : "最後の日が終わりました");
      this.rec.finish({ meeting: this.meeting.result });
    } else {
      this.setStatus("day_waiting", `${this.day}日目が終わりました。「次の日へ」で進みます`);
    }
    this.emitTick();
  }

  async reflectAll() {
    const people = this.activeResidents();
    await Promise.all(people.map((r) => this.reflectOne(r)));
  }

  async reflectOne(r) {
    const today = r.memory.filter((m) => m.day === this.day).map((m) => formatMemory(m, this.cfg.derived.dayStartMin));
    const m = this.w.meeting;
    const ctx = {
      day: this.day,
      time: this.time,
      res: r,
      hungerText: P.hungerState(this.w.hunger, r.hunger),
      pinned: pinnedMemories(r).map((x) => formatMemory(x, this.cfg.derived.dayStartMin)),
      todayMemories: today.length ? today : ["（特に覚えていることはない）"],
      beliefs: r.beliefs.slice(-6).map((b) => `${this.shortOf[b.about]}について：${b.text}`),
      relations: Object.entries(r.relations).filter(([, v]) => v !== 0).map(([n, v]) => `${this.shortOf[n]} ${v > 0 ? "+" : ""}${v}`),
      meetingNote: `${m.day}日目${m.time}に${m.place}で。議題：${m.agenda}（${m.options.join("・")}）`,
    };
    const others = this.order.filter((n) => n !== r.name);
    const out = await this.gw.call({
      role: "reflection",
      resident: r.name,
      systemTexts: [this.rulesText, this.personaText[r.name]],
      userText: P.reflectionUser(ctx),
      schema: this.reflSchema,
      schemaName: "reflection",
      check: (v) => (v.beliefs.length === 0 ? ["beliefs が空"] : []),
      mock: () => mock.mockReflection({ others, shortOf: this.shortOf }, this.mockRng),
    });
    if (!out.ok) {
      this.log({ kind: "fail", who: r.name, text: `${r.short}の振り返りが規則に合わなかった` });
      return;
    }
    const v = out.value;
    for (const b of v.beliefs.slice(0, 5)) {
      if (b.about === r.name) continue;
      const text = cleanText(b.text, 60);
      r.beliefs.push({ about: b.about, text, day: this.day });
      addMemory(r, { day: this.day, minute: this.minute, text: `${this.shortOf[b.about]}について：${text}`, importance: 7, source: { type: "reflection" }, kind: "belief" }, this.w.memory);
    }
    if (r.beliefs.length > 15) r.beliefs.splice(0, r.beliefs.length - 15);
    const changes = [];
    for (const c of v.relation_changes) {
      if (c.to === r.name) continue;
      const d = clamp(c.delta, -2, 2);
      if (!d) continue;
      r.relations[c.to] = clamp((r.relations[c.to] || 0) + d, -5, 5);
      changes.push(`${this.shortOf[c.to]}${d > 0 ? "+" : ""}${d}`);
    }
    r.goal = cleanText(v.goal_tomorrow, 60);
    r.diary.push({ day: this.day, text: cleanText(v.diary, 80) });
    addMemory(r, { day: this.day, minute: this.minute, text: `明日の目標：${r.goal}`, importance: 6, source: { type: "reflection" } }, this.w.memory);
    this.log({
      kind: "reflection",
      who: r.name,
      text: `${r.short}の振り返り：「${cleanText(v.diary, 80)}」 明日の目標：${r.goal}${changes.length ? `（関係の変化：${changes.join("、")}）` : ""}`,
      thought: v.beliefs.map((b) => `${this.shortOf[b.about]}→${cleanText(b.text, 60)}`).join(" / "),
    });
    this.rec.event({ type: "reflection", day: this.day, who: r.name, value: v });
  }

  async writeNewspaper() {
    const day = this.day;
    const m = this.w.meeting;
    let lines = this.dayPublic.slice();
    const meetingNote = this.meeting.result
      ? `結果は「${this.meeting.result.option}」（${this.meeting.result.summary}）`
      : `${m.day}日目${m.time}に開かれる予定（${m.options.join("・")}）`;
    let userText = null;
    const sys = [P.newspaperSystem(this.cfg)];
    while (true) {
      const ctx = { day, issue: day, fund: this.fund, meetingNote, lines: lines.length ? lines : ["（大きな出来事はなかった）"] };
      userText = P.newspaperUser(ctx);
      if (this.gw.fits(sys, userText, this.newsSchema).ok || lines.length <= 10) break;
      // 長すぎるときは真ん中から間引く
      lines = lines.filter((_, i) => i % 2 === 0);
    }
    const out = await this.gw.call({
      role: "newspaper",
      resident: null,
      systemTexts: sys,
      userText,
      schema: this.newsSchema,
      schemaName: "newspaper",
      check: (v) => (v.articles.length === 0 ? ["articles が空"] : []),
      mock: () => mock.mockNewspaper({ day, lines, fund: this.fund }, this.mockRng),
    });
    if (!out.ok) {
      this.log({ kind: "fail", text: `${day}日目の新聞が書けなかった` });
      return;
    }
    const md = newspaperMarkdown(this.w.town_name, day, out.value, this.meeting.result && this.meeting.day === day ? this.meeting.result : null);
    const file = this.rec.writeVersioned(`newspaper_day${day}`, "md", md);
    this.newspapers[day] = { day, json: out.value, markdown: md, file, run: this.rec.id };
    this.rec.event({ type: "newspaper", day, file, json: out.value, markdown: md });
    this.emit("newspaper", { day, markdown: md, json: out.value, file, run: this.rec.id });
    this.log({ kind: "news", text: `『凪野町報』${day}日目号：${cleanText(out.value.headline, 40)}（${file}）` });
    // 翌朝、住人は見出しを読む
    this.morningNews = cleanText(out.value.headline, 40);
  }

  /** 「次の日へ」 */
  nextDay() {
    if (this.status !== "day_waiting") return false;
    this.day++;
    this.tickIndex = 0;
    this.dayStarted = false;
    const w = this.w;
    // 夜のあいだ：家に帰って眠る
    for (const r of this.activeResidents()) {
      r.loc = r.home;
      r.plan = null;
      r.activity = "idle";
      r.needsDecision = true;
      r.convId = null;
      r.transit = null;
      r.collapsedUntilAbs = null;
      r.hunger = clamp(r.hunger + w.hunger.overnight, 0, 10);
      r.perceptions = [];
      if (this.morningNews) this.perceive(r, `今朝の『凪野町報』の見出し：「${this.morningNews}」`, { memory: 4, source: { type: "news" } });
    }
    // 財布を一晩持っていたら、中身は自分のものにしたことになる
    if (this.wallet && this.wallet.holder) {
      const h = this.res.get(this.wallet.holder);
      h.coins += this.wallet.coins;
      h.items["財布"] = 0;
      this.log({ kind: "thought", who: h.name, text: `（夜のうちに）${h.short}は財布の中身を自分のものにした`, thought: "誰にも見られていない…はず" });
      if (this.wallet.owner) this.perceive(this.res.get(this.wallet.owner), "落とした財布は、結局戻ってこなかった", { memory: 6 });
      this.wallet = null;
    }
    // パン屋：かまどの調子は日ごとに少しずつ落ちる
    const ov = w.bakery.oven;
    const decay = ov.daily_decay_min + this.ovenRng.next() * (ov.daily_decay_max - ov.daily_decay_min);
    const prev = this.bakery;
    this.bakery = {
      stock: 0,
      health: Math.max(ov.min_health, this.bakery.health - decay),
      bakedToday: 0,
      stoppedToday: false,
      batchesDone: new Set(),
    };
    // 止まったかまどは翌日も止まったまま（シナリオ2）
    for (const k of ["broken", "brokenAnnounced", "brokenAt", "replaced"]) if (prev[k] !== undefined) this.bakery[k] = prev[k];
    if (this.bakery.replaced === undefined) this.checkOvenBreak("night"); // 集会でかまどの行方が決まったあとは傷まない
    for (const p of Object.values(this.places)) p.closedUntilAbs = null;
    if (this.day > this.lastDay) {
      this.epilogueMorning();
      return true;
    }
    this.scheduleRandomEvents();
    this.setStatus("paused", `${this.day}日目の朝です`);
    this.emitTick();
    return true;
  }

  /** シナリオ2：最後の日の翌朝。かまどが新しくなっていれば最初の分だけ焼き、町の様子を記録して終える */
  epilogueMorning() {
    this.startOfDay();
    const bk = this.w.bakery;
    const am = bk.oven.after_meeting;
    if (am && this.bakery.replaced) {
      this.bakery.broken = false;
      this.bakery.health = am.repaired_health ?? 1;
    }
    this.bakeBatch(bk.batches[0]);
    const hg = this.w.hunger;
    const state = {
      day: this.day,
      time: this.time,
      meeting: this.meeting.result ? this.meeting.result.option : null,
      oven: this.bakery.broken ? "止まったまま" : this.bakery.replaced ? "新しいかまど" : "動いている",
      oven_broken_at: this.bakery.brokenAt || null,
      bakery: { stock: this.bakery.stock, baked: this.bakery.bakedToday },
      residents: this.activeResidents().map((r) => ({
        name: r.name,
        loc: r.loc,
        hunger: Math.round(r.hunger * 10) / 10,
        level: this.hungerLv(r),
        ...(hg.tell === "words" ? { word: P.hungerWord(hg, r.hunger) } : {}),
        bread: r.items["パン"] || 0,
        coins: r.coins,
      })),
    };
    const L = [];
    L.push(`# ${this.w.town_name} ${this.day}日目の朝（${this.time}）`, "");
    L.push(`- 集会の結果：${state.meeting || "（集会なし）"}`);
    const ba = state.oven_broken_at;
    const baText = !ba ? "" : ba.when === "meeting" ? "（集会で直さないと決まった）" : `（${this.bakery.replaced ? "古いかまどが" : ""}止まったのは${ba.day}日目 ${ba.time}）`;
    L.push(`- かまど：${state.oven}${baText}`);
    L.push(`- パン屋の棚：${state.bakery.stock}個（今朝焼けた数 ${state.bakery.baked}個）`, "");
    L.push("| 住人 | 空腹度 | 手持ちのパン | 所持金 |", "| --- | --- | --- | --- |");
    for (const x of state.residents) L.push(`| ${this.shortOf[x.name]} | ${x.level}${x.word ? `（${x.word}）` : ""} | ${x.bread}個 | ${x.coins}コイン |`);
    const md = L.join("\n") + "\n";
    state.file = this.rec.writeVersioned(`morning_day${this.day}`, "md", md);
    this.rec.event({ type: "morning_state", ...state });
    for (const x of state.residents) {
      this.log({ kind: "system", who: x.name, text: `${this.shortOf[x.name]}：空腹度${x.level}${x.word ? `（${x.word}）` : ""}、パン${x.bread}個、${x.coins}コイン` });
    }
    this.log({ kind: "system", text: `── ${this.day}日目の朝の町の様子を記録しました（${state.file}） ──` });
    this.finished = true;
    this.setStatus("finished", `${this.day}日目の朝の町の様子を記録して終わりました`);
    this.rec.finish({ meeting: this.meeting.result, morning: state });
    this.emitTick();
  }
}

export function newspaperMarkdown(town, day, n, meetingResult) {
  const L = [];
  L.push(`# 凪野町報 ${day}日目号`);
  L.push("");
  L.push(`## ${n.headline}`);
  L.push("");
  L.push(n.lead);
  L.push("");
  for (const a of n.articles) {
    L.push(`### ${a.heading}`);
    L.push("");
    L.push(a.body);
    L.push("");
  }
  if (meetingResult) {
    L.push("### 集会の結果（町役場発表）");
    L.push("");
    L.push(`積立金の使い道は「${meetingResult.option}」に決まりました。${meetingResult.summary}`);
    L.push("");
  }
  if (n.rumors.length) {
    L.push("### うわさ欄");
    L.push("");
    for (const r of n.rumors) L.push(`- ${r}`);
    L.push("");
  }
  L.push("### 明日の見どころ");
  L.push("");
  L.push(n.tomorrow);
  L.push("");
  L.push(`---`);
  L.push(`${town}・AIだけの街シミュレーションより（記事は AI が書いた架空の新聞です）`);
  L.push("");
  return L.join("\n");
}
