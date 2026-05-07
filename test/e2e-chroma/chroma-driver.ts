/**
 * Playwright-based driver for the Chroma observability dashboard.
 *
 * Wraps page.goto / page.innerText / page.waitForFunction with a small
 * helper API used by E2E scenarios. The driver is initialized lazily
 * on first use; production wires the contextFactory to playwright's
 * chromium.launch + newContext + newPage. Tests inject a stub.
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
  contextFactory: () => Promise<{
    context: BrowserContext;
    page: Page;
    browser?: Browser;
  }>;
}

export function createChromaDriver(deps: ChromaDriverDeps): ChromaDriver {
  const baseUrl = deps.baseUrl.replace(/\/+$/, '');
  let initialized: {
    page: Page;
    context: BrowserContext;
    browser?: Browser;
  } | null = null;

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
