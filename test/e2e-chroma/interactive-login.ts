#!/usr/bin/env node
/**
 * One-shot interactive login flow for the Chroma E2E test framework.
 *
 * Launches Chromium HEADED (visible window), navigates to Chroma's
 * homepage, and lets the user log in via the Keycloak page. Polls
 * for an authenticated URL (no /signin or /auth in path); on detect,
 * saves cookies to KRAKEN_E2E_CHROMA_COOKIES (default
 * ~/.kraken-e2e-chroma/cookies.json) and exits.
 *
 * Run via: npm run e2e-chroma:login
 *
 * Spec: docs/superpowers/specs/2026-05-07-chroma-e2e-platform-tests-design.md
 */
import { bootBrowser, persistCookiesFrom } from './boot-driver.js';
import { defaultCookiePath } from './chroma-session.js';

const BASE_URL =
  process.env.KRAKEN_E2E_CHROMA_BASE_URL ??
  'https://chroma.westeurope-dev1.ospo-dev.miralabs.dev';

/**
 * Polling cadence + budget for waiting for the user to complete login.
 * 10-minute total budget is generous; if login takes longer than that,
 * something is wrong and the user should investigate manually.
 */
const POLL_INTERVAL_MS = 1_000;
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * A URL is authenticated when it neither contains a sign-in page path
 * nor the Keycloak auth endpoint. Substring match keeps this flexible
 * across Next-Auth's various transitional URLs.
 */
function isAuthenticatedUrl(url: string): boolean {
  const lower = url.toLowerCase();
  if (lower.includes('/api/auth/signin')) return false;
  if (lower.includes('/auth/realms/') && lower.includes('/openid-connect/'))
    return false;
  if (lower.includes('error=')) return false;
  // Accept anything else under the Chroma origin
  try {
    const u = new URL(url);
    const base = new URL(BASE_URL);
    return u.origin === base.origin;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  console.log('');
  console.log('=========================================================');
  console.log('Chroma E2E: interactive login');
  console.log('');
  console.log(`Opening Chromium pointed at: ${BASE_URL}`);
  console.log('Log in via the Keycloak page that appears.');
  console.log('Cookies will be saved on successful login.');
  console.log(`Cookie file: ${defaultCookiePath()}`);
  console.log('=========================================================');
  console.log('');

  // unauthenticated: true ensures we don't pre-load existing cookies,
  // so the user always sees the fresh login flow.
  const booted = await bootBrowser({
    headless: false,
    unauthenticated: true,
  });

  try {
    await booted.page.goto(BASE_URL, { waitUntil: 'load', timeout: 30_000 });
    console.log(`Initial URL after navigate: ${booted.page.url()}`);

    const deadline = Date.now() + LOGIN_TIMEOUT_MS;
    let lastUrl = '';
    while (Date.now() < deadline) {
      const url = booted.page.url();
      if (url !== lastUrl) {
        console.log(`URL: ${url}`);
        lastUrl = url;
      }
      if (isAuthenticatedUrl(url)) {
        console.log('');
        console.log('Authenticated URL detected — saving cookies');
        await persistCookiesFrom(booted.context);
        console.log(`Cookies saved to ${defaultCookiePath()}`);
        return;
      }
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
    console.error('');
    console.error(
      `Timed out after ${LOGIN_TIMEOUT_MS / 1000}s — last URL: ${booted.page.url()}`,
    );
    console.error('Login was not completed. Cookies NOT saved.');
    process.exitCode = 1;
  } finally {
    await booted.context.close().catch(() => undefined);
    await booted.browser.close().catch(() => undefined);
  }
}

main().catch((err) => {
  console.error('e2e-chroma:login failed:', err);
  process.exit(1);
});
