import crypto from 'node:crypto';
import { v4 as uuidv4 } from 'uuid';
import { loggers } from '../utils/logger.js';
import { isThinkingModel } from './hopGPTToAnthropic.js';
import { prepareMessagesForThinking } from './thinkingUtils.js';

const log = loggers.transform;

function resolveDisableParallelToolUse(toolChoice) {
  if (!toolChoice || typeof toolChoice !== 'object') {
    return false;
  }

  const hasSnakeCaseFlag = toolChoice.disable_parallel_tool_use === true;
  const hasCamelCaseFlag = toolChoice.disableParallelToolUse === true;

  return hasSnakeCaseFlag || hasCamelCaseFlag;
}

export function getToolChoiceConfig(toolChoice) {
  const config = {
    mustUseTool: false,
    forcedToolName: null,
    allowTools: true,
    disableParallelToolUse: resolveDisableParallelToolUse(toolChoice),
  };

  if (!toolChoice) {
    return config;
  }

  if (typeof toolChoice === 'string') {
    if (toolChoice === 'none') {
      config.allowTools = false;
    }
    if (toolChoice === 'any' || toolChoice === 'required') {
      config.mustUseTool = true;
    }
    return config;
  }

  if (typeof toolChoice === 'object') {
    if (toolChoice.type === 'none') {
      config.allowTools = false;
      return config;
    }
    if (toolChoice.type === 'any') {
      config.mustUseTool = true;
      return config;
    }
    if (toolChoice.type === 'tool' && toolChoice.name) {
      config.mustUseTool = true;
      config.forcedToolName = toolChoice.name;
      return config;
    }
    if (toolChoice.type === 'function' && toolChoice.function?.name) {
      config.mustUseTool = true;
      config.forcedToolName = toolChoice.function.name;
      return config;
    }
    if (toolChoice.name) {
      config.mustUseTool = true;
      config.forcedToolName = toolChoice.name;
    } else if (toolChoice.function?.name) {
      config.mustUseTool = true;
      config.forcedToolName = toolChoice.function.name;
    }
    return config;
  }

  return config;
}

function buildToolInjectionPrompt(tools, toolChoice, options = {}) {
  if (!tools || !Array.isArray(tools) || tools.length === 0) {
    return '';
  }

  const toolChoiceConfig = getToolChoiceConfig(toolChoice);
  const toolNames = tools.map((tool) => tool.name).filter(Boolean);

  let prompt = options.compact
    ? `\n\n# Tool Use Reminder\n\nThe available tool definitions are unchanged from earlier in this conversation. Available tools: ${toolNames.join(', ')}.\n`
    : `\n\n# Available Tools\n\nYou have access to the following tools. To use tools, output Anthropic-style XML in this exact shape:\n\n<function_calls>\n<invoke name="tool_name">\n<parameter name="param1">value1</parameter>\n<parameter name="param2">value2</parameter>\n</invoke>\n</function_calls>\n\nUse one <invoke> per tool call. For object or array parameters, put compact JSON inside the matching <parameter> tag. If a tool has no parameters, omit parameter tags. Do not use Markdown fences around tool calls.\n`;

  if (toolChoiceConfig.allowTools === false) {
    prompt += `Tool use is disabled for this response. Do not call any tools.\n`;
  } else {
    prompt += `If you call tools, respond with ONLY the <function_calls> block and no extra text. Do not narrate before, between, or after tool calls. If you are not calling a tool, respond normally without any <function_calls> block.\n`;
    if (toolChoiceConfig.disableParallelToolUse) {
      prompt += `Call at most one tool per response, then wait for tool results before calling another tool.\n`;
    }
  }

  if (options.compact) {
    prompt += buildToolChoiceInstruction(toolChoiceConfig);
    return prompt;
  }

  prompt += `\n## Tool Definitions\n\n`;

  for (const tool of tools) {
    const schema = tool.input_schema || tool.parameters || { type: 'object', properties: {} };
    const properties = schema.properties || {};
    const required = Array.isArray(schema.required) ? schema.required : [];

    prompt += `### ${tool.name}\n`;
    if (tool.description) {
      prompt += `${truncateToolDescription(tool.description)}\n\n`;
    }

    if (Object.keys(properties).length > 0) {
      prompt += `Parameters:\n`;
      for (const [paramName, paramDef] of Object.entries(properties)) {
        const reqMark = required.includes(paramName) ? ' (required)' : '';
        const paramType = describeSchemaType(paramDef);
        const paramDesc = paramDef.description
          ? `: ${truncateSchemaDescription(paramDef.description)}`
          : '';
        const enumHint = formatEnumHint(paramDef);
        prompt += `- ${paramName}${reqMark} [${paramType}]${paramDesc}${enumHint}\n`;
        const detailLines = formatSchemaDetailLines(paramDef, 1);
        for (const line of detailLines) {
          prompt += `${line}\n`;
        }
      }
      prompt += '\n';
    }
  }

  prompt += buildToolChoiceInstruction(toolChoiceConfig);

  return prompt;
}

