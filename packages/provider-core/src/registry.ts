import type {
  ProviderAttemptReport,
  ProviderConfig,
  ProviderRegistry,
  ProviderRuntimeState,
} from './types.js';

type RegistryStore = {
  config: ProviderConfig;
  runtime: ProviderRuntimeState;
};

const DEFAULT_EWMA_SUCCESS_RATE = 0.8;
const DEFAULT_EWMA_ALPHA = 0.3;
const DEFAULT_LATENCY_ALPHA = 0.25;
const SLOW_REQUEST_MS = 120_000;
const FUSE_AUTH_MS = 60 * 60 * 1000;
const FUSE_REPEATED_FAILURE_MS = 30 * 60 * 1000;
const RUNTIME_RECOVERY_MS = 6 * 60 * 60 * 1000;
const COOLDOWN_RATE_LIMIT_MS = 3 * 60 * 1000;
const COOLDOWN_OVERLOAD_MS = 10 * 60 * 1000;
const COOLDOWN_TIMEOUT_MS = 5 * 60 * 1000;
const COOLDOWN_SERVER_ERROR_MS = 5 * 60 * 1000;
const COOLDOWN_TRANSPORT_MS = 3 * 60 * 1000;
const COOLDOWN_FAILURE_STREAK_MS = 5 * 60 * 1000;
const CONSECUTIVE_FAILURE_FUSE_THRESHOLD = 16;
const CONSECUTIVE_TIMEOUT_FUSE_THRESHOLD = 10;
const CONSECUTIVE_FAILURE_COOLDOWN_THRESHOLD = 2;
const CONSECUTIVE_SLOW_COOLDOWN_THRESHOLD = 2;

