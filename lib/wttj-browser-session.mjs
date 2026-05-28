import { chromium } from 'playwright';
import path from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

export const WTTJ_APP_BASE = 'https://app.welcometothejungle.com';

const HOME = process.env.HOME;
const SESSION_DIR = path.join(HOME, '.career-ops-wttj');
const LOGIN_PROFILE_DIR = path.join(SESSION_DIR, 'chrome-login-profile');
export const WTTJ_STORAGE_STATE_FILE = path.join(SESSION_DIR, 'storage-state.json');

export function isWttjLoginUrl(value) {
  try {
    const url = new URL(value, WTTJ_APP_BASE);
    return url.hostname === 'app.welcometothejungle.com' && (
      url.pathname === '/login' ||
      url.pathname.startsWith('/login/') ||
      url.pathname === '/signin' ||
      url.pathname.startsWith('/signin/')
    );
  } catch {
    return false;
  }
}

export function hasWttjSession() {
  return existsSync(WTTJ_STORAGE_STATE_FILE);
}

async function waitForUserConfirmation(message) {
  const rl = readline.createInterface({ input, output });
  try {
    await rl.question(message);
  } finally {
    rl.close();
  }
}

export async function loginWttjSession({ timeoutMs = 30 * 60 * 1000 } = {}) {
  mkdirSync(SESSION_DIR, { recursive: true });

  let context;
  try {
    context = await chromium.launchPersistentContext(LOGIN_PROFILE_DIR, {
      channel: process.env.WTTJ_LOGIN_CHANNEL || 'chrome',
      headless: false,
      ignoreDefaultArgs: ['--enable-automation'],
      args: [
        '--disable-blink-features=AutomationControlled',
        '--no-first-run',
        '--no-default-browser-check',
      ],
    });
  } catch (err) {
    process.stdout.write(
      `Could not open Google Chrome for WTTJ login (${err.message}). Falling back to Playwright Chromium.\n`
    );
    context = await chromium.launchPersistentContext(LOGIN_PROFILE_DIR, {
      headless: false,
    });
  }
  const page = await context.newPage();

  try {
    process.stdout.write(
      'Opening WTTJ login in a persistent Chrome profile. Complete login/MFA in the browser window.\n'
    );
    await page.goto(WTTJ_APP_BASE, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await waitForUserConfirmation(
      'After the WTTJ app is visibly logged in, return here and press Enter to save the session. '
    );
    await page.waitForLoadState('domcontentloaded', { timeout: timeoutMs }).catch(() => {});

    if (isWttjLoginUrl(page.url())) {
      throw new Error('Still on the WTTJ login page. Complete login before pressing Enter.');
    }

    await context.storageState({ path: WTTJ_STORAGE_STATE_FILE });
    process.stdout.write(`WTTJ session saved to ${WTTJ_STORAGE_STATE_FILE}\n`);
  } finally {
    await context.close();
  }
}

export async function withWttjBrowser(fn, { headless = true } = {}) {
  if (!hasWttjSession()) {
    throw new Error(
      'No WTTJ session found. Run: node scan-wttj-browser.mjs --login'
    );
  }

  const browser = await chromium.launch({ headless });
  const context = await browser.newContext({ storageState: WTTJ_STORAGE_STATE_FILE });
  try {
    return await fn(context);
  } finally {
    await context.close();
    await browser.close();
  }
}
