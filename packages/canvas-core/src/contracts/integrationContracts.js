export function createRuntimeConfigProvider(implementation) {
  return {
    getRuntimeConfig: implementation?.getRuntimeConfig || (() => ({})),
  };
}

export function createAuthSessionProvider(implementation) {
  return {
    refreshSession: implementation?.refreshSession || (async () => ({})),
    getAccessState: implementation?.getAccessState || (() => ({ ok: true, reason: '' })),
  };
}

export function createCanvasAdapter(implementation) {
  return {
    startImageTask: implementation?.startImageTask,
    getImageTaskStatus: implementation?.getImageTaskStatus,
    getImageTaskResult: implementation?.getImageTaskResult,
    startRun: implementation?.startRun || (async () => { throw new Error('Missing workflow execution provider.'); }),
    getRunStatus: implementation?.getRunStatus || (async () => ({ status: 'idle', jobs: [] })),
    cancelRun: implementation?.cancelRun || (async () => ({ success: false, reason: 'missing_provider' })),
    previewBatchPromptSheet: implementation?.previewBatchPromptSheet || (async () => { throw new Error('Missing batch preview provider.'); }),
    clearCanvasTaskGroup: implementation?.clearCanvasTaskGroup || (async () => ({ success: false, reason: 'missing_provider' })),
    packageCanvasTaskGroup: implementation?.packageCanvasTaskGroup || (async () => ({ success: false, reason: 'missing_provider' })),
    refreshSession: implementation?.refreshSession,
    uploadReferenceAsset: implementation?.uploadReferenceAsset,
  };
}

export function createWorkflowExecutionProvider(implementation) {
  return createCanvasAdapter(implementation);
}
