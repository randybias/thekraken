/**
 * rc.11 manager prompt additions:
 * - post_to_slack idiom (outbound.ndjson)
 * - kraken-db curated read-only CLI reference
 * - No-confab / honesty about capabilities clause
 *
 * Smart-path prompts (DM + provisioning) also get the no-confab clause.
 */

import { describe, it, expect } from 'vitest';
import { buildManagerPrompt } from '../../src/agent/system-prompt.js';
import {
  buildDmSystemPrompt,
  buildProvisioningPrompt,
} from '../../src/dispatcher/smart-path.js';

describe('manager prompt — rc.11 additions', () => {
  const prompt = buildManagerPrompt({
    enclaveName: 'test-enclave',
    userSlackId: 'U1',
    userEmail: 'u@e.com',
  });

  it('teaches the outbound.ndjson post_to_slack idiom', () => {
    expect(prompt).toContain('outbound.ndjson');
    expect(prompt).toContain('jq -nc'); // was: /printf .*type":"slack_message/
  });

  it('documents outbound.ndjson as the cross-channel posting mechanism', () => {
    expect(prompt).toContain('$KRAKEN_TEAM_DIR/outbound.ndjson');
  });

  it('lists the kraken-db lookup-channel command', () => {
    expect(prompt).toContain('kraken-db lookup-channel');
  });

  it('lists the kraken-db list-enclaves command', () => {
    expect(prompt).toContain('kraken-db list-enclaves');
  });

  it('lists the kraken-db recent-deployments command', () => {
    expect(prompt).toContain('kraken-db recent-deployments');
  });

  it('lists the kraken-db change-summary command', () => {
    expect(prompt).toContain('kraken-db change-summary');
  });

  it('describes kraken-db as read-only with no SQL surface', () => {
    expect(prompt).toMatch(/read-only/i);
    expect(prompt).toMatch(/no raw SQL/i);
  });

  it('contains the honesty / no-confab clause', () => {
    expect(prompt).toMatch(/never claim a structural denial/i);
    expect(prompt).toMatch(/ask the user/i);
  });

  it('no-confab clause covers the "I don\'t have access to Slack" denial pattern', () => {
    expect(prompt).toContain("I don't have access to Slack");
  });
});

describe('manager prompt JSON-safe printf (rc.13)', () => {
  const prompt = buildManagerPrompt({
    enclaveName: 'test',
    userSlackId: 'U1',
    userEmail: 'u@e.com',
  });

  it('teaches the jq-based JSON construction', () => {
    expect(prompt).toContain('jq -nc');
    expect(prompt).toContain('--arg text');
    expect(prompt).toContain('--arg ch');
    expect(prompt).toContain('--arg th');
  });

  it('warns against the unsafe printf pattern', () => {
    expect(prompt).toMatch(/do not use printf|printf.*%s.*not.*escape/i);
  });

  it('still references outbound.ndjson and the dispatcher poller', () => {
    expect(prompt).toContain('outbound.ndjson');
  });

  it('no longer contains the printf-based pattern as the recommended idiom', () => {
    // Find any printf line in the post-to-Slack section. The fact that
    // the prompt warns AGAINST printf is fine, but the recommended
    // idiom should be jq.
    const lines = prompt.split('\n');
    const sectionStart = lines.findIndex((l) =>
      l.includes('Posting to other Slack channels'),
    );
    expect(sectionStart).toBeGreaterThan(-1);
    // Find the next H2 after section start
    const sectionEnd = lines
      .slice(sectionStart + 1)
      .findIndex((l) => l.startsWith('## '));
    const sectionLines = lines.slice(
      sectionStart,
      sectionStart + 1 + (sectionEnd === -1 ? lines.length : sectionEnd),
    );
    // The recommended idiom should be jq, not printf.
    const recommended = sectionLines.find(
      (l) => l.includes('printf') && !l.match(/do not|don't/i),
    );
    expect(recommended).toBeUndefined();
  });
});

describe('DM system prompt — no-confab clause', () => {
  const prompt = buildDmSystemPrompt('user@example.com');

  it('contains the honesty / no-confab clause', () => {
    expect(prompt).toMatch(/never claim a structural denial/i);
    expect(prompt).toMatch(/ask the user/i);
  });

  it('no-confab clause covers the "I don\'t have access to Slack" denial pattern', () => {
    expect(prompt).toMatch(/I don.t have access to Slack|structural denial/i);
  });
});

describe('provisioning system prompt — no-confab clause', () => {
  const prompt = buildProvisioningPrompt(
    'user@example.com',
    'sub-123',
    'C123',
    'my-channel',
  );

  it('contains the honesty / no-confab clause', () => {
    expect(prompt).toMatch(/never claim a structural denial/i);
    expect(prompt).toMatch(/ask the user/i);
  });
});
