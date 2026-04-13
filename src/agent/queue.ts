/**
 * Per-thread serial queue.
 *
 * Messages for the same thread are processed serially (FIFO). Messages
 * across different threads run concurrently.
 *
 * Used by AgentRunner to prevent concurrent pi Agent invocations on the
 * same thread (pi Agent is NOT concurrent-safe for multiple prompt() calls).
 */

type QueuedTask<T> = {
  fn: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
};

/**
 * Per-thread serial queue. Different threads run concurrently;
 * messages within the same thread run serially (FIFO).
 */
export class ThreadQueue {
  private queues = new Map<string, QueuedTask<unknown>[]>();
  private active = new Map<string, boolean>();
  private draining = false;

  /**
   * Enqueue a task for a specific thread.
   *
   * Returns a Promise that resolves (or rejects) with the task's result.
   * If the thread has no active task, starts executing immediately.
   * If the thread already has an active task, queues for serial execution.
   *
   * Rejects immediately if drain() has been called (shutdown in progress).
   *
   * @param threadKey - Unique thread identifier (e.g. "C012ABC:1712345678.123456").
   * @param fn - Async function to execute.
   */
  enqueue<T>(threadKey: string, fn: () => Promise<T>): Promise<T> {
    if (this.draining) {
      return Promise.reject(
        new Error('Queue is draining; rejecting new tasks'),
      );
    }

    return new Promise<T>((resolve, reject) => {
      const task: QueuedTask<T> = { fn, resolve, reject } as QueuedTask<T>;

      if (!this.queues.has(threadKey)) {
        this.queues.set(threadKey, []);
      }
      this.queues.get(threadKey)!.push(task as QueuedTask<unknown>);

      if (!this.active.get(threadKey)) {
        void this.processNext(threadKey);
      }
    });
  }

  /**
   * Enter drain mode. Waits for all in-flight tasks to complete, then resolves.
   * Any new enqueue() calls after drain() is called are rejected immediately.
   *
   * @param timeoutMs - Maximum wait time in milliseconds. Default: 30000.
   * @throws Error if timeout elapses before all threads drain.
   */
  async drain(timeoutMs = 30000): Promise<void> {
    this.draining = true;

    const deadline = Date.now() + timeoutMs;
    while (this.hasActiveThreads()) {
      if (Date.now() > deadline) {
        throw new Error(`Queue drain timed out after ${timeoutMs}ms`);
      }
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  /** Returns true if any thread has an in-flight (active) task. */
  hasActiveThreads(): boolean {
    for (const [, isActive] of this.active) {
      if (isActive) return true;
    }
    return false;
  }

  private async processNext(threadKey: string): Promise<void> {
    const queue = this.queues.get(threadKey);
    if (!queue || queue.length === 0) {
      this.active.set(threadKey, false);
      return;
    }

    this.active.set(threadKey, true);
    const task = queue.shift()!;

    try {
      const result = await task.fn();
      task.resolve(result);
    } catch (err) {
      task.reject(err);
    }

    // Process next in same thread (tail call)
    void this.processNext(threadKey);
  }
}
