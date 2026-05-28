import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { scoreAtsMatch } from './ats-utils.mjs';
import { computeOiScore } from './opportunity-intelligence.mjs';
import { normalizeStatus } from './status-utils.mjs';
import { buildWorkflowTimeline, detectWorkflowStaleness, getNextBestAction } from './job-workflow.mjs';
import { getRecruiterTargeting } from './recruiter-targeting.mjs';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function dataDir(env = process.env) {
  return env.CAREER_OPS_DATA_DIR ? path.resolve(env.CAREER_OPS_DATA_DIR) : path.resolve(APP_ROOT, 'data');
}

function configDir(env = process.env) {
  return env.CAREER_OPS_CONFIG_DIR ? path.resolve(env.CAREER_OPS_CONFIG_DIR) : path.resolve(APP_ROOT, 'config');
}

function outputDir(env = process.env) {
  return env.CAREER_OPS_OUTPUT_DIR ? path.resolve(env.CAREER_OPS_OUTPUT_DIR) : path.resolve(APP_ROOT, 'output');
}

function fileStatus(filePath, label) {
  try {
    const stat = fs.statSync(filePath);
    return {
      label,
      path: filePath,
      present: true,
      modifiedAt: stat.mtime.toISOString(),
      sizeBytes: stat.size,
    };
  } catch {
    return {
      label,
      path: filePath,
      present: false,
      modifiedAt: null,
      sizeBytes: 0,
    };
  }
}

function toDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function daysUntil(value, now = new Date()) {
  const date = toDate(value);
  if (!date) return null;
  const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const target = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  return Math.floor((target - start) / MS_PER_DAY);
}

function atsPercent(job) {
  const ats = Number(job?._ats?.score);
  if (Number.isFinite(ats)) return Math.round(ats);
  const score = Number(job?.score);
  return Number.isFinite(score) ? Math.round(score * 20) : null;
}

function aiExperienceMatchPercent(job) {
  const scores = [
    job?.score,
    job?.report?.score,
    job?.generatedDocs?.default?.evaluatorScore,
    ...(Object.values(job?.generatedDocs || {})
      .flatMap(entry => Array.isArray(entry?.history) ? entry.history : [])
      .map(entry => entry?.evaluatorScore)),
  ]
    .map(Number)
    .filter(score => Number.isFinite(score) && score > 0);
  if (!scores.length) return null;
  const strongest = Math.max(...scores);
  return Math.max(0, Math.min(100, Math.round(strongest * 20)));
}

function activeJobs(jobs) {
  return jobs.filter(job => !['rejected', 'archived', 'withdrawn'].includes(normalizeStatus(job?.status)));
}

function generatedResumeVersions(job) {
  const docs = job?.generatedDocs;
  if (!docs || typeof docs !== 'object' || Array.isArray(docs)) return [];
  const versions = [];
  for (const [variant, entry] of Object.entries(docs)) {
    if (!entry || typeof entry !== 'object') continue;
    const history = Array.isArray(entry.history) && entry.history.length
      ? entry.history
      : entry.docxUrl ? [entry] : [];
    for (const item of history) {
      if (!item?.docxUrl) continue;
      versions.push({
        jobId: job.id,
        company: job.company || '',
        title: job.title || '',
        variant,
        strategy: item.strategy || item.variant || entry.strategy || variant,
        generatedAt: item.generatedAt || entry.generatedAt || '',
        evaluatorScore: item.evaluatorScore ?? entry.evaluatorScore ?? null,
        atsScore: item.atsScore ?? entry.atsScore ?? atsPercent(job),
        sourceJobId: item.sourceJobId || entry.sourceJobId || job.id,
        fileName: item.fileName || entry.fileName || item.docxUrl.split('/').filter(Boolean).pop() || 'Resume DOCX',
        docxUrl: item.docxUrl,
        pdfUrl: item.pdfUrl || entry.pdfUrl || null,
      });
    }
  }
  return versions.sort((a, b) => String(b.generatedAt || '').localeCompare(String(a.generatedAt || '')));
}

function createDerivationContext({ now = new Date() } = {}) {
  const resumeVersionsByJob = new Map();
  const contactsByJobs = new WeakMap();

  return {
    now,
    generatedResumeVersions(job) {
      const key = job?.id || job;
      if (!resumeVersionsByJob.has(key)) {
        resumeVersionsByJob.set(key, generatedResumeVersions(job));
      }
      return resumeVersionsByJob.get(key);
    },
    flattenContacts(jobs) {
      if (!contactsByJobs.has(jobs)) {
        contactsByJobs.set(jobs, flattenContacts(jobs, now));
      }
      return contactsByJobs.get(jobs);
    },
  };
}

