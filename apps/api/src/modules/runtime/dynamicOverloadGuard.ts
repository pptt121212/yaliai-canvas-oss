import fs from 'node:fs';
import os from 'node:os';
import { monitorEventLoopDelay, type IntervalHistogram } from 'node:perf_hooks';
import type { PublicApiConfig } from '../admin/controlPlane.js';

type ResourceSnapshot = {
  totalMemoryBytes: number;
  availableMemoryBytes: number;
  effectiveCpuCount: number;
  loadRatio?: number;
};

type CpuTimes = {
  idle: number;
  total: number;
};

export type DynamicOverloadGuardSnapshot = {
  enabled: boolean;
  overloaded: boolean;
  sampledAt: number;
  consecutiveOverloadSamples: number;
  consecutiveRecoverySamples: number;
  reasons: string[];
  availableMemoryRatio?: number;
  cpuLoadRatio?: number;
  eventLoopDelayMs?: number;
  effectiveCpuCount?: number;
};

const sampleIntervalMs = 2_000;
const overloadSamplesRequired = 3;
const recoverySamplesRequired = 5;

function readTrimmedFile(filePath: string) {
  try {
    return fs.readFileSync(filePath, 'utf8').trim();
  } catch {
    return '';
  }
}

function readLinuxMemAvailableBytes() {
  const match = readTrimmedFile('/proc/meminfo').match(/^MemAvailable:\s+(\d+)\s+kB$/m);
  return match ? Number(match[1]) * 1024 : 0;
}

function readCgroupMemoryLimit() {
  const candidates = [
    ['/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory.current'],
    ['/sys/fs/cgroup/memory/memory.limit_in_bytes', '/sys/fs/cgroup/memory/memory.usage_in_bytes'],
  ];
  for (const [limitPath, usagePath] of candidates) {
    const limitRaw = readTrimmedFile(limitPath);
    const usageRaw = readTrimmedFile(usagePath);
    const limit = limitRaw === 'max' ? 0 : Number(limitRaw);
    const usage = Number(usageRaw);
    if (Number.isFinite(limit) && limit > 0 && Number.isFinite(usage) && usage >= 0) {
      // Linux uses an enormous sentinel for an unlimited cgroup.
      if (limit < 2 ** 60) {
        return { totalMemoryBytes: limit, availableMemoryBytes: Math.max(0, limit - usage) };
      }
    }
  }
  return null;
}

function readEffectiveCpuCount() {
  let count = Math.max(1, Number(os.availableParallelism?.() || os.cpus().length || 1));
  const cpuMax = readTrimmedFile('/sys/fs/cgroup/cpu.max').split(/\s+/);
  if (cpuMax.length === 2 && cpuMax[0] !== 'max') {
    const quota = Number(cpuMax[0]);
    const period = Number(cpuMax[1]);
    if (quota > 0 && period > 0) {
      count = Math.max(1, Math.min(count, quota / period));
    }
  }
  const quota = Number(readTrimmedFile('/sys/fs/cgroup/cpu/cpu.cfs_quota_us'));
  const period = Number(readTrimmedFile('/sys/fs/cgroup/cpu/cpu.cfs_period_us'));
  if (quota > 0 && period > 0) {
    count = Math.max(1, Math.min(count, quota / period));
  }
  return count;
}

function readCpuTimes(): CpuTimes {
  return os.cpus().reduce<CpuTimes>((result, cpu) => {
    const total = Object.values(cpu.times).reduce((sum, value) => sum + value, 0);
    return {
      idle: result.idle + cpu.times.idle,
      total: result.total + total,
    };
  }, { idle: 0, total: 0 });
}

function collectResources(): ResourceSnapshot {
  const cgroupMemory = process.platform === 'linux' ? readCgroupMemoryLimit() : null;
  const totalMemoryBytes = cgroupMemory?.totalMemoryBytes || os.totalmem();
  const availableMemoryBytes = cgroupMemory?.availableMemoryBytes
    || (process.platform === 'linux' ? readLinuxMemAvailableBytes() : 0)
    || os.freemem();
  const effectiveCpuCount = readEffectiveCpuCount();
  const loadAverage = os.loadavg?.()[0] || 0;
  return {
    totalMemoryBytes,
    availableMemoryBytes,
    effectiveCpuCount,
    ...(loadAverage > 0 ? { loadRatio: loadAverage / effectiveCpuCount } : {}),
  };
}

