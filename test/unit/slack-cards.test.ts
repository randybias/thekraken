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
// Fixtures
// ---------------------------------------------------------------------------

const sampleEnclaves: EnclaveInfo[] = [
  {
    name: 'alpha',
    platform: 'gke',
    members: ['alice', 'bob'],
    role: 'owner',
  },
  {
    name: 'beta',
    platform: 'aks',
    members: ['carol'],
    role: 'member',
  },
];

const sampleWorkflows: WorkflowInfo[] = [
  {
    name: 'data-pipeline',
    status: 'running',
    ready: true,
    version: '1.2.0',
    age: '3d',
  },
  {
    name: 'auth-service',
    status: 'failed',
    ready: false,
    version: '0.9.1',
    age: '1h',
  },
  {
    name: 'metrics-exporter',
    status: 'pending',
    ready: false,
    version: '2.0.0',
    age: '10m',
  },
];

const sampleHealth: HealthSummary = {
  total: 10,
  healthy: 8,
  degraded: 1,
  down: 1,
};

const sampleAuth: AuthCardParams = {
  loginUrl: 'https://auth.example.com/activate',
  userCode: 'ABCD-1234',
  expiresInSeconds: 300,
};

// ---------------------------------------------------------------------------
// enclaveListCard
// ---------------------------------------------------------------------------

