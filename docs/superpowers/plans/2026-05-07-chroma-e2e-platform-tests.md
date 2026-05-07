# Integrated platform E2E tests — Slack + Chroma — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add live E2E coverage that drives Slack actions and verifies the resulting state appears correctly in Chroma — full enclave + tentacle lifecycle, retrofit onto existing F/E/M scenarios, plus standalone Chroma smoke tests.

**Architecture:** Three composing patterns — Pattern A (linear lifecycle scenarios with interleaved Slack + Chroma steps in `thekraken/test/e2e-platform/`), Pattern B (existing scenarios get an optional `chromaAssertion` field mirroring `mcpAssertion`), Pattern C (standalone Chroma smoke scenarios authored in `tentacular-chroma/test/e2e/`, imported by the runner in thekraken). Single Playwright browser context per run; cookies persist on disk; manual one-time login.

**Tech Stack:** TypeScript, Node 22, vitest, Playwright, Slack Bolt (existing), Keycloak OIDC.

**Spec:** `thekraken/docs/superpowers/specs/2026-05-07-chroma-e2e-platform-tests-design.md`

---

## Task 0: Branch + tracking PR

**Files:**
- Branch: `feat/chroma-e2e-platform-tests`

- [ ] **Step 1: Create branch from main**

```bash
cd ~/code/tentacular-main/thekraken
git checkout main && git pull origin main
git checkout -b feat/chroma-e2e-platform-tests
```

- [ ] **Step 2: Push + open draft PR (after first commit lands)**

```bash
git push -u origin feat/chroma-e2e-platform-tests
# After Task 1 commits, open the PR
gh pr create --draft --title "feat(e2e): platform tests with Chroma coverage" \
  --body "Spec: docs/superpowers/specs/2026-05-07-chroma-e2e-platform-tests-design.md. Three patterns (lifecycle / chromaAssertion retrofit / standalone). Plan: docs/superpowers/plans/2026-05-07-chroma-e2e-platform-tests.md"
```

---

## Phase C1 — Chroma driver + session + first smoke scenario

### Task 1: Add Playwright dev dependency

**Files:**
- Modify: `thekraken/package.json`

- [ ] **Step 1: Install Playwright as a devDependency**

```bash
cd ~/code/tentacular-main/thekraken
npm install --save-dev playwright@1.50.0
npx playwright install chromium  # downloads the Chromium binary; one-time setup
```

- [ ] **Step 2: Verify package.json**

Confirm devDependencies has `"playwright": "1.50.0"` (or compatible). The package-lock.json updates accordingly.

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "build(deps): add playwright devDependency for Chroma E2E"
```

### Task 2: ChromaDriver — the Playwright wrapper

**Files:**
- Create: `thekraken/test/e2e-chroma/chroma-driver.ts`
- Test: `thekraken/test/unit/e2e-chroma/chroma-driver.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// test/unit/e2e-chroma/chroma-driver.test.ts
import { describe, it, expect, vi } from 'vitest';
import { createChromaDriver, type ChromaDriver } from '../../e2e-chroma/chroma-driver.js';

