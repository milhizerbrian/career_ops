import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => fs.readFileSync(path.resolve(APP_ROOT, file), 'utf8');

describe('rejected roles view', () => {
  it('adds a dedicated rejected roles page to the dashboard shell', () => {
    const html = read('public/index.html');

    assert.match(html, /data-view="rejected"/);
    assert.match(html, /id="view-rejected"/);
    assert.match(html, /id="rej-tbody"/);
    assert.match(html, /Rejected Roles/);
  });

  it('keeps rejected roles out of the main dashboard opportunity list', () => {
    const dashboard = read('public/js/dashboard.js');

    assert.match(dashboard, /function isRejectedJob\(job\)/);
    assert.match(dashboard, /function visibleDashboardJobs\(jobs\)/);
    assert.match(dashboard, /const dashboardJobs = visibleDashboardJobs\(allJobs\)/);
    assert.match(dashboard, /let list = allJobs\.filter\(isRejectedJob\)/);
  });

  it('includes rejected rows in generation progress handling', () => {
    const dashboard = read('public/js/dashboard.js');

    assert.match(dashboard, /showProgSection\('rej-prog-' \+ jobId\)/);
    assert.match(dashboard, /rej-gen-btn/);
    assert.match(dashboard, /\['opp-prog-', 'int-prog-', 'rej-prog-'\]/);
  });
});
