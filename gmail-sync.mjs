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
import Anthropic from '@anthropic-ai/sdk';
import { fileURLToPath } from 'url';
import fs from 'fs';
import path from 'path';
import { loadJobById, loadTracker, updateJob, createJob } from './lib/data.mjs';
import { writeJsonAtomic } from './lib/atomic-file.mjs';
import { STATUS_ORDER, normalizeStatus } from './lib/status-utils.mjs';

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
  const stop = new Set(['and', 'the', 'for', 'with', 'job', 'role', 'senior', 'sr']);
  return new Set(normalizeText(value).split(' ').filter(t => t.length >= 3 && !stop.has(t)));
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

  const directTitle = titleSimilarity(job.title, event.role);
  const subjectTitle = titleSimilarity(job.title, `${event.last_email_subject || ''} ${event.last_email_snippet || ''}`);
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

// Return the most recent message NOT sent by Brian, falling back to the first
// message. This avoids classifying Brian's own reply as the email to analyze.
function getBestMessage(thread) {
  const messages = thread.data.messages ?? [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const from = messages[i].payload?.headers?.find(h => h.name === 'From')?.value ?? '';
    if (!/bmilhizer|brian milhizer/i.test(from)) return messages[i];
  }
  return messages[0] ?? null;
}

function getLatestMessage(thread) {
  return getBestMessage(thread);
}

function parseHeaders(msg) {
  const h = msg.payload?.headers ?? [];
  return {
    subject: h.find(x => x.name === 'Subject')?.value ?? '',
    date:    h.find(x => x.name === 'Date')?.value ?? '',
    from:    h.find(x => x.name === 'From')?.value ?? '',
  };
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

async function findLatestThread(gmail, company) {
  const res = await gmail.users.threads.list({
    userId: 'me', q: `"${company}" newer_than:180d`, maxResults: 5,
  });
  if (!res.data.threads?.length) return null;

  const thread = await fetchThread(gmail, res.data.threads[0].id);
  const msg = getLatestMessage(thread);
  if (!msg) return null;

  const { subject, date, from } = parseHeaders(msg);
  return {
    subject,
    from,
    date:     date ? new Date(date).toISOString() : new Date().toISOString(),
    snippet:  (msg.snippet ?? '').slice(0, 200),
    bodyText: extractText(msg.payload).slice(0, 2000),
  };
}

// ── Claude helpers ────────────────────────────────────────────────────────────

// process.env.ANTHROPIC_API_KEY may be "" (set by shell/sandbox) — read
// from .env directly so the SDK always gets a real key.
function getApiKey() {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  try {
    const envPath = path.resolve(APP_ROOT, '.env');
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const m = line.match(/^ANTHROPIC_API_KEY=(.+)$/);
      if (m) return m[1].trim();
    }
  } catch {}
  return '';
}

const anthropic = new Anthropic({ apiKey: getApiKey() });

async function extractStatusAndNextSteps(job, email) {
  const r = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 256,
    system: 'You extract job application status from emails. Respond with valid JSON only — no markdown, no explanation.',
    messages: [{
      role: 'user',
      content: `Job: ${job.company} — ${job.title}
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
    }],
  });

  try {
    const parsed = JSON.parse(r.content[0]?.text?.trim() ?? '{}');
    parsed.status = normalizeStatus(parsed.status || job.status);
    return parsed;
  } catch {
    return { status: normalizeStatus(job.status), next_steps: '', confidence: 'low' };
  }
}

async function extractJobFromEmail(email) {
  const r = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 384,
    system: 'You extract job application details from emails. Respond with valid JSON only — no markdown, no explanation.',
    messages: [{
      role: 'user',
      content: `Extract job application details from this email.

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
    }],
  });

  try {
    const text = r.content[0]?.text?.trim() ?? '{}';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    return jsonMatch ? JSON.parse(jsonMatch[0]) : { is_job_related: false };
  } catch {
    return { is_job_related: false };
  }
}

