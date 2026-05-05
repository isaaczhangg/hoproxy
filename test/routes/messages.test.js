import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CloudflareBlockedError, RefreshTokenExpiredError } from '../../src/errors/authErrors.js';
import messagesRouter from '../../src/routes/messages.js';
import { clearConversationStoreForTests } from '../../src/services/conversationStore.js';
import { getDefaultClient, HopGPTError } from '../../src/services/hopgptClient.js';
import { readFixture } from '../helpers/fixtures.js';
import { createSseResponseFromEvents } from '../helpers/sse.js';

vi.mock('../../src/services/hopgptClient.js', async () => {
  const actual = await vi.importActual('../../src/services/hopgptClient.js');
  return {
    ...actual,
    getDefaultClient: vi.fn(),
  };
});

function createApp() {
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use('/v1', messagesRouter);
  return app;
}

describe('messages routes', () => {
  beforeEach(() => {
    clearConversationStoreForTests();
    getDefaultClient.mockReset();
  });

  it('rejects invalid requests', async () => {
    const app = createApp();
    const response = await request(app).post('/v1/messages').send({ messages: [] });

    expect(response.status).toBe(400);
    expect(response.body.error.type).toBe('invalid_request_error');
  });

  it('returns authentication errors when auth is missing', async () => {
    const mockClient = {
      validateAuth: () => ({ valid: false, missing: ['HOPGPT_BEARER_TOKEN'] }),
    };
    getDefaultClient.mockReturnValue(mockClient);

    const app = createApp();
    const requestBody = await readFixture('anthropic-request-basic.json');
    const response = await request(app).post('/v1/messages').send(requestBody);

    expect(response.status).toBe(401);
    expect(response.body.error.type).toBe('authentication_error');
  });

  it('handles non-streaming requests', async () => {
    const mockClient = {
      validateAuth: () => ({ valid: true, missing: [], warnings: [] }),
      sendMessage: vi.fn(),
    };
    const finalData = await readFixture('hopgpt-response-final.json');
    mockClient.sendMessage.mockResolvedValue(
      createSseResponseFromEvents([{ event: 'message', data: finalData }]),
    );
    getDefaultClient.mockReturnValue(mockClient);

    const app = createApp();
    const requestBody = await readFixture('anthropic-request-basic.json');
    const response = await request(app).post('/v1/messages').send(requestBody);

    expect(response.status).toBe(200);
    expect(response.headers['x-session-id']).toBe('sess-123');
    expect(response.body.type).toBe('message');
    expect(response.body.stop_reason).toBe('tool_use');
    expect(response.body.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'thinking' }),
        expect.objectContaining({ type: 'text' }),
        expect.objectContaining({ type: 'tool_use' }),
      ]),
    );
  });

  it('preserves parallel tool calls from final-only non-streaming responses', async () => {
    const mockClient = {
      validateAuth: () => ({ valid: true, missing: [], warnings: [] }),
      sendMessage: vi.fn(),
    };
    const finalToolCalls = [
      '<tool_call>{"name":"Read","parameters":{"file_path":"README.md"}}</tool_call>',
      '<tool_call>{"name":"Read","parameters":{"file_path":"package.json"}}</tool_call>',
    ].join('');
    mockClient.sendMessage.mockResolvedValue(
      createSseResponseFromEvents([
        {
          event: 'message',
          data: {
            final: true,
            responseMessage: {
              messageId: 'msg-final',
              promptTokens: 10,
              tokenCount: 5,
              content: [{ type: 'text', text: finalToolCalls }],
            },
          },
        },
      ]),
    );
    getDefaultClient.mockReturnValue(mockClient);

    const app = createApp();
    const requestBody = {
      model: 'claude-sonnet-4-5',
      messages: [{ role: 'user', content: 'Read both files' }],
      max_tokens: 128,
      tools: [
        {
          name: 'Read',
          description: 'Read a file',
          input_schema: {
            type: 'object',
            properties: {
              file_path: { type: 'string' },
            },
            required: ['file_path'],
          },
        },
      ],
      stream: false,
    };

    const response = await request(app).post('/v1/messages').send(requestBody);

    expect(response.status).toBe(200);
    const toolUseBlocks = response.body.content.filter((block) => block.type === 'tool_use');
    expect(toolUseBlocks).toEqual([
      expect.objectContaining({ name: 'Read', input: { file_path: 'README.md' } }),
      expect.objectContaining({ name: 'Read', input: { file_path: 'package.json' } }),
    ]);
    expect(response.body.stop_reason).toBe('tool_use');
  });

  it('streams SSE responses', async () => {
    const mockClient = {
      validateAuth: () => ({ valid: true, missing: [], warnings: [] }),
      sendMessage: vi.fn(),
    };
    const streamEvents = [
      { event: 'message', data: { created: true, message: { id: 'msg-1' } } },
      {
        event: 'message',
        data: {
          event: 'on_message_delta',
          data: { delta: { content: [{ type: 'text', text: 'Hello' }] } },
        },
      },
      {
        event: 'message',
        data: {
          final: true,
          responseMessage: {
            messageId: 'msg-final',
            tokenCount: 1,
            content: [{ type: 'text', text: 'Hello' }],
          },
        },
      },
    ];
    mockClient.sendMessage.mockResolvedValue(createSseResponseFromEvents(streamEvents));
    getDefaultClient.mockReturnValue(mockClient);

    const app = createApp();
    const requestBody = await readFixture('anthropic-request-tools.json');
    const response = await request(app).post('/v1/messages').send(requestBody);

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('text/event-stream');
    expect(response.text).toContain('event: message_start');
    expect(response.text).toContain('event: content_block_delta');
    expect(response.text).toContain('event: message_stop');
  });

  it('converts HopGPT errors to Anthropic error formats', async () => {
    const mockClient = {
      validateAuth: () => ({ valid: true, missing: [], warnings: [] }),
      sendMessage: vi.fn(),
    };
    mockClient.sendMessage.mockRejectedValue(new HopGPTError(429, 'Rate limited'));
    getDefaultClient.mockReturnValue(mockClient);

    const app = createApp();
    const requestBody = await readFixture('anthropic-request-basic.json');
    const response = await request(app).post('/v1/messages').send(requestBody);

    expect(response.status).toBe(429);
    expect(response.body.error.type).toBe('rate_limit_error');
  });

  it('returns authentication_error when refresh token expired', async () => {
    const mockClient = {
      validateAuth: () => ({ valid: true, missing: [], warnings: [] }),
      sendMessage: vi.fn(),
    };
    mockClient.sendMessage.mockRejectedValue(new RefreshTokenExpiredError());
    getDefaultClient.mockReturnValue(mockClient);

    const app = createApp();
    const requestBody = await readFixture('anthropic-request-basic.json');
    const response = await request(app).post('/v1/messages').send(requestBody);

    expect(response.status).toBe(401);
    expect(response.body.error.type).toBe('authentication_error');
  });

  it('returns api_error when Cloudflare blocks refresh', async () => {
    const mockClient = {
      validateAuth: () => ({ valid: true, missing: [], warnings: [] }),
      sendMessage: vi.fn(),
    };
    mockClient.sendMessage.mockRejectedValue(new CloudflareBlockedError());
    getDefaultClient.mockReturnValue(mockClient);

    const app = createApp();
    const requestBody = await readFixture('anthropic-request-basic.json');
    const response = await request(app).post('/v1/messages').send(requestBody);

    expect(response.status).toBe(503);
    expect(response.body.error.type).toBe('api_error');
  });
});
