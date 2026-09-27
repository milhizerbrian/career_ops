/**
 * gmail-sync.mjs — Gmail → tracker.json sync + broad application scan
 *
 * Two modes:
 *   1. runGmailSync()      — matches tracked companies; updates tracker.json
 *   2. runBroadGmailScan() — searches Gmail broadly for job application emails;
 *                            writes data/gmail-jobs.json (independent of tracker)
 *
 * Usage:
 *   node gmail-sync.mjs               # both modes
 *   node gmail-sync.mjs --dry-run     # preview without writing
 *   node gmail-sync.mjs --id <jobId>  # tracker sync for single job only
 */
import './lib/env.mjs';

import { google } from 'googleapis';
import { lmStudioChat } from './lib/resume-gen.mjs';
import { getLmStudioAnalysisModel } from './lib/lm-studio-config.mjs';
import { fileURLToPath } from 'url';
import fs from 'fs';
import path from 'path';
import { loadJobById, loadTracker, updateJob, createJob, loadProfile } from './lib/data.mjs';
import { writeJsonAtomic } from './lib/atomic-file.mjs';
import { STATUS_ORDER, normalizeStatus } from './lib/status-utils.mjs';
import { applyStageChange } from './lib/opportunity-store.mjs';
import { deriveStageFromStatus } from './lib/opportunity-stages.mjs';
import { normalizeWorkflowTimeline } from './lib/job-workflow.mjs';

const APP_ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.CAREER_OPS_DATA_DIR
  ? path.resolve(process.env.CAREER_OPS_DATA_DIR)
  : path.resolve(APP_ROOT, 'data');
const GMAIL_JOBS_PATH = process.env.CAREER_OPS_GMAIL_JOBS_PATH
  ? path.resolve(process.env.CAREER_OPS_GMAIL_JOBS_PATH)
  : path.resolve(DATA_DIR, 'gmail-jobs.json');
const AUTO_MATCH_THRESHOLD = 0.62;
const AMBIGUOUS_GAP = 0.12;
const OUTCOME_STATUSES = new Set(['offer', 'rejected', 'withdrawn']);

export const JOB_STATUSES = [
  ...STATUS_ORDER,
];

const statusRank = (status) => JOB_STATUSES.indexOf(normalizeStatus(status));

export function advanceStatus(currentStatus, incomingStatus) {
  const curIdx = statusRank(currentStatus);
  const newIdx = statusRank(incomingStatus);
  return newIdx > curIdx ? normalizeStatus(incomingStatus) : normalizeStatus(currentStatus);
}

export function shouldUseIncomingEmail(existingDate, incomingDate) {
  const existingTime = Date.parse(existingDate || '');
  const incomingTime = Date.parse(incomingDate || '');
  if (!Number.isFinite(existingTime)) return Number.isFinite(incomingTime);
  if (!Number.isFinite(incomingTime)) return false;
  return incomingTime >= existingTime;
}

function normalizeText(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenSet(value) {
  return new Set(meaningfulTokens(value));
}

function jaccard(a, b) {
  if (!a.size && !b.size) return 0;
  let overlap = 0;
  for (const item of a) if (b.has(item)) overlap++;
  return overlap / (a.size + b.size - overlap);
}

function titleSimilarity(a, b) {
  return jaccard(tokenSet(a), tokenSet(b));
}

function meaningfulTokens(value) {
  const stop = new Set(['and', 'the', 'for', 'with', 'job', 'role', 'senior', 'sr']);
  return normalizeText(value).split(' ').filter(t => t.length >= 3 && !stop.has(t));
}

// Full-title credit from the subject alone: the whole title (3+ meaningful
// words, so "Manager"/"CSM"/"Customer Success" never qualify) must appear as
// one contiguous phrase. All-or-nothing; no partial tier.
function subjectHasFullTitle(title, subject) {
  const t = meaningfulTokens(title);
  if (t.length < 3) return false;
  return ` ${meaningfulTokens(subject).join(' ')} `.includes(` ${t.join(' ')} `);
}

function companyMatches(a, b) {
  const left = normalizeText(a);
  const right = normalizeText(b);
  return !!left && !!right && (left === right || left.includes(right) || right.includes(left));
}

function fromDomain(from) {
  const match = String(from ?? '').match(/@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/);
  return match ? match[1].toLowerCase().replace(/^mail\./, '') : '';
}

function urlDomain(url) {
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; }
}

function compactUrl(url) {
  return String(url ?? '').replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/$/, '').toLowerCase();
}

function isAtsDomain(domain) {
  return /(?:greenhouse\.io|lever\.co|ashbyhq\.com|workday\.com|jobvite\.com|smartrecruiters\.com|icims\.com|taleo\.net|myworkdayjobs\.com)$/i.test(domain);
}

function hasOutcomeLanguage(status, haystack) {
  const normalizedStatus = normalizeStatus(status);
  if (normalizedStatus === 'rejected') {
    return /\b(not move forward|not moving forward|decided not to move forward|unfortunately|candidacy|candidate|other candidates|not selected)\b/.test(haystack);
  }
  if (normalizedStatus === 'offer') {
    return /\b(offer|offering|extend an offer|offer letter)\b/.test(haystack);
  }
  if (normalizedStatus === 'withdrawn') {
    return /\b(withdraw|withdrawn|withdrawing)\b/.test(haystack);
  }
  return false;
}

// ── Local-classification safety gate ─────────────────────────────────────────
// LM Studio output is a suggestion, not evidence. Important stage changes need
// explicit wording in the email itself; placeholder/malformed/uncertain output
// is routed to Brian's review queue instead of changing the tracker.
const STAGE_EVIDENCE = {
  rejected: /(?:not|n't) (?:be )?(?:moving|move|proceed(?:ing)?|able to move you) (?:forward|ahead)|decided not to (?:proceed|move forward|continue)|(?:move|moving|go|proceed) (?:forward|ahead) with (?:other|another|candidates)|pursue other candidates|not (?:been )?selected|(?:has been|have|we've|recently) filled|no longer (?:being )?considered|regret to inform|unable to offer you|not (?:the|a) right (?:match|fit)/i,
  withdrawn: /withdr(?:aw|awing|ew|awn) (?:from|my|your|our)|(?:application|candidacy) (?:has been |was )?withdrawn/i,
  offer: /pleased to (?:extend|offer you)|extend (?:you )?(?:an|a formal|a verbal|a written) offer|offer letter|offer of employment|(?:formal|verbal|written) offer/i,
  archived: /(?:position|role|job|requisition|opening|posting|search)[^.\n]{0,40}?(?:has been|have been|was|is) (?:closed|cancell?ed|put on hold|on hold|paused)|(?:put|placed) (?:this|the) (?:role|position|search|requisition) on hold|no longer (?:hiring for|accepting applications|recruiting for)|(?:position|role|requisition) (?:is )?no longer (?:open|available)/i,
  interview: /interview|schedul|\bscreen(?:ing)?\b|final round|on-?site|panel|phone screen|video call|calendar invite/i,
};
const EVIDENCE_FOR_STATUS = {
  rejected: 'rejected',
  withdrawn: 'withdrawn',
  offer: 'offer',
  archived: 'archived',
  recruiter_screen: 'interview',
  hiring_manager_screen: 'interview',
  technical_screen: 'interview',
  onsite: 'interview',
};
const PLACEHOLDER_RE = /[<>{}[\]]|\bor similar\b|\bnot (?:specified|provided|mentioned)\b|^(?:unknown|n\/?a|none|null|undefined|tbd|company(?: name)?|role|job title)$/i;
// Social-feed / newsletter senders (e.g. updates-noreply@, newsletters-noreply@)
// are never an employer or ATS; recruiter InMail relays are not matched.
const BULK_SENDER_RE = /(?:^|<|\s)(?:updates|newsletters?|editors|notifications?|digest|news|marketing)(?:[-_.]?no-?reply)?@/i;

