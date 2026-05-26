// test/scan-linkedin-browser.test.mjs
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  isAuthWall,
  buildSavedJobsUrl,
  buildRecommendedUrl,
  scrapePageIds,
  paginationUrls,
  isCookieStale,
} from '../scan-linkedin-browser.mjs';

describe('isAuthWall', () => {
  it('returns true for /login URL', () => {
    assert.equal(isAuthWall('https://www.linkedin.com/login'), true);
  });
  it('returns true for /authwall URL', () => {
    assert.equal(isAuthWall('https://www.linkedin.com/authwall'), true);
  });
  it('returns true for /checkpoint URL', () => {
    assert.equal(isAuthWall('https://www.linkedin.com/checkpoint/something'), true);
  });
  it('returns false for /feed', () => {
    assert.equal(isAuthWall('https://www.linkedin.com/feed'), false);
  });
  it('returns false for jobs search URL', () => {
    assert.equal(isAuthWall('https://www.linkedin.com/jobs/search/?keywords=CSM'), false);
  });
});

describe('buildSavedJobsUrl', () => {
  it('returns the LinkedIn jobs-tracker URL', () => {
    assert.equal(buildSavedJobsUrl(), 'https://www.linkedin.com/jobs-tracker/');
  });
});

describe('buildRecommendedUrl', () => {
  it('returns the LinkedIn recommended jobs collection URL', () => {
    assert.equal(buildRecommendedUrl(), 'https://www.linkedin.com/jobs/collections/recommended/');
  });
});

describe('scrapePageIds', () => {
  it('extracts IDs from data-entity-urn attributes', () => {
    const html = `
      <ul>
        <li data-entity-urn="urn:li:jobPosting:1234567890">Job A</li>
        <li data-entity-urn="urn:li:jobPosting:9876543210">Job B</li>
      </ul>`;
    const ids = scrapePageIds(html);
    assert.deepEqual(ids.sort(), ['1234567890', '9876543210'].sort());
  });

  it('falls back to data-job-id attributes', () => {
    const html = `
      <div data-job-id="1111111111">Job A</div>
      <div data-job-id="2222222222">Job B</div>`;
    const ids = scrapePageIds(html);
    assert.deepEqual(ids.sort(), ['1111111111', '2222222222'].sort());
  });

  it('deduplicates IDs appearing in both attribute types', () => {
    const html = `
      <li data-entity-urn="urn:li:jobPosting:3333333333" data-job-id="3333333333">Job</li>`;
    const ids = scrapePageIds(html);
    assert.equal(ids.length, 1);
    assert.equal(ids[0], '3333333333');
  });

  it('returns empty array when no IDs found', () => {
    const html = '<div class="no-jobs">Nothing here</div>';
    const ids = scrapePageIds(html);
    assert.deepEqual(ids, []);
  });

  it('ignores non-job entity URNs', () => {
    const html = `
      <li data-entity-urn="urn:li:company:12345">Company</li>
      <li data-entity-urn="urn:li:jobPosting:9999999999">Job</li>`;
    const ids = scrapePageIds(html);
    assert.deepEqual(ids, ['9999999999']);
  });
});

describe('paginationUrls', () => {
  const search = { keywords: 'Customer Success Manager', location: 'United States', f_WT: '2' };

  it('returns 1 URL for pages=1 with start=0', () => {
    const urls = paginationUrls(search, 1);
    assert.equal(urls.length, 1);
    assert.ok(urls[0].includes('start=0'));
    assert.ok(urls[0].includes('Customer+Success+Manager') || urls[0].includes('Customer%20Success%20Manager'));
  });

  it('returns 3 URLs for pages=3 with start=0,25,50', () => {
    const urls = paginationUrls(search, 3);
    assert.equal(urls.length, 3);
    assert.ok(urls[0].includes('start=0'));
    assert.ok(urls[1].includes('start=25'));
    assert.ok(urls[2].includes('start=50'));
  });

  it('includes location in URLs', () => {
    const urls = paginationUrls(search, 1);
    assert.ok(urls[0].includes('United+States') || urls[0].includes('United%20States'));
  });

  it('includes f_WT filter in URLs', () => {
    const urls = paginationUrls(search, 1);
    assert.ok(urls[0].includes('f_WT=2'));
  });

  it('uses /jobs/search/ base path (not guest API)', () => {
    const urls = paginationUrls(search, 1);
    assert.ok(urls[0].includes('linkedin.com/jobs/search/'));
    assert.ok(!urls[0].includes('jobs-guest'));
  });
});

describe('isCookieStale', () => {
  it('returns false for a cookie saved yesterday', () => {
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    assert.equal(isCookieStale(yesterday, 30), false);
  });

  it('returns true for a cookie saved 31 days ago', () => {
    const old = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
    assert.equal(isCookieStale(old, 30), true);
  });

  it('returns false for a cookie saved exactly 29 days ago', () => {
    const fresh = new Date(Date.now() - 29 * 24 * 60 * 60 * 1000).toISOString();
    assert.equal(isCookieStale(fresh, 30), false);
  });

  it('returns true for null savedAt', () => {
    assert.equal(isCookieStale(null, 30), true);
  });

  it('returns true for undefined savedAt', () => {
    assert.equal(isCookieStale(undefined, 30), true);
  });
});
