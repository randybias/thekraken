/**
 * NDJSON protocol layer unit tests.
 *
 * Tests appendNdjson + NdjsonReader for T07 DoD:
 * - Atomic append
 * - Reader returning new records since last read
 * - Missing file handling
 * - Partial lines at EOF
 * - Invalid JSON lines (corruption recovery)
 * - Reader offset reset
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { appendNdjson, NdjsonReader } from '../../src/teams/ndjson.js';

function makeTempDir(): string {
  const dir = join(tmpdir(), `ndjson-test-${process.pid}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const tempDirs: string[] = [];

function tempFile(name = 'test.ndjson'): string {
  const dir = makeTempDir();
  tempDirs.push(dir);
  return join(dir, name);
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
});

describe('appendNdjson', () => {
  it('creates the file and appends a single record', () => {
    const path = tempFile();
    appendNdjson(path, { hello: 'world' });
    const reader = new NdjsonReader(path);
    const records = reader.readNew();
    expect(records).toHaveLength(1);
    expect(records[0]).toEqual({ hello: 'world' });
  });

  it('appends multiple records as separate lines', () => {
    const path = tempFile();
    appendNdjson(path, { n: 1 });
    appendNdjson(path, { n: 2 });
    appendNdjson(path, { n: 3 });
    const reader = new NdjsonReader(path);
    const records = reader.readNew();
    expect(records).toHaveLength(3);
    expect(records[0]).toEqual({ n: 1 });
    expect(records[2]).toEqual({ n: 3 });
  });

  it('preserves nested objects', () => {
    const path = tempFile();
    const rec = { id: 'abc', meta: { type: 'user_message', ts: 12345 } };
    appendNdjson(path, rec);
    const reader = new NdjsonReader(path);
    const [r] = reader.readNew();
    expect(r).toEqual(rec);
  });
});

describe('NdjsonReader', () => {
  it('returns empty array when file does not exist', () => {
    const reader = new NdjsonReader('/tmp/this-file-does-not-exist-kraken-test.ndjson');
    expect(reader.readNew()).toEqual([]);
  });

  it('returns only new records on subsequent reads', () => {
    const path = tempFile();
    appendNdjson(path, { n: 1 });
    const reader = new NdjsonReader(path);

    const first = reader.readNew();
    expect(first).toHaveLength(1);

    appendNdjson(path, { n: 2 });
    const second = reader.readNew();
    expect(second).toHaveLength(1);
    expect(second[0]).toEqual({ n: 2 });
  });

  it('returns empty array when called twice with no new writes', () => {
    const path = tempFile();
    appendNdjson(path, { n: 1 });
    const reader = new NdjsonReader(path);
    reader.readNew();
    expect(reader.readNew()).toEqual([]);
  });

  it('handles partial line at EOF (no trailing newline)', () => {
    const path = tempFile();
    // Write a complete line then a partial line without newline
    writeFileSync(path, '{"n":1}\n{"n":2', 'utf8');
    const reader = new NdjsonReader(path);

    // Should return only the complete first line
    const records = reader.readNew();
    expect(records).toHaveLength(1);
    expect(records[0]).toEqual({ n: 1 });

    // Now complete the partial line
    writeFileSync(path, '{"n":1}\n{"n":2}\n', 'utf8');
    const more = reader.readNew();
    expect(more).toHaveLength(1);
    expect(more[0]).toEqual({ n: 2 });
  });

  it('skips invalid JSON lines and continues reading valid ones', () => {
    const path = tempFile();
    // Write two valid + one invalid line
    writeFileSync(
      path,
      '{"n":1}\nNOT_VALID_JSON\n{"n":3}\n',
      'utf8',
    );
    const reader = new NdjsonReader(path);
    const records = reader.readNew();
    expect(records).toHaveLength(2);
    expect(records[0]).toEqual({ n: 1 });
    expect(records[1]).toEqual({ n: 3 });
  });

  it('returns empty array when file is empty', () => {
    const path = tempFile();
    writeFileSync(path, '', 'utf8');
    const reader = new NdjsonReader(path);
    expect(reader.readNew()).toEqual([]);
  });

  it('reset() allows re-reading from the beginning', () => {
    const path = tempFile();
    appendNdjson(path, { n: 1 });
    appendNdjson(path, { n: 2 });
    const reader = new NdjsonReader(path);

    const first = reader.readNew();
    expect(first).toHaveLength(2);

    reader.reset();
    const replayed = reader.readNew();
    expect(replayed).toHaveLength(2);
    expect(replayed[0]).toEqual({ n: 1 });
  });

  it('offset advances correctly across multiple reads', () => {
    const path = tempFile();
    const reader = new NdjsonReader(path);

    expect(reader.currentOffset).toBe(0);
    appendNdjson(path, { a: 1 });
    reader.readNew();
    expect(reader.currentOffset).toBeGreaterThan(0);

    const offsetAfterFirst = reader.currentOffset;
    appendNdjson(path, { b: 2 });
    reader.readNew();
    expect(reader.currentOffset).toBeGreaterThan(offsetAfterFirst);
  });

  it('handles concurrent appends — reads all records eventually', () => {
    const path = tempFile();
    // Simulate concurrent appends by writing all at once before any read
    for (let i = 0; i < 100; i++) {
      appendNdjson(path, { i });
    }
    const reader = new NdjsonReader(path);
    const records = reader.readNew();
    expect(records).toHaveLength(100);
    for (let i = 0; i < 100; i++) {
      expect((records[i] as { i: number }).i).toBe(i);
    }
  });
});
