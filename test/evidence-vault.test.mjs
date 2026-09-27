import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';

// candidate-data/candidate-questions/evidence-vault resolve their data
// directory from CAREER_OPS_DATA_DIR at MODULE LOAD time (the documented
// Phase 0 singleton trap) — set it and freshly import via a cache-busting
// query string before any assertion runs, mirroring
// test/opportunity-workspace.test.mjs's isolation pattern.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'career-evidence-vault-'));
const dataDir = path.join(tmp, 'data');
const candidateDir = path.join(dataDir, 'candidate');
fs.mkdirSync(candidateDir, { recursive: true });
process.env.CAREER_OPS_DATA_DIR = dataDir;

function seed() {
  fs.writeFileSync(path.join(candidateDir, 'employers.json'), JSON.stringify([
    { id: 'employer-001', fact: 'ExtraHop — Strategic CSM, 2023-Present', category: 'employer', employer: 'ExtraHop', source: 'seed', verified: true, allowed_in_resume: true },
  ], null, 2));
  fs.writeFileSync(path.join(candidateDir, 'achievements.json'), JSON.stringify([
    { id: 'achievement-001', fact: 'Portfolio: $23M ARR', category: 'metric', employer: 'ExtraHop', source: 'seed', verified: true, allowed_in_resume: true },
    { id: 'achievement-002', fact: 'Managed a team of 4 CSMs', category: 'achievement', employer: 'ExtraHop', source: 'seed', verified: true, allowed_in_resume: true },
  ], null, 2));
  fs.writeFileSync(path.join(candidateDir, 'skills.json'), JSON.stringify([
    { id: 'skill-001', fact: 'Cloud Security (CNAPP)', category: 'skill', employer: null, source: 'seed', verified: true, allowed_in_resume: true },
  ], null, 2));
  fs.writeFileSync(path.join(candidateDir, 'certifications.json'), JSON.stringify([
    { id: 'cert-001', fact: 'CEH', category: 'certification', employer: null, source: 'seed', verified: true, allowed_in_resume: true },
  ], null, 2));
  fs.writeFileSync(path.join(candidateDir, 'questions.json'), JSON.stringify([
    {
      id: 'question-answered-1', requirementLabel: 'RFP responses',
      question: 'Have you done work involving RFP responses?',
      status: 'answered', answer: 'Yes, at ExtraHop — drafted 3 enterprise RFP responses.',
      jobIds: ['job-a'], createdAt: '2026-09-01T00:00:00.000Z', answeredAt: '2026-09-02T00:00:00.000Z',
      promotedFactId: null,
    },
    {
      id: 'question-open-1', requirementLabel: 'people management',
      question: 'Have you done work involving people management?',
      status: 'open', answer: null, jobIds: ['job-a'], createdAt: '2026-09-01T00:00:00.000Z', answeredAt: null,
      promotedFactId: null,
    },
  ], null, 2));
  if (fs.existsSync(path.join(candidateDir, 'stories.json'))) fs.rmSync(path.join(candidateDir, 'stories.json'));
}

let mod;
before(async () => {
  seed();
  mod = await import(`../lib/evidence-vault.mjs?t=${Date.now()}-${Math.random()}`);
});
beforeEach(() => seed());
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('buildEvidenceVault', () => {
  it('groups records into the six Career Profile sections, filtered by their own category', () => {
    const vault = mod.buildEvidenceVault();
    assert.deepEqual(Object.keys(vault), ['experience', 'achievements', 'skills', 'certifications', 'metrics', 'stories']);
    assert.equal(vault.experience.length, 1);
    assert.equal(vault.experience[0].id, 'employer-001');
    // achievements.json holds both 'metric' and 'achievement' records —
    // each section must only show its own category, not the whole file.
    assert.equal(vault.achievements.length, 1);
    assert.equal(vault.achievements[0].id, 'achievement-002');
    assert.equal(vault.metrics.length, 1);
    assert.equal(vault.metrics[0].id, 'achievement-001');
    assert.equal(vault.skills.length, 1);
    assert.equal(vault.certifications.length, 1);
    assert.equal(vault.stories.length, 0);
  });

  it('decorates every skill with evidence/experienceDepth/lastUsed defaults without inventing values', () => {
    const vault = mod.buildEvidenceVault();
    const skill = vault.skills[0];
    assert.equal(skill.evidence, null);
    assert.equal(skill.experienceDepth, null);
    assert.equal(skill.lastUsed, null);
    assert.deepEqual(skill.tags, []);
  });
});

