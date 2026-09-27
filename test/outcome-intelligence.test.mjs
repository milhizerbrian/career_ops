import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { buildOutcomeIntelligence, MIN_SAMPLE, furthestStageRank } from '../lib/outcome-intelligence.mjs';

const NOW = new Date('2026-09-27T12:00:00.000Z');
const d = days => new Date(NOW.getTime() - days * 86400000).toISOString();

function ev(type, daysAgo, extra = {}) {
  return { type, at: d(daysAgo), source: 'test', label: '', note: '', ...extra };
}

// 10 LinkedIn applications (4 interviews, 1 offer, 3 rejected) + 3 manual
// applications (0 interviews) + discovered-only noise + a Not Interested.
function fixture() {
  const jobs = [];
  for (let i = 0; i < 10; i += 1) {
    const timeline = [ev('discovered', 60), ev('applied', 50 - i)];
    let stage = 'applied';
    if (i < 4) { timeline.push(ev('interview_scheduled', 40 - i)); stage = 'interview'; }
    if (i === 0) { timeline.push(ev('stage_changed', 20, { from: 'interview', to: 'offer' }), ev('offer_received', 20)); stage = 'offer'; }
    if (i >= 7) { timeline.push(ev('stage_changed', 30, { from: 'applied', to: 'rejected' }), ev('rejected', 30)); stage = 'rejected'; }
    jobs.push({
      id: `li-${i}`, company: i < 2 ? 'Acme' : `Co${i}`, title: 'Senior Customer Success Manager',
      source: 'linkedin-browser', stage, status: 'applied', score: i < 5 ? 4.5 : 3,
      date_found: d(60), location: 'Remote', workflowTimeline: timeline,
      generatedDocs: i < 6 ? { default: { docxUrl: '/x.docx' } } : {},
      contacts: i < 3 ? [{ id: 'c', name: 'Ref', relationshipType: 'referral' }] : [],
    });
  }
  for (let i = 0; i < 3; i += 1) {
    jobs.push({
      id: `m-${i}`, company: `Man${i}`, title: 'Solutions Engineer', source: 'manual', stage: 'applied', status: 'applied',
      score: 2, date_found: d(30), location: 'Dallas, TX', workflowTimeline: [ev('applied', 25)],
    });
  }
  jobs.push({ id: 'disc', company: 'Z', title: 'CSM', source: 'linkedin-browser', stage: 'discovered', status: 'lead', date_found: d(5) });
  jobs.push({
    id: 'not-interested', company: 'Y', title: 'CSM', source: 'linkedin-browser', stage: 'rejected', status: 'rejected', date_found: d(5),
    workflowTimeline: [ev('stage_changed', 4, { from: 'discovered', to: 'rejected' })],
  });
  jobs.push({ id: 'legacy-gmail-reject', company: 'G', title: 'TAM', source: 'gmail', status: 'rejected', last_email_date: d(3) });
  return jobs;
}

describe('furthestStageRank', () => {
  it('uses history, not just current stage', () => {
    assert.equal(furthestStageRank({ stage: 'rejected', workflowTimeline: [ev('stage_changed', 1, { from: 'interview', to: 'rejected' })] }), 3);
    assert.equal(furthestStageRank({ stage: 'withdrawn', workflowTimeline: [ev('applied', 2)] }), 2);
    assert.equal(furthestStageRank({ stage: 'discovered', interviews: [{ id: 'r', roundType: 'panel' }] }), 3);
    assert.equal(furthestStageRank({ status: 'hiring_manager_screen' }), 3);
    assert.equal(furthestStageRank({ stage: 'pursuing' }), 1);
    assert.equal(furthestStageRank({ stage: 'rejected' }), 0);
  });
});

