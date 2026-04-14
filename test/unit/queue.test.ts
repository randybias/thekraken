import { describe, it, expect, vi } from 'vitest';
import { ThreadQueue } from '../../src/agent/queue.js';

describe('ThreadQueue', () => {
  it('executes a single task and resolves with its return value', async () => {
    const queue = new ThreadQueue();
    const result = await queue.enqueue('thread-1', () => Promise.resolve(42));
    expect(result).toBe(42);
  });

  it('processes tasks for the same thread serially (FIFO)', async () => {
    const queue = new ThreadQueue();
    const order: number[] = [];

    // Enqueue 3 tasks for the same thread — each records its order
    const p1 = queue.enqueue('thread-1', async () => {
      await new Promise((r) => setTimeout(r, 20));
      order.push(1);
      return 1;
    });
    const p2 = queue.enqueue('thread-1', async () => {
      order.push(2);
      return 2;
    });
    const p3 = queue.enqueue('thread-1', async () => {
      order.push(3);
      return 3;
    });

    await Promise.all([p1, p2, p3]);
    expect(order).toEqual([1, 2, 3]);
  });

  it('processes tasks for different threads concurrently', async () => {
    const queue = new ThreadQueue();
    const starts: string[] = [];
    const ends: string[] = [];

    // Thread A has a slow task; Thread B should not wait for it
    let resolveA!: () => void;
    const aStarted = new Promise<void>((res) => {
      void queue.enqueue('thread-a', () => {
        starts.push('a');
        return new Promise<void>((r) => {
          resolveA = r;
        }).then(() => {
          ends.push('a');
        });
      });
      res();
    });

    await aStarted;
    // Small delay to ensure thread-a task is running
    await new Promise((r) => setTimeout(r, 5));

    // Thread B should execute immediately, not wait for A
    await queue.enqueue('thread-b', async () => {
      starts.push('b');
      ends.push('b');
    });

    // Thread B completed while A is still running
    expect(starts).toContain('a');
    expect(starts).toContain('b');
    expect(ends).toContain('b');
    expect(ends).not.toContain('a');

    // Now resolve A
    resolveA();
    // Wait a tick for A to finish
    await new Promise((r) => setTimeout(r, 5));
    expect(ends).toContain('a');
  });

  it('propagates rejections from tasks', async () => {
    const queue = new ThreadQueue();
    await expect(
      queue.enqueue('thread-1', () => Promise.reject(new Error('task failed'))),
    ).rejects.toThrow('task failed');
  });

  it('continues processing subsequent tasks after a failure', async () => {
    const queue = new ThreadQueue();

    // First task fails
    const p1 = queue.enqueue('t1', () => Promise.reject(new Error('boom')));
    // Second task should still run
    const p2 = queue.enqueue('t1', () => Promise.resolve('ok'));

    await expect(p1).rejects.toThrow('boom');
    await expect(p2).resolves.toBe('ok');
  });

  it('drain() waits for in-flight tasks and resolves', async () => {
    const queue = new ThreadQueue();
    let completed = false;

    void queue.enqueue('t1', async () => {
      await new Promise((r) => setTimeout(r, 30));
      completed = true;
    });

    await queue.drain(1000);
    expect(completed).toBe(true);
  });

  it('drain() rejects new enqueue attempts', async () => {
    const queue = new ThreadQueue();
    await queue.drain();

    await expect(
      queue.enqueue('t1', () => Promise.resolve('should reject')),
    ).rejects.toThrow('Queue is draining');
  });

  it('drain() times out if tasks take too long', async () => {
    const queue = new ThreadQueue();

    void queue.enqueue('t1', async () => {
      await new Promise((r) => setTimeout(r, 500));
    });

    await expect(queue.drain(50)).rejects.toThrow('timed out');
  });

  it('hasActiveThreads() returns false when all threads idle', async () => {
    const queue = new ThreadQueue();
    await queue.enqueue('t1', () => Promise.resolve());
    // After task completes, no active threads
    expect(queue.hasActiveThreads()).toBe(false);
  });
});
