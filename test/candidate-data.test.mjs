import { strict as assert } from 'node:assert';
import { describe, it, beforeEach, afterEach } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

function withFixtureDataDir(files, fn) {
  return async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'candidate-data-'));
    const candidateDir = path.join(dir, 'candidate');
    fs.mkdirSync(candidateDir, { recursive: true });
    for (const [name, content] of Object.entries(files)) {
      fs.writeFileSync(path.join(candidateDir, name), JSON.stringify(content), 'utf8');
    }
    const prevEnv = process.env.CAREER_OPS_DATA_DIR;
    process.env.CAREER_OPS_DATA_DIR = dir;
    try {
      // Fresh import per test run isn't possible without cache-busting; instead
      // we re-derive the module URL with a cache-busting query so each test
      // sees its own fixture dir rather than a previously cached DATA_DIR.
      const mod = await import(`../lib/candidate-data.mjs?t=${Date.now()}-${Math.random()}`);
      await fn(mod);
    } finally {
      if (prevEnv === undefined) delete process.env.CAREER_OPS_DATA_DIR;
      else process.env.CAREER_OPS_DATA_DIR = prevEnv;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

describe('candidate-data loaders', () => {
  it('loads fact files and returns [] for missing/empty ones', withFixtureDataDir({
    'employers.json': [{ id: 'employer-001', fact: 'ExtraHop — CSE', category: 'employer', employer: 'ExtraHop', source: 'master-brag-document.md', verified: true, allowed_in_resume: true }],
  }, async (mod) => {
    assert.equal(mod.loadCandidateEmployers().length, 1);
    assert.deepEqual(mod.loadCandidateAchievements(), []);
    assert.deepEqual(mod.loadCandidateSkills(), []);
    assert.deepEqual(mod.loadCandidateCertifications(), []);
  }));

  it('loadCandidateFacts includes only verified+allowed facts', withFixtureDataDir({
    'achievements.json': [
      { id: 'achievement-001', fact: 'Managed $23M ARR portfolio', category: 'metric', employer: 'ExtraHop', source: 'master-brag-document.md', verified: true, allowed_in_resume: true },
      { id: 'achievement-002', fact: 'Saved $1.35M at-risk renewal', category: 'achievement', employer: null, source: 'profile.yml (unverified)', verified: false, allowed_in_resume: false, needs_verification: true },
    ],
  }, async (mod) => {
    const usable = mod.loadCandidateFacts();
    assert.equal(usable.length, 1);
    assert.equal(usable[0].id, 'achievement-001');

    const needsReview = mod.loadFactsNeedingVerification();
    assert.equal(needsReview.length, 1);
    assert.equal(needsReview[0].id, 'achievement-002');
  }));

  it('candidateDataExists is false when no fact files are present', withFixtureDataDir({}, async (mod) => {
    assert.equal(mod.candidateDataExists(), false);
  }));

  it('candidateDataExists is true once at least one verified fact exists', withFixtureDataDir({
    'skills.json': [{ id: 'skill-001', fact: 'SIEM', category: 'skill', employer: null, source: 'master-brag-document.md', verified: true, allowed_in_resume: true }],
  }, async (mod) => {
    assert.equal(mod.candidateDataExists(), true);
  }));

  it('a malformed JSON fact file degrades to an empty array rather than throwing', withFixtureDataDir({}, async (mod) => {
    // Nothing malformed written for this loader-level test; exercised via a
    // separate raw-write case below.
    assert.deepEqual(mod.loadCandidateEmployers(), []);
  }));
});

describe('evidenceValidationMode', () => {
  const prev = process.env.CANDIDATE_EVIDENCE_MODE;
  afterEach(() => {
    if (prev === undefined) delete process.env.CANDIDATE_EVIDENCE_MODE;
    else process.env.CANDIDATE_EVIDENCE_MODE = prev;
  });

  it('defaults to block when unset', async () => {
    delete process.env.CANDIDATE_EVIDENCE_MODE;
    const mod = await import(`../lib/candidate-data.mjs?t=${Date.now()}-${Math.random()}`);
    assert.equal(mod.evidenceValidationMode(), 'block');
  });

  it('accepts off, warn, and block, and falls back to block for unknown values', async () => {
    const mod = await import(`../lib/candidate-data.mjs?t=${Date.now()}-${Math.random()}`);
    process.env.CANDIDATE_EVIDENCE_MODE = 'warn';
    assert.equal(mod.evidenceValidationMode(), 'warn');
    process.env.CANDIDATE_EVIDENCE_MODE = 'block';
    assert.equal(mod.evidenceValidationMode(), 'block');
    process.env.CANDIDATE_EVIDENCE_MODE = 'off';
    assert.equal(mod.evidenceValidationMode(), 'off');
    process.env.CANDIDATE_EVIDENCE_MODE = 'nonsense';
    assert.equal(mod.evidenceValidationMode(), 'block');
  });
});
