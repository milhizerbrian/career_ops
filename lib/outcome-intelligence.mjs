// Phase 10: Outcome Intelligence. Pure, deterministic read model over the
// existing tracker/Opportunity data — no new storage, no AI.
//
// Principles:
//   - Funnel position is the FURTHEST stage an opportunity is known to have
//     reached (current stage + recorded stage history + recorded events +
//     interview rounds), so a rejection after an interview still counts as
//     an interview.
//   - Timing uses only really-recorded timestamps (workflowTimeline events
//     as stored, date_found, appliedDate). The synthetic events that
//     buildWorkflowTimeline() derives from `date_updated` are never used.
//   - Every rate carries numerator/denominator and a `sufficient` flag
//     (denominator >= MIN_SAMPLE). Insights are only stated as "measured"
//     when both sides are sufficient, are phrased as associations, and cite
//     their counts. Everything else is reported as insufficient data.
import { normalizeStage, deriveStageFromStatus } from './opportunity-stages.mjs';
import { normalizeWorkflowTimeline } from './job-workflow.mjs';
import { normalizeInterviewRounds } from './interview-rounds.mjs';
import { titleFamily } from './job-search-scoring.mjs';
import { normalizeContacts } from './job-contacts.mjs';

export const MIN_SAMPLE = 5;
const MIN_INSIGHT_DELTA = 0.15;
const MS_PER_DAY = 86400000;

// Known selection effects: segments whose members entered the tracker
// BECAUSE of an employer response, so their conversion rates are biased.
const SELECTION_CAVEATS = {
  'source:gmail': 'Gmail-created opportunities are only tracked after an employer email arrives, so this rate is biased upward and should not be compared directly.',
  'fitRange:unscored': 'Unscored opportunities are mostly Gmail-created (added after an employer email), so this rate is biased upward.',
};

// 0 discovered · 1 interested · 2 applied · 3 interview · 4 offer
const STAGE_RANK = {
  discovered: 0,
  qualified: 1,
  review: 1,
  pursuing: 1,
  materials_ready: 1,
  applied: 2,
  recruiter_screen: 3,
  interview: 3,
  final_round: 3,
  offer: 4,
};
const TERMINAL = new Set(['rejected', 'withdrawn', 'archived']);
const EVENT_RANK = { applied: 2, interview_scheduled: 3, interview_completed: 3, offer_received: 4 };

const ROLE_LABELS = {
  customer_success: 'Customer success / TAM',
  pre_sales: 'Pre-sales / solutions',
  leadership: 'Leadership',
  security: 'Security (other)',
  other: 'Other',
};

function currentStage(job) {
  return normalizeStage(job.stage) ?? deriveStageFromStatus(job.status);
}

function recordedEvents(job) {
  return normalizeWorkflowTimeline(job.workflowTimeline);
}

function rankOf(stage) {
  return STAGE_RANK[stage] ?? null;
}

export function furthestStageRank(job = {}) {
  let rank = rankOf(currentStage(job)) ?? 0;
  for (const e of recordedEvents(job)) {
    if (EVENT_RANK[e.type] != null) rank = Math.max(rank, EVENT_RANK[e.type]);
    if (e.type === 'stage_changed') {
      for (const s of [e.from, e.to]) if (rankOf(s) != null) rank = Math.max(rank, rankOf(s));
    }
  }
  if (job.appliedDate) rank = Math.max(rank, 2);
  if (normalizeInterviewRounds(job.interviews).length) rank = Math.max(rank, 3);
  return rank;
}

/**
 * Assumption (surfaced in the report): an employer rejection that arrived by
 * Gmail implies an application existed, even when no "applied" event was
 * recorded. Rejections with no application signal (e.g. a "Not interested"
 * quick decision) are counted as closed before applying.
 */
function classify(job) {
  const stage = currentStage(job);
  let rank = furthestStageRank(job);
  if (stage === 'rejected' && rank < 2 && job.last_email_date) rank = 2;
  const terminal = TERMINAL.has(stage) ? stage : stage === 'offer' ? 'offer' : null;
  return { stage, rank, terminal };
}

