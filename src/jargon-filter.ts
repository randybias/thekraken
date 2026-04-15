/**
 * Jargon filter for agent output.
 *
 * Replaces common infrastructure/Kubernetes jargon terms with user-friendly
 * alternatives. This catches cases where the agent leaks jargon despite
 * persona instructions.
 *
 * NOTE: The word-boundary regexes guard against partial matches in isolation,
 * but tentacle names that happen to contain jargon substrings (e.g., a
 * tentacle called "postgres-monitor") may still be altered when the name
 * appears in prose. This is a known limitation — avoid naming tentacles after
 * filtered jargon terms or the filter will mangle those names in user-facing
 * output.
 */
export function filterJargon(text: string): string {
  return text
    .replace(/\bnamespace\b/gi, 'enclave')
    .replace(/\bnamespaces\b/gi, 'enclaves')
    .replace(/\bDAG\b/g, 'workflow')
    .replace(/\bthe pod\b/gi, 'the service')
    .replace(/\bpod is\b/gi, 'service is')
    .replace(/\bpod\b/gi, 'service')
    .replace(/\bcontainer image\b/gi, 'system image')
    .replace(/\bcontainer\b/gi, 'service')
    .replace(/\bcron expression\b/gi, 'schedule')
    .replace(/\bgVisor\b/gi, 'secure sandbox')
    .replace(/\brustfs\b/gi, 'file storage')
    .replace(/\bpostgres(ql)?\b/gi, 'database')
    .replace(/\bNATS\b/g, 'messaging service')
    .replace(/\b\d+\/\d+ replicas? ready\b/gi, '')
    .replace(/\breplicas?\b/gi, 'instances')
    .replace(/\bquota preset\b/gi, 'resource tier')
    .replace(/\bwebhook\b/gi, 'system process')
    .replace(/\bConfigMap\b/gi, 'configuration')
    .replace(/\bconfigmap\b/gi, 'configuration')
    .replace(/\bSPIFFE\b/gi, 'security system')
    .replace(/\bCSI driver\b/gi, 'system driver')
    .replace(/`kubectl [^`]+`/g, '_(system command)_')
    .replace(/`tntc [^`]+`/g, '_(system command)_');
}

/**
 * Strip third-person narration and emoji signatures from agent output.
 *
 * The agent sometimes narrates its actions in third person instead of
 * talking directly to the user. This filter removes those patterns
 * and cleans up trailing emoji signatures.
 */
export function filterNarration(text: string): string {
  return (
    text
      // Strip full lines that narrate in third person about a named user.
      // Matches pure narration openers: "Greeted Randy back with...",
      // "Informed the user about...", "Provided a comprehensive overview..."
      // Does NOT include "I have" or "Let" — those are valid direct address
      // ("I have 3 workflows running.", "Let me know if you need more.").
      .replace(
        /^(Greeted|Informed|Provided|Sent|Notified|Shared|Gave|Offered|Showed|Presented|Updated|Told) .{10,}[.!]\s*$/gm,
        '',
      )
      // Strip "I've/I have + narration verb" only — not bare "I have N items".
      // Matches: "I've sent Randy an overview.", "I have informed the user."
      // Does NOT match: "I have 3 workflows running.", "I've got you covered."
      .replace(
        /^I('ve| have) (sent|informed|provided|given|shared|notified|shown|presented|updated|told|greeted) .{5,}[.!]\s*$/gim,
        '',
      )
      // Strip trailing bot-identity emoji signatures (:octopus:, :kraken:, :wave:).
      // Uses an explicit list to avoid stripping legitimate status emojis like
      // :green_circle: or :red_circle: that carry informational value.
      .replace(/\s*:(octopus|kraken|wave):\s*$/gi, '')
      .trim()
  );
}
