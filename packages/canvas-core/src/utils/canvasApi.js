import { extractErrorMessage, requestCanvasJson, safeJson } from './canvasTransport.js';

function getCanvasAdapter(config) {
  return config?.canvasAdapter && typeof config.canvasAdapter === 'object'
    ? config.canvasAdapter
    : null;
}

export async function startCanvasImageTask(config, payload, options = {}) {
  const adapter = getCanvasAdapter(config);
  if (typeof adapter?.startImageTask === 'function') {
    return adapter.startImageTask(payload, { config, options, requestCanvasJson });
  }
  const endpoint = resolveCanvasImageStartEndpoint(config, payload);
  if (!endpoint) {
    throw new Error('画布未配置图像生成接口。');
  }
  return requestCanvasJson(config, endpoint, {
    method: 'POST',
    body: JSON.stringify(payload),
    signal: options.signal,
  });
}

export async function selectCanvasResultVersion(config, payload = {}, options = {}) {
  const adapter = getCanvasAdapter(config);
  if (typeof adapter?.selectResultVersion === 'function') {
    return adapter.selectResultVersion(payload, { config, options, requestCanvasJson });
  }
  if (!config?.canvasResultSelectEndpoint) {
    return { success: false, reason: 'missing_endpoint' };
  }
  return requestCanvasJson(config, config.canvasResultSelectEndpoint, {
    method: 'POST',
    body: JSON.stringify(payload || {}),
    signal: options.signal,
  });
}

export async function clearCanvasTaskGroup(config, canvasId, canvasBatchId = '') {
  const adapter = getCanvasAdapter(config);
  if (typeof adapter?.clearCanvasTaskGroup === 'function') {
    return adapter.clearCanvasTaskGroup({ canvasId, canvasBatchId }, { config, requestCanvasJson });
  }
  if (!config?.clearCanvasEndpoint) {
    return { success: false, reason: 'missing_endpoint' };
  }
  return requestCanvasJson(config, config.clearCanvasEndpoint, {
    method: 'POST',
    body: JSON.stringify({
      canvas_id: canvasId,
      canvas_batch_id: canvasBatchId || '',
    }),
  });
}

export async function packageCanvasTaskGroup(config, canvasId, items = [], canvasBatchId = '') {
  const adapter = getCanvasAdapter(config);
  if (typeof adapter?.packageCanvasTaskGroup === 'function') {
    return adapter.packageCanvasTaskGroup({ canvasId, canvasBatchId, items }, { config, requestCanvasJson });
  }
  if (!config?.packageCanvasEndpoint) {
    return { success: false, reason: 'missing_endpoint' };
  }
  return requestCanvasJson(config, config.packageCanvasEndpoint, {
    method: 'POST',
    body: JSON.stringify({
      canvas_id: canvasId,
      canvas_batch_id: canvasBatchId || canvasId,
      items,
    }),
  });
}

export async function startCanvasWorkflowRun(config, payload, options = {}) {
  const adapter = getCanvasAdapter(config);
  if (typeof adapter?.startRun === 'function') {
    return adapter.startRun(payload, { config, options, requestCanvasJson });
  }
  if (!config?.canvasRunStartEndpoint) {
    throw new Error('画布未配置服务端运行接口。');
  }
  return requestCanvasJson(config, config.canvasRunStartEndpoint, {
    method: 'POST',
    body: JSON.stringify(payload),
    signal: options.signal,
  });
}

export async function getCanvasWorkflowRunStatus(config, runId, options = {}) {
  const adapter = getCanvasAdapter(config);
  if (typeof adapter?.getRunStatus === 'function') {
    return adapter.getRunStatus({ runId, canvasId: options.canvasId || '' }, { config, options, requestCanvasJson });
  }
  if (!config?.canvasRunStatusEndpoint) {
    throw new Error('画布未配置服务端运行状态接口。');
  }
  const params = [];
  if (runId) {
    params.push('run_id=' + encodeURIComponent(String(runId || '')));
  }
  if (options.canvasId) {
    params.push('canvas_id=' + encodeURIComponent(String(options.canvasId || '')));
  }
  const url = String(config.canvasRunStatusEndpoint || '')
    + (String(config.canvasRunStatusEndpoint || '').includes('?') ? '&' : '?')
    + params.join('&');
  return requestCanvasJson(config, url, { method: 'GET', signal: options.signal });
}
export async function cancelCanvasWorkflowRun(config, runId, options = {}) {
  const adapter = getCanvasAdapter(config);
  if (typeof adapter?.cancelRun === 'function') {
    return adapter.cancelRun({ runId }, { config, options, requestCanvasJson });
  }
  if (!config?.canvasRunCancelEndpoint || !runId) {
    return { success: false, reason: 'missing_endpoint' };
  }
  return requestCanvasJson(config, config.canvasRunCancelEndpoint, {
    method: 'POST',
    body: JSON.stringify({ run_id: runId }),
    signal: options.signal,
  });
}

