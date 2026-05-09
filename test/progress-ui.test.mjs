import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const progress = fs.readFileSync(path.resolve(APP_ROOT, 'public', 'js', 'progress.js'), 'utf8');
const dashboard = fs.readFileSync(path.resolve(APP_ROOT, 'public', 'js', 'dashboard.js'), 'utf8');

describe('resume progress UI labels', () => {
  it('maps all current resume backend stages to friendly labels', () => {
    for (const stage of [
      'strategy-selection',
      'validation',
      'page-check',
      'docx',
      'warning',
      'skipped',
    ]) {
      assert.match(progress, new RegExp(`'${stage}'\\s*:`));
    }
  });

  it('falls back to humanized labels for unknown stages', () => {
    assert.match(progress, /export function humanizeStage\(stage\)/);
    assert.match(dashboard, /STAGE_LABELS\[baseStage\]\s*\?\?\s*humanizeStage\(baseStage\)/);
  });
});
