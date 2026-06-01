/**
 * Manager-prompt contract for the 2026-06-01 Chroma + self-identity bugfix.
 *
 * Two gaps reproduced from a live Slack thread:
 *  1. The manager did not know Chroma exists, so it could not hand out the
 *     enclave Chroma URL when asked.
 *  2. The manager did not know its own Slack bot user id, so a <@bot_id>
 *     mention read as a stranger ("that may have been for someone else").
 *
 * Chroma URL pattern (src/slack/cards.ts): `${baseUrl}/enclaves/<enclave>`.
 * Chroma is read-only STATUS, not a prompt editor.
 */

import { describe, it, expect } from 'vitest';
import { buildManagerPrompt } from '../../../src/agent/system-prompt.js';

const BASE_OPTS = {
  enclaveName: 'voyager',
  userSlackId: 'U1',
  userEmail: 'a@b.c',
};

describe('manager prompt — self-identity (bot user id)', () => {
  it('tells the manager its own Slack handle when botUserId is injected', () => {
    const prompt = buildManagerPrompt({
      ...BASE_OPTS,
      botUserId: 'U0AB4T4UHHS',
    });
    expect(prompt).toContain('<@U0AB4T4UHHS>');
  });

  it('states that a mention of its own id is a mention of itself', () => {
    const prompt = buildManagerPrompt({
      ...BASE_OPTS,
      botUserId: 'U0AB4T4UHHS',
    });
    expect(prompt).toMatch(/mention of that id is a mention of you/i);
  });

  it('forbids disclaiming its own mention as someone else', () => {
    const prompt = buildManagerPrompt({
      ...BASE_OPTS,
      botUserId: 'U0AB4T4UHHS',
    });
    expect(prompt).toMatch(
      /never say it (might|may) (have )?be(en)? for someone else/i,
    );
  });

  it('does not emit a broken handle when botUserId is absent', () => {
    const prompt = buildManagerPrompt(BASE_OPTS);
    expect(prompt).not.toContain('<@undefined>');
    expect(prompt).not.toContain('<@>');
  });
});

describe('manager prompt — Chroma awareness', () => {
  it('gives the enclave Chroma URL using the /enclaves/<name> pattern', () => {
    const prompt = buildManagerPrompt({
      ...BASE_OPTS,
      chromaBaseUrl: 'https://chroma.example.com',
    });
    expect(prompt).toContain('https://chroma.example.com/enclaves/voyager');
  });

  it('describes Chroma as read-only status, not a prompt editor', () => {
    const prompt = buildManagerPrompt({
      ...BASE_OPTS,
      chromaBaseUrl: 'https://chroma.example.com',
    });
    expect(prompt).toMatch(/read-only/i);
    expect(prompt).toMatch(/status/i);
    // It must steer away from implying Chroma shows prompt source, and instead
    // offer to paste the prompt text.
    expect(prompt).toMatch(/paste/i);
  });

  it('says Chroma is not configured when no base URL is injected', () => {
    const prompt = buildManagerPrompt(BASE_OPTS);
    expect(prompt).toMatch(/chroma/i);
    expect(prompt).toMatch(/not configured/i);
  });

  it('never fabricates a Chroma URL when none is configured', () => {
    const prompt = buildManagerPrompt(BASE_OPTS);
    expect(prompt).not.toContain('/enclaves/');
    expect(prompt).not.toMatch(/https?:\/\/\S*chroma/i);
  });
});
