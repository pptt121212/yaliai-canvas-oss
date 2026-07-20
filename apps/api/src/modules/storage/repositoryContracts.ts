import type { ProviderConfig, ProviderRuntimeState } from '@yali/provider-core';
import type { AdminControlPlaneConfig } from '../admin/controlPlane.js';
import type { AdminConsoleCatalog } from '../admin/consoleCatalog.js';

export type AdminSessionRecord = {
  token: string;
  username: string;
  createdAt: number;
  expiresAt: number;
};

export type UserUpstreamPreference = {
  mode: 'shared_platform' | 'user_supplied';
  imageApiKind: 'images_endpoint' | 'responses_endpoint';
  imagesBaseUrl: string;
  imagesGenerationsUrl?: string;
  imagesEditsUrl?: string;
  imagesApiKey: string;
  chatBaseUrl: string;
  chatApiKey: string;
  preferredAuthMode: 'bearer' | 'x-api-key';
  chatFallbackMode: 'platform_fallback' | 'strict_user';
  updatedAt: number;
};

export type CanvasUserRecord = {
  id: string;
  username: string;
  email: string;
  passwordHash: string;
  tenantId: string;
  apiKeyId?: string;
  createdAt: number;
  updatedAt: number;
  status: 'active' | 'disabled';
  upstreamPreference: UserUpstreamPreference;
};

export type CanvasUserSessionRecord = {
  token: string;
  userId: string;
  username: string;
  createdAt: number;
  expiresAt: number;
};

export type RateLimitBucketState = {
  key: string;
  limit: number;
  windowStartedAt: number;
  windowEndsAt: number;
  requestCount: number;
  blockedUntil?: number;
  updatedAt: number;
};

export type ConcurrencyCounterState = {
  key: string;
  current: number;
  max: number;
  updatedAt: number;
  expiresAt?: number;
};

export type ProviderHealthSnapshot = {
  providerId: string;
  healthState: 'healthy' | 'cooling' | 'degraded' | 'disabled';
  healthScore: number;
  cooldownUntil?: number;
  lastCheckedAt: number;
  lastSuccessAt?: number;
  lastFailureAt?: number;
  successCount: number;
  failureCount: number;
};

export type OnboardingAnalyzeJobState = {
  jobId: string;
  status: 'running' | 'completed' | 'failed';
  createdAt: number;
  updatedAt: number;
  message?: string;
  probeLog?: unknown[];
  result?: unknown;
};

export type AsyncTaskStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancel_requested'
  | 'cancelled';

export type ImageGatewayTaskState = {
  task_id: string;
  operation: 'generations' | 'edits';
  provider_id: string;
  status: AsyncTaskStatus;
  created_at: number;
  updated_at: number;
  started_at?: number;
  queue_expires_at?: number;
  last_worker_id?: string;
  request_plan: unknown;
  result: unknown;
  error: unknown;
  internal?: Record<string, unknown>;
};

export type WorkflowRunJobState = {
  id: string;
  node_id: string;
  type: string;
  status: AsyncTaskStatus | 'completed' | 'done';
  image_url?: string;
  reference_url?: string;
  download_url?: string;
  prompt?: string;
  task_id?: string;
  error_message?: string;
  dependencies?: string[];
  result_items?: Array<Record<string, unknown>>;
  batch_item?: Record<string, unknown>;
  exploded_prompts?: Array<Record<string, unknown>>;
  ecommerce_prompts?: Array<Record<string, unknown>>;
  ecommerce_stage?: string;
  strategy_analysis_status?: string;
  analysis_status?: string;
  set_analysis_status?: string;
  ecommerce_effective_config?: Record<string, unknown> | null;
  ecommerce_strategy_result?: Record<string, unknown> | null;
};

