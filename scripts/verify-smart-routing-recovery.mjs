import assert from 'node:assert/strict';
import {
  computeProviderRuntimeAfterAttempt,
  resolveProviderRuntimeForRead,
} from '../packages/provider-core/dist/src/index.js';
import { isPassiveRecoveryReentryProvider } from '../apps/api/dist/src/modules/routing/passiveRecovery.js';

const provider = {
  providerId: 'recovery-test-provider',
  source: 'platform',
  baseUrl: 'https://example.test/v1/images/generations',
  healthScore: 100,
  healthState: 'healthy',
};
const failedAt = 1_800_000_000_000;
const failed = computeProviderRuntimeAfterAttempt(provider, null, {
  providerId: provider.providerId,
  ok: false,
  statusCode: 504,
  failedAt,
  latencyMs: 180_000,
  failureCategory: 'retryable_timeout',
  affectsHealth: true,
});
const rawFailureRate = failed.ewmaSuccessRate;
const rawFailureStreak = failed.consecutiveFailures;
const recoveredAt = failedAt + 2 * 60 * 60 * 1000;
const recovered = resolveProviderRuntimeForRead(failed, provider, recoveredAt);

assert.ok(recovered.healthEvidenceFreshness < 0.1, 'stale evidence must lose most of its weight');
assert.ok(recovered.ewmaSuccessRate > rawFailureRate, 'success rate must return toward neutral over time');
assert.ok(recovered.consecutiveFailures < rawFailureStreak, 'failure pressure must decay over time');
assert.equal(failed.consecutiveFailures, rawFailureStreak, 'read-side decay must not mutate stored runtime');

const refreshed = computeProviderRuntimeAfterAttempt(provider, failed, {
  providerId: provider.providerId,
  ok: true,
  statusCode: 200,
  failedAt: recoveredAt,
  latencyMs: 30_000,
  affectsHealth: false,
});
assert.equal(refreshed.lastHealthEvidenceAt, recoveredAt, 'a real success must refresh health evidence');
assert.ok(refreshed.ewmaSuccessRate > recovered.ewmaSuccessRate, 'new success must improve the decayed evidence');

const reentryProvider = {
  ...provider,
  metadata: {
    runtime: {
      lastFailureAt: failedAt,
      lastSuccessAt: failedAt - 1,
      lastErrorCategory: 'retryable_timeout',
      healthEvidenceAgeMs: 2 * 60 * 60 * 1000,
      healthEvidenceFreshness: 0.07,
    },
  },
};
assert.equal(isPassiveRecoveryReentryProvider(reentryProvider, recoveredAt), true, 'stale technical failure must become eligible for recovery verification');
assert.equal(isPassiveRecoveryReentryProvider({
  ...reentryProvider,
  metadata: { runtime: { ...reentryProvider.metadata.runtime, cooldownUntil: recoveredAt + 1 } },
}, recoveredAt), false, 'active cooldown must block reentry');
assert.equal(isPassiveRecoveryReentryProvider({
  ...reentryProvider,
  metadata: { runtime: { ...reentryProvider.metadata.runtime, lastErrorCategory: 'terminal_auth' } },
}, recoveredAt), false, 'terminal authentication failures must never reenter automatically');
assert.equal(isPassiveRecoveryReentryProvider({
  ...reentryProvider,
  metadata: { runtime: { ...reentryProvider.metadata.runtime, lastErrorCategory: 'retryable_upstream_quota' } },
}, recoveredAt), false, 'upstream quota failures must never enter recovery verification');
assert.equal(isPassiveRecoveryReentryProvider({
  ...reentryProvider,
  metadata: { runtime: { ...reentryProvider.metadata.runtime, lastSuccessAt: recoveredAt } },
}, recoveredAt), false, 'a newer real success ends the recovery reentry state');

const firstVerification = computeProviderRuntimeAfterAttempt(provider, failed, {
  providerId: provider.providerId,
  ok: true,
  statusCode: 200,
  failedAt: recoveredAt,
  latencyMs: 30_000,
  affectsHealth: false,
  passiveRecoveryReentry: true,
});
assert.equal(firstVerification.recoveryCampaignAttempts, 1, 'first recovery success starts the campaign');
assert.equal(firstVerification.recoveryCampaignSuccesses, 1, 'first recovery success is recorded');
assert.equal(isPassiveRecoveryReentryProvider({
  ...provider,
  metadata: { runtime: resolveProviderRuntimeForRead(firstVerification, provider, recoveredAt + 30 * 60 * 1000) },
}, recoveredAt + 30 * 60 * 1000), true, 'a successful first verification permits the spaced second verification');

const secondVerification = computeProviderRuntimeAfterAttempt(provider, firstVerification, {
  providerId: provider.providerId,
  ok: true,
  statusCode: 200,
  failedAt: recoveredAt + 30 * 60 * 1000,
  latencyMs: 30_000,
  affectsHealth: false,
  passiveRecoveryReentry: true,
});
assert.equal(secondVerification.recoveryCampaignSuccesses, 2, 'second recovery success remains in the campaign');

const completedVerification = computeProviderRuntimeAfterAttempt(provider, secondVerification, {
  providerId: provider.providerId,
  ok: true,
  statusCode: 200,
  failedAt: recoveredAt + 60 * 60 * 1000,
  latencyMs: 30_000,
  affectsHealth: false,
  passiveRecoveryReentry: true,
});
assert.equal(completedVerification.recoveryCampaignSuccesses, undefined, 'third recovery success ends the campaign');
assert.equal(isPassiveRecoveryReentryProvider({
  ...provider,
  metadata: { runtime: resolveProviderRuntimeForRead(completedVerification, provider, recoveredAt + 60 * 60 * 1000) },
}, recoveredAt + 60 * 60 * 1000), false, 'completed campaign returns to normal ranking only');

const abortedVerification = computeProviderRuntimeAfterAttempt(provider, firstVerification, {
  providerId: provider.providerId,
  ok: false,
  statusCode: 503,
  failedAt: recoveredAt + 30 * 60 * 1000,
  latencyMs: 1_000,
  failureCategory: 'retryable_gateway',
  affectsHealth: true,
  passiveRecoveryReentry: true,
});
assert.equal(abortedVerification.recoveryCampaignSuccesses, undefined, 'a technical verification failure ends the campaign');

console.log('Smart routing passive recovery verification passed.');
