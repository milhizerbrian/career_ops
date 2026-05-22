import {
  attachGmailAmbiguity,
  createDocs,
  deleteJobRequest,
  dismissGmailAmbiguity,
  evaluateUrl,
  fetchAnalyticsSummary,
  fetchAmbiguousGmailJobs,
  fetchContactsWorkspace,
  fetchDashboard,
  fetchJobDetail,
  fetchOutreachWorkspace,
  fetchResumeRuns,
  fetchResumeWorkspace,
  fetchSettingsHealth,
  generateContactOutreachDraft,
  patchJob,
  postWorkflowEvent,
  submitResumeGapAnswers,
  upsertJobContact,
} from './api.js';
import { sortJobsBy } from './jobs-table.js';
import { EVAL_STAGE_LABELS, STAGE_LABELS, STAGE_PROGRESS, humanizeStage, progressColor } from './progress.js';
import { INTERVIEW_STATUSES, STATUS_ORDER, createDashboardMeta } from './state.js';
import { normalizeSource, sourceBadgeCls, sourceDisplayLabel } from './source-badges.js';

// ─── State ────────────────────────────────────────────────────────────────────
let allJobs    = [];
let userProfile = {};
let dashboardMeta = { builtAt: null, lastScanAt: null };
let ambiguousGmailJobs = [];
let workflowSummary = { urgentFollowUps: 0, staleJobs: 0, upcomingInterviews: 0 };
const socket   = io();

// Sort state
let oppSort      = { col: 'date_updated', dir: 'desc' };
let pipelineSort = 'count'; // 'count' | 'stage' | 'alpha'
let activeHealthFilter = '';
const activeResumeJobs = new Set();
const BULK_RESUME_CONCURRENCY = 3;
let currentVisibleOpportunityJobs = [];
let bulkResumeRunning = false;
let sidebarControlsReady = false;
let resumeWorkspace = null;
let outreachWorkspace = null;
let contactsWorkspace = null;
let analyticsSummary = null;
let settingsHealth = null;
let currentJobDetailId = '';

function isRejectedJob(job) {
  return (job?.status || '').toLowerCase() === 'rejected';
}

function visibleDashboardJobs(jobs) {
  return jobs.filter(job => !isRejectedJob(job));
}

function setupSidebarControls() {
  if (sidebarControlsReady) return;
  sidebarControlsReady = true;
  const root = document.documentElement;
  const toggle = document.getElementById('sidebar-toggle');
  const handle = document.getElementById('sidebar-resize-handle');
  const storedWidthValue = localStorage.getItem('careerOpsSidebarWidth');
  const storedWidth = storedWidthValue == null ? null : Number(storedWidthValue);
  const storedCollapsed = localStorage.getItem('careerOpsSidebarCollapsed') === '1';
  const clamp = value => Math.min(384, Math.max(192, value));
  const applyWidth = value => {
    const width = clamp(value);
    root.style.setProperty('--sidebar-width', `${width}px`);
    if (toggle && !document.body.classList.contains('sidebar-collapsed')) {
      toggle.style.left = `${width - 18}px`;
    }
    localStorage.setItem('careerOpsSidebarWidth', String(width));
  };
  const applyCollapsed = collapsed => {
    document.body.classList.toggle('sidebar-collapsed', collapsed);
    if (toggle) {
      const icon = toggle.querySelector('.material-symbols-outlined');
      toggle.setAttribute('aria-expanded', String(!collapsed));
      toggle.setAttribute('aria-label', collapsed ? 'Show sidebar' : 'Hide sidebar');
      toggle.title = collapsed ? 'Show sidebar' : 'Hide sidebar';
      if (icon) icon.textContent = collapsed ? 'left_panel_open' : 'left_panel_close';
      if (collapsed) toggle.style.left = '12px';
      else {
        const width = Number(localStorage.getItem('careerOpsSidebarWidth')) || 256;
        toggle.style.left = `${clamp(width) - 18}px`;
      }
    }
    localStorage.setItem('careerOpsSidebarCollapsed', collapsed ? '1' : '0');
  };

  if (Number.isFinite(storedWidth)) applyWidth(storedWidth);
  if (storedCollapsed) applyCollapsed(true);

  toggle?.addEventListener('click', () => {
    applyCollapsed(!document.body.classList.contains('sidebar-collapsed'));
  });

  handle?.addEventListener('pointerdown', event => {
    event.preventDefault();
    applyCollapsed(false);
    document.body.classList.add('sidebar-resizing');
    handle.setPointerCapture(event.pointerId);
    const onMove = moveEvent => applyWidth(moveEvent.clientX);
    const onUp = upEvent => {
      document.body.classList.remove('sidebar-resizing');
      handle.releasePointerCapture(upEvent.pointerId);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  });
}

function atsPercent(job) {
  const atsScore = Number(job?._ats?.score);
  if (Number.isFinite(atsScore)) return Math.round(atsScore);
  const fitScore = Number(job?.score);
  return Number.isFinite(fitScore) ? Math.round(fitScore * 20) : null;
}

function atsScoreLabel(job) {
  const pct = atsPercent(job);
  return pct == null ? '—' : pct + '%';
}

function atsScoreColor(job) {
  const pct = atsPercent(job);
  if (pct == null) return 'text-slate-400';
  if (pct >= 80) return 'text-emerald-600';
  if (pct >= 50) return 'text-amber-600';
  return 'text-rose-600';
}

function compactNextStep(job) {
  const next = job?._workflow?.nextBestAction;
  return next ? nextActionLabel(next) : '';
}

// ─── Boot ─────────────────────────────────────────────────────────────────────
async function init() {
  try {
    setupSidebarControls();
    const [data, gmailJobs] = await Promise.all([
      fetchDashboard(),
      fetchAmbiguousGmailJobs().catch(() => []),
    ]);
    allJobs    = data.jobs || [];
    ambiguousGmailJobs = gmailJobs || [];
    userProfile = data.profile || {};
    workflowSummary = data.workflowSummary || workflowSummary;
    dashboardMeta = createDashboardMeta(data);
    applyProfileToHeader();
    renderDashboard();
    setupOpportunities();
    setupInterviews();
    setupRejected();
    setupOperationalWorkspaces();
    renderWorkspaceView(viewFromPath());
    restoreResumeRuns();
  } catch (e) {
    document.getElementById('dash-subtitle').textContent = 'Failed to load: ' + e.message;
  }
}

// ─── Navigation ───────────────────────────────────────────────────────────────
const VIEWS = ['dashboard', 'jobs', 'resume', 'outreach', 'contacts', 'gmail-review', 'interviews', 'rejected', 'analytics', 'settings'];
const VIEW_PATHS = {
  dashboard: '/',
  jobs: '/jobs',
  resume: '/resume',
  outreach: '/outreach',
  contacts: '/contacts',
  'gmail-review': '/gmail-review',
  interviews: '/interviews',
  rejected: '/rejected',
  analytics: '/analytics',
  settings: '/settings',
};
const PATH_VIEWS = {
  '/': 'dashboard',
  '/dashboard': 'dashboard',
  '/jobs': 'jobs',
  '/resume': 'resume',
  '/outreach': 'outreach',
  '/contacts': 'contacts',
  '/gmail-review': 'gmail-review',
  '/gmail-revoew': 'gmail-review',
  '/interviews': 'interviews',
  '/rejected': 'rejected',
  '/analytics': 'analytics',
  '/settings': 'settings',
};

function viewFromPath(pathname = window.location.pathname) {
  const jobMatch = pathname.match(/^\/jobs\/([^/]+)$/);
  if (jobMatch) {
    currentJobDetailId = decodeURIComponent(jobMatch[1]);
    return 'jobs';
  }
  currentJobDetailId = '';
  return PATH_VIEWS[pathname] || 'dashboard';
}

function showView(name, { push = true } = {}) {
  const viewName = VIEWS.includes(name) ? name : 'dashboard';
  VIEWS.forEach(v => {
    document.getElementById('view-' + v).hidden = (v !== viewName);
  });
  document.querySelectorAll('.nav-btn').forEach(btn => {
    const active = btn.dataset.view === viewName;
    btn.className = 'nav-btn w-full flex items-center gap-3 px-3 py-2 rounded-lg transition-all text-sm font-medium '
      + (active ? 'nav-active' : 'nav-inactive');
  });
  if (viewName !== 'jobs' || push) currentJobDetailId = '';
  const nextPath = VIEW_PATHS[viewName] || '/';
  if (push && window.location.pathname !== nextPath) {
    history.pushState({ view: viewName }, '', nextPath);
  }
  renderWorkspaceView(viewName);
}

document.querySelectorAll('.nav-btn').forEach(btn => {
  btn.addEventListener('click', () => showView(btn.dataset.view));
});

window.addEventListener('popstate', () => {
  showView(viewFromPath(), { push: false });
});

document.getElementById('global-search').addEventListener('input', () => {
  applyOppFilters();
});

// ─── Profile header ───────────────────────────────────────────────────────────
function applyProfileToHeader() {
  const name     = userProfile?.candidate?.full_name || 'Brian Milhizer';
  const hl       = userProfile?.narrative?.headline  || '';
  const role     = hl.split('|')[0].trim() || 'Enterprise CSM';
  const initials = name.split(' ').map(p => p[0]).join('').slice(0,2).toUpperCase();
  const comp     = userProfile?.compensation?.target_range || '';
  const loc      = userProfile?.candidate?.location        || '';
  const certs    = (userProfile?.background?.certifications || []).length;

  set('topnav-name',    name);
  set('topnav-role',    role);
  set('sidebar-name',   name);
  set('sidebar-role',   role);
  set('topnav-avatar',  initials);
  set('sidebar-avatar', initials);

  const profileDetails = document.getElementById('profile-card-details');
  if (profileDetails) profileDetails.innerHTML = [
    row('Location',       esc(loc)  || '—'),
    row('Target Comp',    esc(comp) || '—'),
    row('Certifications', certs + ' on file'),
  ].join('');

  function row(label, val) {
    return `<div class="flex justify-between"><span class="text-slate-400">${label}</span><span class="font-medium">${val}</span></div>`;
  }
}

// ─── KPI helpers ──────────────────────────────────────────────────────────────
function computeKPIs(jobs) {
  const activeJobs   = visibleDashboardJobs(jobs);
  const total        = activeJobs.length;
  const interviews   = activeJobs.filter(j => INTERVIEW_STATUSES.has(j.status || '')).length;
  const scored       = activeJobs.map(atsPercent).filter(pct => pct != null);
  const avgAts       = scored.length
    ? Math.round(scored.reduce((sum, pct) => sum + pct, 0) / scored.length) : 0;
  const nonLead      = activeJobs.filter(j => (j.status || '') !== 'lead').length;
  const responseRate = total ? Math.round(nonLead / total * 100) : 0;
  return { total, interviews, avgAts, responseRate };
}

function kpiCard(icon, iconBg, iconColor, label, value) {
  return `<div class="bg-white p-card-padding rounded-xl border border-slate-200 shadow-sm flex flex-col justify-between h-32">
    <div class="flex justify-between items-start">
      <span class="p-2 ${iconBg} ${iconColor} rounded-lg">
        <span class="material-symbols-outlined text-xl">${icon}</span>
      </span>
    </div>
    <div>
      <p class="font-label-caps text-label-caps text-slate-500">${label}</p>
      <p class="text-h1 font-h1">${value}</p>
    </div>
  </div>`;
}

// ─── Dashboard ────────────────────────────────────────────────────────────────
function renderDashboard(builtAt = dashboardMeta.builtAt, lastScanAt = dashboardMeta.lastScanAt) {
  const visibleJobs = visibleDashboardJobs(allJobs);

  document.getElementById('dash-subtitle').textContent =
    `${visibleJobs.length} active jobs · refreshed ${builtAt ? new Date(builtAt).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'}) : 'now'}`;
  document.getElementById('dash-built-at').textContent =
    builtAt ? new Date(builtAt).toLocaleDateString('en-US', {month:'short', day:'numeric', year:'numeric'}) : '';
  const scanEl = document.getElementById('dash-scan-at');
  if (scanEl) {
    scanEl.textContent = lastScanAt
      ? 'Last scan: ' + new Date(lastScanAt).toLocaleString('en-US', {month:'short', day:'numeric', hour:'2-digit', minute:'2-digit'})
      : '';
  }

  renderWorkflowSummary();
  renderPipelineBreakdown();
  renderGmailAmbiguities();
}

function renderWorkflowSummary() {
  const grid = document.getElementById('workflow-summary-grid');
  if (!grid) return;
  const counts = buildHealthSummaryCounts();
  const items = [
    ['urgent_followups', 'priority_high', 'bg-rose-50', 'text-rose-600', 'URGENT FOLLOW-UPS', counts.urgentFollowUps, 'Applied jobs or contacts with follow-up due now. Click to show only roles needing a prompt next touch.'],
    ['stale_leads', 'schedule', 'bg-amber-50', 'text-amber-600', 'STALE LEADS', counts.staleLeads, 'Lead-stage roles that have gone quiet long enough to need a decision, outreach, or archive pass.'],
    ['gmail_ambiguity', 'mark_email_unread', 'bg-amber-50', 'text-amber-700', 'GMAIL REVIEW', counts.ambiguousGmailMatches, 'Emails that matched more than one job. Click to attach each thread to the right opportunity.'],
    ['needs_resume', 'description', 'bg-blue-50', 'text-blue-600', 'NEEDS RESUME', counts.jobsNeedingResume, 'Active leads without a generated resume, or roles whose workflow says resume generation is the next move.'],
    ['ready_apply', 'send', 'bg-emerald-50', 'text-emerald-600', 'READY TO APPLY', counts.jobsReadyToApply, 'Roles where the next best action is submitting the application. Click to focus the table.'],
    ['prep_interview', 'event_available', 'bg-purple-50', 'text-purple-600', 'INTERVIEW PREP', counts.interviewsPrepNeeded, 'Interview-stage roles or opportunities where prep is the next best action.'],
  ];
  grid.innerHTML = items.map(([filter, icon, bg, color, label, value, detail]) => {
    const active = activeHealthFilter === filter;
    return `<button class="health-summary-card group relative text-left bg-white border ${active ? 'border-blue-300 ring-2 ring-blue-600/10' : 'border-slate-200'} rounded-xl shadow-sm p-3 flex items-center gap-3 hover:bg-slate-50 transition-colors"
      data-filter="${filter}" type="button" aria-describedby="health-detail-${filter}">
      <span class="w-9 h-9 rounded-lg ${bg} ${color} flex items-center justify-center shrink-0">
        <span class="material-symbols-outlined text-xl">${icon}</span>
      </span>
      <div class="min-w-0">
        <p class="text-[10px] font-bold uppercase tracking-wide text-slate-400">${label}</p>
        <p class="text-lg font-bold text-slate-800">${value}</p>
      </div>
      <span id="health-detail-${filter}" role="tooltip"
        class="pointer-events-none absolute left-0 top-[calc(100%+8px)] z-30 hidden w-64 rounded-lg border border-slate-200 bg-white p-3 text-xs font-medium leading-relaxed text-slate-600 shadow-lg group-hover:block group-focus-visible:block">
        ${esc(detail)}
      </span>
    </button>`;
  }).join('');
  grid.querySelectorAll('.health-summary-card').forEach(btn => {
    btn.addEventListener('click', () => applyHealthSummaryFilter(btn.dataset.filter));
  });
}

function buildHealthSummaryCounts() {
  const jobs = visibleDashboardJobs(allJobs);
  return {
    urgentFollowUps: Math.max(workflowSummary.urgentFollowUps || 0, jobs.filter(jobNeedsFollowUp).length),
    staleLeads: Math.max(workflowSummary.staleJobs || 0, jobs.filter(jobIsStaleLead).length),
    ambiguousGmailMatches: ambiguousGmailJobs.length,
    jobsNeedingResume: jobs.filter(jobNeedsResume).length,
    jobsReadyToApply: jobs.filter(jobReadyToApply).length,
    interviewsPrepNeeded: Math.max(workflowSummary.upcomingInterviews || 0, jobs.filter(jobNeedsInterviewPrep).length),
  };
}

function applyHealthSummaryFilter(filter) {
  if (filter === 'gmail_ambiguity') {
    showView('gmail-review');
    return;
  }
  activeHealthFilter = activeHealthFilter === filter ? '' : filter;
  renderWorkflowSummary();
  applyOppFilters();
}

function matchesHealthFilter(job) {
  switch (activeHealthFilter) {
    case 'urgent_followups': return jobNeedsFollowUp(job);
    case 'stale_leads': return jobIsStaleLead(job);
    case 'needs_resume': return jobNeedsResume(job);
    case 'ready_apply': return jobReadyToApply(job);
    case 'prep_interview': return jobNeedsInterviewPrep(job);
    default: return true;
  }
}

function jobNeedsFollowUp(job) {
  const workflow = job._workflow || {};
  if (workflow.nextBestAction === 'follow_up') return true;
  if (workflow.staleness?.needsAppliedFollowUp) return true;
  const today = new Date().toISOString().slice(0, 10);
  return (Array.isArray(job.contacts) ? job.contacts : []).some(contact =>
    contact.responseStatus === 'follow_up_due' || (contact.followUpDue && contact.followUpDue <= today)
  );
}

function jobIsStaleLead(job) {
  const workflow = job._workflow || {};
  return workflow.staleness?.staleLead === true || (
    workflow.staleness?.stale === true && (job.status || '') === 'lead'
  );
}

function jobNeedsResume(job) {
  return job._workflow?.nextBestAction === 'generate_resume' || (
    (job.status || '') === 'lead' && generatedResumeVersions(job).length === 0
  );
}

function jobReadyToApply(job) {
  return job._workflow?.nextBestAction === 'apply';
}

function jobNeedsInterviewPrep(job) {
  return job._workflow?.nextBestAction === 'prep_interview' || INTERVIEW_STATUSES.has(job.status || '');
}

function renderGmailAmbiguities() {
  const panel = document.getElementById('gmail-ambiguity-panel');
  const listEl = document.getElementById('gmail-ambiguity-list');
  const countEl = document.getElementById('gmail-ambiguity-count');
  const emptyEl = document.getElementById('gmail-ambiguity-empty');
  if (!panel || !listEl || !countEl) return;

  countEl.textContent = ambiguousGmailJobs.length
    ? `${ambiguousGmailJobs.length} ambiguous email match${ambiguousGmailJobs.length !== 1 ? 'es' : ''} need review`
    : 'No ambiguous Gmail matches need review.';
  if (emptyEl) emptyEl.classList.toggle('hidden', ambiguousGmailJobs.length !== 0);
  listEl.innerHTML = ambiguousGmailJobs.map(renderGmailAmbiguityCard).join('');

  listEl.querySelectorAll('.gmail-attach-btn').forEach(btn => {
    btn.addEventListener('click', () => attachSelectedGmailMatch(btn));
  });
  listEl.querySelectorAll('.gmail-dismiss-btn').forEach(btn => {
    btn.addEventListener('click', () => dismissSelectedGmailMatch(btn));
  });
  listEl.querySelectorAll('.gmail-candidate-select').forEach(select => {
    select.addEventListener('change', () => {
      updateGmailApprovalPreview(select);
    });
  });
  listEl.querySelectorAll('.gmail-candidate-edit-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const card = btn.closest('[data-thread-id]');
      const jobId = btn.dataset.id || card?.querySelector('.gmail-candidate-select')?.value;
      if (jobId) openEditModal(jobId);
    });
  });
}

