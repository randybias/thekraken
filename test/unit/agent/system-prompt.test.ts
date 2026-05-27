/**
 * v0.10.3 manager-prompt contract tests.
 *
 * Covers the four rules added/tightened after the eastus
 * voyager-agentic-flows incident on 2026-05-27:
 *
 * C: Serialize commission_dev_team per enclave
 * D: Typo confirmation before commissioning a new tentacle
 * E: "Done" contract — task_completed signal, not tntc deploy exit 0
 * F: Error messages cite EXACT declared dependency, never invented alternatives
 */

import { describe, it, expect } from 'vitest';
import { buildManagerPrompt } from '../../../src/agent/system-prompt.js';

const BASE_OPTS = {
  enclaveName: 'test',
  userSlackId: 'U1',
  userEmail: 'a@b.c',
};

describe('manager prompt v0.10.3 contracts', () => {
  const prompt = buildManagerPrompt(BASE_OPTS);

  it('C: forbids concurrent dev team commissions per enclave', () => {
    expect(prompt).toMatch(/ONE dev team at a time per enclave/i);
    // The phrase spans across a line break in the prompt — use \s+ to match
    expect(prompt).toMatch(
      /commission_dev_team[\s\S]{0,20}signal without a matching task_completed/i,
    );
  });

  it('C: instructs manager to check signals-in for in-flight tasks before commissioning', () => {
    expect(prompt).toContain('signals-in.ndjson');
    expect(prompt).toMatch(/in flight/i);
  });

  it('C: forbids triggering wf_run while a commission is in flight', () => {
    // The phrase spans a line break: "commission_dev_team is in\n  flight"
    expect(prompt).toMatch(
      /do NOT trigger wf_run while a commission_dev_team is in[\s\S]{0,10}flight/i,
    );
  });

  it('D: requires confirming likely typos before commissioning', () => {
    expect(prompt).toMatch(/typo of a common word/i);
    expect(prompt).toMatch(/did you mean/i);
  });

  it('D: gives examples of typos to check for', () => {
    // factor→factory is the canonical example from the incident
    expect(prompt).toMatch(/factor.*factory/i);
  });

  it('D: instructs manager not to second-guess intentional shortenings', () => {
    expect(prompt).toMatch(/intentional shortenings/i);
  });

  it('E: forbids saying Done before task_completed signal', () => {
    expect(prompt).toMatch(
      /task_completed signal \(NOT just `tntc deploy` returning 0\)/,
    );
  });

  it('E: says task_completed in signals-in is the authoritative source', () => {
    // The phrase spans a line break — match across whitespace
    expect(prompt).toMatch(
      /signals-in\.ndjson is the[\s\S]{0,10}authoritative source/i,
    );
  });

  it('E: defines partial-success wording for runs with internal errors', () => {
    expect(prompt).toMatch(/partial success/i);
  });

  it('F: forbids inventing alternate providers in error messages', () => {
    expect(prompt).toMatch(/NEVER invent alternatives/i);
  });

  it('F: gives a BAD example showing invented alternative provider', () => {
    // The prompt must show "openai.api_key" as the BAD example
    expect(prompt).toContain('openai.api_key');
    expect(prompt).toMatch(/BAD:/);
  });

  it('F: instructs manager to ask user to describe tentacle if dep list unknown', () => {
    expect(prompt).toMatch(/@kraken describe/i);
  });
});
