import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { buildEvidenceIndex, enforceResumeEvidence, evidenceSummarySentence, evidenceSummarySentences, verifyResumeEvidence } from '../lib/resume-evidence.mjs';

const FACTS = [
  { id: 'employer-001', category: 'employer', employer: 'ExtraHop', fact: 'ExtraHop — Customer Success Engineer (Strategic Accounts), May 2023 – Present (~2 years) | Remote (NDR, NPM)', verified: true, allowed_in_resume: true },
  { id: 'employer-002', category: 'employer', employer: 'Securonix', fact: 'Securonix — Strategic Customer Success Manager, July 2021 – November 2022 (1 year 5 months) | Remote (SIEM, UEBA)', verified: true, allowed_in_resume: true },
  { id: 'achievement-001', category: 'metric', employer: 'ExtraHop', fact: 'Portfolio: $23M ARR', verified: true, allowed_in_resume: true },
  { id: 'achievement-002', category: 'achievement', employer: 'ExtraHop', fact: 'Maintained 98% Gross Revenue Retention across strategic enterprise accounts', verified: true, allowed_in_resume: true },
  { id: 'achievement-003', category: 'achievement', employer: 'ExtraHop', fact: 'Led a $13M enterprise renewal while expanding account value by 122%', verified: true, allowed_in_resume: true },
  { id: 'achievement-004', category: 'achievement', employer: 'Securonix', fact: 'Saved three at-risk enterprise accounts through executive escalation and remediation plans', verified: true, allowed_in_resume: true },
  { id: 'achievement-005', category: 'achievement', employer: 'ExtraHop', fact: 'Unverified draft claim about 400% growth', verified: false, allowed_in_resume: false },
  { id: 'skill-001', category: 'skill', employer: null, fact: 'Network Detection and Response (NDR)', verified: true, allowed_in_resume: true },
  { id: 'skill-002', category: 'skill', employer: null, fact: 'SIEM', verified: true, allowed_in_resume: true },
];

const FIELDS = ['TITLE_LINE', 'METRICS_LINE', 'PROFESSIONAL_SUMMARY', 'CORE_COMPETENCIES', 'KEY_ACHIEVEMENT_1',
  'JOB_1_CONTEXT', 'JOB_1_BULLET_1', 'JOB_1_BULLET_2', 'JOB_1_BULLET_3', 'JOB_2_CONTEXT', 'JOB_2_BULLET_1', 'JOB_2_BULLET_2'];

const passQuality = () => true;

function enforce(replacements, options = {}) {
  return enforceResumeEvidence(replacements, FIELDS, buildEvidenceIndex(FACTS), { qualityCheck: passQuality, ...options });
}

