import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RefreshTokenExpiredError } from '../../src/errors/authErrors.js';
import messagesRouter from '../../src/routes/messages.js';
import * as hopgptClientModule from '../../src/services/hopgptClient.js';

function makeSSEResponse(body) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(body));
      controller.close();
    },
  });
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: {
      get: (k) => (k.toLowerCase() === 'content-type' ? 'text/event-stream' : null),
    },
    body: stream,
    text: async () => body,
    json: async () => {
      throw new Error('not json');
    },
  };
}

function makeHangingSSEResponse(body) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(body));
    },
  });
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: {
      get: (k) => (k.toLowerCase() === 'content-type' ? 'text/event-stream' : null),
    },
    body: stream,
    text: async () => body,
    json: async () => {
      throw new Error('not json');
    },
  };
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/v1', messagesRouter);
  return app;
}

describe('POST /v1/messages streaming — end-to-end', () => {
  let getDefaultClientSpy;
  let originalIdlePingDelay;
  let originalToolBatchIdleClose;
  beforeEach(() => {
    originalIdlePingDelay = process.env.HOPGPT_STREAM_IDLE_PING_DELAY_MS;
    originalToolBatchIdleClose = process.env.HOPGPT_TOOL_BATCH_IDLE_CLOSE_MS;
    getDefaultClientSpy = vi.spyOn(hopgptClientModule, 'getDefaultClient');
  });
  afterEach(() => {
    if (originalIdlePingDelay === undefined) {
      delete process.env.HOPGPT_STREAM_IDLE_PING_DELAY_MS;
    } else {
      process.env.HOPGPT_STREAM_IDLE_PING_DELAY_MS = originalIdlePingDelay;
    }
    if (originalToolBatchIdleClose === undefined) {
      delete process.env.HOPGPT_TOOL_BATCH_IDLE_CLOSE_MS;
    } else {
      process.env.HOPGPT_TOOL_BATCH_IDLE_CLOSE_MS = originalToolBatchIdleClose;
    }
    vi.restoreAllMocks();
  });

  it('streams Anthropic SSE from a HAR-shaped HopGPT SSE input', async () => {
    // Matches the event sequence in chat.ai.jh.edu_chat_message.har
    const harSSE =
      'event: message\ndata: {"created":true,"message":{"messageId":"m1","parentMessageId":"0","conversationId":"c1","sender":"User","text":"hi","isCreatedByUser":true,"tokenCount":5},"streamId":"c1"}\n\n' +
      'event: message\ndata: {"event":"on_run_step","data":{"stepIndex":0,"id":"step_1","type":"message_creation","index":0,"stepDetails":{"type":"message_creation","message_creation":{"message_id":"msg_1"}},"usage":null,"runId":"r1"}}\n\n' +
      'event: message\ndata: {"event":"on_message_delta","data":{"id":"step_1","delta":{"content":[{"type":"text","text":"Hi"}]}}}\n\n' +
      'event: message\ndata: {"event":"on_message_delta","data":{"id":"step_1","delta":{"content":[{"type":"text","text":" there"}]}}}\n\n' +
      'event: message\ndata: {"event":"on_message_delta","data":{"id":"step_1","delta":{"content":[{"type":"text","text":"! How can I help you today?"}]}}}\n\n' +
      'event: message\ndata: {"final":true,"conversation":{"conversationId":"c1"},"requestMessage":{"messageId":"m1","conversationId":"c1","sender":"User","text":"hi","isCreatedByUser":true,"tokenCount":5},"responseMessage":{"messageId":"r1","conversationId":"c1","parentMessageId":"m1","isCreatedByUser":false,"model":"claude-opus-4.5","sender":"Claude","promptTokens":8,"endpoint":"AnthropicClaude","text":"","content":[{"type":"text","text":"Hi there! How can I help you today?"}],"attachments":[]}}\n\n';

    getDefaultClientSpy.mockReturnValue({
      validateAuth: () => ({ valid: true, missing: [], warnings: [] }),
      sendMessage: async () => makeSSEResponse(harSSE),
    });

    const app = buildApp();
    const res = await request(app)
      .post('/v1/messages')
      .send({
        model: 'claude-opus-4-5',
        max_tokens: 128,
        stream: true,
        messages: [{ role: 'user', content: 'hi' }],
      });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/event-stream/);

    const body = res.text;
    expect(body).toMatch(/event: message_start/);
    expect(body).toMatch(/event: content_block_start/);
    expect(body).toMatch(/event: content_block_delta/);
    expect(body).toMatch(/event: message_stop/);

    // Assert the concatenation of all text_delta chunks equals the expected final text.
    const deltaTexts = [];
    const lines = body.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (lines[i] === 'event: content_block_delta' && lines[i + 1]?.startsWith('data: ')) {
        try {
          const data = JSON.parse(lines[i + 1].slice('data: '.length));
          if (data.delta?.type === 'text_delta') {
            deltaTexts.push(data.delta.text);
          }
        } catch {
          // ignore non-JSON data lines
        }
      }
    }
    expect(deltaTexts.join('')).toBe('Hi there! How can I help you today?');
  });

  it('sends message_start before upstream content so slow Opus streams are not idle', async () => {
    const harSSE =
      'event: message\ndata: {"created":true,"message":{"messageId":"m1","conversationId":"c1"}}\n\n' +
      'event: message\ndata: {"event":"on_message_delta","data":{"delta":{"content":[{"type":"text","text":"Hi"}]}}}\n\n' +
      'event: message\ndata: {"final":true,"conversation":{"conversationId":"c1"},"responseMessage":{"messageId":"r1","conversationId":"c1","content":[{"type":"text","text":"Hi"}]}}\n\n';

    process.env.HOPGPT_STREAM_IDLE_PING_DELAY_MS = '10';
    getDefaultClientSpy.mockReturnValue({
      validateAuth: () => ({ valid: true, missing: [], warnings: [] }),
      sendMessage: async () => {
        await new Promise((resolve) => setTimeout(resolve, 25));
        return makeSSEResponse(harSSE);
      },
    });

    const app = buildApp();
    const res = await request(app)
      .post('/v1/messages')
      .send({
        model: 'claude-opus-4-5',
        max_tokens: 128,
        stream: true,
        messages: [{ role: 'user', content: 'hi' }],
      });

    expect(res.status).toBe(200);
    const messageStartIndex = res.text.indexOf('event: message_start');
    const contentBlockStartIndex = res.text.indexOf('event: content_block_start');
    expect(messageStartIndex).toBeGreaterThanOrEqual(0);
    expect(contentBlockStartIndex).toBeGreaterThan(messageStartIndex);
  });

  it('streams indexless thinking-model tool calls as actionable tool_use blocks', async () => {
    const functionCalls = `<function_calls>
<invoke name="Read">
<parameter name="file_path">README.md</parameter>
</invoke>
<invoke name="Read">
<parameter name="file_path">package.json</parameter>
</invoke>
</function_calls>`;
    const harSSE =
      'event: message\ndata: {"created":true,"message":{"messageId":"m1","conversationId":"c1"}}\n\n' +
      `event: message\ndata: ${JSON.stringify({
        event: 'on_message_delta',
        data: {
          delta: {
            content: [
              {
                type: 'text',
                text: `Thinking: inspect the key files once.\n${functionCalls}`,
              },
            ],
          },
        },
      })}\n\n` +
      'event: message\ndata: {"final":true,"conversation":{"conversationId":"c1"},"responseMessage":{"messageId":"r1","conversationId":"c1","content":[]}}\n\n';

    getDefaultClientSpy.mockReturnValue({
      validateAuth: () => ({ valid: true, missing: [], warnings: [] }),
      sendMessage: async () => makeSSEResponse(harSSE),
    });

    const app = buildApp();
    const res = await request(app)
      .post('/v1/messages')
      .send({
        model: 'claude-opus-4-5',
        max_tokens: 128,
        stream: true,
        messages: [{ role: 'user', content: 'continue' }],
        tools: [
          {
            name: 'Read',
            input_schema: {
              type: 'object',
              properties: { file_path: { type: 'string' } },
              required: ['file_path'],
            },
          },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.text).toContain('"type":"tool_use"');
    expect(res.text).toContain('"name":"Read"');
    expect(res.text).toContain('\\"file_path\\":\\"README.md\\"');
    expect(res.text).toContain('\\"file_path\\":\\"package.json\\"');
    expect(res.text).toContain('"stop_reason":"tool_use"');
  });

  it('ends the client stream as soon as a tool batch is complete', async () => {
    const functionCalls = `<function_calls>
<invoke name="Read">
<parameter name="file_path">README.md</parameter>
</invoke>
</function_calls>`;
    const harSSE =
      'event: message\ndata: {"created":true,"message":{"messageId":"m1","conversationId":"c1"}}\n\n' +
      `event: message\ndata: ${JSON.stringify({
        event: 'on_message_delta',
        data: {
          delta: {
            content: [
              {
                type: 'text',
                text: `Let me inspect first.\n${functionCalls}\nI will keep talking after the tool.`,
              },
            ],
          },
        },
      })}\n\n` +
      `event: message\ndata: ${JSON.stringify({
        event: 'on_message_delta',
        data: {
          delta: {
            content: [{ type: 'text', text: 'This late text should not reach OpenCode.' }],
          },
        },
      })}\n\n` +
      'event: message\ndata: {"final":true,"conversation":{"conversationId":"c1"},"responseMessage":{"messageId":"r1","conversationId":"c1","content":[{"type":"text","text":"final text should not leak"}]}}\n\n';

    getDefaultClientSpy.mockReturnValue({
      validateAuth: () => ({ valid: true, missing: [], warnings: [] }),
      sendMessage: async () => makeSSEResponse(harSSE),
    });

    const app = buildApp();
    const res = await request(app)
      .post('/v1/messages')
      .send({
        model: 'claude-opus-4-5',
        max_tokens: 128,
        stream: true,
        messages: [{ role: 'user', content: 'inspect the repo' }],
        tools: [
          {
            name: 'Read',
            input_schema: {
              type: 'object',
              properties: { file_path: { type: 'string' } },
              required: ['file_path'],
            },
          },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.text).toContain('"type":"tool_use"');
    expect(res.text).toContain('"name":"Read"');
    expect(res.text).toContain('\\"file_path\\":\\"README.md\\"');
    expect(res.text).toContain('"stop_reason":"tool_use"');
    expect(res.text).not.toContain('Let me inspect first');
    expect(res.text).not.toContain('This late text should not reach OpenCode');
    expect(res.text).not.toContain('final text should not leak');
  });

  it('keeps reading split streaming tool batches until the next non-tool delta', async () => {
    const firstToolCall = `<tool_call>{"name":"Read","parameters":{"file_path":"README.md"}}</tool_call>`;
    const secondToolCall = `<tool_call>{"name":"Read","parameters":{"file_path":"package.json"}}</tool_call>`;
    const harSSE =
      'event: message\ndata: {"created":true,"message":{"messageId":"m1","conversationId":"c1"}}\n\n' +
      `event: message\ndata: ${JSON.stringify({
        event: 'on_message_delta',
        data: {
          delta: {
            content: [{ type: 'text', text: firstToolCall }],
          },
        },
      })}\n\n` +
      `event: message\ndata: ${JSON.stringify({
        event: 'on_message_delta',
        data: {
          delta: {
            content: [{ type: 'text', text: secondToolCall }],
          },
        },
      })}\n\n` +
      `event: message\ndata: ${JSON.stringify({
        event: 'on_message_delta',
        data: {
          delta: {
            content: [{ type: 'text', text: 'This post-tool prose should not reach OpenCode.' }],
          },
        },
      })}\n\n` +
      'event: message\ndata: {"final":true,"conversation":{"conversationId":"c1"},"responseMessage":{"messageId":"r1","conversationId":"c1","content":[{"type":"text","text":"final text should not leak"}]}}\n\n';

    getDefaultClientSpy.mockReturnValue({
      validateAuth: () => ({ valid: true, missing: [], warnings: [] }),
      sendMessage: async () => makeSSEResponse(harSSE),
    });

    const app = buildApp();
    const res = await request(app)
      .post('/v1/messages')
      .send({
        model: 'claude-opus-4-5',
        max_tokens: 128,
        stream: true,
        messages: [{ role: 'user', content: 'inspect the repo' }],
        tools: [
          {
            name: 'Read',
            input_schema: {
              type: 'object',
              properties: { file_path: { type: 'string' } },
              required: ['file_path'],
            },
          },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.text).toContain('\\"file_path\\":\\"README.md\\"');
    expect(res.text).toContain('\\"file_path\\":\\"package.json\\"');
    expect(res.text).toContain('"stop_reason":"tool_use"');
    expect(res.text).not.toContain('post-tool prose');
    expect(res.text).not.toContain('final text should not leak');
  });

  it('emits complete invokes from an open function_calls wrapper and closes on tool idle', async () => {
    const partialFunctionCalls = `<function_calls>
<invoke name="Read">
<parameter name="file_path">README.md</parameter>
</invoke>
`;
    const harSSE =
      'event: message\ndata: {"created":true,"message":{"messageId":"m1","conversationId":"c1"}}\n\n' +
      `event: message\ndata: ${JSON.stringify({
        event: 'on_message_delta',
        data: {
          delta: {
            content: [
              {
                type: 'text',
                text: `Thinking: inspect the README first.\n${partialFunctionCalls}`,
              },
            ],
          },
        },
      })}\n\n`;

    process.env.HOPGPT_TOOL_BATCH_IDLE_CLOSE_MS = '10';
    getDefaultClientSpy.mockReturnValue({
      validateAuth: () => ({ valid: true, missing: [], warnings: [] }),
      sendMessage: async () => makeHangingSSEResponse(harSSE),
    });

    const app = buildApp();
    const res = await request(app)
      .post('/v1/messages')
      .send({
        model: 'claude-opus-4-5',
        max_tokens: 128,
        stream: true,
        messages: [{ role: 'user', content: 'inspect the repo' }],
        tools: [
          {
            name: 'Read',
            input_schema: {
              type: 'object',
              properties: { file_path: { type: 'string' } },
              required: ['file_path'],
            },
          },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.text).toContain('"type":"tool_use"');
    expect(res.text).toContain('"name":"Read"');
    expect(res.text).toContain('\\"file_path\\":\\"README.md\\"');
    expect(res.text).toContain('"stop_reason":"tool_use"');
    expect(res.text).toContain('event: message_stop');
    expect(res.text).not.toContain('<function_calls>');
  });

  it('does not inject continue prompts or stream thinking on tool-result continuations', async () => {
    const functionCalls = `<function_calls>
<invoke name="Read">
<parameter name="file_path">src/index.js</parameter>
</invoke>
</function_calls>`;
    const harSSE =
      'event: message\ndata: {"created":true,"message":{"messageId":"m2","conversationId":"c1"}}\n\n' +
      `event: message\ndata: ${JSON.stringify({
        event: 'on_message_delta',
        data: {
          delta: {
            content: [
              {
                type: 'text',
                text: `Thinking: The user said "Continue" after tool results.\n${functionCalls}`,
              },
            ],
          },
        },
      })}\n\n` +
      'event: message\ndata: {"final":true,"conversation":{"conversationId":"c1"},"responseMessage":{"messageId":"r2","conversationId":"c1","content":[]}}\n\n';
    const sendMessage = vi.fn(async () => makeSSEResponse(harSSE));

    getDefaultClientSpy.mockReturnValue({
      validateAuth: () => ({ valid: true, missing: [], warnings: [] }),
      sendMessage,
    });

    const app = buildApp();
    const res = await request(app)
      .post('/v1/messages')
      .send({
        model: 'claude-opus-4-5',
        max_tokens: 128,
        stream: true,
        messages: [
          { role: 'user', content: 'inspect the codebase' },
          {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'toolu_read',
                name: 'Read',
                input: { file_path: 'README.md' },
              },
            ],
          },
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'toolu_read',
                content: '# HoProxy',
              },
            ],
          },
        ],
        tools: [
          {
            name: 'Read',
            input_schema: {
              type: 'object',
              properties: { file_path: { type: 'string' } },
              required: ['file_path'],
            },
          },
        ],
      });

    expect(res.status).toBe(200);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const hopGPTRequest = sendMessage.mock.calls[0][0];
    expect(hopGPTRequest.text).toContain('<tool_result tool_use_id="toolu_read">');
    expect(hopGPTRequest.text).not.toContain('[Continue]');
    expect(hopGPTRequest.text).not.toContain('[Tool execution completed.]');
    expect(res.text).not.toContain('thinking_delta');
    expect(res.text).not.toContain('The user said');
    expect(res.text).toContain('"type":"tool_use"');
    expect(res.text).toContain('"name":"Read"');
    expect(res.text).toContain('\\"file_path\\":\\"src/index.js\\"');
  });

  it('surfaces final answer text on tool-result continuations without another tool call', async () => {
    const answerText = 'The README says HoProxy exposes an Anthropic-compatible API.';
    const harSSE =
      'event: message\ndata: {"created":true,"message":{"messageId":"m2","conversationId":"c1","sender":"User","isCreatedByUser":true}}\n\n' +
      `event: message\ndata: ${JSON.stringify({
        event: 'on_message_delta',
        data: {
          delta: {
            content: [
              {
                type: 'text',
                text: answerText,
              },
            ],
          },
        },
      })}\n\n` +
      'event: message\ndata: {"final":true,"conversation":{"conversationId":"c1"},"responseMessage":{"messageId":"r2","conversationId":"c1","content":[]}}\n\n';

    getDefaultClientSpy.mockReturnValue({
      validateAuth: () => ({ valid: true, missing: [], warnings: [] }),
      sendMessage: async () => makeSSEResponse(harSSE),
    });

    const app = buildApp();
    const res = await request(app)
      .post('/v1/messages')
      .send({
        model: 'claude-opus-4-5',
        max_tokens: 128,
        stream: true,
        messages: [
          { role: 'user', content: 'inspect the README' },
          {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'toolu_read',
                name: 'Read',
                input: { file_path: 'README.md' },
              },
            ],
          },
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'toolu_read',
                content: '# HoProxy',
              },
            ],
          },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.text).toContain(answerText);
    expect(res.text).toContain('"stop_reason":"end_turn"');
  });

  it('stores HopGPT conversation state before completing the stream', async () => {
    const firstSSE =
      'event: message\ndata: {"created":true,"message":{"messageId":"u1","conversationId":"c1"}}\n\n' +
      'event: message\ndata: {"event":"on_message_delta","data":{"delta":{"content":[{"type":"text","text":"Hi"}]}}}\n\n' +
      'event: message\ndata: {"final":true,"conversation":{"conversationId":"c1"},"responseMessage":{"messageId":"r1","conversationId":"c1","content":[{"type":"text","text":"Hi"}]}}\n\n';
    const secondSSE =
      'event: message\ndata: {"created":true,"message":{"messageId":"u2","conversationId":"c1"}}\n\n' +
      'event: message\ndata: {"event":"on_message_delta","data":{"delta":{"content":[{"type":"text","text":"Again"}]}}}\n\n' +
      'event: message\ndata: {"final":true,"conversation":{"conversationId":"c1"},"responseMessage":{"messageId":"r2","conversationId":"c1","content":[{"type":"text","text":"Again"}]}}\n\n';
    const hopGPTRequests = [];

    getDefaultClientSpy.mockReturnValue({
      validateAuth: () => ({ valid: true, missing: [], warnings: [] }),
      sendMessage: async (hopGPTRequest) => {
        hopGPTRequests.push(hopGPTRequest);
        return makeSSEResponse(hopGPTRequests.length === 1 ? firstSSE : secondSSE);
      },
    });

    const app = buildApp();
    const sessionId = `stream-state-${Date.now()}`;
    await request(app)
      .post('/v1/messages')
      .set('X-Session-Id', sessionId)
      .send({
        model: 'claude-opus-4-5',
        max_tokens: 128,
        stream: true,
        messages: [{ role: 'user', content: 'hi' }],
      })
      .expect(200);

    await request(app)
      .post('/v1/messages')
      .set('X-Session-Id', sessionId)
      .send({
        model: 'claude-opus-4-5',
        max_tokens: 128,
        stream: true,
        messages: [
          { role: 'user', content: 'hi' },
          { role: 'assistant', content: 'Hi' },
          { role: 'user', content: 'again' },
        ],
      })
      .expect(200);

    expect(hopGPTRequests[1].parentMessageId).toBe('r1');
    expect(hopGPTRequests[1].text).toBe('again');
  });

  it('does not store a user created id as the assistant parent when a stream is forced closed', async () => {
    const truncatedSSE =
      'event: message\ndata: {"created":true,"message":{"messageId":"u1","conversationId":"c1","sender":"User","isCreatedByUser":true}}\n\n' +
      'event: message\ndata: {"event":"on_message_delta","data":{"delta":{"content":[{"type":"text","text":"Partial"}]}}}\n\n';
    const secondSSE =
      'event: message\ndata: {"created":true,"message":{"messageId":"u2","conversationId":"c1","sender":"User","isCreatedByUser":true}}\n\n' +
      'event: message\ndata: {"final":true,"conversation":{"conversationId":"c1"},"responseMessage":{"messageId":"r2","conversationId":"c1","content":[{"type":"text","text":"Again"}]}}\n\n';
    const hopGPTRequests = [];

    getDefaultClientSpy.mockReturnValue({
      validateAuth: () => ({ valid: true, missing: [], warnings: [] }),
      sendMessage: async (hopGPTRequest) => {
        hopGPTRequests.push(hopGPTRequest);
        return makeSSEResponse(hopGPTRequests.length === 1 ? truncatedSSE : secondSSE);
      },
    });

    const app = buildApp();
    const sessionId = `stream-force-end-${Date.now()}`;
    await request(app)
      .post('/v1/messages')
      .set('X-Session-Id', sessionId)
      .send({
        model: 'claude-opus-4-5',
        max_tokens: 128,
        stream: true,
        messages: [{ role: 'user', content: 'hi' }],
      })
      .expect(200);

    await request(app)
      .post('/v1/messages')
      .set('X-Session-Id', sessionId)
      .send({
        model: 'claude-opus-4-5',
        max_tokens: 128,
        stream: true,
        messages: [
          { role: 'user', content: 'hi' },
          { role: 'assistant', content: 'Partial' },
          { role: 'user', content: 'continue' },
        ],
      })
      .expect(200);

    expect(hopGPTRequests[1].parentMessageId).toBe('00000000-0000-0000-0000-000000000000');
    expect(hopGPTRequests[1].parentMessageId).not.toBe('u1');
  });

  it('does not reuse generated fallback sessions across clients without an explicit session id', async () => {
    const firstSSE =
      'event: message\ndata: {"created":true,"message":{"messageId":"u1","conversationId":"c1"}}\n\n' +
      'event: message\ndata: {"event":"on_message_delta","data":{"delta":{"content":[{"type":"text","text":"Hi"}]}}}\n\n' +
      'event: message\ndata: {"final":true,"conversation":{"conversationId":"c1"},"responseMessage":{"messageId":"r1","conversationId":"c1","content":[{"type":"text","text":"Hi"}]}}\n\n';
    const secondSSE =
      'event: message\ndata: {"created":true,"message":{"messageId":"u2","conversationId":"c1"}}\n\n' +
      'event: message\ndata: {"event":"on_message_delta","data":{"delta":{"content":[{"type":"text","text":"Again"}]}}}\n\n' +
      'event: message\ndata: {"final":true,"conversation":{"conversationId":"c1"},"responseMessage":{"messageId":"r2","conversationId":"c1","content":[{"type":"text","text":"Again"}]}}\n\n';
    const hopGPTRequests = [];

    getDefaultClientSpy.mockReturnValue({
      validateAuth: () => ({ valid: true, missing: [], warnings: [] }),
      sendMessage: async (hopGPTRequest) => {
        hopGPTRequests.push(hopGPTRequest);
        return makeSSEResponse(hopGPTRequests.length === 1 ? firstSSE : secondSSE);
      },
    });

    const app = buildApp();
    await request(app)
      .post('/v1/messages')
      .send({
        model: 'claude-opus-4-5',
        max_tokens: 128,
        stream: true,
        messages: [{ role: 'user', content: 'hi' }],
      })
      .expect(200);

    await request(app)
      .post('/v1/messages')
      .send({
        model: 'claude-opus-4-5',
        max_tokens: 128,
        stream: true,
        messages: [
          { role: 'user', content: 'hi' },
          { role: 'assistant', content: 'Hi' },
          { role: 'user', content: 'again' },
        ],
      })
      .expect(200);

    expect(hopGPTRequests[1].parentMessageId).toBe('00000000-0000-0000-0000-000000000000');
    expect(hopGPTRequests[1].text).toContain('Human: hi');
    expect(hopGPTRequests[1].text).toContain('Assistant: Hi');
    expect(hopGPTRequests[1].text).toContain('Human: again');
  });

  // Regression: a pre-stream failure (expired creds, CF block, network error)
  // used to flush SSE headers first, then write a lone `event: error` and end.
  // Vercel AI SDK's Anthropic provider chokes on that shape with
  // AI_JSONParseError(text="undefined"). The fix delays flushHeaders() until
  // the first HopGPT byte, so pre-stream errors return proper HTTP JSON.
  it('returns HTTP JSON error (not SSE) when sendMessage throws before the stream starts', async () => {
    getDefaultClientSpy.mockReturnValue({
      validateAuth: () => ({ valid: true, missing: [], warnings: [] }),
      sendMessage: async () => {
        throw new RefreshTokenExpiredError();
      },
    });

    const app = buildApp();
    const res = await request(app)
      .post('/v1/messages')
      .send({
        model: 'claude-sonnet-4-5',
        max_tokens: 128,
        stream: true,
        messages: [{ role: 'user', content: 'hi' }],
      });

    expect(res.status).toBe(401);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.headers['content-type']).not.toMatch(/text\/event-stream/);
    expect(res.body?.type).toBe('error');
    expect(res.body?.error?.type).toBe('authentication_error');
    expect(res.body?.error?.message).toMatch(/Refresh token expired/);
  });
});
