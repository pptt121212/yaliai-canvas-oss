# Upstream Image Compatibility

This document records the image compatibility rules used by the gateway.

The goal is simple:

- upstream: maximize compatibility and configurable adaptation
- downstream: always expose a stable OpenAI Images-compatible contract

## Compatibility Basis

The rules below are written as provider-agnostic behavior. They describe how this gateway
normalizes downstream OpenAI-compatible requests and adapts them to upstream providers with
different Images or Responses protocol capabilities.
- `sub.g-aisc.com` (`images`)
- `sub.foropencode.com` (`images`)
- `api.pixellelabs.com` (`images`)
- `gpt2image.superapi.buzz` (`images`)
- `www.jingyuapi.art` (`images`)

## Core rule

Upstream and downstream are different contracts.

The gateway must not leak upstream request or response shapes downstream.

Downstream must stay normalized to:

- `POST /v1/images/generations`
- `POST /v1/images/edits`
- synchronous JSON image result
- or standardized downstream SSE events:
  - `data: {"object":"image.generation.result"|"image.edit.result","type":"image_generation.completed"|"image_edit.completed","created":...,"data":[{"url"| "b64_json"| ...}]}`
  - `data: [DONE]`

The downstream SSE format is owned by this gateway. It is not a raw passthrough of upstream SSE.

## Upstream families

There are two primary upstream image families:

1. `Responses Endpoint`
2. `Images Endpoint`

These must stay separated in:

- onboarding detection
- upstream configuration
- request construction
- response normalization

## Responses Endpoint patterns

### Typical request pattern

Common observed request characteristics:

- endpoint: `/v1/responses`
- method: `POST`
- transport: often `SSE`
- top-level `model`: text model
- image generation lives inside `tools`
- `tool_choice` often set to `image_generation`
- edit-like behavior can still use `/v1/responses`

Common body shapes observed:

- text-to-image:
  - `input` as string or message array
  - `tools[0].type = image_generation`
  - `tools[0].size`
  - `tools[0].quality`
  - `tools[0].output_format`
  - `stream = true|false`

- reference-image generation / edit:
  - `input` usually message array
  - `content` includes:
    - `input_text`
    - one or more `input_image`
  - image sources often converted to `data URL` or base64-backed payload descriptors
  - `tools[0].action = edit`

### Important observed behavior

- Some upstreams accept plain string `input`
- Some upstreams are more reliable with multimodal message-array `input`
- Some upstreams support both text-only generation and edit-like generation under the same `/v1/responses`
- Some edit-like requests do not behave like classical `images/edits`; they are still modeled as `image_generation` tool calls

### Typical response patterns

Common observed response types:

- SSE event stream with `response.created`
- SSE event stream with `response.output_item.added`
- SSE event stream with `response.image_generation_call.*`
- partial image events
- final image result embedded in later events

Observed normalization rule:

- collect image-like outputs from SSE `data:` payloads
- support `result`
- support `b64_json`
- support direct `url`
- support data-URL image result extraction

## Images Endpoint patterns

### Typical request pattern

Common observed request characteristics:

- text-to-image:
  - endpoint: `/v1/images/generations`
  - method: `POST`
  - body often JSON

- image edit:
  - endpoint: `/v1/images/edits`
  - method: `POST`
  - body often `multipart/form-data`

Common body fields observed:

- `model`
- `prompt`
- `size`
- `resolution` as a downstream compatibility alias when `size` is an aspect ratio such as `1:1`
- `quality`
- `response_format`
- `output_format`
- `n`
- optional `stream`
- optional `async`

For edit-like requests:

- some upstreams prefer `multipart`
- some upstreams accept URL image references
- some upstreams work better with base64/data URL image references
- downstream JSON aliases such as `image_url`, `image_urls[]`, `reference_images[]`, and `images[].image_url` are normalized internally before upstream routing

### Important observed behavior

- `multipart` is the most stable default for `images/edits`
- `images/generations` is usually JSON
- some providers expose edit-like behavior through unusual paths but still semantically map to image edit
- some providers return JSON with standard `data[]`
- some providers return SSE with image events such as `image_generation.completed`
- some providers may return direct binary `image/png` or `image/jpeg`

