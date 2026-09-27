import { findDuplicateJob } from './dedupe-utils.mjs';
import { computeOiScore } from './opportunity-intelligence.mjs';
import { getRecruiterTargeting } from './recruiter-targeting.mjs';
import { normalizeStatus } from './status-utils.mjs';

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const INTERVIEW_STATUSES = new Set(['recruiter_screen', 'hiring_manager_screen', 'technical_screen', 'onsite']);

function clamp(value, min = 0, max = 100) {
  return Math.max(min, Math.min(max, Math.round(value)));
}

function toDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function daysSince(value, now = new Date()) {
  const date = toDate(value);
  if (!date) return null;
  return Math.floor((now.getTime() - date.getTime()) / MS_PER_DAY);
}

function normalizeTextKey(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function titleTokens(value) {
  return new Set(normalizeTextKey(value).split(/\s+/).filter(token => token.length >= 4));
}

function duplicateCandidateJobs(job = {}, others = []) {
  const company = normalizeTextKey(job.company);
  const title = titleTokens(job.title);
  const url = String(job.url || '').toLowerCase();
  return others.filter(candidate => {
    if (!candidate) return false;
    if (url && String(candidate.url || '').toLowerCase() === url) return true;
    const candidateCompany = normalizeTextKey(candidate.company);
    if (company && candidateCompany && company === candidateCompany) return true;
    if (!title.size) return false;
    const candidateTitle = titleTokens(candidate.title);
    let overlap = 0;
    for (const token of title) {
      if (candidateTitle.has(token)) overlap += 1;
      if (overlap >= 2) return true;
    }
    return false;
  }).slice(0, 75);
}

function scoreFromFive(value) {
  const score = Number(value);
  return Number.isFinite(score) && score > 0 ? clamp(score * 20) : null;
}

function atsPercent(job) {
  const ats = Number(job?._ats?.score);
  if (Number.isFinite(ats)) return clamp(ats);
  return scoreFromFive(job?.score);
}

export function computeInterviewFitScore(job = {}) {
  const candidates = [
    scoreFromFive(job.score),
    scoreFromFive(job.report?.score),
    atsPercent(job),
    scoreFromFive(job.generatedDocs?.default?.evaluatorScore),
  ].filter(Number.isFinite);
  return candidates.length ? Math.max(...candidates) : 0;
}

function contactAccessValue(contact = {}) {
  const relation = String(contact.relationshipType || '').toLowerCase();
  const title = String(contact.title || '').toLowerCase();
  let score = 0;
  if (/hiring_manager|hiring manager|vp|vice president|head of|director|chief|ciso|cto|cro|customer success|security/.test(`${relation} ${title}`)) score += 35;
  else if (/recruiter|talent|sourcer/.test(`${relation} ${title}`)) score += 22;
  else if (/employee|alumni|warm|referral|second/.test(relation)) score += 18;
  if (contact.linkedinUrl || contact.email) score += 10;
  if (['responded', 'referral_received'].includes(contact.responseStatus)) score += 25;
  else if (['sent', 'outreach_sent', 'follow_up_due'].includes(contact.responseStatus)) score += 12;
  else if (contact.responseStatus === 'message_drafted') score += 6;
  return score;
}

function contactTitleSeniority(title = '', relationshipType = '') {
  const text = `${title || ''} ${relationshipType || ''}`.toLowerCase();
  if (/chief|ciso|cto|cio|cro|ceo|founder|president|svp|evp/.test(text)) return 35;
  if (/vp|vice president|head of/.test(text)) return 32;
  if (/director|hiring manager/.test(text)) return 28;
  if (/manager|lead|principal/.test(text)) return 20;
  if (/recruiter|talent|sourcer/.test(text)) return 16;
  return 8;
}

function contactRoleRelevance(contact = {}, job = {}) {
  const text = `${contact.title || ''} ${contact.relationshipType || ''}`.toLowerCase();
  const jobText = `${job.title || ''} ${job.full_description || ''} ${job.description_preview || ''}`.toLowerCase();
  let score = 6;
  if (/hiring_manager|hiring manager|customer success|success|csm|account|renewal|post.?sales/.test(`${text} ${jobText}`)) score += 9;
  if (/security|cyber|trust|risk|compliance|soc|siem|iam|ndr/.test(`${text} ${jobText}`)) score += 6;
  if (/recruiter|talent|sourcer/.test(text)) score += 5;
  if (contact.company && job.company && String(contact.company).toLowerCase() === String(job.company).toLowerCase()) score += 5;
  return clamp(score, 0, 25);
}

function contactResponseLikelihood(contact = {}) {
  const status = String(contact.responseStatus || '').toLowerCase();
  let score = 8;
  if (['responded', 'referral_received'].includes(status)) score = 25;
  else if (['follow_up_due', 'outreach_sent', 'sent'].includes(status)) score = 18;
  else if (status === 'message_drafted') score = 13;
  else if (status === 'no_response') score = 6;
  if (contact.email) score += 3;
  if (contact.linkedinUrl) score += 2;
  return clamp(score, 0, 25);
}

function contactWarmPathStrength(contact = {}) {
  const text = `${contact.relationshipType || ''} ${contact.bestConnectionPath || ''} ${contact.notes || ''}`.toLowerCase();
  if (/warm|intro|referral|alumni|former colleague|second.?degree/.test(text)) return 10;
  if (/employee|hiring_manager|hiring manager/.test(text)) return 7;
  if (/recruiter|talent|sourcer/.test(text)) return 5;
  return 2;
}

export function computeContactIntelligence(contact = {}, job = {}) {
  const seniority = contactTitleSeniority(contact.title, contact.relationshipType);
  const relevance = contactRoleRelevance(contact, job);
  const responseLikelihood = contactResponseLikelihood(contact);
  const warmPathStrength = contactWarmPathStrength(contact);
  const influence = /hiring_manager|hiring manager|vp|head of|director|chief|founder|referral/i.test(`${contact.relationshipType || ''} ${contact.title || ''}`)
    ? 5
    : /recruiter|talent|sourcer/i.test(`${contact.relationshipType || ''} ${contact.title || ''}`)
      ? 3
      : 1;
  const score = clamp(seniority + relevance + responseLikelihood + warmPathStrength + influence);
  const reasons = [];
  if (seniority >= 28) reasons.push('senior decision-maker');
  else if (seniority >= 16) reasons.push('credible hiring-channel contact');
  if (relevance >= 18) reasons.push('role-relevant function');
  if (responseLikelihood >= 18) reasons.push('active or likely response path');
  if (warmPathStrength >= 7) reasons.push('warm-path signal');
  if (!contact.email && !contact.linkedinUrl) reasons.push('missing direct contact channel');

  return {
    score,
    seniority,
    relevance,
    responseLikelihood,
    warmPathStrength,
    influence,
    canInfluenceHiring: influence >= 3,
    reasons,
  };
}

export function computeDecisionMakerAccess(job = {}) {
  const rt = getRecruiterTargeting(job);
  const contacts = [
    ...(Array.isArray(job.contacts) ? job.contacts : []),
    rt.recruiterName || rt.recruiterLinkedInUrl ? {
      name: rt.recruiterName,
      title: rt.recruiterTitle || 'Recruiter',
      linkedinUrl: rt.recruiterLinkedInUrl,
      relationshipType: 'recruiter',
      responseStatus: rt.responseStatus,
    } : null,
    rt.hiringManagerName || rt.hiringManagerLinkedInUrl ? {
      name: rt.hiringManagerName,
      title: rt.hiringManagerTitle || 'Hiring Manager',
      linkedinUrl: rt.hiringManagerLinkedInUrl,
      relationshipType: 'hiring_manager',
      responseStatus: rt.responseStatus,
    } : null,
  ].filter(Boolean);

  let score = contacts.reduce((sum, contact) => sum + contactAccessValue(contact), 0);
  const path = String(rt.bestConnectionPath || '').toLowerCase();
  if (/warm|intro|referral|alumni|former colleague|second.?degree/.test(path)) score += 25;
  else if (path) score += 10;

  return {
    score: clamp(score),
    contactCount: contacts.length,
    hasHiringManager: contacts.some(contact => /hiring_manager|hiring manager|vp|head of|director|chief|ciso|cto|cro/i.test(`${contact.relationshipType || ''} ${contact.title || ''}`)),
    hasWarmPath: /warm|intro|referral|alumni|former colleague|second.?degree/.test(path),
  };
}

export function computeStaleDuplicateRisk(job = {}, allJobs = [], { now = new Date() } = {}) {
  const others = (Array.isArray(allJobs) ? allJobs : []).filter(candidate => candidate && candidate !== job && candidate.id !== job.id);
  const duplicate = findDuplicateJob(job, duplicateCandidateJobs(job, others));
  const age = daysSince(job.date_found || job.date_updated, now);
  const updatedAge = daysSince(job.date_updated, now);
  let risk = 0;
  const reasons = [];

  if (duplicate.isDuplicate) {
    risk += 40;
    reasons.push('duplicate-posting');
  } else if (duplicate.isPossibleDuplicate) {
    risk += 20;
    reasons.push('possible-duplicate');
  }
  if (age != null && age >= 60) {
    risk += 30;
    reasons.push('older-than-60-days');
  } else if (age != null && age >= 30) {
    risk += 15;
    reasons.push('older-than-30-days');
  }
  if (updatedAge != null && updatedAge >= 21 && ['lead', 'interested'].includes(normalizeStatus(job.status))) {
    risk += 15;
    reasons.push('stale-lead');
  }
  if (/\brepost(?:ed|ing)?\b|re-listed|relisted/i.test(`${job.title || ''} ${job.description_preview || ''} ${job.notes || ''}`)) {
    risk += 15;
    reasons.push('repost-signal');
  }

  return {
    risk: clamp(risk),
    freshnessScore: clamp(100 - risk),
    reasons,
    duplicate,
    ageDays: age,
  };
}

export function titleFamily(title = '') {
  const text = String(title).toLowerCase();
  if (/sales engineer|solution engineer|solutions architect|pre-sales|presales/.test(text)) return 'pre_sales';
  if (/customer success|csm|account manager|technical account|tam/.test(text)) return 'customer_success';
  if (/director|head|vp|vice president|chief/.test(text)) return 'leadership';
  if (/security|cyber|soc|siem|iam|ndr/.test(text)) return 'security';
  return 'other';
}

function outcomeValue(job = {}) {
  const status = normalizeStatus(job.status);
  if (status === 'offer') return 100;
  if (INTERVIEW_STATUSES.has(status)) return 85;
  if (status === 'applied') return job.last_email_date ? 65 : 50;
  if (status === 'rejected') return 15;
  if (status === 'withdrawn' || status === 'archived') return 20;
  const rt = getRecruiterTargeting(job);
  if (['responded', 'referral_received'].includes(rt.responseStatus)) return 75;
  if (rt.responseStatus === 'no_response') return 25;
  return 40;
}

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

export function buildOutcomeLearningModel(jobs = []) {
  const groups = { source: new Map(), company: new Map(), titleFamily: new Map() };
  for (const job of Array.isArray(jobs) ? jobs : []) {
    const value = outcomeValue(job);
    const entries = [
      [groups.source, job.source || 'unknown'],
      [groups.company, String(job.company || '').toLowerCase()],
      [groups.titleFamily, titleFamily(job.title)],
    ];
    for (const [map, key] of entries) {
      if (!key) continue;
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(value);
    }
  }
  const summarize = map => Object.fromEntries([...map.entries()].map(([key, values]) => [key, {
    count: values.length,
    averageOutcome: Math.round(average(values)),
  }]));
  return {
    source: summarize(groups.source),
    company: summarize(groups.company),
    titleFamily: summarize(groups.titleFamily),
  };
}

export function computeOutcomeLearningScore(job = {}, allJobs = []) {
  const model = buildOutcomeLearningModel(allJobs);
  const candidates = [
    model.company[String(job.company || '').toLowerCase()],
    model.titleFamily[titleFamily(job.title)],
    model.source[job.source || 'unknown'],
  ].filter(entry => entry && entry.count >= 2);
  const avg = average(candidates.map(entry => entry.averageOutcome));
  return {
    score: clamp(avg ?? 50),
    signals: candidates,
  };
}

export function computeJobSearchPriority(job = {}, allJobs = [], { now = new Date() } = {}) {
  const interviewFit = computeInterviewFitScore(job);
  const opportunityQuality = computeOiScore(job).score;
  const access = computeDecisionMakerAccess(job);
  const staleDuplicate = computeStaleDuplicateRisk(job, allJobs, { now });
  const outcomeLearning = computeOutcomeLearningScore(job, allJobs);
  const score = clamp(
    interviewFit * 0.35 +
    opportunityQuality * 0.30 +
    access.score * 0.15 +
    staleDuplicate.freshnessScore * 0.10 +
    outcomeLearning.score * 0.10
  );

  return {
    score,
    rating: score >= 85 ? 'Top Priority' : score >= 70 ? 'Strong' : score >= 55 ? 'Watch' : 'Low Priority',
    explanation: [
      `Interview fit ${interviewFit}%`,
      `Opportunity quality ${opportunityQuality}%`,
      `Decision-maker access ${access.score}%`,
      `Freshness ${staleDuplicate.freshnessScore}%`,
      `Outcome learning ${outcomeLearning.score}%`,
    ],
    missingSignals: [
      interviewFit < 70 ? 'stronger resume/job evidence' : '',
      opportunityQuality < 65 ? 'company quality signals' : '',
      access.score < 45 ? 'senior or warm-path contact' : '',
      staleDuplicate.freshnessScore < 75 ? 'fresh listing confirmation' : '',
      outcomeLearning.signals.length ? '' : 'historical outcome data',
    ].filter(Boolean),
    confidenceAction: access.score < 45
      ? 'Find a senior contact or warm intro before applying.'
      : staleDuplicate.freshnessScore < 75
        ? 'Verify the posting is current, then rescore.'
        : interviewFit < 70
          ? 'Generate a tighter resume version before applying.'
          : 'Move to the next workflow action.',
    dimensions: {
      interviewFit,
      opportunityQuality,
      decisionMakerAccess: access.score,
      freshness: staleDuplicate.freshnessScore,
      outcomeLearning: outcomeLearning.score,
    },
    access,
    staleDuplicate,
    outcomeLearning,
  };
}