export async function previewCanvasBatchPromptSheet(config, file, limit = 20) {
  const adapter = getCanvasAdapter(config);
  if (typeof adapter?.previewBatchPromptSheet === 'function') {
    return adapter.previewBatchPromptSheet({ file, limit }, { config, requestCanvasJson });
  }
  if (!config?.batchPreviewEndpoint) {
    throw new Error('画布未配置批量提示词预览接口。');
  }
  const formData = new FormData();
  formData.append('batch_sheet', file);
  formData.append('canvas_prompt_limit', String(Math.min(20, Math.max(1, Number(limit || 20)))));
  return requestCanvasJson(config, config.batchPreviewEndpoint, {
    method: 'POST',
    body: formData,
  });
}

export async function refreshCanvasSessionConfig(config) {
  const adapter = getCanvasAdapter(config);
  if (typeof adapter?.refreshSession === 'function') {
    return adapter.refreshSession({ config, requestCanvasJson });
  }
  const sessionEndpoint = String(config?.sessionEndpoint || '').trim();
  if (!sessionEndpoint) {
    return discoverSameOriginCanvasSession(config);
  }
  return requestCanvasJson(config, sessionEndpoint, { method: 'GET' });
}

export async function loginCanvasUser(config, payload) {
  const endpoint = String(config?.userControl?.loginEndpoint || '').trim();
  if (!endpoint) {
    throw new Error('画布未配置登录接口。');
  }
  return requestCanvasControlJson(endpoint, {
    method: 'POST',
    body: JSON.stringify(payload || {}),
  });
}

export async function registerCanvasUser(config, payload) {
  const endpoint = String(config?.userControl?.registerEndpoint || '').trim();
  if (!endpoint) {
    throw new Error('画布未配置注册接口。');
  }
  return requestCanvasControlJson(endpoint, {
    method: 'POST',
    body: JSON.stringify(payload || {}),
  });
}

export async function logoutCanvasUser(config) {
  const endpoint = String(config?.userControl?.logoutEndpoint || '').trim();
  if (!endpoint) {
    throw new Error('画布未配置注销接口。');
  }
  return requestCanvasControlJson(endpoint, { method: 'POST' });
}

export async function getCanvasCurrentUser(config) {
  const endpoint = String(config?.userControl?.profileEndpoint || '').trim();
  if (!endpoint) {
    throw new Error('画布未配置用户信息接口。');
  }
  return requestCanvasControlJson(endpoint, { method: 'GET' });
}

export async function changeCanvasUserPassword(config, payload) {
  const endpoint = String(config?.userControl?.changePasswordEndpoint || '').trim();
  if (!endpoint) {
    throw new Error('画布未配置修改密码接口。');
  }
  return requestCanvasControlJson(endpoint, {
    method: 'POST',
    body: JSON.stringify(payload || {}),
  });
}

export async function saveCanvasUserUpstreamPreference(config, payload) {
  const endpoint = String(config?.userControl?.upstreamPreferenceEndpoint || '').trim();
  if (!endpoint) {
    throw new Error('画布未配置上游偏好保存接口。');
  }
  return requestCanvasControlJson(endpoint, {
    method: 'PUT',
    body: JSON.stringify(payload || {}),
  });
}

export async function saveCanvasUserApiKeySettings(config, payload) {
  const endpoint = String(config?.userControl?.apiKeySettingsEndpoint || '').trim();
  if (!endpoint) {
    throw new Error('画布未配置密钥设置保存接口。');
  }
  return requestCanvasControlJson(endpoint, {
    method: 'PUT',
    body: JSON.stringify(payload || {}),
  });
}

export async function getCanvasUserFinanceLedger(config, options = {}) {
  const endpoint = String(config?.userControl?.financeLedgerEndpoint || '').trim();
  if (!endpoint) {
    throw new Error('画布未配置余额流水查询接口。');
  }
  const params = new URLSearchParams();
  params.set('window_hours', String(Math.max(1, Number(options.windowHours || 48))));
  params.set('page', String(Math.max(1, Number(options.page || 1))));
  params.set('page_size', String(Math.max(1, Number(options.pageSize || options.limit || 10))));
  const url = endpoint + (endpoint.includes('?') ? '&' : '?') + params.toString();
  return requestCanvasControlJson(url, { method: 'GET' });
}

