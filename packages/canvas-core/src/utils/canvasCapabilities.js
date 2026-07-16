export function ensureCanvasAccess(runtimeConfig) {
  const explicitAccess = runtimeConfig?.canvasAccess && typeof runtimeConfig.canvasAccess === 'object'
    ? runtimeConfig.canvasAccess
    : null;

  if (explicitAccess) {
    return {
      ok: explicitAccess.allowed !== false,
      reason: String(explicitAccess.reason || (explicitAccess.allowed === false ? 'access_denied' : '')).trim(),
      message: String(explicitAccess.message || '').trim(),
    };
  }

  if (!runtimeConfig?.requiresMembership) {
    return { ok: true, reason: '' };
  }
  if (!runtimeConfig?.isLoggedIn) {
    return { ok: false, reason: 'login_required' };
  }
  if (!runtimeConfig?.isMember) {
    return { ok: false, reason: 'membership_required' };
  }
  return { ok: true, reason: '' };
}
