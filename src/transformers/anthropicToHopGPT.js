import { v4 as uuidv4 } from "uuid";
import { isThinkingModel } from "./hopGPTToAnthropic.js";
import { prepareMessagesForThinking } from "./thinkingUtils.js";
import { loggers } from '../utils/logger.js';

const log = loggers.transform;

function resolveDisableParallelToolUse(toolChoice) {
  if (!toolChoice || typeof toolChoice !== "object") {
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
    disableParallelToolUse: resolveDisableParallelToolUse(toolChoice)
  };

  if (!toolChoice) {
    return config;
  }

  if (typeof toolChoice === "string") {
    if (toolChoice === "none") {
      config.allowTools = false;
    }
    if (toolChoice === "any" || toolChoice === "required") {
      config.mustUseTool = true;
    }
    return config;
  }

  if (typeof toolChoice === "object") {
    if (toolChoice.type === "none") {
      config.allowTools = false;
      return config;
    }
    if (toolChoice.type === "any") {
      config.mustUseTool = true;
      return config;
    }
    if (toolChoice.type === "tool" && toolChoice.name) {
      config.mustUseTool = true;
      config.forcedToolName = toolChoice.name;
      return config;
    }
    if (toolChoice.type === "function" && toolChoice.function?.name) {
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

/**
 * Build a tool injection prompt that tells the model about available tools
 * and how to call them using XML format that we can parse.
 * @param {Array} tools - Normalized tools array
 * @param {object} toolChoice - Anthropic tool_choice
 * @returns {string} Tool injection prompt
 */
function buildToolInjectionPrompt(tools, toolChoice) {
  if (!tools || !Array.isArray(tools) || tools.length === 0) {
    return '';
  }

  const toolChoiceConfig = getToolChoiceConfig(toolChoice);

  let prompt = `\n\n# Available Tools\n\nYou have access to the following tools. To use a tool, output a tool call in the following XML format:\n\n<tool_call>\n{"name": "tool_name", "parameters": {"param1": "value1", "param2": "value2"}}\n</tool_call>\n\nIMPORTANT: You MUST use this exact XML format to call tools.\n`;

  if (toolChoiceConfig.allowTools === false) {
    prompt += `Tool use is disabled for this response. Do not call any tools.\n`;
  } else {
    prompt += `If you call tools, respond with ONLY the <tool_call> block(s) and no extra text. If you are not calling a tool, respond normally without any <tool_call> blocks.\n`;
    if (toolChoiceConfig.disableParallelToolUse) {
      prompt += `Call at most one tool per response, then wait for tool results before calling another tool.\n`;
    }
  }

  prompt += `\n## Tool Definitions\n\n`;

  for (const tool of tools) {
    const schema = tool.input_schema || tool.parameters || { type: 'object', properties: {} };
    const properties = schema.properties || {};
    const required = Array.isArray(schema.required) ? schema.required : [];

    prompt += `### ${tool.name}\n`;
    if (tool.description) {
      // Truncate very long descriptions
      const desc = tool.description.length > 500
        ? tool.description.slice(0, 500) + '...'
        : tool.description;
      prompt += `${desc}\n\n`;
    }

    if (Object.keys(properties).length > 0) {
      prompt += `Parameters:\n`;
      for (const [paramName, paramDef] of Object.entries(properties)) {
        const reqMark = required.includes(paramName) ? ' (required)' : '';
        const paramType = describeSchemaType(paramDef);
        const paramDesc = paramDef.description ? `: ${truncateSchemaDescription(paramDef.description)}` : '';
        prompt += `- ${paramName}${reqMark} [${paramType}]${paramDesc}\n`;
        const detailLines = formatSchemaDetailLines(paramDef, 1);
        for (const line of detailLines) {
          prompt += `${line}\n`;
        }
      }
      prompt += '\n';
    }
  }

  // Add tool choice guidance
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
      prompt += `You may call multiple tools in one response when they can run in parallel by outputting multiple <tool_call> blocks back-to-back. After calling tool(s), wait for the result(s) before proceeding.\n`;
    }
  }

  return prompt;
}

const DEFAULT_TOOL_SCHEMA = {
  type: "object",
  properties: {},
  required: []
};

function normalizeSchemaType(type, schema) {
  if (Array.isArray(type)) {
    const filtered = type.filter((value) => value && value !== "null");
    return filtered.length > 0 ? filtered[0] : null;
  }
  if (typeof type === "string") {
    return type;
  }
  if (schema?.properties) {
    return "object";
  }
  if (schema?.items) {
    return "array";
  }
  return null;
}

function scoreSchemaOption(schema) {
  if (!schema || typeof schema !== "object") {
    return -1;
  }

  const type = normalizeSchemaType(schema.type, schema);
  let score = 0;

  if (type === "object" || schema.properties) {
    score += 5;
  }

  if (schema.properties && typeof schema.properties === "object") {
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
  const base = baseSchema && typeof baseSchema === "object" ? baseSchema : {};
  const extra = extraSchema && typeof extraSchema === "object" ? extraSchema : {};

  const merged = { ...base, ...extra };

  const baseProps = base.properties && typeof base.properties === "object" ? base.properties : {};
  const extraProps = extra.properties && typeof extra.properties === "object" ? extra.properties : {};
  merged.properties = { ...baseProps, ...extraProps };

  const required = new Set();
  if (Array.isArray(base.required)) {
    base.required.forEach((item) => required.add(item));
  }
  if (Array.isArray(extra.required)) {
    extra.required.forEach((item) => required.add(item));
  }
  if (required.size > 0) {
    merged.required = Array.from(required);
  }

  return merged;
}

function resolveSchema(schema, depth = 0) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return null;
  }

  if (depth > 6) {
    return schema;
  }

  if (schema.$ref && !schema.properties && !schema.items && !schema.allOf && !schema.anyOf && !schema.oneOf) {
    const description = schema.description
      ? `${schema.description} (ref: ${schema.$ref})`
      : `Schema reference: ${schema.$ref}`;
    return { type: schema.type || "string", description };
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
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return {};
  }

  if (depth > 6) {
    return {};
  }

  const resolved = resolveSchema(schema, depth);
  if (!resolved || typeof resolved !== "object") {
    return {};
  }

  const node = {};
  const type = normalizeSchemaType(resolved.type, resolved);
  if (type) {
    node.type = type;
  }

  if (typeof resolved.description === "string") {
    node.description = resolved.description;
  }

  if (Array.isArray(resolved.enum)) {
    node.enum = resolved.enum;
  }

  if (resolved.items) {
    node.items = sanitizeSchemaNode(resolved.items, depth + 1);
  }

  if (resolved.properties && typeof resolved.properties === "object") {
    node.type = node.type || "object";
    node.properties = {};
    for (const [key, value] of Object.entries(resolved.properties)) {
      node.properties[key] = sanitizeSchemaNode(value, depth + 1);
    }

    if (Array.isArray(resolved.required)) {
      node.required = resolved.required.filter((item) => typeof item === "string");
    }
  }

  if (resolved.additionalProperties !== undefined) {
    node.additionalProperties = typeof resolved.additionalProperties === "boolean"
      ? resolved.additionalProperties
      : sanitizeSchemaNode(resolved.additionalProperties, depth + 1);
  }

  return node;
}

