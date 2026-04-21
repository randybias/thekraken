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
 * Signal protocol (Must-fix #1):
 *   signals-out.ndjson — manager writes commission_dev_team / terminate_dev_team;
 *                         bridge reads and dispatches dev team subprocesses.
 *   signals-in.ndjson  — bridge writes task_started / progress_update /
 *                         task_completed / task_failed on behalf of dev teams;
 *                         manager reads these for heartbeat and status.
 *
 * Messages are processed sequentially per-enclave; new mailbox records
 * queue while pi is working on the previous turn.
 *
 * D6/B2 (user identity hard partition): TNTC_ACCESS_TOKEN is NOT in the
 * spawn env. The bridge writes a fresh token.json before each mailbox turn
 * (C5); subprocesses read it via KRAKEN_TOKEN_FILE.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { existsSync, mkdirSync, chmodSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createChildLogger, type Logger } from '../logger.js';
import { appendNdjson, NdjsonReader } from './ndjson.js';
import { writeTokenFile } from './token-bootstrap.js';
import { HeartbeatController, isSignificantSignal } from './heartbeat.js';
import {
  decodeOutboundSignal,
  decodeInboundSignal,
  getLastDecodeError,
  makeTaskFailed,
  SIGNALS_OUT_FILE,
  SIGNALS_IN_FILE,
  type CommissionDevTeamSignal,
} from './signals.js';
import {
  buildBuilderPrompt,
  buildDeployerPrompt,
} from '../agent/system-prompt.js';
import type { MailboxRecord } from './lifecycle.js';
import type { OutboundRecord } from './outbound-poller.js';

const log = createChildLogger({ module: 'team-bridge' });

/** Max time to wait for the agent to finish one prompt (build/deploy can be long). */
const IDLE_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

/** Poll the mailbox every 1s. */
const MAILBOX_POLL_MS = 1_000;

/** Max time to wait for a single RPC command response. */
const RPC_RESPONSE_TIMEOUT_MS = 30_000;

/**
 * Minimal handle for a running dev team child process.
 * Bridge keeps one entry per active taskId.
 */
interface DevTeamHandle {
  taskId: string;
  proc: ChildProcess;
  /** True if we have already emitted a terminal signal (task_completed or task_failed). */
  terminated: boolean;
}

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
   * The callback should use getValidTokenForUser() from src/auth/oidc.ts.
   *
   * @param slackUserId - The Slack user ID from the mailbox record.
   * @returns A fresh access token or null if the user must re-auth.
   */
  getTokenForUser?: (slackUserId: string) => Promise<string | null>;
  /**
   * Factory for spawning dev team subprocesses. Defaults to the real
   * spawn() call. Tests inject a mock here to avoid real subprocess spawns.
   */
  spawnDevTeam?: (opts: DevTeamSpawnOptions) => ChildProcess;
}

/** Parameters for spawning a dev team subprocess. */
export interface DevTeamSpawnOptions {
  taskId: string;
  role: 'builder' | 'deployer';
  goal: string;
  tentacleName?: string;
  taskDir: string;
  systemPrompt: string;
  env: Record<string, string>;
  piCliPath: string;
  gitStateDir: string;
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
  /** C1: NdjsonReader for signals-out.ndjson (manager→bridge commands). */
  private signalsOutReader: NdjsonReader;
  /** C4: NdjsonReader for signals-in.ndjson (dev team → manager progress). */
  private signalsInReader: NdjsonReader;
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
  private readonly signalsOutPath: string;
  private readonly signalsInPath: string;

  /**
   * In-memory map of active dev team handles keyed by taskId.
   * Used to route terminate_dev_team signals and detect premature exits.
   */
  private devTeams = new Map<string, DevTeamHandle>();

  /** Current mailbox record being processed (needed to scope dev-team token). */
  private currentRecord: MailboxRecord | null = null;

