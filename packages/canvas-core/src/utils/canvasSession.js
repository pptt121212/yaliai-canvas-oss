import { mergeCanvasSessionConfig } from './canvasConfig.js';
import { refreshCanvasSessionConfig } from './canvasApi.js';

export async function fetchCanvasSessionConfig(runtimeConfig) {
  return refreshCanvasSessionConfig(runtimeConfig);
}

export function applyCanvasSessionPayload(setRuntimeConfig, payload) {
  if (!payload || typeof payload !== 'object') {
    return false;
  }
  setRuntimeConfig((current) => mergeCanvasSessionConfig(current, payload));
  return true;
}
