import {
  cacheThinkingSignature,
  cacheToolSignature,
  getCachedThinkingSignatureFamily,
  getCachedToolSignature,
  MIN_SIGNATURE_LENGTH,
} from './signatureCache.js';

function isThinkingBlock(block) {
  return block?.type === 'thinking' || block?.thought === true;
}

function getBlockSignature(block) {
  if (!block || typeof block !== 'object') {
    return null;
  }
  if (block.thought === true) {
    return block.thoughtSignature || null;
  }
  return block.signature || null;
}

function hasValidSignature(block) {
  const signature = getBlockSignature(block);
  return typeof signature === 'string' && signature.length >= MIN_SIGNATURE_LENGTH;
}

function sanitizeThinkingBlock(block) {
  if (block.type === 'redacted_thinking') {
    return {
      type: 'redacted_thinking',
      data: block.data,
    };
  }

  if (block.thought === true) {
    return {
      thought: true,
      text: block.text || '',
      thoughtSignature: block.thoughtSignature,
    };
  }

  return {
    type: 'thinking',
    thinking: block.thinking || '',
    signature: block.signature,
  };
}

function restoreToolUseSignature(block) {
  if (!block || block.type !== 'tool_use') {
    return block;
  }

  const nextBlock = { ...block };

  if (nextBlock.id && typeof nextBlock.thoughtSignature === 'string') {
    cacheToolSignature(nextBlock.id, nextBlock.thoughtSignature);
  }

  if (
    (!nextBlock.thoughtSignature || nextBlock.thoughtSignature.length < MIN_SIGNATURE_LENGTH) &&
    nextBlock.id
  ) {
    const cached = getCachedToolSignature(nextBlock.id);
    if (cached) {
      nextBlock.thoughtSignature = cached;
    }
  }

  return nextBlock;
}

function sanitizeContentBlocks(content, targetFamily) {
  if (!Array.isArray(content)) {
    return content;
  }

  const sanitized = [];

  for (const block of content) {
    if (!block || typeof block !== 'object') {
      continue;
    }

    if (block.type === 'redacted_thinking') {
      sanitized.push(sanitizeThinkingBlock(block));
      continue;
    }

    if (isThinkingBlock(block)) {
      if (!hasValidSignature(block)) {
        continue;
      }

      const signature = getBlockSignature(block);
      if (signature) {
        if (targetFamily === 'gemini') {
          const family = getCachedThinkingSignatureFamily(signature);
          if (!family || family !== targetFamily) {
            continue;
          }
        }
        cacheThinkingSignature(signature, targetFamily);
      }

      sanitized.push(sanitizeThinkingBlock(block));
      continue;
    }

    if (block.type === 'tool_use') {
      sanitized.push(restoreToolUseSignature(block));
      continue;
    }

    if (block.type === 'text') {
      if (typeof block.text === 'string' && block.text.trim().length === 0) {
        continue;
      }
    }

    sanitized.push({ ...block });
  }

  return sanitized;
}

function reorderAssistantContent(content) {
  if (!Array.isArray(content)) {
    return content;
  }

  const thinkingBlocks = [];
  const textBlocks = [];
  const toolUseBlocks = [];

  for (const block of content) {
    if (!block) continue;

    if (block.type === 'thinking' || block.type === 'redacted_thinking' || block.thought === true) {
      thinkingBlocks.push(block);
    } else if (block.type === 'tool_use') {
      toolUseBlocks.push(block);
    } else if (block.type === 'text') {
      if (typeof block.text === 'string' && block.text.trim().length === 0) {
        continue;
      }
      textBlocks.push(block);
    } else {
      textBlocks.push(block);
    }
  }

  return [...thinkingBlocks, ...textBlocks, ...toolUseBlocks];
}

function messageHasToolUse(message) {
  const content = message?.content;
  if (!Array.isArray(content)) return false;
  return content.some((block) => block?.type === 'tool_use' || block?.functionCall);
}

function messageHasToolResult(message) {
  const content = message?.content;
  if (!Array.isArray(content)) return false;
  return content.some((block) => block?.type === 'tool_result' || block?.functionResponse);
}

