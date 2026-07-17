import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { FastifyRequest } from 'fastify';
import { providerRegistry } from '../../providerRegistry.js';
import { createJsonStore } from '../storage/jsonStore.js';
import { startPostgresConfigListener } from '../storage/postgresConfigEvents.js';
import { createPostgresConsoleCatalogRepository } from '../storage/postgresRepositories.js';
import type { ConsoleCatalogRepository } from '../storage/repositoryContracts.js';
import { hasDatabaseUrl, requireDatabaseUrl } from '../storage/storageMode.js';

requireDatabaseUrl('console_catalog');

export type ConsoleUpstreamKind = 'images_endpoint' | 'responses_endpoint' | 'chat_completions';
export type ConsoleHealthStatus = 'healthy' | 'cooling' | 'degraded' | 'disabled';
export type ResponseFormat = 'url' | 'b64_json';
export type OutputImageFormat = 'png' | 'webp' | 'jpeg';
export type ResponsesInputShape = 'auto_standard' | 'always_multimodal_message';
export type ResponsesToolChoiceMode = 'auto' | 'image_generation';
export type ResponsesToolChoiceFormat = 'typed_object' | 'required_string';
export type ModerationMode = 'omit' | 'auto' | 'low';
export type ResponsesModelRouting = 'split_text_image' | 'single_top_level_model';
export type ResponsesReturnMode = 'stream' | 'json';
export type ReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh';
export type ResponsesModerationMode = 'task_or_omit' | 'force_auto' | 'force_low';
export type ImageToolQuality = 'auto' | 'low' | 'medium' | 'high';
export type ImageQualityTier = 'auto' | 'low' | 'medium' | 'high';
export type ImageQualityCap = 'auto' | 'low' | 'medium' | 'high';
export type ImageCapabilityCostMap = Partial<Record<ImageQualityTier, number>>;

export type UpstreamTestPreset = {
  operation: 'generations' | 'edits' | 'responses' | 'chat_completions';
  model: string;
  imageModel?: string;
  prompt: string;
  size?: string;
  quality?: string;
  imageToolQuality?: ImageToolQuality;
  imageQuality?: number;
  responseFormat?: ResponseFormat;
  outputFormat?: OutputImageFormat;
  outputCompression?: number;
  background?: 'omit' | 'auto' | 'transparent' | 'opaque';
  stream?: boolean;
  partialImages?: number;
  referenceImageUrl?: string;
  responsesInputShape?: ResponsesInputShape;
  responsesToolChoice?: ResponsesToolChoiceMode;
  responsesToolChoiceFormat?: ResponsesToolChoiceFormat;
  moderation?: ModerationMode;
  n?: number;
};

export type EndpointProbeCheck = {
  key: string;
  label: string;
  method: 'GET' | 'POST';
  url: string;
  exists: boolean;
  ok: boolean;
  statusCode: number | null;
  summary: string;
};

export type OnboardingProbeResult = {
  attempted: boolean;
  ok: boolean;
  normalizedBaseCandidates: string[];
  detectedKinds: ConsoleUpstreamKind[];
  recommendedKind: ConsoleUpstreamKind | null;
  syncSupport: 'unknown' | 'likely_supported';
  checks: EndpointProbeCheck[];
  summary: string;
};

export type OnboardingProbeLogEntry = {
  key: string;
  title: string;
  status: 'success' | 'failed' | 'warning' | 'info';
  requestLines: string[];
  responseLines: string[];
  analysisLines?: string[];
  requestBodyPreview?: string;
  responseBodyPreview?: string;
  previewImageUrl?: string;
  previewImageNote?: string;
};

export type OnboardingProbeAnalysisReport = {
  title: string;
  summary: string;
  confirmed: string[];
  needsAttention: string[];
  submittedButUnverified: string[];
  responseEchoes: string[];
  imageDiagnostics: string[];
  savedDiagnostics: string[];
  suggestedNextSteps: string[];
};

export type OnboardingProbeProgressReporter = (entry: OnboardingProbeLogEntry, message?: string) => void;

export type ResolutionTier = 'auto' | '1k' | '2k' | '4k';
export type BillableResolutionTier = 'auto' | '1k' | '2k' | '4k';

export type ImageCapabilityProfile = {
  tier: ResolutionTier;
  qualities: ImageQualityTier[];
  costs?: ImageCapabilityCostMap;
};

export type ImageSellPriceRow = {
  tier: BillableResolutionTier;
  quality: ImageQualityTier;
  price: number;
};

export type ImagesEndpointConfig = {
  supportsGenerations: boolean;
  supportsEdits: boolean;
  supportsAsync: boolean;
  responseFormats: ResponseFormat[];
  allowDirectPublicImageUrl: boolean;
  imageInputMode: 'url_only' | 'multipart_only' | 'url_or_multipart' | 'unknown';
  editProtocolModes: Array<'multipart_file_upload' | 'json_image_url'>;
  jsonReferenceTransports: Array<'url' | 'base64'>;
  editReferenceMode: 'multipart_file_upload' | 'json_image_url';
  returnMode: 'json' | 'stream';
  editRequestFormat: 'json' | 'multipart';
  referenceImageTransport: 'inherit' | 'url' | 'base64';
  capabilityProfiles: ImageCapabilityProfile[];
  generationsUrl?: string;
  editsUrl?: string;
  asyncGenerationsUrl?: string;
  asyncEditsUrl?: string;
  asyncResultUrlTemplate?: string;
};

export type ResponsesEndpointConfig = {
  supportsImageInput: boolean;
  capabilityProfiles: ImageCapabilityProfile[];
  responseFormats: ResponseFormat[];
  jsonReferenceTransports: Array<'url' | 'base64'>;
  allowDirectPublicImageUrl: boolean;
  textModel: string;
  imageModel?: string;
  reasoningEffort: ReasoningEffort;
  returnMode: ResponsesReturnMode;
  inputShape: ResponsesInputShape;
  toolChoice: ResponsesToolChoiceMode;
  toolChoiceFormat: ResponsesToolChoiceFormat;
  modelRouting: ResponsesModelRouting;
  moderationMode: ResponsesModerationMode;
  imageQuality?: number;
  imageToolQuality?: ImageToolQuality;
};

export type ChatCompletionsConfig = {
  supportsSystemPrompt: boolean;
  supportsJsonMode: boolean;
  supportsTools: boolean;
  supportsVisionInput: boolean;
  upstreamCostYuan?: number;
};

export type ConsoleUpstream = {
  id: string;
  name: string;
  kind: ConsoleUpstreamKind;
  baseUrl: string;
  apiKey: string;
  enabled: boolean;
  maxConcurrency: number;
  healthStatus: ConsoleHealthStatus;
  modelHints: string[];
  notes: string;
  adminTestPreset?: UpstreamTestPreset;
  passthrough?: {
    injectHeaders?: Record<string, string>;
    injectBodyFields?: Record<string, unknown>;
  };
  imagesConfig?: ImagesEndpointConfig;
  responsesConfig?: ResponsesEndpointConfig;
  chatConfig?: ChatCompletionsConfig;
  detectedConfig?: {
    kind: ConsoleUpstreamKind;
    imagesConfig?: ImagesEndpointConfig;
    responsesConfig?: ResponsesEndpointConfig;
    chatConfig?: ChatCompletionsConfig;
    probe: OnboardingProbeResult;
  };
  manualOverrides?: {
    kind?: ConsoleUpstreamKind;
    imagesConfig?: Partial<ImagesEndpointConfig>;
    responsesConfig?: Partial<ResponsesEndpointConfig>;
    chatConfig?: Partial<ChatCompletionsConfig>;
    modelHints?: string[];
  };
};

export type ConsoleChannelBusinessType = 'image_generation' | 'text_processing';

export type ConsoleChannel = {
  id: string;
  name: string;
  businessType: ConsoleChannelBusinessType;
  acceptedUpstreamKinds: ConsoleUpstreamKind[];
  upstreamIds: string[];
  upstreamPolicies: ConsoleChannelUpstreamPolicy[];
  enabled: boolean;
  displayOrder: number;
  notes: string;
};

export type ConsoleChannelUpstreamPolicy = {
  upstreamId: string;
  pricing: {
    auto: number;
    oneK: number;
    twoK: number;
    fourK: number;
    chatUnit: number;
  };
  notes: string;
};

export type ConsoleTenant = {
  id: string;
  name: string;
  code: string;
  status: 'active' | 'disabled';
  allowedChannelIds: string[];
  requestLimitPerMinute: number;
  notes: string;
};

export type ConsoleApiKey = {
  id: string;
  name: string;
  tenantId: string;
  status: 'active' | 'disabled';
  allowedChannelIds: string[];
  requestLimitPerMinute: number;
  maxConcurrency: number;
  imageRoutingMode?: 'smart_priority' | 'smart_failover' | 'fixed_provider';
  fixedImageProviderId?: string;
  fixedImageProviderIds?: string[];
  fixedImageFlatPrice?: number;
  maxImageQuality?: ImageQualityCap;
  maskedKey: string;
  rawKey?: string;
  keyHash?: string;
  notes: string;
};

export type ConsoleSystemPolicy = {
  routingStrategyName: string;
  routingStrategySummary: string;
  fallbackBehaviorSummary: string;
  healthGovernanceSummary: string;
  tenantIsolationSummary: string;
};

export type AdminConsoleCatalog = {
  upstreams: ConsoleUpstream[];
  channels: ConsoleChannel[];
  tenants: ConsoleTenant[];
  apiKeys: ConsoleApiKey[];
  imagePricingMatrix: ImageSellPriceRow[];
  chatCompletionsUnitPrice: number;
  systemPolicy: ConsoleSystemPolicy;
};

type OnboardingAnalyzeInput = {
  name: string;
  baseUrl?: string;
  apiKey?: string;
  targetKind?: ConsoleUpstreamKind;
  model?: string;
  imageModel?: string;
  reasoningEffort?: ReasoningEffort;
  prompt?: string;
  size?: string;
  referenceImageUrl?: string;
  imagesGenerationUrl?: string;
  imagesEditUrl?: string;
  quality?: string;
  imageToolQuality?: ImageToolQuality;
  imageQuality?: number;
  responseFormat?: ResponseFormat;
  outputFormat?: OutputImageFormat;
  outputCompression?: number;
  background?: 'omit' | 'auto' | 'transparent' | 'opaque';
  stream?: boolean;
  partialImages?: number;
  moderation?: ModerationMode;
  n?: number;
  responsesInputShape?: ResponsesInputShape;
  responsesToolChoice?: ResponsesToolChoiceMode;
  responsesToolChoiceFormat?: ResponsesToolChoiceFormat;
  customBodyFields?: Record<string, unknown>;
  referenceImageDataUrl?: string;
};

type ProbeCandidate = {
  baseUrl: string;
  path: string;
  method: 'GET' | 'POST';
  key: string;
  label: string;
  body?: Record<string, unknown>;
  bodyFormat?: 'json' | 'multipart';
  requireImageOutput?: boolean;
};

type ProbeExecutionResult = {
  check: EndpointProbeCheck;
  bodyJson?: unknown;
  request: {
    url: string;
    method: 'GET' | 'POST';
    headers: Record<string, string>;
    bodyFormat: 'json' | 'multipart';
    body?: Record<string, unknown>;
  };
  response: {
    ok: boolean;
    statusCode: number | null;
    headers: Record<string, string>;
    bodyText: string;
    bodyJson?: unknown;
  };
};

export type ProbeTraceEntry = {
  key: string;
  label: string;
  check: EndpointProbeCheck;
  request: ProbeExecutionResult['request'];
  response: ProbeExecutionResult['response'];
};

type ProbeBuilderInput = {
  targetKind?: ConsoleUpstreamKind;
  model?: string;
  imageModel?: string;
  reasoningEffort?: ReasoningEffort;
  prompt?: string;
  size?: string;
  referenceImageUrl?: string;
  imagesGenerationUrl?: string;
  imagesEditUrl?: string;
  quality?: string;
  imageToolQuality?: ImageToolQuality;
  imageQuality?: number;
  responseFormat?: ResponseFormat;
  outputFormat?: OutputImageFormat;
  outputCompression?: number;
  background?: 'omit' | 'auto' | 'transparent' | 'opaque';
  stream?: boolean;
  partialImages?: number;
  moderation?: ModerationMode;
  n?: number;
  responsesInputShape?: ResponsesInputShape;
  responsesToolChoice?: ResponsesToolChoiceMode;
  responsesToolChoiceFormat?: ResponsesToolChoiceFormat;
  customBodyFields?: Record<string, unknown>;
  referenceImageDataUrl?: string;
};

const DEFAULT_TEST_PROMPT = '一只小猫，干净背景，自然光，不要文字';
const DEFAULT_TEST_REFERENCE_IMAGE_URL = String(
  process.env.DEFAULT_TEST_REFERENCE_IMAGE_URL || 'http://localhost:5173/test-assets/reference-test.png',
).trim();
const DEFAULT_PROBE_TIMEOUT_MS = 360_000;
const DEFAULT_SSE_PROBE_SUCCESS_TIMEOUT_MS = 360_000;
const DEFAULT_PROBE_RESPONSE_MAX_BYTES = 8 * 1024 * 1024;
const probeGeneratedImageSubdir = 'generated-images';
const probeSseSuccessMarkers = [
  'event: response.created',
  'event: response.in_progress',
  '"type":"response.created"',
  '"type":"response.in_progress"',
  '"type": "response.created"',
  '"type": "response.in_progress"',
];
const reservedImagesCustomBodyFieldKeys = new Set([
  'model',
  'prompt',
  'size',
  'response_format',
  'quality',
  'n',
  'user',
  'image',
  'images',
  'image_urls',
  'stream',
  'output_format',
  'output_quality',
  'output_compression',
  'background',
  'moderation',
  'partial_images',
  'async',
  'callback_url',
]);
const reservedResponsesCustomBodyFieldKeys = new Set([
  'model',
  'input',
  'tools',
  'tool_choice',
  'stream',
  'reasoning',
]);
const reservedChatCustomBodyFieldKeys = new Set([
  'model',
  'messages',
  'stream',
]);

function randomId(prefix: string) {
  return `${prefix}_${crypto.randomBytes(6).toString('hex')}`;
}

function sanitizeInjectedBodyFieldsForKind(
  kind: ConsoleUpstreamKind,
  input?: Record<string, unknown> | null,
) {
  const reservedKeys = kind === 'images_endpoint'
    ? reservedImagesCustomBodyFieldKeys
    : kind === 'responses_endpoint'
      ? reservedResponsesCustomBodyFieldKeys
      : reservedChatCustomBodyFieldKeys;
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input || {})) {
    const normalizedKey = String(key || '').trim();
    if (!normalizedKey || reservedKeys.has(normalizedKey)) {
      continue;
    }
    sanitized[normalizedKey] = value;
  }
  return sanitized;
}

function defaultSystemPolicy(): ConsoleSystemPolicy {
  return {
    routingStrategyName: '系统托管路由',
    routingStrategySummary: '系统会根据协议能力、健康状态、最近负载和最近成功率，自动选择最合适的上游。',
    fallbackBehaviorSummary: '当前上游失败后，系统会自动切换到下一个合格上游，不把底层路由细节暴露给租户。',
    healthGovernanceSummary: '冷却、降级、临时摘除和恢复都由系统自动治理。',
    tenantIsolationSummary: '租户和 API Key 只负责权限、额度和访问范围控制。',
  };
}

function defaultImagesConfig(): ImagesEndpointConfig {
  return {
    supportsGenerations: true,
    supportsEdits: true,
    supportsAsync: false,
    responseFormats: ['url', 'b64_json'],
    allowDirectPublicImageUrl: false,
    imageInputMode: 'unknown',
    editProtocolModes: ['multipart_file_upload'],
    jsonReferenceTransports: [],
    editReferenceMode: 'multipart_file_upload',
    returnMode: 'json',
    editRequestFormat: 'multipart',
    referenceImageTransport: 'inherit',
    capabilityProfiles: defaultImageCapabilityProfiles(),
    generationsUrl: undefined,
    editsUrl: undefined,
    asyncGenerationsUrl: undefined,
    asyncEditsUrl: undefined,
    asyncResultUrlTemplate: undefined,
  };
}

function defaultResponsesConfig(): ResponsesEndpointConfig {
  return {
    supportsImageInput: true,
    capabilityProfiles: defaultImageCapabilityProfiles(),
    responseFormats: ['url', 'b64_json'],
    jsonReferenceTransports: ['url', 'base64'],
    allowDirectPublicImageUrl: false,
    textModel: 'gpt-5.4-mini',
    imageModel: 'gpt-image-2',
    reasoningEffort: 'low',
    returnMode: 'stream',
    inputShape: 'always_multimodal_message',
    toolChoice: 'image_generation',
    toolChoiceFormat: 'typed_object',
    modelRouting: 'split_text_image',
    moderationMode: 'task_or_omit',
    imageToolQuality: 'medium',
    imageQuality: 100,
  };
}

function defaultChatConfig(): ChatCompletionsConfig {
  return {
    supportsSystemPrompt: true,
    supportsJsonMode: true,
    supportsTools: true,
    supportsVisionInput: false,
  };
}

function normalizeImageCapabilityQualities(input?: unknown): ImageQualityTier[] {
  const source = Array.isArray(input) ? input : [];
  const ordered: ImageQualityTier[] = ['auto', 'low', 'medium', 'high'];
  const next = new Set<ImageQualityTier>();
  for (const item of source) {
    const value = String(item || '').trim();
    if (value === 'auto' || value === 'low' || value === 'medium' || value === 'high') {
      next.add(value);
    }
  }
  return ordered.filter((item) => next.has(item));
}

function defaultImageCapabilityProfiles(): ImageCapabilityProfile[] {
  const qualities: ImageQualityTier[] = ['auto', 'low', 'medium', 'high'];
  const tiers: ResolutionTier[] = ['auto', '1k', '2k', '4k'];
  return tiers.map((tier) => ({
    tier,
    qualities: [...qualities],
    costs: {
      auto: 0,
      low: 0,
      medium: 0,
      high: 0,
    },
  }));
}

function normalizeImageToolQualityValue(value: unknown): ImageToolQuality | undefined {
  const normalized = String(value || '').trim();
  if (normalized === 'auto' || normalized === 'low' || normalized === 'medium' || normalized === 'high') {
    return normalized;
  }
  return undefined;
}

function normalizeOptionalImageQualityPercent(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  const numeric = Math.floor(Number(value));
  if (!Number.isFinite(numeric)) {
    return undefined;
  }
  return Math.max(0, Math.min(100, numeric));
}

function normalizeImageCapabilityCosts(input: unknown): ImageCapabilityCostMap {
  const record = input && typeof input === 'object'
    ? input as Record<string, unknown>
    : {};
  const result: ImageCapabilityCostMap = {};
  for (const quality of ['auto', 'low', 'medium', 'high'] as const) {
    const value = Number(record[quality] || 0);
    result[quality] = Number.isFinite(value) && value >= 0 ? value : 0;
  }
  return result;
}

