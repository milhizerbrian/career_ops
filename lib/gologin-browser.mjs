import { chromium } from 'playwright';
import path from 'node:path';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

const HOME = process.env.HOME;
const SESSION_DIR = path.join(HOME, '.career-ops-linkedin');
const COOKIES_FILE = path.join(SESSION_DIR, 'cookies.json');
const pooledBrowserPromises = new Map();
let cleanupHooksInstalled = false;

export function saveLinkedInCookie(liAt) {
  mkdirSync(SESSION_DIR, { recursive: true });
  writeFileSync(COOKIES_FILE, JSON.stringify({
    li_at: liAt,
    savedAt: new Date().toISOString(),
  }, null, 2));
}

function loadLinkedInCookie() {
  if (!existsSync(COOKIES_FILE)) return null;
  try {
    const { li_at } = JSON.parse(readFileSync(COOKIES_FILE, 'utf8'));
    return li_at || null;
  } catch {
    return null;
  }
}

export async function withBrowser(fn) {
  const profileId = process.env.GOLOGIN_PROFILE_ID;
  if (profileId) return withAuthenticatedBrowser(fn);
  return withHeadlessBrowser(fn);
}

function browserPoolEnabled() {
  return process.env.CAREER_OPS_BROWSER_POOL !== '0';
}

function installCleanupHooks() {
  if (cleanupHooksInstalled) return;
  cleanupHooksInstalled = true;
  process.once('exit', () => {
    for (const browserPromise of pooledBrowserPromises.values()) {
      browserPromise.then(browser => browser.close()).catch(() => {});
    }
  });
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, async () => {
      await closePooledBrowsers();
      process.exit(signal === 'SIGINT' ? 130 : 143);
    });
  }
}

async function browserForPool(poolKey) {
  if (!browserPoolEnabled()) {
    return { browser: await chromium.launch({ headless: true }), pooled: false };
  }
  installCleanupHooks();
  if (!pooledBrowserPromises.has(poolKey)) {
    pooledBrowserPromises.set(poolKey, chromium.launch({ headless: true }).catch(err => {
      pooledBrowserPromises.delete(poolKey);
      throw err;
    }));
  }
  return { browser: await pooledBrowserPromises.get(poolKey), pooled: true };
}

export async function closePooledBrowsers() {
  const browserPromises = [...pooledBrowserPromises.values()];
  pooledBrowserPromises.clear();
  await Promise.all(browserPromises.map(async browserPromise => {
    try {
      const browser = await browserPromise;
      await browser.close();
    } catch { /* ignore cleanup errors */ }
  }));
}

async function withAuthenticatedBrowser(fn) {
  const liAt = loadLinkedInCookie();
  if (!liAt) {
    throw new Error(
      'No LinkedIn session cookie found.\n' +
      'Run: node scripts/scrape-linkedin-contacts.mjs --login'
    );
  }

  const { browser, pooled } = await browserForPool('authenticated');
  const context = await browser.newContext();
  await context.addCookies([{
    name: 'li_at',
    value: liAt,
    domain: '.linkedin.com',
    path: '/',
    httpOnly: true,
    secure: true,
    sameSite: 'None',
  }]);

  try {
    return await fn(context);
  } finally {
    await context.close();
    if (!pooled) await browser.close();
  }
}

async function withHeadlessBrowser(fn) {
  const { browser, pooled } = await browserForPool('headless');
  try {
    return await fn(browser);
  } finally {
    if (!pooled) await browser.close();
  }
}
