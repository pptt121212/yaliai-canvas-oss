import type {
  AsyncMediaAdapter,
  AsyncMediaQueryResult,
  AsyncMediaSubmitPayload,
  AsyncMediaSubmitResult,
} from './types.js';

export function createAsyncMediaAdapter(config: { baseUrl: string }): AsyncMediaAdapter {
  const baseUrl = String(config.baseUrl || '').replace(/\/+$/, '');
  return {
    async submit(payload: AsyncMediaSubmitPayload): Promise<AsyncMediaSubmitResult> {
      return {
        taskId: payload.external_request_id || 'mock-task-id',
        status: 'queued',
        raw: {
          mock: true,
          endpoint: `${baseUrl}/v1/videos`,
          payload,
        },
      };
    },
    async query(taskId: string): Promise<AsyncMediaQueryResult> {
      return {
        taskId,
        status: 'queued',
        url: null,
        raw: {
          mock: true,
          endpoint: `${baseUrl}/v1/videos/${taskId}`,
        },
      };
    },
  };
}
