import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { scoreAtsMatch } from './ats-utils.mjs';
import { computeOiScore } from './opportunity-intelligence.mjs';
import {
  buildOutcomeLearningModel,
  computeContactIntelligence,
  computeJobSearchPriority,
  computeStaleDuplicateRisk,
} from './job-search-scoring.mjs';
import { normalizeStatus } from './status-utils.mjs';
import { buildWorkflowTimeline, detectCurrentWorkflowStaleness, filterActivityForDisplay, getCurrentNextBestAction, isDailyActionable } from './job-workflow.mjs';
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

function daysSince(value, now = new Date()) {
  const date = toDate(value);
  if (!date) return null;
  return Math.floor((now.getTime() - date.getTime()) / MS_PER_DAY);
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
  const influenceScores = [existing.influenceScore, next.influenceScore]
    .filter(score => Number.isFinite(Number(score)))
    .map(Number);
  const strongestContactIntelligence = [existing.contactIntelligence, next.contactIntelligence]
    .filter(Boolean)
    .sort((a, b) => (b.score || 0) - (a.score || 0))[0] || null;

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
    influenceScore: influenceScores.length ? Math.max(...influenceScores) : null,
    contactIntelligence: strongestContactIntelligence,
  };
}

function flattenContacts(jobs, now = new Date()) {
  const rows = jobs.flatMap(job => {
    const contacts = allJobContacts(job);
    return contacts.map(contact => {
      const drafts = contactDrafts(job, contact);
      const contactIntelligence = computeContactIntelligence(contact, job);
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
        influenceScore: contactIntelligence.score,
        contactIntelligence,
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

function listFromValue(value) {
  if (Array.isArray(value)) return value.filter(Boolean).map(item => String(item));
  if (!value) return [];
  return String(value).split(/\n|;|,/).map(item => item.trim()).filter(Boolean);
}

function firstDefined(...values) {
  return values.find(value => value !== undefined && value !== null && value !== '');
}

function companyResearchSource(job = {}) {
  return job.companyResearch
    || job.company_research
    || job.companyResearchEnrichment
    || job.company_research_enrichment
    || job.report?.company_research
    || {};
}

function textCorpus(job = {}) {
  return [
    job.full_description,
    job.description_preview,
    job.notes,
    job.score_analysis,
    job.report?.role_summary,
    job.report?.legitimacy_check,
  ].filter(Boolean).join('\n');
}

function inferCompanyResearch(job = {}) {
  const text = textCorpus(job).toLowerCase();
  return {
    funding: /series [abcde]|venture|funding|raised/.test(text) ? 'Funding signal found in job context' : '',
    layoffs: /layoff|restructur|reduction in force|rif/.test(text) ? 'Layoff or restructuring signal found' : '',
    leadership: /new ceo|new cro|new cto|leadership|appointed|joins as/.test(text) ? 'Leadership-change signal found' : '',
    productCategory: /security|cyber|siem|iam|ndr|customer success|saas|platform/.test(text) ? 'Product/category signal found' : '',
    customers: /fortune 500|enterprise customers|customers include|gartner|forrester|case stud/.test(text) ? 'Customer traction signal found' : '',
    competitors: /competitor|competes with|alternative to/.test(text) ? 'Competitor signal found' : '',
    recentNews: /announced|launched|news|press release|recently/.test(text) ? ['Recent-news signal found in job context'] : [],
  };
}

function buildCompanyResearchSummary(job = {}) {
  const source = companyResearchSource(job);
  const inferred = inferCompanyResearch(job);
  const row = {
    jobId: job.id,
    company: job.company || '',
    funding: firstDefined(source.funding, source.fundingStage, source.funding_stage, inferred.funding, ''),
    layoffs: firstDefined(source.layoffs, source.layoffRisk, source.layoff_risk, inferred.layoffs, ''),
    leadership: firstDefined(source.leadership, source.leadershipChanges, source.leadership_changes, inferred.leadership, ''),
    productCategory: firstDefined(source.productCategory, source.product_category, source.category, inferred.productCategory, ''),
    customers: listFromValue(firstDefined(source.customers, source.customerTraction, source.customer_traction, inferred.customers, '')),
    competitors: listFromValue(firstDefined(source.competitors, inferred.competitors, '')),
    recentNews: listFromValue(firstDefined(source.recentNews, source.recent_news, source.news, inferred.recentNews, [])),
  };
  const signalKeys = ['funding', 'layoffs', 'leadership', 'productCategory', 'customers', 'competitors', 'recentNews'];
  const presentCount = signalKeys.filter(key => Array.isArray(row[key]) ? row[key].length : Boolean(row[key])).length;
  return {
    ...row,
    confidence: Math.round((presentCount / signalKeys.length) * 100),
    missingSignals: signalKeys
      .filter(key => Array.isArray(row[key]) ? !row[key].length : !row[key])
      .map(key => key === 'productCategory' ? 'product category' : key),
  };
}

function buildCompanyResearchRows(jobs = []) {
  const byCompany = new Map();
  for (const job of jobs) {
    if (!job?.company) continue;
    const row = buildCompanyResearchSummary(job);
    const key = String(row.company).toLowerCase();
    const existing = byCompany.get(key);
    if (!existing || row.confidence > existing.confidence) byCompany.set(key, row);
  }
  return [...byCompany.values()].sort((a, b) => b.confidence - a.confidence || a.company.localeCompare(b.company));
}

function resumeReadiness(job = {}) {
  const versions = generatedResumeVersions(job);
  const ats = atsPercent(job);
  if (versions.length && (ats == null || ats >= 75)) return { score: 100, label: 'Resume ready' };
  if (versions.length) return { score: 75, label: 'Resume exists; improve evidence' };
  if (ats != null && ats >= 80) return { score: 70, label: 'Strong fit; generate resume' };
  return { score: 35, label: 'Needs resume strategy' };
}

function outreachReadiness(job = {}) {
  const contacts = allJobContacts(job);
  const best = contacts
    .map(contact => computeContactIntelligence(contact, job).score)
    .sort((a, b) => b - a)[0] || 0;
  const hasResponse = contacts.some(contact => ['responded', 'referral_received'].includes(contact.responseStatus));
  const hasFollowUp = contacts.some(contact => contact.responseStatus === 'follow_up_due' || contact.followUpDue);
  return {
    score: hasResponse ? 100 : Math.max(best, hasFollowUp ? 60 : 0),
    label: hasResponse ? 'Response path active' : hasFollowUp ? 'Follow-up due' : contacts.length ? 'Contact path available' : 'No contact path',
  };
}

function scoreExplanationForJob(job = {}, active = [job], now = new Date()) {
  const search = job._search || computeJobSearchPriority(job, active, { now });
  const ats = atsPercent(job);
  const oi = job._oi || computeOiScore(job);
  return {
    ats: {
      score: ats,
      explanation: [
        ats == null ? 'No resume fit score is available yet.' : `ATS/readiness score is ${ats}%.`,
        generatedResumeVersions(job).length ? 'Generated resume versions are available.' : 'No generated resume version is saved yet.',
      ],
      missingSignals: ats == null ? ['evaluated resume score'] : [],
      action: ats == null || ats < 75 ? 'Generate or revise the resume for this role.' : 'Use this score to prioritize application timing.',
    },
    oi: {
      score: oi.score,
      explanation: oi.reasons || [],
      missingSignals: oi.missingSignals || [],
      action: oi.score < 65 ? 'Enrich company quality signals before prioritizing.' : 'Company quality is strong enough to proceed.',
    },
    search: {
      score: search.score,
      explanation: search.explanation || [],
      missingSignals: search.missingSignals || [],
      action: search.confidenceAction || 'Move to the next workflow action.',
    },
  };
}

function buildWhyThisRoleBrief(job = {}, active = [job], now = new Date()) {
  const explanations = scoreExplanationForJob(job, active, now);
  const table = Array.isArray(job.report?.cv_match_table) ? job.report.cv_match_table : [];
  const strongestStories = table
    .filter(row => /strong/i.test(row?.strength || '') && row.evidence)
    .slice(0, 3)
    .map(row => row.evidence);
  const gaps = Array.isArray(job.report?.gaps) ? job.report.gaps.slice(0, 4) : [];
  const companyResearch = buildCompanyResearchSummary(job);
  const access = outreachReadiness(job);
  return {
    fitThesis: job.report?.role_summary
      || `${job.company || 'This company'} needs ${job.title || 'this role'} coverage; current fit is ${explanations.search.score}%.`,
    likelyObjections: gaps.length ? gaps : explanations.search.missingSignals.slice(0, 3),
    strongestStories,
    gaps,
    questionsToAsk: [
      companyResearch.productCategory ? `How is ${companyResearch.productCategory} differentiated against current competitors?` : 'What product category and buyer problem matters most for this role?',
      companyResearch.customers.length ? 'Which customer segment is the priority for the next two quarters?' : 'What customer proof would make a candidate most credible here?',
      'What would make the first 90 days successful?',
    ],
    outreachAngle: access.score >= 60
      ? `${access.label}; lead with the strongest customer-impact story.`
      : 'Build a warmer path before applying or following up.',
  };
}

function cleanupRecommendation(item) {
  if (item.expiredLink) return 'archive_or_refresh_link';
  if (item.noResponseApplication) return 'follow_up';
  if (item.duplicateRisk >= 60) return 'archive_duplicate';
  if (item.duplicateRisk >= 35) return 'rescore';
  if (item.staleLead) return 'rescore_or_archive';
  return 'review';
}

function actionable(job) {
  return job._workflow?.actionable ?? isDailyActionable(job);
}

function buildStaleCleanup(jobs = [], now = new Date(), staleRiskByJobId = new Map()) {
  return jobs.filter(actionable).flatMap(job => {
    const status = normalizeStatus(job.status);
    const stale = job._workflow?.staleness || detectCurrentWorkflowStaleness(job);
    const risk = staleRiskByJobId.get(job.id) || computeStaleDuplicateRisk(job, jobs, { now });
    const linkState = `${job.urlStatus || ''} ${job.linkStatus || ''} ${job.httpStatus || ''} ${job.fetchError || ''}`.toLowerCase();
    const expiredLink = /expired|404|410|not found|closed/.test(linkState);
    const noResponseApplication = status === 'applied' && (stale.needsAppliedFollowUp || daysSince(job.date_updated, now) >= 14) && !job.last_email_date;
    const staleLead = Boolean(stale.staleLead);
    if (!expiredLink && !noResponseApplication && !staleLead && risk.risk < 35) return [];
    const item = {
      jobId: job.id,
      company: job.company || '',
      title: job.title || '',
      status,
      duplicateRisk: risk.risk,
      ageDays: risk.ageDays,
      staleLead,
      expiredLink,
      noResponseApplication,
      reasons: [
        ...risk.reasons,
        expiredLink ? 'expired-link' : '',
        noResponseApplication ? 'no-response-application' : '',
        staleLead ? 'stale-lead' : '',
      ].filter(Boolean),
    };
    return [{ ...item, recommendedAction: cleanupRecommendation(item) }];
  }).sort((a, b) => b.duplicateRisk - a.duplicateRisk || (b.ageDays || 0) - (a.ageDays || 0));
}

function buildUnifiedPriorityQueue(jobs = [], now = new Date(), { searchByJobId = new Map(), staleRiskByJobId = new Map() } = {}) {
  const active = activeJobs(jobs);
  return active.filter(actionable).map(job => {
    const search = searchByJobId.get(job.id) || job._search || computeJobSearchPriority(job, active, { now });
    const resume = resumeReadiness(job);
    const outreach = outreachReadiness(job);
    const stale = staleRiskByJobId.get(job.id) || computeStaleDuplicateRisk(job, active, { now });
    const workflow = job._workflow || {
      nextBestAction: getCurrentNextBestAction(job),
      staleness: detectCurrentWorkflowStaleness(job),
    };
    const score = Math.round(search.score * 0.50 + resume.score * 0.20 + outreach.score * 0.15 + stale.freshnessScore * 0.15);
    return {
      jobId: job.id,
      company: job.company || '',
      title: job.title || '',
      status: normalizeStatus(job.status),
      score,
      searchScore: search.score,
      resumeReadiness: resume,
      outreachStatus: outreach,
      freshnessScore: stale.freshnessScore,
      nextBestAction: workflow.nextBestAction,
      stale: workflow.staleness || {},
      explanation: [
        `Search priority ${search.score}%`,
        `${resume.label} (${resume.score}%)`,
        `${outreach.label} (${outreach.score}%)`,
        `Freshness ${stale.freshnessScore}%`,
      ],
      missingSignals: search.missingSignals || [],
      recommendedAction: workflow.nextBestAction || search.confidenceAction || 'review',
    };
  }).sort((a, b) => b.score - a.score || a.company.localeCompare(b.company));
}

function buildResumeFeedback(jobs = [], now = new Date()) {
  const strategies = new Map();
  for (const job of jobs) {
    const versions = generatedResumeVersions(job);
    if (!versions.length) continue;
    const status = normalizeStatus(job.status);
    const hadReply = Boolean(job.last_email_date) || ['recruiter_screen', 'hiring_manager_screen', 'technical_screen', 'onsite', 'offer'].includes(status);
    const ghosted = status === 'applied' && !job.last_email_date && daysSince(job.date_updated, now) >= 14;
    for (const version of versions) {
      const key = version.strategy || version.variant || 'default';
      if (!strategies.has(key)) {
        strategies.set(key, { strategy: key, applications: 0, replies: 0, interviews: 0, rejections: 0, ghosting: 0, jobs: [] });
      }
      const row = strategies.get(key);
      row.applications += 1;
      if (hadReply) row.replies += 1;
      if (['recruiter_screen', 'hiring_manager_screen', 'technical_screen', 'onsite', 'offer'].includes(status)) row.interviews += 1;
      if (status === 'rejected') row.rejections += 1;
      if (ghosted) row.ghosting += 1;
      row.jobs.push({ jobId: job.id, company: job.company || '', title: job.title || '', status });
    }
  }
  return [...strategies.values()]
    .map(row => ({
      ...row,
      replyRate: row.applications ? Math.round((row.replies / row.applications) * 100) : 0,
      interviewRate: row.applications ? Math.round((row.interviews / row.applications) * 100) : 0,
    }))
    .sort((a, b) => b.interviewRate - a.interviewRate || b.replyRate - a.replyRate || b.applications - a.applications);
}

function buildDailyDigest(jobs = [], now = new Date(), { queue = null, cleanup = null, contacts = null } = {}) {
  const digestQueue = queue || buildUnifiedPriorityQueue(jobs, now);
  const digestCleanup = cleanup || buildStaleCleanup(jobs, now);
  const digestContacts = contacts || flattenContacts(jobs, now);
  return {
    topJobsToApply: digestQueue.filter(item => ['generate_resume', 'apply', 'send_outreach'].includes(item.nextBestAction)).slice(0, 5),
    followUpsDue: digestContacts
      .filter(contact => contact.responseStatus === 'follow_up_due' || (contact.followUpDueInDays != null && contact.followUpDueInDays <= 0))
      .slice(0, 5),
    staleLeadsToClean: digestCleanup.slice(0, 5),
    highPriorityNewRoles: digestQueue
      .filter(item => item.score >= 70)
      .filter(item => daysSince(jobs.find(job => job.id === item.jobId)?.date_found, now) != null && daysSince(jobs.find(job => job.id === item.jobId)?.date_found, now) <= 7)
      .slice(0, 5),
    interviewsToPrep: jobs
      .filter(job => ['recruiter_screen', 'hiring_manager_screen', 'technical_screen', 'onsite'].includes(normalizeStatus(job.status)))
      .filter(job => isDailyActionable(job))
      .map(job => ({ jobId: job.id, company: job.company || '', title: job.title || '', brief: buildWhyThisRoleBrief(job, activeJobs(jobs), now) }))
      .slice(0, 5),
  };
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
    _search: normalized._search || computeJobSearchPriority(normalized, [normalized], { now: context.now }),
    _scoreExplanations: normalized._scoreExplanations || scoreExplanationForJob(normalized, [normalized], context.now),
    _companyResearch: normalized._companyResearch || buildCompanyResearchSummary(normalized),
    _brief: normalized._brief || buildWhyThisRoleBrief(normalized, [normalized], context.now),
    _workflow: normalized._workflow || {
      timeline: filterActivityForDisplay(buildWorkflowTimeline(normalized)),
      nextBestAction: getCurrentNextBestAction(normalized),
      staleness: detectCurrentWorkflowStaleness(normalized),
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
    const nextBestAction = job._workflow ? job._workflow.nextBestAction : getCurrentNextBestAction(job);
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
  const staleLeads = active.filter(job => job._workflow?.staleness?.staleLead || detectCurrentWorkflowStaleness(job).staleLead);
  const followUpDebt = contacts.filter(contact =>
    contact.responseStatus === 'follow_up_due' || (contact.followUpDueInDays != null && contact.followUpDueInDays <= 0)
  );
  const searchEntries = active
    .map(job => ({
      jobId: job.id,
      company: job.company || '',
      title: job.title || '',
      status: normalizeStatus(job.status),
      search: computeJobSearchPriority(job, active, { now }),
    }));
  const searchByJobId = new Map(searchEntries.map(entry => [entry.jobId, entry.search]));
  const staleRiskByJobId = new Map(searchEntries.map(entry => [entry.jobId, entry.search.staleDuplicate]));
  const searchPriorities = [...searchEntries]
    .sort((a, b) => b.search.score - a.search.score)
    .slice(0, 10);
  const priorityQueue = buildUnifiedPriorityQueue(jobs, now, { searchByJobId, staleRiskByJobId });
  const staleCleanup = buildStaleCleanup(active, now, staleRiskByJobId);
  const dailyDigest = buildDailyDigest(jobs, now, { queue: priorityQueue, cleanup: staleCleanup, contacts });
  const companyResearch = buildCompanyResearchRows(jobs);
  const resumeFeedback = buildResumeFeedback(jobs, now);

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
        inactiveForDays: job._workflow?.staleness?.inactiveForDays ?? detectCurrentWorkflowStaleness(job).inactiveForDays,
      })),
    },
    outreachResponseStatus,
    searchScoring: {
      topPriorities: searchPriorities,
      outcomeLearning: buildOutcomeLearningModel(jobs),
    },
    commandCenter: {
      priorityQueue,
      dailyDigest,
      staleCleanup,
      companyResearch,
      resumeFeedback,
    },
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
