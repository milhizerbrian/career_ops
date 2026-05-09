export const CANONICAL_STATUSES = [
  'lead',
  'interested',
  'applied',
  'recruiter_screen',
  'hiring_manager_screen',
  'technical_screen',
  'onsite',
  'offer',
  'rejected',
  'withdrawn',
  'archived',
];

export const STATUS_ORDER = CANONICAL_STATUSES;

const STATUS_LABELS = {
  lead: 'Lead',
  interested: 'Interested',
  applied: 'Applied',
  recruiter_screen: 'Recruiter Screen',
  hiring_manager_screen: 'Hiring Manager Screen',
  technical_screen: 'Technical Screen',
  onsite: 'Onsite',
  offer: 'Offer',
  rejected: 'Rejected',
  withdrawn: 'Withdrawn',
  archived: 'Archived',
};

const INTERVIEW_STATUSES = new Set([
  'recruiter_screen',
  'hiring_manager_screen',
  'technical_screen',
  'onsite',
]);

const LEGACY_STATUS_MAP = new Map([
  ['new', 'lead'],
  ['open', 'lead'],
  ['active', 'lead'],
  ['prospect', 'lead'],
  ['lead', 'lead'],
  ['interested', 'interested'],
  ['applied', 'applied'],
  ['submitted', 'applied'],
  ['application submitted', 'applied'],
  ['phone', 'recruiter_screen'],
  ['phone screen', 'recruiter_screen'],
  ['phone_screen', 'recruiter_screen'],
  ['recruiter', 'recruiter_screen'],
  ['recruiter screen', 'recruiter_screen'],
  ['recruiter_screen', 'recruiter_screen'],
  ['screen', 'recruiter_screen'],
  ['hm screen', 'hiring_manager_screen'],
  ['hiring manager screen', 'hiring_manager_screen'],
  ['hiring_manager_screen', 'hiring_manager_screen'],
  ['manager screen', 'hiring_manager_screen'],
  ['interview', 'technical_screen'],
  ['interviewing', 'technical_screen'],
  ['technical', 'technical_screen'],
  ['technical interview', 'technical_screen'],
  ['technical screen', 'technical_screen'],
  ['technical_screen', 'technical_screen'],
  ['onsite', 'onsite'],
  ['on site', 'onsite'],
  ['on-site', 'onsite'],
  ['final', 'onsite'],
  ['final interview', 'onsite'],
  ['offer', 'offer'],
  ['rejected', 'rejected'],
  ['reject', 'rejected'],
  ['declined', 'rejected'],
  ['withdrawn', 'withdrawn'],
  ['withdrew', 'withdrawn'],
  ['closed', 'archived'],
  ['archived', 'archived'],
]);

export function normalizeStatus(status) {
  if (status == null || status === '') return 'lead';
  if (typeof status !== 'string') throw new Error('status must be a string');
  const key = status
    .trim()
    .toLowerCase()
    .replace(/[_/-]+/g, ' ')
    .replace(/\s+/g, ' ');
  if (!key) return 'lead';
  return LEGACY_STATUS_MAP.get(key) ?? 'lead';
}

export function isInterviewStatus(status) {
  return INTERVIEW_STATUSES.has(normalizeStatus(status));
}

export function statusLabel(status) {
  const normalized = normalizeStatus(status);
  return STATUS_LABELS[normalized] ?? normalized;
}
