// 小さな道具：時刻、乱数、文字列の整形

export function hhmmToMin(s) {
  const m = /^(\d{2}):(\d{2})$/.exec(String(s));
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 24 || mi > 59) return null;
  return h * 60 + mi;
}

export function minToHhmm(min) {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

// 再現できる乱数（mulberry32）
export function makeRng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int(min, max) {
      return min + Math.floor(next() * (max - min + 1));
    },
    pick(arr) {
      return arr[Math.floor(next() * arr.length)];
    },
    chance(p) {
      return next() < p;
    },
    shuffle(arr) {
      const a2 = arr.slice();
      for (let i = a2.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [a2[i], a2[j]] = [a2[j], a2[i]];
      }
      return a2;
    },
  };
}

// 制御文字を除き、長さを切る（AI の文字列や天の声の自由入力に使う）
export function cleanText(s, max) {
  const t = String(s ?? "")
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return [...t].slice(0, max).join("");
}

export function charLen(s) {
  return [...String(s ?? "")].length;
}

// 送る前のトークン数の見積もり（多めに）：UTF-8 のバイト数の半分
export function estimateTokens(text) {
  return Math.ceil(Buffer.byteLength(String(text), "utf8") / 2);
}

export function nowStamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export function round6(x) {
  return Math.round(x * 1e6) / 1e6;
}

export function clamp(x, lo, hi) {
  return Math.max(lo, Math.min(hi, x));
}
