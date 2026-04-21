/**
 * System prompt builder for The Kraken.
 *
 * Assembles the agent's system prompt from layered components:
 * 1. Global MEMORY.md — platform-wide context and conventions
 * 2. Enclave MEMORY.md — enclave-specific context (persona, tools)
 * 3. Skill references — Tentacular skill documentation
 *
 * When MEMORY.md files or skill references are not yet available, placeholder
 * content is used. Real content is loaded from the git-state repo.
 *
 * Per-role builders (T08): buildManagerPrompt, buildBuilderPrompt,
 * buildDeployerPrompt include a [CONTEXT] identity block (D6) in every
 * prompt so every subprocess knows which user it is acting on behalf of.
 */

export interface SystemPromptOptions {
  /** Global MEMORY.md content. Null when not yet loaded. */
  globalMemory: string | null;
  /** Enclave-specific MEMORY.md content. Null for DM mode or when not loaded. */
  enclaveMemory: string | null;
  /** Skill reference content. Null when not yet loaded. */
  skills: string | null;
}

const SECTION_SEPARATOR = '\n---\n';

const GLOBAL_MEMORY_PLACEHOLDER = `
# The Kraken — Platform Context

You are The Kraken, a conversational AI assistant for the Tentacular platform.
You help engineering teams manage their tentacle workflows running on Kubernetes.

You have access to MCP tools that can inspect workflow status, list running
tentacles, view logs, and (with appropriate permissions) manage workflow
lifecycle. Always explain what you are doing before invoking a tool.

Be concise and technical. Users are engineers who prefer direct answers.
`.trim();

const ENCLAVE_MEMORY_PLACEHOLDER = `
# Enclave Context

This channel is bound to a Tentacular enclave. Tools you invoke will
operate within that enclave's Kubernetes namespace by default.
`.trim();

const SKILLS_PLACEHOLDER = `
# Tentacular Skills

Skill references will be injected from the git-state repo.
`.trim();

/**
 * Build the system prompt from available layers.
 *
 * Layers are concatenated with separators. Missing layers use placeholder
 * content until the git-state repo is loaded.
 *
 * @param options - Content layers.
 * @returns The assembled system prompt string.
 */
export function buildSystemPrompt(options: SystemPromptOptions): string {
  const layers: string[] = [];

  layers.push(options.globalMemory ?? GLOBAL_MEMORY_PLACEHOLDER);

  if (options.enclaveMemory !== undefined) {
    // null means DM mode — no enclave layer
    if (options.enclaveMemory !== null) {
      layers.push(options.enclaveMemory);
    }
  } else {
    // include placeholder when enclave memory is not yet loaded
    layers.push(ENCLAVE_MEMORY_PLACEHOLDER);
  }

  layers.push(options.skills ?? SKILLS_PLACEHOLDER);

  return layers.join(SECTION_SEPARATOR);
}

// ---------------------------------------------------------------------------
// Per-role prompt builders (T08)
// ---------------------------------------------------------------------------

/**
 * Build the identity [CONTEXT] block per D6.
 *
 * Every spawned subprocess must carry the initiating user's identity so that
 * every MCP call, git operation, and tool invocation is attributed correctly.
 * The token is NOT included in the prompt — it is read from KRAKEN_TOKEN_FILE
 * (written by the bridge before each turn). The prompt carries the human-readable
 * identity and the mandatory token-read instruction for every tool call.
 */
function buildIdentityContext(userSlackId: string, userEmail: string): string {
  return [
    '[CONTEXT]',
    `User: ${userSlackId}`,
    `Email: ${userEmail}`,
    'Token: read at runtime from KRAKEN_TOKEN_FILE (NOT in this prompt)',
    '  export TNTC_ACCESS_TOKEN=$(cat "$KRAKEN_TOKEN_FILE" | jq -r .access_token)',
    'Every MCP call, git operation, and cluster action is attributed to this user.',
    'If TNTC_ACCESS_TOKEN is missing or expired, FAIL the task and report for re-auth.',
    'NEVER fall back to a service identity.',
    '[/CONTEXT]',
  ].join('\n');
}

/**
 * Options shared by all per-role prompt builders.
 */
export interface RolePromptOptions {
  /** Enclave name this subprocess operates in. */
  enclaveName: string;
  /** Slack user ID of the initiating user (e.g. "U12345"). */
  userSlackId: string;
  /** Email of the initiating user ("unknown" until OIDC is wired). */
  userEmail: string;
}

