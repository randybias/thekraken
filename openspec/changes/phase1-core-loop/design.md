# Phase 1: Core Loop — Design (Revised: Dispatcher + Per-Enclave Team Architecture)

**Change ID:** phase1-core-loop
**Status:** DRAFT (Architectural Pivot)
**Created:** 2026-04-13
**Revised:** 2026-04-13
**Author:** Senior Architect

---

## 0. Why This Revision Exists

The original Phase 1 design treated the Kraken as a custom daemon that uses
`pi-agent-core`'s bare `Agent` class directly and implements its own extension
system. That was architecturally wrong. The Kraken is a **specialized
pi-coding-agent running in a custom "Slack mode."** 50% of its job is WRITING
TENTACLES (coding). The full `pi-coding-agent` runtime — including
`createAgentSession()`, the `ExtensionRunner`, filesystem tools (read, bash,
edit, write), session management — is the right foundation.

Additionally, the original design used per-thread Agent instances within a
single process. The revised architecture uses **per-enclave teams** spawned as
subprocesses, following the patterns established by `pi-mono-team-mode` (v1.6.0)
and `pi-subagents` (v0.13.4).

### Locked Decisions (Not Relitigated Here)

- **D1:** Kraken-owned Slack mode. NOT upstreamed to pi-mono.
- **D2:** Per-enclave team granularity (not per-thread).
- **D3:** Dispatcher owns ALL Slack I/O. Teams write to `outbound.ndjson`.
- **D4:** Hybrid dispatcher with named deterministic/smart code paths.
- **D5:** Heartbeat updates: manager-driven, 30-60s floor, friendly format.
- **D6:** User identity hard partition. No service identity for enclave work.
- **D7:** Pod restart = all teams die. Fresh state. 30-min idle timeout.
- **D8:** Full pi-coding-agent extension system. Standard pi extensions.

### Conventions Carried From Phase 0

- Conventional Commits on `feature/phase1-core-loop`
- Commit after each task group passes `npm test && npx tsc --noEmit`
- No code in `src/` without a corresponding test in `test/unit/`
- Multi-error throw pattern for config validation
- Express-compatible health handler composition

---

## 1. Architecture Overview

### 1.1 Three-Tier Process Model

```
                     Slack (Events API / Socket Mode)
                              |
              +===============================+
              |      DISPATCHER (Tier 1)      |
              |  Singleton Node.js process    |
              |  pi AgentSession in custom    |
              |  "slack" mode                 |
              |                               |
              |  - Slack Bolt socket owner    |
              |  - Deterministic event router |
              |  - LLM path for ambiguous     |
              |    events (DMs, novel input)  |
              |  - Team lifecycle manager     |
              |  - Outbound poller + poster   |
              +===============================+
                    |                |
         spawn on first      poll outbound.ndjson
         engagement          post to Slack
                    |                |
     +==============v================v=========+
     |      PER-ENCLAVE TEAM (Tier 2)          |
     |  ~/.pi/teams/{enclaveName}/             |
     |                                         |
     |  MANAGER subprocess (long-lived)        |
     |    pi AgentSession, role="manager"      |
     |    - Holds thread contexts              |
     |    - Accumulates enclave MEMORY.md      |
     |    - Reads mailbox.ndjson (dispatcher)  |
     |    - Writes outbound.ndjson (to Slack)  |
     |    - Writes signals.ndjson (progress)   |
     |    - Spawns builder/deployer per task   |
     |    - 30-min idle timeout -> exit        |
     +=========================================+
                    |
         spawn per task, exit when done
                    |
     +==============v==========================+
     |    TASK SUBPROCESS (Tier 3)             |
     |                                         |
     |  BUILDER: pi AgentSession, role="builder"|
     |    - Full coding tools (read/bash/edit) |
     |    - Writes tentacle code               |
     |    - Writes completion signal           |
     |                                         |
     |  DEPLOYER: pi AgentSession, role="deployer"|
     |    - Git-state deploy flow              |
     |    - MCP wf_apply call                  |
     |    - Writes completion signal           |
     +=========================================+
```

### 1.2 Where Pi Libraries Live

| Component | Pi Package | Usage |
|-----------|-----------|-------|
| Dispatcher | `pi-coding-agent` | `createAgentSession()` with custom Slack mode, `ExtensionRunner` for tool scoping + jargon filter + context injection |
| Manager | `pi-coding-agent` | `createAgentSession()` in RPC mode with enclave-specific config, team orchestration via `pi-mono-team-mode` patterns |
| Builder | `pi-coding-agent` | `createAgentSession()` in print mode, full coding tools (`read`, `bash`, `edit`, `write`) |
| Deployer | `pi-coding-agent` | `createAgentSession()` in print mode, MCP tools + git tools |

### 1.3 What `pi-mono-team-mode` Provides (Reference, Not Direct Import)

After reading `pi-mono-team-mode` v1.6.0, its key patterns:

1. **TeamStore + managers** — filesystem-backed persistence (`team.json`,
   `tasks.json`, `signals.ndjson`, `mailbox.ndjson`, `approvals.json`)
2. **Leader runtime** — spawns teammate pi subprocesses via `child_process.spawn`,
   collects output via JSON mode parsing, emits signals
3. **Signal types** — `team_started`, `task_created`, `task_assigned`,
   `task_started`, `progress_update`, `task_completed`, `team_completed`, `error`
4. **Mailbox protocol** — structured `MailboxMessage` with `from`, `to`, `taskId`,
   `type`, `message`, `attachments`

We adopt the **filesystem protocol** (ndjson files) and **signal type taxonomy**
but NOT the library itself. Reasons:

- `pi-mono-team-mode`'s `LeaderRuntime` is designed for interactive Pi sessions
  with TUI widgets. The Kraken's manager runs headless with Slack output.
- The team-mode's approval flow assumes a human at a TUI. Our approval flow is
  Slack-mediated.
- The library's `TeamStore` paths don't match our `~/.pi/teams/{enclave}/` layout.

We write a Kraken-specific `TeamLifecycleManager` that follows the same
filesystem conventions but integrates with Slack I/O.

### 1.4 What `pi-subagents` Provides (Reference Pattern)

After reading `pi-subagents` v0.13.4:

1. **Subprocess spawning** — `subagent-runner.ts` spawns pi processes via
   `child_process.spawn` with `--mode json` for structured output
2. **Sync vs async** — sync blocks parent until child exits; async (detached)
   spawns and polls result files
3. **Depth guard** — `PI_SUBAGENT_DEPTH` env var prevents infinite recursion
4. **Result collection** — stdout JSON event parsing for final assistant text

We adopt the **subprocess spawn pattern** (Node `child_process.spawn` with
`--mode json` flag) and the **depth guard** convention. We do NOT import
`pi-subagents` as a dependency — it is an extension designed for the interactive
Pi TUI, not for headless Slack-mediated use.

---

## 2. Dispatcher Design

### 2.1 Boot Sequence

The dispatcher is the Kraken's main process. It boots as a pi-coding-agent
`AgentSession` in a custom "slack" mode.

