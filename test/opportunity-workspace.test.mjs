import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

// candidate-data.mjs and lib/data.mjs resolve their data/config directories
// from env vars at MODULE LOAD time (documented singleton trap from Phase 0)
// — so these env vars must be set, and the module graph freshly imported via
// a cache-busting query string, before any of this file's assertions run.
// Mirrors test/server-api.test.mjs's isolation pattern.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'career-opp-workspace-'));
const dataDir = path.join(tmp, 'data');
const configDir = path.join(tmp, 'config');
const candidateDir = path.join(dataDir, 'candidate');
fs.mkdirSync(candidateDir, { recursive: true });
fs.mkdirSync(configDir, { recursive: true });

process.env.CAREER_OPS_DATA_DIR = dataDir;
process.env.CAREER_OPS_CONFIG_DIR = configDir;
process.env.CAREER_OPS_TRACKER_PATH = path.join(dataDir, 'tracker.json');

fs.writeFileSync(path.join(dataDir, 'master-brag-document.md'), 'Cybersecurity customer success leader with enterprise stakeholder evidence.\n');
fs.writeFileSync(path.join(configDir, 'profile.yml'), [
  'candidate:',
  '  full_name: Test Candidate',
  'compensation:',
  '  minimum: "$165K"',
  '  location_flexibility: "Dallas-based (DFW) or fully remote"',
  'deal_breakers: []',
  '',
].join('\n'));
fs.writeFileSync(path.join(candidateDir, 'achievements.json'), JSON.stringify([
  { id: 'achievement-003', fact: 'Managed and developed a team of 4 CSMs', category: 'achievement', employer: 'Total Trial Services', verified: true, allowed_in_resume: true },
], null, 2));

fs.writeFileSync(path.join(candidateDir, 'stories.json'), JSON.stringify([
  { id: 'story-001', category: 'story', employer: 'Total Trial Services', verified: true, situation: 'CSM team was new', task: 'Build the team', action: 'Managed and developed a team of CSMs', result: 'Team retained key accounts' },
  { id: 'story-002', category: 'story', employer: 'Total Trial Services', verified: false, situation: 'Unverified draft', task: 'Build the team', action: 'Managed and developed a team of CSMs', result: 'Unconfirmed' },
], null, 2));

// A job description that scores as "usable" (has requirements/responsibilities
// markers) and, against the single fact above, is known (verified against the
// real jd-parser/candidate-fit-analysis output) to produce a mix of tiers:
// "people management" -> partial_match, and several -> unknown (including
// "RFP/RFI response", which has zero alias overlap with our one fact).
const USABLE_JD = [
  'Responsibilities: Manage and develop a team of CSMs across the portfolio.',
  'Own commercial NRR and expansion for enterprise accounts.',
  '',
  'Requirements: 10+ years of experience required.',
  'Prepare RFP responses for enterprise deals. SIEM experience preferred.',
].join('\n');

function writeTracker(jobs) {
  fs.writeFileSync(process.env.CAREER_OPS_TRACKER_PATH, JSON.stringify(jobs, null, 2));
}

let mod;
before(async () => {
  mod = await import(`../lib/opportunity-workspace.mjs?t=${Date.now()}-${Math.random()}`);
});

