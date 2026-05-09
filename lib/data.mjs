import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';
import PizZip from 'pizzip';
import PDFParser from 'pdf2json';
import {
  loadTracker as loadTrackerObject,
  updateJob as updateStoredJob,
  updateTracker,
} from './tracker-store.mjs';
import { writeTextAtomic } from './atomic-file.mjs';
import { normalizeStatus } from './status-utils.mjs';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Load all jobs from data/tracker.json.
 * tracker.json is a plain object keyed by job ID.
 * Returns array sorted by date_updated descending.
 */
export function loadTracker() {
  const obj = loadTrackerObject();
  return Object.entries(obj)
    .map(([id, job]) => ({ id, ...job, status: normalizeStatus(job.status) }))
    .sort((a, b) => (b.date_updated || '').localeCompare(a.date_updated || ''));
}

/**
 * Load a single job by tracker key. Throws if not found.
 */
export function loadJobById(id) {
  const obj = loadTrackerObject();
  if (!obj[id]) throw new Error(`Job not found in tracker: ${id}`);
  return { id, ...obj[id], status: normalizeStatus(obj[id].status) };
}

// Per-file mtime caches: avoid re-reading large/expensive sources on every call.
// Each cache holds { mtimeMs, value } and re-loads only when the file changes.
const _mtimeCache = new Map();
function _readWithMtime(filePath, loader) {
  if (!fs.existsSync(filePath)) {
    _mtimeCache.delete(filePath);
    return null;
  }
  const { mtimeMs } = fs.statSync(filePath);
  const cached = _mtimeCache.get(filePath);
  if (cached && cached.mtimeMs === mtimeMs) return cached.value;
  const value = loader(filePath);
  _mtimeCache.set(filePath, { mtimeMs, value });
  return value;
}

/**
 * Load the master brag document (candidate history). Cached by mtime.
 */
export function loadBragDoc() {
  const filePath = path.resolve(APP_ROOT, 'data', 'master-brag-document.md');
  const value = _readWithMtime(filePath, p => fs.readFileSync(p, 'utf8'));
  if (value === null) throw new Error(`Brag doc not found: ${filePath}`);
  return value;
}

/**
 * Load and parse config/profile.yml.
 */
export function loadProfile() {
  const filePath = path.resolve(APP_ROOT, 'config', 'profile.yml');
  return yaml.load(fs.readFileSync(filePath, 'utf8'));
}

/**
 * Extract plain text from data/Brian_Milhizer_Resume.docx.
 * Returns null if file not found.
 */
export function loadResumeText() {
  const filePath = path.resolve(APP_ROOT, 'data', 'Brian_Milhizer_Resume.docx');
  return _readWithMtime(filePath, p => {
    const content = fs.readFileSync(p, 'binary');
    const zip = new PizZip(content);
    const xml = zip.file('word/document.xml')?.asText() ?? '';
    return xml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  });
}

/**
 * Extract plain text from data/Profile.pdf (LinkedIn export).
 * Returns null if file not found. Async.
 */
// Async PDF parse cache — pdf2json is the heaviest read in this module (~1.5s).
let _linkedInCache = null; // { mtimeMs, promise }
export function loadLinkedInText() {
  const filePath = path.resolve(APP_ROOT, 'data', 'Profile.pdf');
  if (!fs.existsSync(filePath)) {
    _linkedInCache = null;
    return Promise.resolve(null);
  }
  const { mtimeMs } = fs.statSync(filePath);
  if (_linkedInCache && _linkedInCache.mtimeMs === mtimeMs) {
    return _linkedInCache.promise;
  }
  const promise = new Promise((resolve) => {
    const parser = new PDFParser();
    parser.on('pdfParser_dataReady', (data) => {
      try {
        const text = data.Pages
          ?.flatMap(p => p.Texts?.map(t => {
            try { return decodeURIComponent(t.R?.[0]?.T ?? ''); } catch { return t.R?.[0]?.T ?? ''; }
          }) ?? [])
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim();
        resolve(text || null);
      } catch { resolve(null); }
    });
    parser.on('pdfParser_dataError', () => resolve(null));
    parser.loadPDF(filePath);
  });
  _linkedInCache = { mtimeMs, promise };
  return promise;
}

/**
 * Parse unchecked items from data/pipeline.md.
 * Each line format: - [ ] URL | Company | Title
 * Returns array of { url, company, title }.
 */
export function loadPipeline() {
  const filePath = path.resolve(APP_ROOT, 'data', 'pipeline.md');
  if (!fs.existsSync(filePath)) return [];
  const lines = fs.readFileSync(filePath, 'utf8').split('\n');
  const results = [];
  for (const line of lines) {
    const m = line.match(/^- \[ \]\s+(.+)/);
    if (!m) continue;
    const parts = m[1].split('|').map(p => p.trim());
    if (parts.length >= 1) {
      results.push({
        url: parts[0] || '',
        company: parts[1] || '',
        title: parts[2] || '',
      });
    }
  }
  return results;
}

/**
 * Mark a pipeline.md entry as dismissed (checked) by URL.
 */
export function dismissPipelineItem(url) {
  const filePath = path.resolve(APP_ROOT, 'data', 'pipeline.md');
  if (!fs.existsSync(filePath)) return;
  const content = fs.readFileSync(filePath, 'utf8');
  const escaped = url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const updated = content.replace(
    new RegExp(`^(- )\\[ \\]( +${escaped}.*)$`, 'm'),
    '$1[x]$2'
  );
  writeTextAtomic(filePath, updated);
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

/**
 * Merge arbitrary top-level fields into a job in data/tracker.json.
 * Preserves all existing fields; only provided keys are overwritten.
 */
export function updateJob(jobId, fields) {
  return updateStoredJob(jobId, job => ({ ...job, ...fields }));
}

/**
 * Create a new job entry in data/tracker.json.
 * Throws if the ID already exists. Use updateJob for updates.
 */
export function createJob(id, fields) {
  let created;
  updateTracker(tracker => {
    if (tracker[id]) throw new Error(`Job already exists in tracker: ${id}`);
    tracker[id] = fields;
    created = { id, ...fields };
  });
  return created;
}
