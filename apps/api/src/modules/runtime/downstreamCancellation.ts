type ResponseLike = {
  writableEnded?: boolean;
  once(event: 'finish' | 'close', listener: () => void): unknown;
  removeListener(event: 'finish' | 'close', listener: () => void): unknown;
};

type RequestLike = {
  aborted?: boolean;
};

export class DownstreamClientDisconnectedError extends Error {
  constructor() {
    super('The downstream client disconnected before the upstream request completed.');
    this.name = 'DownstreamClientDisconnectedError';
  }
}

export function isDownstreamClientDisconnectedError(error: unknown): error is DownstreamClientDisconnectedError {
  if (error instanceof DownstreamClientDisconnectedError) {
    return true;
  }
  return Boolean(
    error
    && typeof error === 'object'
    && (error as { name?: unknown }).name === 'DownstreamClientDisconnectedError',
  );
}

export function createDownstreamCancellation(input: {
  request: RequestLike;
  response: ResponseLike;
}) {
  const controller = new AbortController();
  let responseFinished = false;

  const abort = () => {
    if (!controller.signal.aborted) {
      controller.abort(new DownstreamClientDisconnectedError());
    }
  };
  const onFinish = () => {
    responseFinished = true;
  };
  const onClose = () => {
    // ServerResponse emits close after a normal finish too. Only a close
    // before finish represents a disconnected downstream client.
    if (!responseFinished && !input.response.writableEnded) {
      abort();
    }
  };

  if (input.request.aborted) {
    abort();
  }
  input.response.once('finish', onFinish);
  input.response.once('close', onClose);

  return {
    signal: controller.signal,
    dispose() {
      input.response.removeListener('finish', onFinish);
      input.response.removeListener('close', onClose);
    },
  };
}

export function throwIfDownstreamCancelled(signal?: AbortSignal) {
  if (!signal?.aborted) {
    return;
  }
  if (isDownstreamClientDisconnectedError(signal.reason)) {
    throw signal.reason;
  }
  throw signal.reason instanceof Error ? signal.reason : new Error('Upstream request was aborted.');
}
