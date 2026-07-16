import { createClient, type RedisClientType } from 'redis';
import type {
  CanvasWorkflowRunState,
  WorkflowNodeState,
  WorkflowRunJobState,
} from './modules/storage/repositoryContracts.js';
import { asyncHotStateStore, hotStateStore, sharedHotStateStrict } from './modules/storage/runtimeStores.js';
import { requireDatabaseUrl } from './modules/storage/storageMode.js';
import { requireSharedHotState } from './modules/storage/sharedStateMode.js';
import {
  createWorkflowRunSchema,
  type CanvasEdge,
  type CanvasGeneratedItem,
  type CanvasNode,
  type CanvasWorkflowPayload,
} from './canvasWorkflowSchema.js';
import {
  buildCanvasEcommerceEffectiveConfig,
  buildCanvasEcommerceFallbackStrategyResult,
  buildCanvasEcommerceOverviewPrompt,
  buildCanvasEcommerceSetPrompt,
  buildCanvasEcommerceStrategyPrompt,
  buildCanvasEffectiveEcommerceNode,
  buildCanvasImageExplosionPrompt,
  cleanCanvasEcommerceVisiblePromptText,
  getCanvasEcommerceSetCount,
  normalizeCanvasEcommerceStrategyResult,
  normalizeCanvasPromptItems,
} from './canvasBusinessLogic.js';

requireDatabaseUrl('canvas_worker');
requireSharedHotState('canvas_worker');

const workflowRunTtlSeconds = 60 * 60 * 24;
const canvasWorkflowQueuePollMs = Math.max(250, Math.floor(Number(process.env.CANVAS_WORKFLOW_QUEUE_POLL_MS || 1000)));
const canvasWorkflowClaimTtlSeconds = Math.max(300, Math.floor(Number(process.env.CANVAS_WORKFLOW_CLAIM_TTL_SECONDS || 3600)));
const imageRequestTimeoutMs = Math.max(60_000, Math.floor(Number(process.env.CANVAS_WORKER_IMAGE_TIMEOUT_MS || 10 * 60 * 1000)));
const chatRequestTimeoutMs = Math.max(30_000, Math.floor(Number(process.env.CANVAS_WORKER_CHAT_TIMEOUT_MS || 120_000)));
const canvasMaxReferenceImageBytes = Math.max(1 * 1024 * 1024, Number(process.env.IMAGE_PAYLOAD_MAX_BYTES || 12 * 1024 * 1024));
const canvasMaxReferenceImageCount = Math.max(1, Number(process.env.IMAGE_INPUT_MAX_COUNT || 6));
const localApiBaseUrl = String(process.env.CANVAS_WORKER_API_BASE_URL || `http://127.0.0.1:${Number(process.env.PORT || 4010)}`)
  .trim()
  .replace(/\/+$/, '');
const redisClaimPrefix = 'yali:workflow_run_claim:';
const canvasRunnableTypes = new Set(['generate', 'imageExplosion', 'ecommerceImage', 'output']);

let pumpRunning = false;
let claimClient: RedisClientType | null = process.env.REDIS_URL
  ? createClient({ url: process.env.REDIS_URL })
  : null;

function requestLogWarn(event: string, error: unknown) {
  console.warn(`[canvas-worker] ${event}`, error instanceof Error ? error.message : String(error || ''));
}

function estimateEmbeddedCanvasImageBytes(value: string) {
  const match = String(value || '').trim().match(/^data:image\/[a-zA-Z0-9.+-]+;base64,([A-Za-z0-9+/=\s]+)$/i);
  if (!match) {
    return 0;
  }
  const compact = String(match[1] || '').replace(/\s+/g, '');
  if (!compact) {
    return 0;
  }
  const padding = compact.endsWith('==') ? 2 : compact.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((compact.length * 3) / 4) - padding);
}

function assertCanvasReferenceLimits(references: string[], label: string) {
  const normalized = Array.isArray(references)
    ? references.map((item) => String(item || '').trim()).filter(Boolean)
    : [];
  if (normalized.length > canvasMaxReferenceImageCount) {
    throw new Error(`${label} 单次最多只支持 ${canvasMaxReferenceImageCount} 张参考图。`);
  }
  normalized.forEach((reference, index) => {
    const embeddedBytes = estimateEmbeddedCanvasImageBytes(reference);
    if (embeddedBytes > canvasMaxReferenceImageBytes) {
      throw new Error(`${label} 的第 ${index + 1} 张参考图超过 12MB，请压缩后重试。`);
    }
  });
}

function createSharedHotStateUnavailableError(operation: string) {
  const error = new Error(`Shared state backend is unavailable during ${operation}.`);
  (error as Error & { statusCode?: number; code?: string; details?: Record<string, unknown> }).statusCode = 503;
  (error as Error & { statusCode?: number; code?: string; details?: Record<string, unknown> }).code = 'shared_state_unavailable';
  (error as Error & { statusCode?: number; code?: string; details?: Record<string, unknown> }).details = { operation };
  return error;
}

async function ensureClaimClient() {
  if (!claimClient) {
    if (sharedHotStateStrict) {
      throw createSharedHotStateUnavailableError('workflow_claim_client');
    }
    return null;
  }
  if (!claimClient.isOpen) {
    await claimClient.connect();
  }
  return claimClient;
}

async function claimWorkflowRun(runId: string) {
  const client = await ensureClaimClient();
  if (!client) {
    return true;
  }
  const result = await (client as RedisClientType & {
    sendCommand(args: string[]): Promise<unknown>;
  }).sendCommand([
    'SET',
    `${redisClaimPrefix}${runId}`,
    `${process.pid}`,
    'EX',
    String(canvasWorkflowClaimTtlSeconds),
    'NX',
  ]);
  return result === 'OK';
}

async function releaseWorkflowRunClaim(runId: string) {
  const client = await ensureClaimClient();
  if (!client) {
    return;
  }
  await client.del(`${redisClaimPrefix}${runId}`);
}

