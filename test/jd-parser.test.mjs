import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  parseJobDescription,
  splitIntoSections,
  detectSeniority,
  detectLeadership,
  detectLocation,
  detectCompensation,
  detectEducationCertifications,
} from '../lib/jd-parser.mjs';

const SAMPLE_JD = `As Vanta's Customer Success Manager, Strategic, you will serve as a trusted advisor. ` +
  `What you'll do: Serve as the primary trusted advisor for 5-10 strategic customers. Lead enterprise-scale implementations. ` +
  `Build and maintain deep executive relationships with CISOs and CIOs. Manage and develop a team of associate CSMs. ` +
  `How to be successful in this role: 10+ years of experience as a Customer Success Manager for a SaaS company. ` +
  `Experience with SIEM and cloud security architecture is required. Bachelor's degree required. CISSP preferred. ` +
  `Nice to have: experience with Kubernetes and API security. ` +
  `What you can expect: Industry-competitive salary $150K - $180K and equity. Remote position, no relocation required.`;

describe('splitIntoSections', () => {
  it('splits flattened JD text into responsibilities/required/preferred/benefits segments', () => {
    const sections = splitIntoSections(SAMPLE_JD);
    assert.match(sections.responsibilities, /primary trusted advisor/i);
    assert.match(sections.required, /10\+ years/i);
    assert.match(sections.preferred, /Kubernetes/i);
    assert.match(sections.benefits, /150K/);
  });

  it('returns all-unlabeled text when no section markers are present', () => {
    const sections = splitIntoSections('Just a plain sentence with no headers at all.');
    assert.equal(sections.required, '');
    assert.match(sections.unlabeled, /plain sentence/);
  });

  it('handles empty input without throwing', () => {
    const sections = splitIntoSections('');
    assert.equal(sections.unlabeled, '');
  });
});

describe('detectSeniority', () => {
  it('extracts the highest years-of-experience figure mentioned', () => {
    const result = detectSeniority('Requires 5+ years, ideally 10+ years of experience.', 'Senior CSM');
    assert.equal(result.minYearsRequired, 10);
    assert.equal(result.level, 'Senior');
  });

  it('returns null level/years when nothing is mentioned', () => {
    const result = detectSeniority('Great teammate wanted.', '');
    assert.equal(result.level, null);
    assert.equal(result.minYearsRequired, null);
  });
});

describe('detectLeadership', () => {
  it('flags leadership requirement when team-management language is present', () => {
    const result = detectLeadership('Manage and develop a team of CSMs.');
    assert.equal(result.required, true);
    assert.ok(result.evidence.length > 0);
  });

  it('does not flag leadership for an individual-contributor JD', () => {
    const result = detectLeadership('Own a book of strategic accounts as an individual contributor.');
    assert.equal(result.required, false);
  });
});

describe('detectLocation', () => {
  it('prefers the job record location/remoteStatus over JD text', () => {
    const result = detectLocation('some text mentioning onsite once', { location: 'Remote (US)', remoteStatus: 'remote' });
    assert.equal(result.type, 'remote');
    assert.equal(result.source, 'job record');
  });

  it('falls back to JD text when no job record location is given', () => {
    const result = detectLocation('This is a fully remote position with no relocation required.', {});
    assert.equal(result.type, 'remote');
    assert.equal(result.relocationRequired, false);
  });

  it('detects an explicit relocation requirement', () => {
    const result = detectLocation('Onsite role; must relocate to Austin within 60 days.', {});
    assert.equal(result.type, 'onsite');
    assert.equal(result.relocationRequired, true);
  });
});

describe('detectCompensation', () => {
  it('parses a $XXXK - $XXXK range from JD text', () => {
    const result = detectCompensation('Salary range: $150K - $180K plus equity.', {});
    assert.equal(result.min, 150000);
    assert.equal(result.max, 180000);
    assert.equal(result.source, 'JD text');
  });

  it('prefers job.salary when present', () => {
    const result = detectCompensation('irrelevant JD text', { salary: '$160K - $200K' });
    assert.equal(result.min, 160000);
    assert.equal(result.max, 200000);
    assert.equal(result.source, 'job record');
  });

  it('returns unknown when no compensation data exists anywhere', () => {
    const result = detectCompensation('No numbers here.', {});
    assert.equal(result.min, null);
    assert.equal(result.source, 'unknown');
  });
});

describe('detectEducationCertifications', () => {
  it('detects a required degree and a preferred certification', () => {
    const result = detectEducationCertifications("Bachelor's degree required. CISSP preferred.");
    const degree = result.find(r => r.type === 'degree');
    const cert = result.find(r => r.type === 'certification');
    assert.ok(degree);
    assert.equal(degree.required, true);
    assert.ok(cert);
    assert.equal(cert.value, 'CISSP');
  });
});

describe('parseJobDescription (end to end)', () => {
  it('produces every documented field without throwing on real-shaped JD text', () => {
    const parsed = parseJobDescription(SAMPLE_JD, { title: 'Customer Success Manager, Strategic' });
    assert.ok(Array.isArray(parsed.required));
    assert.ok(Array.isArray(parsed.preferred));
    assert.ok(Array.isArray(parsed.responsibilities));
    assert.ok(Array.isArray(parsed.skills));
    assert.ok(Array.isArray(parsed.domain));
    assert.equal(typeof parsed.seniority, 'object');
    assert.equal(typeof parsed.leadership, 'object');
    assert.equal(typeof parsed.location, 'object');
    assert.equal(typeof parsed.compensation, 'object');
    assert.equal(parsed.leadership.required, true);
    assert.equal(parsed.location.type, 'remote');
    assert.equal(parsed.compensation.min, 150000);
  });

  it('never fabricates a value for a field the JD text does not mention', () => {
    const parsed = parseJobDescription('A very short job description with no specifics.', {});
    assert.equal(parsed.compensation.min, null);
    assert.equal(parsed.seniority.minYearsRequired, null);
    assert.deepEqual(parsed.domain, []);
  });
});
