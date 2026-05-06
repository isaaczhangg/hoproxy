import { ReadableStream } from 'node:stream/web';

export function buildSseEvent(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export function createSseResponse(bodyText) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(bodyText));
      controller.close();
    },
  });
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
    },
  });
}

export function createSseResponseFromEvents(events) {
  const body = events.map(({ event, data }) => buildSseEvent(event, data)).join('');
  return createSseResponse(body);
}