function normalizeImageCapabilityProfiles(input?: unknown): ImageCapabilityProfile[] {
  const source = Array.isArray(input) ? input : [];
  const tiers: ResolutionTier[] = ['auto', '1k', '2k', '4k'];
  const byTier = new Map<ResolutionTier, ImageCapabilityProfile>();
  for (const item of source) {
    if (!item || typeof item !== 'object') {
      continue;
    }
    const record = item as Record<string, unknown>;
    const tier = String(record.tier || '').trim();
    if (tier !== 'auto' && tier !== '1k' && tier !== '2k' && tier !== '4k') {
      continue;
    }
    const qualities = normalizeImageCapabilityQualities(record.qualities);
    byTier.set(tier, {
      tier,
      qualities,
      costs: normalizeImageCapabilityCosts(record.costs),
    });
  }

  if (!byTier.size) {
    return defaultImageCapabilityProfiles();
  }

  return tiers
    .filter((tier) => byTier.has(tier))
    .map((tier) => byTier.get(tier) as ImageCapabilityProfile);
}

function defaultImagePricingMatrix(): ImageSellPriceRow[] {
  const tiers: BillableResolutionTier[] = ['auto', '1k', '2k', '4k'];
  const qualities: ImageQualityTier[] = ['auto', 'low', 'medium', 'high'];
  return tiers.flatMap((tier) => qualities.map((quality) => ({ tier, quality, price: 0 })));
}

function normalizeImagePricingMatrix(input?: unknown): ImageSellPriceRow[] {
  const source = Array.isArray(input) ? input : [];
  const tiers: BillableResolutionTier[] = ['auto', '1k', '2k', '4k'];
  const qualities: ImageQualityTier[] = ['auto', 'low', 'medium', 'high'];
  const byKey = new Map<string, number>();
  for (const item of source) {
    if (!item || typeof item !== 'object') {
      continue;
    }
    const record = item as Record<string, unknown>;
    const tier = String(record.tier || '').trim();
    const quality = String(record.quality || '').trim();
    if ((tier !== 'auto' && tier !== '1k' && tier !== '2k' && tier !== '4k')
      || (quality !== 'auto' && quality !== 'low' && quality !== 'medium' && quality !== 'high')) {
      continue;
    }
    byKey.set(`${tier}:${quality}`, Math.max(0, Number(record.price || 0)));
  }
  return tiers.flatMap((tier) => qualities.map((quality) => ({
    tier,
    quality,
    price: byKey.get(`${tier}:${quality}`) ?? 0,
  })));
}

function defaultTestPreset(kind: ConsoleUpstreamKind): UpstreamTestPreset {
  if (kind === 'responses_endpoint') {
    return {
      operation: 'responses',
      model: 'gpt-5.4-mini',
      imageModel: 'gpt-image-2',
      prompt: DEFAULT_TEST_PROMPT,
      size: '1600x1200',
      imageToolQuality: 'medium',
      imageQuality: 100,
      outputFormat: 'webp',
      stream: true,
      referenceImageUrl: DEFAULT_TEST_REFERENCE_IMAGE_URL,
      responsesInputShape: 'always_multimodal_message',
      responsesToolChoice: 'image_generation',
      responsesToolChoiceFormat: 'typed_object',
      moderation: 'omit',
    };
  }

  if (kind === 'chat_completions') {
    return {
      operation: 'chat_completions',
      model: 'gpt-4.1-mini',
      prompt: '请理解这张图片，并提取最适合复刻的核心视觉元素。',
      referenceImageUrl: DEFAULT_TEST_REFERENCE_IMAGE_URL,
      stream: false,
    };
  }

  return {
    operation: 'generations',
    model: 'gpt-image-2',
    prompt: DEFAULT_TEST_PROMPT,
    size: '1600x1200',
    quality: 'medium',
    responseFormat: 'b64_json',
    outputFormat: 'webp',
    stream: false,
    partialImages: undefined,
    referenceImageUrl: DEFAULT_TEST_REFERENCE_IMAGE_URL,
    moderation: 'omit',
    n: 1,
  };
}

function normalizeTestPresetForKind(kind: ConsoleUpstreamKind, input?: Partial<UpstreamTestPreset> | null): UpstreamTestPreset {
  const defaults = defaultTestPreset(kind);
  const next = {
    ...defaults,
    ...(input || {}),
  };

  if (kind === 'responses_endpoint') {
    return {
      ...next,
      operation: 'responses',
      model: next.model || 'gpt-5.4-mini',
      imageModel: next.imageModel || 'gpt-image-2',
      stream: true,
    };
  }

  if (kind === 'chat_completions') {
    return {
      operation: 'chat_completions',
      model: next.model && next.model !== 'gpt-image-2' ? next.model : 'gpt-4.1-mini',
      prompt: next.prompt || defaults.prompt,
      stream: next.stream,
      referenceImageUrl: next.referenceImageUrl,
    };
  }

  return {
    ...next,
    operation: next.operation === 'edits' ? 'edits' : 'generations',
    model: next.model || 'gpt-image-2',
  };
}

function buildOnboardingPreset(input: OnboardingAnalyzeInput, kind: ConsoleUpstreamKind): UpstreamTestPreset {
  const preset = defaultTestPreset(kind);
  const next: UpstreamTestPreset = {
    ...preset,
    model: input.model || preset.model,
    prompt: input.prompt || preset.prompt,
    size: input.size || preset.size,
    referenceImageUrl: input.referenceImageUrl || preset.referenceImageUrl,
    quality: input.quality || preset.quality,
    imageToolQuality: normalizeImageToolQualityValue(input.imageToolQuality)
      ?? normalizeImageToolQualityValue(input.quality)
      ?? preset.imageToolQuality,
    imageQuality: input.imageQuality ?? preset.imageQuality,
    responseFormat: input.responseFormat || preset.responseFormat,
    outputFormat: input.outputFormat || preset.outputFormat,
    outputCompression: input.outputCompression ?? preset.outputCompression,
    background: input.background ?? preset.background,
    stream: input.stream ?? preset.stream,
    partialImages: input.partialImages ?? preset.partialImages,
    moderation: input.moderation || preset.moderation,
    n: input.n ?? preset.n,
    responsesInputShape: input.responsesInputShape || preset.responsesInputShape,
    responsesToolChoice: input.responsesToolChoice || preset.responsesToolChoice,
    responsesToolChoiceFormat: input.responsesToolChoiceFormat || preset.responsesToolChoiceFormat,
  };

  if (kind === 'responses_endpoint') {
    next.imageModel = input.imageModel || preset.imageModel;
    next.stream = true;
  }

  return next;
}

function buildResponsesProbeInput(referenceImageValue: string | undefined, inputShape: ResponsesInputShape) {
  const normalizedImages = [String(referenceImageValue || '').trim()].filter(Boolean);
  if (!normalizedImages.length && inputShape === 'auto_standard') {
    return DEFAULT_TEST_PROMPT;
  }

  const content: Array<Record<string, unknown>> = [{ type: 'input_text', text: DEFAULT_TEST_PROMPT }];
  for (const imageUrl of normalizedImages) {
    content.push({ type: 'input_image', image_url: imageUrl });
  }

  return [{ role: 'user', content }];
}

function buildResponsesProbeBody(input: ProbeBuilderInput) {
  const model = String(input.model || 'gpt-5.4-mini').trim();
  const imageModel = String(input.imageModel || '').trim();
  const size = String(input.size || '1600x1200').trim();
  const referenceImageValue = String(input.referenceImageDataUrl || input.referenceImageUrl || '').trim();
  const inputShape: ResponsesInputShape = input.responsesInputShape
    || (referenceImageValue ? 'always_multimodal_message' : 'auto_standard');
  const toolChoice: ResponsesToolChoiceMode = input.responsesToolChoice || 'image_generation';
  const modelRouting: ResponsesModelRouting = imageModel ? 'split_text_image' : 'single_top_level_model';
  const outputFormat: OutputImageFormat = input.outputFormat || 'webp';
  const quality = String(input.imageToolQuality || input.quality || 'medium').trim();
  const moderation = input.moderation;
  const imageQuality = Number(input.imageQuality ?? 100);
  const partialImages = Number(input.partialImages);

  const tool: Record<string, unknown> = {
    type: 'image_generation',
    size,
    quality,
    output_format: outputFormat,
    ...(imageQuality !== undefined ? { output_compression: imageQuality } : {}),
    ...(Number.isInteger(partialImages) && partialImages > 0 ? { partial_images: partialImages } : {}),
  };
  tool.action = referenceImageValue ? 'edit' : 'generate';

  if (imageModel && modelRouting === 'split_text_image') {
    tool.model = imageModel;
  }
  if (moderation && moderation !== 'omit') {
    tool.moderation = moderation;
  }

  const body: Record<string, unknown> = {
    model,
    input: buildResponsesProbeInput(referenceImageValue || undefined, inputShape),
    tools: [tool],
    stream: true,
    reasoning: { effort: input.reasoningEffort ?? 'low' },
  };

  if (toolChoice === 'image_generation') {
    body.tool_choice = (input.responsesToolChoiceFormat || 'typed_object') === 'required_string'
      ? 'required'
      : { type: 'image_generation' };
  }

  return body;
}

function normalizeBaseUrl(value: string) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function normalizeOptionalEndpointUrl(value: unknown) {
  const normalized = String(value || '').trim();
  return /^https?:\/\//i.test(normalized) ? normalized : undefined;
}

function normalizeProbeBaseCandidates(input: string) {
  const raw = normalizeBaseUrl(input);
  if (!raw) {
    return [];
  }
  return [raw];
}

function normalizeUrlPath(baseUrl: string, pathOrUrl: string) {
  if (/^https?:\/\//i.test(pathOrUrl)) {
    return pathOrUrl;
  }
  const raw = normalizeBaseUrl(baseUrl);
  if (!raw) {
    return pathOrUrl.startsWith('/') ? pathOrUrl : `/${pathOrUrl}`;
  }
  return raw;
}

function mergeProbeBody(base: Record<string, unknown>, extra?: Record<string, unknown>) {
  if (!extra || !Object.keys(extra).length) {
    return base;
  }
  return {
    ...base,
    ...extra,
  };
}


function inferKindFromProtocol(protocol: string | undefined): ConsoleUpstreamKind {
  if (protocol === 'openai_responses') {
    return 'responses_endpoint';
  }
  if (protocol === 'openai_chat') {
    return 'chat_completions';
  }
  return 'images_endpoint';
}

function inferDetectedConfigFromProtocol(protocol: string | undefined) {
  const kind = inferKindFromProtocol(protocol);
  if (kind === 'responses_endpoint') {
    return {
      kind,
      responsesConfig: defaultResponsesConfig(),
    };
  }
  if (kind === 'chat_completions') {
    return {
      kind,
      chatConfig: defaultChatConfig(),
    };
  }
  return {
    kind,
    imagesConfig: defaultImagesConfig(),
  };
}

function normalizeResponsesConfig(input?: Partial<ResponsesEndpointConfig> | null): ResponsesEndpointConfig {
  const defaults = defaultResponsesConfig();
  const supportsImageInput = input?.supportsImageInput ?? defaults.supportsImageInput;
  const hasResponseFormats = Boolean(input && Object.prototype.hasOwnProperty.call(input, 'responseFormats'));
  const responseFormats: ResponseFormat[] = Array.isArray(input?.responseFormats)
    ? input.responseFormats.filter((item): item is ResponseFormat => item === 'url' || item === 'b64_json')
    : defaults.responseFormats;
  const jsonReferenceTransports: Array<'url' | 'base64'> = supportsImageInput
    ? normalizeJsonReferenceTransports(input?.jsonReferenceTransports, null, ['json_image_url'])
    : [];
  const hasCapabilityProfiles = Boolean(input && Object.prototype.hasOwnProperty.call(input, 'capabilityProfiles'));
  const hasImageToolQuality = Boolean(input && Object.prototype.hasOwnProperty.call(input, 'imageToolQuality'));
  const hasImageQuality = Boolean(input && Object.prototype.hasOwnProperty.call(input, 'imageQuality'));
  return {
    ...defaults,
    ...(input || {}),
    supportsImageInput: Boolean(supportsImageInput),
    responseFormats: hasResponseFormats ? responseFormats : defaults.responseFormats,
    jsonReferenceTransports,
    allowDirectPublicImageUrl: Boolean(input?.allowDirectPublicImageUrl) && responseFormats.includes('url'),
    returnMode: 'stream',
    capabilityProfiles: hasCapabilityProfiles
      ? (Array.isArray(input?.capabilityProfiles) && input.capabilityProfiles.length === 0
        ? []
        : normalizeImageCapabilityProfiles(input?.capabilityProfiles))
      : defaults.capabilityProfiles,
    textModel: String(input?.textModel || defaults.textModel),
    imageModel: input?.imageModel ? String(input.imageModel) : defaults.imageModel,
    imageToolQuality: hasImageToolQuality
      ? normalizeImageToolQualityValue(input?.imageToolQuality)
      : defaults.imageToolQuality,
    imageQuality: hasImageQuality
      ? normalizeOptionalImageQualityPercent(input?.imageQuality)
      : defaults.imageQuality,
  };
}

function normalizeChatConfig(input?: Partial<ChatCompletionsConfig> | null): ChatCompletionsConfig {
  const defaults = defaultChatConfig();
  const upstreamCostYuan = Number(input?.upstreamCostYuan);
  return {
    ...defaults,
    ...(input || {}),
    ...(Number.isFinite(upstreamCostYuan) ? { upstreamCostYuan: Math.max(0, upstreamCostYuan) } : {}),
  };
}

function normalizeImageQualityCap(input?: unknown): ImageQualityCap {
  const value = String(input || '').trim().toLowerCase();
  return value === 'auto' || value === 'low' || value === 'medium' || value === 'high' ? value : 'high';
}

function normalizeEditProtocolModes(
  input?: Array<'multipart_file_upload' | 'json_image_url'> | null,
  legacy?: Partial<ImagesEndpointConfig> | null,
): Array<'multipart_file_upload' | 'json_image_url'> {
  const order: Array<'multipart_file_upload' | 'json_image_url'> = ['multipart_file_upload', 'json_image_url'];
  const source = Array.isArray(input) ? input.filter((item) => order.includes(item)) : [];
  if (source.length) {
    return order.filter((item) => source.includes(item));
  }
  if (legacy?.imageInputMode === 'url_or_multipart') {
    return order.slice();
  }
  if (
    legacy?.editReferenceMode === 'json_image_url'
    || legacy?.editRequestFormat === 'json'
    || legacy?.imageInputMode === 'url_only'
  ) {
    return ['json_image_url'];
  }
  return ['multipart_file_upload'];
}

function normalizeJsonReferenceTransports(
  input?: Array<'url' | 'base64'> | null,
  legacy?: Partial<ImagesEndpointConfig> | null,
  protocols: Array<'multipart_file_upload' | 'json_image_url'> = [],
): Array<'url' | 'base64'> {
  if (!protocols.includes('json_image_url')) {
    return [];
  }
  const order: Array<'url' | 'base64'> = ['url', 'base64'];
  const source = Array.isArray(input) ? input.filter((item) => order.includes(item)) : [];
  if (source.length) {
    return order.filter((item) => source.includes(item));
  }
  if (legacy?.referenceImageTransport === 'inherit') {
    return order.slice();
  }
  if (legacy?.referenceImageTransport === 'url' || legacy?.referenceImageTransport === 'base64') {
    return [legacy.referenceImageTransport];
  }
  return ['url'];
}

function deriveImagesRuntimeFields(input: {
  editProtocolModes: Array<'multipart_file_upload' | 'json_image_url'>;
  jsonReferenceTransports: Array<'url' | 'base64'>;
}) {
  const editProtocolModes: Array<'multipart_file_upload' | 'json_image_url'> = input.editProtocolModes.length
    ? input.editProtocolModes
    : ['multipart_file_upload'];
  const jsonReferenceTransports: Array<'url' | 'base64'> = editProtocolModes.includes('json_image_url')
    ? input.jsonReferenceTransports
    : [];
  const hasMultipart = editProtocolModes.includes('multipart_file_upload');
  const hasJson = editProtocolModes.includes('json_image_url');
  const hasJsonUrl = jsonReferenceTransports.includes('url');
  const hasJsonBase64 = jsonReferenceTransports.includes('base64');

  return {
    editProtocolModes,
    jsonReferenceTransports,
    imageInputMode: (
      hasMultipart
        ? (hasJson ? 'url_or_multipart' : 'multipart_only')
        : (hasJson ? 'url_only' : 'unknown')
    ) as ImagesEndpointConfig['imageInputMode'],
    editReferenceMode: (
      hasJson ? 'json_image_url' : 'multipart_file_upload'
    ) as ImagesEndpointConfig['editReferenceMode'],
    editRequestFormat: (
      hasJson ? 'json' : 'multipart'
    ) as ImagesEndpointConfig['editRequestFormat'],
    referenceImageTransport: (
      !hasJson
        ? 'inherit'
        : hasJsonUrl && hasJsonBase64
          ? 'inherit'
          : hasJsonBase64
            ? 'base64'
            : 'url'
    ) as ImagesEndpointConfig['referenceImageTransport'],
  };
}

function normalizeImagesConfig(input?: Partial<ImagesEndpointConfig> | null): ImagesEndpointConfig {
  const defaults = defaultImagesConfig();
  const responseFormats: ResponseFormat[] = Array.isArray(input?.responseFormats)
    ? input.responseFormats
    : defaults.responseFormats;
  const editProtocolModes: Array<'multipart_file_upload' | 'json_image_url'> = normalizeEditProtocolModes(input?.editProtocolModes, input);
  const jsonReferenceTransports: Array<'url' | 'base64'> = normalizeJsonReferenceTransports(
    input?.jsonReferenceTransports,
    input,
    editProtocolModes,
  );
  const runtimeFields = deriveImagesRuntimeFields({
    editProtocolModes,
    jsonReferenceTransports,
  });
  return {
    ...defaults,
    ...(input || {}),
    ...runtimeFields,
    editProtocolModes,
    jsonReferenceTransports,
    responseFormats,
    allowDirectPublicImageUrl: Boolean(input?.allowDirectPublicImageUrl) && responseFormats.includes('url'),
    capabilityProfiles: normalizeImageCapabilityProfiles(input?.capabilityProfiles),
    generationsUrl: normalizeOptionalEndpointUrl(input?.generationsUrl),
    editsUrl: normalizeOptionalEndpointUrl(input?.editsUrl),
    asyncGenerationsUrl: normalizeOptionalEndpointUrl(input?.asyncGenerationsUrl),
    asyncEditsUrl: normalizeOptionalEndpointUrl(input?.asyncEditsUrl),
    asyncResultUrlTemplate: normalizeOptionalEndpointUrl(input?.asyncResultUrlTemplate),
  };
}

function normalizeDetectedConfigForKind(
  kind: ConsoleUpstreamKind,
  detectedConfig?: ConsoleUpstream['detectedConfig'],
): ConsoleUpstream['detectedConfig'] | undefined {
  if (!detectedConfig) {
    return undefined;
  }

  return {
    kind,
    imagesConfig: kind === 'images_endpoint'
      ? normalizeImagesConfig(detectedConfig.imagesConfig)
      : undefined,
    responsesConfig: kind === 'responses_endpoint'
      ? normalizeResponsesConfig(detectedConfig.responsesConfig)
      : undefined,
    chatConfig: kind === 'chat_completions'
      ? normalizeChatConfig(detectedConfig.chatConfig)
      : undefined,
    probe: detectedConfig.probe,
  };
}

