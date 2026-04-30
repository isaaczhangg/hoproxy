import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import messagesRouter from '../../src/routes/messages.js';
import * as hopgptClientModule from '../../src/services/hopgptClient.js';

function makeSSEResponse(body) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(body));
      controller.close();
    }
  });
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: { get: (k) => k.toLowerCase() === 'content-type' ? 'text/event-stream' : null },
    body: stream,
    text: async () => body,
    json: async () => { throw new Error('not json'); }
  };
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/v1', messagesRouter);
  return app;
}

describe('POST /v1/messages non-streaming — missing final event', () => {
  let getDefaultClientSpy;
  beforeEach(() => {
    getDefaultClientSpy = vi.spyOn(hopgptClientModule, 'getDefaultClient');
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns 502 when the SSE stream ends without final:true', async () => {
    const incompleteSSE =
      'event: message\ndata: {"created":true,"message":{"messageId":"m1","conversationId":"c1","sender":"User","text":"hi","isCreatedByUser":true,"tokenCount":5}}\n\n' +
      'event: message\ndata: {"event":"on_message_delta","data":{"delta":{"content":[{"type":"text","text":"hello"}]}}}\n\n';

    getDefaultClientSpy.mockReturnValue({
      validateAuth: () => ({ valid: true, missing: [], warnings: [] }),
      sendMessage: async () => makeSSEResponse(incompleteSSE)
    });

    const app = buildApp();
    const res = await request(app)
      .post('/v1/messages')
      .send({ model: 'claude-sonnet-4-5', max_tokens: 128, messages: [{ role: 'user', content: 'hi' }] });

    expect(res.status).toBe(502);
    expect(res.body?.error?.message).toMatch(/Stream ended without final event/);
  });

  it('returns 200 with complete content when the SSE stream ends with final:true', async () => {
    const completeSSE =
      'event: message\ndata: {"created":true,"message":{"messageId":"m1","conversationId":"c1","sender":"User","text":"hi","isCreatedByUser":true,"tokenCount":5}}\n\n' +
      'event: message\ndata: {"event":"on_message_delta","data":{"delta":{"content":[{"type":"text","text":"hello"}]}}}\n\n' +
      'event: message\ndata: {"final":true,"conversation":{"conversationId":"c1"},"responseMessage":{"content":[{"type":"text","text":"hello"}],"promptTokens":5,"tokenCount":1}}\n\n';

    getDefaultClientSpy.mockReturnValue({
      validateAuth: () => ({ valid: true, missing: [], warnings: [] }),
      sendMessage: async () => makeSSEResponse(completeSSE)
    });

    const app = buildApp();
    const res = await request(app)
      .post('/v1/messages')
      .send({ model: 'claude-sonnet-4-5', max_tokens: 128, messages: [{ role: 'user', content: 'hi' }] });

    expect(res.status).toBe(200);
    expect(res.body?.content?.[0]?.text).toBe('hello');
  });
});