export function isUnusableExtractedValue(value) {
  const text = String(value ?? '').trim();
  return !text || text.length > 120 || !/[a-z0-9]/i.test(text) || PLACEHOLDER_RE.test(text);
}

export function hasExplicitStageEvidence(status, text) {
  const key = EVIDENCE_FOR_STATUS[normalizeStatus(status)];
  return !key || STAGE_EVIDENCE[key].test(String(text ?? ''));
}

// Returns the reasons a classification needs review (empty = safe to automate).
// `company` is optional: tracker sync already knows the job's company.
export function classificationReviewReasons({ rawStatus, confidence, company, requireCompany = true }, email) {
  const reasons = [];
  const text = `${email.subject || ''}\n${email.bodyText || ''}`;
  const status = normalizeStatus(rawStatus);
  if (!JOB_STATUSES.includes(String(rawStatus ?? '').trim().toLowerCase())) {
    reasons.push(`status "${rawStatus ?? ''}" is not an allowed value`);
  }
  if (!['high', 'medium'].includes(String(confidence ?? '').toLowerCase())) {
    reasons.push(`model confidence is "${confidence ?? 'missing'}"`);
  }
  if (!hasExplicitStageEvidence(status, text)) {
    reasons.push(`no explicit ${status.replace(/_/g, ' ')} wording in the email`);
  }
  if (requireCompany) {
    if (isUnusableExtractedValue(company)) {
      reasons.push(`company "${company ?? ''}" is a placeholder or malformed`);
    } else {
      if (!normalizeText(`${email.from || ''} ${text}`).includes(normalizeText(company))) {
        reasons.push(`company "${company}" does not appear in the email`);
      }
      if (BULK_SENDER_RE.test(email.from || '')) {
        reasons.push('sent from a social/newsletter notification address, not an employer or ATS');
      }
    }
  }
  return reasons;
}

