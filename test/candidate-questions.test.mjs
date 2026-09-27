import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

function withIsolatedQuestions(fn) {
  return async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'candidate-questions-'));
    const prevEnv = process.env.CAREER_OPS_DATA_DIR;
    process.env.CAREER_OPS_DATA_DIR = dir;
    try {
      const mod = await import(`../lib/candidate-questions.mjs?t=${Date.now()}-${Math.random()}`);
      await fn(mod);
    } finally {
      if (prevEnv === undefined) delete process.env.CAREER_OPS_DATA_DIR;
      else process.env.CAREER_OPS_DATA_DIR = prevEnv;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

describe('candidate-questions store', () => {
  it('starts empty when no questions.json exists yet', withIsolatedQuestions(async (mod) => {
    assert.deepEqual(mod.loadQuestions(), []);
  }));

  it('ensureQuestion creates a new open question with specifics-seeking phrasing (never yes/no)', withIsolatedQuestions(async (mod) => {
    const q = mod.ensureQuestion('RFP/RFI response', 'job-1');
    assert.equal(q.status, 'open');
    assert.match(q.question, /which employer/i);
    assert.match(q.question, /measurable result/i);
    assert.match(q.question, /what did you specifically do/i);
    assert.deepEqual(q.jobIds, ['job-1']);
  }));

  it('does not create a duplicate question for the same requirement label', withIsolatedQuestions(async (mod) => {
    mod.ensureQuestion('RFP/RFI response', 'job-1');
    mod.ensureQuestion('RFP/RFI response', 'job-2');
    const all = mod.loadQuestions();
    assert.equal(all.length, 1);
    assert.deepEqual(all[0].jobIds.sort(), ['job-1', 'job-2']);
  }));

  it('answering a question removes it from the open list and it is never re-asked', withIsolatedQuestions(async (mod) => {
    const q = mod.ensureQuestion('RFP/RFI response', 'job-1');
    mod.answerQuestion(q.id, 'Yes, at Proofpoint I led RFP responses for 3 enterprise deals.');

    assert.equal(mod.getOpenQuestions().length, 0);
    assert.equal(mod.getAnsweredQuestions().length, 1);
    assert.equal(mod.getAnsweredQuestions()[0].answer, 'Yes, at Proofpoint I led RFP responses for 3 enterprise deals.');

    // Re-triggering generation for the same requirement must not re-open it.
    const stillOpen = mod.generateQuestionsForUnknowns([{ tier: 'unknown', label: 'RFP/RFI response' }], 'job-2');
    assert.equal(stillOpen.length, 0);
  }));

  it('throws a clear error when answering a question id that does not exist', withIsolatedQuestions(async (mod) => {
    assert.throws(() => mod.answerQuestion('question-does-not-exist', 'answer'), /not found/i);
  }));

  it('generateQuestionsForUnknowns only generates for Unknown-tier classifications', withIsolatedQuestions(async (mod) => {
    const classifications = [
      { tier: 'unknown', label: 'RFP/RFI response' },
      { tier: 'strong_match', label: 'people management' },
      { tier: 'gap', label: 'OWASP/MITRE familiarity' },
    ];
    const open = mod.generateQuestionsForUnknowns(classifications, 'job-1');
    assert.equal(open.length, 1);
    assert.equal(open[0].requirementLabel, 'RFP/RFI response');
  }));

  it('a newly created question starts with promotedFactId: null (Phase 5)', withIsolatedQuestions(async (mod) => {
    const q = mod.ensureQuestion('RFP/RFI response', 'job-1');
    assert.equal(q.promotedFactId, null);
  }));

  it('markQuestionPromoted records which evidence fact an answer became (Phase 5)', withIsolatedQuestions(async (mod) => {
    const q = mod.ensureQuestion('RFP/RFI response', 'job-1');
    mod.answerQuestion(q.id, 'Yes, at Proofpoint I led RFP responses.');
    const updated = mod.markQuestionPromoted(q.id, 'skill-042');
    assert.equal(updated.promotedFactId, 'skill-042');
    assert.equal(mod.loadQuestions().find(x => x.id === q.id).promotedFactId, 'skill-042');
  }));

  it('markQuestionPromoted throws a clear error for an unknown question id', withIsolatedQuestions(async (mod) => {
    assert.throws(() => mod.markQuestionPromoted('does-not-exist', 'skill-001'), /not found/i);
  }));
});