function renderGmailAmbiguityCard(item) {
  const threadId = item.thread_id || '';
  const candidates = Array.isArray(item.matchCandidates) ? item.matchCandidates : [];
  const selected = candidates[0] || null;
  const selectedJob = selected ? allJobs.find(job => job.id === selected.id) : null;
  const initialPreview = buildGmailApprovalPreview(item, selectedJob, selected);
  const emailDate = item.last_email_date
    ? new Date(item.last_email_date).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    : 'Unknown time';
  const candidateRows = candidates.length
    ? candidates.map(c => `<div class="text-[11px] text-slate-500 flex items-center justify-between gap-2">
        <span class="min-w-0">
          <span class="font-semibold text-slate-700">${esc(c.company || '')}</span>
          ${esc(c.title || '')}
          <span class="text-slate-400">· ${formatConfidence(c.confidence)} · ${(c.matchedBy || []).map(esc).join(', ')}</span>
        </span>
        <button type="button" class="gmail-candidate-edit-btn text-[11px] font-semibold text-blue-600 hover:underline shrink-0" data-id="${esc(c.id)}">Edit</button>
      </div>`).join('')
    : '<div class="text-[11px] text-slate-400">No candidates available.</div>';
  const options = candidates.map(c => {
    const label = `${c.company || 'Unknown'} — ${c.title || 'Unknown'} (${formatConfidence(c.confidence)})`;
    const candidateJob = allJobs.find(job => job.id === c.id);
    const preview = buildGmailApprovalPreview(item, candidateJob, c);
    return `<option value="${esc(c.id)}"
      data-job-label="${esc(preview.jobLabel)}"
      data-current-status="${esc(preview.currentStatusLabel)}"
      data-detected-status="${esc(preview.detectedStatusLabel)}"
      data-resolved-status="${esc(preview.resolvedStatusLabel)}"
      data-status-change="${esc(preview.statusChangeLabel)}">${esc(label)}</option>`;
  }).join('');
  const selectedLabel = selected
    ? `${selected.company || 'Unknown'} — ${selected.title || 'Unknown'}`
    : 'No candidate selected';

  return `<div class="border border-slate-200 rounded-lg p-3" data-thread-id="${esc(threadId)}">
    <div class="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_minmax(260px,0.9fr)_210px] gap-2 items-start">
      <div class="min-w-0">
        <p class="text-[10px] font-bold uppercase tracking-wide text-slate-400 mb-2">Email</p>
        <p class="text-xs font-semibold text-slate-700 truncate">${esc(item.company || 'Unknown company')}</p>
        <p class="text-[11px] text-slate-400">${esc(emailDate)}</p>
        <p class="text-[11px] text-slate-500 truncate mt-1">${esc(item.from || 'Unknown sender')}</p>
        <p class="text-xs text-slate-700 mt-2 line-clamp-2">${esc(item.last_email_subject || '(no subject)')}</p>
        <p class="text-[11px] text-slate-500 mt-2">
          Detected: <span class="font-semibold">${esc(item.company || 'Unknown')}</span>
          ${item.role ? `· ${esc(item.role)}` : ''}
          <span class="text-slate-400">· ${formatConfidence(item.gmailMatch?.confidence)}</span>
        </p>
      </div>
      <div class="min-w-0">
        <p class="text-[10px] font-bold uppercase tracking-wide text-slate-400 mb-2">If approved</p>
        <p class="text-xs text-slate-600 leading-relaxed">
          Attach this email to <span class="font-semibold text-slate-800 gmail-selected-job-label">${esc(selectedLabel)}</span>.
          Save subject, sender context, email date, snippet, confidence, and manual resolution metadata on the job.
        </p>
        <p class="text-xs text-slate-600 mt-2">
          Status: <span class="font-semibold text-slate-800 gmail-status-change-label">${esc(initialPreview.statusChangeLabel)}</span>
        </p>
        <p class="text-[11px] text-slate-400 mt-1">
          Gmail detected <span class="gmail-detected-status">${esc(initialPreview.detectedStatusLabel)}</span>; approval updates the selected job to <span class="gmail-resolved-status">${esc(initialPreview.resolvedStatusLabel)}</span>.
        </p>
        <div class="mt-2 space-y-0.5">${candidateRows}</div>
        <p class="gmail-ambiguity-error hidden text-xs text-rose-600 mt-2"></p>
      </div>
      <div class="flex flex-col gap-2">
        <p class="text-[10px] font-bold uppercase tracking-wide text-slate-400">Decision</p>
        <select class="gmail-candidate-select border border-slate-200 rounded-lg px-3 py-2 text-xs bg-white text-slate-700 outline-none focus:ring-2 focus:ring-blue-600/20" ${candidates.length ? '' : 'disabled'}>
          ${options}
        </select>
        <button type="button" class="gmail-candidate-edit-btn text-xs font-semibold text-blue-600 border border-blue-100 px-3 py-2 rounded-lg hover:bg-blue-50 disabled:opacity-50"
          ${candidates.length ? '' : 'disabled'}>Edit selected job</button>
        <div class="grid grid-cols-2 gap-2">
          <button class="gmail-attach-btn bg-primary text-white text-xs font-semibold px-3 py-2 rounded-lg hover:opacity-90 disabled:opacity-50" ${candidates.length ? '' : 'disabled'}>Approve</button>
          <button class="gmail-dismiss-btn text-xs font-semibold text-slate-600 border border-slate-200 px-3 py-2 rounded-lg hover:bg-slate-50">Decline</button>
        </div>
      </div>
    </div>
  </div>`;
}

function normalizeDashboardStatus(status) {
  const value = String(status || 'lead').toLowerCase();
  return STATUS_ORDER.includes(value) ? value : 'lead';
}

function advanceDashboardStatus(currentStatus, incomingStatus) {
  const current = normalizeDashboardStatus(currentStatus);
  const incoming = normalizeDashboardStatus(incomingStatus);
  return STATUS_ORDER.indexOf(incoming) > STATUS_ORDER.indexOf(current) ? incoming : current;
}

function statusDisplay(status) {
  return humanizeStage(normalizeDashboardStatus(status));
}

function buildGmailApprovalPreview(item, job, candidate) {
  const currentStatus = normalizeDashboardStatus(job?.status);
  const detectedStatus = normalizeDashboardStatus(item?.status);
  const resolvedStatus = advanceDashboardStatus(currentStatus, detectedStatus);
  const currentStatusLabel = statusDisplay(currentStatus);
  const detectedStatusLabel = statusDisplay(detectedStatus);
  const resolvedStatusLabel = statusDisplay(resolvedStatus);
  return {
    jobLabel: candidate ? `${candidate.company || 'Unknown'} — ${candidate.title || 'Unknown'}` : 'No candidate selected',
    currentStatusLabel,
    detectedStatusLabel,
    resolvedStatusLabel,
    statusChangeLabel: currentStatus === resolvedStatus
      ? `${currentStatusLabel} → ${resolvedStatusLabel} (no change)`
      : `${currentStatusLabel} → ${resolvedStatusLabel}`,
  };
}

function updateGmailApprovalPreview(select) {
  const card = select.closest('[data-thread-id]');
  const option = select.selectedOptions?.[0];
  if (!card || !option) return;
  const setText = (selector, value) => {
    const el = card.querySelector(selector);
    if (el) el.textContent = value;
  };
  setText('.gmail-selected-job-label', option.dataset.jobLabel || option.textContent.replace(/\s*\(\d+%\)\s*$/, ''));
  setText('.gmail-status-change-label', option.dataset.statusChange || '');
  setText('.gmail-detected-status', option.dataset.detectedStatus || '');
  setText('.gmail-resolved-status', option.dataset.resolvedStatus || '');
}

async function attachSelectedGmailMatch(btn) {
  const card = btn.closest('[data-thread-id]');
  const threadId = card?.dataset.threadId;
  const jobId = card?.querySelector('.gmail-candidate-select')?.value;
  if (!threadId || !jobId) return;
  await resolveGmailMatchAction(btn, async () => {
    await attachGmailAmbiguity(threadId, jobId);
    ambiguousGmailJobs = ambiguousGmailJobs.filter(item => item.thread_id !== threadId);
    const data = await fetchDashboard();
    allJobs = data.jobs || [];
    dashboardMeta = createDashboardMeta(data);
    renderDashboard();
    applyOppFilters();
    renderInterviews();
    renderRejected();
  });
}

async function dismissSelectedGmailMatch(btn) {
  const card = btn.closest('[data-thread-id]');
  const threadId = card?.dataset.threadId;
  if (!threadId) return;
  await resolveGmailMatchAction(btn, async () => {
    await dismissGmailAmbiguity(threadId);
    ambiguousGmailJobs = ambiguousGmailJobs.filter(item => item.thread_id !== threadId);
    renderWorkflowSummary();
    renderGmailAmbiguities();
  });
}

async function resolveGmailMatchAction(btn, actionFn) {
  const card = btn.closest('[data-thread-id]');
  const errEl = card?.querySelector('.gmail-ambiguity-error');
  const buttons = card?.querySelectorAll('button') || [];
  buttons.forEach(b => { b.disabled = true; });
  const originalText = btn.textContent;
  btn.textContent = 'Saving…';
  if (errEl) errEl.classList.add('hidden');
  try {
    await actionFn();
  } catch (e) {
    if (errEl) {
      errEl.textContent = e.message;
      errEl.classList.remove('hidden');
    } else {
      alert('Gmail review failed: ' + e.message);
    }
    buttons.forEach(b => { b.disabled = false; });
    btn.textContent = originalText;
  }
}

function formatConfidence(value) {
  const num = Number(value || 0);
  return `${Math.round(num * 100)}%`;
}

function renderPipelineBreakdown() {
  const counts = {};
  visibleDashboardJobs(allJobs).forEach(j => {
    const s = (j.status || 'Unknown').trim();
    counts[s] = (counts[s] || 0) + 1;
  });

  let entries = Object.entries(counts);
  if (pipelineSort === 'count') {
    entries.sort((a,b) => b[1] - a[1]);
  } else if (pipelineSort === 'stage') {
    entries.sort((a,b) => {
      const ai = STATUS_ORDER.indexOf(a[0].toLowerCase()), bi = STATUS_ORDER.indexOf(b[0].toLowerCase());
      const an = ai === -1 ? 99 : ai, bn = bi === -1 ? 99 : bi;
      return an - bn;
    });
  } else {
    entries.sort((a,b) => a[0].localeCompare(b[0]));
  }

  document.getElementById('pipeline-breakdown').innerHTML = entries.map(([status, count]) => {
    const total = visibleDashboardJobs(allJobs).length || 1;
    const pct = Math.round(count / total * 100);
    const { icon, iconBg, iconColor, barColor } = statusStyle(status);
    return `<div class="bg-slate-50 border border-slate-200 rounded-lg p-2 min-h-[82px] flex flex-col justify-between overflow-hidden">
      <div class="flex items-start justify-between gap-1">
        <span class="w-7 h-7 rounded-lg ${iconBg} ${iconColor} flex items-center justify-center shrink-0">
          <span class="material-symbols-outlined text-base">${icon}</span>
        </span>
        <span class="text-[10px] font-semibold text-slate-400">${pct}%</span>
      </div>
      <div>
        <p class="text-[9px] font-bold uppercase tracking-wide text-slate-400 truncate">${esc(statusDisplayLabel(status))}</p>
        <p class="text-lg font-bold text-slate-800 leading-tight">${count}</p>
      </div>
      <div class="h-1.5 bg-white rounded-full overflow-hidden">
        <div class="${barColor} h-full rounded-full" style="width:${pct}%"></div>
      </div>
    </div>`;
  }).join('');
}

document.getElementById('pipeline-sort').addEventListener('change', e => {
  pipelineSort = e.target.value;
  renderPipelineBreakdown();
});

// ─── Opportunities ────────────────────────────────────────────────────────────
function setupOpportunities() {
  // Build status dropdown from actual data
  const statuses = [...new Set(visibleDashboardJobs(allJobs).map(j => j.status).filter(Boolean))].sort();
  const sel = document.getElementById('opp-status-filter');
  statuses.forEach(s => {
    const o = document.createElement('option');
    o.value = s; o.textContent = statusDisplayLabel(s);
    sel.appendChild(o);
  });

  // Build source dropdown
  const sources = [...new Set(visibleDashboardJobs(allJobs).map(j => normalizeSource(j.source)).filter(Boolean))].sort();
  const srcSel  = document.getElementById('opp-source-filter');
  sources.forEach(s => {
    const o = document.createElement('option');
    o.value = s; o.textContent = sourceDisplayLabel(s);
    srcSel.appendChild(o);
  });

  document.getElementById('opp-status-filter').addEventListener('change',  applyOppFilters);
  document.getElementById('opp-score-filter').addEventListener('change',   applyOppFilters);
  document.getElementById('opp-source-filter').addEventListener('change',  applyOppFilters);
  document.getElementById('opp-posted-filter').addEventListener('change',  applyOppFilters);
  document.getElementById('opp-clear-btn').addEventListener('click',       clearOppFilters);
  document.getElementById('bulk-generate-visible-btn').addEventListener('click', triggerBulkGenerateVisible);

  // Add Job panel
  document.getElementById('add-job-btn').addEventListener('click', () => {
    document.getElementById('add-job-panel').classList.remove('hidden');
    document.getElementById('add-job-url').focus();
  });
  document.getElementById('add-job-cancel').addEventListener('click', closeAddJobPanel);
  document.getElementById('add-job-submit').addEventListener('click', submitAddJob);
  document.getElementById('add-job-url').addEventListener('keydown', e => {
    if (e.key === 'Enter') submitAddJob();
  });

  applyOppFilters();
}

function closeAddJobPanel() {
  document.getElementById('add-job-panel').classList.add('hidden');
  document.getElementById('add-job-url').value     = '';
  document.getElementById('add-job-company').value = '';
  document.getElementById('add-job-title').value   = '';
  document.getElementById('add-job-log').innerHTML = '';
  document.getElementById('add-job-log').classList.add('hidden');
  const btn = document.getElementById('add-job-submit');
  btn.disabled = false;
  btn.style.removeProperty('background-color');
  document.getElementById('add-job-submit-label').textContent = 'Scrape & Add';
}

let _addJobUrl = null; // track in-flight URL for socket matching