export type WorkflowNodeState = {
  node_id: string;
  status: AsyncTaskStatus | 'completed' | 'done';
  image_url?: string;
  reference_url?: string;
  output_url?: string;
  package_url?: string;
  package_file_name?: string;
  package_count?: number;
  csv_url?: string;
  task_id?: string;
  error_message?: string;
  exploded_prompts?: Array<Record<string, unknown>>;
  ecommerce_prompts?: Array<Record<string, unknown>>;
  ecommerce_stage?: string;
  strategy_analysis_status?: string;
  analysis_status?: string;
  set_analysis_status?: string;
  ecommerce_effective_config?: Record<string, unknown> | null;
  ecommerce_strategy_result?: Record<string, unknown> | null;
};

export type CanvasWorkflowRunState = {
  run_id: string;
  canvas_id: string;
  status: AsyncTaskStatus | 'completed' | 'idle';
  workflow: unknown;
  execution_payload?: Record<string, unknown>;
  request_headers?: Record<string, string>;
  node_states: WorkflowNodeState[];
  jobs: WorkflowRunJobState[];
  created_at: number;
  updated_at?: number;
  started_at?: number;
  completed_at?: number;
  error_message?: string;
  last_worker_id?: string;
  canvas_batch_id?: string;
  history?: Array<Record<string, unknown>>;
};

export type BillingLedgerStatus = 'reserved' | 'charged' | 'voided';
export type BillingLedgerOperation = 'generations' | 'edits' | 'chat_completions';

export type BillingLedgerRecord = {
  id: string;
  createdAt: number;
  updatedAt: number;
  tenantId: string;
  apiKeyId: string;
  channelId: string;
  upstreamId?: string;
  requestId: string;
  taskId?: string;
  operation: BillingLedgerOperation;
  currency: 'cny';
  reservedCredits: number;
  chargedCredits: number;
  status: BillingLedgerStatus;
  model: string;
  size?: string;
  detail: Record<string, unknown>;
};

export type TenantCreditBalanceRecord = {
  tenantId: string;
  currency: 'cny';
  totalChargedCredits: number;
  totalVoidedCredits: number;
  totalReservedCredits: number;
  lastRequestId?: string;
  lastTaskId?: string;
  updatedAt: number;
};

export type TenantFinanceLedgerDirection = 'credit' | 'debit';

export type TenantFinanceLedgerRecord = {
  id: string;
  createdAt: number;
  updatedAt: number;
  tenantId: string;
  operatorId: string;
  direction: TenantFinanceLedgerDirection;
  amountCents: number;
  balanceAfterCents: number;
  currency: 'cny';
  note: string;
  detail: Record<string, unknown>;
};

export type TenantFinanceBalanceRecord = {
  tenantId: string;
  currency: 'cny';
  balanceCents: number;
  totalCreditedCents: number;
  totalDebitedCents: number;
  updatedAt: number;
};

export type AuditLogRecord = {
  id: string;
  createdAt: number;
  actorType: 'admin' | 'tenant_key' | 'system';
  actorId: string;
  action: string;
  targetType: 'upstream' | 'channel' | 'tenant' | 'api_key' | 'image_request' | 'task';
  targetId: string;
  requestId?: string;
  status: 'success' | 'failed' | 'accepted';
  message: string;
  detail: Record<string, unknown>;
};

export type RequestTraceSource =
  | 'onboarding_probe'
  | 'admin_upstream_test'
  | 'tenant_runtime_sync'
  | 'tenant_runtime_async_submit'
  | 'tenant_runtime_async_complete';

export type RequestTraceScope = 'upstream_only' | 'full_chain';

export type RequestTraceStatus = 'accepted' | 'success' | 'failed';

export type RequestTraceRecord = {
  traceId: string;
  createdAt: number;
  updatedAt: number;
  source: RequestTraceSource;
  scope: RequestTraceScope;
  status: RequestTraceStatus;
  summary: string;
  requestId?: string;
  taskId?: string;
  tenantId?: string;
  apiKeyId?: string;
  channelId?: string;
  upstreamId?: string;
  upstreamName?: string;
  providerBaseUrl?: string;
  operation?: 'generations' | 'edits' | 'responses' | 'chat_completions';
  downstreamRequest?: Record<string, unknown> | null;
  downstreamResponse?: Record<string, unknown> | null;
  upstreamRequest?: Record<string, unknown> | null;
  upstreamResponse?: Record<string, unknown> | null;
  errorPayload?: Record<string, unknown> | null;
  failureCategory?: string;
  statusCode?: number;
  tags?: string[];
};

