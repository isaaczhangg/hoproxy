import { v4 as uuidv4 } from 'uuid';
import { cacheThinkingSignature, cacheToolSignature } from './signatureCache.js';
import { normalizeMaxTokens, normalizeStopSequences } from './anthropicToHopGPT.js';
import { loggers } from '../utils/logger.js';

const log = loggers.transform;

// Pattern for <mcp_tool_call> blocks
const MCP_TOOL_CALL_BLOCK_RE = /<mcp_tool_call\b[\s\S]*?<\/mcp_tool_call>/gi;
const MCP_TOOL_CALL_START_TAG = '<mcp_tool_call';

// Pattern for <function_calls> blocks (used by OpenCode)
// Also matches <function_calls> used by Claude Code
const FUNCTION_CALLS_BLOCK_RE = /<(?:antml:)?function_calls\b[\s\S]*?<\/(?:antml:)?function_calls>/gi;
const FUNCTION_CALLS_START_TAG = '<function_calls';
const ANTML_FUNCTION_CALLS_START_TAG = '<antml:function_calls';

// Pattern for <tool_call> blocks with JSON (another OpenCode format)
const TOOL_CALL_JSON_BLOCK_RE = /<tool_call\b[\s\S]*?<\/tool_call>/gi;
const TOOL_CALL_JSON_START_TAG = '<tool_call';

// Pattern for <tool_use> blocks with JSON-like content (Anthropic style in text)
const TOOL_USE_START_TAG = '<tool_use';

// Pattern for standalone <invoke> blocks
// Also matches <invoke> used by Claude Code
const INVOKE_BLOCK_RE = /<(?:antml:)?invoke\b[\s\S]*?<\/(?:antml:)?invoke>/gi;
const INVOKE_START_TAG = '<invoke';
const ANTML_INVOKE_START_TAG = '<antml:invoke';

const FUNCTION_CALLS_TAGS = [FUNCTION_CALLS_START_TAG, ANTML_FUNCTION_CALLS_START_TAG];
const INVOKE_TAGS = [INVOKE_START_TAG, ANTML_INVOKE_START_TAG];

const TOOL_TAG_NAMES = [
  'mcp_tool_call',
  'function_calls',
  'antml:function_calls',
  'tool_call',
  'tool_use',
  'invoke',
  'antml:invoke'
];

const TOOL_TAG_NAME_SET = new Set(TOOL_TAG_NAMES);

const TOOL_TAG_CLOSINGS = {
  'mcp_tool_call': ['</mcp_tool_call>'],
  'function_calls': ['</function_calls>', '</antml:function_calls>'],
  'antml:function_calls': ['</antml:function_calls>', '</function_calls>'],
  'invoke': ['</invoke>', '</antml:invoke>'],
  'antml:invoke': ['</antml:invoke>', '</invoke>'],
  'tool_call': ['</tool_call>', '</tool_use>'],
  'tool_use': ['</tool_use>', '</tool_call>']
};

// Helper function to parse environment variable as positive integer
function parsePositiveInt(envVar, defaultValue) {
  const parsed = Number.parseInt(envVar, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultValue;
}

const DEFAULT_MAX_TOOL_CALL_BUFFER_SIZE = 1000000;
const MAX_TOOL_CALL_BUFFER_SIZE = parsePositiveInt(
  process.env.HOPGPT_TOOL_CALL_BUFFER_SIZE,
  DEFAULT_MAX_TOOL_CALL_BUFFER_SIZE
);

const DEFAULT_TOOL_CALL_BUFFER_WARN_THRESHOLD = 50000;
const DEFAULT_TOOL_CALL_BUFFER_WARN_STEP = 200000;

const TOOL_CALL_BUFFER_WARN_THRESHOLD = parsePositiveInt(
  process.env.HOPGPT_TOOL_CALL_BUFFER_WARN_THRESHOLD,
  DEFAULT_TOOL_CALL_BUFFER_WARN_THRESHOLD
);

const TOOL_CALL_BUFFER_WARN_STEP = parsePositiveInt(
  process.env.HOPGPT_TOOL_CALL_BUFFER_WARN_STEP,
  DEFAULT_TOOL_CALL_BUFFER_WARN_STEP
);

const VALID_JSON_ESCAPES = new Set(['"', '\\', '/', 'b', 'f', 'n', 'r', 't', 'u']);
const TOOL_INSTRUCTION_MARKERS = [
  '# available tools',
  '## tool definitions',
  'you have access to the following tools',
  'important: you must use this exact xml format to call tools'
];
const SANITIZE_TAIL_LENGTH = 120;
const DUPLICATE_TEXT_CHUNK_MIN_LENGTH = 80;
const ROLE_PREFIX_RE = /(^|\r?\n)\s*(?:H:|A:|Human:|Assistant:)\s*/g;

function includesAny(haystack, needles) {
  return needles.some(tag => haystack.includes(tag));
}

function findToolInstructionStartIndex(text, fromIndex = 0) {
  if (!text) {
    return -1;
  }
  const lower = text.toLowerCase();
  let earliest = -1;
  for (const marker of TOOL_INSTRUCTION_MARKERS) {
    const idx = lower.indexOf(marker, fromIndex);
    if (idx !== -1 && (earliest === -1 || idx < earliest)) {
      earliest = idx;
    }
  }
  return earliest;
}

function findNextAssistantMarkerIndex(text, fromIndex = 0) {
  if (!text) {
    return -1;
  }
  const re = /(^|\r?\n)\s*(?:A:|Assistant:)\s*/g;
  re.lastIndex = fromIndex;
  const match = re.exec(text);
  return match ? match.index : -1;
}

function stripRolePrefixes(text) {
  if (!text) {
    return text;
  }
  return text.replace(ROLE_PREFIX_RE, '$1');
}

function stripToolInstructionLeak(text) {
  if (!text) {
    return text;
  }

  let result = text;
  while (true) {
    const startIndex = findToolInstructionStartIndex(result, 0);
    if (startIndex === -1) {
      break;
    }

    const assistantIndex = findNextAssistantMarkerIndex(result, startIndex);
    if (assistantIndex === -1) {
      result = result.slice(0, startIndex);
      break;
    }

    result = result.slice(0, startIndex) + result.slice(assistantIndex);
  }

  return result;
}

function sanitizeTextFull(text) {
  return stripRolePrefixes(stripToolInstructionLeak(text));
}

function normalizeToolNameToken(value) {
  if (!value || typeof value !== 'string') {
    return '';
  }
  // Remove all non-alphanumeric characters for fuzzy matching
  // This allows "todo_write" to match "todowrite"
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

function isLikelyToolTagStart(text, index, tagName) {
  if (index > 0) {
    const prev = text[index - 1];
    if (prev === '`' || prev === '"' || prev === "'" || prev === '/' || prev === '\\') {
      return false;
    }
    if (/[A-Za-z0-9_]/.test(prev)) {
      return false;
    }
  }

  const afterTagIndex = index + 1 + tagName.length;
  const after = text[afterTagIndex];
  if (after === "'" || after === '"' || after === '`') {
    return false;
  }

  return true;
}

function findNextToolTag(text, fromIndex) {
  let index = text.indexOf('<', fromIndex);
  while (index !== -1) {
    if (text[index + 1] === '/') {
      index = text.indexOf('<', index + 1);
      continue;
    }
    const match = text.slice(index).match(/^<\s*([a-zA-Z0-9:_-]+)/);
    if (!match) {
      index = text.indexOf('<', index + 1);
      continue;
    }
    const tagName = match[1].toLowerCase();
    if (!TOOL_TAG_NAME_SET.has(tagName) || !isLikelyToolTagStart(text, index, tagName)) {
      index = text.indexOf('<', index + 1);
      continue;
    }
    const startTagEnd = text.indexOf('>', index + 1);
    return { index, tagName, startTagEnd };
  }
  return null;
}

/**
 * Find the closing tag for a given tag name, respecting JSON string boundaries.
 * This function properly handles closing tag text that appears inside JSON strings
 * by tracking whether we're inside a double-quoted string.
 *
 * IMPORTANT: This function only tracks double quotes (") for string boundaries,
 * which is correct for JSON (JSON spec only allows double quotes for strings).
 * Single-quoted strings are not standard JSON and will not be handled correctly.
 *
 * @param {string} text - The text to search
 * @param {number} fromIndex - The index to start searching from
 * @param {string} tagName - The tag name to find the closing tag for
 * @returns {{startIndex: number, endIndex: number}|null} The position of the closing tag or null
 */
function findClosingTagMatch(text, fromIndex, tagName) {
  const closingTags = TOOL_TAG_CLOSINGS[tagName] || [`</${tagName}>`];
  const lower = text.toLowerCase();
  let inString = false;
  let escaped = false;
  let inCdata = false;

  for (let i = fromIndex; i < text.length; i++) {
    if (inCdata) {
      if (lower.startsWith(']]>', i)) {
        inCdata = false;
        i += 2;
      }
      continue;
    }

    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        continue;
      }
      if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (lower.startsWith('<![cdata[', i)) {
      inCdata = true;
      i += 8;
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === '<' && lower[i + 1] === '/') {
      for (const closingTag of closingTags) {
        if (lower.startsWith(closingTag, i)) {
          return { startIndex: i, endIndex: i + closingTag.length };
        }
      }
    }
  }

  return null;
}

function findClosingTagMatchLoose(text, fromIndex, tagName) {
  const closingTags = TOOL_TAG_CLOSINGS[tagName] || [`</${tagName}>`];
  const lower = text.toLowerCase();
  let bestIndex = -1;
  let bestTag = null;

  for (const tag of closingTags) {
    const index = lower.indexOf(tag, fromIndex);
    if (index !== -1 && (bestIndex === -1 || index < bestIndex)) {
      bestIndex = index;
      bestTag = tag;
    }
  }

  if (bestIndex === -1 || !bestTag) {
    return null;
  }

  return { startIndex: bestIndex, endIndex: bestIndex + bestTag.length };
}

/**
 * Find the closing tag for an XML element, using the last occurrence strategy.
 * This is useful for XML elements like <parameter> where the content may contain
 * text that looks like a closing tag (e.g., "</parameter>") but isn't actually
 * meant to close the current element.
 *
 * The strategy is to find the last closing tag before:
 * - The next opening tag of the same type, OR
 * - The end of the parent container (e.g., </invoke>)
 *
 * @param {string} text - The text to search
 * @param {number} fromIndex - The index to start searching from (after the opening tag's >)
 * @param {string} tagName - The tag name to match
 * @param {string[]} boundaryTags - Tags that mark the boundary (e.g., ['</invoke>', '</function_calls>'])
 * @returns {{startIndex: number, endIndex: number}|null} The position of the closing tag or null
 */
function findClosingTagByLastOccurrence(text, fromIndex, tagName, boundaryTags = []) {
  const lower = text.toLowerCase();
  const closeTag = `</${tagName.toLowerCase()}>`;
  const openTagPattern = `<${tagName.toLowerCase()}`;

  // Find the boundary - either the next opening tag of the same type or a boundary tag
  let boundaryIndex = text.length;

  // Check for next opening tag of the same type (another parameter)
  let nextOpenIdx = fromIndex;
  while (true) {
    nextOpenIdx = lower.indexOf(openTagPattern, nextOpenIdx);
    if (nextOpenIdx === -1) break;
    // Make sure it's actually a tag (followed by whitespace or >)
    const afterTag = text[nextOpenIdx + openTagPattern.length];
    if (afterTag === '>' || afterTag === ' ' || afterTag === '\t' || afterTag === '\n' || afterTag === '\r') {
      boundaryIndex = Math.min(boundaryIndex, nextOpenIdx);
      break;
    }
    nextOpenIdx++;
  }

  // Check boundary tags
  for (const boundaryTag of boundaryTags) {
    const idx = lower.indexOf(boundaryTag.toLowerCase(), fromIndex);
    if (idx !== -1) {
      boundaryIndex = Math.min(boundaryIndex, idx);
    }
  }

  // Find the LAST closing tag before the boundary
  let lastCloseIdx = -1;
  let searchIdx = fromIndex;
  while (true) {
    const idx = lower.indexOf(closeTag, searchIdx);
    if (idx === -1 || idx >= boundaryIndex) break;
    lastCloseIdx = idx;
    searchIdx = idx + 1;
  }

  if (lastCloseIdx === -1) {
    return null;
  }

  return { startIndex: lastCloseIdx, endIndex: lastCloseIdx + closeTag.length };
}

function extractToolCallSegments(text) {
  const segments = [];
  if (!text) {
    return { segments, lastIndex: 0 };
  }

  let index = 0;
  while (index < text.length) {
    const nextTag = findNextToolTag(text, index);
    if (!nextTag) {
      return { segments, lastIndex: index };
    }

    if (nextTag.index > index) {
      segments.push({ type: 'text', text: text.slice(index, nextTag.index) });
    }

    if (nextTag.startTagEnd === -1) {
      return { segments, lastIndex: nextTag.index };
    }

    let closingMatch = findClosingTagMatch(text, nextTag.startTagEnd + 1, nextTag.tagName);
    if (!closingMatch) {
      closingMatch = findClosingTagMatchLoose(text, nextTag.startTagEnd + 1, nextTag.tagName);
    }
    if (!closingMatch) {
      return { segments, lastIndex: nextTag.index };
    }

    const block = text.slice(nextTag.index, closingMatch.endIndex);
    const toolCalls = parseAnyToolCallBlock(block);
    if (toolCalls.length === 0) {
      segments.push({ type: 'text', text: block });
    } else {
      for (const toolCall of toolCalls) {
        segments.push({ type: 'tool_call', toolCall });
      }
    }

    index = closingMatch.endIndex;
  }

  return { segments, lastIndex: index };
}

function extractXmlTagValue(source, tagName) {
  if (!source) {
    return null;
  }
  const matcher = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'i');
  const match = source.match(matcher);
  return match ? match[1].trim() : null;
}

