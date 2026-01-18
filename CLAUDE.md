# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

HoProxy is a Node.js/Express proxy that exposes Anthropic-compatible API endpoints and translates them to the HopGPT backend at `https://chat.ai.jh.edu`. It enables Claude Code and other Anthropic SDK clients to use HopGPT models.

Key capabilities:
- Anthropic Messages API compatibility (`/v1/messages`)
- Tool use support (converts XML tool calls from model output to Anthropic `tool_use` blocks)
- Extended thinking support for thinking models
- Automatic token refresh (extends sessions from ~15 min to ~7 days)
- TLS fingerprinting to bypass Cloudflare protection

## Build, Test, and Development Commands

```bash
npm install              # Install dependencies
npm start                # Start server (port 3001 by default)
npm run dev              # Start with auto-reload (--watch)
npm run extract          # Extract browser credentials to .env

npm test                 # Run all tests once (Vitest)
npm run test:watch       # Run tests in watch mode
npx vitest test/routes/messages.test.js  # Run a specific test file
```

## Architecture

```
Anthropic SDK Client
        │
        ▼
┌─────────────────────────────────────────┐
│  Routes (src/routes/)                   │
│  • messages.js - /v1/messages           │
│  • models.js - /v1/models, /v1/models/:id │
│  • refreshToken.js - /refresh-token,   │
│    /token-status, /token-debug          │
└─────────────────┬───────────────────────┘
                  ▼
┌─────────────────────────────────────────┐
│  Transformers (src/transformers/)       │
│  • anthropicToHopGPT.js - Request xform │
│  • hopGPTToAnthropic.js - Response xform│
│  • thinkingUtils.js - Thinking blocks   │
│  • signatureCache.js - Signature cache  │
└─────────────────┬───────────────────────┘
                  ▼
┌─────────────────────────────────────────┐
│  Services (src/services/)               │
│  • hopgptClient.js - API client w/ auth │
│  • tlsClient.js - Cloudflare bypass     │
│  • conversationStore.js - Session state │
│  • browserCredentials.js - Puppeteer    │
└─────────────────┬───────────────────────┘
                  ▼
┌─────────────────────────────────────────┐
│  Utils (src/utils/)                     │
│  • logger.js - Structured logging       │
│  • modelMapping.js - Model name aliases │
│  • sseParser.js - SSE stream parsing    │
├─────────────────────────────────────────┤
│  Errors (src/errors/)                   │
│  • authErrors.js - Auth error classes   │
└─────────────────┬───────────────────────┘
                  ▼
         HopGPT Backend
```

**Data flow**: Anthropic request → `anthropicToHopGPT.js` (injects tools into prompt) → HopGPT API → SSE stream → `hopGPTToAnthropic.js` (parses XML tool calls, handles thinking blocks) → Anthropic response

## Key Technical Details

**Tool Injection**: HopGPT doesn't natively support Anthropic tools, so `anthropicToHopGPT.js` injects tool definitions into the prompt. The model outputs tool calls as XML, which `hopGPTToAnthropic.js` parses and converts to Anthropic `tool_use` blocks.

**Supported XML formats** (all converted to `tool_use` blocks):
- `<mcp_tool_call>` - MCP format
- `<function_calls><invoke name="...">` - Claude Code / OpenCode format
- `<tool_call>{JSON}</tool_call>` - JSON format

**Session Management**: Uses `X-Session-Id` header (or `X-SessionID`) or `metadata.session_id`/`metadata.conversation_id` to maintain conversation threading via `parentMessageId`. Reset sessions with `X-Conversation-Reset: true` header or `metadata.conversation_reset`/`metadata.reset`/`metadata.new_conversation` set to `true`.

**MCP Passthrough**: Enable with `x-mcp-passthrough: true` header or `metadata.mcp_passthrough: true` to keep tool call XML in the text response instead of converting to `tool_use` blocks. Use for clients that parse XML directly.

**Model Aliases**: Flexible naming via `modelMapping.js`. Supports opus-4.5, sonnet-4.5, and haiku-4.5 with automatic `-thinking` suffix handling and version variants (e.g., `claude-opus-4-5`, `claude-opus-4.5`, `claude-opus-4-5-thinking` all resolve correctly).

## Coding Style

- ES modules (`import`/`export`), Node.js 18+
- 2-space indentation with semicolons
- camelCase for functions/variables
- Concise module names (`hopgptClient.js`, not `HopGPTClientService.js`)
- Route handlers in `src/routes/`, shared logic in `src/services/` or `src/utils/`

## Testing

- Tests use Vitest + Supertest, mirroring source structure under `test/`
- Fixtures in `test/fixtures/`, helpers in `test/helpers/`
- Name test files `*.test.js`

## Environment Variables

Minimum required: `HOPGPT_COOKIE_REFRESH_TOKEN`

**Core settings:**
- `PORT` - Server port (default: 3001)
- `HOPGPT_BEARER_TOKEN` - JWT token (auto-refreshed if refresh token is set)
- `HOPGPT_USER_AGENT` - Browser User-Agent for Cloudflare

**Authentication cookies:**
- `HOPGPT_COOKIE_REFRESH_TOKEN` - Required for token refresh
- `HOPGPT_COOKIE_CF_CLEARANCE` - Cloudflare clearance cookie
- `HOPGPT_COOKIE_CONNECT_SID` - Connect session ID
- `HOPGPT_COOKIE_CF_BM` - Cloudflare bot management cookie
- `HOPGPT_COOKIE_TOKEN_PROVIDER` - Token provider (default: librechat)

**Logging:**
- `HOPGPT_DEBUG` - Enable debug logging (true/false)
- `HOPGPT_LOG_LEVEL` - Log level (debug/info/warn/error/silent)
- `HOPGPT_LOG_NO_COLOR` or `NO_COLOR` - Disable colored log output

**Caching/TTL:**
- `CONVERSATION_TTL_MS` - Session state TTL (default: 6 hours)
- `SIGNATURE_CACHE_TTL_MS` - Signature cache TTL

**Browser automation (Puppeteer):**
- `HOPGPT_PUPPETEER_USER_DATA_DIR` - Chrome user data directory
- `HOPGPT_PUPPETEER_CHANNEL` - Browser channel (default: chrome)

**Transport:**
- `HOPGPT_STREAMING_TRANSPORT` - Streaming transport mode
