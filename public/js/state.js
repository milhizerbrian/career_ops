export const INTERVIEW_STATUSES = new Set([
  'recruiter_screen',
  'hiring_manager_screen',
  'technical_screen',
  'onsite',
]);

export const STATUS_ORDER = [
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

export function createDashboardMeta(data = {}) {
  return {
    builtAt: data.builtAt || null,
    lastScanAt: data.lastScanAt || null,
  };
}
