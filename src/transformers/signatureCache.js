const DEFAULT_CACHE_TTL_MS = 2 * 60 * 60 * 1000;
export const MIN_SIGNATURE_LENGTH = 50;

const toolSignatureCache = new Map();
const thinkingSignatureCache = new Map();

function resolveCacheTtlMs() {
  const configured = Number.parseInt(process.env.SIGNATURE_CACHE_TTL_MS, 10);
  if (Number.isFinite(configured) && configured > 0) {
    return configured;
  }
  return DEFAULT_CACHE_TTL_MS;
}

function isValidSignature(signature) {
  return typeof signature === 'string' && signature.length >= MIN_SIGNATURE_LENGTH;
}

function cleanupExpired(cache, now = Date.now()) {
  for (const [key, entry] of cache.entries()) {
    if (!entry || entry.expiresAt <= now) {
      cache.delete(key);
    }
  }
}

export function cacheToolSignature(toolUseId, signature) {
  if (!toolUseId || !isValidSignature(signature)) {
    return;
  }
  cleanupExpired(toolSignatureCache);
  const ttlMs = resolveCacheTtlMs();
  toolSignatureCache.set(toolUseId, {
    signature,
    expiresAt: Date.now() + ttlMs,
  });
}

export function getCachedToolSignature(toolUseId) {
  if (!toolUseId) {
    return null;
  }
  const entry = toolSignatureCache.get(toolUseId);
  if (!entry) {
    return null;
  }
  if (entry.expiresAt <= Date.now()) {
    toolSignatureCache.delete(toolUseId);
    return null;
  }
  return entry.signature;
}

export function cacheThinkingSignature(signature, family = 'claude') {
  if (!isValidSignature(signature)) {
    return;
  }
  cleanupExpired(thinkingSignatureCache);
  const ttlMs = resolveCacheTtlMs();
  thinkingSignatureCache.set(signature, {
    family,
    expiresAt: Date.now() + ttlMs,
  });
}

export function getCachedThinkingSignatureFamily(signature) {
  if (!signature) {
    return null;
  }
  const entry = thinkingSignatureCache.get(signature);
  if (!entry) {
    return null;
  }
  if (entry.expiresAt <= Date.now()) {
    thinkingSignatureCache.delete(signature);
    return null;
  }
  return entry.family || null;
}

export function cleanupSignatureCache() {
  const now = Date.now();
  cleanupExpired(toolSignatureCache, now);
  cleanupExpired(thinkingSignatureCache, now);
}

export function getSignatureCacheSize() {
  cleanupSignatureCache();
  return {
    tool: toolSignatureCache.size,
    thinking: thinkingSignatureCache.size,
  };
}
