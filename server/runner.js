// 町の進行役：再生・一時停止・1ティック・速度・次の日・天の声・自動停止・再生モードの切り替え。
import { RunRecorder } from "./record.js";
import { LlmGateway, BudgetStop, FatalLlmError } from "./llm/gateway.js";
import { Town } from "./sim/town.js";
import { Replayer } from "./replay.js";
import { cleanText } from "./util.js";
import { publicWorld, publicCharacters } from "./public.js";

// 最初の記録が出るまで runs/ にフォルダを作らない（起動しただけの空の run を作らないため）
class LazyRecorder {
  constructor(opts) {
    this.opts = opts;
    this.r = null;
  }
  real() {
    if (!this.r) this.r = new RunRecorder(this.opts);
    return this.r;
  }
  get id() {
    return this.real().id;
  }
  get started() {
    return !!this.r;
  }
  event(o) {
    this.real().event(o);
  }
  llmCall(o) {
    this.real().llmCall(o);
  }
  cost(o) {
    this.real().cost(o);
  }
  writeVersioned(b, e, c) {
    return this.real().writeVersioned(b, e, c);
  }
  finish(o) {
    this.real().finish(o);
  }
}

export class Runner {
  constructor({ cfg, mode, modeNote, ledger, broadcast, mockLatency, mockInvalidRate }) {
    this.cfg = cfg;
    this.mode = mode;
    this.modeNote = modeNote;
    this.ledger = ledger;
    this.broadcast = broadcast;
    this.mockLatency = mockLatency;
    this.mockInvalidRate = mockInvalidRate;
    this.speed = 1;
    this.running = false;
    this.loopPromise = null;
    this.replay = null;
    this.clients = 0;
    this.disconnectTimer = null;
    this.newTown();
  }

  newTown() {
    this.rec = new LazyRecorder({ kind: "sim", mode: this.mode, extraMeta: { seed: this.cfg.world.seed } });
    this.gw = new LlmGateway({
      cfg: this.cfg,
      mode: this.mode,
      recorder: this.rec,
      ledger: this.ledger,
      onCost: (b) => this.broadcast("cost", b),
      mockLatency: this.mockLatency,
    });
    this.town = new Town({
      cfg: this.cfg,
      gateway: this.gw,
      recorder: this.rec,
      emit: (type, payload) => {
        if (!this.replay) this.broadcast(type, payload);
      },
      mockInvalidRate: this.mockInvalidRate,
    });
  }

  tickMs() {
    return Math.round((this.cfg.world.time.tick_seconds_1x * 1000) / this.speed);
  }

  /** 新しく接続したブラウザに渡す一式 */
  hello() {
    if (this.replay) return this.replay.hello();
    const t = this.town;
    return {
      mode: this.mode,
      modeNote: this.modeNote,
      replay: null,
      run: this.rec.started ? this.rec.id : null,
      speed: this.speed,
      speeds: this.cfg.world.time.speeds,
      world: publicWorld(this.cfg.world),
      characters: publicCharacters(this.cfg.characters),
      snapshot: t.snapshot(),
      logs: t.logs.slice(-400),
      newspapers: Object.values(t.newspapers),
      cost: this.gw.budgetState(),
    };
  }

  setClients(n) {
    this.clients = n;
    if (n > 0) {
      clearTimeout(this.disconnectTimer);
      this.disconnectTimer = null;
      return;
    }
    if (this.disconnectTimer) return;
    const sec = this.cfg.budget.disconnect_pause_seconds;
    this.disconnectTimer = setTimeout(() => {
      this.disconnectTimer = null;
      if (this.clients === 0) {
        if (this.running) this.pause(`ブラウザが${sec}秒以上つながっていないため一時停止しました`);
        if (this.replay) this.replay.pause();
      }
    }, sec * 1000);
  }

