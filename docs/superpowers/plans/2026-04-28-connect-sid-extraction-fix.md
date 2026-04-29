# connect.sid Extraction Fix + HopGPTClient Cleanup + opencode Wiring — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix `npm run extract` hang by waiting for a post-login API signal instead of a nonexistent `refreshToken` cookie; remove the cargo-cult `HOPGPT_COOKIE_REFRESH_TOKEN` throughout HoProxy and replace guards with `connect.sid`; wire opencode to HoProxy.

**Architecture:** Puppeteer stays — disk-based alternatives were empirically disproven (HAR `chat.ai.jh.edu_Archive [26-04-28 23-14-36].har` shows HopGPT uses Express `connect.sid` session cookie, no `refreshToken` cookie ever set). Detection signal is changed from "refreshToken cookie polled" to "first 2xx/304 response from `/api/auth/refresh` OR `/api/config` with `connect.sid` in the request." All `cookies.refreshToken` guards in `HopGPTClient` are replaced with `cookies.connect_sid`. `/token-status` and `/token-debug` response shapes change (breaking, undocumented contract).

**Tech Stack:** Node 18+ ESM, Puppeteer-extra + stealth, Express, vitest.

**Source spec:** `docs/superpowers/specs/2026-04-28-puppeteer-extraction-fix-design.md`

---

## Task ordering rationale

Tasks are ordered so the codebase is never broken mid-plan. Each task ends with all existing tests passing.

1. Server-side cleanup first (Tasks 1–6). These remove the `refreshToken` cookie field and replace guards with `connect.sid`. After Task 6, the server works cleanly when `.env` has `HOPGPT_COOKIE_CONNECT_SID` set.
2. Extractor rewrite second (Tasks 7–10). The new extractor produces a `.env` shape the cleaned-up server already accepts.
3. opencode config third (Task 11). Independent of the rest.
4. Manual verification + README + PR (Tasks 12–13).

---

### Task 1: Remove `refreshToken` from HopGPTClient cookie initializer and `buildCookieHeader`

**Files:**
- Modify: `src/services/hopgptClient.js:39-45` (constructor), `:180-200` (`buildCookieHeader`)
- Test: `test/services/hopgptClient.test.js`

- [ ] **Step 1: Write the failing test**

Open `test/services/hopgptClient.test.js` and add:

```javascript
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

  it('emits only known session + Cloudflare cookies from a clean client', () => {
    const client = new HopGPTClient({
      connectSid: 'sid-value',
      cfClearance: 'cf-value',
      cfBm: 'bm-value',
      tokenProvider: 'openid'
    });
    const header = client.buildCookieHeader();
    expect(header).toBe('cf_clearance=cf-value; connect.sid=sid-value; __cf_bm=bm-value; token_provider=openid');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run test/services/hopgptClient.test.js -t 'buildCookieHeader'
```

Expected: the first test FAILS because `buildCookieHeader` currently pushes a `refreshToken` line when `this.cookies.refreshToken` is truthy.

- [ ] **Step 3: Remove `refreshToken` from the constructor**

Edit `src/services/hopgptClient.js` lines 39–45 so the block reads:

```javascript
    this.cookies = {
      cf_clearance: config.cfClearance || process.env.HOPGPT_COOKIE_CF_CLEARANCE,
      connect_sid: config.connectSid || process.env.HOPGPT_COOKIE_CONNECT_SID,
      __cf_bm: config.cfBm || process.env.HOPGPT_COOKIE_CF_BM,
      token_provider: config.tokenProvider || process.env.HOPGPT_COOKIE_TOKEN_PROVIDER || 'librechat'
    };
```

(The `refreshToken: config.refreshToken || process.env.HOPGPT_COOKIE_REFRESH_TOKEN,` line is deleted entirely.)

- [ ] **Step 4: Remove the `refreshToken` push from `buildCookieHeader`**

Edit `src/services/hopgptClient.js` lines 180–200 so the function body is:

```javascript
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

    return cookies.join('; ');
  }
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
npx vitest run test/services/hopgptClient.test.js -t 'buildCookieHeader'
```

Expected: both new tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/services/hopgptClient.js test/services/hopgptClient.test.js
git commit -m "refactor(hopgptClient): drop unused refreshToken cookie from constructor and cookie header"
```

---

### Task 2: Remove the `refreshToken` branch from `_parseCookies` (Set-Cookie handler)

**Files:**
- Modify: `src/services/hopgptClient.js:228-249`
- Test: `test/services/hopgptClient.test.js`

- [ ] **Step 1: Write the failing test**

Add to `test/services/hopgptClient.test.js`:

```javascript
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
```

- [ ] **Step 2: Run test to verify second test fails**

```bash
npx vitest run test/services/hopgptClient.test.js -t '_parseCookies'
```

Expected: "does NOT set a refreshToken field" FAILS because current code sets `this.cookies.refreshToken = value`.

- [ ] **Step 3: Remove the `refreshToken` branch**

Edit `src/services/hopgptClient.js:228-249`. The function body becomes:

```javascript
  _parseCookies(setCookieHeaders) {
    for (const cookieStr of setCookieHeaders) {
      const [cookiePart] = cookieStr.split(';');
      const equalsIndex = cookiePart.indexOf('=');
      if (equalsIndex === -1) continue;
      const name = cookiePart.substring(0, equalsIndex);
      const value = cookiePart.substring(equalsIndex + 1);

      if (name === 'connect.sid') {
        this.cookies.connect_sid = value;
        log.debug('Session cookie (connect.sid) rotated');
      } else if (name === 'cf_clearance') {
        this.cookies.cf_clearance = value;
      } else if (name === '__cf_bm') {
        this.cookies.__cf_bm = value;
      }
    }
  }
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run test/services/hopgptClient.test.js -t '_parseCookies'
```

Expected: all three tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/hopgptClient.js test/services/hopgptClient.test.js
git commit -m "refactor(hopgptClient): drop refreshToken branch from Set-Cookie parser"
```

---

### Task 3: Replace `refreshToken` guards with `connect_sid` guards in refresh control flow

**Files:**
- Modify: `src/services/hopgptClient.js:378-392` (`_shouldProactivelyRefresh`), `:424-446` (`refreshTokens`), `:841-876` (`validateAuth`)
- Test: `test/services/hopgptClient.test.js`