```typescript
// src/index.ts — Dispatcher boot sequence

import { createAgentSession, codingTools } from '@mariozechner/pi-coding-agent';
import { SessionManager } from '@mariozechner/pi-coding-agent/core/session-manager.js';
import { loadConfig } from './config.js';
import { initTelemetry, shutdownTelemetry } from './telemetry.js';
import { logger } from './logger.js';
import { initDatabase } from './db/index.js';
import { createSlackBot } from './slack/bot.js';
import { TeamLifecycleManager } from './teams/lifecycle.js';
import { OutboundPoller } from './teams/outbound-poller.js';
import { EnclaveBindingEngine } from './enclave/binding.js';
import { loadDispatcherExtensions } from './extensions/dispatcher-extensions.js';

async function main(): Promise<void> {
  // 1. Load config (fail fast with all missing vars)
  const config = loadConfig();

  // 2. Initialize OTel
  initTelemetry();

  // 3. Initialize SQLite
  const db = initDatabase(config);

  // 4. Create dispatcher's pi AgentSession
  //    Custom "slack" mode: no TUI, no stdin, extensions loaded
  const { session, extensionsResult } = await createAgentSession({
    cwd: config.gitState.dir, // Workspace is the git-state repo
    tools: [],                 // Dispatcher has NO coding tools — it routes, not codes
    customTools: buildDispatcherTools(config, db),
    sessionManager: SessionManager.inMemory(), // Dispatcher doesn't persist its own sessions
  });

  // 5. Load Kraken extensions on the session
  await session.bindExtensions({
    onError: (err) => logger.error({ err }, 'extension error'),
  });

  // 6. Create subsystems
  const bindings = new EnclaveBindingEngine(db);
  const teams = new TeamLifecycleManager(config, db, bindings);
  const poller = new OutboundPoller(config, teams);

  // 7. Create and start Slack bot (passes dispatcher session for smart path)
  const bot = createSlackBot({ config, session, teams, bindings, db });
  await bot.start();

  // 8. Start outbound polling (reads outbound.ndjson from teams, posts to Slack)
  poller.start();

  // 9. Log startup banner
  logger.info({
    version: '2.0.0',
    mode: config.slack.mode,
    mcpUrl: config.mcp.url,
    enclaves: bindings.count(),
  }, 'The Kraken v2 started (dispatcher mode)');

  // 10. Shutdown handler
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');
    try {
      poller.stop();
      await bot.stop();
      await teams.shutdownAll();
      db.close();
      await shutdownTelemetry();
    } catch (err) {
      logger.error({ err }, 'error during shutdown');
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  logger.fatal({ err }, 'startup failed');
  process.exit(1);
});
```

### 2.2 Why createAgentSession() Instead of Bare Agent

The original design used `new Agent()` from `pi-agent-core` directly. This was
wrong for two reasons:

1. **Extensions.** Pi's `ExtensionRunner` lives in `pi-coding-agent` and is
   bound to `AgentSession`. Tool scoping, jargon filtering, and context
   injection are standard pi extensions loaded via `session.bindExtensions()`.
   Without `AgentSession`, none of this works.

2. **Coding capability.** 50% of the Kraken's job is writing tentacles. The
   builder subprocesses need `read`, `bash`, `edit`, `write` tools from
   `pi-coding-agent`. Using bare `Agent` would require reimplementing all
   tool definitions.

The dispatcher itself has NO coding tools (it routes, not codes). But it uses
`createAgentSession()` for its LLM smart path and extension support.

### 2.3 Dispatcher Tool Set

The dispatcher has its own custom tools (NOT MCP tools — those are for
per-enclave teams):

```typescript
// src/tools/dispatcher-tools.ts

import type { ToolDefinition } from '@mariozechner/pi-coding-agent';

export function buildDispatcherTools(
  config: KrakenConfig,
  db: Database.Database,
): ToolDefinition[] {
  return [
    {
      name: 'spawn_enclave_team',
      description: 'Spawn or wake a per-enclave team for the given enclave. Returns team status.',
      parameters: {
        type: 'object',
        properties: {
          enclaveName: { type: 'string', description: 'Enclave name' },
          userSlackId: { type: 'string', description: 'Slack user ID of initiator' },
          userToken: { type: 'string', description: 'User OIDC access token' },
        },
        required: ['enclaveName', 'userSlackId', 'userToken'],
      },
      execute: async (params) => {
        // Implementation delegates to TeamLifecycleManager
      },
    },
    {
      name: 'send_to_team',
      description: 'Send a message to an enclave team manager via its mailbox.',
      parameters: {
        type: 'object',
        properties: {
          enclaveName: { type: 'string' },
          threadTs: { type: 'string', description: 'Slack thread timestamp for context' },
          message: { type: 'string', description: 'Message text to forward' },
          userSlackId: { type: 'string' },
          userToken: { type: 'string' },
        },
        required: ['enclaveName', 'threadTs', 'message', 'userSlackId', 'userToken'],
      },
      execute: async (params) => {
        // Append to ~/.pi/teams/{enclave}/mailbox.ndjson
      },
    },
    {
      name: 'check_team_status',
      description: 'Check the status of an enclave team (running, idle, dead).',
      parameters: {
        type: 'object',
        properties: { enclaveName: { type: 'string' } },
        required: ['enclaveName'],
      },
      execute: async (params) => {
        // Read team process state
      },
    },
    {
      name: 'post_to_slack',
      description: 'Post a message to a Slack channel or thread.',
      parameters: {
        type: 'object',
        properties: {
          channelId: { type: 'string' },
          threadTs: { type: 'string' },
          text: { type: 'string' },
        },
        required: ['channelId', 'text'],
      },
      execute: async (params) => {
        // Direct Slack WebClient call (dispatcher owns Slack I/O)
      },
    },
  ];
}
```

### 2.4 Event Handler Structure

```typescript
// src/slack/bot.ts — Event registration

function registerEventHandlers(app: App, deps: SlackBotDeps): void {
  // app_mention — primary entry point for enclave channels
  app.event('app_mention', async ({ event, say }) => {
    if ('bot_id' in event) return;
    const result = routeEvent({
      type: 'app_mention',
      channelId: event.channel,
      threadTs: event.thread_ts ?? event.ts,
      userId: event.user ?? '',
      text: event.text ?? '',
    }, deps);
    await executeRouteResult(result, say, deps);
  });

  // message — DMs and thread replies
  app.event('message', async ({ event, say }) => {
    if ('subtype' in event && event.subtype) return;
    if (!('user' in event)) return;
    if ('bot_id' in event) return;
    const result = routeEvent({
      type: 'message',
      channelId: event.channel,
      channelType: event.channel_type,
      threadTs: ('thread_ts' in event ? event.thread_ts : undefined) as string | undefined,
      userId: event.user as string,
      text: (('text' in event ? event.text : undefined) as string) ?? '',
    }, deps);
    await executeRouteResult(result, say, deps);
  });

  // app_home_opened — Home Tab rendering
  app.event('app_home_opened', async ({ event, client }) => {
    // Phase 4: render Home Tab via Block Kit
  });

  // channel_archive, channel_rename, member_left_channel
  // Phase 3: channel lifecycle events
}
```

