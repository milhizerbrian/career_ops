import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  getRecruiterTargeting,
  buildRecruiterAnalytics,
  statusLabel,
  DEFAULT_TARGETING,
  VALID_STATUSES,
} from '../lib/recruiter-targeting.mjs';

// ── getRecruiterTargeting ─────────────────────────────────────────────────────

describe('getRecruiterTargeting — defaults', () => {
  it('returns all default fields for a bare job', () => {
    const result = getRecruiterTargeting({ company: 'Acme' });
    for (const [k, v] of Object.entries(DEFAULT_TARGETING)) {
      assert.deepEqual(result[k], v, `field "${k}" should equal default`);
    }
  });

  it('merges stored values over defaults', () => {
    const job = {
      recruiterTargeting: {
        recruiterName: 'Jane Recruiter',
        responseStatus: 'sent',
      },
    };
    const result = getRecruiterTargeting(job);
    assert.equal(result.recruiterName, 'Jane Recruiter');
    assert.equal(result.responseStatus, 'sent');
    assert.equal(result.recruiterTitle, ''); // default
    assert.deepEqual(result.contactAttempts, []); // default
  });

  it('forces contactAttempts to array when stored value is not an array', () => {
    const job = { recruiterTargeting: { contactAttempts: null } };
    const result = getRecruiterTargeting(job);
    assert.ok(Array.isArray(result.contactAttempts));
    assert.equal(result.contactAttempts.length, 0);
  });

  it('preserves stored contactAttempts', () => {
    const attempt = { date: '2026-04-27', channel: 'LinkedIn', contactName: 'Jane', message: 'Hi', status: 'sent' };
    const job = { recruiterTargeting: { contactAttempts: [attempt] } };
    const result = getRecruiterTargeting(job);
    assert.equal(result.contactAttempts.length, 1);
    assert.deepEqual(result.contactAttempts[0], attempt);
  });

  it('resets invalid responseStatus to not_contacted', () => {
    const job = { recruiterTargeting: { responseStatus: 'gibberish_value' } };
    const result = getRecruiterTargeting(job);
    assert.equal(result.responseStatus, 'not_contacted');
  });

  it('all VALID_STATUSES pass through unchanged', () => {
    for (const status of VALID_STATUSES) {
      const result = getRecruiterTargeting({ recruiterTargeting: { responseStatus: status } });
      assert.equal(result.responseStatus, status, `status "${status}" should pass through`);
    }
  });
});

// ── statusLabel ───────────────────────────────────────────────────────────────

describe('statusLabel', () => {
  it('returns human-readable label for known statuses', () => {
    assert.equal(statusLabel('not_contacted'),   'Not Contacted');
    assert.equal(statusLabel('message_drafted'), 'Message Drafted');
    assert.equal(statusLabel('sent'),            'Sent');
    assert.equal(statusLabel('responded'),       'Responded');
    assert.equal(statusLabel('no_response'),     'No Response');
    assert.equal(statusLabel('follow_up_due'),   'Follow-Up Due');
    assert.equal(statusLabel('referral_received'), 'Referral Received');
  });

  it('returns raw value for unknown status', () => {
    assert.equal(statusLabel('custom_status'), 'custom_status');
  });
});

// ── buildRecruiterAnalytics ───────────────────────────────────────────────────

describe('buildRecruiterAnalytics — empty', () => {
  it('returns all zeros for empty job list', () => {
    const result = buildRecruiterAnalytics([]);
    assert.equal(result.contacted, 0);
    assert.equal(result.notContacted, 0);
    assert.equal(result.totalAttempts, 0);
    assert.equal(result.responded, 0);
    assert.equal(result.responseRate, 0);
    assert.equal(result.followUpsDue, 0);
    assert.equal(result.messagesDrafted, 0);
  });
});