export type TaskMasterRecord = {
  taskId: string;
  requestId: string;
  tenantId: string;
  apiKeyId: string;
  channelId: string;
  upstreamId?: string;
  operation: 'generations' | 'edits';
  status: AsyncTaskStatus | 'completed';
  providerId?: string;
  providerSource?: 'admin_managed' | 'user_supplied';
  providerBaseUrl?: string;
  model: string;
  promptPreview: string;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  requestPayload: Record<string, unknown>;
  responsePayload?: Record<string, unknown> | null;
  errorPayload?: Record<string, unknown> | null;
  billedCredits?: number;
};

export type OperationalOutboxEventStatus =
  | 'pending'
  | 'processing'
  | 'completed'
  | 'retrying'
  | 'dead';

export type OperationalOutboxEventRecord = {
  eventId: string;
  eventType: 'image_gateway_persistence';
  idempotencyKey: string;
  status: OperationalOutboxEventStatus;
  payload: Record<string, unknown>;
  attemptCount: number;
  availableAt: number;
  lockedUntil?: number;
  lockedBy?: string;
  lastError?: string;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
};

export type TenantFinanceLedgerCreateInput = {
  idempotencyKey?: string;
  tenantId: string;
  operatorId: string;
  direction: TenantFinanceLedgerDirection;
  amountCents: number;
  note: string;
  currency: 'cny';
  detail?: Record<string, unknown>;
};

export type ImageGatewayPersistenceBundle = {
  eventId: string;
  billingRecords: BillingLedgerRecord[];
  tenantFinanceLedger?: TenantFinanceLedgerCreateInput | null;
  taskRecord: TaskMasterRecord;
};

export type BillingChargePersistenceBundle = {
  billingRecords: BillingLedgerRecord[];
  tenantFinanceLedger?: TenantFinanceLedgerCreateInput | null;
};

export type RoutingAccuracySnapshotRecord = {
  snapshotKey: string;
  generatedAt: number;
  expiresAt: number;
  payload: Record<string, unknown>;
};

export type ChannelTaskAggregate = {
  channelId: string;
  upstreamId?: string;
  requestCount: number;
  eligibleRequestCount: number;
  completedCount: number;
  failedCount: number;
  rejectedCount: number;
  runningCount: number;
  averageDurationMs: number;
  lastActivityAt?: number;
  generationCount: number;
  editCount: number;
};

export type ChannelBillingAggregate = {
  channelId: string;
  upstreamId?: string;
  operation: BillingLedgerOperation;
  tier?: string;
  quality?: string;
  unitCount: number;
  upstreamUnitCostConfigured: boolean;
  upstreamUnitCostCredits: number;
  chargedCredits: number;
};

export type ChannelTraceAggregate = {
  channelId: string;
  upstreamId?: string;
  requestCount: number;
  eligibleRequestCount: number;
  completedCount: number;
  failedCount: number;
  rejectedCount: number;
  runningCount: number;
  averageDurationMs: number;
  lastActivityAt?: number;
};

export type ChannelPerformanceData = {
  tasks: ChannelTaskAggregate[];
  billing: ChannelBillingAggregate[];
  traces: ChannelTraceAggregate[];
};

