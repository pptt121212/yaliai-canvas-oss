import type { Pool } from 'pg';

/**
 * 月分区的命名、建表与回收工具。
 *
 * 高频运行明细统一以 Unix 毫秒作为分区键。业务主键仍由独立的全局定位表
 * 保证唯一和幂等，避免 PostgreSQL 分区表要求唯一键必须包含分区键的问题。
 */

export type PartitionedOperationalTable =
  | 'request_traces'
  | 'billing_ledger'
  | 'task_master'
  | 'tenant_finance_ledger';

type Queryable = Pick<Pool, 'query'>;

const monthMs = 31 * 24 * 60 * 60 * 1000;
const partitionEnsurePromises = new Map<string, Promise<void>>();

function padMonth(value: number) {
  return String(value).padStart(2, '0');
}

export function startOfUtcMonth(timestamp: number) {
  const date = new Date(timestamp);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
}

export function startOfNextUtcMonth(timestamp: number) {
  const date = new Date(startOfUtcMonth(timestamp));
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
}

export function operationalPartitionName(table: PartitionedOperationalTable, timestamp: number) {
  const date = new Date(startOfUtcMonth(timestamp));
  return `${table}_${date.getUTCFullYear()}_${padMonth(date.getUTCMonth() + 1)}`;
}

function assertSafeIdentifier(value: string, label: string) {
  if (!/^[a-z_][a-z0-9_]*$/i.test(value)) {
    throw new Error(`invalid_${label}_identifier`);
  }
  return value;
}

function qualified(schema: string, table: string) {
  return `${assertSafeIdentifier(schema, 'schema')}.${assertSafeIdentifier(table, 'table')}`;
}

/** Ensures the month that contains timestamp and the following month exist before writes arrive. */
export async function ensureOperationalMonthlyPartition(
  db: Queryable,
  schema: string,
  table: PartitionedOperationalTable,
  timestamp: number,
) {
  const monthStart = startOfUtcMonth(timestamp);
  const monthEnd = startOfNextUtcMonth(timestamp);
  const partition = operationalPartitionName(table, monthStart);
  const cacheKey = `${schema}:${table}:${monthStart}`;
  const existing = partitionEnsurePromises.get(cacheKey);
  if (existing) {
    return existing;
  }
  const pending = (async () => {
    await db.query(
      `create table if not exists ${qualified(schema, partition)} partition of ${qualified(schema, table)} for values from (${monthStart}) to (${monthEnd})`,
    );
    const nextPartition = operationalPartitionName(table, monthEnd);
    const nextMonthEnd = startOfNextUtcMonth(monthEnd);
    await db.query(
      `create table if not exists ${qualified(schema, nextPartition)} partition of ${qualified(schema, table)} for values from (${monthEnd}) to (${nextMonthEnd})`,
    );
  })().catch((error) => {
    partitionEnsurePromises.delete(cacheKey);
    throw error;
  });
  partitionEnsurePromises.set(cacheKey, pending);
  return pending;
}

/**
 * Drops only whole historical monthly partitions. The caller can still delete a partial
 * current month with a targeted DELETE when its configured retention is shorter than a month.
 */
export async function dropExpiredOperationalMonthlyPartitions(
  db: Queryable,
  schema: string,
  table: PartitionedOperationalTable,
  cutoff: number,
) {
  const parent = qualified(schema, table);
  const result = await db.query(
    `
      select child.relname as partition_name
      from pg_inherits
      join pg_class parent on pg_inherits.inhparent = parent.oid
      join pg_namespace parent_ns on parent.relnamespace = parent_ns.oid
      join pg_class child on pg_inherits.inhrelid = child.oid
      where parent_ns.nspname = $1 and parent.relname = $2
    `,
    [schema, table],
  );
  const cutoffMonth = startOfUtcMonth(cutoff);
  let dropped = 0;
  for (const row of result.rows) {
    const partitionName = String(row.partition_name || '');
    const matched = new RegExp(`^${table}_(\\d{4})_(\\d{2})$`).exec(partitionName);
    if (!matched) {
      continue;
    }
    const partitionStart = Date.UTC(Number(matched[1]), Number(matched[2]) - 1, 1);
    if (startOfNextUtcMonth(partitionStart) > cutoffMonth) {
      continue;
    }
    await db.query(`drop table if exists ${qualified(schema, partitionName)}`);
    dropped += 1;
  }
  return dropped;
}

/** Bounds a timestamp to a plausible partition lookup range and rejects malformed inputs early. */
export function normalizeOperationalPartitionTimestamp(value: unknown) {
  const timestamp = Math.floor(Number(value || 0));
  if (!Number.isFinite(timestamp) || timestamp <= 0 || timestamp > Date.now() + monthMs) {
    throw new Error('invalid_operational_partition_timestamp');
  }
  return timestamp;
}
