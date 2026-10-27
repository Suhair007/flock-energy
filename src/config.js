import 'dotenv/config';

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

const portalBaseUrl = required('PORTAL_BASE_URL').replace(/\/+$/, '');
let parsedPortalUrl;

try {
  parsedPortalUrl = new URL(portalBaseUrl);
} catch {
  throw new Error('PORTAL_BASE_URL must be a valid absolute URL');
}

if (!['http:', 'https:'].includes(parsedPortalUrl.protocol)) {
  throw new Error('PORTAL_BASE_URL must use HTTP or HTTPS');
}

const port = Number.parseInt(process.env.PORT ?? '3000', 10);
const timeoutMs = Number.parseInt(process.env.PORTAL_TIMEOUT_MS ?? '15000', 10);

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT must be an integer between 1 and 65535');
}

if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
  throw new Error('PORTAL_TIMEOUT_MS must be a positive integer');
}

export const config = {
  port,
  portalBaseUrl,
  portalEmail: required('PORTAL_EMAIL'),
  portalPassword: required('PORTAL_PASSWORD'),
  portalTimeoutMs: timeoutMs
};
