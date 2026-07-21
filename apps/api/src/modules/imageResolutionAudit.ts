import { createHash } from 'node:crypto';
import { classifyResolutionTier, parseImageSize, type ResolutionTier } from '@yali/billing-core';
import type { AdminConsoleCatalog } from './admin/consoleCatalog.js';
import type { TaskMasterRecord } from './storage/repositoryContracts.js';

export type ImageResolutionAuditRecord = {
  requestedSize?: string;
  requestedTier?: ResolutionTier;
  requestedWidth?: number;
  requestedHeight?: number;
  requestedAspectLabel?: string;
  requestedPixels?: number;
  requestedAspectRatio?: number;
  actualSize?: string;
  actualTier?: ResolutionTier;
  actualWidth?: number;
  actualHeight?: number;
  actualAspectLabel?: string;
  actualPixels?: number;
  actualAspectRatio?: number;
  exactSizeMatch?: boolean;
  sameTierMatch?: boolean;
  sameOrHigherTier?: boolean;
  tierDelta?: number;
  tierDowngradeLevels?: number;
  tierUpgradeLevels?: number;
  aspectRatioDeltaPercent?: number;
  aspectAccuracyPercent?: number;
  maxSideDeltaPercent?: number;
  widthDeltaPercent?: number;
  heightDeltaPercent?: number;
  resolutionAccuracyPercent?: number;
  extractionSource: 'response_field' | 'url_fetch' | 'base64_decode' | 'unavailable';
  imageUrl?: string;
};

export type ImageResolutionAuditBatch = {
  records: ImageResolutionAuditRecord[];
  measuredCount: number;
  requestedCount: number;
};

export type ResolutionAuditSummaryRow = {
  key: string;
  upstreamId: string;
  upstreamName: string;
  operation: 'generations' | 'edits';
  requestedSize: string;
  requestedAspectLabel: string;
  requestedTier: ResolutionTier | 'auto';
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
  requestedTier: ResolutionTier | 'auto';
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

export type BillingAuditImageRecord = ImageResolutionAuditRecord & {
  index: number;
  billedTier?: ResolutionTier;
  billedSize?: string;
};

type ImageCandidate = {
  url?: string;
  b64?: string;
  width?: number;
  height?: number;
};

type ImageCandidateCollectorState = {
  seenObjects: WeakSet<object>;
  seenCandidateKeys: Set<string>;
};

const JPEG_SOF_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3,
  0xc5, 0xc6, 0xc7,
  0xc9, 0xca, 0xcb,
  0xcd, 0xce, 0xcf,
]);
const BASE64_DIMENSION_PREFIX_BYTES = [
  4096,
  64 * 1024,
  256 * 1024,
  1024 * 1024,
];

function roundMetric(value: number | null | undefined, digits = 2): number | undefined {
  const normalized = Number(value);
  if (!Number.isFinite(normalized)) {
    return undefined;
  }
  const factor = 10 ** digits;
  return Math.round(normalized * factor) / factor;
}

function ratioAccuracyPercent(requestedRatio: number | null | undefined, actualRatio: number | null | undefined): number | undefined {
  const requested = Number(requestedRatio);
  const actual = Number(actualRatio);
  if (!Number.isFinite(requested) || !Number.isFinite(actual) || requested <= 0 || actual <= 0) {
    return undefined;
  }
  return roundMetric(Math.min(requested, actual) / Math.max(requested, actual) * 100);
}

function resolutionAccuracyPercent(requestedPixels: number | null | undefined, actualPixels: number | null | undefined): number | undefined {
  const requested = Number(requestedPixels);
  const actual = Number(actualPixels);
  if (!Number.isFinite(requested) || !Number.isFinite(actual) || requested <= 0 || actual <= 0) {
    return undefined;
  }
  return roundMetric(Math.min(requested, actual) / Math.max(requested, actual) * 100);
}

function resolutionTierRank(tier: ResolutionTier | undefined): number | null {
  if (tier === '1k') return 1;
  if (tier === '2k') return 2;
  if (tier === '4k') return 3;
  return null;
}

function greatestCommonDivisor(a: number, b: number): number {
  let left = Math.abs(Math.trunc(a));
  let right = Math.abs(Math.trunc(b));
  while (right !== 0) {
    const next = left % right;
    left = right;
    right = next;
  }
  return left || 1;
}

function buildAspectLabel(width?: number, height?: number): string | undefined {
  if (!width || !height || width <= 0 || height <= 0) {
    return undefined;
  }
  const gcd = greatestCommonDivisor(width, height);
  return `${Math.round(width / gcd)}:${Math.round(height / gcd)}`;
}

function parseRatioFromString(input: string | null | undefined): number | null {
  const value = String(input || '').trim();
  const match = value.match(/^(\d+(?:\.\d+)?)\s*[:/x]\s*(\d+(?:\.\d+)?)$/i);
  if (!match) {
    return null;
  }
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return null;
  }
  return width / height;
}