export async function regenerateCanvasUserApiKey(config) {
  const endpoint = String(config?.userControl?.regenerateApiKeyEndpoint || '').trim();
  if (!endpoint) {
    throw new Error('画布未配置 API 密钥重置接口。');
  }
  return requestCanvasControlJson(endpoint, { method: 'POST' });
}

export async function getCanvasUserApiKeys(config) {
  const endpoint = String(config?.userControl?.apiKeysEndpoint || '').trim();
  if (!endpoint) {
    throw new Error('画布未配置 API 密钥列表接口。');
  }
  return requestCanvasControlJson(endpoint, { method: 'GET' });
}

export async function setCanvasUserDefaultApiKey(config, apiKeyId) {
  const endpoint = String(config?.userControl?.defaultApiKeyEndpoint || '').trim();
  if (!endpoint) {
    throw new Error('画布未配置默认 API 密钥设置接口。');
  }
  return requestCanvasControlJson(endpoint, {
    method: 'PUT',
    body: JSON.stringify({ apiKeyId: String(apiKeyId || '').trim() }),
  });
}

export async function uploadCanvasReferenceAsset(config, imageInput, options = {}) {
  const adapter = getCanvasAdapter(config);
  if (typeof adapter?.uploadReferenceAsset === 'function') {
    return adapter.uploadReferenceAsset(imageInput, { ...options, config, requestCanvasJson });
  }

  const directUpload = getDirectUploadContext(config);
  if (!directUpload) {
    return null;
  }

  const endpoint = String(directUpload.reference_endpoint || '').trim();
  const ticket = String(directUpload.reference_ticket || '').trim();
  if (!endpoint) {
    return null;
  }

  const blob = await imageUrlToBlob(imageInput, options);
  const fileName = String(options.fileName || inferUploadFileName(imageInput, options.index)).trim();
  const headers = {
    Accept: 'application/json',
    'X-Yali-Upload-Kind': 'reference_asset',
    'X-Yali-Upload-File-Name': encodeURIComponent(fileName || 'canvas-reference.png'),
    'X-Yali-Upload-File-Size': String(blob.size || 0),
    'X-Yali-Reference-Owner-Id': String(options.ownerId || ''),
    'X-Yali-Reference-Field': 'reference_images',
    'X-Yali-Reference-Index': String(options.index || 0),
  };
  if (config.wpNonce) {
    headers['X-WP-Nonce'] = config.wpNonce;
  }
  if (ticket) {
    headers['X-Yali-Upload-Ticket'] = ticket;
  }
  const formData = new FormData();
  formData.append('file', blob, fileName || 'canvas-reference.png');

  const response = await window.fetch(endpoint, {
    method: 'POST',
    headers,
    body: formData,
    credentials: config?.credentialsMode || 'same-origin',
    cache: 'no-store',
  });
  const payload = await safeJson(response);
  if (!response.ok) {
    const error = new Error(extractErrorMessage(payload) || 'Reference upload failed. Please try again.');
    error.status = response.status;
    error.payload = payload;
    throw error;
  }

  const nodeId = String(payload.node_id || directUpload.node_id || '').trim();
  const source = String(payload.source || '').trim() || (nodeId === 'main-site'
    ? 'main_temporary_reference_url'
    : 'worker_temporary_reference_url');

  return {
    image_url: String(payload.image_url || payload.download_url || payload.remote_reference_url || ''),
    download_url: String(payload.download_url || payload.image_url || ''),
    remote_reference_url: String(payload.remote_reference_url || payload.download_url || payload.image_url || ''),
    reference_asset_token: String(payload.reference_asset_token || payload.token || ''),
    reference_asset_node_id: nodeId,
    size_bytes: Number(payload.size_bytes || blob.size || 0),
    source,
  };
}

export async function pollCanvasImageTask(config, taskId, lineGroup, options = {}) {
  const timeoutMs = Number(options.timeoutMs || 1000 * 60 * 8);
  const intervalMs = Number(config.pollIntervalMs || 2500);
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    throwIfAborted(options.signal);
    const status = await getCanvasImageTaskStatus(config, taskId, lineGroup, options);
    const task = extractCanvasImageTask(status);
    if (task.status === 'completed') {
      throwIfAborted(options.signal);
      return getCanvasImageTaskResult(config, taskId, task.line_group || lineGroup, options);
    }
    if (task.status === 'failed' || task.status === 'expired') {
      throw new Error(task.error_message || '图像任务失败，请稍后重试。');
    }
    await wait(intervalMs, options.signal);
  }

  throw new Error('图像任务等待超时，请稍后在任务记录中查看结果。');
}