export type BusinessOverviewData = {
  imageRequests1h: number;
  imageEligibleRequests1h: number;
  imageSuccess1h: number;
  imageFailed1h: number;
  imageRejected1h: number;
  imageRequests24h: number;
  imageEligibleRequests24h: number;
  imageSuccess24h: number;
  imageFailed24h: number;
  imageRejected24h: number;
  imageAverageDuration24hMs: number;
  textRequests1h: number;
  textEligibleRequests1h: number;
  textSuccess1h: number;
  textFailed1h: number;
  textRejected1h: number;
  textRequests24h: number;
  textEligibleRequests24h: number;
  textSuccess24h: number;
  textFailed24h: number;
  textRejected24h: number;
  charged24hCents: number;
  runningTasksCurrent: number;
};

export type OperationalMetricRollupSource =
  | 'scheduled_worker'
  | 'offline_backfill'
  | 'manual_rebuild';

export type OperationalMetricRollupRecord = {
  rollupKey: string;
  metricFamily: 'channel_performance' | 'business_overview' | 'billing_summary' | 'custom';
  bucketStart: number;
  bucketMs: number;
  channelId?: string;
  upstreamId?: string;
  tenantId?: string;
  apiKeyId?: string;
  operation?: 'generations' | 'edits' | 'responses' | 'chat_completions' | 'all';
  tier?: string;
  quality?: string;
  failureCategory?: string;
  source: OperationalMetricRollupSource;
  metrics: Record<string, number>;
  detail?: Record<string, unknown>;
  generatedAt: number;
  updatedAt: number;
};

export type OperationalRollupJobRecord = {
  jobKey: string;
  lockedUntil?: number;
  lockedBy?: string;
  lastSuccessAt?: number;
  lastError?: string;
  updatedAt: number;
};

export interface ControlPlaneRepository {
  get(): AdminControlPlaneConfig;
  save(config: AdminControlPlaneConfig): AdminControlPlaneConfig;
}

export interface ConsoleCatalogRepository {
  get(): AdminConsoleCatalog;
  replace(next: AdminConsoleCatalog): AdminConsoleCatalog;
}

export interface ProviderRepository {
  list(): ProviderConfig[];
  replaceAll(items: ProviderConfig[]): ProviderConfig[];
}

export interface SessionRepository {
  list(): AdminSessionRecord[];
  saveAll(records: AdminSessionRecord[]): AdminSessionRecord[];
}

export interface CanvasUserRepository {
  list(): CanvasUserRecord[];
  saveAll(records: CanvasUserRecord[]): CanvasUserRecord[];
  upsertMany(records: CanvasUserRecord[]): CanvasUserRecord[];
  deleteByIds(ids: string[]): void;
}

export interface CanvasUserSessionRepository {
  list(): CanvasUserSessionRecord[];
  saveAll(records: CanvasUserSessionRecord[]): CanvasUserSessionRecord[];
  upsertMany(records: CanvasUserSessionRecord[]): CanvasUserSessionRecord[];
  deleteByIds(ids: string[]): void;
}

export interface HotStateStore {
  getProviderRuntime(providerId: string): ProviderRuntimeState | null;
  setProviderRuntime(providerId: string, value: ProviderRuntimeState): void;
  deleteProviderRuntime(providerId: string): void;
  listProviderRuntime(): Array<{ providerId: string; runtime: ProviderRuntimeState }>;
  getRateLimitBucket(key: string): RateLimitBucketState | null;
  setRateLimitBucket(key: string, value: RateLimitBucketState, ttlSeconds?: number): void;
  deleteRateLimitBucket(key: string): void;
  listRateLimitBuckets(): RateLimitBucketState[];
  getConcurrencyCounter(key: string): ConcurrencyCounterState | null;
  setConcurrencyCounter(key: string, value: ConcurrencyCounterState, ttlSeconds?: number): void;
  deleteConcurrencyCounter(key: string): void;
  listConcurrencyCounters(): ConcurrencyCounterState[];
  getProviderHealth(providerId: string): ProviderHealthSnapshot | null;
  setProviderHealth(providerId: string, value: ProviderHealthSnapshot, ttlSeconds?: number): void;
  deleteProviderHealth(providerId: string): void;
  listProviderHealth(): ProviderHealthSnapshot[];
  getOnboardingAnalyzeJob(jobId: string): OnboardingAnalyzeJobState | null;
  setOnboardingAnalyzeJob(jobId: string, value: OnboardingAnalyzeJobState, ttlSeconds?: number): void;
  deleteOnboardingAnalyzeJob(jobId: string): void;
  listOnboardingAnalyzeJobs(): OnboardingAnalyzeJobState[];
  getImageTask(taskId: string): ImageGatewayTaskState | null;
  setImageTask(taskId: string, value: ImageGatewayTaskState, ttlSeconds?: number): void;
  deleteImageTask(taskId: string): void;
  listImageTasks(): ImageGatewayTaskState[];
  getWorkflowRun(runId: string): CanvasWorkflowRunState | null;
  setWorkflowRun(runId: string, value: CanvasWorkflowRunState, ttlSeconds?: number): void;
  deleteWorkflowRun(runId: string): void;
  listWorkflowRuns(): CanvasWorkflowRunState[];
}

