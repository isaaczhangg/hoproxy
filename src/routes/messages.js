import { Router } from 'express';
import {
  AuthError,
  CloudflareBlockedError,
  NetworkError,
  RefreshTokenExpiredError,
  TokenRefreshError,
} from '../errors/authErrors.js';
import {
  getConversationState,
  rememberConversationTurn,
  resetConversationState,
  resolveSessionId,
  shouldResetConversation,
  updateConversationState,
} from '../services/conversationStore.js';
import { getDefaultClient, HopGPTError } from '../services/hopgptClient.js';
import {
  extractThinkingConfig,
  getToolChoiceConfig,
  normalizeSystemPrompt,
  transformAnthropicToHopGPT,
} from '../transformers/anthropicToHopGPT.js';
import { formatSSEEvent, HopGPTToAnthropicTransformer } from '../transformers/hopGPTToAnthropic.js';
import { analyzeConversationState } from '../transformers/thinkingUtils.js';
import { loggers } from '../utils/logger.js';
import { resolveModelMapping, stripProviderPrefix } from '../utils/modelMapping.js';
import { parseSSEStream, pipeSSEStream } from '../utils/sseParser.js';

const log = loggers.messages;
const router = Router();
const DEFAULT_STREAM_IDLE_PING_DELAY_MS = 250;
const DEFAULT_TOOL_BATCH_IDLE_CLOSE_MS = 100;

router.post('/messages/count_tokens', (_req, res) => {
  res.status(501).json({
    type: 'error',
    error: {
      type: 'not_implemented',
      message:
        'Token counting is not implemented. Use /v1/messages and configure your client to skip token counting.',
    },
  });
});

router.post('/messages', async (req, res) => {
  try {
    const anthropicRequest = req.body;

    const validationError = validateRequest(anthropicRequest);
    if (validationError) {
      return res.status(400).json({
        type: 'error',
        error: {
          type: 'invalid_request_error',
          message: validationError,
        },
      });
    }

    const client = getDefaultClient();

    const authValidation = client.validateAuth();
    if (!authValidation.valid) {
      return res.status(401).json({
        type: 'error',
        error: {
          type: 'authentication_error',
          message: `Missing authentication configuration: ${authValidation.missing.join(', ')}`,
        },
      });
    }

    if (authValidation.warnings?.length > 0) {
      authValidation.warnings.forEach((warning) => log.warn(warning));
    }

    const requestedModel = anthropicRequest.model;
    const strippedModel = stripProviderPrefix(requestedModel);
    const modelMapping = resolveModelMapping(strippedModel);
    if (!modelMapping.mapped && anthropicRequest.model) {
      log.warn(`Unmapped model "${anthropicRequest.model}", using as-is`);
    }

    const resetRequested = shouldResetConversation(req, anthropicRequest);
    const { sessionId } = resolveSessionId(req, anthropicRequest, {
      allowTranscriptMatch: !resetRequested,
    });
    res.setHeader('X-Session-Id', sessionId);

    if (resetRequested) {
      resetConversationState(sessionId);
    }

    const storedConversationState = resetRequested ? null : getConversationState(sessionId);
    const requestConversationState = normalizeConversationState(
      anthropicRequest.conversation_state || anthropicRequest.conversationState,
    );
    const conversationState = mergeConversationStates(
      storedConversationState,
      requestConversationState,
    );

    const hopGPTRequest = transformAnthropicToHopGPT(anthropicRequest, conversationState);
    hopGPTRequest.model = modelMapping.hopgptModel || strippedModel || hopGPTRequest.model;
    if (modelMapping.hopgptEndpoint) {
      hopGPTRequest.endpoint = modelMapping.hopgptEndpoint;
    }
    if (modelMapping.modelDisplayLabel) {
      hopGPTRequest.modelDisplayLabel = modelMapping.modelDisplayLabel;
    }

    log.debug('Request transformed', {
      model: hopGPTRequest.model,
      endpoint: hopGPTRequest.endpoint,
      toolCount: hopGPTRequest.tools?.length || 0,
      streaming: anthropicRequest.stream === true,
    });

    const thinkingConfig = extractThinkingConfig(anthropicRequest);
    const conversationAnalysis = analyzeConversationState(anthropicRequest.messages);
    const suppressThinking = thinkingConfig.enabled && conversationAnalysis.inToolLoop;

    const systemPrompt =
      normalizeSystemPrompt(anthropicRequest.system) ??
      normalizeSystemPrompt(conversationState?.systemPrompt ?? conversationState?.system);

    // This preserves <mcp_tool_call> blocks in text for clients like OpenCode
    // that parse and execute tool calls directly from the text stream
    const mcpPassthrough =
      req.headers['x-mcp-passthrough'] === 'true' ||
      anthropicRequest.metadata?.mcp_passthrough === true ||
      anthropicRequest.metadata?.mcpPassthrough === true;

    const toolNames = extractToolNames(anthropicRequest.tools);
    const hasTools = toolNames.length > 0;
    const toolChoiceConfig = getToolChoiceConfig(anthropicRequest.tool_choice);
    const isStreaming = anthropicRequest.stream === true;

    const stopOnToolUse = shouldStopOnToolUse(
      mcpPassthrough,
      hasTools,
      toolChoiceConfig,
      isStreaming,
    );

    log.debug('Processing request', {
      sessionId: `${sessionId.slice(0, 8)}...`,
      mcpPassthrough,
      thinkingEnabled: thinkingConfig.enabled,
      suppressThinking,
      hasTools,
      disableParallelToolUse: toolChoiceConfig.disableParallelToolUse,
      stopOnToolUse,
    });

    const transformerOptions = {
      thinkingEnabled: thinkingConfig.enabled,
      suppressThinking,
      maxTokens: hopGPTRequest.max_tokens,
      stopSequences: hopGPTRequest.stop_sequences,
      systemPrompt,
      mcpPassthrough,
      stopOnToolUse,
      toolNames,
      tools: anthropicRequest.tools,
    };

    // Echo the requested model in responses to avoid client-side model validation errors.
    const responseModel = anthropicRequest.model;

    log.debug('Model resolution', {
      requested: anthropicRequest.model,
      stripped: strippedModel,
      hopgpt: modelMapping.hopgptModel,
      endpoint: hopGPTRequest.endpoint,
      response: responseModel,
    });

    const transformer = new HopGPTToAnthropicTransformer(responseModel, transformerOptions);

    if (isStreaming) {
      await handleStreamingRequest(
        client,
        hopGPTRequest,
        transformer,
        res,
        req,
        sessionId,
        anthropicRequest,
      );
    } else {
      await handleNonStreamingRequest(
        client,
        hopGPTRequest,
        transformer,
        res,
        sessionId,
        anthropicRequest,
      );
    }
  } catch (error) {
    handleError(error, res);
  }
});

