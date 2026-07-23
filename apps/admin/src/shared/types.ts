export type AdminSession = {
  authenticated: boolean;
  user?: {
    username: string;
  };
};

export type AdminControlPlaneConfig = {
  routing: {
    allowUserSuppliedKey: boolean;
    smartRoutingCostPriorityBaseDelta: number;
  };
  publicApi: {
    enabled: boolean;
    authMode: 'admin_key' | 'tenant_key' | 'disabled';
    rateLimitPerMinute: number;
    maxConcurrency: number;
    asyncQueueMax: number;
    asyncQueuePerApiKeyMax: number;
    asyncQueueDispatchPerTick: number;
    asyncQueuePollMs: number;
    asyncQueueWaitMs: number;
    maxInputImageMb: number;
    maxInputImageCount: number;
    maxInputImageTotalMb: number;
    exposeGenerations: boolean;
    exposeEdits: boolean;
    overloadGuardEnabled: boolean;
    overloadGuardMinAvailableMemoryRatio: number;
    overloadGuardMaxCpuLoadRatio: number;
    overloadGuardMaxEventLoopDelayMs: number;
  };
  canvas: {
    allowUserSuppliedProviders: boolean;
    brandLogoUrl: string;
    entryMode: 'login' | 'settings';
  };
  maintenance: {
    generatedImageRetentionMinutes: number;
    canvasReferenceAssetRetentionMinutes: number;
    requestTraceRetentionMinutes: number;
    taskRecordRetentionDays: number;
    auditLogRetentionDays: number;
    billingLedgerRetentionDays: number;
  };
  analytics: {
    operationalRollupEnabled: boolean;
    operationalRollupIntervalMinutes: number;
    operationalRollupLookbackDays: number;
  };
};

export type OperationalRollupTableRow = {
  bucketStart: number;
  bucketEnd: number;
  bucketMs: number;
  channelId: string;
  upstreamId: string;
  requestCount: number;
  eligibleRequestCount: number;
  completedCount: number;
  failedCount: number;
  rejectedCount: number;
  runningCount: number;
  successRate: number;
  generatedImageCount: number;
  chatRequestCount: number;
  chargedCredits: number;
  estimatedUpstreamCostCredits: number;
  estimatedGrossMarginCredits: number;
  grossMarginRate: number;
  costedImageCount: number;
  costedChatRequestCount: number;
  averageDurationMs: number;
  generationCount: number;
  editCount: number;
  tiers: string[];
  qualities: string[];
  lastActivityAt?: number;
};

export type OperationalRollupReport = {
  generatedAt: number;
  fromInclusive: number;
  toExclusive: number;
  enabled: boolean;
  hardDisabledByEnv: boolean;
  intervalMinutes: number;
  lookbackDays: number;
  rows: Array<{
    rollupKey: string;
    metricFamily: string;
    bucketStart: number;
    bucketMs: number;
    channelId?: string;
    upstreamId?: string;
    tenantId?: string;
    apiKeyId?: string;
    operation?: string;
    tier?: string;
    quality?: string;
    failureCategory?: string;
    source: string;
    metrics: Record<string, number>;
    detail?: Record<string, unknown>;
    generatedAt: number;
    updatedAt: number;
  }>;
  tableRows: OperationalRollupTableRow[];
  jobs: {
    channelPerformanceDaily: null | {
      jobKey: string;
      lockedUntil?: number;
      lockedBy?: string;
      lastSuccessAt?: number;
      lastError?: string;
      updatedAt: number;
    };
  };
};

