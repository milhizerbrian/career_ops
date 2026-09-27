// Phase 2: JD Parsing
//
// Splits a raw job-description text into categorized requirement data:
// required / preferred / responsibilities / skills / seniority / leadership /
// domain / educationCertifications / location / compensation.
//
// Deterministic, regex/keyword-based. Reuses the existing curated
// REQUIREMENT_CATALOG / DOMAIN_CATALOG / GENERIC_KEYWORD_REQUIREMENTS built
// for resume tailoring (lib/resume-gen.mjs) so Brian's domain vocabulary
// stays in one place. Never calls external APIs, never invents data not
// present in the JD text or the job record passed in.
import {
  REQUIREMENT_CATALOG,
  DOMAIN_CATALOG,
} from './resume-gen.mjs';
import { containsTerm, containsAnyTerm } from './text-match-utils.mjs';

// ── Section splitting ────────────────────────────────────────────────────

const SECTION_MARKERS = [
  { key: 'responsibilities', pattern: /what you.?ll do|what you will do|the role|key responsibilities|responsibilities include|day.to.day/i },
  { key: 'required', pattern: /how to be successful|minimum qualifications|basic qualifications|what you.?ll need|what you bring|who you are|requirements|qualifications/i },
  { key: 'preferred', pattern: /nice to have|preferred qualifications|preferred requirements|bonus points|it.?s a plus/i },
  { key: 'benefits', pattern: /what you can expect|benefits|compensation and benefits|perks|why join|about (the company|us|vanta|drata|this role)/i },
];

/**
 * Real-world JDs pulled into tracker.json are frequently a single flattened
 * paragraph (bullet markers stripped by the scraper). We split on known
 * section-header phrases first, then split each section into sentence-like
 * units on a capital-letter boundary. This is a heuristic, not a full
 * parser — it will occasionally mis-split a sentence, but it never invents
 * requirement text that isn't in the source.
 */
export function splitIntoSections(text) {
  const t = String(text ?? '');
  if (!t.trim()) return { responsibilities: '', required: '', preferred: '', benefits: '', unlabeled: '' };

  const hits = [];
  for (const { key, pattern } of SECTION_MARKERS) {
    const re = new RegExp(pattern.source, 'gi');
    let m;
    while ((m = re.exec(t)) !== null) {
      hits.push({ key, index: m.index, length: m[0].length });
    }
  }
  hits.sort((a, b) => a.index - b.index);

  if (hits.length === 0) return { responsibilities: '', required: '', preferred: '', benefits: '', unlabeled: t };

  const sections = { responsibilities: '', required: '', preferred: '', benefits: '', unlabeled: t.slice(0, hits[0].index) };
  for (let i = 0; i < hits.length; i++) {
    const start = hits[i].index + hits[i].length;
    const end = i + 1 < hits.length ? hits[i + 1].index : t.length;
    sections[hits[i].key] += ' ' + t.slice(start, end);
  }
  return sections;
}

/** Splits a section's text into sentence-ish requirement/responsibility units. */
export function splitIntoSentences(segment) {
  const s = String(segment ?? '').trim();
  if (!s) return [];
  return s
    .split(/(?<=[a-z0-9%\)])\.\s+(?=[A-Z])|(?<=[a-z0-9%\)])\s(?=[A-Z][a-z]{2,}[a-z ]{0,40}(?:experience|skills|ability|track record|knowledge|understanding|proficiency|years|degree|certification|team|management|expertise|comfort))/)
    .map(x => x.trim())
    .filter(x => x.length > 8);
}

// ── Catalog-phrase matching (skills / requirement labels) ──────────────────

function matchCatalogPhrases(text) {
  return REQUIREMENT_CATALOG
    .filter(({ aliases }) => containsAnyTerm(text, aliases))
    .map(({ phrase }) => phrase);
}

function matchDomains(text) {
  return DOMAIN_CATALOG
    .filter(({ aliases }) => containsAnyTerm(text, aliases))
    .map(({ domain }) => domain);
}

// ── Seniority ────────────────────────────────────────────────────────────

const SENIORITY_LEVELS = [
  { level: 'Executive', terms: ['vp', 'vice president', 'chief', 'head of'] },
  { level: 'Director', terms: ['director'] },
  { level: 'Principal/Staff', terms: ['principal', 'staff'] },
  { level: 'Senior', terms: ['senior', 'sr.', 'sr '] },
  { level: 'Mid', terms: ['manager', 'lead'] },
  { level: 'Entry', terms: ['associate', 'junior', 'entry-level', 'entry level'] },
];

export function detectSeniority(text, title = '') {
  const corpus = `${title} ${text}`;
  const yearsMatches = [...corpus.matchAll(/(\d{1,2})\+?\s*(?:to\s*\d{1,2}\s*)?years?/gi)].map(m => Number(m[1]));
  const minYearsRequired = yearsMatches.length ? Math.max(...yearsMatches) : null;

  let level = null;
  for (const { level: lvl, terms } of SENIORITY_LEVELS) {
    if (containsAnyTerm(corpus, terms)) { level = lvl; break; }
  }

  return {
    level,
    minYearsRequired,
    evidence: level || minYearsRequired ? [
      ...(level ? [`Title/text indicates ${level}-level role.`] : []),
      ...(minYearsRequired ? [`JD references ${minYearsRequired}+ years of experience.`] : []),
    ] : [],
  };
}

// ── Leadership ───────────────────────────────────────────────────────────

const LEADERSHIP_TERMS = [
  'manage a team', 'manage and develop', 'direct reports', 'people management',
  'lead a team', 'build a team', 'hire and develop', 'coach and develop', 'managing and developing',
];

