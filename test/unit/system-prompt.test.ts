import { describe, it, expect } from 'vitest';
import { buildSystemPrompt } from '../../src/agent/system-prompt.js';

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
    expect(prompt).toContain('Placeholder');
  });
});
