import { isInterviewStatus, normalizeStatus } from './status-utils.mjs';

export const WORKFLOW_EVENT_TYPES = [
  'discovered',
  'evaluated',
  'resume_generated',
  'applied',
  'outreach_sent',
  'follow_up_done',
  'recruiter_reply',
  'interview_scheduled',
  'rejected',
  'note_added',
  // Phase 1 (Opportunity model) additions — additive only, nothing above changed.
  'stage_changed',
  'priority_changed',
  'offer_received',
  'withdrawn',
  // Phase 9.1 (interview rounds) addition — additive only.
  'interview_completed',
];

export const NEXT_BEST_ACTIONS = [
  'generate_resume',
  'apply',
  'send_outreach',
  'follow_up',
  'prep_interview',
  'archive',
];

const EVENT_TYPE_SET = new Set(WORKFLOW_EVENT_TYPES);
const MANUAL_EVENT_TYPE_SET = new Set([
  'outreach_sent',
  'follow_up_done',
  'recruiter_reply',
  'interview_scheduled',
  'note_added',
]);
const MS_PER_DAY = 24 * 60 * 60 * 1000;
export const WORKFLOW_NOTE_MAX_LENGTH = 1000;

function toIsoDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function daysSince(value, now = new Date()) {
  const iso = toIsoDate(value);
  if (!iso) return null;
  return Math.floor((now.getTime() - new Date(iso).getTime()) / MS_PER_DAY);
}

export function normalizeWorkflowTimeline(timeline) {
  if (!Array.isArray(timeline)) return [];
  return timeline
    .filter(event => event && typeof event === 'object' && EVENT_TYPE_SET.has(event.type))
    .map(event => ({
      type: event.type,
      at: toIsoDate(event.at) || new Date(0).toISOString(),
      source: typeof event.source === 'string' ? event.source : 'manual',
      label: typeof event.label === 'string' ? event.label : '',
      note: typeof event.note === 'string' ? event.note : '',
      // Optional Phase 1 fields: present only on stage_changed/priority_changed
      // events. Omitted (not even as empty strings) on every other event type
      // so existing snapshots/fixtures that don't expect these keys are
      // unaffected.
      ...(typeof event.from === 'string' && event.from ? { from: event.from } : {}),
      ...(typeof event.to === 'string' && event.to ? { to: event.to } : {}),
    }))
    .sort((a, b) => a.at.localeCompare(b.at));
}

export function appendWorkflowEvent(job, event, now = new Date()) {
  if (!job || typeof job !== 'object') throw new Error('job is required');
  if (!event || !EVENT_TYPE_SET.has(event.type)) throw new Error(`Unsupported workflow event type: ${event?.type}`);
  const next = normalizeWorkflowTimeline(job.workflowTimeline);
  next.push({
    type: event.type,
    at: toIsoDate(event.at) || now.toISOString(),
    source: event.source || 'manual',
    label: event.label || '',
    note: event.note || '',
    ...(event.from ? { from: String(event.from) } : {}),
    ...(event.to ? { to: String(event.to) } : {}),
  });
  job.workflowTimeline = next.sort((a, b) => a.at.localeCompare(b.at));
  return job.workflowTimeline;
}

export function validateManualWorkflowEventPayload(payload = {}) {
  const type = typeof payload.type === 'string' ? payload.type.trim() : '';
  if (!MANUAL_EVENT_TYPE_SET.has(type)) {
    throw new Error(`Unsupported workflow event type: ${type || '(missing)'}`);
  }

  const note = typeof payload.note === 'string' ? payload.note.trim() : '';
  if (note.length > WORKFLOW_NOTE_MAX_LENGTH) {
    throw new Error(`Workflow note must be ${WORKFLOW_NOTE_MAX_LENGTH} characters or fewer`);
  }

  return {
    type,
    note,
    label: typeof payload.label === 'string' ? payload.label.trim().slice(0, 160) : '',
  };
}

