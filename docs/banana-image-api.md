# Banana / Gemini Image API

Banana is a native image API family. It is deliberately separate from OpenAI
Images, OpenAI Responses, and Chat Completions. A Banana API Key can call only
the Gemini-compatible downstream endpoint below, and it is routed only to
Banana-compatible upstreams.

## Downstream Endpoint

```http
POST /v1beta/models/{model}:generateContent
Authorization: Bearer {tenant_api_key}
# or: x-goog-api-key: {tenant_api_key}
Content-Type: application/json
```

Text-to-image example:

```json
{
  "contents": [{
    "role": "user",
    "parts": [{ "text": "A studio photo of a red apple" }]
  }],
  "generationConfig": {
    "responseModalities": ["TEXT", "IMAGE"],
    "imageConfig": {
      "aspectRatio": "1:1",
      "imageSize": "2K"
    }
  }
}
```

For image-to-image, add one or more parts using native Base64 data:

```json
{
  "inlineData": {
    "mimeType": "image/png",
    "data": "BASE64_IMAGE_DATA"
  }
}
```

The gateway keeps the successful upstream response in Gemini candidate/part
form. It does not rewrite it into an OpenAI `data[]` response.

## Configuration

1. Add an upstream with type `Banana / Gemini image`.
2. Enter the upstream service root, for example `https://sub.g-aisc.com/`.
   Do not enter separate OpenAI `generations` or `edits` URLs. The gateway
   always calls `/v1beta/models/{model}:generateContent`.
3. Select exactly one model for that upstream. The supported catalog is fixed
   to `gemini-3-pro-image` and `gemini-3.1-flash-image`, the
   two models in the supplied Python request examples.
4. Configure the model's supported image sizes, aspect ratios,
   reference-image capability, and one fixed cost in yuan per image.
5. Enable that upstream in the image-generation channel.
6. In the pricing page, configure one sell price for each fixed model. The
   page always contains the two models and does not allow adding, renaming, or
   deleting models.
7. Issue a tenant API Key with downstream type `Banana image`; optionally
   restrict models and image sizes.

Routing treats model, `imageSize`, aspect ratio, and reference-image support as
hard eligibility conditions. It then reuses the shared health, concurrency,
latency, cost-speed ranking, cooldown, retry, and failover mechanisms.

## Billing And Cost

- The charged sell price is selected only by the model actually submitted
  upstream.
- Image size and aspect ratio are recorded for audit and capability filtering,
  not pricing.
- A fixed-provider Key price overrides the shared sell-price matrix.
- Upstream cost is selected by `upstream + model` and is written to the billing
  ledger, task record, request trace, and operational aggregates.
- A zero upstream cost is a valid configured cost and is not treated as missing.

## Upstream Request Contract

The gateway follows the supplied Python examples rather than OpenAI Images:

- It sends both `Authorization: Bearer {key}` and `x-goog-api-key: {key}` by
  default. Either mode can be selected only when an upstream requires it.
- Text-to-image sends `contents[].parts[].text` plus
  `generationConfig.responseModalities` and `generationConfig.imageConfig`.
- Image-to-image uses the same endpoint and body, adding an
  `inlineData: { mimeType, data }` part. It does not use multipart uploads,
  `images/edits`, or image URLs upstream.
- Successful images are read from the native response's `inlineData` or
  `inline_data` Base64 payload.

Each upstream represents one selected model with one fixed cost. Mark only
image sizes the upstream actually supports: an unchecked K tier is excluded
from routing, while an explicit cost of `0` remains a valid exact cost.

## Onboarding

Choose `Banana / Gemini image`, enter the service root, select one of the two
fixed models, and choose an `imageSize`. The wizard sends a native text-to-
image probe. When it can download the supplied reference image, it also sends
a separate native image-to-image probe with Base64 `inlineData`; the saved
line enables reference-image routing only when that second probe succeeds.

## Extending Native Image APIs

The shared gateway owns authentication, tenant balance checks, overload and
concurrency limits, provider health, retry and failover, traces, task
persistence, and finance outbox writes. A new native image API family should
reuse that execution path rather than create a second gateway workflow.

Its protocol-specific adapter must define only these boundaries:

1. Native downstream route, request validation, and error/success envelope.
2. Upstream request-plan construction and output validation.
3. Capability dimensions used as hard routing filters.
4. Sell-price and upstream-cost keys derived from the parameters actually sent upstream.
5. API-Key restrictions and the corresponding admin configuration fields.

Do not force distinct protocols into one untyped JSON schema. OpenAI Images,
OpenAI Responses, and Banana retain strict request and response semantics;
only their shared execution and persistence mechanisms are common. Before a
third native family is introduced, promote these boundaries into a registered
`NativeImageProtocolAdapter` so the new family is added as an adapter instead
of new `if (protocol === ...)` branches across the gateway.
