import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveTemplatePath } from '../lib/docx-utils.mjs';
import {
  auditJdCoverage,
  buildEvidenceMap,
  buildGapQuestionCandidates,
  buildCandidateTruthContext,
  buildResumeDebugStats,
  buildResumePlanningContext,
  buildResumeSectionPlan,
  chooseDynamicPageFitAction,
  classifyResumeLayout,
  classifyResumeRole,
  compactOverflowFields,
  compareSupportedRequirementCoverage,
  critiqueResumeDraft,
  applyDeterministicStrategicRepairs,
  applyDeterministicQualityRepairs,
  applyRoleSectionIntegrityRepairs,
  assessJobDescription,
  extractJobRequirements,
  extractJdSignals,
  flattenDynamicResumeDraft,
  generateResumeFinish,
  inferResumePositioningMode,
  lowestPrioritySelectedBullet,
  planningContextText,
  repairThinSummary,
  extendSummaryWithEvidence,
  dedupeMetricsLine,
  ensureLocalModelContext,
  enrichEvidenceMapWithVault,
  rescueQualityUntilStable,
  sanitizeResumeLanguage,
  selectBestJobDescription,
  selectDynamicRoleBullets,
  synthesisSystemBlocks,
  validateResumeQuality,
} from '../lib/resume-gen.mjs';
import { anthropicRequestCacheControl } from '../lib/anthropic-cache.mjs';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const FIELDS = [
  'PROFESSIONAL_SUMMARY',
  'KEY_ACHIEVEMENT_1',
  'JOB_1_CONTEXT',
  'JOB_1_BULLET_1',
];

const VALID_REPLACEMENTS = {
  PROFESSIONAL_SUMMARY: 'Enterprise customer success leader with 25 years across cybersecurity SaaS, NDR, SIEM, IAM, and endpoint security. Manages strategic portfolios through executive engagement, adoption planning, renewal recovery, expansion motions, and measurable value realization. Trusted advisor to CISOs and VP security leaders across regulated enterprise environments and complex hybrid-cloud deployments.',
  KEY_ACHIEVEMENT_1: 'Led $13M enterprise renewal at ExtraHop while expanding account value 122% through security maturity and adoption planning.',
  JOB_1_CONTEXT: 'ExtraHop strategic Customer Success Engineer managing $23M ARR across NDR, NPM, hybrid-cloud, healthcare, financial services, and retail accounts.',
  JOB_1_BULLET_1: 'Recovered renewal risk across a $23M NDR and NPM portfolio by aligning CISO stakeholders, prioritizing hybrid-cloud visibility use cases, and preserving 98% gross revenue retention before renewal.',
};

function withEnv(overrides, fn) {
  const previous = {};
  for (const key of Object.keys(overrides)) {
    previous[key] = process.env[key];
    if (overrides[key] === undefined) delete process.env[key];
    else process.env[key] = overrides[key];
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const key of Object.keys(overrides)) {
        if (previous[key] === undefined) delete process.env[key];
        else process.env[key] = previous[key];
      }
    });
}

function finishState(variant) {
  return {
    jobId: `test-${variant}`,
    io: { events: [], emit(event, payload) { this.events.push({ event, payload }); } },
    job: { company: `PDF Test ${variant}` },
    templatePath: resolveTemplatePath(),
    fields: FIELDS,
    replacements: VALID_REPLACEMENTS,
    variant,
    log: () => {},
  };
}

describe('validateResumeQuality', () => {
  it('rejects short, generic job bullets', () => {
    const replacements = {
      PROFESSIONAL_SUMMARY: 'Enterprise customer success leader with 25 years across cybersecurity SaaS, NDR, SIEM, IAM, and endpoint security. Manages strategic portfolios through executive engagement, adoption planning, renewal recovery, expansion motions, and measurable value realization. Trusted advisor to CISOs and VP security leaders across regulated enterprise environments and complex hybrid-cloud deployments.',
      KEY_ACHIEVEMENT_1: 'Led $13M enterprise renewal at ExtraHop while expanding account value 122% through security maturity and adoption planning.',
      JOB_1_CONTEXT: 'ExtraHop strategic Customer Success Engineer managing $23M ARR across NDR, NPM, hybrid-cloud, healthcare, financial services, and retail accounts.',
      JOB_1_BULLET_1: 'Managed accounts and supported customers.',
    };

    assert.throws(
      () => validateResumeQuality(replacements, FIELDS),
      /JOB_1_BULLET_1: bullet is too short/
    );
  });

  it('accepts detailed bullets with scope, domain, mechanism, and proof', () => {
    const replacements = {
      PROFESSIONAL_SUMMARY: 'Enterprise customer success leader with 25 years across cybersecurity SaaS, NDR, SIEM, IAM, and endpoint security. Manages strategic portfolios through executive engagement, adoption planning, renewal recovery, expansion motions, and measurable value realization. Trusted advisor to CISOs and VP security leaders across regulated enterprise environments and complex hybrid-cloud deployments.',
      KEY_ACHIEVEMENT_1: 'Led $13M enterprise renewal at ExtraHop while expanding account value 122% through security maturity and adoption planning.',
      JOB_1_CONTEXT: 'ExtraHop strategic Customer Success Engineer managing $23M ARR across NDR, NPM, hybrid-cloud, healthcare, financial services, and retail accounts.',
      JOB_1_BULLET_1: 'Recovered renewal risk across a $23M NDR and NPM portfolio by aligning CISO stakeholders, prioritizing hybrid-cloud visibility use cases, and preserving 98% gross revenue retention before renewal.',
    };

    assert.equal(validateResumeQuality(replacements, FIELDS), true);
  });

  it('rejects professional summaries that exceed the three-sentence ceiling', () => {
    const replacements = {
      PROFESSIONAL_SUMMARY: 'Enterprise customer success leader with 25 years across cybersecurity SaaS. Manages strategic portfolios through executive engagement. Trusted advisor to CISOs and VP security leaders. Builds adoption systems that connect technical execution to measurable value realization.',
      KEY_ACHIEVEMENT_1: 'Led $13M enterprise renewal at ExtraHop while expanding account value 122% through security maturity and adoption planning.',
      JOB_1_CONTEXT: 'ExtraHop strategic Customer Success Engineer managing $23M ARR across NDR, NPM, hybrid-cloud, healthcare, financial services, and retail accounts.',
      JOB_1_BULLET_1: 'Recovered renewal risk across a $23M NDR and NPM portfolio by aligning CISO stakeholders, prioritizing hybrid-cloud visibility use cases, and preserving 98% gross revenue retention before renewal.',
    };

    assert.throws(
      () => validateResumeQuality(replacements, FIELDS),
      /PROFESSIONAL_SUMMARY: summary has too many sentences/
    );
  });

  it('rejects known shallow shorthand bullets', () => {
    const base = {
      PROFESSIONAL_SUMMARY: 'Enterprise customer success leader with 25 years across cybersecurity SaaS, NDR, SIEM, IAM, and endpoint security. Manages strategic portfolios through executive engagement, adoption planning, renewal recovery, expansion motions, and measurable value realization. Trusted advisor to CISOs and VP security leaders across regulated enterprise environments and complex hybrid-cloud deployments.',
      KEY_ACHIEVEMENT_1: 'Led $13M enterprise renewal at ExtraHop while expanding account value 122% through security maturity and adoption planning.',
      JOB_1_CONTEXT: 'ExtraHop strategic Customer Success Engineer managing $23M ARR across NDR, NPM, hybrid-cloud, healthcare, financial services, and retail accounts.',
    };
    const weakBullets = [
      'Managed accounts and supported customers.',
      'Owned $23M ARR portfolio.',
      'Advised CISOs on threat detection.',
      'Maintained 98% retention.',
      'Supported enterprise deployments.',
    ];

    for (const bullet of weakBullets) {
      assert.throws(
        () => validateResumeQuality({ ...base, JOB_1_BULLET_1: bullet }, FIELDS),
        /Resume quality gate failed/
      );
    }
  });

  it('rejects key achievements without measurable scale or portfolio proof', () => {
    assert.throws(
      () => validateResumeQuality({
        KEY_ACHIEVEMENT_1: 'Improved onboarding discipline through better stakeholder alignment and repeatable customer success operating rhythms.',
      }, ['KEY_ACHIEVEMENT_1']),
      /achievement lacks a measurable result/
    );
  });

  it('rejects copyable generic claims without a specific system or customer motion', () => {
    assert.throws(
      () => validateResumeQuality({
        JOB_1_BULLET_1: 'Improved adoption across enterprise cybersecurity accounts by aligning CISO stakeholders and preserving 98% retention through executive engagement.',
      }, ['JOB_1_BULLET_1']),
      /copyable claim/
    );
  });

  it('sanitizes banned wording after model repair output', () => {
    const value = sanitizeResumeLanguage(
      'Responsible for customer outcomes — provided support and managed relationships to leverage synergy.'
    );

    assert.doesNotMatch(value, /Responsible for|—|provided support|managed relationships|leverage|synergy/i);
    assert.match(value, /Owned/);
    assert.match(value, /resolved execution gaps/);
  });

  it('scrubs generated filler clauses and unsupported customer-SOC AI scope', () => {
    const value = sanitizeResumeLanguage(
      'Deployed AI workflow automation inside customer SOC environments to reduce repetitive manual analyst tasks, for enterprise security stakeholders through documented deployment criteria and measurable security outcomes.'
    );

    assert.doesNotMatch(value, /for enterprise security stakeholders through documented deployment criteria/i);
    assert.doesNotMatch(value, /Deployed AI workflow automation inside customer SOC environments/i);
    assert.doesNotMatch(value, /AI workflow automation/i);
    assert.match(value, /Mapped customer investigation workflows/);
  });

  it('rejects generated filler clauses and unsupported customer-SOC AI claims', () => {
    assert.throws(
      () => validateResumeQuality({
        JOB_1_BULLET_1: 'Deployed AI workflow automation inside customer SOC environments to reduce repetitive manual analyst tasks across a $23M enterprise portfolio, improving adoption and preserving 98% retention through executive alignment.',
      }, ['JOB_1_BULLET_1']),
      /unsupported AI customer-SOC deployment claim/
    );

    assert.throws(
      () => validateResumeQuality({
        JOB_1_BULLET_1: 'Aligned renewal strategy across a $23M portfolio with CISO stakeholders and 98% retention, for enterprise security stakeholders through documented deployment criteria and measurable security outcomes.',
      }, ['JOB_1_BULLET_1']),
      /generated security-stakeholder filler artifact/
    );
  });

  it('rejects banned support-first phrasing even when a bullet has proof', () => {
    assert.throws(
      () => validateResumeQuality({
        JOB_1_BULLET_1: 'Provided support across a $23M enterprise NDR portfolio by aligning CISO stakeholders, improving security adoption, and preserving 98% gross retention through renewal execution.',
      }, ['JOB_1_BULLET_1']),
      /contains banned phrase/
    );
  });

  it('fails bullets under 15 words even for compressed older roles', () => {
    assert.throws(
      () => validateResumeQuality({
        JOB_5_BULLET_1: 'Maintained 98% retention across enterprise email security accounts.',
      }, ['JOB_5_BULLET_1']),
      /expected 15\+ even when compressed/
    );
  });

  it('tracks debug metrics without model calls', () => {
    const stats = buildResumeDebugStats({
      JOB_1_BULLET_1: 'Recovered renewal risk across a $23M NDR and NPM portfolio by aligning CISO stakeholders, prioritizing hybrid-cloud visibility use cases, and preserving 98% gross revenue retention before renewal.',
    }, ['JOB_1_BULLET_1'], { pageCount: 2 });

    assert.equal(stats.bulletCount, 1);
    assert.equal(stats.weakBulletCount, 0);
    assert.equal(stats.pageCount, 2);
    assert.ok(stats.avgBulletWordCount >= 25);
    assert.ok(stats.avgBulletCharacterCount >= 175);
  });
});

