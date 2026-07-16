import {
  computeProviderRuntimeAfterAttempt,
  createInMemoryProviderRegistry,
  createProviderRouter,
  resolveProviderRuntimeForRead,
  type ProviderConfig,
  type ProviderRegistry,
  type ProviderRoutingMode,
  type ProviderSelectionContext,
  type ProviderRuntimeState,
} from '@yali/provider-core';
import { createJsonStore } from './modules/storage/jsonStore.js';
import { createPostgresProviderRepository } from './modules/storage/postgresRepositories.js';
import { startPostgresConfigListener } from './modules/storage/postgresConfigEvents.js';
import { appendAuditRecord } from './modules/storage/operationalService.js';
import type { ProviderRepository } from './modules/storage/repositoryContracts.js';
import { hotStateStore, updateHotProviderRuntime } from './modules/storage/runtimeStores.js';
import { hasDatabaseUrl, requireDatabaseUrl } from './modules/storage/storageMode.js';

requireDatabaseUrl('provider_registry');

const seedProviders: ProviderConfig[] = [];

function readProviderFile(): ProviderConfig[] {
  return providerCache;
}

function writeProviderFile(items: ProviderConfig[]) {
  setProviderCache(items);
  if (postgresProviderRepository) {
    void postgresProviderRepository.replaceAll(items);
    return;
  }
  providerStore.write(items);
}

const providerStore = createJsonStore<ProviderConfig[]>({
  envDirKey: 'PROVIDER_DATA_DIR',
  defaultDirName: 'data',
  fileName: 'providers.json',
  createDefault: () => seedProviders,
  mergeOnRead: (input) => Array.isArray(input) ? input as ProviderConfig[] : seedProviders,
});

const postgresProviderRepository = hasDatabaseUrl()
  ? createPostgresProviderRepository({
      connectionString: process.env.DATABASE_URL,
      schema: process.env.PG_SCHEMA || 'public',
      fallback: () => seedProviders,
    })
  : null;

let providerCache = postgresProviderRepository ? seedProviders : providerStore.read();
let providerCacheById = new Map(providerCache.map((provider) => [provider.providerId, provider]));
let providerRefreshPromise: Promise<ProviderConfig[]> | null = null;
let providerListenerStarted = false;

function setProviderCache(items: ProviderConfig[]) {
  providerCache = items;
  providerCacheById = new Map(items.map((provider) => [provider.providerId, provider]));
  return providerCache;
}

function createRegistry(items: ProviderConfig[]): ProviderRegistry {
  return createInMemoryProviderRegistry(items);
}

function mergeProviderRuntime(provider: ProviderConfig): ProviderConfig {
  const runtime = hotStateStore.getProviderRuntime(provider.providerId)
    || (provider.metadata?.runtime as ProviderRuntimeState | undefined);
  const mergedRuntime = normalizeRuntimeForRead(runtime, provider);
  return {
    ...provider,
    healthScore: Number(mergedRuntime?.healthScore || provider.healthScore || 100),
    healthState: mergedRuntime?.healthState || provider.healthState,
    metadata: {
      ...(provider.metadata || {}),
      runtime: mergedRuntime,
    },
  };
}

function buildRuntimeRegistryItems(items: ProviderConfig[]) {
  return items.map((provider) => mergeProviderRuntime(provider));
}

function createRuntimeRegistry(items: ProviderConfig[]) {
  return createRegistry(buildRuntimeRegistryItems(items));
}

let runtimeRegistry: ProviderRegistry = createRuntimeRegistry(providerCache);

const routers = new Map<ProviderRoutingMode, ReturnType<typeof createProviderRouter>>([
  ['priority_failover', createProviderRouter('priority_failover')],
  ['health_weighted_best', createProviderRouter('health_weighted_best')],
  ['round_robin_failover', createProviderRouter('round_robin_failover')],
  ['weighted_round_robin', createProviderRouter('weighted_round_robin')],
  ['least_recently_used', createProviderRouter('least_recently_used')],
]);

function rebuildRuntimeRegistry(items: ProviderConfig[]) {
  runtimeRegistry = createRuntimeRegistry(items);
}

async function refreshProviderCache() {
  if (providerRefreshPromise) {
    return providerRefreshPromise;
  }
  providerRefreshPromise = (async () => {
    setProviderCache(postgresProviderRepository
      ? await postgresProviderRepository.list()
      : providerStore.read());
    rebuildRuntimeRegistry(providerCache);
    return providerCache;
  })();
  try {
    return await providerRefreshPromise;
  } finally {
    providerRefreshPromise = null;
  }
}

function normalizeRuntimeForRead(
  runtime: ProviderRuntimeState | undefined,
  provider: ProviderConfig,
): ProviderRuntimeState | undefined {
  return runtime ? resolveProviderRuntimeForRead(runtime, provider) : undefined;
}

function persistProviders(items: ProviderConfig[]) {
  providerRepository.replaceAll(items);
  rebuildRuntimeRegistry(items);
  void appendAuditRecord({
    actorType: 'system',
    actorId: 'provider-registry',
    action: 'provider_registry_replace_all',
    targetType: 'upstream',
    targetId: 'provider-registry',
    status: 'accepted',
    message: 'Provider registry updated.',
    detail: { providerCount: items.length },
  });
  return items;
}

