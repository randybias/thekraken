import { describe, it, expect } from 'vitest';
import { buildDeployerPrompt } from '../../src/agent/system-prompt.js';

describe('deployer prompt', () => {
  it('instructs deployer to compose plain-English summary post-commit', () => {
    const prompt = buildDeployerPrompt({
      enclaveName: 'tentacular-agensys',
      userEmail: 'rbias@mirantis.com',
      userSlackId: 'U_X',
    });
    expect(prompt).toMatch(/plain.english summary/i);
    expect(prompt).toMatch(/record_deploy_event/i);
    expect(prompt).toMatch(/non.engineer/i);
    // Must NOT instruct to mention SHAs or git terms in the summary
    expect(prompt).toMatch(/don.t mention.*(file names|diff|technical)/i);
  });
});
