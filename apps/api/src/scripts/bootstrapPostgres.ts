import { Pool } from 'pg';

function requireEnv(name: string) {
  const value = String(process.env[name] || '').trim();
  if (!value) {
    throw new Error(`${name}_required`);
  }
  return value;
}

async function ensureJsonbRecordTable(pool: Pool, schema: string, tableName: string) {
  await pool.query(`create schema if not exists ${schema}`);
  await pool.query(`
    create table if not exists ${schema}.${tableName} (
      id text primary key,
      payload jsonb not null,
      updated_at timestamptz not null default now()
    )
  `);
}

async function ensureOperationalTables(pool: Pool, schema: string) {
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
      reserved_credits integer not null,
      charged_credits integer not null,
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
      billed_credits integer
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
      note text not null
    )
  `);
}

async function main() {
  const connectionString = requireEnv('DATABASE_URL');
  const schema = String(process.env.PG_SCHEMA || 'public').trim() || 'public';
  const pool = new Pool({ connectionString, max: 2 });

  try {
    await ensureJsonbRecordTable(pool, schema, 'control_plane_config');
    await ensureJsonbRecordTable(pool, schema, 'console_catalog');
    await ensureJsonbRecordTable(pool, schema, 'provider_registry');
    await ensureJsonbRecordTable(pool, schema, 'admin_sessions');
    await ensureJsonbRecordTable(pool, schema, 'canvas_users');
    await ensureJsonbRecordTable(pool, schema, 'canvas_user_sessions');
    await ensureOperationalTables(pool, schema);
    console.log(`postgres bootstrap complete: schema=${schema}`);
  } finally {
    await (pool as unknown as { end: () => Promise<void> }).end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
