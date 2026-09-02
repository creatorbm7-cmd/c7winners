# syntax=docker/dockerfile:1

# Node 22 is the floor: the SQLite path uses node:sqlite, which does not exist
# before it.
FROM node:22-slim AS build
WORKDIR /app

# Dependencies first, so a source-only change does not reinstall them.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
COPY web ./web
COPY scripts ./scripts
RUN npm run build:vercel   # tsc + the static front end -> dist/ and dist-web/

# ---

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Only what the server needs at runtime: no TypeScript, no test tooling.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist
COPY --from=build /app/dist-web ./dist-web

# The database lives on a mounted volume, not in the image layer, so it survives
# a redeploy. Without the mount every deploy would start with no accounts.
ENV PORT=8080 \
    DATABASE_PATH=/data/c7winners.db \
    WEB_ROOT=dist-web
EXPOSE 8080

# The server drops to this user itself, in main.ts, after it has taken ownership
# of the database directory. It has to be that way round: a mounted volume
# arrives owned by root and replaces whatever ownership this image gives /data,
# so a process that started unprivileged could never open its own database.
RUN mkdir -p /data && chown node:node /data
ENV RUN_AS_UID=1000 RUN_AS_GID=1000

CMD ["node", "dist/server/main.js"]
