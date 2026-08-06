# syntax=docker/dockerfile:1.7

# Production image for the DigiSparsh Claims web app (Next.js 14).
#
# Multi-stage:
#   1. base      — pinned Node + pnpm, shared by builder and runner
#   2. deps      — installs ALL workspace deps (Next needs devDeps to build)
#   3. builder   — `next build` against output:'standalone' (set in
#                  next.config.js) emits a self-contained .next/standalone
#                  tree that the runner can copy directly.
#   4. runner    — minimal runtime image with ONLY the standalone tree +
#                  static assets + public dir. Runs as a non-root user.
#
# Build context: repo root (NOT apps/web). Required because the web app
# imports workspace packages (@claims/contracts, @claims/error-codes,
# @claims/ui-tokens) via pnpm symlinks that need to be resolvable.
#
# Build:
#   docker build -f apps/web/Dockerfile -t digisparsh-claims-web:latest .
#
# Run:
#   docker run -p 3000:3000 \
#     -e NEXT_PUBLIC_API_BASE_URL=https://api.example.com \
#     digisparsh-claims-web:latest

# ---------- 1. Base ----------
FROM node:20-alpine AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@9.7.0 --activate
RUN apk add --no-cache tini
WORKDIR /app

# ---------- 2. Deps ----------
# Same monorepo manifest copy pattern as the API image — only
# package.json files in the first layer so the install cache holds
# until a manifest actually changes.
FROM base AS deps
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY apps/web/package.json apps/web/
COPY apps/api/package.json apps/api/
COPY packages/contracts/package.json packages/contracts/
COPY packages/error-codes/package.json packages/error-codes/
COPY packages/eslint-config/package.json packages/eslint-config/
COPY packages/ui-tokens/package.json packages/ui-tokens/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

# ---------- 3. Builder ----------
FROM base AS builder
# Public Next env vars must be set at build time — they're inlined
# into the JS bundle. Server-side env vars (DATABASE_URL etc.) are
# read at runtime and DON'T belong here.
ARG NEXT_PUBLIC_API_BASE_URL
ENV NEXT_PUBLIC_API_BASE_URL=${NEXT_PUBLIC_API_BASE_URL}

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/web/node_modules ./apps/web/node_modules
COPY --from=deps /app/packages/contracts/node_modules ./packages/contracts/node_modules
COPY --from=deps /app/packages/error-codes/node_modules ./packages/error-codes/node_modules
COPY --from=deps /app/packages/ui-tokens/node_modules ./packages/ui-tokens/node_modules
COPY . .
# Build the workspace packages first (Next's transpilePackages picks
# up source, but ui-tokens ships built CSS via package.json `style`).
RUN pnpm --filter @claims/contracts build || true
RUN pnpm --filter @claims/error-codes build || true
RUN pnpm --filter @claims/ui-tokens build || true
RUN pnpm --filter @claims/web build

# ---------- 4. Runner ----------
FROM base AS runner
ENV NODE_ENV=production
ENV PORT=3000
# Bind 0.0.0.0 so the container is reachable from the host.
ENV HOSTNAME=0.0.0.0
USER node
WORKDIR /app

# Next.js standalone output ships its own minimal node_modules inside
# .next/standalone. We copy that tree plus the static + public assets
# Next serves directly (the standalone server reads from these paths).
COPY --chown=node:node --from=builder /app/apps/web/.next/standalone ./
COPY --chown=node:node --from=builder /app/apps/web/.next/static ./apps/web/.next/static
COPY --chown=node:node --from=builder /app/apps/web/public ./apps/web/public

EXPOSE 3000

HEALTHCHECK --interval=15s --timeout=3s --start-period=15s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/ || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
# Standalone output writes server.js at the monorepo root inside the
# image. Path comes from apps/web/.next/standalone/apps/web/server.js
# being copied to ./apps/web/server.js in the runner.
CMD ["node", "apps/web/server.js"]
