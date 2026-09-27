// Phase 1: Opportunity data access layer. Wraps the existing tracker-store
// (data/tracker.json) rather than introducing a second database — an
// Opportunity IS a tracker.json job record, decorated with a computed
// `stage` (see opportunity-stages.mjs) and a set of additive optional
// fields. All reads/writes go through this module so UI/routes stop
// touching the raw tracker object directly.
//
// The underlying tracker store is resolved fresh on every call (via
// createTrackerStore) rather than importing tracker-store.mjs's cached
// singleton. tracker-store.mjs computes its default path once at module
// load time from CAREER_OPS_TRACKER_PATH/CAREER_OPS_DATA_DIR; resolving
// lazily here means this module always honors the current environment
// (correct in production, where the env is fixed before startup anyway,
// and it makes this module cleanly unit-testable with an isolated tracker
// file per test).
import path from 'path';
import { createTrackerStore, DEFAULT_TRACKER_PATH } from './tracker-store.mjs';
import { normalizeStatus } from './status-utils.mjs';
import { appendWorkflowEvent, buildWorkflowTimeline } from './job-workflow.mjs';
import {
  PIPELINE_STAGES,
  normalizeStage,
  deriveStageFromStatus,
  stageToLegacyStatus,
} from './opportunity-stages.mjs';

export const PRIORITY_LEVELS = ['high', 'medium', 'low'];

// Fields updateOpportunity() is allowed to touch directly. `stage` is
// deliberately excluded — it must go through changeStage() so a stage
// change always produces an activity record and stays in sync with the
// legacy `status` field. `priority` is allowed here but diffed so a real
// change still logs a priority_changed activity event.
const DIRECTLY_UPDATABLE_FIELDS = new Set([
  'company', 'title', 'url', 'source', 'location', 'remoteStatus', 'salary', 'compensation',
  'postedDate', 'notes',
  'overallFit', 'experienceMatch', 'skillsMatch', 'seniorityMatch', 'domainMatch',
  'locationMatch', 'compensationMatch', 'leadershipMatch', 'technicalMatch', 'evidenceQuality',
  'freshness', 'confidence', 'hardBlockers',
  'priority', 'nextAction', 'nextActionDate',
  'appliedDate', 'resumeVersion', 'coverLetterVersion', 'referral', 'applicationSource',
  'outcomeStatus', 'closedDate', 'outcomeReason',
]);

function resolveTrackerPath() {
  if (process.env.CAREER_OPS_TRACKER_PATH) return path.resolve(process.env.CAREER_OPS_TRACKER_PATH);
  if (process.env.CAREER_OPS_DATA_DIR) return path.resolve(process.env.CAREER_OPS_DATA_DIR, 'tracker.json');
  return DEFAULT_TRACKER_PATH;
}

function store() {
  return createTrackerStore({ trackerPath: resolveTrackerPath() });
}

function opportunityNotFound(id) {
  const err = new Error(`Opportunity not found: ${id}`);
  err.code = 'OPPORTUNITY_NOT_FOUND';
  return err;
}

/**
 * Read-time decoration only — never persisted under these alias names.
 * Existing consumers reading the raw job object (job.date_found, job.score,
 * job.status, ...) keep working unchanged; this view adds the Opportunity
 * naming on top without duplicating storage.
 */
export function toOpportunityView(id, job) {
  if (!job) return null;
  const stage = normalizeStage(job.stage) ?? deriveStageFromStatus(job.status);
  return {
    id,
    ...job,
    stage,
    status: normalizeStatus(job.status),
    discoveredDate: job.date_found ?? null,
    lastActivity: job.date_updated ?? null,
    overallFit: job.overallFit ?? job.score ?? null,
  };
}

export function listOpportunities() {
  const tracker = store().loadTracker();
  return Object.entries(tracker)
    .map(([id, job]) => toOpportunityView(id, job))
    .sort((a, b) => (b.lastActivity || '').localeCompare(a.lastActivity || ''));
}

export function getOpportunity(id) {
  const tracker = store().loadTracker();
  if (!tracker[id]) throw opportunityNotFound(id);
  return toOpportunityView(id, tracker[id]);
}

/**
 * Creates a new opportunity. Only fields explicitly passed in are set —
 * nothing is invented. `stage` defaults to 'discovered' when not given, and
 * a real 'discovered' activity event is recorded (not just synthesized at
 * read time the way buildWorkflowTimeline() does for legacy jobs).
 */
