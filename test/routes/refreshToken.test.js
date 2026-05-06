import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CloudflareBlockedError, RefreshTokenExpiredError } from '../../src/errors/authErrors.js';
import refreshTokenRouter from '../../src/routes/refreshToken.js';
import { getDefaultClient } from '../../src/services/hopgptClient.js';

vi.mock('../../src/services/hopgptClient.js', async () => {
  const actual = await vi.importActual('../../src/services/hopgptClient.js');
  return {
    ...actual,
    getDefaultClient: vi.fn(),
  };
});

function createApp() {
  const app = express();
  app.use(refreshTokenRouter);
  return app;
}

describe('refresh-token route', () => {
  beforeEach(() => {
    getDefaultClient.mockReset();
  });

  it('returns authentication_error when refresh token expired', async () => {
    const mockClient = {
      cookies: {
        connect_sid: 'session-id',
        refreshToken: 'refresh-token',
        openid_user_id: 'openid-id',
      },
      refreshTokens: vi.fn(),
    };
    mockClient.refreshTokens.mockRejectedValue(new RefreshTokenExpiredError());
    getDefaultClient.mockReturnValue(mockClient);

    const app = createApp();
    const response = await request(app).post('/refresh-token');

    expect(response.status).toBe(401);
    expect(response.body.success).toBe(false);
    expect(response.body.error.type).toBe('authentication_error');
  });

  it('returns api_error when Cloudflare blocks refresh', async () => {
    const mockClient = {
      cookies: {
        connect_sid: 'session-id',
        refreshToken: 'refresh-token',
        openid_user_id: 'openid-id',
      },
      refreshTokens: vi.fn(),
    };
    mockClient.refreshTokens.mockRejectedValue(new CloudflareBlockedError());
    getDefaultClient.mockReturnValue(mockClient);

    const app = createApp();
    const response = await request(app).post('/refresh-token');

    expect(response.status).toBe(503);
    expect(response.body.success).toBe(false);
    expect(response.body.error.type).toBe('api_error');
  });
});

describe('GET /token-status', () => {
  beforeEach(() => {
    getDefaultClient.mockReset();
  });

  it('returns bearerToken, refreshCredential, openidUser, and session state', async () => {
    getDefaultClient.mockReturnValue({
      bearerToken: 'bearer',
      cookies: { connect_sid: 'sid', refreshToken: null, openid_user_id: 'oid' },
      autoRefresh: true,
    });

    const app = createApp();
    const res = await request(app).get('/token-status');

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('bearerToken');
    expect(res.body).toHaveProperty('refreshCredential');
    expect(res.body.refreshCredential.present).toBe(true);
    expect(res.body.refreshCredential.kind).toBe('session');
    expect(res.body).toHaveProperty('openidUser');
    expect(res.body.openidUser.present).toBe(true);
    expect(res.body).toHaveProperty('session');
    expect(res.body.session).toEqual({ present: true });
  });

  it('reports session refresh when both session and legacy refreshToken exist', async () => {
    getDefaultClient.mockReturnValue({
      bearerToken: 'bearer',
      cookies: { connect_sid: 'sid', refreshToken: 'stale-refresh', openid_user_id: 'oid' },
      autoRefresh: true,
    });

    const app = createApp();
    const res = await request(app).get('/token-status');

    expect(res.status).toBe(200);
    expect(res.body.refreshCredential.present).toBe(true);
    expect(res.body.refreshCredential.kind).toBe('session');
  });

  it('refreshCredential.present is false when refresh credentials are unset', async () => {
    getDefaultClient.mockReturnValue({
      bearerToken: null,
      cookies: {},
      autoRefresh: true,
    });

    const app = createApp();
    const res = await request(app).get('/token-status');

    expect(res.body.refreshCredential.present).toBe(false);
    expect(res.body.openidUser.present).toBe(false);
    expect(res.body.session).toEqual({ present: false });
  });
});

describe('POST /refresh-token — missing refresh credential', () => {
  beforeEach(() => {
    getDefaultClient.mockReset();
  });

  it('returns 400 with session credential hint when refresh credentials are missing', async () => {
    getDefaultClient.mockReturnValue({
      cookies: {},
      refreshTokens: vi.fn(),
    });

    const app = createApp();
    const res = await request(app).post('/refresh-token');

    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('HOPGPT_COOKIE_CONNECT_SID');
    expect(res.body.error.message).toContain('HOPGPT_COOKIE_OPENID_USER_ID');
  });

  it('uses session refresh credentials when refreshToken is absent', async () => {
    const mockClient = {
      bearerToken: 'new-bearer',
      cookies: { connect_sid: 'session-id', refreshToken: null, openid_user_id: 'openid-id' },
      refreshTokens: vi.fn().mockResolvedValue(true),
    };
    getDefaultClient.mockReturnValue(mockClient);

    const app = createApp();
    const res = await request(app).post('/refresh-token');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(mockClient.refreshTokens).toHaveBeenCalledOnce();
  });
});
