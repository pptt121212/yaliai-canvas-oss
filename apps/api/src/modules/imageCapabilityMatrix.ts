export type ImageCapabilityTier = 'auto' | '1k' | '2k' | '4k';
export type ImageCapabilityQuality = 'auto' | 'low' | 'medium' | 'high';

export type ImageCapabilityProfileLike = {
  tier?: unknown;
  qualities?: unknown;
  costs?: unknown;
};

export type ImageCapabilityCostResolution = {
  configured: boolean;
  value: number;
  source: 'exact' | 'highest_configured_fallback' | 'unconfigured';
};

const tiers: ImageCapabilityTier[] = ['auto', '1k', '2k', '4k'];
const qualities: ImageCapabilityQuality[] = ['auto', 'low', 'medium', 'high'];

const tierRank: Record<ImageCapabilityTier, number> = {
  auto: 0,
  '1k': 1,
  '2k': 2,
  '4k': 3,
};

const qualityRank: Record<ImageCapabilityQuality, number> = {
  auto: 0,
  low: 1,
  medium: 2,
  high: 3,
};

function normalizeTier(value: unknown): ImageCapabilityTier | null {
  const normalized = String(value || '').trim().toLowerCase();
  return tiers.includes(normalized as ImageCapabilityTier) ? normalized as ImageCapabilityTier : null;
}

function normalizeQuality(value: unknown): ImageCapabilityQuality | null {
  const normalized = String(value || '').trim().toLowerCase();
  return qualities.includes(normalized as ImageCapabilityQuality) ? normalized as ImageCapabilityQuality : null;
}

function profileForTier(profiles: ImageCapabilityProfileLike[], tier: ImageCapabilityTier) {
  return profiles.find((profile) => normalizeTier(profile?.tier) === tier);
}

function enabledQualities(profile: ImageCapabilityProfileLike | undefined) {
  const configured = Array.isArray(profile?.qualities) ? profile.qualities : [];
  return qualities.filter((quality) => configured.some((item) => normalizeQuality(item) === quality));
}

function costFor(profile: ImageCapabilityProfileLike | undefined, quality: ImageCapabilityQuality) {
  const costs = profile?.costs && typeof profile.costs === 'object'
    ? profile.costs as Record<string, unknown>
    : null;
  if (!costs || costs[quality] === undefined) {
    return null;
  }
  const value = Number(costs[quality]);
  return Number.isFinite(value) ? Math.max(0, value) : null;
}

/**
 * Undefined preserves compatibility for user-supplied or legacy providers
 * without a matrix. An explicit matrix, including an empty one, is strict.
 */
export function supportsImageCapabilityCombination(
  profiles: ImageCapabilityProfileLike[] | undefined,
  tier: ImageCapabilityTier,
  quality: ImageCapabilityQuality,
) {
  if (profiles === undefined) {
    return true;
  }
  return enabledQualities(profileForTier(profiles, tier)).includes(quality);
}

export function hasEnabledImageCapabilityTier(
  profiles: ImageCapabilityProfileLike[] | undefined,
  tier: ImageCapabilityTier,
) {
  if (profiles === undefined) {
    return true;
  }
  return enabledQualities(profileForTier(profiles, tier)).length > 0;
}

/** Uses the same highest enabled tier/quality fallback for routing and reports. */
export function resolveImageCapabilityCost(
  profiles: ImageCapabilityProfileLike[] | undefined,
  tier: ImageCapabilityTier,
  quality: ImageCapabilityQuality,
): ImageCapabilityCostResolution {
  if (!profiles) {
    return { configured: false, value: 0, source: 'unconfigured' };
  }
  const exactProfile = profileForTier(profiles, tier);
  if (enabledQualities(exactProfile).includes(quality)) {
    const exactCost = costFor(exactProfile, quality);
    if (exactCost !== null) {
      return { configured: true, value: exactCost, source: 'exact' };
    }
  }

  let highest: { tier: ImageCapabilityTier; quality: ImageCapabilityQuality; value: number } | null = null;
  for (const profile of profiles) {
    const profileTier = normalizeTier(profile?.tier);
    if (!profileTier) {
      continue;
    }
    for (const profileQuality of enabledQualities(profile)) {
      const value = costFor(profile, profileQuality);
      if (value === null) {
        continue;
      }
      if (!highest
        || tierRank[profileTier] > tierRank[highest.tier]
        || (tierRank[profileTier] === tierRank[highest.tier] && qualityRank[profileQuality] > qualityRank[highest.quality])) {
        highest = { tier: profileTier, quality: profileQuality, value };
      }
    }
  }
  return highest
    ? { configured: true, value: highest.value, source: 'highest_configured_fallback' }
    : { configured: false, value: 0, source: 'unconfigured' };
}
