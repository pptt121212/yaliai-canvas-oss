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
  };
}
