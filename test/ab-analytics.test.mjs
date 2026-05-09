import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildAbAnalytics, normalizeVariant } from '../lib/ab-analytics.mjs';

describe('normalizeVariant', () => {
  it('accepts A/B aliases', () => {
    assert.equal(normalizeVariant('A'), 'technical');
    assert.equal(normalizeVariant('business-outcomes'), 'outcomes');
  });
});

describe('buildAbAnalytics', () => {
  it('calculates interview yield by narrative variant', () => {
    const jobs = [
      { id: 'one', company: 'Acme', title: 'CSM', status: 'Interview' },
      { id: 'two', company: 'Beta', title: 'CSM', status: 'Applied' },
      { id: 'three', company: 'Core', title: 'CSM', status: 'Offer' },
    ];
    const submissions = [
      { jobId: 'one', variant: 'technical', submittedAt: '2026-04-01T00:00:00.000Z' },
      { jobId: 'two', variant: 'technical', submittedAt: '2026-04-02T00:00:00.000Z' },
      { jobId: 'three', variant: 'outcomes', submittedAt: '2026-04-03T00:00:00.000Z' },
    ];

    const analytics = buildAbAnalytics(jobs, submissions);
    assert.equal(analytics.variants.technical.submitted, 2);
    assert.equal(analytics.variants.technical.interviews, 1);
    assert.equal(analytics.variants.technical.yieldRate, 50);
    assert.equal(analytics.variants.outcomes.yieldRate, 100);
  });
});