### Typical response patterns

Observed response families:

1. standard JSON:
   - `{ created, data: [{ b64_json|url }] }`

2. SSE image stream:
   - event names can be provider-specific
   - final event may directly contain:
     - `b64_json`
     - `result`
     - `url`

3. direct binary image:
   - `Content-Type: image/png`
   - `Content-Type: image/jpeg`
   - `Content-Type: image/webp`

Observed normalization rule:

- if upstream returns standard JSON: normalize directly
- if upstream returns SSE: parse provider event payloads and extract final image item
- if upstream returns binary image: encode internally and normalize to downstream image item

## Real compatibility rules that matter

These settings have proved operationally meaningful:

- upstream kind:
  - `responses_endpoint`
  - `images_endpoint`

- image edit request body format:
  - `json`
  - `multipart`

- reference image transport:
  - `inherit`
  - `url`
  - `base64`

- upstream return mode:
  - `json`
  - `stream`

- supported response formats:
  - `url`
  - `b64_json`

- responses input shape:
  - `auto_standard`
  - `always_multimodal_message`

- responses model routing:
  - `single_top_level_model`
  - `split_text_image`

- responses tool choice:
  - `auto`
  - `image_generation`

- responses tool choice format:
  - typed object
  - string-required style

- custom injected body fields:
  - only for non-standard vendor knobs
  - example: `force_firefly`

## Settings that should not be treated as generic magic

These should not be modeled as general free-form protocol behavior:

- using custom body injection to override standard fields like:
  - `model`
  - `prompt`
  - `size`
  - `response_format`
  - `quality`
  - `stream`
  - `image`
  - `tool_choice`

Those belong to structured gateway configuration and request mapping logic.

## Downstream standardization rules

No matter what upstream does, downstream should remain:

- OpenAI Images-style request contract
- OpenAI Images-style response contract

### Downstream request contract

Text-to-image:

- `POST /v1/images/generations`
- JSON body with `model`, `prompt`, optional `size`, optional `resolution`, optional `response_format`, and related image parameters
- if `size` is a concrete pixel size, it is authoritative
- if `size` is an aspect ratio and `resolution` is `1k`, `2k`, or `4k`, the gateway maps it to the canonical pixel size before upstream submission

Reference-image generation or edit:

- `POST /v1/images/edits`
- JSON references may use `image`, `image_url`, `image_urls[]`, `reference_images[]`, or `images[].image_url`
- multipart references may use `image`, `image_url`, `image_urls`, or `reference_images`
- the gateway records whether the downstream request was multipart or JSON image URL style and uses that as an upstream routing filter; multipart edits and JSON image URL edits are not treated as generically equivalent protocols

### Downstream response contract

If downstream asks for JSON:

- return normalized `ImageResponse`
- `data[]` contains `url` or `b64_json`

If downstream asks for SSE:

- if upstream is SSE-capable:
  - normalize upstream image result into gateway-owned SSE `data:` payloads
- if upstream is non-streaming:
  - wait for full upstream result
  - then emit one normalized downstream SSE completion payload containing `object`, `type`, `created`, and `data[]`

This keeps downstream contract stable even when upstream transport differs.

## Implementation checklist

When adding or testing a new upstream:

1. detect whether upstream is `responses` or `images`
2. test text-to-image
3. test reference-image flow
4. confirm whether edit is true `/images/edits` or tool-driven `/responses`
5. confirm whether image input is best as:
   - URL
   - base64/data URL
   - multipart file
6. confirm whether upstream returns:
   - JSON
   - SSE
   - direct binary image
7. save the successful configuration in structured fields, not ad-hoc notes
8. keep downstream response normalized to OpenAI Images

## Compatibility Principles

The gateway follows these principles:

- flexible upstream adaptation
- strict downstream normalization
- provider capability fields saved as structured configuration
- zero leakage of provider-specific SSE or payload shape to downstream clients
