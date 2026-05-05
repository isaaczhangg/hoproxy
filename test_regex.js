const text =
  'Let me check: <' +
  'antml:function_calls>' +
  '<' +
  'antml:invoke name="Bash"></' +
  'antml:invoke>' +
  '</' +
  'antml:function_calls> Done.';
const re = /<(?:antml:)?function_calls\b[\s\S]*?<\/(?:antml:)?function_calls>/gi;
console.log('Text:', text);
console.log('Text contains antml:', text.includes('antml:'));
console.log('Match result:', text.match(re));
