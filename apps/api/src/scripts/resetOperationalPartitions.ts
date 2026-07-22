import { Pool } from 'pg';
import { ensureOperationalSchemaForPool } from '../modules/storage/postgresRepositories.js';

function requireEnv(name: string) {
  const value = String(process.env[name] || '').trim();
  if (!value) {
    throw new Error(`${name}_required`);
  }
  return value;
}

function assertExplicitConfirmation() {
  if (process.env.OPERATIONAL_PARTITION_RESET_CONFIRM !== 'RESET_OPERATIONAL_DETAILS') {
    throw new Error('set_OPERATIONAL_PARTITION_RESET_CONFIRM_to_RESET_OPERATIONAL_DETAILS');
  }
}

function assertSchema(value: string) {
  if (!/^[a-z_][a-z0-9_]*$/i.test(value)) {
    throw new Error('invalid_pg_schema');
  }
  return value;
}

/**
 * One-time schema cutover for the new system.
 *
 * This deliberately resets only high-volume operational detail. Tenant balances remain
 * authoritative in tenant_finance_balances and tenant_credit_balances, so a detail reset
 * cannot alter available account funds. Run it before starting the version with partitioned
 * operational tables; it is intentionally not a rolling compatibility migration.
 */
async function main() {
  assertExplicitConfirmation();
  const connectionString = requireEnv('DATABASE_URL');
  const schema = assertSchema(String(process.env.PG_SCHEMA || 'public').trim() || 'public');
  const pool = new Pool({ connectionString, max: 2 });

  try {
    await pool.query('begin');
    for (const table of [
      'request_trace_index',
      'billing_ledger_index',
      'task_master_index',
      'tenant_finance_ledger_index',
      'request_traces',
      'billing_ledger',
      'task_master',
      'tenant_finance_ledger',
    ]) {
      await pool.query(`drop table if exists ${schema}.${table} cascade`);
    }
    await pool.query('commit');
    await ensureOperationalSchemaForPool(pool, schema);
    console.log(JSON.stringify({
      ok: true,
      schema,
      reset: ['request_traces', 'billing_ledger', 'task_master', 'tenant_finance_ledger'],
      preserved: ['tenant_credit_balances', 'tenant_finance_balances', 'audit_logs'],
    }));
  } catch (error) {
    await pool.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    await (pool as unknown as { end: () => Promise<void> }).end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