  async command(body) {
    const cmd = body && body.cmd;
    if (this.replay && !["replay_play", "replay_pause", "replay_step", "speed", "replay_exit", "runs"].includes(cmd)) {
      return { ok: false, error: "再生モード中です（先に「再生をやめる」）" };
    }
    switch (cmd) {
      case "play":
        return this.play();
      case "pause":
        this.pause("");
        return { ok: true };
      case "step":
        return this.step();
      case "speed": {
        const s = Number(body.speed);
        if (!this.cfg.world.time.speeds.includes(s)) return { ok: false, error: "その速度は選べません" };
        this.speed = s;
        if (this.replay) this.replay.speed = s;
        this.broadcast("speed", { speed: s });
        return { ok: true };
      }
      case "next_day": {
        if (this.running) return { ok: false, error: "進行中です" };
        const ok = this.town.nextDay();
        return ok ? { ok: true } : { ok: false, error: "まだ1日が終わっていません" };
      }
      case "heaven":
        return this.heaven(body);
      case "new_town": {
        if (this.running) return { ok: false, error: "一時停止してから" };
        if (this.rec.started) this.rec.finish({ reason: "new_town" });
        this.newTown();
        this.broadcast("hello", this.hello());
        return { ok: true };
      }
      case "replay_start": {
        if (this.running) return { ok: false, error: "一時停止してから" };
        const rp = Replayer.open(String(body.run || ""), (type, payload) => this.broadcast(type, payload));
        if (!rp) return { ok: false, error: "その run は再生できません" };
        this.replay = rp;
        rp.speed = this.speed;
        this.broadcast("hello", this.hello());
        return { ok: true };
      }
      case "replay_play":
        if (!this.replay) return { ok: false, error: "再生モードではありません" };
        this.replay.play(() => this.tickMs());
        return { ok: true };
      case "replay_pause":
        if (this.replay) this.replay.pause();
        return { ok: true };
      case "replay_step":
        if (this.replay) await this.replay.step();
        return { ok: true };
      case "replay_exit":
        if (this.replay) this.replay.pause();
        this.replay = null;
        this.broadcast("hello", this.hello());
        return { ok: true };
      default:
        return { ok: false, error: "知らない命令です" };
    }
  }

  heaven(body) {
    const t = this.town;
    if (t.finished) return { ok: false, error: "町の3日間は終わっています" };
    const type = String(body.type || "");
    if (!["storm", "wallet", "oven", "letter", "free"].includes(type)) return { ok: false, error: "知らない出来事です" };
    const max = this.cfg.world.heaven.free_text_max;
    const ev = { type };
    if (type === "letter") {
      ev.to = this.cfg.derived.names.includes(body.to) ? body.to : null;
      ev.text = cleanText(body.text, max);
    }
    if (type === "free") {
      ev.text = cleanText(body.text, max);
      if (!ev.text) return { ok: false, error: "出来事の文を入れてください" };
      ev.place = this.cfg.derived.placeNames.includes(body.place) ? body.place : null;
    }
    t.queueHeaven(ev);
    this.broadcast("toast", { text: "天の声を受け付けました（次の時刻に起きます）" });
    return { ok: true };
  }

  play() {
    const t = this.town;
    if (t.finished) return { ok: false, error: "町の3日間は終わっています" };
    if (t.status === "day_waiting") return { ok: false, error: "「次の日へ」を押してください" };
    if (t.status === "stopped") return { ok: false, error: t.statusReason };
    if (this.running) return { ok: true };
    this.running = true;
    t.setStatus("running");
    this.loopPromise = this.loop();
    return { ok: true };
  }

  pause(reason) {
    if (!this.running) return;
    this.running = false;
    this.town.setStatus("paused", reason);
  }

  async step() {
    const t = this.town;
    if (this.running) return { ok: false, error: "進行中です" };
    if (t.finished || t.status === "day_waiting" || t.status === "stopped" || t.status === "dayend") return { ok: false, error: "今は進められません" };
    if (this.stepping) return { ok: false, error: "処理中です" };
    this.stepping = true;
    try {
      await this.safeTick();
      if (!["day_waiting", "finished", "stopped"].includes(t.status)) t.setStatus("paused", "1ティック進めました");
    } finally {
      this.stepping = false;
    }
    return { ok: true };
  }

  async safeTick() {
    try {
      await this.town.tick();
      return true;
    } catch (e) {
      const msg = e instanceof BudgetStop || e instanceof FatalLlmError ? e.message : `内部エラー：${e.message}`;
      if (!(e instanceof BudgetStop || e instanceof FatalLlmError)) console.error(e);
      this.running = false;
      this.town.setStatus("stopped", msg);
      this.town.log({ kind: "system", text: `停止：${msg}` });
      this.broadcast("cost", this.gw.budgetState());
      return false;
    }
  }

  async loop() {
    const t = this.town;
    while (this.running) {
      const t0 = Date.now();
      const ok = await this.safeTick();
      if (!ok) break;
      if (t.finished || t.status === "day_waiting") {
        this.running = false;
        break;
      }
      if (this.gw.stopReason) {
        this.running = false;
        t.setStatus("stopped", this.gw.stopReason);
        break;
      }
      const wait = this.tickMs() - (Date.now() - t0);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    }
  }
}
