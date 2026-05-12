/**
 * Platform lifecycle E2E scenarios (Pattern A from the spec).
 *
 * Linear scenarios interleave Slack and Chroma steps in a single flow.
 * Each step must pass before the next runs. Cleanup steps run in a
 * finally-block regardless of pass/fail.
 *
 * Spec: thekraken/docs/superpowers/specs/2026-05-07-chroma-e2e-platform-tests-design.md
 */

import { CHANNELS, TEST_ENCLAVE } from '../e2e-slack/harness.js';

export type LifecycleStep =
  | {
      kind: 'slack';
      channel: string;
      message: string;
      expectedPatterns?: Array<string | RegExp>;
      forbiddenPatterns?: Array<string | RegExp>;
      timeoutMs?: number;
    }
  | {
      kind: 'chroma';
      path: string;
      expectText?: Array<string | RegExp>;
      forbiddenText?: Array<string | RegExp>;
      timeoutMs?: number;
      pollMs?: number;
    };

export interface LifecycleScenarioDef {
  id: string;
  name: string;
  steps: LifecycleStep[];
  /**
   * Cleanup steps run in a finally-block regardless of pass/fail.
   * Typically removes tentacles and deprovisions the enclave.
   */
  cleanup?: LifecycleStep[];
  /**
   * Environment variable name that must equal '1' for the scenario to run.
   * Use to gate destructive scenarios that provision + deploy to a live cluster.
   */
  gatedBy?: string;
}

export const LIFECYCLE_SCENARIOS: LifecycleScenarioDef[] = [
  {
    id: 'PLAT-LIFECYCLE-1',
    name: 'create enclave → tentacle → run → verify in Chroma → remove',
    gatedBy: 'KRAKEN_E2E_ALLOW_DESTRUCTIVE',
    steps: [
      {
        kind: 'slack',
        channel: CHANNELS.test,
        message: `@Kraken provision this channel as an enclave named ${TEST_ENCLAVE} for end-to-end testing`,
        expectedPatterns: [
          new RegExp(
            `live|ready|done|is now|complete|set up|${TEST_ENCLAVE}.*enclave|enclave.*${TEST_ENCLAVE}|dev team|commissioned|working|getting started`,
            'i',
          ),
        ],
        timeoutMs: 150_000,
      },
      {
        kind: 'chroma',
        path: `/enclaves/${TEST_ENCLAVE}`,
        expectText: [new RegExp(TEST_ENCLAVE, 'i')],
        timeoutMs: 60_000,
        pollMs: 5_000,
      },
      {
        kind: 'slack',
        channel: CHANNELS.test,
        message: '@Kraken build a hello-world tentacle for me',
        expectedPatterns: [
          /build|hello-world|scaffold|deploy|redeploy|apply|ready|verify|running|committed|working|delegat/i,
        ],
        timeoutMs: 15 * 60 * 1000,
      },
      {
        kind: 'chroma',
        path: `/enclaves/${TEST_ENCLAVE}/tentacles/hello-world`,
        expectText: [/hello-world/i, /(ready|running|deployed)/i],
        timeoutMs: 600_000,
        pollMs: 10_000,
      },
      {
        kind: 'slack',
        channel: CHANNELS.test,
        message: '@Kraken run hello-world',
        expectedPatterns: [/started|triggered|run|running|complete/i],
        timeoutMs: 60_000,
      },
      {
        kind: 'chroma',
        path: `/enclaves/${TEST_ENCLAVE}/tentacles/hello-world/runs`,
        expectText: [/hello-world/i],
        timeoutMs: 120_000,
        pollMs: 10_000,
      },
    ],
    cleanup: [
      {
        kind: 'slack',
        channel: CHANNELS.test,
        message: '@Kraken remove hello-world',
        expectedPatterns: [
          /removed|deleted|decommission|gone|done|no longer|hello-world|confirm|are you sure|not found|completed|working|getting started|commissioned|dev team|keep you posted/i,
        ],
        timeoutMs: 120_000,
      },
      {
        kind: 'slack',
        channel: CHANNELS.test,
        message: '@Kraken remove this channel as an enclave',
        expectedPatterns: [
          /deprovision|remove|confirm|not an enclave|owner|decommission|commissioned|dev team|still working|working|getting started/i,
        ],
        timeoutMs: 60_000,
      },
    ],
  },
];
