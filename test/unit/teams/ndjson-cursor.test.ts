import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, appendFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { NdjsonReader } from '../../../src/teams/ndjson.js';

describe('NdjsonReader cursor persistence (rc.13)', () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ndjson-cursor-'));
    path = join(dir, 'records.ndjson');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('initialOffset resumes mid-file', () => {
    appendFileSync(path, '{"a":1}\n{"b":2}\n{"c":3}\n');
    const offset = '{"a":1}\n'.length;
    const reader = new NdjsonReader(path, { initialOffset: offset });
    const records = reader.readNew();
    expect(records).toEqual([{ b: 2 }, { c: 3 }]);
  });

  it('persistOffset is called after readNew advances offset', () => {
    appendFileSync(path, '{"a":1}\n');
    const persisted: number[] = [];
    const reader = new NdjsonReader(path, {
      persistOffset: (n) => persisted.push(n),
    });
    reader.readNew();
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toBe(statSync(path).size);
  });

  it('persistOffset is called once per readNew that has new bytes', () => {
    appendFileSync(path, '{"a":1}\n');
    const persisted: number[] = [];
    const reader = new NdjsonReader(path, {
      persistOffset: (n) => persisted.push(n),
    });
    reader.readNew();
    expect(persisted).toHaveLength(1);

    // No new bytes — readNew is a no-op
    reader.readNew();
    expect(persisted).toHaveLength(1);

    // New bytes — readNew advances + persists
    appendFileSync(path, '{"b":2}\n');
    reader.readNew();
    expect(persisted).toHaveLength(2);
    expect(persisted[1]).toBe(statSync(path).size);
  });

  it('initialOffset takes precedence over startAtEnd', () => {
    appendFileSync(path, '{"a":1}\n{"b":2}\n');
    const reader = new NdjsonReader(path, {
      initialOffset: 0,
      startAtEnd: true,
    });
    const records = reader.readNew();
    expect(records).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it('default behavior (no opts) reads from beginning', () => {
    appendFileSync(path, '{"a":1}\n');
    const reader = new NdjsonReader(path);
    expect(reader.readNew()).toEqual([{ a: 1 }]);
  });
});