export type OverviewPayload = {
  stats: {
    totalProviders: number;
    healthyProviders: number;
    coolingProviders: number;
    degradedProviders: number;
    imageCapableProviders: number;
  };
  routing: {
    allowUserSuppliedKey: boolean;
    smartRoutingCostPriorityBaseDelta: number;
  };
  publicApi: {
    enabled: boolean;
    authMode: 'admin_key' | 'tenant_key' | 'disabled';
    rateLimitPerMinute: number;
    maxConcurrency: number;
    exposeGenerations: boolean;
    exposeEdits: boolean;
  };
  server: {
    generatedAt: number;
    hostname: string;
    platform: string;
    nodeVersion: string;
    pid: number;
    uptimeSeconds: number;
    systemUptimeSeconds: number;
    cpuCount: number;
    loadAverage: number[];
    loadPercent1m: number;
    memory: {
      totalBytes: number;
      freeBytes: number;
      usedBytes: number;
      usedPercent: number;
    };
    processMemory: {
      rssBytes: number;
      heapUsedBytes: number;
      heapTotalBytes: number;
      externalBytes: number;
    };
    disk: null | {
      path: string;
      totalBytes: number;
      freeBytes: number;
      usedBytes: number;
      usedPercent: number;
    };
    redisEnabled: boolean;
    databaseEnabled: boolean;
  };
  business: {
    traceSampleSize: number;
    requests1h: number;
    eligibleRequests1h: number;
    success1h: number;
    rejected1h: number;
    requests24h: number;
    eligibleRequests24h: number;
    success24h: number;
    failed24h: number;
    rejected24h: number;
    successRate1h: number;
    successRate24h: number;
    imageRequests1h: number;
    imageEligibleRequests1h: number;
    imageSuccess1h: number;
    imageRejected1h: number;
    imageSuccessRate1h: number;
    imageRequests24h: number;
    imageEligibleRequests24h: number;
    imageSuccess24h: number;
    imageFailed24h: number;
    imageRejected24h: number;
    imageSuccessRate24h: number;
    charged24hCents: number;
    completedTasks24h: number;
    runningTasksCurrent: number;
    averageImageDuration24hMs: number;
    tenantBalanceTotalCents: number;
    tenantDebitedTotalCents: number;
    tenantBalanceCount: number;
  };
  hotState: {
    providerRuntimeCount: number;
    providerHealthCount: number;
    rateLimitBucketCount: number;
    concurrencyCounterCount: number;
    imageTaskCount: number;
    workflowRunCount: number;
  };
  protocolStats: Record<string, number>;
  adapterStats: Array<{
    adapterKey: string;
    title: string;
    providerCount: number;
  }>;
  providers: Array<Record<string, unknown>>;
};

export type ResolutionAuditSummaryRow = {
  key: string;
  upstreamId: string;
  upstreamName: string;
  operation: 'generations' | 'edits';
  requestedSize: string;
  requestedAspectLabel: string;
  requestedTier: 'auto' | '1k' | '2k' | '4k';
  sampleCount: number;
  measuredCount: number;
  avgAspectAccuracyPercent: number;
  avgResolutionAccuracyPercent: number;
  sameOrHigherTierRate: number;
  downgradeRate: number;
  avgTierDowngradeLevels: number;
  exactSizeMatchRate: number;
  sameTierMatchRate: number;
  exactAspectRatioRate: number;
  avgAspectRatioDeltaPercent: number;
  avgMaxSideDeltaPercent: number;
  actualTierBreakdown: Record<string, number>;
  downgradeLevelBreakdown: Record<string, number>;
  latestSampleAt?: number;
};

export type AspectResolutionAuditSummaryRow = {
  key: string;
  upstreamId: string;
  upstreamName: string;
  operation: 'generations' | 'edits';
  requestedAspectLabel: string;
  requestedTier: 'auto' | '1k' | '2k' | '4k';
  sampleCount: number;
  measuredCount: number;
  avgAspectAccuracyPercent: number;
  avgResolutionAccuracyPercent: number;
  sameOrHigherTierRate: number;
  downgradeRate: number;
  avgTierDowngradeLevels: number;
  actualTierBreakdown: Record<string, number>;
  latestSampleAt?: number;
};

