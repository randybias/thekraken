import { describe, it, expect } from 'vitest';
import {
  filterJargon,
  filterNarration,
} from '../../src/extensions/jargon-filter.js';

// ---------------------------------------------------------------------------
// New replacements added in Phase 1
// ---------------------------------------------------------------------------

describe('filterJargon — postgres/postgresql', () => {
  it('replaces postgres with database', () => {
    expect(filterJargon('The postgres instance is running.')).toBe(
      'The database instance is running.',
    );
  });

  it('replaces postgresql with database', () => {
    expect(filterJargon('Using postgresql as the backend.')).toBe(
      'Using database as the backend.',
    );
  });

  it('replaces POSTGRES (uppercase) with database', () => {
    expect(filterJargon('Connect to POSTGRES now.')).toBe(
      'Connect to database now.',
    );
  });

  it('replaces PostgreSQL (mixed case) with database', () => {
    expect(filterJargon('Backed by PostgreSQL.')).toBe('Backed by database.');
  });
});

describe('filterJargon — NATS', () => {
  it('replaces NATS with messaging service', () => {
    expect(filterJargon('Events go through NATS.')).toBe(
      'Events go through messaging service.',
    );
  });

  it('does not replace lowercase nats (not a word-boundary match)', () => {
    // The regex is /\bNATS\b/g (no i flag) — lowercase "nats" is not replaced
    expect(filterJargon('nats are insects')).toBe('nats are insects');
  });
});

describe('filterJargon — rustfs', () => {
  it('replaces rustfs with file storage', () => {
    expect(filterJargon('Files are stored in rustfs.')).toBe(
      'Files are stored in file storage.',
    );
  });

  it('replaces RUSTFS (uppercase) with file storage', () => {
    expect(filterJargon('RUSTFS is the storage layer.')).toBe(
      'file storage is the storage layer.',
    );
  });
});

describe('filterJargon — replicas / replica count strings', () => {
  it('strips "0/3 replicas ready" status string', () => {
    expect(filterJargon('Status: 0/3 replicas ready.')).toBe('Status: .');
  });

  it('strips "1/1 replica ready" (singular)', () => {
    expect(filterJargon('1/1 replica ready')).toBe('');
  });

  it('strips "2/5 replicas ready" mid-sentence', () => {
    expect(filterJargon('Currently 2/5 replicas ready in the cluster.')).toBe(
      'Currently  in the cluster.',
    );
  });

  it('replaces replicas with instances', () => {
    expect(filterJargon('Scale to 3 replicas.')).toBe('Scale to 3 instances.');
  });

  it('replaces replica (singular) with instances (regex maps all forms to plural)', () => {
    // The regex \breplicas?\b maps both "replica" and "replicas" to the same
    // replacement string "instances". This is a known quirk of the filter —
    // singular "replica" becomes plural "instances" rather than "instance".
    expect(filterJargon('One replica is running.')).toBe(
      'One instances is running.',
    );
  });
});

describe('filterJargon — quota preset', () => {
  it('replaces quota preset with resource tier', () => {
    expect(filterJargon('Select a quota preset for your workload.')).toBe(
      'Select a resource tier for your workload.',
    );
  });

  it('replaces Quota Preset (mixed case) with resource tier', () => {
    expect(filterJargon('Quota Preset: small')).toBe('resource tier: small');
  });
});

// ---------------------------------------------------------------------------
// Existing replacements
// ---------------------------------------------------------------------------

describe('filterJargon — namespace/namespaces', () => {
  it('replaces namespace with enclave', () => {
    expect(filterJargon('Create a namespace first.')).toBe(
      'Create a enclave first.',
    );
  });

  it('replaces namespaces with enclaves', () => {
    expect(filterJargon('List all namespaces.')).toBe('List all enclaves.');
  });

  it('replaces Namespace (mixed case) with enclave', () => {
    expect(filterJargon('Namespace: my-ns')).toBe('enclave: my-ns');
  });
});

describe('filterJargon — DAG', () => {
  it('replaces DAG with workflow', () => {
    expect(filterJargon('This DAG has 3 nodes.')).toBe(
      'This workflow has 3 nodes.',
    );
  });

  it('does not replace lowercase dag', () => {
    // /\bDAG\b/g has no i flag — only uppercase DAG is replaced
    expect(filterJargon('no dag here')).toBe('no dag here');
  });
});

