/**
 * Opportunity Intelligence Scoring
 *
 * Answers: "Should I want this job?" — separate from ATS match scoring.
 * Score: 0–100 across 6 factors.
 *
 * Data sources (in priority order):
 *   1. job.oi_signals — manually populated fields (highest fidelity)
 *   2. Text inference from full_description / description_preview / score_analysis
 *   3. Unknown (score 0, listed in unknowns array)
 *
 * Never calls external APIs. Never invents data.
 */

// ── Factor definitions ────────────────────────────────────────────────────────

const FACTORS = [
  { key: 'funding_stage',        name: 'Funding Stage',        max: 15 },
  { key: 'revenue_trend',        name: 'Revenue Growth',       max: 20 },
  { key: 'layoff_risk',          name: 'Layoff Risk',          max: 20 },
  { key: 'hiring_velocity',      name: 'Hiring Velocity',      max: 15 },
  { key: 'leadership_stability', name: 'Leadership Stability', max: 15 },
  { key: 'pmf_signals',          name: 'Product Market Fit',   max: 15 },
];

// ── Text-based inference detectors ───────────────────────────────────────────

function detectFundingStage(text) {
  const t = text.toLowerCase();
  if (/\bipo\b|\bpublicly traded\b|\bnasdaq\b|\bnyse\b|\bpublic company\b/.test(t)) return 'public';
  if (/series [de]\b/i.test(t)) return 'series_d_plus';
  if (/series c\b/i.test(t)) return 'series_c';
  if (/series b\b/i.test(t)) return 'series_b';
  if (/series a\b/i.test(t)) return 'series_a';
  if (/\bseed\b|\bseed round\b|\bseed funded\b/.test(t)) return 'seed';
  if (/\bbootstrapped\b|\bself.?funded\b/.test(t)) return 'bootstrapped';
  return null;
}

function detectRevenueTrend(text) {
  const t = text.toLowerCase();
  if (/rapid growth|hyper growth|strong growth|significant growth|revenue grew|record revenue|yoy growth/.test(t)) return 'positive';
  if (/declining revenue|revenue decrease|shrinking/.test(t)) return 'negative';
  if (/stable growth|steady growth|consistent growth/.test(t)) return 'flat';
  return null;
}

function detectLayoffRisk(text) {
  const t = text.toLowerCase();
  if (/\blayoff|\bdownsiz|\brestructur|\breduction in force|\brif\b/.test(t)) return 'high';
  if (/\bhiring freeze\b/.test(t)) return 'medium';
  if (/hiring aggressively|rapid expansion|growing team|expanding our team/.test(t)) return 'low';
  return null;
}

function detectHiringVelocity(text) {
  const t = text.toLowerCase();
  if (/hiring aggressively|rapid growth|scaling fast|growing quickly|expanding team|fast.growing/.test(t)) return 'high';
  if (/selective hiring|hiring for key|thoughtful hiring/.test(t)) return 'moderate';
  if (/\bhiring freeze\b/.test(t)) return 'low';
  return null;
}

function detectLeadershipStability(text) {
  const t = text.toLowerCase();
  if (/new (ceo|cto|cro|cso|vp|president)|recently appointed|under new leadership/.test(t)) return 'recent_changes';
  return null;
}

function detectPmfSignals(text) {
  const t = text.toLowerCase();
  if (/market leader|industry leader|recognized leader|gartner|magic quadrant|forrester wave|analyst recognized/.test(t)) return 'strong';
  if (/growing market|increasing demand|strong demand|market momentum/.test(t)) return 'moderate';
  if (/new market|early adopter|emerging market|nascent/.test(t)) return 'weak';
  return null;
}

// ── Score tables ──────────────────────────────────────────────────────────────

