import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

describe('package scan scripts', () => {
  it('uses the authenticated LinkedIn browser scan as the default LinkedIn scan', () => {
    assert.equal(pkg.scripts['scan:linkedin'], 'node scan-linkedin-browser.mjs');
    assert.equal(pkg.scripts['pipeline:linkedin'], 'npm run scan:linkedin');
  });

  it('keeps the LinkedIn guest API as an explicit fallback only', () => {
    assert.equal(pkg.scripts['scan:linkedin:guest'], 'node scan-linkedin.mjs');
    assert.doesNotMatch(pkg.scripts['pipeline:all'], /scan-linkedin\.mjs/);
    assert.match(pkg.scripts['pipeline:all'], /npm run scan:linkedin/);
  });
});