function rate(numerator, denominator) {
  return {
    numerator,
    denominator,
    rate: denominator > 0 ? numerator / denominator : null,
    sufficient: denominator >= MIN_SAMPLE,
  };
}

function pct(r) {
  return r.rate == null ? '—' : `${Math.round(r.rate * 100)}%`;
}

function firstAt(events, predicate) {
  const hit = events.filter(predicate).map(e => e.at).sort()[0];
  return hit || null;
}

function toIso(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function timestamps(job) {
  const events = recordedEvents(job);
  const toRank = (e, n) => e.type === 'stage_changed' && rankOf(e.to) === n;
  return {
    discovered: toIso(job.date_found),
    posted: toIso(job.postedDate),
    applied: toIso(job.appliedDate) || firstAt(events, e => e.type === 'applied' || toRank(e, 2)),
    firstInterview: firstAt(events, e => e.type === 'interview_scheduled' || toRank(e, 3)),
    offer: firstAt(events, e => e.type === 'offer_received' || toRank(e, 4)),
    rejected: firstAt(events, e => e.type === 'rejected' || (e.type === 'stage_changed' && e.to === 'rejected')),
  };
}

function daysBetween(from, to) {
  if (!from || !to) return null;
  const days = (new Date(to) - new Date(from)) / MS_PER_DAY;
  return days >= 0 ? days : null;
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const value = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return Math.round(value * 10) / 10;
}

// ── Segment keys ────────────────────────────────────────────────────────

function fitRange(job) {
  const raw = Number(job.score ?? job.report?.score);
  if (!Number.isFinite(raw) || raw <= 0) return ['unscored', 'Not scored'];
  const pctScore = Math.min(100, raw * 20); // evaluator scores are 0-5
  if (pctScore >= 80) return ['80-100', '80-100%'];
  if (pctScore >= 60) return ['60-79', '60-79%'];
  if (pctScore >= 40) return ['40-59', '40-59%'];
  return ['0-39', 'Under 40%'];
}

function workArrangement(job) {
  const text = `${job.remoteStatus || ''} ${job.location || ''}`.toLowerCase();
  if (/remote/.test(text)) return ['remote', 'Remote'];
  if (/hybrid/.test(text)) return ['hybrid', 'Hybrid'];
  if (text.trim()) return ['onsite', 'On-site / location listed'];
  return ['unknown', 'Unknown'];
}

function resumeKey(job) {
  if (typeof job.resumeVersion === 'string' && job.resumeVersion.trim()) {
    const v = job.resumeVersion.trim();
    return [`version:${v.toLowerCase()}`, `Resume used: ${v}`];
  }
  const docs = job.generatedDocs && typeof job.generatedDocs === 'object' ? Object.keys(job.generatedDocs) : [];
  return docs.length ? ['generated', 'Tailored resume generated'] : ['none', 'No tailored resume generated'];
}

function networkingKey(job) {
  const contacts = normalizeContacts(job.contacts);
  if ((typeof job.referral === 'string' && job.referral.trim()) || contacts.some(c => c.relationshipType === 'referral')) {
    return ['referral', 'Referral'];
  }
  const reachedOut = contacts.some(c => ['outreach_sent', 'responded', 'follow_up_due', 'no_response'].includes(c.responseStatus))
    || recordedEvents(job).some(e => e.type === 'outreach_sent');
  if (reachedOut) return ['outreach', 'Contacted someone'];
  if (contacts.length) return ['contact_only', 'Contact saved, no outreach'];
  return ['none', 'No contacts'];
}

const DIMENSIONS = {
  source: { label: 'Source', key: job => [job.source || 'unknown', job.source || 'Unknown'] },
  fitRange: { label: 'Fit score at discovery', key: fitRange },
  roleCategory: { label: 'Role category', key: job => { const k = titleFamily(job.title); return [k, ROLE_LABELS[k] || k]; } },
  company: { label: 'Company', key: job => { const c = String(job.company || '').trim(); return c ? [c.toLowerCase(), c] : null; }, onlyApplied: true, limit: 15 },
  workArrangement: { label: 'Work arrangement', key: workArrangement },
  resume: { label: 'Resume', key: resumeKey },
  networking: { label: 'Networking', key: networkingKey },
};

function buildSegments(classified) {
  const out = {};
  for (const [dim, def] of Object.entries(DIMENSIONS)) {
    const groups = new Map();
    for (const item of classified) {
      const key = def.key(item.job);
      if (!key) continue;
      const [k, label] = key;
      if (!groups.has(k)) groups.set(k, { key: k, label, total: 0, applied: 0, interviews: 0, offers: 0, rejected: 0, withdrawn: 0 });
      const g = groups.get(k);
      g.total += 1;
      if (item.rank >= 2) {
        g.applied += 1;
        if (item.terminal === 'rejected') g.rejected += 1;
        if (item.terminal === 'withdrawn') g.withdrawn += 1;
      }
      if (item.rank >= 3) g.interviews += 1;
      if (item.rank >= 4) g.offers += 1;
    }
    let rows = [...groups.values()]
      .map(g => ({
        ...g,
        caveat: SELECTION_CAVEATS[`${dim}:${g.key}`] || '',
        applyRate: rate(g.applied, g.total),
        interviewRate: rate(g.interviews, g.applied),
        offerRate: rate(g.offers, g.interviews),
      }))
      .filter(g => !def.onlyApplied || g.applied > 0)
      .sort((a, b) => b.applied - a.applied || b.total - a.total || a.label.localeCompare(b.label));
    if (def.limit) rows = rows.slice(0, def.limit);
    out[dim] = { label: def.label, rows };
  }
  return out;
}

function buildInsights(conversions, segments, timing) {
  const insights = [];
  const byId = Object.fromEntries(conversions.map(c => [c.id, c]));
  const overall = byId.applied_to_interview;

  for (const c of conversions) {
    if (!c.sufficient) {
      insights.push({ kind: 'insufficient', text: `${c.label}: not enough data yet (${c.numerator}/${c.denominator}; needs ${MIN_SAMPLE}+ in the base).` });
    }
  }

  if (overall.sufficient) {
    for (const [dim, seg] of Object.entries(segments)) {
      if (dim === 'company') continue;
      for (const row of seg.rows) {
        const r = row.interviewRate;
        if (!r.sufficient || r.denominator === overall.denominator) continue;
        const delta = r.rate - overall.rate;
        if (Math.abs(delta) < MIN_INSIGHT_DELTA) continue;
        insights.push({
          kind: 'measured',
          dimension: dim,
          text: `${seg.label} "${row.label}": ${pct(r)} of applications reached an interview (${r.numerator}/${r.denominator}), ${delta > 0 ? 'above' : 'below'} the ${pct(overall)} overall rate (${overall.numerator}/${overall.denominator}). This is an association, not proof of cause.${row.caveat ? ` Caveat: ${row.caveat}` : ''}`,
          caveat: row.caveat,
          delta,
        });
      }
    }
  }

  for (const t of timing) {
    if (t.sufficient) {
      insights.push({ kind: 'measured', dimension: 'timing', text: `${t.label}: median ${t.medianDays} days (n=${t.n} opportunities with recorded dates).` });
    }
  }

  const measured = insights.filter(i => i.kind === 'measured').sort((a, b) => Math.abs(b.delta ?? 0) - Math.abs(a.delta ?? 0));
  return [...measured, ...insights.filter(i => i.kind === 'insufficient')];
}

/**
 * @param {object[]} jobs raw tracker jobs (with `id`), e.g. getCachedDashboard().jobs
 */
export function buildOutcomeIntelligence(jobs = [], { now = new Date() } = {}) {
  const classified = (Array.isArray(jobs) ? jobs : [])
    .filter(job => job && typeof job === 'object')
    .map(job => ({ job, ...classify(job) }));

  const count = pred => classified.filter(pred).length;
  const funnel = {
    discovered: classified.length,
    interested: count(c => c.rank >= 1),
    applied: count(c => c.rank >= 2),
    interview: count(c => c.rank >= 3),
    offer: count(c => c.rank >= 4),
    rejectedAfterApplying: count(c => c.terminal === 'rejected' && c.rank >= 2),
    rejectedAfterInterview: count(c => c.terminal === 'rejected' && c.rank >= 3),
    withdrawn: count(c => c.terminal === 'withdrawn'),
    archived: count(c => c.terminal === 'archived'),
    closedBeforeApplying: count(c => c.terminal && c.terminal !== 'offer' && c.rank < 2),
    awaitingResponse: count(c => !c.terminal && c.rank === 2),
    inInterviews: count(c => !c.terminal && c.rank === 3),
  };

  const conversions = [
    { id: 'discovered_to_interested', label: 'Discovered → pursued', ...rate(funnel.interested, funnel.discovered) },
    { id: 'interested_to_applied', label: 'Pursued → applied', ...rate(funnel.applied, funnel.interested) },
    { id: 'applied_to_interview', label: 'Application → interview', ...rate(funnel.interview, funnel.applied) },
    { id: 'interview_to_offer', label: 'Interview → offer', ...rate(funnel.offer, funnel.interview) },
    { id: 'applied_to_offer', label: 'Application → offer', ...rate(funnel.offer, funnel.applied) },
  ];

  const stamps = classified.map(c => ({ ...c, t: timestamps(c.job) }));
  const timingDef = [
    ['posted_to_applied', 'Posting → application', s => daysBetween(s.t.posted, s.t.applied)],
    ['discovered_to_applied', 'Discovered → application', s => daysBetween(s.t.discovered, s.t.applied)],
    ['applied_to_first_interview', 'Application → first interview', s => daysBetween(s.t.applied, s.t.firstInterview)],
    ['applied_to_rejection', 'Application → rejection', s => daysBetween(s.t.applied, s.t.rejected)],
    ['interview_to_offer', 'First interview → offer', s => daysBetween(s.t.firstInterview, s.t.offer)],
  ];
  const timing = timingDef.map(([id, label, fn]) => {
    const values = stamps.map(fn).filter(v => v != null);
    return { id, label, n: values.length, medianDays: median(values), sufficient: values.length >= MIN_SAMPLE };
  });

  const segments = buildSegments(classified);
  const insights = buildInsights(conversions, segments, timing);

  const dataGaps = [];
  if (!classified.some(c => c.job.postedDate)) dataGaps.push('No posted dates are stored, so posting → application timing cannot be measured.');
  if (!classified.some(c => typeof c.job.resumeVersion === 'string' && c.job.resumeVersion.trim())) {
    dataGaps.push('"Resume used" is never recorded on the Application tab, so resume results compare "tailored resume generated" vs not, which does not confirm which resume was submitted.');
  }
  if (!classified.some(c => c.job.appliedDate)) dataGaps.push('No applied dates are recorded on the Application tab; application timing uses recorded "applied" activity events only.');
  dataGaps.push('Company attributes such as size, funding, or industry are not stored; company results are grouped by company name and work arrangement only.');

  return {
    generatedAt: now.toISOString(),
    minSample: MIN_SAMPLE,
    funnel,
    conversions,
    segments,
    timing,
    insights,
    assumptions: [
      'Funnel counts use the furthest stage each opportunity is known to have reached (stage history, activity events, and interview rounds), not only its current stage.',
      'A rejection received by Gmail counts as an application even if no "applied" event was recorded. A rejection with no application signal (for example "Not interested") counts as closed before applying.',
      'Fit ranges use the evaluator score recorded at discovery (0-5 scale shown as a percentage).',
      `Rates with a base under ${MIN_SAMPLE} are shown as counts only and are not used for insights.`,
    ],
    dataGaps,
  };
}
