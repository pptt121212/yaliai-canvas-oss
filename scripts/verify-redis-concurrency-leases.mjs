import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createClient } from '../apps/api/node_modules/redis/dist/index.js';
import { createRedisAtomicCounters } from '../apps/api/dist/src/modules/storage/redisAtomicCounters.js';

const redisUrl = process.env.LEASE_TEST_REDIS_URL || 'redis://127.0.0.1:6399';
const prefix = `lease_test_${randomUUID().replaceAll('-', '')}`;
const counters = createRedisAtomicCounters({ url: redisUrl, prefix });
const admin = createClient({ url: redisUrl });

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function current(key) {
  const states = await counters.inspectConcurrencyLeases([key]);
  return states[0]?.state.current ?? 0;
}

await admin.connect();
try {
  const first = await counters.acquireConcurrencyLease('provider:test', 2, 5, 'first');
  const second = await counters.acquireConcurrencyLease('provider:test', 2, 5, 'second');
  const rejected = await counters.acquireConcurrencyLease('provider:test', 2, 5, 'third');
  assert.equal(first.allowed, true, 'first lease should be admitted');
  assert.equal(second.allowed, true, 'second lease should be admitted');
  assert.equal(rejected.allowed, false, 'max concurrency must reject a third lease');
  assert.equal(await current('provider:test'), 2, 'two active leases must be visible to routing');

  await counters.releaseConcurrencyLease(first.lease);
  assert.equal(await current('provider:test'), 1, 'releasing one lease must not release another request');
  const third = await counters.acquireConcurrencyLease('provider:test', 2, 5, 'third');
  assert.equal(third.allowed, true, 'a released slot should be immediately reusable');
  await counters.releaseConcurrencyLease(second.lease);
  await counters.releaseConcurrencyLease(third.lease);
  assert.equal(await current('provider:test'), 0, 'all released leases must leave no residual concurrency');

  // Separate Redis clients emulate multiple PM2 gateway processes attempting
  // to reserve the same Provider at once.
  const contenderClients = Array.from({ length: 40 }, () => createRedisAtomicCounters({ url: redisUrl, prefix }));
  try {
    const contentionResults = await Promise.all(contenderClients.map(async (client, index) => ({
      client,
      result: await client.acquireConcurrencyLease('provider:contention', 7, 5, `contender-${index}`),
    })));
    const admitted = contentionResults.filter((item) => item.result.allowed);
    assert.equal(admitted.length, 7, 'atomic admission must cap concurrent PM2 contenders exactly at the configured max');
    assert.equal(await current('provider:contention'), 7, 'routing must observe every admitted contender');
    await Promise.all(admitted.map((item) => item.client.releaseConcurrencyLease(item.result.lease)));
    assert.equal(await current('provider:contention'), 0, 'parallel releases must leave no phantom slots');
  } finally {
    await Promise.all(contenderClients.map((client) => client.close()));
  }

  const renewed = await counters.acquireConcurrencyLease('provider:renew', 1, 5, 'renewed');
  assert.equal(renewed.allowed, true);
  await sleep(3_000);
  assert.equal((await counters.renewConcurrencyLease(renewed.lease)).allowed, true, 'an active lease must renew');
  await sleep(3_000);
  assert.equal(await current('provider:renew'), 1, 'renewal must prevent premature expiry');
  await counters.releaseConcurrencyLease(renewed.lease);

  const abandoned = await counters.acquireConcurrencyLease('provider:abandoned', 1, 5, 'abandoned');
  assert.equal(abandoned.allowed, true);
  await sleep(5_300);
  assert.equal(await current('provider:abandoned'), 0, 'an unreleased lease must recover after its own expiry');

  const legacyKey = `${prefix}:concurrency:provider:legacy`;
  await admin.set(legacyKey, JSON.stringify({
    key: 'provider:legacy',
    current: 1,
    max: 1,
    updatedAt: Date.now(),
    expiresAt: Date.now() + 60_000,
  }), { EX: 60 });
  const blockedByLegacyWorker = await counters.acquireConcurrencyLease('provider:legacy', 1, 5, 'new-worker');
  assert.equal(blockedByLegacyWorker.allowed, false, 'new leases must honor draining legacy workers');
  await admin.del(legacyKey);
  const afterLegacyDrain = await counters.acquireConcurrencyLease('provider:legacy', 1, 5, 'new-worker');
  assert.equal(afterLegacyDrain.allowed, true, 'the slot should be available after legacy worker release');
  await counters.releaseConcurrencyLease(afterLegacyDrain.lease);

  const manyStates = await counters.inspectConcurrencyLeases([
    'provider:test',
    'provider:renew',
    'provider:abandoned',
    'provider:legacy',
  ]);
  assert.deepEqual(
    manyStates.map((item) => item.state.current),
    [0, 0, 0, 0],
    'batched routing reads must report the final aggregate state for every provider',
  );

  console.log('Redis request-level concurrency lease verification passed.');
} finally {
  await admin.close();
  await counters.close();
}
