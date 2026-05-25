import fs from 'node:fs';
import path from 'node:path';
import {
  CloudflareBlockedError,
  NetworkError,
  RefreshTokenExpiredError,
  TokenRefreshError,
} from '../errors/authErrors.js';
import { loggers } from '../utils/logger.js';
import { tlsFetch } from './tlsClient.js';

const log = loggers.hopgpt;
const DEFAULT_PROACTIVE_REFRESH_BUFFER_SEC = 600;
const DEFAULT_TOKEN_PROVIDER = 'openid';

// In-process mutex for .env file writes
let envWritePromise = null;

function maskToken(token) {
  if (!token) return '<not set>';
  if (token.length <= 24) return '<too short>';
  return `${token.substring(0, 10)}...${token.substring(token.length - 10)}`;
}

function configOrEnv(configValue, envValue) {
  return configValue === undefined ? envValue : configValue;
}

function resolveTokenProvider(configTokenProvider, openidUserId) {
  const configuredProvider = configOrEnv(
    configTokenProvider,
    process.env.HOPGPT_COOKIE_TOKEN_PROVIDER,
  );
  if (openidUserId && (!configuredProvider || configuredProvider.toLowerCase() === 'librechat')) {
    return DEFAULT_TOKEN_PROVIDER;
  }
  return configuredProvider || DEFAULT_TOKEN_PROVIDER;
}

function resolveChatEndpoint(endpointName, defaultEndpoint) {
  if (typeof endpointName !== 'string' || endpointName.trim().length === 0) {
    return defaultEndpoint;
  }

  const trimmed = endpointName.trim();
  if (trimmed.startsWith('/')) {
    return trimmed;
  }
  return `/api/agents/chat/${encodeURIComponent(trimmed)}`;
}

function isTestRuntime() {
  const isBunTestCommand = Boolean(process.versions?.bun) && process.argv.includes('test');
  return (
    process.env.VITEST === 'true' ||
    process.env.BUN_TEST === '1' ||
    process.env.NODE_ENV === 'test' ||
    isBunTestCommand
  );
}

export class HopGPTClient {
  constructor(config = {}) {
    this.baseURL = config.baseURL || 'https://chat.ai.jh.edu';
    this.endpoint = config.endpoint || '/api/agents/chat/AnthropicClaude';
    this.streamEndpointPrefix = config.streamEndpointPrefix || '/api/agents/chat/stream/';
    this.bearerToken = configOrEnv(config.bearerToken, process.env.HOPGPT_BEARER_TOKEN);
    this.userAgent = configOrEnv(config.userAgent, process.env.HOPGPT_USER_AGENT);
    const openidUserId = configOrEnv(config.openidUserId, process.env.HOPGPT_COOKIE_OPENID_USER_ID);
    const refreshToken = configOrEnv(config.refreshToken, process.env.HOPGPT_COOKIE_REFRESH_TOKEN);
    this.cookies = {
      cf_clearance: configOrEnv(config.cfClearance, process.env.HOPGPT_COOKIE_CF_CLEARANCE),
      connect_sid: configOrEnv(config.connectSid, process.env.HOPGPT_COOKIE_CONNECT_SID),
      __cf_bm: configOrEnv(config.cfBm, process.env.HOPGPT_COOKIE_CF_BM),
      // HopGPT's OpenID refresh path normally reads server-side tokens via
      // connect.sid, then falls back to the refreshToken cookie when the
      // session no longer has those tokens.
      refreshToken,
      openid_user_id: openidUserId,
      token_provider: resolveTokenProvider(config.tokenProvider, openidUserId),
    };
    this.autoRefresh = config.autoRefresh !== false;
    this.streamingTransport = (
      config.streamingTransport ||
      process.env.HOPGPT_STREAMING_TRANSPORT ||
      'fetch'
    ).toLowerCase();
    this.refreshPromise = null;
    this.proactiveRefreshBufferSec = parsePositiveInteger(
      config.proactiveRefreshBufferSec ?? process.env.HOPGPT_PROACTIVE_REFRESH_BUFFER_SECONDS,
      DEFAULT_PROACTIVE_REFRESH_BUFFER_SEC,
    );

    // Test runners mock refreshes; never let those overwrite a developer's .env.
    this.autoPersist = config.autoPersist ?? !isTestRuntime();
    this.envPath = config.envPath || path.join(process.cwd(), '.env');

    this.rateLimitConfig = {
      maxRetries: config.rateLimitMaxRetries ?? 3,
      baseDelayMs: config.rateLimitBaseDelayMs ?? 1000,
      maxDelayMs: config.rateLimitMaxDelayMs ?? 30000,
      maxWaitTimeMs: config.rateLimitMaxWaitTimeMs ?? 10000,
    };
  }

