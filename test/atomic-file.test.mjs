import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeJsonAtomic, writeTextAtomic } from '../lib/atomic-file.mjs';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => fs.readFileSync(path.resolve(APP_ROOT, file), 'utf8');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'career-ops-atomic-'));
}

describe('atomic file helpers', () => {
  it('JSON write does not leave a partial file when rename fails', () => {
    const dir = tempDir();
    const filePath = path.join(dir, 'runtime.json');
    fs.writeFileSync(filePath, '{"ok":true}\n', 'utf8');

    const originalRename = fs.renameSync;
    fs.renameSync = () => { throw new Error('simulated rename failure'); };
    try {
      assert.throws(() => writeJsonAtomic(filePath, { ok: false }), /simulated rename failure/);
    } finally {
      fs.renameSync = originalRename;
    }

    assert.equal(fs.readFileSync(filePath, 'utf8'), '{"ok":true}\n');
    assert.deepEqual(fs.readdirSync(dir).filter(name => name.includes('.tmp')), []);
  });

  it('text write preserves content exactly', () => {
    const dir = tempDir();
    const filePath = path.join(dir, 'pipeline.md');
    const content = '# Pipeline\n\n## Pendientes\n\n- [ ] https://example.com | Acme | CSM\n';

    writeTextAtomic(filePath, content);

    assert.equal(fs.readFileSync(filePath, 'utf8'), content);
  });
});

describe('runtime writers use atomic helpers', () => {
  it('uses helpers for replace-style runtime files where practical', () => {
    assert.match(read('gmail-sync.mjs'), /writeJsonAtomic\(GMAIL_JOBS_PATH/);
    assert.match(read('lib/ab-analytics.mjs'), /writeJsonAtomic\(ANALYTICS_PATH/);
    assert.match(read('lib/data.mjs'), /writeTextAtomic\(filePath, updated\)/);
    assert.match(read('scan.mjs'), /writeTextAtomic\(PIPELINE_PATH, text\)/);
    assert.match(read('scan-linkedin.mjs'), /writeTextAtomic\(PIPELINE_PATH, text\)/);
    assert.match(read('lib/evaluator.mjs'), /writeTextAtomic\(path\.resolve\(reportsDir, filename\), content\)/);
  });

  it('uses safe append helper for scanner history appends', () => {
    assert.match(read('scan.mjs'), /appendTextSafe\(SCAN_HISTORY_PATH, lines\)/);
    assert.match(read('scan-linkedin.mjs'), /appendTextSafe\(SCAN_HISTORY_PATH, lines\)/);
  });
});
