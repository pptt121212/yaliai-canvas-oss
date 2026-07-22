import type {
  AdminConsoleCatalog,
  AdminControlPlaneConfig,
  AdminSession,
  AuditLogReport,
  ConsoleApiKey,
  ConsoleChannel,
  ConsoleTenant,
  ConsoleUpstream,
  BananaImageSellPriceRow,
  ImageSellPriceRow,
  OnboardingAnalyzeRequest,
  OnboardingAnalyzeJob,
  OnboardingAnalysisResult,
  OperationalRollupReport,
  OverviewPayload,
  BillingLedgerReport,
  ChannelPerformanceReport,
  RequestTraceDetail,
  RequestTraceReport,
  RoutingDiagnosticsReport,
  TenantFinanceLedgerReport,
  CanvasUserAdminReport,
  ResolutionAuditReport,
  UpstreamTestRequest,
  UpstreamTestResult,
} from './types';

function extractApiErrorMessage(payload: unknown, responseText: string, status: number) {
  if (payload && typeof payload === 'object') {
    const record = payload as Record<string, unknown>;
    if (typeof record.message === 'string' && record.message.trim()) {
      return record.message.trim();
    }
    if (typeof record.error === 'string' && record.error.trim()) {
      return record.error.trim();
    }
    if (Array.isArray(record.issues) && record.issues.length) {
      return record.issues
        .map((item) => {
          if (!item || typeof item !== 'object') {
            return '';
          }
          const issue = item as Record<string, unknown>;
          const path = Array.isArray(issue.path) && issue.path.length ? issue.path.join('.') : 'root';
          const message = typeof issue.message === 'string' ? issue.message : '';
          return message ? `${path}: ${message}` : '';
        })
        .filter(Boolean)
        .join(' | ');
    }
    if (Array.isArray(record.errors) && record.errors.length) {
      return record.errors.map((item) => String(item)).join(' | ');
    }
  }
  const raw = String(responseText || '').trim();
  if (raw) {
    return raw.slice(0, 500);
  }
  return `请求失败，HTTP ${status}`;
}

export async function requestJson<T>(url: string, options: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        ...(options.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
        ...(options.headers || {}),
      },
      ...options,
    });
  } catch (error) {
    throw new Error(
      error instanceof Error && error.message
        ? `请求未完成或连接中断：${error.message}。如刚刚发起的是接入探测，请查看“请求追踪”确认后台是否已经完成。`
        : '请求未完成或连接中断。如刚刚发起的是接入探测，请查看“请求追踪”确认后台是否已经完成。',
    );
  }
  const responseText = await response.text().catch(() => '');
  let payload: unknown = {};
  if (responseText) {
    try {
      payload = JSON.parse(responseText);
    } catch {
      payload = {};
    }
  }
  if (!response.ok) {
    throw new Error(extractApiErrorMessage(payload, responseText, response.status));
  }
  return payload as T;
}

export async function fetchAdminSession() {
  return requestJson<AdminSession>('/v1/admin/session', { method: 'GET' });
}

export async function adminLogin(username: string, password: string) {
  return requestJson('/v1/admin/login', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  });
}

export async function adminLogout() {
  return requestJson('/v1/admin/logout', {
    method: 'POST',
    body: '{}',
  });
}

export async function fetchOverview() {
  return requestJson<OverviewPayload>('/v1/admin/overview', { method: 'GET' });
}

export async function fetchControlPlane() {
  return requestJson<AdminControlPlaneConfig>('/v1/admin/control-plane', { method: 'GET' });
}

export async function saveControlPlane(config: AdminControlPlaneConfig) {
  return requestJson<AdminControlPlaneConfig>('/v1/admin/control-plane', {
    method: 'PUT',
    body: JSON.stringify(config),
  });
}

export async function fetchResolutionAuditReport(limit = 1000) {
  return requestJson<ResolutionAuditReport>(`/v1/admin/reports/resolution-audit?limit=${encodeURIComponent(String(limit))}`, {
    method: 'GET',
  });
}

export type BillingLedgerQuery = {
  limit?: number;
  scope?: 'image' | 'chat';
  tenantId?: string;
  apiKeyId?: string;
  createdAfter?: number;
  createdBefore?: number;
  cursorCreatedAt?: number;
  cursorId?: string;
};

