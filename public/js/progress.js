export const EVAL_STAGE_LABELS = {
  fetch: 'Fetching',
  score: 'Scoring',
  save: 'Saving',
  evaluate: 'Evaluating',
};

export const STAGE_LABELS = {
  'strategy-selection': 'Strategy',
  'lm-studio': 'Keywords',
  'ai': 'Resume Draft',
  'polish': 'Polishing',
  'validation': 'Quality Check',
  'docx': 'Building DOCX',
  'page-check': 'Page Check',
  'pdf': 'PDF Export',
  'warning': 'Warning',
  'skipped': 'Skipped',
  'error': 'Error',
};

export const STAGE_PROGRESS = {
  'strategy-selection': { started: 3,  done: 8 },
  'lm-studio':          { started: 8,  done: 28 },
  'ai':                 { started: 30, done: 68 },
  'polish':             { started: 70, done: 78 },
  'validation':         { started: 80, done: 86 },
  'docx':               { started: 88, done: 98 },
  'page-check':         { started: 96, done: 98 },
  'pdf':                { started: 96, done: 98 },
};

export function humanizeStage(stage) {
  return String(stage ?? '')
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, ch => ch.toUpperCase()) || 'Progress';
}

export function progressColor(pct) {
  if (pct < 30) return '#2563eb';
  if (pct < 68) return '#4f46e5';
  if (pct < 88) return '#7c3aed';
  return '#059669';
}