async function submitAddJob() {
  const url     = document.getElementById('add-job-url').value.trim();
  const company = document.getElementById('add-job-company').value.trim();
  const title   = document.getElementById('add-job-title').value.trim();
  if (!url || !url.startsWith('http')) {
    addJobLog('error', 'Please enter a valid http(s) URL.');
    return;
  }

  _addJobUrl = url;
  const btn  = document.getElementById('add-job-submit');
  btn.disabled = true;
  document.getElementById('add-job-submit-label').textContent = 'Scraping…';
  document.getElementById('add-job-log').innerHTML = '';
  document.getElementById('add-job-log').classList.remove('hidden');
  addJobLog('ok', 'Sending to scraper…');

  try {
    await evaluateUrl({ url, company, title });
    // progress + completion come via socket events below
  } catch (e) {
    addJobLog('error', e.response ? e.message : 'Network error: ' + e.message);
    btn.disabled = false;
    document.getElementById('add-job-submit-label').textContent = 'Retry';
  }
}

function addJobLog(kind, text) {
  const log   = document.getElementById('add-job-log');
  const color = kind === 'error' ? 'text-rose-600' : kind === 'warning' ? 'text-amber-600' : 'text-emerald-700';
  const d = document.createElement('div');
  d.className = color;
  d.textContent = text;
  log.appendChild(d);
  log.scrollTop = log.scrollHeight;
}

function evalProgressPct(stage, message) {
  if (stage === 'fetch')  return (message && !/^Fetching|^Using/i.test(message)) ? 35 : 10;
  if (stage === 'score')  return (message && !/^Scoring/i.test(message))          ? 80 : 45;
  if (stage === 'save')   return 95;
  return null;
}

function updateAddJobBtn(pct, label) {
  const btn = document.getElementById('add-job-submit');
  if (!btn) return;
  btn.style.backgroundColor = progressColor(pct);
  document.getElementById('add-job-submit-label').textContent = `${label}… ${pct}%`;
}

function resetAddJobBtn(label = 'Scrape & Add') {
  const btn = document.getElementById('add-job-submit');
  if (!btn) return;
  btn.disabled = false;
  btn.style.removeProperty('background-color');
  document.getElementById('add-job-submit-label').textContent = label;
}

socket.on('eval-progress', ({ url, stage, message }) => {
  if (url !== _addJobUrl) return;
  const label = EVAL_STAGE_LABELS[stage] || stage;
  addJobLog('ok', `${label}: ${message || '…'}`);
  const pct = evalProgressPct(stage, message);
  if (pct != null) updateAddJobBtn(pct, label);
});

socket.on('eval-complete', async ({ url, alreadyExists, company, title: role, score }) => {
  if (url !== _addJobUrl) return;
  _addJobUrl = null;
  const btn = document.getElementById('add-job-submit');
  if (btn) btn.style.backgroundColor = '#059669';
  if (alreadyExists) {
    document.getElementById('add-job-submit-label').textContent = '✓ Already tracked';
    addJobLog('warning', 'Already in tracker — no duplicate added.');
  } else {
    const scoreStr = score != null ? ` · score ${score}` : '';
    document.getElementById('add-job-submit-label').textContent = '✓ Added';
    addJobLog('ok', `✓ Added: ${company || 'Unknown'} — ${role || 'Unknown'}${scoreStr}`);
  }
  setTimeout(() => resetAddJobBtn('Add Another'), 1500);
  // Reload data so the new job appears in the table
  const data = await fetchDashboard();
  allJobs    = data.jobs || [];
  dashboardMeta = createDashboardMeta(data);
  invalidateWorkspaceCaches();
  applyOppFilters();
  renderInterviews();
  renderRejected();
  renderDashboard();
});

socket.on('eval-error', ({ url, message }) => {
  if (url !== _addJobUrl) return;
  _addJobUrl = null;
  addJobLog('error', 'Error: ' + message);
  resetAddJobBtn('Retry');
});

function clearOppFilters() {
  document.getElementById('global-search').value = '';
  document.getElementById('opp-status-filter').value  = '';
  document.getElementById('opp-score-filter').value   = '';
  document.getElementById('opp-source-filter').value  = '';
  document.getElementById('opp-posted-filter').value  = '';
  activeHealthFilter = '';
  oppSort = { col: 'date_updated', dir: 'desc' };
  updateSortHeaders();
  renderWorkflowSummary();
  applyOppFilters();
}

function setOppSort(col) {
  if (oppSort.col === col) {
    oppSort.dir = oppSort.dir === 'asc' ? 'desc' : 'asc';
  } else {
    oppSort.col = col;
    // default direction: desc for numeric/date cols, asc for text cols
    oppSort.dir = (col === 'company' || col === 'location' || col === 'status') ? 'asc' : 'desc';
  }
  updateSortHeaders();
  applyOppFilters();
}

window.setOppSort = setOppSort;

function updateSortHeaders() {
  const COLS = ['company','score','status','location','date_found','date_updated'];
  COLS.forEach(col => {
    const icon = document.querySelector('.sort-icon-' + col);
    if (!icon) return;
    if (oppSort.col === col) {
      icon.textContent = oppSort.dir === 'asc' ? 'arrow_upward' : 'arrow_downward';
      icon.style.opacity = '1';
      icon.style.color   = '#004ac6';
    } else {
      icon.textContent = 'unfold_more';
      icon.style.opacity = '0.35';
      icon.style.color   = '';
    }
  });
}

function applyOppFilters() {
  const q       = (document.getElementById('global-search').value || '').toLowerCase();
  const statusF = document.getElementById('opp-status-filter').value;
  const scoreF  = document.getElementById('opp-score-filter').value;
  const sourceF = document.getElementById('opp-source-filter').value;
  const postedF = document.getElementById('opp-posted-filter').value;

  const hasFilter = q || statusF || scoreF || sourceF || postedF || activeHealthFilter || oppSort.col !== 'date_updated';
  document.getElementById('opp-clear-btn').classList.toggle('hidden', !hasFilter);

  const dashboardJobs = visibleDashboardJobs(allJobs);
  let filtered = dashboardJobs.filter(j => {
    const haystack = ((j.company||'') + ' ' + (j.title||'')).toLowerCase();
    if (q       && !haystack.includes(q))    return false;
    if (statusF && j.status  !== statusF)     return false;
    if (sourceF && normalizeSource(j.source) !== sourceF) return false;
    if (!matchesHealthFilter(j)) return false;
    if (scoreF) {
      const pct = atsPercent(j);
      if (scoreF === 'high' && (pct == null || pct < 80))              return false;
      if (scoreF === 'mid'  && (pct == null || pct < 50 || pct >= 80)) return false;
      if (scoreF === 'low'  && (pct == null || pct >= 50))             return false;
    }
    if (postedF && j.date_found) {
      const daysAgo = Math.floor((Date.now() - new Date(j.date_found).getTime()) / (24 * 60 * 60 * 1000));
      if (postedF === 'old' && daysAgo <= 60)  return false;
      if (postedF !== 'old' && daysAgo > Number(postedF)) return false;
    }
    return true;
  });

  filtered = sortJobsBy(filtered, oppSort.col, oppSort.dir, STATUS_ORDER);

  document.getElementById('opp-count-label').textContent = `${filtered.length} of ${dashboardJobs.length} active jobs`;
  currentVisibleOpportunityJobs = filtered;
  updateBulkGenerateButton();
  document.getElementById('opp-empty').classList.toggle('hidden', filtered.length > 0);

  const tbody = document.getElementById('opp-tbody');
  tbody.innerHTML = '';

  const OLDER_STATUSES = new Set(['applied', 'lead']);
  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  const isOlder = j => OLDER_STATUSES.has(j.status) && j.date_updated &&
    Math.floor((Date.now() - new Date(j.date_updated).getTime()) / MS_PER_DAY) > 10;

  const recent = filtered.filter(j => !isOlder(j));
  const older  = filtered.filter(isOlder);

  const appendJobRow = job => {
    const atsStr = atsScoreLabel(job);
    const atsColor = atsScoreColor(job);
    const nextStep = compactNextStep(job);
    const detailId = 'detail-' + job.id;

    const tr = document.createElement('tr');
    tr.className = 'border-b border-slate-100 hover:bg-slate-50 transition-colors cursor-pointer';
    tr.dataset.detailId = detailId;
    tr.innerHTML = `
      <td class="px-4 py-3">
        <div class="flex items-center gap-2">
          <button class="flag-btn shrink-0 p-0.5 rounded transition-colors ${job.flagged ? 'text-amber-400 hover:text-amber-500' : 'text-slate-200 hover:text-amber-300'}"
            data-id="${esc(job.id)}" title="${job.flagged ? 'Unflag job' : 'Flag job'}">
            <span class="material-symbols-outlined text-xl leading-none" style="${job.flagged ? 'font-variation-settings:\'FILL\' 1' : ''}">flag</span>
          </button>
          <div class="w-8 h-8 rounded-lg bg-surface-container-high flex items-center justify-center text-xs font-bold text-slate-600 shrink-0">
            ${esc((job.company||'?').slice(0,2).toUpperCase())}
          </div>
          <div class="min-w-0">
            <p class="font-semibold text-on-surface truncate max-w-xs">${esc(job.company)}</p>
            <p class="text-xs text-slate-500 truncate max-w-xs">${esc(job.title)}</p>
            <span class="inline-block mt-0.5 px-1.5 py-px rounded text-[10px] font-semibold uppercase tracking-wide ${sourceBadgeCls(job.source)}">${esc(sourceDisplayLabel(job.source))}</span>
            ${nextStep ? `<p class="text-[11px] text-slate-400 truncate max-w-xs mt-0.5">Next: ${esc(nextStep)}</p>` : ''}
          </div>
        </div>
      </td>
      <td class="px-4 py-3 hidden md:table-cell text-left">
        <span class="font-bold ${atsColor}">${atsStr}</span>
      </td>
      <td class="px-4 py-3">${statusBadge(job.status)}</td>
      <td class="px-4 py-3 text-xs text-slate-500 hidden lg:table-cell">${esc(job.location||'—')}</td>
      <td class="px-4 py-3 text-xs text-slate-400 hidden md:table-cell">${fmtDate(job.date_found)}</td>
      <td class="px-4 py-3 text-xs text-slate-400 hidden md:table-cell">${fmtDate(job.date_updated)}</td>
      <td class="px-4 py-3">
        <div class="flex items-center gap-2">
          <button class="gen-btn px-3 py-1.5 bg-primary text-white text-xs font-bold rounded-lg hover:opacity-90 transition-opacity"
            data-id="${esc(job.id)}">Generate</button>
          <button class="open-job-btn p-1.5 text-slate-400 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-colors"
            data-id="${esc(job.id)}" title="Open job workspace">
            <span class="material-symbols-outlined text-base leading-none">open_in_new</span>
          </button>
          <button class="edit-btn p-1.5 text-slate-400 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-colors"
            data-id="${esc(job.id)}" title="Edit job">
            <span class="material-symbols-outlined text-base leading-none">edit</span>
          </button>
          <button class="del-btn p-1.5 text-slate-400 hover:text-rose-500 hover:bg-rose-50 rounded-lg transition-colors"
            data-id="${esc(job.id)}" title="Remove job">
            <span class="material-symbols-outlined text-base leading-none">delete</span>
          </button>
        </div>
      </td>`;

    // Detail expansion row
    const dRow = document.createElement('tr');
    dRow.id = detailId;
    dRow.className = 'hidden bg-slate-50/60';
    dRow.innerHTML = `<td colspan="7" class="px-6 py-4 border-b border-slate-100">${buildDetailPanel(job)}</td>`;

    const pRow = document.createElement('tr');
    pRow.id = 'opp-prog-' + job.id;
    pRow.className = 'hidden';
    pRow.innerHTML = `<td colspan="7" class="px-6 pb-4 bg-slate-50/50">
      <div class="stage-log text-xs space-y-0.5 font-mono mt-1"></div>
      <div class="downloads mt-2 flex gap-4 text-xs"></div>
    </td>`;

    tbody.appendChild(tr);
    tbody.appendChild(dRow);
    tbody.appendChild(pRow);
  };

  recent.forEach(appendJobRow);

  if (older.length > 0) {
    const sep = document.createElement('tr');
    sep.innerHTML = `<td colspan="7" class="px-4 py-1.5 text-[11px] font-semibold uppercase tracking-widest text-slate-400 bg-slate-50 border-y border-slate-100">Older</td>`;
    tbody.appendChild(sep);
    older.forEach(appendJobRow);
  }

  // Row click → toggle detail; ignore clicks on action buttons
  tbody.querySelectorAll('tr[data-detail-id]').forEach(tr => {
    tr.addEventListener('click', e => {
      if (e.target.closest('.gen-btn') || e.target.closest('.open-job-btn') || e.target.closest('.edit-btn') || e.target.closest('.del-btn')) return;
      const dRow = document.getElementById(tr.dataset.detailId);
      if (dRow) dRow.classList.toggle('hidden');
    });
  });

  tbody.querySelectorAll('.flag-btn').forEach(btn => {
    btn.addEventListener('click', e => { e.stopPropagation(); toggleJobFlag(btn.dataset.id, btn); });
  });

  tbody.querySelectorAll('.gen-btn').forEach(btn => {
    btn.addEventListener('click', () => triggerGenerate(btn.dataset.id, btn));
  });

  tbody.querySelectorAll('.open-job-btn').forEach(btn => {
    btn.addEventListener('click', () => showJobDetail(btn.dataset.id));
  });

  tbody.querySelectorAll('.edit-btn').forEach(btn => {
    btn.addEventListener('click', () => openEditModal(btn.dataset.id));
  });

  tbody.querySelectorAll('.del-btn').forEach(btn => {
    btn.addEventListener('click', () => deleteJob(btn.dataset.id));
  });

  bindWorkflowActions(tbody);
  bindContactWorkspace(tbody);
}

