import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getWatchTargets } from '../lib/watcher.mjs';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('watcher targets', () => {
  it('includes dashboard and resume context files that invalidate cache', () => {
    const targets = getWatchTargets();
    for (const target of [
      path.resolve(APP_ROOT, 'config', 'profile.yml'),
      path.resolve(APP_ROOT, 'data', 'gmail-jobs.json'),
      path.resolve(APP_ROOT, 'data', 'scan-history.tsv'),
      path.resolve(APP_ROOT, 'data', 'ab-analytics.json'),
      path.resolve(APP_ROOT, 'reports', '**', '*.md'),
      path.resolve(APP_ROOT, 'portals.yml'),
    ]) {
      assert.ok(targets.includes(target), `missing watch target: ${target}`);
    }
  });

  it('preserves existing tracker, data markdown, and output watch coverage', () => {
    const targets = getWatchTargets();
    assert.ok(targets.includes(path.resolve(APP_ROOT, 'data', 'tracker.json')));
    assert.ok(targets.includes(path.resolve(APP_ROOT, 'data', '*.md')));
    assert.ok(targets.includes(path.resolve(APP_ROOT, 'output')));
  });
});
