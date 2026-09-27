// Phase 5: Career Evidence Vault — the UI-facing read/write layer over
// Phase 0's canonical candidate fact files (data/candidate/*.json). This is
// NOT a second candidate database: it reads and writes the exact same files
// candidate-data.mjs already loads for scoring/resume generation
// (employers.json, achievements.json, skills.json, certifications.json),
// plus one new file this phase adds for STAR stories (stories.json), which
// lives in the same data/candidate/ directory and follows the same
// {id, category, source, verified, allowed_in_resume} shape as every other
// fact record. Nothing here changes how Phase 2 (candidate-fit-analysis.mjs)
// or resume-gen.mjs read facts — they keep calling candidate-data.mjs's
// loadCandidateFacts()/loadAllCandidateFacts() exactly as before; new/edited
// records just show up there because they're the same files.
//
// Evidence Rules (Phase 0, restated and enforced here):
//   Verified      -> AI may use it (loadCandidateFacts() requires this)
//   Unverified    -> ask Brian (surfaced, never used to generate a claim)
//   No evidence   -> never claim as fact
// This module never silently flips `verified` or `allowed_in_resume` — both
// are only ever set by an explicit field in the caller's request (a person
// checking/unchecking a box, or confirming a promotion), never inferred or
// defaulted to true.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { writeJsonAtomic } from './atomic-file.mjs';
import { loadQuestions, markQuestionPromoted } from './candidate-questions.mjs';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = process.env.CAREER_OPS_DATA_DIR
  ? path.resolve(process.env.CAREER_OPS_DATA_DIR)
  : path.resolve(APP_ROOT, 'data');
const CANDIDATE_DIR = path.resolve(DATA_DIR, 'candidate');

// Every fact category the Vault knows about, and which file it lives in.
// 'achievement' and 'metric' deliberately share achievements.json — that's
// the existing Phase 0 convention (see data/candidate/achievements.json),
// not something this phase changes.
const CATEGORY_FILE = {
  employer: 'employers.json',
  achievement: 'achievements.json',
  metric: 'achievements.json',
  skill: 'skills.json',
  certification: 'certifications.json',
  story: 'stories.json',
};

const ID_PREFIX = {
  employer: 'employer',
  achievement: 'achievement',
  metric: 'achievement', // shares achievements.json's existing numbering
  skill: 'skill',
  certification: 'cert',
  story: 'story',
};

// Career Profile navigation sections -> the category value(s) shown there.
export const VAULT_SECTIONS = {
  experience: ['employer'],
  achievements: ['achievement'],
  skills: ['skill'],
  certifications: ['certification'],
  metrics: ['metric'],
  stories: ['story'],
};

// Fields any category may set on add/edit. Category-specific extras are
// added on top. `verified` and `allowed_in_resume` are always explicit,
// caller-supplied booleans — never inferred.
const COMMON_FIELDS = ['fact', 'employer', 'source', 'tags', 'verified', 'allowed_in_resume'];
const CATEGORY_EXTRA_FIELDS = {
  skill: ['evidence', 'experienceDepth', 'lastUsed'],
  // Stories don't use the generic `fact` field — they're structured STAR
  // records instead. `allowed_in_resume` doesn't apply to them either (a
  // STAR story isn't itself a resume line); resume/matching facts about the
  // same experience still live as their own skill/achievement records.
  story: ['situation', 'task', 'action', 'result'],
};
const STORY_ONLY_FIELDS = new Set(['situation', 'task', 'action', 'result']);

function categoryFile(category) {
  const file = CATEGORY_FILE[category];
  if (!file) throw new Error(`Unknown evidence category: ${category}`);
  return path.resolve(CANDIDATE_DIR, file);
}