async function getCanvasWorkflowRunState(runId: string) {
  if (asyncHotStateStore) {
    try {
      const remote = await asyncHotStateStore.getWorkflowRun(runId);
      if (remote) {
        hotStateStore.setWorkflowRun(runId, remote, workflowRunTtlSeconds);
        return remote;
      }
    } catch (error) {
      if (sharedHotStateStrict) {
        throw createSharedHotStateUnavailableError('workflow_run_read');
      }
      requestLogWarn('workflow_run_read_failed', error);
    }
  }
  return hotStateStore.getWorkflowRun(runId);
}

async function persistCanvasWorkflowRun(run: CanvasWorkflowRunState) {
  hotStateStore.setWorkflowRun(run.run_id, run, workflowRunTtlSeconds);
  if (!asyncHotStateStore) {
    return;
  }
  try {
    await asyncHotStateStore.setWorkflowRun(run.run_id, run, workflowRunTtlSeconds);
  } catch (error) {
    if (sharedHotStateStrict) {
      throw createSharedHotStateUnavailableError('workflow_run_write');
    }
    requestLogWarn('workflow_run_write_failed', error);
  }
}

async function listSharedCanvasWorkflowRuns() {
  if (!asyncHotStateStore) {
    return hotStateStore.listWorkflowRuns();
  }
  try {
    const runs = await asyncHotStateStore.listWorkflowRuns();
    for (const run of runs) {
      hotStateStore.setWorkflowRun(run.run_id, run, workflowRunTtlSeconds);
    }
    return runs;
  } catch (error) {
    if (sharedHotStateStrict) {
      throw createSharedHotStateUnavailableError('workflow_run_list');
    }
    requestLogWarn('workflow_run_list_failed', error);
    return hotStateStore.listWorkflowRuns();
  }
}

async function updateCanvasRun(runId: string, mutate: (run: CanvasWorkflowRunState) => void) {
  const run = await getCanvasWorkflowRunState(runId);
  if (!run) {
    return null;
  }
  mutate(run);
  run.updated_at = Date.now();
  await persistCanvasWorkflowRun(run);
  return run;
}

async function getCanvasRunOrThrow(runId: string) {
  const run = await getCanvasWorkflowRunState(runId);
  if (!run) {
    throw new Error(`Canvas run ${runId} was not found.`);
  }
  return run;
}

async function setCanvasNodeState(runId: string, nodeId: string, patch: Partial<WorkflowNodeState>) {
  await updateCanvasRun(runId, (run) => {
    const state = run.node_states.find((item) => item.node_id === nodeId);
    if (state) {
      Object.assign(state, patch);
    } else {
      run.node_states.push({ node_id: nodeId, status: 'queued', ...patch });
    }
  });
}

async function setCanvasJobState(runId: string, nodeId: string, patch: Partial<WorkflowRunJobState>) {
  await updateCanvasRun(runId, (run) => {
    const job = run.jobs.find((item) => item.node_id === nodeId);
    if (job) {
      Object.assign(job, patch);
    }
  });
}

async function appendCanvasRunHistory(runId: string, message: string, detail: Record<string, unknown> = {}) {
  await updateCanvasRun(runId, (run) => {
    run.history = (run.history || []).concat({
      at: Date.now(),
      message,
      ...detail,
    }).slice(-80);
  });
}

function normalizeCanvasNodes(value: unknown): CanvasNode[] {
  return (Array.isArray(value) ? value : [])
    .map((node) => ({
      ...(node && typeof node === 'object' && !Array.isArray(node) ? node as Record<string, unknown> : {}),
      id: String((node as any)?.id || '').trim(),
      type: String((node as any)?.type || '').trim(),
      data: (node as any)?.data && typeof (node as any).data === 'object' ? (node as any).data : {},
    }))
    .filter((node) => node.id && node.type);
}

function normalizeCanvasEdges(value: unknown): CanvasEdge[] {
  return (Array.isArray(value) ? value : [])
    .map((edge) => ({
      id: String((edge as any)?.id || '').trim(),
      source: String((edge as any)?.source || '').trim(),
      target: String((edge as any)?.target || '').trim(),
    }))
    .filter((edge) => edge.source && edge.target);
}

function getCanvasNodeLabel(node: CanvasNode) {
  return String(node.data?.label || node.id || node.type || 'node').trim();
}

function compareCanvasNodes(a: CanvasNode | undefined, b: CanvasNode | undefined) {
  const ax = Number(a?.position?.x || 0);
  const bx = Number(b?.position?.x || 0);
  if (ax !== bx) {
    return ax - bx;
  }
  const ay = Number(a?.position?.y || 0);
  const by = Number(b?.position?.y || 0);
  if (ay !== by) {
    return ay - by;
  }
  return String(a?.id || '').localeCompare(String(b?.id || ''));
}

function buildCanvasExecutionPlan(nodes: CanvasNode[], edges: CanvasEdge[]) {
  const runnableNodes = nodes.filter((node) => canvasRunnableTypes.has(node.type));
  const runnableIds = new Set(runnableNodes.map((node) => node.id));
  const nodeById = new Map(runnableNodes.map((node) => [node.id, node]));
  const incomingByTarget = new Map<string, Set<string>>();
  const outgoingBySource = new Map<string, Set<string>>();
  runnableNodes.forEach((node) => {
    incomingByTarget.set(node.id, new Set());
    outgoingBySource.set(node.id, new Set());
  });
  edges.forEach((edge) => {
    if (!runnableIds.has(edge.source) || !runnableIds.has(edge.target)) {
      return;
    }
    incomingByTarget.get(edge.target)?.add(edge.source);
    outgoingBySource.get(edge.source)?.add(edge.target);
  });
  const ready = runnableNodes
    .filter((node) => !incomingByTarget.get(node.id)?.size)
    .sort(compareCanvasNodes);
  const plan: CanvasNode[] = [];
  while (ready.length) {
    const node = ready.shift()!;
    plan.push(node);
    Array.from(outgoingBySource.get(node.id) || [])
      .sort((left, right) => compareCanvasNodes(nodeById.get(left), nodeById.get(right)))
      .forEach((targetId) => {
        const incoming = incomingByTarget.get(targetId);
        incoming?.delete(node.id);
        if (incoming && incoming.size === 0) {
          const target = nodeById.get(targetId);
          if (target) {
            ready.push(target);
            ready.sort(compareCanvasNodes);
          }
        }
      });
  }
  if (plan.length !== runnableNodes.length) {
    throw new Error('Canvas workflow contains a cycle between runnable nodes.');
  }
  return plan;
}

