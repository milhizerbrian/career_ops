// Phase 2: Candidate Fit Analysis
//
// Answers "does Brian fit this specific job?" — evidence-backed, deterministic,
// and explicitly distinct from lib/opportunity-intelligence.mjs, which scores
// COMPANY quality ("should Brian want this job?"), not candidate-to-JD fit.
// Also distinct from lib/job-search-scoring.mjs's computeJobSearchPriority
// (a coarser 4-band composite over ATS/contact/staleness signals) — this
// module's 6-band Pursuit Classification is evidence-driven and does not
// replace or feed that existing rating.
//
// Never calls external APIs. Never invents evidence: every Strong/Partial
// match traces to one or more candidate fact IDs from career-evidence/candidate/*.json
// (Phase 0's verified-fact vault). Missing evidence is reported as Unknown,
// never silently treated as a confirmed gap or a confirmed match.
import { loadCandidateFacts, loadCandidateCertifications, loadCandidateEmployers } from './candidate-data.mjs';
import { loadProfile } from './data.mjs';
import { REQUIREMENT_CATALOG, EVIDENCE_ALIASES, DOMAIN_CATALOG } from './resume-gen.mjs';
import { parseJobDescription } from './jd-parser.mjs';
import { containsTerm, containsAnyTerm } from './text-match-utils.mjs';

export const MATCH_TIERS = ['strong_match', 'partial_match', 'unknown', 'gap', 'blocker'];
export const PURSUIT_CLASSIFICATIONS = ['Priority', 'Strong', 'Possible', 'Low Priority', 'Blocked', 'Needs Information'];
export const FRESHNESS_BUCKETS = ['fresh', 'recent', 'aging', 'stale', 'expired'];

const TECHNICAL_KEYWORDS = [
  'architecture', 'siem', 'cloud', 'api', 'security', 'integration', 'data center', 'bom',
  'kubernetes', 'xdr', 'edr', 'iam', 'vulnerability', 'network', 'endpoint', 'identity',
  'telemetry', 'encryption', 'dast', 'sast', 'appsec',
];
const LEADERSHIP_LABELS = new Set(['people management', 'team coaching and development', 'CSM mentorship and ramp', 'team standards and accountability']);

// ── Candidate profile helpers (derived from Phase 0's verified fact vault) ──

/**
 * Total years of professional experience, derived from the earliest start
 * date recorded across career-evidence/candidate/employers.json (verified facts, not
 * an unverified narrative figure). Returns null if no parseable dates.
 */
export function computeCandidateYearsExperience(employers = loadCandidateEmployers(), now = new Date()) {
  const starts = [];
  for (const e of employers) {
    const m = String(e.fact ?? '').match(/([A-Z][a-z]+)\s+(\d{4})\s*[–-]/);
    if (m) {
      const monthIndex = new Date(`${m[1]} 1, 2000`).getMonth();
      if (!Number.isNaN(monthIndex)) starts.push(new Date(Number(m[2]), monthIndex, 1));
    }
  }
  if (!starts.length) return null;
  const earliest = new Date(Math.min(...starts.map(d => d.getTime())));
  return Math.floor((now - earliest) / (365.25 * 24 * 60 * 60 * 1000));
}

function isTechnicalRequirement(label) {
  const catalogEntry = REQUIREMENT_CATALOG.find(r => r.phrase === label);
  const corpus = [label, ...(catalogEntry?.aliases ?? [])].join(' ');
  return containsAnyTerm(corpus, TECHNICAL_KEYWORDS);
}

// ── Evidence matching / 5-tier classification ───────────────────────────

/**
 * Certifications are a closed list (Phase 0 migrated every cert Brian holds
 * from the master brag doc). A required, named certification with zero
 * alias hits against that closed list is a confirmed Gap, not an Unknown —
 * unlike open-ended achievement/skill evidence, where absence of a mention
 * doesn't mean the candidate never did it.
 */
function isClosedListRequirement(label) {
  return /certification|OWASP\/MITRE|LCNC governance/i.test(label);
}

/**
 * Classifies one canonical requirement label (from REQUIREMENT_CATALOG)
 * against the candidate's verified fact vault.
 *
 * @returns {{ tier: string, evidenceIds: string[], reason: string }}
 */
