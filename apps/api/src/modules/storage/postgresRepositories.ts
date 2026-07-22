import { Pool, type PoolConfig } from 'pg';
import type { ProviderConfig } from '@yali/provider-core';
import type { AdminControlPlaneConfig } from '../admin/controlPlane.js';
import type { AdminConsoleCatalog } from '../admin/consoleCatalog.js';
import { notifyPostgresConfigChange } from './postgresConfigEvents.js';
import { ensureCnyMoneyPrecisionReady } from './moneyPrecisionMigration.js';
import type {
  AdminSessionRecord,
  AsyncCanvasUserRepository,
  AsyncCanvasUserSessionRepository,
  AsyncOperationalRepository,
  AsyncConsoleCatalogRepository,
  AsyncControlPlaneRepository,
  AsyncProviderRepository,
  AsyncSessionRepository,
  AuditLogRecord,
  BillingChargePersistenceBundle,
  BillingLedgerRecord,
  CanvasUserRecord,
  CanvasUserSessionRecord,
  BusinessOverviewData,
  ChannelPerformanceData,
  ImageGatewayPersistenceBundle,
  OperationalMetricRollupRecord,
  OperationalOutboxEventRecord,
  OperationalRollupJobRecord,
  RequestTraceRecord,
  TenantCreditBalanceRecord,
  TenantFinanceBalanceRecord,
  TenantFinanceLedgerRecord,
  TaskMasterRecord,
} from './repositoryContracts.js';

export type PostgresStorageOptions = {
  connectionString?: string;
  schema?: string;
  poolConfig?: PoolConfig;
};

const poolCache = new Map<string, Pool>();
const ensuredJsonbTables = new WeakMap<Pool, Map<string, Promise<void>>>();
const ensuredOperationalSchemas = new WeakMap<Pool, Map<string, Promise<void>>>();
type PgClient = {
  query: Pool['query'];
  release: () => void;
};
const postgresRetryableErrorCodes = new Set([
  '40001', // serialization_failure
  '40P01', // deadlock_detected
]);
const excludedBusinessTenantIds = [
  'admin-managed',
  'canvas-admin-managed',
  'user-supplied',
  'canvas-user-supplied',
] as const;
const operationalPruneBatchSize = Math.max(100, Math.min(50_000, Number(process.env.OPERATIONAL_PRUNE_BATCH_SIZE || 5_000)));
const operationalPruneMaxBatches = Math.max(1, Math.min(1_000, Number(process.env.OPERATIONAL_PRUNE_MAX_BATCHES || 20)));
const operationalMetricSnapshotMs = Math.max(5_000, Math.min(10 * 60_000, Number(process.env.OPERATIONAL_METRIC_SNAPSHOT_MS || 60_000)));
const rejectedFailureCategories = [
  'terminal_invalid_request',
  'terminal_user_content',
  'terminal_safety',
  'terminal_billing',
] as const;

function isRetryablePostgresError(error: unknown) {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && postgresRetryableErrorCodes.has(code);
}

async function withPostgresRetry<T>(operation: () => Promise<T>, attempts = 4): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!isRetryablePostgresError(error) || attempt >= attempts) {
        throw error;
      }
      await new Promise((resolve) => {
        const delayMs = Math.min(250, 25 * attempt * attempt) + Math.floor(Math.random() * 25);
        setTimeout(resolve, delayMs);
      });
    }
  }
  throw lastError;
}

async function rollbackQuietly(client: PgClient) {
  try {
    await client.query('rollback');
  } catch {
    // The original transaction error is more useful to callers.
  }
}

function resolvePoolCacheKey(options: PostgresStorageOptions = {}) {
  return JSON.stringify({
    connectionString: options.connectionString || process.env.DATABASE_URL || '',
    poolConfig: options.poolConfig || {},
  });
}

function resolveDefaultPoolMax() {
  const raw = Number(process.env.PG_POOL_MAX || 12);
  if (!Number.isFinite(raw) || raw <= 0) {
    return 12;
  }
  return Math.max(2, Math.min(50, Math.floor(raw)));
}

function runEnsured(
  cache: WeakMap<Pool, Map<string, Promise<void>>>,
  pool: Pool,
  key: string,
  factory: () => Promise<void>,
) {
  let poolEntries = cache.get(pool);
  if (!poolEntries) {
    poolEntries = new Map<string, Promise<void>>();
    cache.set(pool, poolEntries);
  }
  const existing = poolEntries.get(key);
  if (existing) {
    return existing;
  }
  const next = factory().catch((error) => {
    poolEntries?.delete(key);
    throw error;
  });
  poolEntries.set(key, next);
  return next;
}

function createPool(options: PostgresStorageOptions = {}) {
  const cacheKey = resolvePoolCacheKey(options);
  const existing = poolCache.get(cacheKey);
  if (existing) {
    return existing;
  }

  const connectionString = options.connectionString || process.env.DATABASE_URL || '';
  const pool = new Pool({
    connectionString: connectionString || undefined,
    max: resolveDefaultPoolMax(),
    ...options.poolConfig,
  });
  poolCache.set(cacheKey, pool);
  return pool;
}


function isUndefinedColumnError(error: unknown, columnName: string) {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const record = error as { code?: unknown; message?: unknown };
  if (String(record.code || '') !== '42703') {
    return false;
  }
  const message = String(record.message || '');
  return message.includes(`column "${columnName}" does not exist`);
}

async function ensureJsonbRecordTable(pool: Pool, schema: string, tableName: string) {
  await runEnsured(ensuredJsonbTables, pool, `${schema}.${tableName}`, async () => {
    await pool.query(`create schema if not exists ${schema}`);
    await pool.query(`
      create table if not exists ${schema}.${tableName} (
        id text primary key,
        payload jsonb not null,
        updated_at timestamptz not null default now()
      )
    `);
    await pool.query(`
      create index if not exists ${schema}_${tableName}_updated_at_idx
      on ${schema}.${tableName} (updated_at desc)
    `);
  });
}

async function syncJsonbRecordTable<T>(
  pool: Pool,
  schema: string,
  tableName: string,
  records: T[],
  mapRecord: (record: T) => { id: string; payload: string },
) {
  await ensureJsonbRecordTable(pool, schema, tableName);
  const client = await (pool as unknown as { connect: () => Promise<PgClient> }).connect();
  try {
    await client.query('begin');
    const recordIds: string[] = [];
    for (const record of records) {
      const mapped = mapRecord(record);
      recordIds.push(mapped.id);
      await client.query(
        `
          insert into ${schema}.${tableName} (id, payload, updated_at)
          values ($1, $2::jsonb, now())
          on conflict (id)
          do update set payload = excluded.payload, updated_at = now()
        `,
        [mapped.id, mapped.payload],
      );
    }
    if (recordIds.length) {
      await client.query(
        `delete from ${schema}.${tableName} where not (id = any($1::text[]))`,
        [recordIds],
      );
    } else {
      await client.query(`delete from ${schema}.${tableName}`);
    }
    await client.query('commit');
  } catch (error) {
    await rollbackQuietly(client);
    throw error;
  } finally {
    client.release();
  }
}

async function upsertJsonbRecordTable<T>(
  pool: Pool,
  schema: string,
  tableName: string,
  records: T[],
  mapRecord: (record: T) => { id: string; payload: string },
) {
  await ensureJsonbRecordTable(pool, schema, tableName);
  const client = await (pool as unknown as { connect: () => Promise<PgClient> }).connect();
  try {
    await client.query('begin');
    for (const record of records) {
      const mapped = mapRecord(record);
      await client.query(
        `
          insert into ${schema}.${tableName} (id, payload, updated_at)
          values ($1, $2::jsonb, now())
          on conflict (id)
          do update set payload = excluded.payload, updated_at = now()
        `,
        [mapped.id, mapped.payload],
      );
    }
    await client.query('commit');
  } catch (error) {
    await rollbackQuietly(client);
    throw error;
  } finally {
    client.release();
  }
}

async function deleteJsonbRecordTableIds(
  pool: Pool,
  schema: string,
  tableName: string,
  ids: string[],
) {
  await ensureJsonbRecordTable(pool, schema, tableName);
  if (!ids.length) {
    return;
  }
  await pool.query(
    `delete from ${schema}.${tableName} where id = any($1::text[])`,
    [ids],
  );
}

async function readSingletonJson<T>(pool: Pool, schema: string, tableName: string, id: string, fallback: () => T): Promise<T> {
  await ensureJsonbRecordTable(pool, schema, tableName);
  const result = await pool.query(`select payload from ${schema}.${tableName} where id = $1 limit 1`, [id]);
  if (!result.rowCount) {
    const seed = fallback();
    await writeSingletonJson(pool, schema, tableName, id, seed);
    return seed;
  }
  return result.rows[0].payload as T;
}

async function writeSingletonJson<T>(pool: Pool, schema: string, tableName: string, id: string, payload: T): Promise<T> {
  await ensureJsonbRecordTable(pool, schema, tableName);
  await pool.query(
    `
      insert into ${schema}.${tableName} (id, payload, updated_at)
      values ($1, $2::jsonb, now())
      on conflict (id)
      do update set payload = excluded.payload, updated_at = now()
    `,
    [id, JSON.stringify(payload)],
  );
  return payload;
}

