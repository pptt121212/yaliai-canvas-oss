import type { ProviderConfig } from '@yali/provider-core';

export const passiveRecoveryReentryMinAgeMs = 30 * 60 * 1000;
export const passiveRecoveryReentryIntervalSeconds = 30 * 60;

function isTerminalRecoveryFailureCategory(value: unknown) {
  const category = String(value || '').trim();
  return category.startsWith('terminal_')
    || category === 'retryable_upstream_auth'
    || category === 'retryable_upstream_quota'
    || category === 'retryable_upstream_capability';
}

// A recovered line needs a real downstream request before it can earn a new
// health record. This only identifies safe candidates; the caller owns the
// shared frequency lease and the final fallback chain.
export function isPassiveRecoveryReentryProvider(provider: ProviderConfig, now = Date.now()) {
  const runtime = provider.metadata?.runtime as {
    cooldownUntil?: unknown;
    fusedUntil?: unknown;
    lastFailureAt?: unknown;
    lastSuccessAt?: unknown;
    lastHealthEvidenceAt?: unknown;
    lastErrorCategory?: unknown;
    healthEvidenceAgeMs?: unknown;
    healthEvidenceFreshness?: unknown;
  } | undefined;
  if (!runtime || isTerminalRecoveryFailureCategory(runtime.lastErrorCategory)) {
    return false;
  }
  const unavailableUntil = Math.max(Number(runtime.cooldownUntil || 0), Number(runtime.fusedUntil || 0));
  if (unavailableUntil > now) {
    return false;
  }
  const lastFailureAt = Number(runtime.lastFailureAt || 0);
  const lastSuccessAt = Number(runtime.lastSuccessAt || 0);
  const lastHealthEvidenceAt = Number(runtime.lastHealthEvidenceAt || 0);
  const evidenceAgeMs = Math.max(0, Number(runtime.healthEvidenceAgeMs || 0));
  const evidenceFreshness = Math.max(0, Math.min(1, Number(runtime.healthEvidenceFreshness || 1)));
  return lastFailureAt > 0
    && lastFailureAt > lastSuccessAt
    // A rate-limit/concurrency event may set lastFailureAt without counting as
    // health evidence. It must not manufacture a recovery reentry.
    && (lastHealthEvidenceAt <= 0 || lastHealthEvidenceAt >= lastFailureAt)
    && evidenceAgeMs >= passiveRecoveryReentryMinAgeMs
    && evidenceFreshness <= 0.512;
}
