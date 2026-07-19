import {
  Alert,
  Button,
  Card,
  Checkbox,
  Col,
  Drawer,
  Form,
  Input,
  InputNumber,
  Popconfirm,
  Row,
  Select,
  Space,
  Switch,
  Table,
  Tabs,
  Typography,
} from 'antd';
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import { BANANA_MODELS } from '@yali/provider-core';
import { useEffect, useMemo, useState } from 'react';
import {
  CodeBlock,
  DrawerFooter,
  EllipsisText,
  PageHeader,
  SectionTitle,
  StatusDot,
} from '../../shared/ui';
import type { StatusTone } from '../../shared/ui';
import type {
  AdminConsoleCatalog,
  BananaAuthMode,
  BananaModelCapability,
  ConsoleUpstream,
  ImageBackgroundMode,
  ImageCapabilityProfile,
  ImageQualityTier,
  ImageToolQuality,
  ModerationMode,
  OutputImageFormat,
  ReasoningEffort,
  ResponseFormat,
  ResponsesInputShape,
  ResponsesModelRouting,
  ResponsesModerationMode,
  ResponsesReturnMode,
  ResponsesToolChoiceFormat,
  ResponsesToolChoiceMode,
  UpstreamTestRequest,
  UpstreamTestPreset,
  UpstreamTestResult,
} from '../../shared/types';

const { Paragraph, Text } = Typography;

const localReferenceImageUrl = `${window.location.origin}/test-assets/reference-test.png`;

type UpstreamsPageProps = {
  catalog: AdminConsoleCatalog | null;
  saving: boolean;
  onSave: (upstream: ConsoleUpstream) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onTest: (upstream: ConsoleUpstream, request: UpstreamTestRequest) => Promise<UpstreamTestResult>;
};

type KeyValueItem = {
  key: string;
  value: string;
};

type FormShape = {
  id: string;
  name: string;
  kind: ConsoleUpstream['kind'];
  baseUrl: string;
  apiKey: string;
  enabled: boolean;
  maxConcurrency: number;
  healthStatus: ConsoleUpstream['healthStatus'];
  modelHintsText: string;
  notes: string;
  injectHeadersList: KeyValueItem[];
  injectBodyFieldsList: KeyValueItem[];
  testOperation: UpstreamTestRequest['operation'];
  testModel: string;
  testImageModel?: string;
  testPrompt: string;
  testSize?: string;
  testQuality?: string;
  testImageToolQuality?: ImageToolQuality;
  testImageQuality?: number;
  testResponseFormat?: ResponseFormat;
  testOutputFormat?: OutputImageFormat;
  testOutputCompression?: number;
  testBackground?: ImageBackgroundMode;
  testStream?: boolean;
  testPartialImages?: number;
  testReferenceImageUrl?: string;
  testResponsesInputShape?: ResponsesInputShape;
  testResponsesToolChoice?: ResponsesToolChoiceMode;
  testResponsesToolChoiceFormat?: ResponsesToolChoiceFormat;
  testModeration?: ModerationMode;
  responsesTextModel?: string;
  responsesImageModel?: string;
  responsesReasoningEffort?: ReasoningEffort;
  responsesReturnMode?: ResponsesReturnMode;
  responsesInputShape?: ResponsesInputShape;
  responsesToolChoice?: ResponsesToolChoiceMode;
  responsesToolChoiceFormat?: ResponsesToolChoiceFormat;
  responsesModelRouting?: ResponsesModelRouting;
  responsesModerationMode?: ResponsesModerationMode;
  responsesImageToolQuality?: ImageToolQuality;
  responsesImageQuality?: number;
  testN?: number;
  supportsGenerations?: boolean;
  supportsEdits?: boolean;
  supportsAsync?: boolean;
  responseFormats?: Array<'url' | 'b64_json'>;
  allowDirectPublicImageUrl?: boolean;
  imageInputMode?: 'url_only' | 'multipart_only' | 'url_or_multipart' | 'unknown';
  imageEditProtocolModes?: Array<'multipart_file_upload' | 'json_image_url'>;
  jsonReferenceTransports?: Array<'url' | 'base64'>;
  imageEditReferenceMode?: 'multipart_file_upload' | 'json_image_url';
  imageReturnMode?: 'json' | 'stream';
  imageEditRequestFormat?: 'json' | 'multipart';
  referenceImageTransport?: 'inherit' | 'url' | 'base64';
  imagesCapabilityProfiles?: ImageCapabilityProfile[];
  imagesGenerationsUrl?: string;
  imagesEditsUrl?: string;
  imagesAsyncGenerationsUrl?: string;
  imagesAsyncEditsUrl?: string;
  imagesAsyncResultUrlTemplate?: string;
  responsesCapabilityProfiles?: ImageCapabilityProfile[];
  supportsImageInput?: boolean;
  responsesResponseFormats?: Array<'url' | 'b64_json'>;
  responsesJsonReferenceTransports?: Array<'url' | 'base64'>;
  responsesAllowDirectPublicImageUrl?: boolean;
  supportsSystemPrompt?: boolean;
  supportsJsonMode?: boolean;
  supportsTools?: boolean;
  supportsVisionInput?: boolean;
  chatUpstreamCostYuan?: number;
  bananaAuthMode?: BananaAuthMode;
  bananaSupportsTextToImage?: boolean;
  bananaSupportsImageToImage?: boolean;
  bananaGenerationPathPrefix?: string;
  bananaModelCapabilities?: BananaModelCapability[];
};

const kindOptions = [
  { value: 'images_endpoint', label: 'Images Endpoint' },
  { value: 'responses_endpoint', label: 'Responses Endpoint' },
  { value: 'banana_endpoint', label: 'Banana / Gemini 图像接口' },
  { value: 'chat_completions', label: 'Chat Completions' },
];

const healthOptions = [
  { value: 'healthy', label: '健康' },
  { value: 'cooling', label: '冷却中' },
  { value: 'degraded', label: '降级' },
  { value: 'disabled', label: '停用' },
];

function healthLabel(value: ConsoleUpstream['healthStatus']) {
  return healthOptions.find((item) => item.value === value)?.label || value;
}

function healthTone(value: ConsoleUpstream['healthStatus']): StatusTone {
  if (value === 'healthy') return 'success';
  if (value === 'cooling' || value === 'degraded') return 'warning';
  return 'neutral';
}

function displayUpstreamHost(value: string) {
  try {
    return new URL(value).hostname;
  } catch {
    return String(value || '')
      .replace(/^https?:\/\//i, '')
      .split('/')[0]
      .split(':')[0];
  }
}

function imageUploadFormats(upstream: ConsoleUpstream) {
  if (upstream.kind === 'banana_endpoint') {
    return upstream.bananaConfig?.supportsImageToImage ? 'BASE64' : '不支持';
  }
  if (upstream.kind === 'images_endpoint') {
    if (!upstream.imagesConfig?.supportsEdits) {
      return '不支持';
    }
    const transports = upstream.imagesConfig.jsonReferenceTransports || [];
    const formats = [
      ...(upstream.imagesConfig.editProtocolModes.includes('multipart_file_upload') ? ['MULTIPART'] : []),
      ...(transports.includes('url') ? ['URL'] : []),
      ...(transports.includes('base64') ? ['BASE64'] : []),
    ];
    return formats.length ? formats.join(' / ') : '未配置';
  }
  if (upstream.kind !== 'responses_endpoint' || !upstream.responsesConfig?.supportsImageInput) {
    return '不支持';
  }
  const transports = upstream.responsesConfig.jsonReferenceTransports || [];
  const formats = [
    ...(transports.includes('url') ? ['URL'] : []),
    ...(transports.includes('base64') ? ['BASE64'] : []),
  ];
  return formats.length ? formats.join(' / ') : '未配置';
}

function imageReturnFormats(upstream: ConsoleUpstream) {
  if (upstream.kind === 'banana_endpoint') {
    return 'BASE64';
  }
  const formats = upstream.kind === 'images_endpoint'
    ? upstream.imagesConfig?.responseFormats || []
    : upstream.kind === 'responses_endpoint'
      ? upstream.responsesConfig?.responseFormats || []
      : [];
  const labels = [
    ...(formats.includes('url') ? ['URL'] : []),
    ...(formats.includes('b64_json') ? ['BASE64'] : []),
  ];
  return labels.length ? labels.join(' / ') : '未配置';
}

const imageReturnModeOptions = [
  { value: 'json', label: '上游标准 JSON（不向上游发送 stream=true）' },
  { value: 'stream', label: '上游原生 SSE（仅上游明确支持 stream=true 时选择）' },
];

function defaultBananaModelCapabilities(): BananaModelCapability[] {
  return [{
    model: BANANA_MODELS[0].id,
    imageSizes: ['1k', '2k', '4k'],
    aspectRatios: ['16:9'],
    supportsReferenceImages: false,
  }];
}

const imageEditProtocolOptions = [
  { value: 'multipart_file_upload', label: 'multipart/form-data + image 文件上传' },
  { value: 'json_image_url', label: 'application/json + images[].image_url' },
];

const jsonImageReferenceTransportOptions = [
  { value: 'url', label: '普通 URL' },
  { value: 'base64', label: 'Base64 / data URL' },
];

const resolutionTierOptions = [
  { value: 'auto', label: '自动' },
  { value: '1k', label: '1K' },
  { value: '2k', label: '2K' },
  { value: '4k', label: '4K' },
];

const responseFormatOptions = [
  { value: 'url', label: '返回图片链接 URL' },
  { value: 'b64_json', label: '返回 Base64' },
];

const outputFormatOptions = [
  { value: 'png', label: 'PNG' },
  { value: 'webp', label: 'WEBP' },
  { value: 'jpeg', label: 'JPEG' },
];

type TestPreviewImage = {
  url: string;
  source: string;
};

function normalizePreviewMime(outputFormat: unknown) {
  const normalized = String(outputFormat || '').trim().toLowerCase();
  if (normalized === 'jpg' || normalized === 'jpeg') {
    return 'image/jpeg';
  }
  if (normalized === 'webp') {
    return 'image/webp';
  }
  return 'image/png';
}

function looksLikeBase64Image(value: string) {
  const normalized = value.replace(/\s+/g, '');
  return normalized.length > 128 && /^[a-zA-Z0-9+/]+={0,2}$/.test(normalized);
}

function collectTestPreviewImages(result: UpstreamTestResult): TestPreviewImage[] {
  const body = result.requestPlan.body || {};
  const extraBody = body.extra_body && typeof body.extra_body === 'object'
    ? body.extra_body as Record<string, unknown>
    : {};
  const mime = normalizePreviewMime(body.output_format || extraBody.output_format);
  const finalImages: TestPreviewImage[] = [];
  const partialImages: TestPreviewImage[] = [];
  const seen = new Set<string>();

  function append(url: string, source: string, partial = false) {
    const normalized = String(url || '').trim();
    const target = partial ? partialImages : finalImages;
    if (!normalized || seen.has(normalized) || target.length >= 8) {
      return;
    }
    seen.add(normalized);
    target.push({ url: normalized, source });
  }

  function appendImageValue(value: unknown, source: string, partial = false) {
    if (typeof value !== 'string') {
      return;
    }
    const normalized = value.trim();
    if (/^https?:\/\//i.test(normalized) || /^data:image\//i.test(normalized)) {
      append(normalized, source, partial);
      return;
    }
    if (looksLikeBase64Image(normalized)) {
      append(`data:${mime};base64,${normalized.replace(/\s+/g, '')}`, source, partial);
    }
  }

  function walk(node: unknown, path = 'response') {
    if (finalImages.length >= 8 || node === null || node === undefined) {
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((item, index) => walk(item, `${path}[${index}]`));
      return;
    }
    if (typeof node !== 'object') {
      return;
    }
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      const nextPath = `${path}.${key}`;
      if (key === 'b64_json' || key === 'result') {
        appendImageValue(value, nextPath);
        continue;
      }
      if (key === 'partial_image_b64') {
        appendImageValue(value, nextPath, true);
        continue;
      }
      if (key === 'url' || key === 'image_url') {
        appendImageValue(value, nextPath);
      }
      walk(value, nextPath);
    }
  }

  walk(result.response.bodyJson);
  const responseText = String(result.response.bodyText || '').trim();
  if (responseText) {
    try {
      walk(JSON.parse(responseText), 'responseText');
    } catch {
      for (const line of responseText.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) {
          continue;
        }
        const dataText = trimmed.slice(5).trim();
        if (!dataText || dataText === '[DONE]') {
          continue;
        }
        try {
          walk(JSON.parse(dataText), 'sse');
        } catch {
          // Ignore non-JSON SSE events.
        }
      }
    }
  }
  return finalImages.length ? finalImages : partialImages;
}