async function mutateSingletonJson<T>(
  pool: Pool,
  schema: string,
  tableName: string,
  id: string,
  fallback: () => T,
  updater: (current: T) => T | Promise<T>,
): Promise<T> {
  await ensureJsonbRecordTable(pool, schema, tableName);
  const client = await (pool as unknown as { connect: () => Promise<PgClient> }).connect();
  try {
    await client.query('begin');
    await client.query(
      `
        insert into ${schema}.${tableName} (id, payload, updated_at)
        values ($1, $2::jsonb, now())
        on conflict (id) do nothing
      `,
      [id, JSON.stringify(fallback())],
    );
    const result = await client.query(
      `select payload from ${schema}.${tableName} where id = $1 for update`,
      [id],
    );
    const current = result.rows[0].payload as T;
    const next = await updater(current);
    await client.query(
      `
        insert into ${schema}.${tableName} (id, payload, updated_at)
        values ($1, $2::jsonb, now())
        on conflict (id)
        do update set payload = excluded.payload, updated_at = now()
      `,
      [id, JSON.stringify(next)],
    );
    await client.query('commit');
    return next;
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export function createPostgresControlPlaneRepository(
  options: PostgresStorageOptions & { fallback: () => AdminControlPlaneConfig },
): AsyncControlPlaneRepository {
  const pool = createPool(options);
  const schema = options.schema || 'public';
  return {
    async get() {
      return readSingletonJson(pool, schema, 'control_plane_config', 'control_plane', options.fallback);
    },
    async save(config: AdminControlPlaneConfig) {
      const next = await writeSingletonJson(pool, schema, 'control_plane_config', 'control_plane', config);
      void notifyPostgresConfigChange('control_plane', { schema });
      return next;
    },
  };
}

export function createPostgresConsoleCatalogRepository(
  options: PostgresStorageOptions & { fallback: () => AdminConsoleCatalog },
): AsyncConsoleCatalogRepository {
  const pool = createPool(options);
  const schema = options.schema || 'public';
  return {
    async get() {
      return readSingletonJson(pool, schema, 'console_catalog', 'catalog', options.fallback);
    },
    async replace(next: AdminConsoleCatalog) {
      const saved = await writeSingletonJson(pool, schema, 'console_catalog', 'catalog', next);
      void notifyPostgresConfigChange('console_catalog', { schema });
      return saved;
    },
    async mutate(updater: (current: AdminConsoleCatalog) => AdminConsoleCatalog | Promise<AdminConsoleCatalog>) {
      const saved = await mutateSingletonJson(
        pool,
        schema,
        'console_catalog',
        'catalog',
        options.fallback,
        updater,
      );
      void notifyPostgresConfigChange('console_catalog', { schema });
      return saved;
    },
  };
}

export function createPostgresProviderRepository(
  options: PostgresStorageOptions & { fallback: () => ProviderConfig[] },
): AsyncProviderRepository {
  const pool = createPool(options);
  const schema = options.schema || 'public';
  return {
    async list() {
      return readSingletonJson(pool, schema, 'provider_registry', 'providers', options.fallback);
    },
    async replaceAll(items: ProviderConfig[]) {
      const saved = await writeSingletonJson(pool, schema, 'provider_registry', 'providers', items);
      void notifyPostgresConfigChange('provider_registry', { schema });
      return saved;
    },
  };
}

export function createPostgresSessionRepository(
  options: PostgresStorageOptions,
): AsyncSessionRepository {
  const pool = createPool(options);
  const schema = options.schema || 'public';
  return {
    async list() {
      await ensureJsonbRecordTable(pool, schema, 'admin_sessions');
      const result = await pool.query(`select payload from ${schema}.admin_sessions order by updated_at desc`);
      return result.rows.map((row) => row.payload as AdminSessionRecord);
    },
    async saveAll(records: AdminSessionRecord[]) {
      await syncJsonbRecordTable(pool, schema, 'admin_sessions', records, (record) => ({
        id: record.token,
        payload: JSON.stringify(record),
      }));
      return records;
    },
  };
}

export function createPostgresCanvasUserRepository(
  options: PostgresStorageOptions,
): AsyncCanvasUserRepository {
  const pool = createPool(options);
  const schema = options.schema || 'public';
  return {
    async list() {
      await ensureJsonbRecordTable(pool, schema, 'canvas_users');
      const result = await pool.query(`select payload from ${schema}.canvas_users order by updated_at desc`);
      return result.rows.map((row) => row.payload as CanvasUserRecord);
    },
    async saveAll(records: CanvasUserRecord[]) {
      await syncJsonbRecordTable(pool, schema, 'canvas_users', records, (record) => ({
        id: record.id,
        payload: JSON.stringify(record),
      }));
      void notifyPostgresConfigChange('canvas_users', { schema, count: records.length });
      return records;
    },
    async upsertMany(records: CanvasUserRecord[]) {
      await upsertJsonbRecordTable(pool, schema, 'canvas_users', records, (record) => ({
        id: record.id,
        payload: JSON.stringify(record),
      }));
      void notifyPostgresConfigChange('canvas_users', { schema, count: records.length });
      return records;
    },
    async deleteByIds(ids: string[]) {
      await deleteJsonbRecordTableIds(pool, schema, 'canvas_users', ids);
      void notifyPostgresConfigChange('canvas_users', { schema, count: ids.length });
    },
  };
}

export function createPostgresCanvasUserSessionRepository(
  options: PostgresStorageOptions,
): AsyncCanvasUserSessionRepository {
  const pool = createPool(options);
  const schema = options.schema || 'public';
  return {
    async list() {
      await ensureJsonbRecordTable(pool, schema, 'canvas_user_sessions');
      const result = await pool.query(`select payload from ${schema}.canvas_user_sessions order by updated_at desc`);
      return result.rows.map((row) => row.payload as CanvasUserSessionRecord);
    },
    async saveAll(records: CanvasUserSessionRecord[]) {
      await syncJsonbRecordTable(pool, schema, 'canvas_user_sessions', records, (record) => ({
        id: record.token,
        payload: JSON.stringify(record),
      }));
      void notifyPostgresConfigChange('canvas_user_sessions', { schema, count: records.length });
      return records;
    },
    async upsertMany(records: CanvasUserSessionRecord[]) {
      await upsertJsonbRecordTable(pool, schema, 'canvas_user_sessions', records, (record) => ({
        id: record.token,
        payload: JSON.stringify(record),
      }));
      void notifyPostgresConfigChange('canvas_user_sessions', { schema, count: records.length });
      return records;
    },
    async deleteByIds(ids: string[]) {
      await deleteJsonbRecordTableIds(pool, schema, 'canvas_user_sessions', ids);
      void notifyPostgresConfigChange('canvas_user_sessions', { schema, count: ids.length });
    },
  };
}

async function ensureOperationalTables(pool: Pool, schema: string) {
  await runEnsured(ensuredOperationalSchemas, pool, schema, async () => {
    await pool.query(`create schema if not exists ${schema}`);
    await pool.query(`
      create table if not exists ${schema}.audit_logs (
        id text primary key,
        created_at bigint not null,
        actor_type text not null,
        actor_id text not null,
        action text not null,
        target_type text not null,
        target_id text not null,
        request_id text,
        status text not null,
        message text not null,
        detail jsonb not null default '{}'::jsonb
      )
    `);
    await pool.query(`
      create table if not exists ${schema}.request_traces (
        trace_id text primary key,
        created_at bigint not null,
        updated_at bigint not null,
        source text not null,
        scope text not null,
        status text not null,
        summary text not null,
        request_id text,
        task_id text,
        tenant_id text,
        api_key_id text,
        channel_id text,
        upstream_id text,
        upstream_name text,
        provider_base_url text,
        operation text,
        downstream_request jsonb,
        downstream_response jsonb,
        upstream_request jsonb,
        upstream_response jsonb,
        error_payload jsonb,
        failure_category text,
        status_code integer,
        tags jsonb
      )
    `);
    await pool.query(`
      create table if not exists ${schema}.billing_ledger (
        id text primary key,
        created_at bigint not null,
        updated_at bigint not null,
        tenant_id text not null,
        api_key_id text not null,
        channel_id text not null,
        upstream_id text,
        request_id text not null,
        task_id text,
        operation text not null,
        currency text not null,
        reserved_credits bigint not null,
        charged_credits bigint not null,
        status text not null,
        model text not null,
        size text,
        detail jsonb not null default '{}'::jsonb
      )
    `);
    await pool.query(`
      create table if not exists ${schema}.task_master (
        task_id text primary key,
        request_id text not null,
        tenant_id text not null,
        api_key_id text not null,
        channel_id text not null,
        upstream_id text,
        operation text not null,
        status text not null,
        provider_id text,
        model text not null,
        prompt_preview text not null,
        created_at bigint not null,
        updated_at bigint not null,
        completed_at bigint,
        request_payload jsonb not null default '{}'::jsonb,
        response_payload jsonb,
        error_payload jsonb,
        billed_credits bigint
      )
    `);
    await pool.query(`
      create table if not exists ${schema}.tenant_credit_balances (
        tenant_id text not null,
        currency text not null,
        total_charged_credits bigint not null default 0,
        total_voided_credits bigint not null default 0,
        total_reserved_credits bigint not null default 0,
        last_request_id text,
        last_task_id text,
        updated_at bigint not null,
        primary key (tenant_id, currency)
      )
    `);
    await pool.query(`
      create table if not exists ${schema}.tenant_finance_balances (
        tenant_id text not null,
        currency text not null,
        balance_cents bigint not null default 0,
        total_credited_cents bigint not null default 0,
        total_debited_cents bigint not null default 0,
        updated_at bigint not null,
        primary key (tenant_id, currency)
      )
    `);
    await pool.query(`
      create table if not exists ${schema}.tenant_finance_ledger (
        id text primary key,
        created_at bigint not null,
        updated_at bigint not null,
        tenant_id text not null,
        operator_id text not null,
        direction text not null,
        amount_cents bigint not null,
        balance_after_cents bigint not null,
        currency text not null,
        note text not null,
        detail jsonb not null default '{}'::jsonb
      )
    `);
    await pool.query(`
      create table if not exists ${schema}.routing_accuracy_snapshots (
        snapshot_key text primary key,
        generated_at bigint not null,
        expires_at bigint not null,
        payload jsonb not null default '{}'::jsonb,
        updated_at bigint not null
      )
    `);
    await pool.query(`
      create table if not exists ${schema}.operational_metric_snapshots (
        snapshot_key text primary key,
        generated_at bigint not null,
        expires_at bigint not null,
        payload jsonb not null default '{}'::jsonb,
        updated_at bigint not null
      )
    `);
    await pool.query(`
      create table if not exists ${schema}.operational_metric_rollups (
        rollup_key text primary key,
        metric_family text not null,
        bucket_start bigint not null,
        bucket_ms bigint not null,
        channel_id text,
        upstream_id text,
        tenant_id text,
        api_key_id text,
        operation text,
        tier text,
        quality text,
        failure_category text,
        source text not null,
        metrics jsonb not null default '{}'::jsonb,
        detail jsonb not null default '{}'::jsonb,
        generated_at bigint not null,
        updated_at bigint not null
      )
    `);
    await pool.query(`
      create table if not exists ${schema}.operational_rollup_jobs (
        job_key text primary key,
        locked_until bigint,
        locked_by text,
        last_success_at bigint,
        last_error text,
        updated_at bigint not null
      )
    `);
    await pool.query(`
      create table if not exists ${schema}.operational_outbox_events (
        event_id text primary key,
        event_type text not null,
        idempotency_key text not null unique,
        status text not null,
        payload jsonb not null default '{}'::jsonb,
        attempt_count integer not null default 0,
        available_at bigint not null,
        locked_until bigint,
        locked_by text,
        last_error text,
        created_at bigint not null,
        updated_at bigint not null,
        completed_at bigint
      )
    `);
    await pool.query(`alter table ${schema}.tenant_finance_ledger add column if not exists detail jsonb`);
    await pool.query(`alter table ${schema}.tenant_finance_ledger alter column detail set default '{}'::jsonb`);
    await pool.query(`alter table ${schema}.request_traces add column if not exists failure_category text`);
    await pool.query(`alter table ${schema}.request_traces add column if not exists status_code integer`);
    await pool.query(`alter table ${schema}.request_traces add column if not exists tags jsonb`);
    await pool.query(`alter table ${schema}.request_traces alter column tags set default '[]'::jsonb`);
    await pool.query(`create index if not exists ${schema}_audit_logs_created_at_idx on ${schema}.audit_logs (created_at desc)`);
    await pool.query(`create index if not exists ${schema}_request_traces_created_at_idx on ${schema}.request_traces (created_at desc)`);
    await pool.query(`create index if not exists ${schema}_request_traces_updated_at_idx on ${schema}.request_traces (updated_at)`);
    await pool.query(`create index if not exists ${schema}_request_traces_request_id_idx on ${schema}.request_traces (request_id)`);
    await pool.query(`create index if not exists ${schema}_request_traces_task_id_idx on ${schema}.request_traces (task_id)`);
    await pool.query(`create index if not exists ${schema}_request_traces_scope_created_idx on ${schema}.request_traces (scope, created_at desc)`);
    await pool.query(`create index if not exists ${schema}_request_traces_channel_upstream_created_idx on ${schema}.request_traces (channel_id, upstream_id, created_at desc)`);
    await pool.query(`create index if not exists ${schema}_request_traces_scope_channel_created_idx on ${schema}.request_traces (scope, channel_id, created_at desc, upstream_id)`);
    await pool.query(`create index if not exists ${schema}_billing_ledger_created_at_idx on ${schema}.billing_ledger (created_at desc)`);
    await pool.query(`create index if not exists ${schema}_billing_ledger_created_id_idx on ${schema}.billing_ledger (created_at desc, id desc)`);
    await pool.query(`create index if not exists ${schema}_billing_ledger_tenant_status_created_idx on ${schema}.billing_ledger (tenant_id, status, created_at desc)`);
    await pool.query(`create index if not exists ${schema}_billing_ledger_tenant_created_idx on ${schema}.billing_ledger (tenant_id, created_at desc)`);
    await pool.query(`create index if not exists ${schema}_billing_ledger_tenant_created_id_idx on ${schema}.billing_ledger (tenant_id, created_at desc, id desc)`);
    await pool.query(`create index if not exists ${schema}_billing_ledger_api_key_created_idx on ${schema}.billing_ledger (api_key_id, created_at desc)`);
    await pool.query(`create index if not exists ${schema}_billing_ledger_api_key_created_id_idx on ${schema}.billing_ledger (api_key_id, created_at desc, id desc)`);
    await pool.query(`create index if not exists ${schema}_billing_ledger_request_id_idx on ${schema}.billing_ledger (request_id)`);
    await pool.query(`create index if not exists ${schema}_billing_ledger_channel_upstream_created_idx on ${schema}.billing_ledger (channel_id, upstream_id, created_at desc)`);
    await pool.query(`create index if not exists ${schema}_billing_ledger_operation_created_idx on ${schema}.billing_ledger (operation, created_at desc)`);
    await pool.query(`create index if not exists ${schema}_billing_ledger_charged_created_channel_idx on ${schema}.billing_ledger (created_at desc, channel_id, upstream_id) where status = 'charged'`);
    await pool.query(`create index if not exists ${schema}_task_master_created_at_idx on ${schema}.task_master (created_at desc)`);
    await pool.query(`create index if not exists ${schema}_task_master_updated_at_idx on ${schema}.task_master (updated_at)`);
    await pool.query(`create index if not exists ${schema}_task_master_request_id_idx on ${schema}.task_master (request_id)`);
    await pool.query(`create index if not exists ${schema}_task_master_channel_upstream_created_idx on ${schema}.task_master (channel_id, upstream_id, created_at desc)`);
    await pool.query(`create index if not exists ${schema}_task_master_created_channel_upstream_idx on ${schema}.task_master (created_at desc, channel_id, upstream_id) where coalesce(request_payload ->> '_provider_source', '') <> 'user_supplied'`);
    await pool.query(`create index if not exists ${schema}_task_master_image_created_idx on ${schema}.task_master (created_at desc, status) where coalesce(channel_id, '') in ('image_generation', 'channel_image_generation') and coalesce(request_payload ->> '_provider_source', '') <> 'user_supplied'`);
    await pool.query(`create index if not exists ${schema}_tenant_finance_ledger_created_at_idx on ${schema}.tenant_finance_ledger (created_at desc)`);
    await pool.query(`create index if not exists ${schema}_tenant_finance_ledger_created_id_idx on ${schema}.tenant_finance_ledger (created_at desc, id desc)`);
    await pool.query(`create index if not exists ${schema}_tenant_finance_ledger_tenant_created_idx on ${schema}.tenant_finance_ledger (tenant_id, created_at desc)`);
    await pool.query(`create index if not exists ${schema}_tenant_finance_ledger_tenant_created_id_idx on ${schema}.tenant_finance_ledger (tenant_id, created_at desc, id desc)`);
    await pool.query(`create index if not exists ${schema}_tenant_finance_ledger_tenant_currency_created_idx on ${schema}.tenant_finance_ledger (tenant_id, currency, created_at desc)`);
    await pool.query(`drop index if exists ${schema}.${schema}_tenant_finance_ledger_tenant_currency_direction_created_`);
    await pool.query(`create index if not exists ${schema}_finance_ledger_tenant_currency_direction_created_idx on ${schema}.tenant_finance_ledger (tenant_id, currency, direction, created_at desc)`);
    await pool.query(`create index if not exists ${schema}_tenant_finance_balances_updated_at_idx on ${schema}.tenant_finance_balances (updated_at desc, tenant_id asc)`);
    await pool.query(`create index if not exists ${schema}_routing_accuracy_snapshots_expires_at_idx on ${schema}.routing_accuracy_snapshots (expires_at)`);
    await pool.query(`create index if not exists ${schema}_operational_metric_snapshots_expires_at_idx on ${schema}.operational_metric_snapshots (expires_at)`);
    await pool.query(`create index if not exists ${schema}_operational_metric_rollups_family_bucket_idx on ${schema}.operational_metric_rollups (metric_family, bucket_start desc)`);
    await pool.query(`create index if not exists ${schema}_operational_metric_rollups_channel_upstream_bucket_idx on ${schema}.operational_metric_rollups (metric_family, channel_id, upstream_id, bucket_start desc)`);
    await pool.query(`create index if not exists ${schema}_operational_metric_rollups_tenant_bucket_idx on ${schema}.operational_metric_rollups (metric_family, tenant_id, bucket_start desc)`);
    await pool.query(`create index if not exists ${schema}_operational_rollup_jobs_locked_until_idx on ${schema}.operational_rollup_jobs (locked_until)`);
    await pool.query(`create index if not exists ${schema}_operational_outbox_events_ready_idx on ${schema}.operational_outbox_events (event_type, status, available_at, locked_until)`);
    await pool.query(`create index if not exists ${schema}_operational_outbox_events_updated_idx on ${schema}.operational_outbox_events (updated_at desc)`);
    await ensureCnyMoneyPrecisionReady(pool, schema);
  });
}

function retentionCutoff(maxAgeMs: number) {
  return Date.now() - Math.max(0, Number(maxAgeMs || 0));
}

async function deleteExpiredRowsInBatches(
  pool: Pool,
  qualifiedTableName: string,
  timestampColumn: string,
  cutoff: number,
) {
  let deleted = 0;
  for (let batch = 0; batch < operationalPruneMaxBatches; batch += 1) {
    const result = await pool.query(
      `
        delete from ${qualifiedTableName}
        where ctid in (
          select ctid
          from ${qualifiedTableName}
          where ${timestampColumn} < $1
          limit $2
        )
      `,
      [cutoff, operationalPruneBatchSize],
    );
    const rowCount = result.rowCount || 0;
    deleted += rowCount;
    if (rowCount < operationalPruneBatchSize) {
      break;
    }
  }
  return deleted;
}

async function pruneOperationalWindow(pool: Pool, schema: string, maxAgeMs: number) {
  const cutoff = retentionCutoff(maxAgeMs);
  await deleteExpiredRowsInBatches(pool, `${schema}.audit_logs`, 'created_at', cutoff);
  await deleteExpiredRowsInBatches(pool, `${schema}.request_traces`, 'updated_at', cutoff);
  await deleteExpiredRowsInBatches(pool, `${schema}.billing_ledger`, 'created_at', cutoff);
  await deleteExpiredRowsInBatches(pool, `${schema}.task_master`, 'updated_at', cutoff);
}

async function pruneOperationalRetention(pool: Pool, schema: string, retention: {
  auditMs: number;
  traceMs: number;
  billingMs: number;
  taskMs: number;
}) {
  await deleteExpiredRowsInBatches(pool, `${schema}.audit_logs`, 'created_at', retentionCutoff(retention.auditMs));
  await deleteExpiredRowsInBatches(pool, `${schema}.request_traces`, 'updated_at', retentionCutoff(retention.traceMs));
  await deleteExpiredRowsInBatches(pool, `${schema}.billing_ledger`, 'created_at', retentionCutoff(retention.billingMs));
  await deleteExpiredRowsInBatches(pool, `${schema}.task_master`, 'updated_at', retentionCutoff(retention.taskMs));
  await deleteExpiredRowsInBatches(pool, `${schema}.operational_metric_snapshots`, 'expires_at', Date.now());
}

function metricSnapshotBucket(value: number) {
  return Math.floor(Number(value || 0) / operationalMetricSnapshotMs) * operationalMetricSnapshotMs;
}

function channelPerformanceSnapshotKey(fromInclusive: number, toExclusive: number) {
  return `channel_performance:${metricSnapshotBucket(fromInclusive)}:${metricSnapshotBucket(toExclusive)}`;
}

function normalizeChannelPerformanceSnapshot(value: ChannelPerformanceData): ChannelPerformanceData {
  return {
    ...value,
    billing: (value.billing || []).map((item) => {
      const legacy = item as typeof item & {
        imageCount?: unknown;
        unitCount?: unknown;
        operation?: unknown;
        upstreamUnitCostCredits?: unknown;
        upstreamUnitCostConfigured?: unknown;
      };
      const channelId = String(legacy.channelId || '');
      const operation = legacy.operation === 'edits' || legacy.operation === 'chat_completions'
        ? legacy.operation
        : channelId === 'channel_text_processing' || channelId === 'text_processing'
          ? 'chat_completions'
          : 'generations';
      return {
        ...item,
        operation,
        unitCount: Math.max(0, Number(legacy.unitCount ?? legacy.imageCount ?? 0)),
        upstreamUnitCostConfigured: legacy.upstreamUnitCostConfigured === undefined
          ? Math.max(0, Number(legacy.upstreamUnitCostCredits || 0)) > 0
          : Boolean(legacy.upstreamUnitCostConfigured),
        upstreamUnitCostCredits: Math.max(0, Number(legacy.upstreamUnitCostCredits || 0)),
      };
    }),
  };
}

function businessOverviewSnapshotKey(input: { oneHourAgo: number; oneDayAgo: number; toExclusive: number }) {
  return `business_overview:${metricSnapshotBucket(input.oneHourAgo)}:${metricSnapshotBucket(input.oneDayAgo)}:${metricSnapshotBucket(input.toExclusive)}`;
}

function mapOperationalMetricRollupRow(row: Record<string, unknown>): OperationalMetricRollupRecord {
  return {
    rollupKey: String(row.rollup_key || ''),
    metricFamily: String(row.metric_family || 'custom') as OperationalMetricRollupRecord['metricFamily'],
    bucketStart: Number(row.bucket_start || 0),
    bucketMs: Number(row.bucket_ms || 0),
    channelId: row.channel_id ? String(row.channel_id) : undefined,
    upstreamId: row.upstream_id ? String(row.upstream_id) : undefined,
    tenantId: row.tenant_id ? String(row.tenant_id) : undefined,
    apiKeyId: row.api_key_id ? String(row.api_key_id) : undefined,
    operation: row.operation ? String(row.operation) as OperationalMetricRollupRecord['operation'] : undefined,
    tier: row.tier ? String(row.tier) : undefined,
    quality: row.quality ? String(row.quality) : undefined,
    failureCategory: row.failure_category ? String(row.failure_category) : undefined,
    source: String(row.source || 'offline_backfill') as OperationalMetricRollupRecord['source'],
    metrics: row.metrics && typeof row.metrics === 'object' ? row.metrics as Record<string, number> : {},
    detail: row.detail && typeof row.detail === 'object' ? row.detail as Record<string, unknown> : {},
    generatedAt: Number(row.generated_at || 0),
    updatedAt: Number(row.updated_at || 0),
  };
}

function mapOperationalRollupJobRow(row: Record<string, unknown>): OperationalRollupJobRecord {
  return {
    jobKey: String(row.job_key || ''),
    lockedUntil: row.locked_until ? Number(row.locked_until) : undefined,
    lockedBy: row.locked_by ? String(row.locked_by) : undefined,
    lastSuccessAt: row.last_success_at ? Number(row.last_success_at) : undefined,
    lastError: row.last_error ? String(row.last_error) : undefined,
    updatedAt: Number(row.updated_at || 0),
  };
}

function mapOperationalOutboxEventRow(row: Record<string, unknown>): OperationalOutboxEventRecord {
  return {
    eventId: String(row.event_id || ''),
    eventType: String(row.event_type || 'image_gateway_persistence') as OperationalOutboxEventRecord['eventType'],
    idempotencyKey: String(row.idempotency_key || ''),
    status: String(row.status || 'pending') as OperationalOutboxEventRecord['status'],
    payload: row.payload && typeof row.payload === 'object' ? row.payload as Record<string, unknown> : {},
    attemptCount: Number(row.attempt_count || 0),
    availableAt: Number(row.available_at || 0),
    lockedUntil: row.locked_until ? Number(row.locked_until) : undefined,
    lockedBy: row.locked_by ? String(row.locked_by) : undefined,
    lastError: row.last_error ? String(row.last_error) : undefined,
    createdAt: Number(row.created_at || 0),
    updatedAt: Number(row.updated_at || 0),
    completedAt: row.completed_at ? Number(row.completed_at) : undefined,
  };
}

function mapTenantFinanceLedgerRow(row: Record<string, unknown>): TenantFinanceLedgerRecord {
  return {
    id: String(row.id || ''),
    createdAt: Number(row.created_at || 0),
    updatedAt: Number(row.updated_at || 0),
    tenantId: String(row.tenant_id || ''),
    operatorId: String(row.operator_id || ''),
    direction: String(row.direction || 'debit') as TenantFinanceLedgerRecord['direction'],
    amountCents: Number(row.amount_cents || 0),
    balanceAfterCents: Number(row.balance_after_cents || 0),
    currency: String(row.currency || 'cny') as TenantFinanceLedgerRecord['currency'],
    note: String(row.note || ''),
    detail: row.detail && typeof row.detail === 'object' ? row.detail as Record<string, unknown> : {},
  };
}

async function readOperationalMetricSnapshot<T>(
  pool: Pool,
  schema: string,
  snapshotKey: string,
): Promise<T | null> {
  const result = await pool.query(
    `select payload, expires_at from ${schema}.operational_metric_snapshots where snapshot_key = $1 limit 1`,
    [snapshotKey],
  );
  const row = result.rows[0];
  if (!row || Number(row.expires_at || 0) <= Date.now()) {
    return null;
  }
  return row.payload as T;
}

async function writeOperationalMetricSnapshot(
  pool: Pool,
  schema: string,
  snapshotKey: string,
  payload: Record<string, unknown>,
) {
  const now = Date.now();
  await pool.query(
    `
      insert into ${schema}.operational_metric_snapshots (
        snapshot_key, generated_at, expires_at, payload, updated_at
      ) values ($1,$2,$3,$4::jsonb,$5)
      on conflict (snapshot_key) do update set
        generated_at = excluded.generated_at,
        expires_at = excluded.expires_at,
        payload = excluded.payload,
        updated_at = excluded.updated_at
    `,
    [
      snapshotKey,
      now,
      now + operationalMetricSnapshotMs,
      JSON.stringify(payload),
      now,
    ],
  );
}

export function createPostgresOperationalRepository(
  options: PostgresStorageOptions,
): AsyncOperationalRepository {
  const pool = createPool(options);
  const schema = options.schema || 'public';
  return {
    async pruneOperationalWindow(maxAgeMs: number) {
      await ensureOperationalTables(pool, schema);
      await pruneOperationalWindow(pool, schema, maxAgeMs);
    },
    async pruneOperationalRetention(retention) {
      await ensureOperationalTables(pool, schema);
      await pruneOperationalRetention(pool, schema, retention);
    },
    async appendAudit(record: AuditLogRecord) {
      await ensureOperationalTables(pool, schema);
      await pool.query(
        `
          insert into ${schema}.audit_logs (
            id, created_at, actor_type, actor_id, action, target_type, target_id,
            request_id, status, message, detail
          ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)
        `,
        [
          record.id,
          record.createdAt,
          record.actorType,
          record.actorId,
          record.action,
          record.targetType,
          record.targetId,
          record.requestId || null,
          record.status,
          record.message,
          JSON.stringify(record.detail || {}),
        ],
      );
      return record;
    },
    async listAudit(limit: number) {
      await ensureOperationalTables(pool, schema);
      const result = await pool.query(
        `select * from ${schema}.audit_logs order by created_at desc limit $1`,
        [limit],
      );
      return result.rows.map((row) => ({
        id: row.id,
        createdAt: Number(row.created_at),
        actorType: row.actor_type,
        actorId: row.actor_id,
        action: row.action,
        targetType: row.target_type,
        targetId: row.target_id,
        requestId: row.request_id || undefined,
        status: row.status,
        message: row.message,
        detail: row.detail || {},
      } satisfies AuditLogRecord));
    },
    async appendTrace(record: RequestTraceRecord) {
      await ensureOperationalTables(pool, schema);
      await pool.query(
        `
          insert into ${schema}.request_traces (
            trace_id, created_at, updated_at, source, scope, status, summary,
          request_id, task_id, tenant_id, api_key_id, channel_id, upstream_id,
          upstream_name, provider_base_url, operation,
          downstream_request, downstream_response, upstream_request, upstream_response,
          error_payload, failure_category, status_code, tags
          ) values (
            $1,$2,$3,$4,$5,$6,$7,
            $8,$9,$10,$11,$12,$13,
            $14,$15,$16,
            $17::jsonb,$18::jsonb,$19::jsonb,$20::jsonb,
            $21::jsonb,$22,$23,$24::jsonb
          )
        `,
        [
          record.traceId,
          record.createdAt,
          record.updatedAt,
          record.source,
          record.scope,
          record.status,
          record.summary,
          record.requestId || null,
          record.taskId || null,
          record.tenantId || null,
          record.apiKeyId || null,
          record.channelId || null,
          record.upstreamId || null,
          record.upstreamName || null,
          record.providerBaseUrl || null,
          record.operation || null,
          JSON.stringify(record.downstreamRequest || null),
          JSON.stringify(record.downstreamResponse || null),
          JSON.stringify(record.upstreamRequest || null),
          JSON.stringify(record.upstreamResponse || null),
          JSON.stringify(record.errorPayload || null),
          record.failureCategory || null,
          record.statusCode || null,
          JSON.stringify(record.tags || []),
        ],
      );
      return record;
    },
    async updateTrace(traceId: string, patch: Partial<RequestTraceRecord>) {
      await ensureOperationalTables(pool, schema);
      const current = await pool.query(`select * from ${schema}.request_traces where trace_id = $1 limit 1`, [traceId]);
      if (!current.rowCount) {
        return null;
      }
      const row = current.rows[0];
      const next: RequestTraceRecord = {
        traceId: row.trace_id,
        createdAt: Number(row.created_at),
        updatedAt: Number(patch.updatedAt || Date.now()),
        source: patch.source ?? row.source,
        scope: patch.scope ?? row.scope,
        status: patch.status ?? row.status,
        summary: patch.summary ?? row.summary,
        requestId: patch.requestId ?? row.request_id ?? undefined,
        taskId: patch.taskId ?? row.task_id ?? undefined,
        tenantId: patch.tenantId ?? row.tenant_id ?? undefined,
        apiKeyId: patch.apiKeyId ?? row.api_key_id ?? undefined,
        channelId: patch.channelId ?? row.channel_id ?? undefined,
        upstreamId: patch.upstreamId ?? row.upstream_id ?? undefined,
        upstreamName: patch.upstreamName ?? row.upstream_name ?? undefined,
        providerBaseUrl: patch.providerBaseUrl ?? row.provider_base_url ?? undefined,
        operation: patch.operation ?? row.operation ?? undefined,
        downstreamRequest: patch.downstreamRequest ?? row.downstream_request ?? null,
        downstreamResponse: patch.downstreamResponse ?? row.downstream_response ?? null,
        upstreamRequest: patch.upstreamRequest ?? row.upstream_request ?? null,
        upstreamResponse: patch.upstreamResponse ?? row.upstream_response ?? null,
        errorPayload: patch.errorPayload ?? row.error_payload ?? null,
        failureCategory: patch.failureCategory ?? row.failure_category ?? undefined,
        statusCode: patch.statusCode ?? row.status_code ?? undefined,
        tags: patch.tags ?? row.tags ?? [],
      };
      await pool.query(
        `
          update ${schema}.request_traces
          set updated_at = $2, source = $3, scope = $4, status = $5, summary = $6,
              request_id = $7, task_id = $8, tenant_id = $9, api_key_id = $10, channel_id = $11,
              upstream_id = $12, upstream_name = $13, provider_base_url = $14, operation = $15,
              downstream_request = $16::jsonb, downstream_response = $17::jsonb,
              upstream_request = $18::jsonb, upstream_response = $19::jsonb,
              error_payload = $20::jsonb, failure_category = $21, status_code = $22, tags = $23::jsonb
          where trace_id = $1
        `,
        [
          traceId,
          next.updatedAt,
          next.source,
          next.scope,
          next.status,
          next.summary,
          next.requestId || null,
          next.taskId || null,
          next.tenantId || null,
          next.apiKeyId || null,
          next.channelId || null,
          next.upstreamId || null,
          next.upstreamName || null,
          next.providerBaseUrl || null,
          next.operation || null,
          JSON.stringify(next.downstreamRequest || null),
          JSON.stringify(next.downstreamResponse || null),
          JSON.stringify(next.upstreamRequest || null),
          JSON.stringify(next.upstreamResponse || null),
          JSON.stringify(next.errorPayload || null),
          next.failureCategory || null,
          next.statusCode || null,
          JSON.stringify(next.tags || []),
        ],
      );
      return next;
    },
    async listTraces(limit: number) {
      await ensureOperationalTables(pool, schema);
      let result;
      try {
        result = await pool.query(
          `
            select
              trace_id, created_at, updated_at, source, scope, status, summary,
              request_id, task_id, tenant_id, api_key_id, channel_id, upstream_id,
              upstream_name, provider_base_url, operation, failure_category, status_code, tags
            from ${schema}.request_traces
            order by created_at desc
            limit $1
          `,
          [limit],
        );
      } catch (error) {
        if (!isUndefinedColumnError(error, 'failure_category')) {
          throw error;
        }
        result = await pool.query(
          `
            select
              trace_id, created_at, updated_at, source, scope, status, summary,
              request_id, task_id, tenant_id, api_key_id, channel_id, upstream_id,
              upstream_name, provider_base_url, operation
            from ${schema}.request_traces
            order by created_at desc
            limit $1
          `,
          [limit],
        );
      }
      return result.rows.map((row) => ({
        traceId: row.trace_id,
        createdAt: Number(row.created_at),
        updatedAt: Number(row.updated_at),
        source: row.source,
        scope: row.scope,
        status: row.status,
        summary: row.summary,
        requestId: row.request_id ?? undefined,
        taskId: row.task_id ?? undefined,
        tenantId: row.tenant_id ?? undefined,
        apiKeyId: row.api_key_id ?? undefined,
        channelId: row.channel_id ?? undefined,
        upstreamId: row.upstream_id ?? undefined,
        upstreamName: row.upstream_name ?? undefined,
        providerBaseUrl: row.provider_base_url ?? undefined,
        operation: row.operation ?? undefined,
        downstreamRequest: null,
        downstreamResponse: null,
        upstreamRequest: null,
        upstreamResponse: null,
        errorPayload: null,
        failureCategory: row.failure_category ?? undefined,
        statusCode: row.status_code ?? undefined,
        tags: row.tags || [],
      } satisfies RequestTraceRecord));
    },
    async clearTraces() {
      await ensureOperationalTables(pool, schema);
      const countResult = await pool.query(`select count(*)::bigint as total from ${schema}.request_traces`);
      const deletedCount = Number(countResult.rows[0]?.total || 0);
      await pool.query(`delete from ${schema}.request_traces`);
      return { deletedCount };
    },
    async getTrace(traceId: string) {
      await ensureOperationalTables(pool, schema);
      const result = await pool.query(
        `select * from ${schema}.request_traces where trace_id = $1 limit 1`,
        [traceId],
      );
      if (!result.rowCount) {
        return null;
      }
      const row = result.rows[0];
      return {
        traceId: row.trace_id,
        createdAt: Number(row.created_at),
        updatedAt: Number(row.updated_at),
        source: row.source,
        scope: row.scope,
        status: row.status,
        summary: row.summary,
        requestId: row.request_id ?? undefined,
        taskId: row.task_id ?? undefined,
        tenantId: row.tenant_id ?? undefined,
        apiKeyId: row.api_key_id ?? undefined,
        channelId: row.channel_id ?? undefined,
        upstreamId: row.upstream_id ?? undefined,
        upstreamName: row.upstream_name ?? undefined,
        providerBaseUrl: row.provider_base_url ?? undefined,
        operation: row.operation ?? undefined,
        downstreamRequest: row.downstream_request || null,
        downstreamResponse: row.downstream_response || null,
        upstreamRequest: row.upstream_request || null,
        upstreamResponse: row.upstream_response || null,
        errorPayload: row.error_payload || null,
        failureCategory: row.failure_category || undefined,
        statusCode: row.status_code || undefined,
        tags: row.tags || [],
      } satisfies RequestTraceRecord;
    },
    async createBillingLedger(record: BillingLedgerRecord) {
      await ensureOperationalTables(pool, schema);
      await pool.query(
        `
          insert into ${schema}.billing_ledger (
            id, created_at, updated_at, tenant_id, api_key_id, channel_id, upstream_id,
            request_id, task_id, operation, currency, reserved_credits, charged_credits,
            status, model, size, detail
          ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb)
        `,
        [
          record.id,
          record.createdAt,
          record.updatedAt,
          record.tenantId,
          record.apiKeyId,
          record.channelId,
          record.upstreamId || null,
          record.requestId,
          record.taskId || null,
          record.operation,
          record.currency,
          record.reservedCredits,
          record.chargedCredits,
          record.status,
          record.model,
          record.size || null,
          JSON.stringify(record.detail || {}),
        ],
      );
      return record;
    },
    async updateBillingLedger(id: string, patch: Partial<BillingLedgerRecord>) {
      await ensureOperationalTables(pool, schema);
      const current = await pool.query(`select * from ${schema}.billing_ledger where id = $1 limit 1`, [id]);
      if (!current.rowCount) {
        return null;
      }
      const row = current.rows[0];
      const next: BillingLedgerRecord = {
        id: row.id,
        createdAt: Number(row.created_at),
        updatedAt: Number(patch.updatedAt || Date.now()),
        tenantId: row.tenant_id,
        apiKeyId: row.api_key_id,
        channelId: row.channel_id,
        upstreamId: patch.upstreamId ?? row.upstream_id ?? undefined,
        requestId: row.request_id,
        taskId: patch.taskId ?? row.task_id ?? undefined,
        operation: patch.operation ?? row.operation,
        currency: patch.currency ?? row.currency,
        reservedCredits: patch.reservedCredits ?? Number(row.reserved_credits),
        chargedCredits: patch.chargedCredits ?? Number(row.charged_credits),
        status: patch.status ?? row.status,
        model: patch.model ?? row.model,
        size: patch.size ?? row.size ?? undefined,
        detail: patch.detail ?? row.detail ?? {},
      };
      await pool.query(
        `
          update ${schema}.billing_ledger
          set updated_at = $2, upstream_id = $3, task_id = $4, operation = $5, currency = $6,
              reserved_credits = $7, charged_credits = $8, status = $9, model = $10, size = $11, detail = $12::jsonb
          where id = $1
        `,
        [
          id,
          next.updatedAt,
          next.upstreamId || null,
          next.taskId || null,
          next.operation,
          next.currency,
          next.reservedCredits,
          next.chargedCredits,
          next.status,
          next.model,
          next.size || null,
          JSON.stringify(next.detail || {}),
        ],
      );
      return next;
    },
    async listBillingLedger(input) {
      await ensureOperationalTables(pool, schema);
      const operations = Array.from(new Set((input.operations || []).filter((operation) => (
        operation === 'generations' || operation === 'edits' || operation === 'chat_completions'
      ))));
      const conditions: string[] = [];
      const params: Array<number | string | string[]> = [];
      if (operations.length) {
        params.push(operations);
        conditions.push(`operation = any($${params.length}::text[])`);
      }
      if (input.tenantId) {
        params.push(input.tenantId);
        conditions.push(`tenant_id = $${params.length}`);
      }
      if (input.apiKeyId) {
        params.push(input.apiKeyId);
        conditions.push(`api_key_id = $${params.length}`);
      }
      if (Number.isFinite(input.createdAfter) && Number(input.createdAfter) > 0) {
        params.push(Number(input.createdAfter));
        conditions.push(`created_at >= $${params.length}`);
      }
      if (Number.isFinite(input.createdBefore) && Number(input.createdBefore) > 0) {
        params.push(Number(input.createdBefore));
        conditions.push(`created_at < $${params.length}`);
      }
      params.push(input.limit);
      const where = conditions.length ? `where ${conditions.join(' and ')}` : '';
      const limitParameter = `$${params.length}`;
      const result = await pool.query(
        `select * from ${schema}.billing_ledger ${where} order by created_at desc limit ${limitParameter}`,
        params,
      );
      return result.rows.map((row) => ({
        id: row.id,
        createdAt: Number(row.created_at),
        updatedAt: Number(row.updated_at),
        tenantId: row.tenant_id,
        apiKeyId: row.api_key_id,
        channelId: row.channel_id,
        upstreamId: row.upstream_id ?? undefined,
        requestId: row.request_id,
        taskId: row.task_id ?? undefined,
        operation: row.operation,
        currency: row.currency,
        reservedCredits: Number(row.reserved_credits),
        chargedCredits: Number(row.charged_credits),
        status: row.status,
        model: row.model,
        size: row.size ?? undefined,
        detail: row.detail || {},
      } satisfies BillingLedgerRecord));
    },
    async listBillingLedgerPage(input) {
      await ensureOperationalTables(pool, schema);
      const operations = Array.from(new Set((input.operations || []).filter((operation) => (
        operation === 'generations' || operation === 'edits' || operation === 'chat_completions'
      ))));
      const conditions: string[] = [];
      const params: Array<number | string | string[]> = [];
      if (operations.length) {
        params.push(operations);
        conditions.push(`operation = any($${params.length}::text[])`);
      }
      if (input.tenantId) {
        params.push(input.tenantId);
        conditions.push(`tenant_id = $${params.length}`);
      }
      if (input.apiKeyId) {
        params.push(input.apiKeyId);
        conditions.push(`api_key_id = $${params.length}`);
      }
      if (Number.isFinite(input.createdAfter) && Number(input.createdAfter) > 0) {
        params.push(Number(input.createdAfter));
        conditions.push(`created_at >= $${params.length}`);
      }
      if (Number.isFinite(input.createdBefore) && Number(input.createdBefore) > 0) {
        params.push(Number(input.createdBefore));
        conditions.push(`created_at < $${params.length}`);
      }
      if (input.cursor) {
        params.push(input.cursor.createdAt, input.cursor.id);
        conditions.push(`(created_at < $${params.length - 1} or (created_at = $${params.length - 1} and id < $${params.length}))`);
      }
      const limit = Math.max(1, Math.min(500, Number(input.limit || 100)));
      params.push(limit + 1);
      const where = conditions.length ? `where ${conditions.join(' and ')}` : '';
      const result = await pool.query(
        `select * from ${schema}.billing_ledger ${where} order by created_at desc, id desc limit $${params.length}`,
        params,
      );
      const pageRows = result.rows.slice(0, limit).map((row) => ({
        id: row.id,
        createdAt: Number(row.created_at),
        updatedAt: Number(row.updated_at),
        tenantId: row.tenant_id,
        apiKeyId: row.api_key_id,
        channelId: row.channel_id,
        upstreamId: row.upstream_id ?? undefined,
        requestId: row.request_id,
        taskId: row.task_id ?? undefined,
        operation: row.operation,
        currency: row.currency,
        reservedCredits: Number(row.reserved_credits),
        chargedCredits: Number(row.charged_credits),
        status: row.status,
        model: row.model,
        size: row.size ?? undefined,
        detail: row.detail || {},
      } satisfies BillingLedgerRecord));
      const last = pageRows[pageRows.length - 1];
      return {
        rows: pageRows,
        hasMore: result.rows.length > limit,
        nextCursor: result.rows.length > limit && last ? { createdAt: last.createdAt, id: last.id } : undefined,
      };
    },
    async purgeTenantData(tenantId: string) {
      await ensureOperationalTables(pool, schema);
      // Financial balances and their immutable ledger are intentionally excluded.
      const [traceResult, billingResult, taskResult, creditBalanceResult] = await Promise.all([
        pool.query(`delete from ${schema}.request_traces where tenant_id = $1`, [tenantId]),
        pool.query(`delete from ${schema}.billing_ledger where tenant_id = $1`, [tenantId]),
        pool.query(`delete from ${schema}.task_master where tenant_id = $1`, [tenantId]),
        pool.query(`delete from ${schema}.tenant_credit_balances where tenant_id = $1`, [tenantId]),
      ]);
      return {
        traces: traceResult.rowCount || 0,
        billing: billingResult.rowCount || 0,
        tasks: taskResult.rowCount || 0,
        creditBalances: creditBalanceResult.rowCount || 0,
        financeLedger: 0,
        financeBalances: 0,
      };
    },
    async sumChargedCreditsForTenant(tenantId: string, fromInclusive: number, toExclusive: number) {
      await ensureOperationalTables(pool, schema);
      const result = await pool.query(
        `
          select coalesce(sum(charged_credits), 0) as total
          from ${schema}.billing_ledger
          where tenant_id = $1
            and status in ('reserved', 'charged')
            and created_at >= $2
            and created_at < $3
        `,
        [tenantId, fromInclusive, toExclusive],
      );
      return Number(result.rows[0]?.total || 0);
    },
    async adjustTenantCreditBalance(input) {
      await ensureOperationalTables(pool, schema);
      const updatedAt = Date.now();
      const result = await withPostgresRetry(() => pool.query(
        `
            insert into ${schema}.tenant_credit_balances (
              tenant_id, currency, total_charged_credits, total_voided_credits, total_reserved_credits,
              last_request_id, last_task_id, updated_at
            ) values ($1,$2,$3,$4,$5,$6,$7,$8)
            on conflict (tenant_id, currency) do update set
              total_charged_credits = ${schema}.tenant_credit_balances.total_charged_credits + excluded.total_charged_credits,
              total_voided_credits = ${schema}.tenant_credit_balances.total_voided_credits + excluded.total_voided_credits,
              total_reserved_credits = ${schema}.tenant_credit_balances.total_reserved_credits + excluded.total_reserved_credits,
              last_request_id = coalesce(excluded.last_request_id, ${schema}.tenant_credit_balances.last_request_id),
              last_task_id = coalesce(excluded.last_task_id, ${schema}.tenant_credit_balances.last_task_id),
              updated_at = excluded.updated_at
            returning *
          `,
        [
            input.tenantId,
            input.currency,
            Number(input.chargedDelta || 0),
            Number(input.voidedDelta || 0),
            Number(input.reservedDelta || 0),
            input.requestId || null,
            input.taskId || null,
            updatedAt,
          ],
      ),
      );
      const row = result.rows[0];
      return {
        tenantId: row.tenant_id,
        currency: row.currency,
        totalChargedCredits: Number(row.total_charged_credits || 0),
        totalVoidedCredits: Number(row.total_voided_credits || 0),
        totalReservedCredits: Number(row.total_reserved_credits || 0),
        lastRequestId: row.last_request_id ?? undefined,
        lastTaskId: row.last_task_id ?? undefined,
        updatedAt: Number(row.updated_at || updatedAt),
      } satisfies TenantCreditBalanceRecord;
    },
    async getTenantCreditBalance(tenantId: string, currency: 'cny') {
      await ensureOperationalTables(pool, schema);
      const result = await pool.query(
        `select * from ${schema}.tenant_credit_balances where tenant_id = $1 and currency = $2 limit $3`,
        [tenantId, currency, 1],
      );
      if (!result.rowCount) {
        return null;
      }
      const row = result.rows[0];
      return {
        tenantId: row.tenant_id,
        currency: row.currency,
        totalChargedCredits: Number(row.total_charged_credits || 0),
        totalVoidedCredits: Number(row.total_voided_credits || 0),
        totalReservedCredits: Number(row.total_reserved_credits || 0),
        lastRequestId: row.last_request_id ?? undefined,
        lastTaskId: row.last_task_id ?? undefined,
        updatedAt: Number(row.updated_at || 0),
      } satisfies TenantCreditBalanceRecord;
    },
    async createTenantFinanceLedger(input) {
      await ensureOperationalTables(pool, schema);
      const now = Date.now();
      const amountCents = Number(input.amountCents || 0);
      const direction = input.direction;
      const delta = direction === 'credit' ? amountCents : -amountCents;
      const stableId = String(input.idempotencyKey || '').trim();
      return withPostgresRetry(async () => {
        const client = await (pool as unknown as { connect: () => Promise<PgClient> }).connect();
        try {
          await client.query('begin');
          if (stableId) {
            const existing = await client.query(
              `select * from ${schema}.tenant_finance_ledger where id = $1 limit 1 for update`,
              [stableId],
            );
            if (existing.rowCount) {
              await client.query('commit');
              return mapTenantFinanceLedgerRow(existing.rows[0]);
            }
          }
          const balanceResult = await client.query(
            `
              insert into ${schema}.tenant_finance_balances (
                tenant_id, currency, balance_cents, total_credited_cents, total_debited_cents, updated_at
              ) values ($1,$2,$3,$4,$5,$6)
              on conflict (tenant_id, currency) do update set
                balance_cents = ${schema}.tenant_finance_balances.balance_cents + excluded.balance_cents,
                total_credited_cents = ${schema}.tenant_finance_balances.total_credited_cents + excluded.total_credited_cents,
                total_debited_cents = ${schema}.tenant_finance_balances.total_debited_cents + excluded.total_debited_cents,
                updated_at = excluded.updated_at
              returning *
            `,
            [
              input.tenantId,
              input.currency,
              delta,
              direction === 'credit' ? amountCents : 0,
              direction === 'debit' ? amountCents : 0,
              now,
            ],
          );
          const balance = balanceResult.rows[0];
          const nextBalanceCents = Number(balance.balance_cents || 0);
          const record: TenantFinanceLedgerRecord = {
            id: stableId || `tenant_finance_${Math.random().toString(36).slice(2, 10)}_${Date.now().toString(36)}`,
            createdAt: now,
            updatedAt: now,
            tenantId: input.tenantId,
            operatorId: input.operatorId,
            direction,
            amountCents,
            balanceAfterCents: nextBalanceCents,
            currency: input.currency,
            note: input.note,
            detail: input.detail && typeof input.detail === 'object' ? input.detail : {},
          };
          await client.query(
            `
              insert into ${schema}.tenant_finance_ledger (
                id, created_at, updated_at, tenant_id, operator_id, direction, amount_cents, balance_after_cents, currency, note, detail
              ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)
            `,
            [
              record.id,
              record.createdAt,
              record.updatedAt,
              record.tenantId,
              record.operatorId,
              record.direction,
              record.amountCents,
              record.balanceAfterCents,
              record.currency,
              record.note,
              JSON.stringify(record.detail || {}),
            ],
          );
          await client.query('commit');
          return record;
        } catch (error) {
          await rollbackQuietly(client);
          throw error;
        } finally {
          client.release();
        }
      });
    },
    async listTenantFinanceLedger(limit: number) {
      await ensureOperationalTables(pool, schema);
      const result = await pool.query(
        `select * from ${schema}.tenant_finance_ledger order by created_at desc limit $1`,
        [limit],
      );
      return result.rows.map((row) => ({
        id: row.id,
        createdAt: Number(row.created_at),
        updatedAt: Number(row.updated_at),
        tenantId: row.tenant_id,
        operatorId: row.operator_id,
        direction: row.direction,
        amountCents: Number(row.amount_cents),
        balanceAfterCents: Number(row.balance_after_cents),
        currency: row.currency,
        note: row.note,
        detail: row.detail || {},
      } satisfies TenantFinanceLedgerRecord));
    },
    async listTenantFinanceLedgerPage(input) {
      await ensureOperationalTables(pool, schema);
      const conditions: string[] = [];
      const params: Array<number | string> = [];
      if (input.tenantId) {
        params.push(input.tenantId);
        conditions.push(`tenant_id = $${params.length}`);
      }
      if (input.direction) {
        params.push(input.direction);
        conditions.push(`direction = $${params.length}`);
      }
      if (Number.isFinite(input.createdAfter) && Number(input.createdAfter) > 0) {
        params.push(Number(input.createdAfter));
        conditions.push(`created_at >= $${params.length}`);
      }
      if (Number.isFinite(input.createdBefore) && Number(input.createdBefore) > 0) {
        params.push(Number(input.createdBefore));
        conditions.push(`created_at < $${params.length}`);
      }
      const requestChargePredicate = "direction = 'debit' and (operator_id like 'system:%' or coalesce(detail ->> 'source', '') like '%_request_charge')";
      if (input.entryType === 'tenant_request_charge') {
        conditions.push(`(${requestChargePredicate})`);
      } else if (input.entryType === 'account_adjustment') {
        conditions.push(`not (${requestChargePredicate})`);
      }
      if (input.cursor) {
        params.push(input.cursor.createdAt, input.cursor.id);
        conditions.push(`(created_at < $${params.length - 1} or (created_at = $${params.length - 1} and id < $${params.length}))`);
      }
      const limit = Math.max(1, Math.min(500, Number(input.limit || 100)));
      params.push(limit + 1);
      const where = conditions.length ? `where ${conditions.join(' and ')}` : '';
      const result = await pool.query(
        `select * from ${schema}.tenant_finance_ledger ${where} order by created_at desc, id desc limit $${params.length}`,
        params,
      );
      const pageRows = result.rows.slice(0, limit).map(mapTenantFinanceLedgerRow);
      const last = pageRows[pageRows.length - 1];
      return {
        rows: pageRows,
        hasMore: result.rows.length > limit,
        nextCursor: result.rows.length > limit && last ? { createdAt: last.createdAt, id: last.id } : undefined,
      };
    },
    async listTenantFinanceLedgerByTenant(input) {
      await ensureOperationalTables(pool, schema);
      const params: Array<string | number> = [input.tenantId, input.currency];
      const where = ['tenant_id = $1', 'currency = $2'];
      if (Number(input.createdAfter || 0) > 0) {
        params.push(Number(input.createdAfter));
        where.push(`created_at >= $${params.length}`);
      }
      params.push(Math.max(1, Number(input.limit || 20)));
      const limitIndex = params.length;
      params.push(Math.max(0, Number(input.offset || 0)));
      const offsetIndex = params.length;
      const result = await pool.query(
        `select * from ${schema}.tenant_finance_ledger where ${where.join(' and ')} order by created_at desc limit $${limitIndex} offset $${offsetIndex}`,
        params,
      );
      return result.rows.map((row) => ({
        id: row.id,
        createdAt: Number(row.created_at),
        updatedAt: Number(row.updated_at),
        tenantId: row.tenant_id,
        operatorId: row.operator_id,
        direction: row.direction,
        amountCents: Number(row.amount_cents),
        balanceAfterCents: Number(row.balance_after_cents),
        currency: row.currency,
        note: row.note,
        detail: row.detail || {},
      } satisfies TenantFinanceLedgerRecord));
    },
    async countTenantFinanceLedgerByTenant(input) {
      await ensureOperationalTables(pool, schema);
      const params: Array<string | number> = [input.tenantId, input.currency];
      const where = ['tenant_id = $1', 'currency = $2'];
      if (Number(input.createdAfter || 0) > 0) {
        params.push(Number(input.createdAfter));
        where.push(`created_at >= $${params.length}`);
      }
      const result = await pool.query(
        `select count(*)::bigint as total from ${schema}.tenant_finance_ledger where ${where.join(' and ')}`,
        params,
      );
      return Number(result.rows[0]?.total || 0);
    },
    async sumTenantFinanceLedgerByTenant(input) {
      await ensureOperationalTables(pool, schema);
      const params: Array<string | number> = [input.tenantId, input.currency];
      const where = ['tenant_id = $1', 'currency = $2'];
      if (input.direction) {
        params.push(input.direction);
        where.push(`direction = $${params.length}`);
      }
      if (Number(input.createdAfter || 0) > 0) {
        params.push(Number(input.createdAfter));
        where.push(`created_at >= $${params.length}`);
      }
      if (Number(input.createdBefore || 0) > 0) {
        params.push(Number(input.createdBefore));
        where.push(`created_at < $${params.length}`);
      }
      const result = await pool.query(
        `select coalesce(sum(amount_cents), 0)::bigint as total from ${schema}.tenant_finance_ledger where ${where.join(' and ')}`,
        params,
      );
      return Number(result.rows[0]?.total || 0);
    },
    async getTenantFinanceBalance(tenantId: string, currency: 'cny') {
      await ensureOperationalTables(pool, schema);
      const result = await pool.query(
        `select * from ${schema}.tenant_finance_balances where tenant_id = $1 and currency = $2 limit $3`,
        [tenantId, currency, 1],
      );
      if (!result.rowCount) {
        return null;
      }
      const row = result.rows[0];
      return {
        tenantId: row.tenant_id,
        currency: row.currency,
        balanceCents: Number(row.balance_cents || 0),
        totalCreditedCents: Number(row.total_credited_cents || 0),
        totalDebitedCents: Number(row.total_debited_cents || 0),
        updatedAt: Number(row.updated_at || 0),
      } satisfies TenantFinanceBalanceRecord;
    },
    async listTenantFinanceBalances() {
      await ensureOperationalTables(pool, schema);
      const result = await pool.query(
        `select * from ${schema}.tenant_finance_balances order by updated_at desc, tenant_id asc`,
      );
      return result.rows.map((row) => ({
        tenantId: row.tenant_id,
        currency: row.currency,
        balanceCents: Number(row.balance_cents || 0),
        totalCreditedCents: Number(row.total_credited_cents || 0),
        totalDebitedCents: Number(row.total_debited_cents || 0),
        updatedAt: Number(row.updated_at || 0),
      } satisfies TenantFinanceBalanceRecord));
    },
    async getChannelPerformanceData(fromInclusive, toExclusive) {
      await ensureOperationalTables(pool, schema);
      const snapshotKey = channelPerformanceSnapshotKey(fromInclusive, toExclusive);
      const snapshot = await readOperationalMetricSnapshot<ChannelPerformanceData>(pool, schema, snapshotKey);
      if (snapshot) {
        return normalizeChannelPerformanceSnapshot(snapshot);
      }
      const excludedTenants = [...excludedBusinessTenantIds];
      const rejectedCategories = [...rejectedFailureCategories];
      const [taskResult, billingResult, traceResult] = await Promise.all([
        pool.query(
          `
            select
              channel_id,
              upstream_id,
              count(*)::bigint as request_count,
              count(*) filter (
                where status = 'completed'
                  or (
                    status = 'failed'
                    and not (coalesce(error_payload ->> 'failure_category', '') = any($4::text[]))
                  )
              )::bigint as eligible_request_count,
              count(*) filter (where status = 'completed')::bigint as completed_count,
              count(*) filter (
                where status = 'failed'
                  and not (coalesce(error_payload ->> 'failure_category', '') = any($4::text[]))
              )::bigint as failed_count,
              count(*) filter (
                where status = 'failed'
                  and coalesce(error_payload ->> 'failure_category', '') = any($4::text[])
              )::bigint as rejected_count,
              count(*) filter (where status not in ('completed', 'failed'))::bigint as running_count,
              coalesce(avg(
                case
                  when status = 'completed' then greatest(0, coalesce(completed_at, updated_at) - created_at)
                  else null
                end
              ), 0) as average_duration_ms,
              max(updated_at) as last_activity_at,
              count(*) filter (where operation = 'generations')::bigint as generation_count,
              count(*) filter (where operation = 'edits')::bigint as edit_count
            from ${schema}.task_master
            where created_at >= $1 and created_at < $2
              and not (coalesce(tenant_id, '') = any($3::text[]))
              and coalesce(request_payload ->> '_provider_source', '') <> 'user_supplied'
            group by channel_id, upstream_id
          `,
          [fromInclusive, toExclusive, excludedTenants, rejectedCategories],
        ),
        pool.query(
          `
            select
              channel_id,
              upstream_id,
              operation,
              nullif(coalesce(detail ->> 'billedTier', detail ->> 'actualTier', detail ->> 'requestedTier', ''), '') as tier,
              nullif(coalesce(detail ->> 'billedQuality', ''), '') as quality,
                (
                  coalesce(detail ->> 'upstreamCostConfigured', '') = 'true'
                  or
                  coalesce(detail ->> 'upstreamCostYuan', '') ~ '^-?[0-9]+(\\.[0-9]+)?$'
                or coalesce(detail ->> 'upstreamCostMinorUnits', '') ~ '^-?[0-9]+$'
                or coalesce(detail ->> 'upstreamCostCents', '') ~ '^-?[0-9]+$'
              ) as upstream_unit_cost_configured,
              case
                when coalesce(detail ->> 'upstreamCostYuan', '') ~ '^-?[0-9]+(\\.[0-9]+)?$'
                  then (detail ->> 'upstreamCostYuan')::numeric * 100000
                when coalesce(detail ->> 'upstreamCostMinorUnits', '') ~ '^-?[0-9]+$'
                  then (detail ->> 'upstreamCostMinorUnits')::numeric
                when coalesce(detail ->> 'upstreamCostCents', '') ~ '^-?[0-9]+$'
                  then (detail ->> 'upstreamCostCents')::numeric
                else 0
              end as upstream_unit_cost_credits,
              count(*)::bigint as unit_count,
              coalesce(sum(charged_credits), 0)::bigint as charged_credits
            from ${schema}.billing_ledger
            where created_at >= $1 and created_at < $2
              and status = 'charged'
              and not (coalesce(tenant_id, '') = any($3::text[]))
            group by channel_id, upstream_id, operation, tier, quality, upstream_unit_cost_configured, upstream_unit_cost_credits
          `,
          [fromInclusive, toExclusive, excludedTenants],
        ),
        pool.query(
          `
            with latest as (
              select distinct on (
                coalesce(channel_id, '') || '|' || coalesce(upstream_id, '') || '|' || coalesce(request_id, task_id, trace_id)
              )
                channel_id,
                upstream_id,
                status,
                failure_category,
                created_at,
                updated_at
              from ${schema}.request_traces
              where scope = 'full_chain'
                and created_at >= $1
                and created_at < $2
                and not (coalesce(tenant_id, '') = any($3::text[]))
              order by
                coalesce(channel_id, '') || '|' || coalesce(upstream_id, '') || '|' || coalesce(request_id, task_id, trace_id),
                updated_at desc
            )
            select
              channel_id,
              upstream_id,
              count(*)::bigint as request_count,
              count(*) filter (
                where status = 'success'
                  or (
                    status = 'failed'
                    and not (coalesce(failure_category, '') = any($4::text[]))
                  )
              )::bigint as eligible_request_count,
              count(*) filter (where status = 'success')::bigint as completed_count,
              count(*) filter (
                where status = 'failed'
                  and not (coalesce(failure_category, '') = any($4::text[]))
              )::bigint as failed_count,
              count(*) filter (
                where status = 'failed'
                  and coalesce(failure_category, '') = any($4::text[])
              )::bigint as rejected_count,
              count(*) filter (where status not in ('success', 'failed'))::bigint as running_count,
              coalesce(avg(
                case
                  when status = 'success' then greatest(0, updated_at - created_at)
                  else null
                end
              ), 0) as average_duration_ms,
              max(updated_at) as last_activity_at
            from latest
            group by channel_id, upstream_id
          `,
          [fromInclusive, toExclusive, excludedTenants, rejectedCategories],
        ),
      ]);
      const data: ChannelPerformanceData = {
        tasks: taskResult.rows.map((row) => ({
          channelId: row.channel_id,
          upstreamId: row.upstream_id || undefined,
          requestCount: Number(row.request_count || 0),
          eligibleRequestCount: Number(row.eligible_request_count || 0),
          completedCount: Number(row.completed_count || 0),
          failedCount: Number(row.failed_count || 0),
          rejectedCount: Number(row.rejected_count || 0),
          runningCount: Number(row.running_count || 0),
          averageDurationMs: Number(row.average_duration_ms || 0),
          lastActivityAt: row.last_activity_at ? Number(row.last_activity_at) : undefined,
          generationCount: Number(row.generation_count || 0),
          editCount: Number(row.edit_count || 0),
        })),
        billing: billingResult.rows.map((row) => ({
          channelId: row.channel_id,
          upstreamId: row.upstream_id || undefined,
          operation: row.operation,
          tier: row.tier || undefined,
          quality: row.quality || undefined,
          unitCount: Number(row.unit_count || 0),
          upstreamUnitCostConfigured: Boolean(row.upstream_unit_cost_configured),
          upstreamUnitCostCredits: Number(row.upstream_unit_cost_credits || 0),
          chargedCredits: Number(row.charged_credits || 0),
        })),
        traces: traceResult.rows.map((row) => ({
          channelId: row.channel_id || '',
          upstreamId: row.upstream_id || undefined,
          requestCount: Number(row.request_count || 0),
          eligibleRequestCount: Number(row.eligible_request_count || 0),
          completedCount: Number(row.completed_count || 0),
          failedCount: Number(row.failed_count || 0),
          rejectedCount: Number(row.rejected_count || 0),
          runningCount: Number(row.running_count || 0),
          averageDurationMs: Number(row.average_duration_ms || 0),
          lastActivityAt: row.last_activity_at ? Number(row.last_activity_at) : undefined,
        })),
      };
      await writeOperationalMetricSnapshot(pool, schema, snapshotKey, data as unknown as Record<string, unknown>);
      return data;
    },
    async getBusinessOverviewData(input) {
      await ensureOperationalTables(pool, schema);
      const snapshotKey = businessOverviewSnapshotKey(input);
      const snapshot = await readOperationalMetricSnapshot<BusinessOverviewData>(pool, schema, snapshotKey);
      if (snapshot) {
        return snapshot;
      }
      const excludedTenants = [...excludedBusinessTenantIds];
      const rejectedCategories = [...rejectedFailureCategories];
      const [imageTaskResult, textTraceResult, billingResult] = await Promise.all([
        pool.query(
          `
            select
              count(*) filter (where created_at >= $1)::bigint as requests_1h,
              count(*) filter (
                where created_at >= $1
                  and (
                    status = 'completed'
                    or (
                      status = 'failed'
                      and not (coalesce(error_payload ->> 'failure_category', '') = any($5::text[]))
                    )
                  )
              )::bigint as eligible_requests_1h,
              count(*) filter (where created_at >= $1 and status = 'completed')::bigint as success_1h,
              count(*) filter (
                where created_at >= $1
                  and status = 'failed'
                  and not (coalesce(error_payload ->> 'failure_category', '') = any($5::text[]))
              )::bigint as failed_1h,
              count(*) filter (
                where created_at >= $1
                  and status = 'failed'
                  and coalesce(error_payload ->> 'failure_category', '') = any($5::text[])
              )::bigint as rejected_1h,
              count(*) filter (where created_at >= $2)::bigint as requests_24h,
              count(*) filter (
                where created_at >= $2
                  and (
                    status = 'completed'
                    or (
                      status = 'failed'
                      and not (coalesce(error_payload ->> 'failure_category', '') = any($5::text[]))
                    )
                  )
              )::bigint as eligible_requests_24h,
              count(*) filter (where created_at >= $2 and status = 'completed')::bigint as success_24h,
              count(*) filter (
                where created_at >= $2
                  and status = 'failed'
                  and not (coalesce(error_payload ->> 'failure_category', '') = any($5::text[]))
              )::bigint as failed_24h,
              count(*) filter (
                where created_at >= $2
                  and status = 'failed'
                  and coalesce(error_payload ->> 'failure_category', '') = any($5::text[])
              )::bigint as rejected_24h,
              count(*) filter (where status in ('queued', 'running'))::bigint as running_current,
              coalesce(avg(
                case
                  when created_at >= $2 and status = 'completed'
                    then greatest(0, coalesce(completed_at, updated_at) - created_at)
                  else null
                end
              ), 0) as average_duration_24h_ms
            from ${schema}.task_master
            where created_at < $3
              and not (coalesce(tenant_id, '') = any($4::text[]))
              and coalesce(request_payload ->> '_provider_source', '') <> 'user_supplied'
              and coalesce(channel_id, '') in ('image_generation', 'channel_image_generation')
          `,
          [input.oneHourAgo, input.oneDayAgo, input.toExclusive, excludedTenants, rejectedCategories],
        ),
        pool.query(
          `
            with latest as (
              select distinct on (coalesce(request_id, task_id, trace_id))
                status,
                failure_category,
                created_at
              from ${schema}.request_traces
              where scope = 'full_chain'
                and created_at >= $2
                and created_at < $3
                and not (coalesce(tenant_id, '') = any($4::text[]))
                and coalesce(channel_id, '') in ('text_processing', 'channel_text_processing')
              order by coalesce(request_id, task_id, trace_id), updated_at desc
            )
            select
              count(*) filter (where created_at >= $1)::bigint as requests_1h,
              count(*) filter (
                where created_at >= $1
                  and (
                    status = 'success'
                    or (
                      status = 'failed'
                      and not (coalesce(failure_category, '') = any($5::text[]))
                    )
                  )
              )::bigint as eligible_requests_1h,
              count(*) filter (where created_at >= $1 and status = 'success')::bigint as success_1h,
              count(*) filter (
                where created_at >= $1
                  and status = 'failed'
                  and not (coalesce(failure_category, '') = any($5::text[]))
              )::bigint as failed_1h,
              count(*) filter (
                where created_at >= $1
                  and status = 'failed'
                  and coalesce(failure_category, '') = any($5::text[])
              )::bigint as rejected_1h,
              count(*)::bigint as requests_24h,
              count(*) filter (
                where status = 'success'
                  or (
                    status = 'failed'
                    and not (coalesce(failure_category, '') = any($5::text[]))
                  )
              )::bigint as eligible_requests_24h,
              count(*) filter (where status = 'success')::bigint as success_24h,
              count(*) filter (
                where status = 'failed'
                  and not (coalesce(failure_category, '') = any($5::text[]))
              )::bigint as failed_24h,
              count(*) filter (
                where status = 'failed'
                  and coalesce(failure_category, '') = any($5::text[])
              )::bigint as rejected_24h
            from latest
          `,
          [input.oneHourAgo, input.oneDayAgo, input.toExclusive, excludedTenants, rejectedCategories],
        ),
        pool.query(
          `
            select
              coalesce(sum(charged_credits), 0)::bigint as charged_24h
            from ${schema}.billing_ledger
            where created_at >= $1
              and created_at < $2
              and not (coalesce(tenant_id, '') = any($3::text[]))
          `,
          [input.oneDayAgo, input.toExclusive, excludedTenants],
        ),
      ]);

      const image = imageTaskResult.rows[0] || {};
      const text = textTraceResult.rows[0] || {};
      const billing = billingResult.rows[0] || {};

      const data: BusinessOverviewData = {
        imageRequests1h: Number(image.requests_1h || 0),
        imageEligibleRequests1h: Number(image.eligible_requests_1h || 0),
        imageSuccess1h: Number(image.success_1h || 0),
        imageFailed1h: Number(image.failed_1h || 0),
        imageRejected1h: Number(image.rejected_1h || 0),
        imageRequests24h: Number(image.requests_24h || 0),
        imageEligibleRequests24h: Number(image.eligible_requests_24h || 0),
        imageSuccess24h: Number(image.success_24h || 0),
        imageFailed24h: Number(image.failed_24h || 0),
        imageRejected24h: Number(image.rejected_24h || 0),
        imageAverageDuration24hMs: Number(image.average_duration_24h_ms || 0),
        textRequests1h: Number(text.requests_1h || 0),
        textEligibleRequests1h: Number(text.eligible_requests_1h || 0),
        textSuccess1h: Number(text.success_1h || 0),
        textFailed1h: Number(text.failed_1h || 0),
        textRejected1h: Number(text.rejected_1h || 0),
        textRequests24h: Number(text.requests_24h || 0),
        textEligibleRequests24h: Number(text.eligible_requests_24h || 0),
        textSuccess24h: Number(text.success_24h || 0),
        textFailed24h: Number(text.failed_24h || 0),
        textRejected24h: Number(text.rejected_24h || 0),
        charged24hCents: Number(billing.charged_24h || 0),
        runningTasksCurrent: Number(image.running_current || 0),
      };
      await writeOperationalMetricSnapshot(pool, schema, snapshotKey, data as unknown as Record<string, unknown>);
      return data;
    },
    async upsertOperationalMetricRollup(record) {
      await ensureOperationalTables(pool, schema);
      await pool.query(
        `
          insert into ${schema}.operational_metric_rollups (
            rollup_key, metric_family, bucket_start, bucket_ms, channel_id, upstream_id,
            tenant_id, api_key_id, operation, tier, quality, failure_category, source,
            metrics, detail, generated_at, updated_at
          ) values (
            $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15::jsonb,$16,$17
          )
          on conflict (rollup_key) do update set
            metric_family = excluded.metric_family,
            bucket_start = excluded.bucket_start,
            bucket_ms = excluded.bucket_ms,
            channel_id = excluded.channel_id,
            upstream_id = excluded.upstream_id,
            tenant_id = excluded.tenant_id,
            api_key_id = excluded.api_key_id,
            operation = excluded.operation,
            tier = excluded.tier,
            quality = excluded.quality,
            failure_category = excluded.failure_category,
            source = excluded.source,
            metrics = excluded.metrics,
            detail = excluded.detail,
            generated_at = excluded.generated_at,
            updated_at = excluded.updated_at
        `,
        [
          record.rollupKey,
          record.metricFamily,
          record.bucketStart,
          record.bucketMs,
          record.channelId || null,
          record.upstreamId || null,
          record.tenantId || null,
          record.apiKeyId || null,
          record.operation || null,
          record.tier || null,
          record.quality || null,
          record.failureCategory || null,
          record.source,
          JSON.stringify(record.metrics || {}),
          JSON.stringify(record.detail || {}),
          record.generatedAt,
          record.updatedAt,
        ],
      );
      return record;
    },
    async listOperationalMetricRollups(input) {
      await ensureOperationalTables(pool, schema);
      const limit = Math.max(1, Math.min(10_000, Number(input.limit || 1000)));
      const conditions = ['bucket_start >= $1', 'bucket_start < $2'];
      const params: unknown[] = [input.fromInclusive, input.toExclusive];
      function addCondition(sql: string, value: unknown) {
        params.push(value);
        conditions.push(sql.replace('?', `$${params.length}`));
      }
      if (input.metricFamily) {
        addCondition('metric_family = ?', input.metricFamily);
      }
      if (input.channelId) {
        addCondition('channel_id = ?', input.channelId);
      }
      if (input.upstreamId) {
        addCondition('upstream_id = ?', input.upstreamId);
      }
      if (input.tenantId) {
        addCondition('tenant_id = ?', input.tenantId);
      }
      params.push(limit);
      const result = await pool.query(
        `
          select *
          from ${schema}.operational_metric_rollups
          where ${conditions.join(' and ')}
          order by bucket_start desc, metric_family asc, channel_id asc nulls last, upstream_id asc nulls last
          limit $${params.length}
        `,
        params,
      );
      return result.rows.map(mapOperationalMetricRollupRow);
    },
    async clearOperationalRollups(input) {
      await ensureOperationalTables(pool, schema);
      if (input?.metricFamily) {
        const rollupResult = await pool.query(
          `delete from ${schema}.operational_metric_rollups where metric_family = $1`,
          [input.metricFamily],
        );
        const jobResult = input.metricFamily === 'channel_performance'
          ? await pool.query(
            `delete from ${schema}.operational_rollup_jobs where job_key = $1`,
            ['channel_performance_daily_v1'],
          )
          : { rowCount: 0 };
        return {
          rollups: Number(rollupResult.rowCount || 0),
          jobs: Number(jobResult.rowCount || 0),
        };
      }
      const rollupResult = await pool.query(`delete from ${schema}.operational_metric_rollups`);
      const jobResult = await pool.query(`delete from ${schema}.operational_rollup_jobs`);
      return {
        rollups: Number(rollupResult.rowCount || 0),
        jobs: Number(jobResult.rowCount || 0),
      };
    },
    async tryStartOperationalRollupJob(input) {
      await ensureOperationalTables(pool, schema);
      const now = Date.now();
      const lockMs = Math.max(60_000, Number(input.lockMs || 0));
      const result = await pool.query(
        `
          insert into ${schema}.operational_rollup_jobs (
            job_key, locked_until, locked_by, updated_at
          ) values ($1,$2,$3,$4)
          on conflict (job_key) do update set
            locked_until = excluded.locked_until,
            locked_by = excluded.locked_by,
            updated_at = excluded.updated_at
          where coalesce(${schema}.operational_rollup_jobs.locked_until, 0) <= $4
             or ${schema}.operational_rollup_jobs.locked_by = $3
          returning job_key
        `,
        [input.jobKey, now + lockMs, input.workerId, now],
      );
      return Boolean(result.rowCount);
    },
    async finishOperationalRollupJob(input) {
      await ensureOperationalTables(pool, schema);
      const now = Date.now();
      await pool.query(
        `
          insert into ${schema}.operational_rollup_jobs (
            job_key, locked_until, locked_by, last_success_at, last_error, updated_at
          ) values ($1,0,$2,$3,$4,$5)
          on conflict (job_key) do update set
            locked_until = 0,
            locked_by = excluded.locked_by,
            last_success_at = coalesce(excluded.last_success_at, ${schema}.operational_rollup_jobs.last_success_at),
            last_error = excluded.last_error,
            updated_at = excluded.updated_at
          where ${schema}.operational_rollup_jobs.locked_by = $2
             or coalesce(${schema}.operational_rollup_jobs.locked_until, 0) <= $5
        `,
        [
          input.jobKey,
          input.workerId,
          input.success ? now : null,
          input.success ? null : String(input.error || '').slice(0, 2000),
          now,
        ],
      );
    },
    async getOperationalRollupJob(jobKey) {
      await ensureOperationalTables(pool, schema);
      const result = await pool.query(
        `select * from ${schema}.operational_rollup_jobs where job_key = $1 limit 1`,
        [jobKey],
      );
      if (!result.rowCount) {
        return null;
      }
      return mapOperationalRollupJobRow(result.rows[0]);
    },
    async enqueueOperationalOutboxEvent(record) {
      await ensureOperationalTables(pool, schema);
      const result = await pool.query(
        `
          insert into ${schema}.operational_outbox_events (
            event_id, event_type, idempotency_key, status, payload, attempt_count,
            available_at, locked_until, locked_by, last_error, created_at, updated_at, completed_at
          ) values ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11,$12,$13)
          on conflict (idempotency_key) do update set
            payload = case
              when ${schema}.operational_outbox_events.status = 'completed' then ${schema}.operational_outbox_events.payload
              else excluded.payload
            end,
            status = case
              when ${schema}.operational_outbox_events.status = 'completed' then ${schema}.operational_outbox_events.status
              else excluded.status
            end,
            available_at = case
              when ${schema}.operational_outbox_events.status = 'completed' then ${schema}.operational_outbox_events.available_at
              else excluded.available_at
            end,
            locked_until = case
              when ${schema}.operational_outbox_events.status = 'completed' then ${schema}.operational_outbox_events.locked_until
              else null
            end,
            locked_by = case
              when ${schema}.operational_outbox_events.status = 'completed' then ${schema}.operational_outbox_events.locked_by
              else null
            end,
            last_error = case
              when ${schema}.operational_outbox_events.status = 'completed' then ${schema}.operational_outbox_events.last_error
              else null
            end,
            updated_at = excluded.updated_at
          returning *
        `,
        [
          record.eventId,
          record.eventType,
          record.idempotencyKey,
          record.status,
          JSON.stringify(record.payload || {}),
          record.attemptCount,
          record.availableAt,
          record.lockedUntil || null,
          record.lockedBy || null,
          record.lastError || null,
          record.createdAt,
          record.updatedAt,
          record.completedAt || null,
        ],
      );
      return mapOperationalOutboxEventRow(result.rows[0]);
    },
    async claimOperationalOutboxEvents(input) {
      await ensureOperationalTables(pool, schema);
      const now = Date.now();
      const limit = Math.max(1, Math.min(100, Math.floor(Number(input.limit || 1))));
      const lockMs = Math.max(5_000, Math.min(15 * 60_000, Math.floor(Number(input.lockMs || 60_000))));
      const result = await pool.query(
        `
          with candidates as (
            select event_id
            from ${schema}.operational_outbox_events
            where event_type = $1
              and status in ('pending', 'retrying', 'processing')
              and available_at <= $2
              and (status <> 'processing' or coalesce(locked_until, 0) <= $2)
            order by created_at asc
            limit $3
            for update skip locked
          )
          update ${schema}.operational_outbox_events outbox
          set status = 'processing',
              attempt_count = outbox.attempt_count + 1,
              locked_until = $4,
              locked_by = $5,
              updated_at = $2
          from candidates
          where outbox.event_id = candidates.event_id
          returning outbox.*
        `,
        [input.eventType, now, limit, now + lockMs, input.workerId],
      );
      return result.rows.map(mapOperationalOutboxEventRow);
    },
    async markOperationalOutboxEventCompleted(input) {
      await ensureOperationalTables(pool, schema);
      const now = Date.now();
      await pool.query(
        `
          update ${schema}.operational_outbox_events
          set status = 'completed',
              payload = '{}'::jsonb,
              locked_until = null,
              locked_by = null,
              last_error = null,
              completed_at = $2,
              updated_at = $2
          where event_id = $1
            and (locked_by = $3 or status = 'completed')
        `,
        [input.eventId, now, input.workerId],
      );
    },
    async markOperationalOutboxEventFailed(input) {
      await ensureOperationalTables(pool, schema);
      const now = Date.now();
      const maxAttempts = Math.max(1, Math.floor(Number(input.maxAttempts || 1)));
      const retryDelayMs = Math.max(1_000, Math.min(60 * 60_000, Math.floor(Number(input.retryDelayMs || 10_000))));
      await pool.query(
        `
          update ${schema}.operational_outbox_events
          set status = case when attempt_count >= $4 then 'dead' else 'retrying' end,
              available_at = case when attempt_count >= $4 then available_at else $2 + $5 end,
              locked_until = null,
              locked_by = null,
              last_error = $6,
              updated_at = $2
          where event_id = $1
            and locked_by = $3
        `,
        [
          input.eventId,
          now,
          input.workerId,
          maxAttempts,
          retryDelayMs,
          String(input.error || '').slice(0, 4000),
        ],
      );
    },
    async applyBillingChargePersistenceBundle(input: BillingChargePersistenceBundle) {
      await ensureOperationalTables(pool, schema);
      await withPostgresRetry(async () => {
        const client = await (pool as unknown as { connect: () => Promise<PgClient> }).connect();
        try {
          await client.query('begin');
          let insertedChargedCredits = 0;
          let creditTenantId = '';
          let creditCurrency: 'cny' = 'cny';
          let creditRequestId = '';
          let creditTaskId = '';
          for (const record of input.billingRecords || []) {
            const insertResult = await client.query(
              `
                insert into ${schema}.billing_ledger (
                  id, created_at, updated_at, tenant_id, api_key_id, channel_id, upstream_id,
                  request_id, task_id, operation, currency, reserved_credits, charged_credits,
                  status, model, size, detail
                ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb)
                on conflict (id) do nothing
                returning id
              `,
              [
                record.id,
                record.createdAt,
                record.updatedAt,
                record.tenantId,
                record.apiKeyId,
                record.channelId,
                record.upstreamId || null,
                record.requestId,
                record.taskId || null,
                record.operation,
                record.currency,
                record.reservedCredits,
                record.chargedCredits,
                record.status,
                record.model,
                record.size || null,
                JSON.stringify(record.detail || {}),
              ],
            );
            if (insertResult.rowCount && record.status === 'charged' && Number(record.chargedCredits || 0) > 0) {
              insertedChargedCredits += Number(record.chargedCredits || 0);
              creditTenantId = record.tenantId;
              creditCurrency = record.currency;
              creditRequestId = record.requestId;
              creditTaskId = record.taskId || '';
            }
          }
          if (insertedChargedCredits > 0 && creditTenantId) {
            const updatedAt = Date.now();
            await client.query(
              `
                insert into ${schema}.tenant_credit_balances (
                  tenant_id, currency, total_charged_credits, total_voided_credits, total_reserved_credits,
                  last_request_id, last_task_id, updated_at
                ) values ($1,$2,$3,0,0,$4,$5,$6)
                on conflict (tenant_id, currency) do update set
                  total_charged_credits = ${schema}.tenant_credit_balances.total_charged_credits + excluded.total_charged_credits,
                  last_request_id = coalesce(excluded.last_request_id, ${schema}.tenant_credit_balances.last_request_id),
                  last_task_id = coalesce(excluded.last_task_id, ${schema}.tenant_credit_balances.last_task_id),
                  updated_at = excluded.updated_at
              `,
              [creditTenantId, creditCurrency, insertedChargedCredits, creditRequestId || null, creditTaskId || null, updatedAt],
            );
          }

          const finance = input.tenantFinanceLedger;
          if (finance && finance.idempotencyKey && Number(finance.amountCents || 0) > 0) {
            const existingFinance = await client.query(
              `select id from ${schema}.tenant_finance_ledger where id = $1 limit 1 for update`,
              [finance.idempotencyKey],
            );
            if (!existingFinance.rowCount) {
              const now = Date.now();
              const amountCents = Number(finance.amountCents || 0);
              const delta = finance.direction === 'credit' ? amountCents : -amountCents;
              const balanceResult = await client.query(
                `
                  insert into ${schema}.tenant_finance_balances (
                    tenant_id, currency, balance_cents, total_credited_cents, total_debited_cents, updated_at
                  ) values ($1,$2,$3,$4,$5,$6)
                  on conflict (tenant_id, currency) do update set
                    balance_cents = ${schema}.tenant_finance_balances.balance_cents + excluded.balance_cents,
                    total_credited_cents = ${schema}.tenant_finance_balances.total_credited_cents + excluded.total_credited_cents,
                    total_debited_cents = ${schema}.tenant_finance_balances.total_debited_cents + excluded.total_debited_cents,
                    updated_at = excluded.updated_at
                  returning *
                `,
                [
                  finance.tenantId,
                  finance.currency,
                  delta,
                  finance.direction === 'credit' ? amountCents : 0,
                  finance.direction === 'debit' ? amountCents : 0,
                  now,
                ],
              );
              await client.query(
                `
                  insert into ${schema}.tenant_finance_ledger (
                    id, created_at, updated_at, tenant_id, operator_id, direction, amount_cents,
                    balance_after_cents, currency, note, detail
                  ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)
                `,
                [
                  finance.idempotencyKey,
                  now,
                  now,
                  finance.tenantId,
                  finance.operatorId,
                  finance.direction,
                  amountCents,
                  Number(balanceResult.rows[0]?.balance_cents || 0),
                  finance.currency,
                  finance.note,
                  JSON.stringify(finance.detail || {}),
                ],
              );
            }
          }
          await client.query('commit');
        } catch (error) {
          await client.query('rollback').catch(() => undefined);
          throw error;
        } finally {
          client.release();
        }
      });
    },
    async applyImageGatewayPersistenceBundle(input: ImageGatewayPersistenceBundle) {
      await ensureOperationalTables(pool, schema);
      await withPostgresRetry(async () => {
        const client = await (pool as unknown as { connect: () => Promise<PgClient> }).connect();
        try {
          await client.query('begin');
          let insertedChargedCredits = 0;
          let creditTenantId = '';
          let creditCurrency: 'cny' = 'cny';
          let creditRequestId = '';
          let creditTaskId = '';
          for (const record of input.billingRecords || []) {
            const insertResult = await client.query(
              `
                insert into ${schema}.billing_ledger (
                  id, created_at, updated_at, tenant_id, api_key_id, channel_id, upstream_id,
                  request_id, task_id, operation, currency, reserved_credits, charged_credits,
                  status, model, size, detail
                ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb)
                on conflict (id) do nothing
                returning id
              `,
              [
                record.id,
                record.createdAt,
                record.updatedAt,
                record.tenantId,
                record.apiKeyId,
                record.channelId,
                record.upstreamId || null,
                record.requestId,
                record.taskId || null,
                record.operation,
                record.currency,
                record.reservedCredits,
                record.chargedCredits,
                record.status,
                record.model,
                record.size || null,
                JSON.stringify(record.detail || {}),
              ],
            );
            if (insertResult.rowCount && record.status === 'charged' && Number(record.chargedCredits || 0) > 0) {
              insertedChargedCredits += Number(record.chargedCredits || 0);
              creditTenantId = record.tenantId;
              creditCurrency = record.currency;
              creditRequestId = record.requestId;
              creditTaskId = record.taskId || '';
            }
          }
          if (insertedChargedCredits > 0 && creditTenantId) {
            const updatedAt = Date.now();
            await client.query(
              `
                insert into ${schema}.tenant_credit_balances (
                  tenant_id, currency, total_charged_credits, total_voided_credits, total_reserved_credits,
                  last_request_id, last_task_id, updated_at
                ) values ($1,$2,$3,0,0,$4,$5,$6)
                on conflict (tenant_id, currency) do update set
                  total_charged_credits = ${schema}.tenant_credit_balances.total_charged_credits + excluded.total_charged_credits,
                  last_request_id = coalesce(excluded.last_request_id, ${schema}.tenant_credit_balances.last_request_id),
                  last_task_id = coalesce(excluded.last_task_id, ${schema}.tenant_credit_balances.last_task_id),
                  updated_at = excluded.updated_at
              `,
              [creditTenantId, creditCurrency, insertedChargedCredits, creditRequestId || null, creditTaskId || null, updatedAt],
            );
          }

          const finance = input.tenantFinanceLedger;
          if (finance && finance.idempotencyKey && Number(finance.amountCents || 0) > 0) {
            const existingFinance = await client.query(
              `select id from ${schema}.tenant_finance_ledger where id = $1 limit 1 for update`,
              [finance.idempotencyKey],
            );
            if (!existingFinance.rowCount) {
              const now = Date.now();
              const amountCents = Number(finance.amountCents || 0);
              const delta = finance.direction === 'credit' ? amountCents : -amountCents;
              const balanceResult = await client.query(
                `
                  insert into ${schema}.tenant_finance_balances (
                    tenant_id, currency, balance_cents, total_credited_cents, total_debited_cents, updated_at
                  ) values ($1,$2,$3,$4,$5,$6)
                  on conflict (tenant_id, currency) do update set
                    balance_cents = ${schema}.tenant_finance_balances.balance_cents + excluded.balance_cents,
                    total_credited_cents = ${schema}.tenant_finance_balances.total_credited_cents + excluded.total_credited_cents,
                    total_debited_cents = ${schema}.tenant_finance_balances.total_debited_cents + excluded.total_debited_cents,
                    updated_at = excluded.updated_at
                  returning *
                `,
                [
                  finance.tenantId,
                  finance.currency,
                  delta,
                  finance.direction === 'credit' ? amountCents : 0,
                  finance.direction === 'debit' ? amountCents : 0,
                  now,
                ],
              );
              await client.query(
                `
                  insert into ${schema}.tenant_finance_ledger (
                    id, created_at, updated_at, tenant_id, operator_id, direction, amount_cents,
                    balance_after_cents, currency, note, detail
                  ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)
                `,
                [
                  finance.idempotencyKey,
                  now,
                  now,
                  finance.tenantId,
                  finance.operatorId,
                  finance.direction,
                  amountCents,
                  Number(balanceResult.rows[0]?.balance_cents || 0),
                  finance.currency,
                  finance.note,
                  JSON.stringify(finance.detail || {}),
                ],
              );
            }
          }

          const record = input.taskRecord;
          await client.query(
            `
              insert into ${schema}.task_master (
                task_id, request_id, tenant_id, api_key_id, channel_id, upstream_id, operation, status,
                provider_id, model, prompt_preview, created_at, updated_at, completed_at,
                request_payload, response_payload, error_payload, billed_credits
              ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16::jsonb,$17::jsonb,$18)
              on conflict (task_id) do update set
                request_id = excluded.request_id,
                tenant_id = excluded.tenant_id,
                api_key_id = excluded.api_key_id,
                channel_id = excluded.channel_id,
                upstream_id = excluded.upstream_id,
                operation = excluded.operation,
                status = excluded.status,
                provider_id = excluded.provider_id,
                model = excluded.model,
                prompt_preview = excluded.prompt_preview,
                updated_at = excluded.updated_at,
                completed_at = excluded.completed_at,
                request_payload = excluded.request_payload,
                response_payload = excluded.response_payload,
                error_payload = excluded.error_payload,
                billed_credits = excluded.billed_credits
            `,
            [
              record.taskId,
              record.requestId,
              record.tenantId,
              record.apiKeyId,
              record.channelId,
              record.upstreamId || null,
              record.operation,
              record.status,
              record.providerId || null,
              record.model,
              record.promptPreview,
              record.createdAt,
              record.updatedAt,
              record.completedAt || null,
              JSON.stringify({
                ...(record.requestPayload || {}),
                _provider_source: record.providerSource || null,
                _provider_base_url: record.providerBaseUrl || null,
              }),
              JSON.stringify(record.responsePayload || null),
              record.errorPayload ? JSON.stringify(record.errorPayload) : null,
              record.billedCredits ?? null,
            ],
          );
          await client.query('commit');
        } catch (error) {
          await rollbackQuietly(client);
          throw error;
        } finally {
          client.release();
        }
      });
    },
    async upsertTask(record: TaskMasterRecord) {
      await ensureOperationalTables(pool, schema);
      await pool.query(
        `
          insert into ${schema}.task_master (
            task_id, request_id, tenant_id, api_key_id, channel_id, upstream_id, operation, status,
            provider_id, model, prompt_preview, created_at, updated_at, completed_at,
            request_payload, response_payload, error_payload, billed_credits
          ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16::jsonb,$17::jsonb,$18)
          on conflict (task_id) do update set
            request_id = excluded.request_id,
            tenant_id = excluded.tenant_id,
            api_key_id = excluded.api_key_id,
            channel_id = excluded.channel_id,
            upstream_id = excluded.upstream_id,
            operation = excluded.operation,
            status = excluded.status,
            provider_id = excluded.provider_id,
            model = excluded.model,
            prompt_preview = excluded.prompt_preview,
            updated_at = excluded.updated_at,
            completed_at = excluded.completed_at,
            request_payload = excluded.request_payload,
            response_payload = excluded.response_payload,
            error_payload = excluded.error_payload,
            billed_credits = excluded.billed_credits
        `,
        [
          record.taskId,
          record.requestId,
          record.tenantId,
          record.apiKeyId,
          record.channelId,
          record.upstreamId || null,
          record.operation,
          record.status,
          record.providerId || null,
          record.model,
          record.promptPreview,
          record.createdAt,
          record.updatedAt,
          record.completedAt || null,
          JSON.stringify({
            ...(record.requestPayload || {}),
            _provider_source: record.providerSource || null,
            _provider_base_url: record.providerBaseUrl || null,
          }),
          JSON.stringify(record.responsePayload || null),
          record.errorPayload ? JSON.stringify(record.errorPayload) : null,
          record.billedCredits ?? null,
        ],
      );
      return record;
    },
    async getTask(taskId: string) {
      await ensureOperationalTables(pool, schema);
      const result = await pool.query(`select * from ${schema}.task_master where task_id = $1 limit 1`, [taskId]);
      if (!result.rowCount) {
        return null;
      }
      const row = result.rows[0];
      return {
        taskId: row.task_id,
        requestId: row.request_id,
        tenantId: row.tenant_id,
        apiKeyId: row.api_key_id,
        channelId: row.channel_id,
        upstreamId: row.upstream_id ?? undefined,
        operation: row.operation,
        status: row.status,
        providerId: row.provider_id ?? undefined,
        providerSource: row.request_payload?._provider_source ?? undefined,
        providerBaseUrl: row.request_payload?._provider_base_url ?? undefined,
        model: row.model,
        promptPreview: row.prompt_preview,
        createdAt: Number(row.created_at),
        updatedAt: Number(row.updated_at),
        completedAt: row.completed_at ? Number(row.completed_at) : undefined,
        requestPayload: row.request_payload || {},
        responsePayload: row.response_payload || null,
        errorPayload: row.error_payload || null,
        billedCredits: row.billed_credits ?? undefined,
      } satisfies TaskMasterRecord;
    },
    async listTasks(limit: number) {
      await ensureOperationalTables(pool, schema);
      const result = await pool.query(
        `select * from ${schema}.task_master order by created_at desc limit $1`,
        [limit],
      );
      return result.rows.map((row) => ({
        taskId: row.task_id,
        requestId: row.request_id,
        tenantId: row.tenant_id,
        apiKeyId: row.api_key_id,
        channelId: row.channel_id,
        upstreamId: row.upstream_id ?? undefined,
        operation: row.operation,
        status: row.status,
        providerId: row.provider_id ?? undefined,
        providerSource: row.request_payload?._provider_source ?? undefined,
        providerBaseUrl: row.request_payload?._provider_base_url ?? undefined,
        model: row.model,
        promptPreview: row.prompt_preview,
        createdAt: Number(row.created_at),
        updatedAt: Number(row.updated_at),
        completedAt: row.completed_at ? Number(row.completed_at) : undefined,
        requestPayload: row.request_payload || {},
        responsePayload: row.response_payload || null,
        errorPayload: row.error_payload || null,
        billedCredits: row.billed_credits ?? undefined,
      } satisfies TaskMasterRecord));
    },
    async listTasksForRoutingAccuracy(limit: number) {
      await ensureOperationalTables(pool, schema);
      const result = await pool.query(
        `
          select
            task_id, request_id, tenant_id, api_key_id, channel_id, upstream_id,
            operation, status, provider_id, model, prompt_preview,
            created_at, updated_at, completed_at, billed_credits,
            case when request_payload ? 'resolutionAudit'
              then jsonb_build_object('resolutionAudit', request_payload -> 'resolutionAudit')
              else '{}'::jsonb end as request_payload,
            case when response_payload ? 'resolutionAudit'
              then jsonb_build_object('resolutionAudit', response_payload -> 'resolutionAudit')
              else null end as response_payload
          from ${schema}.task_master
          order by created_at desc
          limit $1
        `,
        [limit],
      );
      return result.rows.map((row) => ({
        taskId: row.task_id,
        requestId: row.request_id,
        tenantId: row.tenant_id,
        apiKeyId: row.api_key_id,
        channelId: row.channel_id,
        upstreamId: row.upstream_id ?? undefined,
        operation: row.operation,
        status: row.status,
        providerId: row.provider_id ?? undefined,
        providerSource: undefined,
        providerBaseUrl: undefined,
        model: row.model,
        promptPreview: row.prompt_preview,
        createdAt: Number(row.created_at),
        updatedAt: Number(row.updated_at),
        completedAt: row.completed_at ? Number(row.completed_at) : undefined,
        requestPayload: row.request_payload || {},
        responsePayload: row.response_payload || null,
        errorPayload: null,
        billedCredits: row.billed_credits ?? undefined,
      } satisfies TaskMasterRecord));
    },
    async getRoutingAccuracySnapshot(snapshotKey: string) {
      await ensureOperationalTables(pool, schema);
      const result = await pool.query(
        `select * from ${schema}.routing_accuracy_snapshots where snapshot_key = $1 limit 1`,
        [snapshotKey],
      );
      if (!result.rowCount) {
        return null;
      }
      const row = result.rows[0];
      return {
        snapshotKey: row.snapshot_key,
        generatedAt: Number(row.generated_at || 0),
        expiresAt: Number(row.expires_at || 0),
        payload: row.payload && typeof row.payload === 'object' ? row.payload : {},
      };
    },
    async upsertRoutingAccuracySnapshot(record) {
      await ensureOperationalTables(pool, schema);
      await pool.query(
        `
          insert into ${schema}.routing_accuracy_snapshots (
            snapshot_key, generated_at, expires_at, payload, updated_at
          ) values ($1,$2,$3,$4::jsonb,$5)
          on conflict (snapshot_key) do update set
            generated_at = excluded.generated_at,
            expires_at = excluded.expires_at,
            payload = excluded.payload,
            updated_at = excluded.updated_at
        `,
        [
          record.snapshotKey,
          record.generatedAt,
          record.expiresAt,
          JSON.stringify(record.payload || {}),
          Date.now(),
        ],
      );
      return record;
    },
  };
}