describe('filterJargon — pod', () => {
  it('replaces "the pod" with "the service"', () => {
    expect(filterJargon('Check the pod status.')).toBe(
      'Check the service status.',
    );
  });

  it('replaces "pod is" with "service is" — note the preceding "the pod" rule fires first', () => {
    // "The pod is running." → \bthe pod\b fires first, replacing "The pod"
    // with "the service" (lowercase 't' because replacement string is lowercase).
    // The \bpod is\b rule is then a no-op. Final result starts with lowercase 't'.
    expect(filterJargon('The pod is running.')).toBe('the service is running.');
  });

  it('replaces standalone pod with service', () => {
    expect(filterJargon('A pod failed.')).toBe('A service failed.');
  });
});

describe('filterJargon — container image / container', () => {
  it('replaces "container image" with "system image"', () => {
    expect(filterJargon('Pull the container image.')).toBe(
      'Pull the system image.',
    );
  });

  it('replaces container with service', () => {
    expect(filterJargon('The container crashed.')).toBe('The service crashed.');
  });
});

describe('filterJargon — cron expression', () => {
  it('replaces cron expression with schedule', () => {
    expect(filterJargon('Set a cron expression for this task.')).toBe(
      'Set a schedule for this task.',
    );
  });
});

describe('filterJargon — gVisor', () => {
  it('replaces gVisor with secure sandbox', () => {
    expect(filterJargon('Using gVisor for isolation.')).toBe(
      'Using secure sandbox for isolation.',
    );
  });

  it('replaces gvisor (lowercase) with secure sandbox', () => {
    expect(filterJargon('gvisor is enabled.')).toBe(
      'secure sandbox is enabled.',
    );
  });
});

describe('filterJargon — webhook', () => {
  it('replaces webhook with system process', () => {
    expect(filterJargon('A webhook triggered the run.')).toBe(
      'A system process triggered the run.',
    );
  });
});

describe('filterJargon — ConfigMap / configmap', () => {
  it('replaces ConfigMap with configuration', () => {
    expect(filterJargon('Update the ConfigMap.')).toBe(
      'Update the configuration.',
    );
  });

  it('replaces configmap (lowercase) with configuration', () => {
    expect(filterJargon('Edit configmap values.')).toBe(
      'Edit configuration values.',
    );
  });
});

describe('filterJargon — SPIFFE', () => {
  it('replaces SPIFFE with security system', () => {
    expect(filterJargon('SPIFFE identity is required.')).toBe(
      'security system identity is required.',
    );
  });
});

describe('filterJargon — CSI driver', () => {
  it('replaces CSI driver with system driver', () => {
    expect(filterJargon('Install the CSI driver.')).toBe(
      'Install the system driver.',
    );
  });
});