function normalizeManualOverridesForKind(
  kind: ConsoleUpstreamKind,
  manualOverrides?: ConsoleUpstream['manualOverrides'],
): ConsoleUpstream['manualOverrides'] | undefined {
  if (!manualOverrides) {
    return undefined;
  }

  return {
    kind,
    imagesConfig: kind === 'images_endpoint' ? manualOverrides.imagesConfig : undefined,
    responsesConfig: kind === 'responses_endpoint' ? manualOverrides.responsesConfig : undefined,
    chatConfig: kind === 'chat_completions' ? manualOverrides.chatConfig : undefined,
    modelHints: manualOverrides.modelHints,
  };
}

function normalizeUpstreamForKind(input: ConsoleUpstream): ConsoleUpstream {
  const kind = input.kind;
  const injectHeaders = input.passthrough?.injectHeaders || {};
  const injectBodyFields = sanitizeInjectedBodyFieldsForKind(kind, input.passthrough?.injectBodyFields);
  const passthrough = {
    injectHeaders,
    injectBodyFields,
  };

  return {
    ...input,
    maxConcurrency: Math.max(1, Math.floor(Number(input.maxConcurrency || 10))),
    adminTestPreset: normalizeTestPresetForKind(kind, input.adminTestPreset),
    passthrough,
    imagesConfig: kind === 'images_endpoint'
      ? normalizeImagesConfig(input.imagesConfig)
      : undefined,
    responsesConfig: kind === 'responses_endpoint'
      ? normalizeResponsesConfig(input.responsesConfig)
      : undefined,
    chatConfig: kind === 'chat_completions'
      ? normalizeChatConfig(input.chatConfig)
      : undefined,
    detectedConfig: normalizeDetectedConfigForKind(kind, input.detectedConfig),
    manualOverrides: normalizeManualOverridesForKind(kind, input.manualOverrides),
  };
}

function responsesConfigFromProvider(provider: { metadata?: Record<string, unknown> }): ResponsesEndpointConfig {
  const defaults = defaultResponsesConfig();
  const metadata = provider.metadata || {};
  const input: Partial<ResponsesEndpointConfig> = {
    supportsImageInput: metadata.responses_supports_image_input !== false,
    responseFormats: Array.isArray(metadata.responses_response_formats)
      ? metadata.responses_response_formats as ResponseFormat[]
      : defaults.responseFormats,
    jsonReferenceTransports: Array.isArray(metadata.responses_json_reference_transports)
      ? metadata.responses_json_reference_transports.filter((item): item is 'url' | 'base64' => item === 'url' || item === 'base64')
      : defaults.jsonReferenceTransports,
    allowDirectPublicImageUrl: metadata.responses_allow_direct_public_image_url === true,
    textModel: String(metadata.responses_text_model || defaults.textModel),
    imageModel: String(metadata.responses_image_model || defaults.imageModel || ''),
    reasoningEffort: (metadata.reasoning_effort as ReasoningEffort) || defaults.reasoningEffort,
    returnMode: (metadata.responses_return_mode as ResponsesReturnMode) || defaults.returnMode,
    inputShape: (metadata.responses_input_shape as ResponsesInputShape) || defaults.inputShape,
    toolChoice: (metadata.responses_tool_choice as ResponsesToolChoiceMode) || defaults.toolChoice,
    toolChoiceFormat: (metadata.responses_tool_choice_format as ResponsesToolChoiceFormat) || defaults.toolChoiceFormat,
    modelRouting: (metadata.responses_model_routing as ResponsesModelRouting) || defaults.modelRouting,
    moderationMode: (metadata.responses_moderation_mode as ResponsesModerationMode) || defaults.moderationMode,
    capabilityProfiles: metadata.responses_capability_profiles as ImageCapabilityProfile[] | undefined,
    imageToolQuality: normalizeImageToolQualityValue(metadata.responses_image_tool_quality),
    imageQuality: normalizeOptionalImageQualityPercent(metadata.responses_image_quality),
  };
  return normalizeResponsesConfig(input);
}

function imagesConfigFromProvider(provider: { metadata?: Record<string, unknown> }): ImagesEndpointConfig {
  const defaults = defaultImagesConfig();
  const metadata = provider.metadata || {};
  const editProtocolModes = Array.isArray(metadata.images_edit_protocols)
    ? metadata.images_edit_protocols.filter((item): item is 'multipart_file_upload' | 'json_image_url' => (
        item === 'multipart_file_upload' || item === 'json_image_url'
      ))
    : undefined;
  const jsonReferenceTransports = Array.isArray(metadata.images_json_reference_transports)
    ? metadata.images_json_reference_transports.filter((item): item is 'url' | 'base64' => item === 'url' || item === 'base64')
    : undefined;
  return normalizeImagesConfig({
    supportsGenerations: metadata.images_supports_generations !== false,
    supportsEdits: metadata.images_supports_edits !== false,
    supportsAsync: metadata.images_supports_async === true,
    imageInputMode: (metadata.images_image_input_mode as ImagesEndpointConfig['imageInputMode']) || defaults.imageInputMode,
    editProtocolModes,
    jsonReferenceTransports,
    editReferenceMode: String(metadata.images_edit_reference_mode || '')
      === 'json_image_url'
      ? 'json_image_url'
      : String(metadata.images_edit_request_format || defaults.editRequestFormat) === 'json'
        ? 'json_image_url'
        : defaults.editReferenceMode,
    responseFormats: Array.isArray(metadata.images_response_formats)
      ? metadata.images_response_formats as ResponseFormat[]
      : defaults.responseFormats,
    allowDirectPublicImageUrl: metadata.images_allow_direct_public_image_url === true,
    returnMode: String(metadata.images_return_mode || defaults.returnMode) === 'stream' ? 'stream' : 'json',
    editRequestFormat: String(metadata.images_edit_request_format || defaults.editRequestFormat) === 'multipart' ? 'multipart' : 'json',
    referenceImageTransport: (() => {
      const value = String(metadata.reference_image_transport || defaults.referenceImageTransport);
      return value === 'url' || value === 'base64' ? value : 'inherit';
    })(),
    capabilityProfiles: metadata.images_capability_profiles as ImageCapabilityProfile[] | undefined,
    generationsUrl: normalizeOptionalEndpointUrl(metadata.images_generations_url),
    editsUrl: normalizeOptionalEndpointUrl(metadata.images_edits_url),
    asyncGenerationsUrl: normalizeOptionalEndpointUrl(metadata.images_async_generations_url),
    asyncEditsUrl: normalizeOptionalEndpointUrl(metadata.images_async_edits_url),
    asyncResultUrlTemplate: normalizeOptionalEndpointUrl(metadata.images_async_result_url_template),
  });
}

function buildFixedChannels(upstreams: ConsoleUpstream[]): ConsoleChannel[] {
  const imageUpstreamIds = upstreams
    .filter((item) => item.kind === 'images_endpoint' || item.kind === 'responses_endpoint')
    .map((item) => item.id);
  const textUpstreamIds = upstreams
    .filter((item) => item.kind === 'chat_completions')
    .map((item) => item.id);

  return [
    {
      id: 'channel_image_generation',
      name: '图像生成',
      businessType: 'image_generation',
      acceptedUpstreamKinds: ['images_endpoint', 'responses_endpoint'],
      upstreamIds: imageUpstreamIds,
      upstreamPolicies: imageUpstreamIds.map((upstreamId) => buildDefaultChannelPolicy(upstreamId, upstreams)),
      enabled: true,
      displayOrder: 10,
      notes: '',
    },
    {
      id: 'channel_text_processing',
      name: '文本处理',
      businessType: 'text_processing',
      acceptedUpstreamKinds: ['chat_completions'],
      upstreamIds: textUpstreamIds,
      upstreamPolicies: textUpstreamIds.map((upstreamId) => buildDefaultChannelPolicy(upstreamId, upstreams)),
      enabled: true,
      displayOrder: 20,
      notes: '',
    },
  ];
}

function buildDefaultChannelPolicy(upstreamId: string, upstreams: ConsoleUpstream[]): ConsoleChannelUpstreamPolicy {
  const upstream = upstreams.find((item) => item.id === upstreamId);
  return {
    upstreamId,
    pricing: {
      auto: 0,
      oneK: 0,
      twoK: 0,
      fourK: 0,
      chatUnit: 0,
    },
    notes: '',
  };
}

function supportedResolutionTiersForUpstream(upstream?: ConsoleUpstream): ResolutionTier[] {
  if (!upstream) {
    return ['auto'];
  }
  if (upstream.kind === 'images_endpoint') {
    return upstream.imagesConfig?.capabilityProfiles?.length
      ? upstream.imagesConfig.capabilityProfiles.map((item) => item.tier)
      : ['auto'];
  }
  if (upstream.kind === 'responses_endpoint') {
    return upstream.responsesConfig?.capabilityProfiles?.length
      ? upstream.responsesConfig.capabilityProfiles.map((item) => item.tier)
      : ['auto', '1k', '2k', '4k'];
  }
  return [];
}

function normalizePricingByUpstreamCapability(
  upstream: ConsoleUpstream | undefined,
  pricing: {
    auto: number;
    oneK: number;
    twoK: number;
    fourK: number;
    chatUnit: number;
  },
) {
  if (!upstream) {
    return pricing;
  }
  if (upstream.kind === 'chat_completions') {
    return {
      auto: 0,
      oneK: 0,
      twoK: 0,
      fourK: 0,
      chatUnit: pricing.chatUnit,
    };
  }

  const supported = new Set(supportedResolutionTiersForUpstream(upstream));
  return {
    auto: supported.has('auto') ? pricing.auto : 0,
    oneK: supported.has('1k') ? pricing.oneK : 0,
    twoK: supported.has('2k') ? pricing.twoK : 0,
    fourK: supported.has('4k') ? pricing.fourK : 0,
    chatUnit: 0,
  };
}

function normalizeChannelPolicy(input: unknown, upstreamId: string, upstreams: ConsoleUpstream[]): ConsoleChannelUpstreamPolicy {
  const defaults = buildDefaultChannelPolicy(upstreamId, upstreams);
  const record = input && typeof input === 'object' ? input as Record<string, unknown> : {};
  const pricing = record.pricing && typeof record.pricing === 'object'
    ? record.pricing as Record<string, unknown>
    : {};
  const upstream = upstreams.find((item) => item.id === upstreamId);
  const normalizedPricing = normalizePricingByUpstreamCapability(upstream, {
    auto: Number(pricing.auto ?? defaults.pricing.auto),
    oneK: Number(pricing.oneK ?? defaults.pricing.oneK),
    twoK: Number(pricing.twoK ?? defaults.pricing.twoK),
    fourK: Number(pricing.fourK ?? defaults.pricing.fourK),
    chatUnit: Number(pricing.chatUnit ?? defaults.pricing.chatUnit),
  });
  return {
    upstreamId,
    pricing: normalizedPricing,
    notes: String(record.notes || ''),
  };
}

function syncChannelPoliciesForUpstreamIds(
  upstreamIds: string[],
  policies: ConsoleChannelUpstreamPolicy[],
  upstreams: ConsoleUpstream[],
) {
  const byId = new Map(policies.map((item) => [item.upstreamId, item]));
  return upstreamIds.map((upstreamId) => normalizeChannelPolicy(byId.get(upstreamId), upstreamId, upstreams));
}

function normalizeAllowedChannelIds(input: unknown) {
  const source = Array.isArray(input) ? input.map((value) => String(value)) : [];
  if (!source.length) {
    return ['channel_image_generation', 'channel_text_processing'];
  }

  const next = new Set<string>();
  for (const channelId of source) {
    if (channelId === 'channel_image_generation' || channelId === 'channel_text_processing') {
      next.add(channelId);
    }
  }
  return Array.from(next);
}

function normalizeFixedChannels(rawChannels: unknown[], upstreams: ConsoleUpstream[]): ConsoleChannel[] {
  const defaults = buildFixedChannels(upstreams);
  const records = new Map<string, Record<string, unknown>>();
  for (const item of rawChannels) {
    if (!item || typeof item !== 'object') {
      continue;
    }
    const record = item as Record<string, unknown>;
    const id = String(record.id || '');
    if (id === 'channel_image_generation' || id === 'channel_text_processing') {
      records.set(id, record);
    }
  }

  return defaults.map((channel) => {
    const record = records.get(channel.id);
    if (!record) {
      return channel;
    }
    const upstreamIds = channel.upstreamIds;
    const rawPolicies = Array.isArray(record.upstreamPolicies) ? record.upstreamPolicies : [];
    const policyByUpstreamId = new Map<string, unknown>();
    for (const rawPolicy of rawPolicies) {
      if (!rawPolicy || typeof rawPolicy !== 'object') {
        continue;
      }
      const policyRecord = rawPolicy as Record<string, unknown>;
      const upstreamId = String(policyRecord.upstreamId || '').trim();
      if (upstreamId) {
        policyByUpstreamId.set(upstreamId, policyRecord);
      }
    }
    return {
      ...channel,
      enabled: record.enabled !== false,
      notes: String(record.notes || ''),
      upstreamIds,
      upstreamPolicies: upstreamIds.map((upstreamId) => (
        normalizeChannelPolicy(policyByUpstreamId.get(upstreamId), upstreamId, upstreams)
      )),
    };
  });
}

function deriveSeedCatalog(): AdminConsoleCatalog {
  const providers = providerRegistry.list();
  const upstreams: ConsoleUpstream[] = providers.map((provider, index) => {
    const detected = inferDetectedConfigFromProtocol(provider.protocol);
    return {
      id: String(provider.providerId || randomId('upstream')),
      name: provider.name || provider.providerId || `Upstream ${index + 1}`,
      kind: detected.kind,
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey || '',
      enabled: provider.healthState !== 'disabled',
      maxConcurrency: Math.max(1, Math.floor(Number(
        provider.metadata?.max_concurrency
          ?? provider.metadata?.provider_max_concurrency
          ?? provider.metadata?.upstream_max_concurrency
          ?? 10,
      ))),
      healthStatus: provider.healthState || 'healthy',
      modelHints: provider.modelAllowlist || [],
      notes: '',
      adminTestPreset: normalizeTestPresetForKind(detected.kind),
      passthrough: provider.passthrough,
      imagesConfig: detected.kind === 'images_endpoint'
        ? imagesConfigFromProvider(provider)
        : detected.imagesConfig,
      responsesConfig: detected.kind === 'responses_endpoint'
        ? responsesConfigFromProvider(provider)
        : detected.responsesConfig,
      chatConfig: detected.chatConfig,
      detectedConfig: {
        ...detected,
        probe: {
          attempted: false,
          ok: false,
          normalizedBaseCandidates: [normalizeBaseUrl(provider.baseUrl)].filter(Boolean),
          detectedKinds: [detected.kind],
          recommendedKind: detected.kind,
          syncSupport: 'unknown',
          checks: [],
          summary: '已从现有运行态导入这条上游，暂时还没有真实探测证据。',
        },
      },
      manualOverrides: {},
    };
  });

  const channels = buildFixedChannels(upstreams);

  return {
    upstreams,
    channels,
    tenants: [],
    apiKeys: [],
    imagePricingMatrix: defaultImagePricingMatrix(),
    chatCompletionsUnitPrice: 0,
    systemPolicy: defaultSystemPolicy(),
  };
}

function normalizeFixedImageProviderIds(input: unknown, legacyValue?: unknown) {
  const values = Array.isArray(input) ? input : [];
  const normalized = values
    .map((item) => String(item || '').trim())
    .filter(Boolean);
  const legacyId = String(legacyValue || '').trim();
  if (legacyId && !normalized.includes(legacyId)) {
    normalized.unshift(legacyId);
  }
  return Array.from(new Set(normalized));
}

function normalizeCatalog(raw: unknown): AdminConsoleCatalog {
  if (!raw || typeof raw !== 'object') {
    return deriveSeedCatalog();
  }

  const source = raw as Record<string, unknown>;
  const upstreams = Array.isArray(source.upstreams) ? source.upstreams : [];
  const channels = Array.isArray(source.channels) ? source.channels : [];
  const tenants = Array.isArray(source.tenants) ? source.tenants : [];
  const apiKeys = Array.isArray(source.apiKeys) ? source.apiKeys : [];

  const normalizedUpstreams: ConsoleUpstream[] = upstreams.flatMap((item, index) => {
    if (!item || typeof item !== 'object') {
      return [];
    }
    const record = item as Record<string, unknown>;
    const kind = String(record.kind || '');
    if (kind !== 'images_endpoint' && kind !== 'responses_endpoint' && kind !== 'chat_completions') {
      return [];
    }

    return [normalizeUpstreamForKind({
      id: String(record.id || randomId(`upstream_${index}`)),
      name: String(record.name || `Upstream ${index + 1}`),
      kind,
      baseUrl: String(record.baseUrl || ''),
      apiKey: String(record.apiKey || ''),
      enabled: record.enabled !== false,
      maxConcurrency: Math.max(1, Math.floor(Number(record.maxConcurrency || 10))),
      healthStatus: (record.healthStatus as ConsoleHealthStatus) || 'healthy',
      modelHints: Array.isArray(record.modelHints) ? record.modelHints.map((value) => String(value)) : [],
      notes: String(record.notes || ''),
      adminTestPreset: record.adminTestPreset && typeof record.adminTestPreset === 'object'
        ? normalizeTestPresetForKind(kind, record.adminTestPreset as Partial<UpstreamTestPreset>)
        : normalizeTestPresetForKind(kind),
      passthrough: record.passthrough && typeof record.passthrough === 'object'
        ? (record.passthrough as ConsoleUpstream['passthrough'])
        : undefined,
      imagesConfig: kind === 'images_endpoint'
        ? normalizeImagesConfig(record.imagesConfig as Partial<ImagesEndpointConfig> | undefined)
        : undefined,
      responsesConfig: kind === 'responses_endpoint'
        ? normalizeResponsesConfig(record.responsesConfig as Partial<ResponsesEndpointConfig> | undefined)
        : undefined,
      chatConfig: kind === 'chat_completions'
        ? normalizeChatConfig(record.chatConfig as Partial<ChatCompletionsConfig> | undefined)
        : undefined,
      detectedConfig: record.detectedConfig && typeof record.detectedConfig === 'object'
        ? normalizeDetectedConfigForKind(kind, record.detectedConfig as ConsoleUpstream['detectedConfig'])
        : undefined,
      manualOverrides: record.manualOverrides && typeof record.manualOverrides === 'object'
        ? normalizeManualOverridesForKind(kind, record.manualOverrides as ConsoleUpstream['manualOverrides'])
        : undefined,
    })];
  });

  const normalizedChannels = normalizeFixedChannels(channels, normalizedUpstreams);

  return {
    upstreams: normalizedUpstreams,
    channels: normalizedChannels,
    tenants: (tenants as Record<string, unknown>[]).map((item, index) => ({
      id: String(item.id || randomId(`tenant_${index}`)),
      name: String(item.name || `Tenant ${index + 1}`),
      code: String(item.code || `tenant_${index + 1}`),
      status: item.status === 'disabled' ? 'disabled' : 'active',
      allowedChannelIds: normalizeAllowedChannelIds(item.allowedChannelIds),
      requestLimitPerMinute: Number(item.requestLimitPerMinute || 120),
      notes: String(item.notes || ''),
    })),
    apiKeys: (apiKeys as Record<string, unknown>[]).map((item, index) => {
      const fixedImageProviderIds = normalizeFixedImageProviderIds(
        item.fixedImageProviderIds,
        item.fixedImageProviderId,
      );
      return {
      id: String(item.id || randomId(`key_${index}`)),
      name: String(item.name || `Key ${index + 1}`),
      tenantId: String(item.tenantId || ''),
      status: item.status === 'disabled' ? 'disabled' : 'active',
      allowedChannelIds: normalizeAllowedChannelIds(item.allowedChannelIds),
      requestLimitPerMinute: Number(item.requestLimitPerMinute || 120),
      maxConcurrency: Math.max(1, Number(item.maxConcurrency || 10)),
      imageRoutingMode: item.imageRoutingMode === 'smart_priority'
        || item.imageRoutingMode === 'smart_failover'
        || item.imageRoutingMode === 'fixed_provider'
        ? item.imageRoutingMode
        : undefined,
      fixedImageProviderId: fixedImageProviderIds[0] || '',
      fixedImageProviderIds,
      fixedImageFlatPrice: Math.max(0, Number(item.fixedImageFlatPrice || 0)),
      maxImageQuality: normalizeImageQualityCap(item.maxImageQuality),
      maskedKey: String(item.maskedKey || ''),
      rawKey: String(item.rawKey || ''),
      keyHash: String(item.keyHash || ''),
      notes: String(item.notes || ''),
      };
    }),
    imagePricingMatrix: normalizeImagePricingMatrix(source.imagePricingMatrix),
    chatCompletionsUnitPrice: Math.max(0, Number(source.chatCompletionsUnitPrice || 0)),
    systemPolicy: (source.systemPolicy as ConsoleSystemPolicy) || defaultSystemPolicy(),
  };
}

