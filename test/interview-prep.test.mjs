import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { buildInterviewPrep } from '../lib/interview-prep.mjs';

const NOW = new Date('2026-09-27T12:00:00.000Z');

const FACTS = [
  { id: 'achievement-001', fact: 'Managed and developed a team of 4 CSMs', employer: 'Acme', category: 'achievement', verified: true, allowed_in_resume: true },
  { id: 'skill-001', fact: 'Led QBRs with CISO stakeholders', employer: 'Beta', category: 'skill', verified: true, allowed_in_resume: true },
];

const STORIES = [
  { id: 'story-001', category: 'story', verified: true, employer: 'Acme', situation: 'Team missing targets', task: 'Rebuild the CSM team', action: 'Managed and developed a team of CSMs with weekly coaching', result: 'Team hit plan' },
  { id: 'story-002', category: 'story', verified: false, employer: 'Acme', situation: 'Unverified people management story', task: 'x', action: 'Managed a team', result: 'y' },
];

function fit(overrides = {}) {
  return {
    available: true,
    overallScore: 72,
    pursuitClassification: 'Strong',
    hardBlockers: [{ description: 'Requires on-site in NYC' }],
    classifications: [
      { label: 'people management', categories: ['required'], tier: 'partial_match', evidenceIds: ['achievement-001'], reason: '1 verified fact partially supports this.' },
      { label: 'executive stakeholder management', categories: ['required'], tier: 'strong_match', evidenceIds: ['skill-001', 'achievement-404'], reason: '2 verified facts support this.' },
      { label: 'RFP/RFI response', categories: ['preferred'], tier: 'unknown', evidenceIds: [], reason: 'No verified evidence found.' },
      { label: 'SIEM', categories: ['skills'], tier: 'gap', evidenceIds: [], reason: 'Confirmed gap.' },
    ],
    openQuestions: [{ id: 'q-001', requirementLabel: 'RFP/RFI response', question: 'Have you written RFP responses?' }],
    ...overrides,
  };
}

function input(overrides = {}) {
  return {
    opp: { id: 'opp-1', company: 'Gamma', title: 'Strategic CSM', stage: 'interview', location: 'Remote', compensation: '$180K', generatedDocs: {} },
    stageLabel: 'Interview',
    fit: fit(),
    parsedJd: {
      responsibilities: [{ text: 'Own renewals for enterprise accounts.' }, { text: 'Run QBRs.' }],
      seniority: 'senior',
      domain: ['cybersecurity'],
    },
    rounds: [
      { id: 'r-old', roundType: 'recruiter', status: 'completed', scheduledAt: '2026-09-20T15:00:00.000Z', contactIds: ['c1'] },
      { id: 'r-next', roundType: 'hiring_manager', status: 'scheduled', scheduledAt: '2026-10-01T15:00:00.000Z', contactIds: [] },
    ],
    facts: FACTS,
    stories: STORIES,
    baseQuestionsToAsk: ['What would make the first 90 days successful?'],
    resumeVersionCount: 0,
    now: NOW,
    ...overrides,
  };
}

