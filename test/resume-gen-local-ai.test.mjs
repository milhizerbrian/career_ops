// Regression: resume generation must never reach Anthropic (Career-Ops uses
// no paid AI APIs). Static check over resume-gen's local module graph; the
// runtime request check lives in resume-gen.test.mjs (DOCX-first finish).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function localImportGraph(entry) {
  const seen = new Set();
  const stack = [path.resolve(APP_ROOT, entry)];
  while (stack.length) {
    const file = stack.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    const text = fs.readFileSync(file, 'utf8');
    for (const m of text.matchAll(/from\s+['"](\.{1,2}\/[^'"]+)['"]/g)) {
      stack.push(path.resolve(path.dirname(file), m[1]));
    }
  }
  return [...seen];
}

describe('resume generation uses local AI only', () => {
  it('no module reachable from resume-gen imports the Anthropic SDK or calls its API', () => {
    for (const file of localImportGraph('lib/resume-gen.mjs')) {
      const text = fs.readFileSync(file, 'utf8');
      assert.doesNotMatch(text, /@anthropic-ai\/sdk|api\.anthropic\.com/, path.relative(APP_ROOT, file));
    }
  });
});
