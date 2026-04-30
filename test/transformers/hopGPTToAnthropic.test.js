import { describe, it, expect, vi } from 'vitest';
import {
  HopGPTToAnthropicTransformer,
  formatSSEEvent
} from '../../src/transformers/hopGPTToAnthropic.js';
import { readFixture } from '../helpers/fixtures.js';

describe('hopGPTToAnthropic transformer', () => {
  it('formats SSE events', () => {
    const formatted = formatSSEEvent({
      event: 'message_start',
      data: { type: 'message_start', message: { id: 'msg_1' } }
    });

    expect(formatted).toBe(
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1"}}\n\n'
    );
  });

  it('captures created message id for conversation state', () => {
    const transformer = new HopGPTToAnthropicTransformer('claude-sonnet-4-5-thinking', {
      thinkingEnabled: false
    });

    transformer.transformEvent({
      event: 'message',
      data: JSON.stringify({
        created: true,
        message: { id: 'msg-create' }
      })
    });

    const state = transformer.getConversationState();
    expect(state.lastAssistantMessageId).toBe('msg-create');
  });

  it('transforms streaming thinking, text, and tool_use blocks', async () => {
    const transformer = new HopGPTToAnthropicTransformer('claude-sonnet-4-5-thinking', {
      thinkingEnabled: true,
      stopSequences: ['END']
    });

    const events = [];
    const pushEvents = (data) => {
      const result = transformer.transformEvent({
        event: 'message',
        data: JSON.stringify(data)
      });
      if (result) {
        events.push(...(Array.isArray(result) ? result : [result]));
      }
    };

    pushEvents({ created: true, message: { id: 'msg-create' } });
    pushEvents({
      event: 'on_message_delta',
      data: {
        delta: {
          content: [
            { type: 'thinking', thinking: 'Plan', signature: 'sig-1' }
          ]
        }
      }
    });
    pushEvents({
      event: 'on_message_delta',
      data: {
        delta: {
          content: [
            { type: 'text', text: 'Hello' }
          ]
        }
      }
    });
    pushEvents({
      event: 'on_message_delta',
      data: {
        delta: {
          content: [
            {
              type: 'tool_use',
              id: 'toolu_1',
              name: 'search',
              input: '{"q":"hi"}'
            }
          ]
        }
      }
    });

    const finalData = await readFixture('hopgpt-response-final.json');
    pushEvents(finalData);

    const eventNames = events.map(evt => evt.event);
    expect(eventNames).toContain('message_start');
    expect(eventNames).toContain('content_block_start');
    expect(eventNames).toContain('content_block_delta');
    expect(eventNames).toContain('message_stop');

    const thinkingDelta = events.find(evt => evt.event === 'content_block_delta' &&
      evt.data?.delta?.type === 'thinking_delta');
    const toolDelta = events.find(evt => evt.event === 'content_block_delta' &&
      evt.data?.delta?.type === 'input_json_delta');
    expect(thinkingDelta).toBeTruthy();
    expect(toolDelta).toBeTruthy();

    const response = transformer.buildNonStreamingResponse();
    expect(response.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'thinking', signature: 'sig-1' }),
        expect.objectContaining({ type: 'text', text: 'Hello' }),
        expect.objectContaining({ type: 'tool_use', name: 'get_weather' })
      ])
    );
    expect(response.stop_reason).toBe('tool_use');
  });

  it('extracts mcp_tool_call blocks from text and emits tool_use', () => {
    const transformer = new HopGPTToAnthropicTransformer('claude-sonnet-4-5-thinking', {
      thinkingEnabled: false
    });

    const events = [];
    const pushEvents = (data) => {
      const result = transformer.transformEvent({
        event: 'message',
        data: JSON.stringify(data)
      });
      if (result) {
        events.push(...(Array.isArray(result) ? result : [result]));
      }
    };

    const mcpCall = `<mcp_tool_call>
<server_name>opencode</server_name>
<tool_name>Edit</tool_name>
<arguments>
{
  "file_path": "example.ts",
  "new_string": "line 1\\nline 2\\nline 3"
}
</arguments>
</mcp_tool_call>`;

    pushEvents({ created: true, message: { id: 'msg-create' } });
    pushEvents({
      event: 'on_message_delta',
      data: {
        delta: {
          content: [
            { type: 'text', text: `Before ${mcpCall} After` }
          ]
        }
      }
    });
    pushEvents({
      final: true,
      responseMessage: {
        messageId: 'msg-final',
        promptTokens: 0,
        tokenCount: 0,
        stopReason: 'stop',
        content: []
      }
    });

    const textDeltas = events
      .filter(evt => evt.event === 'content_block_delta' && evt.data?.delta?.type === 'text_delta')
      .map(evt => evt.data.delta.text)
      .join('');
    expect(textDeltas).toContain('Before');
    expect(textDeltas).toContain('After');
    expect(textDeltas).not.toContain('<mcp_tool_call>');

    const toolStart = events.find(evt =>
      evt.event === 'content_block_start' &&
      evt.data?.content_block?.type === 'tool_use' &&
      evt.data?.content_block?.name === 'Edit'
    );
    expect(toolStart).toBeTruthy();

    const response = transformer.buildNonStreamingResponse();
    expect(response.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'tool_use',
          name: 'Edit',
          input: {
            file_path: 'example.ts',
            new_string: 'line 1\nline 2\nline 3'
          }
        })
      ])
    );
  });

  it('maps mcp_tool_call blocks to matching MCP tool names', () => {
    const transformer = new HopGPTToAnthropicTransformer('claude-sonnet-4-5-thinking', {
      thinkingEnabled: false,
      toolNames: ['mcp__opencode__Edit']
    });

    const events = [];
    const pushEvents = (data) => {
      const result = transformer.transformEvent({
        event: 'message',
        data: JSON.stringify(data)
      });
      if (result) {
        events.push(...(Array.isArray(result) ? result : [result]));
      }
    };

    const mcpCall = `<mcp_tool_call>
<server_name>opencode</server_name>
<tool_name>Edit</tool_name>
<arguments>
{
  "file_path": "example.ts",
  "new_string": "line 1\\nline 2\\nline 3"
}
</arguments>
</mcp_tool_call>`;

    pushEvents({ created: true, message: { id: 'msg-create' } });
    pushEvents({
      event: 'on_message_delta',
      data: {
        delta: {
          content: [
            { type: 'text', text: `Before ${mcpCall} After` }
          ]
        }
      }
    });
    pushEvents({
      final: true,
      responseMessage: {
        messageId: 'msg-final',
        promptTokens: 0,
        tokenCount: 0,
        stopReason: 'stop',
        content: []
      }
    });

    const toolStart = events.find(evt =>
      evt.event === 'content_block_start' &&
      evt.data?.content_block?.type === 'tool_use' &&
      evt.data?.content_block?.name === 'mcp__opencode__Edit'
    );
    expect(toolStart).toBeTruthy();

    const response = transformer.buildNonStreamingResponse();
    expect(response.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'tool_use',
          name: 'mcp__opencode__Edit'
        })
      ])
    );
  });

  it('handles mcp_tool_call blocks without arguments', () => {
    const transformer = new HopGPTToAnthropicTransformer('claude-sonnet-4-5-thinking', {
      thinkingEnabled: false
    });

    const events = [];
    const pushEvents = (data) => {
      const result = transformer.transformEvent({
        event: 'message',
        data: JSON.stringify(data)
      });
      if (result) {
        events.push(...(Array.isArray(result) ? result : [result]));
      }
    };

    const mcpCall = `<mcp_tool_call>
<server_name>opencode</server_name>
<tool_name>List</tool_name>
</mcp_tool_call>`;

    pushEvents({ created: true, message: { id: 'msg-create' } });
    pushEvents({
      event: 'on_message_delta',
      data: {
        delta: {
          content: [
            { type: 'text', text: `Before ${mcpCall} After` }
          ]
        }
      }
    });
    pushEvents({
      final: true,
      responseMessage: {
        messageId: 'msg-final',
        promptTokens: 0,
        tokenCount: 0,
        stopReason: 'stop',
        content: []
      }
    });

    const textDeltas = events
      .filter(evt => evt.event === 'content_block_delta' && evt.data?.delta?.type === 'text_delta')
      .map(evt => evt.data.delta.text)
      .join('');
    expect(textDeltas).toContain('Before');
    expect(textDeltas).toContain('After');
    expect(textDeltas).not.toContain('<mcp_tool_call>');

    const response = transformer.buildNonStreamingResponse();
    const toolUseBlocks = response.content.filter(b => b.type === 'tool_use');
    expect(toolUseBlocks.length).toBe(1);
    expect(toolUseBlocks[0].name).toBe('List');
    expect(toolUseBlocks[0].input).toEqual({});
  });

  it('passes through mcp_tool_call blocks in text when mcpPassthrough is enabled', () => {
    const transformer = new HopGPTToAnthropicTransformer('claude-sonnet-4-5-thinking', {
      thinkingEnabled: false,
      mcpPassthrough: true
    });

    const events = [];
    const pushEvents = (data) => {
      const result = transformer.transformEvent({
        event: 'message',
        data: JSON.stringify(data)
      });
      if (result) {
        events.push(...(Array.isArray(result) ? result : [result]));
      }
    };

    const mcpCall = `<mcp_tool_call>
<server_name>opencode</server_name>
<tool_name>Edit</tool_name>
<arguments>
{
  "file_path": "example.ts",
  "new_string": "line 1\\nline 2\\nline 3"
}
</arguments>
</mcp_tool_call>`;

    pushEvents({ created: true, message: { id: 'msg-create' } });
    pushEvents({
      event: 'on_message_delta',
      data: {
        delta: {
          content: [
            { type: 'text', text: `Before ${mcpCall} After` }
          ]
        }
      }
    });
    pushEvents({
      final: true,
      responseMessage: {
        messageId: 'msg-final',
        promptTokens: 0,
        tokenCount: 0,
        stopReason: 'stop',
        content: []
      }
    });

    // In passthrough mode, the mcp_tool_call should remain in text
    const textDeltas = events
      .filter(evt => evt.event === 'content_block_delta' && evt.data?.delta?.type === 'text_delta')
      .map(evt => evt.data.delta.text)
      .join('');
    expect(textDeltas).toContain('Before');
    expect(textDeltas).toContain('After');
    expect(textDeltas).toContain('<mcp_tool_call>');
    expect(textDeltas).toContain('<tool_name>Edit</tool_name>');

    // No tool_use blocks should be created
    const toolStart = events.find(evt =>
      evt.event === 'content_block_start' &&
      evt.data?.content_block?.type === 'tool_use'
    );
    expect(toolStart).toBeFalsy();

    // Non-streaming response should also preserve the text
    const response = transformer.buildNonStreamingResponse();
    const textBlocks = response.content.filter(b => b.type === 'text');
    expect(textBlocks.length).toBeGreaterThan(0);
    const fullText = textBlocks.map(b => b.text).join('');
    expect(fullText).toContain('<mcp_tool_call>');

    // No tool_use in content
    const toolUseBlocks = response.content.filter(b => b.type === 'tool_use');
    expect(toolUseBlocks.length).toBe(0);
  });

  it('extracts function_calls/invoke blocks from text and emits tool_use', () => {
    const transformer = new HopGPTToAnthropicTransformer('claude-sonnet-4-5-thinking', {
      thinkingEnabled: false
    });

    const events = [];
    const pushEvents = (data) => {
      const result = transformer.transformEvent({
        event: 'message',
        data: JSON.stringify(data)
      });
      if (result) {
        events.push(...(Array.isArray(result) ? result : [result]));
      }
    };

    // OpenCode format with multiple tool calls
    const functionCalls = `<function_calls>
<invoke name="Glob">
<parameter name="pattern">**/</parameter>
</invoke>
<invoke name="Read">
<parameter name="file_path">README.md</parameter>
</invoke>
</function_calls>`;

    pushEvents({ created: true, message: { id: 'msg-create' } });
    pushEvents({
      event: 'on_message_delta',
      data: {
        delta: {
          content: [
            { type: 'text', text: `Let me explore: ${functionCalls} Done.` }
          ]
        }
      }
    });
    pushEvents({
      final: true,
      responseMessage: {
        messageId: 'msg-final',
        promptTokens: 0,
        tokenCount: 0,
        stopReason: 'stop',
        content: []
      }
    });

    // Text should not contain the XML blocks
    const textDeltas = events
      .filter(evt => evt.event === 'content_block_delta' && evt.data?.delta?.type === 'text_delta')
      .map(evt => evt.data.delta.text)
      .join('');
    expect(textDeltas).toContain('Let me explore:');
    expect(textDeltas).toContain('Done.');
    expect(textDeltas).not.toContain('<function_calls>');
    expect(textDeltas).not.toContain('<invoke');

    // Both tool_use blocks should be created
    const toolStarts = events.filter(evt =>
      evt.event === 'content_block_start' &&
      evt.data?.content_block?.type === 'tool_use'
    );
    expect(toolStarts.length).toBe(2);
    expect(toolStarts[0].data.content_block.name).toBe('Glob');
    expect(toolStarts[1].data.content_block.name).toBe('Read');

    // Non-streaming response should have both tool_use blocks
    const response = transformer.buildNonStreamingResponse();
    const toolUseBlocks = response.content.filter(b => b.type === 'tool_use');
    expect(toolUseBlocks.length).toBe(2);
    expect(toolUseBlocks[0].name).toBe('Glob');
    expect(toolUseBlocks[0].input).toEqual({ pattern: '**/' });
    expect(toolUseBlocks[1].name).toBe('Read');
    expect(toolUseBlocks[1].input).toEqual({ file_path: 'README.md' });
    expect(response.stop_reason).toBe('tool_use');
  });

  it('extracts standalone invoke blocks from text and emits tool_use', () => {
    const transformer = new HopGPTToAnthropicTransformer('claude-sonnet-4-5-thinking', {
      thinkingEnabled: false
    });

    const events = [];
    const pushEvents = (data) => {
      const result = transformer.transformEvent({
        event: 'message',
        data: JSON.stringify(data)
      });
      if (result) {
        events.push(...(Array.isArray(result) ? result : [result]));
      }
    };

    const invokeCall = `<invoke name="Read">
<parameter name="file_path">README.md</parameter>
</invoke>`;

    pushEvents({ created: true, message: { id: 'msg-create' } });
    pushEvents({
      event: 'on_message_delta',
      data: {
        delta: {
          content: [
            { type: 'text', text: `Before ${invokeCall} After` }
          ]
        }
      }
    });
    pushEvents({
      final: true,
      responseMessage: {
        messageId: 'msg-final',
        promptTokens: 0,
        tokenCount: 0,
        stopReason: 'stop',
        content: []
      }
    });

    const textDeltas = events
      .filter(evt => evt.event === 'content_block_delta' && evt.data?.delta?.type === 'text_delta')
      .map(evt => evt.data.delta.text)
      .join('');
    expect(textDeltas).toContain('Before');
    expect(textDeltas).toContain('After');
    expect(textDeltas).not.toContain('<invoke');

    const response = transformer.buildNonStreamingResponse();
    const toolUseBlocks = response.content.filter(b => b.type === 'tool_use');
    expect(toolUseBlocks.length).toBe(1);
    expect(toolUseBlocks[0].name).toBe('Read');
    expect(toolUseBlocks[0].input).toEqual({ file_path: 'README.md' });
    expect(response.stop_reason).toBe('tool_use');
  });

  it('extracts tool_call JSON blocks from text and emits tool_use', () => {
    const transformer = new HopGPTToAnthropicTransformer('claude-sonnet-4-5-thinking', {
      thinkingEnabled: false
    });

    const events = [];
    const pushEvents = (data) => {
      const result = transformer.transformEvent({
        event: 'message',
        data: JSON.stringify(data)
      });
      if (result) {
        events.push(...(Array.isArray(result) ? result : [result]));
      }
    };

    // OpenCode <tool_call> JSON format
    const toolCall = `<tool_call>
{"name": "Task", "parameters": {"task": "Explore the codebase", "agent": "codebase_explorer"}}
</tool_call>`;

    pushEvents({ created: true, message: { id: 'msg-create' } });
    pushEvents({
      event: 'on_message_delta',
      data: {
        delta: {
          content: [
            { type: 'text', text: `I'll explore the project: ${toolCall} Done exploring.` }
          ]
        }
      }
    });
    pushEvents({
      final: true,
      responseMessage: {
        messageId: 'msg-final',
        promptTokens: 0,
        tokenCount: 0,
        stopReason: 'stop',
        content: []
      }
    });

    // Text should not contain the XML blocks
    const textDeltas = events
      .filter(evt => evt.event === 'content_block_delta' && evt.data?.delta?.type === 'text_delta')
      .map(evt => evt.data.delta.text)
      .join('');
    expect(textDeltas).toContain("I'll explore the project:");
    expect(textDeltas).toContain('Done exploring.');
    expect(textDeltas).not.toContain('<tool_call>');
    expect(textDeltas).not.toContain('codebase_explorer');

    // tool_use block should be created
    const toolStart = events.find(evt =>
      evt.event === 'content_block_start' &&
      evt.data?.content_block?.type === 'tool_use'
    );
    expect(toolStart).toBeTruthy();
    expect(toolStart.data.content_block.name).toBe('Task');

    // Non-streaming response should have the tool_use block
    const response = transformer.buildNonStreamingResponse();
    const toolUseBlocks = response.content.filter(b => b.type === 'tool_use');
    expect(toolUseBlocks.length).toBe(1);
    expect(toolUseBlocks[0].name).toBe('Task');
    expect(toolUseBlocks[0].input).toEqual({
      task: 'Explore the codebase',
      agent: 'codebase_explorer'
    });
    expect(response.stop_reason).toBe('tool_use');
  });

  it('normalizes tool_call names to available tool definitions', () => {
    const transformer = new HopGPTToAnthropicTransformer('claude-sonnet-4-5-thinking', {
      thinkingEnabled: false,
      toolNames: ['todowrite']
    });

    const events = [];
    const pushEvents = (data) => {
      const result = transformer.transformEvent({
        event: 'message',
        data: JSON.stringify(data)
      });
      if (result) {
        events.push(...(Array.isArray(result) ? result : [result]));
      }
    };

    const toolCall = `<tool_call>{"name": "todo_write", "parameters": {"todos": [{"id": "1", "content": "Task A", "status": "pending"}]}}</tool_call>`;

    pushEvents({ created: true, message: { id: 'msg-create' } });
    pushEvents({
      event: 'on_message_delta',
      data: {
        delta: {
          content: [
            { type: 'text', text: toolCall }
          ]
        }
      }
    });
    pushEvents({
      final: true,
      responseMessage: {
        messageId: 'msg-final',
        promptTokens: 0,
        tokenCount: 0,
        stopReason: 'stop',
        content: []
      }
    });

    const toolStart = events.find(evt =>
      evt.event === 'content_block_start' &&
      evt.data?.content_block?.type === 'tool_use'
    );
    expect(toolStart).toBeTruthy();
    expect(toolStart.data.content_block.name).toBe('todowrite');

    const response = transformer.buildNonStreamingResponse();
    const toolUseBlocks = response.content.filter(b => b.type === 'tool_use');
    expect(toolUseBlocks.length).toBe(1);
    expect(toolUseBlocks[0].name).toBe('todowrite');
  });

  it('emits tool_use from final content when no deltas are streamed', () => {
    const transformer = new HopGPTToAnthropicTransformer('claude-sonnet-4-5-thinking', {
      thinkingEnabled: false
    });

    const events = [];
    const pushEvents = (data) => {
      const result = transformer.transformEvent({
        event: 'message',
        data: JSON.stringify(data)
      });
      if (result) {
        events.push(...(Array.isArray(result) ? result : [result]));
      }
    };

    const toolCall = `<tool_call>
{"name": "Task", "parameters": {"task": "Explore the codebase", "agent": "explorer"}}
</tool_call>`;

    pushEvents({
      final: true,
      responseMessage: {
        messageId: 'msg-final',
        promptTokens: 0,
        tokenCount: 0,
        stopReason: 'stop',
        content: [
          { type: 'text', text: toolCall }
        ]
      }
    });

    const eventNames = events.map(evt => evt.event);
    expect(eventNames).toContain('message_start');
    expect(eventNames).toContain('content_block_start');
    expect(eventNames).toContain('message_stop');

    const toolStart = events.find(evt =>
      evt.event === 'content_block_start' &&
      evt.data?.content_block?.type === 'tool_use'
    );
    expect(toolStart).toBeTruthy();
    expect(toolStart.data.content_block.name).toBe('Task');

    const textDeltas = events
      .filter(evt => evt.event === 'content_block_delta' && evt.data?.delta?.type === 'text_delta')
      .map(evt => evt.data.delta.text)
      .join('');
    expect(textDeltas).not.toContain('<tool_call>');

    const response = transformer.buildNonStreamingResponse();
    const toolUseBlocks = response.content.filter(b => b.type === 'tool_use');
    expect(toolUseBlocks.length).toBe(1);
    expect(toolUseBlocks[0].name).toBe('Task');
    expect(response.stop_reason).toBe('tool_use');
  });

  it('emits tool_use from final text when content is a string', () => {
    const transformer = new HopGPTToAnthropicTransformer('claude-sonnet-4-5-thinking', {
      thinkingEnabled: false
    });

    const events = [];
    const pushEvents = (data) => {
      const result = transformer.transformEvent({
        event: 'message',
        data: JSON.stringify(data)
      });
      if (result) {
        events.push(...(Array.isArray(result) ? result : [result]));
      }
    };

    const toolCall = `<tool_call>
{"name": "Task", "parameters": {"task": "Explore the codebase", "agent": "explorer"}}
</tool_call>`;

    pushEvents({
      final: true,
      responseMessage: {
        messageId: 'msg-final',
        promptTokens: 0,
        tokenCount: 0,
        stopReason: 'stop',
        content: toolCall
      }
    });

    const eventNames = events.map(evt => evt.event);
    expect(eventNames).toContain('message_start');
    expect(eventNames).toContain('content_block_start');
    expect(eventNames).toContain('message_stop');

    const toolStart = events.find(evt =>
      evt.event === 'content_block_start' &&
      evt.data?.content_block?.type === 'tool_use'
    );
    expect(toolStart).toBeTruthy();
    expect(toolStart.data.content_block.name).toBe('Task');

    const response = transformer.buildNonStreamingResponse();
    const toolUseBlocks = response.content.filter(b => b.type === 'tool_use');
    expect(toolUseBlocks.length).toBe(1);
    expect(toolUseBlocks[0].name).toBe('Task');
    expect(response.stop_reason).toBe('tool_use');
  });

  it('extracts tool_call JSON blocks with attributes from text', () => {
    const transformer = new HopGPTToAnthropicTransformer('claude-sonnet-4-5-thinking', {
      thinkingEnabled: false
    });

    const events = [];
    const pushEvents = (data) => {
      const result = transformer.transformEvent({
        event: 'message',
        data: JSON.stringify(data)
      });
      if (result) {
        events.push(...(Array.isArray(result) ? result : [result]));
      }
    };

    const toolCall = `<tool_call id="call_1">
{"name": "Read", "parameters": {"path": "README.md"}}
</tool_call>`;

    pushEvents({ created: true, message: { id: 'msg-create' } });
    pushEvents({
      event: 'on_message_delta',
      data: {
        delta: {
          content: [
            { type: 'text', text: `Before ${toolCall} After` }
          ]
        }
      }
    });
    pushEvents({
      final: true,
      responseMessage: {
        messageId: 'msg-final',
        promptTokens: 0,
        tokenCount: 0,
        stopReason: 'stop',
        content: []
      }
    });

    const textDeltas = events
      .filter(evt => evt.event === 'content_block_delta' && evt.data?.delta?.type === 'text_delta')
      .map(evt => evt.data.delta.text)
      .join('');
    expect(textDeltas).toContain('Before');
    expect(textDeltas).toContain('After');
    expect(textDeltas).not.toContain('<tool_call');

    const response = transformer.buildNonStreamingResponse();
    const toolUseBlocks = response.content.filter(b => b.type === 'tool_use');
    expect(toolUseBlocks.length).toBe(1);
    expect(toolUseBlocks[0].name).toBe('Read');
    expect(toolUseBlocks[0].input).toEqual({ path: 'README.md' });
    expect(response.stop_reason).toBe('tool_use');
  });

  it('extracts tool_use XML blocks from text and emits tool_use', () => {
    const transformer = new HopGPTToAnthropicTransformer('claude-sonnet-4-5-thinking', {
      thinkingEnabled: false
    });

    const events = [];
    const pushEvents = (data) => {
      const result = transformer.transformEvent({
        event: 'message',
        data: JSON.stringify(data)
      });
      if (result) {
        events.push(...(Array.isArray(result) ? result : [result]));
      }
    };

    const toolUse = `<tool_use id="toolu_test" name="read">
{
  "file_path": "README.md"
}
</tool_use>`;

    pushEvents({ created: true, message: { id: 'msg-create' } });
    pushEvents({
      event: 'on_message_delta',
      data: {
        delta: {
          content: [
            { type: 'text', text: `Before ${toolUse} After` }
          ]
        }
      }
    });
    pushEvents({
      final: true,
      responseMessage: {
        messageId: 'msg-final',
        promptTokens: 0,
        tokenCount: 0,
        stopReason: 'stop',
        content: []
      }
    });

    const textDeltas = events
      .filter(evt => evt.event === 'content_block_delta' && evt.data?.delta?.type === 'text_delta')
      .map(evt => evt.data.delta.text)
      .join('');
    expect(textDeltas).toContain('Before');
    expect(textDeltas).toContain('After');
    expect(textDeltas).not.toContain('<tool_use');

    const toolStart = events.find(evt =>
      evt.event === 'content_block_start' &&
      evt.data?.content_block?.type === 'tool_use' &&
      evt.data?.content_block?.name === 'read'
    );
    expect(toolStart).toBeTruthy();
    expect(toolStart.data.content_block.id).toBe('toolu_test');

    const response = transformer.buildNonStreamingResponse();
    const toolUseBlocks = response.content.filter(b => b.type === 'tool_use');
    expect(toolUseBlocks.length).toBe(1);
    expect(toolUseBlocks[0].id).toBe('toolu_test');
    expect(toolUseBlocks[0].name).toBe('read');
    expect(toolUseBlocks[0].input).toEqual({ file_path: 'README.md' });
    expect(response.stop_reason).toBe('tool_use');
  });

  it('parses tool_use JSON containing tag-like strings and continues parsing tool calls', () => {
    const transformer = new HopGPTToAnthropicTransformer('claude-sonnet-4-5-thinking', {
      thinkingEnabled: false
    });

    const events = [];
    const pushEvents = (data) => {
      const result = transformer.transformEvent({
        event: 'message',
        data: JSON.stringify(data)
      });
      if (result) {
        events.push(...(Array.isArray(result) ? result : [result]));
      }
    };

    const oldString = [
      'const TOOL_CALL_JSON_BLOCK_RE = /<tool_call\\b[\\s\\S]*?<\\/tool_call>/gi;',
      "const TOOL_USE_TAG = '</tool_use>';"
    ].join('\n');
    const toolUsePayload = {
      filePath: '/tmp/example.js',
      oldString,
      newString: 'updated'
    };
    const toolUse = `<tool_use id="toolu_edit" name="edit">
${JSON.stringify(toolUsePayload, null, 2)}
</tool_use>`;
    const followupToolCall = `<tool_call>{"name": "Read", "parameters": {"path": "README.md"}}</tool_call>`;

    const splitPoint = Math.max(1, toolUse.indexOf('</tool_use>') - 10);

    pushEvents({ created: true, message: { id: 'msg-create' } });
    pushEvents({
      event: 'on_message_delta',
      data: {
        delta: {
          content: [
            { type: 'text', text: toolUse.slice(0, splitPoint) }
          ]
        }
      }
    });
    pushEvents({
      event: 'on_message_delta',
      data: {
        delta: {
          content: [
            { type: 'text', text: `${toolUse.slice(splitPoint)}${followupToolCall}` }
          ]
        }
      }
    });
    pushEvents({
      final: true,
      responseMessage: {
        messageId: 'msg-final',
        promptTokens: 0,
        tokenCount: 0,
        stopReason: 'stop',
        content: []
      }
    });

    const response = transformer.buildNonStreamingResponse();
    const toolUseBlocks = response.content.filter(b => b.type === 'tool_use');
    expect(toolUseBlocks.length).toBe(2);
    expect(toolUseBlocks[0].name).toBe('edit');
    expect(toolUseBlocks[0].input.filePath).toBe('/tmp/example.js');
    // The oldString contains regex source code with an escaped forward slash
    expect(toolUseBlocks[0].input.oldString).toContain('<\\/tool_call>');
    expect(toolUseBlocks[1].name).toBe('Read');
    expect(toolUseBlocks[1].input).toEqual({ path: 'README.md' });
  });

  it('extracts antml:function_calls/antml:invoke blocks from text (Claude Code format)', () => {
    const transformer = new HopGPTToAnthropicTransformer('claude-sonnet-4-5-thinking', {
      thinkingEnabled: false
    });

    const events = [];
    const pushEvents = (data) => {
      const result = transformer.transformEvent({
        event: 'message',
        data: JSON.stringify(data)
      });
      if (result) {
        events.push(...(Array.isArray(result) ? result : [result]));
      }
    };

    // Claude Code format with antml: namespace
    const functionCalls = `<antml:function_calls>
<antml:invoke name="Bash">
<antml:parameter name="command">git status</antml:parameter>
<antml:parameter name="description">Show git status</antml:parameter>
</antml:invoke>
<antml:invoke name="Read">
<antml:parameter name="file_path">/path/to/file.js</antml:parameter>
</antml:invoke>
</antml:function_calls>`;

    pushEvents({ created: true, message: { id: 'msg-create' } });
    pushEvents({
      event: 'on_message_delta',
      data: {
        delta: {
          content: [
            { type: 'text', text: `Let me check the status: ${functionCalls} Done.` }
          ]
        }
      }
    });
    pushEvents({
      final: true,
      responseMessage: {
        messageId: 'msg-final',
        promptTokens: 0,
        tokenCount: 0,
        stopReason: 'stop',
        content: []
      }
    });

    // Text should not contain the XML blocks
    const textDeltas = events
      .filter(evt => evt.event === 'content_block_delta' && evt.data?.delta?.type === 'text_delta')
      .map(evt => evt.data.delta.text)
      .join('');
    expect(textDeltas).toContain('Let me check the status:');
    expect(textDeltas).toContain('Done.');
    expect(textDeltas).not.toContain('<antml:function_calls>');
    expect(textDeltas).not.toContain('<antml:invoke');

    // Both tool_use blocks should be created
    const toolStarts = events.filter(evt =>
      evt.event === 'content_block_start' &&
      evt.data?.content_block?.type === 'tool_use'
    );
    expect(toolStarts.length).toBe(2);
    expect(toolStarts[0].data.content_block.name).toBe('Bash');
    expect(toolStarts[1].data.content_block.name).toBe('Read');

    // Non-streaming response should have both tool_use blocks
    const response = transformer.buildNonStreamingResponse();
    const toolUseBlocks = response.content.filter(b => b.type === 'tool_use');
    expect(toolUseBlocks.length).toBe(2);
    expect(toolUseBlocks[0].name).toBe('Bash');
    expect(toolUseBlocks[0].input).toEqual({ command: 'git status', description: 'Show git status' });
    expect(toolUseBlocks[1].name).toBe('Read');
    expect(toolUseBlocks[1].input).toEqual({ file_path: '/path/to/file.js' });
    expect(response.stop_reason).toBe('tool_use');
  });

  it('extracts standalone antml:invoke blocks from text (Claude Code format)', () => {
    const transformer = new HopGPTToAnthropicTransformer('claude-sonnet-4-5-thinking', {
      thinkingEnabled: false
    });

    const events = [];
    const pushEvents = (data) => {
      const result = transformer.transformEvent({
        event: 'message',
        data: JSON.stringify(data)
      });
      if (result) {
        events.push(...(Array.isArray(result) ? result : [result]));
      }
    };

    const invokeCall = `<invoke name="Bash">
<parameter name="command">npm test</parameter>
</invoke>`;

    pushEvents({ created: true, message: { id: 'msg-create' } });
    pushEvents({
      event: 'on_message_delta',
      data: {
        delta: {
          content: [
            { type: 'text', text: `Before ${invokeCall} After` }
          ]
        }
      }
    });
    pushEvents({
      final: true,
      responseMessage: {
        messageId: 'msg-final',
        promptTokens: 0,
        tokenCount: 0,
        stopReason: 'stop',
        content: []
      }
    });

    const textDeltas = events
      .filter(evt => evt.event === 'content_block_delta' && evt.data?.delta?.type === 'text_delta')
      .map(evt => evt.data.delta.text)
      .join('');
    expect(textDeltas).toContain('Before');
    expect(textDeltas).toContain('After');
    expect(textDeltas).not.toContain('<invoke');

    const response = transformer.buildNonStreamingResponse();
    const toolUseBlocks = response.content.filter(b => b.type === 'tool_use');
    expect(toolUseBlocks.length).toBe(1);
    expect(toolUseBlocks[0].name).toBe('Bash');
    expect(toolUseBlocks[0].input).toEqual({ command: 'npm test' });
    expect(response.stop_reason).toBe('tool_use');
  });

  it('repairs malformed JSON with missing array brackets in tool_use blocks', () => {
    const transformer = new HopGPTToAnthropicTransformer('claude-sonnet-4-5-thinking', {
      thinkingEnabled: false
    });

    const events = [];
    const pushEvents = (data) => {
      const result = transformer.transformEvent({
        event: 'message',
        data: JSON.stringify(data)
      });
      if (result) {
        events.push(...(Array.isArray(result) ? result : [result]));
      }
    };

    // Malformed JSON where array brackets are missing around objects
    // This is what models sometimes output incorrectly:
    // {"todos": {"id": "1", ...}, {"id": "2", ...}} instead of
    // {"todos": [{"id": "1", ...}, {"id": "2", ...}]}
    const malformedToolUse = `<tool_use id="toolu_abc" name="todowrite">
{"todos": {"id": "1", "content": "First task", "status": "completed"}, {"id": "2", "content": "Second task", "status": "pending"}}
</tool_use>`;

    pushEvents({ created: true, message: { id: 'msg-create' } });
    pushEvents({
      event: 'on_message_delta',
      data: {
        delta: {
          content: [
            { type: 'text', text: malformedToolUse }
          ]
        }
      }
    });
    pushEvents({
      final: true,
      responseMessage: {
        messageId: 'msg-final',
        promptTokens: 0,
        tokenCount: 0,
        stopReason: 'stop',
        content: []
      }
    });

    const response = transformer.buildNonStreamingResponse();
    const toolUseBlocks = response.content.filter(b => b.type === 'tool_use');

    // Should successfully parse and repair the malformed JSON
    expect(toolUseBlocks.length).toBe(1);
    expect(toolUseBlocks[0].name).toBe('todowrite');
    expect(toolUseBlocks[0].id).toBe('toolu_abc');

    // The repaired JSON should have the todos as an array
    const input = toolUseBlocks[0].input;
    expect(Array.isArray(input.todos)).toBe(true);
    expect(input.todos.length).toBe(2);
    expect(input.todos[0].id).toBe('1');
    expect(input.todos[0].content).toBe('First task');
    expect(input.todos[1].id).toBe('2');
    expect(input.todos[1].content).toBe('Second task');
  });

  it('repairs malformed JSON with missing array brackets in tool_call blocks', () => {
    const transformer = new HopGPTToAnthropicTransformer('claude-sonnet-4-5-thinking', {
      thinkingEnabled: false
    });

    const events = [];
    const pushEvents = (data) => {
      const result = transformer.transformEvent({
        event: 'message',
        data: JSON.stringify(data)
      });
      if (result) {
        events.push(...(Array.isArray(result) ? result : [result]));
      }
    };

    // Malformed tool_call JSON format
    const malformedToolCall = `<tool_call>
{"name": "todowrite", "parameters": {"todos": {"id": "1", "content": "Task A", "status": "completed"}, {"id": "2", "content": "Task B", "status": "in_progress"}, {"id": "3", "content": "Task C", "status": "pending"}}}
</tool_call>`;

    pushEvents({ created: true, message: { id: 'msg-create' } });
    pushEvents({
      event: 'on_message_delta',
      data: {
        delta: {
          content: [
            { type: 'text', text: malformedToolCall }
          ]
        }
      }
    });
    pushEvents({
      final: true,
      responseMessage: {
        messageId: 'msg-final',
        promptTokens: 0,
        tokenCount: 0,
        stopReason: 'stop',
        content: []
      }
    });

    const response = transformer.buildNonStreamingResponse();
    const toolUseBlocks = response.content.filter(b => b.type === 'tool_use');

    // Should successfully parse and repair the malformed JSON
    expect(toolUseBlocks.length).toBe(1);
    expect(toolUseBlocks[0].name).toBe('todowrite');

    // The repaired JSON should have the todos as an array
    const input = toolUseBlocks[0].input;
    expect(Array.isArray(input.todos)).toBe(true);
    expect(input.todos.length).toBe(3);
    expect(input.todos[0].id).toBe('1');
    expect(input.todos[1].id).toBe('2');
    expect(input.todos[2].id).toBe('3');
  });

  it('repairs tool_call JSON with unescaped newlines in string values', () => {
    const transformer = new HopGPTToAnthropicTransformer('claude-sonnet-4-5-thinking', {
      thinkingEnabled: false
    });

    const events = [];
    const pushEvents = (data) => {
      const result = transformer.transformEvent({
        event: 'message',
        data: JSON.stringify(data)
      });
      if (result) {
        events.push(...(Array.isArray(result) ? result : [result]));
      }
    };

    const toolUseWithNewlines = `<tool_use>
{"name": "write", "parameters": {"filePath": "/tmp/example.txt", "content": "line1
line2
line3"}}
</tool_call>`;

    pushEvents({ created: true, message: { id: 'msg-create' } });
    pushEvents({
      event: 'on_message_delta',
      data: {
        delta: {
          content: [
            { type: 'text', text: toolUseWithNewlines }
          ]
        }
      }
    });
    pushEvents({
      final: true,
      responseMessage: {
        messageId: 'msg-final',
        promptTokens: 0,
        tokenCount: 0,
        stopReason: 'stop',
        content: []
      }
    });

    const response = transformer.buildNonStreamingResponse();
    const toolUseBlocks = response.content.filter(b => b.type === 'tool_use');

    expect(toolUseBlocks.length).toBe(1);
    expect(toolUseBlocks[0].name).toBe('write');
    expect(toolUseBlocks[0].input.filePath).toBe('/tmp/example.txt');
    expect(toolUseBlocks[0].input.content).toBe('line1\nline2\nline3');
  });

  it('extracts tool_use blocks with tool_call JSON and mismatched closing tag', () => {
    const transformer = new HopGPTToAnthropicTransformer('claude-sonnet-4-5-thinking', {
      thinkingEnabled: false
    });

    const events = [];
    const pushEvents = (data) => {
      const result = transformer.transformEvent({
        event: 'message',
        data: JSON.stringify(data)
      });
      if (result) {
        events.push(...(Array.isArray(result) ? result : [result]));
      }
    };

    const mismatchedToolUse = `<tool_use>
{"name": "todowrite", "parameters": {"todos": {"id": "1", "content": "Task A", "status": "completed"}, {"id": "2", "content": "Task B", "status": "in_progress"}}}
</tool_call>`;

    pushEvents({ created: true, message: { id: 'msg-create' } });
    pushEvents({
      event: 'on_message_delta',
      data: {
        delta: {
          content: [
            { type: 'text', text: `Before ${mismatchedToolUse} After` }
          ]
        }
      }
    });
    pushEvents({
      final: true,
      responseMessage: {
        messageId: 'msg-final',
        promptTokens: 0,
        tokenCount: 0,
        stopReason: 'stop',
        content: []
      }
    });

    const textDeltas = events
      .filter(evt => evt.event === 'content_block_delta' && evt.data?.delta?.type === 'text_delta')
      .map(evt => evt.data.delta.text)
      .join('');
    expect(textDeltas).toContain('Before');
    expect(textDeltas).toContain('After');
    expect(textDeltas).not.toContain('<tool_use');

    const response = transformer.buildNonStreamingResponse();
    const toolUseBlocks = response.content.filter(b => b.type === 'tool_use');
    expect(toolUseBlocks.length).toBe(1);
    expect(toolUseBlocks[0].name).toBe('todowrite');
    const input = toolUseBlocks[0].input;
    expect(Array.isArray(input.todos)).toBe(true);
    expect(input.todos.length).toBe(2);
    expect(input.todos[0].id).toBe('1');
    expect(input.todos[1].id).toBe('2');
  });

  it('forceEnd emits message_stop when stream ends without final event', () => {
    const transformer = new HopGPTToAnthropicTransformer('claude-sonnet-4-5', {
      thinkingEnabled: false
    });

    const events = [];
    const pushEvents = (data) => {
      const result = transformer.transformEvent({
        event: 'message',
        data: JSON.stringify(data)
      });
      if (result) {
        events.push(...(Array.isArray(result) ? result : [result]));
      }
    };

    // Simulate a stream that starts but never receives a final event
    pushEvents({ created: true, message: { id: 'msg-create' } });
    pushEvents({
      event: 'on_message_delta',
      data: {
        delta: {
          content: [
            { type: 'text', text: 'Hello world' }
          ]
        }
      }
    });

    // Stream hasn't ended yet
    expect(transformer.hasEnded()).toBe(false);

    // Force end the stream (simulating what happens when HopGPT closes without final event)
    const cleanupEvents = transformer.forceEnd();

    // Should emit message_delta and message_stop
    expect(cleanupEvents.length).toBeGreaterThan(0);
    const messageStop = cleanupEvents.find(evt => evt.event === 'message_stop');
    expect(messageStop).toBeTruthy();
    expect(messageStop.data.type).toBe('message_stop');

    // Should have a message_delta with stop_reason
    const messageDelta = cleanupEvents.find(evt => evt.event === 'message_delta');
    expect(messageDelta).toBeTruthy();
    expect(messageDelta.data.delta.stop_reason).toBe('end_turn');

    // Now hasEnded should return true
    expect(transformer.hasEnded()).toBe(true);

    // Calling forceEnd again should return empty array (idempotent)
    const secondCall = transformer.forceEnd();
    expect(secondCall).toEqual([]);
  });

  it('forceEnd flushes buffered partial tool calls as text', () => {
    const transformer = new HopGPTToAnthropicTransformer('claude-sonnet-4-5', {
      thinkingEnabled: false
    });

    const events = [];
    const pushEvents = (data) => {
      const result = transformer.transformEvent({
        event: 'message',
        data: JSON.stringify(data)
      });
      if (result) {
        events.push(...(Array.isArray(result) ? result : [result]));
      }
    };

    pushEvents({ created: true, message: { id: 'msg-create' } });
    // Send text that contains a partial tool call tag (never closed)
    pushEvents({
      event: 'on_message_delta',
      data: {
        delta: {
          content: [
            { type: 'text', text: 'Use <tool_use to call tools' }
          ]
        }
      }
    });

    // Force end without final event
    const cleanupEvents = transformer.forceEnd();

    // The partial tool call should be flushed as text
    const textDeltas = cleanupEvents.filter(
      evt => evt.event === 'content_block_delta' && evt.data?.delta?.type === 'text_delta'
    );
    const allText = textDeltas.map(evt => evt.data.delta.text).join('');
    expect(allText).toContain('<tool_use');

    // Should still have message_stop
    const messageStop = cleanupEvents.find(evt => evt.event === 'message_stop');
    expect(messageStop).toBeTruthy();
  });

  it('recovers incomplete tool_call blocks at end of stream', () => {
    const transformer = new HopGPTToAnthropicTransformer('claude-sonnet-4-5', {
      thinkingEnabled: false
    });

    const events = [];
    const pushEvents = (data) => {
      const result = transformer.transformEvent({
        event: 'message',
        data: JSON.stringify(data)
      });
      if (result) {
        events.push(...(Array.isArray(result) ? result : [result]));
      }
    };

    pushEvents({ created: true, message: { id: 'msg-create' } });
    pushEvents({
      event: 'on_message_delta',
      data: {
        delta: {
          content: [
            { type: 'text', text: '<tool_call>{"name": "Read", "parameters": {"path": "README.md"}}' }
          ]
        }
      }
    });
    pushEvents({
      final: true,
      responseMessage: {
        messageId: 'msg-final',
        promptTokens: 0,
        tokenCount: 0,
        stopReason: 'stop',
        content: []
      }
    });

    const toolBlocks = events.filter(evt =>
      evt.event === 'content_block_start' &&
      evt.data?.content_block?.type === 'tool_use'
    );
    expect(toolBlocks.length).toBe(1);
    expect(toolBlocks[0].data?.content_block?.name).toBe('Read');

    const inputJson = events
      .filter(evt => evt.event === 'content_block_delta' && evt.data?.delta?.type === 'input_json_delta')
      .map(evt => evt.data.delta.partial_json)
      .join('');
    const parsedInput = JSON.parse(inputJson);
    expect(parsedInput.path).toBe('README.md');
  });

  it('recovers incomplete function_calls blocks at end of stream', () => {
    const transformer = new HopGPTToAnthropicTransformer('claude-sonnet-4-5', {
      thinkingEnabled: false
    });

    const events = [];
    const pushEvents = (data) => {
      const result = transformer.transformEvent({
        event: 'message',
        data: JSON.stringify(data)
      });
      if (result) {
        events.push(...(Array.isArray(result) ? result : [result]));
      }
    };

    pushEvents({ created: true, message: { id: 'msg-create' } });
    pushEvents({
      event: 'on_message_delta',
      data: {
        delta: {
          content: [
            { type: 'text', text: '<function_calls><invoke name="Write"><parameter name="path">README.md</parameter><parameter name="content">Hello</parameter></invoke>' }
          ]
        }
      }
    });
    pushEvents({
      final: true,
      responseMessage: {
        messageId: 'msg-final',
        promptTokens: 0,
        tokenCount: 0,
        stopReason: 'stop',
        content: []
      }
    });

    const toolBlocks = events.filter(evt =>
      evt.event === 'content_block_start' &&
      evt.data?.content_block?.type === 'tool_use'
    );
    expect(toolBlocks.length).toBe(1);
    expect(toolBlocks[0].data?.content_block?.name).toBe('Write');

    const inputJson = events
      .filter(evt => evt.event === 'content_block_delta' && evt.data?.delta?.type === 'input_json_delta')
      .map(evt => evt.data.delta.partial_json)
      .join('');
    const parsedInput = JSON.parse(inputJson);
    expect(parsedInput.path).toBe('README.md');
    expect(parsedInput.content).toBe('Hello');
  });

  it('does not buffer quoted tool tags in documentation text', () => {
    const transformer = new HopGPTToAnthropicTransformer('claude-sonnet-4-5', {
      thinkingEnabled: false
    });

    const events = [];
    const pushEvents = (data) => {
      const result = transformer.transformEvent({
        event: 'message',
        data: JSON.stringify(data)
      });
      if (result) {
        events.push(...(Array.isArray(result) ? result : [result]));
      }
    };

    pushEvents({ created: true, message: { id: 'msg-create' } });

    // Send text that contains quoted tool tags (documentation/explanation)
    // These should NOT be buffered waiting for a closing tag
    pushEvents({
      event: 'on_message_delta',
      data: {
        delta: {
          content: [
            { type: 'text', text: 'You can use `<tool_use>` blocks to call tools. ' }
          ]
        }
      }
    });

    // Send more text to verify the quoted tag wasn't buffered
    pushEvents({
      event: 'on_message_delta',
      data: {
        delta: {
          content: [
            { type: 'text', text: 'Here is an example.' }
          ]
        }
      }
    });

    pushEvents({
      final: true,
      responseMessage: {
        messageId: 'msg-final',
        promptTokens: 0,
        tokenCount: 0,
        stopReason: 'stop',
        content: []
      }
    });

    // The quoted <tool_use> should be emitted as text, not buffered
    const textDeltas = events
      .filter(evt => evt.event === 'content_block_delta' && evt.data?.delta?.type === 'text_delta')
      .map(evt => evt.data.delta.text)
      .join('');

    // Both chunks should have been emitted (not buffered)
    expect(textDeltas).toContain('`<tool_use>`');
    expect(textDeltas).toContain('Here is an example');

    // No tool_use blocks should be created from quoted tags
    const toolBlocks = events.filter(evt =>
      evt.event === 'content_block_start' &&
      evt.data?.content_block?.type === 'tool_use'
    );
    expect(toolBlocks.length).toBe(0);
  });

  it('does not buffer source code containing tag-like string literals', () => {
    const transformer = new HopGPTToAnthropicTransformer('claude-sonnet-4-5', {
      thinkingEnabled: false
    });

    const events = [];
    const pushEvents = (data) => {
      const result = transformer.transformEvent({
        event: 'message',
        data: JSON.stringify(data)
      });
      if (result) {
        events.push(...(Array.isArray(result) ? result : [result]));
      }
    };

    pushEvents({ created: true, message: { id: 'msg-create' } });

    // Send source code that contains tag-like string literals
    // The quote AFTER the tag name should prevent buffering
    pushEvents({
      event: 'on_message_delta',
      data: {
        delta: {
          content: [
            { type: 'text', text: "const FUNCTION_CALLS_START_TAG = '<function_calls';\nconst INVOKE_START_TAG = '<invoke';\n" }
          ]
        }
      }
    });

    // Send more text to verify it wasn't buffered
    pushEvents({
      event: 'on_message_delta',
      data: {
        delta: {
          content: [
            { type: 'text', text: 'More code here.' }
          ]
        }
      }
    });

    pushEvents({
      final: true,
      responseMessage: {
        messageId: 'msg-final',
        promptTokens: 0,
        tokenCount: 0,
        stopReason: 'stop',
        content: []
      }
    });

    // Source code with string literals should be emitted, not buffered
    const textDeltas = events
      .filter(evt => evt.event === 'content_block_delta' && evt.data?.delta?.type === 'text_delta')
      .map(evt => evt.data.delta.text)
      .join('');

    // Both chunks should have been emitted
    expect(textDeltas).toContain("'<function_calls'");
    expect(textDeltas).toContain("'<invoke'");
    expect(textDeltas).toContain('More code here');

    // No tool_use blocks should be created
    const toolBlocks = events.filter(evt =>
      evt.event === 'content_block_start' &&
      evt.data?.content_block?.type === 'tool_use'
    );
    expect(toolBlocks.length).toBe(0);
  });

  it('repairs tool_call JSON with unescaped quotes in string values', () => {
    const transformer = new HopGPTToAnthropicTransformer('claude-sonnet-4-5', {
      thinkingEnabled: false
    });

    const events = [];
    const pushEvents = (data) => {
      const result = transformer.transformEvent({
        event: 'message',
        data: JSON.stringify(data)
      });
      if (result) {
        events.push(...(Array.isArray(result) ? result : [result]));
      }
    };

    pushEvents({ created: true, message: { id: 'msg-create' } });

    const chunk = '<tool_call>{"name": "Edit", "parameters": {"path": "foo.txt", "content": "uncaptured " quote"}}</tool_call>';
    pushEvents({
      event: 'on_message_delta',
      data: {
        delta: {
          content: [{ type: 'text', text: chunk }]
        }
      }
    });

    const toolBlocks = events.filter(evt =>
      evt.event === 'content_block_start' &&
      evt.data?.content_block?.type === 'tool_use'
    );
    expect(toolBlocks.length).toBe(1);
    expect(toolBlocks[0].data?.content_block?.name).toBe('Edit');

    const inputJson = events
      .filter(evt => evt.event === 'content_block_delta' && evt.data?.delta?.type === 'input_json_delta')
      .map(evt => evt.data.delta.partial_json)
      .join('');
    const parsedInput = JSON.parse(inputJson);
    expect(parsedInput.path).toBe('foo.txt');
    expect(parsedInput.content).toBe('uncaptured " quote');
  });

  it('emits unrecoverable tool_call JSON as text instead of buffering', () => {
    const transformer = new HopGPTToAnthropicTransformer('claude-sonnet-4-5', {
      thinkingEnabled: false
    });

    const events = [];
    const pushEvents = (data) => {
      const result = transformer.transformEvent({
        event: 'message',
        data: JSON.stringify(data)
      });
      if (result) {
        events.push(...(Array.isArray(result) ? result : [result]));
      }
    };

    pushEvents({ created: true, message: { id: 'msg-create' } });

    const chunk = '<tool_call>{"name": "Edit", "parameters": {"path": "foo.txt", "content": "unterminated}}</tool_call>';
    pushEvents({
      event: 'on_message_delta',
      data: {
        delta: {
          content: [{ type: 'text', text: chunk }]
        }
      }
    });

    const textDeltas = events
      .filter(evt => evt.event === 'content_block_delta' && evt.data?.delta?.type === 'text_delta')
      .map(evt => evt.data.delta.text)
      .join('');

    expect(textDeltas).toContain('<tool_call>');
    expect(textDeltas).toContain('unterminated');

    const toolBlocks = events.filter(evt =>
      evt.event === 'content_block_start' &&
      evt.data?.content_block?.type === 'tool_use'
    );
    expect(toolBlocks.length).toBe(0);
  });

  it('preserves raw tool_use input when JSON parsing fails', () => {
    const transformer = new HopGPTToAnthropicTransformer('claude-sonnet-4-5', {
      thinkingEnabled: false
    });

    const invalidInput = '{"q": "bad " quote"}';
    transformer.transformEvent({
      event: 'message',
      data: JSON.stringify({
        final: true,
        responseMessage: {
          messageId: 'msg-final',
          promptTokens: 0,
          tokenCount: 0,
          content: [
            {
              type: 'tool_use',
              id: 'toolu_1',
              name: 'search',
              input: invalidInput
            }
          ]
        }
      })
    });

    const response = transformer.buildNonStreamingResponse();
    const toolBlock = response.content.find(block => block.type === 'tool_use');
    expect(toolBlock.input).toEqual({ _raw: invalidInput });
  });

  it('strips tool instruction leaks and role prefixes from final text', () => {
    const transformer = new HopGPTToAnthropicTransformer('claude-sonnet-4-5', {
      thinkingEnabled: false
    });

    const leakedText = [
      'H: user prompt',
      '',
      '# Available Tools',
      '',
      'You have access to the following tools. To use a tool, output a tool call in the following XML format:',
      '',
      '<tool_call>',
      '{"name": "tool_name", "parameters": {}}',
      '</tool_call>',
      '',
      '## Tool Definitions',
      '',
      '### search',
      'Parameters:',
      '- q [string]',
      '',
      'A: assistant answer'
    ].join('\n');

    transformer.transformEvent({
      event: 'message',
      data: JSON.stringify({
        final: true,
        responseMessage: {
          messageId: 'msg-final',
          promptTokens: 0,
          tokenCount: 0,
          stopReason: 'stop',
          content: [{ type: 'text', text: leakedText }]
        }
      })
    });

    const response = transformer.buildNonStreamingResponse();
    const textBlock = response.content.find(block => block.type === 'text');
    expect(textBlock.text).toContain('user prompt');
    expect(textBlock.text).toContain('assistant answer');
    expect(textBlock.text).not.toContain('# Available Tools');
    expect(textBlock.text).not.toContain('Tool Definitions');
    expect(textBlock.text).not.toContain('<tool_call>');
    expect(textBlock.text).not.toMatch(/\bH:\s/);
    expect(textBlock.text).not.toMatch(/\bA:\s/);
  });

  it('filters tool instruction leaks and role markers in streaming text', () => {
    const transformer = new HopGPTToAnthropicTransformer('claude-sonnet-4-5', {
      thinkingEnabled: false
    });

    const events = [];
    const pushEvents = (data) => {
      const result = transformer.transformEvent({
        event: 'message',
        data: JSON.stringify(data)
      });
      if (result) {
        events.push(...(Array.isArray(result) ? result : [result]));
      }
    };

    pushEvents({ created: true, message: { id: 'msg-create' } });
    pushEvents({
      event: 'on_message_delta',
      data: {
        delta: {
          content: [
            { type: 'text', text: 'H: user prompt\n\n# Available Tools\n' }
          ]
        }
      }
    });
    pushEvents({
      event: 'on_message_delta',
      data: {
        delta: {
          content: [
            { type: 'text', text: '<tool_call>{"name":"tool_name","parameters":{}}</tool_call>\n\nA: streamed answer' }
          ]
        }
      }
    });
    pushEvents({
      final: true,
      responseMessage: {
        messageId: 'msg-final',
        promptTokens: 0,
        tokenCount: 0,
        stopReason: 'stop',
        content: []
      }
    });

    const text = events
      .filter(evt => evt.event === 'content_block_delta' && evt.data?.delta?.type === 'text_delta')
      .map(evt => evt.data.delta.text)
      .join('');

    expect(text).toContain('user prompt');
    expect(text).toContain('streamed answer');
    expect(text).not.toContain('# Available Tools');
    expect(text).not.toContain('Tool Definitions');
    expect(text).not.toContain('<tool_call>');
    expect(text).not.toMatch(/\bH:\s/);
    expect(text).not.toMatch(/\bA:\s/);
  });

  it('deduplicates repeated large text chunks in streaming', () => {
    const transformer = new HopGPTToAnthropicTransformer('claude-sonnet-4-5', {
      thinkingEnabled: false
    });

    const events = [];
    const pushEvents = (data) => {
      const result = transformer.transformEvent({
        event: 'message',
        data: JSON.stringify(data)
      });
      if (result) {
        events.push(...(Array.isArray(result) ? result : [result]));
      }
    };

    const summaryTable = [
      '| Tool | Result |',
      '| --- | --- |',
      '| Bash | ok |',
      '| Read | ok |',
      '| Write | ok |',
      '| Glob | ok |',
      '| List | ok |',
      '| Edit | ok |'
    ].join('\n');

    pushEvents({ created: true, message: { id: 'msg-create' } });
    pushEvents({
      event: 'on_message_delta',
      data: {
        delta: {
          content: [
            { type: 'text', text: summaryTable }
          ]
        }
      }
    });
    pushEvents({
      event: 'on_message_delta',
      data: {
        delta: {
          content: [
            { type: 'text', text: summaryTable }
          ]
        }
      }
    });
    pushEvents({
      final: true,
      responseMessage: {
        messageId: 'msg-final',
        promptTokens: 0,
        tokenCount: 0,
        stopReason: 'stop',
        content: []
      }
    });

    const text = events
      .filter(evt => evt.event === 'content_block_delta' && evt.data?.delta?.type === 'text_delta')
      .map(evt => evt.data.delta.text)
      .join('');

    expect(text).toBe(summaryTable);
  });

  it('parses parameter values containing closing tag text', () => {
    const transformer = new HopGPTToAnthropicTransformer('claude-sonnet-4-5-thinking', {
      thinkingEnabled: false
    });

    const events = [];
    const pushEvents = (data) => {
      const result = transformer.transformEvent({
        event: 'message',
        data: JSON.stringify(data)
      });
      if (result) {
        events.push(...(Array.isArray(result) ? result : [result]));
      }
    };

    // Parameter value contains </parameter> as text - should not truncate
    const invokeCall = `<invoke name="Edit">
<parameter name="oldString">Text with </parameter> tag in it</parameter>
<parameter name="newString">Replacement text</parameter>
</invoke>`;

    pushEvents({ created: true, message: { id: 'msg-create' } });
    pushEvents({
      event: 'on_message_delta',
      data: {
        delta: {
          content: [
            { type: 'text', text: invokeCall }
          ]
        }
      }
    });
    pushEvents({
      final: true,
      responseMessage: {
        messageId: 'msg-final',
        promptTokens: 0,
        tokenCount: 0,
        stopReason: 'stop',
        content: []
      }
    });

    const response = transformer.buildNonStreamingResponse();
    const toolUseBlocks = response.content.filter(b => b.type === 'tool_use');

    expect(toolUseBlocks.length).toBe(1);
    expect(toolUseBlocks[0].name).toBe('Edit');
    // The full value including </parameter> should be captured
    expect(toolUseBlocks[0].input.oldString).toBe('Text with </parameter> tag in it');
    expect(toolUseBlocks[0].input.newString).toBe('Replacement text');
  });

  it('parses invoke blocks containing closing tag text in JSON', () => {
    const transformer = new HopGPTToAnthropicTransformer('claude-sonnet-4-5-thinking', {
      thinkingEnabled: false
    });

    const events = [];
    const pushEvents = (data) => {
      const result = transformer.transformEvent({
        event: 'message',
        data: JSON.stringify(data)
      });
      if (result) {
        events.push(...(Array.isArray(result) ? result : [result]));
      }
    };

    // Invoke block with JSON containing </invoke> as a string value
    const functionCalls = `<function_calls>
<invoke name="Write">
<parameter name="content">{"example": "text with </invoke> tag"}</parameter>
</invoke>
<invoke name="Read">
<parameter name="path">/tmp/file.txt</parameter>
</invoke>
</function_calls>`;

    pushEvents({ created: true, message: { id: 'msg-create' } });
    pushEvents({
      event: 'on_message_delta',
      data: {
        delta: {
          content: [
            { type: 'text', text: functionCalls }
          ]
        }
      }
    });
    pushEvents({
      final: true,
      responseMessage: {
        messageId: 'msg-final',
        promptTokens: 0,
        tokenCount: 0,
        stopReason: 'stop',
        content: []
      }
    });

    const response = transformer.buildNonStreamingResponse();
    const toolUseBlocks = response.content.filter(b => b.type === 'tool_use');

    // Both invoke blocks should be parsed
    expect(toolUseBlocks.length).toBe(2);
    expect(toolUseBlocks[0].name).toBe('Write');
    expect(toolUseBlocks[0].input.content).toBe('{"example": "text with </invoke> tag"}');
    expect(toolUseBlocks[1].name).toBe('Read');
    expect(toolUseBlocks[1].input.path).toBe('/tmp/file.txt');
  });

  it('parses MCP tool calls with nested closing tags in arguments', () => {
    const transformer = new HopGPTToAnthropicTransformer('claude-sonnet-4-5-thinking', {
      thinkingEnabled: false
    });

    const events = [];
    const pushEvents = (data) => {
      const result = transformer.transformEvent({
        event: 'message',
        data: JSON.stringify(data)
      });
      if (result) {
        events.push(...(Array.isArray(result) ? result : [result]));
      }
    };

    // MCP tool call with </arguments> in the JSON content
    const mcpToolCall = `<mcp_tool_call>
<server_name>test-server</server_name>
<tool_name>process_xml</tool_name>
<arguments>{"xml": "<data></arguments></data>", "mode": "parse"}</arguments>
</mcp_tool_call>`;

    pushEvents({ created: true, message: { id: 'msg-create' } });
    pushEvents({
      event: 'on_message_delta',
      data: {
        delta: {
          content: [
            { type: 'text', text: mcpToolCall }
          ]
        }
      }
    });
    pushEvents({
      final: true,
      responseMessage: {
        messageId: 'msg-final',
        promptTokens: 0,
        tokenCount: 0,
        stopReason: 'stop',
        content: []
      }
    });

    const response = transformer.buildNonStreamingResponse();
    const toolUseBlocks = response.content.filter(b => b.type === 'tool_use');

    expect(toolUseBlocks.length).toBe(1);
    expect(toolUseBlocks[0].name).toBe('process_xml');
    expect(toolUseBlocks[0].input.xml).toBe('<data></arguments></data>');
    expect(toolUseBlocks[0].input.mode).toBe('parse');
  });

  it('parses tool_call blocks with closing tag in JSON string', () => {
    const transformer = new HopGPTToAnthropicTransformer('claude-sonnet-4-5-thinking', {
      thinkingEnabled: false
    });

    const events = [];
    const pushEvents = (data) => {
      const result = transformer.transformEvent({
        event: 'message',
        data: JSON.stringify(data)
      });
      if (result) {
        events.push(...(Array.isArray(result) ? result : [result]));
      }
    };

    // tool_call with </tool_call> in the JSON content
    const toolCall = `<tool_call>
{"name": "edit", "parameters": {"oldString": "match </tool_call> text", "newString": "replaced"}}
</tool_call>`;

    pushEvents({ created: true, message: { id: 'msg-create' } });
    pushEvents({
      event: 'on_message_delta',
      data: {
        delta: {
          content: [
            { type: 'text', text: toolCall }
          ]
        }
      }
    });
    pushEvents({
      final: true,
      responseMessage: {
        messageId: 'msg-final',
        promptTokens: 0,
        tokenCount: 0,
        stopReason: 'stop',
        content: []
      }
    });

    const response = transformer.buildNonStreamingResponse();
    const toolUseBlocks = response.content.filter(b => b.type === 'tool_use');

    expect(toolUseBlocks.length).toBe(1);
    expect(toolUseBlocks[0].name).toBe('edit');
    expect(toolUseBlocks[0].input.oldString).toBe('match </tool_call> text');
    expect(toolUseBlocks[0].input.newString).toBe('replaced');
  });

  it('handles escaped quotes in XML attribute values', () => {
    const transformer = new HopGPTToAnthropicTransformer('claude-sonnet-4-5-thinking', {
      thinkingEnabled: false
    });

    const events = [];
    const pushEvents = (data) => {
      const result = transformer.transformEvent({
        event: 'message',
        data: JSON.stringify(data)
      });
      if (result) {
        events.push(...(Array.isArray(result) ? result : [result]));
      }
    };

    // Tool use with escaped quote in attribute
    const toolUse = `<tool_use id="toolu_123" name="test_tool">
{"key": "value"}
</tool_use>`;

    pushEvents({ created: true, message: { id: 'msg-create' } });
    pushEvents({
      event: 'on_message_delta',
      data: {
        delta: {
          content: [
            { type: 'text', text: toolUse }
          ]
        }
      }
    });
    pushEvents({
      final: true,
      responseMessage: {
        messageId: 'msg-final',
        promptTokens: 0,
        tokenCount: 0,
        stopReason: 'stop',
        content: []
      }
    });

    const response = transformer.buildNonStreamingResponse();
    const toolUseBlocks = response.content.filter(b => b.type === 'tool_use');

    expect(toolUseBlocks.length).toBe(1);
    expect(toolUseBlocks[0].name).toBe('test_tool');
    expect(toolUseBlocks[0].id).toBe('toolu_123');
  });
});

describe('HopGPTToAnthropicTransformer drift logging', () => {
  it('emits a debug log when encountering an unknown event shape', async () => {
    const { HopGPTToAnthropicTransformer } = await import('../../src/transformers/hopGPTToAnthropic.js');
    const { loggers } = await import('../../src/utils/logger.js');
    const debugSpy = vi.spyOn(loggers.transform, 'debug').mockImplementation(() => {});
    const transformer = new HopGPTToAnthropicTransformer('claude-sonnet-4-5');
    const result = transformer.transformEvent({ event: 'message', data: JSON.stringify({ event: 'made_up_event', data: {} }) });
    expect(result).toBeNull();
    const matched = debugSpy.mock.calls.some(([msg]) => typeof msg === 'string' && msg.includes('Unknown HopGPT event'));
    expect(matched).toBe(true);
    debugSpy.mockRestore();
  });
});