export function classifyRequirement(requirementLabel, candidateFacts = loadCandidateFacts()) {
  const aliasTerms = EVIDENCE_ALIASES[requirementLabel] ?? [requirementLabel];
  const evidenceIds = [];
  for (const fact of candidateFacts) {
    if (containsAnyTerm(fact.fact, aliasTerms)) evidenceIds.push(fact.id);
  }
  const uniqueIds = [...new Set(evidenceIds)];

  if (uniqueIds.length >= 2) {
    return { tier: 'strong_match', evidenceIds: uniqueIds, reason: `${uniqueIds.length} verified facts support this.` };
  }
  if (uniqueIds.length === 1) {
    return { tier: 'partial_match', evidenceIds: uniqueIds, reason: '1 verified fact partially supports this.' };
  }
  if (isClosedListRequirement(requirementLabel)) {
    return { tier: 'gap', evidenceIds: [], reason: 'No matching record in Brian\'s certification list (a complete list, so absence is confirmed, not unknown).' };
  }
  return { tier: 'unknown', evidenceIds: [], reason: 'No verified evidence found. Not confirmed as a gap — may simply be undocumented. Needs confirmation.' };
}

/**
 * Classifies every distinct requirement label surfaced by the JD parser
 * (required + preferred + skills), each tagged with its source category.
 */
export function classifyAllRequirements(parsedJd, candidateFacts = loadCandidateFacts()) {
  const labelSources = new Map(); // label -> Set of categories it appeared in
  const record = (labels, category) => {
    for (const label of labels) {
      if (!labelSources.has(label)) labelSources.set(label, new Set());
      labelSources.get(label).add(category);
    }
  };
  for (const r of parsedJd.required) record(r.requirementLabels, 'required');
  for (const r of parsedJd.preferred) record(r.requirementLabels, 'preferred');
  record(parsedJd.skills, 'skills');

  return [...labelSources.entries()].map(([label, categories]) => ({
    label,
    categories: [...categories],
    ...classifyRequirement(label, candidateFacts),
  }));
}

// ── Hard blocker detection ──────────────────────────────────────────────

/**
 * Hard blockers use config/profile.yml's deal_breakers / compensation
 * section — Brian's own stated job-search filters, not the candidate
 * evidence vault (Phase 0 deliberately kept these separate: they're
 * preferences, not resume claims). Flagged for Brian to confirm in the
 * Phase 2 completion report, since this is the first place Phase 2 code
 * reads that config directly.
 */
export function detectHardBlockers(parsedJd, { profile = safeLoadProfile(), certifications = loadCandidateCertifications() } = {}) {
  const blockers = [];
  const comp = profile?.compensation;
  const dealBreakers = profile?.deal_breakers ?? [];

  if (comp?.minimum && parsedJd.compensation.max != null) {
    const minRequired = parseDollarAmount(comp.minimum);
    if (minRequired != null && parsedJd.compensation.max < minRequired) {
      blockers.push({ type: 'compensation_floor', description: `JD's compensation ceiling ($${parsedJd.compensation.max.toLocaleString()}) is below Brian's stated minimum (${comp.minimum}).` });
    }
  }

  const locationFlex = String(comp?.location_flexibility ?? '');
  if (parsedJd.location.type === 'onsite' && !/dfw|dallas/i.test(parsedJd.location.detail ?? '')) {
    blockers.push({ type: 'location_incompatible', description: `JD requires on-site work outside DFW; Brian's stated flexibility is "${locationFlex || 'remote or DFW-based'}".` });
  }
  if (parsedJd.location.relocationRequired) {
    blockers.push({ type: 'relocation_required', description: 'JD explicitly requires relocation.' });
  }

  if (containsAnyTerm(dealBreakers.join(' '), ['pure sales', 'ae/quota-carrying']) && /\bquota[- ]carrying account executive\b|\bpure sales role\b/i.test(parsedJd.required.map(r => r.text).join(' '))) {
    blockers.push({ type: 'role_type_excluded', description: 'JD reads as a quota-carrying sales (AE) role, excluded by Brian\'s stated deal-breakers.' });
  }

  for (const cert of parsedJd.educationCertifications) {
    if (cert.type === 'certification' && cert.required) {
      const held = certifications.some(c => containsTerm(c.fact, cert.value));
      if (!held) blockers.push({ type: 'missing_required_certification', description: `JD requires ${cert.value}, not found in Brian's certification list.` });
    }
  }

  return blockers;
}

function safeLoadProfile() {
  try { return loadProfile(); } catch { return null; }
}

/** Parses a dollar figure like "$165K" or "$165,000" into a plain number. */
function parseDollarAmount(value) {
  if (value == null) return null;
  const s = String(value);
  const kMatch = s.match(/(\d+(?:\.\d+)?)\s*[kK]\b/);
  if (kMatch) return Math.round(Number(kMatch[1]) * 1000);
  const plain = s.replace(/[^0-9.]/g, '');
  return plain ? Number(plain) : null;
}