function normalizeRequestedSize(payload: Record<string, unknown> | null | undefined): string | undefined {
  const size = String(payload?.size || '').trim();
  if (size && size.toLowerCase() !== 'auto') {
    return size;
  }
  const resolution = String(payload?.resolution || '').trim();
  if (resolution && resolution.toLowerCase() !== 'auto') {
    return resolution;
  }
  if (size.toLowerCase() === 'auto' || resolution.toLowerCase() === 'auto') {
    return 'auto';
  }
  return undefined;
}

function normalizeRequestedAspectRatio(payload: Record<string, unknown> | null | undefined): number | undefined {
  const fromExplicit = parseRatioFromString(String(payload?.aspect_ratio || payload?.aspectRatio || ''));
  if (fromExplicit) {
    return fromExplicit;
  }
  const size = normalizeRequestedSize(payload);
  const parsed = parseImageSize(size);
  return parsed?.ratio;
}

function visitSsePayload(raw: string): unknown[] {
  const events: unknown[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) {
      continue;
    }
    const dataPart = trimmed.slice(5).trim();
    if (!dataPart || dataPart === '[DONE]') {
      continue;
    }
    try {
      events.push(JSON.parse(dataPart));
    } catch {
      events.push(dataPart);
    }
  }
  return events;
}

function normalizeCandidateBase64(value: unknown) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw || /^https?:\/\//i.test(raw)) {
    return '';
  }
  const dataUrlMatch = raw.match(/^data:image\/[^;]+;base64,(.+)$/is);
  const normalized = (dataUrlMatch?.[1] || raw).replace(/\s+/g, '');
  return /^[A-Za-z0-9+/=]+$/.test(normalized) && normalized.length > 64 ? normalized : '';
}

function addImageCandidate(
  bucket: ImageCandidate[],
  state: ImageCandidateCollectorState,
  candidate: ImageCandidate,
) {
  const keys: string[] = [];
  if (candidate.url) {
    keys.push(`url:${candidate.url}`);
  }
  if (candidate.b64) {
    keys.push(`b64:${createHash('sha256').update(candidate.b64).digest('hex')}`);
  }
  if (!keys.length || keys.some((key) => state.seenCandidateKeys.has(key))) {
    return;
  }
  for (const key of keys) {
    state.seenCandidateKeys.add(key);
  }
  bucket.push(candidate);
}

function collectImageCandidates(
  payload: unknown,
  bucket: ImageCandidate[],
  state: ImageCandidateCollectorState = {
    seenObjects: new WeakSet<object>(),
    seenCandidateKeys: new Set<string>(),
  },
) {
  if (!payload) {
    return;
  }

  if (typeof payload === 'string') {
    const trimmed = payload.trim();
    if (!trimmed) {
      return;
    }
    if (trimmed.includes('\ndata:') || trimmed.startsWith('data:')) {
      for (const event of visitSsePayload(trimmed)) {
        collectImageCandidates(event, bucket, state);
      }
      return;
    }
    if (/^https?:\/\//i.test(trimmed)) {
      addImageCandidate(bucket, state, { url: trimmed });
      return;
    }
    const b64 = normalizeCandidateBase64(trimmed);
    if (b64) {
      addImageCandidate(bucket, state, { b64 });
    }
    return;
  }

  if (typeof payload !== 'object') {
    return;
  }

  if (state.seenObjects.has(payload)) {
    return;
  }
  state.seenObjects.add(payload);

  if (Array.isArray(payload)) {
    for (const item of payload) {
      collectImageCandidates(item, bucket, state);
    }
    return;
  }

  const record = payload as Record<string, unknown>;
  const eventType = String(record.type || record.event || '').trim().toLowerCase();
  if (eventType.includes('partial_image')) {
    return;
  }

  const result = typeof record.result === 'string' ? record.result.trim() : '';
  const directUrl = [
    record.url,
    record.image_url,
    record.output_url,
    result,
  ].find((value) => typeof value === 'string' && /^https?:\/\//i.test(value.trim()));
  const directB64 = [
    record.b64_json,
    record.image_base64,
    record.partial_image_b64,
    result,
  ].map(normalizeCandidateBase64).find(Boolean);
  const width = Number(record.width);
  const height = Number(record.height);
  if (directUrl || directB64) {
    addImageCandidate(bucket, state, {
      url: typeof directUrl === 'string' ? directUrl.trim() : undefined,
      b64: directB64 || undefined,
      width: Number.isFinite(width) && width > 0 ? width : undefined,
      height: Number.isFinite(height) && height > 0 ? height : undefined,
    });
  }

  for (const value of Object.values(record)) {
    if (value && typeof value === 'object') {
      collectImageCandidates(value, bucket, state);
    }
  }
}

function parsePngDimensions(buffer: Buffer) {
  if (buffer.length < 24) {
    return null;
  }
  if (
    buffer[0] !== 0x89 || buffer[1] !== 0x50 || buffer[2] !== 0x4e || buffer[3] !== 0x47
    || buffer[4] !== 0x0d || buffer[5] !== 0x0a || buffer[6] !== 0x1a || buffer[7] !== 0x0a
  ) {
    return null;
  }
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  };
}

