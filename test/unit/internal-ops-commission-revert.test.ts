/**
 * Tests for commission_revert internal-op (G4.4).
 *
 * Validates:
 * - Briefs dev team with structured intent containing "Restore", additionalIntent, targetSha.
 * - Returns {status: 'commissioned', jobId}.
 * - Works when additionalIntent is absent.
 */

import { describe, it, expect } from 'vitest';
import { commissionRevert } from '../../src/dispatcher/internal-ops.js';
import type { RevertTeams } from '../../src/dispatcher/internal-ops.js';

describe('commission_revert', () => {
  it('briefs dev team with structured intent and returns commissioned status', async () => {
    const briefingsCaptured: unknown[] = [];

    const fakeTeams: RevertTeams = {
      spawn: async (brief: unknown) => {
        briefingsCaptured.push(brief);
        return { jobId: 'job-1' };
      },
    };

    const result = await commissionRevert(fakeTeams, {
      enclave: 'tentacular-agensys',
      tentacle: 'ai-news-digest',
      targetSha: 'abc1234',
      additionalIntent: 'raise the title limit to 80 chars',
      userSlackId: 'U_USER',
    });

    expect(result.status).toBe('commissioned');
    expect(result.jobId).toBe('job-1');

    expect(briefingsCaptured).toHaveLength(1);
    const brief = briefingsCaptured[0] as {
      intent: string;
      targetSha: string;
      enclave: string;
      tentacle: string;
    };
    expect(brief.intent).toContain('Restore');
    expect(brief.intent).toContain('raise the title limit to 80 chars');
    expect(brief.targetSha).toBe('abc1234');
    expect(brief.enclave).toBe('tentacular-agensys');
    expect(brief.tentacle).toBe('ai-news-digest');
  });

  it('works without additionalIntent', async () => {
    const briefingsCaptured: unknown[] = [];

    const fakeTeams: RevertTeams = {
      spawn: async (brief: unknown) => {
        briefingsCaptured.push(brief);
        return { jobId: 'job-2' };
      },
    };

    const result = await commissionRevert(fakeTeams, {
      enclave: 'tentacular-agensys',
      tentacle: 'ai-news-digest',
      targetSha: 'abc1234',
      userSlackId: 'U_USER',
    });

    expect(result.status).toBe('commissioned');
    expect(result.jobId).toBe('job-2');

    const brief = briefingsCaptured[0] as { intent: string };
    expect(brief.intent).toContain('Restore');
    // No crash, no "undefined" in brief
    expect(brief.intent).not.toContain('undefined');
  });

  it('includes the enclave and tentacle in the brief', async () => {
    const briefingsCaptured: unknown[] = [];

    const fakeTeams: RevertTeams = {
      spawn: async (brief: unknown) => {
        briefingsCaptured.push(brief);
        return { jobId: 'job-3' };
      },
    };

    await commissionRevert(fakeTeams, {
      enclave: 'my-enclave',
      tentacle: 'my-tentacle',
      targetSha: 'deadbeef',
      userSlackId: 'U_ALICE',
    });

    const brief = briefingsCaptured[0] as {
      enclave: string;
      tentacle: string;
    };
    expect(brief.enclave).toBe('my-enclave');
    expect(brief.tentacle).toBe('my-tentacle');
  });
});
