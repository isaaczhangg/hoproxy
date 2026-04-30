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

describe('HopGPTClient.subscribeStream', () => {
  let tlsFetchSpy;
  let fetchSpy;

  beforeEach(() => {
    tlsFetchSpy = vi.spyOn(tlsClient, 'tlsFetch');
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      throw new Error('fetchSpy not configured in this test');
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function makeFetchSSEResponse({ status = 200, contentType = 'text/event-stream', body = 'event: message\ndata: {}\n\n' } = {}) {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(body));
        controller.close();
      }
    });
    const headers = new Map();
    headers.set('content-type', contentType);
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 200 ? 'OK' : 'Error',
      headers: { get: (k) => headers.get(k.toLowerCase()) || null },
      body: stream,
      text: async () => body,
      json: async () => JSON.parse(body)
    };
  }

  it('returns a fetch-like response with a ReadableStream body on happy path (fetch transport)', async () => {
    fetchSpy.mockResolvedValue(makeFetchSSEResponse({ body: 'event: message\ndata: {"final":true}\n\n' }));
    const client = newClient();
    const response = await client.subscribeStream('abc');
    expect(response.ok).toBe(true);
    expect(response.status).toBe(200);
    expect(response.body).toBeDefined();
    const reader = response.body.getReader();
    const { value } = await reader.read();
    expect(new TextDecoder().decode(value)).toMatch(/final/);
  });

  it('uses tlsFetch when streamingTransport is "tls"', async () => {
    tlsFetchSpy.mockResolvedValue(createMockTLSResponse({
      ok: true, status: 200,
      body: 'event: message\ndata: {"final":true}\n\n',
      headers: { 'content-type': 'text/event-stream' }
    }));
    const client = newClient({ streamingTransport: 'tls' });
    const response = await client.subscribeStream('abc');
    expect(tlsFetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(response.ok).toBe(true);
  });

  it('falls back to tlsFetch on generic fetch failure', async () => {
    fetchSpy.mockRejectedValue(new Error('ECONNRESET'));
    tlsFetchSpy.mockResolvedValue(createMockTLSResponse({
      ok: true, status: 200,
      body: 'event: message\ndata: {"final":true}\n\n',
      headers: { 'content-type': 'text/event-stream' }
    }));
    const client = newClient();
    const response = await client.subscribeStream('abc');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(tlsFetchSpy).toHaveBeenCalledTimes(1);
    expect(response.ok).toBe(true);
  });

  it('rethrows AbortError from fetch without falling back to tlsFetch', async () => {
    const abortErr = new Error('aborted');
    abortErr.name = 'AbortError';
    fetchSpy.mockRejectedValue(abortErr);
    const client = newClient();
    await expect(client.subscribeStream('abc')).rejects.toMatchObject({ name: 'AbortError' });
    expect(tlsFetchSpy).not.toHaveBeenCalled();
  });

  it('sends correct URL, method, and headers', async () => {
    fetchSpy.mockResolvedValue(makeFetchSSEResponse());
    const client = newClient();
    await client.subscribeStream('xyz-789');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://example.com/api/agents/chat/stream/xyz-789');
    expect(init.method).toBe('GET');
    expect(init.headers['Accept']).toBe('*/*');
    expect(init.headers['Cache-Control']).toBe('no-cache');
    expect(init.headers['Pragma']).toBe('no-cache');
    expect(init.headers['Referer']).toBe('https://example.com/c/new');
    expect(init.headers['Authorization']).toBe('Bearer test-bearer');
    expect(init.headers['Cookie']).toMatch(/openid_user_id=test-oid/);
  });

  it('URL-encodes streamIds with reserved characters', async () => {
    fetchSpy.mockResolvedValue(makeFetchSSEResponse());
    const client = newClient();
    await client.subscribeStream('foo/bar?x=1');
    const [url] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://example.com/api/agents/chat/stream/foo%2Fbar%3Fx%3D1');
  });

  it('throws HopGPTError(401) on 401 response', async () => {
    fetchSpy.mockResolvedValue(makeFetchSSEResponse({ status: 401, contentType: 'text/plain', body: 'nope' }));
    const client = newClient();
    await expect(client.subscribeStream('abc')).rejects.toMatchObject({ statusCode: 401 });
  });

  it('throws HopGPTError(403) on 403 response', async () => {
    fetchSpy.mockResolvedValue(makeFetchSSEResponse({ status: 403, contentType: 'text/plain', body: '' }));
    const client = newClient();
    await expect(client.subscribeStream('abc')).rejects.toMatchObject({ statusCode: 403 });
  });

  it('throws HopGPTError(429) on 429 response', async () => {
    fetchSpy.mockResolvedValue(makeFetchSSEResponse({ status: 429, contentType: 'text/plain', body: 'slow' }));
    const client = newClient();
    await expect(client.subscribeStream('abc')).rejects.toMatchObject({ statusCode: 429 });
  });

  it('throws HopGPTError(500) on 500 response', async () => {
    fetchSpy.mockResolvedValue(makeFetchSSEResponse({ status: 500, contentType: 'text/plain', body: '' }));
    const client = newClient();
    await expect(client.subscribeStream('abc')).rejects.toMatchObject({ statusCode: 500 });
  });

  it('throws HopGPTError(502, /Expected text\\/event-stream/) on 200 + text/html', async () => {
    fetchSpy.mockResolvedValue(makeFetchSSEResponse({ contentType: 'text/html', body: '<html>login</html>' }));
    const client = newClient();
    await expect(client.subscribeStream('abc')).rejects.toMatchObject({
      statusCode: 502,
      message: expect.stringMatching(/Expected text\/event-stream/)
    });
  });

  it('throws HopGPTError(502) on 200 + application/json', async () => {
    fetchSpy.mockResolvedValue(makeFetchSSEResponse({ contentType: 'application/json', body: '{}' }));
    const client = newClient();
    await expect(client.subscribeStream('abc')).rejects.toMatchObject({
      statusCode: 502,
      message: expect.stringMatching(/Expected text\/event-stream/)
    });
  });

  it('throws synchronously when streamId is empty; no HTTP call', async () => {
    const client = newClient();
    await expect(client.subscribeStream('   ')).rejects.toThrow(/non-empty streamId/);
    await expect(client.subscribeStream('')).rejects.toThrow(/non-empty streamId/);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(tlsFetchSpy).not.toHaveBeenCalled();
  });

  it('throws when signal already aborted; no HTTP call', async () => {
    const controller = new AbortController();
    controller.abort();
    const client = newClient();
    await expect(client.subscribeStream('abc', { signal: controller.signal }))
      .rejects.toThrow(/Request aborted/);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(tlsFetchSpy).not.toHaveBeenCalled();
  });
});
