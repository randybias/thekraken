import { describe, it, expect, vi } from 'vitest';
import { provisionEnclave, deprovisionEnclave } from '../../src/enclave/provisioning.js';

describe('provisionEnclave', () => {
  it('calls enclave_provision with correct params', async () => {
    const mockMcp = vi.fn().mockResolvedValue({ name: 'my-enclave', status: 'active' });
    const result = await provisionEnclave({
      name: 'my-enclave',
      ownerEmail: 'alice@example.com',
      ownerSub: 'sub-123',
      platform: 'slack',
      channelId: 'C123',
      channelName: 'my-channel',
    }, mockMcp);

    expect(mockMcp).toHaveBeenCalledWith('enclave_provision', {
      name: 'my-enclave',
      owner_email: 'alice@example.com',
      owner_sub: 'sub-123',
      platform: 'slack',
      channel_id: 'C123',
      channel_name: 'my-channel',
    });
    expect(result.name).toBe('my-enclave');
  });

  it('passes optional members and quota_preset', async () => {
    const mockMcp = vi.fn().mockResolvedValue({ name: 'enc', status: 'active' });
    await provisionEnclave({
      name: 'enc',
      ownerEmail: 'a@b.com',
      ownerSub: 's',
      members: ['bob@example.com'],
      quotaPreset: 'large',
    }, mockMcp);

    expect(mockMcp).toHaveBeenCalledWith('enclave_provision', expect.objectContaining({
      members: ['bob@example.com'],
      quota_preset: 'large',
    }));
  });
});

describe('deprovisionEnclave', () => {
  it('calls enclave_deprovision', async () => {
    const mockMcp = vi.fn().mockResolvedValue({ tentacles_removed: 3 });
    const result = await deprovisionEnclave('my-enclave', mockMcp);
    expect(mockMcp).toHaveBeenCalledWith('enclave_deprovision', { name: 'my-enclave' });
    expect(result.tentacles_removed).toBe(3);
  });
});