const SCORE_TABLES = {
  funding_stage: {
    public:        { score: 15, explanation: 'Public company — revenue visibility and institutional stability.' },
    series_d_plus: { score: 13, explanation: 'Late-stage venture — significant scale and traction achieved.' },
    series_c:      { score: 12, explanation: 'Growth-stage company with validated traction.' },
    series_b:      { score: 10, explanation: 'Scaling stage — product-market fit validated, execution underway.' },
    series_a:      { score: 7,  explanation: 'Early growth stage — execution risk remains.' },
    seed:          { score: 4,  explanation: 'Early stage — significant execution and runway risk.' },
    bootstrapped:  { score: 6,  explanation: 'Bootstrapped — profitable but scale may be limited.' },
  },
  revenue_trend: {
    positive: { score: 20, explanation: 'Revenue trend appears favorable — strong momentum signal.' },
    flat:     { score: 10, explanation: 'Stable revenue — no clear growth catalyst identified.' },
    negative: { score: 0,  explanation: 'Declining revenue trend — elevated financial risk.' },
  },
  layoff_risk: {
    low:    { score: 20, explanation: 'No layoff signals detected — company appears operationally stable.' },
    medium: { score: 10, explanation: 'Some instability signals present — monitor closely.' },
    high:   { score: 0,  explanation: 'Active layoff or restructuring signals detected.' },
  },
  hiring_velocity: {
    high:     { score: 15, explanation: 'Company appears to be in active growth-hiring mode.' },
    moderate: { score: 10, explanation: 'Selective, steady hiring pace.' },
    low:      { score: 5,  explanation: 'Slow or cautious hiring pace detected.' },
  },
  leadership_stability: {
    stable:         { score: 15, explanation: 'No leadership transition signals detected.' },
    recent_changes: { score: 8,  explanation: 'Recent leadership changes — potential for strategic shifts.' },
  },
  pmf_signals: {
    strong:   { score: 15, explanation: 'Strong PMF signals (analyst recognition, market leadership).' },
    moderate: { score: 10, explanation: 'Moderate PMF — growing category, not yet dominant.' },
    weak:     { score: 3,  explanation: 'Early PMF stage — high market uncertainty.' },
  },
};

const DETECTORS = {
  funding_stage:        detectFundingStage,
  revenue_trend:        detectRevenueTrend,
  layoff_risk:          detectLayoffRisk,
  hiring_velocity:      detectHiringVelocity,
  leadership_stability: detectLeadershipStability,
  pmf_signals:          detectPmfSignals,
};

// ── Rating bands ──────────────────────────────────────────────────────────────

function ratingFromScore(score) {
  if (score >= 85) return 'Excellent';
  if (score >= 70) return 'Strong';
  if (score >= 55) return 'Fair';
  return 'Risky';
}

function displayValue(raw) {
  return raw.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Compute Opportunity Intelligence Score for a job.
 *
 * @param {object} job — tracker.json job entry (with optional oi_signals field)
 * @returns {{
 *   score: number,
 *   rating: string,
 *   factors: Array<{ name, score, max, value, source, explanation }>,
 *   unknowns: string[]
 * }}
 */
export function computeOiScore(job) {
  const signals = job.oi_signals ?? {};
  const corpus = [
    job.full_description    ?? '',
    job.description_preview ?? '',
    job.score_analysis      ?? '',
    job.report?.role_summary ?? '',
  ].join(' ');

  let total = 0;
  const factors = [];
  const unknowns = [];

  for (const { key, name, max } of FACTORS) {
    // Manual signal takes priority over text inference
    let value  = signals[key] ?? null;
    let source = 'manual';

    if (!value) {
      value  = DETECTORS[key](corpus) ?? null;
      source = 'inferred';
    }

    const entry = value ? (SCORE_TABLES[key][value] ?? null) : null;

    if (entry) {
      factors.push({
        name,
        score: entry.score,
        max,
        value: displayValue(value),
        source,
        explanation: entry.explanation,
      });
      total += entry.score;
    } else {
      unknowns.push(name);
      factors.push({
        name,
        score: 0,
        max,
        value: 'Unknown',
        source: 'unknown',
        explanation: 'No reliable signal available. Add oi_signals to tracker.json to score this factor.',
      });
    }
  }

  return {
    score: total,
    rating: ratingFromScore(total),
    factors,
    unknowns,
  };
}
