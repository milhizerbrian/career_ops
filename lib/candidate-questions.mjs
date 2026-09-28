// Phase 2: Persistent candidate-clarification questions.
//
// When Phase 2's fit analysis finds a requirement with Unknown evidence
// (no verified fact either way — never a confirmed Gap), it can generate a
// targeted question for Brian. Questions are persisted in
// career-evidence/candidate/questions.json, keyed by requirement label, so the same
// question is never re-asked across jobs once it has been answered — and a
// once-open question is reused (not duplicated) across multiple jobs that
// share the same unresolved requirement.
//
// Never assumes yes/no: every generated question asks for specifics
// (employer, scope, measurable result) rather than a boolean confirmation,
// matching the phrasing convention already used by
// lib/resume-gen.mjs's buildGapQuestionCandidates for resume-tailoring gaps.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { writeJsonAtomic } from './atomic-file.mjs';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = process.env.CAREER_OPS_DATA_DIR
  ? path.resolve(process.env.CAREER_OPS_DATA_DIR)
  : path.resolve(APP_ROOT, 'data');

function questionsPath() {
  // Lives in the tracked career-evidence/ directory by default; tests override
  // CAREER_OPS_DATA_DIR and seed DATA_DIR/candidate directly.
  return process.env.CAREER_OPS_DATA_DIR
    ? path.resolve(DATA_DIR, 'candidate', 'questions.json')
    : path.resolve(APP_ROOT, 'career-evidence', 'candidate', 'questions.json');
}

export function loadQuestions() {
  const filePath = questionsPath();
  if (!fs.existsSync(filePath)) return [];
  try {
    const value = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function saveQuestions(questions) {
  writeJsonAtomic(questionsPath(), questions);
}

function buildQuestionText(requirementLabel) {
  return `Have you done work involving ${requirementLabel}? If yes, which employer, what did you specifically do, and what measurable result or scope can we state truthfully? If no, say so — this stays marked Unknown (not held against you) until answered.`;
}

let _counter = 0;
function nextId() {
  _counter += 1;
  return `question-${Date.now().toString(36)}-${_counter}`;
}

/**
 * Ensures a persisted question exists for `requirementLabel`, associating
 * `jobId` with it (so one question can surface across multiple jobs that
 * hit the same unknown requirement). Returns the (possibly pre-existing)
 * question record. Never creates a duplicate open question for the same
 * requirement label, and never re-opens one already answered.
 */
export function ensureQuestion(requirementLabel, jobId) {
  const questions = loadQuestions();
  const existing = questions.find(q => q.requirementLabel === requirementLabel);
  if (existing) {
    if (!existing.jobIds.includes(jobId)) {
      existing.jobIds.push(jobId);
      saveQuestions(questions);
    }
    return existing;
  }
  const question = {
    id: nextId(),
    requirementLabel,
    question: buildQuestionText(requirementLabel),
    status: 'open',
    answer: null,
    jobIds: [jobId].filter(Boolean),
    createdAt: new Date().toISOString(),
    answeredAt: null,
    promotedFactId: null,
  };
  questions.push(question);
  saveQuestions(questions);
  return question;
}

/**
 * Generates/reuses persisted questions for every Unknown-tier classification
 * in a fit-analysis result. Returns only the still-open ones (answered
 * requirements are resolved silently — callers wanting the answer text
 * should read it off the returned record's `.answer` via getAnsweredQuestions()).
 */
export function generateQuestionsForUnknowns(classifications, jobId) {
  return classifications
    .filter(c => c.tier === 'unknown')
    .map(c => ensureQuestion(c.label, jobId))
    .filter(q => q.status === 'open');
}

export function answerQuestion(id, answer) {
  const questions = loadQuestions();
  const question = questions.find(q => q.id === id);
  if (!question) throw new Error(`Question not found: ${id}`);
  question.status = 'answered';
  question.answer = answer;
  question.answeredAt = new Date().toISOString();
  saveQuestions(questions);
  return question;
}

export function getOpenQuestions() {
  return loadQuestions().filter(q => q.status === 'open');
}

export function getAnsweredQuestions() {
  return loadQuestions().filter(q => q.status === 'answered');
}

/**
 * Phase 5: records that an answered question's answer has been turned into
 * a persisted Evidence Vault fact (see lib/evidence-vault.mjs's
 * promoteQuestionToEvidence), so the same question is never offered for
 * promotion twice. Never called except after that explicit, confirmed
 * promotion — this module itself never decides to promote anything.
 */
export function markQuestionPromoted(id, factId) {
  const questions = loadQuestions();
  const question = questions.find(q => q.id === id);
  if (!question) throw new Error(`Question not found: ${id}`);
  question.promotedFactId = factId;
  saveQuestions(questions);
  return question;
}
