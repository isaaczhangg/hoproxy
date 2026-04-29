import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  generateEnvContent,
  writeEnvFile
} from '../../src/services/browserCredentials.js';

describe('generateEnvContent', () => {
  it('produces the minimum-viable .env with only connect.sid', () => {
    const content = generateEnvContent({
      bearerToken: null,
      userAgent: null,
      cookies: {
        connect_sid: 'sid-abc',
        cf_clearance: null,
        __cf_bm: null,
        token_provider: null
      }
    });
    expect(content).toContain('HOPGPT_COOKIE_CONNECT_SID=sid-abc');
    expect(content).not.toContain('HOPGPT_BEARER_TOKEN=');
    expect(content).not.toContain('HOPGPT_COOKIE_REFRESH_TOKEN');
  });

  it('produces full .env with every cookie populated', () => {
    const content = generateEnvContent({
      bearerToken: 'bearer-xyz',
      userAgent: 'Mozilla/5.0 test',
      cookies: {
        connect_sid: 'sid-abc',
        cf_clearance: 'cf-1',
        __cf_bm: 'bm-2',
        token_provider: 'openid'
      }
    });
    expect(content).toContain('HOPGPT_BEARER_TOKEN=bearer-xyz');
    expect(content).toContain('HOPGPT_USER_AGENT="Mozilla/5.0 test"');
    expect(content).toContain('HOPGPT_COOKIE_CONNECT_SID=sid-abc');
    expect(content).toContain('HOPGPT_COOKIE_CF_CLEARANCE=cf-1');
    expect(content).toContain('HOPGPT_COOKIE_CF_BM=bm-2');
    expect(content).toContain('HOPGPT_COOKIE_TOKEN_PROVIDER=openid');
  });
});

describe('generateEnvContent — missing connect.sid', () => {
  it('still generates content (caller is responsible for validation)', () => {
    // Rationale: extractCredentials() throws BEFORE calling generateEnvContent
    // when connect.sid is missing (see explicit check in extractCredentials).
    // The pure helper stays permissive so it's composable; validation is the
    // caller's job.
    const content = generateEnvContent({
      bearerToken: null,
      userAgent: null,
      cookies: { connect_sid: null, cf_clearance: null, __cf_bm: null, token_provider: null }
    });
    expect(content).not.toContain('HOPGPT_COOKIE_CONNECT_SID=');
  });
});

describe('writeEnvFile', () => {
  it('strips a stale HOPGPT_COOKIE_REFRESH_TOKEN line while preserving unrelated vars', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hopgpt-ext-'));
    const envPath = path.join(tmp, '.env');
    fs.writeFileSync(envPath,
      '# existing header\n' +
      'HOPGPT_COOKIE_REFRESH_TOKEN=stale\n' +
      'UNRELATED_VAR=keep-me\n'
    );

    writeEnvFile(envPath, 'HOPGPT_COOKIE_CONNECT_SID=fresh\n');

    const written = fs.readFileSync(envPath, 'utf-8');
    expect(written).toContain('HOPGPT_COOKIE_CONNECT_SID=fresh');
    expect(written).not.toContain('HOPGPT_COOKIE_REFRESH_TOKEN');
    expect(written).toContain('UNRELATED_VAR=keep-me');

    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
