import { buildCanvasRuntimeConfig } from './runtimeConfig.js';

export function readCanvasConfig() {
  return buildCanvasRuntimeConfig();
}

export const LOCAL_CANVAS_UPSTREAM_PREFERENCE_KEY = 'yali_canvas_local_upstream_preference_v1';

export function mergeCanvasSessionConfig(config, payload) {
  if (!payload || typeof payload !== 'object') {
    return config;
  }

  const serverUserControl = payload.user_control && typeof payload.user_control === 'object'
    ? payload.user_control
    : (payload.userControl && typeof payload.userControl === 'object' ? payload.userControl : config.userControl);
  const isLocalSettingsMode = serverUserControl?.entryMode === 'settings';
  const localPreference = isLocalSettingsMode
    ? readLocalCanvasUpstreamPreference()
    : null;
  const effectiveSettingsPreference = isLocalSettingsMode
    ? normalizeLocalCanvasUpstreamPreference(localPreference || {})
    : null;
  const mergedUserControl = serverUserControl
    ? {
        ...serverUserControl,
        upstreamPreference: effectiveSettingsPreference
          ? {
              mode: String(effectiveSettingsPreference.mode || 'shared_platform').trim() || 'shared_platform',
              imageApiKind: String(effectiveSettingsPreference.imageApiKind || 'images_endpoint').trim() || 'images_endpoint',
              imagesBaseUrl: String(effectiveSettingsPreference.imagesBaseUrl || '').trim(),
              imagesGenerationsUrl: String(effectiveSettingsPreference.imagesGenerationsUrl || '').trim(),
              imagesEditsUrl: String(effectiveSettingsPreference.imagesEditsUrl || '').trim(),
              imagesApiKey: String(effectiveSettingsPreference.imagesApiKey || '').trim(),
              chatBaseUrl: String(effectiveSettingsPreference.chatBaseUrl || '').trim(),
              chatApiKey: String(effectiveSettingsPreference.chatApiKey || '').trim(),
              hasImagesApiKey: Boolean(String(effectiveSettingsPreference.imagesApiKey || '').trim()),
              hasChatApiKey: Boolean(String(effectiveSettingsPreference.chatApiKey || '').trim()),
              preferredAuthMode: String(effectiveSettingsPreference.preferredAuthMode || 'bearer').trim() || 'bearer',
              chatFallbackMode: String(effectiveSettingsPreference.chatFallbackMode || 'platform_fallback').trim() || 'platform_fallback',
            }
          : serverUserControl.upstreamPreference,
      }
    : config.userControl;
  return {
    ...config,
    wpNonce: String(payload.wpNonce || config.wpNonce || '').trim(),
    sessionEndpoint: String(payload.session_endpoint || payload.sessionEndpoint || config.sessionEndpoint || '').trim(),
    isLoggedIn: Boolean(payload.isLoggedIn ?? config.isLoggedIn),
    isMember: Boolean(payload.is_member ?? payload.isMember ?? config.isMember),
    requiresMembership: Boolean(payload.canvas_requires_membership ?? payload.canvasRequiresMembership ?? config.requiresMembership),
    canvasAccess: payload.canvas_access && typeof payload.canvas_access === 'object'
      ? payload.canvas_access
      : (payload.canvasAccess && typeof payload.canvasAccess === 'object' ? payload.canvasAccess : config.canvasAccess),
    canvasChannelId: String(payload.canvas_channel_id || payload.canvasChannelId || config.canvasChannelId || '').trim(),
    canvasExecutionSource: isLocalSettingsMode
      ? 'user_supplied'
      : (String(payload.canvas_execution_source || payload.canvasExecutionSource || config.canvasExecutionSource || 'admin_managed').trim() || 'admin_managed'),
    canvasRoutingMode: String(payload.canvas_routing_mode || payload.canvasRoutingMode || config.canvasRoutingMode || '').trim(),
    executionOwnerLock: String(payload.execution_owner_lock || config.executionOwnerLock || '').trim(),
    directUpload: payload.direct_upload && typeof payload.direct_upload === 'object'
      ? payload.direct_upload
      : config.directUpload,
    lineGroup: 'official',
    currentUserId: String(payload.current_user_id || payload.currentUserId || config.currentUserId || '').trim(),
    currentUsername: String(payload.current_username || payload.currentUsername || config.currentUsername || '').trim(),
    currentUserEmail: String(payload.current_user_email || payload.currentUserEmail || config.currentUserEmail || '').trim(),
    currentTenantId: String(payload.current_tenant_id || payload.currentTenantId || config.currentTenantId || '').trim(),
    currentTenantBalanceCents: Number(payload.current_tenant_balance_cents || payload.currentTenantBalanceCents || config.currentTenantBalanceCents || 0),
    currentTenantBalanceYuan: Number(payload.current_tenant_balance_yuan || payload.currentTenantBalanceYuan || config.currentTenantBalanceYuan || 0),
    maxConcurrentGenerations: Number(payload.max_concurrent_generations || payload.maxConcurrentGenerations || config.maxConcurrentGenerations || 3),
    clearCanvasEndpoint: String(payload.clear_canvas_endpoint || payload.clearCanvasEndpoint || config.clearCanvasEndpoint || '').trim(),
    packageCanvasEndpoint: String(payload.package_canvas_endpoint || payload.packageCanvasEndpoint || config.packageCanvasEndpoint || '').trim(),
    canvasResultSelectEndpoint: String(payload.canvas_result_select_endpoint || payload.canvasResultSelectEndpoint || config.canvasResultSelectEndpoint || '').trim(),
    canvasRunStartEndpoint: String(payload.canvas_run_start_endpoint || payload.canvasRunStartEndpoint || config.canvasRunStartEndpoint || '').trim(),
    canvasRunStatusEndpoint: String(payload.canvas_run_status_endpoint || payload.canvasRunStatusEndpoint || config.canvasRunStatusEndpoint || '').trim(),
    canvasRunCancelEndpoint: String(payload.canvas_run_cancel_endpoint || payload.canvasRunCancelEndpoint || config.canvasRunCancelEndpoint || '').trim(),
    batchPreviewEndpoint: String(payload.batch_preview_endpoint || payload.batchPreviewEndpoint || config.batchPreviewEndpoint || '').trim(),
    logoIconUrl: String(payload.logo_icon_url || payload.logoIconUrl || config.logoIconUrl || '').trim() || '/logo.svg',
    authMode: String(payload.auth_mode || payload.authMode || config.authMode || '').trim(),
    authToken: String(payload.auth_token || payload.authToken || config.authToken || '').trim(),
    userControl: mergedUserControl,
  };
}