// ─── Job detail panel ────────────────────────────────────────────────────────
function buildDetailPanel(job) {
  const parts = [];
  const workflow = job._workflow || {};
  const nextAction = workflow.nextBestAction ? nextActionLabel(workflow.nextBestAction) : null;
  const staleText = workflow.staleness?.stale ? workflowStaleLabel(workflow.staleness) : '';

  // Header: URL + next steps
  const urlHtml = job.url
    ? `<a href="${esc(job.url)}" target="_blank" rel="noopener"
         class="inline-flex items-center gap-1 text-blue-600 hover:underline text-xs font-medium">
         <span class="material-symbols-outlined text-sm">open_in_new</span>View Posting
       </a>`
    : '';
  const nsHtml = job.next_steps
    ? `<span class="text-xs text-amber-700 bg-amber-50 rounded px-2 py-0.5 font-medium">${esc(job.next_steps)}</span>`
    : '';
  if (urlHtml || nsHtml) {
    parts.push(`<div class="flex flex-wrap items-center gap-3 mb-3">${urlHtml}${nsHtml}</div>`);
  }

  if (nextAction || staleText) {
    parts.push(`
      <div class="bg-white border border-slate-200 rounded-lg p-3 mb-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
        <div>
          <p class="text-[10px] font-bold uppercase tracking-wide text-slate-400">Next Best Action</p>
          <p class="text-xs font-semibold text-slate-700">${esc(nextAction || 'Review')}</p>
        </div>
        ${staleText ? `<span class="text-xs font-semibold text-amber-700 bg-amber-50 rounded px-2 py-1">${esc(staleText)}</span>` : ''}
      </div>`);
  }

  parts.push(renderWorkflowActions(job));
  parts.push(renderContactWorkspace(job));

  // Score analysis / email snippet
  const analysis = job.score_analysis || job.last_email_snippet || job.notes || '';
  if (analysis) {
    parts.push(`<p class="text-xs text-slate-600 mb-3 leading-relaxed">${esc(analysis)}</p>`);
  }

  // CV match table
  const table = job.report?.cv_match_table;
  if (Array.isArray(table) && table.length) {
    const strengthColor = s => s === 'Strong' ? 'text-emerald-600' : s === 'Gap' ? 'text-rose-500' : 'text-amber-600';
    parts.push(`
      <div class="overflow-x-auto mb-3">
        <table class="w-full text-xs border-collapse">
          <thead>
            <tr class="border-b border-slate-200">
              <th class="text-left py-1.5 pr-3 font-semibold text-slate-500 w-1/3">Requirement</th>
              <th class="text-left py-1.5 pr-3 font-semibold text-slate-500">Evidence</th>
              <th class="text-left py-1.5 font-semibold text-slate-500 w-20">Match</th>
            </tr>
          </thead>
          <tbody>
            ${table.map(row => `
              <tr class="border-b border-slate-100">
                <td class="py-1.5 pr-3 text-slate-700 align-top">${esc(row.req||'')}</td>
                <td class="py-1.5 pr-3 text-slate-500 align-top">${esc(row.evidence||'')}</td>
                <td class="py-1.5 align-top font-semibold ${strengthColor(row.strength)}">${esc(row.strength||'')}</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>`);
  }

  // Gaps
  const gaps = job.report?.gaps;
  if (Array.isArray(gaps) && gaps.length) {
    parts.push(`
      <div class="flex flex-wrap gap-1.5">
        <span class="text-xs font-semibold text-slate-500 mr-1">Gaps:</span>
        ${gaps.map(g => `<span class="text-xs bg-rose-50 text-rose-600 rounded px-2 py-0.5">${esc(g)}</span>`).join('')}
      </div>`);
  }

  const resumeVersions = generatedResumeVersions(job);
  if (resumeVersions.length) {
    parts.push(`
      <div class="mt-4">
        <p class="text-[10px] font-bold uppercase tracking-wide text-slate-400 mb-2">Resume Versions</p>
        <div class="bg-white border border-slate-200 rounded-lg divide-y divide-slate-100">
          ${resumeVersions.map(version => `
            <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-1 px-3 py-2">
              <div class="min-w-0">
                <a href="${esc(version.docxUrl)}" download class="text-xs font-semibold text-blue-600 hover:underline truncate block">${esc(version.fileName || 'Resume DOCX')}</a>
                <p class="text-[11px] text-slate-400">${esc(statusDisplayLabel(version.strategy || version.variant || 'default'))} · ${fmtDateTime(version.generatedAt)}</p>
              </div>
              <div class="text-[11px] text-slate-500 shrink-0">${resumeVersionScoreLabel(version)}</div>
            </div>`).join('')}
        </div>
      </div>`);
  }

  const timeline = workflowTimelineItems(job);
  if (timeline.length) {
    parts.push(`
      <div class="mt-4">
        <p class="text-[10px] font-bold uppercase tracking-wide text-slate-400 mb-2">Workflow Timeline</p>
        <div class="bg-white border border-slate-200 rounded-lg divide-y divide-slate-100">
          ${timeline.map(event => `
            <div class="flex items-center justify-between gap-3 px-3 py-2">
              <div class="min-w-0">
                <p class="text-xs font-semibold text-slate-700">${esc(workflowEventLabel(event.type))}</p>
                ${event.label || event.note ? `<p class="text-[11px] text-slate-400 truncate">${esc(event.note || event.label)}</p>` : ''}
              </div>
              <p class="text-[11px] text-slate-400 shrink-0">${fmtDateTime(event.at)}</p>
            </div>`).join('')}
        </div>
      </div>`);
  }

  return parts.length
    ? parts.join('')
    : `<p class="text-xs text-slate-400 italic">No additional details available.</p>`;
}

function renderContactWorkspace(job) {
  const contacts = Array.isArray(job.contacts) ? job.contacts : [];
  return `<div class="contact-workspace bg-white border border-slate-200 rounded-lg p-3 mb-3" data-job-id="${esc(job.id)}">
    <div class="flex items-center justify-between gap-2 mb-2">
      <p class="text-[10px] font-bold uppercase tracking-wide text-slate-400">Contacts</p>
      <p class="text-[11px] text-slate-400">${contacts.length} saved</p>
    </div>
    <div class="space-y-2 mb-3">
      ${contacts.length ? contacts.map(renderContactRow).join('') : '<p class="text-xs text-slate-400 italic">No contacts yet.</p>'}
    </div>
    <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-2">
      <input class="contact-name bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-xs outline-none focus:ring-2 focus:ring-blue-600/20" placeholder="Name">
      <input class="contact-title bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-xs outline-none focus:ring-2 focus:ring-blue-600/20" placeholder="Role/title">
      <select class="contact-type bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-xs outline-none focus:ring-2 focus:ring-blue-600/20">
        <option value="recruiter">Recruiter</option>
        <option value="hiring_manager">Hiring Manager</option>
        <option value="referral">Referral</option>
        <option value="employee">Employee</option>
      </select>
      <select class="contact-response bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-xs outline-none focus:ring-2 focus:ring-blue-600/20">
        <option value="not_contacted">Not contacted</option>
        <option value="outreach_sent">Outreach sent</option>
        <option value="responded">Responded</option>
        <option value="no_response">No response</option>
        <option value="follow_up_due">Follow-up due</option>
      </select>
      <input class="contact-linkedin bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-xs outline-none focus:ring-2 focus:ring-blue-600/20" placeholder="LinkedIn URL">
      <input class="contact-email bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-xs outline-none focus:ring-2 focus:ring-blue-600/20" placeholder="Email">
      <input class="contact-follow-up bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-xs outline-none focus:ring-2 focus:ring-blue-600/20" type="date">
      <button class="contact-save-btn bg-primary text-white text-xs font-semibold px-3 py-2 rounded-lg hover:opacity-90">Save Contact</button>
    </div>
    <p class="contact-error hidden text-xs text-rose-600 mt-2"></p>
  </div>`;
}

function renderContactRow(contact) {
  const badgeCls = contact.responseStatus === 'responded'
    ? 'bg-emerald-50 text-emerald-700'
    : contact.responseStatus === 'follow_up_due'
      ? 'bg-amber-50 text-amber-700'
      : 'bg-slate-100 text-slate-600';
  const meta = [
    contact.title,
    contact.company,
    contact.followUpDue ? `Follow up ${contact.followUpDue}` : '',
  ].filter(Boolean).join(' · ');
  const drafts = Array.isArray(contact.outreachDrafts) ? contact.outreachDrafts.slice(-3).reverse() : [];
  return `<div class="contact-row border border-slate-100 rounded-lg px-3 py-2" data-contact-id="${esc(contact.id)}">
    <div class="flex flex-col lg:flex-row lg:items-center justify-between gap-2">
      <div class="min-w-0">
        <p class="text-xs font-semibold text-slate-700 truncate">${esc(contact.name)}</p>
        <p class="text-[11px] text-slate-400 truncate">${esc(contact.relationshipType)}${meta ? ` · ${esc(meta)}` : ''}</p>
      </div>
      <div class="flex flex-wrap items-center gap-2">
        ${contact.linkedinUrl ? `<a class="text-[11px] text-blue-600 hover:underline" href="${esc(contact.linkedinUrl)}" target="_blank" rel="noopener">LinkedIn</a>` : ''}
        ${contact.email ? `<a class="text-[11px] text-blue-600 hover:underline" href="mailto:${esc(contact.email)}">Email</a>` : ''}
        <span class="text-[10px] font-bold uppercase tracking-wide rounded px-1.5 py-0.5 ${badgeCls}">${esc(contact.responseStatus || 'not_contacted')}</span>
        <button class="contact-edit-btn text-[11px] font-semibold text-slate-500 hover:text-blue-600">Edit</button>
        <button class="contact-outreach-btn text-[11px] font-semibold text-slate-500 hover:text-blue-600">Outreach sent</button>
      </div>
    </div>
    <div class="flex flex-col sm:flex-row gap-2 mt-2">
      <select class="contact-draft-type bg-slate-50 border border-slate-200 rounded-lg px-2 py-1.5 text-[11px] outline-none focus:ring-2 focus:ring-blue-600/20">
        <option value="linkedin_connection">LinkedIn connection</option>
        <option value="linkedin_follow_up">LinkedIn follow-up</option>
        <option value="email">Email</option>
      </select>
      <button class="contact-draft-btn text-[11px] font-semibold text-slate-500 border border-slate-200 rounded-lg px-2.5 py-1.5 hover:bg-slate-50">Generate draft</button>
    </div>
    ${drafts.length ? `<div class="mt-2 space-y-2">
      ${drafts.map(draft => `<div>
        <p class="text-[10px] font-bold uppercase tracking-wide text-slate-400 mb-1">${esc(statusDisplayLabel(draft.type))} · ${fmtDateTime(draft.generatedAt)}</p>
        <textarea readonly class="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-xs text-slate-600 leading-relaxed resize-y" rows="4">${esc(draft.text)}</textarea>
      </div>`).join('')}
    </div>` : ''}
  </div>`;
}

function renderWorkflowActions(job) {
  const actions = [
    ['outreach_sent', 'Outreach sent'],
    ['follow_up_done', 'Follow-up done'],
    ['recruiter_reply', 'Recruiter reply'],
    ['interview_scheduled', 'Interview scheduled'],
  ];
  return `<div class="workflow-actions bg-white border border-slate-200 rounded-lg p-3 mb-3" data-job-id="${esc(job.id)}">
    <div class="flex flex-wrap gap-2 mb-2">
      ${actions.map(([type, label]) => `
        <button class="workflow-action-btn text-xs font-semibold text-slate-600 border border-slate-200 rounded-lg px-2.5 py-1.5 hover:bg-slate-50" data-type="${type}">
          ${esc(label)}
        </button>`).join('')}
    </div>
    <div class="flex flex-col sm:flex-row gap-2">
      <input class="workflow-note-input flex-1 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-xs outline-none focus:ring-2 focus:ring-blue-600/20"
        maxlength="1000" placeholder="Optional note">
      <button class="workflow-note-btn bg-primary text-white text-xs font-semibold px-3 py-2 rounded-lg hover:opacity-90">Add note</button>
    </div>
    <p class="workflow-action-error hidden text-xs text-rose-600 mt-2"></p>
  </div>`;
}

function workflowTimelineItems(job) {
  const timeline = Array.isArray(job._workflow?.timeline) ? job._workflow.timeline : [];
  return timeline.slice(-6).reverse();
}

function nextActionLabel(action) {
  const labels = {
    generate_resume: 'Generate resume',
    apply: 'Apply',
    send_outreach: 'Send outreach',
    follow_up: 'Follow up',
    prep_interview: 'Prep interview',
    archive: 'Archive',
  };
  return labels[action] || action;
}

function workflowEventLabel(type) {
  const labels = {
    discovered: 'Discovered',
    evaluated: 'Evaluated',
    resume_generated: 'Resume generated',
    applied: 'Applied',
    outreach_sent: 'Outreach sent',
    recruiter_reply: 'Recruiter reply',
    interview_scheduled: 'Interview scheduled',
    rejected: 'Rejected',
    follow_up_done: 'Follow-up done',
    note_added: 'Note added',
  };
  return labels[type] || type;
}

function workflowStaleLabel(staleness) {
  if (staleness.needsAppliedFollowUp) return `Applied ${staleness.appliedForDays}d ago`;
  if (staleness.staleLead) return `No activity ${staleness.inactiveForDays}d`;
  return 'Needs review';
}

function generatedResumeVersions(job) {
  const docs = job.generatedDocs;
  if (!docs || typeof docs !== 'object' || Array.isArray(docs)) return [];
  const versions = [];
  for (const [variant, entry] of Object.entries(docs)) {
    if (!entry || typeof entry !== 'object') continue;
    const history = Array.isArray(entry.history) && entry.history.length
      ? entry.history
      : entry.docxUrl ? [entry] : [];
    history.forEach(item => {
      if (!item?.docxUrl) return;
      versions.push({
        variant,
        strategy: item.strategy || item.variant || entry.strategy || variant,
        generatedAt: item.generatedAt || entry.generatedAt || '',
        evaluatorScore: item.evaluatorScore ?? entry.evaluatorScore ?? null,
        atsScore: item.atsScore ?? entry.atsScore ?? null,
        sourceJobId: item.sourceJobId || entry.sourceJobId || job.id,
        fileName: item.fileName || entry.fileName || item.docxUrl.split('/').filter(Boolean).pop(),
        docxUrl: item.docxUrl,
      });
    });
  }
  return versions.sort((a, b) => String(b.generatedAt || '').localeCompare(String(a.generatedAt || ''))).slice(0, 6);
}

function resumeVersionScoreLabel(version) {
  const bits = [];
  if (version.evaluatorScore != null) bits.push(`Eval ${version.evaluatorScore}`);
  if (version.atsScore != null) bits.push(`ATS ${Math.round(version.atsScore)}%`);
  return bits.join(' · ') || 'Score —';
}

// ─── Interview detail panel ──────────────────────────────────────────────────
function buildIntDetailPanel(job) {
  const parts = [];

  // Reuse dashboard detail content (URL, next steps, analysis, CV match, gaps)
  parts.push(buildDetailPanel(job));

  // Gmail update
  if (job.last_email_date) {
    parts.push(`
      <div class="bg-white border border-slate-200 rounded-lg p-3 mt-4 space-y-1">
        <p class="text-[10px] font-bold uppercase tracking-wide text-slate-400">Latest Gmail Update · ${fmtDateTime(job.last_email_date)}</p>
        <p class="text-xs font-semibold text-slate-700 leading-snug">${esc(job.last_email_subject || '')}</p>
        ${job.last_email_snippet ? `<p class="text-xs text-slate-500 leading-relaxed">${esc(decodeEntities(job.last_email_snippet))}</p>` : ''}
      </div>`);
  }

  // Full job description
  const jd = job.full_description || job.description_preview || '';
  if (jd) {
    parts.push(`
      <div class="mt-4">
        <p class="text-[10px] font-bold uppercase tracking-wide text-slate-400 mb-2">Job Description</p>
        <div class="bg-white border border-slate-200 rounded-lg p-4 text-xs text-slate-600 leading-relaxed whitespace-pre-wrap max-h-64 overflow-y-auto">${esc(jd)}</div>
      </div>`);
  }

  // Notes
  parts.push(`
    <div class="mt-4">
      <p class="text-[10px] font-bold uppercase tracking-wide text-slate-400 mb-2">Notes</p>
      <div class="int-notes-log divide-y divide-slate-100 mb-2" data-id="${esc(job.id)}">${renderNotesLog(job.notes || '')}</div>
      <div class="flex gap-2 items-end">
        <textarea class="int-note-input flex-1 bg-white border border-slate-200 rounded-lg px-3 py-2 text-xs resize-none outline-none focus:ring-2 focus:ring-blue-600/20 focus:border-blue-300"
          data-id="${esc(job.id)}" rows="2" placeholder="Add a note…"></textarea>
        <button class="int-note-submit hidden bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-xs font-semibold px-3 py-1.5 rounded-lg transition-colors"
          data-id="${esc(job.id)}">Submit</button>
      </div>
    </div>`);

  return parts.join('');
}

// ─── Interviews ───────────────────────────────────────────────────────────────
function setupInterviews() {
  // Derive the stages present in interview-stage jobs
  const intJobs    = allJobs.filter(j => INTERVIEW_STATUSES.has(j.status||''));
  const intStatuses = [...new Set(intJobs.map(j => j.status).filter(Boolean))].sort();
  const intSel = document.getElementById('int-status-filter');
  intStatuses.forEach(s => {
    const o = document.createElement('option');
    o.value = s; o.textContent = s;
    intSel.appendChild(o);
  });

  document.getElementById('int-search').addEventListener('input',          renderInterviews);
  document.getElementById('int-status-filter').addEventListener('change',  renderInterviews);
  document.getElementById('int-sort').addEventListener('change',            renderInterviews);

  renderInterviews();
}

function renderInterviews() {
  const q        = (document.getElementById('int-search').value || '').toLowerCase();
  const statusF  = document.getElementById('int-status-filter').value;
  const sortVal  = document.getElementById('int-sort').value;

  let list = allJobs.filter(j => INTERVIEW_STATUSES.has(j.status||''));

  if (q)       list = list.filter(j => ((j.company||'') + ' ' + (j.title||'')).toLowerCase().includes(q));
  if (statusF) list = list.filter(j => j.status === statusF);

  list.sort((a, b) => {
    switch (sortVal) {
      case 'date_asc':     return (a.date_updated||'').localeCompare(b.date_updated||'');
      case 'company_asc':  return (a.company||'').toLowerCase().localeCompare((b.company||'').toLowerCase());
      case 'company_desc': return (b.company||'').toLowerCase().localeCompare((a.company||'').toLowerCase());
      case 'score_desc': {
        const as = atsPercent(a) ?? -1, bs = atsPercent(b) ?? -1;
        return bs - as;
      }
      case 'stage_desc': {
        const ai = STATUS_ORDER.indexOf((a.status||'').toLowerCase());
        const bi = STATUS_ORDER.indexOf((b.status||'').toLowerCase());
        return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
      }
      default: return (b.date_updated||'').localeCompare(a.date_updated||''); // date_desc
    }
  });

  const total = allJobs.filter(j => INTERVIEW_STATUSES.has(j.status||'')).length;
  document.getElementById('int-count-label').textContent =
    list.length === total
      ? `${total} active interview loop${total !== 1 ? 's' : ''}`
      : `${list.length} of ${total} interview loops`;
  document.getElementById('int-empty').classList.toggle('hidden', list.length > 0);

  const tbody = document.getElementById('int-tbody');
  tbody.innerHTML = '';

  list.forEach(job => {
    const atsColor = atsScoreColor(job);
    const atsStr   = atsScoreLabel(job);
    const nextStep = compactNextStep(job);
    const detailId = 'int-detail-' + job.id;

    const tr = document.createElement('tr');
    tr.className = 'border-b border-slate-100 hover:bg-slate-50 transition-colors cursor-pointer';
    tr.dataset.detailId = detailId;
    tr.innerHTML = `
      <td class="px-4 py-3">
        <div class="flex items-center gap-3">
          <div class="w-8 h-8 rounded-lg bg-amber-50 flex items-center justify-center text-xs font-bold text-amber-700 shrink-0">
            ${esc((job.company||'?').slice(0,2).toUpperCase())}
          </div>
          <div class="min-w-0">
            <p class="font-semibold text-on-surface truncate max-w-xs">${esc(job.company)}</p>
            <p class="text-xs text-slate-500 truncate max-w-xs">${esc(job.title)}</p>
            ${nextStep ? `<p class="text-[11px] text-slate-400 truncate max-w-xs mt-0.5">Next: ${esc(nextStep)}</p>` : ''}
          </div>
        </div>
      </td>
      <td class="px-4 py-3">
        ${statusBadge(job.status)}
        ${latestNoteText(job.notes) ? `<p class="text-xs text-slate-500 whitespace-pre-wrap break-words max-w-sm mt-1 leading-snug">${esc(latestNoteText(job.notes))}</p>` : ''}
      </td>
      <td class="px-4 py-3 hidden md:table-cell"><span class="font-bold ${atsColor}">${atsStr}</span></td>
      <td class="px-4 py-3 text-xs text-slate-500 hidden lg:table-cell">${esc(job.location||'—')}</td>
      <td class="px-4 py-3 text-xs text-slate-400 hidden md:table-cell">${fmtDate(job.date_updated)}</td>
      <td class="px-4 py-3">
        <div class="flex items-center gap-2">
          <button class="int-add-note-btn px-3 py-1.5 bg-primary text-white text-xs font-bold rounded-lg hover:opacity-90 transition-opacity"
            data-id="${esc(job.id)}">Add note</button>
          <button class="int-edit-btn p-1.5 text-slate-400 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-colors"
            data-id="${esc(job.id)}" title="Edit job">
            <span class="material-symbols-outlined text-base leading-none">edit</span>
          </button>
        </div>
      </td>`;

    // Detail expansion row
    const dRow = document.createElement('tr');
    dRow.id = detailId;
    dRow.className = 'hidden bg-slate-50/60';
    dRow.innerHTML = `<td colspan="6" class="px-6 py-5 border-b border-slate-100">${buildIntDetailPanel(job)}</td>`;

    // Progress row
    const pRow = document.createElement('tr');
    pRow.id = 'int-prog-' + job.id;
    pRow.className = 'hidden';
    pRow.innerHTML = `<td colspan="6" class="px-6 pb-4 bg-slate-50/50">
      <div class="stage-log text-xs space-y-0.5 font-mono mt-1"></div>
      <div class="downloads mt-2 flex gap-4 text-xs"></div>
    </td>`;

    tbody.appendChild(tr);
    tbody.appendChild(dRow);
    tbody.appendChild(pRow);
  });

  // Row click → toggle detail; ignore button clicks
  tbody.querySelectorAll('tr[data-detail-id]').forEach(tr => {
    tr.addEventListener('click', e => {
      if (e.target.closest('.int-add-note-btn') || e.target.closest('.int-edit-btn')) return;
      document.getElementById(tr.dataset.detailId)?.classList.toggle('hidden');
    });
  });

  tbody.querySelectorAll('.int-add-note-btn').forEach(btn => {
    btn.addEventListener('click', () => openInterviewNote(btn.dataset.id));
  });

  tbody.querySelectorAll('.int-edit-btn').forEach(btn => {
    btn.addEventListener('click', () => openEditModal(btn.dataset.id));
  });

  // Note textarea → show submit only when content present
  tbody.querySelectorAll('.int-note-input').forEach(ta => {
    const submitBtn = tbody.querySelector(`.int-note-submit[data-id="${CSS.escape(ta.dataset.id)}"]`);
    ta.addEventListener('input', () => {
      if (submitBtn) submitBtn.classList.toggle('hidden', !ta.value.trim());
    });
  });

  tbody.querySelectorAll('.int-note-submit').forEach(btn => {
    btn.addEventListener('click', async () => {
      const jobId = btn.dataset.id;
      const ta    = tbody.querySelector(`.int-note-input[data-id="${CSS.escape(jobId)}"]`);
      const logEl = tbody.querySelector(`.int-notes-log[data-id="${CSS.escape(jobId)}"]`);
      const text  = ta.value.trim();
      if (!text) return;
      btn.disabled = true;
      btn.textContent = 'Saving…';
      const today    = new Date().toISOString().slice(0, 10);
      const job      = allJobs.find(j => j.id === jobId);
      const existing = (job?.notes || '').trim();
      const newNotes = existing ? `${today}: ${text}\n${existing}` : `${today}: ${text}`;
      try {
        await patchJob(jobId, { notes: newNotes });
        if (job) job.notes = newNotes;
        ta.value = '';
        btn.classList.add('hidden');
        if (logEl) logEl.innerHTML = renderNotesLog(newNotes);
      } catch (e) {
        alert('Failed to save note: ' + e.message);
      } finally {
        btn.disabled = false;
        btn.textContent = 'Submit';
      }
    });
  });

  bindWorkflowActions(tbody);
  bindContactWorkspace(tbody);
}

function bindWorkflowActions(root = document) {
  root.querySelectorAll('.workflow-actions').forEach(panel => {
    if (panel.dataset.bound === '1') return;
    panel.dataset.bound = '1';
    panel.querySelectorAll('.workflow-action-btn').forEach(btn => {
      btn.addEventListener('click', () => submitWorkflowAction(panel, btn.dataset.type, btn));
    });
    panel.querySelector('.workflow-note-btn')?.addEventListener('click', event => {
      submitWorkflowAction(panel, 'note_added', event.currentTarget);
    });
    panel.querySelector('.workflow-note-input')?.addEventListener('keydown', event => {
      if (event.key === 'Enter') submitWorkflowAction(panel, 'note_added', panel.querySelector('.workflow-note-btn'));
    });
  });
}

async function submitWorkflowAction(panel, type, btn) {
  const jobId = panel.dataset.jobId;
  const input = panel.querySelector('.workflow-note-input');
  const errorEl = panel.querySelector('.workflow-action-error');
  const note = input?.value.trim() || '';
  if (!jobId || !type) return;
  if (type === 'note_added' && !note) {
    if (errorEl) {
      errorEl.textContent = 'Add a note first.';
      errorEl.classList.remove('hidden');
    }
    return;
  }
  const originalText = btn?.textContent;
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Saving...';
  }
  if (errorEl) errorEl.classList.add('hidden');
  try {
    await postWorkflowEvent(jobId, { type, note });
    await refreshDashboardState();
    if (input) input.value = '';
    renderAllViews();
  } catch (e) {
    if (errorEl) {
      errorEl.textContent = e.message;
      errorEl.classList.remove('hidden');
    } else {
      alert('Workflow action failed: ' + e.message);
    }
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = originalText;
    }
  }
}

function bindContactWorkspace(root = document) {
  root.querySelectorAll('.contact-workspace').forEach(panel => {
    if (panel.dataset.bound === '1') return;
    panel.dataset.bound = '1';
    panel.querySelector('.contact-save-btn')?.addEventListener('click', event => {
      submitContact(panel, event.currentTarget);
    });
    panel.querySelectorAll('.contact-edit-btn').forEach(btn => {
      btn.addEventListener('click', () => populateContactForm(panel, btn.closest('.contact-row')?.dataset.contactId));
    });
    panel.querySelectorAll('.contact-outreach-btn').forEach(btn => {
      btn.addEventListener('click', () => markContactOutreach(panel, btn.closest('.contact-row')?.dataset.contactId, btn));
    });
    panel.querySelectorAll('.contact-draft-btn').forEach(btn => {
      btn.addEventListener('click', () => generateContactDraft(panel, btn.closest('.contact-row'), btn));
    });
  });
}

function contactPanelJob(panel) {
  return allJobs.find(job => job.id === panel.dataset.jobId);
}

function contactById(panel, contactId) {
  const job = contactPanelJob(panel);
  return (Array.isArray(job?.contacts) ? job.contacts : []).find(contact => contact.id === contactId);
}

function populateContactForm(panel, contactId) {
  const contact = contactById(panel, contactId);
  if (!contact) return;
  panel.dataset.editContactId = contact.id;
  panel.querySelector('.contact-name').value = contact.name || '';
  panel.querySelector('.contact-title').value = contact.title || '';
  panel.querySelector('.contact-type').value = contact.relationshipType || 'recruiter';
  panel.querySelector('.contact-response').value = contact.responseStatus || 'not_contacted';
  panel.querySelector('.contact-linkedin').value = contact.linkedinUrl || '';
  panel.querySelector('.contact-email').value = contact.email || '';
  panel.querySelector('.contact-follow-up').value = contact.followUpDue || '';
  panel.querySelector('.contact-name')?.focus();
}

function readContactForm(panel) {
  const job = contactPanelJob(panel);
  return {
    id: panel.dataset.editContactId || '',
    name: panel.querySelector('.contact-name')?.value.trim() || '',
    title: panel.querySelector('.contact-title')?.value.trim() || '',
    company: job?.company || '',
    relationshipType: panel.querySelector('.contact-type')?.value || 'recruiter',
    responseStatus: panel.querySelector('.contact-response')?.value || 'not_contacted',
    linkedinUrl: panel.querySelector('.contact-linkedin')?.value.trim() || '',
    email: panel.querySelector('.contact-email')?.value.trim() || '',
    followUpDue: panel.querySelector('.contact-follow-up')?.value || '',
  };
}

async function submitContact(panel, btn) {
  const errorEl = panel.querySelector('.contact-error');
  const originalText = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Saving...';
  errorEl?.classList.add('hidden');
  try {
    await upsertJobContact(panel.dataset.jobId, { contact: readContactForm(panel) });
    await refreshDashboardState();
    renderAllViews();
  } catch (e) {
    if (errorEl) {
      errorEl.textContent = e.message;
      errorEl.classList.remove('hidden');
    }
  } finally {
    btn.disabled = false;
    btn.textContent = originalText;
  }
}

async function markContactOutreach(panel, contactId, btn) {
  const contact = contactById(panel, contactId);
  if (!contact) return;
  const originalText = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Saving...';
  try {
    await upsertJobContact(panel.dataset.jobId, {
      contact: { ...contact, responseStatus: 'outreach_sent' },
      markOutreachSent: true,
    });
    await refreshDashboardState();
    renderAllViews();
  } catch (e) {
    const errorEl = panel.querySelector('.contact-error');
    if (errorEl) {
      errorEl.textContent = e.message;
      errorEl.classList.remove('hidden');
    }
  } finally {
    btn.disabled = false;
    btn.textContent = originalText;
  }
}

async function generateContactDraft(panel, row, btn) {
  const contactId = row?.dataset.contactId;
  const type = row?.querySelector('.contact-draft-type')?.value || 'linkedin_connection';
  if (!contactId) return;
  const originalText = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Generating...';
  try {
    await generateContactOutreachDraft(panel.dataset.jobId, { contactId, type });
    await refreshDashboardState();
    renderAllViews();
  } catch (e) {
    const errorEl = panel.querySelector('.contact-error');
    if (errorEl) {
      errorEl.textContent = e.message;
      errorEl.classList.remove('hidden');
    }
  } finally {
    btn.disabled = false;
    btn.textContent = originalText;
  }
}

async function refreshDashboardState() {
  const data = await fetchDashboard();
  allJobs = data.jobs || [];
  workflowSummary = data.workflowSummary || workflowSummary;
  dashboardMeta = createDashboardMeta(data);
  invalidateWorkspaceCaches();
}

function renderAllViews() {
  renderDashboard();
  applyOppFilters();
  renderGmailAmbiguities();
  renderInterviews();
  renderRejected();
  if (currentJobDetailId) renderJobsWorkspace();
  if (resumeWorkspace) renderResumeWorkspace();
  if (outreachWorkspace) renderOutreachWorkspace();
  if (contactsWorkspace) renderContactsWorkspace();
  if (analyticsSummary) renderAnalyticsWorkspace();
  if (settingsHealth) renderSettingsWorkspace();
}

function invalidateWorkspaceCaches() {
  resumeWorkspace = null;
  outreachWorkspace = null;
  contactsWorkspace = null;
  analyticsSummary = null;
  settingsHealth = null;
}

function setupOperationalWorkspaces() {
  document.getElementById('resume-filter')?.addEventListener('change', renderResumeWorkspace);
  document.getElementById('contacts-search')?.addEventListener('input', renderContactsWorkspace);
  document.getElementById('contacts-relationship-filter')?.addEventListener('change', renderContactsWorkspace);
  document.getElementById('contacts-response-filter')?.addEventListener('change', renderContactsWorkspace);
}

function renderWorkspaceView(viewName) {
  if (viewName === 'jobs') renderJobsWorkspace();
  if (viewName === 'resume') renderResumeWorkspace();
  if (viewName === 'outreach') renderOutreachWorkspace();
  if (viewName === 'contacts') renderContactsWorkspace();
  if (viewName === 'analytics') renderAnalyticsWorkspace();
  if (viewName === 'settings') renderSettingsWorkspace();
}

function showJobDetail(jobId, { push = true } = {}) {
  currentJobDetailId = jobId;
  showView('jobs', { push: false });
  if (push) history.pushState({ view: 'jobs', jobId }, '', `/jobs/${encodeURIComponent(jobId)}`);
  renderJobsWorkspace();
}

async function renderJobsWorkspace() {
  const detailRoot = document.getElementById('job-detail-root');
  const listRoot = document.getElementById('jobs-list-root');
  const countEl = document.getElementById('jobs-count-label');
  if (!detailRoot || !listRoot || !countEl) return;

  if (currentJobDetailId) {
    detailRoot.innerHTML = `<div class="bg-white rounded-xl border border-slate-200 shadow-sm p-4 text-sm text-slate-500">Loading job detail…</div>`;
    listRoot.innerHTML = '';
    try {
      const job = await fetchJobDetail(currentJobDetailId);
      countEl.textContent = `${job.company || 'Unknown company'} · ${job.title || 'Unknown role'}`;
      detailRoot.innerHTML = renderJobDetailWorkspace(job);
      bindWorkflowActions(detailRoot);
      bindContactWorkspace(detailRoot);
      bindJobDetailActions(detailRoot, job);
    } catch (e) {
      countEl.textContent = 'Job detail unavailable';
      detailRoot.innerHTML = `<div class="bg-white rounded-xl border border-rose-200 shadow-sm p-4 text-sm text-rose-600">${esc(e.message)}</div>`;
    }
    return;
  }

  detailRoot.innerHTML = '';
  const jobs = [...allJobs].sort((a, b) => String(b.date_updated || '').localeCompare(String(a.date_updated || '')));
  countEl.textContent = `${jobs.length} tracked job${jobs.length === 1 ? '' : 's'}`;
  listRoot.innerHTML = `<table class="dashboard-table w-full text-sm">
    <thead>
      <tr class="border-b border-slate-200 bg-slate-50">
        <th class="text-left px-4 py-3 text-xs font-bold text-slate-500 uppercase tracking-wide">Company / Role</th>
        <th class="text-left px-4 py-3 text-xs font-bold text-slate-500 uppercase tracking-wide">Status</th>
        <th class="text-left px-4 py-3 text-xs font-bold text-slate-500 uppercase tracking-wide hidden md:table-cell">ATS</th>
        <th class="text-left px-4 py-3 text-xs font-bold text-slate-500 uppercase tracking-wide hidden lg:table-cell">Next</th>
        <th class="text-left px-4 py-3 text-xs font-bold text-slate-500 uppercase tracking-wide">Action</th>
      </tr>
    </thead>
    <tbody>
      ${jobs.map(job => `<tr class="border-b border-slate-100 hover:bg-slate-50">
        <td class="px-4 py-3">
          <p class="font-semibold text-slate-800">${esc(job.company || 'Unknown')}</p>
          <p class="text-xs text-slate-500">${esc(job.title || '')}</p>
        </td>
        <td class="px-4 py-3">${statusBadge(job.status)}</td>
        <td class="px-4 py-3 hidden md:table-cell"><span class="font-bold ${atsScoreColor(job)}">${atsScoreLabel(job)}</span></td>
        <td class="px-4 py-3 hidden lg:table-cell text-xs text-slate-500">${esc(compactNextStep(job) || 'Review')}</td>
        <td class="px-4 py-3">
          <button class="job-open-btn text-xs font-semibold text-blue-600 border border-blue-100 rounded-lg px-3 py-1.5 hover:bg-blue-50" data-id="${esc(job.id)}">Open</button>
        </td>
      </tr>`).join('')}
    </tbody>
  </table>`;
  listRoot.querySelectorAll('.job-open-btn').forEach(btn => {
    btn.addEventListener('click', () => showJobDetail(btn.dataset.id));
  });
}

function renderJobDetailWorkspace(job) {
  const versions = Array.isArray(job.resumeVersions) ? job.resumeVersions : generatedResumeVersions(job);
  const gmail = job.gmail || {};
  return `<div class="space-y-4">
    <div class="flex items-center justify-between gap-3">
      <button id="job-detail-back" class="text-xs font-semibold text-slate-500 border border-slate-200 rounded-lg px-3 py-1.5 hover:bg-slate-50">Back to jobs</button>
      <div class="flex items-center gap-2">
        ${job.url ? `<a href="${esc(job.url)}" target="_blank" rel="noopener" class="text-xs font-semibold text-blue-600 border border-blue-100 rounded-lg px-3 py-1.5 hover:bg-blue-50">Posting</a>` : ''}
        <button class="gen-btn bg-primary text-white text-xs font-semibold rounded-lg px-3 py-1.5 hover:opacity-90" data-id="${esc(job.id)}">Generate resume</button>
        <button class="job-detail-edit text-xs font-semibold text-slate-600 border border-slate-200 rounded-lg px-3 py-1.5 hover:bg-slate-50" data-id="${esc(job.id)}">Edit</button>
      </div>
    </div>
    <div class="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_320px] gap-4">
      <div class="space-y-4">
        <div class="bg-white rounded-xl border border-slate-200 shadow-sm p-4">
          <div class="flex items-start justify-between gap-3 mb-3">
            <div>
              <p class="text-[10px] font-bold uppercase tracking-wide text-slate-400">Opportunity</p>
              <h3 class="text-xl font-bold text-slate-900">${esc(job.company || 'Unknown company')}</h3>
              <p class="text-sm text-slate-500">${esc(job.title || 'Unknown role')}</p>
            </div>
            ${statusBadge(job.status)}
          </div>
          <div class="grid grid-cols-4 gap-2 mb-4">
            ${workspaceMetricCard('ATS', atsScoreLabel(job), atsScoreColor(job))}
            ${workspaceMetricCard('OI', job._oi?.score ?? '—', 'text-slate-800')}
            ${workspaceMetricCard('Resumes', versions.length, 'text-slate-800')}
            ${workspaceMetricCard('Contacts', (job.contacts || []).length, 'text-slate-800')}
          </div>
          ${buildDetailPanel(job)}
        </div>
        <div class="bg-white rounded-xl border border-slate-200 shadow-sm p-4">
          <p class="text-label-caps font-label-caps text-slate-500 mb-3">GMAIL SIGNALS</p>
          ${gmail.lastEmailDate ? `<div class="text-sm">
            <p class="font-semibold text-slate-700">${esc(gmail.lastEmailSubject || 'Latest Gmail signal')}</p>
            <p class="text-xs text-slate-400">${fmtDateTime(gmail.lastEmailDate)}</p>
            <p class="text-xs text-slate-500 mt-2">${esc(gmail.lastEmailSnippet || '')}</p>
          </div>` : '<p class="text-sm text-slate-400">No Gmail signal attached.</p>'}
        </div>
      </div>
      <div class="space-y-4">
        <div class="bg-white rounded-xl border border-slate-200 shadow-sm p-4">
          <p class="text-label-caps font-label-caps text-slate-500 mb-2">NEXT ACTION</p>
          <p class="text-lg font-bold text-slate-800">${esc(nextActionLabel(job._workflow?.nextBestAction || 'review'))}</p>
          ${job._workflow?.staleness?.stale ? `<p class="text-xs text-amber-700 mt-1">${esc(workflowStaleLabel(job._workflow.staleness))}</p>` : ''}
        </div>
        <div class="bg-white rounded-xl border border-slate-200 shadow-sm p-4">
          <p class="text-label-caps font-label-caps text-slate-500 mb-3">RESUME VERSIONS</p>
          ${versions.length ? versions.slice(0, 8).map(version => `<div class="border-b border-slate-100 last:border-0 py-2">
            <a href="${esc(version.docxUrl)}" download class="text-xs font-semibold text-blue-600 hover:underline">${esc(version.fileName)}</a>
            <p class="text-[11px] text-slate-400">${fmtDateTime(version.generatedAt)} · ${esc(resumeVersionScoreLabel(version))}</p>
          </div>`).join('') : '<p class="text-sm text-slate-400">No generated resume yet.</p>'}
        </div>
      </div>
    </div>
  </div>`;
}

function bindJobDetailActions(root, job) {
  root.querySelector('#job-detail-back')?.addEventListener('click', () => {
    currentJobDetailId = '';
    history.pushState({ view: 'jobs' }, '', '/jobs');
    renderJobsWorkspace();
  });
  root.querySelector('.job-detail-edit')?.addEventListener('click', () => openEditModal(job.id));
  root.querySelector('.gen-btn')?.addEventListener('click', event => triggerGenerate(job.id, event.currentTarget));
}

async function loadResumeWorkspace() {
  if (!resumeWorkspace) resumeWorkspace = await fetchResumeWorkspace();
  return resumeWorkspace;
}

async function renderResumeWorkspace() {
  const queueRoot = document.getElementById('resume-queue-root');
  const versionsRoot = document.getElementById('resume-versions-root');
  const qualityRoot = document.getElementById('resume-quality-root');
  const countEl = document.getElementById('resume-count-label');
  if (!queueRoot || !versionsRoot || !qualityRoot || !countEl) return;
  try {
    const data = await loadResumeWorkspace();
    const filter = document.getElementById('resume-filter')?.value || '';
    let queue = data.queue || [];
    if (filter === 'high_ats') queue = queue.filter(item => Number(item.atsScore) >= 80);
    else if (filter === 'low_ats') queue = queue.filter(item => item.atsScore == null || Number(item.atsScore) < 50);
    else if (filter) queue = queue.filter(item => item.resumeStatus === filter);
    countEl.textContent = `${queue.length} queue item${queue.length === 1 ? '' : 's'} · ${(data.versions || []).length} generated version${(data.versions || []).length === 1 ? '' : 's'}`;
    queueRoot.innerHTML = renderResumeQueueTable(queue);
    versionsRoot.innerHTML = renderResumeVersionHistory(data.versions || []);
    qualityRoot.innerHTML = renderSourceQualityCoach(data.sourceQuality);
    queueRoot.querySelectorAll('.resume-job-link').forEach(btn => btn.addEventListener('click', () => showJobDetail(btn.dataset.id)));
    queueRoot.querySelectorAll('.gen-btn').forEach(btn => btn.addEventListener('click', () => triggerGenerate(btn.dataset.id, btn)));
  } catch (e) {
    countEl.textContent = 'Resume workspace unavailable';
    queueRoot.innerHTML = `<div class="p-4 text-sm text-rose-600">${esc(e.message)}</div>`;
  }
}

function renderResumeQueueTable(queue) {
  if (!queue.length) return '<div class="p-12 text-center text-slate-400">No resume work matches this filter.</div>';
  return `<table class="dashboard-table w-full text-sm">
    <thead><tr class="border-b border-slate-200 bg-slate-50">
      <th class="text-left px-4 py-3 text-xs font-bold text-slate-500 uppercase tracking-wide">Role</th>
      <th class="text-left px-4 py-3 text-xs font-bold text-slate-500 uppercase tracking-wide">Status</th>
      <th class="text-left px-4 py-3 text-xs font-bold text-slate-500 uppercase tracking-wide">ATS</th>
      <th class="text-left px-4 py-3 text-xs font-bold text-slate-500 uppercase tracking-wide">Last Version</th>
      <th class="text-left px-4 py-3 text-xs font-bold text-slate-500 uppercase tracking-wide">Action</th>
    </tr></thead>
    <tbody>${queue.map(item => `<tr class="border-b border-slate-100 hover:bg-slate-50">
      <td class="px-4 py-3"><p class="font-semibold text-slate-800">${esc(item.company)}</p><p class="text-xs text-slate-500">${esc(item.title)}</p></td>
      <td class="px-4 py-3"><span class="text-xs font-bold uppercase tracking-wide rounded px-2 py-0.5 ${resumeStatusClass(item.resumeStatus)}">${esc(statusDisplayLabel(item.resumeStatus))}</span></td>
      <td class="px-4 py-3 font-bold ${item.atsScore >= 80 ? 'text-emerald-600' : item.atsScore >= 50 ? 'text-amber-600' : 'text-rose-600'}">${item.atsScore == null ? '—' : item.atsScore + '%'}</td>
      <td class="px-4 py-3 text-xs text-slate-500">${item.latestVersion ? fmtDateTime(item.latestVersion.generatedAt) : '—'}</td>
      <td class="px-4 py-3"><div class="flex gap-2">
        <button class="resume-job-link text-xs font-semibold text-blue-600 border border-blue-100 rounded-lg px-3 py-1.5 hover:bg-blue-50" data-id="${esc(item.jobId)}">Open</button>
        <button class="gen-btn text-xs font-semibold bg-primary text-white rounded-lg px-3 py-1.5 hover:opacity-90" data-id="${esc(item.jobId)}">Generate</button>
      </div></td>
    </tr>`).join('')}</tbody>
  </table>`;
}

function resumeStatusClass(status) {
  if (status === 'running') return 'bg-blue-50 text-blue-700';
  if (status === 'blocked') return 'bg-rose-50 text-rose-700';
  if (status === 'generated') return 'bg-emerald-50 text-emerald-700';
  return 'bg-amber-50 text-amber-700';
}

function renderResumeVersionHistory(versions) {
  return `<p class="text-label-caps font-label-caps text-slate-500 mb-3">VERSION HISTORY</p>
    ${versions.length ? `<div class="divide-y divide-slate-100">${versions.slice(0, 12).map(version => `<div class="py-2 flex items-center justify-between gap-3">
      <div class="min-w-0">
        <a href="${esc(version.docxUrl)}" download class="text-xs font-semibold text-blue-600 hover:underline truncate block">${esc(version.fileName)}</a>
        <p class="text-[11px] text-slate-400">${esc(version.company)} · ${esc(version.title)}</p>
      </div>
      <p class="text-[11px] text-slate-500 shrink-0">${fmtDateTime(version.generatedAt)} · ${esc(resumeVersionScoreLabel(version))}</p>
    </div>`).join('')}</div>` : '<p class="text-sm text-slate-400">No generated versions yet.</p>'}`;
}

function renderSourceQualityCoach(sourceQuality) {
  const categories = Array.isArray(sourceQuality?.categories) ? sourceQuality.categories : [];
  const findings = sourceQuality?.findings || sourceQuality?.questions || [];
  if (categories.length) {
    return `<p class="text-label-caps font-label-caps text-slate-500 mb-3">SOURCE QUALITY COACH</p>
      <div class="space-y-2">
        ${categories.map(category => {
          const statusCls = category.status === 'strong'
            ? 'bg-emerald-50 text-emerald-700'
            : category.status === 'weak'
              ? 'bg-amber-50 text-amber-700'
              : 'bg-rose-50 text-rose-700';
          const prompts = Array.isArray(category.prompts) ? category.prompts : [];
          const signals = Array.isArray(category.signals) ? category.signals.slice(0, 4).join(', ') : '';
          return `<div class="border border-slate-100 rounded-lg p-2">
            <div class="flex items-center justify-between gap-2 mb-1">
              <p class="text-xs font-semibold text-slate-700">${esc(category.label || statusDisplayLabel(category.key || 'Evidence'))}</p>
              <span class="text-[10px] font-bold uppercase rounded px-1.5 py-0.5 ${statusCls}">${esc(category.status || 'review')}</span>
            </div>
            <p class="text-[11px] text-slate-500">${esc(category.count ?? 0)} signal${Number(category.count) === 1 ? '' : 's'}${signals ? ` · ${esc(signals)}` : ''}</p>
            ${prompts.length ? `<div class="mt-2 space-y-1">${prompts.slice(0, 2).map(prompt => `<p class="text-[11px] text-amber-700">${esc(prompt)}</p>`).join('')}</div>` : ''}
          </div>`;
        }).join('')}
      </div>`;
  }
  return `<p class="text-label-caps font-label-caps text-slate-500 mb-3">SOURCE QUALITY COACH</p>
    ${findings.length ? `<div class="space-y-2">${findings.slice(0, 8).map(item => {
      const text = typeof item === 'string' ? item : item.question || item.message || item.category || JSON.stringify(item);
      return `<div class="border border-slate-100 rounded-lg p-2 text-xs text-slate-600">${esc(text)}</div>`;
    }).join('')}</div>` : '<p class="text-sm text-slate-400">No source quality gaps detected.</p>'}`;
}

async function renderOutreachWorkspace() {
  const countEl = document.getElementById('outreach-count-label');
  if (!countEl) return;
  try {
    if (!outreachWorkspace) outreachWorkspace = await fetchOutreachWorkspace();
    const data = outreachWorkspace;
    countEl.textContent = `${data.dueFollowUps.length} due · ${data.drafts.length} draft${data.drafts.length === 1 ? '' : 's'} · ${data.replies.length} repl${data.replies.length === 1 ? 'y' : 'ies'}`;
    document.getElementById('outreach-summary-root').innerHTML = [
      workspaceMetricCard('Due', data.dueFollowUps.length, 'text-amber-700'),
      workspaceMetricCard('Drafts', data.drafts.length, 'text-blue-700'),
      workspaceMetricCard('Sent', data.sentOutreach.length, 'text-slate-800'),
      workspaceMetricCard('Replies', data.replies.length, 'text-emerald-700'),
    ].join('');
    document.getElementById('outreach-due-root').innerHTML = renderOutreachList('DUE FOLLOW-UPS', data.dueFollowUps, renderOutreachContactItem);
    document.getElementById('outreach-drafts-root').innerHTML = renderOutreachList('DRAFTS', data.drafts, renderDraftItem);
    document.getElementById('outreach-sent-root').innerHTML = renderOutreachList('SENT OUTREACH', data.sentOutreach, renderOutreachContactItem);
    document.getElementById('outreach-replies-root').innerHTML = renderOutreachList('REPLIES', data.replies, renderOutreachContactItem);
    bindOutreachWorkspaceActions(document.getElementById('view-outreach'));
  } catch (e) {
    countEl.textContent = 'Outreach unavailable';
  }
}

function renderOutreachList(title, items, renderer) {
  return `<p class="text-label-caps font-label-caps text-slate-500 mb-3">${title}</p>
    <div class="space-y-2">${items.length ? items.slice(0, 12).map(renderer).join('') : '<p class="text-sm text-slate-400">Nothing here.</p>'}</div>`;
}

function renderOutreachContactItem(item) {
  return `<div class="border border-slate-100 rounded-lg p-3">
    <div class="flex items-start justify-between gap-2">
      <div class="min-w-0">
        <p class="text-xs font-semibold text-slate-700">${esc(item.name || item.contactName || 'Contact')}</p>
        <p class="text-[11px] text-slate-400">${esc(item.company || item.jobCompany || '')} · ${esc(item.jobTitle || '')}</p>
        ${item.followUpDue ? `<p class="text-[11px] text-amber-700 mt-1">Due ${esc(item.followUpDue)}</p>` : ''}
        ${item.lastEmailSubject ? `<p class="text-[11px] text-slate-500 mt-1">${esc(item.lastEmailSubject)}</p>` : ''}
      </div>
      <button class="outreach-open-job text-[11px] font-semibold text-blue-600" data-id="${esc(item.jobId)}">Open</button>
    </div>
  </div>`;
}

function renderDraftItem(draft) {
  return `<div class="border border-slate-100 rounded-lg p-3">
    <div class="flex items-start justify-between gap-2 mb-2">
      <div class="min-w-0">
        <p class="text-xs font-semibold text-slate-700">${esc(draft.contactName || 'Contact')}</p>
        <p class="text-[11px] text-slate-400">${esc(statusDisplayLabel(draft.type))} · ${esc(draft.company)} · ${fmtDateTime(draft.generatedAt)}</p>
      </div>
      <div class="flex gap-2">
        <button class="draft-copy-btn text-[11px] font-semibold text-blue-600" data-text="${esc(draft.text)}">Copy</button>
        <button class="draft-regenerate-btn text-[11px] font-semibold text-slate-500" data-job-id="${esc(draft.jobId)}" data-contact-id="${esc(draft.contactId)}" data-type="${esc(draft.type)}">Regenerate</button>
        <button class="draft-mark-sent-btn text-[11px] font-semibold text-slate-500" data-job-id="${esc(draft.jobId)}" data-contact-id="${esc(draft.contactId)}">Mark sent</button>
      </div>
    </div>
    <textarea readonly rows="4" class="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-xs text-slate-600 resize-y">${esc(draft.text)}</textarea>
  </div>`;
}

function bindOutreachWorkspaceActions(root) {
  root.querySelectorAll('.outreach-open-job').forEach(btn => btn.addEventListener('click', () => showJobDetail(btn.dataset.id)));
  root.querySelectorAll('.draft-copy-btn').forEach(btn => btn.addEventListener('click', async () => {
    await navigator.clipboard?.writeText(btn.dataset.text || '');
    btn.textContent = 'Copied';
    setTimeout(() => { btn.textContent = 'Copy'; }, 1200);
  }));
  root.querySelectorAll('.draft-regenerate-btn').forEach(btn => btn.addEventListener('click', async () => {
    await generateContactOutreachDraft(btn.dataset.jobId, { contactId: btn.dataset.contactId, type: btn.dataset.type });
    invalidateWorkspaceCaches();
    await refreshDashboardState();
    renderOutreachWorkspace();
  }));
  root.querySelectorAll('.draft-mark-sent-btn').forEach(btn => btn.addEventListener('click', async () => {
    const job = allJobs.find(item => item.id === btn.dataset.jobId);
    const contact = (job?.contacts || []).find(item => item.id === btn.dataset.contactId);
    if (!contact) return;
    await upsertJobContact(btn.dataset.jobId, { contact: { ...contact, responseStatus: 'outreach_sent' }, markOutreachSent: true });
    invalidateWorkspaceCaches();
    await refreshDashboardState();
    renderOutreachWorkspace();
  }));
}

async function renderContactsWorkspace() {
  const root = document.getElementById('contacts-root');
  const countEl = document.getElementById('contacts-count-label');
  if (!root || !countEl) return;
  try {
    if (!contactsWorkspace) {
      contactsWorkspace = await fetchContactsWorkspace();
      populateWorkspaceSelect('contacts-relationship-filter', contactsWorkspace.filters.relationshipTypes, 'All relationships');
      populateWorkspaceSelect('contacts-response-filter', contactsWorkspace.filters.responseStatuses, 'All response states');
    }
    const q = (document.getElementById('contacts-search')?.value || '').toLowerCase();
    const relationship = document.getElementById('contacts-relationship-filter')?.value || '';
    const response = document.getElementById('contacts-response-filter')?.value || '';
    let contacts = contactsWorkspace.contacts || [];
    if (q) contacts = contacts.filter(contact => [contact.name, contact.company, contact.jobCompany, contact.jobTitle, contact.title].join(' ').toLowerCase().includes(q));
    if (relationship) contacts = contacts.filter(contact => contact.relationshipType === relationship);
    if (response) contacts = contacts.filter(contact => contact.responseStatus === response);
    countEl.textContent = `${contacts.length} of ${(contactsWorkspace.contacts || []).length} contact${(contactsWorkspace.contacts || []).length === 1 ? '' : 's'}`;
    root.innerHTML = renderContactsTable(contacts);
    bindContactsWorkspaceActions(root, contacts);
  } catch (e) {
    countEl.textContent = 'Contacts unavailable';
    root.innerHTML = `<div class="p-4 text-sm text-rose-600">${esc(e.message)}</div>`;
  }
}

function populateWorkspaceSelect(id, values, label) {
  const select = document.getElementById(id);
  if (!select || select.dataset.populated === '1') return;
  select.innerHTML = `<option value="">${esc(label)}</option>` + values.map(value => `<option value="${esc(value)}">${esc(statusDisplayLabel(value))}</option>`).join('');
  select.dataset.populated = '1';
}

function renderContactsTable(contacts) {
  if (!contacts.length) return '<div class="p-12 text-center text-slate-400">No contacts match these filters.</div>';
  return `<table class="dashboard-table w-full text-sm">
    <thead><tr class="border-b border-slate-200 bg-slate-50">
      <th class="text-left px-4 py-3 text-xs font-bold text-slate-500 uppercase tracking-wide">Contact</th>
      <th class="text-left px-4 py-3 text-xs font-bold text-slate-500 uppercase tracking-wide">Relationship</th>
      <th class="text-left px-4 py-3 text-xs font-bold text-slate-500 uppercase tracking-wide">Response</th>
      <th class="text-left px-4 py-3 text-xs font-bold text-slate-500 uppercase tracking-wide">Follow-up</th>
      <th class="text-left px-4 py-3 text-xs font-bold text-slate-500 uppercase tracking-wide">Action</th>
    </tr></thead>
    <tbody>${contacts.map(contact => `<tr class="border-b border-slate-100 hover:bg-slate-50">
      <td class="px-4 py-3"><p class="font-semibold text-slate-800">${esc(contact.name)}</p><p class="text-xs text-slate-500">${esc(contact.title || '')} · ${esc(contact.jobCompany)} · ${esc(contact.jobTitle)}</p></td>
      <td class="px-4 py-3 text-xs text-slate-600">${esc(statusDisplayLabel(contact.relationshipType))}</td>
      <td class="px-4 py-3 text-xs text-slate-600">${esc(statusDisplayLabel(contact.responseStatus))}</td>
      <td class="px-4 py-3 text-xs ${contact.followUpDueInDays != null && contact.followUpDueInDays <= 0 ? 'text-amber-700 font-semibold' : 'text-slate-500'}">${esc(contact.followUpDue || '—')}</td>
      <td class="px-4 py-3"><div class="flex gap-2">
        <button class="contact-open-job text-xs font-semibold text-blue-600 border border-blue-100 rounded-lg px-3 py-1.5 hover:bg-blue-50" data-id="${esc(contact.jobId)}">Open</button>
        <button class="contact-edit-workspace text-xs font-semibold text-slate-600 border border-slate-200 rounded-lg px-3 py-1.5 hover:bg-slate-50" data-job-id="${esc(contact.jobId)}" data-contact-id="${esc(contact.id)}">Edit</button>
      </div></td>
    </tr>`).join('')}</tbody>
  </table>`;
}

function bindContactsWorkspaceActions(root, contacts) {
  root.querySelectorAll('.contact-open-job').forEach(btn => btn.addEventListener('click', () => showJobDetail(btn.dataset.id)));
  root.querySelectorAll('.contact-edit-workspace').forEach(btn => btn.addEventListener('click', async () => {
    const contact = contacts.find(item => item.id === btn.dataset.contactId && item.jobId === btn.dataset.jobId);
    if (!contact) return;
    const followUpDue = window.prompt('Follow-up due date (YYYY-MM-DD)', contact.followUpDue || '');
    if (followUpDue == null) return;
    await upsertJobContact(contact.jobId, { contact: { ...contact, followUpDue } });
    invalidateWorkspaceCaches();
    await refreshDashboardState();
    renderContactsWorkspace();
  }));
}

async function renderAnalyticsWorkspace() {
  const countEl = document.getElementById('analytics-count-label');
  if (!countEl) return;
  try {
    if (!analyticsSummary) analyticsSummary = await fetchAnalyticsSummary();
    const data = analyticsSummary;
    countEl.textContent = `${data.activeOpportunities} active opportunities · average ATS ${data.averageActiveAtsScore ?? '—'}%`;
    document.getElementById('analytics-summary-root').innerHTML = [
      workspaceMetricCard('Active', data.activeOpportunities, 'text-slate-800'),
      workspaceMetricCard('Avg ATS', data.averageActiveAtsScore == null ? '—' : data.averageActiveAtsScore + '%', 'text-blue-700'),
      workspaceMetricCard('Follow-ups', data.followUpDebt.count, 'text-amber-700'),
      workspaceMetricCard('Stale', data.staleLeads.count, 'text-rose-700'),
    ].join('');
    document.getElementById('analytics-stage-root').innerHTML = renderKeyValuePanel('PIPELINE DISTRIBUTION', data.stageDistribution);
    document.getElementById('analytics-resume-root').innerHTML = renderKeyValuePanel('RESUME SCORE DISTRIBUTION', data.resumeScoreDistribution);
    document.getElementById('analytics-followup-root').innerHTML = renderOutreachList('FOLLOW-UP DEBT', data.followUpDebt.items || [], renderOutreachContactItem);
    document.getElementById('analytics-outreach-root').innerHTML = renderKeyValuePanel('OUTREACH RESPONSE STATUS', data.outreachResponseStatus);
  } catch (e) {
    countEl.textContent = 'Analytics unavailable';
  }
}

async function renderSettingsWorkspace() {
  const countEl = document.getElementById('settings-count-label');
  if (!countEl) return;
  try {
    if (!settingsHealth) settingsHealth = await fetchSettingsHealth();
    const data = settingsHealth;
    const failures = (data.checks || []).filter(check => check.status === 'FAIL').length;
    const warnings = (data.checks || []).filter(check => check.status === 'WARN').length;
    countEl.textContent = `${failures} failures · ${warnings} warnings · secrets hidden`;
    document.getElementById('settings-paths-root').innerHTML = `<p class="text-label-caps font-label-caps text-slate-500 mb-3">LOCAL PATHS</p>
      <div class="grid grid-cols-2 gap-2 text-xs">${Object.entries(data.paths || {}).map(([key, value]) => `<div class="border border-slate-100 rounded-lg p-2"><p class="font-semibold text-slate-500">${esc(statusDisplayLabel(key))}</p><p class="text-slate-700 break-all">${esc(value)}</p></div>`).join('')}</div>`;
    document.getElementById('settings-files-root').innerHTML = `<p class="text-label-caps font-label-caps text-slate-500 mb-3">CONFIG AND DATA FILES</p>
      <div class="divide-y divide-slate-100">${(data.files || []).map(file => `<div class="py-2 flex items-center justify-between gap-3">
        <div class="min-w-0"><p class="text-xs font-semibold text-slate-700">${esc(file.label)}</p><p class="text-[11px] text-slate-400 break-all">${esc(file.path)}</p></div>
        <span class="text-[10px] font-bold uppercase rounded px-2 py-0.5 ${file.present ? 'bg-emerald-50 text-emerald-700' : 'bg-rose-50 text-rose-700'}">${file.present ? 'Present' : 'Missing'}</span>
      </div>`).join('')}</div>`;
    document.getElementById('settings-health-root').innerHTML = `<p class="text-label-caps font-label-caps text-slate-500 mb-3">HEALTH CHECKS</p>
      <div class="divide-y divide-slate-100">${(data.checks || []).map(check => `<div class="py-2 flex items-start justify-between gap-3">
        <div><p class="text-xs font-semibold text-slate-700">${esc(check.name)}</p><p class="text-[11px] text-slate-500">${esc(check.message)}</p></div>
        <span class="text-[10px] font-bold uppercase rounded px-2 py-0.5 ${healthStatusClass(check.status)}">${esc(check.status)}</span>
      </div>`).join('')}</div>`;
  } catch (e) {
    countEl.textContent = 'Settings unavailable';
  }
}

function renderKeyValuePanel(title, values = {}) {
  return `<p class="text-label-caps font-label-caps text-slate-500 mb-3">${esc(title)}</p>
    <div class="divide-y divide-slate-100">${Object.entries(values).map(([key, value]) => `<div class="py-2 flex items-center justify-between gap-3">
      <span class="text-xs font-semibold text-slate-600">${esc(statusDisplayLabel(key))}</span>
      <span class="text-sm font-bold text-slate-800">${esc(value)}</span>
    </div>`).join('') || '<p class="text-sm text-slate-400">No data.</p>'}</div>`;
}

function workspaceMetricCard(label, value, color) {
  return `<div class="bg-white border border-slate-200 rounded-lg p-3 min-h-[72px]">
    <p class="text-[10px] font-bold uppercase tracking-wide text-slate-400">${esc(label)}</p>
    <p class="text-lg font-bold ${color}">${esc(value)}</p>
  </div>`;
}

function healthStatusClass(status) {
  if (status === 'PASS') return 'bg-emerald-50 text-emerald-700';
  if (status === 'WARN') return 'bg-amber-50 text-amber-700';
  return 'bg-rose-50 text-rose-700';
}

// ─── Rejected roles ──────────────────────────────────────────────────────────
function setupRejected() {
  document.getElementById('rej-search').addEventListener('input', renderRejected);
  document.getElementById('rej-sort').addEventListener('change', renderRejected);
  renderRejected();
}

function renderRejected() {
  const q = (document.getElementById('rej-search').value || '').toLowerCase();
  const sortVal = document.getElementById('rej-sort').value;

  let list = allJobs.filter(isRejectedJob);
  if (q) list = list.filter(j => ((j.company||'') + ' ' + (j.title||'')).toLowerCase().includes(q));

  list.sort((a, b) => {
    switch (sortVal) {
      case 'date_asc':     return (a.date_updated||'').localeCompare(b.date_updated||'');
      case 'company_asc':  return (a.company||'').toLowerCase().localeCompare((b.company||'').toLowerCase());
      case 'company_desc': return (b.company||'').toLowerCase().localeCompare((a.company||'').toLowerCase());
      case 'score_desc': {
        const as = atsPercent(a) ?? -1, bs = atsPercent(b) ?? -1;
        return bs - as;
      }
      default: return (b.date_updated||'').localeCompare(a.date_updated||'');
    }
  });

  const total = allJobs.filter(isRejectedJob).length;
  document.getElementById('rej-count-label').textContent =
    list.length === total
      ? `${total} rejected role${total !== 1 ? 's' : ''}`
      : `${list.length} of ${total} rejected roles`;
  document.getElementById('rej-empty').classList.toggle('hidden', list.length > 0);

  const tbody = document.getElementById('rej-tbody');
  tbody.innerHTML = '';

  list.forEach(job => {
    const atsColor = atsScoreColor(job);
    const atsStr   = atsScoreLabel(job);
    const nextStep = compactNextStep(job);
    const detailId = 'rej-detail-' + job.id;

    const tr = document.createElement('tr');
    tr.className = 'border-b border-slate-100 hover:bg-slate-50 transition-colors cursor-pointer';
    tr.dataset.detailId = detailId;
    tr.innerHTML = `
      <td class="px-4 py-3">
        <div class="flex items-center gap-3">
          <div class="w-8 h-8 rounded-lg bg-rose-50 flex items-center justify-center text-xs font-bold text-rose-700 shrink-0">
            ${esc((job.company||'?').slice(0,2).toUpperCase())}
          </div>
          <div class="min-w-0">
            <p class="font-semibold text-on-surface truncate max-w-xs">${esc(job.company)}</p>
            <p class="text-xs text-slate-500 truncate max-w-xs">${esc(job.title)}</p>
            ${nextStep ? `<p class="text-[11px] text-slate-400 truncate max-w-xs mt-0.5">Next: ${esc(nextStep)}</p>` : ''}
            ${job.last_email_subject ? `<p class="text-[11px] text-slate-400 truncate max-w-xs mt-0.5">${esc(job.last_email_subject)}</p>` : ''}
          </div>
        </div>
      </td>
      <td class="px-4 py-3">${statusBadge(job.status)}</td>
      <td class="px-4 py-3 hidden md:table-cell"><span class="font-bold ${atsColor}">${atsStr}</span></td>
      <td class="px-4 py-3 text-xs text-slate-500 hidden lg:table-cell">${esc(job.location||'—')}</td>
      <td class="px-4 py-3 text-xs text-slate-400 hidden md:table-cell">${fmtDate(job.date_updated)}</td>
      <td class="px-4 py-3">
        <div class="flex items-center gap-2">
          <button class="rej-gen-btn px-3 py-1.5 bg-primary text-white text-xs font-bold rounded-lg hover:opacity-90 transition-opacity"
            data-id="${esc(job.id)}">Generate</button>
          <button class="rej-edit-btn p-1.5 text-slate-400 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-colors"
            data-id="${esc(job.id)}" title="Edit job">
            <span class="material-symbols-outlined text-base leading-none">edit</span>
          </button>
          <button class="rej-del-btn p-1.5 text-slate-400 hover:text-rose-500 hover:bg-rose-50 rounded-lg transition-colors"
            data-id="${esc(job.id)}" title="Remove job">
            <span class="material-symbols-outlined text-base leading-none">delete</span>
          </button>
        </div>
      </td>`;

    const dRow = document.createElement('tr');
    dRow.id = detailId;
    dRow.className = 'hidden bg-slate-50/60';
    dRow.innerHTML = `<td colspan="6" class="px-6 py-5 border-b border-slate-100">${buildIntDetailPanel(job)}</td>`;

    const pRow = document.createElement('tr');
    pRow.id = 'rej-prog-' + job.id;
    pRow.className = 'hidden';
    pRow.innerHTML = `<td colspan="6" class="px-6 pb-4 bg-slate-50/50">
      <div class="stage-log text-xs space-y-0.5 font-mono mt-1"></div>
      <div class="downloads mt-2 flex gap-4 text-xs"></div>
    </td>`;

    tbody.appendChild(tr);
    tbody.appendChild(dRow);
    tbody.appendChild(pRow);
  });

  tbody.querySelectorAll('tr[data-detail-id]').forEach(tr => {
    tr.addEventListener('click', e => {
      if (e.target.closest('.rej-gen-btn') || e.target.closest('.rej-edit-btn') || e.target.closest('.rej-del-btn')) return;
      document.getElementById(tr.dataset.detailId)?.classList.toggle('hidden');
    });
  });

  tbody.querySelectorAll('.rej-gen-btn').forEach(btn => {
    btn.addEventListener('click', () => triggerGenerate(btn.dataset.id, btn));
  });

  tbody.querySelectorAll('.rej-edit-btn').forEach(btn => {
    btn.addEventListener('click', () => openEditModal(btn.dataset.id));
  });

  tbody.querySelectorAll('.rej-del-btn').forEach(btn => {
    btn.addEventListener('click', () => deleteJob(btn.dataset.id));
  });

  bindWorkflowActions(tbody);
  bindContactWorkspace(tbody);
}

function latestNoteText(notesStr) {
  if (!notesStr || !notesStr.trim()) return '';
  const lines = notesStr.split('\n');
  const startIdx = lines.findIndex(l => l.trim());
  if (startIdx === -1) return '';
  const first = lines[startIdx].trim();
  const dated = first.match(/^(\d{4}-\d{2}-\d{2}):\s*(.*)/);
  if (!dated) return first;

  const noteLines = [dated[2]];
  for (let i = startIdx + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^\s*\d{4}-\d{2}-\d{2}:\s*/.test(line)) break;
    noteLines.push(line);
  }
  return noteLines.join('\n').trim();
}

function renderNotesLog(notesStr) {
  if (!notesStr || !notesStr.trim()) return '';
  return notesStr.split('\n').filter(l => l.trim()).map(line => {
    const m = line.match(/^(\d{4}-\d{2}-\d{2}):\s*(.*)/);
    if (m) return `<div class="py-1 text-xs text-slate-600"><span class="text-blue-500 font-semibold mr-1">${esc(m[1])}</span>${esc(m[2])}</div>`;
    return `<div class="py-1 text-xs text-slate-600">${esc(line)}</div>`;
  }).join('');
}

function openInterviewNote(jobId) {
  const detailRow = document.getElementById('int-detail-' + jobId);
  if (!detailRow) return;
  detailRow.classList.remove('hidden');
  const noteInput = detailRow.querySelector(`.int-note-input[data-id="${CSS.escape(jobId)}"]`);
  noteInput?.focus();
}

// ─── Job deletion ────────────────────────────────────────────────────────────
async function toggleJobFlag(jobId, btn) {
  const job = allJobs.find(j => j.id === jobId);
  if (!job) return;
  const nowFlagged = !job.flagged;
  job.flagged = nowFlagged;
  // Optimistically update the button
  const icon = btn.querySelector('.material-symbols-outlined');
  btn.className = btn.className.replace(/text-(?:amber-4|amber-5|slate-2)\d+/g, '').trim();
  btn.classList.add(nowFlagged ? 'text-amber-400' : 'text-slate-200', nowFlagged ? 'hover:text-amber-500' : 'hover:text-amber-300');
  btn.title = nowFlagged ? 'Unflag job' : 'Flag job';
  if (icon) icon.style.fontVariationSettings = nowFlagged ? "'FILL' 1" : '';
  try {
    await fetch(`/api/jobs/${encodeURIComponent(jobId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ flagged: nowFlagged }),
    });
  } catch {
    job.flagged = !nowFlagged; // revert on failure
    applyOppFilters();
  }
}

