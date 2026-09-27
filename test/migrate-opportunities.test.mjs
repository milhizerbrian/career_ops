import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { migrateJob, migrateTracker } from '../scripts/migrate-opportunities.mjs';
import { CANONICAL_STATUSES } from '../lib/status-utils.mjs';
import { isValidStage } from '../lib/opportunity-stages.mjs';

const baseJob = (overrides = {}) => ({
  company: 'Example',
  title: 'CSM',
  status: 'lead',
  notes: '',
  date_found: '2026-01-01T00:00:00.000Z',
  date_updated: '2026-01-02T00:00:00.000Z',
  ...overrides,
});

describe('migrateJob', () => {
  it('adds a stage derived from status when none exists', () => {
    const { job, changed } = migrateJob(baseJob({ status: 'applied' }), 'x');
    assert.equal(job.stage, 'applied');
    assert.equal(changed, true);
  });

  it('adds a discovered activity event using the existing date_found, not "now"', () => {
    const now = new Date('2026-09-24T00:00:00.000Z');
    const { job } = migrateJob(baseJob({ date_found: '2026-01-01T00:00:00.000Z' }), 'x', now);
    const discovered = job.workflowTimeline.find(e => e.type === 'discovered');
    assert.ok(discovered);
    assert.equal(discovered.at, '2026-01-01T00:00:00.000Z');
  });

  it('does not duplicate a discovered event that already exists', () => {
    const jobWithHistory = baseJob({
      workflowTimeline: [{ type: 'discovered', at: '2026-01-01T00:00:00.000Z', source: 'tracker', label: '', note: '' }],
    });
    const { job, changed } = migrateJob(jobWithHistory, 'x');
    const discoveredEvents = job.workflowTimeline.filter(e => e.type === 'discovered');
    assert.equal(discoveredEvents.length, 1);
    // stage still gets added, so changed is true even though the timeline itself wasn't touched
    assert.equal(changed, true);
  });

  it('is a true no-op (changed:false) on a job that already has stage + discovered event', () => {
    const already = baseJob({
      stage: 'applied',
      workflowTimeline: [{ type: 'discovered', at: '2026-01-01T00:00:00.000Z', source: 'tracker', label: '', note: '' }],
    });
    const { job, changed } = migrateJob(already, 'x');
    assert.equal(changed, false);
    assert.equal(job.stage, 'applied');
  });

  it('preserves every existing field untouched', () => {
    const job = baseJob({ score: 88, score_analysis: 'Strong fit', url: 'https://example.com/job' });
    const { job: migrated } = migrateJob(job, 'x');
    assert.equal(migrated.score, 88);
    assert.equal(migrated.score_analysis, 'Strong fit');
    assert.equal(migrated.url, 'https://example.com/job');
    assert.equal(migrated.company, 'Example');
  });

  it('never invents a discovered timestamp when date_found is missing — falls back to migration time and says so', () => {
    const now = new Date('2026-09-24T00:00:00.000Z');
    const jobNoDate = baseJob({});
    delete jobNoDate.date_found;
    const { job, notes } = migrateJob(jobNoDate, 'x', now);
    const discovered = job.workflowTimeline.find(e => e.type === 'discovered');
    assert.equal(discovered.at, now.toISOString());
    assert.match(discovered.label, /unknown/);
  });

  it('replaces an invalid pre-existing stage value and notes the correction', () => {
    const job = baseJob({ stage: 'not-a-real-stage', status: 'applied' });
    const { job: migrated, notes } = migrateJob(job, 'weird-job');
    assert.equal(migrated.stage, 'applied');
    assert.ok(notes.some(n => n.includes('weird-job') && n.includes('not-a-real-stage')));
  });
});

describe('migrateTracker (full-tracker pass + report)', () => {
  it('migrates every job and reports counts', () => {
    const tracker = {
      a: baseJob({ status: 'lead' }),
      b: baseJob({ status: 'applied' }),
      c: baseJob({ stage: 'offer', status: 'offer', workflowTimeline: [{ type: 'discovered', at: '2026-01-01T00:00:00.000Z', source: 'x', label: '', note: '' }] }),
    };
    const { tracker: migrated, report } = migrateTracker(tracker);
    assert.equal(report.totalJobs, 3);
    assert.equal(report.migrated, 2);
    assert.equal(report.alreadyMigrated, 1);
    assert.ok(isValidStage(migrated.a.stage));
    assert.ok(isValidStage(migrated.b.stage));
    assert.equal(migrated.c.stage, 'offer');
  });

  it('every canonical legacy status maps to a valid stage during a full-tracker migration', () => {
    const tracker = {};
    CANONICAL_STATUSES.forEach((status, i) => { tracker[`job-${i}`] = baseJob({ status }); });
    const { tracker: migrated } = migrateTracker(tracker);
    for (const job of Object.values(migrated)) {
      assert.ok(isValidStage(job.stage));
    }
  });

  it('is idempotent — running twice produces the same result and reports nothing left to migrate', () => {
    const tracker = { a: baseJob({ status: 'lead' }), b: baseJob({ status: 'onsite' }) };
    const first = migrateTracker(tracker);
    const second = migrateTracker(first.tracker);
    assert.equal(second.report.migrated, 0);
    assert.equal(second.report.alreadyMigrated, 2);
    assert.deepEqual(second.tracker, first.tracker);
  });

  it('tolerates a job with missing optional fields (no score, no url, no workflowTimeline)', () => {
    const tracker = { bare: { company: 'X', title: 'Y', status: 'lead', notes: '' } };
    const { tracker: migrated } = migrateTracker(tracker);
    assert.ok(isValidStage(migrated.bare.stage));
    assert.ok(Array.isArray(migrated.bare.workflowTimeline));
  });
});
