/**
 * TeamLifecycleManager — per-enclave team spawn, monitor, and GC (T10).
 *
 * Spawns a pi subprocess as the "manager" for each engaged enclave.
 * One manager per enclave; manager lives 30 minutes after last activity (D7).
 * On pod restart, all teams die — no state resume (D7).
 *
 * D6 enforcement:
 * - User's OIDC token passed in subprocess env as TNTC_ACCESS_TOKEN.
 * - Never a service token, never a fallback.
 * - Token expiry: caller responsibility (mailbox record with expired token).
 *
 * IPC: Dispatcher writes to mailbox.ndjson; manager reads it.
 * Teams write outbound.ndjson; OutboundPoller reads it.
 */

import { mkdirSync, readdirSync, statSync, rmSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import type Database from 'better-sqlite3';
import { createChildLogger } from '../logger.js';
import type { KrakenConfig } from '../config.js';
import { appendNdjson } from './ndjson.js';

const log = createChildLogger({ module: 'team-lifecycle' });

/** Idle timeout before sending SIGTERM to the manager. 30 minutes per D7. */
const IDLE_TIMEOUT_MS = 30 * 60 * 1000;

/** GC teams with state directories older than 7 days with no live PID. */
const GC_STALE_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000;

/** Per-enclave runtime state. */
interface TeamState {
  enclaveName: string;
  proc: ChildProcess;
  lastActivity: number;
  /** Map of slackUserId -> OIDC token, updated as messages arrive. */
  userTokens: Map<string, string>;
  /** The most recently active user's token (used as the token for next spawn). */
  currentToken: string;
  teamDir: string;
}

/** A record written to mailbox.ndjson by the dispatcher. */
export interface MailboxRecord {
  id: string;
  timestamp: string;
  from: 'dispatcher';
  type: 'user_message' | 'status_query' | 'shutdown';
  threadTs: string;
  channelId: string;
  userSlackId: string;
  /**
   * D6: User's OIDC token. ONLY in mailbox. Never in outbound or signals.
   * Empty string until the OIDC device flow is wired.
   * There is NO service token concept — only user tokens exist.
   */
  userToken: string;
  message: string;
}

/**
 * Resolve the path to the pi CLI binary.
 *
 * Per F20: use node_modules/.bin/pi (no global install required).
 * Resolved relative to this file's location in dist/.
 */
function resolvePiBinary(): string {
  // In production (compiled): dist/teams/lifecycle.js -> project root is ../../
  // In development (tsx): src/teams/lifecycle.ts -> project root is ../../
  // node_modules/.bin/pi is at project root / node_modules / .bin / pi
  return resolve(import.meta.dirname, '..', '..', 'node_modules', '.bin', 'pi');
}

/**
 * Ensure the team directory structure exists.
 *
 * Layout: {teamsDir}/{enclaveName}/
 *           mailbox.ndjson, outbound.ndjson, signals.ndjson
 *           memory/MEMORY.md  (persisted across team restarts)
 */
function ensureTeamDir(teamDir: string): void {
  mkdirSync(join(teamDir, 'memory'), { recursive: true });
}

/**
 * Set secure permissions on the mailbox file (0o600 — owner only).
 *
 * Called after the file is created. This protects the OIDC token embedded
 * in mailbox records per D6 / security review T18.
 */
async function securePath(path: string): Promise<void> {
  try {
    const { chmodSync } = await import('node:fs');
    chmodSync(path, 0o600);
  } catch {
    // Non-fatal: log and continue. File may not exist yet.
    log.warn({ path }, 'could not set mailbox permissions to 0600');
  }
}

/**
 * Manages per-enclave team subprocess lifecycle.
 *
 * One team per enclave. Spawns on first engagement, terminates on idle.
 * Provides sendToTeam() for the dispatcher to write to the mailbox.
 */
export class TeamLifecycleManager {
  private teams = new Map<string, TeamState>();
  private idleCheckInterval: NodeJS.Timeout;
  /** Called when a team exits so the outbound poller can drain final records. */
  private onTeamExited?: (enclaveName: string) => void;

  constructor(
    private readonly config: KrakenConfig,
    _db: Database.Database,
  ) {
    this.idleCheckInterval = setInterval(() => this.checkIdle(), 60_000);
    // Allow the process to exit even if the timer is pending
    this.idleCheckInterval.unref?.();
  }

  /**
   * Register a callback for when a team exits (Codex fix #3).
   * Used by the dispatcher to wire OutboundPoller.notifyTeamExited().
   */
  setOnTeamExited(cb: (enclaveName: string) => void): void {
    this.onTeamExited = cb;
  }

  /**
   * Spawn (or wake) a per-enclave team manager subprocess.
   *
   * If the team is already running, updates the token for the user
   * and refreshes the lastActivity timestamp. Otherwise spawns a new
   * manager process.
   *
   * D6: userToken is the initiating user's OIDC token. It is passed
   * to the subprocess via TNTC_ACCESS_TOKEN env var. NEVER a service token.
   *
   * @param enclaveName - Enclave name (becomes the team directory name).
   * @param initiatingUserId - Slack user ID of the user triggering the spawn.
   * @param userToken - OIDC access token for the initiating user.
   */
  async spawnTeam(
    enclaveName: string,
    initiatingUserId: string,
    userToken: string,
  ): Promise<void> {
    const existing = this.teams.get(enclaveName);
    if (existing) {
      // Team already running — update token + activity
      existing.userTokens.set(initiatingUserId, userToken);
      existing.currentToken = userToken;
      existing.lastActivity = Date.now();
      log.debug({ enclaveName }, 'team already active, refreshing activity');
      return;
    }

    const teamDir = join(this.config.teamsDir, enclaveName);
    ensureTeamDir(teamDir);

    const piPath = resolvePiBinary();
    // git-state layout: <repo>/enclaves/<enclave-name>/ — matches mirantis-tentacle-workflows
    const gitStateDir = join(this.config.gitState.dir, 'enclaves', enclaveName);

    // Construct a MINIMAL allow-listed env. Never spread process.env —
    // it would leak OIDC_CLIENT_SECRET, SLACK_BOT_TOKEN, and other
    // secrets into the subprocess (the builder has bash access).
    // D6: Only TNTC_ACCESS_TOKEN carries auth to MCP (per-user token).
    const subprocessEnv: Record<string, string> = {
      // System essentials
      PATH: process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin',
      HOME: process.env['HOME'] ?? '/home/node',
      NODE_ENV: process.env['NODE_ENV'] ?? 'production',
      // D6: User's OIDC token ONLY
      TNTC_ACCESS_TOKEN: userToken,
      // Depth guard (pi-subagents pattern)
      PI_SUBAGENT_DEPTH: '0',
      PI_SUBAGENT_MAX_DEPTH: '3',
      // Team directory for NDJSON IPC
      KRAKEN_TEAM_DIR: teamDir,
      KRAKEN_ENCLAVE_NAME: enclaveName,
      // LLM API key for the subprocess (it needs to call the LLM)
      ...(this.config.llm.anthropicApiKey
        ? { ANTHROPIC_API_KEY: this.config.llm.anthropicApiKey }
        : {}),
      ...(this.config.llm.openaiApiKey
        ? { OPENAI_API_KEY: this.config.llm.openaiApiKey }
        : {}),
      ...(this.config.llm.geminiApiKey
        ? { GEMINI_API_KEY: this.config.llm.geminiApiKey }
        : {}),
    };

    const proc = spawn(
      piPath,
      [
        '--mode',
        'json',
        '--provider',
        this.config.llm.defaultProvider,
        '--model',
        this.config.llm.defaultModel,
        '--cwd',
        gitStateDir,
      ],
      {
        cwd: gitStateDir,
        env: subprocessEnv,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );

    const state: TeamState = {
      enclaveName,
      proc,
      lastActivity: Date.now(),
      userTokens: new Map([[initiatingUserId, userToken]]),
      currentToken: userToken,
      teamDir,
    };
    this.teams.set(enclaveName, state);

    proc.on('exit', (code, signal) => {
      log.info({ enclaveName, code, signal }, 'team manager exited');
      this.teams.delete(enclaveName);
      // Notify poller so it drains final outbound records (Codex fix #3)
      this.onTeamExited?.(enclaveName);
    });

    proc.on('error', (err) => {
      log.error({ enclaveName, err }, 'team manager process error');
      this.teams.delete(enclaveName);
      this.onTeamExited?.(enclaveName);
    });

    // Drain stderr to prevent buffer blocking
    proc.stderr?.on('data', (chunk: Buffer) => {
      log.debug(
        { enclaveName, stderr: chunk.toString('utf8').slice(0, 200) },
        'team stderr',
      );
    });

    log.info(
      { enclaveName, teamDir, userId: initiatingUserId },
      'team spawned',
    );
  }

  /**
   * Returns true if an active manager subprocess is running for this enclave.
   */
  isTeamActive(enclaveName: string): boolean {
    return this.teams.has(enclaveName);
  }

  /**
   * Returns the names of all active enclave teams (those with a running
   * manager subprocess). Used by OutboundPoller to know which team
   * directories to poll.
   */
  getActiveTeamNames(): string[] {
    return Array.from(this.teams.keys());
  }

  /**
   * Write a mailbox record to the team's mailbox.ndjson.
   *
   * Also updates the team's last-activity timestamp to reset the idle clock.
   * Secures mailbox file permissions to 0o600 after creation (D6).
   *
   * D6: The record may contain a userToken. It is the caller's responsibility
   * to ensure tokens are ONLY in mailbox records, never in outbound/signals.
   *
   * @param enclaveName - Target team's enclave name.
   * @param record - The mailbox record to append.
   */
  async sendToTeam(enclaveName: string, record: MailboxRecord): Promise<void> {
    const teamDir = join(this.config.teamsDir, enclaveName);
    ensureTeamDir(teamDir);

    const mailboxPath = join(teamDir, 'mailbox.ndjson');
    appendNdjson(mailboxPath, record);

    // Defense-in-depth: re-enforce 0o600 even though appendNdjson already
    // creates the file with secure permissions (Codex fix #4).
    await securePath(mailboxPath);

    const team = this.teams.get(enclaveName);
    if (team) {
      team.lastActivity = Date.now();
      if (record.userToken) {
        team.userTokens.set(record.userSlackId, record.userToken);
        team.currentToken = record.userToken;
      }
    }
  }

  /**
   * Gracefully shut down all active teams.
   *
   * Sends SIGTERM to each manager subprocess and waits for them to exit.
   * Called on SIGTERM/SIGINT (D7: pod restart = all teams die).
   */
  async shutdownAll(): Promise<void> {
    clearInterval(this.idleCheckInterval);

    const shutdowns: Promise<void>[] = [];
    for (const [name, state] of this.teams) {
      log.info({ enclaveName: name }, 'sending SIGTERM to team manager');
      const p = new Promise<void>((resolve) => {
        state.proc.once('exit', () => resolve());
        state.proc.kill('SIGTERM');
        // Force kill after 5s
        setTimeout(() => {
          if (!state.proc.killed) state.proc.kill('SIGKILL');
          resolve();
        }, 5000).unref?.();
      });
      shutdowns.push(p);
    }

    await Promise.all(shutdowns);
    this.teams.clear();
    log.info('all teams shut down');
  }

  /**
   * GC stale team directories (> 7 days old with no live PID).
   *
   * Called periodically or on startup. Leaves directories of active teams.
   */
  gcStaleTeams(): void {
    const teamsDir = this.config.teamsDir;

    if (!existsSync(teamsDir)) return;

    let entries: string[];
    try {
      entries = readdirSync(teamsDir);
    } catch {
      return;
    }

    const now = Date.now();
    for (const name of entries) {
      // Skip active teams
      if (this.teams.has(name)) continue;

      const dir = join(teamsDir, name);
      try {
        const stat = statSync(dir);
        const ageMs = now - stat.mtimeMs;
        if (ageMs > GC_STALE_THRESHOLD_MS) {
          rmSync(dir, { recursive: true, force: true });
          log.info(
            { enclaveName: name, ageMs },
            'GC: removed stale team directory',
          );
        }
      } catch {
        // Non-fatal — directory may have been removed by another process
      }
    }
  }

  private checkIdle(): void {
    const now = Date.now();
    for (const [name, state] of this.teams) {
      if (now - state.lastActivity > IDLE_TIMEOUT_MS) {
        log.info(
          { enclaveName: name, idleMs: now - state.lastActivity },
          'idle timeout, sending SIGTERM',
        );
        state.proc.kill('SIGTERM');
        this.teams.delete(name);
      }
    }
  }
}
