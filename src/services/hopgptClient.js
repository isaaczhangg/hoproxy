import { tlsFetch } from './tlsClient.js';
import fs from 'fs';
import path from 'path';
import { loggers } from '../utils/logger.js';
import {
  TokenRefreshError,
  RefreshTokenExpiredError,
  CloudflareBlockedError,
  NetworkError
} from '../errors/authErrors.js';

const log = loggers.hopgpt;

// In-process mutex for .env file writes
let envWritePromise = null;

/**
 * Mask a token for safe logging (show first 10 and last 10 chars)
 * @param {string} token - Token to mask
 * @returns {string} Masked token
 */
function maskToken(token) {
  if (!token) return '<not set>';
  if (token.length <= 24) return '<too short>';
  return `${token.substring(0, 10)}...${token.substring(token.length - 10)}`;
}

/**
 * HopGPT API Client
 * Handles authentication and communication with the HopGPT backend
 * Uses node-tls-client to bypass Cloudflare TLS fingerprinting
 */
export class HopGPTClient {
  constructor(config = {}) {
    this.baseURL = config.baseURL || 'https://chat.ai.jh.edu';
    this.endpoint = config.endpoint || '/api/agents/chat/AnthropicClaude';
    this.bearerToken = config.bearerToken || process.env.HOPGPT_BEARER_TOKEN;
    this.userAgent = config.userAgent || process.env.HOPGPT_USER_AGENT;
    this.cookies = {
      cf_clearance: config.cfClearance || process.env.HOPGPT_COOKIE_CF_CLEARANCE,
      connect_sid: config.connectSid || process.env.HOPGPT_COOKIE_CONNECT_SID,
      __cf_bm: config.cfBm || process.env.HOPGPT_COOKIE_CF_BM,
      refreshToken: config.refreshToken || process.env.HOPGPT_COOKIE_REFRESH_TOKEN,
      token_provider: config.tokenProvider || process.env.HOPGPT_COOKIE_TOKEN_PROVIDER || 'librechat'
    };
    this.autoRefresh = config.autoRefresh !== false;
    this.streamingTransport = (config.streamingTransport ||
      process.env.HOPGPT_STREAMING_TRANSPORT ||
      'fetch').toLowerCase();
    this.refreshPromise = null;
    this.proactiveRefreshBufferSec = config.proactiveRefreshBufferSec ?? 300;
    
    // Auto-persist credentials to .env after refresh
    this.autoPersist = config.autoPersist !== false;
    this.envPath = config.envPath || path.join(process.cwd(), '.env');

    // Rate limiting configuration
    this.rateLimitConfig = {
      maxRetries: config.rateLimitMaxRetries ?? 3,
      baseDelayMs: config.rateLimitBaseDelayMs ?? 1000,
      maxDelayMs: config.rateLimitMaxDelayMs ?? 30000,
      maxWaitTimeMs: config.rateLimitMaxWaitTimeMs ?? 10000  // Wait for short limits (≤10 sec)
    };
  }

  /**
   * Extract retry delay from Retry-After header
   * @param {object} headers - Response headers
   * @returns {number|null} Delay in milliseconds, or null if not present
   */
  _extractRetryAfter(headers) {
    if (!headers) {
      return null;
    }

    let retryAfter;
    if (typeof headers.get === 'function') {
      retryAfter = headers.get('retry-after');
    } else {
      retryAfter = headers['retry-after'] || headers['Retry-After'];
    }
    if (!retryAfter) {
      return null;
    }

    // Retry-After can be either a number of seconds or an HTTP-date
    const seconds = parseInt(retryAfter, 10);
    if (!isNaN(seconds)) {
      return seconds * 1000;
    }

    // Try parsing as HTTP-date
    const date = new Date(retryAfter);
    if (!isNaN(date.getTime())) {
      const delayMs = date.getTime() - Date.now();
      return Math.max(0, delayMs);
    }

    return null;
  }

