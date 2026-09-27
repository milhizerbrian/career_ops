import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  classifyRequirement,
  classifyAllRequirements,
  detectHardBlockers,
  classifyFreshness,
  computeComponentScores,
  computeConfidence,
  classifyPursuit,
  buildExplainableSummary,
  computeCandidateYearsExperience,
  analyzeFit,
} from '../lib/candidate-fit-analysis.mjs';
import { parseJobDescription } from '../lib/jd-parser.mjs';

const FACTS = [
  { id: 'achievement-001', fact: 'Portfolio: $23M ARR', category: 'metric', employer: 'ExtraHop', verified: true, allowed_in_resume: true },
  { id: 'achievement-002', fact: 'Retention: 98% Gross Revenue Retention', category: 'metric', employer: 'ExtraHop', verified: true, allowed_in_resume: true },
  { id: 'achievement-003', fact: 'Managed and developed a team of 4 CSMs', category: 'achievement', employer: 'Total Trial Services', verified: true, allowed_in_resume: true },
  { id: 'skill-001', fact: 'SIEM / UEBA architecture', category: 'skill', employer: null, verified: true, allowed_in_resume: true },
  { id: 'skill-002', fact: 'Net Revenue Retention (NRR)', category: 'skill', employer: null, verified: true, allowed_in_resume: true },
];
const CERTS = [
  { id: 'cert-001', fact: 'CEH — Certified Ethical Hacker (December 2014)', category: 'certification', verified: true, allowed_in_resume: true },
];

describe('classifyRequirement (5-tier evidence classification)', () => {
  it('classifies Strong Match when 2+ facts support it, with evidence IDs', () => {
    const result = classifyRequirement('commercial NRR and expansion ownership', FACTS);
    assert.equal(result.tier, 'strong_match');
    assert.ok(result.evidenceIds.length >= 2);
  });

  it('classifies Partial Match when exactly 1 fact supports it', () => {
    const result = classifyRequirement('people management', FACTS);
    assert.equal(result.tier, 'partial_match');
    assert.deepEqual(result.evidenceIds, ['achievement-003']);
  });

  it('classifies Unknown (never Gap) for an open-ended requirement with no matching fact', () => {
    const result = classifyRequirement('RFP/RFI response', FACTS);
    assert.equal(result.tier, 'unknown');
    assert.deepEqual(result.evidenceIds, []);
  });

  it('classifies a missing required certification as a confirmed Gap, not Unknown', () => {
    const result = classifyRequirement('OWASP/MITRE familiarity', CERTS);
    assert.equal(result.tier, 'gap');
  });

  it('never reports evidence IDs for a tier with no supporting facts', () => {
    const result = classifyRequirement('some requirement not in the catalog', []);
    assert.deepEqual(result.evidenceIds, []);
    assert.equal(result.tier, 'unknown');
  });
});

describe('classifyAllRequirements', () => {
  it('tags each requirement label with the JD categories it appeared in', () => {
    const parsedJd = {
      required: [{ text: 'Own commercial NRR and expansion.', requirementLabels: ['commercial NRR and expansion ownership'] }],
      preferred: [{ text: 'OWASP familiarity a plus.', requirementLabels: ['OWASP/MITRE familiarity'] }],
      skills: ['commercial NRR and expansion ownership'],
    };
    const results = classifyAllRequirements(parsedJd, FACTS);
    const nrr = results.find(r => r.label === 'commercial NRR and expansion ownership');
    assert.ok(nrr.categories.includes('required'));
    assert.ok(nrr.categories.includes('skills'));
    const owasp = results.find(r => r.label === 'OWASP/MITRE familiarity');
    assert.ok(owasp.categories.includes('preferred'));
  });
});

