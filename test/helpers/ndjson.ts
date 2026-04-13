/**
 * NDJSON test helpers (T23).
 *
 * Utilities for writing and reading NDJSON records in tests, used by T07,
 * T10, T11 and scenario tests.
 */

import { appendFileSync, existsSync, readFileSync } from 'node:fs';

/**
 * Append a JSON record to an NDJSON file.
 *
 * Thin wrapper over appendFileSync that serialises the record to JSON.
 * Creates the file if it does not exist.
 */
export function appendRecord(path: string, record: object): void {
  appendFileSync(path, JSON.stringify(record) + '\n', 'utf8');
}

/**
 * Read all complete JSON records from an NDJSON file.
 *
 * Returns an empty array if the file does not exist or is empty.
 * Optionally filters records using a predicate.
 *
 * @param path - Absolute path to the NDJSON file.
 * @param filter - Optional predicate; only matching records are returned.
 */
export function readRecords(
  path: string,
  filter?: (rec: object) => boolean,
): object[] {
  if (!existsSync(path)) return [];
  const content = readFileSync(path, 'utf8');
  const records: object[] = [];
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const rec = JSON.parse(trimmed) as object;
      if (!filter || filter(rec)) {
        records.push(rec);
      }
    } catch {
      // skip invalid lines
    }
  }
  return records;
}

/**
 * Wait for a matching record to appear in an NDJSON file.
 *
 * Polls the file every `intervalMs` milliseconds until a record matching
 * `matcher` is found or `timeoutMs` elapses.
 *
 * @param path - Absolute path to the NDJSON file.
 * @param matcher - Predicate that returns true for the desired record.
 * @param timeoutMs - Maximum wait time in milliseconds. Default: 5000.
 * @param intervalMs - Poll interval in milliseconds. Default: 50.
 * @returns The matching record.
 * @throws if timeout elapses before a match is found.
 */
export async function waitForRecord(
  path: string,
  matcher: (rec: object) => boolean,
  timeoutMs = 5000,
  intervalMs = 50,
): Promise<object> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const records = readRecords(path, matcher);
    if (records.length > 0) return records[0]!;
    await new Promise<void>((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(
    `waitForRecord: no matching record found in "${path}" within ${timeoutMs}ms`,
  );
}
