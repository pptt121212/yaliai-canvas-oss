# Storage

Yali Canvas OSS uses PostgreSQL as the production persistence layer. Local JSON persistence is not a supported production mode.

## PostgreSQL

PostgreSQL stores durable business data:

- admin catalog and control-plane settings
- upstream providers and business channels
- tenants, API keys, and tenant balances
- image pricing and billing ledgers
- request traces and audit logs
- async image tasks and canvas workflow runs
- operational report rollups

Initialize the schema before starting production processes:

```bash
DATABASE_URL='postgresql://user:pass@127.0.0.1:5432/yaliai_canvas' \
PG_SCHEMA=public \
pnpm --filter @yali/api bootstrap:postgres
```

Recommended PostgreSQL settings depend on machine size, but the deployment should at least provide enough connections for every PM2 API process, the worker process, admin requests, and maintenance jobs. The application-side pool size is controlled by `PG_POOL_MAX`.

## Redis

Redis stores shared hot-path runtime state:

- provider runtime health
- smart-routing counters and route hot state
- short TTL snapshots
- queue claim locks
- multi-process coordination state

Redis is required for multi-process API deployments and for the canvas Worker. Those modes use Redis for accurate runtime counters, task claims, and locks. A single API process may omit Redis only for local development without the Worker.

## File Assets

The API still uses configured directories for binary assets that should not be stored inside PostgreSQL:

- generated images that need URL responses
- temporary reference images used by multipart image workflows
- upstream probe preview images

Configure the asset root with `ADMIN_DATA_DIR`. The gateway stores generated images in `$ADMIN_DATA_DIR/generated-images` and canvas reference assets in `$ADMIN_DATA_DIR/canvas-reference-assets`.

`PROVIDER_DATA_DIR` remains a compatibility setting for legacy local provider storage and is not required in PostgreSQL-backed production mode. `GENERATED_IMAGE_DIR` currently affects the admin disk metric only; it does not change the gateway's generated-image storage path.

The Nginx example uses an internal acceleration path for generated images:

- public URL returned by API: `/v1/generated-images/...`
- internal Nginx alias: `/_generated-images/...`, mapped to `$ADMIN_DATA_DIR/generated-images`

To enable this acceleration path, set `GENERATED_IMAGE_ACCEL_REDIRECT_TARGET_DIR` to the same generated-image directory. If it is unset, the API safely falls back to direct Node.js streaming.

Keep these directories outside the Git working tree and make sure the Node process user can read and write them.

## Retention

Operational data should have explicit retention rules:

- request traces are short-lived diagnostic data
- generated image files should be pruned by the gateway cleanup flow
- temporary reference images should be pruned after the configured retention window
- billing ledgers and audit logs should be retained according to your business requirements

Do not store large `b64_json` payloads in long-lived business tables unless your deployment explicitly requires it.
