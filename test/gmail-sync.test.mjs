import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  advanceStatus,
  buildGmailAttachFields,
  gmailReauthMessage,
  isGmailAuthError,
  listAmbiguousGmailJobs,
  matchGmailEventToTracker,
  shouldUseIncomingEmail,
  verifyLmStudio,
  classificationReviewReasons,
  isUnusableExtractedValue,
  resolveTrackerSyncStatus,
  gmailJobMutator,
  candidacyOwnershipReasons,
  getBestMessage,
  isCandidateSender,
  storedGmailMatch,
  matchTrackerPassEmail,
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

describe('Gmail auth failures', () => {
  it('recognizes invalid_grant and returns a reauth instruction', () => {
    assert.equal(isGmailAuthError(new Error('invalid_grant')), true);
    assert.equal(isGmailAuthError({ code: 401, message: 'Invalid Credentials' }), true);
    assert.equal(isGmailAuthError(new Error('quota exceeded')), false);
    assert.match(gmailReauthMessage('invalid_grant'), /node oauth-setup\.mjs/);
    assert.match(gmailReauthMessage('invalid_grant'), /GMAIL_REFRESH_TOKEN/);
    assert.match(gmailReauthMessage('invalid_grant'), /--dry-run/);
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

  it('builds attach fields and advances tracker status on approval', () => {
    const fields = buildGmailAttachFields({
      thread_id: 't1',
      company: 'Vanta',
      role: 'Customer Success Manager',
      status: 'recruiter_screen',
      last_email_subject: 'Next steps at Vanta',
      last_email_date: '2026-05-08T12:00:00.000Z',
      last_email_snippet: 'Thanks for applying',
      gmailMatch: { ambiguous: true, confidence: 0.48, matchedBy: ['company'] },
    }, { id: 'job-1', status: 'applied' }, '2026-05-08T13:00:00.000Z');

    assert.equal(fields.last_email_subject, 'Next steps at Vanta');
    assert.equal(fields.status, 'recruiter_screen');
    assert.equal(fields.gmailMatch.manuallyResolved, true);
    assert.equal(fields.gmailAmbiguityResolution.action, 'attached');
    assert.equal(fields.gmailAmbiguityResolution.previousStatus, 'applied');
    assert.equal(fields.gmailAmbiguityResolution.detectedStatus, 'recruiter_screen');
    assert.equal(fields.gmailAmbiguityResolution.resolvedStatus, 'recruiter_screen');
    assert.equal(fields.gmailAmbiguityResolution.statusChanged, true);
  });
});

describe('Gmail quota safety', () => {
  it('routes broad-scan thread fetches and tracker searches through the throttle', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../gmail-sync.mjs', import.meta.url), 'utf8');
    assert.match(src, /throttledGmail\(\(\) => fetchThread\(gmail, threadId\)\)/);
    assert.match(src, /throttledGmail\(\(\) => findLatestThread\(gmail, job\.company(?:, candidate)?\)\)/);
    assert.doesNotMatch(src, /await fetchThread\(gmail, threadId\)/);
  });
});

describe('verifyLmStudio', () => {
  const models = ids => async () => ({ ok: true, json: async () => ({ data: ids.map(id => ({ id })) }) });

  it('passes when the analysis model is listed', async () => {
    await verifyLmStudio('m1', models(['m1', 'm2']));
  });

  it('stops with an actionable message when LM Studio is unreachable', async () => {
    await assert.rejects(
      verifyLmStudio('m1', async () => { throw new Error('fetch failed'); }),
      /LM Studio not reachable.*lms server start/,
    );
  });

  it('stops when the analysis model is not available', async () => {
    await assert.rejects(verifyLmStudio('m1', models(['other'])), /model "m1".*not available/);
  });

  it('never calls Anthropic for Gmail classification', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../gmail-sync.mjs', import.meta.url), 'utf8');
    assert.doesNotMatch(src, /@anthropic-ai\/sdk|messages\.create/);
  });
});

