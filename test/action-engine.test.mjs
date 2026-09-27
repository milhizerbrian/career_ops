import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  generateCandidateActions,
  applyDecisionOverlay,
  buildActions,
  buildHomeSummary,
  actionId,
  recordActionDecision,
  loadActionState,
  ACTION_TYPES,
  ACTION_STATUSES,
} from '../lib/action-engine.mjs';

function opp(overrides = {}) {
  return {
    id: 'job-1',
    company: 'Acme',
    title: 'Strategic CSM',
    stage: 'discovered',
    discoveredDate: new Date().toISOString(),
    lastActivity: new Date().toISOString(),
    date_updated: new Date().toISOString(),
    status: 'lead',
    workflowTimeline: [],
    contacts: [],
    score: 4, // legacy 0-5 scale -> 80%
    ...overrides,
  };
}

describe('generateCandidateActions', () => {
  it('generates review_opportunity for a decent-fit discovered job', () => {
    const actions = generateCandidateActions(opp());
    assert.ok(actions.some(a => a.type === 'review_opportunity'));
  });

  it('does not generate review_opportunity for a low-fit discovered job', () => {
    const actions = generateCandidateActions(opp({ score: 1 })); // 20%
    assert.ok(!actions.some(a => a.type === 'review_opportunity'));
  });

  it('does not mistake Phase 1\'s legacy-score fallback on overallFit for a real Phase 2 percent', () => {
    // toOpportunityView() sets overallFit = job.overallFit ?? job.score ?? null,
    // so a job Phase 2 has never scored can still show overallFit = 4 (its
    // 0-5 legacy score, not a 0-100 percent). Without `confidence` alongside
    // it (only ever written by a real Phase 2 run), that must not be read as
    // "4% fit" — it should fall back to the legacy 0-5-scaled percent.
    const actions = generateCandidateActions(opp({ score: 4, overallFit: 4, confidence: undefined }));
    assert.ok(actions.some(a => a.type === 'review_opportunity'));
  });

  it('trusts overallFit as a real 0-100 percent once Phase 2 confidence is present', () => {
    const actions = generateCandidateActions(opp({ score: 1, overallFit: 85, confidence: { level: 'High' } }));
    assert.ok(actions.some(a => a.type === 'review_opportunity'));
  });

  it('does not generate review_opportunity when hard blockers are present, even with a high score', () => {
    const actions = generateCandidateActions(opp({ score: 5, hardBlockers: [{ type: 'compensation_floor' }] }));
    assert.ok(!actions.some(a => a.type === 'review_opportunity'));
  });

  it('generates answer_question for a pursuing job with open Phase 2 questions', () => {
    const ctx = { openQuestionsFor: (id) => (id === 'job-1' ? [{ id: 'q1' }] : []) };
    const actions = generateCandidateActions(opp({ stage: 'pursuing' }), ctx);
    assert.ok(actions.some(a => a.type === 'answer_question'));
  });

  it('generates generate_resume for a pursuing job with no resume yet', () => {
    const actions = generateCandidateActions(opp({ stage: 'pursuing' }), { hasGeneratedResume: () => false });
    assert.ok(actions.some(a => a.type === 'generate_resume'));
  });

  it('generates review_resume once a resume exists but has not been marked reviewed', () => {
    const actions = generateCandidateActions(opp({ stage: 'pursuing' }), { hasGeneratedResume: () => true, isCompleted: () => false });
    assert.ok(actions.some(a => a.type === 'review_resume'));
    assert.ok(!actions.some(a => a.type === 'generate_resume'));
  });

  it('generates apply only once review_resume has been completed', () => {
    const ctxNotReviewed = { hasGeneratedResume: () => true, isCompleted: () => false };
    const ctxReviewed = { hasGeneratedResume: () => true, isCompleted: (id) => id.endsWith(':review_resume') };
    assert.ok(!generateCandidateActions(opp({ stage: 'pursuing' }), ctxNotReviewed).some(a => a.type === 'apply'));
    assert.ok(generateCandidateActions(opp({ stage: 'pursuing' }), ctxReviewed).some(a => a.type === 'apply'));
  });

  it('generates find_contact when pursuing with no contacts on file', () => {
    const actions = generateCandidateActions(opp({ stage: 'pursuing', contacts: [] }));
    assert.ok(actions.some(a => a.type === 'find_contact'));
  });

  it('does not generate find_contact once a contact exists', () => {
    const actions = generateCandidateActions(opp({ stage: 'pursuing', contacts: [{ id: 'c1', name: 'Jane' }] }));
    assert.ok(!actions.some(a => a.type === 'find_contact'));
  });

  it('generates follow_up (via the existing staleness detector) for an applied job with no response', () => {
    const appliedAt = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    const job = opp({ stage: 'applied', status: 'applied', date_updated: appliedAt, workflowTimeline: [{ type: 'applied', at: appliedAt, source: 'test' }] });
    const actions = generateCandidateActions(job);
    const followUp = actions.find(a => a.type === 'follow_up');
    assert.ok(followUp);
    assert.match(followUp.reason, /Applied \d+ days? ago/);
  });

  it('generates prepare_interview for any active interview-stage opportunity', () => {
    for (const stage of ['recruiter_screen', 'interview', 'final_round']) {
      const actions = generateCandidateActions(opp({ stage }));
      assert.ok(actions.some(a => a.type === 'prepare_interview'), `expected prepare_interview for stage ${stage}`);
    }
  });

  it('generates record_outcome for an interview gone quiet for 10+ days', () => {
    const staleAt = new Date(Date.now() - 12 * 24 * 60 * 60 * 1000).toISOString();
    const job = opp({ stage: 'interview', date_updated: staleAt, workflowTimeline: [] });
    const actions = generateCandidateActions(job, { lastActivityAt: () => staleAt });
    assert.ok(actions.some(a => a.type === 'record_outcome'));
  });

  it('generates no actions at all for a terminal-stage opportunity', () => {
    for (const stage of ['rejected', 'withdrawn', 'archived', 'offer']) {
      const actions = generateCandidateActions(opp({ stage, score: 5 }));
      assert.deepEqual(actions, [], `expected no actions for terminal stage ${stage}`);
    }
  });

  it('every action has the full documented shape', () => {
    const [action] = generateCandidateActions(opp());
    for (const key of ['id', 'opportunityId', 'type', 'title', 'reason', 'priority', 'dueDate', 'status', 'createdAt', 'completedAt']) {
      assert.ok(key in action, `missing field: ${key}`);
    }
    assert.ok(ACTION_TYPES.includes(action.type));
    assert.ok(ACTION_STATUSES.includes(action.status));
  });
});