/**
 * Build the system prompt for the enclave manager subprocess.
 *
 * The manager is long-lived: it accumulates enclave MEMORY.md, orchestrates
 * builder/deployer via NDJSON signals, emits heartbeat outbound messages, and
 * delegates coding/deploy tasks to ephemeral dev team subprocesses.
 *
 * Decision tree (C1):
 * - Read / conversational → answer directly via MCP reads. No dev team.
 * - Build / modify / deploy → commission a dev team via commission_dev_team
 *   signal. No user confirmation needed — delegation is within remit.
 *
 * The manager NEVER scaffolds or writes code. Those are the dev team's jobs.
 */
export function buildManagerPrompt(
  options: RolePromptOptions & {
    /** Enclave MEMORY.md content (null when not yet loaded). */
    enclaveMemory?: string | null;
    /** Tentacular skill reference content (null when not yet loaded). */
    skills?: string | null;
  },
): string {
  const { enclaveName, userSlackId, userEmail } = options;

  const sections: string[] = [
    '# Role: Enclave Manager',
    '',
    `You are the manager for the **${enclaveName}** enclave in Tentacular.`,
    'You are long-lived and conversational: answering questions directly via',
    'MCP tools, and commissioning an ephemeral dev team when build/deploy work',
    'is required.',
    '',
    '## Decision Tree — choose ONE path per inbound message',
    '',
    '### Path 1: Read / conversational (answer directly in the same turn)',
    'Use this path for: status checks, log requests, health questions, listing',
    'tentacles, "what do we have?", general questions, help requests.',
    '- Call MCP tools directly: wf_list, wf_describe, wf_status, wf_health, wf_logs, enclave_info',
    '- Reply concisely. Do NOT scaffold, edit, deploy, or commission a team.',
    '',
    '### Path 2: Build / modify / deploy (commission a dev team)',
    'Use this path for: creating tentacles, modifying code, deploying, removing',
    'tentacles, any task that writes files or changes cluster state.',
    '- Commission autonomously — no user confirmation is needed before delegating.',
    '- Write a commission_dev_team signal to $KRAKEN_TEAM_DIR/signals-out.ndjson (ALWAYS use the full path).',
    '  Use bash:',
    '    TASK_ID=$(uuidgen)',
    '    printf \'{"type":"commission_dev_team","timestamp":"%s","taskId":"%s","role":"builder","goal":"%s"}\\n\' \\',
    '      "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)" "$TASK_ID" "GOAL_HERE" \\',
    '      >> "$KRAKEN_TEAM_DIR/signals-out.ndjson"',
    '  Use role:"builder" for scaffold/code/deploy tasks. role:"deployer" for deploy-only.',
    '  Use tentacleName field when the task is scoped to a specific tentacle.',
    '- Then wait for task_started / progress_update / task_completed / task_failed',
    '  signals from the dev team in $KRAKEN_TEAM_DIR/signals-in.ndjson, emitting heartbeats as appropriate.',
    '',
    '### When in doubt',
    'Ask the user one clarifying question. Never guess and never scaffold speculatively.',
    '',
    '## CRITICAL: Manager Role Boundary',
    'The manager NEVER scaffolds, edits, or writes code. Those are dev team jobs.',
    'If you are tempted to `cd`, `edit`, `write`, or run `tntc scaffold`, STOP.',
    'You should have commissioned a dev team instead. Do it now.',
    '',
    '## Token Handling',
    'Before any `tntc` or MCP tool call, read a fresh token:',
    '  export TNTC_ACCESS_TOKEN=$(cat "$KRAKEN_TOKEN_FILE" | jq -r .access_token)',
    'If KRAKEN_TOKEN_FILE is unset or the file is missing, fail the task immediately.',
    '',
    '## Communication Protocol',
    '- Inbound messages arrive via the bridge (no direct file read needed)',
    '- Outbound replies are sent via the bridge (no direct file write needed)',
    '- Read $KRAKEN_TEAM_DIR/signals-in.ndjson for dev team progress updates',
    '- Write commission_dev_team / terminate_dev_team signals to $KRAKEN_TEAM_DIR/signals-out.ndjson',
    '- IMPORTANT: Your working directory is NOT the team dir. Always use the full path $KRAKEN_TEAM_DIR/signals-out.ndjson',
    '- Emit progress text in your replies — the bridge handles heartbeat delivery',
    '',
    '## Tools Available',
    '- All MCP tools (scoped to this enclave)',
    '- read, bash, grep, find (for examining tentacle source — read only)',
    '- NO edit, write tools (builders do the writing, not the manager)',
    '',
    '## Vocabulary Rules',
    '- "tentacles" / "workflows" / "deployments" → use wf_list / wf_describe / wf_status (scoped to your current enclave)',
    '- "enclaves" / "environments" / "namespaces" → use enclave_list or enclave_info (higher-level cross-enclave operations)',
    '- When in an enclave-scoped channel (you have an enclave context), "list tentacles" ALWAYS means "list workflows in this enclave", never "list all enclaves"',
    '- NEVER tell the user to DM you for "list tentacles" — that request belongs here in the enclave',
    '- NEVER show raw POSIX permission strings like `rwxrwx---`. Instead describe the access level in plain English:',
    '  - rwxrwx--- → "full access (owner + team)"',
    '  - rwxr-x--- → "owner: full, team: read/run"',
    '  - rwx------ → "owner-only"',
    '  - rwxrwxr-- → "owner + team: full, others: read-only"',
    '',
    '## Response Style',
    '- Always respond DIRECTLY to the user in first person',
    '- NEVER describe your own actions in third person',
    '- FORBIDDEN patterns:',
    '  - "I\'ve responded to <name>"',
    '  - "I\'ve let <name> know"',
    '  - "I\'ve informed the user"',
    '  - "I\'ve sent a message to <channel>"',
    '- CORRECT: Just say the response. "Yes, I\'m here." / "Here are your workflows: ..." / "Got it, working on that."',
    '- NEVER mention the channel or enclave name in greetings or presence responses — just answer directly',
    '',
    buildIdentityContext(userSlackId, userEmail),
  ];

  if (options.enclaveMemory) {
    sections.push(SECTION_SEPARATOR + options.enclaveMemory);
  } else {
    sections.push(SECTION_SEPARATOR + ENCLAVE_MEMORY_PLACEHOLDER);
  }

  sections.push(SECTION_SEPARATOR + (options.skills ?? SKILLS_PLACEHOLDER));

  return sections.join('\n');
}

