# Future API Gateway Scaling

This guide is for a future capacity expansion. It does not change the normal single-server deployment, which remains the default and runs the API gateway, Worker, Admin, Canvas, PostgreSQL, Redis, and local generated-image directory together.

## Current Expansion Readiness

The project is intentionally single-server by default, but its core gateway state is already safe to share across multiple API processes and future gateway servers:

| Area | Current behavior | Multi-gateway status |
| --- | --- | --- |
| Tenants, API keys, pricing, billing, tasks, traces, and audits | PostgreSQL is authoritative. | Shared safely when every gateway uses the same database and schema. |
| Global concurrency, key limits, provider health, queue claims, and short-lived runtime state | Redis is authoritative for shared hot state. | Shared safely when every gateway uses the same Redis namespace. |
| Image persistence and billing | PostgreSQL outbox, transaction boundaries, and idempotency keys. | Multiple gateways may process events without duplicate charges. |
| Async image and canvas workflow claims | Redis claim keys. | Multiple processes may compete safely; only the claimant executes a task. |
| Control-plane configuration | PostgreSQL-backed catalog with change notifications and refresh. | Every gateway refreshes the same configuration. |
| Admin and Canvas static UI | Static files served by the current complete server. | Can remain on that server; they do not need to scale with API traffic initially. |
| Generated-image and canvas-reference files | Local `ADMIN_DATA_DIR` directories. | Not shareable across gateway servers without shared storage. |

This means a future API gateway pool can scale the synchronous downstream-to-upstream proxy path without changing tenant authorization, routing, task, or billing semantics. PostgreSQL and Redis are still central dependencies, not automatically multi-primary clusters; monitor their connections, CPU, memory, disk IOPS, and latency as traffic grows.

## Target Request Path

```text
downstream client -> load balancer -> selected API gateway -> upstream provider
                  <- direct response from the same API gateway <-
```

The load balancer is an independent network entrypoint, not the original business server. It selects a gateway only when a request begins. The selected gateway keeps the downstream connection, calls the upstream provider, and returns the result directly. Do not proxy image or Base64 response bytes back through the original server.

## What Stays Shared

All gateway servers must use the same PostgreSQL database and Redis service. PostgreSQL remains authoritative for tenants, API keys, configuration, traces, tasks, and billing. Redis remains authoritative for shared runtime coordination, including global concurrency, rate limits, provider health, queue claims, and short-lived counters.

Do not place any new authority for these values in a process-local memory cache.

## Gateway-Only Node

Deploy the same built API version on a new server, configure secure network access to the existing PostgreSQL and Redis services, and start only:

```bash
export GATEWAY_INSTANCE_ID='gateway-02'
export PM2_APP_NAME='yali-canvas-api-gateway'
pm2 start deploy/api/ecosystem.gateway.config.cjs --update-env
```

Do not start the Worker, PostgreSQL, Redis, Admin static site, or Canvas site on this new gateway-only node. It needs a controlled outbound route to upstream providers and must receive downstream API traffic only from the load balancer. The API process keeps its existing durable outbox and shared-claim behavior; PostgreSQL idempotency and Redis claims prevent multiple gateways from duplicating a billed task or queued execution.

The new gateway receives the full downstream request, calls the selected upstream provider, and returns the response itself. It must not send image bytes or Base64 responses back through the original complete server.

## Load Balancer Requirements

- Keep the public API hostname unchanged. Later, point `api.example.com` to the independent load-balancer IP or CNAME, not to the original business server.
- Use `/ready` as the backend health check. A `200` means the gateway is accepting new work; `503` means it is draining or locally overloaded.
- Do not use `/health` as the eligibility check; it is only a liveness endpoint.
- Support the project request limits, multipart uploads, large JSON/Base64 responses, SSE, and at least the configured upstream timeout (default `600s`).
- Forward `Host`, `X-Forwarded-For`, and `X-Forwarded-Proto`; restrict direct access to gateway nodes to the load balancer where practical.
- Use connection-aware distribution such as least-connections. A long-running image generation remains on the initially selected gateway.

`deploy/nginx/api-gateway.conf` is a gateway-only Nginx reference for the `/v1/`, `/ready`, and `/health` paths. It is not a complete replacement for the single-server site configuration.

## Images and Local Assets

The initial scale-out can safely distribute requests that return upstream public URLs or `b64_json`, because the selected gateway returns the response directly. Before allowing multiple gateways to return the project-local `/v1/generated-images/...` URLs or to access shared canvas reference assets, replace the local directories with shared storage. Do not enable multi-gateway local-image URLs before that condition is met.

This storage boundary does not affect the current single-server deployment. It is an expansion-time requirement only.

## Safe Cutover

1. Keep the current DNS and single-server deployment unchanged.
2. Add the existing server to the load balancer as a backend and verify `/ready`, `/v1/`, multipart, SSE, long image requests, billing, traces, and graceful drain.
3. Deploy one gateway-only node with a unique `GATEWAY_INSTANCE_ID` and run the same checks.
4. Confirm that both gateways see the same configuration and shared Redis/PostgreSQL state.
5. Reduce DNS TTL in advance, then point the existing API hostname to the independent load balancer.
6. Keep the original server as a lower-weight gateway until production metrics show the new topology is stable.

No DNS, storage, or topology change is required until a real second gateway is being added.
