import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { load as cheerioLoad } from 'cheerio';
import { parseDetail, parseSections } from '../scan-linkedin.mjs';

describe('scan-linkedin section parsing', () => {
  it('parses flat LinkedIn description text into responsibilities and requirements', () => {
    const html = `
      <div class="show-more-less-html__markup">
        <p><strong>About the role</strong></p>
        <p>Own executive customer relationships and drive adoption plans for enterprise security accounts.</p>
        <p>Partner with product and support teams to resolve escalations and improve retention.</p>
        <p><strong>What we're looking for</strong></p>
        <p>7+ years of experience in customer success, technical account management, or security consulting.</p>
        <p>Experience with IAM, SIEM, endpoint security, or cloud security programs is required.</p>
      </div>`;
    const $ = cheerioLoad(html);

    const sections = parseSections($, $('.show-more-less-html__markup').first());

    assert.ok(sections.responsibilities.some(item => /Own executive customer relationships/i.test(item)));
    assert.ok(sections.requirements.some(item => /7\+ years of experience/i.test(item)));
    assert.ok(sections.requirements.some(item => /IAM, SIEM/i.test(item)));
  });

  it('falls back to later description selectors when the first selector is absent', () => {
    const job = parseDetail(`
      <html>
        <body>
          <h1 class="top-card-layout__title">Strategic Customer Success Manager</h1>
          <a class="topcard__org-name-link">Example Security</a>
          <span class="topcard__flavor--bullet">Remote</span>
          <section class="description__text">
            <div>
              Responsibilities:
              Lead customer onboarding, renewal readiness, and security value reviews.
              Requirements:
              Must have experience with cybersecurity SaaS customers and executive stakeholders.
            </div>
          </section>
        </body>
      </html>
    `, '123');

    assert.equal(job.title, 'Strategic Customer Success Manager');
    assert.equal(job.company, 'Example Security');
    assert.ok(job.description.includes('Lead customer onboarding'));
    assert.ok(job.responsibilities.some(item => /Lead customer onboarding/i.test(item)));
    assert.ok(job.requirements.some(item => /cybersecurity SaaS customers/i.test(item)));
  });
});
