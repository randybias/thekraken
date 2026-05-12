import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadChromaScenarios } from '../../e2e-chroma/load-chroma-scenarios.js';

// The sibling tentacular-chroma checkout is only present in developer
// workspaces (and in repos that explicitly check it out alongside).
// In thekraken's own CI it is absent, so the sibling-dependent assertions
// must be skipped instead of failed.
const HERE = dirname(fileURLToPath(import.meta.url));
const SIBLING = resolve(HERE, '../../../../tentacular-chroma');
const HAS_SIBLING = existsSync(SIBLING);

describe('loadChromaScenarios', () => {
  it.skipIf(!HAS_SIBLING)(
    'returns CHROMA_SCENARIOS array when sibling checkout has the file',
    async () => {
      const scenarios = await loadChromaScenarios();
      expect(Array.isArray(scenarios)).toBe(true);
      expect(scenarios.find((s) => s.id === 'CHROMA-SMOKE-1')).toBeDefined();
    },
  );

  it('returns empty array when siblingPath does not exist', async () => {
    const scenarios = await loadChromaScenarios({
      siblingPath: '/nonexistent/path/to/chroma',
    });
    expect(scenarios).toEqual([]);
  });

  it.skipIf(!HAS_SIBLING)(
    'default siblingPath resolves to ../tentacular-chroma relative to this module',
    async () => {
      const scenarios = await loadChromaScenarios();
      expect(scenarios.length).toBeGreaterThan(0);
    },
  );
});
