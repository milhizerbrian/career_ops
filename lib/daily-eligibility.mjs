// Daily-action eligibility: the single rule Home (action-engine) and the
// Dashboard (job-workflow / cache / read models) share to decide whether a
// job may produce a task that needs Brian's attention.
//
//   - Active candidacies (applied, screens, interviews, offer) always stay
//     actionable, whatever their score.
//   - Everything else (discovered/lead/review/pursuing...) needs a known fit
//     of at least DAILY_FIT_THRESHOLD. Unscored jobs can't show they meet it,
//     so they are not surfaced as daily tasks either.
//
// Nothing is deleted or rescored: ineligible jobs stay stored for dedupe,
// history, and Outcome Intelligence.
import { normalizeStage, deriveStageFromStatus } from './opportunity-stages.mjs';

export const DAILY_FIT_THRESHOLD = 65;
const ACTIVE_CANDIDACY_STAGES = new Set(['applied', 'recruiter_screen', 'interview', 'final_round', 'offer']);

/**
 * 0-100 fit: a genuine Phase 2 fit (overallFit written together with
 * `confidence`), else the evaluator's 0-5 discovery score. The ATS resume
 * keyword score is deliberately not used — it measures resume wording, and
 * isn't available on the Home data path, so using it would let Home and
 * Dashboard disagree.
 */
export function dailyFitPercent(job = {}) {
  if (job.confidence != null && Number.isFinite(Number(job.overallFit))) return Math.round(Number(job.overallFit));
  for (const value of [job.score, job.report?.score]) {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) return Math.round(n * 20);
  }
  return null;
}

export function isActiveCandidacy(job = {}) {
  const stage = normalizeStage(job.stage) ?? deriveStageFromStatus(job.status);
  return ACTIVE_CANDIDACY_STAGES.has(stage);
}

export function isDailyActionEligible(job = {}) {
  if (isActiveCandidacy(job)) return true;
  const fit = dailyFitPercent(job);
  return fit != null && fit >= DAILY_FIT_THRESHOLD;
}
