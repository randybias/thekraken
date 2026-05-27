import { describe, it, expect } from 'vitest';
import { createDatabase } from '../../../src/db/migrations.js';

describe('SCHEMA_V4: kraken_threads', () => {
  it('creates kraken_threads table on fresh init', () => {
    const db = createDatabase(':memory:');
    const row = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='kraken_threads'",
      )
      .get() as { name: string } | undefined;
    expect(row?.name).toBe('kraken_threads');
    db.close();
  });

  it('table has expected columns', () => {
    const db = createDatabase(':memory:');
    const cols = db
      .prepare("PRAGMA table_info('kraken_threads')")
      .all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name).sort();
    expect(names).toEqual(['channel_id', 'created_at', 'thread_ts']);
    db.close();
  });

  it('primary key is (channel_id, thread_ts)', () => {
    const db = createDatabase(':memory:');
    db.prepare(
      "INSERT INTO kraken_threads (channel_id, thread_ts, created_at) VALUES ('C1','T1', 1)",
    ).run();
    expect(() =>
      db
        .prepare(
          "INSERT INTO kraken_threads (channel_id, thread_ts, created_at) VALUES ('C1','T1', 2)",
        )
        .run(),
    ).toThrow(/UNIQUE constraint/);
    db.close();
  });
});
