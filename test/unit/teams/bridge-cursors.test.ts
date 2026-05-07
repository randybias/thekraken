/**
 * Functional test of the cursor wiring used by TeamBridge.
 *
 * The full TeamBridge has many subprocess-spawn dependencies. This test
 * exercises the reader-cursor pattern in isolation, confirming that the
 * data-loss bug from rc.11/rc.12 (startAtEnd dropping queued records on
 * restart) is fixed.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createDatabase } from '../../../src/db/migrations.js';
import {
  initCursorStore,
  getCursor,
  setCursor,
} from '../../../src/db/cursors.js';
import { NdjsonReader } from '../../../src/teams/ndjson.js';

describe('bridge readers with cursor store (rc.13)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bridge-cursors-'));
    initCursorStore(createDatabase(':memory:'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('first reader processes from offset 0; second reader resumes from cursor', () => {
    const path = join(dir, 'mailbox.ndjson');
    appendFileSync(path, '{"a":1}\n{"b":2}\n');

    const enclave = 'e';
    const r1 = new NdjsonReader(path, {
      initialOffset: getCursor(enclave, 'mailbox.ndjson'),
      persistOffset: (off) => setCursor(enclave, 'mailbox.ndjson', off),
    });
    expect(r1.readNew()).toEqual([{ a: 1 }, { b: 2 }]);

    appendFileSync(path, '{"c":3}\n');

    // Simulate a fresh process — re-create reader, cursor restores.
    const r2 = new NdjsonReader(path, {
      initialOffset: getCursor(enclave, 'mailbox.ndjson'),
      persistOffset: (off) => setCursor(enclave, 'mailbox.ndjson', off),
    });
    expect(r2.readNew()).toEqual([{ c: 3 }]);
  });

  it('records appended while the bridge was down are NOT lost on restart', () => {
    const path = join(dir, 'signals-in.ndjson');
    appendFileSync(path, '{"id":"a"}\n');

    const enclave = 'e';
    const r1 = new NdjsonReader(path, {
      initialOffset: getCursor(enclave, 'signals-in.ndjson'),
      persistOffset: (off) => setCursor(enclave, 'signals-in.ndjson', off),
    });
    expect(r1.readNew()).toEqual([{ id: 'a' }]);

    // Simulate pod down: records get appended to the PVC file while
    // the bridge is not running.
    appendFileSync(path, '{"id":"b"}\n{"id":"c"}\n');

    // Pod back up — fresh reader.
    const r2 = new NdjsonReader(path, {
      initialOffset: getCursor(enclave, 'signals-in.ndjson'),
      persistOffset: (off) => setCursor(enclave, 'signals-in.ndjson', off),
    });
    // CRITICAL: records appended while the pod was down ARE caught up.
    expect(r2.readNew()).toEqual([{ id: 'b' }, { id: 'c' }]);
  });

  it("per-(enclave, file) isolation: one bridge does not consume another's records", () => {
    const e1Path = join(dir, 'e1-mailbox.ndjson');
    const e2Path = join(dir, 'e2-mailbox.ndjson');
    appendFileSync(e1Path, '{"x":1}\n');
    appendFileSync(e2Path, '{"y":1}\n');

    const e1Reader = new NdjsonReader(e1Path, {
      initialOffset: getCursor('e1', 'mailbox.ndjson'),
      persistOffset: (off) => setCursor('e1', 'mailbox.ndjson', off),
    });
    const e2Reader = new NdjsonReader(e2Path, {
      initialOffset: getCursor('e2', 'mailbox.ndjson'),
      persistOffset: (off) => setCursor('e2', 'mailbox.ndjson', off),
    });

    expect(e1Reader.readNew()).toEqual([{ x: 1 }]);
    expect(e2Reader.readNew()).toEqual([{ y: 1 }]);
    // Cursors are stored separately — e1 reader's read does not advance e2's
    expect(getCursor('e1', 'mailbox.ndjson')).not.toBe(0);
    expect(getCursor('e2', 'mailbox.ndjson')).not.toBe(0);
  });
});