function extractXmlTagValueFlexible(source, tagName, fallbackTagName) {
  const value = extractXmlTagValue(source, tagName);
  if (value !== null) {
    return value;
  }
  if (!source || !fallbackTagName) {
    return null;
  }
  const matcher = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\\/${fallbackTagName}>`, 'i');
  const match = source.match(matcher);
  return match ? match[1].trim() : null;
}

function extractXmlTagValueSafe(source, tagName) {
  if (!source) {
    return null;
  }

  const openerRe = new RegExp(`<${tagName}[^>]*>`, 'i');
  const openMatch = source.match(openerRe);
  if (!openMatch || openMatch.index === undefined) {
    return null;
  }

  const startIndex = openMatch.index + openMatch[0].length;
  let closingMatch = findClosingTagMatch(source, startIndex, tagName);
  // Fall back to loose matching for malformed JSON (e.g., unescaped quotes)
  if (!closingMatch) {
    closingMatch = findClosingTagMatchLoose(source, startIndex, tagName);
  }
  if (!closingMatch) {
    return null;
  }

  return source.slice(startIndex, closingMatch.startIndex).trim();
}

function extractXmlAttribute(source, tagName, attrName) {
  if (!source) {
    return null;
  }

  // Find the opening tag (case-insensitive)
  const tagRe = new RegExp(`<${tagName}\\b`, 'i');
  const tagMatch = source.match(tagRe);
  if (!tagMatch || tagMatch.index === undefined) {
    return null;
  }

  // Find the end of the opening tag
  const tagStart = tagMatch.index;
  const tagEnd = source.indexOf('>', tagStart);
  if (tagEnd === -1) {
    return null;
  }

  const tagContent = source.slice(tagStart, tagEnd + 1);

  // Look for the attribute - handle both quoted and unquoted values
  // Match: attrName="value" or attrName='value' with proper escape handling
  const attrRe = new RegExp(`\\b${attrName}\\s*=\\s*`, 'i');
  const attrMatch = tagContent.match(attrRe);
  if (!attrMatch || attrMatch.index === undefined) {
    return null;
  }

  const valueStart = attrMatch.index + attrMatch[0].length;
  const quoteChar = tagContent[valueStart];

  // Handle quoted values
  if (quoteChar === '"' || quoteChar === "'") {
    let value = '';
    let escaped = false;
    for (let i = valueStart + 1; i < tagContent.length; i++) {
      const ch = tagContent[i];
      if (escaped) {
        // Handle common XML/HTML escapes and JSON escapes
        if (ch === quoteChar || ch === '\\') {
          value += ch;
        } else {
          // Keep the backslash for other escapes (like \n, \t)
          value += '\\' + ch;
        }
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        continue;
      }
      if (ch === quoteChar) {
        return value;
      }
      value += ch;
    }
    // Unterminated quote - return what we have
    return value || null;
  }

  // Handle unquoted values (stop at whitespace or >)
  let value = '';
  for (let i = valueStart; i < tagContent.length; i++) {
    const ch = tagContent[i];
    if (/\s/.test(ch) || ch === '>' || ch === '/') {
      break;
    }
    value += ch;
  }
  return value || null;
}

function stripCdata(source) {
  if (!source) {
    return source;
  }
  const trimmed = source.trim();
  if (trimmed.startsWith('<![CDATA[') && trimmed.endsWith(']]>')) {
    return trimmed.slice(9, -3);
  }
  return source;
}

function escapeUnescapedControlChars(jsonStr) {
  if (!jsonStr || typeof jsonStr !== 'string') {
    return jsonStr;
  }

  let result = '';
  let inString = false;
  let escaped = false;

  for (let i = 0; i < jsonStr.length; i++) {
    const ch = jsonStr[i];
    if (inString) {
      if (escaped) {
        result += ch;
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        result += ch;
        escaped = true;
        continue;
      }
      if (ch === '"') {
        inString = false;
        result += ch;
        continue;
      }
      if (ch === '\n') {
        result += '\\n';
        continue;
      }
      if (ch === '\r') {
        result += '\\r';
        continue;
      }
      if (ch === '\t') {
        result += '\\t';
        continue;
      }
      const code = ch.charCodeAt(0);
      if (code < 0x20) {
        result += `\\u${code.toString(16).padStart(4, '0')}`;
        continue;
      }
      result += ch;
      continue;
    }

    if (ch === '"') {
      inString = true;
    }
    result += ch;
  }

  return result;
}

function findNextNonWhitespace(source, startIndex) {
  if (!source || startIndex < 0) {
    return null;
  }
  for (let i = startIndex; i < source.length; i++) {
    const ch = source[i];
    if (!/\s/.test(ch)) {
      return ch;
    }
  }
  return null;
}

function repairMalformedStringEscapes(jsonStr) {
  if (!jsonStr || typeof jsonStr !== 'string') {
    return jsonStr;
  }

  let result = '';
  let inString = false;
  let escaped = false;

  for (let i = 0; i < jsonStr.length; i++) {
    const ch = jsonStr[i];

    if (inString) {
      if (escaped) {
        escaped = false;
        result += ch;
        continue;
      }

      if (ch === '\\') {
        const next = jsonStr[i + 1];
        if (!next) {
          result += '\\\\';
          continue;
        }
        if (VALID_JSON_ESCAPES.has(next)) {
          if (next === 'u') {
            const hex = jsonStr.slice(i + 2, i + 6);
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
              result += '\\\\';
              continue;
            }
          }
          result += ch;
          escaped = true;
          continue;
        }
        result += '\\\\';
        continue;
      }

      if (ch === '"') {
        const nextNonWhitespace = findNextNonWhitespace(jsonStr, i + 1);
        if (nextNonWhitespace === null ||
            nextNonWhitespace === ':' ||
            ',}]'.includes(nextNonWhitespace)) {
          inString = false;
          result += ch;
        } else {
          result += '\\"';
        }
        continue;
      }

      result += ch;
      continue;
    }

    if (ch === '"') {
      inString = true;
      result += ch;
      continue;
    }

    result += ch;
  }

  return result;
}

function parseEmbeddedJson(value) {
  if (typeof value !== 'string') {
    return value;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return value;
  }
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    const parsed = parseJsonWithRepair(trimmed);
    return parsed !== null ? parsed : value;
  }
  return value;
}

function parseJsonWithRepair(jsonText) {
  if (!jsonText || typeof jsonText !== 'string') {
    return null;
  }
  const cleaned = stripCdata(jsonText).trim();
  if (!cleaned) {
    return null;
  }
  const escaped = escapeUnescapedControlChars(cleaned);
  const attempts = new Set();
  const addAttempt = (value) => {
    if (typeof value === 'string' && value.length > 0) {
      attempts.add(value);
    }
  };

  const baseValues = [cleaned, escaped];
  for (const base of baseValues) {
    addAttempt(base);

    const arrayRepaired = repairMalformedArrayJson(base);
    addAttempt(arrayRepaired);

    const stringRepaired = repairMalformedStringEscapes(base);
    addAttempt(stringRepaired);
    addAttempt(repairMalformedArrayJson(stringRepaired));
    addAttempt(repairMalformedStringEscapes(arrayRepaired));
  }

  for (const attempt of attempts) {
    try {
      return JSON.parse(attempt);
    } catch (error) {
      continue;
    }
  }

  return null;
}

function parseToolCallJsonContent(jsonContent) {
  const attemptParse = (value) => {
    const parsed = parseJsonWithRepair(value);
    if (!parsed || typeof parsed !== 'object') {
      return null;
    }
    return parsed;
  };

  let parsed = attemptParse(jsonContent);
  if (!parsed) {
    const extracted = extractFirstJsonObject(jsonContent);
    if (extracted && extracted !== jsonContent) {
      parsed = attemptParse(extracted);
    }
  }
  if (!parsed) {
    return null;
  }
  const toolName = parsed.name;
  if (!toolName) {
    return null;
  }
  const args = parsed.parameters || parsed.arguments || parsed.input || {};
  return {
    toolName,
    arguments: parseEmbeddedJson(args),
    toolUseId: parsed.id || parsed.toolUseId || null
  };
}

function pickFirstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) {
      return value;
    }
  }
  return null;
}

function normalizeQuestionOption(option) {
  if (typeof option === 'string') {
    return { description: option };
  }
  if (!option || typeof option !== 'object' || Array.isArray(option)) {
    return option;
  }
  if (typeof option.description === 'string') {
    return option;
  }

  const fallback = pickFirstString(option.label, option.value, option.text, option.title, option.name);
  if (fallback !== null) {
    return { ...option, description: fallback };
  }
  if (option.description !== undefined) {
    return { ...option, description: String(option.description) };
  }
  return { ...option, description: '' };
}

function normalizeQuestionsInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return input;
  }
  if (!Array.isArray(input.questions)) {
    return input;
  }

  let questionsChanged = false;
  const normalizedQuestions = input.questions.map((question) => {
    if (!question || typeof question !== 'object' || Array.isArray(question)) {
      return question;
    }

    let questionChanged = false;
    let normalized = question;

    if (typeof question.header !== 'string' || question.header.trim().length === 0) {
      const headerFallback = pickFirstString(
        question.question,
        question.title,
        question.text,
        question.prompt
      );
      if (headerFallback) {
        normalized = { ...normalized, header: headerFallback };
        questionChanged = true;
      }
    }

    if (Array.isArray(question.options)) {
      let optionsChanged = false;
      const normalizedOptions = question.options.map((option) => {
        const normalizedOption = normalizeQuestionOption(option);
        if (normalizedOption !== option) {
          optionsChanged = true;
        }
        return normalizedOption;
      });
      if (optionsChanged) {
        normalized = { ...normalized, options: normalizedOptions };
        questionChanged = true;
      }
    }

    if (questionChanged) {
      questionsChanged = true;
      return normalized;
    }
    return question;
  });

  if (!questionsChanged) {
    return input;
  }
  return { ...input, questions: normalizedQuestions };
}

function normalizeToolInput(toolName, input) {
  if (!input || typeof input !== 'object') {
    return input;
  }
  return normalizeQuestionsInput(input);
}

function getLeadingTagName(block) {
  if (!block) {
    return null;
  }
  const match = block.trim().match(/^<\s*([a-zA-Z0-9:_-]+)/);
  return match ? match[1].toLowerCase() : null;
}

function findMatchingBrace(source, startIndex) {
  if (!source || startIndex < 0 || startIndex >= source.length || source[startIndex] !== '{') {
    return -1;
  }
  let braceCount = 0;
  let inString = false;
  let escaped = false;

  for (let i = startIndex; i < source.length; i++) {
    const ch = source[i];
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        continue;
      }
      if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') {
      braceCount++;
    } else if (ch === '}') {
      braceCount--;
      if (braceCount === 0) {
        return i;
      }
    }
  }

  return -1;
}

function extractFirstJsonObject(text) {
  if (!text || typeof text !== 'string') {
    return null;
  }
  const startIndex = text.indexOf('{');
  if (startIndex === -1) {
    return null;
  }
  const endIndex = findMatchingBrace(text, startIndex);
  if (endIndex === -1) {
    return null;
  }
  return text.slice(startIndex, endIndex + 1);
}

/**
 * Repair malformed JSON where array brackets are missing.
 * Fixes patterns like: {"key": {"id": "1"}, {"id": "2"}}
 * To become: {"key": [{"id": "1"}, {"id": "2"}]}
 *
 * This commonly happens when models output tool calls with array parameters
 * but omit the array brackets.
 */
function repairMalformedArrayJson(jsonStr) {
  if (!jsonStr || typeof jsonStr !== 'string') {
    return jsonStr;
  }

  // Pattern: a key followed by an object, then comma and another object without array brackets
  // e.g., "key": {"a": 1}, {"b": 2} should become "key": [{"a": 1}, {"b": 2}]
  //
  // Strategy: Find patterns where we have }: followed by whitespace and {
  // which indicates adjacent objects that should be in an array

  let result = jsonStr;
  const modifications = [];
  const valueStarts = [];
  let inString = false;
  let escaped = false;

  for (let i = 0; i < jsonStr.length; i++) {
    const ch = jsonStr[i];
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        continue;
      }
      if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      let j = i + 1;
      let keyEscaped = false;
      for (; j < jsonStr.length; j++) {
        const next = jsonStr[j];
        if (keyEscaped) {
          keyEscaped = false;
          continue;
        }
        if (next === '\\') {
          keyEscaped = true;
          continue;
        }
        if (next === '"') {
          break;
        }
      }

      if (j >= jsonStr.length) {
        break;
      }

      let k = j + 1;
      while (k < jsonStr.length && /\s/.test(jsonStr[k])) {
        k++;
      }
      if (jsonStr[k] !== ':') {
        i = j;
        continue;
      }
      k++;
      while (k < jsonStr.length && /\s/.test(jsonStr[k])) {
        k++;
      }
      if (jsonStr[k] === '{') {
        valueStarts.push(k);
      }
      i = j;
      continue;
    }
  }

  for (const startOfValue of valueStarts) {
    const firstObjEnd = findMatchingBrace(jsonStr, startOfValue);
    if (firstObjEnd === -1) {
      continue;
    }

    let pos = firstObjEnd + 1;
    while (pos < jsonStr.length && /\s/.test(jsonStr[pos])) {
      pos++;
    }
    if (jsonStr[pos] !== ',') {
      continue;
    }
    pos++;
    while (pos < jsonStr.length && /\s/.test(jsonStr[pos])) {
      pos++;
    }
    if (jsonStr[pos] !== '{') {
      continue;
    }

    let arrayEnd = firstObjEnd;
    let nextObjStart = pos;
    while (nextObjStart < jsonStr.length && jsonStr[nextObjStart] === '{') {
      const nextObjEnd = findMatchingBrace(jsonStr, nextObjStart);
      if (nextObjEnd === -1) {
        break;
      }
      arrayEnd = nextObjEnd;
      let afterObj = nextObjEnd + 1;
      while (afterObj < jsonStr.length && /\s/.test(jsonStr[afterObj])) {
        afterObj++;
      }
      if (jsonStr[afterObj] !== ',') {
        break;
      }
      afterObj++;
      while (afterObj < jsonStr.length && /\s/.test(jsonStr[afterObj])) {
        afterObj++;
      }
      if (jsonStr[afterObj] !== '{') {
        break;
      }
      nextObjStart = afterObj;
    }

    modifications.push({
      insertOpenBracket: startOfValue,
      insertCloseBracket: arrayEnd + 1
    });
  }

  // Apply modifications in reverse order to preserve positions
  modifications.sort((a, b) => b.insertCloseBracket - a.insertCloseBracket);
  for (const mod of modifications) {
    result = result.slice(0, mod.insertCloseBracket) + ']' + result.slice(mod.insertCloseBracket);
    result = result.slice(0, mod.insertOpenBracket) + '[' + result.slice(mod.insertOpenBracket);
  }

  return result;
}

function parseMcpToolCallBlock(block) {
  // Use safe extraction to handle nested closing tags in JSON content
  const serverName = extractXmlTagValueSafe(block, 'server_name');
  const toolName = extractXmlTagValueSafe(block, 'tool_name');
  const argsText = extractXmlTagValueSafe(block, 'arguments');

  if (!toolName) {
    return null;
  }

  let parsedArgs = {};
  if (argsText && argsText.trim().length > 0) {
    const trimmedArgs = argsText.trim();
    const repairedArgs = parseJsonWithRepair(trimmedArgs);
    if (repairedArgs !== null) {
      parsedArgs = repairedArgs;
    } else {
      log.warn('Failed to parse MCP tool call arguments');
      parsedArgs = { _raw: trimmedArgs };
    }
  }

  return {
    serverName,
    toolName,
    arguments: parsedArgs
  };
}

/**
 * Parse a single <invoke> block from <function_calls> format
 * Also handles antml: namespace variants used by Claude Code
 * Format: <invoke name="ToolName"><parameter name="paramName">value</parameter>...</invoke>
 * Or: <invoke name="ToolName"><parameter name="paramName">value</parameter>...</invoke>
 */
function parseInvokeBlock(invokeBlock) {
  // Try both invoke and antml:invoke tag names
  let toolName = extractXmlAttribute(invokeBlock, 'invoke', 'name');
  if (!toolName) {
    toolName = extractXmlAttribute(invokeBlock, 'antml:invoke', 'name');
  }
  if (!toolName) {
    return null;
  }

  // Extract all parameters using last-occurrence strategy
  // This handles parameter values that contain </parameter> as literal text
  // by finding the last closing tag before the next parameter or end of invoke
  const args = {};
  const paramTagRe = /<(?:antml:)?parameter\s+name\s*=\s*/gi;
  let paramTagMatch;

  // Determine boundary tags based on the invoke block type
  const boundaryTags = ['</invoke>', '</invoke>'];

  while ((paramTagMatch = paramTagRe.exec(invokeBlock)) !== null) {
    const paramStart = paramTagMatch.index;

    // Determine if this is an antml: prefixed parameter
    const isAntml = invokeBlock.slice(paramStart, paramStart + 20).toLowerCase().includes('antml:');
    const tagBaseName = isAntml ? 'antml:parameter' : 'parameter';

    // Extract the parameter name from the tag
    const afterMatch = invokeBlock.slice(paramTagMatch.index + paramTagMatch[0].length);
    const quoteChar = afterMatch[0];
    if (quoteChar !== '"' && quoteChar !== "'") {
      continue;
    }

    // Find the end of the parameter name
    let paramName = '';
    let nameEnd = -1;
    for (let i = 1; i < afterMatch.length; i++) {
      if (afterMatch[i] === quoteChar) {
        paramName = afterMatch.slice(1, i);
        nameEnd = i;
        break;
      }
    }
    if (!paramName) {
      continue;
    }

    // Find the > that closes the opening tag
    const tagCloseOffset = afterMatch.indexOf('>', nameEnd);
    if (tagCloseOffset === -1) {
      continue;
    }

    // Calculate the absolute position where the value starts
    const valueStartPos = paramTagMatch.index + paramTagMatch[0].length + tagCloseOffset + 1;

    // Use last-occurrence strategy to find the proper closing tag
    // This handles cases where the parameter value contains </parameter> as text
    // by finding the LAST closing tag before the next parameter or end of invoke
    let closingMatch = findClosingTagByLastOccurrence(invokeBlock, valueStartPos, tagBaseName, boundaryTags);

    // Fall back to JSON-string-aware matching
    if (!closingMatch) {
      closingMatch = findClosingTagMatch(invokeBlock, valueStartPos, tagBaseName);
    }

    // Fall back to loose matching as last resort
    if (!closingMatch) {
      closingMatch = findClosingTagMatchLoose(invokeBlock, valueStartPos, tagBaseName);
    }

    if (closingMatch) {
      const paramValue = invokeBlock.slice(valueStartPos, closingMatch.startIndex).trim();
      args[paramName] = paramValue;
      // Move the regex past this parameter to continue searching
      paramTagRe.lastIndex = closingMatch.endIndex;
    }
  }

  return {
    serverName: null,
    toolName,
    arguments: args
  };
}

/**
 * Parse <function_calls> block containing one or more <invoke> blocks
 * Also handles antml: namespace variants used by Claude Code
 * Uses string-boundary-aware parsing to handle nested </invoke> in content
 */
function parseFunctionCallsBlock(block) {
  const toolCalls = [];
  const invokeTagRe = /<(?:antml:)?invoke\b/gi;
  let invokeMatch;

  while ((invokeMatch = invokeTagRe.exec(block)) !== null) {
    const invokeStart = invokeMatch.index;

    // Find the end of the opening tag
    const tagEnd = block.indexOf('>', invokeStart);
    if (tagEnd === -1) {
      continue;
    }

    // Determine which closing tag to look for based on the opening tag
    const openingTag = block.slice(invokeStart, tagEnd + 1).toLowerCase();
    const isAntml = openingTag.includes('antml:');
    const closingTagName = isAntml ? 'antml:invoke' : 'invoke';

    // Use string-boundary-aware matching to find the proper closing tag
    let closingMatch = findClosingTagMatch(block, tagEnd + 1, closingTagName);
    if (!closingMatch && isAntml) {
      // Try without namespace as fallback
      closingMatch = findClosingTagMatch(block, tagEnd + 1, 'invoke');
    }
    if (!closingMatch) {
      // Fall back to loose matching
      closingMatch = findClosingTagMatchLoose(block, tagEnd + 1, closingTagName);
    }
    if (!closingMatch && isAntml) {
      closingMatch = findClosingTagMatchLoose(block, tagEnd + 1, 'invoke');
    }

    if (closingMatch) {
      const invokeBlock = block.slice(invokeStart, closingMatch.endIndex);
      const toolCall = parseInvokeBlock(invokeBlock);
      if (toolCall) {
        toolCalls.push(toolCall);
      }
      // Move the regex past this invoke block to continue searching
      invokeTagRe.lastIndex = closingMatch.endIndex;
    }
  }

  return toolCalls;
}

/**
 * Parse <tool_call> block with JSON content
 * Format: <tool_call>{"name": "ToolName", "parameters": {...}}</tool_call>
 */
function parseToolCallJsonBlock(block) {
  const jsonContent = extractXmlTagValueSafe(block, 'tool_call');
  if (!jsonContent) {
    return null;
  }

  try {
    const toolCall = parseToolCallJsonContent(jsonContent);
    if (!toolCall) {
      return null;
    }
    return {
      serverName: null,
      toolName: toolCall.toolName,
      toolUseId: toolCall.toolUseId,
      arguments: toolCall.arguments
    };
  } catch (error) {
    log.warn('Failed to parse tool_call JSON', { error: error.message });
  }
}

/**
 * Parse <tool_use> block with JSON content
 * Format: <tool_use id="toolu_x" name="ToolName">{...}</tool_use>
 */
function parseToolUseBlock(block) {
  const toolUseId = extractXmlAttribute(block, 'tool_use', 'id');
  const toolName = extractXmlAttribute(block, 'tool_use', 'name');
  if (!toolName) {
    const inputText = extractXmlTagValueSafe(block, 'tool_use');
    if (!inputText) {
      return null;
    }
    const toolCall = parseToolCallJsonContent(inputText);
    if (!toolCall) {
      return null;
    }
    return {
      serverName: null,
      toolName: toolCall.toolName,
      toolUseId: toolUseId || toolCall.toolUseId,
      arguments: toolCall.arguments
    };
  }

  const inputText = stripCdata(extractXmlTagValueSafe(block, 'tool_use'));
  let parsedArgs = {};

  if (inputText && inputText.length > 0) {
    const trimmedInput = inputText.trim();
    let repairedInput = parseJsonWithRepair(trimmedInput);
    if (repairedInput === null) {
      const extracted = extractFirstJsonObject(trimmedInput);
      if (extracted) {
        repairedInput = parseJsonWithRepair(extracted);
      }
    }
    parsedArgs = repairedInput !== null ? repairedInput : { _raw: trimmedInput };
  }

  return {
    serverName: null,
    toolName,
    toolUseId,
    arguments: parsedArgs
  };
}

/**
 * Parse any tool call block format and return array of tool calls
 */
function parseAnyToolCallBlock(block) {
  const leadingTag = getLeadingTagName(block);
  if (leadingTag === 'mcp_tool_call') {
    const toolCall = parseMcpToolCallBlock(block);
    return toolCall ? [toolCall] : [];
  }
  if (leadingTag === 'function_calls' || leadingTag === 'antml:function_calls') {
    return parseFunctionCallsBlock(block);
  }
  if (leadingTag === 'invoke' || leadingTag === 'antml:invoke') {
    const toolCall = parseInvokeBlock(block);
    return toolCall ? [toolCall] : [];
  }
  if (leadingTag === 'tool_call') {
    const toolCall = parseToolCallJsonBlock(block);
    return toolCall ? [toolCall] : [];
  }
  if (leadingTag === 'tool_use') {
    const toolCall = parseToolUseBlock(block);
    return toolCall ? [toolCall] : [];
  }
  const blockLower = block.toLowerCase();
  if (blockLower.includes(MCP_TOOL_CALL_START_TAG)) {
    const toolCall = parseMcpToolCallBlock(block);
    return toolCall ? [toolCall] : [];
  }
  if (includesAny(blockLower, FUNCTION_CALLS_TAGS)) {
    return parseFunctionCallsBlock(block);
  }
  if (includesAny(blockLower, INVOKE_TAGS)) {
    const toolCall = parseInvokeBlock(block);
    return toolCall ? [toolCall] : [];
  }
  if (blockLower.includes('<tool_call')) {
    const toolCall = parseToolCallJsonBlock(block);
    return toolCall ? [toolCall] : [];
  }
  if (blockLower.includes('<tool_use')) {
    const toolCall = parseToolUseBlock(block);
    return toolCall ? [toolCall] : [];
  }
  return [];
}

function parseIncompleteToolCallBlocks(block, options = {}) {
  if (!block) {
    return [];
  }

  const leadingTag = getLeadingTagName(block);
  if (!leadingTag) {
    return [];
  }

  const allowFunctionCalls = options.allowFunctionCalls !== false;

  if (allowFunctionCalls) {
    if (leadingTag === 'function_calls' || leadingTag === 'antml:function_calls') {
      return parseFunctionCallsBlock(block);
    }
    if (leadingTag === 'invoke' || leadingTag === 'antml:invoke') {
      const toolCall = parseInvokeBlock(block);
      return toolCall ? [toolCall] : [];
    }
  }

  if (leadingTag === 'tool_call') {
    const startTagEnd = block.indexOf('>');
    if (startTagEnd === -1) {
      return [];
    }
    const jsonContent = block.slice(startTagEnd + 1).trim();
    if (!jsonContent) {
      return [];
    }
    const toolCall = parseToolCallJsonContent(jsonContent);
    if (!toolCall) {
      return [];
    }
    return [{
      serverName: null,
      toolName: toolCall.toolName,
      toolUseId: toolCall.toolUseId,
      arguments: toolCall.arguments
    }];
  }

  if (leadingTag === 'tool_use') {
    const startTagEnd = block.indexOf('>');
    if (startTagEnd === -1) {
      return [];
    }
    const toolUseId = extractXmlAttribute(block, 'tool_use', 'id');
    const toolName = extractXmlAttribute(block, 'tool_use', 'name');
    const inputText = stripCdata(block.slice(startTagEnd + 1));

    if (toolName) {
      let parsedArgs = {};
      if (inputText && inputText.trim().length > 0) {
        const trimmedInput = inputText.trim();
        let repairedInput = parseJsonWithRepair(trimmedInput);
        if (repairedInput === null) {
          const extracted = extractFirstJsonObject(trimmedInput);
          if (extracted) {
            repairedInput = parseJsonWithRepair(extracted);
          }
        }
        parsedArgs = repairedInput !== null ? repairedInput : { _raw: trimmedInput };
      }
      return [{
        serverName: null,
        toolName,
        toolUseId,
        arguments: parsedArgs
      }];
    }

    if (!inputText) {
      return [];
    }
    const toolCall = parseToolCallJsonContent(inputText);
    if (!toolCall) {
      return [];
    }
    return [{
      serverName: null,
      toolName: toolCall.toolName,
      toolUseId: toolUseId || toolCall.toolUseId,
      arguments: toolCall.arguments
    }];
  }

  return [];
}

function splitMcpToolCalls(text, allowIncomplete = false) {
  if (!text) {
    return [];
  }

  const { segments, lastIndex } = extractToolCallSegments(text);
  if (lastIndex < text.length) {
    const remainder = text.slice(lastIndex);
    if (allowIncomplete) {
      const incompleteBlocks = parseIncompleteToolCallBlocks(remainder);
      if (incompleteBlocks.length > 0) {
        for (const toolCall of incompleteBlocks) {
          segments.push({ type: 'tool_call', toolCall });
        }
        return segments;
      }
    }
    segments.push({ type: 'text', text: remainder });
  }
  return segments;
}

function splitStreamTextForMcpToolCalls(text) {
  const segments = [];

  // Maximum buffer size before we give up waiting for a closing tag.
  // Keep this large enough for file-edit tool calls while still bounded.
  const MAX_BUFFER_SIZE = MAX_TOOL_CALL_BUFFER_SIZE;

  const { segments: parsedSegments, lastIndex } = extractToolCallSegments(text);
  segments.push(...parsedSegments);

  const trailing = text.slice(lastIndex);
  if (!trailing) {
    return { segments, remainder: '' };
  }

  const nextTag = findNextToolTag(trailing, 0);
  if (nextTag) {
    const startIndex = nextTag.index;
    const potentialRemainder = trailing.slice(startIndex);
    if (potentialRemainder.length > MAX_BUFFER_SIZE) {
      const incompleteBlocks = parseIncompleteToolCallBlocks(potentialRemainder, {
        allowFunctionCalls: false
      });
      if (incompleteBlocks.length > 0) {
        if (startIndex > 0) {
          segments.push({ type: 'text', text: trailing.slice(0, startIndex) });
        }
        for (const toolCall of incompleteBlocks) {
          segments.push({ type: 'tool_call', toolCall });
        }
        return { segments, remainder: '' };
      }
      if (startIndex > 0) {
        segments.push({ type: 'text', text: trailing.slice(0, startIndex) });
      }
      return { segments, remainder: potentialRemainder };
    }
    if (startIndex > 0) {
      segments.push({ type: 'text', text: trailing.slice(0, startIndex) });
    }
    return { segments, remainder: potentialRemainder };
  }

  // Check for partial tag at end (e.g., "<mcp_tool" or "<function" or "<tool_c" or "<")
  const lastLt = trailing.lastIndexOf('<');
  if (lastLt !== -1) {
    const possibleTag = trailing.slice(lastLt);
    const matchingTag = TOOL_TAG_NAMES.find(tag => `<${tag}`.startsWith(possibleTag));
    if (matchingTag && isLikelyToolTagStart(trailing, lastLt, matchingTag)) {
      if (lastLt > 0) {
        segments.push({ type: 'text', text: trailing.slice(0, lastLt) });
      }
      return { segments, remainder: possibleTag };
    }
  }

  segments.push({ type: 'text', text: trailing });
  return { segments, remainder: '' };
}

/**
 * Check if a model supports extended thinking
 * @param {string} model - Model name
 * @returns {boolean} True if model supports thinking
 */
export function isThinkingModel(model) {
  if (!model) return false;
  const modelLower = model.toLowerCase();
  // Models with "-thinking" suffix or explicit thinking models
  return modelLower.includes('-thinking') ||
         modelLower.includes('thinking') ||
         // Claude Opus 4.5 models may support thinking with explicit parameter
         modelLower.includes('opus-4.5') ||
         modelLower.includes('opus-4-5');
}

/**
 * Generate a unique tool use ID in Anthropic format
 * @returns {string} Tool use ID like toolu_01XFDUDYJgAACzvnptvVoYEL
 */
function generateToolUseId() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = 'toolu_01';
  for (let i = 0; i < 22; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

function mapStopReason(value) {
  if (!value || typeof value !== 'string') {
    return null;
  }
  const normalized = value.toLowerCase();
  if (normalized === 'stop_sequence' || normalized === 'stop-sequence' || normalized === 'stopsequence') {
    return 'stop_sequence';
  }
  if (normalized === 'max_tokens' || normalized === 'max-tokens' || normalized === 'length' || normalized === 'max_tokens_exceeded') {
    return 'max_tokens';
  }
  if (normalized === 'tool_use' || normalized === 'tool-use' || normalized === 'tool' || normalized === 'function_call') {
    return 'tool_use';
  }
  if (normalized === 'end_turn' || normalized === 'end-turn' || normalized === 'stop' || normalized === 'eos') {
    return 'end_turn';
  }
  return null;
}

/**
 * Transformer class to convert HopGPT SSE events to Anthropic SSE format
 * Supports extended thinking and tool use for compatible models
 */
export class HopGPTToAnthropicTransformer {
  constructor(model = 'claude-sonnet-4-20250514', options = {}) {
    this.messageId = `msg_${uuidv4().replace(/-/g, '').slice(0, 24)}`;
    this.model = model;
    this.hasStarted = false;
    this.inputTokens = 0;
    this.outputTokens = 0;
    this.conversationId = null;
    this.responseMessageId = null;
    this.systemPrompt = options.systemPrompt ?? null;

    // Thinking support
    this.thinkingEnabled = options.thinkingEnabled ?? isThinkingModel(model);
    this.currentBlockIndex = -1;  // Will be incremented when blocks start
    this.currentBlockType = null; // 'thinking', 'text', or 'tool_use'
    this.blockStarted = false;    // Track if current block has started
    this.hasEmittedNonThinkingContent = false;

    // Accumulated content for non-streaming responses
    this.contentBlocks = [];      // Array of {type, content, signature?}
    this.accumulatedText = '';    // For backward compatibility
    this.accumulatedThinking = '';
    this.thinkingSignature = null;
    this.mcpToolCallBuffer = '';
    this._toolBufferWarningEmitted = false;
    this._nextToolBufferWarningAt = TOOL_CALL_BUFFER_WARN_THRESHOLD;

    // Tool use support
    this.currentToolUse = null;   // Current tool use being streamed {id, name, inputJson}
    this.accumulatedToolUses = []; // All completed tool uses
    this.hasToolUse = false;      // Track if response contains tool use

    // MCP tool call passthrough mode - when enabled, <mcp_tool_call> blocks are
    // passed through as text instead of being converted to tool_use blocks.
    // This is needed for clients like OpenCode that parse and execute tool calls
    // directly from the text stream.
    this.mcpPassthrough = options.mcpPassthrough ?? false;

    this.availableToolNames = Array.isArray(options.toolNames)
      ? options.toolNames
        .filter((name) => typeof name === 'string' && name.trim().length > 0)
        .map((name) => name.trim())
      : [];
    this.availableToolNameSet = new Set(this.availableToolNames);
    this.availableToolNameLowerMap = new Map();
    this.availableToolNamesNormalized = [];
    for (const name of this.availableToolNames) {
      const lower = name.toLowerCase();
      if (!this.availableToolNameLowerMap.has(lower)) {
        this.availableToolNameLowerMap.set(lower, name);
      }
      this.availableToolNamesNormalized.push({
        name,
        normalized: normalizeToolNameToken(name)
      });
    }
    this.genericMcpToolName = this._detectGenericMcpToolName();

    // Stop streaming once a tool_use is emitted (Anthropic tool-use behavior).
    this.stopOnToolUse = options.stopOnToolUse ?? false;
    this._stopRequested = false;
    this._suppressOutput = false;

    this._textSanitizeBuffer = '';
    this._toolLeakActive = false;
    this._lastTextChunk = null;

    this.maxTokens = normalizeMaxTokens(options.maxTokens);
    this.stopSequences = normalizeStopSequences(options.stopSequences);
    this.hopGPTStopReason = null;
    this.hopGPTStopSequence = null;
  }

  /**
   * Transform a HopGPT SSE event to Anthropic SSE event(s)
   * @param {object} event - Parsed SSE event with 'event' and 'data' fields
   * @returns {Array|null} Array of Anthropic SSE events or null if event should be skipped
   */
  transformEvent(event) {
    try {
      const data = JSON.parse(event.data);
      const suppressOutput = this._suppressOutput;
      const events = this._transformData(data);
      if (suppressOutput) {
        return null;
      }
      return events;
    } catch (error) {
      log.error('Failed to parse SSE event', { error: error.message });
      return null;
    }
  }

  _transformData(data) {
    // Event type 1: Initial message created
    if (data.created && data.message) {
      const createdMessageId = data.message?.messageId || data.message?.id;
      if (createdMessageId && !this.responseMessageId) {
        this.responseMessageId = createdMessageId;
      }
      const createdConversationId = data.message?.conversationId || data.conversation?.conversationId;
      if (createdConversationId && !this.conversationId) {
        this.conversationId = createdConversationId;
      }
      return this._createMessageStart();
    }

    // Event type 2: on_run_step - skip (internal HopGPT event)
    if (data.event === 'on_run_step') {
      return null;
    }

    // Event type 3: on_message_delta - content chunks (text or thinking)
    if (data.event === 'on_message_delta') {
      const deltaContent = data.data?.delta?.content;
      if (deltaContent && deltaContent.length > 0) {
        const events = [];

        // Process all content blocks (may include thinking and text)
        for (const block of deltaContent) {
          const blockEvents = this._processContentBlock(block);
          if (blockEvents) {
            events.push(...blockEvents);
          }
        }

        // Also check for thoughtSignature in the delta
        if (data.data?.delta?.thoughtSignature) {
          this.thinkingSignature = data.data.delta.thoughtSignature;
          cacheThinkingSignature(this.thinkingSignature, 'claude');
        }

        if (this.stopOnToolUse && this._stopRequested && !this._hasEmittedMessageStop) {
          this.mcpToolCallBuffer = '';
          this._toolBufferWarningEmitted = false;
          this._nextToolBufferWarningAt = TOOL_CALL_BUFFER_WARN_THRESHOLD;
          const stopEvents = this._createMessageStop();
          if (stopEvents) {
            events.push(...stopEvents);
          }
        }

        return events.length > 0 ? events : null;
      }
      return null;
    }

    // Event type 4: final - end of stream
    if (data.final) {
      const finalConversationId = data.conversation?.conversationId;
      if (finalConversationId) {
        this.conversationId = finalConversationId;
      }
      const finalMessageId = data.responseMessage?.messageId;
      if (finalMessageId) {
        this.responseMessageId = finalMessageId;
      }
      this.inputTokens = data.responseMessage?.promptTokens || 0;
      this.outputTokens = data.responseMessage?.tokenCount || 0;
      this.hopGPTStopReason = data.responseMessage?.stopReason ??
        data.responseMessage?.stop_reason ??
        data.responseMessage?.finishReason ??
        data.responseMessage?.finish_reason ??
        null;
      this.hopGPTStopSequence = data.responseMessage?.stopSequence ??
        data.responseMessage?.stop_sequence ??
        null;

      // Check for thoughtSignature in final response
      if (data.responseMessage?.thoughtSignature) {
        this.thinkingSignature = data.responseMessage.thoughtSignature;
        cacheThinkingSignature(this.thinkingSignature, 'claude');
      }

      // Extract content blocks from final message for non-streaming
      const finalContent = this._normalizeFinalContent(data.responseMessage);
      if (finalContent) {
        this._extractFinalContent(finalContent);
      }

      if (this._hasEmittedMessageStop) {
        return null;
      }

      const events = [];
      if (finalContent && finalContent.length > 0 && !this.hasEmittedNonThinkingContent) {
        this.mcpToolCallBuffer = '';
        this._toolBufferWarningEmitted = false;
        this._nextToolBufferWarningAt = TOOL_CALL_BUFFER_WARN_THRESHOLD;
        const finalEvents = this._emitFinalContentBlocks(finalContent);
        if (finalEvents.length > 0) {
          events.push(...finalEvents);
        }
      }

      const stopEvents = this._createMessageStop();
      if (stopEvents) {
        events.push(...stopEvents);
      }

      return events.length > 0 ? events : null;
    }

    return null;
  }

  _sanitizeTextChunk(text) {
    if (!text) {
      return '';
    }

    let source = `${this._textSanitizeBuffer}${text}`;
    this._textSanitizeBuffer = '';
    let output = '';

    let processing = source;
    let processLimit = processing.length;
    if (!this._toolLeakActive && processing.length > SANITIZE_TAIL_LENGTH) {
      processLimit = processing.length - SANITIZE_TAIL_LENGTH;
    }

    while (processing.length > 0) {
      if (this._toolLeakActive) {
        const assistantIndex = findNextAssistantMarkerIndex(processing, 0);
        if (assistantIndex === -1) {
          this._textSanitizeBuffer = processing.slice(-SANITIZE_TAIL_LENGTH);
          return stripRolePrefixes(output);
        }
        processing = processing.slice(assistantIndex);
        this._toolLeakActive = false;
        processLimit = processing.length;
        if (processing.length > SANITIZE_TAIL_LENGTH) {
          processLimit = processing.length - SANITIZE_TAIL_LENGTH;
        }
        continue;
      }

      const startIndex = findToolInstructionStartIndex(processing, 0);
      if (startIndex === -1 || startIndex >= processLimit) {
        output += processing.slice(0, processLimit);
        processing = processing.slice(processLimit);
        break;
      }

      output += processing.slice(0, startIndex);
      const assistantIndex = findNextAssistantMarkerIndex(processing, startIndex);
      if (assistantIndex === -1) {
        this._toolLeakActive = true;
        this._textSanitizeBuffer = processing.slice(startIndex);
        return stripRolePrefixes(output);
      }

      processing = processing.slice(assistantIndex);
      processLimit = processing.length;
      if (processing.length > SANITIZE_TAIL_LENGTH) {
        processLimit = processing.length - SANITIZE_TAIL_LENGTH;
      }
    }

    if (!this._toolLeakActive) {
      this._textSanitizeBuffer = processing;
    }

    return stripRolePrefixes(output);
  }

  _flushSanitizedText() {
    if (!this._textSanitizeBuffer) {
      this._toolLeakActive = false;
      return '';
    }

    let remaining = this._textSanitizeBuffer;
    this._textSanitizeBuffer = '';

    if (this._toolLeakActive) {
      const assistantIndex = findNextAssistantMarkerIndex(remaining, 0);
      this._toolLeakActive = false;
      if (assistantIndex === -1) {
        return '';
      }
      remaining = remaining.slice(assistantIndex);
    }

    return sanitizeTextFull(remaining);
  }

  /**
   * Process a single content block from delta
   */
  _processContentBlock(block) {
    const events = [];

    // Handle thinking blocks
    if (block.type === 'thinking' && block.thinking) {
      // If we were in a different block type, close it first
      if (this.blockStarted && this.currentBlockType !== 'thinking') {
        events.push(this._createBlockStop());
      }

      // Start thinking block if needed
      if (!this.blockStarted || this.currentBlockType !== 'thinking') {
        const startEvent = this._createBlockStart('thinking');
        if (startEvent) events.push(startEvent);
      }

      // Add thinking delta
      this.accumulatedThinking += block.thinking;
      events.push({
        event: 'content_block_delta',
        data: {
          type: 'content_block_delta',
          index: this.currentBlockIndex,
          delta: {
            type: 'thinking_delta',
            thinking: block.thinking
          }
        }
      });

      // Capture signature if present
      if (block.signature) {
        this.thinkingSignature = block.signature;
        cacheThinkingSignature(this.thinkingSignature, 'claude');
      }

      return events;
    }

    // Handle text blocks
    if (block.type === 'text' && block.text) {
      const sanitizedText = this._sanitizeTextChunk(block.text);
      if (!sanitizedText) {
        return events.length > 0 ? events : null;
      }

      // In passthrough mode, don't parse MCP tool calls - just emit text as-is
      if (this.mcpPassthrough) {
        events.push(...this._emitTextDelta(sanitizedText));
        return events.length > 0 ? events : null;
      }

      if (process.env.HOPGPT_DEBUG === 'true') {
        const hasToolCallTag = sanitizedText.includes('<tool_call') ||
                               includesAny(sanitizedText, FUNCTION_CALLS_TAGS) ||
                               sanitizedText.includes(MCP_TOOL_CALL_START_TAG) ||
                               sanitizedText.includes(TOOL_USE_START_TAG) ||
                               includesAny(sanitizedText, INVOKE_TAGS);
        if (hasToolCallTag) {
          log.debug('Text contains tool call XML', { preview: sanitizedText.slice(0, 200) });
        }
      }

      const combined = `${this.mcpToolCallBuffer}${sanitizedText}`;
      const { segments, remainder } = splitStreamTextForMcpToolCalls(combined);
      this.mcpToolCallBuffer = remainder;

      if (!remainder) {
        this._toolBufferWarningEmitted = false;
        this._nextToolBufferWarningAt = TOOL_CALL_BUFFER_WARN_THRESHOLD;
      }

      if (remainder && remainder.length >= this._nextToolBufferWarningAt) {
        const preview = remainder.slice(0, 200);
        log.warn('Large tool call buffer detected', {
          size: remainder.length,
          nextWarningAt: this._nextToolBufferWarningAt,
          preview
        });
        if (TOOL_CALL_BUFFER_WARN_STEP > 0) {
          const steps = Math.floor(
            (remainder.length - this._nextToolBufferWarningAt) / TOOL_CALL_BUFFER_WARN_STEP
          ) + 1;
          this._nextToolBufferWarningAt += steps * TOOL_CALL_BUFFER_WARN_STEP;
        } else {
          this._nextToolBufferWarningAt = remainder.length + 1;
        }
      }

      if (process.env.HOPGPT_DEBUG === 'true') {
        const toolCalls = segments.filter(s => s.type === 'tool_call');
        if (toolCalls.length > 0) {
          log.debug('Parsed tool calls from text', {
            count: toolCalls.length,
            tools: toolCalls.map(tc => tc.toolCall?.toolName)
          });
        }
      }

      for (const segment of segments) {
        if (segment.type === 'text') {
          events.push(...this._emitTextDelta(segment.text));
          continue;
        }
        if (segment.type === 'tool_call') {
          const toolBlock = this._buildToolUseFromCall(segment.toolCall);
          if (toolBlock) {
            events.push(...this._processToolUseBlock(toolBlock));
          }
          if (this.stopOnToolUse) {
            break;
          }
        }
      }

      return events.length > 0 ? events : null;
    }

    // Handle tool_use blocks
    if (block.type === 'tool_use') {
      if (block.thoughtSignature && block.id) {
        cacheToolSignature(block.id, block.thoughtSignature);
      }
      return this._processToolUseBlock(block);
    }

    return null;
  }

  /**
   * Extract content blocks from final message
   */
  _extractFinalContent(content) {
    let stopAfterTool = false;
    for (const block of content) {
      if (stopAfterTool) {
        break;
      }
      if (block.type === 'thinking') {
        if (block.signature) {
          cacheThinkingSignature(block.signature, 'claude');
        }
        this.contentBlocks.push({
          type: 'thinking',
          thinking: block.thinking || this.accumulatedThinking,
          signature: block.signature || this.thinkingSignature
        });
      } else if (block.type === 'text') {
        // In passthrough mode, don't parse MCP tool calls - preserve text as-is
        if (this.mcpPassthrough) {
          const sanitizedText = sanitizeTextFull(block.text || '');
          if (sanitizedText) {
            const lastBlock = this.contentBlocks[this.contentBlocks.length - 1];
            if (lastBlock?.type === 'text' &&
                sanitizedText.length >= DUPLICATE_TEXT_CHUNK_MIN_LENGTH &&
                sanitizedText === lastBlock.text) {
              continue;
            }
            this.contentBlocks.push({
              type: 'text',
              text: sanitizedText
            });
            this.accumulatedText += sanitizedText;
          }
          continue;
        }

        const sanitizedText = sanitizeTextFull(block.text || '');
        const segments = splitMcpToolCalls(sanitizedText, true);
        for (const segment of segments) {
          if (stopAfterTool) {
            break;
          }
          if (segment.type === 'text') {
            if (!segment.text) continue;
            const lastBlock = this.contentBlocks[this.contentBlocks.length - 1];
            if (lastBlock?.type === 'text' &&
                segment.text.length >= DUPLICATE_TEXT_CHUNK_MIN_LENGTH &&
                segment.text === lastBlock.text) {
              continue;
            }
            this.contentBlocks.push({
              type: 'text',
              text: segment.text
            });
            this.accumulatedText += segment.text;
            continue;
          }
          if (segment.type === 'tool_call') {
            this.hasToolUse = true;
            const toolBlock = this._buildToolUseFromCall(segment.toolCall);
            if (!toolBlock) {
              continue;
            }
            this.contentBlocks.push({
              type: 'tool_use',
              id: toolBlock.id,
              name: toolBlock.name,
              input: toolBlock.input
            });
            if (this.stopOnToolUse) {
              stopAfterTool = true;
            }
          }
        }
      } else if (block.type === 'tool_use') {
        this.hasToolUse = true;
        let input = block.input;

        // Parse input if it's a string
        if (typeof input === 'string') {
          try {
            input = JSON.parse(input);
          } catch (e) {
            input = { _raw: input };
          }
        }
        input = normalizeToolInput(block.name, input);

        this.contentBlocks.push({
          type: 'tool_use',
          id: block.id || generateToolUseId(),
          name: block.name || '',
          input: input || {}
        });
        if (this.stopOnToolUse) {
          stopAfterTool = true;
        }
      }
    }
  }

  _emitFinalContentBlocks(content) {
    if (!Array.isArray(content) || content.length === 0) {
      return [];
    }

    const events = [];
    let stopAfterTool = false;

    for (const block of content) {
      if (stopAfterTool) {
        break;
      }

      if (block.type === 'thinking' && block.thinking) {
        const blockEvents = this._processContentBlock(block);
        if (blockEvents) {
          events.push(...blockEvents);
        }
        continue;
      }

      if (block.type === 'text') {
        if (this.mcpPassthrough) {
          const sanitizedText = sanitizeTextFull(block.text || '');
          if (sanitizedText) {
            events.push(...this._emitTextDelta(sanitizedText));
          }
          continue;
        }

        const sanitizedText = sanitizeTextFull(block.text || '');
        const segments = splitMcpToolCalls(sanitizedText, true);
        for (const segment of segments) {
          if (stopAfterTool) {
            break;
          }
          if (segment.type === 'text') {
            if (segment.text) {
              events.push(...this._emitTextDelta(segment.text));
            }
            continue;
          }
          if (segment.type === 'tool_call') {
            const toolBlock = this._buildToolUseFromCall(segment.toolCall);
            if (toolBlock) {
              events.push(...this._processToolUseBlock(toolBlock));
            }
            if (this.stopOnToolUse) {
              stopAfterTool = true;
            }
          }
        }
        continue;
      }

      if (block.type === 'tool_use') {
        const blockEvents = this._processToolUseBlock(block);
        if (blockEvents) {
          events.push(...blockEvents);
        }
        if (this.stopOnToolUse) {
          stopAfterTool = true;
        }
      }
    }

    return events;
  }

  _emitTextDelta(text) {
    if (!text) {
      return [];
    }

    const events = [];
    this.hasEmittedNonThinkingContent = true;

    const startingNewTextBlock = !this.blockStarted || this.currentBlockType !== 'text';
    if (startingNewTextBlock) {
      this._lastTextChunk = null;
    }

    if (this._lastTextChunk &&
        text.length >= DUPLICATE_TEXT_CHUNK_MIN_LENGTH &&
        text === this._lastTextChunk) {
      return [];
    }

    if (this.blockStarted && this.currentBlockType !== 'text') {
      // Save tool use before switching away from tool_use block
      if (this.currentBlockType === 'tool_use' && this.currentToolUse) {
        this.accumulatedToolUses.push({...this.currentToolUse});
        this.currentToolUse = null;
      }
      events.push(this._createBlockStop());
    }

    if (!this.blockStarted || this.currentBlockType !== 'text') {
      const startEvent = this._createBlockStart('text');
      if (Array.isArray(startEvent)) {
        events.push(...startEvent);
      } else if (startEvent) {
        events.push(startEvent);
      }
    }

    this.accumulatedText += text;
    events.push({
      event: 'content_block_delta',
      data: {
        type: 'content_block_delta',
        index: this.currentBlockIndex,
        delta: {
          type: 'text_delta',
          text
        }
      }
    });
    this._lastTextChunk = text;

    return events;
  }

  _processToolUseBlock(block) {
    const events = [];
    this.hasToolUse = true;
    this.hasEmittedNonThinkingContent = true;
    if (this.stopOnToolUse) {
      this._stopRequested = true;
    }

    const toolId = block.id || (this.currentToolUse?.id);
    const toolName = block.name || (this.currentToolUse?.name);

    if (this.blockStarted && (this.currentBlockType !== 'tool_use' ||
        (this.currentToolUse && this.currentToolUse.id !== toolId))) {
      if (this.currentBlockType === 'tool_use' && this.currentToolUse) {
        this.accumulatedToolUses.push({...this.currentToolUse});
      }
      events.push(this._createBlockStop());
    }

    if (!this.blockStarted || this.currentBlockType !== 'tool_use' ||
        (this.currentToolUse && this.currentToolUse.id !== toolId)) {
      this.currentToolUse = {
        id: toolId || generateToolUseId(),
        name: toolName || '',
        inputJson: ''
      };
      const startEvent = this._createBlockStart('tool_use', this.currentToolUse);
      if (Array.isArray(startEvent)) {
        events.push(...startEvent);
      } else if (startEvent) {
        events.push(startEvent);
      }
    }

    if (block.name && !this.currentToolUse.name) {
      this.currentToolUse.name = block.name;
    }

    if (block.input !== undefined) {
      let inputDelta = '';
      if (typeof block.input === 'string') {
        const trimmedInput = block.input.trim();
        let parsedInput = null;
        if (trimmedInput) {
          parsedInput = parseJsonWithRepair(trimmedInput);
          if (parsedInput === null) {
            const extracted = extractFirstJsonObject(trimmedInput);
            if (extracted) {
              parsedInput = parseJsonWithRepair(extracted);
            }
          }
        }
        const normalizedInput = parsedInput && typeof parsedInput === 'object'
          ? normalizeToolInput(toolName, parsedInput)
          : { _raw: block.input };
        inputDelta = JSON.stringify(normalizedInput);
        this.currentToolUse.inputJson = inputDelta;
      } else if (typeof block.input === 'object') {
        const normalizedInput = normalizeToolInput(toolName, block.input);
        inputDelta = JSON.stringify(normalizedInput);
        this.currentToolUse.inputJson = inputDelta;
      }

      if (inputDelta) {
        events.push({
          event: 'content_block_delta',
          data: {
            type: 'content_block_delta',
            index: this.currentBlockIndex,
            delta: {
              type: 'input_json_delta',
              partial_json: inputDelta
            }
          }
        });
      }
    }

    if (block.input_json !== undefined) {
      this.currentToolUse.inputJson += block.input_json;
      events.push({
        event: 'content_block_delta',
        data: {
          type: 'content_block_delta',
          index: this.currentBlockIndex,
          delta: {
            type: 'input_json_delta',
            partial_json: block.input_json
          }
        }
      });
    }

    return events;
  }

  _getGeneratedText() {
    if (this.contentBlocks.length > 0) {
      return this.contentBlocks
        .filter(block => block.type === 'text' && typeof block.text === 'string')
        .map(block => block.text)
        .join('');
    }

    return this.accumulatedText || '';
  }

  _detectStopSequence() {
    if (!this.stopSequences || this.stopSequences.length === 0) {
      return null;
    }

    const text = this._getGeneratedText();
    if (!text) {
      return null;
    }

    for (const sequence of this.stopSequences) {
      if (sequence && text.endsWith(sequence)) {
        return sequence;
      }
    }

    return null;
  }

  _determineStopInfo() {
    if (this.hasToolUse) {
      return { stopReason: 'tool_use', stopSequence: null };
    }

    const mappedReason = mapStopReason(this.hopGPTStopReason);
    if (mappedReason) {
      if (mappedReason === 'stop_sequence') {
        const sequence = typeof this.hopGPTStopSequence === 'string' && this.hopGPTStopSequence.length > 0
          ? this.hopGPTStopSequence
          : this._detectStopSequence();
        return { stopReason: 'stop_sequence', stopSequence: sequence || null };
      }
      return { stopReason: mappedReason, stopSequence: null };
    }

    const detectedSequence = this._detectStopSequence();
    if (detectedSequence) {
      return { stopReason: 'stop_sequence', stopSequence: detectedSequence };
    }

    if (this.maxTokens !== null && this.outputTokens >= this.maxTokens) {
      return { stopReason: 'max_tokens', stopSequence: null };
    }

    return { stopReason: 'end_turn', stopSequence: null };
  }

  _createMessageStart() {
    if (this.hasStarted) {
      return null;
    }
    this.hasStarted = true;

    // Just emit message_start, blocks will be started as content arrives
    return [
      {
        event: 'message_start',
        data: {
          type: 'message_start',
          message: {
            id: this.messageId,
            type: 'message',
            role: 'assistant',
            content: [],
            model: this.model,
            stop_reason: null,
            stop_sequence: null,
            usage: {
              input_tokens: 0,
              output_tokens: 0
            }
          }
        }
      }
    ];
  }

  /**
   * Create a content block start event
   */
  _createBlockStart(blockType, toolUseInfo = null) {
    this.currentBlockIndex++;
    this.currentBlockType = blockType;
    this.blockStarted = true;

    // Ensure message has started
    const events = [];
    if (!this.hasStarted) {
      const startEvents = this._createMessageStart();
      if (startEvents) events.push(...startEvents);
    }

    if (blockType === 'thinking') {
      events.push({
        event: 'content_block_start',
        data: {
          type: 'content_block_start',
          index: this.currentBlockIndex,
          content_block: {
            type: 'thinking',
            thinking: ''
          }
        }
      });
    } else if (blockType === 'tool_use') {
      events.push({
        event: 'content_block_start',
        data: {
          type: 'content_block_start',
          index: this.currentBlockIndex,
          content_block: {
            type: 'tool_use',
            id: toolUseInfo?.id || generateToolUseId(),
            name: toolUseInfo?.name || ''
          }
        }
      });
    } else {
      events.push({
        event: 'content_block_start',
        data: {
          type: 'content_block_start',
          index: this.currentBlockIndex,
          content_block: {
            type: 'text',
            text: ''
          }
        }
      });
    }

    return events.length === 1 ? events[0] : events;
  }

  /**
   * Create a content block stop event
   */
  _createBlockStop() {
    const event = {
      event: 'content_block_stop',
      data: {
        type: 'content_block_stop',
        index: this.currentBlockIndex
      }
    };
    this.blockStarted = false;
    return event;
  }

  _createContentDelta(text) {
    // Legacy method for backward compatibility
    const events = [];
    this.hasEmittedNonThinkingContent = true;

    // Ensure message and text block have started
    if (!this.hasStarted) {
      const startEvents = this._createMessageStart();
      if (startEvents) events.push(...startEvents);
    }

    if (!this.blockStarted || this.currentBlockType !== 'text') {
      const startEvent = this._createBlockStart('text');
      if (Array.isArray(startEvent)) {
        events.push(...startEvent);
      } else if (startEvent) {
        events.push(startEvent);
      }
    }

    this.accumulatedText += text;
    events.push({
      event: 'content_block_delta',
      data: {
        type: 'content_block_delta',
        index: this.currentBlockIndex,
        delta: {
          type: 'text_delta',
          text
        }
      }
    });

    return events;
  }

  _createMessageStop() {
    const events = [];

    // Mark that we're emitting message_stop
    this._hasEmittedMessageStop = true;
    this._suppressOutput = true;

    if (!this.hasStarted) {
      const startEvents = this._createMessageStart();
      if (startEvents) {
        events.push(...startEvents);
      }
    }

    const flushedText = this._flushSanitizedText();
    if (flushedText) {
      if (this.mcpPassthrough) {
        events.push(...this._emitTextDelta(flushedText));
      } else {
        const combined = `${this.mcpToolCallBuffer}${flushedText}`;
        const { segments, remainder } = splitStreamTextForMcpToolCalls(combined);
        this.mcpToolCallBuffer = remainder;
        for (const segment of segments) {
          if (segment.type === 'text' && segment.text) {
            events.push(...this._emitTextDelta(segment.text));
          } else if (segment.type === 'tool_call') {
            const toolBlock = this._buildToolUseFromCall(segment.toolCall);
            if (toolBlock) {
              events.push(...this._processToolUseBlock(toolBlock));
            }
          }
        }
      }
    }

    // Flush any remaining buffered MCP tool calls
    if (this.mcpToolCallBuffer && !this.mcpPassthrough) {
      const segments = splitMcpToolCalls(this.mcpToolCallBuffer, true);
      for (const segment of segments) {
        if (segment.type === 'text' && segment.text) {
          events.push(...this._emitTextDelta(segment.text));
        } else if (segment.type === 'tool_call') {
          const toolBlock = this._buildToolUseFromCall(segment.toolCall);
          if (toolBlock) {
            events.push(...this._processToolUseBlock(toolBlock));
          }
        }
      }
      this.mcpToolCallBuffer = '';
      this._toolBufferWarningEmitted = false;
      this._nextToolBufferWarningAt = TOOL_CALL_BUFFER_WARN_THRESHOLD;
    }

    // Save current tool use if still in progress
    if (this.currentBlockType === 'tool_use' && this.currentToolUse) {
      this.accumulatedToolUses.push({...this.currentToolUse});
    }

    // Close any open content block
    if (this.blockStarted) {
      events.push(this._createBlockStop());
    }

    const { stopReason, stopSequence } = this._determineStopInfo();

    // Add message_delta with stop reason
    events.push({
      event: 'message_delta',
      data: {
        type: 'message_delta',
        delta: {
          stop_reason: stopReason,
          stop_sequence: stopSequence
        },
        usage: {
          output_tokens: this.outputTokens
        }
      }
    });

    // Add message_stop
    events.push({
      event: 'message_stop',
      data: {
        type: 'message_stop'
      }
    });

    return events;
  }

  _normalizeFinalContent(responseMessage) {
    if (!responseMessage || typeof responseMessage !== 'object') {
      return null;
    }
    if (Array.isArray(responseMessage.content)) {
      return responseMessage.content;
    }
    if (typeof responseMessage.content === 'string' && responseMessage.content.trim().length > 0) {
      return [{ type: 'text', text: responseMessage.content }];
    }
    if (typeof responseMessage.text === 'string' && responseMessage.text.trim().length > 0) {
      return [{ type: 'text', text: responseMessage.text }];
    }
    return null;
  }

  _lookupToolName(candidate) {
    if (!candidate || this.availableToolNames.length === 0) {
      return null;
    }
    if (this.availableToolNameSet.has(candidate)) {
      return candidate;
    }
    const lower = candidate.toLowerCase();
    return this.availableToolNameLowerMap.get(lower) || null;
  }

  _detectGenericMcpToolName() {
    const candidates = [
      'mcp',
      'mcp_tool',
      'mcp_tool_call',
      'mcp_tool_use',
      'mcp_call',
      'mcp.call'
    ];
    for (const candidate of candidates) {
      const match = this._lookupToolName(candidate);
      if (match) {
        return match;
      }
    }
    return null;
  }

  _resolveMcpToolName(serverName, toolName) {
    if (!serverName || !toolName || this.availableToolNames.length === 0) {
      return null;
    }

    const candidates = [
      `${serverName}__${toolName}`,
      `${serverName}_${toolName}`,
      `${serverName}.${toolName}`,
      `${serverName}/${toolName}`,
      `${serverName}:${toolName}`,
      `mcp__${serverName}__${toolName}`,
      `mcp_${serverName}_${toolName}`,
      `mcp-${serverName}-${toolName}`
    ];

    for (const candidate of candidates) {
      const match = this._lookupToolName(candidate);
      if (match) {
        return match;
      }
    }

    const normalizedServer = normalizeToolNameToken(serverName);
    const normalizedTool = normalizeToolNameToken(toolName);
    if (!normalizedServer || !normalizedTool) {
      return null;
    }

    for (const entry of this.availableToolNamesNormalized) {
      const serverIndex = entry.normalized.indexOf(normalizedServer);
      if (serverIndex === -1) {
        continue;
      }
      const toolIndex = entry.normalized.indexOf(normalizedTool);
      if (toolIndex === -1 || toolIndex < serverIndex) {
        continue;
      }
      return entry.name;
    }

    return null;
  }

  _resolveToolCall(toolCall) {
    if (!toolCall) {
      return null;
    }

    let resolvedName = toolCall.toolName ? toolCall.toolName.trim() : '';
    let resolvedInput = toolCall.arguments;

    if (toolCall.serverName) {
      const matchedName = this._resolveMcpToolName(toolCall.serverName, toolCall.toolName);
      if (matchedName) {
        resolvedName = matchedName;
      } else if (this.genericMcpToolName) {
        resolvedName = this.genericMcpToolName;
        resolvedInput = {
          server_name: toolCall.serverName,
          tool_name: toolCall.toolName,
          arguments: resolvedInput ?? {}
        };
      }
    } else if (resolvedName) {
      const matchedName = this._lookupToolName(resolvedName);
      if (matchedName) {
        resolvedName = matchedName;
      } else if (this.availableToolNamesNormalized.length > 0) {
        const normalizedCandidate = normalizeToolNameToken(resolvedName);
        if (normalizedCandidate) {
          const normalizedMatch = this.availableToolNamesNormalized.find(
            (entry) => entry.normalized === normalizedCandidate
          );
          if (normalizedMatch) {
            resolvedName = normalizedMatch.name;
          }
        }
      }
    }

    return {
      name: resolvedName,
      input: resolvedInput,
      toolUseId: toolCall.toolUseId || null
    };
  }

  _buildToolUseFromCall(toolCall) {
    const resolved = this._resolveToolCall(toolCall);
    if (!resolved || !resolved.name) {
      return null;
    }
    return {
      type: 'tool_use',
      id: resolved.toolUseId || generateToolUseId(),
      name: resolved.name,
      input: normalizeToolInput(resolved.name, resolved.input)
    };
  }

  /**
   * Build a complete non-streaming response from accumulated data
   * @returns {object} Anthropic Messages API response
   */
  buildNonStreamingResponse() {
    // Build content array, preferring extracted blocks or falling back to accumulated
    let content = [];

    if (this.contentBlocks.length > 0) {
      // Use extracted content blocks from final message
      content = this.contentBlocks;
    } else {
      // Fall back to accumulated content
      if (this.accumulatedThinking) {
        const thinkingBlock = {
          type: 'thinking',
          thinking: this.accumulatedThinking
        };
        if (this.thinkingSignature) {
          thinkingBlock.signature = this.thinkingSignature;
        }
        content.push(thinkingBlock);
      }

      if (this.accumulatedText) {
        content.push({
          type: 'text',
          text: this.accumulatedText
        });
      }

      // Add accumulated tool uses
      for (const toolUse of this.accumulatedToolUses) {
        let input = {};
        if (toolUse.inputJson) {
          try {
            input = JSON.parse(toolUse.inputJson);
          } catch (e) {
            input = { _raw: toolUse.inputJson };
          }
        }
        input = normalizeToolInput(toolUse.name, input);
        content.push({
          type: 'tool_use',
          id: toolUse.id,
          name: toolUse.name,
          input
        });
      }

      // If no content at all, add empty text block
      if (content.length === 0) {
        content.push({
          type: 'text',
          text: ''
        });
      }
    }

    const { stopReason, stopSequence } = this._determineStopInfo();

    return {
      id: this.messageId,
      type: 'message',
      role: 'assistant',
      content,
      model: this.model,
      stop_reason: stopReason,
      stop_sequence: stopSequence,
      usage: {
        input_tokens: this.inputTokens,
        output_tokens: this.outputTokens
      }
    };
  }

  /**
   * Get conversation state for multi-turn conversations
   * @returns {object} Conversation state
   */
  getConversationState() {
    return {
      conversationId: this.conversationId,
      lastAssistantMessageId: this.responseMessageId,
      systemPrompt: this.systemPrompt
    };
  }

  /**
   * Check if the stream has been properly terminated with message_stop
   * @returns {boolean} True if message_stop has been emitted
   */
  hasEnded() {
    return this._hasEmittedMessageStop === true;
  }

  /**
   * Force cleanup and emit message_stop if the stream ends without a final event
   * This ensures clients always receive a proper termination signal
   * @returns {Array} Array of cleanup SSE events to emit
   */
  forceEnd() {
    // If we've already emitted message_stop, don't do it again
    if (this._hasEmittedMessageStop) {
      return [];
    }

    log.debug('Forcing stream end - no final event received from HopGPT');

    // Use _createMessageStop to properly flush buffer, close blocks, and emit events
    const events = this._createMessageStop();
    this._hasEmittedMessageStop = true;
    return events;
  }
}

/**
 * Format SSE event for writing to response
 * @param {object} event - Event with 'event' and 'data' fields
 * @returns {string} Formatted SSE string
 */
export function formatSSEEvent(event) {
  return `event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`;
}
