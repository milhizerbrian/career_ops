import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { extractNumericClaims, findUnsupportedClaims, validateGeneratedClaims } from '../lib/evidence-validator.mjs';

const FACTS = [
  { id: 'metric-001', fact: 'Portfolio: $23M ARR', category: 'metric', employer: 'ExtraHop', source: 'master-brag-document.md', verified: true, allowed_in_resume: true },
  { id: 'metric-002', fact: 'Retention: 98% Gross Revenue Retention', category: 'metric', employer: 'ExtraHop', source: 'master-brag-document.md', verified: true, allowed_in_resume: true },
  { id: 'metric-003', fact: 'Expansion: 120% Net Revenue Retention', category: 'metric', employer: 'ExtraHop', source: 'master-brag-document.md', verified: true, allowed_in_resume: true },
  { id: 'metric-004', fact: 'Portfolio: $27M ARR across 6 enterprise SIEM customers', category: 'metric', employer: 'Securonix', source: 'master-brag-document.md', verified: true, allowed_in_resume: true },
];

describe('extractNumericClaims', () => {
  it('pulls dollar and percent tokens out of prose', () => {
    const claims = extractNumericClaims('Grew the account by $2.4M and improved retention by 20%.');
    assert.deepEqual(claims.sort(), ['$2.4M', '20%'].sort());
  });

  it('returns no claims for prose with no numbers', () => {
    assert.deepEqual(extractNumericClaims('Led enterprise renewals and expansion motions.'), []);
  });
});

describe('findUnsupportedClaims', () => {
  it('does not flag a claim that matches a verified fact exactly', () => {
    const result = findUnsupportedClaims({ KEY_ACHIEVEMENT_1: 'Owned a $23M ARR portfolio with 98% GRR.' }, FACTS);
    assert.deepEqual(result, []);
  });

  it('flags a dollar amount that appears nowhere in verified facts', () => {
    const result = findUnsupportedClaims({ KEY_ACHIEVEMENT_1: 'Recovered a $1.35M at-risk renewal.' }, FACTS);
    assert.equal(result.length, 1);
    assert.equal(result[0].field, 'KEY_ACHIEVEMENT_1');
    assert.equal(result[0].text, '$1.35M');
  });

  it('does not let "20%" false-match inside a verified "120%"', () => {
    const result = findUnsupportedClaims({ KEY_ACHIEVEMENT_1: 'Drove 20% expansion across the portfolio.' }, FACTS);
    assert.equal(result.length, 1);
    assert.equal(result[0].text, '20%');
  });

  it('does not let a verified "$27M" go unmatched due to trailing context', () => {
    const result = findUnsupportedClaims({ JOB_2_CONTEXT: 'Managed a $27M ARR book of business.' }, FACTS);
    assert.deepEqual(result, []);
  });

  it('ignores fields with no numeric claims', () => {
    const result = findUnsupportedClaims({ TITLE_LINE: 'Strategic Customer Success Manager' }, FACTS);
    assert.deepEqual(result, []);
  });
});

describe('validateGeneratedClaims (mode gating)', () => {
  const replacements = { KEY_ACHIEVEMENT_1: 'Recovered a $1.35M at-risk renewal.' };

  it('mode off: never returns claims or blocks, even with unsupported numbers present', () => {
    const result = validateGeneratedClaims(replacements, FACTS, { mode: 'off' });
    assert.deepEqual(result, { claims: [], blocking: false });
  });

  it('mode warn: returns the unsupported claim but never blocks', () => {
    const result = validateGeneratedClaims(replacements, FACTS, { mode: 'warn' });
    assert.equal(result.claims.length, 1);
    assert.equal(result.blocking, false);
  });

  it('mode block: returns the unsupported claim and blocks', () => {
    const result = validateGeneratedClaims(replacements, FACTS, { mode: 'block' });
    assert.equal(result.claims.length, 1);
    assert.equal(result.blocking, true);
  });

  it('mode block with a fully-supported claim does not block', () => {
    const result = validateGeneratedClaims({ KEY_ACHIEVEMENT_1: '$23M ARR, 98% GRR.' }, FACTS, { mode: 'block' });
    assert.deepEqual(result, { claims: [], blocking: false });
  });

  it('never blocks when the candidate fact store is empty (migration not run yet)', () => {
    const result = validateGeneratedClaims(replacements, [], { mode: 'block' });
    assert.deepEqual(result, { claims: [], blocking: false });
  });
});

describe('findUnsupportedFactualClaims (Phase 10 thank-you safety)', async () => {
  const { findUnsupportedFactualClaims } = await import('../lib/evidence-validator.mjs');
  const support = [
    'Zenity', 'Technical Customer Success Manager', 'Dana Lee', 'VP Customer Success', 'Hiring Manager',
    'Talked about renewals and CISO business reviews.',
    'Led renewals for 40 enterprise security accounts with 98% gross retention',
  ];

  it('accepts text grounded in the supplied notes, facts, and role details', () => {
    const text = 'Subject: Thank you - Technical Customer Success Manager at Zenity\n\nHi Dana,\n\nThank you for the conversation about renewals and CISO business reviews. Leading renewals for 40 enterprise security accounts is work I enjoy, and I appreciated hearing your priorities.\n\nBest,\nBrian';
    assert.deepEqual(findUnsupportedFactualClaims(text, support), []);
  });

  it('flags invented years, employers, titles, certifications, products, and metrics', () => {
    const text = 'Hi Dana, with 12 years of experience at Palo Alto Networks as a director, and my CISSP certification, I rolled out Splunk for ten years and cut churn by half.';
    const flagged = findUnsupportedFactualClaims(text, support);
    for (const claim of ['12', 'Palo Alto Networks', 'director', 'CISSP', 'certification', 'Splunk', 'ten years']) {
      assert.ok(flagged.includes(claim), `expected "${claim}" flagged, got ${JSON.stringify(flagged)}`);
    }
  });

  it('flags vague experience claims not in the evidence', () => {
    assert.ok(findUnsupportedFactualClaims('I bring many years of hands-on leadership.', support).includes('many years'));
  });

  it('treats an empty support set as supporting nothing', () => {
    assert.ok(findUnsupportedFactualClaims('At Zenity I led 40 accounts.', []).length > 0);
  });
});