function readCatalog(): AdminConsoleCatalog {
  return catalogCache;
}

export type AdminConsoleCatalogRuntimeIndex = {
  tenantById: Map<string, ConsoleTenant>;
  activeApiKeyById: Map<string, ConsoleApiKey>;
  activeApiKeyByRawKey: Map<string, ConsoleApiKey>;
  activeApiKeyByHash: Map<string, ConsoleApiKey>;
};

function buildCatalogRuntimeIndex(catalog: AdminConsoleCatalog): AdminConsoleCatalogRuntimeIndex {
  const tenantById = new Map<string, ConsoleTenant>();
  const activeApiKeyById = new Map<string, ConsoleApiKey>();
  const activeApiKeyByRawKey = new Map<string, ConsoleApiKey>();
  const activeApiKeyByHash = new Map<string, ConsoleApiKey>();
  for (const tenant of catalog.tenants) {
    tenantById.set(tenant.id, tenant);
  }
  for (const apiKey of catalog.apiKeys) {
    if (apiKey.status !== 'active') {
      continue;
    }
    activeApiKeyById.set(apiKey.id, apiKey);
    if (apiKey.rawKey) {
      activeApiKeyByRawKey.set(apiKey.rawKey, apiKey);
    }
    if (apiKey.keyHash) {
      activeApiKeyByHash.set(apiKey.keyHash, apiKey);
    }
  }
  return {
    tenantById,
    activeApiKeyById,
    activeApiKeyByRawKey,
    activeApiKeyByHash,
  };
}

function setCatalogCache(next: AdminConsoleCatalog) {
  const normalized = normalizeCatalog(next);
  catalogCache = normalized;
  catalogRuntimeIndex = buildCatalogRuntimeIndex(normalized);
  return normalized;
}

function writeCatalog(next: AdminConsoleCatalog) {
  const normalized = setCatalogCache(next);
  if (postgresConsoleCatalogRepository) {
    void postgresConsoleCatalogRepository.replace(normalized);
    return;
  }
  consoleCatalogStore.write(normalized);
}

const consoleCatalogStore = createJsonStore<AdminConsoleCatalog>({
  envDirKey: 'ADMIN_DATA_DIR',
  defaultDirName: 'data',
  fileName: 'admin-console-catalog.json',
  createDefault: () => deriveSeedCatalog(),
  mergeOnRead: (input) => normalizeCatalog(input),
});

const postgresConsoleCatalogRepository = hasDatabaseUrl()
  ? createPostgresConsoleCatalogRepository({
      connectionString: process.env.DATABASE_URL,
      schema: process.env.PG_SCHEMA || 'public',
      fallback: () => deriveSeedCatalog(),
    })
  : null;

let catalogCache = postgresConsoleCatalogRepository ? deriveSeedCatalog() : consoleCatalogStore.read();
let catalogRuntimeIndex = buildCatalogRuntimeIndex(catalogCache);
let catalogRefreshPromise: Promise<AdminConsoleCatalog> | null = null;
let catalogListenerStarted = false;

async function refreshCatalogCache() {
  if (catalogRefreshPromise) {
    return catalogRefreshPromise;
  }
  catalogRefreshPromise = (async () => {
    if (postgresConsoleCatalogRepository) {
      return setCatalogCache(await postgresConsoleCatalogRepository.get());
    }
    return setCatalogCache(consoleCatalogStore.read());
  })();
  try {
    return await catalogRefreshPromise;
  } finally {
    catalogRefreshPromise = null;
  }
}

async function persistCatalogAsync(next: AdminConsoleCatalog) {
  const normalized = setCatalogCache(next);
  if (postgresConsoleCatalogRepository) {
    await postgresConsoleCatalogRepository.replace(normalized);
    return catalogCache;
  }
  consoleCatalogStore.write(normalized);
  return consoleCatalogStore.read();
}

async function mutateCatalogAsync(
  updater: (current: AdminConsoleCatalog) => AdminConsoleCatalog | Promise<AdminConsoleCatalog>,
) {
  if (postgresConsoleCatalogRepository?.mutate) {
    const saved = await postgresConsoleCatalogRepository.mutate(async (current) => normalizeCatalog(await updater(normalizeCatalog(current))));
    return setCatalogCache(saved);
  }
  const current = await refreshCatalogCache();
  return persistCatalogAsync(await updater(current));
}

export async function initializeAdminConsoleCatalogStore() {
  const catalog = await refreshCatalogCache();
  if (!catalogListenerStarted && postgresConsoleCatalogRepository) {
    catalogListenerStarted = true;
    await startPostgresConfigListener('console_catalog', () => {
      void refreshCatalogCache();
    });
  }
  return catalog;
}

export const adminConsoleCatalogStore: ConsoleCatalogRepository & {
  refreshAsync: () => Promise<AdminConsoleCatalog>;
  replaceAsync: (next: AdminConsoleCatalog) => Promise<AdminConsoleCatalog>;
  updateAsync: (
    updater: (current: AdminConsoleCatalog) => AdminConsoleCatalog | Promise<AdminConsoleCatalog>,
  ) => Promise<AdminConsoleCatalog>;
  saveUpstreamAsync: (upstream: ConsoleUpstream) => Promise<AdminConsoleCatalog>;
  removeUpstreamAsync: (id: string) => Promise<AdminConsoleCatalog>;
  saveChannelAsync: (channel: ConsoleChannel) => Promise<AdminConsoleCatalog>;
  removeChannelAsync: (id: string) => Promise<AdminConsoleCatalog>;
  saveTenantAsync: (tenant: ConsoleTenant) => Promise<AdminConsoleCatalog>;
  removeTenantAsync: (id: string) => Promise<AdminConsoleCatalog>;
  saveApiKeyAsync: (apiKey: ConsoleApiKey) => Promise<AdminConsoleCatalog>;
  removeApiKeyAsync: (id: string) => Promise<AdminConsoleCatalog>;
  saveUpstream: (upstream: ConsoleUpstream) => AdminConsoleCatalog;
  removeUpstream: (id: string) => AdminConsoleCatalog;
  saveChannel: (channel: ConsoleChannel) => AdminConsoleCatalog;
  removeChannel: (id: string) => AdminConsoleCatalog;
  saveTenant: (tenant: ConsoleTenant) => AdminConsoleCatalog;
  removeTenant: (id: string) => AdminConsoleCatalog;
  saveApiKey: (apiKey: ConsoleApiKey) => AdminConsoleCatalog;
  removeApiKey: (id: string) => AdminConsoleCatalog;
  getStorageInfo: () => {
    consoleDataDir: string;
    consoleCatalogFilePath: string;
  };
  getRuntimeIndex: () => AdminConsoleCatalogRuntimeIndex;
} = {
  get() {
    return readCatalog();
  },
  getRuntimeIndex() {
    return catalogRuntimeIndex;
  },
  replace(next: AdminConsoleCatalog) {
    writeCatalog(next);
    return readCatalog();
  },
  async replaceAsync(next: AdminConsoleCatalog) {
    return persistCatalogAsync(next);
  },
  async updateAsync(updater) {
    return mutateCatalogAsync(updater);
  },
  async refreshAsync() {
    return refreshCatalogCache();
  },
  saveUpstream(upstream: ConsoleUpstream) {
    const catalog = readCatalog();
    const normalizedUpstream = normalizeUpstreamForKind(upstream);
    const next = catalog.upstreams.filter((item) => item.id !== normalizedUpstream.id);
    next.push(normalizedUpstream);
    const nextChannels = catalog.channels.map((channel) => {
      const shouldKeepMembership = channel.acceptedUpstreamKinds.includes(normalizedUpstream.kind);
      const upstreamIds = shouldKeepMembership
        ? Array.from(new Set([...channel.upstreamIds, normalizedUpstream.id]))
        : channel.upstreamIds.filter((item) => item !== normalizedUpstream.id);
      const upstreamPolicies = syncChannelPoliciesForUpstreamIds(
        upstreamIds,
        shouldKeepMembership
          ? (channel.upstreamPolicies || [])
          : (channel.upstreamPolicies || []).filter((item) => item.upstreamId !== normalizedUpstream.id),
        next,
      );
      return {
        ...channel,
        upstreamIds,
        upstreamPolicies,
      };
    });
    writeCatalog({ ...catalog, upstreams: next, channels: nextChannels.length ? nextChannels : buildFixedChannels(next) });
    return readCatalog();
  },
  async saveUpstreamAsync(upstream: ConsoleUpstream) {
    return mutateCatalogAsync((catalog) => {
      const normalizedUpstream = normalizeUpstreamForKind(upstream);
      const next = catalog.upstreams.filter((item) => item.id !== normalizedUpstream.id);
      next.push(normalizedUpstream);
      const nextChannels = catalog.channels.map((channel) => {
        const shouldKeepMembership = channel.acceptedUpstreamKinds.includes(normalizedUpstream.kind);
        const upstreamIds = shouldKeepMembership
          ? Array.from(new Set([...channel.upstreamIds, normalizedUpstream.id]))
          : channel.upstreamIds.filter((item) => item !== normalizedUpstream.id);
        const upstreamPolicies = syncChannelPoliciesForUpstreamIds(
          upstreamIds,
          shouldKeepMembership
            ? (channel.upstreamPolicies || [])
            : (channel.upstreamPolicies || []).filter((item) => item.upstreamId !== normalizedUpstream.id),
          next,
        );
        return {
          ...channel,
          upstreamIds,
          upstreamPolicies,
        };
      });
      return { ...catalog, upstreams: next, channels: nextChannels.length ? nextChannels : buildFixedChannels(next) };
    });
  },
  removeUpstream(id: string) {
    const catalog = readCatalog();
    writeCatalog({
      ...catalog,
      upstreams: catalog.upstreams.filter((item) => item.id !== id),
      channels: catalog.channels.map((channel) => ({
        ...channel,
        upstreamIds: channel.upstreamIds.filter((upstreamId) => upstreamId !== id),
        upstreamPolicies: (channel.upstreamPolicies || []).filter((item) => item.upstreamId !== id),
      })),
    });
    return readCatalog();
  },
  async removeUpstreamAsync(id: string) {
    return mutateCatalogAsync((catalog) => ({
      ...catalog,
      upstreams: catalog.upstreams.filter((item) => item.id !== id),
      channels: catalog.channels.map((channel) => ({
        ...channel,
        upstreamIds: channel.upstreamIds.filter((upstreamId) => upstreamId !== id),
        upstreamPolicies: (channel.upstreamPolicies || []).filter((item) => item.upstreamId !== id),
      })),
    }));
  },
  saveChannel(channel: ConsoleChannel) {
    const catalog = readCatalog();
    const next = catalog.channels.filter((item) => item.id !== channel.id);
    next.push({
      ...channel,
      upstreamPolicies: syncChannelPoliciesForUpstreamIds(channel.upstreamIds, channel.upstreamPolicies || [], catalog.upstreams),
    });
    writeCatalog({ ...catalog, channels: next });
    return readCatalog();
  },
  async saveChannelAsync(channel: ConsoleChannel) {
    return mutateCatalogAsync((catalog) => {
      const next = catalog.channels.filter((item) => item.id !== channel.id);
      next.push({
        ...channel,
        upstreamPolicies: syncChannelPoliciesForUpstreamIds(channel.upstreamIds, channel.upstreamPolicies || [], catalog.upstreams),
      });
      return { ...catalog, channels: next };
    });
  },
  removeChannel(id: string) {
    const catalog = readCatalog();
    writeCatalog({
      ...catalog,
      channels: catalog.channels.filter((item) => item.id !== id),
      tenants: catalog.tenants.map((tenant) => ({
        ...tenant,
        allowedChannelIds: tenant.allowedChannelIds.filter((channelId) => channelId !== id),
      })),
      apiKeys: catalog.apiKeys.map((item) => ({
        ...item,
        allowedChannelIds: item.allowedChannelIds.filter((channelId) => channelId !== id),
      })),
    });
    return readCatalog();
  },
  async removeChannelAsync(id: string) {
    return mutateCatalogAsync((catalog) => ({
      ...catalog,
      channels: catalog.channels.filter((item) => item.id !== id),
      tenants: catalog.tenants.map((tenant) => ({
        ...tenant,
        allowedChannelIds: tenant.allowedChannelIds.filter((channelId) => channelId !== id),
      })),
      apiKeys: catalog.apiKeys.map((item) => ({
        ...item,
        allowedChannelIds: item.allowedChannelIds.filter((channelId) => channelId !== id),
      })),
    }));
  },
  saveTenant(tenant: ConsoleTenant) {
    const catalog = readCatalog();
    const next = catalog.tenants.filter((item) => item.id !== tenant.id);
    next.push(tenant);
    writeCatalog({ ...catalog, tenants: next });
    return readCatalog();
  },
  async saveTenantAsync(tenant: ConsoleTenant) {
    return mutateCatalogAsync((catalog) => {
      const next = catalog.tenants.filter((item) => item.id !== tenant.id);
      next.push(tenant);
      return { ...catalog, tenants: next };
    });
  },
  removeTenant(id: string) {
    const catalog = readCatalog();
    writeCatalog({
      ...catalog,
      tenants: catalog.tenants.filter((item) => item.id !== id),
      apiKeys: catalog.apiKeys.filter((item) => item.tenantId !== id),
    });
    return readCatalog();
  },
  async removeTenantAsync(id: string) {
    return mutateCatalogAsync((catalog) => ({
      ...catalog,
      tenants: catalog.tenants.filter((item) => item.id !== id),
      apiKeys: catalog.apiKeys.filter((item) => item.tenantId !== id),
    }));
  },
  saveApiKey(apiKey: ConsoleApiKey) {
    const catalog = readCatalog();
    const next = catalog.apiKeys.filter((item) => item.id !== apiKey.id);
    next.push(apiKey);
    writeCatalog({ ...catalog, apiKeys: next });
    return readCatalog();
  },
  async saveApiKeyAsync(apiKey: ConsoleApiKey) {
    return mutateCatalogAsync((catalog) => {
      const next = catalog.apiKeys.filter((item) => item.id !== apiKey.id);
      next.push(apiKey);
      return { ...catalog, apiKeys: next };
    });
  },
  removeApiKey(id: string) {
    const catalog = readCatalog();
    writeCatalog({
      ...catalog,
      apiKeys: catalog.apiKeys.filter((item) => item.id !== id),
    });
    return readCatalog();
  },
  async removeApiKeyAsync(id: string) {
    return mutateCatalogAsync((catalog) => ({
      ...catalog,
      apiKeys: catalog.apiKeys.filter((item) => item.id !== id),
    }));
  },
  getStorageInfo() {
    const filePath = postgresConsoleCatalogRepository
      ? `postgresql://${process.env.PG_SCHEMA || 'public'}.console_catalog`
      : consoleCatalogStore.getFilePath();
    return {
      consoleDataDir: postgresConsoleCatalogRepository ? 'postgresql' : filePath.replace(/[\\/][^\\/]+$/, ''),
      consoleCatalogFilePath: filePath,
    };
  },
};

export function createMaskedApiKey() {
  const raw = `yk_${crypto.randomBytes(18).toString('hex')}`;
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  return {
    raw,
    masked: `${raw.slice(0, 7)}...${raw.slice(-4)}`,
    hash,
  };
}

