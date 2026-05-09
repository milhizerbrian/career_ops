import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dashboard = fs.readFileSync(path.resolve(APP_ROOT, 'public', 'js', 'dashboard.js'), 'utf8');
const state = fs.readFileSync(path.resolve(APP_ROOT, 'public', 'js', 'state.js'), 'utf8');

describe('dashboard metadata rendering', () => {
  it('keeps builtAt and lastScanAt in dashboard metadata state', () => {
    assert.match(dashboard, /let dashboardMeta = \{ builtAt: null, lastScanAt: null \}/);
    assert.match(state, /export function createDashboardMeta\(data = \{\}\)/);
    assert.match(dashboard, /dashboardMeta = createDashboardMeta\(data\)/);
  });

  it('does not rerender dashboard with only builtAt after refreshes', () => {
    assert.match(dashboard, /function renderDashboard\(builtAt = dashboardMeta\.builtAt, lastScanAt = dashboardMeta\.lastScanAt\)/);
    assert.doesNotMatch(dashboard, /renderDashboard\(data\.builtAt\)/);
  });
});