export function createOpportunity(id, fields = {}) {
  if (!id || typeof id !== 'string') throw new Error('id is required');
  const stage = fields.stage ? normalizeStage(fields.stage) : 'discovered';
  if (fields.stage && !stage) throw new Error(`Unsupported stage: ${fields.stage}`);
  const now = new Date();
  const job = {
    status: fields.status ?? stageToLegacyStatus(stage),
    date_found: fields.discoveredDate ?? now.toISOString(),
    date_updated: now.toISOString(),
    notes: '',
    ...fields,
    stage,
  };
  delete job.discoveredDate; // stored as date_found; not duplicated

  const s = store();
  let created;
  s.updateTracker((tracker) => {
    if (tracker[id]) throw new Error(`Job already exists in tracker: ${id}`);
    appendWorkflowEvent(job, { type: 'discovered', source: 'opportunity-store' }, now);
    tracker[id] = job;
    created = { id, ...job };
  });
  return toOpportunityView(id, created);
}

/**
 * Partial update for fields that don't require activity-log bookkeeping
 * beyond a simple diff (priority). Rejects attempts to set `stage` directly
 * — use changeStage() so the activity record and legacy status stay
 * consistent.
 */
export function updateOpportunity(id, fields = {}) {
  if ('stage' in fields) {
    throw new Error('updateOpportunity() cannot set `stage` directly — use changeStage()');
  }
  const unknown = Object.keys(fields).filter(k => !DIRECTLY_UPDATABLE_FIELDS.has(k));
  if (unknown.length) {
    throw new Error(`updateOpportunity() does not support field(s): ${unknown.join(', ')}`);
  }
  if (fields.priority != null && !PRIORITY_LEVELS.includes(fields.priority)) {
    throw new Error(`Unsupported priority: ${fields.priority}`);
  }

  const updated = store().updateJob(id, (job) => {
    const previousPriority = job.priority ?? null;
    const next = { ...job, ...fields, date_updated: new Date().toISOString() };
    if ('priority' in fields && fields.priority !== previousPriority) {
      appendWorkflowEvent(next, {
        type: 'priority_changed',
        source: 'opportunity-store',
        from: previousPriority ?? '',
        to: fields.priority ?? '',
      });
    }
    return next;
  });
  return toOpportunityView(id, updated);
}

/**
 * Pure stage transition (no I/O): the single lifecycle rule shared by
 * changeStage() and callers already inside a tracker write (Gmail sync).
 * Keeps the legacy `status` in sync via STAGE_TO_LEGACY_STATUS; `status`
 * may override it only with a legacy value that maps back to the same
 * stage (e.g. hiring_manager_screen for "interview"), so the two never
 * disagree. Records a stage_changed event only when the stage changes.
 */
export function applyStageChange(job, newStage, { reason = '', actor = 'manual', label = '', status = null } = {}) {
  const normalized = normalizeStage(newStage);
  if (!normalized) throw new Error(`Unsupported stage: ${newStage}`);
  if (status != null && deriveStageFromStatus(status) !== normalized) {
    throw new Error(`Status "${status}" does not belong to stage "${normalized}"`);
  }
  const currentStage = normalizeStage(job.stage) ?? deriveStageFromStatus(job.status);
  const next = {
    ...job,
    stage: normalized,
    status: status != null ? normalizeStatus(status) : stageToLegacyStatus(normalized),
    date_updated: new Date().toISOString(),
  };
  if (currentStage !== normalized) {
    appendWorkflowEvent(next, {
      type: 'stage_changed',
      source: actor,
      label,
      from: currentStage,
      to: normalized,
      note: reason || '',
    });
    if (normalized === 'offer') {
      appendWorkflowEvent(next, { type: 'offer_received', source: actor });
    }
    if (normalized === 'withdrawn') {
      appendWorkflowEvent(next, { type: 'withdrawn', source: actor, note: reason || '' });
    }
  }
  return next;
}

/**
 * Moves an opportunity to a new stage. Keeps the legacy `status` field in
 * sync (via STAGE_TO_LEGACY_STATUS) so every existing status-driven
 * consumer keeps working, and always records a stage_changed activity
 * event — a no-op when the stage isn't actually changing.
 */
export function changeStage(id, newStage, { reason = '', actor = 'manual' } = {}) {
  const updated = store().updateJob(id, job => applyStageChange(job, newStage, { reason, actor }));
  return toOpportunityView(id, updated);
}

/** Appends a workflow/activity event to an opportunity. Thin, validated wrapper. */
export function recordActivity(id, event) {
  const updated = store().updateJob(id, (job) => {
    const next = { ...job };
    appendWorkflowEvent(next, event);
    return next;
  });
  return toOpportunityView(id, updated);
}

/** Full activity history — real recorded events merged with the existing derived/synthetic ones. */
export function getActivity(id) {
  const tracker = store().loadTracker();
  if (!tracker[id]) throw opportunityNotFound(id);
  return buildWorkflowTimeline(tracker[id]);
}

export { PIPELINE_STAGES };
