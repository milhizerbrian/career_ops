import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => fs.readFileSync(path.resolve(APP_ROOT, file), 'utf8');
const exists = (file) => fs.existsSync(path.resolve(APP_ROOT, file));

describe('frontend asset loading', () => {
  it('serves dashboard framework and icon assets locally', () => {
    const html = read('public/index.html');

    assert.match(html, /src="\/vendor\/tailwindcss-forms-container-queries\.js"/);
    assert.match(html, /href="\/vendor\/material-symbols\.css"/);
    assert.ok(exists('public/vendor/tailwindcss-forms-container-queries.js'));
    assert.ok(exists('public/vendor/material-symbols.css'));
    assert.ok(exists('public/vendor/material-symbols-outlined.ttf'));
  });

  it('does not depend on remote frontend font or framework hosts', () => {
    const html = read('public/index.html');
    const materialCss = read('public/vendor/material-symbols.css');

    for (const remoteHost of ['cdn.tailwindcss.com', 'fonts.googleapis.com', 'fonts.gstatic.com']) {
      assert.doesNotMatch(html, new RegExp(remoteHost));
      assert.doesNotMatch(materialCss, new RegExp(remoteHost));
    }
  });

  it('uses a system font stack instead of a downloaded text font', () => {
    const html = read('public/index.html');

    assert.match(html, /font-family: ui-sans-serif, system-ui/);
    assert.doesNotMatch(html, /font-family: 'Inter'/);
  });
});