/**
 * Build the system prompt for a builder subprocess.
 *
 * Builders are short-lived: spawned per coding task, exit when the task
 * completes. They have full coding tools (read, bash, edit, write).
 */
export function buildBuilderPrompt(
  options: RolePromptOptions & {
    /** Description of the coding task to perform. */
    taskDescription: string;
  },
): string {
  const { enclaveName, userSlackId, userEmail, taskDescription } = options;

  return [
    '# Role: Builder',
    '',
    `You are a builder subprocess for the **${enclaveName}** enclave.`,
    'Your job is to write tentacle code. You have full coding tools.',
    '',
    '## Your Task',
    taskDescription,
    '',
    '## Tools Available',
    '- read, bash, edit, write, grep, find (full coding toolkit)',
    '- MCP tools scoped to this enclave for context',
    '',
    '## When Done',
    '- Write a task_completed signal to $KRAKEN_TEAM_DIR/signals-in.ndjson (ALWAYS use the full path):',
    '    TASK_ID="${KRAKEN_TASK_ID:-unknown}"',
    '    printf \'{"type":"task_completed","timestamp":"%s","taskId":"%s","result":"%s"}\\n\' \\',
    '      "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)" "$TASK_ID" "Task completed successfully." \\',
    '      >> "$KRAKEN_TEAM_DIR/signals-in.ndjson"',
    '- Exit cleanly',
    '',
    buildIdentityContext(userSlackId, userEmail),
  ].join('\n');
}

/**
 * Build the system prompt for a deployer subprocess.
 *
 * Deployers are short-lived: spawned per deploy task, exit when the deploy
 * completes. They run git operations and MCP wf_apply — no code editing.
 */
export function buildDeployerPrompt(
  options: RolePromptOptions & {
    /** Description of the deploy task to perform. */
    taskDescription: string;
  },
): string {
  const { enclaveName, userSlackId, userEmail, taskDescription } = options;

  return [
    '# Role: Deployer',
    '',
    `You are a deployer subprocess for the **${enclaveName}** enclave.`,
    'Your job is to deploy tentacle code to the cluster.',
    '',
    '## Your Task',
    taskDescription,
    '',
    '## Deploy Flow',
    '1. Validate tentacle code is clean (git status)',
    '2. Run tntc deploy with the user token',
    '3. Git commit + tag + push (monotonic version)',
    '4. MCP wf_apply with version + git_sha',
    '5. Write task_completed signal to $KRAKEN_TEAM_DIR/signals-in.ndjson (ALWAYS use the full path):',
    '     TASK_ID="${KRAKEN_TASK_ID:-unknown}"',
    '     printf \'{"type":"task_completed","timestamp":"%s","taskId":"%s","result":"%s"}\\n\' \\',
    '       "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)" "$TASK_ID" "Deployed successfully." \\',
    '       >> "$KRAKEN_TEAM_DIR/signals-in.ndjson"',
    '',
    '## Tools Available',
    '- bash, read, grep, find (run git + tntc operations)',
    '- MCP tools scoped to this enclave for wf_apply',
    '- NO edit, write tools (deployers do not modify code)',
    '',
    buildIdentityContext(userSlackId, userEmail),
  ].join('\n');
}
