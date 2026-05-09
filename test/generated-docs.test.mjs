import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildGeneratedDocEntry, buildResumeVersionRecord } from '../lib/generated-docs.mjs';

describe('buildGeneratedDocEntry', () => {
  it('persists DOCX metadata and lightweight version history', () => {
    const pageValidation = {
      status: 'skipped',
      message: 'PDF validation disabled',
    };

    assert.deepEqual(
      buildGeneratedDocEntry({
        variant: 'technical',
        docxUrl: '/output/resume-example.docx',
        pdfUrl: null,
        pageCount: null,
        pageValidation,
      }, {
        generatedAt: '2026-05-07T12:00:00.000Z',
        job: { id: 'job-1', score: 4.2, _ats: { score: 83 } },
      }),
      {
        generatedAt: '2026-05-07T12:00:00.000Z',
        strategy: 'technical',
        variant: 'technical',
        evaluatorScore: 4.2,
        atsScore: 83,
        sourceJobId: 'job-1',
        fileName: 'resume-example.docx',
        docxUrl: '/output/resume-example.docx',
        pdfUrl: null,
        pageCount: null,
        pageValidation,
        history: [{
          generatedAt: '2026-05-07T12:00:00.000Z',
          strategy: 'technical',
          variant: 'technical',
          evaluatorScore: 4.2,
          atsScore: 83,
          sourceJobId: 'job-1',
          fileName: 'resume-example.docx',
          docxUrl: '/output/resume-example.docx',
        }],
      }
    );
  });

  it('defaults missing PDF metadata to DOCX-first skipped validation', () => {
    const entry = buildGeneratedDocEntry({
      docxUrl: '/output/resume-example.docx',
    }, { generatedAt: '2026-05-07T12:00:00.000Z' });

    assert.equal(entry.pdfUrl, null);
    assert.equal(entry.pageCount, null);
    assert.deepEqual(entry.pageValidation, {
      status: 'skipped',
      message: 'PDF validation disabled',
    });
    assert.equal(entry.strategy, 'default');
    assert.equal(entry.fileName, 'resume-example.docx');
    assert.equal(entry.history.length, 1);
  });

  it('carries forward old generatedDocs entries into history', () => {
    const entry = buildGeneratedDocEntry({
      variant: 'default',
      docxUrl: '/output/resume-new.docx',
    }, {
      generatedAt: '2026-05-08T12:00:00.000Z',
      jobId: 'job-1',
      previousEntry: {
        docxUrl: '/output/resume-old.docx',
        generatedAt: '2026-05-07T12:00:00.000Z',
      },
    });

    assert.deepEqual(entry.history.map(item => item.fileName), [
      'resume-old.docx',
      'resume-new.docx',
    ]);
    assert.equal(entry.history[0].sourceJobId, null);
    assert.equal(entry.history[1].sourceJobId, 'job-1');
  });
});

describe('buildResumeVersionRecord', () => {
  it('captures source job, strategy, score, file name, and docx URL', () => {
    assert.deepEqual(
      buildResumeVersionRecord({
        variant: 'outcomes',
        docxUrl: '/output/resume-acme-2026-05-08-outcomes.docx',
      }, {
        generatedAt: '2026-05-08T13:00:00.000Z',
        job: { id: 'job-2', score: 3.8, _ats: { score: 76 } },
      }),
      {
        generatedAt: '2026-05-08T13:00:00.000Z',
        strategy: 'outcomes',
        variant: 'outcomes',
        evaluatorScore: 3.8,
        atsScore: 76,
        sourceJobId: 'job-2',
        fileName: 'resume-acme-2026-05-08-outcomes.docx',
        docxUrl: '/output/resume-acme-2026-05-08-outcomes.docx',
      }
    );
  });
});