export function applyManualWorkflowEvent(job, payload, now = new Date()) {
  const event = validateManualWorkflowEventPayload(payload);
  appendWorkflowEvent(job, {
    ...event,
    at: now.toISOString(),
    source: 'manual',
    label: event.label || manualEventLabel(event.type),
  }, now);
  if (event.type === 'note_added' && event.note) {
    const today = now.toISOString().slice(0, 10);
    const existing = typeof job.notes === 'string' ? job.notes.trim() : '';
    const line = `${today}: ${event.note}`;
    job.notes = existing ? `${line}\n${existing}` : line;
  }
  return job;
}

function manualEventLabel(type) {
  const labels = {
    outreach_sent: 'Outreach sent',
    follow_up_done: 'Follow-up done',
    recruiter_reply: 'Recruiter reply',
    interview_scheduled: 'Interview scheduled',
    note_added: 'Note added',
  };
  return labels[type] || type;
}

function generatedResumeEvents(job) {
  const docs = job?.generatedDocs;
  if (!docs || typeof docs !== 'object' || Array.isArray(docs)) return [];
  const events = [];
  for (const entry of Object.values(docs)) {
    if (!entry || typeof entry !== 'object') continue;
    const history = Array.isArray(entry.history) && entry.history.length ? entry.history : [entry];
    for (const version of history) {
      const at = toIsoDate(version?.generatedAt);
      if (at) events.push({ type: 'resume_generated', at, source: 'generatedDocs', label: version.fileName || '' });
    }
  }
  return events;
}