describe('detectHardBlockers', () => {
  const profile = {
    compensation: { minimum: '$165K', location_flexibility: 'Dallas-based (DFW) or fully remote' },
    deal_breakers: ['Total comp below $165K', 'Fully on-site outside DFW', 'Pure sales roles (AE/quota-carrying)'],
  };

  it('flags a compensation floor blocker when JD max is below the stated minimum', () => {
    const parsedJd = { compensation: { max: 140000 }, location: {}, educationCertifications: [], required: [] };
    const blockers = detectHardBlockers(parsedJd, { profile, certifications: CERTS });
    assert.ok(blockers.some(b => b.type === 'compensation_floor'));
  });

  it('does not flag a comp blocker when JD max meets the minimum', () => {
    const parsedJd = { compensation: { max: 200000 }, location: {}, educationCertifications: [], required: [] };
    const blockers = detectHardBlockers(parsedJd, { profile, certifications: CERTS });
    assert.ok(!blockers.some(b => b.type === 'compensation_floor'));
  });

  it('flags an onsite-outside-DFW location blocker', () => {
    const parsedJd = { compensation: {}, location: { type: 'onsite', detail: 'Boston, MA' }, educationCertifications: [], required: [] };
    const blockers = detectHardBlockers(parsedJd, { profile, certifications: CERTS });
    assert.ok(blockers.some(b => b.type === 'location_incompatible'));
  });

  it('flags a missing required certification as a blocker', () => {
    const parsedJd = { compensation: {}, location: {}, educationCertifications: [{ type: 'certification', value: 'CISSP', required: true }], required: [] };
    const blockers = detectHardBlockers(parsedJd, { profile, certifications: CERTS });
    assert.ok(blockers.some(b => b.type === 'missing_required_certification'));
  });

  it('does not blocker a preferred (non-required) certification the candidate lacks', () => {
    const parsedJd = { compensation: {}, location: {}, educationCertifications: [{ type: 'certification', value: 'CISSP', required: false }], required: [] };
    const blockers = detectHardBlockers(parsedJd, { profile, certifications: CERTS });
    assert.ok(!blockers.some(b => b.type === 'missing_required_certification'));
  });

  it('produces no blockers for a fully compatible JD', () => {
    const parsedJd = { compensation: { max: 220000 }, location: { type: 'remote' }, educationCertifications: [], required: [] };
    const blockers = detectHardBlockers(parsedJd, { profile, certifications: CERTS });
    assert.deepEqual(blockers, []);
  });
});

describe('classifyFreshness', () => {
  it('buckets a job posted 1 day ago as fresh', () => {
    const now = new Date('2026-09-24T00:00:00Z');
    const result = classifyFreshness({ postedDate: '2026-09-23T00:00:00Z' }, now);
    assert.equal(result.bucket, 'fresh');
  });

  it('buckets a job posted 90 days ago as expired', () => {
    const now = new Date('2026-09-24T00:00:00Z');
    const result = classifyFreshness({ postedDate: '2026-06-26T00:00:00Z' }, now);
    assert.equal(result.bucket, 'expired');
  });

  it('returns bucket null (not a penalized bucket) when no date is available', () => {
    const result = classifyFreshness({});
    assert.equal(result.bucket, null);
  });
});

describe('computeCandidateYearsExperience', () => {
  it('derives years experience from the earliest employer start date', () => {
    const employers = [{ fact: 'ExtraHop — CSE, May 2023 – Present' }, { fact: 'Dynatrace — Global Manager, June 1999 – October 2013' }];
    const years = computeCandidateYearsExperience(employers, new Date('2026-01-01'));
    assert.ok(years >= 26 && years <= 27);
  });

  it('returns null when no employer dates are parseable', () => {
    assert.equal(computeCandidateYearsExperience([{ fact: 'no dates here' }]), null);
  });
});

describe('computeConfidence', () => {
  const parsedJdKnown = { seniority: { level: 'Senior', minYearsRequired: 8 }, domain: ['SIEM/SOC'], location: { type: 'remote' }, compensation: { max: 200000 } };
  const parsedJdUnknown = { seniority: { level: null, minYearsRequired: null }, domain: [], location: { type: null }, compensation: { max: null } };

  it('rates High confidence when most requirements are resolved and core categories are known', () => {
    const classifications = Array.from({ length: 10 }, (_, i) => ({ tier: i < 9 ? 'strong_match' : 'unknown' }));
    const result = computeConfidence(classifications, parsedJdKnown);
    assert.equal(result.level, 'High');
  });

  it('rates Low confidence when most requirements are unresolved', () => {
    const classifications = Array.from({ length: 10 }, () => ({ tier: 'unknown' }));
    const result = computeConfidence(classifications, parsedJdUnknown);
    assert.equal(result.level, 'Low');
  });
});

