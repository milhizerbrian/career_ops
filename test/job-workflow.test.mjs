import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  appendWorkflowEvent,
  applyManualWorkflowEvent,
  buildWorkflowSummary,
  buildWorkflowTimeline,
  detectWorkflowStaleness,
  getNextBestAction,
  validateManualWorkflowEventPayload,
} from '../lib/job-workflow.mjs';

const NOW = new Date('2026-05-09T12:00:00.000Z');

describe('job workflow timeline', () => {
  it('normalizes persisted events and derives existing tracker signals', () => {
    const job = {
      id: 'a',
      company: 'Example',
      status: 'applied',
      score: 4,
      date_updated: '2026-05-01',
      workflowTimeline: [
        { type: 'outreach_sent', at: '2026-05-03T12:00:00.000Z', source: 'manual', label: 'LinkedIn' },
      ],
      generatedDocs: {
        default: { docxUrl: '/output/a.docx', generatedAt: '2026-05-02T12:00:00.000Z' },
      },
    };

    assert.deepEqual(
      buildWorkflowTimeline(job).map(event => event.type),
      ['discovered', 'evaluated', 'applied', 'resume_generated', 'outreach_sent']
    );
  });

  it('appends supported workflow events for persistence', () => {
    const job = { workflowTimeline: [] };
    appendWorkflowEvent(job, { type: 'applied', at: '2026-05-01T00:00:00.000Z', source: 'status' }, NOW);

    assert.deepEqual(job.workflowTimeline, [{
      type: 'applied',
      at: '2026-05-01T00:00:00.000Z',
      source: 'status',
      label: '',
      note: '',
    }]);
  });

  it('validates manual workflow events and note limits', () => {
    assert.deepEqual(validateManualWorkflowEventPayload({
      type: 'outreach_sent',
      note: 'Sent LinkedIn note',
    }), {
      type: 'outreach_sent',
      note: 'Sent LinkedIn note',
      label: '',
    });

    assert.throws(
      () => validateManualWorkflowEventPayload({ type: 'applied' }),
      /Unsupported workflow event type/
    );
    assert.throws(
      () => validateManualWorkflowEventPayload({ type: 'note_added', note: 'x'.repeat(1001) }),
      /1000 characters/
    );
  });

  it('applies manual workflow events and stores add-note text on the job', () => {
    const job = { notes: '2026-05-01: Existing note' };
    applyManualWorkflowEvent(job, { type: 'note_added', note: 'Talk to Alex' }, NOW);

    assert.equal(job.workflowTimeline.at(-1).type, 'note_added');
    assert.equal(job.workflowTimeline.at(-1).note, 'Talk to Alex');
    assert.match(job.notes, /^2026-05-09: Talk to Alex/);
  });
});

describe('job workflow decisions', () => {
  it('chooses next best actions from job state', () => {
    assert.equal(getNextBestAction({ status: 'lead', date_updated: '2026-05-08' }, { now: NOW }), 'generate_resume');
    assert.equal(getNextBestAction({
      status: 'lead',
      date_updated: '2026-05-08',
      generatedDocs: { default: { docxUrl: '/output/a.docx', generatedAt: '2026-05-08T00:00:00.000Z' } },
    }, { now: NOW }), 'apply');
    assert.equal(getNextBestAction({
      status: 'applied',
      date_updated: '2026-05-01',
      generatedDocs: { default: { docxUrl: '/output/a.docx', generatedAt: '2026-05-01T00:00:00.000Z' } },
    }, { now: NOW }), 'follow_up');
    assert.equal(getNextBestAction({ status: 'technical_screen', date_updated: '2026-05-08' }, { now: NOW }), 'prep_interview');
    assert.equal(getNextBestAction({ status: 'rejected', date_updated: '2026-05-08' }, { now: NOW }), 'archive');
  });

  it('detects stale leads and applied follow-ups', () => {
    const staleLead = detectWorkflowStaleness({ status: 'lead', date_updated: '2026-04-20' }, { now: NOW });
    const appliedFollowUp = detectWorkflowStaleness({ status: 'applied', date_updated: '2026-05-01' }, { now: NOW });

    assert.equal(staleLead.staleLead, true);
    assert.equal(appliedFollowUp.needsAppliedFollowUp, true);
  });

  it('does not flag applied follow-up immediately after a manual follow-up', () => {
    const appliedFollowUp = detectWorkflowStaleness({
      status: 'applied',
      date_updated: '2026-05-01',
      workflowTimeline: [{ type: 'follow_up_done', at: '2026-05-09T10:00:00.000Z', source: 'manual' }],
    }, { now: NOW });

    assert.equal(appliedFollowUp.needsAppliedFollowUp, false);
    assert.equal(getNextBestAction({
      status: 'applied',
      date_updated: '2026-05-01',
      generatedDocs: { default: { docxUrl: '/output/a.docx', generatedAt: '2026-05-01T00:00:00.000Z' } },
      workflowTimeline: [{ type: 'follow_up_done', at: '2026-05-09T10:00:00.000Z', source: 'manual' }],
    }, { now: NOW }), 'send_outreach');
  });

  it('builds compact dashboard counts', () => {
    const summary = buildWorkflowSummary([
      { id: 'a', status: 'lead', date_updated: '2026-04-20' },
      { id: 'b', status: 'applied', date_updated: '2026-05-01' },
      { id: 'c', status: 'recruiter_screen', date_updated: '2026-05-08' },
    ], { now: NOW });

    assert.equal(summary.staleJobs, 2);
    assert.equal(summary.urgentFollowUps, 2);
    assert.equal(summary.upcomingInterviews, 1);
  });
});