function readLocalCanvasUpstreamPreference() {
  if (typeof window === 'undefined' || !window.localStorage) {
    return null;
  }
  try {
    const raw = window.localStorage.getItem(LOCAL_CANVAS_UPSTREAM_PREFERENCE_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') {
      return null;
    }
    return normalizeLocalCanvasUpstreamPreference(parsed);
  } catch {
    return null;
  }
}

export function writeLocalCanvasUpstreamPreference(input) {
  if (typeof window === 'undefined' || !window.localStorage) {
    return null;
  }
  try {
    const normalized = normalizeLocalCanvasUpstreamPreference(input);
    window.localStorage.setItem(LOCAL_CANVAS_UPSTREAM_PREFERENCE_KEY, JSON.stringify(normalized));
    return normalized;
  } catch {
    return null;
  }
}

function normalizeLocalCanvasUpstreamPreference(input) {
  const value = input && typeof input === 'object' ? input : {};
  return {
    mode: String(value.mode || 'shared_platform').trim() || 'shared_platform',
    imageApiKind: String(value.imageApiKind || 'images_endpoint').trim() || 'images_endpoint',
    imagesBaseUrl: String(value.imagesBaseUrl || '').trim(),
    imagesGenerationsUrl: String(value.imagesGenerationsUrl || '').trim(),
    imagesEditsUrl: String(value.imagesEditsUrl || '').trim(),
    imagesApiKey: String(value.imagesApiKey || '').trim(),
    chatBaseUrl: String(value.chatBaseUrl || '').trim(),
    chatApiKey: String(value.chatApiKey || '').trim(),
    preferredAuthMode: String(value.preferredAuthMode || 'bearer').trim() || 'bearer',
    chatFallbackMode: String(value.chatFallbackMode || 'platform_fallback').trim() || 'platform_fallback',
  };
}
