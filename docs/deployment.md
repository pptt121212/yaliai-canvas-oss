# Production Deployment Guide

This guide describes a full production-style deployment for Yali Canvas OSS. It uses:

- `apps/api` as the OpenAI-compatible API gateway and admin API.
- `apps/admin` as the admin console under `/admin/`.
- `apps/web` as the canvas frontend under `/`.
- PostgreSQL as durable storage.
- Redis as the shared hot-state layer.
- PM2 cluster mode for API concurrency.
- One PM2 worker process for canvas workflow queue execution.
- Nginx for TLS, static assets, body-size limits, gzip, and generated-image acceleration.

All domains and paths below are examples. Replace them with your own deployment values.

## 1. Recommended Server Baseline

Minimum for a small deployment:

- 2 CPU cores
- 4 GB RAM
- 30 GB disk
- Ubuntu 22.04 / 24.04 or another modern Linux distribution

Recommended for real API traffic:

- 4+ CPU cores
- 8+ GB RAM
- SSD storage
- separate backups for PostgreSQL
- Redis enabled
- PM2 API instances set to `2` or more

Install system packages:

```bash
sudo apt update
sudo apt install -y git curl build-essential nginx postgresql postgresql-contrib redis-server
```

Install Node.js 22 and the repository-pinned pnpm version:

```bash
corepack enable
corepack prepare pnpm@11.7.0 --activate
node -v
pnpm -v
```

Install PM2:

```bash
pnpm add -g pm2
```

## 2. Directory Plan

Example layout:

```text
/opt/yaliai-canvas-oss/app          # Git checkout
/opt/yaliai-canvas-oss/data         # runtime data root
```

Create directories:

```bash
sudo mkdir -p /opt/yaliai-canvas-oss/app
sudo mkdir -p /opt/yaliai-canvas-oss/data
sudo mkdir -p /opt/yaliai-canvas-oss/data/generated-images
sudo mkdir -p /opt/yaliai-canvas-oss/data/canvas-reference-assets
sudo chown -R "$USER":"$USER" /opt/yaliai-canvas-oss
```

Do not put runtime data inside Git-tracked source directories.

## 3. PostgreSQL

Create database and user:

```bash
sudo -u postgres psql
```

```sql
create user yali_canvas with password 'replace-with-a-strong-password';
create database yali_canvas owner yali_canvas;
\q
```

The application uses `DATABASE_URL`:

```bash
export DATABASE_URL='postgresql://yali_canvas:replace-with-a-strong-password@127.0.0.1:5432/yali_canvas'
export PG_SCHEMA=public
```

Initialize tables:

```bash
pnpm --filter @yali/api build
DATABASE_URL="$DATABASE_URL" PG_SCHEMA="$PG_SCHEMA" pnpm --filter @yali/api bootstrap:postgres
```

Recommended application pool setting:

- `PG_POOL_MAX=12` is the default pool size per Node.js process.
- The default PM2 topology has two API processes plus one Worker, so PostgreSQL must allow roughly three application pools plus admin and maintenance headroom. Increase gradually only after sizing `max_connections` accordingly.

## 4. Redis

Redis is required by the supplied PM2 topology: it starts both a multi-process API cluster and a canvas Worker. A single API process without the Worker may omit Redis only for local development.

Start and enable Redis:

```bash
sudo systemctl enable redis-server
sudo systemctl start redis-server
redis-cli ping
```

Use:

```bash
export REDIS_URL='redis://127.0.0.1:6379'
```

Redis is used for short-lived shared state, route counters, provider runtime health, and queue locks. PostgreSQL remains the durable source of truth.

## 5. Build

Clone and build:

```bash
cd /opt/yaliai-canvas-oss/app
git clone <your-repository-url> .
pnpm install --frozen-lockfile
pnpm check
pnpm -r build
```

Build outputs:

- API server: `apps/api/dist/src/server.js`
- Worker: `apps/api/dist/src/worker.js`
- Admin static files: `apps/admin/dist`
- Canvas static files: `apps/web/dist`

## 6. Environment Variables

At minimum:

