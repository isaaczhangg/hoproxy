import { HopGPTToAnthropicTransformer } from '../src/transformers/hopGPTToAnthropic.js';

// Mock process.env
process.env.HOPGPT_DEBUG = 'true';

async function testTransformer() {
  const transformer = new HopGPTToAnthropicTransformer('claude-opus-4.5', {
    mcpPassthrough: false,
  });

  // Simulate usage of the transformer with chunks
  // This mimics what handleStreamingRequest does

  // 1. Message start (HopGPT format)
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
  const startResult = transformer.transformEvent(startEvent);
  console.log('Start Result:', JSON.stringify(startResult, null, 2));

  // 2. Chunks representing text then a tool call split across chunks
  const chunks = [
    'Here is the tool call:\n\n',
    '<tool_',
    'call>\n',
    '{"name": "Glob", "parameters": {"pattern": "**/*"}}\n',
    '</tool_call>',
  ];

  for (const chunk of chunks) {
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

    console.log(`--- Processing chunk: ${JSON.stringify(chunk)} ---`);
    const result = transformer.transformEvent(event);
    if (result) {
      console.log('Result:', JSON.stringify(result, null, 2));
    }
  }
}

testTransformer().catch(console.error);
