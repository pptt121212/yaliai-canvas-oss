export type BillingQuoteInput = {
  model: string;
  outputType: 'image' | 'video';
  resolution?: string;
  duration?: number;
};

export type BillingQuote = {
  reserveCredits: number;
  maxChargeCredits: number;
  currency: 'credits';
};

export interface BillingPolicy {
  quote(input: BillingQuoteInput): BillingQuote;
}

export type ResolutionTier = '1k' | '2k' | '4k';

export type ParsedImageSize = {
  width: number;
  height: number;
  pixels: number;
  ratio: number;
  normalized: string;
};

const ONE_K_PIXELS = 1024 * 1024;
const TWO_K_PIXELS = 2048 * 1152;
const FOUR_K_PIXELS = 3840 * 2160;
const ONE_K_MAX_PIXELS = 1024 * 1536;
const TWO_K_MAX_PIXELS = 2560 * 2048;

const CANONICAL_RESOLUTION_PROFILES = [
  { aspect: '1:1', sizes: { '1k': '1024x1024', '2k': '2048x2048', '4k': '2880x2880' } },
  { aspect: '3:2', sizes: { '1k': '1536x1024', '2k': '2048x1360', '4k': '3520x2336' } },
  { aspect: '2:3', sizes: { '1k': '1024x1536', '2k': '1360x2048', '4k': '2336x3520' } },
  { aspect: '4:3', sizes: { '1k': '1024x768', '2k': '2048x1536', '4k': '3312x2480' } },
  { aspect: '3:4', sizes: { '1k': '768x1024', '2k': '1536x2048', '4k': '2480x3312' } },
  { aspect: '5:4', sizes: { '1k': '1280x1024', '2k': '2560x2048', '4k': '3216x2576' } },
  { aspect: '4:5', sizes: { '1k': '1024x1280', '2k': '2048x2560', '4k': '2576x3216' } },
  { aspect: '16:9', sizes: { '1k': '1536x864', '2k': '2048x1152', '4k': '3840x2160' } },
  { aspect: '9:16', sizes: { '1k': '864x1536', '2k': '1152x2048', '4k': '2160x3840' } },
  { aspect: '2:1', sizes: { '1k': '2048x1024', '2k': '2688x1344', '4k': '3840x1920' } },
  { aspect: '1:2', sizes: { '1k': '1024x2048', '2k': '1344x2688', '4k': '1920x3840' } },
  { aspect: '21:9', sizes: { '1k': '2016x864', '2k': '2688x1152', '4k': '3840x1648' } },
  { aspect: '9:21', sizes: { '1k': '864x2016', '2k': '1152x2688', '4k': '1648x3840' } },
] as const;

const canonicalSizeTierByNormalizedSize = new Map<string, ResolutionTier>();
for (const profile of CANONICAL_RESOLUTION_PROFILES) {
  for (const tier of ['1k', '2k', '4k'] as const) {
    canonicalSizeTierByNormalizedSize.set(parseImageSize(profile.sizes[tier])!.normalized, tier);
  }
}

export function parseImageSize(input: string | null | undefined): ParsedImageSize | null {
  const value = String(input || '').trim().toLowerCase();
  if (!value || value === 'auto') {
    return null;
  }

  const match = value.match(/^(\d+)x(\d+)$/);
  if (!match) {
    return null;
  }

  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return null;
  }

  return {
    width,
    height,
    pixels: width * height,
    ratio: width / height,
    normalized: `${width}x${height}`,
  };
}

export function classifyResolutionTierFromPixels(pixels: number | null | undefined): ResolutionTier | null {
  const normalized = Number(pixels);
  if (!Number.isFinite(normalized) || normalized <= 0) {
    return null;
  }

  if (normalized <= ONE_K_MAX_PIXELS) {
    return '1k';
  }
  if (normalized <= TWO_K_MAX_PIXELS) {
    return '2k';
  }
  return '4k';
}

function classifyResolutionTierFromParsedSize(parsed: ParsedImageSize): ResolutionTier {
  const exactTier = canonicalSizeTierByNormalizedSize.get(parsed.normalized);
  if (exactTier) {
    return exactTier;
  }

  return classifyResolutionTierFromPixels(parsed.pixels) || '1k';
}

export function classifyResolutionTier(input: string | ParsedImageSize | null | undefined): ResolutionTier | null {
  if (!input) {
    return null;
  }
  const parsed = typeof input === 'string' ? parseImageSize(input) : input;
  return parsed ? classifyResolutionTierFromParsedSize(parsed) : null;
}

export function getResolutionTierBasePixels(tier: ResolutionTier): number {
  if (tier === '1k') {
    return ONE_K_PIXELS;
  }
  if (tier === '2k') {
    return TWO_K_PIXELS;
  }
  return FOUR_K_PIXELS;
}

export function getResolutionTierThresholds() {
  return {
    oneKToTwoK: ONE_K_MAX_PIXELS,
    twoKToFourK: TWO_K_MAX_PIXELS,
  };
}

export function createFlatDemoBillingPolicy(): BillingPolicy {
  return {
    quote(input) {
      if (input.outputType === 'video') {
        const seconds = Math.max(1, input.duration || 1);
        return {
          reserveCredits: seconds * 10,
          maxChargeCredits: seconds * 10,
          currency: 'credits'
        };
      }
      return {
        reserveCredits: 8,
        maxChargeCredits: 12,
        currency: 'credits'
      };
    }
  };
}
