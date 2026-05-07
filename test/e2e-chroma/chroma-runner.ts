/**
 * Executes a single CHROMA_* scenario via Playwright.
 *
 * Each invocation launches a fresh browser context (so cookie state
 * is hermetic between scenarios). On success, persists cookies for
 * subsequent runs.
 *
 * Spec: docs/superpowers/specs/2026-05-07-chroma-e2e-platform-tests-design.md
 */
import { createChromaDriver } from './chroma-driver.js';
import { bootBrowser, persistCookiesFrom } from './boot-driver.js';
import type { ChromaScenarioDef } from './load-chroma-scenarios.js';
import type { ScenarioResult } from '../e2e-slack/harness.js';

const BASE_URL =
  process.env['KRAKEN_E2E_CHROMA_BASE_URL'] ??
  'https://chroma.westeurope-dev1.ospo-dev.miralabs.dev';

export async function runChromaScenario(
  scenario: ChromaScenarioDef,
): Promise<ScenarioResult> {
  const start = Date.now();
  let booted: Awaited<ReturnType<typeof bootBrowser>> | null = null;

  try {
    booted = await bootBrowser({
      unauthenticated: scenario.unauthenticated ?? false,
    });
    const driver = createChromaDriver({
      baseUrl: BASE_URL,
      contextFactory: async () => ({
        browser: booted!.browser,
        context: booted!.context,
        page: booted!.page,
      }),
    });

    await driver.goto(scenario.chromaPath);

    if (scenario.expectRedirect) {
      const finalUrl = booted.page.url();
      if (!scenario.expectRedirect.test(finalUrl)) {
        return {
          id: scenario.id,
          name: scenario.name,
          status: 'FAIL',
          durationMs: Date.now() - start,
          notes: `Expected redirect ${scenario.expectRedirect.toString()} but URL was ${finalUrl}`,
        };
      }
    }

    if (scenario.expectText) {
      const text = await driver.pageText();
      for (const p of scenario.expectText) {
        const matched = p instanceof RegExp ? p.test(text) : text.includes(p);
        if (!matched) {
          return {
            id: scenario.id,
            name: scenario.name,
            status: 'FAIL',
            durationMs: Date.now() - start,
            notes: `Expected text ${p.toString()} not found in Chroma page`,
            replyText: text.slice(0, 500),
          };
        }
      }
    }

    if (scenario.forbiddenText) {
      try {
        await driver.assertNoText(scenario.forbiddenText);
      } catch (err) {
        return {
          id: scenario.id,
          name: scenario.name,
          status: 'FAIL',
          durationMs: Date.now() - start,
          notes: (err as Error).message,
        };
      }
    }

    if (!scenario.unauthenticated) {
      await persistCookiesFrom(booted.context);
    }

    await driver.close();

    return {
      id: scenario.id,
      name: scenario.name,
      status: 'PASS',
      durationMs: Date.now() - start,
      notes: '',
    };
  } catch (err) {
    return {
      id: scenario.id,
      name: scenario.name,
      status: 'ERROR',
      durationMs: Date.now() - start,
      notes: (err as Error).message,
    };
  } finally {
    // Best-effort cleanup
    if (booted) {
      try {
        await booted.context.close();
      } catch {
        /* ignore */
      }
      try {
        await booted.browser.close();
      } catch {
        /* ignore */
      }
    }
  }
}
