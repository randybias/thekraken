/**
 * Team bridge: wires a pi-coding-agent subprocess (spawned in RPC mode)
 * to the NDJSON IPC files (mailbox.ndjson in, outbound.ndjson out).
 *
 * Each enclave's team has ONE TeamBridge. On creation, it spawns
 * `pi --mode rpc`, then starts tailing mailbox.ndjson for dispatcher
 * records. For each user_message record:
 *
 *   1. Send a `{type:"prompt"}` JSON command on pi's stdin.
 *   2. Watch the stdout event stream for an `agent_end` event.
 *   3. Query `{type:"get_last_assistant_text"}` and capture the reply.
 *   4. Append an OutboundRecord to outbound.ndjson so the poller posts
 *      it to Slack.
 *
 * Messages are processed sequentially per-enclave; new mailbox records
 * queue while pi is working on the previous turn.
 *
 * D6 (user identity hard partition): the env passed to pi already carries
 * TNTC_ACCESS_TOKEN (set by TeamLifecycleManager on spawn).
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createChildLogger } from '../logger.js';
import { appendNdjson, NdjsonReader } from './ndjson.js';
import { writeTokenFile } from './token-bootstrap.js';
import { HeartbeatController, isSignificantSignal } from './heartbeat.js';
import { decodeSignal } from './signals.js';
import type { MailboxRecord } from './lifecycle.js';
import type { OutboundRecord } from './outbound-poller.js';

const log = createChildLogger({ module: 'team-bridge' });

/** Max time to wait for the agent to finish one prompt (build/deploy can be long). */
const IDLE_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

/** Poll the mailbox every 1s. */
const MAILBOX_POLL_MS = 1_000;

/** Max time to wait for a single RPC command response. */
const RPC_RESPONSE_TIMEOUT_MS = 30_000;

export interface TeamBridgeOptions {
  enclaveName: string;
  teamDir: string;
  gitStateDir: string;
  /** LLM provider (e.g. "anthropic"). */
  provider: string;
  /** Model ID (e.g. "claude-sonnet-4-6"). */
  modelId: string;
  /** Env to pass to the pi subprocess (already contains the user's token). */
  env: Record<string, string>;
  /** Path to the pi CLI binary (the .bin/pi symlink target). */
  piCliPath: string;
  /**
   * System prompt to append to pi's default coding-agent prompt. Gives
   * the team Kraken-specific context (enclave, build flow, vocabulary,
   * response style).
   */
  appendSystemPrompt?: string;
  /**
   * Called when the pi subprocess exits unexpectedly so the owner
   * (TeamLifecycleManager) can clean up.
   */
  onExit?: (code: number | null) => void;
  /**
   * C5: Optional callback to retrieve a fresh access token for the user
   * before each mailbox turn. If provided, the token is written to
   * token.json in the team dir before the prompt is sent to pi.
   *
   * The token from the mailbox record is used as the fallback when this
   * callback is not provided or returns null.
   *
   * The callback should use getValidTokenForUser() from src/auth/oidc.ts.
   *
   * @param slackUserId - The Slack user ID from the mailbox record.
   * @returns A fresh access token or null if the user must re-auth.
   */
  getTokenForUser?: (slackUserId: string) => Promise<string | null>;
}

