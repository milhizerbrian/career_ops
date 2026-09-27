// Phase 9.4 (interviewers as contacts) + 9.5 (thank-you drafts and the
// send_thank_you action).
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { CONTACT_RELATIONSHIP_TYPES, validateContactPayload } from '../lib/job-contacts.mjs';
import { computeContactIntelligence } from '../lib/job-search-scoring.mjs';
import { upsertInterviewRound } from '../lib/interview-rounds.mjs';
import { createOutreachDraft, storeOutreachDraft, validateOutreachDraftPayload, OUTREACH_DRAFT_TYPES } from '../lib/outreach-drafts.mjs';
import { validateTracker } from '../lib/tracker-store.mjs';
import { generateCandidateActions, applyDecisionOverlay, ACTION_TYPES } from '../lib/action-engine.mjs';

const NOW = new Date('2026-09-27T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

const FACTS = [
  { id: 'achievement-001', fact: 'Led renewals for 40 enterprise security accounts with 98% gross retention', verified: true, allowed_in_resume: true },
  { id: 'achievement-002', fact: 'Ran quarterly business reviews with CISO stakeholders', verified: true, allowed_in_resume: true },
  { id: 'achievement-999', fact: 'Unverified claim about renewals: grew revenue 300%', verified: false, allowed_in_resume: false },
];

function jobWithCompletedRound({ completedAt = NOW } = {}) {
  const job = {
    company: 'Acme Security',
    title: 'Senior CSM',
    stage: 'interview',
    status: 'technical_screen',
    contacts: [{ id: 'c-int', name: 'Dana Lee', title: 'VP Customer Success', relationshipType: 'interviewer' }],
  };
  const round = upsertInterviewRound(job, { roundType: 'hiring_manager', contactIds: ['c-int'], notes: 'Talked about renewals and CISO business reviews.' }, new Date(completedAt.getTime() - DAY));
  upsertInterviewRound(job, { id: round.id, status: 'completed' }, completedAt);
  return { job, roundId: round.id };
}

function lmStub(text, calls = []) {
  return async (url, init) => {
    calls.push(JSON.parse(init.body));
    return { ok: true, json: async () => ({ choices: [{ message: { content: text } }] }) };
  };
}

describe('Phase 9.4 interviewers as contacts', () => {
  it('accepts interviewer as a relationship type without changing existing types', () => {
    assert.deepEqual(CONTACT_RELATIONSHIP_TYPES, ['recruiter', 'hiring_manager', 'referral', 'employee', 'interviewer']);
    assert.equal(validateContactPayload({ name: 'Dana', relationshipType: 'interviewer' }).relationshipType, 'interviewer');
  });

  it('scores an interviewer contact without error and leaves existing scoring intact', () => {
    const hm = computeContactIntelligence({ name: 'A', relationshipType: 'hiring_manager', title: 'Director' });
    assert.equal(typeof computeContactIntelligence({ name: 'B', relationshipType: 'interviewer', title: 'Director' }).score, 'number');
    assert.deepEqual(computeContactIntelligence({ name: 'A', relationshipType: 'hiring_manager', title: 'Director' }), hm);
  });

  it('rounds link interviewer contacts by contactIds', () => {
    const { job } = jobWithCompletedRound();
    assert.deepEqual(job.interviews[0].contactIds, ['c-int']);
  });
});

describe('Phase 9.5 thank-you drafts', () => {
  it('records completedAt when a round is completed', () => {
    const { job } = jobWithCompletedRound();
    assert.equal(job.interviews[0].completedAt, NOW.toISOString());
  });

  it('requires a real roundId for thank_you drafts', async () => {
    assert.ok(OUTREACH_DRAFT_TYPES.includes('thank_you'));
    assert.throws(() => validateOutreachDraftPayload({ contactId: 'c-int', type: 'thank_you' }), /roundId is required/);
    const { job } = jobWithCompletedRound();
    await assert.rejects(
      createOutreachDraft(job, { contactId: 'c-int', type: 'thank_you', roundId: 'nope' }, { useLmStudio: false, candidateFacts: FACTS }),
      /Interview round not found/
    );
  });

  it('falls back to a claim-free template when LM Studio is off', async () => {
    const { job, roundId } = jobWithCompletedRound();
    const draft = await createOutreachDraft(job, { contactId: 'c-int', type: 'thank_you', roundId }, { useLmStudio: false, candidateFacts: FACTS, now: NOW });
    assert.equal(draft.type, 'thank_you');
    assert.equal(draft.roundId, roundId);
    assert.equal(draft.source, 'fallback');
    assert.match(draft.text, /Dana/);
    assert.match(draft.text, /Acme Security/);
    assert.doesNotMatch(draft.text, /\d+%|\$\d/);
  });

  it('sends LM Studio only round notes and verified facts, never the brag doc or unverified facts', async () => {
    const { job, roundId } = jobWithCompletedRound();
    const calls = [];
    const draft = await createOutreachDraft(job, { contactId: 'c-int', type: 'thank_you', roundId }, {
      candidateFacts: FACTS,
      bragDoc: 'BRAG DOC SHOULD NOT APPEAR',
      fetchImpl: lmStub('Hi Dana, thank you for the conversation about renewals and CISO business reviews.', calls),
      now: NOW,
    });
    const prompt = calls[0].messages[0].content;
    assert.match(prompt, /Talked about renewals and CISO business reviews\./);
    assert.match(prompt, /Ran quarterly business reviews with CISO stakeholders/);
    assert.doesNotMatch(prompt, /BRAG DOC SHOULD NOT APPEAR/);
    assert.doesNotMatch(prompt, /Unverified claim/);
    assert.equal(draft.source, 'lm_studio');
    assert.deepEqual(draft.unsupportedClaims, []);
  });

  it('keeps LM output whose numeric claims are backed by verified facts', async () => {
    const { job, roundId } = jobWithCompletedRound();
    const draft = await createOutreachDraft(job, { contactId: 'c-int', type: 'thank_you', roundId }, {
      candidateFacts: FACTS,
      fetchImpl: lmStub('Thanks Dana. Holding 98% gross retention on renewals is the work I enjoy most.'),
      now: NOW,
    });
    assert.equal(draft.source, 'lm_studio');
    assert.match(draft.text, /98%/);
  });

  it('rejects LM output with unsupported claims and falls back', async () => {
    const { job, roundId } = jobWithCompletedRound();
    const draft = await createOutreachDraft(job, { contactId: 'c-int', type: 'thank_you', roundId }, {
      candidateFacts: FACTS,
      fetchImpl: lmStub('Thanks Dana. I grew revenue 300% and saved $5M last year.'),
      now: NOW,
    });
    assert.equal(draft.source, 'fallback');
    assert.doesNotMatch(draft.text, /300%|\$5M/);
    assert.deepEqual(draft.unsupportedClaims.sort(), ['$5M', '300%'].sort());
  });

  it('stores thank_you drafts that survive tracker validation', async () => {
    const { job, roundId } = jobWithCompletedRound();
    const draft = await createOutreachDraft(job, { contactId: 'c-int', type: 'thank_you', roundId }, { useLmStudio: false, candidateFacts: FACTS, now: NOW });
    storeOutreachDraft(job, draft);
    const tracker = validateTracker({ 'job-1': job });
    const stored = tracker['job-1'].contacts[0].outreachDrafts[0];
    assert.equal(stored.type, 'thank_you');
  });
});

describe('Phase 9.5 send_thank_you action', () => {
  function opp(job) {
    return { id: 'job-1', lastActivity: NOW.toISOString(), date_updated: NOW.toISOString(), workflowTimeline: [], ...job };
  }

  it('is generated per recently completed round with no follow-up yet', () => {
    assert.ok(ACTION_TYPES.includes('send_thank_you'));
    const { job, roundId } = jobWithCompletedRound();
    const actions = generateCandidateActions(opp(job), { now: new Date(NOW.getTime() + DAY) });
    const action = actions.find(a => a.type === 'send_thank_you');
    assert.ok(action);
    assert.equal(action.id, `job-1:send_thank_you:${roundId}`);
    assert.match(action.title, /thank-you/i);
  });

  it('clears once a follow_up_done event is recorded after the round completed', () => {
    const { job } = jobWithCompletedRound();
    job.workflowTimeline.push({ type: 'follow_up_done', at: new Date(NOW.getTime() + 60_000).toISOString(), source: 'manual', label: 'Thank-you sent', note: '' });
    const actions = generateCandidateActions(opp(job), { now: new Date(NOW.getTime() + DAY) });
    assert.ok(!actions.some(a => a.type === 'send_thank_you'));
  });

  it('does not count a follow-up from before the round completed', () => {
    const { job } = jobWithCompletedRound();
    job.workflowTimeline.push({ type: 'follow_up_done', at: new Date(NOW.getTime() - 5 * DAY).toISOString(), source: 'manual', label: '', note: '' });
    const actions = generateCandidateActions(opp(job), { now: new Date(NOW.getTime() + DAY) });
    assert.ok(actions.some(a => a.type === 'send_thank_you'));
  });

  it('stops nagging after 7 days and ignores scheduled/cancelled rounds', () => {
    const { job } = jobWithCompletedRound();
    assert.ok(!generateCandidateActions(opp(job), { now: new Date(NOW.getTime() + 8 * DAY) }).some(a => a.type === 'send_thank_you'));
    const fresh = { company: 'X', stage: 'interview', status: 'technical_screen', contacts: [] };
    upsertInterviewRound(fresh, { roundType: 'panel' }, NOW);
    assert.ok(!generateCandidateActions(opp(fresh), { now: NOW }).some(a => a.type === 'send_thank_you'));
  });

  it('a completed decision for one round does not hide a later round', () => {
    const { job, roundId } = jobWithCompletedRound();
    const later = new Date(NOW.getTime() + 2 * DAY);
    const r2 = upsertInterviewRound(job, { roundType: 'panel' }, later);
    upsertInterviewRound(job, { id: r2.id, status: 'completed' }, later);
    const candidates = generateCandidateActions(opp(job), { now: new Date(later.getTime() + 60_000) });
    const state = { [`job-1:send_thank_you:${roundId}`]: { status: 'Completed', decidedAt: later.toISOString() } };
    const overlaid = applyDecisionOverlay(candidates, state, { now: later }).filter(a => a.type === 'send_thank_you');
    assert.equal(overlaid.find(a => a.id.endsWith(r2.id)).status, 'Pending');
    assert.equal(overlaid.find(a => a.id.endsWith(roundId)).status, 'Completed');
  });
});
