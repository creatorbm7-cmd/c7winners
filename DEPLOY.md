# Deploying the Chip Room

There are two things to deploy now: the **server** (accounts, balances, game) and
the **static front end** it serves. `npm run serve:api` runs both from one
process, which is the simplest thing that works.

The server runs on either engine: **Postgres** when `DATABASE_URL` is set, and
SQLite otherwise. Which one you need depends on the host.

| Host | Engine | Why |
| --- | --- | --- |
| Vercel and other serverless | Postgres | The filesystem resets between requests, so SQLite would lose every account |
| Fly, Railway, Render, a VPS | Either | A persistent disk means SQLite works, and needs no second service |

## Vercel + Supabase

`vercel.json` and `api/index.mjs` are already set up: the API runs as one
function and the static site is served alongside it.

```bash
npx vercel --prod
npx vercel domains add c7winners.com
```

Then set **`DATABASE_URL`** in the Vercel project (Settings → Environment
Variables) and redeploy. Until it is set, the site loads but every API call
answers 503 with a message saying exactly that.

Take the connection string from Supabase → Project Settings → Database →
Connection string → **Transaction pooler** (port 6543). The pooler is the right
one for serverless: each invocation opens its own connection, and the direct
port will run out of them under any real traffic.

`TRUST_PROXY` defaults to 1 in the Vercel function, which is correct behind
Vercel's edge. Leave it alone unless you add another proxy in front.

## Running the server

```bash
npm run build:web        # front end -> dist-web/
npm run serve:api        # API + site on :8080
```

Environment: `PORT` (default 8080), `DATABASE_PATH` (default `c7winners.db`),
`WEB_ROOT` (default `dist-web`), `TRUST_PROXY` (default `0`).

**Set `TRUST_PROXY` when you deploy behind a load balancer** — one hop is
`TRUST_PROXY=1`. Left at 0 behind a proxy, every request looks like it comes from
the proxy, so one visitor's traffic can exhaust the shared limit for everyone.
Set too high, or set at all with nothing in front, and a client can spoof
`X-Forwarded-For` to bypass the limits entirely. Match the real number of hops. The database is a single SQLite file — back it
up by copying it, and put it on a persistent volume, not a container filesystem
that resets on deploy.

A host that runs a Node process and gives you a disk (Fly.io, Railway, Render, a
VPS) fits this directly. Serverless platforms do not: SQLite needs a filesystem
that persists between requests.

```bash
npm run build:web   # -> dist-web/
npm run serve       # build, then serve it on http://localhost:8080
```

## Pointing c7winners.com at it

Pick one host. Each reads its config from this repo, so a push deploys.

### Vercel

```bash
npx vercel --prod          # first run links the project
npx vercel domains add c7winners.com
```

`vercel.json` already sets the build command, output directory and headers.
Vercel will print the DNS records to add at your registrar — usually an `A`
record for the apex and a `CNAME` for `www`.

### Netlify

```bash
npx netlify deploy --prod
npx netlify domains:add c7winners.com
```

`netlify.toml` carries the same settings.

### Cloudflare Pages

```bash
npx wrangler pages deploy dist-web --project-name c7winners
```

Then add the custom domain in the Pages project. If the domain's nameservers are
already on Cloudflare, the DNS record is created for you.

### Any other static host

Upload the contents of `dist-web/`. The only requirements are that `.js` files
are served with a JavaScript content type (ES modules are rejected otherwise)
and that `index.html` is the directory index.

## DNS

`c7winners.com` is already registered. Point it at whichever host you chose:

| Record | Name | Value |
| --- | --- | --- |
| A | `@` | the host's apex IP (they will give you this) |
| CNAME | `www` | the host's target, e.g. `cname.vercel-dns.com` |

Propagation is usually minutes, occasionally up to 48 hours. HTTPS certificates
are issued automatically by all three hosts once the records resolve.

## What is being deployed

A play-money site. Chips are issued free by a faucet, have no cash value, and
cannot be bought, sold or cashed out — there is no deposit path and no
withdrawal path in the build. No gaming licence or payment processor is
involved in running it.

Real-money operation is a different question entirely and is not unlocked by
deploying this. See the interlocks in `src/guards.ts`.

## Headers

Both configs ship a CSP that allows only this origin's own scripts, plus Google
Fonts for stylesheets and font files. If you add a third-party script — analytics,
a chat widget — you must widen `script-src`, or it will be blocked with no
visible error.
