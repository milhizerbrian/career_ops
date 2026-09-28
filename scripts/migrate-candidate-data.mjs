#!/usr/bin/env node
// Phase 0: migrate verified facts from data/master-brag-document.md into
// the canonical career-evidence/candidate/*.json fact store. Read-only against all
// existing files (master-brag-document.md, config/profile.yml, tracker.json).
// Idempotent: safe to re-run; skips facts already present by exact text match.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = path.resolve(APP_ROOT, 'data');
// Canonical fact store lives in the tracked career-evidence/ directory, not
// gitignored data/ (see career-evidence/README.md).
const EVIDENCE_DIR = path.resolve(APP_ROOT, 'career-evidence');
const CANDIDATE_DIR = path.resolve(EVIDENCE_DIR, 'candidate');
const BRAG_PATH = path.resolve(EVIDENCE_DIR, 'master-brag-document.md');
const PROFILE_YML_PATH = path.resolve(APP_ROOT, 'config', 'profile.yml');

const NUMBER_WORDS = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
  nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14,
  fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20,
};

function readFile(p) {
  if (!fs.existsSync(p)) return '';
  return fs.readFileSync(p, 'utf8');
}

function loadExisting(name) {
  const p = path.resolve(CANDIDATE_DIR, name);
  if (!fs.existsSync(p)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function normalizeFact(text) {
  return String(text ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Word/digit-boundary-aware substring test: prevents "20%" from matching
// inside "120%", or "8 accounts" from matching inside "18 accounts".
export function corpusContainsToken(corpus, token) {
  const escaped = escapeRegExp(token);
  if (!escaped) return false;
  const pattern = new RegExp(`(?<![0-9$.,])${escaped}(?![0-9])`, 'i');
  return pattern.test(corpus);
}

// Adds new fact records to an existing array, skipping exact-text duplicates
// (case/whitespace-insensitive) within the same category+employer. Returns
// { records, added, skipped }.
export function mergeFacts(existing, incoming, prefix) {
  const seen = new Set(existing.map(r => `${r.category}|${r.employer ?? ''}|${normalizeFact(r.fact)}`));
  const added = [];
  const skipped = [];
  let nextNum = existing.reduce((max, r) => {
    const m = /-(\d+)$/.exec(r.id || '');
    return m ? Math.max(max, parseInt(m[1], 10)) : max;
  }, 0);
  const records = [...existing];
  for (const rec of incoming) {
    const key = `${rec.category}|${rec.employer ?? ''}|${normalizeFact(rec.fact)}`;
    if (seen.has(key)) {
      skipped.push(rec.fact);
      continue;
    }
    seen.add(key);
    nextNum += 1;
    const id = `${prefix}-${String(nextNum).padStart(3, '0')}`;
    const full = { id, ...rec };
    records.push(full);
    added.push(full);
  }
  return { records, added, skipped };
}

// ---- Parse master-brag-document.md ----

export function parseIdentity(md) {
  const block = md.split('## Identity')[1]?.split('---')[0] ?? '';
  const grab = (label) => {
    const m = new RegExp(`\\*\\*${label}:\\*\\*\\s*(.+)`).exec(block);
    return m ? m[1].trim() : '';
  };
  return {
    name: grab('Name'),
    email: grab('Email'),
    phone: grab('Phone'),
    location: grab('Location'),
    linkedin: grab('LinkedIn'),
    portfolio: grab('Portfolio'),
    headline: grab('Headline'),
    topSkills: grab('Top Skills'),
  };
}

export function parseTargetRoles(md) {
  const block = md.split('## Target Roles')[1]?.split('## Career Summary')[0] ?? '';
  const grab = (label) => {
    const m = new RegExp(`\\*\\*${label}:\\*\\*\\s*(.+)`).exec(block);
    return m ? m[1].trim() : '';
  };
  const splitList = (s) => s.split(',').map(x => x.trim()).filter(Boolean);
  return {
    preferredTitles: splitList(grab('Preferred Titles')),
    targetCompanyTypes: splitList(grab('Target Company Types')),
    mustHaveKeywords: splitList(grab('Must-Have Keywords for ATS')),
    dealBreakerExclusions: grab('Deal-Breaker Exclusions'),
  };
}

export function parseResumeWritingRules(md) {
  const block = md.split('## Resume Writing Rules')[1]?.split('## Instructions for Claude Code')[0] ?? '';
  return block.split('\n').map(l => l.trim()).filter(l => l.startsWith('- ')).map(l => l.slice(2).trim());
}

export function parseRoles(md) {
  const chunk = md.split('## Experience Details')[1]?.split('## Certifications')[0] ?? '';
  const sections = chunk.split(/\n### /).slice(1); // first split-part is the "Exact Role Titles" preamble
  const roles = [];
  for (const section of sections) {
    const headingLine = section.split('\n')[0].trim();
    const [employerPart, titlePart] = headingLine.split(/\s+—\s+/);
    const employer = (employerPart || '').trim();
    const title = (titlePart || '').trim();
    const datesMatch = /\*\*(.+?\d{4}.*?)\*\*/.exec(section);
    const dates = datesMatch ? datesMatch[1].trim() : '';
    const domainMatch = /\*\*Domain:\*\*\s*(.+)/.exec(section);
    const domain = domainMatch ? domainMatch[1].trim() : '';
    const keywordsMatch = /\*\*Keywords:\*\*\s*(.+)/.exec(section);
    const keywords = keywordsMatch ? keywordsMatch[1].split(',').map(k => k.trim()).filter(Boolean) : [];
    const metricsBlock = section.split('**Key Metrics:**')[1]?.split('**Keywords:**')[0] ?? '';
    const metrics = metricsBlock.split('\n').map(l => l.trim()).filter(l => l.startsWith('- ')).map(l => l.slice(2).trim());
    const bulletsBlock = section.split('**Bullets:**')[1]?.split(/\n---/)[0] ?? '';
    const bullets = bulletsBlock.split('\n').map(l => l.trim()).filter(l => l.startsWith('- ')).map(l => l.slice(2).trim());
    roles.push({ employer, title, dates, domain, keywords, metrics, bullets });
  }
  return roles;
}

export function parseCertifications(md) {
  const block = md.split('## Certifications')[1]?.split('## Resume Writing Rules')[0] ?? '';
  return block.split('\n').map(l => l.trim()).filter(l => l.startsWith('- ')).map(l => l.slice(2).trim());
}

// ---- Conflict detection: profile.yml claims not corroborated by master doc ----

export function extractNumericTokens(text) {
  const tokens = new Set();
  for (const m of text.matchAll(/\$[\d,.]+\s*[KMB]?\+?/gi)) tokens.add(m[0].trim());
  for (const m of text.matchAll(/\b\d+(?:\.\d+)?%/g)) tokens.add(m[0]);
  return [...tokens];
}

export function wordsToDigits(text) {
  return text.replace(/\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)\b/gi,
    (w) => String(NUMBER_WORDS[w.toLowerCase()] ?? w));
}

export function extractCountPhrases(text) {
  const normalized = wordsToDigits(text);
  const tokens = new Set();
  for (const m of normalized.matchAll(/\b(\d+)\s*(direct reports?|accounts?|clients?|customers?)\b/gi)) {
    tokens.add(`${m[1]} ${m[2].toLowerCase().replace(/s$/, '')}`.replace(/\s+/g, ' '));
  }
  return [...tokens];
}

export function findUnverifiedProfileYmlClaims(bragRaw, profileYmlPath) {
  if (!fs.existsSync(profileYmlPath)) return [];
  let doc;
  try {
    doc = yaml.load(fs.readFileSync(profileYmlPath, 'utf8'));
  } catch {
    return [];
  }
  const claims = [];
  const bragLower = bragRaw.toLowerCase();
  // Only scan sections that make candidate-history/achievement claims.
  // compensation, scoring_overrides, and deal_breakers are job-search
  // filter preferences, not resume-fact candidates — out of scope here.
  const scopedRoots = {
    narrative: doc?.narrative,
    background: doc?.background,
  };
  const walk = (value, sourcePath) => {
    if (typeof value === 'string') {
      for (const token of extractNumericTokens(value)) {
        if (!corpusContainsToken(bragRaw, token) && !corpusContainsToken(bragLower, token.toLowerCase())) {
          claims.push({ sourcePath, snippet: value.trim(), token, kind: 'numeric' });
        }
      }
      for (const token of extractCountPhrases(value)) {
        if (!corpusContainsToken(wordsToDigits(bragLower), token)) {
          claims.push({ sourcePath, snippet: value.trim(), token, kind: 'count-phrase' });
        }
      }
    } else if (Array.isArray(value)) {
      value.forEach((v, i) => walk(v, `${sourcePath}[${i}]`));
    } else if (value && typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) walk(v, sourcePath ? `${sourcePath}.${k}` : k);
    }
  };
  for (const [rootKey, rootValue] of Object.entries(scopedRoots)) {
    if (rootValue !== undefined) walk(rootValue, rootKey);
  }
  return claims;
}

// ---- Main ----

function main() {
  fs.mkdirSync(CANDIDATE_DIR, { recursive: true });
  const bragRaw = readFile(BRAG_PATH);
  if (!bragRaw) {
    console.error(`FATAL: master brag document not found at ${BRAG_PATH}`);
    process.exit(1);
  }

  const identity = parseIdentity(bragRaw);
  const targetRoles = parseTargetRoles(bragRaw);
  const resumeWritingRules = parseResumeWritingRules(bragRaw);
  const roles = parseRoles(bragRaw);
  const certifications = parseCertifications(bragRaw);

  const report = { generatedAt: new Date().toISOString(), files: {}, conflicts: [] };

  // profile.json (structured, not a fact-record list)
  const profileJson = {
    generatedAt: new Date().toISOString(),
    source: 'data/master-brag-document.md',
    verified: true,
    fields: identity,
  };
  fs.writeFileSync(path.resolve(CANDIDATE_DIR, 'profile.json'), JSON.stringify(profileJson, null, 2) + '\n');

  // preferences.json (structured)
  const preferencesJson = {
    generatedAt: new Date().toISOString(),
    source: 'data/master-brag-document.md',
    verified: true,
    preferredTitles: targetRoles.preferredTitles,
    targetCompanyTypes: targetRoles.targetCompanyTypes,
    mustHaveKeywords: targetRoles.mustHaveKeywords,
    dealBreakerExclusions: targetRoles.dealBreakerExclusions,
    resumeWritingRules,
  };
  fs.writeFileSync(path.resolve(CANDIDATE_DIR, 'preferences.json'), JSON.stringify(preferencesJson, null, 2) + '\n');

  // employers.json — one fact record per role
  const employerIncoming = roles.map(r => ({
    fact: `${r.employer} — ${r.title}, ${r.dates}${r.domain ? ` (${r.domain})` : ''}`,
    category: 'employer',
    employer: r.employer,
    source: 'master-brag-document.md',
    verified: true,
    allowed_in_resume: true,
  }));
  const employersExisting = loadExisting('employers.json');
  const employersMerged = mergeFacts(employersExisting, employerIncoming, 'employer');
  fs.writeFileSync(path.resolve(CANDIDATE_DIR, 'employers.json'), JSON.stringify(employersMerged.records, null, 2) + '\n');
  report.files.employers = { added: employersMerged.added.length, skipped: employersMerged.skipped.length, total: employersMerged.records.length };

  // achievements.json — metrics + bullets, one record each, tagged verified/allowed
  const achievementIncoming = [];
  for (const r of roles) {
    for (const m of r.metrics) {
      achievementIncoming.push({ fact: m, category: 'metric', employer: r.employer, source: 'master-brag-document.md', verified: true, allowed_in_resume: true });
    }
    for (const b of r.bullets) {
      achievementIncoming.push({ fact: b, category: 'achievement', employer: r.employer, source: 'master-brag-document.md', verified: true, allowed_in_resume: true });
    }
  }
  // Unverified claims recovered from config/profile.yml — recorded but NOT usable in resumes
  // until Brian confirms them (verified:false, allowed_in_resume:false).
  const unverified = findUnverifiedProfileYmlClaims(bragRaw, PROFILE_YML_PATH);
  const unverifiedIncoming = unverified.map(c => ({
    fact: c.snippet,
    category: 'achievement',
    employer: null,
    source: `config/profile.yml (${c.sourcePath}) — not corroborated by master-brag-document.md`,
    verified: false,
    allowed_in_resume: false,
    needs_verification: true,
    conflict_token: c.token,
  }));
  const achievementsExisting = loadExisting('achievements.json');
  const achievementsMerged = mergeFacts(achievementsExisting, [...achievementIncoming, ...unverifiedIncoming], 'achievement');
  fs.writeFileSync(path.resolve(CANDIDATE_DIR, 'achievements.json'), JSON.stringify(achievementsMerged.records, null, 2) + '\n');
  report.files.achievements = { added: achievementsMerged.added.length, skipped: achievementsMerged.skipped.length, total: achievementsMerged.records.length };
  report.conflicts = unverified;

  // skills.json — dedup keywords across roles + top skills + ATS must-haves
  const skillIncoming = [];
  const skillSeen = new Set();
  const addSkill = (fact, employer) => {
    const key = normalizeFact(fact);
    if (skillSeen.has(key)) return;
    skillSeen.add(key);
    skillIncoming.push({ fact, category: 'skill', employer: employer ?? null, source: 'master-brag-document.md', verified: true, allowed_in_resume: true });
  };
  if (identity.topSkills) identity.topSkills.split(',').forEach(s => addSkill(s.trim(), null));
  targetRoles.mustHaveKeywords.forEach(k => addSkill(k, null));
  for (const r of roles) r.keywords.forEach(k => addSkill(k, r.employer));
  const skillsExisting = loadExisting('skills.json');
  const skillsMerged = mergeFacts(skillsExisting, skillIncoming, 'skill');
  fs.writeFileSync(path.resolve(CANDIDATE_DIR, 'skills.json'), JSON.stringify(skillsMerged.records, null, 2) + '\n');
  report.files.skills = { added: skillsMerged.added.length, skipped: skillsMerged.skipped.length, total: skillsMerged.records.length };

  // certifications.json
  const certIncoming = certifications.map(c => ({
    fact: c, category: 'certification', employer: null, source: 'master-brag-document.md', verified: true, allowed_in_resume: true,
  }));
  const certsExisting = loadExisting('certifications.json');
  const certsMerged = mergeFacts(certsExisting, certIncoming, 'cert');
  fs.writeFileSync(path.resolve(CANDIDATE_DIR, 'certifications.json'), JSON.stringify(certsMerged.records, null, 2) + '\n');
  report.files.certifications = { added: certsMerged.added.length, skipped: certsMerged.skipped.length, total: certsMerged.records.length };

  fs.writeFileSync(path.resolve(CANDIDATE_DIR, 'MIGRATION_REPORT.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
}

const isDirectRun = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isDirectRun) {
  main();
}

export { main };
