/**
 * Unit tests for test helpers (T23, T24, T26).
 *
 * Verifies that the test infrastructure itself works correctly.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { appendRecord, readRecords, waitForRecord } from '../helpers/ndjson.js';
import { createTeamFixture } from '../helpers/team-fixture.js';
import { createIdentityFixture } from '../helpers/identity-fixture.js';

// ---------------------------------------------------------------------------
// NDJSON helpers (T23)
// ---------------------------------------------------------------------------

describe('ndjson helpers', () => {
  const fixtures: ReturnType<typeof createTeamFixture>[] = [];

  afterEach(() => {
    for (const f of fixtures.splice(0)) f.cleanup();
  });

  it('appendRecord + readRecords round-trip', () => {
    const f = createTeamFixture('test-enclave');
    fixtures.push(f);

    appendRecord(f.mailboxPath, { type: 'user_message', text: 'hello' });
    appendRecord(f.mailboxPath, { type: 'user_message', text: 'world' });

    const records = readRecords(f.mailboxPath);
    expect(records).toHaveLength(2);
  });

  it('readRecords returns empty array for missing file', () => {
    expect(readRecords('/tmp/kraken-test-missing-12345.ndjson')).toEqual([]);
  });

  it('readRecords filters records with predicate', () => {
    const f = createTeamFixture('filter-test');
    fixtures.push(f);

    appendRecord(f.mailboxPath, { type: 'a', n: 1 });
    appendRecord(f.mailboxPath, { type: 'b', n: 2 });
    appendRecord(f.mailboxPath, { type: 'a', n: 3 });

    const aOnly = readRecords(f.mailboxPath, (r) => (r as { type: string }).type === 'a');
    expect(aOnly).toHaveLength(2);
  });

  it('waitForRecord resolves when record appears', async () => {
    const f = createTeamFixture('wait-test');
    fixtures.push(f);

    // Write the record after a short delay
    setTimeout(() => appendRecord(f.outboundPath, { type: 'done', id: 'x1' }), 50);

    const rec = await waitForRecord(
      f.outboundPath,
      (r) => (r as { type: string }).type === 'done',
      2000,
    );
    expect((rec as { id: string }).id).toBe('x1');
  });

  it('waitForRecord rejects when timeout elapses', async () => {
    const f = createTeamFixture('timeout-test');
    fixtures.push(f);

    await expect(
      waitForRecord(f.outboundPath, () => false, 100, 20),
    ).rejects.toThrow('waitForRecord');
  });
});

// ---------------------------------------------------------------------------
// Team fixture (T24)
// ---------------------------------------------------------------------------

describe('createTeamFixture', () => {
  const fixtures: ReturnType<typeof createTeamFixture>[] = [];

  afterEach(() => {
    for (const f of fixtures.splice(0)) f.cleanup();
  });

  it('creates the team directory structure', () => {
    const f = createTeamFixture('my-enclave');
    fixtures.push(f);

    expect(existsSync(f.dir)).toBe(true);
    expect(existsSync(f.dir + '/memory')).toBe(true);
    expect(existsSync(f.dir + '/team.json')).toBe(true);
  });

  it('mailbox path is inside team dir', () => {
    const f = createTeamFixture('enc1');
    fixtures.push(f);
    expect(f.mailboxPath).toContain(f.dir);
    expect(f.mailboxPath).toContain('mailbox.ndjson');
  });

  it('appendMailbox + readMailbox round-trip', () => {
    const f = createTeamFixture('enc2');
    fixtures.push(f);

    f.appendMailbox({ id: '1', type: 'user_message', message: 'build something' });
    const records = f.readMailbox();
    expect(records).toHaveLength(1);
  });

  it('appendOutbound + readOutbound round-trip', () => {
    const f = createTeamFixture('enc3');
    fixtures.push(f);

    f.appendOutbound({ id: '1', type: 'slack_message', text: 'done' });
    const records = f.readOutbound();
    expect(records).toHaveLength(1);
  });

  it('appendSignal + readSignals round-trip', () => {
    const f = createTeamFixture('enc4');
    fixtures.push(f);

    f.appendSignal({ id: '1', type: 'task_completed', message: 'done' });
    const records = f.readSignals();
    expect(records).toHaveLength(1);
  });

  it('cleanup removes temp directory', () => {
    const f = createTeamFixture('cleanup-test');
    const dir = f.teamsDir;
    f.cleanup();
    expect(existsSync(dir)).toBe(false);
    // Don't push — already cleaned
  });
});

// ---------------------------------------------------------------------------
// Identity fixture (T26)
// ---------------------------------------------------------------------------

describe('createIdentityFixture', () => {
  const fixtures: ReturnType<typeof createIdentityFixture>[] = [];

  afterEach(() => {
    for (const f of fixtures.splice(0)) f.cleanup();
  });

  it('creates two distinct user identities', () => {
    const f = createIdentityFixture('test-enclave');
    fixtures.push(f);

    expect(f.userA.slackUserId).not.toBe(f.userB.slackUserId);
    expect(f.userA.token).not.toBe(f.userB.token);
  });

  it('writes mailbox records with user token for userA', () => {
    const f = createIdentityFixture('test-enclave');
    fixtures.push(f);

    f.writeMailboxForUserA('build a tentacle', '1111.000');
    const records = f.fixture.readMailbox();
    expect(records).toHaveLength(1);
    const rec = records[0] as { userSlackId: string; userToken: string };
    expect(rec.userSlackId).toBe('U_ALICE');
    expect(rec.userToken).toBe(f.userA.token);
  });

  it('token in mailbox is NOT in outbound (D6)', () => {
    const f = createIdentityFixture('d6-test');
    fixtures.push(f);

    f.writeMailboxForUserA('build', '1111.000');
    // Write an outbound record that does NOT contain the token
    f.fixture.appendOutbound({ type: 'slack_message', text: 'done', user: 'U_ALICE' });

    // Should not throw
    f.assertTokenNotLeaked(f.userA.token);
  });

  it('assertTokenNotLeaked throws when token IS in outbound (D6 enforcement)', () => {
    const f = createIdentityFixture('d6-leak-test');
    fixtures.push(f);

    // Deliberately leak the token into outbound
    f.fixture.appendOutbound({
      type: 'slack_message',
      text: 'done',
      token: f.userA.token, // BUG: should never happen
    });

    expect(() => f.assertTokenNotLeaked(f.userA.token)).toThrow('D6 violation');
  });

  it('two users write mailbox records that interleave without cross-bleed', () => {
    const f = createIdentityFixture('two-users');
    fixtures.push(f);

    f.writeMailboxForUserA('task A', '1111.000');
    f.writeMailboxForUserB('task B', '2222.000');
    f.writeMailboxForUserA('task A2', '1111.001');

    const records = f.fixture.readMailbox() as Array<{
      userSlackId: string;
      userToken: string;
    }>;
    expect(records).toHaveLength(3);

    // Each record carries the correct token
    expect(records[0].userSlackId).toBe('U_ALICE');
    expect(records[0].userToken).toBe(f.userA.token);

    expect(records[1].userSlackId).toBe('U_BOB');
    expect(records[1].userToken).toBe(f.userB.token);

    // Cross-check: A's records never contain B's token
    for (const rec of records.filter((r) => r.userSlackId === 'U_ALICE')) {
      expect(rec.userToken).not.toBe(f.userB.token);
    }
  });
});