  _extractRetryAfter(headers) {
    const retryAfter = this._getHeaderValue(headers, 'retry-after');
    if (!retryAfter) {
      return null;
    }

    const seconds = Number.parseInt(retryAfter, 10);
    if (!Number.isNaN(seconds)) {
      return seconds * 1000;
    }

    const date = new Date(retryAfter);
    if (!Number.isNaN(date.getTime())) {
      const delayMs = date.getTime() - Date.now();
      return Math.max(0, delayMs);
    }

    return null;
  }

  _getHeaderValue(headers, name) {
    if (!headers) {
      return '';
    }

    let value;
    if (typeof headers.get === 'function') {
      value = headers.get(name);
    } else {
      value = headers[name] || headers[name.toLowerCase()];
      if (value === undefined) {
        const headerEntry = Object.entries(headers).find(
          ([key]) => key.toLowerCase() === name.toLowerCase(),
        );
        value = headerEntry?.[1];
      }
    }

    if (Array.isArray(value)) {
      return value[0] || '';
    }
    if (value === undefined || value === null) {
      return '';
    }
    return String(value);
  }

  _calculateBackoffDelay(attempt, retryAfterMs) {
    if (retryAfterMs !== null && retryAfterMs <= this.rateLimitConfig.maxWaitTimeMs) {
      return retryAfterMs;
    }

    const exponentialDelay = this.rateLimitConfig.baseDelayMs * 2 ** attempt;
    const jitter = Math.random() * 0.3 * exponentialDelay;
    const delay = Math.min(exponentialDelay + jitter, this.rateLimitConfig.maxDelayMs);

    return Math.round(delay);
  }

  async _sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  _resolveBrowserType() {
    return this.userAgent?.toLowerCase().includes('firefox') ? 'firefox' : 'chrome';
  }

  buildBrowserHeaders(browserType) {
    const detectedBrowser = this.userAgent?.toLowerCase().includes('firefox')
      ? 'firefox'
      : 'chrome';
    const browser = browserType || detectedBrowser;

    if (browser === 'firefox') {
      return {
        'User-Agent':
          this.userAgent ||
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:146.0) Gecko/20100101 Firefox/146.0',
        'Accept-Language': 'en-US,en;q=0.5',
        'Accept-Encoding': 'gzip, deflate, br, zstd',
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-origin',
        Connection: 'keep-alive',
        Priority: 'u=0',
        TE: 'trailers',
      };
    }