describe('enclaveListCard', () => {
  it('returns blocks and text with typical data', () => {
    const result = enclaveListCard(sampleEnclaves);
    expect(result.blocks.length).toBeGreaterThan(0);
    expect(result.text).toContain('alpha');
    expect(result.text).toContain('beta');
  });

  it('has a header block as first block', () => {
    const result = enclaveListCard(sampleEnclaves);
    expect(result.blocks[0].type).toBe('header');
  });

  it('includes enclave count in section text', () => {
    const result = enclaveListCard(sampleEnclaves);
    const sectionTexts = result.blocks
      .filter((b) => b.type === 'section')
      .map((b) =>
        'text' in b && b.text && typeof b.text !== 'string' && 'text' in b.text
          ? b.text.text
          : '',
      );
    const countSection = sectionTexts.find((t) =>
      t.includes('2 active enclaves'),
    );
    expect(countSection).toBeTruthy();
  });

  it('renders a rich_text_preformatted block for the table', () => {
    const result = enclaveListCard(sampleEnclaves);
    const richTextBlock = result.blocks.find((b) => b.type === 'rich_text');
    expect(richTextBlock).toBeTruthy();
  });

  it('table content includes enclave names', () => {
    const result = enclaveListCard(sampleEnclaves);
    const richTextBlock = result.blocks.find((b) => b.type === 'rich_text') as
      | {
          type: string;
          elements: {
            type: string;
            elements: { type: string; text: string }[];
          }[];
        }
      | undefined;
    const tableText = richTextBlock?.elements?.[0]?.elements?.[0]?.text ?? '';
    expect(tableText).toContain('alpha');
    expect(tableText).toContain('beta');
  });

  it('handles empty array', () => {
    const result = enclaveListCard([]);
    expect(result.blocks.length).toBeGreaterThan(0);
    expect(result.text).toContain('no active enclaves');
  });

  it('handles single enclave with singular grammar', () => {
    const result = enclaveListCard([sampleEnclaves[0]]);
    const sectionTexts = result.blocks
      .filter((b) => b.type === 'section')
      .map((b) =>
        'text' in b && b.text && 'text' in b.text ? b.text.text : '',
      );
    const countSection = sectionTexts.find((t) =>
      t.includes('1 active enclave'),
    );
    expect(countSection).toBeTruthy();
  });

  it('handles many enclaves without error', () => {
    const many: EnclaveInfo[] = Array.from({ length: 20 }, (_, i) => ({
      name: `enclave-${i}`,
      platform: 'gke',
      members: ['user1'],
      role: i === 0 ? 'owner' : 'member',
    }));
    const result = enclaveListCard(many);
    expect(result.blocks.length).toBeGreaterThan(0);
    expect(result.text).toContain('enclave-0');
  });

  it('includes no button when chromaBaseUrl is absent', () => {
    const result = enclaveListCard(sampleEnclaves);
    const buttonBlocks = result.blocks.filter(
      (b) => b.type === 'section' && 'accessory' in b,
    );
    expect(buttonBlocks.length).toBe(0);
  });

  it('includes per-enclave buttons when chromaBaseUrl is provided and few enclaves', () => {
    const result = enclaveListCard(
      sampleEnclaves,
      'https://chroma.example.com',
    );
    const buttonBlocks = result.blocks.filter(
      (b) => b.type === 'section' && 'accessory' in b,
    );
    expect(buttonBlocks.length).toBe(sampleEnclaves.length);
  });

  it('includes a single overview button for many enclaves when chromaBaseUrl is provided', () => {
    const many: EnclaveInfo[] = Array.from({ length: 10 }, (_, i) => ({
      name: `enclave-${i}`,
      platform: 'gke',
      members: [],
      role: 'member',
    }));
    const result = enclaveListCard(many, 'https://chroma.example.com');
    const buttonBlocks = result.blocks.filter(
      (b) => b.type === 'section' && 'accessory' in b,
    );
    expect(buttonBlocks.length).toBe(1);
  });

  it('text fallback is always a non-empty string', () => {
    expect(enclaveListCard(sampleEnclaves).text.length).toBeGreaterThan(0);
    expect(enclaveListCard([]).text.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// workflowStatusCard
// ---------------------------------------------------------------------------

describe('workflowStatusCard', () => {
  it('returns blocks and text with typical data', () => {
    const result = workflowStatusCard(sampleWorkflows, 'alpha');
    expect(result.blocks.length).toBeGreaterThan(0);
    expect(result.text).toContain('data-pipeline');
    expect(result.text).toContain('alpha');
  });

  it('has a header block containing enclave name', () => {
    const result = workflowStatusCard(sampleWorkflows, 'alpha');
    const header = result.blocks[0] as {
      type: string;
      text: { type: string; text: string };
    };
    expect(header.type).toBe('header');
    expect(header.text.text).toContain('alpha');
  });

  it('renders section fields for each workflow', () => {
    const result = workflowStatusCard(sampleWorkflows, 'alpha');
    const fieldSections = result.blocks.filter(
      (b) => b.type === 'section' && 'fields' in b,
    );
    expect(fieldSections.length).toBe(sampleWorkflows.length);
  });

  it('uses green emoji for running status', () => {
    const result = workflowStatusCard(
      [
        {
          name: 'wf',
          status: 'running',
          ready: true,
          version: '1.0',
          age: '1d',
        },
      ],
      'test-enclave',
    );
    const fieldSection = result.blocks.find(
      (b) => b.type === 'section' && 'fields' in b,
    ) as { type: string; fields: { type: string; text: string }[] } | undefined;
    const statusField = fieldSection?.fields?.find((f) =>
      f.text.includes('Status'),
    );
    expect(statusField?.text).toContain(':large_green_circle:');
  });

  it('uses red emoji for failed status', () => {
    const result = workflowStatusCard(
      [
        {
          name: 'wf',
          status: 'failed',
          ready: false,
          version: '1.0',
          age: '1d',
        },
      ],
      'test-enclave',
    );
    const fieldSection = result.blocks.find(
      (b) => b.type === 'section' && 'fields' in b,
    ) as { type: string; fields: { type: string; text: string }[] } | undefined;
    const statusField = fieldSection?.fields?.find((f) =>
      f.text.includes('Status'),
    );
    expect(statusField?.text).toContain(':red_circle:');
  });

  it('uses yellow emoji for pending status', () => {
    const result = workflowStatusCard(
      [
        {
          name: 'wf',
          status: 'pending',
          ready: false,
          version: '1.0',
          age: '1d',
        },
      ],
      'test-enclave',
    );
    const fieldSection = result.blocks.find(
      (b) => b.type === 'section' && 'fields' in b,
    ) as { type: string; fields: { type: string; text: string }[] } | undefined;
    const statusField = fieldSection?.fields?.find((f) =>
      f.text.includes('Status'),
    );
    expect(statusField?.text).toContain(':large_yellow_circle:');
  });

  it('handles empty workflow list', () => {
    const result = workflowStatusCard([], 'alpha');
    expect(result.blocks.length).toBeGreaterThan(0);
    expect(result.text).toContain('No workflows');
  });

  it('includes no button when chromaBaseUrl is absent', () => {
    const result = workflowStatusCard(sampleWorkflows, 'alpha');
    const buttonBlocks = result.blocks.filter(
      (b) => b.type === 'section' && 'accessory' in b,
    );
    expect(buttonBlocks.length).toBe(0);
  });

  it('includes Chroma button when chromaBaseUrl is provided', () => {
    const result = workflowStatusCard(
      sampleWorkflows,
      'alpha',
      'https://chroma.example.com',
    );
    const buttonBlocks = result.blocks.filter(
      (b) => b.type === 'section' && 'accessory' in b,
    );
    expect(buttonBlocks.length).toBe(1);
  });

  it('text fallback is always a non-empty string', () => {
    expect(
      workflowStatusCard(sampleWorkflows, 'alpha').text.length,
    ).toBeGreaterThan(0);
    expect(workflowStatusCard([], 'alpha').text.length).toBeGreaterThan(0);
  });

  it('summary includes ready/total count', () => {
    const result = workflowStatusCard(sampleWorkflows, 'alpha');
    const sectionTexts = result.blocks
      .filter(
        (b) => b.type === 'section' && !('fields' in b) && !('accessory' in b),
      )
      .map((b) =>
        'text' in b && b.text && typeof b.text !== 'string' && 'text' in b.text
          ? b.text.text
          : '',
      );
    const summary = sectionTexts.find((t) => t.includes('1/3'));
    expect(summary).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// healthCard
// ---------------------------------------------------------------------------

describe('healthCard', () => {
  it('returns blocks and text', () => {
    const result = healthCard(sampleHealth);
    expect(result.blocks.length).toBeGreaterThan(0);
    expect(result.text).toContain('8/10');
  });

  it('has a section with fields', () => {
    const result = healthCard(sampleHealth);
    const fieldSection = result.blocks.find(
      (b) => b.type === 'section' && 'fields' in b,
    );
    expect(fieldSection).toBeTruthy();
  });

  it('fields contain correct counts', () => {
    const result = healthCard(sampleHealth);
    const fieldSection = result.blocks.find(
      (b) => b.type === 'section' && 'fields' in b,
    ) as { type: string; fields: { type: string; text: string }[] } | undefined;
    const allText = fieldSection?.fields?.map((f) => f.text).join(' ') ?? '';
    expect(allText).toContain('10');
    expect(allText).toContain('8');
    expect(allText).toContain('1');
  });

  it('renders green emoji for healthy count', () => {
    const result = healthCard(sampleHealth);
    const fieldSection = result.blocks.find(
      (b) => b.type === 'section' && 'fields' in b,
    ) as { type: string; fields: { type: string; text: string }[] } | undefined;
    const healthyField = fieldSection?.fields?.find((f) =>
      f.text.includes('Healthy'),
    );
    expect(healthyField?.text).toContain(':large_green_circle:');
  });

  it('renders red emoji for down count', () => {
    const result = healthCard(sampleHealth);
    const fieldSection = result.blocks.find(
      (b) => b.type === 'section' && 'fields' in b,
    ) as { type: string; fields: { type: string; text: string }[] } | undefined;
    const downField = fieldSection?.fields?.find((f) =>
      f.text.includes('Down'),
    );
    expect(downField?.text).toContain(':red_circle:');
  });

  it('all healthy case has no down or degraded issues', () => {
    const allHealthy: HealthSummary = {
      total: 5,
      healthy: 5,
      degraded: 0,
      down: 0,
    };
    const result = healthCard(allHealthy);
    expect(result.text).toContain('5/5');
    expect(result.text).toContain('0 degraded');
    expect(result.text).toContain('0 down');
  });

  it('renders details section when details provided', () => {
    const withDetails: HealthSummary = {
      ...sampleHealth,
      details: 'Node pool-1 is under pressure.',
    };
    const result = healthCard(withDetails);
    const hasDivider = result.blocks.some((b) => b.type === 'divider');
    const detailsBlock = result.blocks.find(
      (b) =>
        b.type === 'section' &&
        'text' in b &&
        b.text &&
        'text' in b.text &&
        b.text.text.includes('under pressure'),
    );
    expect(hasDivider).toBe(true);
    expect(detailsBlock).toBeTruthy();
  });

  it('no details section when details absent', () => {
    const result = healthCard(sampleHealth);
    const hasDivider = result.blocks.some((b) => b.type === 'divider');
    expect(hasDivider).toBe(false);
  });

  it('text fallback is always a non-empty string', () => {
    expect(healthCard(sampleHealth).text.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// authCard
// ---------------------------------------------------------------------------

describe('authCard', () => {
  it('returns blocks and text', () => {
    const result = authCard(sampleAuth);
    expect(result.blocks.length).toBeGreaterThan(0);
    expect(result.text).toContain('ABCD-1234');
    expect(result.text).toContain('https://auth.example.com/activate');
  });

  it('renders the user code in the blocks', () => {
    const result = authCard(sampleAuth);
    const allText = result.blocks
      .filter((b) => b.type === 'section')
      .map((b) =>
        'text' in b && b.text && 'text' in b.text ? b.text.text : '',
      )
      .join(' ');
    expect(allText).toContain('ABCD-1234');
  });

  it('includes a Log In button with the correct URL', () => {
    const result = authCard(sampleAuth);
    const buttonSection = result.blocks.find(
      (b) => b.type === 'section' && 'accessory' in b,
    ) as
      | {
          type: string;
          accessory: { type: string; url: string; text: { text: string } };
        }
      | undefined;
    expect(buttonSection).toBeTruthy();
    expect(buttonSection?.accessory.url).toBe(
      'https://auth.example.com/activate',
    );
    expect(buttonSection?.accessory.text.text).toBe('Log In');
  });

  it('includes a context block with expiry info', () => {
    const result = authCard(sampleAuth);
    const contextEl = result.blocks.find((b) => b.type === 'context') as
      | { type: string; elements: { type: string; text: string }[] }
      | undefined;
    expect(contextEl).toBeTruthy();
    expect(contextEl?.elements[0].text).toContain('5 minutes');
  });

  it('calculates minutes correctly and rounds up', () => {
    const result = authCard({ ...sampleAuth, expiresInSeconds: 61 });
    const contextEl = result.blocks.find((b) => b.type === 'context') as
      | { type: string; elements: { type: string; text: string }[] }
      | undefined;
    expect(contextEl?.elements[0].text).toContain('2 minutes');
  });

  it('uses singular minute for exactly 60 seconds', () => {
    const result = authCard({ ...sampleAuth, expiresInSeconds: 60 });
    const contextEl = result.blocks.find((b) => b.type === 'context') as
      | { type: string; elements: { type: string; text: string }[] }
      | undefined;
    expect(contextEl?.elements[0].text).toContain('1 minute');
    expect(contextEl?.elements[0].text).not.toContain('1 minutes');
  });

  it('text fallback is always a non-empty string', () => {
    expect(authCard(sampleAuth).text.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// buildCard dispatcher
// ---------------------------------------------------------------------------

describe('buildCard', () => {
  it('dispatches enclave_list to enclaveListCard', () => {
    const result = buildCard('enclave_list', { enclaves: sampleEnclaves });
    expect(result.blocks[0].type).toBe('header');
    expect(result.text).toContain('alpha');
  });

  it('dispatches workflow_status to workflowStatusCard', () => {
    const result = buildCard('workflow_status', {
      workflows: sampleWorkflows,
      enclave_name: 'alpha',
    });
    expect(result.blocks[0].type).toBe('header');
    expect(result.text).toContain('data-pipeline');
  });

  it('dispatches health to healthCard', () => {
    const result = buildCard('health', sampleHealth);
    expect(
      result.blocks.some((b) => b.type === 'section' && 'fields' in b),
    ).toBe(true);
    expect(result.text).toContain('8/10');
  });

  it('dispatches auth to authCard', () => {
    const result = buildCard('auth', sampleAuth);
    expect(result.text).toContain('ABCD-1234');
  });

  it('falls back to plain section for unknown card type', () => {
    const result = buildCard('unknown_type', { foo: 'bar' });
    expect(result.blocks.length).toBe(1);
    expect(result.blocks[0].type).toBe('section');
  });

  it('passes chromaBaseUrl to enclave_list builder', () => {
    const result = buildCard(
      'enclave_list',
      { enclaves: sampleEnclaves },
      'https://chroma.example.com',
    );
    const buttonBlocks = result.blocks.filter(
      (b) => b.type === 'section' && 'accessory' in b,
    );
    expect(buttonBlocks.length).toBeGreaterThan(0);
  });

  it('passes chromaBaseUrl to workflow_status builder', () => {
    const result = buildCard(
      'workflow_status',
      { workflows: sampleWorkflows, enclave_name: 'alpha' },
      'https://chroma.example.com',
    );
    const buttonBlocks = result.blocks.filter(
      (b) => b.type === 'section' && 'accessory' in b,
    );
    expect(buttonBlocks.length).toBeGreaterThan(0);
  });

  it('no buttons in enclave_list without chromaBaseUrl', () => {
    const result = buildCard('enclave_list', { enclaves: sampleEnclaves });
    const buttonBlocks = result.blocks.filter(
      (b) => b.type === 'section' && 'accessory' in b,
    );
    expect(buttonBlocks.length).toBe(0);
  });

  it('handles missing enclaves array gracefully', () => {
    const result = buildCard('enclave_list', {});
    expect(result.blocks.length).toBeGreaterThan(0);
  });

  it('handles missing workflows array gracefully', () => {
    const result = buildCard('workflow_status', { enclave_name: 'alpha' });
    expect(result.blocks.length).toBeGreaterThan(0);
  });

  it('always returns a non-empty text fallback', () => {
    const types: Array<[string, unknown]> = [
      ['enclave_list', { enclaves: sampleEnclaves }],
      [
        'workflow_status',
        { workflows: sampleWorkflows, enclave_name: 'alpha' },
      ],
      ['health', sampleHealth],
      ['auth', sampleAuth],
      ['unknown', { x: 1 }],
    ];
    for (const [type, data] of types) {
      expect(buildCard(type, data).text.length).toBeGreaterThan(0);
    }
  });

  it('falls back gracefully when health data causes TypeError', () => {
    // Pass null as health data to trigger TypeError in healthCard
    const result = buildCard('health', null);
    expect(result.blocks.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Status emoji coverage (additional statuses)
// ---------------------------------------------------------------------------

describe('workflowStatusCard status emoji coverage', () => {
  function statusFieldText(status: string): string {
    const result = workflowStatusCard(
      [{ name: 'wf', status, ready: false, version: '1.0', age: '1m' }],
      'test',
    );
    const fieldSection = result.blocks.find(
      (b) => b.type === 'section' && 'fields' in b,
    ) as { type: string; fields: { type: string; text: string }[] } | undefined;
    return (
      fieldSection?.fields?.find((f) => f.text.includes('Status'))?.text ?? ''
    );
  }

  it('uses green emoji for ready status', () => {
    expect(statusFieldText('ready')).toContain(':large_green_circle:');
  });

  it('uses yellow emoji for degraded status', () => {
    expect(statusFieldText('degraded')).toContain(':large_yellow_circle:');
  });

  it('uses yellow emoji for warning status', () => {
    expect(statusFieldText('warning')).toContain(':large_yellow_circle:');
  });

  it('uses red emoji for error status', () => {
    expect(statusFieldText('error')).toContain(':red_circle:');
  });

  it('uses red emoji for down status', () => {
    expect(statusFieldText('down')).toContain(':red_circle:');
  });

  it('uses white circle for stopped status', () => {
    expect(statusFieldText('stopped')).toContain(':white_circle:');
  });

  it('uses white circle for unknown status', () => {
    expect(statusFieldText('unknown')).toContain(':white_circle:');
  });

  it('uses white circle for unrecognized status', () => {
    expect(statusFieldText('initializing')).toContain(':white_circle:');
  });
});

// ---------------------------------------------------------------------------
// healthCard degraded emoji
// ---------------------------------------------------------------------------

describe('healthCard degraded emoji', () => {
  it('renders yellow emoji for degraded count', () => {
    const result = healthCard(sampleHealth);
    const fieldSection = result.blocks.find(
      (b) => b.type === 'section' && 'fields' in b,
    ) as { type: string; fields: { type: string; text: string }[] } | undefined;
    const degradedField = fieldSection?.fields?.find((f) =>
      f.text.includes('Degraded'),
    );
    expect(degradedField?.text).toContain(':large_yellow_circle:');
  });
});

// ---------------------------------------------------------------------------
// enclaveListCard mixed role summary line
// ---------------------------------------------------------------------------

describe('enclaveListCard mixed owner+member summary', () => {
  it('shows both owned and member counts in summary', () => {
    const result = enclaveListCard(sampleEnclaves);
    const sectionTexts = result.blocks
      .filter((b) => b.type === 'section')
      .map((b) =>
        'text' in b && b.text && 'text' in b.text ? b.text.text : '',
      );
    const summary = sectionTexts.find(
      (t) => t.includes('owned by you') && t.includes('as member'),
    );
    expect(summary).toBeTruthy();
  });

  it('shows only owned when all enclaves are owned', () => {
    const allOwned: EnclaveInfo[] = [
      { name: 'a', platform: 'gke', members: [], role: 'owner' },
      { name: 'b', platform: 'gke', members: [], role: 'owner' },
    ];
    const result = enclaveListCard(allOwned);
    const sectionTexts = result.blocks
      .filter((b) => b.type === 'section')
      .map((b) =>
        'text' in b && b.text && 'text' in b.text ? b.text.text : '',
      );
    const summary = sectionTexts.find((t) => t.includes('owned by you'));
    expect(summary).toBeTruthy();
    expect(summary).not.toContain('as member');
  });
});
