import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildOutcomeLearningModel,
  computeContactIntelligence,
  computeDecisionMakerAccess,
  computeJobSearchPriority,
  computeOutcomeLearningScore,
  computeStaleDuplicateRisk,
} from '../lib/job-search-scoring.mjs';

describe('decision-maker access scoring', () => {
  it('boosts jobs with hiring-manager contact and warm path', () => {
    const access = computeDecisionMakerAccess({
      recruiterTargeting: {
        hiringManagerName: 'Avery Chen',
        hiringManagerTitle: 'VP Customer Success',
        hiringManagerLinkedInUrl: 'https://linkedin.com/in/avery',
        bestConnectionPath: 'Warm intro through former colleague',
        responseStatus: 'message_drafted',
      },
    });

    assert.ok(access.score >= 70, `Expected strong access score, got ${access.score}`);
    assert.equal(access.hasHiringManager, true);
    assert.equal(access.hasWarmPath, true);
  });
});

describe('contact intelligence scoring', () => {
  it('scores senior relevant contacts by influence and response likelihood', () => {
    const score = computeContactIntelligence({
      name: 'Avery Chen',
      title: 'VP Customer Success',
      company: 'Acme',
      relationshipType: 'hiring_manager',
      responseStatus: 'responded',
      linkedinUrl: 'https://linkedin.com/in/avery',
    }, {
      company: 'Acme',
      title: 'Director Customer Success',
    });

    assert.ok(score.score >= 80, `Expected high contact intelligence, got ${score.score}`);
    assert.equal(score.canInfluenceHiring, true);
    assert.ok(score.reasons.includes('senior decision-maker'));
  });
});

describe('stale and duplicate risk scoring', () => {
  it('penalizes old possible duplicate postings', () => {
    const now = new Date('2026-05-28T12:00:00.000Z');
    const job = {
      id: 'new',
      company: 'Acme Security',
      title: 'Senior Customer Success Manager',
      location: 'Remote',
      date_found: '2026-03-01',
      date_updated: '2026-03-15',
      status: 'lead',
    };
    const existing = {
      id: 'old',
      company: 'Acme Security',
      title: 'Sr. Customer Success Mgr',
      location: 'Remote',
    };

    const risk = computeStaleDuplicateRisk(job, [existing], { now });

    assert.ok(risk.risk >= 50, `Expected high risk, got ${risk.risk}`);
    assert.ok(risk.reasons.includes('older-than-60-days'));
    assert.ok(risk.reasons.includes('stale-lead'));
    assert.ok(risk.duplicate.isPossibleDuplicate || risk.duplicate.isDuplicate);
  });
});

describe('outcome learning', () => {
  const jobs = [
    { id: 'a', company: 'Acme', title: 'Customer Success Manager', source: 'linkedin', status: 'recruiter_screen' },
    { id: 'b', company: 'Acme', title: 'Senior Customer Success Manager', source: 'linkedin', status: 'hiring_manager_screen' },
    { id: 'c', company: 'Beta', title: 'Customer Success Manager', source: 'linkedin', status: 'rejected' },
  ];

  it('builds reusable outcome aggregates by source, company, and title family', () => {
    const model = buildOutcomeLearningModel(jobs);

    assert.equal(model.company.acme.count, 2);
    assert.ok(model.company.acme.averageOutcome >= 80);
    assert.equal(model.titleFamily.customer_success.count, 3);
  });

  it('scores new jobs from historical conversion patterns', () => {
    const score = computeOutcomeLearningScore({
      company: 'Acme',
      title: 'Director Customer Success',
      source: 'linkedin',
    }, jobs);

    assert.ok(score.score > 50, `Expected positive outcome learning, got ${score.score}`);
  });
});

describe('combined job search priority', () => {
  it('separates interview fit, opportunity quality, access, freshness, and outcomes', () => {
    const now = new Date('2026-05-28T12:00:00.000Z');
    const job = {
      id: 'target',
      company: 'Acme',
      title: 'Senior Customer Success Manager',
      source: 'linkedin',
      status: 'lead',
      score: 4.4,
      date_found: '2026-05-25',
      full_description: 'Series C company with rapid growth, Gartner recognition, Fortune 500 customers, expanding our team, and a great place to work culture.',
      recruiterTargeting: {
        hiringManagerName: 'Avery Chen',
        hiringManagerTitle: 'VP Customer Success',
        hiringManagerLinkedInUrl: 'https://linkedin.com/in/avery',
        bestConnectionPath: 'Warm intro available',
      },
    };
    const result = computeJobSearchPriority(job, [
      job,
      { id: 'past1', company: 'Acme', title: 'Customer Success Manager', source: 'linkedin', status: 'recruiter_screen' },
      { id: 'past2', company: 'Acme', title: 'Senior CSM', source: 'linkedin', status: 'hiring_manager_screen' },
    ], { now });

    assert.ok(result.score >= 70, `Expected strong priority, got ${result.score}`);
    assert.equal(result.dimensions.interviewFit, 88);
    assert.ok(result.dimensions.opportunityQuality >= 70);
    assert.ok(result.dimensions.decisionMakerAccess > 0);
    assert.ok(result.dimensions.outcomeLearning > 50);
  });
});
