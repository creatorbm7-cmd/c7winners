/**
 * The c7winners server: the play-money API, with the static site alongside it.
 *
 * Serving both from one process keeps the front end same-origin, so by default
 * there is no CORS surface and no third-party origin to allow in the CSP. A
 * front end deployed elsewhere is the exception, and needs its origin named in
 * ALLOWED_ORIGINS before the browser will let it read a reply.
 */
import { createServer } from "node:http";
import { chownSync, existsSync, mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, extname, join, normalize } from "node:path";
import { createApi, parseAllowedOrigins } from "./api.js";
import { createDatabase } from "./database.js";
import { migrate } from "./schema.js";
import { Store } from "./store.js";

const PORT = Number(process.env["PORT"] ?? 8080);
const DB_PATH = process.env["DATABASE_PATH"] ?? "c7winners.db";
const WEB_ROOT = process.env["WEB_ROOT"] ?? "dist-web";
/**
 * How many proxies in front of this server are yours.
 *
 * 0 (the default) ignores `X-Forwarded-For` entirely. Set this only to the real
 * number of hops you control: trusting the header when nothing is in front means
 * any client can send a different address per request and slip every rate limit.
 * Behind one load balancer, TRUST_PROXY=1.
 */
const TRUST_PROXY = Number(process.env["TRUST_PROXY"] ?? 0);

/**
 * Browser origins allowed to call this API from a page they serve, separated by
 * commas.
 *
 * Empty (the default) is the right answer whenever this server serves its own
 * front end: that page is same-origin and needs no permission. Set it only when
 * a page you control is served from somewhere else — `https://c7winners.com`,
 * say — and name that origin exactly. There is no wildcard on purpose.
 */
const ALLOWED_ORIGINS = (() => {
  try {
    return parseAllowedOrigins(process.env["ALLOWED_ORIGINS"]);
  } catch (err) {
    // Named here rather than in the parser, so the operator reading the deploy
    // log is told which variable to go and fix.
    throw new Error(`ALLOWED_ORIGINS: ${(err as Error).message}`);
  }
})();

/**
 * The commit this build came from, if the platform tells the process.
 *
 * Railway injects `RAILWAY_GIT_COMMIT_SHA`; `GIT_COMMIT` is there for anywhere
 * that does not. Without one of them the field is simply absent, which is
 * honest — better than printing a value that might be from another build.
 */
const COMMIT = (process.env["RAILWAY_GIT_COMMIT_SHA"] ?? process.env["GIT_COMMIT"] ?? "").trim();

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

/**
 * Takes ownership of the database directory, then gives up root.
 *
 * A volume arrives owned by root. This server is meant to run unprivileged, so
 * the first boot after one is attached cannot open its own database: SQLite
 * fails, the process dies before it listens, and the platform keeps the
 * previous container serving — which from outside is indistinguishable from a
 * deploy that never happened. The image cannot fix it either, since the mount
 * replaces whatever ownership the image gave that path.
 *
 * So the process starts as root, long enough to make that one directory and
 * hand it to the user it is about to become, and then becomes that user. If any
 * of that fails it exits: carrying on as root would trade a visible outage for
 * an invisible privilege.
 *
 * Started unprivileged already — locally, or on a platform that drops for us —
 * this does nothing at all.
 */
function takeDataDirectoryAndDropRoot(path: string): void {
  if (process.getuid?.() !== 0) return;

  // The `node` user in the official images. Overridable for an image that
  // numbers its unprivileged user differently.
  const uid = Number(process.env["RUN_AS_UID"] ?? 1000);
  const gid = Number(process.env["RUN_AS_GID"] ?? uid);
  if (!Number.isInteger(uid) || uid <= 0 || !Number.isInteger(gid) || gid <= 0) {
    throw new Error(`RUN_AS_UID/RUN_AS_GID must be positive integers, got ${uid}/${gid}.`);
  }

  const directory = dirname(path);
  try {
    mkdirSync(directory, { recursive: true });
    chownSync(directory, uid, gid);
    if (existsSync(path)) chownSync(path, uid, gid);
  } catch (err) {
    throw new Error(`Could not hand ${directory} to uid ${uid}: ${(err as Error).message}`);
  }

  try {
    process.setgid?.(gid);
    process.setuid?.(uid);
  } catch (err) {
    throw new Error(`Could not drop root to uid ${uid}: ${(err as Error).message}`);
  }
  if (process.getuid?.() !== uid) {
    throw new Error(`Refusing to run as root: the drop to uid ${uid} did not take.`);
  }
  console.log(`  dropped root: now uid ${uid}, ${directory} is ours`);
}

takeDataDirectoryAndDropRoot(DB_PATH);

// Checked before the database is opened, because opening it creates the file:
// after that there is no way to tell a first boot from a wiped one.
const sqliteFileExisted = existsSync(DB_PATH);

const { db, dialect } = createDatabase({
  connectionString: process.env["DATABASE_URL"],
  sqlitePath: DB_PATH,
});
await migrate(db, dialect);

const createdThisBoot = dialect === "sqlite" && !sqliteFileExisted;

const store = new Store(db);
const api = createApi(store, {
  trustedProxies: Number.isInteger(TRUST_PROXY) && TRUST_PROXY > 0 ? TRUST_PROXY : 0,
  storage: { engine: dialect, createdThisBoot },
  allowedOrigins: ALLOWED_ORIGINS,
  ...(COMMIT ? { build: { commit: COMMIT } } : {}),
});

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
  console.log(`  database: ${dialect}${dialect === "sqlite" ? ` (${DB_PATH})` : ""}`);
  console.log(`  web root: ${WEB_ROOT}`);
  console.log(`  trusted proxies: ${TRUST_PROXY}${TRUST_PROXY === 0 ? " (X-Forwarded-For ignored)" : ""}`);
  console.log(
    `  allowed origins: ${ALLOWED_ORIGINS.join(", ") || "none (this API answers same-origin pages only)"}`,
  );
  console.log(`  build: ${COMMIT || "unknown (no RAILWAY_GIT_COMMIT_SHA or GIT_COMMIT)"}`);

  // Loud on purpose. A wiped database is otherwise indistinguishable from a
  // healthy empty one: the process starts, /api/health passes, and the only
  // evidence is that every account is gone. Saying so at boot puts the fact in
  // the deploy log, where it is read at exactly the moment it can be acted on.
  if (createdThisBoot) {
    console.warn(
      `  WARNING: no database existed at ${DB_PATH}; a new one was created.\n` +
        `  Expected on a first deploy. On any later one it means the file is not\n` +
        `  on a persistent volume, and every account just went with the old\n` +
        `  container. Mount a volume and point DATABASE_PATH inside it, or set\n` +
        `  DATABASE_URL to a Postgres instance. See DEPLOY.md.`,
    );
  }
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