function latestResumeVersion(job) {
  return generatedResumeVersions(job)[0] || null;
}

function contactDrafts(job, contact) {
  return (Array.isArray(contact?.outreachDrafts) ? contact.outreachDrafts : [])
    .map(draft => ({
      ...draft,
      jobId: job.id,
      company: job.company || contact.company || '',
      title: job.title || '',
      contactName: contact.name || '',
      contactTitle: contact.title || '',
      responseStatus: contact.responseStatus || 'not_contacted',
    }))
    .sort((a, b) => String(b.generatedAt || '').localeCompare(String(a.generatedAt || '')));
}

function mapRecruiterResponseStatus(status) {
  if (status === 'sent') return 'outreach_sent';
  if (status === 'referral_received') return 'responded';
  if (status === 'message_drafted') return 'not_contacted';
  return status || 'not_contacted';
}

function latestAttemptDate(attempts) {
  return (Array.isArray(attempts) ? attempts : [])
    .map(attempt => attempt?.date || '')
    .filter(Boolean)
    .sort()
    .at(-1) || '';
}

function recruiterVirtualContacts(job) {
  const rt = getRecruiterTargeting(job);
  const attempts = Array.isArray(rt.contactAttempts) ? rt.contactAttempts : [];
  const shared = {
    company: job.company || '',
    responseStatus: mapRecruiterResponseStatus(rt.responseStatus),
    followUpDue: rt.followUpDate || '',
    outreachSentAt: latestAttemptDate(attempts),
    updatedAt: latestAttemptDate(attempts) || rt.followUpDate || '',
    contactAttempts: attempts,
    outreachDrafts: rt.suggestedMessage ? [{
      type: 'linkedin_connection',
      text: rt.suggestedMessage,
      generatedAt: latestAttemptDate(attempts) || new Date(0).toISOString(),
      contactId: `recruiter-targeting-${job.id}`,
    }] : [],
    legacySource: 'recruiterTargeting',
  };
  const contacts = [];
  if (rt.recruiterName || rt.recruiterLinkedInUrl || rt.recruiterTitle || rt.suggestedMessage || attempts.length || rt.responseStatus !== 'not_contacted') {
    contacts.push({
      ...shared,
      id: `recruiter-targeting-${job.id}`,
      name: rt.recruiterName || 'Recruiter contact',
      title: rt.recruiterTitle || '',
      linkedinUrl: rt.recruiterLinkedInUrl || '',
      email: '',
      relationshipType: 'recruiter',
    });
  }
  if (rt.hiringManagerName || rt.hiringManagerLinkedInUrl || rt.hiringManagerTitle) {
    contacts.push({
      ...shared,
      id: `hiring-manager-targeting-${job.id}`,
      name: rt.hiringManagerName || 'Hiring manager contact',
      title: rt.hiringManagerTitle || '',
      linkedinUrl: rt.hiringManagerLinkedInUrl || '',
      email: '',
      relationshipType: 'hiring_manager',
    });
  }
  return contacts;
}

function allJobContacts(job) {
  return [
    ...(Array.isArray(job.contacts) ? job.contacts : []),
    ...recruiterVirtualContacts(job),
  ];
}

