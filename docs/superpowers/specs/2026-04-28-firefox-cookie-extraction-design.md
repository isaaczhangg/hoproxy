# Firefox Cookie Extraction + opencode Wiring

**Date:** 2026-04-28
**Status:** Approved (pending implementation)

## Problem

Current credential extraction (`npm run extract`) launches Puppeteer-controlled Chromium, asks the user to log into HopGPT again, and polls `page.cookies()` for a cookie named `refreshToken` to detect login. In practice the loop never fires: the Chrome window opens, the user logs in via JHU SSO, and the browser never closes. No `.env` is written. The user's real browser (Firefox) already holds a valid HopGPT session — the extractor ignores it.

## Goals

1. Eliminate the second login. Read cookies from the browser the user actually uses.
2. `npm run extract` completes in under 2 seconds.
3. `.env` is always written on success, with a clear error on failure.
4. Write the opencode config that points opencode at HoProxy.

## Non-Goals

- Chrome / Safari support. Firefox only.
- Windows / Linux support. macOS only (project is darwin-only).
- Removing the manual `.env` escape hatch. Keep it documented.
- Bearer-token scraping. HoProxy's auto-refresh path handles this from the refresh cookie.

## Approach

Read Firefox's `cookies.sqlite` directly. Auto-pick the profile whose HopGPT session is newest. Write `.env`. No browser launch.

## Architecture

### Files changed

| File | Change |
|------|--------|
| `src/services/browserCredentials.js` | Rewrite. Public export `extractCredentials(options)` keeps the same signature. Internals read Firefox SQLite instead of launching Puppeteer. |
| `src/extract-credentials.js` | Update `--help` text. Add `--profile <name>` flag. Drop Puppeteer env-var docs. Accept `--timeout` as no-op for backward compat. |
| `package.json` | Remove `puppeteer`, `puppeteer-extra`, `puppeteer-extra-plugin-stealth`. Add `better-sqlite3`. |
| `README.md` | Update Quick Start + credential extraction sections. Drop `HOPGPT_PUPPETEER_*` env-var docs. |
| `test/services/browserCredentials.test.js` | New. Unit tests against fixture SQLite DBs built in temp dirs. |

### Module layout

```
extractCredentials(options)             ← public, unchanged signature
  ├─ findFirefoxProfilesDir()           ← returns ~/Library/Application Support/Firefox/Profiles, or throws with helpful error
  ├─ listProfiles(profilesDir)          ← returns [{ name, path, cookiesDbPath }]
  ├─ readHopGPTCookies(profile)         ← returns { cookies: {...}, refreshTokenCreationTime } | null
  │     ├─ open with better-sqlite3 using file:...?mode=ro&immutable=1 URI
  │     └─ fallback: copy cookies.sqlite to os.tmpdir() and read the copy
  ├─ pickProfile(profiles)              ← newest-login-wins by refreshToken.creationTime
  ├─ buildCredentials(cookies)          ← maps moz_cookies rows → credentials shape
  ├─ generateEnvContent(credentials)    ← unchanged from current implementation
  └─ writeEnvFile(path, content)        ← unchanged from current implementation
```

### Key design decisions

1. **No bearer-token extraction.** HoProxy refreshes bearer tokens from the refresh cookie on the first API call. Eliminating the scrape removes the fragile, slow part.
2. **User agent.** Hardcode a current Firefox macOS UA as a sensible default: `Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:128.0) Gecko/20100101 Firefox/128.0`. Cloudflare doesn't do strict UA matching — it checks plausibility.
3. **Profile selection.** Auto-pick newest-login (max `refreshToken.creationTime`, which `moz_cookies` stores as microseconds since epoch). `--profile <name>` overrides.
4. **SQLite access.** `better-sqlite3` (synchronous, simpler control flow). Open read-only with `immutable=1` URI flag. If Firefox is mid-write and that still fails, fall back to copying `cookies.sqlite` to `os.tmpdir()` and reading the copy.
5. **Clean break.** Remove Puppeteer entirely. No feature flag, no dual code path.

### Cookie query

```sql
SELECT name, value, host, expiry, creationTime
FROM moz_cookies
WHERE host = 'chat.ai.jh.edu' OR host = '.ai.jh.edu' OR host = '.jh.edu'
```