function buildToolChoiceInstruction(toolChoiceConfig) {
  let prompt = '';
  if (toolChoiceConfig.forcedToolName) {
    prompt += `\nYou MUST use the "${toolChoiceConfig.forcedToolName}" tool in your response.\n`;
  } else if (toolChoiceConfig.mustUseTool) {
    prompt += `\nYou MUST use at least one tool in your response.\n`;
  }

  if (toolChoiceConfig.allowTools !== false) {
    prompt += `\nIf you need more information to call a tool, ask a brief clarifying question instead of guessing.\n`;
    if (toolChoiceConfig.disableParallelToolUse) {
      prompt += `Call at most one tool per response. After calling a tool, wait for the result before proceeding.\n`;
    } else {
      prompt += `Prefer one contiguous <function_calls> batch containing every independent tool call you can determine now. After calling tool(s), wait for the result(s) before proceeding.\n`;
    }
  }
  return prompt;
}

const DEFAULT_TOOL_SCHEMA = {
  type: 'object',
  properties: {},
  required: [],
};

function normalizeSchemaType(type, schema) {
  if (Array.isArray(type)) {
    const filtered = type.filter((value) => value && value !== 'null');
    return filtered.length > 0 ? filtered[0] : null;
  }
  if (typeof type === 'string') {
    return type;
  }
  if (schema?.properties) {
    return 'object';
  }
  if (schema?.items) {
    return 'array';
  }
  return null;
}

function scoreSchemaOption(schema) {
  if (!schema || typeof schema !== 'object') {
    return -1;
  }

  const type = normalizeSchemaType(schema.type, schema);
  let score = 0;

  if (type === 'object' || schema.properties) {
    score += 5;
  }

  if (schema.properties && typeof schema.properties === 'object') {
    score += Math.min(Object.keys(schema.properties).length, 10);
  }

  if (Array.isArray(schema.required)) {
    score += Math.min(schema.required.length, 5);
  }

  if (schema.description) {
    score += 1;
  }

  if (Array.isArray(schema.enum)) {
    score += Math.min(schema.enum.length, 3);
  }

  return score;
}

function pickBestSchemaOption(options) {
  let best = null;
  let bestScore = -1;

  for (const option of options) {
    const score = scoreSchemaOption(option);
    if (score > bestScore) {
      bestScore = score;
      best = option;
    }
  }

  return best || options[0] || null;
}

function mergeSchemas(baseSchema, extraSchema) {
  const base = baseSchema && typeof baseSchema === 'object' ? baseSchema : {};
  const extra = extraSchema && typeof extraSchema === 'object' ? extraSchema : {};

  const merged = { ...base, ...extra };

  const baseProps = base.properties && typeof base.properties === 'object' ? base.properties : {};
  const extraProps =
    extra.properties && typeof extra.properties === 'object' ? extra.properties : {};
  merged.properties = { ...baseProps, ...extraProps };

  const required = new Set();
  if (Array.isArray(base.required)) {
    for (const item of base.required) {
      required.add(item);
    }
  }
  if (Array.isArray(extra.required)) {
    for (const item of extra.required) {
      required.add(item);
    }
  }
  if (required.size > 0) {
    merged.required = Array.from(required);
  }

  return merged;
}

