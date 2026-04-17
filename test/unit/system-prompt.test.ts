import { describe, it, expect } from 'vitest';
import {
  buildSystemPrompt,
  buildManagerPrompt,
  buildBuilderPrompt,
  buildDeployerPrompt,
} from '../../src/agent/system-prompt.js';

describe('buildSystemPrompt', () => {
  it('returns a non-empty string with all-null inputs (placeholders)', () => {
    const prompt = buildSystemPrompt({
      globalMemory: null,
      enclaveMemory: null,
      skills: null,
    });
    expect(typeof prompt).toBe('string');
    expect(prompt.length).toBeGreaterThan(0);
  });

  it('includes global memory content when provided', () => {
    const prompt = buildSystemPrompt({
      globalMemory: 'GLOBAL_CONTENT',
      enclaveMemory: null,
      skills: null,
    });
    expect(prompt).toContain('GLOBAL_CONTENT');
  });

  it('includes enclave memory content when provided', () => {
    const prompt = buildSystemPrompt({
      globalMemory: null,
      enclaveMemory: 'ENCLAVE_CONTENT',
      skills: null,
    });
    expect(prompt).toContain('ENCLAVE_CONTENT');
  });

  it('includes skills content when provided', () => {
    const prompt = buildSystemPrompt({
      globalMemory: null,
      enclaveMemory: null,
      skills: 'SKILLS_CONTENT',
    });
    expect(prompt).toContain('SKILLS_CONTENT');
  });

  it('layers are separated by --- delimiter', () => {
    const prompt = buildSystemPrompt({
      globalMemory: 'GLOBAL',
      enclaveMemory: 'ENCLAVE',
      skills: 'SKILLS',
    });
    expect(prompt).toContain('\n---\n');
    // Global comes before enclave
    expect(prompt.indexOf('GLOBAL')).toBeLessThan(prompt.indexOf('ENCLAVE'));
    // Enclave comes before skills
    expect(prompt.indexOf('ENCLAVE')).toBeLessThan(prompt.indexOf('SKILLS'));
  });

  it('DM mode: null enclaveMemory omits enclave layer', () => {
    const promptWithEnclave = buildSystemPrompt({
      globalMemory: 'G',
      enclaveMemory: 'ENCLAVE_LAYER',
      skills: 'S',
    });
    const promptDm = buildSystemPrompt({
      globalMemory: 'G',
      enclaveMemory: null,
      skills: 'S',
    });
    expect(promptWithEnclave).toContain('ENCLAVE_LAYER');
    expect(promptDm).not.toContain('ENCLAVE_LAYER');
  });

  it('uses placeholder global memory when globalMemory is null', () => {
    const prompt = buildSystemPrompt({
      globalMemory: null,
      enclaveMemory: null,
      skills: null,
    });
    // Placeholder should mention The Kraken
    expect(prompt).toContain('The Kraken');
  });

  it('uses placeholder skills when skills is null', () => {
    const prompt = buildSystemPrompt({
      globalMemory: 'G',
      enclaveMemory: null,
      skills: null,
    });
    expect(prompt).toContain('Tentacular Skills');
  });
});

// T08: Per-role prompt builder tests

const BASE_ROLE_OPTS = {
  enclaveName: 'marketing-analytics',
  userSlackId: 'U12345',
  userEmail: 'alice@example.com',
};

describe('buildManagerPrompt', () => {
  it('includes enclave name in prompt', () => {
    const prompt = buildManagerPrompt(BASE_ROLE_OPTS);
    expect(prompt).toContain('marketing-analytics');
  });

  it('includes Role: Enclave Manager header', () => {
    const prompt = buildManagerPrompt(BASE_ROLE_OPTS);
    expect(prompt).toContain('Role: Enclave Manager');
  });

  it('includes [CONTEXT] block with user identity (D6)', () => {
    const prompt = buildManagerPrompt(BASE_ROLE_OPTS);
    expect(prompt).toContain('[CONTEXT]');
    expect(prompt).toContain('U12345');
    expect(prompt).toContain('alice@example.com');
    expect(prompt).toContain('[/CONTEXT]');
  });

  it('[CONTEXT] block does NOT contain the token value', () => {
    const prompt = buildManagerPrompt(BASE_ROLE_OPTS);
    // Token is never in the prompt — only the env var name
    expect(prompt).toContain('TNTC_ACCESS_TOKEN');
    // Make sure it does not contain an actual token value
    expect(prompt).not.toContain('eyJ');
    expect(prompt).not.toContain('Bearer ');
  });

  it('includes instruction to fail on expired token (D6)', () => {
    const prompt = buildManagerPrompt(BASE_ROLE_OPTS);
    expect(prompt).toContain('FAIL');
    expect(prompt).toContain('re-auth');
  });

  it('explicitly prohibits service identity fallback (D6)', () => {
    const prompt = buildManagerPrompt(BASE_ROLE_OPTS);
    expect(prompt).toContain('NEVER fall back to a service identity');
  });

  it('includes enclave memory when provided', () => {
    const prompt = buildManagerPrompt({
      ...BASE_ROLE_OPTS,
      enclaveMemory: 'ENCLAVE_DATA',
    });
    expect(prompt).toContain('ENCLAVE_DATA');
  });

  it('uses placeholder enclave memory when not provided', () => {
    const prompt = buildManagerPrompt(BASE_ROLE_OPTS);
    expect(prompt).toContain('Enclave Context');
  });

  it('includes skills when provided', () => {
    const prompt = buildManagerPrompt({
      ...BASE_ROLE_OPTS,
      skills: 'SKILL_DATA',
    });
    expect(prompt).toContain('SKILL_DATA');
  });
});