// ── Mode 1: tracker sync ──────────────────────────────────────────────────────

export async function runGmailSync({ jobId = null, dryRun = false, onProgress = null } = {}) {
  const gmail  = buildGmailClient();
  await verifyGmailAuth(gmail);
  const jobs   = loadTracker().filter(j => j.company?.trim());
  const target = jobId ? jobs.filter(j => j.id === jobId) : jobs;

  process.stdout.write(`[gmail-sync] Tracker sync: ${target.length} jobs (dry-run: ${dryRun})\n`);

  for (const job of target) {
    process.stdout.write(`  → ${job.company}... `);
    try {
      const email = await findLatestThread(gmail, job.company);
      if (!email) { process.stdout.write('no emails found\n'); continue; }

      const match = matchGmailEventToTracker({
        company: job.company,
        role: '',
        from: email.from,
        last_email_subject: email.subject,
        last_email_date: email.date,
        last_email_snippet: email.snippet,
        bodyText: email.bodyText,
      }, [job]);

      if (!match.job) {
        process.stdout.write(
          `skip weak match confidence=${match.confidence} ` +
          `matchedBy=${match.matchedBy.join(',') || 'none'} ambiguous=${match.ambiguous}\n`
        );
        continue;
      }

      const { status: newStatus, next_steps } = await extractStatusAndNextSteps(job, email);
      const current = normalizeStatus(job.status);
      const curIdx  = statusRank(current);
      const newIdx  = statusRank(newStatus);
      const final   = newIdx > curIdx ? newStatus : current;

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

      process.stdout.write(`${current} → ${final} | "${(next_steps ?? '').slice(0, 60)}"\n`);
      if (!dryRun) updateJob(job.id, updates);
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

  for (const threadId of allThreadIds) {
    try {
      const thread  = await fetchThread(gmail, threadId);
      const msg     = getLatestMessage(thread);
      if (!msg) continue;

      const { subject, date, from } = parseHeaders(msg);
      const bodyText = extractText(msg.payload).slice(0, 2000);
      const snippet  = (msg.snippet ?? '').slice(0, 200);
      const dateIso  = date ? new Date(date).toISOString() : new Date().toISOString();

      const extracted = await extractJobFromEmail({ from, subject, date: dateIso, bodyText });

      if (!extracted.is_job_related || !extracted.company) {
        process.stdout.write(`  skip: "${subject.slice(0, 60)}"\n`);
        continue;
      }

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
      });

      process.stdout.write(`  ✓ ${extracted.company} — ${extracted.role || '(role unknown)'} [${extracted.status}]\n`);
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
      const { candidates, ...gmailMatch } = match;
      return {
        ...result,
        gmailMatch,
        matchCandidates: candidates,
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
  let updatedCount = 0, addedCount = 0, ambiguousCount = 0, unmatchedCount = 0;

  for (const result of finalResults) {
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
        updateJob(existing.id, {
          status:             nextJob.status,
          next_steps:         nextJob.next_steps,
          last_email_subject: nextJob.last_email_subject,
          last_email_date:    nextJob.last_email_date,
          last_email_snippet: nextJob.last_email_snippet,
          gmailMatch:         nextJob.gmailMatch,
          date_updated:       nextJob.date_updated,
        });
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
    `${ambiguousCount} ambiguous, ${unmatchedCount} weak matches` +
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
  return jobs.filter(job => job?.gmailMatch?.ambiguous === true && !job.gmailResolution);
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
      ...(event.gmailMatch || {}),
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
  if (event?.gmailMatch?.ambiguous !== true) throw new Error('Gmail event is not ambiguous');

  const resolvedAt = new Date().toISOString();
  const job = loadJobById(jobId);
  const fields = buildGmailAttachFields(event, job, resolvedAt);
  updateJob(jobId, fields);
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
  if (event?.gmailMatch?.ambiguous !== true) throw new Error('Gmail event is not ambiguous');

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
