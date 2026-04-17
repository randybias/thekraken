/**
 * Identity propagation test fixture (T26).
 *
 * Provides test utilities to verify that user OIDC tokens flow correctly
 * from mailbox records through subprocess env vars (D6 enforcement).
 *
 * Since Phase 1 tests use mock pi (not a real subprocess), this fixture
 * works by inspecting mailbox records and verifying the token field
 * appears only in the mailbox (not in outbound or signals) and that
 * cross-user token isolation holds.
 */

import { createTeamFixture } from './team-fixture.js';
import type { TeamFixture } from './team-fixture.js';

export interface UserIdentity {
  slackUserId: string;
  token: string;
  email: string;
}

export interface IdentityFixture {
  fixture: TeamFixture;
  /** User A identity. */
  userA: UserIdentity;
  /** User B identity. */
  userB: UserIdentity;
  /**
   * Write a mailbox record for userA.
   * The token is embedded in the record (D6: token in mailbox only).
   */
  writeMailboxForUserA: (message: string, threadTs: string) => void;
  /**
   * Write a mailbox record for userB.
   * The token is embedded in the record (D6: token in mailbox only).
   */
  writeMailboxForUserB: (message: string, threadTs: string) => void;
  /**
   * Assert that userA's token appears in the mailbox but NOT in outbound or signals.
   * Throws if the assertion fails.
   */
  assertTokenNotInOutbound: (userId: string, token: string) => void;
  /**
   * Assert that no record in outbound.ndjson, signals-out.ndjson, or
   * signals-in.ndjson contains the given token string. Throws if any
   * record contains the token.
   */
  assertTokenNotLeaked: (token: string) => void;
  cleanup: () => void;
}

/**
 * Create an identity propagation fixture for two users on the same enclave.
 *
 * @param enclaveName - The enclave name to create the fixture for.
 */
export function createIdentityFixture(enclaveName: string): IdentityFixture {
  const fixture = createTeamFixture(enclaveName);

  const userA: UserIdentity = {
    slackUserId: 'U_ALICE',
    token: 'token-alice-oidc-xyz',
    email: 'alice@example.com',
  };

  const userB: UserIdentity = {
    slackUserId: 'U_BOB',
    token: 'token-bob-oidc-abc',
    email: 'bob@example.com',
  };

  function makeMailboxRecord(
    user: UserIdentity,
    message: string,
    threadTs: string,
  ): object {
    return {
      id: `msg-${user.slackUserId}-${Date.now()}`,
      timestamp: new Date().toISOString(),
      from: 'dispatcher',
      type: 'user_message',
      threadTs,
      channelId: 'C_TEST',
      userSlackId: user.slackUserId,
      // D6: token is ONLY in mailbox records, never in outbound or signals
      userToken: user.token,
      message,
    };
  }

  return {
    fixture,
    userA,
    userB,
    writeMailboxForUserA: (message, threadTs) => {
      fixture.appendMailbox(makeMailboxRecord(userA, message, threadTs));
    },
    writeMailboxForUserB: (message, threadTs) => {
      fixture.appendMailbox(makeMailboxRecord(userB, message, threadTs));
    },
    assertTokenNotInOutbound: (userId, token) => {
      const outbound = fixture.readOutbound();
      for (const rec of outbound) {
        const str = JSON.stringify(rec);
        if (str.includes(token)) {
          throw new Error(
            `D6 violation: token for user ${userId} found in outbound.ndjson: ${str.slice(0, 100)}`,
          );
        }
      }
    },
    assertTokenNotLeaked: (token) => {
      // Check outbound
      const outbound = fixture.readOutbound();
      for (const rec of outbound) {
        if (JSON.stringify(rec).includes(token)) {
          throw new Error(
            `D6 violation: token "${token.slice(0, 10)}..." found in outbound.ndjson`,
          );
        }
      }
      // Check outbound signals (signals-out.ndjson, manager→bridge)
      const signalsOut = fixture.readSignalsOut();
      for (const rec of signalsOut) {
        if (JSON.stringify(rec).includes(token)) {
          throw new Error(
            `D6 violation: token "${token.slice(0, 10)}..." found in signals-out.ndjson`,
          );
        }
      }
      // Check inbound signals (signals-in.ndjson, dev-team→manager)
      const signalsIn = fixture.readSignalsIn();
      for (const rec of signalsIn) {
        if (JSON.stringify(rec).includes(token)) {
          throw new Error(
            `D6 violation: token "${token.slice(0, 10)}..." found in signals-in.ndjson`,
          );
        }
      }
    },
    cleanup: () => fixture.cleanup(),
  };
}
