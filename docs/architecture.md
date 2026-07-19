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

### Future Gateway Scaling

The default deployment remains a single complete server. When downstream API traffic grows, additional servers may run the API gateway only and share the existing PostgreSQL and Redis instances. A separate load balancer then distributes new `/v1/` requests to a selected gateway; that selected gateway calls the upstream provider and returns the image response directly to the downstream client. Image bytes must not be relayed back through the original server.

The API exposes two operational probes:

- `/health`: process liveness. It remains available during graceful shutdown for diagnosis.
- `/ready`: load-balancer eligibility. It returns `503` while the API is draining or when the enabled local overload guard has marked the node overloaded.

Every request trace includes a `gateway:<instance-id>` tag. Set `GATEWAY_INSTANCE_ID` to a stable, unique node name only when deploying multiple gateway servers. The single-server default needs no setting.

Generated-image and canvas-reference directories remain local in the single-server topology. Before multiple gateway nodes are allowed to return local generated-image URLs or serve shared reference assets, use a shared storage implementation. This is deliberately deferred and is not required for the default deployment.

`DATABASE_URL` is required in every API process. Redis is required when running more than one API process and whenever the canvas Worker is enabled: route hot state, counters, task claims, and locks must be shared across processes. A single API process may omit Redis only for local development without the Worker.

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
