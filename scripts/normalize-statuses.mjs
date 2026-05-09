#!/usr/bin/env node
import path from 'path';
import { fileURLToPath } from 'url';
import { createTrackerStore, DEFAULT_TRACKER_PATH } from '../lib/tracker-store.mjs';
import { normalizeStatus } from '../lib/status-utils.mjs';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function normalizeTrackerStatuses(tracker) {
  const next = JSON.parse(JSON.stringify(tracker ?? {}));
  const changes = [];
  for (const [id, job] of Object.entries(next)) {
    if (!job || typeof job !== 'object') continue;
    const before = job.status;
    const after = normalizeStatus(before);
    if (before !== after) {
      job.status = after;
      changes.push({ id, before, after });
    }
  }
  return { tracker: next, changes };
}

export async function main(argv = process.argv.slice(2), {
  trackerPath = DEFAULT_TRACKER_PATH,
  stdout = process.stdout,
} = {}) {
  const write = argv.includes('--write');
  const dryRun = argv.includes('--dry-run') || !write;
  if (write && argv.includes('--dry-run')) throw new Error('Use either --dry-run or --write, not both');

  const store = createTrackerStore({ trackerPath });
  const current = store.loadTracker();
  const { tracker, changes } = normalizeTrackerStatuses(current);

  for (const change of changes) {
    stdout.write(`${change.id}: ${JSON.stringify(change.before)} -> ${change.after}\n`);
  }
  stdout.write(`${dryRun ? 'Would update' : 'Updated'} ${changes.length} tracker status${changes.length === 1 ? '' : 'es'}.\n`);

  if (write && changes.length) store.saveTrackerAtomic(tracker);
  return { changes, wrote: write && changes.length > 0, trackerPath: path.resolve(APP_ROOT, trackerPath) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    process.stderr.write(`${err.message}\n`);
    process.exitCode = 1;
  });
}