function getCanvasIncomingNodes(nodeId: string, nodes: CanvasNode[], edges: CanvasEdge[]) {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  return edges
    .filter((edge) => edge.target === nodeId)
    .map((edge) => nodeById.get(edge.source))
    .filter(Boolean) as CanvasNode[];
}

function resolveCanvasNodeSize(data: Record<string, any> = {}) {
  if (data.useCustomSize) {
    const width = Math.max(16, Math.min(4096, Number(data.customWidth || 1280)));
    const height = Math.max(16, Math.min(4096, Number(data.customHeight || 720)));
    return `${width}x${height}`;
  }
  return String(data.size || 'auto').trim() || 'auto';
}

function resolveCanvasNodeOutputFormat(data: Record<string, any> = {}) {
  const value = String(data.outputFormat || 'png').trim().toLowerCase();
  return ['png', 'jpeg', 'jpg', 'webp'].includes(value) ? (value === 'jpg' ? 'jpeg' : value) : 'png';
}

function buildCanvasImagePayload(
  workflowPayload: CanvasWorkflowPayload,
  node: CanvasNode,
  prompt: string,
  references: string[],
) {
  const data = node.data || {};
  const outputFormat = resolveCanvasNodeOutputFormat(data);
  const referenceImages = references
    .map((item) => String(item || '').trim())
    .filter(Boolean)
    .map((imageUrl) => ({ image_url: imageUrl }));
  return {
    model: String(data.model || 'gpt-image-2').trim() || 'gpt-image-2',
    prompt,
    action: referenceImages.length ? 'edit' : 'generate',
    size: resolveCanvasNodeSize(data),
    quality: String(data.quality || 'low').trim() || 'low',
    response_format: 'url' as const,
    n: 1,
    ...(referenceImages.length ? { reference_images: referenceImages } : {}),
    ...(referenceImages.length
      ? {
          metadata: {
            yali_requested_edit_protocol: 'multipart_file_upload',
          },
        }
      : {}),
    extra_body: {
      output_format: outputFormat,
      output_quality: Math.max(1, Math.min(100, Number(data.outputQuality || 100))),
    },
    provider_source: workflowPayload.provider_source === 'user_supplied' ? 'user_supplied' as const : 'admin_managed' as const,
    ...(workflowPayload.provider_source === 'user_supplied' && workflowPayload.user_api_base_url
      ? {
          user_image_api_kind: workflowPayload.user_image_api_kind || 'images_endpoint',
          user_api_base_url: workflowPayload.user_api_base_url,
          ...(workflowPayload.user_images_generations_url ? { user_images_generations_url: workflowPayload.user_images_generations_url } : {}),
          ...(workflowPayload.user_images_edits_url ? { user_images_edits_url: workflowPayload.user_images_edits_url } : {}),
          user_api_key: workflowPayload.user_api_key || '',
          preferred_auth_mode: workflowPayload.preferred_auth_mode || 'bearer',
        }
      : {}),
    routing_mode: workflowPayload.routing_mode,
  };
}


function getCanvasDirectImageUrl(node: CanvasNode) {
  const data = node.data || {};
  return String(data.annotatedImageUrl || data.referenceUrl || data.outputUrl || data.imageUrl || '').trim();
}

function getCanvasNodeResultImages(node: CanvasNode, resultsByNode: Map<string, CanvasGeneratedItem[]>) {
  const runtimeItems = resultsByNode.get(node.id) || [];
  const storedItems = Array.isArray(node.data?.resultItems) ? node.data?.resultItems : [];
  const urls = [...runtimeItems, ...storedItems]
    .map((item: any) => String(item?.download_url || item?.downloadUrl || item?.reference_url || item?.referenceUrl || item?.image_url || item?.imageUrl || '').trim())
    .filter(Boolean);
  const direct = getCanvasDirectImageUrl(node);
  if (direct) {
    urls.push(direct);
  }
  return Array.from(new Set(urls));
}

function buildCartesianImageSets(groups: string[][]) {
  return groups.reduce<string[][]>((acc, group) => {
    if (!group.length) {
      return acc;
    }
    const next: string[][] = [];
    acc.forEach((base) => {
      group.forEach((item) => next.push([...base, item]));
    });
    return next;
  }, [[]]);
}

function collectCanvasReferenceSets(node: CanvasNode, nodes: CanvasNode[], edges: CanvasEdge[], resultsByNode: Map<string, CanvasGeneratedItem[]>) {
  const incoming = getCanvasIncomingNodes(node.id, nodes, edges);
  const base: string[] = [];
  const groups: string[][] = [];
  incoming.forEach((source) => {
    if (source.type === 'prompt' || source.type === 'batchPrompt') {
      return;
    }
    const images = getCanvasNodeResultImages(source, resultsByNode);
    if (!images.length) {
      return;
    }
    if (['generate', 'imageExplosion', 'ecommerceImage'].includes(source.type) && images.length > 1 && node.type === 'generate') {
      groups.push(images);
      return;
    }
    base.push(...images);
  });
  const combinations = buildCartesianImageSets(groups);
  return combinations.length
    ? combinations.map((combo) => Array.from(new Set([...base, ...combo])))
    : [Array.from(new Set(base))];
}

