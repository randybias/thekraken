/**
 * Unit tests for the Slack Home Tab builder (D3).
 */
import { describe, it, expect } from 'vitest';
import {
  buildHomeTab,
  buildUnauthenticatedHomeTab,
  type EnclaveData,
} from '../../src/slack/home-tab.js';

describe('buildHomeTab', () => {
  it('returns type: home', () => {
    const view = buildHomeTab([]);
    expect(view.type).toBe('home');
  });

  it('includes welcome header block', () => {
    const view = buildHomeTab([]);
    const headerBlock = view.blocks.find(
      (b) =>
        b.type === 'header' &&
        (b as { text: { text: string } }).text.text.includes('Welcome'),
    );
    expect(headerBlock).toBeDefined();
  });

  it('shows empty state when no enclaves', () => {
    const view = buildHomeTab([]);
    const emptyBlock = view.blocks.find(
      (b) =>
        b.type === 'section' &&
        'text' in b &&
        (b as { text: { text: string } }).text.text.includes(
          "don't have any enclaves",
        ),
    );
    expect(emptyBlock).toBeDefined();
  });

  it('shows enclave list when enclaves provided', () => {
    const enclaves: EnclaveData[] = [
      {
        name: 'my-enclave',
        tentacleCount: 3,
        healthyCount: 3,
        role: 'owner',
      },
    ];
    const view = buildHomeTab(enclaves);
    const enclaveBlock = view.blocks.find(
      (b) =>
        b.type === 'section' &&
        'text' in b &&
        (b as { text: { text: string } }).text.text.includes('my-enclave'),
    );
    expect(enclaveBlock).toBeDefined();
  });

  it('shows green health for fully healthy enclave', () => {
    const enclaves: EnclaveData[] = [
      {
        name: 'enc',
        tentacleCount: 2,
        healthyCount: 2,
        role: 'owner',
      },
    ];
    const view = buildHomeTab(enclaves);
    const healthBlock = view.blocks.find(
      (b) =>
        b.type === 'section' &&
        'text' in b &&
        (b as { text: { text: string } }).text.text.includes(
          ':large_green_circle:',
        ),
    );
    expect(healthBlock).toBeDefined();
  });

  it('shows red health for fully unhealthy enclave', () => {
    const enclaves: EnclaveData[] = [
      {
        name: 'enc',
        tentacleCount: 4,
        healthyCount: 0,
        role: 'member',
      },
    ];
    const view = buildHomeTab(enclaves);
    const healthBlock = view.blocks.find(
      (b) =>
        b.type === 'section' &&
        'text' in b &&
        (b as { text: { text: string } }).text.text.includes(':red_circle:'),
    );
    expect(healthBlock).toBeDefined();
  });

  it('shows yellow health for partially healthy enclave', () => {
    const enclaves: EnclaveData[] = [
      {
        name: 'enc',
        tentacleCount: 4,
        healthyCount: 2,
        role: 'member',
      },
    ];
    const view = buildHomeTab(enclaves);
    const healthBlock = view.blocks.find(
      (b) =>
        b.type === 'section' &&
        'text' in b &&
        (b as { text: { text: string } }).text.text.includes(
          ':large_yellow_circle:',
        ),
    );
    expect(healthBlock).toBeDefined();
  });

  it('shows white circle for enclave with 0 tentacles', () => {
    const enclaves: EnclaveData[] = [
      {
        name: 'enc',
        tentacleCount: 0,
        healthyCount: 0,
        role: 'owner',
      },
    ];
    const view = buildHomeTab(enclaves);
    const healthBlock = view.blocks.find(
      (b) =>
        b.type === 'section' &&
        'text' in b &&
        (b as { text: { text: string } }).text.text.includes(':white_circle:'),
    );
    expect(healthBlock).toBeDefined();
  });

  it('adds Chroma button when chromaUrl provided', () => {
    const enclaves: EnclaveData[] = [
      {
        name: 'enc',
        tentacleCount: 1,
        healthyCount: 1,
        role: 'owner',
        chromaUrl: 'https://chroma.example.com/enclaves/enc',
      },
    ];
    const view = buildHomeTab(enclaves);
    const actionsBlock = view.blocks.find((b) => b.type === 'actions');
    expect(actionsBlock).toBeDefined();
  });

  it('does not add Chroma button when no chromaUrl', () => {
    const enclaves: EnclaveData[] = [
      {
        name: 'enc',
        tentacleCount: 1,
        healthyCount: 1,
        role: 'owner',
      },
    ];
    const view = buildHomeTab(enclaves);
    const actionsBlock = view.blocks.find((b) => b.type === 'actions');
    expect(actionsBlock).toBeUndefined();
  });

  it('includes quick reference section', () => {
    const view = buildHomeTab([]);
    const qrHeader = view.blocks.find(
      (b) =>
        b.type === 'header' &&
        (b as { text: { text: string } }).text.text.includes('Quick Reference'),
    );
    expect(qrHeader).toBeDefined();
  });

  it('shows Owner role label correctly', () => {
    const enclaves: EnclaveData[] = [
      { name: 'enc', tentacleCount: 1, healthyCount: 1, role: 'owner' },
    ];
    const view = buildHomeTab(enclaves);
    const block = view.blocks.find(
      (b) =>
        b.type === 'section' &&
        'text' in b &&
        (b as { text: { text: string } }).text.text.includes('Owner'),
    );
    expect(block).toBeDefined();
  });

  it('shows Member role label correctly', () => {
    const enclaves: EnclaveData[] = [
      { name: 'enc', tentacleCount: 1, healthyCount: 1, role: 'member' },
    ];
    const view = buildHomeTab(enclaves);
    const block = view.blocks.find(
      (b) =>
        b.type === 'section' &&
        'text' in b &&
        (b as { text: { text: string } }).text.text.includes('Member'),
    );
    expect(block).toBeDefined();
  });
});

describe('buildUnauthenticatedHomeTab', () => {
  it('returns type: home', () => {
    const view = buildUnauthenticatedHomeTab();
    expect(view.type).toBe('home');
  });

  it('has a welcome header', () => {
    const view = buildUnauthenticatedHomeTab();
    const headerBlock = view.blocks.find(
      (b) =>
        b.type === 'header' &&
        (b as { text: { text: string } }).text.text.includes('Welcome'),
    );
    expect(headerBlock).toBeDefined();
  });

  it('asks user to DM for login', () => {
    const view = buildUnauthenticatedHomeTab();
    const loginBlock = view.blocks.find(
      (b) =>
        b.type === 'section' &&
        'text' in b &&
        (b as { text: { text: string } }).text.text.includes('DM'),
    );
    expect(loginBlock).toBeDefined();
  });
});
