import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clearConversationStoreForTests,
  rememberConversationTurn,
  resolveSessionId,
  updateConversationState,
} from '../../src/services/conversationStore.js';

const reqWithoutSession = {
  get: () => null,
};

function createRequest(model, messages) {
  return {
    model,
    messages,
  };
}

describe('conversationStore', () => {
  beforeEach(() => {
    clearConversationStoreForTests();
    delete process.env.TRANSCRIPT_ALIASES_PER_SESSION;
  });

  afterEach(() => {
    delete process.env.TRANSCRIPT_ALIASES_PER_SESSION;
  });

  it('keeps transcript matching scoped to the request model', () => {
    const sessionId = 'session-model-a';
    updateConversationState(sessionId, {
      conversationId: 'conv-a',
      lastAssistantMessageId: 'msg-a',
    });

    rememberConversationTurn(
      sessionId,
      createRequest('claude-opus-4-5', [{ role: 'user', content: 'Continue this' }]),
      { role: 'assistant', content: 'Sure.' },
    );

    const sameModel = resolveSessionId(
      reqWithoutSession,
      createRequest('claude-opus-4-5', [
        { role: 'user', content: 'Continue this' },
        { role: 'assistant', content: 'Sure.' },
        { role: 'user', content: 'Next' },
      ]),
    );
    const differentModel = resolveSessionId(
      reqWithoutSession,
      createRequest('claude-sonnet-4-5', [
        { role: 'user', content: 'Continue this' },
        { role: 'assistant', content: 'Sure.' },
        { role: 'user', content: 'Next' },
      ]),
    );

    expect(sameModel.sessionId).toBe(sessionId);
    expect(differentModel.sessionId).not.toBe(sessionId);
    expect(differentModel.isGenerated).toBe(true);
  });

  it('trims old transcript aliases for long-running sessions', () => {
    process.env.TRANSCRIPT_ALIASES_PER_SESSION = '2';
    const sessionId = 'session-with-many-turns';
    const model = 'claude-sonnet-4-5';
    updateConversationState(sessionId, {
      conversationId: 'conv-a',
      lastAssistantMessageId: 'msg-a',
    });

    const firstTurn = [{ role: 'user', content: 'Turn 1' }];
    const secondTurn = [
      ...firstTurn,
      { role: 'assistant', content: 'Reply 1' },
      { role: 'user', content: 'Turn 2' },
    ];
    const thirdTurn = [
      ...secondTurn,
      { role: 'assistant', content: 'Reply 2' },
      { role: 'user', content: 'Turn 3' },
    ];

    rememberConversationTurn(sessionId, createRequest(model, firstTurn), {
      role: 'assistant',
      content: 'Reply 1',
    });
    rememberConversationTurn(sessionId, createRequest(model, secondTurn), {
      role: 'assistant',
      content: 'Reply 2',
    });
    rememberConversationTurn(sessionId, createRequest(model, thirdTurn), {
      role: 'assistant',
      content: 'Reply 3',
    });

    const trimmedAlias = resolveSessionId(
      reqWithoutSession,
      createRequest(model, [
        ...firstTurn,
        { role: 'assistant', content: 'Reply 1' },
        { role: 'user', content: 'Follow-up' },
      ]),
    );
    const retainedAlias = resolveSessionId(
      reqWithoutSession,
      createRequest(model, [
        ...thirdTurn,
        { role: 'assistant', content: 'Reply 3' },
        { role: 'user', content: 'Follow-up' },
      ]),
    );

    expect(trimmedAlias.sessionId).not.toBe(sessionId);
    expect(trimmedAlias.isGenerated).toBe(true);
    expect(retainedAlias.sessionId).toBe(sessionId);
  });
});
