import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it, vi } from 'vitest';
import {
  generateEnvContent,
  refreshBrowserSession,
  writeEnvFile,
} from '../../src/services/browserCredentials.js';

describe('generateEnvContent', () => {
  it('produces the minimum-viable .env with session and openid_user_id', () => {
    const content = generateEnvContent({
      bearerToken: null,
      userAgent: null,
      cookies: {
        connect_sid: 'sid-abc',
        refreshToken: null,
        openid_user_id: 'oid-abc',
        cf_clearance: null,
        __cf_bm: null,
        token_provider: null,
      },
    });
    expect(content).toContain('HOPGPT_COOKIE_CONNECT_SID=sid-abc');
    expect(content).toContain('HOPGPT_COOKIE_OPENID_USER_ID=oid-abc');
    expect(content).not.toContain('HOPGPT_COOKIE_REFRESH_TOKEN=');
    expect(content).not.toContain('HOPGPT_COOKIE_TOKEN_PROVIDER=');
    expect(content).not.toContain('HOPGPT_BEARER_TOKEN=');
  });

  it('produces full .env with every cookie populated', () => {
    const content = generateEnvContent({
      bearerToken: 'bearer-xyz',
      userAgent: 'Mozilla/5.0 test',
      cookies: {
        connect_sid: 'sid-abc',
        refreshToken: 'refresh-abc',
        openid_user_id: 'oid-abc',
        cf_clearance: 'cf-1',
        __cf_bm: 'bm-2',
        token_provider: 'openid',
      },
    });
    expect(content).toContain('HOPGPT_BEARER_TOKEN=bearer-xyz');
    expect(content).toContain('HOPGPT_USER_AGENT="Mozilla/5.0 test"');
    expect(content).toContain('HOPGPT_COOKIE_REFRESH_TOKEN=refresh-abc');
    expect(content).toContain('HOPGPT_COOKIE_CONNECT_SID=sid-abc');
    expect(content).toContain('HOPGPT_COOKIE_OPENID_USER_ID=oid-abc');
    expect(content).toContain('HOPGPT_COOKIE_CF_CLEARANCE=cf-1');
    expect(content).toContain('HOPGPT_COOKIE_CF_BM=bm-2');
    expect(content).toContain('HOPGPT_COOKIE_TOKEN_PROVIDER=openid');
  });
});

describe('generateEnvContent — missing openid_user_id', () => {
  it('still generates content (caller is responsible for validation)', () => {
    // Rationale: extractCredentials() throws BEFORE calling generateEnvContent
    // when openid_user_id is missing. The pure helper stays permissive so it's
    // composable; validation is the caller's job.
    const content = generateEnvContent({
      bearerToken: null,
      userAgent: null,
      cookies: {
        connect_sid: null,
        refreshToken: null,
        openid_user_id: null,
        cf_clearance: null,
        __cf_bm: null,
        token_provider: null,
      },
    });
    expect(content).not.toContain('HOPGPT_COOKIE_OPENID_USER_ID=');
  });
});

describe('writeEnvFile', () => {
  it('removes stale refreshToken when writing session credentials', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hopgpt-ext-'));
    try {
      const envPath = path.join(tmp, '.env');
      fs.writeFileSync(
        envPath,
        '# existing header\n' + 'HOPGPT_COOKIE_REFRESH_TOKEN=stale\n' + 'UNRELATED_VAR=keep-me\n',
      );

      writeEnvFile(
        envPath,
        'HOPGPT_COOKIE_CONNECT_SID=fresh-sid\nHOPGPT_COOKIE_OPENID_USER_ID=fresh\n',
      );

      const written = fs.readFileSync(envPath, 'utf-8');
      expect(written).toContain('HOPGPT_COOKIE_CONNECT_SID=fresh-sid');
      expect(written).toContain('HOPGPT_COOKIE_OPENID_USER_ID=fresh');
      expect(written).not.toContain('HOPGPT_COOKIE_REFRESH_TOKEN=stale');
      expect(written).toContain('UNRELATED_VAR=keep-me');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('refreshBrowserSession', () => {
  it('uses browser credentials to validate refreshability and return the minted bearer token', async () => {
    const page = {
      evaluate: vi.fn(async (_callback, refreshPath) => {
        expect(refreshPath).toBe('/api/auth/refresh');
        return {
          ok: true,
          status: 200,
          contentType: 'application/json; charset=utf-8',
          body: JSON.stringify({ token: 'minted-token' }),
        };
      }),
    };

    const token = await refreshBrowserSession(page);

    expect(token).toBe('minted-token');
    expect(page.evaluate).toHaveBeenCalledOnce();
  });

  it('fails before writing credentials when browser refresh does not return JSON', async () => {
    const page = {
      evaluate: vi.fn(async () => ({
        ok: true,
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: 'Refresh token not provided',
      })),
    };

    await expect(refreshBrowserSession(page)).rejects.toThrow(
      'Browser refresh failed: Refresh token not provided',
    );
  });
});
