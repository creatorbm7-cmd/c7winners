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

# Drop privileges: the server needs to read its own files and write one database.
RUN mkdir -p /data && chown node:node /data
USER node

CMD ["node", "dist/server/main.js"]