export async function fetchBillingLedgerReport(query: BillingLedgerQuery = {}) {
  const params = new URLSearchParams();
  params.set('limit', String(query.limit || 200));
  if (query.scope) params.set('scope', query.scope);
  if (query.tenantId) params.set('tenantId', query.tenantId);
  if (query.apiKeyId) params.set('apiKeyId', query.apiKeyId);
  if (query.createdAfter) params.set('createdAfter', String(query.createdAfter));
  if (query.createdBefore) params.set('createdBefore', String(query.createdBefore));
  if (query.cursorCreatedAt) params.set('cursorCreatedAt', String(query.cursorCreatedAt));
  if (query.cursorId) params.set('cursorId', query.cursorId);
  return requestJson<BillingLedgerReport>(`/v1/admin/reports/billing-ledger?${params.toString()}`, {
    method: 'GET',
  });
}

export async function fetchAuditLogReport(limit = 500) {
  return requestJson<AuditLogReport>(`/v1/admin/reports/audit-logs?limit=${encodeURIComponent(String(limit))}`, {
    method: 'GET',
  });
}

export type ChannelPerformanceQuery = {
  days?: number;
  from?: number;
  to?: number;
};

export async function fetchChannelPerformanceReport(query: ChannelPerformanceQuery = {}) {
  const params = new URLSearchParams();
  if (query.from) params.set('from', String(query.from));
  if (query.to) params.set('to', String(query.to));
  if (!query.from && !query.to) params.set('days', String(query.days || 7));
  return requestJson<ChannelPerformanceReport>(`/v1/admin/reports/channel-performance?${params.toString()}`, {
    method: 'GET',
  });
}

export async function fetchOperationalRollupReport(days = 30) {
  return requestJson<OperationalRollupReport>(`/v1/admin/reports/operational-rollups?days=${encodeURIComponent(String(days))}`, {
    method: 'GET',
  });
}

export async function fetchRequestTraceReport(limit = 200) {
  return requestJson<RequestTraceReport>(`/v1/admin/reports/request-traces?limit=${encodeURIComponent(String(limit))}`, {
    method: 'GET',
  });
}

export async function fetchRoutingDiagnosticsReport() {
  return requestJson<RoutingDiagnosticsReport>('/v1/admin/reports/routing-diagnostics', {
    method: 'GET',
  });
}

export async function fetchRequestTraceDetail(traceId: string) {
  return requestJson<RequestTraceDetail>(`/v1/admin/reports/request-traces/${encodeURIComponent(traceId)}`, {
    method: 'GET',
  });
}

export async function clearRequestTraces() {
  return requestJson<{ success: true; deletedTraceCount: number; deletedImageCount: number }>(
    '/v1/admin/reports/request-traces/clear',
    {
      method: 'POST',
      body: '{}',
    },
  );
}

export type TenantFinanceLedgerQuery = {
  limit?: number;
  tenantId?: string;
  direction?: 'credit' | 'debit';
  entryType?: 'account_adjustment' | 'tenant_request_charge';
  createdAfter?: number;
  createdBefore?: number;
  cursorCreatedAt?: number;
  cursorId?: string;
};

export async function fetchTenantFinanceLedgerReport(query: TenantFinanceLedgerQuery = {}) {
  const params = new URLSearchParams();
  params.set('limit', String(query.limit || 200));
  if (query.tenantId) params.set('tenantId', query.tenantId);
  if (query.direction) params.set('direction', query.direction);
  if (query.entryType) params.set('entryType', query.entryType);
  if (query.createdAfter) params.set('createdAfter', String(query.createdAfter));
  if (query.createdBefore) params.set('createdBefore', String(query.createdBefore));
  if (query.cursorCreatedAt) params.set('cursorCreatedAt', String(query.cursorCreatedAt));
  if (query.cursorId) params.set('cursorId', query.cursorId);
  return requestJson<TenantFinanceLedgerReport>(`/v1/admin/reports/tenant-finance-ledger?${params.toString()}`, {
    method: 'GET',
  });
}

export async function fetchCanvasUsersReport(limit = 1000) {
  return requestJson<CanvasUserAdminReport>(`/v1/admin/reports/canvas-users?limit=${encodeURIComponent(String(limit))}`, {
    method: 'GET',
  });
}

export async function fetchCatalog() {
  return requestJson<AdminConsoleCatalog>('/v1/admin/catalog', { method: 'GET' });
}

export async function saveUpstream(upstream: ConsoleUpstream) {
  return requestJson<AdminConsoleCatalog>('/v1/admin/catalog/upstreams', {
    method: 'POST',
    body: JSON.stringify(upstream),
  });
}

export async function deleteUpstream(id: string) {
  return requestJson<AdminConsoleCatalog>(`/v1/admin/catalog/upstreams/${encodeURIComponent(id)}/delete`, {
    method: 'POST',
    body: '{}',
  });
}

export async function saveChannel(channel: ConsoleChannel) {
  return requestJson<AdminConsoleCatalog>('/v1/admin/catalog/channels', {
    method: 'POST',
    body: JSON.stringify(channel),
  });
}

