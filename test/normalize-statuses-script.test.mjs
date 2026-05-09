import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main, normalizeTrackerStatuses } from '../scripts/normalize-statuses.mjs';

function tempTracker(initialTracker) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'career-ops-status-'));
  const trackerPath = path.join(dir, 'tracker.json');
  fs.writeFileSync(trackerPath, JSON.stringify(initialTracker, null, 2) + '\n', 'utf8');
  return { dir, trackerPath };
}

describe('normalize-statuses script', () => {
  it('reports legacy status changes without mutating input', () => {
    const current = {
      a: { company: 'A', title: 'CSM', status: 'Lead' },
      b: { company: 'B', title: 'TAM', status: 'phone_screen' },
    };
    const { tracker, changes } = normalizeTrackerStatuses(current);

    assert.equal(current.a.status, 'Lead');
    assert.equal(tracker.a.status, 'lead');
    assert.equal(tracker.b.status, 'recruiter_screen');
    assert.deepEqual(changes.map(c => c.id), ['a', 'b']);
  });

  it('dry-run does not write tracker changes', async () => {
    const { trackerPath } = tempTracker({
      a: { company: 'A', title: 'CSM', status: 'Lead' },
    });
    const output = [];
    const result = await main(['--dry-run'], {
      trackerPath,
      stdout: { write: text => output.push(text) },
    });

    assert.equal(result.wrote, false);
    assert.equal(JSON.parse(fs.readFileSync(trackerPath, 'utf8')).a.status, 'Lead');
    assert.match(output.join(''), /Would update 1 tracker status/);
  });

  it('write persists canonical statuses', async () => {
    const { trackerPath } = tempTracker({
      a: { company: 'A', title: 'CSM', status: 'Lead' },
    });
    const result = await main(['--write'], {
      trackerPath,
      stdout: { write: () => {} },
    });

    assert.equal(result.wrote, true);
    assert.equal(JSON.parse(fs.readFileSync(trackerPath, 'utf8')).a.status, 'lead');
  });
});
