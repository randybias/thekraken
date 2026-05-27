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

  it('G: requires LLM provider/model/api-key elicitation before commissioning', () => {
    expect(prompt).toMatch(/LLM provider/i);
    expect(prompt).toMatch(/LLM_DEFAULT_MODEL/);
    expect(prompt).toMatch(/api key source/i);
    expect(prompt).toMatch(/scaffold defaults are NOT a substitute/i);
  });

  it('H: forbids defaulting to gpt-4o or arbitrary models without user input', () => {
    expect(prompt).toMatch(
      /Never default to "gpt-4o"|never default to.*gpt-4o/i,
    );
    expect(prompt).toMatch(/model choices belong to the user/i);
  });
});

describe('manager prompt v0.10.4 contracts', () => {
  const prompt = buildManagerPrompt(BASE_OPTS);

  // Fix I: Status replies must poll ground truth
  it('I: requires polling signals-in.ndjson before composing a status reply', () => {
    expect(prompt).toMatch(/Status replies must poll ground truth/i);
    expect(prompt).toMatch(/signals-in\.ndjson[\s\S]{0,100}task_completed/);
  });

  it('I: requires calling wf_status on the tentacle being built', () => {
    expect(prompt).toMatch(/Call wf_status on the tentacle being built/i);
  });

  it('I: requires calling wf_logs before composing status reply', () => {
    expect(prompt).toMatch(/Call wf_logs on the tentacle/i);
  });

  it('I: forbids saying "still running" when signals-in is silent for >2 min', () => {
    expect(prompt).toMatch(
      /Never say "still running" if[\s\S]{0,60}signals-in\.ndjson is silent/i,
    );
  });

  it('I: instructs manager to say it cannot determine ground truth rather than confabulate', () => {
    // The phrase spans a line break — use [\s\S] to match across lines
    expect(prompt).toMatch(/I can't see what's[\s\S]{0,20}happening/i);
    expect(prompt).toMatch(/wf_describe \+ enclave_info/i);
  });

  // Fix J: Silent failure detection
  it('J: defines silent failure as no progress_update in >2 minutes', () => {
    expect(prompt).toMatch(/Silent failure detection/i);
    expect(prompt).toMatch(/no progress_update in the last 2 minutes/i);
  });

  it('J: forbids reporting as "still working" after 2-min signal gap', () => {
    expect(prompt).toMatch(/Do NOT report it as "still working"/i);
    expect(prompt).toMatch(/confabulating[\s\S]{0,30}lack of evidence/i);
  });

  it('J: instructs manager to surface wf_logs verbatim on silent failure', () => {
    expect(prompt).toMatch(/logs show an error, surface[\s\S]{0,20}verbatim/i);
  });

  it('J: instructs manager to say "logs are silent" when logs are empty', () => {
    expect(prompt).toMatch(
      /logs are silent — dev[\s\S]{0,30}subprocess may have died/i,
    );
  });

  // Fix K bonus: lifecycle no-quiesce reminder in manager prompt
  it("K: tells manager it won't be timed out mid-job due to no-quiesce protection", () => {
    expect(prompt).toMatch(/dispatcher will keep this team subprocess alive/i);
    expect(prompt).toMatch(/won't be timed out mid-job/i);
  });

  it('K: instructs manager to emit heartbeat records every ~60s while a job is in flight', () => {
    expect(prompt).toMatch(
      /emit progress_update or[\s\S]{0,30}heartbeat outbound records every ~60s/i,
    );
  });
});
