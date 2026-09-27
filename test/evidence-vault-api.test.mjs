import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'career-evidence-vault-api-'));
const dataDir = path.join(tmp, 'data');
const configDir = path.join(tmp, 'config');
const candidateDir = path.join(dataDir, 'candidate');
fs.mkdirSync(candidateDir, { recursive: true });
fs.mkdirSync(configDir, { recursive: true });

process.env.CAREER_OPS_DATA_DIR = dataDir;
process.env.CAREER_OPS_CONFIG_DIR = configDir;
process.env.CAREER_OPS_TRACKER_PATH = path.join(dataDir, 'tracker.json');
process.env.CAREER_OPS_GMAIL_JOBS_PATH = path.join(dataDir, 'gmail-jobs.json');
process.env.CAREER_OPS_DISABLE_LM_STUDIO = '1';

fs.writeFileSync(path.join(dataDir, 'master-brag-document.md'), 'Cybersecurity customer success leader.\n');
fs.writeFileSync(path.join(configDir, 'profile.yml'), 'candidate:\n  full_name: Test Candidate\n');
fs.writeFileSync(process.env.CAREER_OPS_GMAIL_JOBS_PATH, '[]\n');
fs.writeFileSync(process.env.CAREER_OPS_TRACKER_PATH, '{}\n');
fs.writeFileSync(path.join(candidateDir, 'skills.json'), JSON.stringify([
  { id: 'skill-001', fact: 'Cloud Security (CNAPP)', category: 'skill', employer: null, source: 'seed', verified: true, allowed_in_resume: true },
], null, 2));
fs.writeFileSync(path.join(candidateDir, 'questions.json'), JSON.stringify([
  {
    id: 'question-1', requirementLabel: 'RFP responses',
    question: 'Have you done work involving RFP responses?',
    status: 'answered', answer: 'Yes, at ExtraHop — drafted 3 enterprise RFP responses.',
    jobIds: ['job-a'], createdAt: '2026-09-01T00:00:00.000Z', answeredAt: '2026-09-02T00:00:00.000Z',
    promotedFactId: null,
  },
], null, 2));

const { createApp } = await import(`../server.mjs?evidence-vault-api=${Date.now()}`);
const listener = createApp().listen(0);
const baseUrl = await new Promise(resolve => {
  listener.on('listening', () => resolve(`http://127.0.0.1:${listener.address().port}`));
});

after(() => {
  listener.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function request(pathname, options = {}) {
  const res = await fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
  });
  const body = await res.json();
  return { res, body };
}

describe('Evidence Vault API (Phase 5)', () => {
  it('serves the six-section Career Profile payload', async () => {
    const { res, body } = await request('/api/evidence-vault');
    assert.equal(res.status, 200);
    assert.deepEqual(Object.keys(body), ['experience', 'achievements', 'skills', 'certifications', 'metrics', 'stories']);
    assert.equal(body.skills.length, 1);
  });

  it('adds a new fact via POST and rejects a follow-up duplicate', async () => {
    const added = await request('/api/evidence-vault/skill', {
      method: 'POST',
      body: JSON.stringify({ fact: 'Net Revenue Retention (NRR)', verified: true, allowed_in_resume: true }),
    });
    assert.equal(added.res.status, 200);
    assert.equal(added.body.ok, true);
    assert.equal(added.body.fact.fact, 'Net Revenue Retention (NRR)');

    const dup = await request('/api/evidence-vault/skill', {
      method: 'POST',
      body: JSON.stringify({ fact: 'net revenue retention (nrr)' }),
    });
    assert.equal(dup.res.status, 409);
  });

  it('rejects allowed_in_resume without verified', async () => {
    const { res, body } = await request('/api/evidence-vault/skill', {
      method: 'POST',
      body: JSON.stringify({ fact: 'Some unverifiable claim', allowed_in_resume: true }),
    });
    assert.equal(res.status, 400);
    assert.match(body.error, /verify it first/i);
  });

  it('edits a fact via PATCH without touching other fields', async () => {
    const { res, body } = await request('/api/evidence-vault/skill/skill-001', {
      method: 'PATCH',
      body: JSON.stringify({ tags: ['cloud', 'security'] }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(body.fact.tags, ['cloud', 'security']);
    assert.equal(body.fact.fact, 'Cloud Security (CNAPP)');
  });

  it('404s a PATCH to an unknown record', async () => {
    const { res } = await request('/api/evidence-vault/skill/skill-does-not-exist', {
      method: 'PATCH',
      body: JSON.stringify({ tags: [] }),
    });
    assert.equal(res.status, 404);
  });

  it('requires confirmation before promoting an answered question to evidence', async () => {
    const noConfirm = await request('/api/candidate-questions/question-1/promote', {
      method: 'POST',
      body: JSON.stringify({}),
    });
    assert.equal(noConfirm.res.status, 400);

    const confirmed = await request('/api/candidate-questions/question-1/promote', {
      method: 'POST',
      body: JSON.stringify({ confirm: true, category: 'skill' }),
    });
    assert.equal(confirmed.res.status, 200);
    assert.equal(confirmed.body.fact.verified, true);
    assert.equal(confirmed.body.fact.allowed_in_resume, true);

    // Re-promoting is idempotent, not a duplicate.
    const again = await request('/api/candidate-questions/question-1/promote', {
      method: 'POST',
      body: JSON.stringify({ confirm: true, category: 'skill' }),
    });
    assert.equal(again.res.status, 200);
    assert.equal(again.body.alreadyPromoted, true);
    assert.equal(again.body.fact.id, confirmed.body.fact.id);
  });
});
