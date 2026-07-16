export function createWorkflowRunContext(plan = [], edges = []) {
  const runnableIds = new Set(plan.map((node) => node.id));
  const edgeStates = {};
  edges.forEach((edge) => {
    if (runnableIds.has(edge.source) || runnableIds.has(edge.target)) {
      edgeStates[edge.id] = 'waiting';
    }
  });
  return {
    runId: `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    status: 'running',
    currentNodeIds: [],
    completedNodeIds: [],
    failedNodeId: '',
    edgeStates,
  };
}

export function nextRunContextEdgeStates(context, edges, nodeIds, state, mode = 'touch') {
  if (!context || !Array.isArray(nodeIds) || !nodeIds.length) {
    return context?.edgeStates || {};
  }
  const ids = new Set(nodeIds);
  const nextStates = { ...(context.edgeStates || {}) };
  edges.forEach((edge) => {
    const sourceMatched = ids.has(edge.source);
    const targetMatched = ids.has(edge.target);
    const shouldUpdate = mode === 'incoming'
      ? targetMatched
      : mode === 'outgoing'
        ? sourceMatched
        : sourceMatched || targetMatched;
    if (shouldUpdate) {
      nextStates[edge.id] = state;
    }
  });
  return nextStates;
}
