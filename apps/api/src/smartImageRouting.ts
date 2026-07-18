import {
  resolveProviderRuntimeForRead,
  supportedImagesEditProtocols,
  type OpenAIImagesEditProtocol,
  type ProviderConfig,
} from '@yali/provider-core';
import { classifyResolutionTier, parseImageSize } from '@yali/billing-core';
import { adminConsoleCatalogStore } from './modules/admin/consoleCatalog.js';
import { adminControlPlaneStore } from './modules/admin/controlPlane.js';
import {
  hotStateStore,
  refreshHotConcurrencyCounters,
  refreshHotProviderRuntime,
} from './modules/storage/runtimeStores.js';
import { operationalRepository } from './modules/storage/operationalStore.js';
import type { ResolutionAuditSummaryRow } from './modules/imageResolutionAudit.js';
import { buildResolutionAuditReport, type ResolutionAuditReport } from './modules/imageResolutionAudit.js';

export type ImageRoutingMode = 'smart_priority' | 'smart_failover' | 'fixed_provider';

export type ImageRoutingRequestContext = {
  operation: 'generations' | 'edits';
  requestedSize?: string;
  requestedQuality?: string;
  requestedResponseFormat?: 'url' | 'b64_json';
  requestedEditProtocol?: OpenAIImagesEditProtocol;
  requestMode: 'sync' | 'async';
  hasReferenceImage: boolean;
  requestedModel: string;
  ignoreTierQualityCapability?: boolean;
  ignoreRuntimeBlock?: boolean;
};

export type SmartImageRoutingCandidate = {
  provider: ProviderConfig;
  score: number;
  baseScore: number;
  reasons: string[];
  currentConcurrency: number;
  maxConcurrency: number;
  estimatedLatencyMs: number;
  observedLatencyMs?: number;
  latencySource: 'success_ewma' | 'legacy_ewma' | 'candidate_median';
  successLatencySampleCount: number;
  qualityScore: number;
  healthScore: number;
  concurrencyScore: number;
  price: number;
  costSource: 'exact' | 'highest_configured_fallback' | 'unconfigured';
  costMedian: number;
  effectiveCost: number;
  costIndex: number;
  deliveryValueIndex: number;
};

type ProviderFilterReason = {
  reason: string;
  temporaryRuntimeBlock: boolean;
};

export type SmartImageRoutingPlan = {
  mode: ImageRoutingMode;
  candidates: SmartImageRoutingCandidate[];
  filteredOut: Array<{
    providerId: string;
    reason: string;
  }>;
};

export type UpstreamFailureCategory =
  | 'retryable_transport'
  | 'retryable_status'
  | 'retryable_rate_limit'
  | 'retryable_gateway'
  | 'retryable_timeout'
  | 'retryable_overloaded'
  | 'retryable_upstream_auth'
  | 'retryable_upstream_quota'
  | 'retryable_upstream_capability'
  | 'terminal_invalid_request'
  | 'terminal_user_content'
  | 'terminal_auth'
  | 'terminal_capability'
  | 'terminal_safety'
  | 'terminal_config'
  | 'terminal_unknown';

export type UpstreamFailureClassification = {
  category: UpstreamFailureCategory;
  shouldFailover: boolean;
  cooldownMs: number;
  affectsHealth?: boolean;
};

type ProviderAccuracySnapshot = {
  exactRow?: ResolutionAuditSummaryRow;
  aspectFallbackRow?: ResolutionAuditSummaryRow;
};

type AccuracySnapshotIndex = {
  exactRowsByProviderId: Map<string, ResolutionAuditSummaryRow>;
  aspectRowsByProviderId: Map<string, ResolutionAuditSummaryRow>;
};

// Reliability decides whether candidates are comparable. Cost then competes
// with predicted successful output time inside that comparable range.
const ROUTING_HEALTH_WEIGHT = 0.6;
const ROUTING_CONCURRENCY_WEIGHT = 0.2667;
const ROUTING_ACCURACY_WEIGHT = 0.1333;
const COST_MEDIAN_FLOOR_RATIO = 0.5;
const DEFAULT_PREDICTED_SUCCESS_LATENCY_MS = 60_000;
const SUCCESS_LATENCY_WARMUP_SAMPLES = 5;
const accuracyCacheTtlMs = Math.max(5_000, Number(process.env.SMART_ROUTING_ACCURACY_CACHE_MS || 15_000));
const accuracySampleLimit = Math.max(200, Math.min(5_000, Number(process.env.SMART_ROUTING_ACCURACY_TASK_SAMPLE_LIMIT || 1_500)));
const accuracySnapshotKey = 'image_resolution_accuracy_v1';
const accuracySnapshotRefreshMs = Math.max(
  60 * 60 * 1000,
  Number(process.env.SMART_ROUTING_ACCURACY_SNAPSHOT_MS || 5 * 24 * 60 * 60 * 1000),
);
const accuracySnapshotCache = new Map<string, {
  expiresAt: number;
  value: AccuracySnapshotIndex;
}>();
let persistedAccuracyReportCache: {
  expiresAt: number;
  value: ResolutionAuditReport;
} | null = null;
let accuracySnapshotRefreshPromise: Promise<ResolutionAuditReport> | null = null;

function accuracyCacheKey(context: ImageRoutingRequestContext) {
  return [
    context.operation,
    context.requestedSize || 'auto',
    requestedAspectLabel(context.requestedSize),
    requestTier(context.requestedSize),
  ].join('|');
}

