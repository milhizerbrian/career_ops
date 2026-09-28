// Canonical candidate fact store (Phase 0). Loads verified candidate facts
// from career-evidence/candidate/*.json — the trusted source for resume/application
// claims. Read-only against the JSON files; migration writes them
// (see scripts/migrate-candidate-data.mjs).
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = process.env.CAREER_OPS_DATA_DIR
  ? path.resolve(process.env.CAREER_OPS_DATA_DIR)
  : path.resolve(APP_ROOT, 'data');
// Canonical fact files live in the tracked career-evidence/ directory, not
// gitignored data/ — see career-evidence/README.md. Tests override
// CAREER_OPS_DATA_DIR and seed DATA_DIR/candidate directly, so that
// isolation contract still resolves under DATA_DIR when the env var is set.
const CANDIDATE_DIR = process.env.CAREER_OPS_DATA_DIR
  ? path.resolve(DATA_DIR, 'candidate')
  : path.resolve(APP_ROOT, 'career-evidence', 'candidate');

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

/** STAR stories (Evidence Vault). Not part of loadAllCandidateFacts(); callers filter by `verified`. */
export function loadCandidateStories() {
  return loadFactFile('stories.json');
}

// profile.json holds PII (email, phone) and stays under local, gitignored
// data/candidate/ like config/profile.yml — never moved into the tracked
// career-evidence/ directory, even though the other candidate fact files were.
export function loadCandidateProfile() {
  const filePath = path.resolve(DATA_DIR, 'candidate', 'profile.json');
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
 * 'block' (default) — unsupported claims are rejected/replaced with verified
 *   evidence, and a resume that still has any is never saved.
 * 'warn' — enforcement runs; a remaining issue is reported, not blocking.
 * 'off' — explicit opt-out.
 * Controlled by CANDIDATE_EVIDENCE_MODE; unknown values fall back to 'block'.
 */
export function evidenceValidationMode() {
  const raw = String(process.env.CANDIDATE_EVIDENCE_MODE ?? 'block').toLowerCase();
  return ['off', 'warn', 'block'].includes(raw) ? raw : 'block';
}

export { CANDIDATE_DIR };
