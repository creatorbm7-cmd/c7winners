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

## Fly.io (recommended)

A persistent disk means SQLite works, so there is no second service to run and
no secret to set.

```bash
fly launch --no-deploy --name c7winners-play
fly volumes create c7winners_data --size 1 --region sin
fly deploy
fly certs add play.c7winners.com
```

A subdomain is the easy case for DNS: one CNAME, no IP records.

| Record | Name | Value |
| --- | --- | --- |
| CNAME | `play` | `c7winners-play.fly.dev` |

`fly certs show play.c7winners.com` reports when the certificate is issued —
usually a few minutes after the record resolves.

`fly.toml` and the `Dockerfile` carry the rest: the volume mount, the health
check on `/api/health`, and `TRUST_PROXY=1` for Fly's proxy.

> [!WARNING]
> Keep this app at **one machine**. Each Fly machine gets its own volume, so a
> second machine would be a second, separate database — whether an account exists
> would depend on which machine answered. `fly scale count 1` is the safe
> setting. To run more than one, set `DATABASE_URL` to a Postgres instance and
> the same image scales freely.

Back up by copying the database off the volume:

```bash
fly ssh console -C "cat /data/c7winners.db" > backup.db
```

### Deploying from GitHub

`.github/workflows/deploy.yml` runs the same `fly deploy` on every push to
`main`, once CI has gone green on that commit. Set one repository secret and it
takes over:

```bash
fly tokens create deploy -a c7winners-play
```

Paste the token into **Settings → Secrets and variables → Actions → New
repository secret**, named `FLY_API_TOKEN`. A deploy-scoped token can push
releases to this one app and nothing else in the organisation.

The workflow deploys the exact commit CI tested, not whatever `main` points at
by the time it starts, and it never runs two deploys at once. After the release
it asks `https://c7winners-play.fly.dev/api/health` through Fly's public edge —
the hostname is deliberate, since `play.c7winners.com` depends on DNS and a
certificate that a workflow cannot fix. **Run → Deploy → Run workflow**
redeploys the current `main` without a new commit.

It deploys; it does not create — with one deliberate exception. **Run workflow**
has a *create the Fly app and its volume before deploying* box, off by default.
Tick it the first time, when there is no app yet, and the run creates both from
the names in `fly.toml` before deploying. That box is the whole reason a machine
with `flyctl` is optional: the deploy token does the work.

It is off by default because a volume is a billable resource and an app created
under the wrong name is a worse outcome than a deploy that fails. Re-running with
the box ticked is safe: an existing app is left alone, and an existing volume is
never joined by a second one — two volumes would mean two machines with two
separate databases, the failure `fly.toml`'s header warns about.

## Railway

`railway.json` builds the same Dockerfile. Connect the repository in the Railway
dashboard and every push to `main` deploys itself — no token, no CLI, nothing to
install. That makes this the one host here that can be set up entirely from a
phone.

Three things have to be set on the service, and `railway.json` can carry none of
them:

| Setting | Value | Why |
| --- | --- | --- |
| Volume, mounted at | `/data` | Without it every deploy starts with no accounts |
| `DATABASE_PATH` | `/data/c7winners.db` | Puts the database on that volume |
| `TRUST_PROXY` | `1` | Railway terminates TLS one hop in front |

`TRUST_PROXY` earns its row. It defaults to 0, which is correct only with
nothing in front; left at 0 behind Railway's proxy, every request looks like it
came from the proxy, so one visitor's traffic can exhaust the rate limit for
everyone. The Dockerfile sets `PORT=8080`, and the server reads whatever `PORT`
the platform provides, so that one needs no attention.

> [!WARNING]
> Keep this service at **one replica**, for the reason `fly.toml`'s header gives:
> each replica gets its own volume, so a second would be a second, separate
> database, and whether an account exists would depend on which replica answered.
> To run more than one, set `DATABASE_URL` to a Postgres instance instead.

Settings → Networking generates a `*.up.railway.app` hostname, and takes a
custom domain: add `play.c7winners.com` there, then put the CNAME it prints at
the registrar, per [DNS](#dns).

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

The chip room lives at **`play.c7winners.com`**, a subdomain. The apex
`c7winners.com` is a separate site and is deliberately left alone: pointing it
here would take it down, and nothing in this repo needs it.

That makes the DNS a single record, at the registrar holding `c7winners.com`:

| Record | Name | Value |
| --- | --- | --- |
| CNAME | `play` | whatever the host gives you for this app |

The value depends on which host is serving it — `c7winners-play.fly.dev` for
Fly, or the target Railway prints when you add the custom domain. Only one host
holds `play` at a time; the record is what decides which.

A subdomain is the easy case, which is why it is the one chosen: apex records
cannot be CNAMEs, and a registrar without ALIAS support (GoDaddy, among others)
then needs its nameservers moved to a provider that flattens them. None of that
applies here.

Name the record `play`, not `play.c7winners.com` — registrars append the domain
themselves, and the full name produces `play.c7winners.com.c7winners.com`.
Propagation is usually minutes. Both hosts issue the certificate automatically
once the record resolves; behind Cloudflare, leave the record unproxied until it
does.

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
