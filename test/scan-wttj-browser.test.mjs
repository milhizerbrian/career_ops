import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  buildWttjDetailQueue,
  buildWttjSearchUrl,
  extractWttjJobUrls,
  isWttjLoginUrl,
  normalizeWttjJobId,
  normalizeWttjJobUrl,
  parseWttjJobDetail,
} from '../lib/wttj-browser-utils.mjs';

describe('WTTJ browser helpers', () => {
  it('detects WTTJ login redirects', () => {
    assert.equal(isWttjLoginUrl('https://app.welcometothejungle.com/login?redirect=%2F'), true);
    assert.equal(isWttjLoginUrl('https://app.welcometothejungle.com/jobs/Kt1Sbyrv'), false);
    assert.equal(isWttjLoginUrl('https://www.welcometothejungle.com/en'), false);
  });

  it('normalizes app job IDs and canonical URLs', () => {
    assert.equal(normalizeWttjJobId('https://app.welcometothejungle.com/jobs/Kt1Sbyrv/company'), 'Kt1Sbyrv');
    assert.equal(normalizeWttjJobId('https://app.welcometothejungle.com/dashboard/jobs/Kt1Sbyrv'), 'Kt1Sbyrv');
    assert.equal(normalizeWttjJobId('/jobs/abc_123-XYZ'), 'abc_123-XYZ');
    assert.equal(normalizeWttjJobUrl('/dashboard/jobs/abc_123-XYZ'), 'https://app.welcometothejungle.com/jobs/abc_123-XYZ');
    assert.equal(normalizeWttjJobUrl('/jobs/abc_123-XYZ/company'), 'https://app.welcometothejungle.com/jobs/abc_123-XYZ');
    assert.equal(normalizeWttjJobId('https://www.welcometothejungle.com/en/companies/foo/jobs/bar'), '');
  });

  it('extracts canonical app job URLs from anchors and raw HTML', () => {
    const html = `
      <a href="/jobs/Kt1Sbyrv/company">Role</a>
      <a href="/dashboard/jobs/dash456">Dashboard role</a>
      <a href="https://app.welcometothejungle.com/jobs/abc_123">Other role</a>
      <script>window.__x = "https://app.welcometothejungle.com/jobs/xyz-789/company";</script>
      <a href="https://www.welcometothejungle.com/en/companies/foo/jobs/bar">Public job</a>
    `;
    assert.deepEqual(extractWttjJobUrls(html), [
      'https://app.welcometothejungle.com/jobs/Kt1Sbyrv',
      'https://app.welcometothejungle.com/jobs/dash456',
      'https://app.welcometothejungle.com/jobs/abc_123',
      'https://app.welcometothejungle.com/jobs/xyz-789',
    ]);
  });

  it('builds configured WTTJ search URLs', () => {
    assert.equal(
      buildWttjSearchUrl('customer success security', 2),
      'https://app.welcometothejungle.com/jobs?query=customer+success+security&page=3'
    );
  });

  it('parses representative WTTJ job detail HTML', () => {
    const html = `
      <main>
        <h1>Strategic Customer Success Manager, <a href="https://example.com">Example Security</a></h1>
        <div>Remote - United States</div>
        <div>$160K - $190K</div>
        <h2>Role</h2>
        <p>Own executive customer relationships and drive adoption plans for enterprise security accounts.</p>
        <p>Partner with product and support teams to resolve escalations and improve retention.</p>
        <h2>Requirements</h2>
        <p>7+ years of experience in customer success, technical account management, or security consulting.</p>
        <p>Experience with IAM, SIEM, endpoint security, or cloud security programs is required.</p>
      </main>
    `;

    const job = parseWttjJobDetail(html, 'https://app.welcometothejungle.com/jobs/Kt1Sbyrv');

    assert.equal(job.id, 'wttj-app-Kt1Sbyrv');
    assert.equal(job.title, 'Strategic Customer Success Manager');
    assert.equal(job.company, 'Example Security');
    assert.equal(job.location, 'Remote - United States');
    assert.equal(job.compensation, '$160K - $190K');
    assert.ok(job.responsibilities.some(item => /Own executive customer relationships/i.test(item)));
    assert.ok(job.requirements.some(item => /7\+ years of experience/i.test(item)));
  });

  it('builds a deduped detail queue and skips already seen saved jobs', () => {
    const sources = new Map([
      ['seen123', 'wttj-saved'],
      ['new456', 'wttj-browser'],
      ['new789', 'wttj-recommended'],
    ]);

    assert.deepEqual(buildWttjDetailQueue(sources, new Set(['seen123']), 1), [{
      id: 'new456',
      source: 'wttj-browser',
      url: 'https://app.welcometothejungle.com/jobs/new456',
    }]);
  });
});
