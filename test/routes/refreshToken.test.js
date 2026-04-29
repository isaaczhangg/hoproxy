import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import refreshTokenRouter from '../../src/routes/refreshToken.js';
import { getDefaultClient } from '../../src/services/hopgptClient.js';
import { RefreshTokenExpiredError, CloudflareBlockedError } from '../../src/errors/authErrors.js';

vi.mock('../../src/services/hopgptClient.js', async () => {
  const actual = await vi.importActual('../../src/services/hopgptClient.js');
  return {
    ...actual,
    getDefaultClient: vi.fn()
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
      cookies: { connect_sid: 'session-id' },
      refreshTokens: vi.fn()
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
      cookies: { connect_sid: 'session-id' },
      refreshTokens: vi.fn()
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

  it('returns new shape with session.present = true and no refreshToken field', async () => {
    getDefaultClient.mockReturnValue({
      bearerToken: 'bearer',
      cookies: { connect_sid: 'sid' },
      autoRefresh: true
    });

    const app = createApp();
    const res = await request(app).get('/token-status');

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('bearerToken');
    expect(res.body).toHaveProperty('session');
    expect(res.body.session).toEqual({ present: true });
    expect(res.body).not.toHaveProperty('refreshToken');
  });

  it('session.present is false when connect_sid is unset', async () => {
    getDefaultClient.mockReturnValue({
      bearerToken: null,
      cookies: {},
      autoRefresh: true
    });

    const app = createApp();
    const res = await request(app).get('/token-status');

    expect(res.body.session).toEqual({ present: false });
  });
});

describe('POST /refresh-token — missing session', () => {
  beforeEach(() => {
    getDefaultClient.mockReset();
  });

  it('returns 400 with HOPGPT_COOKIE_CONNECT_SID hint when connect_sid missing', async () => {
    getDefaultClient.mockReturnValue({
      cookies: {},
      refreshTokens: vi.fn()
    });

    const app = createApp();
    const res = await request(app).post('/refresh-token');

    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('HOPGPT_COOKIE_CONNECT_SID');
  });
});
