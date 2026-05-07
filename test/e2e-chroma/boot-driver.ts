/**
 * Bootstraps a Playwright browser + context with persisted cookies.
 *
 * Returns { browser, context, page } for the ChromaDriver factory.
 * The Playwright import is dynamic so this module loads even when
 * Playwright isn't installed (e.g., in unit-test environments that
 * mock the boot path).
 *
 * Spec: docs/superpowers/specs/2026-05-07-chroma-e2e-platform-tests-design.md
 */
import type { Browser, BrowserContext, Page } from 'playwright';
import {
  defaultCookiePath,
  loadCookies,
  saveCookies,
} from './chroma-session.js';

export interface BootedBrowser {
  browser: Browser;
  context: BrowserContext;
  page: Page;
}

export interface BootBrowserOpts {
  cookiesPath?: string;
  unauthenticated?: boolean;
}

export async function bootBrowser(
  opts: BootBrowserOpts = {},
): Promise<BootedBrowser> {
  // Dynamic import so this module loads in environments without
  // Playwright (e.g., unit tests that mock the runner).
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();

  if (!opts.unauthenticated) {
    const path = opts.cookiesPath ?? defaultCookiePath();
    const cookies = await loadCookies(path);
    if (cookies.length > 0) {
      await context.addCookies(cookies as never);
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
  await saveCookies(cookiesPath ?? defaultCookiePath(), cookies as never);
}
