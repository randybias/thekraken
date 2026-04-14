/**
 * Team state directory fixture (T24).
 *
 * Creates and cleans up temporary team directories matching the
 * {teamsDir}/{enclaveName}/ layout used by TeamLifecycleManager.
 * Provides helpers for writing/reading mailbox, outbound, and signals files.
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { appendRecord, readRecords } from './ndjson.js';

export interface TeamFixture {
  /** Absolute path to the enclave's team directory. */
  dir: string;
  /** Absolute path to mailbox.ndjson. */
  mailboxPath: string;
  /** Absolute path to outbound.ndjson. */
  outboundPath: string;
  /** Absolute path to signals.ndjson. */
  signalsPath: string;
  /** The teamsDir root (parent of all team dirs). */
  teamsDir: string;
  /** Append a record to mailbox.ndjson. */
  appendMailbox: (record: object) => void;
  /** Append a record to outbound.ndjson. */
  appendOutbound: (record: object) => void;
  /** Append a record to signals.ndjson. */
  appendSignal: (record: object) => void;
  /** Read all records from mailbox.ndjson. */
  readMailbox: (filter?: (r: object) => boolean) => object[];
  /** Read all records from outbound.ndjson. */
  readOutbound: (filter?: (r: object) => boolean) => object[];
  /** Read all records from signals.ndjson. */
  readSignals: (filter?: (r: object) => boolean) => object[];
  /** Remove the temp directory and all its contents. */
  cleanup: () => void;
}

/**
 * Create a temporary team fixture for the given enclave name.
 *
 * The fixture creates a temp teamsDir root and a subdirectory for the
 * enclave. Call cleanup() (or use vitest afterEach) to remove it.
 *
 * @param enclaveName - Enclave name (used as directory name).
 * @returns A TeamFixture with helpers and path refs.
 */
export function createTeamFixture(enclaveName: string): TeamFixture {
  const teamsDir = join(tmpdir(), `kraken-teams-${process.pid}-${Date.now()}`);
  const dir = join(teamsDir, enclaveName);

  // Create the directory structure
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(dir, 'memory'), { recursive: true });

  const mailboxPath = join(dir, 'mailbox.ndjson');
  const outboundPath = join(dir, 'outbound.ndjson');
  const signalsPath = join(dir, 'signals.ndjson');

  // Write an empty team.json metadata file
  writeFileSync(
    join(dir, 'team.json'),
    JSON.stringify({
      enclaveName,
      createdAt: new Date().toISOString(),
      status: 'active',
    }),
    'utf8',
  );

  return {
    dir,
    mailboxPath,
    outboundPath,
    signalsPath,
    teamsDir,
    appendMailbox: (record) => appendRecord(mailboxPath, record),
    appendOutbound: (record) => appendRecord(outboundPath, record),
    appendSignal: (record) => appendRecord(signalsPath, record),
    readMailbox: (filter) => readRecords(mailboxPath, filter),
    readOutbound: (filter) => readRecords(outboundPath, filter),
    readSignals: (filter) => readRecords(signalsPath, filter),
    cleanup: () => {
      if (existsSync(teamsDir)) {
        rmSync(teamsDir, { recursive: true, force: true });
      }
    },
  };
}
