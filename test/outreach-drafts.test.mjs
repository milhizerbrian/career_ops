import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  buildOutreachDraftFallback,
  createOutreachDraft,
  generateAndStoreOutreachDraft,
  validateOutreachDraftPayload,
} from '../lib/outreach-drafts.mjs';

const NOW = new Date('2026-05-08T16:00:00.000Z');

function jobFixture() {
  return {
    company: 'Acme Security',
    title: 'Senior Customer Success Manager',
    score_analysis: 'strong fit for enterprise cybersecurity customer outcomes',
    contacts: [{
      id: 'contact-1',
      name: 'Alex Morgan',
      title: 'Recruiter',
      company: 'Acme Security',
      relationshipType: 'recruiter',
      responseStatus: 'not_contacted',
    }],
  };
}

describe('outreach drafts', () => {
  it('validates draft type and contact id', () => {
    assert.throws(() => validateOutreachDraftPayload({ type: 'email' }), /contactId is required/);
    assert.throws(
      () => validateOutreachDraftPayload({ contactId: 'contact-1', type: 'sms' }),
      /Invalid outreach draft type/
    );
    assert.deepEqual(validateOutreachDraftPayload({ contactId: 'contact-1', type: 'email' }), {
      contactId: 'contact-1',
      type: 'email',
    });
  });

  it('generates deterministic fallback drafts by type', () => {
    const job = jobFixture();
    const contact = job.contacts[0];

    const linkedIn = buildOutreachDraftFallback({
      job,
      contact,
      bragDoc: 'Led enterprise cybersecurity customer success programs with measurable retention outcomes.',
      type: 'linkedin_connection',
    });
    assert.match(linkedIn, /Hi Alex/);
    assert.match(linkedIn, /Acme Security/);
    assert.doesNotMatch(linkedIn, /Subject:/);

    const email = buildOutreachDraftFallback({ job, contact, bragDoc: '', type: 'email' });
    assert.match(email, /Subject: Acme Security - Senior Customer Success Manager/);
    assert.match(email, /Best,\nBrian/);
  });

  it('falls back when LM Studio is disabled and returns draft metadata', async () => {
    const draft = await createOutreachDraft(jobFixture(), {
      contactId: 'contact-1',
      type: 'linkedin_follow_up',
    }, {
      bragDoc: 'Built cybersecurity customer programs across executive stakeholders.',
      now: NOW,
      useLmStudio: false,
    });

    assert.equal(draft.type, 'linkedin_follow_up');
    assert.equal(draft.contactId, 'contact-1');
    assert.equal(draft.generatedAt, NOW.toISOString());
    assert.match(draft.text, /following up/i);
  });

  it('persists generated drafts on the selected contact', async () => {
    const job = jobFixture();
    const draft = await generateAndStoreOutreachDraft(job, {
      contactId: 'contact-1',
      type: 'email',
    }, {
      bragDoc: 'Owned cybersecurity renewals and adoption motions.',
      now: NOW,
      useLmStudio: false,
    });

    assert.equal(job.contacts[0].outreachDrafts.length, 1);
    assert.deepEqual(job.contacts[0].outreachDrafts[0], draft);
    assert.equal(job.contacts[0].updatedAt, NOW.toISOString());
  });
});