describe('LM Studio classification safety gate', () => {
  const email = (subject, bodyText, from = 'Jane Recruiter <jane@acme.com>') => ({ subject, bodyText, from });
  const review = (overrides, mail) => classificationReviewReasons({
    rawStatus: 'rejected', confidence: 'high', company: 'Acme', ...overrides,
  }, mail);

  it('allows an explicit rejection email', () => {
    const mail = email('Your application at Acme', 'We have decided to pursue other candidates for this position.');
    assert.deepEqual(review({}, mail), []);
  });

  it('recognizes common explicit rejection phrasings', () => {
    for (const body of [
      "Unfortunately, we have decided to move forward with candidates who more closely align with our needs.",
      "We have decided not to proceed with your candidacy.",
      "We've chosen to move forward with another candidate for this role.",
      "We've recently filled this position and aren't able to move you forward.",
      "We've decided it's not the right match for this particular role right now.",
      "We regret to inform you that the position has been filled.",
    ]) assert.deepEqual(review({}, email('Your application', body)), [], body);
  });

  it('flags ambiguous rejection wording', () => {
    const mail = email('Acme update', 'Unfortunately the hiring manager is out this week; we will follow up soon.');
    assert.match(review({}, mail).join(), /no explicit rejected wording/);
  });

  it('allows an explicit offer', () => {
    const mail = email('Offer from Acme', 'We are pleased to extend an offer for the Senior CSM role. Your offer letter is attached.');
    assert.deepEqual(review({ rawStatus: 'offer' }, mail), []);
  });

  it('flags ambiguous offer wording (someone else\'s offer in a newsletter)', () => {
    const mail = email(
      'From laid off to a Senior CSM offer at Acme',
      'Have you ever accepted a job offer out of desperation? Michael accepted a Senior CSM role at Acme.',
      'Career Coach <coach@coachsite.com>',
    );
    assert.match(review({ rawStatus: 'offer' }, mail).join(), /no explicit offer wording/);
  });

  it('rejects placeholder company and role output', () => {
    assert.equal(isUnusableExtractedValue('<unknown>'), true);
    assert.equal(isUnusableExtractedValue('<customer success manager or similar>'), true);
    assert.equal(isUnusableExtractedValue('<not specified>'), true);
    assert.equal(isUnusableExtractedValue('unknown'), true);
    assert.equal(isUnusableExtractedValue(''), true);
    assert.equal(isUnusableExtractedValue('Senior Customer Success Manager'), false);
    const mail = email('Thanks for applying', 'We received your application.');
    assert.match(review({ rawStatus: 'applied', company: '<unknown>' }, mail).join(), /placeholder or malformed/);
  });

  it('flags a questionable company from a social-feed notification', () => {
    const mail = email(
      'Brian, Jane Doe has a new post for you',
      'Jane Doe shared a post: we are hiring, contact me.',
      'LinkedIn <updates-noreply@linkedin.com>',
    );
    assert.match(review({ rawStatus: 'lead', company: 'Jane Doe' }, mail).join(), /notification address/);
  });

  it('flags a company that does not appear in the email', () => {
    const mail = email('Thanks for applying', 'We received your application.', 'no-reply@us.greenhouse-mail.io');
    assert.match(review({ rawStatus: 'applied', company: 'Globex' }, mail).join(), /does not appear/);
  });

  it('flags uncertain classification (low confidence or invalid status)', () => {
    const mail = email('Acme interview', 'Please pick an interview slot with Acme.');
    assert.match(review({ rawStatus: 'technical_screen', confidence: 'low' }, mail).join(), /confidence is "low"/);
    assert.match(review({ rawStatus: 'interview' }, mail).join(), /not an allowed value/);
  });

  it('never makes a destructive stage change from uncertain output', () => {
    // A withdrawal/offer/rejection must carry its own wording, even with high model confidence.
    const mail = email('Re: Acme next steps', 'Great news! We reviewed your application and would like to schedule time.');
    for (const rawStatus of ['rejected', 'withdrawn', 'offer']) {
      assert.ok(review({ rawStatus }, mail).length > 0, rawStatus);
    }
    const withdrawal = email('Re: Acme next steps', 'I recently accepted another position and will be withdrawing from the interview process.');
    assert.deepEqual(review({ rawStatus: 'withdrawn' }, withdrawal), []);
    assert.ok(review({ rawStatus: 'rejected' }, withdrawal).length > 0);
  });

  it('lists needs-review items in the review queue', () => {
    const queued = listAmbiguousGmailJobs([
      { thread_id: 'a', needsReview: true, gmailMatch: { ambiguous: false } },
      { thread_id: 'b', gmailMatch: { ambiguous: false } },
      { thread_id: 'c', needsReview: true, gmailMatch: {}, gmailResolution: { action: 'dismissed' } },
    ]);
    assert.deepEqual(queued.map(j => j.thread_id), ['a']);
  });
});

describe('archived requires explicit evidence', () => {
  const email = (subject, bodyText, from = 'Jane Recruiter <jane@acme.com>') => ({ subject, bodyText, from });
  const review = (overrides, mail) => classificationReviewReasons({
    rawStatus: 'archived', confidence: 'high', company: 'Acme', ...overrides,
  }, mail);

  it('allows explicit archive evidence (role closed/cancelled/on hold)', () => {
    for (const body of [
      'The Senior CSM position has been closed and we are no longer hiring for it.',
      'This requisition was cancelled due to a change in budget.',
      'We have put this role on hold indefinitely.',
      'Acme is no longer accepting applications for this position.',
    ]) assert.deepEqual(review({}, email('Update on your Acme application', body)), [], body);
  });

  it('flags ambiguous archive wording', () => {
    const mail = email('Acme update', 'We will keep your resume on file and reach out if anything changes. Hiring is slow this quarter.');
    assert.match(review({}, mail).join(), /no explicit archived wording/);
    const layoffStory = email('Elevate your value', 'After her position had been eliminated, Maria rebuilt her network.');
    assert.match(review({}, layoffStory).join(), /no explicit archived wording/);
  });

  it('flags a model "archived" with no archive evidence in the email', () => {
    const mail = email('Re: Acme next steps', 'Great news! We would like to schedule time to chat next week.');
    assert.match(review({}, mail).join(), /no explicit archived wording/);
  });

  it('sends uncertain archived classification to review', () => {
    const closed = email('Acme update', 'The position has been closed.');
    assert.match(review({ confidence: 'low' }, closed).join(), /confidence is "low"/);
  });

  it('keeps the stage unchanged and records a review when evidence is insufficient', () => {
    const job = { id: 'j1', company: 'Acme', title: 'CSM', status: 'applied' };
    const mail = email('Checking in', 'Hi Brian, just following up on our conversation.');
    const held = resolveTrackerSyncStatus(job, { status: 'archived', rawStatus: 'archived', confidence: 'high' }, mail);
    assert.equal(held.status, 'applied');
    assert.match(held.reviewReasons.join(), /no explicit archived wording/);

    const closed = email('Update on your Acme application', 'Hi Brian, This requisition has been cancelled.');
    const moved = resolveTrackerSyncStatus(job, { status: 'archived', rawStatus: 'archived', confidence: 'high' }, closed, { full_name: 'Brian Milhizer' });
    assert.equal(moved.status, 'archived');
    assert.deepEqual(moved.reviewReasons, []);
  });
});