async function handleStreamingRequest(
  client,
  hopGPTRequest,
  transformer,
  res,
  _req,
  sessionId,
  anthropicRequest,
) {
  // Stage SSE headers but do NOT flush them yet. If sendMessage() throws before
  // any HopGPT byte arrives (expired creds, Cloudflare block, network error),
  // headers stay unsent so handleError() can return a proper HTTP 4xx/5xx JSON
  // body — matching the real Anthropic API. Once HopGPT responds successfully,
  // the first res.write() inside pipeSSEStream flushes headers implicitly.
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  log.debug('Starting streaming response', {
    sessionId: `${sessionId.slice(0, 8)}...`,
  });

  const abortController = new AbortController();
  let clientDisconnected = false;

  // Listen for client disconnect to abort upstream request
  // NOTE: Must use res.on('close'), NOT req.on('close')
  // req 'close' fires when request body is fully read (immediately for POST)
  // res 'close' fires when the response connection is actually closed
  const onClose = () => {
    if (!res.writableEnded) {
      clientDisconnected = true;
      log.debug('Client disconnected, aborting stream', {
        sessionId: `${sessionId.slice(0, 8)}...`,
      });
      abortController.abort();
    }
  };
  res.on('close', onClose);

  let hopGPTResponse;
  const idlePingTimer = setTimeout(() => {
    if (!clientDisconnected && !res.writableEnded && !res.destroyed) {
      writeSSEEvents(res, transformer.createMessageStart());
    }
  }, getStreamIdlePingDelayMs());
  try {
    hopGPTResponse = await client.sendMessage(hopGPTRequest, {
      stream: true,
      signal: abortController.signal,
    });
  } catch (error) {
    clearTimeout(idlePingTimer);
    // Pre-stream failure — headers not yet flushed, so we can return a proper
    // HTTP error response via the shared error handler.
    res.removeListener('close', onClose);
    if (clientDisconnected || res.writableEnded || res.destroyed) {
      log.debug('Suppressing pre-stream error for disconnected client', {
        error: error.message,
      });
      return;
    }
    if (res.headersSent) {
      res.write(
        formatSSEEvent({
          event: 'error',
          data: {
            type: 'error',
            error: {
              type: 'api_error',
              message: error.message,
            },
          },
        }),
      );
      res.end();
      return;
    }
    // Clear the staged SSE headers so handleError can set application/json.
    res.removeHeader('Content-Type');
    res.removeHeader('Cache-Control');
    res.removeHeader('Connection');
    res.removeHeader('X-Accel-Buffering');
    handleError(error, res);
    return;
  }
  clearTimeout(idlePingTimer);

  try {
    writeSSEEvents(res, transformer.createMessageStart());

    const pipeResult = await pipeSSEStream(
      hopGPTResponse,
      res,
      (event) => {
        return transformer.transformEvent(event);
      },
      abortController.signal,
      {
        autoEndOnMessageStop: true,
        onToolUseIdle: () => transformer.forceEnd(),
        toolUseIdleCloseMs: getToolBatchIdleCloseMs(),
      },
    );
    if (pipeResult?.stoppedOnMessageStop && !abortController.signal.aborted) {
      abortController.abort();
    }

    // HopGPT can end without a final event; Anthropic clients still need message_stop.
    if (!transformer.hasEnded() && !clientDisconnected && !res.writableEnded) {
      const cleanupEvents = transformer.forceEnd();
      for (const evt of cleanupEvents) {
        res.write(`event: ${evt.event}\n`);
        res.write(`data: ${JSON.stringify(evt.data)}\n\n`);
      }
    }

    // Update state before ending the response so fast follow-up requests see it.
    persistConversationTurn(sessionId, anthropicRequest, transformer, null, hopGPTRequest);

    if (!clientDisconnected && !res.writableEnded) {
      res.end();
    }
  } catch (error) {
    // Mid-stream failure. Headers are already flushed (first HopGPT byte
    // arrived), so we can't switch to HTTP JSON — emit an SSE error event
    // instead.
    if (clientDisconnected || res.writableEnded || res.destroyed) {
      log.debug('Suppressing error for disconnected client', {
        error: error.message,
      });
      return;
    }

    const errorEvent = {
      event: 'error',
      data: {
        type: 'error',
        error: {
          type: 'api_error',
          message: error.message,
        },
      },
    };
    res.write(formatSSEEvent(errorEvent));
    res.end();
  } finally {
    res.removeListener('close', onClose);
  }
}

