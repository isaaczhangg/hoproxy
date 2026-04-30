import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HopGPTClient } from '../../src/services/hopgptClient.js';
import * as tlsClient from '../../src/services/tlsClient.js';

function createMockTLSResponse({
  ok = true,
  status = 200,
  statusText = 'OK',
  body = '',
  headers = {}
} = {}) {
  return {
    ok,
    status,
    statusText,
    body,
    headers,
    text: async () => body,
    json: async () => JSON.parse(body || '{}')
  };
}

function newClient(overrides = {}) {
  return new HopGPTClient({
    baseURL: 'https://example.com',
    bearerToken: 'test-bearer',
    openidUserId: 'test-oid',
    connectSid: 'test-sid',
    userAgent: 'Mozilla/5.0 Firefox/150.0',
    autoPersist: false,
    autoRefresh: false,
    ...overrides
  });
}

describe('HopGPTClient.startStream', () => {
  let tlsFetchSpy;

  beforeEach(() => {
    tlsFetchSpy = vi.spyOn(tlsClient, 'tlsFetch');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns the ack object on 2xx JSON response', async () => {
    tlsFetchSpy.mockResolvedValue(createMockTLSResponse({
      ok: true,
      status: 200,
      body: JSON.stringify({ streamId: 'abc-123', conversationId: 'conv-1', status: 'started' }),
      headers: { 'content-type': 'application/json' }
    }));

    const client = newClient();
    const ack = await client.startStream({ text: 'hi' });

    expect(ack).toEqual({ streamId: 'abc-123', conversationId: 'conv-1', status: 'started' });
  });

  it('sends the correct method, URL, body, and headers', async () => {
    tlsFetchSpy.mockResolvedValue(createMockTLSResponse({
      ok: true, status: 200,
      body: JSON.stringify({ streamId: 's', conversationId: 'c', status: 'started' }),
      headers: { 'content-type': 'application/json' }
    }));

    const client = newClient();
    await client.startStream({ text: 'hello' });

    expect(tlsFetchSpy).toHaveBeenCalledTimes(1);
    const call = tlsFetchSpy.mock.calls[0][0];
    expect(call.method).toBe('POST');
    expect(call.url).toBe('https://example.com/api/agents/chat/AnthropicClaude');
    expect(call.body).toEqual({ text: 'hello' });
    expect(call.headers['Content-Type']).toBe('application/json');
    expect(call.headers['Accept']).toBe('application/json, text/plain, */*');
    expect(call.headers['Origin']).toBe('https://example.com');
    expect(call.headers['Referer']).toBe('https://example.com/c/new');
    expect(call.headers['Authorization']).toBe('Bearer test-bearer');
    expect(call.headers['Cookie']).toMatch(/openid_user_id=test-oid/);
  });

  it('throws HopGPTError(401) on 401 response', async () => {
    tlsFetchSpy.mockResolvedValue(createMockTLSResponse({
      ok: false, status: 401, statusText: 'Unauthorized',
      body: 'nope'
    }));
    const client = newClient();
    await expect(client.startStream({ text: 'hi' })).rejects.toMatchObject({
      name: 'HopGPTError',
      statusCode: 401
    });
  });

  it('throws HopGPTError(403) on 403 response', async () => {
    tlsFetchSpy.mockResolvedValue(createMockTLSResponse({ ok: false, status: 403, statusText: 'Forbidden', body: '' }));
    const client = newClient();
    await expect(client.startStream({ text: 'hi' })).rejects.toMatchObject({ statusCode: 403 });
  });

  it('throws HopGPTError(429) on 429 response', async () => {
    tlsFetchSpy.mockResolvedValue(createMockTLSResponse({
      ok: false, status: 429, statusText: 'Too Many Requests', body: 'slow down',
      headers: { 'retry-after': '2' }
    }));
    const client = newClient();
    await expect(client.startStream({ text: 'hi' })).rejects.toMatchObject({ statusCode: 429 });
  });

  it('throws HopGPTError(500) on 500 response', async () => {
    tlsFetchSpy.mockResolvedValue(createMockTLSResponse({ ok: false, status: 500, statusText: 'Server Error', body: 'oops' }));
    const client = newClient();
    await expect(client.startStream({ text: 'hi' })).rejects.toMatchObject({ statusCode: 500 });
  });

  it('throws HopGPTError(502, /Malformed stream ack/) on non-JSON 2xx body', async () => {
    tlsFetchSpy.mockResolvedValue(createMockTLSResponse({
      ok: true, status: 200,
      body: '<html><title>Please log in</title></html>',
      headers: { 'content-type': 'text/html' }
    }));
    const client = newClient();
    await expect(client.startStream({ text: 'hi' })).rejects.toMatchObject({
      statusCode: 502,
      message: expect.stringMatching(/Malformed stream ack/)
    });
  });

  it('throws HopGPTError(502, /Malformed stream ack/) on JSON 2xx missing streamId', async () => {
    tlsFetchSpy.mockResolvedValue(createMockTLSResponse({
      ok: true, status: 200,
      body: JSON.stringify({ conversationId: 'c', status: 'started' }),
      headers: { 'content-type': 'application/json' }
    }));
    const client = newClient();
    await expect(client.startStream({ text: 'hi' })).rejects.toMatchObject({
      statusCode: 502,
      message: expect.stringMatching(/Malformed stream ack/)
    });
  });

  it('throws Error(/Request aborted/) when signal already aborted; no HTTP call', async () => {
    const controller = new AbortController();
    controller.abort();
    const client = newClient();
    await expect(client.startStream({ text: 'hi' }, { signal: controller.signal }))
      .rejects.toThrow(/Request aborted/);
    expect(tlsFetchSpy).not.toHaveBeenCalled();
  });

  it('throws synchronously when hopGPTRequest is null', async () => {
    const client = newClient();
    await expect(client.startStream(null)).rejects.toThrow();
    expect(tlsFetchSpy).not.toHaveBeenCalled();
  });

  it('does not call refreshTokens even with autoRefresh:true and a 401 response', async () => {
    tlsFetchSpy.mockResolvedValue(createMockTLSResponse({ ok: false, status: 401, statusText: 'Unauthorized', body: '' }));
    const client = newClient({ autoRefresh: true });
    const refreshSpy = vi.spyOn(client, 'refreshTokens');
    await expect(client.startStream({ text: 'hi' })).rejects.toMatchObject({ statusCode: 401 });
    expect(refreshSpy).not.toHaveBeenCalled();
  });
});
