import { createParser } from 'eventsource-parser';
import { loggers } from './logger.js';

const log = loggers.transform;

/**
 * Parse an SSE stream from a fetch response
 * @param {Response} response - Fetch response with SSE body
 * @param {function} onEvent - Callback for each parsed event
 * @returns {Promise<void>}
 */
export async function parseSSEStream(response, onEvent) {
  const parser = createParser((event) => {
    if (event.type === 'event') {
      onEvent({
        event: event.event || 'message',
        data: event.data,
      });
    }
  });

  const reader = response.body.getReader();
  const decoder = new TextDecoder();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      parser.feed(chunk);
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Parse SSE stream and pipe transformed events to response
 * @param {Response} fetchResponse - Fetch response with SSE body
 * @param {object} res - Express response object
 * @param {function} transformEvent - Function to transform each event
 * @param {AbortSignal} [signal] - Optional abort signal to cancel streaming
 * @returns {Promise<object>} Final transformer state
 */
export async function pipeSSEStream(fetchResponse, res, transformEvent, signal, options = {}) {
  const { autoEndOnMessageStop = false, onToolUseIdle = null, toolUseIdleCloseMs = null } = options;
  let stoppedOnMessageStop = false;
  let toolUseIdleTimer = null;
  const parser = createParser((event) => {
    if (stoppedOnMessageStop) {
      return;
    }

    if (event.type === 'event') {
      const parsedEvent = {
        event: event.event || 'message',
        data: event.data,
      };

      const transformedEvents = transformEvent(parsedEvent);

      if (transformedEvents) {
        const events = Array.isArray(transformedEvents) ? transformedEvents : [transformedEvents];
        let sawToolUse = false;

        for (const evt of events) {
          // Check if response is still writable before writing
          if (res.writableEnded || res.destroyed) {
            return;
          }

          if (evt.event === 'message_start') {
            log.debug('Streaming message_start', {
              model: evt.data?.message?.model,
              messageId: evt.data?.message?.id,
            });
          }

          writeEvent(res, evt);
          if (isToolUseStartEvent(evt)) {
            sawToolUse = true;
          }
          if (autoEndOnMessageStop && evt.event === 'message_stop') {
            clearToolUseIdleTimer();
            stoppedOnMessageStop = true;
            return;
          }
        }

        if (sawToolUse && !stoppedOnMessageStop) {
          scheduleToolUseIdleClose();
        }
      }
    }
  });

  const reader = fetchResponse.body.getReader();
  const decoder = new TextDecoder();

  function clearToolUseIdleTimer() {
    if (toolUseIdleTimer) {
      clearTimeout(toolUseIdleTimer);
      toolUseIdleTimer = null;
    }
  }

  function scheduleToolUseIdleClose() {
    if (
      typeof onToolUseIdle !== 'function' ||
      !Number.isFinite(toolUseIdleCloseMs) ||
      toolUseIdleCloseMs < 0
    ) {
      return;
    }

    clearToolUseIdleTimer();
    toolUseIdleTimer = setTimeout(() => {
      toolUseIdleTimer = null;
      if (stoppedOnMessageStop || signal?.aborted || res.writableEnded || res.destroyed) {
        return;
      }

      const events = onToolUseIdle();
      const normalizedEvents = Array.isArray(events) ? events : events ? [events] : [];
      for (const evt of normalizedEvents) {
        if (res.writableEnded || res.destroyed) {
          return;
        }
        writeEvent(res, evt);
        if (evt.event === 'message_stop') {
          stoppedOnMessageStop = true;
        }
      }

      if (stoppedOnMessageStop) {
        reader.cancel().catch((error) => {
          log.debug('Failed to cancel upstream reader after tool-use idle close', {
            error: error.message,
          });
        });
      }
    }, toolUseIdleCloseMs);
  }

  try {
    while (true) {
      // Check if aborted before reading next chunk
      if (signal?.aborted) {
        clearToolUseIdleTimer();
        await reader.cancel();
        break;
      }

      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      parser.feed(chunk);
      if (stoppedOnMessageStop) {
        clearToolUseIdleTimer();
        await reader.cancel();
        break;
      }
    }
  } finally {
    clearToolUseIdleTimer();
    reader.releaseLock();
  }

  return { stoppedOnMessageStop };
}

function writeEvent(res, evt) {
  res.write(`event: ${evt.event}\n`);
  res.write(`data: ${JSON.stringify(evt.data)}\n\n`);
  if (typeof res.flush === 'function') {
    res.flush();
  }
}

function isToolUseStartEvent(evt) {
  return evt.event === 'content_block_start' && evt.data?.content_block?.type === 'tool_use';
}

/**
 * Collect all events from an SSE stream
 * @param {Response} response - Fetch response with SSE body
 * @returns {Promise<Array>} Array of parsed events
 */
export async function collectSSEEvents(response) {
  const events = [];

  await parseSSEStream(response, (event) => {
    events.push(event);
  });

  return events;
}