Map relevant names into the credentials shape:

| `moz_cookies.name` | Destination |
|---|---|
| `refreshToken` | `credentials.cookies.refreshToken` |
| `cf_clearance` | `credentials.cookies.cf_clearance` |
| `connect.sid` | `credentials.cookies.connect_sid` |
| `__cf_bm` | `credentials.cookies.__cf_bm` |
| `token_provider` | `credentials.cookies.token_provider` (default `librechat`) |

## UX

### Happy path

```
$ npm run extract

=== HopGPT Credential Extraction (Firefox) ===

Scanning Firefox profiles at ~/Library/Application Support/Firefox/Profiles...
Found HopGPT session in profile: xyz123.default-release (refresh token created 2 minutes ago)

Extracted:
  Refresh Token: yes
  CF Clearance:  yes
  Connect SID:   yes
  CF BM:         yes
  User Agent:    yes (Firefox default)

Wrote .env → /Users/isaaczhang/Projects/HoProxy/.env

Start the proxy: npm start
```

### Error paths

| Condition | Message |
|---|---|
| Firefox profiles dir missing | `Firefox profile directory not found at ~/Library/Application Support/Firefox/Profiles. Is Firefox installed?` |
| No profile has HopGPT cookies | `No Firefox profile has an active HopGPT session. Log into https://chat.ai.jh.edu in Firefox, then re-run.` |
| `cookies.sqlite` locked after fallback | `Firefox appears to be mid-write. Close Firefox and retry, or the issue may be a permissions problem.` |
| Refresh token present, Cloudflare cookies missing | Warn, still write `.env` (refresh token alone enables auto-refresh). |
| `--profile <name>` specified but not found | `Profile "<name>" not found under ~/Library/Application Support/Firefox/Profiles. Available: <list>` |

## opencode Config

Edit `~/.config/opencode/opencode.json` (global scope). Override the existing `anthropic` provider to route through HoProxy.

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
        "CONTEXT7_API_KEY": "ctx7sk-1e96710a-c3b6-4fed-81bd-9edd2eee75e8"
      },
      "enabled": true
    }
  }
}
```

- `baseURL` includes `/v1` because HoProxy mounts routes at `/v1/messages`, `/v1/models`.
- `apiKey: "dummy"` — HoProxy does not validate, but the SDK requires a non-empty string.
- `(HoProxy)` suffix on model labels is cosmetic; makes provenance visible in the model picker.
- No `x-mcp-passthrough` header. Default mode (XML → `tool_use` blocks) is correct for opencode. Only add `"headers": { "x-mcp-passthrough": "true" }` to `options` if tool-call XML appears as raw text instead of executing.

## Testing

### Unit tests (`test/services/browserCredentials.test.js`)

- `findFirefoxProfilesDir` returns correct darwin path; throws when missing.
- `listProfiles` handles a temp profiles dir with two fake profile folders.
- `readHopGPTCookies` extracts expected names from a fixture `cookies.sqlite` built in a temp dir with seeded `moz_cookies` rows.
- `pickProfile` returns the profile with the newest `refreshToken.creationTime` given three candidates.
- `buildCredentials` handles missing cookies gracefully.
- `generateEnvContent` / `writeEnvFile` — existing behavior preserved.

### Manual verification plan

1. `npm run extract` completes in under 2s, writes `.env`, lists extracted cookies.
2. `npm start` boots, `/health` returns 200.
3. `curl -s http://localhost:3001/v1/messages -H 'Content-Type: application/json' -d '{"model":"claude-haiku-4-5","max_tokens":64,"messages":[{"role":"user","content":"ping"}]}'` returns a real model response (proves auto-refresh works without a captured bearer token).
4. Apply the opencode config block above.
5. Run `opencode`. Confirm `/models` lists three HoProxy-labeled models. Send a test message; verify streaming. Ask for a file edit; verify tool-use blocks fire (not raw XML).

## Rollout

- Single PR, squash merge — no useful intermediate state.
- `.env` stays in `.gitignore`; confirm no secrets leak.
- README updates: replace the Puppeteer-specific extraction steps with "log into HopGPT in Firefox, then `npm run extract`." Keep the manual `.env` template as an explicit fallback.