export type ResolutionAuditReport = {
  generatedAt: number;
  sampleWindowSize: number;
  totals: {
    sampleCount: number;
    measuredCount: number;
    upstreamCount: number;
    exactRequestGroupCount: number;
    aspectGroupCount: number;
  };
  rows: ResolutionAuditSummaryRow[];
  aspectRows: AspectResolutionAuditSummaryRow[];
};

export type BillingLedgerRow = {
  id: string;
  createdAt: number;
  updatedAt: number;
  tenantId: string;
  tenantName: string;
  apiKeyId: string;
  apiKeyName: string;
  channelId: string;
  upstreamId?: string;
  upstreamName?: string;
  requestId: string;
  taskId?: string;
  operation: 'generations' | 'edits' | 'chat_completions';
  currency: 'cny';
  reservedCredits: number;
  chargedCredits: number;
  status: 'reserved' | 'charged' | 'voided';
  model: string;
  size?: string;
  requestedSize?: string;
  actualSize?: string;
  billedSize?: string;
  requestedTier?: string;
  actualTier?: string;
  billedTier?: string;
  requestedQuality?: string;
  billedQuality?: string;
  billingMode?: string;
  billingModeLabel?: string;
  detail: Record<string, unknown>;
};

export type BillingLedgerReport = {
  generatedAt: number;
  total: number;
  page: {
    limit: number;
    totalMatching: number;
    currentCursor?: { createdAt: number; id: string };
    hasMore: boolean;
    nextCursor?: { createdAt: number; id: string };
  };
  image: {
    total: number;
    rows: BillingLedgerRow[];
  };
  chat: {
    total: number;
    rows: BillingLedgerRow[];
  };
};

export type AuditLogRow = {
  id: string;
  createdAt: number;
  actorType: 'admin' | 'tenant_key' | 'system';
  actorId: string;
  action: string;
  targetType: 'upstream' | 'channel' | 'tenant' | 'api_key' | 'image_request' | 'task';
  targetId: string;
  targetName?: string;
  requestId?: string;
  status: 'success' | 'failed' | 'accepted';
  message: string;
  detail: Record<string, unknown>;
};

export type AuditLogReport = {
  generatedAt: number;
  total: number;
  summary: {
    successCount: number;
    failedCount: number;
    acceptedCount: number;
    adminActorCount: number;
    systemActorCount: number;
    tenantKeyActorCount: number;
    latestCreatedAt?: number;
  };
  rows: AuditLogRow[];
};

export type ChannelUpstreamPerformanceMetric = {
  upstreamId: string;
  healthState?: 'healthy' | 'cooling' | 'degraded' | 'disabled';
  healthScore?: number;
  requestCount: number;
  eligibleRequestCount: number;
  completedCount: number;
  failedCount: number;
  rejectedCount: number;
  runningCount: number;
  successRate: number;
  generatedImageCount: number;
  chargedCredits: number;
  estimatedUpstreamCostCredits: number;
  estimatedGrossMarginCredits: number;
  costedImageCount: number;
  averageDurationMs: number;
  lastActivityAt?: number;
  generationCount: number;
  editCount: number;
};

export type ChannelPerformanceMetric = ChannelUpstreamPerformanceMetric & {
  channelId: string;
  upstreams: ChannelUpstreamPerformanceMetric[];
};

export type ChannelPerformanceReport = {
  generatedAt: number;
  windowDays: number;
  fromInclusive: number;
  toExclusive: number;
  rows: ChannelPerformanceMetric[];
};

