import { createClient, type RedisClientType } from 'redis';
import type { ProviderRuntimeState } from '@yali/provider-core';
import type {
  AsyncHotStateStore,
  CanvasWorkflowRunState,
  ConcurrencyCounterState,
  ImageGatewayTaskState,
  OnboardingAnalyzeJobState,
  ProviderHealthSnapshot,
  RateLimitBucketState,
} from './repositoryContracts.js';

export type RedisHotStateOptions = {
  url?: string;
  prefix?: string;
};

function resolveClient(options: RedisHotStateOptions = {}): RedisClientType {
  return createClient({
    url: options.url || process.env.REDIS_URL || undefined,
  });
}

function buildKey(prefix: string, section: string, id: string) {
  return `${prefix}:${section}:${id}`;
}

function buildSectionPrefix(prefix: string, section: string) {
  return `${prefix}:${section}:`;
}

async function ensureConnected(client: RedisClientType) {
  if (!client.isOpen) {
    await client.connect();
  }
}

async function readJson<T>(client: RedisClientType, key: string): Promise<T | null> {
  const raw = await client.get(key);
  if (!raw) {
    return null;
  }
  return JSON.parse(raw) as T;
}

function parseJsonOrNull<T>(raw: unknown): T | null {
  if (typeof raw !== 'string' || !raw) {
    return null;
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

async function writeJson<T>(client: RedisClientType, key: string, value: T, ttlSeconds?: number) {
  const payload = JSON.stringify(value);
  if (ttlSeconds && ttlSeconds > 0) {
    await client.set(key, payload, { EX: ttlSeconds });
    return;
  }
  await client.set(key, payload);
}

async function scanKeys(client: RedisClientType, pattern: string): Promise<string[]> {
  const keys: string[] = [];
  const lowLevelClient = client as RedisClientType & {
    sendCommand(args: string[]): Promise<unknown>;
  };
  let cursor = '0';
  do {
    const response = await lowLevelClient.sendCommand(['SCAN', cursor, 'MATCH', pattern, 'COUNT', '200']) as [string, string[]];
    cursor = String(response?.[0] || '0');
    const batch = Array.isArray(response?.[1]) ? response[1] : [];
    for (const key of batch) {
      keys.push(String(key));
    }
  }
  while (cursor !== '0');
  return keys;
}

async function listByPattern<T>(client: RedisClientType, pattern: string): Promise<T[]> {
  const keys = await scanKeys(client, pattern);
  if (!keys.length) {
    return [];
  }
  const values = await client.mGet(keys);
  return values
    .filter((item): item is string => Boolean(item))
    .map((item) => JSON.parse(item) as T);
}

function isQueuedImageTask(task: ImageGatewayTaskState | null, now = Date.now()) {
  if (!task || task.status !== 'queued') {
    return false;
  }
  const queueExpiresAt = Number(task.queue_expires_at || 0);
  return !(queueExpiresAt > 0 && queueExpiresAt <= now);
}

export function createRedisHotStateStore(options: RedisHotStateOptions = {}): AsyncHotStateStore {
  const client = resolveClient(options);
  const prefix = options.prefix || 'yali';
  const providerRuntimeSectionPrefix = buildSectionPrefix(prefix, 'provider_runtime');
  const imageTaskQueueKey = buildKey(prefix, 'image_task_queue', 'queued');

  async function removeQueuedImageTaskIds(taskIds: string[]) {
    const uniqueTaskIds = Array.from(new Set(taskIds.map((item) => String(item || '').trim()).filter(Boolean)));
    if (!uniqueTaskIds.length) {
      return;
    }
    await (client as RedisClientType & { sendCommand(args: string[]): Promise<unknown> }).sendCommand([
      'ZREM',
      imageTaskQueueKey,
      ...uniqueTaskIds,
    ]);
  }

  async function updateQueuedImageTaskIndex(taskId: string, value: ImageGatewayTaskState) {
    const normalizedTaskId = String(taskId || '').trim();
    if (!normalizedTaskId) {
      return;
    }
    if (!isQueuedImageTask(value)) {
      await removeQueuedImageTaskIds([normalizedTaskId]);
      return;
    }
    const score = Math.max(0, Number(value.created_at || value.updated_at || Date.now()));
    await (client as RedisClientType & { sendCommand(args: string[]): Promise<unknown> }).sendCommand([
      'ZADD',
      imageTaskQueueKey,
      String(score),
      normalizedTaskId,
    ]);
  }

  return {
    async getProviderRuntime(providerId: string) {
      await ensureConnected(client);
      return readJson<ProviderRuntimeState>(client, buildKey(prefix, 'provider_runtime', providerId));
    },
    async getProviderRuntimeMany(providerIds: string[]) {
      await ensureConnected(client);
      const uniqueProviderIds = Array.from(new Set(providerIds.map((item) => String(item || '').trim()).filter(Boolean)));
      if (!uniqueProviderIds.length) {
        return [];
      }
      const keys = uniqueProviderIds.map((providerId) => buildKey(prefix, 'provider_runtime', providerId));
      const values = await client.mGet(keys);
      return uniqueProviderIds.map((providerId, index) => ({
        providerId,
        runtime: parseJsonOrNull<ProviderRuntimeState>(values[index]),
      }));
    },
    async updateProviderRuntime(providerId, updater, ttlSeconds) {
      await ensureConnected(client);
      const key = buildKey(prefix, 'provider_runtime', providerId);
      const lowLevelClient = client as RedisClientType & {
        watch(key: string): Promise<void>;
        unwatch(): Promise<void>;
        multi(): {
          set(key: string, value: string, options?: { EX?: number }): unknown;
          exec(): Promise<unknown[] | null>;
        };
      };
      for (let attempt = 0; attempt < 8; attempt += 1) {
        await lowLevelClient.watch(key);
        try {
          const current = await readJson<ProviderRuntimeState>(client, key);
          const next = updater(current);
          const transaction = lowLevelClient.multi();
          const payload = JSON.stringify(next);
          if (ttlSeconds && ttlSeconds > 0) {
            transaction.set(key, payload, { EX: ttlSeconds });
          } else {
            transaction.set(key, payload);
          }
          const result = await transaction.exec();
          if (result) {
            return next;
          }
        } finally {
          try {
            await lowLevelClient.unwatch();
          } catch {
            // Ignore redundant unwatch failures after exec/abort.
          }
        }
      }
      throw new Error(`provider_runtime_update_conflict:${providerId}`);
    },
    async setProviderRuntime(providerId: string, value: ProviderRuntimeState, ttlSeconds?: number) {
      await ensureConnected(client);
      await writeJson(client, buildKey(prefix, 'provider_runtime', providerId), value, ttlSeconds);
    },
    async deleteProviderRuntime(providerId: string) {
      await ensureConnected(client);
      await client.del(buildKey(prefix, 'provider_runtime', providerId));
    },
    async listProviderRuntime() {
      await ensureConnected(client);
      const keys = await scanKeys(client, buildKey(prefix, 'provider_runtime', '*'));
      if (!keys.length) {
        return [];
      }
      const values = await client.mGet(keys);
      return keys
        .map((key, index) => ({ key, raw: values[index] }))
        .filter((item): item is { key: string; raw: string } => Boolean(item.raw))
        .map((item) => ({
          providerId: item.key.startsWith(providerRuntimeSectionPrefix)
            ? item.key.slice(providerRuntimeSectionPrefix.length)
            : '',
          runtime: JSON.parse(item.raw) as ProviderRuntimeState,
        }))
        .filter((item) => item.providerId);
    },
    async getRateLimitBucket(key: string) {
      await ensureConnected(client);
      return readJson<RateLimitBucketState>(client, buildKey(prefix, 'rate_limit', key));
    },
    async setRateLimitBucket(key: string, value: RateLimitBucketState, ttlSeconds?: number) {
      await ensureConnected(client);
      await writeJson(client, buildKey(prefix, 'rate_limit', key), value, ttlSeconds);
    },
    async deleteRateLimitBucket(key: string) {
      await ensureConnected(client);
      await client.del(buildKey(prefix, 'rate_limit', key));
    },
    async listRateLimitBuckets() {
      await ensureConnected(client);
      return listByPattern<RateLimitBucketState>(client, buildKey(prefix, 'rate_limit', '*'));
    },
    async getConcurrencyCounter(key: string) {
      await ensureConnected(client);
      return readJson<ConcurrencyCounterState>(client, buildKey(prefix, 'concurrency', key));
    },
    async getConcurrencyCounters(keys: string[]) {
      await ensureConnected(client);
      const uniqueKeys = Array.from(new Set(keys.map((item) => String(item || '').trim()).filter(Boolean)));
      if (!uniqueKeys.length) {
        return [];
      }
      const redisKeys = uniqueKeys.map((key) => buildKey(prefix, 'concurrency', key));
      const values = await client.mGet(redisKeys);
      return uniqueKeys.map((key, index) => ({
        key,
        counter: parseJsonOrNull<ConcurrencyCounterState>(values[index]),
      }));
    },
    async setConcurrencyCounter(key: string, value: ConcurrencyCounterState, ttlSeconds?: number) {
      await ensureConnected(client);
      await writeJson(client, buildKey(prefix, 'concurrency', key), value, ttlSeconds);
    },
    async deleteConcurrencyCounter(key: string) {
      await ensureConnected(client);
      await client.del(buildKey(prefix, 'concurrency', key));
    },
    async listConcurrencyCounters() {
      await ensureConnected(client);
      return listByPattern<ConcurrencyCounterState>(client, buildKey(prefix, 'concurrency', '*'));
    },
    async getProviderHealth(providerId: string) {
      await ensureConnected(client);
      return readJson<ProviderHealthSnapshot>(client, buildKey(prefix, 'provider_health', providerId));
    },
    async setProviderHealth(providerId: string, value: ProviderHealthSnapshot, ttlSeconds?: number) {
      await ensureConnected(client);
      await writeJson(client, buildKey(prefix, 'provider_health', providerId), value, ttlSeconds);
    },
    async deleteProviderHealth(providerId: string) {
      await ensureConnected(client);
      await client.del(buildKey(prefix, 'provider_health', providerId));
    },
    async listProviderHealth() {
      await ensureConnected(client);
      return listByPattern<ProviderHealthSnapshot>(client, buildKey(prefix, 'provider_health', '*'));
    },
    async getOnboardingAnalyzeJob(jobId: string) {
      await ensureConnected(client);
      return readJson<OnboardingAnalyzeJobState>(client, buildKey(prefix, 'onboarding_job', jobId));
    },
    async setOnboardingAnalyzeJob(jobId: string, value: OnboardingAnalyzeJobState, ttlSeconds?: number) {
      await ensureConnected(client);
      await writeJson(client, buildKey(prefix, 'onboarding_job', jobId), value, ttlSeconds);
    },
    async deleteOnboardingAnalyzeJob(jobId: string) {
      await ensureConnected(client);
      await client.del(buildKey(prefix, 'onboarding_job', jobId));
    },
    async listOnboardingAnalyzeJobs() {
      await ensureConnected(client);
      return listByPattern<OnboardingAnalyzeJobState>(client, buildKey(prefix, 'onboarding_job', '*'));
    },
    async getImageTask(taskId: string) {
      await ensureConnected(client);
      return readJson<ImageGatewayTaskState>(client, buildKey(prefix, 'image_task', taskId));
    },
    async setImageTask(taskId: string, value: ImageGatewayTaskState, ttlSeconds?: number) {
      await ensureConnected(client);
      await writeJson(client, buildKey(prefix, 'image_task', taskId), value, ttlSeconds);
      await updateQueuedImageTaskIndex(taskId, value);
    },
    async deleteImageTask(taskId: string) {
      await ensureConnected(client);
      await client.del(buildKey(prefix, 'image_task', taskId));
      await removeQueuedImageTaskIds([taskId]);
    },
    async listImageTasks() {
      await ensureConnected(client);
      return listByPattern<ImageGatewayTaskState>(client, buildKey(prefix, 'image_task', '*'));
    },
    async listQueuedImageTasks() {
      await ensureConnected(client);
      const lowLevelClient = client as RedisClientType & {
        sendCommand(args: string[]): Promise<unknown>;
      };
      const taskIds = (await lowLevelClient.sendCommand([
        'ZRANGE',
        imageTaskQueueKey,
        '0',
        '-1',
      ]) as unknown[])
        .map((item) => String(item || '').trim())
        .filter(Boolean);
      if (!taskIds.length) {
        return [];
      }
      const keys = taskIds.map((taskId) => buildKey(prefix, 'image_task', taskId));
      const values = await client.mGet(keys);
      const staleTaskIds: string[] = [];
      const now = Date.now();
      const tasks: ImageGatewayTaskState[] = [];
      for (let index = 0; index < taskIds.length; index += 1) {
        const task = parseJsonOrNull<ImageGatewayTaskState>(values[index]);
        if (!task || !isQueuedImageTask(task, now)) {
          staleTaskIds.push(taskIds[index]);
          continue;
        }
        tasks.push(task);
      }
      if (staleTaskIds.length) {
        await removeQueuedImageTaskIds(staleTaskIds);
      }
      return tasks.sort((left, right) => Number(left.created_at || 0) - Number(right.created_at || 0));
    },
    async getWorkflowRun(runId: string) {
      await ensureConnected(client);
      return readJson<CanvasWorkflowRunState>(client, buildKey(prefix, 'workflow_run', runId));
    },
    async setWorkflowRun(runId: string, value: CanvasWorkflowRunState, ttlSeconds?: number) {
      await ensureConnected(client);
      await writeJson(client, buildKey(prefix, 'workflow_run', runId), value, ttlSeconds);
    },
    async deleteWorkflowRun(runId: string) {
      await ensureConnected(client);
      await client.del(buildKey(prefix, 'workflow_run', runId));
    },
    async listWorkflowRuns() {
      await ensureConnected(client);
      return listByPattern<CanvasWorkflowRunState>(client, buildKey(prefix, 'workflow_run', '*'));
    },
  };
}
