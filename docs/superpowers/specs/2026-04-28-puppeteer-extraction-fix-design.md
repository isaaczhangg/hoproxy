# Extraction Rewrite + connect.sid Session Fix + opencode Wiring

**Date:** 2026-04-28
**Status:** Approved (pending implementation)

## Executive Summary

HoProxy's `npm run extract` hangs because its detection loop waits for a cookie named `refreshToken` that HopGPT has never set. A HAR capture of a real login (`chat.ai.jh.edu_Archive [26-04-28 23-14-36].har`) shows definitively that HopGPT uses the Express session cookie `connect.sid` for authentication and does not use a `refreshToken` cookie at all. `HOPGPT_COOKIE_REFRESH_TOKEN` is a misnamed variable whose presence is required only by a client-side guard; the value itself is ignored by the server.

This spec fixes three things in one PR:
1. Rewrite the extractor to capture `connect.sid` (the real session cookie) plus auxiliary Cloudflare cookies.
2. Replace every `cookies.refreshToken` guard and reference in `hopgptClient.js` / routes / tests with `cookies.connect_sid`. Delete the `HOPGPT_COOKIE_REFRESH_TOKEN` env var.
3. Wire opencode to HoProxy via `~/.config/opencode/opencode.json`.

## Evidence (what the HAR proved)

From `/api/auth/refresh` request (status 200):

- **Request headers:** no `Authorization`, no `Cookie: refreshToken=...`. Only `connect.sid`, `openid_user_id`, `token_provider`, `cf_clearance`, `__cf_bm` (plus Google Analytics cookies irrelevant to auth).
- **Response JSON body:** `{ token: "eyJ...", user: {...} }` — the bearer token.
- **Response `Set-Cookie` headers:** rotated `token_provider`, `openid_user_id`, `connect.sid`. **No `refreshToken` cookie.**

After `/api/auth/refresh`, all subsequent `/api/*` requests carry `Authorization: Bearer <token>` + the same cookies. `connect.sid` is the session key; everything else flows from it.

## Goals

1. `npm run extract` writes a working `.env` within ~15 s of successful login, without the user having to send a chat message.
2. The written `.env` is honest — no cargo-cult `HOPGPT_COOKIE_REFRESH_TOKEN`, no fields the server doesn't read.
3. HoProxy's refresh flow, token status, and startup diagnostics work correctly based on `connect.sid` instead of the nonexistent `refreshToken` cookie.
4. Wire opencode to HoProxy.

## Non-Goals

- Switching away from Puppeteer. Verified: no disk-readable path exists (cookies are HttpOnly and only present in a live browser session).
- Headless extraction. SSO still needs a human in the loop.
- Backwards compatibility with `.env` files that set `HOPGPT_COOKIE_REFRESH_TOKEN`. Leaving the line in a user's `.env` is harmless; nothing reads it after this change. No migration script needed.

## Part 1 — Extraction rewrite

### Detection signal

Accept **either** of two signals, whichever fires first:

1. **Primary:** successful response (2xx or 304) from `POST https://chat.ai.jh.edu/api/auth/refresh`. The HAR shows this fires on fresh login.
2. **Co-primary:** successful response (2xx or 304) from `GET https://chat.ai.jh.edu/api/config` **where the request carried `Cookie: connect.sid=...`**. The HAR shows `/api/config` fires on every page load regardless of whether `/api/auth/refresh` runs, which covers the case of "user already had a valid bearer cached" — the most likely real-world scenario.

Treating both as primary removes the 30-second wait that a primary-then-fallback design would impose.

**Final fallback:** if neither signal fires within the overall timeout (default 300 s) but `page.cookies()` already shows `connect.sid`, treat that as success and harvest. This covers unanticipated changes to LibreChat's startup flow.

The extractor does NOT try to detect login by URL pattern. SSO flows go through Shibboleth and/or Duo, and the intermediate hops are not stable.

### New extraction flow