describe('classifyPursuit (6-band classification)', () => {
  it('classifies Blocked whenever any hard blocker exists, regardless of score', () => {
    const result = classifyPursuit({ overallScore: 95, blockers: [{ type: 'compensation_floor' }], confidence: { level: 'High' }, classifications: [] });
    assert.equal(result, 'Blocked');
  });

  it('classifies Needs Information when confidence is Low and evidence is sparse', () => {
    const classifications = Array.from({ length: 5 }, () => ({ tier: 'unknown' }));
    const result = classifyPursuit({ overallScore: 60, blockers: [], confidence: { level: 'Low' }, classifications });
    assert.equal(result, 'Needs Information');
  });

  it('classifies Priority for a high score with no blockers', () => {
    const result = classifyPursuit({ overallScore: 90, blockers: [], confidence: { level: 'High' }, classifications: [] });
    assert.equal(result, 'Priority');
  });

  it('classifies Low Priority for a low score with no blockers', () => {
    const result = classifyPursuit({ overallScore: 20, blockers: [], confidence: { level: 'Medium' }, classifications: [] });
    assert.equal(result, 'Low Priority');
  });
});

describe('buildExplainableSummary', () => {
  it('separates strong matches, partial matches (concerns), unknowns, and blockers', () => {
    const classifications = [
      { label: 'A', tier: 'strong_match', evidenceIds: ['x1', 'x2'] },
      { label: 'B', tier: 'partial_match', evidenceIds: ['x3'] },
      { label: 'C', tier: 'unknown', evidenceIds: [] },
    ];
    const summary = buildExplainableSummary({ classifications, blockers: [{ description: 'Comp too low' }], freshnessBucket: 'fresh' });
    assert.ok(summary.whyYouFit[0].includes('A'));
    assert.ok(summary.concerns[0].includes('B'));
    assert.deepEqual(summary.unknowns, ['C']);
    assert.deepEqual(summary.blockers, ['Comp too low']);
  });
});

describe('analyzeFit (end to end, real-shaped fixture)', () => {
  const job = { title: 'Strategic Customer Success Manager', postedDate: new Date().toISOString(), salary: '$180K - $220K', location: 'Remote (US)', remoteStatus: 'remote' };
  const jdText = 'Manage and develop a team of CSMs. Own commercial NRR and expansion for enterprise accounts. ' +
    '10+ years of experience required. SIEM experience preferred.';

  it('produces every documented output field without throwing, using injected candidate data', () => {
    const result = analyzeFit(job, jdText, { candidateFacts: FACTS, profile: { compensation: { minimum: '$165K', location_flexibility: 'Dallas-based (DFW) or fully remote' }, deal_breakers: [] }, certifications: CERTS });
    assert.equal(typeof result.overallScore, 'number');
    assert.ok(result.overallScore >= 0 && result.overallScore <= 100);
    assert.ok(['High', 'Medium', 'Low'].includes(result.confidence.level));
    assert.ok(Array.isArray(result.hardBlockers));
    assert.ok(['Priority', 'Strong', 'Possible', 'Low Priority', 'Blocked', 'Needs Information'].includes(result.pursuitClassification));
    for (const key of ['experience', 'skills', 'seniority', 'domain', 'leadership', 'technical', 'location', 'compensation', 'freshness', 'evidenceQuality']) {
      assert.equal(typeof result.componentScores[key], 'number', `missing component score: ${key}`);
    }
    assert.ok(result.summary.whyYouFit.length > 0);
  });

  it('is a pure function of its inputs (no I/O side effects) when data is injected', () => {
    const a = analyzeFit(job, jdText, { candidateFacts: FACTS, profile: {}, certifications: CERTS });
    const b = analyzeFit(job, jdText, { candidateFacts: FACTS, profile: {}, certifications: CERTS });
    assert.deepEqual(a.componentScores, b.componentScores);
    assert.equal(a.overallScore, b.overallScore);
  });
});
