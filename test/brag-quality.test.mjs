import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeBragDocQuality, formatBragQualityReport } from '../lib/brag-quality.mjs';

describe('brag doc source quality coach', () => {
  it('flags missing evidence categories with concise prompts', () => {
    const report = analyzeBragDocQuality('Led customer programs and helped accounts succeed.');
    const byKey = Object.fromEntries(report.categories.map(c => [c.key, c]));

    assert.equal(byKey.metrics.status, 'missing');
    assert.equal(byKey.tools_platforms.status, 'missing');
    assert.equal(byKey.technical_depth.status, 'missing');
    assert.ok(byKey.metrics.prompts[0].includes('Where can you add numbers'));
    assert.ok(report.summary.advisoryCount >= 3);
  });

  it('recognizes covered source evidence without adding prompts', () => {
    const markdown = `
      Managed $23M ARR across 42 enterprise accounts, preserved 98% GRR, expanded revenue 122%, and improved CSAT 18%.
      Built a renewal recovery playbook through QBR cadence, adoption plans, maturity model, stakeholder realignment, and automated executive reporting.
      Partnered with CISO, CIO, VP Security, SOC directors, product, sales, engineering, and implementation stakeholders.
      Used Salesforce, Gainsight, ServiceNow, Jira, ExtraHop, Splunk, AWS, Azure, SIEM, NDR, XDR, EDR, IAM, SOAR, and API integrations.
      Improved retention, expansion, adoption, revenue growth, churn reduction, time-to-value, and risk reduction.
      Led hybrid-cloud architecture, detection engineering, incident response, MITRE mapping, endpoint telemetry, network workflows, and zero trust deployments.
    `;
    const report = analyzeBragDocQuality(markdown);

    assert.deepEqual(report.summary.missingCategories, []);
    assert.deepEqual(report.summary.weakCategories, []);
    assert.ok(report.categories.every(c => c.status === 'strong'));
    assert.ok(report.categories.every(c => c.prompts.length === 0));
  });

  it('formats advisory CLI output', () => {
    const report = analyzeBragDocQuality('Owned renewals with CISO stakeholders.');
    const output = formatBragQualityReport(report);

    assert.match(output, /Brag Doc Source Quality Coach/);
    assert.match(output, /Metrics: missing/);
    assert.match(output, /Tools\/platforms: missing/);
  });
});
