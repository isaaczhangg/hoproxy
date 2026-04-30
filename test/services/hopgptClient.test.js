import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { HopGPTClient, HopGPTError } from '../../src/services/hopgptClient.js';
import * as tlsClient from '../../src/services/tlsClient.js';
import {
  TokenRefreshError,
  RefreshTokenExpiredError,
  CloudflareBlockedError,
  NetworkError
} from '../../src/errors/authErrors.js';

function createMockTLSResponse({
  ok = true,
  status = 200,
  statusText = 'OK',
  body = '',
  headers = {}
} = {}) {
  return {
    ok,
    status,
    statusText,
    body,
    headers,
    text: async () => body,
    json: async () => JSON.parse(body || '{}')
  };
}

describe('HopGPTClient', () => {
  let tlsFetchSpy;

  beforeEach(() => {
    // Mock tlsFetch instead of global fetch
    tlsFetchSpy = vi.spyOn(tlsClient, 'tlsFetch');
  });

  afterEach(() => {
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
      expect(result.warnings.some(w => w.includes('HOPGPT_BEARER_TOKEN'))).toBe(true);
    });
  });

  describe('_resolveBrowserType()', () => {
    it('returns "firefox" when userAgent contains Firefox (case-insensitive)', () => {
      const client = new HopGPTClient({ openidUserId: 'id', userAgent: 'Mozilla/5.0 (Macintosh) Firefox/150.0' });
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
      const client = new HopGPTClient({ openidUserId: 'id', streamEndpointPrefix: '/custom/prefix/' });
      expect(client.streamEndpointPrefix).toBe('/custom/prefix/');
    });
  });

  it('refreshes tokens and retries on auth errors', async () => {
    const refreshResponse = createMockTLSResponse({
      ok: true,
      status: 200,
      body: JSON.stringify({ token: 'new-token' }),
      headers: {
        'set-cookie': ['connect.sid=new-session; Path=/;']
      }
    });
    const successResponse = createMockTLSResponse({
      ok: true,
      status: 200,
      body: 'data: {"type":"text"}\n\n'
    });

    let refreshCalls = 0;
    let chatCalls = 0;
    tlsFetchSpy.mockImplementation(async (options) => {
      if (options.url.endsWith('/api/auth/refresh')) {
        refreshCalls++;
        return refreshResponse;
      }
      chatCalls++;
      return successResponse;
    });

    // Use a non-JWT bearer token to trigger proactive refresh
    const client = new HopGPTClient({
      baseURL: 'https://example.com',
      bearerToken: 'old-token',  // Non-JWT triggers proactive refresh
      connectSid: 'session-id', openidUserId: 'openid-id'
    });

    const response = await client.sendMessage({ text: 'hello' });
    expect(response.ok).toBe(true);
    expect(client.bearerToken).toBe('new-token');
    expect(client.cookies.connect_sid).toBe('new-session');
    // Proactive refresh (1 call) + chat request (1 call) = 2 calls
    expect(refreshCalls).toBe(1);
    expect(chatCalls).toBe(1);
  });

  it('parses cookies with equals signs in values correctly', async () => {
    // JWT tokens and base64 values often contain '=' characters
    const jwtWithEquals = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.abc123==';
    const refreshResponse = createMockTLSResponse({
      ok: true,
      status: 200,
      body: JSON.stringify({ token: 'new-bearer-token' }),
      headers: {
        'set-cookie': [`connect.sid=${jwtWithEquals}; Path=/; HttpOnly`]
      }
    });

    tlsFetchSpy.mockResolvedValue(refreshResponse);

    const client = new HopGPTClient({
      baseURL: 'https://example.com',
      connectSid: 'old-session', openidUserId: 'old-openid',
      autoPersist: false
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
      error: { type: 'authentication_error', message: 'Unauthorized' }
    });

    const rateError = new HopGPTError(429, 'Too many requests');
    expect(rateError.toAnthropicError()).toEqual({
      type: 'error',
      error: { type: 'rate_limit_error', message: 'Too many requests' }
    });
  });

  it('includes retry_after_seconds in rate limit error when retryAfterMs is provided', () => {
    const rateError = new HopGPTError(429, 'Rate limited', null, 5000);
    expect(rateError.toAnthropicError()).toEqual({
      type: 'error',
      error: {
        type: 'rate_limit_error',
        message: 'Rate limited',
        retry_after_seconds: 5
      }
    });
  });

  describe('rate limiting', () => {
    it('retries on 429 with exponential backoff', async () => {
      const rateLimitResponse = createMockTLSResponse({
        ok: false,
        status: 429,
        statusText: 'Too Many Requests',
        body: 'rate limited',
        headers: { 'retry-after': '1' }
      });
      const chatSuccessResponse = createMockTLSResponse({
        ok: true,
        status: 200,
        body: 'data: {"type":"text"}\n\n'
      });
      const refreshSuccessResponse = createMockTLSResponse({
        ok: true,
        status: 200,
        body: JSON.stringify({ token: 'new-token' }),
        headers: { 'set-cookie': ['connect.sid=new-session; Path=/;'] }
      });

      let chatCalls = 0;
      tlsFetchSpy.mockImplementation(async (options) => {
        if (options.url.endsWith('/api/auth/refresh')) {
          return refreshSuccessResponse;  // Refresh succeeds with token
        }
        chatCalls++;
        if (chatCalls === 1) {
          return rateLimitResponse;
        }
        return chatSuccessResponse;
      });

    const client = new HopGPTClient({
      baseURL: 'https://example.com',
      bearerToken: 'token',  // Non-JWT triggers proactive refresh
      connectSid: 'session-id', openidUserId: 'openid-id',
      rateLimitMaxRetries: 3,
      rateLimitBaseDelayMs: 10  // Use short delay for tests
    });
    const sleepSpy = vi.spyOn(client, '_sleep').mockResolvedValue();

    const response = await client.sendMessage({ text: 'hello' });
    expect(response.ok).toBe(true);
    expect(chatCalls).toBe(2);  // First fails with 429, second succeeds
    expect(sleepSpy).toHaveBeenCalledTimes(1);
  });

    it('throws error when rate limit retries are exhausted', async () => {
      const rateLimitResponse = createMockTLSResponse({
        ok: false,
        status: 429,
        statusText: 'Too Many Requests',
        body: 'rate limited',
        headers: {}
      });
      const refreshSuccessResponse = createMockTLSResponse({
        ok: true,
        status: 200,
        body: JSON.stringify({ token: 'new-token' }),
        headers: { 'set-cookie': ['connect.sid=new-session; Path=/;'] }
      });

      let chatCalls = 0;
      tlsFetchSpy.mockImplementation(async (options) => {
        if (options.url.endsWith('/api/auth/refresh')) {
          return refreshSuccessResponse;  // Refresh succeeds with token
        }
        chatCalls++;
        return rateLimitResponse;  // Chat always returns 429
      });

    const client = new HopGPTClient({
      baseURL: 'https://example.com',
      bearerToken: 'token',  // Non-JWT triggers proactive refresh
      connectSid: 'session-id', openidUserId: 'openid-id',
      rateLimitMaxRetries: 2,
      rateLimitBaseDelayMs: 10
    });
    const sleepSpy = vi.spyOn(client, '_sleep').mockResolvedValue();

    await expect(client.sendMessage({ text: 'hello' })).rejects.toThrow(
      'Rate limit retries exhausted. Please try again later.'
    );
    // Initial attempt + 2 retries = 3 chat calls
    expect(chatCalls).toBe(3);
    expect(sleepSpy).toHaveBeenCalledTimes(2);
  });

    it('does not retry when Retry-After exceeds maxWaitTimeMs', async () => {
      const rateLimitResponse = createMockTLSResponse({
        ok: false,
        status: 429,
        statusText: 'Too Many Requests',
        body: 'rate limited',
        headers: { 'retry-after': '60' }  // 60 seconds
      });
      const refreshSuccessResponse = createMockTLSResponse({
        ok: true,
        status: 200,
        body: JSON.stringify({ token: 'new-token' }),
        headers: { 'set-cookie': ['connect.sid=new-session; Path=/;'] }
      });

      let chatCalls = 0;
      tlsFetchSpy.mockImplementation(async (options) => {
        if (options.url.endsWith('/api/auth/refresh')) {
          return refreshSuccessResponse;  // Refresh succeeds with token
        }
        chatCalls++;
        return rateLimitResponse;
      });

      const client = new HopGPTClient({
        baseURL: 'https://example.com',
        bearerToken: 'token',  // Non-JWT triggers proactive refresh
        connectSid: 'session-id', openidUserId: 'openid-id',
        rateLimitMaxRetries: 3,
        rateLimitMaxWaitTimeMs: 10000  // 10 seconds max
      });

      await expect(client.sendMessage({ text: 'hello' })).rejects.toThrow(
        'Rate limited. Retry after 60 seconds.'
      );
      // Should only call chat once since Retry-After exceeds max wait time
      expect(chatCalls).toBe(1);
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
        rateLimitMaxDelayMs: 30000
      });

      // With Retry-After within max wait time, use Retry-After
      expect(client._calculateBackoffDelay(0, 5000)).toBe(5000);

      // Without Retry-After, use exponential backoff
      const delay0 = client._calculateBackoffDelay(0, null);
      expect(delay0).toBeGreaterThanOrEqual(1000);
      expect(delay0).toBeLessThanOrEqual(1300);  // Base + 30% jitter

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
        headers: {}
      });

      tlsFetchSpy.mockResolvedValue(refreshResponseNoToken);

      const client = new HopGPTClient({
        connectSid: 'valid-session', openidUserId: 'valid-openid',
        autoPersist: false
      });

      const result = await client.refreshTokens();
      expect(result).toBe(false);
    });

    it('throws RefreshTokenExpiredError on 401 response (P1 #5 fix)', async () => {
      const unauthorizedResponse = createMockTLSResponse({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
        body: 'Token expired'
      });

      tlsFetchSpy.mockResolvedValue(unauthorizedResponse);

      const client = new HopGPTClient({
        connectSid: 'expired-session', openidUserId: 'expired-openid',
        autoPersist: false
      });

      await expect(client.refreshTokens()).rejects.toThrow(RefreshTokenExpiredError);
    });

    it('throws RefreshTokenExpiredError on 403 response (P1 #5 fix)', async () => {
      const forbiddenResponse = createMockTLSResponse({
        ok: false,
        status: 403,
        statusText: 'Forbidden',
        body: 'Access denied'
      });

      tlsFetchSpy.mockResolvedValue(forbiddenResponse);

      const client = new HopGPTClient({
        connectSid: 'invalid-session', openidUserId: 'invalid-openid',
        autoPersist: false
      });

      await expect(client.refreshTokens()).rejects.toThrow(RefreshTokenExpiredError);
    });

    it('throws CloudflareBlockedError on 503 response (P1 #5 fix)', async () => {
      const cfBlockedResponse = createMockTLSResponse({
        ok: false,
        status: 503,
        statusText: 'Service Unavailable',
        body: 'Cloudflare error'
      });

      tlsFetchSpy.mockResolvedValue(cfBlockedResponse);

      const client = new HopGPTClient({
        connectSid: 'valid-session', openidUserId: 'valid-openid',
        autoPersist: false
      });

      await expect(client.refreshTokens()).rejects.toThrow(CloudflareBlockedError);
    });

    it('throws NetworkError on network failure (P1 #5 fix)', async () => {
      tlsFetchSpy.mockRejectedValue(new Error('ECONNREFUSED'));

      const client = new HopGPTClient({
        connectSid: 'valid-session', openidUserId: 'valid-openid',
        autoPersist: false
      });

      await expect(client.refreshTokens()).rejects.toThrow(NetworkError);
    });

    it('throws TokenRefreshError when proactive refresh fails (P0 #3 fix)', async () => {
      const refreshFailResponse = createMockTLSResponse({
        ok: true,
        status: 200,
        body: JSON.stringify({}),  // No token in response
        headers: {}
      });

      tlsFetchSpy.mockResolvedValue(refreshFailResponse);

      const client = new HopGPTClient({
        baseURL: 'https://example.com',
        bearerToken: 'invalid-token',  // Non-JWT triggers proactive refresh
        connectSid: 'valid-session', openidUserId: 'valid-openid',
        autoPersist: false
      });

      await expect(client.sendMessage({ text: 'hello' })).rejects.toThrow(TokenRefreshError);
    });

    it('concurrent refreshTokens() calls share the same promise (P0 #1 fix)', async () => {
      let refreshCallCount = 0;
      const refreshSuccessResponse = createMockTLSResponse({
        ok: true,
        status: 200,
        body: JSON.stringify({ token: 'new-token' }),
        headers: { 'set-cookie': ['connect.sid=new-session; Path=/;'] }
      });

      tlsFetchSpy.mockImplementation(async () => {
        refreshCallCount++;
        // Add small delay to ensure both calls happen before first completes
        await new Promise(resolve => setTimeout(resolve, 10));
        return refreshSuccessResponse;
      });

      const client = new HopGPTClient({
        connectSid: 'valid-session', openidUserId: 'valid-openid',
        autoPersist: false
      });

      // Start two concurrent refresh calls
      const [result1, result2] = await Promise.all([
        client.refreshTokens(),
        client.refreshTokens()
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
        cfClearance: 'cf-value'
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
        tokenProvider: 'openid'
      });
      const header = client.buildCookieHeader();
      expect(header).toBe('cf_clearance=cf-value; connect.sid=sid-value; __cf_bm=bm-value; token_provider=openid; openid_user_id=oid-value');
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
      client._parseCookies([
        'cf_clearance=cf-new; Path=/',
        '__cf_bm=bm-new; Path=/'
      ]);
      expect(client.cookies.cf_clearance).toBe('cf-new');
      expect(client.cookies.__cf_bm).toBe('bm-new');
    });
  });

  describe('persistCredentials (.env rewrite)', () => {
    it('strips a stale HOPGPT_COOKIE_REFRESH_TOKEN line and writes the new credential vars', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hopgpt-test-'));
      try {
        const envPath = path.join(tmpDir, '.env');
        fs.writeFileSync(envPath,
          'HOPGPT_COOKIE_REFRESH_TOKEN=stale-value\n' +
          'SOMETHING_ELSE=keep\n'
        );

        const client = new HopGPTClient({
          connectSid: 'fresh-sid',
          openidUserId: 'fresh-openid',
          bearerToken: 'fresh-bearer',
          envPath
        });
        await client.persistCredentials();

        const written = fs.readFileSync(envPath, 'utf-8');
        expect(written).toContain('HOPGPT_COOKIE_CONNECT_SID=fresh-sid');
        expect(written).toContain('HOPGPT_COOKIE_OPENID_USER_ID=fresh-openid');
        expect(written).toContain('HOPGPT_BEARER_TOKEN=fresh-bearer');
        expect(written).not.toContain('HOPGPT_COOKIE_REFRESH_TOKEN');
        expect(written).toContain('SOMETHING_ELSE=keep');
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });
});
