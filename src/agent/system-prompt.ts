/**
 * System prompt builder for The Kraken v2.
 *
 * Assembles the agent's system prompt from layered components:
 * 1. Global MEMORY.md — platform-wide context and conventions
 * 2. Enclave MEMORY.md — enclave-specific context (persona, tools)
 * 3. Skill references — Tentacular skill documentation
 *
 * Phase 1: placeholder content for all layers. Phase 3 wires up real
 * MEMORY.md files and skill references from git-state repo.
 */

export interface SystemPromptOptions {
  /** Global MEMORY.md content. Null in Phase 1. */
  globalMemory: string | null;
  /** Enclave-specific MEMORY.md content. Null in Phase 1 or for DM mode. */
  enclaveMemory: string | null;
  /** Skill reference content. Null in Phase 1. */
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
# Tentacular Skills (Phase 1 Placeholder)

Full skill references will be injected in Phase 3.
`.trim();

/**
 * Build the system prompt from available layers.
 *
 * Layers are concatenated with separators. Missing layers use placeholder
 * content in Phase 1.
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
    // Phase 1: always include placeholder when key is missing entirely
    layers.push(ENCLAVE_MEMORY_PLACEHOLDER);
  }

  layers.push(options.skills ?? SKILLS_PLACEHOLDER);

  return layers.join(SECTION_SEPARATOR);
}
