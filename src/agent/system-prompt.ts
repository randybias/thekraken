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
 * The token is NOT included in the prompt — it is passed via subprocess env
 * (TNTC_ACCESS_TOKEN). The prompt only carries the human-readable identity.
 */
function buildIdentityContext(userSlackId: string, userEmail: string): string {
  return [
    '[CONTEXT]',
    `User: ${userSlackId}`,
    `Email: ${userEmail}`,
    'Token: passed via TNTC_ACCESS_TOKEN env var (NOT in this prompt)',
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
 * builder/deployer via NDJSON mailbox, emits heartbeat outbound messages, and
 * delegates coding/deploy tasks to Tier-3 subprocesses.
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
    'You orchestrate work for this enclave: answering questions, delegating',
    'coding tasks to builder subprocesses, and delegating deploy tasks to',
    'deployer subprocesses.',
    '',
    '## Responsibilities',
    '- Answer questions about workflows in this enclave using MCP tools',
    '- Delegate coding tasks to builder subprocesses',
    '- Delegate deploy tasks to deployer subprocesses',
    '- Monitor task progress via signals.ndjson and emit heartbeats',
    '- Maintain enclave MEMORY.md with accumulated context',
    '',
    '## Communication Protocol',
    '- Read mailbox.ndjson for incoming messages from the dispatcher',
    '- Write outbound.ndjson for messages to post to Slack',
    '- Read signals.ndjson from builder/deployer for progress updates',
    '- Emit heartbeat messages per the heartbeat protocol (30s floor, manager-decided significance)',
    '',
    '## Tools Available',
    '- All MCP tools (ENCLAVE_SCOPED filtered to this enclave)',
    '- read, bash, grep, find (for examining tentacle source)',
    '- NO edit, write tools (builders do the writing)',
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
    '- Write a task_completed signal to signals.ndjson',
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
    '5. Write task_completed signal to signals.ndjson',
    '',
    '## Tools Available',
    '- bash, read, grep, find (run git + tntc operations)',
    '- MCP tools scoped to this enclave for wf_apply',
    '- NO edit, write tools (deployers do not modify code)',
    '',
    buildIdentityContext(userSlackId, userEmail),
  ].join('\n');
}
