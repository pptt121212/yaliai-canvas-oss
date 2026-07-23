import { createJsonStore } from '../storage/jsonStore.js';
import { createPostgresControlPlaneRepository } from '../storage/postgresRepositories.js';
import { startPostgresConfigListener } from '../storage/postgresConfigEvents.js';
import type { ControlPlaneRepository } from '../storage/repositoryContracts.js';
import { hasDatabaseUrl, requireDatabaseUrl } from '../storage/storageMode.js';

requireDatabaseUrl('control_plane');

export type RoutingPolicyConfig = {
  allowUserSuppliedKey: boolean;
  smartRoutingCostPriorityBaseDelta: number;
};

export type PublicApiConfig = {
  enabled: boolean;
  authMode: 'admin_key' | 'tenant_key' | 'disabled';
  rateLimitPerMinute: number;
  maxConcurrency: number;
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

export type CanvasPolicyConfig = {
  allowUserSuppliedProviders: boolean;
  brandLogoUrl: string;
  entryMode: 'login' | 'settings';
};

export type MaintenancePolicyConfig = {
  generatedImageRetentionMinutes: number;
  canvasReferenceAssetRetentionMinutes: number;
  requestTraceRetentionMinutes: number;
  taskRecordRetentionDays: number;
  auditLogRetentionDays: number;
  billingLedgerRetentionDays: number;
};

export type AnalyticsPolicyConfig = {
  operationalRollupEnabled: boolean;
  operationalRollupIntervalMinutes: number;
  operationalRollupLookbackDays: number;
};

export type AdminControlPlaneConfig = {
  routing: RoutingPolicyConfig;
  publicApi: PublicApiConfig;
  canvas: CanvasPolicyConfig;
  maintenance: MaintenancePolicyConfig;
  analytics: AnalyticsPolicyConfig;
};

function resolveDurationMinutesFromMs(envKey: string, fallbackMs: number) {
  const raw = Number(process.env[envKey] || 0);
  const effectiveMs = Number.isFinite(raw) && raw > 0 ? raw : fallbackMs;
  return Math.max(1, Math.floor(effectiveMs / 60_000));
}

function resolveDurationDaysFromMs(envKey: string, fallbackMs: number) {
  const raw = Number(process.env[envKey] || 0);
  const effectiveMs = Number.isFinite(raw) && raw > 0 ? raw : fallbackMs;
  return Math.max(1, Math.floor(effectiveMs / (24 * 60 * 60 * 1000)));
}

const defaultControlPlaneConfig: AdminControlPlaneConfig = {
  routing: {
    allowUserSuppliedKey: true,
    smartRoutingCostPriorityBaseDelta: 30,
  },
  publicApi: {
    enabled: true,
    authMode: 'tenant_key',
    rateLimitPerMinute: 3000,
    maxConcurrency: 120,
    maxInputImageMb: 12,
    maxInputImageCount: 6,
    maxInputImageTotalMb: 30,
    exposeGenerations: true,
    exposeEdits: true,
    overloadGuardEnabled: false,
    overloadGuardMinAvailableMemoryRatio: 0.15,
    overloadGuardMaxCpuLoadRatio: 0.85,
    overloadGuardMaxEventLoopDelayMs: 250,
  },
  canvas: {
    allowUserSuppliedProviders: true,
    brandLogoUrl: '/logo.svg',
    entryMode: 'login',
  },
  maintenance: {
    generatedImageRetentionMinutes: resolveDurationMinutesFromMs('GENERATED_IMAGE_RETENTION_MS', 20 * 60 * 1000),
    canvasReferenceAssetRetentionMinutes: resolveDurationMinutesFromMs('CANVAS_REFERENCE_ASSET_RETENTION_MS', 20 * 60 * 1000),
    requestTraceRetentionMinutes: resolveDurationMinutesFromMs('OPERATIONAL_TRACE_RETENTION_MS', 30 * 60 * 1000),
    taskRecordRetentionDays: resolveDurationDaysFromMs('OPERATIONAL_TASK_RETENTION_MS', 14 * 24 * 60 * 60 * 1000),
    auditLogRetentionDays: resolveDurationDaysFromMs('OPERATIONAL_AUDIT_RETENTION_MS', 90 * 24 * 60 * 60 * 1000),
    billingLedgerRetentionDays: resolveDurationDaysFromMs('OPERATIONAL_BILLING_RETENTION_MS', 180 * 24 * 60 * 60 * 1000),
  },
  analytics: {
    operationalRollupEnabled: false,
    operationalRollupIntervalMinutes: Math.max(15, Math.floor(Number(process.env.OPERATIONAL_ROLLUP_INTERVAL_MS || 6 * 60 * 60 * 1000) / 60_000)),
    operationalRollupLookbackDays: Math.max(1, Math.min(3, Number(process.env.OPERATIONAL_ROLLUP_LOOKBACK_DAYS || 2))),
  },
};

function mergeWithDefaults(input: Partial<AdminControlPlaneConfig> | null | undefined): AdminControlPlaneConfig {
  const publicApi: Partial<PublicApiConfig> = input?.publicApi || {};
  const canvas: Partial<CanvasPolicyConfig> = input?.canvas || {};
  const maintenance: Partial<MaintenancePolicyConfig> = input?.maintenance || {};
  const analytics: Partial<AnalyticsPolicyConfig> = input?.analytics || {};
  return {
    routing: {
      allowUserSuppliedKey: typeof input?.routing?.allowUserSuppliedKey === 'boolean'
        ? input.routing.allowUserSuppliedKey
        : defaultControlPlaneConfig.routing.allowUserSuppliedKey,
      smartRoutingCostPriorityBaseDelta: Math.max(
        0,
        Math.min(
          100,
          Math.floor(Number(input?.routing?.smartRoutingCostPriorityBaseDelta ?? defaultControlPlaneConfig.routing.smartRoutingCostPriorityBaseDelta)),
        ),
      ),
    },
    publicApi: {
      enabled: typeof publicApi.enabled === 'boolean' ? publicApi.enabled : defaultControlPlaneConfig.publicApi.enabled,
      authMode: publicApi.authMode === 'admin_key' || publicApi.authMode === 'disabled' || publicApi.authMode === 'tenant_key'
        ? publicApi.authMode
        : defaultControlPlaneConfig.publicApi.authMode,
      rateLimitPerMinute: Math.max(0, Math.floor(Number(publicApi.rateLimitPerMinute ?? defaultControlPlaneConfig.publicApi.rateLimitPerMinute))),
      maxConcurrency: Math.max(0, Math.floor(Number(publicApi.maxConcurrency ?? defaultControlPlaneConfig.publicApi.maxConcurrency))),
      maxInputImageMb: Math.max(
        1,
        Math.min(12, Number(publicApi.maxInputImageMb ?? defaultControlPlaneConfig.publicApi.maxInputImageMb)),
      ),
      maxInputImageCount: Math.max(
        1,
        Math.min(6, Math.floor(Number(publicApi.maxInputImageCount ?? defaultControlPlaneConfig.publicApi.maxInputImageCount))),
      ),
      maxInputImageTotalMb: Math.max(
        1,
        Math.min(30, Number(publicApi.maxInputImageTotalMb ?? defaultControlPlaneConfig.publicApi.maxInputImageTotalMb)),
      ),
      exposeGenerations: typeof publicApi.exposeGenerations === 'boolean'
        ? publicApi.exposeGenerations
        : defaultControlPlaneConfig.publicApi.exposeGenerations,
      exposeEdits: typeof publicApi.exposeEdits === 'boolean'
        ? publicApi.exposeEdits
        : defaultControlPlaneConfig.publicApi.exposeEdits,
      overloadGuardEnabled: typeof publicApi.overloadGuardEnabled === 'boolean'
        ? publicApi.overloadGuardEnabled
        : defaultControlPlaneConfig.publicApi.overloadGuardEnabled,
      overloadGuardMinAvailableMemoryRatio: Math.max(
        0.03,
        Math.min(0.8, Number(publicApi.overloadGuardMinAvailableMemoryRatio ?? defaultControlPlaneConfig.publicApi.overloadGuardMinAvailableMemoryRatio)),
      ),
      overloadGuardMaxCpuLoadRatio: Math.max(
        0.1,
        Math.min(2, Number(publicApi.overloadGuardMaxCpuLoadRatio ?? defaultControlPlaneConfig.publicApi.overloadGuardMaxCpuLoadRatio)),
      ),
      overloadGuardMaxEventLoopDelayMs: Math.max(
        25,
        Math.min(10_000, Math.floor(Number(publicApi.overloadGuardMaxEventLoopDelayMs ?? defaultControlPlaneConfig.publicApi.overloadGuardMaxEventLoopDelayMs))),
      ),
    },
    canvas: {
      allowUserSuppliedProviders: typeof canvas.allowUserSuppliedProviders === 'boolean'
        ? canvas.allowUserSuppliedProviders
        : defaultControlPlaneConfig.canvas.allowUserSuppliedProviders,
      brandLogoUrl: String(canvas.brandLogoUrl ?? defaultControlPlaneConfig.canvas.brandLogoUrl),
      entryMode: canvas.entryMode === 'settings' ? 'settings' : 'login',
    },
    maintenance: {
      generatedImageRetentionMinutes: Math.max(
        1,
        Math.floor(Number(maintenance.generatedImageRetentionMinutes ?? defaultControlPlaneConfig.maintenance.generatedImageRetentionMinutes)),
      ),
      canvasReferenceAssetRetentionMinutes: Math.max(
        1,
        Math.floor(Number(maintenance.canvasReferenceAssetRetentionMinutes ?? defaultControlPlaneConfig.maintenance.canvasReferenceAssetRetentionMinutes)),
      ),
      requestTraceRetentionMinutes: Math.max(
        1,
        Math.floor(Number(maintenance.requestTraceRetentionMinutes ?? defaultControlPlaneConfig.maintenance.requestTraceRetentionMinutes)),
      ),
      taskRecordRetentionDays: Math.max(
        1,
        Math.floor(Number(maintenance.taskRecordRetentionDays ?? defaultControlPlaneConfig.maintenance.taskRecordRetentionDays)),
      ),
      auditLogRetentionDays: Math.max(
        1,
        Math.floor(Number(maintenance.auditLogRetentionDays ?? defaultControlPlaneConfig.maintenance.auditLogRetentionDays)),
      ),
      billingLedgerRetentionDays: Math.max(
        1,
        Math.floor(Number(maintenance.billingLedgerRetentionDays ?? defaultControlPlaneConfig.maintenance.billingLedgerRetentionDays)),
      ),
    },
    analytics: {
      operationalRollupEnabled: typeof analytics.operationalRollupEnabled === 'boolean'
        ? analytics.operationalRollupEnabled
        : defaultControlPlaneConfig.analytics.operationalRollupEnabled,
      operationalRollupIntervalMinutes: Math.max(
        15,
        Math.min(
          24 * 60,
          Math.floor(Number(analytics.operationalRollupIntervalMinutes ?? defaultControlPlaneConfig.analytics.operationalRollupIntervalMinutes)),
        ),
      ),
      operationalRollupLookbackDays: Math.max(
        1,
        Math.min(
        3,
          Math.floor(Number(analytics.operationalRollupLookbackDays ?? defaultControlPlaneConfig.analytics.operationalRollupLookbackDays)),
        ),
      ),
    },
  };
}

function readConfig(): AdminControlPlaneConfig {
  return controlPlaneCache;
}

function writeConfig(config: AdminControlPlaneConfig) {
  const next = mergeWithDefaults(config);
  controlPlaneCache = next;
  if (postgresControlPlaneRepository) {
    void postgresControlPlaneRepository.save(next);
    return;
  }
  controlPlaneStore.write(next);
}

const controlPlaneStore = createJsonStore<AdminControlPlaneConfig>({
  envDirKey: 'ADMIN_DATA_DIR',
  defaultDirName: 'data',
  fileName: 'admin-control-plane.json',
  createDefault: () => defaultControlPlaneConfig,
  mergeOnRead: (input) => mergeWithDefaults(input as Partial<AdminControlPlaneConfig> | null | undefined),
});

const postgresControlPlaneRepository = hasDatabaseUrl()
  ? createPostgresControlPlaneRepository({
      connectionString: process.env.DATABASE_URL,
      schema: process.env.PG_SCHEMA || 'public',
      fallback: () => defaultControlPlaneConfig,
    })
  : null;

let controlPlaneCache = postgresControlPlaneRepository ? defaultControlPlaneConfig : controlPlaneStore.read();
let controlPlaneRefreshPromise: Promise<AdminControlPlaneConfig> | null = null;
let controlPlaneListenerStarted = false;
const controlPlaneSubscribers = new Set<(config: AdminControlPlaneConfig) => void>();

function notifyControlPlaneSubscribers(config: AdminControlPlaneConfig) {
  for (const subscriber of controlPlaneSubscribers) {
    try {
      subscriber(config);
    } catch {
      // Runtime observers must not prevent a configuration refresh.
    }
  }
}

async function refreshControlPlaneCache() {
  if (controlPlaneRefreshPromise) {
    return controlPlaneRefreshPromise;
  }
  controlPlaneRefreshPromise = (async () => {
    if (postgresControlPlaneRepository) {
      controlPlaneCache = mergeWithDefaults(await postgresControlPlaneRepository.get());
      notifyControlPlaneSubscribers(controlPlaneCache);
      return controlPlaneCache;
    }
    controlPlaneCache = controlPlaneStore.read();
    notifyControlPlaneSubscribers(controlPlaneCache);
    return controlPlaneCache;
  })();
  try {
    return await controlPlaneRefreshPromise;
  } finally {
    controlPlaneRefreshPromise = null;
  }
}

export async function initializeAdminControlPlaneStore() {
  const controlPlane = await refreshControlPlaneCache();
  if (!controlPlaneListenerStarted && postgresControlPlaneRepository) {
    controlPlaneListenerStarted = true;
    await startPostgresConfigListener('control_plane', () => {
      void refreshControlPlaneCache();
    });
  }
  return controlPlane;
}

export const adminControlPlaneStore: ControlPlaneRepository & {
  refreshAsync: () => Promise<AdminControlPlaneConfig>;
  saveAsync: (config: AdminControlPlaneConfig) => Promise<AdminControlPlaneConfig>;
  getStorageInfo: () => {
    controlPlaneDataDir: string;
    controlPlaneFilePath: string;
  };
} = {
  get() {
    return readConfig();
  },
  save(config: AdminControlPlaneConfig) {
    writeConfig(config);
    notifyControlPlaneSubscribers(controlPlaneCache);
    return readConfig();
  },
  async refreshAsync() {
    return refreshControlPlaneCache();
  },
  async saveAsync(config: AdminControlPlaneConfig) {
    const next = mergeWithDefaults(config);
    controlPlaneCache = next;
    if (postgresControlPlaneRepository) {
      await postgresControlPlaneRepository.save(next);
      notifyControlPlaneSubscribers(controlPlaneCache);
      return controlPlaneCache;
    }
    controlPlaneStore.write(next);
    controlPlaneCache = controlPlaneStore.read();
    notifyControlPlaneSubscribers(controlPlaneCache);
    return controlPlaneCache;
  },
  getStorageInfo() {
    const filePath = postgresControlPlaneRepository
      ? `postgresql://${process.env.PG_SCHEMA || 'public'}.control_plane_config`
      : controlPlaneStore.getFilePath();
    return {
      controlPlaneDataDir: postgresControlPlaneRepository ? 'postgresql' : filePath.replace(/[\\/][^\\/]+$/, ''),
      controlPlaneFilePath: filePath,
    };
  },
};

export function subscribeAdminControlPlane(listener: (config: AdminControlPlaneConfig) => void) {
  controlPlaneSubscribers.add(listener);
  return () => controlPlaneSubscribers.delete(listener);
}

export const providerAdapterCatalog = [
  {
    adapterKey: 'openai_images',
    title: 'OpenAI Images',
    category: 'standard',
    description: '标准 OpenAI Images 接口，适用于文生图和图生图的通用兼容接入。',
    supportsProtocols: ['openai_images'],
    supportsSync: true,
    supportsAsync: false,
  },
  {
    adapterKey: 'openai_responses',
    title: 'OpenAI Responses',
    category: 'standard',
    description: '标准 OpenAI Responses 接口，适合需要对话、搜索增强或多模态串联的图像能力。',
    supportsProtocols: ['openai_responses'],
    supportsSync: true,
    supportsAsync: false,
  },
  {
    adapterKey: 'jingyu_unified_async',
    title: '京玉统一异步图像',
    category: 'specialized',
    description: '针对京玉统一图片任务接口的异步适配器，文生图与图生图共用统一任务提交与轮询语义。',
    supportsProtocols: ['openai_images', 'custom_async_media'],
    supportsSync: false,
    supportsAsync: true,
  },
];
