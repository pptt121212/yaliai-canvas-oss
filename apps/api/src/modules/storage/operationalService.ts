import crypto from 'node:crypto';
import { operationalRepository } from './operationalStore.js';
import type {
  AuditLogRecord,
  BillingLedgerRecord,
  RequestTraceRecord,
  TenantFinanceLedgerDirection,
  TenantFinanceLedgerRecord,
  TaskMasterRecord,
} from './repositoryContracts.js';

const traceTextMaxLength = 64 * 1024;

function createId(prefix: string) {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

function truncateTraceText(value: string) {
  if (value.length <= traceTextMaxLength) {
    return value;
  }
  return `${value.slice(0, traceTextMaxLength)}\n[trace text truncated original_length=${value.length}]`;
}

function redactEmbeddedImagePayloadText(value: string) {
  return value
    .replace(
      /("(?:b64_json|partial_image_b64)"\s*:\s*")([A-Za-z0-9+/=\s]{512,})(")/gi,
      (_match, prefix: string, payload: string, suffix: string) => (
        `${prefix}[base64 omitted length=${payload.replace(/\s+/g, '').length}]${suffix}`
      ),
    )
    .replace(
      /("(?:result|image|image_url|url)"\s*:\s*")(data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=\s]+)(")/gi,
      (_match, prefix: string, payload: string, suffix: string) => (
        `${prefix}[data-url omitted length=${payload.length}]${suffix}`
      ),
    )
    .replace(
      /data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=\s]{512,}/gi,
      (payload) => `[data-url omitted length=${payload.length}]`,
    );
}

function sanitizeTraceValue(value: unknown): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (/^Bearer\s+/i.test(trimmed)) {
      return 'Bearer ***';
    }
    if (/^sk-[A-Za-z0-9\-_]+/.test(trimmed) || /^yk_[A-Za-z0-9]+/.test(trimmed)) {
      return `${trimmed.slice(0, 6)}***`;
    }
    if (/^data:image\/[a-zA-Z0-9.+-]+;base64,/i.test(trimmed)) {
      return `[data-url omitted length=${trimmed.length}]`;
    }
    const compact = trimmed.replace(/\s+/g, '');
    if (compact.length >= 2048 && /^[A-Za-z0-9+/=]+$/.test(compact)) {
      return `[base64 omitted length=${compact.length}]`;
    }
    if (
      trimmed.length >= 512
      && (
        (trimmed.startsWith('{') && trimmed.endsWith('}'))
        || (trimmed.startsWith('[') && trimmed.endsWith(']'))
      )
    ) {
      try {
        const parsed = JSON.parse(trimmed);
        return truncateTraceText(JSON.stringify(sanitizeTraceValue(parsed)));
      } catch {
        // Keep non-JSON text handling below.
      }
    }
    return truncateTraceText(redactEmbeddedImagePayloadText(value));
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeTraceValue(item));
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const next: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(record)) {
      const normalizedKey = String(key || '').toLowerCase();
      if (normalizedKey === 'authorization') {
        next[key] = 'Bearer ***';
      } else if (normalizedKey.includes('api_key') || normalizedKey === 'apikey' || normalizedKey === 'keyhash' || normalizedKey === 'rawkey') {
        next[key] = typeof child === 'string' ? `${child.slice(0, 6)}***` : '***';
      } else {
        next[key] = sanitizeTraceValue(child);
      }
    }
    return next;
  }
  return value;
}

function sanitizeTraceRecord(input: RequestTraceRecord): RequestTraceRecord {
  return {
    ...input,
    downstreamRequest: sanitizeTraceValue(input.downstreamRequest || null) as Record<string, unknown> | null,
    downstreamResponse: sanitizeTraceValue(input.downstreamResponse || null) as Record<string, unknown> | null,
    upstreamRequest: sanitizeTraceValue(input.upstreamRequest || null) as Record<string, unknown> | null,
    upstreamResponse: sanitizeTraceValue(input.upstreamResponse || null) as Record<string, unknown> | null,
    errorPayload: sanitizeTraceValue(input.errorPayload || null) as Record<string, unknown> | null,
  };
}

function sanitizeTaskPayloadObject(value: Record<string, unknown> | null | undefined) {
  const sanitized = sanitizeTraceValue(value || null);
  if (!sanitized || typeof sanitized !== 'object' || Array.isArray(sanitized)) {
    return null;
  }
  return sanitized as Record<string, unknown>;
}

function sanitizeTaskRecord(input: TaskMasterRecord): TaskMasterRecord {
  return {
    ...input,
    requestPayload: sanitizeTaskPayloadObject(input.requestPayload) || {},
    responsePayload: sanitizeTaskPayloadObject(input.responsePayload),
    errorPayload: sanitizeTaskPayloadObject(input.errorPayload),
  };
}