// ── Freshness ────────────────────────────────────────────────────────────

/**
 * 5 buckets by posting age. If no posted date is available at all, returns
 * bucket: null (not one of the 5 buckets — freshness is simply unknown and
 * is excluded from the freshness component's penalty, per the rule that
 * missing data must never be scored as a confirmed negative).
 */
export function classifyFreshness(job = {}, now = new Date()) {
  const dateStr = job.postedDate || job.date_found;
  if (!dateStr) return { bucket: null, ageDays: null };
  const posted = new Date(dateStr);
  if (Number.isNaN(posted.getTime())) return { bucket: null, ageDays: null };
  const ageDays = Math.floor((now - posted) / (24 * 60 * 60 * 1000));
  let bucket;
  if (ageDays <= 3) bucket = 'fresh';
  else if (ageDays <= 14) bucket = 'recent';
  else if (ageDays <= 30) bucket = 'aging';
  else if (ageDays <= 60) bucket = 'stale';
  else bucket = 'expired';
  return { bucket, ageDays };
}

const FRESHNESS_SCORES = { fresh: 100, recent: 85, aging: 60, stale: 30, expired: 10 };

// ── Component scoring ───────────────────────────────────────────────────

function tierWeight(tier) {
  return { strong_match: 1, partial_match: 0.5, unknown: 0.25, gap: 0, blocker: 0 }[tier] ?? 0;
}

function weightedAvg(classifications) {
  if (!classifications.length) return null;
  const sum = classifications.reduce((acc, c) => acc + tierWeight(c.tier), 0);
  return Math.round((sum / classifications.length) * 100);
}

const COMPONENT_WEIGHTS = {
  experience: 15, skills: 15, seniority: 10, domain: 15, leadership: 5,
  technical: 10, location: 10, compensation: 10, freshness: 5, evidenceQuality: 5,
};

export function computeComponentScores(parsedJd, classifications, job, candidateFacts = loadCandidateFacts(), profile = safeLoadProfile()) {
  const requiredOnly = classifications.filter(c => c.categories.includes('required') && !isTechnicalRequirement(c.label) && !LEADERSHIP_LABELS.has(c.label));
  const skillsOnly = classifications.filter(c => c.categories.includes('skills') && !isTechnicalRequirement(c.label) && !LEADERSHIP_LABELS.has(c.label));
  const technicalOnly = classifications.filter(c => isTechnicalRequirement(c.label));
  const leadershipOnly = classifications.filter(c => LEADERSHIP_LABELS.has(c.label));

  const experience = weightedAvg(requiredOnly) ?? 50;
  const skills = weightedAvg(skillsOnly) ?? weightedAvg(classifications) ?? 50;
  const technical = technicalOnly.length ? weightedAvg(technicalOnly) : 100;
  const leadership = parsedJd.leadership.required ? (weightedAvg(leadershipOnly) ?? 25) : 100;

  const candidateYears = computeCandidateYearsExperience();
  let seniority = 60; // neutral default when JD gives no signal
  if (parsedJd.seniority.minYearsRequired != null && candidateYears != null) {
    const gap = candidateYears - parsedJd.seniority.minYearsRequired;
    seniority = gap >= 0 ? 100 : gap >= -2 ? 70 : 30;
  }

  const jdDomains = parsedJd.domain;
  let domain = 60; // neutral default when JD names no specific security domain
  if (jdDomains.length) {
    const matchedDomains = jdDomains.filter(d => {
      const catalogEntry = require_domain_aliases(d);
      return containsAnyTerm(candidateFacts.map(f => f.fact).join(' | '), catalogEntry);
    });
    domain = Math.round((matchedDomains.length / jdDomains.length) * 100);
  }

  let location = 60;
  if (parsedJd.location.type) {
    location = parsedJd.location.type === 'onsite' ? 20 : 100;
  }

  let compensation = 60;
  if (parsedJd.compensation.max != null) {
    const minRequired = parseDollarAmount(profile?.compensation?.minimum);
    compensation = minRequired != null ? (parsedJd.compensation.max >= minRequired ? 100 : 0) : 60;
  }

  const freshnessInfo = classifyFreshness(job);
  const freshness = freshnessInfo.bucket ? FRESHNESS_SCORES[freshnessInfo.bucket] : 70;

  const withEvidenceAttempt = classifications.filter(c => c.tier !== 'blocker');
  const evidenceQuality = withEvidenceAttempt.length
    ? Math.round((withEvidenceAttempt.filter(c => c.evidenceIds.length > 0).length / withEvidenceAttempt.length) * 100)
    : 50;

  const components = { experience, skills, seniority, domain, leadership, technical, location, compensation, freshness, evidenceQuality };
  const overallScore = Math.round(
    Object.entries(components).reduce((sum, [key, val]) => sum + val * (COMPONENT_WEIGHTS[key] / 100), 0)
  );

  return { components, overallScore, freshnessBucket: freshnessInfo.bucket, freshnessAgeDays: freshnessInfo.ageDays };
}

