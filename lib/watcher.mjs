import chokidar from 'chokidar';
import path from 'path';
import { fileURLToPath } from 'url';
import { invalidateCache } from './cache.mjs';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let _debounceTimer = null;

function scheduleInvalidate(filePath) {
  clearTimeout(_debounceTimer);
  _debounceTimer = setTimeout(() => {
    process.stdout.write(`[watcher] invalidating cache (changed: ${path.basename(filePath)})\n`);
    invalidateCache();
  }, 600);
}

/**
 * Files that can affect dashboard payloads or resume-generation context.
 */
export function getWatchTargets() {
  return [
    path.resolve(APP_ROOT, 'config', 'profile.yml'),
    path.resolve(APP_ROOT, 'data', 'tracker.json'),
    path.resolve(APP_ROOT, 'data', '*.md'),
    path.resolve(APP_ROOT, 'data', 'gmail-jobs.json'),
    path.resolve(APP_ROOT, 'data', 'scan-history.tsv'),
    path.resolve(APP_ROOT, 'data', 'ab-analytics.json'),
    path.resolve(APP_ROOT, 'reports', '**', '*.md'),
    path.resolve(APP_ROOT, 'portals.yml'),
    path.resolve(APP_ROOT, 'output'),
  ];
}

/**
 * Start watching data files and output directory.
 * Call once after server starts.
 */
export function startWatcher() {
  const watcher = chokidar.watch(getWatchTargets(), {
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
  });

  watcher.on('add',    scheduleInvalidate);
  watcher.on('change', scheduleInvalidate);
  watcher.on('unlink', scheduleInvalidate);
  watcher.on('error',  err => process.stderr.write(`[watcher] error: ${err.message}\n`));

  return watcher;
}
