// node:http だけで、静的ファイル・SSE・操作 API を出す。127.0.0.1 にだけバインドする。
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { WEB_DIR } from "./paths.js";
import { listRuns } from "./record.js";

const STATIC = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/index.html": ["index.html", "text/html; charset=utf-8"],
  "/style.css": ["style.css", "text/css; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/map.js": ["map.js", "text/javascript; charset=utf-8"],
};

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

function baseHeaders(type) {
  return {
    "Content-Type": type,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": CSP,
  };
}

function sendJson(res, code, obj) {
  res.writeHead(code, baseHeaders("application/json; charset=utf-8"));
  res.end(JSON.stringify(obj));
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export function startHttp({ port, runner, onClients, exportLog, exportMap }) {
  const clients = new Set();
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const allowedOrigins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);

  function broadcast(type, payload) {
    const data = `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const res of clients) res.write(data);
  }

  const server = http.createServer(async (req, res) => {
    try {
      // DNS リバインディング対策：Host が自分以外なら断る
      if (!allowedHosts.has(req.headers.host || "")) {
        res.writeHead(421, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("misdirected");
        return;
      }
      const url = new URL(req.url, `http://${req.headers.host}`);

      if (req.method === "GET" && STATIC[url.pathname]) {
        const [file, type] = STATIC[url.pathname];
        const body = fs.readFileSync(path.join(WEB_DIR, file));
        res.writeHead(200, baseHeaders(type));
        res.end(body);
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/events") {
        res.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-store",
          Connection: "keep-alive",
          "X-Content-Type-Options": "nosniff",
        });
        res.write("retry: 2000\n\n");
        res.write(`event: hello\ndata: ${JSON.stringify(runner().hello())}\n\n`);
        clients.add(res);
        onClients(clients.size);
        const hb = setInterval(() => res.write(": ping\n\n"), 15000);
        req.on("close", () => {
          clearInterval(hb);
          clients.delete(res);
          onClients(clients.size);
        });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/runs") {
        sendJson(res, 200, { runs: listRuns() });
        return;
      }

      if (req.method === "POST") {
        // ほかのサイトからの書き込みを断る
        const origin = req.headers.origin;
        if (origin && !allowedOrigins.has(origin)) {
          sendJson(res, 403, { ok: false, error: "forbidden origin" });
          return;
        }
        if (url.pathname === "/api/control") {
          if (!String(req.headers["content-type"] || "").startsWith("application/json")) {
            sendJson(res, 415, { ok: false, error: "JSON で送ってください" });
            return;
          }
          const raw = await readBody(req, 16 * 1024);
          let body;
          try {
            body = JSON.parse(raw.toString("utf8"));
          } catch {
            sendJson(res, 400, { ok: false, error: "JSON が読めません" });
            return;
          }
          const out = await runner().command(body);
          sendJson(res, 200, out);
          return;
        }
        if (url.pathname === "/api/export/log") {
          if (!String(req.headers["content-type"] || "").startsWith("application/json")) {
            sendJson(res, 415, { ok: false, error: "JSON で送ってください" });
            return;
          }
          sendJson(res, 200, exportLog());
          return;
        }
        if (url.pathname === "/api/export/map") {
          if (req.headers["content-type"] !== "image/png") {
            sendJson(res, 415, { ok: false, error: "PNG で送ってください" });
            return;
          }
          const png = await readBody(req, 12 * 1024 * 1024);
          sendJson(res, 200, exportMap(png));
          return;
        }
      }

      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("not found");
    } catch (e) {
      console.error("HTTP エラー:", e.message);
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: "サーバーで問題が起きました" });
      else res.end();
    }
  });

  server.listen(port, "127.0.0.1");
  return { server, broadcast };
}