/** A pending RPC request waiting on its response. */
interface PendingRequest {
  resolve: (data: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export class TeamBridge {
  private proc: ChildProcess | null = null;
  private reader: NdjsonReader;
  /** C4: NdjsonReader for signals.ndjson (dev team → manager progress). */
  private signalsReader: NdjsonReader;
  /** C4: HeartbeatController emits friendly outbound messages on significant events. */
  private heartbeat: HeartbeatController;
  private pollTimer: NodeJS.Timeout | null = null;
  private queue: MailboxRecord[] = [];
  private processing = false;
  private stopped = false;
  private stdoutBuffer = '';
  private pending = new Map<string, PendingRequest>();
  /** Resolved when pi emits an `agent_end` event. */
  private idleResolver: (() => void) | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  /** Latched `agent_end` — consumed by the next `waitForIdle()` call. */
  private agentEndLatched = false;
  private readonly mailboxPath: string;
  private readonly outboundPath: string;
  private readonly signalsPath: string;

  constructor(private readonly opts: TeamBridgeOptions) {
    this.mailboxPath = join(opts.teamDir, 'mailbox.ndjson');
    this.outboundPath = join(opts.teamDir, 'outbound.ndjson');
    this.signalsPath = join(opts.teamDir, 'signals.ndjson');
    // Start at the end of any existing mailbox. On pod restart, old
    // records are stale (their threads are dead, pi context is gone).
    // We only want records appended AFTER this bridge starts.
    this.reader = new NdjsonReader(this.mailboxPath, { startAtEnd: true });
    // C4: signals reader — also start at end (only new dev team signals matter).
    this.signalsReader = new NdjsonReader(this.signalsPath, {
      startAtEnd: true,
    });
    // C4: Heartbeat controller emits to outbound.ndjson on the manager's behalf.
    this.heartbeat = new HeartbeatController({
      onHeartbeat: (text) => this.writeHeartbeat(text),
    });

    if (!existsSync(opts.gitStateDir)) {
      mkdirSync(opts.gitStateDir, { recursive: true });
    }
  }

  /** Start the pi RPC subprocess and begin polling mailbox. */
  async start(): Promise<void> {
    // cwd is set via spawn() below, not via a pi CLI flag (pi doesn't
    // have --cwd; it picks up process.cwd()). See pi --help.
    const args = [
      '--mode',
      'rpc',
      '--provider',
      this.opts.provider,
      '--model',
      this.opts.modelId,
      '--no-session',
      '--no-extensions',
    ];
    if (this.opts.appendSystemPrompt) {
      args.push('--append-system-prompt', this.opts.appendSystemPrompt);
    }
    this.proc = spawn(this.opts.piCliPath, args, {
      cwd: this.opts.gitStateDir,
      env: this.opts.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.proc.stdout?.on('data', (chunk: Buffer) => {
      this.stdoutBuffer += chunk.toString('utf8');
      let nl: number;
      while ((nl = this.stdoutBuffer.indexOf('\n')) !== -1) {
        const line = this.stdoutBuffer.slice(0, nl).trim();
        this.stdoutBuffer = this.stdoutBuffer.slice(nl + 1);
        if (line) this.handleLine(line);
      }
    });

    this.proc.stderr?.on('data', (chunk: Buffer) => {
      log.debug(
        {
          enclaveName: this.opts.enclaveName,
          stderr: chunk.toString('utf8').slice(0, 400),
        },
        'team-bridge: pi stderr',
      );
    });

    this.proc.on('exit', (code, signal) => {
      log.info(
        { enclaveName: this.opts.enclaveName, code, signal },
        'team-bridge: pi RPC process exited',
      );
      this.stopped = true;
      this.proc = null;
      // Reject all pending requests
      for (const [, pending] of this.pending) {
        clearTimeout(pending.timer);
        pending.reject(new Error(`pi exited (code=${code})`));
      }
      this.pending.clear();
      if (this.idleResolver) {
        this.idleResolver();
        this.idleResolver = null;
      }
      this.opts.onExit?.(code);
    });

    this.proc.on('error', (err) => {
      log.error(
        { enclaveName: this.opts.enclaveName, err },
        'team-bridge: pi RPC process error',
      );
    });

    // Wait for pi to be ready by sending get_state and awaiting the response.
    // This confirms the RPC loop is listening.
    try {
      await this.sendCommand('get_state', {});
      log.info(
        { enclaveName: this.opts.enclaveName },
        'team-bridge: pi RPC ready',
      );
    } catch (err) {
      log.error(
        { err, enclaveName: this.opts.enclaveName },
        'team-bridge: pi RPC handshake failed',
      );
      throw err;
    }

    this.pollTimer = setInterval(() => {
      this.poll().catch((err: unknown) => {
        log.error(
          { err, enclaveName: this.opts.enclaveName },
          'team-bridge: poll cycle failed',
        );
      });
    }, MAILBOX_POLL_MS);
    this.pollTimer.unref?.();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.proc) {
      this.proc.kill('SIGTERM');
      // Force-kill after 3s
      setTimeout(() => {
        if (this.proc && !this.proc.killed) this.proc.kill('SIGKILL');
      }, 3000).unref?.();
    }
  }

  isActive(): boolean {
    return !this.stopped && this.proc !== null;
  }

  /** Handle a single JSON line from pi's stdout. */
  private handleLine(line: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line) as Record<string, unknown>;
    } catch {
      // Non-JSON output — log and skip (pi may emit non-RPC text).
      log.debug(
        { enclaveName: this.opts.enclaveName, line: line.slice(0, 200) },
        'team-bridge: non-JSON stdout',
      );
      return;
    }

    // RPC response?
    if (msg['type'] === 'response' && typeof msg['id'] === 'string') {
      const pending = this.pending.get(msg['id'] as string);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(msg['id'] as string);
        if (msg['success']) {
          pending.resolve(msg['data']);
        } else {
          pending.reject(new Error(String(msg['error'] ?? 'rpc error')));
        }
      }
      return;
    }

    // Agent event? We care about agent_end for idle detection.
    // Latch the event even if no waiter is registered yet — processOne
    // sends 'prompt' and then calls waitForIdle(); if the agent finishes
    // between those two calls, the latch ensures the wait resolves
    // immediately instead of timing out after 10 minutes.
    if (msg['type'] === 'agent_end') {
      if (this.idleResolver) {
        const resolve = this.idleResolver;
        this.idleResolver = null;
        if (this.idleTimer) {
          clearTimeout(this.idleTimer);
          this.idleTimer = null;
        }
        resolve();
      } else {
        // No waiter yet — latch so the next waitForIdle() returns immediately.
        this.agentEndLatched = true;
      }
    }
  }