- [ ] **Step 1: Write the failing tests**

Add to `test/services/hopgptClient.test.js`:

```javascript
describe('refreshTokens() gate', () => {
  it('returns false when connect.sid is missing', async () => {
    const client = new HopGPTClient({ connectSid: null });
    const result = await client.refreshTokens();
    expect(result).toBe(false);
  });
});

describe('validateAuth()', () => {
  it('lists HOPGPT_COOKIE_CONNECT_SID in missing when connect_sid is unset', () => {
    const client = new HopGPTClient({ connectSid: null, bearerToken: 'b' });
    const result = client.validateAuth();
    expect(result.missing).toContain('HOPGPT_COOKIE_CONNECT_SID');
    expect(result.missing).not.toContain('HOPGPT_COOKIE_REFRESH_TOKEN');
  });

  it('valid when only connect_sid is present (bearer can be refreshed)', () => {
    const client = new HopGPTClient({ connectSid: 'sid', bearerToken: null });
    const result = client.validateAuth();
    expect(result.valid).toBe(true);
    expect(result.warnings.some(w => w.includes('HOPGPT_BEARER_TOKEN'))).toBe(true);
  });
});
```

Update existing tests across `test/services/hopgptClient.test.js`. Use your editor's search-and-replace, one pattern at a time, reviewing each hit:

- `refreshToken: 'refresh-token'` → `connectSid: 'session-id'`
- `refreshToken: 'valid-refresh'` → `connectSid: 'valid-session'`
- `refreshToken: 'expired-refresh'` → `connectSid: 'expired-session'`
- `refreshToken: 'invalid-refresh'` → `connectSid: 'invalid-session'`
- `refreshToken: 'old-refresh-token'` → `connectSid: 'old-session'`
- `refreshToken: null` in the test at line 41 ("returns false when refresh token is missing") → change whole line to `connectSid: null` and rename the test title to `'returns false when session cookie is missing'`.

For Set-Cookie mock fixtures, replace every `'set-cookie': ['refreshToken=new-refresh; Path=/;']` with `'set-cookie': ['connect.sid=new-session; Path=/;']`. Update every assertion that reads `client.cookies.refreshToken` to read `client.cookies.connect_sid`. The JWT-with-`=` parse test (around lines 90–114) is testing the cookie parser — keep its structure, just change the cookie name to `connect.sid` and the expected property to `connect_sid`.

Run `grep -n "refreshToken\|refresh-refresh\|refresh-token" test/services/hopgptClient.test.js` after the replacements. You should see only references inside test *titles* (describing user-facing behavior) or inside the error class name `RefreshTokenExpiredError` — no `cookies.refreshToken` property accesses or `refreshToken:` constructor args should remain.

- [ ] **Step 2: Run tests to verify the new ones fail**

```bash
npx vitest run test/services/hopgptClient.test.js
```

Expected: new `refreshTokens() gate` and `validateAuth()` tests FAIL because current code gates on `this.cookies.refreshToken`.

- [ ] **Step 3: Update `_shouldProactivelyRefresh`**

Edit `src/services/hopgptClient.js:378-392`:

```javascript
  _shouldProactivelyRefresh() {
    if (!this.autoRefresh || !this.cookies.connect_sid) {
      return false;
    }

    const expiryInfo = this._getTokenExpiryInfo(this.bearerToken);
    if (!expiryInfo) {
      return true;
    }

    return expiryInfo.expiresInSeconds <= this.proactiveRefreshBufferSec;
  }
```

- [ ] **Step 4: Update `refreshTokens` gate**

Edit `src/services/hopgptClient.js:430-433`. Change:

```javascript
    if (!this.cookies.refreshToken) {
      log.error('No refresh token available');
      return false;
    }
```

to:

```javascript
    if (!this.cookies.connect_sid) {
      log.error('No session cookie (connect.sid) available — run: npm run extract');
      return false;
    }
```

- [ ] **Step 5: Update `validateAuth`**

Edit `src/services/hopgptClient.js:841-876`. The function body becomes:

```javascript
  validateAuth() {
    const missing = [];
    const warnings = [];

    // Session cookie is required for auto-refresh to work
    if (!this.cookies.connect_sid) {
      missing.push('HOPGPT_COOKIE_CONNECT_SID');
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

    // Bearer token is optional if session cookie is available (we can refresh it)
    if (!this.bearerToken) {
      if (this.cookies.connect_sid) {
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
```

- [ ] **Step 6: Run all hopgptClient tests**

```bash
npx vitest run test/services/hopgptClient.test.js
```

Expected: ALL tests PASS (new ones + every existing one, now using `connectSid` fixtures).

- [ ] **Step 7: Commit**

```bash
git add src/services/hopgptClient.js test/services/hopgptClient.test.js
git commit -m "refactor(hopgptClient): gate refresh on connect_sid instead of refreshToken cookie"
```

---

### Task 4: Scrub JWT-expiry log fields from `_doRefreshTokens` (session cookies aren't JWTs)

**Files:**
- Modify: `src/services/hopgptClient.js:453-578` (`_doRefreshTokens`)
- Test: existing tests in `test/services/hopgptClient.test.js` must still pass.

The current code calls `_getTokenExpiryInfo(this.cookies.refreshToken)` expecting a JWT. The session cookie is not a JWT — it's an opaque Express-session value like `s%3AB-NcMDWv...DvcKJUo9qZhD...`. All those calls silently return null today; remove them to stop implying JWT semantics.

- [ ] **Step 1: Remove the pre-refresh expiry-info block**

Edit `src/services/hopgptClient.js:453-471`. Replace:

```javascript
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
```

with:

```javascript
  async _doRefreshTokens() {
    log.info('Attempting token refresh', {
      sessionPresent: !!this.cookies.connect_sid,
      sessionMasked: maskToken(this.cookies.connect_sid)
    });

    try {
```

- [ ] **Step 2: Remove the post-refresh rotation-info block**

Edit `src/services/hopgptClient.js:530-563`. Replace:

```javascript
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
```

with:

```javascript
      // Update cookies from Set-Cookie headers (server may rotate connect.sid)
      const oldSid = this.cookies.connect_sid;

      const setCookieHeaders = response.headers['set-cookie'] || response.headers['Set-Cookie'];
      if (setCookieHeaders) {
        const headerArray = Array.isArray(setCookieHeaders) ? setCookieHeaders : [setCookieHeaders];
        log.debug('Received Set-Cookie headers', {
          count: headerArray.length,
          cookieNames: headerArray.map(h => h.split('=')[0]).join(', ')
        });
      }

      this.updateCookiesFromTLSResponse(response.headers);

      if (this.cookies.connect_sid && this.cookies.connect_sid !== oldSid) {
        log.info('Session cookie rotated by server', {
          old: maskToken(oldSid),
          new: maskToken(this.cookies.connect_sid)
        });
      } else if (!this.cookies.connect_sid) {
        log.error('No session cookie after refresh — future refreshes will fail', {
          hadOldSession: !!oldSid
        });
      }
```

- [ ] **Step 3: Run all hopgptClient tests**

```bash
npx vitest run test/services/hopgptClient.test.js
```

Expected: all tests still PASS. The removed logging has no test coverage, so no test changes are needed beyond what Task 3 already did.

- [ ] **Step 4: Commit**

```bash
git add src/services/hopgptClient.js
git commit -m "refactor(hopgptClient): drop JWT-expiry logging for non-JWT session cookie"
```

---

### Task 5: Update `persistCredentials` to write `HOPGPT_COOKIE_CONNECT_SID` instead of `HOPGPT_COOKIE_REFRESH_TOKEN`

**Files:**
- Modify: `src/services/hopgptClient.js:255-363` (`persistCredentials`)
- Test: existing tests must still pass.

- [ ] **Step 1: Rewrite `persistCredentials`**

Edit `src/services/hopgptClient.js:255-363`. Replace the whole function with:

```javascript
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
    const bearerTokenToSave = this.bearerToken;

    log.debug('Persisting credentials to .env', {
      sessionMasked: maskToken(sessionToSave),
      bearerTokenMasked: maskToken(bearerTokenToSave)
    });

    const writeOperation = (async () => {
      try {
        let existingContent = '';
        const preservedLines = [];

        // Variables we will (re-)write on persist.
        // Note: HOPGPT_COOKIE_REFRESH_TOKEN is included here ONLY so that any
        // stale line from pre-fix .env files gets stripped on next persist.
        const tokenVars = new Set([
          'HOPGPT_BEARER_TOKEN',
          'HOPGPT_COOKIE_CONNECT_SID',
          'HOPGPT_COOKIE_REFRESH_TOKEN'
        ]);

        if (fs.existsSync(this.envPath)) {
          existingContent = fs.readFileSync(this.envPath, 'utf-8');

          for (const line of existingContent.split('\n')) {
            const trimmed = line.trim();

            const isTokenVar = Array.from(tokenVars).some(v =>
              trimmed.startsWith(`${v}=`) || trimmed.startsWith(`# ${v}=`)
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

        // Verify the write by reading back connect.sid
        const verifyContent = fs.readFileSync(this.envPath, 'utf-8');
        const verifyMatch = verifyContent.match(/^HOPGPT_COOKIE_CONNECT_SID=(.+)$/m);
        const verifiedSid = verifyMatch ? verifyMatch[1].trim() : null;

        if (sessionToSave && verifiedSid === sessionToSave) {
          log.info('Credentials persisted and verified in .env', {
            sessionMasked: maskToken(verifiedSid)
          });
        } else if (sessionToSave) {
          log.error('CRITICAL: .env verification failed — session cookie mismatch', {
            expectedMasked: maskToken(sessionToSave),
            actualMasked: maskToken(verifiedSid)
          });
        } else {
          log.debug('Credentials persisted to .env (no session cookie to verify)');
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
```

- [ ] **Step 2: Add a test for the stale-line stripping behavior**

Add to `test/services/hopgptClient.test.js`:

```javascript
describe('persistCredentials (.env rewrite)', () => {
  it('strips a stale HOPGPT_COOKIE_REFRESH_TOKEN line and writes HOPGPT_COOKIE_CONNECT_SID', async () => {
    const fs = await import('fs');
    const os = await import('os');
    const path = await import('path');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hopgpt-test-'));
    const envPath = path.join(tmpDir, '.env');
    fs.writeFileSync(envPath,
      'HOPGPT_COOKIE_REFRESH_TOKEN=stale-value\n' +
      'SOMETHING_ELSE=keep\n'
    );

    const client = new HopGPTClient({
      connectSid: 'fresh-sid',
      bearerToken: 'fresh-bearer',
      envPath
    });
    await client.persistCredentials();

    const written = fs.readFileSync(envPath, 'utf-8');
    expect(written).toContain('HOPGPT_COOKIE_CONNECT_SID=fresh-sid');
    expect(written).toContain('HOPGPT_BEARER_TOKEN=fresh-bearer');
    expect(written).not.toContain('HOPGPT_COOKIE_REFRESH_TOKEN');
    expect(written).toContain('SOMETHING_ELSE=keep');

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
```

- [ ] **Step 3: Run the test**

```bash
npx vitest run test/services/hopgptClient.test.js -t 'persistCredentials'
```

Expected: PASS.

- [ ] **Step 4: Run the full hopgptClient test file**

```bash
npx vitest run test/services/hopgptClient.test.js
```

Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/hopgptClient.js test/services/hopgptClient.test.js
git commit -m "refactor(hopgptClient): persist HOPGPT_COOKIE_CONNECT_SID, strip stale refresh-token line"
```

---

### Task 6: Update `/token-status`, `/token-debug`, and `/refresh-token` routes

**Files:**
- Modify: `src/routes/refreshToken.js`
- Modify: `src/index.js` (startup diagnostics)
- Test: `test/routes/refreshToken.test.js`

- [ ] **Step 1: Update existing test fixtures**

In `test/routes/refreshToken.test.js`, lines 29 and 45 currently have `cookies: { refreshToken: 'refresh-token' }` — change both to `cookies: { connect_sid: 'session-id' }`.

- [ ] **Step 2: Write failing tests for the new response shapes**

Add these describe blocks at the end of `test/routes/refreshToken.test.js` (inside the file but outside the existing `describe('refresh-token route', ...)`):

```javascript
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
```

- [ ] **Step 3: Run tests to verify failures**

```bash
npx vitest run test/routes/refreshToken.test.js
```

Expected: new tests FAIL. Existing tests should still PASS (their fixtures were updated in Step 1).

- [ ] **Step 4: Rewrite `/token-status`**

Edit `src/routes/refreshToken.js:30-59`. Replace the handler with:

```javascript
router.get('/token-status', (req, res) => {
  const client = getDefaultClient();
  log.debug('Checking token status');

  const bearerTokenInfo = getTokenExpiryInfo(client.bearerToken);

  const status = {
    bearerToken: bearerTokenInfo ? {
      ...bearerTokenInfo,
      present: true
    } : {
      present: !!client.bearerToken,
      isExpired: null,
      note: client.bearerToken ? 'Token is not a decodable JWT' : 'No bearer token configured'
    },
    session: {
      present: !!client.cookies?.connect_sid
    },
    autoRefresh: client.autoRefresh,
    timestamp: new Date().toISOString()
  };

  res.json(status);
});
```

- [ ] **Step 5: Rewrite `/refresh-token` missing-credential guard**

Edit `src/routes/refreshToken.js:65-77`. Replace the guard block with:

```javascript
router.post('/refresh-token', async (req, res) => {
  const client = getDefaultClient();
  log.info('Manual token refresh requested');

  if (!client.cookies?.connect_sid) {
    log.warn('Token refresh failed: no session cookie configured');
    return res.status(400).json({
      success: false,
      error: {
        message: 'Missing session cookie (HOPGPT_COOKIE_CONNECT_SID). Run: npm run extract'
      }
    });
  }
```

- [ ] **Step 6: Rewrite `/token-debug`**

Edit `src/routes/refreshToken.js:126-231`. Replace the entire handler with:

```javascript
router.get('/token-debug', (req, res) => {
  const client = getDefaultClient();
  const envPath = path.join(process.cwd(), '.env');
  log.debug('Token debug requested');

  const memoryBearerToken = client.bearerToken;
  const memorySid = client.cookies?.connect_sid;
  const memoryBearerInfo = getTokenExpiryInfo(memoryBearerToken);

  let envBearerToken = null;
  let envSid = null;
  let envReadError = null;

  try {
    if (fs.existsSync(envPath)) {
      const envContent = fs.readFileSync(envPath, 'utf-8');
      const bearerMatch = envContent.match(/^HOPGPT_BEARER_TOKEN=(.+)$/m);
      const sidMatch = envContent.match(/^HOPGPT_COOKIE_CONNECT_SID=(.+)$/m);
      envBearerToken = bearerMatch ? bearerMatch[1].trim() : null;
      envSid = sidMatch ? sidMatch[1].trim() : null;
    }
  } catch (err) {
    envReadError = err.message;
  }

  const envBearerInfo = getTokenExpiryInfo(envBearerToken);

  const debug = {
    timestamp: new Date().toISOString(),
    memory: {
      bearerToken: {
        present: !!memoryBearerToken,
        masked: maskToken(memoryBearerToken),
        length: memoryBearerToken?.length || 0,
        isValidJWT: !!memoryBearerInfo,
        expiresIn: memoryBearerInfo ? `${Math.round(memoryBearerInfo.expiresInSeconds / 60)}min` : null,
        isExpired: memoryBearerInfo?.isExpired ?? null
      },
      session: {
        present: !!memorySid,
        masked: maskToken(memorySid),
        length: memorySid?.length || 0
      }
    },
    envFile: {
      path: envPath,
      readError: envReadError,
      bearerToken: {
        present: !!envBearerToken,
        masked: maskToken(envBearerToken),
        length: envBearerToken?.length || 0,
        isValidJWT: !!envBearerInfo,
        matchesMemory: envBearerToken === memoryBearerToken
      },
      session: {
        present: !!envSid,
        masked: maskToken(envSid),
        length: envSid?.length || 0,
        matchesMemory: envSid === memorySid
      }
    },
    cloudflare: {
      cf_clearance: client.cookies?.cf_clearance ? 'set' : 'NOT SET',
      __cf_bm: client.cookies?.__cf_bm ? 'set' : 'NOT SET'
    },
    config: {
      autoRefresh: client.autoRefresh,
      autoPersist: client.autoPersist,
      proactiveRefreshBufferSec: client.proactiveRefreshBufferSec
    },
    diagnosis: []
  };

  if (!memorySid) {
    debug.diagnosis.push('CRITICAL: No session cookie (connect.sid) in memory — run: npm run extract');
  }

  if (envSid && memorySid && envSid !== memorySid) {
    debug.diagnosis.push('INFO: .env session cookie differs from memory — session may have been rotated; next refresh will re-persist');
  }

  if (!envSid && memorySid) {
    debug.diagnosis.push('WARNING: Session cookie in memory but not in .env — persistence may have failed');
  }

  if (debug.diagnosis.length === 0) {
    debug.diagnosis.push('OK: Token state appears healthy');
  }

  res.json(debug);
});
```

- [ ] **Step 7: Rewrite `src/index.js` startup diagnostics**

Edit `src/index.js:28-105`. Replace `logStartupTokenDiagnostics()` with:

```javascript
function logStartupTokenDiagnostics() {
  const client = getDefaultClient();
  const envPath = path.join(process.cwd(), '.env');

  log.info('=== Token Diagnostics on Startup ===');

  const bearerToken = client.bearerToken;
  const bearerInfo = getTokenExpiryInfo(bearerToken);
  if (bearerToken) {
    log.info('Bearer token', {
      present: true,
      masked: maskToken(bearerToken),
      isValidJWT: !!bearerInfo,
      expiresIn: bearerInfo ? `${Math.round(bearerInfo.expiresInSeconds / 60)}min` : 'N/A',
      isExpired: bearerInfo?.isExpired ?? 'unknown'
    });
  } else {
    log.warn('Bearer token: NOT SET (will attempt refresh on first request)');
  }

  const sid = client.cookies?.connect_sid;
  if (sid) {
    log.info('Session cookie (connect.sid)', {
      present: true,
      masked: maskToken(sid),
      length: sid.length
    });
  } else {
    log.error('Session cookie: NOT SET — authentication will fail (run: npm run extract)');
  }

  try {
    if (fs.existsSync(envPath)) {
      const envContent = fs.readFileSync(envPath, 'utf-8');
      const envSidMatch = envContent.match(/^HOPGPT_COOKIE_CONNECT_SID=(.+)$/m);
      const envSid = envSidMatch ? envSidMatch[1].trim() : null;

      if (envSid && sid && envSid !== sid) {
        log.debug('.env session cookie differs from memory — will be reconciled on next refresh');
      }
    }
  } catch (err) {
    log.debug('Could not verify .env file', { error: err.message });
  }

  const cfClearance = client.cookies?.cf_clearance;
  const cfBm = client.cookies?.__cf_bm;
  if (!cfClearance || !cfBm) {
    log.warn('Cloudflare cookies missing', {
      cf_clearance: cfClearance ? 'set' : 'NOT SET',
      __cf_bm: cfBm ? 'set' : 'NOT SET',
      note: 'This may cause Cloudflare blocks, but TLS fingerprinting should help bypass'
    });
  }

  log.info('=== End Token Diagnostics ===');
}
```

- [ ] **Step 8: Run tests**

```bash
npx vitest run test/routes/refreshToken.test.js
```

Expected: all PASS.

- [ ] **Step 9: Run the full test suite**

```bash
npm test
```

Expected: all PASS.

- [ ] **Step 10: Commit**

```bash
git add src/routes/refreshToken.js src/index.js test/routes/refreshToken.test.js
git commit -m "refactor(routes): rename refreshToken diagnostics to session; remove from public API"
```

---

### Task 7: Rewrite extractor detection — wait for `/api/auth/refresh` OR `/api/config`

**Files:**
- Rewrite: `src/services/browserCredentials.js`
- Test: `test/services/browserCredentials.test.js` (new file)

This task replaces the `while (!authenticated)` polling loop with a `page.on('response')` race.

- [ ] **Step 1: Create the test file with pure-helper tests**

Create `test/services/browserCredentials.test.js` with:

```javascript
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
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run test/services/browserCredentials.test.js
```

Expected: FAIL — `generateEnvContent` and `writeEnvFile` either don't accept the new shape or still emit `HOPGPT_COOKIE_REFRESH_TOKEN`.

- [ ] **Step 3: Rewrite `src/services/browserCredentials.js`**

Replace the entire file contents with:

```javascript
/**
 * Browser Credential Extraction Module
 * Extracts HopGPT credentials by observing authenticated API traffic.
 */
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import fs from 'fs';
import path from 'path';

const HOPGPT_URL = 'https://chat.ai.jh.edu';
const AUTH_REFRESH_PATH = '/api/auth/refresh';
const CONFIG_PATH = '/api/config';

puppeteer.use(StealthPlugin());

async function launchBrowser(options = {}) {
  const launchOptions = {
    headless: false,
    defaultViewport: null,
    args: ['--start-maximized']
  };

  const userDataDir = options.userDataDir || process.env.HOPGPT_PUPPETEER_USER_DATA_DIR;
  if (userDataDir) {
    launchOptions.userDataDir = userDataDir;
  }

  const channel = options.channel || process.env.HOPGPT_PUPPETEER_CHANNEL || 'chrome';

  try {
    return await puppeteer.launch({ ...launchOptions, channel });
  } catch (error) {
    if (!options.channel && !process.env.HOPGPT_PUPPETEER_CHANNEL) {
      console.warn(`Failed to launch Chrome channel (${channel}). Falling back to bundled Chromium.`);
      return await puppeteer.launch(launchOptions);
    }
    throw error;
  }
}

/**
 * Returns true when `response` signals that login is complete.
 */
function isLoginSignal(response) {
  const url = response.url();
  const status = response.status();
  const ok = status >= 200 && status < 400;
  if (!ok) return false;

  if (url.startsWith(HOPGPT_URL + AUTH_REFRESH_PATH)) {
    return true;
  }
  if (url.startsWith(HOPGPT_URL + CONFIG_PATH)) {
    // Accept /api/config as co-primary only if the request carried connect.sid
    const request = response.request();
    const cookieHeader = request.headers()['cookie'] || '';
    return cookieHeader.includes('connect.sid=');
  }
  return false;
}

export async function extractCredentials(options = {}) {
  const envPath = options.envPath || path.join(process.cwd(), '.env');
  const timeout = options.timeout || 5 * 60 * 1000;

  console.log('\n=== HopGPT Browser Credential Extraction ===\n');
  console.log('Opening browser and navigating to HopGPT...');
  console.log('Please complete the login flow in the browser window.\n');

  const browser = await launchBrowser(options);
  let bearerToken = null;

  try {
    const page = await browser.newPage();

    // Capture Authorization headers on any outgoing chat.ai.jh.edu/api/* request.
    // This is not request-intercepting (no request.continue() needed) — we observe
    // via the request event, which does not block the request.
    page.on('request', (request) => {
      const url = request.url();
      if (!url.startsWith(HOPGPT_URL + '/api/')) return;
      const auth = request.headers()['authorization'];
      if (auth && auth.startsWith('Bearer ')) {
        bearerToken = auth.slice('Bearer '.length);
      }
    });

    // Primary: resolve when we see a post-login API response.
    const loginDetected = new Promise((resolve) => {
      const handler = (response) => {
        if (isLoginSignal(response)) {
          page.off('response', handler);
          resolve({ reason: 'api-signal', url: response.url() });
        }
      };
      page.on('response', handler);
    });

    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error(
        `Login not detected within ${timeout / 1000} seconds. Make sure you completed the SSO flow and landed on ${HOPGPT_URL}. Re-run with --timeout 600 if you need more time.`
      )), timeout)
    );

    const disconnectedPromise = new Promise((_, reject) => {
      browser.on('disconnected', () => reject(new Error('Browser was closed before login completed.')));
    });

    await page.goto(HOPGPT_URL, { waitUntil: 'networkidle2' });
    console.log('Waiting for login...');

    const outcome = await Promise.race([loginDetected, timeoutPromise, disconnectedPromise]);
    console.log(`Detected authenticated API call (${new URL(outcome.url).pathname}).`);

    // Harvest cookies.
    const cookies = await page.cookies(HOPGPT_URL);
    const userAgent = await browser.userAgent().catch(() => null);

    const credentials = {
      bearerToken,
      userAgent,
      cookies: {
        connect_sid: findCookie(cookies, 'connect.sid'),
        cf_clearance: findCookie(cookies, 'cf_clearance'),
        __cf_bm: findCookie(cookies, '__cf_bm'),
        token_provider: findCookie(cookies, 'token_provider')
      }
    };

    if (!credentials.cookies.connect_sid) {
      throw new Error('Logged in but connect.sid cookie was not set. This shouldn\'t happen — please report.');
    }

    const envContent = generateEnvContent(credentials);
    writeEnvFile(envPath, envContent);

    console.log('\nExtracted:');
    console.log(`  connect.sid:    ${credentials.cookies.connect_sid ? 'yes' : 'no'}`);
    console.log(`  cf_clearance:   ${credentials.cookies.cf_clearance ? 'yes' : 'no'}`);
    console.log(`  __cf_bm:        ${credentials.cookies.__cf_bm ? 'yes' : 'no'}`);
    console.log(`  token_provider: ${credentials.cookies.token_provider || '(default: librechat)'}`);
    console.log(`  Bearer Token:   ${credentials.bearerToken ? 'yes' : 'no — will be minted on first request'}`);
    console.log(`  User Agent:     ${credentials.userAgent ? 'yes' : 'no'}`);
    console.log(`\nWrote .env → ${envPath}\n`);

    return credentials;
  } finally {
    await browser.close().catch(() => {});
  }
}

function findCookie(cookies, name) {
  const hit = cookies.find((c) => c.name === name);
  return hit ? hit.value : null;
}

/**
 * Build the .env contents from a credentials object. Pure — no I/O.
 */
export function generateEnvContent(credentials) {
  const lines = [
    '# HopGPT Credentials',
    '# Auto-generated by browser credential extraction',
    `# Generated at: ${new Date().toISOString()}`,
    ''
  ];

  if (credentials.bearerToken) {
    lines.push(`HOPGPT_BEARER_TOKEN=${credentials.bearerToken}`);
  } else {
    lines.push('# HOPGPT_BEARER_TOKEN= (will be minted automatically on first request)');
  }

  if (credentials.userAgent) {
    lines.push(`HOPGPT_USER_AGENT="${credentials.userAgent}"`);
  }

  if (credentials.cookies.connect_sid) {
    lines.push(`HOPGPT_COOKIE_CONNECT_SID=${credentials.cookies.connect_sid}`);
  }
  if (credentials.cookies.cf_clearance) {
    lines.push(`HOPGPT_COOKIE_CF_CLEARANCE=${credentials.cookies.cf_clearance}`);
  }
  if (credentials.cookies.__cf_bm) {
    lines.push(`HOPGPT_COOKIE_CF_BM=${credentials.cookies.__cf_bm}`);
  }
  if (credentials.cookies.token_provider) {
    lines.push(`HOPGPT_COOKIE_TOKEN_PROVIDER=${credentials.cookies.token_provider}`);
  }

  lines.push('');
  return lines.join('\n');
}

/**
 * Write or update .env file, preserving non-HopGPT variables.
 * Also strips any stale HOPGPT_COOKIE_REFRESH_TOKEN line from prior versions.
 */
export function writeEnvFile(envPath, newContent) {
  let preservedLines = [];

  if (fs.existsSync(envPath)) {
    const existingContent = fs.readFileSync(envPath, 'utf-8');

    const hopgptVars = [
      'HOPGPT_BEARER_TOKEN',
      'HOPGPT_USER_AGENT',
      'HOPGPT_COOKIE_CF_CLEARANCE',
      'HOPGPT_COOKIE_CONNECT_SID',
      'HOPGPT_COOKIE_CF_BM',
      'HOPGPT_COOKIE_REFRESH_TOKEN', // strip on rewrite
      'HOPGPT_COOKIE_TOKEN_PROVIDER'
    ];

    for (const line of existingContent.split('\n')) {
      const trimmed = line.trim();

      if (trimmed === '' ||
          trimmed.startsWith('# HopGPT') ||
          trimmed.startsWith('# Auto-generated') ||
          trimmed.startsWith('# Generated at')) {
        continue;
      }

      const isHopgptVar = hopgptVars.some(v =>
        trimmed.startsWith(v + '=') || trimmed.startsWith(`# ${v}`)
      );
      if (!isHopgptVar) {
        preservedLines.push(line);
      }
    }
  }

  let finalContent = newContent;
  if (preservedLines.length > 0) {
    finalContent = newContent + '\n# Other configuration\n' + preservedLines.join('\n') + '\n';
  }

  fs.writeFileSync(envPath, finalContent);
}

export default { extractCredentials };
```

- [ ] **Step 4: Run the helper tests**

```bash
npx vitest run test/services/browserCredentials.test.js
```

Expected: all PASS.

- [ ] **Step 5: Run the full test suite**

```bash
npm test
```

Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add src/services/browserCredentials.js test/services/browserCredentials.test.js
git commit -m "feat(extract): detect login via /api/auth/refresh or /api/config, harvest connect.sid"
```

---

### Task 8: Update the CLI wrapper `src/extract-credentials.js`

**Files:**
- Modify: `src/extract-credentials.js`

- [ ] **Step 1: Update the `--help` block**

Edit `src/extract-credentials.js` lines 20–42. Replace the `--help` block with:

```javascript
  } else if (args[i] === '--help' || args[i] === '-h') {
    console.log(`
HopGPT Credential Extraction

Extracts credentials from a live browser session by observing the post-login
/api/auth/refresh or /api/config call. Writes them to .env.

Usage: npm run extract [-- options]

Options:
  --env-path <path>    Path to .env file (default: .env in project root)
  --timeout <seconds>  Timeout to wait for login (default: 300 seconds)
  --help, -h           Show this help message

Environment:
  HOPGPT_PUPPETEER_CHANNEL       Chrome channel for Puppeteer (default: chrome)
  HOPGPT_PUPPETEER_USER_DATA_DIR Chrome user data directory (optional)

Example:
  npm run extract
  npm run extract -- --timeout 600
  npm run extract -- --env-path /path/to/.env
`);
    process.exit(0);
  }
```

(No behavioral change; help text now reflects the new detection mechanism.)

- [ ] **Step 2: Commit**

```bash
git add src/extract-credentials.js
git commit -m "docs(extract): update CLI help to describe the new detection signal"
```

---

### Task 9: Run end-to-end extraction manually to verify

**Files:** none modified.

This task does not mutate code — it's a manual gate before the next tasks.

- [ ] **Step 1: Back up any existing `.env`**

```bash
cd /Users/isaaczhang/Projects/HoProxy
cp .env .env.backup 2>/dev/null || true
rm -f .env
```

- [ ] **Step 2: Run extraction**

```bash
npm run extract
```

Expected:
- Chrome window opens.
- You log in via JHU SSO.
- Within ~15 s of landing on the chat UI, the terminal prints `Detected authenticated API call (...)` and then the extraction summary.
- Chrome closes.
- A fresh `.env` exists.

- [ ] **Step 3: Inspect the written `.env`**

```bash
grep -E '^HOPGPT_' .env | sed 's/=.*/=<redacted>/'
```

Expected lines:
```
HOPGPT_BEARER_TOKEN=<redacted>   (optional — may be absent if the Authorization header was not intercepted)
HOPGPT_USER_AGENT=<redacted>
HOPGPT_COOKIE_CONNECT_SID=<redacted>
HOPGPT_COOKIE_CF_CLEARANCE=<redacted>
HOPGPT_COOKIE_CF_BM=<redacted>   (sometimes absent — Cloudflare only sets this selectively)
HOPGPT_COOKIE_TOKEN_PROVIDER=openid
```

There MUST NOT be a `HOPGPT_COOKIE_REFRESH_TOKEN` line.

- [ ] **Step 4: If extraction hangs or errors, diagnose before moving on**

Common failures and fixes:
- **Times out at 300s:** you didn't finish logging in; re-run.
- **`connect.sid cookie was not set`:** HopGPT's auth flow changed. Dump `page.cookies()` manually and update the harvest path.
- **Chrome launches but fails to load:** `HOPGPT_PUPPETEER_CHANNEL=chrome` and you may not have Chrome installed; unset to use bundled Chromium.

Do NOT proceed to Task 10 until extraction produces a valid `.env`.

---

### Task 10: Run end-to-end proxy verification

**Files:** none modified.

- [ ] **Step 1: Start the proxy in the background**

```bash
cd /Users/isaaczhang/Projects/HoProxy
npm start &
SERVER_PID=$!
sleep 2
```

- [ ] **Step 2: Health check**

```bash
curl -s http://localhost:3001/health
```

Expected: `{"status":"ok","timestamp":"..."}`

- [ ] **Step 3: Send a real model request**

```bash
curl -s http://localhost:3001/v1/messages \
  -H 'Content-Type: application/json' \
  -d '{"model":"claude-haiku-4-5","max_tokens":64,"messages":[{"role":"user","content":"Say hello in 3 words."}]}' \
  | head -c 800
```

Expected: a JSON response with `content[0].text` containing a greeting. Confirms the full round-trip (auto-refresh of the bearer token via `connect.sid` included, since we did not capture one in extraction).

- [ ] **Step 4: Check `/token-status` reflects the new shape**

```bash
curl -s http://localhost:3001/token-status | python3 -m json.tool
```

Expected JSON with `bearerToken` and `session: { present: true }` keys. Confirm **no** `refreshToken` key.

- [ ] **Step 5: Stop the server**

```bash
kill $SERVER_PID
```

- [ ] **Step 6: (No commit — this is a verification-only task.)**

---

### Task 11: Wire opencode to HoProxy

**Files:**
- Modify: `~/.config/opencode/opencode.json`

This edit is outside the project tree and preserves the user's existing MCP config byte-for-byte.

- [ ] **Step 1: Back up the existing config**

```bash
cp ~/.config/opencode/opencode.json ~/.config/opencode/opencode.json.bak
```

- [ ] **Step 2: Read the current config**

```bash
cat ~/.config/opencode/opencode.json
```

Note the existing `mcp.context7` block (including the `CONTEXT7_API_KEY` header value) — this MUST be preserved verbatim.

- [ ] **Step 3: Merge provider additions into the existing config**

Open `~/.config/opencode/opencode.json` in an editor. Keep the top-level `$schema`, `autoupdate`, and `mcp` blocks unchanged. Add a `provider` block and a top-level `model` key so the final file looks like:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "autoupdate": true,
  "provider": {
    "anthropic": {
      "options": {
        "baseURL": "http://localhost:3001/v1",
        "apiKey": "dummy"
      },
      "models": {
        "claude-sonnet-4-5": { "name": "Claude Sonnet 4.5 (HoProxy)" },
        "claude-opus-4-5":   { "name": "Claude Opus 4.5 (HoProxy)" },
        "claude-haiku-4-5":  { "name": "Claude Haiku 4.5 (HoProxy)" }
      }
    }
  },
  "model": "anthropic/claude-sonnet-4-5",
  "mcp": {
    "context7": {
      "type": "remote",
      "url": "https://mcp.context7.com/mcp",
      "headers": {
        "CONTEXT7_API_KEY": "<preserve existing value>"
      },
      "enabled": true
    }
  }
}
```

When pasting into the editor, copy the existing `CONTEXT7_API_KEY` value byte-for-byte from the backup; do not retype it.

- [ ] **Step 4: Validate the JSON**

```bash
python3 -m json.tool ~/.config/opencode/opencode.json > /dev/null && echo OK
```

Expected: `OK`. If it errors, restore the backup and retry.

- [ ] **Step 5: Launch opencode and verify**

In a terminal with the HoProxy server running (`npm start` in another window):

```bash
opencode
```

Inside opencode:
1. Run `/models` — expect `anthropic/claude-sonnet-4-5 (HoProxy)`, `anthropic/claude-opus-4-5 (HoProxy)`, `anthropic/claude-haiku-4-5 (HoProxy)` to appear.
2. Send a test message: "Write a haiku about proxies." Expect a streaming response.
3. Ask: "Read the README and summarize it in 2 sentences." Expect opencode to execute the read tool (not echo raw XML).

If the tool-call symptom appears (raw `<function_calls>` XML instead of execution), add `"headers": { "x-mcp-passthrough": "true" }` inside `provider.anthropic.options` and retry. The HAR evidence suggests this won't be needed, but it's a one-line fallback.

- [ ] **Step 6: No commit** — this config change lives outside the repo.

---

### Task 12: Update `README.md`

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update the minimum-required `.env` block**

Edit `README.md:47-62` (the "Manual Credential Setup" section). Replace:

```bash
# .env (minimum required)
HOPGPT_COOKIE_REFRESH_TOKEN=eyJhbGciOiJIUzI1NiIs...

# Optional (auto-obtained via refresh token)
HOPGPT_BEARER_TOKEN=eyJhbGciOiJIUzI1NiIs...
HOPGPT_USER_AGENT="Mozilla/5.0 ..."
HOPGPT_COOKIE_CF_CLEARANCE=...
HOPGPT_COOKIE_CONNECT_SID=...
HOPGPT_COOKIE_CF_BM=...
```

with:

```bash
# .env (minimum required)
HOPGPT_COOKIE_CONNECT_SID=s%3A...

# Optional (set by extractor; Cloudflare cookies recommended)
HOPGPT_BEARER_TOKEN=eyJhbGciOiJIUzI1NiIs...   # auto-minted on first request if absent
HOPGPT_USER_AGENT="Mozilla/5.0 ..."
HOPGPT_COOKIE_CF_CLEARANCE=...
HOPGPT_COOKIE_CF_BM=...
HOPGPT_COOKIE_TOKEN_PROVIDER=openid
```

- [ ] **Step 2: Update the Environment Variables table**

Edit `README.md:336-358`. Remove this row:

```
| `HOPGPT_COOKIE_REFRESH_TOKEN` | Refresh token cookie (required for auto-refresh) |
```

The table still has `HOPGPT_COOKIE_CONNECT_SID` documented (line 345). No additions needed.

- [ ] **Step 3: Update the Minimal Configuration section**

Edit `README.md:406-413`. Replace:

```
With auto-refresh enabled, you only need to provide the **refresh token**. The bearer token will be obtained automatically on the first request:

```bash
# Minimal .env configuration
HOPGPT_COOKIE_REFRESH_TOKEN=eyJhbGciOiJIUzI1NiIs...
```
```

with:

```
With auto-refresh enabled, you only need to provide the **session cookie** (`connect.sid`). The bearer token will be minted automatically on the first request:

```bash
# Minimal .env configuration
HOPGPT_COOKIE_CONNECT_SID=s%3A...
```
```

- [ ] **Step 4: Add a note about the `/token-status` shape change**

Edit `README.md:371-373` (API Endpoints table area). Below the `/token-status` row, add a new line:

```
> **Note (breaking change, 2026-04-28):** `/token-status` and `/token-debug` no longer expose a `refreshToken` field. HopGPT does not use a refresh-token cookie; the session is keyed by `connect.sid`. Use `session.present` instead.
```

- [ ] **Step 5: Verify Markdown renders**

```bash
grep -n 'HOPGPT_COOKIE_REFRESH_TOKEN' README.md
```

Expected: no matches.

- [ ] **Step 6: Commit**

```bash
git add README.md
git commit -m "docs: describe connect.sid-based auth; drop HOPGPT_COOKIE_REFRESH_TOKEN references"
```

---

### Task 13: Open the PR

**Files:** none modified — PR metadata only.

- [ ] **Step 1: Push the branch**

```bash
git push -u origin HEAD
```

- [ ] **Step 2: Open the PR**

```bash
gh pr create --title "Fix npm run extract + clean up refreshToken cargo cult + wire opencode" --body "$(cat <<'EOF'
## Summary

- `npm run extract` no longer hangs. It now detects login by observing the first 2xx/304 response from `POST /api/auth/refresh` or `GET /api/config` (with `connect.sid` in the request), matching what HopGPT actually does after SSO. HAR evidence: `chat.ai.jh.edu_Archive [26-04-28 23-14-36].har`.
- HopGPT does not use a `refreshToken` cookie. The session is keyed by `connect.sid`. `HOPGPT_COOKIE_REFRESH_TOKEN` is now removed from client guards, persistence, startup diagnostics, and both public status endpoints.
- opencode routed through HoProxy via `~/.config/opencode/opencode.json` (documented in spec; not a repo change).

## Breaking change

`/token-status` and `/token-debug` response shapes change. The `refreshToken` field is removed. Use `session.present` instead. These endpoints were not documented as stable contracts.

## Migration

Users of prior `.env` files can delete the `HOPGPT_COOKIE_REFRESH_TOKEN=...` line or leave it — nothing reads it after this change. Re-running `npm run extract` strips the stale line.

## Test plan

- [x] `npm test` — all existing tests updated to new fixtures; new coverage added for `buildCookieHeader`, `_parseCookies`, `persistCredentials`, `/token-status` shape, extraction helpers.
- [x] Manual: `npm run extract` completes in <15s after login; `.env` has `HOPGPT_COOKIE_CONNECT_SID`, no `HOPGPT_COOKIE_REFRESH_TOKEN`.
- [x] Manual: `npm start` + `curl /v1/messages` returns a real model response (proves auto-refresh via `connect.sid`).
- [x] Manual: `opencode` shows three HoProxy-labeled models; streaming and tool-use work.
EOF
)"
```

- [ ] **Step 3: Verify the PR URL is returned and the branch is up to date.**

---

## Self-review checklist (for reviewers)

Before merging, confirm:

1. `grep -rn HOPGPT_COOKIE_REFRESH_TOKEN src/ test/` returns zero matches.
2. `grep -rn 'cookies.refreshToken\|cookies\\.refreshToken' src/` returns zero matches (function names like `refreshTokens()` are fine).
3. `npm test` green.
4. `.env.backup` from Task 9 should be removed before the PR merges if it's still present in the working tree. Check `git status`.