function buildProbeCandidates(baseCandidate: string, input: ProbeBuilderInput): ProbeCandidate[] {
  const targetKind = input.targetKind || 'images_endpoint';
  const model = input.model || (
    targetKind === 'chat_completions'
      ? 'gpt-4.1-mini'
      : targetKind === 'responses_endpoint'
        ? 'gpt-5.4-mini'
        : 'gpt-image-2'
  );
  const imageModel = input.imageModel || 'gpt-image-2';
  const size = input.size || '1536x1024';
  const referenceImageUrl = input.referenceImageUrl || DEFAULT_TEST_REFERENCE_IMAGE_URL;
  const customBodyFields = input.customBodyFields;

  if (targetKind === 'responses_endpoint') {
    const candidates: ProbeCandidate[] = [
      {
        key: `responses_post_text:${baseCandidate}`,
        label: 'Responses POST 文生图',
        method: 'POST',
        baseUrl: baseCandidate,
        path: '/v1/responses',
        body: mergeProbeBody(buildResponsesProbeBody({
          ...input,
          size,
          referenceImageUrl: undefined,
          referenceImageDataUrl: undefined,
        }), customBodyFields),
        requireImageOutput: true,
      },
    ];

    if (referenceImageUrl) {
      candidates.push({
        key: `responses_post_edit_url:${baseCandidate}`,
        label: 'Responses POST 图生图(URL)',
        method: 'POST',
        baseUrl: baseCandidate,
        path: '/v1/responses',
        body: mergeProbeBody(buildResponsesProbeBody({
          ...input,
          size,
          referenceImageUrl,
          referenceImageDataUrl: undefined,
        }), customBodyFields),
        requireImageOutput: true,
      });
    }

    if (input.referenceImageDataUrl) {
      candidates.push({
        key: `responses_post_edit_base64:${baseCandidate}`,
        label: 'Responses POST 图生图(BASE64)',
        method: 'POST',
        baseUrl: baseCandidate,
        path: '/v1/responses',
        body: mergeProbeBody(buildResponsesProbeBody({
          ...input,
          size,
          referenceImageUrl: undefined,
          referenceImageDataUrl: input.referenceImageDataUrl,
        }), customBodyFields),
        requireImageOutput: true,
      });
    }

    return candidates;
  }

  if (targetKind === 'chat_completions') {
    const chatMessages = referenceImageUrl
      ? [{
          role: 'user',
          content: [
            { type: 'text', text: '请描述这张图片里的主体、背景与风格。' },
            { type: 'image_url', image_url: { url: referenceImageUrl } },
          ],
        }]
      : [{ role: 'user', content: 'probe' }];
    return [
      {
        key: `chat_post:${baseCandidate}`,
        label: 'Chat Completions POST',
        method: 'POST',
        baseUrl: baseCandidate,
        path: '/v1/chat/completions',
        body: mergeProbeBody({
          model,
          messages: chatMessages,
          ...(input.stream !== undefined ? { stream: input.stream } : {}),
        }, customBodyFields),
      },
    ];
  }

  const generationsUrl = normalizeOptionalEndpointUrl(input.imagesGenerationUrl);
  const editsUrl = normalizeOptionalEndpointUrl(input.imagesEditUrl);
  const prompt = String(input.prompt || DEFAULT_TEST_PROMPT).trim() || DEFAULT_TEST_PROMPT;
  const outputFormat = input.outputFormat || 'webp';
  const outputCompression = Number(input.outputCompression);
  const partialImages = Number(input.partialImages);
  const count = Number.isInteger(input.n) && Number(input.n) > 0 ? Number(input.n) : 1;

  const buildImagesBody = (
    responseFormat: ResponseFormat,
    options: { image?: string } = {},
  ) => mergeProbeBody({
    model,
    prompt,
    ...(options.image ? { image: options.image } : {}),
    size,
    quality: input.quality || 'auto',
    output_format: outputFormat,
    response_format: responseFormat,
    ...(Number.isFinite(outputCompression) ? { output_compression: outputCompression } : {}),
    ...(input.background && input.background !== 'omit' ? { background: input.background } : {}),
    ...(input.moderation && input.moderation !== 'omit' ? { moderation: input.moderation } : {}),
    ...(Number.isInteger(partialImages) && partialImages > 0 ? { partial_images: partialImages } : {}),
    n: count,
    ...(input.stream !== undefined ? { stream: input.stream } : {}),
  }, customBodyFields);

  const candidates: ProbeCandidate[] = [];
  if (generationsUrl) {
    candidates.push({
      key: 'images_generations_post:format_url',
      label: 'Images 文生图 (url)',
      method: 'POST',
      baseUrl: '',
      path: generationsUrl,
      body: buildImagesBody('url'),
      requireImageOutput: true,
    });
  }
  if (editsUrl) {
    candidates.push({
      key: 'images_edits_post_multipart:format_b64_json',
      label: 'Images 图生图 (b64_json)',
      method: 'POST',
      baseUrl: '',
      path: editsUrl,
      bodyFormat: 'multipart',
      body: buildImagesBody('b64_json', {
        image: input.referenceImageDataUrl || referenceImageUrl,
      }),
      requireImageOutput: true,
    });
    candidates.push({
      key: 'images_edits_post_json_image_url:format_b64_json',
      label: 'Images edits (JSON images[].image_url URL, b64_json)',
      method: 'POST',
      baseUrl: '',
      path: editsUrl,
      bodyFormat: 'json',
      body: mergeProbeBody({
        model,
        prompt,
        images: [{ image_url: referenceImageUrl }],
        size,
        quality: input.quality || 'auto',
        output_format: outputFormat,
        response_format: 'b64_json',
        ...(Number.isFinite(outputCompression) ? { output_compression: outputCompression } : {}),
        ...(input.background && input.background !== 'omit' ? { background: input.background } : {}),
        ...(input.moderation && input.moderation !== 'omit' ? { moderation: input.moderation } : {}),
        ...(Number.isInteger(partialImages) && partialImages > 0 ? { partial_images: partialImages } : {}),
        n: count,
        ...(input.stream !== undefined ? { stream: input.stream } : {}),
      }, customBodyFields),
      requireImageOutput: true,
    });
    if (input.referenceImageDataUrl) {
      candidates.push({
        key: 'images_edits_post_json_image_data_url:format_b64_json',
        label: 'Images edits (JSON images[].image_url data URL, b64_json)',
        method: 'POST',
        baseUrl: '',
        path: editsUrl,
        bodyFormat: 'json',
        body: mergeProbeBody({
          model,
          prompt,
          images: [{ image_url: input.referenceImageDataUrl }],
          size,
          quality: input.quality || 'auto',
          output_format: outputFormat,
          response_format: 'b64_json',
          ...(Number.isFinite(outputCompression) ? { output_compression: outputCompression } : {}),
          ...(input.background && input.background !== 'omit' ? { background: input.background } : {}),
          ...(input.moderation && input.moderation !== 'omit' ? { moderation: input.moderation } : {}),
          ...(Number.isInteger(partialImages) && partialImages > 0 ? { partial_images: partialImages } : {}),
          n: count,
          ...(input.stream !== undefined ? { stream: input.stream } : {}),
        }, customBodyFields),
        requireImageOutput: true,
      });
    }
  }

  return candidates;
}

function isMeaningfulStatus(statusCode: number | null) {
  return statusCode !== null && [200, 400, 401, 403, 405, 409, 422, 429].includes(statusCode);
}

function looksLikeParameterCompatibilityError(bodyText: string, bodyJson?: unknown) {
  const rawText = String(bodyText || '').toLowerCase();
  const jsonText = bodyJson && typeof bodyJson === 'object'
    ? JSON.stringify(bodyJson).toLowerCase()
    : '';
  const combined = `${rawText}\n${jsonText}`;
  return (
    combined.includes('unknown parameter')
    || combined.includes('unsupported parameter')
    || combined.includes('unexpected parameter')
    || combined.includes('invalid_request')
    || combined.includes('invalid request')
    || combined.includes('unrecognized request argument')
  );
}

function inferKindFromChecks(checks: EndpointProbeCheck[]): ConsoleUpstreamKind[] {
  const result: ConsoleUpstreamKind[] = [];
  const hasImages = checks.some((item) => item.key.includes('images_') && item.ok);
  const hasResponses = checks.some((item) => item.key.includes('responses_') && item.ok);
  const hasChat = checks.some((item) => item.key.includes('chat_') && item.exists);

  if (hasImages) {
    result.push('images_endpoint');
  }
  if (hasResponses) {
    result.push('responses_endpoint');
  }
  if (hasChat) {
    result.push('chat_completions');
  }

  return result;
}

function detectActualImageResponseFormatFromValue(value: unknown): ResponseFormat | null {
  if (typeof value !== 'string') {
    return null;
  }
  const raw = String(value || '').trim();
  if (!raw) {
    return null;
  }
  if (/^https?:\/\//i.test(raw)) {
    return 'url';
  }
  if (probeDecodeImagePayload(raw)?.buffer) {
    return 'b64_json';
  }
  return null;
}

function collectActualImageResponseFormatsFromNode(node: unknown, formats: Set<ResponseFormat>) {
  if (Array.isArray(node)) {
    for (const item of node) {
      collectActualImageResponseFormatsFromNode(item, formats);
    }
    return;
  }
  const record = getJsonRecord(node);
  if (!record) {
    return;
  }
  if (typeof record.b64_json === 'string' || typeof record.partial_image_b64 === 'string') {
    formats.add('b64_json');
  }
  const urlFormat = detectActualImageResponseFormatFromValue(record.url);
  if (urlFormat) {
    formats.add(urlFormat);
  }
  const resultFormat = detectActualImageResponseFormatFromValue(record.result);
  if (resultFormat) {
    formats.add(resultFormat);
  }
  const imageUrlFormat = detectActualImageResponseFormatFromValue(record.image_url);
  if (imageUrlFormat) {
    formats.add(imageUrlFormat);
  }
  for (const value of Object.values(record)) {
    collectActualImageResponseFormatsFromNode(value, formats);
  }
}

function collectActualImageResponseFormatsFromTraceEntries(traceEntries: ProbeTraceEntry[]): ResponseFormat[] {
  const formats = new Set<ResponseFormat>();
  for (const entry of traceEntries) {
    if (!entry.check.ok) {
      continue;
    }
    collectActualImageResponseFormatsFromNode(entry.response.bodyJson, formats);
    const bodyText = String(entry.response.bodyText || '');
    if (/"b64_json"\s*:\s*"/.test(bodyText) || /"partial_image_b64"\s*:\s*"/.test(bodyText) || /data:image\/[a-zA-Z0-9.+-]+;base64,/.test(bodyText)) {
      formats.add('b64_json');
    }
    if (/"url"\s*:\s*"https?:\/\/[^"]+"/i.test(bodyText) || /"result"\s*:\s*"https?:\/\/[^"]+"/i.test(bodyText) || /"image_url"\s*:\s*"https?:\/\/[^"]+"/i.test(bodyText)) {
      formats.add('url');
    }
  }
  return (['url', 'b64_json'] as ResponseFormat[]).filter((format) => formats.has(format));
}

function hasActualHttpImageUrlInNode(node: unknown): boolean {
  if (Array.isArray(node)) {
    return node.some((item) => hasActualHttpImageUrlInNode(item));
  }
  const record = getJsonRecord(node);
  if (!record) {
    return false;
  }
  for (const key of ['url', 'result', 'image_url'] as const) {
    const value = record[key];
    if (typeof value === 'string' && /^https?:\/\//i.test(value.trim())) {
      return true;
    }
  }
  return Object.values(record).some((value) => hasActualHttpImageUrlInNode(value));
}

function collectActualHttpImageUrlSupportFromTraceEntries(traceEntries: ProbeTraceEntry[]) {
  for (const entry of traceEntries) {
    if (!entry.check.ok) {
      continue;
    }
    if (hasActualHttpImageUrlInNode(entry.response.bodyJson)) {
      return true;
    }
    const bodyText = String(entry.response.bodyText || '');
    if (/"(?:url|result|image_url)"\s*:\s*"https?:\/\/[^"]+"/i.test(bodyText)) {
      return true;
    }
  }
  return false;
}

function buildPersistedResponsesConfigFromProbe(
  input: OnboardingAnalyzeInput,
  responsesChecks: EndpointProbeCheck[],
  traceEntries: ProbeTraceEntry[],
): ResponsesEndpointConfig {
  const defaults = defaultResponsesConfig();
  const referenceImageValue = String(input.referenceImageDataUrl || input.referenceImageUrl || '').trim();
  const responseFormats = collectActualImageResponseFormatsFromTraceEntries(
    traceEntries.filter((entry) => entry.key.includes('responses_')),
  );
  return normalizeResponsesConfig({
    supportsImageInput: responsesChecks.some((item) => (
      (item.key.includes('responses_post_edit_url') || item.key.includes('responses_post_edit_base64')) && item.ok
    )),
    responseFormats,
    jsonReferenceTransports: [
      ...(responsesChecks.some((item) => item.key.includes('responses_post_edit_url') && item.ok) ? ['url' as const] : []),
      ...(responsesChecks.some((item) => item.key.includes('responses_post_edit_base64') && item.ok) ? ['base64' as const] : []),
    ],
    allowDirectPublicImageUrl: collectActualHttpImageUrlSupportFromTraceEntries(
      traceEntries.filter((entry) => entry.key.includes('responses_')),
    ),
    textModel: input.model || defaults.textModel,
    imageModel: input.imageModel || defaults.imageModel,
    reasoningEffort: input.reasoningEffort ?? defaults.reasoningEffort,
    returnMode: 'stream',
    inputShape: input.responsesInputShape
      || (referenceImageValue ? 'always_multimodal_message' : 'auto_standard'),
    toolChoice: input.responsesToolChoice || defaults.toolChoice,
    toolChoiceFormat: input.responsesToolChoiceFormat || defaults.toolChoiceFormat,
    modelRouting: input.imageModel ? 'split_text_image' : 'single_top_level_model',
    moderationMode: input.moderation === 'auto'
      ? 'force_auto'
      : input.moderation === 'low'
        ? 'force_low'
        : defaults.moderationMode,
    capabilityProfiles: [],
    imageToolQuality: undefined,
    imageQuality: undefined,
  });
}

function pickRawUpstreamAddress(input: OnboardingAnalyzeInput, kind: ConsoleUpstreamKind) {
  if (kind === 'images_endpoint') {
    return String(input.imagesGenerationUrl || input.imagesEditUrl || input.baseUrl || '').trim();
  }
  return String(input.baseUrl || '').trim();
}

function buildDetectedUpstreamDraft(
  input: OnboardingAnalyzeInput,
  probe: OnboardingProbeResult,
  traceEntries: ProbeTraceEntry[],
): ConsoleUpstream {
  const kind = probe.recommendedKind || 'images_endpoint';
  const imagesChecks = probe.checks.filter((item) => item.key.includes('images_'));
  const responsesChecks = probe.checks.filter((item) => item.key.includes('responses_'));
  const chatChecks = probe.checks.filter((item) => item.key.includes('chat_'));

  const preset = buildOnboardingPreset(input, kind);
  const customBodyFields = input.customBodyFields && Object.keys(input.customBodyFields).length
    ? sanitizeInjectedBodyFieldsForKind(kind, input.customBodyFields)
    : undefined;

  const imagesConfig = kind === 'images_endpoint'
    ? (() => {
        const detectedResponseFormats = collectActualImageResponseFormatsFromTraceEntries(
          traceEntries.filter((entry) => entry.key.includes('images_')),
        );
        const supportsMultipartEdits = imagesChecks.some((item) => item.key.includes('images_edits_post_multipart') && item.ok);
        const supportsJsonImageUrlEdits = imagesChecks.some((item) => item.key.includes('images_edits_post_json_image_url') && item.ok);
        const supportsJsonImageDataUrlEdits = imagesChecks.some((item) => item.key.includes('images_edits_post_json_image_data_url') && item.ok);
        const supportsAnyJsonImageUrlEdits = supportsJsonImageUrlEdits || supportsJsonImageDataUrlEdits;
        const editProtocolModes: Array<'multipart_file_upload' | 'json_image_url'> = [
          ...(supportsMultipartEdits ? ['multipart_file_upload' as const] : []),
          ...(supportsAnyJsonImageUrlEdits ? ['json_image_url' as const] : []),
        ];
        const jsonReferenceTransports: Array<'url' | 'base64'> = [
          ...(supportsJsonImageUrlEdits ? ['url' as const] : []),
          ...(supportsJsonImageDataUrlEdits ? ['base64' as const] : []),
        ];
        return normalizeImagesConfig({
          ...defaultImagesConfig(),
          supportsGenerations: imagesChecks.some((item) => item.key.includes('images_generations_post') && item.ok),
          supportsEdits: imagesChecks.some((item) => item.key.includes('images_edits_post') && item.ok),
          supportsAsync: false,
          responseFormats: detectedResponseFormats.length ? detectedResponseFormats : (['b64_json'] as ResponseFormat[]),
          editProtocolModes,
          jsonReferenceTransports,
          returnMode: input.stream ? 'stream' as const : 'json' as const,
          generationsUrl: normalizeOptionalEndpointUrl(input.imagesGenerationUrl),
          editsUrl: normalizeOptionalEndpointUrl(input.imagesEditUrl),
        });
      })()
    : undefined;

  const responsesConfig = kind === 'responses_endpoint'
    ? buildPersistedResponsesConfigFromProbe(input, responsesChecks, traceEntries)
    : undefined;

  const chatConfig = kind === 'chat_completions'
    ? {
        ...defaultChatConfig(),
        supportsJsonMode: chatChecks.some((item) => item.exists),
        supportsVisionInput: Boolean(input.referenceImageUrl) && chatChecks.some((item) => item.key.includes('chat_post') && item.exists),
      }
    : undefined;

  return {
    id: randomId('upstream'),
    name: input.name || 'New upstream',
    kind,
    baseUrl: pickRawUpstreamAddress(input, kind)
      || probe.normalizedBaseCandidates[0]
      || '',
    apiKey: input.apiKey || '',
    enabled: true,
    maxConcurrency: 10,
    healthStatus: 'healthy',
    modelHints: Array.from(new Set([
      kind === 'responses_endpoint' ? preset.imageModel : preset.model,
    ].filter(Boolean) as string[])),
    notes: '',
    adminTestPreset: preset,
    passthrough: {
      injectBodyFields: customBodyFields || {},
    },
    imagesConfig,
    responsesConfig,
    chatConfig,
    detectedConfig: {
      kind,
      imagesConfig,
      responsesConfig,
      chatConfig,
      probe,
    },
    manualOverrides: {},
  };
}

function summarizeProbeRequest(entry: ProbeTraceEntry) {
  const lines: string[] = [
    `请求地址：${entry.request.url}`,
    `请求方法：${entry.request.method}`,
    `提交格式：${entry.request.bodyFormat === 'multipart' ? 'multipart/form-data' : 'application/json'}`,
  ];
  const body = entry.request.body || {};
  if (Array.isArray((body as { images?: unknown }).images)) {
    lines.push('图生图协议：JSON + images[].image_url');
  } else if ('image' in body) {
    lines.push(`图生图协议：${entry.request.bodyFormat === 'multipart' ? 'multipart + image(file part)' : 'image 字段'}`);
  }
  const model = String(body.model || '').trim();
  if (model) {
    lines.push(`模型：${model}`);
  }
  const size = String(body.size || '').trim();
  if (size) {
    lines.push(`尺寸：${size}`);
  }
  const prompt = String(body.prompt || '').trim();
  if (prompt) {
    lines.push(`提示词：${prompt.slice(0, 80)}`);
  }
  if (typeof body.stream === 'boolean') {
    lines.push(`流式返回：${body.stream ? '开启' : '关闭'}`);
  }
  if (typeof body.async === 'boolean') {
    lines.push(`异步提交：${body.async ? '开启' : '关闭'}`);
  }
  if (typeof body.response_format === 'string') {
    lines.push(`返回图片格式：${String(body.response_format)}`);
  }
  if (typeof body.output_format === 'string') {
    lines.push(`输出图片格式：${String(body.output_format)}`);
  }
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    const firstTool = body.tools[0] as Record<string, unknown>;
    lines.push(`图像工具：${String(firstTool.type || 'unknown')}`);
    if (typeof firstTool.model === 'string') {
      lines.push(`图像工具模型：${firstTool.model}`);
    }
    if (typeof firstTool.action === 'string') {
      lines.push(`图像动作：${firstTool.action}`);
    }
    if (typeof firstTool.size === 'string') {
      lines.push(`图像工具尺寸：${firstTool.size}`);
    }
    if (typeof firstTool.output_format === 'string') {
      lines.push(`图像输出格式：${firstTool.output_format}`);
    }
  }
  const hasReferenceImage = Array.isArray(body.image)
    ? body.image.length > 0
    : typeof body.image === 'string'
      ? Boolean(String(body.image).trim())
      : false;
  const hasJsonImageArray = Array.isArray((body as { images?: unknown }).images)
    && (body as { images?: unknown[] }).images!.length > 0;
  if (hasJsonImageArray) {
    lines.push('参考图：已携带 images[].image_url JSON 字段');
  } else if (hasReferenceImage) {
    lines.push(`参考图：已携带 ${entry.request.bodyFormat === 'multipart' ? '文件上传' : '图片字段'}`);
  }
  const customKeys = Object.keys(body).filter((key) => ![
    'model',
    'prompt',
    'size',
    'quality',
    'response_format',
    'output_format',
    'stream',
    'async',
    'image',
    'images',
    'tools',
    'input',
    'reasoning',
    'tool_choice',
    'n',
  ].includes(key));
  if (customKeys.length) {
    lines.push(`附加字段：${customKeys.join('、')}`);
  }
  return lines;
}

