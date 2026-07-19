import os from 'node:os';

function normalizeGatewayInstanceId(value: string) {
  return value
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .slice(0, 120);
}

const configuredGatewayInstanceId = normalizeGatewayInstanceId(String(process.env.GATEWAY_INSTANCE_ID || ''));

// Operators can set GATEWAY_INSTANCE_ID to a stable node name. The fallback is
// unique per process and remains useful before a dedicated gateway is deployed.
export const gatewayInstanceId = configuredGatewayInstanceId
  || `gateway-${normalizeGatewayInstanceId(os.hostname()) || 'unknown'}-${process.pid}`;
