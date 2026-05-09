import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'career-server-api-'));
const dataDir = path.join(tmp, 'data');
const configDir = path.join(tmp, 'config');
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(configDir, { recursive: true });

process.env.CAREER_OPS_DATA_DIR = dataDir;
process.env.CAREER_OPS_CONFIG_DIR = configDir;
process.env.CAREER_OPS_TRACKER_PATH = path.join(dataDir, 'tracker.json');
process.env.CAREER_OPS_GMAIL_JOBS_PATH = path.join(dataDir, 'gmail-jobs.json');
process.env.CAREER_OPS_DISABLE_LM_STUDIO = '1';

fs.writeFileSync(path.join(dataDir, 'master-brag-document.md'), 'Cybersecurity customer success leader with enterprise stakeholder evidence.\n');
fs.writeFileSync(path.join(configDir, 'profile.yml'), 'candidate:\n  full_name: Test Candidate\n');
fs.writeFileSync(process.env.CAREER_OPS_TRACKER_PATH, JSON.stringify({
  job1: {
    company: 'Acme Security',
    title: 'Senior Customer Success Manager',
    status: 'lead',
    date_updated: '2026-05-01',
  },
}, null, 2) + '\n');
fs.writeFileSync(process.env.CAREER_OPS_GMAIL_JOBS_PATH, JSON.stringify([
  {
    thread_id: 'thread-attach',
    company: 'Acme Security',
    role: 'Senior Customer Success Manager',
    status: 'recruiter_screen',
    last_email_subject: 'Acme next steps',
    last_email_date: '2026-05-08T12:00:00.000Z',
    last_email_snippet: 'Thanks for applying',
    gmailMatch: { ambiguous: true, confidence: 0.5 },
    matchCandidates: [{ id: 'job1', company: 'Acme Security', title: 'Senior Customer Success Manager' }],
  },
  {
    thread_id: 'thread-dismiss',
    company: 'Other',
    role: 'Customer Success Manager',
    gmailMatch: { ambiguous: true, confidence: 0.45 },
    matchCandidates: [{ id: 'job1', company: 'Acme Security', title: 'Senior Customer Success Manager' }],
  },
], null, 2) + '\n');

const { createApp } = await import(`../server.mjs?server-api=${Date.now()}`);
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

describe('server API routes', () => {
  it('lists and dismisses ambiguous Gmail matches', async () => {
    const listed = await request('/api/gmail-jobs?ambiguous=1');
    assert.equal(listed.res.status, 200);
    assert.equal(listed.body.length, 2);

    const dismissed = await request('/api/gmail-jobs/thread-dismiss/dismiss', {
      method: 'POST',
      body: JSON.stringify({}),
    });
    assert.equal(dismissed.res.status, 200);
    assert.equal(dismissed.body.ok, true);

    const relisted = await request('/api/gmail-jobs?ambiguous=1');
    assert.equal(relisted.body.length, 1);
    assert.equal(relisted.body[0].thread_id, 'thread-attach');
  });

  it('attaches ambiguous Gmail matches and advances status on approval', async () => {
    const attached = await request('/api/gmail-jobs/thread-attach/attach', {
      method: 'POST',
      body: JSON.stringify({ jobId: 'job1' }),
    });

    assert.equal(attached.res.status, 200);
    assert.equal(attached.body.ok, true);
    assert.equal(attached.body.previousStatus, 'lead');
    assert.equal(attached.body.detectedStatus, 'recruiter_screen');
    assert.equal(attached.body.resolvedStatus, 'recruiter_screen');
    assert.equal(attached.body.statusChanged, true);
    const job = tracker().job1;
    assert.equal(job.status, 'recruiter_screen');
    assert.equal(job.gmailAmbiguityResolution.action, 'attached');
    assert.equal(job.gmailAmbiguityResolution.previousStatus, 'lead');
    assert.equal(job.gmailAmbiguityResolution.detectedStatus, 'recruiter_screen');
    assert.equal(job.gmailAmbiguityResolution.resolvedStatus, 'recruiter_screen');
  });

  it('persists manual workflow events', async () => {
    const result = await request('/api/jobs/job1/workflow-event', {
      method: 'POST',
      body: JSON.stringify({ type: 'note_added', note: 'Prep account notes' }),
    });

    assert.equal(result.res.status, 200);
    assert.equal(result.body.ok, true);
    assert.equal(tracker().job1.workflowTimeline.at(-1).type, 'note_added');
    assert.match(tracker().job1.notes, /Prep account notes/);
  });

  it('exposes resume run snapshots for refresh recovery', async () => {
    const result = await request('/api/resume-runs');
    assert.equal(result.res.status, 200);
    assert.deepEqual(result.body, []);
  });

  it('validates and persists job contacts', async () => {
    const invalid = await request('/api/jobs/job1/contacts', {
      method: 'POST',
      body: JSON.stringify({ contact: { relationshipType: 'recruiter' } }),
    });
    assert.equal(invalid.res.status, 400);

    const saved = await request('/api/jobs/job1/contacts', {
      method: 'POST',
      body: JSON.stringify({
        contact: {
          name: 'Alex Morgan',
          title: 'Recruiter',
          relationshipType: 'recruiter',
          responseStatus: 'not_contacted',
        },
      }),
    });
    assert.equal(saved.res.status, 200);
    assert.equal(saved.body.contact.name, 'Alex Morgan');
    assert.equal(tracker().job1.contacts[0].name, 'Alex Morgan');
  });

  it('generates and stores outreach drafts for contacts', async () => {
    const contactId = tracker().job1.contacts[0].id;
    const result = await request('/api/jobs/job1/contacts/outreach-draft', {
      method: 'POST',
      body: JSON.stringify({ contactId, type: 'linkedin_connection' }),
    });

    assert.equal(result.res.status, 200);
    assert.equal(result.body.draft.contactId, contactId);
    assert.match(result.body.draft.text, /Acme Security/);
    assert.equal(tracker().job1.contacts[0].outreachDrafts.length, 1);
  });
});
