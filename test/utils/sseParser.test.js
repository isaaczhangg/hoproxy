import { describe, expect, it } from 'vitest';
import { parseSSEStream, pipeSSEStream } from '../../src/utils/sseParser.js';
import { createSseResponse } from '../helpers/sse.js';

describe('sseParser utilities', () => {
  it('parses SSE streams into events', async () => {
    const response = createSseResponse(
      'event: message\ndata: {"foo":"bar"}\n\n' + 'event: update\ndata: {"count":1}\n\n',
    );

    const events = [];
    await parseSSEStream(response, (event) => events.push(event));

    expect(events).toEqual([
      { event: 'message', data: '{"foo":"bar"}' },
      { event: 'update', data: '{"count":1}' },
    ]);
  });

  it('pipes and transforms SSE events', async () => {
    const response = createSseResponse('event: message\ndata: {"foo":"bar"}\n\n');

    const writes = [];
    const res = {
      write: (chunk) => writes.push(chunk),
    };

    await pipeSSEStream(response, res, (event) => ({
      event: 'proxy',
      data: { original: event.data },
    }));

    const output = writes.join('');
    expect(output).toContain('event: proxy');
    expect(output).toContain('data: {"original":"{\\"foo\\":\\"bar\\"}"}');
  });
});
