# Deploying the Chip Room

The site is static: `npm run build:web` produces `dist-web/`, which any static
host can serve. The page loads the compiled core as plain ES modules, so there is
no bundler and no server-side runtime.

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
