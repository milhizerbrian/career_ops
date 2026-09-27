import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as store from '../lib/opportunity-store.mjs';

// opportunity-store.mjs resolves its tracker path lazily (per call) from
// CAREER_OPS_TRACKER_PATH, so an isolated tracker file just needs the env
// var set for the duration of the test — no module cache-busting required.
function withIsolatedTracker(initialTracker, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opportunity-store-'));
  const trackerPath = path.join(dir, 'tracker.json');
  fs.writeFileSync(trackerPath, JSON.stringify(initialTracker, null, 2) + '\n', 'utf8');
  const prevPath = process.env.CAREER_OPS_TRACKER_PATH;
  process.env.CAREER_OPS_TRACKER_PATH = trackerPath;
  try {
    return fn(store, trackerPath);
  } finally {
    if (prevPath === undefined) delete process.env.CAREER_OPS_TRACKER_PATH;
    else process.env.CAREER_OPS_TRACKER_PATH = prevPath;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const baseJob = (overrides = {}) => ({
  company: 'Example Co',
  title: 'Customer Success Manager',
  status: 'lead',
  notes: '',
  ...overrides,
});

describe('listOpportunities / getOpportunity', () => {
  it('decorates every job with a derived stage when none is stored', () => withIsolatedTracker({
    a: baseJob({ status: 'lead' }),
    b: baseJob({ status: 'applied' }),
  }, (mod) => {
    const list = mod.listOpportunities();
    assert.equal(list.length, 2);
    const a = list.find(o => o.id === 'a');
    const b = list.find(o => o.id === 'b');
    assert.equal(a.stage, 'discovered');
    assert.equal(b.stage, 'applied');
  }));

  it('getOpportunity throws a recognizable error for an unknown id', () => withIsolatedTracker({}, (mod) => {
    assert.throws(() => mod.getOpportunity('missing'), /Opportunity not found/);
  }));

  it('preserves every existing field unchanged in the decorated view', () => withIsolatedTracker({
    a: baseJob({ score: 72, score_analysis: 'Good fit', date_found: '2026-01-01T00:00:00.000Z' }),
  }, (mod) => {
    const opp = mod.getOpportunity('a');
    assert.equal(opp.score, 72);
    assert.equal(opp.score_analysis, 'Good fit');
    assert.equal(opp.discoveredDate, '2026-01-01T00:00:00.000Z');
    assert.equal(opp.overallFit, 72);
  }));

  it('never invents overallFit when no score exists', () => withIsolatedTracker({
    a: baseJob({}),
  }, (mod) => {
    assert.equal(mod.getOpportunity('a').overallFit, null);
  }));
});

describe('createOpportunity', () => {
  it('defaults to the discovered stage and records a discovered activity event', () => withIsolatedTracker({}, (mod) => {
    const opp = mod.createOpportunity('new-1', { company: 'NewCo', title: 'CSM' });
    assert.equal(opp.stage, 'discovered');
    assert.equal(opp.status, 'lead');
    const activity = mod.getActivity('new-1');
    assert.ok(activity.some(e => e.type === 'discovered'));
  }));

  it('does not invent optional fields that were not provided', () => withIsolatedTracker({}, (mod) => {
    const opp = mod.createOpportunity('new-2', { company: 'NewCo', title: 'CSM' });
    assert.equal(opp.overallFit, null);
    assert.equal(opp.salary ?? null, null);
  }));

  it('rejects an unsupported stage rather than silently falling back', () => withIsolatedTracker({}, (mod) => {
    assert.throws(() => mod.createOpportunity('bad', { stage: 'not-a-stage' }), /Unsupported stage/);
  }));

  it('throws when creating a duplicate id (never overwrites)', () => withIsolatedTracker({
    dup: baseJob({}),
  }, (mod) => {
    assert.throws(() => mod.createOpportunity('dup', { company: 'X', title: 'Y' }));
  }));
});

describe('updateOpportunity', () => {
  it('updates an allowed field without touching others', () => withIsolatedTracker({
    a: baseJob({ notes: 'old' }),
  }, (mod) => {
    const opp = mod.updateOpportunity('a', { notes: 'new' });
    assert.equal(opp.notes, 'new');
    assert.equal(opp.company, 'Example Co');
  }));

  it('rejects a direct stage change with a clear message pointing at changeStage()', () => withIsolatedTracker({
    a: baseJob({}),
  }, (mod) => {
    assert.throws(() => mod.updateOpportunity('a', { stage: 'applied' }), /changeStage/);
  }));

  it('rejects unknown fields rather than silently writing them', () => withIsolatedTracker({
    a: baseJob({}),
  }, (mod) => {
    assert.throws(() => mod.updateOpportunity('a', { totallyMadeUp: 1 }), /does not support/);
  }));

  it('rejects an invalid priority value', () => withIsolatedTracker({
    a: baseJob({}),
  }, (mod) => {
    assert.throws(() => mod.updateOpportunity('a', { priority: 'urgent' }), /Unsupported priority/);
  }));

  it('logs a priority_changed activity event only when priority actually changes', () => withIsolatedTracker({
    a: baseJob({ priority: 'low' }),
  }, (mod) => {
    mod.updateOpportunity('a', { priority: 'low' }); // unchanged
    let activity = mod.getActivity('a');
    assert.equal(activity.filter(e => e.type === 'priority_changed').length, 0);

    mod.updateOpportunity('a', { priority: 'high' });
    activity = mod.getActivity('a');
    const changes = activity.filter(e => e.type === 'priority_changed');
    assert.equal(changes.length, 1);
    assert.equal(changes[0].from, 'low');
    assert.equal(changes[0].to, 'high');
  }));
});

describe('changeStage', () => {
  it('updates stage and keeps legacy status in sync', () => withIsolatedTracker({
    a: baseJob({ status: 'lead' }),
  }, (mod) => {
    const opp = mod.changeStage('a', 'applied');
    assert.equal(opp.stage, 'applied');
    assert.equal(opp.status, 'applied');
  }));

  it('records a stage_changed activity event with from/to', () => withIsolatedTracker({
    a: baseJob({ status: 'lead' }),
  }, (mod) => {
    mod.changeStage('a', 'pursuing', { reason: 'Looks strong' });
    const activity = mod.getActivity('a');
    const change = activity.find(e => e.type === 'stage_changed');
    assert.ok(change);
    assert.equal(change.from, 'discovered');
    assert.equal(change.to, 'pursuing');
    assert.equal(change.note, 'Looks strong');
  }));

  it('is a no-op activity-wise when the stage does not actually change', () => withIsolatedTracker({
    a: baseJob({ status: 'lead' }),
  }, (mod) => {
    mod.changeStage('a', 'discovered'); // already discovered via derivation
    const activity = mod.getActivity('a');
    assert.equal(activity.filter(e => e.type === 'stage_changed').length, 0);
  }));

  it('rejects an invalid stage', () => withIsolatedTracker({
    a: baseJob({}),
  }, (mod) => {
    assert.throws(() => mod.changeStage('a', 'not-a-stage'), /Unsupported stage/);
  }));

  it('records an offer_received event when moving to offer', () => withIsolatedTracker({
    a: baseJob({ status: 'onsite', stage: 'final_round' }),
  }, (mod) => {
    mod.changeStage('a', 'offer');
    const activity = mod.getActivity('a');
    assert.ok(activity.some(e => e.type === 'offer_received'));
  }));

  it('throws opportunity-not-found for an invalid id', () => withIsolatedTracker({}, (mod) => {
    assert.throws(() => mod.changeStage('missing', 'applied'));
  }));
});

describe('recordActivity / getActivity', () => {
  it('appends a manual activity event that shows up in getActivity', () => withIsolatedTracker({
    a: baseJob({}),
  }, (mod) => {
    mod.recordActivity('a', { type: 'note_added', note: 'Called recruiter' });
    const activity = mod.getActivity('a');
    assert.ok(activity.some(e => e.type === 'note_added' && e.note === 'Called recruiter'));
  }));

  it('rejects an unsupported activity type', () => withIsolatedTracker({
    a: baseJob({}),
  }, (mod) => {
    assert.throws(() => mod.recordActivity('a', { type: 'not-a-real-event' }));
  }));
});
