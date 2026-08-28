/**
 * Vercel entry point for the play-money API.
 *
 * Serverless invocations are short-lived, so the store is built once per cold
 * start and reused across requests on the same instance. The schema is applied
 * lazily on the first request rather than at import time, so a database that is
 * briefly unreachable produces a clear error instead of an instance that fails
 * to boot.
 */
import { createApi } from "../dist/server/api.js";
import { PostgresDb } from "../dist/server/db-postgres.js";
import { migrate } from "../dist/server/schema.js";
import { Store } from "../dist/server/store.js";

const CONNECTION_STRING = process.env.DATABASE_URL?.trim();
const TRUST_PROXY = Number(process.env.TRUST_PROXY ?? 1);

let handler = null;
let ready = null;

function build() {
  // Vercel terminates TLS and forwards the client address, so one hop is
  // trusted by default here — unlike the standalone server, which faces the
  // client directly and trusts nothing.
  const db = new PostgresDb(CONNECTION_STRING);
  const store = new Store(db);
  const api = createApi(store, {
    trustedProxies: Number.isInteger(TRUST_PROXY) && TRUST_PROXY > 0 ? TRUST_PROXY : 0,
  });
  return { db, api };
}

export default async function vercelHandler(req, res) {
  if (!CONNECTION_STRING) {
    res.writeHead(503, { "content-type": "application/json; charset=utf-8" });
    res.end(
      JSON.stringify({
        error:
          "This deployment has no database configured. Set the DATABASE_URL " +
          "environment variable in the Vercel project to a Postgres connection " +
          "string, then redeploy.",
      }),
    );
    return;
  }

  if (!handler) {
    const built = build();
    handler = built.api;
    ready = migrate(built.db, "postgres");
  }

  try {
    await ready;
  } catch (err) {
    // A failed migration must not be cached as success; let the next request retry.
    ready = null;
    handler = null;
    console.error("Schema migration failed:", err);
    res.writeHead(503, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "The database is not reachable right now." }));
    return;
  }

  if (!(await handler(req, res))) {
    res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "No such endpoint." }));
  }
}
