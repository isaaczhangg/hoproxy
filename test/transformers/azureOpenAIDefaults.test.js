import { describe, expect, it } from 'vitest';
import { applyAzureOpenAIDefaults } from '../../src/transformers/azureOpenAIDefaults.js';

function baseGptRequest() {
  // Shape the Claude-oriented transformer produces before normalization.
  return {
    text: 'hi',
    sender: 'User',
    endpoint: 'AzureOpenAI',
    endpointType: 'custom',
    model: 'gpt-5.5',
    modelDisplayLabel: 'GPT',
    key: 'never',
    max_tokens: 8192,
    stop_sequences: ['<|hopgpt_tool_stop|>'],
    ephemeralAgent: { mcp: [], web_search: false },
    temperature: 0.2,
    top_p: 0.9,
    top_k: 40,
    frequency_penalty: 0.5,
    presence_penalty: 0.5,
    thinking: { type: 'enabled', budget_tokens: 4096 },
  };
}

describe('applyAzureOpenAIDefaults', () => {
  it('pins the GPT-5.5 web-client parameter set', () => {
    const result = applyAzureOpenAIDefaults(baseGptRequest());

    expect(result.reasoning_effort).toBe('xhigh');
    expect(result.reasoning_summary).toBe('detailed');
    expect(result.imageDetail).toBe('high');
    expect(result.resendFiles).toBe(false);
  });

  it('strips sampling parameters the reasoning model never receives', () => {
    const result = applyAzureOpenAIDefaults(baseGptRequest());

    expect(result.temperature).toBeUndefined();
    expect(result.top_p).toBeUndefined();
    expect(result.top_k).toBeUndefined();
    expect(result.frequency_penalty).toBeUndefined();
    expect(result.presence_penalty).toBeUndefined();
  });

  it('strips the Claude-only thinking budget and ephemeralAgent fields', () => {
    const result = applyAzureOpenAIDefaults(baseGptRequest());

    expect(result.thinking).toBeUndefined();
    expect(result.ephemeralAgent).toBeUndefined();
  });

  it('preserves routing, output budget, and tool stop fields', () => {
    const result = applyAzureOpenAIDefaults(baseGptRequest());

    expect(result.endpoint).toBe('AzureOpenAI');
    expect(result.model).toBe('gpt-5.5');
    expect(result.modelDisplayLabel).toBe('GPT');
    expect(result.max_tokens).toBe(8192);
    expect(result.stop_sequences).toEqual(['<|hopgpt_tool_stop|>']);
  });

  it('pins reasoning settings even when the source request had none', () => {
    const result = applyAzureOpenAIDefaults({
      text: 'hi',
      endpoint: 'AzureOpenAI',
      model: 'gpt-5.5',
    });

    expect(result.reasoning_effort).toBe('xhigh');
    expect(result.reasoning_summary).toBe('detailed');
  });

  it('returns non-object input unchanged', () => {
    expect(applyAzureOpenAIDefaults(null)).toBeNull();
    expect(applyAzureOpenAIDefaults(undefined)).toBeUndefined();
  });
});
