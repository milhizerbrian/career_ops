import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveTemplatePath } from '../lib/docx-utils.mjs';
import { buildResumeDebugStats, generateResumeFinish, validateResumeQuality } from '../lib/resume-gen.mjs';

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

describe('DOCX-first resume finish', () => {
  it('repairs weak generated bullets before failing the quality gate', async () => {
    await withEnv({ ANTHROPIC_API_KEY: '', RESUME_PDF_EXPORT: '0' }, async () => {
      const state = finishState(`quality-repair-${Date.now()}`);
      state.fields = [
        'PROFESSIONAL_SUMMARY',
        'KEY_ACHIEVEMENT_1',
        'JOB_1_CONTEXT',
        'JOB_1_BULLET_1',
        'JOB_2_BULLET_3',
      ];
      state.replacements = {
        ...VALID_REPLACEMENTS,
        JOB_2_BULLET_3: 'Managed customer relationships and supported implementation planning for accounts.',
      };

      const result = await generateResumeFinish(state);

      assert.ok(result.docxUrl.endsWith('.docx'));
      assert.match(state.io.events.map(event => event.payload?.stage).join('\n'), /quality-repair/);
    });
  });

  it('succeeds with a DOCX result when PDF export is disabled', async () => {
    await withEnv({ ANTHROPIC_API_KEY: '', RESUME_PDF_EXPORT: '0' }, async () => {
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
      ANTHROPIC_API_KEY: '',
      RESUME_PDF_EXPORT: '1',
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
    await withEnv({ ANTHROPIC_API_KEY: '', RESUME_PDF_EXPORT: '0' }, async () => {
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

  it('keeps active prompts aligned to word and character targets', () => {
    assert.match(source, /22-34 words/);
    assert.match(source, /175-240 characters/);
    assert.match(source, /140-210 characters/);
    assert.match(source, /scope, concrete action\/mechanism, domain language, and measurable outcome/);
    assert.match(source, /Do not over-compress useful detail|do not over-compress useful detail/);
  });
});
