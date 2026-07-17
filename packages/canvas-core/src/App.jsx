import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Background, ControlButton, Controls, MiniMap, ReactFlow, addEdge, useEdgesState, useNodesState } from '@xyflow/react';
import { Check, FileSpreadsheet, Grid3X3, Play, Square, Trash2, Upload, X } from 'lucide-react';
import { FIT_VIEW_OPTIONS } from './config/constants.js';
import { NODE_DEFS } from './config/nodeDefs.jsx';
import { createDefaultData, initialEdges, initialNodes } from './config/initialWorkflow.js';
import { BatchPromptNode, EcommerceImageNode, GenerateNode, ImageExplosionNode, LocalReferenceNode, OutputNode, PromptNode, ReferenceNode } from './nodes/index.jsx';
import { CreateMenu, EdgeInspector, Inspector, RunLog } from './panels/index.jsx';
import { ImageLightbox, LocalReferenceModal, ReferenceEditorModal, ResultGalleryModal } from './editors/index.jsx';
import { fileToDataUrl, isEditableTarget } from './utils/image.js';
import { CANVAS_REFERENCE_IMAGE_MAX_BYTES, appendHistory, buildRunnableExecutionPlan, buildWorkflowOutputPackageFromItems, getBatchContextsByNode, getImageGroupContextsByNode, getOutputGeneratedInputCount, getOutputModeRequirements, nodeHasContent, validateBatchPromptUsage, validateImageRequestInputs, validateRequiredOutputNodes } from './utils/workflow.js';
import { createWorkflowRunContext, nextRunContextEdgeStates } from './utils/workflowRunContext.js';
import { mergeCanvasSessionConfig, readCanvasConfig, writeLocalCanvasUpstreamPreference } from './utils/canvasConfig.js';
import {
  buildLocalEcommerceEffectiveConfig,
  getLocalEcommerceSetCount,
  buildLocalEcommerceFallbackStrategyResult,
  buildLocalEcommerceOverviewPrompt,
  buildLocalEcommerceSetPrompt,
  buildLocalEcommerceStrategyPrompt,
  buildLocalImageExplosionPrompt,
  cleanLocalEcommerceVisiblePromptText,
  collectLocalAllReferences,
  collectLocalPromptItems,
  collectLocalReferenceSets,
  executeLocalChatCompletion,
  executeLocalImagesRequest,
  getLocalBrowserUnsupportedMessage,
  isLocalBrowserSupportedNodeType,
  normalizeLocalDerivedPromptItems,
  normalizeLocalEcommerceStrategyResult,
} from './utils/localWorkflow.js';
import { ECOMMERCE_CAPABILITY_OPTIONS, buildEcommerceCapabilityNodePatch } from './utils/ecommerce.js';
import {
  cancelCanvasWorkflowRun,
  changeCanvasUserPassword,
  clearCanvasTaskGroup,
  getCanvasUserApiKeys,
  getCanvasUserFinanceLedger,
  getCanvasWorkflowRunStatus,
  imageUrlToBlob,
  loginCanvasUser,
  logoutCanvasUser,
  packageCanvasTaskGroup,
  pollCanvasImageTask,
  previewCanvasBatchPromptSheet,
  regenerateCanvasUserApiKey,
  registerCanvasUser,
  saveCanvasUserApiKeySettings,
  setCanvasUserDefaultApiKey,
  selectCanvasResultVersion,
  startCanvasWorkflowRun,
  startCanvasImageTask,
  uploadCanvasReferenceAsset,
} from './utils/canvasApi.js';
import { annotateLocalReferenceImage, normalizeLocalCircles, prepareCanvasWorkflowNodesForServer } from './utils/canvasPayload.js';
import { ensureCanvasAccess as evaluateCanvasAccess } from './utils/canvasCapabilities.js';
import { fetchCanvasSessionConfig } from './utils/canvasSession.js';
import { buildCanvasAccessViewState } from './utils/canvasViewState.js';

const NODE_TYPES = {
  prompt: PromptNode,
  batchPrompt: BatchPromptNode,
  reference: ReferenceNode,
  localReference: LocalReferenceNode,
  generate: GenerateNode,
  imageExplosion: ImageExplosionNode,
  ecommerceImage: EcommerceImageNode,
  output: OutputNode,
};

const CANVAS_CACHE_VERSION = 3;
const CANVAS_CACHE_PREFIX = 'yali-free-image-canvas';
const REFERENCE_NODE_TYPES = new Set(['reference', 'localReference']);
const REFERENCE_DISPLAY_NODE_TYPES = new Set(['reference', 'localReference', 'generate', 'imageExplosion', 'ecommerceImage', 'output']);
const VALIDATION_FOCUS_NODE_TYPES = new Set(['prompt', 'batchPrompt', 'reference', 'localReference', 'imageExplosion', 'ecommerceImage', 'output']);
const CANVAS_SNAP_GRID = [20, 20];
const CANVAS_NODE_DRAG_MIME = 'application/x-yali-canvas-node';

function setCanvasNodeDragPayload(event, type, dataPatch = {}) {
  event.dataTransfer?.setData(CANVAS_NODE_DRAG_MIME, JSON.stringify({ type, dataPatch }));
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'copy';
  }
}

function parseCanvasNodeDragPayload(event) {
  const raw = event.dataTransfer?.getData(CANVAS_NODE_DRAG_MIME);
  if (!raw) {
    return null;
  }
  try {
    const payload = JSON.parse(raw);
    const type = String(payload?.type || '').trim();
    if (!NODE_DEFS[type]) {
      return null;
    }
    const dataPatch = payload?.dataPatch && typeof payload.dataPatch === 'object' && !Array.isArray(payload.dataPatch)
      ? payload.dataPatch
      : {};
    return { type, dataPatch };
  } catch (error) {
    return null;
  }
}

function getCanvasCacheKey(config) {
  const userId = String(config?.currentUserId || config?.userId || '').trim() || 'anonymous';
  return `${CANVAS_CACHE_PREFIX}:v${CANVAS_CACHE_VERSION}:${userId}`;
}

function removeCachedWorkflow(config, options = {}) {
  const keys = new Set([getCanvasCacheKey(config)]);
  if (options.includeAnonymous) {
    keys.add(`${CANVAS_CACHE_PREFIX}:v${CANVAS_CACHE_VERSION}:anonymous`);
  }
  try {
    keys.forEach((key) => window.localStorage?.removeItem(key));
  } catch (error) {
    // Ignore local storage cleanup failures.
  }
}

function readCachedWorkflow(config) {
  const fallback = { nodes: normalizeReferenceOrders(initialNodes), edges: initialEdges, selectedNodeId: '', canvasId: createCanvasId() };
  try {
    const raw = window.localStorage?.getItem(getCanvasCacheKey(config));
    if (!raw) {
      return fallback;
    }
    const payload = JSON.parse(raw);
    if (payload?.version !== CANVAS_CACHE_VERSION || !Array.isArray(payload.nodes) || !Array.isArray(payload.edges)) {
      return fallback;
    }
    const migrated = migrateLegacyDefaultWorkflow(payload.nodes.length ? payload.nodes : initialNodes, payload.edges);
    return {
      nodes: normalizeReferenceOrders(migrated.nodes.map(stripRuntimeNodeData)),
      edges: migrated.edges,
      selectedNodeId: '',
      canvasId: normalizeCanvasId(payload.canvasId) || fallback.canvasId,
    };
  } catch (error) {
    return fallback;
  }
}

function writeCachedWorkflow(config, nodes, edges, selectedNodeId, canvasId) {
  try {
    window.localStorage?.setItem(getCanvasCacheKey(config), JSON.stringify({
      version: CANVAS_CACHE_VERSION,
      savedAt: Date.now(),
      selectedNodeId,
      canvasId,
      nodes: nodes.map(stripRuntimeNodeData),
      edges,
    }));
  } catch (error) {
    // Local storage can be unavailable or full; the canvas still works without persistence.
  }
}

function stripRuntimeNodeData(node) {
  const data = { ...(node.data || {}) };
  delete data.onDelete;
  delete data.onClearBatchPrompt;
  delete data.onClearResult;
  delete data.onOpenBatchPrompt;
  delete data.onOpenLocalReference;
  delete data.onOpenReferenceEditor;
  delete data.onPreview;
  delete data.onRequestUpload;
  delete data.onRunNode;
  delete data.batchSourceLabel;
  delete data.batchTotal;
  delete data.locked;
  delete data.originalImageUrl;
  delete data.resultItems;
  delete data.taskId;
  delete data.referenceUrl;
  delete data.outputUrl;
  delete data.packageUrl;
  delete data.packageCount;
  delete data.packageFileName;
  delete data.errorMessage;
  delete data.explodedPrompts;
  delete data.ecommercePrompts;
  delete data.ecommerceStage;
  delete data.ecommerceStrategyAnalysisStatus;
  delete data.ecommerceAnalysisStatus;
  delete data.ecommerceSetAnalysisStatus;
  delete data.ecommerceEffectiveConfig;
  delete data.ecommerceStrategyResult;
  delete data.csvUrl;
  delete data.result;
  delete data.revisedPrompt;
  delete data.responseId;
  delete data.requestPayload;
  if (!REFERENCE_NODE_TYPES.has(node?.type)) {
    delete data.imageUrl;
    delete data.annotatedImageUrl;
  }
  return { ...node, data };
}

function stripServerWorkflowNodeData(node) {
  const normalized = stripRuntimeNodeData(node);
  const data = { ...(normalized.data || {}) };
  delete data.originalImageUrl;
  delete data.resultItems;
  delete data.taskId;
  delete data.referenceUrl;
  delete data.outputUrl;
  delete data.packageUrl;
  delete data.packageCount;
  delete data.packageFileName;
  delete data.errorMessage;
  delete data.explodedPrompts;
  delete data.batchTotal;
  delete data.batchSourceLabel;
  delete data.csvUrl;

  if (normalized.type === 'localReference') {
    delete data.region;
    delete data.circles;
    delete data.localPrompt;
    if (String(data.annotatedImageUrl || '').trim()) {
      delete data.imageUrl;
    }
  } else if (normalized.type !== 'reference') {
    delete data.imageUrl;
    delete data.annotatedImageUrl;
  }

  return { ...normalized, data };
}

function validateReferenceUploadFile(file) {
  if (!file) {
    return '';
  }
  if (!String(file.type || '').startsWith('image/')) {
    return '只能上传图片文件。';
  }
  if (Number(file.size || 0) > CANVAS_REFERENCE_IMAGE_MAX_BYTES) {
    return '单张参考图最大支持 12MB，请压缩后再上传。';
  }
  return '';
}

function normalizeResultItem(job, fallbackIndex = 0) {
  if (!job || typeof job !== 'object') {
    return null;
  }
  const imageUrl = String(job.image_url || job.imageUrl || '').trim();
  const referenceUrl = String(job.reference_url || job.referenceUrl || '').trim();
  const batchItem = job.batch_item && typeof job.batch_item === 'object'
    ? job.batch_item
    : (job.batchItem && typeof job.batchItem === 'object' ? job.batchItem : null);
  const versions = Array.isArray(job.versions)
    ? job.versions.filter((version) => version && (version.imageUrl || version.image_url || version.downloadUrl || version.download_url)).map((version, index) => ({
        id: String(version.id || version.versionId || version.version_id || `version-${index + 1}`).trim(),
        label: String(version.label || version.name || `版本 ${index + 1}`).trim(),
        imageUrl: String(version.imageUrl || version.image_url || '').trim(),
        downloadUrl: String(version.downloadUrl || version.download_url || version.referenceUrl || version.reference_url || version.imageUrl || version.image_url || '').trim(),
        taskId: String(version.taskId || version.task_id || '').trim(),
        prompt: String(version.prompt || '').trim(),
        editType: String(version.editType || version.edit_type || '').trim(),
        createdAt: String(version.createdAt || version.created_at || '').trim(),
      }))
    : [];
  return {
    jobId: String(job.id || job.job_id || job.jobId || '').trim(),
    nodeId: String(job.node_id || job.nodeId || '').trim(),
    taskId: String(job.task_id || job.taskId || '').trim(),
    artifactOwnerType: String(job.artifact_owner_type || job.artifactOwnerType || '').trim(),
    artifactOwnerNode: String(job.artifact_owner_node || job.artifactOwnerNode || '').trim(),
    executorType: String(job.executor_type || job.executorType || '').trim(),
    executorNodeId: String(job.executor_node_id || job.executorNodeId || '').trim(),
    status: String(job.status || '').trim(),
    imageUrl,
    referenceUrl,
    downloadUrl: referenceUrl || imageUrl,
    prompt: String(job.prompt || '').trim(),
    errorMessage: String(job.error_message || job.errorMessage || '').trim(),
    batchItem,
    index: Number(batchItem?.index || fallbackIndex + 1),
    name: String(batchItem?.name || '').trim(),
    imageCategory: String(job.image_category || job.imageCategory || batchItem?.image_category || batchItem?.imageCategory || '').trim(),
    goal: String(job.goal || batchItem?.goal || '').trim(),
    referenceUsage: String(job.reference_usage || job.referenceUsage || batchItem?.reference_usage || batchItem?.referenceUsage || '').trim(),
    scriptText: String(job.script_text || job.scriptText || batchItem?.script_text || batchItem?.scriptText || batchItem?.video_script || batchItem?.videoScript || '').trim(),
    shotScript: String(job.shot_script || job.shotScript || batchItem?.shot_script || batchItem?.shotScript || batchItem?.storyboard_script || batchItem?.storyboardScript || '').trim(),
    versions,
    selectedVersionId: String(job.selectedVersionId || job.selected_version_id || '').trim(),
  };
}

function buildResultItemsByNode(runPayload) {
  const jobs = Array.isArray(runPayload?.jobs) ? runPayload.jobs : [];
  const jobsById = new Map();
  const generateItemsByNode = new Map();

  const normalizeJobResultItems = (job, nodeId, jobId, fallbackIndex = 0) => {
    const nestedItems = Array.isArray(job?.result_items) ? job.result_items : [];
    if (!nestedItems.length) {
      return [];
    }
    return nestedItems
      .map((child, childIndex) => normalizeResultItem({
        ...child,
        node_id: child?.node_id || child?.nodeId || nodeId,
        job_id: child?.job_id || child?.jobId || `${jobId}:e${childIndex + 1}`,
      }, fallbackIndex + childIndex))
      .filter(Boolean);
  };

  jobs.forEach((job, index) => {
    const jobId = String(job?.id || job?.job_id || '').trim();
    if (jobId) {
      jobsById.set(jobId, job);
    }
    if (!['generate', 'imageExplosion', 'ecommerceImage'].includes(String(job?.type || ''))) {
      return;
    }
    const nodeId = String(job?.node_id || '').trim();
    if (!nodeId) {
      return;
    }
    if (!generateItemsByNode.has(nodeId)) {
      generateItemsByNode.set(nodeId, []);
    }
    const nestedItems = normalizeJobResultItems(job, nodeId, jobId, 0);
    if (nestedItems.length) {
      generateItemsByNode.get(nodeId).push(...nestedItems);
      return;
    }
    const item = normalizeResultItem(job, index);
    if (item) {
      generateItemsByNode.get(nodeId).push(item);
    }
  });

  jobs.forEach((job) => {
    if (String(job?.type || '') !== 'output') {
      return;
    }
    const nodeId = String(job?.node_id || '').trim();
    if (!nodeId) {
      return;
    }
    const ownItems = normalizeJobResultItems(job, nodeId, String(job?.id || job?.job_id || nodeId).trim(), 0);
    if (ownItems.length) {
      generateItemsByNode.set(nodeId, ownItems);
      return;
    }
    const deps = Array.isArray(job?.dependencies) ? job.dependencies : [];
    const items = deps.flatMap((depId, index) => {
      const depJob = jobsById.get(String(depId || '').trim());
      if (!depJob) {
        return [];
      }
      const depNodeId = String(depJob?.node_id || '').trim();
      const nestedItems = normalizeJobResultItems(depJob, depNodeId, String(depJob?.id || depId), 0);
      if (nestedItems.length) {
        return nestedItems;
      }
      return [normalizeResultItem(depJob, index)].filter(Boolean);
    });
    if (items.length) {
      generateItemsByNode.set(nodeId, items);
    }
  });

  return generateItemsByNode;
}

