/**
 * NDJSON cursor persistence (rc.13).
 *
 * Stores per-(enclave, file) byte offsets so readers can resume from
 * where the prior process left off. Keyed by enclave name + relative
 * filename; the team dir path is implicit because each file lives in
 * its enclave's team dir.
 *
 * Initialized at startup with the main DB handle (the same kraken.db
 * passed to other non-secrets stores). NOT the secrets DB.
 */
import type Database from 'better-sqlite3';

let db: Database.Database;

export function initCursorStore(database: Database.Database): void {
  db = database;
}

/** Read the stored byte offset, or 0 if no cursor exists for the pair. */
export function getCursor(enclaveName: string, filename: string): number {
  const row = db
    .prepare(
      'SELECT byte_offset FROM ndjson_cursors WHERE enclave_name = ? AND filename = ?',
    )
    .get(enclaveName, filename) as { byte_offset: number } | undefined;
  return row?.byte_offset ?? 0;
}

/** Persist the byte offset (UPSERT). */
export function setCursor(
  enclaveName: string,
  filename: string,
  byteOffset: number,
): void {
  db.prepare(
    `INSERT INTO ndjson_cursors (enclave_name, filename, byte_offset, updated_at)
     VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
     ON CONFLICT (enclave_name, filename) DO UPDATE SET
       byte_offset = excluded.byte_offset,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
  ).run(enclaveName, filename, byteOffset);
}

/**
 * Delete cursor(s).
 *
 * - With a filename: removes the cursor for one (enclave, file) pair.
 * - Without a filename: removes ALL cursors for the enclave (use when
 *   an enclave is deprovisioned).
 */
export function deleteCursor(enclaveName: string, filename?: string): void {
  if (filename) {
    db.prepare(
      'DELETE FROM ndjson_cursors WHERE enclave_name = ? AND filename = ?',
    ).run(enclaveName, filename);
  } else {
    db.prepare('DELETE FROM ndjson_cursors WHERE enclave_name = ?').run(
      enclaveName,
    );
  }
}