function parseJpegDimensions(buffer: Buffer) {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) {
    return null;
  }
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buffer[offset + 1];
    if (marker === 0xda || marker === 0xd9) {
      break;
    }
    const blockLength = buffer.readUInt16BE(offset + 2);
    if (JPEG_SOF_MARKERS.has(marker) && offset + 8 < buffer.length) {
      return {
        height: buffer.readUInt16BE(offset + 5),
        width: buffer.readUInt16BE(offset + 7),
      };
    }
    if (blockLength <= 0) {
      break;
    }
    offset += 2 + blockLength;
  }
  return null;
}

function parseWebpDimensions(buffer: Buffer) {
  if (buffer.length < 16 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WEBP') {
    return null;
  }
  const chunkType = buffer.toString('ascii', 12, 16);
  if (chunkType === 'VP8X' && buffer.length >= 30) {
    return {
      width: 1 + buffer.readUIntLE(24, 3),
      height: 1 + buffer.readUIntLE(27, 3),
    };
  }
  if (chunkType === 'VP8L' && buffer.length >= 25) {
    const bits = buffer.readUInt32LE(21);
    return {
      width: (bits & 0x3fff) + 1,
      height: ((bits >> 14) & 0x3fff) + 1,
    };
  }
  if (chunkType === 'VP8 ' && buffer.length >= 30) {
    const frameOffset = 20;
    if (buffer[frameOffset + 3] !== 0x9d || buffer[frameOffset + 4] !== 0x01 || buffer[frameOffset + 5] !== 0x2a) {
      return null;
    }
    return {
      width: buffer.readUInt16LE(frameOffset + 6) & 0x3fff,
      height: buffer.readUInt16LE(frameOffset + 8) & 0x3fff,
    };
  }
  return null;
}

function parseImageDimensions(buffer: Buffer) {
  return parsePngDimensions(buffer) || parseJpegDimensions(buffer) || parseWebpDimensions(buffer);
}

async function fetchImageDimensionsFromUrl(url: string) {
  const response = await fetch(url, {
    headers: {
      Range: 'bytes=0-524287',
      Accept: 'image/*,*/*;q=0.8',
    },
  });
  if (!response.ok) {
    return null;
  }
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (total < 524_288) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = Buffer.from(next.value);
      const remaining = 524_288 - total;
      chunks.push(chunk.subarray(0, remaining));
      total += Math.min(chunk.length, remaining);
      if (chunk.length > remaining) {
        await reader.cancel('image dimension prefix complete').catch(() => undefined);
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }
  const buffer = Buffer.concat(chunks, total);
  return parseImageDimensions(buffer);
}

function normalizeBase64ImagePayload(raw: string) {
  return raw.replace(/^data:[^;]+;base64,/i, '').replace(/\s+/g, '');
}

function decodeBase64Prefix(value: string, maxBytes: number) {
  const requiredChars = Math.ceil(maxBytes / 3) * 4;
  const boundedLength = Math.min(value.length, requiredChars);
  const alignedLength = boundedLength - (boundedLength % 4);
  if (alignedLength <= 0) {
    return Buffer.alloc(0);
  }
  return Buffer.from(value.slice(0, alignedLength), 'base64');
}

function parseImageDimensionsFromBase64(raw: string) {
  const value = normalizeBase64ImagePayload(raw);
  if (!value) {
    return null;
  }
  let fullyDecodedByPrefix = false;
  for (const maxBytes of BASE64_DIMENSION_PREFIX_BYTES) {
    const buffer = decodeBase64Prefix(value, maxBytes);
    if (!buffer.length) {
      continue;
    }
    fullyDecodedByPrefix = buffer.length >= Math.floor(value.length / 4) * 3 - 2;
    const parsed = parseImageDimensions(buffer);
    if (parsed) {
      return parsed;
    }
    if (fullyDecodedByPrefix) {
      return null;
    }
  }
  const buffer = Buffer.from(value, 'base64');
  return parseImageDimensions(buffer);
}

async function resolveActualImageSize(payload: unknown): Promise<{
  width?: number;
  height?: number;
  extractionSource: ImageResolutionAuditRecord['extractionSource'];
  imageUrl?: string;
}> {
  const candidates: ImageCandidate[] = [];
  collectImageCandidates(payload, candidates);
  for (const candidate of candidates) {
    if (candidate.width && candidate.height) {
      return {
        width: candidate.width,
        height: candidate.height,
        extractionSource: 'response_field',
        imageUrl: candidate.url,
      };
    }
    if (candidate.b64) {
      const parsed = parseImageDimensionsFromBase64(candidate.b64);
      if (parsed?.width && parsed?.height) {
        return {
          width: parsed.width,
          height: parsed.height,
          extractionSource: 'base64_decode',
          imageUrl: candidate.url,
        };
      }
    }
    if (candidate.url) {
      try {
        const parsed = await fetchImageDimensionsFromUrl(candidate.url);
        if (parsed?.width && parsed?.height) {
          return {
            width: parsed.width,
            height: parsed.height,
            extractionSource: 'url_fetch',
            imageUrl: candidate.url,
          };
        }
      } catch {
        continue;
      }
    }
  }
  return {
    extractionSource: 'unavailable',
  };
}

