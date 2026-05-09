import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTrackerStore } from '../lib/tracker-store.mjs';

function tempStore(initialTracker = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'career-ops-tracker-'));
  const trackerPath = path.join(dir, 'tracker.json');
  fs.writeFileSync(trackerPath, JSON.stringify(initialTracker, null, 2) + '\n', 'utf8');
  return { dir, trackerPath, store: createTrackerStore({ trackerPath, lockTimeoutMs: 1000 }) };
}

const baseJob = (overrides = {}) => ({
  company: 'Example',
  title: 'Customer Success Manager',
  status: 'lead',
  notes: '',
  ...overrides,
});

describe('tracker-store', () => {
  it('preserves concurrent different-job updates', async () => {
    const { store } = tempStore({
      a: baseJob({ company: 'Alpha', title: 'CSM' }),
      b: baseJob({ company: 'Beta', title: 'TAM' }),
    });

    await Promise.all([
      Promise.resolve().then(() => store.updateJob('a', job => ({ ...job, notes: 'updated a' }))),
      Promise.resolve().then(() => store.updateJob('b', job => ({ ...job, notes: 'updated b' }))),
    ]);

    const tracker = store.loadTracker();
    assert.equal(tracker.a.notes, 'updated a');
    assert.equal(tracker.b.notes, 'updated b');
  });

  it('updateJob preserves generatedDocs when a mutator omits it', () => {
    const { store } = tempStore({
      a: baseJob({
        generatedDocs: {
          default: { docxUrl: '/output/a.docx', generatedAt: '2026-05-01T00:00:00.000Z' },
        },
      }),
    });

    store.updateJob('a', job => ({
      company: job.company,
      title: job.title,
      status: 'applied',
      notes: 'submitted',
    }));

    const tracker = store.loadTracker();
    assert.equal(tracker.a.status, 'applied');
    assert.deepEqual(tracker.a.generatedDocs, {
      default: { docxUrl: '/output/a.docx', generatedAt: '2026-05-01T00:00:00.000Z' },
    });
  });

  it('accepts old generatedDocs entries without PDF metadata', () => {
    const oldGeneratedDocs = {
      default: {
        docxUrl: '/output/a.docx',
        coverLetterUrl: null,
        generatedAt: '2026-05-01T00:00:00.000Z',
      },
    };
    const { store } = tempStore({
      a: baseJob({ generatedDocs: oldGeneratedDocs }),
    });

    assert.deepEqual(store.loadTracker().a.generatedDocs, oldGeneratedDocs);
    assert.doesNotThrow(() => store.saveTrackerAtomic(store.loadTracker()));
  });

  it('persists workflowTimeline while preserving backward compatibility', () => {
    const { store } = tempStore({
      a: baseJob({
        workflowTimeline: [
          { type: 'applied', at: '2026-05-01T00:00:00.000Z', source: 'status' },
        ],
      }),
      b: baseJob(),
    });

    assert.doesNotThrow(() => store.saveTrackerAtomic(store.loadTracker()));
    const tracker = store.loadTracker();
    assert.equal(tracker.a.workflowTimeline[0].type, 'applied');
    assert.equal(tracker.b.workflowTimeline, undefined);
  });

  it('rejects unsupported workflow event types', () => {
    const { store } = tempStore({ a: baseJob() });

    assert.throws(
      () => store.saveTrackerAtomic({
        a: baseJob({ workflowTimeline: [{ type: 'unknown', at: '2026-05-01T00:00:00.000Z' }] }),
      }),
      /unsupported workflow event/
    );
  });

  it('persists validated job contacts', () => {
    const { store } = tempStore({
      a: baseJob({
        contacts: [{
          id: 'contact-1',
          name: 'Alex Morgan',
          title: 'Recruiter',
          company: 'Example',
          relationshipType: 'recruiter',
          responseStatus: 'not_contacted',
          linkedinUrl: 'https://www.linkedin.com/in/alex',
          email: 'alex@example.com',
          followUpDue: '2026-05-15',
          outreachDrafts: [{
            type: 'email',
            text: 'Subject: Hello\n\nHi Alex,',
            generatedAt: '2026-05-08T16:00:00.000Z',
            contactId: 'contact-1',
          }],
        }],
      }),
    });

    assert.doesNotThrow(() => store.saveTrackerAtomic(store.loadTracker()));
    const contact = store.loadTracker().a.contacts[0];
    assert.equal(contact.name, 'Alex Morgan');
    assert.equal(contact.relationshipType, 'recruiter');
    assert.equal(contact.outreachDrafts[0].type, 'email');
  });

  it('rejects invalid job contact shapes', () => {
    const { store } = tempStore({ a: baseJob() });

    assert.throws(
      () => store.saveTrackerAtomic({
        a: baseJob({ contacts: [{ relationshipType: 'recruiter' }] }),
      }),
      /contact name is required/
    );
    assert.throws(
      () => store.saveTrackerAtomic({
        a: baseJob({ contacts: [{ name: 'Alex', relationshipType: 'vendor' }] }),
      }),
      /unsupported contact relationship/
    );
    assert.throws(
      () => store.saveTrackerAtomic({
        a: baseJob({ contacts: [{ name: 'Alex', responseStatus: 'maybe' }] }),
      }),
      /unsupported contact response/
    );
    assert.throws(
      () => store.saveTrackerAtomic({
        a: baseJob({ contacts: [{ name: 'Alex', linkedinUrl: 'javascript:alert(1)' }] }),
      }),
      /linkedinUrl must be http\(s\)/
    );
    assert.throws(
      () => store.saveTrackerAtomic({
        a: baseJob({
          contacts: [{
            name: 'Alex',
            outreachDrafts: [{
              type: 'sms',
              text: 'Hello',
              generatedAt: '2026-05-08T16:00:00.000Z',
              contactId: 'contact-1',
            }],
          }],
        }),
      }),
      /unsupported outreach draft type/
    );
  });

  it('normalizes legacy status values on write', () => {
    const { store } = tempStore({
      a: baseJob({ status: 'Lead' }),
      b: baseJob({ status: 'phone_screen' }),
    });

    store.saveTrackerAtomic(store.loadTracker());
    const tracker = store.loadTracker();
    assert.equal(tracker.a.status, 'lead');
    assert.equal(tracker.b.status, 'recruiter_screen');
  });

  it('rejects invalid tracker data before write', () => {
    const { store } = tempStore({ a: baseJob() });

    assert.throws(
      () => store.saveTrackerAtomic({ a: { company: 42, title: 'CSM', status: 'lead' } }),
      /company must be a string/
    );

    assert.equal(store.loadTracker().a.company, 'Example');
  });

  it('does not leave partial JSON or temp files after rejected writes', () => {
    const { dir, trackerPath, store } = tempStore({ a: baseJob() });

    assert.throws(
      () => store.saveTrackerAtomic({ a: { company: 'Example', title: 'CSM', status: 42 } }),
      /status must be a string/
    );

    assert.doesNotThrow(() => JSON.parse(fs.readFileSync(trackerPath, 'utf8')));
    const tempFiles = fs.readdirSync(dir).filter(name => name.endsWith('.tmp') || name.endsWith('.lock'));
    assert.deepEqual(tempFiles, []);
  });
});
