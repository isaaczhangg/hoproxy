import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CloudflareBlockedError,
  NetworkError,
  RefreshTokenExpiredError,
  TokenRefreshError,
} from '../../src/errors/authErrors.js';
import { HopGPTClient, HopGPTError } from '../../src/services/hopgptClient.js';
import * as tlsClient from '../../src/services/tlsClient.js';

function createMockTLSResponse({
  ok = true,
  status = 200,
  statusText = 'OK',
  body = '',
  headers = {},
} = {}) {
  return {
    ok,
    status,
    statusText,
    body,
    headers,
    text: async () => body,
    json: async () => JSON.parse(body || '{}'),
  };
}

/**
 * Wire up tlsFetchSpy so that the two-phase chat flow returns an ack on POST
 * and an SSE body on GET. Tests that need to customize individual phases pass
 * postOverride / getOverride.
 *
 * Callers are responsible for mocking /api/auth/refresh separately when
 * needed (pass refreshResponse: createMockTLSResponse(...) to install it).
 */
function mockChatFlow(
  tlsFetchSpy,
  {
    ackBody = { streamId: 'stream-1', conversationId: 'conv-1', status: 'started' },
    sseBody = 'event: message\ndata: {"final":true,"conversation":{"conversationId":"conv-1"},"responseMessage":{"content":[{"type":"text","text":"hi"}]}}\n\n',
    postOverride = null,
    getOverride = null,
    refreshResponse = null,
  } = {},
) {
  tlsFetchSpy.mockImplementation(async (options) => {
    if (options.url.endsWith('/api/auth/refresh')) {
      if (refreshResponse) return refreshResponse;
      throw new Error('mockChatFlow: /api/auth/refresh hit but no refreshResponse configured');
    }
    if (options.url.includes('/api/agents/chat/AnthropicClaude') && options.method === 'POST') {
      return (
        postOverride ??
        createMockTLSResponse({
          ok: true,
          status: 200,
          body: JSON.stringify(ackBody),
          headers: { 'content-type': 'application/json' },
        })
      );
    }
    if (options.url.includes('/api/agents/chat/stream/') && options.method === 'GET') {
      return (
        getOverride ??
        createMockTLSResponse({
          ok: true,
          status: 200,
          body: sseBody,
          headers: { 'content-type': 'text/event-stream' },
        })
      );
    }
    throw new Error(`mockChatFlow: unexpected URL ${options.url} (${options.method})`);
  });
}

