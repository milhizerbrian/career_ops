// Phase 9.3: pure helpers for the Interview Command Center UI. Option lists
// mirror lib/interview-rounds.mjs (server is the source of truth and
// validates regardless; test/interview-ui.test.mjs keeps them in sync).

export const INTERVIEW_ROUND_TYPE_OPTIONS = [
  ['recruiter', 'Recruiter'],
  ['hiring_manager', 'Hiring Manager'],
  ['technical', 'Technical'],
  ['panel', 'Panel'],
  ['executive', 'Executive'],
  ['final', 'Final'],
  ['other', 'Other'],
];

export const INTERVIEW_ROUND_STATUS_OPTIONS = [
  ['scheduled', 'Scheduled'],
  ['completed', 'Completed'],
  ['cancelled', 'Cancelled'],
];

export const INTERVIEW_ROUND_FORMAT_OPTIONS = [
  ['', 'Not set'],
  ['phone', 'Phone'],
  ['video', 'Video'],
  ['onsite', 'Onsite'],
  ['other', 'Other'],
];

const TYPE_LABELS = Object.fromEntries(INTERVIEW_ROUND_TYPE_OPTIONS);

export function interviewRoundTypeLabel(type) {
  return TYPE_LABELS[type] || TYPE_LABELS.other;
}

/** Soonest upcoming scheduled round; else a scheduled round with no date yet; else null. */
export function nextScheduledRound(rounds, now = new Date()) {
  const scheduled = (Array.isArray(rounds) ? rounds : []).filter(r => r && r.status === 'scheduled');
  const nowIso = now.toISOString();
  const upcoming = scheduled
    .filter(r => r.scheduledAt && r.scheduledAt >= nowIso)
    .sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt));
  return upcoming[0] || scheduled.find(r => !r.scheduledAt) || null;
}

function pad(n) {
  return String(n).padStart(2, '0');
}

/** ISO timestamp -> `<input type="datetime-local">` value in the viewer's local time. */
export function toDatetimeLocalValue(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** `<input type="datetime-local">` value (local time) -> ISO timestamp. */
export function fromDatetimeLocalValue(value) {
  if (!value) return '';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString();
}

export function buildRoundPayload(values = {}) {
  const text = v => (typeof v === 'string' ? v.trim() : '');
  return {
    roundType: values.roundType,
    status: values.status,
    scheduledAt: values.scheduledAt || '',
    format: values.format || '',
    location: text(values.location),
    contactIds: [...new Set(Array.isArray(values.contactIds) ? values.contactIds : [])],
    notes: text(values.notes),
    outcome: text(values.outcome),
  };
}