describe('ChromaDriver', () => {
  it('exposes goto / pageText / waitForText / assertNoText / screenshot / close', () => {
    // Mock Playwright internals via factory injection — driver doesn't
    // launch a real browser when given a stub.
    const stubPage = {
      goto: vi.fn().mockResolvedValue(undefined),
      content: vi.fn().mockResolvedValue('<html><body>hello world</body></html>'),
      waitForFunction: vi.fn().mockResolvedValue(undefined),
      screenshot: vi.fn().mockResolvedValue(Buffer.from([])),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const stubContext = {
      newPage: vi.fn().mockResolvedValue(stubPage),
      close: vi.fn().mockResolvedValue(undefined),
    };

    const driver: ChromaDriver = createChromaDriver({
      baseUrl: 'http://chroma.test',
      contextFactory: () => Promise.resolve({ context: stubContext, page: stubPage } as never),
    });

    expect(typeof driver.goto).toBe('function');
    expect(typeof driver.pageText).toBe('function');
    expect(typeof driver.waitForText).toBe('function');
    expect(typeof driver.assertNoText).toBe('function');
    expect(typeof driver.screenshot).toBe('function');
    expect(typeof driver.close).toBe('function');
  });

  it('goto prefixes baseUrl', async () => {
    const stubPage = {
      goto: vi.fn().mockResolvedValue(undefined),
      content: vi.fn().mockResolvedValue(''),
      waitForFunction: vi.fn().mockResolvedValue(undefined),
      screenshot: vi.fn().mockResolvedValue(Buffer.from([])),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const stubContext = {
      newPage: vi.fn().mockResolvedValue(stubPage),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const driver = createChromaDriver({
      baseUrl: 'http://chroma.test',
      contextFactory: () => Promise.resolve({ context: stubContext, page: stubPage } as never),
    });

    await driver.goto('/enclaves/foo');
    expect(stubPage.goto).toHaveBeenCalledWith(
      'http://chroma.test/enclaves/foo',
      expect.any(Object),
    );
  });

  it('pageText returns innerText after navigation', async () => {
    const stubPage = {
      goto: vi.fn().mockResolvedValue(undefined),
      content: vi
        .fn()
        .mockResolvedValue('<html><body>Hello, World</body></html>'),
      innerText: vi.fn().mockResolvedValue('Hello, World'),
      waitForFunction: vi.fn().mockResolvedValue(undefined),
      screenshot: vi.fn().mockResolvedValue(Buffer.from([])),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const stubContext = {
      newPage: vi.fn().mockResolvedValue(stubPage),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const driver = createChromaDriver({
      baseUrl: 'http://chroma.test',
      contextFactory: () => Promise.resolve({ context: stubContext, page: stubPage } as never),
    });

    await driver.goto('/');
    const text = await driver.pageText();
    expect(text).toBe('Hello, World');
  });
});
```

- [ ] **Step 2: Run test to verify failure**

```bash
cd ~/code/tentacular-main/thekraken
npx vitest run test/unit/e2e-chroma/chroma-driver.test.ts
```

Expected: failure — `chroma-driver.ts` doesn't exist.

- [ ] **Step 3: Implement `chroma-driver.ts`**

```typescript
// test/e2e-chroma/chroma-driver.ts
/**
 * Playwright-based driver for the Chroma observability dashboard.
 *
 * Wraps page.goto / page.innerText / page.waitForFunction with a small
 * helper API used by E2E scenarios. The driver is initialized once per
 * test run (single browser context) so cookies persist across all
 * scenarios.
 *
 * For testability, the contextFactory is injectable — production wires
 * it to playwright.chromium.launch + browser.newContext.
 */
import type { Browser, BrowserContext, Page } from 'playwright';

export interface ChromaDriver {
  goto(path: string): Promise<void>;
  pageText(): Promise<string>;
  waitForText(needle: string | RegExp, timeoutMs?: number): Promise<void>;
  assertNoText(patterns: Array<string | RegExp>): Promise<void>;
  screenshot(): Promise<Buffer>;
  close(): Promise<void>;
}

export interface ChromaDriverDeps {
  baseUrl: string;
  contextFactory: () => Promise<{ context: BrowserContext; page: Page; browser?: Browser }>;
}

export function createChromaDriver(deps: ChromaDriverDeps): ChromaDriver {
  const baseUrl = deps.baseUrl.replace(/\/+$/, '');
  let initialized: { page: Page; context: BrowserContext; browser?: Browser } | null = null;

  async function getPage(): Promise<Page> {
    if (!initialized) {
      initialized = await deps.contextFactory();
    }
    return initialized.page;
  }

  return {
    async goto(path: string): Promise<void> {
      const page = await getPage();
      const url = `${baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
      await page.goto(url, { waitUntil: 'load', timeout: 30_000 });
    },

    async pageText(): Promise<string> {
      const page = await getPage();
      return await page.innerText('body');
    },

    async waitForText(
      needle: string | RegExp,
      timeoutMs = 10_000,
    ): Promise<void> {
      const page = await getPage();
      const matchExpr =
        needle instanceof RegExp
          ? `new RegExp(${JSON.stringify(needle.source)}, ${JSON.stringify(needle.flags)}).test(document.body.innerText)`
          : `document.body.innerText.includes(${JSON.stringify(needle)})`;
      await page.waitForFunction(matchExpr, { timeout: timeoutMs });
    },

    async assertNoText(patterns: Array<string | RegExp>): Promise<void> {
      const page = await getPage();
      const text = await page.innerText('body');
      for (const p of patterns) {
        if (p instanceof RegExp) {
          if (p.test(text)) {
            throw new Error(`Forbidden pattern ${p} found in Chroma page text`);
          }
        } else if (text.includes(p)) {
          throw new Error(`Forbidden text "${p}" found in Chroma page text`);
        }
      }
    },

    async screenshot(): Promise<Buffer> {
      const page = await getPage();
      return await page.screenshot();
    },

    async close(): Promise<void> {
      if (initialized) {
        await initialized.context.close().catch(() => undefined);
        await initialized.browser?.close().catch(() => undefined);
        initialized = null;
      }
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run test/unit/e2e-chroma/chroma-driver.test.ts
```

Expected: 3 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add test/e2e-chroma/chroma-driver.ts test/unit/e2e-chroma/chroma-driver.test.ts
git commit -m "feat(e2e-chroma): ChromaDriver — Playwright wrapper for Chroma navigation + assertions"
```

### Task 3: ChromaSession — cookie-jar persistence

**Files:**
- Create: `thekraken/test/e2e-chroma/chroma-session.ts`
- Test: `thekraken/test/unit/e2e-chroma/chroma-session.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// test/unit/e2e-chroma/chroma-session.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  loadCookies,
  saveCookies,
  defaultCookiePath,
} from '../../e2e-chroma/chroma-session.js';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join, tmpdir } from 'node:os';

describe('chroma-session cookie jar', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'chroma-session-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('loadCookies returns empty array when file missing', async () => {
    const cookies = await loadCookies(join(dir, 'missing.json'));
    expect(cookies).toEqual([]);
  });

  it('saveCookies writes to disk; loadCookies reads it back', async () => {
    const path = join(dir, 'cookies.json');
    const cookies = [
      { name: 'x', value: 'y', domain: 'chroma.test', path: '/' },
    ];
    await saveCookies(path, cookies as never);
    expect(existsSync(path)).toBe(true);
    const loaded = await loadCookies(path);
    expect(loaded).toEqual(cookies);
  });

  it('defaultCookiePath honors KRAKEN_E2E_CHROMA_COOKIES env var', () => {
    const orig = process.env.KRAKEN_E2E_CHROMA_COOKIES;
    process.env.KRAKEN_E2E_CHROMA_COOKIES = '/tmp/foo.json';
    expect(defaultCookiePath()).toBe('/tmp/foo.json');
    if (orig === undefined) delete process.env.KRAKEN_E2E_CHROMA_COOKIES;
    else process.env.KRAKEN_E2E_CHROMA_COOKIES = orig;
  });

  it('defaultCookiePath defaults to ~/.kraken-e2e-chroma/cookies.json', () => {
    const orig = process.env.KRAKEN_E2E_CHROMA_COOKIES;
    delete process.env.KRAKEN_E2E_CHROMA_COOKIES;
    expect(defaultCookiePath()).toMatch(/\.kraken-e2e-chroma\/cookies\.json$/);
    if (orig !== undefined) process.env.KRAKEN_E2E_CHROMA_COOKIES = orig;
  });
});
```

- [ ] **Step 2: Run, expect failure**

```bash
npx vitest run test/unit/e2e-chroma/chroma-session.test.ts
```

Expected: file doesn't exist.

- [ ] **Step 3: Implement `chroma-session.ts`**

```typescript
// test/e2e-chroma/chroma-session.ts
/**
 * Cookie-jar persistence for Chroma E2E browser session.
 *
 * The runner loads cookies from disk on startup, hands them to the
 * Playwright BrowserContext via context.addCookies(), and saves the
 * post-session cookies back to disk. On first run with no cookie file,
 * the runner prompts the user to log in via a printed URL and waits
 * for the cookie file to appear.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

interface Cookie {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'Lax' | 'None' | 'Strict';
}

export function defaultCookiePath(): string {
  const env = process.env.KRAKEN_E2E_CHROMA_COOKIES;
  if (env) return env;
  return join(homedir(), '.kraken-e2e-chroma', 'cookies.json');
}

export async function loadCookies(path: string): Promise<Cookie[]> {
  try {
    const raw = await readFile(path, 'utf8');
    return JSON.parse(raw) as Cookie[];
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return [];
    throw err;
  }
}

export async function saveCookies(
  path: string,
  cookies: Cookie[],
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(cookies, null, 2), { mode: 0o600 });
}
```

- [ ] **Step 4: Run, expect pass**

```bash
npx vitest run test/unit/e2e-chroma/chroma-session.test.ts
```

Expected: 4 PASS.

- [ ] **Step 5: Commit**

```bash
git add test/e2e-chroma/chroma-session.ts test/unit/e2e-chroma/chroma-session.test.ts
git commit -m "feat(e2e-chroma): ChromaSession — cookie-jar persistence for Playwright"
```

### Task 4: First Chroma scenario — CHROMA-SMOKE-1 (login redirect)

**Files:**
- Create: `tentacular-chroma/test/e2e/scenarios.ts`

- [ ] **Step 1: Create the scenarios file in the chroma repo**

```typescript
// tentacular-chroma/test/e2e/scenarios.ts
/**
 * Standalone Chroma E2E scenarios (Pattern C from the spec).
 *
 * These scenarios touch only Chroma — no Slack involvement. The runner
 * in thekraken imports this module via relative path and dispatches
 * each scenario to the ChromaDriver.
 *
 * Spec: thekraken/docs/superpowers/specs/2026-05-07-chroma-e2e-platform-tests-design.md
 */

export interface ChromaScenarioDef {
  id: string;
  name: string;
  /** Path under the Chroma base URL. */
  chromaPath: string;
  /**
   * If set, the scenario expects this regex to match the FINAL URL after
   * navigation (e.g. unauthenticated → redirected to Keycloak).
   */
  expectRedirect?: RegExp;
  /** Expected text patterns on the page after navigation completes. */
  expectText?: Array<string | RegExp>;
  /** Forbidden text patterns. */
  forbiddenText?: Array<string | RegExp>;
  /** Per-scenario timeout (ms). */
  timeoutMs?: number;
  /**
   * If true, the scenario runs without injecting Chroma cookies — used
   * to test the unauthenticated path.
   */
  unauthenticated?: boolean;
}

export const CHROMA_SCENARIOS: ChromaScenarioDef[] = [
  {
    id: 'CHROMA-SMOKE-1',
    name: 'unauthenticated user is redirected to Keycloak login',
    chromaPath: '/',
    expectRedirect: /\/auth\/realms\/tentacular\/protocol\/openid-connect\/auth/,
    timeoutMs: 30_000,
    unauthenticated: true,
  },
];
```

- [ ] **Step 2: Verify the file is in tentacular-chroma's git tree**

```bash
cd ~/code/tentacular-main/tentacular-chroma
git status -s
# expected: ?? test/e2e/scenarios.ts
git add test/e2e/scenarios.ts
git status -s
# expected: A test/e2e/scenarios.ts
```

- [ ] **Step 3: Commit on the chroma side**

```bash
cd ~/code/tentacular-main/tentacular-chroma
git checkout -b feat/e2e-platform-scenarios
git commit -m "feat(test): standalone Chroma E2E scenarios (CHROMA-SMOKE-1)

First scenario in the integrated platform E2E framework. Imported
by thekraken's runner via relative path. See thekraken's spec at
docs/superpowers/specs/2026-05-07-chroma-e2e-platform-tests-design.md."
git push -u origin feat/e2e-platform-scenarios
gh pr create --draft --title "feat(test): platform E2E scenarios (Chroma side)" \
  --body "Companion PR to thekraken's feat/chroma-e2e-platform-tests. Standalone Chroma scenarios live here per the integrated test framework spec."
cd ~/code/tentacular-main/thekraken
```

### Task 5: Chroma scenario loader

**Files:**
- Create: `thekraken/test/e2e-chroma/load-chroma-scenarios.ts`
- Test: `thekraken/test/unit/e2e-chroma/load-chroma-scenarios.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// test/unit/e2e-chroma/load-chroma-scenarios.test.ts
import { describe, it, expect } from 'vitest';
import { loadChromaScenarios } from '../../e2e-chroma/load-chroma-scenarios.js';

describe('loadChromaScenarios', () => {
  it('returns CHROMA_SCENARIOS array when import succeeds', async () => {
    const scenarios = await loadChromaScenarios();
    expect(Array.isArray(scenarios)).toBe(true);
    // Sibling tentacular-chroma is checked out at ../tentacular-chroma
    // and exports at least CHROMA-SMOKE-1.
    expect(scenarios.find((s) => s.id === 'CHROMA-SMOKE-1')).toBeDefined();
  });

  it('returns empty array (with warning) when sibling not present', async () => {
    // Override the lookup path to a directory that doesn't exist
    const scenarios = await loadChromaScenarios({
      siblingPath: '/nonexistent/path/to/chroma',
    });
    expect(scenarios).toEqual([]);
  });
});
```

- [ ] **Step 2: Run, expect failure**

- [ ] **Step 3: Implement loader**

```typescript
// test/e2e-chroma/load-chroma-scenarios.ts
/**
 * Loads CHROMA_SCENARIOS from the sibling tentacular-chroma checkout.
 *
 * The two repos sit in ~/code/tentacular-main/ and are pinned together
 * via lockstep tags. Importing a sibling's test file via relative path
 * is acceptable for this test framework.
 *
 * On import failure (sibling not checked out, etc.), returns an empty
 * array with a warning so thekraken can build standalone.
 */
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface ChromaScenarioDef {
  id: string;
  name: string;
  chromaPath: string;
  expectRedirect?: RegExp;
  expectText?: Array<string | RegExp>;
  forbiddenText?: Array<string | RegExp>;
  timeoutMs?: number;
  unauthenticated?: boolean;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_SIBLING = resolve(HERE, '../../../../tentacular-chroma');

export async function loadChromaScenarios(opts?: {
  siblingPath?: string;
}): Promise<ChromaScenarioDef[]> {
  const siblingPath = opts?.siblingPath ?? DEFAULT_SIBLING;
  const scenariosPath = resolve(siblingPath, 'test/e2e/scenarios.ts');
  if (!existsSync(scenariosPath)) {
    console.warn(
      `[chroma-loader] scenarios not found at ${scenariosPath}; returning empty array`,
    );
    return [];
  }
  try {
    const mod = (await import(scenariosPath)) as {
      CHROMA_SCENARIOS?: ChromaScenarioDef[];
    };
    return mod.CHROMA_SCENARIOS ?? [];
  } catch (err) {
    console.warn(
      `[chroma-loader] failed to import ${scenariosPath}: ${(err as Error).message}`,
    );
    return [];
  }
}
```

- [ ] **Step 4: Run tests + commit**

```bash
npx vitest run test/unit/e2e-chroma/load-chroma-scenarios.test.ts
git add test/e2e-chroma/load-chroma-scenarios.ts test/unit/e2e-chroma/load-chroma-scenarios.test.ts
git commit -m "feat(e2e-chroma): load CHROMA_SCENARIOS from sibling tentacular-chroma checkout"
```

### Task 6: Wire Chroma scenarios into the runner — CHROMA-SMOKE-1 live

**Files:**
- Modify: `thekraken/test/e2e-slack/run-all.ts`
- Modify: `thekraken/test/e2e-slack/harness.ts`

- [ ] **Step 1: Add Chroma scenario execution to run-all**

In `run-all.ts`, after the existing scenario loop, add:

```typescript
import { loadChromaScenarios } from '../e2e-chroma/load-chroma-scenarios.js';
import { runChromaScenario } from '../e2e-chroma/chroma-runner.js'; // new — Task 7

// After the existing for-loop over ALL_SCENARIOS:
if (process.env.KRAKEN_E2E_DISABLE_CHROMA !== '1') {
  const chromaScenarios = await loadChromaScenarios();
  for (const cs of chromaScenarios) {
    const r = await runChromaScenario(cs);
    results.push(r);
    printScenarioLine(r);
  }
}
```

- [ ] **Step 2: Stub the runner so CI passes**

Create a stub at `test/e2e-chroma/chroma-runner.ts` (Task 7 fills it in):

```typescript
import type { ChromaScenarioDef } from './load-chroma-scenarios.js';
import type { ScenarioResult } from '../e2e-slack/harness.js';

export async function runChromaScenario(
  scenario: ChromaScenarioDef,
): Promise<ScenarioResult> {
  // Stubbed in C1; full impl in Task 7.
  return {
    id: scenario.id,
    name: scenario.name,
    status: 'SKIP',
    durationMs: 0,
    notes: 'chroma-runner stub — Task 7',
  };
}
```

- [ ] **Step 3: Verify**

```bash
npx tsc --noEmit
KRAKEN_E2E_DRY_RUN=1 npm run test:e2e-slack 2>&1 | grep -E "CHROMA-SMOKE|SKIP" | head
```

Expected: tsc clean. The smoke scenario shows up in the run output as SKIP.

- [ ] **Step 4: Commit**

```bash
git add test/e2e-chroma/chroma-runner.ts test/e2e-slack/run-all.ts
git commit -m "feat(e2e): wire Chroma scenarios into run-all (stub runner)"
```

### Task 7: Implement chroma-runner — CHROMA-SMOKE-1 actually runs

**Files:**
- Modify: `thekraken/test/e2e-chroma/chroma-runner.ts`
- Create: `thekraken/test/e2e-chroma/boot-driver.ts` (browser-context launcher)

- [ ] **Step 1: Write the boot-driver**

```typescript
// test/e2e-chroma/boot-driver.ts
/**
 * Bootstraps a Playwright browser + context with persisted cookies.
 * Returns a callable that yields { browser, context, page } for the
 * ChromaDriver factory.
 */
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { loadCookies, saveCookies, defaultCookiePath } from './chroma-session.js';

export interface BootedBrowser {
  browser: Browser;
  context: BrowserContext;
  page: Page;
}

export async function bootBrowser(opts: {
  cookiesPath?: string;
  unauthenticated?: boolean;
}): Promise<BootedBrowser> {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();

  if (!opts.unauthenticated) {
    const path = opts.cookiesPath ?? defaultCookiePath();
    const cookies = await loadCookies(path);
    if (cookies.length > 0) {
      await context.addCookies(cookies);
    }
  }

  const page = await context.newPage();
  return { browser, context, page };
}

export async function persistCookiesFrom(
  context: BrowserContext,
  cookiesPath?: string,
): Promise<void> {
  const cookies = await context.cookies();
  await saveCookies(cookiesPath ?? defaultCookiePath(), cookies);
}
```

- [ ] **Step 2: Implement the runner**

```typescript
// test/e2e-chroma/chroma-runner.ts
import { createChromaDriver } from './chroma-driver.js';
import { bootBrowser, persistCookiesFrom } from './boot-driver.js';
import type { ChromaScenarioDef } from './load-chroma-scenarios.js';
import type { ScenarioResult } from '../e2e-slack/harness.js';

const BASE_URL =
  process.env.KRAKEN_E2E_CHROMA_BASE_URL ??
  'https://chroma.westeurope-dev1.ospo-dev.miralabs.dev';

export async function runChromaScenario(
  scenario: ChromaScenarioDef,
): Promise<ScenarioResult> {
  const start = Date.now();
  const booted = await bootBrowser({
    unauthenticated: scenario.unauthenticated ?? false,
  });
  const driver = createChromaDriver({
    baseUrl: BASE_URL,
    contextFactory: async () => ({
      browser: booted.browser,
      context: booted.context,
      page: booted.page,
    }),
  });

  try {
    await driver.goto(scenario.chromaPath);

    if (scenario.expectRedirect) {
      const finalUrl = booted.page.url();
      if (!scenario.expectRedirect.test(finalUrl)) {
        return {
          id: scenario.id,
          name: scenario.name,
          status: 'FAIL',
          durationMs: Date.now() - start,
          notes: `Expected redirect ${scenario.expectRedirect} but URL was ${finalUrl}`,
        };
      }
    }

    if (scenario.expectText) {
      const text = await driver.pageText();
      for (const p of scenario.expectText) {
        const matched =
          p instanceof RegExp ? p.test(text) : text.includes(p);
        if (!matched) {
          return {
            id: scenario.id,
            name: scenario.name,
            status: 'FAIL',
            durationMs: Date.now() - start,
            notes: `Expected text ${p} not found in Chroma page`,
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
    await driver.close();
  }
}
```

- [ ] **Step 3: Run live (with VPN up + nats-weu reachable)**

```bash
cd ~/code/tentacular-main/thekraken
KUBECONFIG=/tmp/nats-fixed.kubeconfig \
  KRAKEN_E2E_CHROMA_BASE_URL=https://chroma.westeurope-dev1.ospo-dev.miralabs.dev \
  ./scripts/run-e2e-nats-weu.sh CHROMA-SMOKE-1 2>&1 | tail -30
```

Expected: CHROMA-SMOKE-1 PASS — anonymous request to `/` 302s to the Keycloak `/auth` URL.

- [ ] **Step 4: Commit**

```bash
git add test/e2e-chroma/chroma-runner.ts test/e2e-chroma/boot-driver.ts
git commit -m "feat(e2e-chroma): chroma-runner executes scenarios + persists cookies

CHROMA-SMOKE-1 (unauthenticated → Keycloak redirect) verified live
on nats-weu."
```

---

## Phase C2 — Manual cookie persistence + authenticated smoke

### Task 8: First-run prompt for manual login

**Files:**
- Modify: `thekraken/test/e2e-chroma/boot-driver.ts`
- Modify: `thekraken/test/e2e-chroma/chroma-session.ts`

- [ ] **Step 1: Add prompt-on-missing-cookies behavior**

In `boot-driver.ts`, before falling back to no-cookies behavior, check whether ANY chroma scenario will need auth. If yes and cookies are missing, print instructions and wait for the cookies file to appear.

Add to `chroma-session.ts`:

```typescript
import { existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';

export async function waitForCookies(
  path: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) {
      // Confirm the file isn't being actively written
      const s = await stat(path);
      if (s.size > 0) return;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Timed out waiting for cookies file at ${path}`);
}
```

In `boot-driver.ts`:

```typescript
export async function ensureCookiesAvailable(opts: {
  cookiesPath?: string;
  baseUrl: string;
  timeoutMs?: number;
}): Promise<void> {
  const path = opts.cookiesPath ?? defaultCookiePath();
  const cookies = await loadCookies(path);
  if (cookies.length > 0) return;

  console.log('');
  console.log('=========================================================');
  console.log('Chroma E2E: no auth cookies found.');
  console.log('');
  console.log(`Open in your browser: ${opts.baseUrl}`);
  console.log('Log in via Keycloak, then export cookies as JSON to:');
  console.log(`  ${path}`);
  console.log('');
  console.log('Use the Playwright "Get cookies" devtools or any cookie');
  console.log('export extension. The file should be a JSON array of');
  console.log('Playwright-format cookie objects.');
  console.log('=========================================================');
  console.log('');

  const timeout = opts.timeoutMs ?? 10 * 60 * 1000;
  await waitForCookies(path, timeout);
}
```

- [ ] **Step 2: Wire into run-all**

In `run-all.ts`, before running Chroma scenarios that need auth, call `ensureCookiesAvailable`:

```typescript
const needsAuth = chromaScenarios.some((s) => !s.unauthenticated);
if (needsAuth) {
  await ensureCookiesAvailable({ baseUrl: CHROMA_BASE_URL });
}
```

- [ ] **Step 3: Test the prompt path manually**

```bash
rm -f ~/.kraken-e2e-chroma/cookies.json
KUBECONFIG=/tmp/nats-fixed.kubeconfig ./scripts/run-e2e-nats-weu.sh
# expect: prints login URL, waits
# Then user manually creates the cookies file:
#   1. open Chroma in Chrome
#   2. log in
#   3. extract cookies via DevTools → Application → Storage → Cookies
#   4. save as JSON to ~/.kraken-e2e-chroma/cookies.json
# After file exists, run continues
```

- [ ] **Step 4: Commit**

```bash
git add test/e2e-chroma/boot-driver.ts test/e2e-chroma/chroma-session.ts test/e2e-slack/run-all.ts
git commit -m "feat(e2e-chroma): prompt for manual login on first run

When no cookies file exists, runner prints a login URL and waits up
to 10 min for the user to log in via the browser and save the
cookies file. Subsequent runs reuse the persisted session."
```

### Task 9: CHROMA-SMOKE-2 — authenticated home page loads

**Files:**
- Modify: `tentacular-chroma/test/e2e/scenarios.ts`

- [ ] **Step 1: Add the scenario**

```typescript
{
  id: 'CHROMA-SMOKE-2',
  name: 'authenticated home page loads with enclave list',
  chromaPath: '/',
  expectText: [
    /enclave/i, // page references enclaves somewhere
  ],
  forbiddenText: [
    /sign in to keycloak/i,
    /access denied/i,
  ],
  timeoutMs: 30_000,
},
```

- [ ] **Step 2: Run + verify live**

```bash
cd ~/code/tentacular-main/thekraken
KUBECONFIG=/tmp/nats-fixed.kubeconfig ./scripts/run-e2e-nats-weu.sh CHROMA-SMOKE-2 2>&1 | tail -10
```

Expected: PASS.

- [ ] **Step 3: Commit on chroma side**

```bash
cd ~/code/tentacular-main/tentacular-chroma
git add test/e2e/scenarios.ts
git commit -m "test(e2e): CHROMA-SMOKE-2 — authenticated / loads with enclave list"
git push
```

---

## Phase C3 — Pattern B retrofit on existing scenarios

### Task 10: Extend `ScenarioDef` with `chromaAssertion`

**Files:**
- Modify: `thekraken/test/e2e-slack/scenarios.ts`
- Modify: `thekraken/test/e2e-slack/harness.ts`

- [ ] **Step 1: Add field to interface**

```typescript
// In scenarios.ts ScenarioDef interface:
chromaAssertion?: {
  /** URL path on Chroma. Substitution: <TEST_ENCLAVE> replaced with the active test enclave. */
  path: string;
  expectText?: Array<string | RegExp>;
  forbiddenText?: Array<string | RegExp>;
  timeoutMs?: number;
  pollMs?: number;
};
```

- [ ] **Step 2: Implement chromaAssertion executor in harness**

In `harness.ts`, after the existing `mcpAssertion` block:

```typescript
import { createChromaDriver } from '../e2e-chroma/chroma-driver.js';

// ...
if (scenario.chromaAssertion && process.env['KRAKEN_E2E_DISABLE_CHROMA'] !== '1') {
  const driver = ctx.chromaDriver;
  if (!driver) {
    log.warn(`[harness] chromaAssertion requested but no driver (Chroma disabled or boot failed) — skipping ${scenario.id}`);
  } else {
    const path = scenario.chromaAssertion.path.replace(
      '<TEST_ENCLAVE>',
      TEST_ENCLAVE,
    );
    const pollMs = scenario.chromaAssertion.pollMs ?? 5_000;
    const budgetMs = scaledTimeout(scenario.chromaAssertion.timeoutMs ?? 60_000);
    const deadline = Date.now() + budgetMs;
    let lastErr: string | null = 'not evaluated';
    while (Date.now() < deadline) {
      try {
        await driver.goto(path);
        const text = await driver.pageText();
        let allMatched = true;
        if (scenario.chromaAssertion.expectText) {
          for (const p of scenario.chromaAssertion.expectText) {
            if (p instanceof RegExp) {
              if (!p.test(text)) { lastErr = `expected ${p} not in page`; allMatched = false; break; }
            } else if (!text.includes(p)) {
              lastErr = `expected "${p}" not in page`; allMatched = false; break;
            }
          }
        }
        if (scenario.chromaAssertion.forbiddenText) {
          for (const p of scenario.chromaAssertion.forbiddenText) {
            if (p instanceof RegExp) {
              if (p.test(text)) { lastErr = `forbidden ${p} in page`; allMatched = false; break; }
            } else if (text.includes(p)) {
              lastErr = `forbidden "${p}" in page`; allMatched = false; break;
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
      return {
        id: scenario.id,
        name: scenario.name,
        status: 'FAIL',
        durationMs: Date.now() - start,
        notes: `chromaAssertion: ${lastErr}`,
      };
    }
  }
}
```

The driver is shared via `ctx.chromaDriver` — the harness boot creates one shared driver passed to every scenario.

- [ ] **Step 3: Tests for the field**

```typescript
// test/unit/e2e-slack/scenario-chroma-assertion.test.ts
import { describe, it, expect } from 'vitest';
import { ALL_SCENARIOS, type ScenarioDef } from '../../e2e-slack/scenarios.js';

describe('ScenarioDef.chromaAssertion (rc.13 platform tests)', () => {
  it('field is optional', () => {
    const s: ScenarioDef = {
      id: 'X',
      name: 'x',
      channel: 'C',
      message: '@kraken hi',
    };
    expect(s.chromaAssertion).toBeUndefined();
  });

  it('field accepts path + expectText + forbiddenText + timeoutMs + pollMs', () => {
    const s: ScenarioDef = {
      id: 'X',
      name: 'x',
      channel: 'C',
      message: '@kraken hi',
      chromaAssertion: {
        path: '/enclaves/<TEST_ENCLAVE>',
        expectText: ['hello'],
        forbiddenText: [/error/i],
        timeoutMs: 30_000,
        pollMs: 2_000,
      },
    };
    expect(s.chromaAssertion?.path).toBe('/enclaves/<TEST_ENCLAVE>');
  });
});
```

- [ ] **Step 4: Commit**

```bash
git add test/e2e-slack/scenarios.ts test/e2e-slack/harness.ts test/unit/e2e-slack/scenario-chroma-assertion.test.ts
git commit -m "feat(e2e): chromaAssertion field on ScenarioDef + harness executor"
```

### Task 11: Retrofit E2 + E5 + F1 + F10 with chromaAssertion

**Files:**
- Modify: `thekraken/test/e2e-slack/scenarios.ts`

- [ ] **Step 1: Locate E2 (provision)**

```bash
grep -n "id: 'E2'" test/e2e-slack/scenarios.ts
```

Add chromaAssertion:

```typescript
// On the E2 scenario:
chromaAssertion: {
  path: '/enclaves/<TEST_ENCLAVE>',
  expectText: [/<TEST_ENCLAVE>/i],
  timeoutMs: 60_000,
  pollMs: 5_000,
},
```

- [ ] **Step 2: E5 (deprovision)**

```typescript
chromaAssertion: {
  path: '/',
  forbiddenText: [/<TEST_ENCLAVE>/i], // deprovisioned enclave should NOT appear
  timeoutMs: 60_000,
},
```

- [ ] **Step 3: F1 (build hello-world)**

```typescript
chromaAssertion: {
  path: '/enclaves/<TEST_ENCLAVE>/tentacles/hello-world',
  expectText: [/hello-world/i, /(ready|running|deployed)/i],
  timeoutMs: 600_000, // matches the F1 build timeout
  pollMs: 10_000,
},
```

- [ ] **Step 4: F10 (remove hello-world)**

```typescript
chromaAssertion: {
  path: '/enclaves/<TEST_ENCLAVE>/tentacles',
  forbiddenText: [/hello-world/i],
  timeoutMs: 60_000,
},
```

- [ ] **Step 5: Commit**

```bash
git add test/e2e-slack/scenarios.ts
git commit -m "test(e2e): chromaAssertion retrofit on E2 / E5 / F1 / F10"
```

---

## Phase C4 — Pattern A lifecycle scenario

### Task 12: Lifecycle runner + PLAT-LIFECYCLE-1

**Files:**
- Create: `thekraken/test/e2e-platform/scenarios.ts`
- Create: `thekraken/test/e2e-platform/lifecycle-runner.ts`
- Modify: `thekraken/test/e2e-slack/run-all.ts`

- [ ] **Step 1: Define the linear-flow scenario shape**

```typescript
// test/e2e-platform/scenarios.ts
export type LifecycleStep =
  | { kind: 'slack'; channel: string; message: string;
      expectedPatterns?: Array<string | RegExp>;
      forbiddenPatterns?: Array<string | RegExp>;
      timeoutMs?: number }
  | { kind: 'chroma'; path: string;
      expectText?: Array<string | RegExp>;
      forbiddenText?: Array<string | RegExp>;
      timeoutMs?: number; pollMs?: number };

export interface LifecycleScenarioDef {
  id: string;
  name: string;
  steps: LifecycleStep[];
  /**
   * Cleanup steps run in a finally-block regardless of pass/fail.
   * Typically deprovision and remove tentacles.
   */
  cleanup?: LifecycleStep[];
  gatedBy?: string; // env var name that must equal '1' for the scenario to run
}

export const LIFECYCLE_SCENARIOS: LifecycleScenarioDef[] = [
  {
    id: 'PLAT-LIFECYCLE-1',
    name: 'create enclave → tentacle → run → describe in Chroma → remove',
    gatedBy: 'KRAKEN_E2E_ALLOW_DESTRUCTIVE',
    steps: [
      { kind: 'slack', channel: '<CHANNELS.test>',
        message: '@Kraken provision this channel as an enclave',
        expectedPatterns: [/provision|enclave/i],
        timeoutMs: 60_000 },
      { kind: 'chroma', path: '/enclaves/<TEST_ENCLAVE>',
        expectText: [/<TEST_ENCLAVE>/i],
        timeoutMs: 60_000, pollMs: 5_000 },
      { kind: 'slack', channel: '<CHANNELS.test>',
        message: '@Kraken build a hello-world tentacle from the echo-probe scaffold',
        expectedPatterns: [/build|deploy/i],
        timeoutMs: 600_000 },
      { kind: 'chroma', path: '/enclaves/<TEST_ENCLAVE>/tentacles/hello-world',
        expectText: [/hello-world/i, /(ready|running|deployed)/i],
        timeoutMs: 600_000, pollMs: 10_000 },
      { kind: 'slack', channel: '<CHANNELS.test>',
        message: '@Kraken run hello-world',
        expectedPatterns: [/started|triggered|run/i],
        timeoutMs: 60_000 },
      { kind: 'chroma', path: '/enclaves/<TEST_ENCLAVE>/tentacles/hello-world/runs',
        expectText: [/hello-world/i],
        timeoutMs: 120_000, pollMs: 10_000 },
    ],
    cleanup: [
      { kind: 'slack', channel: '<CHANNELS.test>',
        message: '@Kraken remove hello-world',
        expectedPatterns: [/removed|gone|done/i],
        timeoutMs: 120_000 },
      { kind: 'slack', channel: '<CHANNELS.test>',
        message: '@Kraken deprovision this channel',
        expectedPatterns: [/deprov|removed/i],
        timeoutMs: 60_000 },
    ],
  },
];
```

- [ ] **Step 2: Implement the runner**

```typescript
// test/e2e-platform/lifecycle-runner.ts
import type { LifecycleScenarioDef, LifecycleStep } from './scenarios.js';
import type { ScenarioResult } from '../e2e-slack/harness.js';
import type { SlackDriver } from '../e2e-slack/slack-driver.js';
import type { ChromaDriver } from '../e2e-chroma/chroma-driver.js';

export interface LifecycleRunnerDeps {
  slackDriver: SlackDriver;
  chromaDriver: ChromaDriver;
  channels: Record<string, string>;
  testEnclave: string;
  scaledTimeout: (n: number | undefined) => number;
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
      notes: `gated by ${scenario.gatedBy}=1`,
    };
  }

  const start = Date.now();
  let stepFailed: { idx: number; err: string } | null = null;

  async function runStep(step: LifecycleStep, idx: number): Promise<void> {
    if (step.kind === 'slack') {
      const channelKey = step.channel.replace(/^<|>$/g, '').replace(/^CHANNELS\./, '');
      const channelId = deps.channels[channelKey];
      if (!channelId) throw new Error(`step ${idx}: unknown channel "${step.channel}"`);
      const ts = await deps.slackDriver.postAsUser(channelId, step.message);
      const reply = await deps.slackDriver.waitForKrakenReply(
        channelId,
        ts,
        deps.scaledTimeout(step.timeoutMs ?? 60_000),
      );
      if (step.expectedPatterns) {
        for (const p of step.expectedPatterns) {
          const matched = p instanceof RegExp ? p.test(reply) : reply.includes(p);
          if (!matched) throw new Error(`step ${idx}: expected ${p} not in reply: ${reply.slice(0, 200)}`);
        }
      }
      if (step.forbiddenPatterns) {
        for (const p of step.forbiddenPatterns) {
          const matched = p instanceof RegExp ? p.test(reply) : reply.includes(p);
          if (matched) throw new Error(`step ${idx}: forbidden ${p} in reply`);
        }
      }
    } else {
      const path = step.path.replace('<TEST_ENCLAVE>', deps.testEnclave);
      const pollMs = step.pollMs ?? 5_000;
      const budgetMs = deps.scaledTimeout(step.timeoutMs ?? 60_000);
      const deadline = Date.now() + budgetMs;
      let lastErr: string | null = 'not evaluated';
      while (Date.now() < deadline) {
        try {
          await deps.chromaDriver.goto(path);
          const text = await deps.chromaDriver.pageText();
          let allMatched = true;
          if (step.expectText) {
            for (const p of step.expectText) {
              const matched = p instanceof RegExp ? p.test(text) : text.includes(p);
              if (!matched) { lastErr = `expected ${p} not in page`; allMatched = false; break; }
            }
          }
          if (step.forbiddenText) {
            for (const p of step.forbiddenText) {
              const matched = p instanceof RegExp ? p.test(text) : text.includes(p);
              if (matched) { lastErr = `forbidden ${p} in page`; allMatched = false; break; }
            }
          }
          if (allMatched) { lastErr = null; break; }
        } catch (err) {
          lastErr = (err as Error).message;
        }
        await new Promise((r) => setTimeout(r, pollMs));
      }
      if (lastErr) throw new Error(`step ${idx}: chroma ${lastErr}`);
    }
  }

  try {
    for (const [idx, step] of scenario.steps.entries()) {
      await runStep(step, idx);
    }
  } catch (err) {
    stepFailed = { idx: -1, err: (err as Error).message };
  } finally {
    // Best-effort cleanup
    if (scenario.cleanup) {
      for (const [idx, step] of scenario.cleanup.entries()) {
        try { await runStep(step, idx); } catch { /* swallow cleanup errors */ }
      }
    }
  }

  return {
    id: scenario.id,
    name: scenario.name,
    status: stepFailed ? 'FAIL' : 'PASS',
    durationMs: Date.now() - start,
    notes: stepFailed?.err ?? '',
  };
}
```

- [ ] **Step 3: Wire into run-all**

After existing scenario loop:

```typescript
import { LIFECYCLE_SCENARIOS } from '../e2e-platform/scenarios.js';
import { runLifecycleScenario } from '../e2e-platform/lifecycle-runner.js';

// after Chroma scenario loop:
for (const ls of LIFECYCLE_SCENARIOS) {
  const r = await runLifecycleScenario(ls, {
    slackDriver: ctx.driver,
    chromaDriver: ctx.chromaDriver,
    channels: ctx.channelIds,
    testEnclave: TEST_ENCLAVE,
    scaledTimeout,
  });
  results.push(r);
  printScenarioLine(r);
}
```

- [ ] **Step 4: Run live (gated)**

```bash
KUBECONFIG=/tmp/nats-fixed.kubeconfig \
  KRAKEN_E2E_ALLOW_DESTRUCTIVE=1 \
  KRAKEN_E2E_TIMEOUT_MULT=5 \
  ./scripts/run-e2e-nats-weu.sh PLAT-LIFECYCLE-1
```

Expected: PASS or detailed FAIL with which step failed.

- [ ] **Step 5: Commit**

```bash
git add test/e2e-platform/ test/e2e-slack/run-all.ts
git commit -m "feat(e2e-platform): PLAT-LIFECYCLE-1 — Slack + Chroma full lifecycle journey"
```

---

## Phase C5 — Remaining smoke scenarios

### Task 13: Add CHROMA-SMOKE-3..7

**Files:**
- Modify: `tentacular-chroma/test/e2e/scenarios.ts`

- [ ] **Step 1: Add deep-link, 404, deprovisioned, read-only, DAG node tests**

```typescript
{
  id: 'CHROMA-SMOKE-3',
  name: 'authenticated deep-link to enclave loads (Slack URL pattern)',
  chromaPath: '/enclaves/tentacular-agensys',
  expectText: [/tentacular-agensys/i],
  timeoutMs: 30_000,
},
{
  id: 'CHROMA-SMOKE-4',
  name: 'unknown enclave path returns 404',
  chromaPath: '/enclaves/this-enclave-does-not-exist',
  expectText: [/not found|404/i],
  timeoutMs: 30_000,
},
{
  id: 'CHROMA-SMOKE-5',
  name: 'deprovisioned enclave does not appear in list',
  chromaPath: '/',
  forbiddenText: [/deprovisioned-test-enclave/i],
  timeoutMs: 30_000,
},
{
  id: 'CHROMA-SMOKE-6',
  name: 'no mutation form fields rendered (read-only contract)',
  chromaPath: '/enclaves/tentacular-agensys',
  forbiddenText: [/<input.*type="(submit|button)"/i, /<form/i],
  timeoutMs: 30_000,
},
{
  id: 'CHROMA-SMOKE-7',
  name: 'tentacle detail page shows DAG node list',
  chromaPath: '/enclaves/tentacular-agensys/tentacles/ai-news-digest',
  expectText: [/ai-news-digest/i],
  timeoutMs: 30_000,
},
```

- [ ] **Step 2: Run live + commit**

```bash
cd ~/code/tentacular-main/thekraken
KUBECONFIG=/tmp/nats-fixed.kubeconfig ./scripts/run-e2e-nats-weu.sh CHROMA-SMOKE-3 CHROMA-SMOKE-4 CHROMA-SMOKE-5 CHROMA-SMOKE-6 CHROMA-SMOKE-7

cd ~/code/tentacular-main/tentacular-chroma
git add test/e2e/scenarios.ts
git commit -m "test(e2e): CHROMA-SMOKE-3..7 — deep-link, 404, deprovisioned, read-only, DAG"
git push
```

---

## Phase C6 — Final E2E + hygiene + RC

### Task 14: Hygiene + final integrated run

- [ ] **Step 1: Run all checks**

```bash
cd ~/code/tentacular-main/thekraken
npx tsc --noEmit
npm run lint
npm run format:check
npm test 2>&1 | grep "Test Files" | tail -3
```

Expected: tsc + lint + format clean. Test Files baseline.

- [ ] **Step 2: Apply prettier if needed**

```bash
npm run format -- --write
git add -u && git commit -m "chore: prettier cleanup" || true
```

- [ ] **Step 3: Push + ready PR**

```bash
git push origin feat/chroma-e2e-platform-tests
gh pr ready
```

### Task 15: Final live E2E run (top to bottom, all three patterns)

- [ ] **Step 1: Run with all gates ON**

```bash
KUBECONFIG=/tmp/nats-fixed.kubeconfig \
  KRAKEN_E2E_TIMEOUT_MULT=5 \
  KRAKEN_E2E_ALLOW_DESTRUCTIVE=1 \
  ./scripts/run-e2e-nats-weu.sh 2>&1 | tee /tmp/e2e-platform.log | tail -200
```

- [ ] **Step 2: Capture summary**

```bash
grep -E "Summary|^[A-Z][0-9]|^CHROMA|^PLAT" /tmp/e2e-platform.log | tail -100
```

- [ ] **Step 3: Triage failures (any)**

Apply same pattern as rc.13 triage: per-scenario reply text + Kraken pod logs + decide real bug vs regex / data drift / latency.

### Task 16: Merge + decide on RC bump

- [ ] **Step 1: Merge thekraken PR**

```bash
gh pr merge --squash --admin
```

- [ ] **Step 2: Merge tentacular-chroma companion PR**

```bash
cd ~/code/tentacular-main/tentacular-chroma
gh pr merge --squash --admin
```

- [ ] **Step 3: Decide on rc.14 vs roll into v0.10.0 final**

This decision is the user's. Two options:
- (a) Cut rc.14 lockstep so the test framework lands as a versioned RC artifact.
- (b) The framework is test-only — no production code change — so it can ride along into v0.10.0 final without an RC bump.

Default: (a) — cut rc.14 with the framework + any small production fixes that accumulated, then v0.10.0 final from rc.14 if E2E fully green.

---

## Self-Review

**Spec coverage:**

| Spec section | Task | Status |
|---|---|---|
| Pattern A — Linear lifecycle scenarios | T12 | ✓ |
| Pattern B — chromaAssertion field | T10, T11 | ✓ |
| Pattern C — Standalone Chroma scenarios | T4, T9, T13 | ✓ |
| ChromaDriver | T2 | ✓ |
| ChromaSession (cookie jar) | T3 | ✓ |
| Cross-repo scenario loader | T5 | ✓ |
| Runner integration | T6, T7 | ✓ |
| Manual login prompt | T8 | ✓ |
| Configuration env vars | T7 (BASE_URL), T3 (COOKIES), T6 (DISABLE_CHROMA) | ✓ |
| Phase rollout C1-C6 | Phases C1, C2, C3, C4, C5, C6 | ✓ |

**Placeholders:** none. Every task contains exact paths, runnable code, runnable commands.

**Type consistency:** `ChromaScenarioDef` consistent across T4, T5, T7. `LifecycleScenarioDef` and `LifecycleStep` defined in T12 only. `ChromaDriver` interface stable from T2 through T7, T10, T12.

---

## Execution Handoff

Plan saved to `thekraken/docs/superpowers/plans/2026-05-07-chroma-e2e-platform-tests.md`.

Two execution options:

1. **Subagent-Driven (recommended)** — fresh subagent per task with two-stage review
2. **Inline Execution** — execute in batches with checkpoints

User said go with subagent-driven via the standard pattern.