function redactImagePayloadForDisplay(node: unknown): unknown {
  if (Array.isArray(node)) {
    return node.map((item) => redactImagePayloadForDisplay(item));
  }
  if (!node || typeof node !== 'object') {
    return node;
  }
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (
      (key === 'b64_json' || key === 'result' || key === 'partial_image_b64')
      && typeof value === 'string'
      && value.length > 128
    ) {
      next[key] = '<image payload omitted; rendered below>';
      continue;
    }
    if (
      (key === 'image' || key === 'image_url' || key === 'url')
      && typeof value === 'string'
      && (/^data:image\//i.test(value) || value.length > 4096)
    ) {
      next[key] = '<image payload omitted; rendered below>';
      continue;
    }
    next[key] = redactImagePayloadForDisplay(value);
  }
  return next;
}

function buildTestResponseDisplay(result: UpstreamTestResult) {
  const sanitizedJson = redactImagePayloadForDisplay(result.response.bodyJson);
  let bodyText = result.response.bodyText;
  if (result.response.bodyJson !== undefined) {
    bodyText = JSON.stringify(sanitizedJson);
  } else {
    bodyText = String(bodyText || '')
      .replace(/("(?:b64_json|result|partial_image_b64)"\s*:\s*")[^"]{128,}(")/g, '$1<image payload omitted; rendered below>$2')
      .replace(/("(?:image|image_url|url)"\s*:\s*")data:image\/[^"]+(")/gi, '$1<image payload omitted; rendered below>$2');
  }
  return {
    ...result.response,
    bodyJson: sanitizedJson,
    bodyText,
  };
}

const qualityOptions = [
  { value: 'low', label: '快速' },
  { value: 'medium', label: '标准' },
  { value: 'high', label: '精细' },
];

const imageToolQualityOptions = [
  { value: 'auto', label: '自动' },
  { value: 'low', label: '快速' },
  { value: 'medium', label: '标准' },
  { value: 'high', label: '精细' },
];

const capabilityQualityOptions = [
  { value: 'auto', label: '自动' },
  { value: 'low', label: '低' },
  { value: 'medium', label: '中' },
  { value: 'high', label: '高' },
];

const defaultCapabilityProfiles = (): ImageCapabilityProfile[] => (
  ['auto', '1k', '2k', '4k'].map((tier) => ({
    tier: tier as ImageCapabilityProfile['tier'],
    qualities: ['auto', 'low', 'medium', 'high'],
    costs: {
      auto: 0,
      low: 0,
      medium: 0,
      high: 0,
    },
  }))
);

function normalizeEditProtocolModes(input?: Array<'multipart_file_upload' | 'json_image_url'>) {
  const order: Array<'multipart_file_upload' | 'json_image_url'> = ['multipart_file_upload', 'json_image_url'];
  const source = Array.isArray(input) ? input.filter((item) => order.includes(item)) : [];
  return order.filter((item) => source.includes(item));
}

function normalizeJsonReferenceTransports(input?: Array<'url' | 'base64'>) {
  const order: Array<'url' | 'base64'> = ['url', 'base64'];
  const source = Array.isArray(input) ? input.filter((item) => order.includes(item)) : [];
  return order.filter((item) => source.includes(item));
}

function deriveImageCapabilitiesFromLegacy(config?: ConsoleUpstream['imagesConfig']) {
  if (!config) {
    return {
      imageEditProtocolModes: ['multipart_file_upload'] as Array<'multipart_file_upload' | 'json_image_url'>,
      jsonReferenceTransports: ['url', 'base64'] as Array<'url' | 'base64'>,
    };
  }
  const imageEditProtocolModes = normalizeEditProtocolModes(
    config.editProtocolModes?.length
      ? config.editProtocolModes
      : config.imageInputMode === 'url_or_multipart'
        ? ['multipart_file_upload', 'json_image_url']
        : config.editReferenceMode === 'json_image_url' || config.editRequestFormat === 'json' || config.imageInputMode === 'url_only'
          ? ['json_image_url']
          : ['multipart_file_upload'],
  );
  const jsonReferenceTransports = imageEditProtocolModes.includes('json_image_url')
    ? normalizeJsonReferenceTransports(
        config.jsonReferenceTransports?.length
          ? config.jsonReferenceTransports
          : config.referenceImageTransport === 'inherit'
            ? ['url', 'base64']
            : config.referenceImageTransport === 'url' || config.referenceImageTransport === 'base64'
              ? [config.referenceImageTransport]
              : ['url'],
      )
    : [];
  return {
    imageEditProtocolModes,
    jsonReferenceTransports,
  };
}

function deriveImagesRuntimeFields(values: {
  imageEditProtocolModes?: Array<'multipart_file_upload' | 'json_image_url'>;
  jsonReferenceTransports?: Array<'url' | 'base64'>;
}) {
  const requestedProtocols = normalizeEditProtocolModes(values.imageEditProtocolModes);
  const imageEditProtocolModes: Array<'multipart_file_upload' | 'json_image_url'> = requestedProtocols.length
    ? requestedProtocols
    : ['multipart_file_upload'];
  const jsonReferenceTransports = imageEditProtocolModes.includes('json_image_url')
    ? normalizeJsonReferenceTransports(values.jsonReferenceTransports?.length ? values.jsonReferenceTransports : ['url'])
    : [];
  const hasMultipart = imageEditProtocolModes.includes('multipart_file_upload');
  const hasJson = imageEditProtocolModes.includes('json_image_url');
  const hasJsonUrl = jsonReferenceTransports.includes('url');
  const hasJsonBase64 = jsonReferenceTransports.includes('base64');
  return {
    imageEditProtocolModes,
    jsonReferenceTransports,
    imageInputMode: (
      hasMultipart
        ? (hasJson ? 'url_or_multipart' : 'multipart_only')
        : (hasJson ? 'url_only' : 'unknown')
    ) as NonNullable<FormShape['imageInputMode']>,
    imageEditReferenceMode: (
      hasJson ? 'json_image_url' : 'multipart_file_upload'
    ) as NonNullable<FormShape['imageEditReferenceMode']>,
    imageEditRequestFormat: (
      hasJson ? 'json' : 'multipart'
    ) as NonNullable<FormShape['imageEditRequestFormat']>,
    referenceImageTransport: (
      !hasJson
        ? 'inherit'
        : hasJsonUrl && hasJsonBase64
          ? 'inherit'
          : hasJsonBase64
            ? 'base64'
            : 'url'
    ) as NonNullable<FormShape['referenceImageTransport']>,
  };
}

function normalizeCapabilityProfiles(input?: ImageCapabilityProfile[]) {
  const source = Array.isArray(input) ? input : [];
  const tiers: Array<ImageCapabilityProfile['tier']> = ['auto', '1k', '2k', '4k'];
  const order: ImageQualityTier[] = ['auto', 'low', 'medium', 'high'];
  const byTier = new Map<ImageCapabilityProfile['tier'], ImageCapabilityProfile>();
  for (const item of source) {
    if (!item || !tiers.includes(item.tier)) {
      continue;
    }
    const qualities = order.filter((quality) => (item.qualities || []).includes(quality));
    const costs = order.reduce((result, quality) => ({
      ...result,
      [quality]: Math.max(0, Number(item.costs?.[quality] || 0)),
    }), {} as NonNullable<ImageCapabilityProfile['costs']>);
    byTier.set(item.tier, {
      tier: item.tier,
      qualities,
      costs,
    });
  }
  if (!byTier.size) {
    return defaultCapabilityProfiles();
  }
  return tiers
    .filter((tier) => byTier.has(tier))
    .map((tier) => byTier.get(tier) || {
      tier,
      qualities: [],
      costs: { auto: 0, low: 0, medium: 0, high: 0 },
    });
}

const responsesInputShapeOptions = [
  { value: 'auto_standard', label: '自动：有参考图时自动切多模态' },
  { value: 'always_multimodal_message', label: '始终使用多模态消息结构' },
];

const responsesToolChoiceOptions = [
  { value: 'auto', label: '不指定图像工具（默认）' },
  { value: 'image_generation', label: '指定 image_generation 工具' },
];

const responsesToolChoiceFormatOptions = [
  { value: 'typed_object', label: '对象格式：type=image_generation' },
  { value: 'required_string', label: '字符串格式：required' },
];

const responsesModelRoutingOptions = [
  { value: 'split_text_image', label: '拆分模型：顶层文本模型 + 工具图像模型' },
  { value: 'single_top_level_model', label: '单顶层模型：只发顶层模型' },
];

const reasoningEffortOptions = [
  { value: 'low', label: '低' },
  { value: 'medium', label: '中' },
  { value: 'high', label: '高' },
  { value: 'xhigh', label: '极高' },
];

const responsesModerationModeOptions = [
  { value: 'task_or_omit', label: '跟随任务或省略' },
  { value: 'force_auto', label: '强制 auto' },
  { value: 'force_low', label: '强制 low' },
];

const moderationOptions = [
  { value: 'omit', label: '不提交 moderation' },
  { value: 'auto', label: '提交 moderation=auto' },
  { value: 'low', label: '提交 moderation=low' },
];

const backgroundOptions: Array<{ value: ImageBackgroundMode; label: string }> = [
  { value: 'omit', label: 'Do not send background' },
  { value: 'auto', label: 'auto' },
  { value: 'transparent', label: 'transparent' },
  { value: 'opaque', label: 'opaque' },
];

const reservedCustomBodyFieldKeysByKind: Record<ConsoleUpstream['kind'], Set<string>> = {
  images_endpoint: new Set([
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
  ]),
  responses_endpoint: new Set([
    'model',
    'input',
    'tools',
    'tool_choice',
    'stream',
    'reasoning',
  ]),
  banana_endpoint: new Set([
    'contents',
    'generationConfig',
  ]),
  chat_completions: new Set([
    'model',
    'messages',
    'stream',
  ]),
};

const emptyUpstream: ConsoleUpstream = {
  id: '',
  name: '',
  kind: 'images_endpoint',
  baseUrl: '',
  apiKey: '',
  enabled: true,
  maxConcurrency: 10,
  healthStatus: 'healthy',
  modelHints: [],
  notes: '',
  adminTestPreset: {
    operation: 'generations',
    model: 'gpt-image-2',
    prompt: '一只小猫，干净背景，自然光，不要文字',
    size: '1600x1200',
    quality: 'medium',
    responseFormat: 'b64_json',
    outputFormat: 'png',
    outputCompression: undefined,
    background: 'omit',
    stream: false,
    referenceImageUrl: localReferenceImageUrl,
    moderation: 'omit',
    n: 1,
  },
  passthrough: {
    injectHeaders: {},
    injectBodyFields: {},
  },
  imagesConfig: {
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
    capabilityProfiles: defaultCapabilityProfiles(),
  },
  responsesConfig: {
    supportsImageInput: true,
    capabilityProfiles: defaultCapabilityProfiles(),
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
    imageQuality: undefined,
  },
  bananaConfig: {
    authMode: 'both',
    supportsTextToImage: true,
    supportsImageToImage: false,
    generationPathPrefix: '/v1beta/models',
    modelCapabilities: defaultBananaModelCapabilities(),
  },
  chatConfig: {
    supportsSystemPrompt: true,
    supportsJsonMode: true,
    supportsTools: true,
    supportsVisionInput: false,
  },
};

function protocolDefaults(kind: ConsoleUpstream['kind']): Partial<FormShape> {
  if (kind === 'banana_endpoint') {
    return {
      modelHintsText: '',
      maxConcurrency: 10,
      injectHeadersList: [],
      injectBodyFieldsList: [],
      testOperation: 'generations',
      testModel: BANANA_MODELS[0].id,
      testPrompt: 'A clean studio product photograph of a small orange cat.',
      testSize: '4k',
      testReferenceImageUrl: localReferenceImageUrl,
      testN: 1,
      bananaAuthMode: 'both',
      bananaSupportsTextToImage: true,
      bananaSupportsImageToImage: false,
      bananaGenerationPathPrefix: '/v1beta/models',
      bananaModelCapabilities: defaultBananaModelCapabilities(),
    };
  }
  if (kind === 'responses_endpoint') {
    return {
      modelHintsText: 'gpt-image-2',
      maxConcurrency: 10,
      injectHeadersList: [],
      injectBodyFieldsList: [],
      testOperation: 'responses' as const,
      testModel: 'gpt-5.4-mini',
      testImageModel: 'gpt-image-2',
      testSize: 'auto',
      testQuality: 'medium',
      testImageToolQuality: 'medium' as ImageToolQuality,
      testImageQuality: undefined,
      testPrompt: '一只小猫，干净背景，自然光，不要文字',
      testOutputFormat: 'png' as const,
      testOutputCompression: undefined,
      testBackground: 'omit' as const,
      testStream: true,
      testResponseFormat: undefined,
      testModeration: 'omit' as const,
      testReferenceImageUrl: localReferenceImageUrl,
      testResponsesInputShape: 'always_multimodal_message' as const,
      testResponsesToolChoice: 'image_generation' as const,
      testResponsesToolChoiceFormat: 'typed_object' as const,
      testN: undefined,
      responsesTextModel: 'gpt-5.4-mini',
      responsesImageModel: 'gpt-image-2',
      responsesInputShape: 'always_multimodal_message' as const,
      responsesToolChoice: 'image_generation' as const,
      responsesToolChoiceFormat: 'typed_object' as const,
      responsesModelRouting: 'split_text_image' as const,
      responsesReturnMode: 'stream' as const,
      responsesReasoningEffort: 'low' as const,
      responsesModerationMode: 'task_or_omit' as const,
      responsesImageToolQuality: undefined,
      responsesImageQuality: undefined,
      supportsImageInput: true,
      responsesResponseFormats: ['url', 'b64_json'] as Array<'url' | 'b64_json'>,
      responsesJsonReferenceTransports: ['url', 'base64'] as Array<'url' | 'base64'>,
      responsesAllowDirectPublicImageUrl: false,
      responsesCapabilityProfiles: defaultCapabilityProfiles(),
      supportsGenerations: undefined,
      supportsEdits: undefined,
      supportsAsync: undefined,
      responseFormats: undefined,
      allowDirectPublicImageUrl: undefined,
      imageInputMode: undefined,
      imageEditProtocolModes: undefined,
      jsonReferenceTransports: undefined,
      imagesCapabilityProfiles: undefined,
      supportsSystemPrompt: undefined,
      supportsJsonMode: undefined,
      supportsTools: undefined,
      supportsVisionInput: undefined,
    };
  }
  if (kind === 'chat_completions') {
    return {
      modelHintsText: '',
      maxConcurrency: 10,
      injectHeadersList: [],
      injectBodyFieldsList: [],
      testOperation: 'chat_completions' as const,
      testModel: 'gpt-4.1-mini',
      testImageModel: undefined,
      testSize: undefined,
      testQuality: undefined,
      testImageToolQuality: undefined,
      testImageQuality: undefined,
      testResponseFormat: undefined,
      testOutputFormat: undefined,
      testOutputCompression: undefined,
      testBackground: undefined,
      testStream: false,
      testPrompt: '请描述这张图里的主体、背景与风格',
      testModeration: undefined,
      testReferenceImageUrl: localReferenceImageUrl,
      testResponsesInputShape: undefined,
      testResponsesToolChoice: undefined,
      testResponsesToolChoiceFormat: undefined,
      testN: undefined,
      responsesTextModel: undefined,
      responsesImageModel: undefined,
      responsesReasoningEffort: undefined,
      responsesReturnMode: undefined,
      responsesInputShape: undefined,
      responsesToolChoice: undefined,
      responsesToolChoiceFormat: undefined,
      responsesModelRouting: undefined,
      responsesModerationMode: undefined,
      responsesImageToolQuality: undefined,
      responsesImageQuality: undefined,
      supportsGenerations: undefined,
      supportsEdits: undefined,
      supportsAsync: undefined,
      responseFormats: undefined,
      allowDirectPublicImageUrl: undefined,
      imageInputMode: undefined,
      imageEditProtocolModes: undefined,
      jsonReferenceTransports: undefined,
      imagesCapabilityProfiles: undefined,
      supportsImageInput: undefined,
      responsesResponseFormats: undefined,
      responsesJsonReferenceTransports: undefined,
      responsesAllowDirectPublicImageUrl: undefined,
      responsesCapabilityProfiles: undefined,
      supportsSystemPrompt: true,
      supportsJsonMode: true,
      supportsTools: true,
      supportsVisionInput: false,
    };
  }
  return {
    modelHintsText: '',
    maxConcurrency: 10,
    injectHeadersList: [],
    injectBodyFieldsList: [],
    testOperation: 'generations' as const,
    testModel: 'gpt-image-2',
    testImageModel: undefined,
    testSize: '1600x1200',
    testQuality: 'medium',
    testImageToolQuality: undefined,
    testImageQuality: undefined,
    testResponseFormat: 'b64_json' as const,
    testOutputFormat: 'png' as const,
    testOutputCompression: undefined,
    testBackground: 'omit' as const,
    testStream: false,
    testPrompt: '一只小猫，干净背景，自然光，不要文字',
    testModeration: 'omit' as const,
    testReferenceImageUrl: localReferenceImageUrl,
    testResponsesInputShape: undefined,
    testResponsesToolChoice: undefined,
    testResponsesToolChoiceFormat: undefined,
    testN: 1,
    responsesTextModel: undefined,
    responsesImageModel: undefined,
    responsesReasoningEffort: undefined,
    responsesReturnMode: undefined,
    responsesInputShape: undefined,
    responsesToolChoice: undefined,
    responsesToolChoiceFormat: undefined,
    responsesModelRouting: undefined,
    responsesModerationMode: undefined,
    responsesImageToolQuality: undefined,
    responsesImageQuality: undefined,
    supportsGenerations: true,
    supportsEdits: true,
    supportsAsync: false,
    responseFormats: ['url', 'b64_json'] as Array<'url' | 'b64_json'>,
    allowDirectPublicImageUrl: false,
    imageInputMode: 'unknown' as const,
    imageEditProtocolModes: ['multipart_file_upload'] as Array<'multipart_file_upload' | 'json_image_url'>,
    jsonReferenceTransports: ['url', 'base64'] as Array<'url' | 'base64'>,
    imageEditReferenceMode: 'multipart_file_upload' as const,
    imageReturnMode: 'json' as const,
    imageEditRequestFormat: 'multipart' as const,
    referenceImageTransport: 'inherit' as const,
    imagesCapabilityProfiles: defaultCapabilityProfiles(),
    supportsImageInput: undefined,
    responsesResponseFormats: undefined,
    responsesJsonReferenceTransports: undefined,
    responsesAllowDirectPublicImageUrl: undefined,
    responsesCapabilityProfiles: undefined,
    supportsSystemPrompt: undefined,
    supportsJsonMode: undefined,
    supportsTools: undefined,
    supportsVisionInput: undefined,
  };
}

function toKeyValueList(input?: Record<string, unknown> | Record<string, string>) {
  return Object.entries(input || {}).map(([key, value]) => ({
    key,
    value: String(value ?? ''),
  }));
}

function fromKeyValueList(list: KeyValueItem[]) {
  const result: Record<string, unknown> = {};
  for (const item of list) {
    const key = String(item.key || '').trim();
    if (!key) {
      continue;
    }
    result[key] = parseTypedValue(item.value);
  }
  return result;
}

function sanitizeInjectBodyFieldsForKind(
  kind: ConsoleUpstream['kind'],
  fields: Record<string, unknown>,
) {
  const reserved = reservedCustomBodyFieldKeysByKind[kind];
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields || {})) {
    const normalizedKey = String(key || '').trim();
    if (!normalizedKey || reserved.has(normalizedKey)) {
      continue;
    }
    sanitized[normalizedKey] = value;
  }
  return sanitized;
}

function parseTypedValue(input: string) {
  const raw = String(input ?? '').trim();
  if (!raw) {
    return '';
  }
  if (raw === 'true') {
    return true;
  }
  if (raw === 'false') {
    return false;
  }
  if (raw === 'null') {
    return null;
  }
  if (/^-?\d+(\.\d+)?$/.test(raw)) {
    return Number(raw);
  }
  if ((raw.startsWith('{') && raw.endsWith('}')) || (raw.startsWith('[') && raw.endsWith(']'))) {
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }
  return raw;
}

function normalizeTestOperation(
  kind: ConsoleUpstream['kind'],
  operation?: UpstreamTestRequest['operation'],
): UpstreamTestRequest['operation'] {
  if (kind === 'responses_endpoint') {
    return 'responses';
  }
  if (kind === 'chat_completions') {
    return 'chat_completions';
  }
  return operation === 'edits' ? 'edits' : 'generations';
}

function buildAdminTestPreset(kind: ConsoleUpstream['kind'], values: FormShape): UpstreamTestPreset {
  if (kind === 'banana_endpoint') {
    const model = values.bananaModelCapabilities?.[0]?.model || BANANA_MODELS[0].id;
    return {
      operation: normalizeTestOperation(kind, values.testOperation),
      model,
      prompt: values.testPrompt,
      size: values.testSize || '4k',
      referenceImageUrl: values.testOperation === 'edits' ? values.testReferenceImageUrl || undefined : undefined,
    };
  }
  if (kind === 'responses_endpoint') {
    return {
      operation: 'responses',
      model: values.responsesTextModel || values.testModel || 'gpt-5.4-mini',
      imageModel: values.responsesImageModel || values.testImageModel || undefined,
      prompt: values.testPrompt,
      size: values.testSize || undefined,
      imageToolQuality: values.testImageToolQuality ?? undefined,
      imageQuality: values.testImageQuality ?? undefined,
      outputFormat: values.testOutputFormat || undefined,
      outputCompression: values.testOutputCompression ?? undefined,
      background: values.testBackground || undefined,
      referenceImageUrl: values.testReferenceImageUrl || undefined,
      moderation: values.testModeration || undefined,
      stream: true,
      responsesInputShape: values.testResponsesInputShape || undefined,
      responsesToolChoice: values.testResponsesToolChoice || undefined,
      responsesToolChoiceFormat: values.testResponsesToolChoiceFormat || undefined,
    };
  }

  if (kind === 'chat_completions') {
    return {
      operation: 'chat_completions',
      model: values.testModel,
      prompt: values.testPrompt,
      stream: Boolean(values.testStream),
      referenceImageUrl: values.testReferenceImageUrl || undefined,
    };
  }

  return {
    operation: normalizeTestOperation(kind, values.testOperation),
    model: values.testModel,
    prompt: values.testPrompt,
    size: values.testSize || undefined,
    quality: values.testQuality || undefined,
    responseFormat: values.testResponseFormat || undefined,
    outputFormat: values.testOutputFormat || undefined,
    outputCompression: values.testOutputCompression ?? undefined,
    background: values.testBackground || undefined,
    stream: Boolean(values.testStream),
    referenceImageUrl: values.testReferenceImageUrl || undefined,
    moderation: values.testModeration || undefined,
    n: values.testN ? Number(values.testN) : undefined,
  };
}

function buildDraftTestRequest(
  kind: ConsoleUpstream['kind'],
  values: FormShape,
  operation: UpstreamTestRequest['operation'],
): UpstreamTestRequest {
  const normalizedOperation = normalizeTestOperation(kind, operation);

  if (kind === 'banana_endpoint') {
    const model = values.bananaModelCapabilities?.[0]?.model || BANANA_MODELS[0].id;
    return {
      operation: normalizedOperation,
      model,
      prompt: values.testPrompt,
      size: values.testSize || '4k',
      referenceImageUrl: normalizedOperation === 'edits' ? values.testReferenceImageUrl || undefined : undefined,
    };
  }

  if (kind === 'responses_endpoint') {
    return {
      operation: 'responses',
      model: values.responsesTextModel || values.testModel || 'gpt-5.4-mini',
      imageModel: values.responsesImageModel || values.testImageModel || undefined,
      prompt: values.testPrompt,
      size: values.testSize || undefined,
      imageToolQuality: values.testImageToolQuality ?? undefined,
      imageQuality: values.testImageQuality ?? undefined,
      outputFormat: values.testOutputFormat || undefined,
      outputCompression: values.testOutputCompression ?? undefined,
      background: values.testBackground || undefined,
      referenceImageUrl: values.testReferenceImageUrl || undefined,
      moderation: values.testModeration || undefined,
      stream: true,
      responsesInputShape: values.testResponsesInputShape || undefined,
      responsesToolChoice: values.testResponsesToolChoice || undefined,
      responsesToolChoiceFormat: values.testResponsesToolChoiceFormat || undefined,
    };
  }

  if (kind === 'chat_completions') {
    return {
      operation: 'chat_completions',
      model: values.testModel,
      prompt: values.testPrompt,
      stream: Boolean(values.testStream),
      referenceImageUrl: values.testReferenceImageUrl || undefined,
    };
  }

  return {
    operation: normalizedOperation,
    model: values.testModel,
    prompt: values.testPrompt,
    size: values.testSize || undefined,
    quality: values.testQuality || undefined,
    responseFormat: values.testResponseFormat || undefined,
    outputFormat: values.testOutputFormat || undefined,
    outputCompression: values.testOutputCompression ?? undefined,
    background: values.testBackground || undefined,
    stream: Boolean(values.testStream),
    referenceImageUrl: normalizedOperation === 'edits' ? values.testReferenceImageUrl || undefined : undefined,
    moderation: values.testModeration || undefined,
    n: values.testN ? Number(values.testN) : undefined,
  };
}

function toFormValues(upstream: ConsoleUpstream): FormShape {
  const preset = upstream.adminTestPreset || emptyUpstream.adminTestPreset!;
  const imageCapabilities = deriveImageCapabilitiesFromLegacy(upstream.imagesConfig);
  const baseValues = {
    id: upstream.id,
    name: upstream.name,
    kind: upstream.kind,
    baseUrl: upstream.baseUrl,
    apiKey: upstream.apiKey,
    enabled: upstream.enabled,
    maxConcurrency: Math.max(1, Number(upstream.maxConcurrency || 10)),
    healthStatus: upstream.healthStatus,
    modelHintsText: String((upstream.modelHints || [])[0] || ''),
    notes: upstream.notes,
    injectHeadersList: toKeyValueList(upstream.passthrough?.injectHeaders as Record<string, string>),
    injectBodyFieldsList: toKeyValueList(upstream.passthrough?.injectBodyFields as Record<string, unknown>),
    testOperation: normalizeTestOperation(upstream.kind, preset.operation),
    testModel: preset.model,
    testImageModel: preset.imageModel,
    testPrompt: preset.prompt,
    testSize: preset.size,
    testQuality: preset.quality,
    testImageToolQuality: preset.imageToolQuality
      ?? (upstream.kind === 'responses_endpoint' ? preset.quality as ImageToolQuality | undefined : undefined),
    testImageQuality: preset.imageQuality,
    testResponseFormat: preset.responseFormat,
    testOutputFormat: preset.outputFormat,
    testOutputCompression: preset.outputCompression,
    testBackground: preset.background,
    testStream: preset.stream,
    testPartialImages: preset.partialImages,
    testReferenceImageUrl: preset.referenceImageUrl,
    testResponsesInputShape: preset.responsesInputShape,
    testResponsesToolChoice: preset.responsesToolChoice,
    testResponsesToolChoiceFormat: preset.responsesToolChoiceFormat,
    testModeration: preset.moderation,
    responsesTextModel: upstream.responsesConfig?.textModel,
    responsesImageModel: upstream.responsesConfig?.imageModel,
    responsesReasoningEffort: upstream.responsesConfig?.reasoningEffort,
    responsesReturnMode: upstream.responsesConfig?.returnMode,
    responsesInputShape: upstream.responsesConfig?.inputShape,
    responsesToolChoice: upstream.responsesConfig?.toolChoice,
    responsesToolChoiceFormat: upstream.responsesConfig?.toolChoiceFormat,
    responsesModelRouting: upstream.responsesConfig?.modelRouting,
    responsesModerationMode: upstream.responsesConfig?.moderationMode,
    responsesImageToolQuality: upstream.responsesConfig?.imageToolQuality,
    responsesImageQuality: upstream.responsesConfig?.imageQuality,
    responsesResponseFormats: upstream.responsesConfig?.responseFormats || ['url', 'b64_json'],
    responsesJsonReferenceTransports: upstream.responsesConfig?.jsonReferenceTransports || ['url', 'base64'],
    responsesAllowDirectPublicImageUrl: upstream.responsesConfig?.allowDirectPublicImageUrl ?? false,
    responsesCapabilityProfiles: normalizeCapabilityProfiles(upstream.responsesConfig?.capabilityProfiles),
    testN: preset.n,
    supportsGenerations: upstream.imagesConfig?.supportsGenerations,
    supportsEdits: upstream.imagesConfig?.supportsEdits,
    supportsAsync: upstream.imagesConfig?.supportsAsync,
    responseFormats: upstream.imagesConfig?.responseFormats,
    allowDirectPublicImageUrl: upstream.imagesConfig?.allowDirectPublicImageUrl,
    imageInputMode: upstream.imagesConfig?.imageInputMode,
    imageEditProtocolModes: imageCapabilities.imageEditProtocolModes,
    jsonReferenceTransports: imageCapabilities.jsonReferenceTransports,
    imageEditReferenceMode: upstream.imagesConfig?.editReferenceMode,
    imageReturnMode: upstream.imagesConfig?.returnMode,
    imageEditRequestFormat: upstream.imagesConfig?.editRequestFormat,
    referenceImageTransport: upstream.imagesConfig?.referenceImageTransport,
    imagesCapabilityProfiles: normalizeCapabilityProfiles(upstream.imagesConfig?.capabilityProfiles),
    imagesGenerationsUrl: upstream.imagesConfig?.generationsUrl,
    imagesEditsUrl: upstream.imagesConfig?.editsUrl,
    imagesAsyncGenerationsUrl: upstream.imagesConfig?.asyncGenerationsUrl,
    imagesAsyncEditsUrl: upstream.imagesConfig?.asyncEditsUrl,
    imagesAsyncResultUrlTemplate: upstream.imagesConfig?.asyncResultUrlTemplate,
    supportsImageInput: upstream.responsesConfig?.supportsImageInput,
    supportsSystemPrompt: upstream.chatConfig?.supportsSystemPrompt,
    supportsJsonMode: upstream.chatConfig?.supportsJsonMode,
    supportsTools: upstream.chatConfig?.supportsTools,
    supportsVisionInput: upstream.chatConfig?.supportsVisionInput,
    chatUpstreamCostYuan: upstream.chatConfig?.upstreamCostYuan,
    bananaAuthMode: upstream.bananaConfig?.authMode || 'both',
    bananaSupportsTextToImage: upstream.bananaConfig?.supportsTextToImage ?? true,
    bananaSupportsImageToImage: upstream.bananaConfig?.supportsImageToImage ?? false,
    bananaGenerationPathPrefix: upstream.bananaConfig?.generationPathPrefix || '/v1beta/models',
    bananaModelCapabilities: upstream.bananaConfig?.modelCapabilities?.slice(0, 1).length
      ? upstream.bananaConfig.modelCapabilities.slice(0, 1)
      : defaultBananaModelCapabilities(),
  };
  return {
    ...protocolDefaults(upstream.kind),
    ...baseValues,
  };
}

function fromHeaderList(list: KeyValueItem[]) {
  const result: Record<string, string> = {};
  for (const item of list) {
    const key = String(item.key || '').trim();
    if (!key) {
      continue;
    }
    result[key] = String(item.value || '');
  }
  return result;
}

function toUpstream(values: FormShape, original?: ConsoleUpstream | null): ConsoleUpstream {
  const kind = values.kind;
  const injectHeaders = fromHeaderList(values.injectHeadersList || []);
  const injectBodyFields = sanitizeInjectBodyFieldsForKind(
    kind,
    fromKeyValueList(values.injectBodyFieldsList || []),
  );
  const imageRuntime = deriveImagesRuntimeFields(values);
  const bananaCapability = kind === 'banana_endpoint'
    ? (values.bananaModelCapabilities || [])[0] || defaultBananaModelCapabilities()[0]
    : null;
  const bananaModel = bananaCapability && BANANA_MODELS.some((item) => item.id === bananaCapability.model)
    ? bananaCapability.model
    : BANANA_MODELS[0].id;
  const upstream: ConsoleUpstream = {
    id: values.id || original?.id || `upstream_${Date.now()}`,
    name: values.name,
    kind,
    baseUrl: values.baseUrl,
    apiKey: values.apiKey,
    enabled: Boolean(values.enabled),
    maxConcurrency: Math.max(1, Math.floor(Number(values.maxConcurrency || 10))),
    healthStatus: values.healthStatus || original?.healthStatus || 'healthy',
    modelHints: kind === 'banana_endpoint'
      ? [bananaModel]
      : (() => {
      const value = String(values.modelHintsText || '').trim();
      return value ? [value] : [];
      })(),
    notes: values.notes || '',
    adminTestPreset: buildAdminTestPreset(kind, values),
    passthrough: kind === 'images_endpoint'
      ? {
          injectHeaders,
          injectBodyFields,
        }
      : {
          injectHeaders,
          injectBodyFields,
        },
    imagesConfig: kind === 'images_endpoint' ? {
      supportsGenerations: Boolean(values.supportsGenerations),
      supportsEdits: Boolean(values.supportsEdits),
      supportsAsync: Boolean(values.supportsAsync),
      responseFormats: values.responseFormats?.length ? values.responseFormats : ['url', 'b64_json'],
      allowDirectPublicImageUrl: Boolean(values.allowDirectPublicImageUrl) && (values.responseFormats || []).includes('url'),
      imageInputMode: imageRuntime.imageInputMode,
      editProtocolModes: imageRuntime.imageEditProtocolModes,
      jsonReferenceTransports: imageRuntime.jsonReferenceTransports,
      editReferenceMode: imageRuntime.imageEditReferenceMode,
      returnMode: values.imageReturnMode || 'json',
      editRequestFormat: imageRuntime.imageEditRequestFormat,
      referenceImageTransport: imageRuntime.referenceImageTransport,
      capabilityProfiles: normalizeCapabilityProfiles(values.imagesCapabilityProfiles),
      generationsUrl: values.imagesGenerationsUrl || undefined,
      editsUrl: values.imagesEditsUrl || undefined,
      asyncGenerationsUrl: values.imagesAsyncGenerationsUrl || undefined,
      asyncEditsUrl: values.imagesAsyncEditsUrl || undefined,
      asyncResultUrlTemplate: values.imagesAsyncResultUrlTemplate || undefined,
    } : undefined,
    responsesConfig: kind === 'responses_endpoint' ? {
      supportsImageInput: Boolean(values.supportsImageInput),
      responseFormats: values.responsesResponseFormats?.length ? values.responsesResponseFormats : ['url', 'b64_json'],
      jsonReferenceTransports: Boolean(values.supportsImageInput)
        ? normalizeJsonReferenceTransports(values.responsesJsonReferenceTransports?.length ? values.responsesJsonReferenceTransports : ['url'])
        : [],
      allowDirectPublicImageUrl: Boolean(values.responsesAllowDirectPublicImageUrl)
        && (values.responsesResponseFormats || []).includes('url'),
      capabilityProfiles: normalizeCapabilityProfiles(values.responsesCapabilityProfiles),
      textModel: values.responsesTextModel || values.testModel || 'gpt-5.4-mini',
      imageModel: values.responsesImageModel || undefined,
      reasoningEffort: values.responsesReasoningEffort || 'low',
      returnMode: 'stream',
      inputShape: values.responsesInputShape || 'always_multimodal_message',
      toolChoice: values.responsesToolChoice || 'image_generation',
      toolChoiceFormat: values.responsesToolChoiceFormat || 'typed_object',
      modelRouting: values.responsesModelRouting || 'split_text_image',
      moderationMode: values.responsesModerationMode || 'task_or_omit',
      imageToolQuality: values.responsesImageToolQuality ?? undefined,
      imageQuality: values.responsesImageQuality ?? undefined,
    } : undefined,
    bananaConfig: kind === 'banana_endpoint' ? {
      authMode: values.bananaAuthMode || 'both',
      supportsTextToImage: values.bananaSupportsTextToImage !== false,
      supportsImageToImage: values.bananaSupportsImageToImage !== false,
      generationPathPrefix: values.bananaGenerationPathPrefix || '/v1beta/models',
      modelCapabilities: [{
        model: bananaModel,
        imageSizes: bananaCapability?.imageSizes || [],
        aspectRatios: bananaCapability?.aspectRatios || [],
        supportsReferenceImages: bananaCapability?.supportsReferenceImages === true,
        ...(bananaCapability?.cost === undefined ? {} : { cost: bananaCapability.cost }),
      }],
    } : undefined,
    chatConfig: kind === 'chat_completions' ? {
      supportsSystemPrompt: Boolean(values.supportsSystemPrompt),
      supportsJsonMode: Boolean(values.supportsJsonMode),
      supportsTools: Boolean(values.supportsTools),
      supportsVisionInput: Boolean(values.supportsVisionInput),
      ...(values.chatUpstreamCostYuan === undefined || values.chatUpstreamCostYuan === null
        ? {}
        : { upstreamCostYuan: Math.max(0, Number(values.chatUpstreamCostYuan)) }),
    } : undefined,
    detectedConfig: original?.detectedConfig,
    manualOverrides: original?.manualOverrides,
  };
  return upstream;
}

function KeyValueEditor({
  value = [],
  onChange,
  keyPlaceholder,
  valuePlaceholder,
}: {
  value?: KeyValueItem[];
  onChange?: (next: KeyValueItem[]) => void;
  keyPlaceholder: string;
  valuePlaceholder: string;
}) {
  const list = value || [];

  function update(next: KeyValueItem[]) {
    onChange?.(next);
  }

  return (
    <div className="kv-editor">
      {list.map((item, index) => (
        <div className="kv-row" key={`${item.key}_${index}`}>
          <Input
            placeholder={keyPlaceholder}
            value={item.key}
            onChange={(event) => {
              const next = [...list];
              next[index] = { ...next[index], key: event.target.value };
              update(next);
            }}
          />
          <Input
            placeholder={valuePlaceholder}
            value={item.value}
            onChange={(event) => {
              const next = [...list];
              next[index] = { ...next[index], value: event.target.value };
              update(next);
            }}
          />
          <Button
            type="text"
            danger
            icon={<DeleteOutlined />}
            aria-label="删除该行"
            onClick={() => {
              update(list.filter((_, currentIndex) => currentIndex !== index));
            }}
          />
        </div>
      ))}
      <Button
        type="dashed"
        icon={<PlusOutlined />}
        block
        onClick={() => update([...(list || []), { key: '', value: '' }])}
      >
        新增一行
      </Button>
    </div>
  );
}

function CapabilityProfilesEditor({
  value = defaultCapabilityProfiles(),
  onChange,
}: {
  value?: ImageCapabilityProfile[];
  onChange?: (next: ImageCapabilityProfile[]) => void;
}) {
  const profiles = normalizeCapabilityProfiles(value);
  const qualityOrder: ImageQualityTier[] = ['auto', 'low', 'medium', 'high'];

  function updateCell(tier: ImageCapabilityProfile['tier'], quality: ImageQualityTier, enabled: boolean, cost?: number | null) {
    onChange?.(profiles.map((item) => {
      if (item.tier !== tier) {
        return item;
      }
      const nextQualities = enabled
        ? Array.from(new Set([...item.qualities, quality])).sort((left, right) => qualityOrder.indexOf(left) - qualityOrder.indexOf(right))
        : item.qualities.filter((entry) => entry !== quality);
      return {
        ...item,
        qualities: nextQualities,
        costs: {
          auto: Math.max(0, Number(item.costs?.auto || 0)),
          low: Math.max(0, Number(item.costs?.low || 0)),
          medium: Math.max(0, Number(item.costs?.medium || 0)),
          high: Math.max(0, Number(item.costs?.high || 0)),
          ...(cost !== undefined && cost !== null ? { [quality]: Math.max(0, Number(cost || 0)) } : {}),
        },
      };
    }));
  }

  return (
    <div className="capability-matrix">
      <div className="capability-matrix__header capability-matrix__row">
        <div className="capability-matrix__tier">分辨率</div>
        {capabilityQualityOptions.map((option) => (
          <div key={option.value} className="capability-matrix__cell capability-matrix__cell--heading">
            <Text strong>{option.label}</Text>
          </div>
        ))}
      </div>
      {profiles.map((profile) => (
        <div key={profile.tier} className="capability-matrix__row">
          <div className="capability-matrix__tier">
            <Text strong>{profile.tier === 'auto' ? '自动' : profile.tier.toUpperCase()}</Text>
          </div>
          {qualityOrder.map((quality) => {
            const enabled = profile.qualities.includes(quality);
            return (
              <div key={`${profile.tier}_${quality}`} className={`capability-matrix__cell${enabled ? ' is-enabled' : ''}`}>
                <Checkbox
                  checked={enabled}
                  onChange={(event) => updateCell(profile.tier, quality, event.target.checked)}
                >
                  启用
                </Checkbox>
                <InputNumber
                  min={0}
                  precision={5}
                  step={0.00001}
                  disabled={!enabled}
                  value={profile.costs?.[quality] ?? 0}
                  placeholder="成本（元）"
                  style={{ width: '100%' }}
                  onChange={(next) => updateCell(profile.tier, quality, true, Number(next || 0))}
                />
              </div>
            );
          })}
        </div>
      ))}
      <div className="capability-matrix__note">
        <Text type="secondary">
          每个格子都是一个真实的“分辨率 + 质量”组合。勾选表示该上游支持该组合；成本按人民币元 / 张填写，用于记录该组合的上游单次成本，并为后续路由成本对比提供依据。
        </Text>
      </div>
    </div>
  );
}

export function UpstreamsPage({ catalog, saving, onSave, onDelete, onTest }: UpstreamsPageProps) {
  const [form] = Form.useForm<FormShape>();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editing, setEditing] = useState<ConsoleUpstream | null>(null);
  const [activeUpstreamTab, setActiveUpstreamTab] = useState<'image' | 'chat'>('image');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<UpstreamTestResult | null>(null);
  const [testError, setTestError] = useState('');

  const currentKind = Form.useWatch('kind', form) || 'images_endpoint';
  const selectedBananaModel = Form.useWatch(['bananaModelCapabilities', 0, 'model'], form);
  const currentImageEditProtocolModes = Form.useWatch('imageEditProtocolModes', form) || [];
  const currentResponseFormats = Form.useWatch('responseFormats', form) || [];
  const currentResponsesResponseFormats = Form.useWatch('responsesResponseFormats', form) || [];
  const responsesImageInputEnabled = Boolean(Form.useWatch('supportsImageInput', form));
  const jsonEditEnabled = currentImageEditProtocolModes.includes('json_image_url');
  const allowDirectPublicImageUrlEnabled = currentResponseFormats.includes('url');
  const allowDirectResponsesPublicImageUrlEnabled = currentResponsesResponseFormats.includes('url');
  const derivedImageRuntime = deriveImagesRuntimeFields({
    imageEditProtocolModes: currentImageEditProtocolModes,
    jsonReferenceTransports: Form.useWatch('jsonReferenceTransports', form) || [],
  });
  const testPreviewImages = useMemo(
    () => testResult ? collectTestPreviewImages(testResult) : [],
    [testResult],
  );
  const testResponseDisplay = useMemo(
    () => testResult ? buildTestResponseDisplay(testResult) : null,
    [testResult],
  );

  useEffect(() => {
    if (!allowDirectPublicImageUrlEnabled && form.getFieldValue('allowDirectPublicImageUrl')) {
      form.setFieldValue('allowDirectPublicImageUrl', false);
    }
  }, [allowDirectPublicImageUrlEnabled, form]);

  useEffect(() => {
    if (!allowDirectResponsesPublicImageUrlEnabled && form.getFieldValue('responsesAllowDirectPublicImageUrl')) {
      form.setFieldValue('responsesAllowDirectPublicImageUrl', false);
    }
  }, [allowDirectResponsesPublicImageUrlEnabled, form]);

  useEffect(() => {
    if (!responsesImageInputEnabled && (form.getFieldValue('responsesJsonReferenceTransports') || []).length) {
      form.setFieldValue('responsesJsonReferenceTransports', []);
    }
  }, [responsesImageInputEnabled, form]);

  function handleKindChange(kind: ConsoleUpstream['kind']) {
    form.setFieldsValue({
      kind,
      ...protocolDefaults(kind),
    });
  }

  function openCreate() {
    setEditing(null);
    setTestResult(null);
    setTestError('');
    form.setFieldsValue({
      ...toFormValues(emptyUpstream),
      ...protocolDefaults('images_endpoint'),
    });
    setDrawerOpen(true);
  }

  function openEdit(record: ConsoleUpstream) {
    setEditing(record);
    setTestResult(null);
    setTestError('');
    form.setFieldsValue(toFormValues(record));
    setDrawerOpen(true);
  }

  async function handleSave() {
    const values = await form.validateFields();
    const upstream = toUpstream(values, editing);
    await onSave(upstream);
    setDrawerOpen(false);
  }

  async function handleTest(testRequest: UpstreamTestRequest) {
    const values = await form.validateFields();
    const upstream = toUpstream(values, editing);
    setTesting(true);
    setTestError('');
    try {
      const result = await onTest(upstream, testRequest);
      setTestResult(result);
    } catch (error) {
      setTestError(error instanceof Error ? error.message : '测试失败');
      setTestResult(null);
    } finally {
      setTesting(false);
    }
  }

  async function runDraftTest(operation: 'generations' | 'edits' | 'responses' | 'chat_completions') {
    const values = await form.validateFields();
    await handleTest(buildDraftTestRequest(currentKind, values, operation));
  }

  return (
    <div className="page-stack">
      <PageHeader
        title="上游接入"
        desc="保存上游后会自动加入对应业务通道；线路开启和停用统一在“业务通道”中管理。"
        actions={<Button type="primary" onClick={openCreate}>新增上游</Button>}
      />

      <Card>
        <Tabs
          activeKey={activeUpstreamTab}
          onChange={(key) => setActiveUpstreamTab(key as 'image' | 'chat')}
          items={[
            {
              key: 'image',
              label: `图像生成（${(catalog?.upstreams || []).filter((item) => item.kind !== 'chat_completions').length}）`,
            },
            {
              key: 'chat',
              label: `聊天端口（${(catalog?.upstreams || []).filter((item) => item.kind === 'chat_completions').length}）`,
            },
          ]}
        />
        <Table
          rowKey="id"
          size="small"
          dataSource={(catalog?.upstreams || []).filter((item) => (
            activeUpstreamTab === 'chat'
              ? item.kind === 'chat_completions'
              : item.kind !== 'chat_completions'
          ))}
          pagination={false}
          columns={[
            { title: '名称', dataIndex: 'name' },
            { title: '协议类型', width: 180, render: (_, record) => kindOptions.find((item) => item.value === record.kind)?.label || record.kind },
            {
              title: '地址',
              dataIndex: 'baseUrl',
              width: 170,
              render: (value?: string) => <Text>{displayUpstreamHost(value || '')}</Text>,
            },
            {
              title: '图片上报',
              width: 130,
              render: (_, record) => <Text>{imageUploadFormats(record)}</Text>,
            },
            {
              title: '图片返回',
              width: 130,
              render: (_, record) => <Text>{imageReturnFormats(record)}</Text>,
            },
            {
              title: '状态',
              width: 120,
              render: (_, record) => record.enabled
                ? <StatusDot tone={healthTone(record.healthStatus)}>{healthLabel(record.healthStatus)}</StatusDot>
                : <StatusDot tone="neutral">停用</StatusDot>,
            },
            {
              title: '操作',
              width: 160,
              render: (_, record) => (
                <Space>
                  <Button size="small" type="link" onClick={() => openEdit(record)}>编辑</Button>
                  <Popconfirm
                    title="确认删除这条上游 API？"
                    description="删除后会同时从业务通道里移出，已保存的上游配置不可恢复。"
                    okText="确认删除"
                    cancelText="取消"
                    okButtonProps={{ danger: true }}
                    onConfirm={() => onDelete(record.id)}
                  >
                    <Button size="small" type="link" danger>删除</Button>
                  </Popconfirm>
                </Space>
              ),
            },
          ]}
        />
      </Card>

      <Drawer
        title={editing ? '编辑上游接入' : '新增上游接入'}
        open={drawerOpen}
        width={900}
        onClose={() => setDrawerOpen(false)}
        footer={
          <DrawerFooter>
            <Button onClick={() => setDrawerOpen(false)}>取消</Button>
            <Button type="primary" loading={saving} onClick={handleSave}>保存</Button>
          </DrawerFooter>
        }
      >
        <Form form={form} layout="vertical">
          <Form.Item name="id" hidden>
            <Input />
          </Form.Item>

          <Row gutter={16}>
            <Col span={12}>
              <Form.Item name="name" label="上游名称" rules={[{ required: true }]}>
                <Input placeholder="例如：正式主线路 1" />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="kind" label="上游协议类型" rules={[{ required: true }]}>
                <Select options={kindOptions} onChange={handleKindChange} />
              </Form.Item>
            </Col>
          </Row>

          <Row gutter={16}>
            <Col span={12}>
              <Form.Item
                name="baseUrl"
                label="基础地址"
                rules={[{ required: true }]}
                extra={currentKind === 'banana_endpoint'
                  ? '填写上游服务根地址或网关根路径，例如 https://sub.g-aisc.com/。系统会按固定协议请求 /v1beta/models/{model}:generateContent，不需要填写文生图或图生图两个地址。'
                  : '按原样保存并按原样请求你填写的地址。这里请直接填写上游真实完整 URL，系统不会自动补全路径。'}
              >
                <Input placeholder={currentKind === 'banana_endpoint' ? '例如 https://sub.g-aisc.com/' : '例如 https://example.com/v1/responses'} />
              </Form.Item>
            </Col>
              <Col span={12}>
                <Form.Item name="apiKey" label="API 密钥">
                  <Input.Password placeholder="留空则请求时不带鉴权头" />
                </Form.Item>
              </Col>
          </Row>

          <Card size="small" title="接入与路由归属" className="upstream-config-card">
            <Form.Item name="enabled" valuePropName="checked" hidden>
              <Switch />
            </Form.Item>
            <Row gutter={16}>
              <Col span={12}>
                <Form.Item name="healthStatus" hidden>
                  <Input />
                </Form.Item>
                <Form.Item label="当前线路状态">
                  <StatusDot tone={form.getFieldValue('enabled') ? healthTone(form.getFieldValue('healthStatus') || 'healthy') : 'neutral'}>
                    {form.getFieldValue('enabled') ? healthLabel(form.getFieldValue('healthStatus') || 'healthy') : '已在业务通道停用'}
                  </StatusDot>
                </Form.Item>
              </Col>
              {currentKind === 'banana_endpoint' ? (
                <Col span={12}>
                  <Form.Item label="下游请求模型匹配" extra="Banana 线路固定绑定下方选择的一个模型，系统会自动按该模型过滤路由。">
                    <Input value={selectedBananaModel || BANANA_MODELS[0].id} disabled />
                  </Form.Item>
                </Col>
              ) : (
              <Col span={12}>
                <Form.Item
                  name="modelHintsText"
                  label="下游请求模型匹配"
                  extra="填写一个下游模型名。留空则不按模型过滤路由。"
                >
                  <Input placeholder="例如 gpt-image-2" />
                </Form.Item>
              </Col>
              )}
              <Col span={12}>
                <Form.Item
                  name="maxConcurrency"
                  label="上游最大并发"
                  extra="限制该上游同一时间最多承载多少个图像请求。智能模式下占满后会尝试后续线路；全部占满时返回忙碌状态。"
                >
                  <InputNumber min={1} precision={0} style={{ width: '100%' }} />
                </Form.Item>
              </Col>
            </Row>
            <Alert
              type="info"
              showIcon
              message={`保存后自动加入${currentKind === 'chat_completions' ? '文本处理' : '图像生成'}业务通道`}
              description="如需暂停或恢复该线路，请保存后前往“业务通道”操作线路开关。"
            />
          </Card>

          {currentKind === 'images_endpoint' ? (
            <>
            <SectionTitle desc="按真实业务链路组织 Images 配置，避免把不相关的字段平铺在同一层。">Images Endpoint 配置</SectionTitle>
            <div className="upstream-config-grid">
              <Card size="small" title="文生图链路" className="upstream-config-card">
                <Row gutter={16}>
                  <Col span={24}>
                    <Form.Item name="supportsGenerations" label="启用文生图" valuePropName="checked">
                      <Switch />
                    </Form.Item>
                  </Col>
                  <Col span={24}>
                    <Form.Item
                      name="imagesGenerationsUrl"
                      label="文生图完整地址"
                      extra="当启用文生图时，这个地址就是网关实际请求的上游端点。"
                    >
                      <Input placeholder="https://provider.example.com/v1/images/generations" />
                    </Form.Item>
                  </Col>
                </Row>
              </Card>

              <Card size="small" title="图生图链路" className="upstream-config-card">
                <Row gutter={16}>
                  <Col span={24}>
                    <Form.Item name="supportsEdits" label="启用图生图" valuePropName="checked">
                      <Switch />
                    </Form.Item>
                  </Col>
                  <Col span={24}>
                    <Form.Item
                      name="imagesEditsUrl"
                      label="图生图完整地址"
                      extra="当启用图生图时，这个地址就是网关实际请求的上游端点。"
                    >
                      <Input placeholder="https://provider.example.com/v1/images/edits" />
                    </Form.Item>
                  </Col>
                  <Col span={24}>
                    <Form.Item
                      name="imageEditProtocolModes"
                      label="Supported Edit Protocols"
                      extra="这里记录该上游真实支持哪些 /v1/images/edits 协议形状。它是智能路由的筛选条件，不表示 multipart 与 JSON edits 可以等价互转。下游命中哪种 edits 协议，只会路由到声明支持同协议的上游。"
                    >
                      <Select mode="multiple" options={imageEditProtocolOptions} />
                    </Form.Item>
                  </Col>
                  <Col span={24}>
                    <Form.Item label="当前路由过滤规则">
                      <Input
                        disabled
                        value={
                          currentImageEditProtocolModes.includes('multipart_file_upload') && currentImageEditProtocolModes.includes('json_image_url')
                            ? '下游 multipart edits 只命中 multipart 上游；下游 JSON edits 只命中 JSON image_url 上游。'
                            : currentImageEditProtocolModes.includes('multipart_file_upload')
                              ? '该上游仅接受下游 multipart/form-data + image 文件上传请求。'
                              : '该上游仅接受下游 JSON edits 请求。'
                        }
                      />
                    </Form.Item>
                  </Col>
                </Row>
              </Card>

              <Card size="small" title="参考图与上游响应" className="upstream-config-card">
                <Row gutter={16}>
                  <Col span={24}>
                    <Form.Item
                      label="JSON Reference Payloads"
                      extra={
                        jsonEditEnabled
                          ? '这里只有在支持 JSON edits 时才有意义，表示上游 `images[].image_url` 实际接受普通 URL、Base64/data URL，还是两者都支持。'
                          : '当前未勾选 JSON edits，因此这里不会参与运行。若只支持 multipart，这是正常的。'
                      }
                    >
                      {jsonEditEnabled ? (
                        <Form.Item name="jsonReferenceTransports" noStyle>
                          <Select mode="multiple" options={jsonImageReferenceTransportOptions} />
                        </Form.Item>
                      ) : (
                        <Input value="未启用 JSON edits" disabled />
                      )}
                    </Form.Item>
                  </Col>
                  <Col span={24}>
                    <Form.Item label="JSON Reference Payload 自动策略">
                      <Input
                        disabled
                        value={
                          derivedImageRuntime.referenceImageTransport === 'inherit'
                            ? 'inherit：若上游同时支持 URL 与 Base64/data URL，则尽量保留当前 JSON 引用形式。'
                            : derivedImageRuntime.referenceImageTransport === 'base64'
                              ? 'base64：统一改写成 Base64 / data URL 再提交上游'
                              : 'url：统一改写成普通 URL 再提交上游'
                        }
                      />
                    </Form.Item>
                  </Col>
                  <Col span={24}>
                    <Form.Item
                      name="responseFormats"
                      label="支持的返回格式"
                      extra="与接入向导探测结果一致，声明该上游原生支持 URL、Base64 或两者都支持。"
                    >
                      <Select mode="multiple" options={[{ value: 'url', label: 'URL' }, { value: 'b64_json', label: 'Base64' }]} />
                    </Form.Item>
                  </Col>
                  <Col span={24}>
                    <Form.Item
                      name="allowDirectPublicImageUrl"
                      label="允许直传上游公网图片 URL"
                      valuePropName="checked"
                      extra="仅当支持的返回格式包含 URL 时可启用。启用后，当上游直接返回可公网访问的图片链接时，平台会优先保留该 URL，不再重新抓取并落盘；若上游返回的是 Base64 或 data URL，仍会按原逻辑转换。"
                    >
                      <Switch disabled={!allowDirectPublicImageUrlEnabled} />
                    </Form.Item>
                  </Col>
                  <Col span={24}>
                    <Form.Item
                      name="imageReturnMode"
                      label="上游原生响应模式"
                      extra="这里只决定请求上游时是否携带 stream=true。选择标准 JSON 时，即使下游请求 stream=true，也不会透传给上游；平台会在拿到完整图片后自行转为下游 SSE。"
                    >
                      <Select options={imageReturnModeOptions} />
                    </Form.Item>
                  </Col>
                </Row>
              </Card>

              <Card size="small" title="异步任务" className="upstream-config-card">
                <Row gutter={16}>
                  <Col span={24}>
                    <Form.Item
                      name="supportsAsync"
                      label="启用异步任务"
                      valuePropName="checked"
                      extra="只在上游确实提供异步提交和结果查询协议时开启。"
                    >
                      <Switch />
                    </Form.Item>
                  </Col>
                  <Col span={24}>
                    <Form.Item name="imagesAsyncGenerationsUrl" label="异步文生图地址">
                      <Input placeholder="https://provider.example.com/tasks/images/generations" />
                    </Form.Item>
                  </Col>
                  <Col span={24}>
                    <Form.Item name="imagesAsyncEditsUrl" label="异步图生图地址">
                      <Input placeholder="https://provider.example.com/tasks/images/edits" />
                    </Form.Item>
                  </Col>
                  <Col span={24}>
                    <Form.Item
                      name="imagesAsyncResultUrlTemplate"
                      label="异步结果查询地址模板"
                      extra="例如 https://provider.example.com/tasks/{id}"
                    >
                      <Input placeholder="https://provider.example.com/tasks/{id}" />
                    </Form.Item>
                  </Col>
                </Row>
              </Card>
            </div>

            <Card size="small" title="能力矩阵" className="upstream-config-card" style={{ marginTop: 16 }}>
              <Form.Item
                name="imagesCapabilityProfiles"
                label="支持的分辨率、质量与上游成本"
                extra="请按真实能力逐格勾选。每个已启用组合都可以填写对应的上游单次成本，既用于记录该线路成本，也用于约束该线路实际支持的分辨率与质量。"
              >
                <CapabilityProfilesEditor />
              </Form.Item>
            </Card>
            </>
          ) : null}

          {currentKind === 'responses_endpoint' ? (
            <>
              <SectionTitle desc="把 Responses 配置拆成协议层、图像能力层和默认运行偏好，避免把测试参数、协议结构和真实能力混在一起。">
                Responses Endpoint 配置
              </SectionTitle>

              <div className="upstream-config-grid">
                <Card size="small" title="协议结构层" className="upstream-config-card">
                  <Row gutter={16}>
                    <Col span={24}>
                      <Form.Item label="上游返回方式">
                        <Input value="固定 SSE（Responses 上游统一以 stream=true 请求）" disabled />
                      </Form.Item>
                    </Col>
                    <Col span={12}>
                      <Form.Item name="responsesTextModel" label="顶层文本模型">
                        <Input placeholder="例如 gpt-5.4-mini" />
                      </Form.Item>
                    </Col>
                    <Col span={12}>
                      <Form.Item name="responsesImageModel" label="图像工具模型">
                        <Input placeholder="例如 gpt-image-2，单顶层模式可留空" />
                      </Form.Item>
                    </Col>
                    <Col span={8}>
                      <Form.Item name="responsesInputShape" label="输入结构">
                        <Select options={responsesInputShapeOptions} />
                      </Form.Item>
                    </Col>
                    <Col span={8}>
                      <Form.Item name="responsesModelRouting" label="模型路由方式">
                        <Select options={responsesModelRoutingOptions} />
                      </Form.Item>
                    </Col>
                    <Col span={8}>
                      <Form.Item name="responsesReasoningEffort" label="推理强度">
                        <Select options={reasoningEffortOptions} />
                      </Form.Item>
                    </Col>
                    <Col span={12}>
                      <Form.Item name="responsesToolChoice" label="图像工具指定方式">
                        <Select options={responsesToolChoiceOptions} />
                      </Form.Item>
                    </Col>
                    <Col span={12}>
                      <Form.Item name="responsesToolChoiceFormat" label="tool_choice 提交格式">
                        <Select options={responsesToolChoiceFormatOptions} />
                      </Form.Item>
                    </Col>
                    <Col span={24}>
                      <Form.Item name="responsesModerationMode" label="moderation 策略">
                        <Select options={responsesModerationModeOptions} />
                      </Form.Item>
                    </Col>
                  </Row>
                </Card>

                <Card size="small" title="图像输入能力层" className="upstream-config-card">
                  <Row gutter={16}>
                    <Col span={24}>
                      <Form.Item
                        name="supportsImageInput"
                        label="支持参考图输入"
                        valuePropName="checked"
                        extra="这里声明 Responses 图像工具是否支持图生图。关闭后，智能路由不会把带参考图的任务派发到这条线路。"
                      >
                        <Switch />
                      </Form.Item>
                    </Col>
                    <Col span={24}>
                      <Form.Item
                        label="支持的参考图传输格式"
                        extra={
                          responsesImageInputEnabled
                            ? '声明 input[].content 中的 input_image.image_url 实际支持普通 URL、Base64/data URL，还是两者都支持。运行时会按这里的能力决定是否需要改写引用。'
                            : '当前已关闭参考图输入，这里不会参与运行。'
                        }
                      >
                        {responsesImageInputEnabled ? (
                          <Form.Item name="responsesJsonReferenceTransports" noStyle>
                            <Select mode="multiple" options={jsonImageReferenceTransportOptions} />
                          </Form.Item>
                        ) : (
                          <Input value="未启用参考图输入" disabled />
                        )}
                      </Form.Item>
                    </Col>
                    <Col span={24}>
                      <Form.Item label="当前输入适配规则">
                        <Input
                          disabled
                          value={
                            !responsesImageInputEnabled
                              ? '该线路不接收参考图。'
                              : (form.getFieldValue('responsesJsonReferenceTransports') || []).includes('url')
                                && (form.getFieldValue('responsesJsonReferenceTransports') || []).includes('base64')
                                ? '运行时尽量保留原始引用形态；URL 与 Base64/data URL 都可透传。'
                                : (form.getFieldValue('responsesJsonReferenceTransports') || []).includes('base64')
                                  ? '运行时会优先改写成 Base64 / data URL 再提交 Responses input_image。'
                                  : '运行时会优先保留或改写成普通 URL 再提交 Responses input_image。'
                          }
                        />
                      </Form.Item>
                    </Col>
                  </Row>
                </Card>

                <Card size="small" title="图像输出能力层" className="upstream-config-card">
                  <Row gutter={16}>
                    <Col span={24}>
                      <Form.Item
                        name="responsesResponseFormats"
                        label="支持的返回格式"
                        extra="这里记录该 Responses 上游真实会产出图片 URL、Base64，还是两者都可能出现。它和探测结论、运行时结果处理保持一致。"
                      >
                        <Select mode="multiple" options={responseFormatOptions} />
                      </Form.Item>
                    </Col>
                    <Col span={24}>
                      <Form.Item
                        name="responsesAllowDirectPublicImageUrl"
                        label="允许保留上游公网图片 URL"
                        valuePropName="checked"
                        extra="仅当返回格式包含 URL 时可启用。启用后，若 Responses 结果直接给出可公网访问的图片链接，平台会优先保留该 URL，不再强制重新抓取落盘。"
                      >
                        <Switch disabled={!allowDirectResponsesPublicImageUrlEnabled} />
                      </Form.Item>
                    </Col>
                  </Row>
                </Card>

                <Card size="small" title="默认运行偏好" className="upstream-config-card">
                  <Row gutter={16}>
                    <Col span={12}>
                      <Form.Item
                        name="responsesImageToolQuality"
                        label="默认图像工具质量"
                        extra="仅在下游请求没有显式给出质量时兜底，不会覆盖下游真实传参。"
                      >
                        <Select allowClear options={imageToolQualityOptions} />
                      </Form.Item>
                    </Col>
                    <Col span={12}>
                      <Form.Item
                        name="responsesImageQuality"
                        label="默认图像压缩率"
                        extra="仅在下游没有显式给出 output_compression / image_quality 时兜底。"
                      >
                        <InputNumber min={0} max={100} style={{ width: '100%' }} />
                      </Form.Item>
                    </Col>
                  </Row>
                </Card>
              </div>

              <Card size="small" title="能力矩阵" className="upstream-config-card" style={{ marginTop: 16 }}>
                <Form.Item
                  name="responsesCapabilityProfiles"
                  label="支持的分辨率、质量与上游成本"
                  extra="Responses 图像工具也按完整矩阵维护真实能力与对应成本，路由阶段会按这里的启用状态做资格筛选。"
                >
                  <CapabilityProfilesEditor />
                </Form.Item>
              </Card>
            </>
          ) : null}

          {currentKind === 'banana_endpoint' ? (
            <>
              <SectionTitle desc="Banana 使用 Gemini generateContent 原生协议。一条上游只绑定一个模型；模型、K 档位、比例和参考图能力都是路由硬条件。">
                Banana / Gemini 图像配置
              </SectionTitle>
              <Card size="small" className="upstream-config-card">
                <Row gutter={16}>
                  <Col span={8}>
                    <Form.Item name="bananaAuthMode" label="上游鉴权方式">
                      <Select options={[
                        { value: 'x_goog_api_key', label: 'x-goog-api-key' },
                        { value: 'bearer', label: 'Bearer' },
                        { value: 'both', label: '同时携带两者' },
                      ]} />
                    </Form.Item>
                  </Col>
                  <Col span={8}><Form.Item name="bananaSupportsTextToImage" label="支持文生图" valuePropName="checked"><Switch /></Form.Item></Col>
                  <Col span={8}><Form.Item name="bananaSupportsImageToImage" label="支持图生图" valuePropName="checked"><Switch /></Form.Item></Col>
                  <Col span={24}>
                    <Form.Item name="bananaGenerationPathPrefix" label="生成接口路径前缀" extra="基础地址填写域名或网关根路径；系统将请求 /v1beta/models/{model}:generateContent。">
                      <Input placeholder="/v1beta/models" />
                    </Form.Item>
                  </Col>
                </Row>
              </Card>
              <Card size="small" title="固定模型能力与上游成本（元 / 张）" className="upstream-config-card" style={{ marginTop: 16 }}>
                <Alert
                  type="info"
                  showIcon
                  style={{ marginBottom: 16 }}
                  message="一个 Banana 上游配置只代表一个模型"
                  description="选择该线路实际调用的模型后，只填写一次固定上游成本。K 档位、比例和参考图仅用于能力过滤与请求审计；成本为 0 是有效配置。"
                />
                <Row gutter={12}>
                  <Col span={8}>
                    <Form.Item name={['bananaModelCapabilities', 0, 'model']} label="绑定模型" rules={[{ required: true }]}>
                      <Select options={BANANA_MODELS.map((item) => ({ value: item.id, label: `${item.label} (${item.id})` }))} />
                    </Form.Item>
                  </Col>
                  <Col span={8}>
                    <Form.Item name={['bananaModelCapabilities', 0, 'imageSizes']} label="支持图像尺寸">
                      <Select mode="multiple" options={['1k', '2k', '4k'].map((value) => ({ value, label: value.toUpperCase() }))} />
                    </Form.Item>
                  </Col>
                  <Col span={8}>
                    <Form.Item name={['bananaModelCapabilities', 0, 'aspectRatios']} label="支持比例">
                      <Select mode="tags" placeholder="例如 1:1、16:9" />
                    </Form.Item>
                  </Col>
                  <Col span={8}>
                    <Form.Item name={['bananaModelCapabilities', 0, 'supportsReferenceImages']} label="支持参考图" valuePropName="checked">
                      <Switch />
                    </Form.Item>
                  </Col>
                  <Col span={8}><Form.Item name={['bananaModelCapabilities', 0, 'cost']} label="上游固定成本（元 / 张）"><InputNumber min={0} precision={5} step={0.00001} style={{ width: '100%' }} /></Form.Item></Col>
                </Row>
              </Card>
              <Card size="small" title="测试预设" className="upstream-config-card" style={{ marginTop: 16 }}>
                <Row gutter={12}>
                  <Col span={8}>
                    <Form.Item name="testOperation" label="测试类型">
                      <Select options={[
                        { value: 'generations', label: '文生图' },
                        { value: 'edits', label: '图生图' },
                      ]} />
                    </Form.Item>
                  </Col>
                  <Col span={8}>
                    <Form.Item label="测试模型">
                      <Input value={selectedBananaModel || BANANA_MODELS[0].id} disabled />
                    </Form.Item>
                  </Col>
                  <Col span={8}>
                    <Form.Item name="testSize" label="测试 imageSize">
                      <Select options={['1k', '2k', '4k'].map((value) => ({ value, label: value.toUpperCase() }))} />
                    </Form.Item>
                  </Col>
                  <Col span={24}>
                    <Form.Item name="testReferenceImageUrl" label="图生图参考图 URL" extra="仅选择“图生图”测试时会下载为 Base64，并按 Python 示例写入 contents[].parts[].inlineData。">
                      <Input placeholder="https://example.com/reference.png" />
                    </Form.Item>
                  </Col>
                </Row>
              </Card>
            </>
          ) : null}

          {currentKind === 'chat_completions' ? (
            <Row gutter={16}>
              <Col span={8}>
                <Form.Item
                  name="chatUpstreamCostYuan"
                  label="上游固定成本（元 / 成功次）"
                  extra="仅用于成本和毛利报表，不改变统一售价或租户实际扣费。"
                >
                  <InputNumber min={0} precision={5} step={0.00001} style={{ width: '100%' }} />
                </Form.Item>
              </Col>
              <Col span={8}><Form.Item name="supportsSystemPrompt" label="支持系统提示词" valuePropName="checked"><Switch /></Form.Item></Col>
              <Col span={8}><Form.Item name="supportsJsonMode" label="支持 JSON 模式" valuePropName="checked"><Switch /></Form.Item></Col>
              <Col span={8}><Form.Item name="supportsTools" label="支持工具调用" valuePropName="checked"><Switch /></Form.Item></Col>
              <Col span={8}><Form.Item name="supportsVisionInput" label="支持视觉输入" valuePropName="checked"><Switch /></Form.Item></Col>
            </Row>
          ) : null}

          <SectionTitle desc="这里只保留真正的个性化补丁参数。标准字段如 stream、response_format、output_format、size、quality 会由协议设置、测试预设和下游真实请求决定。">
            高级补丁字段
          </SectionTitle>

          <Alert
            type="info"
            showIcon
            message="这里可以处理不完全标准的上游"
            description="固定追加字段是兜底逃生口，只适合 force_firefly=true 这类上游私有参数；常规模型、尺寸、质量、返回格式、流式方式都应使用上面的正式配置或测试预设。"
            style={{ marginBottom: 16 }}
          />

          <Form.Item name="injectHeadersList" label="固定追加的请求头">
            <KeyValueEditor keyPlaceholder="请求头名称" valuePlaceholder="请求头值" />
          </Form.Item>

          <Form.Item name="injectBodyFieldsList" label="固定追加的请求体字段">
            <KeyValueEditor keyPlaceholder="字段名，例如 force_firefly" valuePlaceholder="字段值，例如 true" />
          </Form.Item>

          <Paragraph type="secondary" style={{ marginTop: -8 }}>
            固定追加字段会直接合并进最终上游请求体，但系统会自动拦截标准协议字段，避免覆盖正常请求结构。字段值支持自动识别类型：`true` / `false` 会按布尔值发送，纯数字会按数字发送，`{"{"}...{"}"}` 或 `[...]` 会按 JSON 发送，其他内容按字符串发送。
          </Paragraph>

          <Form.Item name="notes" label="备注">
            <Input.TextArea rows={4} placeholder="记录这个上游的限制、特性、适用场景、调试说明" />
          </Form.Item>

          <SectionTitle desc="不同接口类型各自维护测试参数，不会把 Responses、Images、Chat 的模型字段混在一起。">
            测试预设
          </SectionTitle>

          {currentKind === 'images_endpoint' ? (
            <>
              <Row gutter={16}>
                <Col span={8}>
                  <Form.Item name="testOperation" label="默认测试类型">
                    <Select options={[
                      { value: 'generations', label: '文生图' },
                      { value: 'edits', label: '图生图' },
                    ]} />
                  </Form.Item>
                </Col>
                <Col span={16}>
                  <Form.Item name="testModel" label="图像模型">
                    <Input placeholder="例如 gpt-image-2" />
                  </Form.Item>
                </Col>
              </Row>

              <Form.Item name="testPrompt" label="默认测试提示词">
                <Input.TextArea rows={3} placeholder="例如：一只小猫，干净背景，自然光，不要文字" />
              </Form.Item>

              <Row gutter={16}>
                <Col span={8}>
                  <Form.Item name="testSize" label="默认测试尺寸">
                    <Input placeholder="例如 1600x1200" />
                  </Form.Item>
                </Col>
                <Col span={8}>
                  <Form.Item name="testQuality" label="默认测试质量">
                    <Select allowClear options={qualityOptions} />
                  </Form.Item>
                </Col>
                <Col span={8}>
                  <Form.Item name="testResponseFormat" label="返回格式">
                    <Select allowClear options={responseFormatOptions} />
                  </Form.Item>
                </Col>
              </Row>

              <Row gutter={16}>
                <Col span={8}>
                  <Form.Item name="testOutputFormat" label="输出图片格式">
                    <Select allowClear options={outputFormatOptions} />
                  </Form.Item>
                </Col>
                <Col span={8}>
                  <Form.Item name="testOutputCompression" label="output_compression">
                    <InputNumber min={0} max={100} precision={0} style={{ width: '100%' }} />
                  </Form.Item>
                </Col>
                <Col span={8}>
                  <Form.Item name="testBackground" label="background">
                    <Select allowClear options={backgroundOptions} />
                  </Form.Item>
                </Col>
              </Row>

              <Row gutter={16}>
                <Col span={8}>
                  <Form.Item name="testModeration" label="moderation 策略">
                    <Select allowClear options={moderationOptions} />
                  </Form.Item>
                </Col>
                <Col span={8}>
                  <Form.Item name="testStream" label="是否流式返回" valuePropName="checked">
                    <Switch />
                  </Form.Item>
                </Col>
              </Row>

              <Row gutter={16}>
                <Col span={12}>
                  <Form.Item name="testReferenceImageUrl" label="默认参考图 URL">
                    <Input placeholder="图生图测试时使用的公网图片地址" />
                  </Form.Item>
                </Col>
                <Col span={6}>
                  <Form.Item name="testN" label="n">
                    <InputNumber min={1} max={10} style={{ width: '100%' }} />
                  </Form.Item>
                </Col>
              </Row>
            </>
          ) : null}

          {currentKind === 'responses_endpoint' ? (
            <>
              <SectionTitle desc="这里仅配置测试时的生成条件。顶层文本模型、图像工具模型、推理强度、输入结构会复用上方「固定适配规则」；Responses 接入测试统一固定以 SSE 请求上游。">
                测试预设
              </SectionTitle>

              <Form.Item name="testPrompt" label="默认测试提示词">
                <Input.TextArea rows={3} placeholder="例如：一只小猫，干净背景，自然光，不要文字" />
              </Form.Item>

              <SectionTitle>请求级默认值</SectionTitle>
              <Row gutter={16}>
                <Col span={8}>
                  <Form.Item name="testSize" label="默认测试尺寸">
                    <Input placeholder="例如 auto、1536x1024 或 1024x1024" />
                  </Form.Item>
                </Col>
                <Col span={8}>
                  <Form.Item name="testQuality" label="图像工具质量">
                    <Select allowClear options={imageToolQualityOptions} />
                  </Form.Item>
                </Col>
                <Col span={8}>
                  <Form.Item name="testImageQuality" label="图像压缩率">
                    <InputNumber min={0} max={100} style={{ width: '100%' }} />
                  </Form.Item>
                </Col>
              </Row>

              <Row gutter={16}>
                <Col span={8}>
                  <Form.Item name="testModeration" label="moderation 策略">
                    <Select allowClear options={moderationOptions} />
                  </Form.Item>
                </Col>
                <Col span={8}>
                  <Form.Item name="testOutputFormat" label="输出图片格式">
                    <Select allowClear options={outputFormatOptions} />
                  </Form.Item>
                </Col>
                <Col span={8}>
                  <Form.Item name="testBackground" label="background">
                    <Select allowClear options={backgroundOptions} />
                  </Form.Item>
                </Col>
              </Row>

              <Row gutter={16}>
                <Col span={24}>
                  <Form.Item name="testReferenceImageUrl" label="默认参考图 URL">
                    <Input placeholder="多模态测试时使用的公网图片地址" />
                  </Form.Item>
                </Col>
              </Row>
            </>
          ) : null}

          {currentKind === 'chat_completions' ? (
            <>
              <Row gutter={16}>
                <Col span={8}>
                  <Form.Item name="testOperation" label="默认测试类型">
                    <Select options={[
                      { value: 'chat_completions', label: '聊天理解' },
                    ]} />
                  </Form.Item>
                </Col>
                <Col span={16}>
                  <Form.Item name="testModel" label="聊天模型">
                    <Input placeholder="例如 gpt-4.1-mini" />
                  </Form.Item>
                </Col>
              </Row>

              <Form.Item name="testPrompt" label="默认测试提示词">
                <Input.TextArea rows={3} placeholder="例如：请描述这张图里的主体、背景与风格" />
              </Form.Item>

              <Row gutter={16}>
                <Col span={12}>
                  <Form.Item name="testReferenceImageUrl" label="默认视觉输入 URL">
                    <Input placeholder="视觉理解测试时使用的公网图片地址" />
                  </Form.Item>
                </Col>
                <Col span={12}>
                  <Form.Item name="testStream" label="是否流式返回" valuePropName="checked">
                    <Switch />
                  </Form.Item>
                </Col>
              </Row>
            </>
          ) : null}

          <SectionTitle desc="使用当前抽屉里的草稿配置直接请求上游，不需要先保存。适合调试自定义字段、特殊 Header、参考图方式。">
            边改边测
          </SectionTitle>

          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 12 }}
            message="这里展示的是单次上游调试口径"
            description="测试结果里的成功或失败，只表示这次调试请求是否从上游拿到了预期响应。它不等于业务统计页里的生成成功率，也不等于路由诊断页里的线路运行态成功率。"
          />

          <Space wrap>
            <Button loading={testing} onClick={() => runDraftTest(currentKind === 'responses_endpoint' ? 'responses' : currentKind === 'chat_completions' ? 'chat_completions' : 'generations')}>
              {currentKind === 'responses_endpoint' ? '测试 Responses 图像工具' : currentKind === 'chat_completions' ? '测试聊天理解' : '测试文生图'}
            </Button>
            <Button
              loading={testing}
              onClick={() => runDraftTest(currentKind === 'images_endpoint' ? 'edits' : currentKind === 'responses_endpoint' ? 'responses' : 'chat_completions')}
            >
              {currentKind === 'images_endpoint' ? '测试图生图' : currentKind === 'responses_endpoint' ? '测试带参考图的 Responses' : '测试视觉理解'}
            </Button>
          </Space>

          {testError ? <Alert style={{ marginTop: 16 }} type="error" showIcon message={testError} /> : null}

          {testResult ? (
            <Card size="small" style={{ marginTop: 16 }} title="测试结果">
              <Paragraph><Text strong>总结：</Text>{testResult.summary}</Paragraph>
              <SectionTitle>发送给上游的请求</SectionTitle>
              <CodeBlock value={testResult.requestPlan} maxHeight={280} />
              <div style={{ height: 12 }} />
              <SectionTitle>上游响应</SectionTitle>
              <CodeBlock value={testResponseDisplay || testResult.response} maxHeight={280} />
              {testPreviewImages.length ? (
                <>
                  <div style={{ height: 16 }} />
                  <SectionTitle desc="直接根据本次上游真实响应中的 URL 或 Base64 图像负载渲染。">
                    生成图片
                  </SectionTitle>
                  <div className="upstream-test-preview-grid">
                    {testPreviewImages.map((image, index) => (
                      <figure className="upstream-test-preview" key={`${image.source}-${index}`}>
                        <img src={image.url} alt={`上游测试生成结果 ${index + 1}`} />
                        <figcaption>
                          <Text type="secondary">{image.source}</Text>
                          {/^https?:\/\//i.test(image.url) ? (
                            <Button type="link" size="small" href={image.url} target="_blank" rel="noreferrer">
                              打开原图
                            </Button>
                          ) : null}
                        </figcaption>
                      </figure>
                    ))}
                  </div>
                </>
              ) : null}
            </Card>
          ) : null}
        </Form>
      </Drawer>
    </div>
  );
}
