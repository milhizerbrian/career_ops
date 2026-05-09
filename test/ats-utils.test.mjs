import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { auditParsedText, extractAtsKeywords, scoreAtsMatch } from '../lib/ats-utils.mjs';

const job = {
  title: 'Strategic Customer Success Manager',
  keywords: ['Splunk', 'Salesforce'],
  requirements: [
    'Experience with SIEM platforms and SOC stakeholders',
    'Strong Salesforce CRM hygiene',
  ],
  full_description: 'The role requires Splunk, SIEM, SOC, Salesforce, executive QBRs, and cybersecurity SaaS renewals.',
  report: {
    cv_match_table: [
      {
        requirement: 'Executive QBRs with CISO stakeholders',
        brian_evidence: 'Led CISO-facing QBRs for enterprise cybersecurity accounts.',
        strength: 'Strong',
      },
      {
        requirement: 'Splunk administration',
        brian_evidence: '',
        strength: 'Gap',
      },
    ],
  },
};

describe('extractAtsKeywords', () => {
  it('extracts known ATS terms from structured job data', () => {
    const keywords = extractAtsKeywords(job).map(item => item.keyword);
    assert.ok(keywords.includes('Splunk'));
    assert.ok(keywords.includes('Salesforce'));
    assert.ok(keywords.includes('SIEM'));
  });
});

describe('scoreAtsMatch', () => {
  it('separates mapped and missing keywords', () => {
    const score = scoreAtsMatch(job, 'Salesforce CRM, SIEM, SOC, CISO QBRs, and cybersecurity SaaS renewals');
    assert.ok(score.score > 0);
    assert.ok(score.mapped.some(item => item.keyword === 'Salesforce'));
    assert.ok(score.missing.some(item => item.keyword === 'Splunk'));
  });
});

describe('auditParsedText', () => {
  it('flags missing core headers', () => {
    const audit = auditParsedText('Summary Customer Success Skills Salesforce SIEM Education');
    assert.equal(audit.ok, false);
    assert.ok(audit.issues.some(issue => issue.type === 'missing-header'));
  });

  it('passes text with a clean experience section', () => {
    const audit = auditParsedText('Summary '.repeat(40) + ' Experience ExtraHop CrowdStrike renewals and customer success. ' + 'Education Certifications Skills '.repeat(20));
    assert.equal(audit.ok, true);
  });
});