function loadCategoryFile(category) {
  const filePath = categoryFile(category);
  if (!fs.existsSync(filePath)) return [];
  try {
    const value = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function saveCategoryFile(category, records) {
  writeJsonAtomic(categoryFile(category), records);
}

function nextId(category, allRecordsInFile) {
  const prefix = ID_PREFIX[category];
  let max = 0;
  for (const r of allRecordsInFile) {
    const m = typeof r?.id === 'string' && r.id.startsWith(`${prefix}-`) ? r.id.slice(prefix.length + 1) : null;
    const n = m != null ? parseInt(m, 10) : NaN;
    if (Number.isFinite(n) && n > max) max = n;
  }
  return `${prefix}-${String(max + 1).padStart(3, '0')}`;
}

function normalizeText(value) {
  return String(value ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Read-time decoration only, matching candidate-data.mjs's own convention
 * (toOpportunityView() in opportunity-store.mjs does the same thing) —
 * fills in display defaults for fields a record may not have yet, without
 * writing anything to disk or inventing a value beyond "not set".
 */
function decorate(category, record) {
  const decorated = {
    ...record,
    tags: Array.isArray(record.tags) ? record.tags : [],
  };
  if (category === 'skill') {
    decorated.evidence = record.evidence ?? null;
    decorated.experienceDepth = record.experienceDepth ?? null;
    decorated.lastUsed = record.lastUsed ?? null;
  }
  return decorated;
}

/**
 * Finds an existing record in `category`'s file whose identity text matches
 * `fact` (or, for stories, `situation`+`task`+`action`+`result` together)
 * and employer — used to block accidental duplicates on add, and to detect
 * "this requirement is already covered" before promoting a candidate
 * question's answer into evidence.
 */
function findDuplicate(category, fields, records) {
  const employer = normalizeText(fields.employer);
  const identity = category === 'story'
    ? normalizeText([fields.situation, fields.task, fields.action, fields.result].join('|'))
    : normalizeText(fields.fact);
  if (!identity) return null;
  return records.find(r => {
    const rIdentity = category === 'story'
      ? normalizeText([r.situation, r.task, r.action, r.result].join('|'))
      : normalizeText(r.fact);
    return rIdentity === identity && normalizeText(r.employer) === employer;
  }) || null;
}

function pickFields(category, source) {
  const allowed = new Set([...COMMON_FIELDS, ...(CATEGORY_EXTRA_FIELDS[category] || [])]);
  if (category === 'story') STORY_ONLY_FIELDS.forEach(f => allowed.delete('fact')); // stories never use `fact`
  const out = {};
  for (const key of allowed) {
    if (key === 'fact' && category === 'story') continue;
    if (Object.prototype.hasOwnProperty.call(source, key)) out[key] = source[key];
  }
  return out;
}

function assertResumePermissionInvariant(fields, existing = {}) {
  // "No evidence -> never claim as fact": a record can only be marked usable
  // in generated materials if it's also marked verified. This blocks the one
  // state Phase 0's evidence rules explicitly forbid; it never sets either
  // flag itself.
  const verified = 'verified' in fields ? fields.verified : existing.verified;
  const allowedInResume = 'allowed_in_resume' in fields ? fields.allowed_in_resume : existing.allowed_in_resume;
  if (allowedInResume === true && verified !== true) {
    throw new Error('Cannot allow unverified evidence in resume — verify it first.');
  }
}

/** Builds the full Career Profile payload: one array per Vault section. */
export function buildEvidenceVault() {
  const vault = {};
  for (const [section, categories] of Object.entries(VAULT_SECTIONS)) {
    vault[section] = categories.flatMap(category =>
      loadCategoryFile(category)
        .filter(r => r.category === category)
        .map(r => decorate(category, r))
    );
  }
  return vault;
}

/**
 * Adds a new fact/story. Rejects an exact duplicate (same identity text +
 * employer) already in that category's file, and rejects allowed_in_resume
 * without verified. `verified`/`allowed_in_resume` default to false — a new
 * record is never automatically usable; Brian has to say so.
 */
export function addFact(category, fields = {}) {
  if (!CATEGORY_FILE[category]) throw new Error(`Unknown evidence category: ${category}`);
  const picked = pickFields(category, fields);
  if (category === 'story') {
    if (!picked.situation || !picked.task || !picked.action || !picked.result) {
      throw new Error('A story needs situation, task, action, and result.');
    }
  } else if (!picked.fact || !String(picked.fact).trim()) {
    throw new Error('fact is required');
  }
  picked.verified = picked.verified === true;
  picked.allowed_in_resume = category === 'story' ? undefined : picked.allowed_in_resume === true;
  assertResumePermissionInvariant(picked);

  const records = loadCategoryFile(category);
  const dup = findDuplicate(category, picked, records.filter(r => r.category === category));
  if (dup) {
    const err = new Error(`This looks identical to an existing record (${dup.id}) — not adding a duplicate.`);
    err.code = 'DUPLICATE_EVIDENCE';
    err.existingId = dup.id;
    throw err;
  }

  const record = {
    id: nextId(category, records),
    category,
    employer: picked.employer ?? null,
    source: picked.source || 'manual-entry',
    verified: picked.verified,
    createdAt: new Date().toISOString(),
    ...picked,
  };
  if (category !== 'story') record.allowed_in_resume = picked.allowed_in_resume;
  records.push(record);
  saveCategoryFile(category, records);
  return decorate(category, record);
}

/**
 * Partial update. Only fields explicitly present in `fields` are touched —
 * everything else on the record is left exactly as it was. Still enforced:
 * allowed_in_resume can't be set true unless the record ends up verified.
 */
export function updateFact(category, id, fields = {}) {
  if (!CATEGORY_FILE[category]) throw new Error(`Unknown evidence category: ${category}`);
  const records = loadCategoryFile(category);
  const record = records.find(r => r.id === id);
  if (!record) {
    const err = new Error(`Evidence record not found: ${id}`);
    err.code = 'EVIDENCE_NOT_FOUND';
    throw err;
  }
  const picked = pickFields(category, fields);
  assertResumePermissionInvariant(picked, record);
  Object.assign(record, picked, { updatedAt: new Date().toISOString() });
  saveCategoryFile(category, records);
  return decorate(category, record);
}

/**
 * Turns an already-answered candidate question (Phase 2) into a persisted,
 * verified fact — but only when explicitly confirmed (`confirm: true`), and
 * only once per question (idempotent: re-confirming an already-promoted
 * question returns the fact already created for it, never a duplicate).
 * This is the "existing mechanism" that keeps Career-Ops from repeatedly
 * asking the same question once Brian has answered it.
 */
export function promoteQuestionToEvidence(questionId, { confirm = false, category = 'skill', employer = null, tags = [] } = {}) {
  if (!confirm) {
    const err = new Error('Promoting a question to evidence requires explicit confirmation.');
    err.code = 'CONFIRMATION_REQUIRED';
    throw err;
  }
  const question = loadQuestions().find(q => q.id === questionId);
  if (!question) {
    const err = new Error(`Question not found: ${questionId}`);
    err.code = 'QUESTION_NOT_FOUND';
    throw err;
  }
  if (question.status !== 'answered' || !question.answer) {
    throw new Error('This question has not been answered yet.');
  }
  if (question.promotedFactId) {
    const records = loadCategoryFile(category);
    const existing = records.find(r => r.id === question.promotedFactId);
    if (existing) return { question, fact: decorate(category, existing), alreadyPromoted: true };
  }

  const fields = {
    fact: question.answer,
    employer: employer ?? null,
    source: `candidate-question:${question.id}`,
    tags: Array.isArray(tags) ? tags : [],
    verified: true,
    allowed_in_resume: true,
  };
  let fact;
  try {
    fact = addFact(category, fields);
  } catch (err) {
    if (err.code === 'DUPLICATE_EVIDENCE') {
      markQuestionPromoted(question.id, err.existingId);
      const records = loadCategoryFile(category);
      const existing = records.find(r => r.id === err.existingId);
      return { question: { ...question, promotedFactId: err.existingId }, fact: decorate(category, existing), alreadyPromoted: true };
    }
    throw err;
  }
  const updatedQuestion = markQuestionPromoted(question.id, fact.id);
  return { question: updatedQuestion, fact, alreadyPromoted: false };
}

export { CANDIDATE_DIR };
