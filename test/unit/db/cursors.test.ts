import { describe, it, expect, beforeEach } from 'vitest';
import { createDatabase } from '../../../src/db/migrations.js';
import {
  initCursorStore,
  getCursor,
  setCursor,
  deleteCursor,
} from '../../../src/db/cursors.js';

describe('cursors store', () => {
  beforeEach(() => {
    initCursorStore(createDatabase(':memory:'));
  });

  it('returns 0 for unknown (enclave, file)', () => {
    expect(getCursor('e', 'mailbox.ndjson')).toBe(0);
  });

  it('persists and reads back', () => {
    setCursor('e', 'mailbox.ndjson', 100);
    expect(getCursor('e', 'mailbox.ndjson')).toBe(100);
  });

  it('UPSERT on subsequent set', () => {
    setCursor('e', 'mailbox.ndjson', 100);
    setCursor('e', 'mailbox.ndjson', 200);
    expect(getCursor('e', 'mailbox.ndjson')).toBe(200);
  });

  it('different files do not collide', () => {
    setCursor('e', 'mailbox.ndjson', 100);
    setCursor('e', 'outbound.ndjson', 999);
    expect(getCursor('e', 'mailbox.ndjson')).toBe(100);
    expect(getCursor('e', 'outbound.ndjson')).toBe(999);
  });

  it('different enclaves do not collide', () => {
    setCursor('e1', 'mailbox.ndjson', 100);
    setCursor('e2', 'mailbox.ndjson', 200);
    expect(getCursor('e1', 'mailbox.ndjson')).toBe(100);
    expect(getCursor('e2', 'mailbox.ndjson')).toBe(200);
  });

  it('deleteCursor with filename removes one (enclave, file)', () => {
    setCursor('e', 'mailbox.ndjson', 100);
    setCursor('e', 'outbound.ndjson', 999);
    deleteCursor('e', 'mailbox.ndjson');
    expect(getCursor('e', 'mailbox.ndjson')).toBe(0);
    expect(getCursor('e', 'outbound.ndjson')).toBe(999);
  });

  it('deleteCursor without filename removes all rows for the enclave', () => {
    setCursor('e', 'mailbox.ndjson', 100);
    setCursor('e', 'outbound.ndjson', 999);
    setCursor('other', 'mailbox.ndjson', 50);
    deleteCursor('e');
    expect(getCursor('e', 'mailbox.ndjson')).toBe(0);
    expect(getCursor('e', 'outbound.ndjson')).toBe(0);
    expect(getCursor('other', 'mailbox.ndjson')).toBe(50);
  });
});
