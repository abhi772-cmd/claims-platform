# Docker — production images

Two images, one per app:

| App | Dockerfile | Image tag (CI) | Listens on |
|---|---|---|---|
| NestJS API | `apps/api/Dockerfile` | `digisparsh-claims-api` | `:3001` |
| Next.js web | `apps/web/Dockerfile` | `digisparsh-claims-web` | `:3000` |

Both are multi-stage. The runner stage runs as **non-root (`node` user, UID 1000)** and uses **`tini` as PID 1** so SIGTERM drains in-flight requests instead of being SIGKILLed.

## Build context is the repo root

Both Dockerfiles **must be built from the repo root** because the apps import workspace packages (`@claims/contracts`, `@claims/error-codes`, `@claims/ui-tokens`) that live at `packages/*`. The Dockerfile path is given via `-f`:

```bash
# From repo root
docker build -f apps/api/Dockerfile -t digisparsh-claims-api:latest .
docker build -f apps/web/Dockerfile \
  --build-arg NEXT_PUBLIC_API_BASE_URL=https://api.digisparsh.in \
  -t digisparsh-claims-web:latest .
```

Trying to build from `apps/api/` directly will fail at `COPY packages/...`.

## Public env vars are baked at build time

`NEXT_PUBLIC_*` env vars are inlined into the Next.js JS bundle during `next build`. They cannot be changed at container-run time. Pass them as `--build-arg` when building the web image:

```bash
docker build -f apps/web/Dockerfile \
  --build-arg NEXT_PUBLIC_API_BASE_URL=https://api.digisparsh.in \
  -t digisparsh-claims-web:latest .
```

Server-side env vars (`DATABASE_URL`, `JWT_SECRET`, `NHCX_*`) are read at runtime and **must** be passed via `--env-file` or the orchestrator's secrets, never via build args.

## Running locally end-to-end

Reference orchestration is at `infra/docker-compose/docker-compose.prod.yml`. It wires:

- `migrate` (one-shot Prisma `migrate deploy`)
- `api` (depends on `migrate` completing)
- `web` (depends on `api` healthy)

```bash
# 1. Build both images
docker build -f apps/api/Dockerfile -t digisparsh-claims-api:dev .
docker build -f apps/web/Dockerfile -t digisparsh-claims-web:dev .

# 2. Provide a Postgres + Redis (the dev compose file works:
#    `pnpm infra:up` and point DATABASE_URL at host.docker.internal:5433)

# 3. Run the prod stack
docker compose -f infra/docker-compose/docker-compose.prod.yml up
```

Open http://localhost:3000.

## Migrations in production

The API image's default `CMD` runs `prisma migrate deploy` before booting. **This is fine for a single-replica deploy.** For multi-replica deploys, the replicas race the same `_prisma_migrations` table; one wins, the rest fail.

The `docker-compose.prod.yml` shows the correct pattern: a separate `migrate` service that runs to completion first, and the API service overrides `CMD` to skip migrations on boot. In Kubernetes, do the same with a `Job` resource gating a `Deployment`.

## Image sizes (target)

| Image | Target | What dominates |
|---|---|---|
| API runner | ~250 MB | Node 20 base + prisma engine + prod node_modules |
| Web runner | ~150 MB | Node 20 base + Next standalone tree |

Run `docker images digisparsh-claims-*` after building to verify. If either is significantly larger, check that `.dockerignore` is excluding `node_modules`, `.next/cache`, and tests.

## Health checks

- API: `GET /health/live` (liveness — always 200), `GET /health/ready` (readiness — checks DB)
- Web: `GET /` (200 means Next.js is serving)

Both images have a `HEALTHCHECK` directive so Docker / Kubernetes can drive restart policy without an external probe.

## OVH cutover (next steps)

1. **Push images to OVH's container registry**: `docker tag digisparsh-claims-api:latest <registry>.gra.cloud.ovh.net/digisparsh/api:latest && docker push ...`
2. **Wire CI** (GitHub Actions): build + push on every merge to `main`
3. **Kubernetes manifests** (or OVH Container Engine equivalent): `Deployment` for api + web, `Service` for each, `Ingress` with TLS, a one-shot `Job` for migrations gated on every release
4. **Secrets**: load `DATABASE_URL`, `JWT_SECRET`, NHCX credentials etc. from OVH Secret Manager → Kubernetes `Secret` → env vars
5. **Logs + metrics**: API uses structured pino logging; pipe to OVH Logs Data Platform or an external sink

See `PRODUCTION_HANDOVER.md` (repo root) for the full production checklist.