function collectCanvasAllReferences(node: CanvasNode, nodes: CanvasNode[], edges: CanvasEdge[], resultsByNode: Map<string, CanvasGeneratedItem[]>) {
  return Array.from(new Set(collectCanvasReferenceSets(node, nodes, edges, resultsByNode).flat()));
}

function collectCanvasPromptItems(node: CanvasNode, nodes: CanvasNode[], edges: CanvasEdge[]) {
  const incoming = getCanvasIncomingNodes(node.id, nodes, edges);
  const batch = incoming.find((source) => source.type === 'batchPrompt' && Array.isArray(source.data?.items));
  if (batch) {
    const items = (batch.data?.items || [])
      .filter((item: any) => item && !item.skip && String(item.prompt || '').trim())
      .slice(0, 50)
      .map((item: any, index: number) => ({
        prompt: String(item.prompt || '').trim(),
        batch_item: {
          index: Number(item.index || index + 1),
          name: String(item.name || `batch-${index + 1}`).trim(),
          prompt: String(item.prompt || '').trim(),
        },
      }));
    if (items.length) {
      return items;
    }
  }
  const promptText = incoming
    .filter((source) => source.type === 'prompt')
    .map((source) => String(source.data?.prompt || '').trim())
    .filter(Boolean)
    .join('\n\n');
  const fallback = promptText || String(node.data?.prompt || '').trim();
  return fallback ? [{ prompt: fallback, batch_item: null }] : [];
}

function tryParseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function extractChatCompletionText(payload: unknown) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return '';
  }
  const record = payload as Record<string, any>;
  const first = Array.isArray(record.choices) ? record.choices[0] : null;
  const content = first?.message?.content ?? first?.delta?.content ?? record.content ?? record.text;
  if (typeof content === 'string') {
    return content.trim();
  }
  if (Array.isArray(content)) {
    return content
      .map((item) => typeof item === 'string' ? item : String(item?.text || item?.content || ''))
      .join('')
      .trim();
  }
  return '';
}

async function fetchJsonWithTimeout(url: string, init: RequestInit, timeoutMs: number) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
    });
    const text = await response.text();
    const json = tryParseJson(text);
    return { response, text, json };
  } finally {
    clearTimeout(timer);
  }
}

function extractLocalErrorMessage(payload: unknown, fallback: string) {
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const record = payload as Record<string, unknown>;
    const errorRecord = record.error && typeof record.error === 'object' && !Array.isArray(record.error)
      ? record.error as Record<string, unknown>
      : null;
    const message = record.public_message
      || record.publicMessage
      || record.message
      || errorRecord?.message
      || record.error_description;
    if (typeof message === 'string' && message.trim()) {
      return message.trim();
    }
    if (record.error && typeof record.error === 'string' && record.error.trim()) {
      return record.error.trim();
    }
  }
  return fallback;
}

function createSyntheticRequestHeaders() {
  return {
    'content-type': 'application/json',
    host: new URL(localApiBaseUrl).host,
    'x-yali-internal-worker': '1',
  };
}

function createCanvasInternalRequestHeaders(workflowPayload: CanvasWorkflowPayload) {
  const headers: Record<string, string> = {
    ...createSyntheticRequestHeaders(),
  };
  const tenantId = String(workflowPayload.internal_tenant_id || '').trim();
  const apiKeyId = String(workflowPayload.internal_api_key_id || '').trim();
  if (tenantId) {
    headers['x-yali-internal-tenant-id'] = tenantId;
  }
  if (apiKeyId) {
    headers['x-yali-internal-api-key-id'] = apiKeyId;
  }
  return headers;
}

async function executeCanvasImageGeneration(input: {
  workflowPayload: CanvasWorkflowPayload;
  node: CanvasNode;
  prompt: string;
  references: string[];
}) {
  assertCanvasReferenceLimits(input.references, `节点「${getCanvasNodeLabel(input.node)}」`);
  const payload = buildCanvasImagePayload(input.workflowPayload, input.node, input.prompt, input.references);
  const operation = input.references.length ? 'edits' : 'generations';
  const { response, json } = await fetchJsonWithTimeout(
    `${localApiBaseUrl}/v1/images/${operation}`,
    {
      method: 'POST',
      headers: createCanvasInternalRequestHeaders(input.workflowPayload),
      body: JSON.stringify(payload),
    },
    imageRequestTimeoutMs,
  );
  if (!response.ok) {
    throw new Error(extractLocalErrorMessage(json, `Canvas image ${operation} failed.`));
  }
  const taskId = String((json as Record<string, unknown> | null)?.task_id || `${operation}_${Date.now().toString(36)}`);
  const imageUrl = String((json as any)?.data?.[0]?.url || '').trim();
  if (!imageUrl) {
    throw new Error('Image provider returned no usable image URL.');
  }
  return {
    taskId,
    imageUrl,
    raw: json,
  };
}

async function executeCanvasChatCompletion(input: {
  workflowPayload: CanvasWorkflowPayload;
  instruction: string;
  images: string[];
}) {
  assertCanvasReferenceLimits(input.images, '画布参考图分析');
  const content = [
    { type: 'text', text: input.instruction },
    ...input.images
      .map((url) => String(url || '').trim())
      .filter(Boolean)
      .map((url) => ({ type: 'image_url', image_url: { url } })),
  ];
  const body: Record<string, unknown> = {
    messages: [{ role: 'user', content }],
    provider_source: input.workflowPayload.provider_source === 'user_supplied' ? 'user_supplied' : 'admin_managed',
  };
  if (input.workflowPayload.provider_source === 'user_supplied') {
    body.user_chat_base_url = input.workflowPayload.user_chat_base_url || '';
    body.user_chat_api_key = input.workflowPayload.user_chat_api_key || '';
    body.user_api_base_url = input.workflowPayload.user_chat_base_url || '';
    body.user_api_key = input.workflowPayload.user_chat_api_key || '';
    body.preferred_auth_mode = input.workflowPayload.preferred_auth_mode || 'bearer';
    body.user_chat_fallback_mode = input.workflowPayload.user_chat_fallback_mode || 'platform_fallback';
  }
  const { response, text, json } = await fetchJsonWithTimeout(
    `${localApiBaseUrl}/v1/chat/completions`,
    {
      method: 'POST',
      headers: createCanvasInternalRequestHeaders(input.workflowPayload),
      body: JSON.stringify(body),
    },
    chatRequestTimeoutMs,
  );
  if (!response.ok) {
    throw new Error(extractLocalErrorMessage(json, 'Canvas chat completion failed.'));
  }
  return extractChatCompletionText(json) || text.trim();
}