export async function appendAuditRecord(input: Omit<AuditLogRecord, 'id' | 'createdAt'>) {
  const record: AuditLogRecord = {
    id: createId('audit'),
    createdAt: Date.now(),
    ...input,
  };
  return operationalRepository.appendAudit(record);
}

export async function appendRequestTrace(input: Omit<RequestTraceRecord, 'traceId' | 'createdAt' | 'updatedAt'> & {
  traceId?: string;
  createdAt?: number;
  updatedAt?: number;
}) {
  const record: RequestTraceRecord = sanitizeTraceRecord({
    traceId: input.traceId || createId('trace'),
    createdAt: Number(input.createdAt || Date.now()),
    updatedAt: Number(input.updatedAt || Date.now()),
    ...input,
  });
  return operationalRepository.appendTrace(record);
}

export async function updateRequestTrace(traceId: string, patch: Partial<RequestTraceRecord>) {
  return operationalRepository.updateTrace(traceId, sanitizeTraceTracePatch(patch));
}

function sanitizeTraceTracePatch(patch: Partial<RequestTraceRecord>): Partial<RequestTraceRecord> {
  return sanitizeTraceRecord({
    traceId: patch.traceId || 'trace_patch',
    createdAt: patch.createdAt || Date.now(),
    updatedAt: patch.updatedAt || Date.now(),
    source: patch.source || 'tenant_runtime_sync',
    scope: patch.scope || 'full_chain',
    status: patch.status || 'accepted',
    summary: patch.summary || '',
    requestId: patch.requestId,
    taskId: patch.taskId,
    tenantId: patch.tenantId,
    apiKeyId: patch.apiKeyId,
    channelId: patch.channelId,
    upstreamId: patch.upstreamId,
    upstreamName: patch.upstreamName,
    providerBaseUrl: patch.providerBaseUrl,
    operation: patch.operation,
    downstreamRequest: patch.downstreamRequest || null,
    downstreamResponse: patch.downstreamResponse || null,
    upstreamRequest: patch.upstreamRequest || null,
    upstreamResponse: patch.upstreamResponse || null,
    errorPayload: patch.errorPayload || null,
    failureCategory: patch.failureCategory,
    statusCode: patch.statusCode,
    tags: patch.tags,
  });
}

export async function createBillingReservation(input: Omit<BillingLedgerRecord, 'id' | 'createdAt' | 'updatedAt' | 'status' | 'chargedCredits'> & {
  reservedCredits: number;
}) {
  const record: BillingLedgerRecord = {
    id: createId('billing'),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    status: 'reserved',
    chargedCredits: 0,
    ...input,
  };
  return operationalRepository.createBillingLedger(record);
}

export async function createBillingCharge(input: Omit<BillingLedgerRecord, 'id' | 'createdAt' | 'updatedAt' | 'status'>) {
  const record: BillingLedgerRecord = {
    id: createId('billing'),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    status: input.chargedCredits > 0 ? 'charged' : 'voided',
    ...input,
  };
  return operationalRepository.createBillingLedger(record);
}

export async function applyBillingChargePersistenceBundle(input: {
  billingRecords: BillingLedgerRecord[];
  tenantFinanceLedger?: {
    idempotencyKey?: string;
    tenantId: string;
    operatorId: string;
    direction: TenantFinanceLedgerDirection;
    amountCents: number;
    note: string;
    currency?: 'cny';
    detail?: Record<string, unknown>;
  } | null;
}) {
  return operationalRepository.applyBillingChargePersistenceBundle({
    billingRecords: input.billingRecords,
    tenantFinanceLedger: input.tenantFinanceLedger
      ? {
          ...input.tenantFinanceLedger,
          currency: input.tenantFinanceLedger.currency || 'cny',
          detail: input.tenantFinanceLedger.detail || {},
        }
      : null,
  });
}

export async function upsertTaskRecord(input: TaskMasterRecord) {
  return operationalRepository.upsertTask(sanitizeTaskRecord(input));
}

export async function chargeBillingRecord(id: string, chargedCredits: number, detail: Record<string, unknown> = {}) {
  return operationalRepository.updateBillingLedger(id, {
    status: chargedCredits > 0 ? 'charged' : 'voided',
    chargedCredits,
    updatedAt: Date.now(),
    detail,
  });
}

export async function createTenantFinanceLedger(input: {
  idempotencyKey?: string;
  tenantId: string;
  operatorId: string;
  direction: TenantFinanceLedgerDirection;
  amountCents: number;
  note: string;
  currency?: 'cny';
  detail?: Record<string, unknown>;
}): Promise<TenantFinanceLedgerRecord> {
  return operationalRepository.createTenantFinanceLedger({
    tenantId: input.tenantId,
    idempotencyKey: input.idempotencyKey,
    operatorId: input.operatorId,
    direction: input.direction,
    amountCents: input.amountCents,
    note: input.note,
    currency: input.currency || 'cny',
    detail: input.detail || {},
  });
}
