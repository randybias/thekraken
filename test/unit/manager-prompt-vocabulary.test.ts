import { describe, it, expect } from 'vitest';
import { buildManagerPrompt } from '../../src/agent/system-prompt.js';

describe('manager prompt vocabulary contract', () => {
  const prompt = buildManagerPrompt({
    enclaveName: 'tentacular-agensys',
    userEmail: 'rbias@mirantis.com',
    userSlackId: 'U_X',
  });

  it('instructs manager to never use SHA, version numbers, or git terms in user output', () => {
    expect(prompt).toMatch(/never.*SHA|never.*version number|never.*git/i);
  });

  it('lists the forbidden vocabulary explicitly', () => {
    // Forbidden words must be enumerated in the prompt so the LLM knows what to avoid
    expect(prompt).toMatch(/sha/i);
    expect(prompt).toMatch(/commit/i);
    expect(prompt).toMatch(/tag/i);
    expect(prompt).toMatch(/branch/i);
  });

  it('instructs manager to confirm before revert-class actions', () => {
    expect(prompt).toMatch(
      /confirm.*before.*(revert|undo|go back)|always.*confirm.*(revert|undo|go back)/i,
    );
  });

  it('instructs manager to call list_deploy_events before describing version state', () => {
    expect(prompt).toMatch(
      /list_deploy_events.*first|first.*list_deploy_events/i,
    );
  });

  it('does not itself instruct the LLM to produce bare version numbers like v3', () => {
    // The prompt must not slip into forbidden vocabulary in its own examples.
    // Allow "v\d" when it appears inside a quoted "forbidden" rule
    // (e.g., "never say 'v3'") but not as a raw instruction.
    // We check that the prompt contains the forbidden-vocab enumeration
    // (so the LLM knows the rule) but does NOT emit a bare instruction like
    // "respond with v3" or "use version number v2".
    expect(prompt).not.toMatch(
      /respond with v\d+|use version number v\d+|output.*v\d+/i,
    );
  });
});