describe('buildRecruiterAnalytics — basic counts', () => {
  it('counts not_contacted correctly', () => {
    const jobs = [
      { recruiterTargeting: { responseStatus: 'not_contacted', contactAttempts: [] } },
      { recruiterTargeting: { responseStatus: 'not_contacted', contactAttempts: [] } },
    ];
    const r = buildRecruiterAnalytics(jobs);
    assert.equal(r.notContacted, 2);
    assert.equal(r.contacted, 0);
  });

  it('counts message_drafted as contacted', () => {
    const jobs = [
      { recruiterTargeting: { responseStatus: 'message_drafted', contactAttempts: [] } },
    ];
    const r = buildRecruiterAnalytics(jobs);
    assert.equal(r.contacted, 1);
    assert.equal(r.messagesDrafted, 1);
    assert.equal(r.notContacted, 0);
  });

  it('counts responded jobs correctly', () => {
    const jobs = [
      { recruiterTargeting: { responseStatus: 'responded', contactAttempts: [{}] } },
      { recruiterTargeting: { responseStatus: 'sent', contactAttempts: [{}] } },
      { recruiterTargeting: { responseStatus: 'not_contacted', contactAttempts: [] } },
    ];
    const r = buildRecruiterAnalytics(jobs);
    assert.equal(r.responded, 1);
    assert.equal(r.contacted, 2);
    assert.equal(r.notContacted, 1);
    assert.equal(r.totalAttempts, 2);
  });

  it('counts referral_received as a response', () => {
    const jobs = [
      { recruiterTargeting: { responseStatus: 'referral_received', contactAttempts: [{}] } },
    ];
    const r = buildRecruiterAnalytics(jobs);
    assert.equal(r.responded, 1);
    assert.equal(r.contacted, 1);
  });

  it('counts follow_up_due correctly', () => {
    const jobs = [
      { recruiterTargeting: { responseStatus: 'follow_up_due', contactAttempts: [{}] } },
      { recruiterTargeting: { responseStatus: 'follow_up_due', contactAttempts: [{}] } },
    ];
    const r = buildRecruiterAnalytics(jobs);
    assert.equal(r.followUpsDue, 2);
    assert.equal(r.contacted, 2);
    assert.equal(r.responded, 0);
  });

  it('calculates responseRate as responded/contacted * 100', () => {
    const jobs = [
      { recruiterTargeting: { responseStatus: 'responded',     contactAttempts: [] } },
      { recruiterTargeting: { responseStatus: 'responded',     contactAttempts: [] } },
      { recruiterTargeting: { responseStatus: 'sent',          contactAttempts: [] } },
      { recruiterTargeting: { responseStatus: 'not_contacted', contactAttempts: [] } },
    ];
    const r = buildRecruiterAnalytics(jobs);
    // 2 responded out of 3 contacted = 67%
    assert.equal(r.responded, 2);
    assert.equal(r.contacted, 3);
    assert.equal(r.responseRate, 67);
  });

  it('responseRate is 0 when none contacted', () => {
    const jobs = [
      { recruiterTargeting: { responseStatus: 'not_contacted', contactAttempts: [] } },
    ];
    const r = buildRecruiterAnalytics(jobs);
    assert.equal(r.responseRate, 0);
  });

  it('sums contactAttempts across all jobs', () => {
    const jobs = [
      { recruiterTargeting: { responseStatus: 'sent', contactAttempts: [{}, {}] } },
      { recruiterTargeting: { responseStatus: 'sent', contactAttempts: [{}] } },
    ];
    const r = buildRecruiterAnalytics(jobs);
    assert.equal(r.totalAttempts, 3);
  });

  it('handles jobs without recruiterTargeting field', () => {
    const jobs = [
      { company: 'Acme', title: 'CSM' },
      { company: 'Beta', title: 'SE', recruiterTargeting: { responseStatus: 'sent', contactAttempts: [{}] } },
    ];
    const r = buildRecruiterAnalytics(jobs);
    assert.equal(r.notContacted, 1);
    assert.equal(r.contacted, 1);
    assert.equal(r.totalAttempts, 1);
  });
});
