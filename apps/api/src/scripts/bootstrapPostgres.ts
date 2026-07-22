import { Pool } from 'pg';
import { ensureOperationalSchemaForPool } from '../modules/storage/postgresRepositories.js';

function requireEnv(name: string) {
  const value = String(process.env[name] || '').trim();
  if (!value) {
    throw new Error(`${name}_required`);
  }
  return value;
}

function assertSchema(value: string) {
  if (!/^[a-z_][a-z0-9_]*$/i.test(value)) {
    throw new Error('invalid_pg_schema');
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

async function main() {
  const connectionString = requireEnv('DATABASE_URL');
  const schema = assertSchema(String(process.env.PG_SCHEMA || 'public').trim() || 'public');
  const pool = new Pool({ connectionString, max: 2 });

  try {
    for (const table of [
      'control_plane_config',
      'console_catalog',
      'provider_registry',
      'admin_sessions',
      'canvas_users',
      'canvas_user_sessions',
    ]) {
      await ensureJsonbRecordTable(pool, schema, table);
    }
    await ensureOperationalSchemaForPool(pool, schema);
    console.log(`postgres bootstrap complete: schema=${schema}`);
  } finally {
    await (pool as unknown as { end: () => Promise<void> }).end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