async function resolveImageCandidateSize(candidate: ImageCandidate): Promise<{
  width?: number;
  height?: number;
  extractionSource: ImageResolutionAuditRecord['extractionSource'];
  imageUrl?: string;
}> {
  if (candidate.width && candidate.height) {
    return {
      width: candidate.width,
      height: candidate.height,
      extractionSource: 'response_field',
      imageUrl: candidate.url,
    };
  }
  if (candidate.b64) {
    const parsed = parseImageDimensionsFromBase64(candidate.b64);
    if (parsed?.width && parsed?.height) {
      return {
        width: parsed.width,
        height: parsed.height,
        extractionSource: 'base64_decode',
        imageUrl: candidate.url,
      };
    }
  }
  if (candidate.url) {
    try {
      const parsed = await fetchImageDimensionsFromUrl(candidate.url);
      if (parsed?.width && parsed?.height) {
        return {
          width: parsed.width,
          height: parsed.height,
          extractionSource: 'url_fetch',
          imageUrl: candidate.url,
        };
      }
    } catch {
      return {
        extractionSource: 'unavailable',
        imageUrl: candidate.url,
      };
    }
  }
  return {
    extractionSource: 'unavailable',
    imageUrl: candidate.url,
  };
}

export async function buildImageResolutionAuditRecord(input: {
  requestPayload?: Record<string, unknown> | null;
  responsePayload?: unknown;
}): Promise<ImageResolutionAuditRecord | null> {
  const requestedSize = normalizeRequestedSize(input.requestPayload);
  const requestedParsed = parseImageSize(requestedSize);
  const requestedAspectRatio = normalizeRequestedAspectRatio(input.requestPayload);
  const actual = await resolveActualImageSize(input.responsePayload);

  const actualParsed = actual.width && actual.height
    ? parseImageSize(`${actual.width}x${actual.height}`)
    : null;

  if (!requestedParsed && !actualParsed) {
    return null;
  }

  const requestedMaxSide = requestedParsed ? Math.max(requestedParsed.width, requestedParsed.height) : null;
  const actualMaxSide = actualParsed ? Math.max(actualParsed.width, actualParsed.height) : null;
  const aspectDelta = requestedAspectRatio && actualParsed
    ? Math.abs(actualParsed.ratio - requestedAspectRatio) / requestedAspectRatio * 100
    : undefined;
  const requestedTier = classifyResolutionTier(requestedParsed) || undefined;
  const actualTier = classifyResolutionTier(actualParsed) || undefined;
  const requestedTierRank = resolutionTierRank(requestedTier);
  const actualTierRank = resolutionTierRank(actualTier);
  const tierDelta = requestedTierRank !== null && actualTierRank !== null
    ? actualTierRank - requestedTierRank
    : undefined;

  return {
    requestedSize: requestedParsed?.normalized || requestedSize,
    requestedTier,
    requestedWidth: requestedParsed?.width,
    requestedHeight: requestedParsed?.height,
    requestedAspectLabel: buildAspectLabel(requestedParsed?.width, requestedParsed?.height),
    requestedPixels: requestedParsed?.pixels,
    requestedAspectRatio: roundMetric(requestedAspectRatio, 6),
    actualSize: actualParsed?.normalized,
    actualTier,
    actualWidth: actualParsed?.width,
    actualHeight: actualParsed?.height,
    actualAspectLabel: buildAspectLabel(actualParsed?.width, actualParsed?.height),
    actualPixels: actualParsed?.pixels,
    actualAspectRatio: roundMetric(actualParsed?.ratio, 6),
    exactSizeMatch: Boolean(requestedParsed && actualParsed && requestedParsed.normalized === actualParsed.normalized),
    sameTierMatch: Boolean(requestedTier && requestedTier === actualTier),
    sameOrHigherTier: Boolean(requestedTierRank !== null && actualTierRank !== null && actualTierRank >= requestedTierRank),
    tierDelta,
    tierDowngradeLevels: typeof tierDelta === 'number' && tierDelta < 0 ? Math.abs(tierDelta) : 0,
    tierUpgradeLevels: typeof tierDelta === 'number' && tierDelta > 0 ? tierDelta : 0,
    aspectRatioDeltaPercent: roundMetric(aspectDelta),
    aspectAccuracyPercent: ratioAccuracyPercent(requestedAspectRatio, actualParsed?.ratio),
    maxSideDeltaPercent: requestedMaxSide && actualMaxSide
      ? roundMetric(Math.abs(actualMaxSide - requestedMaxSide) / requestedMaxSide * 100)
      : undefined,
    widthDeltaPercent: requestedParsed && actualParsed
      ? roundMetric(Math.abs(actualParsed.width - requestedParsed.width) / requestedParsed.width * 100)
      : undefined,
    heightDeltaPercent: requestedParsed && actualParsed
      ? roundMetric(Math.abs(actualParsed.height - requestedParsed.height) / requestedParsed.height * 100)
      : undefined,
    resolutionAccuracyPercent: resolutionAccuracyPercent(requestedParsed?.pixels, actualParsed?.pixels),
    extractionSource: actual.extractionSource,
    imageUrl: actual.imageUrl,
  };
}