describe('buildOutcomeIntelligence', () => {
  const report = buildOutcomeIntelligence(fixture(), { now: NOW });

  it('builds a funnel from furthest stage reached', () => {
    const f = report.funnel;
    assert.equal(f.discovered, 16);
    assert.equal(f.applied, 14, '13 applications + legacy Gmail rejection inferred as applied');
    assert.equal(f.interview, 4);
    assert.equal(f.offer, 1);
    assert.equal(f.rejectedAfterApplying, 4);
    assert.equal(f.closedBeforeApplying, 1);
  });

  it('computes conversions with explicit sample sufficiency', () => {
    const c = Object.fromEntries(report.conversions.map(x => [x.id, x]));
    assert.deepEqual([c.applied_to_interview.numerator, c.applied_to_interview.denominator], [4, 14]);
    assert.equal(c.applied_to_interview.sufficient, true);
    assert.equal(c.applied_to_interview.rate, 4 / 14);
    assert.deepEqual([c.interview_to_offer.numerator, c.interview_to_offer.denominator], [1, 4]);
    assert.equal(c.interview_to_offer.sufficient, false, `needs ${MIN_SAMPLE}+ interviews`);
  });

  it('segments outcomes by source, fit range, role, company, arrangement, resume, and networking', () => {
    const seg = report.segments;
    const li = seg.source.rows.find(r => r.key === 'linkedin-browser');
    assert.equal(li.applied, 10);
    assert.equal(li.interviews, 4);
    assert.equal(li.interviewRate.sufficient, true);
    const manual = seg.source.rows.find(r => r.key === 'manual');
    assert.equal(manual.interviewRate.sufficient, false);
    assert.equal(seg.fitRange.rows.find(r => r.key === '80-100').applied, 5);
    assert.ok(seg.roleCategory.rows.some(r => r.key === 'customer_success'));
    assert.equal(seg.company.rows.find(r => r.label === 'Acme').applied, 2);
    assert.equal(seg.workArrangement.rows.find(r => r.key === 'remote').applied, 10);
    assert.equal(seg.resume.rows.find(r => r.key === 'generated').applied, 6);
    assert.equal(seg.networking.rows.find(r => r.key === 'referral').applied, 3);
  });

  it('only reports timing from recorded timestamps', () => {
    const t = Object.fromEntries(report.timing.map(x => [x.id, x]));
    assert.equal(t.applied_to_first_interview.n, 4);
    assert.equal(t.applied_to_first_interview.sufficient, false);
    assert.equal(t.discovered_to_applied.n, 13);
    assert.equal(t.posted_to_applied.n, 0);
    assert.equal(t.posted_to_applied.medianDays, null);
  });

  it('states insufficient data instead of drawing conclusions, and frames findings as associations', () => {
    assert.ok(report.insights.every(i => ['measured', 'insufficient'].includes(i.kind)));
    const measured = report.insights.filter(i => i.kind === 'measured');
    for (const i of measured) {
      assert.match(i.text, /\(\d+\/\d+\)|\(n=\d+/, 'measured insights cite counts');
      assert.doesNotMatch(i.text, /because|causes|leads to/i);
    }
    assert.ok(report.insights.some(i => i.kind === 'insufficient' && /offer/i.test(i.text)));
    assert.ok(report.assumptions.length > 0);
    assert.ok(report.dataGaps.some(g => /posted/i.test(g)));
  });

  it('flags known selection bias for Gmail-created opportunities', () => {
    const jobs = [];
    for (let i = 0; i < 6; i += 1) jobs.push({ id: `g${i}`, source: 'gmail', status: 'recruiter_screen', last_email_date: d(2), workflowTimeline: [ev('applied', 9)] });
    for (let i = 0; i < 12; i += 1) jobs.push({ id: `l${i}`, source: 'linkedin-browser', stage: 'applied', score: 3, workflowTimeline: [ev('applied', 9)] });
    const r = buildOutcomeIntelligence(jobs, { now: NOW });
    const gmail = r.segments.source.rows.find(x => x.key === 'gmail');
    assert.match(gmail.caveat, /biased/);
    const insight = r.insights.find(i => i.kind === 'measured' && /"gmail"/.test(i.text));
    assert.ok(insight);
    assert.match(insight.text, /Caveat: .*biased/);
  });

  it('handles an empty tracker without throwing or inventing rates', () => {
    const empty = buildOutcomeIntelligence([], { now: NOW });
    assert.equal(empty.funnel.discovered, 0);
    assert.ok(empty.conversions.every(c => c.rate === null && c.sufficient === false));
    assert.ok(empty.insights.every(i => i.kind === 'insufficient'));
  });
});
