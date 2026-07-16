import { buildChannelPerformanceRollups } from '../modules/operationalRollups.js';
import { operationalRepository } from '../modules/storage/operationalStore.js';
import type { OperationalMetricRollupRecord } from '../modules/storage/repositoryContracts.js';

type ParsedArgs = {
  fromInclusive: number;
  toExclusive: number;
  bucketMs: number;
  source: OperationalMetricRollupRecord['source'];
};

const oneHourMs = 60 * 60 * 1000;
const oneDayMs = 24 * oneHourMs;

function readArg(name: string) {
  const prefix = `--${name}=`;
  const matched = process.argv.slice(2).find((item) => item.startsWith(prefix));
  return matched ? matched.slice(prefix.length) : undefined;
}

function parseTimestamp(value: string | undefined) {
  if (!value) {
    return undefined;
  }
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) {
    return Math.floor(numeric);
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseBucketMs(value: string | undefined) {
  const normalized = String(value || 'day').trim().toLowerCase();
  if (normalized === 'hour' || normalized === 'hourly') {
    return oneHourMs;
  }
  if (normalized === 'day' || normalized === 'daily') {
    return oneDayMs;
  }
  const numeric = Number(normalized);
  return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : oneDayMs;
}

function parseSource(value: string | undefined): OperationalMetricRollupRecord['source'] {
  const normalized = String(value || 'offline_backfill').trim();
  if (normalized === 'scheduled_worker' || normalized === 'manual_rebuild') {
    return normalized;
  }
  return 'offline_backfill';
}

function parseArgs(): ParsedArgs {
  const now = Date.now();
  const bucketMs = parseBucketMs(readArg('bucket') || readArg('bucket-ms'));
  const toExclusive = parseTimestamp(readArg('to') || readArg('to-ms')) || Math.floor(now / bucketMs) * bucketMs;
  const days = Math.max(1, Math.min(365, Number(readArg('days') || 1)));
  const fromInclusive = parseTimestamp(readArg('from') || readArg('from-ms')) || toExclusive - days * oneDayMs;
  if (toExclusive <= fromInclusive) {
    throw new Error('invalid_rollup_time_range');
  }
  return {
    fromInclusive,
    toExclusive,
    bucketMs,
    source: parseSource(readArg('source')),
  };
}

async function main() {
  const args = parseArgs();
  const result = await buildChannelPerformanceRollups({
    repository: operationalRepository,
    fromInclusive: args.fromInclusive,
    toExclusive: args.toExclusive,
    bucketMs: args.bucketMs,
    source: args.source,
  });
  console.log(JSON.stringify({
    ok: true,
    family: 'channel_performance',
    ...result,
  }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  }, null, 2));
  process.exitCode = 1;
});
