# HoProxy

**Anthropic-compatible API proxy for HopGPT (`https://chat.ai.jh.edu`).**

Point any Anthropic SDK client — Claude Code, OpenCode, the Python/JS SDKs — at a local endpoint that speaks the Messages API, and HoProxy translates requests to HopGPT under the hood.

## Quick Start

Requires **Node.js 18+**.

```bash
npm install
npm run extract   # opens a browser for one-time HopGPT login
npm start
```

The proxy listens on `http://localhost:3001`. If extraction completes without errors, you're done — jump to **[Client Setup](#client-setup)**.

> **Manual credential setup.** If `npm run extract` can't drive a browser on your machine, see [Appendix A: Manual credential setup](#appendix-a-manual-credential-setup).

## Client Setup

### Claude Code

Install Claude Code (`curl -fsSL https://claude.ai/install.sh | bash` or `npm i -g @anthropic-ai/claude-code`), then point it at HoProxy via `~/.claude/settings.json`:

```json
{
  "env": {
    "ANTHROPIC_AUTH_TOKEN": "test",
    "ANTHROPIC_BASE_URL": "http://localhost:3001",
    "ANTHROPIC_MODEL": "claude-sonnet-4-5"
  }
}
```

Restart Claude Code. HoProxy ignores the auth token, but Claude Code requires a non-empty value. Equivalent shell env vars (`ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, `ANTHROPIC_MODEL`) work as well.

### OpenCode

Point OpenCode at `http://localhost:3001` as an Anthropic-compatible provider. HoProxy handles OpenCode's tool-use flow out of the box — it injects tool definitions into the prompt, parses the model's XML tool calls, and returns standard Anthropic `tool_use` blocks. If your client parses XML tool calls directly from the text stream instead, see [Appendix B: MCP passthrough mode](#appendix-b-mcp-passthrough-mode).

### Anthropic SDK

Python:

```python
from anthropic import Anthropic

client = Anthropic(api_key="dummy", base_url="http://localhost:3001")
msg = client.messages.create(
    model="claude-sonnet-4-5",
    max_tokens=1024,
    messages=[{"role": "user", "content": "Hello!"}],
)
print(msg.content)
```

JavaScript:

```javascript
import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({ apiKey: 'dummy', baseURL: 'http://localhost:3001' });
const msg = await client.messages.create({
  model: 'claude-sonnet-4-5',
  max_tokens: 1024,
  messages: [{ role: 'user', content: 'Hello!' }],
});
console.log(msg.content);
```

curl (streaming):

```bash
curl http://localhost:3001/v1/messages \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4-5",
    "max_tokens": 1024,
    "stream": true,
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

## Models

| Canonical ID          | Use case                                            |
| --------------------- | --------------------------------------------------- |
| `claude-opus-4-5`     | Highest quality; complex reasoning, long-form work. |
| `claude-sonnet-4-5`   | Balanced speed/quality; good default.               |
| `claude-haiku-4-5`    | Fastest; low-latency tasks.                         |

The proxy also accepts dotted variants (`claude-sonnet-4.5`) and `-thinking` suffixes (`claude-sonnet-4-5-thinking`). The `-thinking` form never appears in canonical responses — thinking mode is enabled internally based on the model.

When thinking is enabled, HoProxy floors the request's `max_tokens` at 8192 before forwarding to HopGPT. HopGPT's Bedrock backend rejects requests where `max_tokens <= thinking.budget_tokens`; bumping the floor keeps the request valid regardless of the caller's budget.

## API

| Endpoint                      | Method | Purpose                                            |
| ----------------------------- | ------ | -------------------------------------------------- |
| `/v1/messages`                | POST   | Anthropic Messages API (streaming + non-streaming) |
| `/v1/messages/count_tokens`   | POST   | Token counting — returns 501 Not Implemented       |
| `/v1/models`                  | GET    | List available models                              |
| `/v1/models/:id`              | GET    | Fetch one model                                    |
| `/refresh-token`              | POST   | Force a HopGPT token refresh                       |
| `/token-status`               | GET    | Token expiry summary                               |
| `/token-debug`                | GET    | Detailed token diagnostics (memory vs `.env`)      |
| `/health`                     | GET    | Health check                                       |

## Configuration

### Environment variables

| Variable                                    | Default     | Description                                                                                                         |
| ------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------- |
| `PORT`                                      | `3001`      | Server port.                                                                                                        |
| `HOPGPT_COOKIE_OPENID_USER_ID`              | —           | **Required.** OIDC-issued refresh JWT (the `openid_user_id` browser cookie). Used to mint bearer tokens.            |
| `HOPGPT_BEARER_TOKEN`                       | —           | JWT bearer; auto-minted from `openid_user_id` if missing.                                                            |
| `HOPGPT_COOKIE_CONNECT_SID`                 | —           | Express session cookie; rotated on every token refresh.                                                              |
| `HOPGPT_COOKIE_CF_CLEARANCE`                | —           | Cloudflare clearance cookie.                                                                                         |
| `HOPGPT_COOKIE_CF_BM`                       | —           | Cloudflare bot management cookie.                                                                                    |
| `HOPGPT_COOKIE_TOKEN_PROVIDER`              | `librechat` | Token provider; HopGPT production uses `openid`.                                                                     |
| `HOPGPT_USER_AGENT`                         | —           | Browser `User-Agent`. Helps satisfy Cloudflare.                                                                      |
| `HOPGPT_STREAMING_TRANSPORT`                | `fetch`     | `fetch` or `tls`. Switch to `tls` if Cloudflare blocks streaming on native fetch.                                    |
| `CONVERSATION_TTL_MS`                       | `21600000`  | In-memory conversation TTL (ms); default 6h.                                                                         |
| `SIGNATURE_CACHE_TTL_MS`                    | `3600000`   | Tool-signature cache TTL (ms); default 1h.                                                                           |
| `HOPGPT_TOOL_CALL_BUFFER_SIZE`              | `1000000`   | Max buffer for streaming tool-call detection (bytes).                                                                |
| `HOPGPT_TOOL_CALL_BUFFER_WARN_THRESHOLD`    | `50000`     | Buffer size that triggers warning logs (bytes).                                                                      |
| `HOPGPT_TOOL_CALL_BUFFER_WARN_STEP`         | `200000`    | Increment between subsequent buffer warnings (bytes).                                                                |
| `HOPGPT_DEBUG`                              | unset       | Extra debug logging.                                                                                                 |
| `HOPGPT_LOG_LEVEL`                          | `info`      | `debug` \| `info` \| `warn` \| `error` \| `silent`.                                                                 |
| `HOPGPT_LOG_NO_COLOR` / `NO_COLOR`          | unset       | Disable ANSI color in logs.                                                                                          |

Extraction-only: `HOPGPT_PUPPETEER_CHANNEL`, `HOPGPT_PUPPETEER_USER_DATA_DIR`.

With auto-refresh on, the only variable you *must* set is `HOPGPT_COOKIE_OPENID_USER_ID`. Everything else is populated on first request.

### Authentication

HoProxy handles two refresh scopes:

- **Bearer token** (~75 min lifespan). Auto-refreshed on 401/403 by calling HopGPT's `/api/auth/refresh` with the `openid_user_id` cookie.
- **`openid_user_id`** (~7-day lifespan). When this expires, run `npm run extract` to re-authenticate.

The `connect.sid` session cookie is rotated server-side on every refresh and tracked alongside the credential; Cloudflare cookies are best-effort and may need re-extraction on blocks.

### Conversation state

HoProxy keeps HopGPT conversation threading in memory so multi-turn calls reuse context:

- Pass a stable session key via the `X-Session-Id` request header or any of `metadata.{session_id,sessionId,conversation_id,conversationId}`.
- Omit it and the proxy generates one, echoed back as `X-Session-Id` on the response.
- Reset a conversation with `X-Conversation-Reset: true` or `metadata.{conversation_reset,reset,new_conversation}`.

State expires after `CONVERSATION_TTL_MS` (6h default).

## Troubleshooting

| Symptom                                         | Fix                                                                                                                   |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Connection refused                              | Proxy isn't running. `npm start`.                                                                                      |
| `authentication_error` from HoProxy             | Re-run `npm run extract`, then restart the server.                                                                     |
| 401/403 from HopGPT                             | `openid_user_id` JWT expired (~7-day lifespan). Re-run `npm run extract`.                                              |
| Cloudflare "Attention Required" page            | CF cookies or UA stale. Re-run `npm run extract` and restart.                                                          |
| Streaming output arrives all at once            | Try `HOPGPT_STREAMING_TRANSPORT=tls` if Cloudflare is blocking native fetch.                                            |
| Model warning / not found                       | Use a canonical model from the table above, or hit `GET /v1/models`.                                                   |
| Claude Code still calls `api.anthropic.com`     | `ANTHROPIC_BASE_URL` isn't being read. Double-check `~/.claude/settings.json` and restart Claude Code.                 |
| Tool-call XML rendered as text                  | Passthrough mode is on. See [Appendix B](#appendix-b-mcp-passthrough-mode) — the default (off) converts XML to `tool_use`. |

Need deeper insight? `HOPGPT_DEBUG=true npm start` logs incoming HopGPT events, detected tool-call XML, and parsed tool calls. `GET /token-debug` compares in-memory auth state against `.env`.

## Streaming protocol

HopGPT uses a two-phase chat protocol. HoProxy POSTs `/api/agents/chat/AnthropicClaude` to get a `{streamId, conversationId, status:"started"}` ack, then GETs `/api/agents/chat/stream/{streamId}` for the SSE event stream. Retry policy splits by phase: POST 401/403/429 fully re-runs the sequence; GET 401/403/429 retries the subscription only (reusing the same `streamId`) to avoid duplicating the user's persisted message on HopGPT's server. No user-visible configuration changes.

## Testing

```bash
npm test            # run once
npm run test:watch  # watch mode
```

## Project Structure

```
src/
├── index.js                    # Express entry, route mounting, health
├── extract-credentials.js      # Puppeteer credential extraction (npm run extract)
├── errors/authErrors.js        # Auth error classes
├── routes/
│   ├── messages.js             # /v1/messages (+ count_tokens)
│   ├── models.js               # /v1/models
│   └── refreshToken.js         # /refresh-token, /token-status, /token-debug
├── transformers/
│   ├── anthropicToHopGPT.js    # Request translation
│   ├── hopGPTToAnthropic.js    # SSE response translation
│   ├── signatureCache.js       # Tool signature cache
│   └── thinkingUtils.js        # Thinking-block helpers
├── services/
│   ├── browserCredentials.js   # Browser credential helpers
│   ├── conversationStore.js    # In-memory session store
│   ├── hopgptClient.js         # HopGPT API client
│   └── tlsClient.js            # TLS-fingerprinted requests
└── utils/
    ├── logger.js               # Logging
    ├── modelMapping.js         # Model alias resolution
    └── sseParser.js            # SSE parsing
```

## License

MIT

---

## Appendix A: Manual credential setup

If Puppeteer can't drive a browser on your host, grab the values yourself:

1. Open `https://chat.ai.jh.edu` and log in.
2. DevTools (F12) → Network → send any message.
3. Inspect the request to `/api/agents/chat/AnthropicClaude` and copy:

```bash
# .env — minimum
HOPGPT_COOKIE_OPENID_USER_ID=eyJhbGciOiJIUzI1NiIs...

# recommended (otherwise auto-populated on first request)
HOPGPT_BEARER_TOKEN=eyJhbGciOiJIUzI1NiIs...
HOPGPT_COOKIE_CONNECT_SID=s%3A...
HOPGPT_COOKIE_CF_CLEARANCE=...
HOPGPT_COOKIE_CF_BM=...
HOPGPT_COOKIE_TOKEN_PROVIDER=openid
HOPGPT_USER_AGENT="Mozilla/5.0 ..."
```

## Appendix B: MCP passthrough mode

Default behavior: HoProxy parses the model's tool-call XML (MCP, `function_calls`, `antml:function_calls`, or `tool_call` JSON wrappers) and emits Anthropic `tool_use` blocks. This is what Claude Code, OpenCode, and the Anthropic SDKs expect.

Passthrough leaves the raw XML in the response text so your client can parse it directly. Enable per-request:

```bash
# HTTP header
curl -H "x-mcp-passthrough: true" ...

# or metadata
{ "metadata": { "mcp_passthrough": true }, "messages": [...] }
```

Supported tool-call XML formats (auto-detected in default mode):

<details>
<summary>Show XML format examples</summary>

**MCP tool call:**

```xml
<mcp_tool_call>
<server_name>opencode</server_name>
<tool_name>Edit</tool_name>
<arguments>{"file_path": "example.ts", "new_string": "..."}</arguments>
</mcp_tool_call>
```

**OpenCode `function_calls`:**

```xml
<function_calls>
<invoke name="Glob">
<parameter name="pattern">**/*.ts</parameter>
</invoke>
</function_calls>
```

**Claude Code `antml:function_calls`:** same shape, `antml:` prefix on `function_calls` / `invoke` / `parameter`.

**Tool-call JSON wrapper:**

```xml
<tool_call>
{"name": "Task", "parameters": {"task": "Explore the codebase", "agent": "explorer"}}
</tool_call>
```

</details>