describe('buildInterviewPrep', () => {
  it('targets the next upcoming scheduled round', () => {
    const prep = buildInterviewPrep(input());
    assert.equal(prep.nextRound.id, 'r-next');
    assert.equal(prep.roundType, 'hiring_manager');
    assert.equal(prep.roundTypeLabel, 'Hiring Manager');
  });

  it('builds a briefing from stored job data and fit only', () => {
    const { briefing } = buildInterviewPrep(input());
    assert.equal(briefing.company, 'Gamma');
    assert.equal(briefing.title, 'Strategic CSM');
    assert.equal(briefing.stageLabel, 'Interview');
    assert.deepEqual(briefing.responsibilities, ['Own renewals for enterprise accounts.', 'Run QBRs.']);
    assert.deepEqual(briefing.domains, ['cybersecurity']);
    assert.equal(briefing.fit.overallScore, 72);
    assert.deepEqual(briefing.hardBlockers, ['Requires on-site in NYC']);
  });

  it('recommends only verified facts and verified stories, and never invents missing evidence', () => {
    const { evidence } = buildInterviewPrep(input());
    const people = evidence.find(e => e.requirement === 'people management');
    assert.deepEqual(people.facts.map(f => f.id), ['achievement-001']);
    assert.deepEqual(people.stories.map(s => s.id), ['story-001']);

    const exec = evidence.find(e => e.requirement === 'executive stakeholder management');
    assert.deepEqual(exec.facts.map(f => f.id), ['skill-001'], 'unknown fact ids are dropped, not fabricated');

    const allText = JSON.stringify(evidence);
    assert.doesNotMatch(allText, /Unverified people management story/);
    assert.ok(!evidence.some(e => e.requirement === 'RFP/RFI response'), 'no evidence entries for unsupported requirements');
  });

  it('says so when a matched requirement has no verified stories', () => {
    const { evidence } = buildInterviewPrep(input({ stories: [] }));
    const people = evidence.find(e => e.requirement === 'people management');
    assert.deepEqual(people.stories, []);
    assert.match(people.storyNote, /No verified STAR story/);
  });

  it('lists gaps/unknowns with reasons and linked open questions', () => {
    const { gaps } = buildInterviewPrep(input());
    assert.deepEqual(gaps.map(g => g.requirement), ['RFP/RFI response', 'SIEM']);
    assert.equal(gaps[0].openQuestionId, 'q-001');
    assert.equal(gaps[1].openQuestionId, null);
    assert.match(gaps[1].reason, /gap/i);
  });

  it('generates likely questions from requirements and round type without candidate claims', () => {
    const { likelyQuestions } = buildInterviewPrep(input());
    const texts = likelyQuestions.map(q => q.question);
    assert.ok(texts.some(t => /people management/.test(t)));
    assert.ok(texts.some(t => /RFP\/RFI response/.test(t)));
    assert.ok(likelyQuestions.some(q => q.basis === 'round'));
    assert.ok(likelyQuestions.every(q => !/\d+%|\$\d/.test(q.question)), 'questions contain no metrics');
    assert.ok(new Set(texts).size === texts.length, 'no duplicates');
  });

  it('falls back to general questions when no round is scheduled', () => {
    const prep = buildInterviewPrep(input({ rounds: [] }));
    assert.equal(prep.nextRound, null);
    assert.equal(prep.roundType, null);
    assert.ok(prep.likelyQuestions.some(q => q.basis === 'round'));
  });

  it('merges base questions to ask with round-specific ones, deduped', () => {
    const { questionsToAsk } = buildInterviewPrep(input({ baseQuestionsToAsk: ['What would make the first 90 days successful?', 'What would make the first 90 days successful?'] }));
    assert.equal(questionsToAsk.filter(q => q === 'What would make the first 90 days successful?').length, 1);
    assert.ok(questionsToAsk.length >= 2);
  });

  it('computes the checklist from real state', () => {
    const byId = Object.fromEntries(buildInterviewPrep(input()).checklist.map(c => [c.id, c]));
    assert.equal(byId.jd.done, true);
    assert.equal(byId.resume.done, false);
    assert.equal(byId.round_scheduled.done, true);
    assert.equal(byId.interviewers.done, false);
    assert.equal(byId.open_questions.done, false);
    assert.equal(byId.stories.done, true);

    const bare = Object.fromEntries(buildInterviewPrep(input({ rounds: [], stories: [], resumeVersionCount: 1, fit: fit({ openQuestions: [] }) })).checklist.map(c => [c.id, c]));
    assert.equal(bare.resume.done, true);
    assert.equal(bare.round_scheduled.done, false);
    assert.equal(bare.open_questions.done, true);
    assert.equal(bare.stories.done, false);
  });

  it('degrades gracefully when fit analysis is unavailable', () => {
    const prep = buildInterviewPrep(input({ fit: { available: false, reason: 'No usable JD' }, parsedJd: null }));
    assert.deepEqual(prep.evidence, []);
    assert.deepEqual(prep.gaps, []);
    assert.equal(prep.briefing.fit, null);
    assert.equal(prep.briefing.jdReason, 'No usable JD');
    assert.ok(prep.likelyQuestions.length > 0);
    assert.equal(prep.checklist.find(c => c.id === 'jd').done, false);
  });
});