describe('duplicate prevention', () => {
  it('never generates two actions of the same type for the same opportunity', () => {
    const actions = generateCandidateActions(opp({ stage: 'pursuing', contacts: [] }), { hasGeneratedResume: () => false });
    const types = actions.map(a => a.type);
    assert.equal(new Set(types).size, types.length);
  });

  it('re-running buildActions on unchanged state produces the same action ids, not duplicates', () => {
    const one = buildActions([opp()], { state: {}, openQuestions: [] });
    const two = buildActions([opp()], { state: {}, openQuestions: [] });
    assert.deepEqual(one.map(a => a.id), two.map(a => a.id));
  });
});

describe('prioritization', () => {
  it('sorts actions highest-priority first', () => {
    const actions = buildActions([
      opp({ id: 'job-1', stage: 'discovered', score: 4 }),
      opp({ id: 'job-2', stage: 'interview' }),
    ], { state: {}, openQuestions: [] });
    assert.equal(actions[0].type, 'prepare_interview'); // base priority 90 beats review_opportunity's ~45
  });

  it('ranks a fresher, higher-fit review above an older, lower-fit one', () => {
    const fresh = opp({ id: 'job-fresh', score: 5, discoveredDate: new Date().toISOString() });
    const old = opp({ id: 'job-old', score: 3, discoveredDate: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString() });
    const actions = buildActions([fresh, old], { state: {}, openQuestions: [] });
    const freshIdx = actions.findIndex(a => a.opportunityId === 'job-fresh');
    const oldIdx = actions.findIndex(a => a.opportunityId === 'job-old');
    assert.ok(freshIdx < oldIdx);
  });
});

describe('completion / skip / snooze overlay', () => {
  it('a Completed action is reported as Completed, not regenerated as Pending', () => {
    const candidates = generateCandidateActions(opp());
    const id = candidates[0].id;
    const state = { [id]: { status: 'Completed', decidedAt: new Date().toISOString() } };
    const merged = applyDecisionOverlay(candidates, state);
    assert.equal(merged.find(a => a.id === id).status, 'Completed');
  });

  it('a recently Skipped action stays hidden (Skipped) during the cooldown window', () => {
    const candidates = generateCandidateActions(opp());
    const id = candidates[0].id;
    const state = { [id]: { status: 'Skipped', decidedAt: new Date().toISOString() } };
    const merged = applyDecisionOverlay(candidates, state, { skipCooldownDays: 3 });
    assert.equal(merged.find(a => a.id === id).status, 'Skipped');
  });

  it('a Skipped action reappears as Pending once the cooldown window passes', () => {
    const candidates = generateCandidateActions(opp());
    const id = candidates[0].id;
    const longAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    const state = { [id]: { status: 'Skipped', decidedAt: longAgo } };
    const merged = applyDecisionOverlay(candidates, state, { skipCooldownDays: 3 });
    assert.equal(merged.find(a => a.id === id).status, 'Pending');
  });

  it('a Snoozed action stays hidden until snoozeUntil passes, then reopens', () => {
    const candidates = generateCandidateActions(opp());
    const id = candidates[0].id;
    const future = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString();
    const past = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString();
    assert.equal(applyDecisionOverlay(candidates, { [id]: { status: 'Snoozed', snoozeUntil: future } }).find(a => a.id === id).status, 'Snoozed');
    assert.equal(applyDecisionOverlay(candidates, { [id]: { status: 'Snoozed', snoozeUntil: past } }).find(a => a.id === id).status, 'Pending');
  });
});