function normalizeContactKeyPart(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function contactDedupeKey(contact) {
  const company = normalizeContactKeyPart(contact.company || contact.jobCompany);
  const url = String(contact.linkedinUrl || '').toLowerCase().replace(/[/?#]+$/, '');
  if (url) return `${company}|url:${url}`;
  const name = normalizeContactKeyPart(contact.name);
  if (name) return `${company}|name:${name}`;
  return '';
}

function mergeContactRows(existing, next, now = new Date()) {
  const associatedJobIds = [...new Set([
    ...(existing.associatedJobIds || []),
    ...(next.associatedJobIds || []),
  ].filter(Boolean))];
  const followUpDue = [existing.followUpDue, next.followUpDue].filter(Boolean).sort()[0] || '';
  const recentDraft = [existing.recentDraft, next.recentDraft]
    .filter(Boolean)
    .sort((a, b) => String(b.generatedAt || '').localeCompare(String(a.generatedAt || '')))[0] || null;
  const experienceScores = [existing.experienceMatchPct, next.experienceMatchPct]
    .filter(score => Number.isFinite(Number(score)))
    .map(Number);

  return {
    ...existing,
    associatedJobIds,
    relatedJobCount: associatedJobIds.length,
    title: existing.title || next.title || '',
    company: existing.company || next.company || '',
    jobCompany: existing.jobCompany || next.jobCompany || '',
    jobTitle: existing.jobTitle || next.jobTitle || '',
    linkedinUrl: existing.linkedinUrl || next.linkedinUrl || '',
    email: existing.email || next.email || '',
    followUpDue,
    followUpDueInDays: daysUntil(followUpDue, now),
    outreachSentAt: [existing.outreachSentAt, next.outreachSentAt].filter(Boolean).sort().at(-1) || '',
    updatedAt: [existing.updatedAt, next.updatedAt].filter(Boolean).sort().at(-1) || '',
    recentDraft,
    draftCount: (existing.draftCount || 0) + (next.draftCount || 0),
    experienceMatchPct: experienceScores.length ? Math.max(...experienceScores) : null,
    experienceMatchSource: existing.experienceMatchSource || next.experienceMatchSource || '',
  };
}

function flattenContacts(jobs, now = new Date()) {
  const rows = jobs.flatMap(job => {
    const contacts = allJobContacts(job);
    return contacts.map(contact => {
      const drafts = contactDrafts(job, contact);
      return {
        id: contact.id || '',
        jobId: job.id,
        associatedJobIds: [job.id].filter(Boolean),
        name: contact.name || '',
        title: contact.title || '',
        company: contact.company || job.company || '',
        jobCompany: job.company || '',
        jobTitle: job.title || '',
        relationshipType: contact.relationshipType || 'recruiter',
        responseStatus: contact.responseStatus || 'not_contacted',
        linkedinUrl: contact.linkedinUrl || '',
        email: contact.email || '',
        followUpDue: contact.followUpDue || '',
        followUpDueInDays: daysUntil(contact.followUpDue, now),
        outreachSentAt: contact.outreachSentAt || '',
        updatedAt: contact.updatedAt || '',
        recentDraft: drafts[0] || null,
        draftCount: drafts.length,
        legacySource: contact.legacySource || '',
        experienceMatchPct: aiExperienceMatchPercent(job),
        experienceMatchSource: 'ai',
      };
    });
  });

  const deduped = new Map();
  for (const row of rows) {
    const key = contactDedupeKey(row) || `${row.jobId}|${row.id}`;
    const existing = deduped.get(key);
    deduped.set(key, existing ? mergeContactRows(existing, row, now) : {
      ...row,
      relatedJobCount: row.associatedJobIds.length,
    });
  }
  return [...deduped.values()];
}

export function buildJobReadModel(job, { bragDoc = '', context = createDerivationContext() } = {}) {
  if (!job) return null;
  const normalized = {
    ...job,
    status: normalizeStatus(job.status),
  };
  return {
    ...normalized,
    _ats: normalized._ats || (bragDoc ? scoreAtsMatch(normalized, bragDoc) : null),
    _oi: normalized._oi || computeOiScore(normalized),
    _workflow: normalized._workflow || {
      timeline: buildWorkflowTimeline(normalized),
      nextBestAction: getNextBestAction(normalized),
      staleness: detectWorkflowStaleness(normalized),
    },
    contacts: Array.isArray(normalized.contacts) ? normalized.contacts : [],
    generatedDocs: normalized.generatedDocs || {},
    resumeVersions: context.generatedResumeVersions(normalized),
    gmail: {
      lastEmailDate: normalized.last_email_date || null,
      lastEmailSubject: normalized.last_email_subject || '',
      lastEmailSnippet: normalized.last_email_snippet || '',
      ambiguityResolution: normalized.gmailAmbiguityResolution || null,
    },
  };
}

export function buildResumeWorkspace(jobs, {
  resumeRuns = [],
  sourceQuality = null,
  assessJobDescription = null,
  context = createDerivationContext(),
} = {}) {
  const runsByJob = new Map(resumeRuns.map(run => [run.jobId, run]));
  const queue = activeJobs(jobs).map(job => {
    const versions = context.generatedResumeVersions(job);
    const run = runsByJob.get(job.id) || null;
    const nextBestAction = job._workflow?.nextBestAction || getNextBestAction(job);
    let jdAssessment = null;
    if (typeof assessJobDescription === 'function' && (nextBestAction === 'generate_resume' || versions.length === 0)) {
      try { jdAssessment = assessJobDescription(job.id); } catch { jdAssessment = null; }
    }
    const atsScore = atsPercent(job);
    const blockedByWeakJd = jdAssessment ? jdAssessment.usable === false : false;
    return {
      jobId: job.id,
      company: job.company || '',
      title: job.title || '',
      status: normalizeStatus(job.status),
      atsScore,
      evaluatorScore: job.score ?? null,
      nextBestAction,
      resumeStatus: run?.status === 'running'
        ? 'running'
        : blockedByWeakJd
          ? 'blocked'
          : versions.length
            ? 'generated'
            : 'needs_resume',
      generatedCount: versions.length,
      lastGeneratedAt: versions[0]?.generatedAt || null,
      latestVersion: versions[0] || null,
      missingEvidenceCategories: sourceQuality?.categories || sourceQuality?.findings || [],
      jdAssessment,
    };
  }).sort((a, b) => {
    const order = { running: 0, blocked: 1, needs_resume: 2, generated: 3 };
    return (order[a.resumeStatus] ?? 9) - (order[b.resumeStatus] ?? 9)
      || String(b.lastGeneratedAt || '').localeCompare(String(a.lastGeneratedAt || ''))
      || a.company.localeCompare(b.company);
  });

  return {
    queue,
    versions: jobs.flatMap(job => context.generatedResumeVersions(job)),
    activeRuns: resumeRuns,
    sourceQuality,
    filters: ['needs_resume', 'generated', 'running', 'blocked', 'high_ats', 'low_ats'],
  };
}

export function buildOutreachWorkspace(jobs, { now = new Date(), context = createDerivationContext({ now }) } = {}) {
  const contacts = context.flattenContacts(jobs);
  const dueFollowUps = contacts
    .filter(contact => contact.responseStatus === 'follow_up_due' || (contact.followUpDueInDays != null && contact.followUpDueInDays <= 0))
    .sort((a, b) => String(a.followUpDue || '').localeCompare(String(b.followUpDue || '')));
  const dueFollowUpKeys = new Set(dueFollowUps.map(item => `${item.id}|${item.jobId}`));
  const drafts = jobs.flatMap(job => allJobContacts(job).flatMap(contact => contactDrafts(job, contact)));
  const sentOutreach = contacts
    .filter(contact => contact.responseStatus === 'outreach_sent' || contact.outreachSentAt)
    .sort((a, b) => String(b.outreachSentAt || b.updatedAt || '').localeCompare(String(a.outreachSentAt || a.updatedAt || '')));
  const replies = [
    ...contacts.filter(contact => contact.responseStatus === 'responded'),
    ...jobs.filter(job => job.last_email_date).map(job => ({
      id: `gmail-${job.id}`,
      jobId: job.id,
      name: job.last_email_subject || 'Gmail signal',
      company: job.company || '',
      jobCompany: job.company || '',
      jobTitle: job.title || '',
      relationshipType: 'gmail',
      responseStatus: 'responded',
      updatedAt: job.last_email_date,
      lastEmailSubject: job.last_email_subject || '',
      lastEmailSnippet: job.last_email_snippet || '',
    })),
  ].sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));

  return {
    dueFollowUps,
    drafts,
    sentOutreach,
    replies,
    byContact: contacts,
    byCompany: Object.values(contacts.reduce((acc, contact) => {
      const key = contact.company || contact.jobCompany || 'Unknown';
      acc[key] ||= { company: key, contacts: [], draftCount: 0, dueCount: 0 };
      acc[key].contacts.push(contact);
      acc[key].draftCount += contact.draftCount || 0;
      if (dueFollowUpKeys.has(`${contact.id}|${contact.jobId}`)) acc[key].dueCount += 1;
      return acc;
    }, {})).sort((a, b) => a.company.localeCompare(b.company)),
  };
}

export function buildContactsWorkspace(jobs, { now = new Date(), context = createDerivationContext({ now }) } = {}) {
  const contacts = [...context.flattenContacts(jobs)].sort((a, b) =>
    String(a.followUpDue || '9999-99-99').localeCompare(String(b.followUpDue || '9999-99-99'))
    || a.name.localeCompare(b.name)
  );
  return {
    contacts,
    filters: {
      relationshipTypes: [...new Set(contacts.map(contact => contact.relationshipType).filter(Boolean))].sort(),
      responseStatuses: [...new Set(contacts.map(contact => contact.responseStatus).filter(Boolean))].sort(),
    },
  };
}

export function buildAnalyticsSummary(jobs, { now = new Date(), context = createDerivationContext({ now }) } = {}) {
  const active = activeJobs(jobs);
  const contacts = context.flattenContacts(jobs);
  const stageDistribution = jobs.reduce((acc, job) => {
    const status = normalizeStatus(job.status);
    acc[status] = (acc[status] || 0) + 1;
    return acc;
  }, {});
  const scored = active.map(atsPercent).filter(score => score != null);
  const resumeScoreDistribution = {
    high: scored.filter(score => score >= 80).length,
    mid: scored.filter(score => score >= 50 && score < 80).length,
    low: scored.filter(score => score < 50).length,
    unscored: active.length - scored.length,
  };
  const outreachResponseStatus = contacts.reduce((acc, contact) => {
    const status = contact.responseStatus || 'not_contacted';
    acc[status] = (acc[status] || 0) + 1;
    return acc;
  }, {});
  const staleLeads = active.filter(job => job._workflow?.staleness?.staleLead || detectWorkflowStaleness(job).staleLead);
  const followUpDebt = contacts.filter(contact =>
    contact.responseStatus === 'follow_up_due' || (contact.followUpDueInDays != null && contact.followUpDueInDays <= 0)
  );

  return {
    activeOpportunities: active.length,
    stageDistribution,
    conversionCounts: {
      leads: jobs.filter(job => normalizeStatus(job.status) === 'lead').length,
      applied: jobs.filter(job => normalizeStatus(job.status) === 'applied').length,
      interviews: jobs.filter(job => ['recruiter_screen', 'hiring_manager_screen', 'technical_screen', 'onsite'].includes(normalizeStatus(job.status))).length,
      offers: jobs.filter(job => normalizeStatus(job.status) === 'offer').length,
      rejected: jobs.filter(job => normalizeStatus(job.status) === 'rejected').length,
    },
    averageActiveAtsScore: scored.length ? Math.round(scored.reduce((sum, score) => sum + score, 0) / scored.length) : null,
    resumeScoreDistribution,
    followUpDebt: {
      count: followUpDebt.length,
      items: followUpDebt,
    },
    staleLeads: {
      count: staleLeads.length,
      items: staleLeads.map(job => ({
        jobId: job.id,
        company: job.company || '',
        title: job.title || '',
        inactiveForDays: job._workflow?.staleness?.inactiveForDays ?? detectWorkflowStaleness(job).inactiveForDays,
      })),
    },
    outreachResponseStatus,
  };
}

export async function buildSettingsHealth({
  env = process.env,
  healthChecks = [],
  runHealthChecks = null,
} = {}) {
  const dataPath = dataDir(env);
  const configPath = configDir(env);
  const checks = healthChecks.length
    ? healthChecks
    : typeof runHealthChecks === 'function'
      ? await runHealthChecks({ env })
      : [];
  const gmailKeys = ['GMAIL_CLIENT_ID', 'GMAIL_CLIENT_SECRET', 'GMAIL_REFRESH_TOKEN'];
  const presentGmailKeys = gmailKeys.filter(key => Boolean(env[key]));

  return {
    paths: {
      appRoot: APP_ROOT,
      dataDir: dataPath,
      configDir: configPath,
      outputDir: outputDir(env),
      trackerPath: env.CAREER_OPS_TRACKER_PATH ? path.resolve(env.CAREER_OPS_TRACKER_PATH) : path.resolve(dataPath, 'tracker.json'),
    },
    files: [
      fileStatus(path.resolve(configPath, 'profile.yml'), 'Profile config'),
      fileStatus(path.resolve(dataPath, 'tracker.json'), 'Tracker data'),
      fileStatus(path.resolve(dataPath, 'master-brag-document.md'), 'Master brag document'),
      fileStatus(path.resolve(dataPath, 'Profile.pdf'), 'LinkedIn profile PDF'),
      fileStatus(path.resolve(dataPath, 'FINAL Brian Milhizer Production Resume Template v3.dotx'), 'Resume template'),
      fileStatus(path.resolve(APP_ROOT, 'portals.yml'), 'Portal searches'),
    ],
    integrations: {
      gmailOAuth: {
        configured: presentGmailKeys.length === gmailKeys.length,
        presentCount: presentGmailKeys.length,
        missingKeys: gmailKeys.filter(key => !env[key]),
      },
      anthropic: {
        configured: Boolean(env.ANTHROPIC_API_KEY),
      },
      lmStudio: {
        configuredModel: env.LM_STUDIO_ANALYSIS_MODEL || '',
      },
    },
    checks,
  };
}