function requestedAspectLabel(size?: string) {
  const parsed = parseImageSize(size);
  if (!parsed?.width || !parsed?.height) {
    return 'unknown';
  }
  const gcd = greatestCommonDivisor(parsed.width, parsed.height);
  return `${Math.round(parsed.width / gcd)}:${Math.round(parsed.height / gcd)}`;
}

function greatestCommonDivisor(a: number, b: number): number {
  let left = Math.abs(Math.trunc(a));
  let right = Math.abs(Math.trunc(b));
  while (right !== 0) {
    const next = left % right;
    left = right;
    right = next;
  }
  return left || 1;
}

function currentProviderConcurrency(providerId: string) {
  const key = `provider:${providerId}`;
  return hotStateStore.getConcurrencyCounter(key)?.current || 0;
}

function requestTier(size?: string) {
  return classifyResolutionTier(size || '') || 'auto';
}

function requestedQuality(value?: string) {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized === 'low' || normalized === 'medium' || normalized === 'high' ? normalized : 'auto';
}

function providerCapabilityProfiles(provider: ProviderConfig) {
  const kind = String(provider.metadata?.consoleUpstreamKind || '');
  const profiles = kind === 'responses_endpoint'
    ? provider.metadata?.responses_capability_profiles
    : provider.metadata?.images_capability_profiles;
  return Array.isArray(profiles) ? profiles : [];
}

function providerResolutionTiers(provider: ProviderConfig) {
  const profiles = providerCapabilityProfiles(provider);
  if (!Array.isArray(profiles)) {
    return ['auto', '1k', '2k', '4k'];
  }
  const tiers = profiles.flatMap((item) => {
    if (!item || typeof item !== 'object') {
      return [];
    }
    const tier = String((item as Record<string, unknown>).tier || '');
    return tier === 'auto' || tier === '1k' || tier === '2k' || tier === '4k' ? [tier] : [];
  });
  return tiers.length ? Array.from(new Set(tiers)) : ['auto', '1k', '2k', '4k'];
}

function providerSupportsTierQuality(
  provider: ProviderConfig,
  requestedTier: 'auto' | '1k' | '2k' | '4k',
  quality: 'auto' | 'low' | 'medium' | 'high',
) {
  const profiles = providerCapabilityProfiles(provider);
  if (!profiles.length) {
    return true;
  }
  const matched = profiles.find((item) => {
    if (!item || typeof item !== 'object') {
      return false;
    }
    return String((item as Record<string, unknown>).tier || '') === requestedTier;
  });
  if (!matched || typeof matched !== 'object') {
    return false;
  }
  const qualities = Array.isArray((matched as Record<string, unknown>).qualities)
    ? ((matched as Record<string, unknown>).qualities as unknown[])
      .map((item) => String(item || '').trim().toLowerCase())
      .filter((item): item is 'auto' | 'low' | 'medium' | 'high' => (
        item === 'auto' || item === 'low' || item === 'medium' || item === 'high'
      ))
    : [];
  if (!qualities.length) {
    return false;
  }
  return qualities.includes(quality);
}

function providerCapabilityCost(
  provider: ProviderConfig,
  requestedTier: 'auto' | '1k' | '2k' | '4k',
  quality: 'auto' | 'low' | 'medium' | 'high',
) {
  const profiles = providerCapabilityProfiles(provider);
  const matched = profiles.find((item) => {
    if (!item || typeof item !== 'object') {
      return false;
    }
    return String((item as Record<string, unknown>).tier || '') === requestedTier;
  });
  const readCost = (profile: unknown) => {
    if (!profile || typeof profile !== 'object') {
      return null;
    }
    const record = profile as Record<string, unknown>;
    const qualities = Array.isArray(record.qualities) ? record.qualities : [];
    if (!qualities.includes(quality)) {
      return null;
    }
    const costs = record.costs;
    if (!costs || typeof costs !== 'object') {
      return null;
    }
    if ((costs as Record<string, unknown>)[quality] === undefined) {
      return null;
    }
    const value = Number((costs as Record<string, unknown>)[quality]);
    return Number.isFinite(value) ? Math.max(0, value) : null;
  };

  const exactCost = readCost(matched);
  if (exactCost !== null) {
    return { value: exactCost, source: 'exact' as const };
  }

  const tierRank: Record<string, number> = { auto: 0, '1k': 1, '2k': 2, '4k': 3 };
  const qualityRank: Record<string, number> = { auto: 0, low: 1, medium: 2, high: 3 };
  let highest: { value: number; tierRank: number; qualityRank: number } | null = null;
  for (const profile of profiles) {
    if (!profile || typeof profile !== 'object') {
      continue;
    }
    const record = profile as Record<string, unknown>;
    const profileTierRank = tierRank[String(record.tier || '')];
    const qualities = Array.isArray(record.qualities) ? record.qualities : [];
    const costs = record.costs && typeof record.costs === 'object'
      ? record.costs as Record<string, unknown>
      : {};
    for (const configuredQuality of ['auto', 'low', 'medium', 'high']) {
      if (!qualities.includes(configuredQuality) || costs[configuredQuality] === undefined) {
        continue;
      }
      const value = Number(costs[configuredQuality]);
      if (!Number.isFinite(value)) {
        continue;
      }
      const next = {
        value: Math.max(0, value),
        tierRank: Number(profileTierRank || 0),
        qualityRank: qualityRank[configuredQuality],
      };
      if (!highest
        || next.tierRank > highest.tierRank
        || (next.tierRank === highest.tierRank && next.qualityRank > highest.qualityRank)) {
        highest = next;
      }
    }
  }
  if (highest) {
    return { value: highest.value, source: 'highest_configured_fallback' as const };
  }

  return { value: 0, source: 'unconfigured' as const };
}

