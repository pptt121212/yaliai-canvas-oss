import assert from 'node:assert/strict';
import {
  normalizeOperationalPartitionTimestamp,
  operationalPartitionName,
  startOfNextUtcMonth,
  startOfUtcMonth,
} from '../modules/storage/operationalPartitions.js';

function main() {
  const june = Date.UTC(2026, 5, 30, 23, 59, 59);
  const july = Date.UTC(2026, 6, 1, 0, 0, 0);

  assert.equal(startOfUtcMonth(june), Date.UTC(2026, 5, 1));
  assert.equal(startOfNextUtcMonth(june), Date.UTC(2026, 6, 1));
  assert.equal(operationalPartitionName('billing_ledger', june), 'billing_ledger_2026_06');
  assert.equal(operationalPartitionName('billing_ledger', july), 'billing_ledger_2026_07');
  assert.equal(normalizeOperationalPartitionTimestamp(july), july);
  assert.throws(() => normalizeOperationalPartitionTimestamp(0), /invalid_operational_partition_timestamp/);

  console.log(JSON.stringify({ ok: true, checks: 6 }));
}

main();