function buildProbePreviewDataUrl(value: string) {
  const decoded = probeDecodeImagePayload(value);
  if (!decoded) {
    return '';
  }
  const resolved = resolveValidatedProbeImageBuffer(decoded.buffer, decoded.extension);
  if (!resolved) {
    return '';
  }
  const mime = probeContentTypeForExtension(resolved.extension);
  return `data:${mime};base64,${resolved.buffer.toString('base64')}`;
}

function getProbeGeneratedImageDir() {
  return path.join(String(process.env.ADMIN_DATA_DIR || path.join(process.cwd(), 'data')), probeGeneratedImageSubdir);
}

function inferProbePublicBaseUrl(request?: FastifyRequest) {
  const configured = String(process.env.PUBLIC_API_BASE_URL || '').trim();
  if (configured) {
    return configured.replace(/\/+$/, '');
  }
  const headers = request?.headers || {};
  const protocolHeader = String(headers['x-forwarded-proto'] || '').trim();
  const proto = protocolHeader || String((request as { protocol?: string } | undefined)?.protocol || 'http');
  const hostHeader = String(headers['x-forwarded-host'] || headers.host || '').trim();
  if (hostHeader) {
    return `${proto}://${hostHeader.replace(/\/+$/, '')}`;
  }
  const port = String(process.env.PORT || '4010').trim();
  return `http://127.0.0.1:${port}`;
}

async function persistProbeImageAndBuildUrl(input: {
  request?: FastifyRequest;
  taskId: string;
  imageIndex: number;
  buffer: Buffer;
  extension: string;
}) {
  const dir = getProbeGeneratedImageDir();
  await fs.mkdir(dir, { recursive: true });
  const safeTask = String(input.taskId || 'probe').replace(/[^a-zA-Z0-9_-]+/g, '_');
  const safeExt = String(input.extension || 'png').replace(/[^a-zA-Z0-9]+/g, '') || 'png';
  const fileName = `${safeTask}_${input.imageIndex}.${safeExt}`;
  const filePath = path.join(dir, fileName);
  await fs.writeFile(filePath, input.buffer);
  return `${inferProbePublicBaseUrl(input.request)}/v1/generated-images/${encodeURIComponent(fileName)}`;
}

async function mapProbePreviewValueToGatewayUrl(
  value: string,
  request: FastifyRequest | undefined,
  taskId: string,
  imageIndex: number,
) {
  const decoded = probeDecodeImagePayload(value);
  if (decoded?.buffer) {
    const resolved = resolveValidatedProbeImageBuffer(decoded.buffer, decoded.extension);
    if (!resolved) {
      return '';
    }
    return persistProbeImageAndBuildUrl({
      request,
      taskId,
      imageIndex,
      buffer: resolved.buffer,
      extension: resolved.extension,
    });
  }
  const raw = String(value || '').trim();
  if (!/^https?:\/\//i.test(raw)) {
    return '';
  }
  try {
    const response = await fetch(raw);
    if (!response.ok) {
      return '';
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    const resolved = resolveValidatedProbeImageBuffer(buffer);
    if (!resolved) {
      return '';
    }
    return persistProbeImageAndBuildUrl({
      request,
      taskId,
      imageIndex,
      buffer: resolved.buffer,
      extension: resolved.extension,
    });
  } catch {
    return '';
  }
}

async function extractPreviewImageFromPayload(
  node: unknown,
  request: FastifyRequest | undefined,
  taskId: string,
  imageIndex = 0,
): Promise<{ url?: string; note?: string }> {
  if (!node || typeof node !== 'object') {
    return {};
  }
  if (Array.isArray(node)) {
    for (let index = 0; index < node.length; index += 1) {
      const matched = await extractPreviewImageFromPayload(node[index], request, taskId, index);
      if (matched.url || matched.note) {
        return matched;
      }
    }
    return {};
  }
  const record = node as Record<string, unknown>;
  if (typeof record.url === 'string') {
    const gatewayUrl = await mapProbePreviewValueToGatewayUrl(record.url, request, taskId, imageIndex);
    if (gatewayUrl) {
      return {
        url: gatewayUrl,
        note: '图片已转存为本站预览地址，响应结构中的图片内容已省略。',
      };
    }
  }
  if (typeof record.result === 'string') {
    const gatewayUrl = await mapProbePreviewValueToGatewayUrl(record.result, request, taskId, imageIndex);
    if (gatewayUrl) {
      return {
        url: gatewayUrl,
        note: '图片已转存为本站预览地址，响应结构中的图片内容已省略。',
      };
    }
  }
  if (typeof record.b64_json === 'string' && record.b64_json.length > 32) {
    const gatewayUrl = await mapProbePreviewValueToGatewayUrl(record.b64_json, request, taskId, imageIndex);
    if (gatewayUrl) {
      return {
        url: gatewayUrl,
        note: '图片已转存为本站预览地址，响应结构中的图片内容已省略。',
      };
    }
    return { note: '本次探测已拿到 Base64 图片，内容已省略。' };
  }
  for (const value of Object.values(record)) {
    const matched = await extractPreviewImageFromPayload(value, request, taskId, imageIndex);
    if (matched.url || matched.note) {
      return matched;
    }
  }
  return {};
}

function tryParseJson(text: string) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function parseSseEvents(bodyText: string) {
  const blocks = String(bodyText || '')
    .split(/\r?\n\r?\n/)
    .map((block) => block.trim())
    .filter(Boolean);
  const events: Array<{ event: string; dataText: string; dataJson?: unknown }> = [];
  for (const block of blocks) {
    const lines = block.split(/\r?\n/);
    let eventName = '';
    const dataLines: string[] = [];
    for (const line of lines) {
      if (line.startsWith('event:')) {
        eventName = line.slice('event:'.length).trim();
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice('data:'.length).trim());
      }
    }
    const dataText = dataLines.join('\n').trim();
    if (!eventName && !dataText) {
      continue;
    }
    events.push({
      event: eventName || 'message',
      dataText,
      dataJson: dataText ? tryParseJson(dataText) : undefined,
    });
  }
  return events;
}

function extractChatCompletionSseText(bodyText: string) {
  let content = '';
  let finishReason = '';
  let done = false;
  let usage: unknown = undefined;
  for (const event of parseSseEvents(bodyText)) {
    if (event.dataText === '[DONE]') {
      done = true;
      continue;
    }
    const record = getJsonRecord(event.dataJson);
    if (!record) {
      continue;
    }
    if (record.usage !== undefined) {
      usage = record.usage;
    }
    const choices = Array.isArray(record.choices) ? record.choices : [];
    for (const choice of choices) {
      const choiceRecord = getJsonRecord(choice);
      if (!choiceRecord) {
        continue;
      }
      const delta = getJsonRecord(choiceRecord.delta);
      const message = getJsonRecord(choiceRecord.message);
      const deltaContent = typeof delta?.content === 'string' ? delta.content : '';
      const messageContent = typeof message?.content === 'string' ? message.content : '';
      content += deltaContent || messageContent;
      if (typeof choiceRecord.finish_reason === 'string' && choiceRecord.finish_reason) {
        finishReason = choiceRecord.finish_reason;
      }
    }
  }
  return {
    content,
    finishReason,
    done,
    usage,
  };
}

