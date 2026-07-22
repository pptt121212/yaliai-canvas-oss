import { randomUUID } from 'node:crypto';
import { createClient, type RedisClientType } from 'redis';
import type { ConcurrencyCounterState, RateLimitBucketState } from './repositoryContracts.js';

type RedisAtomicCounterOptions = {
  url?: string;
  prefix?: string;
};

export type AtomicRateLimitResult = {
  allowed: boolean;
  scope: 'tenant' | 'api_key' | null;
  state: RateLimitBucketState | null;
};

export type AtomicConcurrencyResult = {
  allowed: boolean;
  state: ConcurrencyCounterState | null;
};

export type AtomicConcurrencyLease = {
  key: string;
  leaseId: string;
  ttlSeconds: number;
};

export type AtomicConcurrencyLeaseResult = AtomicConcurrencyResult & {
  lease: AtomicConcurrencyLease | null;
};

const rateLimitScript = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
local window_ms = tonumber(ARGV[3])
local ttl_seconds = tonumber(ARGV[4])
local current = redis.call('GET', key)
local count = 0
local window_started = now
local window_ends = now + window_ms
local blocked_until = 0

if current then
  local decoded = cjson.decode(current)
  count = tonumber(decoded.requestCount or 0)
  window_started = tonumber(decoded.windowStartedAt or now)
  window_ends = tonumber(decoded.windowEndsAt or 0)
  blocked_until = tonumber(decoded.blockedUntil or 0)
  if window_ends <= now then
    count = 0
    window_started = now
    window_ends = now + window_ms
    blocked_until = 0
  end
end

count = count + 1
local state = {
  key = ARGV[5],
  limit = limit,
  windowStartedAt = window_started,
  windowEndsAt = window_ends,
  requestCount = count,
  updatedAt = now
}
if blocked_until > now then
  state.blockedUntil = blocked_until
end

redis.call('SET', key, cjson.encode(state), 'EX', ttl_seconds)
local allowed = 0
if count <= limit and blocked_until <= now then
  allowed = 1
end
return { allowed, cjson.encode(state) }
`;

const dualRateLimitScript = `
local now = tonumber(ARGV[1])
local window_ms = tonumber(ARGV[2])
local ttl_seconds = tonumber(ARGV[3])
local tenant_key_label = ARGV[4]
local tenant_limit = tonumber(ARGV[5])
local api_key_label = ARGV[6]
local api_key_limit = tonumber(ARGV[7])

local function build_state(redis_key, key_label, limit)
  if redis_key == '' or limit <= 0 then
    return nil, true
  end
  local current = redis.call('GET', redis_key)
  local count = 0
  local window_started = now
  local window_ends = now + window_ms
  local blocked_until = 0
  if current then
    local decoded = cjson.decode(current)
    count = tonumber(decoded.requestCount or 0)
    window_started = tonumber(decoded.windowStartedAt or now)
    window_ends = tonumber(decoded.windowEndsAt or 0)
    blocked_until = tonumber(decoded.blockedUntil or 0)
    if window_ends <= now then
      count = 0
      window_started = now
      window_ends = now + window_ms
      blocked_until = 0
    end
  end
  local state = {
    key = key_label,
    limit = limit,
    windowStartedAt = window_started,
    windowEndsAt = window_ends,
    requestCount = count + 1,
    updatedAt = now
  }
  if blocked_until > now then
    state.blockedUntil = blocked_until
  end
  local allowed = state.requestCount <= limit and blocked_until <= now
  return state, allowed
end

local tenant_state, tenant_allowed = build_state(KEYS[1], tenant_key_label, tenant_limit)
if not tenant_allowed then
  return { 0, 'tenant', tenant_state and cjson.encode(tenant_state) or '' }
end

local api_key_state, api_key_allowed = build_state(KEYS[2], api_key_label, api_key_limit)
if not api_key_allowed then
  return { 0, 'api_key', api_key_state and cjson.encode(api_key_state) or '' }
end

if tenant_state then
  redis.call('SET', KEYS[1], cjson.encode(tenant_state), 'EX', ttl_seconds)
end
if api_key_state then
  redis.call('SET', KEYS[2], cjson.encode(api_key_state), 'EX', ttl_seconds)
end

