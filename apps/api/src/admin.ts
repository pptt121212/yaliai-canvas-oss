import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  type OpenAIImagesRequest,
  type ProviderConfig,
  type ProviderRoutingMode,
} from '@yali/provider-core';
import { yuanToMinorUnits } from '@yali/billing-core';
import { adaptOpenAIImagesPayloadForProvider, buildImageRequestPlanForProvider } from './imageGateway.js';
import { providerRegistry } from './providerRegistry.js';
import { buildSmartImageRoutingPlan, classifyUpstreamFailure } from './smartImageRouting.js';
import { resolveImageCapabilityCost } from './modules/imageCapabilityMatrix.js';
import {
  adminControlPlaneStore,
  providerAdapterCatalog,
  type AdminControlPlaneConfig,
} from './modules/admin/controlPlane.js';
import {
  adminConsoleCatalogStore,
  analyzeOnboardingInput,
  createMaskedApiKey,
  type OnboardingProbeLogEntry,
  type ProbeTraceEntry,
  type ConsoleUpstream,
} from './modules/admin/consoleCatalog.js';
import { buildResolutionAuditReport } from './modules/imageResolutionAudit.js';
import { createJsonStore } from './modules/storage/jsonStore.js';
import {
  createPostgresCanvasUserRepository,
  createPostgresCanvasUserSessionRepository,
  createPostgresSessionRepository,
} from './modules/storage/postgresRepositories.js';
import { operationalRepository } from './modules/storage/operationalStore.js';
import { appendAuditRecord, appendRequestTrace, createTenantFinanceLedger } from './modules/storage/operationalService.js';
import type {
  CanvasUserRecord,
  CanvasUserSessionRecord,
  OnboardingAnalyzeJobState,
  SessionRepository,
} from './modules/storage/repositoryContracts.js';
import { asyncHotStateStore, hotStateStore, refreshHotConcurrencyCounters, refreshHotProviderRuntime } from './modules/storage/runtimeStores.js';
import { hasDatabaseUrl, requireDatabaseUrl } from './modules/storage/storageMode.js';

const sessionTtlMs = 1000 * 60 * 60 * 24 * 7;
const cookieName = 'yali_admin_session';
requireDatabaseUrl('admin_routes');

const providerSchema = z.object({
  providerId: z.string().min(1),
  name: z.string().optional(),
  source: z.enum(['admin_managed', 'user_supplied']),
  protocol: z.enum([
    'openai_images',
    'openai_responses',
    'openai_chat',
    'custom_async_media',
  ]).optional(),
  baseUrl: z.string().url(),
  apiKey: z.string().optional(),
  modelAllowlist: z.array(z.string()).optional(),
  healthState: z.enum(['healthy', 'cooling', 'degraded', 'disabled']).optional(),
  supportsImage: z.boolean().optional(),
  supportsVideo: z.boolean().optional(),
  capability: z.object({
    supportsSync: z.boolean().optional(),
    supportsAsync: z.boolean().optional(),
    supportsImageGeneration: z.boolean().optional(),
    supportsImageEdit: z.boolean().optional(),
    supportsVideoGeneration: z.boolean().optional(),
    supportsReferenceImages: z.boolean().optional(),
  }).optional(),
  passthrough: z.object({
    injectHeaders: z.record(z.string(), z.string()).optional(),
    injectBodyFields: z.record(z.string(), z.unknown()).optional(),
  }).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

const controlPlaneSchema = z.object({
  routing: z.object({
    allowUserSuppliedKey: z.boolean(),
    smartRoutingCostPriorityBaseDelta: z.number().int().min(0).max(100),
  }),
  publicApi: z.object({
    enabled: z.boolean(),
    defaultResponseFormat: z.enum(['url', 'b64_json']),
    authMode: z.enum(['admin_key', 'tenant_key', 'disabled']),
    rateLimitPerMinute: z.number().int().nonnegative(),
    maxConcurrency: z.number().int().nonnegative(),
    exposeGenerations: z.boolean(),
    exposeEdits: z.boolean(),
  }),
  canvas: z.object({
    allowUserSuppliedProviders: z.boolean(),
    brandLogoUrl: z.string().trim(),
    entryMode: z.enum(['login', 'settings']),
  }),
  maintenance: z.object({
    generatedImageRetentionMinutes: z.number().int().min(1),
    canvasReferenceAssetRetentionMinutes: z.number().int().min(1),
    requestTraceRetentionMinutes: z.number().int().min(1),
    taskRecordRetentionDays: z.number().int().min(1),
    auditLogRetentionDays: z.number().int().min(1),
    billingLedgerRetentionDays: z.number().int().min(1),
  }),
  analytics: z.object({
    operationalRollupEnabled: z.boolean(),
    operationalRollupIntervalMinutes: z.number().int().min(15).max(24 * 60),
    operationalRollupLookbackDays: z.number().int().min(1).max(90),
  }).optional(),
});

const resolutionTierSchema = z.enum(['auto', '1k', '2k', '4k']);
const billableResolutionTierSchema = z.enum(['auto', '1k', '2k', '4k']);
const upstreamKindSchema = z.enum(['images_endpoint', 'responses_endpoint', 'chat_completions']);
const responseFormatSchema = z.enum(['url', 'b64_json']);
const outputImageFormatSchema = z.enum(['png', 'webp', 'jpeg']);
const responsesInputShapeSchema = z.enum(['auto_standard', 'always_multimodal_message']);
const responsesToolChoiceModeSchema = z.enum(['auto', 'image_generation']);
const responsesToolChoiceFormatSchema = z.enum(['typed_object', 'required_string']);
const moderationModeSchema = z.enum(['omit', 'auto', 'low']);
const responsesModelRoutingSchema = z.enum(['split_text_image', 'single_top_level_model']);
const responsesReturnModeSchema = z.enum(['stream', 'json']);
const reasoningEffortSchema = z.enum(['low', 'medium', 'high', 'xhigh']);
const responsesModerationModeSchema = z.enum(['task_or_omit', 'force_auto', 'force_low']);
const imageToolQualitySchema = z.enum(['auto', 'low', 'medium', 'high']);
const imageQualityTierSchema = z.enum(['auto', 'low', 'medium', 'high']);
const imageQualityCapSchema = z.enum(['auto', 'low', 'medium', 'high']);
const imageBackgroundModeSchema = z.enum(['omit', 'auto', 'transparent', 'opaque']);
const imageRoutingModeSchema = z.enum(['smart_priority', 'smart_failover', 'fixed_provider']);
const imageCapabilityCostMapSchema = z.object({
  auto: z.number().nonnegative().optional(),
  low: z.number().nonnegative().optional(),
  medium: z.number().nonnegative().optional(),
  high: z.number().nonnegative().optional(),
}).partial();
const imageCapabilityProfileSchema = z.object({
  tier: resolutionTierSchema,
  qualities: z.array(imageQualityTierSchema),
  costs: imageCapabilityCostMapSchema.optional(),
});
const imageSellPriceRowSchema = z.object({
  tier: billableResolutionTierSchema,
  quality: imageQualityTierSchema,
  price: z.number().nonnegative(),
});
const healthStatusSchema = z.preprocess((value) => {
  if (value === 'healthy' || value === 'cooling' || value === 'degraded' || value === 'disabled') {
    return value;
  }
  return 'healthy';
}, z.enum(['healthy', 'cooling', 'degraded', 'disabled']));
const imagesConfigSchema = z.object({
  supportsGenerations: z.boolean(),
  supportsEdits: z.boolean(),
  supportsAsync: z.boolean(),
  responseFormats: z.array(responseFormatSchema),
  allowDirectPublicImageUrl: z.boolean(),
  imageInputMode: z.enum(['url_only', 'multipart_only', 'url_or_multipart', 'unknown']),
  editProtocolModes: z.array(z.enum(['multipart_file_upload', 'json_image_url'])),
  jsonReferenceTransports: z.array(z.enum(['url', 'base64'])),
  editReferenceMode: z.enum(['multipart_file_upload', 'json_image_url']),
  returnMode: z.enum(['json', 'stream']),
  editRequestFormat: z.enum(['json', 'multipart']),
  referenceImageTransport: z.enum(['inherit', 'url', 'base64']),
  capabilityProfiles: z.array(imageCapabilityProfileSchema),
  generationsUrl: z.string().url().optional(),
  editsUrl: z.string().url().optional(),
  asyncGenerationsUrl: z.string().url().optional(),
  asyncEditsUrl: z.string().url().optional(),
  asyncResultUrlTemplate: z.string().trim().regex(/^https?:\/\//i).optional(),
});
const responsesConfigSchema = z.object({
  supportsImageInput: z.boolean(),
  capabilityProfiles: z.array(imageCapabilityProfileSchema),
  responseFormats: z.array(responseFormatSchema),
  jsonReferenceTransports: z.array(z.enum(['url', 'base64'])),
  allowDirectPublicImageUrl: z.boolean(),
  textModel: z.string().min(1),
  imageModel: z.string().optional(),
  reasoningEffort: reasoningEffortSchema,
  returnMode: responsesReturnModeSchema,
  inputShape: responsesInputShapeSchema,
  toolChoice: responsesToolChoiceModeSchema,
  toolChoiceFormat: responsesToolChoiceFormatSchema,
  modelRouting: responsesModelRoutingSchema,
  moderationMode: responsesModerationModeSchema,
  imageQuality: z.number().int().min(0).max(100).optional(),
  imageToolQuality: imageToolQualitySchema.optional(),
});
const chatConfigSchema = z.object({
  supportsSystemPrompt: z.boolean(),
  supportsJsonMode: z.boolean(),
  supportsTools: z.boolean(),
  supportsVisionInput: z.boolean(),
  upstreamCostYuan: z.number().nonnegative().optional(),
});
const probeCheckSchema = z.object({
  key: z.string(),
  label: z.string(),
  method: z.enum(['GET', 'POST']),
  url: z.string(),
  exists: z.boolean(),
  ok: z.boolean(),
  statusCode: z.number().int().nullable(),
  summary: z.string(),
});
const onboardingProbeSchema = z.object({
  attempted: z.boolean(),
  ok: z.boolean(),
  normalizedBaseCandidates: z.array(z.string()),
  detectedKinds: z.array(upstreamKindSchema),
  recommendedKind: upstreamKindSchema.nullable(),
  syncSupport: z.enum(['unknown', 'likely_supported']),
  checks: z.array(probeCheckSchema),
  summary: z.string(),
});

const upstreamTestPresetSchema = z.object({
  operation: z.enum(['generations', 'edits', 'responses', 'chat_completions']),
  model: z.string().min(1),
  imageModel: z.string().optional(),
  prompt: z.string().min(1),
  size: z.string().optional(),
  quality: z.string().optional(),
  imageToolQuality: imageToolQualitySchema.optional(),
  imageQuality: z.number().int().min(0).max(100).optional(),
  responseFormat: responseFormatSchema.optional(),
  outputFormat: outputImageFormatSchema.optional(),
  outputCompression: z.number().int().min(0).max(100).optional(),
  background: imageBackgroundModeSchema.optional(),
  stream: z.boolean().optional(),
  partialImages: z.number().int().min(1).max(3).optional(),
  referenceImageUrl: z.string().url().optional(),
  responsesInputShape: responsesInputShapeSchema.optional(),
  responsesToolChoice: responsesToolChoiceModeSchema.optional(),
  responsesToolChoiceFormat: responsesToolChoiceFormatSchema.optional(),
  moderation: moderationModeSchema.optional(),
  n: z.number().int().positive().optional(),
});

const consoleUpstreamSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  kind: upstreamKindSchema,
  baseUrl: z.string().url(),
  apiKey: z.string(),
  enabled: z.boolean(),
  maxConcurrency: z.number().int().positive().default(10),
  healthStatus: healthStatusSchema,
  modelHints: z.array(z.string()),
  notes: z.string(),
  adminTestPreset: upstreamTestPresetSchema.optional(),
  passthrough: z.object({
    injectHeaders: z.record(z.string(), z.string()).optional(),
    injectBodyFields: z.record(z.string(), z.unknown()).optional(),
  }).optional(),
  imagesConfig: imagesConfigSchema.optional(),
  responsesConfig: responsesConfigSchema.optional(),
  chatConfig: chatConfigSchema.optional(),
  detectedConfig: z.object({
    kind: upstreamKindSchema,
    imagesConfig: imagesConfigSchema.optional(),
    responsesConfig: responsesConfigSchema.optional(),
    chatConfig: chatConfigSchema.optional(),
    probe: onboardingProbeSchema,
  }).optional(),
  manualOverrides: z.object({
    kind: upstreamKindSchema.optional(),
    imagesConfig: imagesConfigSchema.partial().optional(),
    responsesConfig: responsesConfigSchema.partial().optional(),
    chatConfig: chatConfigSchema.partial().optional(),
    modelHints: z.array(z.string()).optional(),
  }).optional(),
});

function buildResponsesMultimodalInput(
  prompt: string,
  referenceImages: string[],
  inputShape: 'auto_standard' | 'always_multimodal_message',
) {
  const normalizedPrompt = String(prompt || '');
  const normalizedImages = referenceImages
    .map((item) => String(item || '').trim())
    .filter(Boolean);

  if (!normalizedImages.length && inputShape === 'auto_standard') {
    return normalizedPrompt;
  }

  const content: Array<Record<string, unknown>> = [
    { type: 'input_text', text: normalizedPrompt },
  ];
  for (const imageUrl of normalizedImages) {
    content.push({ type: 'input_image', image_url: imageUrl });
  }

  return [{ role: 'user', content }];
}

function smartRoutingModeLabel(mode: 'smart_priority' | 'smart_failover' | 'fixed_provider') {
  if (mode === 'fixed_provider') {
    return '固定';
  }
  return mode === 'smart_priority' ? '优选' : '智能';
}

function buildRoutingPreviewContexts() {
  return [
    {
      key: 'generation_standard',
      label: '标准文生图',
      context: {
        operation: 'generations' as const,
        requestedSize: '1024x1024',
        requestMode: 'sync' as const,
        hasReferenceImage: false,
        requestedModel: 'gpt-image-2',
      },
    },
    {
      key: 'generation_high_res',
      label: '高清文生图',
      context: {
        operation: 'generations' as const,
        requestedSize: '2048x2048',
        requestMode: 'sync' as const,
        hasReferenceImage: false,
        requestedModel: 'gpt-image-2',
      },
    },
    {
      key: 'edit_with_reference',
      label: '带参考图编辑',
      context: {
        operation: 'edits' as const,
        requestedSize: '1024x1024',
        requestMode: 'sync' as const,
        hasReferenceImage: true,
        requestedModel: 'gpt-image-2',
      },
    },
  ];
}

const routingDiagnosticsWindowMs = 2 * 60 * 60 * 1000;
const routingDiagnosticsImageChannelIds = new Set(['image_generation', 'channel_image_generation']);

async function buildRoutingDiagnosticsPayload() {
  const catalog = adminConsoleCatalogStore.get();
  const generatedAt = Date.now();
  const windowFromInclusive = generatedAt - routingDiagnosticsWindowMs;
  const [providers, performance] = await Promise.all([
    listFreshAdminRuntimeProviders({ includeConcurrency: true }),
    operationalRepository.getChannelPerformanceData(windowFromInclusive, generatedAt),
  ]);
  const apiKeys = catalog.apiKeys || [];
  const smartModeCount = apiKeys.filter((item) => (item.imageRoutingMode || 'smart_failover') === 'smart_failover').length;
  const preferredModeCount = apiKeys.filter((item) => item.imageRoutingMode === 'smart_priority').length;
  const fixedModeCount = apiKeys.filter((item) => item.imageRoutingMode === 'fixed_provider').length;
  const upstreamNameById = new Map(catalog.upstreams.map((item) => [item.id, item.name]));
  const recentTaskStatsByProviderId = new Map(
    performance.tasks
      .filter((item) => routingDiagnosticsImageChannelIds.has(String(item.channelId || '')))
      .map((item) => [String(item.upstreamId || ''), item]),
  );
  const recentBillingStatsByProviderId = new Map<string, {
    generatedImageCount: number;
    chargedCredits: number;
  }>();
  for (const row of performance.billing) {
    if (row.operation === 'chat_completions' || !routingDiagnosticsImageChannelIds.has(String(row.channelId || ''))) {
      continue;
    }
    const providerId = String(row.upstreamId || '').trim();
    if (!providerId) {
      continue;
    }
    const current = recentBillingStatsByProviderId.get(providerId) || {
      generatedImageCount: 0,
      chargedCredits: 0,
    };
    current.generatedImageCount += Number(row.unitCount || 0);
    current.chargedCredits += Number(row.chargedCredits || 0);
    recentBillingStatsByProviderId.set(providerId, current);
  }
  const previewInputs = buildRoutingPreviewContexts();
  const previews = await Promise.all(previewInputs.map(async (item) => {
    const smartPlan = await buildSmartImageRoutingPlan({
      providers,
      mode: 'smart_failover',
      context: item.context,
    });
    const preferredPlan = await buildSmartImageRoutingPlan({
      providers,
      mode: 'smart_priority',
      context: item.context,
    });
    return {
      key: item.key,
      label: item.label,
      requestedSize: item.context.requestedSize,
      operation: item.context.operation,
      hasReferenceImage: item.context.hasReferenceImage,
      plans: [smartPlan, preferredPlan].map((plan) => ({
        mode: plan.mode,
        modeLabel: smartRoutingModeLabel(plan.mode),
        candidateCount: plan.candidates.length,
        filteredOutCount: plan.filteredOut.length,
        filteredOut: plan.filteredOut,
        candidates: plan.candidates.map((candidate, index) => ({
          rank: index + 1,
          providerId: candidate.provider.providerId,
          providerName: candidate.provider.name,
          protocol: candidate.provider.protocol,
          baseUrl: candidate.provider.baseUrl,
          score: Number(candidate.score.toFixed(2)),
          baseScore: Number(candidate.baseScore.toFixed(2)),
          qualityScore: Number(candidate.qualityScore.toFixed(2)),
          healthScore: Number(candidate.healthScore.toFixed(2)),
          concurrencyScore: Number(candidate.concurrencyScore.toFixed(2)),
          price: candidate.price,
          costSource: candidate.costSource,
          estimatedLatencyMs: Math.round(candidate.estimatedLatencyMs),
          observedLatencyMs: candidate.observedLatencyMs
            ? Math.round(candidate.observedLatencyMs)
            : undefined,
          latencySource: candidate.latencySource,
          successLatencySampleCount: candidate.successLatencySampleCount,
          costMedian: candidate.costMedian,
          effectiveCost: candidate.effectiveCost,
          costIndex: Number(candidate.costIndex.toFixed(4)),
          deliveryValueIndex: Number(candidate.deliveryValueIndex.toFixed(2)),
          currentConcurrency: candidate.currentConcurrency,
          reasons: candidate.reasons,
        })),
      })),
    };
  }));

  return {
    generatedAt,
    summary: {
      providerCount: providers.length,
      healthyCount: providers.filter((item) => item.healthState === 'healthy').length,
      coolingCount: providers.filter((item) => item.healthState === 'cooling').length,
      degradedCount: providers.filter((item) => item.healthState === 'degraded').length,
      disabledCount: providers.filter((item) => item.healthState === 'disabled').length,
      tenantKeyCount: apiKeys.length,
      smartModeCount,
      preferredModeCount,
      fixedModeCount,
      diagnosticsWindowMinutes: Math.round(routingDiagnosticsWindowMs / 60000),
    },
    apiKeyModes: apiKeys.map((item) => {
      const fixedProviderIds = Array.from(new Set([
        ...(Array.isArray(item.fixedImageProviderIds) ? item.fixedImageProviderIds : []),
        item.fixedImageProviderId || '',
      ].map((providerId) => String(providerId || '').trim()).filter(Boolean)));
      return {
        apiKeyId: item.id,
        apiKeyName: item.name,
        tenantId: item.tenantId,
        tenantName: catalog.tenants.find((tenant) => tenant.id === item.tenantId)?.name || item.tenantId,
        mode: item.imageRoutingMode || 'smart_failover',
        modeLabel: smartRoutingModeLabel(item.imageRoutingMode || 'smart_failover'),
        fixedProviderId: fixedProviderIds[0] || '',
        fixedProviderIds,
        fixedProviderName: fixedProviderIds
          .map((providerId) => upstreamNameById.get(providerId) || providerId)
          .join('、'),
        status: item.status,
        maxConcurrency: item.maxConcurrency,
        requestLimitPerMinute: item.requestLimitPerMinute,
      };
    }),
    providers: providers.map((provider) => {
      const runtime = (provider.metadata?.runtime && typeof provider.metadata.runtime === 'object')
        ? provider.metadata.runtime as Record<string, unknown>
        : {};
      const recentTaskStats = recentTaskStatsByProviderId.get(provider.providerId);
      const recentBillingStats = recentBillingStatsByProviderId.get(provider.providerId) || {
        generatedImageCount: 0,
        chargedCredits: 0,
      };
      return {
        providerId: provider.providerId,
        name: provider.name,
        protocol: provider.protocol,
        kind: String(provider.metadata?.consoleUpstreamKind || ''),
        baseUrl: provider.baseUrl,
        healthState: provider.healthState,
        healthScore: Number(provider.healthScore || 0),
        supportsImageGeneration: provider.capability?.supportsImageGeneration !== false,
        supportsImageEdit: provider.capability?.supportsImageEdit !== false,
        supportsReferenceImages: provider.capability?.supportsReferenceImages !== false,
        supportsAsync: provider.capability?.supportsAsync === true,
        maxConcurrency: Math.max(1, Math.floor(Number(provider.metadata?.max_concurrency || 10))),
        currentConcurrency: Number(hotStateStore.getConcurrencyCounter(`provider:${provider.providerId}`)?.current || 0),
        cooldownUntil: Number(runtime.cooldownUntil || 0) || undefined,
        fusedUntil: Number(runtime.fusedUntil || 0) || undefined,
        successCount: Number(runtime.successCount || 0),
        failureCount: Number(runtime.failureCount || 0),
        ewmaSuccessRate: Number(runtime.ewmaSuccessRate || 0),
        ewmaLatencyMs: Number(runtime.ewmaLatencyMs || 0),
        lastCheckedAt: Number(runtime.lastCheckedAt || 0) || undefined,
        lastSelectedAt: Number(runtime.lastSelectedAt || 0) || undefined,
        lastSuccessAt: Number(runtime.lastSuccessAt || 0) || undefined,
        lastFailureAt: Number(runtime.lastFailureAt || 0) || undefined,
        lastErrorCategory: String(runtime.lastErrorCategory || ''),
        lastErrorMessage: String(runtime.lastErrorMessage || ''),
        capabilityProfiles: Array.isArray(provider.metadata?.images_capability_profiles)
          ? provider.metadata?.images_capability_profiles
          : Array.isArray(provider.metadata?.responses_capability_profiles)
            ? provider.metadata?.responses_capability_profiles
            : [],
        recentTaskStats: {
          windowMinutes: Math.round(routingDiagnosticsWindowMs / 60000),
          requestCount: Number(recentTaskStats?.requestCount || 0),
          eligibleRequestCount: Number(recentTaskStats?.eligibleRequestCount || 0),
          successCount: Number(recentTaskStats?.completedCount || 0),
          failedCount: Number(recentTaskStats?.failedCount || 0),
          rejectedCount: Number(recentTaskStats?.rejectedCount || 0),
          runningCount: Number(recentTaskStats?.runningCount || 0),
          averageDurationMs: Number(recentTaskStats?.averageDurationMs || 0),
          lastActivityAt: Number(recentTaskStats?.lastActivityAt || 0) || undefined,
        },
        recentBillingStats: {
          windowMinutes: Math.round(routingDiagnosticsWindowMs / 60000),
          generatedImageCount: recentBillingStats.generatedImageCount,
          chargedCredits: recentBillingStats.chargedCredits,
        },
      };
    }),
    previews,
  };
}

const reservedResponsesTestBodyFields = new Set([
  'model',
  'input',
  'tools',
  'tool_choice',
  'stream',
  'reasoning',
]);

const reservedChatTestBodyFields = new Set([
  'model',
  'messages',
  'stream',
]);

function sanitizeAdminInjectedBodyFields(
  fields: Record<string, unknown> | undefined,
  reservedKeys: Set<string>,
) {
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields || {})) {
    const normalizedKey = String(key || '').trim();
    if (!normalizedKey || reservedKeys.has(normalizedKey)) {
      continue;
    }
    sanitized[normalizedKey] = value;
  }
  return sanitized;
}

const consoleChannelSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  businessType: z.enum(['image_generation', 'text_processing']),
  acceptedUpstreamKinds: z.array(upstreamKindSchema),
  upstreamIds: z.array(z.string()),
  upstreamPolicies: z.array(z.object({
    upstreamId: z.string().min(1),
    pricing: z.object({
      auto: z.number().nonnegative(),
      oneK: z.number().nonnegative(),
      twoK: z.number().nonnegative(),
      fourK: z.number().nonnegative(),
      chatUnit: z.number().nonnegative(),
    }),
    notes: z.string(),
  })),
  enabled: z.boolean(),
  displayOrder: z.number().int(),
  notes: z.string(),
});

const imagePricingMatrixSchema = z.object({
  rows: z.array(imageSellPriceRowSchema),
  chatCompletionsUnitPrice: z.number().nonnegative().optional(),
  chatCompletionsUnitPriceYuan: z.number().nonnegative().optional(),
});

const consoleTenantSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  code: z.string().min(1),
  status: z.enum(['active', 'disabled']),
  allowedChannelIds: z.array(z.string()),
  requestLimitPerMinute: z.number().int().nonnegative(),
  notes: z.string(),
});

const consoleApiKeySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  tenantId: z.string().min(1),
  status: z.enum(['active', 'disabled']),
  allowedChannelIds: z.array(z.string()),
  requestLimitPerMinute: z.number().int().nonnegative(),
  maxConcurrency: z.number().int().positive(),
  imageRoutingMode: imageRoutingModeSchema.optional(),
  fixedImageProviderId: z.string().optional(),
  fixedImageProviderIds: z.array(z.string()).optional(),
  fixedImageFlatPrice: z.number().nonnegative().optional(),
  maxImageQuality: imageQualityCapSchema.optional(),
  maskedKey: z.string().min(1),
  rawKey: z.string().optional(),
  keyHash: z.string().optional(),
  notes: z.string(),
});

const onboardingAnalyzeSchema = z.object({
  name: z.string().min(1),
  baseUrl: z.string().url().optional(),
  apiKey: z.string().optional(),
  targetKind: upstreamKindSchema.optional(),
  model: z.string().optional(),
  imageModel: z.string().optional(),
  reasoningEffort: reasoningEffortSchema.optional(),
  prompt: z.string().optional(),
  size: z.string().optional(),
  referenceImageUrl: z.string().url().optional(),
  imagesGenerationUrl: z.string().url().optional(),
  imagesEditUrl: z.string().url().optional(),
  quality: z.string().optional(),
  imageToolQuality: imageToolQualitySchema.optional(),
  imageQuality: z.number().int().min(0).max(100).optional(),
  responseFormat: responseFormatSchema.optional(),
  outputFormat: outputImageFormatSchema.optional(),
  outputCompression: z.number().int().min(0).max(100).optional(),
  background: imageBackgroundModeSchema.optional(),
  stream: z.boolean().optional(),
  partialImages: z.number().int().min(1).max(3).optional(),
  moderation: moderationModeSchema.optional(),
  n: z.number().int().min(1).max(10).optional(),
  responsesInputShape: responsesInputShapeSchema.optional(),
  responsesToolChoice: responsesToolChoiceModeSchema.optional(),
  responsesToolChoiceFormat: responsesToolChoiceFormatSchema.optional(),
  customBodyFields: z.record(z.string(), z.unknown()).optional(),
}).superRefine((value, context) => {
  const kind = value.targetKind || 'images_endpoint';
  if (kind === 'images_endpoint') {
    if (!value.imagesGenerationUrl) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['imagesGenerationUrl'],
        message: '请填写完整的文生图接口地址。',
      });
    }
    if (!value.imagesEditUrl) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['imagesEditUrl'],
        message: '请填写完整的图生图接口地址。',
      });
    }
    return;
  }
  if (!value.baseUrl) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['baseUrl'],
      message: '请填写上游基础地址。',
    });
  }
});

const upstreamTestRequestSchema = z.object({
  operation: z.enum(['generations', 'edits', 'responses', 'chat_completions']),
  model: z.string().min(1),
  imageModel: z.string().optional(),
  prompt: z.string().min(1),
  size: z.string().optional(),
  quality: z.string().optional(),
  imageToolQuality: imageToolQualitySchema.optional(),
  imageQuality: z.number().int().min(0).max(100).optional(),
  responseFormat: responseFormatSchema.optional(),
  outputFormat: outputImageFormatSchema.optional(),
  outputCompression: z.number().int().min(0).max(100).optional(),
  background: imageBackgroundModeSchema.optional(),
  stream: z.boolean().optional(),
  partialImages: z.number().int().min(1).max(3).optional(),
  referenceImageUrl: z.string().url().optional(),
  responsesInputShape: responsesInputShapeSchema.optional(),
  responsesToolChoice: responsesToolChoiceModeSchema.optional(),
  responsesToolChoiceFormat: responsesToolChoiceFormatSchema.optional(),
  moderation: moderationModeSchema.optional(),
  n: z.number().int().positive().optional(),
});

const upstreamTestSchema = z.object({
  upstream: consoleUpstreamSchema,
  request: upstreamTestRequestSchema,
});

const resolutionAuditQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(5000).optional(),
});

const billingLedgerQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(5000).optional(),
});

const tenantFinanceLedgerQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(5000).optional(),
});

const canvasUsersQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(5000).optional(),
});

const tenantFinanceAdjustSchema = z.object({
  tenantId: z.string().min(1),
  direction: z.enum(['credit', 'debit']),
  amountYuan: z.coerce.number().positive().refine((value) => yuanToMinorUnits(value) > 0, {
    message: 'amount_must_be_at_least_0.00001_cny',
  }),
  note: z.string().trim().min(1).max(500),
});

type OnboardingAnalyzeJobRecord = {
  jobId: string;
  status: 'running' | 'completed' | 'failed';
  createdAt: number;
  updatedAt: number;
  message?: string;
  probeLog?: OnboardingProbeLogEntry[];
  result?: unknown;
};

const onboardingAnalyzeJobTtlMs = 1000 * 60 * 30;
const onboardingAnalyzeJobTtlSeconds = Math.ceil(onboardingAnalyzeJobTtlMs / 1000);

function normalizeOnboardingAnalyzeJobRecord(raw: OnboardingAnalyzeJobState | null): OnboardingAnalyzeJobRecord | null {
  if (!raw || !raw.jobId || !raw.status || !raw.createdAt || !raw.updatedAt) {
    return null;
  }
  return {
    jobId: String(raw.jobId),
    status: raw.status,
    createdAt: Number(raw.createdAt),
    updatedAt: Number(raw.updatedAt),
    message: raw.message ? String(raw.message) : undefined,
    probeLog: Array.isArray(raw.probeLog) ? raw.probeLog as OnboardingProbeLogEntry[] : [],
    result: raw.result,
  };
}

async function loadOnboardingAnalyzeJob(jobId: string) {
  if (asyncHotStateStore) {
    const shared = normalizeOnboardingAnalyzeJobRecord(await asyncHotStateStore.getOnboardingAnalyzeJob(jobId));
    if (shared) {
      hotStateStore.setOnboardingAnalyzeJob(jobId, shared as OnboardingAnalyzeJobState, onboardingAnalyzeJobTtlSeconds);
      return shared;
    }
  }
  return normalizeOnboardingAnalyzeJobRecord(hotStateStore.getOnboardingAnalyzeJob(jobId));
}

async function saveOnboardingAnalyzeJob(jobId: string, record: OnboardingAnalyzeJobRecord) {
  hotStateStore.setOnboardingAnalyzeJob(jobId, record as OnboardingAnalyzeJobState, onboardingAnalyzeJobTtlSeconds);
  if (asyncHotStateStore) {
    await asyncHotStateStore.setOnboardingAnalyzeJob(jobId, record as OnboardingAnalyzeJobState, onboardingAnalyzeJobTtlSeconds);
  }
}

async function createOnboardingAnalyzeJob() {
  const jobId = `onb_${Date.now().toString(36)}_${crypto.randomBytes(6).toString('hex')}`;
  const record: OnboardingAnalyzeJobRecord = {
    jobId,
    status: 'running',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    message: '探测任务已创建，正在后台执行。',
    probeLog: [],
  };
  await saveOnboardingAnalyzeJob(jobId, record);
  return record;
}