describe('role section integrity repairs', () => {
  it('restores Proofpoint content when Trend Micro leaks into the Proofpoint fields', () => {
    const repaired = applyRoleSectionIntegrityRepairs({
      JOB_6_CONTEXT: 'TAM / Customer Account Manager | Trend Micro | Jan 2014 - Nov 2015 | Endpoint security',
      JOB_6_BULLET_1: 'Supported Trend Micro deployments while earning CEH.',
      JOB_6_BULLET_2: 'Introduced Trend Micro technical reviews while earning CEH.',
    }, ['JOB_6_CONTEXT', 'JOB_6_BULLET_1', 'JOB_6_BULLET_2']);

    assert.match(repaired.JOB_6_CONTEXT, /\$18M ARR portfolio/);
    assert.match(repaired.JOB_6_BULLET_1, /98% retention/);
    assert.match(repaired.JOB_6_BULLET_2, /\$1\.65M\+/);
  });

  it('restores Proofpoint content when Dynatrace leaks into the Proofpoint fields', () => {
    const repaired = applyRoleSectionIntegrityRepairs({
      JOB_6_CONTEXT: 'Dynatrace / Keynote content',
      JOB_6_BULLET_1: 'Led Dynatrace support operations.',
      JOB_6_BULLET_2: 'Expanded Keynote coverage.',
    }, ['JOB_6_CONTEXT', 'JOB_6_BULLET_1', 'JOB_6_BULLET_2']);

    assert.match(repaired.JOB_6_CONTEXT, /\$18M ARR portfolio/);
    assert.match(repaired.JOB_6_BULLET_1, /structured executive engagement/);
  });

  it('removes duplicated role/title/date prefixes from generated context lines', () => {
    const repaired = applyRoleSectionIntegrityRepairs({
      JOB_1_CONTEXT: 'Customer Success Engineer (Strategic Accounts) | ExtraHop | May 2023 - Present | $23M ARR portfolio, NDR/NPM.',
    }, ['JOB_1_CONTEXT']);

    assert.equal(repaired.JOB_1_CONTEXT, '$23M ARR portfolio, NDR/NPM.');
  });

  it('merges duplicate GTM competency categories', () => {
    const repaired = applyRoleSectionIntegrityRepairs({
      CORE_COMPETENCIES: 'GTM & Pre-Sales: POC Design & Execution, POC Conversion & Success Metrics | GTM/CS Platforms: POC Conversion & Success Metrics, Sales Cycle Win Rate Contribution',
    }, ['CORE_COMPETENCIES']);

    assert.match(repaired.CORE_COMPETENCIES, /GTM & Pre-Sales:/);
    assert.doesNotMatch(repaired.CORE_COMPETENCIES, /GTM\/CS Platforms:/);
    assert.match(repaired.CORE_COMPETENCIES, /Sales Cycle Win Rate Contribution/);
  });

  it('removes empty competency categories left behind by strategic rewrites', () => {
    const repaired = applyRoleSectionIntegrityRepairs({
      CORE_COMPETENCIES: 'Strategic Account Leadership | Security Domains: | GTM/CS Platforms:',
    }, ['CORE_COMPETENCIES']);

    assert.equal(repaired.CORE_COMPETENCIES, 'Strategic Account Leadership');
  });
});

describe('quality rescue', () => {
  // Deterministic repairs no longer append generic clauses to satisfy length
  // or proof rules (that produced repeated filler); evidence enforcement
  // replaces weak bullets with verified facts or omits them instead.
  const FILLER_RE = /executive-ready operating rhythm|tying (?:daily )?execution to|using documented deployment criteria|across enterprise portfolios|across enterprise customer (?:environments|accounts)/i;

  it('does not append generic filler to a weak bullet', () => {
    const repaired = applyDeterministicQualityRepairs({
      JOB_1_BULLET_1: 'Managed customer relationships and supported implementation planning for accounts.',
    }, ['JOB_1_BULLET_1'], [
      'JOB_1_BULLET_1: bullet lacks metric, enterprise scope, or stakeholder proof',
      'JOB_1_BULLET_1: recent/relevant bullet is too short (10 words, target 22-34)',
    ]);
    assert.doesNotMatch(repaired.JOB_1_BULLET_1, FILLER_RE);
  });

  it('does not pad short contexts or achievements', () => {
    const repaired = applyDeterministicQualityRepairs({
      JOB_1_CONTEXT: 'Customer Success Engineer at ExtraHop.',
      KEY_ACHIEVEMENT_1: 'Improved onboarding.',
    }, ['JOB_1_CONTEXT', 'KEY_ACHIEVEMENT_1'], [
      'JOB_1_CONTEXT: context is too short (6 words, expected 12+)',
      'KEY_ACHIEVEMENT_1: achievement is too short (2 words, expected 14+)',
    ]);
    assert.doesNotMatch(`${repaired.JOB_1_CONTEXT} ${repaired.KEY_ACHIEVEMENT_1}`, FILLER_RE);
  });
});


describe('rendered resume layout', () => {
  it('requires both two pages and a materially full second page', () => {
    assert.equal(classifyResumeLayout({
      pageCount: 2,
      pages: [{ fillRatio: 0.95 }, { fillRatio: 0.91 }],
    }).status, 'fit');

    assert.equal(classifyResumeLayout({
      pageCount: 2,
      pages: [{ fillRatio: 0.95 }, { fillRatio: 0.62 }],
    }).status, 'underfilled');

    assert.equal(classifyResumeLayout({
      pageCount: 3,
      pages: [{ fillRatio: 0.95 }, { fillRatio: 0.95 }, { fillRatio: 0.4 }],
    }).status, 'overflow');
  });

  it('keeps a valid bullet unchanged when removing overflow text would make it fail quality', () => {
    const repaired = compactOverflowFields({
      JOB_3_BULLET_3: 'Built a framework, then handed the risk signal process to the broader CS team as a repeatable playbook, across enterprise cybersecurity stakeholders using documented deployment criteria and measurable security outcomes.',
    }, ['JOB_3_BULLET_3']);

    // Stripping the clause would fail quality and no generic re-padding is
    // added any more, so the valid bullet is kept unchanged.
    assert.equal(validateResumeQuality(repaired, ['JOB_3_BULLET_3']), true);
  });

  it('treats overly dense two-page renders as overflow to preserve Word pagination buffer', () => {
    assert.equal(classifyResumeLayout({
      pageCount: 2,
      pages: [{ fillRatio: 0.95, wordCount: 520 }, { fillRatio: 0.91, wordCount: 515 }],
    }).status, 'overflow');
  });

  it('applies stricter overflow budgets on later fit attempts', () => {
    const longBullet = 'Built a detailed enterprise cybersecurity operating model with CISO stakeholders through documented deployment criteria, measurable security outcomes, structured stakeholder alignment, and repeatable architecture review cadences across multiple complex accounts.';
    const first = compactOverflowFields({ JOB_1_BULLET_1: longBullet }, ['JOB_1_BULLET_1'], 1);
    const third = compactOverflowFields({ JOB_1_BULLET_1: longBullet }, ['JOB_1_BULLET_1'], 3);

    assert.ok(first.JOB_1_BULLET_1.length > third.JOB_1_BULLET_1.length);
    assert.ok(third.JOB_1_BULLET_1.length <= 190);
  });

  it('does not accept compaction that removes required bullet proof', () => {
    const bullet = 'Mapped application control requirements into deployment sequencing for endpoint security use cases, preserving stakeholder alignment across enterprise accounts and sustaining 98% retention.';
    const repaired = compactOverflowFields({ JOB_1_BULLET_1: bullet }, ['JOB_1_BULLET_1'], 3);

    assert.equal(validateResumeQuality(repaired, ['JOB_1_BULLET_1']), true);
    assert.match(repaired.JOB_1_BULLET_1, /98% retention|enterprise accounts/);
  });

  it('accepts an underfilled resume within 2 pages instead of padding it', () => {
    assert.equal(chooseDynamicPageFitAction({
      status: 'underfilled',
      pageCount: 2,
      secondPageFillRatio: 0.8248,
      renderedWords: 983,
    }), 'accept');
    assert.equal(chooseDynamicPageFitAction({ status: 'underfilled', pageCount: 1 }), 'accept');

    assert.equal(chooseDynamicPageFitAction({
      status: 'overflow',
      pageCount: 3,
      secondPageFillRatio: 0.96,
      renderedWords: 1180,
    }, 0), 'tighten');

    assert.equal(chooseDynamicPageFitAction({
      status: 'overflow',
      pageCount: 3,
      secondPageFillRatio: 0.96,
      renderedWords: 1180,
    }, 1), 'drop-bullet');
  });
});

describe('dynamic resume bullets', () => {
  const draft = {
    TITLE_LINE: 'Senior Sales Engineer',
    ROLES: [
      { roleIndex: 1, context: 'ExtraHop context', bullets: [
        'Aligned CISO stakeholders across a $23M enterprise NDR portfolio through security architecture reviews and technical discovery.',
        'Mapped endpoint security requirements into deployment criteria with enterprise security stakeholders and measurable cybersecurity outcomes.',
      ] },
      { roleIndex: 5, context: 'Older context', bullets: [
        'Supported general account activity without much JD-specific security evidence.',
      ] },
    ],
  };

  it('selects stronger JD-matched bullets before weak older bullets when the budget cannot preserve continuity', () => {
    const planning = buildResumePlanningContext(
      'Sales Engineer owning security architecture, technical discovery, and endpoint security.',
      '',
      'ExtraHop NDR security architecture evidence.'
    );
    const roles = selectDynamicRoleBullets(draft, planning, { budget: 1 });
    assert.equal(roles[0].bullets.length, 1);
    assert.equal(roles[4].bullets.length, 0);
  });

  it('keeps one continuity bullet per role when candidates exist', () => {
    const planning = {
      roleMode: 'customer-success',
      requirements: [{ requirement: 'customer health strategy' }],
    };
    const roles = selectDynamicRoleBullets({
      ROLES: [
        { roleIndex: 1, context: 'Role 1', bullets: ['Improved adoption across enterprise accounts with customer health planning.'] },
        { roleIndex: 2, context: 'Role 2', bullets: ['Improved retention across enterprise accounts with lifecycle governance.'] },
        { roleIndex: 6, context: 'Role 6', bullets: ['Managed an $18M enterprise portfolio across 18 accounts with structured executive engagement.'] },
      ],
    }, planning, { budget: 3 });

    assert.equal(roles[0].bullets.length, 1);
    assert.equal(roles[1].bullets.length, 1);
    assert.equal(roles[5].bullets.length, 1);
  });

  it('flattens selected dynamic bullets into existing template slots and leaves unused slots blank', () => {
    const flattened = flattenDynamicResumeDraft(draft, [
      'TITLE_LINE',
      'JOB_1_CONTEXT',
      'JOB_1_BULLET_1',
      'JOB_1_BULLET_2',
      'JOB_1_BULLET_3',
      'JOB_5_CONTEXT',
      'JOB_5_BULLET_1',
    ], null, { budget: 1 });
    assert.equal(flattened.JOB_1_CONTEXT, 'ExtraHop context');
    assert.ok(flattened.JOB_1_BULLET_1);
    assert.equal(flattened.JOB_1_BULLET_3, '');
    assert.equal(flattened.JOB_5_BULLET_1, '');
  });
});

describe('generic resume evidence review', () => {
  it('asks about both missing requirements and weak quantified proof', () => {
    const requirements = [
      { requirement: 'cross-functional influence', source: 'jd' },
      { requirement: 'renewal and retention ownership', source: 'jd' },
    ];
    const evidenceMap = [
      { requirement: 'cross-functional influence', status: 'gap' },
      { requirement: 'renewal and retention ownership', status: 'supported' },
    ];
    const bragDoc = [
      '### ExampleCo — Senior Customer Success Manager',
      '- Strengthened long-term retention across enterprise customers through executive alignment.',
    ].join('\n');

    const questions = buildGapQuestionCandidates({ requirements, evidenceMap, bragDoc });

    assert.ok(questions.some(item => item.gap === 'cross-functional influence'));
    assert.ok(questions.some(item => item.kind === 'weak-proof'));
  });

  it('surfaces generic people-leadership and operating gaps from a non-security JD', () => {
    const requirements = extractJobRequirements(
      'Manage and develop a team. Coach team members. Drive playbooks, operational consistency, GRR, NRR, lifecycle programs, and 1-to-many automation.',
      ''
    );
    const evidenceMap = buildEvidenceMap(requirements, 'Built onboarding workflows and retained enterprise customers.');
    const questions = buildGapQuestionCandidates({ requirements, evidenceMap, bragDoc: '' });
    const gaps = questions.map(item => item.gap);

    assert.ok(requirements.some(item => item.requirement === 'people management'));
    assert.ok(requirements.some(item => item.requirement === 'team coaching and development'));
    assert.ok(requirements.some(item => item.requirement === 'customer success metrics management'));
    assert.ok(gaps.includes('people management'));
    assert.ok(gaps.includes('team coaching and development'));
  });

  it('detects when page fitting removes previously covered supported requirements', () => {
    const planning = {
      requirements: [{ requirement: 'value realization' }],
      evidenceMap: [{ requirement: 'value realization', status: 'supported' }],
    };
    const before = { JOB_1_BULLET_1: 'Drove value realization across enterprise accounts.' };
    const after = { JOB_1_BULLET_1: '' };

    assert.deepEqual(compareSupportedRequirementCoverage(before, after, planning), ['value realization']);
  });
});

describe('extractJobRequirements section weighting', () => {
  it('ranks a requirement named in the Requirements section above one only in Nice to Have', () => {
    const jd = [
      'Requirements:',
      'Experience with CRM tooling and keeping customer records current is required.',
      '',
      'Nice to have:',
      'Familiarity with BOM review is a plus.',
    ].join('\n');

    const requirements = extractJobRequirements(jd, '');
    const crmIndex = requirements.findIndex(item => item.requirement === 'CRM opportunity hygiene');
    const bomIndex = requirements.findIndex(item => item.requirement === 'BOM review');

    assert.ok(crmIndex >= 0, 'CRM opportunity hygiene should be detected');
    assert.ok(bomIndex >= 0, 'BOM review should be detected');
    assert.ok(requirements[crmIndex].priority > requirements[bomIndex].priority);
  });

  it('preserves existing behavior for JD text with no section headers', () => {
    const requirements = extractJobRequirements(
      'Manage and develop a team. Coach team members. Drive playbooks, operational consistency, GRR, NRR, lifecycle programs, and 1-to-many automation.',
      ''
    );
    assert.ok(requirements.some(item => item.requirement === 'people management'));
    assert.ok(requirements.some(item => item.requirement === 'team coaching and development'));
    assert.ok(requirements.some(item => item.requirement === 'customer success metrics management'));
  });
});