export async function buildImageResolutionAuditRecords(input: {
  requestPayload?: Record<string, unknown> | null;
  responsePayload?: unknown;
  maxImageCount?: number;
}): Promise<ImageResolutionAuditBatch> {
  const requestedSize = normalizeRequestedSize(input.requestPayload);
  const requestedParsed = parseImageSize(requestedSize);
  const requestedAspectRatio = normalizeRequestedAspectRatio(input.requestPayload);
  const requestedTier = classifyResolutionTier(requestedParsed) || undefined;
  const requestedTierRank = resolutionTierRank(requestedTier);
  const requestedMaxSide = requestedParsed ? Math.max(requestedParsed.width, requestedParsed.height) : null;

  const candidates: ImageCandidate[] = [];
  collectImageCandidates(input.responsePayload, candidates);
  const maxImageCount = Number.isFinite(Number(input.maxImageCount)) && Number(input.maxImageCount) > 0
    ? Math.floor(Number(input.maxImageCount))
    : candidates.length;
  const selectedCandidates = candidates.slice(0, maxImageCount);

  if (!selectedCandidates.length) {
    const fallback = await buildImageResolutionAuditRecord(input);
    return {
      records: fallback ? [fallback] : [],
      measuredCount: fallback?.actualSize ? 1 : 0,
      requestedCount: requestedParsed ? 1 : 0,
    };
  }

  const records: ImageResolutionAuditRecord[] = [];
  for (const candidate of selectedCandidates) {
    const actual = await resolveImageCandidateSize(candidate);
    const actualParsed = actual.width && actual.height
      ? parseImageSize(`${actual.width}x${actual.height}`)
      : null;
    const actualMaxSide = actualParsed ? Math.max(actualParsed.width, actualParsed.height) : null;
    const aspectDelta = requestedAspectRatio && actualParsed
      ? Math.abs(actualParsed.ratio - requestedAspectRatio) / requestedAspectRatio * 100
      : undefined;
    const actualTier = classifyResolutionTier(actualParsed) || undefined;
    const actualTierRank = resolutionTierRank(actualTier);
    const tierDelta = requestedTierRank !== null && actualTierRank !== null
      ? actualTierRank - requestedTierRank
      : undefined;
    if (!requestedParsed && !actualParsed) {
      continue;
    }
    records.push({
      requestedSize: requestedParsed?.normalized || requestedSize,
      requestedTier,
      requestedWidth: requestedParsed?.width,
      requestedHeight: requestedParsed?.height,
      requestedAspectLabel: buildAspectLabel(requestedParsed?.width, requestedParsed?.height),
      requestedPixels: requestedParsed?.pixels,
      requestedAspectRatio: roundMetric(requestedAspectRatio, 6),
      actualSize: actualParsed?.normalized,
      actualTier,
      actualWidth: actualParsed?.width,
      actualHeight: actualParsed?.height,
      actualAspectLabel: buildAspectLabel(actualParsed?.width, actualParsed?.height),
      actualPixels: actualParsed?.pixels,
      actualAspectRatio: roundMetric(actualParsed?.ratio, 6),
      exactSizeMatch: Boolean(requestedParsed && actualParsed && requestedParsed.normalized === actualParsed.normalized),
      sameTierMatch: Boolean(requestedTier && requestedTier === actualTier),
      sameOrHigherTier: Boolean(requestedTierRank !== null && actualTierRank !== null && actualTierRank >= requestedTierRank),
      tierDelta,
      tierDowngradeLevels: typeof tierDelta === 'number' && tierDelta < 0 ? Math.abs(tierDelta) : 0,
      tierUpgradeLevels: typeof tierDelta === 'number' && tierDelta > 0 ? tierDelta : 0,
      aspectRatioDeltaPercent: roundMetric(aspectDelta),
      aspectAccuracyPercent: ratioAccuracyPercent(requestedAspectRatio, actualParsed?.ratio),
      maxSideDeltaPercent: requestedMaxSide && actualMaxSide
        ? roundMetric(Math.abs(actualMaxSide - requestedMaxSide) / requestedMaxSide * 100)
        : undefined,
      widthDeltaPercent: requestedParsed && actualParsed
        ? roundMetric(Math.abs(actualParsed.width - requestedParsed.width) / requestedParsed.width * 100)
        : undefined,
      heightDeltaPercent: requestedParsed && actualParsed
        ? roundMetric(Math.abs(actualParsed.height - requestedParsed.height) / requestedParsed.height * 100)
        : undefined,
      resolutionAccuracyPercent: resolutionAccuracyPercent(requestedParsed?.pixels, actualParsed?.pixels),
      extractionSource: actual.extractionSource,
      imageUrl: actual.imageUrl,
    });
  }

  return {
    records,
    measuredCount: records.filter((item) => item.actualSize).length,
    requestedCount: requestedParsed ? records.length || 1 : 0,
  };
}

export async function buildBillingAuditImageRecords(input: {
  requestPayload?: Record<string, unknown> | null;
  responsePayload?: unknown;
  maxImageCount?: number;
}): Promise<BillingAuditImageRecord[]> {
  const batch = await buildImageResolutionAuditRecords(input);
  return batch.records
    .filter((record) => Boolean(record.actualSize && record.actualTier))
    .map((record, index) => ({
    ...record,
    index,
    billedTier: record.actualTier,
    billedSize: record.actualSize,
  }));
}