async function deleteJob(jobId) {
  if (!confirm('Remove this job from the tracker?')) return;
  try {
    await deleteJobRequest(jobId);
    allJobs = allJobs.filter(j => j.id !== jobId);
    invalidateWorkspaceCaches();
    // Remove associated rows immediately before re-render
    ['detail-', 'opp-prog-'].forEach(prefix => {
      document.getElementById(prefix + jobId)?.remove();
    });
    applyOppFilters();
    renderInterviews();
    renderRejected();
    renderDashboard();
  } catch (e) {
    alert((e.response ? 'Could not remove: ' : 'Network error: ') + e.message);
  }
}

// ─── Resume generation ────────────────────────────────────────────────────────
function bulkGenerateCandidates() {
  return currentVisibleOpportunityJobs
    .filter(job => jobNeedsResume(job))
    .filter(job => !activeResumeJobs.has(job.id));
}

function updateBulkGenerateButton() {
  const btn = document.getElementById('bulk-generate-visible-btn');
  const label = document.getElementById('bulk-generate-visible-label');
  if (!btn || !label) return;
  const candidates = bulkGenerateCandidates();
  btn.classList.toggle('hidden', candidates.length === 0 && !bulkResumeRunning);
  btn.disabled = bulkResumeRunning || candidates.length === 0;
  label.textContent = bulkResumeRunning
    ? 'Starting resumes...'
    : `Generate visible (${candidates.length})`;
}