describe('verified-vault evidence enrichment', () => {
  it('tags a requirement backed by 2+ verified facts as strong_match with traceable fact ids', () => {
    const evidenceMap = [{ requirement: 'onboarding project management', status: 'partial', evidenceTerms: [] }];
    const candidateFacts = [
      { id: 'achievement-100', category: 'achievement', verified: true, allowed_in_resume: true, fact: 'Improved onboarding consistency across 87 client relationships.' },
      { id: 'achievement-101', category: 'achievement', verified: true, allowed_in_resume: true, fact: 'Reduced onboarding time by 30% through implementation redesign.' },
    ];
    const enriched = enrichEvidenceMapWithVault(evidenceMap, candidateFacts);

    assert.equal(enriched[0].verifiedTier, 'strong_match');
    assert.deepEqual(new Set(enriched[0].verifiedEvidenceIds), new Set(['achievement-100', 'achievement-101']));
    assert.equal(enriched[0].status, 'partial');
  });

  it('never upgrades a requirement to a stronger tier than the vault actually supports', () => {
    const evidenceMap = [{ requirement: 'AI governance', status: 'gap', evidenceTerms: [] }];
    const candidateFacts = [
      { id: 'skill-050', category: 'skill', verified: true, allowed_in_resume: true, fact: 'Enterprise SIEM and IAM platform administration.' },
    ];
    const enriched = enrichEvidenceMapWithVault(evidenceMap, candidateFacts);

    // 'AI governance' isn't a closed-list requirement (unlike certifications),
    // so zero verified hits classifies as 'unknown' (not confirmed absent),
    // not 'gap' — classifyRequirement's own documented distinction.
    assert.equal(enriched[0].verifiedTier, 'unknown');
    assert.deepEqual(enriched[0].verifiedEvidenceIds, []);
  });

  it('falls back to the unenriched evidence map when no candidate facts are available', () => {
    const evidenceMap = [{ requirement: 'onboarding project management', status: 'partial', evidenceTerms: [] }];
    const enriched = enrichEvidenceMapWithVault(evidenceMap, []);
    assert.deepEqual(enriched, evidenceMap);
  });
});

describe('generic resume evidence review extra matching', () => {
  it('does not treat a short alias as a hit when it only appears inside an unrelated word', () => {
    const requirements = [{ requirement: 'SME positioning' }];
    const evidenceMap = buildEvidenceMap(
      requirements,
      'Helped customers who felt the onboarding process smelled off get back on track quickly.'
    );
    assert.equal(evidenceMap.find(item => item.requirement === 'SME positioning').status, 'gap');
  });

  it('still matches a short alias when it appears as its own word', () => {
    const requirements = [{ requirement: 'SME positioning' }];
    const evidenceMap = buildEvidenceMap(
      requirements,
      'Positioned as the SME for enterprise identity architecture during executive reviews.'
    );
    assert.equal(evidenceMap.find(item => item.requirement === 'SME positioning').status, 'supported');
  });
});

describe('page-fit bullet floor', () => {
  it('never drops a role to zero bullets while another role still has a droppable bullet', () => {
    const planningContext = { roleMode: 'customer-success', requirements: [] };
    const replacements = {
      JOB_1_BULLET_1: 'Managed a $23M enterprise portfolio across 30 accounts with executive stakeholder alignment.',
      JOB_1_BULLET_2: 'Drove 98% retention through structured account health reviews and CISO business reviews.',
      JOB_1_BULLET_3: 'Reduced churn by identifying at-risk accounts and coordinating cross-functional recovery plans.',
      JOB_5_BULLET_1: 'Supported day-to-day account activity without a specific metric.',
    };

    let current = { ...replacements };
    for (let i = 0; i < 2; i += 1) {
      const drop = lowestPrioritySelectedBullet(current, planningContext);
      assert.ok(drop, `expected a droppable bullet on iteration ${i}`);
      assert.notEqual(drop.field, 'JOB_5_BULLET_1', `role 5's only bullet should not be dropped while role 1 still has more than one (iteration ${i})`);
      current = { ...current, [drop.field]: '' };
    }
  });

  it('falls back to score-only tie-breaking once every role is already down to one bullet, without throwing', () => {
    const planningContext = { roleMode: 'customer-success', requirements: [] };
    // Both roles already at the floor (one bullet each) — the per-role-floor
    // guard has nothing left to protect, so this must fall back to picking
    // by score alone rather than getting stuck with an empty candidate pool.
    const replacements = {
      JOB_1_BULLET_1: 'Drove 98% retention through structured account health reviews and CISO business reviews.',
      JOB_5_BULLET_1: 'Supported day-to-day account activity without a specific metric.',
    };

    const drop = lowestPrioritySelectedBullet(replacements, planningContext);

    assert.ok(drop, 'expected a bullet to be returned even with both roles at the floor');
    assert.equal(drop.field, 'JOB_5_BULLET_1', 'the lower-scoring of the two remaining bullets should be picked');
  });

  it('protects the only bullet covering a covered top-priority requirement over a higher-scoring but redundant one', () => {
    const planningContext = {
      roleMode: 'customer-success',
      requirements: [{ requirement: 'customer escalation management', source: 'jd', priority: 9 }],
      evidenceMap: [{ requirement: 'customer escalation management', status: 'supported' }],
    };
    const replacements = {
      JOB_1_BULLET_1: 'Drove 98% retention and $23M portfolio growth through structured account health reviews.',
      JOB_1_BULLET_2: 'Owned customer escalations end to end, coordinating recovery planning across support and engineering.',
      JOB_5_BULLET_1: 'Supported day-to-day account activity without a specific metric.',
    };

    const drop = lowestPrioritySelectedBullet(replacements, planningContext);

    assert.notEqual(drop.field, 'JOB_1_BULLET_2', 'should not drop the sole bullet covering the covered top-priority requirement');
  });
});

describe('summary sentence repetition', () => {
  it('flags consecutive PROFESSIONAL_SUMMARY sentences that open with the same words', () => {
    const planningContext = { roleMode: 'customer-success', requirements: [] };
    const issues = critiqueResumeDraft({
      PROFESSIONAL_SUMMARY: 'Supported enterprise customers across endpoint and network security deployments, helping resolve escalations and maintain platform stability. Supported enterprise customers adopting identity and access management (IAM) platforms, helping teams integrate authentication workflows and stabilize production deployments.',
    }, planningContext);

    assert.ok(issues.some(issue => issue.code === 'repeated-summary-opener' && issue.field === 'PROFESSIONAL_SUMMARY'));
  });

  it('does not flag a summary whose sentences open differently and cover different ground', () => {
    const planningContext = { roleMode: 'customer-success', requirements: [] };
    const issues = critiqueResumeDraft({
      PROFESSIONAL_SUMMARY: 'Led enterprise customer success across a $23M ARR portfolio. Reduced onboarding time by 30% through implementation redesign.',
    }, planningContext);

    assert.ok(!issues.some(issue => issue.code === 'repeated-summary-opener'));
    assert.ok(!issues.some(issue => issue.code === 'near-duplicate-summary-sentence'));
  });

  it('flags near-duplicate summary sentences even when their openers differ', () => {
    const planningContext = { roleMode: 'customer-success', requirements: [] };
    const issues = critiqueResumeDraft({
      PROFESSIONAL_SUMMARY: 'Reduced onboarding time across enterprise SIEM customers through process redesign and stakeholder alignment. Cut onboarding time across enterprise SIEM customers through process redesign and stakeholder alignment.',
    }, planningContext);

    assert.ok(issues.some(issue => issue.code === 'near-duplicate-summary-sentence' && issue.field === 'PROFESSIONAL_SUMMARY'));
  });
});

describe('JD coverage audit', () => {
  it('separates covered, missing-despite-evidence, unsupported-gap, and buried requirements', () => {
    const requirements = [
      { requirement: 'onboarding project management', source: 'jd', priority: 9 },
      { requirement: 'people management', source: 'jd', priority: 8 },
      { requirement: 'renewal and retention ownership', source: 'jd', priority: 7 },
      { requirement: 'CRM opportunity hygiene', source: 'jd', priority: 1 },
    ];
    const evidenceMap = [
      { requirement: 'onboarding project management', status: 'supported' },
      { requirement: 'people management', status: 'supported' },
      { requirement: 'renewal and retention ownership', status: 'supported' },
      { requirement: 'CRM opportunity hygiene', status: 'gap' },
    ];
    const replacements = {
      KEY_ACHIEVEMENT_1: 'Improved onboarding consistency across 87 client relationships.',
      JOB_1_BULLET_1: 'Resolved complex escalations across support and product functions.',
      JOB_5_BULLET_1: 'Owned renewal execution and expansion for a mid-market book of business.',
    };

    const audit = auditJdCoverage({ requirements, evidenceMap, replacements });

    assert.ok(audit.covered.includes('onboarding project management'));
    assert.ok(!audit.buried.includes('onboarding project management'));
    assert.ok(audit.missingWithEvidence.includes('people management'));
    assert.ok(audit.covered.includes('renewal and retention ownership'));
    assert.ok(audit.buried.includes('renewal and retention ownership'));
    assert.ok(audit.unsupportedGaps.includes('CRM opportunity hygiene'));
  });

  it('prefers the vault-backed verifiedTier over the raw text-heuristic status when both are present', () => {
    // status says 'partial' (weak text-search hit), but the vault tier says
    // 'unknown' (no verified fact actually supports it) — the stronger,
    // fact-traced signal must win, since that's the whole point of wiring
    // enrichEvidenceMapWithVault into the audit.
    const requirements = [{ requirement: 'CRM opportunity hygiene', source: 'jd', priority: 5 }];
    const evidenceMap = [{ requirement: 'CRM opportunity hygiene', status: 'partial', verifiedTier: 'unknown', verifiedEvidenceIds: [] }];
    const replacements = { PROFESSIONAL_SUMMARY: 'Kept customer records current across a $23M portfolio.' };

    const audit = auditJdCoverage({ requirements, evidenceMap, replacements });

    assert.ok(audit.unsupportedGaps.includes('CRM opportunity hygiene'));
    assert.ok(!audit.covered.includes('CRM opportunity hygiene'));
    assert.ok(!audit.missingWithEvidence.includes('CRM opportunity hygiene'));
  });
});

describe('generic JD source selection', () => {
  it('prefers a role-specific stored JD over a stale generic report scrape', () => {
    const selected = selectBestJobDescription({
      title: 'Manager, Customer Success',
      full_description: 'About the job. The Manager, Customer Success will manage and develop a team, coach team members, monitor GRR and NRR, and drive onboarding consistency. What You Will Do: build playbooks. What You Will Bring: 6+ years of experience.',
      description_preview: 'Manager, Customer Success',
    }, [
      '## Job Description',
      'Careers | Example Skip to main content Book a demo Download the app Footer Privacy Policy Website Terms',
      'Our mission is to help people thrive.',
      '## AI Analysis',
      'No role found.',
    ].join('\n'));

    assert.equal(selected.source, 'full_description');
    assert.match(selected.text, /coach team members/i);
  });

  it('marks navigation-heavy scrapes as unusable before drafting', () => {
    const assessment = assessJobDescription({
      title: 'Manager, Customer Success',
      full_description: 'Careers | Example Skip to main content Book a demo Download the app Footer Privacy Policy Website Terms',
    });

    assert.equal(assessment.usable, false);
  });
});

