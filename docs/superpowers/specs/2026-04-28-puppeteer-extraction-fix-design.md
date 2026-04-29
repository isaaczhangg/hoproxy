# Fix Puppeteer Credential Extraction + opencode Wiring

**Date:** 2026-04-28
**Status:** Approved (pending implementation)

## Context / Why Firefox-cookie-reading was rejected

An earlier revision of this spec proposed reading cookies directly from Firefox's on-disk `cookies.sqlite`. That approach was verified against the live Firefox profile and **does not work for HopGPT** — the only cookies on `chat.ai.jh.edu` are `openid_user_id` and `token_provider`. There is no refresh-token cookie anywhere in the cookie jar, and HopGPT's `localStorage` holds only UI state (theme, panel layout). HopGPT's bearer token exists only in memory during a live browser session; the only way to capture it from disk-less storage is to be inside an active browser when it flies past on an outgoing HTTP request.

That makes **active-browser request interception** (Puppeteer) the only workable approach. This spec keeps Puppeteer but fixes the hang.

## Problem

`npm run extract` launches Puppeteer, opens HopGPT, the user logs in, and **the browser never closes**. No `.env` is written. Current code in `src/services/browserCredentials.js`:

1. Listens for `Authorization: Bearer ...` headers on requests to `/api/agents/chat/AnthropicClaude` and `/api/auth/*` (lines 88–97). This path only fires when the user actively sends a chat message — **fresh login alone does not trigger it.** Historically LibreChat's page-load hit `/api/auth/refresh` automatically; that appears to no longer be reliable.
2. Polls `page.cookies()` every second for a cookie named `refreshToken` (lines 109–127). **That cookie does not exist on HopGPT** (empirically verified 2026-04-28). The loop runs until `timeout` (default 5 minutes) and then throws.

The cookie-polling path was the dead-code fallback the whole time; it only *appeared* to work historically because the bearer-token interception fired first. When that interception stopped catching anything on login, the cookie-polling path was all that was left, and it waited forever for a cookie that will never appear.

## Goals

1. `npm run extract` closes the browser and writes `.env` within ~15 seconds of successful login, without the user having to send a chat message.
2. The captured bearer token is valid (not stale, not from a different request class).
3. Clear, actionable error messages on failure — not a 5-minute timeout.
4. Write the opencode config that routes opencode through HoProxy.

## Non-Goals

- Switching away from Puppeteer. Verified: no disk-readable alternative exists for HopGPT.
- Headless extraction. SSO still needs a human in the loop.
- Bundling Chromium is a cost (~400 MB); accept it.

## Approach

Rewrite the extraction loop so detection is based on **the signal that actually occurs**: an outgoing HTTP request carrying a `Bearer` token to a HopGPT API endpoint. After the user logs in, we **proactively trigger** an API call from inside the page (via `page.evaluate`) so we don't depend on LibreChat's auto-fetches. The cookie-polling fallback is removed entirely.

## Architecture

### Files changed

| File | Change |
|------|--------|
| `src/services/browserCredentials.js` | Rewrite the extraction loop. Keep Puppeteer + stealth launch code (mostly unchanged). Remove cookie-polling. Add post-login API-call trigger. Add race-based completion. |
| `src/extract-credentials.js` | Minor: `--help` wording. No new flags. `--timeout` stays (now applies to the whole flow). |
| `package.json` | No dep changes. Puppeteer stays. |
| `README.md` | Update "troubleshooting" bullets to reflect the new detection model. |
| `test/services/browserCredentials.test.js` | New. Unit tests for the pure helpers only (the Puppeteer path is tested manually). |

### New detection flow

Two credentials must both be captured: the **bearer token** (from outgoing `Authorization` headers) and the **refreshToken cookie** (set by the server on `/api/auth/refresh` responses). Neither exists persistently — both are in-memory, and the only way to capture them is during a live browser session.

