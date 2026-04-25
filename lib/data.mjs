import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Load all jobs from data/tracker.json.
 * tracker.json is a plain object keyed by job ID.
 * Returns array sorted by date_updated descending.
 */
export function loadTracker() {
  const filePath = path.resolve(APP_ROOT, 'data', 'tracker.json');
  const raw = fs.readFileSync(filePath, 'utf8');
  const obj = JSON.parse(raw);
  return Object.entries(obj)
    .map(([id, job]) => ({ id, ...job }))
    .sort((a, b) => (b.date_updated || '').localeCompare(a.date_updated || ''));
}

/**
 * Load a single job by tracker key. Throws if not found.
 */
export function loadJobById(id) {
  const filePath = path.resolve(APP_ROOT, 'data', 'tracker.json');
  const raw = fs.readFileSync(filePath, 'utf8');
  const obj = JSON.parse(raw);
  if (!obj[id]) throw new Error(`Job not found in tracker: ${id}`);
  return { id, ...obj[id] };
}

/**
 * Load the master brag document (candidate history).
 */
export function loadBragDoc() {
  const filePath = path.resolve(APP_ROOT, 'data', 'master-brag-document.md');
  if (!fs.existsSync(filePath)) throw new Error(`Brag doc not found: ${filePath}`);
  return fs.readFileSync(filePath, 'utf8');
}

/**
 * Load and parse config/profile.yml.
 */
export function loadProfile() {
  const filePath = path.resolve(APP_ROOT, 'config', 'profile.yml');
  return yaml.load(fs.readFileSync(filePath, 'utf8'));
}

/**
 * Try to load a full JD from reports/{id}-*.md.
 * Returns file content string, or null if not found.
 */
export function loadJdFromReports(id) {
  const reportsDir = path.resolve(APP_ROOT, 'reports');
  if (!fs.existsSync(reportsDir)) return null;
  const files = fs.readdirSync(reportsDir)
    .filter(f => f.startsWith(id + '-') || f.includes(`-${id}-`));
  if (!files.length) return null;
  return fs.readFileSync(path.resolve(reportsDir, files[0]), 'utf8');
}