function extractCanvasImageTask(payload) {
  if (payload?.task && typeof payload.task === 'object' && !Array.isArray(payload.task)) {
    return payload.task;
  }
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    return payload;
  }
  return {};
}

export async function getCanvasImageTaskStatus(config, taskId, lineGroup, options = {}) {
  const adapter = getCanvasAdapter(config);
  if (typeof adapter?.getImageTaskStatus === 'function') {
    return adapter.getImageTaskStatus({ taskId, lineGroup }, { config, options, requestCanvasJson });
  }
  const url = resolveCanvasImageTaskQueryUrl(config, taskId, lineGroup, options);
  if (!url) {
    throw new Error('画布未配置图片编辑任务状态接口。');
  }
  return requestCanvasJson(config, url, { method: 'GET', signal: options.signal });
}

export async function getCanvasImageTaskResult(config, taskId, lineGroup, options = {}) {
  const adapter = getCanvasAdapter(config);
  if (typeof adapter?.getImageTaskResult === 'function') {
    return adapter.getImageTaskResult({ taskId, lineGroup }, { config, options, requestCanvasJson });
  }
  const url = resolveCanvasImageTaskResultUrl(config, taskId, lineGroup, options);
  if (!url) {
    throw new Error('画布未配置图片编辑任务结果接口。');
  }
  return requestCanvasJson(config, url, { method: 'GET', signal: options.signal });
}

function resolveCanvasImageStartEndpoint(config, payload = {}) {
  const explicit = String(config?.startEndpoint || '').trim();
  const action = inferCanvasImageOperation(payload);
  const userControl = config?.userControl && typeof config.userControl === 'object'
    ? config.userControl
    : {};
  const gatewayEndpoint = action === 'edit'
    ? String(userControl.imagesEditsEndpoint || '').trim()
    : String(userControl.imagesGenerationsEndpoint || '').trim();
  return explicit || gatewayEndpoint;
}

function resolveCanvasImageTaskQueryUrl(config, taskId, lineGroup, options = {}) {
  const directPath = normalizeCanvasQueryPath(options.queryPath);
  if (directPath) {
    return directPath;
  }
  const endpoint = String(config?.canvasTaskStatusEndpoint || config?.statusEndpoint || '').trim();
  if (endpoint) {
    return buildTaskUrl(endpoint, taskId, lineGroup);
  }
  const action = String(options.action || '').trim().toLowerCase();
  const userControl = config?.userControl && typeof config.userControl === 'object'
    ? config.userControl
    : {};
  const baseEndpoint = action === 'edit'
    ? String(userControl.imagesEditsEndpoint || '').trim()
    : String(userControl.imagesGenerationsEndpoint || '').trim();
  if (!baseEndpoint || !taskId) {
    return '';
  }
  return joinTaskPath(baseEndpoint, taskId);
}

function inferCanvasImageOperation(payload = {}) {
  const explicitAction = String(payload?.action || '').trim().toLowerCase();
  if (explicitAction === 'edit' || explicitAction === 'generate') {
    return explicitAction;
  }
  const imageValue = payload?.image;
  if (Array.isArray(imageValue)) {
    return imageValue.length ? 'edit' : 'generate';
  }
  return String(imageValue || '').trim() ? 'edit' : 'generate';
}

function resolveCanvasImageTaskResultUrl(config, taskId, lineGroup, options = {}) {
  const directPath = normalizeCanvasQueryPath(options.queryPath);
  if (directPath) {
    return directPath;
  }
  const endpoint = String(config?.canvasTaskResultEndpoint || config?.resultEndpoint || '').trim();
  if (endpoint) {
    return buildTaskUrl(endpoint, taskId, lineGroup);
  }
  return resolveCanvasImageTaskQueryUrl(config, taskId, lineGroup, options);
}

