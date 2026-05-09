import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  normalizeContacts,
  upsertJobContact,
  validateContactPayload,
} from '../lib/job-contacts.mjs';

const NOW = new Date('2026-05-08T15:30:00.000Z');

describe('job contacts', () => {
  it('normalizes legacy/missing contacts without requiring existing jobs to change', () => {
    assert.deepEqual(normalizeContacts(), []);
    assert.deepEqual(normalizeContacts([{ name: '' }, null]), []);

    const [contact] = normalizeContacts([{ name: ' Alex ', relationshipType: 'referral' }]);
    assert.equal(contact.name, 'Alex');
    assert.equal(contact.relationshipType, 'referral');
    assert.equal(contact.responseStatus, 'not_contacted');
  });

  it('validates required fields and safe enum/string shapes', () => {
    assert.throws(() => validateContactPayload({ contact: { name: '' } }), /Contact name is required/);
    assert.throws(
      () => validateContactPayload({ contact: { name: 'Alex', relationshipType: 'vendor' } }),
      /Invalid relationshipType/
    );
    assert.throws(
      () => validateContactPayload({ contact: { name: 'Alex', responseStatus: 'maybe' } }),
      /Invalid responseStatus/
    );
    assert.throws(
      () => validateContactPayload({ contact: { name: 'Alex', linkedinUrl: 'javascript:alert(1)' } }),
      /linkedinUrl must be http\(s\)/
    );
    assert.throws(
      () => validateContactPayload({ contact: { name: 'Alex', email: 'not-email' } }),
      /email is invalid/
    );
    assert.throws(
      () => validateContactPayload({ contact: { name: 'Alex', followUpDue: '05\/08\/2026' } }),
      /YYYY-MM-DD/
    );
  });

  it('persists contacts and edits existing contacts by id', () => {
    const job = { company: 'Acme', title: 'CSM' };

    const saved = upsertJobContact(job, {
      contact: {
        name: 'Alex Morgan',
        title: 'Recruiter',
        company: 'Acme',
        relationshipType: 'recruiter',
        responseStatus: 'not_contacted',
      },
    }, NOW);

    assert.equal(job.contacts.length, 1);
    assert.equal(saved.name, 'Alex Morgan');
    assert.equal(saved.updatedAt, NOW.toISOString());
    assert.equal(job.workflowTimeline, undefined);

    const edited = upsertJobContact(job, {
      contact: {
        id: saved.id,
        name: 'Alex Morgan',
        title: 'Senior Recruiter',
        company: 'Acme',
        relationshipType: 'recruiter',
      },
    }, NOW);

    assert.equal(job.contacts.length, 1);
    assert.equal(edited.title, 'Senior Recruiter');
  });

  it('marks outreach sent and appends a workflow event', () => {
    const job = { company: 'Acme', title: 'CSM' };
    const saved = upsertJobContact(job, {
      contact: { name: 'Priya Shah', relationshipType: 'hiring_manager' },
    }, NOW);

    const updated = upsertJobContact(job, {
      contact: { ...saved, responseStatus: 'outreach_sent' },
      markOutreachSent: true,
    }, NOW);

    assert.equal(updated.responseStatus, 'outreach_sent');
    assert.equal(updated.outreachSentAt, NOW.toISOString());
    assert.equal(job.workflowTimeline.length, 1);
    assert.deepEqual(job.workflowTimeline[0], {
      type: 'outreach_sent',
      at: NOW.toISOString(),
      source: 'contact',
      label: 'Priya Shah',
      note: 'hiring_manager',
    });
  });
});
