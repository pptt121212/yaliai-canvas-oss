export type PostgresConfigChannel =
  | 'control_plane'
  | 'console_catalog'
  | 'provider_registry'
  | 'canvas_users'
  | 'canvas_user_sessions';

const channelNames: Record<PostgresConfigChannel, string> = {
  control_plane: 'yali_config_control_plane',
  console_catalog: 'yali_config_console_catalog',
  provider_registry: 'yali_config_provider_registry',
  canvas_users: 'yali_canvas_users',
  canvas_user_sessions: 'yali_canvas_user_sessions',
};

type ListenerResource = {
  pool?: any;
  client?: any;
  onChange: () => Promise<void> | void;
  reconnectAttempts: number;
  reconnectTimer?: ReturnType<typeof setTimeout>;
  connecting: boolean;
};

const listenerResources = new Map<PostgresConfigChannel, ListenerResource>();

function resolveConnectionString() {
  return process.env.DATABASE_URL || '';
}

export function resolvePostgresConfigChannelName(channel: PostgresConfigChannel) {
  return channelNames[channel];
}

async function createPool(connectionString: string) {
  const pg = await import('pg');
  const PoolCtor = (pg as any).Pool;
  return new PoolCtor({ connectionString });
}

export async function notifyPostgresConfigChange(
  channel: PostgresConfigChannel,
  detail: Record<string, unknown> = {},
) {
  const connectionString = resolveConnectionString();
  if (!connectionString) {
    return;
  }
  const pool = await createPool(connectionString);
  try {
    const client = await pool.connect();
    try {
      await client.query(
        `select pg_notify($1::text, $2::text)`,
        [resolvePostgresConfigChannelName(channel), JSON.stringify({
          changedAt: Date.now(),
          ...detail,
        })],
      );
    } finally {
      client.release();
    }
  } finally {
    await pool.end().catch(() => undefined);
  }
}

export async function startPostgresConfigListener(
  channel: PostgresConfigChannel,
  onChange: () => Promise<void> | void,
) {
  if (listenerResources.has(channel)) {
    return;
  }
  const connectionString = resolveConnectionString();
  if (!connectionString) {
    return;
  }
  listenerResources.set(channel, {
    onChange,
    reconnectAttempts: 0,
    connecting: false,
  });
  await connectPostgresConfigListener(channel, true);
}

async function connectPostgresConfigListener(channel: PostgresConfigChannel, failOnError = false) {
  const resource = listenerResources.get(channel);
  if (!resource || resource.connecting) {
    return;
  }
  const connectionString = resolveConnectionString();
  if (!connectionString) {
    listenerResources.delete(channel);
    return;
  }
  resource.connecting = true;
  const pool = await createPool(connectionString);
  try {
    const client = await pool.connect();
    resource.pool = pool;
    resource.client = client;
    const channelName = resolvePostgresConfigChannelName(channel);
    await client.query(`LISTEN ${channelName}`);
    resource.reconnectAttempts = 0;
    client.on('notification', () => {
      void Promise.resolve(resource.onChange()).catch(() => undefined);
    });
    const schedule = () => {
      schedulePostgresConfigListenerReconnect(channel, pool, client);
    };
    client.on('error', schedule);
    client.on('end', schedule);
  } catch (error) {
    await pool.end().catch(() => undefined);
    if (failOnError) {
      listenerResources.delete(channel);
      throw error;
    }
    schedulePostgresConfigListenerReconnect(channel);
  } finally {
    resource.connecting = false;
  }
}

function schedulePostgresConfigListenerReconnect(channel: PostgresConfigChannel, pool?: any, client?: any) {
  const resource = listenerResources.get(channel);
  if (!resource || (client && resource.client !== client)) {
    return;
  }
  resource.client = undefined;
  resource.pool = undefined;
  resource.reconnectAttempts += 1;
  client?.removeAllListeners?.();
  try {
    client?.release?.();
  } catch {
    // The connection may already be closed; reconnect handling is best-effort.
  }
  void pool?.end?.().catch?.(() => undefined);
  if (resource.reconnectTimer) {
    return;
  }
  const delayMs = Math.min(30_000, 500 * Math.max(1, resource.reconnectAttempts));
  resource.reconnectTimer = setTimeout(() => {
    resource.reconnectTimer = undefined;
    void connectPostgresConfigListener(channel);
  }, delayMs);
}
