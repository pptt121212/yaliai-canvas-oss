# Integration Guide

This project is designed to be embedded into external systems without forcing those systems
to adopt any specific account, billing, or business backend stack.

## Service boundary

This OSS repository contains two intentionally separable services:

1. backend API routing service: `apps/api`
2. frontend canvas service: `apps/web`

Recommended boundary:

- `apps/web` may run completely standalone in local mode
- `apps/api` may run completely standalone as an OpenAI-compatible image gateway
- coupling is optional and should happen only through documented runtime config and API contracts

The frontend must not assume that the backend from this repository is always present.
The backend must not assume that the frontend from this repository is always deployed.

The only acceptable built-in coupling is:

- login mode / tenant session
- tenant API key authorization
- normalized workflow execution endpoints exposed by your own backend

## Integration model

You do not need to modify the canvas core to integrate your own system.

You only need to provide these three layers:

1. runtime config provider
2. auth/session provider
3. workflow execution adapter

This project also supports two API ownership models:

1. admin-managed provider pool
2. user-supplied API credentials

Both can coexist.

## 1. Runtime config provider

Purpose:

- inject endpoints
- inject auth mode
- inject UI capabilities
- inject line group / limits / upload settings
- inject business channel and routing context

Current accepted runtime sources:

- `window.yaliCanvasRuntime`
- container `data-*`
- legacy `window.yaliFreeImageCanvas`

Recommended for new integrations:

```js
window.yaliCanvasRuntime = {
  canvasRunStartEndpoint: 'https://your-api.example.com/v1/canvas/workflow-runs',
  canvasRunStatusEndpoint: 'https://your-api.example.com/v1/canvas/workflow-runs',
  canvasRunCancelEndpoint: 'https://your-api.example.com/v1/canvas/workflow-runs/cancel',
  batchPreviewEndpoint: 'https://your-api.example.com/v1/canvas/batch-preview',
  sessionEndpoint: 'https://your-api.example.com/v1/canvas/session',
  canvasChannelId: 'channel_image_generation',
  canvasExecutionSource: 'admin_managed',
  canvasRoutingMode: 'health_weighted_best',
  authMode: 'bearer',
  authToken: 'YOUR_TOKEN',
  credentialsMode: 'omit',
  requiresMembership: false
};
```

If you do not inject any runtime config, the OSS canvas should default to standalone local mode
instead of assuming this repository's backend endpoints.

## 2. Auth/session provider

Purpose:

- refresh current user session
- refresh membership state
- determine whether the user may run the canvas
- return runtime policy overrides when needed

Expected outputs:

- `isLoggedIn`
- `isMember`
- `requiresMembership`
- `canvasAccess`
- `canvasChannelId`
- `canvasExecutionSource`
- `canvasRoutingMode`

## 3. Workflow execution adapter

Purpose:

- abstract upstream submit/query/cancel details
- start a workflow run
- query workflow run status
- cancel a run
- preview batch prompt sheet
- clear server task groups
- package result groups

The recommended place to do this is `window.yaliCanvasRuntime.canvasAdapter`, or a backend
endpoint layer that exposes the normalized contracts below.

Minimal contract:

- `POST /v1/canvas/workflow-runs`
- `GET /v1/canvas/workflow-runs?run_id=...`
- `POST /v1/canvas/workflow-runs/cancel`

When the canvas starts a workflow run it can also submit:

- `channel_id`
- `execution_source`
- `routing_mode`

## Recommended response shape

Workflow run start / status should normalize to:

```json
{
  "run_id": "run_xxx",
  "canvas_id": "canvas_xxx",
  "status": "queued",
  "node_states": [],
  "jobs": []
}
```

## Provider adapters

Provider-specific logic should stay behind your backend, not inside the canvas UI.

Examples:

- OpenAI-compatible image API
- Gemini generate content image API
- async image/video API with submit/query protocol

The canvas should only talk to your workflow execution layer.

Recommended adapter methods:

- `startRun`
- `getRunStatus`
- `cancelRun`
- `previewBatchPromptSheet`
- `clearCanvasTaskGroup`
- `packageCanvasTaskGroup`
- `refreshSession`
- optional `startImageTask` / `getImageTaskStatus` / `getImageTaskResult`

## Admin-managed vs user-supplied API

Recommended backend behavior:

- admin may configure a shared provider pool
- admin may decide whether users are allowed to bring their own API key
- routing must happen on the backend
- business channel selection should also stay on the backend, or be injected as `canvasChannelId`
- the canvas UI should only submit intent and optional user credentials

See:

- [provider-management.md](./provider-management.md)
- [upstream-image-compatibility.md](./upstream-image-compatibility.md)

## Migration rule

If a feature belongs to:

- user identity
- provider routing
- async polling

it should be implemented in providers/services, not in the core canvas UI.
