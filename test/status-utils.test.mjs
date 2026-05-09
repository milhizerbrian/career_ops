import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isInterviewStatus, normalizeStatus, statusLabel } from '../lib/status-utils.mjs';

describe('status-utils', () => {
  it('normalizes legacy and case variants to canonical statuses', () => {
    assert.equal(normalizeStatus('Lead'), 'lead');
    assert.equal(normalizeStatus('new'), 'lead');
    assert.equal(normalizeStatus('phone_screen'), 'recruiter_screen');
    assert.equal(normalizeStatus('hm screen'), 'hiring_manager_screen');
    assert.equal(normalizeStatus('Technical Interview'), 'technical_screen');
    assert.equal(normalizeStatus('Closed'), 'archived');
    assert.equal(normalizeStatus('not sure yet'), 'lead');
  });

  it('detects interview-stage statuses', () => {
    assert.equal(isInterviewStatus('recruiter_screen'), true);
    assert.equal(isInterviewStatus('hm screen'), true);
    assert.equal(isInterviewStatus('onsite'), true);
    assert.equal(isInterviewStatus('applied'), false);
    assert.equal(isInterviewStatus('offer'), false);
  });

  it('returns human-readable labels', () => {
    assert.equal(statusLabel('hiring_manager_screen'), 'Hiring Manager Screen');
    assert.equal(statusLabel('phone_screen'), 'Recruiter Screen');
  });
});
