const DEFAULT_RUNTIME = {
  startEndpoint: '',
  clearCanvasEndpoint: '',
  packageCanvasEndpoint: '',
  canvasResultSelectEndpoint: '',
  canvasRunStartEndpoint: '',
  canvasRunStatusEndpoint: '',
  canvasRunCancelEndpoint: '',
  batchPreviewEndpoint: '',
  sessionEndpoint: '',
  wpNonce: '',
  executionOwnerLock: '',
  directUpload: null,
  canvasAdapter: null,
  canvasAccess: null,
  canvasChannelId: 'channel_image_generation',
  canvasExecutionSource: '',
  canvasRoutingMode: '',
  pollIntervalMs: 2500,
  lineGroup: 'official',
  maxReferenceImages: 6,
  maxReferenceImageBytes: 12582912,
  maxConcurrentGenerations: 3,
  currentUserId: '',
  currentUsername: '',
  currentUserEmail: '',
  currentTenantId: '',
  currentTenantBalanceCents: 0,
  currentTenantBalanceYuan: 0,
  isLoggedIn: false,
  isMember: false,
  requiresMembership: false,
  loginUrl: '/login/',
  creditRedeemUrl: '/credits/',
  logoIconUrl: '/logo.svg',
  authMode: '',
  authToken: '',
  userControl: {
    enabled: true,
    entryMode: 'settings',
    imagesGenerationsEndpoint: '',
    imagesEditsEndpoint: '',
    chatCompletionsEndpoint: '',
    loginEndpoint: '',
    registerEndpoint: '',
    logoutEndpoint: '',
    profileEndpoint: '',
    changePasswordEndpoint: '',
    upstreamPreferenceEndpoint: '',
    apiKeySettingsEndpoint: '',
    financeLedgerEndpoint: '',
    regenerateApiKeyEndpoint: '',
  },
  credentialsMode: 'same-origin',
};

export function getCanvasRuntimeGlobals() {
  const modern = typeof window !== 'undefined' && window.yaliCanvasRuntime && typeof window.yaliCanvasRuntime === 'object'
    ? window.yaliCanvasRuntime
    : null;
  const legacy = typeof window !== 'undefined' && window.yaliFreeImageCanvas && typeof window.yaliFreeImageCanvas === 'object'
    ? window.yaliFreeImageCanvas
    : null;
  return modern || legacy || {};
}

export function getCanvasRootElement() {
  return document.getElementById('free-image-canvas-root') || document.getElementById('root');
}

