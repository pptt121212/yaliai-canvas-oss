import type { HotStateStore, ProviderHealthSnapshot, RateLimitBucketState } from './repositoryContracts.js';

export function createRateLimitService(store: HotStateStore) {
  return {
    inspect(key: string) {
      return store.getRateLimitBucket(key);
    },
    consume(key: string, limit: number, windowSeconds: number) {
      const now = Date.now();
      const current = store.getRateLimitBucket(key);
      const windowMs = windowSeconds * 1000;

      let next: RateLimitBucketState;
      if (!current || current.windowEndsAt <= now) {
        next = {
          key,
          limit,
          windowStartedAt: now,
          windowEndsAt: now + windowMs,
          requestCount: 1,
          updatedAt: now,
        };
      } else {
        next = {
          ...current,
          limit,
          requestCount: current.requestCount + 1,
          updatedAt: now,
        };
      }

      store.setRateLimitBucket(key, next, Math.max(1, Math.ceil((next.windowEndsAt - now) / 1000)));
      return {
        allowed: next.requestCount <= limit && !(next.blockedUntil && next.blockedUntil > now),
        state: next,
      };
    },
    clear(key: string) {
      store.deleteRateLimitBucket(key);
    },
  };
}

export function createConcurrencyService(store: HotStateStore) {
  return {
    get(key: string) {
      return store.getConcurrencyCounter(key);
    },
    acquire(key: string, max: number, ttlSeconds = 300) {
      const current = store.getConcurrencyCounter(key);
      const nextCurrent = (current?.current || 0) + 1;
      if (nextCurrent > max) {
        return {
          allowed: false,
          state: current,
        };
      }
      const next = {
        key,
        current: nextCurrent,
        max,
        updatedAt: Date.now(),
        expiresAt: Date.now() + ttlSeconds * 1000,
      };
      store.setConcurrencyCounter(key, next, ttlSeconds);
      return {
        allowed: true,
        state: next,
      };
    },
    release(key: string, ttlSeconds = 60) {
      const current = store.getConcurrencyCounter(key);
      if (!current) {
        return null;
      }
      const nextCurrent = Math.max(0, current.current - 1);
      if (nextCurrent === 0) {
        store.deleteConcurrencyCounter(key);
        return {
          ...current,
          current: 0,
          updatedAt: Date.now(),
        };
      }
      const next = {
        ...current,
        current: nextCurrent,
        updatedAt: Date.now(),
      };
      store.setConcurrencyCounter(key, next, ttlSeconds);
      return next;
    },
    clear(key: string) {
      store.deleteConcurrencyCounter(key);
    },
  };
}

export function createProviderHealthService(store: HotStateStore) {
  return {
    get(providerId: string) {
      return store.getProviderHealth(providerId);
    },
    report(providerId: string, patch: Partial<ProviderHealthSnapshot> & { healthState: ProviderHealthSnapshot['healthState']; healthScore: number }) {
      const current = store.getProviderHealth(providerId);
      const next: ProviderHealthSnapshot = {
        providerId,
        healthState: patch.healthState,
        healthScore: patch.healthScore,
        cooldownUntil: patch.cooldownUntil ?? current?.cooldownUntil,
        lastCheckedAt: Date.now(),
        lastSuccessAt: patch.lastSuccessAt ?? current?.lastSuccessAt,
        lastFailureAt: patch.lastFailureAt ?? current?.lastFailureAt,
        successCount: patch.successCount ?? current?.successCount ?? 0,
        failureCount: patch.failureCount ?? current?.failureCount ?? 0,
      };
      const ttlSeconds = next.cooldownUntil && next.cooldownUntil > Date.now()
        ? Math.max(60, Math.ceil((next.cooldownUntil - Date.now()) / 1000))
        : 3600;
      store.setProviderHealth(providerId, next, ttlSeconds);
      return next;
    },
    clear(providerId: string) {
      store.deleteProviderHealth(providerId);
    },
  };
}