async function runCanvasGenerateNode(input: {
  workflowPayload: CanvasWorkflowPayload;
  runId: string;
  node: CanvasNode;
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  resultsByNode: Map<string, CanvasGeneratedItem[]>;
}) {
  const promptItems = collectCanvasPromptItems(input.node, input.nodes, input.edges);
  if (!promptItems.length) {
    throw new Error(`生成图片节点【${getCanvasNodeLabel(input.node)}】缺少提示词。`);
  }
  const referenceSets = collectCanvasReferenceSets(input.node, input.nodes, input.edges, input.resultsByNode);
  const resultItems: CanvasGeneratedItem[] = [];
  for (const promptItem of promptItems) {
    for (const references of referenceSets) {
      const index = resultItems.length + 1;
      const image = await executeCanvasImageGeneration({
        workflowPayload: input.workflowPayload,
        node: input.node,
        prompt: promptItem.prompt,
        references,
      });
      resultItems.push({
        job_id: `${input.node.id}:${index}`,
        task_id: image.taskId,
        node_id: input.node.id,
        status: 'done',
        image_url: image.imageUrl,
        reference_url: image.imageUrl,
        download_url: image.imageUrl,
        prompt: promptItem.prompt,
        batch_item: promptItem.batch_item,
        index,
        name: promptItem.batch_item ? String(promptItem.batch_item.name || `batch-${index}`) : `${getCanvasNodeLabel(input.node)}-${index}`,
      });
      await setCanvasJobState(input.runId, input.node.id, {
        status: 'running',
        image_url: image.imageUrl,
        reference_url: image.imageUrl,
        result_items: resultItems,
      });
      await setCanvasNodeState(input.runId, input.node.id, {
        status: 'running',
        image_url: image.imageUrl,
        reference_url: image.imageUrl,
      });
    }
  }
  input.resultsByNode.set(input.node.id, resultItems);
  const first = resultItems[0];
  await setCanvasJobState(input.runId, input.node.id, {
    status: 'done',
    image_url: first?.image_url,
    reference_url: first?.reference_url,
    result_items: resultItems,
  });
  await setCanvasNodeState(input.runId, input.node.id, {
    status: 'done',
    image_url: first?.image_url,
    reference_url: first?.reference_url,
  });
}

