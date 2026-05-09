import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computeOiScore } from '../lib/opportunity-intelligence.mjs';

describe('computeOiScore — bare job (no signals, no text)', () => {
  it('returns score 0 and all 6 factors Unknown', () => {
    const result = computeOiScore({ company: 'Acme', title: 'CSM' });
    assert.equal(result.score, 0);
    assert.equal(result.rating, 'Risky');
    assert.equal(result.factors.length, 6);
    assert.equal(result.unknowns.length, 6);
    for (const f of result.factors) {
      assert.equal(f.score, 0);
      assert.equal(f.value, 'Unknown');
      assert.equal(f.source, 'unknown');
    }
  });
});

describe('computeOiScore — manual oi_signals', () => {
  it('perfect signals yield 97 (Excellent)', () => {
    const job = {
      oi_signals: {
        funding_stage: 'series_c',
        revenue_trend: 'positive',
        layoff_risk: 'low',
        hiring_velocity: 'high',
        leadership_stability: 'stable',
        pmf_signals: 'strong',
      },
    };
    const result = computeOiScore(job);
    // 12 + 20 + 20 + 15 + 15 + 15 = 97
    assert.equal(result.score, 97);
    assert.equal(result.rating, 'Excellent');
    assert.equal(result.unknowns.length, 0);
  });

  it('public company scores 15 for funding_stage', () => {
    const job = { oi_signals: { funding_stage: 'public' } };
    const result = computeOiScore(job);
    const f = result.factors.find(x => x.name === 'Funding Stage');
    assert.equal(f.score, 15);
    assert.equal(f.value, 'Public');
    assert.equal(f.source, 'manual');
  });

  it('high layoff_risk scores 0', () => {
    const job = { oi_signals: { layoff_risk: 'high' } };
    const result = computeOiScore(job);
    const f = result.factors.find(x => x.name === 'Layoff Risk');
    assert.equal(f.score, 0);
    assert.equal(f.value, 'High');
  });

  it('recent_changes leadership scores 8', () => {
    const job = { oi_signals: { leadership_stability: 'recent_changes' } };
    const result = computeOiScore(job);
    const f = result.factors.find(x => x.name === 'Leadership Stability');
    assert.equal(f.score, 8);
    assert.equal(f.value, 'Recent Changes');
  });

  it('unrecognized signal value falls through to Unknown', () => {
    const job = { oi_signals: { funding_stage: 'unicorn_round' } };
    const result = computeOiScore(job);
    const f = result.factors.find(x => x.name === 'Funding Stage');
    assert.equal(f.value, 'Unknown');
    assert.equal(f.score, 0);
    assert.ok(result.unknowns.includes('Funding Stage'));
  });
});

describe('computeOiScore — text inference', () => {
  it('infers Series C from full_description', () => {
    const job = { full_description: 'We recently closed our Series C round of $150M.' };
    const result = computeOiScore(job);
    const f = result.factors.find(x => x.name === 'Funding Stage');
    assert.equal(f.value, 'Series C');
    assert.equal(f.source, 'inferred');
    assert.equal(f.score, 12);
  });

  it('infers Series B from description_preview', () => {
    const job = { description_preview: 'After closing our Series B last year we are growing fast.' };
    const result = computeOiScore(job);
    const f = result.factors.find(x => x.name === 'Funding Stage');
    assert.equal(f.value, 'Series B');
    assert.equal(f.score, 10);
  });

  it('infers low layoff risk from hiring language', () => {
    const job = { description_preview: 'We are expanding our team and hiring aggressively.' };
    const result = computeOiScore(job);
    const f = result.factors.find(x => x.name === 'Layoff Risk');
    assert.equal(f.value, 'Low');
    assert.equal(f.score, 20);
  });

  it('infers high layoff risk from restructuring language', () => {
    const job = { full_description: 'Following our restructuring last quarter, we are rebuilding.' };
    const result = computeOiScore(job);
    const f = result.factors.find(x => x.name === 'Layoff Risk');
    assert.equal(f.value, 'High');
    assert.equal(f.score, 0);
  });

  it('infers strong PMF from Gartner mention', () => {
    const job = { description_preview: 'We are a Gartner Magic Quadrant leader in cloud security.' };
    const result = computeOiScore(job);
    const f = result.factors.find(x => x.name === 'Product Market Fit');
    assert.equal(f.value, 'Strong');
    assert.equal(f.score, 15);
  });

  it('manual oi_signals override inferred text', () => {
    const job = {
      full_description: 'We recently closed our Series C round.',
      oi_signals: { funding_stage: 'series_b' },
    };
    const result = computeOiScore(job);
    const f = result.factors.find(x => x.name === 'Funding Stage');
    assert.equal(f.value, 'Series B');
    assert.equal(f.source, 'manual');
    assert.equal(f.score, 10);
  });
});

describe('rating bands', () => {
  it('85+ = Excellent', () => {
    const job = {
      oi_signals: {
        funding_stage: 'public',
        revenue_trend: 'positive',
        layoff_risk: 'low',
        hiring_velocity: 'high',
        leadership_stability: 'stable',
        pmf_signals: 'strong',
      },
    };
    assert.equal(computeOiScore(job).rating, 'Excellent');
  });

  it('70-84 = Strong', () => {
    const job = {
      oi_signals: {
        funding_stage: 'series_c',
        revenue_trend: 'positive',
        layoff_risk: 'low',
        hiring_velocity: 'moderate',
      },
    };
    const r = computeOiScore(job);
    // 12 + 20 + 20 + 10 = 62 — fair, need to adjust
    // Let's use series_d_plus + positive + low + high + stable = 13+20+20+15+15 = 83 → Strong
    const job2 = {
      oi_signals: {
        funding_stage: 'series_d_plus',
        revenue_trend: 'positive',
        layoff_risk: 'low',
        hiring_velocity: 'high',
        leadership_stability: 'stable',
      },
    };
    const r2 = computeOiScore(job2);
    assert.ok(r2.score >= 70 && r2.score < 85, `Expected Strong range, got ${r2.score}`);
    assert.equal(r2.rating, 'Strong');
  });

  it('55-69 = Fair', () => {
    const job = {
      oi_signals: {
        funding_stage: 'series_a',
        revenue_trend: 'flat',
        layoff_risk: 'medium',
        hiring_velocity: 'moderate',
        leadership_stability: 'recent_changes',
      },
    };
    const r = computeOiScore(job);
    // 7 + 10 + 10 + 10 + 8 = 45 — risky. Adjust:
    // series_b + positive + medium + high = 10+20+10+15 = 55 → Fair
    const job2 = {
      oi_signals: {
        funding_stage: 'series_b',
        revenue_trend: 'positive',
        layoff_risk: 'medium',
        hiring_velocity: 'high',
      },
    };
    const r2 = computeOiScore(job2);
    assert.ok(r2.score >= 55 && r2.score < 70, `Expected Fair range, got ${r2.score}`);
    assert.equal(r2.rating, 'Fair');
  });

  it('0-54 = Risky', () => {
    const job = { oi_signals: { revenue_trend: 'negative', layoff_risk: 'high' } };
    const r = computeOiScore(job);
    assert.ok(r.score < 55, `Expected Risky range, got ${r.score}`);
    assert.equal(r.rating, 'Risky');
  });
});