### 2.5 Deterministic vs Smart Routing (D4)

The dispatcher has two CLEARLY SEPARATED code paths. The admission criteria
are defined here as a named contract — the "RouteDecision" type.

```typescript
// src/dispatcher/router.ts

export type RouteDecision =
  | { path: 'deterministic'; action: DeterministicAction }
  | { path: 'smart'; reason: string; context: SmartContext };

export type DeterministicAction =
  | { type: 'spawn_and_forward'; enclaveName: string }
  | { type: 'enclave_sync_add'; targetUserId: string }
  | { type: 'enclave_sync_remove'; targetUserId: string }
  | { type: 'drift_sync'; channelId: string }
  | { type: 'ignore_unbound' }
  | { type: 'ignore_bot' }
  | { type: 'ignore_visitor' }
  | { type: 'forward_to_active_team'; enclaveName: string };

export interface SmartContext {
  eventType: string;
  channelId: string;
  threadTs: string;
  userId: string;
  text: string;
  enclaveName: string | null;
  mode: 'enclave' | 'dm';
}

/**
 * Route a Slack event to either the deterministic or smart code path.
 *
 * DETERMINISTIC PATH admission criteria (exhaustive list):
 *   1. @mention in enclave-bound channel with active team -> forward_to_active_team
 *   2. @mention in enclave-bound channel without active team -> spawn_and_forward
 *   3. "@kraken add @user" pattern (word after verb is @mention) -> enclave_sync_add
 *   4. "@kraken remove @user" pattern -> enclave_sync_remove
 *   5. Message in unbound channel -> ignore_unbound
 *   6. Bot/self message -> ignore_bot
 *   7. member_left_channel event -> drift_sync
 *   8. Thread reply in active team's channel -> forward_to_active_team
 *
 * SMART PATH admission criteria (anything not matched above):
 *   1. DM from authenticated user (cross-enclave query)
 *   2. Ambiguous @mention (cannot parse as command)
 *   3. Status check requests ("how's it going?")
 *   4. Novel phrasing that doesn't match deterministic patterns
 *   5. Help requests that need contextual response
 *
 * The smart path invokes the dispatcher's own pi AgentSession with the
 * dispatcher tools (spawn_enclave_team, send_to_team, check_team_status,
 * post_to_slack) and the event context in the prompt.
 */
export function routeEvent(event: InboundEvent, deps: SlackBotDeps): RouteDecision {
  // 1. Bot/self filter
  if (event.botId) return { path: 'deterministic', action: { type: 'ignore_bot' } };

  // 2. Unbound channel filter
  const binding = deps.bindings.lookupEnclave(event.channelId);
  if (!binding && event.channelType !== 'im') {
    return { path: 'deterministic', action: { type: 'ignore_unbound' } };
  }

  // 3. Command parsing (deterministic commands)
  const command = parseCommand(event.text);
  if (command) {
    return { path: 'deterministic', action: command };
  }

  // 4. Enclave-bound @mention or thread reply -> spawn/forward
  if (binding) {
    const teamActive = deps.teams.isTeamActive(binding.enclaveName);
    if (teamActive) {
      return { path: 'deterministic', action: {
        type: 'forward_to_active_team',
        enclaveName: binding.enclaveName,
      }};
    }
    return { path: 'deterministic', action: {
      type: 'spawn_and_forward',
      enclaveName: binding.enclaveName,
    }};
  }

  // 5. Everything else -> smart path (DMs, ambiguous, novel)
  return {
    path: 'smart',
    reason: event.channelType === 'im' ? 'dm_query' : 'ambiguous_input',
    context: {
      eventType: event.type,
      channelId: event.channelId,
      threadTs: event.threadTs ?? '',
      userId: event.userId,
      text: event.text,
      enclaveName: binding?.enclaveName ?? null,
      mode: event.channelType === 'im' ? 'dm' : 'enclave',
    },
  };
}
```

### 2.6 Smart Path: Dispatcher LLM Invocation

When the smart path is taken, the dispatcher's own `AgentSession` is prompted.
The session has access to `spawn_enclave_team`, `send_to_team`,
`check_team_status`, and `post_to_slack` tools.

```typescript
// In executeRouteResult() for smart path:
async function executeSmartPath(
  ctx: SmartContext,
  session: AgentSession,
  say: SayFn,
): Promise<void> {
  const prompt = [
    `A Slack event needs your reasoning to handle:`,
    `Event type: ${ctx.eventType}`,
    `Channel: ${ctx.channelId} (${ctx.mode} mode)`,
    `Thread: ${ctx.threadTs}`,
    `User: ${ctx.userId}`,
    `Enclave: ${ctx.enclaveName ?? 'none (DM)'}`,
    `Message: "${ctx.text}"`,
    ``,
    `Decide what to do. If this is a question you can answer directly (status`,
    `check, help request, cross-enclave query in DM), answer it. If this needs`,
    `an enclave team to handle (coding, deployment, workflow operation), use`,
    `spawn_enclave_team and send_to_team. Always respond to the user via`,
    `post_to_slack.`,
  ].join('\n');

  await session.prompt(prompt);
}
```

### 2.7 DM Handling

DMs are handled by the dispatcher's smart path, NOT by per-enclave teams.
Cross-enclave queries ("what's the health of all my enclaves?") require
reading across team boundaries, which a single-enclave team cannot do.

The dispatcher's smart path has access to `check_team_status` for all enclaves
and can aggregate results. If a DM is clearly about a single enclave
("deploy to marketing-analytics"), the dispatcher spawns/forwards to that
enclave's team.

---

## 3. Per-Enclave Team Design

### 3.1 Manager Subprocess

The manager is a long-lived `pi` subprocess spawned by the dispatcher on first
engagement with an enclave. It uses `pi-coding-agent` in RPC mode for
structured I/O.

**Lifecycle:**
1. Dispatcher calls `TeamLifecycleManager.spawnTeam(enclaveName, userToken)`
2. Manager process starts: `pi --mode json --cwd {gitStateDir}/{enclaveName}/`
3. Manager loads system prompt with enclave context + tentacular skill
4. Manager enters a poll loop reading `mailbox.ndjson` for new messages
5. When a message arrives, manager processes it:
   - Simple query → answer directly, write to `outbound.ndjson`
   - Coding task → spawn builder subprocess, monitor via `signals.ndjson`
   - Deploy task → spawn deployer subprocess, monitor via `signals.ndjson`
6. Idle 30 minutes → manager writes `team_completed` signal and exits

**Spawn signature:**

