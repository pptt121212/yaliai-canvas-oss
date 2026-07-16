export function normalizeOpenAIBaseUrl(baseUrl: string): string {
  return String(baseUrl || '')
    .trim()
    .replace(/\/+(v1\/(images\/generations|images\/edits|responses|chat\/completions))$/i, '')
    .replace(/\/+(api\/v1)$/i, '/api')
    .replace(/\/+(v1)$/i, '')
    .replace(/\/+$/, '');
}

function matchesEndpointTail(rawUrl: string, endpointPath: string): boolean {
  const raw = String(rawUrl || '').trim().replace(/\/+$/, '').toLowerCase();
  const endpoint = String(endpointPath || '').trim().replace(/\/+$/, '').toLowerCase();
  if (!raw || !endpoint) {
    return false;
  }
  if (raw.endsWith(endpoint)) {
    return true;
  }

  const endpointTail = endpoint.replace(/^\/v1/i, '');
  return Boolean(endpointTail) && raw.endsWith(endpointTail);
}

export function resolveOpenAIEndpointUrl(
  baseUrl: string,
  endpointPath: '/v1/images/generations' | '/v1/images/edits' | '/v1/responses' | '/v1/chat/completions',
): string {
  const raw = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!raw) {
    return endpointPath;
  }
  if (matchesEndpointTail(raw, endpointPath)) {
    return raw;
  }
  return `${normalizeOpenAIBaseUrl(raw)}${endpointPath}`;
}
