function hasRedisUrl() {
  return Boolean(String(process.env.REDIS_URL || '').trim());
}

function hasPm2ProcessMarker() {
  return typeof process.env.NODE_APP_INSTANCE !== 'undefined'
    || typeof process.env.pm_id !== 'undefined';
}

export function isSharedHotStateRequired() {
  if (String(process.env.ALLOW_INMEMORY_HOT_STATE || '').trim() === '1') {
    return false;
  }
  if (String(process.env.REQUIRE_SHARED_HOT_STATE || '').trim() === '1') {
    return true;
  }
  if (String(process.env.CANVAS_WORKER_ONLY || '').trim() === '1') {
    return true;
  }
  return hasPm2ProcessMarker();
}

export function isSharedHotStateStrict() {
  return isSharedHotStateRequired();
}

export function requireSharedHotState(feature: string) {
  if (isSharedHotStateRequired() && !hasRedisUrl()) {
    throw new Error(`${feature}_requires_redis_shared_state`);
  }
}
