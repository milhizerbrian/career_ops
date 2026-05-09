import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { writeJsonAtomic } from './atomic-file.mjs';
import { isInterviewStatus, normalizeStatus } from './status-utils.mjs';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ANALYTICS_PATH = path.resolve(APP_ROOT, 'data', 'ab-analytics.json');

export const VARIANTS = {
  technical: {
    key: 'technical',
    label: 'Version A',
    name: 'Technical Leadership',
  },
  outcomes: {
    key: 'outcomes',
    label: 'Version B',
    name: 'Business Outcomes',
  },
};

export function normalizeVariant(variant) {
  const raw = String(variant ?? '').toLowerCase().trim();
  if (raw === 'a' || raw === 'technical-leadership' || raw === 'technical') return 'technical';
  if (raw === 'b' || raw === 'business-outcomes' || raw === 'outcomes') return 'outcomes';
  throw new Error(`Unknown A/B variant: ${variant}`);
}

export function loadSubmissions() {
  if (!fs.existsSync(ANALYTICS_PATH)) return [];
  const parsed = JSON.parse(fs.readFileSync(ANALYTICS_PATH, 'utf8'));
  return Array.isArray(parsed?.submissions) ? parsed.submissions : [];
}

function saveSubmissions(submissions) {
  writeJsonAtomic(ANALYTICS_PATH, { submissions });
}

export function recordSubmission({ jobId, variant, submittedAt = new Date().toISOString() }) {
  if (!jobId) throw new Error('jobId is required');
  const normalized = normalizeVariant(variant);
  const submissions = loadSubmissions();
  const existing = submissions.find(item => item.jobId === jobId && item.variant === normalized);
  if (existing) {
    existing.submittedAt = submittedAt;
  } else {
    submissions.push({ jobId, variant: normalized, submittedAt });
  }
  saveSubmissions(submissions);
  return { jobId, variant: normalized, submittedAt };
}

export function buildAbAnalytics(jobs, submissions = loadSubmissions()) {
  const jobsById = new Map(jobs.map(job => [job.id, job]));
  const byVariant = Object.fromEntries(
    Object.values(VARIANTS).map(variant => [
      variant.key,
      {
        ...variant,
        submitted: 0,
        interviews: 0,
        yieldRate: 0,
        jobs: [],
      },
    ])
  );

  for (const submission of submissions) {
    const variant = byVariant[submission.variant];
    if (!variant) continue;
    const job = jobsById.get(submission.jobId);
    variant.submitted++;
    const interviewed = isInterviewStatus(job?.status) || normalizeStatus(job?.status) === 'offer';
    if (interviewed) variant.interviews++;
    variant.jobs.push({
      jobId: submission.jobId,
      company: job?.company || '',
      title: job?.title || '',
      status: job?.status || '',
      submittedAt: submission.submittedAt,
      interviewed,
    });
  }

  for (const variant of Object.values(byVariant)) {
    variant.yieldRate = variant.submitted
      ? Math.round((variant.interviews / variant.submitted) * 100)
      : 0;
  }

  return {
    variants: byVariant,
    totals: {
      submitted: Object.values(byVariant).reduce((sum, item) => sum + item.submitted, 0),
      interviews: Object.values(byVariant).reduce((sum, item) => sum + item.interviews, 0),
    },
  };
}
