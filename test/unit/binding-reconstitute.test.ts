/**
 * Unit tests for lookupEnclaveWithReconstitute owner-resolution paths.
 *
 * Covers the three branches introduced in the phase-bd reconstitution work:
 *   1. info.owner resolves to an authenticated user  → binding written with owner's Slack ID
 *   2. info.owner present but email not in user_tokens → binding written with triggering user's ID + warn log
 *   3. info.owner absent/empty in MCP response       → binding written with triggering user's ID + warn log
 *
 * Also covers the drift-sync owner attribution reconciliation path:
 *   4. Binding has stale ownerSlackId (fallback user) → setOwnerSlackId updates it when owner authenticates
 *   5. Binding already has correct ownerSlackId        → setOwnerSlackId is a no-op
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { createDatabase } from '../../src/db/migrations.js';

// ---------------------------------------------------------------------------
// Mock src/auth/tokens.js before importing binding.ts.
// binding.ts imports getUserTokenByEmail at module load time, so we must mock
// the whole module. vi.hoisted ensures the mock fn is initialised before the
// vi.mock factory runs (which is hoisted to the top of the file by Vitest).
// ---------------------------------------------------------------------------
const { mockGetUserTokenByEmail } = vi.hoisted(() => ({
  mockGetUserTokenByEmail: vi.fn(),
}));

vi.mock('../../src/auth/tokens.js', () => ({
  getUserTokenByEmail: mockGetUserTokenByEmail,
  initTokenStore: vi.fn(),
  getUserToken: vi.fn(),
  setUserToken: vi.fn(),
  deleteUserToken: vi.fn(),
  getAllUserTokens: vi.fn(),
}));

// Import after mock registration
import { EnclaveBindingEngine } from '../../src/enclave/binding.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTestDb(): Database.Database {
  return createDatabase(':memory:');
}

/** Build a minimal MCP call mock that returns enclave_list + enclave_info responses. */
function buildMcpCall(opts: {
  enclaveListItems?: Array<{
    name: string;
    owner: string;
    status: string;
    members: string[];
  }>;
  enclaveInfo?: Record<string, unknown>;
}) {
  return vi
    .fn()
    .mockImplementation(
      async (tool: string, params: Record<string, unknown>) => {
        if (tool === 'enclave_list') {
          return { enclaves: opts.enclaveListItems ?? [] };
        }
        if (tool === 'enclave_info') {
          return (
            opts.enclaveInfo ?? {
              name: params['name'],
              owner: '',
              status: 'active',
            }
          );
        }
        return {};
      },
    );
}

// ---------------------------------------------------------------------------
// Tests: lookupEnclaveWithReconstitute owner resolution
// ---------------------------------------------------------------------------