describe('HopGPTClient', () => {
  let tlsFetchSpy;
  let originalProactiveRefreshBuffer;
  let originalTokenProvider;

  beforeEach(() => {
    // Mock tlsFetch instead of global fetch
    tlsFetchSpy = vi.spyOn(tlsClient, 'tlsFetch');
    originalProactiveRefreshBuffer = process.env.HOPGPT_PROACTIVE_REFRESH_BUFFER_SECONDS;
    originalTokenProvider = process.env.HOPGPT_COOKIE_TOKEN_PROVIDER;
    delete process.env.HOPGPT_COOKIE_TOKEN_PROVIDER;
  });

  afterEach(() => {
    if (originalProactiveRefreshBuffer === undefined) {
      delete process.env.HOPGPT_PROACTIVE_REFRESH_BUFFER_SECONDS;
    } else {
      process.env.HOPGPT_PROACTIVE_REFRESH_BUFFER_SECONDS = originalProactiveRefreshBuffer;
    }
    if (originalTokenProvider === undefined) {
      delete process.env.HOPGPT_COOKIE_TOKEN_PROVIDER;
    } else {
      process.env.HOPGPT_COOKIE_TOKEN_PROVIDER = originalTokenProvider;
    }
    vi.restoreAllMocks();
  });

  it('returns false when refresh credential is missing', async () => {
    const client = new HopGPTClient({ bearerToken: 'token', openidUserId: null });
    const refreshed = await client.refreshTokens();

    expect(refreshed).toBe(false);
  });

  describe('refreshTokens() gate', () => {
    it('returns false when openid_user_id is missing', async () => {
      const client = new HopGPTClient({ openidUserId: null });
      const result = await client.refreshTokens();
      expect(result).toBe(false);
    });
  });

  describe('validateAuth()', () => {
    it('lists HOPGPT_COOKIE_OPENID_USER_ID in missing when openid_user_id is unset', () => {
      const client = new HopGPTClient({ openidUserId: null, bearerToken: 'b' });
      const result = client.validateAuth();
      expect(result.missing).toContain('HOPGPT_COOKIE_OPENID_USER_ID');
      expect(result.missing).not.toContain('HOPGPT_COOKIE_REFRESH_TOKEN');
    });

    it('valid when openid_user_id is present (bearer can be refreshed)', () => {
      const client = new HopGPTClient({ openidUserId: 'id', bearerToken: null });
      const result = client.validateAuth();
      expect(result.valid).toBe(true);
      expect(result.warnings.some((w) => w.includes('HOPGPT_BEARER_TOKEN'))).toBe(true);
    });
  });

  describe('_resolveBrowserType()', () => {
    it('returns "firefox" when userAgent contains Firefox (case-insensitive)', () => {
      const client = new HopGPTClient({
        openidUserId: 'id',
        userAgent: 'Mozilla/5.0 (Macintosh) Firefox/150.0',
      });
      expect(client._resolveBrowserType()).toBe('firefox');
    });

    it('returns "chrome" when userAgent is missing or not Firefox', () => {
      const c1 = new HopGPTClient({ openidUserId: 'id', userAgent: undefined });
      const c2 = new HopGPTClient({ openidUserId: 'id', userAgent: 'Mozilla/5.0 Chrome/120' });
      expect(c1._resolveBrowserType()).toBe('chrome');
      expect(c2._resolveBrowserType()).toBe('chrome');
    });
  });

  describe('streamEndpointPrefix config', () => {
    it('defaults to /api/agents/chat/stream/', () => {
      const client = new HopGPTClient({ openidUserId: 'id' });
      expect(client.streamEndpointPrefix).toBe('/api/agents/chat/stream/');
    });

    it('accepts an override via config', () => {
      const client = new HopGPTClient({
        openidUserId: 'id',
        streamEndpointPrefix: '/custom/prefix/',
      });
      expect(client.streamEndpointPrefix).toBe('/custom/prefix/');
    });
  });

  describe('autoPersist default', () => {
    it('is disabled under Vitest to avoid overwriting a real .env file', () => {
      const client = new HopGPTClient({ openidUserId: 'id' });
      expect(client.autoPersist).toBe(false);
    });
  });

  describe('proactive refresh buffer', () => {
    it('defaults to ten minutes', () => {
      const client = new HopGPTClient({ openidUserId: 'id' });
      expect(client.proactiveRefreshBufferSec).toBe(600);
    });

    it('can be configured with HOPGPT_PROACTIVE_REFRESH_BUFFER_SECONDS', () => {
      process.env.HOPGPT_PROACTIVE_REFRESH_BUFFER_SECONDS = '900';
      const client = new HopGPTClient({ openidUserId: 'id' });
      expect(client.proactiveRefreshBufferSec).toBe(900);
    });

    it('uses the default when HOPGPT_PROACTIVE_REFRESH_BUFFER_SECONDS is invalid', () => {
      process.env.HOPGPT_PROACTIVE_REFRESH_BUFFER_SECONDS = 'not-a-number';
      const client = new HopGPTClient({ openidUserId: 'id' });
      expect(client.proactiveRefreshBufferSec).toBe(600);
    });
  });

  it('refreshes tokens and retries on auth errors', async () => {
    const refreshResponse = createMockTLSResponse({
      ok: true,
      status: 200,
      body: JSON.stringify({ token: 'new-token' }),
      headers: {
        'set-cookie': ['connect.sid=new-session; Path=/;'],
      },
    });

    mockChatFlow(tlsFetchSpy, { refreshResponse });

    // Use a non-JWT bearer token to trigger proactive refresh
    const client = new HopGPTClient({
      baseURL: 'https://example.com',
      bearerToken: 'old-token', // Non-JWT triggers proactive refresh
      connectSid: 'session-id',
      openidUserId: 'openid-id',
      streamingTransport: 'tls',
    });

    const response = await client.sendMessage({ text: 'hello' });
    expect(response.ok).toBe(true);
    expect(client.bearerToken).toBe('new-token');
    expect(client.cookies.connect_sid).toBe('new-session');

    const postCalls = tlsFetchSpy.mock.calls.filter(([o]) => o.url.includes('/AnthropicClaude'));
    const getCalls = tlsFetchSpy.mock.calls.filter(([o]) => o.url.includes('/stream/'));
    const refreshCalls = tlsFetchSpy.mock.calls.filter(([o]) =>
      o.url.endsWith('/api/auth/refresh'),
    );
    // Proactive refresh + 1 POST (startStream) + 1 GET (subscribeStream)
    expect(refreshCalls.length).toBe(1);
    expect(postCalls.length).toBe(1);
    expect(getCalls.length).toBe(1);
  });

  it('matches the browser refresh request shape', async () => {
    const refreshResponse = createMockTLSResponse({
      ok: true,
      status: 200,
      body: JSON.stringify({ token: 'new-token' }),
      headers: {},
    });

    tlsFetchSpy.mockResolvedValue(refreshResponse);

    const client = new HopGPTClient({
      baseURL: 'https://example.com',
      connectSid: 'session-id',
      openidUserId: 'openid-id',
      autoPersist: false,
    });

    await client.refreshTokens();

    const [[refreshCall]] = tlsFetchSpy.mock.calls;
    expect(refreshCall.url).toBe('https://example.com/api/auth/refresh');
    expect(refreshCall.method).toBe('POST');
    expect(refreshCall.body).toBeUndefined();
    expect(refreshCall.headers).not.toHaveProperty('Content-Type');
    expect(refreshCall.headers.Accept).toBe('application/json, text/plain, */*');
    expect(refreshCall.headers.Cookie).toContain('token_provider=openid');
    expect(refreshCall.headers.Cookie).toContain('openid_user_id=openid-id');
  });

  it('parses cookies with equals signs in values correctly', async () => {
    // JWT tokens and base64 values often contain '=' characters
    const jwtWithEquals =
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.abc123==';
    const refreshResponse = createMockTLSResponse({
      ok: true,
      status: 200,
      body: JSON.stringify({ token: 'new-bearer-token' }),
      headers: {
        'set-cookie': [`connect.sid=${jwtWithEquals}; Path=/; HttpOnly`],
      },
    });

    tlsFetchSpy.mockResolvedValue(refreshResponse);

    const client = new HopGPTClient({
      baseURL: 'https://example.com',
      connectSid: 'old-session',
      openidUserId: 'old-openid',
      autoPersist: false,
    });

    const refreshed = await client.refreshTokens();
    expect(refreshed).toBe(true);
    // The full JWT with trailing '==' should be preserved
    expect(client.cookies.connect_sid).toBe(jwtWithEquals);
  });

  it('maps HopGPT errors to Anthropic error formats', () => {
    const authError = new HopGPTError(401, 'Unauthorized');
    expect(authError.toAnthropicError()).toEqual({
      type: 'error',
      error: { type: 'authentication_error', message: 'Unauthorized' },
    });

    const rateError = new HopGPTError(429, 'Too many requests');
    expect(rateError.toAnthropicError()).toEqual({
      type: 'error',
      error: { type: 'rate_limit_error', message: 'Too many requests' },
    });
  });

  it('includes retry_after_seconds in rate limit error when retryAfterMs is provided', () => {
    const rateError = new HopGPTError(429, 'Rate limited', null, 5000);
    expect(rateError.toAnthropicError()).toEqual({
      type: 'error',
      error: {
        type: 'rate_limit_error',
        message: 'Rate limited',
        retry_after_seconds: 5,
      },
    });
  });

  describe('rate limiting', () => {
    it('retries on 429 with exponential backoff', async () => {
      const rateLimitResponse = createMockTLSResponse({
        ok: false,
        status: 429,
        statusText: 'Too Many Requests',
        body: 'rate limited',
        headers: { 'retry-after': '1' },
      });
      const ackResponse = createMockTLSResponse({
        ok: true,
        status: 200,
        body: JSON.stringify({ streamId: 'stream-1', conversationId: 'conv-1', status: 'started' }),
        headers: { 'content-type': 'application/json' },
      });
      const sseResponse = createMockTLSResponse({
        ok: true,
        status: 200,
        body: 'event: message\ndata: {"final":true,"conversation":{"conversationId":"conv-1"},"responseMessage":{"content":[{"type":"text","text":"hi"}]}}\n\n',
        headers: { 'content-type': 'text/event-stream' },
      });
      const refreshSuccessResponse = createMockTLSResponse({
        ok: true,
        status: 200,
        body: JSON.stringify({ token: 'new-token' }),
        headers: { 'set-cookie': ['connect.sid=new-session; Path=/;'] },
      });

      let postAttempts = 0;
      tlsFetchSpy.mockImplementation(async (options) => {
        if (options.url.endsWith('/api/auth/refresh')) {
          return refreshSuccessResponse; // Refresh succeeds with token
        }
        if (options.url.includes('/api/agents/chat/AnthropicClaude') && options.method === 'POST') {
          postAttempts++;
          if (postAttempts === 1) {
            return rateLimitResponse;
          }
          return ackResponse;
        }
        if (options.url.includes('/api/agents/chat/stream/') && options.method === 'GET') {
          return sseResponse;
        }
        throw new Error(`unexpected: ${options.method} ${options.url}`);
      });

      const client = new HopGPTClient({
        baseURL: 'https://example.com',
        bearerToken: 'token', // Non-JWT triggers proactive refresh
        connectSid: 'session-id',
        openidUserId: 'openid-id',
        rateLimitMaxRetries: 3,
        rateLimitBaseDelayMs: 10, // Use short delay for tests
        streamingTransport: 'tls',
      });
      const sleepSpy = vi.spyOn(client, '_sleep').mockResolvedValue();

      const response = await client.sendMessage({ text: 'hello' });
      expect(response.ok).toBe(true);
      // First POST fails with 429, second POST succeeds, then one GET for the SSE stream
      expect(postAttempts).toBe(2);
      const getCalls = tlsFetchSpy.mock.calls.filter(([o]) => o.url.includes('/stream/'));
      expect(getCalls.length).toBe(1);
      expect(sleepSpy).toHaveBeenCalledTimes(1);
    });

    it('throws error when rate limit retries are exhausted', async () => {
      const rateLimitResponse = createMockTLSResponse({
        ok: false,
        status: 429,
        statusText: 'Too Many Requests',
        body: 'rate limited',
        headers: {},
      });
      const refreshSuccessResponse = createMockTLSResponse({
        ok: true,
        status: 200,
        body: JSON.stringify({ token: 'new-token' }),
        headers: { 'set-cookie': ['connect.sid=new-session; Path=/;'] },
      });

      let postAttempts = 0;
      tlsFetchSpy.mockImplementation(async (options) => {
        if (options.url.endsWith('/api/auth/refresh')) {
          return refreshSuccessResponse; // Refresh succeeds with token
        }
        if (options.url.includes('/api/agents/chat/AnthropicClaude') && options.method === 'POST') {
          postAttempts++;
          return rateLimitResponse; // POST always returns 429
        }
        throw new Error(`unexpected: ${options.method} ${options.url}`);
      });

      const client = new HopGPTClient({
        baseURL: 'https://example.com',
        bearerToken: 'token', // Non-JWT triggers proactive refresh
        connectSid: 'session-id',
        openidUserId: 'openid-id',
        rateLimitMaxRetries: 2,
        rateLimitBaseDelayMs: 10,
        streamingTransport: 'tls',
      });
      const sleepSpy = vi.spyOn(client, '_sleep').mockResolvedValue();

      // After exhausting retries, sendMessage rethrows the underlying HopGPTError
      // from startStream. Its .message is the upstream statusText
      // ("Too Many Requests"); assert on the error shape instead.
      let caught;
      try {
        await client.sendMessage({ text: 'hello' });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(HopGPTError);
      expect(caught.statusCode).toBe(429);
      // Initial attempt + 2 retries = 3 POST calls
      expect(postAttempts).toBe(3);
      expect(sleepSpy).toHaveBeenCalledTimes(2);
    });

    it('does not retry when Retry-After exceeds maxWaitTimeMs', async () => {
      const rateLimitResponse = createMockTLSResponse({
        ok: false,
        status: 429,
        statusText: 'Too Many Requests',
        body: 'rate limited',
        headers: { 'retry-after': '60' }, // 60 seconds
      });
      const refreshSuccessResponse = createMockTLSResponse({
        ok: true,
        status: 200,
        body: JSON.stringify({ token: 'new-token' }),
        headers: { 'set-cookie': ['connect.sid=new-session; Path=/;'] },
      });

      let postAttempts = 0;
      tlsFetchSpy.mockImplementation(async (options) => {
        if (options.url.endsWith('/api/auth/refresh')) {
          return refreshSuccessResponse; // Refresh succeeds with token
        }
        if (options.url.includes('/api/agents/chat/AnthropicClaude') && options.method === 'POST') {
          postAttempts++;
          return rateLimitResponse;
        }
        throw new Error(`unexpected: ${options.method} ${options.url}`);
      });

      const client = new HopGPTClient({
        baseURL: 'https://example.com',
        bearerToken: 'token', // Non-JWT triggers proactive refresh
        connectSid: 'session-id',
        openidUserId: 'openid-id',
        rateLimitMaxRetries: 3,
        rateLimitMaxWaitTimeMs: 10000, // 10 seconds max
        streamingTransport: 'tls',
      });

      // With Retry-After=60s exceeding maxWaitTimeMs=10s, sendMessage rethrows
      // the original HopGPTError immediately without retry. Assert on the
      // error shape (statusCode + retryAfterMs) instead of its .message.
      let caught;
      try {
        await client.sendMessage({ text: 'hello' });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(HopGPTError);
      expect(caught.statusCode).toBe(429);
      expect(caught.retryAfterMs).toBe(60000);
      // Should only POST once since Retry-After exceeds max wait time
      expect(postAttempts).toBe(1);
    });

    it('extracts numeric Retry-After header', () => {
      const client = new HopGPTClient();

      expect(client._extractRetryAfter({ 'retry-after': '5' })).toBe(5000);
      expect(client._extractRetryAfter({ 'Retry-After': '10' })).toBe(10000);
      expect(client._extractRetryAfter({})).toBe(null);
    });

    it('calculates backoff delay with jitter', () => {
      const client = new HopGPTClient({
        rateLimitBaseDelayMs: 1000,
        rateLimitMaxDelayMs: 30000,
      });

      // With Retry-After within max wait time, use Retry-After
      expect(client._calculateBackoffDelay(0, 5000)).toBe(5000);

      // Without Retry-After, use exponential backoff
      const delay0 = client._calculateBackoffDelay(0, null);
      expect(delay0).toBeGreaterThanOrEqual(1000);
      expect(delay0).toBeLessThanOrEqual(1300); // Base + 30% jitter

      const delay1 = client._calculateBackoffDelay(1, null);
      expect(delay1).toBeGreaterThanOrEqual(2000);
      expect(delay1).toBeLessThanOrEqual(2600);
    });
  });

  describe('token refresh error handling', () => {
    it('returns false when refresh response has no token (P0 #2 fix)', async () => {
      const refreshResponseNoToken = createMockTLSResponse({
        ok: true,
        status: 200,
        body: JSON.stringify({ message: 'success but no token' }),
        headers: {},
      });

      tlsFetchSpy.mockResolvedValue(refreshResponseNoToken);

      const client = new HopGPTClient({
        connectSid: 'valid-session',
        openidUserId: 'valid-openid',
        autoPersist: false,
      });

      const result = await client.refreshTokens();
      expect(result).toBe(false);
    });

    it('throws RefreshTokenExpiredError on 401 response (P1 #5 fix)', async () => {
      const unauthorizedResponse = createMockTLSResponse({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
        body: 'Token expired',
      });

      tlsFetchSpy.mockResolvedValue(unauthorizedResponse);

      const client = new HopGPTClient({
        connectSid: 'expired-session',
        openidUserId: 'expired-openid',
        autoPersist: false,
      });

      await expect(client.refreshTokens()).rejects.toThrow(RefreshTokenExpiredError);
    });

    it('throws RefreshTokenExpiredError on 403 response (P1 #5 fix)', async () => {
      const forbiddenResponse = createMockTLSResponse({
        ok: false,
        status: 403,
        statusText: 'Forbidden',
        body: 'Access denied',
      });

      tlsFetchSpy.mockResolvedValue(forbiddenResponse);

      const client = new HopGPTClient({
        connectSid: 'invalid-session',
        openidUserId: 'invalid-openid',
        autoPersist: false,
      });

      await expect(client.refreshTokens()).rejects.toThrow(RefreshTokenExpiredError);
    });

    it('throws CloudflareBlockedError on 503 response (P1 #5 fix)', async () => {
      const cfBlockedResponse = createMockTLSResponse({
        ok: false,
        status: 503,
        statusText: 'Service Unavailable',
        body: 'Cloudflare error',
      });

      tlsFetchSpy.mockResolvedValue(cfBlockedResponse);

      const client = new HopGPTClient({
        connectSid: 'valid-session',
        openidUserId: 'valid-openid',
        autoPersist: false,
      });

      await expect(client.refreshTokens()).rejects.toThrow(CloudflareBlockedError);
    });

    it('throws NetworkError on network failure (P1 #5 fix)', async () => {
      tlsFetchSpy.mockRejectedValue(new Error('ECONNREFUSED'));

      const client = new HopGPTClient({
        connectSid: 'valid-session',
        openidUserId: 'valid-openid',
        autoPersist: false,
      });

      await expect(client.refreshTokens()).rejects.toThrow(NetworkError);
    });

    it('throws TokenRefreshError when proactive refresh fails (P0 #3 fix)', async () => {
      const refreshFailResponse = createMockTLSResponse({
        ok: true,
        status: 200,
        body: JSON.stringify({}), // No token in response
        headers: {},
      });

      tlsFetchSpy.mockResolvedValue(refreshFailResponse);

      const client = new HopGPTClient({
        baseURL: 'https://example.com',
        bearerToken: 'invalid-token', // Non-JWT triggers proactive refresh
        connectSid: 'valid-session',
        openidUserId: 'valid-openid',
        autoPersist: false,
        streamingTransport: 'tls',
      });

      await expect(client.sendMessage({ text: 'hello' })).rejects.toThrow(TokenRefreshError);
    });

    it('concurrent refreshTokens() calls share the same promise (P0 #1 fix)', async () => {
      let refreshCallCount = 0;
      const refreshSuccessResponse = createMockTLSResponse({
        ok: true,
        status: 200,
        body: JSON.stringify({ token: 'new-token' }),
        headers: { 'set-cookie': ['connect.sid=new-session; Path=/;'] },
      });

      tlsFetchSpy.mockImplementation(async () => {
        refreshCallCount++;
        // Add small delay to ensure both calls happen before first completes
        await new Promise((resolve) => setTimeout(resolve, 10));
        return refreshSuccessResponse;
      });

      const client = new HopGPTClient({
        connectSid: 'valid-session',
        openidUserId: 'valid-openid',
        autoPersist: false,
      });

      // Start two concurrent refresh calls
      const [result1, result2] = await Promise.all([
        client.refreshTokens(),
        client.refreshTokens(),
      ]);

      expect(result1).toBe(true);
      expect(result2).toBe(true);
      // Should only make ONE actual HTTP call due to mutex
      expect(refreshCallCount).toBe(1);
    });
  });

  describe('buildCookieHeader', () => {
    it('does NOT emit a refreshToken cookie even if one is somehow set', () => {
      const client = new HopGPTClient({
        connectSid: 'sid-value',
        cfClearance: 'cf-value',
      });
      // Attempt to sneak a refreshToken in — it must be ignored.
      client.cookies.refreshToken = 'should-be-ignored';
      const header = client.buildCookieHeader();
      expect(header).toContain('connect.sid=sid-value');
      expect(header).toContain('cf_clearance=cf-value');
      expect(header).not.toContain('refreshToken');
    });

    it('emits only known session + Cloudflare + OIDC cookies from a clean client', () => {
      const client = new HopGPTClient({
        connectSid: 'sid-value',
        openidUserId: 'oid-value',
        cfClearance: 'cf-value',
        cfBm: 'bm-value',
        tokenProvider: 'openid',
      });
      const header = client.buildCookieHeader();
      expect(header).toBe(
        'cf_clearance=cf-value; connect.sid=sid-value; __cf_bm=bm-value; token_provider=openid; openid_user_id=oid-value',
      );
    });

    it('defaults to the OpenID provider when the refresh credential is openid_user_id', () => {
      const client = new HopGPTClient({
        openidUserId: 'oid-value',
      });
      expect(client.buildCookieHeader()).toContain('token_provider=openid');
    });

    it('normalizes the stale LibreChat provider when using openid_user_id', () => {
      const client = new HopGPTClient({
        openidUserId: 'oid-value',
        tokenProvider: 'librechat',
      });
      expect(client.buildCookieHeader()).toContain('token_provider=openid');
    });
  });

  describe('_parseCookies (rotation from Set-Cookie)', () => {
    it('rotates connect.sid when server sends a new one', () => {
      const client = new HopGPTClient({ connectSid: 'old-sid' });
      client._parseCookies(['connect.sid=new-sid; Path=/; HttpOnly']);
      expect(client.cookies.connect_sid).toBe('new-sid');
    });

    it('does NOT set a refreshToken field when server sends refreshToken cookie (field should not exist)', () => {
      const client = new HopGPTClient({ connectSid: 'sid' });
      client._parseCookies(['refreshToken=should-be-ignored; Path=/; HttpOnly']);
      expect(client.cookies.refreshToken).toBeUndefined();
    });

    it('rotates cf_clearance and __cf_bm', () => {
      const client = new HopGPTClient({});
      client._parseCookies(['cf_clearance=cf-new; Path=/', '__cf_bm=bm-new; Path=/']);
      expect(client.cookies.cf_clearance).toBe('cf-new');
      expect(client.cookies.__cf_bm).toBe('bm-new');
    });
  });

  describe('persistCredentials (.env rewrite)', () => {
    it('strips a stale HOPGPT_COOKIE_REFRESH_TOKEN line and writes the new credential vars', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hopgpt-test-'));
      try {
        const envPath = path.join(tmpDir, '.env');
        fs.writeFileSync(
          envPath,
          'HOPGPT_COOKIE_REFRESH_TOKEN=stale-value\n' + 'SOMETHING_ELSE=keep\n',
        );

        const client = new HopGPTClient({
          connectSid: 'fresh-sid',
          openidUserId: 'fresh-openid',
          bearerToken: 'fresh-bearer',
          autoPersist: true,
          envPath,
        });
        await client.persistCredentials();

        const written = fs.readFileSync(envPath, 'utf-8');
        expect(written).toContain('HOPGPT_COOKIE_CONNECT_SID=fresh-sid');
        expect(written).toContain('HOPGPT_COOKIE_OPENID_USER_ID=fresh-openid');
        expect(written).toContain('HOPGPT_COOKIE_TOKEN_PROVIDER=openid');
        expect(written).toContain('HOPGPT_BEARER_TOKEN=fresh-bearer');
        expect(written).not.toContain('HOPGPT_COOKIE_REFRESH_TOKEN');
        expect(written).toContain('SOMETHING_ELSE=keep');
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  describe('two-phase retry policy', () => {
    const SSE_OK =
      'event: message\ndata: {"final":true,"conversation":{"conversationId":"conv-1"},"responseMessage":{"content":[{"type":"text","text":"hi"}]}}\n\n';

    function makeRefreshOK() {
      return createMockTLSResponse({
        ok: true,
        status: 200,
        body: JSON.stringify({ token: 'new-token' }),
        headers: { 'set-cookie': ['connect.sid=new-session; Path=/;'] },
      });
    }

    it('post-ack GET 401 → refresh → GET 200 with SAME streamId (no second POST)', async () => {
      let getAttempts = 0;
      tlsFetchSpy.mockImplementation(async (options) => {
        if (options.url.endsWith('/api/auth/refresh')) return makeRefreshOK();
        if (options.url.includes('/AnthropicClaude') && options.method === 'POST') {
          return createMockTLSResponse({
            ok: true,
            status: 200,
            body: JSON.stringify({
              streamId: 'stream-abc',
              conversationId: 'conv-1',
              status: 'started',
            }),
            headers: { 'content-type': 'application/json' },
          });
        }
        if (options.url.includes('/stream/') && options.method === 'GET') {
          getAttempts++;
          if (getAttempts === 1)
            return createMockTLSResponse({
              ok: false,
              status: 401,
              statusText: 'Unauthorized',
              body: '',
            });
          return createMockTLSResponse({
            ok: true,
            status: 200,
            body: SSE_OK,
            headers: { 'content-type': 'text/event-stream' },
          });
        }
        throw new Error(`unexpected: ${options.url}`);
      });

      const client = new HopGPTClient({
        baseURL: 'https://example.com',
        bearerToken: 'token',
        connectSid: 's',
        openidUserId: 'o',
        streamingTransport: 'tls',
        autoRefresh: true,
        autoPersist: false,
      });
      const response = await client.sendMessage({ text: 'hi' });
      expect(response.ok).toBe(true);

      const postCalls = tlsFetchSpy.mock.calls.filter(
        ([o]) => o.url.includes('/AnthropicClaude') && o.method === 'POST',
      );
      const getCalls = tlsFetchSpy.mock.calls.filter(([o]) => o.url.includes('/stream/'));
      expect(postCalls.length).toBe(1); // exactly one POST
      expect(getCalls.length).toBe(2); // two GETs, same streamId
      expect(getCalls[0][0].url).toBe('https://example.com/api/agents/chat/stream/stream-abc');
      expect(getCalls[1][0].url).toBe('https://example.com/api/agents/chat/stream/stream-abc');
    });

    it('post-ack GET 401 → refresh → GET 401 again → throws; still only one POST', async () => {
      tlsFetchSpy.mockImplementation(async (options) => {
        if (options.url.endsWith('/api/auth/refresh')) return makeRefreshOK();
        if (options.url.includes('/AnthropicClaude') && options.method === 'POST') {
          return createMockTLSResponse({
            ok: true,
            status: 200,
            body: JSON.stringify({
              streamId: 'stream-abc',
              conversationId: 'conv-1',
              status: 'started',
            }),
            headers: { 'content-type': 'application/json' },
          });
        }
        if (options.url.includes('/stream/') && options.method === 'GET') {
          return createMockTLSResponse({
            ok: false,
            status: 401,
            statusText: 'Unauthorized',
            body: '',
          });
        }
        throw new Error(`unexpected: ${options.url}`);
      });

      const client = new HopGPTClient({
        baseURL: 'https://example.com',
        bearerToken: 'token',
        connectSid: 's',
        openidUserId: 'o',
        streamingTransport: 'tls',
        autoRefresh: true,
        autoPersist: false,
      });
      await expect(client.sendMessage({ text: 'hi' })).rejects.toMatchObject({ statusCode: 401 });

      const postCalls = tlsFetchSpy.mock.calls.filter(
        ([o]) => o.url.includes('/AnthropicClaude') && o.method === 'POST',
      );
      expect(postCalls.length).toBe(1); // never re-POSTed
      // Refresh fires twice: once proactively (non-JWT bearer triggers it before POST)
      // and once as the post-ack one-shot for the GET 401. isPostAckAuthRetry blocks
      // further refreshes, so the second GET 401 must NOT trigger a third refresh.
      const refreshCalls = tlsFetchSpy.mock.calls.filter(([o]) =>
        o.url.endsWith('/api/auth/refresh'),
      );
      expect(refreshCalls.length).toBe(2);
    });

    it('post-ack GET 429 → backoff → GET 200 with SAME streamId (no second POST)', async () => {
      let getAttempts = 0;
      tlsFetchSpy.mockImplementation(async (options) => {
        if (options.url.endsWith('/api/auth/refresh')) return makeRefreshOK();
        if (options.url.includes('/AnthropicClaude') && options.method === 'POST') {
          return createMockTLSResponse({
            ok: true,
            status: 200,
            body: JSON.stringify({
              streamId: 'stream-abc',
              conversationId: 'conv-1',
              status: 'started',
            }),
            headers: { 'content-type': 'application/json' },
          });
        }
        if (options.url.includes('/stream/') && options.method === 'GET') {
          getAttempts++;
          if (getAttempts === 1)
            return createMockTLSResponse({
              ok: false,
              status: 429,
              statusText: 'Too Many Requests',
              body: 'slow',
              headers: { 'retry-after': '1' },
            });
          return createMockTLSResponse({
            ok: true,
            status: 200,
            body: SSE_OK,
            headers: { 'content-type': 'text/event-stream' },
          });
        }
        throw new Error(`unexpected: ${options.url}`);
      });

      const client = new HopGPTClient({
        baseURL: 'https://example.com',
        bearerToken: 'token',
        connectSid: 's',
        openidUserId: 'o',
        streamingTransport: 'tls',
        autoPersist: false,
        rateLimitMaxRetries: 2,
        rateLimitBaseDelayMs: 10,
      });
      vi.spyOn(client, '_sleep').mockResolvedValue();
      const response = await client.sendMessage({ text: 'hi' });
      expect(response.ok).toBe(true);

      const postCalls = tlsFetchSpy.mock.calls.filter(
        ([o]) => o.url.includes('/AnthropicClaude') && o.method === 'POST',
      );
      expect(postCalls.length).toBe(1);
    });

    it('post-ack GET 429 → retries exhausted → throws; only one POST', async () => {
      tlsFetchSpy.mockImplementation(async (options) => {
        if (options.url.endsWith('/api/auth/refresh')) return makeRefreshOK();
        if (options.url.includes('/AnthropicClaude') && options.method === 'POST') {
          return createMockTLSResponse({
            ok: true,
            status: 200,
            body: JSON.stringify({
              streamId: 'stream-abc',
              conversationId: 'conv-1',
              status: 'started',
            }),
            headers: { 'content-type': 'application/json' },
          });
        }
        if (options.url.includes('/stream/') && options.method === 'GET') {
          return createMockTLSResponse({
            ok: false,
            status: 429,
            statusText: 'Too Many Requests',
            body: 'slow',
            headers: { 'retry-after': '1' },
          });
        }
        throw new Error(`unexpected: ${options.url}`);
      });

      const client = new HopGPTClient({
        baseURL: 'https://example.com',
        bearerToken: 'token',
        connectSid: 's',
        openidUserId: 'o',
        streamingTransport: 'tls',
        autoPersist: false,
        rateLimitMaxRetries: 2,
        rateLimitBaseDelayMs: 10,
      });
      vi.spyOn(client, '_sleep').mockResolvedValue();
      await expect(client.sendMessage({ text: 'hi' })).rejects.toMatchObject({ statusCode: 429 });

      // With rateLimitMaxRetries: 2, the GET is attempted 3 times (initial + 2 retries).
      const getCalls = tlsFetchSpy.mock.calls.filter(([o]) => o.url.includes('/stream/'));
      expect(getCalls.length).toBe(3);
      const postCalls = tlsFetchSpy.mock.calls.filter(
        ([o]) => o.url.includes('/AnthropicClaude') && o.method === 'POST',
      );
      expect(postCalls.length).toBe(1);
    });

    it('pre-ack POST 429 → backoff → POST2 + GET OK (full rerun allowed before ack)', async () => {
      let postAttempts = 0;
      tlsFetchSpy.mockImplementation(async (options) => {
        if (options.url.endsWith('/api/auth/refresh')) return makeRefreshOK();
        if (options.url.includes('/AnthropicClaude') && options.method === 'POST') {
          postAttempts++;
          if (postAttempts === 1)
            return createMockTLSResponse({
              ok: false,
              status: 429,
              statusText: 'Too Many Requests',
              body: 'slow',
              headers: { 'retry-after': '1' },
            });
          return createMockTLSResponse({
            ok: true,
            status: 200,
            body: JSON.stringify({
              streamId: 'stream-abc',
              conversationId: 'conv-1',
              status: 'started',
            }),
            headers: { 'content-type': 'application/json' },
          });
        }
        if (options.url.includes('/stream/') && options.method === 'GET') {
          return createMockTLSResponse({
            ok: true,
            status: 200,
            body: SSE_OK,
            headers: { 'content-type': 'text/event-stream' },
          });
        }
        throw new Error(`unexpected: ${options.url}`);
      });

      const client = new HopGPTClient({
        baseURL: 'https://example.com',
        bearerToken: 'token',
        connectSid: 's',
        openidUserId: 'o',
        streamingTransport: 'tls',
        autoPersist: false,
        rateLimitMaxRetries: 2,
        rateLimitBaseDelayMs: 10,
      });
      vi.spyOn(client, '_sleep').mockResolvedValue();
      const response = await client.sendMessage({ text: 'hi' });
      expect(response.ok).toBe(true);
      expect(postAttempts).toBe(2);
    });

    it('pre-ack POST 401 → refresh → POST2 + GET OK', async () => {
      let postAttempts = 0;
      tlsFetchSpy.mockImplementation(async (options) => {
        if (options.url.endsWith('/api/auth/refresh')) return makeRefreshOK();
        if (options.url.includes('/AnthropicClaude') && options.method === 'POST') {
          postAttempts++;
          if (postAttempts === 1)
            return createMockTLSResponse({
              ok: false,
              status: 401,
              statusText: 'Unauthorized',
              body: '',
            });
          return createMockTLSResponse({
            ok: true,
            status: 200,
            body: JSON.stringify({
              streamId: 'stream-abc',
              conversationId: 'conv-1',
              status: 'started',
            }),
            headers: { 'content-type': 'application/json' },
          });
        }
        if (options.url.includes('/stream/') && options.method === 'GET') {
          return createMockTLSResponse({
            ok: true,
            status: 200,
            body: SSE_OK,
            headers: { 'content-type': 'text/event-stream' },
          });
        }
        throw new Error(`unexpected: ${options.url}`);
      });

      const client = new HopGPTClient({
        baseURL: 'https://example.com',
        bearerToken: 'token',
        connectSid: 's',
        openidUserId: 'o',
        streamingTransport: 'tls',
        autoRefresh: true,
        autoPersist: false,
      });
      const response = await client.sendMessage({ text: 'hi' });
      expect(response.ok).toBe(true);
      expect(postAttempts).toBe(2);
    });

    it('abort between POST and GET: GET never called', async () => {
      const controller = new AbortController();
      tlsFetchSpy.mockImplementation(async (options) => {
        if (options.url.endsWith('/api/auth/refresh')) return makeRefreshOK();
        if (options.url.includes('/AnthropicClaude') && options.method === 'POST') {
          controller.abort(); // flip aborted=true after POST resolves
          return createMockTLSResponse({
            ok: true,
            status: 200,
            body: JSON.stringify({
              streamId: 'stream-abc',
              conversationId: 'conv-1',
              status: 'started',
            }),
            headers: { 'content-type': 'application/json' },
          });
        }
        if (options.url.includes('/stream/')) {
          throw new Error('GET should not be called after abort');
        }
        throw new Error(`unexpected: ${options.url}`);
      });

      const client = new HopGPTClient({
        baseURL: 'https://example.com',
        bearerToken: 'token',
        connectSid: 's',
        openidUserId: 'o',
        streamingTransport: 'tls',
        autoPersist: false,
      });
      await expect(
        client.sendMessage({ text: 'hi' }, { signal: controller.signal }),
      ).rejects.toThrow(/Request aborted/);

      const getCalls = tlsFetchSpy.mock.calls.filter(([o]) => o.url.includes('/stream/'));
      expect(getCalls.length).toBe(0);
    });

    it('POST 200 with HTML body (upstream auth page) → 502 /Malformed stream ack/; no GET', async () => {
      tlsFetchSpy.mockImplementation(async (options) => {
        if (options.url.endsWith('/api/auth/refresh')) return makeRefreshOK();
        if (options.url.includes('/AnthropicClaude') && options.method === 'POST') {
          return createMockTLSResponse({
            ok: true,
            status: 200,
            body: '<html><title>Login required</title></html>',
            headers: { 'content-type': 'text/html' },
          });
        }
        if (options.url.includes('/stream/')) {
          throw new Error('GET should not be called after malformed ack');
        }
        throw new Error(`unexpected: ${options.url}`);
      });

      const client = new HopGPTClient({
        baseURL: 'https://example.com',
        bearerToken: 'token',
        connectSid: 's',
        openidUserId: 'o',
        streamingTransport: 'tls',
        autoPersist: false,
      });
      await expect(client.sendMessage({ text: 'hi' })).rejects.toMatchObject({
        statusCode: 502,
        message: expect.stringMatching(/Malformed stream ack/),
      });
      const getCalls = tlsFetchSpy.mock.calls.filter(([o]) => o.url.includes('/stream/'));
      expect(getCalls.length).toBe(0);
    });

    it('GET 200 with text/html body → 502 /Expected text\\/event-stream/', async () => {
      tlsFetchSpy.mockImplementation(async (options) => {
        if (options.url.endsWith('/api/auth/refresh')) return makeRefreshOK();
        if (options.url.includes('/AnthropicClaude') && options.method === 'POST') {
          return createMockTLSResponse({
            ok: true,
            status: 200,
            body: JSON.stringify({
              streamId: 'stream-abc',
              conversationId: 'conv-1',
              status: 'started',
            }),
            headers: { 'content-type': 'application/json' },
          });
        }
        if (options.url.includes('/stream/') && options.method === 'GET') {
          return createMockTLSResponse({
            ok: true,
            status: 200,
            body: '<html>login</html>',
            headers: { 'content-type': 'text/html' },
          });
        }
        throw new Error(`unexpected: ${options.url}`);
      });

      const client = new HopGPTClient({
        baseURL: 'https://example.com',
        bearerToken: 'token',
        connectSid: 's',
        openidUserId: 'o',
        streamingTransport: 'tls',
        autoPersist: false,
      });
      await expect(client.sendMessage({ text: 'hi' })).rejects.toMatchObject({
        statusCode: 502,
        message: expect.stringMatching(/Expected text\/event-stream/),
      });
    });

    it('GET 200 with empty SSE body returns a response (consumer decides completion)', async () => {
      tlsFetchSpy.mockImplementation(async (options) => {
        if (options.url.endsWith('/api/auth/refresh')) return makeRefreshOK();
        if (options.url.includes('/AnthropicClaude') && options.method === 'POST') {
          return createMockTLSResponse({
            ok: true,
            status: 200,
            body: JSON.stringify({
              streamId: 'stream-abc',
              conversationId: 'conv-1',
              status: 'started',
            }),
            headers: { 'content-type': 'application/json' },
          });
        }
        if (options.url.includes('/stream/') && options.method === 'GET') {
          return createMockTLSResponse({
            ok: true,
            status: 200,
            body: '',
            headers: { 'content-type': 'text/event-stream' },
          });
        }
        throw new Error(`unexpected: ${options.url}`);
      });

      const client = new HopGPTClient({
        baseURL: 'https://example.com',
        bearerToken: 'token',
        connectSid: 's',
        openidUserId: 'o',
        streamingTransport: 'tls',
        autoPersist: false,
      });
      const response = await client.sendMessage({ text: 'hi' });
      expect(response.ok).toBe(true); // client returns; transformer's forceEnd handles downstream
    });

    it('streamId with reserved characters is URL-encoded in GET URL', async () => {
      tlsFetchSpy.mockImplementation(async (options) => {
        if (options.url.endsWith('/api/auth/refresh')) return makeRefreshOK();
        if (options.url.includes('/AnthropicClaude') && options.method === 'POST') {
          return createMockTLSResponse({
            ok: true,
            status: 200,
            body: JSON.stringify({
              streamId: 'foo/bar?x=1',
              conversationId: 'c',
              status: 'started',
            }),
            headers: { 'content-type': 'application/json' },
          });
        }
        if (options.url.includes('/stream/') && options.method === 'GET') {
          return createMockTLSResponse({
            ok: true,
            status: 200,
            body: 'event: message\ndata: {"final":true,"conversation":{"conversationId":"c"},"responseMessage":{"content":[{"type":"text","text":"hi"}]}}\n\n',
            headers: { 'content-type': 'text/event-stream' },
          });
        }
        throw new Error(`unexpected: ${options.url}`);
      });

      const client = new HopGPTClient({
        baseURL: 'https://example.com',
        bearerToken: 'token',
        connectSid: 's',
        openidUserId: 'o',
        streamingTransport: 'tls',
        autoPersist: false,
      });
      await client.sendMessage({ text: 'hi' });

      const getCall = tlsFetchSpy.mock.calls.find(([o]) => o.url.includes('/stream/'));
      expect(getCall[0].url).toBe('https://example.com/api/agents/chat/stream/foo%2Fbar%3Fx%3D1');
    });
  });
});