describe('Gmail lifecycle transitions (Phase 1 stage + timeline)', () => {
  const applied = () => ({
    id: 'j1', company: 'Acme', title: 'CSM', status: 'applied', stage: 'applied',
    workflowTimeline: [{ type: 'applied', at: '2026-05-01T00:00:00.000Z', source: 'status', label: 'applied', note: '' }],
  });
  const meta = { messageKey: 'msg-123', subject: 'Your Acme application', date: '2026-08-27T17:16:16.000Z' };
  const emailFields = { last_email_subject: 'Your Acme application', status: 'applied' };

  it('Applied -> Rejected updates status and stage together', () => {
    const next = gmailJobMutator(emailFields, { from: 'applied', to: 'rejected', ...meta })(applied());
    assert.equal(next.status, 'rejected');
    assert.equal(next.stage, 'rejected');
    assert.equal(next.last_email_subject, 'Your Acme application');
  });

  it('Applied -> Withdrawn updates status and stage together', () => {
    const next = gmailJobMutator(emailFields, { from: 'applied', to: 'withdrawn', ...meta })(applied());
    assert.equal(next.status, 'withdrawn');
    assert.equal(next.stage, 'withdrawn');
    assert.ok(next.workflowTimeline.some(e => e.type === 'withdrawn' && e.source === 'gmail'));
  });

  it('records the transition in workflowTimeline with Gmail as the source and the previous state', () => {
    const next = gmailJobMutator(emailFields, { from: 'applied', to: 'rejected', ...meta })(applied());
    const event = next.workflowTimeline.find(e => e.type === 'stage_changed');
    assert.equal(event.source, 'gmail');
    assert.equal(event.label, 'gmail:msg-123');
    assert.equal(event.from, 'applied');
    assert.equal(event.to, 'rejected');
    assert.match(event.note, /Your Acme application/);
    assert.match(event.note, /previous status applied/);
  });

  it('keeps a precise legacy status whose stage matches (hiring_manager_screen -> interview)', () => {
    const next = gmailJobMutator(emailFields, { from: 'applied', to: 'hiring_manager_screen', ...meta })(applied());
    assert.equal(next.status, 'hiring_manager_screen');
    assert.equal(next.stage, 'interview');
  });

  it('does not duplicate history when the same Gmail message is processed again', () => {
    const once = gmailJobMutator(emailFields, { from: 'applied', to: 'rejected', ...meta })(applied());
    // Simulate a manual revert, then the same message arriving again.
    const reverted = { ...once, status: 'applied', stage: 'applied' };
    const twice = gmailJobMutator(emailFields, { from: 'applied', to: 'rejected', ...meta })(reverted);
    assert.equal(twice.workflowTimeline.filter(e => e.label === 'gmail:msg-123').length, 1);
    assert.equal(twice.status, 'applied');
    assert.equal(twice.stage, 'applied');
  });

  it('review/uncertain classification creates no lifecycle transition', () => {
    const job = applied();
    const mail = { subject: 'Checking in', bodyText: 'Just following up.', from: 'jane@acme.com' };
    const { status } = resolveTrackerSyncStatus(job, { status: 'rejected', rawStatus: 'rejected', confidence: 'high' }, mail);
    const next = gmailJobMutator(emailFields, { from: 'applied', to: status, ...meta })(job);
    assert.equal(next.status, 'applied');
    assert.equal(next.stage, 'applied');
    assert.deepEqual(next.workflowTimeline, job.workflowTimeline);
  });

  it('is pure: never mutates the stored job it is given', () => {
    const job = applied();
    const snapshot = structuredClone(job);
    gmailJobMutator(emailFields, { from: 'applied', to: 'rejected', ...meta })(job);
    assert.deepEqual(job, snapshot);
  });

  it('dry-run makes no tracker/lifecycle writes: every write in the sync paths is dry-run guarded', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../gmail-sync.mjs', import.meta.url), 'utf8');
    const body = src.slice(src.indexOf('export async function runGmailSync'), src.indexOf('export function loadGmailJobs'));
    const lines = body.split('\n');
    lines.forEach((line, i) => {
      if (!/\b(updateJob|createJob|writeJsonAtomic)\(/.test(line)) return;
      const guarded = /if \(!dryRun\)/.test(line) || /if \(!dryRun\) \{\s*$/.test(lines[i - 1] || '');
      assert.ok(guarded, `unguarded write: ${line.trim()}`);
    });
  });
});

describe('Gmail metadata-only writes do not bump date_updated', () => {
  const OLD = '2026-05-01T00:00:00.000Z';
  const stored = () => ({
    id: 'j1', company: 'Acme', title: 'CSM', status: 'rejected', stage: 'rejected', date_updated: OLD,
    last_email_subject: 'Thank you', last_email_date: '2026-04-30T12:00:00.000Z',
    gmailMatch: { confidence: 0.63, matchedBy: ['company', 'title'], ambiguous: false },
    workflowTimeline: [{ type: 'stage_changed', at: OLD, source: 'gmail', label: 'gmail:msg-1', note: '', from: 'applied', to: 'rejected' }],
  });
  // Mirrors what the sync paths pass: fresh metadata plus a same-day date_updated.
  const syncFields = (gmailMatch) => ({
    next_steps: '', last_email_subject: 'Thank you', last_email_date: '2026-04-30T12:00:00.000Z',
    gmailMatch, date_updated: new Date().toISOString().slice(0, 10),
  });
  const same = { from: 'rejected', to: 'rejected', messageKey: 'msg-1', subject: 'Thank you', date: '2026-04-30T12:00:00.000Z' };

  it('same status + same Gmail message leaves date_updated unchanged', () => {
    const next = gmailJobMutator(syncFields(stored().gmailMatch), same)(stored());
    assert.equal(next.date_updated, OLD);
  });

  it('same status + changed match confidence leaves date_updated unchanged', () => {
    const next = gmailJobMutator(syncFields({ confidence: 0.66, matchedBy: ['company', 'title'], ambiguous: false }), same)(stored());
    assert.equal(next.date_updated, OLD);
  });

  it('same status + changed matchedBy leaves date_updated unchanged', () => {
    const gm = { confidence: 0.63, matchedBy: ['company', 'title', 'loose_application_timing'], ambiguous: false };
    const next = gmailJobMutator(syncFields(gm), same)(stored());
    assert.equal(next.date_updated, OLD);
  });

  it('still stores refreshed Gmail metadata without touching freshness', () => {
    const gm = { confidence: 0.66, matchedBy: ['company', 'title', 'loose_application_timing'], ambiguous: false };
    const fields = { ...syncFields(gm), last_email_subject: 'Following up', next_steps: 'none' };
    const next = gmailJobMutator(fields, same)(stored());
    assert.deepEqual(next.gmailMatch, gm);
    assert.equal(next.last_email_subject, 'Following up');
    assert.equal(next.next_steps, 'none');
    assert.equal(next.date_updated, OLD);
    assert.deepEqual(next.workflowTimeline, stored().workflowTimeline);
  });

  it('a genuine lifecycle transition still updates date_updated via applyStageChange', () => {
    const applied = { ...stored(), status: 'applied', stage: 'applied', workflowTimeline: [] };
    const before = Date.now();
    const next = gmailJobMutator(syncFields(applied.gmailMatch), { ...same, from: 'applied', to: 'rejected', messageKey: 'msg-2' })(applied);
    assert.equal(next.stage, 'rejected');
    assert.match(next.date_updated, /^\d{4}-\d\d-\d\dT.*Z$/);
    assert.ok(Date.parse(next.date_updated) >= before);
    assert.equal(next.workflowTimeline.at(-1)?.at?.slice(0, 16), next.date_updated.slice(0, 16));
  });
});

describe('Gmail candidacy ownership gate', () => {
  const candidate = { full_name: 'Brian Milhizer', email: 'milhizer.brian@gmail.com' };
  const job = () => ({ id: 'j1', company: 'Acme', title: 'Senior CSM', status: 'applied' });
  const sync = (mail, status = 'rejected') =>
    resolveTrackerSyncStatus(job(), { status, rawStatus: status, confidence: 'high' }, mail, candidate);

  const atsRejection = {
    from: 'no-reply@us.greenhouse-mail.io',
    subject: 'Update on your application for Senior CSM at Acme',
    bodyText: 'Hi Brian, Thank you for your interest in the Senior CSM role at Acme. Unfortunately, we have decided to move forward with other candidates.',
  };
  const recruiterInterview = {
    from: 'Jane Recruiter <jane@acme.com>',
    subject: 'Acme interview invitation',
    bodyText: 'Hello Brian, We have reviewed your application and would like to schedule a phone screen with you next week.',
  };
  const newsletterRejection = {
    from: 'Career Coach <coach@coachsite.com>',
    listUnsubscribe: '<mailto:unsubscribe@coachsite.com>',
    subject: 'Rejected after 5 rounds at Acme',
    bodyText: 'Hi Brian, Sarah got the email every candidate dreads: "we have decided to pursue other candidates." Here is how she bounced back. Unsubscribe',
  };
  const newsletterOffer = {
    from: 'Career Coach <coach@coachsite.com>',
    subject: 'From laid off to a Senior CSM offer at Acme',
    bodyText: '͏ ͏ ͏ Here\'s how Michael did it. Michael was pleased to receive a formal offer from Acme. You can too.',
  };
  const coachingStory = {
    from: 'Coach Name <coach@coachname.com>',
    subject: 'How I landed my 160K CSM job',
    bodyText: 'It was luck... My final round interview with the hiring manager at Acme went long. View this email in your browser',
  };
  const marketing = {
    from: 'Acme Marketing <marketing@acme.com>',
    subject: 'Your offer letter is waiting: 20% off Acme Pro',
    bodyText: 'Hi Brian, this formal offer expires Friday. Your application of the discount is automatic. Manage your email preferences',
  };

  it('allows a direct ATS rejection concerning Brian\'s application', () => {
    assert.deepEqual(candidacyOwnershipReasons(atsRejection, candidate), []);
    assert.equal(sync(atsRejection).status, 'rejected');
  });

  it('allows direct recruiter/interview communication', () => {
    assert.deepEqual(candidacyOwnershipReasons(recruiterInterview, candidate), []);
    assert.equal(sync(recruiterInterview, 'recruiter_screen').status, 'recruiter_screen');
  });

  it('allows a direct thread Brian took part in even without application wording', () => {
    const mail = { from: 'Neil <neil@acme.com>', subject: 'Re: Acme next steps', bodyText: 'No problem, thanks Brian.', threadSenders: ['Brian Milhizer <milhizer.brian@gmail.com>', 'Neil <neil@acme.com>'] };
    assert.deepEqual(candidacyOwnershipReasons(mail, candidate), []);
  });

  for (const [name, mail, status] of [
    ['newsletter describing someone else\'s rejection', newsletterRejection, 'rejected'],
    ['newsletter describing someone else\'s offer', newsletterOffer, 'offer'],
    ['career-coaching success story', coachingStory, 'onsite'],
    ['marketing email containing job-status language', marketing, 'offer'],
  ]) {
    it(`blocks a ${name}`, () => {
      assert.match(candidacyOwnershipReasons(mail, candidate).join(), /candidacy ownership could not be established/);
      const result = sync(mail, status);
      assert.equal(result.status, 'applied');
      assert.match(result.reviewReasons.join(), /candidacy ownership/);
    });
  }

  it('sends uncertain ownership to review (direct-looking but no candidacy wording or name)', () => {
    const mail = { from: 'jane@acme.com', subject: 'Acme update', bodyText: 'We regret to inform you the role has been filled.' };
    const result = sync(mail);
    assert.equal(result.status, 'applied');
    assert.match(result.reviewReasons.join(), /candidacy ownership could not be established/);
  });

  it('fails closed when candidate identity is unavailable', () => {
    assert.match(candidacyOwnershipReasons(atsRejection, null).join(), /candidate identity/);
    const result = resolveTrackerSyncStatus(job(), { status: 'rejected', rawStatus: 'rejected', confidence: 'high' }, atsRejection);
    assert.equal(result.status, 'applied');
  });

  it('a third-party email cannot change stage through the lifecycle mutator', () => {
    const stored = { ...job(), stage: 'applied', workflowTimeline: [] };
    const { status } = sync(newsletterOffer, 'offer');
    const next = gmailJobMutator({}, { from: 'applied', to: status, messageKey: 'm1' })(stored);
    assert.equal(next.status, 'applied');
    assert.equal(next.stage, 'applied');
    assert.deepEqual(next.workflowTimeline, []);
  });

  it('legitimate direct email still changes stage when all other gates pass', () => {
    const stored = { ...job(), stage: 'applied', workflowTimeline: [] };
    const { status, reviewReasons } = sync(atsRejection);
    assert.deepEqual(reviewReasons, []);
    const next = gmailJobMutator({}, { from: 'applied', to: status, messageKey: 'm2' })(stored);
    assert.equal(next.status, 'rejected');
    assert.equal(next.stage, 'rejected');
  });

  it('other gates still apply to a direct email (evidence gate unchanged)', () => {
    const vague = { ...atsRejection, bodyText: 'Hi Brian, thank you for your application. We will follow up soon.' };
    assert.match(sync(vague).reviewReasons.join(), /no explicit rejected wording/);
    assert.equal(sync(vague).status, 'applied');
  });

  it('does not require ownership for pre-application statuses (recruiter outreach leads)', () => {
    const inmail = { from: 'Jane <inmail-hit-reply@linkedin.com>', subject: 'Opportunity at Acme', bodyText: 'Hi Brian, would you be open to a chat?' };
    assert.deepEqual(candidacyOwnershipReasons(inmail, candidate, 'lead'), []);
  });
});

describe('Gmail candidate message selection (profile identity)', () => {
  const candidate = { full_name: 'Pat Example', email: 'pat.example@mail.test' };
  const msg = (id, from) => ({ id, payload: { headers: [{ name: 'From', value: from }] } });
  const thread = (...messages) => ({ data: { messages } });

  it('recognizes the profile email as the candidate\'s own message', () => {
    assert.equal(isCandidateSender('Someone <PAT.EXAMPLE@mail.test>', candidate), true);
    assert.equal(isCandidateSender('pat.example@mail.test', candidate), true);
    const t = thread(msg('r', 'Recruiter <r@acme.com>'), msg('me', 'Whatever Name <pat.example@mail.test>'));
    assert.equal(getBestMessage(t, candidate).id, 'r');
  });

  it('recognizes the profile full name as the sender display name', () => {
    assert.equal(isCandidateSender('"Pat Example" <other@elsewhere.test>', candidate), true);
    const t = thread(msg('r', 'Recruiter <r@acme.com>'), msg('me', 'Pat Example <work@elsewhere.test>'));
    assert.equal(getBestMessage(t, candidate).id, 'r');
  });

  it('does not treat an unrelated sender as the candidate', () => {
    for (const from of ['Recruiter <r@acme.com>', 'Pat Examples Team <jobs@acme.com>', 'xpat.example@mail.test.evil.io']) {
      assert.equal(isCandidateSender(from, candidate), false, from);
    }
    const t = thread(msg('a', 'Recruiter <r@acme.com>'), msg('b', 'Hiring <h@acme.com>'));
    assert.equal(getBestMessage(t, candidate).id, 'b');
  });

  it('falls back to the first message when every message is the candidate\'s', () => {
    const t = thread(msg('m1', 'Pat Example <pat.example@mail.test>'), msg('m2', 'pat.example@mail.test'));
    assert.equal(getBestMessage(t, candidate).id, 'm1');
  });

  it('fails safely when candidate identity is missing or invalid', () => {
    const t = thread(msg('r', 'Recruiter <r@acme.com>'));
    for (const bad of [null, {}, { full_name: '', email: 'not-an-email' }, { full_name: ' ' }]) {
      assert.equal(isCandidateSender('Recruiter <r@acme.com>', bad), false);
      assert.equal(getBestMessage(t, bad), null, JSON.stringify(bad));
    }
  });

  it('keeps no hardcoded candidate identity in Gmail logic', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../gmail-sync.mjs', import.meta.url), 'utf8')
      .split('\n').filter(line => !/^\s*(?:\/\/|\*)/.test(line)).join('\n');
    assert.doesNotMatch(src, /milhizer|bmilhizer|brian/i);
  });
});

