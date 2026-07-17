import type {
  AsyncOperationalRepository,
  ChannelPerformanceData,
  OperationalMetricRollupRecord,
} from './storage/repositoryContracts.js';

export type BuildChannelPerformanceRollupsInput = {
  repository: AsyncOperationalRepository;
  fromInclusive: number;
  toExclusive: number;
  bucketMs: number;
  source: OperationalMetricRollupRecord['source'];
  shouldContinue?: () => boolean;
  costResolver?: (input: {
    upstreamId?: string;
    tier?: string;
    quality?: string;
  }) => {
    configured: boolean;
    valueCredits: number;
  };
};

export type BuildChannelPerformanceRollupsResult = {
  fromInclusive: number;
  toExclusive: number;
  bucketMs: number;
  bucketCount: number;
  writtenCount: number;
  cancelled?: boolean;
};

export type StartOperationalRollupSchedulerInput = {
  repository: AsyncOperationalRepository;
  enabled?: boolean | (() => boolean);
  beforeTick?: () => Promise<void> | void;
  intervalMs?: number;
  intervalMsProvider?: () => number;
  lookbackDays?: number;
  lookbackDaysProvider?: () => number;
  bucketMs?: number;
  lockMs?: number;
  workerId?: string;
  costResolver?: BuildChannelPerformanceRollupsInput['costResolver'];
};

const minRollupBucketMs = 60 * 60 * 1000;
const maxRollupBucketMs = 31 * 24 * 60 * 60 * 1000;
const defaultRollupBucketMs = 24 * 60 * 60 * 1000;
const defaultRollupIntervalMs = 6 * 60 * 60 * 1000;
const defaultRollupLookbackDays = 14;
const defaultRollupLockMs = 30 * 60 * 1000;
const channelPerformanceRollupJobKey = 'channel_performance_daily_v1';

function normalizeBucketMs(value: number) {
  const normalized = Math.floor(Number(value || 0));
  if (!Number.isFinite(normalized)) {
    return 24 * 60 * 60 * 1000;
  }
  return Math.max(minRollupBucketMs, Math.min(maxRollupBucketMs, normalized));
}

function rollupKeyPart(value: unknown) {
  const normalized = String(value || '').trim();
  return encodeURIComponent(normalized || '_');
}

function normalizeRollupChannelId(value: unknown) {
  const normalized = String(value || '').trim();
  if (normalized === 'image_generation') {
    return 'channel_image_generation';
  }
  if (normalized === 'text_processing') {
    return 'channel_text_processing';
  }
  return normalized;
}

function channelPerformanceRollupKey(input: {
  bucketStart: number;
  bucketMs: number;
  metricKind: 'task' | 'billing' | 'trace';
  channelId?: string;
  upstreamId?: string;
  operation?: string;
  tier?: string;
  quality?: string;
}) {
  return [
    'channel_performance',
    input.bucketStart,
    input.bucketMs,
    input.metricKind,
    rollupKeyPart(input.channelId),
    rollupKeyPart(input.upstreamId),
    rollupKeyPart(input.operation),
    rollupKeyPart(input.tier),
    rollupKeyPart(input.quality),
  ].join(':');
}

function makeBaseRollup(input: {
  bucketStart: number;
  bucketMs: number;
  channelId?: string;
  upstreamId?: string;
  operation?: OperationalMetricRollupRecord['operation'];
  tier?: string;
  quality?: string;
  source: OperationalMetricRollupRecord['source'];
  metrics: Record<string, number>;
  detail: Record<string, unknown>;
  rollupKey: string;
}): OperationalMetricRollupRecord {
  const now = Date.now();
  return {
    rollupKey: input.rollupKey,
    metricFamily: 'channel_performance',
    bucketStart: input.bucketStart,
    bucketMs: input.bucketMs,
    channelId: input.channelId,
    upstreamId: input.upstreamId,
    operation: input.operation,
    tier: input.tier,
    quality: input.quality,
    source: input.source,
    metrics: input.metrics,
    detail: input.detail,
    generatedAt: now,
    updatedAt: now,
  };
}

