export function buildCanvasRequestOptions(config, options = {}) {
  const headers = {
    Accept: 'application/json',
    ...(options.headers || {}),
  };

  if (options.body && !(options.body instanceof FormData) && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }

  const authMode = String(config?.authMode || '').trim().toLowerCase();
  const authToken = String(config?.authToken || '').trim();

  if (authMode === 'bearer' && authToken) {
    headers.Authorization = `Bearer ${authToken}`;
  } else if (authMode === 'x-api-key' && authToken) {
    headers['X-API-Key'] = authToken;
  } else if (config?.wpNonce) {
    headers['X-WP-Nonce'] = config.wpNonce;
  }

  return {
    method: String(options.method || 'GET').toUpperCase(),
    headers,
    body: options.body || null,
    credentials: config?.credentialsMode || 'same-origin',
    cache: 'no-store',
    signal: options.signal,
  };
}

export async function requestCanvasJson(config, url, options = {}) {
  const method = String(options.method || 'GET').toUpperCase();
  const finalUrl = method === 'GET' ? addNoCacheParam(url) : url;
  const response = await window.fetch(finalUrl, buildCanvasRequestOptions(config, options));
  const payload = await safeJson(response);
  if (!response.ok) {
    const error = new Error(extractErrorMessage(payload) || 'Request failed.');
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

function addNoCacheParam(url) {
  return String(url || '') + (String(url || '').includes('?') ? '&' : '?') + '_yali_nc=' + encodeURIComponent(String(Date.now()) + '_' + Math.random().toString(36).slice(2));
}

export async function safeJson(response) {
  const text = await response.text();
  if (!text) {
    return {};
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    return { message: text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim() };
  }
}

export function extractErrorMessage(payload) {
  if (!payload || typeof payload !== 'object') {
    return '';
  }
  if (payload.message) {
    return String(payload.message);
  }
  if (payload.error) {
    return String(payload.error);
  }
  if (payload.data?.message) {
    return String(payload.data.message);
  }
  return '';
}
