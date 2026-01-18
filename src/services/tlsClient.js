/**
 * TLS Client Wrapper
 * Uses node-tls-client to bypass Cloudflare TLS fingerprinting
 * by mimicking real browser TLS/JA3 fingerprints
 */
import { Session, initTLS, destroyTLS } from 'node-tls-client';
import { loggers } from '../utils/logger.js';

const log = loggers.tls;

// Track initialization state
let isInitialized = false;
let initPromise = null;

// Browser profiles that mimic real browser TLS fingerprints
const BROWSER_PROFILES = {
  firefox: 'firefox_120',
  chrome: 'chrome_120'
};

/**
 * Initialize the TLS client library
 * Must be called before making any requests
 * Safe to call multiple times - will only initialize once
 */
export async function ensureTLSInitialized() {
  if (isInitialized) {
    return;
  }

  if (initPromise) {
    // Already initializing, wait for it
    await initPromise;
    return;
  }

  initPromise = initTLS();
  await initPromise;
  isInitialized = true;
  log.info('TLS client initialized');
}

/**
 * Shutdown the TLS client library
 * Call this on process exit for clean shutdown
 */
export async function shutdownTLS() {
  if (isInitialized) {
    await destroyTLS();
    isInitialized = false;
    initPromise = null;
    log.info('TLS client shutdown complete');
  }
}

/**
 * Create a TLS session with browser-like fingerprint
 * @param {string} browserType - 'firefox' or 'chrome'
 * @returns {Session} TLS client session
 */
export function createTLSSession(browserType = 'firefox') {
  const profile = BROWSER_PROFILES[browserType] || BROWSER_PROFILES.firefox;

  const session = new Session({
    clientIdentifier: profile,
    // Timeout settings (in milliseconds for node-tls-client v2+)
    timeout: 60000,
    // Follow redirects like a browser
    followRedirects: true,
    // Enable HTTP/2 like modern browsers
    forceHttp1: false,
    // Random TLS extension order like real browsers
    randomTlsExtensionOrder: true
  });

  return session;
}

/**
 * Make a request using TLS client with browser fingerprint
 * @param {object} options - Request options
 * @param {string} options.url - URL to request
 * @param {string} options.method - HTTP method (GET, POST, etc.)
 * @param {object} options.headers - Request headers
 * @param {string|object} options.body - Request body
 * @param {string} options.browserType - Browser type to mimic ('firefox' or 'chrome')
 * @returns {Promise<{status: number, headers: object, body: string}>}
 */
export async function tlsFetch(options) {
  const { url, method = 'GET', headers = {}, body, browserType = 'firefox' } = options;

  // Ensure TLS client is initialized
  await ensureTLSInitialized();

  const session = createTLSSession(browserType);

  try {
    const requestOptions = {
      headers,
      // node-tls-client expects body as string
      body: typeof body === 'object' ? JSON.stringify(body) : body
    };

    let response;

    switch (method.toUpperCase()) {
      case 'POST':
        response = await session.post(url, requestOptions);
        break;
      case 'GET':
        response = await session.get(url, requestOptions);
        break;
      case 'PUT':
        response = await session.put(url, requestOptions);
        break;
      case 'DELETE':
        response = await session.delete(url, requestOptions);
        break;
      default:
        response = await session.get(url, requestOptions);
    }

    // Handle response - node-tls-client may return body differently
    const responseBody = typeof response.body === 'string'
      ? response.body
      : (await response.text?.()) || '';

    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      statusText: getStatusText(response.status),
      headers: response.headers || {},
      body: responseBody,
      // Helper to get text (already a string)
      text: async () => responseBody,
      // Helper to parse JSON
      json: async () => JSON.parse(responseBody || '{}')
    };
  } finally {
    // Clean up session
    try {
      await session.close();
    } catch (closeError) {
      log.debug('Session close warning', { error: closeError.message });
    }
  }
}

/**
 * Get status text for HTTP status code
 */
function getStatusText(status) {
  const statusTexts = {
    200: 'OK',
    201: 'Created',
    400: 'Bad Request',
    401: 'Unauthorized',
    403: 'Forbidden',
    404: 'Not Found',
    429: 'Too Many Requests',
    500: 'Internal Server Error',
    502: 'Bad Gateway',
    503: 'Service Unavailable'
  };
  return statusTexts[status] || 'Unknown';
}


process.on('SIGINT', async () => {
  log.info('Received SIGINT, shutting down');
  await shutdownTLS();
  process.exit(0);
});

// Register shutdown handler for clean exit
process.on('beforeExit', async () => {
  await shutdownTLS();
});

export default { tlsFetch, createTLSSession, ensureTLSInitialized, shutdownTLS };
