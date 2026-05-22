export const EVAL_STAGE_LABELS = {
  fetch: 'Fetching',
  score: 'Scoring',
  save: 'Saving',
  evaluate: 'Evaluating',
};

export const STAGE_LABELS = {
  'lm-studio': 'Keywords',
  'keyword-analysis': 'Keywords',
  'planning': 'Resume Plan',
  'ai': 'Resume Draft',
  'draft-critique': 'Resume Critique',
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
  'lm-studio':          { started: 8,  done: 28 },
  'keyword-analysis':   { started: 8,  done: 28 },
  'planning':           { started: 28, done: 34 },
  'ai':                 { started: 35, done: 68 },
  'draft-critique':     { started: 69, done: 73 },
  'polish':             { started: 74, done: 80 },
  'validation':         { started: 81, done: 86 },
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
