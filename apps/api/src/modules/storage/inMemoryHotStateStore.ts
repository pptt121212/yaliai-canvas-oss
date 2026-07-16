import type { ProviderRuntimeState } from '@yali/provider-core';
import type {
  CanvasWorkflowRunState,
  ConcurrencyCounterState,
  HotStateStore,
  ImageGatewayTaskState,
  OnboardingAnalyzeJobState,
  ProviderHealthSnapshot,
  RateLimitBucketState,
} from './repositoryContracts.js';

type MemoryValue<T> = {
  value: T;
  expiresAt?: number;
};

function readWithTtl<T>(store: Map<string, MemoryValue<T>>, key: string): T | null {
  const record = store.get(key);
  if (!record) {
    return null;
  }
  if (record.expiresAt && record.expiresAt <= Date.now()) {
    store.delete(key);
    return null;
  }
  return record.value;
}

function writeWithTtl<T>(store: Map<string, MemoryValue<T>>, key: string, value: T, ttlSeconds?: number) {
  store.set(key, {
    value,
    expiresAt: ttlSeconds && ttlSeconds > 0 ? Date.now() + ttlSeconds * 1000 : undefined,
  });
}

const providerRuntimeStore = new Map<string, MemoryValue<ProviderRuntimeState>>();
const rateLimitStore = new Map<string, MemoryValue<RateLimitBucketState>>();
const concurrencyStore = new Map<string, MemoryValue<ConcurrencyCounterState>>();
const providerHealthStore = new Map<string, MemoryValue<ProviderHealthSnapshot>>();
const onboardingAnalyzeJobStore = new Map<string, MemoryValue<OnboardingAnalyzeJobState>>();
const imageTaskStore = new Map<string, MemoryValue<ImageGatewayTaskState>>();
const workflowRunStore = new Map<string, MemoryValue<CanvasWorkflowRunState>>();

function listLiveValues<T>(store: Map<string, MemoryValue<T>>) {
  const result: T[] = [];
  for (const key of store.keys()) {
    const value = readWithTtl(store, key);
    if (value !== null) {
      result.push(value);
    }
  }
  return result;
}

function listLiveEntries<T>(store: Map<string, MemoryValue<T>>) {
  const result: Array<{ key: string; value: T }> = [];
  for (const key of store.keys()) {
    const value = readWithTtl(store, key);
    if (value !== null) {
      result.push({ key, value });
    }
  }
  return result;
}

export const inMemoryHotStateStore: HotStateStore = {
  getProviderRuntime(providerId: string) {
    return readWithTtl(providerRuntimeStore, providerId);
  },
  setProviderRuntime(providerId: string, value: ProviderRuntimeState) {
    writeWithTtl(providerRuntimeStore, providerId, value);
  },
  deleteProviderRuntime(providerId: string) {
    providerRuntimeStore.delete(providerId);
  },
  listProviderRuntime() {
    return listLiveEntries(providerRuntimeStore).map((item) => ({
      providerId: item.key,
      runtime: item.value,
    }));
  },
  getRateLimitBucket(key: string) {
    return readWithTtl(rateLimitStore, key);
  },
  setRateLimitBucket(key: string, value: RateLimitBucketState, ttlSeconds?: number) {
    writeWithTtl(rateLimitStore, key, value, ttlSeconds);
  },
  deleteRateLimitBucket(key: string) {
    rateLimitStore.delete(key);
  },
  listRateLimitBuckets() {
    return listLiveValues(rateLimitStore);
  },
  getConcurrencyCounter(key: string) {
    return readWithTtl(concurrencyStore, key);
  },
  setConcurrencyCounter(key: string, value: ConcurrencyCounterState, ttlSeconds?: number) {
    writeWithTtl(concurrencyStore, key, value, ttlSeconds);
  },
  deleteConcurrencyCounter(key: string) {
    concurrencyStore.delete(key);
  },
  listConcurrencyCounters() {
    return listLiveValues(concurrencyStore);
  },
  getProviderHealth(providerId: string) {
    return readWithTtl(providerHealthStore, providerId);
  },
  setProviderHealth(providerId: string, value: ProviderHealthSnapshot, ttlSeconds?: number) {
    writeWithTtl(providerHealthStore, providerId, value, ttlSeconds);
  },
  deleteProviderHealth(providerId: string) {
    providerHealthStore.delete(providerId);
  },
  listProviderHealth() {
    return listLiveValues(providerHealthStore);
  },
  getOnboardingAnalyzeJob(jobId: string) {
    return readWithTtl(onboardingAnalyzeJobStore, jobId);
  },
  setOnboardingAnalyzeJob(jobId: string, value: OnboardingAnalyzeJobState, ttlSeconds?: number) {
    writeWithTtl(onboardingAnalyzeJobStore, jobId, value, ttlSeconds);
  },
  deleteOnboardingAnalyzeJob(jobId: string) {
    onboardingAnalyzeJobStore.delete(jobId);
  },
  listOnboardingAnalyzeJobs() {
    return listLiveValues(onboardingAnalyzeJobStore);
  },
  getImageTask(taskId: string) {
    return readWithTtl(imageTaskStore, taskId);
  },
  setImageTask(taskId: string, value: ImageGatewayTaskState, ttlSeconds?: number) {
    writeWithTtl(imageTaskStore, taskId, value, ttlSeconds);
  },
  deleteImageTask(taskId: string) {
    imageTaskStore.delete(taskId);
  },
  listImageTasks() {
    return listLiveValues(imageTaskStore);
  },
  getWorkflowRun(runId: string) {
    return readWithTtl(workflowRunStore, runId);
  },
  setWorkflowRun(runId: string, value: CanvasWorkflowRunState, ttlSeconds?: number) {
    writeWithTtl(workflowRunStore, runId, value, ttlSeconds);
  },
  deleteWorkflowRun(runId: string) {
    workflowRunStore.delete(runId);
  },
  listWorkflowRuns() {
    return listLiveValues(workflowRunStore);
  },
};