function sanitizeToolSchema(schema) {
  const sanitized = sanitizeSchemaNode(schema);
  const normalized = { ...DEFAULT_TOOL_SCHEMA, ...sanitized };

  if (!normalized.properties || typeof normalized.properties !== "object") {
    normalized.properties = {};
  }

  if (!Array.isArray(normalized.required)) {
    normalized.required = [];
  }

  if (normalized.type !== "object" && Object.keys(normalized.properties).length === 0) {
    return {
      type: "object",
      properties: {
        input: sanitized.type ? sanitized : { type: "string" }
      },
      required: []
    };
  }

  normalized.type = "object";
  return normalized;
}

function normalizeToolDefinition(tool, index) {
  if (!tool || typeof tool !== "object") {
    return null;
  }

  const functionTool = tool.function || tool.custom || null;
  const rawName = tool.name || functionTool?.name || tool.custom?.name;
  const name = typeof rawName === "string" && rawName.trim().length > 0
    ? rawName.trim()
    : `tool-${index + 1}`;
  const description = tool.description || functionTool?.description || tool.custom?.description || "";
  const rawSchema = tool.input_schema ||
    tool.parameters ||
    functionTool?.input_schema ||
    functionTool?.parameters ||
    tool.custom?.input_schema ||
    tool.custom?.parameters;

  return {
    name: String(name),
    description: typeof description === "string" ? description : "",
    input_schema: sanitizeToolSchema(rawSchema)
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
  if (!schema || typeof schema !== "object") {
    return "any";
  }

  if (Array.isArray(schema.type)) {
    return schema.type.join(" | ");
  }

  if (typeof schema.type === "string") {
    return schema.type;
  }

  if (schema.enum) {
    return "enum";
  }

  if (schema.properties) {
    return "object";
  }

  if (schema.items) {
    return "array";
  }

  return "any";
}

const MAX_SCHEMA_DEPTH = 4;
const MAX_SCHEMA_PROPERTIES = 12;

function truncateSchemaDescription(value) {
  if (typeof value !== "string") {
    return "";
  }
  return value.length > 500 ? `${value.slice(0, 500)}...` : value;
}

function formatSchemaDetailLines(schema, depth = 0) {
  if (!schema || typeof schema !== "object" || depth >= MAX_SCHEMA_DEPTH) {
    return [];
  }

  const lines = [];
  const indent = "  ".repeat(depth);

  if (schema.items && typeof schema.items === "object") {
    const itemType = describeSchemaType(schema.items);
    const itemDesc = schema.items.description ? `: ${truncateSchemaDescription(schema.items.description)}` : "";
    lines.push(`${indent}- items [${itemType}]${itemDesc}`);
    lines.push(...formatSchemaDetailLines(schema.items, depth + 1));
  }

  if (schema.properties && typeof schema.properties === "object") {
    const required = new Set(Array.isArray(schema.required) ? schema.required : []);
    const entries = Object.entries(schema.properties);
    for (const [name, propSchema] of entries.slice(0, MAX_SCHEMA_PROPERTIES)) {
      const reqMark = required.has(name) ? " (required)" : "";
      const propType = describeSchemaType(propSchema);
      const propDesc = propSchema.description ? `: ${truncateSchemaDescription(propSchema.description)}` : "";
      lines.push(`${indent}- ${name}${reqMark} [${propType}]${propDesc}`);
      lines.push(...formatSchemaDetailLines(propSchema, depth + 1));
    }
    if (entries.length > MAX_SCHEMA_PROPERTIES) {
      lines.push(`${indent}- ... (${entries.length - MAX_SCHEMA_PROPERTIES} more)`);
    }
  }

  return lines;
}

/**
 * Transform Anthropic tool definitions to HopGPT format
 * @param {Array} tools - Anthropic tools array
 * @returns {Array} HopGPT tools array
 */
export function transformTools(tools) {
  const normalizedTools = normalizeToolDefinitions(tools);
  if (normalizedTools.length === 0) {
    return null;
  }

  return normalizedTools.map((tool) => ({
    name: tool.name,
    description: tool.description || "",
    input_schema: tool.input_schema,
    parameters: tool.input_schema
  }));
}

/**
 * Transform Anthropic tool_choice to HopGPT format
 * @param {object|string} toolChoice - Anthropic tool_choice
 * @returns {object|null} HopGPT tool choice config
 */
export function transformToolChoice(toolChoice) {
  if (!toolChoice) {
    return null;
  }

  const toolChoiceConfig = getToolChoiceConfig(toolChoice);
  const applyDisableParallel = (value) => (
    toolChoiceConfig.disableParallelToolUse
      ? { ...value, disable_parallel_tool_use: true }
      : value
  );

  // Handle string shortcuts
  if (typeof toolChoice === "string") {
    if (toolChoice === "auto") {
      return applyDisableParallel({ type: "auto" });
    }
    if (toolChoice === "any") {
      return applyDisableParallel({ type: "required" });
    }
    if (toolChoice === "required") {
      return applyDisableParallel({ type: "required" });
    }
    if (toolChoice === "none") {
      return applyDisableParallel({ type: "none" });
    }
  }

  // Handle object format
  if (typeof toolChoice === "object") {
    if (toolChoice.type === "auto") {
      return applyDisableParallel({ type: "auto" });
    }
    if (toolChoice.type === "any") {
      return applyDisableParallel({ type: "required" });
    }
    if (toolChoice.type === "tool") {
      return applyDisableParallel({ type: "function", function: { name: toolChoice.name } });
    }
    if (toolChoice.type === "function" && toolChoice.function?.name) {
      return applyDisableParallel({ type: "function", function: { name: toolChoice.function.name } });
    }
  }

  return null;
}

/**
 * Format a tool_use block for conversation context
 * @param {object} block - tool_use content block
 * @returns {string} Formatted string representation
 */
function formatToolUseBlock(block) {
  const inputStr =
    typeof block.input === "string"
      ? block.input
      : JSON.stringify(block.input, null, 2);
  return `<tool_use id="${block.id}" name="${block.name}">\n${inputStr}\n</tool_use>`;
}

/**
 * Format a tool_result block for conversation context
 * @param {object} block - tool_result content block
 * @returns {string} Formatted string representation
 */
function formatToolResultBlock(block) {
  let content = "";
  if (typeof block.content === "string") {
    content = block.content;
  } else if (Array.isArray(block.content)) {
    // Handle array content (e.g., with text blocks)
    content = block.content
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("\n");
  }

  const errorAttr = block.is_error ? ' is_error="true"' : "";
  return `<tool_result tool_use_id="${block.tool_use_id}"${errorAttr}>\n${content}\n</tool_result>`;
}

/**
 * Extract content from a message, handling all content block types
 * @param {object} message - Anthropic message
 * @returns {string} Extracted text content
 */
function extractMessageContent(message) {
  if (typeof message.content === "string") {
    return message.content;
  }

  if (!Array.isArray(message.content)) {
    return "";
  }

  const parts = [];
  for (const block of message.content) {
    if (block.type === "text") {
      parts.push(block.text);
    } else if (block.type === "tool_use") {
      parts.push(formatToolUseBlock(block));
    } else if (block.type === "tool_result") {
      parts.push(formatToolResultBlock(block));
    }
    // Skip thinking blocks - they are internal model reasoning
  }

  return parts.join("\n\n");
}

export function normalizeSystemPrompt(system) {
  if (!system) {
    return null;
  }

  if (typeof system === "string") {
    return system.trim().length > 0 ? system : null;
  }

  if (Array.isArray(system)) {
    const parts = [];
    for (const block of system) {
      if (block?.type === "text" && typeof block.text === "string") {
        parts.push(block.text);
      }
    }
    const combined = parts.join("\n");
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

export function normalizeStopSequences(value) {
  if (Array.isArray(value)) {
    return value.filter((seq) => typeof seq === "string" && seq.length > 0);
  }
  if (typeof value === "string" && value.length > 0) {
    return [value];
  }
  return [];
}

/**
 * Extract thinking configuration from Anthropic request
 * @param {object} anthropicRequest - Anthropic API request body
 * @returns {object} Thinking configuration {enabled, budgetTokens}
 */
export function extractThinkingConfig(anthropicRequest) {
  const { model, thinking } = anthropicRequest;

  // Check explicit thinking parameter
  if (thinking) {
    return {
      enabled: thinking.type === "enabled",
      budgetTokens: thinking.budget_tokens || null,
    };
  }

  // Auto-detect from model name
  return {
    enabled: isThinkingModel(model),
    budgetTokens: null,
  };
}

function extractTextAndImages(content, imageDetail) {
  if (typeof content === "string") {
    return { text: content, images: [] };
  }

  if (!Array.isArray(content)) {
    return { text: "", images: [] };
  }

  const textParts = [];
  const images = [];

  for (const block of content) {
    if (!block) continue;
    if (block.type === "text" && typeof block.text === "string") {
      textParts.push(block.text);
      continue;
    }

    if (block.type === "tool_use") {
      textParts.push(formatToolUseBlock(block));
      continue;
    }

    if (block.type === "tool_result") {
      textParts.push(formatToolResultBlock(block));
      continue;
    }

    if (block.type === "image" && block.source) {
      if (
        block.source.type === "base64" &&
        block.source.data &&
        block.source.media_type
      ) {
        images.push({
          type: "image_url",
          image_url: {
            url: `data:${block.source.media_type};base64,${block.source.data}`,
            detail: imageDetail,
          },
        });
      } else if (block.source.type === "url" && block.source.url) {
        images.push({
          type: "image_url",
          image_url: {
            url: block.source.url,
            detail: imageDetail,
          },
        });
      }
    }
  }

  return { text: textParts.join("\n"), images };
}

/**
 * Transform Anthropic Messages API request to HopGPT format
 * @param {object} anthropicRequest - Anthropic API request body
 * @param {object} conversationState - Optional conversation state for multi-turn
 * @returns {object} HopGPT request body
 */
export function transformAnthropicToHopGPT(
  anthropicRequest,
  conversationState = null
) {
  const {
    model,
    messages,
    system,
    tools,
    tool_choice,
    max_tokens,
    stop_sequences,
    stop,
  } = anthropicRequest;
  
  log.debug('Transforming Anthropic request to HopGPT', {
    model,
    messageCount: messages?.length || 0,
    hasSystem: !!system,
    toolCount: tools?.length || 0,
    hasToolChoice: !!tool_choice,
    maxTokens: max_tokens
  });
  
  const imageDetail = "high";
  // NOTE: Do NOT use a stop sequence that matches tool call markup. Some backends
  // strip stop sequences from output, which would truncate XML tool calls and
  // break parsing. Use a sentinel that is unlikely to appear in model output.
  const toolCallStopSequence = "<|hopgpt_tool_stop|>";
  const normalizedTools = normalizeToolDefinitions(tools);

  // Get thinking configuration
  const thinkingConfig = extractThinkingConfig(anthropicRequest);
  const processedMessages = prepareMessagesForThinking(messages, {
    targetFamily: "claude",
    thinkingEnabled: thinkingConfig.enabled
  });
  const normalizedSystem = normalizeSystemPrompt(system);
  const stateSystem = normalizeSystemPrompt(
    conversationState?.systemPrompt ?? conversationState?.system
  );
  const systemText = normalizedSystem ?? stateSystem;
  const systemChanged =
    normalizedSystem && stateSystem && normalizedSystem !== stateSystem;
  const isNewConversation = !conversationState?.lastAssistantMessageId;

  // Get the latest user message
  const latestMessage = processedMessages[processedMessages.length - 1];

  // Build text content - handle all content block types including tool_result
  let text = "";
  let images = [];
  if (typeof latestMessage.content === "string") {
    text = latestMessage.content;
  } else if (Array.isArray(latestMessage.content)) {
    // Extract text from content blocks (skip thinking blocks in user messages)
    const extracted = extractTextAndImages(latestMessage.content, imageDetail);
    text = extracted.text;
    images = extracted.images;
  }

  const shouldIncludeHistory = isNewConversation && processedMessages.length > 1;
  if (shouldIncludeHistory) {
    text = buildConversationText(processedMessages, systemText);
  } else if (
    systemText &&
    (isNewConversation || systemChanged || !stateSystem)
  ) {
    text = text ? `${systemText}\n\n${text}` : systemText;
  }

  // Inject tool definitions into the prompt if tools are provided
  // This is necessary because HopGPT doesn't pass tools to the model natively
  const toolInjection = buildToolInjectionPrompt(normalizedTools, tool_choice);
  if (toolInjection) {
    text = text + toolInjection;
  }

  // Get parent message ID for conversation threading
  const parentMessageId =
    conversationState?.lastAssistantMessageId ||
    "00000000-0000-0000-0000-000000000000";

  // Generate timestamp in HopGPT format
  const clientTimestamp = new Date().toISOString().slice(0, 19);

  // Build base request
  const hopGPTRequest = {
    text,
    sender: "User",
    clientTimestamp,
    isCreatedByUser: true,
    parentMessageId,
    messageId: uuidv4(),
    error: false,
    endpoint: "AnthropicClaude",
    endpointType: "custom",
    model: model || "claude-sonnet-4-20250514",
    resendFiles: false,
    imageDetail,
    key: "never",
    modelDisplayLabel: "Claude",
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

  if (images.length > 0) {
    hopGPTRequest.image_urls = images;
  }

  const maxTokens = normalizeMaxTokens(max_tokens);
  const stopSequences = normalizeStopSequences(stop_sequences ?? stop);
  if (!stopSequences.includes(toolCallStopSequence)) {
    stopSequences.push(toolCallStopSequence);
  }
  if (maxTokens !== null) {
    hopGPTRequest.max_tokens = maxTokens;
  }
  hopGPTRequest.stop_sequences = stopSequences;

  // Add tools if provided
  const transformedTools = transformTools(normalizedTools);
  if (transformedTools) {
    hopGPTRequest.tools = transformedTools;
  }

  // Add tool_choice if provided
  const transformedToolChoice = transformToolChoice(tool_choice);
  if (transformedToolChoice) {
    hopGPTRequest.tool_choice = transformedToolChoice;
  }

  // Add reasoning/thinking parameters based on thinking config
  if (thinkingConfig.enabled) {
    hopGPTRequest.reasoning_effort = "high";
    hopGPTRequest.reasoning_summary = "detailed";
    log.debug('Thinking mode enabled', { model });
  }

  log.debug('Request transformation complete', {
    textLength: text.length,
    hasImages: images.length > 0,
    toolsInjected: !!toolInjection,
    isNewConversation
  });

  return hopGPTRequest;
}

/**
 * Build conversation history text for multi-turn conversations
 * HopGPT handles conversation state server-side via parentMessageId,
 * but for context we can include previous messages in the text if needed
 *
 * Note: Thinking blocks from previous assistant messages are excluded
 * as they are internal model reasoning and should not be in conversation text
 */
export function buildConversationText(messages, system = null) {
  let parts = [];
  const systemText = normalizeSystemPrompt(system);

  if (systemText) {
    parts.push(`System: ${systemText}`);
  }

  for (const msg of messages) {
    const role = msg.role === "user" ? "Human" : "Assistant";
    const content = extractMessageContent(msg);

    if (content) {
      parts.push(`${role}: ${content}`);
    }
  }

  return parts.join("\n\n");
}

/**
 * Check if a message contains thinking blocks
 * @param {object} message - Anthropic message object
 * @returns {boolean} True if message contains thinking content
 */
export function hasThinkingContent(message) {
  if (!message || !Array.isArray(message.content)) {
    return false;
  }
  return message.content.some((block) => block.type === "thinking");
}

/**
 * Extract thinking signature from a message
 * Used for interleaved thinking in multi-turn conversations
 * @param {object} message - Anthropic message object
 * @returns {string|null} The thinking signature if present
 */
export function extractThinkingSignature(message) {
  if (!message || !Array.isArray(message.content)) {
    return null;
  }

  for (const block of message.content) {
    if (block.type === "thinking" && block.signature) {
      return block.signature;
    }
  }

  return null;
}
