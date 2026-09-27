// MUST be the first import — populates process.env before any other lib module
// reads it at module-eval time. See lib/env.mjs for the why.
import './lib/env.mjs';

import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

import { getCachedDashboard, getCachedValue, getCachedValueAsync, invalidateCache } from './lib/cache.mjs';
import { loadBragDoc, loadJobById, loadPipeline, dismissPipelineItem } from './lib/data.mjs';
import { updateTracker, updateJobWithPrevious } from './lib/tracker-store.mjs';
import { generateResume, analyzeGaps, generateGapQuestions, applyGapAnswersToBragDoc, assessStoredJobDescription } from './lib/resume-gen.mjs';
import { startWatcher } from './lib/watcher.mjs';
import { scoreAtsMatch } from './lib/ats-utils.mjs';
import { computeOiScore } from './lib/opportunity-intelligence.mjs';
import { buildGeneratedDocEntry } from './lib/generated-docs.mjs';
import { normalizeStatus } from './lib/status-utils.mjs';
import { analyzeBragDocQuality } from './lib/brag-quality.mjs';
import { beginSharedResumeResources, canStartResumeRun, resumeMaxConcurrent } from './lib/resume-run-coordinator.mjs';
import { appendWorkflowEvent, applyManualWorkflowEvent } from './lib/job-workflow.mjs';
import { upsertJobContact } from './lib/job-contacts.mjs';
import { upsertInterviewRound } from './lib/interview-rounds.mjs';
import { buildOutcomeIntelligence } from './lib/outcome-intelligence.mjs';
import { createOutreachDraft, storeOutreachDraft } from './lib/outreach-drafts.mjs';
import {
  getRecruiterTargeting,
  updateRecruiterTargeting,
  generateRecruiterMessage,
  recordContactAttempt,
  buildRecruiterAnalytics,
} from './lib/recruiter-targeting.mjs';
import {
  buildAnalyticsSummary,
  buildContactsWorkspace,
  buildJobReadModel,
  buildOutreachWorkspace,
  buildResumeWorkspace,
  buildSettingsHealth,
} from './lib/workspace-read-models.mjs';
import { listOpportunities, changeStage, updateOpportunity } from './lib/opportunity-store.mjs';
import { buildActions, buildHomeSummary, recordActionDecision, actionId } from './lib/action-engine.mjs';
import { getOpenQuestions, answerQuestion } from './lib/candidate-questions.mjs';
import { buildOpportunityWorkspace } from './lib/opportunity-workspace.mjs';
import { buildEvidenceVault, addFact, updateFact, promoteQuestionToEvidence } from './lib/evidence-vault.mjs';
import { runHealthChecks } from './scripts/health-check.mjs';

const APP_ROOT = path.dirname(fileURLToPath(import.meta.url));

// Manual .env parsing (no dotenv package)
try {
  const envPath = path.resolve(APP_ROOT, '.env');
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const m = line.match(/^([^#=\s][^=]*)=(.*)$/);
      if (m) process.env[m[1].trim()] ??= m[2].trim();
    }
  }
} catch { /* ignore */ }

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);
const PORT = parseInt(process.env.PORT ?? '3000', 10);
const OUTPUT_DIR = path.resolve(APP_ROOT, 'output');
const STATIC_DIR = path.resolve(APP_ROOT, 'public');
const resumeRuns = new Map();
let resumeRunsVersion = 0;

fs.mkdirSync(OUTPUT_DIR, { recursive: true });

function bumpResumeRunsVersion() {
  resumeRunsVersion += 1;
}

function computedJobReadModel(job) {
  return buildJobReadModel(job, { bragDoc: loadBragDoc() });
}

function cachedJobById(jobId) {
  const { jobs } = getCachedDashboard();
  const job = jobs.find(item => item.id === jobId);
  if (!job) throw new Error(`Job not found in tracker: ${jobId}`);
  return job;
}

function resumeRun(jobId) {
  if (!resumeRuns.has(jobId)) {
    resumeRuns.set(jobId, {
      jobId,
      status: 'running',
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      events: [],
      complete: null,
      error: null,
    });
    bumpResumeRunsVersion();
  }
  return resumeRuns.get(jobId);
}