```typescript
// src/teams/lifecycle.ts

import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';

interface TeamState {
  enclaveName: string;
  proc: ChildProcess;
  lastActivity: number;
  userTokens: Map<string, string>;  // slackUserId -> OIDC token
}

export class TeamLifecycleManager {
  private teams = new Map<string, TeamState>();
  private idleCheckInterval: NodeJS.Timeout;

  constructor(
    private config: KrakenConfig,
    private db: Database.Database,
    private bindings: EnclaveBindingEngine,
  ) {
    this.idleCheckInterval = setInterval(() => this.checkIdle(), 60_000);
    this.idleCheckInterval.unref?.();
  }

  async spawnTeam(
    enclaveName: string,
    initiatingUserId: string,
    userToken: string,
  ): Promise<void> {
    if (this.teams.has(enclaveName)) {
      // Team already running — just update token
      this.teams.get(enclaveName)!.userTokens.set(initiatingUserId, userToken);
      this.teams.get(enclaveName)!.lastActivity = Date.now();
      return;
    }

    const teamDir = join(this.config.teamsDir, enclaveName);
    await ensureTeamDirs(teamDir);

    // Spawn manager as a pi subprocess in JSON (RPC) mode
    const piCmd = getPiInvocation([
      '--mode', 'json',
      '--cwd', join(this.config.gitState.dir, enclaveName),
      '-p', buildManagerPrompt(enclaveName, this.config),
    ]);

    const proc = spawn(piCmd.command, piCmd.args, {
      cwd: join(this.config.gitState.dir, enclaveName),
      env: {
        ...process.env,
        // D6: User's OIDC token, NOT a service token
        TNTC_ACCESS_TOKEN: userToken,
        // Depth guard (pi-subagents pattern)
        PI_SUBAGENT_DEPTH: '0',
        PI_SUBAGENT_MAX_DEPTH: '3',
        // Team directory for filesystem protocol
        KRAKEN_TEAM_DIR: teamDir,
        KRAKEN_ENCLAVE_NAME: enclaveName,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const state: TeamState = {
      enclaveName,
      proc,
      lastActivity: Date.now(),
      userTokens: new Map([[initiatingUserId, userToken]]),
    };
    this.teams.set(enclaveName, state);

    // Monitor process exit
    proc.on('exit', (code) => {
      logger.info({ enclaveName, code }, 'team manager exited');
      this.teams.delete(enclaveName);
    });
  }

  isTeamActive(enclaveName: string): boolean {
    return this.teams.has(enclaveName);
  }

  async sendToTeam(
    enclaveName: string,
    message: MailboxRecord,
  ): Promise<void> {
    const teamDir = join(this.config.teamsDir, enclaveName);
    await appendNdjson(join(teamDir, 'mailbox.ndjson'), message);
    const team = this.teams.get(enclaveName);
    if (team) team.lastActivity = Date.now();
  }

  private checkIdle(): void {
    const IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes (D7)
    const now = Date.now();
    for (const [name, state] of this.teams) {
      if (now - state.lastActivity > IDLE_TIMEOUT_MS) {
        logger.info({ enclaveName: name }, 'team idle timeout, killing');
        state.proc.kill('SIGTERM');
        this.teams.delete(name);
      }
    }
  }

  async shutdownAll(): Promise<void> {
    clearInterval(this.idleCheckInterval);
    for (const [, state] of this.teams) {
      state.proc.kill('SIGTERM');
    }
    this.teams.clear();
  }
}
```

### 3.2 Manager System Prompt

```typescript
function buildManagerPrompt(enclaveName: string, config: KrakenConfig): string {
  return [
    '# Role: Enclave Manager',
    '',
    `You are the manager for the "${enclaveName}" enclave in Tentacular.`,
    'You orchestrate work for this enclave: answering questions, delegating',
    'coding tasks to builders, and delegating deploy tasks to deployers.',
    '',
    '## Your Responsibilities',
    '- Answer questions about workflows in this enclave using MCP tools',
    '- Delegate coding tasks to builder subprocesses',
    '- Delegate deploy tasks to deployer subprocesses',
    '- Monitor task progress via signals and emit heartbeats',
    '- Maintain enclave MEMORY.md with accumulated context',
    '',
    '## Communication Protocol',
    '- Read mailbox.ndjson for incoming messages from the dispatcher',
    '- Write outbound.ndjson for messages to post to Slack',
    '- Read signals.ndjson from builder/deployer for progress updates',
    '- Emit heartbeat outbound messages per the heartbeat protocol (Section 8)',
    '',
    '## Identity',
    `- You run with the initiating user's OIDC token`,
    '- Every MCP call, every git operation is attributed to that user',
    '- You have NO service identity. If the token expires, FAIL and report.',
    '',
    '## Tools Available',
    '- All MCP tools (ENCLAVE_SCOPED filtered to this enclave)',
    '- read, bash, grep, find (for examining tentacle source)',
    '- NO edit, write tools (builders do the writing)',
    '',
    '# Tentacular Skill (injected below)',
    '---',
    // Skill content loaded at runtime from skills/ directory
  ].join('\n');
}
```

### 3.3 Builder Subprocess

Spawned by the manager when a coding task is needed. Uses `pi-coding-agent` in
print mode (`-p "task description"`).

```typescript
// Manager spawns builder:
const builder = spawn(piCmd.command, [
  ...piCmd.args,
  '--mode', 'json',
  '--cwd', join(gitStateDir, enclaveName),
  '-p', `Write tentacle code for: ${taskDescription}`,
], {
  env: {
    ...process.env,
    TNTC_ACCESS_TOKEN: userToken,  // D6: user's token
    PI_SUBAGENT_DEPTH: String(currentDepth + 1),
    PI_SUBAGENT_MAX_DEPTH: '3',
    KRAKEN_TEAM_DIR: teamDir,
    KRAKEN_ROLE: 'builder',
  },
  stdio: ['pipe', 'pipe', 'pipe'],
});
```

Builder has full coding tools (`read`, `bash`, `edit`, `write`) and exits when
its task completes. On exit, it writes a `task_completed` signal to
`signals.ndjson`.

### 3.4 Deployer Subprocess

Similar to builder but specialized for the git-state deploy flow:

1. Validate tentacle code is clean (`git status`)
2. Run `tntc deploy` with the user's token
3. Git commit + tag + push (monotonic version)
4. MCP `wf_apply` with version + git_sha (Phase 4 cross-repo work)
5. Write `task_completed` signal

The deployer has NO edit/write tools — it only runs git and MCP operations.

---

## 4. Communication Protocols

### 4.1 Filesystem Layout

```
~/.pi/teams/
  {enclaveName}/
    mailbox.ndjson       # dispatcher -> manager (inbound)
    outbound.ndjson      # manager -> dispatcher (outbound to Slack)
    signals.ndjson       # builder/deployer -> manager (progress)
    team.json            # team metadata (status, created_at, etc.)
    memory/
      MEMORY.md          # enclave-accumulated context
    builder/
      outputs/           # builder artifacts
    deployer/
      outputs/           # deployer artifacts
