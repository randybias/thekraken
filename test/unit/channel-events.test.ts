import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleChannelEvent } from '../../src/enclave/drift.js';
import type { ChannelEventType } from '../../src/enclave/drift.js';

const ENCLAVE_NAME = 'my-enclave';
const BOT_USER_ID = 'U_BOT';
const OWNER_EMAIL = 'owner@example.com';
const MEMBER_EMAIL = 'alice@example.com';

function makeDeps() {
  const mcpCall = vi.fn().mockResolvedValue({});
  const resolveEmail = vi.fn().mockResolvedValue(MEMBER_EMAIL);
  const getEnclaveInfo = vi.fn().mockResolvedValue({
    owner: OWNER_EMAIL,
    members: [MEMBER_EMAIL],
  });
  const invalidateCache = vi.fn();
  return {
    mcpCall,
    resolveEmail,
    getEnclaveInfo,
    invalidateCache,
    botUserId: BOT_USER_ID,
  };
}

describe('handleChannelEvent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('member_joined', () => {
    it('logs visitor arrival, makes no MCP call', async () => {
      const deps = makeDeps();
      await handleChannelEvent(
        'member_joined',
        ENCLAVE_NAME,
        { userId: 'U456' },
        deps,
      );
      expect(deps.mcpCall).not.toHaveBeenCalled();
    });

    it('ignores bot joining', async () => {
      const deps = makeDeps();
      await handleChannelEvent(
        'member_joined',
        ENCLAVE_NAME,
        { userId: BOT_USER_ID },
        deps,
      );
      expect(deps.mcpCall).not.toHaveBeenCalled();
    });
  });

  describe('member_left', () => {
    it('calls enclave_sync with remove_members for enclave member', async () => {
      const deps = makeDeps();
      await handleChannelEvent(
        'member_left',
        ENCLAVE_NAME,
        { userId: 'U_ALICE' },
        deps,
      );
      expect(deps.resolveEmail).toHaveBeenCalledWith('U_ALICE');
      expect(deps.mcpCall).toHaveBeenCalledWith('enclave_sync', {
        name: ENCLAVE_NAME,
        remove_members: [MEMBER_EMAIL],
      });
      expect(deps.invalidateCache).toHaveBeenCalledWith(ENCLAVE_NAME);
    });

    it('skips removal for visitor (email not in members list)', async () => {
      const deps = makeDeps();
      deps.resolveEmail.mockResolvedValue('visitor@example.com');
      await handleChannelEvent(
        'member_left',
        ENCLAVE_NAME,
        { userId: 'U_VISITOR' },
        deps,
      );
      expect(deps.mcpCall).not.toHaveBeenCalled();
      expect(deps.invalidateCache).not.toHaveBeenCalled();
    });

    it('no MCP call when owner leaves (owner is not in members list)', async () => {
      const deps = makeDeps();
      deps.resolveEmail.mockResolvedValue(OWNER_EMAIL);
      // owner is NOT in the members array, only in owner field
      await handleChannelEvent(
        'member_left',
        ENCLAVE_NAME,
        { userId: 'U_OWNER' },
        deps,
      );
      expect(deps.mcpCall).not.toHaveBeenCalled();
    });

    it('no MCP call when bot itself leaves', async () => {
      const deps = makeDeps();
      await handleChannelEvent(
        'member_left',
        ENCLAVE_NAME,
        { userId: BOT_USER_ID },
        deps,
      );
      expect(deps.mcpCall).not.toHaveBeenCalled();
      expect(deps.resolveEmail).not.toHaveBeenCalled();
    });

    it('skips when email resolution fails', async () => {
      const deps = makeDeps();
      deps.resolveEmail.mockResolvedValue(undefined);
      await handleChannelEvent(
        'member_left',
        ENCLAVE_NAME,
        { userId: 'U_UNKNOWN' },
        deps,
      );
      expect(deps.mcpCall).not.toHaveBeenCalled();
    });

    it('skips when enclave info not found', async () => {
      const deps = makeDeps();
      deps.getEnclaveInfo.mockResolvedValue(undefined);
      await handleChannelEvent(
        'member_left',
        ENCLAVE_NAME,
        { userId: 'U_ALICE' },
        deps,
      );
      expect(deps.mcpCall).not.toHaveBeenCalled();
    });
  });

  describe('channel_archive', () => {
    it('calls enclave_sync with new_status frozen', async () => {
      const deps = makeDeps();
      await handleChannelEvent('channel_archive', ENCLAVE_NAME, {}, deps);
      expect(deps.mcpCall).toHaveBeenCalledWith('enclave_sync', {
        name: ENCLAVE_NAME,
        new_status: 'frozen',
      });
      expect(deps.invalidateCache).toHaveBeenCalledWith(ENCLAVE_NAME);
    });
  });

  describe('channel_rename', () => {
    it('calls enclave_sync with new_channel_name', async () => {
      const deps = makeDeps();
      await handleChannelEvent(
        'channel_rename',
        ENCLAVE_NAME,
        { newName: 'new-name' },
        deps,
      );
      expect(deps.mcpCall).toHaveBeenCalledWith('enclave_sync', {
        name: ENCLAVE_NAME,
        new_channel_name: 'new-name',
      });
    });

    it('skips when newName is missing', async () => {
      const deps = makeDeps();
      await handleChannelEvent('channel_rename', ENCLAVE_NAME, {}, deps);
      expect(deps.mcpCall).not.toHaveBeenCalled();
    });
  });
});