describe('repairThinSummary (one targeted local repair)', () => {
  const TRUTH = 'Brian led ExtraHop NDR and Securonix SIEM enterprise renewals across a $23M ARR portfolio, built the customer success function at Total Trial Services with 8 direct reports, and ran executive business reviews with CISO stakeholders at Securonix.';
  const SHORT = 'Customer success leader for enterprise cybersecurity accounts across NDR and SIEM platforms. Drives renewals, adoption, and executive alignment for security customers at enterprise scale.';
  const GOOD = 'Enterprise customer success leader who ran ExtraHop enterprise renewals across a $23M ARR portfolio and executive business reviews with CISO stakeholders at Securonix. Built the customer success function at Total Trial Services with 8 direct reports, turning adoption and renewal work into a repeatable operating model. Brings hands-on portfolio ownership, stakeholder alignment, and renewal discipline to growing security customer programs.';

  async function run(summary, lmText, env = {}) {
    const calls = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      calls.push(String(url));
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: lmText } }] }), text: async () => '' };
    };
    try {
      let out;
      await withEnv({ CAREER_OPS_DISABLE_LM_STUDIO: undefined, ...env }, async () => {
        out = await repairThinSummary({ PROFESSIONAL_SUMMARY: summary, TITLE_LINE: 'Customer Success Leader' }, { candidateTruth: TRUTH, jdText: 'Customer Success Manager for security customers.' });
      });
      return { out, calls };
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  const EXTRA = 'Built the customer success function at Total Trial Services with 8 direct reports and ran executive business reviews with CISO stakeholders at Securonix.';
  const THREE_SHORT = 'Customer success leader. Drives renewals for security customers. Leads enterprise adoption.';

  it('adds one grounded sentence to a thin 2-sentence summary', async () => {
    const { out, calls } = await run(SHORT, JSON.stringify({ SENTENCE: EXTRA }));
    assert.equal(out.PROFESSIONAL_SUMMARY, `${SHORT} ${EXTRA}`);
    assert.equal(calls.length, 1);
    assert.match(calls[0], /^http:\/\/localhost:1234\//);
  });

  it('rewrites a thin 3-sentence summary in one call', async () => {
    const { out, calls } = await run(THREE_SHORT, JSON.stringify({ PROFESSIONAL_SUMMARY: GOOD }));
    assert.equal(out.PROFESSIONAL_SUMMARY, GOOD);
    assert.equal(calls.length, 1);
  });

  it('keeps the original when the addition invents claims, with no second attempt', async () => {
    const invented = 'After 12 years at Palo Alto Networks as a CISSP-certified director, built the customer success function at Total Trial Services.';
    const { out, calls } = await run(SHORT, JSON.stringify({ SENTENCE: invented }));
    assert.equal(out.PROFESSIONAL_SUMMARY, SHORT);
    assert.equal(calls.length, 1);
  });

  it('keeps the original when the result is still too thin', async () => {
    const { out, calls } = await run(SHORT, JSON.stringify({ SENTENCE: 'Customer success leader.' }));
    assert.equal(out.PROFESSIONAL_SUMMARY, SHORT);
    assert.equal(calls.length, 1);
  });

  it('falls back to one verified evidence sentence when the local extension is rejected (no second call)', async () => {
    const calls = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      calls.push(String(url));
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify({ SENTENCE: 'Built the program at Arms Cyber over 25 years.' }) } }] }), text: async () => '' };
    };
    try {
      let out;
      await withEnv({ CAREER_OPS_DISABLE_LM_STUDIO: undefined }, async () => {
        out = await repairThinSummary({ PROFESSIONAL_SUMMARY: SHORT }, {
          supportTexts: [TRUTH],
          evidenceFallback: () => EXTRA,
        });
      });
      assert.equal(out.PROFESSIONAL_SUMMARY, `${SHORT} ${EXTRA}`);
      assert.equal(calls.length, 1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('for a thin 3-sentence summary, swaps the shortest sentence for one verified evidence sentence', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{}' } }] }), text: async () => '' });
    const three = 'Customer success leader for enterprise cybersecurity accounts across NDR and SIEM platforms and renewals. Drives renewals and adoption. Leads enterprise alignment and renewal planning for security customers at enterprise scale.';
    try {
      let out;
      await withEnv({ CAREER_OPS_DISABLE_LM_STUDIO: undefined }, async () => {
        out = await repairThinSummary({ PROFESSIONAL_SUMMARY: three }, { supportTexts: [TRUTH], evidenceFallback: () => EXTRA });
      });
      assert.equal(out.PROFESSIONAL_SUMMARY, 'Customer success leader for enterprise cybersecurity accounts across NDR and SIEM platforms and renewals. ' + EXTRA + ' Leads enterprise alignment and renewal planning for security customers at enterprise scale.');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('fills a very thin 1-sentence summary with up to two verified sentences (max 3 total)', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{}' } }] }), text: async () => '' });
    const one = 'Customer success leader for enterprise cybersecurity accounts.';
    const second = 'Led ExtraHop NDR and Securonix SIEM enterprise renewals across a $23M ARR portfolio for enterprise customers.';
    try {
      let out;
      await withEnv({ CAREER_OPS_DISABLE_LM_STUDIO: undefined }, async () => {
        out = await repairThinSummary({ PROFESSIONAL_SUMMARY: one }, { supportTexts: [TRUTH], evidenceFallback: () => [EXTRA, second] });
      });
      assert.equal(out.PROFESSIONAL_SUMMARY, `${one} ${EXTRA} ${second}`);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('picks the highest-ranked verified sentences that actually reach the floor', () => {
    const one = 'Customer success leader for enterprise cybersecurity accounts.';
    const tiny = 'Ran QBRs.';
    const second = 'Led ExtraHop NDR and Securonix SIEM enterprise renewals across a $23M ARR portfolio for enterprise customers.';
    const out = extendSummaryWithEvidence({ PROFESSIONAL_SUMMARY: one }, { supportTexts: [TRUTH, tiny], evidenceFallback: () => [tiny, EXTRA, second] });
    assert.equal(out.PROFESSIONAL_SUMMARY, `${one} ${EXTRA} ${second}`);
  });

  it('rebuilds an emptied or unfixable summary entirely from verified sentences', () => {
    const second = 'Led ExtraHop NDR and Securonix SIEM enterprise renewals across a $23M ARR portfolio for enterprise customers.';
    const third = 'Ran executive business reviews with CISO stakeholders at Securonix for enterprise customers across NDR and SIEM platforms.';
    const expected = `${EXTRA} ${second} ${third}`;
    const empty = extendSummaryWithEvidence({ PROFESSIONAL_SUMMARY: '' }, { supportTexts: [TRUTH], evidenceFallback: () => [EXTRA, second, third] });
    assert.equal(empty.PROFESSIONAL_SUMMARY, expected);
    const twoShort = extendSummaryWithEvidence(
      { PROFESSIONAL_SUMMARY: 'Customer success leader. Drives renewals.' },
      { supportTexts: [TRUTH], evidenceFallback: () => [EXTRA, second, third] },
    );
    assert.equal(twoShort.PROFESSIONAL_SUMMARY, expected);
  });

  it('does nothing when the summary already meets 45 words or LM Studio is disabled', async () => {
    assert.equal((await run(GOOD, '{}')).calls.length, 0);
    const disabled = await run(SHORT, '{}', { CAREER_OPS_DISABLE_LM_STUDIO: '1' });
    assert.equal(disabled.calls.length, 0);
    assert.equal(disabled.out.PROFESSIONAL_SUMMARY, SHORT);
  });
});

describe('ensureLocalModelContext', () => {
  const model = 'qwen2.5-coder-7b-instruct-mlx';
  function deps(info) {
    const execs = [];
    return {
      execs,
      options: {
        model,
        contextTokens: 16384,
        fetchImpl: async () => ({ ok: true, json: async () => info }),
        execImpl: async (file, args) => { execs.push([file, ...args].join(' ')); },
        lmsPath: '/fake/lms',
        exists: () => true,
      },
    };
  }

  it('does nothing when the model is already loaded with enough context', async () => {
    const { execs, options } = deps({ state: 'loaded', loaded_context_length: 16384 });
    assert.equal(await ensureLocalModelContext(options), 'ready');
    assert.deepEqual(execs, []);
  });

  it('loads the model with the configured context and an idle TTL when not loaded', async () => {
    const { execs, options } = deps({ state: 'not-loaded' });
    assert.equal(await ensureLocalModelContext(options), 'loaded');
    assert.deepEqual(execs, [`/fake/lms load ${model} --context-length 16384 --ttl 3600 -y`]);
  });

  it('reloads a model that was loaded with too small a context', async () => {
    const { execs, options } = deps({ state: 'loaded', loaded_context_length: 4096 });
    assert.equal(await ensureLocalModelContext(options), 'loaded');
    assert.deepEqual(execs, [`/fake/lms unload ${model}`, `/fake/lms load ${model} --context-length 16384 --ttl 3600 -y`]);
  });

  it('leaves loading to LM Studio when the lms CLI is unavailable', async () => {
    const { execs, options } = deps({ state: 'not-loaded' });
    assert.equal(await ensureLocalModelContext({ ...options, exists: () => false }), 'no-cli');
    assert.deepEqual(execs, []);
  });
});

describe('structured model output becomes resume text', () => {
  it('renders object/array field values in the template format instead of [object Object]', () => {
    assert.equal(
      sanitizeResumeLanguage({ 'Customer Success': ['Adoption', 'Renewals'], 'Security Domains': ['NDR', 'SIEM'] }),
      'Customer Success: Adoption, Renewals | Security Domains: NDR, SIEM',
    );
    assert.equal(sanitizeResumeLanguage(['QBRs', 'Renewals']), 'QBRs, Renewals');
    assert.equal(sanitizeResumeLanguage('plain text'), 'plain text');
  });

  it('flattens a synthesized object CORE_COMPETENCIES into text', () => {
    const out = flattenDynamicResumeDraft(
      { CORE_COMPETENCIES: { 'Customer Success': ['Adoption', 'Renewals'] }, ROLES: [] },
      ['CORE_COMPETENCIES'],
      null,
    );
    assert.equal(sanitizeResumeLanguage(out.CORE_COMPETENCIES), 'Customer Success: Adoption, Renewals');
  });

  it('quality gate rejects serialized objects', () => {
    assert.throws(() => validateResumeQuality({ CORE_COMPETENCIES: '[object Object]' }, ['CORE_COMPETENCIES']), /object/i);
  });

  it('collapses immediately repeated words and parentheticals', () => {
    assert.equal(sanitizeResumeLanguage('$55M ARR Portfolio (Peak) (Peak)'), '$55M ARR Portfolio (Peak)');
    assert.equal(sanitizeResumeLanguage('Led the the renewal'), 'Led the renewal');
  });

  it('drops a repeated METRICS_LINE segment', () => {
    assert.equal(
      dedupeMetricsLine('$23M ARR, 98% GRR, 120% NRR | $55M ARR Portfolio (Peak) | 120% NRR'),
      '$23M ARR, 98% GRR, 120% NRR | $55M ARR Portfolio (Peak)',
    );
    assert.equal(dedupeMetricsLine('$13M renewal | 98% GRR'), '$13M renewal | 98% GRR');
    assert.equal(dedupeMetricsLine('$55M ARR Portfolio (Peak) | 120% NRR | Net Revenue Retention: 120%'), '$55M ARR Portfolio (Peak) | 120% NRR');
  });
});

describe('gap questions already answered', () => {
  it('does not re-ask a gap that already has a saved answer in Recovered Evidence', () => {
    const bragDoc = [
      '## ExtraHop', 'Managed enterprise accounts.', '',
      '---', '', '## Recovered Evidence', '',
      '- customer health management: I built customer health management at Securonix.',
      '- AI governance: unverified. Ask for a concrete sample first.', '',
    ].join('\n');
    const candidates = buildGapQuestionCandidates({
      requirements: [
        { requirement: 'customer health management', source: 'jd' },
        { requirement: 'AI governance', source: 'jd' },
        { requirement: 'RFP/RFI response', source: 'jd' },
      ],
      evidenceMap: [
        { requirement: 'customer health management', status: 'partial' },
        { requirement: 'AI governance', status: 'gap' },
        { requirement: 'RFP/RFI response', status: 'gap' },
      ],
      bragDoc,
    });
    assert.deepEqual(candidates.map(c => c.gap), ['RFP/RFI response']);
  });

  it('matches saved answers regardless of letter case', () => {
    const candidates = buildGapQuestionCandidates({
      requirements: [{ requirement: 'customer health management', source: 'jd' }],
      evidenceMap: [{ requirement: 'customer health management', status: 'partial' }],
      bragDoc: '## Recovered Evidence\n\n- Customer Health Management: yes\n',
    });
    assert.deepEqual(candidates, []);
  });
});

describe('DOCX-first resume finish', () => {
  it('fails the quality gate on a weak bullet instead of padding it with filler', async () => {
    await withEnv({ CAREER_OPS_DISABLE_LM_STUDIO: '1', CANDIDATE_EVIDENCE_MODE: 'off', RESUME_PDF_EXPORT: '0', RESUME_PAGE_VALIDATION: '0' }, async () => {
      const state = finishState(`quality-repair-${Date.now()}`);
      state.fields = ['PROFESSIONAL_SUMMARY', 'KEY_ACHIEVEMENT_1', 'JOB_1_CONTEXT', 'JOB_1_BULLET_1', 'JOB_2_BULLET_3'];
      state.replacements = {
        ...VALID_REPLACEMENTS,
        JOB_2_BULLET_3: 'Managed customer relationships and supported implementation planning for accounts.',
      };
      await assert.rejects(generateResumeFinish(state), /JOB_2_BULLET_3: bullet is too short/);
      assert.match(state.io.events.map(event => event.payload?.stage).join('\n'), /quality-repair/);
    });
  });

  it('sends AI requests only to local LM Studio even when an Anthropic key is configured', async () => {
    const calls = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, init = {}) => {
      calls.push(`${url} ${JSON.stringify(init.headers || {})}`);
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{}' } }] }), text: async () => '{}' };
    };
    try {
      await withEnv({
        CANDIDATE_EVIDENCE_MODE: 'off', // this test is about request routing
        ANTHROPIC_API_KEY: 'sk-ant-test-key-should-never-be-used',
        CAREER_OPS_DISABLE_LM_STUDIO: undefined,
        RESUME_PDF_EXPORT: '0',
        RESUME_PAGE_VALIDATION: '0',
      }, async () => {
        const state = finishState(`local-ai-only-${Date.now()}`);
        state.replacements = {
          ...VALID_REPLACEMENTS,
          JOB_2_BULLET_3: 'Managed customer relationships and supported implementation planning for accounts.',
        };
        const result = await generateResumeFinish(state);
        assert.ok(result.docxUrl.endsWith('.docx'));
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
    assert.ok(calls.length > 0, 'expected the finish pipeline to make local AI requests');
    for (const call of calls) {
      assert.match(call, /^http:\/\/localhost:1234\//);
      assert.doesNotMatch(call, /anthropic|sk-ant-/i);
    }
  });

  it('repairs pre-sales framing issues before polish with clean progress payloads', async () => {
    await withEnv({ CAREER_OPS_DISABLE_LM_STUDIO: '1', CANDIDATE_EVIDENCE_MODE: 'off', RESUME_PDF_EXPORT: '0', RESUME_PAGE_VALIDATION: '0' }, async () => {
      const state = finishState(`draft-critique-${Date.now()}`);
      state.planningContext = buildResumePlanningContext(
        'Senior Client Solutions Engineer owning pre-sales discovery, solution sizing, BOM review, cloud management, and security architecture.',
        '',
        'ExtraHop NDR architecture and Securonix SIEM log ingestion advisory for enterprise CISOs.'
      );
      state.fields = [
        'TITLE_LINE',
        'PROFESSIONAL_SUMMARY',
        'CORE_COMPETENCIES',
        ...FIELDS,
      ];
      state.replacements = {
        TITLE_LINE: 'Enterprise Customer Success Leader | Retention | Renewals',
        CORE_COMPETENCIES: 'Customer success, renewals, QBRs',
        ...VALID_REPLACEMENTS,
      };

      const result = await generateResumeFinish(state);

      assert.ok(result.docxUrl.endsWith('.docx'));
      assert.match(state.io.events.map(event => event.payload?.stage).join('\n'), /draft-critique/);
      assert.ok(state.io.events.every(event => !Object.hasOwn(event.payload || {}, '0')));
    });
  });

  it('succeeds with a DOCX result when PDF export is disabled', async () => {
    await withEnv({ CAREER_OPS_DISABLE_LM_STUDIO: '1', CANDIDATE_EVIDENCE_MODE: 'off', RESUME_PDF_EXPORT: '0', RESUME_PAGE_VALIDATION: '0' }, async () => {
      const state = finishState(`docx-only-${Date.now()}`);
      const result = await generateResumeFinish(state);

      assert.match(result.docxUrl, /^\/output\/.+\.docx$/);
      assert.equal(result.pdfUrl, null);
      assert.deepEqual(result.pageValidation, {
        status: 'skipped',
        message: 'PDF validation disabled',
      });
      assert.ok(fs.existsSync(path.resolve(APP_ROOT, result.docxUrl.slice(1))));
      assert.ok(state.io.events.some(({ event }) => event === 'complete'));
    });
  });

  it('does not fail generation when PDF tools are missing', async () => {
    await withEnv({
      CAREER_OPS_DISABLE_LM_STUDIO: '1',
      CANDIDATE_EVIDENCE_MODE: 'off',
      RESUME_PDF_EXPORT: '1',
      RESUME_PAGE_VALIDATION: '0',
      RESUME_SOFFICE_PATH: '/definitely/missing/soffice',
    }, async () => {
      const state = finishState(`missing-pdf-tools-${Date.now()}`);
      const result = await generateResumeFinish(state);

      assert.match(result.docxUrl, /^\/output\/.+\.docx$/);
      assert.equal(result.pdfUrl, null);
      assert.equal(result.pageValidation.status, 'skipped');
      assert.ok(fs.existsSync(path.resolve(APP_ROOT, result.docxUrl.slice(1))));
    });
  });

  it('keeps the completion payload backward compatible', async () => {
    await withEnv({ CAREER_OPS_DISABLE_LM_STUDIO: '1', CANDIDATE_EVIDENCE_MODE: 'off', RESUME_PDF_EXPORT: '0', RESUME_PAGE_VALIDATION: '0' }, async () => {
      const state = finishState(`compat-${Date.now()}`);
      const result = await generateResumeFinish(state);
      const complete = state.io.events.find(({ event }) => event === 'complete');

      assert.ok(complete);
      assert.equal(complete.payload.docxUrl, result.docxUrl);
      assert.equal(complete.payload.pdfUrl, null);
      assert.deepEqual(complete.payload.pageValidation, result.pageValidation);
    });
  });
});

describe('active resume prompts', () => {
  const source = fs.readFileSync(path.resolve(APP_ROOT, 'lib', 'resume-gen.mjs'), 'utf8');

  it('does not reintroduce the old 12-word or hard-concision constraints', () => {
    assert.doesNotMatch(source, /12 words/i);
    assert.doesNotMatch(source, /concise bullets/i);
    assert.doesNotMatch(source, /brief bullets/i);
    assert.doesNotMatch(source, /one-line bullets/i);
    assert.doesNotMatch(source, /tight bullets/i);
    assert.doesNotMatch(source, /max words/i);
  });

  it('does not require every fixed template bullet slot to be populated', () => {
    assert.doesNotMatch(source, /Use all listed bullet fields/);
    assert.match(source, /ROLES=array of six chronological role objects/);
  });

  it('keeps active prompts aligned to word and character targets', () => {
    assert.match(source, /22-34 words/);
    assert.match(source, /175-240 characters/);
    assert.match(source, /140-210 characters/);
    assert.match(source, /scope, concrete action\/mechanism, domain language, and measurable outcome/);
    assert.match(source, /Do not over-compress useful detail|do not over-compress useful detail/);
  });

  it('carries the five resume improvement principles into active prompts and section planning', () => {
    assert.match(source, /Lead with measurable results/);
    assert.match(source, /Tailor to the exact JD/);
    assert.match(source, /Strengthen the top third/);
    assert.match(source, /Write clear impact bullets/);
    assert.match(source, /Remove clutter/);
    assert.match(source, /RESUME IMPROVEMENT CHECKLIST/);
    assert.match(source, /UNIVERSAL RESUME IMPROVEMENT STANDARD/);
  });

  it('carries top-1% applicant principles into active prompts and section planning', () => {
    assert.match(source, /Increase evidence density/);
    assert.match(source, /Show judgment, not activity/);
    assert.match(source, /Match the role business model/);
    assert.match(source, /Make accomplishments hard to copy/);
    assert.match(source, /final hiring-manager rejection lens/);
    assert.match(source, /TOP-1% APPLICANT CHECKLIST/);
    assert.match(source, /TOP-1% APPLICANT STANDARD/);
  });

  it('detects pre-sales solution architecture roles from JD language', () => {
    const jd = [
      'Senior Client Solutions Engineer',
      'Own pre-sales technical sales campaigns for enterprise data center infrastructure.',
      'Provide solution sizing, BOM review, cloud management guidance, security architecture, SME positioning, and leadership across technical stakeholders.',
      'Saved evaluation notes may mention technical account manager adjacency, but the JD title still controls the pre-sales frame.',
    ].join('\n');

    assert.equal(inferResumePositioningMode(jd), 'pre-sales-solutions-architecture');
    assert.equal(classifyResumeRole(jd), 'pre-sales-solutions-architecture');
  });

  it('keeps pre-sales resume guidance out of post-sale CS framing', () => {
    assert.match(source, /Do not default to Customer Success language/);
    assert.match(source, /TITLE_LINE must mirror the JD function/);
    assert.match(source, /CORE_COMPETENCIES should be the only skills\/platform section/);
    assert.match(source, /Do not create or imply a duplicate Tools & Platforms block/);
    assert.match(source, /ExtraHop bullets should prioritize architecture design decisions/);
    assert.match(source, /Securonix bullets should lead with SIEM\/log ingestion architecture/);
    assert.match(source, /Downrank renewals, retention, NRR, churn prevention/);
  });

  it('carries operator and differentiation standards into active prompts', () => {
    assert.match(source, /operator, not a relationship manager/i);
    assert.match(source, /Exact role titles only/);
    assert.match(source, /7-SECOND SCAN/);
    assert.match(source, /measurable impact, scope, method\/system, stakeholder, and business outcome/);
    assert.match(source, /best-in-class/);
    assert.match(source, /three consecutive gerund-opening bullets/);
  });

  it('applies the shared humanizer standard to resume output passes', () => {
    assert.match(source, /HUMANIZED_OUTPUT_RULES/);
    assert.match(source, /withHumanizer/);
    assert.match(source, /Apply the humanizer standard/);
    assert.match(source, /Rewrite these resume bullets/);
    assert.match(source, /Repair only the listed resume fields/);
  });

  it('builds candidate truth context from brag doc, Profile.pdf text, and v3 template', () => {
    const context = buildCandidateTruthContext({
      bragDoc: 'ExtraHop $23M ARR and exact role evidence.',
      linkedInText: 'LinkedIn exported profile with chronology and titles.',
      templatePath: '/tmp/FINAL Brian Milhizer Production Resume Template v3.dotx',
    });

    assert.match(context, /PRIMARY RESUME SOURCES OF TRUTH/);
    assert.match(context, /master-brag-document\.md/);
    assert.match(context, /Profile\.pdf/);
    assert.match(context, /FINAL Brian Milhizer Production Resume Template v3\.dotx/);
    assert.match(context, /ExtraHop \$23M ARR/);
    assert.match(context, /LinkedIn exported profile/);
  });

  it('extracts JD-specific requirements for pre-sales architecture roles', () => {
    const requirements = extractJobRequirements(
      'Own solution sizing, BOM review, data center infrastructure, cloud management, and security architecture.',
      'technical discovery, SME positioning'
    ).map(item => item.requirement);

    assert.ok(requirements.includes('solution sizing'));
    assert.ok(requirements.includes('BOM review'));
    assert.ok(requirements.includes('data center infrastructure'));
    assert.ok(requirements.includes('cloud management'));
    assert.ok(requirements.includes('security architecture'));
    assert.ok(requirements.includes('technical discovery'));
  });

  it('extracts JD signal analysis for domain, stakeholders, power nouns, and priorities', () => {
    const signals = extractJdSignals(
      'Own SIEM telemetry, detection engineering, risk posture, cloud security architecture, and commercial renewal lifecycle with CISOs, SOC Directors, and DevSecOps.',
      'log ingestion, solution sizing'
    );

    assert.equal(signals.primaryDomain, 'SIEM/SOC');
    assert.ok(signals.powerNouns.includes('telemetry'));
    assert.ok(signals.powerNouns.includes('risk posture'));
    assert.ok(signals.hiddenStakeholders.includes('CISO'));
    assert.ok(signals.hiddenStakeholders.includes('SOC Director'));
    assert.ok(signals.unstatedPriorities.some(priority => /commercial operator/i.test(priority)));
  });

  it('maps unsupported requirements as gaps instead of inventing evidence', () => {
    const requirements = [
      { requirement: 'BOM review' },
      { requirement: 'SIEM/log ingestion architecture' },
    ];
    const evidence = buildEvidenceMap(
      requirements,
      'Built Securonix SIEM log ingestion workflows and UEBA integrations for enterprise security teams.'
    );

    assert.equal(evidence.find(item => item.requirement === 'BOM review').status, 'gap');
    assert.equal(evidence.find(item => item.requirement === 'SIEM/log ingestion architecture').status, 'supported');
  });

  it('plans pre-sales sections with technical positioning and tools/platforms guidance', () => {
    const requirements = extractJobRequirements(
      'Client Solutions Engineer owning pre-sales discovery, security architecture, and cloud management.',
      ''
    );
    const evidenceMap = buildEvidenceMap(requirements, 'ExtraHop NDR, Securonix SIEM, AWS, Azure, Salesforce, and executive security advisory.');
    const plan = buildResumeSectionPlan({
      roleMode: 'pre-sales-solutions-architecture',
      requirements,
      evidenceMap,
    });

    assert.match(plan.taglineDirective, /pre-sales|client-solutions/i);
    assert.match(plan.summaryThesis, /technical advisor|pre-sales solution architect/i);
    assert.match(plan.toolsPlatformsDirective, /Tools & Platforms|Security Platforms/i);
    assert.ok(plan.downrankVocabulary.includes('renewal'));
  });

  it('detects MSP compliance delivery leadership roles before generic leadership', () => {
    const jd = [
      'Director of Customer Success for a managed services provider.',
      'Own execution coordination, onboarding project management, corrective action plans, technology rollouts, environment builds, dashboards, ticket queues, backlog, and escalation accountability.',
      'Lead team standards for compliance program delivery across cybersecurity customers.',
    ].join('\n');

    assert.equal(classifyResumeRole(jd), 'msp-compliance-delivery');
  });

  it('detects strategic customer success leadership roles before generic leadership', () => {
    const jd = [
      'Director, Customer Success',
      'Lead, coach, and develop a team supporting strategic enterprise accounts.',
      'Define customer success strategy across retention, adoption, customer health, executive engagement, value realization, customer planning, and segmentation.',
      'Operate in a high-growth environment with cross-functional Product, Sales, Marketing, and Operations partners.',
    ].join('\n');

    assert.equal(classifyResumeRole(jd), 'strategic-cs-leadership');
  });

  it('detects Nebulock-style startup CSM builder roles before generic CS', () => {
    const jd = [
      'Customer Success Manager at a fast-paced cybersecurity startup.',
      'Own process design and implementation by designing, building, and iterating scalable onboarding workflows and customer support processes from the ground up.',
      'Use AI-driven efficiency with ChatGPT, Claude, or Gemini, serve as Voice of the Customer, act as the internal quarterback across Product, Engineering, Sales, and Marketing, and lead onsite Strategic Business Reviews and security workshops.',
      'The platform focuses on threat hunting, behavioral detections, endpoint telemetry, identity telemetry, cloud telemetry, credential misuse, lateral movement, and post-access activity.',
    ].join('\n');

    assert.equal(classifyResumeRole(jd), 'startup-cs-builder');
  });

  it('does not classify an ordinary enterprise CSM JD as startup-cs-builder just because it mentions voice of the customer or process design', () => {
    const jd = 'Customer Success Manager. Manage a portfolio of enterprise accounts. Lead kickoff meetings, success reviews, and Executive Business Reviews. Represent the voice of the customer by providing feedback to Product Management. Contribute to continuous process design improvements based on customer feedback.';
    assert.notEqual(classifyResumeRole(jd), 'startup-cs-builder');
  });

  it('still classifies a genuinely startup-framed JD as startup-cs-builder', () => {
    const jd = 'Customer Success Manager at a fast-paced, high-growth startup. Build our customer success function from the ground up as a foundational team member.';
    assert.equal(classifyResumeRole(jd), 'startup-cs-builder');
  });

  it('detects Hakimo-style commercial startup CSM roles separately from cybersecurity builder roles', () => {
    const jd = [
      'Customer Success Manager at an AI-powered physical security startup.',
      'Own three KPIs across a book of business: expansion, retention, and churn save.',
      'Partner with AEs on shared accounts, renewal motions, expansion strategy, account planning, and Pipedrive opportunity hygiene.',
      'Build rather than inherit playbooks in a fast-paced environment with ops, facilities, security chiefs, and IT stakeholders.',
    ].join('\n');

    assert.equal(classifyResumeRole(jd), 'startup-commercial-cs-builder');
  });

  it('detects Maven-style AI customer experience roles before generic startup commercial CS', () => {
    const jd = [
      'Customer Experience Manager - Strategic for an enterprise AI platform.',
      'Own conversational AI agents, LLM quality, prompt tuning, contracted-volume consumption, onboarding, and multi-department customer service workflows.',
    ].join('\n');

    assert.equal(classifyResumeRole(jd), 'ai-customer-experience');
  });

  it('keeps technical CSM roles with onboarding discovery out of pre-sales mode', () => {
    const jd = [
      'Technical Customer Success Manager',
      'Own post-sale success for enterprise accounts.',
      'Lead onboarding, discovery sessions, platform configuration, integrations, QBRs, and technical escalations.',
      'Guide customers on AI governance, LCNC security programs, and executive value realization.',
    ].join('\n');

    assert.equal(classifyResumeRole(jd), 'cse');
  });

  it('extracts delivery and compliance requirements without treating gaps as direct experience', () => {
    const requirements = extractJobRequirements(
      'Manage CMMC compliance program delivery, corrective action plans, onboarding project management, technical projects, dashboards, ticket queues, and escalation accountability.',
      ''
    );
    const labels = requirements.map(item => item.requirement);
    const evidence = buildEvidenceMap(
      requirements,
      'Built Securonix onboarding workflows, escalation protocols, SOC enablement, DLP, IAM, and audit-readiness reporting for regulated enterprise customers.'
    );

    assert.ok(labels.includes('compliance program delivery'));
    assert.ok(labels.includes('corrective action plan management'));
    assert.ok(labels.includes('onboarding project management'));
    assert.ok(labels.includes('service instrumentation and dashboards'));
    assert.notEqual(evidence.find(item => item.requirement === 'compliance program delivery')?.status, 'gap');
    assert.equal(evidence.some(item => item.evidenceTerms.includes('cmmc')), false);
  });

  it('extracts Zenity-style AI governance requirements for technical CSM roles', () => {
    const requirements = extractJobRequirements(
      'Guide customers on AI standards, LCNC low-code/no-code governance, application security, governance frameworks, configuring policies, remediation guidance, risk reduction metrics, product roadmap feedback, and OWASP / MITRE familiarity.',
      'alignment, business, company'
    );
    const labels = requirements.map(item => item.requirement);

    assert.ok(labels.includes('AI governance'));
    assert.ok(labels.includes('LCNC governance'));
    assert.ok(labels.includes('enterprise application security'));
    assert.ok(labels.includes('policy configuration guidance'));
    assert.ok(labels.includes('security violation remediation'));
    assert.ok(labels.includes('risk reduction analytics'));
    assert.ok(labels.includes('product feedback loops'));
    assert.ok(labels.includes('OWASP/MITRE familiarity'));
    assert.equal(labels.includes('alignment'), false);
    assert.equal(labels.includes('business'), false);
    assert.equal(labels.includes('company'), false);
  });

  it('extracts startup CSM builder and threat-hunting requirements', () => {
    const requirements = extractJobRequirements(
      [
        'Build from the ground up with process design, scalable onboarding workflows, customer support processes, AI-driven efficiency, and Generative AI tools such as ChatGPT, Claude, or Gemini.',
        'Act as Voice of the Customer with Product and Engineering, partner with Sales on handoffs and expansion, work with Marketing on power users, case studies, and testimonials.',
        'Support threat hunting, behavioral detections, endpoint telemetry, identity telemetry, cloud telemetry, credential misuse, lateral movement, and post-access activity.',
      ].join(' '),
      ''
    );
    const labels = requirements.map(item => item.requirement);

    assert.ok(labels.includes('startup CS function building'));
    assert.ok(labels.includes('process design and implementation'));
    assert.ok(labels.includes('AI-driven workflow efficiency'));
    assert.ok(labels.includes('voice of customer product alignment'));
    assert.ok(labels.includes('marketing advocacy and case studies'));
    assert.ok(labels.includes('threat hunting and behavioral detection'));
    assert.ok(labels.includes('endpoint identity cloud telemetry'));
    assert.ok(labels.includes('credential misuse and lateral movement'));
  });

  it('extracts commercial startup CSM requirements for physical-security adjacency', () => {
    const requirements = extractJobRequirements(
      [
        'Own a book of business across expansion, retention, and churn save.',
        'Partner with Account Executives on shared accounts, joint planning, renewal motions, expansion strategy, and Pipedrive expansion opportunities.',
        'Build rather than inherit playbooks for AI-powered physical security, IoT, hardware-software, ops, security chiefs, and facilities leaders.',
      ].join(' '),
      ''
    );
    const labels = requirements.map(item => item.requirement);

    assert.ok(labels.includes('commercial CSM KPI ownership'));
    assert.ok(labels.includes('AE partnership and account planning'));
    assert.ok(labels.includes('CRM opportunity hygiene'));
    assert.ok(labels.includes('physical security and IoT adjacency'));
    assert.ok(labels.includes('startup CS playbook building'));
  });

  it('plans MSP compliance delivery sections around execution before SaaS expansion', () => {
    const requirements = extractJobRequirements(
      'Managed services Director owning service delivery, compliance program delivery, onboarding project management, corrective action plans, technology rollouts, dashboards, and team accountability.',
      ''
    );
    const evidenceMap = buildEvidenceMap(requirements, 'Built CS teams, onboarding workflows, escalation protocols, health scoring, DLP, IAM, SIEM, SOC, and retention outcomes.');
    const plan = buildResumeSectionPlan({
      roleMode: 'msp-compliance-delivery',
      requirements,
      evidenceMap,
    });

    assert.match(plan.taglineDirective, /managed services|execution leadership|compliance-aligned/i);
    assert.match(plan.summaryThesis, /onboarding execution|corrective action|escalation accountability/i);
    assert.match(plan.toolsPlatformsDirective, /clean competency list/i);
    assert.ok(plan.downrankVocabulary.some(item => /NRR|expansion|commercial/i.test(item)));
  });

  it('plans strategic CS leadership sections around outcomes and people leadership before security tooling', () => {
    const requirements = extractJobRequirements(
      'Director, Customer Success owning customer health, value realization, executive engagement, team coaching, customer planning, and scalable operating rhythms.',
      ''
    );
    const evidenceMap = buildEvidenceMap(requirements, 'Built CS operating models, led an 8-person team, improved retention, created health scoring, and aligned executive stakeholders.');
    const plan = buildResumeSectionPlan({
      roleMode: 'strategic-cs-leadership',
      requirements,
      evidenceMap,
    });

    assert.match(plan.summaryThesis, /customer outcomes leader/i);
    assert.match(plan.toolsPlatformsDirective, /customer-success competency list/i);
    assert.ok(plan.downrankVocabulary.includes('SIEM'));
  });

  it('plans startup CSM builder sections around Total Trial, AI workflow, and threat hunting', () => {
    const requirements = extractJobRequirements(
      'Customer Success Manager in a high-growth startup owning process design, scalable onboarding workflows, AI-driven efficiency, Voice of Customer, Strategic Business Reviews, threat hunting, behavioral detection, and endpoint identity cloud telemetry.',
      ''
    );
    const evidenceMap = buildEvidenceMap(
      requirements,
      'Total Trial Services built CS function across 87 clients with 8 direct reports and 22% retention improvement. ExtraHop NDR AI workflow automation and Securonix SIEM onboarding reduction.'
    );
    const plan = buildResumeSectionPlan({
      roleMode: 'startup-cs-builder',
      requirements,
      evidenceMap,
    });

    assert.match(plan.taglineDirective, /Customer Success Manager|startup CS builder/i);
    assert.match(plan.summaryThesis, /onboarding|support|escalation/i);
    assert.match(plan.toolsPlatformsDirective, /AI-Assisted Documentation|Threat Hunting/i);
    assert.ok(plan.emphasizeBullets.some(item => /Total Trial Services/i.test(item)));
    assert.ok(plan.downrankVocabulary.some(item => /Director-level/i.test(item)));
  });

  it('plans commercial startup CSM sections around builder proof, churn save, and AE partnership', () => {
    const requirements = extractJobRequirements(
      'Customer Success Manager owning expansion, retention, churn save, account planning, renewal motions, Pipedrive hygiene, startup playbook building, physical security, IoT, and ops stakeholders.',
      ''
    );
    const evidenceMap = buildEvidenceMap(
      requirements,
      'Total Trial Services built CS function across 87 clients with 8 direct reports and 22% retention improvement. Securonix retained three at-risk accounts, 100% renewal, 30% onboarding reduction, and 81% ARR expansion. ExtraHop partnered with sales on renewal strategy.'
    );
    const plan = buildResumeSectionPlan({
      roleMode: 'startup-commercial-cs-builder',
      requirements,
      evidenceMap,
    });

    assert.match(plan.taglineDirective, /commercial ownership|AE partnership|physical-security/i);
    assert.match(plan.summaryThesis, /renewal and expansion|AEs/i);
    assert.match(plan.toolsPlatformsDirective, /Pipedrive|Churn Save|Physical Security/i);
    assert.ok(plan.emphasizeBullets.some(item => /Total Trial Services/i.test(item)));
    assert.ok(plan.emphasizeBullets.some(item => /Securonix/i.test(item)));
    assert.ok(plan.downrankVocabulary.some(item => /direct physical security/i.test(item)));
  });

  it('plans AI CXM sections around truthful AI adoption transfer instead of direct LLM claims', () => {
    const requirements = extractJobRequirements(
      'Customer Experience Manager for an enterprise AI platform owning onboarding, consumption, AI quality, Product and Engineering feedback, and multi-department workflow integration.',
      ''
    );
    const evidenceMap = buildEvidenceMap(
      requirements,
      'McAfee largest cloud security onboarding with highest NPS. Securonix usage data, Product and Engineering feedback, and 30% onboarding reduction. Auth0 IAM integration workflows across 14 enterprise accounts.'
    );
    const plan = buildResumeSectionPlan({
      roleMode: 'ai-customer-experience',
      requirements,
      evidenceMap,
    });

    assert.match(plan.taglineDirective, /Customer Experience Manager|AI Platform Adoption/i);
    assert.match(plan.summaryThesis, /quality|usage data|Product and Engineering/i);
    assert.ok(plan.emphasizeBullets.some(item => /McAfee/i.test(item)));
    assert.ok(plan.emphasizeBullets.some(item => /Auth0/i.test(item)));
    assert.ok(plan.downrankVocabulary.some(item => /direct LLM/i.test(item)));
  });

  it('critiques SaaS expansion framing in MSP compliance delivery drafts', () => {
    const planningContext = buildResumePlanningContext(
      'Director of Customer Success at a managed services provider owning compliance program delivery, onboarding project management, corrective action plans, technology rollouts, dashboards, and escalation accountability.',
      '',
      'Built CS lifecycle models, onboarding workflows, escalation protocols, health scoring, DLP, IAM, SIEM, SOC, and team standards.'
    );
    const issues = critiqueResumeDraft({
      TITLE_LINE: 'Director of Customer Success | Enterprise Cybersecurity | Retention & Expansion Ownership',
      PROFESSIONAL_SUMMARY: 'Customer Success leader focused on NRR, ARR growth, QBR pipeline, and commercial owner motions.',
      CORE_COMPETENCIES: 'ExtraHop NDR, Securonix SIEM, Salesforce, Gainsight',
      KEY_ACHIEVEMENT_1: 'Drove 120% NRR through QBR pipeline generation across enterprise SaaS accounts.',
    }, planningContext);

    assert.ok(issues.some(issue => issue.code === 'delivery-frame-mismatch'));
    assert.ok(issues.some(issue => issue.code === 'weak-delivery-competencies'));
    assert.ok(issues.some(issue => issue.code === 'commercial-heavy-delivery-bullet'));
  });

  it('critiques overtechnical framing in strategic CS leadership drafts', () => {
    const planningContext = buildResumePlanningContext(
      'Director, Customer Success leading strategic enterprise accounts with customer health, executive engagement, adoption, value realization, and team coaching.',
      '',
      'Built customer health systems, led an 8-person CS team, and managed healthcare enterprise accounts.'
    );
    const issues = critiqueResumeDraft({
      TITLE_LINE: 'Director, Customer Success | Strategic Enterprise Accounts',
      PROFESSIONAL_SUMMARY: 'Customer success leader focused on SIEM architecture and security platform lifecycle execution.',
      CORE_COMPETENCIES: 'Security Platforms: ExtraHop NDR, Securonix SIEM/UEBA, McAfee EDR',
      JOB_1_BULLET_1: 'Optimized NDR detection coverage for enterprise security stakeholders through platform architecture reviews.',
    }, planningContext);

    assert.ok(issues.some(issue => issue.code === 'overtechnical-strategic-cs-framing'));
    assert.ok(issues.some(issue => issue.code === 'overtechnical-strategic-cs-bullet'));
  });

  it('critiques startup CSM drafts that bury builder proof, AI fluency, or threat-hunting domain', () => {
    const planningContext = buildResumePlanningContext(
      'Customer Success Manager at a fast-paced cybersecurity startup building process design, scalable onboarding workflows, AI-driven efficiency, Voice of Customer, onsite Strategic Business Reviews, threat hunting, behavioral detections, endpoint identity cloud telemetry, credential misuse, lateral movement, and post-access activity.',
      '',
      'Total Trial Services built CS function across 87 clients with 8 direct reports and 22% retention improvement. ExtraHop NDR AI workflow automation and Securonix SIEM onboarding reduction.'
    );
    const issues = critiqueResumeDraft({
      TITLE_LINE: 'Strategic Customer Success Manager | Enterprise Accounts',
      PROFESSIONAL_SUMMARY: 'Customer Success leader managing relationships across large enterprise accounts with retention ownership and broad stakeholder engagement.',
      CORE_COMPETENCIES: 'Customer success, QBRs, renewals, account management',
      KEY_ACHIEVEMENT_1: 'Maintained strong retention across enterprise security accounts through customer planning.',
    }, planningContext);

    assert.ok(issues.some(issue => issue.code === 'missing-startup-builder-positioning'));
    assert.ok(issues.some(issue => issue.code === 'missing-threat-hunting-domain'));
    assert.ok(issues.some(issue => issue.code === 'missing-total-trial-builder-proof'));
    assert.ok(issues.some(issue => issue.code === 'missing-ai-fluency'));
  });

  it('critiques Hakimo-style drafts that miss commercial ownership, builder proof, or churn-save proof', () => {
    const planningContext = buildResumePlanningContext(
      'Customer Success Manager at an AI-powered physical security startup owning expansion, retention, churn save, AE partnership, account planning, renewal motions, Pipedrive, and no fully established playbooks.',
      '',
      'Total Trial Services built CS function across 87 clients with 8 direct reports and 22% retention improvement. Securonix retained three at-risk accounts, 100% renewal, 30% onboarding reduction, and 81% ARR expansion.'
    );
    const issues = critiqueResumeDraft({
      TITLE_LINE: 'Strategic Customer Success Manager | Enterprise Cybersecurity',
      PROFESSIONAL_SUMMARY: 'Cybersecurity customer success leader focused on security platform adoption and enterprise stakeholders.',
      CORE_COMPETENCIES: 'NDR, SIEM, IAM, SOC workflows',
      KEY_ACHIEVEMENT_1: 'Maintained adoption across enterprise security accounts.',
    }, planningContext);

    assert.equal(planningContext.roleMode, 'startup-commercial-cs-builder');
    assert.ok(issues.some(issue => issue.code === 'missing-commercial-startup-positioning'));
    assert.ok(issues.some(issue => issue.code === 'missing-physical-security-iot-bridge'));
    assert.ok(issues.some(issue => issue.code === 'missing-total-trial-builder-proof'));
    assert.ok(issues.some(issue => issue.code === 'missing-securonix-churn-save-proof'));
  });

  it('critiques Maven-style AI CXM drafts that overfit cybersecurity or invent direct AI work', () => {
    const jd = 'Customer Experience Manager - Strategic for an enterprise AI platform with LLMs, prompt tuning, AI quality, contracted-volume consumption, onboarding, Product and Engineering collaboration, and multi-department customer service workflows.';
    const planningContext = buildResumePlanningContext(
      jd,
      '',
      'McAfee largest cloud security onboarding with highest NPS. Securonix usage data, Product and Engineering feedback, and 30% onboarding reduction. Auth0 IAM integration workflows across 14 enterprise accounts. ExtraHop telemetry business cases.'
    );
    const issues = critiqueResumeDraft({
      TITLE_LINE: 'Strategic Customer Success Manager | NDR, SIEM & Cybersecurity',
      PROFESSIONAL_SUMMARY: 'Cybersecurity customer success leader with direct experience with AI workflow automation and security platform adoption.',
      CORE_COMPETENCIES: 'NDR | SIEM | IAM | SOC | Threat Detection',
      JOB_1_BULLET_1: 'Built AI workflow automation targeting repetitive security operations tasks across a $23M enterprise portfolio.',
    }, planningContext);

    assert.equal(planningContext.roleMode, 'ai-customer-experience');
    assert.ok(issues.some(issue => issue.code === 'missing-ai-cx-positioning'));
    assert.ok(issues.some(issue => issue.code === 'unsupported-direct-ai-claim'));
    assert.ok(issues.some(issue => issue.code === 'missing-mcafee-onboarding-analog'));
    assert.ok(issues.some(issue => issue.code === 'missing-ai-quality-data-loop'));
  });

  it('critiques generic commercial CSM drafts that miss NRR, demos, health checks, or mentorship', () => {
    const planningContext = buildResumePlanningContext(
      [
        'Customer Success Manager managing a portfolio of 30-40 named accounts.',
        'Own Net Revenue Retention quota, upsells, cross-sells, renewals, executive business reviews, health checks, risk action plans, escalations, demonstrations to CISOs, and mentorship for developing CSMs.',
        'The platform is AI cybersecurity across network, cloud, and email.',
      ].join(' '),
      '',
      'Managed $23M ARR and $55M ARR portfolios with NRR, renewals, CISO demos, health checks, escalations, and team standards.'
    );
    const issues = critiqueResumeDraft({
      TITLE_LINE: 'Enterprise Customer Success Manager',
      METRICS_LINE: '22+ Years Enterprise SaaS',
      PROFESSIONAL_SUMMARY: 'Customer Success leader managing relationships across enterprise accounts with adoption planning and stakeholder engagement.',
      CORE_COMPETENCIES: 'Customer success, adoption, stakeholder engagement',
      KEY_ACHIEVEMENT_1: 'Improved customer outcomes across enterprise accounts.',
    }, planningContext);

    assert.equal(planningContext.roleMode, 'customer-success');
    assert.ok(issues.some(issue => issue.code === 'missing-named-account-portfolio-frame'));
    assert.ok(issues.some(issue => issue.code === 'missing-commercial-cs-ownership'));
    assert.ok(issues.some(issue => issue.code === 'missing-executive-demo-health-cadence'));
    assert.ok(issues.some(issue => issue.code === 'missing-csm-mentorship'));
  });

  it('critiques and repairs weak above-fold proof', () => {
    const planningContext = buildResumePlanningContext(
      'Customer Success Manager owning retention, renewal execution, executive business reviews, and account planning.',
      '',
      'Managed enterprise portfolios with retention and renewal outcomes.'
    );
    const draft = {
      TITLE_LINE: 'Enterprise Customer Success Manager',
      METRICS_LINE: '22+ Years Enterprise SaaS',
      PROFESSIONAL_SUMMARY: 'Customer Success leader focused on adoption, executive alignment, and customer outcomes across complex SaaS environments.',
      KEY_ACHIEVEMENT_1: 'Improved onboarding discipline through better stakeholder alignment and repeatable customer success operating rhythms.',
    };
    const issues = critiqueResumeDraft(draft, planningContext);
    const repaired = applyDeterministicStrategicRepairs(draft, [
      'TITLE_LINE',
      'METRICS_LINE',
      'PROFESSIONAL_SUMMARY',
      'KEY_ACHIEVEMENT_1',
    ], {
      jdText: planningContext.jdText,
      planningContext,
    });

    assert.ok(issues.some(issue => issue.code === 'weak-above-fold-proof'));
    assert.match(repaired.METRICS_LINE, /\$55M ARR Portfolio \(Peak\)/);
  });

  it('critiques above-fold sections that miss the target role business model', () => {
    const planningContext = buildResumePlanningContext(
      'Senior Sales Engineer owning pre-sales discovery, solution architecture, demos, POC success criteria, and technical business cases.',
      '',
      'ExtraHop NDR architecture and Securonix SIEM advisory for enterprise security stakeholders.'
    );
    const issues = critiqueResumeDraft({
      TITLE_LINE: 'Enterprise Technical Advisor',
      METRICS_LINE: '$55M ARR Portfolio (Peak)',
      PROFESSIONAL_SUMMARY: 'Enterprise technical leader with cybersecurity depth across complex customer environments and executive stakeholder alignment.',
      CORE_COMPETENCIES: 'Security Platforms: ExtraHop NDR, Securonix SIEM',
      KEY_ACHIEVEMENT_1: 'Led $13M enterprise renewal at ExtraHop while expanding account value 122% through security maturity and adoption planning.',
    }, planningContext);

    assert.equal(planningContext.roleMode, 'pre-sales-solutions-architecture');
    assert.ok(issues.some(issue => issue.code === 'missing-role-business-model-signal'));
  });

  it('applies generic commercial CSM repairs without copying target account ranges', () => {
    const repaired = applyDeterministicStrategicRepairs({
      TITLE_LINE: 'Enterprise Customer Success Manager',
      METRICS_LINE: '22+ Years Enterprise SaaS',
      PROFESSIONAL_SUMMARY: 'Customer Success leader managing relationships across enterprise accounts.',
      CORE_COMPETENCIES: 'Customer Success: Enterprise Portfolio Management (30-40 Named Accounts), adoption',
      KEY_ACHIEVEMENT_4: 'Improved customer engagement workflows across enterprise accounts.',
    }, ['TITLE_LINE', 'METRICS_LINE', 'PROFESSIONAL_SUMMARY', 'CORE_COMPETENCIES', 'KEY_ACHIEVEMENT_4'], {
      jdText: 'Customer Success Manager owning NRR quota, upsells, cross-sells, renewals, executive business reviews, health checks, demonstrations to CISOs, and mentoring developing Customer Success Managers across a portfolio of 30-40 named accounts at an AI cybersecurity company.',
      planningContext: { roleMode: 'customer-success', jdText: 'Customer Success Manager owning NRR quota, upsells, cross-sells, renewals, executive business reviews, health checks, demonstrations to CISOs, and mentoring developing Customer Success Managers across a portfolio of 30-40 named accounts at an AI cybersecurity company.' },
    });
    const sanitized = sanitizeResumeLanguage(repaired.CORE_COMPETENCIES);

    assert.match(repaired.METRICS_LINE, /\$55M ARR Portfolio \(Peak\)/);
    assert.match(repaired.PROFESSIONAL_SUMMARY, /NRR|upsell and cross-sell|CISO|health/i);
    assert.match(repaired.CORE_COMPETENCIES, /CSM Mentorship|Solution Demonstrations|NRR \/ GRR Ownership/);
    assert.doesNotMatch(sanitized, /30-40 Named Accounts/i);
  });

  it('protects generic commercial CSM proof from local page-fit bullet dropping', () => {
    const planning = {
      roleMode: 'customer-success',
      jdText: 'Customer Success Manager owning NRR quota, upsells, renewals, executive business reviews, health checks, CISO demonstrations, and mentorship for developing CSMs.',
      requirements: extractJobRequirements('NRR upsells renewals executive business reviews health checks CISO demonstrations mentorship', ''),
    };
    const drop = lowestPrioritySelectedBullet({
      JOB_1_BULLET_1: 'Maintained account notes for enterprise customers through routine check-ins.',
      JOB_1_BULLET_2: 'Sustained 120% NRR by converting QBR health signals into renewal, upsell, and cross-sell actions across enterprise cybersecurity accounts.',
      JOB_2_BULLET_1: 'Mentored developing CSMs through best-practice sharing and repeatable escalation standards that improved team ramp and customer handoff consistency.',
    }, planning);

    assert.equal(drop.field, 'JOB_1_BULLET_1');
  });

  it('does not pad strategic CS leadership bullets with generic business-outcome clauses', () => {
    const repaired = applyDeterministicQualityRepairs({
      JOB_1_BULLET_1: 'Advised stakeholders on program execution.',
    }, ['JOB_1_BULLET_1'], [
      'JOB_1_BULLET_1: bullet lacks metric, enterprise scope, or stakeholder proof',
      'JOB_1_BULLET_1: bullet reads like generic activity rather than differentiated impact',
    ], 'strategic-cs-leadership');

    // No generic clause is appended (filler); evidence enforcement handles weak bullets.
    assert.doesNotMatch(repaired.JOB_1_BULLET_1, /measurable business outcomes|enterprise cybersecurity stakeholders/);
  });

  it('applies deterministic Nebulock-style startup CSM repairs', () => {
    const repaired = applyDeterministicStrategicRepairs({
      TITLE_LINE: 'Strategic Customer Success Manager | Enterprise Accounts',
      METRICS_LINE: '$55M ARR Portfolio (Peak) | 98-100% Retention',
      PROFESSIONAL_SUMMARY: 'Cybersecurity customer success operator with 22+ years across NDR, SIEM, IAM, endpoint, identity, and cloud security. Builds systems, aligns stakeholders, and owns customer outcomes across enterprise accounts.',
      CORE_COMPETENCIES: 'Customer Success: QBRs, renewals',
      KEY_ACHIEVEMENT_4: 'Rebuilt customer engagement workflows across enterprise accounts.',
    }, ['TITLE_LINE', 'METRICS_LINE', 'PROFESSIONAL_SUMMARY', 'CORE_COMPETENCIES', 'KEY_ACHIEVEMENT_4'], {
      jdText: 'Customer Success Manager at a cybersecurity startup with process design, AI-driven efficiency, threat hunting, behavioral detection, endpoint identity cloud telemetry, and build from the ground up ownership.',
      planningContext: { roleMode: 'startup-cs-builder' },
    });

    assert.match(repaired.TITLE_LINE, /Customer Success Manager|startup CS builder/i);
    assert.match(repaired.METRICS_LINE, /87-Client CS Function Build/);
    assert.match(repaired.METRICS_LINE, /22% Retention Lift/);
    assert.match(repaired.PROFESSIONAL_SUMMARY, /Total Trial Services|87 clients|22%/);
    assert.match(repaired.CORE_COMPETENCIES, /AI Workflow Automation/);
    assert.match(repaired.CORE_COMPETENCIES, /Threat Hunting/);
    assert.match(repaired.KEY_ACHIEVEMENT_4, /Total Trial Services|87 clients|22%/);
  });

  it('applies deterministic Maven-style AI CXM repairs with truthful source bridges', () => {
    const jdText = 'Customer Experience Manager - Strategic for an enterprise AI platform owning onboarding, adoption, consumption, AI quality, Product and Engineering collaboration, and multi-department workflow integration.';
    const planningContext = buildResumePlanningContext(
      jdText,
      '',
      'McAfee largest cloud security onboarding with highest NPS. Securonix usage data, Product and Engineering feedback, and 30% onboarding reduction. Auth0 IAM integration workflows across 14 enterprise accounts. ExtraHop telemetry business cases.'
    );
    const repaired = applyDeterministicStrategicRepairs({
      TITLE_LINE: 'Strategic Customer Success Manager | NDR, SIEM & Cybersecurity',
      METRICS_LINE: '$23M ARR Portfolio',
      PROFESSIONAL_SUMMARY: 'Cybersecurity customer success leader with direct experience with AI workflow automation.',
      CORE_COMPETENCIES: 'NDR | SIEM | IAM',
      KEY_ACHIEVEMENT_1: 'Closed a $13M enterprise renewal with 122% expansion.',
      KEY_ACHIEVEMENT_2: 'Recovered three at-risk Securonix accounts.',
      KEY_ACHIEVEMENT_3: 'Cut onboarding time 30%.',
      KEY_ACHIEVEMENT_4: 'Built CS playbooks.',
    }, [
      'TITLE_LINE',
      'METRICS_LINE',
      'PROFESSIONAL_SUMMARY',
      'CORE_COMPETENCIES',
      'KEY_ACHIEVEMENT_1',
      'KEY_ACHIEVEMENT_2',
      'KEY_ACHIEVEMENT_3',
      'KEY_ACHIEVEMENT_4',
    ], { jdText, planningContext });

    assert.match(repaired.TITLE_LINE, /Customer Experience Manager|AI Platform Adoption/);
    assert.match(repaired.PROFESSIONAL_SUMMARY, /Maven-relevant proof/);
    assert.doesNotMatch(repaired.PROFESSIONAL_SUMMARY, /direct experience with AI workflow automation/i);
    assert.match(repaired.CORE_COMPETENCIES, /Quality \/ Usage Data Reviews/);
    assert.match(repaired.KEY_ACHIEVEMENT_2, /usage data|Product and Engineering/);
    assert.match(repaired.KEY_ACHIEVEMENT_3, /McAfee|largest cloud-security onboarding/);
    assert.match(repaired.KEY_ACHIEVEMENT_4, /Auth0|workflow integrations/);
  });

  it('applies deterministic Hakimo-style commercial startup CSM repairs', () => {
    const repaired = applyDeterministicStrategicRepairs({
      TITLE_LINE: 'Strategic Customer Success Manager | Enterprise Accounts',
      METRICS_LINE: '$55M ARR Portfolio (Peak) | 98-100% Retention',
      PROFESSIONAL_SUMMARY: 'Customer success operator with enterprise security experience.',
      CORE_COMPETENCIES: 'Customer Success: QBRs, renewals',
      KEY_ACHIEVEMENT_3: 'Improved customer outcomes across enterprise accounts.',
      KEY_ACHIEVEMENT_4: 'Built customer engagement workflows across enterprise accounts.',
    }, ['TITLE_LINE', 'METRICS_LINE', 'PROFESSIONAL_SUMMARY', 'CORE_COMPETENCIES', 'KEY_ACHIEVEMENT_3', 'KEY_ACHIEVEMENT_4'], {
      jdText: 'Customer Success Manager at a physical security startup owning expansion, retention, churn save, AE partnership, account planning, Pipedrive, and build rather than inherit playbooks.',
      planningContext: { roleMode: 'startup-commercial-cs-builder' },
    });

    assert.match(repaired.TITLE_LINE, /Expansion|Retention|Churn Save|Physical Security/i);
    assert.match(repaired.METRICS_LINE, /87-Client CS Function Build/);
    assert.match(repaired.PROFESSIONAL_SUMMARY, /Total Trial Services|physical security|IoT/i);
    assert.match(repaired.CORE_COMPETENCIES, /Pipedrive|AE Partnership|Physical Security/i);
    assert.match(repaired.KEY_ACHIEVEMENT_3, /Securonix|100% renewal|30% onboarding|81% ARR/i);
    assert.match(repaired.KEY_ACHIEVEMENT_4, /Total Trial Services|87 clients|22%/);
  });

  it('protects Total Trial and Securonix proof from local page-fit bullet dropping for commercial startup CSMs', () => {
    const drop = lowestPrioritySelectedBullet({
      JOB_1_BULLET_1: 'Maintained account notes for enterprise customers through routine check-ins.',
      JOB_3_BULLET_1: 'Retained three at-risk Securonix accounts through churn-save escalation, sustained 100% renewal performance, cut onboarding 30%, and supported 81% ARR expansion.',
      JOB_5_BULLET_1: 'Built the CS function at Total Trial Services across 87 clients and an 8-person team, improving retention 22% through onboarding consistency and escalation handling.',
    }, {
      roleMode: 'startup-commercial-cs-builder',
      requirements: extractJobRequirements('expansion retention churn save book of business account planning Pipedrive physical security startup playbook building', ''),
    });

    assert.equal(drop.field, 'JOB_1_BULLET_1');
  });

  it('softens residual cybersecurity phrasing for strategic CS leadership drafts', () => {
    const repaired = applyDeterministicStrategicRepairs({
      JOB_1_BULLET_1: 'Advised CISO stakeholders on deployment health, threat detection gaps, and security operations timelines.',
      JOB_1_BULLET_2: 'Built QBR governance across strategic enterprise accounts, surfacing adoption health signals and expansion signals for customer executives and internal sales leadership in structured quarterly reviews that tightened renewal forecasting and reduced late-stage surprises.',
    }, ['JOB_1_BULLET_1', 'JOB_1_BULLET_2'], {
      jdText: 'Director, Customer Success leading customer health and executive engagement.',
      planningContext: { roleMode: 'strategic-cs-leadership' },
    });

    assert.match(repaired.JOB_1_BULLET_1, /customer engagement and lifecycle progress/);
    assert.match(repaired.JOB_1_BULLET_1, /customer needs and operational priorities/);
    assert.match(repaired.JOB_1_BULLET_2, /Built structured QBR governance/);
    assert.doesNotMatch(repaired.JOB_1_BULLET_2, /signals and expansion signals/);
  });

  it('critiques source-domain overfit for any non-security target JD', () => {
    const planningContext = buildResumePlanningContext(
      'Director of Operations leading executive alignment, operating cadence, and measurable business outcomes.',
      '',
      'Built customer health systems and led enterprise teams.'
    );
    const issues = critiqueResumeDraft({
      TITLE_LINE: 'Director of Operations',
      PROFESSIONAL_SUMMARY: 'Leader focused on SIEM architecture and deployment health.',
      CORE_COMPETENCIES: 'Security Platforms: ExtraHop NDR, Securonix SIEM',
      JOB_1_BULLET_1: 'Improved NDR detection coverage through security architecture reviews.',
    }, planningContext);

    assert.ok(issues.some(issue => issue.code === 'source-domain-overfit'));
    assert.ok(issues.some(issue => issue.code === 'source-domain-heavy-bullet'));
  });

  it('softens transferable language for any non-security target JD', () => {
    const repaired = applyDeterministicStrategicRepairs({
      JOB_1_BULLET_1: 'Advised security stakeholders on deployment health, threat detection gaps, and security operations timelines across complex hybrid environments.',
    }, ['JOB_1_BULLET_1'], {
      jdText: 'Director of Operations leading executive alignment and measurable business outcomes.',
      planningContext: { roleMode: 'leadership' },
    });

    assert.match(repaired.JOB_1_BULLET_1, /executive stakeholders/);
    assert.match(repaired.JOB_1_BULLET_1, /customer engagement and lifecycle progress/);
    assert.match(repaired.JOB_1_BULLET_1, /customer needs and operational priorities/);
    assert.doesNotMatch(repaired.JOB_1_BULLET_1, /hybrid environments/);
  });

  it('critiques post-sale CS framing in pre-sales drafts', () => {
    const planningContext = buildResumePlanningContext(
      'Senior Client Solutions Engineer owning pre-sales discovery, solution sizing, BOM review, cloud management, and security architecture.',
      '',
      'ExtraHop NDR architecture and Securonix SIEM log ingestion advisory for enterprise CISOs.'
    );
    const issues = critiqueResumeDraft({
      TITLE_LINE: 'Enterprise Customer Success Leader | Cybersecurity | Retention',
      PROFESSIONAL_SUMMARY: 'Enterprise Customer Success leader focused on renewals, retention, churn prevention, and account health.',
      CORE_COMPETENCIES: 'Customer success, renewals, QBRs',
      JOB_1_BULLET_1: 'Recovered renewal risk and improved retention across enterprise accounts.',
    }, planningContext);

    assert.ok(issues.some(issue => issue.code === 'role-frame-mismatch'));
    assert.ok(issues.some(issue => issue.code === 'weak-tools-platforms'));
    assert.ok(issues.some(issue => issue.code === 'post-sale-bullet-in-pre-sales-resume'));
  });

  it('builds prompt context with requirement map and section plan', () => {
    const context = buildResumePlanningContext(
      'Senior Client Solutions Engineer owning pre-sales discovery, solution sizing, BOM review, cloud management, and security architecture.',
      'data center infrastructure',
      'ExtraHop NDR architecture and Securonix SIEM log ingestion advisory for enterprise CISOs.'
    );
    const text = planningContextText(context);

    assert.match(text, /REQUIREMENT_EVIDENCE_MAP/);
    assert.match(text, /JD_SIGNAL_ANALYSIS/);
    assert.match(text, /SECTION_PLAN/);
    assert.match(text, /pre-sales-solutions-architecture/);
    assert.match(text, /solution sizing/);
  });

  it('runs every resume AI step on local LM Studio with no Anthropic dependency', () => {
    assert.doesNotMatch(source, /@anthropic-ai\/sdk|anthropic-cache|ANTHROPIC_API_KEY|CLAUDE_(?:SYNTHESIS|POLISH)_MODEL|preferClaudePipeline/);
    assert.match(source, /const localAiClient = \{/);
    assert.match(source, /LM_STUDIO_SYNTHESIS_MODEL/);
    assert.equal(typeof synthesisSystemBlocks(), 'string');
  });

  it('adds request-level Anthropic prompt caching by default', async () => {
    assert.deepEqual(anthropicRequestCacheControl(), { type: 'ephemeral' });

    await withEnv({ ANTHROPIC_PROMPT_CACHING: '0' }, async () => {
      assert.equal(anthropicRequestCacheControl(), undefined);
    });
  });
});
