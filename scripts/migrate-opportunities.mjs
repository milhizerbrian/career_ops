#!/usr/bin/env node
// Phase 1: migrates every existing tracker.json job into the Opportunity
// model by adding a `stage` field (derived from the legacy `status`) plus
// a real `discovered` activity event when one isn't already present.
// Nothing existing is removed, renamed, or overwritten — this is additive
// only. Backs up tracker.json before writing. Idempotent: re-running finds
// nothing left to do.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createTrackerStore, DEFAULT_TRACKER_PATH, validateTracker } from '../lib/tracker-store.mjs';
import { deriveStageFromStatus, isValidStage } from '../lib/opportunity-stages.mjs';
import { appendWorkflowEvent, normalizeWorkflowTimeline } from '../lib/job-workflow.mjs';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function resolveTrackerPath() {
  return process.env.CAREER_OPS_TRACKER_PATH
    ? path.resolve(process.env.CAREER_OPS_TRACKER_PATH)
    : DEFAULT_TRACKER_PATH;
}

function backupTracker(trackerPath) {
  if (!fs.existsSync(trackerPath)) return null;
  const backupDir = path.resolve(path.dirname(trackerPath), 'backups', `tracker-pre-opportunity-migration-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  fs.mkdirSync(backupDir, { recursive: true });
  const backupPath = path.resolve(backupDir, 'tracker.json');
  fs.copyFileSync(trackerPath, backupPath);
  return backupPath;
}

export function migrateJob(job, id, now = new Date()) {
  const alreadyMigrated = typeof job.stage === 'string' && isValidStage(job.stage);
  const next = { ...job };
  const notes = [];

  if (!alreadyMigrated) {
    if (job.stage != null && !isValidStage(job.stage)) {
      notes.push(`job "${id}": existing stage "${job.stage}" is not a recognized stage — replaced with a status-derived value`);
    }
    next.stage = deriveStageFromStatus(job.status);
  }

  const timeline = normalizeWorkflowTimeline(job.workflowTimeline);
  const hasDiscovered = timeline.some(e => e.type === 'discovered');
  if (!hasDiscovered) {
    // Use the job's own discovery date when we have one — never invent a
    // "now" timestamp for historical data.
    const discoveredAt = job.date_found || null;
    appendWorkflowEvent(next, {
      type: 'discovered',
      source: 'migration',
      at: discoveredAt || now.toISOString(),
      label: discoveredAt ? '' : 'discovered date unknown — recorded at migration time',
    }, now);
  }

  const changed = !alreadyMigrated || !hasDiscovered;
  return { job: next, changed, notes };
}

export function migrateTracker(tracker, now = new Date()) {
  const result = {};
  const report = { totalJobs: 0, migrated: 0, alreadyMigrated: 0, notes: [] };
  for (const [id, job] of Object.entries(tracker)) {
    report.totalJobs += 1;
    const { job: migratedJob, changed, notes } = migrateJob(job, id, now);
    result[id] = migratedJob;
    if (changed) report.migrated += 1;
    else report.alreadyMigrated += 1;
    report.notes.push(...notes);
  }
  return { tracker: result, report };
}

function main() {
  const trackerPath = resolveTrackerPath();
  if (!fs.existsSync(trackerPath)) {
    console.error(`FATAL: tracker not found at ${trackerPath}`);
    process.exit(1);
  }

  const backupPath = backupTracker(trackerPath);
  const raw = JSON.parse(fs.readFileSync(trackerPath, 'utf8'));
  const { tracker: migrated, report } = migrateTracker(raw);

  // Validate before writing anything — fail loudly rather than write a
  // tracker.json the app itself would reject.
  validateTracker(JSON.parse(JSON.stringify(migrated)));

  const trackerStore = createTrackerStore({ trackerPath });
  trackerStore.saveTrackerAtomic(migrated);

  const fullReport = { generatedAt: new Date().toISOString(), backupPath, trackerPath, ...report };
  const reportPath = path.resolve(path.dirname(trackerPath), 'OPPORTUNITY_MIGRATION_REPORT.json');
  fs.writeFileSync(reportPath, JSON.stringify(fullReport, null, 2) + '\n');
  console.log(JSON.stringify(fullReport, null, 2));
}

const isDirectRun = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isDirectRun) {
  main();
}

export { main };