```bash
export NODE_ENV=production
export APP_CWD=/opt/yaliai-canvas-oss/app
export PORT=4010
export HOST=0.0.0.0
export GATEWAY_INSTANCE_ID='gateway-main' # optional in single-server mode; unique per gateway when scaled
export DATABASE_URL='postgresql://yali_canvas:replace-with-a-strong-password@127.0.0.1:5432/yali_canvas'
export PG_SCHEMA=public
export REDIS_URL='redis://127.0.0.1:6379'
export ADMIN_USERNAME=admin
export ADMIN_PASSWORD='replace-with-a-strong-admin-password'
export ADMIN_SESSION_SECRET='replace-with-a-long-random-secret'
export ADMIN_DATA_DIR=/opt/yaliai-canvas-oss/data
export GENERATED_IMAGE_ACCEL_REDIRECT_PREFIX='/_generated-images'
export GENERATED_IMAGE_ACCEL_REDIRECT_TARGET_DIR='/opt/yaliai-canvas-oss/data/generated-images'
export PUBLIC_API_BASE_URL='https://api.example.com'
export DEFAULT_TEST_REFERENCE_IMAGE_URL='https://api.example.com/test-assets/reference-test.png'
```

Important runtime tuning variables:

| Variable | Default | Purpose |
| --- | ---: | --- |
| `PM2_API_INSTANCES` | `2` | Number of clustered API processes. |
| `PM2_API_KILL_TIMEOUT_MS` | `660000` | Maximum time PM2 waits for an in-flight API request during reload. |
| `GRACEFUL_SHUTDOWN_TIMEOUT_MS` | `660000` | API process drain timeout after `SIGINT` or `SIGTERM`; keep it at least as large as the longest upstream request timeout. |
| `GATEWAY_INSTANCE_ID` | unset | Optional stable API gateway node ID. Set a unique value on each server only when using a load balancer. |
| `PG_POOL_MAX` | `12` | PostgreSQL pool size per process. |
| `API_REQUEST_BODY_LIMIT_BYTES` | `134217728` | Downstream request body limit. Match Nginx `client_max_body_size`. |
| `IMAGE_PAYLOAD_MAX_BYTES` | `12582912` | Absolute hard cap for one input image. It cannot exceed 12MiB. |
| `UPSTREAM_JSON_RESPONSE_MAX_BYTES` | `100663296` | Max upstream JSON response size. |
| `UPSTREAM_BINARY_RESPONSE_MAX_BYTES` | `67108864` | Max upstream binary response size. |
| `ASYNC_IMAGE_QUEUE_MAX` | `200` | Global async image queue cap. |
| `ASYNC_IMAGE_QUEUE_PER_API_KEY_MAX` | `20` | Per-key async queue cap. |
| `IMAGE_PERSISTENCE_OUTBOX_ENABLED` | `true` | Persist successful image task metadata outside the response hot path. |
| `OPERATIONAL_ROLLUP_ENABLED` | unset | Set to `false` to hard-disable operational rollup reports. |

Reference image limits are configured in the Admin Overview page under "Downstream API": single-image size, image count, and total decoded input size. Defaults are `12MiB`, `6`, and `30MiB`; these are also hard maximums, so a deployment can tighten them but cannot loosen them beyond the built-in safety boundary.
| `GENERATED_IMAGE_ACCEL_REDIRECT_TARGET_DIR` | unset | Enable Nginx internal acceleration when it matches the generated-image directory. |

## 7. PM2 Process Model

The provided template is `deploy/api/ecosystem.config.cjs`.

It starts:

- `yali-canvas-api`: clustered API gateway, default `2` instances.
- `yali-canvas-worker`: single worker process for canvas workflow queue execution.

Start:

```bash
cd /opt/yaliai-canvas-oss/app

export APP_CWD=/opt/yaliai-canvas-oss/app
export PM2_APP_NAME=yali-canvas-api
export PM2_WORKER_APP_NAME=yali-canvas-worker
export PM2_API_INSTANCES=2

pm2 start deploy/api/ecosystem.config.cjs
pm2 save
pm2 status
```

Configure PM2 startup:

```bash
pm2 startup systemd
```

Run the command printed by PM2, then:

```bash
pm2 save
```

Why API cluster + worker:

- API cluster improves concurrent downstream request handling.
- Redis shares hot state across API processes.
- The worker isolates canvas workflow queue execution from the HTTP response path.

## 8. Nginx

Use `deploy/nginx/example.conf` as the site template and replace:

- `api.example.com`
- `/opt/yaliai-canvas-oss/app`
- `/opt/yaliai-canvas-oss/data/generated-images`
- SSL certificate paths