function providerResponseFormatCompatibilityReason(
  provider: ProviderConfig,
  responseFormat?: 'url' | 'b64_json',
) {
  if (!responseFormat) {
    return null;
  }
  const kind = String(provider.metadata?.consoleUpstreamKind || '');
  if (kind !== 'images_endpoint') {
    return null;
  }
  const supported = provider.metadata?.images_response_formats;
  if (!Array.isArray(supported) || !supported.length) {
    return null;
  }
  if (supported.includes(responseFormat)) {
    return null;
  }
  return `response_format_${responseFormat}_converted_from_${String(supported[0] || 'upstream_default')}`;
}

function providerAllowsRequestedModel(provider: ProviderConfig, requestedModel?: string) {
  if (!Array.isArray(provider.modelAllowlist) || !provider.modelAllowlist.length) {
    return true;
  }
  const model = String(requestedModel || '').trim();
  if (!model) {
    return true;
  }
  return provider.modelAllowlist.includes(model);
}

function providerRuntimeBlockReason(provider: ProviderConfig): ProviderFilterReason | null {
  const runtime = hotStateStore.getProviderRuntime(provider.providerId);
  const runtimeUnavailableUntil = Math.max(Number(runtime?.cooldownUntil || 0), Number(runtime?.fusedUntil || 0));
  const lastAuthFailure = runtime?.lastErrorCategory === 'terminal_auth'
    || runtime?.lastHttpStatus === 401
    || runtime?.lastHttpStatus === 403;
  if (lastAuthFailure && runtimeUnavailableUntil > Date.now()) {
    return {
      reason: 'auth_failed',
      temporaryRuntimeBlock: true,
    };
  }
  if (runtimeUnavailableUntil > Date.now()) {
    return {
      reason: 'in_cooldown',
      temporaryRuntimeBlock: true,
    };
  }
  return null;
}

function filterProviderForRequest(provider: ProviderConfig, context: ImageRoutingRequestContext): ProviderFilterReason | null {
  if (provider.healthState === 'disabled') {
    return {
      reason: 'disabled',
      temporaryRuntimeBlock: false,
    };
  }
  if (context.operation === 'edits' && provider.capability?.supportsImageEdit === false) {
    return {
      reason: 'edit_not_supported',
      temporaryRuntimeBlock: false,
    };
  }
  if (context.operation === 'generations' && provider.capability?.supportsImageGeneration === false) {
    return {
      reason: 'generation_not_supported',
      temporaryRuntimeBlock: false,
    };
  }
  if (context.requestMode === 'sync' && provider.capability?.supportsSync === false) {
    return {
      reason: 'sync_not_supported',
      temporaryRuntimeBlock: false,
    };
  }
  // Platform async tasks run synchronous upstream providers in the background.
  // Upstream native async support is not required for /v1/images/* async=true.
  if (context.hasReferenceImage && provider.capability?.supportsReferenceImages === false) {
    return {
      reason: 'reference_not_supported',
      temporaryRuntimeBlock: false,
    };
  }
  if (context.operation === 'edits' && context.requestedEditProtocol) {
    const supportedProtocols = supportedImagesEditProtocols(provider);
    if (!supportedProtocols.includes(context.requestedEditProtocol)) {
      return {
        reason: `edit_protocol_${context.requestedEditProtocol}_not_supported`,
        temporaryRuntimeBlock: false,
      };
    }
  }
  if (!providerAllowsRequestedModel(provider, context.requestedModel)) {
    return {
      reason: 'model_not_allowed',
      temporaryRuntimeBlock: false,
    };
  }
  const requestedTier = requestTier(context.requestedSize);
  if (!context.ignoreTierQualityCapability) {
    const supportedTiers = providerResolutionTiers(provider);
    if (requestedTier !== 'auto' && !supportedTiers.includes(requestedTier)) {
      return {
        reason: `tier_${requestedTier}_not_supported`,
        temporaryRuntimeBlock: false,
      };
    }
    const quality = requestedQuality(context.requestedQuality);
    if (!providerSupportsTierQuality(provider, requestedTier, quality)) {
      return {
        reason: `quality_${quality}_not_supported_for_${requestedTier}`,
        temporaryRuntimeBlock: false,
      };
    }
  }
  if (!context.ignoreRuntimeBlock) {
    const runtimeBlock = providerRuntimeBlockReason(provider);
    if (runtimeBlock) {
      return runtimeBlock;
    }
  }
  return null;
}

function preferAccuracyRow(
  current: ResolutionAuditSummaryRow | undefined,
  next: ResolutionAuditSummaryRow,
) {
  if (!current) {
    return next;
  }
  if (next.measuredCount !== current.measuredCount) {
    return next.measuredCount > current.measuredCount ? next : current;
  }
  return Number(next.latestSampleAt || 0) > Number(current.latestSampleAt || 0) ? next : current;
}

