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
];

for (const testCase of cases) {
  const result = classifyUpstreamFailure(testCase.input);
  assert.equal(result.category, testCase.category, testCase.name);
  assert.equal(result.shouldFailover, testCase.shouldFailover, testCase.name);
}

console.log(`Verified ${cases.length} upstream failure classifications.`);