```
extractCredentials(options)
  ├─ launchBrowser()                                     ← unchanged
  ├─ attach: page.on('response', handler)
  │     on response from chat.ai.jh.edu/api/* with status in 200..399 (not 3xx redirects out)
  │       → signal "logged in"
  ├─ navigate to https://chat.ai.jh.edu
  ├─ race:
  │     - login-detected promise → proceed
  │     - timeout (default 300 s) → throw with clear message
  │     - browser disconnected → throw "browser closed before login"
  ├─ once logged in:
  │     - harvest cookies via page.cookies('https://chat.ai.jh.edu'):
  │         connect.sid         (REQUIRED — fails loudly if absent)
  │         cf_clearance        (recommended)
  │         __cf_bm             (optional — only set by Cloudflare bot-mgmt)
  │         token_provider      (optional — the server rotates this on /api/auth/refresh;
  │                              current value is 'openid' per HAR, though HoProxy defaults to 'librechat')
  │     - capture browser.userAgent()
  │     - if we intercepted a bearer from an outgoing Authorization header,
  │       save it as HOPGPT_BEARER_TOKEN (optional; HoProxy will mint one on demand)

  openid_user_id is NOT harvested. It's set by HopGPT on response but is OIDC subject
  metadata — the server does not require it to be echoed back in subsequent requests
  (the HAR shows subsequent /api/* calls carry it only because the browser cookie jar
  re-attaches it automatically). HoProxy's server code does not read or forward it.
  ├─ validate: connect.sid MUST be present; fail loudly if not
  ├─ generateEnvContent + writeEnvFile (pure helpers, rewritten to drop refresh-token line)

  ENTIRE flow is wrapped in try { ... } finally { await browser.close().catch(noop) }
  so the browser is closed on every exit path: success, timeout, thrown error, manual
  Ctrl+C. The current code only closes on success and on timeout-throw, which leaks
  Chromium processes on any other exception.
```

### Files to change

| File | Change |
|------|--------|
| `src/services/browserCredentials.js` | Rewrite extraction. Delete `cookieMap['refreshToken']` detection. Replace with first-200 response detection. Harvest `connect.sid` as primary. Always-close browser in `finally`. Remove references to `refreshToken` from credentials shape. |
| `src/extract-credentials.js` | Minor: `--help` wording. `--timeout` stays. |
| `package.json` | No dep changes. Puppeteer stays. |

### CLI UX

**Happy path:**

```
$ npm run extract

=== HopGPT Browser Credential Extraction ===

Opening browser and navigating to HopGPT...
Please complete the login flow in the browser window.

Waiting for login...
Detected authenticated API call (/api/config returned 304).

Extracted:
  connect.sid:     yes
  cf_clearance:    yes
  __cf_bm:         yes
  token_provider:  openid
  User Agent:      yes

Closing browser.
Wrote .env → /Users/isaaczhang/Projects/HoProxy/.env

Start the proxy: npm start
```

**Error paths:**

| Condition | Message |
|---|---|
| Timeout before any authenticated `/api/*` response seen | `Login not detected within {N} seconds. Make sure you completed the SSO flow and landed on https://chat.ai.jh.edu. Re-run with --timeout 600 for more time.` |
| Login detected but `connect.sid` missing from `page.cookies()` | `Logged in but connect.sid cookie was not set. This shouldn't happen — please report.` |
| Browser window closed manually before login | `Browser closed before login completed.` (via `browser.on('disconnected')`) |
| Network failure reaching HopGPT | `Could not reach https://chat.ai.jh.edu. Check your network and any corporate firewalls.` |

## Part 2 — HoProxy client fix (replace refreshToken guard with connect.sid)

### Change inventory

The `cookies.refreshToken` field in the `HopGPTClient` is used as a **guard** in several places. Each guard's intent is "do we have a usable session?" — and the answer should be determined by `connect.sid`, not the nonexistent `refreshToken`. The server already sends `connect.sid` on every request via `buildCookieHeader()`; we just need to stop requiring a field the server doesn't read.