export type RequestTraceRow = {
  traceId: string;
  createdAt: number;
  updatedAt: number;
  source: 'onboarding_probe' | 'admin_upstream_test' | 'tenant_runtime_sync' | 'tenant_runtime_async_submit' | 'tenant_runtime_async_complete';
  scope: 'upstream_only' | 'full_chain';
  status: 'accepted' | 'success' | 'failed';
  summary: string;
  requestId?: string;
  taskId?: string;
  tenantId?: string;
  tenantName?: string;
  apiKeyId?: string;
  apiKeyName?: string;
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

export type RequestTraceDetail = RequestTraceRow;

export type RequestTraceReport = {
  generatedAt: number;
  total: number;
  summary: {
    upstreamOnlyCount: number;
    fullChainCount: number;
    successCount: number;
    failedCount: number;
    latestCreatedAt?: number;
  };
  rows: RequestTraceRow[];
};

export type RoutingDiagnosticsProvider = {
  providerId: string;
  name: string;
  protocol: string;
  kind: string;
  baseUrl: string;
  healthState: 'healthy' | 'cooling' | 'degraded' | 'disabled';
  healthScore: number;
  supportsImageGeneration: boolean;
  supportsImageEdit: boolean;
  supportsReferenceImages: boolean;
  supportsAsync: boolean;
  maxConcurrency: number;
  currentConcurrency: number;
  cooldownUntil?: number;
  fusedUntil?: number;
  successCount: number;
  failureCount: number;
  ewmaSuccessRate: number;
  ewmaLatencyMs: number;
  lastCheckedAt?: number;
  lastSelectedAt?: number;
  lastSuccessAt?: number;
  lastFailureAt?: number;
  lastErrorCategory: string;
  lastErrorMessage: string;
  capabilityProfiles: ImageCapabilityProfile[];
  recentTaskStats: {
    windowMinutes: number;
    requestCount: number;
    eligibleRequestCount: number;
    successCount: number;
    failedCount: number;
    rejectedCount: number;
    runningCount: number;
    averageDurationMs: number;
    lastActivityAt?: number;
  };
  recentBillingStats: {
    windowMinutes: number;
    generatedImageCount: number;
    chargedCredits: number;
  };
};

export type RoutingDiagnosticsApiKeyMode = {
  apiKeyId: string;
  apiKeyName: string;
  tenantId: string;
  tenantName: string;
  mode: 'smart_priority' | 'smart_failover' | 'fixed_provider';
  modeLabel: string;
  fixedProviderId?: string;
  fixedProviderIds?: string[];
  fixedProviderName?: string;
  status: 'active' | 'disabled';
  maxConcurrency: number;
  requestLimitPerMinute: number;
};

export type RoutingDiagnosticsPreviewPlan = {
  mode: 'smart_priority' | 'smart_failover' | 'fixed_provider';
  modeLabel: string;
  candidateCount: number;
  filteredOutCount: number;
  filteredOut: Array<{ providerId: string; providerName: string; reason: string }>;
  candidates: Array<{
    rank: number;
    providerId: string;
    providerName: string;
    protocol: string;
    baseUrl: string;
    score: number;
    baseScore: number;
    qualityScore: number;
    healthScore: number;
    concurrencyScore: number;
    price: number;
    costSource: 'exact' | 'highest_configured_fallback' | 'unconfigured';
    estimatedLatencyMs: number;
    observedLatencyMs?: number;
    latencySource: 'success_ewma' | 'legacy_ewma' | 'candidate_median';
    successLatencySampleCount: number;
    healthEvidenceAgeMs: number;
    healthEvidenceFreshness: number;
    successLatencyFreshness: number;
    costMedian: number;
    effectiveCost: number;
    costIndex: number;
    deliveryValueIndex: number;
    currentConcurrency: number;
    reasons: string[];
  }>;
};

export type RoutingDiagnosticsPreview = {
  key: string;
  label: string;
  requestedSize?: string;
  operation: 'generations' | 'edits';
  hasReferenceImage: boolean;
  plans: RoutingDiagnosticsPreviewPlan[];
};

export type RoutingDiagnosticsReport = {
  generatedAt: number;
  summary: {
    providerCount: number;
    healthyCount: number;
    coolingCount: number;
    degradedCount: number;
    disabledCount: number;
    tenantKeyCount: number;
    smartModeCount: number;
    preferredModeCount: number;
    fixedModeCount?: number;
    diagnosticsWindowMinutes?: number;
  };
  apiKeyModes: RoutingDiagnosticsApiKeyMode[];
  providers: RoutingDiagnosticsProvider[];
  previews: RoutingDiagnosticsPreview[];
};

export type TenantFinanceBalanceRow = {
  tenantId: string;
  tenantName: string;
  currency: 'cny';
  balanceCents: number;
  totalCreditedCents: number;
  totalDebitedCents: number;
  updatedAt: number;
};

export type TenantFinanceLedgerRow = {
  id: string;
  createdAt: number;
  updatedAt: number;
  tenantId: string;
  tenantName: string;
  operatorId: string;
  operatorLabel?: string;
  sourceLabel?: string;
  entryType: 'account_adjustment' | 'tenant_request_charge';
  direction: 'credit' | 'debit';
  amountCents: number;
  balanceAfterCents: number;
  currentBalanceCents: number;
  currency: 'cny';
  note: string;
};

export type TenantFinanceLedgerReport = {
  generatedAt: number;
  total: number;
  page: {
    limit: number;
    totalMatching: number;
    currentCursor?: { createdAt: number; id: string };
    hasMore: boolean;
    nextCursor?: { createdAt: number; id: string };
  };
  balances: TenantFinanceBalanceRow[];
  rows: TenantFinanceLedgerRow[];
};

export type CanvasUserAdminRow = {
  id: string;
  username: string;
  email: string;
  tenantId: string;
  apiKeyId: string;
  status: 'active' | 'disabled';
  createdAt: number;
  updatedAt: number;
  upstreamPreference: {
    mode: 'shared_platform' | 'user_supplied';
    imageApiKind: 'images_endpoint' | 'responses_endpoint';
    imagesBaseUrl: string;
    chatBaseUrl: string;
    preferredAuthMode: 'bearer' | 'x-api-key';
    chatFallbackMode: 'platform_fallback' | 'strict_user';
    hasImagesApiKey: boolean;
    hasChatApiKey: boolean;
    updatedAt: number;
  };
};

export type CanvasUserAdminReport = {
  generatedAt: number;
  total: number;
  rows: CanvasUserAdminRow[];
};

export type ConsoleUpstreamKind = 'images_endpoint' | 'responses_endpoint' | 'banana_endpoint' | 'chat_completions';
export type ResolutionTier = 'auto' | '1k' | '2k' | '4k';
export type BillableResolutionTier = 'auto' | '1k' | '2k' | '4k';
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
export type ImageBackgroundMode = 'omit' | 'auto' | 'transparent' | 'opaque';
export type ImageCapabilityCostMap = Partial<Record<ImageQualityTier, number>>;

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
  background?: ImageBackgroundMode;
  stream?: boolean;
  partialImages?: number;
  referenceImageUrl?: string;
  responsesInputShape?: ResponsesInputShape;
  responsesToolChoice?: ResponsesToolChoiceMode;
  responsesToolChoiceFormat?: ResponsesToolChoiceFormat;
  moderation?: ModerationMode;
  n?: number;
};