function formatTextPreview(text: string, maxLength: number) {
  const normalized = String(text || '').trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength)}...（已截断，完整内容请查看对应 probe-detail 请求追踪）`;
}

function redactImagePayload(node: unknown): unknown {
  if (Array.isArray(node)) {
    return node.map((item) => redactImagePayload(item));
  }
  if (!node || typeof node !== 'object') {
    return node;
  }
  const record = node as Record<string, unknown>;
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if ((key === 'b64_json' || key === 'result' || key === 'partial_image_b64') && typeof value === 'string' && value.length > 64) {
      sanitized[key] = '<image payload omitted>';
      continue;
    }
    if ((key === 'image' || key === 'image_url') && typeof value === 'string') {
      const raw = String(value || '').trim();
      if (/^data:image\//i.test(raw) || raw.length > 512) {
        sanitized[key] = '<image payload omitted>';
        continue;
      }
    }
    sanitized[key] = redactImagePayload(value);
  }
  return sanitized;
}

async function extractPreviewImageFromSseText(
  bodyText: string,
  request: FastifyRequest | undefined,
  taskId: string,
): Promise<{ url?: string; note?: string }> {
  const normalized = String(bodyText || '');
  const parsedEvents = parseSseEvents(normalized);
  for (let index = parsedEvents.length - 1; index >= 0; index -= 1) {
    const event = parsedEvents[index];
    if (event.dataJson !== undefined) {
      const matched = await extractPreviewImageFromPayload(event.dataJson, request, taskId, 0);
      if (matched.url || matched.note) {
        return matched.url
          ? {
              url: matched.url,
              note: matched.note || '图片已转存为本站预览地址，SSE 响应中的图片内容已省略。',
            }
          : matched;
      }
    }
  }
  const dataUrlMatch = normalized.match(/data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=\s]+/);
  if (dataUrlMatch?.[0]) {
    const gatewayUrl = await mapProbePreviewValueToGatewayUrl(dataUrlMatch[0], request, taskId, 0);
    if (gatewayUrl) {
      return {
        url: gatewayUrl,
        note: '图片已转存为本站预览地址，SSE 响应中的图片内容已省略。',
      };
    }
    return {
      note: '本次探测已在 SSE 事件中拿到 Base64 图片，内容已省略。',
    };
  }
  const b64JsonMatch = normalized.match(/"b64_json"\s*:\s*"([A-Za-z0-9+/=\s]+)"/);
  if (b64JsonMatch?.[1]) {
    const gatewayUrl = await mapProbePreviewValueToGatewayUrl(b64JsonMatch[1], request, taskId, 0);
    if (gatewayUrl) {
      return {
        url: gatewayUrl,
        note: '图片已转存为本站预览地址，SSE 响应中的图片内容已省略。',
      };
    }
  }
  const rawResultMatch = normalized.match(/"result"\s*:\s*"([A-Za-z0-9+/=\s]{256,})"/);
  if (rawResultMatch?.[1]) {
    const gatewayUrl = await mapProbePreviewValueToGatewayUrl(rawResultMatch[1], request, taskId, 0);
    if (gatewayUrl) {
      return {
        url: gatewayUrl,
        note: '图片已转存为本站预览地址，SSE 响应中的图片内容已省略。',
      };
    }
  }
  const partialImageMatch = normalized.match(/"partial_image_b64"\s*:\s*"([A-Za-z0-9+/=\s]{256,})"/);
  if (partialImageMatch?.[1]) {
    const gatewayUrl = await mapProbePreviewValueToGatewayUrl(partialImageMatch[1], request, taskId, 0);
    if (gatewayUrl) {
      return {
        url: gatewayUrl,
        note: '图片已转存为本站预览地址，SSE 响应中的图片内容已省略。',
      };
    }
  }
  const resultMatch = normalized.match(/"result"\s*:\s*"(data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=\s]+)"/);
  if (resultMatch?.[1]) {
    const gatewayUrl = await mapProbePreviewValueToGatewayUrl(resultMatch[1], request, taskId, 0);
    if (gatewayUrl) {
      return {
        url: gatewayUrl,
        note: '图片已转存为本站预览地址，SSE 响应中的图片内容已省略。',
      };
    }
    return {
      note: '本次探测已在 SSE 事件中拿到 Base64 图片，内容已省略。',
    };
  }
  const httpUrlMatch = normalized.match(/https?:\/\/[^\s"']+/);
  if (httpUrlMatch?.[0] && !httpUrlMatch[0].includes('/v1/responses')) {
    const gatewayUrl = await mapProbePreviewValueToGatewayUrl(httpUrlMatch[0], request, taskId, 0);
    if (gatewayUrl) {
      return {
        url: gatewayUrl,
        note: '图片已转存为本站预览地址，SSE 响应中的图片内容已省略。',
      };
    }
  }
  return {};
}

function buildRequestBodyPreview(entry: ProbeTraceEntry) {
  if (!entry.request.body) {
    return '';
  }
  return JSON.stringify(redactImagePayload(entry.request.body), null, 2);
}

function pickRelevantSseEventData(event: { event: string; dataText: string; dataJson?: unknown }) {
  const eventName = String(event.event || '').trim();
  const data = event.dataJson;
  if (data && typeof data === 'object') {
    const record = data as Record<string, unknown>;
    const item = record.item && typeof record.item === 'object' ? record.item as Record<string, unknown> : null;
    const response = record.response && typeof record.response === 'object' ? record.response as Record<string, unknown> : null;
    const output = Array.isArray(response?.output) ? response.output as Array<Record<string, unknown>> : [];
    if (item?.type === 'image_generation_call') {
      return {
        event: eventName,
        data: redactImagePayload(item),
      };
    }
    if (eventName === 'response.completed') {
      const imageOutput = output.filter((entry) => entry?.type === 'image_generation_call');
      if (imageOutput.length) {
        return {
          event: eventName,
          data: redactImagePayload({ output: imageOutput }),
        };
      }
    }
    if (eventName === 'response.image_generation_call.partial_image') {
      return {
        event: eventName,
        data: redactImagePayload(record),
      };
    }
  }
  return null;
}

function buildResponseBodyPreview(entry: ProbeTraceEntry) {
  if (entry.response.bodyJson !== undefined) {
    return JSON.stringify(redactImagePayload(entry.response.bodyJson), null, 2);
  }
  const bodyText = String(entry.response.bodyText || '').trim();
  if (!bodyText) {
    return '';
  }
  const sseEvents = parseSseEvents(bodyText);
  if (sseEvents.length) {
    const chatSse = extractChatCompletionSseText(bodyText);
    if (chatSse.content) {
      return JSON.stringify({
        type: 'chat_completions_sse',
        finishReason: chatSse.finishReason || undefined,
        done: chatSse.done,
        usage: chatSse.usage,
        content: formatTextPreview(chatSse.content, 8_000),
      }, null, 2);
    }
    const structured = sseEvents
      .map((item) => pickRelevantSseEventData(item))
      .filter((item): item is { event: string; data: unknown } => Boolean(item));
    if (!structured.length) {
      return '';
    }
    return JSON.stringify(structured, null, 2);
  }
  const maybeJson = tryParseJson(bodyText);
  if (maybeJson !== undefined) {
    return JSON.stringify(redactImagePayload(maybeJson), null, 2);
  }
  return bodyText
    .replace(/data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=\s]+/g, '<image payload omitted>')
    .replace(/"partial_image_b64"\s*:\s*"([A-Za-z0-9+/=\s]{64,})"/g, '"partial_image_b64":"<image payload omitted>"')
    .replace(/"b64_json"\s*:\s*"([A-Za-z0-9+/=\s]{64,})"/g, '"b64_json":"<image payload omitted>"')
    .replace(/"result"\s*:\s*"([A-Za-z0-9+/=\s]{64,})"/g, '"result":"<image payload omitted>"');
}

function summarizeRelevantSseEventNames(bodyText: string) {
  const names = new Set<string>();
  for (const event of parseSseEvents(bodyText)) {
    if (event.event === 'response.created' || event.event === 'response.completed') {
      names.add(event.event);
      continue;
    }
    if (pickRelevantSseEventData(event)) {
      names.add(event.event || 'message');
    }
  }
  return Array.from(names);
}

function getJsonRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function findFirstImageRecord(node: unknown): Record<string, unknown> | null {
  if (Array.isArray(node)) {
    for (const item of node) {
      const matched = findFirstImageRecord(item);
      if (matched) {
        return matched;
      }
    }
    return null;
  }
  const record = getJsonRecord(node);
  if (!record) {
    return null;
  }
  if (
    typeof record.url === 'string'
    || typeof record.b64_json === 'string'
    || typeof record.result === 'string'
    || typeof record.partial_image_b64 === 'string'
  ) {
    return record;
  }
  for (const value of Object.values(record)) {
    const matched = findFirstImageRecord(value);
    if (matched) {
      return matched;
    }
  }
  return null;
}

function detectPngInfo(buffer: Buffer) {
  if (buffer.length < 26 || !buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]))) {
    return null;
  }
  const colorType = buffer[25];
  return {
    format: 'png',
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
    hasAlpha: colorType === 4 || colorType === 6,
  };
}

function detectJpegInfo(buffer: Buffer) {
  if (buffer.length < 4 || buffer[0] !== 0xFF || buffer[1] !== 0xD8) {
    return null;
  }
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xFF) {
      offset += 1;
      continue;
    }
    const marker = buffer[offset + 1];
    const length = buffer.readUInt16BE(offset + 2);
    if (length < 2) {
      break;
    }
    if (
      marker === 0xC0 || marker === 0xC1 || marker === 0xC2 || marker === 0xC3
      || marker === 0xC5 || marker === 0xC6 || marker === 0xC7
      || marker === 0xC9 || marker === 0xCA || marker === 0xCB
      || marker === 0xCD || marker === 0xCE || marker === 0xCF
    ) {
      return {
        format: 'jpeg',
        width: buffer.readUInt16BE(offset + 7),
        height: buffer.readUInt16BE(offset + 5),
        hasAlpha: false,
      };
    }
    offset += 2 + length;
  }
  return { format: 'jpeg', hasAlpha: false };
}

function detectWebpInfo(buffer: Buffer) {
  if (
    buffer.length < 16
    || buffer.subarray(0, 4).toString('ascii') !== 'RIFF'
    || buffer.subarray(8, 12).toString('ascii') !== 'WEBP'
  ) {
    return null;
  }
  const chunk = buffer.subarray(12, 16).toString('ascii');
  if (chunk === 'VP8X' && buffer.length >= 30) {
    const flags = buffer[20];
    return {
      format: 'webp',
      width: 1 + buffer.readUIntLE(24, 3),
      height: 1 + buffer.readUIntLE(27, 3),
      hasAlpha: Boolean(flags & 0x10),
    };
  }
  if (chunk === 'VP8 ' && buffer.length >= 30) {
    return {
      format: 'webp',
      width: buffer.readUInt16LE(26) & 0x3fff,
      height: buffer.readUInt16LE(28) & 0x3fff,
      hasAlpha: false,
    };
  }
  if (chunk === 'VP8L' && buffer.length >= 25) {
    const b0 = buffer[21];
    const b1 = buffer[22];
    const b2 = buffer[23];
    const b3 = buffer[24];
    return {
      format: 'webp',
      width: 1 + (((b1 & 0x3f) << 8) | b0),
      height: 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)),
      hasAlpha: true,
    };
  }
  return { format: 'webp' };
}

function inspectProbeImageBuffer(buffer: Buffer) {
  return detectPngInfo(buffer) || detectJpegInfo(buffer) || detectWebpInfo(buffer) || {
    format: probeDetectImageExtensionFromBuffer(buffer),
  };
}

type ProbeImageInspection = {
  source: string;
  declaredUrl: string;
  byteLength: number;
  format?: string;
  width?: number;
  height?: number;
  hasAlpha?: boolean;
  note?: string;
};

async function inspectProbeImageOutput(entry: ProbeTraceEntry): Promise<ProbeImageInspection | null> {
  const imageRecord = findFirstImageRecord(entry.response.bodyJson);
  if (!imageRecord) {
    return null;
  }
  let source = '';
  let buffer: Buffer | null = null;
  let declaredUrl = '';
  if (typeof imageRecord.url === 'string') {
    source = 'url';
    declaredUrl = imageRecord.url;
    try {
      const response = await fetch(imageRecord.url);
      if (response.ok) {
        buffer = Buffer.from(await response.arrayBuffer());
      }
    } catch {
      buffer = null;
    }
  } else if (typeof imageRecord.b64_json === 'string') {
    source = 'b64_json';
    const decoded = probeDecodeImagePayload(imageRecord.b64_json);
    buffer = decoded?.buffer || null;
  } else if (typeof imageRecord.result === 'string') {
    source = 'result';
    const decoded = probeDecodeImagePayload(imageRecord.result);
    buffer = decoded?.buffer || null;
  } else if (typeof imageRecord.partial_image_b64 === 'string') {
    source = 'partial_image_b64';
    const decoded = probeDecodeImagePayload(imageRecord.partial_image_b64);
    buffer = decoded?.buffer || null;
  }
  if (!buffer) {
    return {
      source,
      declaredUrl,
      byteLength: 0,
      note: '已识别图片输出字段，但未能下载或解码图片字节。',
    } satisfies ProbeImageInspection;
  }
  return {
    source,
    declaredUrl,
    byteLength: buffer.byteLength,
    ...inspectProbeImageBuffer(buffer),
  } satisfies ProbeImageInspection;
}

function extractResponseEchoLines(entry: ProbeTraceEntry) {
  const lines: string[] = [];
  const body = getJsonRecord(entry.response.bodyJson);
  if (!body) {
    return lines;
  }
  const responseKeys = Object.keys(body);
  if (responseKeys.length) {
    lines.push(`响应顶层字段：${responseKeys.join('、')}`);
  }
  const requestBody = getJsonRecord(entry.request.body);
  for (const key of ['model', 'size', 'quality', 'output_format'] as const) {
    if (body[key] !== undefined) {
      const requested = requestBody?.[key];
      lines.push(`字段回显 ${key}：请求=${requested === undefined ? '未提交' : String(requested)}，响应=${String(body[key])}`);
    }
  }
  if (body.created !== undefined) {
    lines.push(`上游 created：${String(body.created)}`);
  }
  const imageRecord = findFirstImageRecord(body);
  if (imageRecord) {
    const imageKeys = Object.keys(imageRecord);
    lines.push(`图片结果字段：${imageKeys.join('、')}`);
    if (typeof imageRecord.revised_prompt === 'string') {
      lines.push(`上游返回 revised_prompt：${imageRecord.revised_prompt.slice(0, 160)}`);
    }
  }
  return lines;
}

function extractHeaderAnalysisLines(entry: ProbeTraceEntry) {
  const headers = entry.response.headers || {};
  const lines: string[] = [];
  const requestId = String(headers['x-request-id'] || headers['x-client-request-id'] || '').trim();
  if (requestId) {
    lines.push(`上游请求 ID：${requestId}`);
  }
  for (const key of ['content-type', 'content-encoding', 'transfer-encoding', 'content-length'] as const) {
    const value = String(headers[key] || '').trim();
    if (value) {
      lines.push(`响应头 ${key}：${value}`);
    }
  }
  return lines;
}

async function buildProbeAnalysisLines(entry: ProbeTraceEntry) {
  const lines: string[] = [];
  const body = getJsonRecord(entry.request.body);
  if (body) {
    lines.push(`请求字段覆盖：${Object.keys(body).join('、')}`);
  }
  lines.push(...extractHeaderAnalysisLines(entry));
  lines.push(...extractResponseEchoLines(entry));
  const imageInfo = await inspectProbeImageOutput(entry);
  if (imageInfo) {
    const dimensions = imageInfo.width && imageInfo.height ? `${imageInfo.width}x${imageInfo.height}` : '未识别';
    lines.push(`图片实测：来源=${imageInfo.source || '未知'}，真实格式=${imageInfo.format || '未知'}，尺寸=${dimensions}，透明通道=${imageInfo.hasAlpha === undefined ? '未识别' : imageInfo.hasAlpha ? '有' : '无'}，字节=${imageInfo.byteLength}`);
    if (imageInfo.declaredUrl && !String(imageInfo.declaredUrl).toLowerCase().includes(`.${String(imageInfo.format || '').toLowerCase()}`)) {
      lines.push(`注意：图片 URL 后缀与真实文件签名可能不一致，URL=${imageInfo.declaredUrl.slice(0, 160)}`);
    }
    if (imageInfo.note) {
      lines.push(imageInfo.note);
    }
  }
  if (body?.partial_images !== undefined && !JSON.stringify(entry.response.bodyJson || {}).includes('partial')) {
    lines.push('未验证：请求提交了 partial_images，但本次响应未出现中间图字段或中间图事件。');
  }
  if (body?.background !== undefined) {
    lines.push('未验证：background 是否生效需要结合实际图片透明通道/背景内容判断，不能只靠响应 JSON。');
  }
  if (body?.output_compression !== undefined || body?.output_quality !== undefined) {
    lines.push('未验证：压缩率/质量参数通常不会在响应中回执，需要比较实际图片字节大小或质量。');
  }
  if (body?.moderation !== undefined) {
    lines.push('未验证：moderation 策略通常不会在成功响应中回执，只能证明上游未拒绝该字段。');
  }
  return lines;
}

async function summarizeProbeResponse(entry: ProbeTraceEntry, request?: FastifyRequest) {
  const lines: string[] = [];
  const statusCode = entry.response.statusCode;
  lines.push(`HTTP 状态：${statusCode === null ? '未收到响应' : statusCode}`);
  const contentType = String(entry.response.headers?.['content-type'] || '').trim();
  if (contentType) {
    lines.push(`响应类型：${contentType}`);
  }
  const bodyText = String(entry.response.bodyText || '').trim();
  const chatSse = bodyText ? extractChatCompletionSseText(bodyText) : null;
  if (chatSse?.content) {
    lines.push(`响应内容：${formatTextPreview(chatSse.content, 360)}`);
    if (chatSse.finishReason || chatSse.done) {
      lines.push(`SSE 完整性：finish_reason=${chatSse.finishReason || '未回执'}，DONE=${chatSse.done ? '是' : '否'}`);
    }
  }
  const relevantSseEvents = bodyText ? summarizeRelevantSseEventNames(bodyText) : [];
  if (!chatSse?.content && relevantSseEvents.length) {
    lines.push(`关键事件：${relevantSseEvents.join('、')}`);
  } else if (!chatSse?.content && bodyText) {
    const flattened = bodyText.replace(/\s+/g, ' ').trim();
    if (flattened) {
      lines.push(`响应摘要：${flattened.slice(0, 180)}`);
    }
  }
  const taskId = `probe_${entry.key}_${crypto.randomBytes(4).toString('hex')}`;
  const preview = await extractPreviewImageFromPayload(entry.response.bodyJson, request, taskId);
  const ssePreview = !preview.url && !preview.note ? await extractPreviewImageFromSseText(entry.response.bodyText, request, taskId) : {};
  if (preview.url || ssePreview.url) {
    lines.push('结果图片：已提取并转存为本站预览地址。');
  } else if (preview.note || ssePreview.note) {
    lines.push('结果图片：已识别到图片内容，界面中会以预览或说明展示。');
  }
  return {
    lines,
    analysisLines: await buildProbeAnalysisLines(entry),
    previewImageUrl: preview.url || ssePreview.url,
    previewImageNote: preview.note || ssePreview.note,
    responseBodyPreview: buildResponseBodyPreview(entry),
  };
}

async function buildProbeLogEntryFromTrace(
  traceEntry: ProbeTraceEntry,
  request?: FastifyRequest,
): Promise<OnboardingProbeLogEntry> {
  const responseSummary = await summarizeProbeResponse(traceEntry, request);
  return {
    key: traceEntry.key,
    title: traceEntry.label,
    status: traceEntry.check.ok ? 'success' : 'failed',
    requestLines: summarizeProbeRequest(traceEntry),
    responseLines: responseSummary.lines,
    analysisLines: responseSummary.analysisLines,
    requestBodyPreview: buildRequestBodyPreview(traceEntry),
    responseBodyPreview: responseSummary.responseBodyPreview,
    previewImageUrl: responseSummary.previewImageUrl,
    previewImageNote: responseSummary.previewImageNote,
  };
}

async function buildOnboardingProbeLog(
  input: OnboardingAnalyzeInput,
  warnings: string[],
  recommendations: string[],
  traceEntries: ProbeTraceEntry[],
  request?: FastifyRequest,
) {
  const entries: OnboardingProbeLogEntry[] = [];
  const inputAddresses = input.targetKind === 'images_endpoint'
    ? [input.imagesGenerationUrl, input.imagesEditUrl].filter(Boolean).map((value) => String(value))
    : [String(input.baseUrl || '')].filter(Boolean);
  const normalizedEntry: OnboardingProbeLogEntry = {
    key: 'normalized_base',
    title: '地址确认',
    status: 'info',
    requestLines: [
      `输入地址：${inputAddresses.join(' | ') || '未填写'}`,
      `目标接口类型：${input.targetKind || 'images_endpoint'}`,
    ],
    responseLines: [
      '系统按原样保留你填写的接入地址；真正发请求时只做最小的路径去重，避免重复拼接已完整填写的终端路径。',
    ],
  };
  entries.push(normalizedEntry);

  if (input.referenceImageUrl) {
    const referenceWarning = warnings.find((item) => item.includes('参考图'));
    const referenceRecommendation = recommendations.find((item) => item.includes('参考图'));
    const referenceEntry: OnboardingProbeLogEntry = {
      key: 'reference_image_check',
      title: '参考图校验',
      status: referenceWarning ? 'warning' : 'success',
      requestLines: [`参考图地址：${input.referenceImageUrl}`],
      responseLines: [referenceWarning || referenceRecommendation || '未执行参考图校验。'],
    };
    entries.push(referenceEntry);
  }

  for (const traceEntry of traceEntries) {
    entries.push(await buildProbeLogEntryFromTrace(traceEntry, request));
  }

  return entries;
}

function uniqueLines(lines: string[]) {
  return Array.from(new Set(lines.map((line) => String(line || '').trim()).filter(Boolean)));
}

function collectRequestedFields(traceEntries: ProbeTraceEntry[]) {
  const fields = new Set<string>();
  for (const entry of traceEntries) {
    const body = getJsonRecord(entry.request.body);
    if (!body) {
      continue;
    }
    for (const key of Object.keys(body)) {
      fields.add(key);
    }
  }
  return Array.from(fields);
}

function buildProbeAnalysisReport(input: OnboardingAnalyzeInput, probe: OnboardingProbeResult, traceEntries: ProbeTraceEntry[], probeLog: OnboardingProbeLogEntry[]): OnboardingProbeAnalysisReport {
  const allAnalysisLines = uniqueLines(probeLog.flatMap((entry) => entry.analysisLines || []));
  const requestedFields = collectRequestedFields(traceEntries);
  const relevantImageTraceEntries = traceEntries.filter((entry) => (
    probe.recommendedKind === 'responses_endpoint'
      ? entry.key.includes('responses_')
      : entry.key.includes('images_')
  ));
  const actualImageResponseFormats = collectActualImageResponseFormatsFromTraceEntries(relevantImageTraceEntries);
  const actualHttpImageUrlObserved = collectActualHttpImageUrlSupportFromTraceEntries(relevantImageTraceEntries);
  const confirmed: string[] = [];
  const needsAttention: string[] = [];
  const submittedButUnverified: string[] = [];
  const responseEchoes: string[] = [];
  const imageDiagnostics: string[] = [];
  const savedDiagnostics: string[] = [];
  const suggestedNextSteps: string[] = [];

  if (probe.checks.some((item) => item.key.includes('images_generations_post') && item.ok)) {
    confirmed.push('已确认文生图 generations 接口可用，并且返回了可识别的最终图片。');
  }
  if (probe.checks.some((item) => item.key.includes('images_edits_post') && item.ok)) {
    confirmed.push('Confirmed: images edits succeeded.');
  }
  if (probe.checks.some((item) => item.key.includes('images_edits_post_multipart') && item.ok)) {
    confirmed.push('Confirmed: multipart/form-data + image file upload works.');
  }
  if (probe.checks.some((item) => item.key.includes('images_edits_post_json_image_url') && item.ok)) {
    confirmed.push('Confirmed: application/json + images[].image_url works with normal URL payloads.');
  }
  if (probe.checks.some((item) => item.key.includes('images_edits_post_json_image_data_url') && item.ok)) {
    confirmed.push('Confirmed: application/json + images[].image_url works with data URL / Base64 payloads.');
  }
  if (actualImageResponseFormats.includes('url')) {
    confirmed.push('Confirmed: at least one successful images response actually returned image URLs.');
  }
  if (actualImageResponseFormats.includes('b64_json')) {
    confirmed.push('Confirmed: at least one successful images response actually returned Base64 image payloads.');
  }
  if (
    probe.checks.some((item) => item.key.includes('format_url') && item.ok)
    && !actualImageResponseFormats.includes('url')
  ) {
    needsAttention.push('A probe request asked for response_format=url, but the successful upstream response did not actually return image URLs.');
  }
  const hasJsonUrlSupport = probe.checks.some((item) => item.key.includes('images_edits_post_json_image_url') && item.ok);
  const hasJsonDataUrlSupport = probe.checks.some((item) => item.key.includes('images_edits_post_json_image_data_url') && item.ok);
  if (hasJsonUrlSupport && hasJsonDataUrlSupport) {
    confirmed.push('Confirmed: JSON edits can accept both public image URLs and data URL / Base64 references.');
  } else if (hasJsonDataUrlSupport && !hasJsonUrlSupport) {
    needsAttention.push('JSON edits passed only with data URL / Base64 references; plain public URLs were not proven.');
  } else if (hasJsonUrlSupport && !hasJsonDataUrlSupport) {
    needsAttention.push('JSON edits passed with public image URLs, but data URL / Base64 references were not proven.');
  }

  for (const line of allAnalysisLines) {
    if (line.startsWith('字段回显') || line.startsWith('响应顶层字段') || line.startsWith('图片结果字段') || line.startsWith('上游 created')) {
      responseEchoes.push(line);
    } else if (line.startsWith('图片实测') || line.includes('图片 URL 后缀') || line.includes('真实文件签名')) {
      imageDiagnostics.push(line);
    } else if (line.startsWith('上游请求 ID') || line.startsWith('响应头')) {
      savedDiagnostics.push(line);
    } else if (line.startsWith('未验证')) {
      submittedButUnverified.push(line);
    } else if (line.startsWith('请求字段覆盖')) {
      savedDiagnostics.push(line);
    }
  }

  const inputRequestedFields = [
    input.model ? 'model' : '',
    input.prompt ? 'prompt' : '',
    input.size ? 'size' : '',
    input.quality ? 'quality' : '',
    input.outputFormat ? 'output_format' : '',
    input.outputCompression !== undefined ? 'output_compression' : '',
    input.background && input.background !== 'omit' ? 'background' : '',
    input.moderation && input.moderation !== 'omit' ? 'moderation' : '',
    input.partialImages !== undefined ? 'partial_images' : '',
    input.stream !== undefined ? 'stream' : '',
    input.n !== undefined ? 'n' : '',
  ].filter(Boolean);

  if (inputRequestedFields.length) {
    savedDiagnostics.unshift(`本次探测配置覆盖字段：${inputRequestedFields.join('、')}`);
  }
  if (requestedFields.length) {
    savedDiagnostics.unshift(`实际请求字段合集：${requestedFields.join('、')}`);
  }

  if (actualImageResponseFormats.length) {
    savedDiagnostics.unshift(`Actual images response formats observed: ${actualImageResponseFormats.join(', ')}`);
  }
  if (probe.recommendedKind === 'responses_endpoint') {
    savedDiagnostics.unshift(`Direct upstream public image URL observed in successful response: ${actualHttpImageUrlObserved ? 'yes' : 'no'}`);
  }

  if (input.partialImages !== undefined) {
    suggestedNextSteps.push('如需确认中间图能力，建议继续保留 SSE 探测，并检查是否出现 partial image 事件或字段。');
  }
  if (input.background && input.background !== 'omit') {
    suggestedNextSteps.push('如需确认透明背景能力，建议自动下载结果图并校验真实 alpha 通道；仅响应 JSON 不足以证明 background 生效。');
  }
  if (input.outputCompression !== undefined) {
    suggestedNextSteps.push('如需确认压缩率生效，建议比较不同 output_compression 下的真实文件大小和文件签名。');
  }
  if (input.moderation && input.moderation !== 'omit') {
    suggestedNextSteps.push('moderation 成功响应通常不会回执策略，当前只能确认该字段未导致请求失败。');
  }
  if (!suggestedNextSteps.length) {
    suggestedNextSteps.push('当前基础协议已通过；如要验证更细参数，请在探测参数中启用对应选项后重新探测。');
  }

  for (const line of imageDiagnostics) {
    if (line.includes('真实格式=png') && input.outputFormat === 'webp') {
      needsAttention.push('请求 output_format=webp，但图片实测可能是 PNG 字节，请重点确认该上游是否真实按格式输出。');
    }
    if (line.includes('透明通道=无') && input.background === 'transparent') {
      needsAttention.push('请求 background=transparent，但实测图片未识别到透明通道，可能不支持透明背景或本次内容未产生透明区域。');
    }
  }

  if (!needsAttention.length && submittedButUnverified.length) {
    needsAttention.push('部分参数已提交但响应未提供回执，报告中已单独列出，建议不要把它们直接视为已确认能力。');
  }

  return {
    title: '接入探测分析报告',
    summary: probe.ok
      ? '该上游已通过基础协议探测；以下报告区分“已确认能力”和“已提交但未证明的参数”。'
      : '该上游未完全通过基础协议探测；请优先查看失败请求、响应摘要和注意事项。',
    confirmed: uniqueLines(confirmed),
    needsAttention: uniqueLines(needsAttention),
    submittedButUnverified: uniqueLines(submittedButUnverified),
    responseEchoes: uniqueLines(responseEchoes),
    imageDiagnostics: uniqueLines(imageDiagnostics),
    savedDiagnostics: uniqueLines(savedDiagnostics),
    suggestedNextSteps: uniqueLines(suggestedNextSteps),
  };
}

export async function analyzeOnboardingInput(
  input: OnboardingAnalyzeInput,
  request?: FastifyRequest,
  onProgress?: OnboardingProbeProgressReporter,
  onTraceComplete?: (traceEntry: ProbeTraceEntry) => Promise<void> | void,
) {
  const warnings: string[] = [];
  const recommendations: string[] = [];
  let referenceImageDataUrl = '';
  const normalizedEntry: OnboardingProbeLogEntry = {
    key: 'normalized_base',
    title: '地址确认',
    status: 'info',
    requestLines: [
      `输入地址：${input.targetKind === 'images_endpoint'
        ? [input.imagesGenerationUrl, input.imagesEditUrl].filter(Boolean).join(' | ') || '未填写'
        : (input.baseUrl || '未填写')}`,
      `目标接口类型：${input.targetKind || 'images_endpoint'}`,
    ],
    responseLines: [
      '系统按原样保留你填写的接入地址；真正发请求时只做最小的路径去重，避免重复拼接已完整填写的终端路径。',
    ],
  };
  onProgress?.(normalizedEntry, '已确认输入地址，准备执行后续探测。');

  if ((input.targetKind === 'responses_endpoint' || input.targetKind === 'images_endpoint') && input.referenceImageUrl) {
    try {
      const referenceResponse = await fetch(input.referenceImageUrl);
      if (!referenceResponse.ok) {
        warnings.push(`参考图 URL 无法访问：HTTP ${referenceResponse.status}`);
      } else {
        const mime = String(referenceResponse.headers.get('content-type') || 'application/octet-stream')
          .split(';')[0]
          .trim() || 'application/octet-stream';
        const buffer = Buffer.from(await referenceResponse.arrayBuffer());
        referenceImageDataUrl = `data:${mime};base64,${buffer.toString('base64')}`;
        recommendations.push(`参考图已验证可访问，大小 ${buffer.byteLength} 字节。`);
      }
    } catch (error) {
      warnings.push(`参考图 URL 校验失败：${error instanceof Error ? error.message : 'unknown error'}`);
    }
    const referenceWarning = warnings.find((item) => item.includes('参考图'));
    const referenceRecommendation = recommendations.find((item) => item.includes('参考图'));
    onProgress?.({
      key: 'reference_image_check',
      title: '参考图校验',
      status: referenceWarning ? 'warning' : 'success',
      requestLines: [`参考图地址：${input.referenceImageUrl}`],
      responseLines: [referenceWarning || referenceRecommendation || '未执行参考图校验。'],
    }, '参考图校验完成，开始执行图像探测任务。');
  }

  const probe = await probeUpstream({
    ...input,
    customBodyFields: sanitizeInjectedBodyFieldsForKind(input.targetKind || 'images_endpoint', input.customBodyFields),
    referenceImageDataUrl,
    baseUrl: input.baseUrl,
    apiKey: input.apiKey || '',
    targetKind: input.targetKind || 'images_endpoint',
    onTraceComplete: async (traceEntry) => {
      if (onTraceComplete) {
        await onTraceComplete(traceEntry);
      }
      const taskEntry = await buildProbeLogEntryFromTrace(traceEntry, request);
      onProgress?.(taskEntry, `${traceEntry.label} 已完成。`);
    },
  });

  if (!probe.attempted) {
    warnings.push('未提供 API 密钥，本次只确认了输入地址，没有执行真实探测。');
  } else if (!probe.ok) {
    warnings.push(`真实探测未能确认可用接口。${probe.summary}`);
  } else {
    recommendations.push(`探测已确认以下接口类型：${probe.detectedKinds.join('、')}。`);
  }

  const { traceEntries, ...clientProbe } = probe;
  const upstreamDraft = buildDetectedUpstreamDraft(input, clientProbe, traceEntries);
  const probeLog = await buildOnboardingProbeLog(input, warnings, recommendations, traceEntries, request);
  const probeReport = buildProbeAnalysisReport(input, clientProbe, traceEntries, probeLog);
  const channelDraft: ConsoleChannel = upstreamDraft.kind === 'chat_completions'
    ? {
        id: 'channel_text_processing',
        name: '文本处理',
        businessType: 'text_processing',
        acceptedUpstreamKinds: ['chat_completions'],
        upstreamIds: [],
        upstreamPolicies: [],
        enabled: true,
        displayOrder: 20,
        notes: '',
      }
    : {
        id: 'channel_image_generation',
        name: '图像生成',
        businessType: 'image_generation',
        acceptedUpstreamKinds: ['images_endpoint', 'responses_endpoint'],
        upstreamIds: [],
        upstreamPolicies: [],
        enabled: true,
        displayOrder: 10,
        notes: '',
      };

  return {
    detectedKind: upstreamDraft.kind,
    upstreamDraft,
    channelDraft,
    warnings,
    recommendations,
    probe: clientProbe,
    probeLog,
    probeReport,
    probeTraceEntries: traceEntries,
  };
}

async function readProbeResponseText(
  response: Response,
  controller: AbortController,
  preferSsePreview: boolean,
) {
  const contentType = String(response.headers.get('content-type') || '').toLowerCase();
  if (!preferSsePreview || !contentType.includes('text/event-stream') || !response.body) {
    return response.text().catch(() => '');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let responseText = '';
  const previewTimer = setTimeout(() => controller.abort(), DEFAULT_SSE_PROBE_SUCCESS_TIMEOUT_MS);
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      responseText += decoder.decode(value, { stream: true });
      if (responseText.length > DEFAULT_PROBE_RESPONSE_MAX_BYTES) {
        controller.abort();
        break;
      }
    }
  } catch {
    // Aborting after a useful SSE preview is expected and should not fail the probe.
  } finally {
    clearTimeout(previewTimer);
    try {
      reader.releaseLock();
    } catch {
      // Ignore stream cleanup errors after abort.
    }
  }
  return responseText;
}

function summarizeProbeResponseText(responseText: string) {
  const chatSse = extractChatCompletionSseText(responseText);
  if (chatSse.content) {
    const suffix = chatSse.finishReason || chatSse.done
      ? `（finish_reason=${chatSse.finishReason || '未回执'}，DONE=${chatSse.done ? '是' : '否'}）`
      : '';
    return `SSE Chat 内容：${formatTextPreview(chatSse.content, 200)}${suffix}`;
  }
  const normalized = String(responseText || '').replace(/\s+/g, ' ').trim();
  const maxLength = 200;
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength)}...（摘要已截断，完整响应请查看对应 probe-detail 请求追踪）`;
}