async function triggerBulkGenerateVisible() {
  const jobs = bulkGenerateCandidates();
  if (!jobs.length || bulkResumeRunning) return;

  bulkResumeRunning = true;
  updateBulkGenerateButton();
  let index = 0;

  async function worker() {
    while (index < jobs.length) {
      const job = jobs[index++];
      await triggerGenerate(job.id);
    }
  }

  await Promise.all(Array.from(
    { length: Math.min(BULK_RESUME_CONCURRENCY, jobs.length) },
    () => worker()
  ));
  bulkResumeRunning = false;
  updateBulkGenerateButton();
}

async function triggerGenerate(jobId, btn) {
  setGeneratingState(jobId, 'Generating…');
  showAllProgSections(jobId);
  activeResumeJobs.add(jobId);
  updateBulkGenerateButton();

  try {
    const preflight = await createDocs(jobId);
    const questions = preflight.needsGapReview ? (preflight.questions || []) : [];
    if (questions.length) {
      appendLog(jobId, 'ok', `Evidence check: ${questions.length} gap question${questions.length === 1 ? '' : 's'} before drafting.`);
      const answers = [];
      for (const item of questions) {
        const answer = window.prompt(`${item.question}\n\nLeave blank or type "no" if not applicable.`);
        if (answer == null) {
          appendLog(jobId, 'error', 'Resume generation cancelled during evidence check.');
          activeResumeJobs.delete(jobId);
          resetBtn(jobId);
          updateBulkGenerateButton();
          return;
        }
        answers.push({ gap: item.gap, answer });
      }
      const update = await submitResumeGapAnswers(jobId, answers);
      if (update.updated) appendLog(jobId, 'ok', `Brag document updated with ${update.additions.length} confirmed evidence item${update.additions.length === 1 ? '' : 's'}.`);
    }
    const result = preflight.started
      ? preflight
      : await createDocs(jobId, { gapReviewComplete: true });
    if (result.alreadyRunning) appendLog(jobId, 'ok', 'Resume generation already running on server.');
  } catch (e) {
    appendLog(jobId, 'error', (e.response ? 'Server error: ' : 'Network error: ') + e.message);
    activeResumeJobs.delete(jobId);
    resetBtn(jobId);
    updateBulkGenerateButton();
  }
}