async function buildAccuracySnapshotIndex(context: ImageRoutingRequestContext): Promise<AccuracySnapshotIndex> {
  const cacheKey = accuracyCacheKey(context);
  const cached = accuracySnapshotCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  const report = await getRoutingAccuracyReportSnapshot();
  const requestedSize = context.requestedSize || 'auto';
  const requestedAspect = requestedAspectLabel(context.requestedSize);
  const requestedTier = requestTier(context.requestedSize);
  const exactRowsByProviderId = new Map<string, ResolutionAuditSummaryRow>();
  const aspectRowsByProviderId = new Map<string, ResolutionAuditSummaryRow>();

  for (const row of report.rows) {
    if (row.operation !== context.operation) {
      continue;
    }
    if (row.requestedSize === requestedSize && row.requestedAspectLabel === requestedAspect) {
      exactRowsByProviderId.set(
        row.upstreamId,
        preferAccuracyRow(exactRowsByProviderId.get(row.upstreamId), row),
      );
    }
    if (row.requestedAspectLabel === requestedAspect && row.requestedTier === requestedTier) {
      aspectRowsByProviderId.set(
        row.upstreamId,
        preferAccuracyRow(aspectRowsByProviderId.get(row.upstreamId), row),
      );
    }
  }

  const snapshot = {
    exactRowsByProviderId,
    aspectRowsByProviderId,
  };

  accuracySnapshotCache.set(cacheKey, {
    expiresAt: Date.now() + accuracyCacheTtlMs,
    value: snapshot,
  });

  if (accuracySnapshotCache.size > 16) {
    for (const [key, entry] of accuracySnapshotCache.entries()) {
      if (entry.expiresAt <= Date.now()) {
        accuracySnapshotCache.delete(key);
      }
    }
  }

  return snapshot;
}

function normalizeRoutingAccuracyReport(value: unknown): ResolutionAuditReport | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const report = value as Partial<ResolutionAuditReport>;
  if (!Array.isArray(report.rows) || !Array.isArray(report.aspectRows)) {
    return null;
  }
  return {
    generatedAt: Number(report.generatedAt || 0),
    sampleWindowSize: Math.max(0, Number(report.sampleWindowSize || 0)),
    totals: report.totals && typeof report.totals === 'object'
      ? report.totals as ResolutionAuditReport['totals']
      : {
          sampleCount: 0,
          measuredCount: 0,
          upstreamCount: 0,
          exactRequestGroupCount: 0,
          aspectGroupCount: 0,
        },
    rows: report.rows as ResolutionAuditReport['rows'],
    aspectRows: report.aspectRows as ResolutionAuditReport['aspectRows'],
  };
}

async function rebuildRoutingAccuracyReportSnapshot() {
  const catalog = adminConsoleCatalogStore.get();
  const tasks = await operationalRepository.listTasks(accuracySampleLimit);
  const report = buildResolutionAuditReport(tasks, catalog);
  const now = Date.now();
  const normalizedReport = {
    ...report,
    generatedAt: now,
    sampleWindowSize: tasks.length,
  };
  const expiresAt = now + accuracySnapshotRefreshMs;
  await operationalRepository.upsertRoutingAccuracySnapshot({
    snapshotKey: accuracySnapshotKey,
    generatedAt: now,
    expiresAt,
    payload: normalizedReport as unknown as Record<string, unknown>,
  });
  persistedAccuracyReportCache = {
    expiresAt,
    value: normalizedReport,
  };
  accuracySnapshotCache.clear();
  return normalizedReport;
}

function refreshRoutingAccuracySnapshotInBackground() {
  if (accuracySnapshotRefreshPromise) {
    return;
  }
  accuracySnapshotRefreshPromise = rebuildRoutingAccuracyReportSnapshot()
    .finally(() => {
      accuracySnapshotRefreshPromise = null;
    });
  void accuracySnapshotRefreshPromise.catch(() => undefined);
}

async function getRoutingAccuracyReportSnapshot() {
  const now = Date.now();
  if (persistedAccuracyReportCache) {
    if (persistedAccuracyReportCache.expiresAt <= now) {
      refreshRoutingAccuracySnapshotInBackground();
    }
    return persistedAccuracyReportCache.value;
  }

  const stored = await operationalRepository.getRoutingAccuracySnapshot(accuracySnapshotKey);
  const storedReport = normalizeRoutingAccuracyReport(stored?.payload);
  if (storedReport) {
    persistedAccuracyReportCache = {
      expiresAt: Math.max(Number(stored?.expiresAt || 0), now + 60_000),
      value: storedReport,
    };
    if (Number(stored?.expiresAt || 0) <= now) {
      refreshRoutingAccuracySnapshotInBackground();
    }
    return storedReport;
  }

  if (!accuracySnapshotRefreshPromise) {
    accuracySnapshotRefreshPromise = rebuildRoutingAccuracyReportSnapshot()
      .finally(() => {
        accuracySnapshotRefreshPromise = null;
      });
  }
  return accuracySnapshotRefreshPromise;
}

function buildAccuracySnapshot(providerId: string, index: AccuracySnapshotIndex): ProviderAccuracySnapshot {
  return {
    exactRow: index.exactRowsByProviderId.get(providerId),
    aspectFallbackRow: index.aspectRowsByProviderId.get(providerId),
  };
}