function buildChannelPerformanceRollupRecords(input: {
  data: ChannelPerformanceData;
  bucketStart: number;
  bucketMs: number;
  source: OperationalMetricRollupRecord['source'];
  costResolver?: BuildChannelPerformanceRollupsInput['costResolver'];
}) {
  const records: OperationalMetricRollupRecord[] = [];

  for (const row of input.data.tasks) {
    const channelId = normalizeRollupChannelId(row.channelId);
    records.push(makeBaseRollup({
      bucketStart: input.bucketStart,
      bucketMs: input.bucketMs,
      channelId,
      upstreamId: row.upstreamId,
      operation: 'all',
      source: input.source,
      rollupKey: channelPerformanceRollupKey({
        bucketStart: input.bucketStart,
        bucketMs: input.bucketMs,
        metricKind: 'task',
        channelId,
        upstreamId: row.upstreamId,
        operation: 'all',
      }),
      metrics: {
        requestCount: row.requestCount,
        eligibleRequestCount: row.eligibleRequestCount,
        completedCount: row.completedCount,
        failedCount: row.failedCount,
        rejectedCount: row.rejectedCount,
        runningCount: row.runningCount,
        averageDurationMs: row.averageDurationMs,
        durationTotalMs: row.averageDurationMs * row.completedCount,
        lastActivityAt: row.lastActivityAt || 0,
        generationCount: row.generationCount,
        editCount: row.editCount,
      },
      detail: {
        metricKind: 'task',
      },
    }));
  }

  for (const row of input.data.billing) {
    const channelId = normalizeRollupChannelId(row.channelId);
    const isChat = row.operation === 'chat_completions';
    const resolvedCost = isChat
      ? { configured: row.upstreamUnitCostConfigured, valueCredits: row.upstreamUnitCostCredits }
      : input.costResolver
        ? input.costResolver({ upstreamId: row.upstreamId, tier: row.tier, quality: row.quality })
        : { configured: false, valueCredits: 0 };
    records.push(makeBaseRollup({
      bucketStart: input.bucketStart,
      bucketMs: input.bucketMs,
      channelId,
      upstreamId: row.upstreamId,
      tier: row.tier,
      quality: row.quality,
      operation: row.operation,
      source: input.source,
      rollupKey: channelPerformanceRollupKey({
        bucketStart: input.bucketStart,
        bucketMs: input.bucketMs,
        metricKind: 'billing',
        channelId,
        upstreamId: row.upstreamId,
        operation: row.operation,
        tier: row.tier,
        quality: row.quality,
      }),
      metrics: {
        billedUnitCount: row.unitCount,
        ...(isChat ? { chatRequestCount: row.unitCount } : { imageCount: row.unitCount }),
        chargedCredits: row.chargedCredits,
        estimatedUpstreamCostCredits: resolvedCost.configured
          ? Math.max(0, Number(resolvedCost.valueCredits || 0)) * row.unitCount
          : 0,
        costedUnitCount: resolvedCost.configured ? row.unitCount : 0,
        ...(isChat
          ? { costedChatRequestCount: resolvedCost.configured ? row.unitCount : 0 }
          : { costedImageCount: resolvedCost.configured ? row.unitCount : 0 }),
      },
      detail: {
        metricKind: 'billing',
      },
    }));
  }

  for (const row of input.data.traces) {
    const channelId = normalizeRollupChannelId(row.channelId);
    records.push(makeBaseRollup({
      bucketStart: input.bucketStart,
      bucketMs: input.bucketMs,
      channelId,
      upstreamId: row.upstreamId,
      operation: 'all',
      source: input.source,
      rollupKey: channelPerformanceRollupKey({
        bucketStart: input.bucketStart,
        bucketMs: input.bucketMs,
        metricKind: 'trace',
        channelId,
        upstreamId: row.upstreamId,
        operation: 'all',
      }),
      metrics: {
        requestCount: row.requestCount,
        eligibleRequestCount: row.eligibleRequestCount,
        completedCount: row.completedCount,
        failedCount: row.failedCount,
        rejectedCount: row.rejectedCount,
        runningCount: row.runningCount,
        averageDurationMs: row.averageDurationMs,
        durationTotalMs: row.averageDurationMs * row.completedCount,
        lastActivityAt: row.lastActivityAt || 0,
      },
      detail: {
        metricKind: 'trace',
      },
    }));
  }

  return records;
}