function showAllProgSections(jobId, { clear = true } = {}) {
  ['opp-prog-', 'int-prog-', 'rej-prog-'].forEach(prefix => showProgSection(prefix + jobId, { clear }));
}

function showProgSection(id, { clear = true } = {}) {
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.remove('hidden');
  const log = el.querySelector('.stage-log');
  const dl  = el.querySelector('.downloads');
  if (clear && log) log.innerHTML = '';
  if (clear && dl)  dl.innerHTML  = '';
}

function genBtns(jobId) {
  return document.querySelectorAll(`.gen-btn[data-id="${jobId}"], .rej-gen-btn[data-id="${jobId}"]`);
}

function setGeneratingState(jobId, label = 'Generating…') {
  genBtns(jobId).forEach(btn => {
    btn.disabled = true;
    btn.textContent = label;
  });
}

function updateBtnProgress(jobId, pct, label) {
  genBtns(jobId).forEach(btn => {
    btn.style.backgroundColor = progressColor(pct);
    btn.style.removeProperty('opacity');
    btn.textContent = `${label}… ${pct}%`;
  });
}

function processResumeProgress({ jobId, stage, status, message }) {
  if (!jobId || !stage) return;
  showAllProgSections(jobId, { clear: false });
  activeResumeJobs.add(jobId);
  const baseStage = stage.split(':')[0];
  const label = STAGE_LABELS[baseStage] ?? humanizeStage(baseStage);
  const text  = message ? `${label}: ${message}` : `${label}: ${status}`;
  const kind  = (status === 'failed' || baseStage === 'error') ? 'error'
              : baseStage === 'warning' ? 'warning' : 'ok';
  appendLog(jobId, kind, text);

  const prog = STAGE_PROGRESS[baseStage];
  if (prog) updateBtnProgress(jobId, status === 'started' ? prog.started : prog.done, label);

  if (kind === 'error') {
    activeResumeJobs.delete(jobId);
    resetBtn(jobId);
    updateBulkGenerateButton();
  }
}

