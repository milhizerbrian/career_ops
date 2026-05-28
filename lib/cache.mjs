import { loadTracker, loadProfile, loadBragDoc } from './data.mjs';
import { computeOiScore } from './opportunity-intelligence.mjs';
import { scoreAtsMatch } from './ats-utils.mjs';
import { buildRecruiterAnalytics } from './recruiter-targeting.mjs';
import { buildWorkflowSummary, buildWorkflowTimeline, detectWorkflowStaleness, getNextBestAction } from './job-workflow.mjs';
import { statSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCAN_HISTORY_PATH = path.resolve(APP_ROOT, 'data', 'scan-history.tsv');

function getScanHistoryMtime() {
  try { return statSync(SCAN_HISTORY_PATH).mtime.toISOString(); } catch { return null; }
}

// Memoized dashboard and workspace payloads. All entries are invalidated
// together because the app is backed by a small set of local files.
const _cache = new Map();
let _dirty = true;

// Report source cache: Map<key, string> capped at 300 entries (FIFO eviction)
const _reportCache = new Map();
const REPORT_CACHE_MAX = 300;

/**
 * Returns memoized dashboard payload.
 * Rebuilds only when file changes trigger invalidateCache().
 */
export function getCachedDashboard() {
  if (!_dirty && _cache.has('dashboard')) {
    return _cache.get('dashboard');
  }
  const rawJobs = loadTracker();
  const bragDoc = loadBragDoc();
  const jobs = rawJobs.map(job => ({
    ...job,
    _oi:  computeOiScore(job),
    _ats: scoreAtsMatch(job, bragDoc),
    _workflow: {
      timeline: buildWorkflowTimeline(job),
      nextBestAction: getNextBestAction(job),
      staleness: detectWorkflowStaleness(job),
    },
  }));
  const payload = {
    jobs,
    profile: loadProfile(),
    recruiterAnalytics: buildRecruiterAnalytics(jobs),
    workflowSummary: buildWorkflowSummary(jobs),
    builtAt: new Date().toISOString(),
    lastScanAt: getScanHistoryMtime(),
  };
  _cache.set('dashboard', payload);
  _dirty = false;
  return payload;
}

export function getCachedValue(key, builder) {
  if (!_dirty && _cache.has(key)) return _cache.get(key);
  const value = builder();
  _cache.set(key, value);
  _dirty = false;
  return value;
}

export async function getCachedValueAsync(key, builder) {
  if (!_dirty && _cache.has(key)) return _cache.get(key);
  const value = await builder();
  _cache.set(key, value);
  _dirty = false;
  return value;
}

/**
 * Mark cache dirty. Called by watcher on file changes.
 */
export function invalidateCache() {
  _dirty = true;
  _cache.clear();
}

/**
 * Get or set a report source cache entry.
 * Pass value to set; omit to get.
 * FIFO eviction at 300 entries.
 */
export function reportCache(key, value) {
  if (value === undefined) {
    return _reportCache.get(key);
  }
  if (!_reportCache.has(key) && _reportCache.size >= REPORT_CACHE_MAX) {
    _reportCache.delete(_reportCache.keys().next().value);
  }
  _reportCache.set(key, value);
}
