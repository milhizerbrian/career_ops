import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.resolve(APP_ROOT, 'public', 'index.html'), 'utf8');
const sourceBadges = fs.readFileSync(path.resolve(APP_ROOT, 'public', 'js', 'source-badges.js'), 'utf8');
const dashboard = fs.readFileSync(path.resolve(APP_ROOT, 'public', 'js', 'dashboard.js'), 'utf8');

describe('source badge rendering', () => {
  it('normalizes current source variants before display and class selection', () => {
    assert.match(sourceBadges, /export function normalizeSource\(source\)/);
    assert.match(sourceBadges, /s\.startsWith\('linkedin'\)/);
    assert.match(sourceBadges, /s\.startsWith\('gmail'\)/);
    assert.match(sourceBadges, /\['manual', 'greenhouse', 'ashby', 'lever', 'workday'\]\.includes\(s\)/);
    assert.match(dashboard, /sourceDisplayLabel\(job\.source\)/);
    assert.match(dashboard, /sourceBadgeCls\(job\.source\)/);
  });

  it('uses normalized sources for the opportunity source filter', () => {
    assert.match(dashboard, /visibleDashboardJobs\(allJobs\)\.map\(j => normalizeSource\(j\.source\)\)/);
    assert.match(dashboard, /normalizeSource\(j\.source\) !== sourceF/);
    assert.match(dashboard, /o\.value = s; o\.textContent = sourceDisplayLabel\(s\)/);
  });

  it('has visual classes for supported source badges', () => {
    for (const source of ['gmail', 'linkedin', 'greenhouse', 'ashby', 'lever', 'workday', 'manual']) {
      assert.match(sourceBadges, new RegExp(`s === '${source}'`));
    }
  });

  it('loads the frontend through a module entrypoint', () => {
    assert.match(html, /<script type="module" src="\/js\/dashboard\.js"><\/script>/);
    assert.match(dashboard, /from '\.\/source-badges\.js'/);
  });
});
