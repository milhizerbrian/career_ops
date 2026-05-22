import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';

const HOME = process.env.HOME;
const ORBITA_DIR = path.join(HOME, '.gologin/browser');
const GOLOGIN_PROFILES = path.join(HOME, 'Library/Application Support/Gologin/profiles');
const CDP_PORT = 9222;

function findOrbitaBinary() {
  if (!existsSync(ORBITA_DIR)) throw new Error('GoLogin Orbita browser not found — is GoLogin installed?');
  const dirs = readdirSync(ORBITA_DIR)
    .filter(d => d.startsWith('orbita-browser-') && !d.endsWith('.tar.gz'))
    .sort();
  if (!dirs.length) throw new Error('No Orbita browser version found in ' + ORBITA_DIR);
  const bin = path.join(ORBITA_DIR, dirs[dirs.length - 1], 'Orbita-Browser.app/Contents/MacOS/Orbita');
  if (!existsSync(bin)) throw new Error('Orbita binary not found: ' + bin);
  return bin;
}

async function waitForCDP(port, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://localhost:${port}/json/version`, { signal: AbortSignal.timeout(1000) });
      if (res.ok) {
        const { webSocketDebuggerUrl } = await res.json();
        return webSocketDebuggerUrl;
      }
    } catch {}
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error(`Orbita CDP not ready after ${timeoutMs}ms on port ${port}`);
}

export async function withBrowser(fn) {
  const profileId = process.env.GOLOGIN_PROFILE_ID;
  if (profileId) return withOrbitaBrowser(fn, profileId);
  return withHeadlessBrowser(fn);
}

async function withOrbitaBrowser(fn, profileId) {
  const userDataDir = path.join(GOLOGIN_PROFILES, profileId);
  if (!existsSync(userDataDir)) {
    throw new Error(
      `GoLogin profile not found: ${userDataDir}\n` +
      'Open GoLogin desktop app and make sure the profile has been synced.'
    );
  }

  // Clear any stale singleton locks left by a previous run or GoLogin UI
  for (const f of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    try { rmSync(path.join(userDataDir, f)); } catch {}
  }

  const orbitaBin = findOrbitaBinary();
  const proc = spawn(orbitaBin, [
    `--user-data-dir=${userDataDir}`,
    `--remote-debugging-port=${CDP_PORT}`,
    '--use-mock-keychain',
    '--no-first-run',
    '--restore-last-session',
    '--disable-features=PrintCompositorLPAC',
    '--webrtc-ip-handling-policy=default_public_interface_only',
    '--font-masking-mode=1',
    '--lang=en-US',
  ], { stdio: 'ignore', detached: false });

  let browser;
  try {
    const wsUrl = await waitForCDP(CDP_PORT);
    browser = await chromium.connectOverCDP(wsUrl);
    return await fn(browser);
  } finally {
    if (browser) await browser.close().catch(() => {});
    proc.kill('SIGTERM');
    await new Promise(r => setTimeout(r, 800));
    proc.kill('SIGKILL');
  }
}

async function withHeadlessBrowser(fn) {
  const browser = await chromium.launch({ headless: true });
  try {
    return await fn(browser);
  } finally {
    await browser.close();
  }
}
