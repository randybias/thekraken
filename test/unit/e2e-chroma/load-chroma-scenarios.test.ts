import { describe, it, expect } from 'vitest';
import { loadChromaScenarios } from '../../e2e-chroma/load-chroma-scenarios.js';

describe('loadChromaScenarios', () => {
  it('returns CHROMA_SCENARIOS array when sibling checkout has the file', async () => {
    const scenarios = await loadChromaScenarios();
    expect(Array.isArray(scenarios)).toBe(true);
    // Sibling tentacular-chroma is checked out at ../tentacular-chroma
    // and exports CHROMA-SMOKE-1 (created in Task 4).
    expect(scenarios.find((s) => s.id === 'CHROMA-SMOKE-1')).toBeDefined();
  });

  it('returns empty array when siblingPath does not exist', async () => {
    const scenarios = await loadChromaScenarios({
      siblingPath: '/nonexistent/path/to/chroma',
    });
    expect(scenarios).toEqual([]);
  });

  it('default siblingPath resolves to ../tentacular-chroma relative to this module', async () => {
    // Implicit test: previous test relies on default resolution. If it
    // works, the path is correct.
    const scenarios = await loadChromaScenarios();
    expect(scenarios.length).toBeGreaterThan(0);
  });
});
