import type { Pool } from 'pg';

export const cnyMoneyPrecisionMigrationId = 'cny_minor_unit_v1';
const legacyCentToMinorUnitScale = 1_000;

type PgClient = {
  query: Pool['query'];
  release: () => void;
};

const moneyJsonKeys = new Set([
  'amountCents',
  'balanceAfterCents',
  'balanceCents',
  'currentBalanceCents',
  'totalCreditedCents',
  'totalDebitedCents',
  'totalChargedCredits',
  'totalVoidedCredits',
  'totalReservedCredits',
  'reservedCredits',
  'chargedCredits',
  'billedCredits',
  'fixedImageFlatPriceCents',
  'upstreamCostCents',
  'sellPriceCents',
  'charged24hCents',
  'tenantBalanceTotalCents',
  'tenantDebitedTotalCents',
]);

function scaleLegacyMoneyJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(scaleLegacyMoneyJson);
  }
  if (!value || typeof value !== 'object') {
    return value;
  }
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (moneyJsonKeys.has(key) && typeof child === 'number' && Number.isSafeInteger(child)) {
      result[key] = child * legacyCentToMinorUnitScale;
      continue;
    }
    if (moneyJsonKeys.has(key) && typeof child === 'string' && /^-?\d+$/.test(child)) {
      const numeric = Number(child);
      result[key] = Number.isSafeInteger(numeric) ? String(numeric * legacyCentToMinorUnitScale) : child;
      continue;
    }
    result[key] = scaleLegacyMoneyJson(child);
  }
  return result;
}

async function ensureMigrationTable(client: Pick<PgClient, 'query'>, schema: string) {
  await client.query(`
    create table if not exists ${schema}.schema_migrations (
      migration_id text primary key,
      applied_at bigint not null,
      detail jsonb not null default '{}'::jsonb
    )
  `);
}

async function hasMigration(client: Pick<PgClient, 'query'>, schema: string) {
  const result = await client.query(
    `select 1 from ${schema}.schema_migrations where migration_id = $1 limit 1`,
    [cnyMoneyPrecisionMigrationId],
  );
  return Boolean(result.rowCount);
}

async function hasHistoricalMoneyEntries(client: Pick<PgClient, 'query'>, schema: string) {
  const result = await client.query(`
    select exists(select 1 from ${schema}.billing_ledger limit 1)
      or exists(select 1 from ${schema}.task_master where billed_credits is not null limit 1)
      or exists(select 1 from ${schema}.tenant_credit_balances limit 1)
      or exists(select 1 from ${schema}.tenant_finance_balances limit 1)
      or exists(select 1 from ${schema}.tenant_finance_ledger limit 1) as has_legacy_data
  `);
  return Boolean(result.rows[0]?.has_legacy_data);
}

async function useMinorUnitColumns(client: Pick<PgClient, 'query'>, schema: string) {
  await client.query(`alter table ${schema}.billing_ledger alter column reserved_credits type bigint using reserved_credits::bigint`);
  await client.query(`alter table ${schema}.billing_ledger alter column charged_credits type bigint using charged_credits::bigint`);
  await client.query(`alter table ${schema}.task_master alter column billed_credits type bigint using billed_credits::bigint`);
}

async function scaleJsonColumn(input: {
  client: Pick<PgClient, 'query'>;
  schema: string;
  table: string;
  idColumn: string;
  jsonColumn: string;
}) {
  const rows = await input.client.query(
    `select ${input.idColumn} as id, ${input.jsonColumn} as payload from ${input.schema}.${input.table}`,
  );
  for (const row of rows.rows) {
    const payload = scaleLegacyMoneyJson(row.payload);
    await input.client.query(
      `update ${input.schema}.${input.table} set ${input.jsonColumn} = $2::jsonb where ${input.idColumn} = $1`,
      [row.id, JSON.stringify(payload)],
    );
  }
}

async function scaleHistoricalJsonColumns(client: Pick<PgClient, 'query'>, schema: string) {
  await scaleJsonColumn({ client, schema, table: 'billing_ledger', idColumn: 'id', jsonColumn: 'detail' });
  await scaleJsonColumn({ client, schema, table: 'tenant_finance_ledger', idColumn: 'id', jsonColumn: 'detail' });
  await scaleJsonColumn({ client, schema, table: 'audit_logs', idColumn: 'id', jsonColumn: 'detail' });
  await scaleJsonColumn({ client, schema, table: 'task_master', idColumn: 'task_id', jsonColumn: 'request_payload' });
  await scaleJsonColumn({ client, schema, table: 'task_master', idColumn: 'task_id', jsonColumn: 'response_payload' });
  await scaleJsonColumn({ client, schema, table: 'task_master', idColumn: 'task_id', jsonColumn: 'error_payload' });
  await scaleJsonColumn({ client, schema, table: 'request_traces', idColumn: 'trace_id', jsonColumn: 'downstream_request' });
  await scaleJsonColumn({ client, schema, table: 'request_traces', idColumn: 'trace_id', jsonColumn: 'downstream_response' });
  await scaleJsonColumn({ client, schema, table: 'request_traces', idColumn: 'trace_id', jsonColumn: 'upstream_request' });
  await scaleJsonColumn({ client, schema, table: 'request_traces', idColumn: 'trace_id', jsonColumn: 'upstream_response' });
  await scaleJsonColumn({ client, schema, table: 'request_traces', idColumn: 'trace_id', jsonColumn: 'error_payload' });
  await scaleJsonColumn({ client, schema, table: 'operational_outbox_events', idColumn: 'event_id', jsonColumn: 'payload' });
}

