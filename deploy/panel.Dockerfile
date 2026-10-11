# syntax=docker/dockerfile:1
# Panel image: Fastify BFF + built Vue admin. Build context is the repo root.

FROM node:24-bookworm-slim AS build
# Toolchain only as a fallback if no better-sqlite3 prebuild matches.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
RUN corepack enable
WORKDIR /repo

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc tsconfig.base.json ./
COPY apps/bff/package.json apps/bff/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
COPY packages/templates/package.json packages/templates/
RUN pnpm install --frozen-lockfile

COPY apps ./apps
COPY packages ./packages
RUN pnpm -r build \
 && pnpm --filter @clawdesk/bff --prod deploy --legacy /out \
 && cp -r apps/bff/drizzle /out/drizzle \
 && cp -r apps/web/dist /out/web

FROM node:24-bookworm-slim
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080 DATA_DIR=/data WEB_DIST=/app/web
WORKDIR /app
COPY --from=build /out /app
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 8080
CMD ["node", "dist/index.js"]