function require_domain_aliases(domainName) {
  return DOMAIN_CATALOG.find(d => d.domain === domainName)?.aliases ?? [domainName];
}

// ── Confidence ───────────────────────────────────────────────────────────

export function computeConfidence(classifications, parsedJd) {
  const nonBlocker = classifications.filter(c => c.tier !== 'blocker');
  const unknownRatio = nonBlocker.length ? nonBlocker.filter(c => c.tier === 'unknown').length / nonBlocker.length : 1;
  const coreCategoriesKnown = [
    parsedJd.seniority.level != null || parsedJd.seniority.minYearsRequired != null,
    parsedJd.domain.length > 0,
    parsedJd.location.type != null,
    parsedJd.compensation.max != null,
  ].filter(Boolean).length;

  if (unknownRatio < 0.15 && coreCategoriesKnown >= 3) {
    return { level: 'High', reason: 'Most requirements resolved to verified evidence, and core categories (seniority, domain, location, compensation) are known from the JD.' };
  }
  if (unknownRatio <= 0.4) {
    return { level: 'Medium', reason: `${Math.round(unknownRatio * 100)}% of requirements are unresolved (no evidence either way) or the JD is missing some core details.` };
  }
  return { level: 'Low', reason: `${Math.round(unknownRatio * 100)}% of requirements are unresolved, or the JD lacks enough detail on seniority/domain/location/compensation to be confident.` };
}

// ── Pursuit classification ──────────────────────────────────────────────

export function classifyPursuit({ overallScore, blockers, confidence, classifications }) {
  if (blockers.length > 0) return 'Blocked';
  const unknownCount = classifications.filter(c => c.tier === 'unknown').length;
  if (confidence.level === 'Low' && unknownCount >= 3) return 'Needs Information';
  if (overallScore >= 85) return 'Priority';
  if (overallScore >= 70) return 'Strong';
  if (overallScore >= 50) return 'Possible';
  return 'Low Priority';
}

// ── Explainable summary ──────────────────────────────────────────────────

export function buildExplainableSummary({ classifications, blockers, freshnessBucket }) {
  const whyYouFit = classifications
    .filter(c => c.tier === 'strong_match')
    .slice(0, 6)
    .map(c => `${c.label} (evidence: ${c.evidenceIds.join(', ')})`);
  const concerns = classifications
    .filter(c => c.tier === 'partial_match')
    .slice(0, 6)
    .map(c => `${c.label} — only partial evidence (${c.evidenceIds.join(', ')})`);
  const unknowns = classifications
    .filter(c => c.tier === 'unknown')
    .slice(0, 6)
    .map(c => c.label);
  const blockerLines = blockers.map(b => b.description);

  return {
    whyYouFit: whyYouFit.length ? whyYouFit : ['No strong matches identified yet — see unknowns below.'],
    concerns,
    unknowns,
    blockers: blockerLines,
  };
}

// ── Main orchestrator ────────────────────────────────────────────────────

export function analyzeFit(job, jdText, { candidateFacts = loadCandidateFacts(), profile = safeLoadProfile(), certifications = loadCandidateCertifications() } = {}) {
  const parsedJd = parseJobDescription(jdText, job);
  const classifications = classifyAllRequirements(parsedJd, candidateFacts);
  const blockers = detectHardBlockers(parsedJd, { profile, certifications });
  const { components, overallScore, freshnessBucket, freshnessAgeDays } = computeComponentScores(parsedJd, classifications, job, candidateFacts, profile);
  const confidence = computeConfidence(classifications, parsedJd);
  const pursuitClassification = classifyPursuit({ overallScore, blockers, confidence, classifications });
  const summary = buildExplainableSummary({ classifications, blockers, freshnessBucket });

  return {
    parsedJd,
    classifications,
    componentScores: components,
    overallScore,
    confidence,
    hardBlockers: blockers,
    freshnessBucket,
    freshnessAgeDays,
    pursuitClassification,
    summary,
  };
}