function getStreamIdlePingDelayMs() {
  const parsed = Number.parseInt(process.env.HOPGPT_STREAM_IDLE_PING_DELAY_MS ?? '', 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_STREAM_IDLE_PING_DELAY_MS;
}

function getToolBatchIdleCloseMs() {
  const parsed = Number.parseInt(process.env.HOPGPT_TOOL_BATCH_IDLE_CLOSE_MS ?? '', 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_TOOL_BATCH_IDLE_CLOSE_MS;
}

function writeSSEEvents(res, events) {
  for (const event of events) {
    res.write(formatSSEEvent(event));
  }
  if (events.length > 0 && typeof res.flush === 'function') {
    res.flush();
  }
}

async function handleNonStreamingRequest(
  client,
  hopGPTRequest,
  transformer,
  res,
  sessionId,
  anthropicRequest,
) {
  log.debug('Starting non-streaming response', {
    sessionId: `${sessionId.slice(0, 8)}...`,
  });
  const hopGPTResponse = await client.sendMessage(hopGPTRequest, {
    stream: false,
  });

  await parseSSEStream(hopGPTResponse, (event) => {
    transformer.transformEvent(event);
  });

  // Require final:true. If the stream ended without it, HopGPT gave us an
  // incomplete response — fail loudly instead of emitting empty content.
  if (!transformer.hasEnded()) {
    throw new HopGPTError(502, 'Stream ended without final event', null);
  }

  const response = transformer.buildNonStreamingResponse();
  // Update state before sending the response so fast follow-up requests see it.
  persistConversationTurn(sessionId, anthropicRequest, transformer, response, hopGPTRequest);
  res.json(response);
}

function persistConversationTurn(
  sessionId,
  anthropicRequest,
  transformer,
  response = null,
  hopGPTRequest = null,
) {
  const nextState = {
    ...transformer.getConversationState(),
    toolPromptHash: hopGPTRequest?.__hoproxyToolPromptHash || null,
  };
  if (
    nextState?.lastAssistantMessageId ||
    nextState?.conversationId ||
    nextState?.systemPrompt ||
    nextState?.toolPromptHash
  ) {
    updateConversationState(sessionId, nextState);
    const assistantContent = response?.content || transformer.getAssistantContentBlocks();
    rememberConversationTurn(sessionId, anthropicRequest, {
      role: 'assistant',
      content: assistantContent || [],
    });
  }
}

function validateRequest(request) {
  if (!request.model) {
    return 'model is required';
  }

  if (!request.messages || !Array.isArray(request.messages)) {
    return 'messages array is required';
  }

  if (request.messages.length === 0) {
    return 'messages array cannot be empty';
  }

  for (let i = 0; i < request.messages.length; i++) {
    const msg = request.messages[i];

    if (!msg.role) {
      return `messages[${i}].role is required`;
    }

    if (!['user', 'assistant'].includes(msg.role)) {
      return `messages[${i}].role must be 'user' or 'assistant'`;
    }

    if (msg.content === undefined || msg.content === null) {
      return `messages[${i}].content is required`;
    }
  }

  return null;
}

function normalizeConversationState(state) {
  if (!state || typeof state !== 'object') {
    return null;
  }

  return {
    conversationId: state.conversationId || state.conversation_id || null,
    lastAssistantMessageId: state.lastAssistantMessageId || state.last_assistant_message_id || null,
    systemPrompt: state.systemPrompt || state.system_prompt || state.system || null,
    toolPromptHash: state.toolPromptHash || state.tool_prompt_hash || null,
  };
}

function mergeConversationStates(storedState, requestState) {
  if (!storedState && !requestState) {
    return null;
  }

  if (!storedState) {
    return requestState;
  }

  if (!requestState) {
    return storedState;
  }

  return {
    conversationId: requestState.conversationId ?? storedState.conversationId,
    lastAssistantMessageId:
      requestState.lastAssistantMessageId ?? storedState.lastAssistantMessageId,
    systemPrompt: requestState.systemPrompt ?? storedState.systemPrompt,
    toolPromptHash: requestState.toolPromptHash ?? storedState.toolPromptHash,
  };
}

function handleError(error, res) {
  log.error('Request failed', {
    error: error.message,
    type: error.constructor.name,
  });

  if (error instanceof AuthError) {
    const resolved = mapAuthErrorResponse(error);
    if (resolved.retryAfterSeconds) {
      res.setHeader('Retry-After', resolved.retryAfterSeconds);
    }
    return res.status(resolved.statusCode).json(resolved.payload);
  }

  if (error instanceof HopGPTError) {
    const statusCode = error.statusCode >= 400 && error.statusCode < 600 ? error.statusCode : 502;
    const responseBody = typeof error.responseBody === 'string' ? error.responseBody : '';
    const resolved = mapErrorResponse({
      statusCode,
      message: error.message,
      responseBody,
      fallbackType: error.toAnthropicError().error?.type || 'api_error',
      retryAfterMs: error.retryAfterMs,
    });

    if (resolved.retryAfterSeconds) {
      res.setHeader('Retry-After', resolved.retryAfterSeconds);
    }
    return res.status(resolved.statusCode).json(resolved.payload);
  }

  const fallback = mapErrorResponse({
    statusCode: 500,
    message: error?.message,
    responseBody: '',
    fallbackType: 'api_error',
    retryAfterMs: null,
  });
  if (fallback.retryAfterSeconds) {
    res.setHeader('Retry-After', fallback.retryAfterSeconds);
  }
  res.status(fallback.statusCode).json(fallback.payload);
}

export default router;

function extractToolNames(tools) {
  if (!Array.isArray(tools)) {
    return [];
  }

  return tools
    .map((tool) => tool?.name || tool?.function?.name || tool?.custom?.name)
    .filter((name) => typeof name === 'string' && name.trim().length > 0)
    .map((name) => name.trim());
}

function shouldStopOnToolUse(mcpPassthrough, hasTools, toolChoiceConfig, isStreaming) {
  if (mcpPassthrough) {
    return false;
  }

  if (!hasTools) {
    return false;
  }

  if (toolChoiceConfig.allowTools === false) {
    return false;
  }

  return isStreaming || toolChoiceConfig.disableParallelToolUse === true;
}

function mapErrorResponse({ statusCode, message, responseBody, fallbackType, retryAfterMs }) {
  const errorText = extractErrorText(message, responseBody);
  const errorTextLower = errorText.toLowerCase();
  const retryAfterSeconds = retryAfterMs
    ? Math.ceil(retryAfterMs / 1000)
    : parseRetryAfterSeconds(errorText);

  if (
    statusCode === 401 ||
    errorTextLower.includes('unauthorized') ||
    errorTextLower.includes('unauthenticated')
  ) {
    return buildErrorResponse(401, 'authentication_error', errorText, retryAfterSeconds);
  }

  if (
    statusCode === 403 ||
    errorTextLower.includes('forbidden') ||
    errorTextLower.includes('permission')
  ) {
    return buildErrorResponse(403, 'permission_error', errorText, retryAfterSeconds);
  }

  if (statusCode === 429 || isRateLimitMessage(errorTextLower)) {
    return buildErrorResponse(429, 'rate_limit_error', errorText, retryAfterSeconds);
  }

  if (statusCode === 400 || isInvalidRequestMessage(errorTextLower)) {
    return buildErrorResponse(400, 'invalid_request_error', errorText, retryAfterSeconds);
  }

  const resolvedStatus = statusCode >= 400 && statusCode < 600 ? statusCode : 502;
  const resolvedType =
    fallbackType || (resolvedStatus >= 500 ? 'api_error' : 'invalid_request_error');
  return buildErrorResponse(resolvedStatus, resolvedType, errorText, retryAfterSeconds);
}

function mapAuthErrorResponse(error) {
  const errorMapping = getAuthErrorMapping(error);

  return mapErrorResponse({
    statusCode: errorMapping.statusCode,
    message: error.message,
    responseBody: '',
    fallbackType: errorMapping.errorType,
    retryAfterMs: null,
  });
}

function getAuthErrorMapping(error) {
  if (error instanceof RefreshTokenExpiredError || error instanceof TokenRefreshError) {
    return { statusCode: 401, errorType: 'authentication_error' };
  }

  if (error instanceof CloudflareBlockedError) {
    return { statusCode: 503, errorType: 'api_error' };
  }

  if (error instanceof NetworkError) {
    return { statusCode: 502, errorType: 'api_error' };
  }

  return { statusCode: 500, errorType: 'api_error' };
}

function buildErrorResponse(statusCode, errorType, message, retryAfterSeconds) {
  const payload = {
    type: 'error',
    error: {
      type: errorType,
      message: message || 'Internal server error',
    },
  };

  if (retryAfterSeconds) {
    payload.error.retry_after_seconds = retryAfterSeconds;
  }

  return {
    statusCode,
    payload,
    retryAfterSeconds,
  };
}

function extractErrorText(message, responseBody) {
  if (typeof responseBody === 'string' && responseBody.trim()) {
    const parsed = parseErrorMessageFromBody(responseBody);
    if (parsed) {
      return parsed;
    }
  }

  if (typeof message === 'string' && message.trim()) {
    return message;
  }

  return 'Internal server error';
}

function parseErrorMessageFromBody(body) {
  const trimmed = body.trim();
  if (!trimmed) {
    return null;
  }

  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed?.error?.message === 'string') {
      return parsed.error.message;
    }
    if (typeof parsed?.message === 'string') {
      return parsed.message;
    }
    if (typeof parsed === 'string') {
      return parsed;
    }
  } catch (_error) {
    return trimmed;
  }

  return null;
}

