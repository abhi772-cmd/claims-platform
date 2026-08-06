# syntax=docker/dockerfile:1.7

# Production image for the DigiSparsh Claims API (NestJS).
#
# Multi-stage:
#   1. base       — pinned Node + pnpm, shared by builder and runner
#   2. deps       — installs ALL workspace deps (needed for build)
#   3. builder    — nest build + prisma generate
#   4. runner     — minimal runtime image with only the build output +
#                   prod node_modules. Runs as a non-root user.
#
# Build context: repo root (NOT apps/api). Required because the API
# imports workspace packages (@claims/contracts, @claims/error-codes)
# that live at packages/* and need to be visible to pnpm at install
# time.
#
# Build:
#   docker build -f apps/api/Dockerfile -t digisparsh-claims-api:latest .
#
# Run:
#   docker run -p 3001:3001 --env-file apps/api/.env digisparsh-claims-api:latest

# ---------- 1. Base ----------
FROM node:20-alpine AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@9.7.0 --activate
# tini = proper PID 1 (clean SIGTERM handling so the API drains
# in-flight requests on container stop instead of being SIGKILLed).
# openssl = required by Prisma's query engine at runtime.
RUN apk add --no-cache tini openssl
WORKDIR /app

# ---------- 2. Deps ----------
# Copy every workspace manifest first so the install layer caches
# until any package.json / pnpm-lock changes. This is the single
# biggest perf win in CI.
FROM base AS deps
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY apps/api/package.json apps/api/
COPY packages/contracts/package.json packages/contracts/
COPY packages/error-codes/package.json packages/error-codes/
COPY packages/eslint-config/package.json packages/eslint-config/
COPY packages/ui-tokens/package.json packages/ui-tokens/
COPY apps/web/package.json apps/web/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

# ---------- 3. Builder ----------
FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=deps /app/packages/contracts/node_modules ./packages/contracts/node_modules
COPY --from=deps /app/packages/error-codes/node_modules ./packages/error-codes/node_modules
COPY . .
# Generate Prisma client first — nest build's TS compile pass needs
# the generated types in node_modules/@prisma/client.
RUN pnpm --filter @claims/contracts build || true
RUN pnpm --filter @claims/error-codes build || true
RUN pnpm --filter @claims/api prisma:generate
RUN pnpm --filter @claims/api build
# Strip dev dependencies from the workspace tree so the runner stage
# can copy a slimmer node_modules. `--prod` re-resolves the install
# tree without devDeps.
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod --filter @claims/api...

# ---------- 4. Runner ----------
FROM base AS runner
ENV NODE_ENV=production
ENV PORT=3001
# Non-root user — `node` is preinstalled at UID 1000 in the official
# image. Running as root is a common deploy-time CVE.
USER node
WORKDIR /app
# Copy build output + prod-only node_modules + Prisma client + schema.
# The dist path follows nest build's default output layout (which
# preserves apps/api/src/ within dist/).
COPY --chown=node:node --from=builder /app/node_modules ./node_modules
COPY --chown=node:node --from=builder /app/packages ./packages
COPY --chown=node:node --from=builder /app/apps/api/node_modules ./apps/api/node_modules
COPY --chown=node:node --from=builder /app/apps/api/dist ./apps/api/dist
COPY --chown=node:node --from=builder /app/apps/api/prisma ./apps/api/prisma
COPY --chown=node:node --from=builder /app/apps/api/package.json ./apps/api/package.json

WORKDIR /app/apps/api

EXPOSE 3001

# Health check — the API exposes /health/live (always-200 liveness)
# and /health/ready (deep readiness including DB). Orchestrators
# should probe /ready; tini-as-PID-1 ensures graceful shutdown.
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3001/health/live || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
# Run migrations on boot then start the API. For multi-replica
# deploys, run migrations as a separate one-shot Job instead — see
# infra/docker-compose/docker-compose.prod.yml for the pattern.
CMD ["sh", "-c", "node node_modules/prisma/build/index.js migrate deploy && node dist/apps/api/src/main.js"]
