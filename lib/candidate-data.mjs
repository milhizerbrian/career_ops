// Canonical candidate fact store (Phase 0). Loads verified candidate facts
// from data/candidate/*.json — the trusted source for resume/application
// claims. Read-only against the JSON files; migration writes them
// (see scripts/migrate-candidate-data.mjs).
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = process.env.CAREER_OPS_DATA_DIR
  ? path.resolve(process.env.CAREER_OPS_DATA_DIR)
  : path.resolve(APP_ROOT, 'data');
const CANDIDATE_DIR = path.resolve(DATA_DIR, 'candidate');

const _mtimeCache = new Map();
function readJsonWithMtime(filePath, fallback) {
  if (!fs.existsSync(filePath)) {
    _mtimeCache.delete(filePath);
    return fallback;
  }
  const { mtimeMs } = fs.statSync(filePath);
  const cached = _mtimeCache.get(filePath);
  if (cached && cached.mtimeMs === mtimeMs) return cached.value;
  let value;
  try {
    value = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    value = fallback;
  }
  _mtimeCache.set(filePath, { mtimeMs, value });
  return value;
}

function loadFactFile(name) {
  const filePath = path.resolve(CANDIDATE_DIR, name);
  const value = readJsonWithMtime(filePath, []);
  return Array.isArray(value) ? value : [];
}

export function loadCandidateEmployers() {
  return loadFactFile('employers.json');
}

export function loadCandidateAchievements() {
  return loadFactFile('achievements.json');
}

export function loadCandidateSkills() {
  return loadFactFile('skills.json');
}

export function loadCandidateCertifications() {
  return loadFactFile('certifications.json');
}

export function loadCandidateProfile() {
  const filePath = path.resolve(CANDIDATE_DIR, 'profile.json');
  return readJsonWithMtime(filePath, null);
}

export function loadCandidatePreferences() {
  const filePath = path.resolve(CANDIDATE_DIR, 'preferences.json');
  return readJsonWithMtime(filePath, null);
}

/**
 * Loads every fact record (employers, achievements, skills, certifications)
 * across all four fact files. Does not filter by verified/allowed_in_resume —
 * use filterUsableFacts() for that.
 */
export function loadAllCandidateFacts() {
  return [
    ...loadCandidateEmployers(),
    ...loadCandidateAchievements(),
    ...loadCandidateSkills(),
    ...loadCandidateCertifications(),
  ];
}

/**
 * Facts that may actually be used in generated resume/application materials:
 * verified === true AND allowed_in_resume === true. Unverified or explicitly
 * disallowed facts (e.g. recovered-but-unconfirmed claims from profile.yml)
 * are excluded — per the source-of-truth rule, unverified evidence must be
 * asked about, never silently generated as fact.
 */
export function loadCandidateFacts() {
  return loadAllCandidateFacts().filter(f => f && f.verified === true && f.allowed_in_resume === true);
}

/** Facts recorded but not yet confirmed — surfaced for review, not resume use. */
export function loadFactsNeedingVerification() {
  return loadAllCandidateFacts().filter(f => f && (f.verified !== true || f.needs_verification === true));
}

/** Whether the canonical candidate data directory has been populated (i.e. migration has run). */
export function candidateDataExists() {
  return fs.existsSync(CANDIDATE_DIR) && loadAllCandidateFacts().length > 0;
}

/**
 * Evidence-validation enforcement mode for generated resume claims.
 * 'off' (default) — validation does not run; zero behavior change.
 * 'warn' — unsupported claims are logged/emitted but generation proceeds.
 * 'block' — unsupported claims stop document export.
 * Controlled by CANDIDATE_EVIDENCE_MODE. Defaults to 'off' so this is fully
 * backward-compatible until explicitly turned on.
 */
export function evidenceValidationMode() {
  const raw = String(process.env.CANDIDATE_EVIDENCE_MODE ?? 'off').toLowerCase();
  return ['off', 'warn', 'block'].includes(raw) ? raw : 'off';
}

export { CANDIDATE_DIR };