function isRateLimitMessage(text) {
  return (
    text.includes('rate limit') ||
    text.includes('too many requests') ||
    text.includes('resource_exhausted') ||
    text.includes('quota') ||
    text.includes('retry after')
  );
}

function isInvalidRequestMessage(text) {
  return (
    text.includes('invalid request') ||
    text.includes('invalid_argument') ||
    text.includes('invalid input') ||
    text.includes('bad request')
  );
}

function parseRetryAfterSeconds(text) {
  if (!text) {
    return null;
  }

  const retryMatch = text.match(
    /retry\s*after\s*([\d.]+)\s*(ms|s|sec|secs|seconds|m|minutes|h|hours)?/i,
  );
  if (retryMatch) {
    const value = Number.parseFloat(retryMatch[1]);
    const unit = (retryMatch[2] || 's').toLowerCase();
    if (Number.isFinite(value)) {
      if (unit.startsWith('ms')) return Math.ceil(value / 1000);
      if (unit.startsWith('m')) return Math.ceil(value * 60);
      if (unit.startsWith('h')) return Math.ceil(value * 3600);
      return Math.ceil(value);
    }
  }

  const durationMatch = text.match(/(\d+)h(\d+)m(\d+)s|(\d+)m(\d+)s|(\d+)s/i);
  if (durationMatch) {
    if (durationMatch[1]) {
      const hours = Number.parseInt(durationMatch[1], 10);
      const minutes = Number.parseInt(durationMatch[2], 10);
      const seconds = Number.parseInt(durationMatch[3], 10);
      return hours * 3600 + minutes * 60 + seconds;
    }
    if (durationMatch[4]) {
      const minutes = Number.parseInt(durationMatch[4], 10);
      const seconds = Number.parseInt(durationMatch[5], 10);
      return minutes * 60 + seconds;
    }
    if (durationMatch[6]) {
      return Number.parseInt(durationMatch[6], 10);
    }
  }

  return null;
}
