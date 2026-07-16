# Provider Management

This project supports two provider sources:

## 1. Admin-managed providers

These are configured by the system administrator on the server side.

Use cases:

- shared platform routing
- managed billing
- health checks
- traffic shaping
- failover and cooldown
- team or SaaS deployments

## 2. User-supplied providers

These are supplied by the end user from the canvas UI or user settings.

Use cases:

- bring-your-own-key
- private account usage
- personal routing
- hybrid self-host / hosted mode

## Policy rule

The administrator should be able to decide:

- whether user-supplied providers are allowed
- which models are allowed
- whether user traffic may bypass admin-managed pools

## Routing goals

The backend must remain responsible for:

- provider eligibility filtering
- model compatibility filtering
- health/cooldown filtering
- load balancing strategy
- fallback routing

The canvas UI should not decide which upstream provider is chosen.

## Image routing modes

Tenant API keys can use these image routing modes:

- `smart_failover`: score eligible providers and retry subsequent candidates after retryable upstream failures.
- `smart_priority`: score providers but only attempt the highest-ranked candidate.
- `fixed_provider`: send requests to the provider bound to the API key.

## Health model

Each provider may be in one of these states:

- `healthy`
- `cooling`
- `degraded`
- `disabled`

## Deployment modes

You can expose either or both provider sources:

- server-managed provider pool
- user-supplied provider path

This gives operators the ability to run:

- fully managed mode
- hybrid mode
- pure bring-your-own-key mode

## Upstream image compatibility

Image upstreams are not homogeneous.

This project intentionally separates:

- `responses_endpoint`
- `images_endpoint`

The backend must adapt upstream differences, while downstream stays standardized.

See:

- [upstream-image-compatibility.md](./upstream-image-compatibility.md)
