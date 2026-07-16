export function hasDatabaseUrl() {
  return Boolean(String(process.env.DATABASE_URL || '').trim());
}

export function requireDatabaseUrl(feature: string) {
  if (!hasDatabaseUrl()) {
    throw new Error(`${feature}_requires_database_url`);
  }
}
