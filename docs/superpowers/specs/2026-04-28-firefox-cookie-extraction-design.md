# Firefox Cookie Extraction + opencode Wiring

**Date:** 2026-04-28
**Status:** Approved, pending verification (§ Pre-Implementation Verification) before implementation

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
  ├─ snapshotCookieDb(profile)          ← copies cookies.sqlite, -wal, -shm atomically to os.tmpdir()
  ├─ readHopGPTCookies(snapshotDir)     ← opens the snapshot read-only with better-sqlite3; returns { cookies: {...}, refreshTokenLastAccessed } | null
  ├─ pickProfile(profiles)              ← newest-login-wins by refreshToken.lastAccessed
  ├─ buildCredentials(cookies)          ← maps moz_cookies rows → credentials shape
  ├─ generateEnvContent(credentials)    ← unchanged from current implementation
  └─ writeEnvFile(path, content)        ← unchanged from current implementation
```

### Key design decisions

1. **No bearer-token extraction.** HoProxy refreshes bearer tokens from the refresh cookie on the first API call. Eliminating the scrape removes the fragile, slow part.
2. **User agent.** Hardcode a current Firefox macOS UA as a sensible default: `Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:128.0) Gecko/20100101 Firefox/128.0`. Cloudflare doesn't do strict UA matching — it checks plausibility.
3. **Profile selection.** Auto-pick newest-login (max `refreshToken.lastAccessed`). Rationale: Firefox sets `creationTime` at insert and `lastAccessed` on each read, so `lastAccessed` tracks active sessions more reliably than creation time (long-lived refresh cookies keep the same creationTime across many logins). `--profile <name>` overrides.
4. **SQLite access — WAL-safe snapshot.** Always copy `cookies.sqlite`, `cookies.sqlite-wal`, and `cookies.sqlite-shm` together to `os.tmpdir()`, then open the copy read-only. Copying only the main file risks a stale snapshot when Firefox has uncommitted WAL pages. Do **not** use SQLite's `immutable=1` URI flag — SQLite docs warn it can return incorrect results when the file is concurrently written by another process (Firefox), so it's unsafe here. If `-wal` / `-shm` are absent on disk, the copy is still valid (WAL may have been checkpointed). Clean up the temp copy in a `finally`.
5. **Clean break.** Remove Puppeteer entirely. No feature flag, no dual code path.

### Cookie query

```sql
SELECT name, value, host, expiry, creationTime, lastAccessed
FROM moz_cookies
WHERE host LIKE '%jh.edu'
```

Post-verification (see Pre-Implementation Verification), pin the host match to the exact set of hosts HopGPT uses. `host LIKE '%jh.edu'` is the safe starting filter because Firefox stores dot-prefixed forms for domain cookies (e.g. `.jh.edu`, `.ai.jh.edu`) alongside host-only forms (`chat.ai.jh.edu`), and an exact-host list could miss either variant.

Map relevant names into the credentials shape (names to be confirmed by verification step below):

| `moz_cookies.name` | Destination |
|---|---|
| `refreshToken` *(to verify)* | `credentials.cookies.refreshToken` |
| `cf_clearance` | `credentials.cookies.cf_clearance` |
| `connect.sid` | `credentials.cookies.connect_sid` |
| `__cf_bm` | `credentials.cookies.__cf_bm` |
| `token_provider` | `credentials.cookies.token_provider` (default `librechat`) |

### Pre-Implementation Verification

Two assumptions in this spec are inherited from the current Puppeteer extractor and have never been independently confirmed against a live Firefox profile. Both must be verified before implementation begins — they determine the cookie-name mapping and the profile-picker timestamp field.

Run against the user's real Firefox profile:

```sh
# 1. List all jh.edu cookies by name, host, and timestamps
sqlite3 "$HOME/Library/Application Support/Firefox/Profiles/<profile>/cookies.sqlite" \
  "SELECT host, name, expiry, creationTime, lastAccessed FROM moz_cookies WHERE host LIKE '%jh.edu' ORDER BY host, name;"

# 2. (Only if step 1 returns nothing while Firefox is open) close Firefox and retry,
#    or copy the full WAL set and re-query the copy.
```

Expected confirmations:

- The refresh-token cookie name (`refreshToken` or something else — update the mapping table).
- Which host rows exist (host-only, dot-prefixed, or both).
- Whether `lastAccessed` advances on active sessions (compare two captures a few minutes apart after browsing HopGPT).

If verification reveals a different cookie name or host layout, update the cookie query and mapping table inline here, then proceed to writing-plans.

## UX

### Happy path

```
$ npm run extract

=== HopGPT Credential Extraction (Firefox) ===

Scanning Firefox profiles at ~/Library/Application Support/Firefox/Profiles...
Found HopGPT session in profile: xyz123.default-release (last used 2 minutes ago)

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
| Snapshot copy fails (permissions / IO) | `Could not read Firefox cookies.sqlite (and/or -wal, -shm). Close Firefox and retry, or check directory permissions.` |
| Refresh token present, Cloudflare cookies missing | Warn, still write `.env` (refresh token alone enables auto-refresh). |
| `--profile <name>` specified but not found | `Profile "<name>" not found under ~/Library/Application Support/Firefox/Profiles. Available: <list>` |

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

- `findFirefoxProfilesDir` returns correct darwin path; throws when missing.
- `listProfiles` handles a temp profiles dir with two fake profile folders.
- `snapshotCookieDb` copies `cookies.sqlite` + `-wal` + `-shm` when all three exist, and handles the case where only `cookies.sqlite` exists (no WAL on disk).
- `readHopGPTCookies` extracts expected names from a fixture `cookies.sqlite` built in a temp dir with seeded `moz_cookies` rows. Fixture seeds both dot-prefixed and host-only rows to confirm `host LIKE '%jh.edu'` catches both.
- `pickProfile` returns the profile with the newest `refreshToken.lastAccessed` given three candidates.
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
