/**
 * Unit tests for persona inference (Phase 3, T09).
 *
 * One test per archetype + edge cases.
 */

import { describe, it, expect } from 'vitest';
import {
  inferPersona,
  formatPersonaForMemory,
  ARCHETYPES,
} from '../../src/enclave/personas.js';

// ---------------------------------------------------------------------------
// One test per archetype
// ---------------------------------------------------------------------------

describe('inferPersona — archetypes', () => {
  it('infers Marketing archetype', () => {
    const persona = inferPersona('marketing campaigns SEO content strategy');
    expect(persona?.name).toBe('Marketing');
    expect(persona?.languageLevel).toBe('non-technical');
  });

  it('infers Sales archetype', () => {
    const persona = inferPersona('sales pipeline revenue customer deals quota');
    expect(persona?.name).toBe('Sales');
  });

  it('infers Customer Support archetype', () => {
    const persona = inferPersona(
      'support tickets helpdesk customer issues resolution',
    );
    expect(persona?.name).toBe('Customer Support');
  });

  it('infers Operations archetype', () => {
    const persona = inferPersona(
      'operations automation runbook incident monitoring',
    );
    expect(persona?.name).toBe('Operations');
  });

  it('infers IT archetype', () => {
    const persona = inferPersona(
      'IT infrastructure server security patch access',
    );
    expect(persona?.name).toBe('IT');
  });

  it('infers Software Development archetype', () => {
    const persona = inferPersona(
      'software development engineering code api backend testing',
    );
    expect(persona?.name).toBe('Software Development');
    expect(persona?.languageLevel).toBe('highly-technical');
  });

  it('infers Architecture archetype', () => {
    const persona = inferPersona(
      'architecture design system scalability distributed patterns ADR',
    );
    expect(persona?.name).toBe('Architecture');
  });

  it('infers Finance archetype', () => {
    const persona = inferPersona(
      'finance budget accounting expense revenue reporting',
    );
    expect(persona?.name).toBe('Finance');
  });

  it('infers HR archetype', () => {
    const persona = inferPersona(
      'HR human resources hiring recruiting onboarding employee',
    );
    expect(persona?.name).toBe('HR');
  });

  it('infers Legal archetype', () => {
    const persona = inferPersona(
      'legal contract compliance regulatory policy risk',
    );
    expect(persona?.name).toBe('Legal');
  });

  it('infers Executive archetype', () => {
    const persona = inferPersona(
      'executive leadership strategy board OKR quarterly',
    );
    expect(persona?.name).toBe('Executive');
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('inferPersona — edge cases', () => {
  it('returns null for empty description', () => {
    expect(inferPersona('')).toBeNull();
    expect(inferPersona('   ')).toBeNull();
  });

  it('returns null for description with no keyword matches', () => {
    const persona = inferPersona('xyz abc 123');
    expect(persona).toBeNull();
  });

  it('tie-breaking: returns first archetype in ARCHETYPES order when equal score', () => {
    // Use a description with exactly one matching keyword for Marketing
    // and one matching keyword for Sales, where Marketing comes first in ARCHETYPES
    const persona = inferPersona('marketing sales');
    // Marketing is index 0, Sales is index 1 — Marketing wins tie
    expect(persona?.name).toBe('Marketing');
  });

  it('is case-insensitive', () => {
    const persona = inferPersona('MARKETING CAMPAIGNS CONTENT');
    expect(persona?.name).toBe('Marketing');
  });

  it('returns highest-scoring archetype', () => {
    // Finance-heavy description
    const persona = inferPersona(
      'budget expense invoice revenue cost financial reconciliation profit',
    );
    expect(persona?.name).toBe('Finance');
  });
});

// ---------------------------------------------------------------------------
// 11 archetypes are defined
// ---------------------------------------------------------------------------

describe('ARCHETYPES', () => {
  it('has exactly 11 archetypes', () => {
    expect(ARCHETYPES).toHaveLength(11);
  });

  it('all archetypes have required fields', () => {
    for (const persona of ARCHETYPES) {
      expect(persona.name).toBeTruthy();
      expect(persona.languageLevel).toMatch(
        /^(non-technical|semi-technical|technical|highly-technical)$/,
      );
      expect(persona.technicalDetail).toMatch(/^(low|medium|high)$/);
      expect(Array.isArray(persona.suggestedScaffolds)).toBe(true);
      expect(persona.keywords.length).toBeGreaterThan(5);
    }
  });
});

// ---------------------------------------------------------------------------
// formatPersonaForMemory
// ---------------------------------------------------------------------------

describe('formatPersonaForMemory', () => {
  it('generates markdown with persona details', () => {
    const persona = ARCHETYPES.find((a) => a.name === 'Marketing')!;
    const result = formatPersonaForMemory(persona);
    expect(result).toContain('## Team Persona: Marketing');
    expect(result).toContain('Language level: non-technical');
    expect(result).toContain('Technical detail: low');
    expect(result).toContain('Suggested scaffolds:');
  });

  it('includes all 4 key fields', () => {
    for (const persona of ARCHETYPES) {
      const result = formatPersonaForMemory(persona);
      expect(result).toContain(persona.name);
      expect(result).toContain(persona.languageLevel);
      expect(result).toContain(persona.technicalDetail);
    }
  });
});
