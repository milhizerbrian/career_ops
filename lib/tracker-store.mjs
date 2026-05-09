import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { CANONICAL_STATUSES, normalizeStatus } from './status-utils.mjs';
import { WORKFLOW_EVENT_TYPES, normalizeWorkflowTimeline } from './job-workflow.mjs';
import { CONTACT_RELATIONSHIP_TYPES, CONTACT_RESPONSE_STATUSES, normalizeContacts } from './job-contacts.mjs';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_TRACKER_PATH = path.resolve(APP_ROOT, 'data', 'tracker.json');

const VALID_STATUSES = new Set(CANONICAL_STATUSES);
const VALID_WORKFLOW_EVENTS = new Set(WORKFLOW_EVENT_TYPES);
const VALID_CONTACT_RELATIONSHIPS = new Set(CONTACT_RELATIONSHIP_TYPES);
const VALID_CONTACT_RESPONSES = new Set(CONTACT_RESPONSE_STATUSES);
const VALID_OUTREACH_DRAFT_TYPES = new Set(['linkedin_connection', 'linkedin_follow_up', 'email']);

function isSafeContactUrl(value) {
  if (value == null || value === '') return true;
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol);
  } catch {
    return false;
  }
}

function isSafeContactEmail(value) {
  return value == null || value === '' || (
    typeof value === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
  );
}

function isSafeContactDate(value) {
  return value == null || value === '' || (
    typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  );
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value ?? {}));
}

function normalizeTrackerStatus(status) {
  if (status == null || status === '') return status;
  const normalized = normalizeStatus(status);
  if (!VALID_STATUSES.has(normalized)) {
    throw new Error(`Invalid tracker: unsupported status "${status}"`);
  }
  return normalized;
}

export function validateTracker(tracker) {
  if (!tracker || typeof tracker !== 'object' || Array.isArray(tracker)) {
    throw new Error('Invalid tracker: root must be an object');
  }

  for (const [id, job] of Object.entries(tracker)) {
    if (!id || typeof id !== 'string') throw new Error('Invalid tracker: job id must be a non-empty string');
    if (!job || typeof job !== 'object' || Array.isArray(job)) {
      throw new Error(`Invalid tracker: job "${id}" must be an object`);
    }
    if (job.company != null && typeof job.company !== 'string') {
      throw new Error(`Invalid tracker: job "${id}" company must be a string`);
    }
    if (job.title != null && typeof job.title !== 'string') {
      throw new Error(`Invalid tracker: job "${id}" title must be a string`);
    }
    if (job.status != null) job.status = normalizeTrackerStatus(job.status);
    if (job.generatedDocs != null && (typeof job.generatedDocs !== 'object' || Array.isArray(job.generatedDocs))) {
      throw new Error(`Invalid tracker: job "${id}" generatedDocs must be an object`);
    }
    if (job.workflowTimeline != null) {
      if (!Array.isArray(job.workflowTimeline)) {
        throw new Error(`Invalid tracker: job "${id}" workflowTimeline must be an array`);
      }
      for (const event of job.workflowTimeline) {
        if (!event || typeof event !== 'object' || Array.isArray(event)) {
          throw new Error(`Invalid tracker: job "${id}" workflowTimeline events must be objects`);
        }
        if (!VALID_WORKFLOW_EVENTS.has(event.type)) {
          throw new Error(`Invalid tracker: job "${id}" unsupported workflow event "${event.type}"`);
        }
      }
      job.workflowTimeline = normalizeWorkflowTimeline(job.workflowTimeline);
    }
    if (job.contacts != null) {
      if (!Array.isArray(job.contacts)) {
        throw new Error(`Invalid tracker: job "${id}" contacts must be an array`);
      }
      for (const contact of job.contacts) {
        if (!contact || typeof contact !== 'object' || Array.isArray(contact)) {
          throw new Error(`Invalid tracker: job "${id}" contacts must contain objects`);
        }
        if (!contact.name || typeof contact.name !== 'string') {
          throw new Error(`Invalid tracker: job "${id}" contact name is required`);
        }
        if (contact.relationshipType != null && !VALID_CONTACT_RELATIONSHIPS.has(contact.relationshipType)) {
          throw new Error(`Invalid tracker: job "${id}" unsupported contact relationship "${contact.relationshipType}"`);
        }
        if (contact.responseStatus != null && !VALID_CONTACT_RESPONSES.has(contact.responseStatus)) {
          throw new Error(`Invalid tracker: job "${id}" unsupported contact response "${contact.responseStatus}"`);
        }
        if (!isSafeContactUrl(contact.linkedinUrl)) {
          throw new Error(`Invalid tracker: job "${id}" contact linkedinUrl must be http(s)`);
        }
        if (!isSafeContactEmail(contact.email)) {
          throw new Error(`Invalid tracker: job "${id}" contact email is invalid`);
        }
        if (!isSafeContactDate(contact.followUpDue)) {
          throw new Error(`Invalid tracker: job "${id}" contact followUpDue must use YYYY-MM-DD`);
        }
        if (contact.outreachDrafts != null) {
          if (!Array.isArray(contact.outreachDrafts)) {
            throw new Error(`Invalid tracker: job "${id}" contact outreachDrafts must be an array`);
          }
          for (const draft of contact.outreachDrafts) {
            if (!draft || typeof draft !== 'object' || Array.isArray(draft)) {
              throw new Error(`Invalid tracker: job "${id}" contact outreachDrafts must contain objects`);
            }
            if (!VALID_OUTREACH_DRAFT_TYPES.has(draft.type)) {
              throw new Error(`Invalid tracker: job "${id}" unsupported outreach draft type "${draft.type}"`);
            }
            if (!draft.text || typeof draft.text !== 'string') {
              throw new Error(`Invalid tracker: job "${id}" outreach draft text is required`);
            }
            if (!draft.generatedAt || typeof draft.generatedAt !== 'string') {
              throw new Error(`Invalid tracker: job "${id}" outreach draft generatedAt is required`);
            }
            if (!draft.contactId || typeof draft.contactId !== 'string') {
              throw new Error(`Invalid tracker: job "${id}" outreach draft contactId is required`);
            }
          }
        }
      }
      job.contacts = normalizeContacts(job.contacts);
    }
  }

  return tracker;
}