async function getOnboardingAnalyzeJob(jobId: string) {
  return loadOnboardingAnalyzeJob(jobId);
}

async function completeOnboardingAnalyzeJob(jobId: string, result: unknown) {
  const current = await loadOnboardingAnalyzeJob(jobId);
  if (!current) {
    return;
  }
  await saveOnboardingAnalyzeJob(jobId, {
    ...current,
    status: 'completed',
    updatedAt: Date.now(),
    message: '探测任务已完成。',
    probeLog: (result as { probeLog?: unknown })?.probeLog && Array.isArray((result as { probeLog?: unknown[] }).probeLog)
      ? (result as { probeLog: OnboardingAnalyzeJobRecord['probeLog'] }).probeLog
      : current.probeLog,
    result,
  });
}

async function failOnboardingAnalyzeJob(jobId: string, message: string) {
  const current = await loadOnboardingAnalyzeJob(jobId);
  if (!current) {
    return;
  }
  await saveOnboardingAnalyzeJob(jobId, {
    ...current,
    status: 'failed',
    updatedAt: Date.now(),
    message,
  });
}

async function appendOnboardingAnalyzeJobLog(
  jobId: string,
  entry: OnboardingProbeLogEntry,
  message?: string,
) {
  const current = await loadOnboardingAnalyzeJob(jobId);
  if (!current) {
    return;
  }
  await saveOnboardingAnalyzeJob(jobId, {
    ...current,
    updatedAt: Date.now(),
    message: message || current.message,
    probeLog: [...(current.probeLog || []), entry],
  });
}

function formatAdminRouteError(error: unknown) {
  if (error instanceof z.ZodError) {
    return error.issues.map((issue) => {
      const path = issue.path.length ? issue.path.join('.') : 'root';
      return `${path}: ${issue.message}`;
    }).join(' | ');
  }
  return error instanceof Error ? error.message : 'Unknown error';
}

async function persistOnboardingProbeTraces(input: {
  body: z.infer<typeof onboardingAnalyzeSchema>;
  request: FastifyRequest;
  result: Awaited<ReturnType<typeof analyzeOnboardingInput>>;
}) {
  const { body, result } = input;
  const operation = body.targetKind === 'chat_completions'
    ? 'chat_completions'
    : body.targetKind === 'responses_endpoint'
      ? 'responses'
      : 'generations';

  await appendRequestTrace({
    source: 'onboarding_probe',
    scope: 'upstream_only',
    status: result.probe.ok ? 'success' : 'failed',
    summary: result.probe.summary,
    upstreamName: result.upstreamDraft.name,
    providerBaseUrl: result.upstreamDraft.baseUrl,
    operation,
    upstreamRequest: {
      analyzeInput: body,
    },
    upstreamResponse: {
      probe: result.probe,
      warnings: result.warnings,
      recommendations: result.recommendations,
    },
    tags: ['onboarding'],
  });
}

async function persistOnboardingProbeTraceDetail(input: {
  body: z.infer<typeof onboardingAnalyzeSchema>;
  upstreamName: string;
  providerBaseUrl: string;
  traceEntry: ProbeTraceEntry;
}) {
  const { body, upstreamName, providerBaseUrl, traceEntry } = input;
  const operation = body.targetKind === 'chat_completions'
    ? 'chat_completions'
    : body.targetKind === 'responses_endpoint'
      ? 'responses'
      : 'generations';

  await appendRequestTrace({
    source: 'onboarding_probe',
    scope: 'upstream_only',
    status: traceEntry.response?.ok ? 'success' : 'failed',
    summary: traceEntry.label,
    upstreamName,
    providerBaseUrl,
    operation,
    upstreamRequest: traceEntry.request,
    upstreamResponse: traceEntry.response,
    errorPayload: traceEntry.response?.ok ? null : {
      key: traceEntry.key,
      label: traceEntry.label,
      statusCode: traceEntry.response?.statusCode ?? null,
      bodyText: traceEntry.response?.bodyText ?? '',
    },
    tags: ['onboarding', 'probe-detail'],
  });
}

type AdminSessionRecord = {
  token: string;
  username: string;
  createdAt: number;
  expiresAt: number;
};

function readSessions(): AdminSessionRecord[] {
  return adminSessionCache;
}

function writeSessions(records: AdminSessionRecord[]) {
  adminSessionCache = records;
  if (postgresSessionRepository) {
    void postgresSessionRepository.saveAll(records);
    return;
  }
  sessionStore.write(records);
}

const sessionStore = createJsonStore<AdminSessionRecord[]>({
  envDirKey: 'ADMIN_DATA_DIR',
  defaultDirName: 'data',
  fileName: 'admin-sessions.json',
  createDefault: () => [],
  mergeOnRead: (input) => Array.isArray(input) ? input as AdminSessionRecord[] : [],
});

const postgresSessionRepository = hasDatabaseUrl()
  ? createPostgresSessionRepository({
      connectionString: process.env.DATABASE_URL,
      schema: process.env.PG_SCHEMA || 'public',
    })
  : null;

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

let adminSessionCache = postgresSessionRepository ? [] : sessionStore.read();
const sessionRepository: SessionRepository = {
  list() {
    return adminSessionCache;
  },
  saveAll(records: AdminSessionRecord[]) {
    writeSessions(records);
    return adminSessionCache;
  },
};

async function initializeAdminRouteStores() {
  adminSessionCache = postgresSessionRepository
    ? await postgresSessionRepository.list()
    : sessionStore.read();
}

function pruneSessions() {
  const now = Date.now();
  const next = sessionRepository.list().filter((item) => item.expiresAt > now);
  sessionRepository.saveAll(next);
  return next;
}

function getAdminCredentials() {
  const username = String(process.env.ADMIN_USERNAME || '').trim();
  const password = String(process.env.ADMIN_PASSWORD || '').trim();
  if (!username || !password) {
    throw new Error('admin_credentials_not_configured');
  }
  return {
    username,
    password,
  };
}

function toBase64Url(input: Buffer | string) {
  return Buffer.from(input).toString('base64url');
}

function fromBase64Url(input: string) {
  return Buffer.from(String(input || ''), 'base64url').toString('utf8');
}

function getAdminSessionSecret() {
  const explicit = String(process.env.ADMIN_SESSION_SECRET || '').trim();
  if (explicit) {
    return explicit;
  }
  const credentials = getAdminCredentials();
  return `${credentials.username}:${credentials.password}`;
}

function signAdminSessionPayload(payload: string) {
  return crypto.createHmac('sha256', getAdminSessionSecret()).update(payload).digest('base64url');
}

function createSignedAdminSessionToken(session: Pick<AdminSessionRecord, 'username' | 'createdAt' | 'expiresAt'>) {
  const payload = toBase64Url(JSON.stringify({
    u: session.username,
    iat: session.createdAt,
    exp: session.expiresAt,
  }));
  const signature = signAdminSessionPayload(payload);
  return `${payload}.${signature}`;
}

function parseSignedAdminSessionToken(token: string): AdminSessionRecord | null {
  const raw = String(token || '').trim();
  if (!raw) {
    return null;
  }
  const parts = raw.split('.');
  if (parts.length !== 2) {
    return null;
  }
  const [payload, signature] = parts;
  const expectedSignature = signAdminSessionPayload(payload);
  const signatureBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expectedSignature);
  if (signatureBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(signatureBuffer, expectedBuffer)) {
    return null;
  }
  try {
    const parsed = JSON.parse(fromBase64Url(payload)) as {
      u?: unknown;
      iat?: unknown;
      exp?: unknown;
    };
    const username = String(parsed.u || '').trim();
    const createdAt = Number(parsed.iat || 0);
    const expiresAt = Number(parsed.exp || 0);
    if (!username || !Number.isFinite(createdAt) || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
      return null;
    }
    return {
      token: raw,
      username,
      createdAt,
      expiresAt,
    };
  } catch {
    return null;
  }
}

function createSession(username: string) {
  const now = Date.now();
  const session: AdminSessionRecord = {
    token: '',
    username,
    createdAt: now,
    expiresAt: now + sessionTtlMs,
  };
  session.token = createSignedAdminSessionToken(session);
  void appendAuditRecord({
    actorType: 'admin',
    actorId: username,
    action: 'admin_login',
    targetType: 'tenant',
    targetId: 'admin-console',
    status: 'accepted',
    message: 'Admin session created.',
    detail: { username },
  });
  return session;
}

function clearSession(token: string) {
  void token;
}

function parseCookie(request: FastifyRequest, name: string) {
  const raw = String(request.headers.cookie || '');
  if (!raw) {
    return '';
  }
  const pairs = raw.split(';').map((item) => item.trim()).filter(Boolean);
  for (const pair of pairs) {
    const index = pair.indexOf('=');
    if (index === -1) {
      continue;
    }
    const key = pair.slice(0, index).trim();
    const value = pair.slice(index + 1).trim();
    if (key === name) {
      return decodeURIComponent(value);
    }
  }
  return '';
}

function setSessionCookie(reply: FastifyReply, token: string) {
  reply.header(
    'Set-Cookie',
    `${cookieName}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(sessionTtlMs / 1000)}`,
  );
}

