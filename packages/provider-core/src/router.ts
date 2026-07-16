import type {
  ProviderConfig,
  ProviderRouter,
  ProviderRoutingMode,
  ProviderSelectionContext,
  ProviderSelectionResult,
} from './types.js';

type EligibleProvider = ProviderConfig & {
  __runtimeCooldownUntil?: number;
  __runtimeLastSelectedAt?: number;
};

function isInCooldown(provider: ProviderConfig, now: number): boolean {
  const runtime = provider.metadata?.runtime as { cooldownUntil?: number; fusedUntil?: number } | undefined;
  return Boolean(
    (runtime?.cooldownUntil && runtime.cooldownUntil > now)
    || (runtime?.fusedUntil && runtime.fusedUntil > now),
  );
}

function getRuntimeCooldownUntil(provider: ProviderConfig, now: number): number | undefined {
  const runtime = provider.metadata?.runtime as { cooldownUntil?: number; fusedUntil?: number } | undefined;
  const cooldownUntil = Number(runtime?.cooldownUntil || 0);
  const fusedUntil = Number(runtime?.fusedUntil || 0);
  const until = Math.max(cooldownUntil, fusedUntil);
  return until > now ? until : undefined;
}

function getRuntimeLastSelectedAt(provider: ProviderConfig): number {
  const runtime = provider.metadata?.runtime as { lastSelectedAt?: number } | undefined;
  return Number(runtime?.lastSelectedAt || 0);
}

function supportsOperation(provider: ProviderConfig, context: ProviderSelectionContext): boolean {
  if (context.outputType === 'video') {
    return provider.supportsVideo !== false && provider.capability?.supportsVideoGeneration !== false;
  }
  if (context.operation === 'edit') {
    return provider.capability?.supportsImageEdit !== false;
  }
  return provider.supportsImage !== false && provider.capability?.supportsImageGeneration !== false;
}

function supportsRequestMode(provider: ProviderConfig, context: ProviderSelectionContext): boolean {
  if (!context.requestMode || context.requestMode === 'either') {
    return true;
  }
  if (context.requestMode === 'sync') {
    return provider.capability?.supportsSync !== false;
  }
  return provider.capability?.supportsAsync !== false;
}

function filterEligible(context: ProviderSelectionContext, providers: ProviderConfig[]): EligibleProvider[] {
  const now = context.now || Date.now();
  return providers
    .filter((provider) => provider.healthState !== 'disabled')
    .filter((provider) => supportsOperation(provider, context))
    .filter((provider) => supportsRequestMode(provider, context))
    .filter((provider) => !provider.modelAllowlist?.length || provider.modelAllowlist.includes(context.requestedModel))
    .filter((provider) => (context.allowUserSuppliedKey ? true : provider.source === 'admin_managed'))
    .map((provider) => ({
      ...provider,
      __runtimeCooldownUntil: getRuntimeCooldownUntil(provider, now),
      __runtimeLastSelectedAt: getRuntimeLastSelectedAt(provider),
    }));
}

function pickPriorityFailover(eligible: EligibleProvider[]): ProviderConfig | null {
  return [...eligible].sort((a, b) => Number(a.priority || 100) - Number(b.priority || 100))[0] || null;
}

function pickHealthWeightedBest(eligible: EligibleProvider[]): ProviderConfig | null {
  return [...eligible].sort((a, b) => {
    const scoreA = Number(a.healthScore || 100) + Number(a.weight || 0);
    const scoreB = Number(b.healthScore || 100) + Number(b.weight || 0);
    if (scoreA !== scoreB) {
      return scoreB - scoreA;
    }
    return Number(a.priority || 100) - Number(b.priority || 100);
  })[0] || null;
}

function pickRoundRobinFailover(eligible: EligibleProvider[]): ProviderConfig | null {
  return [...eligible].sort((a, b) => {
    const lastA = Number(a.__runtimeLastSelectedAt || 0);
    const lastB = Number(b.__runtimeLastSelectedAt || 0);
    if (lastA !== lastB) {
      return lastA - lastB;
    }
    return Number(a.priority || 100) - Number(b.priority || 100);
  })[0] || null;
}

function expandWeightedList(eligible: EligibleProvider[]): EligibleProvider[] {
  const expanded: EligibleProvider[] = [];
  for (const provider of eligible) {
    const weight = Math.max(1, Math.min(100, Number(provider.weight || 1)));
    for (let index = 0; index < weight; index += 1) {
      expanded.push(provider);
    }
  }
  return expanded;
}

function pickWeightedRoundRobin(eligible: EligibleProvider[]): ProviderConfig | null {
  const expanded = expandWeightedList(eligible).sort((a, b) => {
    const lastA = Number(a.__runtimeLastSelectedAt || 0);
    const lastB = Number(b.__runtimeLastSelectedAt || 0);
    if (lastA !== lastB) {
      return lastA - lastB;
    }
    return Number(a.priority || 100) - Number(b.priority || 100);
  });
  return expanded[0] || null;
}

function pickLeastRecentlyUsed(eligible: EligibleProvider[]): ProviderConfig | null {
  return [...eligible].sort((a, b) => Number(a.__runtimeLastSelectedAt || 0) - Number(b.__runtimeLastSelectedAt || 0))[0] || null;
}

function pickByMode(mode: ProviderRoutingMode, eligible: EligibleProvider[]): ProviderConfig | null {
  switch (mode) {
    case 'health_weighted_best':
      return pickHealthWeightedBest(eligible);
    case 'round_robin_failover':
      return pickRoundRobinFailover(eligible);
    case 'weighted_round_robin':
      return pickWeightedRoundRobin(eligible);
    case 'least_recently_used':
      return pickLeastRecentlyUsed(eligible);
    case 'priority_failover':
    default:
      return pickPriorityFailover(eligible);
  }
}

export function createProviderRouter(defaultMode: ProviderRoutingMode = 'priority_failover'): ProviderRouter {
  return {
    pickProvider(context, providers): ProviderSelectionResult {
      const now = context.now || Date.now();
      const eligible = filterEligible(context, providers);
      const attemptedProviderIds = eligible.map((provider) => provider.providerId);

      if (!providers.length) {
        return {
          provider: null,
          attemptedProviderIds: [],
          reason: 'no_eligible_provider',
        };
      }

      if (!eligible.length) {
        const allDisabled = providers.every((provider) => provider.healthState === 'disabled');
        return {
          provider: null,
          attemptedProviderIds: [],
          reason: allDisabled ? 'all_disabled' : 'no_eligible_provider',
        };
      }

      const active = eligible.filter((provider) => !isInCooldown(provider, now));
      if (!active.length) {
        return {
          provider: null,
          attemptedProviderIds,
          reason: 'all_in_cooldown',
        };
      }

      const selected = pickByMode(context.routingMode || defaultMode, active);
      return {
        provider: selected,
        attemptedProviderIds,
        reason: selected ? 'selected' : 'all_attempted',
      };
    },
  };
}
