import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  checkGmailEnv,
  checkLmStudio,
  checkNodeVersion,
  checkOutputWritable,
  checkResumeTruthSources,
  checkPdfExportEnv,
  exitCodeForChecks,
  fetchLmStudioModels,
  formatChecks,
  isEnabled,
} from '../scripts/health-check.mjs';

describe('health-check helpers', () => {
  it('parses enabled env flags', () => {
    assert.equal(isEnabled('1'), true);
    assert.equal(isEnabled('true'), true);
    assert.equal(isEnabled('yes'), true);
    assert.equal(isEnabled('0'), false);
    assert.equal(isEnabled(undefined), false);
  });

  it('checks Node major version', () => {
    assert.equal(checkNodeVersion('18.0.0').status, 'PASS');
    assert.equal(checkNodeVersion('16.20.0').status, 'FAIL');
  });

  it('reports Gmail env as warn, fail, or pass', () => {
    assert.equal(checkGmailEnv({}).status, 'WARN');
    assert.equal(checkGmailEnv({ GMAIL_CLIENT_ID: 'id' }).status, 'FAIL');
    assert.equal(checkGmailEnv({
      GMAIL_CLIENT_ID: 'id',
      GMAIL_CLIENT_SECRET: 'secret',
      GMAIL_REFRESH_TOKEN: 'token',
    }).status, 'PASS');
  });

  it('skips PDF tools only when export and page validation are disabled', () => {
    assert.deepEqual(
      checkPdfExportEnv({ RESUME_PDF_EXPORT: '0', RESUME_PAGE_VALIDATION: '0' }),
      { status: 'PASS', name: 'PDF tools', message: 'skipped; PDF export and page validation disabled' }
    );
    assert.equal(checkPdfExportEnv({ RESUME_PDF_EXPORT: '1' }), null);
    assert.equal(checkPdfExportEnv({ RESUME_PDF_EXPORT: '0', RESUME_PAGE_VALIDATION: '1' }), null);
  });

  it('reads LM Studio model ids from OpenAI-compatible responses', async () => {
    const models = await fetchLmStudioModels(async () => ({
      ok: true,
      json: async () => ({ data: [{ id: 'model-a' }, { id: 'model-b' }] }),
    }));
    assert.deepEqual(models, ['model-a', 'model-b']);
  });

  it('skips LM Studio checks when Claude-first pipeline is enabled', async () => {
    const checks = await checkLmStudio(async () => {
      throw new Error('should not fetch');
    }, { PREFER_CLAUDE_SYNTHESIS: '1' });
    assert.equal(checks[0].status, 'PASS');
    assert.match(checks[0].message, /skipped; Claude-first/);
  });

  it('does not skip LM Studio checks when evaluation rollback is explicitly enabled', async () => {
    const checks = await checkLmStudio(async () => ({
      ok: true,
      json: async () => ({ data: [{ id: 'qwen2.5-coder-7b-instruct-mlx' }] }),
    }), { PREFER_CLAUDE_SYNTHESIS: '1', PREFER_CLAUDE_EVALUATION: '0' });
    assert.equal(checks[0].status, 'PASS');
    assert.match(checks[0].message, /model\(s\) reported/);
  });

  it('formats checks and returns non-zero when failures exist', () => {
    const checks = [
      { status: 'PASS', name: 'A', message: 'ok' },
      { status: 'FAIL', name: 'Longer', message: 'bad' },
    ];
    assert.match(formatChecks(checks), /^PASS A\s+ok/m);
    assert.equal(exitCodeForChecks(checks), 1);
    assert.equal(exitCodeForChecks([checks[0]]), 0);
  });

  it('checks output directory writability', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'career-health-'));
    assert.equal(checkOutputWritable(dir).status, 'PASS');
  });

  it('checks the three resume truth source files', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'career-truth-'));
    fs.writeFileSync(path.join(dir, 'master-brag-document.md'), 'brag');
    fs.writeFileSync(path.join(dir, 'Profile.pdf'), 'pdf');
    fs.writeFileSync(path.join(dir, 'FINAL Brian Milhizer Production Resume Template v3.dotx'), 'dotx');
    assert.equal(checkResumeTruthSources(dir).status, 'PASS');
    fs.unlinkSync(path.join(dir, 'Profile.pdf'));
    const missing = checkResumeTruthSources(dir);
    assert.equal(missing.status, 'FAIL');
    assert.match(missing.message, /Profile\.pdf/);
  });
});
