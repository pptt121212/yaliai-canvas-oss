import type { Pool } from 'pg';

export const cnyMoneyPrecisionMigrationId = 'cny_minor_unit_v1';
const legacyScale = 1_000;

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
      result[key] = child * legacyScale;
      continue;
    }
    if (moneyJsonKeys.has(key) && typeof child === 'string' && /^-?\d+$/.test(child)) {
      const numeric = Number(child);
      result[key] = Number.isSafeInteger(numeric) ? String(numeric * legacyScale) : child;
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

async function tableExists(client: Pick<PgClient, 'query'>, schema: string, table: string) {
  const result = await client.query(`select to_regclass($1) as table_name`, [`${schema}.${table}`]);
  return Boolean(result.rows[0]?.table_name);
}

async function hasHistoricalMoneyEntries(client: Pick<PgClient, 'query'>, schema: string) {
  const result = await client.query(`
    select exists(
      select 1 from ${schema}.billing_ledger limit 1
    ) or exists(
      select 1 from ${schema}.task_master where billed_credits is not null limit 1
    ) or exists(
      select 1 from ${schema}.tenant_credit_balances limit 1
    ) or exists(
      select 1 from ${schema}.tenant_finance_balances limit 1
    ) or exists(
      select 1 from ${schema}.tenant_finance_ledger limit 1
    ) as has_legacy_data
  `);
  return Boolean(result.rows[0]?.has_legacy_data);
}

async function hasLegacyChatCostConfiguration(client: Pick<PgClient, 'query'>, schema: string) {
  if (!await tableExists(client, schema, 'console_catalog')) {
    return false;
  }
  const catalog = await client.query(`select payload from ${schema}.console_catalog`);
  for (const row of catalog.rows) {
    const payload = row.payload && typeof row.payload === 'object' ? row.payload as Record<string, unknown> : {};
    const channels = Array.isArray(payload.channels) ? payload.channels : [];
    for (const channel of channels) {
      const policies = channel && typeof channel === 'object' && !Array.isArray(channel)
        ? (channel as Record<string, unknown>).upstreamPolicies
        : [];
      for (const policy of Array.isArray(policies) ? policies : []) {
        const pricing = policy && typeof policy === 'object' && !Array.isArray(policy)
          ? (policy as Record<string, unknown>).pricing
          : null;
        const chatUnit = pricing && typeof pricing === 'object' && !Array.isArray(pricing)
          ? Number((pricing as Record<string, unknown>).chatUnit)
          : 0;
        if (Number.isFinite(chatUnit) && chatUnit > 0) {
          return true;
        }
      }
    }
  }
  return false;
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

async function migrateChatUpstreamCosts(client: Pick<PgClient, 'query'>, schema: string) {
  if (!await tableExists(client, schema, 'console_catalog')) {
    return;
  }
  const rows = await client.query(`select id, payload from ${schema}.console_catalog`);
  for (const row of rows.rows) {
    const payload = row.payload && typeof row.payload === 'object' ? row.payload as Record<string, unknown> : {};
    const channels = Array.isArray(payload.channels) ? payload.channels : [];
    const nextChannels = channels.map((channel) => {
      if (!channel || typeof channel !== 'object' || Array.isArray(channel)) {
        return channel;
      }
      const current = channel as Record<string, unknown>;
      const policies = Array.isArray(current.upstreamPolicies) ? current.upstreamPolicies : [];
      return {
        ...current,
        upstreamPolicies: policies.map((policy) => {
          if (!policy || typeof policy !== 'object' || Array.isArray(policy)) {
            return policy;
          }
          const policyRecord = policy as Record<string, unknown>;
          const pricing = policyRecord.pricing && typeof policyRecord.pricing === 'object' && !Array.isArray(policyRecord.pricing)
            ? policyRecord.pricing as Record<string, unknown>
            : null;
          const legacyChatUnit = Number(pricing?.chatUnit);
          if (!pricing || !Number.isFinite(legacyChatUnit)) {
            return policyRecord;
          }
          return {
            ...policyRecord,
            pricing: {
              ...pricing,
              // Before this migration chatUnit was an integer number of cents. It is now yuan, like image costs.
              chatUnit: legacyChatUnit / 100,
            },
          };
        }),
      };
    });
    await client.query(
      `update ${schema}.console_catalog set payload = $2::jsonb, updated_at = now() where id = $1`,
      [row.id, JSON.stringify({ ...payload, channels: nextChannels })],
    );
  }
}

export type CnyMoneyPrecisionMigrationResult = {
  applied: boolean;
  legacyDataMigrated: boolean;
};

/**
 * Converts the former integer-cent ledger to integer 0.00001-yuan units.
 * Run this while all API processes are stopped, before starting the new version.
 */
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

    await client.query(`alter table ${schema}.billing_ledger alter column reserved_credits type bigint using reserved_credits::bigint`);
    await client.query(`alter table ${schema}.billing_ledger alter column charged_credits type bigint using charged_credits::bigint`);
    await client.query(`alter table ${schema}.task_master alter column billed_credits type bigint using billed_credits::bigint`);

    const historicalMoneyEntries = await hasHistoricalMoneyEntries(client, schema);
    const legacyChatCostConfiguration = await hasLegacyChatCostConfiguration(client, schema);
    const legacyDataMigrated = historicalMoneyEntries || legacyChatCostConfiguration;
    if (historicalMoneyEntries) {
      await client.query(`update ${schema}.billing_ledger set reserved_credits = reserved_credits * ${legacyScale}, charged_credits = charged_credits * ${legacyScale}`);
      await client.query(`update ${schema}.task_master set billed_credits = billed_credits * ${legacyScale} where billed_credits is not null`);
      await client.query(`
        update ${schema}.tenant_credit_balances
        set total_charged_credits = total_charged_credits * ${legacyScale},
            total_voided_credits = total_voided_credits * ${legacyScale},
            total_reserved_credits = total_reserved_credits * ${legacyScale}
      `);
      await client.query(`
        update ${schema}.tenant_finance_balances
        set balance_cents = balance_cents * ${legacyScale},
            total_credited_cents = total_credited_cents * ${legacyScale},
            total_debited_cents = total_debited_cents * ${legacyScale}
      `);
      await client.query(`
        update ${schema}.tenant_finance_ledger
        set amount_cents = amount_cents * ${legacyScale},
            balance_after_cents = balance_after_cents * ${legacyScale}
      `);
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
    await migrateChatUpstreamCosts(client, schema);

    // Snapshots contain aggregated legacy units and must never be mixed with the new scale.
    await client.query(`delete from ${schema}.operational_metric_rollups`);
    await client.query(`delete from ${schema}.operational_metric_snapshots`);
    await client.query(
      `insert into ${schema}.schema_migrations (migration_id, applied_at, detail) values ($1, $2, $3::jsonb)`,
      [cnyMoneyPrecisionMigrationId, Date.now(), JSON.stringify({ legacyScale, legacyDataMigrated })],
    );
    await client.query('commit');
    return { applied: true, legacyDataMigrated };
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Marks a pristine database as already using the canonical money scale. */
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
    if (await hasHistoricalMoneyEntries(client, schema) || await hasLegacyChatCostConfiguration(client, schema)) {
      throw new Error('cny_money_precision_migration_required');
    }
    await client.query(
      `insert into ${schema}.schema_migrations (migration_id, applied_at, detail) values ($1, $2, $3::jsonb)`,
      [cnyMoneyPrecisionMigrationId, Date.now(), JSON.stringify({ legacyScale: 1, legacyDataMigrated: false })],
    );
    await client.query('commit');
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