export type CnyMoneyPrecisionMigrationResult = {
  applied: boolean;
  legacyDataMigrated: boolean;
};

/** Converts former integer cents to integer 0.00001-yuan minor units. */
export async function migrateCnyMoneyPrecision(pool: Pool, schema: string): Promise<CnyMoneyPrecisionMigrationResult> {
  const client = await (pool as unknown as { connect: () => Promise<PgClient> }).connect();
  try {
    await client.query('begin');
    await client.query(`select pg_advisory_xact_lock(hashtextextended($1, 0))`, [cnyMoneyPrecisionMigrationId]);
    await ensureMigrationTable(client, schema);
    if (await hasMigration(client, schema)) {
      await client.query('commit');
      return { applied: false, legacyDataMigrated: false };
    }

    const hasLegacyData = await hasHistoricalMoneyEntries(client, schema);
    await useMinorUnitColumns(client, schema);
    if (hasLegacyData) {
      await client.query(`update ${schema}.billing_ledger set reserved_credits = reserved_credits * ${legacyCentToMinorUnitScale}, charged_credits = charged_credits * ${legacyCentToMinorUnitScale}`);
      await client.query(`update ${schema}.task_master set billed_credits = billed_credits * ${legacyCentToMinorUnitScale} where billed_credits is not null`);
      await client.query(`
        update ${schema}.tenant_credit_balances
        set total_charged_credits = total_charged_credits * ${legacyCentToMinorUnitScale},
            total_voided_credits = total_voided_credits * ${legacyCentToMinorUnitScale},
            total_reserved_credits = total_reserved_credits * ${legacyCentToMinorUnitScale}
      `);
      await client.query(`
        update ${schema}.tenant_finance_balances
        set balance_cents = balance_cents * ${legacyCentToMinorUnitScale},
            total_credited_cents = total_credited_cents * ${legacyCentToMinorUnitScale},
            total_debited_cents = total_debited_cents * ${legacyCentToMinorUnitScale}
      `);
      await client.query(`
        update ${schema}.tenant_finance_ledger
        set amount_cents = amount_cents * ${legacyCentToMinorUnitScale},
            balance_after_cents = balance_after_cents * ${legacyCentToMinorUnitScale}
      `);
      await scaleHistoricalJsonColumns(client, schema);
    }

    // All persisted aggregate payloads are derived from the old scale and must be rebuilt.
    await client.query(`delete from ${schema}.operational_metric_rollups`);
    await client.query(`delete from ${schema}.operational_metric_snapshots`);
    await client.query(`delete from ${schema}.operational_rollup_jobs`);
    await client.query(
      `insert into ${schema}.schema_migrations (migration_id, applied_at, detail) values ($1, $2, $3::jsonb)`,
      [cnyMoneyPrecisionMigrationId, Date.now(), JSON.stringify({ legacyCentToMinorUnitScale, legacyDataMigrated: hasLegacyData })],
    );
    await client.query('commit');
    return { applied: true, legacyDataMigrated: hasLegacyData };
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Prevents a process from reading legacy-cent records as minor units. */
export async function ensureCnyMoneyPrecisionReady(pool: Pool, schema: string) {
  const client = await (pool as unknown as { connect: () => Promise<PgClient> }).connect();
  try {
    await client.query('begin');
    await client.query(`select pg_advisory_xact_lock(hashtextextended($1, 0))`, [cnyMoneyPrecisionMigrationId]);
    await ensureMigrationTable(client, schema);
    if (await hasMigration(client, schema)) {
      await client.query('commit');
      return;
    }
    if (await hasHistoricalMoneyEntries(client, schema)) {
      throw new Error('cny_money_precision_migration_required');
    }
    await useMinorUnitColumns(client, schema);
    await client.query(
      `insert into ${schema}.schema_migrations (migration_id, applied_at, detail) values ($1, $2, $3::jsonb)`,
      [cnyMoneyPrecisionMigrationId, Date.now(), JSON.stringify({ legacyCentToMinorUnitScale: 1, legacyDataMigrated: false })],
    );
    await client.query('commit');
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
