import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createDatabase } from '../../../src/db/migrations.js';
import {
  recordKrakenThread,
  isKrakenThread,
  pruneOldKrakenThreads,
} from '../../../src/db/kraken-threads.js';

describe('kraken-threads helpers', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = createDatabase(':memory:');
  });

  it('record + lookup roundtrip', () => {
    recordKrakenThread(db, 'C123', 'T123.456');
    expect(isKrakenThread(db, 'C123', 'T123.456')).toBe(true);
    expect(isKrakenThread(db, 'C123', 'OTHER')).toBe(false);
    expect(isKrakenThread(db, 'OTHER', 'T123.456')).toBe(false);
  });

  it('record is idempotent on the same (channel,thread)', () => {
    recordKrakenThread(db, 'C1', 'T1');
    recordKrakenThread(db, 'C1', 'T1');
    const row = db
      .prepare(
        'SELECT COUNT(*) AS n FROM kraken_threads WHERE channel_id=? AND thread_ts=?',
      )
      .get('C1', 'T1') as { n: number };
    expect(row.n).toBe(1);
  });

  it('pruneOldKrakenThreads removes rows older than maxAgeSeconds', () => {
    const nowSec = Math.floor(Date.now() / 1000);
    db.prepare(
      'INSERT INTO kraken_threads (channel_id, thread_ts, created_at) VALUES (?, ?, ?)',
    ).run('OLD', 'T-OLD', nowSec - 10 * 24 * 3600); // 10 days old
    db.prepare(
      'INSERT INTO kraken_threads (channel_id, thread_ts, created_at) VALUES (?, ?, ?)',
    ).run('NEW', 'T-NEW', nowSec - 1 * 3600); // 1 hour old
    pruneOldKrakenThreads(db, 7 * 24 * 3600);
    expect(isKrakenThread(db, 'OLD', 'T-OLD')).toBe(false);
    expect(isKrakenThread(db, 'NEW', 'T-NEW')).toBe(true);
  });
});