describe('addFact — safe add', () => {
  it('adds a new verified skill with resume permission', () => {
    const fact = mod.addFact('skill', { fact: 'Net Revenue Retention (NRR)', verified: true, allowed_in_resume: true, tags: ['metrics'] });
    assert.equal(fact.category, 'skill');
    assert.equal(fact.verified, true);
    assert.equal(fact.allowed_in_resume, true);
    assert.deepEqual(fact.tags, ['metrics']);
    assert.ok(fact.id.startsWith('skill-'));
  });

  it('defaults verified and allowed_in_resume to false when not explicitly set — never assumes a new record is usable', () => {
    const fact = mod.addFact('skill', { fact: 'Some new claim' });
    assert.equal(fact.verified, false);
    assert.equal(fact.allowed_in_resume, false);
  });

  it('rejects allowed_in_resume=true on an unverified record (Phase 0 evidence rule)', () => {
    assert.throws(() => mod.addFact('skill', { fact: 'Unverified but resume-ready?', verified: false, allowed_in_resume: true }),
      /verify it first/i);
  });

  it('adds a story with STAR fields', () => {
    const story = mod.addFact('story', {
      situation: 'Enterprise renewal at risk', task: 'Save a $13M account',
      action: 'Ran an executive business review', result: 'Renewed + 122% expansion',
      tags: ['renewal'], verified: true,
    });
    assert.equal(story.category, 'story');
    assert.equal(story.situation, 'Enterprise renewal at risk');
    assert.equal(story.result, 'Renewed + 122% expansion');
  });

  it('rejects a story missing any STAR field', () => {
    assert.throws(() => mod.addFact('story', { situation: 'x', task: 'y', action: 'z' }), /situation, task, action, and result/i);
  });
});

describe('duplicate prevention', () => {
  it('rejects an exact duplicate fact for the same category and employer', () => {
    assert.throws(() => mod.addFact('employer', { fact: 'ExtraHop — Strategic CSM, 2023-Present', employer: 'ExtraHop' }),
      (err) => { assert.equal(err.code, 'DUPLICATE_EVIDENCE'); assert.equal(err.existingId, 'employer-001'); return true; });
  });

  it('is case/whitespace-insensitive when detecting duplicates', () => {
    assert.throws(() => mod.addFact('skill', { fact: '  cloud security (cnapp)  ' }), (err) => {
      assert.equal(err.code, 'DUPLICATE_EVIDENCE');
      return true;
    });
  });

  it('does not treat a metric and an achievement in the same file as duplicates of each other', () => {
    // Same-looking text, different category — should not collide even
    // though both live in achievements.json.
    const fact = mod.addFact('achievement', { fact: 'Portfolio: $23M ARR', employer: 'Somewhere Else' });
    assert.ok(fact.id.startsWith('achievement-'));
  });
});

describe('updateFact — safe edit', () => {
  it('updates only the fields provided, leaving everything else untouched', () => {
    const before = mod.buildEvidenceVault().certifications[0];
    const updated = mod.updateFact('certification', before.id, { tags: ['security'] });
    assert.deepEqual(updated.tags, ['security']);
    assert.equal(updated.fact, before.fact);
    assert.equal(updated.verified, before.verified);
  });

  it('never silently converts unverified to verified — verified only changes when explicitly included', () => {
    const added = mod.addFact('skill', { fact: 'Draft skill' }); // verified: false
    const untouched = mod.updateFact('skill', added.id, { tags: ['x'] });
    assert.equal(untouched.verified, false, 'editing an unrelated field must not flip verified');
    const verified = mod.updateFact('skill', added.id, { verified: true });
    assert.equal(verified.verified, true);
  });

  it('enforces the resume-permission invariant on edit too', () => {
    const added = mod.addFact('skill', { fact: 'Another draft skill' }); // verified: false
    assert.throws(() => mod.updateFact('skill', added.id, { allowed_in_resume: true }), /verify it first/i);
    // Setting both together is fine.
    const ok = mod.updateFact('skill', added.id, { verified: true, allowed_in_resume: true });
    assert.equal(ok.allowed_in_resume, true);
  });

  it('404s (via error code) on an unknown id', () => {
    assert.throws(() => mod.updateFact('skill', 'skill-does-not-exist', { tags: [] }),
      (err) => { assert.equal(err.code, 'EVIDENCE_NOT_FOUND'); return true; });
  });
});

describe('Phase 2 unknown resolution — promoting an answered question to evidence', () => {
  it('requires explicit confirmation', () => {
    assert.throws(() => mod.promoteQuestionToEvidence('question-answered-1', {}),
      (err) => { assert.equal(err.code, 'CONFIRMATION_REQUIRED'); return true; });
  });

  it('refuses to promote a question that has not been answered', () => {
    assert.throws(() => mod.promoteQuestionToEvidence('question-open-1', { confirm: true }), /not been answered/i);
  });

  it('creates a verified, resume-usable fact from the answer once confirmed', () => {
    const result = mod.promoteQuestionToEvidence('question-answered-1', { confirm: true, category: 'skill' });
    assert.equal(result.alreadyPromoted, false);
    assert.equal(result.fact.verified, true);
    assert.equal(result.fact.allowed_in_resume, true);
    assert.match(result.fact.fact, /RFP/);
    assert.equal(result.fact.source, 'candidate-question:question-answered-1');
  });

  it('is idempotent — re-confirming an already-promoted question returns the same fact, never a duplicate', () => {
    const first = mod.promoteQuestionToEvidence('question-answered-1', { confirm: true, category: 'skill' });
    const second = mod.promoteQuestionToEvidence('question-answered-1', { confirm: true, category: 'skill' });
    assert.equal(second.alreadyPromoted, true);
    assert.equal(second.fact.id, first.fact.id);
    const vault = mod.buildEvidenceVault();
    assert.equal(vault.skills.filter(s => s.source === 'candidate-question:question-answered-1').length, 1);
  });

  it('404s on an unknown question id', () => {
    assert.throws(() => mod.promoteQuestionToEvidence('does-not-exist', { confirm: true }),
      (err) => { assert.equal(err.code, 'QUESTION_NOT_FOUND'); return true; });
  });
});
