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
2. Configure its authentication mode, endpoint prefix, models, image sizes,
   aspect ratios, reference-image support, and cost in yuan per image.
3. Enable that upstream in the image-generation channel.
4. In the pricing page, configure every sell-price key as `model + imageSize`.
5. Issue a tenant API Key with downstream type `Banana image`; optionally
   restrict models and image sizes.

Routing treats model, `imageSize`, aspect ratio, and reference-image support as
hard eligibility conditions. It then reuses the shared health, concurrency,
latency, cost-speed ranking, cooldown, retry, and failover mechanisms.

## Billing And Cost

- The charged sell price is selected by the model and `imageSize` actually
  submitted upstream.
- Aspect ratio is recorded for audit and capability filtering, not pricing.
- A fixed-provider Key price overrides the shared sell-price matrix.
- Upstream cost is selected by `upstream + model + imageSize` and is written to
  the billing ledger, task record, request trace, and operational aggregates.
- A zero upstream cost is a valid configured cost and is not treated as missing.

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
