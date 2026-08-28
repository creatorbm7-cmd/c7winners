/**
 * The c7winners server: the play-money API, with the static site alongside it.
 *
 * Serving both from one process keeps the front end same-origin, so there is no
 * CORS surface and no third-party origin to allow in the CSP.
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { createApi } from "./api.js";
import { openDatabase } from "./schema.js";
import { Store } from "./store.js";

const PORT = Number(process.env["PORT"] ?? 8080);
const DB_PATH = process.env["DATABASE_PATH"] ?? "c7winners.db";
const WEB_ROOT = process.env["WEB_ROOT"] ?? "dist-web";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
};

const CSP =
  "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
  "font-src https://fonts.gstatic.com; script-src 'self'; img-src 'self' data:; " +
  "base-uri 'none'; form-action 'none'; frame-ancestors 'self'";

const store = new Store(openDatabase(DB_PATH));
const api = createApi(store);

const server = createServer((req, res) => {
  void (async () => {
    if (await api(req, res)) return;

    const path = (req.url ?? "/").split("?")[0] ?? "/";
    const rel = normalize(path === "/" ? "/index.html" : path).replace(/^(\.\.[/\\])+/, "");
    try {
      const body = await readFile(join(WEB_ROOT, rel));
      res.writeHead(200, {
        "content-type": TYPES[extname(rel)] ?? "application/octet-stream",
        "content-security-policy": CSP,
        "x-content-type-options": "nosniff",
        "referrer-policy": "strict-origin-when-cross-origin",
      });
      res.end(body);
    } catch {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("not found");
    }
  })();
});

server.listen(PORT, () => {
  console.log(`c7winners listening on http://localhost:${PORT}`);
  console.log(`  database: ${DB_PATH}`);
  console.log(`  web root: ${WEB_ROOT}`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