describe('filterJargon — kubectl/tntc inline commands', () => {
  it('replaces backtick kubectl commands with (system command)', () => {
    expect(filterJargon('Run `kubectl get pods` to check.')).toBe(
      'Run _(system command)_ to check.',
    );
  });

  it('replaces backtick tntc commands with (system command)', () => {
    expect(filterJargon('Use `tntc deploy my-wf` to deploy.')).toBe(
      'Use _(system command)_ to deploy.',
    );
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('filterJargon — edge cases', () => {
  it('returns text unchanged when no jargon present', () => {
    const text = 'Your workflow is running smoothly.';
    expect(filterJargon(text)).toBe(text);
  });

  it('handles empty string', () => {
    expect(filterJargon('')).toBe('');
  });

  it('applies multiple replacements in one string', () => {
    const input = 'The namespace has 2 replicas and uses NATS.';
    const output = filterJargon(input);
    expect(output).toContain('enclave');
    expect(output).toContain('instances');
    expect(output).toContain('messaging service');
    expect(output).not.toContain('namespace');
    expect(output).not.toContain('replicas');
    expect(output).not.toContain('NATS');
  });

  it('applies all new Phase 1 replacements together', () => {
    const input =
      'Using postgres with NATS and rustfs, quota preset small, 0/3 replicas ready.';
    const output = filterJargon(input);
    expect(output).toContain('database');
    expect(output).toContain('messaging service');
    expect(output).toContain('file storage');
    expect(output).toContain('resource tier');
    // "0/3 replicas ready" is stripped entirely by the N/M replica count pattern,
    // so "replicas" is consumed and never separately replaced with "instances".
    expect(output).not.toContain('replicas ready');
    expect(output).not.toContain('postgres');
    expect(output).not.toContain('NATS');
    expect(output).not.toContain('rustfs');
    expect(output).not.toContain('quota preset');
  });

  // Known limitation: tentacle names containing jargon substrings are mangled.
  // For example, a tentacle named "postgres-monitor" will have "postgres" replaced
  // when the name appears in prose (e.g., "The postgres-monitor service is running"
  // becomes "The database-monitor service is running").
  // This is documented behaviour — avoid naming tentacles after filtered terms.
  it('documents known limitation: jargon inside tentacle names is replaced (known risk)', () => {
    // "postgres-monitor" is a tentacle name — the word boundary \b matches before "postgres"
    // and after the word characters, so postgres IS replaced inside the hyphenated name.
    const input = 'The postgres-monitor tentacle is healthy.';
    const output = filterJargon(input);
    // The jargon "postgres" is replaced even inside the compound name.
    expect(output).toContain('database-monitor');
  });
});

// ---------------------------------------------------------------------------
// filterNarration — third-person narration stripping
// ---------------------------------------------------------------------------

describe('filterNarration — third-person narration', () => {
  it('strips "I\'ve sent [name] a summary" narration', () => {
    const input =
      "I've sent Randy a comprehensive overview of how workflows operate.";
    expect(filterNarration(input)).toBe('');
  });

  it('strips "Greeted [name] back" narration', () => {
    const input =
      'Greeted Randy back in the #tentacular-agensys channel with a friendly wave!';
    expect(filterNarration(input)).toBe('');
  });

  it('strips "Informed the user about" narration', () => {
    const input = 'Informed the user about their running workflows.';
    expect(filterNarration(input)).toBe('');
  });

  it('strips "Provided a summary" narration', () => {
    const input = 'Provided a comprehensive summary of the enclave status.';
    expect(filterNarration(input)).toBe('');
  });

  it('preserves direct user-facing text', () => {
    const input = 'You have 3 workflows running, all healthy.';
    expect(filterNarration(input)).toBe(input);
  });

  it('strips narration lines but keeps direct content', () => {
    const input = [
      'Here are your workflows:',
      '',
      "I've sent Randy an overview of the results.",
      '',
      '• monitor — healthy',
    ].join('\n');
    const result = filterNarration(input);
    expect(result).toContain('Here are your workflows:');
    expect(result).toContain('• monitor — healthy');
    expect(result).not.toContain('sent Randy');
  });

  it('does not strip short "I" sentences that are direct address', () => {
    const input = "I'll check that for you.";
    expect(filterNarration(input)).toBe(input);
  });

  it('does not strip "I have N workflows running" — legitimate user-facing reply', () => {
    const input = 'I have 3 workflows running for you.';
    expect(filterNarration(input)).toBe(input);
  });

  it('does not strip "Let me check" — direct address, not narration', () => {
    const input = 'Let me check on that for you.';
    expect(filterNarration(input)).toBe(input);
  });

  it('strips "I have informed the user" — narration verb pattern', () => {
    const input = 'I have informed the user about the enclave status.';
    expect(filterNarration(input)).toBe('');
  });

  it('strips "I\'ve provided a summary" — narration verb pattern', () => {
    const input = "I've provided a summary of the running workflows.";
    expect(filterNarration(input)).toBe('');
  });
});

// ---------------------------------------------------------------------------
// filterNarration — emoji signature stripping
// ---------------------------------------------------------------------------

describe('filterNarration — emoji signatures', () => {
  it('strips trailing :octopus: emoji', () => {
    const input = 'Here are your workflows! :octopus:';
    expect(filterNarration(input)).toBe('Here are your workflows!');
  });

  it('strips trailing :kraken: emoji', () => {
    const input = 'All 3 tentacles are healthy. :kraken:';
    expect(filterNarration(input)).toBe('All 3 tentacles are healthy.');
  });

  it('does not strip mid-text emoji', () => {
    const input = 'The :green_circle: means healthy. Check it out.';
    expect(filterNarration(input)).toBe(input);
  });

  it('preserves text with no trailing emoji', () => {
    const input = 'Everything looks good.';
    expect(filterNarration(input)).toBe(input);
  });

  it('preserves trailing status emoji :green_circle:', () => {
    const input = 'All healthy :green_circle:';
    expect(filterNarration(input)).toBe(input);
  });

  it('preserves trailing status emoji :red_circle:', () => {
    const input = 'Status: :red_circle:';
    expect(filterNarration(input)).toBe(input);
  });

  it('strips trailing :wave: signature emoji', () => {
    const input = 'Hey there, ready to help! :wave:';
    expect(filterNarration(input)).toBe('Hey there, ready to help!');
  });
});