// C1: Manager decision-tree and role-boundary tests
describe('buildManagerPrompt — decision tree (C1)', () => {
  it('mentions commission_dev_team for build/deploy tasks', () => {
    const prompt = buildManagerPrompt(BASE_ROLE_OPTS);
    expect(prompt).toContain('commission_dev_team');
  });

  it('explicitly states manager never scaffolds or writes code', () => {
    const prompt = buildManagerPrompt(BASE_ROLE_OPTS);
    // Key rule: manager must not use edit/write — those belong to the dev team
    expect(prompt).toContain('never');
    expect(prompt.toLowerCase()).toContain('scaffold');
  });

  it('instructs manager to answer read queries directly without commissioning a team', () => {
    const prompt = buildManagerPrompt(BASE_ROLE_OPTS);
    // Manager handles read/conversational queries in the same turn
    expect(prompt.toLowerCase()).toMatch(/read.*query|conversational|answer.*directly|same turn/i);
  });

  it('instructs manager to commission a dev team for build/deploy tasks without user confirmation', () => {
    const prompt = buildManagerPrompt(BASE_ROLE_OPTS);
    // Per feedback_manager_autonomous_delegation.md: no user confirmation
    expect(prompt.toLowerCase()).toContain('commission');
    // Must not say "ask user" or "confirm with user" for commission decisions
    expect(prompt).not.toMatch(/ask.*user.*before commissioning/i);
    expect(prompt).not.toMatch(/confirm with.*user.*before.*team/i);
  });

  it('lists signals.ndjson in communication protocol', () => {
    const prompt = buildManagerPrompt(BASE_ROLE_OPTS);
    expect(prompt).toContain('signals.ndjson');
  });

  it('explicitly prohibits manager from using edit/write tools', () => {
    const prompt = buildManagerPrompt(BASE_ROLE_OPTS);
    expect(prompt).toContain('NO edit');
  });

  it('instructs manager to read KRAKEN_TOKEN_FILE for fresh token before tntc calls', () => {
    const prompt = buildManagerPrompt(BASE_ROLE_OPTS);
    expect(prompt).toContain('KRAKEN_TOKEN_FILE');
  });
});

describe('buildBuilderPrompt', () => {
  it('includes Role: Builder header', () => {
    const prompt = buildBuilderPrompt({
      ...BASE_ROLE_OPTS,
      taskDescription: 'Write a tentacle',
    });
    expect(prompt).toContain('Role: Builder');
  });

  it('includes the task description', () => {
    const prompt = buildBuilderPrompt({
      ...BASE_ROLE_OPTS,
      taskDescription: 'Build the sentiment analysis pipeline',
    });
    expect(prompt).toContain('Build the sentiment analysis pipeline');
  });

  it('includes enclave name', () => {
    const prompt = buildBuilderPrompt({
      ...BASE_ROLE_OPTS,
      taskDescription: 'task',
    });
    expect(prompt).toContain('marketing-analytics');
  });

  it('includes [CONTEXT] block with user identity (D6)', () => {
    const prompt = buildBuilderPrompt({
      ...BASE_ROLE_OPTS,
      taskDescription: 'task',
    });
    expect(prompt).toContain('[CONTEXT]');
    expect(prompt).toContain('U12345');
    expect(prompt).toContain('alice@example.com');
    expect(prompt).toContain('[/CONTEXT]');
  });

  it('mentions edit/write tools as available', () => {
    const prompt = buildBuilderPrompt({
      ...BASE_ROLE_OPTS,
      taskDescription: 'task',
    });
    expect(prompt).toContain('edit');
    expect(prompt).toContain('write');
  });
});

describe('buildDeployerPrompt', () => {
  it('includes Role: Deployer header', () => {
    const prompt = buildDeployerPrompt({
      ...BASE_ROLE_OPTS,
      taskDescription: 'Deploy v4',
    });
    expect(prompt).toContain('Role: Deployer');
  });

  it('includes the task description', () => {
    const prompt = buildDeployerPrompt({
      ...BASE_ROLE_OPTS,
      taskDescription: 'Deploy tentacle version 4 to production',
    });
    expect(prompt).toContain('Deploy tentacle version 4 to production');
  });

  it('includes [CONTEXT] block with user identity (D6)', () => {
    const prompt = buildDeployerPrompt({
      ...BASE_ROLE_OPTS,
      taskDescription: 'Deploy v4',
    });
    expect(prompt).toContain('[CONTEXT]');
    expect(prompt).toContain('U12345');
    expect(prompt).toContain('[/CONTEXT]');
  });

  it('includes tntc deploy and wf_apply in deploy flow', () => {
    const prompt = buildDeployerPrompt({
      ...BASE_ROLE_OPTS,
      taskDescription: 'task',
    });
    expect(prompt).toContain('tntc deploy');
    expect(prompt).toContain('wf_apply');
  });

  it('explicitly says NO edit/write tools', () => {
    const prompt = buildDeployerPrompt({
      ...BASE_ROLE_OPTS,
      taskDescription: 'task',
    });
    expect(prompt).toContain('NO edit, write tools');
  });
});