```
extractCredentials(options)
  ├─ launchBrowser()                            ← unchanged
  ├─ await page.setRequestInterception(true)
  ├─ install request handler (outgoing):
  │     on any request to https://chat.ai.jh.edu/api/*
  │       → read Authorization header
  │       → if it starts with "Bearer ", record bearerToken
  ├─ install response handler (incoming, via page.on('response')):
  │     on any response from https://chat.ai.jh.edu/api/auth/refresh
  │       → read Set-Cookie headers
  │       → extract refreshToken value, record it
  ├─ navigate to https://chat.ai.jh.edu
  ├─ poll for login-completion signal: page.url() matches https://chat.ai.jh.edu (no auth host)
  │   AND document.cookie or page context shows authenticated state
  │   (approximate: URL is chat.ai.jh.edu AND a recent outgoing request had no 302 to login.jh.edu)
  ├─ on login detected:
  │     → proactively call: await page.evaluate(() =>
  │         fetch('/api/auth/refresh', { method: 'POST', credentials: 'include',
  │                                       headers: { 'Content-Type': 'application/json' },
  │                                       body: '{}' }))
  │     → the request's Authorization header is captured by the request handler
  │     → the response's Set-Cookie: refreshToken=... is captured by the response handler
  │     → also read page.cookies() for cf_clearance, __cf_bm, token_provider
  ├─ wait until both bearerToken AND refreshToken are captured, then resolve
  ├─ timeout: 5 minutes (configurable). Distinct error paths for:
  │     - navigation failed (Cloudflare challenge, network)
  │     - never reached logged-in state (user closed browser / never logged in)
  │     - reached logged-in state but /api/auth/refresh returned no token + set-cookie
  ├─ on success:
  │     - capture browser.userAgent()
  │     - close browser in a finally block
  │     - generateEnvContent + writeEnvFile (unchanged helpers)
```

### Key design decisions

1. **Both credentials come from one deliberate call to `/api/auth/refresh`.** Bearer token from outgoing `Authorization` header; refresh token cookie from incoming `Set-Cookie` header. Capture both from the same request/response pair.
2. **Proactively call `/api/auth/refresh` from `page.evaluate` after login-completion is detected.** Empirically verified: no refresh-token cookie persists in Firefox's `cookies.sqlite` for HopGPT, and LibreChat's page load does not auto-fetch. We must trigger the request ourselves.
3. **Race, don't poll.** The main wait is `Promise.race([bothCapturedPromise, timeoutPromise, navigationFailurePromise, browserDisconnectedPromise])`. Each resolution leads to a distinct code path.
4. **Always close the browser in `finally`.** The current code has one `browser.close()` on success and one on timeout-throw; if an unexpected exception fires between them the browser leaks. Move to `try { ... } finally { await browser.close() }`.
5. **Detect "logged in" with a URL pattern, not a DOM selector.** DOM selectors rot when LibreChat's UI changes. URL pattern: page URL is on `chat.ai.jh.edu` and the last navigation came from `login.jh.edu` (the IdP origin).
6. **Trigger path is `fetch` inside `page.evaluate`, not `page.goto`.** A `page.goto` would navigate and potentially break the post-login state; `fetch` runs in the page context and fires the request we need without changing what the user sees.
7. **Remove the dead cookie-polling branch entirely.** The old detection was always wrong (`refreshToken` cookie never exists on disk). No feature flag, no legacy path.
8. **Browser-disconnected event guards against manual close.** `browser.on('disconnected', …)` resolves its race branch so the script exits cleanly if the user closes the window.

### Cookies to still collect from `page.cookies()`

These are auxiliary (not the bearer) but the server code uses them as documented in `README.md`:

| Cookie | Source | Required? |
|---|---|---|
| `cf_clearance` | set by Cloudflare on first successful page load | recommended |
| `__cf_bm` | set by Cloudflare on bot-management challenges | recommended |
| `token_provider` | set by HopGPT (value: `librechat`) | recommended, defaults to `librechat` if absent |
| `connect.sid` | set by LibreChat server if using connect/Express sessions | may not exist — empirically absent on HopGPT; keep code defensive |

Crucially: we **do not** look for a `refreshToken` cookie anymore.

### Both bearer token and refresh token are required

The refresh flow in `src/services/hopgptClient.js:474` calls `/api/auth/refresh` with a `Cookie: refreshToken=...` header built from `HOPGPT_COOKIE_REFRESH_TOKEN`. Without that cookie, the initial refresh call at startup fails with 401, and the proxy cannot operate.

So **both** `HOPGPT_BEARER_TOKEN` and `HOPGPT_COOKIE_REFRESH_TOKEN` must be written to `.env`. If we fail to capture either, extraction fails loudly with a specific error. The current script's "write .env even without bearer token" branch is removed — it produces a `.env` that can't authenticate.

## UX

### Happy path