function resolveSchema(schema, depth = 0) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    return null;
  }

  if (depth > 6) {
    return schema;
  }

  if (
    schema.$ref &&
    !schema.properties &&
    !schema.items &&
    !schema.allOf &&
    !schema.anyOf &&
    !schema.oneOf
  ) {
    const description = schema.description
      ? `${schema.description} (ref: ${schema.$ref})`
      : `Schema reference: ${schema.$ref}`;
    return { type: schema.type || 'string', description };
  }

  if (Array.isArray(schema.allOf) && schema.allOf.length > 0) {
    const base = { ...schema };
    delete base.allOf;
    let merged = base;
    for (const option of schema.allOf) {
      merged = mergeSchemas(merged, option);
    }
    return resolveSchema(merged, depth + 1);
  }

  if (Array.isArray(schema.anyOf) && schema.anyOf.length > 0) {
    const base = { ...schema };
    delete base.anyOf;
    const best = pickBestSchemaOption(schema.anyOf);
    return resolveSchema(mergeSchemas(base, best), depth + 1);
  }

  if (Array.isArray(schema.oneOf) && schema.oneOf.length > 0) {
    const base = { ...schema };
    delete base.oneOf;
    const best = pickBestSchemaOption(schema.oneOf);
    return resolveSchema(mergeSchemas(base, best), depth + 1);
  }

  return schema;
}

function sanitizeSchemaNode(schema, depth = 0) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    return {};
  }

  if (depth > 6) {
    return {};
  }

  const resolved = resolveSchema(schema, depth);
  if (!resolved || typeof resolved !== 'object') {
    return {};
  }

  const node = {};
  const type = normalizeSchemaType(resolved.type, resolved);
  if (type) {
    node.type = type;
  }

  const descriptionHints = [];
  if (typeof resolved.description === 'string' && resolved.description.trim().length > 0) {
    descriptionHints.push(resolved.description.trim());
  }

  if (resolved.const !== undefined && !Array.isArray(resolved.enum)) {
    node.enum = [resolved.const];
  }

  if (Array.isArray(resolved.enum)) {
    node.enum = resolved.enum;
  }

  const constraintHint = formatConstraintHint(resolved);
  if (constraintHint) {
    descriptionHints.push(constraintHint);
  }

  if (resolved.additionalProperties === false) {
    descriptionHints.push('No extra properties allowed');
  }

  if (descriptionHints.length > 0) {
    node.description = descriptionHints.join(' ');
  }

  if (resolved.items) {
    node.items = sanitizeSchemaNode(resolved.items, depth + 1);
  }

  if (resolved.properties && typeof resolved.properties === 'object') {
    node.type = node.type || 'object';
    node.properties = {};
    for (const [key, value] of Object.entries(resolved.properties)) {
      node.properties[key] = sanitizeSchemaNode(value, depth + 1);
    }

    if (Array.isArray(resolved.required)) {
      node.required = resolved.required.filter((item) => typeof item === 'string');
    }
  }

  return node;
}

