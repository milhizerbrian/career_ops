// MUST be the first import — populates process.env before any other lib module
// reads it at module-eval time. See lib/env.mjs for the why.
import './lib/env.mjs';

import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

import { getCachedDashboard, invalidateCache } from './lib/cache.mjs';
import { loadBragDoc, loadJobById, loadPipeline, dismissPipelineItem, updateJob } from './lib/data.mjs';
import { updateTracker } from './lib/tracker-store.mjs';
import { generateResume, generateResumeDraft, generateResumeFinish, analyzeGaps } from './lib/resume-gen.mjs';
import { startWatcher } from './lib/watcher.mjs';
import { scoreAtsMatch } from './lib/ats-utils.mjs';
import { buildAbAnalytics, recordSubmission } from './lib/ab-analytics.mjs';
import { computeOiScore } from './lib/opportunity-intelligence.mjs';
import { evaluateUrl } from './lib/evaluator.mjs';
import { buildGeneratedDocEntry } from './lib/generated-docs.mjs';
import { normalizeStatus } from './lib/status-utils.mjs';
import { validatePublicHttpUrl } from './lib/url-safety.mjs';
import { analyzeBragDocQuality } from './lib/brag-quality.mjs';
import { cleanupResumeResourceProcesses } from './lib/resume-resource-cleanup.mjs';
import { appendWorkflowEvent, applyManualWorkflowEvent } from './lib/job-workflow.mjs';
import { upsertJobContact } from './lib/job-contacts.mjs';
import { createOutreachDraft, storeOutreachDraft } from './lib/outreach-drafts.mjs';
import {
  getRecruiterTargeting,
  updateRecruiterTargeting,
  generateRecruiterMessage,
  recordContactAttempt,
  buildRecruiterAnalytics,
} from './lib/recruiter-targeting.mjs';

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
const resumeRuns = new Map();

fs.mkdirSync(OUTPUT_DIR, { recursive: true });

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

// SPA entries for URL-addressable dashboard views
const SPA_ROUTES = ['/', '/dashboard', '/gmail-review', '/gmail-revoew', '/interviews', '/rejected'];
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
    const { jobs } = getCachedDashboard();
    res.json(buildRecruiterAnalytics(jobs));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/ab-analytics', (req, res) => {
  try {
    const { jobs } = getCachedDashboard();
    res.json(buildAbAnalytics(jobs));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/ab-submissions/:id', express.json(), (req, res) => {
  try {
    loadJobById(req.params.id);
    const submission = recordSubmission({
      jobId: req.params.id,
      variant: req.body.variant,
    });
    const { jobs } = getCachedDashboard();
    res.json({ submission, analytics: buildAbAnalytics(jobs) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Manually evaluate a job URL through the scoring pipeline
app.post('/api/evaluate-url', express.json(), async (req, res) => {
  const { url, company = '', title = '', fullDescription = '' } = req.body ?? {};
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'url is required and must be an http(s) URL' });
  }
  try {
    await validatePublicHttpUrl(url);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  // Respond immediately — progress comes via socket.io
  res.json({ started: true, url });

  try {
    const result = await evaluateUrl(url, {
      company,
      title,
      fullDescription,
      onProgress: (stage, msg) => {
        io.emit('eval-progress', { url, stage, message: msg });
      },
    });

    invalidateCache();
    if (result.alreadyExists) {
      io.emit('eval-complete', {
        url,
        id: result.id,
        alreadyExists: true,
        message: `Already in tracker (id: ${result.id}, score: ${result.entry.score})`,
      });
    } else {
      const entry = {
        ...result.entry,
        id: result.id,
        _oi:  computeOiScore(result.entry),
        _ats: scoreAtsMatch(result.entry, loadBragDoc()),
      };
      io.emit('eval-complete', {
        url,
        id: result.id,
        alreadyExists: false,
        score: entry.score,
        company: entry.company,
        title: entry.title,
        entry,
      });
    }
  } catch (err) {
    io.emit('eval-error', { url, message: err.message });
  }
});

// Update editable fields on a job
app.patch('/api/jobs/:id', express.json(), (req, res) => {
  const EDITABLE = ['company','title','status','location','url','score','compensation',
                    'employment_type','seniority','next_steps','notes','source'];
  try {
    const fields = Object.fromEntries(
      Object.entries(req.body ?? {}).filter(([k]) => EDITABLE.includes(k))
    );
    if (!Object.keys(fields).length) return res.status(400).json({ error: 'No editable fields provided' });
    const previous = loadJobById(req.params.id);
    if (fields.status !== undefined) fields.status = normalizeStatus(fields.status);
    fields.date_updated = new Date().toISOString().slice(0, 10);
    const result = updateJob(req.params.id, job => {
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
    res.json({ ok: true, job: result });
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
    loadJobById(req.params.id);
    const result = updateJob(req.params.id, job => applyManualWorkflowEvent(job, req.body));
    invalidateCache();
    res.json({ ok: true, job: result });
  } catch (err) {
    const status = err.message.includes('not found') ? 404 : 400;
    res.status(status).json({ error: err.message });
  }
});

app.post('/api/jobs/:id/contacts', express.json(), (req, res) => {
  try {
    loadJobById(req.params.id);
    let savedContact;
    const result = updateJob(req.params.id, job => {
      savedContact = upsertJobContact(job, req.body);
      return job;
    });
    invalidateCache();
    res.json({ ok: true, contact: savedContact, job: result });
  } catch (err) {
    const status = err.message.includes('not found') ? 404 : 400;
    res.status(status).json({ error: err.message });
  }
});

app.post('/api/jobs/:id/contacts/outreach-draft', express.json(), async (req, res) => {
  try {
    const currentJob = loadJobById(req.params.id);
    const draft = await createOutreachDraft(currentJob, req.body);
    const result = updateJob(req.params.id, job => {
      storeOutreachDraft(job, draft);
      return job;
    });
    invalidateCache();
    res.json({ ok: true, draft, job: result });
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
  const abTest = req.body?.abTest === true;
  try {
    loadJobById(jobId); // validate job exists
  } catch (err) {
    return res.status(404).json({ error: err.message });
  }
  const existingRun = resumeRuns.get(jobId);
  if (existingRun?.status === 'running') {
    return res.json({ started: true, jobId, alreadyRunning: true });
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
  res.json({ started: true, jobId });
  const runIo = resumeIo();
  try {
    if (abTest) {
      // Pipeline: load → LM A → (LM B ‖ Claude A) → docxA → Claude B → docxB.
      // Sharing the model load across both variants and overlapping Claude A
      // with LM B saves ~one Claude pass (~10–15s) per A/B run.
      const stateA = await generateResumeDraft(jobId, runIo, injectedSkills, 'technical');
      const [stateB, resA] = await Promise.all([
        generateResumeDraft(jobId, runIo, injectedSkills, 'outcomes'),
        generateResumeFinish(stateA),
      ]);
      saveGeneratedDoc(jobId, resA);
      const resB = await generateResumeFinish(stateB);
      saveGeneratedDoc(jobId, resB);
    } else {
      saveGeneratedDoc(jobId, await generateResume(jobId, runIo, injectedSkills));
    }
  } catch (err) {
    emitResumeEvent('progress', { jobId, stage: 'error', status: 'failed', message: err.message });
  } finally {
    cleanupResumeResourceProcesses().catch(err => {
      process.stderr.write(`[resume-cleanup] ${err.message}\n`);
    });
  }
});

app.use('/output', express.static(OUTPUT_DIR));
app.use(express.static(path.resolve(APP_ROOT, 'public')));

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