export async function buildChannelPerformanceRollups(
  input: BuildChannelPerformanceRollupsInput,
): Promise<BuildChannelPerformanceRollupsResult> {
  const bucketMs = normalizeBucketMs(input.bucketMs);
  const fromInclusive = Math.floor(Number(input.fromInclusive || 0));
  const toExclusive = Math.floor(Number(input.toExclusive || 0));
  if (!Number.isFinite(fromInclusive) || !Number.isFinite(toExclusive) || toExclusive <= fromInclusive) {
    throw new Error('invalid_rollup_time_range');
  }

  let bucketCount = 0;
  let writtenCount = 0;
  for (let bucketStart = fromInclusive; bucketStart < toExclusive; bucketStart += bucketMs) {
    if (input.shouldContinue && !input.shouldContinue()) {
      return {
        fromInclusive,
        toExclusive,
        bucketMs,
        bucketCount,
        writtenCount,
        cancelled: true,
      };
    }
    const bucketEnd = Math.min(bucketStart + bucketMs, toExclusive);
    const data = await input.repository.getChannelPerformanceData(bucketStart, bucketEnd);
    const records = buildChannelPerformanceRollupRecords({
      data,
      bucketStart,
      bucketMs: bucketEnd - bucketStart,
      source: input.source,
      costResolver: input.costResolver,
    });
    for (const record of records) {
      if (input.shouldContinue && !input.shouldContinue()) {
        return {
          fromInclusive,
          toExclusive,
          bucketMs,
          bucketCount,
          writtenCount,
          cancelled: true,
        };
      }
      await input.repository.upsertOperationalMetricRollup(record);
      writtenCount += 1;
    }
    bucketCount += 1;
  }

  return {
    fromInclusive,
    toExclusive,
    bucketMs,
    bucketCount,
    writtenCount,
  };
}

function floorToBucket(value: number, bucketMs: number) {
  return Math.floor(value / bucketMs) * bucketMs;
}

function clampRollupIntervalMs(value: number | undefined) {
  const normalized = Math.floor(Number(value || 0));
  if (!Number.isFinite(normalized) || normalized <= 0) {
    return defaultRollupIntervalMs;
  }
  return Math.max(15 * 60 * 1000, Math.min(24 * 60 * 60 * 1000, normalized));
}

function clampRollupLookbackDays(value: number | undefined) {
  const normalized = Math.floor(Number(value || 0));
  if (!Number.isFinite(normalized) || normalized <= 0) {
    return defaultRollupLookbackDays;
  }
  return Math.max(1, Math.min(90, normalized));
}

function clampRollupLockMs(value: number | undefined) {
  const normalized = Math.floor(Number(value || 0));
  if (!Number.isFinite(normalized) || normalized <= 0) {
    return defaultRollupLockMs;
  }
  return Math.max(5 * 60 * 1000, Math.min(6 * 60 * 60 * 1000, normalized));
}