export interface AsyncControlPlaneRepository {
  get(): Promise<AdminControlPlaneConfig>;
  save(config: AdminControlPlaneConfig): Promise<AdminControlPlaneConfig>;
}

export interface AsyncConsoleCatalogRepository {
  get(): Promise<AdminConsoleCatalog>;
  replace(next: AdminConsoleCatalog): Promise<AdminConsoleCatalog>;
  mutate?(updater: (current: AdminConsoleCatalog) => AdminConsoleCatalog | Promise<AdminConsoleCatalog>): Promise<AdminConsoleCatalog>;
}

export interface AsyncProviderRepository {
  list(): Promise<ProviderConfig[]>;
  replaceAll(items: ProviderConfig[]): Promise<ProviderConfig[]>;
}

export interface AsyncSessionRepository {
  list(): Promise<AdminSessionRecord[]>;
  saveAll(records: AdminSessionRecord[]): Promise<AdminSessionRecord[]>;
}

export interface AsyncCanvasUserRepository {
  list(): Promise<CanvasUserRecord[]>;
  saveAll(records: CanvasUserRecord[]): Promise<CanvasUserRecord[]>;
  upsertMany(records: CanvasUserRecord[]): Promise<CanvasUserRecord[]>;
  deleteByIds(ids: string[]): Promise<void>;
}

export interface AsyncCanvasUserSessionRepository {
  list(): Promise<CanvasUserSessionRecord[]>;
  saveAll(records: CanvasUserSessionRecord[]): Promise<CanvasUserSessionRecord[]>;
  upsertMany(records: CanvasUserSessionRecord[]): Promise<CanvasUserSessionRecord[]>;
  deleteByIds(ids: string[]): Promise<void>;
}