async function persistProvidersAsync(items: ProviderConfig[]) {
  setProviderCache(items);
  if (postgresProviderRepository) {
    await postgresProviderRepository.replaceAll(items);
  } else {
    providerStore.write(items);
  }
  rebuildRuntimeRegistry(items);
  void appendAuditRecord({
    actorType: 'system',
    actorId: 'provider-registry',
    action: 'provider_registry_replace_all',
    targetType: 'upstream',
    targetId: 'provider-registry',
    status: 'accepted',
    message: 'Provider registry updated.',
    detail: { providerCount: items.length },
  });
  return items;
}

function listRuntimeProviders(): ProviderConfig[] {
  return buildRuntimeRegistryItems(providerCache);
}

function findProvider(providerId: string): ProviderConfig | null {
  return providerCacheById.get(providerId) || null;
}

function computeNextRuntimeState(
  provider: ProviderConfig,
  currentRuntime: ProviderRuntimeState | null,
  report: Parameters<ProviderRegistry['reportAttempt']>[0],
) {
  return computeProviderRuntimeAfterAttempt({
    ...provider,
    metadata: {
      ...(provider.metadata || {}),
      runtime: currentRuntime || undefined,
    },
  }, currentRuntime, report);
}

export const providerRegistry = {
  list() {
    return listRuntimeProviders();
  },
  get(providerId: string) {
    const provider = findProvider(providerId);
    return provider ? mergeProviderRuntime(provider) : runtimeRegistry.get(providerId);
  },
  getRuntimeState(providerId: string) {
    const provider = findProvider(providerId);
    if (!provider) {
      return runtimeRegistry.getRuntimeState(providerId);
    }
    const runtime = hotStateStore.getProviderRuntime(providerId)
      || runtimeRegistry.getRuntimeState(providerId)
      || (provider.metadata?.runtime as ProviderRuntimeState | undefined)
      || undefined;
    return normalizeRuntimeForRead(runtime, provider) || null;
  },
  register(provider: ProviderConfig) {
    const next = listRuntimeProviders()
      .filter((item) => item.providerId !== provider.providerId)
      .concat(provider);
    persistProviders(next);
  },
  async reportAttempt(report: Parameters<ProviderRegistry['reportAttempt']>[0]) {
    const provider = findProvider(report.providerId);
    if (!provider) {
      return;
    }
    await updateHotProviderRuntime(
      report.providerId,
      (currentRuntime) => computeNextRuntimeState(provider, currentRuntime, report),
    );
  },
  remove(providerId: string) {
    const next = listRuntimeProviders().filter((item) => item.providerId !== providerId).map(stripRuntimeMetadata);
    persistProviders(next);
  },
  replaceAll(providers: ProviderConfig[]) {
    const existingIds = new Set(listRuntimeProviders().map((item) => item.providerId));
    const nextIds = new Set(providers.map((item) => item.providerId));
    persistProviders(providers);
    for (const providerId of existingIds) {
      if (!nextIds.has(providerId)) {
        hotStateStore.deleteProviderRuntime(providerId);
      }
    }
  },
  async replaceAllAsync(providers: ProviderConfig[]) {
    const existingIds = new Set(listRuntimeProviders().map((item) => item.providerId));
    const nextIds = new Set(providers.map((item) => item.providerId));
    await persistProvidersAsync(providers);
    for (const providerId of existingIds) {
      if (!nextIds.has(providerId)) {
        hotStateStore.deleteProviderRuntime(providerId);
      }
    }
  },
  reload() {
    rebuildRuntimeRegistry(providerRepository.list());
  },
  async reloadAsync() {
    await refreshProviderCache();
  },
  async refreshAsync() {
    return refreshProviderCache();
  },
};

export const providerRepository: ProviderRepository = {
  list() {
    return readProviderFile();
  },
  replaceAll(items: ProviderConfig[]) {
    writeProviderFile(items);
    return providerCache;
  },
};

export async function initializeProviderRegistry() {
  await refreshProviderCache();
  if (!providerListenerStarted && postgresProviderRepository) {
    providerListenerStarted = true;
    await startPostgresConfigListener('provider_registry', () => {
      void refreshProviderCache();
    });
  }
  return providerRegistry.list();
}

function stripRuntimeMetadata(provider: ProviderConfig): ProviderConfig {
  const metadata = provider.metadata && typeof provider.metadata === 'object'
    ? { ...provider.metadata }
    : undefined;

  if (metadata && 'runtime' in metadata) {
    delete metadata.runtime;
  }

  return {
    ...provider,
    metadata: metadata && Object.keys(metadata).length ? metadata : undefined,
  };
}

export function getProviderRuntimeState(providerId: string): ProviderRuntimeState | null {
  return hotStateStore.getProviderRuntime(providerId);
}

export function resolveProvider(context: ProviderSelectionContext) {
  const mode = context.routingMode || 'priority_failover';
  const router = routers.get(mode) || routers.get('priority_failover');
  return router!.pickProvider(context, listRuntimeProviders());
}

export function getProviderStorageInfo() {
  const filePath = postgresProviderRepository
    ? `postgresql://${process.env.PG_SCHEMA || 'public'}.provider_registry`
    : providerStore.getFilePath();
  return {
    providerDataDir: postgresProviderRepository ? 'postgresql' : filePath.replace(/[\\/][^\\/]+$/, ''),
    providerFilePath: filePath,
  };
}
