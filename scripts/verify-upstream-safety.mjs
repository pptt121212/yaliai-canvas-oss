import assert from 'node:assert/strict';

// The classifier is pure, but its module graph also declares repository
// singletons. A syntactically valid local URL keeps this check offline.
process.env.DATABASE_URL ||= 'postgresql://localhost:5432/yali_safety_check';

const { classifyUpstreamFailure } = await import('../apps/api/dist/src/smartImageRouting.js');

const cases = [
  {
    name: 'OpenAI content policy error code',
    input: {
      statusCode: 400,
      bodyJson: { error: { code: 'content_policy_violation', message: 'content rejected' } },
    },
    category: 'terminal_safety',
    shouldFailover: false,
  },
  {
    name: 'Responses safety rejection',
    input: {
      statusCode: 400,
      bodyJson: { error: { code: 'responses_safety_rejected', message: 'rejected by the safety system' } },
    },
    category: 'terminal_safety',
    shouldFailover: false,
  },
  {
    name: 'Temporary upstream overload remains retryable',
    input: {
      statusCode: 503,
      bodyJson: { error: { message: 'server busy and overloaded' } },
    },
    category: 'retryable_overloaded',
    shouldFailover: true,
  },
  {
    name: 'Upstream quota failure remains retryable',
    input: {
      statusCode: 400,
      bodyJson: { error: { code: 'insufficient_user_quota', message: 'quota exceeded' } },
    },
    category: 'retryable_upstream_quota',
    shouldFailover: true,
  },
  {
    name: 'Upstream authentication failure remains retryable',
    input: {
      statusCode: 401,
      bodyJson: { error: { code: 'invalid_api_key', message: 'invalid api key' } },
    },
    category: 'retryable_upstream_auth',
    shouldFailover: true,
  },
  {
    name: 'Disabled upstream channel fails over',
    input: {
      statusCode: 400,
      bodyJson: { error: { code: 'channel_dispatch_disabled', message: '当前分组绑定的渠道未开启调度，请联系客服处理。' } },
    },
    category: 'retryable_upstream_dispatch',
    shouldFailover: true,
  },
];

for (const testCase of cases) {
  const result = classifyUpstreamFailure(testCase.input);
  assert.equal(result.category, testCase.category, testCase.name);
  assert.equal(result.shouldFailover, testCase.shouldFailover, testCase.name);
}

console.log(`Verified ${cases.length} upstream failure classifications.`);
