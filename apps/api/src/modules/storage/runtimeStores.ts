import { inMemoryHotStateStore } from './inMemoryHotStateStore.js';
import { createRedisAtomicCounters } from './redisAtomicCounters.js';
import { createRedisHotStateStore } from './redisHotStateStore.js';
import type { ProviderRuntimeState } from '@yali/provider-core';
import type { HotStateStore } from './repositoryContracts.js';
import { isSharedHotStateStrict, requireSharedHotState } from './sharedStateMode.js';

requireSharedHotState('runtime_hot_state');
const redisEnabled = Boolean(process.env.REDIS_URL && String(process.env.REDIS_URL).trim());
const redisStore = redisEnabled ? createRedisHotStateStore({ url: process.env.REDIS_URL }) : null;
export const asyncHotStateStore = redisStore;
export const hotStateAtomicCounters = redisEnabled ? createRedisAtomicCounters({ url: process.env.REDIS_URL }) : null;
const baseStore = inMemoryHotStateStore;
export const sharedHotStateStrict = isSharedHotStateStrict();

function createSharedHotStateUnavailableError() {
  const error = new Error('Shared hot state backend is unavailable.');
  (error as Error & { statusCode?: number; code?: string }).statusCode = 503;
  (error as Error & { statusCode?: number; code?: string }).code = 'shared_state_unavailable';
  return error;
}

export async function refreshHotProviderRuntime(providerIds: string[]) {
  if (!redisStore || !providerIds.length) {
    return;
  }
  const uniqueProviderIds = Array.from(new Set(providerIds.map((item) => String(item || '').trim()).filter(Boolean)));
  try {
    const runtimes = await redisStore.getProviderRuntimeMany(uniqueProviderIds);
    for (const { providerId, runtime } of runtimes) {
      if (runtime) {
        baseStore.setProviderRuntime(providerId, runtime);
      } else {
        baseStore.deleteProviderRuntime(providerId);
      }
    }
  } catch {
    if (sharedHotStateStrict) {
      throw createSharedHotStateUnavailableError();
    }
  }
}

export async function updateHotProviderRuntime(
  providerId: string,
  updater: (current: ProviderRuntimeState | null) => ProviderRuntimeState,
  ttlSeconds?: number,
) {
  if (redisStore?.updateProviderRuntime) {
    const next = await redisStore.updateProviderRuntime(providerId, updater, ttlSeconds);
    baseStore.setProviderRuntime(providerId, next);
    return next;
  }
  const current = baseStore.getProviderRuntime(providerId);
  const next = updater(current);
  baseStore.setProviderRuntime(providerId, next);
  return next;
}

export async function refreshHotConcurrencyCounters(keys: string[]) {
  if (!keys.length) {
    return;
  }
  const uniqueKeys = Array.from(new Set(keys.map((item) => String(item || '').trim()).filter(Boolean)));
  try {
    // Real request concurrency now uses independent Redis leases. Read the
    // aggregate through the lease store so routing and admin diagnostics see
    // the same count that admission enforces. The legacy JSON counter remains
    // included while older PM2 workers drain during a rolling deployment.
    const counters = hotStateAtomicCounters
      ? await hotStateAtomicCounters.inspectConcurrencyLeases(uniqueKeys)
      : redisStore
        ? await redisStore.getConcurrencyCounters(uniqueKeys)
        : [];
    for (const item of counters) {
      const state = 'state' in item ? item.state : item.counter;
      if (state) {
        const ttlSeconds = state.expiresAt && state.expiresAt > Date.now()
          ? Math.max(1, Math.ceil((state.expiresAt - Date.now()) / 1000))
          : undefined;
        baseStore.setConcurrencyCounter(item.key, state, ttlSeconds);
      } else {
        baseStore.deleteConcurrencyCounter(item.key);
      }
    }
  } catch {
    if (sharedHotStateStrict) {
      throw createSharedHotStateUnavailableError();
    }
  }
}

