import {
  buildOpenAIImagesUpstreamRequest,
  type OpenAIImagesOperation,
  type OpenAIImagesRequest,
  type ProviderConfig,
  type ProviderRoutingMode,
  type ProviderSelectionResult,
  type UpstreamRequestPlan,
} from '@yali/provider-core';

const reservedResponsesBodyFields = new Set([
  'model',
  'input',
  'tools',
  'tool_choice',
  'stream',
  'reasoning',
]);

const reservedChatBodyFields = new Set([
  'model',
  'messages',
  'stream',
]);

function sanitizeInjectedBodyFields(
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

function isHttpUrl(value: string) {
  return /^https?:\/\//i.test(String(value || '').trim());
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

async function fetchImageUrlAsDataUrl(url: string) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch image URL: HTTP ${response.status}`);
  }
  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  const extension = detectImageExtensionFromBuffer(buffer);
  return `data:${contentTypeForExtension(extension)};base64,${buffer.toString('base64')}`;
}

async function normalizeImageValueToDataUrl(value: string) {
  const raw = String(value || '').trim();
  if (!raw) {
    return raw;
  }
  const decoded = decodeImagePayloadToBase64(raw);
  if (decoded?.base64) {
    return `data:${contentTypeForExtension(decoded.extension)};base64,${decoded.base64}`;
  }
  if (!isHttpUrl(raw)) {
    return raw;
  }
  return fetchImageUrlAsDataUrl(raw);
}

async function normalizeImageValueToDataUrlIfEncoded(value: string) {
  const raw = String(value || '').trim();
  if (!raw) {
    return raw;
  }
  const decoded = decodeImagePayloadToBase64(raw);
  if (decoded?.base64) {
    return `data:${contentTypeForExtension(decoded.extension)};base64,${decoded.base64}`;
  }
  return raw;
}

async function normalizeIncomingImagePayloadReferencesPreservingUrls(payload: OpenAIImagesRequest) {
  const nextPayload: OpenAIImagesRequest = {
    ...payload,
  };

  if (payload.image) {
    const images = Array.isArray(payload.image) ? payload.image : [payload.image];
    const normalized = await Promise.all(images.map((image) => normalizeImageValueToDataUrlIfEncoded(String(image || ''))));
    nextPayload.image = Array.isArray(payload.image) ? normalized : normalized[0];
  }

  return nextPayload;
}

function supportedJsonReferenceTransports(provider: ProviderConfig) {
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

export async function adaptOpenAIImagesPayloadForProvider(
  provider: ProviderConfig,
  payload: OpenAIImagesRequest,
): Promise<OpenAIImagesRequest> {
  const transports = supportedJsonReferenceTransports(provider);
  if (!transports.includes('url') && !transports.includes('base64')) {
    return payload;
  }

  if (transports.includes('url') && !transports.includes('base64')) {
    return payload;
  }

  if (transports.includes('base64') && !transports.includes('url')) {
    const nextPayload: OpenAIImagesRequest = {
      ...payload,
    };

    if (payload.image) {
      const images = Array.isArray(payload.image) ? payload.image : [payload.image];
      const normalized = await Promise.all(images.map((image) => normalizeImageValueToDataUrl(String(image || ''))));
      nextPayload.image = Array.isArray(payload.image) ? normalized : normalized[0];
    }

    return nextPayload;
  }

  return normalizeIncomingImagePayloadReferencesPreservingUrls(payload);
}

export type ResolveImageProviderInput = {
  request: OpenAIImagesRequest;
  operation: OpenAIImagesOperation;
  routingMode: ProviderRoutingMode;
  providerSource?: 'admin_managed' | 'user_supplied';
  userImageApiKind?: 'images_endpoint' | 'responses_endpoint';
  userApiBaseUrl?: string;
  userImagesGenerationsUrl?: string;
  userImagesEditsUrl?: string;
  userApiKey?: string;
  userAuthMode?: 'bearer' | 'x-api-key';
  resolveProvider: (context: {
    requestedModel: string;
    outputType: 'image';
    operation: 'generate' | 'edit';
    requestMode: 'sync' | 'async' | 'either';
    routingMode: ProviderRoutingMode;
    allowUserSuppliedKey: boolean;
  }) => ProviderSelectionResult;
};

export type ImageGatewayResolvedPlan = {
  provider: ProviderConfig;
  selection: ProviderSelectionResult;
  requestPlan: UpstreamRequestPlan;
};

function normalizeReferenceInstructionText(value: unknown) {
  const text = String(value || '').trim();
  if (!text) {
    return '';
  }
  if (text.startsWith('下方图片：') || text.startsWith('下方图片:')) {
    return text;
  }
  return `下方图片：${text}`;
}

function buildResponsesMultimodalInput(
  prompt: string,
  images: string[],
  inputShape: string,
) {
  const normalizedPrompt = String(prompt || '');
  const normalizedImages = images
    .map((item) => String(item || '').trim())
    .filter(Boolean);

  if (!normalizedImages.length && inputShape === 'auto_standard') {
    return normalizedPrompt;
  }

  const content: Array<Record<string, unknown>> = [
    { type: 'input_text', text: normalizedPrompt },
  ];
  normalizedImages.forEach((imageUrl) => {
    content.push({ type: 'input_image', image_url: imageUrl });
  });

  return [{ role: 'user', content }];
}

function buildResponsesRequestPlan(provider: ProviderConfig, request: OpenAIImagesRequest): UpstreamRequestPlan {
  const inputShape = String(provider.metadata?.responses_input_shape || request.metadata?.responses_input_shape || 'auto_standard');
  const modelRouting = String(provider.metadata?.responses_model_routing || 'single_top_level_model');
  const toolChoice = String(provider.metadata?.responses_tool_choice || request.metadata?.responses_tool_choice || 'auto');
  const toolChoiceFormat = String(provider.metadata?.responses_tool_choice_format || request.metadata?.responses_tool_choice_format || 'typed_object');
  const moderationMode = String(provider.metadata?.responses_moderation_mode || 'task_or_omit');
  const reasoningEffort = String(provider.metadata?.reasoning_effort || request.metadata?.reasoning_effort || 'low');
  const textModel = String(provider.metadata?.responses_text_model || request.metadata?.responses_text_model || request.model);
  const imageModel = String(provider.metadata?.responses_image_model || request.metadata?.responses_image_model || '').trim();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
  };
  if (provider.apiKey) {
    headers.Authorization = `Bearer ${provider.apiKey}`;
  }
  if (provider.passthrough?.injectHeaders) {
    Object.assign(headers, provider.passthrough.injectHeaders);
  }

  const images = request.image ? (Array.isArray(request.image) ? request.image : [request.image]) : [];
  const hasReference = images.length > 0;
  const imageToolQuality = request.image_tool_quality
    ?? request.extra_body?.image_tool_quality
    ?? request.quality
    ?? provider.metadata?.responses_image_tool_quality;
  const outputFormat = request.output_format ?? request.extra_body?.output_format;
  const imageQuality = request.image_quality
    ?? request.output_compression
    ?? request.output_quality
    ?? request.extra_body?.image_quality
    ?? request.extra_body?.output_compression
    ?? request.extra_body?.output_quality
    ?? provider.metadata?.responses_image_quality;
  const background = request.background ?? request.extra_body?.background;
  const moderation = request.moderation ?? request.extra_body?.moderation;

  const body: Record<string, unknown> = {
    model: textModel,
    input: buildResponsesMultimodalInput(
      request.prompt,
      images,
      inputShape,
    ),
    tools: [
      {
        type: 'image_generation',
        ...(modelRouting === 'split_text_image' && imageModel ? { model: imageModel } : {}),
        action: hasReference ? 'edit' : 'generate',
        size: request.size || 'auto',
        ...(imageToolQuality !== undefined && imageToolQuality !== null && String(imageToolQuality).trim()
          ? { quality: String(imageToolQuality).trim() }
          : {}),
        ...(typeof outputFormat === 'string' && outputFormat.trim()
          ? { output_format: outputFormat.trim() }
          : {}),
        ...(imageQuality !== undefined && imageQuality !== null
          ? { output_compression: Number(imageQuality) }
          : {}),
        ...(Number.isInteger(request.partial_images) && Number(request.partial_images) > 0
          ? { partial_images: Number(request.partial_images) }
          : {}),
        ...(typeof background === 'string' && background.trim()
          ? { background: background.trim() }
          : {}),
        ...(
          moderationMode === 'force_auto'
            ? { moderation: 'auto' }
            : moderationMode === 'force_low'
              ? { moderation: 'low' }
              : moderation
                ? { moderation }
                : {}
        ),
      },
    ],
    stream: true,
  };

  if (reasoningEffort && String(reasoningEffort).trim()) {
    body.reasoning = { effort: String(reasoningEffort).trim() };
  }

  if (toolChoice === 'image_generation') {
    body.tool_choice = toolChoiceFormat === 'required_string'
      ? 'required'
      : { type: 'image_generation' };
  }

  const customBodyFields = sanitizeInjectedBodyFields(
    provider.passthrough?.injectBodyFields,
    reservedResponsesBodyFields,
  );
  if (Object.keys(customBodyFields).length) {
    Object.assign(body, customBodyFields);
  }

  return {
    url: String(provider.baseUrl || '').trim().replace(/\/+$/, ''),
    method: 'POST',
    headers,
    body,
    bodyFormat: 'json',
  };
}

function buildChatRequestPlan(provider: ProviderConfig, request: OpenAIImagesRequest): UpstreamRequestPlan {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (provider.apiKey) {
    headers.Authorization = `Bearer ${provider.apiKey}`;
  }
  if (provider.passthrough?.injectHeaders) {
    Object.assign(headers, provider.passthrough.injectHeaders);
  }

  const body: Record<string, unknown> = {
    model: request.model,
    messages: [
      {
        role: 'user',
        content: request.image
          ? [
              { type: 'text', text: request.prompt },
              ...((Array.isArray(request.image) ? request.image : [request.image]).flatMap((imageUrl, index, list) => {
                const items: Array<Record<string, unknown>> = [];
                const instruction = normalizeReferenceInstructionText(
                  Array.isArray(request.reference_image_instructions)
                    ? request.reference_image_instructions[index]
                    : typeof request.reference_image_instructions === 'string' && index === 0
                      ? request.reference_image_instructions
                      : '',
                );
                if (instruction) {
                  items.push({ type: 'text', text: instruction });
                }
                items.push({
                  type: 'image_url',
                  image_url: { url: imageUrl },
                });
                if (index === 0 && request.prioritize_first_reference_image && list.length > 1) {
                  items.push({
                    type: 'text',
                    text: '以上第一张图片是主图/待编辑图片。以下图片仅作为参考图，不要作为主要编辑对象。',
                  });
                }
                return items;
              })),
            ]
          : request.prompt,
      },
    ],
  };

  const customBodyFields = sanitizeInjectedBodyFields(
    provider.passthrough?.injectBodyFields,
    reservedChatBodyFields,
  );
  if (Object.keys(customBodyFields).length) {
    Object.assign(body, customBodyFields);
  }

  return {
    url: String(provider.baseUrl || '').trim().replace(/\/+$/, ''),
    method: 'POST',
    headers,
    body,
    bodyFormat: 'json',
  };
}

export function buildImageRequestPlanForProvider(
  provider: ProviderConfig,
  operation: OpenAIImagesOperation,
  request: OpenAIImagesRequest,
): UpstreamRequestPlan {
  if (provider.protocol === 'openai_responses') {
    return buildResponsesRequestPlan(provider, request);
  }
  if (provider.protocol === 'openai_chat') {
    return buildChatRequestPlan(provider, request);
  }
  return buildOpenAIImagesUpstreamRequest(provider, operation, request);
}

export function resolveImageProviderPlan(input: ResolveImageProviderInput): ImageGatewayResolvedPlan | null {
  const effectiveUserImageUrl = input.operation === 'edits'
    ? String(input.userImagesEditsUrl || input.userApiBaseUrl || input.userImagesGenerationsUrl || '').trim()
    : String(input.userImagesGenerationsUrl || input.userApiBaseUrl || input.userImagesEditsUrl || '').trim();
  const selection = input.providerSource === 'user_supplied' && effectiveUserImageUrl
    ? (() => {
        const protocol = input.userImageApiKind === 'responses_endpoint'
          ? 'openai_responses' as const
          : 'openai_images' as const;
        const providerId = protocol === 'openai_responses'
          ? 'user-supplied-openai-responses'
          : 'user-supplied-openai-images';
        const authHeaders: Record<string, string> = {};
        if (input.userAuthMode === 'x-api-key' && input.userApiKey) {
          authHeaders['X-API-Key'] = input.userApiKey;
        }
        return {
          provider: {
            providerId,
            source: 'user_supplied' as const,
            protocol,
            baseUrl: effectiveUserImageUrl,
            apiKey: input.userAuthMode === 'x-api-key' ? '' : input.userApiKey,
            capability: {
              supportsAsync: true,
              supportsSync: true,
              supportsImageGeneration: true,
              supportsImageEdit: true,
              supportsReferenceImages: true,
            },
            passthrough: Object.keys(authHeaders).length
              ? { injectHeaders: authHeaders }
              : undefined,
            metadata: protocol === 'openai_responses'
              ? {
                  consoleUpstreamKind: 'responses_endpoint',
                  responses_return_mode: 'json',
                  responses_input_shape: 'always_multimodal_message',
                  responses_model_routing: 'single_top_level_model',
                  responses_tool_choice: 'image_generation',
                  responses_tool_choice_format: 'typed_object',
                }
              : {
                  consoleUpstreamKind: 'images_endpoint',
                },
          },
          attemptedProviderIds: [providerId],
          reason: 'selected' as const,
        };
      })()
    : input.resolveProvider({
        requestedModel: input.request.model,
        outputType: 'image',
        operation: input.operation === 'edits' ? 'edit' : 'generate',
        requestMode: 'either',
        routingMode: input.routingMode,
        allowUserSuppliedKey: true,
      });

  if (!selection.provider) {
    return null;
  }

  if (selection.provider.protocol === 'openai_chat') {
    return null;
  }

  return {
    provider: selection.provider,
    selection,
    requestPlan: buildImageRequestPlanForProvider(selection.provider, input.operation, input.request),
  };
}
