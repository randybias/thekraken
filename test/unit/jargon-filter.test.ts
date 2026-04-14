/**
 * Unit tests for the jargon filter (Phase 3, T12).
 *
 * Before/after pairs for all substitutions, code block preservation,
 * narration filter, and combined filterOutput().
 */

import { describe, it, expect } from 'vitest';
import {
  jargonFilter,
  narrationFilter,
  filterOutput,
} from '../../src/extensions/jargon-filter.js';

// ---------------------------------------------------------------------------
// Vocabulary substitutions
// ---------------------------------------------------------------------------

describe('jargonFilter — vocabulary substitutions', () => {
  it('replaces "namespace" with "enclave"', () => {
    expect(jargonFilter('Check the namespace')).toBe('Check the enclave');
  });

  it('replaces "namespaces" with "enclaves"', () => {
    expect(jargonFilter('List all namespaces')).toBe('List all enclaves');
  });

  it('replaces "pod" with "service"', () => {
    expect(jargonFilter('The pod is running')).toBe('The service is running');
  });

  it('replaces "pods" with "services"', () => {
    expect(jargonFilter('2 pods are running')).toBe('2 services are running');
  });

  it('replaces "container" with "service"', () => {
    expect(jargonFilter('The container crashed')).toBe('The service crashed');
  });

  it('replaces "containers" with "services"', () => {
    expect(jargonFilter('The containers are healthy')).toBe(
      'The services are healthy',
    );
  });

  it('replaces "replica" with "instance"', () => {
    expect(jargonFilter('Scale to 1 replica')).toBe('Scale to 1 instance');
  });

  it('replaces "replicas" with "instances"', () => {
    expect(jargonFilter('3 replicas running')).toBe('3 instances running');
  });

  it('replaces "ConfigMap" with "configuration"', () => {
    expect(jargonFilter('Update the ConfigMap')).toBe(
      'Update the configuration',
    );
  });

  it('replaces "DAG" with "workflow"', () => {
    expect(jargonFilter('The DAG completed')).toBe('The workflow completed');
  });

  it('replaces "DAGs" with "workflows"', () => {
    expect(jargonFilter('Run all DAGs')).toBe('Run all workflows');
  });

  it('replaces "gVisor" with "secure sandbox"', () => {
    expect(jargonFilter('Using gVisor isolation')).toBe(
      'Using secure sandbox isolation',
    );
  });

  it('replaces "rustfs" with "file storage"', () => {
    expect(jargonFilter('Stored in rustfs')).toBe('Stored in file storage');
  });

  it('replaces "postgres" with "database"', () => {
    expect(jargonFilter('Connect to postgres')).toBe('Connect to database');
  });

  it('replaces "postgresql" with "database"', () => {
    expect(jargonFilter('Connect to postgresql')).toBe('Connect to database');
  });

  it('replaces "NATS" with "messaging service"', () => {
    expect(jargonFilter('Messages via NATS')).toBe(
      'Messages via messaging service',
    );
  });

  it('replaces `kubectl ...` with _(system command)_', () => {
    expect(jargonFilter('Run `kubectl get pods`')).toBe(
      'Run _(system command)_',
    );
  });

  it('replaces `tntc ...` with _(system command)_', () => {
    expect(jargonFilter('Run `tntc deploy`')).toBe('Run _(system command)_');
  });

  it('replaces "kubernetes" with "the platform"', () => {
    expect(jargonFilter('Deployed on kubernetes')).toBe(
      'Deployed on the platform',
    );
  });

  it('replaces "k8s" with "the platform"', () => {
    expect(jargonFilter('Running on k8s')).toBe('Running on the platform');
  });

  it('replaces "Helm chart" with "deployment package"', () => {
    expect(jargonFilter('Install the Helm chart')).toBe(
      'Install the deployment package',
    );
  });
});

// ---------------------------------------------------------------------------
// Code block protection
// ---------------------------------------------------------------------------

describe('jargonFilter — code block protection', () => {
  it('does NOT substitute inside triple-backtick code blocks', () => {
    const input = 'Normal: namespace\n```\nkubectl get namespace\n```';
    const result = jargonFilter(input);
    // The non-code part gets substituted
    expect(result).toContain('enclave');
    // The code block is preserved
    expect(result).toContain('kubectl get namespace');
  });

  it('preserves code block content exactly', () => {
    const input = '```\nkubectl apply -f pod.yaml\n```';
    const result = jargonFilter(input);
    expect(result).toContain('kubectl apply -f pod.yaml');
  });

  it('substitutes in text before and after code blocks', () => {
    const input =
      'The namespace is ready.\n```\ncode here\n```\nCheck the pod.';
    const result = jargonFilter(input);
    expect(result).toContain('The enclave is ready.');
    expect(result).toContain('Check the service.');
    expect(result).toContain('code here');
  });

  it('handles multiple code blocks', () => {
    const input = 'pod info:\n```\nkubectl\n```\nmore pods here.';
    const result = jargonFilter(input);
    // "pod info" and "more pods here" get filtered
    expect(result).toContain('service info');
    // Code block preserved
    expect(result).toContain('kubectl');
  });
});

// ---------------------------------------------------------------------------
// Narration filter
// ---------------------------------------------------------------------------

describe('narrationFilter', () => {
  it('strips "The Kraken responds:"', () => {
    const input = 'The Kraken responds: here is the answer';
    const result = narrationFilter(input);
    expect(result).not.toContain('The Kraken responds');
  });

  it('keeps normal lines', () => {
    const input = 'Here is the information you requested.';
    expect(narrationFilter(input)).toBe(
      'Here is the information you requested.',
    );
  });

  it('strips Kraken emoji signature lines', () => {
    const input = 'Content here\n🦑 The Kraken says hi';
    const result = narrationFilter(input);
    expect(result).not.toContain('🦑 The Kraken');
    expect(result).toContain('Content here');
  });

  it('strips "I am thinking..." lines', () => {
    const input = 'I am thinking about this.\nHere is my answer.';
    const result = narrationFilter(input);
    expect(result).not.toContain('I am thinking');
    expect(result).toContain('Here is my answer.');
  });

  it('preserves multi-line content after stripping narration', () => {
    const input = 'The Kraken says:\nLine 1\nLine 2';
    const result = narrationFilter(input);
    expect(result).toContain('Line 1');
    expect(result).toContain('Line 2');
  });
});

// ---------------------------------------------------------------------------
// Combined filterOutput
// ---------------------------------------------------------------------------

describe('filterOutput', () => {
  it('applies both jargon and narration filters', () => {
    const input = 'The Kraken responds:\nThe namespace has 3 pods running.';
    const result = filterOutput(input);
    expect(result).not.toContain('The Kraken responds');
    expect(result).toContain('enclave');
    expect(result).toContain('services');
  });

  it('preserves code blocks through combined filter', () => {
    const input = 'The pod is ready.\n```\nkubectl get pods\n```';
    const result = filterOutput(input);
    expect(result).toContain('service');
    expect(result).toContain('kubectl get pods');
  });

  it('returns empty string for empty input', () => {
    expect(filterOutput('')).toBe('');
  });

  it('returns plain text unchanged (no jargon)', () => {
    const input = 'Your report has been generated successfully.';
    expect(filterOutput(input)).toBe(
      'Your report has been generated successfully.',
    );
  });
});
