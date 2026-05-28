import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadJdFromReports } from '../lib/data.mjs';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('data report lookup cache', () => {
  it('returns updated report content after the report file mtime changes', () => {
    const reportsDir = path.resolve(APP_ROOT, 'reports');
    fs.mkdirSync(reportsDir, { recursive: true });
    const id = `cache-test-${process.pid}-${Date.now()}`;
    const reportPath = path.resolve(reportsDir, `${id}-report.md`);

    try {
      fs.writeFileSync(reportPath, 'first report content', 'utf8');
      assert.equal(loadJdFromReports(id), 'first report content');

      fs.writeFileSync(reportPath, 'second report content', 'utf8');
      const future = new Date(Date.now() + 5000);
      fs.utimesSync(reportPath, future, future);

      assert.equal(loadJdFromReports(id), 'second report content');
    } finally {
      fs.rmSync(reportPath, { force: true });
    }
  });
});
