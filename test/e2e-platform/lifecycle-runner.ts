/**
 * Executes a LifecycleScenarioDef: interleaved Slack + Chroma steps in a
 * linear flow. Cleanup steps run in a finally-block regardless of pass/fail.
 *
 * Spec: thekraken/docs/superpowers/specs/2026-05-07-chroma-e2e-platform-tests-design.md
 */

import type { LifecycleScenarioDef, LifecycleStep } from './scenarios.js';
import type { ScenarioResult } from '../e2e-slack/harness.js';
import type { SlackDriver } from '../e2e-slack/slack-driver.js';
import type { ChromaDriver } from '../e2e-chroma/chroma-driver.js';
import { TEST_ENCLAVE } from '../e2e-slack/harness.js';

export interface LifecycleRunnerDeps {
  slackDriver: SlackDriver;
  chromaDriver: ChromaDriver | undefined;
  channels: Record<string, string>;
  scaledTimeout: (n: number | undefined) => number;
}

async function runSlackStep(
  step: Extract<LifecycleStep, { kind: 'slack' }>,
  idx: number,
  deps: LifecycleRunnerDeps,
): Promise<void> {
  const channelId = deps.channels[step.channel];
  if (!channelId) {
    throw new Error(
      `step ${idx}: channel "${step.channel}" not available in harness`,
    );
  }
  const ts = await deps.slackDriver.postAsUser(channelId, step.message);
  const reply = await deps.slackDriver.waitForKrakenReply(
    channelId,
    ts,
    deps.scaledTimeout(step.timeoutMs ?? 60_000),
  );
  if (step.expectedPatterns) {
    for (const p of step.expectedPatterns) {
      const matched = p instanceof RegExp ? p.test(reply) : reply.includes(p);
      if (!matched) {
        throw new Error(
          `step ${idx}: expected ${p} not in reply: ${reply.slice(0, 200)}`,
        );
      }
    }
  }
  if (step.forbiddenPatterns) {
    for (const p of step.forbiddenPatterns) {
      const matched = p instanceof RegExp ? p.test(reply) : reply.includes(p);
      if (matched) {
        throw new Error(`step ${idx}: forbidden ${p} in reply`);
      }
    }
  }
}

async function runChromaStep(
  step: Extract<LifecycleStep, { kind: 'chroma' }>,
  idx: number,
  deps: LifecycleRunnerDeps,
): Promise<void> {
  const driver = deps.chromaDriver;
  if (!driver) {
    // Chroma not available — skip chroma steps gracefully rather than fail
    console.warn(
      `[lifecycle-runner] step ${idx}: no Chroma driver — skipping chroma assertion`,
    );
    return;
  }
  const path = step.path.replace('<TEST_ENCLAVE>', TEST_ENCLAVE);
  const pollMs = step.pollMs ?? 5_000;
  const budgetMs = deps.scaledTimeout(step.timeoutMs ?? 60_000);
  const deadline = Date.now() + budgetMs;
  let lastErr: string | null = 'not evaluated';
  while (Date.now() < deadline) {
    try {
      await driver.goto(path);
      const text = await driver.pageText();
      let allMatched = true;
      if (step.expectText) {
        for (const p of step.expectText) {
          const matched = p instanceof RegExp ? p.test(text) : text.includes(p);
          if (!matched) {
            lastErr = `expected ${p} not in page`;
            allMatched = false;
            break;
          }
        }
      }
      if (allMatched && step.forbiddenText) {
        for (const p of step.forbiddenText) {
          const matched = p instanceof RegExp ? p.test(text) : text.includes(p);
          if (matched) {
            lastErr = `forbidden ${p} in page`;
            allMatched = false;
            break;
          }
        }
      }
      if (allMatched) {
        lastErr = null;
        break;
      }
    } catch (err) {
      lastErr = (err as Error).message;
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  if (lastErr) {
    throw new Error(`step ${idx}: chroma assertion failed: ${lastErr}`);
  }
}

async function runStep(
  step: LifecycleStep,
  idx: number,
  deps: LifecycleRunnerDeps,
): Promise<void> {
  if (step.kind === 'slack') {
    await runSlackStep(step, idx, deps);
  } else {
    await runChromaStep(step, idx, deps);
  }
}

export async function runLifecycleScenario(
  scenario: LifecycleScenarioDef,
  deps: LifecycleRunnerDeps,
): Promise<ScenarioResult> {
  if (scenario.gatedBy && process.env[scenario.gatedBy] !== '1') {
    return {
      id: scenario.id,
      name: scenario.name,
      status: 'SKIP',
      durationMs: 0,
      notes: `gated by ${scenario.gatedBy}=1 (not set)`,
    };
  }

  const start = Date.now();
  let stepError: string | null = null;

  try {
    for (const [idx, step] of scenario.steps.entries()) {
      await runStep(step, idx, deps);
    }
  } catch (err) {
    stepError = (err as Error).message;
  } finally {
    // Best-effort cleanup — always run regardless of pass/fail
    if (scenario.cleanup) {
      for (const [idx, step] of scenario.cleanup.entries()) {
        try {
          await runStep(step, idx, deps);
        } catch (cleanupErr) {
          // Log but don't override the primary error
          console.warn(
            `[lifecycle-runner] cleanup step ${idx} failed: ${(cleanupErr as Error).message}`,
          );
        }
      }
    }
  }

  return {
    id: scenario.id,
    name: scenario.name,
    status: stepError ? 'FAIL' : 'PASS',
    durationMs: Date.now() - start,
    notes: stepError ?? '',
  };
}