export const hotStateStore: HotStateStore = {
  getProviderRuntime(providerId) {
    return baseStore.getProviderRuntime(providerId);
  },
  setProviderRuntime(providerId, value) {
    baseStore.setProviderRuntime(providerId, value);
    if (redisStore) {
      void redisStore.setProviderRuntime(providerId, value);
    }
  },
  deleteProviderRuntime(providerId) {
    baseStore.deleteProviderRuntime(providerId);
    if (redisStore) {
      void redisStore.deleteProviderRuntime(providerId);
    }
  },
  listProviderRuntime() {
    return baseStore.listProviderRuntime();
  },
  getRateLimitBucket(key) {
    return baseStore.getRateLimitBucket(key);
  },
  setRateLimitBucket(key, value, ttlSeconds) {
    baseStore.setRateLimitBucket(key, value, ttlSeconds);
    if (redisStore) {
      void redisStore.setRateLimitBucket(key, value, ttlSeconds);
    }
  },
  deleteRateLimitBucket(key) {
    baseStore.deleteRateLimitBucket(key);
    if (redisStore) {
      void redisStore.deleteRateLimitBucket(key);
    }
  },
  listRateLimitBuckets() {
    return baseStore.listRateLimitBuckets();
  },
  getConcurrencyCounter(key) {
    return baseStore.getConcurrencyCounter(key);
  },
  setConcurrencyCounter(key, value, ttlSeconds) {
    baseStore.setConcurrencyCounter(key, value, ttlSeconds);
    if (redisStore) {
      void redisStore.setConcurrencyCounter(key, value, ttlSeconds);
    }
  },
  deleteConcurrencyCounter(key) {
    baseStore.deleteConcurrencyCounter(key);
    if (redisStore) {
      void redisStore.deleteConcurrencyCounter(key);
    }
  },
  listConcurrencyCounters() {
    return baseStore.listConcurrencyCounters();
  },
  getProviderHealth(providerId) {
    return baseStore.getProviderHealth(providerId);
  },
  setProviderHealth(providerId, value, ttlSeconds) {
    baseStore.setProviderHealth(providerId, value, ttlSeconds);
    if (redisStore) {
      void redisStore.setProviderHealth(providerId, value, ttlSeconds);
    }
  },
  deleteProviderHealth(providerId) {
    baseStore.deleteProviderHealth(providerId);
    if (redisStore) {
      void redisStore.deleteProviderHealth(providerId);
    }
  },
  listProviderHealth() {
    return baseStore.listProviderHealth();
  },
  getOnboardingAnalyzeJob(jobId) {
    return baseStore.getOnboardingAnalyzeJob(jobId);
  },
  setOnboardingAnalyzeJob(jobId, value, ttlSeconds) {
    baseStore.setOnboardingAnalyzeJob(jobId, value, ttlSeconds);
    if (redisStore) {
      void redisStore.setOnboardingAnalyzeJob(jobId, value, ttlSeconds);
    }
  },
  deleteOnboardingAnalyzeJob(jobId) {
    baseStore.deleteOnboardingAnalyzeJob(jobId);
    if (redisStore) {
      void redisStore.deleteOnboardingAnalyzeJob(jobId);
    }
  },
  listOnboardingAnalyzeJobs() {
    return baseStore.listOnboardingAnalyzeJobs();
  },
  getImageTask(taskId) {
    return baseStore.getImageTask(taskId);
  },
  setImageTask(taskId, value, ttlSeconds) {
    baseStore.setImageTask(taskId, value, ttlSeconds);
    if (redisStore) {
      void redisStore.setImageTask(taskId, value, ttlSeconds);
    }
  },
  deleteImageTask(taskId) {
    baseStore.deleteImageTask(taskId);
    if (redisStore) {
      void redisStore.deleteImageTask(taskId);
    }
  },
  listImageTasks() {
    return baseStore.listImageTasks();
  },
  getWorkflowRun(runId) {
    return baseStore.getWorkflowRun(runId);
  },
  setWorkflowRun(runId, value, ttlSeconds) {
    baseStore.setWorkflowRun(runId, value, ttlSeconds);
    if (redisStore) {
      void redisStore.setWorkflowRun(runId, value, ttlSeconds);
    }
  },
  deleteWorkflowRun(runId) {
    baseStore.deleteWorkflowRun(runId);
    if (redisStore) {
      void redisStore.deleteWorkflowRun(runId);
    }
  },
  listWorkflowRuns() {
    return baseStore.listWorkflowRuns();
  },
};

if (redisStore) {
  void (async () => {
    try {
      for (const runtime of await redisStore.listProviderRuntime()) {
        baseStore.setProviderRuntime(runtime.providerId, runtime.runtime);
      }
      for (const bucket of await redisStore.listRateLimitBuckets()) {
        baseStore.setRateLimitBucket(bucket.key, bucket);
      }
      for (const counter of await redisStore.listConcurrencyCounters()) {
        baseStore.setConcurrencyCounter(counter.key, counter);
      }
      for (const health of await redisStore.listProviderHealth()) {
        baseStore.setProviderHealth(health.providerId, health);
      }
      for (const job of await redisStore.listOnboardingAnalyzeJobs()) {
        baseStore.setOnboardingAnalyzeJob(job.jobId, job);
      }
      for (const task of await redisStore.listImageTasks()) {
        baseStore.setImageTask(task.task_id, task);
      }
      for (const run of await redisStore.listWorkflowRuns()) {
        baseStore.setWorkflowRun(run.run_id, run);
      }
    } catch {
      if (sharedHotStateStrict) {
        console.error('Shared hot state preload failed while strict shared state mode is enabled.');
        process.exit(1);
      }
    }
  })();
}
