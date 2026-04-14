/**
 * Unit tests for structured Slack Block Kit cards (D2).
 */
import { describe, it, expect } from 'vitest';
import {
  enclaveListCard,
  workflowStatusCard,
  healthCard,
  authCard,
  buildCard,
  type EnclaveInfo,
  type WorkflowInfo,
  type HealthSummary,
  type AuthCardParams,
} from '../../src/slack/cards.js';

// ---------------------------------------------------------------------------
// enclaveListCard
// ---------------------------------------------------------------------------

describe('enclaveListCard', () => {
  it('returns empty state when no enclaves', () => {
    const result = enclaveListCard([]);
    expect(result.text).toBe('You have no active enclaves.');
    expect(result.blocks.find((b) => b.type === 'header')).toBeDefined();
  });

  it('includes enclave count in text', () => {
    const enclaves: EnclaveInfo[] = [
      {
        name: 'my-enclave',
        platform: 'k8s',
        members: ['a@b.com'],
        role: 'owner',
      },
    ];
    const result = enclaveListCard(enclaves);
    expect(result.text).toContain('1.');
    expect(result.text).toContain('my-enclave');
  });

  it('adds Chroma button for each enclave when <= 5 and chromaBaseUrl provided', () => {
    const enclaves: EnclaveInfo[] = [
      { name: 'enc1', platform: 'k8s', members: [], role: 'owner' },
      { name: 'enc2', platform: 'k8s', members: [], role: 'member' },
    ];
    const result = enclaveListCard(enclaves, 'https://chroma.example.com');
    // Should have section blocks with Chroma URLs
    const chromaBlocks = result.blocks.filter(
      (b) =>
        b.type === 'section' &&
        'text' in b &&
        (b as { text: { text: string } }).text.text.includes(
          'chroma.example.com',
        ),
    );
    expect(chromaBlocks.length).toBe(2);
  });

  it('adds single Chroma button when > 5 enclaves', () => {
    const enclaves: EnclaveInfo[] = Array.from({ length: 6 }, (_, i) => ({
      name: `enc${i}`,
      platform: 'k8s',
      members: [],
      role: 'owner' as const,
    }));
    const result = enclaveListCard(enclaves, 'https://chroma.example.com');
    const chromaBlocks = result.blocks.filter(
      (b) =>
        b.type === 'section' &&
        'text' in b &&
        (b as { text: { text: string } }).text.text.includes(
          'chroma.example.com',
        ),
    );
    expect(chromaBlocks.length).toBe(1);
  });

  it('does not add Chroma button when no chromaBaseUrl', () => {
    const enclaves: EnclaveInfo[] = [
      { name: 'enc1', platform: 'k8s', members: [], role: 'owner' },
    ];
    const result = enclaveListCard(enclaves);
    const chromaBlocks = result.blocks.filter(
      (b) =>
        b.type === 'section' &&
        'text' in b &&
        (b as { text: { text: string } }).text.text.includes('chroma'),
    );
    expect(chromaBlocks.length).toBe(0);
  });

  it('includes a preformatted table block', () => {
    const enclaves: EnclaveInfo[] = [
      { name: 'enc1', platform: 'k8s', members: ['a@b.com'], role: 'owner' },
    ];
    const result = enclaveListCard(enclaves);
    const rtBlock = result.blocks.find((b) => b.type === 'rich_text');
    expect(rtBlock).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// workflowStatusCard
// ---------------------------------------------------------------------------

describe('workflowStatusCard', () => {
  it('returns empty state when no workflows', () => {
    const result = workflowStatusCard([], 'my-enclave');
    expect(result.text).toContain('No workflows');
    expect(result.text).toContain('my-enclave');
  });

  it('includes workflow fields for each workflow', () => {
    const workflows: WorkflowInfo[] = [
      {
        name: 'my-wf',
        status: 'running',
        ready: true,
        version: 'v1.0.0',
        age: '2d',
      },
    ];
    const result = workflowStatusCard(workflows, 'my-enclave');
    const sectionWithFields = result.blocks.find(
      (b) => b.type === 'section' && 'fields' in b,
    );
    expect(sectionWithFields).toBeDefined();
  });

  it('shows ready count in summary text', () => {
    const workflows: WorkflowInfo[] = [
      { name: 'wf1', status: 'running', ready: true, version: 'v1', age: '1d' },
      { name: 'wf2', status: 'failed', ready: false, version: 'v2', age: '3h' },
    ];
    const result = workflowStatusCard(workflows, 'enc');
    const summaryBlock = result.blocks.find(
      (b) =>
        b.type === 'section' &&
        'text' in b &&
        (b as { text: { text: string } }).text.text.includes('1/2'),
    );
    expect(summaryBlock).toBeDefined();
  });

  it('adds Chroma deep link when chromaBaseUrl provided', () => {
    const workflows: WorkflowInfo[] = [
      { name: 'wf1', status: 'running', ready: true, version: 'v1', age: '1d' },
    ];
    const result = workflowStatusCard(
      workflows,
      'my-enc',
      'https://chroma.example.com',
    );
    const chromaBlock = result.blocks.find(
      (b) =>
        b.type === 'section' &&
        'text' in b &&
        (b as { text: { text: string } }).text.text.includes(
          'chroma.example.com',
        ),
    );
    expect(chromaBlock).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// healthCard
// ---------------------------------------------------------------------------

describe('healthCard', () => {
  it('includes total, healthy, degraded, down fields', () => {
    const summary: HealthSummary = {
      total: 10,
      healthy: 8,
      degraded: 1,
      down: 1,
    };
    const result = healthCard(summary);
    expect(result.text).toContain('8/10');
    expect(result.text).toContain('1 degraded');
    expect(result.text).toContain('1 down');
  });

  it('includes details block when details provided', () => {
    const summary: HealthSummary = {
      total: 2,
      healthy: 1,
      degraded: 0,
      down: 1,
      details: 'Pod crash loop detected',
    };
    const result = healthCard(summary);
    const detailsBlock = result.blocks.find(
      (b) =>
        b.type === 'section' &&
        'text' in b &&
        (b as { text: { text: string } }).text.text.includes('crash loop'),
    );
    expect(detailsBlock).toBeDefined();
  });

  it('has no details block when no details', () => {
    const summary: HealthSummary = {
      total: 1,
      healthy: 1,
      degraded: 0,
      down: 0,
    };
    const result = healthCard(summary);
    // Only the fields section block
    const divider = result.blocks.find((b) => b.type === 'divider');
    expect(divider).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// authCard
// ---------------------------------------------------------------------------

describe('authCard', () => {
  it('includes login URL in text', () => {
    const params: AuthCardParams = {
      loginUrl: 'https://kc.example.com/activate',
      userCode: 'ABCD-1234',
      expiresInSeconds: 300,
    };
    const result = authCard(params);
    expect(result.text).toContain('https://kc.example.com/activate');
    expect(result.text).toContain('ABCD-1234');
  });

  it('shows correct expiry minutes (ceiling)', () => {
    const params: AuthCardParams = {
      loginUrl: 'https://kc.example.com/activate',
      userCode: 'WXYZ-5678',
      expiresInSeconds: 301,
    };
    const result = authCard(params);
    // 301 / 60 = 5.016... -> ceil = 6
    const contextBlock = result.blocks.find(
      (b) =>
        b.type === 'context' &&
        'elements' in b &&
        (b as { elements: Array<{ text: string }> }).elements[0].text.includes(
          '6 minute',
        ),
    );
    expect(contextBlock).toBeDefined();
  });

  it('has a primary button block with login URL', () => {
    const params: AuthCardParams = {
      loginUrl: 'https://kc.example.com/activate',
      userCode: 'ABCD-1234',
      expiresInSeconds: 600,
    };
    const result = authCard(params);
    const buttonBlock = result.blocks.find(
      (b) =>
        b.type === 'section' &&
        'accessory' in b &&
        (b as { accessory: { type: string } }).accessory.type === 'button',
    );
    expect(buttonBlock).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// buildCard dispatcher
// ---------------------------------------------------------------------------

describe('buildCard', () => {
  it('routes enclave_list type', () => {
    const result = buildCard('enclave_list', { enclaves: [] });
    expect(result.text).toBe('You have no active enclaves.');
  });

  it('routes workflow_status type', () => {
    const result = buildCard('workflow_status', {
      workflows: [],
      enclave_name: 'enc',
    });
    expect(result.text).toContain('No workflows');
  });

  it('routes health type', () => {
    const result = buildCard('health', {
      total: 5,
      healthy: 5,
      degraded: 0,
      down: 0,
    });
    expect(result.text).toContain('5/5');
  });

  it('routes auth type', () => {
    const result = buildCard('auth', {
      loginUrl: 'https://kc.example.com/activate',
      userCode: 'TEST-0000',
      expiresInSeconds: 600,
    });
    expect(result.text).toContain('TEST-0000');
  });

  it('falls back to raw JSON for unknown card type', () => {
    const result = buildCard('unknown_type', { key: 'value' });
    expect(result.text).toContain('key');
  });

  it('falls back gracefully on error', () => {
    // Passing null will throw inside the card builder
    const result = buildCard('health', null);
    // Should return a fallback block, not throw
    expect(result.blocks.length).toBeGreaterThan(0);
  });
});