function scoreFromAccuracy(snapshot: ProviderAccuracySnapshot) {
  const row = snapshot.exactRow || snapshot.aspectFallbackRow;
  if (!row) {
    return 55;
  }
  const aspectScore = Number(row.avgAspectAccuracyPercent || 0);
  const resolutionScore = Number(row.avgResolutionAccuracyPercent || 0);
  const downgradePenalty = Number(row.downgradeRate || 0) * 0.45;
  const sameOrHigherBonus = Number(row.sameOrHigherTierRate || 0) * 0.15;
  return Math.max(0, Math.min(100, aspectScore * 0.45 + resolutionScore * 0.55 + sameOrHigherBonus - downgradePenalty));
}

function scoreFromHealth(provider: ProviderConfig) {
  const resolvedRuntime = provider.metadata?.runtime as {
    healthScore?: unknown;
    ewmaSuccessRate?: unknown;
    successCount?: unknown;
    failureCount?: unknown;
  } | undefined;
  const resolvedHealthScore = Number(resolvedRuntime?.healthScore || provider.healthScore || 0);
  if (resolvedHealthScore > 0) {
    return Math.max(0, Math.min(100, resolvedHealthScore));
  }
  const ewmaSuccessRate = Number(resolvedRuntime?.ewmaSuccessRate);
  if (Number.isFinite(ewmaSuccessRate) && ewmaSuccessRate >= 0) {
    return Math.max(0, Math.min(100, ewmaSuccessRate * 100));
  }
  const success = Number(resolvedRuntime?.successCount || 0);
  const failure = Number(resolvedRuntime?.failureCount || 0);
  const total = success + failure;
  if (total <= 0) {
    return 70;
  }
  return Math.max(0, Math.min(100, success / total * 100));
}

function resolveProviderRuntimeForRouting(provider: ProviderConfig) {
  const runtime = hotStateStore.getProviderRuntime(provider.providerId);
  if (!runtime) {
    return provider;
  }
  const resolvedRuntime = resolveProviderRuntimeForRead(runtime, provider);
  return {
    ...provider,
    healthScore: resolvedRuntime.healthScore,
    healthState: resolvedRuntime.healthState,
    metadata: {
      ...(provider.metadata || {}),
      runtime: resolvedRuntime,
    },
  };
}

function resolveProviderConcurrencyMax(provider: ProviderConfig) {
  const raw = provider.metadata?.max_concurrency
    ?? provider.metadata?.provider_max_concurrency
    ?? provider.metadata?.upstream_max_concurrency;
  const value = Number(raw || 0);
  if (!Number.isFinite(value) || value <= 0) {
    return 10;
  }
  return Math.max(1, Math.floor(value));
}

function scoreFromConcurrency(provider: ProviderConfig) {
  const current = currentProviderConcurrency(provider.providerId);
  const max = resolveProviderConcurrencyMax(provider);
  if (!max) {
    return current > 0 ? 92 : 100;
  }
  const pressure = Math.min(1, current / max);
  return Math.max(0, 100 - pressure * 70);
}

function priceForProvider(
  provider: ProviderConfig,
  requestedTierValue: 'auto' | '1k' | '2k' | '4k',
  requestedQualityValue: 'auto' | 'low' | 'medium' | 'high',
) {
  return providerCapabilityCost(provider, requestedTierValue, requestedQualityValue);
}

function reliabilityComparisonScoreDelta() {
  const value = Number(adminControlPlaneStore.get().routing.smartRoutingCostPriorityBaseDelta || 30);
  return Math.max(0, Math.min(100, Math.floor(value)));
}

function compareSmartCandidates(left: SmartImageRoutingCandidate, right: SmartImageRoutingCandidate) {
  const scoreDeltaThreshold = reliabilityComparisonScoreDelta();
  const leftFull = left.maxConcurrency > 0 && left.currentConcurrency >= left.maxConcurrency;
  const rightFull = right.maxConcurrency > 0 && right.currentConcurrency >= right.maxConcurrency;
  if (leftFull !== rightFull) {
    return leftFull ? 1 : -1;
  }
  const baseDelta = right.baseScore - left.baseScore;
  if (Math.abs(baseDelta) > scoreDeltaThreshold) {
    return baseDelta;
  }
  const deliveryValueDelta = left.deliveryValueIndex - right.deliveryValueIndex;
  if (Math.abs(deliveryValueDelta) > 0.000_001) {
    return deliveryValueDelta;
  }
  const healthDelta = right.healthScore - left.healthScore;
  const qualityDelta = right.qualityScore - left.qualityScore;
  const concurrencyDelta = right.concurrencyScore - left.concurrencyScore;
  if (healthDelta !== 0) {
    return healthDelta;
  }
  if (qualityDelta !== 0) {
    return qualityDelta;
  }
  if (concurrencyDelta !== 0) {
    return concurrencyDelta;
  }
  if (left.currentConcurrency !== right.currentConcurrency) {
    return left.currentConcurrency - right.currentConcurrency;
  }
  return Number(left.provider.priority || 100) - Number(right.provider.priority || 100);
}