describe('enforceResumeEvidence', () => {
  it('replaces a bullet with invented metrics by an unused verified achievement for that employer', () => {
    const { replacements, report } = enforce({
      JOB_1_BULLET_1: 'Led the onboarding of 50 new enterprise clients, driving revenue growth by 18%.',
    });
    assert.match(replacements.JOB_1_BULLET_1, /98% Gross Revenue Retention|\$13M enterprise renewal/);
    assert.doesNotMatch(replacements.JOB_1_BULLET_1, /50 new|18%/);
    assert.ok(report.rejected.some(r => r.field === 'JOB_1_BULLET_1' && /50|18/.test(r.reason)));
  });

  it('does not accept a claim just because its numbers were removed', () => {
    const { replacements, report } = enforce({
      JOB_1_BULLET_1: 'Proactively reduced churn across the portfolio through customer engagement programs.',
    });
    assert.notEqual(replacements.JOB_1_BULLET_1, 'Proactively reduced churn across the portfolio through customer engagement programs.');
    assert.ok(report.rejected.some(r => r.field === 'JOB_1_BULLET_1' && /no matching verified fact/.test(r.reason)));
  });

  it('rejects a paraphrase that adds a term not in its matched fact (e.g. NDR on the wrong claim)', () => {
    const { replacements, report } = enforce({
      JOB_1_BULLET_1: 'Maintained 98% Gross Revenue Retention across strategic enterprise accounts on the SIEM platform.',
    });
    assert.doesNotMatch(replacements.JOB_1_BULLET_1, /SIEM platform/);
    assert.ok(report.rejected.some(r => r.field === 'JOB_1_BULLET_1'));
  });

  it('rejects a paraphrase that changes what the fact says, using the verified fact instead', () => {
    const { replacements } = enforce({
      JOB_2_BULLET_1: 'Developed three at-risk enterprise accounts through strategic demos and proofs of concept.',
    });
    assert.equal(replacements.JOB_2_BULLET_1, 'Saved three at-risk enterprise accounts through executive escalation and remediation plans.');
  });

  it('keeps a supported paraphrase of a verified fact', () => {
    const text = 'Maintained 98% Gross Revenue Retention across strategic ExtraHop enterprise accounts.';
    const { replacements } = enforce({ JOB_1_BULLET_1: text });
    assert.equal(replacements.JOB_1_BULLET_1, text);
  });

  it('checks role fields against that employer only (no borrowing another employer\'s dates)', () => {
    const { replacements, report } = enforce({
      JOB_2_CONTEXT: 'Strategic Customer Success Manager at Securonix (May 2023 - Present) across enterprise accounts.',
    });
    assert.doesNotMatch(replacements.JOB_2_CONTEXT, /2023/);
    // Employer/title are already in the template's role header; the context
    // keeps only the rest of the verified employer record.
    assert.match(replacements.JOB_2_CONTEXT, /^July 2021 – November 2022 \(1 year 5 months\) \| Remote \(SIEM, UEBA\)\.$/);
    assert.ok(report.rejected.some(r => r.field === 'JOB_2_CONTEXT'));
  });

  it('omits a bullet when no unused verified fact remains, instead of inventing one', () => {
    const { replacements } = enforce({
      JOB_2_BULLET_1: 'Grew revenue 300% at Securonix.',
      JOB_2_BULLET_2: 'Won 40 new logos at Securonix.',
    });
    const filled = [replacements.JOB_2_BULLET_1, replacements.JOB_2_BULLET_2].filter(Boolean);
    assert.deepEqual(filled, ['Saved three at-risk enterprise accounts through executive escalation and remediation plans.']);
  });

  it('never uses unverified facts', () => {
    const { replacements } = enforce({ JOB_1_BULLET_1: 'x 1', JOB_1_BULLET_2: 'y 2', JOB_1_BULLET_3: 'z 3' });
    assert.doesNotMatch(JSON.stringify(replacements), /400%|Unverified draft/);
  });

  it('drops unsupported summary sentences and line items, keeping supported ones', () => {
    const { replacements } = enforce({
      PROFESSIONAL_SUMMARY: 'Maintained 98% Gross Revenue Retention across strategic enterprise accounts. Holds a CISSP and 12 years at Palo Alto Networks.',
      CORE_COMPETENCIES: 'Security Domains: NDR, SIEM, AWS | Cloud: Kubernetes',
      METRICS_LINE: '$23M ARR | 95% GRR | 122% expansion',
    });
    assert.equal(replacements.PROFESSIONAL_SUMMARY, 'Maintained 98% Gross Revenue Retention across strategic enterprise accounts.');
    assert.equal(replacements.CORE_COMPETENCIES, 'Security Domains: NDR, SIEM');
    assert.equal(replacements.METRICS_LINE, '$23M ARR | 122% expansion');
  });

  it('does not reuse a fact across key achievements and bullets, and removes duplicate bullets', () => {
    const fact = 'Led a $13M enterprise renewal while expanding account value by 122%.';
    const { replacements } = enforce({ KEY_ACHIEVEMENT_1: fact, JOB_1_BULLET_1: fact, JOB_1_BULLET_2: fact });
    const all = [replacements.KEY_ACHIEVEMENT_1, replacements.JOB_1_BULLET_1, replacements.JOB_1_BULLET_2].filter(Boolean);
    assert.equal(all.filter(t => /\$13M/.test(t)).length, 1);
  });

  it('replaces a supported but too-short context with the verified employer record', () => {
    const { replacements } = enforce(
      { JOB_1_CONTEXT: 'Customer Success Engineer at ExtraHop.' },
      { qualityCheck: (field, text) => !(field.endsWith('_CONTEXT') && text.split(/\s+/).length < 12) },
    );
    assert.match(replacements.JOB_1_CONTEXT, /^May 2023 – Present/);
  });

  it('drops a summary sentence whose metric claim does not match a single verified fact', () => {
    const { replacements } = enforce({
      PROFESSIONAL_SUMMARY: 'Customer success leader for NDR and SIEM platforms. Built a $23M ARR portfolio with 122% retention through executive alignment.',
    });
    assert.equal(replacements.PROFESSIONAL_SUMMARY, 'Customer success leader for NDR and SIEM platforms.');
  });

  it('keeps at most three supported summary sentences', () => {
    const { replacements } = enforce({
      PROFESSIONAL_SUMMARY: 'Maintained 98% Gross Revenue Retention across strategic enterprise accounts. Led a $13M enterprise renewal. Saved three at-risk enterprise accounts. Supported NDR and SIEM customers.',
    });
    assert.equal(replacements.PROFESSIONAL_SUMMARY.match(/[.!?]/g).length, 3);
    assert.doesNotMatch(replacements.PROFESSIONAL_SUMMARY, /Supported NDR/);
  });

  it('replaces model text that fails the quality check with verified content', () => {
    const { replacements } = enforce(
      { JOB_1_BULLET_1: 'Maintained 98% Gross Revenue Retention across strategic ExtraHop enterprise accounts, with executive-ready operating rhythm and clear ownership.' },
      { qualityCheck: (field, text) => !/operating rhythm/.test(text) },
    );
    assert.doesNotMatch(replacements.JOB_1_BULLET_1, /operating rhythm/);
  });
});