```
$ npm run extract

=== HopGPT Browser Credential Extraction ===

Opening Chrome and navigating to HopGPT...
Please complete the login flow in the browser window.

Waiting for login...
Detected login (redirected from login.jh.edu).
Calling /api/auth/refresh to capture bearer token and refresh cookie...
Captured bearer token.
Captured refresh token.

Closing browser.

Extracted:
  Bearer Token:   yes
  Refresh Token:  yes
  User Agent:     yes
  CF Clearance:   yes
  CF BM:          yes (or "no — will be set on first authenticated call")
  Token Provider: librechat

Wrote .env → /Users/isaaczhang/Projects/HoProxy/.env

Start the proxy: npm start
```

### Error paths

| Condition | Message |
|---|---|
| Timeout before login-completion URL detected | `Login not detected within 5 minutes. Make sure you completed the SSO flow and landed on https://chat.ai.jh.edu. Re-run with --timeout 600 if you need more time.` |
| Login detected, `/api/auth/refresh` called, but bearer or refresh cookie missing | `Logged in but could not capture credentials from /api/auth/refresh. HopGPT may have changed its auth model — please report this. Browser left open for inspection; press Ctrl+C to exit.` |
| `/api/auth/refresh` returned 401/403 | `Auth refresh rejected (status {code}). Your session may have expired between login and capture. Re-run and log in again.` |
| User closes the browser window manually | `Browser was closed before authentication completed.` (detected via `browser.on('disconnected')`) |
| Navigation to HopGPT failed (Cloudflare block, network) | `Could not reach https://chat.ai.jh.edu. Check your network connection and any corporate firewalls.` |

## opencode Config

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
- `(HoProxy)` suffix on model labels is cosmetic; makes provenance visible in the model picker.
- No `x-mcp-passthrough` header. Default mode (XML → `tool_use` blocks) is correct for opencode. Only add `"headers": { "x-mcp-passthrough": "true" }` to `options` if tool-call XML appears as raw text instead of executing.
- **Secrets hygiene:** the existing `mcp.*` block (with any API keys it contains) is preserved byte-for-byte. This spec deliberately does not reproduce those values. The implementation reads the current config, merges the additions above, writes back — it does not reconstruct the file from a template.
- Provider schema confirmed: opencode 1.14.28's installed SDK types expose `provider.anthropic.options.baseURL` and `options.apiKey`. Verified against `~/.config/opencode/node_modules/@opencode-ai/sdk/dist/gen/types.gen.d.ts`.

## Testing

### Unit tests (`test/services/browserCredentials.test.js`)

The Puppeteer-driven extraction path itself is tested manually. Unit-test the pure helpers:

- `generateEnvContent` handles all-fields, minimum-fields, missing-optional-fields.
- `writeEnvFile` preserves non-HopGPT lines and replaces HopGPT lines (existing behavior).
- Any new pure helper introduced during the rewrite (e.g. a function that classifies a URL as "post-login") gets direct coverage.

### Manual verification plan

1. Delete any existing `.env` so nothing is cached.
2. `npm run extract` — log in via JHU SSO. Confirm: browser closes within ~15 s of landing back on `chat.ai.jh.edu`; `.env` contains both `HOPGPT_BEARER_TOKEN` and `HOPGPT_COOKIE_REFRESH_TOKEN`; total wall-clock time under 1 minute.
3. `npm start` boots, `/health` returns 200.
4. `curl -s http://localhost:3001/v1/messages -H 'Content-Type: application/json' -d '{"model":"claude-haiku-4-5","max_tokens":64,"messages":[{"role":"user","content":"ping"}]}'` returns a real model response.
5. Apply the opencode config block above.
6. Run `opencode`. Confirm `/models` lists three HoProxy-labeled models. Send a test message; verify streaming. Ask for a file edit; verify tool-use blocks fire (not raw XML).

**Failure-mode verification** (run at least once, on a clean machine or after explicit logout):

7. Log out of HopGPT in Chrome. Run `npm run extract`, close the browser window without logging in. Verify a clear error message, not a stack trace.
8. Run `npm run extract --timeout 10` (10 s) and wait it out without logging in. Verify the timeout error mentions `--timeout` as the way to extend.

## Rollout

- Single PR, squash merge.
- `.env` stays in `.gitignore`; confirm no secrets leak into commits.
- README diff: replace the troubleshooting bullet "Login timeout after 300 seconds" with a pointer to the new error messages. Drop any claims about detecting login via a `refreshToken` cookie.