export function buildWorkflowTimeline(job) {
  const timeline = normalizeWorkflowTimeline(job?.workflowTimeline);
  const dateUpdated = toIsoDate(job?.date_updated);
  if (dateUpdated) timeline.push({ type: 'discovered', at: dateUpdated, source: 'tracker', label: '' });
  if (job?.score != null && dateUpdated) timeline.push({ type: 'evaluated', at: dateUpdated, source: 'tracker', label: '' });
  if (normalizeStatus(job?.status) === 'applied' && dateUpdated) timeline.push({ type: 'applied', at: dateUpdated, source: 'status', label: '' });
  if (isInterviewStatus(job?.status) && dateUpdated) timeline.push({ type: 'interview_scheduled', at: dateUpdated, source: 'status', label: '' });
  if (normalizeStatus(job?.status) === 'rejected' && dateUpdated) timeline.push({ type: 'rejected', at: dateUpdated, source: 'status', label: '' });
  if (job?.last_email_date) timeline.push({ type: 'recruiter_reply', at: toIsoDate(job.last_email_date), source: 'gmail', label: job.last_email_subject || '' });
  timeline.push(...generatedResumeEvents(job));

  const seen = new Set();
  return timeline
    .filter(event => event.at)
    .sort((a, b) => a.at.localeCompare(b.at))
    .filter(event => {
      const key = `${event.type}|${event.at}|${event.source}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

// Display-only cutoff: activity before 2026-09-01 00:00 CDT is hidden in the
// UI. Stored history is untouched and still used by logic (staleness, next
// action, action engine, Outcome Intelligence).
export const ACTIVITY_DISPLAY_CUTOFF = '2026-09-01T05:00:00.000Z';

export function filterActivityForDisplay(events, cutoff = ACTIVITY_DISPLAY_CUTOFF) {
  return (Array.isArray(events) ? events : []).filter(event => {
    const at = toIsoDate(event?.at);
    return at != null && at >= cutoff;
  });
}

export function getLastWorkflowActivityAt(job) {
  const timeline = buildWorkflowTimeline(job);
  return timeline.length ? timeline[timeline.length - 1].at : null;
}

function hasEvent(job, type) {
  return buildWorkflowTimeline(job).some(event => event.type === type);
}

function hasGeneratedResume(job) {
  return buildWorkflowTimeline(job).some(event => event.type === 'resume_generated');
}

export function detectWorkflowStaleness(job, options = {}) {
  const now = options.now || new Date();
  const inactiveDays = options.inactiveDays ?? 14;
  const followUpDays = options.followUpDays ?? 7;
  const lastActivityAt = getLastWorkflowActivityAt(job) || job?.date_updated || null;
  const inactiveForDays = daysSince(lastActivityAt, now);
  const status = normalizeStatus(job?.status);
  const appliedAt = buildWorkflowTimeline(job).filter(event => event.type === 'applied').at(-1)?.at;
  const followUpAt = buildWorkflowTimeline(job)
    .filter(event => ['follow_up_done', 'outreach_sent', 'recruiter_reply'].includes(event.type))
    .at(-1)?.at;
  const appliedForDays = daysSince(appliedAt || (status === 'applied' ? job?.date_updated : null), now);
  const lastReplyDays = daysSince(job?.last_email_date, now);
  const lastFollowUpDays = daysSince(followUpAt, now);

  const staleLead = ['lead', 'interested'].includes(status)
    && inactiveForDays != null
    && inactiveForDays >= inactiveDays;
  const needsAppliedFollowUp = status === 'applied'
    && appliedForDays != null
    && appliedForDays >= followUpDays
    && (lastReplyDays == null || lastReplyDays >= followUpDays)
    && (lastFollowUpDays == null || lastFollowUpDays >= followUpDays);

  return {
    stale: staleLead || needsAppliedFollowUp,
    staleLead,
    needsAppliedFollowUp,
    inactiveForDays,
    appliedForDays,
    lastActivityAt,
  };
}

export function getNextBestAction(job, options = {}) {
  const status = normalizeStatus(job?.status);
  const stale = detectWorkflowStaleness(job, options);
  if (['rejected', 'withdrawn', 'archived'].includes(status)) return 'archive';
  if (isInterviewStatus(status) || status === 'offer') return 'prep_interview';
  if (stale.needsAppliedFollowUp) return 'follow_up';
  if (stale.staleLead) return 'follow_up';
  if (!hasGeneratedResume(job)) return 'generate_resume';
  if (status === 'applied') return hasEvent(job, 'outreach_sent') ? 'follow_up' : 'send_outreach';
  if (status === 'interested' || status === 'lead') return 'apply';
  return 'send_outreach';
}

// ── Display cutoff for generated tasks ──────────────────────────────────
// Follow-ups, stale flags, and next actions are triggered by a job's latest
// real activity (applied/interview/stage events, Gmail replies, updates).
// When that activity is older than ACTIVITY_DISPLAY_CUTOFF the task is not
// shown as current. Raw getNextBestAction()/detectWorkflowStaleness() are
// unchanged for any logic that needs full history.
export function isCurrentForActions(job, cutoff = ACTIVITY_DISPLAY_CUTOFF) {
  const last = getLastWorkflowActivityAt(job);
  return last != null && last >= cutoff;
}

export function getCurrentNextBestAction(job, options = {}) {
  return isCurrentForActions(job, options.cutoff) ? getNextBestAction(job, options) : null;
}

export function detectCurrentWorkflowStaleness(job, options = {}) {
  const staleness = detectWorkflowStaleness(job, options);
  return isCurrentForActions(job, options.cutoff)
    ? staleness
    : { ...staleness, stale: false, staleLead: false, needsAppliedFollowUp: false };
}

export function buildWorkflowSummary(jobs, options = {}) {
  const active = (Array.isArray(jobs) ? jobs : []).filter(job => !['rejected', 'archived', 'withdrawn'].includes(normalizeStatus(job?.status)))
    .filter(job => !options.currentOnly || isCurrentForActions(job, options.cutoff));
  const staleJobs = active.filter(job => detectWorkflowStaleness(job, options).stale);
  const urgentFollowUps = active.filter(job => getNextBestAction(job, options) === 'follow_up');
  const upcomingInterviews = active.filter(job => isInterviewStatus(job?.status));
  return {
    urgentFollowUps: urgentFollowUps.length,
    staleJobs: staleJobs.length,
    upcomingInterviews: upcomingInterviews.length,
    staleJobIds: staleJobs.map(job => job.id).filter(Boolean),
    urgentJobIds: urgentFollowUps.map(job => job.id).filter(Boolean),
  };
}
