// Canvas 2D の見下ろしマップ。絵文字や画像は使わず、図形と文字だけで描く。
// AI の文字列は fillText で描くだけ（HTML として解釈されることはない）。

const FONT = '"Zen Maru Gothic", "Hiragino Maru Gothic ProN", "BIZ UDPGothic", "Yu Gothic UI", "Meiryo", sans-serif';

function rr(ctx, x, y, w, h, r) {
  // roundRect は古い Safari に無いので自前で描く
  const q = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + q, y);
  ctx.lineTo(x + w - q, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + q);
  ctx.lineTo(x + w, y + h - q);
  ctx.quadraticCurveTo(x + w, y + h, x + w - q, y + h);
  ctx.lineTo(x + q, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - q);
  ctx.lineTo(x, y + q);
  ctx.quadraticCurveTo(x, y, x + q, y);
  ctx.closePath();
}

function darker(hex, k) {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.round(((n >> 16) & 255) * k);
  const g = Math.round(((n >> 8) & 255) * k);
  const b = Math.round((n & 255) * k);
  return `rgb(${r},${g},${b})`;
}

function textColorOn(hex) {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return lum > 0.6 ? "#1d2733" : "#ffffff";
}

function wrap(ctx, text, maxWidth, maxLines) {
  const chars = [...text];
  const lines = [];
  let cur = "";
  for (const ch of chars) {
    if (ctx.measureText(cur + ch).width > maxWidth && cur) {
      lines.push(cur);
      cur = ch;
      if (lines.length === maxLines) break;
    } else {
      cur += ch;
    }
  }
  if (lines.length < maxLines && cur) lines.push(cur);
  if (lines.length === maxLines && lines.join("").length < chars.length) {
    lines[maxLines - 1] = lines[maxLines - 1].slice(0, -1) + "…";
  }
  return lines;
}