function evaluateResponsesImageProbe(bodyText: string) {
  const events = parseSseEvents(bodyText);
  if (!events.length) {
    return {
      ok: false,
      reason: '未解析到任何 SSE 事件。',
    };
  }

  for (const event of events) {
    if (event.event === 'response.image_generation_call.partial_image') {
      return {
        ok: true,
        reason: '已捕获 partial_image 事件。',
      };
    }
    if (event.dataJson && typeof event.dataJson === 'object') {
      const data = event.dataJson as Record<string, unknown>;
      const item = data.item && typeof data.item === 'object'
        ? data.item as Record<string, unknown>
        : null;
      if (item?.type === 'image_generation_call') {
        return {
          ok: true,
          reason: '已捕获 image_generation_call 输出项。',
        };
      }

      const response = data.response && typeof data.response === 'object'
        ? data.response as Record<string, unknown>
        : null;
      const output = Array.isArray(response?.output) ? response?.output as Array<Record<string, unknown>> : [];
      if (output.some((entry) => entry && entry.type === 'image_generation_call')) {
        return {
          ok: true,
          reason: 'response.completed 中包含 image_generation_call。',
        };
      }
    }
  }

  return {
    ok: false,
    reason: '收到 200/SSE，但没有看到 image_generation_call，当前返回更像普通文本 Responses 结果。',
  };
}

function evaluateResponsesImageProbeFromResult(input: { bodyText: string; bodyJson?: unknown }) {
  const bodyRecord = getJsonRecord(input.bodyJson);
  const topLevelOutput = Array.isArray(bodyRecord?.output) ? bodyRecord.output as Array<Record<string, unknown>> : [];
  if (topLevelOutput.some((entry) => entry && entry.type === 'image_generation_call')) {
    return {
      ok: true,
      reason: '已在 JSON 响应中识别到 image_generation_call 输出项。',
    };
  }
  if (findFirstImageRecord(input.bodyJson)) {
    return {
      ok: true,
      reason: '已在 JSON 响应中识别到图像结果字段。',
    };
  }
  const imageGenUsage = bodyRecord?.tool_usage
    && typeof bodyRecord.tool_usage === 'object'
    && bodyRecord.tool_usage !== null
    && 'image_gen' in bodyRecord.tool_usage
    && bodyRecord.tool_usage.image_gen
    && typeof bodyRecord.tool_usage.image_gen === 'object'
    ? bodyRecord.tool_usage.image_gen as Record<string, unknown>
    : null;
  const imageGenTotalTokens = Number(imageGenUsage?.total_tokens || 0);
  const hasAssistantTextOnlyOutput = topLevelOutput.length > 0
    && topLevelOutput.every((entry) => entry && entry.type !== 'image_generation_call');
  if (bodyRecord && imageGenTotalTokens <= 0 && hasAssistantTextOnlyOutput) {
    return {
      ok: false,
      reason: '收到 200/JSON，但 image_generation 工具未真正执行；上游只返回了文本结果。',
    };
  }
  const legacy = evaluateResponsesImageProbe(input.bodyText);
  if (legacy.ok) {
    return legacy;
  }
  if (input.bodyJson !== undefined) {
    return {
      ok: false,
      reason: '收到 200/JSON，但没有看到 image_generation_call，当前返回更像普通文本 Responses 结果。',
    };
  }
  return legacy;
}

async function evaluateImagesOutputProbe(input: {
  bodyJson?: unknown;
  bodyText: string;
  request?: FastifyRequest;
  taskId: string;
}) {
  const preview = await extractPreviewImageFromPayload(input.bodyJson, input.request, input.taskId);
  if (preview.url) {
    return {
      ok: true,
      reason: '已识别到真实图片输出。',
    };
  }
  const ssePreview = await extractPreviewImageFromSseText(input.bodyText, input.request, input.taskId);
  if (ssePreview.url) {
    return {
      ok: true,
      reason: '已识别到真实图片输出。',
    };
  }
  return {
    ok: false,
    reason: '收到响应，但没有识别到可用图片输出。',
  };
}

async function probeCandidate(candidate: ProbeCandidate, apiKey: string): Promise<ProbeExecutionResult> {
  const url = normalizeUrlPath(candidate.baseUrl, candidate.path);
  const bodyFormat = candidate.bodyFormat || 'json';
  const responsesStreamEnabled = candidate.key.startsWith('responses_post')
    ? true
    : false;
  const requestHeaders: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    Accept: candidate.key.startsWith('responses_post') && responsesStreamEnabled ? 'text/event-stream' : 'application/json',
  };
  const maxAttempts = candidate.key.startsWith('responses_post') ? 3 : 1;
  let lastFailure: ProbeExecutionResult | null = null;
  try {
    const requestBody = candidate.method === 'POST'
      ? await buildProbeRequestBody(candidate.body || {}, bodyFormat, requestHeaders)
      : undefined;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), DEFAULT_PROBE_TIMEOUT_MS);
      const response = await fetch(url, {
        method: candidate.method,
        headers: requestHeaders,
        body: requestBody,
        signal: controller.signal,
      });
      const responseText = await readProbeResponseText(response, controller, candidate.key.startsWith('responses_post'));
      clearTimeout(timer);
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
      const responseSummary = responseText ? summarizeProbeResponseText(responseText) : '';

      const exists = isMeaningfulStatus(response.status)
        || looksLikeParameterCompatibilityError(responseText, responseJson);
      const semantic = candidate.key.startsWith('responses_post')
        ? evaluateResponsesImageProbeFromResult({ bodyText: responseText, bodyJson: responseJson })
        : candidate.requireImageOutput
          ? await evaluateImagesOutputProbe({
              bodyJson: responseJson,
              bodyText: responseText,
              taskId: `probe_semantic_${crypto.randomBytes(4).toString('hex')}`,
            })
          : { ok: true, reason: '' };
      const ok = (response.ok || exists) && semantic.ok;
      const summaryParts = [
        responseSummary ? `HTTP ${response.status} - ${responseSummary}` : `HTTP ${response.status}`,
      ];
      if ((candidate.key.startsWith('responses_post') || candidate.requireImageOutput) && semantic.reason) {
        summaryParts.push(semantic.reason);
      }
      if (maxAttempts > 1) {
        summaryParts.push(`attempt ${attempt}/${maxAttempts}`);
      }

      const result: ProbeExecutionResult = {
        check: {
          key: candidate.key,
          label: candidate.label,
          method: candidate.method,
          url,
          exists,
          ok,
          statusCode: response.status,
          summary: summaryParts.join(' | '),
        },
        bodyJson: responseJson,
        request: {
          url,
          method: candidate.method,
          headers: requestHeaders,
          bodyFormat,
          body: candidate.body,
        },
        response: {
          ok: response.ok,
          statusCode: response.status,
          headers: responseHeaders,
          bodyText: responseText,
          bodyJson: responseJson,
        },
      };

      const shouldRetryResponsesProbe = candidate.key.startsWith('responses_post')
        && !ok
        && !response.ok
        && (response.status === 408 || response.status === 429 || response.status >= 500);

      if (ok || attempt >= maxAttempts || !shouldRetryResponsesProbe) {
        return result;
      }
      lastFailure = result;
      await new Promise((resolve) => setTimeout(resolve, 350));
    }
  } catch (error) {
    return {
      check: {
        key: candidate.key,
        label: candidate.label,
        method: candidate.method,
        url,
        exists: false,
        ok: false,
        statusCode: null,
        summary: error instanceof Error ? error.message : '探测失败',
      },
      request: {
        url,
        method: candidate.method,
        headers: requestHeaders,
        bodyFormat,
        body: candidate.body,
      },
      response: {
        ok: false,
        statusCode: null,
        headers: {},
        bodyText: '',
      },
    };
  }
  if (lastFailure) {
    return lastFailure;
  }
  return {
    check: {
      key: candidate.key,
      label: candidate.label,
      method: candidate.method,
      url,
      exists: false,
      ok: false,
      statusCode: null,
      summary: '探测失败',
    },
    request: {
      url,
      method: candidate.method,
      headers: requestHeaders,
      bodyFormat,
      body: candidate.body,
    },
    response: {
      ok: false,
      statusCode: null,
      headers: {},
      bodyText: '',
    },
  };
}
function probeDetectImageExtensionFromBuffer(buffer: Buffer) {
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

function probeDetectKnownImageExtensionFromBuffer(buffer: Buffer) {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]))) {
    return 'png';
  }
  if (buffer.length >= 3 && buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) {
    return 'jpg';
  }
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') {
    return 'webp';
  }
  return '';
}

function resolveValidatedProbeImageBuffer(buffer: Buffer, declaredExtension?: string) {
  const detectedExtension = probeDetectKnownImageExtensionFromBuffer(buffer);
  if (!detectedExtension) {
    return null;
  }
  const normalizedDeclaredExtension = String(declaredExtension || '').trim().toLowerCase();
  const normalizedExtension = normalizedDeclaredExtension === 'jpeg' ? 'jpg' : normalizedDeclaredExtension;
  return {
    buffer,
    extension: normalizedExtension || detectedExtension,
  };
}

function probeContentTypeForExtension(ext: string) {
  if (ext === 'jpg' || ext === 'jpeg') {
    return 'image/jpeg';
  }
  if (ext === 'webp') {
    return 'image/webp';
  }
  return 'image/png';
}

function probeDecodeImagePayload(value: string) {
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
      extension: probeDetectImageExtensionFromBuffer(buffer),
    };
  }
  return null;
}

async function buildProbeMultipartFilePart(value: string) {
  const raw = String(value || '').trim();
  if (!raw) {
    return null;
  }
  if (/^https?:\/\//i.test(raw)) {
    const response = await fetch(raw);
    if (!response.ok) {
      throw new Error(`Failed to fetch multipart probe image: HTTP ${response.status}`);
    }
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const extension = probeDetectImageExtensionFromBuffer(buffer);
    return {
      blob: new Blob([buffer], { type: probeContentTypeForExtension(extension) }),
      fileName: `reference.${extension}`,
    };
  }
  const decoded = probeDecodeImagePayload(raw);
  if (!decoded) {
    return null;
  }
  return {
    blob: new Blob([decoded.buffer], { type: probeContentTypeForExtension(decoded.extension) }),
    fileName: `reference.${decoded.extension}`,
  };
}

async function buildProbeRequestBody(
  body: Record<string, unknown>,
  bodyFormat: 'json' | 'multipart',
  headers: Record<string, string>,
) {
  if (bodyFormat === 'json') {
    headers['Content-Type'] = 'application/json';
    return JSON.stringify(body);
  }

  const form = new FormData();
  for (const [key, value] of Object.entries(body || {})) {
    if (value === undefined || value === null) {
      continue;
    }
    if (key === 'image') {
      const values = Array.isArray(value) ? value : [value];
      for (const item of values) {
        if (typeof item === 'string') {
          const part = await buildProbeMultipartFilePart(item);
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

async function probeUpstream(input: OnboardingAnalyzeInput & {
  apiKey: string;
  targetKind: ConsoleUpstreamKind;
  referenceImageDataUrl?: string;
  onTraceComplete?: (traceEntry: ProbeTraceEntry) => Promise<void> | void;
}): Promise<OnboardingProbeResult & { traceEntries: ProbeTraceEntry[] }> {
  const normalizedBaseCandidates = input.targetKind === 'images_endpoint'
    ? [input.imagesGenerationUrl, input.imagesEditUrl].map((value) => String(value || '').trim()).filter(Boolean)
    : normalizeProbeBaseCandidates(input.baseUrl || '');
  const probeBaseCandidates = input.targetKind === 'images_endpoint'
    ? ['']
    : normalizedBaseCandidates;
  if (!String(input.apiKey || '').trim()) {
    return {
      attempted: false,
      ok: false,
      normalizedBaseCandidates,
      detectedKinds: [],
      recommendedKind: input.targetKind,
      syncSupport: 'unknown',
      checks: [],
      traceEntries: [],
      summary: '未提供 API 密钥，已跳过真实探测。',
    };
  }

  const checks: EndpointProbeCheck[] = [];
  const traceEntries: ProbeTraceEntry[] = [];
  for (const baseCandidate of probeBaseCandidates) {
    const candidates = buildProbeCandidates(baseCandidate, input);
    for (const candidate of candidates) {
      const result = await probeCandidate(candidate, input.apiKey);
      checks.push(result.check);
      const traceEntry: ProbeTraceEntry = {
        key: candidate.key,
        label: candidate.label,
        check: result.check,
        request: result.request,
        response: result.response,
      };
      traceEntries.push(traceEntry);
      if (input.onTraceComplete) {
        await input.onTraceComplete(traceEntry);
      }

    }
  }

  const detectedKinds = inferKindFromChecks(checks).filter((kind) => kind === input.targetKind);
  const recommendedKind = detectedKinds[0] || input.targetKind;
  const ok = detectedKinds.length > 0;
  const syncSupport = checks.some((item) => item.key.includes('_post') && item.ok)
    ? 'likely_supported'
    : 'unknown';

  return {
    attempted: true,
    ok,
    normalizedBaseCandidates,
    detectedKinds,
    recommendedKind,
    syncSupport,
    checks,
    traceEntries,
    summary: ok
      ? `已确认 ${detectedKinds.join('、')}，共命中 ${checks.filter((item) => item.exists).length} 个有效接口响应。`
      : '当前选定的接口类型没有通过探测确认，请检查地址、模型、密钥或上游协议要求。',
  };
}
