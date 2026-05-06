import { transformTools } from '../src/transformers/anthropicToHopGPT.js';

const mockTools = [
  {
    name: 'test_tool',
    description: 'A test tool',
    input_schema: {
      type: 'object',
      properties: {
        arg: { type: 'string' },
      },
    },
  },
];

const transformed = transformTools(mockTools);
const tool = transformed[0];

console.log('Transformed Tool:', JSON.stringify(tool, null, 2));

if (tool.input_schema && tool.parameters) {
  console.log('SUCCESS: Tool has both input_schema and parameters');
  process.exit(0);
} else {
  console.error('FAILURE: Tool missing required fields');
  process.exit(1);
}