function recordResumeEvent(jobId, event, payload = {}) {
  const run = resumeRun(jobId);
  const entry = { event, at: new Date().toISOString(), ...payload };
  run.events.push(entry);
  run.events = run.events.slice(-80);
  run.updatedAt = entry.at;
  if (event === 'complete') {
    run.status = 'complete';
    run.complete = payload;
  }
  if (event === 'progress' && (payload.status === 'failed' || String(payload.stage || '').startsWith('error'))) {
    run.status = 'failed';
    run.error = payload.message || 'Resume generation failed';
  }
  bumpResumeRunsVersion();
  return entry;
}

function emitResumeEvent(event, payload) {
  if (payload?.jobId) recordResumeEvent(payload.jobId, event, payload);
  io.emit(event, payload);
}

function resumeIo() {
  return {
    emit(event, payload) {
      emitResumeEvent(event, payload);
    },
  };
}

function runningResumeCount() {
  return [...resumeRuns.values()].filter(run => run.status === 'running').length;
}

// SPA entries for URL-addressable dashboard views
const SPA_ROUTES = [
  '/',
  '/dashboard',
  '/jobs',
  '/jobs/:id',
  '/resume',
  '/outreach',
  '/contacts',
  '/gmail-review',
  '/interviews',
  '/rejected',
  '/analytics',
  '/settings',
];
app.get(SPA_ROUTES, (req, res) => {
  res.sendFile(path.resolve(APP_ROOT, 'public', 'index.html'));
});

