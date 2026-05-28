import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { slugToTitle, extractCompanyFromUrl } from '../lib/evaluator.mjs';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => fs.readFileSync(path.resolve(APP_ROOT, file), 'utf8');

describe('slugToTitle', () => {
  it('converts hyphenated slug to title case', () => {
    assert.equal(slugToTitle('palo-alto-networks'), 'Palo Alto Networks');
  });
  it('strips trailing numeric suffix', () => {
    assert.equal(slugToTitle('wiz-1'), 'Wiz');
  });
  it('handles single word', () => {
    assert.equal(slugToTitle('crowdstrike'), 'Crowdstrike');
  });
  it('handles underscore separator', () => {
    assert.equal(slugToTitle('extra_hop'), 'Extra Hop');
  });
  it('returns empty string for empty input', () => {
    assert.equal(slugToTitle(''), '');
  });
});

describe('extractCompanyFromUrl', () => {
  it('extracts company from Greenhouse URL', () => {
    assert.equal(
      extractCompanyFromUrl('https://boards.greenhouse.io/wiz/jobs/6372189003'),
      'Wiz'
    );
  });
  it('extracts company from Lever URL', () => {
    assert.equal(
      extractCompanyFromUrl('https://jobs.lever.co/crowdstrike/abc-123-def'),
      'Crowdstrike'
    );
  });
  it('extracts company from Ashby URL', () => {
    assert.equal(
      extractCompanyFromUrl('https://jobs.ashbyhq.com/palo-alto-networks/abc-123'),
      'Palo Alto Networks'
    );
  });
  it('extracts company from WTTJ URL', () => {
    assert.equal(
      extractCompanyFromUrl('https://www.welcometothejungle.com/en/companies/extrahop/jobs/sr-csm_seattle'),
      'Extrahop'
    );
  });
  it('returns empty string for unknown URL', () => {
    assert.equal(
      extractCompanyFromUrl('https://careers.somecompany.com/job/12345'),
      ''
    );
  });
  it('returns empty string for empty input', () => {
    assert.equal(extractCompanyFromUrl(''), '');
  });
});

describe('expensive resource reuse wiring', () => {
  it('caches the evaluator Anthropic client by API key', () => {
    const evaluator = read('lib/evaluator.mjs');

    assert.match(evaluator, /let anthropicClient = null/);
    assert.match(evaluator, /function getAnthropicClient\(apiKey\)/);
    assert.match(evaluator, /anthropicClientKey !== apiKey/);
    assert.match(evaluator, /const client = getAnthropicClient\(apiKey\)/);
  });

  it('supports opt-out Playwright browser pooling with fresh contexts', () => {
    const browser = read('lib/gologin-browser.mjs');

    assert.match(browser, /CAREER_OPS_BROWSER_POOL !== '0'/);
    assert.match(browser, /pooledBrowserPromises/);
    assert.match(browser, /browser\.newContext\(\)/);
    assert.match(browser, /export async function closePooledBrowsers/);
    assert.match(browser, /SIGINT/);
    assert.match(browser, /SIGTERM/);
  });
});
