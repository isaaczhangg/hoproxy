import { loggers } from '../utils/logger.js';

const log = loggers.model;

// Pinned parameter set captured from chat.ai.jh.edu's GPT-5.5 web client
// (POST /api/agents/chat/AzureOpenAI). The web UI only serializes these four
// model parameters and omits everything else, letting the server apply its
// "System" defaults — Temperature 1.0, Top P 1.0, Frequency/Presence Penalty 0,
// Verbosity None, Responses API off, unbounded context/output. GPT-5.5 is a
// reasoning model on this endpoint, so explicit sampling values can be rejected;
// matching the web client means NOT sending them.
const PINNED_REASONING_EFFORT = 'xhigh';
const PINNED_REASONING_SUMMARY = 'detailed';
const PINNED_IMAGE_DETAIL = 'high';

// Fields the Claude-oriented transformer adds that the GPT-5.5 web client never
// sends. Sampling params can trip the reasoning model; `thinking` (a Bedrock
// budget object) and `ephemeralAgent` belong to other endpoints entirely.
const STRIPPED_FIELDS = [
  'temperature',
  'top_p',
  'top_k',
  'frequency_penalty',
  'presence_penalty',
  'thinking',
  'ephemeralAgent',
];

// Normalize the Claude-shaped body the base transformer produced into the exact
// shape HopGPT's GPT-5.5 web client sends. Mutates and returns the request.
export function applyAzureOpenAIDefaults(request) {
  if (!request || typeof request !== 'object') {
    return request;
  }

  for (const field of STRIPPED_FIELDS) {
    delete request[field];
  }

  request.resendFiles = false;
  request.imageDetail = PINNED_IMAGE_DETAIL;
  request.reasoning_effort = PINNED_REASONING_EFFORT;
  request.reasoning_summary = PINNED_REASONING_SUMMARY;

  log.debug('Applied GPT-5.5 (AzureOpenAI) defaults', {
    reasoning_effort: request.reasoning_effort,
    reasoning_summary: request.reasoning_summary,
  });

  return request;
}