function readResolutionAudit(task: TaskMasterRecord): ImageResolutionAuditRecord | null {
  const responsePayload = task.responsePayload as Record<string, unknown> | null | undefined;
  const requestPayload = task.requestPayload as Record<string, unknown> | null | undefined;
  const audit = (responsePayload?.resolutionAudit || requestPayload?.resolutionAudit) as ImageResolutionAuditRecord | undefined;
  return audit || null;
}

export function buildResolutionAuditReport(tasks: TaskMasterRecord[], catalog: AdminConsoleCatalog): ResolutionAuditReport {
  const upstreamNameById = new Map(catalog.upstreams.map((item) => [item.id, item.name]));
  const filtered = tasks.filter((task) => task.channelId === 'image_generation');
  const rowsByKey = new Map<string, {
    upstreamId: string;
    upstreamName: string;
    operation: 'generations' | 'edits';
    requestedSize: string;
    requestedAspectLabel: string;
    requestedTier: ResolutionTier | 'auto';
    sampleCount: number;
    measuredCount: number;
    exactSizeMatchCount: number;
    sameTierMatchCount: number;
    exactAspectRatioCount: number;
    aspectRatioDeltaTotal: number;
    aspectRatioDeltaSamples: number;
    maxSideDeltaTotal: number;
    maxSideDeltaSamples: number;
    aspectAccuracyTotal: number;
    aspectAccuracySamples: number;
    resolutionAccuracyTotal: number;
    resolutionAccuracySamples: number;
    sameOrHigherTierCount: number;
    downgradeCount: number;
    tierDowngradeTotal: number;
    tierDowngradeSamples: number;
    actualTierBreakdown: Record<string, number>;
    downgradeLevelBreakdown: Record<string, number>;
    latestSampleAt?: number;
  }>();
  const aspectRowsByKey = new Map<string, {
    upstreamId: string;
    upstreamName: string;
    operation: 'generations' | 'edits';
    requestedAspectLabel: string;
    requestedTier: ResolutionTier | 'auto';
    sampleCount: number;
    measuredCount: number;
    aspectAccuracyTotal: number;
    aspectAccuracySamples: number;
    resolutionAccuracyTotal: number;
    resolutionAccuracySamples: number;
    sameOrHigherTierCount: number;
    downgradeCount: number;
    tierDowngradeTotal: number;
    tierDowngradeSamples: number;
    actualTierBreakdown: Record<string, number>;
    latestSampleAt?: number;
  }>();

  function touchRow(input: {
    upstreamId: string;
    operation: 'generations' | 'edits';
    requestedSize: string;
    requestedAspectLabel: string;
    requestedTier: ResolutionTier | 'auto';
  }) {
    const key = [
      input.upstreamId,
      input.operation,
      input.requestedSize,
      input.requestedAspectLabel,
      input.requestedTier,
    ].join(':');
    if (!rowsByKey.has(key)) {
      rowsByKey.set(key, {
        upstreamId: input.upstreamId,
        upstreamName: upstreamNameById.get(input.upstreamId) || input.upstreamId,
        operation: input.operation,
        requestedSize: input.requestedSize,
        requestedAspectLabel: input.requestedAspectLabel,
        requestedTier: input.requestedTier,
        sampleCount: 0,
        measuredCount: 0,
        exactSizeMatchCount: 0,
        sameTierMatchCount: 0,
        exactAspectRatioCount: 0,
        aspectRatioDeltaTotal: 0,
        aspectRatioDeltaSamples: 0,
        maxSideDeltaTotal: 0,
        maxSideDeltaSamples: 0,
        aspectAccuracyTotal: 0,
        aspectAccuracySamples: 0,
        resolutionAccuracyTotal: 0,
        resolutionAccuracySamples: 0,
        sameOrHigherTierCount: 0,
        downgradeCount: 0,
        tierDowngradeTotal: 0,
        tierDowngradeSamples: 0,
        actualTierBreakdown: {},
        downgradeLevelBreakdown: {},
        latestSampleAt: undefined,
      });
    }
    return rowsByKey.get(key)!;
  }

  function touchAspectRow(input: {
    upstreamId: string;
    operation: 'generations' | 'edits';
    requestedAspectLabel: string;
    requestedTier: ResolutionTier | 'auto';
  }) {
    const key = [
      input.upstreamId,
      input.operation,
      input.requestedAspectLabel,
      input.requestedTier,
    ].join(':');
    if (!aspectRowsByKey.has(key)) {
      aspectRowsByKey.set(key, {
        upstreamId: input.upstreamId,
        upstreamName: upstreamNameById.get(input.upstreamId) || input.upstreamId,
        operation: input.operation,
        requestedAspectLabel: input.requestedAspectLabel,
        requestedTier: input.requestedTier,
        sampleCount: 0,
        measuredCount: 0,
        aspectAccuracyTotal: 0,
        aspectAccuracySamples: 0,
        resolutionAccuracyTotal: 0,
        resolutionAccuracySamples: 0,
        sameOrHigherTierCount: 0,
        downgradeCount: 0,
        tierDowngradeTotal: 0,
        tierDowngradeSamples: 0,
        actualTierBreakdown: {},
        latestSampleAt: undefined,
      });
    }
    return aspectRowsByKey.get(key)!;
  }

  for (const task of filtered) {
    const upstreamId = String(task.upstreamId || task.providerId || '').trim();
    if (!upstreamId) {
      continue;
    }
    const audit = readResolutionAudit(task);
    if (!audit) {
      continue;
    }
    const requestedSize = String(audit.requestedSize || '').trim() || 'auto';
    const requestedAspectLabel = String(audit.requestedAspectLabel || buildAspectLabel(audit.requestedWidth, audit.requestedHeight) || 'unknown');
    const requestedTier = audit.requestedTier || 'auto';
    const row = touchRow({
      upstreamId,
      operation: task.operation,
      requestedSize,
      requestedAspectLabel,
      requestedTier,
    });
    const aspectRow = touchAspectRow({
      upstreamId,
      operation: task.operation,
      requestedAspectLabel,
      requestedTier,
    });
    row.sampleCount += 1;
    aspectRow.sampleCount += 1;
    if (typeof task.completedAt === 'number') {
      row.latestSampleAt = Math.max(row.latestSampleAt || 0, task.completedAt);
      aspectRow.latestSampleAt = Math.max(aspectRow.latestSampleAt || 0, task.completedAt);
    } else {
      row.latestSampleAt = Math.max(row.latestSampleAt || 0, task.updatedAt);
      aspectRow.latestSampleAt = Math.max(aspectRow.latestSampleAt || 0, task.updatedAt);
    }
    if (audit.actualSize) {
      row.measuredCount += 1;
      aspectRow.measuredCount += 1;
    }
    if (audit.exactSizeMatch) {
      row.exactSizeMatchCount += 1;
    }
    if (audit.sameTierMatch) {
      row.sameTierMatchCount += 1;
    }
    if (audit.sameOrHigherTier) {
      row.sameOrHigherTierCount += 1;
      aspectRow.sameOrHigherTierCount += 1;
    }
    if ((audit.tierDowngradeLevels || 0) > 0) {
      row.downgradeCount += 1;
      row.tierDowngradeTotal += Number(audit.tierDowngradeLevels || 0);
      row.tierDowngradeSamples += 1;
      aspectRow.downgradeCount += 1;
      aspectRow.tierDowngradeTotal += Number(audit.tierDowngradeLevels || 0);
      aspectRow.tierDowngradeSamples += 1;
    }
    if ((audit.aspectRatioDeltaPercent ?? Number.NaN) <= 1) {
      row.exactAspectRatioCount += 1;
    }
    if (typeof audit.aspectRatioDeltaPercent === 'number') {
      row.aspectRatioDeltaTotal += audit.aspectRatioDeltaPercent;
      row.aspectRatioDeltaSamples += 1;
    }
    if (typeof audit.maxSideDeltaPercent === 'number') {
      row.maxSideDeltaTotal += audit.maxSideDeltaPercent;
      row.maxSideDeltaSamples += 1;
    }
    if (typeof audit.aspectAccuracyPercent === 'number') {
      row.aspectAccuracyTotal += audit.aspectAccuracyPercent;
      row.aspectAccuracySamples += 1;
      aspectRow.aspectAccuracyTotal += audit.aspectAccuracyPercent;
      aspectRow.aspectAccuracySamples += 1;
    }
    if (typeof audit.resolutionAccuracyPercent === 'number') {
      row.resolutionAccuracyTotal += audit.resolutionAccuracyPercent;
      row.resolutionAccuracySamples += 1;
      aspectRow.resolutionAccuracyTotal += audit.resolutionAccuracyPercent;
      aspectRow.resolutionAccuracySamples += 1;
    }
    if (audit.actualTier) {
      row.actualTierBreakdown[audit.actualTier] = (row.actualTierBreakdown[audit.actualTier] || 0) + 1;
      aspectRow.actualTierBreakdown[audit.actualTier] = (aspectRow.actualTierBreakdown[audit.actualTier] || 0) + 1;
    } else {
      row.actualTierBreakdown.unresolved = (row.actualTierBreakdown.unresolved || 0) + 1;
      aspectRow.actualTierBreakdown.unresolved = (aspectRow.actualTierBreakdown.unresolved || 0) + 1;
    }
    const downgradeKey = String(audit.tierDowngradeLevels || 0);
    row.downgradeLevelBreakdown[downgradeKey] = (row.downgradeLevelBreakdown[downgradeKey] || 0) + 1;
  }

  const rows: ResolutionAuditSummaryRow[] = Array.from(rowsByKey.values())
    .sort((left, right) => {
      if (left.upstreamName !== right.upstreamName) {
        return left.upstreamName.localeCompare(right.upstreamName);
      }
      if (left.operation !== right.operation) {
        return left.operation.localeCompare(right.operation);
      }
      if (left.requestedTier !== right.requestedTier) {
        return left.requestedTier.localeCompare(right.requestedTier);
      }
      if (left.requestedAspectLabel !== right.requestedAspectLabel) {
        return left.requestedAspectLabel.localeCompare(right.requestedAspectLabel);
      }
      return left.requestedSize.localeCompare(right.requestedSize);
    })
    .map((row) => ({
      key: `${row.upstreamId}:${row.operation}:${row.requestedSize}:${row.requestedAspectLabel}`,
      upstreamId: row.upstreamId,
      upstreamName: row.upstreamName,
      operation: row.operation,
      requestedSize: row.requestedSize,
      requestedAspectLabel: row.requestedAspectLabel,
      requestedTier: row.requestedTier,
      sampleCount: row.sampleCount,
      measuredCount: row.measuredCount,
      avgAspectAccuracyPercent: row.aspectAccuracySamples
        ? roundMetric(row.aspectAccuracyTotal / row.aspectAccuracySamples) || 0
        : 0,
      avgResolutionAccuracyPercent: row.resolutionAccuracySamples
        ? roundMetric(row.resolutionAccuracyTotal / row.resolutionAccuracySamples) || 0
        : 0,
      sameOrHigherTierRate: row.sampleCount ? roundMetric(row.sameOrHigherTierCount / row.sampleCount * 100) || 0 : 0,
      downgradeRate: row.sampleCount ? roundMetric(row.downgradeCount / row.sampleCount * 100) || 0 : 0,
      avgTierDowngradeLevels: row.tierDowngradeSamples
        ? roundMetric(row.tierDowngradeTotal / row.tierDowngradeSamples) || 0
        : 0,
      exactSizeMatchRate: row.sampleCount ? roundMetric(row.exactSizeMatchCount / row.sampleCount * 100) || 0 : 0,
      sameTierMatchRate: row.sampleCount ? roundMetric(row.sameTierMatchCount / row.sampleCount * 100) || 0 : 0,
      exactAspectRatioRate: row.sampleCount ? roundMetric(row.exactAspectRatioCount / row.sampleCount * 100) || 0 : 0,
      avgAspectRatioDeltaPercent: row.aspectRatioDeltaSamples
        ? roundMetric(row.aspectRatioDeltaTotal / row.aspectRatioDeltaSamples) || 0
        : 0,
      avgMaxSideDeltaPercent: row.maxSideDeltaSamples
        ? roundMetric(row.maxSideDeltaTotal / row.maxSideDeltaSamples) || 0
        : 0,
      actualTierBreakdown: row.actualTierBreakdown,
      downgradeLevelBreakdown: row.downgradeLevelBreakdown,
      latestSampleAt: row.latestSampleAt,
    }));
  const aspectRows: AspectResolutionAuditSummaryRow[] = Array.from(aspectRowsByKey.values())
    .sort((left, right) => {
      if (left.upstreamName !== right.upstreamName) {
        return left.upstreamName.localeCompare(right.upstreamName);
      }
      if (left.operation !== right.operation) {
        return left.operation.localeCompare(right.operation);
      }
      if (left.requestedTier !== right.requestedTier) {
        return left.requestedTier.localeCompare(right.requestedTier);
      }
      return left.requestedAspectLabel.localeCompare(right.requestedAspectLabel);
    })
    .map((row) => ({
      key: `${row.upstreamId}:${row.operation}:${row.requestedAspectLabel}:${row.requestedTier}`,
      upstreamId: row.upstreamId,
      upstreamName: row.upstreamName,
      operation: row.operation,
      requestedAspectLabel: row.requestedAspectLabel,
      requestedTier: row.requestedTier,
      sampleCount: row.sampleCount,
      measuredCount: row.measuredCount,
      avgAspectAccuracyPercent: row.aspectAccuracySamples
        ? roundMetric(row.aspectAccuracyTotal / row.aspectAccuracySamples) || 0
        : 0,
      avgResolutionAccuracyPercent: row.resolutionAccuracySamples
        ? roundMetric(row.resolutionAccuracyTotal / row.resolutionAccuracySamples) || 0
        : 0,
      sameOrHigherTierRate: row.sampleCount ? roundMetric(row.sameOrHigherTierCount / row.sampleCount * 100) || 0 : 0,
      downgradeRate: row.sampleCount ? roundMetric(row.downgradeCount / row.sampleCount * 100) || 0 : 0,
      avgTierDowngradeLevels: row.tierDowngradeSamples
        ? roundMetric(row.tierDowngradeTotal / row.tierDowngradeSamples) || 0
        : 0,
      actualTierBreakdown: row.actualTierBreakdown,
      latestSampleAt: row.latestSampleAt,
    }));

  return {
    generatedAt: Date.now(),
    sampleWindowSize: filtered.length,
    totals: {
      sampleCount: rows.reduce((sum, row) => sum + row.sampleCount, 0),
      measuredCount: rows.reduce((sum, row) => sum + row.measuredCount, 0),
      upstreamCount: new Set(rows.map((row) => row.upstreamId)).size,
      exactRequestGroupCount: rows.length,
      aspectGroupCount: aspectRows.length,
    },
    rows,
    aspectRows,
  };
}
