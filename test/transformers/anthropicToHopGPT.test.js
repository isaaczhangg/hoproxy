import { describe, expect, it } from 'vitest';
import {
  buildConversationText,
  extractThinkingConfig,
  extractThinkingSignature,
  hasThinkingContent,
  normalizeSystemPrompt,
  transformAnthropicToHopGPT,
  transformToolChoice,
  transformTools,
} from '../../src/transformers/anthropicToHopGPT.js';
import { readFixture } from '../helpers/fixtures.js';

describe('anthropicToHopGPT transformers', () => {
  it('transforms tool definitions and tool_choice', () => {
    const tools = [
      {
        name: 'search',
        description: 'Search tool',
        input_schema: { type: 'object', properties: { q: { type: 'string' } } },
      },
    ];
    const transformed = transformTools(tools);

    expect(transformed).toEqual([
      {
        name: 'search',
        description: 'Search tool',
        input_schema: {
          type: 'object',
          properties: { q: { type: 'string' } },
          required: [],
        },
        parameters: {
          type: 'object',
          properties: { q: { type: 'string' } },
          required: [],
        },
      },
    ]);

    expect(transformToolChoice('auto')).toEqual({ type: 'auto' });
    expect(transformToolChoice('any')).toEqual({ type: 'required' });
    expect(transformToolChoice('none')).toEqual({ type: 'none' });
    expect(transformToolChoice({ type: 'tool', name: 'search' })).toEqual({
      type: 'function',
      function: { name: 'search' },
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
        { role: 'user', content: 'Latest' },
      ],
    };

    const result = transformAnthropicToHopGPT(request, {
      conversationId: 'conversation-1',
      lastAssistantMessageId: 'assistant-1',
      systemPrompt: 'System A',
    });

    expect(result.conversationId).toBe('conversation-1');
    expect(result.parentMessageId).toBe('assistant-1');
    expect(result.text).toBe('Latest');
  });

  it('keeps tool results without synthetic continue prompts in threaded conversations', () => {
    const request = {
      model: 'claude-opus-4-5',
      system: 'System A',
      messages: [
        {
          role: 'user',
          content: "can you explore the codebase but don't use subagents?",
        },
        {
          role: 'assistant',
          content: [
            {
              type: 'thinking',
              thinking: 'I should inspect the project metadata before answering.',
              signature: 'x'.repeat(50),
            },
            {
              type: 'tool_use',
              id: 'toolu_read',
              name: 'Read',
              input: { file_path: 'package.json' },
            },
          ],
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_read',
              content: '{"name":"hopgpt-anthropic-proxy"}',
            },
          ],
        },
      ],
    };

    const result = transformAnthropicToHopGPT(request, {
      lastAssistantMessageId: 'assistant-1',
      systemPrompt: 'System A',
    });

    expect(result.parentMessageId).toBe('assistant-1');
    expect(result.text).toContain('<tool_use id="toolu_read" name="Read">');
    expect(result.text).toContain('"file_path": "package.json"');
    expect(result.text).toContain('<tool_result tool_use_id="toolu_read">');
    expect(result.text).toContain('{"name":"hopgpt-anthropic-proxy"}');
    expect(result.text).not.toContain('I should inspect the project metadata');
    expect(result.text).not.toContain('[Tool execution completed.]');
    expect(result.text).not.toContain('[Continue]');
    expect(result.text).not.toContain('can you explore the codebase');
  });

  it('serializes non-text tool result content instead of dropping it', () => {
    const request = {
      model: 'claude-opus-4-5',
      messages: [
        {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'toolu_view',
              name: 'ViewImage',
              input: { path: 'figure.png' },
            },
          ],
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_view',
              content: [
                { type: 'text', text: 'Rendered image:' },
                { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc' } },
              ],
            },
          ],
        },
      ],
    };

    const result = transformAnthropicToHopGPT(request, {
      lastAssistantMessageId: 'assistant-1',
    });

    expect(result.text).toContain('Rendered image:');
    expect(result.text).toContain('"type":"image"');
    expect(result.text).toContain('"media_type":"image/png"');
  });

  it('extracts thinking configuration and signatures', async () => {
    const request = await readFixture('anthropic-request-tools.json');
    const thinkingConfig = extractThinkingConfig(request);

    expect(thinkingConfig).toEqual({ enabled: true, budgetTokens: 256 });

    const message = {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'Thoughts', signature: 'sig-123' },
        { type: 'text', text: 'Answer' },
      ],
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
          { type: 'text', text: 'Visible' },
        ],
      },
      { role: 'user', content: 'Next' },
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
      { type: 'text', text: 'Line 2' },
    ]);

    expect(systemPrompt).toBe('Line 1\nLine 2');
  });

  it('always appends tool_call stop sequence', () => {
    const request = {
      model: 'claude-sonnet-4-5-thinking',
      messages: [{ role: 'user', content: 'Hello' }],
    };

    const result = transformAnthropicToHopGPT(request);

    // NOTE: Use a sentinel that won't match tool markup to avoid truncating tool calls.
    expect(result.stop_sequences).toEqual(['<|hopgpt_tool_stop|>']);
  });

  it('treats stop as an alias for stop_sequences and appends tool_call stop', () => {
    const request = {
      model: 'claude-sonnet-4-5-thinking',
      messages: [{ role: 'user', content: 'Hello' }],
      stop: ['<end>'],
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
      messages: [{ role: 'user', content: 'Hello' }],
    };

    const result = transformAnthropicToHopGPT(request);

    expect(result.reasoning_effort).toBe('high');
    expect(result.max_tokens).toBeGreaterThanOrEqual(8192);
  });

  it('preserves max_tokens above the thinking floor', () => {
    const request = {
      model: 'claude-opus-4-5',
      max_tokens: 32000,
      messages: [{ role: 'user', content: 'Hello' }],
    };

    const result = transformAnthropicToHopGPT(request);

    expect(result.reasoning_effort).toBe('high');
    expect(result.max_tokens).toBe(32000);
  });

  it('does not raise max_tokens when thinking is not enabled', () => {
    const request = {
      model: 'claude-haiku-4-5',
      max_tokens: 512,
      messages: [{ role: 'user', content: 'Hello' }],
    };

    const result = transformAnthropicToHopGPT(request);

    expect(result.reasoning_effort).toBeUndefined();
    expect(result.max_tokens).toBe(512);
  });

  it('forwards Anthropic sampling parameters to HopGPT', () => {
    const request = {
      model: 'claude-haiku-4-5',
      max_tokens: 512,
      temperature: 0.2,
      top_p: 0.9,
      top_k: 40,
      messages: [{ role: 'user', content: 'Hello' }],
    };

    const result = transformAnthropicToHopGPT(request);

    expect(result.temperature).toBe(0.2);
    expect(result.top_p).toBe(0.9);
    expect(result.top_k).toBe(40);
  });

  it('ignores invalid sampling parameter values', () => {
    const request = {
      model: 'claude-haiku-4-5',
      max_tokens: 512,
      temperature: '0.2',
      top_p: Number.NaN,
      top_k: Number.POSITIVE_INFINITY,
      messages: [{ role: 'user', content: 'Hello' }],
    };

    const result = transformAnthropicToHopGPT(request);

    expect(result.temperature).toBeUndefined();
    expect(result.top_p).toBeUndefined();
    expect(result.top_k).toBeUndefined();
  });

  it('preserves explicit thinking budget tokens', () => {
    const request = {
      model: 'claude-opus-4-5',
      max_tokens: 12000,
      thinking: { type: 'enabled', budget_tokens: 4096 },
      messages: [{ role: 'user', content: 'Hello' }],
    };

    const result = transformAnthropicToHopGPT(request);

    expect(result.reasoning_effort).toBe('high');
    expect(result.thinking).toEqual({ type: 'enabled', budget_tokens: 4096 });
  });
});
