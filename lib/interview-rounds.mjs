// Phase 9.1: interview rounds on an Opportunity. Stored as `job.interviews[]`
// on the existing tracker record (same pattern as job-contacts.mjs). A round
// never changes the Opportunity stage — stage stays owned by
// opportunity-store.mjs (changeStage/applyStageChange) and Gmail sync. Round
// type (recruiter, hiring manager, panel, ...) is per-round detail, not a
// lifecycle stage.
import { appendWorkflowEvent } from './job-workflow.mjs';
import { normalizeContacts } from './job-contacts.mjs';

export const INTERVIEW_ROUND_TYPES = ['recruiter', 'hiring_manager', 'technical', 'panel', 'executive', 'final', 'other'];
export const INTERVIEW_ROUND_STATUSES = ['scheduled', 'completed', 'cancelled'];
export const INTERVIEW_ROUND_FORMATS = ['phone', 'video', 'onsite', 'other'];

const ROUND_TYPE_LABELS = {
  recruiter: 'Recruiter',
  hiring_manager: 'Hiring Manager',
  technical: 'Technical',
  panel: 'Panel',
  executive: 'Executive',
  final: 'Final',
  other: 'Other',
};

const TYPE_SET = new Set(INTERVIEW_ROUND_TYPES);
const STATUS_SET = new Set(INTERVIEW_ROUND_STATUSES);
const FORMAT_SET = new Set(INTERVIEW_ROUND_FORMATS);
const LIMITS = { location: 300, notes: 5000, outcome: 1000 };

function cleanString(value, max) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function toIso(value) {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

function has(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

export function roundTypeLabel(type) {
  return ROUND_TYPE_LABELS[type] || ROUND_TYPE_LABELS.other;
}

/** Read-side normalization: tolerant of bad stored data, sorted by scheduled time (unscheduled last). */
export function normalizeInterviewRounds(rounds) {
  if (!Array.isArray(rounds)) return [];
  return rounds
    .filter(r => r && typeof r === 'object' && !Array.isArray(r) && typeof r.id === 'string' && r.id)
    .map(r => ({
      id: r.id,
      roundType: TYPE_SET.has(r.roundType) ? r.roundType : 'other',
      status: STATUS_SET.has(r.status) ? r.status : 'scheduled',
      scheduledAt: toIso(r.scheduledAt),
      format: FORMAT_SET.has(r.format) ? r.format : '',
      location: cleanString(r.location, LIMITS.location),
      contactIds: Array.isArray(r.contactIds) ? r.contactIds.filter(id => typeof id === 'string') : [],
      notes: cleanString(r.notes, LIMITS.notes),
      outcome: cleanString(r.outcome, LIMITS.outcome),
      completedAt: cleanString(r.completedAt, 40),
      createdAt: cleanString(r.createdAt, 40),
      updatedAt: cleanString(r.updatedAt, 40),
    }))
    .sort((a, b) => (a.scheduledAt || '￿').localeCompare(b.scheduledAt || '￿'));
}

/**
 * Validates only the fields present in `payload` (so PATCH can be partial).
 * Rejects rather than silently dropping bad values.
 */
function validateRoundFields(payload, job) {
  const fields = {};
  if (has(payload, 'roundType')) {
    if (!TYPE_SET.has(payload.roundType)) throw new Error(`Invalid roundType: ${payload.roundType}`);
    fields.roundType = payload.roundType;
  }
  if (has(payload, 'status')) {
    if (!STATUS_SET.has(payload.status)) throw new Error(`Invalid status: ${payload.status}`);
    fields.status = payload.status;
  }
  if (has(payload, 'scheduledAt')) {
    const iso = toIso(payload.scheduledAt);
    if (payload.scheduledAt && !iso) throw new Error('scheduledAt must be a valid date/time');
    fields.scheduledAt = iso;
  }
  if (has(payload, 'format')) {
    if (payload.format && !FORMAT_SET.has(payload.format)) throw new Error(`Invalid format: ${payload.format}`);
    fields.format = payload.format || '';
  }
  for (const key of ['location', 'notes', 'outcome']) {
    if (!has(payload, key)) continue;
    if (payload[key] != null && typeof payload[key] !== 'string') throw new Error(`${key} must be a string`);
    const value = (payload[key] || '').trim();
    if (value.length > LIMITS[key]) throw new Error(`${key} must be ${LIMITS[key]} characters or fewer`);
    fields[key] = value;
  }
  if (has(payload, 'contactIds')) {
    if (!Array.isArray(payload.contactIds)) throw new Error('contactIds must be an array');
    const known = new Set(normalizeContacts(job.contacts).map(c => c.id));
    const unknown = payload.contactIds.filter(id => !known.has(id));
    if (unknown.length) throw new Error(`Unknown contact id(s): ${unknown.join(', ')}`);
    fields.contactIds = [...new Set(payload.contactIds)];
  }
  return fields;
}

/**
 * Creates (no `id`) or partially updates (with `id`) a round on `job`,
 * mutating job.interviews and job.workflowTimeline. Logs
 * interview_scheduled on create and interview_completed on the first
 * transition to completed. Never touches stage/status.
 */
export function upsertInterviewRound(job, payload = {}, now = new Date()) {
  if (!job || typeof job !== 'object') throw new Error('job is required');
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('round payload must be an object');
  const fields = validateRoundFields(payload, job);
  const rounds = normalizeInterviewRounds(job.interviews);
  const at = now.toISOString();

  let round;
  if (payload.id) {
    const idx = rounds.findIndex(r => r.id === payload.id);
    if (idx < 0) throw new Error(`Interview round not found: ${payload.id}`);
    const previous = rounds[idx];
    round = { ...previous, ...fields, updatedAt: at };
    if (previous.status !== 'completed' && round.status === 'completed') round.completedAt = at;
    rounds[idx] = round;
    if (previous.status !== 'completed' && round.status === 'completed') {
      appendWorkflowEvent(job, {
        type: 'interview_completed', at, source: 'interview-round',
        label: `${roundTypeLabel(round.roundType)} interview`, note: round.outcome,
      }, now);
    }
  } else {
    if (!fields.roundType) throw new Error('roundType is required');
    round = {
      id: `round-${now.getTime().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      status: 'scheduled', scheduledAt: '', format: '', location: '',
      contactIds: [], notes: '', outcome: '', completedAt: '',
      ...fields,
      createdAt: at,
      updatedAt: at,
    };
    if (round.status === 'completed') round.completedAt = at;
    rounds.push(round);
    appendWorkflowEvent(job, {
      type: 'interview_scheduled', at, source: 'interview-round',
      label: `${roundTypeLabel(round.roundType)} interview`, note: round.scheduledAt,
    }, now);
  }

  job.interviews = normalizeInterviewRounds(rounds);
  return round;
}