describe('stage changes generate the correct actions', () => {
  it('moving a job from discovered to pursuing swaps review_opportunity for generate_resume', () => {
    const discovered = generateCandidateActions(opp({ stage: 'discovered' }));
    assert.ok(discovered.some(a => a.type === 'review_opportunity'));
    assert.ok(!discovered.some(a => a.type === 'generate_resume'));

    const pursuing = generateCandidateActions(opp({ stage: 'pursuing' }), { hasGeneratedResume: () => false });
    assert.ok(!pursuing.some(a => a.type === 'review_opportunity'));
    assert.ok(pursuing.some(a => a.type === 'generate_resume'));
  });

  it('moving a job to a terminal stage clears every action for it, completed or not', () => {
    const candidates = generateCandidateActions(opp({ stage: 'pursuing' }), { hasGeneratedResume: () => false });
    const state = { [candidates[0].id]: { status: 'Completed', decidedAt: new Date().toISOString() } };
    const afterRejection = applyDecisionOverlay(generateCandidateActions(opp({ stage: 'rejected' })), state);
    assert.deepEqual(afterRejection, []);
  });
});

describe('stale/completed actions disappearing', () => {
  it('a Completed review_opportunity is gone once the job moves stage (regeneration no longer produces it, decision overlay is irrelevant)', () => {
    const stateAfterReviewing = { [actionId('job-1', 'review_opportunity')]: { status: 'Completed', decidedAt: new Date().toISOString() } };
    const nowPursuing = applyDecisionOverlay(generateCandidateActions(opp({ id: 'job-1', stage: 'pursuing' }), { hasGeneratedResume: () => false }), stateAfterReviewing);
    assert.ok(!nowPursuing.some(a => a.type === 'review_opportunity'));
  });
});

describe('buildHomeSummary', () => {
  it('produces a top priority, next list, follow-ups, opportunity counts, and a pipeline snapshot', () => {
    const opportunities = [
      opp({ id: 'a', stage: 'discovered', score: 5 }),
      opp({ id: 'b', stage: 'discovered', score: 4.5 }),
      opp({ id: 'c', stage: 'qualified' }),
      opp({ id: 'd', stage: 'applied' }),
      opp({ id: 'e', stage: 'interview' }),
      opp({ id: 'f', stage: 'offer' }),
    ];
    const actions = buildActions(opportunities, { state: {}, openQuestions: [] });
    const summary = buildHomeSummary(opportunities, actions);
    assert.ok(summary.topPriority);
    assert.ok(Array.isArray(summary.next));
    assert.ok(Array.isArray(summary.followUps));
    assert.equal(summary.newOpportunities.qualified, 1);
    assert.equal(summary.pipelineSnapshot.applied, 1);
    assert.equal(summary.pipelineSnapshot.interviews, 1);
    assert.equal(summary.pipelineSnapshot.offers, 1);
    assert.equal(summary.caughtUp, false);
  });

  it('reports caughtUp with an empty queue when there are no pending actions', () => {
    const summary = buildHomeSummary([], []);
    assert.equal(summary.caughtUp, true);
    assert.equal(summary.topPriority, null);
    assert.deepEqual(summary.startMyDayQueue, []);
  });

  it('startMyDayQueue orders topPriority first, then the rest, with no duplicates', () => {
    const opportunities = [opp({ id: 'a', stage: 'interview' }), opp({ id: 'b', stage: 'discovered', score: 5 })];
    const actions = buildActions(opportunities, { state: {}, openQuestions: [] });
    const summary = buildHomeSummary(opportunities, actions);
    assert.equal(summary.startMyDayQueue[0].id, summary.topPriority.id);
    const ids = summary.startMyDayQueue.map(a => a.id);
    assert.equal(new Set(ids).size, ids.length);
  });
});

describe('persisted action decisions', () => {
  it('recordActionDecision(complete/skip/snooze/reopen) round-trips through loadActionState', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'actions-state-'));
    const prevEnv = process.env.CAREER_OPS_DATA_DIR;
    process.env.CAREER_OPS_DATA_DIR = dir;
    try {
      const mod = await import(`../lib/action-engine.mjs?t=${Date.now()}-${Math.random()}`);
      assert.deepEqual(mod.loadActionState(), {});
      mod.recordActionDecision('job-1:review_opportunity', 'complete');
      assert.equal(mod.loadActionState()['job-1:review_opportunity'].status, 'Completed');
      mod.recordActionDecision('job-1:review_opportunity', 'reopen');
      assert.equal(mod.loadActionState()['job-1:review_opportunity'], undefined);
    } finally {
      if (prevEnv === undefined) delete process.env.CAREER_OPS_DATA_DIR;
      else process.env.CAREER_OPS_DATA_DIR = prevEnv;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
