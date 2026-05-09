/**
 * Recruiter Targeting
 *
 * Manages per-job recruiter/hiring-manager contact data, outreach message
 * generation, contact attempt logging, and aggregate analytics.
 *
 * Data lives in tracker.json under job.recruiterTargeting.
 * This module handles file I/O; callers (server.mjs) are responsible for
 * calling invalidateCache() after writes.
 */

import Anthropic from '@anthropic-ai/sdk';
import { loadJobById, loadBragDoc } from './data.mjs';
import { updateJob } from './tracker-store.mjs';

// ── Schema ────────────────────────────────────────────────────────────────────

export const VALID_STATUSES = new Set([
  'not_contacted',
  'message_drafted',
  'sent',
  'responded',
  'no_response',
  'follow_up_due',
  'referral_received',
]);

const STATUS_LABELS = {
  not_contacted:    'Not Contacted',
  message_drafted:  'Message Drafted',
  sent:             'Sent',
  responded:        'Responded',
  no_response:      'No Response',
  follow_up_due:    'Follow-Up Due',
  referral_received:'Referral Received',
};

export const DEFAULT_TARGETING = {
  recruiterName:           '',
  recruiterTitle:          '',
  recruiterLinkedInUrl:    '',
  hiringManagerName:       '',
  hiringManagerTitle:      '',
  hiringManagerLinkedInUrl:'',
  bestConnectionPath:      '',
  suggestedMessage:        '',
  followUpDate:            '',
  contactAttempts:         [],
  responseStatus:          'not_contacted',
};

// Fields allowed in updateRecruiterTargeting (prevents arbitrary key injection)
const MUTABLE_FIELDS = new Set(Object.keys(DEFAULT_TARGETING));

// ── Pure helpers ──────────────────────────────────────────────────────────────

/**
 * Return recruiterTargeting for a job with all defaults filled in.
 * Safe to call with a bare job object (no recruiterTargeting key).
 */
export function getRecruiterTargeting(job) {
  const stored = job.recruiterTargeting ?? {};
  return {
    ...DEFAULT_TARGETING,
    ...stored,
    // Ensure contactAttempts is always an array
    contactAttempts: Array.isArray(stored.contactAttempts) ? stored.contactAttempts : [],
    // Ensure responseStatus is always valid
    responseStatus: VALID_STATUSES.has(stored.responseStatus)
      ? stored.responseStatus
      : 'not_contacted',
  };
}

/** Human-readable label for a responseStatus value. */
export function statusLabel(status) {
  return STATUS_LABELS[status] ?? status;
}

// ── File I/O ──────────────────────────────────────────────────────────────────

/**
 * Merge partial updates into job.recruiterTargeting in tracker.json.
 * Only MUTABLE_FIELDS keys are accepted; unknown keys are silently dropped.
 * Returns the updated recruiterTargeting object.
 */
export function updateRecruiterTargeting(jobId, updates) {
  const filtered = Object.fromEntries(
    Object.entries(updates).filter(([k]) => MUTABLE_FIELDS.has(k))
  );

  if (filtered.responseStatus !== undefined && !VALID_STATUSES.has(filtered.responseStatus)) {
    throw new Error(`Invalid responseStatus: "${filtered.responseStatus}". Allowed: ${[...VALID_STATUSES].join(', ')}`);
  }

  // contactAttempts is managed by recordContactAttempt — ignore here
  delete filtered.contactAttempts;

  const updated = updateJob(jobId, job => ({
    ...job,
    recruiterTargeting: {
      ...(job.recruiterTargeting ?? {}),
      ...filtered,
    },
  }));
  return getRecruiterTargeting({ recruiterTargeting: updated.recruiterTargeting });
}

/**
 * Append a contact attempt to job.recruiterTargeting.contactAttempts.
 * Auto-advances responseStatus from not_contacted/message_drafted → sent.
 * Returns the updated recruiterTargeting object.
 */
export function recordContactAttempt(jobId, attempt) {
  const entry = {
    date:        attempt.date        || new Date().toISOString().slice(0, 10),
    channel:     attempt.channel     || 'LinkedIn',
    contactName: attempt.contactName || '',
    message:     attempt.message     || '',
    status:      attempt.status      || 'sent',
  };

  const updated = updateJob(jobId, job => {
    const rt = job.recruiterTargeting ?? {};
    const existing = Array.isArray(rt.contactAttempts) ? rt.contactAttempts : [];
    const prevStatus = rt.responseStatus || 'not_contacted';
    const nextStatus =
      prevStatus === 'not_contacted' || prevStatus === 'message_drafted'
        ? 'sent'
        : prevStatus;

    return {
      ...job,
      recruiterTargeting: {
        ...rt,
        contactAttempts: [...existing, entry],
        responseStatus: nextStatus,
      },
    };
  });
  return getRecruiterTargeting({ recruiterTargeting: updated.recruiterTargeting });
}