export interface AsyncOperationalRepository {
  pruneOperationalWindow(maxAgeMs: number): Promise<void>;
  pruneOperationalRetention?(retention: {
    auditMs: number;
    traceMs: number;
    billingMs: number;
    taskMs: number;
  }): Promise<void>;
  appendAudit(record: AuditLogRecord): Promise<AuditLogRecord>;
  listAudit(limit: number): Promise<AuditLogRecord[]>;
  appendTrace(record: RequestTraceRecord): Promise<RequestTraceRecord>;
  updateTrace(traceId: string, patch: Partial<RequestTraceRecord>): Promise<RequestTraceRecord | null>;
  getTrace(traceId: string): Promise<RequestTraceRecord | null>;
  listTraces(limit: number): Promise<RequestTraceRecord[]>;
  clearTraces(): Promise<{ deletedCount: number }>;
  createBillingLedger(record: BillingLedgerRecord): Promise<BillingLedgerRecord>;
  updateBillingLedger(id: string, patch: Partial<BillingLedgerRecord>): Promise<BillingLedgerRecord | null>;
  listBillingLedger(input: {
    limit: number;
    operations?: BillingLedgerOperation[];
  }): Promise<BillingLedgerRecord[]>;
  purgeTenantData(tenantId: string): Promise<{
    traces: number;
    billing: number;
    tasks: number;
    creditBalances: number;
    financeLedger: number;
    financeBalances: number;
  }>;
  sumChargedCreditsForTenant(tenantId: string, fromInclusive: number, toExclusive: number): Promise<number>;
  adjustTenantCreditBalance(input: {
    tenantId: string;
    currency: 'cny';
    chargedDelta?: number;
    voidedDelta?: number;
    reservedDelta?: number;
    requestId?: string;
    taskId?: string;
  }): Promise<TenantCreditBalanceRecord>;
  getTenantCreditBalance(tenantId: string, currency: 'cny'): Promise<TenantCreditBalanceRecord | null>;
  createTenantFinanceLedger(input: TenantFinanceLedgerCreateInput): Promise<TenantFinanceLedgerRecord>;
  listTenantFinanceLedger(limit: number): Promise<TenantFinanceLedgerRecord[]>;
  listTenantFinanceLedgerByTenant(input: {
    tenantId: string;
    currency: 'cny';
    limit: number;
    offset?: number;
    createdAfter?: number;
  }): Promise<TenantFinanceLedgerRecord[]>;
  countTenantFinanceLedgerByTenant(input: {
    tenantId: string;
    currency: 'cny';
    createdAfter?: number;
  }): Promise<number>;
  sumTenantFinanceLedgerByTenant(input: {
    tenantId: string;
    currency: 'cny';
    direction?: TenantFinanceLedgerDirection;
    createdAfter?: number;
    createdBefore?: number;
  }): Promise<number>;
  getTenantFinanceBalance(tenantId: string, currency: 'cny'): Promise<TenantFinanceBalanceRecord | null>;
  listTenantFinanceBalances(): Promise<TenantFinanceBalanceRecord[]>;
  getChannelPerformanceData(fromInclusive: number, toExclusive: number): Promise<ChannelPerformanceData>;
  getBusinessOverviewData(input: {
    oneHourAgo: number;
    oneDayAgo: number;
    toExclusive: number;
  }): Promise<BusinessOverviewData>;
  upsertOperationalMetricRollup(record: OperationalMetricRollupRecord): Promise<OperationalMetricRollupRecord>;
  listOperationalMetricRollups(input: {
    metricFamily?: OperationalMetricRollupRecord['metricFamily'];
    fromInclusive: number;
    toExclusive: number;
    channelId?: string;
    upstreamId?: string;
    tenantId?: string;
    limit?: number;
  }): Promise<OperationalMetricRollupRecord[]>;
  clearOperationalRollups(input?: {
    metricFamily?: OperationalMetricRollupRecord['metricFamily'];
  }): Promise<{
    rollups: number;
    jobs: number;
  }>;
  tryStartOperationalRollupJob(input: {
    jobKey: string;
    lockMs: number;
    workerId: string;
  }): Promise<boolean>;
  finishOperationalRollupJob(input: {
    jobKey: string;
    workerId: string;
    success: boolean;
    error?: string;
  }): Promise<void>;
  getOperationalRollupJob(jobKey: string): Promise<OperationalRollupJobRecord | null>;
  enqueueOperationalOutboxEvent(record: OperationalOutboxEventRecord): Promise<OperationalOutboxEventRecord>;
  claimOperationalOutboxEvents(input: {
    eventType: OperationalOutboxEventRecord['eventType'];
    limit: number;
    lockMs: number;
    workerId: string;
  }): Promise<OperationalOutboxEventRecord[]>;
  markOperationalOutboxEventCompleted(input: {
    eventId: string;
    workerId: string;
  }): Promise<void>;
  markOperationalOutboxEventFailed(input: {
    eventId: string;
    workerId: string;
    error: string;
    retryDelayMs: number;
    maxAttempts: number;
  }): Promise<void>;
  applyImageGatewayPersistenceBundle(input: ImageGatewayPersistenceBundle): Promise<void>;
  applyBillingChargePersistenceBundle(input: BillingChargePersistenceBundle): Promise<void>;
  upsertTask(record: TaskMasterRecord): Promise<TaskMasterRecord>;
  getTask(taskId: string): Promise<TaskMasterRecord | null>;
  listTasks(limit: number): Promise<TaskMasterRecord[]>;
  listTasksForRoutingAccuracy(limit: number): Promise<TaskMasterRecord[]>;
  getRoutingAccuracySnapshot(snapshotKey: string): Promise<RoutingAccuracySnapshotRecord | null>;
  upsertRoutingAccuracySnapshot(record: RoutingAccuracySnapshotRecord): Promise<RoutingAccuracySnapshotRecord>;
}

