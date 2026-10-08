// 自己点検：ブラウザ側が標準 API だけで書けているか、安全上の約束（innerHTML・eval を使わない等）を守っているかを調べる。
// 使い方：npm run selfcheck
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(here, "..");

function files(dir, exts) {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((d) => (d.isDirectory() ? files(path.join(dir, d.name), exts) : exts.includes(path.extname(d.name)) ? [path.join(dir, d.name)] : []));
}

// [正規表現, 理由, 重さ（NG=使ってはいけない／注意=古い Safari で動かない等）]
const WEB_RULES = [
  [/\.innerHTML\b|\.outerHTML\b|insertAdjacentHTML|document\.write/, "AI の文字列を HTML として解釈させない約束（textContent を使う）", "NG"],
  [/\beval\s*\(|new\s+Function\s*\(/, "文字列をコードとして実行しない", "NG"],
  [/\.roundRect\s*\(/, "CanvasRenderingContext2D.roundRect は Safari 16 未満に無い", "注意"],
  [/structuredClone\s*\(/, "Safari 15.4 未満に無い", "注意"],
  [/\.at\s*\(-?\d/, "Array.prototype.at は Safari 15.4 未満に無い", "注意"],
  [/Object\.hasOwn\s*\(/, "Safari 15.4 未満に無い", "注意"],
  [/\.findLast\s*\(|\.toSorted\s*\(|\.toReversed\s*\(/, "比較的新しい配列メソッド", "注意"],
  [/requestIdleCallback/, "Safari に無い", "NG"],
  [/OffscreenCanvas/, "Safari 16.4 未満に無い", "注意"],
  [/ctx\.filter|\.letterSpacing\s*=/, "Canvas の filter・letterSpacing は Safari で効かない", "NG"],
  [/navigator\.userAgent|navigator\.vendor/, "ブラウザ判定に頼らない", "注意"],
  [/\.showModal\s*\(|<dialog/, "dialog 要素は古い Safari で挙動が違う", "注意"],
  [/webkit[A-Z]|\bms[A-Z][a-z]+\(/, "ブラウザ固有の API", "NG"],
];
const CSS_RULES = [
  [/:has\(/, ":has() は Edge 105／Safari 15.4 未満に無い", "注意"],
  [/^\s*&/m, "CSS のネストは新しいブラウザだけ", "NG"],
  [/(^|[^-])backdrop-filter/, "Safari は -webkit- 付きが要る", "注意"],
  [/@container/, "コンテナクエリは新しいブラウザだけ", "注意"],
  [/color-mix\(/, "新しいブラウザだけ", "注意"],
  [/text-wrap\s*:/, "新しいブラウザだけ", "注意"],
];
const SERVER_RULES = [
  [/\beval\s*\(|new\s+Function\s*\(/, "AI の文字列を実行しない", "NG"],
  [/child_process|\bexecSync\b|\bspawn\s*\(/, "シェルやコマンドに渡さない", "NG"],
  [/import\s*\(\s*[^"'`\s]/, "動的 import に変数を渡さない", "NG"],
  [/0\.0\.0\.0|listen\(\s*\w+\s*\)/, "127.0.0.1 以外にバインドしない", "NG"],
  [/\btools\s*:/, "住人に tool を渡さない", "NG"],
  [/console\.(log|error)\([^)]*(getApiKeyForClient|apiKey\b)/, "キーを表示しない", "NG"],
];

let ng = 0;
let warn = 0;
const report = [];
function scan(list, rules, label) {
  for (const f of list) {
    const text = fs.readFileSync(f, "utf8");
    const lines = text.split("\n");
    for (const [re, why, level] of rules) {
      lines.forEach((line, i) => {
        if (line.trim().startsWith("//") || line.trim().startsWith("/*") || line.trim().startsWith("*")) return;
        if (re.test(line)) {
          report.push(`${level}\t${label}\t${path.relative(APP, f)}:${i + 1}\t${why}\t${line.trim().slice(0, 80)}`);
          if (level === "NG") ng++;
          else warn++;
        }
      });
    }
  }
}

scan(files(path.join(APP, "web"), [".js", ".html"]), WEB_RULES, "web");
scan(files(path.join(APP, "web"), [".css"]), CSS_RULES, "css");
scan(files(path.join(APP, "server"), [".js"]), SERVER_RULES, "server");

// textContent を使っているか（参考）
const appJs = fs.readFileSync(path.join(APP, "web", "app.js"), "utf8");
const usesText = (appJs.match(/textContent/g) || []).length;

console.log(`点検したファイル：web ${files(path.join(APP, "web"), [".js", ".html", ".css"]).length}、server ${files(path.join(APP, "server"), [".js"]).length}`);
console.log(`NG ${ng} 件、注意 ${warn} 件（app.js の textContent 使用 ${usesText} 箇所）`);
for (const r of report) console.log(r);
if (ng) process.exitCode = 1;
