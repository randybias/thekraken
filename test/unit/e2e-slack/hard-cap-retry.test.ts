import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { HARD_CAP_MS, SCENARIO_RETRIES } from '../../e2e-slack/harness.js';

describe('hard cap + retry env config', () => {
  let origCap: string | undefined;
  let origRetries: string | undefined;

  beforeEach(() => {
    origCap = process.env['KRAKEN_E2E_HARD_CAP_MS'];
    origRetries = process.env['KRAKEN_E2E_RETRIES'];
  });

  afterEach(() => {
    if (origCap === undefined) delete process.env['KRAKEN_E2E_HARD_CAP_MS'];
    else process.env['KRAKEN_E2E_HARD_CAP_MS'] = origCap;
    if (origRetries === undefined) delete process.env['KRAKEN_E2E_RETRIES'];
    else process.env['KRAKEN_E2E_RETRIES'] = origRetries;
  });

  it('HARD_CAP_MS defaults to 10 minutes', () => {
    expect(HARD_CAP_MS).toBe(10 * 60 * 1000);
  });

  it('SCENARIO_RETRIES defaults to 1', () => {
    expect(SCENARIO_RETRIES).toBe(1);
  });
});
