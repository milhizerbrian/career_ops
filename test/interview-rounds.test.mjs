import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  INTERVIEW_ROUND_TYPES,
  INTERVIEW_ROUND_STATUSES,
  normalizeInterviewRounds,
  upsertInterviewRound,
} from '../lib/interview-rounds.mjs';

const NOW = new Date('2026-09-27T12:00:00.000Z');

function job(extra = {}) {
  return {
    company: 'Acme',
    title: 'CSM',
    status: 'recruiter_screen',
    stage: 'recruiter_screen',
    contacts: [{ id: 'c1', name: 'Pat Recruiter', relationshipType: 'recruiter' }],
    ...extra,
  };
}

describe('interview rounds', () => {
  it('exposes the supported round types and statuses', () => {
    assert.deepEqual(INTERVIEW_ROUND_TYPES, ['recruiter', 'hiring_manager', 'technical', 'panel', 'executive', 'final', 'other']);
    assert.deepEqual(INTERVIEW_ROUND_STATUSES, ['scheduled', 'completed', 'cancelled']);
  });

  it('creates a round, records interview_scheduled, and never changes stage/status', () => {
    const j = job();
    const round = upsertInterviewRound(j, {
      roundType: 'hiring_manager',
      scheduledAt: '2026-10-01T15:00:00-05:00',
      format: 'video',
      location: 'https://zoom.example/abc',
      contactIds: ['c1'],
    }, NOW);

    assert.match(round.id, /^round-/);
    assert.equal(round.status, 'scheduled');
    assert.equal(round.scheduledAt, '2026-10-01T20:00:00.000Z');
    assert.equal(round.createdAt, NOW.toISOString());
    assert.equal(j.interviews.length, 1);
    assert.equal(j.stage, 'recruiter_screen');
    assert.equal(j.status, 'recruiter_screen');
    const events = j.workflowTimeline.filter(e => e.type === 'interview_scheduled');
    assert.equal(events.length, 1);
    assert.match(events[0].label, /Hiring Manager/);
  });

  it('partially updates an existing round and records interview_completed once', () => {
    const j = job();
    const created = upsertInterviewRound(j, { roundType: 'recruiter' }, NOW);
    const later = new Date('2026-09-28T12:00:00.000Z');
    const updated = upsertInterviewRound(j, { id: created.id, status: 'completed', notes: 'Went well.' }, later);

    assert.equal(updated.roundType, 'recruiter');
    assert.equal(updated.status, 'completed');
    assert.equal(updated.notes, 'Went well.');
    assert.equal(updated.createdAt, NOW.toISOString());
    assert.equal(updated.updatedAt, later.toISOString());
    assert.equal(j.interviews.length, 1);

    upsertInterviewRound(j, { id: created.id, status: 'completed', outcome: 'Advanced' }, later);
    assert.equal(j.workflowTimeline.filter(e => e.type === 'interview_completed').length, 1);
    assert.equal(j.workflowTimeline.filter(e => e.type === 'interview_scheduled').length, 1);
  });

  it('rejects invalid input', () => {
    assert.throws(() => upsertInterviewRound(job(), {}, NOW), /roundType/);
    assert.throws(() => upsertInterviewRound(job(), { roundType: 'coffee' }, NOW), /roundType/);
    assert.throws(() => upsertInterviewRound(job(), { roundType: 'panel', status: 'maybe' }, NOW), /status/);
    assert.throws(() => upsertInterviewRound(job(), { roundType: 'panel', scheduledAt: 'next tuesday' }, NOW), /scheduledAt/);
    assert.throws(() => upsertInterviewRound(job(), { roundType: 'panel', format: 'carrier pigeon' }, NOW), /format/);
    assert.throws(() => upsertInterviewRound(job(), { roundType: 'panel', contactIds: ['nobody'] }, NOW), /contact/i);
    assert.throws(() => upsertInterviewRound(job(), { roundType: 'panel', notes: 'x'.repeat(5001) }, NOW), /notes/);
    assert.throws(() => upsertInterviewRound(job(), { id: 'round-missing', status: 'completed' }, NOW), /not found/);
  });

  it('normalizes stored rounds defensively and sorts by scheduled time', () => {
    const rounds = normalizeInterviewRounds([
      null,
      { id: 'b', roundType: 'final', status: 'scheduled', scheduledAt: '2026-10-05T00:00:00.000Z' },
      { id: 'a', roundType: 'bogus', status: 'bogus', scheduledAt: '2026-10-01T00:00:00.000Z' },
      { id: 'c', roundType: 'panel' },
    ]);
    assert.deepEqual(rounds.map(r => r.id), ['a', 'b', 'c']);
    assert.equal(rounds[0].roundType, 'other');
    assert.equal(rounds[0].status, 'scheduled');
    assert.deepEqual(rounds[2].contactIds, []);
    assert.deepEqual(normalizeInterviewRounds('nope'), []);
  });
});