return { 1, '', '' }
`;

const acquireConcurrencyScript = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local max = tonumber(ARGV[2])
local ttl_seconds = tonumber(ARGV[3])
local current = redis.call('GET', key)
local count = 0
if current then
  local decoded = cjson.decode(current)
  count = tonumber(decoded.current or 0)
end
local next_count = count + 1
if next_count > max then
  if current then
    return { 0, current }
  end
  local empty_state = {
    key = ARGV[4],
    current = count,
    max = max,
    updatedAt = now,
    expiresAt = now + ttl_seconds * 1000
  }
  return { 0, cjson.encode(empty_state) }
end
local state = {
  key = ARGV[4],
  current = next_count,
  max = max,
  updatedAt = now,
  expiresAt = now + ttl_seconds * 1000
}
redis.call('SET', key, cjson.encode(state), 'EX', ttl_seconds)
return { 1, cjson.encode(state) }
`;

const releaseConcurrencyScript = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local ttl_seconds = tonumber(ARGV[2])
local current = redis.call('GET', key)
if not current then
  return nil
end
local decoded = cjson.decode(current)
local next_count = tonumber(decoded.current or 0) - 1
if next_count <= 0 then
  redis.call('DEL', key)
  decoded.current = 0
  decoded.updatedAt = now
  return cjson.encode(decoded)
end
decoded.current = next_count
decoded.updatedAt = now
decoded.expiresAt = now + ttl_seconds * 1000
redis.call('SET', key, cjson.encode(decoded), 'EX', ttl_seconds)
return cjson.encode(decoded)
`;

// A lease is independent from every other request. Unlike the legacy shared
// counter, an abandoned request can expire without extending unrelated work.
const acquireConcurrencyLeaseScript = `
local lease_key = KEYS[1]
local legacy_key = KEYS[2]
local now = tonumber(ARGV[1])
local max = tonumber(ARGV[2])
local lease_id = ARGV[3]
local ttl_ms = tonumber(ARGV[4])
local ttl_seconds = tonumber(ARGV[5])

redis.call('ZREMRANGEBYSCORE', lease_key, '-inf', now)
local lease_count = redis.call('ZCARD', lease_key)
local legacy_count = 0
local legacy = redis.call('GET', legacy_key)
if legacy then
  local decoded = cjson.decode(legacy)
  legacy_count = tonumber(decoded.current or 0)
end

if lease_count + legacy_count >= max then
  return { 0, lease_count + legacy_count }
end

redis.call('ZADD', lease_key, now + ttl_ms, lease_id)
redis.call('EXPIRE', lease_key, ttl_seconds)
return { 1, lease_count + legacy_count + 1 }
`;

const renewConcurrencyLeaseScript = `
local lease_key = KEYS[1]
local legacy_key = KEYS[2]
local now = tonumber(ARGV[1])
local lease_id = ARGV[2]
local ttl_ms = tonumber(ARGV[3])
local ttl_seconds = tonumber(ARGV[4])

redis.call('ZREMRANGEBYSCORE', lease_key, '-inf', now)
local current_expiry = redis.call('ZSCORE', lease_key, lease_id)
local lease_count = redis.call('ZCARD', lease_key)
local legacy_count = 0
local legacy = redis.call('GET', legacy_key)
if legacy then
  local decoded = cjson.decode(legacy)
  legacy_count = tonumber(decoded.current or 0)
end

if not current_expiry then
  return { 0, lease_count + legacy_count }
end

redis.call('ZADD', lease_key, now + ttl_ms, lease_id)
redis.call('EXPIRE', lease_key, ttl_seconds)
return { 1, lease_count + legacy_count }
`;

const releaseConcurrencyLeaseScript = `
local lease_key = KEYS[1]
local legacy_key = KEYS[2]
local now = tonumber(ARGV[1])
local lease_id = ARGV[2]

redis.call('ZREMRANGEBYSCORE', lease_key, '-inf', now)
redis.call('ZREM', lease_key, lease_id)
local lease_count = redis.call('ZCARD', lease_key)
if lease_count <= 0 then
  redis.call('DEL', lease_key)
end
local legacy_count = 0
local legacy = redis.call('GET', legacy_key)
if legacy then
  local decoded = cjson.decode(legacy)
  legacy_count = tonumber(decoded.current or 0)
