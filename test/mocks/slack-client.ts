/**
 * MockSlackWebClient — a hand-built Slack WebClient mock for unit tests.
 *
 * Records all API method calls with arguments for assertion in tests.
 * Supports scripted responses via addResponse(). Returns { ok: true }
 * by default for unscripted calls.
 *
 * Usage:
 *   const client = new MockSlackWebClient();
 *   client.addResponse('chat.postMessage', { ok: true, ts: '123.456' });
 *   await client.chat.postMessage({ channel: 'C123', text: 'hi' });
 *   client.lastCall('chat.postMessage'); // { method, args, timestamp }
 */

export interface MockCall {
  method: string;
  args: Record<string, unknown>;
  timestamp: number;
}

/**
 * Mock for @slack/web-api WebClient.
 *
 * Intercepts dot-path method calls (e.g. `client.chat.postMessage(args)`)
 * using a Proxy chain that records calls as `chat.postMessage` in `this.calls`.
 */
export class MockSlackWebClient {
  /** Recorded call log indexed by dot-separated method name. */
  calls: Record<string, MockCall[]> = {};

  private responses: Record<string, unknown[]> = {};

  /**
   * Register a scripted response for a Slack API method.
   * Responses are consumed FIFO; if exhausted, falls back to { ok: true }.
   *
   * @param method - Dot-separated method name (e.g. 'chat.postMessage').
   * @param response - Response object to return from the mock call.
   */
  addResponse(method: string, response: unknown): void {
    if (!this.responses[method]) {
      this.responses[method] = [];
    }
    this.responses[method]!.push(response);
  }

  /**
   * Get the last recorded call for a method.
   *
   * @param method - Dot-separated method name.
   * @returns The most recent MockCall, or undefined if never called.
   */
  lastCall(method: string): MockCall | undefined {
    const methodCalls = this.calls[method];
    return methodCalls?.[methodCalls.length - 1];
  }

  /** Reset all recorded calls and scripted responses. */
  reset(): void {
    this.calls = {};
    this.responses = {};
  }

  private record(method: string, args: Record<string, unknown>): unknown {
    if (!this.calls[method]) {
      this.calls[method] = [];
    }
    this.calls[method]!.push({ method, args, timestamp: Date.now() });

    const queue = this.responses[method];
    if (queue && queue.length > 0) {
      return Promise.resolve(queue.shift());
    }
    return Promise.resolve({ ok: true });
  }

  /**
   * Returns a Proxy chain so dot-path calls like:
   *   client.chat.postMessage({ channel, text })
   * are recorded as 'chat.postMessage'.
   */
  private makeProxy(prefix: string): unknown {
    return new Proxy(
      {},
      {
        get: (_target, prop: string) => {
          const method = prefix ? `${prefix}.${prop}` : prop;
          return (args: Record<string, unknown> = {}) =>
            this.record(method, args);
        },
      },
    );
  }

  /** Proxy access to the client — intercepts all nested property access. */
  [key: string]: unknown;

  constructor() {
    return new Proxy(this, {
      get: (target, prop: string) => {
        // Return class methods/fields directly
        if (prop in target) {
          const val = (target as Record<string, unknown>)[prop];
          return typeof val === 'function' ? val.bind(target) : val;
        }
        // Return a proxy for namespace segments (chat, users, etc.)
        return target.makeProxy(prop);
      },
    });
  }
}
