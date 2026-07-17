import { Pool } from 'pg';
import { migrateCnyMoneyPrecision } from '../modules/storage/moneyPrecisionMigration.js';

function requireEnv(name: string) {
  const value = String(process.env[name] || '').trim();
  if (!value) {
    throw new Error(`${name}_required`);
  }
  return value;
}

async function main() {
  const pool = new Pool({ connectionString: requireEnv('DATABASE_URL'), max: 2 });
  const schema = String(process.env.PG_SCHEMA || 'public').trim() || 'public';
  try {
    const result = await migrateCnyMoneyPrecision(pool, schema);
    console.log(JSON.stringify(result));
  } finally {
    await (pool as unknown as { end: () => Promise<void> }).end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