describe('verifyResumeEvidence', () => {
  const index = buildEvidenceIndex(FACTS);

  it('passes a clean, evidence-backed resume', () => {
    assert.deepEqual(verifyResumeEvidence({
      PROFESSIONAL_SUMMARY: 'Maintained 98% Gross Revenue Retention across strategic enterprise accounts.',
      JOB_1_BULLET_1: 'Led a $13M enterprise renewal while expanding account value by 122%.',
    }, FIELDS, index), []);
  });

  it('reports a bullet that adds a claim not in its matched fact', () => {
    const issues = verifyResumeEvidence({
      JOB_1_BULLET_1: 'Maintained 98% Gross Revenue Retention across strategic enterprise accounts on the SIEM platform.',
    }, FIELDS, index);
    assert.match(issues.join('\n'), /JOB_1_BULLET_1: not in its matched fact/);
  });

  it('reports unsupported claims, serialized objects, and repeated filler phrases', () => {
    const issues = verifyResumeEvidence({
      CORE_COMPETENCIES: '[object Object]',
      JOB_1_BULLET_1: 'Maintained 98% Gross Revenue Retention across strategic enterprise accounts, with executive-ready operating rhythm and clear ownership.',
      JOB_1_BULLET_2: 'Led a $13M enterprise renewal while expanding account value by 122%, with executive-ready operating rhythm and clear ownership.',
      JOB_1_BULLET_3: 'Onboarded 50 new enterprise clients.',
    }, FIELDS, index);
    const text = issues.join('\n');
    assert.match(text, /CORE_COMPETENCIES: serialized object/);
    assert.match(text, /repeated phrase/);
    assert.match(text, /JOB_1_BULLET_3: unsupported/);
  });
});

describe('evidenceSummarySentence', () => {
  const index = buildEvidenceIndex(FACTS);

  it('returns an unused verified achievement, never one already in the resume', () => {
    const sentence = evidenceSummarySentence({
      KEY_ACHIEVEMENT_1: 'Led a $13M enterprise renewal while expanding account value by 122%.',
      JOB_1_BULLET_1: 'Maintained 98% Gross Revenue Retention across strategic enterprise accounts.',
    }, ['KEY_ACHIEVEMENT_1', 'JOB_1_BULLET_1'], index);
    assert.equal(sentence, 'Saved three at-risk enterprise accounts through executive escalation and remediation plans.');
  });

  it('returns null when every verified achievement is already used', () => {
    assert.equal(evidenceSummarySentence({
      A: 'Led a $13M enterprise renewal while expanding account value by 122%.',
      B: 'Maintained 98% Gross Revenue Retention across strategic enterprise accounts.',
      C: 'Saved three at-risk enterprise accounts through executive escalation and remediation plans.',
    }, ['A', 'B', 'C'], index), null);
  });
});

describe('evidenceSummarySentences', () => {
  it('returns up to the limit of distinct unused verified achievements', () => {
    const index = buildEvidenceIndex(FACTS);
    const sentences = evidenceSummarySentences({}, [], index, { limit: 2 });
    assert.equal(sentences.length, 2);
    assert.notEqual(sentences[0], sentences[1]);
  });
});