export class TownMap {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.world = null;
    this.chars = [];
    this.snap = null;
    this.pos = {}; // name -> {x, y, path:[], t0, dur}
    this.bubbles = []; // {who, text, kind, until}
    this.showThought = false;
    this.tickMs = 3000;
    this.hover = null;
    this.raf = 0;
    this.dpr = 1;
    this.resize();
    window.addEventListener("resize", () => this.resize());
  }

  setWorld(world, chars) {
    this.world = world;
    this.chars = chars;
    this.W = world.map.width;
    this.H = world.map.height;
    this.place = Object.fromEntries(world.places.map((p) => [p.name, p]));
    this.homeIndex = {};
    const homes = chars.filter((c) => c.home === "住宅通り");
    homes.forEach((c, i) => (this.homeIndex[c.name] = { i, n: homes.length }));
    this.buildGraph();
    this.pos = {};
    this.bubbles = [];
    this.resize();
    this.start();
  }

  resize() {
    const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    this.dpr = dpr;
    const W = this.W || 1000;
    const H = this.H || 680;
    this.canvas.width = Math.round(W * dpr);
    this.canvas.height = Math.round(H * dpr);
  }

  // ---------- 道のグラフ（歩く道筋） ----------
  buildGraph() {
    const m = this.world.map;
    this.nodes = { ...m.road_nodes };
    this.edges = m.road_edges.map(([a, b]) => [a, b]);
    this.adj = {};
    const link = (a, b) => {
      const pa = this.nodes[a];
      const pb = this.nodes[b];
      const d = Math.hypot(pa[0] - pb[0], pa[1] - pb[1]);
      (this.adj[a] ||= []).push([b, d]);
      (this.adj[b] ||= []).push([a, d]);
    };
    for (const [a, b] of this.edges) link(a, b);
    this.attachNode = {};
    const attach = (key, pt) => {
      for (const [id, p] of Object.entries(m.road_nodes)) {
        if (Math.hypot(p[0] - pt[0], p[1] - pt[1]) < 2) return id;
      }
      this.nodes[key] = pt;
      let linked = false;
      for (const [a, b] of this.edges) {
        const A = this.nodes[a];
        const B = this.nodes[b];
        if (onSegment(A, B, pt)) {
          link(key, a);
          link(key, b);
          linked = true;
          break;
        }
      }
      if (!linked) {
        let best = null;
        let bd = Infinity;
        for (const [id, p] of Object.entries(m.road_nodes)) {
          const d = Math.hypot(p[0] - pt[0], p[1] - pt[1]);
          if (d < bd) {
            bd = d;
            best = id;
          }
        }
        link(key, best);
      }
      return key;
    };
    for (const p of this.world.places) this.attachNode[p.name] = attach(`A:${p.name}`, p.attach);
    const home = this.place["住宅通り"];
    for (const c of this.chars) {
      if (this.homeIndex[c.name]) {
        const hp = this.housePos(c.name);
        this.attachNode[`home:${c.name}`] = attach(`H:${c.name}`, [hp.x, m.road_nodes.N1[1]]);
      }
    }
    void home;
  }

  route(fromKey, toKey) {
    const dist = { [fromKey]: 0 };
    const prev = {};
    const q = new Set(Object.keys(this.nodes));
    while (q.size) {
      let u = null;
      let best = Infinity;
      for (const k of q) {
        if ((dist[k] ?? Infinity) < best) {
          best = dist[k];
          u = k;
        }
      }
      if (u == null) break;
      q.delete(u);
      if (u === toKey) break;
      for (const [v, d] of this.adj[u] || []) {
        const nd = best + d;
        if (nd < (dist[v] ?? Infinity)) {
          dist[v] = nd;
          prev[v] = u;
        }
      }
    }
    const path = [];
    let cur = toKey;
    while (cur && cur !== fromKey) {
      path.unshift(this.nodes[cur]);
      cur = prev[cur];
    }
    if (cur === fromKey) path.unshift(this.nodes[fromKey]);
    return path;
  }

  housePos(name) {
    const h = this.place["住宅通り"];
    const hi = this.homeIndex[name];
    const [x, y, w] = h.rect;
    const x0 = x + 160;
    const gap = (w - 170) / hi.n;
    return { x: x0 + gap * (hi.i + 0.5), y: y + 84 };
  }

  slotPos(r, snap) {
    if (r.loc === "住宅通り" && this.homeIndex[r.name]) return this.housePos(r.name);
    const p = this.place[r.loc];
    if (!p) return null;
    const here = snap.residents.filter((o) => o.active && o.loc === r.loc && !(o.loc === "住宅通り" && this.homeIndex[o.name]));
    const idx = here.findIndex((o) => o.name === r.name);
    const [x, y, w, h] = p.rect;
    if (r.loc === "住宅通り") return { x: x + 40 + idx * 38, y: y + 84 };
    const cols = 4;
    const col = idx % cols;
    const row = Math.floor(idx / cols);
    return { x: x + 40 + col * ((w - 80) / (cols - 1 || 1)), y: y + 66 + row * 58 };
  }

  doorKey(name, loc) {
    if (loc === "住宅通り" && this.homeIndex[name]) return { door: [this.housePos(name).x, this.place["住宅通り"].door[1]], node: this.attachNode[`home:${name}`] };
    const p = this.place[loc];
    return { door: p.door, node: this.attachNode[loc] };
  }

  // ---------- 状態の反映 ----------
  update(snap) {
    const prev = this.snap;
    this.snap = snap;
    const now = performance.now();
    for (const r of snap.residents) {
      if (!r.active || !r.loc) continue;
      const target = this.slotPos(r, snap);
      if (!target) continue;
      const cur = this.pos[r.name];
      const prevR = prev && prev.residents.find((o) => o.name === r.name);
      if (!cur) {
        this.pos[r.name] = { x: target.x, y: target.y, path: [], loc: r.loc };
        continue;
      }
      if (prevR && prevR.loc && prevR.loc !== r.loc && cur.loc !== r.loc) {
        // 道に沿って歩かせる
        const from = this.doorKey(r.name, prevR.loc);
        const to = this.doorKey(r.name, r.loc);
        const mid = this.route(from.node, to.node);
        const pts = [[cur.x, cur.y], from.door, ...mid, to.door, [target.x, target.y]];
        cur.path = pts;
        cur.t0 = now;
        cur.dur = Math.max(500, Math.min(2600, this.tickMs * 0.85));
        cur.loc = r.loc;
      } else if (!cur.path.length) {
        // 同じ場所の中での並び替え：ゆっくり寄せる
        cur.path = [[cur.x, cur.y], [target.x, target.y]];
        cur.t0 = now;
        cur.dur = 500;
        cur.loc = r.loc;
      }
    }
  }

  addBubble(who, text, kind) {
    const now = performance.now();
    const life = Math.max(2200, Math.min(6000, this.tickMs * 1.6));
    this.bubbles = this.bubbles.filter((b) => !(b.who === who && b.kind === kind));
    this.bubbles.push({ who, text, kind, until: now + life, born: now });
  }

  start() {
    if (this.raf) return;
    const loop = () => {
      this.draw();
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  stepPositions(now) {
    for (const p of Object.values(this.pos)) {
      if (!p.path.length) continue;
      const t = Math.min(1, (now - p.t0) / p.dur);
      const pts = p.path;
      let total = 0;
      const seg = [];
      for (let i = 1; i < pts.length; i++) {
        const d = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
        seg.push(d);
        total += d;
      }
      let want = total * easeInOut(t);
      let i = 0;
      while (i < seg.length && want > seg[i]) {
        want -= seg[i];
        i++;
      }
      if (i >= seg.length) {
        p.x = pts[pts.length - 1][0];
        p.y = pts[pts.length - 1][1];
      } else {
        const k = seg[i] ? want / seg[i] : 1;
        p.x = pts[i][0] + (pts[i + 1][0] - pts[i][0]) * k;
        p.y = pts[i][1] + (pts[i + 1][1] - pts[i][1]) * k;
      }
      if (t >= 1) p.path = [];
    }
  }

  /** クリックした位置の住人 */
  hit(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    const sx = this.W / rect.width;
    const sy = this.H / rect.height;
    const x = (clientX - rect.left) * sx;
    const y = (clientY - rect.top) * sy;
    let best = null;
    let bd = 22;
    for (const [name, p] of Object.entries(this.pos)) {
      const r = this.snap && this.snap.residents.find((o) => o.name === name);
      if (!r || !r.active) continue;
      const d = Math.hypot(p.x - x, p.y - y);
      if (d < bd) {
        bd = d;
        best = name;
      }
    }
    return best;
  }

  // ---------- 描画 ----------
  draw() {
    const ctx = this.ctx;
    if (!this.world) return;
    const now = performance.now();
    this.stepPositions(now);
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const W = this.W;
    const H = this.H;
    const m = this.world.map;

    // 地面と海
    ctx.fillStyle = "#efe6d1";
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = "#b9d3dc";
    ctx.fillRect(0, m.sea_top, W, H - m.sea_top);
    ctx.strokeStyle = "rgba(255,255,255,0.55)";
    ctx.lineWidth = 1.5;
    for (let y = m.sea_top + 18; y < H; y += 22) {
      ctx.beginPath();
      for (let x = 0; x <= W; x += 8) {
        const yy = y + Math.sin(x / 36 + now / 1400 + y) * 2.5;
        if (x === 0) ctx.moveTo(x, yy);
        else ctx.lineTo(x, yy);
      }
      ctx.stroke();
    }

    // 桟橋と灯台
    ctx.fillStyle = "#a88d68";
    for (const px of [140, 300, 460]) ctx.fillRect(px, m.sea_top - 4, 16, 54);
    const [lx, ly] = m.lighthouse;
    ctx.fillStyle = "#8a8f94";
    ctx.beginPath();
    ctx.ellipse(lx, ly + 28, 48, 16, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#ffffff";
    ctx.beginPath();
    ctx.moveTo(lx - 12, ly + 26);
    ctx.lineTo(lx - 8, ly - 30);
    ctx.lineTo(lx + 8, ly - 30);
    ctx.lineTo(lx + 12, ly + 26);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = "#c0432a";
    ctx.fillRect(lx - 10.5, ly - 6, 21, 8);
    ctx.fillRect(lx - 9.3, ly - 24, 18.6, 7);
    ctx.fillStyle = "#1e3a5f";
    ctx.fillRect(lx - 10, ly - 40, 20, 10);
    ctx.fillStyle = "rgba(255,214,102,0.9)";
    ctx.beginPath();
    ctx.arc(lx, ly - 35, 4, 0, Math.PI * 2);
    ctx.fill();
    this.label(lx, ly + 56, "灯台", 12, "#1e3a5f");

    // 道
    ctx.strokeStyle = "#e0d2b4";
    ctx.lineCap = "round";
    ctx.lineWidth = 24;
    const y1 = m.road_nodes.N1[1];
    const y2 = m.road_nodes.N4[1];
    ctx.beginPath();
    ctx.moveTo(30, y1);
    ctx.lineTo(W - 30, y1);
    ctx.moveTo(30, y2);
    ctx.lineTo(W - 30, y2);
    for (const [a, b] of this.edges) {
      const A = m.road_nodes[a];
      const B = m.road_nodes[b];
      ctx.moveTo(A[0], A[1]);
      ctx.lineTo(B[0], B[1]);
    }
    ctx.stroke();

    // 場所
    const snap = this.snap;
    for (const p of this.world.places) {
      const [x, y, w, h] = p.rect;
      ctx.fillStyle = p.color;
      rr(ctx, x, y, w, h, 14);
      ctx.fill();
      ctx.strokeStyle = darker(p.color, 0.72);
      ctx.lineWidth = 2;
      ctx.stroke();
      // 戸口
      ctx.fillStyle = darker(p.color, 0.6);
      ctx.fillRect(p.door[0] - 9, p.door[1] - 4, 18, 8);
      if (p.name === "住宅通り") this.drawHouses(p);
      // 看板
      ctx.font = `700 17px ${FONT}`;
      const tw = ctx.measureText(p.sign).width;
      ctx.fillStyle = "rgba(255,255,255,0.82)";
      rr(ctx, x + 10, y + 8, tw + 18, 26, 8);
      ctx.fill();
      ctx.fillStyle = "#1e3a5f";
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillText(p.sign, x + 19, y + 22);
      if (p.name === this.world.bakery.place && snap) {
        this.label(x + w - 54, y + 22, `パン ${snap.bakery.stock}個`, 13, snap.bakery.stopped ? "#c0432a" : "#55606d");
      }
      if (snap && snap.places[p.name] && snap.places[p.name].closed) {
        ctx.save();
        rr(ctx, x, y, w, h, 14);
        ctx.clip();
        ctx.fillStyle = "rgba(60,70,90,0.35)";
        ctx.fillRect(x, y, w, h);
        ctx.strokeStyle = "rgba(255,255,255,0.5)";
        ctx.lineWidth = 3;
        for (let k = -h; k < w; k += 18) {
          ctx.beginPath();
          ctx.moveTo(x + k, y + h);
          ctx.lineTo(x + k + h, y);
          ctx.stroke();
        }
        ctx.restore();
        this.label(x + w / 2, y + h / 2, "嵐で立ち入れない", 16, "#ffffff", "rgba(30,58,95,0.85)");
      }
    }
    if (snap && snap.wallet && snap.wallet.place) {
      const p = this.place[snap.wallet.place];
      ctx.fillStyle = "#8a5a2b";
      rr(ctx, p.rect[0] + p.rect[2] - 46, p.rect[1] + p.rect[3] - 30, 22, 14, 3);
      ctx.fill();
    }
    if (snap && (snap.meeting.phase === "speeches" || snap.meeting.phase === "voting")) {
      const p = this.place[this.world.meeting.place];
      ctx.strokeStyle = "#c0432a";
      ctx.lineWidth = 4;
      rr(ctx, p.rect[0] - 4, p.rect[1] - 4, p.rect[2] + 8, p.rect[3] + 8, 16);
      ctx.stroke();
    }

    // 会話の線
    if (snap) {
      ctx.strokeStyle = "rgba(192,67,42,0.55)";
      ctx.lineWidth = 2;
      ctx.setLineDash([5, 4]);
      for (const c of snap.conversations) {
        const a = this.pos[c.a];
        const b = this.pos[c.b];
        if (!a || !b) continue;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
      ctx.setLineDash([]);
    }

    // 住人
    if (snap) {
      for (const r of snap.residents) {
        if (!r.active) continue;
        const p = this.pos[r.name];
        if (!p) continue;
        ctx.fillStyle = "rgba(0,0,0,0.12)";
        ctx.beginPath();
        ctx.ellipse(p.x, p.y + 15, 13, 4, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = r.color;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 15, 0, Math.PI * 2);
        ctx.fill();
        ctx.lineWidth = 2.5;
        ctx.strokeStyle = r.activity === "talk" ? "#c0432a" : "#ffffff";
        ctx.stroke();
        ctx.fillStyle = textColorOn(r.color);
        ctx.font = `700 15px ${FONT}`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(r.initial, p.x, p.y + 1);
        // 名前と状態
        const tag = r.activity === "work" ? "・仕事" : r.activity === "rest" ? "・休憩" : "";
        this.label(p.x, p.y + 27, r.short + tag, 11, "#1d2733", "rgba(251,248,240,0.85)");
      }
    }

    // 時間帯の色
    if (snap) {
      const [hh, mm] = snap.time.split(":").map(Number);
      const t = hh + mm / 60;
      let tint = null;
      if (t < 7) tint = `rgba(255,190,120,${(0.14 * (7 - t)).toFixed(3)})`;
      else if (t >= 17 && t < 19) tint = `rgba(240,140,70,${(0.08 * (t - 17)).toFixed(3)})`;
      else if (t >= 19) tint = `rgba(30,45,90,${Math.min(0.32, 0.08 * (t - 19) + 0.12).toFixed(3)})`;
      if (tint) {
        ctx.fillStyle = tint;
        ctx.fillRect(0, 0, W, H);
      }
    }

    // 日付と時刻（書き出した画像でもいつの場面か分かるように）
    if (snap) {
      ctx.font = `700 15px ${FONT}`;
      const cap = `${this.world.town_name}　${snap.day}日目 ${snap.time}`;
      const cw = ctx.measureText(cap).width + 20;
      ctx.fillStyle = "rgba(251,248,240,0.88)";
      rr(ctx, 14, H - 38, cw, 26, 8);
      ctx.fill();
      ctx.fillStyle = "#1e3a5f";
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillText(cap, 24, H - 25);
    }

    // 吹き出し
    this.bubbles = this.bubbles.filter((b) => b.until > now);
    const placed = [];
    // 新しい吹き出しを優先して置き、重なる古いものはずらす。
    // 同じ場所で会話がいくつも重なると地図が埋まるので、場所ごとに新しいものから数個だけ出す
    const order = this.bubbles.slice().sort((a, b) => b.born - a.born);
    const shown = {};
    const limit = { say: 2, meeting: 3, thought: 1 };
    for (const b of order) {
      if (b.kind === "thought" && !this.showThought) continue;
      const p = this.pos[b.who];
      if (!p) continue;
      const r = snap && snap.residents.find((o) => o.name === b.who);
      const key = `${r ? r.loc : "?"}:${b.kind}`;
      shown[key] = (shown[key] || 0) + 1;
      if (shown[key] > (limit[b.kind] || 3)) continue;
      const alpha = Math.min(1, (b.until - now) / 500, (now - b.born) / 200);
      const avoid = Object.entries(this.pos).filter(([n]) => n !== b.who && snap && snap.residents.some((o) => o.name === n && o.active)).map(([, q]) => q);
      this.drawBubble(p.x, p.y, b.text, b.kind, alpha, placed, avoid);
    }
  }

  drawHouses(p) {
    const ctx = this.ctx;
    for (const c of this.chars) {
      if (!this.homeIndex[c.name]) continue;
      const x = this.housePos(c.name).x;
      const y = p.rect[1];
      ctx.fillStyle = "#fffaf0";
      ctx.fillRect(x - 26, y + 30, 52, 32);
      ctx.strokeStyle = "#cdbf9f";
      ctx.lineWidth = 1;
      ctx.strokeRect(x - 26, y + 30, 52, 32);
      ctx.fillStyle = c.color;
      ctx.globalAlpha = 0.85;
      ctx.beginPath();
      ctx.moveTo(x - 32, y + 31);
      ctx.lineTo(x, y + 10);
      ctx.lineTo(x + 32, y + 31);
      ctx.closePath();
      ctx.fill();
      ctx.globalAlpha = 1;
      this.label(x, y + 47, `${c.short}の家`, 10, "#55606d");
    }
  }

  label(x, y, text, size, color, bg) {
    const ctx = this.ctx;
    ctx.font = `500 ${size}px ${FONT}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    if (bg) {
      const w = ctx.measureText(text).width + 10;
      ctx.fillStyle = bg;
      rr(ctx, x - w / 2, y - size / 2 - 3, w, size + 6, 5);
      ctx.fill();
    }
    ctx.fillStyle = color;
    ctx.fillText(text, x, y);
  }

  drawBubble(x, y, text, kind, alpha, placed, avoid) {
    const ctx = this.ctx;
    const thought = kind === "thought";
    const meeting = kind === "meeting";
    ctx.save();
    ctx.globalAlpha = Math.max(0, alpha);
    ctx.font = `${thought ? 500 : 700} 13px ${FONT}`;
    const lines = wrap(ctx, text, 184, 3);
    const w = Math.max(...lines.map((l) => ctx.measureText(l).width)) + 18;
    const h = lines.length * 18 + 10;
    const W = this.W;
    const H = this.H;
    const cx = Math.max(6, Math.min(W - w - 6, x - w / 2));
    // 置き場所の候補：上・下・右・左（内心は下を先に）。ほかの吹き出しと住人（名前の札を含む）に重ならない所を選ぶ
    const above = { bx: cx, by: y - 26 - h, side: "above" };
    const below = { bx: cx, by: y + 38, side: "below" };
    const right = { bx: x + 24, by: y - h / 2, side: "right" };
    const left = { bx: x - 24 - w, by: y - h / 2, side: "left" };
    const above2 = { bx: cx, by: y - 26 - 2 * h - 6, side: "above" };
    const below2 = { bx: cx, by: y + 38 + h + 6, side: "below" };
    const cands = thought ? [below, right, left, above, below2, above2] : [above, below, right, left, above2, below2];
    const self = { x, y };
    const hits = (bx, by) => {
      let n = 0;
      for (const q of placed) if (bx < q.x + q.w && bx + w > q.x && by < q.y + q.h && by + h > q.y) n += 10;
      for (const a of avoid) if (a.x + 16 > bx && a.x - 16 < bx + w && a.y + 34 > by && a.y - 16 < by + h) n += 3;
      if (self.x + 16 > bx && self.x - 16 < bx + w && self.y + 30 > by && self.y - 16 < by + h) n += 8;
      if (bx < 2 || by < 2 || bx + w > W - 2 || by + h > H - 2) n += 6;
      return n;
    };
    let best = cands[0];
    let bestScore = Infinity;
    for (const c of cands) {
      const sc = hits(c.bx, c.by);
      if (sc < bestScore) {
        best = c;
        bestScore = sc;
      }
    }
    let bx = best.bx;
    let by = best.by;
    // それでもほかの吹き出しと重なるなら、上下にずらす
    for (let guard = 0; guard < 8 && bestScore >= 10; guard++) {
      const hitB = placed.find((q) => bx < q.x + q.w && bx + w > q.x && by < q.y + q.h && by + h > q.y);
      if (!hitB) break;
      by = best.side === "below" || thought ? hitB.y + hitB.h + 4 : hitB.y - h - 4;
    }
    bx = Math.max(2, Math.min(W - w - 2, bx));
    by = Math.max(2, Math.min(H - h - 2, by));
    placed.push({ x: bx, y: by, w, h });
    ctx.fillStyle = thought ? "rgba(240,234,250,0.96)" : meeting ? "#fff4ef" : "#ffffff";
    ctx.strokeStyle = thought ? "#8b78ad" : meeting ? "#c0432a" : "#1e3a5f";
    ctx.lineWidth = 1.5;
    if (thought) ctx.setLineDash([3, 3]);
    rr(ctx, bx, by, w, h, 9);
    ctx.fill();
    ctx.stroke();
    // しっぽ：吹き出しの縁のうち話し手に近い所から、話し手の方へ短く出す
    let ax;
    let ay;
    if (y >= by + h) {
      ax = Math.max(bx + 12, Math.min(bx + w - 12, x));
      ay = by + h;
    } else if (y <= by) {
      ax = Math.max(bx + 12, Math.min(bx + w - 12, x));
      ay = by;
    } else {
      ax = x < bx ? bx : bx + w;
      ay = Math.max(by + 10, Math.min(by + h - 10, y));
    }
    const dx = x - ax;
    const dy = y - ay;
    const len = Math.hypot(dx, dy) || 1;
    const reach = Math.max(0, Math.min(12, len - 17));
    const tipX = ax + (dx / len) * reach;
    const tipY = ay + (dy / len) * reach;
    const nx = (-dy / len) * 6;
    const ny = (dx / len) * 6;
    if (reach > 2) {
      ctx.beginPath();
      ctx.moveTo(ax + nx, ay + ny);
      ctx.lineTo(tipX, tipY);
      ctx.lineTo(ax - nx, ay - ny);
      ctx.closePath();
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(ax + nx, ay + ny);
      ctx.lineTo(tipX, tipY);
      ctx.lineTo(ax - nx, ay - ny);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.fillStyle = thought ? "#4b3d66" : "#1d2733";
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    lines.forEach((l, i) => ctx.fillText(l, bx + 9, by + 6 + i * 18));
    ctx.restore();
  }

}

function onSegment(A, B, P) {
  const cross = (B[0] - A[0]) * (P[1] - A[1]) - (B[1] - A[1]) * (P[0] - A[0]);
  if (Math.abs(cross) > 2 * Math.hypot(B[0] - A[0], B[1] - A[1])) return false;
  const dot = (P[0] - A[0]) * (B[0] - A[0]) + (P[1] - A[1]) * (B[1] - A[1]);
  const len2 = (B[0] - A[0]) ** 2 + (B[1] - A[1]) ** 2;
  return dot >= 0 && dot <= len2;
}

function easeInOut(t) {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}
