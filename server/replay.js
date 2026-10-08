// 再生モード：過去の runs/（run名）/events.jsonl を、API を呼ばずにもう一度流す。
import fs from "node:fs";
import path from "node:path";
import { RUNS_DIR } from "./paths.js";
import { RUN_ID_RE } from "./record.js";
import { publicWorld, publicCharacters } from "./public.js";

export class Replayer {
  static open(runId, emit) {
    if (!RUN_ID_RE.test(runId)) return null;
    const dir = path.join(RUNS_DIR, runId);
    const file = path.join(dir, "events.jsonl");
    if (!fs.existsSync(file)) return null;
    let world;
    let characters;
    let meta = {};
    try {
      world = JSON.parse(fs.readFileSync(path.join(dir, "config", "world.json"), "utf8"));
      characters = JSON.parse(fs.readFileSync(path.join(dir, "config", "characters.json"), "utf8"));
      meta = JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf8"));
    } catch {
      return null;
    }
    const events = [];
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        events.push(JSON.parse(line));
      } catch {
        // 壊れた行は飛ばす
      }
    }
    return new Replayer(runId, meta, world, characters, events, emit);
  }

  constructor(runId, meta, world, characters, events, emit) {
    this.runId = runId;
    this.meta = meta;
    this.world = world;
    this.characters = characters;
    this.events = events;
    this.emit = emit;
    this.pos = 0;
    this.speed = 1;
    this.playing = false;
    this.logs = [];
    this.newspapers = [];
    this.snapshot = events.find((e) => e.type === "tick")?.snapshot || null;
    this.ticksTotal = events.filter((e) => e.type === "tick").length;
    this.ticksDone = 0;
  }

  hello() {
    return {
      mode: "replay",
      modeNote: `再生モード：${this.runId}（${this.meta.mode || "?"} の記録。API は呼びません）${this.meta.scenario && this.meta.scenario !== "base" ? `／シナリオ：${this.meta.scenario_title || this.meta.scenario}` : ""}`,
      scenario: { name: this.meta.scenario || "base", title: this.meta.scenario_title || "いつもの町", chain: this.meta.scenario_chain || [] },
      replay: { run: this.runId, ticksTotal: this.ticksTotal, ticksDone: this.ticksDone, playing: this.playing },
      run: this.runId,
      speed: this.speed,
      speeds: this.world.time.speeds,
      world: publicWorld(this.world),
      characters: publicCharacters(this.characters),
      snapshot: this.snapshot,
      logs: this.logs.slice(-400),
      newspapers: this.newspapers,
      cost: null,
    };
  }

  /** 次の tick まで流す。終わりなら false */
  async step() {
    while (this.pos < this.events.length) {
      const e = this.events[this.pos++];
      if (e.type === "log") {
        this.logs.push(e.entry);
        this.emit("log", e.entry);
      } else if (e.type === "newspaper") {
        const n = { day: e.day, markdown: e.markdown, json: e.json, file: e.file, run: this.runId };
        this.newspapers.push(n);
        this.emit("newspaper", n);
      } else if (e.type === "status") {
        this.emit("status", { status: e.status === "running" ? "replay" : e.status, reason: e.reason ? `（再生）${e.reason}` : "" });
        if (e.status === "day_waiting" && this.playing) {
          this.pause();
          return true;
        }
      } else if (e.type === "tick") {
        this.snapshot = e.snapshot;
        this.ticksDone++;
        this.emit("snapshot", e.snapshot);
        this.emit("replay", { run: this.runId, ticksTotal: this.ticksTotal, ticksDone: this.ticksDone, playing: this.playing });
        return true;
      }
    }
    this.pause();
    this.emit("status", { status: "finished", reason: "（再生）記録の終わりまで再生しました" });
    return false;
  }

  play(tickMs) {
    if (this.playing) return;
    this.playing = true;
    const loop = async () => {
      while (this.playing) {
        const more = await this.step();
        if (!more || !this.playing) break;
        await new Promise((r) => setTimeout(r, tickMs()));
      }
    };
    loop();
  }

  pause() {
    this.playing = false;
    this.emit("replay", { run: this.runId, ticksTotal: this.ticksTotal, ticksDone: this.ticksDone, playing: false });
  }
}