```

### 4.2 mailbox.ndjson (Dispatcher -> Manager)

Each line is a JSON record:

```typescript
interface MailboxRecord {
  id: string;            // UUID v4
  timestamp: string;     // ISO 8601
  from: 'dispatcher';
  type: 'user_message' | 'status_query' | 'shutdown';
  threadTs: string;      // Slack thread for context
  channelId: string;     // For outbound routing
  userSlackId: string;   // Who sent the message
  userToken: string;     // D6: user's OIDC token (see Section 5)
  message: string;       // The user's text
}
```

### 4.3 outbound.ndjson (Manager -> Dispatcher)

```typescript
interface OutboundRecord {
  id: string;            // UUID v4
  timestamp: string;     // ISO 8601
  type: 'slack_message' | 'heartbeat' | 'error';
  channelId: string;     // Where to post
  threadTs: string;      // Thread to reply in
  text: string;          // Message content (plain text or Block Kit JSON)
  mentionUser?: string;  // Optional: @mention this user in the message
}
```

### 4.4 signals.ndjson (Builder/Deployer -> Manager)

Follows `pi-mono-team-mode`'s Signal type taxonomy:

```typescript
interface SignalRecord {
  id: string;
  timestamp: string;
  source: 'builder' | 'deployer';
  type: 'task_started' | 'progress_update' | 'task_completed' | 'error';
  severity: 'info' | 'warning' | 'error';
  taskId: string;
  message: string;       // Human-readable description
  artifacts: string[];   // File paths produced
}
```

### 4.5 Concurrency Model

**Append-only semantics.** All ndjson files are append-only. Writers append
complete lines atomically (Node.js `fs.appendFileSync` with `\n`-terminated
JSON is atomic for lines under the OS pipe buffer size, typically 4KB — our
records are well under this).

**Reader coordination:** Readers track their position via a byte offset stored
in memory. They `fs.read()` from the last offset, parse new lines, advance.
No file locking needed.

```typescript
// src/teams/ndjson.ts

import { appendFileSync, openSync, readSync, statSync, closeSync } from 'node:fs';

export function appendNdjson(path: string, record: object): void {
  appendFileSync(path, JSON.stringify(record) + '\n', 'utf8');
}

export class NdjsonReader {
  private offset = 0;
  private buffer = '';

  constructor(private path: string) {}

  readNew(): object[] {
    let fd: number;
    try {
      fd = openSync(this.path, 'r');
    } catch {
      return []; // File doesn't exist yet
    }
    try {
      const stat = statSync(this.path);
      if (stat.size <= this.offset) return [];

      const buf = Buffer.alloc(stat.size - this.offset);
      readSync(fd, buf, 0, buf.length, this.offset);
      this.offset = stat.size;

      const text = this.buffer + buf.toString('utf8');
      const lines = text.split('\n');
      this.buffer = lines.pop() ?? ''; // Last element may be incomplete

      return lines
        .filter(l => l.trim())
        .map(l => JSON.parse(l));
    } finally {
      closeSync(fd);
    }
  }
}
```

### 4.6 Token in Mailbox (D6 Security Analysis)

**Decision: Embed token in mailbox records, NOT in a file.**

Rejected alternative: `user-token.secure` file per team directory.

Reasons for mailbox-embedded tokens:

1. **Per-interaction identity.** Different users may interact with the same
   enclave team. A single `user-token.secure` file can only hold one token.
   Mailbox records carry the initiating user's token per-message, supporting
   multi-user conclave interaction.

2. **No stale file risk.** A token file could persist after the team dies,
   sitting on the PVC with a valid refresh token. Mailbox records are
   consumed and forgotten.

3. **Simpler lifecycle.** The manager reads the token from the mailbox record
   and passes it to `TNTC_ACCESS_TOKEN` in the subprocess env. No file read,
   no race with the dispatcher writing.

**Security constraints:**
- `mailbox.ndjson` file permissions: `0o600` (only the Node process user)
- Tokens are NEVER logged, NEVER included in signals or outbound records
- PVC persistence: mailbox files survive team death (D7 forensics) but are
  GC'd after 7 days. The tokens inside will have expired (1-hour access
  tokens, 7-day refresh tokens).

---

## 5. Identity Propagation (D6 — Critical)

### 5.1 Token Flow

```
Slack Event (user @mentions Kraken)
  |
  v
Dispatcher:
  1. Look up user's token from SQLite user_tokens table
     (populated via OIDC device flow in Phase 2)
     Phase 1: MCP_SERVICE_TOKEN as placeholder (see Section 5.3)
  2. Include token in mailbox record sent to team
  |
  v
Manager subprocess:
  3. Read token from mailbox record
  4. Set TNTC_ACCESS_TOKEN env var for own process
  5. All MCP tool calls use this token in Bearer header
  6. When spawning builder/deployer, pass token in env:
     TNTC_ACCESS_TOKEN=<user's token>
  |
  v
Builder/Deployer subprocess:
  7. Inherits TNTC_ACCESS_TOKEN from env
  8. All MCP calls, git operations attributed to this user
  9. On exit, token is no longer in any env (process dies)