// ── Message generation ────────────────────────────────────────────────────────

const MESSAGE_SYSTEM = `You are writing a short LinkedIn cold outreach message for a senior cybersecurity customer success professional.

RULES:
- Maximum 4 sentences. Target 3 sentences total.
- First sentence: one specific, genuine observation about the company, role, or team (not generic praise).
- Second sentence: one concrete reason this candidate's background is directly relevant — include one specific metric or technology if available.
- Third sentence: soft, confident ask — interest in the role, not desperation.
- Optional fourth sentence: only if a natural follow-through is needed.
- Never claim a referral, mutual connection, or prior relationship unless the data explicitly states one.
- Never use: "excited", "passionate", "reaching out to connect", "synergy", "leverage", "world-class", "proven track record", "thought leader".
- No salutation. No signature. No subject line.
- Sound like a senior professional wrote it, not a template.
Return ONLY the message text.`;

/**
 * Generate a short outreach message for the recruiter or hiring manager.
 * Saves the result to job.recruiterTargeting.suggestedMessage and advances
 * responseStatus to 'message_drafted' if currently 'not_contacted'.
 * Returns the generated message string.
 */
export async function generateRecruiterMessage(jobId) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set — cannot generate outreach message');

  const job      = loadJobById(jobId);
  const bragDoc  = loadBragDoc();
  const rt       = getRecruiterTargeting(job);

  const jdContext = [
    job.report?.role_summary || '',
    job.description_preview  || '',
    job.full_description     || '',
  ].join(' ').replace(/\s+/g, ' ').slice(0, 800);

  const contactName  = rt.recruiterName       || rt.hiringManagerName       || '';
  const contactTitle = rt.recruiterTitle      || rt.hiringManagerTitle      || '';
  const linkedInUrl  = rt.recruiterLinkedInUrl || rt.hiringManagerLinkedInUrl || '';

  const userPrompt = [
    `TARGET JOB`,
    `Company: ${job.company}`,
    `Role: ${job.title}`,
    contactName  ? `Contact name: ${contactName}`   : '',
    contactTitle ? `Contact title: ${contactTitle}` : '',
    linkedInUrl  ? `Contact LinkedIn: ${linkedInUrl}` : '',
    rt.bestConnectionPath ? `Connection path: ${rt.bestConnectionPath}` : '',
    ``,
    `JOB CONTEXT`,
    jdContext,
    ``,
    `CANDIDATE BACKGROUND (top excerpts)`,
    bragDoc.slice(0, 2500),
  ].filter(Boolean).join('\n');

  const client = new Anthropic({ apiKey });
  const model  = process.env.CLAUDE_SYNTHESIS_MODEL ?? 'claude-sonnet-4-6';

  const response = await client.messages.create({
    model,
    max_tokens: 400,
    system: MESSAGE_SYSTEM,
    messages: [{ role: 'user', content: userPrompt }],
  });

  const text = response.content[0]?.text?.trim() ?? '';
  if (!text) throw new Error('Claude returned an empty message');

  updateJob(jobId, storedJob => {
    const existing = storedJob.recruiterTargeting ?? {};
    return {
      ...storedJob,
      recruiterTargeting: {
        ...existing,
        suggestedMessage: text,
        responseStatus: existing.responseStatus === 'not_contacted'
          ? 'message_drafted'
          : existing.responseStatus,
      },
    };
  });

  return text;
}

// ── Analytics ─────────────────────────────────────────────────────────────────

/**
 * Build aggregate recruiter outreach analytics across all jobs.
 *
 * @param {object[]} jobs — array of tracker job entries (with id spread in)
 * @returns {{
 *   contacted: number,
 *   notContacted: number,
 *   totalAttempts: number,
 *   responded: number,
 *   responseRate: number,
 *   followUpsDue: number,
 *   messagesDrafted: number,
 * }}
 */
export function buildRecruiterAnalytics(jobs) {
  let contacted      = 0;
  let notContacted   = 0;
  let totalAttempts  = 0;
  let responded      = 0;
  let followUpsDue   = 0;
  let messagesDrafted = 0;

  for (const job of jobs) {
    const rt = getRecruiterTargeting(job);
    totalAttempts += rt.contactAttempts.length;

    switch (rt.responseStatus) {
      case 'not_contacted':   notContacted++;    break;
      case 'message_drafted': messagesDrafted++; contacted++; break;
      case 'responded':       responded++;       contacted++; break;
      case 'referral_received': responded++;     contacted++; break;
      case 'follow_up_due':   followUpsDue++;    contacted++; break;
      default:                contacted++;       break;
    }
  }

  const responseRate = contacted > 0 ? Math.round((responded / contacted) * 100) : 0;

  return {
    contacted,
    notContacted,
    totalAttempts,
    responded,
    responseRate,
    followUpsDue,
    messagesDrafted,
  };
}