export function buildCanvasRuntimeConfig() {
  const root = getCanvasRootElement();
  const dataset = root?.dataset || {};
  const globalConfig = getCanvasRuntimeGlobals();

  return {
    ...DEFAULT_RUNTIME,
    startEndpoint: String(globalConfig.startEndpoint || dataset.startEndpoint || '').trim(),
    clearCanvasEndpoint: String(globalConfig.clearCanvasEndpoint || dataset.clearCanvasEndpoint || '').trim(),
    packageCanvasEndpoint: String(globalConfig.packageCanvasEndpoint || dataset.packageCanvasEndpoint || '').trim(),
    canvasResultSelectEndpoint: String(globalConfig.canvasResultSelectEndpoint || dataset.canvasResultSelectEndpoint || '').trim(),
    canvasRunStartEndpoint: String(globalConfig.canvasRunStartEndpoint || dataset.canvasRunStartEndpoint || '').trim(),
    canvasRunStatusEndpoint: String(globalConfig.canvasRunStatusEndpoint || dataset.canvasRunStatusEndpoint || '').trim(),
    canvasRunCancelEndpoint: String(globalConfig.canvasRunCancelEndpoint || dataset.canvasRunCancelEndpoint || '').trim(),
    batchPreviewEndpoint: String(globalConfig.batchPreviewEndpoint || dataset.batchPreviewEndpoint || '').trim(),
    sessionEndpoint: String(globalConfig.sessionEndpoint || dataset.sessionEndpoint || '').trim(),
    wpNonce: String(globalConfig.wpNonce || dataset.wpNonce || '').trim(),
    executionOwnerLock: String(globalConfig.executionOwnerLock || dataset.executionOwnerLock || '').trim(),
    directUpload: readObject(globalConfig.directUpload, null),
    canvasAdapter: readObject(globalConfig.canvasAdapter || globalConfig.integrationAdapter, null),
    canvasAccess: readObject(globalConfig.canvasAccess || globalConfig.accessState, null),
    canvasChannelId: String(globalConfig.canvasChannelId || globalConfig.channelId || dataset.canvasChannelId || dataset.channelId || DEFAULT_RUNTIME.canvasChannelId).trim(),
    canvasExecutionSource: String(globalConfig.canvasExecutionSource || globalConfig.executionSource || dataset.canvasExecutionSource || dataset.executionSource || '').trim(),
    canvasRoutingMode: String(globalConfig.canvasRoutingMode || globalConfig.routingMode || dataset.canvasRoutingMode || dataset.routingMode || '').trim(),
    pollIntervalMs: Number(globalConfig.pollIntervalMs || dataset.pollIntervalMs || DEFAULT_RUNTIME.pollIntervalMs),
    maxReferenceImages: Number(globalConfig.maxReferenceImages || dataset.maxReferenceImages || DEFAULT_RUNTIME.maxReferenceImages),
    maxReferenceImageBytes: Number(globalConfig.maxReferenceImageBytes || dataset.maxReferenceImageBytes || DEFAULT_RUNTIME.maxReferenceImageBytes),
    maxConcurrentGenerations: Number(globalConfig.maxConcurrentGenerations || dataset.maxConcurrentGenerations || DEFAULT_RUNTIME.maxConcurrentGenerations),
    currentUserId: String(globalConfig.currentUserId || dataset.currentUserId || '').trim(),
    currentUsername: String(globalConfig.currentUsername || dataset.currentUsername || '').trim(),
    currentUserEmail: String(globalConfig.currentUserEmail || dataset.currentUserEmail || '').trim(),
    currentTenantId: String(globalConfig.currentTenantId || dataset.currentTenantId || '').trim(),
    currentTenantBalanceCents: Number(globalConfig.currentTenantBalanceCents || dataset.currentTenantBalanceCents || 0),
    currentTenantBalanceYuan: Number(globalConfig.currentTenantBalanceYuan || dataset.currentTenantBalanceYuan || 0),
    isLoggedIn: readBoolean(globalConfig.isLoggedIn, dataset.isLoggedIn, false),
    isMember: readBoolean(globalConfig.isMember, dataset.isMember, false),
    requiresMembership: readBoolean(globalConfig.requiresMembership, dataset.requiresMembership, false),
    loginUrl: String(globalConfig.loginUrl || dataset.loginUrl || DEFAULT_RUNTIME.loginUrl).trim(),
    creditRedeemUrl: String(globalConfig.creditRedeemUrl || dataset.creditRedeemUrl || DEFAULT_RUNTIME.creditRedeemUrl).trim(),
    logoIconUrl: String(globalConfig.logoIconUrl || dataset.logoIconUrl || DEFAULT_RUNTIME.logoIconUrl).trim(),
    authMode: String(globalConfig.authMode || dataset.authMode || '').trim(),
    authToken: String(globalConfig.authToken || dataset.authToken || '').trim(),
    userControl: mergeUserControlRuntime(readObject(globalConfig.userControl, null)),
    credentialsMode: String(globalConfig.credentialsMode || dataset.credentialsMode || DEFAULT_RUNTIME.credentialsMode).trim(),
  };
}

function readBoolean(globalValue, datasetValue, fallback) {
  if (globalValue === true || globalValue === false) {
    return globalValue;
  }
  const value = String(globalValue ?? datasetValue ?? '').trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(value)) {
    return true;
  }
  if (['0', 'false', 'no', 'off'].includes(value)) {
    return false;
  }
  return fallback;
}

function readObject(value, fallback) {
  return value && typeof value === 'object' ? value : fallback;
}

function mergeUserControlRuntime(value) {
  const source = value && typeof value === 'object' ? value : {};
  return {
    ...DEFAULT_RUNTIME.userControl,
    ...source,
  };
}