Install the site:

```bash
sudo cp deploy/nginx/example.conf /etc/nginx/sites-available/yaliai-canvas-oss.conf
sudo ln -s /etc/nginx/sites-available/yaliai-canvas-oss.conf /etc/nginx/sites-enabled/yaliai-canvas-oss.conf
sudo nginx -t
sudo systemctl reload nginx
```

The example config:

- serves `apps/web/dist` at `/`
- serves `apps/admin/dist` at `/admin/`
- proxies `/v1/`, `/health`, and `/ready` to `apps/api`
- sets `client_max_body_size 128m`
- enables gzip for JSON/text/static responses
- keeps SSE latency safe by not gzipping `text/event-stream`
- uses `/_generated-images/` as an internal alias for generated image files
- gives static assets browser cache headers
- keeps admin assets no-cache for safer admin console updates

Do not enable generic Nginx proxy cache for `/v1/` API responses unless you fully understand the effect on tenant-specific authentication, billing, and generated images.

## 9. System Limits

High-concurrency image APIs can open many sockets and file handles. Review:

- `deploy/systemd/nginx-limits.conf`
- `deploy/nginx/nginx.conf`

Recommended Nginx values:

```nginx
worker_processes auto;
worker_rlimit_nofile 65535;

events {
    worker_connections 4096;
    multi_accept on;
}
```

Apply systemd override if needed:

```bash
sudo mkdir -p /etc/systemd/system/nginx.service.d
sudo cp deploy/systemd/nginx-limits.conf /etc/systemd/system/nginx.service.d/limits.conf
sudo systemctl daemon-reload
sudo systemctl restart nginx
```

Also make sure the OS open-file limit is high enough for the PM2 user.

## 10. First Admin Setup

Open:

```text
https://api.example.com/admin/
```

Then:

1. Log in with `ADMIN_USERNAME` and `ADMIN_PASSWORD`.
2. Add or probe upstream providers.
3. Configure business channels.
4. Configure image pricing.
5. Create tenants and downstream API keys.
6. Use the onboarding test or a downstream API request to verify generation.
7. Check request traces, billing ledger, route diagnostics, and audit logs.

The project does not ship with real upstream providers, real production domains, or real default tenant keys.

## 11. API Verification

Health check:

```bash
curl https://api.example.com/health
```

Images generation test:

```bash
curl https://api.example.com/v1/images/generations \
  -H "Authorization: Bearer <tenant-api-key>" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-image-2",
    "prompt": "A clean product photo on a white background",
    "size": "1024x1024",
    "response_format": "url"
  }'
```

Images edit multipart test:

```bash
curl https://api.example.com/v1/images/edits \
  -H "Authorization: Bearer <tenant-api-key>" \
  -F "model=gpt-image-2" \
  -F "prompt=Keep the subject and change the background to a studio scene" \
  -F "image=@./reference.png" \
  -F "size=1024x1024" \
  -F "response_format=url"
```

## 12. Updates

Recommended update flow:

```bash
cd /opt/yaliai-canvas-oss/app
git pull
pnpm install --frozen-lockfile
pnpm check
pnpm -r build
DATABASE_URL="$DATABASE_URL" PG_SCHEMA="$PG_SCHEMA" pnpm --filter @yali/api bootstrap:postgres
pm2 startOrReload deploy/api/ecosystem.config.cjs --only yali-canvas-api --update-env
pm2 restart yali-canvas-worker --update-env
sudo nginx -t
sudo systemctl reload nginx
```

## 13. Backups

Back up:

- PostgreSQL database
- runtime data directories
- generated image directory if you need long-term generated-image retention
- your environment variable management source

Example PostgreSQL backup:

```bash
pg_dump "$DATABASE_URL" > yaliai-canvas-oss-$(date +%F).sql
```

## 14. Scenario Guides

- [API-only deployment](./deployment-api-only.md)
- [Web-only deployment](./deployment-web-only.md)
- [Combined deployment](./deployment-combined.md)
- [Future API gateway scaling](./gateway-scaling.md)

## 15. Related Documents

- [Architecture](./architecture.md)
- [Storage](./storage.md)
- [Integration guide](./integration-guide.md)
- [Provider management](./provider-management.md)
- [Upstream image compatibility](./upstream-image-compatibility.md)
