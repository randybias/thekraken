import { describe, it, expect, beforeEach } from 'vitest';
import {
  buildHomeTab,
  buildUnauthenticatedHomeTab,
  type EnclaveData,
} from '../../src/slack/home-tab.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const twoEnclaves: EnclaveData[] = [
  {
    name: 'alpha',
    tentacleCount: 5,
    healthyCount: 5,
    role: 'owner',
  },
  {
    name: 'beta',
    tentacleCount: 3,
    healthyCount: 2,
    role: 'member',
  },
];

// ---------------------------------------------------------------------------
// buildHomeTab — 0 enclaves
// ---------------------------------------------------------------------------

describe('buildHomeTab with 0 enclaves', () => {
  it('returns a home view type', () => {
    const view = buildHomeTab([]);
    expect(view.type).toBe('home');
  });

  it('has blocks', () => {
    const view = buildHomeTab([]);
    expect(view.blocks.length).toBeGreaterThan(0);
  });

  it('shows no enclaves message', () => {
    const view = buildHomeTab([]);
    const allText = view.blocks
      .filter((b) => b.type === 'section')
      .map((b) =>
        'text' in b && b.text && typeof b.text !== 'string' && 'text' in b.text
          ? b.text.text
          : '',
      )
      .join(' ');
    expect(allText).toContain("don't have any enclaves");
  });

  it('still shows the welcome header', () => {
    const view = buildHomeTab([]);
    const firstBlock = view.blocks[0] as {
      type: string;
      text: { text: string };
    };
    expect(firstBlock.type).toBe('header');
    expect(firstBlock.text.text).toContain('Welcome to The Kraken');
  });
});

// ---------------------------------------------------------------------------
// buildHomeTab — 2 enclaves
// ---------------------------------------------------------------------------

describe('buildHomeTab with 2 enclaves', () => {
  it('returns a home view type', () => {
    const view = buildHomeTab(twoEnclaves);
    expect(view.type).toBe('home');
  });

  it('shows both enclave names', () => {
    const view = buildHomeTab(twoEnclaves);
    const allText = view.blocks
      .filter((b) => b.type === 'section')
      .map((b) =>
        'text' in b && b.text && typeof b.text !== 'string' && 'text' in b.text
          ? b.text.text
          : '',
      )
      .join(' ');
    expect(allText).toContain('alpha');
    expect(allText).toContain('beta');
  });

  it('shows tentacle counts', () => {
    const view = buildHomeTab(twoEnclaves);
    const allText = view.blocks
      .filter((b) => b.type === 'section')
      .map((b) =>
        'text' in b && b.text && typeof b.text !== 'string' && 'text' in b.text
          ? b.text.text
          : '',
      )
      .join(' ');
    expect(allText).toContain('5');
    expect(allText).toContain('3');
  });

  it('shows role for each enclave', () => {
    const view = buildHomeTab(twoEnclaves);
    const allText = view.blocks
      .filter((b) => b.type === 'section')
      .map((b) =>
        'text' in b && b.text && typeof b.text !== 'string' && 'text' in b.text
          ? b.text.text
          : '',
      )
      .join(' ');
    expect(allText).toContain('Owner');
    expect(allText).toContain('Member');
  });

  it('includes the Quick Reference section', () => {
    const view = buildHomeTab(twoEnclaves);
    const headerTexts = view.blocks
      .filter((b) => b.type === 'header')
      .map((b) =>
        'text' in b && b.text && typeof b.text !== 'string' && 'text' in b.text
          ? b.text.text
          : '',
      );
    expect(headerTexts.some((t) => t.includes('Quick Reference'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// buildHomeTab — Chroma URL via enclave.chromaUrl field
// ---------------------------------------------------------------------------

describe('buildHomeTab with chromaUrl on enclave', () => {
  it('includes Open in Chroma button for enclaves that have a chromaUrl', () => {
    const enclaves: EnclaveData[] = [
      {
        name: 'alpha',
        tentacleCount: 2,
        healthyCount: 2,
        role: 'owner',
        chromaUrl: 'https://chroma.example.com/enclaves/alpha',
      },
    ];
    const view = buildHomeTab(enclaves);
    const actionBlocks = view.blocks.filter(
      (b) => b.type === 'actions',
    ) as Array<{
      type: string;
      elements: Array<{
        type: string;
        url: string;
        text: { text: string };
        action_id: string;
      }>;
    }>;
    expect(actionBlocks.length).toBe(1);
    expect(actionBlocks[0].elements[0].url).toBe(
      'https://chroma.example.com/enclaves/alpha',
    );
    expect(actionBlocks[0].elements[0].text.text).toBe('Open in Chroma');
    expect(actionBlocks[0].elements[0].action_id).toBe('open_chroma_alpha');
  });
});

// ---------------------------------------------------------------------------
// buildHomeTab — Chroma URL set by caller on all enclaves
// ---------------------------------------------------------------------------

describe('buildHomeTab with chromaUrl set by caller', () => {
  it('includes Open in Chroma buttons for all enclaves with chromaUrl', () => {
    const enclavesWithChroma: EnclaveData[] = [
      {
        ...twoEnclaves[0],
        chromaUrl: 'https://chroma.test.com/enclaves/alpha',
      },
      {
        ...twoEnclaves[1],
        chromaUrl: 'https://chroma.test.com/enclaves/beta',
      },
    ];
    const view = buildHomeTab(enclavesWithChroma);
    const actionBlocks = view.blocks.filter(
      (b) => b.type === 'actions',
    ) as Array<{
      type: string;
      elements: Array<{ type: string; url: string }>;
    }>;
    expect(actionBlocks.length).toBe(2);
    const urls = actionBlocks.map((b) => b.elements[0].url);
    expect(urls).toContain('https://chroma.test.com/enclaves/alpha');
    expect(urls).toContain('https://chroma.test.com/enclaves/beta');
  });
});

// ---------------------------------------------------------------------------
// buildHomeTab — No Chroma URL
// ---------------------------------------------------------------------------

describe('buildHomeTab without Chroma URL', () => {
  beforeEach(() => {
    delete process.env.CHROMA_BASE_URL;
  });

  it('includes no Open in Chroma buttons when no chromaUrl on enclaves', () => {
    const view = buildHomeTab(twoEnclaves);
    const actionBlocks = view.blocks.filter((b) => b.type === 'actions');
    expect(actionBlocks.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// buildUnauthenticatedHomeTab
// ---------------------------------------------------------------------------

describe('buildUnauthenticatedHomeTab', () => {
  it('returns a home view type', () => {
    const view = buildUnauthenticatedHomeTab();
    expect(view.type).toBe('home');
  });

  it('has blocks', () => {
    const view = buildUnauthenticatedHomeTab();
    expect(view.blocks.length).toBeGreaterThan(0);
  });

  it('shows welcome header', () => {
    const view = buildUnauthenticatedHomeTab();
    const firstBlock = view.blocks[0] as {
      type: string;
      text: { text: string };
    };
    expect(firstBlock.type).toBe('header');
    expect(firstBlock.text.text).toContain('Welcome to The Kraken');
  });

  it('shows auth prompt text', () => {
    const view = buildUnauthenticatedHomeTab();
    const allText = view.blocks
      .filter((b) => b.type === 'section')
      .map((b) =>
        'text' in b && b.text && typeof b.text !== 'string' && 'text' in b.text
          ? b.text.text
          : '',
      )
      .join(' ');
    expect(allText).toContain('verify your identity');
    expect(allText).toContain('DM');
  });
});
