import { createPostgresOperationalRepository } from './postgresRepositories.js';
import { requireDatabaseUrl } from './storageMode.js';
import type { AsyncOperationalRepository } from './repositoryContracts.js';

requireDatabaseUrl('operational_store');

export const operationalRepository: AsyncOperationalRepository = createPostgresOperationalRepository({
  connectionString: process.env.DATABASE_URL,
  schema: process.env.PG_SCHEMA || 'public',
});