The function name `refreshTokens()` itself describes what it does (refresh the *bearer* token) and stays. Only the `cookies.refreshToken` field and `HOPGPT_COOKIE_REFRESH_TOKEN` env var are removed.

| File | Change |
|---|---|
| `src/services/hopgptClient.js:43` | Remove `refreshToken: ... process.env.HOPGPT_COOKIE_REFRESH_TOKEN` from the `this.cookies` initializer. |
| `src/services/hopgptClient.js:192-194` | Remove the `cookies.push('refreshToken=...')` branch from `buildCookieHeader()`. |
| `src/services/hopgptClient.js:238-239` | Remove the `if (name === 'refreshToken')` branch in `updateCookiesFromSetCookie()` (or whatever the setter is named). Do **not** remove similar handling for `connect.sid`. |
| `src/services/hopgptClient.js:266-347` | The auto-persist-to-`.env` logic currently writes `HOPGPT_COOKIE_REFRESH_TOKEN`. Rewrite to write `HOPGPT_COOKIE_CONNECT_SID` whenever `connect.sid` is rotated by a response's `Set-Cookie` header. Drop the verify-against-`.env` bit for `refreshToken`; add an equivalent for `connect.sid`. |
| `src/services/hopgptClient.js:378-391` (`_shouldProactivelyRefresh()`) | Change the guard from "do we have a refresh token" to "do we have a session cookie." `connect.sid` is the correct replacement. Crucially: rename any local variables or log fields that imply JWT semantics (e.g., `refreshTokenInfo`, `refreshTokenExpiry`) — session cookies have no parseable expiry, and those names would be misleading. |
| `src/services/hopgptClient.js:430` | `if (!this.cookies.refreshToken) { log.error('No refresh token available'); return false; }` → `if (!this.cookies.connect_sid) { log.error('No session cookie (connect.sid) available'); return false; }`. |
| `src/services/hopgptClient.js:454-465, 531-556` | Remove all `_getTokenExpiryInfo(this.cookies.refreshToken)` diagnostic calls and the associated log fields (`refreshTokenExpiry`, `refreshTokenMasked`, etc.). Session cookies have no parseable expiry — the existing code's attempt to treat the refresh token as a JWT is dead even today (it just silently returns null). Replace with a generic "session present" boolean (`sessionPresent: !!this.cookies.connect_sid`) and a masked session ID where we previously masked the refresh token. |
| `src/services/hopgptClient.js:780` | `refreshed = await this.refreshTokens()` in the 401/403 retry path — stays as-is; the function name is correct (it refreshes the bearer). Guard at the top of `refreshTokens()` already updated by the 430 change. |
| `src/services/hopgptClient.js:841-868` (`validateAuth()`) | Preflight check currently adds `HOPGPT_COOKIE_REFRESH_TOKEN` to the `missing` list when absent. Change to add `HOPGPT_COOKIE_CONNECT_SID`. The warning-vs-error level shouldn't change: missing `connect.sid` is a hard error (can't authenticate), missing Cloudflare cookies remain warnings. |
| `src/services/hopgptClient.js:228-248` (`updateCookiesFromSetCookie` or equivalent) | Keep the `connect.sid` parsing path (it already exists). Remove the `if (name === 'refreshToken')` branch entirely. This is where rotated cookies from `/api/auth/refresh` get saved — we need `connect.sid` rotation support, not `refreshToken`. |
| `src/index.js:50-85` | `client.cookies?.refreshToken` diagnostic at startup. Replace with `client.cookies?.connect_sid`. Stop trying to get JWT expiry from a non-JWT. |
| `src/routes/refreshToken.js` | Rename is out of scope; keep file name. Internally: update `client.cookies?.refreshToken` checks to `client.cookies?.connect_sid`. `/token-status` response shape changes: drop `refreshToken.expiresAt` (cannot compute for non-JWT) and replace with a simple `session: { present: true/false }` field. Update `/token-debug` similarly. |
| `README.md:54, 346, 412` | Remove `HOPGPT_COOKIE_REFRESH_TOKEN` from the minimum-required section. Replace with `HOPGPT_COOKIE_CONNECT_SID` as the sole required cookie. Keep `HOPGPT_COOKIE_TOKEN_PROVIDER` as optional. Do NOT add `HOPGPT_COOKIE_OPENID_USER_ID` — the server code does not forward it. |
| `test/services/hopgptClient.test.js` | Update fixtures: every `refreshToken: 'refresh-token'` in `new HopGPTClient({...})` becomes `connectSid: 'session-id'`. The `set-cookie: refreshToken=...` fixtures in `/api/auth/refresh` mocks become `set-cookie: connect.sid=...`, because that's what the server actually rotates. |
| `test/routes/refreshToken.test.js` | Same: fixtures now use `cookies.connect_sid`. |

