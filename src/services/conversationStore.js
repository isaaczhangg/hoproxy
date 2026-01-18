import { v4 as uuidv4 } from 'uuid';
import { loggers } from '../utils/logger.js';

const log = loggers.session;
const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000;

const sessionStore = new Map();

function normalizeId(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function getTtlMs() {
  const configured = Number.parseInt(process.env.CONVERSATION_TTL_MS, 10);
  const isValidTtl = Number.isFinite(configured) && configured > 0;

  return isValidTtl ? configured : DEFAULT_TTL_MS;
}

function cleanupExpiredSessions(now = Date.now()) {
  const ttlMs = getTtlMs();
  let expiredCount = 0;
  for (const [sessionId, entry] of sessionStore.entries()) {
    if (now - entry.lastTouchedAt > ttlMs) {
      sessionStore.delete(sessionId);
      expiredCount++;
    }
  }
  if (expiredCount > 0) {
    log.debug(`Cleaned up ${expiredCount} expired sessions`, { remaining: sessionStore.size });
  }
}

function extractSessionIdFromMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object') {
    return null;
  }
  return normalizeId(metadata.session_id) ||
    normalizeId(metadata.sessionId) ||
    normalizeId(metadata.conversation_id) ||
    normalizeId(metadata.conversationId);
}

export function resolveSessionId(req, requestBody) {
  const headerSessionId = normalizeId(req.get('x-session-id')) ||
    normalizeId(req.get('x-sessionid'));
  const metadataSessionId = extractSessionIdFromMetadata(requestBody?.metadata);
  const sessionId = headerSessionId || metadataSessionId;

  if (sessionId) {
    log.debug('Using provided session ID', { sessionId: sessionId.slice(0, 8) + '...' });
    return { sessionId, isGenerated: false };
  }

  const newSessionId = uuidv4();
  log.debug('Generated new session ID', { sessionId: newSessionId.slice(0, 8) + '...' });
  return { sessionId: newSessionId, isGenerated: true };
}

export function shouldResetConversation(req, requestBody) {
  // Check header for reset flag
  const headerReset = normalizeId(req.get('x-conversation-reset'));
  if (headerReset && headerReset.toLowerCase() === 'true') {
    return true;
  }

  // Check metadata for various reset flags
  const metadata = requestBody?.metadata;
  if (!metadata) {
    return false;
  }

  return metadata.conversation_reset === true ||
    metadata.reset === true ||
    metadata.new_conversation === true;
}

export function getConversationState(sessionId) {
  const normalizedSessionId = normalizeId(sessionId);
  if (!normalizedSessionId) {
    return null;
  }

  cleanupExpiredSessions();

  const entry = sessionStore.get(normalizedSessionId);
  if (!entry) {
    log.debug('No existing conversation state', { sessionId: normalizedSessionId.slice(0, 8) + '...' });
    return null;
  }

  entry.lastTouchedAt = Date.now();
  log.debug('Retrieved conversation state', {
    sessionId: normalizedSessionId.slice(0, 8) + '...',
    hasConversationId: !!entry.conversationId,
    hasLastMessageId: !!entry.lastAssistantMessageId
  });
  return {
    conversationId: entry.conversationId || null,
    lastAssistantMessageId: entry.lastAssistantMessageId || null,
    systemPrompt: entry.systemPrompt || null
  };
}

export function updateConversationState(sessionId, state) {
  const normalizedSessionId = normalizeId(sessionId);
  if (!normalizedSessionId || !state) {
    return;
  }

  cleanupExpiredSessions();

  const now = Date.now();
  const isNew = !sessionStore.has(normalizedSessionId);
  const entry = sessionStore.get(normalizedSessionId) || { createdAt: now };
  const conversationId = normalizeId(state.conversationId);
  const lastAssistantMessageId = normalizeId(state.lastAssistantMessageId);
  const systemPrompt = normalizeId(state.systemPrompt);

  if (conversationId) {
    entry.conversationId = conversationId;
  }
  if (lastAssistantMessageId) {
    entry.lastAssistantMessageId = lastAssistantMessageId;
  }
  if (systemPrompt) {
    entry.systemPrompt = systemPrompt;
  }

  entry.lastTouchedAt = now;
  sessionStore.set(normalizedSessionId, entry);
  
  log.debug(isNew ? 'Created conversation state' : 'Updated conversation state', {
    sessionId: normalizedSessionId.slice(0, 8) + '...',
    hasConversationId: !!conversationId,
    hasLastMessageId: !!lastAssistantMessageId,
    totalSessions: sessionStore.size
  });
}

export function resetConversationState(sessionId) {
  const normalizedSessionId = normalizeId(sessionId);
  if (!normalizedSessionId) {
    return;
  }
  const existed = sessionStore.has(normalizedSessionId);
  sessionStore.delete(normalizedSessionId);
  if (existed) {
    log.info('Reset conversation state', { sessionId: normalizedSessionId.slice(0, 8) + '...' });
  }
}