class DynamicOverloadGuard {
  private timer: ReturnType<typeof setInterval> | null = null;
  private eventLoopMonitor: IntervalHistogram | null = null;
  private config: PublicApiConfig | null = null;
  private previousCpuTimes: CpuTimes | null = null;
  private snapshot: DynamicOverloadGuardSnapshot = {
    enabled: false,
    overloaded: false,
    sampledAt: 0,
    consecutiveOverloadSamples: 0,
    consecutiveRecoverySamples: 0,
    reasons: [],
  };

  configure(config: PublicApiConfig) {
    this.config = config;
    if (!config.overloadGuardEnabled) {
      // Keep the disabled path allocation- and sampling-free for every request.
      if (this.timer || this.eventLoopMonitor || this.snapshot.enabled) {
        this.stop();
      }
      return;
    }
    if (!this.eventLoopMonitor) {
      this.eventLoopMonitor = monitorEventLoopDelay({ resolution: 20 });
      this.eventLoopMonitor.enable();
    }
    if (!this.timer) {
      this.sample();
      this.timer = setInterval(() => this.sample(), sampleIntervalMs);
      this.timer.unref();
    }
  }

  shouldReject(config: PublicApiConfig) {
    this.configure(config);
    return this.snapshot.overloaded;
  }

  getSnapshot(config: PublicApiConfig) {
    this.configure(config);
    return this.snapshot;
  }

  private stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.previousCpuTimes = null;
    if (this.eventLoopMonitor) {
      this.eventLoopMonitor.disable();
      this.eventLoopMonitor = null;
    }
    this.snapshot = {
      enabled: false,
      overloaded: false,
      sampledAt: Date.now(),
      consecutiveOverloadSamples: 0,
      consecutiveRecoverySamples: 0,
      reasons: [],
    };
  }

  private sample() {
    const config = this.config;
    if (!config?.overloadGuardEnabled) {
      return;
    }
    const resources = collectResources();
    const cpuTimes = readCpuTimes();
    const previousCpuTimes = this.previousCpuTimes;
    this.previousCpuTimes = cpuTimes;
    const cpuUtilizationRatio = previousCpuTimes && cpuTimes.total > previousCpuTimes.total
      ? 1 - Math.max(0, cpuTimes.idle - previousCpuTimes.idle) / (cpuTimes.total - previousCpuTimes.total)
      : undefined;
    const availableMemoryRatio = resources.totalMemoryBytes > 0
      ? resources.availableMemoryBytes / resources.totalMemoryBytes
      : 1;
    const eventLoopDelayMs = this.eventLoopMonitor?.count
      ? this.eventLoopMonitor.percentile(99) / 1_000_000
      : 0;
    this.eventLoopMonitor?.reset();
    // loadavg reflects scheduler pressure on Unix; sampled CPU utilization covers Windows/macOS.
    const cpuLoadRatio = resources.loadRatio ?? cpuUtilizationRatio;
    const reasons = [
      ...(availableMemoryRatio < config.overloadGuardMinAvailableMemoryRatio ? ['memory_pressure'] : []),
      ...(cpuLoadRatio !== undefined && cpuLoadRatio > config.overloadGuardMaxCpuLoadRatio ? ['cpu_pressure'] : []),
      ...(eventLoopDelayMs > config.overloadGuardMaxEventLoopDelayMs ? ['event_loop_delay'] : []),
    ];
    const unhealthy = reasons.length > 0;
    const overloadSamples = unhealthy ? this.snapshot.consecutiveOverloadSamples + 1 : 0;
    const recoverySamples = unhealthy ? 0 : this.snapshot.consecutiveRecoverySamples + 1;
    const overloaded = this.snapshot.overloaded
      ? recoverySamples < recoverySamplesRequired
      : overloadSamples >= overloadSamplesRequired;
    this.snapshot = {
      enabled: true,
      overloaded,
      sampledAt: Date.now(),
      consecutiveOverloadSamples: overloadSamples,
      consecutiveRecoverySamples: recoverySamples,
      reasons: unhealthy ? reasons : [],
      availableMemoryRatio,
      cpuLoadRatio,
      eventLoopDelayMs,
      effectiveCpuCount: resources.effectiveCpuCount,
    };
  }
}

export const dynamicOverloadGuard = new DynamicOverloadGuard();