function medianPositive(values: number[]) {
  const sorted = values
    .map((value) => Number(value || 0))
    .filter((value) => Number.isFinite(value) && value > 0)
    .sort((left, right) => left - right);
  if (!sorted.length) {
    return 0;
  }
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function measuredSuccessLatency(provider: ProviderConfig): {
  latencyMs?: number;
  sampleCount: number;
  source: 'success_ewma' | 'legacy_ewma' | 'candidate_median';
} {
  const runtime = provider.metadata?.runtime as {
    ewmaSuccessLatencyMs?: unknown;
    ewmaLatencyMs?: unknown;
    successCount?: unknown;
  } | undefined;
  const successLatencyMs = Number(runtime?.ewmaSuccessLatencyMs || 0);
  const legacyLatencyMs = Number(runtime?.ewmaLatencyMs || 0);
  const sampleCount = Math.max(0, Number(runtime?.successCount || 0));
  const hasSuccessLatency = Number.isFinite(successLatencyMs) && successLatencyMs > 0;
  const hasLegacyLatency = Number.isFinite(legacyLatencyMs) && legacyLatencyMs > 0;
  return {
    latencyMs: hasSuccessLatency
      ? successLatencyMs
      : (hasLegacyLatency ? legacyLatencyMs : undefined),
    sampleCount: Number.isFinite(sampleCount) ? Math.floor(sampleCount) : 0,
    source: hasSuccessLatency ? 'success_ewma' : (hasLegacyLatency ? 'legacy_ewma' : 'candidate_median'),
  };
}

export function buildCostSpeedDeliveryIndex(input: {
  price: number;
  costMedian: number;
  predictedLatencyMs: number;
}) {
  const rawMedian = Number(input.costMedian || 0);
  const costMedian = Number.isFinite(rawMedian) && rawMedian > 0 ? rawMedian : 1;
  const price = Number(input.price || 0);
  const costKnown = Number.isFinite(price) && price > 0;
  const effectiveCost = costKnown
    ? Math.max(price, costMedian * COST_MEDIAN_FLOOR_RATIO)
    : costMedian;
  const costIndex = effectiveCost / costMedian;
  const predictedLatencyMs = Math.max(0, Number(input.predictedLatencyMs || 0));
  return {
    costKnown,
    effectiveCost,
    costIndex,
    deliveryValueIndex: predictedLatencyMs * costIndex,
  };
}

export async function buildSmartImageRoutingPlan(input: {
  providers: ProviderConfig[];
  mode: ImageRoutingMode;
  context: ImageRoutingRequestContext;
}) : Promise<SmartImageRoutingPlan> {
  await refreshHotProviderRuntime(input.providers.map((provider) => provider.providerId));
  await refreshHotConcurrencyCounters(input.providers.map((provider) => `provider:${provider.providerId}`));
  const runtimeProviders = input.providers.map(resolveProviderRuntimeForRouting);

  const filteredOut: SmartImageRoutingPlan['filteredOut'] = [];
  const eligibleProviders: ProviderConfig[] = [];
  const temporarilyBlockedProviders: Array<{ provider: ProviderConfig; reason: string }> = [];
  const candidates: SmartImageRoutingCandidate[] = [];
  const tier = requestTier(input.context.requestedSize);
  const quality = requestedQuality(input.context.requestedQuality);
  const scoreDeltaThreshold = reliabilityComparisonScoreDelta();

  for (const provider of runtimeProviders) {
    const filterResult = filterProviderForRequest(provider, input.context);
    if (filterResult) {
      filteredOut.push({ providerId: provider.providerId, reason: filterResult.reason });
      if (filterResult.temporaryRuntimeBlock) {
        temporarilyBlockedProviders.push({ provider, reason: filterResult.reason });
      }
      continue;
    }
    eligibleProviders.push(provider);
  }

  const allowTemporaryRuntimeFallback = input.mode === 'smart_failover';
  const candidateProviders = eligibleProviders.length > 0
    ? eligibleProviders
    : (allowTemporaryRuntimeFallback ? temporarilyBlockedProviders.map((item) => item.provider) : []);
  const fallbackReasons = new Map(temporarilyBlockedProviders.map((item) => [item.provider.providerId, item.reason]));

  if (!candidateProviders.length) {
    return {
      mode: input.mode,
      candidates,
      filteredOut,
    };
  }

  const accuracyIndex = await buildAccuracySnapshotIndex(input.context);

  const unrankedCandidates = candidateProviders.map((provider) => {
    const accuracy = buildAccuracySnapshot(provider.providerId, accuracyIndex);
    const accuracyScore = scoreFromAccuracy(accuracy);
    const healthScore = scoreFromHealth(provider);
    const currentConcurrency = currentProviderConcurrency(provider.providerId);
    const maxConcurrency = resolveProviderConcurrencyMax(provider);
    const concurrencyScore = scoreFromConcurrency(provider);
    const cost = priceForProvider(provider, tier, quality);
    const successLatency = measuredSuccessLatency(provider);
    const responseFormatCompatibilityReason = providerResponseFormatCompatibilityReason(
      provider,
      input.context.requestedResponseFormat,
    );
    const baseScore = healthScore * ROUTING_HEALTH_WEIGHT
      + concurrencyScore * ROUTING_CONCURRENCY_WEIGHT
      + accuracyScore * ROUTING_ACCURACY_WEIGHT;
    return {
      provider,
      score: baseScore,
      baseScore,
      accuracyScore,
      healthScore,
      currentConcurrency,
      maxConcurrency,
      concurrencyScore,
      price: cost.value,
      costSource: cost.source,
      successLatency,
      responseFormatCompatibilityReason,
    };
  });
  const costMedian = medianPositive(unrankedCandidates.map((candidate) => candidate.price)) || 1;
  const estimatedLatencyFallbackMs = medianPositive(
    unrankedCandidates.map((candidate) => candidate.successLatency.latencyMs || 0),
  ) || DEFAULT_PREDICTED_SUCCESS_LATENCY_MS;

  for (const candidate of unrankedCandidates) {
    const latencyConfidence = Math.min(
      1,
      candidate.successLatency.sampleCount / SUCCESS_LATENCY_WARMUP_SAMPLES,
    );
    const estimatedLatencyMs = candidate.successLatency.latencyMs
      ? candidate.successLatency.latencyMs * latencyConfidence
        + estimatedLatencyFallbackMs * (1 - latencyConfidence)
      : estimatedLatencyFallbackMs;
    const deliveryEconomics = buildCostSpeedDeliveryIndex({
      price: candidate.price,
      costMedian,
      predictedLatencyMs: estimatedLatencyMs,
    });
    candidates.push({
      provider: candidate.provider,
      score: candidate.score,
      baseScore: candidate.baseScore,
      reasons: [
        `reliability_base=${candidate.baseScore.toFixed(2)}`,
        `accuracy=${candidate.accuracyScore.toFixed(2)}`,
        `health=${candidate.healthScore.toFixed(2)}`,
        `concurrency=${candidate.concurrencyScore.toFixed(2)}`,
        `concurrency_current=${candidate.currentConcurrency}`,
        `concurrency_max=${candidate.maxConcurrency}`,
        `concurrency_full=${candidate.maxConcurrency > 0 && candidate.currentConcurrency >= candidate.maxConcurrency ? 'true' : 'false'}`,
        `price=${candidate.price.toFixed(5)}`,
        `cost_source=${candidate.costSource}`,
        `cost_median=${costMedian.toFixed(4)}`,
        `effective_cost=${deliveryEconomics.effectiveCost.toFixed(4)}`,
        `cost_index=${deliveryEconomics.costIndex.toFixed(4)}`,
        `cost_known=${deliveryEconomics.costKnown ? 'true' : 'false'}`,
        `success_latency_ms=${candidate.successLatency.latencyMs ? Math.round(candidate.successLatency.latencyMs) : 'fallback'}`,
        `success_latency_source=${candidate.successLatency.source}`,
        `success_latency_samples=${candidate.successLatency.sampleCount}`,
        `success_latency_confidence=${latencyConfidence.toFixed(4)}`,
        `estimated_success_latency_ms=${Math.round(estimatedLatencyMs)}`,
        `delivery_value_index=${deliveryEconomics.deliveryValueIndex.toFixed(2)}`,
        `weight_health=${ROUTING_HEALTH_WEIGHT}`,
        `weight_concurrency=${ROUTING_CONCURRENCY_WEIGHT}`,
        `weight_accuracy=${ROUTING_ACCURACY_WEIGHT}`,
        `reliability_compare_base_delta=${scoreDeltaThreshold}`,
        ...(candidate.responseFormatCompatibilityReason
          ? [candidate.responseFormatCompatibilityReason]
          : []),
        ...(fallbackReasons.has(candidate.provider.providerId)
          ? [`temporary_runtime_fallback=${fallbackReasons.get(candidate.provider.providerId)}`]
          : []),
      ],
      currentConcurrency: candidate.currentConcurrency,
      maxConcurrency: candidate.maxConcurrency,
      estimatedLatencyMs,
      observedLatencyMs: candidate.successLatency.latencyMs,
      latencySource: candidate.successLatency.source,
      successLatencySampleCount: candidate.successLatency.sampleCount,
      qualityScore: candidate.accuracyScore,
      healthScore: candidate.healthScore,
      concurrencyScore: candidate.concurrencyScore,
      price: candidate.price,
      costSource: candidate.costSource,
      costMedian,
      effectiveCost: deliveryEconomics.effectiveCost,
      costIndex: deliveryEconomics.costIndex,
      deliveryValueIndex: deliveryEconomics.deliveryValueIndex,
    });
  }

  candidates.sort(compareSmartCandidates);

  return {
    mode: input.mode,
    candidates,
    filteredOut,
  };
}

export function classifyUpstreamFailure(input: {
  statusCode?: number;
  bodyText?: string;
  bodyJson?: unknown;
  fetchError?: unknown;
}): UpstreamFailureClassification {
  const statusCode = Number(input.statusCode || 0);
  const bodyText = String(input.bodyText || '').toLowerCase();
  const bodyJsonText = input.bodyJson ? JSON.stringify(input.bodyJson).toLowerCase() : '';
  const fetchErrorText = input.fetchError instanceof Error
    ? `${input.fetchError.name} ${input.fetchError.message}`.toLowerCase()
    : String(input.fetchError || '').toLowerCase();
  const haystack = `${bodyText}\n${bodyJsonText}\n${fetchErrorText}`;

  if (input.fetchError) {
    if (
      haystack.includes('timeout')
      || haystack.includes('timed out')
      || haystack.includes('aborterror')
      || haystack.includes('aborted')
      || haystack.includes('deadline')
    ) {
      return {
        category: 'retryable_timeout',
        shouldFailover: true,
        cooldownMs: 30_000,
      };
    }
    return {
      category: 'retryable_transport',
      shouldFailover: true,
      cooldownMs: 20_000,
    };
  }
  if (
    haystack.includes('timeout')
    || haystack.includes('deadline')
    || haystack.includes('unexpected eof')
    || haystack.includes('socket hang up')
    || haystack.includes('econnreset')
  ) {
    return {
      category: 'retryable_timeout',
      shouldFailover: true,
      cooldownMs: 30_000,
    };
  }
  const safetyMarkers = [
    'safety',
    'responses_safety_rejected',
    'safety_rejected',
    'safety rejected',
    'rejected by the safety system',
    'safety system',
    'generated images appear to be unsafe',
    'appear to be unsafe',
    'unsafe. try modifying',
    'content_policy',
    'content policy',
    'policy_violation',
    'policy violation',
    'sexualized',
    'sexual imagery',
    'sexualized imagery',
    'sexualized image',
    'bikini-focused',
    'lingerie',
    'non-sexual',
    'non-explicit',
    'safe fashion/editorial',
    'safer version',
    'cleaner, safer version',
    "can't help generate",
    "can't help create",
    'cannot help generate',
    'cannot help create',
    't help generate that image as requested',
    '安全规则拦截',
    '安全规则',
    '安全限制',
    '触发了安全',
    '不适合处理的内容',
    '明显性暗示',
    '明显的性暗示',
    '性暗示',
    '性感化',
    '性化倾向',
    '性化效果',
    '露骨',
    '非露骨',
    '敏感元素',
    '胸部细节',
    '性感化身体特征',
    '强化这类性感效果',
    '不能帮助生成或强化',
    '不能帮助处理这类',
    '不能继续按原图',
    '不能帮你基于这张图进行复刻或精修',
    '不能帮助把这张',
    '不能协助把这张',
    '被系统判定为涉及',
  ];
  if (safetyMarkers.some((marker) => haystack.includes(marker))) {
    return {
      category: 'terminal_safety',
      shouldFailover: false,
      cooldownMs: 0,
      affectsHealth: false,
    };
  }
  if (haystack.includes('overloaded') || haystack.includes('too many requests') || haystack.includes('server busy')) {
    return {
      category: 'retryable_overloaded',
      shouldFailover: true,
      cooldownMs: 45_000,
    };
  }
  const upstreamQuotaSignals = [
    'insufficient_quota',
    'insufficient_user_quota',
    'quota exceeded',
    'billing',
    'payment required',
    'balance',
    'credit',
    '订阅额度不足',
    '额度不足',
  ];
  if (statusCode === 429 && !upstreamQuotaSignals.some((signal) => haystack.includes(signal))) {
    return {
      category: 'retryable_rate_limit',
      shouldFailover: true,
      cooldownMs: 45_000,
    };
  }
  // These responses describe the selected upstream account, not the tenant's
  // request. Fuse that upstream and continue through smart_failover candidates.
  if (
    upstreamQuotaSignals.some((signal) => haystack.includes(signal))
  ) {
    return {
      category: 'retryable_upstream_quota',
      shouldFailover: true,
      cooldownMs: 0,
      affectsHealth: true,
    };
  }
  if (
    [401, 403].includes(statusCode)
    || haystack.includes('unauthorized')
    || haystack.includes('forbidden')
    || haystack.includes('invalid api key')
    || haystack.includes('invalid_api_key')
    || haystack.includes('incorrect api key')
    || haystack.includes('permission denied')
    || haystack.includes('access denied')
  ) {
    return {
      category: 'retryable_upstream_auth',
      shouldFailover: true,
      cooldownMs: 0,
      affectsHealth: true,
    };
  }
  if (
    haystack.includes('model_not_found')
    || haystack.includes('model not found')
    || haystack.includes('unknown model')
    || haystack.includes('unsupported model')
    || haystack.includes('unsupported endpoint')
    || haystack.includes('unsupported operation')
    || haystack.includes('capability')
  ) {
    return {
      category: 'retryable_upstream_capability',
      shouldFailover: true,
      cooldownMs: 5 * 60_000,
      affectsHealth: true,
    };
  }
  if ([400, 410, 415, 422].includes(statusCode)) {
    const userContentSignals = [
      'safety',
      'content policy',
      'policy_violation',
      'prompt',
      'reference image',
      'image input',
      'invalid image',
      'unsupported image',
    ];
    if (userContentSignals.some((signal) => haystack.includes(signal))) {
      return {
        category: 'terminal_user_content',
        shouldFailover: false,
        cooldownMs: 0,
        affectsHealth: false,
      };
    }
    return {
      category: 'terminal_invalid_request',
      shouldFailover: false,
      cooldownMs: 0,
      affectsHealth: false,
    };
  }
  if (statusCode >= 500) {
    if (statusCode === 502 || statusCode === 503 || statusCode === 504) {
      return {
        category: 'retryable_gateway',
        shouldFailover: true,
        cooldownMs: 30_000,
      };
    }
    return {
      category: 'retryable_status',
      shouldFailover: true,
      cooldownMs: 30_000,
    };
  }
  if (haystack.includes('not configured') || haystack.includes('config')) {
    return {
      category: 'terminal_config',
      shouldFailover: false,
      cooldownMs: 0,
      affectsHealth: false,
    };
  }
  if (haystack.includes('unsupported') || haystack.includes('capability')) {
    return {
      category: 'terminal_capability',
      shouldFailover: false,
      cooldownMs: 0,
      affectsHealth: false,
    };
  }
  return {
    category: statusCode >= 400 ? 'retryable_status' : 'terminal_unknown',
    shouldFailover: statusCode >= 400,
    cooldownMs: statusCode >= 400 ? 20_000 : 0,
    affectsHealth: statusCode >= 400 ? true : false,
  };
}
