# Architecture

Yali Canvas OSS is split into independent frontend, admin, API gateway, and shared package layers. The split is intentional: provider routing, tenant authorization, billing, and persistence stay on the backend; the canvas UI stays focused on workflow editing and interaction.

## Services

### `apps/web`

- React canvas frontend.
- Supports standalone local mode.
- Can be integrated with a backend runtime through explicit runtime config.
- Does not contain upstream routing, billing, or tenant settlement logic.

### `apps/admin`

- React admin console.
- Manages upstream providers, business channels, tenants, API keys, image pricing, billing ledgers, request traces, route diagnostics, and operational reports.
- Is deployed as static assets, usually under `/admin/`.

### `apps/api`

- Fastify API gateway.
- Exposes OpenAI-compatible downstream APIs.
- Normalizes downstream image/chat requests.
- Routes requests to configured upstream providers.
- Handles tenant authentication, billing, request traces, audit logs, async image tasks, canvas workflow tasks, and admin APIs.

## Shared Packages

- `packages/provider-core`: provider adapter contracts and upstream protocol abstractions.
- `packages/billing-core`: billing and settlement contracts.
- `packages/workflow-schema`: shared workflow data structures.
- `packages/canvas-core`: reusable canvas runtime and UI logic.
- `packages/ui-canvas`: canvas UI package boundary.

## Runtime Dependencies

Production mode uses:

- PostgreSQL as the durable source of truth.
- Redis as the shared hot-state layer for multi-process runtime coordination.
- PM2 cluster mode, or an equivalent process manager, for API concurrency.
- A separate worker process for canvas workflow queue execution.
- Nginx or another reverse proxy for TLS, static assets, body-size limits, and internal generated-image acceleration.

`DATABASE_URL` is required for production. Redis is strongly recommended when running more than one API process because route hot state, counters, and locks must be shared across processes.

## Request Flow

1. A downstream tenant sends an OpenAI-compatible request.
2. `apps/api` authenticates the API key and loads runtime catalog data.
3. The gateway normalizes request size, quality, output format, reference images, and protocol metadata.
4. Smart routing selects an eligible upstream provider from business-channel configuration and runtime health data.
5. The gateway converts the request to the selected upstream protocol when needed.
6. The upstream response is normalized back into the downstream protocol.
7. The response is returned to the tenant as early as possible.
8. Durable traces, billing settlement, task state, and operational metrics are persisted through the PostgreSQL-backed storage layer.

## Storage Boundary

Durable data belongs in PostgreSQL:

- admin catalog and control-plane configuration
- upstream provider definitions
- tenants and API keys
- request traces
- audit logs
- billing ledgers
- async task records
- canvas workflow run records
- operational rollup reports

Short-lived shared runtime state belongs in Redis:

- route hot state
- provider runtime health
- queue claim locks
- short TTL counters and snapshots

The project does not use local JSON files as a production persistence layer.