describe('stored gmailMatch never embeds the Opportunity', () => {
  const trackerJob = { id: 'j1', company: 'Acme', title: 'Senior CSM', full_description: 'x'.repeat(5000), status: 'applied' };

  it('keeps only match metadata from a matcher result', () => {
    const match = matchGmailEventToTracker(event({ company: 'Acme', role: 'Senior CSM', from: 'jane@acme.com' }), [trackerJob]);
    assert.ok(match.job, 'fixture should produce a confident match');
    const stored = storedGmailMatch(match);
    assert.equal('job' in stored, false);
    assert.equal('candidates' in stored, false);
    assert.deepEqual(Object.keys(stored).sort(), ['ambiguous', 'confidence', 'matchedBy']);
    assert.equal(stored.confidence, match.confidence);
  });

  it('review-queue attach does not carry an embedded job from an old gmail-jobs.json entry', () => {
    const legacyEvent = {
      thread_id: 't1', status: 'rejected', company: 'Acme',
      gmailMatch: { job: trackerJob, ambiguous: true, confidence: 0.5, matchedBy: ['company'] },
    };
    const fields = buildGmailAttachFields(legacyEvent, trackerJob, '2026-09-27T00:00:00.000Z');
    assert.equal('job' in fields.gmailMatch, false);
    assert.equal(fields.gmailMatch.confidence, 0.5);
    assert.deepEqual(fields.gmailMatch.matchedBy, ['company']);
    assert.equal(fields.gmailMatch.manuallyResolved, true);
    assert.equal(fields.gmailMatch.resolvedJobId, 'j1');
  });

  it('every gmailMatch written by the sync paths goes through storedGmailMatch or explicit fields', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../gmail-sync.mjs', import.meta.url), 'utf8');
    assert.doesNotMatch(src, /\.\.\.gmailMatch\b|\.\.\.\(event\.gmailMatch/);
    assert.doesNotMatch(src, /const \{ candidates, \.\.\./);
  });
});

describe('subject-title matching (full contiguous title phrase in subject)', () => {
  const harmonic = (overrides = {}) => ({
    id: 'li-4418401660', company: 'Harmonic Security', title: 'Customer Success Manager',
    url: 'https://www.linkedin.com/jobs/view/4418401660', date_found: '2026-05-24', date_updated: '2026-05-25',
    status: 'applied', ...overrides,
  });
  const ashbyJobs = [
    { id: 'ab-1', company: 'Ashby', title: 'Strategic Customer Success Manager - Americas', date_found: '2026-05-20', date_updated: '2026-05-20', status: 'lead' },
    { id: 'ab-2', company: 'Ashby', title: 'Mid-Market Customer Success Manager - America', date_found: '2026-05-20', date_updated: '2026-05-20', status: 'lead' },
  ];
  const rejection = (overrides = {}) => ({
    company: 'Harmonic Security, Inc',
    role: '',
    status: 'rejected',
    from: '"Harmonic Security, Inc Hiring Team" <no-reply@ashbyhq.com>',
    last_email_subject: 'Customer Success Manager Application Update',
    last_email_date: '2026-06-22T15:41:39.000Z',
    last_email_snippet: 'Hi Brian, Thank you so much for your interest in Harmonic Security. We were genuinely excited to see your application come through. We wanted to let you know that an actual human (promise!) reviewed',
    ...overrides,
  });
  // Scores a subject against a job whose company is a genuine match, isolating the title rule.
  const titleCredit = (title, subject) => {
    const m = matchGmailEventToTracker(
      rejection({ last_email_subject: subject, last_email_snippet: '' }),
      [harmonic({ title })],
    );
    return m.matchedBy.includes('thread_subject') || m.matchedBy.includes('title');
  };

  it('matches Harmonic when the model extracted the role', () => {
    const m = matchGmailEventToTracker(rejection({ role: 'Customer Success Manager' }), [harmonic(), ...ashbyJobs]);
    assert.equal(m.job?.id, 'li-4418401660');
    assert.equal(m.confidence, 0.66);
    assert.equal(m.ambiguous, false);
  });

  it('matches Harmonic identically when the model role is empty', () => {
    const m = matchGmailEventToTracker(rejection({ role: '' }), [harmonic(), ...ashbyJobs]);
    assert.equal(m.job?.id, 'li-4418401660');
    assert.equal(m.confidence, 0.66);
    assert.deepEqual(m.matchedBy, ['company', 'thread_subject', 'loose_application_timing']);
    assert.equal(m.ambiguous, false);
  });

  for (const title of ['Manager', 'Director', 'CSM', 'Customer Success']) {
    it(`"${title}" gets no subject-title credit (fewer than 3 meaningful words)`, () => {
      assert.equal(titleCredit(title, `${title} Application Update`), false);
    });
  }

  it('scattered, non-contiguous title words get no full-title credit', () => {
    assert.equal(titleCredit('Customer Success Manager', 'Manager update: Customer Success application'), false);
    assert.equal(titleCredit('Customer Success Manager', 'Customer Success Manager Application Update'), true);
  });

  it('only the subject counts: the title in the snippet/body gives no full-title credit', () => {
    const m = matchGmailEventToTracker(
      rejection({ last_email_subject: 'Application Update', last_email_snippet: 'Thanks for applying to Customer Success Manager', bodyText: 'Customer Success Manager' }),
      [harmonic()],
    );
    assert.equal(m.job, null);
    assert.ok(!m.matchedBy.includes('thread_subject'));
  });

  it('same-company duplicate titles stay ambiguous', () => {
    const m = matchGmailEventToTracker(rejection(), [harmonic(), harmonic({ id: 'li-dup', date_found: '2026-05-26', date_updated: '2026-05-26' })]);
    assert.equal(m.job, null);
    assert.equal(m.ambiguous, true);
  });

  it('an ATS sender domain cannot masquerade as company evidence for subject-title credit', () => {
    const ashbyCsm = { id: 'ab-csm', company: 'Ashby', title: 'Customer Success Manager', date_found: '2026-05-24', date_updated: '2026-05-25', status: 'applied' };
    const m = matchGmailEventToTracker(rejection(), [ashbyCsm]);
    assert.equal(m.job, null);
    assert.ok(!m.matchedBy.includes('thread_subject'));
    assert.ok(m.confidence < 0.62);
  });

  it('a different-company Opportunity with the same title does not match just because both use the same ATS', () => {
    const acme = { id: 'acme-csm', company: 'Acme Corp', title: 'Customer Success Manager', url: 'https://jobs.ashbyhq.com/acme/1', date_found: '2026-05-24', date_updated: '2026-05-25', status: 'applied' };
    const m = matchGmailEventToTracker(rejection(), [acme]);
    assert.equal(m.job, null);
    assert.ok(!m.matchedBy.includes('thread_subject'));
    assert.ok(m.confidence < 0.62);
  });
});

describe('tracker pass ignores bulk/notification mail (never candidacy metadata)', () => {
  const opp = (company, title, extra = {}) => ({
    id: `id-${company}`, company, title, status: 'lead', date_found: '2026-05-20', date_updated: '2026-05-20',
    url: 'https://www.linkedin.com/jobs/view/1', ...extra,
  });
  const UNSUB = '<https://www.linkedin.com/unsubscribe>';
  const PAD = '͏ ͏ ͏';

  const falsePositives = [
    ['Automation Anywhere (LinkedIn jobs picked for you)', opp('Automation Anywhere', 'Customer Success Manager', { url: 'https://www.linkedin.com/jobs/view/4432446633' }),
      { from: 'LinkedIn <jobs-noreply@linkedin.com>', subject: 'Customer Success Manager at Automation Anywhere', date: '2026-08-07T19:58:01.000Z',
        snippet: `View jobs picked for you ${PAD}`, bodyText: 'Customer Success Manager Automation Anywhere Dallas County View job: https://www.linkedin.com/comm/jobs/view/4432446633', listUnsubscribe: UNSUB }],
    ['HiddenLayer (Glassdoor digest, company absent)', opp('HiddenLayer', 'Customer Success Manager', { date_found: '2026-05-25', date_updated: '2026-05-25' }),
      { from: 'Glassdoor Jobs <noreply@glassdoor.com>', subject: 'Customer Success Manager at Fullpath and 11 more jobs in Remote, US for you. Apply Now.', date: '2026-06-01T21:49:20.000Z',
        snippet: 'Thrive Global is hiring', bodyText: '', listUnsubscribe: '<mailto:unsubscribe@glassdoor.com>' }],
    ['7AI (saved-job expiry reminder)', opp('7AI', 'Sr. Sales Engineer – Service Providers', { url: 'https://www.linkedin.com/jobs/view/4390042645', date_found: '2026-05-15', date_updated: '2026-05-15' }),
      { from: 'LinkedIn <jobs-noreply@linkedin.com>', subject: 'Brian, your job’s expiring on May 21: Sr. Sales Engineer – Service Providers at 7AI', date: '2026-05-16T17:55:29.000Z',
        snippet: `Apply to your saved jobs. ${PAD}`, bodyText: 'Your saved job at 7AI is still available. Sr. Sales Engineer – Service Providers 7AI United States', listUnsubscribe: UNSUB }],
    ['Cyrusone (saved-search job alert)', opp('Cyrusone', 'Customer Experience Director', { url: 'https://cyrusone.wd1.myworkdayjobs.com/job/R0007166' }),
      { from: 'LinkedIn Job Alerts <jobalerts-noreply@linkedin.com>', subject: '“Enterprise Customer Success…”: CyrusOne - Customer Experience Director posted on 7/18/26', date: '2026-07-19T15:39:55.000Z',
        snippet: `View jobs in Dallas-Fort Worth Metroplex ${PAD}`, bodyText: '1 new job matches your preferences. Customer Experience Director CyrusOne Dallas, TX', listUnsubscribe: UNSUB }],
    ['LaunchDarkly (job-board new-match alert, different posting)', opp('LaunchDarkly', 'Senior Customer Success Manager', { status: 'applied', url: 'https://app.welcometothejungle.com/jobs/DQ7FFFcy' }),
      { from: 'Welcome to the Jungle <help@welcometothejungle.com>', subject: 'New match: Senior Digital Customer Success Manager at LaunchDarkly', date: '2026-09-26T13:52:02.000Z',
        snippet: 'There are new jobs matching your search preferences, Brian! LaunchDarkly Senior Digital Customer Success Manager (Americas)', bodyText: '', listUnsubscribe: '<https://welcometothejungle.com/unsubscribe>' }],
    ['Rapid7 (LinkedIn social notification)', opp('Rapid7', 'Senior Director, Customer Success', { url: 'https://www.linkedin.com/jobs/view/4394484553' }),
      { from: 'LinkedIn <updates-noreply@linkedin.com>', subject: 'Aakash Kumar - Director of AI Customer Success reacted to this post: I am excited  to share that…', date: '2026-09-17T09:44:29.000Z',
        snippet: `I am excited to share that… ${PAD}`, bodyText: 'Aakash Kumar reacted to this post', listUnsubscribe: UNSUB }],
    ['Placer.ai (similar-jobs recommendation)', opp('Placer.ai', 'Director of Customer Success Operations', { status: 'applied', url: 'https://www.linkedin.com/jobs/view/4399404849', date_found: '2026-05-15', date_updated: '2026-05-15' }),
      { from: 'LinkedIn <jobs-noreply@linkedin.com>', subject: 'New jobs similar to Director, Customer Success Operations at Jobgether', date: '2026-05-20T23:39:45.000Z',
        snippet: `Jobs similar to Director, Customer Success Operations at Jobgether ${PAD}`, bodyText: 'Director of Customer Success Operations Placer.ai United States View job: https://www.linkedin.com/comm/jobs/view/4399404849', listUnsubscribe: UNSUB }],
  ];

  for (const [name, job, email] of falsePositives) {
    it(`blocks ${name}`, () => {
      const m = matchTrackerPassEmail(job, email);
      assert.equal(m.job, null);
      assert.equal(m.bulk, true);
    });
  }

  it('still matches the Harmonic Ashby rejection (ATS senders are never bulk)', () => {
    const job = opp('Harmonic Security', 'Customer Success Manager', { status: 'applied', date_found: '2026-05-24', date_updated: '2026-05-25' });
    const m = matchTrackerPassEmail(job, {
      from: '"Harmonic Security, Inc Hiring Team" <no-reply@ashbyhq.com>', subject: 'Customer Success Manager Application Update', date: '2026-06-22T15:41:39.000Z',
      snippet: 'Hi Brian, Thank you so much for your interest in Harmonic Security.', bodyText: 'Hi Brian, Thank you so much for your interest in Harmonic Security. Unsubscribe', listUnsubscribe: '',
    });
    assert.equal(m.job?.id, job.id);
    assert.ok(m.matchedBy.includes('thread_subject'));
  });

  it('still matches Nebulock\'s genuine recruiter thread', () => {
    const job = opp('Nebulock', 'Customer Success Manager', { status: 'withdrawn', url: 'https://www.linkedin.com/jobs/view/4413334763', date_found: '2026-05-20', date_updated: '2026-05-28' });
    const m = matchTrackerPassEmail(job, {
      from: 'Neil Heffernan <neil@nebulock.io>', subject: 'Re: Nebulock - Customer Success Manager - Next Steps', date: '2026-06-02T18:42:09.000Z',
      snippet: 'No problem thank you Brian and congrats on the new role!', bodyText: 'I wish you and the team at Nebulock continued success as you grow.', listUnsubscribe: '',
      threadSenders: ['Neil Heffernan <neil@nebulock.io>', 'Brian Milhizer <milhizer.brian@gmail.com>'],
    });
    assert.equal(m.job?.id, job.id);
    assert.ok(!m.bulk);
  });
});

describe('self-sent job-search digests are never candidacy communication', () => {
  const candidate = { full_name: 'Pat Example', email: 'pat.example@mail.test' };
  const msg = (id, from, to, extra = {}) => ({ id, snippet: extra.snippet || '', payload: { headers: [
    { name: 'From', value: from }, { name: 'To', value: to }, { name: 'Subject', value: extra.subject || '' },
  ] } });
  const thread = (...messages) => ({ data: { messages } });
  const ME = 'Pat Example <pat.example@mail.test>';

  it('blocks a self-sent digest containing an exact job URL (Alteryx/Rhymetec pattern)', () => {
    const t = thread(msg('d1', ME, 'pat.example@mail.test', {
      subject: 'Job updates - 9am/5pm check', snippet: 'Alteryx https://www.linkedin.com/jobs/view/4413197442 Rhymetec https://www.linkedin.com/jobs/view/4419508175',
    }));
    assert.equal(getBestMessage(t, candidate), null);
  });

  it('blocks a self-sent digest naming a company and title', () => {
    const t = thread(msg('d2', 'pat.example@mail.test', 'Pat Example <PAT.EXAMPLE@mail.test>', { subject: 'Notes: Customer Success Manager at Acme' }));
    assert.equal(getBestMessage(t, candidate), null);
  });

  it('allows a genuine inbound recruiter email', () => {
    const t = thread(msg('r1', 'Jane Recruiter <jane@acme.com>', ME, { subject: 'Acme - Customer Success Manager - Next Steps' }));
    assert.equal(getBestMessage(t, candidate).id, 'r1');
  });

  it('keeps the recruiter message usable in a thread with the candidate\'s outbound reply', () => {
    const t = thread(
      msg('r1', 'Jane Recruiter <jane@acme.com>', ME, { subject: 'Acme - Next Steps' }),
      msg('me', ME, 'Jane Recruiter <jane@acme.com>', { subject: 'Re: Acme - Next Steps' }),
    );
    assert.equal(getBestMessage(t, candidate).id, 'r1');
  });

  it('still falls back to an outbound-only message addressed to someone else', () => {
    const t = thread(msg('o1', ME, 'Jane Recruiter <jane@acme.com>', { subject: 'Application: Customer Success Manager' }));
    assert.equal(getBestMessage(t, candidate).id, 'o1');
  });

  it('the Alteryx/Rhymetec self-digest can therefore never reach the tracker-pass matcher', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../gmail-sync.mjs', import.meta.url), 'utf8');
    const fn = src.slice(src.indexOf('async function findLatestThread'), src.indexOf('// Quota-exhaustion fix'));
    assert.match(fn, /const msg = getBestMessage\(thread, candidate\);\s*if \(!msg\) return null;/);
  });
});
