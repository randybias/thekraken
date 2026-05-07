import { describe, it, expect } from 'vitest';
import { createDatabase } from '../../../src/db/migrations.js';

describe('ndjson_cursors schema (rc.13)', () => {
  it('table exists after applyMigrations', () => {
    const db = createDatabase(':memory:');
    const row = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='ndjson_cursors'",
      )
      .get();
    expect(row).toBeDefined();
  });

  it('UPSERT works on (enclave_name, filename) primary key', () => {
    const db = createDatabase(':memory:');
    db.prepare(
      `INSERT INTO ndjson_cursors (enclave_name, filename, byte_offset)
       VALUES (?, ?, ?)
       ON CONFLICT (enclave_name, filename) DO UPDATE SET byte_offset = excluded.byte_offset`,
    ).run('e', 'mailbox.ndjson', 100);
    db.prepare(
      `INSERT INTO ndjson_cursors (enclave_name, filename, byte_offset)
       VALUES (?, ?, ?)
       ON CONFLICT (enclave_name, filename) DO UPDATE SET byte_offset = excluded.byte_offset`,
    ).run('e', 'mailbox.ndjson', 250);
    const row = db
      .prepare(
        'SELECT byte_offset FROM ndjson_cursors WHERE enclave_name = ? AND filename = ?',
      )
      .get('e', 'mailbox.ndjson') as { byte_offset: number };
    expect(row.byte_offset).toBe(250);
  });
});