export function detectLeadership(text) {
  const required = containsAnyTerm(text, LEADERSHIP_TERMS);
  return {
    required,
    evidence: required ? LEADERSHIP_TERMS.filter(t => containsTerm(text, t)) : [],
  };
}

// ── Education / certifications ──────────────────────────────────────────

const DEGREE_TERMS = [
  { value: "Bachelor's degree", terms: ["bachelor's degree", 'bachelor degree', 'ba/bs', 'bs/ba', 'undergraduate degree'] },
  { value: "Master's degree", terms: ["master's degree", 'mba', 'graduate degree'] },
];

const CERT_TERMS = ['cissp', 'cism', 'ceh', 'pmp', 'itil', 'security+', 'comptia', 'aws certified', 'ccsp', 'csm', 'cspm'];

// Whether a matched term reads as "required" — scoped to the sentence it
// appears in, so an unrelated "required"/"preferred" elsewhere in a long
// posting doesn't mislabel every degree/cert mention.
function isRequiredNearby(text, term) {
  const sentences = text.split(/(?<=[.!?])\s+/);
  const sentence = sentences.find(s => containsTerm(s, term)) ?? text;
  const hasRequired = /required|must have|minimum qualification/i.test(sentence);
  const hasPreferred = /preferred|nice to have|bonus/i.test(sentence);
  return hasRequired && !hasPreferred;
}

export function detectEducationCertifications(text) {
  const out = [];
  for (const { value, terms } of DEGREE_TERMS) {
    const hitTerm = terms.find(t => containsTerm(text, t));
    if (hitTerm) {
      out.push({ type: 'degree', value, required: isRequiredNearby(text, hitTerm) });
    }
  }
  for (const term of CERT_TERMS) {
    if (containsTerm(text, term)) {
      out.push({ type: 'certification', value: term.toUpperCase(), required: isRequiredNearby(text, term) });
    }
  }
  return out;
}

// ── Location ─────────────────────────────────────────────────────────────

export function detectLocation(text, job = {}) {
  const corpus = `${job.location ?? ''} ${job.remoteStatus ?? ''} ${text}`;
  let type = null;
  if (containsAnyTerm(corpus, ['fully remote', 'remote-first', 'work from home', 'remote'])) type = 'remote';
  if (containsAnyTerm(corpus, ['hybrid'])) type = 'hybrid';
  if (containsAnyTerm(corpus, ['on-site', 'onsite', 'in-office', 'in office'])) type = type ?? 'onsite';
  const hasRelocationPhrase = containsAnyTerm(corpus, ['relocation required', 'must relocate', 'willing to relocate']);
  const negatedRelocation = /\bno relocation required\b|\bnot required to relocate\b|\bwithout relocation\b/i.test(corpus);
  const relocationRequired = hasRelocationPhrase && !negatedRelocation;

  return {
    type,
    detail: job.location || null,
    relocationRequired,
    source: job.location ? 'job record' : (type ? 'JD text' : 'unknown'),
  };
}

// ── Compensation ─────────────────────────────────────────────────────────

function parseCompRange(str) {
  const s = String(str ?? '');
  const kRange = s.match(/\$\s?(\d{2,3})\s?[kK]\s?(?:-|to|–)\s?\$?\s?(\d{2,3})\s?[kK]/);
  if (kRange) return { min: Number(kRange[1]) * 1000, max: Number(kRange[2]) * 1000 };
  const fullRange = s.match(/\$\s?(\d{2,3}),?(\d{3})\s?(?:-|to|–)\s?\$?\s?(\d{2,3}),?(\d{3})/);
  if (fullRange) return { min: Number(fullRange[1] + fullRange[2]), max: Number(fullRange[3] + fullRange[4]) };
  const single = s.match(/\$\s?(\d{2,3})\s?[kK]/);
  if (single) return { min: Number(single[1]) * 1000, max: null };
  return null;
}

export function detectCompensation(text, job = {}) {
  const jobRaw = job.salary || job.compensation;
  if (jobRaw) {
    const parsed = parseCompRange(jobRaw);
    return { min: parsed?.min ?? null, max: parsed?.max ?? null, currency: 'USD', raw: String(jobRaw), source: 'job record' };
  }
  const parsed = parseCompRange(text);
  if (parsed) {
    return { min: parsed.min, max: parsed.max, currency: 'USD', raw: null, source: 'JD text' };
  }
  return { min: null, max: null, currency: null, raw: null, source: 'unknown' };
}

// ── Main export ──────────────────────────────────────────────────────────

/**
 * Parses a job description into categorized requirement data.
 *
 * @param {string} jdText - raw job description text
 * @param {object} job - optional tracker.json job record (for location/comp/title fallbacks)
 */
export function parseJobDescription(jdText, job = {}) {
  const text = String(jdText ?? '');
  const sections = splitIntoSections(text);

  const required = splitIntoSentences(sections.required).map(sentence => ({
    text: sentence,
    requirementLabels: matchCatalogPhrases(sentence),
  }));
  const preferred = splitIntoSentences(sections.preferred).map(sentence => ({
    text: sentence,
    requirementLabels: matchCatalogPhrases(sentence),
  }));
  const responsibilities = splitIntoSentences(sections.responsibilities || sections.unlabeled).map(sentence => ({
    text: sentence,
    requirementLabels: matchCatalogPhrases(sentence),
  }));

  const skills = [...new Set(matchCatalogPhrases(text))];
  const domain = matchDomains(text);
  const seniority = detectSeniority(text, job.title ?? '');
  const leadership = detectLeadership(text);
  const educationCertifications = detectEducationCertifications(text);
  const location = detectLocation(text, job);
  const compensation = detectCompensation(text, job);

  return {
    required,
    preferred,
    responsibilities,
    skills,
    seniority,
    leadership,
    domain,
    educationCertifications,
    location,
    compensation,
    rawTextLength: text.length,
  };
}
