# HopGPT Anthropic API Proxy

A Node.js/Express proxy server that exposes Anthropic-compatible API endpoints and translates requests to the HopGPT backend at `https://chat.ai.jh.edu`. Use it to connect Claude Code, OpenCode, or any Anthropic SDK client to HopGPT.

## Table of Contents

- [Quick Start](#quick-start)
- [Client Setup](#client-setup)
  - [Claude Code](#claude-code)
  - [OpenCode](#opencode)
  - [Anthropic SDK](#anthropic-sdk)
- [Available Models](#available-models)
- [API Reference](#api-reference)
- [Configuration](#configuration)
  - [Environment Variables](#environment-variables)
  - [Conversation State](#conversation-state)
  - [Authentication](#authentication)
- [Tool Use Support](#tool-use-support)
- [Troubleshooting](#troubleshooting)
- [Project Structure](#project-structure)
- [Testing](#testing)
- [License](#license)

---

## Quick Start

**Requirements:** Node.js 18+

```bash
# 1. Install dependencies
npm install

# 2. Extract credentials (opens browser for login)
npm run extract

# 3. Start the proxy
npm start
```

The proxy listens on `http://localhost:3001` by default.

### Manual Credential Setup

If automatic extraction fails, create a `.env` file manually:

1. Open HopGPT (`https://chat.ai.jh.edu`) in your browser
2. DevTools (F12) → Network tab → send a message
3. Inspect the request to `/api/agents/chat/AnthropicClaude`
4. Copy values from headers/cookies:

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

---

## Claude Code Setup

Configure Claude Code to talk to HoProxy's local Anthropic-compatible endpoint.

### 1) Install Claude Code

**macOS/Linux (recommended):**
```bash
curl -fsSL https://claude.ai/install.sh | bash
```

**npm (requires Node.js 18+):**
```bash
npm install -g @anthropic-ai/claude-code
```

### 2) Extract HopGPT credentials

If you have not already done this in the main setup, run:
```bash
npm run extract
```

### 3) Configure Claude Code `settings.json`

Create or edit `~/.claude/settings.json`:
```json
{
  "env": {
    "ANTHROPIC_AUTH_TOKEN": "test",
    "ANTHROPIC_BASE_URL": "http://localhost:3001",
    "ANTHROPIC_MODEL": "claude-sonnet-4-5"
  }
}
```

Restart Claude Code after editing. HoProxy does not validate the auth token, but Claude Code requires a non-empty value.

### 4) Environment variable configuration

If you prefer shell environment variables instead of `settings.json`:
```bash
export ANTHROPIC_AUTH_TOKEN=test
export ANTHROPIC_BASE_URL=http://localhost:3001
export ANTHROPIC_MODEL=claude-sonnet-4-5
```

### 5) Troubleshooting common issues

- **Connection refused**: Ensure HoProxy is running and listening on `http://localhost:3001`.
- **`authentication_error` from HoProxy**: Your HopGPT cookies/tokens are missing or expired. Re-run `npm run extract` and restart the server.
- **401/403 from HopGPT**: The refresh token likely expired; re-authenticate and re-extract credentials.
- **Cloudflare "Attention Required" page**: Your Cloudflare cookies or user agent are missing/expired. Re-run `npm run extract` and restart the server.
- **Streaming output arrives all at once**: Ensure `HOPGPT_STREAMING_TRANSPORT=fetch` (default). If Cloudflare blocks streaming with native fetch, set `HOPGPT_STREAMING_TRANSPORT=tls` to fall back to non-streaming TLS.
- **Model warning or not found**: Use a supported model from the list below or call `GET /v1/models`.
- **Claude Code still calling Anthropic**: Confirm `ANTHROPIC_BASE_URL` is set and restart Claude Code.

### 6) Available models and their capabilities

| Model (canonical) | Capability notes |
|-------------------|------------------|
| `claude-opus-4-5` | Highest quality; best for complex reasoning and long-form outputs. |
| `claude-sonnet-4-5` | Balanced speed/quality; good default for most tasks. |
| `claude-haiku-4-5` | Fastest model; best for low-latency tasks. |

Aliases accepted by the proxy include:
- `claude-opus-4.5`, `claude-opus-4-5-thinking`, `claude-opus-4.5-thinking`
- `claude-sonnet-4.5`, `claude-sonnet-4-5-thinking`, `claude-sonnet-4.5-thinking`
- `claude-haiku-4.5`, `claude-haiku-4-5-thinking`, `claude-haiku-4.5-thinking`

**Note:** The `-thinking` suffix is accepted for input but not included in canonical model names returned by `/v1/models`. The proxy enables thinking mode internally based on model capabilities.

## OpenCode Setup

OpenCode supports the Anthropic tool use protocol. HoProxy handles the full tool use flow:

1. **Tool Injection**: When tools are sent in the Anthropic request, HoProxy injects tool definitions into the prompt so the model knows how to call them
2. **XML Parsing**: When the model outputs XML-formatted tool calls (e.g., `<tool_call>`), HoProxy parses them and converts to standard Anthropic `tool_use` blocks
3. **Result Handling**: OpenCode executes the tools and sends `tool_result` messages back

### How Tool Injection Works

Since HopGPT doesn't natively pass Anthropic tools to the Claude model, HoProxy injects a tool prompt that:
- Describes all available tools and their parameters
- Instructs the model to output tool calls in `<tool_call>` XML format
- The XML is then parsed and converted to Anthropic `tool_use` blocks

### Supported Tool Call Formats

HoProxy supports four XML formats for tool calls in model responses:

**1. MCP Tool Call Format:**
```xml
<mcp_tool_call>
<server_name>opencode</server_name>
<tool_name>Edit</tool_name>
<arguments>
{"file_path": "example.ts", "new_string": "..."}
</arguments>
</mcp_tool_call>
```

**2. Function Calls Format (OpenCode):**
```xml
<function_calls>
<invoke name="Glob">
<parameter name="pattern">**/*.ts</parameter>
</invoke>
<invoke name="Read">
<parameter name="file_path">README.md</parameter>
</invoke>
</function_calls>
```

**3. Claude Code Function Calls Format (antml: namespace):**
```xml
<function_calls>
<invoke name="Bash">
<parameter name="command">git status</parameter>
</invoke>
<invoke name="Read">
<parameter name="file_path">README.md</parameter>
</invoke>
</function_calls>
```

**4. Tool Call JSON Format (OpenCode):**
```xml
<tool_call>
{"name": "Task", "parameters": {"task": "Explore the codebase", "agent": "explorer"}}
</tool_call>
```

All formats are automatically parsed and converted to Anthropic `tool_use` blocks, which are then returned to the client for execution.

### MCP Tool Call Passthrough

If your client (like OpenCode) parses and executes tool calls directly from XML blocks in the text stream instead of using Anthropic `tool_use` blocks, enable passthrough mode:

**Option A: HTTP Header**
```bash
curl http://localhost:3001/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-mcp-passthrough: true" \
  -d '{ ... }'
```

**Option B: Request metadata**
```json
{
  "model": "claude-sonnet-4-5-thinking",
  "metadata": {
    "mcp_passthrough": true
  },
  "messages": [...]
}
```

When passthrough mode is enabled:
- Tool call XML blocks remain in the text response for the client to parse
- No `tool_use` blocks are generated from the XML
- The client can intercept and execute the tool calls directly

### Troubleshooting Tool Calls

If tool calls aren't working (XML is displayed instead of executed):

1. **Verify passthrough mode is disabled** - Passthrough mode should only be used for clients that parse XML directly. Most clients (including OpenCode) should use the default mode where XML is converted to `tool_use` blocks.

2. **Enable debug logging** to see what's happening:
   ```bash
   HOPGPT_DEBUG=true npm start
   ```
   This will log:
   - Incoming HopGPT events
   - Detected tool call XML
   - Parsed tool calls

3. **Test the proxy directly** with curl:
   ```bash
   curl http://localhost:3001/v1/messages \
     -H "Content-Type: application/json" \
     -d '{
       "model": "claude-sonnet-4-5-thinking",
       "max_tokens": 1024,
       "messages": [{"role": "user", "content": "What is 2+2?"}]
     }'
   ```
   Check that the response contains `tool_use` blocks (not raw XML).

4. **Verify your client is handling tool_use blocks** - The proxy outputs standard Anthropic `tool_use` blocks. Your client must execute them and send `tool_result` messages to continue the agentic loop.

## Usage

### With Anthropic SDK (Python)

```python
from anthropic import Anthropic

client = Anthropic(
    api_key="dummy",  # Not used, but required by the SDK
    base_url="http://localhost:3001"  # Or set ANTHROPIC_BASE_URL
)

message = client.messages.create(
    model="claude-sonnet-4-5",
    max_tokens=1024,
    messages=[{"role": "user", "content": "Hello!"}]
)
print(message.content)
```

### With Anthropic SDK (JavaScript)

```javascript
import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({
  apiKey: process.env['ANTHROPIC_API_KEY'] || 'dummy',
  baseURL: 'http://localhost:3001'
});

const message = await client.messages.create({
  model: 'claude-sonnet-4-5',
  max_tokens: 1024,
  messages: [{ role: 'user', content: 'Hello!' }]
});

console.log(message.content);
```

If your SDK version does not support `baseURL`, use the `curl` example below instead.

### With curl

```bash
curl http://localhost:3001/v1/messages \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4-5",
    "max_tokens": 1024,
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

### Streaming

```bash
curl http://localhost:3001/v1/messages \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4-5-thinking",
    "max_tokens": 1024,
    "stream": true,
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

### List available models

```bash
curl http://localhost:3001/v1/models
```

### Manually refresh the HopGPT token

```bash
curl -X POST http://localhost:3001/refresh-token
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `PORT` | Server port (default: 3001) |
| `HOPGPT_BEARER_TOKEN` | JWT Bearer token from Authorization header (optional if refresh token is set) |
| `HOPGPT_USER_AGENT` | Browser User-Agent header (recommended to satisfy Cloudflare) |
| `HOPGPT_COOKIE_CF_CLEARANCE` | Cloudflare clearance cookie |
| `HOPGPT_COOKIE_CONNECT_SID` | Session ID cookie |
| `HOPGPT_COOKIE_CF_BM` | Cloudflare bot management cookie |
| `HOPGPT_COOKIE_REFRESH_TOKEN` | Refresh token cookie (required for auto-refresh) |
| `HOPGPT_COOKIE_TOKEN_PROVIDER` | Token provider (default: `librechat`) |
| `CONVERSATION_TTL_MS` | In-memory conversation state TTL in ms (default: 21600000) |
| `HOPGPT_DEBUG` | Enable debug logging for troubleshooting (default: unset) |
| `HOPGPT_LOG_LEVEL` | Log level: `debug`, `info`, `warn`, `error`, `silent` (default: `info`) |
| `HOPGPT_LOG_NO_COLOR` | Disable colored log output (default: unset) |
| `NO_COLOR` | Standard env var to disable colored output (default: unset) |
| `HOPGPT_STREAMING_TRANSPORT` | Streaming transport: `fetch` or `tls` (default: `fetch`) |
| `SIGNATURE_CACHE_TTL_MS` | Tool signature cache TTL in ms (default: 3600000) |
| `HOPGPT_TOOL_CALL_BUFFER_SIZE` | Max buffer size for streaming tool call detection (default: 1000000) |
| `HOPGPT_TOOL_CALL_BUFFER_WARN_THRESHOLD` | Buffer size that triggers warning logs (default: 50000) |
| `HOPGPT_TOOL_CALL_BUFFER_WARN_STEP` | Increment for subsequent buffer warnings (default: 200000) |

Extraction-only:
- `HOPGPT_PUPPETEER_CHANNEL`
- `HOPGPT_PUPPETEER_USER_DATA_DIR`

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/v1/messages` | POST | Anthropic Messages API (streaming and non-streaming) |
| `/v1/messages/count_tokens` | POST | Token counting (returns 501 Not Implemented) |
| `/v1/models` | GET | List available models |
| `/v1/models/:model_id` | GET | Fetch a specific model |
| `/refresh-token` | POST | Refresh HopGPT bearer token using refresh cookie |
| `/token-status` | GET | Check token expiry status and time remaining |
| `/token-debug` | GET | Detailed token diagnostics (compares memory vs .env) |
| `/health` | GET | Health check |

## Conversation State

The proxy tracks HopGPT conversation threading in-memory so multi-turn requests can reuse context and cache keys.

- Provide a stable session key via `X-Session-Id` (or `X-SessionID`) or `metadata.session_id`, `metadata.sessionId`, `metadata.conversation_id`, or `metadata.conversationId`.
- If missing, the proxy generates a session ID and returns it in the `X-Session-Id` response header.
- Reset the session with `X-Conversation-Reset: true` or `metadata.conversation_reset`, `metadata.reset`, or `metadata.new_conversation` set to `true`.

Conversation state is stored in-memory and expires after `CONVERSATION_TTL_MS` (default 6 hours).

## Authentication Notes

### Automatic Token Refresh

When a request fails with a 401/403 authentication error, the proxy will:

1. Call the HopGPT refresh endpoint (`/api/auth/refresh`)
2. Obtain a new bearer token using the refresh token cookie
3. Retry the original request with the new token

This extends the effective session from ~15 minutes (bearer token lifespan) to ~7 days (refresh token lifespan).

### Token Lifespans

| Token | Lifespan | Notes |
|-------|----------|-------|
| Bearer Token | ~15 minutes | Automatically refreshed when expired |
| Refresh Token | ~7 days | Requires manual re-authentication when expired |
| Cloudflare cookies | Variable | May need to be refreshed if you encounter issues |

### Minimal Configuration

With auto-refresh enabled, you only need to provide the **refresh token**. The bearer token will be obtained automatically on the first request:

```bash
# Minimal .env configuration
HOPGPT_COOKIE_REFRESH_TOKEN=eyJhbGciOiJIUzI1NiIs...
```

## Project Structure

```
src/
├── index.js                    # Express server entry point, route mounting, health endpoint
├── extract-credentials.js      # Puppeteer credential extraction script (npm run extract)
├── errors/
│   └── authErrors.js           # Authentication error classes
├── routes/
│   ├── messages.js             # /v1/messages and /v1/messages/count_tokens endpoints
│   ├── models.js               # /v1/models endpoints
│   └── refreshToken.js         # /refresh-token and /token-status endpoints
├── transformers/
│   ├── anthropicToHopGPT.js    # Request transformation
│   ├── hopGPTToAnthropic.js    # SSE response transformation
│   ├── signatureCache.js       # Tool signature caching
│   └── thinkingUtils.js        # Thinking block utilities
├── services/
│   ├── browserCredentials.js   # Browser credential helpers
│   ├── conversationStore.js    # In-memory session storage
│   ├── hopgptClient.js         # HopGPT API client
│   └── tlsClient.js            # TLS fingerprinted requests
└── utils/
    ├── logger.js               # Logging utility
    ├── modelMapping.js         # Model alias mapping
    └── sseParser.js            # SSE stream parsing
```

## Testing

```bash
npm test           # Run tests once
npm run test:watch # Run tests in watch mode
```

## License

MIT