function clampNumber(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function ewma(previous: number, next: number, alpha: number) {
  return alpha * next + (1 - alpha) * previous;
}

function normalizeRuntimeState(runtime: ProviderRuntimeState | undefined, config: ProviderConfig): ProviderRuntimeState {
  const baseHealthScore = Number(config.healthScore || 100);
  return {
    healthState: runtime?.healthState || config.healthState || 'healthy',
    healthScore: Number.isFinite(Number(runtime?.healthScore)) ? Number(runtime?.healthScore) : baseHealthScore,
    cooldownUntil: runtime?.cooldownUntil,
    fusedUntil: runtime?.fusedUntil,
    recoveryStartedAt: runtime?.recoveryStartedAt,
    recoveryUntil: runtime?.recoveryUntil,
    recoveryScoreFloor: runtime?.recoveryScoreFloor,
    lastCheckedAt: runtime?.lastCheckedAt,
    lastSelectedAt: runtime?.lastSelectedAt,
    lastSuccessAt: runtime?.lastSuccessAt,
    lastFailureAt: runtime?.lastFailureAt,
    failureCount: Math.max(0, Number(runtime?.failureCount || 0)),
    successCount: Math.max(0, Number(runtime?.successCount || 0)),
    timeoutCount: Math.max(0, Number(runtime?.timeoutCount || 0)),
    slowCount: Math.max(0, Number(runtime?.slowCount || 0)),
    consecutiveTimeouts: Math.max(0, Number(runtime?.consecutiveTimeouts || 0)),
    consecutiveSlowRequests: Math.max(0, Number(runtime?.consecutiveSlowRequests || 0)),
    consecutiveFailures: Math.max(0, Number(runtime?.consecutiveFailures || 0)),
    ewmaSuccessRate: Number.isFinite(Number(runtime?.ewmaSuccessRate))
      ? clampNumber(Number(runtime?.ewmaSuccessRate), 0, 1)
      : DEFAULT_EWMA_SUCCESS_RATE,
    ewmaSuccessLatencyMs: Math.max(0, Number(runtime?.ewmaSuccessLatencyMs || 0)),
    ewmaLatencyMs: Math.max(0, Number(runtime?.ewmaLatencyMs || 0)),
    lastErrorCategory: runtime?.lastErrorCategory || '',
    lastErrorMessage: runtime?.lastErrorMessage || '',
    lastHttpStatus: Math.max(0, Number(runtime?.lastHttpStatus || 0)),
  };
}

function hasUnrecoveredFailure(runtime: ProviderRuntimeState) {
  return Boolean(
    runtime.lastFailureAt
    && (!runtime.lastSuccessAt || runtime.lastSuccessAt <= runtime.lastFailureAt),
  );
}

function resolveRecoveryWindow(runtime: ProviderRuntimeState) {
  const configuredStart = Number(runtime.recoveryStartedAt || 0);
  const configuredUntil = Number(runtime.recoveryUntil || 0);
  if (configuredStart > 0 && configuredUntil > configuredStart) {
    return { start: configuredStart, until: configuredUntil };
  }
  if (!hasUnrecoveredFailure(runtime)) {
    return null;
  }
  const lastFailureAt = Number(runtime.lastFailureAt || 0);
  if (lastFailureAt <= 0) {
    return null;
  }
  const isAuthLike = runtime.lastErrorCategory === 'terminal_auth'
    || runtime.lastHttpStatus === 401
    || runtime.lastHttpStatus === 403;
  const start = lastFailureAt + (isAuthLike ? FUSE_AUTH_MS : COOLDOWN_FAILURE_STREAK_MS);
  return { start, until: start + RUNTIME_RECOVERY_MS };
}

function interpolateRecoveryScore(floor: number, baseline: number, progress: number) {
  const normalizedProgress = clampNumber(progress, 0, 1);
  return Math.round(floor + (baseline - floor) * normalizedProgress);
}

export function resolveProviderRuntimeForRead(
  runtime: ProviderRuntimeState | undefined,
  config: ProviderConfig,
  now = Date.now(),
): ProviderRuntimeState {
  const next = normalizeRuntimeState(runtime, config);
  const cooldownExpired = Boolean(next.cooldownUntil && next.cooldownUntil <= now);
  const fusedExpired = Boolean(next.fusedUntil && next.fusedUntil <= now);
  const hasActiveBlock = Boolean(
    (next.cooldownUntil && next.cooldownUntil > now)
    || (next.fusedUntil && next.fusedUntil > now),
  );
  if (hasActiveBlock) {
    next.healthState = 'cooling';
    next.healthScore = deriveRuntimeHealthScore(next, config, now);
    return next;
  }

  if (cooldownExpired) {
    next.cooldownUntil = undefined;
  }
  if (fusedExpired) {
    next.fusedUntil = undefined;
  }
  const recovery = resolveRecoveryWindow(next);
  const baselineScore = deriveRuntimeHealthScore(next, config, now);
  if (recovery) {
    const progress = (now - recovery.start) / Math.max(1, recovery.until - recovery.start);
    const scoreFloor = Math.max(1, Number(next.recoveryScoreFloor || next.healthScore || baselineScore));
    next.healthScore = interpolateRecoveryScore(scoreFloor, baselineScore, progress);
    next.healthState = progress >= 1 ? 'healthy' : 'degraded';
    return next;
  }
  next.healthState = 'healthy';
  next.healthScore = baselineScore;
  return next;
}

function deriveRuntimeHealthScore(runtime: ProviderRuntimeState, config: ProviderConfig, now: number) {
  let score = 120;
  score += Math.round(clampNumber(Number(runtime.ewmaSuccessRate || DEFAULT_EWMA_SUCCESS_RATE), 0, 1) * 40);
  score -= Math.min(80, Math.max(0, Number(runtime.consecutiveFailures || 0)) * 18);
  score -= Math.min(70, Math.max(0, Number(runtime.consecutiveTimeouts || 0)) * 25);

  const latency = Math.max(0, Number(runtime.ewmaLatencyMs || 0));
  if (latency > 120_000) {
    score -= 35;
  } else if (latency > 90_000) {
    score -= 25;
  } else if (latency > 60_000) {
    score -= 15;
  } else if (latency > 0 && latency < 30_000) {
    score += 10;
  }

  if (runtime.fusedUntil && runtime.fusedUntil > now) {
    score -= 220;
  } else if (runtime.cooldownUntil && runtime.cooldownUntil > now) {
    score -= 90;
  }

  score = clampNumber(score, -200, 200);
  const normalized = Math.round(clampNumber(((score + 200) / 400) * 100, 0, 100));
  return Math.max(1, normalized || Math.round(Number(config.healthScore || 100)) || 1);
}

function resolveFailureGovernance(report: ProviderAttemptReport) {
  const statusCode = Math.max(0, Number(report.statusCode || 0));
  const category = String(report.failureCategory || '').trim().toLowerCase();
  const message = String(report.errorMessage || '').trim().toLowerCase();
  const timeoutLike = category === 'retryable_timeout'
    || category === 'provider_timeout'
    || message.includes('timeout')
    || message.includes('timed out')
    || message.includes('abort')
    || message.includes('deadline');
  const overloadedLike = category === 'retryable_overloaded'
    || message.includes('overload')
    || message.includes('overloaded')
    || message.includes('server busy')
    || message.includes('busy');
  const transportLike = category === 'retryable_transport'
    || category === 'retryable_gateway'
    || category === 'retryable_status'
    || category === 'retryable_upstream_capability';

  if (
    statusCode === 401
    || statusCode === 403
    || category === 'terminal_auth'
    || category === 'retryable_upstream_auth'
    || category === 'retryable_upstream_quota'
  ) {
    return {
      cooldownMs: FUSE_AUTH_MS,
      nextState: 'fused' as const,
      isTimeoutLike: false,
      isSlowLike: false,
      countsAsHealthFailure: report.affectsHealth !== false,
    };
  }
  if (statusCode === 429 || category === 'retryable_rate_limit') {
    return {
      cooldownMs: Math.max(report.cooldownMs || 0, COOLDOWN_RATE_LIMIT_MS),
      nextState: 'cooling' as const,
      isTimeoutLike: false,
      isSlowLike: false,
      countsAsHealthFailure: false,
    };
  }
  if (overloadedLike || statusCode === 529) {
    return {
      cooldownMs: Math.max(report.cooldownMs || 0, COOLDOWN_OVERLOAD_MS),
      nextState: 'cooling' as const,
      isTimeoutLike: false,
      isSlowLike: false,
      countsAsHealthFailure: report.affectsHealth !== false,
    };
  }
  if (timeoutLike) {
    return {
      cooldownMs: Math.max(report.cooldownMs || 0, COOLDOWN_TIMEOUT_MS),
      nextState: 'cooling' as const,
      isTimeoutLike: true,
      isSlowLike: true,
      countsAsHealthFailure: report.affectsHealth !== false,
    };
  }
  if (statusCode >= 500 || transportLike) {
    return {
      cooldownMs: Math.max(report.cooldownMs || 0, statusCode >= 500 ? COOLDOWN_SERVER_ERROR_MS : COOLDOWN_TRANSPORT_MS),
      nextState: 'cooling' as const,
      isTimeoutLike: false,
      isSlowLike: false,
      countsAsHealthFailure: report.affectsHealth !== false,
    };
  }
  if (report.affectsHealth === false) {
    return {
      cooldownMs: Math.max(0, Number(report.cooldownMs || 0)),
      nextState: (report.cooldownMs || 0) > 0 ? 'cooling' as const : 'healthy' as const,
      isTimeoutLike: false,
      isSlowLike: false,
      countsAsHealthFailure: false,
    };
  }
  return {
    cooldownMs: Math.max(report.cooldownMs || 0, COOLDOWN_FAILURE_STREAK_MS),
    nextState: 'degraded' as const,
    isTimeoutLike: false,
    isSlowLike: false,
    countsAsHealthFailure: true,
  };
}

function normalizeProvider(provider: ProviderConfig): ProviderConfig {
  return {
    priority: 100,
    weight: 100,
    healthScore: 100,
    healthState: 'healthy',
    protocol: 'openai_images',
    capability: {
      supportsAsync: true,
      supportsSync: true,
      supportsImageGeneration: true,
      supportsImageEdit: true,
      supportsVideoGeneration: false,
      supportsReferenceImages: true,
    },
    ...provider,
  };
}

function readSeedRuntime(provider: ProviderConfig): ProviderRuntimeState | undefined {
  const runtime = provider.metadata?.runtime;
  if (!runtime || typeof runtime !== 'object' || Array.isArray(runtime)) {
    return undefined;
  }
  return runtime as ProviderRuntimeState;
}

export function createInMemoryProviderRegistry(seed: ProviderConfig[] = []): ProviderRegistry {
  const providers = new Map<string, RegistryStore>();

  for (const item of seed) {
    const normalized = normalizeProvider(item);
    providers.set(normalized.providerId, {
      config: normalized,
      runtime: normalizeRuntimeState(readSeedRuntime(normalized), normalized),
    });
  }

  return {
    list() {
      return Array.from(providers.values()).map((item) => ({
        ...item.config,
        healthScore: Number(resolveProviderRuntimeForRead(item.runtime, item.config).healthScore || item.config.healthScore || 100),
        healthState: resolveProviderRuntimeForRead(item.runtime, item.config).healthState || item.config.healthState,
        metadata: {
          ...(item.config.metadata || {}),
          runtime: resolveProviderRuntimeForRead(item.runtime, item.config),
        },
      }));
    },
    get(providerId) {
      const item = providers.get(providerId);
      if (!item) {
        return null;
      }
      return {
        ...item.config,
        healthScore: Number(resolveProviderRuntimeForRead(item.runtime, item.config).healthScore || item.config.healthScore || 100),
        healthState: resolveProviderRuntimeForRead(item.runtime, item.config).healthState || item.config.healthState,
        metadata: {
          ...(item.config.metadata || {}),
          runtime: resolveProviderRuntimeForRead(item.runtime, item.config),
        },
      };
    },
    getRuntimeState(providerId) {
      const item = providers.get(providerId);
      return item ? { ...resolveProviderRuntimeForRead(item.runtime, item.config) } : null;
    },
    register(provider) {
      const normalized = normalizeProvider(provider);
      providers.set(normalized.providerId, {
        config: normalized,
        runtime: normalizeRuntimeState(readSeedRuntime(normalized), normalized),
      });
    },
    reportAttempt(report) {
      const item = providers.get(report.providerId);
      if (!item) {
        return;
      }
      item.runtime = computeProviderRuntimeAfterAttempt(item.config, item.runtime, report);
    },
  };
}

export function computeProviderRuntimeAfterAttempt(
  provider: ProviderConfig,
  currentRuntime: ProviderRuntimeState | null | undefined,
  report: ProviderAttemptReport,
): ProviderRuntimeState {
  const config = normalizeProvider(provider);
  const now = report.failedAt || Date.now();
  const runtime = normalizeRuntimeState(currentRuntime || readSeedRuntime(config), config);
  runtime.lastSelectedAt = now;
  runtime.lastCheckedAt = now;
  if (report.ok) {
    const latencyMs = Math.max(0, Number(report.latencyMs || 0));
    runtime.lastSuccessAt = now;
    runtime.successCount = Math.max(0, Number(runtime.successCount || 0)) + 1;
    runtime.consecutiveFailures = 0;
    runtime.consecutiveTimeouts = 0;
    runtime.consecutiveSlowRequests = latencyMs >= SLOW_REQUEST_MS
      ? Math.max(0, Number(runtime.consecutiveSlowRequests || 0) - 1)
      : 0;
    runtime.ewmaSuccessRate = ewma(
      Number(runtime.ewmaSuccessRate || DEFAULT_EWMA_SUCCESS_RATE),
      1,
      DEFAULT_EWMA_ALPHA,
    );
    runtime.ewmaLatencyMs = latencyMs > 0
      ? Math.round(ewma(Number(runtime.ewmaLatencyMs || latencyMs), latencyMs, DEFAULT_LATENCY_ALPHA))
      : Number(runtime.ewmaLatencyMs || 0);
    runtime.ewmaSuccessLatencyMs = latencyMs > 0
      ? Math.round(ewma(Number(runtime.ewmaSuccessLatencyMs || latencyMs), latencyMs, DEFAULT_LATENCY_ALPHA))
      : Number(runtime.ewmaSuccessLatencyMs || 0);
    runtime.cooldownUntil = undefined;
    runtime.fusedUntil = undefined;
    runtime.recoveryStartedAt = undefined;
    runtime.recoveryUntil = undefined;
    runtime.recoveryScoreFloor = undefined;
    runtime.healthState = 'healthy';
    runtime.lastErrorCategory = '';
    runtime.lastErrorMessage = '';
    runtime.lastHttpStatus = Math.max(0, Number(report.statusCode || 0));
    runtime.healthScore = deriveRuntimeHealthScore(runtime, config, now);
    return runtime;
  }

  const latencyMs = Math.max(0, Number(report.latencyMs || 0));
  const governance = resolveFailureGovernance(report);
  if (report.affectsHealth === false && governance.cooldownMs <= 0) {
    return runtime;
  }
  runtime.recoveryStartedAt = undefined;
  runtime.recoveryUntil = undefined;
  runtime.recoveryScoreFloor = undefined;
  runtime.lastFailureAt = now;
  runtime.lastErrorCategory = String(report.failureCategory || '').trim();
  runtime.lastErrorMessage = String(report.errorMessage || '').trim();
  runtime.lastHttpStatus = Math.max(0, Number(report.statusCode || 0));
  runtime.ewmaSuccessRate = ewma(
    Number(runtime.ewmaSuccessRate || DEFAULT_EWMA_SUCCESS_RATE),
    governance.countsAsHealthFailure ? 0 : Number(runtime.ewmaSuccessRate || DEFAULT_EWMA_SUCCESS_RATE),
    governance.countsAsHealthFailure ? DEFAULT_EWMA_ALPHA : 0.1,
  );
  runtime.ewmaLatencyMs = latencyMs > 0
    ? Math.round(ewma(Number(runtime.ewmaLatencyMs || latencyMs), latencyMs, DEFAULT_LATENCY_ALPHA))
    : Number(runtime.ewmaLatencyMs || 0);

  if (governance.countsAsHealthFailure) {
    runtime.failureCount = Math.max(0, Number(runtime.failureCount || 0)) + 1;
    runtime.consecutiveFailures = Math.max(0, Number(runtime.consecutiveFailures || 0)) + 1;
  }
  if (governance.isTimeoutLike) {
    runtime.timeoutCount = Math.max(0, Number(runtime.timeoutCount || 0)) + 1;
    runtime.consecutiveTimeouts = Math.max(0, Number(runtime.consecutiveTimeouts || 0)) + 1;
  } else {
    runtime.consecutiveTimeouts = 0;
  }
  if (governance.isSlowLike || latencyMs >= SLOW_REQUEST_MS) {
    runtime.slowCount = Math.max(0, Number(runtime.slowCount || 0)) + 1;
    runtime.consecutiveSlowRequests = Math.max(0, Number(runtime.consecutiveSlowRequests || 0)) + 1;
  } else {
    runtime.consecutiveSlowRequests = 0;
  }

  const consecutiveFailures = Math.max(0, Number(runtime.consecutiveFailures || 0));
  const consecutiveTimeouts = Math.max(0, Number(runtime.consecutiveTimeouts || 0));
  const consecutiveSlowRequests = Math.max(0, Number(runtime.consecutiveSlowRequests || 0));

  if (
    consecutiveFailures >= CONSECUTIVE_FAILURE_FUSE_THRESHOLD
    || consecutiveTimeouts >= CONSECUTIVE_TIMEOUT_FUSE_THRESHOLD
    || governance.nextState === 'fused'
  ) {
    runtime.fusedUntil = now + Math.max(governance.cooldownMs, FUSE_REPEATED_FAILURE_MS);
    runtime.cooldownUntil = undefined;
    runtime.healthState = 'cooling';
    runtime.recoveryStartedAt = runtime.fusedUntil;
    runtime.recoveryUntil = runtime.fusedUntil + RUNTIME_RECOVERY_MS;
  } else if (
    governance.cooldownMs > 0
    || consecutiveFailures >= CONSECUTIVE_FAILURE_COOLDOWN_THRESHOLD
    || consecutiveSlowRequests >= CONSECUTIVE_SLOW_COOLDOWN_THRESHOLD
  ) {
    const streakCooldownMs = consecutiveFailures >= CONSECUTIVE_FAILURE_COOLDOWN_THRESHOLD
      || consecutiveSlowRequests >= CONSECUTIVE_SLOW_COOLDOWN_THRESHOLD
      ? COOLDOWN_FAILURE_STREAK_MS
      : 0;
    runtime.cooldownUntil = now + Math.max(governance.cooldownMs, streakCooldownMs);
    runtime.healthState = 'cooling';
    runtime.recoveryStartedAt = runtime.cooldownUntil;
    runtime.recoveryUntil = runtime.cooldownUntil + RUNTIME_RECOVERY_MS;
  } else {
    runtime.cooldownUntil = undefined;
    runtime.healthState = governance.nextState;
    runtime.recoveryStartedAt = now;
    runtime.recoveryUntil = now + RUNTIME_RECOVERY_MS;
  }

  if (runtime.fusedUntil && runtime.fusedUntil <= now) {
    runtime.fusedUntil = undefined;
    if (runtime.healthState === 'cooling') {
      runtime.healthState = consecutiveFailures > 0 ? 'degraded' : 'healthy';
    }
  }
  if (runtime.cooldownUntil && runtime.cooldownUntil <= now) {
    runtime.cooldownUntil = undefined;
    if (runtime.healthState === 'cooling') {
      runtime.healthState = consecutiveFailures > 0 ? 'degraded' : 'healthy';
    }
  }
  runtime.healthScore = deriveRuntimeHealthScore(runtime, config, now);
  if (runtime.recoveryStartedAt && runtime.recoveryUntil) {
    runtime.recoveryScoreFloor = runtime.healthScore;
  }
  return runtime;
}