// Lightweight jobs list for table rendering (no full report data)
app.get('/api/jobs', (req, res) => {
  try {
    const { jobs } = getCachedDashboard();
    res.json(jobs.map(j => ({
      id:           j.id,
      company:      j.company || '',
      title:        j.title || '',
      next_steps:   j.next_steps || '',
      status:       normalizeStatus(j.status),
      url:          j.url || '',
      date_updated: j.date_updated || '',
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/jobs/:id', (req, res) => {
  try {
    const { jobs } = getCachedDashboard();
    const job = jobs.find(item => item.id === req.params.id);
    if (!job) return res.status(404).json({ error: `Job not found in tracker: ${req.params.id}` });
    res.json(buildJobReadModel(job, { bragDoc: loadBragDoc() }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Full dashboard payload (jobs + profile + build timestamp)
app.get('/api/dashboard', (req, res) => {
  try {
    res.json(getCachedDashboard());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/resume-runs', (req, res) => {
  res.json([...resumeRuns.values()]);
});

app.get('/api/brag-quality', (req, res) => {
  try {
    res.json(analyzeBragDocQuality(loadBragDoc()));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/workspaces/resume', (req, res) => {
  try {
    res.json(getCachedValue(`workspace:resume:${resumeRunsVersion}`, () => {
      const { jobs } = getCachedDashboard();
      return buildResumeWorkspace(jobs, {
        resumeRuns: [...resumeRuns.values()],
        sourceQuality: analyzeBragDocQuality(loadBragDoc()),
        assessJobDescription: assessStoredJobDescription,
      });
    }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/workspaces/outreach', (req, res) => {
  try {
    res.json(getCachedValue('workspace:outreach', () => {
      const { jobs } = getCachedDashboard();
      return buildOutreachWorkspace(jobs);
    }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/workspaces/contacts', (req, res) => {
  try {
    res.json(getCachedValue('workspace:contacts', () => {
      const { jobs } = getCachedDashboard();
      return buildContactsWorkspace(jobs);
    }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/analytics/summary', (req, res) => {
  try {
    res.json(getCachedValue('analytics:summary', () => {
      const { jobs } = getCachedDashboard();
      return buildAnalyticsSummary(jobs);
    }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Phase 10: Outcome Intelligence — deterministic funnel/segment/timing read
// model over the same cached dashboard jobs (lib/outcome-intelligence.mjs).
app.get('/api/analytics/outcomes', (req, res) => {
  try {
    res.json(getCachedValue('analytics:outcomes', () => buildOutcomeIntelligence(getCachedDashboard().jobs)));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/settings/health', async (req, res) => {
  try {
    res.json(await getCachedValueAsync('settings:health', () => buildSettingsHealth({ runHealthChecks })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Phase 3: Daily Command Center ─────────────────────────────────────────
// Home-screen payload: derived fresh from Phase 1 opportunities + Phase 2
// open questions on every (cache-invalidated) build — see lib/action-engine.mjs
// for why actions are computed, not stored.
function buildHomePayload() {
  const opportunities = listOpportunities();
  const openQuestions = getOpenQuestions();
  const actions = buildActions(opportunities, { openQuestions });
  return { ...buildHomeSummary(opportunities, actions), generatedAt: new Date().toISOString() };
}

app.get('/api/home', (req, res) => {
  try {
    res.json(getCachedValue('home', buildHomePayload));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Complete / skip / snooze / reopen a single action. `id` is `${opportunityId}:${type}`.
app.post('/api/actions/:id/decision', express.json(), (req, res) => {
  try {
    const { decision, snoozeDays } = req.body ?? {};
    const record = recordActionDecision(decodeURIComponent(req.params.id), decision, { snoozeDays });
    invalidateCache();
    res.json({ ok: true, record, home: getCachedValue('home', buildHomePayload) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Quick decision on a discovered/qualified opportunity: Pursue / Not Interested / Snooze.
app.post('/api/opportunities/:id/quick-decision', express.json(), (req, res) => {
  try {
    const { decision } = req.body ?? {};
    const id = req.params.id;
    const reviewActionId = actionId(id, 'review_opportunity');
    if (decision === 'pursue') {
      changeStage(id, 'pursuing', { reason: 'Quick decision: pursue', actor: 'quick-decision' });
      recordActionDecision(reviewActionId, 'complete');
    } else if (decision === 'not_interested') {
      changeStage(id, 'rejected', { reason: 'Quick decision: not interested', actor: 'quick-decision' });
      recordActionDecision(reviewActionId, 'complete');
    } else if (decision === 'snooze') {
      recordActionDecision(reviewActionId, 'snooze', { snoozeDays: req.body?.snoozeDays });
    } else {
      return res.status(400).json({ error: `Unsupported decision: ${decision}` });
    }
    invalidateCache();
    res.json({ ok: true, home: getCachedValue('home', buildHomePayload) });
  } catch (err) {
    res.status(err.message?.includes('not found') ? 404 : 400).json({ error: err.message });
  }
});

// ─── Phase 4: Opportunity Workspace ─────────────────────────────────────────
// Single-page read model for one Opportunity (Overview/Fit/Resume/Contacts/
// Application/Interview/Activity tabs) — see lib/opportunity-workspace.mjs.
app.get('/api/opportunities/:id/workspace', (req, res) => {
  try {
    res.json(buildOpportunityWorkspace(req.params.id));
  } catch (err) {
    res.status(err.code === 'OPPORTUNITY_NOT_FOUND' ? 404 : 500).json({ error: err.message });
  }
});

// Application-tab fields, plus priority — a subset of opportunity-store.mjs's
// DIRECTLY_UPDATABLE_FIELDS. Company/title/etc. stay on the existing
// PATCH /api/jobs/:id route (the workspace header's "Edit" button) to avoid
// two edit paths for the same raw job fields.
const OPPORTUNITY_EDITABLE_FIELDS = [
  'priority', 'nextAction', 'nextActionDate',
  'appliedDate', 'resumeVersion', 'coverLetterVersion', 'referral', 'applicationSource',
  'outcomeStatus', 'closedDate', 'outcomeReason',
];
app.patch('/api/opportunities/:id', express.json(), (req, res) => {
  try {
    const fields = Object.fromEntries(
      Object.entries(req.body ?? {}).filter(([k]) => OPPORTUNITY_EDITABLE_FIELDS.includes(k))
    );
    if (!Object.keys(fields).length) return res.status(400).json({ error: 'No editable fields provided' });
    updateOpportunity(req.params.id, fields);
    invalidateCache();
    res.json({ ok: true, workspace: buildOpportunityWorkspace(req.params.id) });
  } catch (err) {
    res.status(err.message.includes('not found') ? 404 : 400).json({ error: err.message });
  }
});

// "Change Stage" quick action — any stage, any opportunity (unlike quick-decision
// above, which is specifically the Phase 3 review_opportunity action).
app.post('/api/opportunities/:id/stage', express.json(), (req, res) => {
  try {
    changeStage(req.params.id, req.body?.stage, { reason: req.body?.reason || '', actor: 'workspace' });
    invalidateCache();
    res.json({ ok: true, workspace: buildOpportunityWorkspace(req.params.id) });
  } catch (err) {
    res.status(err.message.includes('not found') ? 404 : 400).json({ error: err.message });
  }
});

// ─── Phase 9.1: Interview rounds ───────────────────────────────────────────
// Create / partially update a round on job.interviews[] (lib/interview-rounds.mjs).
// Rounds never change the Opportunity stage — use the stage route for that.
function saveInterviewRound(req, res, payload) {
  try {
    let round;
    updateJobWithPrevious(req.params.id, job => {
      round = upsertInterviewRound(job, payload);
      return job;
    });
    invalidateCache();
    res.json({ ok: true, round, workspace: buildOpportunityWorkspace(req.params.id) });
  } catch (err) {
    res.status(err.message.includes('not found') ? 404 : 400).json({ error: err.message });
  }
}

app.post('/api/opportunities/:id/interviews', express.json(), (req, res) => {
  const { id: _ignored, ...payload } = req.body ?? {};
  saveInterviewRound(req, res, payload);
});

app.patch('/api/opportunities/:id/interviews/:roundId', express.json(), (req, res) => {
  saveInterviewRound(req, res, { ...(req.body ?? {}), id: req.params.roundId });
});

// Answers a persisted candidate-clarification question (Phase 2's
// candidate-questions.mjs — the "existing mechanism" the Fit tab's Unknowns
// surface for Brian to resolve).
app.post('/api/candidate-questions/:id/answer', express.json(), (req, res) => {
  try {
    const question = answerQuestion(req.params.id, req.body?.answer ?? '');
    invalidateCache();
    res.json({ ok: true, question });
  } catch (err) {
    res.status(err.message.includes('not found') ? 404 : 400).json({ error: err.message });
  }
});

// ─── Phase 5: Career Evidence Vault ─────────────────────────────────────────
// UI over Phase 0's canonical candidate fact files — see
// lib/evidence-vault.mjs. Never a second candidate database: reads/writes
// the same data/candidate/*.json files Phase 2 scoring and resume
// generation already read.
app.get('/api/evidence-vault', (req, res) => {
  try {
    res.json(buildEvidenceVault());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/evidence-vault/:category', express.json(), (req, res) => {
  try {
    const fact = addFact(req.params.category, req.body ?? {});
    invalidateCache();
    res.json({ ok: true, fact, vault: buildEvidenceVault() });
  } catch (err) {
    res.status(err.code === 'DUPLICATE_EVIDENCE' ? 409 : 400).json({ error: err.message, existingId: err.existingId });
  }
});

app.patch('/api/evidence-vault/:category/:id', express.json(), (req, res) => {
  try {
    const fact = updateFact(req.params.category, req.params.id, req.body ?? {});
    invalidateCache();
    res.json({ ok: true, fact, vault: buildEvidenceVault() });
  } catch (err) {
    res.status(err.code === 'EVIDENCE_NOT_FOUND' ? 404 : 400).json({ error: err.message });
  }
});

// Turns an already-answered Phase 2 candidate question into a verified,
// resume-usable fact — only when the caller explicitly confirms, so
// answering a question never silently converts it into evidence.
app.post('/api/candidate-questions/:id/promote', express.json(), (req, res) => {
  try {
    const { confirm, category, employer, tags } = req.body ?? {};
    const result = promoteQuestionToEvidence(req.params.id, { confirm, category, employer, tags });
    invalidateCache();
    res.json({ ok: true, ...result });
  } catch (err) {
    const status = err.code === 'QUESTION_NOT_FOUND' ? 404
      : err.code === 'CONFIRMATION_REQUIRED' ? 400
      : 400;
    res.status(status).json({ error: err.message });
  }
});

app.get('/api/pipeline', (req, res) => {
  try {
    res.json(loadPipeline());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/pipeline/dismiss', express.json(), (req, res) => {
  try {
    dismissPipelineItem(req.body.url);
    res.json({ ok: true, remaining: loadPipeline() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/analyze-gaps/:id', async (req, res) => {
  const jobId = req.params.id;
  try {
    const missingSkills = await analyzeGaps(jobId);
    res.json({ missingSkills });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/resume-gap-questions/:id', async (req, res) => {
  try {
    res.json({ questions: await generateGapQuestions(req.params.id) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/resume-gap-answers/:id', express.json(), async (req, res) => {
  try {
    loadJobById(req.params.id);
    const result = await applyGapAnswersToBragDoc(req.params.id, req.body?.answers || []);
    invalidateCache();
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/ats-score/:id', (req, res) => {
  const jobId = req.params.id;
  try {
    const job = loadJobById(jobId);
    const score = scoreAtsMatch(job, loadBragDoc());
    res.json(score);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/oi-score/:id', (req, res) => {
  try {
    const job = loadJobById(req.params.id);
    res.json(computeOiScore(job));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Recruiter Targeting ───────────────────────────────────────────────────────

app.get('/api/recruiter-targeting/:id', (req, res) => {
  try {
    const job = loadJobById(req.params.id);
    res.json(getRecruiterTargeting(job));
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

app.post('/api/recruiter-targeting/:id', express.json(), (req, res) => {
  try {
    const result = updateRecruiterTargeting(req.params.id, req.body);
    invalidateCache();
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/recruiter-targeting/:id/generate-message', async (req, res) => {
  try {
    const message = await generateRecruiterMessage(req.params.id);
    invalidateCache();
    res.json({ message });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/recruiter-targeting/:id/contact-attempt', express.json(), (req, res) => {
  try {
    const result = recordContactAttempt(req.params.id, req.body);
    invalidateCache();
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/recruiter-analytics', (req, res) => {
  try {
    res.json(getCachedValue('recruiter:analytics', () => {
      const { jobs } = getCachedDashboard();
      return buildRecruiterAnalytics(jobs);
    }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/evaluate-url', express.json(), (req, res) => {
  res.status(410).json({ error: 'Dashboard job search ingestion is disabled.' });
});

// Update editable fields on a job
app.patch('/api/jobs/:id', express.json(), (req, res) => {
  const EDITABLE = ['company','title','status','location','url','score','compensation',
                    'employment_type','seniority','next_steps','notes','source','flagged'];
  try {
    const fields = Object.fromEntries(
      Object.entries(req.body ?? {}).filter(([k]) => EDITABLE.includes(k))
    );
    if (!Object.keys(fields).length) return res.status(400).json({ error: 'No editable fields provided' });
    if (fields.status !== undefined) fields.status = normalizeStatus(fields.status);
    const flagOnly = Object.keys(fields).every(k => k === 'flagged');
    if (!flagOnly) fields.date_updated = new Date().toISOString().slice(0, 10);
    const { updated: result } = updateJobWithPrevious(req.params.id, (job, previous) => {
      const next = { ...job, ...fields };
      if (fields.status && fields.status !== normalizeStatus(previous.status)) {
        const eventType = fields.status === 'applied'
          ? 'applied'
          : fields.status === 'rejected'
            ? 'rejected'
            : ['recruiter_screen', 'hiring_manager_screen', 'technical_screen', 'onsite'].includes(fields.status)
              ? 'interview_scheduled'
              : null;
        if (eventType) appendWorkflowEvent(next, { type: eventType, source: 'status', label: fields.status });
      }
      return next;
    });
    invalidateCache();
    res.json({ ok: true, job: computedJobReadModel(result) });
  } catch (err) {
    res.status(err.message.includes('not found') ? 404 : 500).json({ error: err.message });
  }
});

// Delete a job from tracker.json
app.delete('/api/jobs/:id', (req, res) => {
  try {
    let found = false;
    updateTracker(tracker => {
      if (!tracker[req.params.id]) return;
      found = true;
      delete tracker[req.params.id];
    });
    if (!found) return res.status(404).json({ error: 'Job not found' });
    invalidateCache();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/jobs/:id/workflow-event', express.json(), (req, res) => {
  try {
    const { updated: result } = updateJobWithPrevious(req.params.id, job => applyManualWorkflowEvent(job, req.body));
    invalidateCache();
    res.json({ ok: true, job: computedJobReadModel(result) });
  } catch (err) {
    const status = err.message.includes('not found') ? 404 : 400;
    res.status(status).json({ error: err.message });
  }
});

app.post('/api/jobs/:id/contacts', express.json(), (req, res) => {
  try {
    let savedContact;
    const { updated: result } = updateJobWithPrevious(req.params.id, job => {
      savedContact = upsertJobContact(job, req.body);
      return job;
    });
    invalidateCache();
    res.json({ ok: true, contact: savedContact, job: computedJobReadModel(result) });
  } catch (err) {
    const status = err.message.includes('not found') ? 404 : 400;
    res.status(status).json({ error: err.message });
  }
});

app.post('/api/jobs/:id/contacts/outreach-draft', express.json(), async (req, res) => {
  try {
    const currentJob = cachedJobById(req.params.id);
    const draft = await createOutreachDraft(currentJob, req.body);
    const { updated: result } = updateJobWithPrevious(req.params.id, job => {
      storeOutreachDraft(job, draft);
      return job;
    });
    invalidateCache();
    res.json({ ok: true, draft, job: computedJobReadModel(result) });
  } catch (err) {
    const status = err.message.includes('not found') ? 404 : 400;
    res.status(status).json({ error: err.message });
  }
});

// Gmail jobs from broad scan (data/gmail-jobs.json)
app.get('/api/gmail-jobs', async (req, res) => {
  try {
    const { loadGmailJobs, listAmbiguousGmailJobs } = await import('./gmail-sync.mjs');
    const jobs = loadGmailJobs();
    res.json(req.query.ambiguous === '1' ? listAmbiguousGmailJobs(jobs) : jobs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/gmail-jobs/:threadId/attach', express.json(), async (req, res) => {
  try {
    const { attachGmailAmbiguityToJob } = await import('./gmail-sync.mjs');
    const result = attachGmailAmbiguityToJob(req.params.threadId, req.body?.jobId);
    invalidateCache();
    res.json(result);
  } catch (err) {
    res.status(err.message.includes('not found') ? 404 : 400).json({ error: err.message });
  }
});

app.post('/api/gmail-jobs/:threadId/dismiss', express.json(), async (req, res) => {
  try {
    const { dismissGmailAmbiguity } = await import('./gmail-sync.mjs');
    const result = dismissGmailAmbiguity(req.params.threadId);
    res.json(result);
  } catch (err) {
    res.status(err.message.includes('not found') ? 404 : 400).json({ error: err.message });
  }
});

// Gmail sync — triggers both tracker sync + broad scan; progress via socket.io
app.post('/api/gmail-sync', express.json(), async (req, res) => {
  const { jobId } = req.body ?? {};
  res.json({ started: true, jobId: jobId || null });
  try {
    const { runGmailSync, runBroadGmailScan } = await import('./gmail-sync.mjs');
    await runGmailSync({
      jobId: jobId || null,
      onProgress: (id, company, status, nextSteps) =>
        io.emit('gmail-sync-progress', { jobId: id, company, status, nextSteps }),
    });
    invalidateCache();
    // Run broad scan unless targeting a single job
    if (!jobId) {
      await runBroadGmailScan({
        onProgress: (id, company, status, nextSteps) =>
          io.emit('gmail-sync-progress', { jobId: id, company, status, nextSteps }),
      });
    }
    io.emit('gmail-sync-complete', { jobId: jobId || null });
  } catch (err) {
    io.emit('gmail-sync-error', { message: err.message });
  }
});

function saveGeneratedDoc(jobId, result) {
  try {
    updateTracker(tracker => {
      if (!tracker[jobId]) return;
      if (!tracker[jobId].generatedDocs) tracker[jobId].generatedDocs = {};
      appendWorkflowEvent(tracker[jobId], {
        type: 'resume_generated',
        at: result.generatedAt,
        source: 'resume',
        label: result.docxFilename || result.docxUrl || '',
      });
      const variant = result.variant ?? 'default';
      const job = {
        id: jobId,
        ...tracker[jobId],
        _ats: scoreAtsMatch({ id: jobId, ...tracker[jobId] }, loadBragDoc()),
      };
      tracker[jobId].generatedDocs[variant] = buildGeneratedDocEntry(result, {
        job,
        jobId,
        previousEntry: tracker[jobId].generatedDocs[variant],
      });
    });
    invalidateCache();
  } catch (e) {
    process.stderr.write(`[saveGeneratedDoc] ${e.message}\n`);
  }
}

// Resume generation — responds immediately; progress comes via socket.io
app.post('/api/create-docs/:id', express.json(), async (req, res) => {
  const jobId = req.params.id;
  const injectedSkills = req.body?.injectedSkills || '';
  try {
    loadJobById(jobId); // validate job exists
  } catch (err) {
    return res.status(404).json({ error: err.message });
  }
  const existingRun = resumeRuns.get(jobId);
  if (existingRun?.status === 'running') {
    return res.json({ started: true, jobId, alreadyRunning: true });
  }
  const runningCount = runningResumeCount();
  if (!canStartResumeRun({ runningCount })) {
    return res.status(429).json({
      error: `Resume generation limit reached (${runningCount}/${resumeMaxConcurrent()})`,
      runningCount,
      maxConcurrent: resumeMaxConcurrent(),
    });
  }
  const jdAssessment = assessStoredJobDescription(jobId);
  if (!jdAssessment.usable) {
    process.stdout.write(`[resume-jd-review] job=${jobId} source=${jdAssessment.source} score=${jdAssessment.score.toFixed(2)}\n`);
    return res.status(422).json({
      error: 'Resume generation blocked: saved job description looks incomplete or generic. Refresh the role with the full posting before drafting.',
      needsJobDescriptionReview: true,
      jobId,
      jdAssessment,
    });
  }
  if (!req.body?.gapReviewComplete) {
    const questions = await generateGapQuestions(jobId);
    process.stdout.write(`[resume-gap-review] job=${jobId} requested=true questions=${questions.length}\n`);
    if (questions.length) return res.json({ started: false, needsGapReview: true, jobId, questions });
  } else {
    process.stdout.write(`[resume-gap-review] job=${jobId} requested=false reason=client_marked_complete\n`);
  }
  resumeRuns.set(jobId, {
    jobId,
    status: 'running',
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    events: [],
    complete: null,
    error: null,
  });
  bumpResumeRunsVersion();
  res.json({ started: true, jobId });
  const runIo = resumeIo();
  const resources = beginSharedResumeResources();
  try {
    saveGeneratedDoc(jobId, await generateResume(jobId, runIo, injectedSkills));
  } catch (err) {
    emitResumeEvent('progress', { jobId, stage: 'error', status: 'failed', message: err.message });
  } finally {
    await resources.release().catch(err => {
      process.stderr.write(`[resume-cleanup] ${err.message}\n`);
    });
  }
});

app.use('/output', express.static(OUTPUT_DIR));
app.use('/vendor', express.static(path.resolve(STATIC_DIR, 'vendor'), {
  maxAge: '30d',
  immutable: true,
}));
app.use('/css', express.static(path.resolve(STATIC_DIR, 'css'), {
  maxAge: '1h',
  etag: true,
}));
app.use('/js', express.static(path.resolve(STATIC_DIR, 'js'), {
  maxAge: '1h',
  etag: true,
}));
app.use(express.static(STATIC_DIR, {
  maxAge: 0,
  etag: true,
}));

io.on('connection', socket => {
  process.stdout.write(`[socket.io] connected: ${socket.id}\n`);
});

export function createApp() {
  return app;
}

export function startServer({ port = PORT } = {}) {
  startWatcher();
  return httpServer.listen(port, () => {
    process.stdout.write(`career-ops running at http://localhost:${port}\n`);
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startServer();
}