```

### 5.2 Cross-User Isolation

**Guarantee: User A's token is never used for User B's work.**

Enforcement mechanism:

1. **Per-message token.** Each mailbox record carries the specific user's
   token. The manager uses whichever token matches the current message being
   processed.

2. **No shared token storage.** The manager does NOT cache tokens between
   messages. It reads from the mailbox record every time.

3. **Subprocess env isolation.** Each builder/deployer subprocess gets its
   own `TNTC_ACCESS_TOKEN` via `spawn()` env. Node's `child_process.spawn`
   creates a fresh env copy — the child cannot mutate the parent's env.

4. **No fallback.** If the token is missing or expired, the operation FAILS.
   The manager writes an `error` outbound message to Slack:
   "Your session has expired. Please re-authenticate with `/kraken auth`."
   It does NOT fall back to a service token or another user's token.

### 5.3 Phase 1 Identity Compromise (Temporary)

Phase 1 does not implement OIDC device flow (Phase 2). In Phase 1, all
mailbox records carry `MCP_SERVICE_TOKEN` from the environment.

**This violates D6 in Phase 1.** This is documented and accepted because:
- Phase 1 is NOT production. It is a development milestone.
- Phase 2 immediately replaces this with per-user tokens.
- The Phase 1 service token is the SAME one used by the original Phase 1
  design (this is not a regression).

**Phase 2 migration:** Replace `MCP_SERVICE_TOKEN` injection with per-user
token lookup from `user_tokens` SQLite table. The mailbox record format
already has the `userToken` field — only the source of the value changes.

---

## 6. What Survives From the Current Implementation

File-by-file assessment of code on `feature/phase1-core-loop`:

### KEEP (unchanged or minor tweaks)

| File | Verdict | Rationale |
|------|---------|-----------|
| `src/logger.ts` | **KEEP** | Pure pino setup. No changes needed. |
| `src/telemetry.ts` | **KEEP** | OTel SDK init. No changes needed. |
| `src/config.ts` | **KEEP** | Config loader. Add `teamsDir` field. Minimal change. |
| `src/enclave/binding.ts` | **KEEP** | Channel-to-enclave lookup. Used by dispatcher's router. |
| `src/agent/queue.ts` | **KEEP** | ThreadQueue. Still used — dispatcher may queue smart-path calls. |
| `src/agent/context-injector.ts` | **KEEP** | Pure function. Moves into extensions as a pi extension wrapper. |
| `src/agent/system-prompt.ts` | **KEEP** | System prompt builder. Adapted for manager/builder/deployer prompts. |
| `src/slack/outbound.ts` | **KEEP** | OutboundTracker for SQLite dedup. Dispatcher still needs this. |
| `src/health.ts` | **KEEP** | Health endpoint. No changes. |
| `src/db/*` | **KEEP** | Schema, migrations. No changes for Phase 1. |

### REWRITE

| File | Verdict | New Purpose |
|------|---------|-------------|
| `src/index.ts` | **REWRITE** | Dispatcher boot sequence (see Section 2.1). Replace single-process `Agent` startup with `createAgentSession()` + team lifecycle + outbound poller. |
| `src/agent/runner.ts` | **REWRITE** | Was per-thread Agent lifecycle. Becomes part of `src/teams/lifecycle.ts` (TeamLifecycleManager). The concept of "handle a message, get a response" is replaced by "forward message to team mailbox, poll outbound for response." |
| `src/slack/bot.ts` | **REWRITE** | Event handlers restructured around deterministic/smart routing (Section 2.4-2.5). Same Bolt dual-mode transport, different handler logic. |
| `src/agent/mcp-connection.ts` | **REWRITE** | Was a process-wide MCP client with service token. Becomes part of the manager/builder/deployer subprocess env (they connect to MCP individually with user tokens). The dispatcher does NOT hold an MCP connection — teams do. |

### DELETE

| File | Verdict | Rationale |
|------|---------|-----------|
| `src/extensions/context-injector.ts` | **DELETE** | Duplicate of `src/agent/context-injector.ts`. The agent/ version is kept and becomes a pi extension wrapper. |
| `src/extensions/tool-scoping.ts` | **DELETE (stub)** | Remains a stub but moves to `src/extensions/tool-scoping-extension.ts` as a real pi extension factory. Phase 2 implementation. |
| `src/extensions/jargon-filter.ts` | **DELETE (stub)** | Same — becomes a real pi extension factory stub. Phase 3 implementation. |

### REPURPOSE

| File | Verdict | New Purpose |
|------|---------|-------------|
| `src/agent/tools.ts` (Phase 0 stub) | **REPURPOSE** | Becomes `src/tools/dispatcher-tools.ts` — the dispatcher's custom tool definitions (spawn_enclave_team, send_to_team, check_team_status, post_to_slack). |

### NEW FILES

| File | Purpose |
|------|---------|
| `src/teams/lifecycle.ts` | TeamLifecycleManager — spawn, monitor, GC per-enclave teams |
| `src/teams/outbound-poller.ts` | Poll `outbound.ndjson` from all active teams, post to Slack |
| `src/teams/ndjson.ts` | Append-only ndjson writer + reader utilities |
| `src/dispatcher/router.ts` | Deterministic/smart routing logic (Section 2.5) |
| `src/tools/dispatcher-tools.ts` | Dispatcher's custom pi tool definitions |
| `src/extensions/dispatcher-extensions.ts` | Extension loader for dispatcher's AgentSession |

### Helm Chart Changes

| Change | Status |
|--------|--------|
| Existing templates | **KEEP** — PVC, NetworkPolicy, etc. unchanged |
| New env var: `KRAKEN_TEAMS_DIR` | **ADD** — configurable teams directory (default: `/app/data/teams`) |
| `values.schema.json` guards | **KEEP** (F14 from original Phase 1) |
| OTel Helm values | **KEEP** |

### Tests

All existing Phase 0 tests **KEEP**. New tests needed for:

- `test/unit/dispatcher-router.test.ts` — deterministic vs smart routing
- `test/unit/team-lifecycle.test.ts` — spawn, idle timeout, shutdown
- `test/unit/ndjson.test.ts` — append + read concurrency
- `test/unit/outbound-poller.test.ts` — poll + post cycle
- `test/unit/dispatcher-tools.test.ts` — tool execution
- Existing `test/unit/runner.test.ts` — **REWRITE** for team-based model

---

## 7. Revised Task List

Original T01-T21 mapped to the new architecture. Preserved numbering for
traceability. Crossed-out DoD items no longer apply. New items marked [NEW].

### T01: Add Runtime Dependencies

**Owner:** Developer

Add `pi-mono-team-mode` (reference only — for type definitions if useful),
ensure `pi-coding-agent` v0.66.1 includes `createAgentSession` SDK.
Add `pino`, `@opentelemetry/*`, `@modelcontextprotocol/sdk` (unchanged).

**DoD:**
- [ ] All packages added with appropriate versions
- [ ] `npm ci` succeeds, `npx tsc --noEmit` clean, `npm test` passes

---

### T02: Implement Pino Structured Logger

**Owner:** Developer

**Status: DONE** (existing `src/logger.ts` is KEEP). No work needed.

---

### T03: Implement OTel SDK Initialization

**Owner:** Developer

**Status: DONE** (existing `src/telemetry.ts` is KEEP). No work needed.

---

### T04: Implement LLM API Key Validation (F3)

**Owner:** Developer

**Status: DONE** (existing in `src/config.ts`). Add `teamsDir` config field.

**DoD:**
- [x] LLM API key validation (existing)
- [ ] [NEW] `KRAKEN_TEAMS_DIR` env var (default: `/app/data/teams`)
- [ ] Config type `KrakenConfig.teamsDir: string` added

---

### T05: Implement Enclave Binding Engine (Read-Only)

**Owner:** Developer

**Status: DONE** (existing `src/enclave/binding.ts` is KEEP). No work needed.

---

### T06: Implement Per-Thread Queue

**Owner:** Developer

**Status: DONE** (existing `src/agent/queue.ts` is KEEP). No work needed.

---

### T07: Implement NDJSON Protocol Layer [NEW — replaces MCP HTTP Wrapper]

**Owner:** Developer

~~Implement `src/agent/mcp-connection.ts`~~

Implement `src/teams/ndjson.ts` — append-only ndjson writer + reader with
byte-offset tracking.

**DoD:**
- [ ] `appendNdjson(path, record)` appends atomically
- [ ] `NdjsonReader` class with `readNew()` returning new records since last read
- [ ] Handles missing file gracefully (returns empty array)
- [ ] Handles partial lines at EOF (buffered)
- [ ] Unit tests for concurrent write + read
- [ ] Unit tests for reader resuming after restart (offset reset)

---

### T08: Implement System Prompt Builder

**Owner:** Developer

**Status: PARTIALLY DONE.** Existing `src/agent/system-prompt.ts` is KEEP.
Extend with role-specific prompt builders.

**DoD:**
- [x] `buildSystemPrompt()` exists (placeholder layers)
- [ ] [NEW] `buildManagerPrompt(enclaveName, config)` — manager role prompt
- [ ] [NEW] `buildBuilderPrompt(taskDescription, enclaveName)` — builder role prompt
- [ ] [NEW] `buildDeployerPrompt(taskDescription, enclaveName)` — deployer role prompt
- [ ] Unit tests for all three role prompts

---

### T09: Implement Dispatcher Router [NEW — replaces CONTEXT injector]

**Owner:** Developer

~~Implement `src/extensions/context-injector.ts` as a pi extension.~~

Implement `src/dispatcher/router.ts` — deterministic vs smart event routing.

**DoD:**
- [ ] `routeEvent(event, deps): RouteDecision` function
- [ ] All 8 deterministic actions from Section 2.5 implemented
- [ ] Smart path fallthrough for DMs and ambiguous input
- [ ] Command parser: `parseCommand(text)` for `@kraken add/remove @user`
- [ ] Unit tests for every admission criterion (8 deterministic + 5 smart)
- [ ] 100% branch coverage on routing logic

---

### T10: Implement TeamLifecycleManager [NEW — replaces Per-Thread Agent Runner]

**Owner:** Developer

~~Implement `src/agent/runner.ts` — per-thread Agent lifecycle.~~

Implement `src/teams/lifecycle.ts` — per-enclave team spawn/monitor/GC.

**DoD:**
- [ ] `TeamLifecycleManager` class with `spawnTeam()`, `sendToTeam()`,
      `isTeamActive()`, `shutdownAll()` methods
- [ ] Manager subprocess spawned via `child_process.spawn` with pi CLI
- [ ] `TNTC_ACCESS_TOKEN` passed in subprocess env (D6)
- [ ] `PI_SUBAGENT_DEPTH` + `PI_SUBAGENT_MAX_DEPTH` set (depth guard)
- [ ] Idle timeout: 30 minutes of no mailbox activity -> SIGTERM (D7)
- [ ] Process exit monitoring with cleanup
- [ ] Team state directory creation (`~/.pi/teams/{enclave}/`)
- [ ] Unit tests with mock subprocess

---

### T11: Implement Outbound Poller [NEW — replaces Outbound Message Tracking]

**Owner:** Developer

~~Implement outbound tracking using `outbound_messages` schema.~~

Implement `src/teams/outbound-poller.ts` — polls `outbound.ndjson` from all
active teams and posts to Slack via the Bolt client.

**DoD:**
- [ ] `OutboundPoller` class with `start()` and `stop()`
- [ ] Polls `outbound.ndjson` for all active teams every 1 second
- [ ] Posts messages to correct Slack channel/thread
- [ ] Records outbound messages in SQLite for restart dedup (reuses OutboundTracker)
- [ ] Handles heartbeat records (Section 8)
- [ ] OTel span per outbound post
- [ ] Unit tests with mock Slack client

---

### T12: Implement Slack Bot (Revised — Dispatcher Routing)

**Owner:** Developer

Implement `src/slack/bot.ts` with dispatcher routing architecture.

**DoD:**
- [ ] `createSlackBot(config, deps)` returns Bolt App (same dual-mode as before)
- [ ] `app_mention` handler calls `routeEvent()` and executes result
- [ ] `message` handler calls `routeEvent()` (DMs + thread replies)
- [ ] Deterministic path: spawn/forward to team, no LLM
- [ ] Smart path: invoke dispatcher's `AgentSession.prompt()`
- [ ] Bot/self messages ignored
- [ ] OTel spans per event
- [ ] Structured logging per event
- [ ] Graceful shutdown
- [ ] Unit tests with mock Slack client + event simulator

---

### T13: Implement Dispatcher Entry Point (Revised)

**Owner:** Developer

Replace Phase 0 stub `src/index.ts` with dispatcher boot sequence.

**DoD:**
- [ ] Loads config with LLM key validation
- [ ] Initializes pino, OTel, SQLite
- [ ] Creates `AgentSession` via `createAgentSession()` with dispatcher tools
- [ ] Creates `TeamLifecycleManager`, `OutboundPoller`, `EnclaveBindingEngine`
- [ ] Creates Slack bot with dispatcher deps
- [ ] Starts health endpoint, outbound poller, Slack bot
- [ ] Logs startup banner
- [ ] SIGTERM/SIGINT: stop poller, stop bot, shutdown teams, flush OTel
- [ ] Integration test: startup + shutdown with mocks

---

### T14: Add Helm Required Guards (F14)

**Owner:** Developer **[PARALLEL with T13]**

**Status: PARTIALLY DONE.** Add `KRAKEN_TEAMS_DIR` to ConfigMap.

**DoD:**
- [x] `values.schema.json` guards (existing)
- [ ] [NEW] `KRAKEN_TEAMS_DIR` in ConfigMap (default: `/app/data/teams`)
- [ ] [NEW] PVC mount for teams directory
- [x] NetworkPolicy egress: port 4318 (existing)
- [x] `helm lint` passes (existing)

---

### T15: Implement Dispatcher Tools

**Owner:** Developer **[PARALLEL with T13]**

Implement `src/tools/dispatcher-tools.ts` — custom tools for the dispatcher's
AgentSession.

**DoD:**
- [ ] `spawn_enclave_team` tool: delegates to TeamLifecycleManager
- [ ] `send_to_team` tool: appends to mailbox.ndjson
- [ ] `check_team_status` tool: reads team state
- [ ] `post_to_slack` tool: direct Slack WebClient call
- [ ] All tools registered as pi `ToolDefinition`s
- [ ] Unit tests for each tool

---

### T16: Validate Full Build Pipeline

**Owner:** Developer

**DoD:**
- [ ] `npm ci`, `npx tsc --noEmit`, `npm run build`, `npm test`,
      `npm run lint`, `npm run format:check` all clean
- [ ] `helm lint charts/thekraken` passes

---

### T17: Code Review

**Owner:** Code Reviewer

**DoD:**
- [ ] Dispatcher routing logic reviewed (deterministic vs smart boundary)
- [ ] Team lifecycle reviewed (spawn, idle, GC, token handling)
- [ ] NDJSON protocol reviewed (atomicity, concurrency)
- [ ] Outbound poller reviewed (polling interval, error handling)
- [ ] Identity propagation reviewed (D6 compliance)
- [ ] No token logged in any span, log line, or error message
- [ ] Sign-off recorded

---

### T18: Security Review

**Owner:** Senior Security Architect

**DoD:**
- [ ] D6 compliance: user token flows from mailbox to subprocess env, never
      falls back to service identity
- [ ] Mailbox files 0o600 permissions
- [ ] Token never in signals.ndjson or outbound.ndjson
- [ ] Subprocess env isolation (spawn creates fresh copy)
- [ ] PVC forensics: stale team dirs GC'd after 7 days (D7)
- [ ] Phase 1 service-token compromise documented and accepted
- [ ] Sign-off recorded

---

### T19: QA Review

**Owner:** Senior QA Engineer

**DoD:**
- [ ] All Phase 0 + Phase 1 tests pass
- [ ] Router tests cover all 13 admission criteria
- [ ] Team lifecycle tests cover spawn/idle/shutdown
- [ ] NDJSON tests cover concurrent access
- [ ] Outbound poller tests cover poll + post + dedup
- [ ] No flaky tests
- [ ] Sign-off recorded

---

### T20: Tech Writer Review

**Owner:** Senior Technical Writer

**DoD:**
- [ ] README updated: team architecture, env vars, filesystem layout
- [ ] CLAUDE.md created (dispatcher + team architecture)
- [ ] Chart README updated with `KRAKEN_TEAMS_DIR` documentation
- [ ] JSDoc on all public functions
- [ ] Sign-off recorded

---

### T21: Codex Review

**Owner:** Codex (automated)

**DoD:**
- [ ] Codex reviewed full Phase 1 diff
- [ ] Findings addressed or documented as followups
- [ ] Review logged

---

## 8. Heartbeat Protocol (D5)

### 8.1 Trigger Conditions

The manager subprocess decides when to emit a heartbeat. A heartbeat is an
outbound record posted to the user's Slack thread.

**Significant progress** is defined as any of:

1. Builder/deployer emitted a `task_started` signal
2. Builder/deployer emitted a `progress_update` with new artifact
3. Builder/deployer emitted a `task_completed` signal
4. MCP tool call returned a notable status change (e.g., workflow transitioning states)
5. Manager answered a question that required multi-step reasoning

**NOT significant (silent):**
- Builder reading files (exploration phase)
- Individual tool calls that don't change state
- Internal manager reasoning steps

### 8.2 Minimum Interval

The manager enforces a floor of **30 seconds** between heartbeat outbound
records. This is tracked via a simple timestamp:

```typescript
// Inside manager process
let lastHeartbeatAt = 0;
const HEARTBEAT_FLOOR_MS = 30_000;

function shouldEmitHeartbeat(progressType: string): boolean {
  const now = Date.now();
  if (now - lastHeartbeatAt < HEARTBEAT_FLOOR_MS) return false;
  // Only emit for significant progress types
  const significant = ['task_started', 'task_completed', 'progress_update'];
  return significant.includes(progressType);
}
```

**Tasks completing in under 60 seconds get NO heartbeat at all.** The
completion message itself serves as the update.

### 8.3 Format: Friendly Human-Addressed

Heartbeats are addressed to the human who initiated the task, using their
Slack display name. They are conversational, not protocol-like.

**Examples:**

```
Hey @alice, your builder is working on the sentiment analysis tentacle.
It just finished reading the existing code and is writing the new
data pipeline node. Should be done in a minute or two.
```

```
Quick update @alice -- the deploy is running. The workflow pod is
starting up (1 of 3 nodes ready). I'll let you know when it's live.
```

```
@alice, your tentacle is deployed and running. Version 4 is live.
Here's what changed: added retry logic to the API call node and
increased the timeout from 10s to 30s.
```

```
Heads up @bob, the builder hit an issue -- the test suite found
2 failing tests after the code change. The builder is fixing them now.
I'll update you when it's resolved.
```

### 8.4 Sub-Threshold Progress

When a builder/deployer emits a `progress_update` signal but the 30-second
floor has not elapsed, the manager:

1. Records the signal in memory (latest progress per task)
2. Does NOT write to outbound.ndjson
3. Logs at debug level: "progress signal below heartbeat threshold, suppressed"
4. The next time the floor elapses AND new progress exists, the heartbeat
   includes accumulated context

---

## 9. New Followups to Track

Items surfaced during this architectural revision. Numbered from F17 onward.

### F17: Cross-Enclave DM Query Token Handling

**Context:** When a user asks "how are all my enclaves doing?" in a DM, the
dispatcher's smart path needs to query multiple team statuses. If the user's
token has expired for some enclaves, partial results need graceful handling.

**Action:** Design the partial-failure UX in Phase 3 when DM queries are
fully implemented.

### F18: Team Crash Recovery

**Context:** If a manager subprocess crashes (OOM, uncaught exception), the
team's mailbox may have unprocessed messages. On next engagement, the
dispatcher spawns a new manager — should it replay the mailbox?

**Action:** Phase 5 hardening. For Phase 1, a crashed team simply restarts
fresh on next engagement. Unprocessed messages are lost (acceptable for
development milestone).

### F19: Multi-User Concurrent Enclave Access

**Context:** Two users message the same enclave simultaneously. The manager
receives two mailbox records with different user tokens. How does it handle
concurrent builder spawns with different tokens?

**Action:** Phase 1 design: serial processing. Manager processes mailbox
records one at a time. The user whose message arrived second waits. Phase 3
may revisit with parallel builder support if latency is a concern.

### F20: pi CLI Binary Path in Container

**Context:** The team subprocess spawn pattern calls `pi` (or `process.execPath`).
In the Docker container, `pi` must be installed and on PATH. The Dockerfile
currently installs `tntc` but NOT `pi`.

**Action:** Phase 1 Dockerfile must install pi CLI. Add to T01 dependencies.

### F21: Manager Session Persistence Across Idle Restart

**Context:** When a manager idles out (30 min) and is respawned on next
engagement, it loses its conversation history (D7: fresh state). The
enclave MEMORY.md survives (on PVC), but thread-level context does not.

**Action:** Accepted for Phase 1. The manager's MEMORY.md accumulates
important decisions. Thread history is expendable.

### F22: Outbound Poller Ordering Guarantee

**Context:** If the outbound poller reads multiple records from different
teams in the same poll cycle, the Slack posting order is not guaranteed.
For a single team, records are in-order (append-only). Cross-team ordering
does not matter (different channels/threads).

**Action:** No action needed. In-team ordering is preserved by sequential
file reads. Cross-team ordering is irrelevant.

---

## 10. Decisions Log

| # | Decision | Rationale |
|---|----------|-----------|
| D1 | Kraken-owned Slack mode, not upstreamed | Avoid upstream dependency; Kraken-specific concerns don't belong in pi-mono |
| D2 | Per-enclave team, not per-thread | Thread isolation within manager; shared enclave context |
| D3 | Dispatcher owns Slack I/O | Single Bolt socket; teams are headless |
| D4 | Named deterministic/smart code paths | Testable boundary; deterministic path never invokes LLM |
| D5 | Heartbeat: manager-driven, 30s floor | Prevents spam; friendly format for non-technical users |
| D6 | User identity hard partition | Security + audit; no service identity for enclave work |
| D7 | Pod restart = fresh state, 30-min idle | Simplicity; PVC for forensics not recovery |
| D8 | Full pi-coding-agent extension system | Extensions are the whole point of the pivot |
| D9 | `createAgentSession()` not bare `Agent` | Need ExtensionRunner, coding tools, session management |
| D10 | pi-mono-team-mode as reference, not dependency | Team-mode's TUI coupling doesn't fit Slack headless |
| D11 | Adopt subprocess spawn from pi-subagents pattern | Proven isolation model; depth guard convention |
| D12 | NDJSON filesystem protocol for IPC | Same convention as pi-mono-team-mode; no gRPC/HTTP overhead |
| D13 | Token embedded in mailbox, not in file | Multi-user support; no stale file risk |
| D14 | Dispatcher has NO coding tools | Dispatcher routes; teams code |
| D15 | Dispatcher has NO MCP connection | Teams connect to MCP with user tokens; dispatcher is Slack-only |
| D16 | Manager has read-only coding tools | Manager inspects; builders write |
| D17 | Phase 1 uses service token (D6 violation accepted) | Temporary; Phase 2 replaces with per-user OIDC |
| D18 | Smart path uses dispatcher's AgentSession | Full pi reasoning for ambiguous events |
| D19 | Serial mailbox processing in manager | Simplicity; avoid multi-user token juggling in Phase 1 |
| D20 | Outbound poller at 1s interval | Balance between responsiveness and CPU; configurable |
