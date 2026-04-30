import { describe, it, expect } from 'vitest';
import {
  transformAnthropicToHopGPT,
  transformTools,
  transformToolChoice,
  extractThinkingConfig,
  buildConversationText,
  hasThinkingContent,
  extractThinkingSignature,
  normalizeSystemPrompt
} from '../../src/transformers/anthropicToHopGPT.js';
import { readFixture } from '../helpers/fixtures.js';

describe('anthropicToHopGPT transformers', () => {
  it('transforms tool definitions and tool_choice', () => {
    const tools = [
      {
        name: 'search',
        description: 'Search tool',
        input_schema: { type: 'object', properties: { q: { type: 'string' } } }
      }
    ];
    const transformed = transformTools(tools);

    expect(transformed).toEqual([
      {
        name: 'search',
        description: 'Search tool',
        input_schema: { type: 'object', properties: { q: { type: 'string' } }, required: [] },
        parameters: { type: 'object', properties: { q: { type: 'string' } }, required: [] }
      }
    ]);

    expect(transformToolChoice('auto')).toEqual({ type: 'auto' });
    expect(transformToolChoice('any')).toEqual({ type: 'required' });
    expect(transformToolChoice('none')).toEqual({ type: 'none' });
    expect(transformToolChoice({ type: 'tool', name: 'search' })).toEqual({
      type: 'function',
      function: { name: 'search' }
    });
  });

  it('handles multi-turn conversation text and image content', async () => {
    const request = await readFixture('anthropic-request-basic.json');
    const result = transformAnthropicToHopGPT(request);

    expect(result.text).toContain('System: You are a helpful assistant.');
    expect(result.text).toContain('Human: Hello');
    expect(result.text).toContain('Assistant: Hi there.');
    expect(result.text).toContain('Human: Check this');
    expect(result.parentMessageId).toBe('00000000-0000-0000-0000-000000000000');
    expect(result.image_urls).toHaveLength(2);
    expect(result.image_urls[0].image_url.url).toMatch(/^data:image\/png;base64,/);
    expect(result.image_urls[1].image_url.url).toBe('https://example.com/cat.png');
  });

  it('threads conversations with provided parent IDs', () => {
    const request = {
      model: 'claude-sonnet-4-5-thinking',
      system: 'System A',
      messages: [
        { role: 'user', content: 'First' },
        { role: 'assistant', content: 'Second' },
        { role: 'user', content: 'Latest' }
      ]
    };

    const result = transformAnthropicToHopGPT(request, {
      lastAssistantMessageId: 'assistant-1',
      systemPrompt: 'System A'
    });

    expect(result.parentMessageId).toBe('assistant-1');
    expect(result.text).toBe('Latest');
  });

  it('extracts thinking configuration and signatures', async () => {
    const request = await readFixture('anthropic-request-tools.json');
    const thinkingConfig = extractThinkingConfig(request);

    expect(thinkingConfig).toEqual({ enabled: true, budgetTokens: 256 });

    const message = {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'Thoughts', signature: 'sig-123' },
        { type: 'text', text: 'Answer' }
      ]
    };

    expect(hasThinkingContent(message)).toBe(true);
    expect(extractThinkingSignature(message)).toBe('sig-123');
  });

  it('builds conversation text without thinking blocks', () => {
    const messages = [
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'Skip me' },
          { type: 'text', text: 'Visible' }
        ]
      },
      { role: 'user', content: 'Next' }
    ];

    const text = buildConversationText(messages, 'System Prompt');
    expect(text).toContain('System: System Prompt');
    expect(text).toContain('Assistant: Visible');
    expect(text).toContain('Human: Next');
    expect(text).not.toContain('Skip me');
  });

  it('normalizes system prompts from array blocks', () => {
    const systemPrompt = normalizeSystemPrompt([
      { type: 'text', text: 'Line 1' },
      { type: 'text', text: 'Line 2' }
    ]);

    expect(systemPrompt).toBe('Line 1\nLine 2');
  });

  it('always appends tool_call stop sequence', () => {
    const request = {
      model: 'claude-sonnet-4-5-thinking',
      messages: [{ role: 'user', content: 'Hello' }]
    };

    const result = transformAnthropicToHopGPT(request);

    // NOTE: Use a sentinel that won't match tool markup to avoid truncating tool calls.
    expect(result.stop_sequences).toEqual(['<|hopgpt_tool_stop|>']);
  });

  it('treats stop as an alias for stop_sequences and appends tool_call stop', () => {
    const request = {
      model: 'claude-sonnet-4-5-thinking',
      messages: [{ role: 'user', content: 'Hello' }],
      stop: ['<end>']
    };

    const result = transformAnthropicToHopGPT(request);

    expect(result.stop_sequences).toEqual(['<end>', '<|hopgpt_tool_stop|>']);
  });

  // Regression: HopGPT's Bedrock backend rejects requests with
  // "max_tokens must be greater than thinking.budget_tokens" when max_tokens
  // is small relative to the implicit thinking budget assigned by "reasoning_effort: high".
  // Empirically, a threshold around 4-8K is required. Boost max_tokens to at
  // least 8192 when thinking is enabled so Bedrock doesn't reject the request.
  it('raises max_tokens floor to 8192 when thinking is enabled and max_tokens is small', () => {
    const request = {
      model: 'claude-opus-4-5',
      max_tokens: 2048,
      messages: [{ role: 'user', content: 'Hello' }]
    };

    const result = transformAnthropicToHopGPT(request);

    expect(result.reasoning_effort).toBe('high');
    expect(result.max_tokens).toBeGreaterThanOrEqual(8192);
  });

  it('preserves max_tokens above the thinking floor', () => {
    const request = {
      model: 'claude-opus-4-5',
      max_tokens: 32000,
      messages: [{ role: 'user', content: 'Hello' }]
    };

    const result = transformAnthropicToHopGPT(request);

    expect(result.reasoning_effort).toBe('high');
    expect(result.max_tokens).toBe(32000);
  });

  it('does not raise max_tokens when thinking is not enabled', () => {
    const request = {
      model: 'claude-haiku-4-5',
      max_tokens: 512,
      messages: [{ role: 'user', content: 'Hello' }]
    };

    const result = transformAnthropicToHopGPT(request);

    expect(result.reasoning_effort).toBeUndefined();
    expect(result.max_tokens).toBe(512);
  });
});