async function runCanvasImageExplosionNode(input: {
  workflowPayload: CanvasWorkflowPayload;
  runId: string;
  node: CanvasNode;
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  resultsByNode: Map<string, CanvasGeneratedItem[]>;
}) {
  const references = collectCanvasAllReferences(input.node, input.nodes, input.edges, input.resultsByNode);
  if (!references.length) {
    throw new Error(`图片大爆炸节点【${getCanvasNodeLabel(input.node)}】缺少前置参考图。`);
  }
  const count = Math.max(1, Math.min(20, Number(input.node.data?.elementCount || 6)));
  let analysisText = '';
  try {
    analysisText = await executeCanvasChatCompletion({
      workflowPayload: input.workflowPayload,
      instruction: buildCanvasImageExplosionPrompt(input.node),
      images: references,
    });
  } catch (error) {
    analysisText = JSON.stringify({
      prompt_items: Array.from({ length: count }).map((_, index) => ({
        name: `元素${index + 1}`,
        image_category: 'exploded_element',
        prompt: `参考原始图像，生成第 ${index + 1} 个最有价值的视觉元素，保持主体特征、材质、色彩和光影关系。`,
      })),
    });
    await appendCanvasRunHistory(input.runId, '图片大爆炸 Chat 分析失败，已使用保守兜底提示词继续执行。', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  const promptItems = normalizeCanvasPromptItems(analysisText, count);
  if (!promptItems.length) {
    throw new Error('图片大爆炸没有解析到可用的子提示词。');
  }
  await setCanvasJobState(input.runId, input.node.id, {
    status: 'running',
    exploded_prompts: promptItems,
  });
  await setCanvasNodeState(input.runId, input.node.id, {
    status: 'running',
    exploded_prompts: promptItems,
  });
  const resultItems: CanvasGeneratedItem[] = [];
  for (const item of promptItems) {
    const image = await executeCanvasImageGeneration({
      workflowPayload: input.workflowPayload,
      node: input.node,
      prompt: item.prompt,
      references,
    });
    resultItems.push({
      job_id: `${input.node.id}:${item.index}`,
      task_id: image.taskId,
      node_id: input.node.id,
      status: 'done',
      image_url: image.imageUrl,
      reference_url: image.imageUrl,
      download_url: image.imageUrl,
      prompt: item.prompt,
      name: item.name,
      image_category: item.image_category,
      batch_item: {
        ...(item.raw || {}),
        index: item.index,
        name: item.name,
        image_category: item.image_category,
        source_locator: item.source_locator || '',
        prompt: item.prompt,
      },
      index: item.index,
    });
    await setCanvasJobState(input.runId, input.node.id, {
      status: 'running',
      image_url: resultItems[0]?.image_url,
      reference_url: resultItems[0]?.reference_url,
      result_items: resultItems,
      exploded_prompts: promptItems,
    });
    await setCanvasNodeState(input.runId, input.node.id, {
      status: 'running',
      image_url: resultItems[0]?.image_url,
      reference_url: resultItems[0]?.reference_url,
      exploded_prompts: promptItems,
    });
  }
  input.resultsByNode.set(input.node.id, resultItems);
  await setCanvasJobState(input.runId, input.node.id, {
    status: 'done',
    image_url: resultItems[0]?.image_url,
    reference_url: resultItems[0]?.reference_url,
    result_items: resultItems,
    exploded_prompts: promptItems,
  });
  await setCanvasNodeState(input.runId, input.node.id, {
    status: 'done',
    image_url: resultItems[0]?.image_url,
    reference_url: resultItems[0]?.reference_url,
    exploded_prompts: promptItems,
  });
}

async function runCanvasEcommerceImageNode(input: {
  workflowPayload: CanvasWorkflowPayload;
  runId: string;
  node: CanvasNode;
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  resultsByNode: Map<string, CanvasGeneratedItem[]>;
}) {
  const originalReferences = collectCanvasAllReferences(input.node, input.nodes, input.edges, input.resultsByNode);
  if (!originalReferences.length) {
    throw new Error(`电商图节点【${getCanvasNodeLabel(input.node)}】缺少商品参考图。`);
  }
  const shouldRunStrategy = String(input.node.data?.structureMode || 'smart').trim() !== 'custom';
  await setCanvasJobState(input.runId, input.node.id, {
    status: 'running',
    ecommerce_stage: 'strategy_analysis',
    strategy_analysis_status: shouldRunStrategy ? 'running' : 'done',
    analysis_status: '',
    set_analysis_status: '',
    ecommerce_prompts: [],
    ecommerce_effective_config: null,
    ecommerce_strategy_result: null,
  });
  await setCanvasNodeState(input.runId, input.node.id, {
    status: 'running',
    ecommerce_stage: 'strategy_analysis',
    strategy_analysis_status: shouldRunStrategy ? 'running' : 'done',
    analysis_status: '',
    set_analysis_status: '',
    ecommerce_prompts: [],
    ecommerce_effective_config: null,
    ecommerce_strategy_result: null,
  });

  let strategyResult: Record<string, unknown> | null = null;
  let effectiveConfig: Record<string, unknown> | null = null;
  let effectiveNode = input.node;
  if (shouldRunStrategy) {
    try {
      const strategyAnalysis = await executeCanvasChatCompletion({
        workflowPayload: input.workflowPayload,
        instruction: buildCanvasEcommerceStrategyPrompt(input.node),
        images: originalReferences,
      });
      strategyResult = normalizeCanvasEcommerceStrategyResult(strategyAnalysis, input.node) as Record<string, unknown>;
      if (!Array.isArray(strategyResult?.recommended_image_plan) || !strategyResult.recommended_image_plan.length) {
        throw new Error('策略分析没有返回可用的逐图规划。');
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error || '');
      strategyResult = buildCanvasEcommerceFallbackStrategyResult(input.node, reason) as Record<string, unknown>;
      await appendCanvasRunHistory(input.runId, '电商图策略分析失败，已按默认能力结构继续执行。', { error: reason });
    }
    effectiveConfig = buildCanvasEcommerceEffectiveConfig(input.node, strategyResult) as Record<string, unknown>;
    effectiveNode = buildCanvasEffectiveEcommerceNode(input.node, effectiveConfig, strategyResult);
  }

  let setCount = getCanvasEcommerceSetCount(effectiveNode.data || {});
  await setCanvasJobState(input.runId, input.node.id, {
    status: 'running',
    ecommerce_stage: 'overview_analysis',
    strategy_analysis_status: 'done',
    analysis_status: 'running',
    set_analysis_status: '',
    ecommerce_effective_config: effectiveConfig,
    ecommerce_strategy_result: strategyResult,
  });
  await setCanvasNodeState(input.runId, input.node.id, {
    status: 'running',
    ecommerce_stage: 'overview_analysis',
    strategy_analysis_status: 'done',
    analysis_status: 'running',
    set_analysis_status: '',
    ecommerce_effective_config: effectiveConfig,
    ecommerce_strategy_result: strategyResult,
  });

  const overviewAnalysis = await executeCanvasChatCompletion({
    workflowPayload: input.workflowPayload,
    instruction: buildCanvasEcommerceOverviewPrompt(effectiveNode),
    images: originalReferences,
  });
  const overviewPromptItem = normalizeCanvasPromptItems(overviewAnalysis, 1)[0] || null;
  const overviewPrompt = cleanCanvasEcommerceVisiblePromptText(overviewPromptItem?.prompt || '', (overviewPromptItem || {}) as Record<string, unknown>);
  if (!overviewPrompt) {
    throw new Error('电商图第一阶段没有解析到组图总览提示词。');
  }
  const overviewImage = await executeCanvasImageGeneration({
    workflowPayload: input.workflowPayload,
    node: effectiveNode,
    prompt: overviewPrompt,
    references: originalReferences,
  });
  const overviewBatchItem = {
    ...(overviewPromptItem?.raw || {}),
    index: 1,
    role: 'overview',
    name: String(overviewPromptItem?.name || 'overview').trim() || 'overview',
    image_category: String(overviewPromptItem?.image_category || 'overview').trim() || 'overview',
    goal: String(overviewPromptItem?.goal || '').trim(),
    reference_usage: String(overviewPromptItem?.reference_usage || '原始商品参考图用于锁定商品身份、结构、颜色和关键部件。').trim(),
    visible_headline: String(overviewPromptItem?.visible_headline || '').trim(),
    visible_copy_points: Array.isArray(overviewPromptItem?.visible_copy_points) ? overviewPromptItem.visible_copy_points : [],
    prompt: String(overviewPromptItem?.prompt || overviewPrompt).trim(),
  };
  const resultItems: CanvasGeneratedItem[] = [{
    job_id: `${effectiveNode.id}:overview`,
    task_id: overviewImage.taskId,
    node_id: effectiveNode.id,
    status: 'done',
    image_url: overviewImage.imageUrl,
    reference_url: overviewImage.imageUrl,
    download_url: overviewImage.imageUrl,
    prompt: overviewPrompt,
    name: '01-overview',
    image_category: overviewBatchItem.image_category || 'overview',
    goal: overviewBatchItem.goal || '',
    reference_usage: overviewBatchItem.reference_usage || '',
    batch_item: overviewBatchItem,
    index: 1,
  }];
  const overviewPromptStateItem = {
    ...overviewBatchItem,
    prompt: overviewBatchItem.prompt,
  };
  await setCanvasJobState(input.runId, input.node.id, {
    status: 'running',
    image_url: overviewImage.imageUrl,
    reference_url: overviewImage.imageUrl,
    result_items: resultItems,
    ecommerce_stage: 'set_analysis',
    analysis_status: 'done',
    set_analysis_status: 'running',
    exploded_prompts: [overviewPromptStateItem],
    ecommerce_prompts: [overviewPromptStateItem],
  });
  await setCanvasNodeState(input.runId, input.node.id, {
    status: 'running',
    image_url: overviewImage.imageUrl,
    reference_url: overviewImage.imageUrl,
    ecommerce_stage: 'set_analysis',
    analysis_status: 'done',
    set_analysis_status: 'running',
    exploded_prompts: [overviewPromptStateItem],
    ecommerce_prompts: [overviewPromptStateItem],
  });

  const setAnalysis = await executeCanvasChatCompletion({
    workflowPayload: input.workflowPayload,
    instruction: buildCanvasEcommerceSetPrompt(effectiveNode, overviewAnalysis),
    images: [...originalReferences, overviewImage.imageUrl],
  });
  const setPromptItems = normalizeCanvasPromptItems(setAnalysis, setCount);
  if (setPromptItems.length !== setCount) {
    await appendCanvasRunHistory(input.runId, '电商图第二阶段提示词数量与目标数量不完全一致。', {
      expected: setCount,
      actual: setPromptItems.length,
    });
  }
  if (setPromptItems.length < setCount) {
    throw new Error('电商图第二阶段没有解析到足够的套图提示词。');
  }
  const allPromptItems: Record<string, unknown>[] = [overviewPromptStateItem];
  for (const item of setPromptItems) {
    const cleanedPrompt = cleanCanvasEcommerceVisiblePromptText(item.prompt, item as unknown as Record<string, unknown>);
    const image = await executeCanvasImageGeneration({
      workflowPayload: input.workflowPayload,
      node: effectiveNode,
      prompt: cleanedPrompt,
      references: [...originalReferences, overviewImage.imageUrl],
    });
    const index = resultItems.length + 1;
    const batchItem = {
      ...(item.raw || {}),
      index,
      role: 'set_image',
      name: item.name || `套图${index - 1}`,
      title: item.title || '',
      image_category: item.image_category || '',
      goal: item.goal || '',
      reference_usage: item.reference_usage || '',
      visible_headline: item.visible_headline || '',
      visible_copy_points: Array.isArray(item.visible_copy_points) ? item.visible_copy_points : [],
      script_text: item.script_text || '',
      shot_script: item.shot_script || '',
      prompt: item.prompt,
    };
    allPromptItems.push(batchItem);
    resultItems.push({
      job_id: `${effectiveNode.id}:${index}`,
      task_id: image.taskId,
      node_id: effectiveNode.id,
      status: 'done',
      image_url: image.imageUrl,
      reference_url: image.imageUrl,
      download_url: image.imageUrl,
      prompt: cleanedPrompt,
      name: `${String(index).padStart(2, '0')}-${item.title || item.name}`,
      image_category: item.image_category,
      goal: item.goal || '',
      reference_usage: item.reference_usage || '',
      script_text: item.script_text || '',
      shot_script: item.shot_script || '',
      batch_item: batchItem,
      index,
    });
    await setCanvasJobState(input.runId, input.node.id, {
      status: 'running',
      image_url: overviewImage.imageUrl,
      reference_url: overviewImage.imageUrl,
      result_items: resultItems,
      ecommerce_stage: 'set_generating',
      set_analysis_status: 'done',
      exploded_prompts: allPromptItems,
      ecommerce_prompts: allPromptItems,
    });
    await setCanvasNodeState(input.runId, input.node.id, {
      status: 'running',
      image_url: overviewImage.imageUrl,
      reference_url: overviewImage.imageUrl,
      ecommerce_stage: 'set_generating',
      set_analysis_status: 'done',
      exploded_prompts: allPromptItems,
      ecommerce_prompts: allPromptItems,
    });
  }
  input.resultsByNode.set(input.node.id, resultItems);
  await setCanvasJobState(input.runId, input.node.id, {
    status: 'done',
    image_url: overviewImage.imageUrl,
    reference_url: overviewImage.imageUrl,
    result_items: resultItems,
    ecommerce_stage: 'done',
    analysis_status: 'done',
    set_analysis_status: 'done',
    exploded_prompts: allPromptItems,
    ecommerce_prompts: allPromptItems,
  });
  await setCanvasNodeState(input.runId, input.node.id, {
    status: 'done',
    image_url: overviewImage.imageUrl,
    reference_url: overviewImage.imageUrl,
    ecommerce_stage: 'done',
    analysis_status: 'done',
    set_analysis_status: 'done',
    exploded_prompts: allPromptItems,
    ecommerce_prompts: allPromptItems,
  });
}

async function runCanvasOutputNode(input: {
  runId: string;
  node: CanvasNode;
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  resultsByNode: Map<string, CanvasGeneratedItem[]>;
}) {
  const incoming = getCanvasIncomingNodes(input.node.id, input.nodes, input.edges);
  const resultItems = incoming
    .filter((source) => ['generate', 'imageExplosion', 'ecommerceImage'].includes(source.type))
    .flatMap((source) => input.resultsByNode.get(source.id) || []);
  const first = resultItems[0];
  const packageFileName = `yali-canvas-${String(input.runId).replace(/[^a-zA-Z0-9._-]/g, '_')}.json`;
  const packageUrl = `data:application/json;charset=utf-8,${encodeURIComponent(JSON.stringify({
    canvas_run_id: input.runId,
    generated_at: new Date().toISOString(),
    count: resultItems.length,
    items: resultItems.map((item, index) => ({
      index: index + 1,
      name: item.name || `image_${index + 1}`,
      image_category: item.image_category || '',
      image_url: item.download_url || item.image_url || '',
      prompt: item.prompt || '',
    })),
  }, null, 2))}`;
  input.resultsByNode.set(input.node.id, resultItems);
  await setCanvasJobState(input.runId, input.node.id, {
    status: 'done',
    image_url: first?.image_url,
    reference_url: first?.reference_url,
    dependencies: incoming.map((source) => `job_${source.id}`),
    result_items: resultItems,
    download_url: packageUrl,
  });
  await setCanvasNodeState(input.runId, input.node.id, {
    status: 'done',
    image_url: first?.image_url,
    output_url: first?.download_url || first?.image_url,
    package_url: packageUrl,
    package_file_name: packageFileName,
    package_count: resultItems.length,
  });
}

async function runCanvasWorkflowAsync(runId: string, workflowPayload: CanvasWorkflowPayload) {
  const nodes = normalizeCanvasNodes(workflowPayload.nodes);
  const edges = normalizeCanvasEdges(workflowPayload.edges);
  const plan = buildCanvasExecutionPlan(nodes, edges);
  const resultsByNode = new Map<string, CanvasGeneratedItem[]>();
  try {
    for (const node of plan) {
      const current = await getCanvasRunOrThrow(runId);
      if (current.status === 'cancel_requested') {
        await updateCanvasRun(runId, (run) => {
          run.status = 'cancelled';
          run.completed_at = Date.now();
        });
        return;
      }
      await appendCanvasRunHistory(runId, `开始执行节点：${getCanvasNodeLabel(node)}`, { nodeId: node.id, type: node.type });
      await setCanvasNodeState(runId, node.id, { status: 'running', error_message: '' });
      await setCanvasJobState(runId, node.id, { status: 'running', error_message: '' });
      if (node.type === 'generate') {
        await runCanvasGenerateNode({ workflowPayload, runId, node, nodes, edges, resultsByNode });
      } else if (node.type === 'imageExplosion') {
        await runCanvasImageExplosionNode({ workflowPayload, runId, node, nodes, edges, resultsByNode });
      } else if (node.type === 'ecommerceImage') {
        await runCanvasEcommerceImageNode({ workflowPayload, runId, node, nodes, edges, resultsByNode });
      } else if (node.type === 'output') {
        await runCanvasOutputNode({ runId, node, nodes, edges, resultsByNode });
      }
      await appendCanvasRunHistory(runId, `节点完成：${getCanvasNodeLabel(node)}`, { nodeId: node.id, type: node.type });
    }
    await updateCanvasRun(runId, (run) => {
      run.status = 'completed';
      run.completed_at = Date.now();
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error || 'Canvas workflow failed.');
    await updateCanvasRun(runId, (run) => {
      run.status = 'failed';
      run.error_message = message;
      run.completed_at = Date.now();
    });
    const current = await getCanvasRunOrThrow(runId);
    const runningNode = current.node_states.find((state) => state.status === 'running');
    if (runningNode) {
      await setCanvasNodeState(runId, runningNode.node_id, { status: 'failed', error_message: message });
      await setCanvasJobState(runId, runningNode.node_id, { status: 'failed', error_message: message });
    }
    await appendCanvasRunHistory(runId, '画布运行失败。', { error: message });
  }
}

async function processCanvasWorkflowQueue() {
  if (pumpRunning) {
    return;
  }
  pumpRunning = true;
  try {
    const runs = (await listSharedCanvasWorkflowRuns())
      .filter((run) => run.status === 'queued')
      .sort((left, right) => Number(left.created_at || 0) - Number(right.created_at || 0));
    const next = runs[0];
    if (!next) {
      return;
    }
    const claimed = await claimWorkflowRun(next.run_id);
    if (!claimed) {
      return;
    }
    try {
      const fresh = await getCanvasWorkflowRunState(next.run_id);
      if (!fresh || fresh.status !== 'queued') {
        return;
      }
      const executionPayload = fresh.execution_payload
        ? createWorkflowRunSchema.parse(fresh.execution_payload)
        : null;
      if (!executionPayload) {
        fresh.status = 'failed';
        fresh.error_message = 'Canvas workflow payload is missing.';
        fresh.completed_at = Date.now();
        fresh.updated_at = Date.now();
        await persistCanvasWorkflowRun(fresh);
        return;
      }
      fresh.status = 'running';
      fresh.started_at = Date.now();
      fresh.updated_at = Date.now();
      fresh.last_worker_id = `${process.pid}`;
      await persistCanvasWorkflowRun(fresh);
      await runCanvasWorkflowAsync(fresh.run_id, executionPayload);
    } finally {
      await releaseWorkflowRunClaim(next.run_id);
    }
  } catch (error) {
    requestLogWarn('workflow_queue_process_failed', error);
  } finally {
    pumpRunning = false;
  }
}

export async function startCanvasWorkflowWorkerRuntime() {
  if (claimClient && !claimClient.isOpen) {
    await claimClient.connect();
  }
  await processCanvasWorkflowQueue();
  const timer = setInterval(() => {
    void processCanvasWorkflowQueue();
  }, canvasWorkflowQueuePollMs);
  if (typeof timer.unref === 'function') {
    timer.unref();
  }
}
