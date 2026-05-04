import { loggers } from './logger.js';

const log = loggers.model;

// Canonical and alias IDs stay Anthropic-compatible for clients like OpenCode;
// -thinking variants are accepted only as input aliases.
const MODEL_MAPPINGS = Object.freeze([
  {
    canonical: 'claude-opus-4-5',
    hopgpt: 'claude-opus-4.5',
    aliases: ['claude-opus-4.5'],
  },
  {
    canonical: 'claude-sonnet-4-5',
    hopgpt: 'claude-sonnet-4.5',
    aliases: ['claude-sonnet-4.5'],
  },
  {
    canonical: 'claude-haiku-4-5',
    hopgpt: 'claude-haiku-4.5',
    aliases: ['claude-haiku-4.5'],
  },
]);

const VERSION_SUFFIX_REGEX = /-(\d{8}|\d{4}-\d{2}-\d{2}|latest|stable)$/;

function normalizeModelName(value) {
  return value.trim().toLowerCase().replace(/_/g, '-');
}

function stripProviderPrefix(modelName) {
  if (typeof modelName !== 'string') {
    return modelName;
  }

  const trimmed = modelName.trim();
  if (!trimmed.includes('/')) {
    return trimmed;
  }

  const parts = trimmed.split('/').filter(Boolean);
  if (parts.length > 0) {
    return parts[parts.length - 1];
  }
  return trimmed;
}

function addModelVariants(variants, name) {
  if (!name) return;
  variants.add(name);

  if (name.includes('4.5')) {
    variants.add(name.replace('4.5', '4-5'));
  }
  if (name.includes('4-5')) {
    variants.add(name.replace('4-5', '4.5'));
  }

  if (name.endsWith('-thinking')) {
    variants.add(name.replace(/-thinking$/, ''));
  } else if (name.startsWith('claude-')) {
    variants.add(`${name}-thinking`);
  }
}

function buildCandidateSet(modelName) {
  const normalized = normalizeModelName(modelName);
  const stripped = normalized.replace(VERSION_SUFFIX_REGEX, '');
  const candidates = new Set();

  addModelVariants(candidates, normalized);
  if (stripped !== normalized) {
    addModelVariants(candidates, stripped);
  }

  return candidates;
}

const MODEL_ALIAS_MAP = new Map();
for (const mapping of MODEL_MAPPINGS) {
  const aliasSources = [mapping.canonical, ...mapping.aliases];
  for (const alias of aliasSources) {
    const candidates = buildCandidateSet(alias);
    for (const candidate of candidates) {
      MODEL_ALIAS_MAP.set(candidate, mapping);
    }
  }
}

export function resolveModelMapping(modelName) {
  if (typeof modelName !== 'string' || modelName.trim() === '') {
    return {
      hopgptModel: modelName,
      responseModel: modelName,
      mapped: false,
    };
  }

  const strippedModel = stripProviderPrefix(modelName);
  const candidates = buildCandidateSet(strippedModel);
  for (const candidate of candidates) {
    const mapping = MODEL_ALIAS_MAP.get(candidate);
    if (mapping) {
      log.debug('Model mapped', {
        input: modelName,
        hopgpt: mapping.hopgpt,
        response: mapping.canonical,
      });
      return {
        hopgptModel: mapping.hopgpt,
        responseModel: mapping.canonical,
        mapped: true,
      };
    }
  }

  log.debug('Model not mapped, using as-is', { model: modelName });
  return {
    hopgptModel: strippedModel,
    responseModel: strippedModel,
    mapped: false,
  };
}

export { MODEL_MAPPINGS, stripProviderPrefix };