export type ProbeCheck = {
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
  checks: ProbeCheck[];
  summary: string;
};

export type BananaImageSize = '1k' | '2k' | '4k';
export type DownstreamImageApiType = 'openai_images' | 'banana_images';

export type BananaImageSellPriceRow = {
  model: string;
  price: number;
};

export type BananaAuthMode = 'x_goog_api_key' | 'bearer' | 'both';
export type BananaModelCapability = {
  model: string;
  imageSizes: BananaImageSize[];
  aspectRatios: string[];
  supportsReferenceImages: boolean;
  cost?: number;
};
export type BananaEndpointConfig = {
  authMode: BananaAuthMode;
  supportsTextToImage: boolean;
  supportsImageToImage: boolean;
  generationPathPrefix?: string;
  modelCapabilities: BananaModelCapability[];
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

export type ProviderPassthroughPolicy = {
  injectHeaders?: Record<string, string>;
  injectBodyFields?: Record<string, unknown>;
};

export type ConsoleUpstream = {
  id: string;
  name: string;
  kind: ConsoleUpstreamKind;
  baseUrl: string;
  apiKey: string;
  enabled: boolean;
  maxConcurrency: number;
  healthStatus: 'healthy' | 'cooling' | 'degraded' | 'disabled';
  modelHints: string[];
  notes: string;
  adminTestPreset?: UpstreamTestPreset;
  passthrough?: ProviderPassthroughPolicy;
  imagesConfig?: ImagesEndpointConfig;
  responsesConfig?: ResponsesEndpointConfig;
  bananaConfig?: BananaEndpointConfig;
  chatConfig?: ChatCompletionsConfig;
  detectedConfig?: {
    kind: ConsoleUpstreamKind;
    imagesConfig?: ImagesEndpointConfig;
    responsesConfig?: ResponsesEndpointConfig;
    bananaConfig?: BananaEndpointConfig;
    chatConfig?: ChatCompletionsConfig;
    probe: OnboardingProbeResult;
  };
  manualOverrides?: {
    kind?: ConsoleUpstreamKind;
    imagesConfig?: Partial<ImagesEndpointConfig>;
    responsesConfig?: Partial<ResponsesEndpointConfig>;
    bananaConfig?: Partial<BananaEndpointConfig>;
    chatConfig?: Partial<ChatCompletionsConfig>;
    modelHints?: string[];
  };
};

export type UpstreamTestRequest = {
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
  background?: ImageBackgroundMode;
  stream?: boolean;
  partialImages?: number;
  referenceImageUrl?: string;
  responsesInputShape?: ResponsesInputShape;
  responsesToolChoice?: ResponsesToolChoiceMode;
  responsesToolChoiceFormat?: ResponsesToolChoiceFormat;
  moderation?: ModerationMode;
  n?: number;
};

export type UpstreamTestResponse = {
  ok: boolean;
  statusCode: number | null;
  headers: Record<string, string>;
  bodyText: string;
  bodyJson?: unknown;
};

export type UpstreamTestResult = {
  requestPlan: {
    url: string;
    method: string;
    headers: Record<string, string>;
    body: Record<string, unknown>;
    bodyFormat?: 'json' | 'multipart';
  };
  response: UpstreamTestResponse;
  summary: string;
};

export type ConsoleChannel = {
  id: string;
  name: string;
  businessType: 'image_generation' | 'text_processing';
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
  downstreamImageApiType?: DownstreamImageApiType;
  bananaAllowedModels?: string[];
  bananaAllowedImageSizes?: BananaImageSize[];
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
  bananaImagePricingMatrix: BananaImageSellPriceRow[];
  chatCompletionsUnitPrice: number;
  chatCompletionsUnitPriceYuan?: number;
  systemPolicy: ConsoleSystemPolicy;
};

export type OnboardingAnalysisResult = {
  detectedKind: ConsoleUpstreamKind;
  upstreamDraft: ConsoleUpstream;
  channelDraft: ConsoleChannel;
  warnings: string[];
  recommendations: string[];
  probe: OnboardingProbeResult;
  probeLog: OnboardingProbeLogEntry[];
  probeReport?: OnboardingProbeAnalysisReport;
};

export type OnboardingAnalyzeJob = {
  jobId: string;
  status: 'running' | 'completed' | 'failed';
  createdAt: number;
  updatedAt: number;
  message?: string;
  probeLog?: OnboardingProbeLogEntry[];
  result?: OnboardingAnalysisResult;
};

export type OnboardingAnalyzeRequest = {
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
  background?: ImageBackgroundMode;
  stream?: boolean;
  partialImages?: number;
  moderation?: ModerationMode;
  n?: number;
  responsesInputShape?: ResponsesInputShape;
  responsesToolChoice?: ResponsesToolChoiceMode;
  responsesToolChoiceFormat?: ResponsesToolChoiceFormat;
  customBodyFields?: Record<string, unknown>;
};
