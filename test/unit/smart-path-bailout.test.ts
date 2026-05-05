/**
 * Smart-path MAX_TURNS bailout error surfacing.
 *
 * The 2026-05-04 incident: smart-path hit MAX_TURNS after wf_run
 * timed out, then returned the *previous* assistant utterance
 * ("Deployed. Now triggering a manual run.") as the user-facing
 * answer. The bailout must surface the actual tool error instead.
 */
import { describe, it, expect } from 'vitest';
import { findLastToolError } from '../../src/dispatcher/smart-path.js';

interface AssistantMsg {
  role: 'assistant';
  content: Array<{ type: string; text?: string }>;
}
interface ToolResultMsg {
  role: 'toolResult';
  toolName: string;
  content: Array<{ type: string; text: string }>;
  isError: boolean;
}

type Msg = AssistantMsg | ToolResultMsg;

describe('findLastToolError', () => {
  it('returns null when no tool errors are present', () => {
    const messages: Msg[] = [
      { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
      {
        role: 'toolResult',
        toolName: 'wf_list',
        content: [{ type: 'text', text: '{"workflows":[]}' }],
        isError: false,
      },
    ];
    expect(findLastToolError(messages)).toBeNull();
  });

  it('returns the most recent tool error in the message list', () => {
    const messages: Msg[] = [
      {
        role: 'toolResult',
        toolName: 'enclave_list',
        content: [{ type: 'text', text: 'first error' }],
        isError: true,
      },
      { role: 'assistant', content: [{ type: 'text', text: 'thinking' }] },
      {
        role: 'toolResult',
        toolName: 'enclave_provision',
        content: [{ type: 'text', text: 'second error' }],
        isError: true,
      },
      { role: 'assistant', content: [{ type: 'text', text: 'final thought' }] },
    ];
    const result = findLastToolError(messages);
    expect(result?.toolName).toBe('enclave_provision');
    expect(result?.content[0]?.text).toBe('second error');
  });

  it('ignores successful tool results', () => {
    const messages: Msg[] = [
      {
        role: 'toolResult',
        toolName: 'enclave_list',
        content: [{ type: 'text', text: 'ok' }],
        isError: false,
      },
      { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
    ];
    expect(findLastToolError(messages)).toBeNull();
  });
});