  /**
   * Calculate exponential backoff delay
   * @param {number} attempt - Current retry attempt (0-indexed)
   * @param {number|null} retryAfterMs - Retry-After header value in milliseconds
   * @returns {number} Delay in milliseconds
   */
  _calculateBackoffDelay(attempt, retryAfterMs) {
    // If Retry-After is provided and within our max wait time, use it
    if (retryAfterMs !== null && retryAfterMs <= this.rateLimitConfig.maxWaitTimeMs) {
      return retryAfterMs;
    }

    // Otherwise, use exponential backoff: baseDelay * 2^attempt with jitter
    const exponentialDelay = this.rateLimitConfig.baseDelayMs * Math.pow(2, attempt);
    const jitter = Math.random() * 0.3 * exponentialDelay; // 0-30% jitter
    const delay = Math.min(exponentialDelay + jitter, this.rateLimitConfig.maxDelayMs);

    return Math.round(delay);
  }

  /**
   * Sleep for a specified duration
   * @param {number} ms - Duration in milliseconds
   */
  async _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Build browser-like headers to pass Cloudflare bot detection
   * Headers are ordered to match real browser request patterns
   * @param {string} browserType - 'firefox' or 'chrome' to match the browser used for cookie extraction
   * @returns {object} Headers object with browser-like values
   */
  buildBrowserHeaders(browserType) {
    // Detect browser type from User-Agent if available
    const detectedBrowser = this.userAgent?.toLowerCase().includes('firefox') ? 'firefox' : 'chrome';
    const browser = browserType || detectedBrowser;

    if (browser === 'firefox') {
      // Firefox-specific headers (matching HAR capture exactly)
      const headers = {
        'User-Agent': this.userAgent || 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:146.0) Gecko/20100101 Firefox/146.0',
        'Accept-Language': 'en-US,en;q=0.5',
        'Accept-Encoding': 'gzip, deflate, br, zstd',
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-origin',
        'Connection': 'keep-alive',
        'Priority': 'u=0',
        'TE': 'trailers'
      };
      return headers;
    } else {
      // Chrome-specific headers
      const headers = {
        'User-Agent': this.userAgent || 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br, zstd',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache',
        'Sec-Ch-Ua': '"Chromium";v="136", "Google Chrome";v="136", "Not.A/Brand";v="99"',
        'Sec-Ch-Ua-Mobile': '?0',
        'Sec-Ch-Ua-Platform': '"macOS"',
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-origin',
        'Connection': 'keep-alive',
        'Priority': 'u=4, i'
      };
      return headers;
    }
  }

  /**
   * Build the cookie header string from configured cookies
   * @returns {string} Cookie header value
   */
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
    if (this.cookies.refreshToken) {
      cookies.push(`refreshToken=${this.cookies.refreshToken}`);
    }
    if (this.cookies.token_provider) {
      cookies.push(`token_provider=${this.cookies.token_provider}`);
    }

    return cookies.join('; ');
  }

  /**
   * Parse Set-Cookie headers and update internal cookie state
   * @param {Headers} headers - Response headers (native fetch Headers object)
   */
  updateCookiesFromResponse(headers) {
    const setCookieHeaders = headers.getSetCookie?.() || [];
    this._parseCookies(setCookieHeaders);
  }

  /**
   * Parse Set-Cookie headers from TLS client response
   * @param {object} headers - Response headers object from TLS client
   */
  updateCookiesFromTLSResponse(headers) {
    // TLS client returns headers as an object, Set-Cookie may be a string or array
    let setCookieHeaders = headers['set-cookie'] || headers['Set-Cookie'] || [];
    if (typeof setCookieHeaders === 'string') {
      setCookieHeaders = [setCookieHeaders];
    }
    this._parseCookies(setCookieHeaders);
  }

  /**
   * Parse cookie strings and update internal state
   * @param {string[]} setCookieHeaders - Array of Set-Cookie header values
   */
  _parseCookies(setCookieHeaders) {
    for (const cookieStr of setCookieHeaders) {
      const [cookiePart] = cookieStr.split(';');
      // Split only on the first '=' to preserve '=' characters in the value
      // (common in base64-encoded tokens like JWTs)
      const equalsIndex = cookiePart.indexOf('=');
      if (equalsIndex === -1) continue;
      const name = cookiePart.substring(0, equalsIndex);
      const value = cookiePart.substring(equalsIndex + 1);

      if (name === 'refreshToken') {
        this.cookies.refreshToken = value;
        log.debug('Refresh token updated');
      } else if (name === 'connect.sid') {
        this.cookies.connect_sid = value;
      } else if (name === 'cf_clearance') {
        this.cookies.cf_clearance = value;
      } else if (name === '__cf_bm') {
        this.cookies.__cf_bm = value;
      }
    }
  }

  /**
   * Persist current credentials to .env file
   * Updates only the token-related variables, preserving other settings
   */
  async persistCredentials() {
    if (!this.autoPersist) {
      log.debug('Auto-persist disabled, skipping .env write');
      return;
    }

    if (envWritePromise) {
      log.debug('Waiting for pending .env write to complete');
      await envWritePromise;
    }

    const refreshTokenToSave = this.cookies.refreshToken;
    const bearerTokenToSave = this.bearerToken;
    
    log.debug('Persisting credentials to .env', {
      refreshTokenMasked: maskToken(refreshTokenToSave),
      bearerTokenMasked: maskToken(bearerTokenToSave)
    });

    // Create the write operation and store it in the mutex
    const writeOperation = (async () => {
      try {
        let existingContent = '';
        const preservedLines = [];

        // Variables we will update
        const tokenVars = new Set([
          'HOPGPT_BEARER_TOKEN',
          'HOPGPT_COOKIE_REFRESH_TOKEN'
        ]);

        // Read existing .env if it exists
        if (fs.existsSync(this.envPath)) {
          existingContent = fs.readFileSync(this.envPath, 'utf-8');

          for (const line of existingContent.split('\n')) {
            const trimmed = line.trim();

            // Check if this line sets a token variable we want to update
            const isTokenVar = Array.from(tokenVars).some(v =>
              trimmed.startsWith(`${v}=`) || trimmed.startsWith(`# ${v}=`)
            );

            if (!isTokenVar) {
              preservedLines.push(line);
            }
          }
        }

        // Build new token lines
        const tokenLines = [];
        if (bearerTokenToSave) {
          tokenLines.push(`HOPGPT_BEARER_TOKEN=${bearerTokenToSave}`);
        }
        if (refreshTokenToSave) {
          tokenLines.push(`HOPGPT_COOKIE_REFRESH_TOKEN=${refreshTokenToSave}`);
        }

        // Find where to insert token lines (after header comments, before other content)
        let insertIndex = 0;
        for (let i = 0; i < preservedLines.length; i++) {
          const line = preservedLines[i].trim();
          if (line.startsWith('#') || line === '') {
            insertIndex = i + 1;
          } else {
            break;
          }
        }

        // Insert token lines
        preservedLines.splice(insertIndex, 0, ...tokenLines);

        // Ensure file ends with newline
        let finalContent = preservedLines.join('\n');
        if (!finalContent.endsWith('\n')) {
          finalContent += '\n';
        }

        // Write back to .env
        fs.writeFileSync(this.envPath, finalContent);

        // Verify the write succeeded by reading back the refresh token
        const verifyContent = fs.readFileSync(this.envPath, 'utf-8');
        const verifyMatch = verifyContent.match(/^HOPGPT_COOKIE_REFRESH_TOKEN=(.+)$/m);
        const verifiedToken = verifyMatch ? verifyMatch[1].trim() : null;
        
        if (refreshTokenToSave && verifiedToken === refreshTokenToSave) {
          log.info('Credentials persisted and verified in .env', {
            refreshTokenMasked: maskToken(verifiedToken)
          });
        } else if (refreshTokenToSave) {
          log.error('CRITICAL: .env verification failed - token mismatch!', {
            expectedMasked: maskToken(refreshTokenToSave),
            actualMasked: maskToken(verifiedToken)
          });
        } else {
          log.debug('Credentials persisted to .env (no refresh token to verify)');
        }
      } catch (error) {
        log.error('Failed to persist credentials', { error: error.message, stack: error.stack });
      } finally {
        // Clear the mutex when done
        envWritePromise = null;
      }
    })();

    envWritePromise = writeOperation;
    return writeOperation;
  }

  /**
   * Get expiry info for a JWT token
   * @param {string} token - JWT token
   * @returns {object|null} Expiry info or null if not a valid JWT
   */
  _getTokenExpiryInfo(token) {
    return parseTokenExpiry(token);
  }

  /**
   * Check if bearer token needs proactive refresh
   * @returns {boolean} True if token should be refreshed
   */
  _shouldProactivelyRefresh() {
    if (!this.autoRefresh || !this.cookies.refreshToken) {
      return false;
    }

    const expiryInfo = this._getTokenExpiryInfo(this.bearerToken);
    if (!expiryInfo) {
      // If we have no bearer token or can't decode it as JWT, refresh proactively
      // This fixes the case where bearerToken exists but is invalid/malformed
      return true;
    }

    // Refresh if token expires within the buffer period
    return expiryInfo.expiresInSeconds <= this.proactiveRefreshBufferSec;
  }

  /**
   * Perform proactive token refresh if needed
   * @returns {Promise<boolean>} True if tokens are valid (refreshed or already valid)
   */
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

  /**
   * Refresh the bearer token using the refresh token
   * @returns {Promise<boolean>} True if refresh succeeded
   * @throws {RefreshTokenExpiredError} When refresh token has expired
   * @throws {CloudflareBlockedError} When blocked by Cloudflare
   * @throws {NetworkError} When network error occurs
   */
  async refreshTokens() {
    if (this.refreshPromise) {
      log.info('Waiting for ongoing token refresh');
      return this.refreshPromise;
    }

    if (!this.cookies.refreshToken) {
      log.error('No refresh token available');
      return false;
    }

    const refreshOperation = (async () => {
      try {
        return await this._doRefreshTokens();
      } finally {
        // Clear the promise only after the operation completes
        this.refreshPromise = null;
      }
    })();

    this.refreshPromise = refreshOperation;
    return refreshOperation;
  }

  /**
   * Internal method that performs the actual token refresh
   * @returns {Promise<boolean>} True if refresh succeeded
   * @private
   */
  async _doRefreshTokens() {
    const refreshTokenInfo = this._getTokenExpiryInfo(this.cookies.refreshToken);
    
    // Enhanced diagnostic logging for refresh token state
    log.info('Attempting token refresh', {
      refreshTokenExpiry: refreshTokenInfo ? `${refreshTokenInfo.expiresInSeconds}s` : 'invalid',
      refreshTokenMasked: maskToken(this.cookies.refreshToken)
    });
    
    if (!refreshTokenInfo) {
      log.warn('Refresh token diagnostics', {
        tokenLength: this.cookies.refreshToken?.length || 0,
        hasThreeParts: this.cookies.refreshToken?.split('.').length === 3,
        note: 'Token may not be a standard JWT or may be corrupted'
      });
    } else {
      log.debug('Refresh token info:', 
        `expires in ${Math.round(refreshTokenInfo.expiresInSeconds / 3600)}h, expired: ${refreshTokenInfo.isExpired}`);
    }

    try {
      const url = `${this.baseURL}/api/auth/refresh`;

      // Detect browser type from User-Agent
      const browserType = this.userAgent?.toLowerCase().includes('firefox') ? 'firefox' : 'chrome';

      // Start with browser-like headers to pass Cloudflare
      // Use the same headers as real browser requests
      const headers = {
        ...this.buildBrowserHeaders(browserType),
        'Content-Type': 'application/json',
        'Accept': '*/*',
        'Origin': this.baseURL,
        'Referer': `${this.baseURL}/`
      };

      const cookieHeader = this.buildCookieHeader();
      if (cookieHeader) {
        headers['Cookie'] = cookieHeader;
      }

      // Use TLS client with browser fingerprint to bypass Cloudflare
      const response = await tlsFetch({
        url,
        method: 'POST',
        headers,
        body: '{}',
        browserType
      });

      if (!response.ok) {
        const errorText = response.body || '';
        log.error('Token refresh failed', { status: response.status, statusText: response.statusText });
        log.debug('Refresh error response body', { body: errorText });
        
        // Classify the error based on status code and response
        if (response.status === 401 || response.status === 403) {
          throw new RefreshTokenExpiredError();
        } else if (response.status === 503 || errorText.includes('cf-') || errorText.includes('cloudflare')) {
          throw new CloudflareBlockedError();
        }
        // Generic failure - return false for backwards compatibility
        return false;
      }

      // Parse the response to get the new bearer token
      const data = await response.json();

      if (data.token) {
        this.bearerToken = data.token;
        const newTokenInfo = this._getTokenExpiryInfo(data.token);
        log.info('Bearer token refreshed', { expiresIn: newTokenInfo ? `${newTokenInfo.expiresInSeconds}s` : 'unknown' });
      } else {
        log.error('Refresh response did not contain token');
        return false;
      }

      // Update cookies from Set-Cookie headers (includes rotated refresh token)
      const oldRefreshToken = this.cookies.refreshToken;
      const oldRefreshMasked = maskToken(oldRefreshToken);
      
      const setCookieHeaders = response.headers['set-cookie'] || response.headers['Set-Cookie'];
      if (setCookieHeaders) {
        const headerArray = Array.isArray(setCookieHeaders) ? setCookieHeaders : [setCookieHeaders];
        log.debug('Received Set-Cookie headers', { 
          count: headerArray.length,
          cookieNames: headerArray.map(h => h.split('=')[0]).join(', ')
        });
      } else {
        log.warn('No Set-Cookie headers in refresh response - refresh token will NOT be rotated');
      }
      
      this.updateCookiesFromTLSResponse(response.headers);

      // Check if refresh token was rotated
      const newRefreshMasked = maskToken(this.cookies.refreshToken);
      if (this.cookies.refreshToken && this.cookies.refreshToken !== oldRefreshToken) {
        log.info('Refresh token rotated by server', {
          oldToken: oldRefreshMasked,
          newToken: newRefreshMasked
        });
        const newRefreshInfo = this._getTokenExpiryInfo(this.cookies.refreshToken);
        log.info('New refresh token expiry', { expiresIn: newRefreshInfo ? `${Math.round(newRefreshInfo.expiresInSeconds / 3600)}h` : 'unknown' });
      } else if (!this.cookies.refreshToken) {
        log.error('No refresh token after refresh - future refreshes will fail!', {
          hadOldToken: !!oldRefreshToken,
          oldToken: oldRefreshMasked
        });
      } else {
        log.debug('Refresh token NOT rotated (same token)', { token: newRefreshMasked });
      }

      // Persist new credentials to .env so they survive server restarts
      await this.persistCredentials();

      return true;
    } catch (error) {
      if (error instanceof RefreshTokenExpiredError ||
          error instanceof CloudflareBlockedError ||
          error instanceof NetworkError) {
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
      'trailer'
    ]);

    const sanitized = {};
    for (const [key, value] of Object.entries(headers)) {
      if (!forbidden.has(key.toLowerCase())) {
        sanitized[key] = value;
      }
    }
    return sanitized;
  }

  async _fetchStream(url, headers, body, signal) {
    const sanitizedHeaders = this._sanitizeHeadersForFetch(headers);

    return fetch(url, {
      method: 'POST',
      headers: sanitizedHeaders,
      body: JSON.stringify(body),
      signal
    });
  }

  async _readResponseText(response) {
    if (!response) {
      return '';
    }

    if (typeof response.text === 'function') {
      try {
        return await response.text();
      } catch (error) {
        return '';
      }
    }

    return response.body || '';
  }

  /**
   * Send a message to HopGPT
   * @param {object} hopGPTRequest - Request body in HopGPT format
   * @param {object} requestOptions - Request options
   * @param {object} retryState - Internal retry state
   * @returns {Response} Fetch-like response object with body as string (SSE data)
   */
  async sendMessage(
    hopGPTRequest,
    requestOptions = {},
    retryState = { isAuthRetry: false, rateLimitAttempt: 0 }
  ) {
    if (!retryState.isAuthRetry) {
      const tokenInfo = this._getTokenExpiryInfo(this.bearerToken);
      if (tokenInfo && tokenInfo.expiresInSeconds <= this.proactiveRefreshBufferSec + 60) {
        log.debug('Token nearing expiry', { expiresIn: `${tokenInfo.expiresInSeconds}s`, buffer: `${this.proactiveRefreshBufferSec}s` });
      }
      const tokenValid = await this.ensureValidToken();
      if (!tokenValid) {
        throw new TokenRefreshError('Failed to obtain valid authentication token before request');
      }
    }

    const url = `${this.baseURL}${this.endpoint}`;

    // Detect browser type from User-Agent
    const browserType = this.userAgent?.toLowerCase().includes('firefox') ? 'firefox' : 'chrome';

    // Start with browser-like headers to pass Cloudflare
    // Accept: */* matches real browser behavior for this endpoint (from HAR capture)
    const headers = {
      ...this.buildBrowserHeaders(browserType),
      'Content-Type': 'application/json',
      'Accept': '*/*',
      'Origin': this.baseURL,
      'Referer': `${this.baseURL}/c/new`
    };

    const isStreaming = requestOptions.stream === true;
    const abortSignal = requestOptions.signal;
    if (isStreaming) {
      headers['Accept'] = 'text/event-stream';
      headers['Cache-Control'] = 'no-cache';
      headers['Pragma'] = 'no-cache';
    }

    // Add Bearer token if configured
    if (this.bearerToken) {
      headers['Authorization'] = `Bearer ${this.bearerToken}`;
    }

    // Add cookies if configured
    const cookieHeader = this.buildCookieHeader();
    if (cookieHeader) {
      headers['Cookie'] = cookieHeader;
    }

    let useFetchForStreaming = isStreaming && this._shouldUseFetchForStreaming();
    let response;

    if (useFetchForStreaming) {
      try {
        if (abortSignal?.aborted) {
          throw new Error('Request aborted');
        }
        response = await this._fetchStream(url, headers, hopGPTRequest, abortSignal);
      } catch (error) {
        useFetchForStreaming = false;
        log.debug('Streaming fetch failed, falling back to TLS client', { error: error.message });
      }
    }

    if (!useFetchForStreaming) {
      if (abortSignal?.aborted) {
        throw new Error('Request aborted');
      }
      response = await tlsFetch({
        url,
        method: 'POST',
        headers,
        body: hopGPTRequest,
        browserType
      });
    }

    if (!response.ok) {
      const errorText = await this._readResponseText(response);

      // Handle rate limiting (429)
      if (response.status === 429) {
        const retryAfterMs = this._extractRetryAfter(response.headers);
        const { rateLimitAttempt } = retryState;

        log.warn('Rate limited (429)', { attempt: `${rateLimitAttempt + 1}/${this.rateLimitConfig.maxRetries}`, retryAfter: retryAfterMs !== null ? `${retryAfterMs}ms` : 'not specified' });

        // Check if we should retry
        const canRetry = rateLimitAttempt < this.rateLimitConfig.maxRetries;
        const waitTime = this._calculateBackoffDelay(rateLimitAttempt, retryAfterMs);

        // If Retry-After exceeds our max wait time, don't retry
        if (retryAfterMs !== null && retryAfterMs > this.rateLimitConfig.maxWaitTimeMs) {
          log.warn('Rate limit wait time exceeds max', { waitTime: `${retryAfterMs}ms`, maxWait: `${this.rateLimitConfig.maxWaitTimeMs}ms` });
          throw new HopGPTError(
            response.status,
            `Rate limited. Retry after ${Math.ceil(retryAfterMs / 1000)} seconds.`,
            errorText,
            retryAfterMs
          );
        }

        if (canRetry) {
          log.debug('Waiting before retry', { waitTime: `${waitTime}ms` });
          await this._sleep(waitTime);

          return this.sendMessage(hopGPTRequest, requestOptions, {
            ...retryState,
            rateLimitAttempt: rateLimitAttempt + 1
          });
        }

        // Retries exhausted
        log.error('Rate limit retries exhausted', { attempts: rateLimitAttempt + 1 });
        throw new HopGPTError(
          response.status,
          'Rate limit retries exhausted. Please try again later.',
          errorText,
          retryAfterMs
        );
      }

      // Check if this is an auth error and we can retry
      if ((response.status === 401 || response.status === 403) && this.autoRefresh && !retryState.isAuthRetry) {
        const tokenInfo = this._getTokenExpiryInfo(this.bearerToken);
        log.warn('Auth error', { status: response.status });
        log.debug('Auth error details', { body: errorText, tokenInfo: tokenInfo ? `expires in ${tokenInfo.expiresInSeconds}s, expired: ${tokenInfo.isExpired}` : 'no valid token' });
        log.info('Attempting token refresh');

        const refreshed = await this.refreshTokens();
        if (refreshed) {
          log.info('Retrying request with new token');
          return this.sendMessage(hopGPTRequest, requestOptions, { ...retryState, isAuthRetry: true });
        } else {
          log.warn('Token refresh failed, not retrying');
        }
      }

      throw new HopGPTError(
        response.status,
        `HopGPT request failed: ${response.status} ${response.statusText}`,
        errorText
      );
    }

    if (useFetchForStreaming) {
      return response;
    }

    // Return a response-like object that the SSE parser can work with
    // The body is the SSE text, we'll create a readable stream from it
    return this._createStreamResponse(response);
  }

  /**
   * Create a fetch-like Response object from TLS client response
   * Converts the string body to a ReadableStream for SSE parsing
   * @param {object} tlsResponse - TLS client response
   * @returns {object} Fetch-like Response object
   */
  _createStreamResponse(tlsResponse) {
    const body = tlsResponse.body || '';

    // Create a ReadableStream from the string
    const stream = new ReadableStream({
      start(controller) {
        // Encode the string as bytes and enqueue
        const encoder = new TextEncoder();
        controller.enqueue(encoder.encode(body));
        controller.close();
      }
    });

    return {
      ok: tlsResponse.ok,
      status: tlsResponse.status,
      statusText: tlsResponse.statusText,
      headers: tlsResponse.headers,
      body: stream,
      // Also provide the raw body text for non-streaming use
      _rawBody: body,
      text: async () => body,
      json: async () => JSON.parse(body)
    };
  }

  /**
   * Validate that required authentication is configured
   * @returns {object} Validation result with status and missing fields
   */
  validateAuth() {
    const missing = [];
    const warnings = [];

    // Refresh token is required for auto-refresh to work
    if (!this.cookies.refreshToken) {
      missing.push('HOPGPT_COOKIE_REFRESH_TOKEN');
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

    // Bearer token is optional if refresh token is available (we can refresh it)
    if (!this.bearerToken) {
      if (this.cookies.refreshToken) {
        warnings.push('HOPGPT_BEARER_TOKEN not set, will attempt to refresh on first request');
      } else {
        missing.push('HOPGPT_BEARER_TOKEN');
      }
    }

    return {
      valid: missing.length === 0,
      missing,
      warnings
    };
  }
}

/**
 * Custom error class for HopGPT API errors
 */
export class HopGPTError extends Error {
  constructor(statusCode, message, responseBody = null, retryAfterMs = null) {
    super(message);
    this.name = 'HopGPTError';
    this.statusCode = statusCode;
    this.responseBody = responseBody;
    this.retryAfterMs = retryAfterMs;
  }

  /**
   * Convert to Anthropic-compatible error format
   * @returns {object} Anthropic error response
   */
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
        message: this.message
      }
    };

    // Include retry-after information for rate limit errors
    if (this.statusCode === 429 && this.retryAfterMs !== null) {
      error.error.retry_after_seconds = Math.ceil(this.retryAfterMs / 1000);
    }

    return error;
  }
}

// Export a default client instance
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

/**
 * Parse JWT token and extract expiry information
 * @param {string} token - JWT token
 * @returns {object|null} Expiry info or null if not a valid JWT
 */
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
    isExpired: expiry.isExpired
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
      isExpired: expiresInSeconds <= 0
    };
  } catch (error) {
    return null;
  }
}