  /** Send a JSON RPC command and await the response. */
  private sendCommand<T = unknown>(
    type: string,
    extra: Record<string, unknown>,
  ): Promise<T> {
    if (!this.proc || !this.proc.stdin || this.stopped) {
      return Promise.reject(new Error('pi RPC process is not running'));
    }
    const id = randomUUID();
    const cmd = { id, type, ...extra };
    const line = JSON.stringify(cmd) + '\n';
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`RPC command ${type} timed out`));
      }, RPC_RESPONSE_TIMEOUT_MS);
      timer.unref?.();
      this.pending.set(id, {
        resolve: (data) => resolve(data as T),
        reject,
        timer,
      });
      this.proc!.stdin!.write(line, (err) => {
        if (err) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(err);
        }
      });
    });
  }

  /** Wait for the next agent_end event (or timeout). */
  private waitForIdle(timeoutMs: number): Promise<void> {
    // Consume latched agent_end — if the event arrived between the
    // prompt response and this call, resolve immediately.
    if (this.agentEndLatched) {
      this.agentEndLatched = false;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      this.idleResolver = resolve;
      this.idleTimer = setTimeout(() => {
        this.idleResolver = null;
        this.idleTimer = null;
        reject(new Error(`agent idle wait timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.idleTimer.unref?.();
    });
  }

  private async poll(): Promise<void> {
    if (this.stopped) return;
    const records = this.reader.readNew() as MailboxRecord[];
    for (const r of records) {
      if (r.type !== 'user_message') continue;
      this.queue.push(r);
    }
    if (this.queue.length > 0 && !this.processing) {
      void this.drain();
    }
    // C4: also poll signals.ndjson for dev team progress heartbeats
    this.pollSignals();
  }

  /**
   * C4: Poll signals.ndjson for dev team progress signals.
   *
   * On significant events (task_started, progress_update, task_completed,
   * task_failed), the HeartbeatController decides whether enough time has
   * passed to emit a heartbeat. The heartbeat is written to outbound.ndjson
   * by the bridge, acting on the manager's behalf.
   */
  private pollSignals(): void {
    if (this.stopped) return;
    const lines = this.signalsReader.readNew();
    for (const raw of lines) {
      const encoded = JSON.stringify(raw);
      const signal = decodeSignal(encoded);
      if (!signal) continue;
      if (!isSignificantSignal(signal)) continue;

      // Extract tentacle name from signal if available
      const tentacleName =
        'tentacleName' in signal && typeof signal['tentacleName'] === 'string'
          ? signal['tentacleName']
          : undefined;

      this.heartbeat.onSignal(signal, tentacleName);
    }
  }

  /**
   * C4: Write a heartbeat message to outbound.ndjson.
   *
   * Called by HeartbeatController.onHeartbeat() when a significant event
   * has occurred and the 30s floor has elapsed.
   *
   * The heartbeat record has no threadTs — the outbound poller should
   * post it to the channel's most recent thread (or the channel directly).
   * For now, we use a sentinel empty string so the poller can identify
   * heartbeat records and handle them appropriately.
   */
  private writeHeartbeat(text: string): void {
    const outbound: OutboundRecord = {
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      type: 'heartbeat',
      channelId: '', // resolved by the outbound poller from bridge context
      threadTs: '',
      text,
    };
    try {
      appendNdjson(this.outboundPath, outbound);
      log.debug(
        { enclaveName: this.opts.enclaveName, textLen: text.length },
        'team-bridge: wrote heartbeat outbound record',
      );
    } catch (err) {
      log.warn(
        { enclaveName: this.opts.enclaveName, err },
        'team-bridge: failed to write heartbeat outbound record',
      );
    }
  }

  private async drain(): Promise<void> {
    if (this.processing) return;
    this.processing = true;
    try {
      while (this.queue.length > 0 && !this.stopped) {
        const record = this.queue.shift()!;
        await this.processOne(record).catch((err: unknown) => {
          log.error(
            { err, recordId: record.id },
            'team-bridge: processOne failed',
          );
          this.writeOutboundError(record, err);
        });
      }
    } finally {
      this.processing = false;
    }
  }

  private async processOne(record: MailboxRecord): Promise<void> {
    log.info(
      {
        enclaveName: this.opts.enclaveName,
        recordId: record.id,
        channelId: record.channelId,
        threadTs: record.threadTs,
        msgLen: record.message.length,
      },
      'team-bridge: processing mailbox record',
    );

    // C5: Write a fresh token.json before handing the prompt to the manager.
    // If a getTokenForUser callback is wired, use it to get a potentially
    // refreshed token. Fall back to the token in the mailbox record.
    await this.refreshTokenFile(record);

    // Send the user turn to pi
    await this.sendCommand('prompt', { message: record.message });
    // Wait for the agent to finish (agent_end event)
    await this.waitForIdle(IDLE_TIMEOUT_MS);
    // Pull the final assistant text
    const data = (await this.sendCommand('get_last_assistant_text', {})) as {
      text: string | null;
    } | null;
    const text = data?.text?.trim();

    if (!text) {
      log.warn(
        { enclaveName: this.opts.enclaveName, recordId: record.id },
        'team-bridge: agent produced no assistant text; skipping outbound',
      );
      return;
    }

    const outbound: OutboundRecord = {
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      type: 'slack_message',
      channelId: record.channelId,
      threadTs: record.threadTs,
      text,
    };
    appendNdjson(this.outboundPath, outbound);
    log.info(
      {
        enclaveName: this.opts.enclaveName,
        recordId: record.id,
        outLen: text.length,
      },
      'team-bridge: wrote outbound record',
    );
  }

  /**
   * C5: Write a fresh token.json to the team dir before each mailbox turn.
   *
   * Tries getTokenForUser callback first (which auto-refreshes if needed).
   * Falls back to the token in the mailbox record if the callback is not
   * wired or returns null.
   *
   * Extracts expires_in from the JWT 'exp' claim when possible; uses a
   * conservative 3600s default when the claim is unavailable.
   */
  private async refreshTokenFile(record: MailboxRecord): Promise<void> {
    let token = record.userToken;
    let expiresIn = 3600; // conservative default

    // Prefer a freshly refreshed token from the callback
    if (this.opts.getTokenForUser) {
      const fresh = await this.opts
        .getTokenForUser(record.userSlackId)
        .catch((err: unknown) => {
          log.warn(
            { enclaveName: this.opts.enclaveName, err },
            'team-bridge: getTokenForUser callback failed; using mailbox token',
          );
          return null;
        });
      if (fresh) {
        token = fresh;
      }
    }

    // Extract expiry from JWT 'exp' claim if available
    if (token) {
      try {
        const part = token.split('.')[1];
        if (part) {
          const payload = JSON.parse(
            Buffer.from(part, 'base64url').toString(),
          ) as Record<string, unknown>;
          const exp = payload['exp'];
          if (typeof exp === 'number') {
            const nowSeconds = Math.floor(Date.now() / 1000);
            expiresIn = Math.max(exp - nowSeconds, 60); // at least 60s
          }
        }
      } catch {
        // non-fatal; keep conservative default
      }
    }

    if (!token) {
      log.warn(
        { enclaveName: this.opts.enclaveName, recordId: record.id },
        'team-bridge: no token available for token.json; subprocess may fail MCP calls',
      );
      return;
    }

    writeTokenFile(this.opts.teamDir, token, expiresIn);
    log.debug(
      { enclaveName: this.opts.enclaveName, expiresIn },
      'team-bridge: refreshed token.json',
    );
  }

  private writeOutboundError(record: MailboxRecord, err: unknown): void {
    const errMsg = err instanceof Error ? err.message : String(err);
    const outbound: OutboundRecord = {
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      type: 'error',
      channelId: record.channelId,
      threadTs: record.threadTs,
      text: `I hit an error while working on that: ${errMsg}`,
    };
    try {
      appendNdjson(this.outboundPath, outbound);
    } catch {
      // best-effort
    }
  }
}