function normalizeCanvasQueryPath(value) {
  const raw = String(value || '').trim();
  if (!raw) {
    return '';
  }
  if (/^https?:\/\//i.test(raw)) {
    return raw;
  }
  if (raw.startsWith('/')) {
    return raw;
  }
  return '/' + raw.replace(/^\.?\//, '');
}

function joinTaskPath(baseEndpoint, taskId) {
  return String(baseEndpoint || '').replace(/\/+$/, '') + '/' + encodeURIComponent(String(taskId || '').trim());
}

function getDirectUploadContext(config) {
  const directUpload = config?.directUpload && typeof config.directUpload === 'object' ? config.directUpload : null;
  return directUpload?.enabled ? directUpload : null;
}

async function discoverSameOriginCanvasSession(config) {
  if (typeof window === 'undefined' || !window.location?.origin) {
    return {};
  }
  try {
    return await requestCanvasJson(config, '/v1/canvas/session', { method: 'GET' });
  } catch {
    return {};
  }
}

async function requestCanvasControlJson(url, options = {}) {
  const method = String(options.method || 'GET').toUpperCase();
  const headers = {
    Accept: 'application/json',
    ...(options.headers || {}),
  };

  if (options.body && !(options.body instanceof FormData) && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }

  const finalUrl = method === 'GET'
    ? String(url || '') + (String(url || '').includes('?') ? '&' : '?') + '_yali_nc=' + encodeURIComponent(String(Date.now()) + '_' + Math.random().toString(36).slice(2))
    : url;

  const response = await window.fetch(finalUrl, {
    method,
    headers,
    body: options.body || null,
    credentials: 'same-origin',
    cache: 'no-store',
    signal: options.signal,
  });
  const payload = await safeJson(response);
  if (!response.ok) {
    const error = new Error(extractErrorMessage(payload) || 'Request failed.');
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

export async function imageUrlToBlob(imageUrl, options = {}) {
  if (typeof Blob !== 'undefined' && imageUrl instanceof Blob) {
    return imageUrl;
  }
  const value = String(imageUrl || '').trim();
  if (!value) {
    throw new Error('Reference image is empty.');
  }
  const timeoutContext = createTimeoutSignal(options);
  try {
    const response = await window.fetch(value, {
      credentials: 'same-origin',
      cache: 'no-store',
      signal: timeoutContext.signal,
    });
    if (!response.ok) {
      throw new Error('Reference image could not be read.');
    }
    return response.blob();
  } catch (error) {
    if (timeoutContext.didTimeout()) {
      throw new Error('Reference image read timed out.');
    }
    throw error;
  } finally {
    timeoutContext.cleanup();
  }
}

function createTimeoutSignal(options = {}) {
  const timeoutMs = Number(options.timeoutMs || 0);
  if (!(timeoutMs > 0) || typeof AbortController === 'undefined') {
    return {
      signal: options.signal,
      cleanup() {},
      didTimeout() {
        return false;
      },
    };
  }
  const controller = new AbortController();
  let didTimeout = false;
  const parentSignal = options.signal || null;
  const forwardAbort = () => controller.abort(parentSignal?.reason);
  if (parentSignal?.aborted) {
    controller.abort(parentSignal.reason);
  } else if (parentSignal) {
    parentSignal.addEventListener('abort', forwardAbort, { once: true });
  }
  const timer = window.setTimeout(() => {
    didTimeout = true;
    controller.abort();
  }, timeoutMs);
  return {
    signal: controller.signal,
    cleanup() {
      window.clearTimeout(timer);
      if (parentSignal) {
        parentSignal.removeEventListener('abort', forwardAbort);
      }
    },
    didTimeout() {
      return didTimeout;
    },
  };
}

function buildTaskUrl(baseUrl, taskId, lineGroup) {
  const params = [];
  if (taskId) {
    params.push('task_id=' + encodeURIComponent(String(taskId)));
  }
  if (lineGroup) {
    params.push('line_group=' + encodeURIComponent(String(lineGroup)));
  }
  if (!params.length) {
    return baseUrl;
  }
  return String(baseUrl || '') + (String(baseUrl || '').includes('?') ? '&' : '?') + params.join('&');
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw new DOMException('画布运行已中断。', 'AbortError');
  }
}

function wait(ms, signal = null) {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = window.setTimeout(resolve, ms);
    if (signal) {
      signal.addEventListener('abort', () => {
        window.clearTimeout(timer);
        resolve();
      }, { once: true });
    }
  });
}

function inferUploadFileName(imageUrl, index = 0) {
  if (typeof File !== 'undefined' && imageUrl instanceof File && imageUrl.name) {
    return imageUrl.name;
  }
  const value = String(imageUrl || '').toLowerCase();
  const ext = value.startsWith('data:image/webp') || value.includes('.webp')
    ? 'webp'
    : value.startsWith('data:image/jpeg') || value.startsWith('data:image/jpg') || value.includes('.jpg') || value.includes('.jpeg')
      ? 'jpg'
      : 'png';
  return `canvas-reference-${Number(index || 0) + 1}.${ext}`;
}
