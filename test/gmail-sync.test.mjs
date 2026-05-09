import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  advanceStatus,
  buildGmailAttachFields,
  listAmbiguousGmailJobs,
  matchGmailEventToTracker,
  shouldUseIncomingEmail,
} from '../gmail-sync.mjs';

function job(overrides = {}) {
  return {
    id: overrides.id || 'job-1',
    company: overrides.company || 'Vanta',
    title: overrides.title || 'Strategic Customer Success Manager',
    url: overrides.url || 'https://jobs.ashbyhq.com/vanta/abc123',
    date_found: overrides.date_found || '2026-05-01',
    date_updated: overrides.date_updated || '2026-05-01',
    status: overrides.status || 'lead',
  };
}

function event(overrides = {}) {
  return {
    company: overrides.company || 'Vanta',
    role: overrides.role ?? 'Strategic Customer Success Manager',
    status: overrides.status || 'recruiter_screen',
    from: overrides.from || 'recruiter@vanta.com',
    last_email_subject: overrides.last_email_subject || 'Next steps for Strategic Customer Success Manager at Vanta',
    last_email_date: overrides.last_email_date || '2026-05-03T12:00:00.000Z',
    last_email_snippet: overrides.last_email_snippet || '',
    bodyText: overrides.bodyText || '',
  };
}

describe('matchGmailEventToTracker', () => {
  it('does not match same company when the role points to a different job', () => {
    const jobs = [
      job({ id: 'vanta-csm', title: 'Strategic Customer Success Manager' }),
      job({ id: 'vanta-se', title: 'Solutions Engineer, Upmarket', url: 'https://jobs.ashbyhq.com/vanta/se123' }),
    ];

    const match = matchGmailEventToTracker(
      event({
        role: 'Solutions Engineer, Upmarket',
        last_email_subject: 'Interview for Solutions Engineer, Upmarket at Vanta',
      }),
      jobs
    );

    assert.equal(match.job.id, 'vanta-se');
    assert.notEqual(match.job.id, 'vanta-csm');
    assert.ok(match.matchedBy.includes('title') || match.matchedBy.includes('thread_subject'));
  });

  it('matches exact company and title', () => {
    const match = matchGmailEventToTracker(
      event({ from: 'notifications@ashbyhq.com', last_email_date: '2026-08-01T12:00:00.000Z' }),
      [job()]
    );

    assert.equal(match.job.id, 'job-1');
    assert.ok(match.confidence >= 0.62);
    assert.equal(match.ambiguous, false);
  });

  it('marks ambiguous when multiple likely matches are too close', () => {
    const jobs = [
      job({ id: 'vanta-strategic', title: 'Strategic Customer Success Manager' }),
      job({ id: 'vanta-enterprise', title: 'Enterprise Customer Success Manager', url: 'https://jobs.ashbyhq.com/vanta/def456' }),
    ];

    const match = matchGmailEventToTracker(
      event({
        role: 'Customer Success Manager',
        from: 'notifications@ashbyhq.com',
        last_email_subject: 'Your Customer Success Manager application at Vanta',
      }),
      jobs
    );

    assert.equal(match.job, null);
    assert.equal(match.ambiguous, true);
    assert.equal(match.candidates.length, 2);
  });

  it('boosts confidence for recruiter/company domains', () => {
    const baseEvent = event({
      role: 'Strategic Customer Success Manager',
      last_email_subject: 'Strategic Customer Success Manager application',
      last_email_date: '2026-08-01T12:00:00.000Z',
    });

    const atsMatch = matchGmailEventToTracker({ ...baseEvent, from: 'notifications@ashbyhq.com' }, [job()]);
    const domainMatch = matchGmailEventToTracker({ ...baseEvent, from: 'jane@vanta.com' }, [job()]);

    assert.ok(domainMatch.confidence > atsMatch.confidence);
    assert.ok(domainMatch.matchedBy.includes('recruiter_domain'));
  });

  it('matches company-domain rejection outcomes even when the email omits role title', () => {
    const match = matchGmailEventToTracker(
      event({
        company: 'runZero',
        role: '',
        from: 'Maya Church <maya.church@runzero.com>',
        status: 'rejected',
        last_email_subject: 'Thank you for interviewing w/ runZero',
        last_email_date: '2026-05-07T20:37:41.000Z',
        last_email_snippet: "I've gathered your interview results and unfortunately, we've decided to not move forward with your candidacy for this position.",
      }),
      [job({
        id: 'gmail-i2cwyuvl',
        company: 'runZero',
        title: 'Customer Success Engineer',
        url: '',
        date_found: '2026-05-02',
        date_updated: '2026-05-08',
        status: 'technical_screen',
      })]
    );

    assert.equal(match.job.id, 'gmail-i2cwyuvl');
    assert.ok(match.confidence >= 0.62);
    assert.ok(match.matchedBy.includes('candidate_outcome'));
    assert.equal(match.ambiguous, false);
  });
});

describe('advanceStatus', () => {
  it('does not downgrade a terminal rejection when older interview emails are processed later', () => {
    assert.equal(advanceStatus('technical_screen', 'rejected'), 'rejected');
    assert.equal(advanceStatus('rejected', 'hiring_manager_screen'), 'rejected');
  });
});

describe('shouldUseIncomingEmail', () => {
  it('keeps newer rejection metadata when older interview emails are processed later', () => {
    assert.equal(
      shouldUseIncomingEmail('2026-05-07T20:37:41.000Z', '2026-05-04T15:15:44.000Z'),
      false
    );
    assert.equal(
      shouldUseIncomingEmail('2026-05-04T15:15:44.000Z', '2026-05-07T20:37:41.000Z'),
      true
    );
  });
});

describe('Gmail ambiguity review helpers', () => {
  it('lists only unresolved ambiguous Gmail jobs', () => {
    const ambiguous = {
      thread_id: 't1',
      gmailMatch: { ambiguous: true, confidence: 0.48 },
      matchCandidates: [{ id: 'job-1', company: 'Vanta', title: 'CSM' }],
    };

    assert.deepEqual(listAmbiguousGmailJobs([
      ambiguous,
      { thread_id: 't2', gmailMatch: { ambiguous: true }, gmailResolution: { action: 'dismissed' } },
      { thread_id: 't3', gmailMatch: { ambiguous: false } },
    ]), [ambiguous]);
  });

  it('builds attach fields without changing tracker status', () => {
    const fields = buildGmailAttachFields({
      thread_id: 't1',
      company: 'Vanta',
      role: 'Customer Success Manager',
      last_email_subject: 'Next steps at Vanta',
      last_email_date: '2026-05-08T12:00:00.000Z',
      last_email_snippet: 'Thanks for applying',
      gmailMatch: { ambiguous: true, confidence: 0.48, matchedBy: ['company'] },
    }, 'job-1', '2026-05-08T13:00:00.000Z');

    assert.equal(fields.last_email_subject, 'Next steps at Vanta');
    assert.equal(fields.gmailMatch.manuallyResolved, true);
    assert.equal(fields.gmailAmbiguityResolution.action, 'attached');
    assert.equal(fields.status, undefined);
  });
});