// ── Candidacy ownership gate ─────────────────────────────────────────────────
// Job-status wording proves nothing about WHOSE candidacy an email concerns:
// career newsletters, coaching stories and marketing mail describe other
// people's offers/rejections/interviews. A lifecycle status (applied or later)
// needs evidence the email is Brian's own recruiting correspondence:
//   - not bulk mail (newsletter sender, List-Unsubscribe header, unsubscribe /
//     view-in-browser footer, invisible preheader padding), unless an ATS sent it
//   - and either Brian took part in the thread, or the email greets him by name
//     AND uses second-person application/interview language.
// Candidate identity comes from config/profile.yml; missing identity fails closed.
const BULK_BODY_RE = /͏|\bunsubscribe\b|view (?:this email )?in (?:your |a )?browser|manage (?:your )?(?:email )?(?:preferences|subscriptions?)/i;
const CANDIDACY_RE = /\byour (?:[\w,&.-]+ ){0,4}?(?:application|candidacy|interview|submission|candidate profile)s?\b|\bthank(?:s| you)(?: so much)? for (?:applying|your (?:application|interest|time)|interviewing|taking the time to (?:apply|interview|speak|meet)|considering)|\byou(?:'ve| have)? applied\b|\binvite you (?:to|for)\b|\b(?:schedule|set up) (?:a|an|your|some) (?:call|interview|time|phone screen|screen)|\bmove (?:you )?forward (?:with you|in the (?:interview|hiring) process)/i;

// Bulk mail: newsletter/notification sender, List-Unsubscribe header, or an
// unsubscribe / view-in-browser / preheader-padding body. ATS senders never are.
export function isBulkMail(email) {
  const from = String(email?.from ?? '');
  return !isAtsDomain(fromDomain(from)) &&
    (BULK_SENDER_RE.test(from) || !!email?.listUnsubscribe || BULK_BODY_RE.test(String(email?.bodyText ?? '')));
}

export function candidacyOwnershipReasons(email, candidate, status = 'applied') {
  if (statusRank(status) < statusRank('applied')) return [];
  const fullName = String(candidate?.full_name ?? '').trim();
  const first = fullName.split(/\s+/)[0];
  if (!first) return ['candidacy ownership could not be established: candidate identity missing from config/profile.yml'];

  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const body = String(email.bodyText ?? '');
  const bulk = isBulkMail(email);
  const inThread = (email.threadSenders ?? []).some(s => isCandidateSender(s, candidate));
  const greeted = new RegExp(`\\b(?:hi|hello|hey|dear|good (?:morning|afternoon|evening))(?: there)?[,\\s]+${esc(first)}\\b|^\\W*${esc(first)}\\s*,`, 'i')
    .test(body.slice(0, 400));
  const candidacy = CANDIDACY_RE.test(`${email.subject ?? ''}\n${body}`);

  if (!bulk && (inThread || (greeted && candidacy))) return [];
  const missing = [
    bulk && 'bulk/newsletter/marketing mail',
    !bulk && !greeted && 'not addressed to the candidate by name',
    !bulk && greeted && !candidacy && 'no second-person application/interview language',
  ].filter(Boolean);
  return [`candidacy ownership could not be established (${missing.join('; ')}); may describe someone else's job search`];
}

function loadCandidate() {
  try { return loadProfile()?.candidate ?? null; } catch { return null; }
}

// True when a From header is the candidate (config/profile.yml candidate.email
// or candidate.full_name as the display name). Missing/invalid identity never
// matches; callers must treat that as "unknown", not "not the candidate".
function candidateIdentity(candidate) {
  const email = String(candidate?.email ?? '').trim().toLowerCase();
  const name = String(candidate?.full_name ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  return {
    email: /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email) ? email : '',
    name: name.length >= 2 ? name : '',
  };
}

export function isCandidateSender(from, candidate) {
  const { email, name } = candidateIdentity(candidate);
  const raw = String(from ?? '');
  const address = (raw.match(/<([^>]+)>/)?.[1] ?? raw).trim().toLowerCase();
  const display = raw.replace(/<[^>]*>/, '').replace(/["']/g, '').trim().toLowerCase().replace(/\s+/g, ' ');
  return (!!email && address === email) || (!!name && display === name);
}

// Tracker-sync stage decision: advance only when the gate finds no review reasons.
export function resolveTrackerSyncStatus(job, classified, email, candidate = null) {
  const current = normalizeStatus(job.status);
  const next = normalizeStatus(classified.status);
  const reviewReasons = statusRank(next) > statusRank(current)
    ? [
      ...classificationReviewReasons({ rawStatus: classified.rawStatus, confidence: classified.confidence, requireCompany: false }, email),
      ...candidacyOwnershipReasons(email, candidate, next),
    ]
    : [];
  return { status: statusRank(next) > statusRank(current) && !reviewReasons.length ? next : current, reviewReasons };
}

// Builds the tracker mutator for a Gmail-driven write: merges the email fields
// and, when the status really changes, moves the Opportunity through the
// Phase 1 lifecycle (applyStageChange) so stage/status stay consistent and
// the transition lands in workflowTimeline with source "gmail". A Gmail
// message already recorded there is never applied twice. Pure: runs only
// inside updateJob(), so dry-run (which never calls updateJob) writes nothing.
// Gmail metadata never bumps date_updated (freshness); only a real lifecycle
// transition does, via applyStageChange.
export function gmailJobMutator(fields, { from, to, messageKey, subject = '', date = '', via = '' }) {
  return (stored) => {
    const { date_updated: _ignored, ...metadata } = fields;
    const merged = { ...stored, ...metadata, status: normalizeStatus(stored.status) };
    const target = normalizeStatus(to);
    if (target === normalizeStatus(from)) return merged;
    const label = `gmail:${messageKey}`;
    if (normalizeWorkflowTimeline(stored.workflowTimeline).some(e => e.source === 'gmail' && e.label === label)) {
      return merged;
    }
    return applyStageChange(merged, deriveStageFromStatus(target), {
      status: target,
      actor: 'gmail',
      label,
      reason: `Gmail${via ? ` (${via})` : ''}: "${subject}" (${date}); previous status ${normalizeStatus(stored.status)}`,
    });
  };
}

function daysBetween(a, b) {
  const left = Date.parse(a || '');
  const right = Date.parse(b || '');
  if (!Number.isFinite(left) || !Number.isFinite(right)) return Infinity;
  return Math.abs(left - right) / 86_400_000;
}

function scoreGmailMatch(job, event) {
  const haystack = [
    event.role,
    event.last_email_subject,
    event.last_email_snippet,
    event.bodyText,
    event.from,
  ].filter(Boolean).join(' ');
  const normalizedHaystack = normalizeText(haystack);
  const matchedBy = [];
  let confidence = 0;

  if (companyMatches(job.company, event.company) || normalizeText(job.company) && normalizedHaystack.includes(normalizeText(job.company))) {
    confidence += 0.25;
    matchedBy.push('company');
  }

  // Genuine company evidence excludes the From header, so an ATS sender
  // (e.g. ashbyhq.com) can never stand in for the employer.
  const companyPhrase = normalizeText(job.company);
  const contentText = normalizeText([event.last_email_subject, event.last_email_snippet, event.bodyText].filter(Boolean).join(' '));
  const genuineCompany = companyMatches(job.company, event.company) || (!!companyPhrase && ` ${contentText} `.includes(` ${companyPhrase} `));
  const directTitle = titleSimilarity(job.title, event.role);
  const subjectTitle = genuineCompany && subjectHasFullTitle(job.title, event.last_email_subject)
    ? 1
    : titleSimilarity(job.title, `${event.last_email_subject || ''} ${event.last_email_snippet || ''}`);
  const titleScore = Math.max(directTitle, subjectTitle);
  if (titleScore >= 0.65) {
    confidence += 0.38;
    matchedBy.push(directTitle >= subjectTitle ? 'title' : 'thread_subject');
  } else if (titleScore >= 0.35) {
    confidence += 0.16;
    matchedBy.push(directTitle >= subjectTitle ? 'partial_title' : 'partial_thread_subject');
  }

  const jobUrl = compactUrl(job.url);
  if (jobUrl && compactUrl(haystack).includes(jobUrl)) {
    confidence += 0.35;
    matchedBy.push('job_url');
  }

  const senderDomain = fromDomain(event.from);
  const jobDomain = urlDomain(job.url);
  const companyKey = normalizeText(job.company).replace(/\s+/g, '');
  if (senderDomain && !isAtsDomain(senderDomain) && (
    (jobDomain && (senderDomain === jobDomain || senderDomain.endsWith(`.${jobDomain}`) || jobDomain.endsWith(senderDomain))) ||
    (companyKey.length >= 4 && senderDomain.replace(/[^a-z0-9]/g, '').includes(companyKey))
  )) {
    confidence += 0.14;
    matchedBy.push('recruiter_domain');
  }

  if (
    OUTCOME_STATUSES.has(normalizeStatus(event.status)) &&
    matchedBy.includes('company') &&
    matchedBy.includes('recruiter_domain') &&
    hasOutcomeLanguage(event.status, normalizedHaystack)
  ) {
    confidence += 0.2;
    matchedBy.push('candidate_outcome');
  }

  const timingDays = Math.min(
    daysBetween(event.last_email_date, job.date_found),
    daysBetween(event.last_email_date, job.date_updated)
  );
  if (timingDays <= 14) {
    confidence += 0.06;
    matchedBy.push('recent_application_timing');
  } else if (timingDays <= 45) {
    confidence += 0.03;
    matchedBy.push('loose_application_timing');
  }

  confidence = Math.min(1, Number(confidence.toFixed(2)));
  return { job, confidence, matchedBy };
}

// Persistable part of a match result: never the matched Opportunity itself
// (`job` duplicated the whole record, descriptions included, into tracker.json)
// nor the in-memory `candidates` list (stored separately as matchCandidates).
export function storedGmailMatch(match) {
  const { job: _job, candidates: _candidates, ...meta } = match || {};
  return meta;
}

export function matchGmailEventToTracker(event, trackerJobs, {
  threshold = AUTO_MATCH_THRESHOLD,
  ambiguousGap = AMBIGUOUS_GAP,
} = {}) {
  const candidates = trackerJobs
    .filter(job => job?.id && job?.company)
    .map(job => scoreGmailMatch(job, event))
    .filter(match => match.matchedBy.length)
    .sort((a, b) => b.confidence - a.confidence);

  const best = candidates[0] || null;
  const second = candidates[1] || null;
  const companyOnly = best?.matchedBy.length === 1 && best.matchedBy[0] === 'company';
  const ambiguous = !!best && !!second && best.confidence >= 0.4 && (best.confidence - second.confidence) <= ambiguousGap;
  const confident = !!best && best.confidence >= threshold && !companyOnly && !ambiguous;

  return {
    job: confident ? best.job : null,
    confidence: best?.confidence || 0,
    matchedBy: best?.matchedBy || [],
    ambiguous: !!ambiguous,
    candidates: candidates.slice(0, 3).map(match => ({
      id: match.job.id,
      company: match.job.company,
      title: match.job.title,
      confidence: match.confidence,
      matchedBy: match.matchedBy,
    })),
  };
}

function buildGmailClient() {
  const { GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN } = process.env;
  if (!GMAIL_CLIENT_ID || !GMAIL_CLIENT_SECRET || !GMAIL_REFRESH_TOKEN) {
    throw new Error('Missing GMAIL_* vars in .env — run node oauth-setup.mjs first');
  }
  const auth = new google.auth.OAuth2(GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET);
  auth.setCredentials({ refresh_token: GMAIL_REFRESH_TOKEN });
  return google.gmail({ version: 'v1', auth });
}

export function isGmailAuthError(err) {
  const status = err?.code || err?.response?.status;
  const message = String(err?.message || err?.response?.data?.error || '');
  const description = String(err?.response?.data?.error_description || '');
  return status === 401 ||
    /\binvalid_grant\b/i.test(message) ||
    /\binvalid_grant\b/i.test(description) ||
    /invalid credentials|unauthorized/i.test(message);
}

export function gmailReauthMessage(detail = '') {
  const suffix = detail ? ` (${detail})` : '';
  return `Gmail authorization expired or was revoked${suffix}. Run: node oauth-setup.mjs, update GMAIL_REFRESH_TOKEN in .env, then retry npm run gmail-sync -- --dry-run`;
}

async function verifyGmailAuth(gmail) {
  try {
    await gmail.users.getProfile({ userId: 'me' });
  } catch (err) {
    if (isGmailAuthError(err)) throw new Error(gmailReauthMessage(err.message));
    throw err;
  }
}

// ── Email helpers ─────────────────────────────────────────────────────────────

async function fetchThread(gmail, threadId) {
  return gmail.users.threads.get({ userId: 'me', id: threadId, format: 'full' });
}

// Return the most recent message NOT sent by the candidate, falling back to the
// first message unless it is self-sent. This avoids classifying Brian's own reply as the email to
// analyze. Without a usable profile identity we can't tell whose message is
// whose, so the thread is skipped (null) instead of guessing.
export function getBestMessage(thread, candidate) {
  const { email, name } = candidateIdentity(candidate);
  if (!email && !name) return null;
  const messages = thread.data.messages ?? [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const from = messages[i].payload?.headers?.find(h => h.name === 'From')?.value ?? '';
    if (!isCandidateSender(from, candidate)) return messages[i];
  }
  // A note the candidate sent only to themselves (e.g. a job-search digest)
  // is never inbound candidacy communication.
  return messages[0] && !isSelfSent(messages[0], candidate) ? messages[0] : null;
}

function isSelfSent(msg, candidate) {
  const headers = msg.payload?.headers ?? [];
  const value = (name) => headers.filter(h => h.name.toLowerCase() === name).map(h => h.value).join(',');
  const recipients = `${value('to')},${value('cc')}`.match(/[^\s<>,;"]+@[^\s<>,;"]+/g) ?? [];
  return isCandidateSender(value('from'), candidate) &&
    recipients.length > 0 && recipients.every(address => isCandidateSender(address, candidate));
}

function parseHeaders(msg) {
  const h = msg.payload?.headers ?? [];
  return {
    subject: h.find(x => x.name === 'Subject')?.value ?? '',
    date:    h.find(x => x.name === 'Date')?.value ?? '',
    from:    h.find(x => x.name === 'From')?.value ?? '',
    listUnsubscribe: h.find(x => /^list-unsubscribe$/i.test(x.name))?.value ?? '',
  };
}

function threadSenders(thread) {
  return (thread.data.messages ?? []).map(m => m.payload?.headers?.find(h => h.name === 'From')?.value ?? '');
}

function extractText(payload) {
  if (!payload) return '';
  if (payload.mimeType === 'text/plain' && payload.body?.data)
    return Buffer.from(payload.body.data, 'base64').toString('utf8');
  if (payload.parts) {
    for (const p of payload.parts) { const t = extractText(p); if (t) return t; }
  }
  return payload.snippet ?? '';
}

async function findLatestThread(gmail, company, candidate) {
  const res = await gmail.users.threads.list({
    userId: 'me', q: `"${company}" newer_than:180d`, maxResults: 5,
  });
  if (!res.data.threads?.length) return null;

  const thread = await fetchThread(gmail, res.data.threads[0].id);
  const msg = getBestMessage(thread, candidate);
  if (!msg) return null;

  const { subject, date, from, listUnsubscribe } = parseHeaders(msg);
  return {
    messageId: msg.id || res.data.threads[0].id,
    subject,
    from,
    listUnsubscribe,
    threadSenders: threadSenders(thread),
    date:     date ? new Date(date).toISOString() : new Date().toISOString(),
    snippet:  (msg.snippet ?? '').slice(0, 200),
    bodyText: extractText(msg.payload).slice(0, 2000),
  };
}

// Quota-exhaustion fix (part 2): the >65 score filter alone still let (a)
// duplicate opportunities at the same company (e.g. 10 separate Saviynt
// postings) each re-run an identical Gmail search, and (b) the 58 remaining
// unique-company searches fire back-to-back with no spacing, which measured
// against this project's real "Units per minute per user" quota (observed:
// ~40 searches succeed, then every further one fails) still exhausts it.
// Fix: (1) cache each company's Gmail search result for this run so repeat
// companies cost zero extra calls, (2) space out NEW (non-cached) searches
// at a rate measured to stay under that observed per-minute ceiling, and
// (3) on an actual quota response, wait out a full quota window ONCE (not a
// short exponential backoff, since this is a per-*minute* bucket) and slow
// all later searches down further — bounded retries only, never an
// unbounded hammering loop.
const GMAIL_SEARCH_DELAY_MS = 1800;       // ~33 searches/min, safely under the observed ~40/min ceiling
const GMAIL_QUOTA_COOLDOWN_MS = 65_000;   // just over Gmail's 1-minute quota window
const GMAIL_MAX_QUOTA_RETRIES = 2;        // wait out the window at most twice, never loop indefinitely

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isGmailQuotaError(err) {
  const status = err?.code || err?.response?.status;
  const reason = err?.errors?.[0]?.reason
    || err?.response?.data?.error?.errors?.[0]?.reason
    || '';
  const message = String(err?.message || err?.response?.data?.error?.message || '');
  return status === 429 ||
    /rateLimitExceeded|userRateLimitExceeded|quotaExceeded/i.test(reason) ||
    /rate limit|quota/i.test(message);
}

// Per-run Gmail request throttle, shared by tracker sync (company searches)
// and the broad scan (per-thread fetches). The broad scan used to fetch all
// ~94 threads back-to-back; when the Claude classifier fails fast (e.g. 401)
// nothing spaced those fetches out and ~37 of them hit the per-minute quota.
// Local state (not module-level) so repeated runs never share throttle state.
function createGmailThrottle() {
  let delayMs = GMAIL_SEARCH_DELAY_MS;
  let requestsRun = 0;

  return async function throttled(request) {
    if (requestsRun > 0) await sleep(delayMs);
    requestsRun += 1;
    for (let attempt = 0; ; attempt++) {
      try {
        return await request();
      } catch (err) {
        if (!isGmailQuotaError(err) || attempt >= GMAIL_MAX_QUOTA_RETRIES) throw err;
        delayMs *= 2; // slow every later search too, not just this retry
        process.stdout.write(
          `[quota] Gmail per-minute quota hit — cooling down ${Math.round(GMAIL_QUOTA_COOLDOWN_MS / 1000)}s ` +
          `(retry ${attempt + 1}/${GMAIL_MAX_QUOTA_RETRIES}), then spacing remaining Gmail requests ${delayMs}ms apart... `
        );
        await sleep(GMAIL_QUOTA_COOLDOWN_MS);
      }
    }
  };
}

// ── Claude helpers ────────────────────────────────────────────────────────────

// Gmail classification runs on the local LM Studio analysis model only —
// no paid API, and deliberately no Anthropic fallback.
const LM_STUDIO_BASE = 'http://localhost:1234';
const GMAIL_CLASSIFY_TIMEOUT_MS = 60_000;

export async function verifyLmStudio(model = getLmStudioAnalysisModel(), fetchImpl = fetch) {
  const fix = `Start LM Studio's server and load the model (e.g. \`lms server start\` then \`lms load ${model}\`), then retry npm run gmail-sync -- --dry-run`;
  let ids;
  try {
    const res = await fetchImpl(`${LM_STUDIO_BASE}/v1/models`, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    ids = ((await res.json()).data ?? []).map(m => m.id);
  } catch (err) {
    throw new Error(`LM Studio not reachable at ${LM_STUDIO_BASE} (${err.message}). ${fix}`);
  }
  if (!ids.includes(model)) {
    throw new Error(`LM Studio model "${model}" (LM_STUDIO_ANALYSIS_MODEL) not available. ${fix}`);
  }
}

async function classifyWithLmStudio(system, user) {
  const text = await lmStudioChat(
    getLmStudioAnalysisModel(),
    [{ role: 'system', content: system }, { role: 'user', content: user }],
    { maxTokens: 384, timeoutMs: GMAIL_CLASSIFY_TIMEOUT_MS },
  );
  // Local models often wrap JSON in ``` fences despite instructions.
  return text.replace(/^```(?:json)?\s*/m, '').replace(/\s*```\s*$/m, '').trim();
}

async function extractStatusAndNextSteps(job, email) {
  const text = await classifyWithLmStudio(
    'You extract job application status from emails. Respond with valid JSON only — no markdown, no explanation.',
    `Job: ${job.company} — ${job.title}
Current status: ${normalizeStatus(job.status)}

Email subject: ${email.subject}
Email body:
${email.bodyText}

Respond with JSON only:
{"status":"<lead|interested|applied|recruiter_screen|hiring_manager_screen|technical_screen|onsite|offer|rejected|withdrawn|archived>","next_steps":"<1-2 sentence action item, or empty string>","confidence":"<high|medium|low>"}

Rules:
- Never downgrade status
- "lead" = recruiter outreach received but not yet applied
- "applied" = application submitted, confirmation received
- "recruiter_screen" = recruiter phone or video screen scheduled or completed
- "hiring_manager_screen" = hiring manager screen scheduled or completed
- "technical_screen" = technical interview stage in progress
- "onsite" = onsite, final, or panel interview stage
- "offer" = offer received
- "rejected" = rejection received
- If email is clearly unrelated to this job, return current status and empty next_steps`,
  );

  try {
    const parsed = JSON.parse(text || '{}');
    parsed.rawStatus = parsed.status;
    parsed.status = normalizeStatus(parsed.status || job.status);
    return parsed;
  } catch {
    return { status: normalizeStatus(job.status), next_steps: '', confidence: 'low' };
  }
}

async function extractJobFromEmail(email) {
  const text = await classifyWithLmStudio(
    'You extract job application details from emails. Respond with valid JSON only — no markdown, no explanation.',
    `Extract job application details from this email.

From: ${email.from}
Subject: ${email.subject}
Date: ${email.date}
Body:
${email.bodyText}

Respond with JSON only:
{
  "is_job_related": true/false,
  "company": "<company name or empty string>",
  "role": "<job title or empty string>",
  "status": "<lead|interested|applied|recruiter_screen|hiring_manager_screen|technical_screen|onsite|offer|rejected|withdrawn|archived>",
  "next_steps": "<1-2 sentence action item, or empty string>",
  "confidence": "<high|medium|low>"
}

Rules:
- "is_job_related": true only if this is clearly about a job application, interview, offer, rejection, or recruiter outreach
- "applied" = application confirmation received
- "recruiter_screen" = recruiter phone/video screen scheduled or completed
- "hiring_manager_screen" = hiring manager screen scheduled or completed
- "technical_screen" = technical interview stage in progress
- "onsite" = onsite, final, or panel interview stage
- "offer" = job offer received
- "rejected" = rejection
- "lead" = recruiter cold outreach, not yet applied
- "lead" = unknown / cannot determine
- If not job-related, return is_job_related: false and empty strings for all other fields`,
  );

  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    return jsonMatch ? JSON.parse(jsonMatch[0]) : { is_job_related: false };
  } catch {
    return { is_job_related: false };
  }
}

// ── Mode 1: tracker sync ──────────────────────────────────────────────────────

// Existing Career-Ops fit score, as a 0-100 percent. Mirrors the same
// fallback already used by lib/action-engine.mjs (legacyFitPercent) and
// public/js/dashboard.js (atsPercent): prefer a real Phase 2 ATS score when
// present, else convert the legacy 0-5 `score` field. This does not compute
// or recalculate a score — it only reads the job's existing score field(s).
function fitScorePercent(job) {
  const ats = Number(job?._ats?.score);
  if (Number.isFinite(ats)) return Math.round(ats);
  const legacy = Number(job?.score);
  return Number.isFinite(legacy) ? Math.round(legacy * 20) : null;
}

// Tracker pass: the company search's newest thread is only candidacy evidence
// when it isn't bulk mail (job alerts, digests, saved-job reminders, social
// notifications), so those never become the Opportunity's email metadata.
export function matchTrackerPassEmail(job, email) {
  if (isBulkMail(email)) return { job: null, bulk: true, confidence: 0, matchedBy: [], ambiguous: false, candidates: [] };
  return matchGmailEventToTracker({
    company: job.company,
    role: '',
    from: email.from,
    last_email_subject: email.subject,
    last_email_date: email.date,
    last_email_snippet: email.snippet,
    bodyText: email.bodyText,
  }, [job]);
}

export async function runGmailSync({ jobId = null, dryRun = false, onProgress = null } = {}) {
  await verifyLmStudio();
  const gmail   = buildGmailClient();
  await verifyGmailAuth(gmail);
  const jobs    = loadTracker().filter(j => j.company?.trim());
  const scoped  = jobId ? jobs.filter(j => j.id === jobId) : jobs;
  // Quota fix: filter by existing fit score BEFORE any Gmail API call, so
  // skipped jobs never trigger a request. Missing/invalid/≤65 scores skip.
  const target  = scoped.filter(j => {
    const pct = fitScorePercent(j);
    return pct != null && pct > 65;
  });
  const skipped = scoped.length - target.length;

  process.stdout.write(`Tracker: ${scoped.length} total | ${target.length} score >65 | ${skipped} skipped\n`);
  process.stdout.write(`[gmail-sync] Tracker sync: ${target.length} jobs (dry-run: ${dryRun})\n`);

  // Cache Gmail search results per company (normalized) for this run only,
  // so multiple tracker entries for the same company (duplicate postings)
  // reuse one Gmail search instead of repeating it. Caches both a found
  // email and a confirmed "no emails found" (null) so neither re-queries.
  const gmailSearchCache = new Map();
  const throttledGmail = createGmailThrottle();
  const candidate = loadCandidate();
  if (!getBestMessage({ data: { messages: [{}] } }, candidate)) {
    process.stdout.write('[gmail-sync] candidate identity missing/invalid in config/profile.yml (candidate.full_name / candidate.email): every thread will be skipped\n');
  }

  for (const job of target) {
    process.stdout.write(`  → ${job.company}... `);
    try {
      const cacheKey = job.company.trim().toLowerCase();
      let email;
      if (gmailSearchCache.has(cacheKey)) {
        email = gmailSearchCache.get(cacheKey);
      } else {
        email = await throttledGmail(() => findLatestThread(gmail, job.company, candidate));
        gmailSearchCache.set(cacheKey, email);
      }
      if (!email) { process.stdout.write('no emails found\n'); continue; }

      const match = matchTrackerPassEmail(job, email);
      if (match.bulk) {
        process.stdout.write('skip bulk/notification mail (not candidacy correspondence)\n');
        continue;
      }
      if (!match.job) {
        process.stdout.write(
          `skip weak match confidence=${match.confidence} ` +
          `matchedBy=${match.matchedBy.join(',') || 'none'} ambiguous=${match.ambiguous}\n`
        );
        continue;
      }

      const classified = await extractStatusAndNextSteps(job, email);
      const newStatus = classified.status;
      const next_steps = isUnusableExtractedValue(classified.next_steps) ? '' : classified.next_steps;
      const current = normalizeStatus(job.status);
      const { status: final, reviewReasons } = resolveTrackerSyncStatus(job, classified, email, candidate);

      const updates = {
        status:             final,
        next_steps:         next_steps ?? '',
        last_email_subject: email.subject,
        last_email_date:    email.date,
        last_email_snippet: email.snippet,
        gmailMatch: {
          confidence: match.confidence,
          matchedBy: match.matchedBy,
          ambiguous: match.ambiguous,
        },
        date_updated:       new Date().toISOString().slice(0, 10),
      };
      if (reviewReasons.length) {
        // Stage unchanged; keep the suggestion + email on the job for Brian.
        updates.gmailReview = {
          suggestedStatus: newStatus,
          reasons: reviewReasons,
          subject: email.subject,
          from: email.from,
          date: email.date,
          flaggedAt: new Date().toISOString(),
        };
        process.stdout.write(`NEEDS REVIEW (suggested ${newStatus}: ${reviewReasons.join('; ')}) | `);
      }

      process.stdout.write(`${current} → ${final} | "${(next_steps ?? '').slice(0, 60)}"\n`);
      if (!dryRun) updateJob(job.id, gmailJobMutator(updates, {
        from: current, to: final, messageKey: email.messageId, subject: email.subject, date: email.date,
      }));
      if (onProgress) onProgress(job.id, job.company, final, next_steps ?? '');
    } catch (err) {
      if (isGmailAuthError(err)) throw new Error(gmailReauthMessage(err.message));
      process.stdout.write(`ERROR: ${err.message}\n`);
    }
  }

  process.stdout.write('[gmail-sync] Tracker sync done.\n');
}

// ── Mode 2: broad Gmail scan ──────────────────────────────────────────────────

// Searches subject AND body (no field prefix = Gmail searches everywhere).
// category:primary excludes newsletters/promotions/automated digests.
// Claude filters the remaining false positives in extractJobFromEmail().
const INBOX_QUERY = [
  'interview',
  '"job application"',
  '"your application"',
  '"application received"',
  '"thank you for applying"',
  '"phone screen"',
  '"next steps"',
  '"hiring manager"',
  '"offer letter"',
  '"job offer"',
  'unfortunately',
  '"not selected"',
  '"other candidates"',
  '"moving forward"',
  '"excited to"',
  'recruiter',
  '"open role"',
].map(t => `(${t})`).join(' OR ');

// ATS senders catch automated emails regardless of wording
const ATS_SENDER_QUERY = [
  'from:(@greenhouse.io)',
  'from:(@lever.co)',
  'from:(@ashbyhq.com)',
  'from:(@workday.com)',
  'from:(@jobvite.com)',
  'from:(@smartrecruiters.com)',
  'from:(@icims.com)',
  'from:(@taleo.net)',
  'from:(@myworkdayjobs.com)',
].join(' OR ');

const FULL_QUERY = `(${INBOX_QUERY} OR ${ATS_SENDER_QUERY}) category:primary newer_than:365d`;
const PAGE_SIZE  = 500; // Gmail API max per page

export async function runBroadGmailScan({ dryRun = false, onProgress = null } = {}) {
  await verifyLmStudio();
  const gmail = buildGmailClient();
  await verifyGmailAuth(gmail);

  // ── Paginate through ALL matching threads ─────────────────────────────────
  process.stdout.write(`[gmail-scan] Full inbox sweep for job-related emails...\n`);

  const allThreadIds = new Set();
  let pageToken;
  do {
    const res = await gmail.users.threads.list({
      userId: 'me',
      q: FULL_QUERY,
      maxResults: PAGE_SIZE,
      ...(pageToken ? { pageToken } : {}),
    });
    for (const t of res.data.threads ?? []) allThreadIds.add(t.id);
    pageToken = res.data.nextPageToken;
  } while (pageToken);

  process.stdout.write(`[gmail-scan] ${allThreadIds.size} candidate threads found — classifying...\n`);

  const seen = new Map(); // "company|role|thread" → best entry (highest status)
  const throttledGmail = createGmailThrottle();
  const candidate = loadCandidate();
  if (!getBestMessage({ data: { messages: [{}] } }, candidate)) {
    process.stdout.write('[gmail-sync] candidate identity missing/invalid in config/profile.yml (candidate.full_name / candidate.email): every thread will be skipped\n');
  }

  for (const threadId of allThreadIds) {
    try {
      const thread  = await throttledGmail(() => fetchThread(gmail, threadId));
      const msg     = getBestMessage(thread, candidate);
      if (!msg) continue;

      const { subject, date, from, listUnsubscribe } = parseHeaders(msg);
      const bodyText = extractText(msg.payload).slice(0, 2000);
      const snippet  = (msg.snippet ?? '').slice(0, 200);
      const dateIso  = date ? new Date(date).toISOString() : new Date().toISOString();

      const extracted = await extractJobFromEmail({ from, subject, date: dateIso, bodyText });

      if (!extracted.is_job_related || !extracted.company) {
        process.stdout.write(`  skip: "${subject.slice(0, 60)}"\n`);
        continue;
      }

      const rawStatus = extracted.status;
      const mail = { from, subject, bodyText, listUnsubscribe, threadSenders: threadSenders(thread) };
      const reviewReasons = [
        ...classificationReviewReasons({ rawStatus, confidence: extracted.confidence, company: extracted.company }, mail),
        ...candidacyOwnershipReasons(mail, candidate, normalizeStatus(rawStatus)),
      ];
      // Reject unusable values rather than inventing replacements.
      if (isUnusableExtractedValue(extracted.role)) extracted.role = '';
      if (isUnusableExtractedValue(extracted.next_steps)) extracted.next_steps = '';

      const key       = [
        extracted.company,
        extracted.role || '',
        threadId,
      ].map(part => normalizeText(part)).join('|');
      extracted.status = normalizeStatus(extracted.status);
      const statusIdx = statusRank(extracted.status);
      const prevEntry = seen.get(key);
      const prevIdx   = prevEntry ? statusRank(prevEntry.status) : -1;

      if (prevEntry) {
        // Upgrade role name if we now have one and didn't before; keep higher status
        if (extracted.role && !prevEntry.role) prevEntry.role = extracted.role;
        if (prevIdx >= statusIdx) continue; // existing status is higher-or-equal, no full update needed
      }

      seen.set(key, {
        thread_id:          threadId,
        message_id:         msg.id || threadId,
        from,
        company:            extracted.company,
        role:               extracted.role || (prevEntry?.role ?? ''),
        status:             extracted.status,
        next_steps:         extracted.next_steps || '',
        last_email_subject: subject,
        last_email_date:    dateIso,
        last_email_snippet: snippet,
        bodyText,
        synced_at:          new Date().toISOString(),
        ...(reviewReasons.length ? { needsReview: true, reviewReasons, classifiedStatus: rawStatus } : {}),
      });

      process.stdout.write(
        `  ${reviewReasons.length ? '?' : '✓'} ${extracted.company} — ${extracted.role || '(role unknown)'} [${extracted.status}]` +
        (reviewReasons.length ? ` needs review: ${reviewReasons.join('; ')}` : '') + '\n'
      );
      if (onProgress) onProgress(null, extracted.company, extracted.status, extracted.next_steps || '');
    } catch (err) {
      if (isGmailAuthError(err)) throw new Error(gmailReauthMessage(err.message));
      process.stdout.write(`  ERROR on thread ${threadId}: ${err.message}\n`);
    }
  }

  const trackerJobs = loadTracker();
  const finalResults = [...seen.values()]
    .map(result => {
      const match = matchGmailEventToTracker(result, trackerJobs);
      return {
        ...result,
        gmailMatch: storedGmailMatch(match),
        matchCandidates: match.candidates,
        bodyText: undefined,
      };
    })
    .sort((a, b) => statusRank(b.status) - statusRank(a.status));

  process.stdout.write(`[gmail-scan] Found ${finalResults.length} job-related threads\n`);

  if (!dryRun) {
    writeJsonAtomic(GMAIL_JOBS_PATH, finalResults);
    process.stdout.write(`[gmail-scan] Saved to data/gmail-jobs.json\n`);
  }

  // ── Sync confident results into tracker.json ───────────────────────────────
  const trackerById = new Map(trackerJobs.map(job => [job.id, job]));
  let updatedCount = 0, addedCount = 0, ambiguousCount = 0, unmatchedCount = 0, reviewCount = 0;

  for (const result of finalResults) {
    if (result.needsReview) {
      reviewCount++;
      process.stdout.write(
        `  [tracker] needs review ${result.company} — ${result.role || '(unknown role)'} [${result.status}] ` +
        `no tracker change: ${result.reviewReasons.join('; ')}\n`
      );
      continue;
    }
    const topCandidate = result.matchCandidates?.[0] || null;
    const companyOnly = result.gmailMatch?.matchedBy?.length === 1 && result.gmailMatch.matchedBy[0] === 'company';
    const existing = result.gmailMatch?.confidence >= AUTO_MATCH_THRESHOLD && !result.gmailMatch.ambiguous && !companyOnly
      ? trackerById.get(topCandidate?.id)
      : null;

    if (existing) {
      // Advance status only (never downgrade)
      const finalStatus = advanceStatus(existing.status, result.status);
      const statusAdvanced = finalStatus !== normalizeStatus(existing.status);
      const useIncomingDetails = statusAdvanced || shouldUseIncomingEmail(existing.last_email_date, result.last_email_date);
      const nextJob = {
        ...existing,
        status: finalStatus,
        next_steps: useIncomingDetails
          ? (result.next_steps || (finalStatus === 'rejected' ? '' : existing.next_steps || ''))
          : (existing.next_steps || ''),
        last_email_subject: useIncomingDetails ? result.last_email_subject : existing.last_email_subject,
        last_email_date: useIncomingDetails ? result.last_email_date : existing.last_email_date,
        last_email_snippet: useIncomingDetails ? result.last_email_snippet : existing.last_email_snippet,
        gmailMatch: useIncomingDetails ? result.gmailMatch : existing.gmailMatch,
        date_updated: new Date().toISOString().slice(0, 10),
      };

      process.stdout.write(`  [tracker] update ${existing.company} (${normalizeStatus(existing.status)} → ${finalStatus})\n`);
      if (!dryRun) {
        updateJob(existing.id, gmailJobMutator({
          next_steps:         nextJob.next_steps,
          last_email_subject: nextJob.last_email_subject,
          last_email_date:    nextJob.last_email_date,
          last_email_snippet: nextJob.last_email_snippet,
          gmailMatch:         nextJob.gmailMatch,
          date_updated:       nextJob.date_updated,
        }, {
          from: existing.status, to: finalStatus,
          messageKey: result.message_id || result.thread_id,
          subject: result.last_email_subject, date: result.last_email_date,
        }));
      }
      trackerById.set(existing.id, nextJob);
      updatedCount++;
    } else if (result.gmailMatch.ambiguous) {
      ambiguousCount++;
      process.stdout.write(
        `  [tracker] ambiguous ${result.company} — ${result.role || '(unknown role)'} ` +
        `confidence=${result.gmailMatch.confidence} candidates=${(result.matchCandidates || []).map(c => c.id).join(',')}\n`
      );
    } else if (result.gmailMatch.confidence > 0) {
      unmatchedCount++;
      process.stdout.write(
        `  [tracker] no confident match ${result.company} — ${result.role || '(unknown role)'} ` +
        `confidence=${result.gmailMatch.confidence} matchedBy=${result.gmailMatch.matchedBy.join(',') || 'none'}\n`
      );
    } else {
      // New job found only in Gmail — add it to tracker
      const id = 'gmail-' + Math.random().toString(36).slice(2, 10);
      process.stdout.write(`  [tracker] add   ${result.company} — ${result.role || '(unknown role)'} [${result.status}]\n`);
      if (!dryRun) {
        createJob(id, {
          company:            result.company,
          title:              result.role || '',
          status:             normalizeStatus(result.status),
          next_steps:         result.next_steps || '',
          last_email_subject: result.last_email_subject,
          last_email_date:    result.last_email_date,
          last_email_snippet: result.last_email_snippet,
          gmailMatch:         result.gmailMatch,
          date_found:         new Date().toISOString().slice(0, 10),
          date_updated:       new Date().toISOString().slice(0, 10),
          url:                '',
          source:             'gmail',
          notes:              '',
        });
      }
      addedCount++;
      if (onProgress) onProgress(id, result.company, result.status, result.next_steps || '');
    }
  }

  process.stdout.write(
    `[gmail-scan] tracker.json: ${updatedCount} updated, ${addedCount} added, ` +
    `${ambiguousCount} ambiguous, ${unmatchedCount} weak matches, ${reviewCount} need review` +
    (dryRun ? ' (dry-run — no writes)' : '') + '\n'
  );

  return finalResults;
}

export function loadGmailJobs() {
  if (!fs.existsSync(GMAIL_JOBS_PATH)) return [];
  try {
    return JSON.parse(fs.readFileSync(GMAIL_JOBS_PATH, 'utf8'));
  } catch {
    return [];
  }
}

function updateGmailJobs(mutatorFn) {
  const jobs = loadGmailJobs();
  const next = mutatorFn(jobs) || jobs;
  writeJsonAtomic(GMAIL_JOBS_PATH, next);
  return next;
}

export function listAmbiguousGmailJobs(jobs = loadGmailJobs()) {
  return jobs.filter(job => (job?.gmailMatch?.ambiguous === true || job?.needsReview === true) && !job.gmailResolution);
}

export function buildGmailAttachFields(event, job, resolvedAt = new Date().toISOString()) {
  const jobId = typeof job === 'string' ? job : job?.id;
  const previousStatus = normalizeStatus(typeof job === 'string' ? 'lead' : job?.status);
  const detectedStatus = normalizeStatus(event.status);
  const resolvedStatus = advanceStatus(previousStatus, detectedStatus);
  return {
    status: resolvedStatus,
    last_email_subject: event.last_email_subject || '',
    last_email_date: event.last_email_date || '',
    last_email_snippet: event.last_email_snippet || '',
    gmailMatch: {
      ...storedGmailMatch(event.gmailMatch),
      ambiguous: true,
      manuallyResolved: true,
      resolvedJobId: jobId,
      resolvedAt,
    },
    gmailAmbiguityResolution: {
      action: 'attached',
      thread_id: event.thread_id,
      jobId,
      resolvedAt,
      detectedCompany: event.company || '',
      detectedTitle: event.role || '',
      confidence: event.gmailMatch?.confidence || 0,
      previousStatus,
      detectedStatus,
      resolvedStatus,
      statusChanged: resolvedStatus !== previousStatus,
    },
    date_updated: new Date(resolvedAt).toISOString().slice(0, 10),
  };
}

function markGmailJobResolved(threadId, resolution) {
  let resolvedEvent = null;
  updateGmailJobs(jobs => jobs.map(job => {
    if (job.thread_id !== threadId) return job;
    resolvedEvent = job;
    return {
      ...job,
      gmailResolution: {
        ...resolution,
        thread_id: threadId,
      },
    };
  }));
  if (!resolvedEvent) throw new Error(`Gmail ambiguity not found: ${threadId}`);
  return resolvedEvent;
}

export function attachGmailAmbiguityToJob(threadId, jobId) {
  if (!jobId || typeof jobId !== 'string') throw new Error('jobId is required');
  const event = loadGmailJobs().find(job => job.thread_id === threadId);
  if (!event) throw new Error(`Gmail ambiguity not found: ${threadId}`);
  if (event.gmailResolution) throw new Error('Gmail ambiguity is already resolved');
  if (event?.gmailMatch?.ambiguous !== true && event?.needsReview !== true) throw new Error('Gmail event is not ambiguous');

  const resolvedAt = new Date().toISOString();
  const job = loadJobById(jobId);
  const fields = buildGmailAttachFields(event, job, resolvedAt);
  const { status: _resolved, ...emailFields } = fields;
  updateJob(jobId, gmailJobMutator(emailFields, {
    from: fields.gmailAmbiguityResolution.previousStatus,
    to: fields.gmailAmbiguityResolution.resolvedStatus,
    messageKey: event.message_id || event.thread_id,
    subject: event.last_email_subject, date: event.last_email_date,
    via: 'confirmed from review queue',
  }));
  markGmailJobResolved(threadId, {
    action: 'attached',
    jobId,
    resolvedAt,
    previousStatus: fields.gmailAmbiguityResolution.previousStatus,
    detectedStatus: fields.gmailAmbiguityResolution.detectedStatus,
    resolvedStatus: fields.gmailAmbiguityResolution.resolvedStatus,
    statusChanged: fields.gmailAmbiguityResolution.statusChanged,
  });
  return {
    ok: true,
    threadId,
    jobId,
    previousStatus: fields.gmailAmbiguityResolution.previousStatus,
    detectedStatus: fields.gmailAmbiguityResolution.detectedStatus,
    resolvedStatus: fields.gmailAmbiguityResolution.resolvedStatus,
    statusChanged: fields.gmailAmbiguityResolution.statusChanged,
  };
}

export function dismissGmailAmbiguity(threadId) {
  const event = loadGmailJobs().find(job => job.thread_id === threadId);
  if (!event) throw new Error(`Gmail ambiguity not found: ${threadId}`);
  if (event.gmailResolution) throw new Error('Gmail ambiguity is already resolved');
  if (event?.gmailMatch?.ambiguous !== true && event?.needsReview !== true) throw new Error('Gmail event is not ambiguous');

  const resolvedAt = new Date().toISOString();
  markGmailJobResolved(threadId, { action: 'dismissed', resolvedAt });
  return { ok: true, threadId };
}

// ── CLI entry point ───────────────────────────────────────────────────────────

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dryRun   = process.argv.includes('--dry-run');
  const idIdx    = process.argv.indexOf('--id');
  const singleId = idIdx !== -1 ? process.argv[idIdx + 1] : null;

  // Run both modes unless --id is given (then tracker-only)
  async function main() {
    await runGmailSync({ jobId: singleId, dryRun });
    if (!singleId) await runBroadGmailScan({ dryRun });
  }

  main().catch(err => {
    process.stderr.write(`[gmail-sync] Fatal: ${err.message}\n`);
    process.exit(1);
  });
}
