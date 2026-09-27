import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  INTERVIEW_ROUND_TYPE_OPTIONS,
  INTERVIEW_ROUND_STATUS_OPTIONS,
  INTERVIEW_ROUND_FORMAT_OPTIONS,
  nextScheduledRound,
  toDatetimeLocalValue,
  fromDatetimeLocalValue,
  buildRoundPayload,
} from '../public/js/interview-ui.js';
import {
  INTERVIEW_ROUND_TYPES,
  INTERVIEW_ROUND_STATUSES,
  INTERVIEW_ROUND_FORMATS,
} from '../lib/interview-rounds.mjs';

const NOW = new Date('2026-09-27T12:00:00.000Z');

describe('interview UI helpers', () => {
  it('mirrors the server-side round enums', () => {
    assert.deepEqual(INTERVIEW_ROUND_TYPE_OPTIONS.map(([v]) => v), INTERVIEW_ROUND_TYPES);
    assert.deepEqual(INTERVIEW_ROUND_STATUS_OPTIONS.map(([v]) => v), INTERVIEW_ROUND_STATUSES);
    assert.deepEqual(INTERVIEW_ROUND_FORMAT_OPTIONS.map(([v]) => v), ['', ...INTERVIEW_ROUND_FORMATS]);
  });

  it('picks the soonest upcoming scheduled round, then an undated scheduled one', () => {
    const rounds = [
      { id: 'past', status: 'scheduled', scheduledAt: '2026-09-01T00:00:00.000Z' },
      { id: 'done', status: 'completed', scheduledAt: '2026-09-30T00:00:00.000Z' },
      { id: 'later', status: 'scheduled', scheduledAt: '2026-10-09T00:00:00.000Z' },
      { id: 'soon', status: 'scheduled', scheduledAt: '2026-10-02T00:00:00.000Z' },
      { id: 'undated', status: 'scheduled', scheduledAt: '' },
    ];
    assert.equal(nextScheduledRound(rounds, NOW).id, 'soon');
    assert.equal(nextScheduledRound(rounds.filter(r => !['soon', 'later'].includes(r.id)), NOW).id, 'undated');
    assert.equal(nextScheduledRound([], NOW), null);
    assert.equal(nextScheduledRound(undefined, NOW), null);
  });

  it('round-trips ISO timestamps through datetime-local values', () => {
    const iso = '2026-10-01T20:30:00.000Z';
    const local = toDatetimeLocalValue(iso);
    assert.match(local, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
    assert.equal(fromDatetimeLocalValue(local), iso);
    assert.equal(toDatetimeLocalValue(''), '');
    assert.equal(toDatetimeLocalValue('garbage'), '');
    assert.equal(fromDatetimeLocalValue(''), '');
  });

  it('builds a trimmed round payload from form values', () => {
    const payload = buildRoundPayload({
      roundType: 'panel',
      status: 'scheduled',
      scheduledAt: '',
      format: 'video',
      location: '  https://meet.example/x  ',
      contactIds: ['c1', 'c1', 'c2'],
      notes: '  prep notes ',
      outcome: '',
    });
    assert.deepEqual(payload, {
      roundType: 'panel',
      status: 'scheduled',
      scheduledAt: '',
      format: 'video',
      location: 'https://meet.example/x',
      contactIds: ['c1', 'c2'],
      notes: 'prep notes',
      outcome: '',
    });
  });
});
