/**
 * Tests for describe_change and record_change_summary internal-ops (G4.3).
 *
 * describe_change:
 *   - Cache hit: returns {cached: true, summary} from change_summaries table.
 *   - Cache miss: returns {cached: false, diff} by calling the git differ.
 *
 * record_change_summary:
 *   - Persists manager-composed summary into change_summaries table.
 *   - Subsequent describe_change call returns cached result.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createDatabase } from '../../src/db/migrations.js';
import {
  describeChange,
  recordChangeSummary,
} from '../../src/dispatcher/internal-ops.js';
import type { GitDiffer } from '../../src/dispatcher/internal-ops.js';
import type Database from 'better-sqlite3';

let db: Database.Database;

/** A no-op git differ that should not be called on cache hits. */
const fakeGitDiffer: GitDiffer = {
  diff: async (_a: string, _b: string) => {
    throw new Error('git differ should not be called on cache hit');
  },
};

/** Seed a cache row directly. */
function seedChangeSummaryCache(
  targetDb: Database.Database,
  shaA: string,
  shaB: string,
  summary: string,
): void {
  targetDb
    .prepare(
      `INSERT INTO change_summaries (sha_a, sha_b, summary) VALUES (?, ?, ?)`,
    )
    .run(shaA, shaB, summary);
}

beforeEach(() => {
  db = createDatabase(':memory:');
});

describe('describe_change', () => {
  it('returns cached summary on second call (cache hit)', async () => {
    seedChangeSummaryCache(db, 'abc1234', 'def5678', 'cached summary text');

    const result = await describeChange(db, fakeGitDiffer, {
      shaA: 'abc1234',
      shaB: 'def5678',
    });

    expect(result.cached).toBe(true);
    expect(result.summary).toBe('cached summary text');
    expect(result.diff).toBeUndefined();
  });

  it('returns the diff for the manager to summarize on cache miss', async () => {
    const differ: GitDiffer = {
      diff: async (_a: string, _b: string) =>
        `--- a/x\n+++ b/x\n@@\n-foo\n+bar`,
    };

    const result = await describeChange(db, differ, {
      shaA: 'abc1234',
      shaB: 'def5678',
    });

    expect(result.cached).toBe(false);
    expect(result.diff).toContain('-foo');
    expect(result.diff).toContain('+bar');
    expect(result.summary).toBeUndefined();
  });

  it('returns empty diff string when differ returns empty', async () => {
    const differ: GitDiffer = {
      diff: async () => '',
    };

    const result = await describeChange(db, differ, {
      shaA: 'abc1234',
      shaB: 'def5678',
    });

    expect(result.cached).toBe(false);
    expect(result.diff).toBe('');
  });
});

describe('record_change_summary', () => {
  it('records a manager-composed summary', async () => {
    await recordChangeSummary(db, {
      shaA: 'abc1234',
      shaB: 'def5678',
      summary: 'title length grew from 50 to 80',
    });

    const result = await describeChange(db, fakeGitDiffer, {
      shaA: 'abc1234',
      shaB: 'def5678',
    });

    expect(result.cached).toBe(true);
    expect(result.summary).toBe('title length grew from 50 to 80');
  });

  it('is idempotent — second record with same key replaces the first', async () => {
    await recordChangeSummary(db, {
      shaA: 'abc1234',
      shaB: 'def5678',
      summary: 'first summary',
    });
    await recordChangeSummary(db, {
      shaA: 'abc1234',
      shaB: 'def5678',
      summary: 'updated summary',
    });

    const result = await describeChange(db, fakeGitDiffer, {
      shaA: 'abc1234',
      shaB: 'def5678',
    });

    expect(result.cached).toBe(true);
    expect(result.summary).toBe('updated summary');
  });
});