export function createTrackerStore({ trackerPath = DEFAULT_TRACKER_PATH, lockTimeoutMs = 5000 } = {}) {
  const lockPath = `${trackerPath}.lock`;

  function loadTracker() {
    if (!fs.existsSync(trackerPath)) return {};
    return JSON.parse(fs.readFileSync(trackerPath, 'utf8'));
  }

  function acquireLock() {
    const started = Date.now();
    while (true) {
      try {
        fs.mkdirSync(lockPath);
        fs.writeFileSync(path.join(lockPath, 'owner'), `${process.pid}\n${new Date().toISOString()}\n`, 'utf8');
        return () => {
          try { fs.rmSync(lockPath, { recursive: true, force: true }); } catch {}
        };
      } catch (err) {
        if (err.code !== 'EEXIST') throw err;
        if (Date.now() - started > lockTimeoutMs) {
          throw new Error(`Timed out waiting for tracker lock: ${lockPath}`);
        }
        try {
          const ageMs = Date.now() - fs.statSync(lockPath).mtimeMs;
          if (ageMs > Math.max(lockTimeoutMs * 2, 30_000)) {
            fs.rmSync(lockPath, { recursive: true, force: true });
            continue;
          }
        } catch {}
        sleepSync(25);
      }
    }
  }

  function saveTrackerAtomic(nextTracker) {
    const normalized = validateTracker(clone(nextTracker));
    fs.mkdirSync(path.dirname(trackerPath), { recursive: true });
    const tmpPath = path.resolve(
      path.dirname(trackerPath),
      `.${path.basename(trackerPath)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`
    );

    try {
      const fd = fs.openSync(tmpPath, 'w');
      try {
        fs.writeFileSync(fd, JSON.stringify(normalized, null, 2) + '\n', 'utf8');
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(tmpPath, trackerPath);
      try {
        const dirFd = fs.openSync(path.dirname(trackerPath), 'r');
        try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
      } catch {}
      return normalized;
    } catch (err) {
      try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch {}
      throw err;
    }
  }

  function updateTracker(mutatorFn) {
    if (typeof mutatorFn !== 'function') throw new Error('updateTracker requires a mutator function');
    const release = acquireLock();
    try {
      const current = loadTracker();
      const draft = clone(current);
      const maybeNext = mutatorFn(draft);
      const next = maybeNext && typeof maybeNext === 'object' ? maybeNext : draft;
      return saveTrackerAtomic(next);
    } finally {
      release();
    }
  }

  function updateJob(jobId, mutatorFn) {
    if (!jobId || typeof jobId !== 'string') throw new Error('jobId is required');
    let updated;
    updateTracker(tracker => {
      if (!tracker[jobId]) throw new Error(`Job not found in tracker: ${jobId}`);
      const existingGeneratedDocs = tracker[jobId].generatedDocs;
      const maybeNext = mutatorFn(tracker[jobId]);
      if (maybeNext && typeof maybeNext === 'object') tracker[jobId] = maybeNext;
      if (existingGeneratedDocs && tracker[jobId].generatedDocs === undefined) {
        tracker[jobId].generatedDocs = existingGeneratedDocs;
      }
      updated = { id: jobId, ...tracker[jobId] };
    });
    return updated;
  }

  return { loadTracker, saveTrackerAtomic, updateTracker, updateJob, validateTracker };
}

const defaultStore = createTrackerStore();

export const loadTracker = defaultStore.loadTracker;
export const saveTrackerAtomic = defaultStore.saveTrackerAtomic;
export const updateTracker = defaultStore.updateTracker;
export const updateJob = defaultStore.updateJob;