    return {
      'User-Agent':
        this.userAgent ||
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br, zstd',
      'Cache-Control': 'no-cache',
      Pragma: 'no-cache',
      'Sec-Ch-Ua': '"Chromium";v="136", "Google Chrome";v="136", "Not.A/Brand";v="99"',
      'Sec-Ch-Ua-Mobile': '?0',
      'Sec-Ch-Ua-Platform': '"macOS"',
      'Sec-Fetch-Dest': 'empty',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'same-origin',
      Connection: 'keep-alive',
      Priority: 'u=4, i',
    };
  }

  hasRefreshCredential() {
    return Boolean(this.hasSessionRefreshCredential() || this.cookies.refreshToken);
  }

  hasSessionRefreshCredential() {
    return Boolean(this.cookies.connect_sid && this.cookies.openid_user_id);
  }

  getRefreshCredentialKind() {
    if (this.hasSessionRefreshCredential()) {
      return 'session';
    }
    if (this.cookies.refreshToken) {
      return 'refreshToken';
    }
    return 'none';
  }

  buildCookieHeader() {
    const cookies = [];

    if (this.cookies.cf_clearance) {
      cookies.push(`cf_clearance=${this.cookies.cf_clearance}`);
    }
    if (this.cookies.connect_sid) {
      cookies.push(`connect.sid=${this.cookies.connect_sid}`);
    }
    if (this.cookies.__cf_bm) {
      cookies.push(`__cf_bm=${this.cookies.__cf_bm}`);
    }
    if (this.cookies.token_provider) {
      cookies.push(`token_provider=${this.cookies.token_provider}`);
    }
    if (this.cookies.refreshToken) {
      cookies.push(`refreshToken=${this.cookies.refreshToken}`);
    }
    if (this.cookies.openid_user_id) {
      cookies.push(`openid_user_id=${this.cookies.openid_user_id}`);
    }

    return cookies.join('; ');
  }

  updateCookiesFromResponse(headers) {
    const setCookieHeaders = headers.getSetCookie?.() || [];
    this._parseCookies(setCookieHeaders);
  }

  updateCookiesFromTLSResponse(headers) {
    let setCookieHeaders = headers['set-cookie'] || headers['Set-Cookie'] || [];
    if (typeof setCookieHeaders === 'string') {
      setCookieHeaders = [setCookieHeaders];
    }
    this._parseCookies(setCookieHeaders);
  }

  _parseCookies(setCookieHeaders) {
    for (const cookieStr of setCookieHeaders) {
      const [cookiePart] = cookieStr.split(';');
      // Split on the first '=' only — cookie values can contain '=' (e.g. base64-padded JWTs).
      const equalsIndex = cookiePart.indexOf('=');
      if (equalsIndex === -1) continue;
      const name = cookiePart.substring(0, equalsIndex);
      const value = cookiePart.substring(equalsIndex + 1);

      if (name === 'connect.sid') {
        this.cookies.connect_sid = value;
        log.debug('Session cookie (connect.sid) rotated');
      } else if (name === 'refreshToken') {
        this.cookies.refreshToken = value;
        log.debug('Refresh token cookie rotated');
      } else if (name === 'openid_user_id') {
        this.cookies.openid_user_id = value;
        log.debug('OpenID user cookie rotated');
      } else if (name === 'token_provider') {
        this.cookies.token_provider = value;
      } else if (name === 'cf_clearance') {
        this.cookies.cf_clearance = value;
      } else if (name === '__cf_bm') {
        this.cookies.__cf_bm = value;
      }
    }
  }

  async persistCredentials() {
    if (!this.autoPersist) {
      log.debug('Auto-persist disabled, skipping .env write');
      return;
    }

    if (envWritePromise) {
      log.debug('Waiting for pending .env write to complete');
      await envWritePromise;
    }

    const sessionToSave = this.cookies.connect_sid;
    const refreshTokenToSave = this.cookies.refreshToken;
    const openidIdToSave = this.cookies.openid_user_id;
    const bearerTokenToSave = this.bearerToken;
    const refreshCredentialKind = this.getRefreshCredentialKind();

    log.debug('Persisting credentials to .env', {
      sessionMasked: maskToken(sessionToSave),
      refreshTokenMasked: maskToken(refreshTokenToSave),
      openidIdMasked: maskToken(openidIdToSave),
      bearerTokenMasked: maskToken(bearerTokenToSave),
      refreshCredentialKind,
    });

    const writeOperation = (async () => {
      try {
        let existingContent = '';
        const preservedLines = [];

        const tokenVars = new Set([
          'HOPGPT_BEARER_TOKEN',
          'HOPGPT_COOKIE_CONNECT_SID',
          'HOPGPT_COOKIE_OPENID_USER_ID',
          'HOPGPT_COOKIE_TOKEN_PROVIDER',
          'HOPGPT_COOKIE_REFRESH_TOKEN',
        ]);

        if (fs.existsSync(this.envPath)) {
          existingContent = fs.readFileSync(this.envPath, 'utf-8');

          for (const line of existingContent.split('\n')) {
            const trimmed = line.trim();

            const isTokenVar = Array.from(tokenVars).some(
              (v) => trimmed.startsWith(`${v}=`) || trimmed.startsWith(`# ${v}=`),
            );

            if (!isTokenVar) {
              preservedLines.push(line);
            }
          }
        }

        const tokenLines = [];
        if (bearerTokenToSave) {
          tokenLines.push(`HOPGPT_BEARER_TOKEN=${bearerTokenToSave}`);
        }
        if (sessionToSave) {
          tokenLines.push(`HOPGPT_COOKIE_CONNECT_SID=${sessionToSave}`);
        }
        if (refreshTokenToSave) {
          tokenLines.push(`HOPGPT_COOKIE_REFRESH_TOKEN=${refreshTokenToSave}`);
        }
        if (openidIdToSave) {
          tokenLines.push(`HOPGPT_COOKIE_OPENID_USER_ID=${openidIdToSave}`);
        }
        if (this.cookies.token_provider) {
          tokenLines.push(`HOPGPT_COOKIE_TOKEN_PROVIDER=${this.cookies.token_provider}`);
        }

        let insertIndex = 0;
        for (let i = 0; i < preservedLines.length; i++) {
          const line = preservedLines[i].trim();
          if (line.startsWith('#') || line === '') {
            insertIndex = i + 1;
          } else {
            break;
          }
        }

        preservedLines.splice(insertIndex, 0, ...tokenLines);

        let finalContent = preservedLines.join('\n');
        if (!finalContent.endsWith('\n')) {
          finalContent += '\n';
        }

        fs.writeFileSync(this.envPath, finalContent);

        const verifyContent = fs.readFileSync(this.envPath, 'utf-8');
        const verifiedSid =
          verifyContent.match(/^HOPGPT_COOKIE_CONNECT_SID=(.+)$/m)?.[1]?.trim() || null;
        const verifiedOpenid =
          verifyContent.match(/^HOPGPT_COOKIE_OPENID_USER_ID=(.+)$/m)?.[1]?.trim() || null;
        const verifiedRefreshToken =
          verifyContent.match(/^HOPGPT_COOKIE_REFRESH_TOKEN=(.+)$/m)?.[1]?.trim() || null;
        const writeVerified =
          (!sessionToSave || verifiedSid === sessionToSave) &&
          (!openidIdToSave || verifiedOpenid === openidIdToSave) &&
          (!refreshTokenToSave || verifiedRefreshToken === refreshTokenToSave);

        if (writeVerified) {
          log.info('Credentials persisted and verified in .env', {
            refreshCredentialKind,
            sessionMasked: maskToken(verifiedSid),
            refreshTokenMasked: maskToken(verifiedRefreshToken),
          });
        } else {
          log.error('CRITICAL: .env verification failed — credential mismatch', {
            expectedSessionMasked: maskToken(sessionToSave),
            actualSessionMasked: maskToken(verifiedSid),
            expectedRefreshTokenMasked: maskToken(refreshTokenToSave),
            actualRefreshTokenMasked: maskToken(verifiedRefreshToken),
            expectedOpenidMasked: maskToken(openidIdToSave),
            actualOpenidMasked: maskToken(verifiedOpenid),
          });
        }
      } catch (error) {
        log.error('Failed to persist credentials', { error: error.message, stack: error.stack });
      } finally {
        envWritePromise = null;
      }
    })();

    envWritePromise = writeOperation;
    return writeOperation;
  }

  _getTokenExpiryInfo(token) {
    return parseTokenExpiry(token);
  }

  _shouldProactivelyRefresh() {
    if (!this.autoRefresh || !this.hasRefreshCredential()) {
      return false;
    }

    const expiryInfo = this._getTokenExpiryInfo(this.bearerToken);
    if (!expiryInfo) {
      // No parseable expiry (missing bearer, non-JWT, or malformed) — refresh proactively.
      return true;
    }

    return expiryInfo.expiresInSeconds <= this.proactiveRefreshBufferSec;
  }

  async ensureValidToken() {
    if (this._shouldProactivelyRefresh()) {
      const expiryInfo = this._getTokenExpiryInfo(this.bearerToken);
      let reason;
      if (!this.bearerToken) {
        reason = 'no bearer token';
      } else if (!expiryInfo) {
        reason = 'bearer token is not a valid JWT';
      } else if (expiryInfo.isExpired) {
        reason = 'bearer token expired';
      } else {
        reason = `bearer token expires in ${expiryInfo.expiresInSeconds}s (buffer: ${this.proactiveRefreshBufferSec}s)`;
      }
      log.info(`Proactive token refresh: ${reason}`);
      return await this.refreshTokens();
    }
    return true;
  }

  async refreshTokens() {
    if (this.refreshPromise) {
      log.info('Waiting for ongoing token refresh');
      return this.refreshPromise;
    }

    if (!this.hasRefreshCredential()) {
      log.error(
        'No HopGPT refresh credential available — run: npm run extract to capture connect.sid/openid_user_id cookies',
      );
      return false;
    }

    const refreshOperation = (async () => {
      try {
        return await this._doRefreshTokens();
      } finally {
        this.refreshPromise = null;
      }
    })();

    this.refreshPromise = refreshOperation;
    return refreshOperation;
  }

  async _doRefreshTokens() {
    log.info('Attempting token refresh', {
      refreshCredentialKind: this.getRefreshCredentialKind(),
      refreshTokenPresent: !!this.cookies.refreshToken,
      refreshTokenMasked: maskToken(this.cookies.refreshToken),
      openidIdPresent: !!this.cookies.openid_user_id,
      openidIdMasked: maskToken(this.cookies.openid_user_id),
      sessionPresent: !!this.cookies.connect_sid,
      sessionMasked: maskToken(this.cookies.connect_sid),
    });

    try {
      const url = `${this.baseURL}/api/auth/refresh`;

      const browserType = this.userAgent?.toLowerCase().includes('firefox') ? 'firefox' : 'chrome';

      const headers = {
        ...this.buildBrowserHeaders(browserType),
        Accept: 'application/json, text/plain, */*',
        Origin: this.baseURL,
        Referer: `${this.baseURL}/`,
      };

      const cookieHeader = this.buildCookieHeader();
      if (cookieHeader) {
        headers.Cookie = cookieHeader;
      }

      const response = await tlsFetch({
        url,
        method: 'POST',
        headers,
        browserType,
      });

      const rawBody = response.body || '';

      if (!response.ok) {
        log.error('Token refresh failed', {
          status: response.status,
          statusText: response.statusText,
        });
        log.debug('Refresh error response body', { body: rawBody });

        if (response.status === 401 || response.status === 403) {
          throw new RefreshTokenExpiredError();
        } else if (
          response.status === 503 ||
          rawBody.includes('cf-') ||
          rawBody.includes('cloudflare')
        ) {
          throw new CloudflareBlockedError();
        }
        return false;
      }

      // Parse the response to get the new bearer token.
      // Some LibreChat builds return 200 OK with a plain-text error body like
      // "Refresh token has expired" when the session is no longer valid — handle
      // non-JSON bodies as auth failures rather than letting JSON.parse throw.
      let data;
      try {
        data = await response.json();
      } catch (parseError) {
        const bodyPreview = rawBody.slice(0, 200);
        log.error('Refresh response was not JSON (likely a session error from the server)', {
          bodyPreview,
          parseError: parseError.message,
        });
        if (/refresh\s*token|session|unauthori[sz]ed|expired/i.test(rawBody)) {
          throw new RefreshTokenExpiredError();
        }
        if (rawBody.includes('cf-') || rawBody.includes('cloudflare')) {
          throw new CloudflareBlockedError();
        }
        throw new NetworkError(new Error(`Non-JSON refresh response: ${bodyPreview}`));
      }

      if (data.token) {
        this.bearerToken = data.token;
        const newTokenInfo = this._getTokenExpiryInfo(data.token);
        log.info('Bearer token refreshed', {
          expiresIn: newTokenInfo ? `${newTokenInfo.expiresInSeconds}s` : 'unknown',
        });
      } else {
        log.error('Refresh response did not contain token');
        return false;
      }

      // Update cookies from Set-Cookie headers (server may rotate connect.sid,
      // openid_user_id, token_provider, and on older deployments refreshToken).
      const oldRefreshToken = this.cookies.refreshToken;
      const oldSid = this.cookies.connect_sid;
      const oldOpenidId = this.cookies.openid_user_id;

      const setCookieHeaders = response.headers['set-cookie'] || response.headers['Set-Cookie'];
      if (setCookieHeaders) {
        const headerArray = Array.isArray(setCookieHeaders) ? setCookieHeaders : [setCookieHeaders];
        log.debug('Received Set-Cookie headers', {
          count: headerArray.length,
          cookieNames: headerArray.map((h) => h.split('=')[0]).join(', '),
        });
      }

      this.updateCookiesFromTLSResponse(response.headers);

      if (this.cookies.refreshToken && this.cookies.refreshToken !== oldRefreshToken) {
        log.info('Refresh token cookie rotated by server', {
          old: maskToken(oldRefreshToken),
          new: maskToken(this.cookies.refreshToken),
        });
      }
      if (this.cookies.connect_sid && this.cookies.connect_sid !== oldSid) {
        log.info('Session cookie rotated by server', {
          old: maskToken(oldSid),
          new: maskToken(this.cookies.connect_sid),
        });
      }
      if (this.cookies.openid_user_id && this.cookies.openid_user_id !== oldOpenidId) {
        log.info('OpenID user cookie rotated by server', {
          old: maskToken(oldOpenidId),
          new: maskToken(this.cookies.openid_user_id),
        });
      }
      if (!this.hasRefreshCredential()) {
        log.error('No refresh credential after refresh — future refreshes will fail', {
          hadOldRefreshToken: !!oldRefreshToken,
          hadOldSession: !!oldSid,
          hasOpenidUser: !!this.cookies.openid_user_id,
        });
      }

      await this.persistCredentials();

      return true;
    } catch (error) {
      if (
        error instanceof RefreshTokenExpiredError ||
        error instanceof CloudflareBlockedError ||
        error instanceof NetworkError
      ) {
        throw error;
      }
      log.error('Token refresh error', { error: error.message });
      throw new NetworkError(error);
    }
  }

  _shouldUseFetchForStreaming() {
    if (this.streamingTransport === 'tls') {
      return false;
    }

    if (typeof fetch !== 'function') {
      log.debug('fetch not available, falling back to TLS client for streaming');
      return false;
    }

    return true;
  }

  _sanitizeHeadersForFetch(headers) {
    const forbidden = new Set([
      'connection',
      'content-length',
      'accept-encoding',
      'transfer-encoding',
      'upgrade',
      'host',
      'keep-alive',
      'proxy-connection',
      'te',
      'trailer',
    ]);

    const sanitized = {};
    for (const [key, value] of Object.entries(headers)) {
      if (!forbidden.has(key.toLowerCase())) {
        sanitized[key] = value;
      }
    }
    return sanitized;
  }

  async _readResponseText(response) {
    if (!response) {
      return '';
    }

    if (typeof response.text === 'function') {
      try {
        return await response.text();
      } catch (_error) {
        return '';
      }
    }

    return response.body || '';
  }

  // Phase 1 of the HopGPT chat protocol: POST the chat request and parse the
  // JSON acknowledgment. Retries and refreshes are handled by sendMessage().
  async startStream(hopGPTRequest, requestOptions = {}) {
    if (!hopGPTRequest || typeof hopGPTRequest !== 'object' || Array.isArray(hopGPTRequest)) {
      throw new Error('startStream requires an object hopGPTRequest');
    }

    if (requestOptions.signal?.aborted) {
      throw new Error('Request aborted');
    }

    const browserType = this._resolveBrowserType();
    const headers = {
      ...this.buildBrowserHeaders(browserType),
      'Content-Type': 'application/json',
      Accept: 'application/json, text/plain, */*',
      Origin: this.baseURL,
      Referer: `${this.baseURL}/c/new`,
    };
    if (this.bearerToken) {
      headers.Authorization = `Bearer ${this.bearerToken}`;
    }
    const cookieHeader = this.buildCookieHeader();
    if (cookieHeader) {
      headers.Cookie = cookieHeader;
    }

    const endpoint = resolveChatEndpoint(hopGPTRequest.endpoint, this.endpoint);
    const response = await tlsFetch({
      url: `${this.baseURL}${endpoint}`,
      method: 'POST',
      headers,
      body: hopGPTRequest,
      browserType,
    });

    if (!response.ok) {
      const body = await this._readResponseText(response);
      const retryAfterMs = this._extractRetryAfter(response.headers);
      throw new HopGPTError(
        response.status,
        response.statusText || `HTTP ${response.status}`,
        body,
        retryAfterMs,
      );
    }

    const rawBody = await this._readResponseText(response);
    let parsed;
    try {
      parsed = JSON.parse(rawBody);
    } catch (_error) {
      throw new HopGPTError(502, 'Malformed stream ack from HopGPT', rawBody.slice(0, 500));
    }

    if (!parsed || typeof parsed.streamId !== 'string' || parsed.streamId.trim().length === 0) {
      throw new HopGPTError(502, 'Malformed stream ack from HopGPT', rawBody.slice(0, 500));
    }

    return {
      streamId: parsed.streamId,
      conversationId: parsed.conversationId,
      status: parsed.status,
    };
  }

  // Phase 2: subscribe to SSE for a previously acknowledged streamId.
  async subscribeStream(streamId, requestOptions = {}) {
    if (typeof streamId !== 'string' || streamId.trim().length === 0) {
      throw new Error('subscribeStream requires a non-empty streamId');
    }

    if (requestOptions.signal?.aborted) {
      throw new Error('Request aborted');
    }

    const browserType = this._resolveBrowserType();
    const headers = {
      ...this.buildBrowserHeaders(browserType),
      Accept: '*/*',
      'Cache-Control': 'no-cache',
      Pragma: 'no-cache',
      Referer: `${this.baseURL}/c/new`,
    };
    if (this.bearerToken) {
      headers.Authorization = `Bearer ${this.bearerToken}`;
    }
    const cookieHeader = this.buildCookieHeader();
    if (cookieHeader) {
      headers.Cookie = cookieHeader;
    }

    const url = `${this.baseURL}${this.streamEndpointPrefix}${encodeURIComponent(streamId)}`;

    let response;
    let usedFetch = false;

    if (this._shouldUseFetchForStreaming()) {
      try {
        response = await fetch(url, {
          method: 'GET',
          headers: this._sanitizeHeadersForFetch(headers),
          signal: requestOptions.signal,
        });
        usedFetch = true;
      } catch (error) {
        if (error?.name === 'AbortError') {
          throw error;
        }
        log.debug('subscribeStream fetch failed, falling back to tlsFetch', {
          error: error.message,
        });
      }
    }

    if (!usedFetch) {
      response = await tlsFetch({
        url,
        method: 'GET',
        headers,
        browserType,
      });
    }

    if (!response.ok) {
      const body = await this._readResponseText(response);
      const retryAfterMs = this._extractRetryAfter(response.headers);
      throw new HopGPTError(
        response.status,
        response.statusText || `HTTP ${response.status}`,
        body,
        retryAfterMs,
      );
    }

    const contentType = this._getHeaderValue(response.headers, 'content-type');
    const normalizedType = contentType.trim().toLowerCase();
    if (!normalizedType.startsWith('text/event-stream')) {
      const body = await this._readResponseText(response);
      throw new HopGPTError(
        502,
        `Expected text/event-stream from stream endpoint, got: ${contentType || '<missing>'}`,
        body.slice(0, 500),
      );
    }

    if (usedFetch) {
      return response;
    }
    return this._createStreamResponse(response);
  }

  async sendMessage(hopGPTRequest, requestOptions = {}, retryState = {}) {
    retryState = {
      isAuthRetry: false,
      rateLimitAttempt: 0,
      isPostAckAuthRetry: false,
      postAckRateLimitAttempt: 0,
      ...retryState,
    };
    if (!retryState.isAuthRetry) {
      const tokenInfo = this._getTokenExpiryInfo(this.bearerToken);
      if (tokenInfo && tokenInfo.expiresInSeconds <= this.proactiveRefreshBufferSec + 60) {
        log.debug('Token nearing expiry', {
          expiresIn: `${tokenInfo.expiresInSeconds}s`,
          buffer: `${this.proactiveRefreshBufferSec}s`,
        });
      }
      const tokenValid = await this.ensureValidToken();
      if (!tokenValid) {
        throw new TokenRefreshError('Failed to obtain valid authentication token before request');
      }
    }

    const signal = requestOptions.signal;

    // ----- Phase 1: POST (pre-ack). Failures here rerun the whole sequence. -----
    let ack;
    try {
      ack = await this.startStream(hopGPTRequest, { signal });
    } catch (error) {
      if (error instanceof HopGPTError && error.statusCode === 429) {
        const { rateLimitAttempt } = retryState;
        const retryAfterMs = error.retryAfterMs ?? null;
        log.warn('Rate limited on POST (pre-ack)', {
          attempt: `${rateLimitAttempt + 1}/${this.rateLimitConfig.maxRetries}`,
          retryAfter: retryAfterMs !== null ? `${retryAfterMs}ms` : 'not specified',
        });
        if (retryAfterMs !== null && retryAfterMs > this.rateLimitConfig.maxWaitTimeMs) {
          throw error;
        }
        if (rateLimitAttempt < this.rateLimitConfig.maxRetries) {
          const waitTime = this._calculateBackoffDelay(rateLimitAttempt, retryAfterMs);
          await this._sleep(waitTime);
          return this.sendMessage(hopGPTRequest, requestOptions, {
            ...retryState,
            rateLimitAttempt: rateLimitAttempt + 1,
          });
        }
        log.error('Rate limit retries exhausted on POST (pre-ack)', {
          attempts: rateLimitAttempt + 1,
        });
        throw error;
      }
      if (
        error instanceof HopGPTError &&
        (error.statusCode === 401 || error.statusCode === 403) &&
        this.autoRefresh &&
        !retryState.isAuthRetry
      ) {
        log.warn('Auth error on POST (pre-ack); attempting refresh', { status: error.statusCode });
        const refreshed = await this.refreshTokens();
        if (refreshed) {
          log.info('Retrying POST (pre-ack) with refreshed token');
          return this.sendMessage(hopGPTRequest, requestOptions, {
            ...retryState,
            isAuthRetry: true,
          });
        }
        log.warn('Token refresh failed; not retrying POST (pre-ack)');
      }
      throw error;
    }

    if (signal?.aborted) {
      throw new Error('Request aborted');
    }

    // ----- Phase 2: GET (post-ack). Failures retry GET only, same streamId. -----
    return this._subscribeWithRetry(ack, requestOptions, retryState);
  }

  // Post-ack retries must reuse the same streamId; never re-POST after ack.
  async _subscribeWithRetry(ack, requestOptions, retryState) {
    const signal = requestOptions.signal;
    try {
      return await this.subscribeStream(ack.streamId, { signal });
    } catch (error) {
      if (error instanceof HopGPTError && error.statusCode === 429) {
        const attempt = retryState.postAckRateLimitAttempt;
        const retryAfterMs = error.retryAfterMs ?? null;
        log.warn('Rate limited on GET (post-ack)', {
          attempt: `${attempt + 1}/${this.rateLimitConfig.maxRetries}`,
          retryAfter: retryAfterMs !== null ? `${retryAfterMs}ms` : 'not specified',
          streamId: ack.streamId,
        });
        if (retryAfterMs !== null && retryAfterMs > this.rateLimitConfig.maxWaitTimeMs) {
          throw error;
        }
        if (attempt < this.rateLimitConfig.maxRetries) {
          const waitTime = this._calculateBackoffDelay(attempt, retryAfterMs);
          await this._sleep(waitTime);
          return this._subscribeWithRetry(ack, requestOptions, {
            ...retryState,
            postAckRateLimitAttempt: attempt + 1,
          });
        }
        log.error('Rate limit retries exhausted on GET (post-ack); NOT re-POSTing', {
          attempts: attempt + 1,
          streamId: ack.streamId,
        });
        throw error;
      }
      if (
        error instanceof HopGPTError &&
        (error.statusCode === 401 || error.statusCode === 403) &&
        this.autoRefresh &&
        !retryState.isPostAckAuthRetry
      ) {
        log.warn('Auth error on GET (post-ack); attempting refresh (GET-only retry)', {
          status: error.statusCode,
          streamId: ack.streamId,
        });
        const refreshed = await this.refreshTokens();
        if (refreshed) {
          log.info('Retrying GET with refreshed token, reusing streamId', {
            streamId: ack.streamId,
          });
          return this._subscribeWithRetry(ack, requestOptions, {
            ...retryState,
            isPostAckAuthRetry: true,
          });
        }
        log.warn('Token refresh failed; not retrying GET (post-ack)');
      }
      throw error;
    }
  }

  _createStreamResponse(tlsResponse) {
    const body = tlsResponse.body || '';

    const stream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(encoder.encode(body));
        controller.close();
      },
    });

    return {
      ok: tlsResponse.ok,
      status: tlsResponse.status,
      statusText: tlsResponse.statusText,
      headers: tlsResponse.headers,
      body: stream,
      _rawBody: body,
      text: async () => body,
      json: async () => JSON.parse(body),
    };
  }

  validateAuth() {
    const missing = [];
    const warnings = [];

    const hasRefreshCredential = this.hasRefreshCredential();

    if (!this.cookies.openid_user_id) {
      warnings.push(
        'HOPGPT_COOKIE_OPENID_USER_ID not set; OpenID cookie context may be incomplete',
      );
    }

    if (!this.cookies.connect_sid) {
      warnings.push('HOPGPT_COOKIE_CONNECT_SID not set; Express session may be rejected');
    }

    if (!this.cookies.cf_clearance) {
      warnings.push('HOPGPT_COOKIE_CF_CLEARANCE not set; Cloudflare may block requests');
    }

    if (!this.cookies.__cf_bm) {
      warnings.push('HOPGPT_COOKIE_CF_BM not set; Cloudflare may block requests');
    }

    if (!this.userAgent) {
      warnings.push('HOPGPT_USER_AGENT not set; Cloudflare may require a browser user agent');
    }

    if (!hasRefreshCredential) {
      warnings.push(
        'No refresh credential configured; set HOPGPT_COOKIE_CONNECT_SID with HOPGPT_COOKIE_OPENID_USER_ID, or legacy HOPGPT_COOKIE_REFRESH_TOKEN',
      );
    }

    if (!this.bearerToken) {
      if (hasRefreshCredential) {
        warnings.push('HOPGPT_BEARER_TOKEN not set; will attempt to refresh on first request');
      } else {
        missing.push(
          'HOPGPT_BEARER_TOKEN or refresh credentials (HOPGPT_COOKIE_CONNECT_SID + HOPGPT_COOKIE_OPENID_USER_ID)',
        );
      }
    }

    return {
      valid: missing.length === 0,
      missing,
      warnings,
    };
  }
}