function clearSessionCookie(reply: FastifyReply) {
  reply.header('Set-Cookie', `${cookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

function readCanvasUsersFromJsonStore() {
  return createJsonStore<CanvasUserRecord[]>({
    envDirKey: 'ADMIN_DATA_DIR',
    defaultDirName: 'data',
    fileName: 'canvas-users.json',
    createDefault: () => [],
    mergeOnRead: (input) => Array.isArray(input) ? input as CanvasUserRecord[] : [],
  }).read();
}

function readCanvasUserSessionsFromJsonStore() {
  return createJsonStore<CanvasUserSessionRecord[]>({
    envDirKey: 'ADMIN_DATA_DIR',
    defaultDirName: 'data',
    fileName: 'canvas-user-sessions.json',
    createDefault: () => [],
    mergeOnRead: (input) => Array.isArray(input) ? input as CanvasUserSessionRecord[] : [],
  }).read();
}

function readCanvasUsers() {
  return readCanvasUsersFromJsonStore();
}

async function purgeTenantCanvasArtifacts(tenantId: string) {
  const users = postgresCanvasUserRepository
    ? await postgresCanvasUserRepository.list()
    : readCanvasUsersFromJsonStore();
  const removedUserIds = new Set(
    users
      .filter((item) => item.tenantId === tenantId)
      .map((item) => item.id),
  );
  if (removedUserIds.size > 0) {
    if (postgresCanvasUserRepository) {
      await postgresCanvasUserRepository.deleteByIds([...removedUserIds]);
    } else {
      const nextUsers = users.filter((item) => item.tenantId !== tenantId);
      createJsonStore<CanvasUserRecord[]>({
        envDirKey: 'ADMIN_DATA_DIR',
        defaultDirName: 'data',
        fileName: 'canvas-users.json',
        createDefault: () => [],
        mergeOnRead: (input) => Array.isArray(input) ? input as CanvasUserRecord[] : [],
      }).write(nextUsers);
    }
  }
  const sessions = postgresCanvasUserSessionRepository
    ? await postgresCanvasUserSessionRepository.list()
    : readCanvasUserSessionsFromJsonStore();
  const removedSessionTokens = sessions
    .filter((item) => removedUserIds.has(item.userId))
    .map((item) => item.token);
  const removedSessionCount = removedSessionTokens.length;
  if (removedSessionTokens.length > 0) {
    if (postgresCanvasUserSessionRepository) {
      await postgresCanvasUserSessionRepository.deleteByIds(removedSessionTokens);
    } else {
      const nextSessions = sessions.filter((item) => !removedUserIds.has(item.userId));
      createJsonStore<CanvasUserSessionRecord[]>({
        envDirKey: 'ADMIN_DATA_DIR',
        defaultDirName: 'data',
        fileName: 'canvas-user-sessions.json',
        createDefault: () => [],
        mergeOnRead: (input) => Array.isArray(input) ? input as CanvasUserSessionRecord[] : [],
      }).write(nextSessions);
    }
  }
  return {
    removedUsers: removedUserIds.size,
    removedSessions: removedSessionCount,
  };
}

function getAdminDataDir() {
  return String(process.env.ADMIN_DATA_DIR || path.join(process.cwd(), 'data'));
}

async function clearGeneratedTraceImages() {
  const generatedImageDir = path.join(getAdminDataDir(), 'generated-images');
  try {
    const entries = await fs.readdir(generatedImageDir, { withFileTypes: true });
    let deletedCount = 0;
    for (const entry of entries) {
      await fs.rm(path.join(generatedImageDir, entry.name), { recursive: true, force: true });
      deletedCount += 1;
    }
    return { deletedCount };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { deletedCount: 0 };
    }
    throw error;
  }
}

function normalizeChannelMetricId(value?: string) {
  if (value === 'image_generation') {
    return 'channel_image_generation';
  }
  if (value === 'text_processing') {
    return 'channel_text_processing';
  }
  return String(value || '');
}

function normalizeCostTier(value: unknown): 'auto' | '1k' | '2k' | '4k' | null {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'auto' || normalized === '1k' || normalized === '2k' || normalized === '4k') {
    return normalized;
  }
  return null;
}

function normalizeCostQuality(value: unknown): 'auto' | 'low' | 'medium' | 'high' {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'low' || normalized === 'medium' || normalized === 'high') {
    return normalized;
  }
  return 'auto';
}

function resolveConfiguredImageCost(
  upstream: ConsoleUpstream | undefined,
  tier: 'auto' | '1k' | '2k' | '4k' | null,
  quality: 'auto' | 'low' | 'medium' | 'high',
) {
  if (!upstream || !tier) {
    return { configured: false, value: 0 };
  }
  const profiles = upstream.kind === 'images_endpoint'
    ? upstream.imagesConfig?.capabilityProfiles
    : upstream.kind === 'responses_endpoint'
      ? upstream.responsesConfig?.capabilityProfiles
      : [];
  const resolved = resolveImageCapabilityCost(profiles, tier, quality);
  return { configured: resolved.configured, value: resolved.value };
}

function imageCostYuanToReportCredits(value: number) {
  const normalized = Number(value || 0);
  if (!Number.isFinite(normalized)) {
    return 0;
  }
  // Operational reports may use fractional cents. Accounting remains integer cents.
  return Math.max(0, yuanToMinorUnits(normalized));
}

function computeEligibleSuccessRate(completedCount: number, eligibleRequestCount: number) {
  if (!eligibleRequestCount) {
    return 0;
  }
  return completedCount / eligibleRequestCount;
}

async function buildChannelPerformanceReport(days: number) {
  const toExclusive = Date.now();
  const fromInclusive = toExclusive - days * 24 * 60 * 60 * 1000;
  const catalog = adminConsoleCatalogStore.get();
  const runtimeProviders = await listFreshAdminRuntimeProviders();
  const performanceData = await operationalRepository.getChannelPerformanceData(fromInclusive, toExclusive);
  const upstreamById = new Map(catalog.upstreams.map((item) => [item.id, item]));
  const runtimeProviderById = new Map(runtimeProviders.map((item) => [item.providerId, item]));
  const imageChannel = catalog.channels.find((item) => item.id === 'channel_image_generation');
  const textChannel = catalog.channels.find((item) => item.id === 'channel_text_processing');
  const imageTaskRows = performanceData.tasks.filter((item) => (
    normalizeChannelMetricId(item.channelId) === 'channel_image_generation'
  ));
  const imageBillingRows = performanceData.billing.filter((item) => (
    normalizeChannelMetricId(item.channelId) === 'channel_image_generation'
    && item.operation !== 'chat_completions'
  ));
  const textBillingRows = performanceData.billing.filter((item) => (
    normalizeChannelMetricId(item.channelId) === 'channel_text_processing'
    && item.operation === 'chat_completions'
  ));
  const textTraceRows = performanceData.traces.filter((item) => (
    normalizeChannelMetricId(item.channelId) === 'channel_text_processing'
  ));

  function summarizeTaskRows(rows: typeof imageTaskRows) {
    return rows.reduce((result, item) => ({
      requestCount: result.requestCount + item.requestCount,
      eligibleRequestCount: result.eligibleRequestCount + item.eligibleRequestCount,
      completedCount: result.completedCount + item.completedCount,
      failedCount: result.failedCount + item.failedCount,
      rejectedCount: result.rejectedCount + item.rejectedCount,
      runningCount: result.runningCount + item.runningCount,
      weightedDurationTotal: result.weightedDurationTotal + item.averageDurationMs * item.completedCount,
      lastActivityAt: Math.max(result.lastActivityAt, item.lastActivityAt || 0),
      generationCount: result.generationCount + item.generationCount,
      editCount: result.editCount + item.editCount,
    }), {
      requestCount: 0,
      eligibleRequestCount: 0,
      completedCount: 0,
      failedCount: 0,
      rejectedCount: 0,
      runningCount: 0,
      weightedDurationTotal: 0,
      lastActivityAt: 0,
      generationCount: 0,
      editCount: 0,
    });
  }

  function summarizeTraceRows(rows: typeof textTraceRows) {
    return rows.reduce((result, item) => ({
      requestCount: result.requestCount + item.requestCount,
      eligibleRequestCount: result.eligibleRequestCount + item.eligibleRequestCount,
      completedCount: result.completedCount + item.completedCount,
      failedCount: result.failedCount + item.failedCount,
      rejectedCount: result.rejectedCount + item.rejectedCount,
      runningCount: result.runningCount + item.runningCount,
      weightedDurationTotal: result.weightedDurationTotal + item.averageDurationMs * item.completedCount,
      lastActivityAt: Math.max(result.lastActivityAt, item.lastActivityAt || 0),
    }), {
      requestCount: 0,
      eligibleRequestCount: 0,
      completedCount: 0,
      failedCount: 0,
      rejectedCount: 0,
      runningCount: 0,
      weightedDurationTotal: 0,
      lastActivityAt: 0,
    });
  }

  function buildImageUpstreamMetric(upstreamId: string) {
    const runtimeProvider = runtimeProviderById.get(upstreamId);
    const tasks = summarizeTaskRows(imageTaskRows.filter((item) => item.upstreamId === upstreamId));
    const billingRows = imageBillingRows.filter((item) => item.upstreamId === upstreamId);
    let estimatedUpstreamCostCredits = 0;
    let costedImageCount = 0;
    for (const row of billingRows) {
      const tier = normalizeCostTier(row.tier);
      const quality = normalizeCostQuality(row.quality);
      const resolved = resolveConfiguredImageCost(upstreamById.get(upstreamId), tier, quality);
      if (resolved.configured) {
        estimatedUpstreamCostCredits += imageCostYuanToReportCredits(resolved.value) * row.unitCount;
        costedImageCount += row.unitCount;
      }
    }
    const chargedCredits = billingRows.reduce((sum, item) => sum + Math.max(0, Number(item.chargedCredits || 0)), 0);
    const generatedImageCount = billingRows.reduce((sum, item) => sum + item.unitCount, 0);
    return {
      upstreamId,
      healthState: runtimeProvider?.healthState || upstreamById.get(upstreamId)?.healthStatus || 'healthy',
      healthScore: Number(runtimeProvider?.healthScore || 0),
      requestCount: tasks.requestCount,
      eligibleRequestCount: tasks.eligibleRequestCount,
      completedCount: tasks.completedCount,
      failedCount: tasks.failedCount,
      rejectedCount: tasks.rejectedCount,
      runningCount: tasks.runningCount,
      successRate: computeEligibleSuccessRate(tasks.completedCount, tasks.eligibleRequestCount),
      generatedImageCount,
      chargedCredits,
      estimatedUpstreamCostCredits,
      estimatedGrossMarginCredits: chargedCredits - estimatedUpstreamCostCredits,
      costedImageCount,
      averageDurationMs: tasks.completedCount ? tasks.weightedDurationTotal / tasks.completedCount : 0,
      lastActivityAt: tasks.lastActivityAt || undefined,
      generationCount: tasks.generationCount,
      editCount: tasks.editCount,
    };
  }

  const textPolicyByUpstreamId = new Map((textChannel?.upstreamPolicies || []).map((item) => [item.upstreamId, item]));
  function buildTextUpstreamMetric(upstreamId: string) {
    const runtimeProvider = runtimeProviderById.get(upstreamId);
    const traces = summarizeTraceRows(textTraceRows.filter((item) => item.upstreamId === upstreamId));
    const billingRows = textBillingRows.filter((item) => item.upstreamId === upstreamId);
    const configuredCostYuan = Number(upstreamById.get(upstreamId)?.chatConfig?.upstreamCostYuan);
    // chatUnit is the legacy per-channel cost in cents; keep it as a compatibility fallback.
    const unitCost = Number.isFinite(configuredCostYuan)
      ? Math.max(0, yuanToMinorUnits(configuredCostYuan))
      : Math.max(0, Number(textPolicyByUpstreamId.get(upstreamId)?.pricing.chatUnit || 0) * 1_000);
    const billedUnitCount = billingRows.reduce((sum, item) => sum + Math.max(0, Number(item.unitCount || 0)), 0);
    const persistedUpstreamCostCredits = billingRows.reduce((sum, item) => (
      sum + Math.max(0, Number(item.upstreamUnitCostCredits || 0)) * Math.max(0, Number(item.unitCount || 0))
    ), 0);
    // Requests with a zero sell price have no billing row, so only those use the current configured fallback cost.
    const estimatedUpstreamCostCredits = persistedUpstreamCostCredits
      + Math.max(0, traces.completedCount - billedUnitCount) * unitCost;
    const chargedCredits = billingRows.reduce((sum, item) => sum + Math.max(0, Number(item.chargedCredits || 0)), 0);
    return {
      upstreamId,
      healthState: runtimeProvider?.healthState || upstreamById.get(upstreamId)?.healthStatus || 'healthy',
      healthScore: Number(runtimeProvider?.healthScore || 0),
      requestCount: traces.requestCount,
      eligibleRequestCount: traces.eligibleRequestCount,
      completedCount: traces.completedCount,
      failedCount: traces.failedCount,
      rejectedCount: traces.rejectedCount,
      runningCount: traces.runningCount,
      successRate: computeEligibleSuccessRate(traces.completedCount, traces.eligibleRequestCount),
      generatedImageCount: 0,
      chargedCredits,
      estimatedUpstreamCostCredits,
      estimatedGrossMarginCredits: chargedCredits - estimatedUpstreamCostCredits,
      costedImageCount: unitCost || !traces.completedCount ? traces.completedCount : 0,
      averageDurationMs: traces.completedCount ? traces.weightedDurationTotal / traces.completedCount : 0,
      lastActivityAt: traces.lastActivityAt || undefined,
      generationCount: 0,
      editCount: 0,
    };
  }

  const imageUpstreamIds = Array.from(new Set([
    ...(imageChannel?.upstreamIds || []),
    ...imageTaskRows.map((item) => item.upstreamId || ''),
    ...imageBillingRows.map((item) => item.upstreamId || ''),
  ].filter(Boolean)));
  const textUpstreamIds = Array.from(new Set([
    ...(textChannel?.upstreamIds || []),
    ...textTraceRows.map((item) => item.upstreamId || ''),
    ...textBillingRows.map((item) => item.upstreamId || ''),
  ].filter(Boolean)));
  const imageUpstreams = imageUpstreamIds.map(buildImageUpstreamMetric);
  const textUpstreams = textUpstreamIds.map(buildTextUpstreamMetric);

  function summarizeUpstreamMetrics(upstreams: typeof imageUpstreams) {
    const completedCount = upstreams.reduce((sum, item) => sum + item.completedCount, 0);
    const eligibleRequestCount = upstreams.reduce((sum, item) => sum + item.eligibleRequestCount, 0);
    return {
      requestCount: upstreams.reduce((sum, item) => sum + item.requestCount, 0),
      eligibleRequestCount,
      completedCount,
      failedCount: upstreams.reduce((sum, item) => sum + item.failedCount, 0),
      rejectedCount: upstreams.reduce((sum, item) => sum + item.rejectedCount, 0),
      runningCount: upstreams.reduce((sum, item) => sum + item.runningCount, 0),
      successRate: computeEligibleSuccessRate(completedCount, eligibleRequestCount),
      generatedImageCount: upstreams.reduce((sum, item) => sum + item.generatedImageCount, 0),
      chargedCredits: upstreams.reduce((sum, item) => sum + item.chargedCredits, 0),
      estimatedUpstreamCostCredits: upstreams.reduce((sum, item) => sum + item.estimatedUpstreamCostCredits, 0),
      estimatedGrossMarginCredits: upstreams.reduce((sum, item) => sum + item.estimatedGrossMarginCredits, 0),
      costedImageCount: upstreams.reduce((sum, item) => sum + item.costedImageCount, 0),
      averageDurationMs: completedCount
        ? upstreams.reduce((sum, item) => sum + item.averageDurationMs * item.completedCount, 0) / completedCount
        : 0,
      lastActivityAt: upstreams.reduce((latest, item) => Math.max(latest, item.lastActivityAt || 0), 0) || undefined,
      generationCount: upstreams.reduce((sum, item) => sum + item.generationCount, 0),
      editCount: upstreams.reduce((sum, item) => sum + item.editCount, 0),
    };
  }

  const imageTasksSummary = summarizeTaskRows(imageTaskRows);
  const imageSummaryBilling = imageBillingRows.reduce((result, row) => {
    const tier = normalizeCostTier(row.tier);
    const quality = normalizeCostQuality(row.quality);
    const resolved = resolveConfiguredImageCost(upstreamById.get(row.upstreamId || ''), tier, quality);
    if (resolved.configured) {
      result.estimatedUpstreamCostCredits += imageCostYuanToReportCredits(resolved.value) * row.unitCount;
      result.costedImageCount += row.unitCount;
    }
    result.generatedImageCount += row.unitCount;
    result.chargedCredits += Math.max(0, Number(row.chargedCredits || 0));
    return result;
  }, {
    generatedImageCount: 0,
    chargedCredits: 0,
    estimatedUpstreamCostCredits: 0,
    costedImageCount: 0,
  });
  const textSummaryBase = summarizeTraceRows(textTraceRows);
  const textCostSummary = summarizeUpstreamMetrics(textUpstreams);
  const imageSummary = {
    requestCount: imageTasksSummary.requestCount,
    eligibleRequestCount: imageTasksSummary.eligibleRequestCount,
    completedCount: imageTasksSummary.completedCount,
    failedCount: imageTasksSummary.failedCount,
    rejectedCount: imageTasksSummary.rejectedCount,
    runningCount: imageTasksSummary.runningCount,
    successRate: computeEligibleSuccessRate(imageTasksSummary.completedCount, imageTasksSummary.eligibleRequestCount),
    generatedImageCount: imageSummaryBilling.generatedImageCount,
    chargedCredits: imageSummaryBilling.chargedCredits,
    estimatedUpstreamCostCredits: imageSummaryBilling.estimatedUpstreamCostCredits,
    estimatedGrossMarginCredits: imageSummaryBilling.chargedCredits - imageSummaryBilling.estimatedUpstreamCostCredits,
    costedImageCount: imageSummaryBilling.costedImageCount,
    averageDurationMs: imageTasksSummary.completedCount
      ? imageTasksSummary.weightedDurationTotal / imageTasksSummary.completedCount
      : 0,
    lastActivityAt: imageTasksSummary.lastActivityAt || undefined,
    generationCount: imageTasksSummary.generationCount,
    editCount: imageTasksSummary.editCount,
  };
  const textSummary = {
    requestCount: textSummaryBase.requestCount,
    eligibleRequestCount: textSummaryBase.eligibleRequestCount,
    completedCount: textSummaryBase.completedCount,
    failedCount: textSummaryBase.failedCount,
    rejectedCount: textSummaryBase.rejectedCount,
    runningCount: textSummaryBase.runningCount,
    successRate: computeEligibleSuccessRate(textSummaryBase.completedCount, textSummaryBase.eligibleRequestCount),
    generatedImageCount: 0,
    chargedCredits: textCostSummary.chargedCredits,
    estimatedUpstreamCostCredits: textCostSummary.estimatedUpstreamCostCredits,
    estimatedGrossMarginCredits: textCostSummary.chargedCredits - textCostSummary.estimatedUpstreamCostCredits,
    costedImageCount: textCostSummary.costedImageCount,
    averageDurationMs: textSummaryBase.completedCount
      ? textSummaryBase.weightedDurationTotal / textSummaryBase.completedCount
      : 0,
    lastActivityAt: textSummaryBase.lastActivityAt || undefined,
    generationCount: 0,
    editCount: 0,
  };

  return {
    generatedAt: Date.now(),
    windowDays: days,
    fromInclusive,
    toExclusive,
    rows: [
      {
        channelId: 'channel_image_generation',
        ...imageSummary,
        upstreamId: '',
        upstreams: imageUpstreams,
      },
      {
        channelId: 'channel_text_processing',
        ...textSummary,
        upstreamId: '',
        upstreams: textUpstreams,
      },
    ],
  };
}

function buildOperationalRollupTable(rows: Array<{
  bucketStart: number;
  bucketMs: number;
  channelId?: string;
  upstreamId?: string;
  operation?: string;
  tier?: string;
  quality?: string;
  metrics?: Record<string, number>;
  detail?: Record<string, unknown>;
}>, upstreams: ConsoleUpstream[] = []) {
  const upstreamById = new Map(upstreams.map((item) => [item.id, item]));
  const grouped = new Map<string, {
    bucketStart: number;
    bucketMs: number;
    channelId: string;
    upstreamId: string;
    requestCount: number;
    eligibleRequestCount: number;
    completedCount: number;
    failedCount: number;
    rejectedCount: number;
    runningCount: number;
    generatedImageCount: number;
    chatRequestCount: number;
    chargedCredits: number;
    estimatedUpstreamCostCredits: number;
    costedImageCount: number;
    costedChatRequestCount: number;
    durationTotalMs: number;
    durationSampleCount: number;
    generationCount: number;
    editCount: number;
    tiers: Set<string>;
    qualities: Set<string>;
    lastActivityAt: number;
  }>();
  function normalizeRollupChannelId(value: unknown) {
    const normalized = String(value || '').trim();
    if (normalized === 'image_generation') {
      return 'channel_image_generation';
    }
    if (normalized === 'text_processing') {
      return 'channel_text_processing';
    }
    return normalized;
  }
  for (const row of rows) {
    const channelId = normalizeRollupChannelId(row.channelId);
    const key = [
      row.bucketStart,
      row.bucketMs,
      channelId,
      row.upstreamId || '',
    ].join('|');
    const current = grouped.get(key) || {
      bucketStart: row.bucketStart,
      bucketMs: row.bucketMs,
      channelId,
      upstreamId: row.upstreamId || '',
      requestCount: 0,
      eligibleRequestCount: 0,
      completedCount: 0,
      failedCount: 0,
      rejectedCount: 0,
      runningCount: 0,
      generatedImageCount: 0,
      chatRequestCount: 0,
      chargedCredits: 0,
      estimatedUpstreamCostCredits: 0,
      costedImageCount: 0,
      costedChatRequestCount: 0,
      durationTotalMs: 0,
      durationSampleCount: 0,
      generationCount: 0,
      editCount: 0,
      tiers: new Set<string>(),
      qualities: new Set<string>(),
      lastActivityAt: 0,
    };
    const metrics = row.metrics || {};
    const metricKind = String(row.detail?.metricKind || '');
    if (metricKind === 'billing') {
      const unitCount = Number(metrics.billedUnitCount ?? metrics.imageCount ?? metrics.chatRequestCount ?? 0);
      const isChat = row.operation === 'chat_completions'
        || normalizeRollupChannelId(row.channelId) === 'channel_text_processing';
      if (isChat) {
        current.chatRequestCount += unitCount;
      } else {
        current.generatedImageCount += unitCount;
      }
      current.chargedCredits += Number(metrics.chargedCredits || 0);
      const snapshotCost = Number(metrics.estimatedUpstreamCostCredits || 0);
      const snapshotCostedUnitCount = Number(metrics.costedUnitCount ?? metrics.costedImageCount ?? metrics.costedChatRequestCount ?? 0);
      if (snapshotCostedUnitCount > 0 || snapshotCost > 0) {
        current.estimatedUpstreamCostCredits += Math.max(0, snapshotCost);
        if (isChat) {
          current.costedChatRequestCount += Math.max(0, snapshotCostedUnitCount);
        } else {
          current.costedImageCount += Math.max(0, snapshotCostedUnitCount);
        }
      } else if (!isChat) {
        const tier = normalizeCostTier(row.tier);
        const quality = normalizeCostQuality(row.quality);
        const resolved = resolveConfiguredImageCost(upstreamById.get(row.upstreamId || ''), tier, quality);
        if (resolved.configured) {
          current.estimatedUpstreamCostCredits += imageCostYuanToReportCredits(resolved.value) * unitCount;
          current.costedImageCount += unitCount;
        }
      }
      if (row.tier) {
        current.tiers.add(row.tier);
      }
      if (row.quality) {
        current.qualities.add(row.quality);
      }
    } else {
      current.requestCount += Number(metrics.requestCount || 0);
      current.eligibleRequestCount += Number(metrics.eligibleRequestCount || 0);
      current.completedCount += Number(metrics.completedCount || 0);
      current.failedCount += Number(metrics.failedCount || 0);
      current.rejectedCount += Number(metrics.rejectedCount || 0);
      current.runningCount += Number(metrics.runningCount || 0);
      current.durationTotalMs += Number(metrics.durationTotalMs || 0);
      current.durationSampleCount += Number(metrics.completedCount || 0);
      current.generationCount += Number(metrics.generationCount || 0);
      current.editCount += Number(metrics.editCount || 0);
      current.lastActivityAt = Math.max(current.lastActivityAt, Number(metrics.lastActivityAt || 0));
    }
    grouped.set(key, current);
  }
  return Array.from(grouped.values())
    .sort((left, right) => right.bucketStart - left.bucketStart || left.channelId.localeCompare(right.channelId) || left.upstreamId.localeCompare(right.upstreamId))
    .map((row) => ({
      bucketStart: row.bucketStart,
      bucketEnd: row.bucketStart + row.bucketMs,
      bucketMs: row.bucketMs,
      channelId: row.channelId,
      upstreamId: row.upstreamId,
      requestCount: row.requestCount,
      eligibleRequestCount: row.eligibleRequestCount,
      completedCount: row.completedCount,
      failedCount: row.failedCount,
      rejectedCount: row.rejectedCount,
      runningCount: row.runningCount,
      successRate: row.eligibleRequestCount ? Math.round((row.completedCount / row.eligibleRequestCount) * 10000) / 100 : 0,
      generatedImageCount: row.generatedImageCount,
      chatRequestCount: row.chatRequestCount,
      chargedCredits: row.chargedCredits,
      estimatedUpstreamCostCredits: row.estimatedUpstreamCostCredits,
      estimatedGrossMarginCredits: row.chargedCredits - row.estimatedUpstreamCostCredits,
      grossMarginRate: row.chargedCredits
        ? Math.round(((row.chargedCredits - row.estimatedUpstreamCostCredits) / row.chargedCredits) * 10000) / 100
        : 0,
      costedImageCount: row.costedImageCount,
      costedChatRequestCount: row.costedChatRequestCount,
      averageDurationMs: row.durationSampleCount ? Math.round(row.durationTotalMs / row.durationSampleCount) : 0,
      generationCount: row.generationCount,
      editCount: row.editCount,
      tiers: Array.from(row.tiers).sort(),
      qualities: Array.from(row.qualities).sort(),
      lastActivityAt: row.lastActivityAt || undefined,
    }));
}

export function requireAdmin(request: FastifyRequest, reply: FastifyReply) {
  const token = parseCookie(request, cookieName);
  if (!token) {
    reply.code(401);
    throw new Error('admin_auth_required');
  }
  const session = parseSignedAdminSessionToken(token);
  if (!session) {
    reply.code(401);
    throw new Error('admin_auth_required');
  }
  return session;
}

export async function registerAdminRoutes(app: FastifyInstance) {
  await initializeAdminRouteStores();
  await syncCatalogUpstreamsToProviders(adminConsoleCatalogStore.get());

  app.post('/v1/admin/login', async (request, reply) => {
    const payload = loginSchema.parse(request.body);
    let expected;
    try {
      expected = getAdminCredentials();
    } catch {
      reply.code(503);
      return {
        success: false,
        message: 'Admin credentials are not configured.',
      };
    }
    if (payload.username !== expected.username || payload.password !== expected.password) {
      reply.code(401);
      return {
        success: false,
        message: 'Invalid credentials.',
      };
    }
    const session = createSession(payload.username);
    setSessionCookie(reply, session.token);
    return {
      success: true,
      user: {
        username: session.username,
      },
    };
  });

  app.post('/v1/admin/logout', async (request, reply) => {
    const token = parseCookie(request, cookieName);
    if (token) {
      clearSession(token);
    }
    clearSessionCookie(reply);
    return { success: true };
  });

  app.get('/v1/admin/session', async (request, reply) => {
    try {
      const session = requireAdmin(request, reply);
      return {
        authenticated: true,
        user: {
          username: session.username,
        },
      };
    } catch {
      reply.code(200);
      return {
        authenticated: false,
      };
    }
  });

  app.get('/v1/admin/providers', async (request, reply) => {
    requireAdmin(request, reply);
    return {
      providers: providerRegistry.list(),
    };
  });

  app.get('/v1/admin/catalog', async (request, reply) => {
    requireAdmin(request, reply);
    return adminConsoleCatalogStore.refreshAsync();
  });

  app.get('/v1/admin/reports/resolution-audit', async (request, reply) => {
    requireAdmin(request, reply);
    const query = resolutionAuditQuerySchema.parse(request.query);
    const [catalog, tasks] = await Promise.all([
      adminConsoleCatalogStore.refreshAsync(),
      operationalRepository.listTasks(query.limit || 1000),
    ]);
    return buildResolutionAuditReport(tasks, catalog);
  });

  app.get('/v1/admin/reports/billing-ledger', async (request, reply) => {
    requireAdmin(request, reply);
    const query = billingLedgerQuerySchema.parse(request.query);
    const [catalog, imageRows, chatRows, tasks] = await Promise.all([
      adminConsoleCatalogStore.refreshAsync(),
      operationalRepository.listBillingLedger({
        limit: query.limit || 1000,
        operations: ['generations', 'edits'],
      }),
      operationalRepository.listBillingLedger({
        limit: query.limit || 1000,
        operations: ['chat_completions'],
      }),
      operationalRepository.listTasks(query.limit || 1000),
    ]);
    const tenantNameById = new Map(catalog.tenants.map((item) => [item.id, item.name]));
    const apiKeyNameById = new Map(catalog.apiKeys.map((item) => [item.id, item.name]));
    const upstreamNameById = new Map(catalog.upstreams.map((item) => [item.id, item.name]));
    const requestedSizeByTaskId = new Map<string, string>();
    const requestedSizeByRequestId = new Map<string, string>();
    for (const task of tasks) {
      const payload = (task.requestPayload as { payload?: { size?: unknown; resolution?: unknown; aspect_ratio?: unknown } } | null)?.payload;
      const requestedSize = String(payload?.size || payload?.resolution || payload?.aspect_ratio || '').trim();
      if (!requestedSize) {
        continue;
      }
      requestedSizeByTaskId.set(task.taskId, requestedSize);
      requestedSizeByRequestId.set(task.requestId, requestedSize);
    }
    const decorateRows = (rows: typeof imageRows, includeImageDetails: boolean) => rows.map((row) => {
      const billingMode = typeof row.detail?.billingMode === 'string' && row.detail.billingMode
        ? row.detail.billingMode
        : typeof row.detail?.billedPricingMode === 'string'
          ? row.detail.billedPricingMode
          : '';
      const billingModeLabel = typeof row.detail?.billingModeLabel === 'string' && row.detail.billingModeLabel
        ? row.detail.billingModeLabel
        : billingMode === 'fixed_provider_flat_price'
          ? '固定线路一口价'
          : billingMode === 'global_chat_completions_unit_price'
            ? 'Chat Completions 按次计费'
            : '按请求尺寸档位';
      const requestedSize = includeImageDetails
        ? (typeof row.detail?.requestedSize === 'string' && row.detail.requestedSize
          ? row.detail.requestedSize
          : requestedSizeByTaskId.get(row.taskId || '') || requestedSizeByRequestId.get(row.requestId || ''))
        : undefined;
      const actualSize = includeImageDetails && typeof row.detail?.actualSize === 'string'
        ? row.detail.actualSize
        : undefined;
      const billedSize = includeImageDetails
        ? (typeof row.detail?.billedSize === 'string' && row.detail.billedSize ? row.detail.billedSize : row.size)
        : undefined;
      return {
        ...row,
        billingMode,
        billingModeLabel,
        requestedSize,
        actualSize,
        requestedQuality: includeImageDetails && typeof row.detail?.requestedQuality === 'string' && row.detail.requestedQuality
          ? row.detail.requestedQuality
          : includeImageDetails && typeof row.detail?.billedQuality === 'string' && row.detail.billedQuality
            ? row.detail.billedQuality
            : undefined,
        billedQuality: includeImageDetails && typeof row.detail?.billedQuality === 'string' && row.detail.billedQuality
          ? row.detail.billedQuality
          : includeImageDetails && typeof row.detail?.requestedQuality === 'string' && row.detail.requestedQuality
            ? row.detail.requestedQuality
            : undefined,
        billedSize: billingMode === 'fixed_provider_flat_price'
          ? '一口价'
          : billingMode === 'global_chat_completions_unit_price'
            ? '按次'
            : billedSize || actualSize || requestedSize,
        requestedTier: includeImageDetails && typeof row.detail?.requestedTier === 'string'
          ? row.detail.requestedTier
          : requestedSize === 'auto'
            ? 'auto'
            : undefined,
        actualTier: includeImageDetails && typeof row.detail?.actualTier === 'string' ? row.detail.actualTier : undefined,
        billedTier: billingMode === 'fixed_provider_flat_price'
          ? '一口价'
          : billingMode === 'global_chat_completions_unit_price'
            ? 'chat'
            : includeImageDetails && typeof row.detail?.billedTier === 'string'
              ? row.detail.billedTier
              : undefined,
        tenantName: tenantNameById.get(row.tenantId) || row.tenantId,
        apiKeyName: apiKeyNameById.get(row.apiKeyId) || row.apiKeyId,
        upstreamName: row.upstreamId ? (upstreamNameById.get(row.upstreamId) || row.upstreamId) : '',
      };
    });
    const image = decorateRows(imageRows, true);
    const chat = decorateRows(chatRows, false);
    return {
      generatedAt: Date.now(),
      total: image.length + chat.length,
      image: { total: image.length, rows: image },
      chat: { total: chat.length, rows: chat },
    };
  });

  app.get('/v1/admin/reports/audit-logs', async (request, reply) => {
    requireAdmin(request, reply);
    const query = z.object({
      limit: z.coerce.number().int().positive().max(2000).optional(),
    }).parse(request.query);
    const [catalog, rows] = await Promise.all([
      adminConsoleCatalogStore.refreshAsync(),
      operationalRepository.listAudit(query.limit || 500),
    ]);
    const upstreamNameById = new Map(catalog.upstreams.map((item) => [item.id, item.name]));
    const channelNameById = new Map(catalog.channels.map((item) => [item.id, item.name]));
    const tenantNameById = new Map(catalog.tenants.map((item) => [item.id, item.name]));
    const apiKeyNameById = new Map(catalog.apiKeys.map((item) => [item.id, item.name]));
    return {
      generatedAt: Date.now(),
      total: rows.length,
      summary: {
        successCount: rows.filter((row) => row.status === 'success').length,
        failedCount: rows.filter((row) => row.status === 'failed').length,
        acceptedCount: rows.filter((row) => row.status === 'accepted').length,
        adminActorCount: rows.filter((row) => row.actorType === 'admin').length,
        systemActorCount: rows.filter((row) => row.actorType === 'system').length,
        tenantKeyActorCount: rows.filter((row) => row.actorType === 'tenant_key').length,
        latestCreatedAt: rows[0]?.createdAt,
      },
      rows: rows.map((row) => {
        let targetName = row.targetId;
        if (row.targetType === 'upstream') {
          targetName = upstreamNameById.get(row.targetId) || row.targetId;
        } else if (row.targetType === 'channel') {
          targetName = channelNameById.get(row.targetId) || row.targetId;
        } else if (row.targetType === 'tenant') {
          targetName = tenantNameById.get(row.targetId) || row.targetId;
        } else if (row.targetType === 'api_key') {
          targetName = apiKeyNameById.get(row.targetId) || row.targetId;
        }
        return {
          ...row,
          targetName,
        };
      }),
    };
  });

  app.get('/v1/admin/reports/channel-performance', async (request, reply) => {
    requireAdmin(request, reply);
    const query = z.object({
      days: z.coerce.number().int().min(1).max(30).optional(),
    }).parse(request.query);
    return buildChannelPerformanceReport(query.days || 7);
  });

  app.get('/v1/admin/reports/operational-rollups', async (request, reply) => {
    requireAdmin(request, reply);
    const now = Date.now();
    const controlPlane = await adminControlPlaneStore.refreshAsync();
    const hardDisabledByEnv = String(process.env.OPERATIONAL_ROLLUP_ENABLED || '').trim().toLowerCase() === 'false';
    const enabled = Boolean(controlPlane.analytics.operationalRollupEnabled) && !hardDisabledByEnv;
    const query = z.object({
      metric_family: z.enum(['channel_performance', 'business_overview', 'billing_summary', 'custom']).optional(),
      from: z.coerce.number().int().positive().optional(),
      to: z.coerce.number().int().positive().optional(),
      days: z.coerce.number().int().min(1).max(365).optional(),
      channel_id: z.string().min(1).optional(),
      upstream_id: z.string().min(1).optional(),
      tenant_id: z.string().min(1).optional(),
      limit: z.coerce.number().int().positive().max(10000).optional(),
    }).parse(request.query);
    const toExclusive = query.to || now;
    const fromInclusive = query.from || (toExclusive - (query.days || 30) * 24 * 60 * 60 * 1000);
    if (!enabled) {
      return {
        generatedAt: now,
        fromInclusive,
        toExclusive,
        enabled,
        hardDisabledByEnv,
        intervalMinutes: controlPlane.analytics.operationalRollupIntervalMinutes,
        lookbackDays: controlPlane.analytics.operationalRollupLookbackDays,
        rows: [],
        tableRows: [],
        jobs: {
          channelPerformanceDaily: null,
        },
      };
    }
    const [rows, channelPerformanceJob, catalog] = await Promise.all([
      operationalRepository.listOperationalMetricRollups({
        metricFamily: query.metric_family,
        fromInclusive,
        toExclusive,
        channelId: query.channel_id,
        upstreamId: query.upstream_id,
        tenantId: query.tenant_id,
        limit: query.limit || 1000,
      }),
      operationalRepository.getOperationalRollupJob('channel_performance_daily_v1'),
      adminConsoleCatalogStore.refreshAsync(),
    ]);
    const tableRows = buildOperationalRollupTable(rows, catalog.upstreams);
    return {
      generatedAt: now,
      fromInclusive,
      toExclusive,
      enabled,
      hardDisabledByEnv,
      intervalMinutes: controlPlane.analytics.operationalRollupIntervalMinutes,
      lookbackDays: controlPlane.analytics.operationalRollupLookbackDays,
      rows,
      tableRows,
      jobs: {
        channelPerformanceDaily: channelPerformanceJob,
      },
    };
  });

  app.get('/v1/admin/reports/request-traces', async (request, reply) => {
    requireAdmin(request, reply);
    const query = z.object({
      limit: z.coerce.number().int().positive().max(1000).optional(),
    }).parse(request.query);
    const catalog = await adminConsoleCatalogStore.refreshAsync();
    const tenantNameById = new Map(catalog.tenants.map((item) => [item.id, item.name]));
    const apiKeyNameById = new Map(catalog.apiKeys.map((item) => [item.id, item.name]));
    const upstreamNameById = new Map(catalog.upstreams.map((item) => [item.id, item.name]));
    let rows;
    try {
      rows = await operationalRepository.listTraces(query.limit || 200);
    } catch (error) {
      const message = formatAdminRouteError(error);
      reply.code(500);
      return {
        success: false,
        message: `请求追踪数据读取失败：${message}`,
      };
    }
    return {
      generatedAt: Date.now(),
      total: rows.length,
      summary: {
        upstreamOnlyCount: rows.filter((row) => row.scope === 'upstream_only').length,
        fullChainCount: rows.filter((row) => row.scope === 'full_chain').length,
        successCount: rows.filter((row) => row.status === 'success').length,
        failedCount: rows.filter((row) => row.status === 'failed').length,
        latestCreatedAt: rows[0]?.createdAt,
      },
      rows: rows.map((row) => ({
        ...row,
        tenantName: row.tenantId ? (tenantNameById.get(row.tenantId) || row.tenantId) : '',
        apiKeyName: row.apiKeyId ? (apiKeyNameById.get(row.apiKeyId) || row.apiKeyId) : '',
        upstreamName: row.upstreamName || (row.upstreamId ? (upstreamNameById.get(row.upstreamId) || row.upstreamId) : ''),
      })),
    };
  });

  app.get('/v1/admin/reports/routing-diagnostics', async (request, reply) => {
    requireAdmin(request, reply);
    return buildRoutingDiagnosticsPayload();
  });

  app.get('/v1/admin/reports/request-traces/:traceId', async (request, reply) => {
    requireAdmin(request, reply);
    const params = z.object({ traceId: z.string().min(1) }).parse(request.params);
    const catalog = await adminConsoleCatalogStore.refreshAsync();
    const tenantNameById = new Map(catalog.tenants.map((item) => [item.id, item.name]));
    const apiKeyNameById = new Map(catalog.apiKeys.map((item) => [item.id, item.name]));
    const upstreamNameById = new Map(catalog.upstreams.map((item) => [item.id, item.name]));
    const row = await operationalRepository.getTrace(params.traceId);
    if (!row) {
      reply.code(404);
      return {
        success: false,
        message: '请求追踪记录不存在或已超过保留窗口。',
      };
    }
    const errorPayload = row.errorPayload && typeof row.errorPayload === 'object'
      ? row.errorPayload as Record<string, unknown>
      : null;
    return {
      ...row,
      tenantName: row.tenantId ? (tenantNameById.get(row.tenantId) || row.tenantId) : '',
      apiKeyName: row.apiKeyId ? (apiKeyNameById.get(row.apiKeyId) || row.apiKeyId) : '',
      upstreamName: row.upstreamName || (row.upstreamId ? (upstreamNameById.get(row.upstreamId) || row.upstreamId) : ''),
      failureCategory: row.failureCategory || (errorPayload ? String(errorPayload.failure_category || '') : ''),
      statusCode: row.statusCode || (errorPayload ? Number(errorPayload.status_code || (errorPayload.upstream as Record<string, unknown> | undefined)?.statusCode || 0) : 0),
    };
  });

  app.post('/v1/admin/reports/request-traces/clear', async (request, reply) => {
    const session = requireAdmin(request, reply);
    const [traceResult, imageResult] = await Promise.all([
      operationalRepository.clearTraces(),
      clearGeneratedTraceImages(),
    ]);
    await appendAuditRecord({
      actorType: 'admin',
      actorId: session.username,
      action: 'admin.request_traces.clear',
      targetType: 'task',
      targetId: 'request_traces',
      status: 'success',
      message: `清空请求追踪 ${traceResult.deletedCount} 条，并删除生成图片 ${imageResult.deletedCount} 个目录项。`,
      detail: {
        deletedTraceCount: traceResult.deletedCount,
        deletedImageCount: imageResult.deletedCount,
      },
    });
    return {
      success: true,
      deletedTraceCount: traceResult.deletedCount,
      deletedImageCount: imageResult.deletedCount,
    };
  });

  app.get('/v1/admin/reports/tenant-finance-ledger', async (request, reply) => {
    requireAdmin(request, reply);
    const query = tenantFinanceLedgerQuerySchema.parse(request.query);
    const [catalog, rows, balances] = await Promise.all([
      adminConsoleCatalogStore.refreshAsync(),
      operationalRepository.listTenantFinanceLedger(query.limit || 1000),
      operationalRepository.listTenantFinanceBalances(),
    ]);
    const tenantNameById = new Map(catalog.tenants.map((item) => [item.id, item.name]));
    const apiKeyNameById = new Map(catalog.apiKeys.map((item) => [item.id, item.name]));
    const balanceByTenantId = new Map(balances.map((item) => [item.tenantId, item]));
    const formatFinanceOperator = (operatorId: string) => {
      const normalized = String(operatorId || '').trim();
      if (normalized.startsWith('system:')) {
        const apiKeyId = normalized.slice('system:'.length);
        const apiKeyName = apiKeyNameById.get(apiKeyId);
        return apiKeyName ? `系统自动扣费 / API Key: ${apiKeyName}` : `系统自动扣费 / API Key: ${apiKeyId}`;
      }
      return normalized || '未知操作人';
    };
    const formatFinanceSource = (row: typeof rows[number]) => {
      if (row.detail?.source === 'image_request_charge') {
        return '图像消费';
      }
      return row.direction === 'credit' ? '充值' : '人工扣费';
    };
    return {
      generatedAt: Date.now(),
      total: rows.length,
      balances: balances.map((item) => ({
        ...item,
        tenantName: tenantNameById.get(item.tenantId) || item.tenantId,
      })),
      rows: rows.map((row) => ({
        ...row,
        tenantName: tenantNameById.get(row.tenantId) || row.tenantId,
        operatorLabel: formatFinanceOperator(row.operatorId),
        sourceLabel: formatFinanceSource(row),
        currentBalanceCents: balanceByTenantId.get(row.tenantId)?.balanceCents ?? row.balanceAfterCents,
      })),
    };
  });

  app.get('/v1/admin/reports/canvas-users', async (request, reply) => {
    requireAdmin(request, reply);
    const query = canvasUsersQuerySchema.parse(request.query);
    const sourceRows = postgresCanvasUserRepository
      ? await postgresCanvasUserRepository.list()
      : readCanvasUsers();
    const rows = sourceRows
      .slice(0, query.limit || 1000)
      .map((user) => ({
        id: user.id,
        username: user.username,
        email: user.email,
        tenantId: user.tenantId,
        apiKeyId: user.apiKeyId || '',
        status: user.status,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
        upstreamPreference: {
          mode: user.upstreamPreference?.mode || 'shared_platform',
          imageApiKind: user.upstreamPreference?.imageApiKind || 'images_endpoint',
          imagesBaseUrl: user.upstreamPreference?.imagesBaseUrl || '',
          chatBaseUrl: user.upstreamPreference?.chatBaseUrl || '',
          preferredAuthMode: user.upstreamPreference?.preferredAuthMode || 'bearer',
          chatFallbackMode: user.upstreamPreference?.chatFallbackMode || 'platform_fallback',
          hasImagesApiKey: Boolean(String(user.upstreamPreference?.imagesApiKey || '').trim()),
          hasChatApiKey: Boolean(String(user.upstreamPreference?.chatApiKey || '').trim()),
          updatedAt: user.upstreamPreference?.updatedAt || 0,
        },
      }));
    return {
      generatedAt: Date.now(),
      total: rows.length,
      rows,
    };
  });

  app.post('/v1/admin/tenant-finance-ledger', async (request, reply) => {
    const session = requireAdmin(request, reply);
    const body = tenantFinanceAdjustSchema.parse(request.body);
    const catalog = await adminConsoleCatalogStore.refreshAsync();
    const tenant = catalog.tenants.find((item) => item.id === body.tenantId);
    if (!tenant) {
      reply.code(404);
      return {
        error: 'tenant_not_found',
        message: 'Tenant not found.',
      };
    }
    const amountCents = yuanToMinorUnits(body.amountYuan);
    const record = await createTenantFinanceLedger({
      tenantId: body.tenantId,
      operatorId: session.username,
      direction: body.direction,
      amountCents,
      note: body.note,
      currency: 'cny',
    });
    await appendAuditRecord({
      actorType: 'admin',
      actorId: session.username,
      action: body.direction === 'credit' ? 'tenant_finance_credit' : 'tenant_finance_debit',
      targetType: 'tenant',
      targetId: body.tenantId,
      status: 'success',
      message: body.direction === 'credit' ? 'Tenant balance credited.' : 'Tenant balance debited.',
      detail: {
        tenantId: body.tenantId,
        amountCents,
        currency: 'cny',
        note: body.note,
        ledgerId: record.id,
      },
    });
    return record;
  });

  app.post('/v1/admin/catalog/upstreams', async (request, reply) => {
    requireAdmin(request, reply);
    try {
      const body = consoleUpstreamSchema.parse(request.body);
      const nextCatalog = await adminConsoleCatalogStore.saveUpstreamAsync(body);
      await syncCatalogUpstreamsToProviders(nextCatalog);
      return nextCatalog;
    } catch (error) {
      reply.code(error instanceof z.ZodError ? 400 : 500);
      return {
        success: false,
        message: `保存上游接入失败：${formatAdminRouteError(error)}`,
      };
    }
  });

  app.delete('/v1/admin/catalog/upstreams/:id', async (request, reply) => {
    requireAdmin(request, reply);
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    const nextCatalog = await adminConsoleCatalogStore.removeUpstreamAsync(params.id);
    await syncCatalogUpstreamsToProviders(nextCatalog);
    return nextCatalog;
  });

  app.post('/v1/admin/catalog/upstreams/:id/delete', async (request, reply) => {
    requireAdmin(request, reply);
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    const nextCatalog = await adminConsoleCatalogStore.removeUpstreamAsync(params.id);
    await syncCatalogUpstreamsToProviders(nextCatalog);
    return nextCatalog;
  });

  app.post('/v1/admin/catalog/upstreams/test', async (request, reply) => {
    requireAdmin(request, reply);
    const body = upstreamTestSchema.parse(request.body);
    const plan = await buildUpstreamTestRequestPlan(body.upstream, body.request);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 360_000);
    const startedAt = Date.now();
    let upstreamRequestStarted = false;
    try {
      const requestBody = await buildAdminUpstreamTestBody(plan);
      upstreamRequestStarted = true;
      const response = await fetch(plan.url, {
        method: plan.method,
        headers: plan.headers,
        body: requestBody,
        signal: controller.signal,
      });
      const responseText = await response.text();
      let responseJson: unknown = undefined;
      try {
        responseJson = JSON.parse(responseText);
      } catch {
        responseJson = undefined;
      }

      const responseHeaders: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        responseHeaders[key] = value;
      });

      const hasUsableImageOutput = adminResponseContainsUsableImageOutput({
        upstream: body.upstream,
        contentType: responseHeaders['content-type'],
        bodyJson: responseJson,
        bodyText: responseText,
      });
      const runtimeHealthUpdated = await reportAdminUpstreamTestAttempt({
        upstream: body.upstream,
        ok: response.ok && hasUsableImageOutput,
        statusCode: response.ok && !hasUsableImageOutput ? 502 : response.status,
        latencyMs: Date.now() - startedAt,
        bodyText: response.ok && !hasUsableImageOutput
          ? 'Upstream responded successfully but did not return usable image output.'
          : responseText,
        bodyJson: responseJson,
      });

      await appendRequestTrace({
        source: 'admin_upstream_test',
        scope: 'upstream_only',
        status: response.ok && hasUsableImageOutput ? 'success' : 'failed',
        summary: `${body.upstream.name} ${body.request.operation} returned HTTP ${response.status}.`,
        upstreamId: body.upstream.id,
        upstreamName: body.upstream.name,
        providerBaseUrl: body.upstream.baseUrl,
        operation: body.request.operation,
        upstreamRequest: {
          url: plan.url,
          method: plan.method,
          headers: plan.headers,
          bodyFormat: getRequestPlanBodyFormat(plan),
          body: plan.body,
        },
        upstreamResponse: {
          ok: response.ok,
          statusCode: response.status,
          headers: responseHeaders,
          bodyJson: responseJson,
          bodyText: responseText,
        },
        tags: ['admin-test'],
      });

      return {
        requestPlan: plan,
        response: {
          ok: response.ok,
          statusCode: response.status,
          headers: responseHeaders,
          bodyText: responseText,
          bodyJson: responseJson,
        },
        runtimeHealthUpdated,
        usableImageOutput: hasUsableImageOutput,
        summary: `${body.upstream.name} ${body.request.operation} returned HTTP ${response.status}.`,
      };
    } catch (error) {
      const runtimeHealthUpdated = upstreamRequestStarted
        ? await reportAdminUpstreamTestAttempt({
            upstream: body.upstream,
            ok: false,
            statusCode: 0,
            latencyMs: Date.now() - startedAt,
            fetchError: error,
          })
        : false;
      await appendRequestTrace({
        source: 'admin_upstream_test',
        scope: 'upstream_only',
        status: 'failed',
        summary: `${body.upstream.name} ${body.request.operation} failed: ${formatAdminRouteError(error)}`,
        upstreamId: body.upstream.id,
        upstreamName: body.upstream.name,
        providerBaseUrl: body.upstream.baseUrl,
        operation: body.request.operation,
        upstreamRequest: {
          url: plan.url,
          method: plan.method,
          headers: plan.headers,
          bodyFormat: getRequestPlanBodyFormat(plan),
          body: plan.body,
        },
        upstreamResponse: {
          ok: false,
          statusCode: 0,
          headers: {},
          bodyJson: {
            error: 'admin_upstream_test_failed',
            message: formatAdminRouteError(error),
          },
          bodyText: formatAdminRouteError(error),
        },
        tags: ['admin-test'],
      });
      reply.code(502);
      return {
        requestPlan: plan,
        response: {
          ok: false,
          statusCode: 0,
          headers: {},
          bodyText: formatAdminRouteError(error),
          bodyJson: {
            error: 'admin_upstream_test_failed',
            message: formatAdminRouteError(error),
          },
        },
        runtimeHealthUpdated,
        usableImageOutput: false,
        summary: `${body.upstream.name} ${body.request.operation} failed: ${formatAdminRouteError(error)}`,
      };
    } finally {
      clearTimeout(timer);
    }
  });

  app.post('/v1/admin/catalog/channels', async (request, reply) => {
    requireAdmin(request, reply);
    const body = consoleChannelSchema.parse(request.body);
    const nextCatalog = await adminConsoleCatalogStore.saveChannelAsync(body);
    await syncCatalogUpstreamsToProviders(nextCatalog);
    return nextCatalog;
  });

  app.post('/v1/admin/catalog/image-pricing', async (request, reply) => {
    requireAdmin(request, reply);
    const body = imagePricingMatrixSchema.parse(request.body);
    return adminConsoleCatalogStore.updateAsync((catalog) => ({
      ...catalog,
      imagePricingMatrix: body.rows,
      chatCompletionsUnitPrice: Math.max(0, Number(body.chatCompletionsUnitPrice ?? catalog.chatCompletionsUnitPrice ?? 0)),
      ...(body.chatCompletionsUnitPriceYuan !== undefined
        ? { chatCompletionsUnitPriceYuan: Math.max(0, Number(body.chatCompletionsUnitPriceYuan)) }
        : {}),
    }));
  });

  app.delete('/v1/admin/catalog/channels/:id', async (request, reply) => {
    requireAdmin(request, reply);
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    const nextCatalog = await adminConsoleCatalogStore.removeChannelAsync(params.id);
    await syncCatalogUpstreamsToProviders(nextCatalog);
    return nextCatalog;
  });

  app.post('/v1/admin/catalog/channels/:id/delete', async (request, reply) => {
    requireAdmin(request, reply);
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    const nextCatalog = await adminConsoleCatalogStore.removeChannelAsync(params.id);
    await syncCatalogUpstreamsToProviders(nextCatalog);
    return nextCatalog;
  });

  app.post('/v1/admin/catalog/tenants', async (request, reply) => {
    requireAdmin(request, reply);
    const body = consoleTenantSchema.parse(request.body);
    return adminConsoleCatalogStore.saveTenantAsync(body);
  });

  app.delete('/v1/admin/catalog/tenants/:id', async (request, reply) => {
    requireAdmin(request, reply);
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    await purgeTenantCanvasArtifacts(params.id);
    await operationalRepository.purgeTenantData(params.id);
    return adminConsoleCatalogStore.removeTenantAsync(params.id);
  });

  app.post('/v1/admin/catalog/tenants/:id/delete', async (request, reply) => {
    requireAdmin(request, reply);
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    await purgeTenantCanvasArtifacts(params.id);
    await operationalRepository.purgeTenantData(params.id);
    return adminConsoleCatalogStore.removeTenantAsync(params.id);
  });

  app.post('/v1/admin/catalog/api-keys', async (request, reply) => {
    requireAdmin(request, reply);
    const parsed = consoleApiKeySchema.parse(request.body);
    const fixedImageProviderIds = Array.from(new Set([
      ...(Array.isArray(parsed.fixedImageProviderIds) ? parsed.fixedImageProviderIds : []),
      parsed.fixedImageProviderId || '',
    ].map((providerId) => String(providerId || '').trim()).filter(Boolean)));
    const body = parsed.imageRoutingMode === 'fixed_provider'
      ? {
          ...parsed,
          fixedImageProviderId: fixedImageProviderIds[0] || '',
          fixedImageProviderIds,
        }
      : {
          ...parsed,
          fixedImageProviderId: '',
          fixedImageProviderIds: [],
          fixedImageFlatPrice: 0,
        };
    if (body.imageRoutingMode === 'fixed_provider') {
      if (!fixedImageProviderIds.length) {
        reply.code(400);
        return { error: 'fixed_provider_pool_required', message: '固定线路模式至少需要选择一条线路。' };
      }
      const catalog = await adminConsoleCatalogStore.refreshAsync();
      const imageChannel = catalog.channels.find((item) => item.id === 'channel_image_generation');
      const validProviderIds = new Set((catalog.upstreams || [])
        .filter((item) => imageChannel?.upstreamIds.includes(item.id))
        .filter((item) => item.kind === 'images_endpoint' || item.kind === 'responses_endpoint')
        .map((item) => item.id));
      const invalidProviderIds = fixedImageProviderIds.filter((providerId) => !validProviderIds.has(providerId));
      if (invalidProviderIds.length) {
        reply.code(400);
        return {
          error: 'invalid_fixed_provider_pool',
          message: '固定线路池只能选择当前图像业务通道中已配置的图像线路。',
          invalidProviderIds,
        };
      }
    }
    return adminConsoleCatalogStore.saveApiKeyAsync(body);
  });

  app.delete('/v1/admin/catalog/api-keys/:id', async (request, reply) => {
    requireAdmin(request, reply);
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    return adminConsoleCatalogStore.removeApiKeyAsync(params.id);
  });

  app.post('/v1/admin/catalog/api-keys/:id/delete', async (request, reply) => {
    requireAdmin(request, reply);
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    return adminConsoleCatalogStore.removeApiKeyAsync(params.id);
  });

  app.post('/v1/admin/catalog/api-keys/new-secret', async (request, reply) => {
    requireAdmin(request, reply);
    return createMaskedApiKey();
  });

  app.post('/v1/admin/onboarding/analyze', async (request, reply) => {
    requireAdmin(request, reply);
    const body = onboardingAnalyzeSchema.parse(request.body);
    const job = await createOnboardingAnalyzeJob();
    void (async () => {
      try {
        const result = await analyzeOnboardingInput(
          body,
          request,
          (entry, message) => {
            void appendOnboardingAnalyzeJobLog(job.jobId, entry, message).catch((error) => {
              console.warn('[admin] failed to persist onboarding analyze progress', error);
            });
          },
          (traceEntry) => persistOnboardingProbeTraceDetail({
            body,
            upstreamName: body.name || 'New upstream',
            providerBaseUrl: body.targetKind === 'images_endpoint'
              ? String(body.imagesGenerationUrl || body.imagesEditUrl || '')
              : String(body.baseUrl || ''),
            traceEntry,
          }),
        );
        await persistOnboardingProbeTraces({ body, request, result });
        const { probeTraceEntries: _probeTraceEntries, ...clientResult } = result as typeof result & {
          probeTraceEntries?: unknown;
        };
        await completeOnboardingAnalyzeJob(job.jobId, clientResult);
      } catch (error) {
        await failOnboardingAnalyzeJob(job.jobId, error instanceof Error ? error.message : '探测失败');
      }
    })();
    reply.code(202);
    return job;
  });

  app.get('/v1/admin/onboarding/analyze/:jobId', async (request, reply) => {
    requireAdmin(request, reply);
    const params = z.object({ jobId: z.string().min(1) }).parse(request.params);
    const job = await getOnboardingAnalyzeJob(params.jobId);
    if (!job) {
      reply.code(404);
      return {
        success: false,
        message: '探测任务不存在或已过期。',
      };
    }
    return job;
  });

  app.get('/v1/admin/provider-adapters', async (request, reply) => {
    requireAdmin(request, reply);
    return {
      adapters: providerAdapterCatalog,
    };
  });

  app.get('/v1/admin/control-plane', async (request, reply) => {
    requireAdmin(request, reply);
    return adminControlPlaneStore.refreshAsync();
  });

  app.put('/v1/admin/control-plane', async (request, reply) => {
    requireAdmin(request, reply);
    const body = controlPlaneSchema.parse(request.body) as AdminControlPlaneConfig;
    const saved = await adminControlPlaneStore.saveAsync(body);
    if (!saved.analytics.operationalRollupEnabled) {
      await operationalRepository.clearOperationalRollups({ metricFamily: 'channel_performance' });
    }
    return saved;
  });

  app.put('/v1/admin/providers', async (request, reply) => {
    requireAdmin(request, reply);
    const body = z.object({
      providers: z.array(providerSchema),
    }).parse(request.body);
    await providerRegistry.replaceAllAsync(body.providers as ProviderConfig[]);
    return {
      success: true,
      providers: await providerRegistry.refreshAsync(),
    };
  });

  app.post('/v1/admin/providers', async (request, reply) => {
    requireAdmin(request, reply);
    const provider = providerSchema.parse(request.body) as ProviderConfig;
    const current = await providerRegistry.refreshAsync();
    const next = current.filter((item) => item.providerId !== provider.providerId);
    next.push(provider);
    await providerRegistry.replaceAllAsync(next);
    return {
      success: true,
      provider,
    };
  });

  app.delete('/v1/admin/providers/:providerId', async (request, reply) => {
    requireAdmin(request, reply);
    const params = z.object({ providerId: z.string().min(1) }).parse(request.params);
    const current = await providerRegistry.refreshAsync();
    const next = current.filter((item) => item.providerId !== params.providerId);
    await providerRegistry.replaceAllAsync(next);
    return { success: true };
  });

  app.get('/v1/admin/overview', async (request, reply) => {
    requireAdmin(request, reply);
    const providers = await listFreshAdminRuntimeProviders();
    const controlPlane = await adminControlPlaneStore.refreshAsync();
    const protocolStats = providers.reduce<Record<string, number>>((acc, item) => {
      const key = item.protocol || 'unknown';
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {});
    const adapterStats = buildAdapterStats(providers);
    const [server, business, hotState] = await Promise.all([
      buildServerOverviewStats(),
      buildBusinessOverviewStats(),
      buildHotStateOverviewStats(),
    ]);
    return {
      stats: {
        totalProviders: providers.length,
        healthyProviders: providers.filter((item) => item.healthState === 'healthy').length,
        coolingProviders: providers.filter((item) => item.healthState === 'cooling').length,
        degradedProviders: providers.filter((item) => item.healthState === 'degraded').length,
        imageCapableProviders: providers.filter((item) => item.supportsImage !== false).length,
      },
      routing: {
        allowUserSuppliedKey: controlPlane.routing.allowUserSuppliedKey,
        smartRoutingCostPriorityBaseDelta: controlPlane.routing.smartRoutingCostPriorityBaseDelta,
      },
      publicApi: controlPlane.publicApi,
      server,
      business,
      hotState,
      protocolStats,
      adapterStats,
      providers,
    };
  });
}

async function buildServerOverviewStats() {
  const cpuCount = os.cpus().length || 1;
  const loadAverage = os.loadavg();
  const totalMemoryBytes = os.totalmem();
  const freeMemoryBytes = os.freemem();
  const processMemory = process.memoryUsage();
  const diskPath = process.env.GENERATED_IMAGE_DIR || process.cwd();
  let disk: {
    path: string;
    totalBytes: number;
    freeBytes: number;
    usedBytes: number;
    usedPercent: number;
  } | null = null;

  try {
    const stat = await fs.statfs(diskPath);
    const totalBytes = Number(stat.blocks) * Number(stat.bsize);
    const freeBytes = Number(stat.bavail) * Number(stat.bsize);
    const usedBytes = Math.max(0, totalBytes - freeBytes);
    disk = {
      path: diskPath,
      totalBytes,
      freeBytes,
      usedBytes,
      usedPercent: totalBytes > 0 ? Math.round((usedBytes / totalBytes) * 10000) / 100 : 0,
    };
  } catch {
    disk = null;
  }

  return {
    generatedAt: Date.now(),
    hostname: os.hostname(),
    platform: `${os.platform()} ${os.arch()}`,
    nodeVersion: process.version,
    pid: process.pid,
    uptimeSeconds: Math.floor(process.uptime()),
    systemUptimeSeconds: Math.floor(os.uptime()),
    cpuCount,
    loadAverage,
    loadPercent1m: Math.round((loadAverage[0] / cpuCount) * 10000) / 100,
    memory: {
      totalBytes: totalMemoryBytes,
      freeBytes: freeMemoryBytes,
      usedBytes: Math.max(0, totalMemoryBytes - freeMemoryBytes),
      usedPercent: totalMemoryBytes > 0
        ? Math.round(((totalMemoryBytes - freeMemoryBytes) / totalMemoryBytes) * 10000) / 100
        : 0,
    },
    processMemory: {
      rssBytes: processMemory.rss,
      heapUsedBytes: processMemory.heapUsed,
      heapTotalBytes: processMemory.heapTotal,
      externalBytes: processMemory.external,
    },
    disk,
    redisEnabled: Boolean(process.env.REDIS_URL && String(process.env.REDIS_URL).trim()),
    databaseEnabled: Boolean(process.env.DATABASE_URL && String(process.env.DATABASE_URL).trim()),
  };
}

async function buildBusinessOverviewStats() {
  try {
    const now = Date.now();
    const oneHourAgo = now - 60 * 60 * 1000;
    const oneDayAgo = now - 24 * 60 * 60 * 1000;
    const [overview, balances] = await Promise.all([
      operationalRepository.getBusinessOverviewData({
        oneHourAgo,
        oneDayAgo,
        toExclusive: now,
      }),
      operationalRepository.listTenantFinanceBalances(),
    ]);
    const totalBalanceCents = balances.reduce((sum, item) => sum + Number(item.balanceCents || 0), 0);
    const totalDebitedCents = balances.reduce((sum, item) => sum + Number(item.totalDebitedCents || 0), 0);
    const requests1h = overview.imageRequests1h + overview.textRequests1h;
    const eligibleRequests1h = overview.imageEligibleRequests1h + overview.textEligibleRequests1h;
    const success1h = overview.imageSuccess1h + overview.textSuccess1h;
    const rejected1h = overview.imageRejected1h + overview.textRejected1h;
    const requests24h = overview.imageRequests24h + overview.textRequests24h;
    const eligibleRequests24h = overview.imageEligibleRequests24h + overview.textEligibleRequests24h;
    const success24h = overview.imageSuccess24h + overview.textSuccess24h;
    const failed24h = overview.imageFailed24h + overview.textFailed24h;
    const rejected24h = overview.imageRejected24h + overview.textRejected24h;

    return {
      traceSampleSize: 0,
      requests1h,
      eligibleRequests1h,
      success1h,
      rejected1h,
      requests24h,
      eligibleRequests24h,
      success24h,
      failed24h,
      rejected24h,
      successRate1h: eligibleRequests1h ? Math.round((success1h / eligibleRequests1h) * 10000) / 100 : 0,
      successRate24h: eligibleRequests24h ? Math.round((success24h / eligibleRequests24h) * 10000) / 100 : 0,
      imageRequests1h: overview.imageRequests1h,
      imageEligibleRequests1h: overview.imageEligibleRequests1h,
      imageSuccess1h: overview.imageSuccess1h,
      imageRejected1h: overview.imageRejected1h,
      imageSuccessRate1h: overview.imageEligibleRequests1h
        ? Math.round((overview.imageSuccess1h / overview.imageEligibleRequests1h) * 10000) / 100
        : 0,
      imageRequests24h: overview.imageRequests24h,
      imageEligibleRequests24h: overview.imageEligibleRequests24h,
      imageSuccess24h: overview.imageSuccess24h,
      imageFailed24h: overview.imageFailed24h,
      imageRejected24h: overview.imageRejected24h,
      imageSuccessRate24h: overview.imageEligibleRequests24h
        ? Math.round((overview.imageSuccess24h / overview.imageEligibleRequests24h) * 10000) / 100
        : 0,
      charged24hCents: overview.charged24hCents,
      completedTasks24h: success24h,
      runningTasksCurrent: overview.runningTasksCurrent,
      averageImageDuration24hMs: overview.imageAverageDuration24hMs,
      tenantBalanceTotalCents: totalBalanceCents,
      tenantDebitedTotalCents: totalDebitedCents,
      tenantBalanceCount: balances.length,
    };
  } catch {
    return {
      traceSampleSize: 0,
      requests1h: 0,
      eligibleRequests1h: 0,
      success1h: 0,
      rejected1h: 0,
      requests24h: 0,
      eligibleRequests24h: 0,
      success24h: 0,
      failed24h: 0,
      rejected24h: 0,
      successRate1h: 0,
      successRate24h: 0,
      imageRequests1h: 0,
      imageEligibleRequests1h: 0,
      imageSuccess1h: 0,
      imageRejected1h: 0,
      imageSuccessRate1h: 0,
      imageRequests24h: 0,
      imageEligibleRequests24h: 0,
      imageSuccess24h: 0,
      imageFailed24h: 0,
      imageRejected24h: 0,
      imageSuccessRate24h: 0,
      charged24hCents: 0,
      completedTasks24h: 0,
      runningTasksCurrent: 0,
      averageImageDuration24hMs: 0,
      tenantBalanceTotalCents: 0,
      tenantDebitedTotalCents: 0,
      tenantBalanceCount: 0,
    };
  }
}

async function buildHotStateOverviewStats() {
  try {
    if (asyncHotStateStore) {
      const [
        providerRuntime,
        providerHealth,
        rateLimitBuckets,
        concurrencyCounters,
        onboardingAnalyzeJobs,
        imageTasks,
        workflowRuns,
      ] = await Promise.all([
        asyncHotStateStore.listProviderRuntime(),
        asyncHotStateStore.listProviderHealth(),
        asyncHotStateStore.listRateLimitBuckets(),
        asyncHotStateStore.listConcurrencyCounters(),
        asyncHotStateStore.listOnboardingAnalyzeJobs(),
        asyncHotStateStore.listImageTasks(),
        asyncHotStateStore.listWorkflowRuns(),
      ]);
      return {
        providerRuntimeCount: providerRuntime.length,
        providerHealthCount: providerHealth.length,
        rateLimitBucketCount: rateLimitBuckets.length,
        concurrencyCounterCount: concurrencyCounters.length,
        onboardingAnalyzeJobCount: onboardingAnalyzeJobs.length,
        imageTaskCount: imageTasks.length,
        workflowRunCount: workflowRuns.length,
      };
    }
    return {
      providerRuntimeCount: hotStateStore.listProviderRuntime().length,
      providerHealthCount: hotStateStore.listProviderHealth().length,
      rateLimitBucketCount: hotStateStore.listRateLimitBuckets().length,
      concurrencyCounterCount: hotStateStore.listConcurrencyCounters().length,
      onboardingAnalyzeJobCount: hotStateStore.listOnboardingAnalyzeJobs().length,
      imageTaskCount: hotStateStore.listImageTasks().length,
      workflowRunCount: hotStateStore.listWorkflowRuns().length,
    };
  } catch {
    return {
      providerRuntimeCount: 0,
      providerHealthCount: 0,
      rateLimitBucketCount: 0,
      concurrencyCounterCount: 0,
      onboardingAnalyzeJobCount: 0,
      imageTaskCount: 0,
      workflowRunCount: 0,
    };
  }
}

function buildAdapterStats(providers: ProviderConfig[]) {
  const stats = providerAdapterCatalog.map((adapter) => ({
    adapterKey: adapter.adapterKey,
    title: adapter.title,
    providerCount: providers.filter((item) => matchProviderAdapter(item, adapter.adapterKey)).length,
  }));
  return stats;
}

function matchProviderAdapter(provider: ProviderConfig, adapterKey: string) {
  const current = String(provider.metadata?.adapterKey || '').trim();
  if (current) {
    return current === adapterKey;
  }

  if (adapterKey === 'jingyu_unified_async') {
    return provider.protocol === 'custom_async_media';
  }

  return provider.protocol === adapterKey;
}

function mapUpstreamKindToProtocol(kind: ConsoleUpstream['kind']): ProviderConfig['protocol'] {
  if (kind === 'responses_endpoint') {
    return 'openai_responses';
  }
  if (kind === 'chat_completions') {
    return 'openai_chat';
  }
  return 'openai_images';
}

function toProviderConfig(upstream: ConsoleUpstream, policy?: ReturnType<typeof adminConsoleCatalogStore.get>['channels'][number]['upstreamPolicies'][number]): ProviderConfig {
  const supportsImage = upstream.kind !== 'chat_completions';
  const protocol = mapUpstreamKindToProtocol(upstream.kind);
  const responsesConfig = upstream.responsesConfig;
  const enabled = upstream.enabled;
  return {
    providerId: upstream.id,
    name: upstream.name,
    source: 'admin_managed',
    protocol,
    baseUrl: upstream.baseUrl,
    apiKey: upstream.apiKey,
    modelAllowlist: upstream.modelHints,
    healthState: enabled
      ? (upstream.healthStatus === 'disabled' ? 'degraded' : upstream.healthStatus)
      : 'disabled',
    supportsImage,
    supportsVideo: false,
    capability: {
      supportsSync: true,
      supportsAsync:
        upstream.kind === 'images_endpoint'
          ? Boolean(upstream.imagesConfig?.supportsAsync)
          : false,
      supportsImageGeneration: upstream.kind === 'images_endpoint'
        ? Boolean(upstream.imagesConfig?.supportsGenerations)
        : upstream.kind === 'responses_endpoint',
      supportsImageEdit: upstream.kind === 'images_endpoint'
        ? Boolean(upstream.imagesConfig?.supportsEdits)
        : upstream.kind === 'responses_endpoint'
          ? Boolean(upstream.responsesConfig?.supportsImageInput)
          : false,
      supportsReferenceImages:
        upstream.kind === 'images_endpoint'
          ? Boolean(upstream.imagesConfig?.supportsEdits)
          : upstream.kind === 'responses_endpoint'
            ? Boolean(upstream.responsesConfig?.supportsImageInput)
            : Boolean(upstream.chatConfig?.supportsVisionInput),
    },
    passthrough: upstream.passthrough,
    metadata: {
      consoleUpstreamKind: upstream.kind,
      max_concurrency: Math.max(1, Math.floor(Number(upstream.maxConcurrency || 10))),
      provider_max_concurrency: Math.max(1, Math.floor(Number(upstream.maxConcurrency || 10))),
      upstream_max_concurrency: Math.max(1, Math.floor(Number(upstream.maxConcurrency || 10))),
      ...(upstream.kind === 'responses_endpoint' && responsesConfig ? {
        responses_supports_image_input: responsesConfig.supportsImageInput,
        responses_text_model: responsesConfig.textModel,
        responses_image_model: responsesConfig.imageModel || '',
        reasoning_effort: responsesConfig.reasoningEffort,
        responses_return_mode: responsesConfig.returnMode,
        responses_input_shape: responsesConfig.inputShape,
        responses_tool_choice: responsesConfig.toolChoice,
        responses_tool_choice_format: responsesConfig.toolChoiceFormat,
        responses_model_routing: responsesConfig.modelRouting,
        responses_moderation_mode: responsesConfig.moderationMode,
        responses_response_formats: responsesConfig.responseFormats,
        responses_json_reference_transports: responsesConfig.jsonReferenceTransports,
        responses_allow_direct_public_image_url: responsesConfig.allowDirectPublicImageUrl === true,
        responses_image_tool_quality: responsesConfig.imageToolQuality || '',
        responses_image_quality: responsesConfig.imageQuality ?? null,
        responses_capability_profiles: responsesConfig.capabilityProfiles,
      } : {}),
      ...(upstream.kind === 'images_endpoint' && upstream.imagesConfig ? {
        images_image_input_mode: upstream.imagesConfig.imageInputMode,
        images_edit_protocols: upstream.imagesConfig.editProtocolModes,
        images_json_reference_transports: upstream.imagesConfig.jsonReferenceTransports,
        images_edit_reference_mode: upstream.imagesConfig.editReferenceMode,
        images_response_formats: upstream.imagesConfig.responseFormats,
        images_allow_direct_public_image_url: upstream.imagesConfig.allowDirectPublicImageUrl === true,
        images_supports_async: upstream.imagesConfig.supportsAsync,
        images_supports_generations: upstream.imagesConfig.supportsGenerations,
        images_supports_edits: upstream.imagesConfig.supportsEdits,
        images_return_mode: upstream.imagesConfig.returnMode,
        images_edit_request_format: upstream.imagesConfig.editRequestFormat,
        reference_image_transport: upstream.imagesConfig.referenceImageTransport,
        images_capability_profiles: upstream.imagesConfig.capabilityProfiles,
        images_generations_url: upstream.imagesConfig.generationsUrl || '',
        images_edits_url: upstream.imagesConfig.editsUrl || '',
        images_async_generations_url: upstream.imagesConfig.asyncGenerationsUrl || '',
        images_async_edits_url: upstream.imagesConfig.asyncEditsUrl || '',
        images_async_result_url_template: upstream.imagesConfig.asyncResultUrlTemplate || '',
      } : {}),
    },
  };
}

async function syncCatalogUpstreamsToProviders(catalog: ReturnType<typeof adminConsoleCatalogStore.get>) {
  const imageChannel = catalog.channels.find((item) => item.id === 'channel_image_generation');
  const textChannel = catalog.channels.find((item) => item.id === 'channel_text_processing');
  const policyByUpstreamId = new Map([
    ...((imageChannel?.upstreamPolicies || []).map((item) => [item.upstreamId, item] as const)),
    ...((textChannel?.upstreamPolicies || []).map((item) => [item.upstreamId, item] as const)),
  ]);
  const imageChannelUpstreamIds = new Set(imageChannel?.enabled === false ? [] : (imageChannel?.upstreamIds || []));
  const textChannelUpstreamIds = new Set(textChannel?.enabled === false ? [] : (textChannel?.upstreamIds || []));
  const providers = catalog.upstreams
    .filter((upstream) => {
      if (upstream.kind === 'chat_completions') {
        return textChannel ? textChannelUpstreamIds.has(upstream.id) : true;
      }
      if (upstream.kind === 'images_endpoint' || upstream.kind === 'responses_endpoint') {
        return imageChannel ? imageChannelUpstreamIds.has(upstream.id) : true;
      }
      return false;
    })
    .map((upstream) => toProviderConfig(upstream, policyByUpstreamId.get(upstream.id)));
  await providerRegistry.replaceAllAsync(providers);
}

async function buildUpstreamTestRequestPlan(upstream: ConsoleUpstream, input: z.infer<typeof upstreamTestRequestSchema>) {
  if (upstream.kind === 'images_endpoint' || upstream.kind === 'responses_endpoint') {
    const body: OpenAIImagesRequest = {
      model: input.model,
      prompt: input.prompt,
      size: input.size,
      quality: input.quality,
      response_format: input.responseFormat || 'url',
      n: input.n,
      image: input.referenceImageUrl,
      image_tool_quality: input.imageToolQuality,
      image_quality: input.imageQuality,
      output_format: input.outputFormat,
      output_compression: input.outputCompression,
      background: input.background && input.background !== 'omit' ? input.background : undefined,
      moderation: input.moderation && input.moderation !== 'omit' ? input.moderation : undefined,
      partial_images: input.partialImages,
      metadata: upstream.kind === 'responses_endpoint' ? {
        responses_input_shape: input.responsesInputShape,
        responses_tool_choice: input.responsesToolChoice,
        responses_tool_choice_format: input.responsesToolChoiceFormat,
      } : undefined,
      extra_body: {
        ...(input.stream !== undefined ? { stream: input.stream } : {}),
      },
    };
    const provider = toProviderConfig(upstream);
    const adapted = await adaptOpenAIImagesPayloadForProvider(provider, body);
    return buildImageRequestPlanForProvider(
      provider,
      (upstream.kind === 'responses_endpoint' ? Boolean(input.referenceImageUrl) : input.operation === 'edits')
        ? 'edits'
        : 'generations',
      adapted,
    );
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (upstream.apiKey) {
    headers.Authorization = `Bearer ${upstream.apiKey}`;
  }
  if (upstream.passthrough?.injectHeaders) {
    Object.assign(headers, upstream.passthrough.injectHeaders);
  }
  const body: Record<string, unknown> = {
    model: input.model,
    messages: [
      {
        role: 'user',
        content: input.referenceImageUrl
          ? [
              { type: 'text', text: input.prompt },
              { type: 'image_url', image_url: { url: input.referenceImageUrl } },
            ]
          : input.prompt,
      },
    ],
    ...(input.stream !== undefined ? { stream: input.stream } : {}),
  };
  const customBodyFields = sanitizeAdminInjectedBodyFields(
    upstream.passthrough?.injectBodyFields,
    reservedChatTestBodyFields,
  );
  if (Object.keys(customBodyFields).length) {
    Object.assign(body, customBodyFields);
  }
  return {
    url: String(upstream.baseUrl || '').trim().replace(/\/+$/, ''),
    method: 'POST' as const,
    headers,
    body,
  };
}

function getRequestPlanBodyFormat(
  plan: Awaited<ReturnType<typeof buildUpstreamTestRequestPlan>>,
): 'json' | 'multipart' {
  return 'bodyFormat' in plan ? (plan.bodyFormat || 'json') : 'json';
}

async function buildAdminUpstreamTestBody(plan: {
  body?: Record<string, unknown>;
  bodyFormat?: 'json' | 'multipart';
}) {
  if ((plan.bodyFormat || 'json') === 'json') {
    return JSON.stringify(plan.body || {});
  }

  const form = new FormData();
  for (const [key, value] of Object.entries(plan.body || {})) {
    if (value === undefined || value === null) {
      continue;
    }
    if (key === 'image') {
      const values = Array.isArray(value) ? value : [value];
      for (const item of values) {
        if (typeof item === 'string') {
          const part = await buildAdminMultipartFilePart(item);
          if (part) {
            form.append(key, part.blob, part.fileName);
          } else {
            form.append(key, item);
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

function adminDetectImageExtensionFromBuffer(buffer: Buffer) {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]))) {
    return 'png';
  }
  if (buffer.length >= 3 && buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) {
    return 'jpg';
  }
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') {
    return 'webp';
  }
  return 'png';
}

function adminContentTypeForExtension(ext: string) {
  if (ext === 'jpg' || ext === 'jpeg') {
    return 'image/jpeg';
  }
  if (ext === 'webp') {
    return 'image/webp';
  }
  return 'image/png';
}

function adminDecodeImagePayload(value: string) {
  const raw = String(value || '').trim();
  const dataUrlMatch = raw.match(/^data:image\/([a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/i);
  if (dataUrlMatch) {
    const ext = String(dataUrlMatch[1] || 'png').toLowerCase() === 'jpeg' ? 'jpg' : String(dataUrlMatch[1] || 'png').toLowerCase();
    return {
      buffer: Buffer.from(dataUrlMatch[2].replace(/\s+/g, ''), 'base64'),
      extension: ext,
    };
  }
  const normalized = raw.replace(/\s+/g, '');
  if (normalized.length >= 64 && /^[A-Za-z0-9+/=]+$/.test(normalized)) {
    const buffer = Buffer.from(normalized, 'base64');
    return {
      buffer,
      extension: adminDetectImageExtensionFromBuffer(buffer),
    };
  }
  return null;
}

async function buildAdminMultipartFilePart(value: string) {
  const raw = String(value || '').trim();
  if (!raw) {
    return null;
  }
  if (/^https?:\/\//i.test(raw)) {
    const response = await fetch(raw);
    if (!response.ok) {
      throw new Error(`Failed to fetch multipart test image: HTTP ${response.status}`);
    }
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const extension = adminDetectImageExtensionFromBuffer(buffer);
    return {
      blob: new Blob([buffer], { type: adminContentTypeForExtension(extension) }),
      fileName: `reference.${extension}`,
    };
  }
  const decoded = adminDecodeImagePayload(raw);
  if (!decoded) {
    return null;
  }
  return {
    blob: new Blob([decoded.buffer], { type: adminContentTypeForExtension(decoded.extension) }),
    fileName: `reference.${decoded.extension}`,
  };
}

async function listFreshAdminRuntimeProviders(options: { includeConcurrency?: boolean } = {}) {
  const initialProviders = providerRegistry.list();
  const providerIds = initialProviders.map((item) => item.providerId);
  await refreshHotProviderRuntime(providerIds);
  if (options.includeConcurrency) {
    await refreshHotConcurrencyCounters(providerIds.map((providerId) => `provider:${providerId}`));
  }
  return providerRegistry.list();
}

async function reportAdminUpstreamTestAttempt(input: {
  upstream: ConsoleUpstream;
  ok: boolean;
  statusCode: number;
  latencyMs: number;
  bodyText?: string;
  bodyJson?: unknown;
  fetchError?: unknown;
}) {
  const provider = providerRegistry.list().find((item) => item.providerId === input.upstream.id);
  if (!provider) {
    return false;
  }

  if (input.ok) {
    await providerRegistry.reportAttempt({
      providerId: input.upstream.id,
      ok: true,
      statusCode: input.statusCode,
      failedAt: Date.now(),
      latencyMs: input.latencyMs,
    });
    return true;
  }

  const failure = classifyUpstreamFailure({
    statusCode: input.statusCode,
    bodyText: input.bodyText,
    bodyJson: input.bodyJson,
    fetchError: input.fetchError,
  });
  await providerRegistry.reportAttempt({
    providerId: input.upstream.id,
    ok: false,
    statusCode: input.statusCode,
    failedAt: Date.now(),
    cooldownMs: failure.cooldownMs,
    affectsHealth: failure.affectsHealth,
    latencyMs: input.latencyMs,
    failureCategory: failure.category,
    errorMessage: input.fetchError instanceof Error
      ? input.fetchError.message
      : String(input.bodyText || input.fetchError || '').slice(0, 500),
  });
  return true;
}

function adminResponseContainsUsableImageOutput(input: {
  upstream: ConsoleUpstream;
  contentType?: string;
  bodyJson?: unknown;
  bodyText?: string;
}) {
  const contentType = String(input.contentType || '').toLowerCase();
  if (contentType.startsWith('image/')) {
    return true;
  }

  const candidates = [
    ...(input.bodyJson !== undefined ? [input.bodyJson] : []),
    ...adminParseSsePayloads(String(input.bodyText || '')),
    adminTryParseJson(String(input.bodyText || '')),
  ].filter((item) => item !== undefined);

  for (const candidate of candidates) {
    if (adminPayloadContainsImage(candidate, input.upstream.kind === 'responses_endpoint')) {
      return true;
    }
  }
  return false;
}

function adminPayloadContainsImage(value: unknown, responsesMode: boolean): boolean {
  if (!value) {
    return false;
  }
  if (typeof value === 'string') {
    return adminLooksLikeBase64ImagePayload(value);
  }
  if (Array.isArray(value)) {
    return value.some((item) => adminPayloadContainsImage(item, responsesMode));
  }
  if (typeof value !== 'object') {
    return false;
  }

  const record = value as Record<string, unknown>;
  if (
    adminLooksLikeImageUrl(record.url)
    || adminLooksLikeBase64ImagePayload(record.b64_json)
    || adminLooksLikeImageUrl(record.image_url)
    || adminLooksLikeBase64ImagePayload(record.result)
  ) {
    return true;
  }

  if (
    responsesMode
    && record.type === 'image_generation_call'
    && (record.status === undefined || record.status === 'completed')
    && adminLooksLikeBase64ImagePayload(record.result)
  ) {
    return true;
  }

  if (record.item && adminPayloadContainsImage(record.item, responsesMode)) {
    return true;
  }
  if (record.response && adminPayloadContainsImage(record.response, responsesMode)) {
    return true;
  }
  if (record.output && adminPayloadContainsImage(record.output, responsesMode)) {
    return true;
  }
  if (record.data && adminPayloadContainsImage(record.data, responsesMode)) {
    return true;
  }
  if (record.images && adminPayloadContainsImage(record.images, responsesMode)) {
    return true;
  }
  return false;
}

function adminLooksLikeImageUrl(value: unknown) {
  if (typeof value !== 'string') {
    return false;
  }
  const text = value.trim();
  return /^https?:\/\/\S+/i.test(text);
}

function adminLooksLikeBase64ImagePayload(value: unknown) {
  if (typeof value !== 'string') {
    return false;
  }
  const text = value.trim();
  if (/^data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=\s]{64,}$/i.test(text)) {
    return true;
  }
  return text.length >= 128 && /^[A-Za-z0-9+/=\s]+$/.test(text);
}

function adminTryParseJson(text: string) {
  const raw = String(text || '').trim();
  if (!raw) {
    return undefined;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function adminParseSsePayloads(text: string) {
  const payloads: unknown[] = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) {
      continue;
    }
    const data = trimmed.slice(5).trim();
    if (!data || data === '[DONE]') {
      continue;
    }
    const parsed = adminTryParseJson(data);
    if (parsed !== undefined) {
      payloads.push(parsed);
    }
  }
  return payloads;
}
