import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCliArgs, selectPipelineItems } from '../evaluate.mjs';
import { buildEntry } from '../lib/evaluator.mjs';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('evaluate.mjs CLI wrapper', () => {
  it('parses existing CLI flags', () => {
    const opts = parseCliArgs([
      '--dry-run',
      '--limit', '7',
      '--concurrency', '3',
      '--days', '2',
      '--company', 'Wiz',
    ]);

    assert.equal(opts.dryRun, true);
    assert.equal(opts.limit, 7);
    assert.equal(opts.concurrency, 3);
    assert.equal(opts.days, 2);
    assert.equal(opts.company, 'Wiz');
  });

  it('filters pipeline items by company and limit', () => {
    const items = [
      { url: 'https://example.com/a', company: 'Wiz', title: 'CSM' },
      { url: 'https://example.com/b', company: 'CrowdStrike', title: 'TAM' },
      { url: 'https://example.com/c', company: 'Wiz Security', title: 'CSE' },
    ];

    assert.deepEqual(selectPipelineItems(items, { company: 'wiz', limit: 1 }), [items[0]]);
    assert.deepEqual(selectPipelineItems(items, { company: 'wiz' }), [items[0], items[2]]);
  });

  it('delegates evaluation to the shared evaluator instead of defining duplicate engine logic', () => {
    const source = fs.readFileSync(path.resolve(APP_ROOT, 'evaluate.mjs'), 'utf8');

    assert.match(source, /from '\.\/lib\/evaluator\.mjs'/);
    assert.match(source, /\bevaluateItem\(/);
    assert.doesNotMatch(source, /function fetchJobDetails/);
    assert.doesNotMatch(source, /function scoreWithLmStudio/);
    assert.doesNotMatch(source, /function buildEntry/);
    assert.doesNotMatch(source, /function fetchWorkdayJob/);
  });

  it('uses the shared tracker entry shape expected by CLI and dashboard paths', () => {
    const entry = buildEntry(
      'url-test',
      { url: 'https://example.com/job', company: 'Example', title: 'Senior CSM' },
      { company: 'Example', title: 'Senior CSM', location: 'Remote', description: 'Full JD text', compensation: '$180K' },
      { score: 4.2, score_analysis: 'Strong fit', role_summary: 'Owns enterprise accounts', gaps: ['None'], cv_match_table: [] }
    );

    assert.equal(entry.status, 'lead');
    assert.equal(entry.source, 'manual');
    assert.equal(entry.score, 4.2);
    assert.equal(entry.full_description, 'Full JD text');
    assert.ok(entry.report);
    assert.deepEqual(entry.report.gaps, ['None']);
  });
});