function messageHasValidThinking(message) {
  const content = message?.content;
  if (!Array.isArray(content)) return false;
  return content.some((block) => isThinkingBlock(block) && hasValidSignature(block));
}

function isPlainUserMessage(message) {
  if (message?.role !== 'user') return false;
  const content = message.content;
  if (!Array.isArray(content)) {
    return typeof content === 'string';
  }
  return !content.some((block) => block?.type === 'tool_result' || block?.functionResponse);
}

export function analyzeConversationState(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return {
      inToolLoop: false,
      interruptedTool: false,
      turnHasThinking: false,
      toolResultCount: 0,
    };
  }

  let lastAssistantIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'assistant' || messages[i]?.role === 'model') {
      lastAssistantIdx = i;
      break;
    }
  }

  if (lastAssistantIdx === -1) {
    return {
      inToolLoop: false,
      interruptedTool: false,
      turnHasThinking: false,
      toolResultCount: 0,
    };
  }

  const lastAssistant = messages[lastAssistantIdx];
  const hasToolUse = messageHasToolUse(lastAssistant);
  const hasThinking = messageHasValidThinking(lastAssistant);

  let toolResultCount = 0;
  let hasPlainUserMessageAfter = false;
  for (let i = lastAssistantIdx + 1; i < messages.length; i++) {
    if (messageHasToolResult(messages[i])) {
      toolResultCount++;
    }
    if (isPlainUserMessage(messages[i])) {
      hasPlainUserMessageAfter = true;
    }
  }

  const inToolLoop = hasToolUse && toolResultCount > 0;
  const interruptedTool = hasToolUse && toolResultCount === 0 && hasPlainUserMessageAfter;

  return {
    inToolLoop,
    interruptedTool,
    turnHasThinking: hasThinking,
    toolResultCount,
    lastAssistantIdx,
    hasPlainUserMessageAfter,
  };
}

export function needsThinkingRecovery(messages) {
  const state = analyzeConversationState(messages);
  if (!state.interruptedTool) return false;
  return !state.turnHasThinking;
}

function stripInvalidThinkingBlocks(messages, targetFamily) {
  return messages.map((message) => {
    if (!Array.isArray(message.content)) {
      return message;
    }

    const filtered = sanitizeContentBlocks(message.content, targetFamily);
    if (!Array.isArray(filtered) || filtered.length > 0) {
      return { ...message, content: filtered };
    }

    return {
      ...message,
      content: [{ type: 'text', text: '.' }],
    };
  });
}

export function closeToolLoopForThinking(messages, targetFamily = 'claude') {
  const state = analyzeConversationState(messages);

  if (!state.inToolLoop && !state.interruptedTool) {
    return messages;
  }

  if (state.inToolLoop && state.hasPlainUserMessageAfter) {
    return messages;
  }

  const modified = stripInvalidThinkingBlocks(messages, targetFamily);

  if (state.interruptedTool) {
    const insertIdx = state.lastAssistantIdx + 1;
    modified.splice(insertIdx, 0, {
      role: 'assistant',
      content: [{ type: 'text', text: '[Tool call was interrupted.]' }],
    });
    return modified;
  }

  if (state.inToolLoop) {
    return modified;
  }

  return modified;
}

export function prepareMessagesForThinking(messages, options = {}) {
  if (!Array.isArray(messages)) {
    return messages;
  }

  const targetFamily = options.targetFamily || 'claude';
  const thinkingEnabled = options.thinkingEnabled ?? false;

  const normalized = messages.map((message) => {
    if (!Array.isArray(message.content)) {
      return message;
    }

    let content = sanitizeContentBlocks(message.content, targetFamily);
    if (message.role === 'assistant') {
      content = reorderAssistantContent(content);
    }

    return { ...message, content };
  });

  if (thinkingEnabled && needsThinkingRecovery(normalized)) {
    return closeToolLoopForThinking(normalized, targetFamily);
  }

  return normalized;
}
