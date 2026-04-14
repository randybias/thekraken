/**
 * Jargon filter for outbound agent messages (Phase 3).
 *
 * Translates infrastructure jargon to plain language so non-technical
 * enclave members understand the bot's output.
 *
 * Two filters:
 *   1. jargonFilter() — vocabulary substitutions (20+ patterns)
 *   2. narrationFilter() — strips third-person narration and bot signatures
 *
 * Both are combined in filterOutput() which is the integration point for the
 * outbound poller. Code blocks (triple-backtick fences) are protected and
 * never modified.
 */

// ---------------------------------------------------------------------------
// Vocabulary substitutions
// ---------------------------------------------------------------------------

type ReplaceFn = string | ((substring: string, ...args: unknown[]) => string);

interface JargonSubstitution {
  pattern: RegExp;
  replacement: ReplaceFn;
}

/**
 * Substitution table. Order matters: more specific patterns should come
 * before less specific ones to avoid partial matches clobbering others.
 */
const SUBSTITUTIONS: JargonSubstitution[] = [
  // Kubernetes resource types — pluralise replacement to match input
  { pattern: /\bnamespaces\b/gi, replacement: 'enclaves' },
  { pattern: /\bnamespace\b/gi, replacement: 'enclave' },
  { pattern: /\bpods\b/gi, replacement: 'services' },
  { pattern: /\bpod\b/gi, replacement: 'service' },
  { pattern: /\bcontainers\b/gi, replacement: 'services' },
  { pattern: /\bcontainer\b/gi, replacement: 'service' },
  { pattern: /\breplicas\b/gi, replacement: 'instances' },
  { pattern: /\breplica\b/gi, replacement: 'instance' },
  { pattern: /\bConfigMaps\b/g, replacement: 'configurations' },
  { pattern: /\bConfigMap\b/g, replacement: 'configuration' },
  { pattern: /\bconfigmaps\b/gi, replacement: 'configurations' },
  { pattern: /\bconfigmap\b/gi, replacement: 'configuration' },
  // Workflow/DAG
  { pattern: /\bDAGs\b/g, replacement: 'workflows' },
  { pattern: /\bDAG\b/g, replacement: 'workflow' },
  // Security
  { pattern: /\bgVisor\b/gi, replacement: 'secure sandbox' },
  // Platform services
  { pattern: /\brustfs\b/gi, replacement: 'file storage' },
  { pattern: /\bpostgresql\b/gi, replacement: 'database' },
  { pattern: /\bpostgres\b/gi, replacement: 'database' },
  { pattern: /\bNATS\b/g, replacement: 'messaging service' },
  // Infrastructure commands (inline code)
  { pattern: /`kubectl\s[^`]+`/g, replacement: '_(system command)_' },
  { pattern: /`tntc\s[^`]+`/g, replacement: '_(system command)_' },
  // Kubernetes jargon
  { pattern: /\bkubernetes\b/gi, replacement: 'the platform' },
  { pattern: /\bk8s\b/gi, replacement: 'the platform' },
  { pattern: /\bHelm\s+chart\b/gi, replacement: 'deployment package' },
  { pattern: /\bHelm\s+release\b/gi, replacement: 'deployment' },
  { pattern: /\borgon\b/gi, replacement: 'workflow engine' },
];

/**
 * Apply vocabulary substitutions to a single text segment (no code blocks).
 */
function applySubstitutions(text: string): string {
  let result = text;
  for (const sub of SUBSTITUTIONS) {
    // TypeScript needs the overload-compatible call; both branches are correct.
    if (typeof sub.replacement === 'string') {
      result = result.replace(sub.pattern, sub.replacement);
    } else {
      result = result.replace(
        sub.pattern,
        sub.replacement as (...args: unknown[]) => string,
      );
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Code block protection
// ---------------------------------------------------------------------------

/**
 * Split text on triple-backtick fences, apply fn only to non-code segments,
 * then rejoin. This ensures code blocks are never modified.
 *
 * Triple-backtick segments at odd indices (0-based) are code blocks.
 */
function protectCodeBlocks(
  text: string,
  fn: (segment: string) => string,
): string {
  const segments = text.split('```');
  return segments
    .map((segment, i) => {
      // Even indices = regular text; odd indices = code block content
      if (i % 2 === 0) return fn(segment);
      // Preserve code block markers by re-adding the ``` delimiters
      return segment;
    })
    .join('```');
}

// ---------------------------------------------------------------------------
// Narration filter
// ---------------------------------------------------------------------------

/**
 * Patterns that identify third-person narration or bot signature lines.
 * These are stripped entirely (the whole line is removed).
 */
const NARRATION_PATTERNS: RegExp[] = [
  // Third-person narration: "The Kraken responds:", "Kraken says:"
  /^(the\s+)?kraken\s+(responds?|says?|replies?|answers?|thinks?|notes?|observes?):?\s*/im,
  // Bot emoji signatures: lines starting with emoji + containing "kraken"
  // Use unicode flag to handle emoji code points correctly
  /^\p{Emoji}.*kraken.*/imu,
  // "I am thinking..." narration
  /^(I am|I'm)\s+(thinking|processing|analyzing|working on|looking at)\b.*/im,
];

/**
 * Strip third-person narration lines and bot emoji signatures.
 */
export function narrationFilter(text: string): string {
  const lines = text.split('\n');
  const filtered = lines.filter((line) => {
    for (const pattern of NARRATION_PATTERNS) {
      if (pattern.test(line)) return false;
    }
    return true;
  });
  return filtered.join('\n').trim();
}

// ---------------------------------------------------------------------------
// Jargon filter
// ---------------------------------------------------------------------------

/**
 * Apply vocabulary substitutions to text, preserving code blocks.
 */
export function jargonFilter(text: string): string {
  return protectCodeBlocks(text, applySubstitutions);
}

// ---------------------------------------------------------------------------
// Combined output filter (integration point for outbound poller)
// ---------------------------------------------------------------------------

/**
 * Apply all output filters: jargon substitution + narration removal.
 *
 * Called by OutboundPoller.processRecord() for slack_message records only.
 * Does NOT filter heartbeat or error records.
 */
export function filterOutput(text: string): string {
  return narrationFilter(jargonFilter(text));
}
