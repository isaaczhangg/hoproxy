import { Router } from 'express';
import { loggers } from '../utils/logger.js';
import { MODEL_MAPPINGS, resolveModelMapping, stripProviderPrefix } from '../utils/modelMapping.js';

const log = loggers.model;
const router = Router();

// Model IDs must not include "-thinking"; OpenCode validates them against
// Anthropic's public model list and rejects synthetic thinking variants.
const CANONICAL_MODELS = [
  {
    id: 'gpt-5-5',
    type: 'model',
    created_at: '2026-01-01T00:00:00Z',
    display_name: 'GPT 5.5',
  },
  {
    id: 'claude-opus-4-5',
    type: 'model',
    created_at: '2025-01-01T00:00:00Z',
    display_name: 'Claude Opus 4.5',
  },
  {
    id: 'claude-sonnet-4-5',
    type: 'model',
    created_at: '2025-01-01T00:00:00Z',
    display_name: 'Claude Sonnet 4.5',
  },
  {
    id: 'claude-haiku-4-5',
    type: 'model',
    created_at: '2025-01-01T00:00:00Z',
    display_name: 'Claude Haiku 4.5',
  },
];

const MODEL_BY_ID = new Map(CANONICAL_MODELS.map((model) => [model.id, model]));

function buildAliasModels() {
  const aliasModels = [];
  const seen = new Set(MODEL_BY_ID.keys());

  for (const mapping of MODEL_MAPPINGS) {
    const canonicalModel = MODEL_BY_ID.get(mapping.canonical);
    if (!canonicalModel) continue;

    for (const alias of mapping.aliases) {
      if (seen.has(alias)) continue;
      aliasModels.push({
        ...canonicalModel,
        id: alias,
      });
      seen.add(alias);
    }
  }

  return aliasModels;
}

const AVAILABLE_MODELS = [...CANONICAL_MODELS, ...buildAliasModels()];

const PROVIDER_PREFIXES = ['anthropic'];

function buildProviderPrefixedModels(models) {
  const prefixedModels = [];
  const seen = new Set(models.map((model) => model.id));

  for (const prefix of PROVIDER_PREFIXES) {
    if (!prefix) continue;
    for (const model of models) {
      const prefixedId = `${prefix}/${model.id}`;
      if (seen.has(prefixedId)) continue;
      prefixedModels.push({
        ...model,
        id: prefixedId,
      });
      seen.add(prefixedId);
    }
  }

  return prefixedModels;
}

const ALL_MODELS = [...AVAILABLE_MODELS, ...buildProviderPrefixedModels(AVAILABLE_MODELS)];

router.get('/models', (_req, res) => {
  log.info('Returning model list', {
    count: ALL_MODELS.length,
    modelIds: ALL_MODELS.map((m) => m.id),
  });
  res.json({
    object: 'list',
    data: ALL_MODELS,
  });
});

router.get('/models/*', (req, res) => {
  // Handle model IDs that may contain slashes (e.g., anthropic/claude-opus-4-5)
  const rawId = req.params[0];
  const requestedId = stripProviderPrefix(rawId);
  let model = AVAILABLE_MODELS.find((m) => m.id === requestedId);

  if (!model) {
    const mapping = resolveModelMapping(requestedId);
    if (mapping.mapped) {
      const canonicalModel = MODEL_BY_ID.get(mapping.responseModel);
      if (canonicalModel) {
        model = {
          ...canonicalModel,
          id: requestedId,
        };
      }
    }
  }

  if (!model) {
    log.debug('Model not found', { modelId: rawId });
    return res.status(404).json({
      type: 'error',
      error: {
        type: 'not_found_error',
        message: `Model not found: ${rawId}`,
      },
    });
  }

  log.debug('Model retrieved', { modelId: model.id });
  res.json(model);
});

export default router;