### Token status endpoint (`/token-status`) — BREAKING CHANGE

Current shape is JWT-centric (`expiresAt`, `expiresInSeconds`). After the change, for the session cookie, those fields are not meaningful. New shape:

```json
{
  "bearerToken": {
    "present": true,
    "expiresInSeconds": 842
  },
  "session": {
    "present": true
  }
}
```

The `refreshToken: { ... }` object is removed.

**This is a breaking change to the response shape.** HoProxy's README lists `/token-status` and `/token-debug` as existing endpoints but does not document their JSON shape as a stable contract, so no external consumer should depend on it. Call this out in the PR description and in a one-line migration note in the README: "if you depended on the `refreshToken` field of `/token-status`, note that HopGPT does not actually use a refresh-token cookie; use `session.present` instead."

### Debug endpoint (`/token-debug`) — BREAKING CHANGE

Currently compares memory vs `.env` for both bearer and refresh token. After the change: compare bearer (unchanged), and for the session cookie, compare `memoryConnectSid === envConnectSid` (masked). Drop the entire `refreshToken:` branch. Same breaking-change note as `/token-status`.

## Part 3 — opencode Config

Edit `~/.config/opencode/opencode.json` (global scope). The implementation **preserves all existing fields** (schema URL, `autoupdate`, existing `mcp.*` entries and their secrets) and adds only the `provider.anthropic` block plus a top-level `model` default. The concrete additions:

```json
{
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
  "model": "anthropic/claude-sonnet-4-5"
}
```

- `baseURL` includes `/v1` because HoProxy mounts routes at `/v1/messages`, `/v1/models`.
- `apiKey: "dummy"` — HoProxy does not validate, but the SDK requires a non-empty string.
- `(HoProxy)` suffix on model labels makes provenance visible in the model picker.
- No `x-mcp-passthrough` header. Default mode (XML → `tool_use` blocks) is correct for opencode. Only add `"headers": { "x-mcp-passthrough": "true" }` to `options` if tool-call XML appears as raw text instead of executing.
- **Secrets hygiene:** the existing `mcp.*` block is preserved byte-for-byte. The implementation reads the current config, merges the additions above, writes back — it does not reconstruct the file from a template.
- Provider schema confirmed: opencode 1.14.28's installed SDK types expose `provider.anthropic.options.baseURL` and `options.apiKey`. Verified against `~/.config/opencode/node_modules/@opencode-ai/sdk/dist/gen/types.gen.d.ts`.

## Testing

### Unit tests to update

**`test/services/hopgptClient.test.js` — comprehensive update required across all test groups:**

