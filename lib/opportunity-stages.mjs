// Phase 1: expanded lifecycle stages for the Opportunity model. This is a
// richer, additive superset alongside the existing 11-value pipeline status
// in status-utils.mjs — that field is untouched and keeps working for every
// existing consumer (dashboard filters, staleness checks, next-best-action).
import { normalizeStatus } from './status-utils.mjs';

export const PIPELINE_STAGES = [
  'discovered',
  'qualified',
  'review',
  'pursuing',
  'materials_ready',
  'applied',
  'recruiter_screen',
  'interview',
  'final_round',
  'offer',
  'rejected',
  'withdrawn',
  'archived',
];

const STAGE_SET = new Set(PIPELINE_STAGES);

export const STAGE_LABELS = {
  discovered: 'Discovered',
  qualified: 'Qualified',
  review: 'Review',
  pursuing: 'Pursuing',
  materials_ready: 'Materials Ready',
  applied: 'Applied',
  recruiter_screen: 'Recruiter Screen',
  interview: 'Interview',
  final_round: 'Final Round',
  offer: 'Offer',
  rejected: 'Rejected',
  withdrawn: 'Withdrawn',
  archived: 'Archived',
};

export const TERMINAL_STAGES = new Set(['offer', 'rejected', 'withdrawn', 'archived']);

/**
 * Old (11-value) status -> new (13-value) stage.
 * The old model has no signal to distinguish Qualified / Review / Pursuing /
 * Materials Ready from each other, or Interview from a specific screen type
 * beyond Recruiter Screen — so migration never invents that precision. Every
 * pre-application legacy status short of "applied" maps to a stage that is
 * safely inferable from what the old status actually recorded:
 *   lead        -> discovered   (just found, nothing done yet)
 *   interested  -> pursuing     (a person actively decided to move on it)
 * "qualified", "review", and "materials_ready" are reachable only through
 * changeStage() going forward (e.g. once Phase 2 scoring or resume
 * generation sets them) — migration of old data never assigns them.
 */
export const LEGACY_STATUS_TO_STAGE = {
  lead: 'discovered',
  interested: 'pursuing',
  applied: 'applied',
  recruiter_screen: 'recruiter_screen',
  hiring_manager_screen: 'interview',
  technical_screen: 'interview',
  onsite: 'final_round',
  offer: 'offer',
  rejected: 'rejected',
  withdrawn: 'withdrawn',
  archived: 'archived',
};

/**
 * New stage -> old (11-value) status, so changeStage() can keep the legacy
 * `status` field in sync and every existing status-driven consumer
 * (dashboard filters, job-workflow staleness/next-action, evaluator) keeps
 * working unchanged for opportunities that only ever move through the new
 * stage API. Stages with no exact legacy equivalent collapse to the closest
 * safe bucket (documented per-line below) rather than inventing a new status
 * value the rest of the app doesn't know about.
 */
export const STAGE_TO_LEGACY_STATUS = {
  discovered: 'lead',
  qualified: 'interested',       // no legacy equivalent; closest is "past lead, not yet applied"
  review: 'interested',          // same
  pursuing: 'interested',
  materials_ready: 'interested', // resume exists but not yet applied
  applied: 'applied',
  recruiter_screen: 'recruiter_screen',
  interview: 'technical_screen', // legacy split HM/technical screen into two statuses; new model has one generic "interview" stage — arbitrary but documented default
  final_round: 'onsite',
  offer: 'offer',
  rejected: 'rejected',
  withdrawn: 'withdrawn',
  archived: 'archived',
};

export function isValidStage(stage) {
  return STAGE_SET.has(stage);
}

export function normalizeStage(stage) {
  if (stage == null || stage === '') return null;
  if (typeof stage !== 'string') throw new Error('stage must be a string');
  return STAGE_SET.has(stage) ? stage : null;
}

/** Derives a stage from a legacy status when a job has no `stage` of its own yet. */
export function deriveStageFromStatus(status) {
  const normalized = normalizeStatus(status);
  return LEGACY_STATUS_TO_STAGE[normalized] ?? 'discovered';
}

export function stageToLegacyStatus(stage) {
  const normalized = normalizeStage(stage);
  if (!normalized) throw new Error(`Unsupported stage: ${stage}`);
  return STAGE_TO_LEGACY_STATUS[normalized];
}

export function stageLabel(stage) {
  const normalized = normalizeStage(stage);
  return normalized ? STAGE_LABELS[normalized] : String(stage ?? '');
}

export function isTerminalStage(stage) {
  const normalized = normalizeStage(stage);
  return normalized ? TERMINAL_STAGES.has(normalized) : false;
}
