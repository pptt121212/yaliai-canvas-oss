import assert from 'node:assert/strict';

// The routing planner is pure for a single candidate and does not need a
// running database or Redis connection for this verification.
process.env.DATABASE_URL ||= 'postgresql://localhost:5432/yali_disabled_provider_check';
delete process.env.REDIS_URL;

const { hotStateStore } = await import('../apps/api/dist/src/modules/storage/runtimeStores.js');
const { buildSmartImageRoutingPlan } = await import('../apps/api/dist/src/smartImageRouting.js');

const provider = {
  providerId: 'disabled-provider-test',
  source: 'admin_managed',
  baseUrl: 'https://disabled.example.test/v1/images/generations',
  protocol: 'openai_images',
  healthState: 'disabled',
  healthScore: 100,
  supportsImage: true,
  capability: {
    supportsSync: true,
    supportsAsync: true,
    supportsImageGeneration: true,
    supportsImageEdit: true,
  },
};

// This reproduces the production fault: a historical successful snapshot
// remains in hot state after the administrator disables the provider.
hotStateStore.setProviderRuntime(provider.providerId, {
  healthState: 'healthy',
  healthScore: 100,
  lastSuccessAt: Date.now(),
  lastHealthEvidenceAt: Date.now(),
});

const plan = await buildSmartImageRoutingPlan({
  providers: [provider],
  mode: 'smart_failover',
  context: {
    operation: 'generations',
    requestedSize: '1024x1024',
    requestMode: 'sync',
    requestedModel: 'gpt-image-2',
    protocolFamily: 'openai_image',
  },
});

assert.equal(plan.candidates.length, 0, 'a disabled provider must not become a candidate from hot health state');
assert.deepEqual(plan.filteredOut, [{ providerId: provider.providerId, reason: 'disabled' }]);

console.log('Disabled provider routing verification passed.');