describe('lookupEnclaveWithReconstitute — owner resolution', () => {
  let db: Database.Database;
  let engine: EnclaveBindingEngine;

  beforeEach(() => {
    db = createTestDb();
    engine = new EnclaveBindingEngine(db);
    vi.clearAllMocks();
  });

  it('branch 1: info.owner resolves to authenticated user → binding written with owner Slack ID', async () => {
    const channelId = 'C_BRANCH1';
    const enclaveName = 'branch1-enclave';
    const ownerEmail = 'owner@example.com';
    const ownerSlackId = 'U_OWNER';
    const triggeringUserId = 'U_TRIGGER';

    // Owner has authenticated: getUserTokenByEmail returns their stored token
    mockGetUserTokenByEmail.mockReturnValue({
      slack_user_id: ownerSlackId,
      access_token: 'at',
      refresh_token: 'rt',
      expires_at: Date.now() + 3600_000,
      keycloak_sub: 'sub_owner',
      email: ownerEmail,
      updated_at: new Date().toISOString(),
    });

    const mcpCall = buildMcpCall({
      enclaveListItems: [
        { name: enclaveName, owner: ownerEmail, status: 'active', members: [] },
      ],
      enclaveInfo: {
        name: enclaveName,
        owner: ownerEmail,
        channel_id: channelId,
        status: 'active',
      },
    });

    const binding = await engine.lookupEnclaveWithReconstitute(
      channelId,
      triggeringUserId,
      mcpCall,
    );

    expect(binding).not.toBeNull();
    expect(binding!.ownerSlackId).toBe(ownerSlackId);
    expect(binding!.channelId).toBe(channelId);
    expect(binding!.enclaveName).toBe(enclaveName);

    // Verify the binding was persisted with the owner's Slack ID
    const stored = engine.lookupEnclave(channelId);
    expect(stored!.ownerSlackId).toBe(ownerSlackId);
  });

  it('branch 2: info.owner present but not in user_tokens → binding written with triggering user ID', async () => {
    const channelId = 'C_BRANCH2';
    const enclaveName = 'branch2-enclave';
    const ownerEmail = 'unauthenticated@example.com';
    const triggeringUserId = 'U_TRIGGER_2';

    // Owner has NOT authenticated: getUserTokenByEmail returns undefined
    mockGetUserTokenByEmail.mockReturnValue(undefined);

    const mcpCall = buildMcpCall({
      enclaveListItems: [
        { name: enclaveName, owner: ownerEmail, status: 'active', members: [] },
      ],
      enclaveInfo: {
        name: enclaveName,
        owner: ownerEmail,
        channel_id: channelId,
        status: 'active',
      },
    });

    const binding = await engine.lookupEnclaveWithReconstitute(
      channelId,
      triggeringUserId,
      mcpCall,
    );

    expect(binding).not.toBeNull();
    // Falls back to triggering user
    expect(binding!.ownerSlackId).toBe(triggeringUserId);

    // Persisted with fallback user
    const stored = engine.lookupEnclave(channelId);
    expect(stored!.ownerSlackId).toBe(triggeringUserId);
  });

  it('branch 3: info.owner absent/empty in MCP response → binding written with triggering user ID', async () => {
    const channelId = 'C_BRANCH3';
    const enclaveName = 'branch3-enclave';
    const triggeringUserId = 'U_TRIGGER_3';

    // MCP returns no owner field
    const mcpCall = buildMcpCall({
      enclaveListItems: [
        { name: enclaveName, owner: '', status: 'active', members: [] },
      ],
      enclaveInfo: {
        name: enclaveName,
        owner: '',
        channel_id: channelId,
        status: 'active',
      },
    });

    const binding = await engine.lookupEnclaveWithReconstitute(
      channelId,
      triggeringUserId,
      mcpCall,
    );

    expect(binding).not.toBeNull();
    // Falls back to triggering user
    expect(binding!.ownerSlackId).toBe(triggeringUserId);
  });

  it('returns cached binding on second call without hitting MCP again', async () => {
    const channelId = 'C_CACHE';
    const enclaveName = 'cache-enclave';
    const triggeringUserId = 'U_CACHE';

    mockGetUserTokenByEmail.mockReturnValue(undefined);

    const mcpCall = buildMcpCall({
      enclaveListItems: [
        { name: enclaveName, owner: '', status: 'active', members: [] },
      ],
      enclaveInfo: {
        name: enclaveName,
        owner: '',
        channel_id: channelId,
        status: 'active',
      },
    });

    // First call triggers reconstitution
    await engine.lookupEnclaveWithReconstitute(
      channelId,
      triggeringUserId,
      mcpCall,
    );
    const mcpCallCount = mcpCall.mock.calls.length;

    // Second call hits cache, no MCP
    await engine.lookupEnclaveWithReconstitute(
      channelId,
      triggeringUserId,
      mcpCall,
    );
    expect(mcpCall.mock.calls.length).toBe(mcpCallCount); // no new calls
  });
});

// ---------------------------------------------------------------------------
// Tests: setOwnerSlackId (drift-sync reconciliation)
// ---------------------------------------------------------------------------

describe('EnclaveBindingEngine.setOwnerSlackId — drift-sync reconciliation', () => {
  let db: Database.Database;
  let engine: EnclaveBindingEngine;

  beforeEach(() => {
    db = createTestDb();
    engine = new EnclaveBindingEngine(db);
    vi.clearAllMocks();
  });

  it('updates owner_slack_id when authoritative value differs from stored value', () => {
    db.prepare(
      `INSERT INTO enclave_bindings (channel_id, enclave_name, owner_slack_id, status)
       VALUES ('C_STALE', 'stale-enclave', 'U_TRIGGER_FALLBACK', 'active')`,
    ).run();

    engine.setOwnerSlackId('C_STALE', 'U_REAL_OWNER');

    const binding = engine.lookupEnclave('C_STALE');
    expect(binding!.ownerSlackId).toBe('U_REAL_OWNER');
  });

  it('is idempotent when owner_slack_id already matches authoritative value', () => {
    db.prepare(
      `INSERT INTO enclave_bindings (channel_id, enclave_name, owner_slack_id, status)
       VALUES ('C_CORRECT', 'correct-enclave', 'U_REAL_OWNER', 'active')`,
    ).run();

    // Call with same value — no error, binding unchanged
    engine.setOwnerSlackId('C_CORRECT', 'U_REAL_OWNER');

    const binding = engine.lookupEnclave('C_CORRECT');
    expect(binding!.ownerSlackId).toBe('U_REAL_OWNER');
  });

  it('is a no-op when channel has no active binding', () => {
    // Should not throw
    expect(() =>
      engine.setOwnerSlackId('C_NONEXISTENT', 'U_ANYONE'),
    ).not.toThrow();
  });

  it('does not update inactive bindings', () => {
    db.prepare(
      `INSERT INTO enclave_bindings (channel_id, enclave_name, owner_slack_id, status)
       VALUES ('C_INACTIVE', 'inactive-enclave', 'U_OLD', 'inactive')`,
    ).run();

    engine.setOwnerSlackId('C_INACTIVE', 'U_NEW');

    // Row should remain unchanged (still 'inactive' with old owner)
    const row = db
      .prepare(
        `SELECT owner_slack_id FROM enclave_bindings WHERE channel_id = 'C_INACTIVE'`,
      )
      .get() as { owner_slack_id: string } | undefined;
    expect(row!.owner_slack_id).toBe('U_OLD');
  });
});