socket.on('progress', processResumeProgress);

function processResumeComplete({ jobId, docxUrl, pdfUrl }) {
  if (!jobId || !docxUrl) return;
  showAllProgSections(jobId, { clear: false });
  activeResumeJobs.delete(jobId);
  const job = allJobs.find(item => item.id === jobId);
  if (job) {
    job.generatedDocs = {
      ...(job.generatedDocs || {}),
      default: {
        ...(job.generatedDocs?.default || {}),
        docxUrl,
        pdfUrl: pdfUrl || null,
        generatedAt: new Date().toISOString(),
      },
    };
  }
  invalidateWorkspaceCaches();
  genBtns(jobId).forEach(btn => {
    btn.style.backgroundColor = '#059669';
    btn.textContent = '✓ Complete';
  });
  const pdfLink = pdfUrl
    ? ` <a href="${esc(pdfUrl)}" download class="text-blue-600 font-semibold hover:underline">Download .pdf</a>`
    : '';
  const links = `<a href="${esc(docxUrl)}" download class="text-blue-600 font-semibold hover:underline">Download .docx</a>${pdfLink}`;
  ['opp-prog-', 'int-prog-', 'rej-prog-'].forEach(prefix => {
    const dl = document.querySelector('#' + prefix + jobId + ' .downloads');
    if (dl) dl.innerHTML = links;
  });
  setTimeout(() => resetBtn(jobId, 'Regenerate'), 1500);
  updateBulkGenerateButton();
}

socket.on('complete', processResumeComplete);
socket.on('connect', () => reconcileResumeRuns({ resetMissingActive: true }));

async function restoreResumeRuns() {
  await reconcileResumeRuns({ resetMissingActive: false });
}

async function reconcileResumeRuns({ resetMissingActive = false } = {}) {
  try {
    const runs = await fetchResumeRuns();
    const serverActive = new Set(runs.filter(run => run.status === 'running').map(run => run.jobId));
    for (const run of runs) restoreResumeRun(run);
    if (resetMissingActive) {
      for (const jobId of [...activeResumeJobs]) {
        if (!serverActive.has(jobId)) markResumeRunStopped(jobId);
      }
    }
  } catch {
    // Non-blocking: generation still runs; this only restores visible progress after refresh.
  }
}

function restoreResumeRun(run) {
  if (!run?.jobId || !Array.isArray(run.events) || !run.events.length) return;
  showAllProgSections(run.jobId);
  if (run.status === 'running') {
    activeResumeJobs.add(run.jobId);
    setGeneratingState(run.jobId, 'Generating…');
  }
  for (const event of run.events) {
    if (event.event === 'progress') processResumeProgress(event);
    if (event.event === 'complete') processResumeComplete(event);
  }
  if (run.status === 'running') {
    const last = run.events.at(-1);
    const baseStage = String(last?.stage || '').split(':')[0];
    const label = STAGE_LABELS[baseStage] ?? 'Generating';
    const prog = STAGE_PROGRESS[baseStage];
    if (prog) updateBtnProgress(run.jobId, prog.started, label);
  } else {
    activeResumeJobs.delete(run.jobId);
    updateBulkGenerateButton();
  }
}

function markResumeRunStopped(jobId) {
  activeResumeJobs.delete(jobId);
  appendLog(jobId, 'error', 'Resume generation stopped before completion. Retry to start a new run.');
  resetBtn(jobId);
  updateBulkGenerateButton();
}

function appendLog(jobId, kind, text) {
  const color = kind === 'error' ? 'text-rose-600' : kind === 'warning' ? 'text-amber-600' : 'text-emerald-700';
  ['opp-prog-', 'int-prog-', 'rej-prog-'].forEach(prefix => {
    const log = document.querySelector('#' + prefix + jobId + ' .stage-log');
    if (!log) return;
    const d = document.createElement('div');
    d.className = color;
    d.textContent = text;
    log.appendChild(d);
  });
}

function resetBtn(jobId, label = 'Retry') {
  genBtns(jobId).forEach(btn => {
    btn.disabled = false;
    btn.textContent = label;
    btn.style.removeProperty('background-color');
  });
}

// ─── Edit Modal ───────────────────────────────────────────────────────────────
const EDIT_FIELDS = ['company','title','status','score','location','compensation',
                     'employment_type','seniority','source','url','next_steps','notes'];

function openEditModal(jobId) {
  const job = allJobs.find(j => j.id === jobId);
  if (!job) return;

  document.getElementById('edit-job-id').value = jobId;
  EDIT_FIELDS.forEach(f => {
    const el = document.getElementById('ef-' + f);
    if (el) el.value = job[f] ?? '';
  });

  // Ensure the current status appears in the select (may be a custom value)
  const statusSel = document.getElementById('ef-status');
  if (job.status && ![...statusSel.options].some(o => o.value === job.status)) {
    const opt = document.createElement('option');
    opt.value = opt.textContent = job.status;
    statusSel.appendChild(opt);
  }
  statusSel.value = job.status || '';

  document.getElementById('edit-error').classList.add('hidden');
  document.getElementById('edit-modal').classList.remove('hidden');
  document.getElementById('ef-company').focus();
}

function closeEditModal() {
  document.getElementById('edit-modal').classList.add('hidden');
}

async function saveEditModal() {
  const jobId = document.getElementById('edit-job-id').value;
  const body  = {};
  EDIT_FIELDS.forEach(f => {
    const el = document.getElementById('ef-' + f);
    if (!el) return;
    const val = el.value.trim();
    body[f] = f === 'score' ? (val === '' ? null : parseFloat(val)) : val;
  });

  const saveBtn = document.getElementById('edit-save');
  saveBtn.disabled = true;
  saveBtn.textContent = 'Saving…';
  document.getElementById('edit-error').classList.add('hidden');

  try {
    await patchJob(jobId, body);

    // Update in-memory job list and re-render
    const idx = allJobs.findIndex(j => j.id === jobId);
    if (idx !== -1) allJobs[idx] = { ...allJobs[idx], ...body };
    closeEditModal();
    renderAllViews();
  } catch (e) {
    const errEl = document.getElementById('edit-error');
    errEl.textContent = 'Save failed: ' + e.message;
    errEl.classList.remove('hidden');
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = 'Save Changes';
  }
}

document.getElementById('edit-close').addEventListener('click', closeEditModal);
document.getElementById('edit-cancel').addEventListener('click', closeEditModal);
document.getElementById('edit-backdrop').addEventListener('click', closeEditModal);
document.getElementById('edit-save').addEventListener('click', saveEditModal);
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeEditModal();
});

// ─── Utilities ────────────────────────────────────────────────────────────────
function statusStyle(status) {
  const s = (status || '').toLowerCase();
  if (/offer/.test(s))              return { icon:'star',         iconBg:'bg-emerald-50', iconColor:'text-emerald-600', barColor:'bg-emerald-500' };
  if (INTERVIEW_STATUSES.has(s))    return { icon:'forum',        iconBg:'bg-amber-50',   iconColor:'text-amber-600',  barColor:'bg-amber-500'   };
  if (/applied/.test(s))            return { icon:'send',         iconBg:'bg-purple-50',  iconColor:'text-purple-600', barColor:'bg-purple-500'  };
  if (/reject|closed|pass/.test(s)) return { icon:'cancel',       iconBg:'bg-slate-100',  iconColor:'text-slate-400',  barColor:'bg-slate-300'   };
  return                                    { icon:'rocket_launch',iconBg:'bg-blue-50',    iconColor:'text-blue-600',   barColor:'bg-blue-500'    };
}

function statusDisplayLabel(status) {
  return String(status || 'Unknown')
    .split('_')
    .map(word => word ? word[0].toUpperCase() + word.slice(1) : word)
    .join(' ');
}

function statusBadge(status) {
  const s  = (status || 'Unknown').trim();
  const sl = s.toLowerCase();
  const cls = /offer/.test(sl)              ? 'bg-emerald-100 text-emerald-700'
            : INTERVIEW_STATUSES.has(sl)    ? 'bg-amber-100 text-amber-700'
            : /applied/.test(sl)            ? 'bg-blue-100 text-blue-700'
            : /reject|closed|pass/.test(sl) ? 'bg-rose-100 text-rose-700'
            : 'bg-slate-100 text-slate-600';
  return `<span class="inline-block px-2 py-0.5 rounded text-xs font-bold ${cls}">${esc(statusDisplayLabel(s))}</span>`;
}

function fmtDate(d) {
  if (!d) return '—';
  const dt = new Date(d);
  return isNaN(dt) ? d.slice(0,10) : dt.toLocaleDateString('en-US', { month:'short', day:'numeric' });
}

function fmtDateTime(d) {
  if (!d) return '—';
  const dt = new Date(d);
  return isNaN(dt) ? d : dt.toLocaleString('en-US', { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' });
}

function decodeEntities(str) {
  return String(str ?? '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n))
    .replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'");
}

function set(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}

function esc(str) {
  return String(str ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ─── Start ────────────────────────────────────────────────────────────────────
showView(viewFromPath(), { push: false });
init();
