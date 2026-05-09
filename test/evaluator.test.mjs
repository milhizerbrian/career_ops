import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { slugToTitle, extractCompanyFromUrl } from '../lib/evaluator.mjs';

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