function createCanvasId() {
  return `canvas_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function normalizeCanvasId(value) {
  const normalized = String(value || '').trim().replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 96);
  return /^canvas_[a-zA-Z0-9_-]{8,}$/.test(normalized) ? normalized : '';
}

function normalizeBatchPreviewItems(payload) {
  const source = Array.isArray(payload?.items) ? payload.items : (Array.isArray(payload?.preview) ? payload.preview : []);
  return source
    .map((item, index) => ({
      index: Number(item?.index || index + 1),
      name: String(item?.name || `batch-${String(index + 1).padStart(3, '0')}`).trim(),
      prompt: String(item?.prompt || '').trim(),
      skip: Boolean(item?.skip),
      skip_reason: String(item?.skip_reason || ''),
    }))
    .filter((item) => item.prompt || item.skip)
    .slice(0, 20);
}

function isReferenceNodeType(type) {
  return REFERENCE_NODE_TYPES.has(type);
}

function isReferenceDisplayNodeType(type) {
  return REFERENCE_DISPLAY_NODE_TYPES.has(type);
}

function getReferenceOrder(node) {
  const value = Number(node?.data?.referenceOrder || 0);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function compareCanvasNodePosition(a, b) {
  const ay = Number(a?.position?.y || 0);
  const by = Number(b?.position?.y || 0);
  if (ay !== by) {
    return ay - by;
  }
  const ax = Number(a?.position?.x || 0);
  const bx = Number(b?.position?.x || 0);
  if (ax !== bx) {
    return ax - bx;
  }
  return String(a?.id || '').localeCompare(String(b?.id || ''));
}

function nextReferenceOrder(nodes) {
  const maxOrder = nodes
    .filter((node) => isReferenceNodeType(node.type))
    .reduce((max, node) => Math.max(max, getReferenceOrder(node)), 0);
  return maxOrder + 1;
}

function normalizeReferenceOrders(nodes) {
  const orderByNodeId = new Map();
  nodes
    .filter((node) => isReferenceNodeType(node.type))
    .slice()
    .sort(compareCanvasNodePosition)
    .forEach((node, index) => {
      orderByNodeId.set(node.id, index + 1);
    });
  let changed = false;
  const nextNodes = nodes.map((node) => {
    let data = node.data || {};

    if (node.type === 'generate' && String(data.label || '').trim() === '生成') {
      changed = true;
      data = {
        ...data,
        label: '生成图片',
      };
    }

    if (!isReferenceNodeType(node.type)) {
      return data === node.data ? node : { ...node, data };
    }

    const referenceOrder = orderByNodeId.get(node.id) || 0;
    if (getReferenceOrder({ ...node, data }) === referenceOrder) {
      return data === node.data ? node : { ...node, data };
    }
    changed = true;
    return {
      ...node,
      data: {
        ...data,
        referenceOrder,
      },
    };
  });
  return changed ? nextNodes : nodes;
}

function isEmptyLegacyDefaultLocalReference(node) {
  if (node?.id !== 'local-reference-1' || node?.type !== 'localReference') {
    return false;
  }
  const data = node.data || {};
  const hasCircles = Array.isArray(data.circles) && data.circles.length > 0;
  return !data.imageUrl && !data.originalImageUrl && !data.localPrompt && !data.region && !hasCircles;
}

function migrateLegacyDefaultWorkflow(nodes, edges) {
  if (!nodes.some(isEmptyLegacyDefaultLocalReference)) {
    return { nodes, edges };
  }
  return {
    nodes: nodes.filter((node) => !isEmptyLegacyDefaultLocalReference(node)),
    edges: edges.filter((edge) => edge.id !== 'local-reference-generate' && edge.source !== 'local-reference-1' && edge.target !== 'local-reference-1'),
  };
}

function referenceOrdersNeedNormalization(nodes) {
  const orderByNodeId = new Map();
  nodes
    .filter((node) => isReferenceNodeType(node.type))
    .slice()
    .sort(compareCanvasNodePosition)
    .forEach((node, index) => {
      orderByNodeId.set(node.id, index + 1);
    });
  return nodes.some((node) => {
    if (node.type === 'generate' && String(node.data?.label || '').trim() === '生成') {
      return true;
    }
    if (!isReferenceNodeType(node.type)) {
      return false;
    }
    return getReferenceOrder(node) !== (orderByNodeId.get(node.id) || 0);
  });
}

function buildReferenceDisplayOrders(nodes, edges) {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const orders = new Map();
  nodes
    .filter((node) => ['generate', 'imageExplosion', 'ecommerceImage', 'output'].includes(node.type))
    .slice()
    .sort(compareCanvasNodePosition)
    .forEach((targetNode) => {
      edges
        .filter((edge) => edge.target === targetNode.id)
        .map((edge) => nodeById.get(edge.source))
        .filter((node) => node && isReferenceDisplayNodeType(node.type))
        .sort(compareCanvasNodePosition)
        .forEach((sourceNode, index) => {
          if (!orders.has(sourceNode.id)) {
            orders.set(sourceNode.id, index + 1);
          }
        });
    });
  return orders;
}

function displayNodeLabel(type, data = {}) {
  const label = String(data.label || '').trim();
  if (type === 'generate' && (!label || label === '生成')) {
    return '生成图片';
  }
  return label || NODE_DEFS[type]?.label || '';
}

function getActiveBatchContexts(nodes, edges) {
  const contexts = getBatchContextsByNode(nodes, edges);
  const bySourceId = new Map();
  contexts.forEach((context) => {
    if (!context || context.conflict || !context.total || !context.sourceId) {
      return;
    }
    if (!bySourceId.has(context.sourceId)) {
      bySourceId.set(context.sourceId, context);
    }
  });
  return Array.from(bySourceId.values());
}

function findUpstreamImageFromMap(nodeId, nodes, edges, imageByNodeId) {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const incomingByTarget = new Map();
  edges.forEach((edge) => {
    if (!incomingByTarget.has(edge.target)) {
      incomingByTarget.set(edge.target, []);
    }
    incomingByTarget.get(edge.target).push(edge.source);
  });

  const visited = new Set();
  const walk = (currentId) => {
    if (visited.has(currentId)) {
      return '';
    }
    visited.add(currentId);
    const incoming = incomingByTarget.get(currentId) || [];
    for (const sourceId of incoming) {
      if (imageByNodeId?.[sourceId]) {
        return normalizeMappedImageUrl(imageByNodeId[sourceId]);
      }
      const sourceNode = nodeById.get(sourceId);
      if (sourceNode?.data?.imageUrl) {
        return sourceNode.data.imageUrl;
      }
      if (sourceNode && ['generate', 'output'].includes(sourceNode.type)) {
        const nested = walk(sourceNode.id);
        if (nested) {
          return nested;
        }
      }
    }
    return '';
  };

  return walk(nodeId);
}

function normalizeMappedImageUrl(value) {
  if (!value) {
    return '';
  }
  if (typeof value === 'string') {
    return value;
  }
  return String(value.imageUrl || value.referenceUrl || '');
}

function buildGeneratedItemTitle(node, batchItem = null) {
  const label = String(displayNodeLabel(node?.type, node?.data) || node?.id || '生成图片').trim();
  if (!batchItem) {
    return label;
  }
  const index = String(batchItem.index || '').padStart(2, '0');
  const name = String(batchItem.name || `batch-${index}`).trim();
  return `${index}-${name}-${label}`;
}

function getBatchAffectedNodeIds(nodes, edges, sourceId) {
  const contexts = getBatchContextsByNode(nodes, edges);
  const affected = new Set();
  contexts.forEach((context, nodeId) => {
    if (context?.sourceId === sourceId && !context.conflict) {
      affected.add(nodeId);
    }
  });
  return affected;
}

function buildServerWorkflowPayload(canvasId, nodes, edges, config = {}) {
  const upstreamPreference = config?.userControl?.upstreamPreference && typeof config.userControl.upstreamPreference === 'object'
    ? config.userControl.upstreamPreference
    : {};
  const hasImagesCredential = Boolean(
    String(upstreamPreference.imagesApiKey || '').trim()
      || upstreamPreference.hasImagesApiKey,
  );
  const userImagesEndpointReady = hasConfiguredImageEndpoint(upstreamPreference);
  const providerSource = String(config.canvasExecutionSource || '').trim() === 'user_supplied'
    && userImagesEndpointReady
    && hasImagesCredential
    ? 'user_supplied'
    : 'admin_managed';

  return {
    canvas_id: canvasId,
    channel_id: config.canvasChannelId || '',
    execution_source: providerSource === 'user_supplied'
      ? 'user_supplied'
      : (config.canvasExecutionSource || ''),
    provider_source: providerSource,
    ...(providerSource === 'user_supplied'
      ? {
          user_image_api_kind: String(upstreamPreference.imageApiKind || 'images_endpoint').trim() || 'images_endpoint',
          user_api_base_url: String(upstreamPreference.imagesBaseUrl || '').trim(),
          ...(String(upstreamPreference.imagesGenerationsUrl || '').trim()
            ? { user_images_generations_url: String(upstreamPreference.imagesGenerationsUrl || '').trim() }
            : {}),
          ...(String(upstreamPreference.imagesEditsUrl || '').trim()
            ? { user_images_edits_url: String(upstreamPreference.imagesEditsUrl || '').trim() }
            : {}),
          ...(String(upstreamPreference.imagesApiKey || '').trim()
            ? { user_api_key: String(upstreamPreference.imagesApiKey || '').trim() }
            : {}),
          ...(String(upstreamPreference.chatBaseUrl || '').trim()
            ? { user_chat_base_url: String(upstreamPreference.chatBaseUrl || '').trim() }
            : {}),
          ...(String(upstreamPreference.chatApiKey || '').trim()
            ? { user_chat_api_key: String(upstreamPreference.chatApiKey || '').trim() }
            : {}),
          preferred_auth_mode: String(upstreamPreference.preferredAuthMode || 'bearer').trim() || 'bearer',
          user_chat_fallback_mode: String(upstreamPreference.chatFallbackMode || 'platform_fallback').trim() || 'platform_fallback',
        }
      : {}),
    line_group: config.lineGroup || 'official',
    execution_owner_lock: config.executionOwnerLock || '',
    routing_mode: config.canvasRoutingMode || '',
    nodes: nodes.map(stripServerWorkflowNodeData),
    edges,
  };
}

function applyServerRunPayloadToNodes(runPayload, setNodes, nodesRef) {
  const states = Array.isArray(runPayload?.node_states) ? runPayload.node_states : [];
  if (!states.length) {
    return;
  }
  const stateByNodeId = new Map(states.map((state) => [String(state.node_id || ''), state]));
  const resultItemsByNode = buildResultItemsByNode(runPayload);
  setNodes((items) => {
    let changed = false;
    const nextNodes = items.map((node) => {
      const state = stateByNodeId.get(node.id);
      if (!state) {
        return node;
      }
      const patch = {};
      if (state.status) {
        patch.status = state.status;
      }
      if (state.task_id) {
        patch.taskId = state.task_id;
      }
      if (resultItemsByNode.has(node.id)) {
        patch.resultItems = resultItemsByNode.get(node.id);
      } else if (Array.isArray(state.result_items)) {
        patch.resultItems = state.result_items.map((item, index) => normalizeResultItem(item, index)).filter(Boolean);
      }
      if (Array.isArray(state.exploded_prompts)) {
        patch.explodedPrompts = state.exploded_prompts;
      }
      if (Array.isArray(state.ecommerce_prompts)) {
        patch.ecommercePrompts = state.ecommerce_prompts;
      }
      if (state.ecommerce_stage) {
        patch.ecommerceStage = state.ecommerce_stage;
      }
      if (state.strategy_analysis_status) {
        patch.ecommerceStrategyAnalysisStatus = state.strategy_analysis_status;
      }
      if (state.analysis_status) {
        patch.ecommerceAnalysisStatus = state.analysis_status;
      }
      if (state.set_analysis_status) {
        patch.ecommerceSetAnalysisStatus = state.set_analysis_status;
      }
      if (state.ecommerce_effective_config && typeof state.ecommerce_effective_config === 'object') {
        patch.ecommerceEffectiveConfig = state.ecommerce_effective_config;
      }
      if (state.ecommerce_strategy_result && typeof state.ecommerce_strategy_result === 'object') {
        patch.ecommerceStrategyResult = state.ecommerce_strategy_result;
      }
      if (state.image_url) {
        patch.imageUrl = state.image_url;
      } else if (Array.isArray(patch.resultItems)) {
        const firstImage = patch.resultItems.find((item) => item?.imageUrl || item?.downloadUrl || item?.referenceUrl);
        if (firstImage) {
          patch.imageUrl = firstImage.imageUrl || firstImage.downloadUrl || firstImage.referenceUrl;
        }
      }
      if (state.reference_url) {
        patch.referenceUrl = state.reference_url;
      }
      if (state.output_url) {
        patch.outputUrl = state.output_url;
      }
      if (state.package_url) {
        patch.packageUrl = state.package_url;
        patch.outputMode = 'zip';
      }
      if (state.package_file_name) {
        patch.packageFileName = state.package_file_name;
      }
      if (state.package_count) {
        patch.packageCount = state.package_count;
      } else if (node.type === 'output' && Array.isArray(patch.resultItems) && patch.resultItems.length > 1) {
        patch.packageCount = patch.resultItems.length;
      }
      if (state.csv_url) {
        patch.csvUrl = state.csv_url;
      }
      if (state.error_message) {
        patch.errorMessage = state.error_message;
      } else if (state.status && state.status !== 'failed') {
        patch.errorMessage = '';
      }
      if (!Object.keys(patch).length) {
        return node;
      }
      changed = true;
      return { ...node, data: { ...node.data, ...patch } };
    });
    if (changed) {
      nodesRef.current = nextNodes;
    }
    return changed ? nextNodes : items;
  });
}

function readCanvasBatchId(runPayload) {
  return String(runPayload?.canvas_batch_id || runPayload?.canvasBatchId || '').trim();
}

function readCanvasPayloadRunId(runPayload) {
  return String(runPayload?.run_id || runPayload?.runId || '').trim();
}

function resolveCanvasImageUrls(item, fallbackImageUrl = '', fallbackDownloadUrl = '') {
  const rawImageUrl = String(item?.imageUrl || item?.image_url || fallbackImageUrl || '').trim();
  const rawReferenceUrl = String(item?.referenceUrl || item?.reference_url || '').trim();
  const rawDownloadUrl = String(
    item?.downloadUrl
    || item?.download_url
    || fallbackDownloadUrl
    || rawReferenceUrl
    || rawImageUrl
    || ''
  ).trim();
  const imageUrl = rawImageUrl || rawDownloadUrl || rawReferenceUrl;
  const downloadUrl = rawDownloadUrl || rawReferenceUrl || imageUrl;
  const referenceUrl = rawReferenceUrl || downloadUrl || imageUrl;
  return { imageUrl, downloadUrl, referenceUrl };
}

function collectCanvasEditableImageUrls(item, fallbackImageUrl = '', fallbackDownloadUrl = '') {
  const { imageUrl, downloadUrl, referenceUrl } = resolveCanvasImageUrls(item, fallbackImageUrl, fallbackDownloadUrl);
  return [imageUrl, downloadUrl, referenceUrl].filter((value, index, list) => value && list.indexOf(value) === index);
}

function buildCanvasImageOriginalVersion(item, fallbackImageUrl = '', fallbackDownloadUrl = '') {
  const { imageUrl, downloadUrl } = resolveCanvasImageUrls(item, fallbackImageUrl, fallbackDownloadUrl);
  if (!imageUrl && !downloadUrl) {
    return null;
  }
  return {
    id: 'original',
    label: '原始图',
    imageUrl: imageUrl || downloadUrl,
    downloadUrl: downloadUrl || imageUrl,
    taskId: String(item?.taskId || item?.task_id || '').trim(),
    prompt: String(item?.prompt || '').trim(),
    createdAt: '',
  };
}

function getCanvasResultItemKey(item) {
  const taskId = String(item?.taskId || item?.task_id || '').trim();
  if (taskId) {
    return `task:${taskId}`;
  }
  const jobId = String(item?.jobId || item?.job_id || item?.id || '').trim();
  if (jobId) {
    return `job:${jobId}`;
  }
  const imageUrl = String(item?.imageUrl || item?.image_url || item?.downloadUrl || item?.download_url || item?.referenceUrl || item?.reference_url || '').trim();
  if (imageUrl) {
    return `url:${imageUrl}`;
  }
  const index = Number(item?.index || 0);
  const name = String(item?.name || item?.imageCategory || item?.image_category || '').trim();
  return index || name ? `meta:${index}:${name}` : '';
}

function normalizePreviewImagePayload(itemPayload, sourceNodeId = '') {
  if (!itemPayload || typeof itemPayload !== 'object') {
    return null;
  }
  const { imageUrl, downloadUrl, referenceUrl } = resolveCanvasImageUrls(itemPayload);
  if (!imageUrl && !downloadUrl && !referenceUrl) {
    return null;
  }
  return {
    ...itemPayload,
    nodeId: String(itemPayload.nodeId || itemPayload.node_id || sourceNodeId || '').trim(),
    imageUrl,
    downloadUrl,
    referenceUrl,
    itemIndex: Number.isFinite(Number(itemPayload.itemIndex)) ? Number(itemPayload.itemIndex) : Number(itemPayload.index || 0) - 1,
    galleryIndex: Number.isFinite(Number(itemPayload.galleryIndex)) ? Number(itemPayload.galleryIndex) : -1,
    galleryItems: Array.isArray(itemPayload.galleryItems) ? itemPayload.galleryItems : [],
  };
}

function buildPreviewFallbackResultItem(node, payload = {}) {
  const data = node?.data || {};
  const primaryResultItem = Array.isArray(data.resultItems)
    ? (
        data.resultItems.find((item) => item && (
          item.imageUrl
          || item.image_url
          || item.downloadUrl
          || item.download_url
          || item.referenceUrl
          || item.reference_url
        ))
        || data.resultItems[0]
        || null
      )
    : null;
  const fallbackItem = primaryResultItem && typeof primaryResultItem === 'object'
    ? primaryResultItem
    : {};
  const { imageUrl, downloadUrl, referenceUrl } = resolveCanvasImageUrls({
    imageUrl: String(
      payload?.imageUrl
        || payload?.downloadUrl
        || payload?.referenceUrl
        || fallbackItem.imageUrl
        || fallbackItem.image_url
        || fallbackItem.downloadUrl
        || fallbackItem.download_url
        || fallbackItem.referenceUrl
        || fallbackItem.reference_url
        || data.imageUrl
        || data.referenceUrl
        || data.outputUrl
        || ''
    ).trim(),
    downloadUrl: String(
      payload?.downloadUrl
        || payload?.referenceUrl
        || fallbackItem.downloadUrl
        || fallbackItem.download_url
        || fallbackItem.referenceUrl
        || fallbackItem.reference_url
        || fallbackItem.imageUrl
        || fallbackItem.image_url
        || data.downloadUrl
        || data.referenceUrl
        || data.outputUrl
        || ''
    ).trim(),
    referenceUrl: String(
      payload?.referenceUrl
        || fallbackItem.referenceUrl
        || fallbackItem.reference_url
        || fallbackItem.downloadUrl
        || fallbackItem.download_url
        || fallbackItem.imageUrl
        || fallbackItem.image_url
        || data.referenceUrl
        || data.downloadUrl
        || data.outputUrl
        || ''
    ).trim(),
  });
  if (!imageUrl && !downloadUrl && !referenceUrl) {
    return null;
  }
  const requestPayload = fallbackItem.requestPayload && typeof fallbackItem.requestPayload === 'object'
    ? fallbackItem.requestPayload
    : (data.requestPayload && typeof data.requestPayload === 'object'
      ? data.requestPayload
      : {});
  return {
    jobId: String(fallbackItem.jobId || fallbackItem.job_id || data.jobId || payload?.jobId || '').trim(),
    nodeId: String(fallbackItem.nodeId || fallbackItem.node_id || node?.id || payload?.nodeId || '').trim(),
    taskId: String(fallbackItem.taskId || fallbackItem.task_id || data.taskId || payload?.taskId || payload?.task_id || '').trim(),
    artifactOwnerType: String(fallbackItem.artifactOwnerType || fallbackItem.artifact_owner_type || data.artifactOwnerType || data.artifact_owner_type || payload?.artifactOwnerType || payload?.artifact_owner_type || '').trim(),
    artifactOwnerNode: String(fallbackItem.artifactOwnerNode || fallbackItem.artifact_owner_node || data.artifactOwnerNode || data.artifact_owner_node || payload?.artifactOwnerNode || payload?.artifact_owner_node || '').trim(),
    executorType: String(fallbackItem.executorType || fallbackItem.executor_type || data.executorType || data.executor_type || payload?.executorType || payload?.executor_type || '').trim(),
    executorNodeId: String(fallbackItem.executorNodeId || fallbackItem.executor_node_id || data.executorNodeId || data.executor_node_id || payload?.executorNodeId || payload?.executor_node_id || '').trim(),
    status: String(fallbackItem.status || data.status || payload?.status || '').trim(),
    imageUrl,
    referenceUrl,
    downloadUrl,
    prompt: String(fallbackItem.revisedPrompt || fallbackItem.prompt || data.revisedPrompt || data.prompt || requestPayload.prompt || payload?.prompt || '').trim(),
    errorMessage: String(fallbackItem.errorMessage || fallbackItem.error_message || data.errorMessage || payload?.errorMessage || payload?.error_message || '').trim(),
    index: 1,
    name: String(fallbackItem.name || fallbackItem.label || data.label || payload?.title || '').trim(),
    imageCategory: String(fallbackItem.imageCategory || fallbackItem.image_category || payload?.imageCategory || payload?.image_category || '').trim(),
    versions: Array.isArray(fallbackItem.versions)
      ? fallbackItem.versions
      : (Array.isArray(data.versions) ? data.versions : (Array.isArray(payload?.versions) ? payload.versions : [])),
    selectedVersionId: String(
      fallbackItem.selectedVersionId
        || fallbackItem.selected_version_id
        || data.selectedVersionId
        || data.selected_version_id
        || payload?.selectedVersionId
        || payload?.selected_version_id
        || ''
    ).trim(),
  };
}

function inferCanvasResultTaskIdFromUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) {
    return '';
  }
  let path = raw;
  try {
    path = new URL(raw, window.location.href).pathname || raw;
  } catch (error) {
    path = raw.split('?')[0].split('#')[0];
  }
  const fileName = decodeURIComponent(String(path || '').split('/').pop() || '');
  const match = fileName.match(/^(canvas_img_[A-Za-z0-9]+)(?:_\d+)?\.[A-Za-z0-9]+$/);
  return match ? match[1] : '';
}

function resolveCanvasResultEditSourceTaskId(context) {
  const candidates = [
    context?.taskId,
    context?.task_id,
    context?.sourceTaskId,
    context?.source_task_id,
    inferCanvasResultTaskIdFromUrl(context?.imageUrl || context?.image_url),
    inferCanvasResultTaskIdFromUrl(context?.downloadUrl || context?.download_url),
    inferCanvasResultTaskIdFromUrl(context?.referenceUrl || context?.reference_url),
  ];
  const imageDerived = candidates.slice(4).find((item) => String(item || '').trim());
  if (imageDerived) {
    return imageDerived;
  }
  return String(candidates.find((item) => String(item || '').trim()) || '').trim();
}

function inferCanvasDataUrlMimeType(format = '') {
  const normalized = String(format || '').trim().toLowerCase();
  if (normalized === 'jpg' || normalized === 'jpeg') {
    return 'image/jpeg';
  }
  if (normalized === 'webp') {
    return 'image/webp';
  }
  if (normalized === 'gif') {
    return 'image/gif';
  }
  return 'image/png';
}

function normalizeCanvasImageTaskResponse(payload) {
  const root = payload && typeof payload === 'object' ? payload : {};
  const result = root.result && typeof root.result === 'object' && !Array.isArray(root.result)
    ? root.result
    : {};
  const body = result.body && typeof result.body === 'object' && !Array.isArray(result.body)
    ? result.body
    : {};
  const dataItems = [
    ...(Array.isArray(root.data) ? root.data : []),
    ...(Array.isArray(result.data) ? result.data : []),
    ...(Array.isArray(body.data) ? body.data : []),
  ].filter((item) => item && typeof item === 'object' && !Array.isArray(item));
  const firstItem = dataItems.find((item) => item.url || item.download_url || item.reference_url || item.b64_json) || null;
  const imageUrl = String(
    firstItem?.url
      || firstItem?.download_url
      || firstItem?.reference_url
      || root.url
      || root.download_url
      || root.reference_url
      || result.url
      || result.download_url
      || result.reference_url
      || body.url
      || body.download_url
      || body.reference_url
      || ''
  ).trim();
  const outputFormat = String(
    firstItem?.__extension_hint
      || body.output_format
      || result.output_format
      || root.output_format
      || 'png'
  ).trim();
  const b64Json = String(
    firstItem?.b64_json
      || root.b64_json
      || result.b64_json
      || body.b64_json
      || ''
  ).trim();
  const fallbackDataUrl = !imageUrl && b64Json
    ? `data:${inferCanvasDataUrlMimeType(outputFormat)};base64,${b64Json}`
    : '';
  const finalImageUrl = imageUrl || fallbackDataUrl;
  const downloadUrl = String(
    firstItem?.download_url
      || firstItem?.reference_url
      || root.download_url
      || root.reference_url
      || result.download_url
      || result.reference_url
      || body.download_url
      || body.reference_url
      || finalImageUrl
      || ''
  ).trim();
  return {
    imageUrl: finalImageUrl,
    downloadUrl: downloadUrl || finalImageUrl,
    taskId: String(root.task_id || result.task_id || '').trim(),
    status: String(root.status || result.status || '').trim(),
    queryPath: String(root.query_path || result.query_path || '').trim(),
  };
}

function normalizeCanvasImageVersions(item, fallbackImageUrl = '', fallbackDownloadUrl = '') {
  const versions = Array.isArray(item?.versions) ? item.versions : [];
  const normalized = versions
    .filter((version) => version && (version.imageUrl || version.image_url || version.downloadUrl || version.download_url))
    .map((version, index) => ({
      id: String(version.id || version.versionId || version.version_id || `version-${index + 1}`).trim(),
      label: String(version.label || version.name || `版本 ${index + 1}`).trim(),
      imageUrl: String(version.imageUrl || version.image_url || '').trim(),
      downloadUrl: String(version.downloadUrl || version.download_url || version.referenceUrl || version.reference_url || version.imageUrl || version.image_url || '').trim(),
      taskId: String(version.taskId || version.task_id || '').trim(),
      prompt: String(version.prompt || '').trim(),
      editType: String(version.editType || version.edit_type || '').trim(),
      createdAt: String(version.createdAt || version.created_at || '').trim(),
    }));
  if (!normalized.some((version) => version.id === 'original')) {
    const original = buildCanvasImageOriginalVersion(item, fallbackImageUrl, fallbackDownloadUrl);
    if (original) {
      normalized.unshift(original);
    }
  }
  return normalized;
}

function buildCanvasPackageItemFromResult(item, fallbackTitle = '') {
  const batchItem = item?.batchItem && typeof item.batchItem === 'object'
    ? item.batchItem
    : (item?.batch_item && typeof item.batch_item === 'object' ? item.batch_item : {});
  return {
    task_id: String(item?.taskId || item?.task_id || '').trim(),
    title: String(fallbackTitle || item?.name || batchItem?.name || item?.imageCategory || item?.image_category || batchItem?.image_category || batchItem?.imageCategory || '').trim(),
    prompt: String(item?.prompt || batchItem?.prompt || '').trim(),
    image_url: String(item?.imageUrl || item?.image_url || '').trim(),
    reference_url: String(item?.referenceUrl || item?.reference_url || item?.downloadUrl || item?.download_url || item?.imageUrl || item?.image_url || '').trim(),
    download_url: String(item?.downloadUrl || item?.download_url || item?.referenceUrl || item?.reference_url || item?.imageUrl || item?.image_url || '').trim(),
    artifact_owner_type: String(item?.artifactOwnerType || item?.artifact_owner_type || '').trim(),
    artifact_owner_node: String(item?.artifactOwnerNode || item?.artifact_owner_node || '').trim(),
    executor_type: String(item?.executorType || item?.executor_type || '').trim(),
    executor_node_id: String(item?.executorNodeId || item?.executor_node_id || '').trim(),
    batch_item: batchItem,
    image_category: String(item?.imageCategory || item?.image_category || batchItem?.image_category || batchItem?.imageCategory || '').trim(),
    goal: String(item?.goal || batchItem?.goal || '').trim(),
    reference_usage: String(item?.referenceUsage || item?.reference_usage || batchItem?.reference_usage || batchItem?.referenceUsage || '').trim(),
    script_text: String(item?.scriptText || item?.script_text || item?.video_script || item?.videoScript || batchItem?.script_text || batchItem?.scriptText || batchItem?.video_script || batchItem?.videoScript || '').trim(),
    shot_script: String(item?.shotScript || item?.shot_script || item?.storyboard_script || item?.storyboardScript || batchItem?.shot_script || batchItem?.shotScript || batchItem?.storyboard_script || batchItem?.storyboardScript || '').trim(),
  };
}

function mergeCanvasResultItemVersion(item, context, version, selectFinal = true) {
  const versions = normalizeCanvasImageVersions(item, context?.imageUrl, context?.downloadUrl);
  const nextVersions = versions.some((entry) => entry.id === version.id)
    ? versions.map((entry) => entry.id === version.id ? { ...entry, ...version } : entry)
    : versions.concat(version);
  const nextItem = {
    ...item,
    versions: nextVersions,
    selectedVersionId: selectFinal ? version.id : (item?.selectedVersionId || item?.selected_version_id || ''),
  };
  if (selectFinal) {
    nextItem.imageUrl = version.imageUrl;
    nextItem.referenceUrl = version.downloadUrl || version.imageUrl;
    nextItem.downloadUrl = version.downloadUrl || version.imageUrl;
    nextItem.taskId = version.taskId || nextItem.taskId;
    nextItem.prompt = version.prompt || nextItem.prompt;
  }
  return nextItem;
}

function isServerRunActiveStatus(status) {
  return ['queued', 'running', 'cancel_requested'].includes(String(status || '').trim().toLowerCase());
}

function createRunContextFromServer(plan, edges, runPayload) {
  const states = Array.isArray(runPayload?.node_states) ? runPayload.node_states : [];
  const completedNodeIds = states.filter((state) => state.status === 'done').map((state) => String(state.node_id || '')).filter(Boolean);
  const runningNodeIds = states.filter((state) => state.status === 'running').map((state) => String(state.node_id || '')).filter(Boolean);
  const failedNode = states.find((state) => state.status === 'failed');
  const context = createWorkflowRunContext(plan, edges);
  let edgeStates = context.edgeStates || {};
  if (completedNodeIds.length) {
    edgeStates = nextRunContextEdgeStates({ ...context, edgeStates }, edges, completedNodeIds, 'done', 'incoming');
  }
  if (runningNodeIds.length) {
    edgeStates = nextRunContextEdgeStates({ ...context, edgeStates }, edges, runningNodeIds, 'active', 'incoming');
  }
  const rawStatus = String(runPayload?.status || '').trim().toLowerCase();
  const status = rawStatus === 'completed'
    ? 'done'
    : rawStatus === 'failed'
      ? 'failed'
      : rawStatus === 'cancelled' || rawStatus === 'canceled' || rawStatus === 'cancel_requested'
        ? 'stopped'
        : 'running';
  return {
    ...context,
    status,
    currentNodeIds: runningNodeIds,
    completedNodeIds,
    failedNodeId: failedNode ? String(failedNode.node_id || '') : '',
    edgeStates,
  };
}

function appendServerRunHistory(setHistory, payload, seenRef) {
  const items = Array.isArray(payload?.history) ? payload.history : [];
  items.forEach((item) => {
    const key = `${item.time || ''}|${item.job_id || ''}|${item.message || ''}`;
    if (!item?.message || seenRef.current.has(key)) {
      return;
    }
    seenRef.current.add(key);
    appendHistory(setHistory, item.message);
  });
}

function getValidationFocusNodeId(issues = [], nodes = []) {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  for (const issue of issues) {
    const relatedItems = [
      ...(issue.promptMessages || []),
      ...(issue.relatedMessages || []),
    ];
    for (const related of relatedItems) {
      const node = nodeById.get(related.nodeId);
      if (node && VALIDATION_FOCUS_NODE_TYPES.has(node.type)) {
        return node.id;
      }
    }
  }

  for (const issue of issues) {
    const node = nodeById.get(issue.nodeId);
    if (node && node.type !== 'generate') {
      return node.id;
    }
  }

  return '';
}

function getMultipleImageExplosionConnectionIssue(connection, nodes = [], edges = []) {
  const sourceId = String(connection?.source || '');
  const targetId = String(connection?.target || '');
  if (!sourceId || !targetId) {
    return '';
  }

  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const sourceNode = nodeById.get(sourceId);
  const targetNode = nodeById.get(targetId);
      if (!['imageExplosion', 'ecommerceImage'].includes(sourceNode?.type) || targetNode?.type !== 'generate') {
    return '';
  }

  const existingSource = edges.find((edge) => {
    const existingSourceId = String(edge.source || '');
    return String(edge.target || '') === targetId
      && existingSourceId !== sourceId
      && ['imageExplosion', 'ecommerceImage'].includes(nodeById.get(existingSourceId)?.type);
  });
  if (!existingSource) {
    return '';
  }

  return `生成图片节点【${displayNodeLabel(targetNode.type, targetNode.data)}】已经连接了会输出多张图片的节点，不能再连接另一个同类节点。请拆成多个生成节点分别处理。`;
}

function getConnectionRuleIssue(connection, nodes = []) {
  const sourceId = String(connection?.source || '');
  const targetId = String(connection?.target || '');
  if (!sourceId || !targetId) {
    return '';
  }

  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const sourceNode = nodeById.get(sourceId);
  const targetNode = nodeById.get(targetId);
  if (!sourceNode || !targetNode) {
    return '';
  }

  const sourceType = String(sourceNode.type || '');
  const targetType = String(targetNode.type || '');

  if (['prompt', 'batchPrompt', 'reference', 'localReference'].includes(targetType)) {
    return `节点【${displayNodeLabel(targetNode.type, targetNode.data)}】不能作为下游目标节点接收连线。`;
  }

  if (targetType === 'output' && !['generate', 'imageExplosion', 'ecommerceImage'].includes(sourceType)) {
    return `输出节点【${displayNodeLabel(targetNode.type, targetNode.data)}】只能直接连接生成图片节点、图片大爆炸节点或电商图节点。`;
  }

  if (targetType === 'generate') {
    const allowedSourceTypes = ['prompt', 'batchPrompt', 'reference', 'localReference', 'generate', 'imageExplosion', 'ecommerceImage'];
    if (!allowedSourceTypes.includes(sourceType)) {
      return `生成图片节点【${displayNodeLabel(targetNode.type, targetNode.data)}】不能连接节点【${displayNodeLabel(sourceNode.type, sourceNode.data)}】。`;
    }
  }

  if (targetType === 'imageExplosion') {
    const allowedSourceTypes = ['reference', 'localReference', 'generate', 'imageExplosion', 'ecommerceImage'];
    if (!allowedSourceTypes.includes(sourceType)) {
      return `图片大爆炸节点【${displayNodeLabel(targetNode.type, targetNode.data)}】只能连接带图片的前置节点。`;
    }
  }

  if (targetType === 'ecommerceImage') {
    const allowedSourceTypes = ['reference', 'localReference', 'generate', 'imageExplosion', 'ecommerceImage'];
    if (!allowedSourceTypes.includes(sourceType)) {
      return `电商图节点【${displayNodeLabel(targetNode.type, targetNode.data)}】只能连接商品参考图或上游生成图片。`;
    }
  }

  return '';
}

function getCreatableConnectionTargetTypes(sourceId, nodes = [], edges = []) {
  const normalizedSourceId = String(sourceId || '');
  if (!normalizedSourceId) {
    return [];
  }

  const hasOutputNode = nodes.some((node) => node.type === 'output');
  const candidateTypes = ['reference', 'localReference', 'generate', 'imageExplosion', 'ecommerceImage', 'output'];

  return candidateTypes.filter((type) => {
    if (type === 'output' && hasOutputNode) {
      return false;
    }

    const probeNode = {
      id: `__probe__${type}`,
      type,
      data: createDefaultData(type),
      position: { x: 0, y: 0 },
    };
    const candidateNodes = nodes.concat(probeNode);
    const connection = { source: normalizedSourceId, target: probeNode.id };

    if (getConnectionRuleIssue(connection, candidateNodes)) {
      return false;
    }

    if (getMultipleImageExplosionConnectionIssue(connection, candidateNodes, edges)) {
      return false;
    }

    return true;
  });
}

function nodeHasReusableCanvasResult(node) {
  if (!node || !['generate', 'imageExplosion', 'ecommerceImage'].includes(node.type)) {
    return false;
  }
  const data = node.data || {};
  if (Array.isArray(data.resultItems) && data.resultItems.some((item) => item && (item.imageUrl || item.image_url || item.downloadUrl || item.referenceUrl || item.reference_url))) {
    return true;
  }
  return Boolean(String(data.imageUrl || data.referenceUrl || '').trim());
}

function collectDownstreamCanvasResultNodeIds(sourceNodeId, nodes, edges) {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const outgoingByNodeId = new Map();
  edges.forEach((edge) => {
    if (!outgoingByNodeId.has(edge.source)) {
      outgoingByNodeId.set(edge.source, []);
    }
    outgoingByNodeId.get(edge.source).push(edge.target);
  });

  const queue = [sourceNodeId];
  const visited = new Set();
  const affected = [];
  while (queue.length) {
    const currentId = queue.shift();
    if (!currentId || visited.has(currentId)) {
      continue;
    }
    visited.add(currentId);
    const node = nodeById.get(currentId);
    if (node && ['generate', 'imageExplosion', 'ecommerceImage', 'output'].includes(node.type)) {
      affected.push(currentId);
    }
    const outgoing = outgoingByNodeId.get(currentId) || [];
    outgoing.forEach((targetId) => {
      if (!visited.has(targetId)) {
        queue.push(targetId);
      }
    });
  }
  return affected;
}

function isAbortError(error) {
  return error?.name === 'AbortError' || String(error?.message || '').includes('中断');
}

function throwIfWorkflowAborted(signal) {
  if (signal?.aborted) {
    throw new DOMException('画布运行已中断。', 'AbortError');
  }
}

function waitForWorkflow(ms, signal = null) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('画布运行已中断。', 'AbortError'));
      return;
    }
    const timer = window.setTimeout(resolve, ms);
    if (signal) {
      signal.addEventListener('abort', () => {
        window.clearTimeout(timer);
        reject(new DOMException('画布运行已中断。', 'AbortError'));
      }, { once: true });
    }
  });
}

function createAuthFormState() {
  return {
    username: '',
    email: '',
    account: '',
    password: '',
    confirmPassword: '',
  };
}

function createPasswordFormState() {
  return {
    currentPassword: '',
    nextPassword: '',
    confirmPassword: '',
  };
}

function createFinanceLedgerState() {
  return {
    loading: false,
    error: '',
    rows: [],
    generatedAt: 0,
    currentBalanceYuan: 0,
    todaySpentYuan: 0,
    yesterdaySpentYuan: 0,
    windowHours: 48,
    page: 1,
    pageSize: 10,
    total: 0,
    totalPages: 1,
  };
}

function createApiKeyListState() {
  return {
    loading: false,
    error: '',
    apiKeys: [],
    defaultApiKeyId: '',
  };
}

function createApiKeySettingsState(config) {
  const settings = config?.userControl?.apiKeySettings && typeof config.userControl.apiKeySettings === 'object'
    ? config.userControl.apiKeySettings
    : {};
  return {
    imageRoutingMode: String(settings.imageRoutingMode || 'smart_failover').trim() || 'smart_failover',
    fixedImageProviderId: String(settings.fixedImageProviderId || '').trim(),
    fixedImageProviderIds: Array.isArray(settings.fixedImageProviderIds)
      ? settings.fixedImageProviderIds.map((item) => String(item || '').trim()).filter(Boolean)
      : [],
    fixedImageProviderName: String(settings.fixedImageProviderName || '').trim(),
    fixedImageFlatPrice: Math.max(0, Number(settings.fixedImageFlatPrice || 0)),
    maxImageQuality: String(settings.maxImageQuality || 'high').trim() || 'high',
    maxConcurrency: Number(settings.maxConcurrency || config?.maxConcurrentGenerations || 10),
  };
}

function createUpstreamPreferenceState(config) {
  const preference = config?.userControl?.upstreamPreference && typeof config.userControl.upstreamPreference === 'object'
    ? config.userControl.upstreamPreference
    : {};
  const isLocalSettingsMode = String(config?.userControl?.entryMode || '').trim() === 'settings';
  return {
    mode: isLocalSettingsMode
      ? 'user_supplied'
      : (String(preference.mode || 'shared_platform').trim() || 'shared_platform'),
    imageApiKind: isLocalSettingsMode
      ? 'images_endpoint'
      : (String(preference.imageApiKind || 'images_endpoint').trim() || 'images_endpoint'),
    imagesBaseUrl: String(preference.imagesBaseUrl || '').trim(),
    imagesGenerationsUrl: String(preference.imagesGenerationsUrl || '').trim(),
    imagesEditsUrl: String(preference.imagesEditsUrl || '').trim(),
    imagesApiKey: String(preference.imagesApiKey || '').trim(),
    chatBaseUrl: String(preference.chatBaseUrl || '').trim(),
    chatApiKey: String(preference.chatApiKey || '').trim(),
    preferredAuthMode: String(preference.preferredAuthMode || 'bearer').trim() || 'bearer',
    chatFallbackMode: String(preference.chatFallbackMode || 'platform_fallback').trim() || 'platform_fallback',
    hasImagesApiKey: Boolean(preference.hasImagesApiKey),
    hasChatApiKey: Boolean(preference.hasChatApiKey),
  };
}

function getImageApiKindLabel(kind) {
  return String(kind || '').trim() === 'responses_endpoint'
    ? 'Responses Endpoint'
    : 'Images Endpoint';
}

function getImageApiUrlPlaceholder(kind) {
  return String(kind || '').trim() === 'responses_endpoint'
    ? 'https://api.example.com/v1/responses'
    : 'https://api.example.com/v1/images/generations';
}

function getUpstreamModeTitle(mode) {
  return String(mode || '').trim() === 'user_supplied'
    ? '当前会使用你填写的上游 API'
    : '当前使用平台/后台默认线路';
}

function hasConfiguredImageEndpoint(value) {
  if (!value || typeof value !== 'object') {
    return false;
  }
  return Boolean(
    String(value.imagesBaseUrl || '').trim()
      || String(value.imagesGenerationsUrl || '').trim()
      || String(value.imagesEditsUrl || '').trim(),
  );
}

function isUserSuppliedPreferenceReady(value) {
  if (!value || typeof value !== 'object') {
    return false;
  }
  return hasConfiguredImageEndpoint(value) && Boolean(String(value.imagesApiKey || '').trim());
}

function filterNodeTypesForLocalMode(types = [], isLocalMode = false) {
  if (!isLocalMode) {
    return Array.isArray(types) ? types : [];
  }
  return (Array.isArray(types) ? types : []).filter((type) => isLocalBrowserSupportedNodeType(type));
}

function formatFinanceAmountYuan(value) {
  const amount = Number(value || 0);
  return `¥${amount.toFixed(5).replace(/\.?0+$/, '')}`;
}

function formatFinanceLedgerTime(value) {
  const timestamp = Number(value || 0);
  if (!timestamp) {
    return '--';
  }
  return new Date(timestamp).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatQualityCapLabel(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'low') {
    return '低画质';
  }
  if (normalized === 'medium') {
    return '中画质';
  }
  return '高画质';
}

function formatQualityValue(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'low') {
    return '低';
  }
  if (normalized === 'medium') {
    return '中';
  }
  if (normalized === 'high') {
    return '高';
  }
  return '自动';
}

function buildCanvasImagePricingCards(config) {
  const rows = Array.isArray(config?.userControl?.imagePricingMatrix)
    ? config.userControl.imagePricingMatrix
    : [];
  const qualityOrder = ['auto', 'low', 'medium', 'high'];
  const byKey = new Map(rows.map((row) => [`${row.tier}:${row.quality}`, Number(row.price || 0)]));
  return ['1k', '2k', '4k'].map((tier) => ({
    tier,
    prices: qualityOrder.map((quality) => ({
      quality,
      price: Number(byKey.get(`${tier}:${quality}`) || 0),
    })),
  }));
}

async function copyPlainText(value) {
  const text = String(value || '').trim();
  if (!text) {
    throw new Error('没有可复制的内容。');
  }
  if (navigator?.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const input = document.createElement('textarea');
  input.value = text;
  input.setAttribute('readonly', 'readonly');
  input.style.position = 'fixed';
  input.style.opacity = '0';
  document.body.appendChild(input);
  input.select();
  document.execCommand('copy');
  document.body.removeChild(input);
}

export default function App() {
  const [rootConfig, setRootConfig] = useState(() => readCanvasConfig());
  const initialWorkflow = useMemo(() => readCachedWorkflow(rootConfig), []);
  const nodeTypes = useMemo(() => NODE_TYPES, []);
  const [nodes, setNodes, onNodesChange] = useNodesState(initialWorkflow.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialWorkflow.edges);
  const [canvasId, setCanvasId] = useState(initialWorkflow.canvasId);
  const [selectedNodeId, setSelectedNodeId] = useState(initialWorkflow.selectedNodeId);
  const [selectedEdgeId, setSelectedEdgeId] = useState('');
  const [createMenu, setCreateMenu] = useState(null);
  const [linkMenu, setLinkMenu] = useState(null);
  const [dropActive, setDropActive] = useState(false);
  const [history, setHistory] = useState([]);
  const [previewImage, setPreviewImage] = useState(null);
  const [resultGallery, setResultGallery] = useState(null);
  const [editorNodeId, setEditorNodeId] = useState('');
  const [localEditorNodeId, setLocalEditorNodeId] = useState('');
  const [batchPromptDialog, setBatchPromptDialog] = useState(null);
  const [userModalMode, setUserModalMode] = useState('');
  const [userManageTab, setUserManageTab] = useState('api');
  const [authForm, setAuthForm] = useState(() => createAuthFormState());
  const [passwordForm, setPasswordForm] = useState(() => createPasswordFormState());
  const [upstreamPreferenceForm, setUpstreamPreferenceForm] = useState(() => createUpstreamPreferenceState(readCanvasConfig()));
  const [apiKeySettingsForm, setApiKeySettingsForm] = useState(() => createApiKeySettingsState(readCanvasConfig()));
  const [financeLedgerState, setFinanceLedgerState] = useState(() => createFinanceLedgerState());
  const [apiKeyListState, setApiKeyListState] = useState(() => createApiKeyListState());
  const [userActionPending, setUserActionPending] = useState(false);
  const [userModalError, setUserModalError] = useState('');
  const [userModalSuccess, setUserModalSuccess] = useState('');
  const [workflowRunning, setWorkflowRunning] = useState(false);
  const [workflowRunContext, setWorkflowRunContext] = useState(null);
  const [snapToGridEnabled, setSnapToGridEnabled] = useState(false);
  const uploadInputRef = useRef(null);
  const uploadTargetRef = useRef('');
  const batchPromptInputRef = useRef(null);
  const batchPromptTargetRef = useRef('');
  const flowRef = useRef(null);
  const connectStartRef = useRef(null);
  const connectSucceededRef = useRef(false);
  const canvasIdRef = useRef(initialWorkflow.canvasId);
  const nodesRef = useRef(initialWorkflow.nodes);
  const edgesRef = useRef(initialWorkflow.edges);
  const [workflowCacheKey, setWorkflowCacheKey] = useState(() => getCanvasCacheKey(rootConfig));
  const workflowCacheKeyRef = useRef(workflowCacheKey);
  const cacheHydratedRef = useRef(false);
  const workflowRunningRef = useRef(false);
  const runAbortRef = useRef(null);
  const serverRunIdRef = useRef('');
  const activeCanvasBatchIdRef = useRef('');
  const workflowRunContextRef = useRef(null);

  const updateWorkflowRunContext = useCallback((updater) => {
    setWorkflowRunContext((current) => {
      const next = typeof updater === 'function' ? updater(current) : updater;
      workflowRunContextRef.current = next;
      return next;
    });
  }, []);

  const refreshCanvasSession = useCallback(async () => {
    try {
      const payload = await fetchCanvasSessionConfig(rootConfig);
      if (!payload || typeof payload !== 'object') {
        return;
      }
      setRootConfig((current) => mergeCanvasSessionConfig(current, payload));
    } catch (error) {
      // Keep the current session snapshot when the refresh request fails.
    }
  }, [rootConfig]);

  const syncUserPreferenceForm = useCallback((config) => {
    setUpstreamPreferenceForm(createUpstreamPreferenceState(config));
    setApiKeySettingsForm(createApiKeySettingsState(config));
  }, []);

  const closeUserModal = useCallback(() => {
    setUserModalMode('');
    setUserManageTab('api');
    setUserActionPending(false);
    setUserModalError('');
    setUserModalSuccess('');
    setFinanceLedgerState(createFinanceLedgerState());
    setApiKeyListState(createApiKeyListState());
    setAuthForm(createAuthFormState());
    setPasswordForm(createPasswordFormState());
    syncUserPreferenceForm(rootConfig);
  }, [rootConfig, syncUserPreferenceForm]);

  const loadFinanceLedger = useCallback(async (targetPage = 1) => {
    if (!rootConfig?.isLoggedIn || !rootConfig?.userControl?.financeLedgerEndpoint) {
      setFinanceLedgerState(createFinanceLedgerState());
      return;
    }
    setFinanceLedgerState((current) => ({
      ...current,
      loading: true,
      error: '',
    }));
    try {
      const payload = await getCanvasUserFinanceLedger(rootConfig, {
        windowHours: 48,
        page: targetPage,
        pageSize: 10,
      });
      setFinanceLedgerState({
        loading: false,
        error: '',
        rows: Array.isArray(payload?.rows) ? payload.rows : [],
        generatedAt: Number(payload?.generatedAt || 0),
        currentBalanceYuan: Number(payload?.currentBalanceYuan || 0),
        todaySpentYuan: Number(payload?.todaySpentYuan || 0),
        yesterdaySpentYuan: Number(payload?.yesterdaySpentYuan || 0),
        windowHours: Math.max(1, Number(payload?.windowHours || 48)),
        page: Math.max(1, Number(payload?.page || targetPage || 1)),
        pageSize: Math.max(1, Number(payload?.pageSize || 10)),
        total: Math.max(0, Number(payload?.total || 0)),
        totalPages: Math.max(1, Number(payload?.totalPages || 1)),
      });
    } catch (error) {
      setFinanceLedgerState((current) => ({
        ...current,
        loading: false,
        error: error?.message || '加载余额流水失败。',
      }));
    }
  }, [rootConfig]);

  const loadCanvasUserApiKeys = useCallback(async () => {
    if (!rootConfig?.isLoggedIn || !rootConfig?.userControl?.apiKeysEndpoint) {
      setApiKeyListState(createApiKeyListState());
      return;
    }
    setApiKeyListState((current) => ({ ...current, loading: true, error: '' }));
    try {
      const payload = await getCanvasUserApiKeys(rootConfig);
      const apiKeys = Array.isArray(payload?.apiKeys)
        ? payload.apiKeys.map((item) => ({
            id: String(item?.id || '').trim(),
            name: String(item?.name || '未命名密钥').trim() || '未命名密钥',
            status: String(item?.status || 'disabled').trim(),
            maskedKey: String(item?.maskedKey || '').trim(),
            rawKey: String(item?.rawKey || '').trim(),
            isDefault: Boolean(item?.isDefault),
            imagePricingMode: String(item?.imagePricingMode || 'pricing_matrix').trim(),
            fixedImageFlatPrice: Math.max(0, Number(item?.fixedImageFlatPrice || 0)),
          })).filter((item) => item.id)
        : [];
      setApiKeyListState({
        loading: false,
        error: '',
        apiKeys,
        defaultApiKeyId: String(payload?.defaultApiKeyId || '').trim(),
      });
    } catch (error) {
      setApiKeyListState((current) => ({
        ...current,
        loading: false,
        error: error?.message || '加载 API 密钥列表失败。',
      }));
    }
  }, [rootConfig]);

  const openLoginModal = useCallback(() => {
    setUserModalMode('login');
    setUserModalError('');
    setUserModalSuccess('');
    setAuthForm(createAuthFormState());
  }, []);

  const openRegisterModal = useCallback(() => {
    setUserModalMode('register');
    setUserModalError('');
    setUserModalSuccess('');
    setAuthForm(createAuthFormState());
  }, []);

  const openManageModal = useCallback(() => {
    setUserModalMode('manage');
    setUserManageTab('api');
    setUserModalError('');
    setUserModalSuccess('');
    setPasswordForm(createPasswordFormState());
    syncUserPreferenceForm(rootConfig);
    void loadFinanceLedger(1);
    void loadCanvasUserApiKeys();
  }, [loadCanvasUserApiKeys, loadFinanceLedger, rootConfig, syncUserPreferenceForm]);

  const openSettingsModal = useCallback(() => {
    setUserModalMode('settings');
    setUserModalError('');
    setUserModalSuccess('');
    syncUserPreferenceForm(rootConfig);
  }, [rootConfig, syncUserPreferenceForm]);

  const userDisplayName = String(rootConfig.currentUsername || rootConfig.currentUserEmail || '用户').trim();
  const generatedGatewayApiKey = String(rootConfig.authToken || '').trim();
  const canvasUserApiKeys = apiKeyListState.apiKeys;
  const isSettingsEntryMode = String(rootConfig?.userControl?.entryMode || '').trim() === 'settings';
  const gatewayImagesGenerationsEndpoint = String(rootConfig?.userControl?.imagesGenerationsEndpoint || '').trim();
  const gatewayImagesEditsEndpoint = String(rootConfig?.userControl?.imagesEditsEndpoint || '').trim();
  const gatewayChatCompletionsEndpoint = String(rootConfig?.userControl?.chatCompletionsEndpoint || '').trim();
  const imagePricingCards = useMemo(() => buildCanvasImagePricingCards(rootConfig), [rootConfig]);
  const isFixedImageRoutingMode = apiKeySettingsForm.imageRoutingMode === 'fixed_provider';
  const hasFixedImageFlatPrice = isFixedImageRoutingMode && Number(apiKeySettingsForm.fixedImageFlatPrice || 0) > 0;
  const userEntryButtonLabel = isSettingsEntryMode
    ? '本地设置'
    : (rootConfig.isLoggedIn ? '登录设置' : '登录 / 注册');

  useEffect(() => {
    nodesRef.current = nodes;
  }, [nodes]);

  useEffect(() => {
    let cancelled = false;
    fetchCanvasSessionConfig(rootConfig)
      .then((payload) => {
        if (!cancelled && payload && typeof payload === 'object') {
          setRootConfig((current) => mergeCanvasSessionConfig(current, payload));
        }
      })
      .catch(() => {
        // The server still validates access and runtime policy; keep the rendered config as fallback.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    edgesRef.current = edges;
  }, [edges]);

  useEffect(() => {
    canvasIdRef.current = canvasId;
  }, [canvasId]);

  useEffect(() => {
    syncUserPreferenceForm(rootConfig);
  }, [rootConfig, syncUserPreferenceForm]);

  useEffect(() => {
    const nextCacheKey = getCanvasCacheKey(rootConfig);
    if (workflowCacheKeyRef.current === nextCacheKey) {
      return;
    }

    const nextWorkflow = readCachedWorkflow(rootConfig);
    workflowCacheKeyRef.current = nextCacheKey;
    nodesRef.current = nextWorkflow.nodes;
    edgesRef.current = nextWorkflow.edges;
    serverRunIdRef.current = '';
    activeCanvasBatchIdRef.current = '';
    workflowRunContextRef.current = null;
    setWorkflowRunContext(null);
    setNodes(nextWorkflow.nodes);
    setEdges(nextWorkflow.edges);
    canvasIdRef.current = nextWorkflow.canvasId;
    setCanvasId(nextWorkflow.canvasId);
    setSelectedNodeId(nextWorkflow.selectedNodeId || '');
    setSelectedEdgeId('');
    setCreateMenu(null);
    setLinkMenu(null);
    setWorkflowCacheKey(nextCacheKey);
  }, [rootConfig, setEdges, setNodes]);

  useEffect(() => {
    if (
      workflowCacheKey !== getCanvasCacheKey(rootConfig)
      || isSettingsEntryMode
      || !rootConfig.canvasRunStatusEndpoint
      || !canvasId
      || workflowRunningRef.current
    ) {
      return;
    }
    let cancelled = false;
    const abortController = new AbortController();
    const seenHistoryRef = { current: new Set() };

    (async () => {
      const payload = await getCanvasWorkflowRunStatus(rootConfig, '', { canvasId, signal: abortController.signal }).catch(() => null);
      if (cancelled || !payload || !Array.isArray(payload.node_states)) {
        return;
      }
      serverRunIdRef.current = readCanvasPayloadRunId(payload) || serverRunIdRef.current;
      activeCanvasBatchIdRef.current = readCanvasBatchId(payload);
      applyServerRunPayloadToNodes(payload, setNodes, nodesRef);
      appendServerRunHistory(setHistory, payload, seenHistoryRef);

      let plan = [];
      try {
        plan = buildRunnableExecutionPlan(nodesRef.current, edgesRef.current);
        updateWorkflowRunContext(createRunContextFromServer(plan, edgesRef.current, payload));
      } catch (error) {
        plan = [];
      }

      if (!isServerRunActiveStatus(payload.status)) {
        return;
      }

      const runId = String(payload.run_id || '');
      if (!runId) {
        return;
      }
      serverRunIdRef.current = runId;
      runAbortRef.current = abortController;
      workflowRunningRef.current = true;
      setWorkflowRunning(true);
      appendHistory(setHistory, '检测到当前画布有服务端运行记录，已继续同步运行状态。');

      let latest = payload;
      try {
        while (!cancelled && !abortController.signal.aborted && isServerRunActiveStatus(latest.status)) {
          await waitForWorkflow(Number(rootConfig.pollIntervalMs || 2500), abortController.signal);
          throwIfWorkflowAborted(abortController.signal);
          latest = await getCanvasWorkflowRunStatus(rootConfig, runId, { signal: abortController.signal });
          activeCanvasBatchIdRef.current = readCanvasBatchId(latest) || activeCanvasBatchIdRef.current;
          appendServerRunHistory(setHistory, latest, seenHistoryRef);
          applyServerRunPayloadToNodes(latest, setNodes, nodesRef);
          if (plan.length) {
            updateWorkflowRunContext(createRunContextFromServer(plan, edgesRef.current, latest));
          }
        }
        if (!cancelled && String(latest.status || '') === 'completed') {
          updateWorkflowRunContext((current) => current ? { ...current, status: 'done', currentNodeIds: [] } : current);
          appendHistory(setHistory, '画布运行已完成。');
        } else if (!cancelled && String(latest.status || '') === 'failed') {
          updateWorkflowRunContext((current) => current ? { ...current, status: 'failed', currentNodeIds: [] } : current);
          appendHistory(setHistory, latest.error_message || '画布运行异常停止。');
        }
      } catch (error) {
        if (!cancelled && !isAbortError(error)) {
          appendHistory(setHistory, error?.message || '画布运行状态同步失败。');
        }
      } finally {
        if (!cancelled) {
          refreshCanvasSession();
        }
        if (runAbortRef.current === abortController) {
          runAbortRef.current = null;
        }
        workflowRunningRef.current = false;
        setWorkflowRunning(false);
      }
    })();

    return () => {
      cancelled = true;
      abortController.abort();
    };
  }, [canvasId, isSettingsEntryMode, refreshCanvasSession, rootConfig, rootConfig.canvasRunStatusEndpoint, rootConfig.pollIntervalMs, setNodes, updateWorkflowRunContext, workflowCacheKey]);
  useEffect(() => {
    if (!referenceOrdersNeedNormalization(nodesRef.current)) {
      return;
    }
    setNodes((items) => {
      const nextNodes = normalizeReferenceOrders(items);
      nodesRef.current = nextNodes;
      return nextNodes;
    });
  }, [nodes, setNodes]);

  useEffect(() => {
    if (workflowCacheKey !== getCanvasCacheKey(rootConfig)) {
      return;
    }
    if (!cacheHydratedRef.current) {
      cacheHydratedRef.current = true;
      return;
    }
    writeCachedWorkflow(rootConfig, nodes, edges, selectedNodeId, canvasId);
  }, [canvasId, edges, nodes, rootConfig, selectedNodeId, workflowCacheKey]);

  useEffect(() => {
    const requirements = getOutputModeRequirements(nodes, edges).filter((item) => item.requiresZip);
    if (!requirements.length) {
      return;
    }
    const lockedIds = new Set(requirements.map((item) => item.nodeId));
    setNodes((items) => {
      let changed = false;
      const nextNodes = items.map((node) => {
        if (!lockedIds.has(node.id) || node.data?.outputMode === 'zip') {
          return node;
        }
        changed = true;
        return {
          ...node,
          data: {
            ...node.data,
            outputMode: 'zip',
            outputUrl: '',
          },
        };
      });
      if (changed) {
        nodesRef.current = nextNodes;
      }
      return changed ? nextNodes : items;
    });
  }, [edges, nodes, setNodes]);

  const selectedNode = useMemo(
    () => nodes.find((node) => node.id === selectedNodeId) || null,
    [nodes, selectedNodeId]
  );

  const selectedOutputGeneratedInputCount = useMemo(
    () => selectedNode?.type === 'output' ? getOutputGeneratedInputCount(selectedNode.id, nodes, edges) : 0,
    [edges, nodes, selectedNode]
  );

  const outputRequirementsByNode = useMemo(
    () => new Map(getOutputModeRequirements(nodes, edges).map((item) => [item.nodeId, item])),
    [edges, nodes]
  );

  const selectedOutputRequiresZip = selectedNode?.type === 'output'
    ? Boolean(outputRequirementsByNode.get(selectedNode.id)?.requiresZip)
    : false;

  const batchContextsByNode = useMemo(
    () => getBatchContextsByNode(nodes, edges),
    [edges, nodes]
  );

  const imageGroupContextsByNode = useMemo(
    () => getImageGroupContextsByNode(nodes, edges),
    [edges, nodes]
  );

  const accessViewState = useMemo(
    () => (String(rootConfig?.userControl?.entryMode || '').trim() === 'settings'
      ? {
          showAccessAlert: false,
          accessTitle: '',
          accessMessage: '',
          accessHref: '',
          accessCta: '',
        }
      : buildCanvasAccessViewState(rootConfig)),
    [rootConfig]
  );

  const handleUserAuthSubmit = useCallback(async (event) => {
    event.preventDefault();
    if (!rootConfig?.userControl?.enabled) {
      setUserModalError('当前画布暂未启用用户中心。');
      return;
    }
    if (userModalMode === 'register') {
      if (!String(authForm.username || '').trim()) {
        setUserModalError('请输入用户名。');
        return;
      }
      if (!String(authForm.email || '').trim()) {
        setUserModalError('请输入邮箱。');
        return;
      }
      if (!String(authForm.password || '').trim()) {
        setUserModalError('请输入密码。');
        return;
      }
      if (String(authForm.password || '') !== String(authForm.confirmPassword || '')) {
        setUserModalError('两次输入的密码不一致。');
        return;
      }
    } else if (!String(authForm.account || '').trim() || !String(authForm.password || '').trim()) {
      setUserModalError('请输入账号和密码。');
      return;
    }

    setUserActionPending(true);
    setUserModalError('');
    setUserModalSuccess('');
    try {
      if (userModalMode === 'register') {
        await registerCanvasUser(rootConfig, {
          username: String(authForm.username || '').trim(),
          email: String(authForm.email || '').trim(),
          password: String(authForm.password || ''),
        });
      } else {
        await loginCanvasUser(rootConfig, {
          account: String(authForm.account || '').trim(),
          password: String(authForm.password || ''),
        });
      }
      await refreshCanvasSession();
      setAuthForm(createAuthFormState());
      setPasswordForm(createPasswordFormState());
      setUserModalMode('manage');
      setUserModalSuccess(userModalMode === 'register' ? '注册并登录成功。' : '登录成功。');
      appendHistory(setHistory, userModalMode === 'register' ? '用户已注册并登录。' : '用户已登录。');
    } catch (error) {
      setUserModalError(error?.message || (userModalMode === 'register' ? '注册失败。' : '登录失败。'));
    } finally {
      setUserActionPending(false);
    }
  }, [authForm, refreshCanvasSession, rootConfig, userModalMode]);

  const handleUserLogout = useCallback(async () => {
    setUserActionPending(true);
    setUserModalError('');
    setUserModalSuccess('');
    try {
      await logoutCanvasUser(rootConfig);
      await refreshCanvasSession();
      closeUserModal();
      appendHistory(setHistory, '用户已退出登录。');
    } catch (error) {
      setUserModalError(error?.message || '退出登录失败。');
      setUserActionPending(false);
    }
  }, [closeUserModal, refreshCanvasSession, rootConfig]);

  const handleChangePassword = useCallback(async (event) => {
    event.preventDefault();
    if (!String(passwordForm.currentPassword || '').trim() || !String(passwordForm.nextPassword || '').trim()) {
      setUserModalError('请完整填写密码信息。');
      return;
    }
    if (String(passwordForm.nextPassword || '') !== String(passwordForm.confirmPassword || '')) {
      setUserModalError('两次输入的新密码不一致。');
      return;
    }
    setUserActionPending(true);
    setUserModalError('');
    setUserModalSuccess('');
    try {
      await changeCanvasUserPassword(rootConfig, {
        currentPassword: String(passwordForm.currentPassword || ''),
        nextPassword: String(passwordForm.nextPassword || ''),
      });
      setPasswordForm(createPasswordFormState());
      setUserModalSuccess('密码修改成功。');
      appendHistory(setHistory, '用户已修改登录密码。');
    } catch (error) {
      setUserModalError(error?.message || '修改密码失败。');
    } finally {
      setUserActionPending(false);
    }
  }, [passwordForm, rootConfig]);

  const handleSaveUpstreamPreference = useCallback(async (event) => {
    event.preventDefault();
    const isLocalSettingsMode = String(rootConfig?.userControl?.entryMode || '').trim() === 'settings';
    if (!isLocalSettingsMode) {
      setUserModalError('登录模式不提供上游接口设置。请切换到本地模式后，在当前浏览器中配置。');
      return;
    }
    const normalizedPreference = {
      mode: 'user_supplied',
      imageApiKind: 'images_endpoint',
      imagesBaseUrl: '',
      imagesGenerationsUrl: String(upstreamPreferenceForm.imagesGenerationsUrl || '').trim(),
      imagesEditsUrl: String(upstreamPreferenceForm.imagesEditsUrl || '').trim(),
      imagesApiKey: String(upstreamPreferenceForm.imagesApiKey || '').trim(),
      chatBaseUrl: String(upstreamPreferenceForm.chatBaseUrl || '').trim(),
      chatApiKey: String(upstreamPreferenceForm.chatApiKey || '').trim(),
      preferredAuthMode: upstreamPreferenceForm.preferredAuthMode || 'bearer',
      chatFallbackMode: 'strict_user',
    };
    if (!hasConfiguredImageEndpoint(normalizedPreference)) {
      setUserModalError('请至少填写文生图或图生图的完整地址。');
      return;
    }
    if (!normalizedPreference.imagesApiKey) {
      setUserModalError('请填写 Images Endpoint 密钥。');
      return;
    }
    setUserActionPending(true);
    setUserModalError('');
    setUserModalSuccess('');
    try {
      const savedPreference = writeLocalCanvasUpstreamPreference(normalizedPreference);
      if (!savedPreference) {
        throw new Error('本地接口设置保存失败。');
      }
      setRootConfig((current) => ({
        ...current,
        canvasExecutionSource: 'user_supplied',
        userControl: current?.userControl
          ? {
              ...current.userControl,
              upstreamPreference: {
                ...savedPreference,
                hasImagesApiKey: Boolean(String(savedPreference.imagesApiKey || '').trim()),
                hasChatApiKey: Boolean(String(savedPreference.chatApiKey || '').trim()),
              },
            }
          : current.userControl,
      }));
      setUserModalSuccess('本地接口设置已保存，仅在当前浏览器生效。');
      appendHistory(setHistory, '已更新本地模式接口配置。');
    } catch (error) {
      setUserModalError(error?.message || '保存本地接口设置失败。');
    } finally {
      setUserActionPending(false);
    }
  }, [rootConfig, upstreamPreferenceForm]);

  const handleRegenerateGatewayApiKey = useCallback(async () => {
    setUserActionPending(true);
    setUserModalError('');
    setUserModalSuccess('');
    try {
      await regenerateCanvasUserApiKey(rootConfig);
      await refreshCanvasSession();
      await loadCanvasUserApiKeys();
      setUserModalSuccess('新的 API 密钥已生成。');
      appendHistory(setHistory, '用户已重置 API 密钥。');
    } catch (error) {
      setUserModalError(error?.message || '重置 API 密钥失败。');
    } finally {
      setUserActionPending(false);
    }
  }, [loadCanvasUserApiKeys, refreshCanvasSession, rootConfig]);

  const handleSaveApiKeySettings = useCallback(async (event) => {
    event.preventDefault();
    setUserActionPending(true);
    setUserModalError('');
    setUserModalSuccess('');
    try {
      await saveCanvasUserApiKeySettings(rootConfig, {
        imageRoutingMode: apiKeySettingsForm.imageRoutingMode || 'smart_failover',
        maxImageQuality: apiKeySettingsForm.maxImageQuality || 'high',
      });
      await refreshCanvasSession();
      setUserModalSuccess('密钥设置已保存。');
      appendHistory(setHistory, '用户已更新自己的 API 设置。');
    } catch (error) {
      setUserModalError(error?.message || '保存密钥设置失败。');
    } finally {
      setUserActionPending(false);
    }
  }, [apiKeySettingsForm, refreshCanvasSession, rootConfig]);

  const handleCopyGatewayApiKey = useCallback(async () => {
    try {
      await copyPlainText(generatedGatewayApiKey);
      setUserModalSuccess('API 密钥已复制。');
    } catch (error) {
      setUserModalError(error?.message || '复制 API 密钥失败。');
    }
  }, [generatedGatewayApiKey]);

  const handleCopyCanvasUserApiKey = useCallback(async (apiKey) => {
    const rawKey = String(apiKey?.rawKey || '').trim();
    if (!rawKey) {
      setUserModalError('该 API 密钥未保存完整密钥，无法复制。');
      return;
    }
    try {
      await copyPlainText(rawKey);
      setUserModalSuccess(`已复制“${apiKey.name}”。`);
    } catch (error) {
      setUserModalError(error?.message || '复制 API 密钥失败。');
    }
  }, []);

  const handleSetCanvasDefaultApiKey = useCallback(async (apiKey) => {
    if (!apiKey?.id || apiKey.status !== 'active') {
      return;
    }
    setUserActionPending(true);
    setUserModalError('');
    setUserModalSuccess('');
    try {
      await setCanvasUserDefaultApiKey(rootConfig, apiKey.id);
      await refreshCanvasSession();
      await loadCanvasUserApiKeys();
      setUserModalSuccess(`已将“${apiKey.name}”设为画布默认密钥。`);
      appendHistory(setHistory, '用户已切换画布默认 API 密钥。');
    } catch (error) {
      setUserModalError(error?.message || '设置画布默认 API 密钥失败。');
    } finally {
      setUserActionPending(false);
    }
  }, [loadCanvasUserApiKeys, refreshCanvasSession, rootConfig]);

  const updateNodeData = useCallback(
    (nodeId, patch) => {
      setNodes((items) => {
        const nextNodes = items.map((node) =>
          node.id === nodeId ? { ...node, data: { ...node.data, ...patch } } : node
        );
        nodesRef.current = nextNodes;
        return nextNodes;
      });
    },
    [setNodes]
  );

  const markRunNodesActive = useCallback((nodeIds) => {
    const ids = Array.isArray(nodeIds) ? nodeIds.filter(Boolean) : [];
    if (!ids.length) {
      return;
    }
    updateWorkflowRunContext((current) => current
      ? {
          ...current,
          currentNodeIds: ids,
          edgeStates: nextRunContextEdgeStates(current, edgesRef.current, ids, 'active', 'incoming'),
        }
      : current);
  }, [updateWorkflowRunContext]);

  const markRunNodesDone = useCallback((nodeIds) => {
    const ids = Array.isArray(nodeIds) ? nodeIds.filter(Boolean) : [];
    if (!ids.length) {
      return;
    }
    updateWorkflowRunContext((current) => current
      ? {
          ...current,
          currentNodeIds: (current.currentNodeIds || []).filter((id) => !ids.includes(id)),
          completedNodeIds: Array.from(new Set([...(current.completedNodeIds || []), ...ids])),
          edgeStates: nextRunContextEdgeStates(current, edgesRef.current, ids, 'done', 'incoming'),
        }
      : current);
  }, [updateWorkflowRunContext]);

  const markRunNodeFailed = useCallback((nodeId) => {
    if (!nodeId) {
      return;
    }
    updateWorkflowRunContext((current) => current
      ? {
          ...current,
          status: 'failed',
          failedNodeId: nodeId,
          currentNodeIds: (current.currentNodeIds || []).filter((id) => id !== nodeId),
          edgeStates: nextRunContextEdgeStates(current, edgesRef.current, [nodeId], 'failed', 'touch'),
        }
      : current);
  }, [updateWorkflowRunContext]);

  const resetWorkflowRuntimeResults = useCallback(() => {
    workflowRunContextRef.current = null;
    setWorkflowRunContext(null);
    const nextNodes = nodesRef.current.map((node) => {
      if (node.type === 'generate' || node.type === 'imageExplosion' || node.type === 'ecommerceImage') {
        return {
          ...node,
          data: {
            ...node.data,
            status: 'idle',
            imageUrl: '',
            taskId: '',
            resultItems: [],
            explodedPrompts: node.type === 'imageExplosion' || node.type === 'ecommerceImage' ? [] : node.data.explodedPrompts,
            ecommercePrompts: node.type === 'ecommerceImage' ? [] : node.data.ecommercePrompts,
            ecommerceStage: node.type === 'ecommerceImage' ? '' : node.data.ecommerceStage,
            ecommerceStrategyAnalysisStatus: node.type === 'ecommerceImage' ? '' : node.data.ecommerceStrategyAnalysisStatus,
            ecommerceAnalysisStatus: node.type === 'ecommerceImage' ? '' : node.data.ecommerceAnalysisStatus,
            ecommerceSetAnalysisStatus: node.type === 'ecommerceImage' ? '' : node.data.ecommerceSetAnalysisStatus,
            ecommerceEffectiveConfig: node.type === 'ecommerceImage' ? null : node.data.ecommerceEffectiveConfig,
            ecommerceStrategyResult: node.type === 'ecommerceImage' ? null : node.data.ecommerceStrategyResult,
            result: null,
            revisedPrompt: '',
            responseId: '',
            requestPayload: null,
            errorMessage: '',
          },
        };
      }
      if (node.type === 'output') {
        return {
          ...node,
          data: {
            ...node.data,
            status: 'empty',
            imageUrl: '',
            outputUrl: '',
            packageUrl: '',
            packageFileName: '',
            packageCount: 0,
            csvUrl: '',
            resultItems: [],
            errorMessage: '',
          },
        };
      }
      if (node.data?.errorMessage) {
        const nextStatus = node.type === 'prompt'
          ? (String(node.data?.prompt || '').trim() ? 'ready' : 'empty')
          : (['batchPrompt', 'reference', 'localReference'].includes(node.type)
            ? (nodeHasContent(node) ? 'ready' : 'empty')
            : node.data?.status);
        return {
          ...node,
          data: {
            ...node.data,
            status: nextStatus,
            errorMessage: '',
          },
        };
      }
      return node;
    });
    nodesRef.current = nextNodes;
    setNodes(nextNodes);
  }, [setNodes]);

  const retireCanvasTaskGroup = useCallback((options = {}) => {
    const {
      nextNodes = nodesRef.current,
      nextEdges = edgesRef.current,
      nextSelectedNodeId = '',
      historyMessage = '',
    } = options;
    const clearingCanvasId = canvasId;
    const clearingCanvasBatchId = activeCanvasBatchIdRef.current;
    const nextCanvasId = createCanvasId();
    canvasIdRef.current = nextCanvasId;
    setCanvasId(nextCanvasId);
    activeCanvasBatchIdRef.current = '';
    serverRunIdRef.current = '';
    workflowRunContextRef.current = null;
    setWorkflowRunContext(null);
    writeCachedWorkflow(rootConfig, nextNodes, nextEdges, nextSelectedNodeId, nextCanvasId);
    if (historyMessage) {
      appendHistory(setHistory, historyMessage);
    }
    if (!isSettingsEntryMode && rootConfig.clearCanvasEndpoint && (clearingCanvasId || clearingCanvasBatchId)) {
      clearCanvasTaskGroup(rootConfig, clearingCanvasId, clearingCanvasBatchId)
        .then((payload) => {
          const deletedRunCount = Number(payload?.deleted_run_count || 0);
          const canceledRunCount = Number(payload?.canceled_run_count || 0);
          const deletedImageCount = Number(payload?.deleted_image_count || 0);
          const summary = [
            deletedRunCount ? `删除运行记录 ${deletedRunCount} 条` : '',
            canceledRunCount ? `取消运行中任务 ${canceledRunCount} 条` : '',
            deletedImageCount ? `删除站内图片 ${deletedImageCount} 张` : '',
          ].filter(Boolean).join('，');
          appendHistory(setHistory, summary ? `服务器任务组清理完成：${summary}。` : '服务器任务组清理完成。');
        })
        .catch((error) => {
          appendHistory(setHistory, error?.message || '服务器画布任务组后台清理提交失败。');
        });
    }
    return nextCanvasId;
  }, [canvasId, isSettingsEntryMode, rootConfig]);

  const deleteNode = useCallback(
    (nodeId) => {
      if (workflowRunningRef.current) {
        appendHistory(setHistory, '画布运行中，暂不能删除节点。');
        return;
      }
      setNodes((items) => items.filter((node) => node.id !== nodeId));
      setEdges((items) => items.filter((edge) => edge.source !== nodeId && edge.target !== nodeId));
      setSelectedNodeId((current) => (current === nodeId ? '' : current));
      setSelectedEdgeId('');
    },
    [setEdges, setNodes]
  );

  const deleteEdge = useCallback(
    (edgeId) => {
      if (!edgeId) {
        return;
      }
      if (workflowRunningRef.current) {
        appendHistory(setHistory, '画布运行中，暂不能断开连线。');
        return;
      }
      setEdges((items) => items.filter((edge) => edge.id !== edgeId));
      setSelectedEdgeId('');
      appendHistory(setHistory, '已断开连线');
    },
    [setEdges]
  );

  const requestUpload = useCallback((nodeId) => {
    if (workflowRunningRef.current) {
      appendHistory(setHistory, '画布运行中，暂不能上传或替换参考图。');
      return;
    }
    uploadTargetRef.current = nodeId;
    uploadInputRef.current?.click();
  }, []);

  const uploadReferenceDataUrlForServer = useCallback(
    async (imageUrl, options = {}) => {
      return uploadCanvasReferenceAsset(rootConfig, imageUrl, {
        fileName: options.fileName || 'canvas-reference.png',
        ownerId: options.ownerId || rootConfig.currentUserId || '',
        index: options.index || 0,
      });
    },
    [rootConfig]
  );

  const requestBatchPromptUpload = useCallback((nodeId) => {
    if (workflowRunningRef.current) {
      appendHistory(setHistory, '画布运行中，暂不能导入批量提示词。');
      return;
    }
    batchPromptTargetRef.current = nodeId;
    batchPromptInputRef.current?.click();
  }, []);

  const clearBatchPrompt = useCallback(
    (nodeId) => {
      if (workflowRunningRef.current) {
        appendHistory(setHistory, '画布运行中，暂不能清除批量提示词。');
        return;
      }
      updateNodeData(nodeId, {
        fileName: '',
        items: [],
        total: 0,
        billableTotal: 0,
        skippedTotal: 0,
        status: 'empty',
        errorMessage: '',
      });
      appendHistory(setHistory, '批量提示词已清除');
    },
    [updateNodeData]
  );

  const clearNodeResult = useCallback((nodeId) => {
    if (workflowRunningRef.current) {
      appendHistory(setHistory, '画布运行中，暂不能清空节点结果。');
      return;
    }
    const targetNode = nodesRef.current.find((node) => node.id === nodeId);
    if (!targetNode || !['generate', 'imageExplosion', 'ecommerceImage'].includes(targetNode.type)) {
      return;
    }
    const affectedNodeIds = collectDownstreamCanvasResultNodeIds(nodeId, nodesRef.current, edgesRef.current);
    if (!affectedNodeIds.length) {
      return;
    }
    const affectedIds = new Set(affectedNodeIds);
    const nextNodes = nodesRef.current.map((node) => {
      if (!affectedIds.has(node.id)) {
        return node;
      }
      if (node.type === 'generate' || node.type === 'imageExplosion' || node.type === 'ecommerceImage') {
        return {
          ...node,
          data: {
            ...node.data,
            status: 'idle',
            imageUrl: '',
            referenceUrl: '',
            taskId: '',
            resultItems: [],
            explodedPrompts: [],
            ecommercePrompts: [],
            ecommerceStage: '',
            ecommerceStrategyAnalysisStatus: '',
            ecommerceAnalysisStatus: '',
            ecommerceSetAnalysisStatus: '',
            ecommerceEffectiveConfig: null,
            ecommerceStrategyResult: null,
            result: null,
            revisedPrompt: '',
            responseId: '',
            requestPayload: null,
            errorMessage: '',
          },
        };
      }
      if (node.type === 'output') {
        return {
          ...node,
          data: {
            ...node.data,
            status: 'empty',
            imageUrl: '',
            outputUrl: '',
            packageUrl: '',
            packageFileName: '',
            packageCount: 0,
            csvUrl: '',
            resultItems: [],
            errorMessage: '',
          },
        };
      }
      return node;
    });
    nodesRef.current = nextNodes;
    setNodes(nextNodes);
    setSelectedNodeId(nodeId);
    retireCanvasTaskGroup({
      nextNodes,
      nextEdges: edgesRef.current,
      nextSelectedNodeId: nodeId,
      historyMessage: '已清空当前生成结果及受影响的下游结果，并切换到新的任务组。',
    });
  }, [retireCanvasTaskGroup, setNodes]);

  const ensureCanvasAccess = useCallback(() => {
    if (isSettingsEntryMode) {
      return true;
    }
    const access = evaluateCanvasAccess(rootConfig);
    if (access.ok) {
      return true;
    }
    if (access.reason === 'login_required') {
      appendHistory(setHistory, '画布为会员版功能，请先登录会员账号。');
      return false;
    }
    if (access.reason === 'membership_required') {
      appendHistory(setHistory, '画布为会员版功能，当前账号暂未开通会员权限。');
      return false;
    }
    appendHistory(setHistory, '当前账号没有运行画布的权限。');
    return false;
  }, [isSettingsEntryMode, rootConfig]);

  const applyValidationIssues = useCallback(
    (issues) => {
      const issueByNodeId = new Map();
      const relatedIssueByNodeId = new Map();

      issues.forEach((issue) => {
        if (issue.nodeId) {
          issueByNodeId.set(issue.nodeId, issue.message);
        }
        [...(issue.promptMessages || []), ...(issue.relatedMessages || [])].forEach((relatedIssue) => {
          relatedIssueByNodeId.set(relatedIssue.nodeId, relatedIssue.message);
        });
      });

      setNodes((items) => {
        const nextNodes = items.map((node) => {
          const message = issueByNodeId.get(node.id) || relatedIssueByNodeId.get(node.id);
          if (message) {
            return {
              ...node,
              data: {
                ...node.data,
                status: 'failed',
                errorMessage: message,
              },
            };
          }

          if (['prompt', 'batchPrompt', 'reference', 'localReference', 'generate', 'imageExplosion', 'ecommerceImage', 'output'].includes(node.type) && node.data?.errorMessage) {
            const nextStatus = node.type === 'prompt'
              ? (String(node.data?.prompt || '').trim() ? 'ready' : 'empty')
              : (node.type === 'batchPrompt'
                ? (nodeHasContent(node) ? 'ready' : 'empty')
                : (['reference', 'localReference'].includes(node.type)
                ? (nodeHasContent(node) ? 'ready' : 'empty')
                : (node.data?.status === 'failed' ? 'idle' : node.data?.status)));
            return {
              ...node,
              data: {
                ...node.data,
                status: nextStatus,
                errorMessage: '',
              },
            };
          }

          return node;
        });
        nodesRef.current = nextNodes;
        return nextNodes;
      });
    },
    [setNodes]
  );

  const addWorkflowNode = useCallback(
    (type, position = null, connectFrom = null, dataPatch = null) => {
      if (workflowRunningRef.current) {
        appendHistory(setHistory, '画布运行中，暂不能添加节点。');
        return '';
      }
      if (isSettingsEntryMode && !isLocalBrowserSupportedNodeType(type)) {
        appendHistory(setHistory, getLocalBrowserUnsupportedMessage(type));
        return '';
      }
      if (type === 'output' && nodesRef.current.some((node) => node.type === 'output')) {
        appendHistory(setHistory, 'Only one output node is allowed. Connect multiple generated images to the same output node.');
        return '';
      }
      const id = `${type}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      const nextPosition = position || { x: 180 + nodes.length * 36, y: 140 + nodes.length * 20 };
      const nextData = {
        ...createDefaultData(type),
        ...(dataPatch && typeof dataPatch === 'object' && !Array.isArray(dataPatch) ? dataPatch : {}),
      };
      if (isReferenceNodeType(type)) {
        nextData.referenceOrder = nextReferenceOrder(nodesRef.current);
      }
      const nextNode = { id, type, position: nextPosition, data: nextData };
      if (connectFrom) {
        const connectionIssue = getConnectionRuleIssue({ source: connectFrom, target: id }, nodesRef.current.concat(nextNode));
        if (connectionIssue) {
          appendHistory(setHistory, connectionIssue);
          return '';
        }
      }
      setNodes((items) => items.concat(nextNode));
      if (connectFrom) {
        setEdges((items) =>
          addEdge({ id: `${connectFrom}-${id}`, source: connectFrom, target: id, animated: true }, items)
        );
      }
      setSelectedNodeId(id);
      setSelectedEdgeId('');
      setCreateMenu(null);
      setLinkMenu(null);
      return id;
    },
    [isSettingsEntryMode, nodes.length, setEdges, setNodes]
  );

  const stopWorkflow = useCallback(() => {
    if (!workflowRunningRef.current || !runAbortRef.current) {
      return;
    }
    appendHistory(setHistory, '正在中断画布运行，已生成图片会保留。');
    const runId = serverRunIdRef.current;
    if (runId && rootConfig.canvasRunCancelEndpoint) {
      cancelCanvasWorkflowRun(rootConfig, runId).catch(() => {});
    }
    runAbortRef.current.abort();
  }, [rootConfig]);
  const clearCanvas = useCallback(async () => {
    if (workflowRunningRef.current) {
      appendHistory(setHistory, '画布运行中，请先中断后再清空。');
      return;
    }
    const confirmed = window.confirm('确认清空当前画布及该画布任务组图片？此操作会删除服务器中该画布任务组的图片。');
    if (!confirmed) {
      return;
    }
    serverRunIdRef.current = '';
    const resetNodes = normalizeReferenceOrders(initialNodes);
    setNodes(resetNodes);
    setEdges(initialEdges);
    nodesRef.current = resetNodes;
    edgesRef.current = initialEdges;
    setSelectedNodeId('');
    setSelectedEdgeId('');
    setCreateMenu(null);
    setLinkMenu(null);
    removeCachedWorkflow(rootConfig, { includeAnonymous: true });
    retireCanvasTaskGroup({
      nextNodes: resetNodes,
      nextEdges: initialEdges,
      nextSelectedNodeId: '',
      historyMessage: isSettingsEntryMode
        ? '本地模式画布已清空，并已创建新的本地任务组。'
        : '画布已清空，并已创建新的画布任务组。服务器旧结果将在后台同步清理。',
    });
  }, [isSettingsEntryMode, retireCanvasTaskGroup, rootConfig, setEdges, setNodes]);

  const runLocalGenerateNode = useCallback(async ({
    node,
    executionNodes,
    executionEdges,
    resultsByNode,
    signal,
  }) => {
    const promptItems = collectLocalPromptItems(node, executionNodes, executionEdges);
    if (!promptItems.length) {
      throw new Error(`生成图片节点【${displayNodeLabel(node.type, node.data)}】缺少提示词。`);
    }
    const referenceSets = collectLocalReferenceSets(node, executionNodes, executionEdges, resultsByNode);
    const resultItems = [];
    const upstreamPreference = rootConfig?.userControl?.upstreamPreference && typeof rootConfig.userControl.upstreamPreference === 'object'
      ? rootConfig.userControl.upstreamPreference
      : {};

    updateNodeData(node.id, {
      status: 'running',
      imageUrl: '',
      referenceUrl: '',
      taskId: '',
      resultItems: [],
      errorMessage: '',
    });

    for (const promptItem of promptItems) {
      for (const references of referenceSets) {
        throwIfWorkflowAborted(signal);
        const image = await executeLocalImagesRequest({
          node,
          prompt: promptItem.prompt,
          references,
          upstreamPreference,
          signal,
        });
        const index = resultItems.length + 1;
        const item = {
          jobId: `${node.id}:${index}`,
          nodeId: node.id,
          taskId: image.taskId,
          status: 'done',
          imageUrl: image.imageUrl,
          referenceUrl: image.imageUrl,
          downloadUrl: image.imageUrl,
          prompt: promptItem.prompt,
          errorMessage: '',
          batchItem: promptItem.batchItem,
          index,
          name: buildGeneratedItemTitle(node, promptItem.batchItem),
        };
        resultItems.push(item);
        updateNodeData(node.id, {
          status: 'running',
          imageUrl: image.imageUrl,
          referenceUrl: image.imageUrl,
          taskId: image.taskId,
          resultItems: resultItems.slice(),
          errorMessage: '',
        });
      }
    }

    const first = resultItems[0] || null;
    resultsByNode.set(node.id, resultItems);
    updateNodeData(node.id, {
      status: 'done',
      imageUrl: first?.imageUrl || '',
      referenceUrl: first?.downloadUrl || first?.imageUrl || '',
      taskId: first?.taskId || '',
      resultItems,
      errorMessage: '',
    });
  }, [rootConfig, updateNodeData]);

  const runLocalImageExplosionNode = useCallback(async ({
    node,
    executionNodes,
    executionEdges,
    resultsByNode,
    signal,
  }) => {
    const references = collectLocalAllReferences(node, executionNodes, executionEdges, resultsByNode);
    if (!references.length) {
      throw new Error(`图片大爆炸节点【${displayNodeLabel(node.type, node.data)}】缺少前置参考图。`);
    }
    const count = Math.max(1, Math.min(20, Number(node.data?.elementCount || 6)));
    const upstreamPreference = rootConfig?.userControl?.upstreamPreference && typeof rootConfig.userControl.upstreamPreference === 'object'
      ? rootConfig.userControl.upstreamPreference
      : {};

    updateNodeData(node.id, {
      status: 'running',
      imageUrl: '',
      referenceUrl: '',
      taskId: '',
      resultItems: [],
      explodedPrompts: [],
      ecommercePrompts: [],
      ecommerceStage: 'overview_analysis',
      ecommerceAnalysisStatus: 'running',
      ecommerceSetAnalysisStatus: '',
      errorMessage: '',
    });

    let analysisText = '';
    try {
      analysisText = await executeLocalChatCompletion({
        upstreamPreference,
        instruction: buildLocalImageExplosionPrompt(node),
        images: references,
        signal,
      });
    } catch (error) {
      analysisText = JSON.stringify({
        prompt_items: Array.from({ length: count }).map((_, index) => ({
          name: `元素${index + 1}`,
          prompt: `参考原始图片，生成第 ${index + 1} 个最有价值的视觉元素或画面片段，保持原图中的主体特征、材质、色彩、光影和构图关系。`,
        })),
      });
      appendHistory(setHistory, '本地模式图片大爆炸 Chat 分析失败，已使用兜底提示词继续执行。');
    }

    const promptItems = normalizeLocalDerivedPromptItems(analysisText, count);
    if (!promptItems.length) {
      throw new Error('图片大爆炸没有解析到可用的子提示词。');
    }

    updateNodeData(node.id, {
      status: 'running',
      explodedPrompts: promptItems,
      errorMessage: '',
    });

    const resultItems = [];
    for (const item of promptItems) {
      throwIfWorkflowAborted(signal);
      const image = await executeLocalImagesRequest({
        node,
        prompt: item.prompt,
        references,
        upstreamPreference,
        signal,
      });
      const index = resultItems.length + 1;
      resultItems.push({
        jobId: `${node.id}:${item.index || index}`,
        nodeId: node.id,
        taskId: image.taskId,
        status: 'done',
        imageUrl: image.imageUrl,
        referenceUrl: image.imageUrl,
        downloadUrl: image.imageUrl,
        prompt: item.prompt,
        name: item.name || `元素${index}`,
        imageCategory: item.image_category || '',
        sourceLocator: item.source_locator || '',
        batchItem: {
          ...item.raw,
          index: item.index || index,
          name: item.name || `元素${index}`,
          image_category: item.image_category || '',
          source_locator: item.source_locator || '',
          prompt: item.prompt,
        },
        index,
        errorMessage: '',
      });
      updateNodeData(node.id, {
        status: 'running',
        imageUrl: resultItems[0]?.imageUrl || image.imageUrl,
        referenceUrl: resultItems[0]?.referenceUrl || image.imageUrl,
        taskId: resultItems[0]?.taskId || image.taskId,
        resultItems: resultItems.slice(),
        explodedPrompts: promptItems,
        errorMessage: '',
      });
    }

    const first = resultItems[0] || null;
    resultsByNode.set(node.id, resultItems);
    updateNodeData(node.id, {
      status: 'done',
      imageUrl: first?.imageUrl || '',
      referenceUrl: first?.downloadUrl || first?.imageUrl || '',
      taskId: first?.taskId || '',
      resultItems,
      explodedPrompts: promptItems,
      errorMessage: '',
    });
  }, [markRunNodeFailed, rootConfig, updateNodeData]);

  const runLocalEcommerceImageNode = useCallback(async ({
    node,
    executionNodes,
    executionEdges,
    resultsByNode,
    signal,
  }) => {
    const originalReferences = collectLocalAllReferences(node, executionNodes, executionEdges, resultsByNode);
    if (!originalReferences.length) {
      throw new Error(`电商图节点【${displayNodeLabel(node.type, node.data)}】缺少商品参考图。`);
    }

    const upstreamPreference = rootConfig?.userControl?.upstreamPreference && typeof rootConfig.userControl.upstreamPreference === 'object'
      ? rootConfig.userControl.upstreamPreference
      : {};
    let setCount = getLocalEcommerceSetCount(node.data || {});

    updateNodeData(node.id, {
      status: 'running',
      imageUrl: '',
      referenceUrl: '',
      taskId: '',
      resultItems: [],
      explodedPrompts: [],
      ecommercePrompts: [],
      ecommerceStage: 'strategy_analysis',
      ecommerceStrategyAnalysisStatus: String(node.data?.structureMode || 'smart').trim() === 'custom' ? 'done' : 'running',
      ecommerceAnalysisStatus: '',
      ecommerceSetAnalysisStatus: '',
      ecommerceEffectiveConfig: null,
      ecommerceStrategyResult: null,
      errorMessage: '',
    });

    const shouldRunStrategy = String(node.data?.structureMode || 'smart').trim() !== 'custom';
    let effectiveConfig = null;
    let strategyResult = null;
    let effectiveNode = node;

    if (shouldRunStrategy) {
      try {
        const strategyAnalysis = await executeLocalChatCompletion({
          upstreamPreference,
          instruction: buildLocalEcommerceStrategyPrompt(node),
          images: originalReferences,
          signal,
        });
        strategyResult = normalizeLocalEcommerceStrategyResult(strategyAnalysis, node);
        if (!Array.isArray(strategyResult?.recommended_image_plan) || !strategyResult.recommended_image_plan.length) {
          throw new Error('策略分析没有返回可用的逐图规划。');
        }
      } catch (error) {
        strategyResult = buildLocalEcommerceFallbackStrategyResult(
          node,
          error instanceof Error ? error.message : String(error || '')
        );
        appendHistory(setHistory, '本地模式电商图策略分析失败，已使用保守兜底结构继续执行。');
      }
      effectiveConfig = buildLocalEcommerceEffectiveConfig(node, strategyResult);
      effectiveNode = {
        ...node,
        data: {
          ...(node.data || {}),
          ...effectiveConfig,
          ecommerceEffectiveConfig: effectiveConfig,
          ecommerceStrategyResult: strategyResult,
        },
      };
    }
    setCount = getLocalEcommerceSetCount(effectiveNode.data || {});

    updateNodeData(node.id, {
      ecommerceStage: 'overview_analysis',
      ecommerceStrategyAnalysisStatus: 'done',
      ecommerceAnalysisStatus: 'running',
      ecommerceEffectiveConfig: effectiveConfig,
      ecommerceStrategyResult: strategyResult,
      errorMessage: '',
    });

    const overviewAnalysis = await executeLocalChatCompletion({
      upstreamPreference,
      instruction: buildLocalEcommerceOverviewPrompt(effectiveNode),
      images: originalReferences,
      signal,
    });
    const overviewPromptItem = normalizeLocalDerivedPromptItems(overviewAnalysis, 1)[0] || null;
    const overviewPrompt = cleanLocalEcommerceVisiblePromptText(overviewPromptItem?.prompt || '', overviewPromptItem || {});
    if (!overviewPrompt) {
      throw new Error('电商图第一阶段没有解析到组图总览提示词。');
    }

    throwIfWorkflowAborted(signal);
    const overviewImage = await executeLocalImagesRequest({
      node: effectiveNode,
      prompt: overviewPrompt,
      references: originalReferences,
      upstreamPreference,
      signal,
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
    const resultItems = [{
      jobId: `${node.id}:overview`,
      nodeId: node.id,
      taskId: overviewImage.taskId,
      status: 'done',
      imageUrl: overviewImage.imageUrl,
      referenceUrl: overviewImage.imageUrl,
      downloadUrl: overviewImage.imageUrl,
      prompt: overviewPrompt,
      name: '01-overview',
      imageCategory: overviewBatchItem.image_category || '组图总览',
      goal: overviewBatchItem.goal || '',
      referenceUsage: overviewBatchItem.reference_usage || '',
      batchItem: overviewBatchItem,
      index: 1,
      errorMessage: '',
    }];

    const overviewPromptStateItem = {
      ...overviewBatchItem,
      prompt: overviewBatchItem.prompt,
    };
    updateNodeData(node.id, {
      status: 'running',
      imageUrl: overviewImage.imageUrl,
      referenceUrl: overviewImage.imageUrl,
      taskId: overviewImage.taskId,
      resultItems: resultItems.slice(),
      explodedPrompts: [overviewPromptStateItem],
      ecommercePrompts: [overviewPromptStateItem],
      ecommerceStage: 'set_analysis',
      ecommerceAnalysisStatus: 'done',
      ecommerceSetAnalysisStatus: 'running',
      errorMessage: '',
    });

    const setAnalysis = await executeLocalChatCompletion({
      upstreamPreference,
      instruction: buildLocalEcommerceSetPrompt(effectiveNode, overviewAnalysis),
      images: [...originalReferences, overviewImage.imageUrl],
      signal,
    });
    const setPromptItems = normalizeLocalDerivedPromptItems(setAnalysis, setCount);
    if (setPromptItems.length < setCount) {
      throw new Error('电商图第二阶段没有解析到可用的套图提示词。');
    }

    const allPromptItems = [overviewPromptStateItem];
    for (const item of setPromptItems) {
      throwIfWorkflowAborted(signal);
      const cleanedPrompt = cleanLocalEcommerceVisiblePromptText(item.prompt, item);
      const image = await executeLocalImagesRequest({
        node: effectiveNode,
        prompt: cleanedPrompt,
        references: [...originalReferences, overviewImage.imageUrl],
        upstreamPreference,
        signal,
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
        jobId: `${node.id}:${index}`,
        nodeId: node.id,
        taskId: image.taskId,
        status: 'done',
        imageUrl: image.imageUrl,
        referenceUrl: image.imageUrl,
        downloadUrl: image.imageUrl,
        prompt: cleanedPrompt,
        name: `${String(index).padStart(2, '0')}-${item.title || item.name || `套图${index - 1}`}`,
        imageCategory: item.image_category || '',
        goal: item.goal || '',
        referenceUsage: item.reference_usage || '',
        scriptText: item.script_text || '',
        shotScript: item.shot_script || '',
        batchItem,
        index,
        errorMessage: '',
      });
      updateNodeData(node.id, {
        status: 'running',
        imageUrl: overviewImage.imageUrl,
        referenceUrl: overviewImage.imageUrl,
        taskId: overviewImage.taskId,
        resultItems: resultItems.slice(),
        explodedPrompts: allPromptItems.slice(),
        ecommercePrompts: allPromptItems.slice(),
        ecommerceStage: 'set_generating',
        ecommerceSetAnalysisStatus: 'done',
        errorMessage: '',
      });
    }

    resultsByNode.set(node.id, resultItems);
    updateNodeData(node.id, {
      status: 'done',
      imageUrl: overviewImage.imageUrl,
      referenceUrl: overviewImage.imageUrl,
      taskId: overviewImage.taskId,
      resultItems,
      explodedPrompts: allPromptItems,
      ecommercePrompts: allPromptItems,
      ecommerceStage: 'done',
      ecommerceAnalysisStatus: 'done',
      ecommerceSetAnalysisStatus: 'done',
      errorMessage: '',
    });
  }, [rootConfig, updateNodeData]);

  const runLocalOutputNode = useCallback(async ({
    node,
    executionNodes,
    executionEdges,
    resultsByNode,
    signal,
  }) => {
    const nodeById = new Map(executionNodes.map((item) => [item.id, item]));
    const incoming = executionEdges
      .filter((edge) => edge.target === node.id)
      .map((edge) => nodeById.get(edge.source))
      .filter((item) => item && ['generate', 'imageExplosion', 'ecommerceImage'].includes(item.type));
    const resultItems = incoming.flatMap((source) => resultsByNode.get(source.id) || []);
    if (!resultItems.length) {
      throw new Error(`输出节点【${displayNodeLabel(node.type, node.data)}】没有可输出的图片。`);
    }

    throwIfWorkflowAborted(signal);
    updateNodeData(node.id, {
      status: 'running',
      imageUrl: '',
      outputUrl: '',
      packageUrl: '',
      packageFileName: '',
      packageCount: 0,
      resultItems: resultItems.slice(),
      errorMessage: '',
    });

    const first = resultItems[0] || null;
    const shouldZip = String(node.data?.outputMode || '').trim() === 'zip' || resultItems.length > 1;
    let packageInfo = null;
    if (shouldZip) {
      packageInfo = await buildWorkflowOutputPackageFromItems(resultItems, {
        fileNamePrefix: `${canvasId}-${node.id}`,
      });
    }

    resultsByNode.set(node.id, resultItems);
    updateNodeData(node.id, {
      status: 'done',
      imageUrl: first?.imageUrl || '',
      outputUrl: shouldZip ? '' : (first?.downloadUrl || first?.imageUrl || ''),
      packageUrl: packageInfo?.url || '',
      packageFileName: packageInfo?.fileName || '',
      packageCount: shouldZip ? Number(packageInfo?.count || resultItems.length) : resultItems.length,
      resultItems,
      errorMessage: '',
    });
  }, [canvasId, updateNodeData]);

  const runLocalWorkflowPlan = useCallback(async (plan, executionNodes, executionEdges, abortController) => {
    const resultsByNode = new Map();
    const executionNodeById = new Map(executionNodes.map((node) => [node.id, node]));
    for (const originalNode of plan) {
      const node = executionNodeById.get(originalNode.id) || originalNode;
      throwIfWorkflowAborted(abortController.signal);
      markRunNodesActive([node.id]);
      appendHistory(setHistory, `本地模式开始执行节点：${displayNodeLabel(node.type, node.data)}`);
      try {
        if (node.type === 'generate') {
          await runLocalGenerateNode({
            node,
            executionNodes,
            executionEdges,
            resultsByNode,
            signal: abortController.signal,
          });
        } else if (node.type === 'imageExplosion') {
          await runLocalImageExplosionNode({
            node,
            executionNodes,
            executionEdges,
            resultsByNode,
            signal: abortController.signal,
          });
        } else if (node.type === 'ecommerceImage') {
          await runLocalEcommerceImageNode({
            node,
            executionNodes,
            executionEdges,
            resultsByNode,
            signal: abortController.signal,
          });
        } else if (node.type === 'output') {
          await runLocalOutputNode({
            node,
            executionNodes,
            executionEdges,
            resultsByNode,
            signal: abortController.signal,
          });
        }
        markRunNodesDone([node.id]);
        appendHistory(setHistory, `本地模式节点完成：${displayNodeLabel(node.type, node.data)}`);
      } catch (error) {
        updateNodeData(node.id, {
          status: 'failed',
          errorMessage: error?.message || '本地模式执行失败。',
        });
        markRunNodeFailed(node.id);
        throw error;
      }
    }
  }, [
    markRunNodeFailed,
    markRunNodesActive,
    markRunNodesDone,
    runLocalEcommerceImageNode,
    runLocalGenerateNode,
    runLocalImageExplosionNode,
    runLocalOutputNode,
    updateNodeData,
  ]);

  const runWorkflow = useCallback(() => {
    if (workflowRunningRef.current) {
      stopWorkflow();
      return;
    }

    if (!ensureCanvasAccess()) {
      return;
    }

    resetWorkflowRuntimeResults();
    setCreateMenu(null);
    setLinkMenu(null);
    setEditorNodeId('');
    setLocalEditorNodeId('');
    setBatchPromptDialog(null);

    let plan = [];
    try {
      plan = buildRunnableExecutionPlan(nodesRef.current, edgesRef.current);
    } catch (error) {
      appendHistory(setHistory, error?.message || '工作流执行计划生成失败');
      return;
    }

    if (!plan.length) {
      return;
    }

    if (isSettingsEntryMode) {
      const unsupportedIssues = nodesRef.current
        .filter((node) => !isLocalBrowserSupportedNodeType(node.type))
        .map((node) => ({
          nodeId: node.id,
          message: getLocalBrowserUnsupportedMessage(node.type),
          promptMessages: [],
          relatedMessages: [],
        }));
      if (unsupportedIssues.length) {
        applyValidationIssues(unsupportedIssues);
        setSelectedNodeId(unsupportedIssues[0].nodeId || '');
        setSelectedEdgeId('');
        appendHistory(setHistory, unsupportedIssues[0].message);
        return;
      }
    }

    const validationIssues = validateImageRequestInputs(
      nodesRef.current,
      edgesRef.current,
      plan.filter((node) => node.type === 'generate' || node.type === 'imageExplosion' || node.type === 'ecommerceImage').map((node) => node.id)
    );
    const outputIssues = validateRequiredOutputNodes(nodesRef.current, edgesRef.current);
    const batchPromptIssues = validateBatchPromptUsage(nodesRef.current, edgesRef.current);
    const allValidationIssues = validationIssues.concat(outputIssues, batchPromptIssues);
    if (allValidationIssues.length) {
      applyValidationIssues(allValidationIssues);
      const names = allValidationIssues
        .map((issue) => {
          const issueNode = nodesRef.current.find((node) => node.id === issue.nodeId);
          return issueNode ? displayNodeLabel(issueNode.type, issueNode.data) : issue.nodeId;
        })
        .filter(Boolean)
        .join('、');
      setSelectedNodeId(getValidationFocusNodeId(allValidationIssues, nodesRef.current));
      setSelectedEdgeId('');
      appendHistory(setHistory, `画布无法运行，发现 ${allValidationIssues.length} 个校验问题${names ? `：${names}` : ''}`);
      appendHistory(setHistory, allValidationIssues[0].message);
      return;
    }

    applyValidationIssues([]);
    const outputRequirements = getOutputModeRequirements(nodesRef.current, edgesRef.current);
    const lockedOutputIds = new Set(outputRequirements.filter((item) => item.requiresZip).map((item) => item.nodeId));
    if (lockedOutputIds.size) {
      const nextNodes = nodesRef.current.map((node) => lockedOutputIds.has(node.id)
        ? { ...node, data: { ...node.data, outputMode: 'zip', outputUrl: '' } }
        : node);
      nodesRef.current = nextNodes;
      setNodes(nextNodes);
    }

    const batchContexts = getActiveBatchContexts(nodesRef.current, edgesRef.current);
    if (batchContexts.length > 1) {
      appendHistory(setHistory, '当前版本每次运行只支持一个批量提示词来源，请拆分画布后分别运行。');
      return;
    }

    const abortController = new AbortController();
    runAbortRef.current = abortController;
    workflowRunningRef.current = true;
    setWorkflowRunning(true);
    updateWorkflowRunContext(createWorkflowRunContext(plan, edgesRef.current));
    appendHistory(
      setHistory,
      isSettingsEntryMode
        ? `开始在浏览器本地执行画布：${plan.map((node) => displayNodeLabel(node.type, node.data)).join(' → ')}`
        : `开始提交画布到服务端调度：${plan.map((node) => displayNodeLabel(node.type, node.data)).join(' → ')}`
    );

    if (isSettingsEntryMode) {
      (async () => {
        try {
          const executionNodes = await prepareCanvasWorkflowNodesForServer(nodesRef.current);
          throwIfWorkflowAborted(abortController.signal);
          await runLocalWorkflowPlan(plan, executionNodes, edgesRef.current, abortController);
          updateWorkflowRunContext((current) => current ? { ...current, status: 'done', currentNodeIds: [] } : current);
          appendHistory(setHistory, '本地模式画布运行已完成。');
        } catch (error) {
          if (isAbortError(error)) {
            updateWorkflowRunContext((current) => current ? { ...current, status: 'stopped', currentNodeIds: [] } : current);
            appendHistory(setHistory, '本地模式画布运行已中断。已完成节点图片已保留。');
            return;
          }
          updateWorkflowRunContext((current) => current ? { ...current, status: 'failed', currentNodeIds: [] } : current);
          appendHistory(setHistory, error?.message || '本地模式画布运行异常停止。');
        } finally {
          if (runAbortRef.current === abortController) {
            runAbortRef.current = null;
          }
          workflowRunningRef.current = false;
          setWorkflowRunning(false);
        }
      })();
      return;
    }

    if (!rootConfig.canvasRunStartEndpoint || !rootConfig.canvasRunStatusEndpoint) {
      appendHistory(setHistory, '当前画布缺少服务端运行接口，无法启动后端调度。');
      runAbortRef.current = null;
      workflowRunningRef.current = false;
      setWorkflowRunning(false);
      return;
    }

    const seenHistoryRef = { current: new Set() };

    (async () => {
      try {
        const serverNodes = await prepareCanvasWorkflowNodesForServer(nodesRef.current, {
          uploadReferenceAsset: (imageUrl, options = {}) => uploadReferenceDataUrlForServer(imageUrl, options),
        });
        throwIfWorkflowAborted(abortController.signal);
        const started = await startCanvasWorkflowRun(rootConfig, buildServerWorkflowPayload(canvasId, serverNodes, edgesRef.current, rootConfig), { signal: abortController.signal });
        const runId = String(started.run_id || '');
        if (!runId) {
          throw new Error('服务端没有返回画布运行ID。');
        }
        serverRunIdRef.current = runId;
        activeCanvasBatchIdRef.current = readCanvasBatchId(started) || activeCanvasBatchIdRef.current;
        appendServerRunHistory(setHistory, started, seenHistoryRef);
        applyServerRunPayloadToNodes(started, setNodes, nodesRef);
        updateWorkflowRunContext(createRunContextFromServer(plan, edgesRef.current, started));

        let latest = started;
        while (!abortController.signal.aborted && isServerRunActiveStatus(latest.status)) {
          await waitForWorkflow(Number(rootConfig.pollIntervalMs || 2500), abortController.signal);
          throwIfWorkflowAborted(abortController.signal);
          latest = await getCanvasWorkflowRunStatus(rootConfig, runId, { signal: abortController.signal });
          activeCanvasBatchIdRef.current = readCanvasBatchId(latest) || activeCanvasBatchIdRef.current;
          appendServerRunHistory(setHistory, latest, seenHistoryRef);
          applyServerRunPayloadToNodes(latest, setNodes, nodesRef);
          updateWorkflowRunContext(createRunContextFromServer(plan, edgesRef.current, latest));
        }

        if (String(latest.status || '') === 'completed') {
          updateWorkflowRunContext((current) => current ? { ...current, status: 'done', currentNodeIds: [] } : current);
          appendHistory(setHistory, '画布运行已完成。');
          return;
        }
        if (['canceled', 'cancelled', 'cancel_requested'].includes(String(latest.status || '').trim().toLowerCase())) {
          updateWorkflowRunContext((current) => current ? { ...current, status: 'stopped', currentNodeIds: [] } : current);
          appendHistory(setHistory, '画布运行已中断。已完成节点图片已保留。');
          return;
        }
        updateWorkflowRunContext((current) => current ? { ...current, status: 'failed', currentNodeIds: [] } : current);
        appendHistory(setHistory, latest.error_message || '画布运行异常停止。');
      } catch (error) {
        if (isAbortError(error)) {
          updateWorkflowRunContext((current) => current ? { ...current, status: 'stopped', currentNodeIds: [] } : current);
          appendHistory(setHistory, '画布运行已中断。已完成节点图片已保留。');
          return;
        }
        updateWorkflowRunContext((current) => current ? { ...current, status: 'failed', currentNodeIds: [] } : current);
        appendHistory(setHistory, error?.message || '画布运行异常停止');
      } finally {
        refreshCanvasSession();
        if (runAbortRef.current === abortController) {
          runAbortRef.current = null;
        }
        workflowRunningRef.current = false;
        setWorkflowRunning(false);
      }
    })();
  }, [applyValidationIssues, canvasId, ensureCanvasAccess, isSettingsEntryMode, refreshCanvasSession, resetWorkflowRuntimeResults, rootConfig, runLocalWorkflowPlan, setNodes, stopWorkflow, updateWorkflowRunContext, uploadReferenceDataUrlForServer]);

  const repackageCanvasOutputNodes = useCallback((nextNodes, changedNodeId = '') => {
    if (!rootConfig.packageCanvasEndpoint && !rootConfig.adapters?.packageCanvasTaskGroup) {
      return;
    }
    const canvasBatchId = activeCanvasBatchIdRef.current || canvasIdRef.current || canvasId;
    const affectedOutputs = nextNodes.filter((node) => {
      if (node.type !== 'output') {
        return false;
      }
      const items = Array.isArray(node.data?.resultItems) ? node.data.resultItems : [];
      if (!items.length) {
        return false;
      }
      return !changedNodeId || items.some((item) => String(item?.nodeId || '') === changedNodeId);
    });
    affectedOutputs.forEach((outputNode) => {
      const items = (Array.isArray(outputNode.data?.resultItems) ? outputNode.data.resultItems : [])
        .filter((item) => item?.imageUrl || item?.downloadUrl || item?.referenceUrl)
        .map((item) => buildCanvasPackageItemFromResult(item, outputNode.data?.label || '输出结果'));
      if (!items.length) {
        return;
      }
      updateNodeData(outputNode.id, {
        packageUrl: '',
        outputUrl: '',
        packageFileName: '',
        packageCount: items.length,
        csvUrl: '',
        status: 'running',
      });
      packageCanvasTaskGroup(rootConfig, canvasIdRef.current || canvasId, items, canvasBatchId)
        .then((packagePayload) => {
          const nextPackageUrl = String(packagePayload?.package_url || packagePayload?.download_url || packagePayload?.url || '').trim();
          const nextOutputUrl = String(packagePayload?.download_url || packagePayload?.package_url || packagePayload?.url || '').trim();
          const nextPackageFileName = String(packagePayload?.package_file_name || packagePayload?.file_name || 'canvas-results.zip').trim();
          const nextPackageCount = Number(packagePayload?.item_count || packagePayload?.image_count || items.length);
          const nextCsvUrl = String(packagePayload?.csv_url || '').trim();
          updateNodeData(outputNode.id, {
            status: 'done',
            outputMode: 'zip',
            packageUrl: nextPackageUrl,
            outputUrl: nextOutputUrl,
            packageFileName: nextPackageFileName,
            packageCount: nextPackageCount,
            csvUrl: nextCsvUrl,
            errorMessage: '',
          });
          setResultGallery((current) => {
            if (!current) {
              return current;
            }
            const galleryHasAffectedItem = Array.isArray(current.items)
              && current.items.some((item) => String(item?.nodeId || '') === changedNodeId);
            if (!galleryHasAffectedItem && String(current.nodeId || '') !== String(outputNode.id || '')) {
              return current;
            }
            return {
              ...current,
              packageUrl: nextOutputUrl || nextPackageUrl,
              packageFileName: nextPackageFileName,
              packageCount: nextPackageCount,
              csvUrl: nextCsvUrl,
            };
          });
          appendHistory(setHistory, '输出节点已根据编辑后的最终图重新打包。');
        })
        .catch((error) => {
          updateNodeData(outputNode.id, {
            status: 'failed',
            errorMessage: error?.message || '编辑后重新打包失败，请稍后重试。',
          });
        });
    });
  }, [canvasId, rootConfig, updateNodeData]);

  const persistCanvasResultVersionMutation = useCallback((action, context, version) => {
    if (!rootConfig.canvasResultSelectEndpoint) {
      return Promise.resolve({ success: false, reason: 'missing_endpoint' });
    }
    const canvasBatchId = activeCanvasBatchIdRef.current || canvasIdRef.current || canvasId;
    return selectCanvasResultVersion(rootConfig, {
      action: String(action || 'select_version').trim() || 'select_version',
      run_id: serverRunIdRef.current || '',
      canvas_id: canvasIdRef.current || canvasId,
      canvas_batch_id: canvasBatchId,
      node_id: String(context?.nodeId || '').trim(),
      item_index: Number.isFinite(Number(context?.itemIndex)) ? Number(context.itemIndex) : -1,
      item_key: getCanvasResultItemKey(context),
      version: {
        id: String(version?.id || '').trim(),
        label: String(version?.label || '').trim(),
        image_url: String(version?.imageUrl || '').trim(),
        download_url: String(version?.downloadUrl || version?.imageUrl || '').trim(),
        reference_url: String(version?.downloadUrl || version?.imageUrl || '').trim(),
        task_id: String(version?.taskId || '').trim(),
        prompt: String(version?.prompt || '').trim(),
        edit_type: String(version?.editType || '').trim(),
        created_at: String(version?.createdAt || '').trim(),
      },
    }).then((payload) => {
      if (payload?.success) {
        applyServerRunPayloadToNodes(payload, setNodes, nodesRef);
        serverRunIdRef.current = readCanvasPayloadRunId(payload) || serverRunIdRef.current;
        activeCanvasBatchIdRef.current = readCanvasBatchId(payload) || activeCanvasBatchIdRef.current;
      }
      return payload;
    });
  }, [canvasId, rootConfig, setNodes]);

  const persistCanvasResultVersionSelection = useCallback((context, version) => (
    persistCanvasResultVersionMutation('select_version', context, version)
  ), [persistCanvasResultVersionMutation]);

  const applyCanvasResultVersion = useCallback((context, version, options = {}) => {
    const nodeId = String(context?.nodeId || '').trim();
    if (!nodeId || !version?.imageUrl) {
      return;
    }
    const itemIndex = Number.isFinite(Number(context?.itemIndex)) ? Number(context.itemIndex) : -1;
    const contextKey = getCanvasResultItemKey(context);
    const selectFinal = options.selectFinal !== false;
    let nextPreview = null;
    const nextNodes = nodesRef.current.map((node) => {
      if (node.id !== nodeId) {
        return node;
      }
      const data = { ...node.data };
      if (Array.isArray(data.resultItems) && data.resultItems.length) {
        let matchedIndex = -1;
        if (contextKey) {
          matchedIndex = data.resultItems.findIndex((item) => getCanvasResultItemKey(item) === contextKey);
        }
        if (matchedIndex < 0 && itemIndex >= 0 && itemIndex < data.resultItems.length) {
          matchedIndex = itemIndex;
        }
        if (matchedIndex < 0) {
          matchedIndex = data.resultItems.findIndex((item) => {
            const itemImage = String(item?.imageUrl || item?.downloadUrl || item?.referenceUrl || '').trim();
            return itemImage && (itemImage === context.imageUrl || itemImage === context.downloadUrl);
          });
        }
        const resultItems = data.resultItems.map((item, index) => {
          if (index !== matchedIndex) {
            return item;
          }
          const nextItem = mergeCanvasResultItemVersion(item, context, version, selectFinal);
          nextPreview = nextItem;
          return nextItem;
        });
        data.resultItems = resultItems;
        if (nextPreview) {
          data.versions = Array.isArray(nextPreview.versions) ? nextPreview.versions : data.versions;
          data.selectedVersionId = String(nextPreview.selectedVersionId || nextPreview.selected_version_id || data.selectedVersionId || '').trim();
        }
        const firstImage = resultItems.find((item) => item?.imageUrl || item?.downloadUrl || item?.referenceUrl);
        if (selectFinal && firstImage) {
          data.imageUrl = firstImage.imageUrl || firstImage.downloadUrl || firstImage.referenceUrl;
          data.referenceUrl = firstImage.downloadUrl || firstImage.referenceUrl || firstImage.imageUrl;
          data.taskId = firstImage.taskId || data.taskId;
        }
      } else {
        const nextData = mergeCanvasResultItemVersion(data, context, version, selectFinal);
        Object.assign(data, nextData);
        nextPreview = nextData;
      }
      return { ...node, data };
    }).map((node) => {
      if (node.type !== 'output' || !Array.isArray(node.data?.resultItems)) {
        return node;
      }
      let touched = false;
      const resultItems = node.data.resultItems.map((item) => {
        if (String(item?.nodeId || '') !== nodeId) {
          return item;
        }
        const itemKey = getCanvasResultItemKey(item);
        const sameItem = contextKey
          ? itemKey === contextKey
          : (
              itemIndex < 0
              || Number(item?.index || 0) === Number(context?.index || itemIndex + 1)
              || item === context.item
            );
        if (!sameItem) {
          return item;
        }
        touched = true;
        return mergeCanvasResultItemVersion(item, context, version, selectFinal);
      });
      if (!touched) {
        return node;
      }
      return {
        ...node,
        data: {
          ...node.data,
          resultItems,
          packageUrl: selectFinal ? '' : node.data.packageUrl,
          outputUrl: selectFinal ? '' : node.data.outputUrl,
          csvUrl: selectFinal ? '' : node.data.csvUrl,
        },
      };
    });
    nodesRef.current = nextNodes;
    setNodes(nextNodes);
    if (nextPreview) {
      setPreviewImage((current) => current ? {
        ...current,
        ...nextPreview,
        nodeId,
        itemIndex,
        imageUrl: selectFinal ? version.imageUrl : (current.imageUrl || nextPreview.imageUrl),
        downloadUrl: selectFinal ? (version.downloadUrl || version.imageUrl) : (current.downloadUrl || nextPreview.downloadUrl),
        referenceUrl: selectFinal ? (version.downloadUrl || version.imageUrl) : (current.referenceUrl || nextPreview.referenceUrl),
      } : current);
      setResultGallery((current) => {
        if (!current || !Array.isArray(current.items)) {
          return current;
        }
        let changed = false;
        const items = current.items.map((item, index) => {
          const itemNodeId = String(item?.nodeId || '').trim();
          const itemKey = getCanvasResultItemKey(item);
          const sameItem = itemNodeId === nodeId && (contextKey ? itemKey === contextKey : index === itemIndex);
          if (!sameItem) {
            return item;
          }
          changed = true;
          return mergeCanvasResultItemVersion(item, context, version, selectFinal);
        });
        return changed ? { ...current, items } : current;
      });
    }
    if (selectFinal) {
      persistCanvasResultVersionSelection(context, version)
        .catch((error) => {
          appendHistory(setHistory, '最终图片已在当前页面切换，但写入画布任务记录失败：' + (error?.message || '未知错误'));
        });
      repackageCanvasOutputNodes(nodesRef.current, nodeId);
    }
  }, [persistCanvasResultVersionSelection, repackageCanvasOutputNodes, setNodes]);

  const submitCanvasResultEdit = useCallback(async ({ prompt, context, editType = 'whole', circles = [], onProgress = null }) => {
    const reportProgress = (message, extra = {}) => {
      if (typeof onProgress === 'function') {
        onProgress({
          state: 'running',
          message,
          ...extra,
        });
      }
    };
    const editPrompt = String(prompt || '').trim();
    const normalizedEditType = editType === 'local' ? 'local' : 'whole';
    const nodeId = String(context?.nodeId || '').trim();
    const sourceTaskId = resolveCanvasResultEditSourceTaskId(context);
    const sourceImageCandidates = collectCanvasEditableImageUrls(context);
    const imageUrl = sourceImageCandidates[0] || '';
    const localCircles = normalizedEditType === 'local'
      ? normalizeLocalCircles(circles).filter((circle) => String(circle.text || '').trim())
      : [];
    if (!editPrompt && !localCircles.length) {
      throw new Error('请先输入编辑指令。');
    }
    if (normalizedEditType === 'local' && !localCircles.length) {
      throw new Error('请先圈选局部区域并填写对应指令。');
    }
    if (!nodeId || !imageUrl) {
      throw new Error('缺少可编辑图片。');
    }
    const sourceNode = nodesRef.current.find((node) => node.id === nodeId);
    const sourceData = sourceNode?.data || {};
    const canvasBatchId = activeCanvasBatchIdRef.current || canvasIdRef.current || canvasId;
    reportProgress('正在读取当前图片，准备提交编辑任务...');
    let sourceBlob = null;
    let sourceReadError = null;
    for (let index = 0; index < sourceImageCandidates.length; index += 1) {
      const candidateUrl = sourceImageCandidates[index];
      try {
        sourceBlob = await imageUrlToBlob(candidateUrl, { timeoutMs: 30000 });
        break;
      } catch (error) {
        sourceReadError = error;
        if (index < sourceImageCandidates.length - 1) {
          reportProgress('当前图片地址读取失败，正在尝试备用地址...');
        }
      }
    }
    if (!sourceBlob) {
      throw new Error(
        sourceImageCandidates.length > 1
          ? '当前图片地址无法读取，已依次尝试展示地址和下载地址。请确认上游图片外链允许访问，或先将图片作为参考图上传后再编辑。'
          : (sourceReadError?.message || '当前图片地址无法读取。')
      );
    }
    reportProgress('正在上传当前图片为编辑参考图...');
    const sourceReferenceAsset = await uploadCanvasReferenceAsset(rootConfig, sourceBlob, {
      ownerId: `canvas-edit-${nodeId}`,
      fileName: 'canvas-edit-source.png',
      index: 0,
      timeoutMs: 30000,
    });
    if (!sourceReferenceAsset?.image_url) {
      throw new Error('当前图片无法转为编辑参考图，请刷新画布后重试。');
    }
    const referenceImages = [{
      ...sourceReferenceAsset,
      source: sourceReferenceAsset.source || 'canvas_generated_result',
    }];
    const referenceInstructions = ['当前需要编辑的原始结果图。'];
    let composedPrompt = editPrompt;
    let localEditPromptText = '';
    if (normalizedEditType === 'local') {
      reportProgress('正在生成局部圈选标注图...');
      let objectUrl = '';
      let annotatedImageUrl = '';
      try {
        objectUrl = URL.createObjectURL(sourceBlob);
        annotatedImageUrl = await annotateLocalReferenceImage(objectUrl, localCircles);
      } finally {
        if (objectUrl) {
          URL.revokeObjectURL(objectUrl);
        }
      }
      reportProgress('正在上传局部圈选标注图...');
      const annotatedReferenceAsset = await uploadCanvasReferenceAsset(rootConfig, annotatedImageUrl, {
        ownerId: `canvas-edit-${nodeId}`,
        fileName: 'canvas-edit-local-marks.png',
        index: 1,
        timeoutMs: 30000,
      });
      if (!annotatedReferenceAsset?.image_url) {
        throw new Error('局部标注图无法转为编辑参考图，请重新圈选后再试。');
      }
      referenceImages.push({
        ...annotatedReferenceAsset,
        source: annotatedReferenceAsset.source || 'canvas_generated_result_annotation',
      });
      const circlePromptText = localCircles
        .map((circle, index) => `${circle.colorName || '彩色'}圈 ${index + 1}：${String(circle.text || '').trim()}`)
        .join(' ');
      localEditPromptText = circlePromptText;
      if (!composedPrompt && circlePromptText) {
        composedPrompt = '请根据参考图2中的圈选编号执行局部编辑。';
      }
      referenceInstructions.push(`带圈选编号的局部标注图。请根据圈选编号执行以下局部修改：${circlePromptText}`);
    }
    if (!composedPrompt) {
      throw new Error('请先输入编辑指令。');
    }
    reportProgress('正在提交后台生成任务...');
    const uploadedReferenceUrls = referenceImages
      .map((item) => String(item?.image_url || item?.download_url || item?.remote_reference_url || '').trim())
      .filter(Boolean);
    if (!uploadedReferenceUrls.length) {
      throw new Error('编辑参考图上传成功，但未生成可用的图片地址。');
    }
    const payload = {
      model: String(sourceData.model || 'gpt-image-2').trim() || 'gpt-image-2',
      prompt: composedPrompt,
      action: 'edit',
      // Result edits can exceed one minute upstream; queue them and poll by task id
      // so the browser does not end up dropping a long-held sync POST.
      async: true,
      size: sourceData.useCustomSize
        ? `${sourceData.customWidth || 1280}x${sourceData.customHeight || 720}`
        : String(sourceData.size || '1024x1024'),
      quality: String(sourceData.quality || 'auto'),
      output_format: String(sourceData.outputFormat || 'jpeg'),
      output_quality: Number(sourceData.outputQuality || 100),
      response_format: 'url',
      reference_images: referenceImages,
      reference_image_instructions: referenceInstructions,
      prioritize_first_reference_image: referenceImages.length > 1,
      metadata: {
        yali_canvas_mode: 'result_edit',
        yali_canvas_edit_type: normalizedEditType,
        yali_requested_edit_protocol: 'multipart_file_upload',
        yali_canvas_id: String(canvasIdRef.current || canvasId || '').trim(),
        yali_canvas_batch_id: String(canvasBatchId || '').trim(),
        yali_parent_node_id: nodeId,
        yali_parent_item_key: getCanvasResultItemKey(context),
        yali_canvas_edit_source_task_id: sourceTaskId,
      },
    };
    const started = await startCanvasImageTask(rootConfig, payload);
    const startedResult = normalizeCanvasImageTaskResponse(started);
    const startedTaskId = String(startedResult.taskId || started?.task_id || '').trim();
    const taskQueryPath = String(startedResult.queryPath || started?.query_path || '').trim();
    let result = started;
    if (!startedResult.imageUrl) {
      if (!startedTaskId) {
        throw new Error('编辑任务已提交，但未返回任务编号或图片结果。');
      }
      reportProgress(`任务已提交：${startedTaskId}，正在等待生成结果...`, { taskId: startedTaskId });
      result = await pollCanvasImageTask(rootConfig, startedTaskId, started.line_group || payload.line_group, {
        timeoutMs: 1000 * 60 * 12,
        queryPath: taskQueryPath,
        action: 'edit',
      });
    } else {
      reportProgress(
        startedTaskId
          ? `任务已完成：${startedTaskId}，正在整理结果...`
          : '任务已完成，正在整理结果...',
        { taskId: startedTaskId }
      );
    }
    const normalizedResult = normalizeCanvasImageTaskResponse(result);
    const version = {
      id: 'edit-' + String(normalizedResult.taskId || startedTaskId || Date.now()),
      label: (normalizedEditType === 'local' ? '局部编辑 ' : '整图编辑 ') + new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }),
      imageUrl: normalizedResult.imageUrl,
      downloadUrl: normalizedResult.downloadUrl,
      taskId: String(normalizedResult.taskId || startedTaskId || '').trim(),
      prompt: editPrompt || localEditPromptText || localCircles.map((circle) => String(circle.text || '').trim()).filter(Boolean).join('；'),
      editType: normalizedEditType,
      createdAt: String(result?.completed_at || result?.created_at || new Date().toISOString()),
    };
    if (!version.imageUrl) {
      throw new Error('编辑任务完成，但没有返回图片地址。');
    }
    applyCanvasResultVersion(context, version, { selectFinal: false });
    persistCanvasResultVersionMutation('append_version', context, version)
      .catch((error) => {
        appendHistory(setHistory, '新版本已生成，但写入画布记录失败，刷新后可能丢失：' + (error?.message || '未知错误'));
      });
    refreshCanvasSession();
    return version;
  }, [applyCanvasResultVersion, canvasId, persistCanvasResultVersionMutation, refreshCanvasSession, rootConfig]);

  const handlePreviewRequest = useCallback((payload) => {
    const sourceNodeId = String(payload?.nodeId || '').trim();
    const sourceNode = sourceNodeId ? nodesRef.current.find((node) => node.id === sourceNodeId) : null;
    let items = Array.isArray(payload?.items)
      ? payload.items
        .map((item, index) => item ? { ...item, nodeId: item.nodeId || sourceNodeId, itemIndex: index } : item)
        .filter((item) => item && (item.imageUrl || item.downloadUrl || item.referenceUrl || item.status || item.errorMessage))
      : [];
    if (!items.length && sourceNode && ['generate', 'imageExplosion', 'ecommerceImage', 'output'].includes(sourceNode.type)) {
      const fallbackItem = buildPreviewFallbackResultItem(sourceNode, payload);
      if (fallbackItem) {
        items = [{ ...fallbackItem, itemIndex: 0 }];
      }
    }
    const visibleImages = items.filter((item) => item.imageUrl || item.downloadUrl || item.referenceUrl);
    const shouldOpenGallery = items.length > 1
      || visibleImages.length > 1
      || (items.length > 0 && visibleImages.length === 0)
      || payload?.forceGallery;
    if (shouldOpenGallery) {
      setResultGallery({
        title: String(payload?.title || '结果列表'),
        nodeId: sourceNodeId,
        items,
        packageUrl: String(payload?.packageUrl || '').trim(),
        packageFileName: String(payload?.packageFileName || '').trim(),
        csvUrl: String(payload?.csvUrl || '').trim(),
        expectedCount: Number(payload?.expectedCount || items.length || visibleImages.length || 0),
        onPreviewImage: (itemPayload) => {
          const nextPreview = normalizePreviewImagePayload(itemPayload, sourceNodeId);
          if (nextPreview) {
            setPreviewImage(nextPreview);
          }
        },
      });
      return;
    }
    const singleItem = items.length === 1 ? items[0] : null;
    const nextPreview = normalizePreviewImagePayload({
      ...payload,
      ...(singleItem || {}),
      nodeId: sourceNodeId || String(singleItem?.nodeId || '').trim(),
      itemIndex: 0,
    }, sourceNodeId);
    if (nextPreview) {
      setPreviewImage(nextPreview);
    }
  }, []);

  const navigatePreviewGallery = useCallback((step) => {
    setPreviewImage((current) => {
      if (!current || typeof current === 'string') {
        return current;
      }
      const galleryItems = Array.isArray(current.galleryItems)
        ? current.galleryItems
          .map((item, index) => normalizePreviewImagePayload({
            ...item,
            galleryItems: current.galleryItems,
            galleryIndex: Number.isFinite(Number(item?.galleryIndex)) ? Number(item.galleryIndex) : index,
          }, current.nodeId))
          .filter(Boolean)
        : [];
      if (galleryItems.length <= 1) {
        return current;
      }
      const currentIndex = Number.isFinite(Number(current.galleryIndex))
        ? Number(current.galleryIndex)
        : galleryItems.findIndex((item) => getCanvasResultItemKey(item) === getCanvasResultItemKey(current));
      const safeIndex = currentIndex >= 0 ? currentIndex : 0;
      const nextIndex = (safeIndex + step + galleryItems.length) % galleryItems.length;
      const nextItem = galleryItems[nextIndex];
      return {
        ...nextItem,
        galleryItems: current.galleryItems,
        galleryIndex: nextIndex,
      };
    });
  }, []);

  const decoratedNodes = useMemo(
    () => {
      const referenceDisplayOrders = buildReferenceDisplayOrders(nodes, edges);
      return nodes.map((node) => {
        const batchContext = batchContextsByNode.get(node.id);
        const imageGroupContext = imageGroupContextsByNode.get(node.id);
        const effectiveBatchTotal = batchContext?.total || imageGroupContext?.total || 0;
        return {
          ...node,
          data: {
            ...node.data,
            batchTotal: effectiveBatchTotal,
            batchSourceLabel: batchContext?.sourceLabel || imageGroupContext?.sourceLabel || '',
            referenceDisplayOrder: referenceDisplayOrders.get(node.id) || 0,
            locked: workflowRunning,
            onClearBatchPrompt: clearBatchPrompt,
            onClearResult: clearNodeResult,
            onDelete: deleteNode,
            onOpenBatchPrompt: requestBatchPromptUpload,
            onOpenLocalReference: setLocalEditorNodeId,
            onOpenReferenceEditor: setEditorNodeId,
            onPreview: (payload) => handlePreviewRequest({ ...payload, nodeId: node.id }),
            onRequestUpload: requestUpload,
          },
        };
      });
    },
    [batchContextsByNode, clearBatchPrompt, clearNodeResult, deleteNode, edges, handlePreviewRequest, imageGroupContextsByNode, nodes, requestBatchPromptUpload, requestUpload, workflowRunning]
  );

  const onConnect = useCallback(
    (connection) => {
      if (workflowRunningRef.current) {
        appendHistory(setHistory, '画布运行中，暂不能连接节点。');
        return;
      }
      const imageExplosionIssue = getMultipleImageExplosionConnectionIssue(connection, nodesRef.current, edgesRef.current);
      if (imageExplosionIssue) {
        appendHistory(setHistory, imageExplosionIssue);
        return;
      }
      const connectionRuleIssue = getConnectionRuleIssue(connection, nodesRef.current);
      if (connectionRuleIssue) {
        appendHistory(setHistory, connectionRuleIssue);
        return;
      }
      connectSucceededRef.current = true;
      setEdges((items) => addEdge({ ...connection, animated: true }, items));
      setSelectedEdgeId('');
      setLinkMenu(null);
    },
    [setEdges]
  );

  const decoratedEdges = useMemo(
    () => {
      const nodeById = new Map(nodes.map((node) => [node.id, node]));
      return edges.map((edge) => {
        const sourceNode = nodeById.get(edge.source);
        const hasSourceContent = nodeHasContent(sourceNode);
        const runState = workflowRunContext?.edgeStates?.[edge.id] || '';
        const classes = [
          hasSourceContent ? 'edge-has-content' : 'edge-empty-content',
          runState ? `edge-run-${runState}` : '',
          edge.id === selectedEdgeId ? 'is-selected-edge' : '',
        ].filter(Boolean);

        return {
          ...edge,
          animated: hasSourceContent,
          className: classes.join(' '),
          selected: edge.id === selectedEdgeId,
        };
      });
    },
    [edges, nodes, selectedEdgeId, workflowRunContext]
  );

  const flowPointFromEvent = useCallback((event) => {
    if (!flowRef.current || typeof flowRef.current.screenToFlowPosition !== 'function') {
      return { x: event.clientX, y: event.clientY };
    }
    return flowRef.current.screenToFlowPosition({ x: event.clientX, y: event.clientY });
  }, []);

  const handleUploadChange = useCallback(
    async (event) => {
      const file = event.target.files?.[0];
      event.target.value = '';
      if (workflowRunningRef.current) {
        appendHistory(setHistory, '画布运行中，暂不能上传或替换参考图。');
        return;
      }
      if (!file) {
        return;
      }
      const validationError = validateReferenceUploadFile(file);
      if (validationError) {
        appendHistory(setHistory, validationError);
        return;
      }
      const imageUrl = await fileToDataUrl(file);
      const targetId = uploadTargetRef.current;
      if (targetId) {
        const targetNode = nodes.find((node) => node.id === targetId);
        const patch = {
          imageUrl,
          originalImageUrl: imageUrl,
          referenceAssetToken: '',
          referenceAssetNodeId: '',
          referenceAssetSource: 'local_data_url',
          status: 'ready',
          note: file.name,
          fileName: file.name,
        };
        if (targetNode?.type === 'localReference') {
          patch.region = null;
          patch.circles = [];
          patch.localPrompt = '';
          patch.status = 'idle';
        }
        const affectedNodeIds = collectDownstreamCanvasResultNodeIds(targetId, nodesRef.current, edgesRef.current);
        const affectedIds = new Set(affectedNodeIds);
        const nextNodes = nodesRef.current.map((node) => {
          if (node.id === targetId) {
            return {
              ...node,
              data: {
                ...node.data,
                ...patch,
              },
            };
          }
          if (!affectedIds.has(node.id)) {
            return node;
          }
          if (node.type === 'generate' || node.type === 'imageExplosion' || node.type === 'ecommerceImage') {
            return {
              ...node,
              data: {
                ...node.data,
                status: 'idle',
                imageUrl: '',
                referenceUrl: '',
                taskId: '',
                resultItems: [],
                explodedPrompts: [],
                result: null,
                revisedPrompt: '',
                responseId: '',
                requestPayload: null,
                errorMessage: '',
              },
            };
          }
          if (node.type === 'output') {
            return {
              ...node,
              data: {
                ...node.data,
                status: 'empty',
                imageUrl: '',
                outputUrl: '',
                packageUrl: '',
                packageFileName: '',
                packageCount: 0,
                csvUrl: '',
                resultItems: [],
                errorMessage: '',
              },
            };
          }
          return node;
        });
        nodesRef.current = nextNodes;
        setNodes(nextNodes);
        appendHistory(setHistory, `参考图已上传：${file.name}`);
        if (affectedNodeIds.length) {
          retireCanvasTaskGroup({
            nextNodes,
            nextEdges: edgesRef.current,
            nextSelectedNodeId: targetId,
            historyMessage: '参考图已更新，已清空受影响的历史生成结果，并切换到新的任务组。',
          });
        } else {
          writeCachedWorkflow(rootConfig, nextNodes, edgesRef.current, targetId, canvasId);
        }
      }
    },
    [canvasId, nodes, retireCanvasTaskGroup, rootConfig, setNodes]
  );

  const handleBatchPromptFileChange = useCallback(
    async (event) => {
      const file = event.target.files?.[0];
      event.target.value = '';
      if (workflowRunningRef.current) {
        appendHistory(setHistory, '画布运行中，暂不能导入批量提示词。');
        return;
      }
      if (!file) {
        return;
      }
      const targetId = batchPromptTargetRef.current;
      if (!targetId) {
        return;
      }

      setBatchPromptDialog({
        nodeId: targetId,
        fileName: file.name,
        status: 'loading',
        items: [],
        total: 0,
        billableTotal: 0,
        skippedTotal: 0,
        errorMessage: '',
      });

      try {
        const payload = await previewCanvasBatchPromptSheet(rootConfig, file, 20);
        const items = normalizeBatchPreviewItems(payload);
        setBatchPromptDialog({
          nodeId: targetId,
          fileName: String(payload.file_name || file.name),
          status: 'ready',
          items,
          total: Number(payload.total || items.length),
          billableTotal: Number(payload.billable_total || items.filter((item) => !item.skip).length),
          skippedTotal: Number(payload.skipped_total || items.filter((item) => item.skip).length),
          errorMessage: '',
        });
        appendHistory(setHistory, `批量提示词预览完成：${items.filter((item) => !item.skip).length} 条有效`);
      } catch (error) {
        setBatchPromptDialog({
          nodeId: targetId,
          fileName: file.name,
          status: 'failed',
          items: [],
          total: 0,
          billableTotal: 0,
          skippedTotal: 0,
          errorMessage: error?.message || '批量提示词解析失败',
        });
        updateNodeData(targetId, { status: 'failed', errorMessage: error?.message || '批量提示词解析失败' });
        appendHistory(setHistory, error?.message || '批量提示词解析失败');
      }
    },
    [rootConfig, updateNodeData]
  );

  const confirmBatchPromptDialog = useCallback(() => {
    if (workflowRunningRef.current) {
      appendHistory(setHistory, '画布运行中，暂不能确认导入批量提示词。');
      return;
    }
    if (!batchPromptDialog || batchPromptDialog.status !== 'ready') {
      return;
    }
    const validItems = batchPromptDialog.items.filter((item) => !item.skip && String(item.prompt || '').trim()).slice(0, 20);
    updateNodeData(batchPromptDialog.nodeId, {
      fileName: batchPromptDialog.fileName,
      items: batchPromptDialog.items.slice(0, 20),
      total: batchPromptDialog.total,
      billableTotal: validItems.length,
      skippedTotal: batchPromptDialog.skippedTotal,
      status: validItems.length ? 'ready' : 'empty',
      errorMessage: validItems.length ? '' : 'CSV 中没有有效提示词。',
    });
    appendHistory(setHistory, `批量提示词已导入：${validItems.length} 条`);
    setBatchPromptDialog(null);
  }, [batchPromptDialog, updateNodeData]);

  const handleDrop = useCallback(
    async (event) => {
      event.preventDefault();
      setDropActive(false);
      if (workflowRunningRef.current) {
        appendHistory(setHistory, '画布运行中，暂不能拖入图片。');
        return;
      }
      const nodePayload = parseCanvasNodeDragPayload(event);
      if (nodePayload) {
        addWorkflowNode(nodePayload.type, flowPointFromEvent(event), null, nodePayload.dataPatch);
        return;
      }
      const file = Array.from(event.dataTransfer?.files || []).find((item) => item.type.startsWith('image/'));
      if (!file) {
        return;
      }
      const validationError = validateReferenceUploadFile(file);
      if (validationError) {
        appendHistory(setHistory, validationError);
        return;
      }

      const imageUrl = await fileToDataUrl(file);
      const selectedRef = ['reference', 'localReference'].includes(selectedNode?.type) ? selectedNode : null;
      if (selectedRef) {
        const patch = {
          imageUrl,
          originalImageUrl: imageUrl,
          referenceAssetToken: '',
          referenceAssetNodeId: '',
          referenceAssetSource: 'local_data_url',
          status: 'ready',
          note: file.name,
          fileName: file.name,
        };
        if (selectedRef.type === 'localReference') {
          patch.region = null;
          patch.circles = [];
          patch.localPrompt = '';
          patch.status = 'idle';
        }
        updateNodeData(selectedRef.id, patch);
        appendHistory(setHistory, `参考图已替换：${file.name}`);
        return;
      }

      const point = flowPointFromEvent(event);
      const id = addWorkflowNode('reference', point);
      updateNodeData(id, {
        imageUrl,
        originalImageUrl: imageUrl,
        referenceAssetToken: '',
        referenceAssetNodeId: '',
        referenceAssetSource: 'local_data_url',
        status: 'ready',
        note: file.name,
        fileName: file.name,
      });
      appendHistory(setHistory, `已从拖拽创建参考图：${file.name}`);
    },
    [addWorkflowNode, flowPointFromEvent, selectedNode, updateNodeData]
  );

  useEffect(() => {
    window.__yaliCanvas = {
      addNode: addWorkflowNode,
      run: runWorkflow,
      nodes: () => nodes,
      edges: () => edges,
      setNodeData: updateNodeData,
      openReferenceEditor: setEditorNodeId,
      openLocalReferenceEditor: setLocalEditorNodeId,
    };
  }, [addWorkflowNode, edges, nodes, runWorkflow, updateNodeData]);

  useEffect(() => {
    const handleKeyDown = (event) => {
      if (!selectedEdgeId || event.defaultPrevented || isEditableTarget(event.target)) {
        return;
      }
      if (workflowRunningRef.current) {
        return;
      }
      if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault();
        deleteEdge(selectedEdgeId);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [deleteEdge, selectedEdgeId]);

  const renderUpstreamPreferenceForm = ({ radioName, submitLabel }) => {
    const isLocalSettingsMode = isSettingsEntryMode;
    const usingUserApi = isLocalSettingsMode || upstreamPreferenceForm.mode === 'user_supplied';
    const imageApiLabel = isLocalSettingsMode
      ? 'Images Endpoint'
      : getImageApiKindLabel(upstreamPreferenceForm.imageApiKind);
    const persistenceLabel = isSettingsEntryMode
      ? '本地模式下，设置只保存在当前浏览器，不会同步到账户或服务端。'
      : '登录模式下不提供上游接口设置。';

    if (isLocalSettingsMode) {
      return (
        <form className="canvas-user-form canvas-user-form--compact" onSubmit={handleSaveUpstreamPreference}>
          <div className="canvas-api-status-card">
            <strong>当前为本地模式</strong>
            <span>本地模式下，设置只保存在当前浏览器，不会同步到账号或服务端。</span>
          </div>

          <div className="canvas-api-config-grid">
            <section className="canvas-api-config-card">
              <div className="canvas-api-config-head">
                <strong>标准 Images Endpoint</strong>
                <span>浏览器会直接请求你填写的 Images 接口；文生图使用 generations 地址，图生图与参考图编辑使用 edits 地址。</span>
              </div>
              <div className="canvas-api-two-col">
                <label className="canvas-user-field">
                  <span>接口协议</span>
                  <input type="text" value="Images Endpoint" readOnly />
                </label>
                <label className="canvas-user-field">
                  <span>鉴权方式</span>
                  <select
                    value={upstreamPreferenceForm.preferredAuthMode}
                    onChange={(event) => setUpstreamPreferenceForm((current) => ({ ...current, preferredAuthMode: event.target.value }))}
                  >
                    <option value="bearer">Bearer Token</option>
                    <option value="x-api-key">X-API-Key</option>
                  </select>
                </label>
              </div>
              <label className="canvas-user-field">
                <span>文生图完整地址</span>
                <input
                  type="url"
                  value={upstreamPreferenceForm.imagesGenerationsUrl}
                  onChange={(event) => setUpstreamPreferenceForm((current) => ({ ...current, imagesGenerationsUrl: event.target.value }))}
                  placeholder="https://api.example.com/v1/images/generations"
                />
              </label>
              <label className="canvas-user-field">
                <span>图生图完整地址</span>
                <input
                  type="url"
                  value={upstreamPreferenceForm.imagesEditsUrl}
                  onChange={(event) => setUpstreamPreferenceForm((current) => ({ ...current, imagesEditsUrl: event.target.value }))}
                  placeholder="https://api.example.com/v1/images/edits"
                />
              </label>
              <label className="canvas-user-field">
                <span>Images Endpoint 密钥</span>
                <input
                  type="password"
                  value={upstreamPreferenceForm.imagesApiKey}
                  onChange={(event) => setUpstreamPreferenceForm((current) => ({ ...current, imagesApiKey: event.target.value }))}
                  placeholder={upstreamPreferenceForm.hasImagesApiKey ? '已保存，如需替换请重新填写' : '请输入 Images Endpoint 密钥'}
                />
              </label>
              <div className="canvas-api-help-text">
                <span>当前浏览器会直接请求你填写的上游接口。若上游没有开放当前站点的跨域访问，浏览器会直接拦截请求。</span>
              </div>
            </section>
            <section className="canvas-api-config-card">
              <div className="canvas-api-config-head">
                <strong>Chat Completions</strong>
                <span>图片大爆炸、电商图等需要分析规划的节点，会由浏览器直接调用这里的 Chat Completions 接口。</span>
              </div>
              <label className="canvas-user-field">
                <span>Chat Completions 完整地址</span>
                <input
                  type="url"
                  value={upstreamPreferenceForm.chatBaseUrl}
                  onChange={(event) => setUpstreamPreferenceForm((current) => ({ ...current, chatBaseUrl: event.target.value }))}
                  placeholder="https://api.example.com/v1/chat/completions"
                />
              </label>
              <label className="canvas-user-field">
                <span>Chat Completions 密钥</span>
                <input
                  type="password"
                  value={upstreamPreferenceForm.chatApiKey}
                  onChange={(event) => setUpstreamPreferenceForm((current) => ({ ...current, chatApiKey: event.target.value }))}
                  placeholder={upstreamPreferenceForm.hasChatApiKey ? '已保存，如需替换请重新填写' : '请输入 Chat Completions 密钥'}
                />
              </label>
              <div className="canvas-api-help-text">
                <span>如果画布里包含图片大爆炸或电商图节点，必须同时配置 Chat Completions；普通参考图与生成节点可只配置 Images Endpoint。</span>
              </div>
            </section>
          </div>

          <div className="canvas-user-inline-note">
            <span>本地模式配置只保存在当前浏览器。本地运行会直接使用你填写的 Images Endpoint 与 Chat Completions，不走平台租户与后台执行链路。</span>
          </div>

          <div className="canvas-user-actions">
            <button type="submit" className="tool-pill tool-pill--primary" disabled={userActionPending}>
              <span>{userActionPending ? '保存中...' : submitLabel}</span>
            </button>
          </div>
        </form>
      );
    }

    return (
      <form className="canvas-user-form canvas-user-form--compact" onSubmit={handleSaveUpstreamPreference}>
        {!isLocalSettingsMode && (
          <div className="canvas-api-mode-cards" role="radiogroup" aria-label="上游线路模式">
            <label className={`canvas-api-mode-card${!usingUserApi ? ' is-active' : ''}`}>
              <input
                type="radio"
                name={radioName}
                checked={!usingUserApi}
                onChange={() => setUpstreamPreferenceForm((current) => ({ ...current, mode: 'shared_platform' }))}
              />
              <strong>使用平台/后台线路</strong>
              <span>画布请求走管理员配置的图像与 Chat 上游，适合快速体验和团队统一部署。</span>
            </label>
            <label className={`canvas-api-mode-card${usingUserApi ? ' is-active' : ''}`}>
              <input
                type="radio"
                name={radioName}
                checked={usingUserApi}
                onChange={() => setUpstreamPreferenceForm((current) => ({ ...current, mode: 'user_supplied' }))}
              />
              <strong>使用我的上游 API</strong>
              <span>图片生成走你填写的接口；Chat 可填写自己的接口，也可按策略使用平台兜底。</span>
            </label>
          </div>
        )}

        <div className="canvas-api-status-card">
          <strong>{isLocalSettingsMode ? '当前为本地模式' : getUpstreamModeTitle(upstreamPreferenceForm.mode)}</strong>
          <span>{persistenceLabel}</span>
        </div>

        <div className={`canvas-api-config-grid${usingUserApi ? '' : ' is-muted'}`}>
          <section className="canvas-api-config-card">
            <div className="canvas-api-config-head">
              <strong>图像接口</strong>
              <span>普通生图、图像编辑和需要图像输出的组合节点，都会使用这里的图像接口。</span>
            </div>
            <div className="canvas-api-two-col">
              {isLocalSettingsMode ? (
                <label className="canvas-user-field">
                  <span>接口协议</span>
                  <input type="text" value="Images Endpoint" readOnly />
                </label>
              ) : (
                <label className="canvas-user-field">
                  <span>图片接口类型</span>
                  <select
                    value={upstreamPreferenceForm.imageApiKind}
                    onChange={(event) => setUpstreamPreferenceForm((current) => ({ ...current, imageApiKind: event.target.value }))}
                  >
                    <option value="images_endpoint">Images Endpoint</option>
                    <option value="responses_endpoint">Responses Endpoint</option>
                  </select>
                </label>
              )}
              <label className="canvas-user-field">
                <span>鉴权方式</span>
                <select
                  value={upstreamPreferenceForm.preferredAuthMode}
                  onChange={(event) => setUpstreamPreferenceForm((current) => ({ ...current, preferredAuthMode: event.target.value }))}
                >
                  <option value="bearer">Bearer Token</option>
                  <option value="x-api-key">X-API-Key</option>
                </select>
              </label>
            </div>
            {isLocalSettingsMode ? (
              <>
                <label className="canvas-user-field">
                  <span>文生图完整地址</span>
                  <input
                    type="url"
                    value={upstreamPreferenceForm.imagesGenerationsUrl}
                    onChange={(event) => setUpstreamPreferenceForm((current) => ({ ...current, imagesGenerationsUrl: event.target.value }))}
                    placeholder="https://api.example.com/v1/images/generations"
                  />
                </label>
                <label className="canvas-user-field">
                  <span>图生图完整地址</span>
                  <input
                    type="url"
                    value={upstreamPreferenceForm.imagesEditsUrl}
                    onChange={(event) => setUpstreamPreferenceForm((current) => ({ ...current, imagesEditsUrl: event.target.value }))}
                    placeholder="https://api.example.com/v1/images/edits"
                  />
                </label>
              </>
            ) : (
              <label className="canvas-user-field">
                <span>{imageApiLabel} 地址</span>
                <input
                  type="url"
                  value={upstreamPreferenceForm.imagesBaseUrl}
                  onChange={(event) => setUpstreamPreferenceForm((current) => ({ ...current, imagesBaseUrl: event.target.value }))}
                  placeholder={getImageApiUrlPlaceholder(upstreamPreferenceForm.imageApiKind)}
                />
              </label>
            )}
            <label className="canvas-user-field">
              <span>{imageApiLabel} 密钥</span>
              <input
                type="password"
                value={upstreamPreferenceForm.imagesApiKey}
                onChange={(event) => setUpstreamPreferenceForm((current) => ({ ...current, imagesApiKey: event.target.value }))}
                placeholder={upstreamPreferenceForm.hasImagesApiKey ? '已保存，如需替换请重新填写' : '请输入 Images Endpoint 密钥'}
              />
            </label>
            <div className="canvas-api-help-text">
              <span>
                {isLocalSettingsMode
                  ? '本地模式请直接填写完整 endpoint；文生图和图生图会分别按各自地址发起请求。'
                  : '地址可以填写服务根地址，也可以填写完整 endpoint；后端会规范化为当前类型需要的请求路径。'}
              </span>
            </div>
          </section>

          <section className="canvas-api-config-card">
            <div className="canvas-api-config-head">
              <strong>Chat Completions</strong>
              <span>大爆炸、电商图和需要视觉理解的节点，会优先调用这里的 Chat 接口。</span>
            </div>
            <label className="canvas-user-field">
              <span>Chat Completions 完整地址</span>
              <input
                type="url"
                value={upstreamPreferenceForm.chatBaseUrl}
                onChange={(event) => setUpstreamPreferenceForm((current) => ({ ...current, chatBaseUrl: event.target.value }))}
                placeholder="https://api.example.com/v1/chat/completions"
              />
            </label>
            <label className="canvas-user-field">
              <span>Chat Completions 密钥</span>
              <input
                type="password"
                value={upstreamPreferenceForm.chatApiKey}
                onChange={(event) => setUpstreamPreferenceForm((current) => ({ ...current, chatApiKey: event.target.value }))}
                placeholder={upstreamPreferenceForm.hasChatApiKey ? '已保存，如需替换请重新填写' : '请输入 Chat API 密钥'}
              />
            </label>
            <label className="canvas-user-field">
              <span>没有填写 Chat 时</span>
              <select
                value={upstreamPreferenceForm.chatFallbackMode}
                onChange={(event) => setUpstreamPreferenceForm((current) => ({ ...current, chatFallbackMode: event.target.value }))}
              >
                <option value="platform_fallback">允许使用平台 Chat 兜底</option>
                <option value="strict_user">必须使用我的 Chat，缺失则报错</option>
              </select>
            </label>
            <div className="canvas-api-help-text">
              <span>如果只使用普通图像生成节点，可以不填 Chat；如果会用视觉理解节点，建议明确配置 Chat。</span>
            </div>
          </section>
        </div>

        <div className="canvas-user-inline-note">
          <span>保存后，画布运行时会自动带入这些配置。</span>
        </div>

        <div className="canvas-user-actions">
          <button type="submit" className="tool-pill tool-pill--primary" disabled={userActionPending}>
            <span>{userActionPending ? '保存中...' : submitLabel}</span>
          </button>
        </div>
      </form>
    );
  };

  const editorNode = editorNodeId ? nodes.find((node) => node.id === editorNodeId) : null;
  const localEditorNode = localEditorNodeId ? nodes.find((node) => node.id === localEditorNodeId) : null;

  return (
    <div className="image-canvas-app">
      <input ref={uploadInputRef} className="hidden-file" type="file" accept="image/*" onChange={handleUploadChange} />
      <input
        ref={batchPromptInputRef}
        className="hidden-file"
        type="file"
        accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        onChange={handleBatchPromptFileChange}
      />

      <div className="floating-toolbar" aria-label="画布工具">
        <div className="toolbar-brand">
          <span className="toolbar-brand-mark">
            <img src={rootConfig.logoIconUrl} alt="" draggable="false" />
          </span>
          <strong>AI 画布</strong>
        </div>
        {Object.entries(NODE_DEFS)
          .filter(([type]) => !isSettingsEntryMode || isLocalBrowserSupportedNodeType(type))
          .map(([type, def]) => {
            const Icon = def.icon;
            const disabled = workflowRunning || (type === 'output' && nodes.some((node) => node.type === 'output'));
            if (type === 'ecommerceImage') {
              return (
                <div key={type} className="tool-menu">
                  <button
                    type="button"
                    className="tool-pill"
                    disabled={disabled}
                    aria-haspopup="menu"
                  >
                    <Icon size={16} />
                    <span>{def.label}</span>
                  </button>
                  <div className="tool-submenu" role="menu" aria-label="电商图子能力">
                    {ECOMMERCE_CAPABILITY_OPTIONS.map((item) => {
                      const patch = buildEcommerceCapabilityNodePatch(item.key);
                      return (
                        <button
                          key={item.key}
                          type="button"
                          className="tool-subcard"
                          disabled={disabled}
                          draggable={!disabled}
                          onClick={() => addWorkflowNode('ecommerceImage', null, null, patch)}
                          onDragStart={(event) => setCanvasNodeDragPayload(event, 'ecommerceImage', patch)}
                        >
                          <strong>{item.label}</strong>
                          <span>{item.description}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            }
            return (
              <button key={type} type="button" className="tool-pill" onClick={() => addWorkflowNode(type)} disabled={disabled}>
                <Icon size={16} />
                <span>{def.label}</span>
              </button>
            );
          })}
        <button
          type="button"
          className={`tool-pill ${workflowRunning ? 'tool-pill--stop' : 'tool-pill--primary'}`}
          onClick={runWorkflow}
          title={workflowRunning
            ? '中断当前画布运行'
            : '运行当前画布'}
        >
          {workflowRunning ? <Square size={16} /> : <Play size={16} />}
          <span>
            {workflowRunning
              ? '中断运行'
              : '运行画布'}
          </span>
        </button>
        <button type="button" className="tool-pill tool-pill--danger" onClick={clearCanvas} disabled={workflowRunning}>
          <Trash2 size={16} />
          <span>清空</span>
        </button>
      </div>

      {rootConfig?.userControl?.enabled && (
        <div className="canvas-user-entry">
          <button
            type="button"
            className="tool-pill tool-pill--user"
            onClick={isSettingsEntryMode ? openSettingsModal : (rootConfig.isLoggedIn ? openManageModal : openLoginModal)}
          >
            <span>{userEntryButtonLabel}</span>
          </button>
        </div>
      )}

      <div className="canvas-help-strip">
        <span>右键空白处添加节点</span>
        <span>拖线后可快速创建下游节点</span>
        <span>拖入图片可创建参考图</span>
      </div>

      {accessViewState.showAccessAlert && (
        <div className="canvas-access-alert">
          <strong>{accessViewState.accessTitle}</strong>
          <span>{accessViewState.accessMessage}</span>
          <a href={accessViewState.accessHref}>
            {accessViewState.accessCta}
          </a>
        </div>
      )}

      {userModalMode && (
        <div className="canvas-user-modal-backdrop" onPointerDown={closeUserModal}>
          <div
            className={`canvas-user-modal ${
              userModalMode === 'manage'
                ? 'canvas-user-modal--manage'
                : userModalMode === 'settings'
                  ? 'canvas-user-modal--settings'
                  : 'canvas-user-modal--auth'
            }`}
            role="dialog"
            aria-modal="true"
            aria-label={
              userModalMode === 'manage'
                ? '画布用户管理'
                : userModalMode === 'settings'
                  ? '画布接口设置'
                  : (userModalMode === 'register' ? '画布用户注册' : '画布用户登录')
            }
            onPointerDown={(event) => event.stopPropagation()}
          >
            <div className="canvas-user-modal-head">
              <div>
                <strong>
                  {userModalMode === 'manage'
                    ? '账户管理'
                    : userModalMode === 'settings'
                      ? '本地接口设置'
                      : (userModalMode === 'register' ? '注册并开始使用' : '登录画布')}
                </strong>
                <span>
                  {userModalMode === 'manage'
                    ? '在这里查看 API、余额流水和账户信息。'
                    : userModalMode === 'settings'
                      ? '这里仅管理当前浏览器本地保存的上游接口配置，不包含登录、注册或账户信息。'
                    : (userModalMode === 'register'
                      ? '注册成功后会自动为你创建可直接使用的 API 密钥。'
                      : '登录后即可查看自己的 API 密钥、余额和最近流水。')}
                </span>
              </div>
              <button type="button" className="canvas-user-modal-close" onClick={closeUserModal} aria-label="关闭">
                <X size={18} />
              </button>
            </div>

            {userModalError && <div className="canvas-user-feedback canvas-user-feedback--error">{userModalError}</div>}
            {userModalSuccess && <div className="canvas-user-feedback canvas-user-feedback--success">{userModalSuccess}</div>}

            <div className="canvas-user-modal-body">
            {(userModalMode === 'login' || userModalMode === 'register') && (
              <form className="canvas-user-form" onSubmit={handleUserAuthSubmit}>
                {userModalMode === 'register' && (
                  <>
                    <label className="canvas-user-field">
                      <span>用户名</span>
                      <input
                        type="text"
                        value={authForm.username}
                        onChange={(event) => setAuthForm((current) => ({ ...current, username: event.target.value }))}
                        placeholder="请输入用户名"
                        autoComplete="username"
                      />
                    </label>
                    <label className="canvas-user-field">
                      <span>邮箱</span>
                      <input
                        type="email"
                        value={authForm.email}
                        onChange={(event) => setAuthForm((current) => ({ ...current, email: event.target.value }))}
                        placeholder="请输入邮箱"
                        autoComplete="email"
                      />
                    </label>
                  </>
                )}
                {userModalMode === 'login' && (
                  <label className="canvas-user-field">
                    <span>账号</span>
                    <input
                      type="text"
                      value={authForm.account}
                      onChange={(event) => setAuthForm((current) => ({ ...current, account: event.target.value }))}
                      placeholder="请输入用户名或邮箱"
                      autoComplete="username"
                    />
                  </label>
                )}
                <label className="canvas-user-field">
                  <span>密码</span>
                  <input
                    type="password"
                    value={authForm.password}
                    onChange={(event) => setAuthForm((current) => ({ ...current, password: event.target.value }))}
                    placeholder="请输入密码"
                    autoComplete={userModalMode === 'register' ? 'new-password' : 'current-password'}
                  />
                </label>
                {userModalMode === 'register' && (
                  <label className="canvas-user-field">
                    <span>确认密码</span>
                    <input
                      type="password"
                      value={authForm.confirmPassword}
                      onChange={(event) => setAuthForm((current) => ({ ...current, confirmPassword: event.target.value }))}
                      placeholder="请再次输入密码"
                      autoComplete="new-password"
                    />
                  </label>
                )}
                <div className="canvas-user-actions">
                  <button type="submit" className="tool-pill tool-pill--primary" disabled={userActionPending}>
                    <span>{userActionPending ? '提交中...' : (userModalMode === 'register' ? '注册并登录' : '登录')}</span>
                  </button>
                  <button
                    type="button"
                    className="tool-pill"
                    onClick={userModalMode === 'register' ? openLoginModal : openRegisterModal}
                    disabled={userActionPending}
                  >
                    <span>{userModalMode === 'register' ? '返回登录' : '去注册'}</span>
                  </button>
                </div>
              </form>
            )}

            {userModalMode === 'settings' && (
              <div className="canvas-user-manage canvas-user-manage--single">
                <section className="canvas-user-panel canvas-user-panel--wide">
                  <div className="canvas-user-panel-head">
                    <strong>本地接口设置</strong>
                    <span>本地模式下，这些设置只保存在当前浏览器，用于直接连接你自己的标准 Images Endpoint。</span>
                  </div>
                  {renderUpstreamPreferenceForm({ radioName: 'settings-upstream-mode', submitLabel: '保存并应用' })}
                </section>
              </div>
            )}

            {userModalMode === 'manage' && (
              <div className="canvas-user-manage canvas-user-manage--tabs">
                <div className="canvas-user-tabbar" role="tablist" aria-label="账户管理标签">
                  <button
                    type="button"
                    className={`canvas-user-tab ${userManageTab === 'api' ? 'is-active' : ''}`}
                    onClick={() => setUserManageTab('api')}
                    role="tab"
                    aria-selected={userManageTab === 'api'}
                  >
                    API
                  </button>
                  <button
                    type="button"
                    className={`canvas-user-tab ${userManageTab === 'ledger' ? 'is-active' : ''}`}
                    onClick={() => {
                      setUserManageTab('ledger');
                      if (!financeLedgerState.rows.length && !financeLedgerState.loading) {
                        void loadFinanceLedger(1);
                      }
                    }}
                    role="tab"
                    aria-selected={userManageTab === 'ledger'}
                  >
                    余额流水
                  </button>
                  <button
                    type="button"
                    className={`canvas-user-tab ${userManageTab === 'account' ? 'is-active' : ''}`}
                    onClick={() => setUserManageTab('account')}
                    role="tab"
                    aria-selected={userManageTab === 'account'}
                  >
                    账户信息
                  </button>
                </div>

                {userManageTab === 'api' && (
                  <div className="canvas-user-tabpanel" role="tabpanel">
                    <section className="canvas-user-panel canvas-user-panel--stack">
                      <div className="canvas-user-panel-head">
                        <strong>API 密钥</strong>
                        <span>这是你的专属 API 密钥，可用于文生图、图生图和聊天接口。</span>
                      </div>
                      <div className="canvas-user-summary-grid">
                        <div className="canvas-user-summary-card">
                          <span>当前余额</span>
                          <strong>{formatFinanceAmountYuan(rootConfig.currentTenantBalanceYuan)}</strong>
                        </div>
                        <div className="canvas-user-summary-card">
                          <span>账户编号</span>
                          <strong>{rootConfig.currentTenantId || '暂未分配'}</strong>
                        </div>
                      </div>
                      <div className="canvas-user-key-box">
                        <code>{generatedGatewayApiKey || '当前还没有可用密钥，请先点击重新生成。'}</code>
                      </div>
                      <div className="canvas-user-actions">
                        <button type="button" className="tool-pill" onClick={handleCopyGatewayApiKey} disabled={userActionPending || !generatedGatewayApiKey}>
                          <span>复制密钥</span>
                        </button>
                        <button type="button" className="tool-pill tool-pill--primary" onClick={handleRegenerateGatewayApiKey} disabled={userActionPending}>
                          <span>{userActionPending ? '处理中...' : '重新生成'}</span>
                        </button>
                      </div>
                      <div className="canvas-user-key-list-head">
                        <strong>账户全部 API 密钥</strong>
                        <span>后台为当前账户新增的密钥会同步显示在这里。画布任务和下方 API 偏好始终使用标记为“画布默认”的一把。</span>
                      </div>
                      {apiKeyListState.error ? <div className="canvas-user-inline-note is-error"><span>{apiKeyListState.error}</span></div> : null}
                      <div className="canvas-user-key-list">
                        {canvasUserApiKeys.map((apiKey) => (
                          (() => {
                            const fixedImageFlatPrice = Math.max(0, Number(apiKey.fixedImageFlatPrice || 0));
                            const imagePricingLabel = apiKey.imagePricingMode === 'fixed_flat' && fixedImageFlatPrice > 0
                              ? `图像 ${formatFinanceAmountYuan(fixedImageFlatPrice)} / 张`
                              : '图像按价格表';
                            return (
                              <article key={apiKey.id} className={`canvas-user-key-item ${apiKey.isDefault ? 'is-default' : ''}`}>
                                <div className="canvas-user-key-item-head">
                                  <div>
                                    <strong>{apiKey.name}</strong>
                                    <span>{apiKey.id}</span>
                                  </div>
                                  <div className="canvas-user-key-badges">
                                    <em className="is-billing">{imagePricingLabel}</em>
                                    {apiKey.isDefault ? <b>画布默认</b> : null}
                                    <em className={apiKey.status === 'active' ? 'is-active' : ''}>{apiKey.status === 'active' ? '可用' : '已停用'}</em>
                                  </div>
                                </div>
                                <code>{apiKey.rawKey || apiKey.maskedKey || '未保存完整密钥'}</code>
                                <div className="canvas-user-actions">
                                  <button type="button" className="tool-pill" onClick={() => void handleCopyCanvasUserApiKey(apiKey)} disabled={userActionPending || !apiKey.rawKey}>
                                    <span>复制密钥</span>
                                  </button>
                                  {!apiKey.isDefault ? (
                                    <button type="button" className="tool-pill" onClick={() => void handleSetCanvasDefaultApiKey(apiKey)} disabled={userActionPending || apiKey.status !== 'active' || !apiKey.rawKey}>
                                      <span>设为画布默认</span>
                                    </button>
                                  ) : null}
                                </div>
                              </article>
                            );
                          })()
                        ))}
                        {!apiKeyListState.loading && !canvasUserApiKeys.length ? <span className="canvas-user-key-list-empty">当前账户还没有可展示的 API 密钥。</span> : null}
                        {apiKeyListState.loading ? <span className="canvas-user-key-list-empty">正在同步账户密钥…</span> : null}
                      </div>
                    </section>

                    <section className="canvas-user-panel canvas-user-panel--stack">
                      <div className="canvas-user-panel-head">
                        <strong>接口地址</strong>
                        <span>下面是已经为你准备好的三个接口地址。</span>
                      </div>
                      <div className="canvas-user-endpoint-list">
                        <div className="canvas-user-endpoint-item">
                          <span>文生图</span>
                          <code>{gatewayImagesGenerationsEndpoint || '暂未就绪'}</code>
                        </div>
                        <div className="canvas-user-endpoint-item">
                          <span>图生图</span>
                          <code>{gatewayImagesEditsEndpoint || '暂未就绪'}</code>
                        </div>
                        <div className="canvas-user-endpoint-item">
                          <span>聊天</span>
                          <code>{gatewayChatCompletionsEndpoint || '暂未就绪'}</code>
                        </div>
                      </div>
                    </section>

                    <section className="canvas-user-panel canvas-user-panel--stack">
                      <div className="canvas-user-panel-head">
                        <strong>画布默认密钥偏好</strong>
                        <span>这些设置仅作用于当前标记为“画布默认”的 API 密钥；切换默认密钥后会自动同步对应设置。</span>
                      </div>
                      <form className="canvas-user-form canvas-user-form--compact canvas-user-form-grid canvas-user-form-grid--2" onSubmit={handleSaveApiKeySettings}>
                        <label className="canvas-user-field">
                          <span>图像路由模式</span>
                          <select
                            value={apiKeySettingsForm.imageRoutingMode}
                            disabled={isFixedImageRoutingMode}
                            onChange={(event) => setApiKeySettingsForm((current) => ({ ...current, imageRoutingMode: event.target.value }))}
                          >
                            <option value="smart_failover">智能模式：智能优选多条线路（增加延时）</option>
                            <option value="smart_priority">优选模式：优选最佳单条线路（失败率偏高）</option>
                            {isFixedImageRoutingMode ? (
                              <option value="fixed_provider">固定模式：使用平台指定线路</option>
                            ) : null}
                          </select>
                        </label>
                        <label className="canvas-user-field">
                          <span>画质上限</span>
                          <select
                            value={apiKeySettingsForm.maxImageQuality}
                            onChange={(event) => setApiKeySettingsForm((current) => ({ ...current, maxImageQuality: event.target.value }))}
                          >
                            <option value="low">低画质</option>
                            <option value="medium">中画质</option>
                            <option value="high">高画质</option>
                          </select>
                        </label>
                        <div className="canvas-user-actions">
                          <button type="submit" className="tool-pill" disabled={userActionPending}>
                            <span>{userActionPending ? '保存中...' : '保存设置'}</span>
                          </button>
                        </div>
                      </form>
                      <div className="canvas-user-inline-note">
                        <span>
                          画质上限决定这个 API 密钥最高能使用到哪个画质。比如你这里设为中画质时，下游请求高画质会自动降为中画质；请求中画质或低画质则保持原请求；未填写画质时，也会按这个上限处理。
                          {isFixedImageRoutingMode ? ` 当前密钥已由平台锁定为固定线路，不允许在前台改成智能或优选。` : ''}
                        </span>
                      </div>
                    </section>

                    <section className="canvas-user-panel canvas-user-panel--stack">
                      <div className="canvas-user-panel-head">
                        <strong>当前价格</strong>
                        <span>下方是当前可用的价格表。不同分辨率和画质对应不同价格，实际扣费会按本次生成结果对应的价格计算。</span>
                      </div>
                      {isFixedImageRoutingMode ? (
                        <div className={`canvas-user-pricing-highlight ${hasFixedImageFlatPrice ? 'is-fixed' : ''}`}>
                          <strong>{hasFixedImageFlatPrice ? '当前密钥专属价格' : '当前密钥固定线路说明'}</strong>
                          <span>
                            {hasFixedImageFlatPrice
                              ? `当前 API 密钥已绑定平台固定线路，并启用一口价 ${formatFinanceAmountYuan(apiKeySettingsForm.fixedImageFlatPrice)} / 张。命中这把密钥时，图像将优先按这一口价结算，不再区分分辨率和画质。`
                              : '当前 API 密钥已绑定平台固定线路，但没有单独设置一口价，因此仍按下方标准价格表结算。'}
                          </span>
                        </div>
                      ) : null}
                      <div className="canvas-user-price-grid">
                        {imagePricingCards.map((item) => (
                          <div key={item.tier} className="canvas-user-price-card">
                            <strong>{item.tier.toUpperCase()}</strong>
                            <div className="canvas-user-price-list">
                              {item.prices.map((priceRow) => (
                                <div key={`${item.tier}-${priceRow.quality}`} className="canvas-user-price-row">
                                  <span>{formatQualityValue(priceRow.quality)}</span>
                                  <b>{formatFinanceAmountYuan(priceRow.price)}</b>
                                </div>
                              ))}
                            </div>
                          </div>
                        ))}
                      </div>
                    </section>
                  </div>
                )}

                {userManageTab === 'ledger' && (
                  <div className="canvas-user-tabpanel" role="tabpanel">
                    <section className="canvas-user-panel canvas-user-panel--stack">
                      <div className="canvas-user-panel-head canvas-user-panel-head--row">
                        <div>
                          <strong>余额与流水</strong>
                          <span>查看当前余额，以及最近 48 小时内的充值和消费记录。</span>
                        </div>
                        <button type="button" className="tool-pill" onClick={() => void loadFinanceLedger(financeLedgerState.page)} disabled={financeLedgerState.loading}>
                          <span>{financeLedgerState.loading ? '刷新中...' : '刷新'}</span>
                        </button>
                      </div>
                      <div className="canvas-user-ledger-summary">
                        <div className="canvas-user-ledger-stat">
                          <span>当前余额</span>
                          <strong>{formatFinanceAmountYuan(financeLedgerState.currentBalanceYuan)}</strong>
                          <em>充值请添加微信：qn006699</em>
                        </div>
                        <div className="canvas-user-ledger-stat">
                          <span>今日消费</span>
                          <strong>{formatFinanceAmountYuan(financeLedgerState.todaySpentYuan)}</strong>
                        </div>
                        <div className="canvas-user-ledger-stat">
                          <span>昨日消费</span>
                          <strong>{formatFinanceAmountYuan(financeLedgerState.yesterdaySpentYuan)}</strong>
                        </div>
                      </div>
                      {financeLedgerState.error && (
                        <div className="canvas-user-feedback canvas-user-feedback--error">{financeLedgerState.error}</div>
                      )}
                      {!financeLedgerState.error && financeLedgerState.rows.length === 0 && !financeLedgerState.loading && (
                        <div className="canvas-user-inline-note">
                          <span>最近 48 小时暂无流水记录。</span>
                        </div>
                      )}
                      {financeLedgerState.rows.length > 0 && (
                        <div className="canvas-user-ledger-list">
                          {financeLedgerState.rows.map((row) => (
                            <div key={row.id} className="canvas-user-ledger-row">
                              <div className="canvas-user-ledger-row-main">
                                <div className="canvas-user-ledger-row-top">
                                  <strong>{row.direction === 'credit' ? '充值' : '消费'}</strong>
                                  <span>{formatFinanceLedgerTime(row.createdAt)}</span>
                                </div>
                                <span className="canvas-user-ledger-note">ID：{row.requestId || row.taskId || row.id}</span>
                                {row.direction === 'debit' ? (
                                  <div className="canvas-user-ledger-detail-grid">
                                    <span>请求协议类型：{row.protocolLabel || 'Images Endpoint'}</span>
                                    <span>请求分辨率：{row.requestedSize || '自动'}</span>
                                    <span>请求画质：{formatQualityValue(row.requestedQuality)}</span>
                                    <span>返回分辨率：{row.actualSize || '未记录'}</span>
                                    <span>返回画质：{formatQualityValue(row.billedQuality)}</span>
                                    <span>价格：{formatFinanceAmountYuan(row.amountYuan)}</span>
                                  </div>
                                ) : (
                                  <span className="canvas-user-ledger-note">{row.note || '无备注'}</span>
                                )}
                              </div>
                              <div className="canvas-user-ledger-row-side">
                                <strong className={row.direction === 'credit' ? 'is-credit' : 'is-debit'}>
                                  {row.direction === 'credit' ? '+' : '-'}{formatFinanceAmountYuan(row.amountYuan)}
                                </strong>
                                <span>余额 {formatFinanceAmountYuan(row.balanceAfterYuan)}</span>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                      {financeLedgerState.totalPages > 1 && (
                        <div className="canvas-user-pagination">
                          <span>共 {financeLedgerState.total} 条</span>
                          <button
                            type="button"
                            className="tool-pill"
                            onClick={() => void loadFinanceLedger(financeLedgerState.page - 1)}
                            disabled={financeLedgerState.loading || financeLedgerState.page <= 1}
                          >
                            <span>上一页</span>
                          </button>
                          <span>第 {financeLedgerState.page} / {financeLedgerState.totalPages} 页</span>
                          <button
                            type="button"
                            className="tool-pill"
                            onClick={() => void loadFinanceLedger(financeLedgerState.page + 1)}
                            disabled={financeLedgerState.loading || financeLedgerState.page >= financeLedgerState.totalPages}
                          >
                            <span>下一页</span>
                          </button>
                        </div>
                      )}
                    </section>
                  </div>
                )}

                {userManageTab === 'account' && (
                  <div className="canvas-user-tabpanel" role="tabpanel">
                    <section className="canvas-user-panel canvas-user-panel--stack">
                      <div className="canvas-user-panel-head">
                        <strong>登录账户</strong>
                        <span>查看当前登录信息，并可随时退出登录。</span>
                      </div>
                      <div className="canvas-user-summary-grid">
                        <div className="canvas-user-summary-card">
                          <span>用户名</span>
                          <strong>{userDisplayName}</strong>
                        </div>
                        <div className="canvas-user-summary-card">
                          <span>邮箱</span>
                          <strong>{rootConfig.currentUserEmail || '未设置'}</strong>
                        </div>
                      </div>
                      <div className="canvas-user-actions">
                        <button type="button" className="tool-pill tool-pill--danger" onClick={handleUserLogout} disabled={userActionPending}>
                          <span>{userActionPending ? '处理中...' : '退出登录'}</span>
                        </button>
                      </div>
                    </section>

                    <section className="canvas-user-panel canvas-user-panel--stack">
                      <div className="canvas-user-panel-head">
                        <strong>修改密码</strong>
                        <span>修改后，下次登录请使用新密码。</span>
                      </div>
                      <form className="canvas-user-form canvas-user-form--compact canvas-user-form-grid canvas-user-form-grid--2" onSubmit={handleChangePassword}>
                        <label className="canvas-user-field">
                          <span>当前密码</span>
                          <input
                            type="password"
                            value={passwordForm.currentPassword}
                            onChange={(event) => setPasswordForm((current) => ({ ...current, currentPassword: event.target.value }))}
                            autoComplete="current-password"
                          />
                        </label>
                        <label className="canvas-user-field">
                          <span>新密码</span>
                          <input
                            type="password"
                            value={passwordForm.nextPassword}
                            onChange={(event) => setPasswordForm((current) => ({ ...current, nextPassword: event.target.value }))}
                            autoComplete="new-password"
                          />
                        </label>
                        <label className="canvas-user-field">
                          <span>确认新密码</span>
                          <input
                            type="password"
                            value={passwordForm.confirmPassword}
                            onChange={(event) => setPasswordForm((current) => ({ ...current, confirmPassword: event.target.value }))}
                            autoComplete="new-password"
                          />
                        </label>
                        <div className="canvas-user-actions">
                          <button type="submit" className="tool-pill" disabled={userActionPending}>
                            <span>{userActionPending ? '处理中...' : '修改密码'}</span>
                          </button>
                        </div>
                      </form>
                    </section>
                  </div>
                )}
              </div>
            )}
            </div>
          </div>
        </div>
      )}

      <main
        className="canvas-main"
        onDragOver={(event) => {
          event.preventDefault();
          if (event.dataTransfer) {
            event.dataTransfer.dropEffect = 'copy';
          }
          const isNodeDrag = Array.from(event.dataTransfer?.types || []).includes(CANVAS_NODE_DRAG_MIME);
          if (!workflowRunning && !isNodeDrag) {
            setDropActive(true);
          }
        }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) {
            setDropActive(false);
          }
        }}
        onDrop={handleDrop}
      >
        <ReactFlow
          nodes={decoratedNodes}
          edges={decoratedEdges}
          onlyRenderVisibleElements
          autoPanOnSelection
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onEdgeClick={(event, edge) => {
            event.stopPropagation();
            setSelectedEdgeId(edge.id);
            setSelectedNodeId('');
            setCreateMenu(null);
            setLinkMenu(null);
          }}
          onEdgesDelete={(deletedEdges) => {
            if (workflowRunningRef.current) {
              return;
            }
            const deletedIds = new Set(deletedEdges.map((edge) => edge.id));
            if (deletedIds.has(selectedEdgeId)) {
              setSelectedEdgeId('');
            }
          }}
          onInit={(instance) => {
            flowRef.current = instance;
            window.setTimeout(() => instance.fitView({ ...FIT_VIEW_OPTIONS, duration: 500 }), 50);
          }}
          onNodeClick={(_, node) => {
            setSelectedNodeId(node.id);
            setSelectedEdgeId('');
            setCreateMenu(null);
            setLinkMenu(null);
          }}
          onPaneClick={() => {
            setSelectedNodeId('');
            setSelectedEdgeId('');
            setCreateMenu(null);
            setLinkMenu(null);
          }}
          onPaneContextMenu={(event) => {
            event.preventDefault();
            if (workflowRunningRef.current) {
              return;
            }
            setLinkMenu(null);
            setCreateMenu({
              x: event.clientX,
              y: event.clientY,
              point: flowPointFromEvent(event),
              types: filterNodeTypesForLocalMode(Object.keys(NODE_DEFS), isSettingsEntryMode),
            });
          }}
          onConnectStart={(_, params) => {
            if (workflowRunningRef.current) {
              return;
            }
            connectStartRef.current = params?.nodeId || '';
            connectSucceededRef.current = false;
          }}
          onConnectEnd={(event) => {
            if (workflowRunningRef.current) {
              connectStartRef.current = '';
              connectSucceededRef.current = false;
              return;
            }
            const sourceId = connectStartRef.current;
            const didConnect = connectSucceededRef.current;
            connectStartRef.current = '';
            connectSucceededRef.current = false;
            if (didConnect) {
              return;
            }
            const target = event.target;
            if (!sourceId || (target instanceof Element && target.closest('.react-flow__handle'))) {
              return;
            }
            const types = filterNodeTypesForLocalMode(
              getCreatableConnectionTargetTypes(sourceId, nodesRef.current, edgesRef.current),
              isSettingsEntryMode,
            );
            if (!types.length) {
              appendHistory(setHistory, '当前节点没有可创建并连接的下游节点。');
              return;
            }
            setCreateMenu(null);
            setLinkMenu({ x: event.clientX, y: event.clientY, point: flowPointFromEvent(event), sourceId, types });
          }}
          onNodesDelete={(deleted) => {
            if (workflowRunningRef.current) {
              return;
            }
            const ids = new Set(deleted.map((node) => node.id));
            if (ids.has(selectedNodeId)) {
              setSelectedNodeId('');
            }
          }}
          fitView
          fitViewOptions={FIT_VIEW_OPTIONS}
          snapToGrid={snapToGridEnabled}
          snapGrid={CANVAS_SNAP_GRID}
          minZoom={0.18}
          maxZoom={1.9}
          nodesDraggable={!workflowRunning}
          nodesConnectable={!workflowRunning}
          edgesReconnectable={!workflowRunning}
          deleteKeyCode={workflowRunning ? null : ['Backspace', 'Delete']}
          proOptions={{ hideAttribution: true }}
        >
          <Background color="rgba(100,116,139,.36)" gap={24} size={1} />
          <MiniMap nodeStrokeWidth={3} zoomable pannable />
          <Controls>
            <ControlButton
              className={snapToGridEnabled ? 'is-active' : ''}
              onClick={() => setSnapToGridEnabled((current) => !current)}
              title={snapToGridEnabled ? '关闭节点拖动网格吸附' : '开启节点拖动网格吸附'}
              aria-label={snapToGridEnabled ? '关闭节点拖动网格吸附' : '开启节点拖动网格吸附'}
            >
              <Grid3X3 size={16} />
            </ControlButton>
          </Controls>
        </ReactFlow>

        {dropActive && (
          <div className="drop-overlay">
            <Upload size={30} />
            <span>释放图片，创建或替换参考图</span>
          </div>
        )}
      </main>

      {createMenu && (
        <CreateMenu
          menu={createMenu}
          onClose={() => setCreateMenu(null)}
          types={createMenu.types}
          onCreate={(type, dataPatch) => addWorkflowNode(type, createMenu.point, null, dataPatch)}
        />
      )}

      {linkMenu && (
        <CreateMenu
          menu={linkMenu}
          title="创建并连接"
          compact
          types={linkMenu.types}
          onClose={() => setLinkMenu(null)}
          onCreate={(type, dataPatch) => addWorkflowNode(type, linkMenu.point, linkMenu.sourceId, dataPatch)}
        />
      )}

      <Inspector
        node={selectedNode}
        rootConfig={rootConfig}
        locked={workflowRunning}
        outputGeneratedInputCount={selectedOutputGeneratedInputCount}
        outputRequiresZip={selectedOutputRequiresZip}
        onUpdate={(patch) => selectedNode && updateNodeData(selectedNode.id, patch)}
        onClearResult={() => selectedNode && clearNodeResult(selectedNode.id)}
        onDelete={() => selectedNode && deleteNode(selectedNode.id)}
        onUpload={() => selectedNode && requestUpload(selectedNode.id)}
        onPreview={(payload) => selectedNode && handlePreviewRequest({ ...payload, nodeId: selectedNode.id })}
        onOpenEditor={() => {
          if (!selectedNode) {
            return;
          }
          if (selectedNode.type === 'localReference') {
            setLocalEditorNodeId(selectedNode.id);
            return;
          }
          setEditorNodeId(selectedNode.id);
        }}
      />

      <EdgeInspector
        edge={edges.find((edge) => edge.id === selectedEdgeId) || null}
        nodes={nodes}
        locked={workflowRunning}
        onDelete={() => deleteEdge(selectedEdgeId)}
      />

      <RunLog history={history} />

      {batchPromptDialog && (
        <div className="batch-prompt-backdrop" role="dialog" aria-modal="true">
          <section className="batch-prompt-modal">
            <header className="batch-prompt-head">
              <div>
                <span>
                  <FileSpreadsheet size={16} />
                  批量提示词
                </span>
                <strong>{batchPromptDialog.fileName || 'CSV 预览'}</strong>
              </div>
              <button type="button" onClick={() => setBatchPromptDialog(null)} aria-label="关闭" disabled={workflowRunning}>
                <X size={17} />
              </button>
            </header>

            {batchPromptDialog.status === 'loading' && (
              <div className="batch-prompt-loading">
                <span />
                <strong>正在解析 CSV</strong>
                <p>画布批量提示词最多导入 20 条，解析完成后可以先预览再确认。</p>
              </div>
            )}

            {batchPromptDialog.status === 'failed' && (
              <div className="batch-prompt-error">
                <strong>解析失败</strong>
                <p>{batchPromptDialog.errorMessage || '批量提示词解析失败，请检查文件格式。'}</p>
                <button type="button" onClick={() => requestBatchPromptUpload(batchPromptDialog.nodeId)} disabled={workflowRunning}>
                  <Upload size={15} />
                  重新上传
                </button>
              </div>
            )}

            {batchPromptDialog.status === 'ready' && (
              <>
                <div className="batch-prompt-summary">
                  <span><b>{batchPromptDialog.billableTotal}</b>有效提示词</span>
                  <span><b>{batchPromptDialog.skippedTotal}</b>跳过</span>
                  <span><b>20</b>最大导入</span>
                </div>
                <div className="batch-prompt-table">
                  <table>
                    <thead>
                      <tr>
                        <th>序号</th>
                        <th>标题</th>
                        <th>提示词</th>
                        <th>状态</th>
                      </tr>
                    </thead>
                    <tbody>
                      {batchPromptDialog.items.map((item, index) => (
                        <tr key={`${item.index}-${item.name}-${index}`} className={item.skip ? 'is-skipped' : ''}>
                          <td>{item.index}</td>
                          <td>{item.name}</td>
                          <td>{item.prompt || item.skip_reason}</td>
                          <td>{item.skip ? '跳过' : '有效'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <footer className="batch-prompt-actions">
                  <button type="button" onClick={() => requestBatchPromptUpload(batchPromptDialog.nodeId)} disabled={workflowRunning}>
                    <Upload size={15} />
                    重新上传
                  </button>
                  <button
                    type="button"
                    className="batch-prompt-confirm"
                    onClick={confirmBatchPromptDialog}
                    disabled={workflowRunning || !batchPromptDialog.items.some((item) => !item.skip && String(item.prompt || '').trim())}
                  >
                    <Check size={15} />
                    确认导入
                  </button>
                </footer>
              </>
            )}
          </section>
        </div>
      )}

      {previewImage && (
        <ImageLightbox
          imageUrl={typeof previewImage === 'string' ? previewImage : previewImage.imageUrl}
          downloadUrl={typeof previewImage === 'string' ? previewImage : previewImage.downloadUrl}
          editContext={typeof previewImage === 'string' ? null : previewImage}
          onSubmitEdit={submitCanvasResultEdit}
          onSelectVersion={(context, version) => applyCanvasResultVersion(context, version, { selectFinal: true })}
          onNavigateGallery={navigatePreviewGallery}
          onOpenReferenceEditor={setEditorNodeId}
          onOpenLocalReferenceEditor={setLocalEditorNodeId}
          onClose={() => setPreviewImage(null)}
        />
      )}

      {resultGallery && (
        <ResultGalleryModal
          title={resultGallery.title}
          items={resultGallery.items}
          packageUrl={resultGallery.packageUrl}
          packageFileName={resultGallery.packageFileName}
          csvUrl={resultGallery.csvUrl}
          expectedCount={resultGallery.expectedCount}
          onPreviewImage={resultGallery.onPreviewImage}
          onClose={() => setResultGallery(null)}
        />
      )}

      {editorNode && (
        <ReferenceEditorModal
          node={editorNode}
          onClose={() => setEditorNodeId('')}
          onSave={(imageUrl) => {
            if (workflowRunningRef.current) {
              return;
            }
            updateNodeData(editorNode.id, {
              imageUrl,
              originalImageUrl: imageUrl,
              referenceAssetToken: '',
              referenceAssetNodeId: '',
              referenceAssetSource: 'local_data_url',
              status: 'ready',
            });
            appendHistory(setHistory, '参考图编辑已保存');
            setEditorNodeId('');
          }}
        />
      )}

      {localEditorNode && (
        <LocalReferenceModal
          node={localEditorNode}
          onClose={() => setLocalEditorNodeId('')}
          onSave={(patch) => {
            if (workflowRunningRef.current) {
              return;
            }
            updateNodeData(localEditorNode.id, { ...patch, status: 'ready' });
            appendHistory(setHistory, '局部参考图已保存');
            setLocalEditorNodeId('');
          }}
        />
      )}
    </div>
  );
}