  constructor(private readonly opts: TeamBridgeOptions) {
    this.mailboxPath = join(opts.teamDir, 'mailbox.ndjson');
    this.outboundPath = join(opts.teamDir, 'outbound.ndjson');
    this.signalsOutPath = join(opts.teamDir, SIGNALS_OUT_FILE);
    this.signalsInPath = join(opts.teamDir, SIGNALS_IN_FILE);

    // Start at the end of any existing mailbox. On pod restart, old
    // records are stale (their threads are dead, pi context is gone).
    // We only want records appended AFTER this bridge starts.
    this.reader = new NdjsonReader(this.mailboxPath, { startAtEnd: true });
    // signals-out: manager→bridge; start at end (only new commission/terminate matter).
    this.signalsOutReader = new NdjsonReader(this.signalsOutPath, {
      startAtEnd: true,
    });
    // signals-in: dev-team→manager; start at end (only new progress matters).
    this.signalsInReader = new NdjsonReader(this.signalsInPath, {
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
    // Terminate all active dev teams
    for (const [taskId, handle] of this.devTeams) {
      if (!handle.proc.killed) {
        log.info(
          { enclaveName: this.opts.enclaveName, taskId },
          'team-bridge: terminating dev team on stop',
        );
        handle.proc.kill('SIGTERM');
      }
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

  /**
   * @internal — for integration tests only.
   *
   * Drive a single signals-out poll cycle without starting the full pi RPC
   * subprocess. Allows tests to verify the commission/terminate/dedup/synthesis
   * logic without a real pi binary.
   *
   * Sets currentRecord so dispatchDevTeam can access the user token.
   *
   * Returns a promise that resolves when all dispatched commission tasks have
   * either been placed in devTeams or produced a task_failed in signals-in.
   */
  async driveSignalsPollForTest(record?: MailboxRecord): Promise<void> {
    this.currentRecord = record ?? null;
    // Drive one poll cycle through the signals-out reader.
    // Must collect async promises so the test can await completion.
    const dispatchPromises: Promise<void>[] = [];
    const lines = this.signalsOutReader.readNew();
    for (const raw of lines) {
      const encoded = JSON.stringify(raw);
      const signal = decodeOutboundSignal(encoded);
      if (!signal) continue;
      if (signal.type === 'commission_dev_team') {
        dispatchPromises.push(
          this.dispatchDevTeam(signal).catch((err: unknown) => {
            log.error(
              {
                enclaveName: this.opts.enclaveName,
                taskId: signal.taskId,
                err,
              },
              'team-bridge: dispatchDevTeam failed (test)',
            );
          }),
        );
      } else if (signal.type === 'terminate_dev_team') {
        const handle = this.devTeams.get(signal.taskId);
        if (handle && !handle.proc.killed) {
          handle.proc.kill('SIGTERM');
        }
      }
    }
    await Promise.all(dispatchPromises);
    this.currentRecord = null;
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
    // Poll signals-out.ndjson for commission/terminate commands from the manager.
    this.pollSignalsOut();
    // Poll signals-in.ndjson for dev team progress heartbeats.
    this.pollSignalsIn();
  }

  /**
   * Poll signals-out.ndjson for commission_dev_team / terminate_dev_team
   * signals written by the manager. Dispatches dev team spawns or kills.
   */
  private pollSignalsOut(): void {
    if (this.stopped) return;
    const lines = this.signalsOutReader.readNew();
    for (const raw of lines) {
      const encoded = JSON.stringify(raw);
      const signal = decodeOutboundSignal(encoded);
      if (!signal) {
        const fieldErr = getLastDecodeError();
        if (fieldErr) {
          log.warn(
            {
              enclaveName: this.opts.enclaveName,
              fieldErr,
              raw: encoded.slice(0, 200),
            },
            'team-bridge: rejected malformed outbound signal (missing required field)',
          );
        } else {
          log.debug(
            { enclaveName: this.opts.enclaveName, raw },
            'team-bridge: ignoring non-outbound record in signals-out',
          );
        }
        continue;
      }
      if (signal.type === 'commission_dev_team') {
        this.dispatchDevTeam(signal).catch((err: unknown) => {
          log.error(
            { enclaveName: this.opts.enclaveName, taskId: signal.taskId, err },
            'team-bridge: dispatchDevTeam failed',
          );
        });
      } else if (signal.type === 'terminate_dev_team') {
        const handle = this.devTeams.get(signal.taskId);
        if (handle && !handle.proc.killed) {
          log.info(
            { enclaveName: this.opts.enclaveName, taskId: signal.taskId },
            'team-bridge: terminating dev team (terminate_dev_team signal)',
          );
          handle.proc.kill('SIGTERM');
        }
      }
    }
  }

  /**
   * C4: Poll signals-in.ndjson for dev team progress signals.
   *
   * On significant events (task_started, progress_update, task_completed,
   * task_failed), the HeartbeatController decides whether enough time has
   * passed to emit a heartbeat. The heartbeat is written to outbound.ndjson
   * by the bridge, acting on the manager's behalf.
   */
  private pollSignalsIn(): void {
    if (this.stopped) return;
    const lines = this.signalsInReader.readNew();
    for (const raw of lines) {
      const encoded = JSON.stringify(raw);
      const signal = decodeInboundSignal(encoded);
      if (!signal) {
        const fieldErr = getLastDecodeError();
        if (fieldErr) {
          log.warn(
            {
              enclaveName: this.opts.enclaveName,
              fieldErr,
              raw: encoded.slice(0, 200),
            },
            'team-bridge: rejected malformed inbound signal (missing required field)',
          );
        } else {
          log.debug(
            { enclaveName: this.opts.enclaveName, raw },
            'team-bridge: ignoring non-inbound record in signals-in',
          );
        }
        continue;
      }
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
   * Spawn a dev team subprocess for the given commission_dev_team signal.
   *
   * Token discipline: writes a fresh token.json scoped to the task dir
   * before spawning. KRAKEN_TOKEN_FILE in the subprocess env points to it.
   *
   * The subprocess writes inbound signals (task_started, progress_update,
   * task_completed, task_failed) to signals-in.ndjson. On premature exit
   * (no terminal signal was emitted), synthesizes a task_failed record.
   *
   * Race-safety: a placeholder entry is inserted into devTeams
   * synchronously (before the first await) so that a second commission
   * signal for the same taskId arriving in the same poll cycle sees the
   * taskId as already tracked and is rejected with a task_failed rather
   * than spawning a duplicate subprocess.
   */
  private async dispatchDevTeam(
    signal: CommissionDevTeamSignal,
  ): Promise<void> {
    const { taskId, goal, role, tentacleName } = signal;

    // Deduplicate: reserve the slot synchronously before any await so a
    // second commission for the same taskId in the same poll cycle is
    // rejected even if the first await has not yet resolved.
    if (this.devTeams.has(taskId)) {
      log.warn(
        { enclaveName: this.opts.enclaveName, taskId },
        'team-bridge: duplicate commission for taskId; emitting task_failed(duplicate_commission)',
      );
      const dupSignal = makeTaskFailed({
        taskId,
        error: 'duplicate_commission',
      });
      try {
        appendNdjson(this.signalsInPath, dupSignal);
      } catch (err) {
        log.warn(
          { enclaveName: this.opts.enclaveName, taskId, err },
          'team-bridge: could not write duplicate_commission task_failed',
        );
      }
      return;
    }

    // Insert a placeholder immediately (synchronous, before any await).
    // The real handle is swapped in once the subprocess is spawned.
    // On any failure path, the placeholder is deleted so the slot is freed.
    const placeholder: DevTeamHandle = {
      taskId,
      // proc placeholder: a minimal stub that satisfies the interface for
      // the .has() guard. Replaced with the real proc before returning.
      proc: { killed: false, kill: () => false } as unknown as ChildProcess,
      terminated: false,
    };
    this.devTeams.set(taskId, placeholder);

    // Create a task-scoped working directory.
    const taskDir = join(this.opts.teamDir, 'tasks', taskId);
    mkdirSync(taskDir, { recursive: true });

    // Write a fresh token.json for the dev team, using the same token
    // as the current manager turn (currentRecord tracks the active record).
    const tokenPath = join(taskDir, 'token.json');
    let tokenWritten = false;
    if (this.currentRecord) {
      const record = this.currentRecord;
      let token = record.userToken;
      if (this.opts.getTokenForUser) {
        const fresh = await this.opts
          .getTokenForUser(record.userSlackId)
          .catch((err: unknown) => {
            log.warn(
              { enclaveName: this.opts.enclaveName, taskId, err },
              'team-bridge: getTokenForUser failed for dev team; using mailbox token',
            );
            return null;
          });
        if (fresh) token = fresh;
      }
      if (token) {
        const expiresIn = extractExpiresIn(token, log, this.opts.enclaveName);
        writeTokenFile(taskDir, token, expiresIn);
        chmodSync(tokenPath, 0o600);
        tokenWritten = true;
      }
    }

    if (!tokenWritten) {
      // No token available — synthesize task_failed immediately.
      // Remove the placeholder so the slot is free for a future retry.
      this.devTeams.delete(taskId);
      log.error(
        { enclaveName: this.opts.enclaveName, taskId },
        'team-bridge: no token available for dev team; cannot spawn',
      );
      const failedSignal = makeTaskFailed({
        taskId,
        error:
          'No authentication token available. The user must re-authenticate before work can continue.',
      });
      appendNdjson(this.signalsInPath, failedSignal);
      // Also write a user-facing outbound error so the manager can relay it.
      this.writeOutboundReauthPrompt();
      return;
    }

    // Build the subprocess env: inherit manager env + task-scoped token file.
    const devTeamEnv: Record<string, string> = {
      ...this.opts.env,
      KRAKEN_TOKEN_FILE: tokenPath,
      KRAKEN_TASK_ID: taskId,
      KRAKEN_TASK_DIR: taskDir,
      ...(tentacleName ? { KRAKEN_TENTACLE_NAME: tentacleName } : {}),
    };

    // Build the system prompt for the dev team role.
    const userSlackId = this.currentRecord?.userSlackId ?? 'unknown';
    const userEmail =
      this.opts.env['KRAKEN_USER_EMAIL'] ?? 'unknown@example.com';
    const systemPrompt =
      role === 'builder'
        ? buildBuilderPrompt({
            enclaveName: this.opts.enclaveName,
            userSlackId,
            userEmail,
            taskDescription: goal,
          })
        : buildDeployerPrompt({
            enclaveName: this.opts.enclaveName,
            userSlackId,
            userEmail,
            taskDescription: goal,
          });

    const gitStateEnclaveDir = join(
      this.opts.gitStateDir,
      '..',
      '..',
      'enclaves',
      this.opts.enclaveName,
    );

    const spawnOpts: DevTeamSpawnOptions = {
      taskId,
      role,
      goal,
      tentacleName,
      taskDir,
      systemPrompt,
      env: devTeamEnv,
      piCliPath: this.opts.piCliPath,
      gitStateDir: existsSync(gitStateEnclaveDir)
        ? gitStateEnclaveDir
        : taskDir,
    };

    log.info(
      { enclaveName: this.opts.enclaveName, taskId, role },
      'team-bridge: spawning dev team subprocess',
    );

    // Emit task_started to signals-in before the subprocess starts.
    appendNdjson(this.signalsInPath, {
      type: 'task_started',
      taskId,
      timestamp: new Date().toISOString(),
    });

    const devProc = this.spawnDevTeamProcess(spawnOpts);
    // Swap the real process handle in over the placeholder.
    const handle: DevTeamHandle = { taskId, proc: devProc, terminated: false };
    this.devTeams.set(taskId, handle);

    devProc.on('exit', (code, exitSignal) => {
      log.info(
        {
          enclaveName: this.opts.enclaveName,
          taskId,
          code,
          signal: exitSignal,
        },
        'team-bridge: dev team subprocess exited',
      );
      this.devTeams.delete(taskId);

      // Event-driven terminal signal check (Finding 2):
      // On exit, do a single bounded scan of signals-in.ndjson to see if
      // the dev team already wrote a task_completed or task_failed before
      // exiting. This eliminates the 500ms polling race where a fast
      // successful exit could beat the old interval-based watcher and
      // trigger a spurious synthetic task_failed.
      if (!handle.terminated) {
        handle.terminated = this.taskHasTerminalSignal(taskId);
      }

      // If still no terminal signal found, synthesize task_failed.
      if (!handle.terminated) {
        const reason =
          exitSignal === 'SIGTERM'
            ? 'terminated by request'
            : `premature_exit (code=${String(code)})`;
        const failedSignal = makeTaskFailed({ taskId, error: reason });
        try {
          appendNdjson(this.signalsInPath, failedSignal);
        } catch (err) {
          log.warn(
            { enclaveName: this.opts.enclaveName, taskId, err },
            'team-bridge: could not write synthetic task_failed',
          );
        }
      }
    });

    devProc.stdout?.on('data', (chunk: Buffer) => {
      log.debug(
        {
          enclaveName: this.opts.enclaveName,
          taskId,
          stdout: chunk.toString('utf8').slice(0, 200),
        },
        'dev team stdout',
      );
    });

    devProc.stderr?.on('data', (chunk: Buffer) => {
      log.debug(
        {
          enclaveName: this.opts.enclaveName,
          taskId,
          stderr: chunk.toString('utf8').slice(0, 400),
        },
        'dev team stderr',
      );
    });
  }

  /**
   * Scan signals-in.ndjson for a terminal signal (task_completed or task_failed)
   * for the given taskId.
   *
   * Runs exactly once at child exit time — bounded scan of a small file.
   * Replaces the old 500ms polling interval (watchForTaskTermination).
   *
   * @returns true if a terminal signal for taskId is present in the file.
   */
  private taskHasTerminalSignal(taskId: string): boolean {
    try {
      if (!existsSync(this.signalsInPath)) return false;
      const content = readFileSync(this.signalsInPath, 'utf8');
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const rec = JSON.parse(trimmed) as Record<string, unknown>;
          if (
            rec['taskId'] === taskId &&
            (rec['type'] === 'task_completed' || rec['type'] === 'task_failed')
          ) {
            return true;
          }
        } catch {
          // skip malformed lines
        }
      }
    } catch {
      // best-effort — if file is unreadable, assume no terminal signal
    }
    return false;
  }

  /**
   * Spawn a dev team subprocess using the injected factory or real spawn().
   */
  private spawnDevTeamProcess(opts: DevTeamSpawnOptions): ChildProcess {
    if (this.opts.spawnDevTeam) {
      return this.opts.spawnDevTeam(opts);
    }
    // Real spawn: pi in print mode (non-interactive one-shot execution).
    // --print makes pi process the goal, run tools, and exit — no RPC loop needed.
    const args = [
      '--provider',
      this.opts.provider,
      '--model',
      this.opts.modelId,
      '--no-session',
      '--no-extensions',
      '--print',
      '--append-system-prompt',
      opts.systemPrompt,
      opts.goal,
    ];
    return spawn(this.opts.piCliPath, args, {
      cwd: opts.gitStateDir,
      env: opts.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
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
    // refreshTokenFile throws if no token is available (Should-fix #5).
    await this.refreshTokenFile(record);

    // Track the current record so dev team dispatch can access the user token.
    this.currentRecord = record;

    try {
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
    } finally {
      this.currentRecord = null;
    }
  }

  /**
   * C5: Write a fresh token.json to the team dir before each mailbox turn.
   *
   * Tries getTokenForUser callback first (which auto-refreshes if needed).
   * Falls back to the token in the mailbox record.
   *
   * Should-fix #5: if neither source produces a token, writes an outbound
   * re-auth prompt to the user AND throws to abort the current mailbox turn.
   */
  private async refreshTokenFile(record: MailboxRecord): Promise<void> {
    let token = record.userToken;

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

    // Should-fix #5: no token from either source — fail loudly.
    if (!token) {
      log.error(
        { enclaveName: this.opts.enclaveName, recordId: record.id },
        'team-bridge: no token available; aborting turn and prompting re-auth',
      );
      // Write outbound re-auth prompt directed at the user.
      const outbound: OutboundRecord = {
        id: randomUUID(),
        timestamp: new Date().toISOString(),
        type: 'error',
        channelId: record.channelId,
        threadTs: record.threadTs,
        text: 'Your session has expired. Please run the device auth flow again to re-authenticate before I can continue.',
      };
      try {
        appendNdjson(this.outboundPath, outbound);
      } catch {
        // best-effort
      }
      throw new Error(
        `no token for user ${record.userSlackId}; mailbox turn aborted`,
      );
    }

    const expiresIn = extractExpiresIn(token, log, this.opts.enclaveName);
    writeTokenFile(this.opts.teamDir, token, expiresIn);
    log.debug(
      { enclaveName: this.opts.enclaveName, expiresIn },
      'team-bridge: refreshed token.json',
    );
  }

  /** Write a user-facing re-auth prompt to outbound.ndjson. */
  private writeOutboundReauthPrompt(): void {
    if (!this.currentRecord) return;
    const outbound: OutboundRecord = {
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      type: 'error',
      channelId: this.currentRecord.channelId,
      threadTs: this.currentRecord.threadTs,
      text: 'Your session has expired. Please re-authenticate before I can start this task.',
    };
    try {
      appendNdjson(this.outboundPath, outbound);
    } catch {
      // best-effort
    }
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

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Extract expires_in from a JWT 'exp' claim.
 *
 * Should-fix #6: uses a 300s fallback (5 min) instead of 3600s so a
 * malformed token forces an early refresh rather than papering over
 * the issue for an hour.
 */
function extractExpiresIn(
  token: string,
  logger: Logger,
  enclaveName: string,
): number {
  try {
    const part = token.split('.')[1];
    if (part) {
      const payload = JSON.parse(
        Buffer.from(part, 'base64url').toString(),
      ) as Record<string, unknown>;
      const exp = payload['exp'];
      if (typeof exp === 'number') {
        const nowSeconds = Math.floor(Date.now() / 1000);
        return Math.max(exp - nowSeconds, 60); // at least 60s
      }
    }
  } catch (err) {
    // Should-fix #6: warn instead of silently swallowing; use 300s fallback.
    logger.warn(
      { enclaveName, err: err instanceof Error ? err.message : String(err) },
      'team-bridge: could not parse JWT exp; using 300s fallback',
    );
  }
  return 300;
}