after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('buildOpportunityWorkspace', () => {
  it('throws OPPORTUNITY_NOT_FOUND for a missing id', () => {
    writeTracker({});
    assert.throws(() => mod.buildOpportunityWorkspace('nope'), (err) => {
      assert.equal(err.code, 'OPPORTUNITY_NOT_FOUND');
      return true;
    });
  });

  it('loads the correct opportunity with stage label, freshness, and activity', () => {
    writeTracker({
      'job-a': { company: 'Acme', title: 'Strategic CSM', status: 'lead', stage: 'discovered', date_found: '2026-09-20', date_updated: '2026-09-20' },
      'job-b': { company: 'Other Co', title: 'CSM', status: 'lead', date_updated: '2026-09-21' },
    });
    const ws = mod.buildOpportunityWorkspace('job-a');
    assert.equal(ws.id, 'job-a');
    assert.equal(ws.company, 'Acme');
    assert.equal(ws.stage, 'discovered');
    assert.equal(ws.stageLabel, 'Discovered');
    assert.ok(Array.isArray(ws.activity));
    assert.ok(ws.freshness);
    // buildJobReadModel's usual computed fields are preserved (superset, not replaced)
    assert.ok(ws._workflow);
    assert.ok(ws._ats);
    assert.equal(Array.isArray(ws.contacts), true);
    assert.equal(Array.isArray(ws.resumeVersions), true);

    // Loading a different, unrelated id returns that opportunity, not job-a.
    const other = mod.buildOpportunityWorkspace('job-b');
    assert.equal(other.id, 'job-b');
    assert.equal(other.company, 'Other Co');
  });

  it('reports fit as unavailable, with a reason, when no usable job description is saved', () => {
    writeTracker({
      'job-no-jd': { company: 'Acme', title: 'Strategic CSM', status: 'lead', date_updated: '2026-09-20' },
    });
    const ws = mod.buildOpportunityWorkspace('job-no-jd');
    assert.equal(ws.fit.available, false);
    assert.equal(typeof ws.fit.reason, 'string');
    assert.ok(ws.fit.reason.length > 0);
  });

  it('runs Phase 2 fit analysis and resolves evidence text against candidate facts when a usable JD is saved', () => {
    writeTracker({
      'job-with-jd': {
        company: 'Acme', title: 'Strategic CSM', status: 'lead', date_updated: '2026-09-20',
        full_description: USABLE_JD,
      },
    });
    const ws = mod.buildOpportunityWorkspace('job-with-jd');
    assert.equal(ws.fit.available, true);
    assert.equal(typeof ws.fit.overallScore, 'number');
    assert.ok(['High', 'Medium', 'Low'].includes(ws.fit.confidence.level));
    assert.ok(Array.isArray(ws.fit.classifications));
    assert.ok(ws.fit.classifications.length > 0);

    const validTiers = new Set(['Strong Match', 'Partial Match', 'Unknown', 'Gap', 'Blocker']);
    for (const c of ws.fit.classifications) {
      assert.ok(validTiers.has(c.tierLabel), `unexpected tierLabel: ${c.tierLabel}`);
      assert.equal(c.evidence.length, c.evidenceIds.length);
    }

    const peopleManagement = ws.fit.classifications.find(c => c.label === 'people management');
    assert.ok(peopleManagement, 'expected "people management" to be classified');
    assert.equal(peopleManagement.tier, 'partial_match');
    assert.deepEqual(peopleManagement.evidence, ['Managed and developed a team of 4 CSMs']);

    const rfp = ws.fit.classifications.find(c => c.label === 'RFP/RFI response');
    assert.ok(rfp, 'expected "RFP/RFI response" to be classified');
    assert.equal(rfp.tier, 'unknown');
  });

  it('ensures a persisted, answerable question exists for each Unknown requirement and surfaces it in fit.openQuestions', () => {
    writeTracker({
      'job-questions': {
        company: 'Acme', title: 'Strategic CSM', status: 'lead', date_updated: '2026-09-20',
        full_description: USABLE_JD,
      },
    });
    const ws = mod.buildOpportunityWorkspace('job-questions');
    const unknownLabels = ws.fit.classifications.filter(c => c.tier === 'unknown').map(c => c.label);
    assert.ok(unknownLabels.length > 0, 'fixture is expected to produce at least one Unknown');

    for (const label of unknownLabels) {
      const question = ws.fit.openQuestions.find(q => q.requirementLabel === label);
      assert.ok(question, `expected an open question for unknown requirement "${label}"`);
      assert.equal(question.status, 'open');
      assert.equal(typeof question.question, 'string');
    }

    // Re-computing the workspace must not create duplicate questions for the
    // same requirement (candidate-questions.mjs's own idempotency).
    const before = ws.fit.openQuestions.length;
    const ws2 = mod.buildOpportunityWorkspace('job-questions');
    assert.equal(ws2.fit.openQuestions.length, before);
  });

  it('handles missing optional data (no contacts, no resume, no compensation) without throwing', () => {
    writeTracker({
      'job-sparse': { company: '', title: '', status: 'lead', date_updated: '2026-09-20' },
    });
    const ws = mod.buildOpportunityWorkspace('job-sparse');
    assert.equal(Array.isArray(ws.contacts), true);
    assert.equal(ws.contacts.length, 0);
    assert.equal(Array.isArray(ws.resumeVersions), true);
    assert.equal(ws.resumeVersions.length, 0);
    assert.equal(ws.fit.available, false);
    assert.equal(Array.isArray(ws.activity), true);
  });

  it('includes a verified-evidence-only interview prep read model', () => {
    writeTracker({
      'job-prep': {
        company: 'Acme', title: 'Strategic CSM', status: 'technical_screen', stage: 'interview', date_updated: '2026-09-20',
        full_description: USABLE_JD,
        interviews: [{ id: 'round-1', roundType: 'hiring_manager', status: 'scheduled', scheduledAt: '2099-01-01T15:00:00.000Z', contactIds: [] }],
      },
    });
    const ws = mod.buildOpportunityWorkspace('job-prep');
    const prep = ws.interviewPrep;
    assert.ok(prep, 'expected interviewPrep on the workspace payload');
    assert.equal(prep.roundType, 'hiring_manager');
    assert.equal(prep.briefing.company, 'Acme');

    const people = prep.evidence.find(e => e.requirement === 'people management');
    assert.ok(people, 'expected evidence for people management');
    assert.deepEqual(people.facts.map(f => f.id), ['achievement-003']);
    assert.deepEqual(people.stories.map(s => s.id), ['story-001']);
    assert.doesNotMatch(JSON.stringify(prep), /Unverified draft/);

    assert.ok(prep.gaps.some(g => g.requirement === 'RFP/RFI response'));
    assert.ok(prep.likelyQuestions.length > 0);
    assert.ok(prep.questionsToAsk.length > 0);
    assert.equal(prep.checklist.find(c => c.id === 'round_scheduled').done, true);
  });

  it('hides activity before the display cutoff but keeps it stored', () => {
    writeTracker({
      'job-old-activity': {
        company: 'Acme', title: 'CSM', status: 'applied', stage: 'applied', date_updated: '2026-09-20',
        workflowTimeline: [
          { type: 'applied', at: '2026-07-01T00:00:00.000Z', source: 'manual', label: '', note: '' },
          { type: 'note_added', at: '2026-09-02T00:00:00.000Z', source: 'manual', label: '', note: 'recent' },
        ],
      },
    });
    const ws = mod.buildOpportunityWorkspace('job-old-activity');
    assert.ok(!ws.activity.some(e => e.at < '2026-09-01T05:00:00.000Z'));
    assert.ok(ws.activity.some(e => e.type === 'note_added'));
    assert.ok(!ws._workflow.timeline.some(e => e.at < '2026-09-01T05:00:00.000Z'));
    const stored = JSON.parse(fs.readFileSync(process.env.CAREER_OPS_TRACKER_PATH, 'utf8'))['job-old-activity'].workflowTimeline;
    assert.equal(stored.length, 2);
    assert.equal(ws.stage, 'applied');
  });
});
