import { destroyTLS, initTLS, Session } from 'node-tls-client';
import { loggers } from '../utils/logger.js';

const log = loggers.tls;

let isInitialized = false;
let initPromise = null;

const BROWSER_PROFILES = {
  firefox: 'firefox_120',
  chrome: 'chrome_120',
};

export async function ensureTLSInitialized() {
  if (isInitialized) {
    return;
  }

  if (initPromise) {
    await initPromise;
    return;
  }

  initPromise = initTLS();
  await initPromise;
  isInitialized = true;
  log.info('TLS client initialized');
}

export async function shutdownTLS() {
  if (isInitialized) {
    await destroyTLS();
    isInitialized = false;
    initPromise = null;
    log.info('TLS client shutdown complete');
  }
}

export function createTLSSession(browserType = 'firefox') {
  const profile = BROWSER_PROFILES[browserType] || BROWSER_PROFILES.firefox;

  const session = new Session({
    clientIdentifier: profile,
    timeout: 60000,
    followRedirects: true,
    forceHttp1: false,
    randomTlsExtensionOrder: true,
  });

  return session;
}

export async function tlsFetch(options) {
  const { url, method = 'GET', headers = {}, body, browserType = 'firefox' } = options;

  await ensureTLSInitialized();

  const session = createTLSSession(browserType);

  try {
    const requestOptions = {
      headers,
      body: typeof body === 'object' ? JSON.stringify(body) : body,
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

    const responseBody =
      typeof response.body === 'string' ? response.body : (await response.text?.()) || '';

    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      statusText: getStatusText(response.status),
      headers: response.headers || {},
      body: responseBody,
      text: async () => responseBody,
      json: async () => JSON.parse(responseBody || '{}'),
    };
  } finally {
    try {
      await session.close();
    } catch (closeError) {
      log.debug('Session close warning', { error: closeError.message });
    }
  }
}

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
    503: 'Service Unavailable',
  };
  return statusTexts[status] || 'Unknown';
}

process.on('SIGINT', async () => {
  log.info('Received SIGINT, shutting down');
  await shutdownTLS();
  process.exit(0);
});

process.on('beforeExit', async () => {
  await shutdownTLS();
});

export default { tlsFetch, createTLSSession, ensureTLSInitialized, shutdownTLS };