function formatConstraintHint(schema) {
  if (!schema || typeof schema !== 'object') {
    return '';
  }
  const hints = [];
  const constraints = [
    ['minLength', 'minLength'],
    ['maxLength', 'maxLength'],
    ['pattern', 'pattern'],
    ['minimum', 'minimum'],
    ['maximum', 'maximum'],
    ['exclusiveMinimum', 'exclusiveMinimum'],
    ['exclusiveMaximum', 'exclusiveMaximum'],
    ['minItems', 'minItems'],
    ['maxItems', 'maxItems'],
    ['format', 'format'],
  ];
  for (const [key, label] of constraints) {
    const value = schema[key];
    if (value !== undefined && value !== null && typeof value !== 'object') {
      hints.push(`${label}: ${value}`);
    }
  }
  return hints.length > 0 ? `Constraints: ${hints.join(', ')}` : '';
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  const entries = Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`);
  return `{${entries.join(',')}}`;
}

function hashToolDefinitions(tools) {
  if (!Array.isArray(tools) || tools.length === 0) {
    return null;
  }
  return crypto.createHash('sha256').update(stableStringify(tools)).digest('hex');
}

function sanitizeToolSchema(schema) {
  const sanitized = sanitizeSchemaNode(schema);
  const normalized = { ...DEFAULT_TOOL_SCHEMA, ...sanitized };

  if (!normalized.properties || typeof normalized.properties !== 'object') {
    normalized.properties = {};
  }

  if (!Array.isArray(normalized.required)) {
    normalized.required = [];
  }

  if (normalized.type !== 'object' && Object.keys(normalized.properties).length === 0) {
    return {
      type: 'object',
      properties: {
        input: sanitized.type ? sanitized : { type: 'string' },
      },
      required: [],
    };
  }

  normalized.type = 'object';
  return normalized;
}

function normalizeToolDefinition(tool, index) {
  if (!tool || typeof tool !== 'object') {
    return null;
  }

  const functionTool = tool.function || tool.custom || null;
  const rawName = tool.name || functionTool?.name || tool.custom?.name;
  const name =
    typeof rawName === 'string' && rawName.trim().length > 0 ? rawName.trim() : `tool-${index + 1}`;
  const description =
    tool.description || functionTool?.description || tool.custom?.description || '';
  const rawSchema =
    tool.input_schema ||
    tool.parameters ||
    functionTool?.input_schema ||
    functionTool?.parameters ||
    tool.custom?.input_schema ||
    tool.custom?.parameters;

  return {
    name: String(name),
    description: typeof description === 'string' ? description : '',
    input_schema: sanitizeToolSchema(rawSchema),
  };
}

function normalizeToolDefinitions(tools) {
  if (!Array.isArray(tools)) {
    return [];
  }

  const normalized = [];
  tools.forEach((tool, index) => {
    const resolved = normalizeToolDefinition(tool, index);
    if (resolved) {
      normalized.push(resolved);
    }
  });

  return normalized;
}

function describeSchemaType(schema) {
  if (!schema || typeof schema !== 'object') {
    return 'any';
  }

  if (Array.isArray(schema.type)) {
    return schema.type.join(' | ');
  }

  if (typeof schema.type === 'string') {
    return schema.type;
  }

  if (schema.enum) {
    return 'enum';
  }

  if (schema.properties) {
    return 'object';
  }

  if (schema.items) {
    return 'array';
  }

  return 'any';
}

const MAX_SCHEMA_DEPTH = 4;
const MAX_SCHEMA_PROPERTIES = 12;
const MAX_TOOL_DESCRIPTION_CHARS = 4000;
const MAX_PARAM_DESCRIPTION_CHARS = 2000;
const MAX_ENUM_VALUES = 32;
const MAX_ENUM_VALUE_CHARS = 80;

function truncateToolDescription(value) {
  if (typeof value !== 'string') {
    return '';
  }
  return value.length > MAX_TOOL_DESCRIPTION_CHARS
    ? `${value.slice(0, MAX_TOOL_DESCRIPTION_CHARS)}...`
    : value;
}

function truncateSchemaDescription(value) {
  if (typeof value !== 'string') {
    return '';
  }
  return value.length > MAX_PARAM_DESCRIPTION_CHARS
    ? `${value.slice(0, MAX_PARAM_DESCRIPTION_CHARS)}...`
    : value;
}

function formatEnumHint(schema) {
  if (!schema || typeof schema !== 'object') {
    return '';
  }
  const values = Array.isArray(schema.enum) ? schema.enum : null;
  if (!values || values.length === 0) {
    return '';
  }

  const rendered = [];
  for (const value of values.slice(0, MAX_ENUM_VALUES)) {
    if (value === null) {
      rendered.push('null');
      continue;
    }
    const type = typeof value;
    if (type === 'string') {
      const trimmed =
        value.length > MAX_ENUM_VALUE_CHARS ? `${value.slice(0, MAX_ENUM_VALUE_CHARS)}...` : value;
      rendered.push(JSON.stringify(trimmed));
    } else if (type === 'number' || type === 'boolean') {
      rendered.push(String(value));
    }
  }

  if (rendered.length === 0) {
    return '';
  }

  const suffix =
    values.length > MAX_ENUM_VALUES ? `, ... (${values.length - MAX_ENUM_VALUES} more)` : '';
  return ` — allowed: ${rendered.join(', ')}${suffix}`;
}

function formatSchemaDetailLines(schema, depth = 0) {
  if (!schema || typeof schema !== 'object' || depth >= MAX_SCHEMA_DEPTH) {
    return [];
  }

  const lines = [];
  const indent = '  '.repeat(depth);

  if (schema.items && typeof schema.items === 'object') {
    const itemType = describeSchemaType(schema.items);
    const itemDesc = schema.items.description
      ? `: ${truncateSchemaDescription(schema.items.description)}`
      : '';
    const itemEnum = formatEnumHint(schema.items);
    lines.push(`${indent}- items [${itemType}]${itemDesc}${itemEnum}`);
    lines.push(...formatSchemaDetailLines(schema.items, depth + 1));
  }

  if (schema.properties && typeof schema.properties === 'object') {
    const required = new Set(Array.isArray(schema.required) ? schema.required : []);
    const entries = Object.entries(schema.properties);
    for (const [name, propSchema] of entries.slice(0, MAX_SCHEMA_PROPERTIES)) {
      const reqMark = required.has(name) ? ' (required)' : '';
      const propType = describeSchemaType(propSchema);
      const propDesc = propSchema.description
        ? `: ${truncateSchemaDescription(propSchema.description)}`
        : '';
      const propEnum = formatEnumHint(propSchema);
      lines.push(`${indent}- ${name}${reqMark} [${propType}]${propDesc}${propEnum}`);
      lines.push(...formatSchemaDetailLines(propSchema, depth + 1));
    }
    if (entries.length > MAX_SCHEMA_PROPERTIES) {
      lines.push(`${indent}- ... (${entries.length - MAX_SCHEMA_PROPERTIES} more)`);
    }
  }

  return lines;
}

export function transformTools(tools) {
  const normalizedTools = normalizeToolDefinitions(tools);
  if (normalizedTools.length === 0) {
    return null;
  }

  return normalizedTools.map((tool) => ({
    name: tool.name,
    description: tool.description || '',
    input_schema: tool.input_schema,
    parameters: tool.input_schema,
  }));
}

export function transformToolChoice(toolChoice) {
  if (!toolChoice) {
    return null;
  }

  const toolChoiceConfig = getToolChoiceConfig(toolChoice);
  const applyDisableParallel = (value) =>
    toolChoiceConfig.disableParallelToolUse ? { ...value, disable_parallel_tool_use: true } : value;

  if (typeof toolChoice === 'string') {
    if (toolChoice === 'auto') {
      return applyDisableParallel({ type: 'auto' });
    }
    if (toolChoice === 'any') {
      return applyDisableParallel({ type: 'required' });
    }
    if (toolChoice === 'required') {
      return applyDisableParallel({ type: 'required' });
    }
    if (toolChoice === 'none') {
      return applyDisableParallel({ type: 'none' });
    }
  }

  if (typeof toolChoice === 'object') {
    if (toolChoice.type === 'auto') {
      return applyDisableParallel({ type: 'auto' });
    }
    if (toolChoice.type === 'any') {
      return applyDisableParallel({ type: 'required' });
    }
    if (toolChoice.type === 'tool') {
      return applyDisableParallel({
        type: 'function',
        function: { name: toolChoice.name },
      });
    }
    if (toolChoice.type === 'function' && toolChoice.function?.name) {
      return applyDisableParallel({
        type: 'function',
        function: { name: toolChoice.function.name },
      });
    }
  }

  return null;
}

function formatToolUseBlock(block) {
  const inputStr =
    typeof block.input === 'string' ? block.input : JSON.stringify(block.input, null, 2);
  return `<tool_use id="${block.id}" name="${block.name}">\n${inputStr}\n</tool_use>`;
}

function formatToolResultBlock(block) {
  let content = '';
  if (typeof block.content === 'string') {
    content = block.content;
  } else if (Array.isArray(block.content)) {
    content = block.content
      .map((c) => {
        if (!c || typeof c !== 'object') {
          return String(c ?? '');
        }
        if (c.type === 'text' && typeof c.text === 'string') {
          return c.text;
        }
        return JSON.stringify(c);
      })
      .join('\n');
  } else if (block.content !== undefined) {
    content = JSON.stringify(block.content);
  }

  const errorAttr = block.is_error ? ' is_error="true"' : '';
  return `<tool_result tool_use_id="${block.tool_use_id}"${errorAttr}>\n${content}\n</tool_result>`;
}

function extractMessageContent(message) {
  if (typeof message.content === 'string') {
    return message.content;
  }

  if (!Array.isArray(message.content)) {
    return '';
  }

  const parts = [];
  for (const block of message.content) {
    if (block.type === 'text') {
      parts.push(block.text);
    } else if (block.type === 'tool_use') {
      parts.push(formatToolUseBlock(block));
    } else if (block.type === 'tool_result') {
      parts.push(formatToolResultBlock(block));
    }
  }

  return parts.join('\n\n');
}

export function normalizeSystemPrompt(system) {
  if (!system) {
    return null;
  }

  if (typeof system === 'string') {
    return system.trim().length > 0 ? system : null;
  }

  if (Array.isArray(system)) {
    const parts = [];
    for (const block of system) {
      if (block?.type === 'text' && typeof block.text === 'string') {
        parts.push(block.text);
      }
    }
    const combined = parts.join('\n');
    return combined.trim().length > 0 ? combined : null;
  }

  return null;
}

export function normalizeMaxTokens(value) {
  if (!Number.isFinite(value)) {
    return null;
  }
  const intValue = Math.floor(value);
  return intValue > 0 ? intValue : null;
}

function normalizeFiniteNumber(value) {
  return Number.isFinite(value) ? value : null;
}

export function normalizeStopSequences(value) {
  if (Array.isArray(value)) {
    return value.filter((seq) => typeof seq === 'string' && seq.length > 0);
  }
  if (typeof value === 'string' && value.length > 0) {
    return [value];
  }
  return [];
}

export function extractThinkingConfig(anthropicRequest) {
  const { model, thinking, output_config } = anthropicRequest;

  if (thinking) {
    return {
      enabled: thinking.type === 'enabled' || thinking.type === 'adaptive',
      budgetTokens: thinking.budget_tokens || null,
      type: thinking.type,
      effort: typeof output_config?.effort === 'string' ? output_config.effort : null,
    };
  }

  return {
    enabled: isThinkingModel(model),
    budgetTokens: null,
    type: null,
    effort: null,
  };
}

function extractTextAndImages(content, imageDetail) {
  if (typeof content === 'string') {
    return { text: content, images: [] };
  }

  if (!Array.isArray(content)) {
    return { text: '', images: [] };
  }

  const textParts = [];
  const images = [];

  for (const block of content) {
    if (!block) continue;
    if (block.type === 'text' && typeof block.text === 'string') {
      textParts.push(block.text);
      continue;
    }

    if (block.type === 'tool_use') {
      textParts.push(formatToolUseBlock(block));
      continue;
    }

    if (block.type === 'tool_result') {
      textParts.push(formatToolResultBlock(block));
      continue;
    }

    if (block.type === 'image' && block.source) {
      if (block.source.type === 'base64' && block.source.data && block.source.media_type) {
        images.push({
          type: 'image_url',
          image_url: {
            url: `data:${block.source.media_type};base64,${block.source.data}`,
            detail: imageDetail,
          },
        });
      } else if (block.source.type === 'url' && block.source.url) {
        images.push({
          type: 'image_url',
          image_url: {
            url: block.source.url,
            detail: imageDetail,
          },
        });
      }
    }
  }

  return { text: textParts.join('\n'), images };
}

function findLastAssistantMessageIndex(messages) {
  if (!Array.isArray(messages)) {
    return -1;
  }

  for (let i = messages.length - 1; i >= 0; i--) {
    const role = messages[i]?.role;
    if (role === 'assistant' || role === 'model') {
      return i;
    }
  }

  return -1;
}

function messageHasContentBlock(message, blockType) {
  if (!Array.isArray(message?.content)) {
    return false;
  }
  return message.content.some((block) => block?.type === blockType);
}

function findLastAssistantToolUseIndex(messages, beforeIndex) {
  if (!Array.isArray(messages)) {
    return -1;
  }

  for (let i = Math.min(beforeIndex, messages.length - 1); i >= 0; i--) {
    const message = messages[i];
    if (
      (message?.role === 'assistant' || message?.role === 'model') &&
      messageHasContentBlock(message, 'tool_use')
    ) {
      return i;
    }
  }

  return -1;
}

function collectImagesFromMessages(messages, imageDetail) {
  const images = [];

  for (const message of messages) {
    if (!Array.isArray(message?.content)) {
      continue;
    }
    images.push(...extractTextAndImages(message.content, imageDetail).images);
  }

  return images;
}

export function transformAnthropicToHopGPT(anthropicRequest, conversationState = null) {
  const {
    model,
    messages,
    system,
    tools,
    tool_choice,
    max_tokens,
    temperature,
    top_p,
    top_k,
    stop_sequences,
    stop,
  } = anthropicRequest;

  log.debug('Transforming Anthropic request to HopGPT', {
    model,
    messageCount: messages?.length || 0,
    hasSystem: !!system,
    toolCount: tools?.length || 0,
    hasToolChoice: !!tool_choice,
    maxTokens: max_tokens,
  });

  const imageDetail = 'high';
  // NOTE: Do NOT use a stop sequence that matches tool call markup. Some backends
  // strip stop sequences from output, which would truncate XML tool calls and
  // break parsing. Use a sentinel that is unlikely to appear in model output.
  const toolCallStopSequence = '<|hopgpt_tool_stop|>';
  const normalizedTools = normalizeToolDefinitions(tools);
  const toolPromptHash = hashToolDefinitions(normalizedTools);

  const thinkingConfig = extractThinkingConfig(anthropicRequest);
  const processedMessages = prepareMessagesForThinking(messages, {
    targetFamily: 'claude',
    thinkingEnabled: thinkingConfig.enabled,
  });
  const thinkingRecoveryInsertedMessages =
    Array.isArray(messages) && processedMessages.length > messages.length;
  const originalLastAssistantIndex = findLastAssistantMessageIndex(messages);
  const normalizedSystem = normalizeSystemPrompt(system);
  const stateSystem = normalizeSystemPrompt(
    conversationState?.systemPrompt ?? conversationState?.system,
  );
  const systemText = normalizedSystem ?? stateSystem;
  const systemChanged = normalizedSystem && stateSystem && normalizedSystem !== stateSystem;
  const isNewConversation = !conversationState?.lastAssistantMessageId;

  const latestMessage = processedMessages[processedMessages.length - 1];

  let text = '';
  let images = [];
  if (typeof latestMessage.content === 'string') {
    text = latestMessage.content;
  } else if (Array.isArray(latestMessage.content)) {
    const extracted = extractTextAndImages(latestMessage.content, imageDetail);
    text = extracted.text;
    images = extracted.images;
  }

  const shouldIncludeHistory = isNewConversation && processedMessages.length > 1;
  if (shouldIncludeHistory) {
    text = buildConversationText(processedMessages, systemText);
  } else {
    const latestMessageHasToolResult = messageHasContentBlock(latestMessage, 'tool_result');
    const lastToolUseIndex = latestMessageHasToolResult
      ? findLastAssistantToolUseIndex(processedMessages, processedMessages.length - 2)
      : -1;
    let replayedToolContext = false;
    if (lastToolUseIndex >= 0) {
      const currentToolTurnMessages = processedMessages.slice(lastToolUseIndex);
      const currentToolTurnText = buildConversationText(currentToolTurnMessages);
      if (currentToolTurnText) {
        text = currentToolTurnText;
        replayedToolContext = true;
      }
      images = collectImagesFromMessages(currentToolTurnMessages, imageDetail);
    }

    if (
      !replayedToolContext &&
      thinkingRecoveryInsertedMessages &&
      originalLastAssistantIndex >= 0
    ) {
      const currentTurnMessages = processedMessages.slice(originalLastAssistantIndex + 1);
      const currentTurnText = buildConversationText(currentTurnMessages);
      if (currentTurnText) {
        text = currentTurnText;
      }
      images = collectImagesFromMessages(currentTurnMessages, imageDetail);
    }

    if (systemText && (isNewConversation || systemChanged || !stateSystem)) {
      text = text ? `${systemText}\n\n${text}` : systemText;
    }
  }

  const canReuseToolDefinitions =
    toolPromptHash &&
    conversationState?.toolPromptHash === toolPromptHash &&
    !isNewConversation &&
    !systemChanged;
  // This is necessary because HopGPT doesn't pass tools to the model natively.
  // When a threaded conversation has already seen the same definitions, keep
  // follow-up turns compact and only remind the model of the XML grammar.
  const toolInjection = buildToolInjectionPrompt(normalizedTools, tool_choice, {
    compact: canReuseToolDefinitions,
  });
  if (toolInjection) {
    text = text + toolInjection;
  }

  const conversationId = conversationState?.conversationId || conversationState?.conversation_id;
  const parentMessageId =
    conversationState?.lastAssistantMessageId || '00000000-0000-0000-0000-000000000000';

  const clientTimestamp = new Date().toISOString().slice(0, 19);

  const hopGPTRequest = {
    text,
    sender: 'User',
    clientTimestamp,
    isCreatedByUser: true,
    parentMessageId,
    messageId: uuidv4(),
    error: false,
    endpoint: 'AnthropicClaude',
    endpointType: 'custom',
    model: model || 'claude-sonnet-4-20250514',
    resendFiles: false,
    imageDetail,
    key: 'never',
    modelDisplayLabel: 'Claude',
    isTemporary: false,
    isRegenerate: false,
    isContinued: false,
    ephemeralAgent: {
      execute_code: false,
      web_search: false,
      file_search: false,
      artifacts: false,
      mcp: [],
    },
  };

  if (conversationId) {
    hopGPTRequest.conversationId = conversationId;
  }

  if (images.length > 0) {
    hopGPTRequest.image_urls = images;
  }

  const maxTokens = normalizeMaxTokens(max_tokens);
  const stopSequences = normalizeStopSequences(stop_sequences ?? stop);
  if (!stopSequences.includes(toolCallStopSequence)) {
    stopSequences.push(toolCallStopSequence);
  }
  // Bedrock (via HopGPT) rejects requests where `max_tokens <= thinking.budget_tokens`.
  // Empirically the implicit budget for `reasoning_effort: "high"` is a few thousand
  // tokens, so floor max_tokens at 8192 whenever thinking is on to keep the request valid.
  const THINKING_MAX_TOKENS_FLOOR = 8192;
  const effectiveMaxTokens = thinkingConfig.enabled
    ? Math.max(maxTokens ?? 0, THINKING_MAX_TOKENS_FLOOR)
    : maxTokens;
  if (effectiveMaxTokens !== null && effectiveMaxTokens > 0) {
    hopGPTRequest.max_tokens = effectiveMaxTokens;
  }

  for (const [name, value] of Object.entries({ temperature, top_p, top_k })) {
    const normalizedValue = normalizeFiniteNumber(value);
    if (normalizedValue !== null) {
      hopGPTRequest[name] = normalizedValue;
    }
  }

  hopGPTRequest.stop_sequences = stopSequences;

  const transformedTools = transformTools(normalizedTools);
  if (transformedTools) {
    hopGPTRequest.tools = transformedTools;
  }

  const transformedToolChoice = transformToolChoice(tool_choice);
  if (transformedToolChoice) {
    hopGPTRequest.tool_choice = transformedToolChoice;
  }

  if (thinkingConfig.enabled) {
    hopGPTRequest.reasoning_effort = thinkingConfig.effort || 'high';
    hopGPTRequest.reasoning_summary = 'detailed';
    if (Number.isFinite(thinkingConfig.budgetTokens) && thinkingConfig.budgetTokens > 0) {
      hopGPTRequest.thinking = {
        type: 'enabled',
        budget_tokens: Math.floor(thinkingConfig.budgetTokens),
      };
    }
    log.debug('Thinking mode enabled', { model });
  }

  log.debug('Request transformation complete', {
    textLength: text.length,
    hasImages: images.length > 0,
    toolsInjected: !!toolInjection,
    compactToolPrompt: canReuseToolDefinitions,
    isNewConversation,
  });

  if (toolPromptHash) {
    Object.defineProperty(hopGPTRequest, '__hoproxyToolPromptHash', {
      value: toolPromptHash,
      enumerable: false,
    });
  }

  return hopGPTRequest;
}

export function buildConversationText(messages, system = null) {
  const parts = [];
  const systemText = normalizeSystemPrompt(system);

  if (systemText) {
    parts.push(`System: ${systemText}`);
  }

  for (const msg of messages) {
    const role = msg.role === 'user' ? 'Human' : 'Assistant';
    const content = extractMessageContent(msg);

    if (content) {
      parts.push(`${role}: ${content}`);
    }
  }

  return parts.join('\n\n');
}

export function hasThinkingContent(message) {
  if (!message || !Array.isArray(message.content)) {
    return false;
  }
  return message.content.some((block) => block.type === 'thinking');
}

export function extractThinkingSignature(message) {
  if (!message || !Array.isArray(message.content)) {
    return null;
  }

  for (const block of message.content) {
    if (block.type === 'thinking' && block.signature) {
      return block.signature;
    }
  }

  return null;
}