export async function saveImagePricing(
  rows: ImageSellPriceRow[],
  bananaRows: BananaImageSellPriceRow[],
  chatCompletionsUnitPriceYuan = 0,
) {
  return requestJson<AdminConsoleCatalog>('/v1/admin/catalog/image-pricing', {
    method: 'POST',
    body: JSON.stringify({ rows, bananaRows, chatCompletionsUnitPriceYuan }),
  });
}

export async function deleteChannel(id: string) {
  return requestJson<AdminConsoleCatalog>(`/v1/admin/catalog/channels/${encodeURIComponent(id)}/delete`, {
    method: 'POST',
    body: '{}',
  });
}

export async function saveTenant(tenant: ConsoleTenant) {
  return requestJson<AdminConsoleCatalog>('/v1/admin/catalog/tenants', {
    method: 'POST',
    body: JSON.stringify(tenant),
  });
}

export async function deleteTenant(id: string) {
  return requestJson<AdminConsoleCatalog>(`/v1/admin/catalog/tenants/${encodeURIComponent(id)}/delete`, {
    method: 'POST',
    body: '{}',
  });
}

export async function saveApiKey(apiKey: ConsoleApiKey) {
  return requestJson<AdminConsoleCatalog>('/v1/admin/catalog/api-keys', {
    method: 'POST',
    body: JSON.stringify(apiKey),
  });
}

export async function deleteApiKey(id: string) {
  return requestJson<AdminConsoleCatalog>(`/v1/admin/catalog/api-keys/${encodeURIComponent(id)}/delete`, {
    method: 'POST',
    body: '{}',
  });
}

export async function createNewApiKeySecret() {
  return requestJson<{ raw: string; masked: string; hash: string }>('/v1/admin/catalog/api-keys/new-secret', {
    method: 'POST',
    body: '{}',
  });
}

export async function adjustTenantFinanceBalance(input: {
  tenantId: string;
  direction: 'credit' | 'debit';
  amountYuan: number;
  note: string;
}) {
  return requestJson('/v1/admin/tenant-finance-ledger', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function analyzeOnboarding(
  input: OnboardingAnalyzeRequest,
  onProgress?: (job: OnboardingAnalyzeJob) => void,
) {
  const pollIntervalMs = 1_000;
  const maxPollMs = getOnboardingMaxPollMs(input);
  const started = await requestJson<OnboardingAnalyzeJob>('/v1/admin/onboarding/analyze', {
    method: 'POST',
    body: JSON.stringify(input),
  });
  let lastJob = started;
  onProgress?.(started);
  if (started.status === 'completed' && started.result) {
    return started.result;
  }
  const startedAt = Date.now();
  while (Date.now() - startedAt < maxPollMs) {
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    const job = await requestJson<OnboardingAnalyzeJob>(`/v1/admin/onboarding/analyze/${encodeURIComponent(started.jobId)}`, {
      method: 'GET',
    });
    lastJob = job;
    onProgress?.(job);
    if (job.status === 'completed' && job.result) {
      return job.result;
    }
    if (job.status === 'failed') {
      throw new Error(job.message || '探测失败');
    }
  }
  const timeoutError = new Error('探测仍在执行中，请稍后重试或查看请求追踪。');
  (timeoutError as Error & { job?: OnboardingAnalyzeJob }).job = {
    ...lastJob,
    status: 'running',
  };
  throw timeoutError;
}

function getOnboardingMaxPollMs(input: OnboardingAnalyzeRequest) {
  const perProbeTimeoutMs = 360_000;
  const fixedBufferMs = 120_000;
  const targetKind = input.targetKind || 'images_endpoint';
  let executionCount = 1;

  if (targetKind === 'images_endpoint') {
    executionCount = 0;
    if (input.imagesGenerationUrl) {
      executionCount += 1;
    }
    if (input.imagesEditUrl) {
      executionCount += 1;
      if (input.referenceImageUrl) {
        executionCount += 2;
      }
    }
    executionCount = Math.max(executionCount, 1);
  } else if (targetKind === 'responses_endpoint') {
    const probeCount = input.referenceImageUrl ? 3 : 1;
    const maxAttemptsPerProbe = 3;
    executionCount = probeCount * maxAttemptsPerProbe;
  } else if (targetKind === 'chat_completions') {
    executionCount = 1;
  }

  return executionCount * perProbeTimeoutMs + fixedBufferMs;
}

export async function testUpstreamDraft(upstream: ConsoleUpstream, request: UpstreamTestRequest) {
  return requestJson<UpstreamTestResult>('/v1/admin/catalog/upstreams/test', {
    method: 'POST',
    body: JSON.stringify({ upstream, request }),
  });
}