export async function runScheduledChannelPerformanceRollup(input: {
  repository: AsyncOperationalRepository;
  now?: number;
  lookbackDays?: number;
  bucketMs?: number;
  lockMs?: number;
  workerId?: string;
  shouldContinue?: () => boolean;
  costResolver?: BuildChannelPerformanceRollupsInput['costResolver'];
}): Promise<BuildChannelPerformanceRollupsResult & { skipped: boolean }> {
  const bucketMs = normalizeBucketMs(input.bucketMs || defaultRollupBucketMs);
  const now = Math.floor(Number(input.now || Date.now()));
  const toExclusive = floorToBucket(now, bucketMs);
  const fromInclusive = toExclusive - clampRollupLookbackDays(input.lookbackDays) * 24 * 60 * 60 * 1000;
  const workerId = input.workerId || `rollup:${process.pid}`;
  const started = await input.repository.tryStartOperationalRollupJob({
    jobKey: channelPerformanceRollupJobKey,
    lockMs: clampRollupLockMs(input.lockMs),
    workerId,
  });
  if (!started) {
    return {
      fromInclusive,
      toExclusive,
      bucketMs,
      bucketCount: 0,
      writtenCount: 0,
      skipped: true,
    };
  }
  try {
    const result = await buildChannelPerformanceRollups({
      repository: input.repository,
      fromInclusive,
      toExclusive,
      bucketMs,
      source: 'scheduled_worker',
      shouldContinue: input.shouldContinue,
      costResolver: input.costResolver,
    });
    if (!result.cancelled) {
      await input.repository.finishOperationalRollupJob({
        jobKey: channelPerformanceRollupJobKey,
        workerId,
        success: true,
      });
    }
    return {
      ...result,
      skipped: false,
    };
  } catch (error) {
    await input.repository.finishOperationalRollupJob({
      jobKey: channelPerformanceRollupJobKey,
      workerId,
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

export function startOperationalRollupScheduler(input: StartOperationalRollupSchedulerInput) {
  const isEnabled = () => {
    if (typeof input.enabled === 'function') {
      return input.enabled();
    }
    return input.enabled !== false;
  };
  const getIntervalMs = () => clampRollupIntervalMs(input.intervalMsProvider ? input.intervalMsProvider() : input.intervalMs);
  const controlPlanePollMs = 60_000;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let nextRunAt = 0;
  let previousEnabled = false;
  const schedule = (delayMs: number) => {
    timer = setTimeout(() => {
      void run();
    }, Math.max(1000, delayMs));
    if (typeof timer.unref === 'function') {
      timer.unref();
    }
  };
  const run = async () => {
    try {
      if (input.beforeTick) {
        await input.beforeTick();
      }
    } catch (error) {
      console.warn('[operational-rollup] control-plane refresh failed', error instanceof Error ? error.message : String(error));
      schedule(controlPlanePollMs);
      return;
    }
    if (!isEnabled()) {
      // Keep a lightweight poll so control-plane changes can enable this feature without a restart.
      // Disabled ticks return before any database lock, scan, or rollup write.
      previousEnabled = false;
      nextRunAt = 0;
      schedule(Math.min(controlPlanePollMs, getIntervalMs()));
      return;
    }
    const now = Date.now();
    const justEnabled = !previousEnabled;
    previousEnabled = true;
    if (!justEnabled && nextRunAt > now) {
      const job = await input.repository.getOperationalRollupJob(channelPerformanceRollupJobKey).catch(() => null);
      if (job?.lastSuccessAt) {
        schedule(Math.min(controlPlanePollMs, Math.max(1000, nextRunAt - now)));
        return;
      }
    }
    try {
      await runScheduledChannelPerformanceRollup({
        repository: input.repository,
        lookbackDays: input.lookbackDaysProvider ? input.lookbackDaysProvider() : input.lookbackDays,
        bucketMs: input.bucketMs,
        lockMs: input.lockMs,
        workerId: input.workerId,
        shouldContinue: isEnabled,
        costResolver: input.costResolver,
      });
    } catch (error) {
      console.warn('[operational-rollup] scheduled channel performance rollup failed', error instanceof Error ? error.message : String(error));
    } finally {
      if (isEnabled()) {
        nextRunAt = Date.now() + getIntervalMs();
        schedule(Math.min(controlPlanePollMs, Math.max(1000, nextRunAt - Date.now())));
      } else {
        previousEnabled = false;
        nextRunAt = 0;
        schedule(Math.min(controlPlanePollMs, getIntervalMs()));
      }
    }
  };
  void run();
  return timer;
}
