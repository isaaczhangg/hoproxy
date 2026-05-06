import { HopGPTToAnthropicTransformer } from '../src/transformers/hopGPTToAnthropic.js';

// Mock process.env
process.env.HOPGPT_DEBUG = 'true';

async function testTransformer() {
  const transformer = new HopGPTToAnthropicTransformer('claude-opus-4.5', {
    mcpPassthrough: false,
  });

  // 1. Message start
  const startEvent = {
    event: 'message_start',
    data: JSON.stringify({
      created: true,
      message: {
        id: 'msg_123',
        role: 'assistant',
        content: [],
      },
    }),
  };

  console.log('--- Transform Start ---');
  transformer.transformEvent(startEvent);

  // 2. Test invalid JSON in tool call
  // This simulates a common failure mode where the model fails to escape characters in code
  const chunk =
    '<tool_call>{"name": "Edit", "parameters": {"path": "foo.txt", "content": "uncaptured " quote"}}</tool_call>';

  const event = {
    event: 'on_message_delta',
    data: JSON.stringify({
      event: 'on_message_delta',
      data: {
        delta: {
          content: [{ type: 'text', text: chunk }],
        },
      },
    }),
  };

  console.log(`--- Processing chunk with INVALID JSON ---`);
  console.log(`Chunk: ${chunk}`);
  const result = transformer.transformEvent(event);

  console.log('Result:', JSON.stringify(result, null, 2));

  if (!result || result.length === 0) {
    console.log('FAIL: The transformer returned no events, meaning the text was dropped!');
  } else {
    console.log('SUCCESS: The transformer returned events.');
  }

  // 3. Test Valid JSON to compare
  const validChunk = '<tool_call>{"name": "Read", "parameters": {"path": "foo.txt"}}</tool_call>';
  const eventValid = {
    event: 'on_message_delta',
    data: JSON.stringify({
      event: 'on_message_delta',
      data: {
        delta: {
          content: [{ type: 'text', text: validChunk }],
        },
      },
    }),
  };
  console.log(`\n--- Processing chunk with VALID JSON ---`);
  const resultValid = transformer.transformEvent(eventValid);
  console.log('Result:', JSON.stringify(resultValid, null, 2));
}

testTransformer().catch(console.error);