- Constructors: every `new HopGPTClient({ ..., refreshToken: '...' })` → `connectSid: '...'`.
- Cookie-parsing tests (including the JWT-with-`=` edge case at lines 90–114): `set-cookie: refreshToken=...` → `set-cookie: connect.sid=...`. Assert `client.cookies.connect_sid` updates.
- Rate-limit / retry refresh mocks (lines 142–268): update `refreshToken=new-refresh` fixtures to `connect.sid=new-session`. Assertions that read `client.cookies.refreshToken` → `client.cookies.connect_sid`.
- Refresh error-handling tests (lines 298–434): `refreshToken: 'valid-refresh'` / `'expired-refresh'` / `'invalid-refresh'` → `connectSid: 'valid-session'` / `'expired-session'` / `'invalid-session'`. The semantic meaning of "expired" becomes "server rejects with 401/403," which is tested via response mocking, not by JWT decoding — existing test structure still works.
- Concurrent-refresh mutex test (line 403): keep the test; update fixture values.
- The test titled `refreshTokens() returns false when no refresh token` → rename to `returns false when no session cookie`. Assert the new log message string.

**`test/routes/refreshToken.test.js` — broader update than prior inventory:**

- Fixture clients use `cookies: { connect_sid: 'session-id' }` instead of `refreshToken`.
- Existing tests only cover `/refresh-token` POST error mapping. Add new tests for:
  - `/token-status` GET returns the new `{ bearerToken: {...}, session: { present: bool } }` shape; asserts absence of a `refreshToken` top-level field.
  - `/token-debug` GET returns comparison between memory and `.env` for bearer and session, no `refreshToken` field.
- Tests of missing-configuration behavior: `'Missing refresh token configuration (HOPGPT_COOKIE_REFRESH_TOKEN)'` error message → `'Missing session cookie (HOPGPT_COOKIE_CONNECT_SID)'`.

**New tests for the extractor's pure helpers:**

- `generateEnvContent` with all cookies present.
- `generateEnvContent` with only `connect.sid` (minimum viable).
- `generateEnvContent` with `connect.sid` missing → helper returns null or an error object (caller throws).
- `writeEnvFile` preserves non-HopGPT lines and does not leave a stale `HOPGPT_COOKIE_REFRESH_TOKEN=...` line if one existed in the prior `.env` — it should be actively removed on rewrite.

The Puppeteer path itself is tested manually.

### Manual verification plan

1. Delete `.env`.
2. `npm run extract` — log in via JHU SSO. Confirm: browser closes within ~15 s; `.env` contains `HOPGPT_COOKIE_CONNECT_SID` (required), and at least one of `HOPGPT_COOKIE_CF_CLEARANCE` / `HOPGPT_COOKIE_CF_BM`. No `HOPGPT_COOKIE_REFRESH_TOKEN` is written.
3. `npm start` → `/health` returns 200.
4. `curl -s http://localhost:3001/v1/messages -H 'Content-Type: application/json' -d '{"model":"claude-haiku-4-5","max_tokens":64,"messages":[{"role":"user","content":"ping"}]}'` returns a real model response.
5. Wait for the bearer to expire (or mint one manually and hard-set it to expired), send another request, and confirm auto-refresh fires: HoProxy logs show a successful call to `/api/auth/refresh` and a new bearer minted.
6. `curl http://localhost:3001/token-status` returns the new shape `{ bearerToken: {...}, session: { present: true } }`.
7. Apply the opencode config block. `opencode` → `/models` lists three HoProxy-labeled models. Send a test message; verify streaming. Ask for a file edit; verify tool-use blocks fire.

**Failure-mode verification:**

8. Close the browser window during extract without logging in → clear error, no stack trace.
9. Set `HOPGPT_COOKIE_CONNECT_SID=garbage` in `.env`, start the server, send a request → proxy surfaces a clean 401 from HopGPT (not a crash).

## Rollout

- Single PR, squash merge. Scope is wider than previous drafts but still one coherent change.
- `.env` stays in `.gitignore`.
- Migration note for existing users: "You can delete `HOPGPT_COOKIE_REFRESH_TOKEN` from your `.env`; it's no longer used. Re-run `npm run extract` to get a working `.env`." Leaving the old line is harmless.
- README changes are documentation-only; no grace period needed.