export interface AsyncHotStateStore {
  getProviderRuntime(providerId: string): Promise<ProviderRuntimeState | null>;
  getProviderRuntimeMany(providerIds: string[]): Promise<Array<{ providerId: string; runtime: ProviderRuntimeState | null }>>;
  updateProviderRuntime?(
    providerId: string,
    updater: (current: ProviderRuntimeState | null) => ProviderRuntimeState,
    ttlSeconds?: number,
  ): Promise<ProviderRuntimeState>;
  setProviderRuntime(providerId: string, value: ProviderRuntimeState, ttlSeconds?: number): Promise<void>;
  deleteProviderRuntime(providerId: string): Promise<void>;
  listProviderRuntime(): Promise<Array<{ providerId: string; runtime: ProviderRuntimeState }>>;
  getRateLimitBucket(key: string): Promise<RateLimitBucketState | null>;
  setRateLimitBucket(key: string, value: RateLimitBucketState, ttlSeconds?: number): Promise<void>;
  deleteRateLimitBucket(key: string): Promise<void>;
  listRateLimitBuckets(): Promise<RateLimitBucketState[]>;
  getConcurrencyCounter(key: string): Promise<ConcurrencyCounterState | null>;
  getConcurrencyCounters(keys: string[]): Promise<Array<{ key: string; counter: ConcurrencyCounterState | null }>>;
  setConcurrencyCounter(key: string, value: ConcurrencyCounterState, ttlSeconds?: number): Promise<void>;
  deleteConcurrencyCounter(key: string): Promise<void>;
  listConcurrencyCounters(): Promise<ConcurrencyCounterState[]>;
  getProviderHealth(providerId: string): Promise<ProviderHealthSnapshot | null>;
  setProviderHealth(providerId: string, value: ProviderHealthSnapshot, ttlSeconds?: number): Promise<void>;
  deleteProviderHealth(providerId: string): Promise<void>;
  listProviderHealth(): Promise<ProviderHealthSnapshot[]>;
  getOnboardingAnalyzeJob(jobId: string): Promise<OnboardingAnalyzeJobState | null>;
  setOnboardingAnalyzeJob(jobId: string, value: OnboardingAnalyzeJobState, ttlSeconds?: number): Promise<void>;
  deleteOnboardingAnalyzeJob(jobId: string): Promise<void>;
  listOnboardingAnalyzeJobs(): Promise<OnboardingAnalyzeJobState[]>;
  getImageTask(taskId: string): Promise<ImageGatewayTaskState | null>;
  setImageTask(taskId: string, value: ImageGatewayTaskState, ttlSeconds?: number): Promise<void>;
  deleteImageTask(taskId: string): Promise<void>;
  listImageTasks(): Promise<ImageGatewayTaskState[]>;
  listQueuedImageTasks?(): Promise<ImageGatewayTaskState[]>;
  getWorkflowRun(runId: string): Promise<CanvasWorkflowRunState | null>;
  setWorkflowRun(runId: string, value: CanvasWorkflowRunState, ttlSeconds?: number): Promise<void>;
  deleteWorkflowRun(runId: string): Promise<void>;
  listWorkflowRuns(): Promise<CanvasWorkflowRunState[]>;
}