end
return lease_count + legacy_count
`;

const inspectConcurrencyLeasesScript = `
local now = tonumber(ARGV[1])
local result = {}
for index = 1, #KEYS, 2 do
  local lease_key = KEYS[index]
  local legacy_key = KEYS[index + 1]
  redis.call('ZREMRANGEBYSCORE', lease_key, '-inf', now)
  local lease_count = redis.call('ZCARD', lease_key)
  local legacy_count = 0
  local legacy_expiry = 0
  local legacy = redis.call('GET', legacy_key)
  if legacy then
    local decoded = cjson.decode(legacy)
    legacy_count = tonumber(decoded.current or 0)
    legacy_expiry = tonumber(decoded.expiresAt or 0)
  end
  local lease_expiry = 0
  local newest = redis.call('ZREVRANGE', lease_key, 0, 0, 'WITHSCORES')
  if newest and newest[2] then
    lease_expiry = tonumber(newest[2])
  end
  table.insert(result, lease_count + legacy_count)
  table.insert(result, math.max(lease_expiry, legacy_expiry))
end
return result
`;

function buildKey(prefix: string, section: string, id: string) {
  return `${prefix}:${section}:${id}`;
}

function parseState<T>(raw: unknown): T | null {
  if (typeof raw !== 'string' || !raw) {
    return null;
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

async function ensureConnected(client: RedisClientType) {
  if (!client.isOpen) {
    await client.connect();
  }
}

export function createRedisAtomicCounters(options: RedisAtomicCounterOptions = {}) {
  const client = createClient({
    url: options.url || process.env.REDIS_URL || undefined,
  });
  const prefix = options.prefix || 'yali';

  return {
    enabled: true,
    async consumeRateLimit(key: string, limit: number, windowSeconds: number): Promise<AtomicRateLimitResult> {
      await ensureConnected(client);
      const now = Date.now();
      const windowMs = Math.max(1, windowSeconds) * 1000;
      const ttlSeconds = Math.max(1, Math.ceil(windowMs / 1000) + 5);
      const response = await client.sendCommand([
        'EVAL',
        rateLimitScript,
        '1',
        buildKey(prefix, 'rate_limit', key),
        String(now),
        String(Math.max(1, Math.floor(limit))),
        String(windowMs),
        String(ttlSeconds),
        key,
      ]) as unknown[];
      const allowed = Number(response?.[0] || 0) === 1;
      const state = parseState<RateLimitBucketState>(response?.[1]);
      return { allowed, scope: allowed ? null : 'api_key', state };
    },
    async consumeDualRateLimit(input: {
      tenantKey: string | null;
      tenantLimit: number;
      apiKeyKey: string | null;
      apiKeyLimit: number;
      windowSeconds: number;
    }): Promise<AtomicRateLimitResult> {
      await ensureConnected(client);
      const now = Date.now();
      const windowMs = Math.max(1, input.windowSeconds) * 1000;
      const ttlSeconds = Math.max(1, Math.ceil(windowMs / 1000) + 5);
      const tenantKey = input.tenantKey ? buildKey(prefix, 'rate_limit', input.tenantKey) : '';
      const apiKeyKey = input.apiKeyKey ? buildKey(prefix, 'rate_limit', input.apiKeyKey) : '';
      const response = await client.sendCommand([
        'EVAL',
        dualRateLimitScript,
        '2',
        tenantKey,
        apiKeyKey,
        String(now),
        String(windowMs),
        String(ttlSeconds),
        input.tenantKey || '',
        String(Math.max(0, Math.floor(input.tenantLimit))),
        input.apiKeyKey || '',
        String(Math.max(0, Math.floor(input.apiKeyLimit))),
      ]) as unknown[];
      const allowed = Number(response?.[0] || 0) === 1;
      const scope = response?.[1] === 'tenant' || response?.[1] === 'api_key' ? response[1] : null;
      const state = parseState<RateLimitBucketState>(response?.[2]);
      return { allowed, scope, state };
    },
    async acquireConcurrency(key: string, max: number, ttlSeconds = 300): Promise<AtomicConcurrencyResult> {
      await ensureConnected(client);
      const now = Date.now();
      const normalizedTtlSeconds = Math.max(1, Math.floor(ttlSeconds));
      const response = await client.sendCommand([
        'EVAL',
        acquireConcurrencyScript,
        '1',
        buildKey(prefix, 'concurrency', key),
        String(now),
        String(Math.max(1, Math.floor(max))),
        String(normalizedTtlSeconds),
        key,
      ]) as unknown[];
      const allowed = Number(response?.[0] || 0) === 1;
      const state = parseState<ConcurrencyCounterState>(response?.[1]);
      return { allowed, state };
    },
    async releaseConcurrency(key: string, ttlSeconds = 60): Promise<ConcurrencyCounterState | null> {
      await ensureConnected(client);
      const now = Date.now();
      const response = await client.sendCommand([
        'EVAL',
        releaseConcurrencyScript,
        '1',
        buildKey(prefix, 'concurrency', key),
        String(now),
        String(Math.max(1, Math.floor(ttlSeconds))),
      ]);
      return parseState<ConcurrencyCounterState>(response);
    },
    async acquireConcurrencyLease(key: string, max: number, ttlSeconds = 90, leaseId = randomUUID()): Promise<AtomicConcurrencyLeaseResult> {
      await ensureConnected(client);
      const now = Date.now();
      const normalizedTtlSeconds = Math.max(5, Math.floor(ttlSeconds));
      const response = await client.sendCommand([
        'EVAL',
        acquireConcurrencyLeaseScript,
        '2',
        buildKey(prefix, 'concurrency_lease', key),
        buildKey(prefix, 'concurrency', key),
        String(now),
        String(Math.max(1, Math.floor(max))),
        leaseId,
        String(normalizedTtlSeconds * 1000),
        String(normalizedTtlSeconds + 5),
      ]) as unknown[];
      const allowed = Number(response?.[0] || 0) === 1;
      const current = Math.max(0, Number(response?.[1] || 0));
      return {
        allowed,
        lease: allowed ? { key, leaseId, ttlSeconds: normalizedTtlSeconds } : null,
        state: {
          key,
          current,
          max: Math.max(1, Math.floor(max)),
          updatedAt: now,
          expiresAt: now + normalizedTtlSeconds * 1000,
        },
      };
    },
    async renewConcurrencyLease(lease: AtomicConcurrencyLease): Promise<AtomicConcurrencyResult> {
      await ensureConnected(client);
      const now = Date.now();
      const ttlSeconds = Math.max(5, Math.floor(lease.ttlSeconds));
      const response = await client.sendCommand([
        'EVAL',
        renewConcurrencyLeaseScript,
        '2',
        buildKey(prefix, 'concurrency_lease', lease.key),
        buildKey(prefix, 'concurrency', lease.key),
        String(now),
        lease.leaseId,
        String(ttlSeconds * 1000),
        String(ttlSeconds + 5),
      ]) as unknown[];
      const allowed = Number(response?.[0] || 0) === 1;
      return {
        allowed,
        state: {
          key: lease.key,
          current: Math.max(0, Number(response?.[1] || 0)),
          max: 0,
          updatedAt: now,
          expiresAt: now + ttlSeconds * 1000,
        },
      };
    },
    async releaseConcurrencyLease(lease: AtomicConcurrencyLease): Promise<ConcurrencyCounterState> {
      await ensureConnected(client);
      const now = Date.now();
      const response = await client.sendCommand([
        'EVAL',
        releaseConcurrencyLeaseScript,
        '2',
        buildKey(prefix, 'concurrency_lease', lease.key),
        buildKey(prefix, 'concurrency', lease.key),
        String(now),
        lease.leaseId,
      ]);
      return {
        key: lease.key,
        current: Math.max(0, Number(response || 0)),
        max: 0,
        updatedAt: now,
        expiresAt: now,
      };
    },
    async inspectConcurrencyLeases(keys: string[]): Promise<Array<{ key: string; state: ConcurrencyCounterState }>> {
      await ensureConnected(client);
      const uniqueKeys = Array.from(new Set(keys.map((key) => String(key || '').trim()).filter(Boolean)));
      if (!uniqueKeys.length) {
        return [];
      }
      const redisKeys = uniqueKeys.flatMap((key) => [
        buildKey(prefix, 'concurrency_lease', key),
        buildKey(prefix, 'concurrency', key),
      ]);
      const now = Date.now();
      const response = await client.sendCommand([
        'EVAL',
        inspectConcurrencyLeasesScript,
        String(redisKeys.length),
        ...redisKeys,
        String(now),
      ]) as unknown[];
      return uniqueKeys.map((key, index) => ({
        key,
        state: {
          key,
          current: Math.max(0, Number(response?.[index * 2] || 0)),
          max: 0,
          updatedAt: now,
          expiresAt: Math.max(0, Number(response?.[index * 2 + 1] || 0)),
        },
      }));
    },
    async close() {
      if (client.isOpen) {
        await (client as RedisClientType & { close(): Promise<void> }).close();
      }
    },
  };
}
