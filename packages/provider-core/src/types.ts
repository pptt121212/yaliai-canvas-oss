export type AsyncMediaSubmitPayload = {
  model: string;
  prompt: string;
  aspect_ratio?: string;
  resolution?: string;
  duration?: number;
  image_url?: string;
  images?: string[];
  external_request_id?: string;
};

export type ProviderSource = 'admin_managed' | 'user_supplied';

export type ProviderRoutingMode =
  | 'health_weighted_best'
  | 'priority_failover'
  | 'round_robin_failover'
  | 'weighted_round_robin'
  | 'least_recently_used';

export type ProviderHealthState = 'healthy' | 'cooling' | 'degraded' | 'disabled';

export type ProviderProtocol =
  | 'openai_images'
  | 'openai_responses'
  | 'openai_chat'
  // Gemini-compatible native image generation endpoint used by Banana.
  | 'gemini_generate_content'
  | 'custom_async_media';

// Banana is intentionally a closed model family for now. Keep the catalog
// here so gateway validation and admin controls cannot drift apart.
export const BANANA_MODELS = [
  {
    id: 'gemini-3-pro-image',
    label: 'Gemini 3 Pro Image',
  },
  {
    id: 'gemini-3.1-flash-image',
    label: 'Gemini 3.1 Flash Image',
  },
] as const;

export type BananaModelId = (typeof BANANA_MODELS)[number]['id'];

export function isBananaModelId(value: unknown): value is BananaModelId {
  return BANANA_MODELS.some((model) => model.id === value);
}

export type ProviderCapability = {
  supportsSync?: boolean;
  supportsAsync?: boolean;
  supportsImageGeneration?: boolean;
  supportsImageEdit?: boolean;
  supportsVideoGeneration?: boolean;
  supportsReferenceImages?: boolean;
};

export type ProviderPassthroughPolicy = {
  injectHeaders?: Record<string, string>;
  injectBodyFields?: Record<string, unknown>;
};

export type ProviderRuntimeState = {
  healthState?: ProviderHealthState;
  healthScore?: number;
  cooldownUntil?: number;
  fusedUntil?: number;
  recoveryStartedAt?: number;
  recoveryUntil?: number;
  recoveryScoreFloor?: number;
  lastCheckedAt?: number;
  lastSelectedAt?: number;
  // Last real upstream result that is allowed to influence health scoring.
  // Reads derive time-decayed values from this timestamp without persisting.
  lastHealthEvidenceAt?: number;
  lastSuccessAt?: number;
  lastFailureAt?: number;
  failureCount?: number;
  successCount?: number;
  timeoutCount?: number;
  slowCount?: number;
  consecutiveTimeouts?: number;
  consecutiveSlowRequests?: number;
  consecutiveFailures?: number;
  ewmaSuccessRate?: number;
  // Only successful requests with usable output contribute to this metric.
  ewmaSuccessLatencyMs?: number;
  ewmaLatencyMs?: number;
  // Read-only diagnostics derived from the persisted evidence timestamp.
  healthEvidenceAgeMs?: number;
  healthEvidenceFreshness?: number;
  successLatencyFreshness?: number;
  lastErrorCategory?: string;
  lastErrorMessage?: string;
  lastHttpStatus?: number;
};

export type ProviderConfig = {
  providerId: string;
  name?: string;
  source: ProviderSource;
  protocol?: ProviderProtocol;
  baseUrl: string;
  apiKey?: string;
  modelAllowlist?: string[];
  weight?: number;
  priority?: number;
  healthScore?: number;
  healthState?: ProviderHealthState;
  supportsImage?: boolean;
  supportsVideo?: boolean;
  capability?: ProviderCapability;
  passthrough?: ProviderPassthroughPolicy;
  metadata?: Record<string, unknown>;
};

export type ProviderSelectionContext = {
  requestedModel: string;
  outputType: 'image' | 'video';
  operation?: 'generate' | 'edit';
  requestMode?: 'sync' | 'async' | 'either';
  routingMode?: ProviderRoutingMode;
  userId?: string;
  allowUserSuppliedKey?: boolean;
  now?: number;
};

export type ProviderSelectionResult = {
  provider: ProviderConfig | null;
  attemptedProviderIds: string[];
  reason:
    | 'selected'
    | 'no_eligible_provider'
    | 'all_attempted'
    | 'all_in_cooldown'
    | 'all_disabled';
};

export type ProviderAttemptReport = {
  providerId: string;
  ok: boolean;
  statusCode?: number;
  failedAt?: number;
  cooldownMs?: number;
  affectsHealth?: boolean;
  latencyMs?: number;
  failureCategory?: string;
  errorMessage?: string;
};

export type OpenAIImagesOperation = 'generations' | 'edits';

export type OpenAIImagesEditProtocol = 'multipart_file_upload' | 'json_image_url';

export type OpenAIImagesRequest = {
  model: string;
  prompt: string;
  action?: string;
  size?: string;
  response_format?: 'url' | 'b64_json';
  quality?: string;
  n?: number;
  user?: string;
  image?: string | string[];
  reference_images?: Array<string | Record<string, unknown>>;
  reference_image_instructions?: string | string[];
  prioritize_first_reference_image?: boolean;
  stream?: boolean;
  partial_images?: number;
  output_format?: string;
  output_quality?: number;
  output_compression?: number;
  background?: string;
  moderation?: string;
  async?: boolean;
  callback_url?: string;
  image_quality?: number;
  image_tool_quality?: string;
  metadata?: Record<string, unknown>;
  extra_body?: Record<string, unknown>;
};

export type UpstreamRequestBodyFormat = 'json' | 'multipart';

export type UpstreamRequestPlan = {
  url: string;
  method: 'POST';
  headers: Record<string, string>;
  body: Record<string, unknown>;
  bodyFormat: UpstreamRequestBodyFormat;
  multipartFileNames?: Record<string, string[]>;
};

export type AsyncMediaSubmitResult = {
  taskId: string;
  status: string;
  raw: unknown;
};

export type AsyncMediaQueryResult = {
  taskId: string;
  status: string;
  url: string | null;
  raw: unknown;
};

export interface AsyncMediaAdapter {
  submit(payload: AsyncMediaSubmitPayload): Promise<AsyncMediaSubmitResult>;
  query(taskId: string): Promise<AsyncMediaQueryResult>;
}

export interface ProviderRegistry {
  list(): ProviderConfig[];
  get(providerId: string): ProviderConfig | null;
  getRuntimeState(providerId: string): ProviderRuntimeState | null;
  register(provider: ProviderConfig): void;
  reportAttempt(report: ProviderAttemptReport): void;
}

export interface ProviderRouter {
  pickProvider(context: ProviderSelectionContext, providers: ProviderConfig[]): ProviderSelectionResult;
}
