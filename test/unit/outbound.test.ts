import { describe, it, expect, beforeEach } from 'vitest';
import { OutboundTracker } from '../../src/slack/outbound.js';
import { createDatabase } from '../../src/db/migrations.js';
import type Database from 'better-sqlite3';

function createTestDb(): Database.Database {
  return createDatabase(':memory:');
}

describe('OutboundTracker', () => {
  let db: Database.Database;
  let tracker: OutboundTracker;

  beforeEach(() => {
    db = createTestDb();
    tracker = new OutboundTracker(db);
  });

  it('hasOutboundInThread returns false when no messages stored', () => {
    expect(tracker.hasOutboundInThread('C001', '1234567890.000000')).toBe(false);
  });

  it('store persists a message and hasOutboundInThread returns true', () => {
    tracker.store('C001', '1234567890.000000', '1234567891.000001', 'Hello world');
    expect(tracker.hasOutboundInThread('C001', '1234567890.000000')).toBe(true);
  });

  it('hasOutboundInThread is channel-specific', () => {
    tracker.store('C001', '1234567890.000000', '1234567891.000001', 'Hello');
    // Different channel — should not match
    expect(tracker.hasOutboundInThread('C002', '1234567890.000000')).toBe(false);
  });

  it('hasOutboundInThread is thread-specific', () => {
    tracker.store('C001', '1111111111.000000', '1111111112.000000', 'Hello');
    // Different thread in same channel
    expect(tracker.hasOutboundInThread('C001', '2222222222.000000')).toBe(false);
  });

  it('store is idempotent — duplicate inserts do not throw', () => {
    const channelId = 'C001';
    const threadTs = '1234567890.000000';
    const messageTs = '1234567891.000001';
    const content = 'Same content';

    expect(() => {
      tracker.store(channelId, threadTs, messageTs, content);
      tracker.store(channelId, threadTs, messageTs, content);
    }).not.toThrow();
  });

  it('simulates restart dedup — messages survive db reference reuse', () => {
    // Simulate Phase 1 restart: same db file, new tracker instance
    tracker.store('C001', '1234567890.000000', '1234567891.000001', 'First response');

    // New tracker instance (same db) — simulates restart
    const tracker2 = new OutboundTracker(db);
    expect(tracker2.hasOutboundInThread('C001', '1234567890.000000')).toBe(true);
  });

  it('stores multiple messages in the same thread', () => {
    const channelId = 'C001';
    const threadTs = '1234567890.000000';

    tracker.store(channelId, threadTs, '1234567891.000001', 'First');
    tracker.store(channelId, threadTs, '1234567892.000002', 'Second');
    tracker.store(channelId, threadTs, '1234567893.000003', 'Third');

    expect(tracker.hasOutboundInThread(channelId, threadTs)).toBe(true);

    // Verify all three rows exist
    const rows = db
      .prepare('SELECT COUNT(*) as n FROM outbound_messages WHERE channel_id = ? AND thread_ts = ?')
      .get(channelId, threadTs) as { n: number };
    expect(rows.n).toBe(3);
  });
});
