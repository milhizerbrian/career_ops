import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'career-opp-workspace-api-'));
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

fs.writeFileSync(path.join(dataDir, 'master-brag-document.md'), 'Cybersecurity customer success leader with enterprise stakeholder evidence.\n');
fs.writeFileSync(path.join(configDir, 'profile.yml'), 'candidate:\n  full_name: Test Candidate\n');
fs.writeFileSync(process.env.CAREER_OPS_GMAIL_JOBS_PATH, '[]\n');
fs.writeFileSync(process.env.CAREER_OPS_TRACKER_PATH, JSON.stringify({
  'opp-1': {
    company: 'Acme Security',
    title: 'Strategic Customer Success Manager',
    status: 'lead',
    stage: 'discovered',
    date_found: '2026-09-01',
    date_updated: '2026-09-01',
  },
}, null, 2) + '\n');

const { createApp } = await import(`../server.mjs?opp-workspace-api=${Date.now()}`);
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

function tracker() {
  return JSON.parse(fs.readFileSync(process.env.CAREER_OPS_TRACKER_PATH, 'utf8'));
}

describe('Opportunity Workspace API (Phase 4)', () => {
  it('serves the workspace payload for a known opportunity', async () => {
    const { res, body } = await request('/api/opportunities/opp-1/workspace');
    assert.equal(res.status, 200);
    assert.equal(body.id, 'opp-1');
    assert.equal(body.company, 'Acme Security');
    assert.equal(body.stageLabel, 'Discovered');
    assert.ok(Array.isArray(body.activity));
    assert.equal(body.fit.available, false);
    assert.ok(body._workflow);
  });

  it('404s a missing opportunity', async () => {
    const { res, body } = await request('/api/opportunities/does-not-exist/workspace');
    assert.equal(res.status, 404);
    assert.match(body.error, /not found/i);
  });

  it('updates Application-tab fields via PATCH and rejects unsupported fields', async () => {
    const rejected = await request('/api/opportunities/opp-1', {
      method: 'PATCH',
      body: JSON.stringify({ company: 'Should not be allowed here' }),
    });
    assert.equal(rejected.res.status, 400);

    const updated = await request('/api/opportunities/opp-1', {
      method: 'PATCH',
      body: JSON.stringify({ appliedDate: '2026-09-10', applicationSource: 'LinkedIn', priority: 'high' }),
    });
    assert.equal(updated.res.status, 200);
    assert.equal(updated.body.ok, true);
    assert.equal(updated.body.workspace.appliedDate, '2026-09-10');
    assert.equal(updated.body.workspace.applicationSource, 'LinkedIn');
    assert.equal(updated.body.workspace.priority, 'high');
    assert.equal(tracker()['opp-1'].applicationSource, 'LinkedIn');
  });

  it('changes stage via the dedicated stage route and records an activity event', async () => {
    const before = await request('/api/opportunities/opp-1/workspace');
    const beforeCount = before.body.activity.length;

    const result = await request('/api/opportunities/opp-1/stage', {
      method: 'POST',
      body: JSON.stringify({ stage: 'pursuing', reason: 'Looks strong' }),
    });
    assert.equal(result.res.status, 200);
    assert.equal(result.body.workspace.stage, 'pursuing');
    assert.equal(result.body.workspace.stageLabel, 'Pursuing');
    assert.ok(result.body.workspace.activity.length > beforeCount);
    const stageChange = result.body.workspace.activity.find(e => e.type === 'stage_changed');
    assert.ok(stageChange, 'expected a stage_changed activity event');
    assert.equal(stageChange.to, 'pursuing');
  });

  it('rejects an unsupported stage', async () => {
    const result = await request('/api/opportunities/opp-1/stage', {
      method: 'POST',
      body: JSON.stringify({ stage: 'not-a-real-stage' }),
    });
    assert.equal(result.res.status, 400);
  });

  it('answers a persisted candidate question raised by the Fit tab', async () => {
    fs.writeFileSync(process.env.CAREER_OPS_TRACKER_PATH, JSON.stringify({
      'opp-2': {
        company: 'Beta Corp',
        title: 'Strategic CSM',
        status: 'lead',
        date_updated: '2026-09-05',
        full_description: 'Responsibilities: Manage and develop a team of CSMs.\n\nRequirements: Prepare RFP responses. 10+ years required.',
      },
    }, null, 2));

    const workspace = await request('/api/opportunities/opp-2/workspace');
    assert.equal(workspace.res.status, 200);
    assert.equal(workspace.body.fit.available, true);
    assert.ok(workspace.body.fit.openQuestions.length > 0, 'expected at least one open candidate question');
    const question = workspace.body.fit.openQuestions[0];

    const answered = await request(`/api/candidate-questions/${encodeURIComponent(question.id)}/answer`, {
      method: 'POST',
      body: JSON.stringify({ answer: 'Yes, at ExtraHop — drafted 3 enterprise RFP responses.' }),
    });
    assert.equal(answered.res.status, 200);
    assert.equal(answered.body.question.status, 'answered');

    const refreshed = await request('/api/opportunities/opp-2/workspace');
    assert.ok(!refreshed.body.fit.openQuestions.some(q => q.id === question.id));
  });
});
