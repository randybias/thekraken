import { describe, it, expect } from 'vitest';
import type { ScenarioDef } from '../../e2e-slack/scenarios.js';

describe('ScenarioDef.chromaAssertion (chroma E2E platform tests)', () => {
  it('field is optional on ScenarioDef', () => {
    const s: ScenarioDef = {
      id: 'X',
      name: 'x',
      channel: 'C',
      message: '@Kraken hi',
    };
    expect(s.chromaAssertion).toBeUndefined();
  });

  it('field accepts path + expectText + forbiddenText + timeoutMs + pollMs', () => {
    const s: ScenarioDef = {
      id: 'X',
      name: 'x',
      channel: 'C',
      message: '@Kraken hi',
      chromaAssertion: {
        path: '/enclaves/<TEST_ENCLAVE>',
        expectText: ['hello'],
        forbiddenText: [/error/i],
        timeoutMs: 30_000,
        pollMs: 2_000,
      },
    };
    expect(s.chromaAssertion?.path).toBe('/enclaves/<TEST_ENCLAVE>');
    expect(s.chromaAssertion?.timeoutMs).toBe(30_000);
    expect(s.chromaAssertion?.pollMs).toBe(2_000);
  });

  it('E2 scenario has chromaAssertion pointing at /enclaves/<TEST_ENCLAVE>', async () => {
    const { PROVISIONING_SCENARIOS } =
      await import('../../e2e-slack/scenarios.js');
    const e2 = PROVISIONING_SCENARIOS.find((s) => s.id === 'E2');
    expect(e2).toBeDefined();
    expect(e2?.chromaAssertion?.path).toBe('/enclaves/<TEST_ENCLAVE>');
    expect(e2?.chromaAssertion?.expectText).toBeDefined();
  });

  it('E5 scenario has chromaAssertion checking / for missing enclave', async () => {
    const { PROVISIONING_SCENARIOS } =
      await import('../../e2e-slack/scenarios.js');
    const e5 = PROVISIONING_SCENARIOS.find((s) => s.id === 'E5');
    expect(e5).toBeDefined();
    expect(e5?.chromaAssertion?.path).toBe('/');
    expect(e5?.chromaAssertion?.forbiddenText).toBeDefined();
  });

  it('F1 scenario has chromaAssertion on tentacle path', async () => {
    const { TENTACLE_SCENARIOS } = await import('../../e2e-slack/scenarios.js');
    const f1 = TENTACLE_SCENARIOS.find((s) => s.id === 'F1');
    expect(f1).toBeDefined();
    expect(f1?.chromaAssertion?.path).toBe(
      '/enclaves/<TEST_ENCLAVE>/workflows/hello-world',
    );
  });

  it('F10 scenario has chromaAssertion checking tentacles list for absence', async () => {
    const { TENTACLE_SCENARIOS } = await import('../../e2e-slack/scenarios.js');
    const f10 = TENTACLE_SCENARIOS.find((s) => s.id === 'F10');
    expect(f10).toBeDefined();
    expect(f10?.chromaAssertion?.path).toBe(
      '/enclaves/<TEST_ENCLAVE>/tentacles',
    );
    expect(f10?.chromaAssertion?.forbiddenText).toBeDefined();
  });
});
