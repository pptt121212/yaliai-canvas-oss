import type {
  OpenAIImagesEditProtocol,
  OpenAIImagesOperation,
  OpenAIImagesRequest,
  ProviderConfig,
  UpstreamRequestPlan,
} from './types.js';
import { resolveOpenAIEndpointUrl } from './openaiPaths.js';

declare const Buffer: any;

const reservedImagesBodyFields = new Set([
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

const fixedImagesBodyFields = [
  'model',
  'prompt',
  'size',
  'response_format',
  'quality',
  'n',
  'user',
  'image',
];

const fixedImagesExtraBodyFields = [
  'stream',
  'output_format',
  'output_quality',
  'output_compression',
  'background',
  'moderation',
  'async',
  'callback_url',
] as const;

const originalMultipartImageFileNamesMetadataKey = '__yali_original_multipart_image_file_names';

function joinOpenAIImagesPath(provider: ProviderConfig, operation: OpenAIImagesOperation): string {
  const metadataKey = operation === 'edits' ? 'images_edits_url' : 'images_generations_url';
  const configuredUrl = String(provider.metadata?.[metadataKey] || '').trim();
  if (/^https?:\/\//i.test(configuredUrl)) {
    return configuredUrl;
  }
  return resolveOpenAIEndpointUrl(provider.baseUrl, `/v1/images/${operation}`);
}

function imagesReturnMode(provider: ProviderConfig, request: OpenAIImagesRequest) {
  void request;
  return String(provider.metadata?.images_return_mode || 'json') === 'stream' ? 'stream' : 'json';
}

export function supportedImagesEditProtocols(provider: ProviderConfig): OpenAIImagesEditProtocol[] {
  const raw = provider.metadata?.images_edit_protocols;
  if (Array.isArray(raw)) {
    const ordered: OpenAIImagesEditProtocol[] = ['multipart_file_upload', 'json_image_url'];
    const filtered = new Set<OpenAIImagesEditProtocol>(
      raw.filter((item): item is OpenAIImagesEditProtocol => (
        item === 'multipart_file_upload' || item === 'json_image_url'
      )) as OpenAIImagesEditProtocol[],
    );
    if (filtered.size) {
      return ordered.filter((item) => filtered.has(item));
    }
  }

  const legacyReferenceMode = String(provider.metadata?.images_edit_reference_mode || '').trim().toLowerCase();
  const legacyRequestFormat = String(provider.metadata?.images_edit_request_format || '').trim().toLowerCase();
  const imageInputMode = String(provider.metadata?.images_image_input_mode || provider.metadata?.image_input_mode || '').trim().toLowerCase();

  if (legacyReferenceMode === 'json_image_url' || legacyRequestFormat === 'json' || imageInputMode === 'url_only') {
    return ['json_image_url'];
  }
  if (imageInputMode === 'url_or_multipart') {
    return ['multipart_file_upload', 'json_image_url'];
  }
  return ['multipart_file_upload'];
}

function requestedImagesEditProtocolHint(request: OpenAIImagesRequest): OpenAIImagesEditProtocol | null {
  const raw = request.metadata?.yali_requested_edit_protocol;
  return raw === 'multipart_file_upload' || raw === 'json_image_url' ? raw : null;
}

function supportedJsonReferenceTransports(provider: ProviderConfig): Array<'url' | 'base64'> {
  const raw = provider.metadata?.images_json_reference_transports;
  if (Array.isArray(raw)) {
    const ordered: Array<'url' | 'base64'> = ['url', 'base64'];
    const filtered = new Set<'url' | 'base64'>(
      raw.filter((item): item is 'url' | 'base64' => item === 'url' || item === 'base64') as Array<'url' | 'base64'>,
    );
    if (filtered.size) {
      return ordered.filter((item) => filtered.has(item));
    }
  }

  const legacy = String(provider.metadata?.reference_image_transport || 'inherit').trim().toLowerCase();
  if (legacy === 'url' || legacy === 'base64') {
    return [legacy];
  }

  return ['url', 'base64'];
}

function detectImageExtensionFromBuffer(buffer: any) {
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

function contentTypeForExtension(ext: string) {
  if (ext === 'jpg' || ext === 'jpeg') {
    return 'image/jpeg';
  }
  if (ext === 'webp') {
    return 'image/webp';
  }
  return 'image/png';
}

function decodeImagePayloadToBase64(value: string) {
  const raw = String(value || '').trim();
  const dataUrlMatch = raw.match(/^data:image\/([a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/i);
  if (dataUrlMatch) {
    const extension = String(dataUrlMatch[1] || 'png').toLowerCase() === 'jpeg'
      ? 'jpg'
      : String(dataUrlMatch[1] || 'png').toLowerCase();
    return {
      base64: dataUrlMatch[2].replace(/\s+/g, ''),
      extension,
    };
  }
  const normalized = raw.replace(/\s+/g, '');
  if (normalized.length >= 64 && /^[A-Za-z0-9+/=]+$/.test(normalized)) {
    const buffer = Buffer.from(normalized, 'base64');
    return {
      base64: normalized,
      extension: detectImageExtensionFromBuffer(buffer),
    };
  }
  return null;
}

function imageStringsFromRequest(request: OpenAIImagesRequest) {
  const imageValues = request.image != null
    ? (Array.isArray(request.image) ? request.image : [request.image])
    : [];
  const referenceValues = Array.isArray(request.reference_images)
    ? request.reference_images
        .map((item) => {
          if (typeof item === 'string') {
            return item;
          }
          if (!item || typeof item !== 'object') {
            return '';
          }
          return String(
            item.image_url
            || item.download_url
            || item.remote_reference_url
            || item.url
            || '',
          ).trim();
        })
        .filter(Boolean)
    : [];
  const raw = imageValues.length ? imageValues : referenceValues;
  if (!raw.length) {
    return [] as string[];
  }
  return raw
    .map((item) => String(item || '').trim())
    .filter(Boolean);
}

function normalizeReferenceImageInstructionText(value: unknown) {
  const text = String(value || '').trim();
  if (!text) {
    return '';
  }
  if (text.startsWith('下方图片：') || text.startsWith('下方图片:')) {
    return text;
  }
  return `下方图片：${text}`;
}

function normalizedReferenceImageInstructions(request: OpenAIImagesRequest, referenceCount: number) {
  const raw = Array.isArray(request.reference_image_instructions)
    ? request.reference_image_instructions
    : typeof request.reference_image_instructions === 'string'
      ? [request.reference_image_instructions]
      : [];
  return Array.from({ length: Math.max(0, referenceCount) }, (_, index) => (
    normalizeReferenceImageInstructionText(raw[index])
  ));
}

function normalizeDirectImageEditInstructionText(value: unknown) {
  const text = String(value || '').trim();
  if (!text) {
    return '';
  }

  if (text.startsWith('参考图')) {
    let rest = text.slice('参考图'.length).trim();
    if (rest) {
      if (rest.startsWith('：') || rest.startsWith(':')) {
        return rest.replace(/^[：:]+/, '').trim();
      }
      if (rest.startsWith('#')) {
        rest = rest.slice(1).trim();
      }
      const multipartMatch = rest.match(/^\d+\s*@reference-[^\s：:]+[：:]\s*(.+)$/iu);
      if (multipartMatch?.[1]) {
        return String(multipartMatch[1]).trim();
      }
      const simpleMatch = rest.match(/^\d+\s*[：:]\s*(.+)$/u);
      if (simpleMatch?.[1]) {
        return String(simpleMatch[1]).trim();
      }
    }
  }

  const englishMatch = text.match(/^reference image\s*#?\d+\s*:\s*(.+)$/iu);
  if (englishMatch?.[1]) {
    return String(englishMatch[1]).trim();
  }

  return text;
}

function trimDirectImageBelowImagePrefix(value: string) {
  for (const prefix of ['下方图片：', '下方图片:']) {
    if (value.startsWith(prefix)) {
      return value.slice(prefix.length).trim();
    }
  }
  return value;
}

function inferImageExtensionFromUrlPath(value: string) {
  try {
    const url = new URL(value);
    const ext = String(url.pathname || '').match(/\.([a-zA-Z0-9]+)$/)?.[1]?.toLowerCase() || '';
    if (ext === 'jpeg') {
      return 'jpg';
    }
    if (ext === 'jpg' || ext === 'png' || ext === 'webp') {
      return ext;
    }
  } catch {
    return '';
  }
  return '';
}

function inferReferenceImageExtension(value: string) {
  const decoded = decodeImagePayloadToBase64(value);
  if (decoded?.extension) {
    return decoded.extension;
  }
  if (/^https?:\/\//i.test(value)) {
    return inferImageExtensionFromUrlPath(value) || 'png';
  }
  const ext = String(value || '').match(/\.([a-zA-Z0-9]+)$/)?.[1]?.toLowerCase() || '';
  if (ext === 'jpeg') {
    return 'jpg';
  }
  if (ext === 'jpg' || ext === 'png' || ext === 'webp') {
    return ext;
  }
  return 'png';
}

function buildMultipartReferenceFileNames(images: string[]) {
  return images.map((image, index) => `reference-${index + 1}.${inferReferenceImageExtension(image)}`);
}

function resolveMultipartReferenceFileNames(request: OpenAIImagesRequest, images: string[]) {
  const configured = request.metadata?.[originalMultipartImageFileNamesMetadataKey];
  const originalNames = Array.isArray(configured)
    ? configured.map((item) => String(item || '').trim())
    : [];
  const fallbackNames = buildMultipartReferenceFileNames(images);
  return fallbackNames.map((fallbackName, index) => originalNames[index] || fallbackName);
}

function buildDirectImageReferenceLine(index: number, instruction: unknown, fileName = '') {
  let normalizedInstruction = normalizeDirectImageEditInstructionText(instruction);
  const normalizedFileName = String(fileName || '').trim();
  if (normalizedFileName) {
    normalizedInstruction = trimDirectImageBelowImagePrefix(normalizedInstruction);
  }
  if (!normalizedInstruction) {
    normalizedInstruction = '参考图片';
  }
  if (normalizedFileName) {
    return `参考图${index + 1} @${normalizedFileName}：${normalizedInstruction}`;
  }
  return `参考图${index + 1}：${normalizedInstruction}`;
}

function buildImagesEditPrompt(
  request: OpenAIImagesRequest,
  referenceCount: number,
  referenceFileNames: string[] = [],
) {
  const prompt = String(request.prompt || '').trim();
  if (referenceCount <= 0) {
    return prompt;
  }
  const instructions = normalizedReferenceImageInstructions(request, referenceCount);
  const segments = [`整体生成图片要求：${prompt}`];
  for (let index = 0; index < referenceCount; index += 1) {
    segments.push(buildDirectImageReferenceLine(index, instructions[index], referenceFileNames[index]));
  }
  return segments.join('\n\n');
}

function classifyReferenceImageValue(value: string) {
  const raw = String(value || '').trim();
  if (!raw) {
    return 'unknown' as const;
  }
  if (/^https?:\/\//i.test(raw)) {
    return 'url' as const;
  }
  if (decodeImagePayloadToBase64(raw)) {
    return 'base64' as const;
  }
  return 'unknown' as const;
}

function resolveImagesEditBodyFormat(provider: ProviderConfig, request: OpenAIImagesRequest) {
  const images = imageStringsFromRequest(request);
  if (!images.length) {
    return 'json' as const;
  }
  const protocols = supportedImagesEditProtocols(provider);
  const requestedProtocol = requestedImagesEditProtocolHint(request);
  if (requestedProtocol === 'multipart_file_upload') {
    if (!protocols.includes('multipart_file_upload')) {
      throw new Error('upstream_multipart_edit_protocol_not_supported');
    }
    return 'multipart' as const;
  }
  if (requestedProtocol === 'json_image_url') {
    if (!protocols.includes('json_image_url')) {
      throw new Error('upstream_json_image_url_edit_protocol_not_supported');
    }
    return 'json' as const;
  }
  if (!protocols.includes('json_image_url')) {
    return 'multipart' as const;
  }

  const jsonTransports = supportedJsonReferenceTransports(provider);
  const hasEncodedReference = images.some((item) => classifyReferenceImageValue(item) === 'base64');
  if (hasEncodedReference && !jsonTransports.includes('base64')) {
    return protocols.includes('multipart_file_upload') ? 'multipart' : 'json';
  }
  return 'json' as const;
}

function resolveJsonReferenceTransport(provider: ProviderConfig, request: OpenAIImagesRequest) {
  const protocols = supportedImagesEditProtocols(provider);
  if (!protocols.includes('json_image_url')) {
    return 'inherit' as const;
  }

  const transports = supportedJsonReferenceTransports(provider);
  if (transports.length === 1) {
    return transports[0] as 'url' | 'base64';
  }

  const imageValues = imageStringsFromRequest(request);
  const hasUrlReference = imageValues.some((item) => classifyReferenceImageValue(item) === 'url');
  const hasEncodedReference = imageValues.some((item) => classifyReferenceImageValue(item) === 'base64');

  if (hasEncodedReference && !hasUrlReference && transports.includes('base64')) {
    return 'base64' as const;
  }
  if (hasUrlReference && !hasEncodedReference && transports.includes('url')) {
    return 'url' as const;
  }
  return 'inherit' as const;
}

function supportedImagesResponseFormats(provider: ProviderConfig) {
  const raw = provider.metadata?.images_response_formats;
  if (!Array.isArray(raw)) {
    return [] as Array<'url' | 'b64_json'>;
  }
  return raw.filter((item): item is 'url' | 'b64_json' => item === 'url' || item === 'b64_json');
}

function resolveUpstreamImagesResponseFormat(provider: ProviderConfig, request: OpenAIImagesRequest) {
  const requested = request.response_format;
  const supported = supportedImagesResponseFormats(provider);
  if (requested && (!supported.length || supported.includes(requested))) {
    return requested;
  }
  if (requested && supported.length) {
    return supported[0];
  }
  return undefined;
}

function normalizeImageValueForTransport(
  value: unknown,
  transport: 'inherit' | 'url' | 'base64',
) {
  if (value === undefined || value === null) {
    return value;
  }
  const normalizeSingle = (input: unknown) => {
    const raw = String(input || '').trim();
    if (!raw) {
      return raw;
    }
    const decoded = decodeImagePayloadToBase64(raw);
    const isHttp = /^https?:\/\//i.test(raw);
    if (decoded?.base64) {
      return `data:${contentTypeForExtension(decoded.extension)};base64,${decoded.base64}`;
    }
    if (transport === 'base64') {
      return isHttp ? raw : raw;
    }
    if (transport === 'url') {
      return raw;
    }
    return raw;
  };
  if (Array.isArray(value)) {
    return value.map((item) => normalizeSingle(item));
  }
  return normalizeSingle(value);
}

function pickForwardedBodyFields(
  request: OpenAIImagesRequest,
): Record<string, unknown> {
  const allowed = new Set(fixedImagesBodyFields);
  const body: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(request)) {
    if (value === undefined || key === 'metadata' || key === 'extra_body') {
      continue;
    }
    if (allowed.has(key)) {
      body[key] = value;
    }
  }
  return body;
}

function sanitizeInjectedImagesBodyFields(fields?: Record<string, unknown>) {
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields || {})) {
    const normalizedKey = String(key || '').trim();
    if (!normalizedKey || reservedImagesBodyFields.has(normalizedKey)) {
      continue;
    }
    sanitized[normalizedKey] = value;
  }
  return sanitized;
}

function pickFixedImagesExtraBodyFields(request: OpenAIImagesRequest) {
  const body: Record<string, unknown> = {};
  const extraBody = request.extra_body;
  for (const key of fixedImagesExtraBodyFields) {
    const value = key === 'async'
      ? extraBody?.[key]
      : request[key] ?? extraBody?.[key];
    if (value !== undefined) {
      body[key] = value;
    }
  }
  return body;
}

export function buildOpenAIImagesUpstreamRequest(
  provider: ProviderConfig,
  operation: OpenAIImagesOperation,
  request: OpenAIImagesRequest,
): UpstreamRequestPlan {
  const imageValues = imageStringsFromRequest(request);
  const returnMode = imagesReturnMode(provider, request);
  const bodyFormat = operation === 'edits'
    ? resolveImagesEditBodyFormat(provider, request)
    : 'json';
  const multipartReferenceFileNames = operation === 'edits' && bodyFormat === 'multipart'
    ? resolveMultipartReferenceFileNames(request, imageValues)
    : [];
  const headers: Record<string, string> = {};

  if (bodyFormat === 'json') {
    headers['Content-Type'] = 'application/json';
  }
  headers.Accept = returnMode === 'stream' ? 'text/event-stream' : 'application/json';

  if (provider.apiKey) {
    headers.Authorization = `Bearer ${provider.apiKey}`;
  }

  if (provider.passthrough?.injectHeaders) {
    Object.assign(headers, provider.passthrough.injectHeaders);
  }

  const body: Record<string, unknown> = {
    ...pickForwardedBodyFields(request),
  };

  if (operation === 'edits' && imageValues.length && body.image === undefined) {
    body.image = imageValues.length === 1 ? imageValues[0] : imageValues;
  }

  if (operation === 'edits' && bodyFormat !== 'multipart') {
    body.prompt = buildImagesEditPrompt(request, imageValues.length, multipartReferenceFileNames);
  }

  if ('image' in body) {
    body.image = normalizeImageValueForTransport(
      body.image,
      operation === 'edits' ? resolveJsonReferenceTransport(provider, request) : 'inherit',
    );
  }
  if (operation === 'edits' && bodyFormat === 'json') {
    const imageValue = body.image;
    delete body.image;
    const imageList = Array.isArray(imageValue) ? imageValue : imageValue !== undefined ? [imageValue] : [];
    if (imageList.length) {
      body.images = imageList
        .map((item) => String(item || '').trim())
        .filter(Boolean)
        .map((image_url) => ({ image_url }));
    }
  }

  Object.assign(body, pickFixedImagesExtraBodyFields(request));
  if (returnMode !== 'stream') {
    delete body.stream;
  }

  const upstreamResponseFormat = resolveUpstreamImagesResponseFormat(provider, request);
  if (upstreamResponseFormat) {
    body.response_format = upstreamResponseFormat;
  }

  if (returnMode === 'stream') {
    body.stream = true;
  }

  const customBodyFields = sanitizeInjectedImagesBodyFields(provider.passthrough?.injectBodyFields);
  if (Object.keys(customBodyFields).length) {
    Object.assign(body, customBodyFields);
  }

  return {
    url: joinOpenAIImagesPath(provider, operation),
    method: 'POST',
    headers,
    body,
    bodyFormat,
    ...(multipartReferenceFileNames.length
      ? { multipartFileNames: { image: multipartReferenceFileNames } }
      : {}),
  };
}