export class HopGPTError extends Error {
  constructor(statusCode, message, responseBody = null, retryAfterMs = null) {
    super(message);
    this.name = 'HopGPTError';
    this.statusCode = statusCode;
    this.responseBody = responseBody;
    this.retryAfterMs = retryAfterMs;
  }

  toAnthropicError() {
    let errorType = 'api_error';

    if (this.statusCode === 401 || this.statusCode === 403) {
      errorType = 'authentication_error';
    } else if (this.statusCode === 400) {
      errorType = 'invalid_request_error';
    } else if (this.statusCode === 429) {
      errorType = 'rate_limit_error';
    } else if (this.statusCode >= 500) {
      errorType = 'api_error';
    }

    const error = {
      type: 'error',
      error: {
        type: errorType,
        message: this.message,
      },
    };

    if (this.statusCode === 429 && this.retryAfterMs !== null) {
      error.error.retry_after_seconds = Math.ceil(this.retryAfterMs / 1000);
    }

    return error;
  }
}

let defaultClient = null;

export function getDefaultClient() {
  if (!defaultClient) {
    defaultClient = new HopGPTClient();
  }
  return defaultClient;
}

export function resetDefaultClient() {
  defaultClient = null;
}

export function getTokenExpiryInfo(token) {
  const expiry = parseTokenExpiry(token);
  if (!expiry) {
    return null;
  }

  const expiresAt = new Date(expiry.expiresAtMs);
  if (Number.isNaN(expiresAt.getTime())) {
    return null;
  }

  return {
    expiresAt: expiresAt.toISOString(),
    expiresAtMs: expiry.expiresAtMs,
    expiresInSeconds: Math.max(0, expiry.expiresInSeconds),
    isExpired: expiry.isExpired,
  };
}

function parseTokenExpiry(token) {
  if (!token) {
    return null;
  }

  const parts = token.split('.');
  if (parts.length < 2) {
    return null;
  }

  try {
    const payload = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const paddedPayload = payload.padEnd(Math.ceil(payload.length / 4) * 4, '=');
    const decoded = Buffer.from(paddedPayload, 'base64').toString('utf8');
    const data = JSON.parse(decoded);

    if (typeof data.exp !== 'number') {
      return null;
    }

    const expiresAtMs = data.exp * 1000;
    if (!Number.isFinite(expiresAtMs)) {
      return null;
    }

    const expiresInSeconds = Math.floor((expiresAtMs - Date.now()) / 1000);

    return {
      expiresAtMs,
      expiresInSeconds,
      isExpired: expiresInSeconds <= 0,
    };
  } catch (_error) {
    return null;
  }
}

function parsePositiveInteger(value, fallback) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }

  return parsed;
}
