import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import crypto from 'node:crypto';
import { scryptSync, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs/promises';
import { createReadStream, openAsBlob } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import {
  supportedImagesEditProtocols,
  type OpenAIImagesEditProtocol,
  type ProviderConfig,
} from '@yali/provider-core';
import {
  classifyResolutionTier,
  formatCnyMinorUnits,
  minorUnitsToYuan,
  parseImageSize,
  type ResolutionTier,
  yuanToMinorUnits,
} from '@yali/billing-core';
import { defaultWorkflow } from '@yali/workflow-schema';
import { registerAdminRoutes } from './admin.js';
import {
  adminConsoleCatalogStore,
  createMaskedApiKey,
  initializeAdminConsoleCatalogStore,
  type ConsoleApiKey,
  type ConsoleUpstream,
} from './modules/admin/consoleCatalog.js';
import {
  buildBillingAuditImageRecords,
  buildImageResolutionAuditRecord,
  buildImageResolutionAuditRecords,
  type BillingAuditImageRecord,
} from './modules/imageResolutionAudit.js';
import { resolveImageCapabilityCost } from './modules/imageCapabilityMatrix.js';
import { dynamicOverloadGuard } from './modules/runtime/dynamicOverloadGuard.js';
import { gatewayInstanceId } from './modules/runtime/gatewayIdentity.js';
import {
  createDownstreamCancellation,
  isDownstreamClientDisconnectedError,
  throwIfDownstreamCancelled,
} from './modules/runtime/downstreamCancellation.js';
import {
  isPassiveRecoveryReentryProvider,
  passiveRecoveryReentryIntervalSeconds,
} from './modules/routing/passiveRecovery.js';
import { startOperationalRollupScheduler } from './modules/operationalRollups.js';
import {
  appendAuditRecord,
  appendRequestTrace,
  applyBillingChargePersistenceBundle,
  updateRequestTrace,
  upsertTaskRecord,
} from './modules/storage/operationalService.js';
import { operationalRepository } from './modules/storage/operationalStore.js';
import {
  adminControlPlaneStore,
  initializeAdminControlPlaneStore,
  subscribeAdminControlPlane,
} from './modules/admin/controlPlane.js';
import { createJsonStore } from './modules/storage/jsonStore.js';
import {
  createPostgresCanvasUserRepository,
  createPostgresCanvasUserSessionRepository,
} from './modules/storage/postgresRepositories.js';
import { startPostgresConfigListener } from './modules/storage/postgresConfigEvents.js';
import { requireSharedHotState } from './modules/storage/sharedStateMode.js';
import { hasDatabaseUrl, requireDatabaseUrl } from './modules/storage/storageMode.js';
import type {
  CanvasUserRecord,
  CanvasUserSessionRecord,
  CanvasWorkflowRunState,
  BillingLedgerRecord,
  ImageGatewayPersistenceBundle,
  ImageGatewayTaskState,
  OperationalOutboxEventRecord,
  TaskMasterRecord,
  WorkflowNodeState,
  WorkflowRunJobState,
} from './modules/storage/repositoryContracts.js';
import {
  asyncHotStateStore,
  hotStateAtomicCounters,
  hotStateStore,
  refreshHotProviderRuntime,
  sharedHotStateStrict,
} from './modules/storage/runtimeStores.js';
import {
  initializeProviderRegistry,
  providerRegistry,
  resolveProvider,
} from './providerRegistry.js';
import { createConcurrencyService, createRateLimitService } from './modules/storage/hotStateServices.js';
import { buildImageRequestPlanForProvider, resolveImageProviderPlan } from './imageGateway.js';
import {
  buildSmartImageRoutingPlan,
  classifyUpstreamFailure,
  type ImageRoutingMode,
  type SmartImageRoutingPlan,
} from './smartImageRouting.js';
import {
  createWorkflowRunSchema,
  type CanvasEdge,
  type CanvasGeneratedItem,
  type CanvasNode,
  type CanvasWorkflowPayload,
} from './canvasWorkflowSchema.js';

const requestBodyLimitBytes = Math.max(1 * 1024 * 1024, Number(process.env.API_REQUEST_BODY_LIMIT_BYTES || 128 * 1024 * 1024));
const imageRouteBodyLimitBytes = Math.max(4 * 1024 * 1024, Number(process.env.IMAGE_ROUTE_BODY_LIMIT_BYTES || 48 * 1024 * 1024));
const app = Fastify({
  logger: true,
  bodyLimit: requestBodyLimitBytes,
});
let gatewayAcceptingTraffic = false;
requireDatabaseUrl('api_server');
requireSharedHotState('api_server');
const port = Number(process.env.PORT || 4010);
const host = process.env.HOST || '0.0.0.0';
const gracefulShutdownTimeoutMs = Math.max(30_000, Number(process.env.GRACEFUL_SHUTDOWN_TIMEOUT_MS || 11 * 60_000));
const imageTaskHotTtlSeconds = 60 * 15;
const configuredImageTaskQueryTtlSeconds = Math.max(
  60 * 15,
  Math.floor(Number(process.env.ASYNC_IMAGE_TASK_TTL_SECONDS || 60 * 720)),
);
const asyncImageQueueMax = Math.max(1, Math.floor(Number(process.env.ASYNC_IMAGE_QUEUE_MAX || 200)));
const asyncImageQueuePerApiKeyMax = Math.max(1, Math.floor(Number(process.env.ASYNC_IMAGE_QUEUE_PER_API_KEY_MAX || 20)));
const asyncImageQueueWaitMs = Math.max(5_000, Math.floor(Number(process.env.ASYNC_IMAGE_QUEUE_WAIT_MS || 60_000)));
const asyncImageQueuePollMs = Math.max(250, Math.floor(Number(process.env.ASYNC_IMAGE_QUEUE_POLL_MS || 1_000)));
const asyncImageQueueDispatchPerTick = Math.max(1, Math.floor(Number(process.env.ASYNC_IMAGE_QUEUE_DISPATCH_PER_TICK || 4)));
const asyncImageTaskClaimTtlSeconds = Math.max(15, Math.floor(Number(process.env.ASYNC_IMAGE_TASK_CLAIM_TTL_SECONDS || 120)));
const imagePersistenceOutboxEnabled = String(process.env.IMAGE_PERSISTENCE_OUTBOX_ENABLED || 'true').toLowerCase() !== 'false';
const imagePersistenceOutboxPollMs = Math.max(250, Math.floor(Number(process.env.IMAGE_PERSISTENCE_OUTBOX_POLL_MS || 1_000)));
const imagePersistenceOutboxBatchSize = Math.max(1, Math.min(50, Math.floor(Number(process.env.IMAGE_PERSISTENCE_OUTBOX_BATCH_SIZE || 10))));
const imagePersistenceOutboxLockMs = Math.max(10_000, Math.floor(Number(process.env.IMAGE_PERSISTENCE_OUTBOX_LOCK_MS || 120_000)));
const imagePersistenceOutboxMaxAttempts = Math.max(3, Math.floor(Number(process.env.IMAGE_PERSISTENCE_OUTBOX_MAX_ATTEMPTS || 20)));
const workflowRunTtlSeconds = 60 * 60 * 24;
const canvasUserSessionTtlMs = 1000 * 60 * 60 * 24 * 14;
const imageChannelId = 'channel_image_generation';
const textChannelId = 'channel_text_processing';
const generatedImageSubdir = 'generated-images';
const canvasReferenceAssetSubdir = 'canvas-reference-assets';
const generatedImageAccelRedirectPrefix = String(process.env.GENERATED_IMAGE_ACCEL_REDIRECT_PREFIX || '')
  .trim()
  .replace(/\/+$/, '');
const generatedImageAccelRedirectTargetDir = String(process.env.GENERATED_IMAGE_ACCEL_REDIRECT_TARGET_DIR || '')
  .trim();
function resolveRetentionMs(envKey: string, fallbackMs: number) {
  const raw = Number(process.env[envKey] || 0);
  if (!Number.isFinite(raw) || raw <= 0) {
    return fallbackMs;
  }
  return Math.max(60_000, Math.floor(raw));
}

const operationalTraceRetentionMs = resolveRetentionMs('OPERATIONAL_TRACE_RETENTION_MS', 30 * 60 * 1000);
const operationalTaskRetentionMs = resolveRetentionMs('OPERATIONAL_TASK_RETENTION_MS', 14 * 24 * 60 * 60 * 1000);
const operationalAuditRetentionMs = resolveRetentionMs('OPERATIONAL_AUDIT_RETENTION_MS', 90 * 24 * 60 * 60 * 1000);
const operationalBillingRetentionMs = resolveRetentionMs('OPERATIONAL_BILLING_RETENTION_MS', 180 * 24 * 60 * 60 * 1000);
const generatedImageRetentionMs = resolveRetentionMs('GENERATED_IMAGE_RETENTION_MS', 20 * 60 * 1000);
const canvasReferenceAssetRetentionMs = resolveRetentionMs('CANVAS_REFERENCE_ASSET_RETENTION_MS', generatedImageRetentionMs);
const operationalMaintenanceIntervalMs = Math.max(60_000, Number(process.env.OPERATIONAL_MAINTENANCE_INTERVAL_MS || 5 * 60 * 1000));
const operationalRollupHardDisabled = String(process.env.OPERATIONAL_ROLLUP_ENABLED || '').trim().toLowerCase() === 'false';
const operationalRollupIntervalMs = Math.max(15 * 60 * 1000, Number(process.env.OPERATIONAL_ROLLUP_INTERVAL_MS || 6 * 60 * 60 * 1000));
const operationalRollupLookbackDays = Math.max(1, Math.min(3, Number(process.env.OPERATIONAL_ROLLUP_LOOKBACK_DAYS || 2)));
const operationalRollupBucketMs = Math.max(60 * 60 * 1000, Number(process.env.OPERATIONAL_ROLLUP_BUCKET_MS || 24 * 60 * 60 * 1000));
const operationalRollupLockMs = Math.max(5 * 60 * 1000, Number(process.env.OPERATIONAL_ROLLUP_LOCK_MS || 30 * 60 * 1000));
const hardMaxInputImagePayloadBytes = 12 * 1024 * 1024;
const maxImagePayloadBytes = Math.max(
  1 * 1024 * 1024,
  Math.min(hardMaxInputImagePayloadBytes, Number(process.env.IMAGE_PAYLOAD_MAX_BYTES || hardMaxInputImagePayloadBytes)),
);
const hardMaxInputImageCount = 6;
const hardMaxInputImageTotalBytes = 30 * 1024 * 1024;
const multipartInputSpoolRoot = path.join(
  String(process.env.MULTIPART_INPUT_SPOOL_DIR || '').trim() || path.join(process.cwd(), 'data', 'multipart-input-spool'),
);
const asyncTaskAssetRoot = path.join(
  String(process.env.ASYNC_TASK_ASSET_DIR || '').trim() || path.join(process.cwd(), 'data', 'async-task-assets'),
);
const multipartInputSpoolStaleMs = Math.max(5 * 60_000, Number(process.env.MULTIPART_INPUT_SPOOL_STALE_MS || 60 * 60_000));
const maxUpstreamJsonResponseBytes = Math.max(1 * 1024 * 1024, Number(process.env.UPSTREAM_JSON_RESPONSE_MAX_BYTES || 96 * 1024 * 1024));
const maxUpstreamBinaryResponseBytes = Math.max(1 * 1024 * 1024, Number(process.env.UPSTREAM_BINARY_RESPONSE_MAX_BYTES || 64 * 1024 * 1024));
await app.register(multipart, {
  limits: {
    fileSize: maxImagePayloadBytes,
    files: hardMaxInputImageCount,
    parts: hardMaxInputImageCount + 32,
  },
});
const concurrencyService = createConcurrencyService(hotStateStore);
const rateLimitService = createRateLimitService(hotStateStore);
const canvasUserCookieName = 'yali_canvas_user_session';

function requestLogWarn(event: string, error: unknown) {
  app.log.warn({
    event,
    error: error instanceof Error ? error.message : String(error),
  });
}

function createSharedHotStateUnavailableError(operation: string) {
  const error = new Error(`Shared state backend is unavailable during ${operation}.`);
  (error as Error & { statusCode?: number; code?: string; details?: Record<string, unknown> }).statusCode = 503;
  (error as Error & { statusCode?: number; code?: string; details?: Record<string, unknown> }).code = 'shared_state_unavailable';
  (error as Error & { statusCode?: number; code?: string; details?: Record<string, unknown> }).details = {
    operation,
  };
  return error;
}

const routingModeSchema = z.enum([
  'health_weighted_best',
  'priority_failover',
  'round_robin_failover',
  'weighted_round_robin',
  'least_recently_used',
  'smart_priority',
  'smart_failover',
  'fixed_provider',
]);

const referenceImageObjectSchema = z.object({
  image_url: z.string().optional(),
  download_url: z.string().optional(),
  remote_reference_url: z.string().optional(),
  url: z.string().optional(),
}).passthrough();

const imageInputValueSchema = z.string();
const referenceImageInputValueSchema = z.union([imageInputValueSchema, referenceImageObjectSchema]);
const originalMultipartImageFileNamesMetadataKey = '__yali_original_multipart_image_file_names';

const openAIImagesSchema = z.object({
  model: z.string().min(1),
  prompt: z.string().min(1),
  action: z.string().optional(),
  size: z.string().optional(),
  resolution: z.enum(['auto', '1k', '2k', '4k']).optional(),
  response_format: z.enum(['url', 'b64_json']).optional(),
  quality: z.string().optional(),
  n: z.number().int().positive().max(10).optional(),
  async: z.boolean().optional(),
  user: z.string().optional(),
  image: z.union([imageInputValueSchema, z.array(imageInputValueSchema).max(hardMaxInputImageCount)]).optional(),
  reference_images: z.array(referenceImageInputValueSchema).max(hardMaxInputImageCount).optional(),
  reference_image_instructions: z.union([z.string(), z.array(z.string()).max(hardMaxInputImageCount)]).optional(),
  prioritize_first_reference_image: z.boolean().optional(),
  stream: z.boolean().optional(),
  output_format: z.string().optional(),
  output_quality: z.number().min(0).max(100).optional(),
  output_compression: z.number().min(0).max(100).optional(),
  background: z.string().optional(),
  moderation: z.string().optional(),
  callback_url: z.string().url().optional(),
  image_quality: z.number().min(0).max(100).optional(),
  image_tool_quality: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  extra_body: z.record(z.string(), z.unknown()).optional(),
  provider_source: z.enum(['admin_managed', 'user_supplied']).optional(),
  user_image_api_kind: z.enum(['images_endpoint', 'responses_endpoint']).optional(),
  user_api_base_url: z.string().url().optional(),
  user_images_generations_url: z.string().url().optional(),
  user_images_edits_url: z.string().url().optional(),
  user_api_key: z.string().optional(),
  preferred_auth_mode: z.enum(['bearer', 'x-api-key']).optional(),
  routing_mode: routingModeSchema.optional(),
});

const imageExtraBodyFieldNames = [
  'stream',
  'output_format',
  'output_quality',
  'output_compression',
  'background',
  'moderation',
  'callback_url',
  'image_quality',
  'image_tool_quality',
] as const;

const compatibleAspectResolutionSizeMap: Record<string, Record<'1k' | '2k' | '4k', string>> = {
  '1:1': { '1k': '1024x1024', '2k': '2048x2048', '4k': '2880x2880' },
  '3:2': { '1k': '1536x1024', '2k': '2048x1360', '4k': '3520x2336' },
  '2:3': { '1k': '1024x1536', '2k': '1360x2048', '4k': '2336x3520' },
  '4:3': { '1k': '1024x768', '2k': '2048x1536', '4k': '3312x2480' },
  '3:4': { '1k': '768x1024', '2k': '1536x2048', '4k': '2480x3312' },
  '5:4': { '1k': '1280x1024', '2k': '2560x2048', '4k': '3216x2576' },
  '4:5': { '1k': '1024x1280', '2k': '2048x2560', '4k': '2576x3216' },
  '16:9': { '1k': '1536x864', '2k': '2048x1152', '4k': '3840x2160' },
  '9:16': { '1k': '864x1536', '2k': '1152x2048', '4k': '2160x3840' },
  '2:1': { '1k': '2048x1024', '2k': '2688x1344', '4k': '3840x1920' },
  '1:2': { '1k': '1024x2048', '2k': '1344x2688', '4k': '1920x3840' },
  '21:9': { '1k': '2016x864', '2k': '2688x1152', '4k': '3840x1648' },
  '9:21': { '1k': '864x2016', '2k': '1152x2688', '4k': '1648x3840' },
};

type ImageInputLimits = {
  maxCount: number;
  maxImageBytes: number;
  maxTotalBytes: number;
};

type ImageInputByteBudget = ImageInputLimits & {
  totalBytes: number;
};

function getImageInputLimits(): ImageInputLimits {
  const publicApi = adminControlPlaneStore.get().publicApi;
  return {
    maxCount: Math.max(1, Math.min(hardMaxInputImageCount, Math.floor(Number(publicApi.maxInputImageCount || hardMaxInputImageCount)))),
    maxImageBytes: Math.max(
      1 * 1024 * 1024,
      Math.min(maxImagePayloadBytes, Math.floor(Number(publicApi.maxInputImageMb || 12) * 1024 * 1024)),
    ),
    maxTotalBytes: Math.max(
      1 * 1024 * 1024,
      Math.min(hardMaxInputImageTotalBytes, Math.floor(Number(publicApi.maxInputImageTotalMb || 30) * 1024 * 1024)),
    ),
  };
}

function createImageInputByteBudget(): ImageInputByteBudget {
  return {
    ...getImageInputLimits(),
    totalBytes: 0,
  };
}

function createInputImageTotalTooLargeError(receivedBytes: number, maxBytes: number) {
  const error = new Error('Combined input image payload exceeds maximum size.');
  (error as Error & { statusCode?: number; code?: string; details?: Record<string, unknown> }).statusCode = 413;
  (error as Error & { statusCode?: number; code?: string; details?: Record<string, unknown> }).code = 'input_image_total_too_large';
  (error as Error & { statusCode?: number; code?: string; details?: Record<string, unknown> }).details = {
    max_input_image_total_bytes: maxBytes,
    received_input_image_total_bytes: receivedBytes,
  };
  return error;
}

function consumeImageInputBytes(budget: ImageInputByteBudget, bytes: number) {
  const nextTotalBytes = budget.totalBytes + Math.max(0, bytes);
  if (nextTotalBytes > budget.maxTotalBytes) {
    throw createInputImageTotalTooLargeError(nextTotalBytes, budget.maxTotalBytes);
  }
  budget.totalBytes = nextTotalBytes;
}

function createImagePayloadTooLargeError(receivedBytes: number, maxBytes = getImageInputLimits().maxImageBytes) {
  const error = new Error('Image payload exceeds maximum size.');
  (error as Error & { statusCode?: number; code?: string; details?: Record<string, unknown> }).statusCode = 413;
  (error as Error & { statusCode?: number; code?: string; details?: Record<string, unknown> }).code = 'image_payload_too_large';
  (error as Error & { statusCode?: number; code?: string; details?: Record<string, unknown> }).details = {
    max_image_payload_bytes: maxBytes,
    received_image_payload_bytes: receivedBytes,
  };
  return error;
}

function isMultipartOpenAIImagesRequest(request: any) {
  return typeof request?.isMultipart === 'function' && request.isMultipart();
}

function normalizeMultipartImageFieldName(fieldName: string) {
  const normalized = String(fieldName || '').trim();
  if (normalized === 'image[]' || normalized === 'images[]' || normalized === 'images') {
    return 'image';
  }
  if (normalized === 'image_urls[]' || normalized === 'reference_images[]') {
    return normalized.endsWith('reference_images[]') ? 'reference_images' : 'image_urls';
  }
  return normalized;
}

function parseMultipartBoolean(value: unknown) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  return normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on';
}

function parseMultipartScalarValue(fieldName: string, rawValue: unknown) {
  const value = typeof rawValue === 'string' ? rawValue.trim() : String(rawValue ?? '').trim();
  if (!value) {
    return '';
  }
  if (fieldName === 'async' || fieldName === 'stream') {
    return parseMultipartBoolean(value);
  }
  if (fieldName === 'n' || fieldName === 'output_quality' || fieldName === 'output_compression' || fieldName === 'image_quality') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : value;
  }
  if (fieldName === 'metadata' || fieldName === 'extra_body') {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  return value;
}

function normalizeIncomingMultipartImageFileName(value: unknown) {
  const raw = String(value || '').trim().replace(/\\/g, '/');
  if (!raw) {
    return '';
  }
  return path.basename(raw).replace(/[\u0000-\u001F\u007F]/g, '').trim().slice(0, 255);
}

type MultipartImageSource = {
  sourceRef: string;
  filePath: string;
  fileName: string;
  mimeType: string;
  extension: string;
  bytes: number;
};

type AsyncTaskImageAsset = {
  sourceRef: string;
  assetName: string;
  fileName: string;
  mimeType: string;
  extension: string;
  bytes: number;
};

type MultipartInputSpool = {
  directory: string;
  sources: MultipartImageSource[];
};

const multipartInputSpools = new WeakMap<object, MultipartInputSpool>();
const multipartImageSourcePrefix = 'yali-multipart-source://';
const asyncTaskImageAssetPrefix = 'yali-async-asset://';

function getMultipartInputSpool(request: any) {
  if (!request || typeof request !== 'object') {
    return undefined;
  }
  return multipartInputSpools.get(request);
}

async function getOrCreateMultipartInputSpool(request: any) {
  const existing = getMultipartInputSpool(request);
  if (existing) {
    return existing;
  }
  await fs.mkdir(multipartInputSpoolRoot, { recursive: true });
  const directory = await fs.mkdtemp(path.join(multipartInputSpoolRoot, 'request-'));
  const spool: MultipartInputSpool = { directory, sources: [] };
  multipartInputSpools.set(request, spool);
  return spool;
}

async function releaseMultipartInputSpool(request: any) {
  const spool = getMultipartInputSpool(request);
  if (!spool || !request || typeof request !== 'object') {
    return;
  }
  multipartInputSpools.delete(request);
  await fs.rm(spool.directory, { recursive: true, force: true });
}

async function cleanupStaleMultipartInputSpools() {
  await fs.mkdir(multipartInputSpoolRoot, { recursive: true });
  const cutoff = Date.now() - multipartInputSpoolStaleMs;
  const entries = await fs.readdir(multipartInputSpoolRoot, { withFileTypes: true });
  await Promise.all(entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('request-'))
    .map(async (entry) => {
      const directory = path.join(multipartInputSpoolRoot, entry.name);
      const stat = await fs.stat(directory).catch(() => undefined);
      if (stat && stat.mtimeMs < cutoff) {
        await fs.rm(directory, { recursive: true, force: true });
      }
    }));
}

async function cleanupStaleAsyncTaskAssets() {
  await fs.mkdir(asyncTaskAssetRoot, { recursive: true });
  const cutoff = Date.now() - imageTaskHotTtlSeconds * 1000;
  const entries = await fs.readdir(asyncTaskAssetRoot, { withFileTypes: true });
  await Promise.all(entries.filter((entry) => entry.isDirectory()).map(async (entry) => {
    const directory = path.join(asyncTaskAssetRoot, entry.name);
    const stat = await fs.stat(directory).catch(() => undefined);
    if (stat && stat.mtimeMs < cutoff) {
      await fs.rm(directory, { recursive: true, force: true });
    }
  }));
}

function sourceRefForMultipartImage(index: number) {
  return `${multipartImageSourcePrefix}${index}`;
}

function sourceForMultipartImageValue(request: any, value: unknown) {
  const sourceRef = String(value || '').trim();
  if (!sourceRef.startsWith(multipartImageSourcePrefix)) {
    return undefined;
  }
  return getMultipartInputSpool(request)?.sources.find((source) => source.sourceRef === sourceRef);
}

function multipartImageSourcesForPayload(request: any, payload: z.infer<typeof openAIImagesSchema>) {
  const values = payload.image ? (Array.isArray(payload.image) ? payload.image : [payload.image]) : [];
  if (!values.length) {
    return undefined;
  }
  const sources = values.map((value) => sourceForMultipartImageValue(request, value));
  return sources.every((source): source is MultipartImageSource => Boolean(source)) ? sources : undefined;
}

function resolveAsyncTaskAssetPath(assetDirectory: string | undefined, assetName: string) {
  const directory = String(assetDirectory || '').trim();
  const safeAssetName = sanitizeFileSegment(assetName);
  if (!directory || !safeAssetName || safeAssetName !== assetName) {
    return undefined;
  }
  const resolvedDirectory = path.resolve(directory);
  const filePath = path.resolve(resolvedDirectory, safeAssetName);
  return filePath.startsWith(`${resolvedDirectory}${path.sep}`) ? filePath : undefined;
}

function asyncTaskImageSourcesForPayload(input: {
  assetDirectory?: string;
  imageAssets?: AsyncTaskImageAsset[];
  payload: z.infer<typeof openAIImagesSchema>;
}) {
  const values = input.payload.image ? (Array.isArray(input.payload.image) ? input.payload.image : [input.payload.image]) : [];
  if (!values.length || !input.imageAssets?.length) {
    return undefined;
  }
  const assetsBySourceRef = new Map(input.imageAssets.map((asset) => [asset.sourceRef, asset]));
  const sources = values.map((value) => {
    const asset = assetsBySourceRef.get(String(value || '').trim());
    const filePath = asset ? resolveAsyncTaskAssetPath(input.assetDirectory, asset.assetName) : undefined;
    return asset && filePath
      ? {
          sourceRef: asset.sourceRef,
          filePath,
          fileName: asset.fileName,
          mimeType: asset.mimeType,
          extension: asset.extension,
          bytes: asset.bytes,
        }
      : undefined;
  });
  return sources.every((source): source is MultipartImageSource => Boolean(source)) ? sources : undefined;
}

function imageFileSourcesForPayload(input: {
  request: any;
  payload: z.infer<typeof openAIImagesSchema>;
  asyncTaskAssetDirectory?: string;
  asyncTaskImageAssets?: AsyncTaskImageAsset[];
}) {
  return multipartImageSourcesForPayload(input.request, input.payload)
    || asyncTaskImageSourcesForPayload({
      assetDirectory: input.asyncTaskAssetDirectory,
      imageAssets: input.asyncTaskImageAssets,
      payload: input.payload,
    });
}

async function materializeImageFileSources(
  payload: z.infer<typeof openAIImagesSchema>,
  sources: MultipartImageSource[],
  label: string,
): Promise<z.infer<typeof openAIImagesSchema>> {
  if (!payload.image) {
    return payload;
  }
  const values = Array.isArray(payload.image) ? payload.image : [payload.image];
  const sourcesByRef = new Map(sources.map((source) => [source.sourceRef, source]));
  const materialized: string[] = [];
  for (const value of values) {
    const source = sourcesByRef.get(String(value || '').trim());
    if (!source) {
      materialized.push(String(value || ''));
      continue;
    }
    const buffer = await fs.readFile(source.filePath);
    assertBufferWithinLimit(buffer, label);
    materialized.push(`data:${source.mimeType};base64,${buffer.toString('base64')}`);
  }
  return {
    ...payload,
    image: Array.isArray(payload.image) ? materialized : materialized[0],
  };
}

async function persistAsyncTaskMultipartAssets(
  request: any,
  taskId: string,
  payload: z.infer<typeof openAIImagesSchema>,
) {
  const values = payload.image ? (Array.isArray(payload.image) ? payload.image : [payload.image]) : [];
  if (!values.length) return { payload, assetDirectory: '', imageAssets: [] as AsyncTaskImageAsset[] };
  const directory = path.join(asyncTaskAssetRoot, sanitizeFileSegment(taskId));
  const nextValues: string[] = [];
  const imageAssets: AsyncTaskImageAsset[] = [];
  let copied = false;
  for (let index = 0; index < values.length; index += 1) {
    const source = sourceForMultipartImageValue(request, values[index]);
    if (!source) {
      nextValues.push(values[index]);
      continue;
    }
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const assetName = `${index + 1}-${crypto.randomUUID()}.${source.extension}`;
    await fs.copyFile(source.filePath, path.join(directory, assetName));
    const sourceRef = `${asyncTaskImageAssetPrefix}${assetName}`;
    nextValues.push(sourceRef);
    imageAssets.push({
      sourceRef,
      assetName,
      fileName: source.fileName,
      mimeType: source.mimeType,
      extension: source.extension,
      bytes: source.bytes,
    });
    copied = true;
  }
  if (!copied) return { payload, assetDirectory: '', imageAssets: [] as AsyncTaskImageAsset[] };
  return {
    payload: { ...payload, image: Array.isArray(payload.image) ? nextValues : nextValues[0] },
    assetDirectory: directory,
    imageAssets,
  };
}

async function spoolMultipartImageFilePart(
  request: any,
  part: any,
  budget: ImageInputByteBudget,
) {
  const spool = await getOrCreateMultipartInputSpool(request);
  const index = spool.sources.length;
  const filePath = path.join(spool.directory, `reference-${index + 1}-${crypto.randomUUID()}.bin`);
  const handle = await fs.open(filePath, 'w', 0o600);
  let totalBytes = 0;
  let header = Buffer.alloc(0);
  let completed = false;

  try {
    for await (const chunk of part.file) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += buffer.length;
      if (totalBytes > budget.maxImageBytes) {
        throw createImagePayloadTooLargeError(totalBytes, budget.maxImageBytes);
      }
      if (budget.totalBytes + totalBytes > budget.maxTotalBytes) {
        throw createInputImageTotalTooLargeError(budget.totalBytes + totalBytes, budget.maxTotalBytes);
      }
      if (header.length < 16) {
        header = Buffer.concat([header, buffer.subarray(0, Math.max(0, 16 - header.length))]);
      }
      await handle.write(buffer);
    }
    await handle.close();
    completed = true;
  } finally {
    if (!completed) {
      await handle.close().catch(() => undefined);
      await fs.rm(filePath, { force: true }).catch(() => undefined);
    }
  }

  consumeImageInputBytes(budget, totalBytes);
  const extension = detectImageExtensionFromBuffer(header);
  const declaredMimeType = String(part.mimetype || '').trim().toLowerCase();
  const mimeType = declaredMimeType.startsWith('image/') ? declaredMimeType : contentTypeForExtension(extension);
  const source: MultipartImageSource = {
    sourceRef: sourceRefForMultipartImage(index),
    filePath,
    fileName: normalizeIncomingMultipartImageFileName(part.filename) || `reference-${index + 1}.${extension}`,
    mimeType,
    extension,
    bytes: totalBytes,
  };
  spool.sources.push(source);
  return source;
}

async function readMultipartFilePartAsDataUrl(part: any, budget: ImageInputByteBudget) {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of part.file) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.length;
    if (totalBytes > budget.maxImageBytes) {
      throw createImagePayloadTooLargeError(totalBytes, budget.maxImageBytes);
    }
    if (budget.totalBytes + totalBytes > budget.maxTotalBytes) {
      throw createInputImageTotalTooLargeError(budget.totalBytes + totalBytes, budget.maxTotalBytes);
    }
    chunks.push(buffer);
  }
  const buffer = Buffer.concat(chunks);
  assertBufferWithinLimit(buffer, 'multipart ingress image', budget.maxImageBytes);
  consumeImageInputBytes(budget, buffer.length);
  const extension = detectImageExtensionFromBuffer(buffer);
  return `data:${contentTypeForExtension(extension)};base64,${buffer.toString('base64')}`;
}

async function parseMultipartOpenAIImagesBody(request: any) {
  const payload: Record<string, unknown> = {};
  const imageValues: string[] = [];
  const imageFileNames: string[] = [];
  const imageBudget = createImageInputByteBudget();

  for await (const part of request.parts()) {
    const fieldName = normalizeMultipartImageFieldName(part.fieldname || '');
    if (!fieldName) {
      continue;
    }

    if (part.type === 'file') {
      if (fieldName === 'image' || fieldName === 'image_url' || fieldName === 'image_urls' || fieldName === 'reference_images') {
        const source = await spoolMultipartImageFilePart(request, part, imageBudget);
        imageValues.push(source.sourceRef);
        imageFileNames.push(source.fileName);
        continue;
      }
      const dataUrl = await readMultipartFilePartAsDataUrl(part, imageBudget);
      payload[fieldName] = dataUrl;
      continue;
    }

    const parsedValue = parseMultipartScalarValue(fieldName, part.value);
    if (fieldName === 'image' || fieldName === 'image_url') {
      if (typeof parsedValue === 'string' && parsedValue) {
        imageValues.push(parsedValue);
        imageFileNames.push('');
      }
      continue;
    }
    if (fieldName === 'image_urls' || fieldName === 'reference_images') {
      if (typeof parsedValue === 'string' && parsedValue) {
        imageValues.push(parsedValue);
        imageFileNames.push('');
      }
      continue;
    }
    if (payload[fieldName] !== undefined) {
      const current = payload[fieldName];
      payload[fieldName] = Array.isArray(current) ? [...current, parsedValue] : [current, parsedValue];
      continue;
    }
    payload[fieldName] = parsedValue;
  }

  if (imageValues.length) {
    payload.image = imageValues.length === 1 ? imageValues[0] : imageValues;
    if (imageFileNames.some(Boolean)) {
      const metadata = payload.metadata && typeof payload.metadata === 'object' && !Array.isArray(payload.metadata)
        ? payload.metadata as Record<string, unknown>
        : {};
      payload.metadata = {
        ...metadata,
        [originalMultipartImageFileNamesMetadataKey]: imageFileNames,
      };
    }
  }
  return normalizeCompatibleOpenAIImagesBody(payload);
}

async function parseIncomingOpenAIImagesBody(request: any) {
  if (isMultipartOpenAIImagesRequest(request)) {
    return parseMultipartOpenAIImagesBody(request);
  }
  return normalizeCompatibleOpenAIImagesBody(request.body);
}

app.addHook('onResponse', async (request) => {
  try {
    await releaseMultipartInputSpool(request);
  } catch (error) {
    requestLogWarn('multipart_input_spool_cleanup_failed', error);
  }
});

function extractCompatibleImageInputsFromBody(rawBody: unknown) {
  if (!rawBody || typeof rawBody !== 'object' || Array.isArray(rawBody)) {
    return undefined;
  }
  const record = rawBody as Record<string, unknown>;
  if (record.image !== undefined) {
    return record.image;
  }
  if (typeof record.image_url === 'string' && record.image_url.trim()) {
    return record.image_url.trim();
  }
  if (Array.isArray(record.image_urls)) {
    const values = record.image_urls
      .map((item) => String(item || '').trim())
      .filter(Boolean);
    if (values.length) {
      return values;
    }
  }
  if (Array.isArray(record.reference_images)) {
    const values = record.reference_images
      .map((item) => {
        if (typeof item === 'string') {
          return item.trim();
        }
        if (!item || typeof item !== 'object') {
          return '';
        }
        return String(
          (item as Record<string, unknown>).image_url
          || (item as Record<string, unknown>).download_url
          || (item as Record<string, unknown>).remote_reference_url
          || (item as Record<string, unknown>).url
          || '',
        ).trim();
      })
      .filter(Boolean);
    if (values.length) {
      return values;
    }
  }
  if (Array.isArray(record.images)) {
    const values = record.images
      .map((item) => {
        if (typeof item === 'string') {
          return item.trim();
        }
        if (!item || typeof item !== 'object') {
          return '';
        }
        return String((item as Record<string, unknown>).image_url || '').trim();
      })
      .filter(Boolean);
    if (values.length) {
      return values.length === 1 ? values[0] : values;
    }
  }
  return undefined;
}

function normalizeCompatibleAspectSize(value: unknown) {
  const match = String(value || '').trim().toLowerCase().match(/^(\d+)\s*:\s*(\d+)$/);
  if (!match) {
    return '';
  }
  return `${Number(match[1])}:${Number(match[2])}`;
}

function normalizeCompatibleResolutionTier(value: unknown): '1k' | '2k' | '4k' | '' {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized === '1k' || normalized === '2k' || normalized === '4k' ? normalized : '';
}

function normalizeCompatibleResolutionMode(value: unknown): 'auto' | '1k' | '2k' | '4k' | '' {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'auto') {
    return 'auto';
  }
  return normalizeCompatibleResolutionTier(normalized);
}

function normalizeCompatibleOpenAIImagesBody(rawBody: unknown) {
  if (!rawBody || typeof rawBody !== 'object' || Array.isArray(rawBody)) {
    return rawBody;
  }
  const record = rawBody as Record<string, unknown>;
  const compatibleImage = extractCompatibleImageInputsFromBody(rawBody);
  const rawSize = String(record.size || '').trim();
  const rawResolution = String(record.resolution || '').trim();
  const compatibleAspect = normalizeCompatibleAspectSize(rawSize);
  const requestedPixelSize = parseImageSize(rawSize)?.normalized || '';
  const requestedResolution = normalizeCompatibleResolutionMode(record.resolution);
  const compatiblePixelSize = compatibleAspect && requestedResolution && requestedResolution !== 'auto'
    ? compatibleAspectResolutionSizeMap[compatibleAspect]?.[requestedResolution]
    : '';
  const shouldUseAutoSize = !requestedPixelSize && !compatiblePixelSize;

  if (compatibleImage === undefined && requestedPixelSize && !rawResolution) {
    return rawBody;
  }
  const metadata = record.metadata && typeof record.metadata === 'object' && !Array.isArray(record.metadata)
    ? record.metadata as Record<string, unknown>
    : {};
  const { resolution: _compatibleResolution, ...recordWithoutCompatibleResolution } = record;
  return {
    ...recordWithoutCompatibleResolution,
    ...(compatibleImage !== undefined ? { image: compatibleImage } : {}),
    ...(requestedPixelSize
      ? {
          size: requestedPixelSize,
        }
      : {}),
    ...(compatiblePixelSize
      ? {
          size: compatiblePixelSize,
          resolution: requestedResolution,
          metadata: {
            ...metadata,
            yali_requested_aspect_ratio: compatibleAspect,
            yali_requested_resolution: requestedResolution,
          },
        }
      : {}),
    ...(shouldUseAutoSize
      ? {
          size: 'auto',
          resolution: 'auto',
          metadata: {
            ...metadata,
            ...(compatibleAspect ? { yali_requested_aspect_ratio: compatibleAspect } : {}),
            yali_requested_resolution: 'auto',
          },
        }
      : {}),
  };
}

function normalizeOpenAIImagesPayload(payload: z.infer<typeof openAIImagesSchema>) {
  const extraBody = { ...(payload.extra_body || {}) };
  delete extraBody.partial_images;
  for (const key of imageExtraBodyFieldNames) {
    const value = payload[key];
    if (value !== undefined) {
      extraBody[key] = value;
    }
  }
  return {
    ...payload,
    ...(Object.keys(extraBody).length ? { extra_body: extraBody } : {}),
  };
}

type DownstreamImageResponseFormat = 'url' | 'b64_json';

function resolveDownstreamImageResponseFormat(payload: z.infer<typeof openAIImagesSchema>): DownstreamImageResponseFormat {
  return payload.response_format === 'b64_json' ? 'b64_json' : 'url';
}

function normalizePublicOpenAIImagesPayload(payload: z.infer<typeof openAIImagesSchema>) {
  const normalized = normalizeOpenAIImagesPayload(payload);
  if (normalized.response_format) {
    return normalized;
  }
  return {
    ...normalized,
    response_format: 'url' as const,
  };
}

const requestedEditProtocolMetadataKey = 'yali_requested_edit_protocol';

function requestedEditProtocolHintFromPayload(payload: z.infer<typeof openAIImagesSchema>): OpenAIImagesEditProtocol | undefined {
  const raw = payload.metadata?.[requestedEditProtocolMetadataKey];
  return raw === 'multipart_file_upload' || raw === 'json_image_url' ? raw : undefined;
}

function payloadHasReferenceImages(payload: z.infer<typeof openAIImagesSchema>) {
  return Boolean(payload.image && (Array.isArray(payload.image) ? payload.image.length : String(payload.image).trim()));
}

function payloadHasAsyncTaskImageAssets(payload: z.infer<typeof openAIImagesSchema>) {
  const values = payload.image ? (Array.isArray(payload.image) ? payload.image : [payload.image]) : [];
  return values.some((value) => String(value || '').trim().startsWith(asyncTaskImageAssetPrefix));
}

function inferRequestedEditProtocol(input: {
  request?: any;
  payload: z.infer<typeof openAIImagesSchema>;
  operation: 'generations' | 'edits';
}): OpenAIImagesEditProtocol | undefined {
  if (input.operation !== 'edits') {
    return undefined;
  }
  const hinted = requestedEditProtocolHintFromPayload(input.payload);
  if (hinted) {
    return hinted;
  }
  if (!payloadHasReferenceImages(input.payload)) {
    return undefined;
  }
  const contentType = String(input.request?.headers?.['content-type'] || '').toLowerCase();
  return contentType.includes('multipart/form-data') ? 'multipart_file_upload' : 'json_image_url';
}

function withRequestedEditProtocolHint(
  payload: z.infer<typeof openAIImagesSchema>,
  protocol?: OpenAIImagesEditProtocol,
) {
  if (!protocol || requestedEditProtocolHintFromPayload(payload) === protocol) {
    return payload;
  }
  return {
    ...payload,
    metadata: {
      ...(payload.metadata || {}),
      [requestedEditProtocolMetadataKey]: protocol,
    },
  };
}

function providerSupportsRequestedEditProtocol(
  provider: { source?: string; metadata?: Record<string, unknown> } & Pick<ProviderConfig, 'providerId'>,
  protocol?: OpenAIImagesEditProtocol,
) {
  if (!protocol || provider.source !== 'admin_managed') {
    return true;
  }
  return supportedImagesEditProtocols(provider as ProviderConfig).includes(protocol);
}

type ImageQualityCap = 'auto' | 'low' | 'medium' | 'high';

function normalizeImageQualityCap(value?: unknown): ImageQualityCap {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized === 'auto' || normalized === 'low' || normalized === 'medium' || normalized === 'high'
    ? normalized
    : 'high';
}

function imageProtocolLabel(value?: string | null) {
  const normalized = String(value || '').trim();
  if (normalized === 'openai_responses') {
    return 'Responses Endpoint';
  }
  if (normalized === 'openai_chat') {
    return 'Chat Completions';
  }
  return 'Images Endpoint';
}

function clampImageQualityToCap(value: unknown, cap: ImageQualityCap) {
  if (cap === 'high') {
    return typeof value === 'string' && value.trim() ? value : undefined;
  }
  const normalized = String(value || '').trim().toLowerCase();
  const rank: Record<ImageQualityCap, number> = {
    auto: 0,
    low: 1,
    medium: 2,
    high: 3,
  };
  // An omitted quality must remain omitted so the selected upstream can use its
  // configured default. `auto` is the lowest explicit tier and is never upgraded.
  if (normalized === 'auto' || !normalized) {
    return normalized || undefined;
  }
  if (normalized !== 'auto' && normalized !== 'low' && normalized !== 'medium' && normalized !== 'high') {
    return typeof value === 'string' && value.trim() ? value : undefined;
  }
  return rank[normalized] > rank[cap] ? cap : normalized;
}

function applyImageQualityCapToPayload(
  payload: z.infer<typeof openAIImagesSchema>,
  accessContext: RequestAccessContext,
) {
  const cap = accessContext.maxImageQuality;
  if (!cap || cap === 'high') {
    return payload;
  }
  const nextQuality = clampImageQualityToCap(payload.quality, cap);
  const nextImageToolQuality = clampImageQualityToCap(
    payload.image_tool_quality ?? payload.extra_body?.image_tool_quality ?? payload.quality,
    cap,
  );
  return {
    ...payload,
    quality: nextQuality,
    image_tool_quality: nextImageToolQuality,
    extra_body: {
      ...(payload.extra_body || {}),
      image_tool_quality: nextImageToolQuality,
    },
  };
}

function countImageInputs(payload: z.infer<typeof openAIImagesSchema>) {
  if (!payload.image) {
    return 0;
  }
  return Array.isArray(payload.image) ? payload.image.length : 1;
}

function inlineImagePayloadBytes(value: unknown) {
  const raw = String(value || '').trim();
  const dataUrlMatch = raw.match(/^data:image\/[a-zA-Z0-9.+-]+;base64,([A-Za-z0-9+/=\s]+)$/i);
  if (dataUrlMatch) {
    return estimateBase64DecodedBytes(dataUrlMatch[1]);
  }
  return isLikelyRawBase64(raw) ? estimateBase64DecodedBytes(raw) : 0;
}

function validateOpenAIImagesPayloadLimits(payload: z.infer<typeof openAIImagesSchema>) {
  const limits = getImageInputLimits();
  const imageCount = countImageInputs(payload);
  if (imageCount > limits.maxCount) {
    const error = new Error(`A single image request can include at most ${limits.maxCount} input images.`);
    (error as Error & { statusCode?: number; code?: string; details?: Record<string, unknown> }).statusCode = 400;
    (error as Error & { statusCode?: number; code?: string; details?: Record<string, unknown> }).code = 'too_many_input_images';
    (error as Error & { statusCode?: number; code?: string; details?: Record<string, unknown> }).details = {
      max_input_images: limits.maxCount,
      received_input_images: imageCount,
    };
    throw error;
  }
  const images = payload.image ? (Array.isArray(payload.image) ? payload.image : [payload.image]) : [];
  const totalBytes = images.reduce((sum, image) => {
    const bytes = inlineImagePayloadBytes(image);
    if (bytes > limits.maxImageBytes) {
      throw createImagePayloadTooLargeError(bytes, limits.maxImageBytes);
    }
    return sum + bytes;
  }, 0);
  if (totalBytes > limits.maxTotalBytes) {
    throw createInputImageTotalTooLargeError(totalBytes, limits.maxTotalBytes);
  }
}

function redactSensitiveHeaderValue(key: string, value: unknown) {
  const normalizedKey = String(key || '').toLowerCase();
  if (normalizedKey === 'authorization') {
    return 'Bearer ***';
  }
  if (normalizedKey === 'x-api-key' || normalizedKey.includes('api-key') || normalizedKey.includes('apikey')) {
    return '***';
  }
  return value;
}

function sanitizeRequestPlanForTaskState(plan: unknown) {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) {
    return plan;
  }
  const record = plan as Record<string, unknown>;
  const headers = record.headers && typeof record.headers === 'object' && !Array.isArray(record.headers)
    ? Object.fromEntries(Object.entries(record.headers as Record<string, unknown>).map(([key, value]) => [
        key,
        redactSensitiveHeaderValue(key, value),
      ]))
    : record.headers;
  return {
    ...record,
    headers,
    body: compactSuccessfulImagePayloadForStorage(record.body),
  };
}

const canvasUserRegisterSchema = z.object({
  username: z.string().trim().min(3).max(32),
  email: z.string().trim().email(),
  password: z.string().min(6).max(128),
});

const canvasUserLoginSchema = z.object({
  account: z.string().trim().min(1),
  password: z.string().min(1).max(128),
});

const canvasUserChangePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(128),
  nextPassword: z.string().min(6).max(128),
});

const canvasUserUpstreamPreferenceSchema = z.object({
  mode: z.enum(['shared_platform', 'user_supplied']),
  imageApiKind: z.enum(['images_endpoint', 'responses_endpoint']).default('images_endpoint'),
  imagesBaseUrl: z.string().trim().optional().default(''),
  imagesGenerationsUrl: z.string().trim().optional().default(''),
  imagesEditsUrl: z.string().trim().optional().default(''),
  imagesApiKey: z.string().trim().optional().default(''),
  chatBaseUrl: z.string().trim().optional().default(''),
  chatApiKey: z.string().trim().optional().default(''),
  preferredAuthMode: z.enum(['bearer', 'x-api-key']).default('bearer'),
  chatFallbackMode: z.enum(['platform_fallback', 'strict_user']).default('platform_fallback'),
});

const canvasUserApiKeySettingsSchema = z.object({
  imageRoutingMode: z.enum(['smart_failover', 'smart_priority', 'fixed_provider']).default('smart_failover'),
  maxImageQuality: z.enum(['auto', 'low', 'medium', 'high']).default('high'),
});

const canvasUserDefaultApiKeySchema = z.object({
  apiKeyId: z.string().trim().min(1),
});

const canvasUserFinanceLedgerQuerySchema = z.object({
  window_hours: z.coerce.number().int().min(1).max(168).optional(),
  windowHours: z.coerce.number().int().min(1).max(168).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  page: z.coerce.number().int().min(1).max(100000).optional(),
  page_size: z.coerce.number().int().min(1).max(50).optional(),
  pageSize: z.coerce.number().int().min(1).max(50).optional(),
});

function defaultCanvasUserUpstreamPreference(): CanvasUserRecord['upstreamPreference'] {
  return {
    mode: 'shared_platform',
    imageApiKind: 'images_endpoint',
    imagesBaseUrl: '',
    imagesGenerationsUrl: '',
    imagesEditsUrl: '',
    imagesApiKey: '',
    chatBaseUrl: '',
    chatApiKey: '',
    preferredAuthMode: 'bearer',
    chatFallbackMode: 'platform_fallback',
    updatedAt: Date.now(),
  };
}

type RequestAccessContext = {
  tenantId: string;
  apiKeyId: string;
  authMode: 'tenant_key' | 'admin_managed' | 'user_supplied';
  imageRoutingMode?: ImageRoutingMode;
  fixedImageProviderId?: string;
  fixedImageProviderIds?: string[];
  fixedImageFlatPrice?: number;
  maxImageQuality?: ImageQualityCap;
  maxConcurrency?: number;
  tenantRequestLimitPerMinute?: number;
  requestLimitPerMinute?: number;
  downstreamImageApiType?: 'openai_images' | 'banana_images';
  bananaAllowedModels?: string[];
  bananaAllowedImageSizes?: Array<'1k' | '2k' | '4k'>;
};

type AsyncQueuedTaskInternalState = {
  payload: z.infer<typeof openAIImagesSchema>;
  accessContext: RequestAccessContext;
  requestHeaders: Record<string, string>;
  enqueuedAt: number;
  attemptCount: number;
  assetDirectory?: string;
  imageAssets?: AsyncTaskImageAsset[];
};

type RequestAccessResult =
  | { granted: true; context: RequestAccessContext }
  | { granted: false; statusCode: 401 | 403; error: string; message: string };

app.addHook('onSend', async (_request, reply, payload) => {
  reply.header('Access-Control-Allow-Origin', '*');
  reply.header('Access-Control-Allow-Credentials', 'true');
  reply.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-API-Key');
  reply.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  return payload;
});

app.options('*', async (_request, reply) => {
  reply.code(204).send();
});

// Reject overloaded image ingress before Fastify starts buffering a JSON or multipart body.
app.addHook('onRequest', async (request, reply) => {
  if ((request.raw.url || '').split('?')[0] !== '/v1/images/generations'
    && (request.raw.url || '').split('?')[0] !== '/v1/images/edits') return;
  if (!isDynamicOverloadProtectionActive()) return;
  reply.header('Retry-After', '5').code(429).send(dynamicOverloadError());
});

app.get('/health', async () => ({
  ok: true,
  service: '@yali/api',
  gatewayInstance: gatewayInstanceId,
}));

app.get('/ready', async (_request, reply) => {
  const overload = dynamicOverloadGuard.getSnapshot(adminControlPlaneStore.get().publicApi);
  const ready = gatewayAcceptingTraffic && !overload.overloaded;
  reply.header('Cache-Control', 'no-store');
  if (!ready) {
    reply.code(503);
  }
  return {
    ok: ready,
    service: '@yali/api',
    gatewayInstance: gatewayInstanceId,
    state: gatewayAcceptingTraffic ? (overload.overloaded ? 'overloaded' : 'ready') : 'draining',
    ...(overload.overloaded ? { reasons: overload.reasons } : {}),
  };
});

app.get('/v1/providers', async () => ({
  providers: providerRegistry.list(),
}));

app.post('/v1/canvas/auth/register', async (request, reply) => {
  const body = canvasUserRegisterSchema.parse(request.body);
  await refreshCanvasUserCache();
  const usernameTaken = canvasUserCache.some((item) => String(item.username).trim().toLowerCase() === body.username.toLowerCase());
  const emailTaken = canvasUserCache.some((item) => String(item.email).trim().toLowerCase() === body.email.toLowerCase());
  if (usernameTaken) {
    reply.code(409);
    return { error: 'username_taken', message: '该用户名已被使用。' };
  }
  if (emailTaken) {
    reply.code(409);
    return { error: 'email_taken', message: '该邮箱已被注册。' };
  }

  const user: CanvasUserRecord = {
    id: `cu_${crypto.randomBytes(8).toString('hex')}`,
    username: body.username.trim(),
    email: body.email.trim().toLowerCase(),
    passwordHash: hashPassword(body.password),
    tenantId: `tenant_user_${crypto.randomBytes(8).toString('hex')}`,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    status: 'active',
    upstreamPreference: defaultCanvasUserUpstreamPreference(),
  };
  await upsertCanvasUsers([user]);
  const { apiKey } = await ensureCanvasTenantAndApiKeyForUser(user);
  const session = await createCanvasUserSession(findCanvasUserById(user.id)!);
  setCanvasUserCookie(reply, session.token);
  return {
    success: true,
    user: await buildCanvasUserSessionPayload({
      user: findCanvasUserById(user.id)!,
      rawApiKey: apiKey?.rawKey || '',
    }),
  };
});

app.post('/v1/canvas/auth/login', async (request, reply) => {
  const body = canvasUserLoginSchema.parse(request.body);
  await refreshCanvasUserCache();
  const user = findCanvasUserByAccount(body.account);
  if (!user || !verifyPassword(body.password, user.passwordHash)) {
    reply.code(401);
    return { error: 'invalid_credentials', message: '账号或密码错误。' };
  }
  const { apiKey } = await ensureCanvasTenantAndApiKeyForUser(user);
  const session = await createCanvasUserSession(user);
  setCanvasUserCookie(reply, session.token);
  return {
    success: true,
    user: await buildCanvasUserSessionPayload({
      user: findCanvasUserById(user.id)!,
      rawApiKey: apiKey?.rawKey || '',
    }),
  };
});

app.post('/v1/canvas/auth/logout', async (request, reply) => {
  const token = parseCookieToken(request.headers.cookie, canvasUserCookieName);
  if (token) {
    await deleteCanvasUserSessionsByTokens([token]);
  }
  clearCanvasUserCookie(reply);
  return { success: true };
});

app.get('/v1/canvas/auth/me', async (request, reply) => {
  try {
    await refreshCanvasUserCache();
    await refreshCanvasUserSessionCache();
    const { user } = await requireCanvasUser(request, reply);
    await ensureCanvasTenantAndApiKeyForUser(user);
    return {
      authenticated: true,
      user: await buildCanvasUserSessionPayload({ user: findCanvasUserById(user.id)! }),
    };
  } catch {
    return {
      authenticated: false,
      user: null,
    };
  }
});

app.post('/v1/canvas/auth/change-password', async (request, reply) => {
  const body = canvasUserChangePasswordSchema.parse(request.body);
  const { user } = await requireCanvasUser(request, reply);
  if (!verifyPassword(body.currentPassword, user.passwordHash)) {
    reply.code(400);
    return { error: 'invalid_current_password', message: '当前密码不正确。' };
  }
  await upsertCanvasUsers([{
    ...user,
    passwordHash: hashPassword(body.nextPassword),
    updatedAt: Date.now(),
  }]);
  return { success: true };
});

app.put('/v1/canvas/user/upstream-preference', async (request, reply) => {
  canvasUserUpstreamPreferenceSchema.parse(request.body);
  reply.code(410);
  return {
    error: 'canvas_upstream_preference_disabled',
    message: '画布账户模式不再保存上游接口设置。请切换到本地模式，并在当前浏览器中配置接口与密钥。',
  };
});

app.put('/v1/canvas/user/api-key-settings', async (request, reply) => {
  const body = canvasUserApiKeySettingsSchema.parse(request.body);
  const { user } = await requireCanvasUser(request, reply);
  const { tenant, apiKey } = await ensureCanvasTenantAndApiKeyForUser(user);
  await adminConsoleCatalogStore.saveApiKeyAsync({
    ...apiKey,
    tenantId: tenant.id,
    imageRoutingMode: body.imageRoutingMode || 'smart_failover',
    maxImageQuality: normalizeImageQualityCap(body.maxImageQuality),
  });
  return {
    success: true,
    user: await buildCanvasUserSessionPayload({ user: findCanvasUserById(user.id)! }),
  };
});

app.get('/v1/canvas/user/api-keys', async (request, reply) => {
  const { user } = await requireCanvasUser(request, reply);
  await ensureCanvasTenantAndApiKeyForUser(user);
  const currentUser = findCanvasUserById(user.id) || user;
  const catalog = await adminConsoleCatalogStore.refreshAsync();
  const apiKeys = listCanvasUserApiKeys(catalog.apiKeys, currentUser);
  return {
    apiKeys: apiKeys.map((apiKey) => buildCanvasUserApiKeyPayload(apiKey, currentUser.apiKeyId)),
    defaultApiKeyId: currentUser.apiKeyId || '',
  };
});

app.put('/v1/canvas/user/default-api-key', async (request, reply) => {
  const body = canvasUserDefaultApiKeySchema.parse(request.body);
  const { user } = await requireCanvasUser(request, reply);
  await ensureCanvasTenantAndApiKeyForUser(user);
  const currentUser = findCanvasUserById(user.id) || user;
  const catalog = await adminConsoleCatalogStore.refreshAsync();
  const apiKey = catalog.apiKeys.find((item) => item.id === body.apiKeyId && item.tenantId === currentUser.tenantId) || null;
  if (!apiKey) {
    reply.code(404);
    return { error: 'api_key_not_found', message: '未找到属于当前账户的 API 密钥。' };
  }
  if (apiKey.status !== 'active') {
    reply.code(400);
    return { error: 'api_key_disabled', message: '已停用的 API 密钥不能设为画布默认密钥。' };
  }
  if (!String(apiKey.rawKey || '').trim()) {
    reply.code(400);
    return { error: 'api_key_secret_unavailable', message: '该 API 密钥未保存完整密钥，无法作为画布默认密钥。' };
  }
  await upsertCanvasUsers([{
    ...currentUser,
    apiKeyId: apiKey.id,
    updatedAt: Date.now(),
  }]);
  return {
    success: true,
    defaultApiKeyId: apiKey.id,
  };
});

app.get('/v1/canvas/user/tenant-finance-ledger', async (request, reply) => {
  const query = canvasUserFinanceLedgerQuerySchema.parse(request.query);
  const { user } = await requireCanvasUser(request, reply);
  const windowHours = Math.max(1, Number(query.windowHours ?? query.window_hours ?? 48));
  const pageSize = Math.max(1, Number(query.pageSize ?? query.page_size ?? query.limit ?? 10));
  const page = Math.max(1, Number(query.page || 1));
  const offset = (page - 1) * pageSize;
  const createdAfter = Date.now() - windowHours * 60 * 60 * 1000;
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const yesterdayStart = todayStart - (24 * 60 * 60 * 1000);
  const [rows, balance, total, todaySpentCents, yesterdaySpentCents] = await Promise.all([
    operationalRepository.listTenantFinanceLedgerByTenant({
      tenantId: user.tenantId,
      currency: 'cny',
      limit: pageSize,
      offset,
      createdAfter,
    }),
    operationalRepository.getTenantFinanceBalance(user.tenantId, 'cny'),
    operationalRepository.countTenantFinanceLedgerByTenant({
      tenantId: user.tenantId,
      currency: 'cny',
      createdAfter,
    }),
    operationalRepository.sumTenantFinanceLedgerByTenant({
      tenantId: user.tenantId,
      currency: 'cny',
      direction: 'debit',
      createdAfter: todayStart,
    }),
    operationalRepository.sumTenantFinanceLedgerByTenant({
      tenantId: user.tenantId,
      currency: 'cny',
      direction: 'debit',
      createdAfter: yesterdayStart,
      createdBefore: todayStart,
    }),
  ]);
  return {
    generatedAt: Date.now(),
    tenantId: user.tenantId,
    windowHours,
    page,
    pageSize,
    total: Number(total || 0),
    totalPages: Math.max(1, Math.ceil(Number(total || 0) / pageSize)),
    currentBalanceCents: Number(balance?.balanceCents || 0),
    currentBalanceYuan: minorUnitsToYuan(Number(balance?.balanceCents || 0)),
    todaySpentCents: Number(todaySpentCents || 0),
    todaySpentYuan: minorUnitsToYuan(Number(todaySpentCents || 0)),
    yesterdaySpentCents: Number(yesterdaySpentCents || 0),
    yesterdaySpentYuan: minorUnitsToYuan(Number(yesterdaySpentCents || 0)),
    rows: rows.map((row) => ({
      id: row.id,
      createdAt: row.createdAt,
      direction: row.direction,
      amountCents: row.amountCents,
      amountYuan: minorUnitsToYuan(Number(row.amountCents || 0)),
      balanceAfterCents: row.balanceAfterCents,
      balanceAfterYuan: minorUnitsToYuan(Number(row.balanceAfterCents || 0)),
      note: String(row.note || '').trim(),
      currency: row.currency,
      requestId: typeof row.detail?.requestId === 'string' ? row.detail.requestId : '',
      taskId: typeof row.detail?.taskId === 'string' ? row.detail.taskId : '',
      protocol: typeof row.detail?.protocol === 'string' ? row.detail.protocol : '',
      protocolLabel: typeof row.detail?.protocolLabel === 'string' ? row.detail.protocolLabel : '',
      operation: typeof row.detail?.operation === 'string' ? row.detail.operation : '',
      requestedSize: typeof row.detail?.requestedSize === 'string' ? row.detail.requestedSize : '',
      requestedTier: typeof row.detail?.requestedTier === 'string' ? row.detail.requestedTier : '',
      requestedQuality: typeof row.detail?.requestedQuality === 'string' ? row.detail.requestedQuality : '',
      actualSize: typeof row.detail?.actualSize === 'string' ? row.detail.actualSize : '',
      actualTier: typeof row.detail?.actualTier === 'string' ? row.detail.actualTier : '',
      billingMode: typeof row.detail?.billingMode === 'string' ? row.detail.billingMode : '',
      billingModeLabel: typeof row.detail?.billingModeLabel === 'string' ? row.detail.billingModeLabel : '',
      billedQuality: typeof row.detail?.billedQuality === 'string' ? row.detail.billedQuality : '',
      billedImages: Math.max(0, Number(row.detail?.billedImages || 0)),
      sourceLabel: row.detail?.source === 'image_request_charge'
        ? '图像消费'
        : row.detail?.source === 'chat_completions_request_charge'
          ? 'Chat Completions 消费'
          : row.direction === 'credit'
            ? '充值'
            : '人工扣费',
    })),
  };
});

app.post('/v1/canvas/user/api-key/regenerate', async (request, reply) => {
  const { user } = await requireCanvasUser(request, reply);
  const { tenant } = await ensureCanvasTenantAndApiKeyForUser(user);
  const secret = createMaskedApiKey();
  const nextApiKeyId = user.apiKeyId || `key_${crypto.randomBytes(8).toString('hex')}`;
  await adminConsoleCatalogStore.saveApiKeyAsync({
    id: nextApiKeyId,
    name: `${user.username} 默认密钥`,
    tenantId: tenant.id,
    status: 'active',
    allowedChannelIds: [imageChannelId, textChannelId],
    requestLimitPerMinute: 120,
    maxConcurrency: 10,
    imageRoutingMode: 'smart_failover',
    maxImageQuality: 'high',
    maskedKey: secret.masked,
    rawKey: secret.raw,
    keyHash: secret.hash,
    notes: 'Canvas OSS user self-managed API key',
  });
  await upsertCanvasUsers([{
    ...user,
    apiKeyId: nextApiKeyId,
    updatedAt: Date.now(),
  }]);
  return {
    success: true,
    apiKey: {
      raw: secret.raw,
      masked: secret.masked,
      id: nextApiKeyId,
    },
  };
});

function getAdminDataDir() {
  return String(process.env.ADMIN_DATA_DIR || path.join(process.cwd(), 'data'));
}

const canvasUserStore = createJsonStore<CanvasUserRecord[]>({
  envDirKey: 'ADMIN_DATA_DIR',
  defaultDirName: 'data',
  fileName: 'canvas-users.json',
  createDefault: () => [],
  mergeOnRead: (input) => Array.isArray(input) ? input as CanvasUserRecord[] : [],
});

const canvasUserSessionStore = createJsonStore<CanvasUserSessionRecord[]>({
  envDirKey: 'ADMIN_DATA_DIR',
  defaultDirName: 'data',
  fileName: 'canvas-user-sessions.json',
  createDefault: () => [],
  mergeOnRead: (input) => Array.isArray(input) ? input as CanvasUserSessionRecord[] : [],
});

const postgresCanvasUserRepository = hasDatabaseUrl()
  ? createPostgresCanvasUserRepository({
      connectionString: process.env.DATABASE_URL,
      schema: process.env.PG_SCHEMA || 'public',
    })
  : null;

const postgresCanvasUserSessionRepository = hasDatabaseUrl()
  ? createPostgresCanvasUserSessionRepository({
      connectionString: process.env.DATABASE_URL,
      schema: process.env.PG_SCHEMA || 'public',
    })
  : null;

let canvasUserCache = postgresCanvasUserRepository ? [] : canvasUserStore.read();
let canvasUserSessionCache = postgresCanvasUserSessionRepository ? [] : canvasUserSessionStore.read();
let canvasUserListenersStarted = false;

async function initializeCanvasUserStores() {
  canvasUserCache = postgresCanvasUserRepository
    ? await postgresCanvasUserRepository.list()
    : canvasUserStore.read();
  canvasUserSessionCache = postgresCanvasUserSessionRepository
    ? await postgresCanvasUserSessionRepository.list()
    : canvasUserSessionStore.read();
  if (!canvasUserListenersStarted && (postgresCanvasUserRepository || postgresCanvasUserSessionRepository)) {
    canvasUserListenersStarted = true;
    if (postgresCanvasUserRepository) {
      await startPostgresConfigListener('canvas_users', () => {
        void refreshCanvasUserCache();
      });
    }
    if (postgresCanvasUserSessionRepository) {
      await startPostgresConfigListener('canvas_user_sessions', () => {
        void refreshCanvasUserSessionCache();
      });
    }
  }
}

async function refreshCanvasUserCache() {
  canvasUserCache = postgresCanvasUserRepository
    ? await postgresCanvasUserRepository.list()
    : canvasUserStore.read();
  return canvasUserCache;
}

async function refreshCanvasUserSessionCache() {
  canvasUserSessionCache = postgresCanvasUserSessionRepository
    ? await postgresCanvasUserSessionRepository.list()
    : canvasUserSessionStore.read();
  return canvasUserSessionCache;
}

async function persistCanvasUsers(next: CanvasUserRecord[]) {
  canvasUserCache = next;
  if (postgresCanvasUserRepository) {
    await postgresCanvasUserRepository.saveAll(next);
    return next;
  }
  canvasUserStore.write(next);
  return next;
}

async function persistCanvasUserSessions(next: CanvasUserSessionRecord[]) {
  canvasUserSessionCache = next;
  if (postgresCanvasUserSessionRepository) {
    await postgresCanvasUserSessionRepository.saveAll(next);
    return next;
  }
  canvasUserSessionStore.write(next);
  return next;
}

async function upsertCanvasUsers(records: CanvasUserRecord[]) {
  if (!records.length) {
    return canvasUserCache;
  }
  const byId = new Map(canvasUserCache.map((item) => [item.id, item]));
  for (const record of records) {
    byId.set(record.id, record);
  }
  const next = Array.from(byId.values()).sort((left, right) => Number(right.updatedAt || 0) - Number(left.updatedAt || 0));
  canvasUserCache = next;
  if (postgresCanvasUserRepository) {
    await postgresCanvasUserRepository.upsertMany(records);
    return next;
  }
  canvasUserStore.write(next);
  return next;
}

async function deleteCanvasUsersByIds(ids: string[]) {
  if (!ids.length) {
    return canvasUserCache;
  }
  const removed = new Set(ids);
  const next = canvasUserCache.filter((item) => !removed.has(item.id));
  canvasUserCache = next;
  if (postgresCanvasUserRepository) {
    await postgresCanvasUserRepository.deleteByIds(ids);
    return next;
  }
  canvasUserStore.write(next);
  return next;
}

async function upsertCanvasUserSessions(records: CanvasUserSessionRecord[]) {
  if (!records.length) {
    return canvasUserSessionCache;
  }
  const byToken = new Map(canvasUserSessionCache.map((item) => [item.token, item]));
  for (const record of records) {
    byToken.set(record.token, record);
  }
  const next = Array.from(byToken.values()).sort((left, right) => Number(right.createdAt || 0) - Number(left.createdAt || 0));
  canvasUserSessionCache = next;
  if (postgresCanvasUserSessionRepository) {
    await postgresCanvasUserSessionRepository.upsertMany(records);
    return next;
  }
  canvasUserSessionStore.write(next);
  return next;
}

async function deleteCanvasUserSessionsByTokens(tokens: string[]) {
  if (!tokens.length) {
    return canvasUserSessionCache;
  }
  const removed = new Set(tokens);
  const next = canvasUserSessionCache.filter((item) => !removed.has(item.token));
  canvasUserSessionCache = next;
  if (postgresCanvasUserSessionRepository) {
    await postgresCanvasUserSessionRepository.deleteByIds(tokens);
    return next;
  }
  canvasUserSessionStore.write(next);
  return next;
}

function hashPassword(password: string) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = scryptSync(password, salt, 64).toString('hex');
  return `scrypt:${salt}:${derived}`;
}

function verifyPassword(password: string, storedHash: string) {
  const parts = String(storedHash || '').split(':');
  if (parts.length !== 3 || parts[0] !== 'scrypt') {
    return false;
  }
  const [, salt, expectedHex] = parts;
  const actual = Buffer.from(scryptSync(password, salt, 64).toString('hex'), 'utf8');
  const expected = Buffer.from(expectedHex, 'utf8');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function createCanvasUserToken() {
  return `cu_${crypto.randomBytes(24).toString('hex')}`;
}

function parseCookieToken(cookieHeader: unknown, cookieName: string) {
  const raw = String(cookieHeader || '');
  const items = raw.split(';').map((item) => item.trim()).filter(Boolean);
  for (const item of items) {
    const [key, ...rest] = item.split('=');
    if (String(key || '').trim() === cookieName) {
      return decodeURIComponent(rest.join('=') || '');
    }
  }
  return '';
}

async function pruneCanvasUserSessions() {
  await refreshCanvasUserSessionCache();
  const now = Date.now();
  const next = canvasUserSessionCache.filter((item) => item.expiresAt > now);
  if (next.length !== canvasUserSessionCache.length) {
    const expiredTokens = canvasUserSessionCache
      .filter((item) => item.expiresAt <= now)
      .map((item) => item.token);
    await deleteCanvasUserSessionsByTokens(expiredTokens);
  }
  return refreshCanvasUserSessionCache();
}

function maskSecret(secret: string) {
  const normalized = String(secret || '').trim();
  if (!normalized) {
    return '';
  }
  if (normalized.length <= 10) {
    return `${normalized.slice(0, 3)}***`;
  }
  return `${normalized.slice(0, 6)}...${normalized.slice(-4)}`;
}

function clearCanvasUserCookie(reply: any) {
  reply.header('Set-Cookie', `${canvasUserCookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

function setCanvasUserCookie(reply: any, token: string) {
  reply.header(
    'Set-Cookie',
    `${canvasUserCookieName}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(canvasUserSessionTtlMs / 1000)}`,
  );
}

function getGeneratedImageDir() {
  return path.join(getAdminDataDir(), generatedImageSubdir);
}

function getCanvasReferenceAssetDir() {
  return path.join(getAdminDataDir(), canvasReferenceAssetSubdir);
}

function extractGeneratedImageFileNameFromUrl(value: unknown, request?: any) {
  const raw = String(value || '').trim();
  if (!raw || !raw.includes('/v1/generated-images/')) {
    return '';
  }
  try {
    const parsed = new URL(raw, request ? inferPublicBaseUrl(request) : 'http://127.0.0.1');
    const marker = '/v1/generated-images/';
    const pathname = String(parsed.pathname || '');
    const index = pathname.indexOf(marker);
    if (index < 0) {
      return '';
    }
    const fileName = decodeURIComponent(pathname.slice(index + marker.length).split('/')[0] || '');
    return sanitizeFileSegment(fileName);
  } catch {
    return '';
  }
}

function extractCanvasReferenceAssetFileNameFromUrl(value: unknown, request?: any) {
  const raw = String(value || '').trim();
  if (!raw || !raw.includes('/v1/canvas/reference-assets/')) {
    return '';
  }
  try {
    const parsed = new URL(raw, request ? inferPublicBaseUrl(request) : 'http://127.0.0.1');
    const marker = '/v1/canvas/reference-assets/';
    const pathname = String(parsed.pathname || '');
    const index = pathname.indexOf(marker);
    if (index < 0) {
      return '';
    }
    const fileName = decodeURIComponent(pathname.slice(index + marker.length).split('/')[0] || '');
    return sanitizeFileSegment(fileName);
  } catch {
    return '';
  }
}

function collectGeneratedImageFileNamesFromValue(value: unknown, fileNames: Set<string>, request?: any) {
  if (typeof value === 'string') {
    const fileName = extractGeneratedImageFileNameFromUrl(value, request);
    if (fileName) {
      fileNames.add(fileName);
    }
    return;
  }
  if (!value || typeof value !== 'object') {
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => collectGeneratedImageFileNamesFromValue(item, fileNames, request));
    return;
  }
  Object.values(value as Record<string, unknown>).forEach((item) => collectGeneratedImageFileNamesFromValue(item, fileNames, request));
}

function collectCanvasReferenceAssetFileNamesFromValue(value: unknown, fileNames: Set<string>, request?: any) {
  if (typeof value === 'string') {
    const fileName = extractCanvasReferenceAssetFileNameFromUrl(value, request);
    if (fileName) {
      fileNames.add(fileName);
    }
    return;
  }
  if (!value || typeof value !== 'object') {
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => collectCanvasReferenceAssetFileNamesFromValue(item, fileNames, request));
    return;
  }
  Object.values(value as Record<string, unknown>).forEach((item) => collectCanvasReferenceAssetFileNamesFromValue(item, fileNames, request));
}

function collectGeneratedImageFileNamesFromCanvasRun(run: CanvasWorkflowRunState, request?: any) {
  const fileNames = new Set<string>();
  collectGeneratedImageFileNamesFromValue(run.execution_payload, fileNames, request);
  collectGeneratedImageFileNamesFromValue(run.node_states, fileNames, request);
  collectGeneratedImageFileNamesFromValue(run.jobs, fileNames, request);
  return [...fileNames];
}

function collectCanvasReferenceAssetFileNamesFromCanvasRun(run: CanvasWorkflowRunState, request?: any) {
  const fileNames = new Set<string>();
  collectCanvasReferenceAssetFileNamesFromValue(run.execution_payload, fileNames, request);
  collectCanvasReferenceAssetFileNamesFromValue(run.node_states, fileNames, request);
  collectCanvasReferenceAssetFileNamesFromValue(run.jobs, fileNames, request);
  return [...fileNames];
}

function collectCanvasTaskIdsFromValue(value: unknown, taskIds: Set<string>) {
  if (!value || typeof value !== 'object') {
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => collectCanvasTaskIdsFromValue(item, taskIds));
    return;
  }
  const record = value as Record<string, unknown>;
  const taskId = String(record.task_id || record.taskId || '').trim();
  if (taskId) {
    taskIds.add(taskId);
  }
  Object.values(record).forEach((item) => collectCanvasTaskIdsFromValue(item, taskIds));
}

function collectCanvasTaskIdsFromRun(run: CanvasWorkflowRunState) {
  const taskIds = new Set<string>();
  collectCanvasTaskIdsFromValue(run.execution_payload, taskIds);
  collectCanvasTaskIdsFromValue(run.node_states, taskIds);
  collectCanvasTaskIdsFromValue(run.jobs, taskIds);
  return [...taskIds];
}

async function collectCanvasAssetFileNamesFromTaskRecords(taskIds: string[], request?: any) {
  const generatedImageFileNames = new Set<string>();
  const referenceAssetFileNames = new Set<string>();
  const uniqueTaskIds = Array.from(new Set(taskIds.map((item) => String(item || '').trim()).filter(Boolean)));
  await Promise.all(uniqueTaskIds.map(async (taskId) => {
    try {
      const task = await operationalRepository.getTask(taskId);
      if (!task) {
        return;
      }
      collectGeneratedImageFileNamesFromValue(task.requestPayload, generatedImageFileNames, request);
      collectGeneratedImageFileNamesFromValue(task.responsePayload, generatedImageFileNames, request);
      collectGeneratedImageFileNamesFromValue(task.errorPayload, generatedImageFileNames, request);
      collectCanvasReferenceAssetFileNamesFromValue(task.requestPayload, referenceAssetFileNames, request);
      collectCanvasReferenceAssetFileNamesFromValue(task.responsePayload, referenceAssetFileNames, request);
      collectCanvasReferenceAssetFileNamesFromValue(task.errorPayload, referenceAssetFileNames, request);
    } catch (error) {
      requestLogWarn('canvas_clear_task_lookup_failed', error);
    }
  }));
  return {
    generatedImageFileNames: [...generatedImageFileNames],
    referenceAssetFileNames: [...referenceAssetFileNames],
  };
}

async function deleteGeneratedImageFilesByName(fileNames: string[]) {
  if (!fileNames.length) {
    return 0;
  }
  let deletedCount = 0;
  await Promise.all(fileNames.map(async (fileName) => {
    const safeName = sanitizeFileSegment(fileName);
    if (!safeName) {
      return;
    }
    try {
      await fs.unlink(path.join(getGeneratedImageDir(), safeName));
      deletedCount += 1;
    } catch {
      return;
    }
  }));
  return deletedCount;
}

async function deleteCanvasReferenceAssetFilesByName(fileNames: string[]) {
  if (!fileNames.length) {
    return 0;
  }
  let deletedCount = 0;
  await Promise.all(fileNames.map(async (fileName) => {
    const safeName = sanitizeFileSegment(fileName);
    if (!safeName) {
      return;
    }
    try {
      await fs.unlink(path.join(getCanvasReferenceAssetDir(), safeName));
      deletedCount += 1;
    } catch {
      return;
    }
  }));
  return deletedCount;
}

async function pruneFilesInDir(dir: string, maxAgeMs: number) {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const cutoff = Date.now() - Math.max(0, Number(maxAgeMs || 0));
    await Promise.all(entries.map(async (entry) => {
      if (!entry.isFile()) {
        return;
      }
      const filePath = path.join(dir, entry.name);
      try {
        const stats = await fs.stat(filePath);
        if (stats.mtimeMs < cutoff) {
          await fs.unlink(filePath);
        }
      } catch {
        return;
      }
    }));
  } catch {
    return;
  }
}

async function pruneGeneratedImageFiles(maxAgeMs: number) {
  await pruneFilesInDir(getGeneratedImageDir(), maxAgeMs);
}

async function pruneCanvasReferenceAssetFiles(maxAgeMs: number) {
  await pruneFilesInDir(getCanvasReferenceAssetDir(), maxAgeMs);
}

function effectiveGeneratedImageRetentionMs() {
  const configuredMinutes = Number(adminControlPlaneStore.get().maintenance?.generatedImageRetentionMinutes || 0);
  if (!Number.isFinite(configuredMinutes) || configuredMinutes <= 0) {
    return generatedImageRetentionMs;
  }
  return Math.max(60_000, Math.floor(configuredMinutes * 60_000));
}

function effectiveCanvasReferenceAssetRetentionMs() {
  const configuredMinutes = Number(adminControlPlaneStore.get().maintenance?.canvasReferenceAssetRetentionMinutes || 0);
  if (!Number.isFinite(configuredMinutes) || configuredMinutes <= 0) {
    return canvasReferenceAssetRetentionMs;
  }
  return Math.max(60_000, Math.floor(configuredMinutes * 60_000));
}

function effectiveRequestTraceRetentionMs() {
  const configuredMinutes = Number(adminControlPlaneStore.get().maintenance?.requestTraceRetentionMinutes || 0);
  if (!Number.isFinite(configuredMinutes) || configuredMinutes <= 0) {
    return operationalTraceRetentionMs;
  }
  return Math.max(60_000, Math.floor(configuredMinutes * 60_000));
}

function effectiveTaskRecordRetentionMs() {
  const configuredDays = Number(adminControlPlaneStore.get().maintenance?.taskRecordRetentionDays || 0);
  if (!Number.isFinite(configuredDays) || configuredDays <= 0) {
    return operationalTaskRetentionMs;
  }
  return Math.max(24 * 60 * 60 * 1000, Math.floor(configuredDays * 24 * 60 * 60 * 1000));
}

function effectiveAuditLogRetentionMs() {
  const configuredDays = Number(adminControlPlaneStore.get().maintenance?.auditLogRetentionDays || 0);
  if (!Number.isFinite(configuredDays) || configuredDays <= 0) {
    return operationalAuditRetentionMs;
  }
  return Math.max(24 * 60 * 60 * 1000, Math.floor(configuredDays * 24 * 60 * 60 * 1000));
}

function effectiveBillingLedgerRetentionMs() {
  const configuredDays = Number(adminControlPlaneStore.get().maintenance?.billingLedgerRetentionDays || 0);
  if (!Number.isFinite(configuredDays) || configuredDays <= 0) {
    return operationalBillingRetentionMs;
  }
  return Math.max(24 * 60 * 60 * 1000, Math.floor(configuredDays * 24 * 60 * 60 * 1000));
}

async function pruneShortTermOperationalData() {
  const pruneOperational = typeof operationalRepository.pruneOperationalRetention === 'function'
    ? operationalRepository.pruneOperationalRetention({
        auditMs: effectiveAuditLogRetentionMs(),
        traceMs: effectiveRequestTraceRetentionMs(),
        billingMs: effectiveBillingLedgerRetentionMs(),
        taskMs: effectiveTaskRecordRetentionMs(),
      })
    : operationalRepository.pruneOperationalWindow(effectiveRequestTraceRetentionMs());
  await Promise.allSettled([
    pruneOperational,
    pruneGeneratedImageFiles(effectiveGeneratedImageRetentionMs()),
    pruneCanvasReferenceAssetFiles(effectiveCanvasReferenceAssetRetentionMs()),
  ]);
}

function scheduleOperationalMaintenance() {
  const runMaintenance = () => {
    void pruneShortTermOperationalData();
  };
  const timer = setInterval(runMaintenance, operationalMaintenanceIntervalMs);
  if (typeof timer.unref === 'function') {
    timer.unref();
  }
  runMaintenance();
}

function sanitizeFileSegment(value: string) {
  return String(value || '').replace(/[^a-zA-Z0-9._-]/g, '');
}

function isHttpUrl(value: string) {
  return /^https?:\/\//i.test(String(value || '').trim());
}

function isLikelyRawBase64(value: string) {
  const normalized = String(value || '').replace(/\s+/g, '');
  return normalized.length >= 64 && /^[A-Za-z0-9+/=]+$/.test(normalized);
}

function detectImageExtension(input: {
  result?: string;
  outputFormat?: string;
}) {
  const result = String(input.result || '');
  const outputFormat = String(input.outputFormat || '').trim().toLowerCase();
  const dataUrlMatch = result.match(/^data:image\/([a-zA-Z0-9.+-]+);base64,/);
  if (dataUrlMatch?.[1]) {
    const ext = dataUrlMatch[1].toLowerCase();
    if (ext === 'jpeg' || ext === 'jpg') {
      return 'jpg';
    }
    if (ext === 'webp') {
      return 'webp';
    }
    return 'png';
  }
  if (outputFormat === 'jpeg' || outputFormat === 'jpg') {
    return 'jpg';
  }
  if (outputFormat === 'webp') {
    return 'webp';
  }
  return 'png';
}

function detectImageExtensionFromBuffer(buffer: Buffer) {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]))) {
    return 'png';
  }
  if (buffer.length >= 3 && buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) {
    return 'jpg';
  }
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') {
    return 'webp';
  }
  if (buffer.length >= 6) {
    const signature = buffer.subarray(0, 6).toString('ascii');
    if (signature === 'GIF87a' || signature === 'GIF89a') {
      return 'gif';
    }
  }
  return 'png';
}

function contentTypeForExtension(ext: string) {
  if (ext === 'jpg' || ext === 'jpeg') {
    return 'image/jpeg';
  }
  if (ext === 'webp') {
    return 'image/webp';
  }
  if (ext === 'gif') {
    return 'image/gif';
  }
  return 'image/png';
}

function outputFormatForImageExtension(extension?: string | null) {
  const normalized = String(extension || '').trim().toLowerCase();
  if (normalized === 'jpg' || normalized === 'jpeg') {
    return 'jpeg';
  }
  if (normalized === 'png' || normalized === 'webp') {
    return normalized;
  }
  return undefined;
}

function actualOutputFormatFromImageData(data: Array<Record<string, unknown>>) {
  const formats = new Set(data
    .map((item) => outputFormatForImageExtension(String(item.__actual_output_extension || '')))
    .filter((format): format is 'png' | 'jpeg' | 'webp' => Boolean(format)));
  return formats.size === 1 ? [...formats][0] : undefined;
}

function findCanvasUserByAccount(account: string) {
  const normalized = String(account || '').trim().toLowerCase();
  return canvasUserCache.find((item) => (
    item.status === 'active'
    && (
      String(item.username || '').trim().toLowerCase() === normalized
      || String(item.email || '').trim().toLowerCase() === normalized
    )
  )) || null;
}

function findCanvasUserById(userId: string) {
  return canvasUserCache.find((item) => item.id === userId && item.status === 'active') || null;
}

async function ensureCanvasTenantAndApiKeyForUser(user: CanvasUserRecord) {
  const catalog = await adminConsoleCatalogStore.refreshAsync();
  let tenant = catalog.tenants.find((item) => item.id === user.tenantId) || null;
  let apiKey = user.apiKeyId
    ? (catalog.apiKeys.find((item) => item.id === user.apiKeyId) || null)
    : null;

  if (!tenant) {
    tenant = {
      id: user.tenantId,
      name: `${user.username} 的租户`,
      code: `user_${user.id}`,
      status: 'active',
      allowedChannelIds: [imageChannelId, textChannelId],
      requestLimitPerMinute: 120,
      notes: 'Canvas OSS user auto-created tenant',
    };
    await adminConsoleCatalogStore.saveTenantAsync(tenant);
  }

  if (!apiKey) {
    const secret = createMaskedApiKey();
    apiKey = {
      id: `key_${crypto.randomBytes(8).toString('hex')}`,
      name: `${user.username} 默认密钥`,
      tenantId: tenant.id,
      status: 'active',
      allowedChannelIds: [imageChannelId, textChannelId],
      requestLimitPerMinute: 120,
      maxConcurrency: 10,
      imageRoutingMode: 'smart_failover',
      maxImageQuality: 'high',
      maskedKey: secret.masked,
      rawKey: secret.raw,
      keyHash: secret.hash,
      notes: 'Canvas OSS user auto-created API key',
    };
    await adminConsoleCatalogStore.saveApiKeyAsync(apiKey);
    await upsertCanvasUsers([{
      ...user,
      apiKeyId: apiKey.id,
      updatedAt: Date.now(),
    }]);
  }

  return {
    tenant,
    apiKey,
  };
}

async function createCanvasUserSession(user: CanvasUserRecord) {
  const token = createCanvasUserToken();
  const session: CanvasUserSessionRecord = {
    token,
    userId: user.id,
    username: user.username,
    createdAt: Date.now(),
    expiresAt: Date.now() + canvasUserSessionTtlMs,
  };
  const existingSessions = await pruneCanvasUserSessions();
  const sameUserTokens = existingSessions
    .filter((item) => item.userId === user.id)
    .map((item) => item.token);
  if (sameUserTokens.length) {
    await deleteCanvasUserSessionsByTokens(sameUserTokens);
  }
  await upsertCanvasUserSessions([session]);
  return session;
}

async function getCanvasUserAuth(request: any, reply: any, options: { required?: boolean } = {}) {
  const required = options.required !== false;
  await refreshCanvasUserCache();
  await refreshCanvasUserSessionCache();
  const token = parseCookieToken(request.headers.cookie, canvasUserCookieName);
  if (!token) {
    if (!required) {
      return null;
    }
    reply.code(401);
    const error = new Error('canvas_user_auth_required');
    (error as Error & { statusCode?: number }).statusCode = 401;
    throw error;
  }
  const sessions = await pruneCanvasUserSessions();
  const session = sessions.find((item) => item.token === token);
  if (!session) {
    clearCanvasUserCookie(reply);
    if (!required) {
      return null;
    }
    reply.code(401);
    const error = new Error('canvas_user_auth_required');
    (error as Error & { statusCode?: number }).statusCode = 401;
    throw error;
  }
  const user = findCanvasUserById(session.userId);
  if (!user) {
    clearCanvasUserCookie(reply);
    if (!required) {
      return null;
    }
    reply.code(401);
    const error = new Error('canvas_user_auth_required');
    (error as Error & { statusCode?: number }).statusCode = 401;
    throw error;
  }
  return { session, user };
}

async function requireCanvasUser(request: any, reply: any) {
  const auth = await getCanvasUserAuth(request, reply, { required: true });
  if (!auth) {
    const error = new Error('canvas_user_auth_required');
    (error as Error & { statusCode?: number }).statusCode = 401;
    throw error;
  }
  return auth;
}

function buildCanvasUserSafePayload(input: {
  user: CanvasUserRecord;
  rawApiKey?: string;
  apiKey?: {
    imageRoutingMode?: ImageRoutingMode;
    maxImageQuality?: ImageQualityCap;
    maxConcurrency?: number;
  } | null;
  tenantBalanceCents?: number;
}) {
  const preference = input.user.upstreamPreference || defaultCanvasUserUpstreamPreference();
  return {
    id: input.user.id,
    username: input.user.username,
    email: input.user.email,
    tenantId: input.user.tenantId,
    apiKeyId: input.user.apiKeyId || '',
    tenantBalanceCents: Math.max(0, Number(input.tenantBalanceCents || 0)),
    tenantBalanceYuan: minorUnitsToYuan(Math.max(0, Number(input.tenantBalanceCents || 0))),
    generatedApiKey: input.rawApiKey || '',
    generatedApiKeyMasked: input.rawApiKey ? maskSecret(input.rawApiKey) : '',
    apiKeySettings: {
      imageRoutingMode: input.apiKey?.imageRoutingMode || 'smart_failover',
      maxImageQuality: normalizeImageQualityCap(input.apiKey?.maxImageQuality),
      maxConcurrency: Math.max(1, Number(input.apiKey?.maxConcurrency || 10)),
    },
    upstreamPreference: {
      mode: preference.mode,
      imageApiKind: preference.imageApiKind || 'images_endpoint',
      imagesBaseUrl: preference.imagesBaseUrl || '',
      imagesGenerationsUrl: preference.imagesGenerationsUrl || '',
      imagesEditsUrl: preference.imagesEditsUrl || '',
      imagesApiKeyMasked: maskSecret(preference.imagesApiKey || ''),
      chatBaseUrl: preference.chatBaseUrl || '',
      chatApiKeyMasked: maskSecret(preference.chatApiKey || ''),
      preferredAuthMode: preference.preferredAuthMode || 'bearer',
      chatFallbackMode: preference.chatFallbackMode || 'platform_fallback',
      hasImagesApiKey: Boolean(String(preference.imagesApiKey || '').trim()),
      hasChatApiKey: Boolean(String(preference.chatApiKey || '').trim()),
      updatedAt: preference.updatedAt || 0,
    },
  };
}

function inferPublicBaseUrl(request: any) {
  const configured = String(process.env.PUBLIC_API_BASE_URL || '').trim();
  if (configured) {
    return configured.replace(/\/+$/, '');
  }
  const headers = request?.headers || {};
  const protocolHeader = String(headers['x-forwarded-proto'] || '').trim();
  const proto = protocolHeader || (request?.protocol || 'http');
  const hostHeader = String(headers['x-forwarded-host'] || headers.host || '').trim();
  if (hostHeader) {
    return `${proto}://${hostHeader.replace(/\/+$/, '')}`;
  }
  return `http://127.0.0.1:${port}`;
}

function buildGeneratedImageUrl(request: any, fileName: string) {
  return `${inferPublicBaseUrl(request)}/v1/generated-images/${encodeURIComponent(fileName)}`;
}

async function persistGeneratedImageAndBuildUrl(input: {
  request: any;
  taskId: string;
  imageIndex: number;
  base64: string;
  extension: string;
}) {
  assertBase64ImageWithinLimit(input.base64, 'generated image output');
  const dir = getGeneratedImageDir();
  await fs.mkdir(dir, { recursive: true });
  const fileName = `${sanitizeFileSegment(input.taskId)}_${input.imageIndex}.${sanitizeFileSegment(input.extension || 'png')}`;
  const filePath = path.join(dir, fileName);
  await fs.writeFile(filePath, Buffer.from(input.base64, 'base64'));
  return buildGeneratedImageUrl(input.request, fileName);
}

async function persistCanvasReferenceAssetAndBuildPayload(input: {
  request: any;
  ownerId: string;
  fileName: string;
  buffer: Buffer;
}) {
  assertBufferWithinLimit(input.buffer, 'canvas reference asset');
  const extension = detectImageExtensionFromBuffer(input.buffer);
  const dir = getCanvasReferenceAssetDir();
  await fs.mkdir(dir, { recursive: true });
  const token = crypto.randomBytes(24).toString('hex');
  const owner = sanitizeFileSegment(input.ownerId || 'canvas').slice(0, 48) || 'canvas';
  const baseName = path.basename(input.fileName || `reference.${extension}`);
  const safeName = sanitizeFileSegment(baseName.replace(/\.[a-zA-Z0-9]+$/, '')).slice(0, 80);
  const suffix = safeName ? `_${safeName}` : '';
  const storedFileName = `${owner}_${token}${suffix}.${sanitizeFileSegment(extension || 'png')}`;
  const filePath = path.join(dir, storedFileName);
  await fs.writeFile(filePath, input.buffer);
  const imageUrl = `${inferPublicBaseUrl(input.request)}/v1/canvas/reference-assets/${encodeURIComponent(storedFileName)}`;
  return {
    image_url: imageUrl,
    download_url: imageUrl,
    remote_reference_url: imageUrl,
    reference_asset_token: token,
    node_id: 'api-server',
    size_bytes: input.buffer.length,
    source: 'worker_temporary_reference_url',
  };
}

async function persistCanvasReferenceAssetFile(input: {
  request: any;
  ownerId: string;
  source: MultipartImageSource;
}) {
  const dir = getCanvasReferenceAssetDir();
  await fs.mkdir(dir, { recursive: true });
  const token = crypto.randomBytes(24).toString('hex');
  const owner = sanitizeFileSegment(input.ownerId || 'canvas').slice(0, 48) || 'canvas';
  const baseName = path.basename(input.source.fileName || `reference.${input.source.extension}`);
  const safeName = sanitizeFileSegment(baseName.replace(/\.[a-zA-Z0-9]+$/, '')).slice(0, 80);
  const suffix = safeName ? `_${safeName}` : '';
  const storedFileName = `${owner}_${token}${suffix}.${sanitizeFileSegment(input.source.extension || 'png')}`;
  const filePath = path.join(dir, storedFileName);
  await fs.copyFile(input.source.filePath, filePath);
  const imageUrl = `${inferPublicBaseUrl(input.request)}/v1/canvas/reference-assets/${encodeURIComponent(storedFileName)}`;
  return {
    image_url: imageUrl,
    download_url: imageUrl,
    remote_reference_url: imageUrl,
    reference_asset_token: token,
    node_id: 'api-server',
    size_bytes: input.source.bytes,
    source: 'worker_temporary_reference_url',
  };
}

function listCanvasUserApiKeys(apiKeys: ConsoleApiKey[], user: CanvasUserRecord) {
  return apiKeys
    .filter((item) => item.tenantId === user.tenantId)
    .sort((left, right) => {
      const leftIsDefault = left.id === user.apiKeyId ? 1 : 0;
      const rightIsDefault = right.id === user.apiKeyId ? 1 : 0;
      if (leftIsDefault !== rightIsDefault) {
        return rightIsDefault - leftIsDefault;
      }
      return left.name.localeCompare(right.name, 'zh-CN');
    });
}

function buildCanvasUserApiKeyPayload(apiKey: ConsoleApiKey, defaultApiKeyId?: string) {
  const fixedImageFlatPrice = apiKey.imageRoutingMode === 'fixed_provider'
    ? Math.max(0, Number(apiKey.fixedImageFlatPrice || 0))
    : 0;
  return {
    id: apiKey.id,
    name: apiKey.name,
    status: apiKey.status,
    maskedKey: apiKey.maskedKey,
    rawKey: apiKey.rawKey || '',
    isDefault: apiKey.id === defaultApiKeyId,
    downstreamImageApiType: apiKey.downstreamImageApiType || 'openai_images',
    bananaAllowedModels: apiKey.bananaAllowedModels || [],
    bananaAllowedImageSizes: apiKey.bananaAllowedImageSizes || [],
    imagePricingMode: fixedImageFlatPrice > 0 ? 'fixed_flat' : 'pricing_matrix',
    fixedImageFlatPrice,
  };
}

function estimateBase64DecodedBytes(value: string) {
  const compact = String(value || '').replace(/\s+/g, '');
  if (!compact) {
    return 0;
  }
  const padding = compact.endsWith('==') ? 2 : compact.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((compact.length * 3) / 4) - padding);
}

function assertBase64ImageWithinLimit(base64: string, label: string) {
  const decodedBytes = estimateBase64DecodedBytes(base64);
  if (decodedBytes > maxImagePayloadBytes) {
    const error = new Error(`${label} exceeds maximum image payload size.`);
    (error as Error & { statusCode?: number; code?: string; details?: Record<string, unknown> }).statusCode = 413;
    (error as Error & { statusCode?: number; code?: string; details?: Record<string, unknown> }).code = 'image_payload_too_large';
    (error as Error & { statusCode?: number; code?: string; details?: Record<string, unknown> }).details = {
      max_image_payload_bytes: maxImagePayloadBytes,
      received_image_payload_bytes: decodedBytes,
    };
    throw error;
  }
}

function assertBufferWithinLimit(buffer: Buffer, label: string, limitBytes = maxImagePayloadBytes) {
  if (buffer.length > limitBytes) {
    const error = new Error(`${label} exceeds maximum payload size.`);
    (error as Error & { statusCode?: number; code?: string; details?: Record<string, unknown> }).statusCode = 413;
    (error as Error & { statusCode?: number; code?: string; details?: Record<string, unknown> }).code = 'image_payload_too_large';
    (error as Error & { statusCode?: number; code?: string; details?: Record<string, unknown> }).details = {
      max_image_payload_bytes: limitBytes,
      received_image_payload_bytes: buffer.length,
    };
    throw error;
  }
}

function decodeImagePayloadToBase64(input: string) {
  const normalized = String(input || '').trim();
  const dataUrlMatch = normalized.match(/^data:image\/([a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/i);
  if (dataUrlMatch) {
    const mimeSubtype = String(dataUrlMatch[1] || '').toLowerCase();
    const extension = mimeSubtype === 'jpeg' ? 'jpg' : mimeSubtype || 'png';
    const base64 = dataUrlMatch[2].replace(/\s+/g, '');
    assertBase64ImageWithinLimit(base64, 'image data URL');
    return {
      base64,
      extension,
    };
  }
  if (isLikelyRawBase64(normalized)) {
    const cleaned = normalized.replace(/\s+/g, '');
    assertBase64ImageWithinLimit(cleaned, 'raw image base64');
    const buffer = Buffer.from(cleaned, 'base64');
    return {
      base64: cleaned,
      extension: detectImageExtensionFromBuffer(buffer),
    };
  }
  return null;
}

async function normalizeImageInputValueToUrl(input: {
  request: any;
  taskId: string;
  imageIndex: number;
  value: string;
}) {
  const raw = String(input.value || '').trim();
  if (!raw) {
    return raw;
  }
  if (isHttpUrl(raw)) {
    return raw;
  }
  const decoded = decodeImagePayloadToBase64(raw);
  if (!decoded?.base64) {
    return raw;
  }
  return persistGeneratedImageAndBuildUrl({
    request: input.request,
    taskId: input.taskId,
    imageIndex: input.imageIndex,
    base64: decoded.base64,
    extension: decoded.extension,
  });
}

async function normalizeIncomingImagePayloadReferences(request: any, payload: z.infer<typeof openAIImagesSchema>) {
  const nextPayload: z.infer<typeof openAIImagesSchema> = {
    ...payload,
  };
  const taskId = createRuntimeTaskId('imgref');

  if (payload.image) {
    const images = Array.isArray(payload.image) ? payload.image : [payload.image];
    const normalizedImages: string[] = [];
    for (let index = 0; index < images.length; index += 1) {
      normalizedImages.push(await normalizeImageInputValueToUrl({
        request,
        taskId,
        imageIndex: index,
        value: String(images[index] || ''),
      }));
    }
    nextPayload.image = Array.isArray(payload.image) ? normalizedImages : normalizedImages[0];
  }

  return nextPayload;
}

async function normalizeImageInputValueToDataUrl(value: string, budget: ImageInputByteBudget) {
  const raw = String(value || '').trim();
  if (!raw) {
    return raw;
  }
  const decoded = decodeImagePayloadToBase64(raw);
  if (decoded?.base64) {
    consumeImageInputBytes(budget, estimateBase64DecodedBytes(decoded.base64));
    return `data:${contentTypeForExtension(decoded.extension)};base64,${decoded.base64}`;
  }
  if (!isHttpUrl(raw)) {
    return raw;
  }
  const fetched = await fetchImageUrlAsBase64(raw, budget);
  return `data:${contentTypeForExtension(fetched.extension)};base64,${fetched.base64}`;
}

async function normalizeIncomingImagePayloadReferencesToDataUrl(payload: z.infer<typeof openAIImagesSchema>) {
  const nextPayload: z.infer<typeof openAIImagesSchema> = {
    ...payload,
  };

  if (payload.image) {
    const images = Array.isArray(payload.image) ? payload.image : [payload.image];
    const normalizedImages: string[] = [];
    const imageBudget = createImageInputByteBudget();
    for (const image of images) {
      normalizedImages.push(await normalizeImageInputValueToDataUrl(String(image || ''), imageBudget));
    }
    nextPayload.image = Array.isArray(payload.image) ? normalizedImages : normalizedImages[0];
  }

  return nextPayload;
}

async function normalizeIncomingImagePayloadReferencesPreservingUrls(payload: z.infer<typeof openAIImagesSchema>) {
  const nextPayload: z.infer<typeof openAIImagesSchema> = {
    ...payload,
  };

  if (payload.image) {
    const images = Array.isArray(payload.image) ? payload.image : [payload.image];
    const normalizedImages: string[] = [];
    for (const image of images) {
      const raw = String(image || '').trim();
      if (!raw) {
        normalizedImages.push(raw);
        continue;
      }
      const decoded = decodeImagePayloadToBase64(raw);
      if (decoded?.base64) {
        normalizedImages.push(`data:${contentTypeForExtension(decoded.extension)};base64,${decoded.base64}`);
        continue;
      }
      normalizedImages.push(raw);
    }
    nextPayload.image = Array.isArray(payload.image) ? normalizedImages : normalizedImages[0];
  }

  return nextPayload;
}

function supportedJsonReferenceTransports(provider: {
  protocol?: string;
  metadata?: Record<string, unknown>;
}) {
  const metadata = provider.metadata || {};
  const raw = provider.protocol === 'openai_responses'
    ? metadata.responses_json_reference_transports ?? metadata.images_json_reference_transports
    : metadata.images_json_reference_transports;
  if (Array.isArray(raw)) {
    const ordered: Array<'url' | 'base64'> = ['url', 'base64'];
    const filtered = raw.filter((item): item is 'url' | 'base64' => item === 'url' || item === 'base64');
    if (filtered.length) {
      return ordered.filter((item) => filtered.includes(item));
    }
  }

  const legacy = String(metadata.reference_image_transport || 'inherit').trim().toLowerCase();
  if (legacy === 'url' || legacy === 'base64') {
    return [legacy] as const;
  }

  return ['url', 'base64'] as const;
}

function withDefaultUpstreamImageOutputFormat(payload: z.infer<typeof openAIImagesSchema>) {
  const requestedFormat = String(payload.output_format ?? payload.extra_body?.output_format ?? '').trim();
  if (requestedFormat) {
    return payload;
  }
  return {
    ...payload,
    output_format: 'jpeg',
  };
}

async function adaptPayloadForProvider(input: {
  request: any;
  payload: z.infer<typeof openAIImagesSchema>;
  provider: { protocol?: string; metadata?: Record<string, unknown>; capability?: Record<string, unknown> };
}) {
  const payload = withDefaultUpstreamImageOutputFormat(input.payload);
  const transports = supportedJsonReferenceTransports(input.provider);
  if (!transports.includes('url') && !transports.includes('base64')) {
    return payload;
  }
  if (transports.includes('url') && !transports.includes('base64')) {
    return normalizeIncomingImagePayloadReferences(input.request, payload);
  }
  if (transports.includes('base64') && !transports.includes('url')) {
    return normalizeIncomingImagePayloadReferencesToDataUrl(payload);
  }
  return normalizeIncomingImagePayloadReferencesPreservingUrls(payload);
}

async function fetchImageUrlAsBase64(url: string, budget?: ImageInputByteBudget) {
  const maxBytes = budget?.maxImageBytes || maxImagePayloadBytes;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch image URL: HTTP ${response.status}`);
  }
  const contentLength = Number(response.headers.get('content-length') || 0);
  if (contentLength > maxBytes) {
    const error = new Error('Image URL source exceeds maximum payload size.');
    (error as Error & { statusCode?: number; code?: string; details?: Record<string, unknown> }).statusCode = 413;
    (error as Error & { statusCode?: number; code?: string; details?: Record<string, unknown> }).code = 'image_payload_too_large';
    (error as Error & { statusCode?: number; code?: string; details?: Record<string, unknown> }).details = {
      max_image_payload_bytes: maxBytes,
      received_image_payload_bytes: contentLength,
    };
    throw error;
  }
  const buffer = await readResponseBufferWithLimit(response, maxBytes, 'image URL source');
  assertBufferWithinLimit(buffer, 'image URL source', maxBytes);
  if (budget) {
    consumeImageInputBytes(budget, buffer.length);
  }
  return {
    base64: buffer.toString('base64'),
    extension: detectImageExtensionFromBuffer(buffer),
  };
}

function providerAllowsDirectPublicImageUrl(provider?: { metadata?: Record<string, unknown> } | null) {
  if (!provider?.metadata) {
    return false;
  }
  const kind = String(provider.metadata.consoleUpstreamKind || '').trim();
  const isResponses = kind === 'responses_endpoint';
  const enabled = isResponses
    ? provider.metadata.responses_allow_direct_public_image_url === true
    : provider.metadata.images_allow_direct_public_image_url === true;
  if (!enabled) {
    return false;
  }
  const rawResponseFormats = isResponses
    ? provider.metadata.responses_response_formats
    : provider.metadata.images_response_formats;
  const responseFormats: Array<'url' | 'b64_json'> = Array.isArray(rawResponseFormats)
    ? rawResponseFormats.filter((item): item is 'url' | 'b64_json' => item === 'url' || item === 'b64_json')
    : [];
  return responseFormats.includes('url');
}

function stripDataUrlPrefix(value: string) {
  const match = String(value || '').match(/^data:image\/[a-zA-Z0-9.+-]+;base64,([A-Za-z0-9+/=\s]+)$/i);
  return match ? match[1].replace(/\s+/g, '') : String(value || '').trim();
}

function fallbackMultipartFileName(fieldName: string, index: number, extension: string) {
  const safeExtension = extension === 'jpeg' ? 'jpg' : extension;
  return `reference-${index + 1}.${safeExtension}`;
}

async function buildMultipartFilePart(
  value: string,
  preferredFileName: string | undefined,
  fieldName: string,
  index: number,
  budget: ImageInputByteBudget,
) {
  const raw = String(value || '').trim();
  if (!raw) {
    return null;
  }

  if (isHttpUrl(raw)) {
    const response = await fetch(raw);
    if (!response.ok) {
      throw new Error(`Failed to fetch multipart image source: HTTP ${response.status}`);
    }
    const contentLength = Number(response.headers.get('content-length') || 0);
    if (contentLength > budget.maxImageBytes) {
      const error = new Error('Multipart image source exceeds maximum payload size.');
      (error as Error & { statusCode?: number; code?: string; details?: Record<string, unknown> }).statusCode = 413;
      (error as Error & { statusCode?: number; code?: string; details?: Record<string, unknown> }).code = 'image_payload_too_large';
      (error as Error & { statusCode?: number; code?: string; details?: Record<string, unknown> }).details = {
        max_image_payload_bytes: budget.maxImageBytes,
        received_image_payload_bytes: contentLength,
      };
      throw error;
    }
    const buffer = await readResponseBufferWithLimit(response, budget.maxImageBytes, 'multipart image source');
    assertBufferWithinLimit(buffer, 'multipart image source', budget.maxImageBytes);
    consumeImageInputBytes(budget, buffer.length);
    const extension = detectImageExtensionFromBuffer(buffer);
    return {
      blob: new Blob([buffer], { type: contentTypeForExtension(extension) }),
      fileName: String(preferredFileName || '').trim() || fallbackMultipartFileName(fieldName, index, extension),
    };
  }

  const decoded = decodeImagePayloadToBase64(raw);
  if (decoded?.base64) {
    const buffer = Buffer.from(decoded.base64, 'base64');
    assertBufferWithinLimit(buffer, 'multipart image base64 source', budget.maxImageBytes);
    consumeImageInputBytes(budget, buffer.length);
    return {
      blob: new Blob([buffer], { type: contentTypeForExtension(decoded.extension) }),
      fileName: String(preferredFileName || '').trim() || fallbackMultipartFileName(fieldName, index, decoded.extension),
    };
  }

  return null;
}

async function buildUpstreamFetchBody(plan: {
  bodyFormat: 'json' | 'multipart';
  body: Record<string, unknown>;
  multipartFileNames?: Record<string, string[]>;
  multipartFileSources?: Record<string, MultipartImageSource[]>;
}) {
  if (plan.bodyFormat === 'json') {
    return JSON.stringify(plan.body);
  }

  const form = new FormData();
  const imageBudget = createImageInputByteBudget();
  for (const [key, value] of Object.entries(plan.body || {})) {
    if (value === undefined || value === null) {
      continue;
    }
    if (key === 'image') {
      const values = Array.isArray(value) ? value : [value];
      const expectedFileNames = Array.isArray(plan.multipartFileNames?.[key]) ? plan.multipartFileNames?.[key] : [];
      const sourceFiles = Array.isArray(plan.multipartFileSources?.[key]) ? plan.multipartFileSources?.[key] : [];
      for (const [index, item] of values.entries()) {
        const source = sourceFiles[index];
        if (source) {
          const blob = await openAsBlob(source.filePath, { type: source.mimeType });
          form.append(key, blob, source.fileName);
          continue;
        }
        if (typeof item === 'string') {
          const part = await buildMultipartFilePart(item, expectedFileNames[index], key, index, imageBudget);
          if (part) {
            form.append(key, part.blob, part.fileName);
          } else {
            form.append(key, stripDataUrlPrefix(item));
          }
        } else {
          form.append(key, String(item));
        }
      }
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        form.append(key, typeof item === 'string' ? item : JSON.stringify(item));
      }
      continue;
    }
    if (typeof value === 'object') {
      form.append(key, JSON.stringify(value));
      continue;
    }
    form.append(key, String(value));
  }
  return form;
}

async function rewriteImageDataItemsToRequestedFormat(input: {
  request: any;
  taskId: string;
  data: Array<Record<string, unknown>>;
  responseFormat?: DownstreamImageResponseFormat;
  outputFormat?: string;
  allowDirectPublicImageUrl?: boolean;
}) {
  const rewritten: Array<Record<string, unknown>> = [];
  const publicBaseUrl = inferPublicBaseUrl(input.request);
  const wantsUrl = input.responseFormat !== 'b64_json';
  const wantsBase64 = input.responseFormat !== 'url';
  async function annotateDimensionsFromBase64(item: Record<string, unknown>, base64: string) {
    const audit = await buildImageResolutionAuditRecord({
      responsePayload: { data: [{ b64_json: base64 }] },
    });
    if (audit?.actualWidth && audit.actualHeight) {
      item.width = audit.actualWidth;
      item.height = audit.actualHeight;
    }
  }
  for (let index = 0; index < input.data.length; index += 1) {
    const item = { ...input.data[index] };
    const currentUrl = typeof item.url === 'string' ? item.url : '';
    const currentB64 = typeof item.b64_json === 'string' ? item.b64_json : '';
    if (currentB64) {
      item.__actual_output_extension = detectImageExtensionFromBuffer(Buffer.from(currentB64, 'base64'));
    }

    if (wantsUrl && !currentUrl && currentB64) {
      await annotateDimensionsFromBase64(item, currentB64);
      const extension = detectImageExtensionFromBuffer(Buffer.from(currentB64, 'base64'));
      const generatedUrl = await persistGeneratedImageAndBuildUrl({
        request: input.request,
        taskId: input.taskId,
        imageIndex: index,
        base64: currentB64,
        extension,
      });
      item.url = generatedUrl;
      item.__actual_output_extension = extension;
      if (!wantsBase64) {
        delete item.b64_json;
      }
    }

    if (wantsUrl && currentUrl && /^data:image\//i.test(currentUrl)) {
      const decoded = decodeImagePayloadToBase64(currentUrl);
      if (decoded?.base64) {
        const extension = detectImageExtensionFromBuffer(Buffer.from(decoded.base64, 'base64'));
        await annotateDimensionsFromBase64(item, decoded.base64);
        item.url = await persistGeneratedImageAndBuildUrl({
          request: input.request,
          taskId: input.taskId,
          imageIndex: index,
          base64: decoded.base64,
          extension,
        });
        item.__actual_output_extension = extension;
        if (wantsBase64) {
          item.b64_json = decoded.base64;
        }
      }
    }

    if (
      wantsUrl
      && currentUrl
      && /^https?:\/\//i.test(currentUrl)
      && !currentUrl.startsWith(`${publicBaseUrl}/v1/generated-images/`)
    ) {
      if (input.allowDirectPublicImageUrl) {
        const audit = await buildImageResolutionAuditRecord({
          responsePayload: { data: [{ url: currentUrl }] },
        });
        if (audit?.actualWidth && audit.actualHeight) {
          item.width = audit.actualWidth;
          item.height = audit.actualHeight;
        }
      } else {
        const fetched = await fetchImageUrlAsBase64(currentUrl);
        await annotateDimensionsFromBase64(item, fetched.base64);
        item.url = await persistGeneratedImageAndBuildUrl({
          request: input.request,
          taskId: input.taskId,
          imageIndex: index,
          base64: fetched.base64,
          extension: fetched.extension,
        });
        item.__actual_output_extension = fetched.extension;
        if (wantsBase64) {
          item.b64_json = fetched.base64;
        }
      }
    }

    if (wantsBase64 && typeof item.b64_json !== 'string' && currentUrl) {
      const decoded = /^data:image\//i.test(currentUrl)
        ? decodeImagePayloadToBase64(currentUrl)
        : null;
      const resolvedImage = decoded?.base64
        ? {
            base64: decoded.base64,
            extension: detectImageExtensionFromBuffer(Buffer.from(decoded.base64, 'base64')),
          }
        : await fetchImageUrlAsBase64(currentUrl);
      item.b64_json = resolvedImage.base64;
      item.__actual_output_extension = resolvedImage.extension;
      await annotateDimensionsFromBase64(item, resolvedImage.base64);
    }

    if (!wantsUrl) {
      delete item.url;
    }
    if (!wantsBase64) {
      delete item.b64_json;
    }

    for (const key of Object.keys(item)) {
      if (key.startsWith('__') && key !== '__actual_output_extension') {
        delete item[key];
      }
    }

    rewritten.push(item);
  }

  return rewritten;
}

async function normalizeStandardImageResponseBody(input: {
  request: any;
  taskId: string;
  bodyJson?: unknown;
  bodyText: string;
  responseContentType?: string;
  bodyBinaryBase64?: string;
  bodyBinaryExtension?: string;
  bodyBinaryFileName?: string;
  responseFormat?: DownstreamImageResponseFormat;
  outputFormat?: string;
  requestedImageCount?: number;
  requestedSize?: string;
  requestedQuality?: string;
  requestedPrompt?: string;
  requestedBackground?: string;
  allowDirectPublicImageUrl?: boolean;
}) {
  const normalizedContentType = String(input.responseContentType || '').toLowerCase();
  if (normalizedContentType.startsWith('image/') && (input.bodyBinaryBase64 || input.bodyBinaryFileName)) {
    const extension = input.bodyBinaryExtension || (
      normalizedContentType.includes('jpeg') || normalizedContentType.includes('jpg')
        ? 'jpg'
        : normalizedContentType.includes('webp')
          ? 'webp'
          : normalizedContentType.includes('gif')
            ? 'gif'
            : 'png'
    );
    return buildNormalizedImageResponseEnvelope({
      bodyJson: input.bodyJson,
      data: await rewriteImageDataItemsToRequestedFormat({
        request: input.request,
        taskId: input.taskId,
        data: [input.bodyBinaryFileName
          ? {
              url: buildGeneratedImageUrl(input.request, input.bodyBinaryFileName),
              __extension_hint: extension,
            }
          : {
              b64_json: input.bodyBinaryBase64,
              __extension_hint: extension,
            }],
        responseFormat: input.responseFormat,
        outputFormat: input.outputFormat,
        allowDirectPublicImageUrl: input.allowDirectPublicImageUrl,
      }),
      outputFormat: input.outputFormat,
      requestedSize: input.requestedSize,
      requestedQuality: input.requestedQuality,
      requestedPrompt: input.requestedPrompt,
      requestedBackground: input.requestedBackground,
    });
  }

  const candidates = buildResponseCandidates(input.bodyJson, input.bodyText);

  const data: Array<Record<string, unknown>> = [];
  for (const candidate of candidates) {
    if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
      const directItem = toOpenAIImageDataItem(candidate as Record<string, unknown>, input.responseFormat);
      if (directItem.url || directItem.b64_json) {
        data.push(directItem);
      }
    }
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      continue;
    }
    const record = candidate as Record<string, unknown>;
    if (!Array.isArray(record.data)) {
      continue;
    }
    data.push(...record.data.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item)));
  }

  if (!data.length) {
    return null;
  }
  const uniqueData = dedupeAndLimitImageDataItems(data, input.requestedImageCount);
  return buildNormalizedImageResponseEnvelope({
    bodyJson: input.bodyJson,
    data: await rewriteImageDataItemsToRequestedFormat({
      request: input.request,
      taskId: input.taskId,
      data: uniqueData,
      responseFormat: input.responseFormat,
      outputFormat: input.outputFormat,
      allowDirectPublicImageUrl: input.allowDirectPublicImageUrl,
    }),
    outputFormat: input.outputFormat,
    requestedSize: input.requestedSize,
    requestedQuality: input.requestedQuality,
    requestedPrompt: input.requestedPrompt,
    requestedBackground: input.requestedBackground,
  });
}

app.get('/v1/generated-images/:fileName', async (request, reply) => {
  const params = z.object({ fileName: z.string().min(1) }).parse(request.params);
  const fileName = sanitizeFileSegment(params.fileName);
  const download = String((request.query as Record<string, unknown>)?.download || '') === '1';
  const filePath = path.join(getGeneratedImageDir(), fileName);
  try {
    const stats = await fs.stat(filePath);
    const ext = path.extname(fileName).replace(/^\./, '').toLowerCase();
    const etag = `"${stats.size.toString(16)}-${Math.trunc(stats.mtimeMs).toString(16)}"`;
    const lastModified = stats.mtime.toUTCString();
    reply.header('Content-Type', contentTypeForExtension(ext));
    reply.header('Cache-Control', 'public, max-age=1200, immutable');
    reply.header('ETag', etag);
    reply.header('Last-Modified', lastModified);
    if (download) {
      reply.header('Content-Disposition', `attachment; filename="${fileName}"`);
    }
    if (
      String(request.headers['if-none-match'] || '').trim() === etag
      || (
        !request.headers['if-none-match']
        && request.headers['if-modified-since']
        && new Date(String(request.headers['if-modified-since'])).getTime() >= Math.trunc(stats.mtimeMs / 1000) * 1000
      )
    ) {
      reply.code(304);
      return reply.send();
    }
    if (generatedImageAccelRedirectPrefix.startsWith('/') && generatedImageAccelRedirectTargetDir) {
      const accelMirrorPath = path.join(generatedImageAccelRedirectTargetDir, fileName);
      try {
        await fs.stat(accelMirrorPath);
        reply.header(
          'X-Accel-Redirect',
          `${generatedImageAccelRedirectPrefix}/${encodeURIComponent(fileName)}`,
        );
        return reply.send();
      } catch {
        // Fall back to direct streaming when the configured accelerated mirror is unavailable.
      }
    }
    reply.header('Content-Length', String(stats.size));
    return reply.send(createReadStream(filePath));
  } catch {
    reply.code(404);
    return {
      error: 'file_not_found',
      message: 'Generated image file not found.',
    };
  }
});

async function executeUpstreamImageRequest(input: {
  request: any;
  payload: z.infer<typeof openAIImagesSchema>;
  operation: 'generations' | 'edits';
  accessContext: RequestAccessContext;
  asyncTaskAssetDirectory?: string;
  asyncTaskImageAssets?: AsyncTaskImageAsset[];
  streamBinaryResponseToUrl?: boolean;
  downstreamAbortSignal?: AbortSignal;
}) {
  throwIfDownstreamCancelled(input.downstreamAbortSignal);
  const preview = await buildSmartExecutionPreview(input);
  if (!preview.candidates.length) {
    return null;
  }

  let lastResult: {
    resolved: {
      provider: ProviderConfig;
      selection: {
        provider: ProviderConfig;
        attemptedProviderIds: string[];
        reason: 'selected';
      };
      requestPlan: UpstreamImageRequestPlan;
      passiveRecoveryReentry?: boolean;
    };
    payload: z.infer<typeof openAIImagesSchema>;
    response: Awaited<ReturnType<typeof fetchUpstreamAttempt>>;
    routing: {
      mode: EffectiveRoutingMode;
      candidateCount: number;
      attemptedProviderIds: string[];
      candidateProviderIds?: string[];
      filteredOut: Array<{ providerId: string; reason: string }>;
      reasons?: string[];
      score?: number;
      provider_attempts?: RoutedProviderAttemptTrace[];
    };
  } | null = null;
  let lastError: unknown = null;
  const providerAttempts: RoutedProviderAttemptTrace[] = [];
  const retrySoleProvider = canRetrySoleProvider(preview.mode, preview.candidates.length);
  const executionCandidates = retrySoleProvider
    ? Array.from({ length: maxSoleProviderRetries + 1 }, () => preview.candidates[0]!)
    : preview.candidates;

  for (let candidateIndex = 0; candidateIndex < executionCandidates.length; candidateIndex += 1) {
    throwIfDownstreamCancelled(input.downstreamAbortSignal);
    const candidateInput = executionCandidates[candidateIndex]!;
    let candidate: PreparedRoutedImageExecutionCandidate;
    try {
      candidate = await prepareRoutedImageExecutionCandidate(candidateInput);
    } catch (error) {
      if ((preview.mode !== 'smart_failover' && preview.mode !== 'fixed_provider_pool') || isTerminalPayloadPreparationError(error)) {
        throw error;
      }
      preview.filteredOut.push({
        providerId: candidateInput.provider.providerId,
        reason: 'payload_adaptation_failed',
      });
      continue;
    }
    throwIfDownstreamCancelled(input.downstreamAbortSignal);
    const sameProviderRetryAttempt = retrySoleProvider ? candidateIndex : undefined;
    const sameProviderRetryLimit = retrySoleProvider ? maxSoleProviderRetries : undefined;
    if (sameProviderRetryAttempt && sameProviderRetryAttempt > 0) {
      await waitBeforeSoleProviderRetry(sameProviderRetryAttempt);
    }
    const shouldRetryCurrentSoleProvider = (failure: { category: string; shouldFailover: boolean }) => (
      retrySoleProvider
      && candidateIndex < executionCandidates.length - 1
      && isSameProviderRetryableFailure(failure)
    );
    const attemptStartedAt = Date.now();
    const requestTimeoutMs = resolveProviderRequestTimeoutMs(candidate.provider);
    let providerConcurrencyKey: RuntimeConcurrencyLease | null = null;
    try {
      const providerConcurrency = await acquireProviderConcurrency(candidate.provider, requestTimeoutMs);
      if (!providerConcurrency.allowed) {
        const failure = {
          category: 'retryable_overloaded' as const,
          shouldFailover: true,
          cooldownMs: 0,
          affectsHealth: false,
        };
        providerAttempts.push(buildProviderAttemptTrace({
          candidate,
          startedAt: attemptStartedAt,
          status: 'failed',
          statusCode: 429,
          failureCategory: failure.category,
          shouldFailover: failure.shouldFailover,
          sameProviderRetryAttempt,
          sameProviderRetryLimit,
        }));
        lastResult = {
          resolved: {
            provider: candidate.provider,
            selection: {
              provider: candidate.provider,
              attemptedProviderIds: preview.candidates.map((item) => item.provider.providerId),
              reason: 'selected',
            },
            requestPlan: candidate.requestPlan,
            passiveRecoveryReentry: candidate.passiveRecoveryReentry,
          },
          payload: candidate.payload,
          response: {
            ok: false,
            statusCode: 429,
            contentType: 'application/json',
            bodyText: 'Provider concurrency limit reached before upstream request.',
            bodyBinaryBase64: undefined,
            bodyBinaryExtension: undefined,
            bodyBinaryFileName: undefined,
            bodyJson: {
              error: 'provider_concurrency_limit_reached',
              message: 'Provider concurrency limit reached before upstream request.',
            },
          },
          routing: buildRoutingSummary({
            mode: preview.mode,
            candidates: preview.candidates,
            filteredOut: preview.filteredOut,
            activeCandidate: candidate,
            attempts: providerAttempts,
          }),
        };
        // This 429 is emitted by our own concurrency guard before an upstream
        // request exists, so it must not affect provider health. A short retry
        // can still succeed when an in-flight request releases its slot.
        if (shouldRetryCurrentSoleProvider(failure)) {
          continue;
        }
        if (shouldStopAfterFirstProviderAttempt(preview.mode)) {
          return lastResult;
        }
        continue;
      }
      providerConcurrencyKey = providerConcurrency.key;
      const response = await fetchUpstreamAttempt({
        requestPlan: candidate.requestPlan,
        timeoutMs: requestTimeoutMs,
        downstreamAbortSignal: input.downstreamAbortSignal,
        streamBinaryResponseToUrl: input.streamBinaryResponseToUrl
          ?? resolveDownstreamImageResponseFormat(input.payload) === 'url',
      });
      lastResult = {
        resolved: {
          provider: candidate.provider,
          selection: {
            provider: candidate.provider,
            attemptedProviderIds: preview.candidates.map((item) => item.provider.providerId),
            reason: 'selected',
          },
          requestPlan: candidate.requestPlan,
          passiveRecoveryReentry: candidate.passiveRecoveryReentry,
        },
        payload: candidate.payload,
        response,
        routing: buildRoutingSummary({
          mode: preview.mode,
          candidates: preview.candidates,
          filteredOut: preview.filteredOut,
          activeCandidate: candidate,
          attempts: providerAttempts,
        }),
      };

      if (response.ok && responseContainsUsableImageOutput({
        protocol: candidate.provider.protocol,
        contentType: response.contentType,
        bodyJson: response.bodyJson,
        bodyText: response.bodyText,
        bodyBinaryBase64: response.bodyBinaryBase64,
        bodyBinaryFileName: response.bodyBinaryFileName,
      })) {
        providerAttempts.push(buildProviderAttemptTrace({
          candidate,
          startedAt: attemptStartedAt,
          status: 'success',
          statusCode: response.statusCode,
          sameProviderRetryAttempt,
          sameProviderRetryLimit,
        }));
        lastResult.routing = buildRoutingSummary({
          mode: preview.mode,
          candidates: preview.candidates,
          filteredOut: preview.filteredOut,
          activeCandidate: candidate,
          attempts: providerAttempts,
        });
        return lastResult;
      }

      if (response.ok) {
        const semanticFailure = {
          category: 'retryable_status' as const,
          shouldFailover: true,
          cooldownMs: 20_000,
          affectsHealth: true,
        };
        providerAttempts.push(buildProviderAttemptTrace({
          candidate,
          startedAt: attemptStartedAt,
          status: 'failed',
          statusCode: 502,
          failureCategory: semanticFailure.category,
          shouldFailover: semanticFailure.shouldFailover,
          sameProviderRetryAttempt,
          sameProviderRetryLimit,
        }));
        await providerRegistry.reportAttempt({
          providerId: candidate.provider.providerId,
          ok: false,
          statusCode: 502,
          failedAt: Date.now(),
          cooldownMs: semanticFailure.cooldownMs,
          affectsHealth: semanticFailure.affectsHealth,
          latencyMs: latestProviderAttemptDurationMs(providerAttempts, candidate.provider.providerId),
          failureCategory: semanticFailure.category,
          errorMessage: 'Upstream responded successfully but did not return usable image output.',
          passiveRecoveryReentry: candidate.passiveRecoveryReentry,
        });
        lastResult = {
          ...lastResult,
          response: {
            ...response,
            ok: false,
            statusCode: 502,
            bodyText: 'Upstream responded successfully but did not return usable image output.',
            bodyJson: {
              error: 'invalid_upstream_response',
              message: 'Upstream responded successfully but did not return usable image output.',
            },
          },
        };
        lastResult.routing = buildRoutingSummary({
          mode: preview.mode,
          candidates: preview.candidates,
          filteredOut: preview.filteredOut,
          activeCandidate: candidate,
          attempts: providerAttempts,
        });
        if (shouldRetryCurrentSoleProvider(semanticFailure)) {
          continue;
        }
        if (shouldStopAfterFirstProviderAttempt(preview.mode)) {
          return lastResult;
        }
        continue;
      }

      const failure = classifyUpstreamFailure({
        statusCode: response.statusCode,
        bodyText: response.bodyText,
        bodyJson: response.bodyJson,
      });
      providerAttempts.push(buildProviderAttemptTrace({
        candidate,
        startedAt: attemptStartedAt,
        status: 'failed',
        statusCode: response.statusCode,
        failureCategory: failure.category,
        shouldFailover: failure.shouldFailover,
        sameProviderRetryAttempt,
        sameProviderRetryLimit,
      }));
      await providerRegistry.reportAttempt({
        providerId: candidate.provider.providerId,
        ok: false,
        statusCode: response.statusCode,
        failedAt: Date.now(),
        cooldownMs: failure.cooldownMs,
        affectsHealth: failure.affectsHealth !== false,
        latencyMs: latestProviderAttemptDurationMs(providerAttempts, candidate.provider.providerId),
        failureCategory: failure.category,
        errorMessage: extractUpstreamErrorMessage({
          bodyJson: response.bodyJson,
          bodyText: response.bodyText,
        }),
        passiveRecoveryReentry: candidate.passiveRecoveryReentry,
      });
      lastResult.routing = buildRoutingSummary({
        mode: preview.mode,
        candidates: preview.candidates,
        filteredOut: preview.filteredOut,
        activeCandidate: candidate,
        attempts: providerAttempts,
      });
      if (shouldRetryCurrentSoleProvider(failure)) {
        continue;
      }
      if (!failure.shouldFailover || shouldStopAfterFirstProviderAttempt(preview.mode)) {
        return lastResult;
      }
    } catch (error) {
      if (isDownstreamClientDisconnectedError(error)) {
        throw error;
      }
      lastError = error;
      const failure = classifyUpstreamFailure({
        fetchError: error,
      });
      providerAttempts.push(buildProviderAttemptTrace({
        candidate,
        startedAt: attemptStartedAt,
        status: 'failed',
        statusCode: 599,
        failureCategory: failure.category,
        shouldFailover: failure.shouldFailover,
        sameProviderRetryAttempt,
        sameProviderRetryLimit,
      }));
      await providerRegistry.reportAttempt({
        providerId: candidate.provider.providerId,
        ok: false,
        statusCode: 599,
        failedAt: Date.now(),
        cooldownMs: failure.cooldownMs,
        affectsHealth: failure.affectsHealth !== false,
        latencyMs: latestProviderAttemptDurationMs(providerAttempts, candidate.provider.providerId),
        failureCategory: failure.category,
        errorMessage: error instanceof Error ? error.message : 'upstream_fetch_failed',
        passiveRecoveryReentry: candidate.passiveRecoveryReentry,
      });
      lastResult = {
        resolved: {
          provider: candidate.provider,
          selection: {
            provider: candidate.provider,
            attemptedProviderIds: preview.candidates.map((item) => item.provider.providerId),
            reason: 'selected',
          },
          requestPlan: candidate.requestPlan,
        },
        payload: candidate.payload,
        response: {
          ok: false,
          statusCode: 599,
          contentType: 'application/json',
          bodyText: error instanceof Error ? error.message : 'upstream_fetch_failed',
          bodyBinaryBase64: undefined,
          bodyBinaryExtension: undefined,
          bodyBinaryFileName: undefined,
          bodyJson: {
            error: 'upstream_fetch_failed',
            message: error instanceof Error ? error.message : 'Unknown upstream fetch failure.',
          },
        },
        routing: buildRoutingSummary({
          mode: preview.mode,
          candidates: preview.candidates,
          filteredOut: preview.filteredOut,
          activeCandidate: candidate,
          attempts: providerAttempts,
        }),
      };
      if (shouldRetryCurrentSoleProvider(failure)) {
        continue;
      }
      if (!failure.shouldFailover || shouldStopAfterFirstProviderAttempt(preview.mode)) {
        return lastResult;
      }
    } finally {
      await releaseProviderConcurrency(providerConcurrencyKey);
    }
  }

  if (lastResult) {
    return lastResult;
  }
  if (lastError) {
    throw lastError;
  }
  return null;
}

function wantsStreamingResponse(payload: z.infer<typeof openAIImagesSchema>) {
  return Boolean(payload.extra_body?.stream === true);
}

type NormalizedImageResponseBody = Record<string, unknown> & {
  created?: number;
  data: Array<Record<string, unknown>>;
};

async function streamImageResultAsSse(input: {
  reply: any;
  statusCode: number;
  normalizedBody: NormalizedImageResponseBody | null;
  operation: 'generations' | 'edits';
}) {
  input.reply.raw.writeHead(input.statusCode, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  if (!input.normalizedBody) {
    input.reply.raw.write(`data: ${JSON.stringify({
      error: 'invalid_upstream_response',
      message: 'Upstream response did not contain image output.',
    })}\n\n`);
    input.reply.raw.write('data: [DONE]\n\n');
    input.reply.raw.end();
    return input.reply;
  }

  input.reply.raw.write(`data: ${JSON.stringify({
    object: input.operation === 'edits' ? 'image.edit.result' : 'image.generation.result',
    type: input.operation === 'edits' ? 'image_edit.completed' : 'image_generation.completed',
    created: input.normalizedBody.created,
    data: input.normalizedBody.data,
  })}\n\n`);
  input.reply.raw.write('data: [DONE]\n\n');
  input.reply.raw.end();
  return input.reply;
}

function createRuntimeTaskId(prefix: string) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function readRuntimeTaskCreatedAtFromId(taskId: string) {
  const match = String(taskId || '').trim().match(/^[a-z]+_([0-9a-z]+)_/i);
  if (!match) {
    return 0;
  }
  const timestamp = Number.parseInt(match[1], 36);
  if (!Number.isFinite(timestamp) || timestamp < 1_500_000_000_000 || timestamp > Date.now() + 60_000) {
    return 0;
  }
  return timestamp;
}

function summarizeTrace(operation: 'generations' | 'edits', statusCode?: number, ok?: boolean) {
  return `${operation} ${ok ? 'success' : 'failed'}${statusCode ? ` HTTP ${statusCode}` : ''}`.trim();
}

function effectiveImageTaskQueryTtlSeconds() {
  return Math.max(configuredImageTaskQueryTtlSeconds, Math.ceil(effectiveGeneratedImageRetentionMs() / 1000));
}

function isTaskExpired(task: { updated_at?: number; created_at?: number }) {
  const lastTouchedAt = Number(task.updated_at || task.created_at || 0);
  if (!lastTouchedAt) {
    return true;
  }
  return Date.now() - lastTouchedAt > effectiveImageTaskQueryTtlSeconds() * 1000;
}

function isRuntimeTaskIdExpired(taskId: string) {
  const createdAt = readRuntimeTaskCreatedAtFromId(taskId);
  return Boolean(createdAt && Date.now() - createdAt > effectiveImageTaskQueryTtlSeconds() * 1000);
}

function imageTaskExpiredPayload(message: string) {
  return {
    error: 'task_expired',
    message,
  };
}

function imageTaskStateFromTaskRecord(record: TaskMasterRecord | null): ImageGatewayTaskState | null {
  if (!record || (record.operation !== 'generations' && record.operation !== 'edits')) {
    return null;
  }
  if (record.status !== 'completed' && record.status !== 'failed' && record.status !== 'cancelled') {
    return null;
  }
  const requestPayload = record.requestPayload || {};
  return {
    task_id: record.taskId,
    operation: record.operation,
    provider_id: record.providerId || record.upstreamId || '',
    status: record.status === 'completed'
      ? 'completed'
      : record.status === 'cancelled'
        ? 'cancelled'
        : 'failed',
    created_at: Number(record.createdAt || Date.now()),
    updated_at: Number(record.updatedAt || record.completedAt || record.createdAt || Date.now()),
    started_at: undefined,
    queue_expires_at: undefined,
    request_plan: (requestPayload.requestPlan || {}) as Record<string, unknown>,
    result: record.responsePayload || null,
    error: record.errorPayload || null,
  };
}

async function getImageTaskState(taskId: string) {
  if (asyncHotStateStore) {
    try {
      const remote = await asyncHotStateStore.getImageTask(taskId);
      if (remote) {
        hotStateStore.setImageTask(taskId, remote, imageTaskHotTtlSeconds);
        return remote;
      }
    } catch (error) {
      if (sharedHotStateStrict) {
        throw createSharedHotStateUnavailableError('image_task_read');
      }
      requestLogWarn('redis_image_task_read_fallback_miss', error);
    }
  }
  const local = hotStateStore.getImageTask(taskId);
  if (local) {
    return local;
  }
  try {
    const recovered = imageTaskStateFromTaskRecord(await operationalRepository.getTask(taskId));
    if (recovered) {
      await setImageTaskState(taskId, recovered, imageTaskHotTtlSeconds);
    }
    return recovered;
  } catch (error) {
    requestLogWarn('image_task_master_recover_failed', error);
    return null;
  }
}

async function setImageTaskState(taskId: string, task: ImageGatewayTaskState, ttlSeconds = imageTaskHotTtlSeconds) {
  hotStateStore.setImageTask(taskId, task, ttlSeconds);
  if (!asyncHotStateStore) {
    return;
  }
  try {
    await asyncHotStateStore.setImageTask(taskId, task, ttlSeconds);
  } catch (error) {
    if (sharedHotStateStrict) {
      throw createSharedHotStateUnavailableError('image_task_write');
    }
    requestLogWarn('redis_image_task_write_failed', error);
  }
}

async function listSharedImageTasks() {
  if (!asyncHotStateStore) {
    return hotStateStore.listImageTasks().filter((task) => !isTaskExpired(task));
  }
  try {
    return (await asyncHotStateStore.listImageTasks()).filter((task) => !isTaskExpired(task));
  } catch (error) {
    if (sharedHotStateStrict) {
      throw createSharedHotStateUnavailableError('image_task_list');
    }
    requestLogWarn('redis_image_task_list_failed', error);
    return hotStateStore.listImageTasks().filter((task) => !isTaskExpired(task));
  }
}

async function listQueuedImageTasks() {
  if (!asyncHotStateStore?.listQueuedImageTasks) {
    return (await listSharedImageTasks()).filter((task) => task.status === 'queued');
  }
  try {
    return await asyncHotStateStore.listQueuedImageTasks();
  } catch (error) {
    if (sharedHotStateStrict) {
      throw createSharedHotStateUnavailableError('image_task_queue_list');
    }
    requestLogWarn('redis_image_task_queue_list_failed', error);
    return (await listSharedImageTasks()).filter((task) => task.status === 'queued');
  }
}

async function getCanvasWorkflowRunState(runId: string) {
  if (asyncHotStateStore) {
    try {
      const remote = await asyncHotStateStore.getWorkflowRun(runId);
      if (remote) {
        hotStateStore.setWorkflowRun(runId, remote, workflowRunTtlSeconds);
        return remote;
      }
    } catch (error) {
      if (sharedHotStateStrict) {
        throw createSharedHotStateUnavailableError('workflow_run_read');
      }
      requestLogWarn('redis_workflow_run_read_fallback_miss', error);
    }
  }
  return hotStateStore.getWorkflowRun(runId);
}

async function setCanvasWorkflowRunState(runId: string, run: CanvasWorkflowRunState, ttlSeconds = workflowRunTtlSeconds) {
  hotStateStore.setWorkflowRun(runId, run, ttlSeconds);
  if (!asyncHotStateStore) {
    return;
  }
  try {
    await asyncHotStateStore.setWorkflowRun(runId, run, ttlSeconds);
  } catch (error) {
    if (sharedHotStateStrict) {
      throw createSharedHotStateUnavailableError('workflow_run_write');
    }
    requestLogWarn('redis_workflow_run_write_failed', error);
  }
}

async function updateCanvasWorkflowRun(runId: string, mutate: (run: CanvasWorkflowRunState) => void) {
  const run = await getCanvasWorkflowRunState(runId);
  if (!run) {
    return null;
  }
  mutate(run);
  run.updated_at = Date.now();
  await setCanvasWorkflowRunState(runId, run, workflowRunTtlSeconds);
  return run;
}

async function deleteCanvasWorkflowRunState(runId: string) {
  hotStateStore.deleteWorkflowRun(runId);
  if (!asyncHotStateStore) {
    return;
  }
  try {
    await asyncHotStateStore.deleteWorkflowRun(runId);
  } catch (error) {
    if (sharedHotStateStrict) {
      throw createSharedHotStateUnavailableError('workflow_run_delete');
    }
    requestLogWarn('redis_workflow_run_delete_failed', error);
  }
}

async function listSharedCanvasWorkflowRuns() {
  if (!asyncHotStateStore) {
    return hotStateStore.listWorkflowRuns();
  }
  try {
    const runs = await asyncHotStateStore.listWorkflowRuns();
    for (const run of runs) {
      hotStateStore.setWorkflowRun(run.run_id, run, workflowRunTtlSeconds);
    }
    return runs;
  } catch (error) {
    if (sharedHotStateStrict) {
      throw createSharedHotStateUnavailableError('workflow_run_list');
    }
    requestLogWarn('redis_workflow_run_list_failed', error);
    return hotStateStore.listWorkflowRuns();
  }
}

function sortCanvasWorkflowRunsByRecency(runs: CanvasWorkflowRunState[]) {
  return [...runs].sort((left, right) => {
    const leftUpdated = Number(left.updated_at || left.completed_at || left.created_at || 0);
    const rightUpdated = Number(right.updated_at || right.completed_at || right.created_at || 0);
    if (leftUpdated !== rightUpdated) {
      return rightUpdated - leftUpdated;
    }
    const leftCreated = Number(left.created_at || 0);
    const rightCreated = Number(right.created_at || 0);
    if (leftCreated !== rightCreated) {
      return rightCreated - leftCreated;
    }
    return String(right.run_id || '').localeCompare(String(left.run_id || ''));
  });
}

function getCanvasRunResultItemKey(item: Record<string, unknown> | null | undefined) {
  const taskId = String(item?.task_id || item?.taskId || '').trim();
  if (taskId) {
    return `task:${taskId}`;
  }
  const jobId = String(item?.job_id || item?.jobId || item?.id || '').trim();
  if (jobId) {
    return `job:${jobId}`;
  }
  const imageUrl = String(
    item?.image_url
    || item?.imageUrl
    || item?.download_url
    || item?.downloadUrl
    || item?.reference_url
    || item?.referenceUrl
    || ''
  ).trim();
  if (imageUrl) {
    return `url:${imageUrl}`;
  }
  const index = Number(item?.index || 0);
  const name = String(item?.name || item?.image_category || item?.imageCategory || '').trim();
  return index || name ? `meta:${index}:${name}` : '';
}

function normalizeCanvasRunImageVersionEntry(version: Record<string, unknown>, fallbackIndex = 0) {
  const imageUrl = String(version?.image_url || version?.imageUrl || '').trim();
  const downloadUrl = String(
    version?.download_url
    || version?.downloadUrl
    || version?.reference_url
    || version?.referenceUrl
    || imageUrl
    || ''
  ).trim();
  if (!imageUrl && !downloadUrl) {
    return null;
  }
  return {
    id: String(version?.id || version?.version_id || version?.versionId || `version-${fallbackIndex + 1}`).trim(),
    label: String(version?.label || version?.name || `版本 ${fallbackIndex + 1}`).trim(),
    image_url: imageUrl || downloadUrl,
    download_url: downloadUrl || imageUrl,
    reference_url: String(version?.reference_url || version?.referenceUrl || downloadUrl || imageUrl).trim(),
    task_id: String(version?.task_id || version?.taskId || '').trim(),
    prompt: String(version?.prompt || '').trim(),
    edit_type: String(version?.edit_type || version?.editType || '').trim(),
    created_at: String(version?.created_at || version?.createdAt || '').trim(),
  };
}

function buildCanvasRunOriginalVersion(item: Record<string, unknown>) {
  const imageUrl = String(item?.image_url || item?.imageUrl || item?.download_url || item?.downloadUrl || '').trim();
  const downloadUrl = String(
    item?.download_url
    || item?.downloadUrl
    || item?.reference_url
    || item?.referenceUrl
    || imageUrl
    || ''
  ).trim();
  if (!imageUrl && !downloadUrl) {
    return null;
  }
  return {
    id: 'original',
    label: '原始图',
    image_url: imageUrl || downloadUrl,
    download_url: downloadUrl || imageUrl,
    reference_url: String(item?.reference_url || item?.referenceUrl || downloadUrl || imageUrl).trim(),
    task_id: String(item?.task_id || item?.taskId || '').trim(),
    prompt: String(item?.prompt || '').trim(),
    edit_type: '',
    created_at: '',
  };
}

function normalizeCanvasRunImageVersions(item: Record<string, unknown>) {
  const versions = Array.isArray(item?.versions)
    ? item.versions
        .map((entry, index) => (
          entry && typeof entry === 'object'
            ? normalizeCanvasRunImageVersionEntry(entry as Record<string, unknown>, index)
            : null
        ))
        .filter(Boolean)
    : [];
  if (!versions.some((entry) => entry && String((entry as Record<string, unknown>).id || '').trim() === 'original')) {
    const original = buildCanvasRunOriginalVersion(item);
    if (original) {
      versions.unshift(original);
    }
  }
  return versions as Array<Record<string, unknown>>;
}

function mergeCanvasRunResultItemVersion(
  item: Record<string, unknown>,
  version: Record<string, unknown>,
  selectFinal = true,
) {
  const normalizedVersion = normalizeCanvasRunImageVersionEntry(version, 0);
  if (!normalizedVersion) {
    return item;
  }
  const versions = normalizeCanvasRunImageVersions(item);
  const nextVersions = versions.some((entry) => String(entry.id || '').trim() === normalizedVersion.id)
    ? versions.map((entry) => (
        String(entry.id || '').trim() === normalizedVersion.id
          ? { ...entry, ...normalizedVersion }
          : entry
      ))
    : versions.concat(normalizedVersion);
  const nextItem: Record<string, unknown> = {
    ...item,
    versions: nextVersions,
    selected_version_id: selectFinal
      ? normalizedVersion.id
      : String(item?.selected_version_id || item?.selectedVersionId || '').trim(),
  };
  if (selectFinal) {
    nextItem.image_url = normalizedVersion.image_url;
    nextItem.download_url = normalizedVersion.download_url || normalizedVersion.image_url;
    nextItem.reference_url = normalizedVersion.reference_url || normalizedVersion.download_url || normalizedVersion.image_url;
    nextItem.task_id = normalizedVersion.task_id || item?.task_id || item?.taskId || '';
    nextItem.prompt = normalizedVersion.prompt || item?.prompt || '';
  }
  return nextItem;
}

function findCanvasRunResultItemIndex(
  items: Array<Record<string, unknown>>,
  itemKey: string,
  itemIndex: number,
) {
  if (itemKey) {
    const matchedByKey = items.findIndex((item) => getCanvasRunResultItemKey(item) === itemKey);
    if (matchedByKey >= 0) {
      return matchedByKey;
    }
  }
  if (itemIndex >= 0 && itemIndex < items.length) {
    return itemIndex;
  }
  return -1;
}

function updateCanvasRunJobSummaryFromResultItems(
  job: WorkflowRunJobState,
  resultItems: Array<Record<string, unknown>>,
  options: { clearPackageDownload?: boolean; preserveDownloadUrl?: boolean } = {},
) {
  const first = resultItems.find((item) => (
    String(item?.image_url || item?.download_url || item?.reference_url || '').trim()
  )) || null;
  job.result_items = resultItems;
  job.image_url = String(first?.image_url || first?.download_url || first?.reference_url || '').trim();
  job.reference_url = String(first?.reference_url || first?.download_url || first?.image_url || '').trim();
  if (options.clearPackageDownload) {
    job.download_url = '';
  } else if (!options.preserveDownloadUrl) {
    job.download_url = String(first?.download_url || first?.reference_url || first?.image_url || '').trim();
  }
  job.task_id = String(first?.task_id || '').trim();
  if (typeof first?.prompt === 'string' && String(first.prompt).trim()) {
    job.prompt = String(first.prompt).trim();
  }
}

function updateCanvasRunNodeSummaryFromResultItems(
  state: WorkflowNodeState,
  resultItems: Array<Record<string, unknown>>,
  options: { clearOutputArtifacts?: boolean } = {},
) {
  const first = resultItems.find((item) => (
    String(item?.image_url || item?.download_url || item?.reference_url || '').trim()
  )) || null;
  state.image_url = String(first?.image_url || first?.download_url || first?.reference_url || '').trim();
  state.reference_url = String(first?.reference_url || first?.download_url || first?.image_url || '').trim();
  state.task_id = String(first?.task_id || '').trim();
  if (options.clearOutputArtifacts) {
    state.output_url = '';
    state.package_url = '';
    state.package_file_name = '';
    state.csv_url = '';
  }
}

function matchCanvasWorkflowRunIdentifiers(run: CanvasWorkflowRunState, canvasId: string, canvasBatchId: string) {
  const runCanvasId = String(run.canvas_id || '').trim();
  const runBatchId = String(run.canvas_batch_id || '').trim();
  if (!canvasId && !canvasBatchId) {
    return true;
  }
  if (canvasId && (runCanvasId === canvasId || runBatchId === canvasId)) {
    return true;
  }
  if (canvasBatchId && (runCanvasId === canvasBatchId || runBatchId === canvasBatchId)) {
    return true;
  }
  return false;
}

function pickAsyncTaskRequestHeaders(request: any): Record<string, string> {
  return {
    host: String(request?.headers?.host || '').trim(),
    'x-forwarded-host': String(request?.headers?.['x-forwarded-host'] || '').trim(),
    'x-forwarded-proto': String(request?.headers?.['x-forwarded-proto'] || '').trim(),
    'content-type': String(request?.headers?.['content-type'] || '').trim(),
  };
}

function buildSyntheticQueuedRequest(headers: Record<string, string>) {
  return {
    headers,
    protocol: String(headers['x-forwarded-proto'] || '').trim() || 'http',
  };
}

function readQueuedTaskInternalState(task: ImageGatewayTaskState): AsyncQueuedTaskInternalState | null {
  const internal = task.internal;
  if (!internal || typeof internal !== 'object' || Array.isArray(internal)) {
    return null;
  }
  const payload = (internal as Record<string, unknown>).payload;
  const accessContext = (internal as Record<string, unknown>).accessContext;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return null;
  }
  if (!accessContext || typeof accessContext !== 'object' || Array.isArray(accessContext)) {
    return null;
  }
  const rawHeaders = (internal as Record<string, unknown>).requestHeaders;
  const rawImageAssets = (internal as Record<string, unknown>).imageAssets;
  const requestHeaders = rawHeaders && typeof rawHeaders === 'object' && !Array.isArray(rawHeaders)
    ? Object.fromEntries(
        Object.entries(rawHeaders as Record<string, unknown>)
          .map(([key, value]) => [key, String(value || '').trim()]),
      )
    : {};
  return {
    payload: payload as z.infer<typeof openAIImagesSchema>,
    accessContext: accessContext as RequestAccessContext,
    requestHeaders,
    enqueuedAt: Number((internal as Record<string, unknown>).enqueuedAt || task.created_at || Date.now()),
    attemptCount: Math.max(0, Number((internal as Record<string, unknown>).attemptCount || 0)),
    assetDirectory: String((internal as Record<string, unknown>).assetDirectory || '').trim() || undefined,
    imageAssets: Array.isArray(rawImageAssets)
      ? rawImageAssets
        .filter((asset): asset is Record<string, unknown> => Boolean(asset) && typeof asset === 'object' && !Array.isArray(asset))
        .map((asset) => ({
          sourceRef: String(asset.sourceRef || '').trim(),
          assetName: String(asset.assetName || '').trim(),
          fileName: normalizeIncomingMultipartImageFileName(asset.fileName),
          mimeType: String(asset.mimeType || '').trim(),
          extension: sanitizeFileSegment(String(asset.extension || '').trim()),
          bytes: Math.max(0, Number(asset.bytes || 0)),
        }))
        .filter((asset) => (
          asset.sourceRef.startsWith(asyncTaskImageAssetPrefix)
          && Boolean(resolveAsyncTaskAssetPath(String((internal as Record<string, unknown>).assetDirectory || ''), asset.assetName))
          && Boolean(asset.fileName)
          && Boolean(asset.mimeType)
          && Boolean(asset.extension)
          && asset.bytes > 0
        ))
      : undefined,
  };
}

function writeQueuedTaskInternalState(task: ImageGatewayTaskState, state: AsyncQueuedTaskInternalState) {
  task.internal = {
    payload: state.payload,
    accessContext: state.accessContext,
    requestHeaders: state.requestHeaders,
    enqueuedAt: state.enqueuedAt,
    attemptCount: state.attemptCount,
    assetDirectory: state.assetDirectory || '',
    imageAssets: state.imageAssets || [],
  };
}

function sanitizeImageTaskForResponse(task: ImageGatewayTaskState) {
  const {
    internal: _internal,
    last_worker_id: _lastWorkerId,
    provider_id: _providerId,
    request_plan: _requestPlan,
    ...rest
  } = task;
  return {
    ...rest,
    error: sanitizePublicTaskError(rest.error),
    result: sanitizePublicTaskResult(rest.result),
  };
}

function parseBearerToken(value: unknown) {
  const raw = String(value || '').trim();
  const match = raw.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

function isInternalCanvasWorkerRequest(request: any) {
  if (String(request?.headers?.['x-yali-internal-worker'] || '').trim() !== '1') {
    return false;
  }
  if (String(request?.headers?.['x-forwarded-for'] || '').trim()) {
    return false;
  }
  const remoteAddress = String(request?.raw?.socket?.remoteAddress || request?.socket?.remoteAddress || request?.ip || '').trim();
  return remoteAddress === '127.0.0.1' || remoteAddress === '::1' || remoteAddress.endsWith(':127.0.0.1');
}

async function resolveRequestAccessContext(
  headers: Record<string, unknown>,
  payload: z.infer<typeof openAIImagesSchema>,
  request?: any,
): Promise<RequestAccessResult> {
  const controlPlane = adminControlPlaneStore.get();
  const authPolicy = controlPlane.publicApi.authMode;
  if (request && isInternalCanvasWorkerRequest(request)) {
    const internalApiKeyId = String(headers['x-yali-internal-api-key-id'] || '').trim();
    const internalTenantId = String(headers['x-yali-internal-tenant-id'] || '').trim();
    if (internalApiKeyId) {
      const catalogIndex = adminConsoleCatalogStore.getRuntimeIndex();
      const apiKey = catalogIndex.activeApiKeyById.get(internalApiKeyId) || null;
      if (!apiKey) {
        return {
          granted: false,
          statusCode: 401,
          error: 'invalid_internal_api_key',
          message: 'The internal canvas API key context is invalid or has been disabled.',
        };
      }
      const tenant = catalogIndex.tenantById.get(apiKey.tenantId) || null;
      if (!tenant || tenant.status !== 'active') {
        return {
          granted: false,
          statusCode: 403,
          error: 'internal_tenant_inactive',
          message: 'The tenant associated with this internal canvas API key is inactive.',
        };
      }
      if (internalTenantId && internalTenantId !== tenant.id) {
        return {
          granted: false,
          statusCode: 403,
          error: 'internal_tenant_mismatch',
          message: 'The internal canvas tenant context does not match the API key tenant.',
        };
      }
      const channelAllowed = apiKey.allowedChannelIds.includes(imageChannelId)
        && tenant.allowedChannelIds.includes(imageChannelId);
      if (!channelAllowed) {
        return {
          granted: false,
          statusCode: 403,
          error: 'channel_not_allowed',
          message: 'This internal canvas API key does not have access to the image generation channel.',
        };
      }
      return {
        granted: true,
        context: {
          tenantId: tenant.id,
          apiKeyId: apiKey.id,
          authMode: 'tenant_key',
          imageRoutingMode: apiKey.imageRoutingMode || 'smart_failover',
          fixedImageProviderId: apiKey.imageRoutingMode === 'fixed_provider'
            ? normalizeFixedImageProviderIds(apiKey.fixedImageProviderIds, apiKey.fixedImageProviderId)[0] || ''
            : '',
          fixedImageProviderIds: apiKey.imageRoutingMode === 'fixed_provider'
            ? normalizeFixedImageProviderIds(apiKey.fixedImageProviderIds, apiKey.fixedImageProviderId)
            : [],
          fixedImageFlatPrice: apiKey.imageRoutingMode === 'fixed_provider'
            ? Math.max(0, Number(apiKey.fixedImageFlatPrice || 0))
            : 0,
          maxImageQuality: normalizeImageQualityCap(apiKey.maxImageQuality),
          maxConcurrency: Math.max(1, Number(apiKey.maxConcurrency || 10)),
          tenantRequestLimitPerMinute: Number(tenant.requestLimitPerMinute || 0),
          requestLimitPerMinute: Number(apiKey.requestLimitPerMinute || 0),
          downstreamImageApiType: apiKey.downstreamImageApiType || 'openai_images',
          bananaAllowedModels: apiKey.bananaAllowedModels || [],
          bananaAllowedImageSizes: apiKey.bananaAllowedImageSizes || [],
        },
      };
    }
    return {
      granted: true,
      context: {
        tenantId: 'canvas-worker',
        apiKeyId: 'canvas-worker',
        authMode: 'admin_managed',
        imageRoutingMode: payload.routing_mode === 'smart_priority' || payload.routing_mode === 'smart_failover'
          ? payload.routing_mode
          : 'smart_failover',
      },
    };
  }

  // user_supplied: 用户自带上游密钥，不走平台鉴权
  if (payload.provider_source === 'user_supplied') {
    if (!controlPlane.routing.allowUserSuppliedKey) {
      return {
        granted: false,
        statusCode: 403,
        error: 'user_supplied_provider_disabled',
        message: 'User supplied upstream keys are disabled by the platform.',
      };
    }
    return {
      granted: true,
      context: {
        tenantId: 'user-supplied',
        apiKeyId: 'user-supplied',
        authMode: 'user_supplied',
        imageRoutingMode: payload.routing_mode === 'smart_priority' || payload.routing_mode === 'smart_failover'
          ? payload.routing_mode
          : 'smart_failover',
      },
    };
  }

  // disabled: 平台不启用鉴权，所有请求以 admin_managed 身份放行
  if (authPolicy === 'disabled') {
    return {
      granted: true,
      context: {
        tenantId: 'admin-managed',
        apiKeyId: 'admin-managed',
        authMode: 'admin_managed',
        imageRoutingMode: payload.routing_mode === 'smart_priority' || payload.routing_mode === 'smart_failover'
          ? payload.routing_mode
          : 'smart_failover',
      },
    };
  }

  const token = parseBearerToken(headers.authorization) || String(headers['x-api-key'] || '').trim();

  // admin_key: 只要携带了任意 token 即放行（管理员自行控制密钥分发）
  if (authPolicy === 'admin_key') {
    if (!token) {
      return {
        granted: false,
        statusCode: 401,
        error: 'auth_required',
        message: 'API key is required. Provide a Bearer token or X-API-Key header.',
      };
    }
    return {
      granted: true,
      context: {
        tenantId: 'admin-managed',
        apiKeyId: 'admin-managed',
        authMode: 'admin_managed',
        imageRoutingMode: payload.routing_mode === 'smart_priority' || payload.routing_mode === 'smart_failover'
          ? payload.routing_mode
          : 'smart_failover',
      },
    };
  }

  // tenant_key: 必须匹配到有效的租户 API Key
  if (!token) {
    return {
      granted: false,
      statusCode: 401,
      error: 'auth_required',
      message: 'API key is required. Provide a Bearer token or X-API-Key header.',
    };
  }

  const catalogIndex = adminConsoleCatalogStore.getRuntimeIndex();
  let apiKey = catalogIndex.activeApiKeyByRawKey.get(token) || null;
  if (!apiKey) {
    const hash = crypto.createHash('sha256').update(token).digest('hex');
    apiKey = catalogIndex.activeApiKeyByHash.get(hash) || null;
  }
  if (!apiKey) {
    return {
      granted: false,
      statusCode: 401,
      error: 'invalid_api_key',
      message: 'The provided API key is invalid or has been disabled.',
    };
  }

  const tenant = catalogIndex.tenantById.get(apiKey.tenantId) || null;
  if (!tenant || tenant.status !== 'active') {
    return {
      granted: false,
      statusCode: 403,
      error: 'tenant_inactive',
      message: 'The tenant associated with this API key is inactive.',
    };
  }

  const channelAllowed = apiKey.allowedChannelIds.includes(imageChannelId)
    && tenant.allowedChannelIds.includes(imageChannelId);
  if (!channelAllowed) {
    return {
      granted: false,
      statusCode: 403,
      error: 'channel_not_allowed',
      message: 'This API key does not have access to the image generation channel.',
    };
  }

  return {
    granted: true,
    context: {
      tenantId: tenant.id,
      apiKeyId: apiKey.id,
      authMode: 'tenant_key',
      imageRoutingMode: apiKey.imageRoutingMode || 'smart_failover',
      fixedImageProviderId: apiKey.imageRoutingMode === 'fixed_provider'
        ? normalizeFixedImageProviderIds(apiKey.fixedImageProviderIds, apiKey.fixedImageProviderId)[0] || ''
        : '',
      fixedImageProviderIds: apiKey.imageRoutingMode === 'fixed_provider'
        ? normalizeFixedImageProviderIds(apiKey.fixedImageProviderIds, apiKey.fixedImageProviderId)
        : [],
      fixedImageFlatPrice: apiKey.imageRoutingMode === 'fixed_provider'
        ? Math.max(0, Number(apiKey.fixedImageFlatPrice || 0))
        : 0,
      maxImageQuality: normalizeImageQualityCap(apiKey.maxImageQuality),
      maxConcurrency: Math.max(1, Number(apiKey.maxConcurrency || 10)),
      tenantRequestLimitPerMinute: Number(tenant.requestLimitPerMinute || 0),
      requestLimitPerMinute: Number(apiKey.requestLimitPerMinute || 0),
      downstreamImageApiType: apiKey.downstreamImageApiType || 'openai_images',
      bananaAllowedModels: apiKey.bananaAllowedModels || [],
      bananaAllowedImageSizes: apiKey.bananaAllowedImageSizes || [],
    },
  };
}

function resolveRequestedImageSize(payload: z.infer<typeof openAIImagesSchema>) {
  const normalized = String(payload.size || '').trim();
  return normalized || undefined;
}

function resolveRequestedImageTier(payload: z.infer<typeof openAIImagesSchema>): ResolutionTier | 'auto' | undefined {
  const compatibleResolution = normalizeCompatibleResolutionMode(
    payload.resolution || payload.metadata?.yali_requested_resolution,
  );
  if (compatibleResolution) {
    return compatibleResolution;
  }
  const requestedSize = resolveRequestedImageSize(payload);
  if (!requestedSize) {
    return undefined;
  }
  if (requestedSize.toLowerCase() === 'auto') {
    return 'auto';
  }
  return classifyResolutionTier(requestedSize || '') || undefined;
}

type EffectiveRoutingMode = ImageRoutingMode | 'fixed_provider_pool';

type UpstreamImageRequestPlan = {
  url: string;
  method: 'POST';
  headers: Record<string, string>;
  body: Record<string, unknown>;
  bodyFormat: 'json' | 'multipart';
  multipartFileNames?: Record<string, string[]>;
  multipartFileSources?: Record<string, MultipartImageSource[]>;
};

async function preparePayloadAndRequestPlanForProvider(input: {
  request: any;
  payload: z.infer<typeof openAIImagesSchema>;
  provider: ProviderConfig;
  operation: 'generations' | 'edits';
  asyncTaskAssetDirectory?: string;
  asyncTaskImageAssets?: AsyncTaskImageAsset[];
}) {
  let payload = await adaptPayloadForProvider({
    request: input.request,
    payload: input.payload,
    provider: input.provider,
  });
  let requestPlan = await buildImageRequestPlanForProvider(input.provider, input.operation, payload) as UpstreamImageRequestPlan;
  const multipartSources = imageFileSourcesForPayload({
    request: input.request,
    payload,
    asyncTaskAssetDirectory: input.asyncTaskAssetDirectory,
    asyncTaskImageAssets: input.asyncTaskImageAssets,
  });

  // Multipart sources stay as files for multipart upstreams. Other protocols
  // materialize them only when their JSON body is actually selected.
  if (multipartSources?.length && requestPlan.bodyFormat !== 'multipart') {
    const materializedPayload = await materializeImageFileSources(
      input.payload,
      multipartSources,
      input.asyncTaskAssetDirectory ? 'async task image asset' : 'multipart input spool image',
    );
    payload = await adaptPayloadForProvider({
      request: input.request,
      payload: materializedPayload,
      provider: input.provider,
    });
    requestPlan = await buildImageRequestPlanForProvider(input.provider, input.operation, payload) as UpstreamImageRequestPlan;
  } else if (multipartSources?.length) {
    requestPlan = {
      ...requestPlan,
      multipartFileSources: {
        ...(requestPlan.multipartFileSources || {}),
        image: multipartSources,
      },
    };
  }

  return { payload, requestPlan };
}

type RoutedImageExecutionCandidate = {
  provider: ProviderConfig;
  requestPlan?: UpstreamImageRequestPlan;
  payload?: z.infer<typeof openAIImagesSchema>;
  prepare?: () => Promise<{
    payload: z.infer<typeof openAIImagesSchema>;
    requestPlan: UpstreamImageRequestPlan;
  }>;
  score?: number;
  reasons?: string[];
  passiveRecoveryReentry?: boolean;
};

type PreparedRoutedImageExecutionCandidate = RoutedImageExecutionCandidate & {
  requestPlan: UpstreamImageRequestPlan;
  payload: z.infer<typeof openAIImagesSchema>;
};

async function prepareRoutedImageExecutionCandidate(
  candidate: RoutedImageExecutionCandidate,
): Promise<PreparedRoutedImageExecutionCandidate> {
  if (candidate.payload && candidate.requestPlan) {
    return candidate as PreparedRoutedImageExecutionCandidate;
  }
  if (!candidate.prepare) {
    throw new Error(`Missing upstream request preparation for provider ${candidate.provider.providerId}.`);
  }
  const prepared = await candidate.prepare();
  candidate.payload = prepared.payload;
  candidate.requestPlan = prepared.requestPlan;
  candidate.prepare = undefined;
  return candidate as PreparedRoutedImageExecutionCandidate;
}

type RoutedProviderAttemptTrace = {
  provider_id: string;
  provider_name?: string;
  provider_base_url?: string;
  protocol?: string;
  status: 'success' | 'failed';
  status_code?: number;
  failure_category?: string;
  should_failover?: boolean;
  duration_ms: number;
  started_at: string;
  completed_at: string;
  reasons?: string[];
  score?: number;
  same_provider_retry_attempt?: number;
  same_provider_retry_limit?: number;
};

type RoutedImageExecutionPreview = {
  mode: EffectiveRoutingMode;
  plan?: SmartImageRoutingPlan;
  candidates: RoutedImageExecutionCandidate[];
  filteredOut: Array<{ providerId: string; reason: string }>;
};

function mapLegacyRoutingModeToSmartMode(mode?: string): EffectiveRoutingMode {
  switch (String(mode || '').trim()) {
    case 'smart_priority':
      return 'smart_priority';
    case 'fixed_provider':
      return 'fixed_provider';
    case 'health_weighted_best':
    case 'least_recently_used':
    case 'weighted_round_robin':
      return 'smart_priority';
    case 'smart_failover':
    case 'priority_failover':
    case 'round_robin_failover':
    default:
      return 'smart_failover';
  }
}

function resolveEffectiveImageRoutingMode(input: {
  payload: z.infer<typeof openAIImagesSchema>;
  accessContext: RequestAccessContext;
}) {
  if (input.payload.provider_source === 'user_supplied') {
    const mode = mapLegacyRoutingModeToSmartMode(input.payload.routing_mode);
    return mode === 'fixed_provider' ? 'smart_failover' : mode;
  }
  if (input.accessContext.authMode === 'tenant_key') {
    if (input.accessContext.imageRoutingMode === 'fixed_provider') {
      const fixedProviderIds = normalizeFixedImageProviderIds(
        input.accessContext.fixedImageProviderIds,
        input.accessContext.fixedImageProviderId,
      );
      return fixedProviderIds.length > 1 ? 'fixed_provider_pool' : 'fixed_provider';
    }
    return input.accessContext.imageRoutingMode || 'smart_failover';
  }
  if (input.payload.routing_mode === 'smart_priority' || input.payload.routing_mode === 'smart_failover') {
    return input.payload.routing_mode;
  }
  return input.accessContext.imageRoutingMode || mapLegacyRoutingModeToSmartMode(input.payload.routing_mode);
}

function shouldStopAfterFirstProviderAttempt(mode: EffectiveRoutingMode) {
  return mode === 'smart_priority' || mode === 'fixed_provider';
}

const maxSoleProviderRetries = 3;

function canRetrySoleProvider(mode: EffectiveRoutingMode, candidateCount: number) {
  return candidateCount === 1 && (
    mode === 'smart_failover'
    || mode === 'smart_priority'
    || mode === 'fixed_provider'
    || mode === 'fixed_provider_pool'
  );
}

function normalizeFixedImageProviderIds(value?: unknown, legacyValue?: unknown) {
  const values = Array.isArray(value) ? value : [];
  const normalized = values
    .map((item) => String(item || '').trim())
    .filter(Boolean);
  const legacyId = String(legacyValue || '').trim();
  if (legacyId && !normalized.includes(legacyId)) {
    normalized.unshift(legacyId);
  }
  return Array.from(new Set(normalized));
}

function isSameProviderRetryableFailure(failure: { category: string; shouldFailover: boolean }) {
  if (!failure.shouldFailover) {
    return false;
  }
  return [
    'retryable_transport',
    'retryable_timeout',
    'retryable_gateway',
    'retryable_overloaded',
    'retryable_rate_limit',
    'retryable_status',
  ].includes(failure.category);
}

function waitBeforeSoleProviderRetry(retryAttempt: number) {
  const delayMs = Math.min(1_000, 250 * (2 ** Math.max(0, retryAttempt - 1)));
  return new Promise<void>((resolve) => setTimeout(resolve, delayMs));
}

async function claimPassiveRecoveryReentry(providerId: string) {
  const key = `provider:${providerId}:passive-recovery-reentry`;
  if (hotStateAtomicCounters) {
    try {
      return (await hotStateAtomicCounters.acquireConcurrency(key, 1, passiveRecoveryReentryIntervalSeconds)).allowed;
    } catch (error) {
      if (sharedHotStateStrict) {
        throw createSharedHotStateUnavailableError('passive_recovery_reentry_claim');
      }
      requestLogWarn('redis_passive_recovery_reentry_claim_fallback', error);
    }
  }
  // Keep the lease until TTL expiry. It is a frequency gate, not in-flight concurrency.
  return concurrencyService.acquire(key, 1, passiveRecoveryReentryIntervalSeconds).allowed;
}

async function promotePassiveRecoveryReentry(input: {
  mode: EffectiveRoutingMode;
  asyncRequest: boolean;
  plan: SmartImageRoutingPlan;
  candidates: RoutedImageExecutionCandidate[];
}) {
  if (
    input.asyncRequest
    || (input.mode !== 'smart_failover' && input.mode !== 'fixed_provider_pool')
    || input.candidates.length < 2
  ) {
    return;
  }
  const eligible = input.candidates
    .map((candidate, index) => ({ candidate, index }))
    .filter((item) => item.index > 0 && isPassiveRecoveryReentryProvider(item.candidate.provider))
    .sort((left, right) => {
      const leftAge = Number((left.candidate.provider.metadata?.runtime as { healthEvidenceAgeMs?: unknown } | undefined)?.healthEvidenceAgeMs || 0);
      const rightAge = Number((right.candidate.provider.metadata?.runtime as { healthEvidenceAgeMs?: unknown } | undefined)?.healthEvidenceAgeMs || 0);
      return rightAge - leftAge || left.index - right.index;
    });

  for (const item of eligible) {
    if (!await claimPassiveRecoveryReentry(item.candidate.provider.providerId)) {
      continue;
    }
    const reentryReason = 'passive_recovery_reentry';
    item.candidate.reasons = [...(item.candidate.reasons || []), reentryReason];
    item.candidate.passiveRecoveryReentry = true;
    input.candidates.splice(item.index, 1);
    input.candidates.unshift(item.candidate);

    const planIndex = input.plan.candidates.findIndex((candidate) => candidate.provider.providerId === item.candidate.provider.providerId);
    if (planIndex >= 0) {
      const [planCandidate] = input.plan.candidates.splice(planIndex, 1);
      if (planCandidate) {
        planCandidate.reasons.push(reentryReason);
        input.plan.candidates.unshift(planCandidate);
      }
    }
    return;
  }
}

function buildApiKeyConcurrencyKey(accessContext: RequestAccessContext) {
  if (accessContext.authMode !== 'tenant_key' || !accessContext.apiKeyId) {
    return null;
  }
  return `api-key:${accessContext.apiKeyId}:image`;
}

type RuntimeConcurrencyLease = {
  key: string;
  ttlSeconds: number;
  backend: 'redis_lease' | 'local_counter';
  leaseId?: string;
  heartbeat?: ReturnType<typeof setInterval>;
  released?: boolean;
};

const runtimeConcurrencyLeaseTtlSeconds = 90;

async function renewRuntimeConcurrencyLease(lease: RuntimeConcurrencyLease) {
  if (lease.released) {
    return false;
  }
  if (lease.backend === 'redis_lease' && lease.leaseId && hotStateAtomicCounters) {
    const result = await hotStateAtomicCounters.renewConcurrencyLease({
      key: lease.key,
      leaseId: lease.leaseId,
      ttlSeconds: lease.ttlSeconds,
    });
    return result.allowed;
  }
  return Boolean(concurrencyService.renew(lease.key, lease.ttlSeconds));
}

function startRuntimeConcurrencyLeaseHeartbeat(lease: RuntimeConcurrencyLease) {
  const intervalMs = Math.max(5_000, Math.floor(lease.ttlSeconds * 1000 / 3));
  lease.heartbeat = setInterval(() => {
    void renewRuntimeConcurrencyLease(lease).then((renewed) => {
      if (!renewed && !lease.released) {
        requestLogWarn('runtime_concurrency_lease_renew_lost', { key: lease.key });
      }
    }).catch((error) => {
      // Existing work may finish while Redis is briefly unavailable. New work
      // remains protected by strict shared-state admission on its next claim.
      requestLogWarn('runtime_concurrency_lease_renew_failed', error);
    });
  }, intervalMs);
  lease.heartbeat.unref?.();
  return lease;
}

async function acquireRuntimeConcurrencyLease(
  key: string,
  max: number,
  ttlSeconds = runtimeConcurrencyLeaseTtlSeconds,
  forceLocal = false,
) {
  const normalizedMax = Math.max(1, Math.floor(max));
  const normalizedTtlSeconds = Math.max(5, Math.floor(ttlSeconds));
  if (hotStateAtomicCounters && !forceLocal) {
    const result = await hotStateAtomicCounters.acquireConcurrencyLease(key, normalizedMax, normalizedTtlSeconds);
    const lease = result.lease
      ? startRuntimeConcurrencyLeaseHeartbeat({
          key,
          ttlSeconds: normalizedTtlSeconds,
          backend: 'redis_lease',
          leaseId: result.lease.leaseId,
        })
      : null;
    return { allowed: result.allowed, key: lease, state: result.state };
  }
  const result = concurrencyService.acquire(key, normalizedMax, normalizedTtlSeconds);
  const lease = result.allowed
    ? startRuntimeConcurrencyLeaseHeartbeat({
        key,
        ttlSeconds: normalizedTtlSeconds,
        backend: 'local_counter',
      })
    : null;
  return { allowed: result.allowed, key: lease, state: result.state };
}

async function releaseRuntimeConcurrencyLease(lease: RuntimeConcurrencyLease | null, forceLocal = false) {
  if (!lease) {
    return;
  }
  lease.released = true;
  if (lease.heartbeat) {
    clearInterval(lease.heartbeat);
  }
  if (lease.backend === 'redis_lease' && lease.leaseId && hotStateAtomicCounters && !forceLocal) {
    await hotStateAtomicCounters.releaseConcurrencyLease({
      key: lease.key,
      leaseId: lease.leaseId,
      ttlSeconds: lease.ttlSeconds,
    });
    return;
  }
  concurrencyService.release(lease.key, Math.min(120, lease.ttlSeconds));
}

async function acquireApiKeyConcurrency(accessContext: RequestAccessContext) {
  const key = buildApiKeyConcurrencyKey(accessContext);
  if (!key || !accessContext.maxConcurrency) {
    return { allowed: true as const, key: null as RuntimeConcurrencyLease | null };
  }
  const max = Math.max(1, Number(accessContext.maxConcurrency || 1));
  if (hotStateAtomicCounters) {
    try {
      const result = await acquireRuntimeConcurrencyLease(key, max);
      return {
        allowed: result.allowed,
        key: result.key,
        state: result.state,
      };
    } catch (error) {
      if (sharedHotStateStrict) {
        throw createSharedHotStateUnavailableError('api_key_concurrency_acquire');
      }
      requestLogWarn('redis_atomic_api_key_concurrency_fallback', error);
    }
  }
  const result = await acquireRuntimeConcurrencyLease(key, max, runtimeConcurrencyLeaseTtlSeconds, true);
  return {
    allowed: result.allowed,
    key: result.key,
    state: result.state,
  };
}

function buildApiKeyRateLimitKey(accessContext: RequestAccessContext) {
  if (accessContext.authMode !== 'tenant_key' || !accessContext.apiKeyId) {
    return null;
  }
  return `api-key:${accessContext.apiKeyId}:image:rpm`;
}

function buildTenantRateLimitKey(accessContext: RequestAccessContext) {
  if (accessContext.authMode !== 'tenant_key' || !accessContext.tenantId) {
    return null;
  }
  return `tenant:${accessContext.tenantId}:image:rpm`;
}

function buildGlobalImageRateLimitKey() {
  return 'global:image:rpm';
}

function buildGlobalImageConcurrencyKey() {
  return 'global:image:concurrency';
}

function inspectImageRateLimitAllowance(key: string | null, limit: number, windowSeconds: number) {
  if (!key || limit <= 0) {
    return {
      allowed: true,
      state: null,
    };
  }
  const now = Date.now();
  const current = rateLimitService.inspect(key);
  const windowMs = windowSeconds * 1000;
  const nextCount = !current || current.windowEndsAt <= now
    ? 1
    : Number(current.requestCount || 0) + 1;
  const blocked = Boolean(current?.blockedUntil && current.blockedUntil > now);
  return {
    allowed: !blocked && nextCount <= limit,
    state: current,
    nextCount,
    windowEndsAt: current?.windowEndsAt ?? (now + windowMs),
  };
}

async function consumeImageRateLimits(accessContext: RequestAccessContext) {
  const controlPlane = adminControlPlaneStore.get();
  const globalLimit = Math.max(0, Number(controlPlane.publicApi.rateLimitPerMinute || 0));
  const tenantLimit = Math.max(0, Number(accessContext.tenantRequestLimitPerMinute || 0));
  const apiKeyLimit = Math.max(0, Number(accessContext.requestLimitPerMinute || 0));
  const globalKey = buildGlobalImageRateLimitKey();
  const tenantKey = buildTenantRateLimitKey(accessContext);
  const apiKeyKey = buildApiKeyRateLimitKey(accessContext);

  if (hotStateAtomicCounters) {
    try {
      if (globalLimit > 0) {
        const globalResult = await hotStateAtomicCounters.consumeRateLimit(globalKey, globalLimit, 60);
        if (!globalResult.allowed) {
          return {
            allowed: false as const,
            scope: 'global' as const,
            limit: globalLimit,
            state: globalResult.state,
          };
        }
      }
      const result = await hotStateAtomicCounters.consumeDualRateLimit({
        tenantKey,
        tenantLimit,
        apiKeyKey,
        apiKeyLimit,
        windowSeconds: 60,
      });
      if (!result.allowed) {
        const scope = result.scope || 'api_key';
        return {
          allowed: false as const,
          scope,
          limit: scope === 'tenant' ? tenantLimit : apiKeyLimit,
          state: result.state,
        };
      }
      return {
        allowed: true as const,
        scope: null,
        limit: 0,
        state: null,
      };
    } catch (error) {
      if (sharedHotStateStrict) {
        throw createSharedHotStateUnavailableError('image_rate_limit_consume');
      }
      requestLogWarn('redis_atomic_rate_limit_fallback', error);
    }
  }

  const globalPreview = inspectImageRateLimitAllowance(globalKey, globalLimit, 60);
  if (!globalPreview.allowed) {
    return {
      allowed: false as const,
      scope: 'global' as const,
      limit: globalLimit,
      state: globalPreview.state,
    };
  }

  const tenantPreview = inspectImageRateLimitAllowance(tenantKey, tenantLimit, 60);
  if (!tenantPreview.allowed) {
    return {
      allowed: false as const,
      scope: 'tenant' as const,
      limit: tenantLimit,
      state: tenantPreview.state,
    };
  }

  const apiKeyPreview = inspectImageRateLimitAllowance(apiKeyKey, apiKeyLimit, 60);
  if (!apiKeyPreview.allowed) {
    return {
      allowed: false as const,
      scope: 'api_key' as const,
      limit: apiKeyLimit,
      state: apiKeyPreview.state,
    };
  }

  if (globalLimit > 0) {
    rateLimitService.consume(globalKey, globalLimit, 60);
  }
  if (tenantKey && tenantLimit > 0) {
    rateLimitService.consume(tenantKey, tenantLimit, 60);
  }
  if (apiKeyKey && apiKeyLimit > 0) {
    rateLimitService.consume(apiKeyKey, apiKeyLimit, 60);
  }

  return {
    allowed: true as const,
    scope: null,
    limit: 0,
    state: null,
  };
}

async function releaseApiKeyConcurrency(lease: RuntimeConcurrencyLease | null) {
  if (!lease) {
    return;
  }
  if (hotStateAtomicCounters) {
    try {
      await releaseRuntimeConcurrencyLease(lease);
      return;
    } catch (error) {
      requestLogWarn('redis_atomic_api_key_concurrency_release_fallback', error);
    }
  }
  await releaseRuntimeConcurrencyLease(lease, true);
}

async function acquireGlobalImageConcurrency() {
  const controlPlane = adminControlPlaneStore.get();
  const max = Math.max(0, Math.floor(Number(controlPlane.publicApi.maxConcurrency || 0)));
  if (max <= 0) {
    return { allowed: true as const, key: null as RuntimeConcurrencyLease | null };
  }
  const key = buildGlobalImageConcurrencyKey();
  if (hotStateAtomicCounters) {
    try {
      const result = await acquireRuntimeConcurrencyLease(key, max);
      return {
        allowed: result.allowed,
        key: result.key,
        state: result.state,
        max,
      };
    } catch (error) {
      if (sharedHotStateStrict) {
        throw createSharedHotStateUnavailableError('global_image_concurrency_acquire');
      }
      requestLogWarn('redis_atomic_global_image_concurrency_fallback', error);
    }
  }
  const result = await acquireRuntimeConcurrencyLease(key, max, runtimeConcurrencyLeaseTtlSeconds, true);
  return {
    allowed: result.allowed,
    key: result.key,
    state: result.state,
    max,
  };
}

async function acquireAsyncQueueAdmission() {
  const key = 'system:image-async-queue-admission';
  if (hotStateAtomicCounters) {
    const result = await hotStateAtomicCounters.acquireConcurrency(key, 1, 120);
    return { allowed: result.allowed, key };
  }
  return { ...concurrencyService.acquire(key, 1, 120), key };
}

async function releaseAsyncQueueAdmission(key: string) {
  if (hotStateAtomicCounters) {
    await hotStateAtomicCounters.releaseConcurrency(key, 120);
    return;
  }
  concurrencyService.release(key, 120);
}

function dynamicOverloadSnapshot() {
  return dynamicOverloadGuard.getSnapshot(adminControlPlaneStore.get().publicApi);
}

function isDynamicOverloadProtectionActive() {
  return dynamicOverloadGuard.shouldReject(adminControlPlaneStore.get().publicApi);
}

function dynamicOverloadError() {
  const snapshot = dynamicOverloadSnapshot();
  return imageEndpointError({
    code: 'server_overloaded',
    message: 'The image API is temporarily overloaded. Please retry shortly.',
    statusCode: 429,
    failureCategory: 'retryable_overloaded',
    details: {
      reasons: snapshot.reasons,
      retry_after_seconds: 5,
    },
  });
}

async function buildCanvasUserSessionPayload(input: {
  user: CanvasUserRecord;
  rawApiKey?: string;
}) {
  const catalog = await adminConsoleCatalogStore.refreshAsync();
  const apiKey = input.user.apiKeyId
    ? (catalog.apiKeys.find((item) => item.id === input.user.apiKeyId) || null)
    : null;
  const balance = await operationalRepository.getTenantFinanceBalance(input.user.tenantId, 'cny');
  return buildCanvasUserSafePayload({
    user: input.user,
    rawApiKey: input.rawApiKey,
    apiKey,
    tenantBalanceCents: Number(balance?.balanceCents || 0),
  });
}

async function releaseGlobalImageConcurrency(lease: RuntimeConcurrencyLease | null) {
  if (!lease) {
    return;
  }
  if (hotStateAtomicCounters) {
    try {
      await releaseRuntimeConcurrencyLease(lease);
      return;
    } catch (error) {
      requestLogWarn('redis_atomic_global_image_concurrency_release_fallback', error);
    }
  }
  await releaseRuntimeConcurrencyLease(lease, true);
}

async function releaseImageConcurrency(apiKeyConcurrencyKey: RuntimeConcurrencyLease | null, globalConcurrencyKey: RuntimeConcurrencyLease | null) {
  await Promise.all([
    releaseApiKeyConcurrency(apiKeyConcurrencyKey),
    releaseGlobalImageConcurrency(globalConcurrencyKey),
  ]);
}

async function acquireAsyncTaskClaim(taskId: string) {
  const key = `async:image:claim:${taskId}`;
  if (hotStateAtomicCounters) {
    try {
      const result = await hotStateAtomicCounters.acquireConcurrency(key, 1, asyncImageTaskClaimTtlSeconds);
      return {
        allowed: result.allowed,
        key,
      };
    } catch (error) {
      if (sharedHotStateStrict) {
        throw createSharedHotStateUnavailableError('async_task_claim_acquire');
      }
      requestLogWarn('redis_atomic_async_task_claim_fallback', error);
    }
  }
  const result = concurrencyService.acquire(key, 1, asyncImageTaskClaimTtlSeconds);
  return {
    allowed: result.allowed,
    key,
  };
}

async function releaseAsyncTaskClaim(key: string | null) {
  if (!key) {
    return;
  }
  if (hotStateAtomicCounters) {
    try {
      await hotStateAtomicCounters.releaseConcurrency(key, 30);
      return;
    } catch (error) {
      requestLogWarn('redis_atomic_async_task_claim_release_fallback', error);
    }
  }
  concurrencyService.release(key, 30);
}

async function inspectAsyncQueueState(accessContext: RequestAccessContext) {
  const now = Date.now();
  const queuedTasks = (await listQueuedImageTasks()).filter((task) => (
    !(Number(task.queue_expires_at || 0) > 0 && Number(task.queue_expires_at || 0) <= now)
  ));
  const apiKeyQueuedCount = queuedTasks.filter((task) => {
    const internal = readQueuedTaskInternalState(task);
    return internal?.accessContext.apiKeyId === accessContext.apiKeyId;
  }).length;
  return {
    queuedTasks,
    totalQueuedCount: queuedTasks.length,
    apiKeyQueuedCount,
  };
}

async function finalizeAsyncSubmissionTrace(completion: Parameters<typeof appendRequestTrace>[0]) {
  const taskId = String(completion.taskId || completion.requestId || '').trim();
  if (!taskId) {
    await appendRequestTrace(completion);
    return;
  }
  const traceId = `trace_${taskId}_submit`;
  const updated = await updateRequestTrace(traceId, {
    ...completion,
    traceId,
    source: 'tenant_runtime_async_submit',
    tags: ['runtime', 'async', 'submit', 'completion'],
  });
  if (!updated) {
    await appendRequestTrace({
      ...completion,
      traceId,
      tags: ['runtime', 'async', 'completion'],
    });
  }
}

async function failQueuedImageTask(input: {
  task: ImageGatewayTaskState;
  requestHeaders: Record<string, string>;
  payload: z.infer<typeof openAIImagesSchema>;
  accessContext: RequestAccessContext;
  operation: 'generations' | 'edits';
  errorPayload: Record<string, unknown>;
}) {
  const request = buildSyntheticQueuedRequest(input.requestHeaders);
  const internal = readQueuedTaskInternalState(input.task);
  input.task.status = 'failed';
  input.task.error = input.errorPayload;
  input.task.updated_at = Date.now();
  await setImageTaskState(input.task.task_id, input.task, imageTaskHotTtlSeconds);
  void upsertTaskRecord({
    taskId: input.task.task_id,
    requestId: input.task.task_id,
    tenantId: input.accessContext.tenantId,
    apiKeyId: input.accessContext.apiKeyId,
    channelId: imageChannelId,
    upstreamId: input.task.provider_id,
    operation: input.operation,
    status: 'failed',
    providerId: input.task.provider_id,
    model: input.payload.model,
    promptPreview: input.payload.prompt.slice(0, 120),
    createdAt: input.task.created_at,
    updatedAt: input.task.updated_at,
    completedAt: input.task.updated_at,
    requestPayload: { payload: input.payload, operation: input.operation },
    responsePayload: {
      resolutionAudit: await buildImageResolutionAuditRecord({
        requestPayload: {
          size: input.payload.size,
          resolution: input.payload.size,
          aspect_ratio: input.payload.size,
        },
        responsePayload: null,
      }),
    },
    errorPayload: input.errorPayload,
  });
  void finalizeAsyncSubmissionTrace({
    source: 'tenant_runtime_async_complete',
    scope: 'full_chain',
    status: 'failed',
    summary: summarizeTrace(input.operation, Number(input.errorPayload.status_code || 0) || undefined, false),
    requestId: input.task.task_id,
    taskId: input.task.task_id,
    tenantId: input.accessContext.tenantId,
    apiKeyId: input.accessContext.apiKeyId,
    channelId: imageChannelId,
    upstreamId: input.task.provider_id,
    operation: input.operation,
    downstreamRequest: {
      headers: request.headers,
      payload: input.payload,
    },
    downstreamResponse: {
      task_id: input.task.task_id,
      status: 'failed',
    },
    upstreamRequest: input.task.request_plan as Record<string, unknown>,
    upstreamResponse: null,
    errorPayload: input.errorPayload,
    tags: ['runtime', 'async', 'completion'],
  });
  if (internal?.assetDirectory) {
    await fs.rm(internal.assetDirectory, { recursive: true, force: true }).catch((error) => {
      requestLogWarn('async_task_asset_cleanup_failed', error);
    });
  }
}

function resolveProviderConcurrencyMax(provider: ProviderConfig) {
  const raw = provider.metadata?.max_concurrency
    ?? provider.metadata?.provider_max_concurrency
    ?? provider.metadata?.upstream_max_concurrency;
  const value = Number(raw || 0);
  if (!Number.isFinite(value) || value <= 0) {
    return 10;
  }
  return Math.max(1, Math.floor(value));
}

async function acquireProviderConcurrency(provider: ProviderConfig, _ttlMs: number) {
  const max = resolveProviderConcurrencyMax(provider);
  if (!max) {
    return { allowed: true as const, key: null as RuntimeConcurrencyLease | null };
  }
  const key = `provider:${provider.providerId}`;
  // A short lease plus heartbeat recovers abandoned slots quickly while still
  // allowing the configured upstream timeout to run to completion.
  const ttlSeconds = runtimeConcurrencyLeaseTtlSeconds;
  if (hotStateAtomicCounters) {
    try {
      const result = await acquireRuntimeConcurrencyLease(key, max, ttlSeconds);
      return {
        allowed: result.allowed,
        key: result.key,
        state: result.state,
        max,
      };
    } catch (error) {
      if (sharedHotStateStrict) {
        throw createSharedHotStateUnavailableError('provider_concurrency_acquire');
      }
      requestLogWarn('redis_atomic_provider_concurrency_fallback', error);
    }
  }
  const result = await acquireRuntimeConcurrencyLease(key, max, ttlSeconds, true);
  return {
    allowed: result.allowed,
    key: result.key,
    state: result.state,
    max,
  };
}

async function releaseProviderConcurrency(lease: RuntimeConcurrencyLease | null) {
  if (!lease) {
    return;
  }
  if (hotStateAtomicCounters) {
    try {
      await releaseRuntimeConcurrencyLease(lease);
      return;
    } catch (error) {
      requestLogWarn('redis_atomic_provider_concurrency_release_fallback', error);
    }
  }
  await releaseRuntimeConcurrencyLease(lease, true);
}

function resolveProviderRequestTimeoutMs(provider: ProviderConfig) {
  const configuredMs = Number(provider.metadata?.request_timeout_ms || provider.metadata?.upstream_request_timeout_ms || 0);
  if (configuredMs > 0) {
    return Math.max(1000, Math.min(30 * 60_000, configuredMs));
  }
  const configuredSeconds = Number(provider.metadata?.request_timeout_seconds || provider.metadata?.upstream_request_timeout_seconds || 0);
  if (configuredSeconds > 0) {
    return Math.max(1000, Math.min(30 * 60_000, configuredSeconds * 1000));
  }
  const envMs = Number(process.env.IMAGE_UPSTREAM_TIMEOUT_MS || 0);
  if (envMs > 0) {
    return Math.max(1000, Math.min(30 * 60_000, envMs));
  }
  return 180_000;
}

function formatAttemptTime(timestamp: number) {
  return new Date(timestamp).toISOString();
}

function buildProviderAttemptTrace(input: {
  candidate: RoutedImageExecutionCandidate;
  startedAt: number;
  status: 'success' | 'failed';
  statusCode?: number;
  failureCategory?: string;
  shouldFailover?: boolean;
  sameProviderRetryAttempt?: number;
  sameProviderRetryLimit?: number;
}) {
  const completedAt = Date.now();
  return {
    provider_id: input.candidate.provider.providerId,
    provider_name: input.candidate.provider.name,
    provider_base_url: input.candidate.provider.baseUrl,
    protocol: input.candidate.provider.protocol,
    status: input.status,
    status_code: input.statusCode,
    failure_category: input.failureCategory,
    should_failover: input.shouldFailover,
    duration_ms: Math.max(0, completedAt - input.startedAt),
    started_at: formatAttemptTime(input.startedAt),
    completed_at: formatAttemptTime(completedAt),
    reasons: input.candidate.reasons,
    score: input.candidate.score,
    same_provider_retry_attempt: input.sameProviderRetryAttempt,
    same_provider_retry_limit: input.sameProviderRetryLimit,
  } satisfies RoutedProviderAttemptTrace;
}

function latestProviderAttemptDurationMs(attempts: RoutedProviderAttemptTrace[], providerId: string) {
  for (let index = attempts.length - 1; index >= 0; index -= 1) {
    const attempt = attempts[index];
    if (attempt.provider_id === providerId) {
      return Math.max(0, Number(attempt.duration_ms || 0));
    }
  }
  return 0;
}

function buildRoutingSummary(input: {
  mode: EffectiveRoutingMode;
  candidates: RoutedImageExecutionCandidate[];
  filteredOut: Array<{ providerId: string; reason: string }>;
  activeCandidate?: RoutedImageExecutionCandidate;
  attempts: RoutedProviderAttemptTrace[];
}) {
  return {
    mode: input.mode,
    candidateCount: input.candidates.length,
    candidateProviderIds: input.candidates.map((item) => item.provider.providerId),
    attemptedProviderIds: input.attempts.map((item) => item.provider_id),
    filteredOut: input.filteredOut,
    reasons: input.activeCandidate?.reasons,
    score: input.activeCandidate?.score,
    provider_attempts: input.attempts,
  };
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number, downstreamAbortSignal?: AbortSignal) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`Upstream request timed out after ${timeoutMs}ms.`)), timeoutMs);
  const abortForDownstreamDisconnect = () => {
    controller.abort(downstreamAbortSignal?.reason);
  };
  if (downstreamAbortSignal?.aborted) {
    abortForDownstreamDisconnect();
  } else {
    downstreamAbortSignal?.addEventListener('abort', abortForDownstreamDisconnect, { once: true });
  }
  let disposed = false;
  const dispose = () => {
    if (disposed) {
      return;
    }
    disposed = true;
    clearTimeout(timer);
    downstreamAbortSignal?.removeEventListener('abort', abortForDownstreamDisconnect);
  };
  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
    });
    return { response, dispose };
  } catch (error) {
    dispose();
    if (downstreamAbortSignal?.aborted) {
      throwIfDownstreamCancelled(downstreamAbortSignal);
    }
    throw error;
  }
}

function assertContentLengthWithinLimit(response: Response, limitBytes: number, label: string) {
  const contentLength = Number(response.headers.get('content-length') || 0);
  if (contentLength > limitBytes) {
    const error = new Error(`${label} exceeds maximum response size of ${limitBytes} bytes.`);
    (error as Error & { statusCode?: number }).statusCode = 413;
    throw error;
  }
}

async function readResponseTextWithLimit(response: Response, limitBytes: number, label: string) {
  return (await readResponseBufferWithLimit(response, limitBytes, label)).toString('utf8');
}

async function readResponseBufferWithLimit(response: Response, limitBytes: number, label: string) {
  assertContentLengthWithinLimit(response, limitBytes, label);
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = Buffer.from(next.value);
      total += chunk.length;
      if (total > limitBytes) {
        await reader.cancel(`${label} exceeds maximum response size.`).catch(() => undefined);
        const error = new Error(`${label} exceeds maximum response size of ${limitBytes} bytes.`);
        (error as Error & { statusCode?: number }).statusCode = 413;
        throw error;
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

async function streamResponseToGeneratedImageFile(response: Response, limitBytes: number, label: string) {
  assertContentLengthWithinLimit(response, limitBytes, label);
  if (!response.body) {
    throw new Error(`${label} has no response body.`);
  }
  const dir = getGeneratedImageDir();
  await fs.mkdir(dir, { recursive: true });
  const token = crypto.randomUUID();
  const temporaryPath = path.join(dir, `.upstream-${token}.part`);
  const handle = await fs.open(temporaryPath, 'wx', 0o600);
  const reader = response.body.getReader();
  const headerChunks: Buffer[] = [];
  let headerBytes = 0;
  let totalBytes = 0;
  let finalizedFilePath = '';
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = Buffer.from(next.value);
      totalBytes += chunk.length;
      if (totalBytes > limitBytes) {
        await reader.cancel(`${label} exceeds maximum response size.`).catch(() => undefined);
        const error = new Error(`${label} exceeds maximum response size of ${limitBytes} bytes.`);
        (error as Error & { statusCode?: number }).statusCode = 413;
        throw error;
      }
      let offset = 0;
      while (offset < chunk.length) {
        const { bytesWritten } = await handle.write(chunk, offset, chunk.length - offset);
        if (bytesWritten <= 0) {
          throw new Error(`Failed to write ${label} to disk.`);
        }
        offset += bytesWritten;
      }
      if (headerBytes < 32) {
        const prefix = chunk.subarray(0, Math.min(chunk.length, 32 - headerBytes));
        headerChunks.push(prefix);
        headerBytes += prefix.length;
      }
    }
    if (!totalBytes) {
      throw new Error(`${label} is empty.`);
    }
    await handle.close();
    const extension = detectImageExtensionFromBuffer(Buffer.concat(headerChunks, headerBytes));
    const fileName = `upstream_${token}.${extension}`;
    finalizedFilePath = path.join(dir, fileName);
    await fs.rename(temporaryPath, finalizedFilePath);
    return { fileName, extension, bytes: totalBytes };
  } catch (error) {
    await fs.rm(finalizedFilePath || temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
    await handle.close().catch(() => undefined);
  }
}

function resolveChatRequestTimeoutMs(provider?: ProviderConfig) {
  const configuredMs = Number(provider?.metadata?.chat_request_timeout_ms || provider?.metadata?.request_timeout_ms || 0);
  if (configuredMs > 0) {
    return Math.max(1000, Math.min(10 * 60_000, configuredMs));
  }
  const configuredSeconds = Number(provider?.metadata?.chat_request_timeout_seconds || provider?.metadata?.request_timeout_seconds || 0);
  if (configuredSeconds > 0) {
    return Math.max(1000, Math.min(10 * 60_000, configuredSeconds * 1000));
  }
  const envMs = Number(process.env.CHAT_UPSTREAM_TIMEOUT_MS || 0);
  if (envMs > 0) {
    return Math.max(1000, Math.min(10 * 60_000, envMs));
  }
  return 120_000;
}

async function fetchUpstreamAttempt(input: {
  requestPlan: UpstreamImageRequestPlan;
  timeoutMs: number;
  streamBinaryResponseToUrl?: boolean;
  downstreamAbortSignal?: AbortSignal;
}) {
  const requestBody = await buildUpstreamFetchBody({
    bodyFormat: input.requestPlan.bodyFormat,
    body: input.requestPlan.body,
    multipartFileNames: input.requestPlan.multipartFileNames,
    multipartFileSources: input.requestPlan.multipartFileSources,
  });

  const upstreamFetch = await fetchWithTimeout(input.requestPlan.url, {
    method: input.requestPlan.method,
    headers: input.requestPlan.headers,
    body: requestBody,
  }, input.timeoutMs, input.downstreamAbortSignal);
  try {
    const response = upstreamFetch.response;
    const responseContentType = String(response.headers.get('content-type') || '');
    let responseText = '';
    let bodyJson: unknown = undefined;
    let bodyBinaryBase64: string | undefined;
    let bodyBinaryExtension: string | undefined;
    let bodyBinaryFileName: string | undefined;
    if (responseContentType.toLowerCase().startsWith('image/')) {
      if (input.streamBinaryResponseToUrl && response.ok) {
        const stored = await streamResponseToGeneratedImageFile(
          response,
          maxUpstreamBinaryResponseBytes,
          'upstream binary image response',
        );
        bodyBinaryFileName = stored.fileName;
        bodyBinaryExtension = stored.extension;
      } else {
        const buffer = await readResponseBufferWithLimit(response, maxUpstreamBinaryResponseBytes, 'upstream binary image response');
        assertBufferWithinLimit(buffer, 'upstream binary image response', maxUpstreamBinaryResponseBytes);
        bodyBinaryBase64 = buffer.toString('base64');
        bodyBinaryExtension = detectImageExtensionFromBuffer(buffer);
      }
    } else {
      const rawResponseText = await readResponseTextWithLimit(response, maxUpstreamJsonResponseBytes, 'upstream JSON response');
      try {
        bodyJson = JSON.parse(rawResponseText);
        if (!bodyJson || typeof bodyJson !== 'object') {
          responseText = rawResponseText;
        }
      } catch {
        responseText = rawResponseText;
      }
    }
    return {
      ok: response.ok,
      statusCode: response.status,
      contentType: responseContentType,
      bodyText: responseText,
      bodyBinaryBase64,
      bodyBinaryExtension,
      bodyBinaryFileName,
      bodyJson,
    };
  } catch (error) {
    if (input.downstreamAbortSignal?.aborted) {
      throwIfDownstreamCancelled(input.downstreamAbortSignal);
    }
    throw error;
  } finally {
    upstreamFetch.dispose();
  }
}

function responseContainsUsableImageOutput(input: {
  protocol?: string;
  contentType?: string;
  bodyJson?: unknown;
  bodyText?: string;
  bodyBinaryBase64?: string;
  bodyBinaryFileName?: string;
}) {
  const normalizedContentType = String(input.contentType || '').toLowerCase();
  if (normalizedContentType.startsWith('image/') && (input.bodyBinaryBase64 || input.bodyBinaryFileName)) {
    return true;
  }

  const candidates = [
    ...(input.bodyJson !== undefined ? [input.bodyJson] : []),
    ...parseResponsesSsePayloads(String(input.bodyText || '')),
    tryParseJson(String(input.bodyText || '')),
  ].filter((item) => item !== undefined);

  if (String(input.protocol || '') === 'openai_responses') {
    for (const candidate of candidates) {
      if (collectImageLikeOutputs(candidate).length > 0) {
        return true;
      }
      if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
        const record = candidate as Record<string, unknown>;
        const item = record.item && typeof record.item === 'object'
          ? record.item as Record<string, unknown>
          : null;
        if (
          item?.type === 'image_generation_call'
          && item.status === 'completed'
          && typeof item.result === 'string'
          && item.result.trim()
        ) {
          return true;
        }
        const response = record.response && typeof record.response === 'object'
          ? record.response as Record<string, unknown>
          : null;
        const output = Array.isArray(response?.output) ? response.output as Array<Record<string, unknown>> : [];
        if (output.some((entry) => (
          entry
          && entry.type === 'image_generation_call'
          && entry.status === 'completed'
          && typeof entry.result === 'string'
          && entry.result.trim()
        ))) {
          return true;
        }
      }
    }
    return false;
  }

  if (String(input.protocol || '') === 'gemini_generate_content') {
    return candidates.some((candidate) => hasBananaImageOutput(candidate));
  }

  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') {
      continue;
    }
    if (Array.isArray(candidate)) {
      if (candidate.some((item) => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
          return false;
        }
        const normalized = toOpenAIImageDataItem(item as Record<string, unknown>);
        return Boolean(normalized.url || normalized.b64_json);
      })) {
        return true;
      }
      continue;
    }
    const record = candidate as Record<string, unknown>;
    if (isPartialImageEvent(record)) {
      continue;
    }
    const directItem = toOpenAIImageDataItem(record);
    if (directItem.url || directItem.b64_json) {
      return true;
    }
    if (Array.isArray(record.data) && record.data.some((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        return false;
      }
      const normalized = toOpenAIImageDataItem(item as Record<string, unknown>);
      return Boolean(normalized.url || normalized.b64_json);
    })) {
      return true;
    }
  }

  return false;
}

function buildStandardDownstreamError(input: {
  code: string;
  message: string;
  statusCode: number;
  failureCategory?: string;
  publicMessage?: string;
  upstream?: {
    providerId?: string;
    providerName?: string;
    providerBaseUrl?: string;
    statusCode?: number;
    category?: string;
  };
  traceId?: string;
  taskId?: string;
  details?: Record<string, unknown>;
}) {
  const publicMessage = input.publicMessage || input.message;
  const errorType = input.failureCategory === 'terminal_billing'
    ? 'insufficient_quota'
    : input.statusCode === 401
      ? 'authentication_error'
      : input.statusCode === 403
        ? 'permission_error'
        : input.statusCode === 429
          ? 'rate_limit_error'
          : input.statusCode >= 500
            ? 'server_error'
            : 'invalid_request_error';
  return {
    error: {
      message: publicMessage,
      type: errorType,
      param: null,
      code: input.code,
    },
    message: publicMessage,
    public_message: publicMessage,
    code: input.code,
    status_code: input.statusCode,
    failure_category: input.failureCategory || null,
    trace_id: input.traceId,
    task_id: input.taskId,
    upstream: null,
    details: sanitizePublicErrorDetails(input.details),
  };
}

function buildValidationIssueDetails(error: z.ZodError) {
  return {
    issues: error.issues.slice(0, 20).map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
      code: issue.code,
    })),
  };
}

function registerUnifiedErrorHandler() {
  app.setErrorHandler((error, _request, reply) => {
    const statusCode = Number((error as Error & { statusCode?: number }).statusCode || 0);
    if (error instanceof z.ZodError) {
      reply.code(400);
      return buildStandardDownstreamError({
        code: 'invalid_request',
        message: 'Request parameters are invalid.',
        statusCode: 400,
        failureCategory: 'terminal_user_content',
        details: buildValidationIssueDetails(error),
      });
    }

    if (statusCode === 413 || (error as Error & { code?: string }).code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
      reply.code(413);
      return buildStandardDownstreamError({
        code: (error as Error & { code?: string }).code === 'image_payload_too_large'
          ? 'image_payload_too_large'
          : 'request_body_too_large',
        message: 'Request payload is too large.',
        statusCode: 413,
        failureCategory: 'terminal_user_content',
        details: (error as Error & { details?: Record<string, unknown> }).details || {
          max_request_body_bytes: requestBodyLimitBytes,
          max_image_payload_bytes: maxImagePayloadBytes,
        },
      });
    }

    if (statusCode >= 400 && statusCode < 500) {
      reply.code(statusCode);
      return buildStandardDownstreamError({
        code: (error as Error & { code?: string }).code || 'invalid_request',
        message: (error as Error).message || 'Request cannot be processed.',
        statusCode,
        failureCategory: 'terminal_user_content',
        details: (error as Error & { details?: Record<string, unknown> }).details,
      });
    }

    if (statusCode === 503) {
      reply.code(503);
      return buildStandardDownstreamError({
        code: (error as Error & { code?: string }).code || 'service_unavailable',
        message: (error as Error).message || 'Shared state backend is unavailable.',
        statusCode: 503,
        failureCategory: 'retryable_internal_error',
        details: (error as Error & { details?: Record<string, unknown> }).details,
      });
    }

    app.log.error({
      error,
      errorName: error instanceof Error ? error.name : typeof error,
      errorMessage: error instanceof Error ? error.message : String(error),
      errorStack: error instanceof Error ? error.stack : undefined,
    }, 'Unhandled API error');
    reply.code(500);
    return buildStandardDownstreamError({
      code: 'internal_server_error',
      message: 'The request failed due to an internal server error.',
      statusCode: 500,
      failureCategory: 'retryable_internal_error',
    });
  });
}

function imageEndpointError(input: {
  code: string;
  message: string;
  statusCode: number;
  failureCategory?: string;
  details?: Record<string, unknown>;
}) {
  return buildStandardDownstreamError({
    code: input.code,
    message: input.message,
    statusCode: input.statusCode,
    failureCategory: input.failureCategory || (input.statusCode === 429 ? 'retryable_overloaded' : 'terminal_user_content'),
    details: input.details,
  });
}

function imageApiTypeMismatchError(expected: 'openai_images' | 'banana_images') {
  return imageEndpointError({
    code: 'api_key_interface_type_mismatch',
    message: expected === 'banana_images'
      ? 'This API key is configured for the OpenAI Images interface, not the Banana image interface.'
      : 'This API key is configured for the Banana image interface, not the OpenAI Images interface.',
    statusCode: 403,
    failureCategory: 'terminal_auth',
  });
}

const bananaInlineDataSchema = z.object({
  mimeType: z.string().trim().min(1).max(128),
  data: z.string().trim().min(1),
});
const bananaPartSchema = z.object({
  text: z.string().optional(),
  inlineData: bananaInlineDataSchema.optional(),
  inline_data: bananaInlineDataSchema.optional(),
}).passthrough();
const bananaGenerateContentSchema = z.object({
  contents: z.array(z.object({
    role: z.string().optional(),
    parts: z.array(bananaPartSchema).min(1),
  })).min(1),
  generationConfig: z.object({
    imageConfig: z.object({
      aspectRatio: z.string().trim().min(1).max(32).optional(),
      imageSize: z.string().trim().optional(),
    }).optional(),
  }).optional(),
}).passthrough();

function buildBananaNativeError(statusCode: number, message: string, code: string) {
  return {
    error: {
      code: statusCode,
      message,
      status: code,
    },
  };
}

function parseBananaPayload(model: string, body: unknown) {
  const request = bananaGenerateContentSchema.parse(body);
  const parts = request.contents.flatMap((content) => content.parts);
  const prompt = parts
    .map((part) => String(part.text || '').trim())
    .filter(Boolean)
    .join('\n');
  if (!prompt) {
    throw new z.ZodError([{ code: z.ZodIssueCode.custom, path: ['contents'], message: 'A Banana image request needs at least one text part.' }]);
  }
  const references = parts.flatMap((part) => {
    const inline = part.inlineData || part.inline_data;
    if (!inline) {
      return [];
    }
    return [`data:${inline.mimeType};base64,${inline.data.replace(/\s+/g, '')}`];
  });
  const imageSize = normalizeBananaImageSize(request.generationConfig?.imageConfig?.imageSize);
  if (!imageSize) {
    throw new z.ZodError([{ code: z.ZodIssueCode.custom, path: ['generationConfig', 'imageConfig', 'imageSize'], message: 'imageSize must be 1K, 2K, or 4K.' }]);
  }
  const aspectRatio = String(request.generationConfig?.imageConfig?.aspectRatio || '1:1').trim();
  return openAIImagesSchema.parse({
    model,
    prompt,
    size: imageSize,
    n: 1,
    ...(references.length ? { image: references } : {}),
    extra_body: {
      banana_protocol: true,
      banana_image_size: imageSize,
      banana_aspect_ratio: aspectRatio,
    },
  });
}

async function appendImageEndpointRejectionTrace(input: {
  request: any;
  payload: z.infer<typeof openAIImagesSchema>;
  operation: 'generations' | 'edits';
  accessContext: RequestAccessContext;
  requestStartedAt: number;
  statusCode: number;
  errorPayload: ReturnType<typeof imageEndpointError>;
  tags?: string[];
}) {
  await appendRequestTrace({
    source: 'tenant_runtime_sync',
    scope: 'full_chain',
    status: 'failed',
    summary: `${input.operation} rejected HTTP ${input.statusCode}`,
    createdAt: input.requestStartedAt,
    updatedAt: Date.now(),
    failureCategory: input.errorPayload.failure_category || undefined,
    statusCode: input.statusCode,
    tenantId: input.accessContext.tenantId,
    apiKeyId: input.accessContext.apiKeyId,
    channelId: imageChannelId,
    operation: input.operation,
    downstreamRequest: {
      headers: input.request.headers,
      payload: input.payload,
    },
    downstreamResponse: {
      statusCode: input.statusCode,
      body: input.errorPayload,
    },
    upstreamRequest: null,
    upstreamResponse: null,
    errorPayload: input.errorPayload,
    tags: ['runtime', 'rejected', ...(input.tags || [])],
  });
}

function classifyDownstreamErrorCode(statusCode: number) {
  if (statusCode === 429) return 'upstream_rate_limited';
  if (statusCode === 401 || statusCode === 403) return 'upstream_auth_failed';
  if (statusCode === 400 || statusCode === 410 || statusCode === 415 || statusCode === 422) return 'upstream_invalid_request';
  if (statusCode >= 500) return 'upstream_temporary_failure';
  return 'upstream_request_failed';
}

function publicMessageForFailureCategory(category: string) {
  if (category === 'terminal_safety') {
    return 'The request was rejected by platform safety checks.';
  }
  if (category === 'terminal_auth') {
    return 'The service is temporarily unavailable due to a service authentication issue.';
  }
  if (category === 'terminal_config') {
    return 'The service is currently unavailable due to a configuration issue.';
  }
  if (category === 'terminal_capability') {
    return 'The requested capability is not available on the current service.';
  }
  if (category === 'terminal_invalid_request') {
    return 'The request parameters are not accepted by the current service.';
  }
  if (category === 'terminal_user_content') {
    return 'The prompt or input images could not be processed. Adjust the request and try again.';
  }
  if (category === 'terminal_billing') {
    return 'The service is temporarily unavailable due to a billing issue.';
  }
  if (category === 'retryable_no_provider') {
    return 'No available service could accept the request at this time.';
  }
  if (category.startsWith('retryable_')) {
    return 'The service is temporarily unavailable. Retry in a moment.';
  }
  return 'The request could not be completed.';
}

function sanitizeDownstreamFailureMessage(category: string) {
  return publicMessageForFailureCategory(category);
}

function sanitizePublicErrorDetails(details: unknown) {
  if (!details || typeof details !== 'object' || Array.isArray(details)) {
    return details ?? null;
  }
  const blockedKeys = new Set([
    'routing',
    'upstream',
    'upstream_request',
    'upstream_response',
    'provider_id',
    'provider_name',
    'provider_base_url',
    'request_plan',
    'headers',
    'url',
  ]);
  const sanitizedEntries = Object.entries(details as Record<string, unknown>)
    .filter(([key]) => !blockedKeys.has(key));
  if (!sanitizedEntries.length) {
    return null;
  }
  return Object.fromEntries(sanitizedEntries);
}

function sanitizePublicTaskResult(result: unknown) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return result ?? null;
  }
  const { routing: _routing, ...rest } = result as Record<string, unknown>;
  const statusCode = Number(rest.statusCode || 0);
  if (statusCode >= 400) {
    return {
      ...rest,
      body: null,
    };
  }
  return rest;
}

function sanitizePublicTaskError(error: unknown) {
  if (error == null) {
    return null;
  }
  if (typeof error === 'string') {
    const publicMessage = publicMessageForFailureCategory('terminal_unknown');
    return {
      error: 'task_failed',
      message: publicMessage,
      public_message: publicMessage,
    };
  }
  if (typeof error !== 'object' || Array.isArray(error)) {
    return error;
  }
  const {
    upstream: _upstream,
    routing: _routing,
    upstream_response: _upstreamResponse,
    request_plan: _requestPlan,
    provider_id: _providerId,
    provider_name: _providerName,
    provider_base_url: _providerBaseUrl,
    ...rest
  } = error as Record<string, unknown>;
  const failureCategory = String(rest.failure_category || '');
  const publicMessage = publicMessageForFailureCategory(failureCategory);
  return {
    ...rest,
    message: publicMessage,
    public_message: publicMessage,
    upstream: null,
    details: sanitizePublicErrorDetails(rest.details),
  };
}

function buildUpstreamFailureEnvelope(input: {
  statusCode: number;
  bodyJson?: unknown;
  bodyText?: string;
  providerId: string;
  providerName?: string;
  providerBaseUrl?: string;
  failureCategory?: string;
  routing?: Record<string, unknown>;
}) {
  const failureCategory = input.failureCategory || classifyUpstreamFailure({
    statusCode: input.statusCode,
    bodyJson: input.bodyJson,
    bodyText: input.bodyText,
  }).category;
  const publicMessage = publicMessageForFailureCategory(failureCategory);
  return buildStandardDownstreamError({
    code: failureCategory === 'terminal_safety'
      ? 'upstream_safety_rejected'
      : failureCategory === 'retryable_upstream_dispatch'
        ? 'upstream_temporary_failure'
      : classifyDownstreamErrorCode(input.statusCode),
    message: sanitizeDownstreamFailureMessage(failureCategory),
    statusCode: input.statusCode,
    failureCategory,
    publicMessage,
    details: {
      upstream_status: input.statusCode,
    },
  });
}

function getImageChannelRuntimeConfig() {
  const controlPlane = adminControlPlaneStore.get();
  const catalog = adminConsoleCatalogStore.get();
  const imageChannel = catalog.channels.find((item) => item.id === imageChannelId) || null;
  return {
    publicApi: controlPlane.publicApi,
    imageChannel,
  };
}

function resolveEnabledImageProvidersForOperation(operation: 'generations' | 'edits') {
  const { imageChannel } = getImageChannelRuntimeConfig();
  if (!imageChannel || imageChannel.enabled === false) {
    return [];
  }

  const allowedUpstreamIds = new Set(imageChannel.upstreamIds || []);
  const providers = providerRegistry.list().filter((provider) => allowedUpstreamIds.has(provider.providerId));
  if (operation === 'generations') {
    return providers;
  }
  return providers.filter((provider) => provider.capability?.supportsImageEdit !== false);
}

function isBananaImagePayload(payload: z.infer<typeof openAIImagesSchema>) {
  return payload.extra_body?.banana_protocol === true;
}

function normalizeBananaImageSize(value: unknown): '1k' | '2k' | '4k' | null {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized === '1k' || normalized === '2k' || normalized === '4k' ? normalized : null;
}

function extractUpstreamErrorMessage(input: { bodyJson?: unknown; bodyText?: string }) {
  if (input.bodyJson && typeof input.bodyJson === 'object' && !Array.isArray(input.bodyJson)) {
    const record = input.bodyJson as Record<string, unknown>;
    const message = record.message || record.error || record.detail;
    if (typeof message === 'string' && message.trim()) {
      return message.trim();
    }
    if (typeof record.message === 'object' || typeof record.error === 'object') {
      return JSON.stringify(record.message || record.error);
    }
  }
  return String(input.bodyText || '').trim() || 'Upstream request failed.';
}

function isTerminalPayloadPreparationError(error: unknown) {
  const statusCode = Number((error as { statusCode?: unknown } | null)?.statusCode || 0);
  return statusCode >= 400 && statusCode < 500;
}

async function buildSmartExecutionPreview(input: {
  request: any;
  payload: z.infer<typeof openAIImagesSchema>;
  operation: 'generations' | 'edits';
  accessContext: RequestAccessContext;
  asyncTaskAssetDirectory?: string;
  asyncTaskImageAssets?: AsyncTaskImageAsset[];
}): Promise<RoutedImageExecutionPreview> {
  const requestedEditProtocol = inferRequestedEditProtocol({
    request: input.request,
    payload: input.payload,
    operation: input.operation,
  });
  const payload = withRequestedEditProtocolHint(input.payload, requestedEditProtocol);
  const mode = resolveEffectiveImageRoutingMode({
    payload,
    accessContext: input.accessContext,
  });

  if (payload.provider_source === 'user_supplied') {
    const resolved = resolveImageProviderPlan({
      request: payload,
      operation: input.operation,
      routingMode: 'priority_failover',
      providerSource: payload.provider_source,
      userApiBaseUrl: payload.user_api_base_url,
      userImagesGenerationsUrl: payload.user_images_generations_url,
      userImagesEditsUrl: payload.user_images_edits_url,
      userApiKey: payload.user_api_key,
      userImageApiKind: payload.user_image_api_kind || 'images_endpoint',
      userAuthMode: payload.preferred_auth_mode || 'bearer',
      resolveProvider,
    });
    if (!resolved) {
      return {
        mode,
        candidates: [],
        filteredOut: [],
      };
    }
    if (!providerSupportsRequestedEditProtocol(resolved.provider, requestedEditProtocol)) {
      return {
        mode,
        candidates: [],
        filteredOut: [{
          providerId: resolved.provider.providerId,
          reason: `edit_protocol_${requestedEditProtocol}_not_supported`,
        }],
      };
    }
    const prepared = await preparePayloadAndRequestPlanForProvider({
      request: input.request,
      payload,
      provider: resolved.provider,
      operation: input.operation,
      asyncTaskAssetDirectory: input.asyncTaskAssetDirectory,
      asyncTaskImageAssets: input.asyncTaskImageAssets,
    });
    return {
      mode,
      candidates: [{
        provider: resolved.provider,
        payload: prepared.payload,
        requestPlan: prepared.requestPlan,
        reasons: ['user_supplied'],
      }],
      filteredOut: [],
    };
  }

  const bananaRequest = isBananaImagePayload(payload);
  const channelProviders = resolveEnabledImageProvidersForOperation(input.operation)
    .filter((provider) => bananaRequest
      ? provider.protocol === 'gemini_generate_content'
      : provider.protocol !== 'gemini_generate_content');
  const isFixedProviderRoute = mode === 'fixed_provider' || mode === 'fixed_provider_pool';
  const fixedProviderIds = normalizeFixedImageProviderIds(
    input.accessContext.fixedImageProviderIds,
    input.accessContext.fixedImageProviderId,
  );
  const fixedProviderIdSet = new Set(fixedProviderIds);
  const providers = isFixedProviderRoute
    ? channelProviders.filter((provider) => fixedProviderIdSet.has(provider.providerId))
    : channelProviders;
  const fixedProviderFilteredOut = isFixedProviderRoute
    ? channelProviders
      .filter((provider) => !fixedProviderIdSet.has(provider.providerId))
      .map((provider) => ({
        providerId: provider.providerId,
        reason: mode === 'fixed_provider_pool' ? 'not_fixed_provider_pool' : 'not_fixed_provider',
      }))
    : [];
  const routingPlanMode: ImageRoutingMode = mode === 'fixed_provider_pool' ? 'smart_failover' : mode;
  const plan = await buildSmartImageRoutingPlan({
    providers,
    mode: routingPlanMode,
    context: {
      operation: input.operation,
      requestedSize: resolveRequestedImageSize(payload),
      requestedQuality: payload.quality,
      requestedResponseFormat: payload.response_format,
      requestedEditProtocol,
      requestMode: payload.async ? 'async' : 'sync',
      hasReferenceImage: payloadHasReferenceImages(payload),
      requestedModel: payload.model,
      protocolFamily: bananaRequest ? 'banana_image' : 'openai_image',
      bananaImageSize: bananaRequest ? normalizeBananaImageSize(payload.extra_body?.banana_image_size) || undefined : undefined,
      bananaAspectRatio: bananaRequest ? String(payload.extra_body?.banana_aspect_ratio || '').trim() || undefined : undefined,
      ignoreTierQualityCapability: isFixedProviderRoute,
      ignoreRuntimeBlock: mode === 'fixed_provider',
    },
  });

  const selected = shouldStopAfterFirstProviderAttempt(mode)
    ? plan.candidates.slice(0, 1)
    : plan.candidates;

  const candidates: RoutedImageExecutionCandidate[] = [];
  const adaptationFilteredOut = [...fixedProviderFilteredOut, ...plan.filteredOut];
  for (const candidate of selected) {
    candidates.push({
      provider: candidate.provider,
      score: candidate.score,
      reasons: candidate.reasons,
      prepare: async () => {
        return preparePayloadAndRequestPlanForProvider({
          request: input.request,
          payload,
          provider: candidate.provider,
          operation: input.operation,
          asyncTaskAssetDirectory: input.asyncTaskAssetDirectory,
          asyncTaskImageAssets: input.asyncTaskImageAssets,
        });
      },
    });
  }

  await promotePassiveRecoveryReentry({
    mode,
    asyncRequest: Boolean(payload.async),
    plan,
    candidates,
  });

  // Queue metadata needs the initial route, while fallback candidates remain
  // lazy so their reference images are only prepared if they are attempted.
  if (payload.async && candidates[0]) {
    try {
      await prepareRoutedImageExecutionCandidate(candidates[0]);
    } catch (error) {
      if ((mode !== 'smart_failover' && mode !== 'fixed_provider_pool') || isTerminalPayloadPreparationError(error)) {
        throw error;
      }
      adaptationFilteredOut.push({
        providerId: candidates[0].provider.providerId,
        reason: 'payload_adaptation_failed',
      });
      candidates.splice(0, 1);
    }
  }

  return {
    mode,
    plan,
    candidates,
    filteredOut: adaptationFilteredOut,
  };
}

function normalizeRequestedImageQuality(value?: string | null): 'auto' | 'low' | 'medium' | 'high' {
  const quality = String(value || '').trim().toLowerCase();
  return quality === 'low' || quality === 'medium' || quality === 'high' ? quality : 'auto';
}

function normalizeKnownImageQuality(value?: unknown): 'low' | 'medium' | 'high' | undefined {
  const quality = String(value || '').trim().toLowerCase();
  return quality === 'low' || quality === 'medium' || quality === 'high' ? quality : undefined;
}

function imageTierRank(tier?: ResolutionTier | 'auto' | null) {
  if (tier === '1k') return 1;
  if (tier === '2k') return 2;
  if (tier === '4k') return 3;
  return null;
}

function imageQualityRank(quality?: 'low' | 'medium' | 'high' | 'auto' | null) {
  if (quality === 'low') return 1;
  if (quality === 'medium') return 2;
  if (quality === 'high') return 3;
  return null;
}

function resolveBilledImageTier(input: {
  submittedTier?: ResolutionTier | 'auto' | null;
  actualTier?: ResolutionTier | null;
  fixedUnitCents?: number;
}) {
  if (input.submittedTier === 'auto') {
    return 'auto' as const;
  }
  if (!input.submittedTier) {
    return input.actualTier || undefined;
  }
  if ((input.fixedUnitCents || 0) > 0) {
    return input.submittedTier;
  }
  const submittedRank = imageTierRank(input.submittedTier);
  const actualRank = imageTierRank(input.actualTier);
  if (submittedRank !== null && actualRank !== null && actualRank < submittedRank) {
    return input.actualTier || input.submittedTier;
  }
  return input.submittedTier;
}

function resolveBilledImageQuality(input: {
  submittedQuality?: string | null;
  actualQuality?: unknown;
  fixedUnitCents?: number;
}) {
  const submittedQuality = normalizeRequestedImageQuality(input.submittedQuality);
  if (submittedQuality === 'auto' || (input.fixedUnitCents || 0) > 0) {
    return submittedQuality;
  }
  const actualQuality = normalizeKnownImageQuality(input.actualQuality);
  const submittedRank = imageQualityRank(submittedQuality);
  const actualRank = imageQualityRank(actualQuality);
  if (submittedRank !== null && actualRank !== null && actualRank < submittedRank) {
    return actualQuality || submittedQuality;
  }
  return submittedQuality;
}

function firstImageGenerationTool(body?: Record<string, unknown> | null) {
  const tools = Array.isArray(body?.tools) ? body.tools : [];
  return tools.find((item): item is Record<string, unknown> => (
    !!item
    && typeof item === 'object'
    && !Array.isArray(item)
    && String((item as Record<string, unknown>).type || '') === 'image_generation'
  ));
}

function resolveSubmittedImageSize(input: {
  payload: z.infer<typeof openAIImagesSchema>;
  requestPlanBody?: Record<string, unknown> | null;
}) {
  const bodySize = String(input.requestPlanBody?.size || '').trim();
  if (bodySize) {
    return bodySize;
  }
  const toolSize = String(firstImageGenerationTool(input.requestPlanBody)?.size || '').trim();
  if (toolSize) {
    return toolSize;
  }
  return resolveRequestedImageSize(input.payload);
}

function resolveSubmittedImageQuality(input: {
  payload: z.infer<typeof openAIImagesSchema>;
  requestPlanBody?: Record<string, unknown> | null;
}) {
  const bodyQuality = String(input.requestPlanBody?.quality || '').trim();
  if (bodyQuality) {
    return bodyQuality;
  }
  const tool = firstImageGenerationTool(input.requestPlanBody);
  const toolQuality = String(tool?.quality || '').trim();
  if (toolQuality) {
    return toolQuality;
  }
  return input.payload.quality;
}

function resolveImageSellPrice(input: {
  tier?: ResolutionTier | 'auto' | null;
  quality?: string | null;
}) {
  const tier = input.tier;
  if (tier !== 'auto' && tier !== '1k' && tier !== '2k' && tier !== '4k') {
    return 0;
  }
  const quality = normalizeRequestedImageQuality(input.quality);
  const catalog = adminConsoleCatalogStore.get();
  const row = (catalog.imagePricingMatrix || []).find((item) => item.tier === tier && item.quality === quality);
  return Math.max(0, Number(row?.price || 0));
}

function resolveImageSellPriceCents(input: {
  tier?: ResolutionTier | 'auto' | null;
  quality?: string | null;
}) {
  return Math.max(0, yuanToMinorUnits(resolveImageSellPrice(input)));
}

function resolveBananaImageSellPriceCents(model: string) {
  const row = (adminConsoleCatalogStore.get().bananaImagePricingMatrix || []).find((item) => (
    item.model === model
  ));
  return Math.max(0, yuanToMinorUnits(Number(row?.price || 0)));
}

function resolveChatCompletionsSellPriceCents() {
  const catalog = adminConsoleCatalogStore.get();
  const yuan = Number(catalog.chatCompletionsUnitPriceYuan);
  if (Number.isFinite(yuan)) {
    return Math.max(0, yuanToMinorUnits(yuan));
  }
  // Legacy catalogs stored this setting directly in cents.
  return Math.max(0, Number(catalog.chatCompletionsUnitPrice || 0));
}

function resolveFixedApiKeyImageSellPriceCents(accessContext?: RequestAccessContext) {
  if (!accessContext || accessContext.authMode !== 'tenant_key') {
    return 0;
  }
  if (accessContext.imageRoutingMode !== 'fixed_provider') {
    return 0;
  }
  if (!normalizeFixedImageProviderIds(
    accessContext.fixedImageProviderIds,
    accessContext.fixedImageProviderId,
  ).length) {
    return 0;
  }
  const flatPrice = Number(accessContext.fixedImageFlatPrice || 0);
  if (!Number.isFinite(flatPrice) || flatPrice <= 0) {
    return 0;
  }
  return Math.max(0, yuanToMinorUnits(flatPrice));
}

async function ensureTenantPositiveBalance(input: {
  accessContext: RequestAccessContext;
}) {
  if (input.accessContext.authMode !== 'tenant_key') {
    return { allowed: true as const, balanceCents: null as number | null };
  }
  const balance = await operationalRepository.getTenantFinanceBalance(input.accessContext.tenantId, 'cny');
  const balanceCents = Number(balance?.balanceCents || 0);
  if (balanceCents <= 0) {
    return {
      allowed: false as const,
      balanceCents,
    };
  }
  return { allowed: true as const, balanceCents };
}

function stableOperationalId(prefix: string, ...parts: Array<string | number | undefined | null>) {
  const digest = crypto
    .createHash('sha256')
    .update(parts.map((part) => String(part ?? '')).join('\u001f'))
    .digest('hex')
    .slice(0, 32);
  return `${prefix}_${digest}`;
}

function readActualImageQualityFromResponsePayload(responsePayload: unknown) {
  if (!responsePayload || typeof responsePayload !== 'object' || Array.isArray(responsePayload)) {
    return undefined;
  }
  const record = responsePayload as Record<string, unknown>;
  const body = record.body && typeof record.body === 'object' && !Array.isArray(record.body)
    ? record.body as Record<string, unknown>
    : record;
  return normalizeKnownImageQuality(body.quality);
}

function readBillingAuditRecordsFromResponsePayload(responsePayload: unknown): BillingAuditImageRecord[] {
  if (!responsePayload || typeof responsePayload !== 'object' || Array.isArray(responsePayload)) {
    return [];
  }
  const record = responsePayload as Record<string, unknown>;
  const rawRecords = Array.isArray(record.billingAuditRecords)
    ? record.billingAuditRecords
    : [];
  if (rawRecords.length) {
    return rawRecords
      .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object' && !Array.isArray(item)))
      .filter((item) => Boolean(item.actualSize && item.actualTier))
      .map((item, index) => ({
        ...item,
        index: Number.isFinite(Number(item.index)) ? Number(item.index) : index,
        billedTier: item.billedTier || item.actualTier,
        billedSize: item.billedSize || item.actualSize,
      } as BillingAuditImageRecord));
  }

  const body = record.body && typeof record.body === 'object' && !Array.isArray(record.body)
    ? record.body as Record<string, unknown>
    : {};
  const requestMeta = record.requestMeta && typeof record.requestMeta === 'object' && !Array.isArray(record.requestMeta)
    ? record.requestMeta as Record<string, unknown>
    : {};
  const actualSize = String(body.size || '').trim();
  const actualTier = classifyResolutionTier(actualSize || '');
  if (!actualSize || !actualTier) {
    return [];
  }
  const dataLength = Array.isArray(body.data) ? body.data.length : 0;
  const requestedCount = Number(requestMeta.requestedImageCount || 0);
  const count = Math.max(1, dataLength || (Number.isFinite(requestedCount) ? Math.floor(requestedCount) : 0));
  const requestedSize = String(requestMeta.upstreamRequestedSize || requestMeta.size || '').trim() || undefined;
  const requestedTier = classifyResolutionTier(requestedSize || '') || undefined;
  return Array.from({ length: count }, (_, index) => ({
    index,
    requestedSize,
    requestedTier,
    actualSize,
    actualTier,
    billedTier: actualTier,
    billedSize: actualSize,
    extractionSource: 'response_field',
  } as BillingAuditImageRecord));
}

async function resolveBillingAuditRecordsForPersistence(input: {
  requestPayload: Record<string, unknown>;
  responsePayload: unknown;
  maxImageCount: number;
}) {
  const embedded = readBillingAuditRecordsFromResponsePayload(input.responsePayload);
  if (embedded.length) {
    return embedded.slice(0, input.maxImageCount);
  }
  return buildBillingAuditImageRecords({
    requestPayload: input.requestPayload,
    responsePayload: input.responsePayload,
    maxImageCount: input.maxImageCount,
  });
}

async function buildActualImageBilling(input: {
  taskId: string;
  requestId: string;
  payload: z.infer<typeof openAIImagesSchema>;
  requestPlanBody?: Record<string, unknown> | null;
  submittedSize?: string;
  submittedQuality?: string;
  operation: 'generations' | 'edits';
  upstreamId?: string;
  providerProtocol?: string;
  accessContext: RequestAccessContext;
  responsePayload: unknown;
}) {
  if (input.accessContext.authMode !== 'tenant_key') {
    return { totalChargedCredits: 0, billedImages: 0, financeDetail: {}, billingRecords: [] as BillingLedgerRecord[] };
  }

  if (input.providerProtocol === 'gemini_generate_content') {
    const imageSize = normalizeBananaImageSize(input.requestPlanBody?.generationConfig
      && typeof input.requestPlanBody.generationConfig === 'object'
      ? (input.requestPlanBody.generationConfig as Record<string, unknown>).imageConfig
        && typeof (input.requestPlanBody.generationConfig as Record<string, unknown>).imageConfig === 'object'
        ? ((input.requestPlanBody.generationConfig as Record<string, unknown>).imageConfig as Record<string, unknown>).imageSize
        : undefined
      : input.payload.extra_body?.banana_image_size)
      || normalizeBananaImageSize(input.payload.extra_body?.banana_image_size);
    if (!imageSize) {
      return { totalChargedCredits: 0, billedImages: 0, financeDetail: {}, billingRecords: [] as BillingLedgerRecord[] };
    }
    const fixedUnitCents = resolveFixedApiKeyImageSellPriceCents(input.accessContext);
    const chargedCredits = fixedUnitCents > 0
      ? fixedUnitCents
      : resolveBananaImageSellPriceCents(input.payload.model);
    const catalog = adminConsoleCatalogStore.get();
    const upstream = catalog.upstreams.find((item) => item.id === input.upstreamId);
    const capability = upstream?.bananaConfig?.modelCapabilities.find((item) => item.model === input.payload.model);
    const hasConfiguredCost = Boolean(capability && Object.prototype.hasOwnProperty.call(capability, 'cost'));
    const costYuan = Number(capability?.cost || 0);
    const upstreamCostCredits = hasConfiguredCost && Number.isFinite(costYuan) && costYuan >= 0
      ? yuanToMinorUnits(costYuan)
      : 0;
    const resultCount = Math.max(1, collectBananaInlineDataParts(input.responsePayload).length || 1);
    const billingRecords = Array.from({ length: resultCount }, (_, index) => ({
      id: stableOperationalId('billing', input.taskId, index, input.payload.model, imageSize),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      tenantId: input.accessContext.tenantId,
      apiKeyId: input.accessContext.apiKeyId,
      channelId: imageChannelId,
      upstreamId: input.upstreamId,
      requestId: input.requestId,
      taskId: input.taskId,
      operation: input.operation,
      currency: 'cny' as const,
      reservedCredits: chargedCredits,
      chargedCredits,
      status: chargedCredits > 0 ? 'charged' as const : 'voided' as const,
      model: input.payload.model,
      size: imageSize,
      detail: {
        idempotencyKey: stableOperationalId('banana_image_charge', input.taskId, index),
        protocol: 'banana_images',
        submittedModel: input.payload.model,
        submittedImageSize: imageSize,
        submittedAspectRatio: String(input.payload.extra_body?.banana_aspect_ratio || '') || null,
        billedModel: input.payload.model,
        billedTier: imageSize,
        billingMode: fixedUnitCents > 0 ? 'fixed_provider_flat_price' : 'banana_model_price',
        billingModeLabel: fixedUnitCents > 0 ? '固定线路一口价' : 'Banana 模型定价',
        upstreamCostConfigured: hasConfiguredCost,
        upstreamCostMinorUnits: hasConfiguredCost ? upstreamCostCredits : null,
        upstreamCostYuan: hasConfiguredCost ? minorUnitsToYuan(upstreamCostCredits) : null,
        upstreamCostModel: input.payload.model,
        upstreamCostDimension: 'model',
      },
    }));
    const totalChargedCredits = chargedCredits * resultCount;
    return {
      totalChargedCredits,
      billedImages: resultCount,
      billingRecords,
      financeDetail: {
        source: 'banana_image_request_charge',
        requestId: input.requestId,
        taskId: input.taskId,
        operation: input.operation,
        protocol: 'gemini_generate_content',
        protocolLabel: 'Banana 图像接口',
        requestedModel: input.payload.model,
        requestedImageSize: imageSize,
        requestedAspectRatio: String(input.payload.extra_body?.banana_aspect_ratio || '') || null,
        billingMode: fixedUnitCents > 0 ? 'fixed_provider_flat_price' : 'banana_model_price',
        billedImages: resultCount,
        amountCents: totalChargedCredits,
      },
    };
  }

  const submittedSize = input.submittedSize || resolveSubmittedImageSize({
    payload: input.payload,
    requestPlanBody: input.requestPlanBody,
  });
  const submittedQuality = input.submittedQuality || resolveSubmittedImageQuality({
    payload: input.payload,
    requestPlanBody: input.requestPlanBody,
  });
  const submittedTier = submittedSize && submittedSize.toLowerCase() === 'auto'
    ? 'auto' as const
    : classifyResolutionTier(submittedSize || '') || undefined;
  const submittedTierIsAuto = submittedTier === 'auto';

  const records = await resolveBillingAuditRecordsForPersistence({
    requestPayload: {
      size: submittedSize,
      resolution: submittedSize,
      aspect_ratio: submittedSize,
    },
    responsePayload: input.responsePayload,
    maxImageCount: Math.max(1, Number(input.payload.n || 1)),
  });

  let totalChargedCredits = 0;
  let billedImages = 0;
  let firstActualSize = '';
  let firstActualTier = '';
  const billingRecords: BillingLedgerRecord[] = [];
  const fixedUnitCents = resolveFixedApiKeyImageSellPriceCents(input.accessContext);
  const requestedSize = submittedSize;
  const requestedTier = submittedTier;
  const requestedTierIsAuto = submittedTierIsAuto;
  const billingMode = fixedUnitCents > 0 ? 'fixed_provider_flat_price' : 'global_image_price_matrix';
  const billingModeLabel = fixedUnitCents > 0 ? '固定线路一口价' : '按请求尺寸档位';
  const actualQuality = readActualImageQualityFromResponsePayload(input.responsePayload);
  const upstreamCostTier = requestedTier || (requestedSize === 'auto' ? 'auto' : null);
  const upstreamCostQuality = normalizeRequestedImageQuality(submittedQuality);
  const catalog = adminConsoleCatalogStore.get();
  const upstream = catalog.upstreams.find((item) => item.id === input.upstreamId);
  // Cost is based on the request actually sent upstream, not a downstream raw
  // parameter or a later response downgrade.
  const upstreamCost = resolveOperationalImageCost(upstream, upstreamCostTier, upstreamCostQuality);
  const billedQuality = resolveBilledImageQuality({
    submittedQuality,
    actualQuality,
    fixedUnitCents,
  });

  for (const record of records) {
    const actualTier = record.actualTier || classifyResolutionTier(record.actualSize || '') || undefined;
    const billedTier = resolveBilledImageTier({
      submittedTier: requestedTier || (requestedTierIsAuto ? 'auto' : undefined),
      actualTier,
      fixedUnitCents,
    }) || record.requestedTier || actualTier;
    if (!billedTier || !record.actualSize) {
      continue;
    }
    const chargedCredits = fixedUnitCents > 0
      ? fixedUnitCents
      : resolveImageSellPriceCents({
        tier: billedTier,
        quality: billedQuality,
      });
    const billedSize = billedTier === actualTier
      ? record.actualSize
      : record.requestedSize || requestedSize || record.actualSize;
    if (!firstActualSize) {
      firstActualSize = record.actualSize;
      firstActualTier = actualTier || '';
    }
    billedImages += 1;
    totalChargedCredits += chargedCredits;
    billingRecords.push({
      id: stableOperationalId('billing', input.taskId, record.index, billedTier, billedQuality),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      tenantId: input.accessContext.tenantId,
      apiKeyId: input.accessContext.apiKeyId,
      channelId: imageChannelId,
      upstreamId: input.upstreamId,
      requestId: input.requestId,
      taskId: input.taskId,
      operation: input.operation,
      currency: 'cny',
      reservedCredits: chargedCredits,
      chargedCredits,
      status: chargedCredits > 0 ? 'charged' : 'voided',
      model: input.payload.model,
      size: billedSize,
      detail: {
        idempotencyKey: stableOperationalId('image_charge', input.taskId, record.index),
        imageIndex: record.index,
        upstreamRequestedSize: record.requestedSize || requestedSize || null,
        upstreamActualSize: record.actualSize || null,
        requestedSize: record.requestedSize || requestedSize || null,
        actualSize: record.actualSize || null,
        billedSize,
        requestedTier: requestedTier || record.requestedTier || (requestedSize === 'auto' ? 'auto' : null),
        actualTier: actualTier || null,
        billedTier: billedTier || null,
        requestedQuality: normalizeRequestedImageQuality(submittedQuality),
        actualQuality: actualQuality || null,
        billedQuality,
        billingMode,
        billingModeLabel,
        billedPricingMode: billingMode,
        fixedImageFlatPriceMinorUnits: fixedUnitCents > 0 ? fixedUnitCents : null,
        upstreamCostConfigured: upstreamCost.configured,
        upstreamCostMinorUnits: upstreamCost.configured ? upstreamCost.valueCredits : undefined,
        upstreamCostYuan: upstreamCost.configured ? minorUnitsToYuan(upstreamCost.valueCredits) : null,
        upstreamCostSource: upstreamCost.source,
        upstreamCostTier,
        upstreamCostQuality,
        imageUrl: record.imageUrl || null,
        extractionSource: record.extractionSource,
      },
    });
  }

  return {
    totalChargedCredits,
    billedImages,
    billingRecords,
    financeDetail: {
      source: 'image_request_charge',
      requestId: input.requestId,
      taskId: input.taskId,
      operation: input.operation,
      protocol: String(input.providerProtocol || '').trim() || 'openai_images',
      protocolLabel: imageProtocolLabel(input.providerProtocol),
      requestedSize,
      requestedTier: requestedTier || (requestedSize === 'auto' ? 'auto' : undefined),
      requestedQuality: normalizeRequestedImageQuality(submittedQuality),
      actualQuality: actualQuality || null,
      actualSize: firstActualSize || null,
      actualTier: firstActualTier || null,
      billingMode,
      billingModeLabel,
      billedQuality,
      billedImages,
      amountCents: totalChargedCredits,
    },
  };
}

async function buildImageTaskResponsePayload(input: {
  request?: any;
  payload: z.infer<typeof openAIImagesSchema>;
  operation: 'generations' | 'edits';
  taskId?: string;
  providerProtocol?: string;
  allowDirectPublicImageUrl?: boolean;
  statusCode: number;
  bodyJson?: unknown;
  bodyText: string;
  responseContentType?: string;
  bodyBinaryBase64?: string;
  bodyBinaryExtension?: string;
  bodyBinaryFileName?: string;
  responseFormatOverride?: DownstreamImageResponseFormat;
  normalizedBody?: unknown;
}): Promise<Record<string, unknown>> {
  const outputFormat = String(input.payload.extra_body?.output_format || input.payload.output_format || 'png');
  const requestedResponseFormat = input.responseFormatOverride || resolveDownstreamImageResponseFormat(input.payload);
  let responseBody: unknown = input.normalizedBody !== undefined ? input.normalizedBody : input.bodyJson ?? (
    input.bodyBinaryBase64 || input.bodyBinaryFileName
      ? {
          data: [{
            ...(input.bodyBinaryFileName
              ? { url: buildGeneratedImageUrl(input.request, input.bodyBinaryFileName) }
              : { b64_json: input.bodyBinaryBase64 }),
            __extension_hint: input.bodyBinaryExtension || detectImageExtension({
              outputFormat,
            }),
          }],
        }
      : input.bodyText
  );

  if (input.normalizedBody === undefined && input.request && input.taskId && (input.statusCode >= 200 && input.statusCode < 300)) {
    const commonNormalizationInput = {
      request: input.request,
      taskId: input.taskId,
      bodyJson: input.bodyJson,
      bodyText: input.bodyText,
      responseFormat: requestedResponseFormat,
      outputFormat,
      requestedImageCount: input.payload.n,
      requestedSize: input.payload.size,
      requestedQuality: input.payload.quality,
      requestedPrompt: input.payload.prompt,
      requestedBackground: typeof input.payload.extra_body?.background === 'string'
        ? input.payload.extra_body.background
        : undefined,
      allowDirectPublicImageUrl: input.allowDirectPublicImageUrl,
    };
    const normalizedBody = input.providerProtocol === 'openai_responses'
      ? await normalizeResponsesImageBody(commonNormalizationInput)
      : await normalizeStandardImageResponseBody({
          ...commonNormalizationInput,
          responseContentType: input.responseContentType,
          bodyBinaryBase64: input.bodyBinaryBase64,
          bodyBinaryExtension: input.bodyBinaryExtension,
          bodyBinaryFileName: input.bodyBinaryFileName,
        });
    if (normalizedBody) {
      responseBody = normalizedBody;
    }
  }

  const resolutionAuditBatch = await buildImageResolutionAuditRecords({
    requestPayload: {
      size: input.payload.size,
      resolution: input.payload.size,
      aspect_ratio: input.payload.size,
    },
    responsePayload: responseBody,
    maxImageCount: Math.max(1, Number(input.payload.n || 1)),
  });
  const resolutionAudit = resolutionAuditBatch.records[0] || null;
  const submittedTier = input.payload.size && input.payload.size.toLowerCase() === 'auto'
    ? 'auto' as const
    : classifyResolutionTier(input.payload.size || '') || undefined;
  const actualQuality = readActualImageQualityFromResponsePayload(responseBody);
  const billedQuality = resolveBilledImageQuality({
    submittedQuality: input.payload.quality,
    actualQuality,
  });
  const billingAuditRecords = resolutionAuditBatch.records
    .filter((record) => Boolean(record.actualSize && record.actualTier))
    .map((record, index) => ({
      ...record,
      index,
      billedTier: resolveBilledImageTier({
        submittedTier,
        actualTier: record.actualTier,
      }),
      billedSize: resolveBilledImageTier({
        submittedTier,
        actualTier: record.actualTier,
      }) === record.actualTier
        ? record.actualSize
        : record.requestedSize || input.payload.size || record.actualSize,
      billedQuality,
    }));

  return {
    statusCode: input.statusCode,
    body: responseBody,
    resolutionAudit,
    billingAuditRecords,
    requestMeta: {
      operation: input.operation,
      size: input.payload.size || null,
      upstreamRequestedSize: input.payload.size || null,
      responseFormat: resolveDownstreamImageResponseFormat(input.payload),
      storedResponseFormat: requestedResponseFormat || null,
      quality: input.payload.quality || null,
      requestedImageCount: input.payload.n || 1,
    },
  };
}

function imagePayloadOmission(value: string) {
  return `<image payload omitted: ${value.length} chars>`;
}

function isImagePayloadKey(key: string) {
  return key === 'b64_json'
    || key === 'bodyBinaryBase64'
    || key === 'partial_image_b64'
    || key === 'image_b64'
    || key === 'image_base64';
}

function compactSuccessfulImagePayloadForStorage(value: unknown, key = ''): unknown {
  if (typeof value === 'string') {
    if (isImagePayloadKey(key) || /^data:image\/[a-zA-Z0-9.+-]+;base64,/i.test(value)) {
      return imagePayloadOmission(value);
    }
    if ((key === 'bodyText' || key === 'raw') && value.length > 4096) {
      return `${value.slice(0, 2048)}...<truncated: ${value.length} chars>`;
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => compactSuccessfulImagePayloadForStorage(item));
  }
  if (!value || typeof value !== 'object') {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .map(([entryKey, entryValue]) => [
        entryKey,
        compactSuccessfulImagePayloadForStorage(entryValue, entryKey),
      ]),
  );
}

async function buildRecoverableImageResponsePayloadForStorage(input: {
  request?: any;
  taskId: string;
  responsePayload: Record<string, unknown> | null;
}) {
  const responsePayload = input.responsePayload;
  if (!responsePayload || typeof responsePayload !== 'object' || Array.isArray(responsePayload)) {
    return responsePayload;
  }
  const requestMeta = responsePayload.requestMeta && typeof responsePayload.requestMeta === 'object' && !Array.isArray(responsePayload.requestMeta)
    ? responsePayload.requestMeta as Record<string, unknown>
    : {};
  const body = responsePayload.body && typeof responsePayload.body === 'object' && !Array.isArray(responsePayload.body)
    ? responsePayload.body as Record<string, unknown>
    : null;
  if (requestMeta.responseFormat !== 'b64_json' || !body || !Array.isArray(body.data)) {
    return responsePayload;
  }

  const data = await Promise.all(body.data.map(async (item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return item;
    }
    const record = { ...item as Record<string, unknown> };
    if (typeof record.url === 'string' && record.url.trim()) {
      delete record.b64_json;
      return record;
    }
    const base64 = typeof record.b64_json === 'string' ? record.b64_json.trim() : '';
    if (!base64 || base64.startsWith('<image payload omitted:')) {
      return record;
    }
    const extension = detectImageExtension({
      result: base64,
      outputFormat: typeof body.output_format === 'string' ? body.output_format : undefined,
    });
    record.url = await persistGeneratedImageAndBuildUrl({
      request: input.request,
      taskId: input.taskId,
      imageIndex: index,
      base64,
      extension,
    });
    delete record.b64_json;
    return record;
  }));

  return {
    ...responsePayload,
    body: {
      ...body,
      data,
    },
    requestMeta: {
      ...requestMeta,
      responseFormat: 'b64_json',
      storedResponseFormat: 'url',
      recoverableFromUrl: true,
    },
  };
}

async function buildImageTaskQueryResponse(request: any, task: ImageGatewayTaskState) {
  const sharedTasks = task.status === 'queued' ? await listQueuedImageTasks() : [];
  const queuePosition = task.status === 'queued'
    ? sharedTasks
      .sort((left, right) => left.created_at - right.created_at)
      .findIndex((item) => item.task_id === task.task_id) + 1
    : 0;
  const baseTask = {
    ...sanitizeImageTaskForResponse(task),
    queue_position: queuePosition || undefined,
    queue_wait_ms: task.status === 'queued' ? Math.max(0, Date.now() - Number(task.created_at || Date.now())) : undefined,
  };
  if (!task.result || typeof task.result !== 'object' || Array.isArray(task.result)) {
    return baseTask;
  }
  const result = task.result as Record<string, unknown>;
  const requestMeta = result.requestMeta && typeof result.requestMeta === 'object' && !Array.isArray(result.requestMeta)
    ? result.requestMeta as Record<string, unknown>
    : {};
  if (requestMeta.responseFormat !== 'b64_json' || !result.body || typeof result.body !== 'object' || Array.isArray(result.body)) {
    return baseTask;
  }
  const body = result.body as Record<string, unknown>;
  if (!Array.isArray(body.data)) {
    return baseTask;
  }
  const convertedData = await rewriteImageDataItemsToRequestedFormat({
    request,
    taskId: task.task_id,
    data: body.data.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item)),
    responseFormat: 'b64_json',
    outputFormat: typeof body.output_format === 'string' ? body.output_format : undefined,
  });
  return {
    ...baseTask,
    result: sanitizePublicTaskResult({
      ...result,
      body: {
        ...body,
        data: convertedData,
      },
    }),
  };
}

function tryParseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function parseResponsesSsePayloads(text: string): unknown[] {
  const payloads: unknown[] = [];
  for (const block of text.split(/\n\s*\n/)) {
    const dataLines = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim())
      .filter((line) => line && line !== '[DONE]');
    if (!dataLines.length) {
      continue;
    }
    const parsed = tryParseJson(dataLines.join('\n'));
    if (parsed !== undefined) {
      payloads.push(parsed);
    }
  }
  return payloads;
}

function isPartialImageEvent(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  const eventType = String(record.type || record.event || '').trim().toLowerCase();
  return eventType.includes('partial_image');
}

function buildResponseCandidates(bodyJson: unknown, bodyText: string) {
  if (bodyJson !== undefined) {
    return isPartialImageEvent(bodyJson) ? [] : [bodyJson];
  }
  const ssePayloads = parseResponsesSsePayloads(bodyText);
  if (ssePayloads.length) {
    return ssePayloads.filter((payload) => !isPartialImageEvent(payload));
  }
  const parsed = tryParseJson(bodyText);
  return parsed === undefined || isPartialImageEvent(parsed) ? [] : [parsed];
}

function dedupeAndLimitImageDataItems(
  data: Array<Record<string, unknown>>,
  requestedImageCount?: number,
) {
  const limit = Number.isFinite(Number(requestedImageCount))
    ? Math.max(1, Math.floor(Number(requestedImageCount)))
    : Number.POSITIVE_INFINITY;
  const seen = new Set<string>();
  const unique: Array<Record<string, unknown>> = [];
  for (const item of data) {
    const url = typeof item.url === 'string' ? item.url : '';
    const imageUrl = typeof item.image_url === 'string' ? item.image_url : '';
    const b64Json = typeof item.b64_json === 'string' ? item.b64_json : '';
    const result = typeof item.result === 'string' ? item.result : '';
    const identity = url
      ? `url:${url}`
      : imageUrl
        ? `image_url:${imageUrl}`
        : b64Json
          ? `b64:${b64Json}`
          : result
            ? `result:${result}`
            : '';
    if (identity && seen.has(identity)) {
      continue;
    }
    if (identity) {
      seen.add(identity);
    }
    unique.push(item);
    if (unique.length >= limit) {
      break;
    }
  }
  return unique;
}

function buildNormalizedImageResponseEnvelope(input: {
  bodyJson?: unknown;
  data: Array<Record<string, unknown>>;
  outputFormat?: string;
  requestedSize?: string;
  requestedQuality?: string;
  requestedPrompt?: string;
  requestedBackground?: string;
}): NormalizedImageResponseBody {
  const source = input.bodyJson && typeof input.bodyJson === 'object' && !Array.isArray(input.bodyJson)
    ? input.bodyJson as Record<string, unknown>
    : {};
  const response: Record<string, unknown> = {};
  for (const key of ['created', 'usage', 'size', 'quality', 'background', 'output_format']) {
    if (source[key] !== undefined) {
      response[key] = source[key];
    }
  }
  response.created = Number(response.created || 0) || Math.floor(Date.now() / 1000);
  if (response.size === undefined && input.requestedSize) {
    response.size = input.requestedSize;
  }
  if (response.quality === undefined && input.requestedQuality) {
    response.quality = input.requestedQuality;
  }
  if (response.background === undefined && input.requestedBackground) {
    response.background = input.requestedBackground;
  }
  const actualOutputFormat = actualOutputFormatFromImageData(input.data);
  if (actualOutputFormat) {
    response.output_format = actualOutputFormat;
  } else if (response.output_format === undefined && input.outputFormat) {
    response.output_format = input.outputFormat;
  }
  const downstreamPrompt = typeof input.requestedPrompt === 'string' ? input.requestedPrompt : '';
  response.data = input.data.map((item) => {
    const nextItem = { ...item };
    delete nextItem.__actual_output_extension;
    // Upstream adapters can add provider-specific rewritten prompts. The
    // downstream contract always reflects the caller's original prompt.
    if (downstreamPrompt.trim()) {
      nextItem.revised_prompt = downstreamPrompt;
    } else {
      delete nextItem.revised_prompt;
    }
    return nextItem;
  });
  return response as NormalizedImageResponseBody;
}

function collectImageLikeOutputs(value: unknown, results: Array<Record<string, unknown>> = []) {
  if (!value || typeof value !== 'object') {
    return results;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectImageLikeOutputs(item, results);
    }
    return results;
  }

  const record = value as Record<string, unknown>;
  if (isPartialImageEvent(record)) {
    return results;
  }
  const result = typeof record.result === 'string' ? record.result : '';
  const b64Json = typeof record.b64_json === 'string' ? record.b64_json : '';
  const url = typeof record.url === 'string'
    ? record.url
    : typeof record.image_url === 'string'
      ? record.image_url
      : '';
  if (result || b64Json || url) {
    results.push(record);
  }

  for (const child of Object.values(record)) {
    collectImageLikeOutputs(child, results);
  }
  return results;
}

function collectBananaInlineDataParts(value: unknown, results: Array<{ mimeType: string; data: string }> = []) {
  if (!value || typeof value !== 'object') {
    return results;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectBananaInlineDataParts(item, results);
    }
    return results;
  }
  const record = value as Record<string, unknown>;
  const inline = record.inlineData || record.inline_data;
  if (inline && typeof inline === 'object' && !Array.isArray(inline)) {
    const inlineRecord = inline as Record<string, unknown>;
    const data = String(inlineRecord.data || '').replace(/\s+/g, '');
    const mimeType = String(inlineRecord.mimeType || inlineRecord.mime_type || 'image/png').trim();
    if (data && /^image\//i.test(mimeType)) {
      results.push({ mimeType, data });
    }
  }
  for (const child of Object.values(record)) {
    collectBananaInlineDataParts(child, results);
  }
  return results;
}

function hasBananaImageOutput(value: unknown) {
  return collectBananaInlineDataParts(value).length > 0;
}

function toOpenAIImageDataItem(item: Record<string, unknown>, responseFormat?: DownstreamImageResponseFormat) {
  const result = typeof item.result === 'string' ? item.result : '';
  const url = typeof item.url === 'string'
    ? item.url
    : typeof item.image_url === 'string'
      ? item.image_url
      : '';
  const b64Json = typeof item.b64_json === 'string' ? item.b64_json : '';
  const size = typeof item.size === 'string' ? item.size : undefined;
  const output: Record<string, unknown> = {};

  if (url) {
    output.url = url;
  } else if (result.startsWith('http://') || result.startsWith('https://')) {
    output.url = result;
  } else {
    const dataUrlMatch = result.match(/^data:image\/[a-zA-Z0-9.+-]+;base64,(.+)$/);
    const base64 = b64Json || (dataUrlMatch ? dataUrlMatch[1] : result);
    if (responseFormat === 'url' && (result.startsWith('http://') || result.startsWith('https://'))) {
      output.url = result;
    } else if (base64) {
      output.b64_json = base64;
    }
  }

  if (size) {
    output.size = size;
  }
  return output;
}

async function normalizeResponsesImageBody(input: {
  request: any;
  taskId: string;
  bodyJson?: unknown;
  bodyText: string;
  responseFormat?: DownstreamImageResponseFormat;
  outputFormat?: string;
  requestedImageCount?: number;
  requestedSize?: string;
  requestedQuality?: string;
  requestedPrompt?: string;
  requestedBackground?: string;
  allowDirectPublicImageUrl?: boolean;
}) {
  const candidates = buildResponseCandidates(input.bodyJson, input.bodyText);
  const imageItems = candidates.flatMap((candidate) => collectImageLikeOutputs(candidate));
  const normalizedData = imageItems
    .map((item) => ({
      raw: item,
      normalized: toOpenAIImageDataItem(item, input.responseFormat),
    }))
    .filter((item) => item.normalized.url || item.normalized.b64_json);

  const baseData = dedupeAndLimitImageDataItems(normalizedData.map((item) => {
    if (
      !item.normalized.url
      && item.normalized.b64_json
      && typeof item.raw.result === 'string'
      && /^data:image\//i.test(item.raw.result)
    ) {
      return {
        ...item.normalized,
        __result_hint: item.raw.result,
      };
    }
    return item.normalized;
  }) as Array<Record<string, unknown>>, input.requestedImageCount);

  const data = await rewriteImageDataItemsToRequestedFormat({
    request: input.request,
    taskId: input.taskId,
    data: baseData.map((item, index) => {
      const nextItem = { ...item };
      if (typeof nextItem.__result_hint === 'string' && nextItem.b64_json && !nextItem.url && input.responseFormat === 'url') {
        const extension = detectImageExtension({
          result: String(nextItem.__result_hint),
          outputFormat: input.outputFormat,
        });
        nextItem.__extension_hint = extension;
      }
      return nextItem;
    }),
    responseFormat: input.responseFormat,
    outputFormat: input.outputFormat,
    allowDirectPublicImageUrl: input.allowDirectPublicImageUrl,
  });

  if (!data.length) {
    return null;
  }
  return buildNormalizedImageResponseEnvelope({
    bodyJson: input.bodyJson,
    data,
    outputFormat: input.outputFormat,
    requestedSize: input.requestedSize,
    requestedQuality: input.requestedQuality,
    requestedPrompt: input.requestedPrompt,
    requestedBackground: input.requestedBackground,
  });
}

type PersistImageGatewayAttemptInput = {
  request?: any;
  taskId: string;
  requestId: string;
  accessContext: RequestAccessContext;
  payload: z.infer<typeof openAIImagesSchema>;
  requestPlanBody?: Record<string, unknown> | null;
  operation: 'generations' | 'edits';
  providerId: string;
  providerProtocol?: string;
  providerSource?: 'admin_managed' | 'user_supplied';
  providerBaseUrl?: string;
  status: 'completed' | 'failed';
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  responseStatusCode: number;
  responseBodyJson?: unknown;
  responseBodyText: string;
  responseContentType?: string;
  responseBodyBinaryBase64?: string;
  responseBodyBinaryExtension?: string;
  responseBodyBinaryFileName?: string;
  responseFormatOverride?: DownstreamImageResponseFormat;
  allowDirectPublicImageUrl?: boolean;
  errorPayload?: Record<string, unknown> | null;
  responsePayload?: Record<string, unknown> | null;
};

type ImageGatewayPersistenceOutboxPayload = {
  eventId: string;
  taskId: string;
  requestId: string;
  accessContext: RequestAccessContext;
  payload: z.infer<typeof openAIImagesSchema>;
  submittedSize?: string;
  submittedQuality?: string;
  operation: 'generations' | 'edits';
  providerId: string;
  providerProtocol?: string;
  providerSource?: 'admin_managed' | 'user_supplied';
  providerBaseUrl?: string;
  status: 'completed' | 'failed';
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  responsePayload: Record<string, unknown> | null;
  errorPayload?: Record<string, unknown> | null;
};

async function buildImageGatewayPersistenceOutboxPayload(input: PersistImageGatewayAttemptInput): Promise<ImageGatewayPersistenceOutboxPayload> {
  const responsePayload = input.responsePayload !== undefined
    ? input.responsePayload
    : await buildImageTaskResponsePayload({
        request: input.request,
        payload: input.payload,
        operation: input.operation,
        taskId: input.taskId,
        providerProtocol: input.providerProtocol,
        statusCode: input.responseStatusCode,
        bodyJson: input.responseBodyJson,
        bodyText: input.responseBodyText,
        responseContentType: input.responseContentType,
        bodyBinaryBase64: input.responseBodyBinaryBase64,
        bodyBinaryExtension: input.responseBodyBinaryExtension,
        bodyBinaryFileName: input.responseBodyBinaryFileName,
        responseFormatOverride: input.responseFormatOverride,
        allowDirectPublicImageUrl: input.allowDirectPublicImageUrl,
      });
  const recoverableResponsePayload = input.status === 'completed'
    ? await buildRecoverableImageResponsePayloadForStorage({
        request: input.request,
        taskId: input.taskId,
        responsePayload,
      })
    : responsePayload;
  const storedResponsePayload = compactSuccessfulImagePayloadForStorage(recoverableResponsePayload) as Record<string, unknown> | null;
  const storedPayload = compactSuccessfulImagePayloadForStorage(input.payload) as z.infer<typeof openAIImagesSchema>;

  return {
    eventId: stableOperationalId('outbox', input.taskId, 'image_gateway_persistence'),
    taskId: input.taskId,
    requestId: input.requestId,
    accessContext: input.accessContext,
    payload: storedPayload,
    submittedSize: resolveSubmittedImageSize({
      payload: input.payload,
      requestPlanBody: input.requestPlanBody,
    }),
    submittedQuality: resolveSubmittedImageQuality({
      payload: input.payload,
      requestPlanBody: input.requestPlanBody,
    }),
    operation: input.operation,
    providerId: input.providerId,
    providerProtocol: input.providerProtocol,
    providerSource: input.providerSource,
    providerBaseUrl: input.providerBaseUrl,
    status: input.status,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
    completedAt: input.completedAt,
    responsePayload: storedResponsePayload,
    errorPayload: input.errorPayload || null,
  };
}

async function buildImageGatewayPersistenceBundle(input: ImageGatewayPersistenceOutboxPayload): Promise<ImageGatewayPersistenceBundle> {
  const billing = input.status === 'completed'
    ? await buildActualImageBilling({
        taskId: input.taskId,
        requestId: input.requestId,
        payload: input.payload,
        submittedSize: input.submittedSize,
        submittedQuality: input.submittedQuality,
        operation: input.operation,
        upstreamId: input.providerId,
        providerProtocol: input.providerProtocol,
        accessContext: input.accessContext,
        responsePayload: input.responsePayload,
      })
    : { totalChargedCredits: 0, billedImages: 0, financeDetail: {}, billingRecords: [] as BillingLedgerRecord[] };
  const storedRequestPayload = compactSuccessfulImagePayloadForStorage({
    payload: input.payload,
    operation: input.operation,
  }) as Record<string, unknown>;

  return {
    eventId: input.eventId,
    billingRecords: billing.billingRecords || [],
    tenantFinanceLedger: input.accessContext.authMode === 'tenant_key' && billing.totalChargedCredits > 0
      ? {
          idempotencyKey: stableOperationalId('tenant_finance', input.taskId, 'image_charge'),
          tenantId: input.accessContext.tenantId,
          operatorId: `system:${input.accessContext.apiKeyId}`,
          direction: 'debit',
          amountCents: billing.totalChargedCredits,
          note: `图像生成扣费 ${input.operation} / ${input.taskId}`,
          currency: 'cny',
          detail: billing.financeDetail,
        }
      : null,
    taskRecord: {
      taskId: input.taskId,
      requestId: input.requestId,
      tenantId: input.accessContext.tenantId,
      apiKeyId: input.accessContext.apiKeyId,
      channelId: 'image_generation',
      upstreamId: input.providerId,
      operation: input.operation,
      status: input.status,
      providerId: input.providerId,
      providerSource: input.providerSource,
      providerBaseUrl: input.providerBaseUrl,
      model: input.payload.model,
      promptPreview: input.payload.prompt.slice(0, 120),
      createdAt: input.createdAt,
      updatedAt: input.updatedAt,
      completedAt: input.completedAt,
      requestPayload: storedRequestPayload,
      responsePayload: input.responsePayload,
      errorPayload: input.errorPayload || null,
      billedCredits: billing.totalChargedCredits,
    },
  };
}

async function applyImageGatewayPersistenceBundle(bundle: ImageGatewayPersistenceBundle) {
  await operationalRepository.applyImageGatewayPersistenceBundle(bundle);
}

async function enqueueImageGatewayPersistence(input: PersistImageGatewayAttemptInput) {
  const payload = await buildImageGatewayPersistenceOutboxPayload(input);
  if (!imagePersistenceOutboxEnabled) {
    const bundle = await buildImageGatewayPersistenceBundle(payload);
    await applyImageGatewayPersistenceBundle(bundle);
    return;
  }
  const now = Date.now();
  const event: OperationalOutboxEventRecord = {
    eventId: payload.eventId,
    eventType: 'image_gateway_persistence',
    idempotencyKey: `image_gateway_persistence:${input.taskId}`,
    status: 'pending',
    payload: payload as unknown as Record<string, unknown>,
    attemptCount: 0,
    availableAt: now,
    createdAt: now,
    updatedAt: now,
  };
  await operationalRepository.enqueueOperationalOutboxEvent(event);
  void processImagePersistenceOutbox();
}

let imagePersistenceOutboxRunning = false;

function parseImageGatewayPersistenceOutboxPayload(value: unknown): ImageGatewayPersistenceOutboxPayload | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const record = value as Partial<ImageGatewayPersistenceOutboxPayload>;
  if (!record.eventId || !record.taskId || !record.payload || !('responsePayload' in record)) {
    return null;
  }
  return record as ImageGatewayPersistenceOutboxPayload;
}

function imagePersistenceOutboxRetryDelayMs(attemptCount: number) {
  const base = Math.min(5 * 60_000, 2 ** Math.min(8, Math.max(0, attemptCount - 1)) * 1_000);
  return base + Math.floor(Math.random() * 500);
}

async function processImagePersistenceOutbox() {
  if (!imagePersistenceOutboxEnabled || imagePersistenceOutboxRunning) {
    return;
  }
  imagePersistenceOutboxRunning = true;
  const workerId = `image-persistence:${process.pid}`;
  try {
    const events = await operationalRepository.claimOperationalOutboxEvents({
      eventType: 'image_gateway_persistence',
      limit: imagePersistenceOutboxBatchSize,
      lockMs: imagePersistenceOutboxLockMs,
      workerId,
    });
    for (const event of events) {
      try {
        const outboxPayload = parseImageGatewayPersistenceOutboxPayload(event.payload);
        if (!outboxPayload) {
          throw new Error('invalid_image_persistence_outbox_payload');
        }
        const bundle = await buildImageGatewayPersistenceBundle(outboxPayload);
        await applyImageGatewayPersistenceBundle(bundle);
        await operationalRepository.markOperationalOutboxEventCompleted({
          eventId: event.eventId,
          workerId,
        });
      } catch (error) {
        requestLogWarn('image_persistence_outbox_event_failed', error);
        await operationalRepository.markOperationalOutboxEventFailed({
          eventId: event.eventId,
          workerId,
          error: error instanceof Error ? error.message : String(error),
          retryDelayMs: imagePersistenceOutboxRetryDelayMs(event.attemptCount),
          maxAttempts: imagePersistenceOutboxMaxAttempts,
        });
      }
    }
  } catch (error) {
    requestLogWarn('image_persistence_outbox_claim_failed', error);
  } finally {
    imagePersistenceOutboxRunning = false;
  }
}

async function createImageGatewayTask(input: {
  request?: any;
  operation: 'generations' | 'edits';
  providerId: string;
  providerBaseUrl?: string;
  requestPlan: unknown;
  accessContext: RequestAccessContext;
  payload: z.infer<typeof openAIImagesSchema>;
  requestHeaders: Record<string, string>;
  createdAt?: number;
}) {
  const now = Number(input.createdAt || Date.now());
  const taskId = createRuntimeTaskId('imgtask');
  const admission = await acquireAsyncQueueAdmission();
  if (!admission.allowed) {
    const error = new Error('Async image queue admission is busy.');
    (error as Error & { statusCode?: number; code?: string }).statusCode = 429;
    (error as Error & { statusCode?: number; code?: string }).code = 'async_queue_admission_busy';
    throw error;
  }
  let persistedAssets: Awaited<ReturnType<typeof persistAsyncTaskMultipartAssets>> | undefined;
  try {
    const queueState = await inspectAsyncQueueState(input.accessContext);
    if (queueState.totalQueuedCount >= asyncImageQueueMax || queueState.apiKeyQueuedCount >= asyncImageQueuePerApiKeyMax) {
      const error = new Error('Async image queue is full.');
      (error as Error & { statusCode?: number; code?: string }).statusCode = 429;
      (error as Error & { statusCode?: number; code?: string }).code = queueState.totalQueuedCount >= asyncImageQueueMax
        ? 'async_queue_full'
        : 'async_queue_per_key_full';
      throw error;
    }
    persistedAssets = await persistAsyncTaskMultipartAssets(input.request, taskId, input.payload);
    const record: ImageGatewayTaskState = {
      task_id: taskId,
      operation: input.operation,
      provider_id: input.providerId,
      status: 'queued',
      created_at: now,
      updated_at: now,
      queue_expires_at: now + asyncImageQueueWaitMs,
      request_plan: sanitizeRequestPlanForTaskState(input.requestPlan),
      result: null,
      error: null,
    };
    writeQueuedTaskInternalState(record, {
      payload: persistedAssets.payload,
      accessContext: input.accessContext,
      requestHeaders: input.requestHeaders,
      enqueuedAt: now,
      attemptCount: 0,
      assetDirectory: persistedAssets.assetDirectory || undefined,
      imageAssets: persistedAssets.imageAssets,
    });
    // Keep the admission reservation until this task is visible to every PM2 worker.
    await setImageTaskState(taskId, record, imageTaskHotTtlSeconds);
    void upsertTaskRecord({
      taskId,
      requestId: taskId,
      tenantId: input.accessContext.tenantId,
      apiKeyId: input.accessContext.apiKeyId,
      channelId: 'image_generation',
      upstreamId: input.providerId,
      operation: input.operation,
      status: 'queued',
      providerId: input.providerId,
      providerBaseUrl: input.providerBaseUrl,
      model: persistedAssets.payload.model,
      promptPreview: persistedAssets.payload.prompt.slice(0, 120),
      createdAt: now,
      updatedAt: now,
      requestPayload: {
        payload: compactSuccessfulImagePayloadForStorage(persistedAssets.payload),
        requestPlan: input.requestPlan,
      },
      responsePayload: null,
      errorPayload: null,
    });
    return record;
  } catch (error) {
    if (persistedAssets?.assetDirectory) {
      await fs.rm(persistedAssets.assetDirectory, { recursive: true, force: true }).catch((cleanupError) => {
        requestLogWarn('async_task_asset_admission_cleanup_failed', cleanupError);
      });
    }
    throw error;
  } finally {
    await releaseAsyncQueueAdmission(admission.key).catch((error) => requestLogWarn('async_queue_admission_release_failed', error));
  }
}

async function runImageGatewayTask(
  request: any,
  task: ImageGatewayTaskState,
  payload: z.infer<typeof openAIImagesSchema>,
  operation: 'generations' | 'edits',
  accessContext: RequestAccessContext,
  concurrencyKey: RuntimeConcurrencyLease | null,
  globalConcurrencyKey: RuntimeConcurrencyLease | null,
  taskClaimKey: string | null,
) {
  const taskId = task.task_id;
  task.status = 'running';
  task.started_at = Date.now();
  task.last_worker_id = `${process.pid}`;
  task.updated_at = Date.now();
  const internal = readQueuedTaskInternalState(task);
  if (internal) {
    internal.attemptCount += 1;
    writeQueuedTaskInternalState(task, internal);
  }
  await setImageTaskState(taskId, task, imageTaskHotTtlSeconds);

  try {
    const asyncMultipartSources = asyncTaskImageSourcesForPayload({
      assetDirectory: internal?.assetDirectory,
      imageAssets: internal?.imageAssets,
      payload,
    });
    if (payloadHasAsyncTaskImageAssets(payload) && !asyncMultipartSources?.length) {
      throw new Error('Async task reference image assets are unavailable.');
    }
    const result = await executeUpstreamImageRequest({
      request,
      payload,
      operation,
      accessContext,
      asyncTaskAssetDirectory: asyncMultipartSources?.length ? internal?.assetDirectory : undefined,
      asyncTaskImageAssets: asyncMultipartSources?.length ? internal?.imageAssets : undefined,
      streamBinaryResponseToUrl: true,
    });
    if (!result) {
      task.status = 'failed';
      task.error = {
        error: 'no_provider_available',
        message: 'No eligible image provider is currently available.',
      };
      task.updated_at = Date.now();
      await setImageTaskState(taskId, task, imageTaskHotTtlSeconds);
      void finalizeAsyncSubmissionTrace({
        source: 'tenant_runtime_async_complete',
        scope: 'full_chain',
        status: 'failed',
        summary: summarizeTrace(operation, undefined, false),
        createdAt: task.created_at,
        updatedAt: task.updated_at,
        requestId: taskId,
        taskId,
        tenantId: accessContext.tenantId,
        apiKeyId: accessContext.apiKeyId,
        channelId: imageChannelId,
        upstreamId: task.provider_id,
        operation,
        downstreamRequest: {
          headers: request.headers,
          payload,
        },
        downstreamResponse: {
          task_id: taskId,
          status: task.status,
        },
        upstreamRequest: task.request_plan as Record<string, unknown>,
        upstreamResponse: null,
        errorPayload: task.error as Record<string, unknown>,
        tags: ['runtime', 'async', 'completion'],
      });
      return;
    }

    task.provider_id = result.resolved.provider.providerId;
    task.status = result.response.ok ? 'completed' : 'failed';
    const downstreamError = result.response.ok
      ? null
      : buildUpstreamFailureEnvelope({
          statusCode: result.response.statusCode,
          bodyJson: result.response.bodyJson,
          bodyText: result.response.bodyText,
          providerId: result.resolved.provider.providerId,
          providerName: result.resolved.provider.name,
          providerBaseUrl: result.resolved.provider.baseUrl,
          routing: result.routing,
        });
    const taskResponsePayload = await buildImageTaskResponsePayload({
      request,
      payload: result.payload,
      operation,
      taskId,
      providerProtocol: result.resolved.provider.protocol,
      allowDirectPublicImageUrl: providerAllowsDirectPublicImageUrl(result.resolved.provider),
      statusCode: result.response.statusCode,
      bodyJson: result.response.bodyJson,
      bodyText: result.response.bodyText,
      responseContentType: result.response.contentType,
      bodyBinaryBase64: result.response.bodyBinaryBase64,
      bodyBinaryExtension: result.response.bodyBinaryExtension,
      bodyBinaryFileName: result.response.bodyBinaryFileName,
      responseFormatOverride: result.response.ok ? 'url' : undefined,
    });
    task.result = result.response.ok
      ? taskResponsePayload
      : {
          ...taskResponsePayload,
          body: downstreamError,
        };
    if (task.result && typeof task.result === 'object' && !Array.isArray(task.result)) {
      task.result = {
        ...task.result as Record<string, unknown>,
        routing: result.routing,
      };
    }
    task.error = downstreamError;
    task.updated_at = Date.now();
    await setImageTaskState(taskId, task, imageTaskHotTtlSeconds);
    if (result.response.ok) {
      void providerRegistry.reportAttempt({
        providerId: result.resolved.provider.providerId,
        ok: true,
        statusCode: result.response.statusCode,
        failedAt: task.updated_at,
        affectsHealth: false,
        latencyMs: latestProviderAttemptDurationMs(
          result.routing.provider_attempts || [],
          result.resolved.provider.providerId,
        ),
        passiveRecoveryReentry: result.resolved.passiveRecoveryReentry,
      }).catch((error) => {
        requestLogWarn('async_provider_success_report_failed', error);
      });
    }
    void enqueueImageGatewayPersistence({
      request,
      taskId,
      requestId: taskId,
      accessContext,
      payload: result.payload,
      requestPlanBody: result.resolved.requestPlan.body,
      operation,
      providerId: result.resolved.provider.providerId,
      providerProtocol: result.resolved.provider.protocol,
      allowDirectPublicImageUrl: providerAllowsDirectPublicImageUrl(result.resolved.provider),
      providerSource: result.resolved.provider.source,
      providerBaseUrl: result.resolved.provider.baseUrl,
      status: task.status,
      createdAt: task.created_at,
      updatedAt: task.updated_at,
      completedAt: task.status === 'completed' ? task.updated_at : undefined,
      responseStatusCode: result.response.statusCode,
      responseBodyJson: result.response.bodyJson,
      responseBodyText: result.response.bodyText,
      responseContentType: result.response.contentType,
      responseBodyBinaryBase64: result.response.bodyBinaryBase64,
      responseBodyBinaryExtension: result.response.bodyBinaryExtension,
      responseBodyBinaryFileName: result.response.bodyBinaryFileName,
      errorPayload: task.error && typeof task.error === 'object' ? task.error as Record<string, unknown> : null,
      responsePayload: taskResponsePayload,
    });
    const completionTracePayload: Parameters<typeof appendRequestTrace>[0] = {
      source: 'tenant_runtime_async_complete',
      scope: 'full_chain',
      status: result.response.ok ? 'success' : 'failed',
      summary: summarizeTrace(operation, result.response.statusCode, result.response.ok),
      createdAt: task.created_at,
      updatedAt: task.updated_at,
      failureCategory: result.response.ok ? undefined : String((task.error as Record<string, unknown> | null)?.failure_category || ''),
      statusCode: result.response.statusCode,
      requestId: taskId,
      taskId,
      tenantId: accessContext.tenantId,
      apiKeyId: accessContext.apiKeyId,
      channelId: imageChannelId,
      upstreamId: result.resolved.provider.providerId,
      upstreamName: result.resolved.provider.name,
      providerBaseUrl: result.resolved.provider.baseUrl,
      operation,
      downstreamRequest: {
        headers: request.headers,
        payload,
      },
      downstreamResponse: {
        task_id: taskId,
        status: task.status,
        result: task.result,
        routing: result.routing,
      },
      upstreamRequest: {
        url: result.resolved.requestPlan.url,
        method: result.resolved.requestPlan.method,
        headers: result.resolved.requestPlan.headers,
        bodyFormat: result.resolved.requestPlan.bodyFormat,
        body: result.resolved.requestPlan.body,
        routing: result.routing,
      },
      upstreamResponse: {
        ok: result.response.ok,
        statusCode: result.response.statusCode,
        contentType: result.response.contentType,
        bodyJson: result.response.bodyJson,
        bodyText: result.response.bodyText,
        bodyBinaryBase64: result.response.bodyBinaryBase64,
        bodyBinaryExtension: result.response.bodyBinaryExtension,
        bodyBinaryFileName: result.response.bodyBinaryFileName,
      },
      errorPayload: task.error && typeof task.error === 'object'
        ? { ...task.error as Record<string, unknown>, routing: result.routing }
        : null,
      tags: ['runtime', 'async', 'completion'],
    };
    void finalizeAsyncSubmissionTrace(
      result.response.ok
        ? compactSuccessfulImagePayloadForStorage(completionTracePayload) as Parameters<typeof appendRequestTrace>[0]
        : completionTracePayload,
    );
    void appendAuditRecord({
      actorType: 'system',
      actorId: 'image-gateway',
      action: 'image_task_completed',
      targetType: 'task',
      targetId: taskId,
      status: result.response.ok ? 'success' : 'failed',
      message: `Image task ${task.status}.`,
      detail: {
        operation,
        providerId: result.resolved.provider.providerId,
        statusCode: result.response.statusCode,
      },
    });
  } catch (error) {
    task.status = 'failed';
    task.error = error instanceof Error ? error.message : 'unknown_error';
    task.updated_at = Date.now();
    await setImageTaskState(taskId, task, imageTaskHotTtlSeconds);
    void upsertTaskRecord({
      taskId,
      requestId: taskId,
      tenantId: accessContext.tenantId,
      apiKeyId: accessContext.apiKeyId,
      channelId: 'image_generation',
      upstreamId: task.provider_id,
      operation,
      status: 'failed',
      providerId: task.provider_id,
      model: payload.model,
      promptPreview: payload.prompt.slice(0, 120),
      createdAt: task.created_at,
      updatedAt: task.updated_at,
      completedAt: task.updated_at,
      requestPayload: { payload, operation },
      responsePayload: {
        resolutionAudit: await buildImageResolutionAuditRecord({
          requestPayload: {
            size: payload.size,
            resolution: payload.size,
            aspect_ratio: payload.size,
          },
          responsePayload: null,
        }),
      },
      errorPayload: { message: task.error },
    });
    void finalizeAsyncSubmissionTrace({
      source: 'tenant_runtime_async_complete',
      scope: 'full_chain',
      status: 'failed',
      summary: summarizeTrace(operation, undefined, false),
      createdAt: task.created_at,
      updatedAt: task.updated_at,
      requestId: taskId,
      taskId,
      tenantId: accessContext.tenantId,
      apiKeyId: accessContext.apiKeyId,
      channelId: imageChannelId,
      upstreamId: task.provider_id,
      operation,
      downstreamRequest: {
        headers: request.headers,
        payload,
      },
      downstreamResponse: {
        task_id: taskId,
        status: 'failed',
      },
      upstreamRequest: task.request_plan as Record<string, unknown>,
      upstreamResponse: null,
      errorPayload: { message: task.error },
      tags: ['runtime', 'async', 'completion'],
    });
  } finally {
    if (internal?.assetDirectory) {
      await fs.rm(internal.assetDirectory, { recursive: true, force: true }).catch((error) => {
        requestLogWarn('async_task_asset_cleanup_failed', error);
      });
    }
    await releaseImageConcurrency(concurrencyKey, globalConcurrencyKey);
    await releaseAsyncTaskClaim(taskClaimKey);
  }
}

let asyncQueuePumpRunning = false;
let asyncQueueDispatchPaused = false;
const activeAsyncImageTaskRuns = new Set<Promise<void>>();

function startAsyncImageTaskRun(input: Parameters<typeof runImageGatewayTask>) {
  const run = runImageGatewayTask(...input);
  activeAsyncImageTaskRuns.add(run);
  void run
    .catch((error) => requestLogWarn('async_image_task_run_failed', error))
    .finally(() => activeAsyncImageTaskRuns.delete(run));
}

async function processAsyncImageQueue() {
  if (asyncQueuePumpRunning || asyncQueueDispatchPaused) {
    return;
  }
  asyncQueuePumpRunning = true;
  try {
    if (isDynamicOverloadProtectionActive()) {
      return;
    }
    const queuedTasks = (await listQueuedImageTasks())
      .sort((left, right) => left.created_at - right.created_at);

    let dispatched = 0;
    for (const queuedTask of queuedTasks) {
      if (dispatched >= asyncImageQueueDispatchPerTick) {
        break;
      }

      const claim = await acquireAsyncTaskClaim(queuedTask.task_id);
      if (!claim.allowed) {
        continue;
      }

      let started = false;
      try {
        const task = await getImageTaskState(queuedTask.task_id);
        if (!task || task.status !== 'queued') {
          continue;
        }

        const internal = readQueuedTaskInternalState(task);
        if (!internal) {
          await failQueuedImageTask({
            task,
            requestHeaders: {},
            payload: {
              model: 'gpt-image-2',
              prompt: 'invalid queued task',
            } as z.infer<typeof openAIImagesSchema>,
            accessContext: {
              tenantId: 'system',
              apiKeyId: 'system',
              authMode: 'admin_managed',
            },
            operation: task.operation,
            errorPayload: {
              error: 'queued_task_invalid',
              message: 'Queued task metadata is missing or invalid.',
              status_code: 500,
              failure_category: 'retryable_internal_error',
            },
          });
          continue;
        }

        if (Number(task.queue_expires_at || 0) > 0 && Number(task.queue_expires_at || 0) <= Date.now()) {
          await failQueuedImageTask({
            task,
            requestHeaders: internal.requestHeaders,
            payload: internal.payload,
            accessContext: internal.accessContext,
            operation: task.operation,
            errorPayload: {
              error: 'async_queue_timeout',
              message: 'The async image task waited too long in queue before execution.',
              status_code: 429,
              failure_category: 'retryable_overloaded',
            },
          });
          continue;
        }

        const apiKeyConcurrency = await acquireApiKeyConcurrency(internal.accessContext);
        if (!apiKeyConcurrency.allowed) {
          continue;
        }

        const globalConcurrency = await acquireGlobalImageConcurrency();
        if (!globalConcurrency.allowed) {
          await releaseApiKeyConcurrency(apiKeyConcurrency.key);
          break;
        }
        if (asyncQueueDispatchPaused) {
          await releaseImageConcurrency(apiKeyConcurrency.key, globalConcurrency.key);
          break;
        }

        started = true;
        dispatched += 1;
        startAsyncImageTaskRun([
          buildSyntheticQueuedRequest(internal.requestHeaders),
          task,
          internal.payload,
          task.operation,
          internal.accessContext,
          apiKeyConcurrency.key,
          globalConcurrency.key,
          claim.key,
        ]);
      } finally {
        if (!started) {
          await releaseAsyncTaskClaim(claim.key);
        }
      }
    }
  } finally {
    asyncQueuePumpRunning = false;
  }
}

setInterval(() => {
  void processAsyncImageQueue();
}, asyncImageQueuePollMs).unref();

setInterval(() => {
  void processImagePersistenceOutbox();
}, imagePersistenceOutboxPollMs).unref();

async function replyWithProxyResult(
  request: any,
  reply: any,
  accessContext: RequestAccessContext,
  payload: z.infer<typeof openAIImagesSchema>,
  operation: 'generations' | 'edits',
  result: Awaited<ReturnType<typeof executeUpstreamImageRequest>>,
  concurrencyKey: RuntimeConcurrencyLease | null,
  globalConcurrencyKey: RuntimeConcurrencyLease | null,
  startedAt: number,
) {
  if (!result) {
    await releaseImageConcurrency(concurrencyKey, globalConcurrencyKey);
    reply.code(503);
    return buildStandardDownstreamError({
      code: 'no_provider_available',
      message: 'No eligible image provider is currently available.',
      statusCode: 503,
      failureCategory: 'retryable_no_provider',
    });
  }

  const taskId = createRuntimeTaskId('imgsync');
  const submittedPayload = result.payload;
  const normalizedBody = result.resolved.provider.protocol === 'openai_responses' && result.response.ok
    ? await normalizeResponsesImageBody({
        request,
        taskId,
        bodyJson: result.response.bodyJson,
        bodyText: result.response.bodyText,
        responseFormat: resolveDownstreamImageResponseFormat(submittedPayload),
        outputFormat: String(submittedPayload.output_format || submittedPayload.extra_body?.output_format || 'png'),
        requestedImageCount: submittedPayload.n,
        requestedSize: submittedPayload.size,
        requestedQuality: submittedPayload.quality,
        requestedPrompt: payload.prompt,
        requestedBackground: typeof submittedPayload.extra_body?.background === 'string'
          ? submittedPayload.extra_body.background
          : undefined,
        allowDirectPublicImageUrl: providerAllowsDirectPublicImageUrl(result.resolved.provider),
      })
    : result.response.ok
      ? await normalizeStandardImageResponseBody({
          request,
          taskId,
          bodyJson: result.response.bodyJson,
          bodyText: result.response.bodyText,
          responseFormat: resolveDownstreamImageResponseFormat(submittedPayload),
          outputFormat: String(submittedPayload.output_format || submittedPayload.extra_body?.output_format || 'png'),
          requestedImageCount: submittedPayload.n,
          requestedSize: submittedPayload.size,
          requestedQuality: submittedPayload.quality,
          requestedPrompt: payload.prompt,
          requestedBackground: typeof submittedPayload.extra_body?.background === 'string'
            ? submittedPayload.extra_body.background
            : undefined,
          allowDirectPublicImageUrl: providerAllowsDirectPublicImageUrl(result.resolved.provider),
          responseContentType: result.response.contentType,
          bodyBinaryBase64: result.response.bodyBinaryBase64,
          bodyBinaryExtension: result.response.bodyBinaryExtension,
          bodyBinaryFileName: result.response.bodyBinaryFileName,
        })
      : null;
  const upstreamResponseBodyJson = normalizedBody || result.response.bodyJson;
  const upstreamResponseBodyText = normalizedBody ? '' : result.response.bodyText;
  const downstreamError = result.response.ok
    ? null
    : buildUpstreamFailureEnvelope({
        statusCode: result.response.statusCode,
        bodyJson: result.response.bodyJson,
        bodyText: result.response.bodyText,
        providerId: result.resolved.provider.providerId,
        providerName: result.resolved.provider.name,
        providerBaseUrl: result.resolved.provider.baseUrl,
        routing: result.routing,
      });
  const responseBodyJson = result.response.ok ? upstreamResponseBodyJson : downstreamError;
  const responseBodyText = result.response.ok ? upstreamResponseBodyText : '';
  if (result.response.ok) {
    void providerRegistry.reportAttempt({
      providerId: result.resolved.provider.providerId,
      ok: true,
      statusCode: result.response.statusCode,
      failedAt: Date.now(),
      affectsHealth: false,
      latencyMs: latestProviderAttemptDurationMs(
        result.routing.provider_attempts || [],
        result.resolved.provider.providerId,
      ),
      passiveRecoveryReentry: result.resolved.passiveRecoveryReentry,
    }).catch((error) => {
      requestLogWarn('async_provider_success_report_failed', error);
    });
  }
  const tracePayload: Parameters<typeof appendRequestTrace>[0] = {
    source: 'tenant_runtime_sync',
    scope: 'full_chain',
    status: result.response.ok ? 'success' : 'failed',
    summary: summarizeTrace(operation, result.response.statusCode, result.response.ok),
    createdAt: startedAt,
    failureCategory: result.response.ok ? undefined : String(downstreamError?.failure_category || ''),
    statusCode: result.response.statusCode,
    requestId: taskId,
    taskId,
    tenantId: accessContext.tenantId,
    apiKeyId: accessContext.apiKeyId,
    channelId: imageChannelId,
    upstreamId: result.resolved.provider.providerId,
    upstreamName: result.resolved.provider.name,
    providerBaseUrl: result.resolved.provider.baseUrl,
    operation,
    downstreamRequest: {
      headers: request.headers,
      payload,
    },
    downstreamResponse: responseBodyJson !== undefined
      ? { statusCode: result.response.statusCode, body: responseBodyJson }
      : { statusCode: result.response.statusCode, raw: responseBodyText },
    upstreamRequest: {
      url: result.resolved.requestPlan.url,
      method: result.resolved.requestPlan.method,
      headers: result.resolved.requestPlan.headers,
      bodyFormat: result.resolved.requestPlan.bodyFormat,
      body: result.resolved.requestPlan.body,
      routing: result.routing,
    },
    upstreamResponse: {
      ok: result.response.ok,
      statusCode: result.response.statusCode,
      contentType: result.response.contentType,
      bodyJson: result.response.bodyJson,
      bodyText: result.response.bodyText,
      bodyBinaryBase64: result.response.bodyBinaryBase64,
      bodyBinaryExtension: result.response.bodyBinaryExtension,
      bodyBinaryFileName: result.response.bodyBinaryFileName,
    },
    errorPayload: result.response.ok
      ? null
      : (downstreamError ? { ...downstreamError, upstream_response: result.response.bodyJson || result.response.bodyText, routing: result.routing } : null),
    tags: ['runtime', 'sync'],
  };
  const storedTracePayload = result.response.ok
    ? compactSuccessfulImagePayloadForStorage(tracePayload) as Parameters<typeof appendRequestTrace>[0]
    : tracePayload;
  if (result.response.ok) {
    void appendRequestTrace(storedTracePayload).catch((error) => {
      requestLogWarn('async_success_trace_write_failed', error);
    });
  } else {
    await appendRequestTrace(storedTracePayload);
  }

  const responsePayload = await buildImageTaskResponsePayload({
    request,
    payload: submittedPayload,
    operation,
    taskId,
    providerProtocol: result.resolved.provider.protocol,
    allowDirectPublicImageUrl: providerAllowsDirectPublicImageUrl(result.resolved.provider),
    statusCode: result.response.statusCode,
    bodyJson: responseBodyJson,
    bodyText: responseBodyText,
    responseContentType: result.response.contentType,
    bodyBinaryBase64: result.response.bodyBinaryBase64,
    bodyBinaryExtension: result.response.bodyBinaryExtension,
    bodyBinaryFileName: result.response.bodyBinaryFileName,
    normalizedBody: normalizedBody ?? undefined,
  });

  if (result.response.ok && wantsStreamingResponse(submittedPayload)) {
    const now = Date.now();
    await enqueueImageGatewayPersistence({
      taskId,
      requestId: taskId,
      accessContext,
      payload: submittedPayload,
      requestPlanBody: result.resolved.requestPlan.body,
      operation,
      providerId: result.resolved.provider.providerId,
      providerProtocol: result.resolved.provider.protocol,
      providerSource: result.resolved.provider.source,
      providerBaseUrl: result.resolved.provider.baseUrl,
      allowDirectPublicImageUrl: providerAllowsDirectPublicImageUrl(result.resolved.provider),
      status: 'completed',
      createdAt: startedAt,
      updatedAt: now,
      completedAt: now,
      responseStatusCode: result.response.statusCode,
      responseBodyJson,
      responseBodyText,
      responseContentType: result.response.contentType,
      responseBodyBinaryBase64: result.response.bodyBinaryBase64,
      responseBodyBinaryExtension: result.response.bodyBinaryExtension,
      responseBodyBinaryFileName: result.response.bodyBinaryFileName,
      errorPayload: null,
      responsePayload,
    });
    await releaseImageConcurrency(concurrencyKey, globalConcurrencyKey);
    return streamImageResultAsSse({
      reply,
      statusCode: result.response.statusCode,
      normalizedBody,
      operation,
    });
  }

  const now = Date.now();
  await enqueueImageGatewayPersistence({
    taskId,
    requestId: taskId,
    accessContext,
    payload: submittedPayload,
    requestPlanBody: result.resolved.requestPlan.body,
    operation,
    providerId: result.resolved.provider.providerId,
    providerProtocol: result.resolved.provider.protocol,
    providerSource: result.resolved.provider.source,
    providerBaseUrl: result.resolved.provider.baseUrl,
    allowDirectPublicImageUrl: providerAllowsDirectPublicImageUrl(result.resolved.provider),
    status: result.response.ok ? 'completed' : 'failed',
    createdAt: startedAt,
    updatedAt: now,
    completedAt: now,
    responseStatusCode: result.response.statusCode,
    responseBodyJson,
    responseBodyText,
    responseContentType: result.response.contentType,
    responseBodyBinaryBase64: result.response.bodyBinaryBase64,
    responseBodyBinaryExtension: result.response.bodyBinaryExtension,
    responseBodyBinaryFileName: result.response.bodyBinaryFileName,
    errorPayload: result.response.ok
      ? null
      : (downstreamError ? { ...downstreamError, upstream_response: result.response.bodyJson || result.response.bodyText } : null),
    responsePayload,
  });

  reply.code(result.response.statusCode);
  await releaseImageConcurrency(concurrencyKey, globalConcurrencyKey);
  if (!result.response.ok) {
    return downstreamError || buildStandardDownstreamError({
      code: 'upstream_request_failed',
      message: publicMessageForFailureCategory('terminal_unknown'),
      statusCode: result.response.statusCode || 502,
      failureCategory: 'terminal_unknown',
    });
  }
  if (responseBodyJson !== undefined) {
    return responseBodyJson;
  }
  return {
    raw: responseBodyText,
  };
}

// Fastify treats a colon after a parameter name as another parameter boundary.
// Restrict the model segment so the literal :generateContent suffix remains intact.
app.post('/v1beta/models/:model(^[^:]+):generateContent', async (request, reply) => {
  const requestStartedAt = Date.now();
  const params = z.object({ model: z.string().trim().min(1).max(240) }).parse(request.params);
  const payload = parseBananaPayload(params.model, request.body);
  validateOpenAIImagesPayloadLimits(payload);
  const { publicApi, imageChannel } = getImageChannelRuntimeConfig();
  if (!publicApi.enabled || publicApi.exposeGenerations === false || !imageChannel || imageChannel.enabled === false) {
    reply.code(503);
    return buildBananaNativeError(503, 'Image generation API is currently disabled.', 'UNAVAILABLE');
  }
  const accessResult = await resolveRequestAccessContext({
    ...(request.headers as Record<string, unknown>),
    'x-api-key': String(request.headers['x-goog-api-key'] || request.headers['x-api-key'] || ''),
  }, payload, request);
  if (!accessResult.granted) {
    reply.code(accessResult.statusCode);
    return buildBananaNativeError(accessResult.statusCode, accessResult.message, 'UNAUTHENTICATED');
  }
  const accessContext = accessResult.context;
  if (accessContext.authMode === 'tenant_key' && accessContext.downstreamImageApiType !== 'banana_images') {
    reply.code(403);
    return buildBananaNativeError(403, 'This API key is not configured for the Banana image interface.', 'PERMISSION_DENIED');
  }
  const imageSize = normalizeBananaImageSize(payload.extra_body?.banana_image_size)!;
  if (accessContext.authMode === 'tenant_key') {
    if (accessContext.bananaAllowedModels?.length && !accessContext.bananaAllowedModels.includes(payload.model)) {
      reply.code(403);
      return buildBananaNativeError(403, 'This API key is not allowed to use the requested Banana model.', 'PERMISSION_DENIED');
    }
    if (accessContext.bananaAllowedImageSizes?.length && !accessContext.bananaAllowedImageSizes.includes(imageSize)) {
      reply.code(403);
      return buildBananaNativeError(403, 'This API key is not allowed to use the requested Banana image size.', 'PERMISSION_DENIED');
    }
    const fixedPrice = resolveFixedApiKeyImageSellPriceCents(accessContext);
    if (fixedPrice <= 0 && resolveBananaImageSellPriceCents(payload.model) <= 0) {
      reply.code(422);
      return buildBananaNativeError(422, 'No Banana selling price is configured for this model.', 'FAILED_PRECONDITION');
    }
  }
  const budget = await ensureTenantPositiveBalance({ accessContext });
  if (!budget.allowed) {
    reply.code(402);
    return buildBananaNativeError(402, `Insufficient tenant balance. Current balance: ${formatCnyMinorUnits(Number(budget.balanceCents || 0), 2)} CNY.`, 'RESOURCE_EXHAUSTED');
  }
  const rateLimit = await consumeImageRateLimits(accessContext);
  if (!rateLimit.allowed || isDynamicOverloadProtectionActive()) {
    reply.header('Retry-After', '5');
    reply.code(429);
    return buildBananaNativeError(429, 'The image API is temporarily overloaded. Please retry.', 'RESOURCE_EXHAUSTED');
  }
  const concurrency = await acquireApiKeyConcurrency(accessContext);
  if (!concurrency.allowed) {
    reply.code(429);
    return buildBananaNativeError(429, 'The API key has reached its max concurrent image requests.', 'RESOURCE_EXHAUSTED');
  }
  const globalConcurrency = await acquireGlobalImageConcurrency();
  if (!globalConcurrency.allowed) {
    await releaseApiKeyConcurrency(concurrency.key);
    reply.code(429);
    return buildBananaNativeError(429, 'The image API has reached its global max concurrent request limit.', 'RESOURCE_EXHAUSTED');
  }
  const downstreamCancellation = createDownstreamCancellation({ request: request.raw, response: reply.raw });
  try {
    const result = await executeUpstreamImageRequest({
      request,
      payload,
      operation: payloadHasReferenceImages(payload) ? 'edits' : 'generations',
      accessContext,
      downstreamAbortSignal: downstreamCancellation.signal,
    });
    downstreamCancellation.dispose();
    const taskId = createRuntimeTaskId('banana');
    const statusCode = result?.response.statusCode || 503;
    const responseBody = result?.response.bodyJson;
    const ok = Boolean(result?.response.ok && responseBody);
    const failure = ok || !result
      ? null
      : classifyUpstreamFailure({
          statusCode,
          bodyJson: result.response.bodyJson,
          bodyText: result.response.bodyText,
        });
    const nativeError = ok
      ? null
      : buildBananaNativeError(
        statusCode,
        failure?.category === 'terminal_safety'
          ? publicMessageForFailureCategory(failure.category)
          : extractUpstreamErrorMessage({
              bodyJson: result?.response.bodyJson,
              bodyText: result?.response.bodyText,
            }),
        statusCode >= 500 ? 'UNAVAILABLE' : 'FAILED_PRECONDITION',
      );
    if (result) {
      const responsePayload = {
        statusCode,
        body: responseBody || nativeError,
        requestMeta: {
          protocol: 'banana_images',
          model: payload.model,
          imageSize,
          aspectRatio: payload.extra_body?.banana_aspect_ratio || null,
        },
      };
      void enqueueImageGatewayPersistence({
        taskId,
        requestId: taskId,
        accessContext,
        payload: result.payload,
        requestPlanBody: result.resolved.requestPlan.body,
        operation: payloadHasReferenceImages(payload) ? 'edits' : 'generations',
        providerId: result.resolved.provider.providerId,
        providerProtocol: result.resolved.provider.protocol,
        providerSource: result.resolved.provider.source,
        providerBaseUrl: result.resolved.provider.baseUrl,
        status: ok ? 'completed' : 'failed',
        createdAt: requestStartedAt,
        updatedAt: Date.now(),
        completedAt: ok ? Date.now() : undefined,
        responseStatusCode: statusCode,
        responseBodyJson: responseBody,
        responseBodyText: result.response.bodyText,
        responseContentType: result.response.contentType,
        errorPayload: nativeError,
        responsePayload,
      });
      const trace = {
        source: 'tenant_runtime_sync' as const,
        scope: 'full_chain' as const,
        status: ok ? 'success' as const : 'failed' as const,
        summary: `banana ${ok ? 'success' : 'failed'}`,
        createdAt: requestStartedAt,
        requestId: taskId,
        taskId,
        tenantId: accessContext.tenantId,
        apiKeyId: accessContext.apiKeyId,
        channelId: imageChannelId,
        upstreamId: result.resolved.provider.providerId,
        upstreamName: result.resolved.provider.name,
        providerBaseUrl: result.resolved.provider.baseUrl,
        operation: payloadHasReferenceImages(payload) ? 'edits' as const : 'generations' as const,
        statusCode,
        downstreamRequest: { headers: request.headers, payload: request.body as Record<string, unknown> },
        downstreamResponse: { statusCode, body: responseBody || nativeError },
        upstreamRequest: { ...result.resolved.requestPlan, routing: result.routing },
        upstreamResponse: { ok, statusCode, bodyJson: responseBody, bodyText: result.response.bodyText },
        errorPayload: nativeError,
        tags: ['runtime', 'sync', 'banana'],
      };
      void appendRequestTrace(ok ? compactSuccessfulImagePayloadForStorage(trace) as Parameters<typeof appendRequestTrace>[0] : trace);
      if (ok) {
        void providerRegistry.reportAttempt({
          providerId: result.resolved.provider.providerId,
          ok: true,
          statusCode,
          failedAt: Date.now(),
          affectsHealth: false,
          latencyMs: latestProviderAttemptDurationMs(result.routing.provider_attempts || [], result.resolved.provider.providerId),
          passiveRecoveryReentry: result.resolved.passiveRecoveryReentry,
        });
      }
    }
    await releaseImageConcurrency(concurrency.key, globalConcurrency.key);
    reply.code(statusCode);
    return ok ? responseBody : nativeError;
  } catch (error) {
    downstreamCancellation.dispose();
    await releaseImageConcurrency(concurrency.key, globalConcurrency.key);
    if (isDownstreamClientDisconnectedError(error)) {
      reply.hijack();
      return;
    }
    throw error;
  }
});

app.post('/v1/images/generations', { bodyLimit: imageRouteBodyLimitBytes }, async (request, reply) => {
  const requestStartedAt = Date.now();
  let payload = normalizePublicOpenAIImagesPayload(openAIImagesSchema.parse(
    await parseIncomingOpenAIImagesBody(request),
  ));
  validateOpenAIImagesPayloadLimits(payload);
  const { publicApi, imageChannel } = getImageChannelRuntimeConfig();
  if (!publicApi.enabled || publicApi.exposeGenerations === false) {
    reply.code(503);
    return imageEndpointError({
      code: 'public_api_disabled',
      message: 'Image generation API is currently disabled.',
      statusCode: 503,
      failureCategory: 'terminal_config',
    });
  }
  if (!imageChannel || imageChannel.enabled === false) {
    reply.code(503);
    return imageEndpointError({
      code: 'channel_disabled',
      message: 'Image generation channel is currently disabled.',
      statusCode: 503,
      failureCategory: 'terminal_config',
    });
  }
  const accessResult = await resolveRequestAccessContext(request.headers as Record<string, unknown>, payload, request);
  if (!accessResult.granted) {
    reply.code(accessResult.statusCode);
    return imageEndpointError({
      code: accessResult.error,
      message: accessResult.message,
      statusCode: accessResult.statusCode,
      failureCategory: 'terminal_auth',
    });
  }
  const accessContext = accessResult.context;
  if (accessContext.authMode === 'tenant_key' && accessContext.downstreamImageApiType === 'banana_images') {
    const errorPayload = imageApiTypeMismatchError('openai_images');
    reply.code(403);
    return errorPayload;
  }
  payload = applyImageQualityCapToPayload(payload, accessContext);
  const budget = await ensureTenantPositiveBalance({
    accessContext,
  });
  if (!budget.allowed) {
    const errorPayload = imageEndpointError({
      code: 'insufficient_balance',
      message: `Insufficient tenant balance. Current balance: ${formatCnyMinorUnits(Number(budget.balanceCents || 0), 2)} CNY.`,
      statusCode: 402,
      failureCategory: 'terminal_billing',
      details: {
        balance_minor_units: Number(budget.balanceCents || 0),
        balance_yuan: minorUnitsToYuan(Number(budget.balanceCents || 0)),
      },
    });
    await appendImageEndpointRejectionTrace({
      request,
      payload,
      operation: 'generations',
      accessContext,
      requestStartedAt,
      statusCode: 402,
      errorPayload,
      tags: ['billing'],
    });
    reply.code(402);
    return errorPayload;
  }
  const rateLimit = await consumeImageRateLimits(accessContext);
  if (!rateLimit.allowed) {
    reply.code(429);
    return imageEndpointError({
      code: 'rate_limit_exceeded',
      message: rateLimit.scope === 'global'
        ? `The image API has exceeded its global ${rateLimit.limit}/minute request limit.`
        : rateLimit.scope === 'tenant'
          ? `The tenant has exceeded its ${rateLimit.limit}/minute image request limit.`
          : `The API key has exceeded its ${rateLimit.limit}/minute image request limit.`,
      statusCode: 429,
      failureCategory: 'retryable_overloaded',
      details: {
        scope: rateLimit.scope,
        limit_per_minute: rateLimit.limit,
      },
    });
  }
  if (isDynamicOverloadProtectionActive()) {
    reply.header('Retry-After', '5');
    reply.code(429);
    return dynamicOverloadError();
  }
  if (payload.async) {
    const queueState = await inspectAsyncQueueState(accessContext);
    if (queueState.totalQueuedCount >= asyncImageQueueMax) {
      reply.code(429);
      return imageEndpointError({
        code: 'async_queue_full',
        message: 'The async image queue is currently full.',
        statusCode: 429,
        failureCategory: 'retryable_overloaded',
        details: {
          queue_limit: asyncImageQueueMax,
          queued_count: queueState.totalQueuedCount,
        },
      });
    }
    if (queueState.apiKeyQueuedCount >= asyncImageQueuePerApiKeyMax) {
      reply.code(429);
      return imageEndpointError({
        code: 'async_queue_per_key_full',
        message: 'The API key has reached its async queued task limit.',
        statusCode: 429,
        failureCategory: 'retryable_overloaded',
        details: {
          queue_limit: asyncImageQueuePerApiKeyMax,
          queued_count: queueState.apiKeyQueuedCount,
        },
      });
    }
    const preview = await buildSmartExecutionPreview({
      request,
      payload,
      operation: 'generations',
      accessContext,
    });
    const selectedCandidate = preview.candidates[0];
    if (!selectedCandidate) {
      reply.code(503);
      return imageEndpointError({
        code: 'no_provider_available',
        message: 'No eligible image provider is currently available.',
        statusCode: 503,
        failureCategory: 'retryable_no_provider',
      });
    }
    const task = await createImageGatewayTask({
      request,
      operation: 'generations',
      providerId: selectedCandidate.provider.providerId,
      providerBaseUrl: selectedCandidate.provider.baseUrl,
      requestPlan: { deferred: true },
      accessContext,
      payload,
      requestHeaders: pickAsyncTaskRequestHeaders(request),
      createdAt: requestStartedAt,
    });
    await appendRequestTrace({
      traceId: `trace_${task.task_id}_submit`,
      source: 'tenant_runtime_async_submit',
      scope: 'full_chain',
      status: 'accepted',
      summary: 'generations async accepted',
      createdAt: requestStartedAt,
      requestId: task.task_id,
      taskId: task.task_id,
      tenantId: accessContext.tenantId,
      apiKeyId: accessContext.apiKeyId,
      channelId: imageChannelId,
      upstreamId: selectedCandidate.provider.providerId,
      upstreamName: selectedCandidate.provider.name,
      providerBaseUrl: selectedCandidate.provider.baseUrl,
      operation: 'generations',
      downstreamRequest: {
        headers: request.headers,
        payload,
      },
      downstreamResponse: {
        task_id: task.task_id,
        status: task.status,
        provider_id: task.provider_id,
        query_path: `/v1/images/generations/${task.task_id}`,
        queue_position: queueState.totalQueuedCount + 1,
      },
      upstreamRequest: { deferred: true },
      upstreamResponse: null,
      errorPayload: null,
      tags: ['runtime', 'async', 'submit'],
    });
    void processAsyncImageQueue();
    reply.code(202);
    return {
      task_id: task.task_id,
      status: task.status,
      query_path: `/v1/images/generations/${task.task_id}`,
      queue_position: queueState.totalQueuedCount + 1,
      queue_expires_at: task.queue_expires_at,
    };
  }

  const concurrency = await acquireApiKeyConcurrency(accessContext);
  if (!concurrency.allowed) {
    reply.code(429);
    return imageEndpointError({
      code: 'concurrency_limit_reached',
      message: 'The API key has reached its max concurrent image requests.',
      statusCode: 429,
      failureCategory: 'retryable_overloaded',
    });
  }
  const globalConcurrency = await acquireGlobalImageConcurrency();
  if (!globalConcurrency.allowed) {
    await releaseApiKeyConcurrency(concurrency.key);
    reply.code(429);
    return imageEndpointError({
      code: 'global_concurrency_limit_reached',
      message: 'The image API has reached its global max concurrent request limit.',
      statusCode: 429,
      failureCategory: 'retryable_overloaded',
      details: {
        limit: globalConcurrency.max,
      },
    });
  }

  const downstreamCancellation = createDownstreamCancellation({ request: request.raw, response: reply.raw });
  try {
    const result = await executeUpstreamImageRequest({
      request,
      payload,
      operation: 'generations',
      accessContext,
      downstreamAbortSignal: downstreamCancellation.signal,
    });
    downstreamCancellation.dispose();
    return await replyWithProxyResult(
      request,
      reply,
      accessContext,
      payload,
      'generations',
      result,
      concurrency.key,
      globalConcurrency.key,
      requestStartedAt,
    );
  } catch (error) {
    downstreamCancellation.dispose();
    await releaseImageConcurrency(concurrency.key, globalConcurrency.key);
    if (isDownstreamClientDisconnectedError(error)) {
      reply.hijack();
      return;
    }
    throw error;
  }
});

app.post('/v1/images/edits', { bodyLimit: imageRouteBodyLimitBytes }, async (request, reply) => {
  const requestStartedAt = Date.now();
  let payload = normalizePublicOpenAIImagesPayload(openAIImagesSchema.parse(
    await parseIncomingOpenAIImagesBody(request),
  ));
  validateOpenAIImagesPayloadLimits(payload);
  payload = withRequestedEditProtocolHint(payload, inferRequestedEditProtocol({
    request,
    payload,
    operation: 'edits',
  }));
  const { publicApi, imageChannel } = getImageChannelRuntimeConfig();
  if (!publicApi.enabled || publicApi.exposeEdits === false) {
    reply.code(503);
    return imageEndpointError({
      code: 'public_api_disabled',
      message: 'Image edit API is currently disabled.',
      statusCode: 503,
      failureCategory: 'terminal_config',
    });
  }
  if (!imageChannel || imageChannel.enabled === false) {
    reply.code(503);
    return imageEndpointError({
      code: 'channel_disabled',
      message: 'Image generation channel is currently disabled.',
      statusCode: 503,
      failureCategory: 'terminal_config',
    });
  }
  const accessResult = await resolveRequestAccessContext(request.headers as Record<string, unknown>, payload, request);
  if (!accessResult.granted) {
    reply.code(accessResult.statusCode);
    return imageEndpointError({
      code: accessResult.error,
      message: accessResult.message,
      statusCode: accessResult.statusCode,
      failureCategory: 'terminal_auth',
    });
  }
  const accessContext = accessResult.context;
  if (accessContext.authMode === 'tenant_key' && accessContext.downstreamImageApiType === 'banana_images') {
    const errorPayload = imageApiTypeMismatchError('openai_images');
    reply.code(403);
    return errorPayload;
  }
  payload = applyImageQualityCapToPayload(payload, accessContext);
  const budget = await ensureTenantPositiveBalance({
    accessContext,
  });
  if (!budget.allowed) {
    const errorPayload = imageEndpointError({
      code: 'insufficient_balance',
      message: `Insufficient tenant balance. Current balance: ${formatCnyMinorUnits(Number(budget.balanceCents || 0), 2)} CNY.`,
      statusCode: 402,
      failureCategory: 'terminal_billing',
      details: {
        balance_minor_units: Number(budget.balanceCents || 0),
        balance_yuan: minorUnitsToYuan(Number(budget.balanceCents || 0)),
      },
    });
    await appendImageEndpointRejectionTrace({
      request,
      payload,
      operation: 'edits',
      accessContext,
      requestStartedAt,
      statusCode: 402,
      errorPayload,
      tags: ['billing'],
    });
    reply.code(402);
    return errorPayload;
  }
  const rateLimit = await consumeImageRateLimits(accessContext);
  if (!rateLimit.allowed) {
    reply.code(429);
    return imageEndpointError({
      code: 'rate_limit_exceeded',
      message: rateLimit.scope === 'global'
        ? `The image API has exceeded its global ${rateLimit.limit}/minute request limit.`
        : rateLimit.scope === 'tenant'
          ? `The tenant has exceeded its ${rateLimit.limit}/minute image request limit.`
          : `The API key has exceeded its ${rateLimit.limit}/minute image request limit.`,
      statusCode: 429,
      failureCategory: 'retryable_overloaded',
      details: {
        scope: rateLimit.scope,
        limit_per_minute: rateLimit.limit,
      },
    });
  }
  if (isDynamicOverloadProtectionActive()) {
    reply.header('Retry-After', '5');
    reply.code(429);
    return dynamicOverloadError();
  }
  if (payload.async) {
    const queueState = await inspectAsyncQueueState(accessContext);
    if (queueState.totalQueuedCount >= asyncImageQueueMax) {
      reply.code(429);
      return imageEndpointError({
        code: 'async_queue_full',
        message: 'The async image queue is currently full.',
        statusCode: 429,
        failureCategory: 'retryable_overloaded',
        details: {
          queue_limit: asyncImageQueueMax,
          queued_count: queueState.totalQueuedCount,
        },
      });
    }
    if (queueState.apiKeyQueuedCount >= asyncImageQueuePerApiKeyMax) {
      reply.code(429);
      return imageEndpointError({
        code: 'async_queue_per_key_full',
        message: 'The API key has reached its async queued task limit.',
        statusCode: 429,
        failureCategory: 'retryable_overloaded',
        details: {
          queue_limit: asyncImageQueuePerApiKeyMax,
          queued_count: queueState.apiKeyQueuedCount,
        },
      });
    }
    const preview = await buildSmartExecutionPreview({
      request,
      payload,
      operation: 'edits',
      accessContext,
    });
    const selectedCandidate = preview.candidates[0];
    if (!selectedCandidate) {
      reply.code(503);
      return imageEndpointError({
        code: 'no_provider_available',
        message: 'No eligible image edit provider is currently available.',
        statusCode: 503,
        failureCategory: 'retryable_no_provider',
      });
    }
    const task = await createImageGatewayTask({
      request,
      operation: 'edits',
      providerId: selectedCandidate.provider.providerId,
      providerBaseUrl: selectedCandidate.provider.baseUrl,
      requestPlan: { deferred: true },
      accessContext,
      payload,
      requestHeaders: pickAsyncTaskRequestHeaders(request),
      createdAt: requestStartedAt,
    });
    await appendRequestTrace({
      traceId: `trace_${task.task_id}_submit`,
      source: 'tenant_runtime_async_submit',
      scope: 'full_chain',
      status: 'accepted',
      summary: 'edits async accepted',
      createdAt: requestStartedAt,
      requestId: task.task_id,
      taskId: task.task_id,
      tenantId: accessContext.tenantId,
      apiKeyId: accessContext.apiKeyId,
      channelId: imageChannelId,
      upstreamId: selectedCandidate.provider.providerId,
      upstreamName: selectedCandidate.provider.name,
      providerBaseUrl: selectedCandidate.provider.baseUrl,
      operation: 'edits',
      downstreamRequest: {
        headers: request.headers,
        payload,
      },
      downstreamResponse: {
        task_id: task.task_id,
        status: task.status,
        provider_id: task.provider_id,
        query_path: `/v1/images/edits/${task.task_id}`,
        queue_position: queueState.totalQueuedCount + 1,
      },
      upstreamRequest: { deferred: true },
      upstreamResponse: null,
      errorPayload: null,
      tags: ['runtime', 'async', 'submit'],
    });
    void processAsyncImageQueue();
    reply.code(202);
    return {
      task_id: task.task_id,
      status: task.status,
      query_path: `/v1/images/edits/${task.task_id}`,
      queue_position: queueState.totalQueuedCount + 1,
      queue_expires_at: task.queue_expires_at,
    };
  }

  const concurrency = await acquireApiKeyConcurrency(accessContext);
  if (!concurrency.allowed) {
    reply.code(429);
    return imageEndpointError({
      code: 'concurrency_limit_reached',
      message: 'The API key has reached its max concurrent image requests.',
      statusCode: 429,
      failureCategory: 'retryable_overloaded',
    });
  }
  const globalConcurrency = await acquireGlobalImageConcurrency();
  if (!globalConcurrency.allowed) {
    await releaseApiKeyConcurrency(concurrency.key);
    reply.code(429);
    return imageEndpointError({
      code: 'global_concurrency_limit_reached',
      message: 'The image API has reached its global max concurrent request limit.',
      statusCode: 429,
      failureCategory: 'retryable_overloaded',
      details: {
        limit: globalConcurrency.max,
      },
    });
  }

  const downstreamCancellation = createDownstreamCancellation({ request: request.raw, response: reply.raw });
  try {
    const result = await executeUpstreamImageRequest({
      request,
      payload,
      operation: 'edits',
      accessContext,
      downstreamAbortSignal: downstreamCancellation.signal,
    });
    downstreamCancellation.dispose();
    return await replyWithProxyResult(
      request,
      reply,
      accessContext,
      payload,
      'edits',
      result,
      concurrency.key,
      globalConcurrency.key,
      requestStartedAt,
    );
  } catch (error) {
    downstreamCancellation.dispose();
    await releaseImageConcurrency(concurrency.key, globalConcurrency.key);
    if (isDownstreamClientDisconnectedError(error)) {
      reply.hijack();
      return;
    }
    throw error;
  }
});

app.get('/v1/images/generations/:taskId', async (request, reply) => {
  const params = z.object({ taskId: z.string().min(1) }).parse(request.params);
  const task = await getImageTaskState(params.taskId);
  if (!task) {
    reply.code(404);
    return isRuntimeTaskIdExpired(params.taskId)
      ? imageTaskExpiredPayload('Image generation task query window expired.')
      : { error: 'task_not_found', message: 'Image generation task not found.' };
  }
  if (task.operation !== 'generations') {
    reply.code(404);
    return { error: 'task_not_found', message: 'Image generation task not found.' };
  }
  if (isTaskExpired(task)) {
    reply.code(404);
    return imageTaskExpiredPayload('Image generation task query window expired.');
  }
  return buildImageTaskQueryResponse(request, task);
});

app.get('/v1/images/edits/:taskId', async (request, reply) => {
  const params = z.object({ taskId: z.string().min(1) }).parse(request.params);
  const task = await getImageTaskState(params.taskId);
  if (!task) {
    reply.code(404);
    return isRuntimeTaskIdExpired(params.taskId)
      ? imageTaskExpiredPayload('Image edit task query window expired.')
      : { error: 'task_not_found', message: 'Image edit task not found.' };
  }
  if (task.operation !== 'edits') {
    reply.code(404);
    return { error: 'task_not_found', message: 'Image edit task not found.' };
  }
  if (isTaskExpired(task)) {
    reply.code(404);
    return imageTaskExpiredPayload('Image edit task query window expired.');
  }
  return buildImageTaskQueryResponse(request, task);
});

app.get('/v1/image/tasks/:taskId', async (request, reply) => {
  const params = z.object({ taskId: z.string().min(1) }).parse(request.params);
  const task = await getImageTaskState(params.taskId);
  if (!task) {
    reply.code(404);
    return isRuntimeTaskIdExpired(params.taskId)
      ? imageTaskExpiredPayload('Image task query window expired.')
      : { error: 'task_not_found', message: 'Image task not found.' };
  }
  if (isTaskExpired(task)) {
    reply.code(404);
    return imageTaskExpiredPayload('Image task query window expired.');
  }
  return buildImageTaskQueryResponse(request, task);
});

function resolveOpenAICompatibleEndpoint(baseUrl: string, pathName: string) {
  const base = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!base) {
    return '';
  }
  if (pathName === '/v1/chat/completions') {
    return base;
  }
  return base ? `${base}${pathName}` : '';
}

async function getCanvasChatProviders() {
  const catalog = adminConsoleCatalogStore.get();
  const textChannel = catalog.channels.find((item) => item.id === textChannelId);
  const upstreamById = new Map(catalog.upstreams.map((upstream) => [upstream.id, upstream]));
  const allowed = new Set(textChannel?.upstreamIds || []);
  const policyByUpstreamId = new Map((textChannel?.upstreamPolicies || []).map((policy) => [policy.upstreamId, policy]));
  const configuredProviders = providerRegistry.list()
    .filter((provider) => provider.protocol === 'openai_chat')
    .filter((provider) => !allowed.size || allowed.has(provider.providerId));
  await refreshHotProviderRuntime(configuredProviders.map((provider) => provider.providerId));
  const now = Date.now();
  const enabledProviders = providerRegistry.list()
    .filter((provider) => provider.protocol === 'openai_chat')
    .filter((provider) => provider.healthState !== 'disabled')
    .filter((provider) => !allowed.size || allowed.has(provider.providerId));
  const eligibleProviders = enabledProviders.filter((provider) => {
    const runtime = provider.metadata?.runtime as { cooldownUntil?: unknown; fusedUntil?: unknown } | undefined;
    return Math.max(Number(runtime?.cooldownUntil || 0), Number(runtime?.fusedUntil || 0)) <= now;
  });
  return (eligibleProviders.length ? eligibleProviders : enabledProviders)
    .sort((left, right) => (
      Number(right.healthScore || 0) - Number(left.healthScore || 0)
      || Number(left.priority || 100) - Number(right.priority || 100)
    ))
    .map((provider) => ({
      provider,
      policy: policyByUpstreamId.get(provider.providerId) || null,
      upstream: upstreamById.get(provider.providerId),
    }));
}

type ChatRequestAccessResult =
  | { granted: true; context: RequestAccessContext }
  | { granted: false; statusCode: 401 | 402 | 403; error: string; message: string };

async function resolveChatRequestAccessContext(
  headers: Record<string, unknown>,
  providerSource: 'user_supplied' | 'admin_managed',
  sellPriceCents: number,
  request?: any,
): Promise<ChatRequestAccessResult> {
  const controlPlane = adminControlPlaneStore.get();
  const authPolicy = controlPlane.publicApi.authMode;
  if (request && isInternalCanvasWorkerRequest(request)) {
    const internalApiKeyId = String(headers['x-yali-internal-api-key-id'] || '').trim();
    const internalTenantId = String(headers['x-yali-internal-tenant-id'] || '').trim();
    if (internalApiKeyId) {
      const catalogIndex = adminConsoleCatalogStore.getRuntimeIndex();
      const apiKey = catalogIndex.activeApiKeyById.get(internalApiKeyId) || null;
      if (!apiKey) {
        return {
          granted: false,
          statusCode: 401,
          error: 'invalid_internal_api_key',
          message: 'The internal canvas API key context is invalid or has been disabled.',
        };
      }
      const tenant = catalogIndex.tenantById.get(apiKey.tenantId) || null;
      if (!tenant || tenant.status !== 'active') {
        return {
          granted: false,
          statusCode: 403,
          error: 'internal_tenant_inactive',
          message: 'The tenant associated with this internal canvas API key is inactive.',
        };
      }
      if (internalTenantId && internalTenantId !== tenant.id) {
        return {
          granted: false,
          statusCode: 403,
          error: 'internal_tenant_mismatch',
          message: 'The internal canvas tenant context does not match the API key tenant.',
        };
      }
      const channelAllowed = apiKey.allowedChannelIds.includes(textChannelId)
        && tenant.allowedChannelIds.includes(textChannelId);
      if (!channelAllowed) {
        return {
          granted: false,
          statusCode: 403,
          error: 'channel_not_allowed',
          message: 'This internal canvas API key does not have access to the Chat Completions channel.',
        };
      }
      if (sellPriceCents > 0) {
        const balance = await operationalRepository.getTenantFinanceBalance(tenant.id, 'cny');
        const balanceCents = Number(balance?.balanceCents || 0);
        if (balanceCents <= 0) {
          return {
            granted: false,
            statusCode: 402,
            error: 'insufficient_balance',
            message: `Insufficient tenant balance. Current balance: ${formatCnyMinorUnits(balanceCents, 2)} CNY.`,
          };
        }
      }
      return {
        granted: true,
        context: {
          tenantId: tenant.id,
          apiKeyId: apiKey.id,
          authMode: 'tenant_key',
          tenantRequestLimitPerMinute: Number(tenant.requestLimitPerMinute || 0),
          requestLimitPerMinute: Number(apiKey.requestLimitPerMinute || 0),
        },
      };
    }
    return {
      granted: true,
      context: {
        tenantId: 'canvas-worker',
        apiKeyId: 'canvas-worker',
        authMode: 'admin_managed',
      },
    };
  }
  if (providerSource === 'user_supplied') {
    if (!controlPlane.routing.allowUserSuppliedKey) {
      return {
        granted: false,
        statusCode: 403,
        error: 'user_supplied_provider_disabled',
        message: 'User supplied upstream keys are disabled by the platform.',
      };
    }
    return {
      granted: true,
      context: {
        tenantId: 'user-supplied',
        apiKeyId: 'user-supplied',
        authMode: 'user_supplied',
      },
    };
  }

  if (authPolicy === 'disabled') {
    return {
      granted: true,
      context: {
        tenantId: 'admin-managed',
        apiKeyId: 'admin-managed',
        authMode: 'admin_managed',
      },
    };
  }

  const token = parseBearerToken(headers.authorization) || String(headers['x-api-key'] || '').trim();
  if (authPolicy === 'admin_key') {
    if (!token) {
      return {
        granted: false,
        statusCode: 401,
        error: 'auth_required',
        message: 'API key is required. Provide a Bearer token or X-API-Key header.',
      };
    }
    return {
      granted: true,
      context: {
        tenantId: 'admin-managed',
        apiKeyId: 'admin-managed',
        authMode: 'admin_managed',
      },
    };
  }

  if (!token) {
    return {
      granted: false,
      statusCode: 401,
      error: 'auth_required',
      message: 'API key is required. Provide a Bearer token or X-API-Key header.',
    };
  }

  const catalogIndex = adminConsoleCatalogStore.getRuntimeIndex();
  let apiKey = catalogIndex.activeApiKeyByRawKey.get(token) || null;
  if (!apiKey) {
    const hash = crypto.createHash('sha256').update(token).digest('hex');
    apiKey = catalogIndex.activeApiKeyByHash.get(hash) || null;
  }
  if (!apiKey) {
    return {
      granted: false,
      statusCode: 401,
      error: 'invalid_api_key',
      message: 'The provided API key is invalid or has been disabled.',
    };
  }

  const tenant = catalogIndex.tenantById.get(apiKey.tenantId) || null;
  if (!tenant || tenant.status !== 'active') {
    return {
      granted: false,
      statusCode: 403,
      error: 'tenant_inactive',
      message: 'The tenant associated with this API key is inactive.',
    };
  }

  const channelAllowed = apiKey.allowedChannelIds.includes(textChannelId)
    && tenant.allowedChannelIds.includes(textChannelId);
  if (!channelAllowed) {
    return {
      granted: false,
      statusCode: 403,
      error: 'channel_not_allowed',
      message: 'This API key does not have access to the Chat Completions channel.',
    };
  }

  if (sellPriceCents > 0) {
    const balance = await operationalRepository.getTenantFinanceBalance(tenant.id, 'cny');
    const balanceCents = Number(balance?.balanceCents || 0);
    if (balanceCents <= 0) {
      return {
        granted: false,
        statusCode: 402,
        error: 'insufficient_balance',
        message: `Insufficient tenant balance. Current balance: ${formatCnyMinorUnits(balanceCents, 2)} CNY.`,
      };
    }
  }

  return {
    granted: true,
    context: {
      tenantId: tenant.id,
      apiKeyId: apiKey.id,
      authMode: 'tenant_key',
      tenantRequestLimitPerMinute: Number(tenant.requestLimitPerMinute || 0),
      requestLimitPerMinute: Number(apiKey.requestLimitPerMinute || 0),
    },
  };
}

async function recordChatCompletionCharge(input: {
  requestId: string;
  accessContext: RequestAccessContext;
  attempt: {
    providerId: string;
    providerName: string;
    providerBaseUrl: string;
    upstreamCostYuan: number;
  };
  model: string;
  sellPriceCents: number;
  responseStatusCode: number;
}) {
  if (input.accessContext.authMode !== 'tenant_key' || input.sellPriceCents <= 0) {
    return;
  }
  const detail = {
    source: 'chat_completions_request_charge',
    requestId: input.requestId,
    taskId: input.requestId,
    operation: 'chat_completions',
    protocol: 'openai_chat',
    protocolLabel: 'Chat Completions',
    billingMode: 'global_chat_completions_unit_price',
    billingModeLabel: 'Chat Completions 按次计费',
    sellPriceCents: input.sellPriceCents,
    upstreamCostYuan: Math.max(0, Number(input.attempt.upstreamCostYuan || 0)),
    upstreamCostMinorUnits: yuanToMinorUnits(Math.max(0, Number(input.attempt.upstreamCostYuan || 0))),
    upstreamName: input.attempt.providerName,
    upstreamBaseUrl: input.attempt.providerBaseUrl,
    responseStatusCode: input.responseStatusCode,
  };
  const now = Date.now();
  const billingRecord: BillingLedgerRecord = {
    id: stableOperationalId('billing', input.requestId, 'chat_charge'),
    createdAt: now,
    updatedAt: now,
    status: input.sellPriceCents > 0 ? 'charged' : 'voided',
    tenantId: input.accessContext.tenantId,
    apiKeyId: input.accessContext.apiKeyId,
    channelId: textChannelId,
    upstreamId: input.attempt.providerId,
    requestId: input.requestId,
    taskId: input.requestId,
    operation: 'chat_completions',
    currency: 'cny',
    reservedCredits: input.sellPriceCents,
    chargedCredits: input.sellPriceCents,
    model: input.model,
    detail,
  };
  await applyBillingChargePersistenceBundle({
    billingRecords: [billingRecord],
    tenantFinanceLedger: {
      idempotencyKey: stableOperationalId('tenant_finance', input.requestId, 'chat_charge'),
      tenantId: input.accessContext.tenantId,
      operatorId: `system:${input.accessContext.apiKeyId}`,
      direction: 'debit',
      amountCents: input.sellPriceCents,
      note: 'Chat Completions 请求扣费',
      currency: 'cny',
      detail,
    },
  });
}

app.post('/v1/chat/completions', async (request, reply) => {
  const body = z.record(z.string(), z.unknown()).parse(request.body);
  const providerSource = body.provider_source === 'user_supplied' ? 'user_supplied' : 'admin_managed';
  const sellPriceCents = resolveChatCompletionsSellPriceCents();
  const accessResult = await resolveChatRequestAccessContext(
    request.headers as Record<string, unknown>,
    providerSource,
    sellPriceCents,
    request,
  );
  if (!accessResult.granted) {
    reply.code(accessResult.statusCode);
    return {
      error: accessResult.error,
      message: accessResult.message,
    };
  }
  const accessContext = accessResult.context;
  const chatRequestId = `chat_${crypto.randomBytes(8).toString('hex')}`;
  const userBaseUrl = String(body.user_api_base_url || body.user_chat_base_url || '').trim();
  const userApiKey = String(body.user_api_key || body.user_chat_api_key || '').trim();
  const sanitizedBody = { ...body };
  delete sanitizedBody.provider_source;
  delete sanitizedBody.user_api_base_url;
  delete sanitizedBody.user_api_key;
  delete sanitizedBody.user_chat_base_url;
  delete sanitizedBody.user_chat_api_key;
  delete sanitizedBody.preferred_auth_mode;
  delete sanitizedBody.user_image_api_kind;
  delete sanitizedBody.user_chat_fallback_mode;

  type ChatCompletionAttempt = {
    providerId: string;
    providerName: string;
    providerBaseUrl: string;
    upstreamCostYuan: number;
    url: string;
    headers: Record<string, string>;
    body: Record<string, unknown>;
    timeoutMs: number;
  };

  const attempts: ChatCompletionAttempt[] = providerSource === 'user_supplied' && userBaseUrl && userApiKey
    ? [{
        providerId: 'user-supplied-openai-chat',
        providerName: 'User supplied Chat Completions',
        providerBaseUrl: userBaseUrl,
        upstreamCostYuan: 0,
        url: resolveOpenAICompatibleEndpoint(userBaseUrl, '/v1/chat/completions'),
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          ...(body.preferred_auth_mode === 'x-api-key'
            ? { 'X-API-Key': userApiKey }
            : { Authorization: `Bearer ${userApiKey}` }),
        },
        body: sanitizedBody,
        timeoutMs: resolveChatRequestTimeoutMs(),
      }]
    : (await getCanvasChatProviders()).map(({ provider, policy, upstream }) => ({
        providerId: provider.providerId,
        providerName: String(provider.name || provider.providerId),
        providerBaseUrl: provider.baseUrl,
        upstreamCostYuan: Number.isFinite(Number(upstream?.chatConfig?.upstreamCostYuan))
          ? Math.max(0, Number(upstream?.chatConfig?.upstreamCostYuan))
          : Math.max(0, Number(policy?.pricing.chatUnit || 0)) / 100,
        url: resolveOpenAICompatibleEndpoint(provider.baseUrl, '/v1/chat/completions'),
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          ...(provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {}),
          ...(provider.passthrough?.injectHeaders || {}),
        },
        body: {
          ...sanitizedBody,
          model: String(sanitizedBody.model || provider.metadata?.chat_model || provider.metadata?.text_model || provider.modelAllowlist?.[0] || 'gpt-4o-mini'),
          ...(provider.passthrough?.injectBodyFields || {}),
        },
        timeoutMs: resolveChatRequestTimeoutMs(provider),
      }));

  let lastStatus = 503;
  let lastPayload: unknown = {
    error: 'no_chat_provider_available',
    message: 'No enabled Chat Completions provider is available.',
  };
  const downstreamCancellation = createDownstreamCancellation({ request: request.raw, response: reply.raw });
  try {
  for (const attempt of attempts) {
    const attemptStartedAt = Date.now();
    try {
      const upstreamFetch = await fetchWithTimeout(attempt.url, {
        method: 'POST',
        headers: attempt.headers,
        body: JSON.stringify(attempt.body),
      }, attempt.timeoutMs, downstreamCancellation.signal);
      const upstream = upstreamFetch.response;
      let text = '';
      try {
        text = await upstream.text();
      } finally {
        upstreamFetch.dispose();
      }
      const json = tryParseJson(text);
      if (upstream.ok) {
        void providerRegistry.reportAttempt({
          providerId: attempt.providerId,
          ok: true,
          statusCode: upstream.status,
          failedAt: Date.now(),
          latencyMs: Date.now() - attemptStartedAt,
          affectsHealth: false,
        }).catch((error) => {
          requestLogWarn('chat_provider_success_report_failed', error);
        });
        await recordChatCompletionCharge({
          requestId: chatRequestId,
          accessContext,
          attempt: {
            providerId: attempt.providerId,
            providerName: attempt.providerName,
            providerBaseUrl: attempt.providerBaseUrl,
            upstreamCostYuan: Math.max(0, Number(attempt.upstreamCostYuan || 0)),
          },
          model: String(attempt.body.model || sanitizedBody.model || ''),
          sellPriceCents,
          responseStatusCode: upstream.status,
        });
        reply.code(upstream.status);
        return json ?? { raw: text };
      }
      lastStatus = upstream.status;
      const failure = classifyUpstreamFailure({
        statusCode: upstream.status,
        bodyJson: json,
        bodyText: text,
      });
      lastPayload = buildStandardDownstreamError({
        code: failure.category === 'terminal_safety'
          ? 'upstream_safety_rejected'
          : 'chat_upstream_failed',
        message: publicMessageForFailureCategory(failure.category),
        publicMessage: publicMessageForFailureCategory(failure.category),
        statusCode: upstream.status,
        failureCategory: failure.category,
      });
      void providerRegistry.reportAttempt({
        providerId: attempt.providerId,
        ok: false,
        statusCode: upstream.status,
        failedAt: Date.now(),
        cooldownMs: failure.cooldownMs,
        latencyMs: Date.now() - attemptStartedAt,
        failureCategory: failure.category,
        errorMessage: extractUpstreamErrorMessage({ bodyJson: json, bodyText: text }),
        affectsHealth: failure.affectsHealth !== false,
      }).catch((error) => {
        requestLogWarn('chat_provider_failure_report_failed', error);
      });
      if (!failure.shouldFailover) {
        break;
      }
    } catch (error) {
      if (isDownstreamClientDisconnectedError(error)) {
        reply.hijack();
        return;
      }
      lastStatus = 599;
      const message = error instanceof Error ? error.message : 'Chat upstream fetch failed.';
      const failure = classifyUpstreamFailure({ fetchError: error });
      lastPayload = buildStandardDownstreamError({
        code: 'chat_upstream_fetch_failed',
        message: publicMessageForFailureCategory(failure.category),
        publicMessage: publicMessageForFailureCategory(failure.category),
        statusCode: lastStatus,
        failureCategory: failure.category,
      });
      void providerRegistry.reportAttempt({
        providerId: attempt.providerId,
        ok: false,
        statusCode: 599,
        failedAt: Date.now(),
        cooldownMs: failure.cooldownMs,
        latencyMs: Date.now() - attemptStartedAt,
        failureCategory: failure.category,
        errorMessage: message,
        affectsHealth: failure.affectsHealth !== false,
      }).catch((reportError) => {
        requestLogWarn('chat_provider_failure_report_failed', reportError);
      });
      if (!failure.shouldFailover) {
        break;
      }
    }
  }
  reply.code(lastStatus);
  return lastPayload;
  } finally {
    downstreamCancellation.dispose();
  }
});

app.get('/v1/canvas/session', async (request, reply) => {
  const controlPlane = adminControlPlaneStore.get();
  const publicBaseUrl = inferPublicBaseUrl(request);
  const auth = await getCanvasUserAuth(request, reply, { required: false });
  let canvasUser: CanvasUserRecord | null = auth?.user || null;
  if (canvasUser) {
    try {
      await ensureCanvasTenantAndApiKeyForUser(canvasUser);
    } catch {
      canvasUser = null;
    }
  }
  const currentUser = canvasUser ? findCanvasUserById(canvasUser.id) : null;
  const catalog = await adminConsoleCatalogStore.refreshAsync();
  const apiKey = currentUser?.apiKeyId
    ? (catalog.apiKeys.find((item) => item.id === currentUser.apiKeyId) || null)
    : null;
  const balance = currentUser
    ? await operationalRepository.getTenantFinanceBalance(currentUser.tenantId, 'cny')
    : null;
  const storedUpstreamPreference = currentUser?.upstreamPreference || defaultCanvasUserUpstreamPreference();
  const isCanvasLocalSettingsMode = String(controlPlane.canvas.entryMode || '').trim() === 'settings';
  const upstreamPreference = isCanvasLocalSettingsMode
    ? defaultCanvasUserUpstreamPreference()
    : storedUpstreamPreference;
  return {
    isLoggedIn: Boolean(currentUser),
    isMember: true,
    canvasRequiresMembership: false,
    currentUserId: currentUser?.id || '',
    currentUsername: currentUser?.username || '',
    currentUserEmail: currentUser?.email || '',
    currentTenantId: currentUser?.tenantId || '',
    currentTenantBalanceCents: Math.max(0, Number(balance?.balanceCents || 0)),
    currentTenantBalanceYuan: minorUnitsToYuan(Math.max(0, Number(balance?.balanceCents || 0))),
    maxConcurrentGenerations: apiKey?.maxConcurrency || 10,
    executionOwnerLock: '',
    canvasAccess: {
      allowed: true,
    },
    loginUrl: '',
    canvasChannelId: imageChannelId,
    canvasExecutionSource: isCanvasLocalSettingsMode ? 'user_supplied' : 'admin_managed',
    canvasRoutingMode: apiKey?.imageRoutingMode || 'smart_failover',
    sessionEndpoint: '/v1/canvas/session',
    clearCanvasEndpoint: '/v1/canvas/clear',
    packageCanvasEndpoint: '/v1/canvas/package',
    canvasResultSelectEndpoint: '/v1/canvas/result-selection',
    canvasRunStartEndpoint: '/v1/canvas/workflow-runs',
    canvasRunStatusEndpoint: '/v1/canvas/workflow-runs',
    canvasRunCancelEndpoint: '/v1/canvas/workflow-runs/cancel',
    batchPreviewEndpoint: '/v1/canvas/batch-preview',
    direct_upload: currentUser && !isCanvasLocalSettingsMode
      ? {
          enabled: true,
          reference_endpoint: '/v1/canvas/reference-assets',
          node_id: 'api-server',
        }
      : null,
    authMode: apiKey?.rawKey ? 'bearer' : '',
    authToken: apiKey?.rawKey || '',
    logoIconUrl: String(controlPlane.canvas.brandLogoUrl || '/logo.svg').trim() || '/logo.svg',
    userControl: {
      enabled: true,
      entryMode: controlPlane.canvas.entryMode || 'login',
      gatewayBaseUrl: publicBaseUrl,
      imagesGenerationsEndpoint: `${publicBaseUrl}/v1/images/generations`,
      imagesEditsEndpoint: `${publicBaseUrl}/v1/images/edits`,
      chatCompletionsEndpoint: `${publicBaseUrl}/v1/chat/completions`,
      profileEndpoint: '/v1/canvas/auth/me',
      loginEndpoint: '/v1/canvas/auth/login',
      registerEndpoint: '/v1/canvas/auth/register',
      logoutEndpoint: '/v1/canvas/auth/logout',
      changePasswordEndpoint: '/v1/canvas/auth/change-password',
      upstreamPreferenceEndpoint: '',
      apiKeySettingsEndpoint: '/v1/canvas/user/api-key-settings',
      financeLedgerEndpoint: '/v1/canvas/user/tenant-finance-ledger',
      regenerateApiKeyEndpoint: '/v1/canvas/user/api-key/regenerate',
      apiKeysEndpoint: '/v1/canvas/user/api-keys',
      defaultApiKeyEndpoint: '/v1/canvas/user/default-api-key',
      imagePricingMatrix: Array.isArray(catalog.imagePricingMatrix) ? catalog.imagePricingMatrix : [],
      apiKeySettings: {
        imageRoutingMode: apiKey?.imageRoutingMode || 'smart_failover',
        fixedImageProviderId: apiKey?.imageRoutingMode === 'fixed_provider'
          ? normalizeFixedImageProviderIds(apiKey.fixedImageProviderIds, apiKey.fixedImageProviderId)[0] || ''
          : '',
        fixedImageProviderIds: apiKey?.imageRoutingMode === 'fixed_provider'
          ? normalizeFixedImageProviderIds(apiKey.fixedImageProviderIds, apiKey.fixedImageProviderId)
          : [],
        fixedImageProviderName: apiKey?.imageRoutingMode === 'fixed_provider'
          ? '平台固定线路'
          : '',
        fixedImageFlatPrice: apiKey?.imageRoutingMode === 'fixed_provider'
          ? Math.max(0, Number(apiKey?.fixedImageFlatPrice || 0))
          : 0,
        maxImageQuality: normalizeImageQualityCap(apiKey?.maxImageQuality),
        maxConcurrency: Math.max(1, Number(apiKey?.maxConcurrency || 10)),
      },
      upstreamPreference: {
        mode: upstreamPreference.mode,
        imageApiKind: upstreamPreference.imageApiKind || 'images_endpoint',
        imagesBaseUrl: upstreamPreference.imagesBaseUrl || '',
        imagesGenerationsUrl: upstreamPreference.imagesGenerationsUrl || '',
        imagesEditsUrl: upstreamPreference.imagesEditsUrl || '',
        chatBaseUrl: upstreamPreference.chatBaseUrl || '',
        hasImagesApiKey: Boolean(String(upstreamPreference.imagesApiKey || '').trim()),
        hasChatApiKey: Boolean(String(upstreamPreference.chatApiKey || '').trim()),
        preferredAuthMode: upstreamPreference.preferredAuthMode || 'bearer',
        chatFallbackMode: upstreamPreference.chatFallbackMode || 'platform_fallback',
      },
    },
  };
});

app.post('/v1/canvas/clear', async (request, reply) => {
  const body = z.object({
    canvas_id: z.string().optional(),
    canvas_batch_id: z.string().optional(),
  }).parse(request.body);
  const canvasId = String(body.canvas_id || '').trim();
  const canvasBatchId = String(body.canvas_batch_id || '').trim();
  if (!canvasId && !canvasBatchId) {
    reply.code(400);
    return {
      success: false,
      reason: 'missing_canvas_id',
      message: '缺少待清理的画布任务组标识。',
    };
  }

  const entryMode = String(adminControlPlaneStore.get().canvas.entryMode || '').trim();
  let currentTenantId = '';
  if (entryMode !== 'settings') {
    const { user } = await requireCanvasUser(request, reply);
    const currentUser = findCanvasUserById(user.id);
    if (!currentUser) {
      reply.code(401);
      return {
        success: false,
        reason: 'canvas_user_not_found',
        message: '当前画布登录状态无效，请重新登录后再试。',
      };
    }
    currentTenantId = String(currentUser.tenantId || '').trim();
  }

  const allRuns = sortCanvasWorkflowRunsByRecency(await listSharedCanvasWorkflowRuns());
  const matchedRuns = allRuns.filter((run) => {
    const runCanvasId = String(run.canvas_id || '').trim();
    const runBatchId = String(run.canvas_batch_id || '').trim();
    if (canvasId && runCanvasId !== canvasId && runBatchId !== canvasId) {
      if (!canvasBatchId || (runCanvasId !== canvasBatchId && runBatchId !== canvasBatchId)) {
        return false;
      }
    }
    if (canvasBatchId && runCanvasId !== canvasBatchId && runBatchId !== canvasBatchId) {
      if (!canvasId || (runCanvasId !== canvasId && runBatchId !== canvasId)) {
        return false;
      }
    }
    if (!currentTenantId) {
      return true;
    }
    const runTenantId = String((run.execution_payload as Record<string, unknown> | undefined)?.internal_tenant_id || '').trim();
    return !runTenantId || runTenantId === currentTenantId;
  });

  let queuedBatchCount = 0;
  let canceledRunCount = 0;
  let deletedRunCount = 0;
  const generatedImageFileNames = new Set<string>();
  const referenceAssetFileNames = new Set<string>();
  const relatedTaskIds = new Set<string>();

  for (const run of matchedRuns) {
    const status = String(run.status || '').trim().toLowerCase();
    if (status === 'queued' || status === 'running' || status === 'processing' || status === 'accepted' || status === 'cancel_requested') {
      await setCanvasWorkflowRunState(run.run_id, {
        ...run,
        status: 'cancel_requested',
        updated_at: Date.now(),
      }, workflowRunTtlSeconds);
      canceledRunCount += 1;
      queuedBatchCount += 1;
      continue;
    }
    collectGeneratedImageFileNamesFromCanvasRun(run, request).forEach((fileName) => generatedImageFileNames.add(fileName));
    collectCanvasReferenceAssetFileNamesFromCanvasRun(run, request).forEach((fileName) => referenceAssetFileNames.add(fileName));
    collectCanvasTaskIdsFromRun(run).forEach((taskId) => relatedTaskIds.add(taskId));
    await deleteCanvasWorkflowRunState(run.run_id);
    deletedRunCount += 1;
  }

  const relatedTaskArtifacts = await collectCanvasAssetFileNamesFromTaskRecords([...relatedTaskIds], request);
  relatedTaskArtifacts.generatedImageFileNames.forEach((fileName) => generatedImageFileNames.add(fileName));
  relatedTaskArtifacts.referenceAssetFileNames.forEach((fileName) => referenceAssetFileNames.add(fileName));

  const deletedImageCount = await deleteGeneratedImageFilesByName([...generatedImageFileNames]);
  const deletedReferenceAssetCount = await deleteCanvasReferenceAssetFilesByName([...referenceAssetFileNames]);
  return {
    success: true,
    canvas_id: canvasId,
    canvas_batch_id: canvasBatchId,
    matched_run_count: matchedRuns.length,
    deleted_run_count: deletedRunCount,
    canceled_run_count: canceledRunCount,
    deleted_image_count: deletedImageCount,
    deleted_reference_image_count: deletedReferenceAssetCount,
    queued_batch_count: queuedBatchCount,
  };
});

app.post('/v1/canvas/reference-assets', async (request, reply) => {
  const entryMode = String(adminControlPlaneStore.get().canvas.entryMode || '').trim();
  if (entryMode === 'settings') {
    reply.code(400);
    return {
      error: 'canvas_reference_upload_unavailable',
      message: '本地设置模式不需要上传参考图到服务端。',
    };
  }
  const { user } = await requireCanvasUser(request, reply);
  const currentUser = findCanvasUserById(user.id);
  if (!currentUser) {
    reply.code(401);
    return {
      error: 'canvas_user_auth_required',
      message: '请先登录后再上传参考图。',
    };
  }
  if (typeof (request as any).isMultipart !== 'function' || !(request as any).isMultipart()) {
    reply.code(415);
    return {
      error: 'multipart_required',
      message: '参考图上传需要 multipart/form-data 文件请求。',
    };
  }

  const part = await (request as any).file();
  if (!part || part.type !== 'file') {
    reply.code(400);
    return {
      error: 'reference_file_required',
      message: '请上传参考图片文件。',
    };
  }
  if (!String(part.mimetype || '').startsWith('image/')) {
    reply.code(400);
    return {
      error: 'invalid_reference_file_type',
      message: '只能上传图片文件。',
    };
  }

  const source = await spoolMultipartImageFilePart(request, part, createImageInputByteBudget());
  return persistCanvasReferenceAssetFile({
    request,
    ownerId: currentUser.id,
    source,
  });
});

app.get('/v1/canvas/reference-assets/:fileName', async (request, reply) => {
  const params = z.object({ fileName: z.string().min(1) }).parse(request.params);
  const fileName = sanitizeFileSegment(params.fileName);
  const filePath = path.join(getCanvasReferenceAssetDir(), fileName);
  try {
    const stats = await fs.stat(filePath);
    const ext = path.extname(fileName).replace(/^\./, '').toLowerCase();
    reply.header('Content-Type', contentTypeForExtension(ext));
    reply.header('Cache-Control', 'public, max-age=1200, immutable');
    reply.header('Content-Length', String(stats.size));
    return reply.send(createReadStream(filePath));
  } catch {
    reply.code(404);
    return {
      error: 'file_not_found',
      message: 'Canvas reference asset not found.',
    };
  }
});

async function hydrateCanvasWorkflowUserCredentials(request: any, reply: any, payload: CanvasWorkflowPayload): Promise<CanvasWorkflowPayload> {
  if (payload.provider_source !== 'user_supplied') {
    return payload;
  }
  const entryMode = String(adminControlPlaneStore.get().canvas.entryMode || '').trim();
  if (entryMode === 'settings') {
    return payload;
  }
  const hasInlineImageCredentials = Boolean(
    String(payload.user_api_base_url || '').trim()
      && String(payload.user_api_key || '').trim(),
  );
  const hasInlineChatCredentials = Boolean(
    String(payload.user_chat_base_url || '').trim()
      && String(payload.user_chat_api_key || '').trim(),
  );
  if (hasInlineImageCredentials && hasInlineChatCredentials) {
    return payload;
  }

  const auth = await getCanvasUserAuth(request, reply, { required: false }).catch(() => null);
  const storedUser = auth?.user ? findCanvasUserById(auth.user.id) : null;
  const preference = storedUser?.upstreamPreference;
  if (!preference || preference.mode !== 'user_supplied') {
    return payload;
  }

  return {
    ...payload,
    user_image_api_kind: payload.user_image_api_kind || preference.imageApiKind || 'images_endpoint',
    user_api_base_url: payload.user_api_base_url || preference.imagesBaseUrl || '',
    user_images_generations_url: payload.user_images_generations_url || preference.imagesGenerationsUrl || '',
    user_images_edits_url: payload.user_images_edits_url || preference.imagesEditsUrl || '',
    user_api_key: payload.user_api_key || preference.imagesApiKey || '',
    user_chat_base_url: payload.user_chat_base_url || preference.chatBaseUrl || '',
    user_chat_api_key: payload.user_chat_api_key || preference.chatApiKey || '',
    preferred_auth_mode: payload.preferred_auth_mode || preference.preferredAuthMode || 'bearer',
    user_chat_fallback_mode: payload.user_chat_fallback_mode || preference.chatFallbackMode || 'platform_fallback',
  };
}

const canvasRunnableTypes = new Set(['generate', 'imageExplosion', 'ecommerceImage', 'output']);
const canvasReferenceSourceTypes = new Set(['reference', 'localReference']);

function normalizeCanvasNodes(value: unknown): CanvasNode[] {
  return (Array.isArray(value) ? value : [])
    .map((node) => ({
      ...(node && typeof node === 'object' && !Array.isArray(node) ? node as Record<string, unknown> : {}),
      id: String((node as any)?.id || '').trim(),
      type: String((node as any)?.type || '').trim(),
      data: (node as any)?.data && typeof (node as any).data === 'object' ? (node as any).data : {},
    }))
    .filter((node) => node.id && node.type);
}

function normalizeCanvasEdges(value: unknown): CanvasEdge[] {
  return (Array.isArray(value) ? value : [])
    .map((edge) => ({
      id: String((edge as any)?.id || '').trim(),
      source: String((edge as any)?.source || '').trim(),
      target: String((edge as any)?.target || '').trim(),
    }))
    .filter((edge) => edge.source && edge.target);
}

function getCanvasNodeLabel(node: CanvasNode) {
  return String(node.data?.label || node.id || node.type || 'node').trim();
}

function estimateCanvasEmbeddedImageBytes(value: string) {
  const match = String(value || '').trim().match(/^data:image\/[a-zA-Z0-9.+-]+;base64,([A-Za-z0-9+/=\s]+)$/i);
  if (!match) {
    return 0;
  }
  return estimateBase64DecodedBytes(String(match[1] || ''));
}

function hasCanvasReferenceValue(node: CanvasNode) {
  if (node.type === 'localReference') {
    return Boolean(String(node.data?.annotatedImageUrl || node.data?.imageUrl || '').trim());
  }
  return Boolean(String(node.data?.imageUrl || '').trim());
}

function validateCanvasWorkflowInputConstraints(nodes: CanvasNode[], edges: CanvasEdge[]) {
  for (const node of nodes) {
    const fields: Array<[string, string]> = [
      ['imageUrl', String(node.data?.imageUrl || '').trim()],
      ['annotatedImageUrl', String(node.data?.annotatedImageUrl || '').trim()],
      ['originalImageUrl', String(node.data?.originalImageUrl || '').trim()],
    ];
    for (const [fieldName, value] of fields) {
      const embeddedBytes = estimateCanvasEmbeddedImageBytes(value);
      if (embeddedBytes > maxImagePayloadBytes) {
        const error = new Error(`Canvas reference image exceeds maximum size on ${fieldName}.`);
        (error as Error & { statusCode?: number; code?: string; details?: Record<string, unknown> }).statusCode = 413;
        (error as Error & { statusCode?: number; code?: string; details?: Record<string, unknown> }).code = 'canvas_reference_image_too_large';
        (error as Error & { statusCode?: number; code?: string; details?: Record<string, unknown> }).details = {
          node_id: node.id,
          node_type: node.type,
          field: fieldName,
          max_image_payload_bytes: maxImagePayloadBytes,
          received_image_payload_bytes: embeddedBytes,
        };
        throw error;
      }
    }
  }

  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  for (const node of nodes) {
    if (!['generate', 'imageExplosion', 'ecommerceImage'].includes(node.type)) {
      continue;
    }
    const directReferenceCount = edges
      .filter((edge) => edge.target === node.id)
      .map((edge) => nodeById.get(edge.source))
      .filter((source): source is CanvasNode => Boolean(source))
      .filter((source) => canvasReferenceSourceTypes.has(source.type) && hasCanvasReferenceValue(source))
      .length;
    const maxReferenceCount = getImageInputLimits().maxCount;
    if (directReferenceCount > maxReferenceCount) {
      const error = new Error(`Canvas node ${getCanvasNodeLabel(node)} exceeds the maximum direct reference image count.`);
      (error as Error & { statusCode?: number; code?: string; details?: Record<string, unknown> }).statusCode = 400;
      (error as Error & { statusCode?: number; code?: string; details?: Record<string, unknown> }).code = 'canvas_reference_limit_exceeded';
      (error as Error & { statusCode?: number; code?: string; details?: Record<string, unknown> }).details = {
        node_id: node.id,
        node_type: node.type,
        direct_reference_count: directReferenceCount,
        max_reference_count: maxReferenceCount,
      };
      throw error;
    }
  }
}

function compareCanvasNodes(a: CanvasNode | undefined, b: CanvasNode | undefined) {
  const ax = Number(a?.position?.x || 0);
  const bx = Number(b?.position?.x || 0);
  if (ax !== bx) return ax - bx;
  const ay = Number(a?.position?.y || 0);
  const by = Number(b?.position?.y || 0);
  if (ay !== by) return ay - by;
  return String(a?.id || '').localeCompare(String(b?.id || ''));
}

function buildCanvasExecutionPlan(nodes: CanvasNode[], edges: CanvasEdge[]) {
  const runnableNodes = nodes.filter((node) => canvasRunnableTypes.has(node.type));
  const runnableIds = new Set(runnableNodes.map((node) => node.id));
  const nodeById = new Map(runnableNodes.map((node) => [node.id, node]));
  const incomingByTarget = new Map<string, Set<string>>();
  const outgoingBySource = new Map<string, Set<string>>();
  runnableNodes.forEach((node) => {
    incomingByTarget.set(node.id, new Set());
    outgoingBySource.set(node.id, new Set());
  });
  edges.forEach((edge) => {
    if (!runnableIds.has(edge.source) || !runnableIds.has(edge.target)) {
      return;
    }
    incomingByTarget.get(edge.target)?.add(edge.source);
    outgoingBySource.get(edge.source)?.add(edge.target);
  });

  const ready = runnableNodes
    .filter((node) => !incomingByTarget.get(node.id)?.size)
    .sort(compareCanvasNodes);
  const plan: CanvasNode[] = [];
  while (ready.length) {
    const node = ready.shift()!;
    plan.push(node);
    Array.from(outgoingBySource.get(node.id) || [])
      .sort((a, b) => compareCanvasNodes(nodeById.get(a), nodeById.get(b)))
      .forEach((targetId) => {
        const incoming = incomingByTarget.get(targetId);
        incoming?.delete(node.id);
        if (incoming && incoming.size === 0) {
          const target = nodeById.get(targetId);
          if (target) {
            ready.push(target);
            ready.sort(compareCanvasNodes);
          }
        }
      });
  }
  if (plan.length !== runnableNodes.length) {
    throw new Error('Canvas workflow contains a cycle between runnable nodes.');
  }
  return plan;
}

app.post('/v1/canvas/package', async (request) => {
  const body = z.object({
    canvas_id: z.string().optional(),
    canvas_batch_id: z.string().optional(),
    items: z.array(z.any()).optional(),
  }).parse(request.body);
  return {
    success: true,
    canvas_id: body.canvas_id || '',
    canvas_batch_id: body.canvas_batch_id || '',
    packaged_count: Array.isArray(body.items) ? body.items.length : 0,
  };
});

app.post('/v1/canvas/batch-preview', async () => ({
  file_name: 'batch.csv',
  total: 0,
  billable_total: 0,
  skipped_total: 0,
  items: [],
}));

app.post('/v1/canvas/result-selection', async (request, reply) => {
  const body = z.object({
    action: z.enum(['append_version', 'select_version']).optional(),
    run_id: z.string().optional(),
    canvas_id: z.string().optional(),
    canvas_batch_id: z.string().optional(),
    node_id: z.string().min(1),
    item_index: z.number().int().optional(),
    item_key: z.string().optional(),
    version: z.object({
      id: z.string().min(1),
      label: z.string().optional(),
      image_url: z.string().optional(),
      download_url: z.string().optional(),
      reference_url: z.string().optional(),
      task_id: z.string().optional(),
      prompt: z.string().optional(),
      edit_type: z.string().optional(),
      created_at: z.string().optional(),
    }).passthrough(),
  }).parse(request.body);

  const action = String(body.action || 'select_version').trim() === 'append_version'
    ? 'append_version'
    : 'select_version';
  const canvasId = String(body.canvas_id || '').trim();
  const canvasBatchId = String(body.canvas_batch_id || '').trim();
  const nodeId = String(body.node_id || '').trim();
  const itemKey = String(body.item_key || '').trim();
  const itemIndex = Number.isFinite(Number(body.item_index)) ? Number(body.item_index) : -1;

  const entryMode = String(adminControlPlaneStore.get().canvas.entryMode || '').trim();
  let currentTenantId = '';
  if (entryMode !== 'settings') {
    const { user } = await requireCanvasUser(request, reply);
    const currentUser = findCanvasUserById(user.id);
    if (!currentUser) {
      reply.code(401);
      return {
        success: false,
        reason: 'canvas_user_not_found',
        message: '当前画布登录状态无效，请重新登录后再试。',
      };
    }
    currentTenantId = String(currentUser.tenantId || '').trim();
  }

  let targetRun = body.run_id ? await getCanvasWorkflowRunState(String(body.run_id || '').trim()) : null;
  if (!targetRun) {
    targetRun = sortCanvasWorkflowRunsByRecency(await listSharedCanvasWorkflowRuns()).find((run) => {
      if (!matchCanvasWorkflowRunIdentifiers(run, canvasId, canvasBatchId)) {
        return false;
      }
      if (!currentTenantId) {
        return true;
      }
      const runTenantId = String((run.execution_payload as Record<string, unknown> | undefined)?.internal_tenant_id || '').trim();
      return !runTenantId || runTenantId === currentTenantId;
    }) || null;
  }

  if (!targetRun) {
    reply.code(404);
    return {
      success: false,
      reason: 'run_not_found',
      message: '未找到可更新的画布运行记录。',
    };
  }

  if (currentTenantId) {
    const runTenantId = String((targetRun.execution_payload as Record<string, unknown> | undefined)?.internal_tenant_id || '').trim();
    if (runTenantId && runTenantId !== currentTenantId) {
      reply.code(403);
      return {
        success: false,
        reason: 'run_forbidden',
        message: '当前用户无权修改该画布运行记录。',
      };
    }
  }

  const updatedRun = await updateCanvasWorkflowRun(targetRun.run_id, (run) => {
    const sourceJob = run.jobs.find((job) => String(job.node_id || '').trim() === nodeId);
    if (!sourceJob) {
      const error = new Error('未找到对应的结果节点任务。');
      (error as Error & { statusCode?: number; code?: string }).statusCode = 404;
      (error as Error & { statusCode?: number; code?: string }).code = 'result_job_not_found';
      throw error;
    }

    const sourceItems = Array.isArray(sourceJob.result_items)
      ? sourceJob.result_items
          .filter((item) => item && typeof item === 'object' && !Array.isArray(item))
          .map((item) => ({ ...(item as Record<string, unknown>) }))
      : [];
    if (!sourceItems.length) {
      const error = new Error('当前结果项尚未生成，无法写入版本记录。');
      (error as Error & { statusCode?: number; code?: string }).statusCode = 409;
      (error as Error & { statusCode?: number; code?: string }).code = 'result_items_missing';
      throw error;
    }

    const sourceItemIndex = findCanvasRunResultItemIndex(sourceItems, itemKey, itemIndex);
    if (sourceItemIndex < 0) {
      const error = new Error('未找到要更新的图片结果项。');
      (error as Error & { statusCode?: number; code?: string }).statusCode = 404;
      (error as Error & { statusCode?: number; code?: string }).code = 'result_item_not_found';
      throw error;
    }

    sourceItems[sourceItemIndex] = mergeCanvasRunResultItemVersion(
      sourceItems[sourceItemIndex],
      body.version as Record<string, unknown>,
      action === 'select_version',
    );
    updateCanvasRunJobSummaryFromResultItems(sourceJob, sourceItems);

    const sourceNodeState = run.node_states.find((state) => String(state.node_id || '').trim() === nodeId);
    if (sourceNodeState) {
      updateCanvasRunNodeSummaryFromResultItems(sourceNodeState, sourceItems);
    }

    const touchedOutputNodeIds = new Set<string>();
    run.jobs.forEach((job) => {
      if (String(job.type || '').trim() !== 'output' || !Array.isArray(job.result_items) || !job.result_items.length) {
        return;
      }
      let touched = false;
      const nextItems = job.result_items.map((item, index) => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
          return item;
        }
        const record = { ...(item as Record<string, unknown>) };
        if (String(record.node_id || record.nodeId || '').trim() !== nodeId) {
          return record;
        }
        const outputItemKey = getCanvasRunResultItemKey(record);
        const sameItem = itemKey
          ? outputItemKey === itemKey
          : (itemIndex < 0 || index === itemIndex || Number(record.index || 0) === itemIndex + 1);
        if (!sameItem) {
          return record;
        }
        touched = true;
        return mergeCanvasRunResultItemVersion(record, body.version as Record<string, unknown>, action === 'select_version');
      });
      if (!touched) {
        return;
      }
      updateCanvasRunJobSummaryFromResultItems(job, nextItems as Array<Record<string, unknown>>, {
        clearPackageDownload: action === 'select_version',
        preserveDownloadUrl: action !== 'select_version',
      });
      touchedOutputNodeIds.add(String(job.node_id || '').trim());
    });

    if (touchedOutputNodeIds.size) {
      run.node_states.forEach((state) => {
        const outputNodeId = String(state.node_id || '').trim();
        if (!touchedOutputNodeIds.has(outputNodeId)) {
          return;
        }
        const outputJob = run.jobs.find((job) => String(job.node_id || '').trim() === outputNodeId);
        const outputItems = Array.isArray(outputJob?.result_items)
          ? outputJob.result_items.filter((item) => item && typeof item === 'object' && !Array.isArray(item)) as Array<Record<string, unknown>>
          : [];
        updateCanvasRunNodeSummaryFromResultItems(state, outputItems, {
          clearOutputArtifacts: action === 'select_version',
        });
        if (action === 'select_version') {
          state.package_count = outputItems.length || state.package_count || 0;
        }
      });
    }

    run.history = (run.history || []).concat({
      at: Date.now(),
      action: 'canvas_result_version_mutated',
      mutation_action: action,
      node_id: nodeId,
      item_key: itemKey,
      item_index: itemIndex,
      version_id: String(body.version?.id || '').trim(),
      message: action === 'append_version'
        ? 'Canvas result version appended.'
        : 'Canvas result version selected.',
    }).slice(-80);
  });

  if (!updatedRun) {
    reply.code(404);
    return {
      success: false,
      reason: 'run_not_found',
      message: '画布运行记录不存在或已过期。',
    };
  }

  return {
    success: true,
    action,
    ...updatedRun,
  };
});

app.post('/v1/canvas/workflow-runs', async (request, reply) => {
  const parsedPayload = createWorkflowRunSchema.parse(request.body);
  let payload = await hydrateCanvasWorkflowUserCredentials(request, reply, parsedPayload);
  const entryMode = String(adminControlPlaneStore.get().canvas.entryMode || '').trim();
  const auth = entryMode === 'settings'
    ? null
    : await getCanvasUserAuth(request, reply, { required: false }).catch(() => null);
  let currentCanvasUser = auth?.user ? findCanvasUserById(auth.user.id) : null;
  if (payload.provider_source !== 'user_supplied' && entryMode !== 'settings') {
    if (!currentCanvasUser) {
      reply.code(401);
      return {
        error: 'canvas_user_auth_required',
        message: '请先登录后再生成图像。',
      };
    }
    const ensured = await ensureCanvasTenantAndApiKeyForUser(currentCanvasUser);
    currentCanvasUser = findCanvasUserById(currentCanvasUser.id) || currentCanvasUser;
    payload = {
      ...payload,
      internal_tenant_id: ensured.tenant.id,
      internal_api_key_id: ensured.apiKey?.id || currentCanvasUser.apiKeyId || '',
    };
  }
  const hasUserImageUrl = Boolean(
    String(payload.user_images_generations_url || '').trim()
    || String(payload.user_images_edits_url || '').trim()
    || String(payload.user_api_base_url || '').trim(),
  );
  if (
    payload.provider_source === 'user_supplied'
    && (!hasUserImageUrl || !String(payload.user_api_key || '').trim())
  ) {
    reply.code(400);
    return {
      error: 'user_image_api_required',
      message: '使用自带线路运行画布时，请先配置图片 API 地址和密钥。',
    };
  }
  const runId = `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const nodes = normalizeCanvasNodes(payload.nodes);
  const edges = normalizeCanvasEdges(payload.edges);
  validateCanvasWorkflowInputConstraints(nodes, edges);
  const plan = buildCanvasExecutionPlan(nodes, edges);
  const planNodeIds = new Set(plan.map((node) => node.id));
  const nodeStates: WorkflowNodeState[] = nodes
    .filter((node) => canvasRunnableTypes.has(node.type))
    .map((node) => ({
      node_id: node.id,
      status: planNodeIds.has(node.id) ? 'queued' : 'completed',
    }));
  const jobs: WorkflowRunJobState[] = plan.map((node) => ({
    id: `job_${node.id}`,
    node_id: node.id,
    type: node.type,
    status: 'queued',
    prompt: String(node.data?.prompt || node.data?.explosionInstruction || node.data?.userRequirements || ''),
  }));

  const record: CanvasWorkflowRunState = {
    run_id: runId,
    canvas_id: payload.canvas_id,
    canvas_batch_id: payload.canvas_id,
    status: 'queued',
    workflow: payload.workflow || defaultWorkflow,
    execution_payload: payload as Record<string, unknown>,
    request_headers: pickAsyncTaskRequestHeaders(request),
    node_states: nodeStates,
    jobs,
    created_at: Date.now(),
    updated_at: Date.now(),
    history: [{
      at: Date.now(),
      message: 'Canvas workflow run accepted.',
      jobCount: jobs.length,
    }],
  };
  await setCanvasWorkflowRunState(runId, record, workflowRunTtlSeconds);
  void appendAuditRecord({
    actorType: 'system',
    actorId: 'canvas-runner',
    action: 'canvas_workflow_run_created',
    targetType: 'task',
    targetId: runId,
    status: 'accepted',
    message: 'Canvas workflow run created.',
    detail: {
      canvasId: payload.canvas_id,
      channelId: payload.channel_id || imageChannelId,
      executionSource: payload.execution_source || '',
      lineGroup: payload.line_group || '',
      jobCount: jobs.length,
      routingMode: payload.routing_mode || '',
    },
  });
  // Worker process will pick this run up from shared Redis-backed state.
  reply.code(202);
  return record;
});

app.get('/v1/canvas/workflow-runs', async (request) => {
  const query = z.object({
    run_id: z.string().optional(),
    canvas_id: z.string().optional(),
  }).parse(request.query);

  if (query.run_id) {
    const run = await getCanvasWorkflowRunState(query.run_id);
    if (run) {
      return run;
    }
  }

  const latest = sortCanvasWorkflowRunsByRecency(await listSharedCanvasWorkflowRuns()).find((item) => (
    !query.canvas_id || item.canvas_id === query.canvas_id
  ));

  return latest || {
    run_id: '',
    canvas_id: query.canvas_id || '',
    status: 'idle',
    jobs: [],
  };
});

app.post('/v1/canvas/workflow-runs/cancel', async (request) => {
  const body = z.object({ run_id: z.string().min(1) }).parse(request.body);
  const record = await getCanvasWorkflowRunState(body.run_id);
  if (!record) {
    return { success: false, reason: 'not_found' };
  }
  record.status = 'cancel_requested';
  await setCanvasWorkflowRunState(body.run_id, record, workflowRunTtlSeconds);
  return { success: true, run_id: body.run_id, status: record.status };
});

function resolveOperationalImageCost(
  upstream: ConsoleUpstream | undefined,
  tier: 'auto' | '1k' | '2k' | '4k' | null,
  quality: 'auto' | 'low' | 'medium' | 'high',
) {
  if (!upstream || !tier) {
    return { configured: false, valueCredits: 0, source: 'unconfigured' as const };
  }
  const profiles = upstream.kind === 'images_endpoint'
    ? upstream.imagesConfig?.capabilityProfiles
    : upstream.kind === 'responses_endpoint'
      ? upstream.responsesConfig?.capabilityProfiles
      : [];
  const resolved = resolveImageCapabilityCost(profiles, tier, quality);
  return {
    configured: resolved.configured,
    valueCredits: resolved.configured ? Math.max(0, yuanToMinorUnits(resolved.value)) : 0,
    source: resolved.source,
  };
}

function normalizeOperationalCostTier(value: unknown): 'auto' | '1k' | '2k' | '4k' | null {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized === 'auto' || normalized === '1k' || normalized === '2k' || normalized === '4k'
    ? normalized
    : null;
}

function normalizeOperationalCostQuality(value: unknown): 'auto' | 'low' | 'medium' | 'high' {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized === 'low' || normalized === 'medium' || normalized === 'high' || normalized === 'auto'
    ? normalized
    : 'auto';
}

await initializeProviderRegistry();
await initializeAdminConsoleCatalogStore();
await initializeAdminControlPlaneStore();
await cleanupStaleMultipartInputSpools().catch((error) => {
  requestLogWarn('multipart_input_spool_startup_cleanup_failed', error);
});
await cleanupStaleAsyncTaskAssets().catch((error) => {
  requestLogWarn('async_task_asset_startup_cleanup_failed', error);
});
dynamicOverloadGuard.configure(adminControlPlaneStore.get().publicApi);
subscribeAdminControlPlane((config) => dynamicOverloadGuard.configure(config.publicApi));
await initializeCanvasUserStores();
await registerAdminRoutes(app);
registerUnifiedErrorHandler();
scheduleOperationalMaintenance();
startOperationalRollupScheduler({
  repository: operationalRepository,
  beforeTick: async () => {
    await adminControlPlaneStore.refreshAsync();
  },
  enabled: () => !operationalRollupHardDisabled && adminControlPlaneStore.get().analytics.operationalRollupEnabled,
  intervalMsProvider: () => Math.max(
    15 * 60 * 1000,
    Number(adminControlPlaneStore.get().analytics.operationalRollupIntervalMinutes || 0) * 60 * 1000 || operationalRollupIntervalMs,
  ),
  lookbackDaysProvider: () => Math.max(
    1,
    Math.min(3, Number(adminControlPlaneStore.get().analytics.operationalRollupLookbackDays || operationalRollupLookbackDays)),
  ),
  bucketMs: operationalRollupBucketMs,
  lockMs: operationalRollupLockMs,
  workerId: `api:${process.pid}`,
  costResolver: (input) => {
    const catalog = adminConsoleCatalogStore.get();
    const upstream = catalog.upstreams.find((item) => item.id === input.upstreamId);
    return resolveOperationalImageCost(
      upstream,
      normalizeOperationalCostTier(input.tier),
      normalizeOperationalCostQuality(input.quality),
    );
  },
});

let gracefulShutdownStarted = false;

async function closeApiServer(signal: NodeJS.Signals) {
  if (gracefulShutdownStarted) {
    return;
  }
  gracefulShutdownStarted = true;
  gatewayAcceptingTraffic = false;
  asyncQueueDispatchPaused = true;
  app.log.info({ signal, gracefulShutdownTimeoutMs, gatewayInstance: gatewayInstanceId }, 'api_server_graceful_shutdown_started');
  const forceExitTimer = setTimeout(() => {
    app.log.error({ signal, gracefulShutdownTimeoutMs }, 'api_server_graceful_shutdown_timed_out');
    process.exit(1);
  }, gracefulShutdownTimeoutMs);
  forceExitTimer.unref();
  try {
    await app.close();
    if (activeAsyncImageTaskRuns.size) {
      app.log.info({ activeAsyncImageTaskRuns: activeAsyncImageTaskRuns.size }, 'api_server_waiting_for_async_image_tasks');
      await Promise.allSettled(Array.from(activeAsyncImageTaskRuns));
    }
    app.log.info({ signal }, 'api_server_graceful_shutdown_completed');
    process.exit(0);
  } catch (error) {
    app.log.error(error, 'api_server_graceful_shutdown_failed');
    process.exit(1);
  }
}

process.once('SIGINT', () => {
  void closeApiServer('SIGINT');
});
process.once('SIGTERM', () => {
  void closeApiServer('SIGTERM');
});

app.listen({ port, host }).then(() => {
  gatewayAcceptingTraffic = true;
  app.log.info({ gatewayInstance: gatewayInstanceId, port, host }, 'api_gateway_ready');
  if (typeof process.send === 'function') {
    process.send('ready');
  }
}).catch((error) => {
  app.log.error(error);
  process.exit(1);
});
