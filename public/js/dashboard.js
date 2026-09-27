import {
  addEvidenceFact,
  answerCandidateQuestion,
  attachGmailAmbiguity,
  createDocs,
  createInterviewRound,
  deleteJobRequest,
  dismissGmailAmbiguity,
  fetchAnalyticsSummary,
  fetchAmbiguousGmailJobs,
  fetchContactsWorkspace,
  fetchDashboard,
  fetchEvidenceVault,
  fetchHome,
  fetchOpportunityWorkspace,
  fetchOutcomeIntelligence,
  fetchOutreachWorkspace,
  fetchResumeRuns,
  fetchResumeWorkspace,
  fetchSettingsHealth,
  generateContactOutreachDraft,
  patchJob,
  patchOpportunity,
  postActionDecision,
  postOpportunityStage,
  postQuickDecision,
  postWorkflowEvent,
  promoteQuestionToEvidence,
  submitResumeGapAnswers,
  updateEvidenceFact,
  updateInterviewRound,
  upsertJobContact,
} from './api.js';
import { sortJobsBy } from './jobs-table.js';
import { STAGE_LABELS, STAGE_PROGRESS, humanizeStage, progressColor } from './progress.js';
import { INTERVIEW_STATUSES, STATUS_ORDER, createDashboardMeta } from './state.js';
import { normalizeSource, sourceBadgeCls, sourceDisplayLabel } from './source-badges.js';
import {
  INTERVIEW_ROUND_FORMAT_OPTIONS,
  INTERVIEW_ROUND_STATUS_OPTIONS,
  INTERVIEW_ROUND_TYPE_OPTIONS,
  buildRoundPayload,
  fromDatetimeLocalValue,
  interviewRoundTypeLabel,
  nextScheduledRound,
  toDatetimeLocalValue,
} from './interview-ui.js';

// ─── State ────────────────────────────────────────────────────────────────────
let allJobs    = [];
let userProfile = {};
let dashboardMeta = { builtAt: null, lastScanAt: null };
let ambiguousGmailJobs = [];
let workflowSummary = { urgentFollowUps: 0, staleJobs: 0, upcomingInterviews: 0 };
const socket   = io();

// Phase 3: Daily Command Center state
let homeData = null;
let startDayQueue = [];
let startDayIndex = 0;

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
let analyticsOutcomes = null;
let settingsHealth = null;
// Phase 5: Career Evidence Vault state
let vaultData = null;
let currentVaultTab = 'experience';
let currentJobDetailId = '';
// Phase 4: Opportunity Workspace state
let currentJobDetailTab = 'overview';
let currentJobDetailData = null;
let jobDetailReturnView = 'jobs';
let contactsSort = { col: 'experienceMatchPct', dir: 'desc' };
let delegatedWorkspaceActionsReady = false;
const compactSidebarQuery = window.matchMedia('(max-width: 1179px)');

const INACTIVE_DASHBOARD_STATUS_RE = /\b(rejected?|declined|pass(?:ed)?|closed|archived|withdrawn)\b/i;

function debounce(fn, delay = 150) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

function delegate(root, eventName, selector, handler) {
  root?.addEventListener(eventName, event => {
    const target = event.target.closest(selector);
    if (!target || !root.contains(target)) return;
    handler(event, target);
  });
}

function jobById(jobId) {
  return allJobs.find(job => job.id === jobId);
}

function replaceJobInState(job) {
  if (!job?.id) return;
  const idx = allJobs.findIndex(item => item.id === job.id);
  // Merge rather than overwrite: a partial read model (e.g. from a
  // workflow-event/contact mutation) omits Opportunity-only fields
  // (stage/priority/overallFit/...) that a fuller fetch may have set.
  if (idx === -1) allJobs.unshift(job);
  else allJobs[idx] = { ...allJobs[idx], ...job };
  invalidateWorkspaceCaches();
}

function applyJobMutation(job) {
  replaceJobInState(job);
  renderAllViews();
}

function ensureDetailRow(detailRow, job, htmlBuilder) {
  const cell = detailRow?.querySelector('td');
  if (!cell || cell.dataset.lazyBuilt === '1') return;
  cell.innerHTML = htmlBuilder(job);
  cell.dataset.lazyBuilt = '1';
  bindWorkflowActions(cell);
  bindContactWorkspace(cell);
  bindInterviewNoteActions(cell);
}

function isRejectedJob(job) {
  return /\b(rejected?|declined|pass(?:ed)?)\b/i.test(String(job?.status || '').toLowerCase());
}

function isInactiveDashboardJob(job) {
  return INACTIVE_DASHBOARD_STATUS_RE.test(String(job?.status || '').toLowerCase());
}

function visibleDashboardJobs(jobs) {
  return jobs.filter(job => !isInactiveDashboardJob(job));
}

function setupSidebarControls() {
  if (sidebarControlsReady) return;
  sidebarControlsReady = true;
  const root = document.documentElement;
  const toggle = document.getElementById('sidebar-toggle');
  const handle = document.getElementById('sidebar-resize-handle');
  const backdrop = document.getElementById('sidebar-backdrop');
  const storedWidthValue = localStorage.getItem('careerOpsSidebarWidth');
  const storedWidth = storedWidthValue == null ? null : Number(storedWidthValue);
  const storedCollapsed = localStorage.getItem('careerOpsSidebarCollapsed') === '1';
  const isCompact = () => compactSidebarQuery.matches;
  const clamp = value => Math.min(384, Math.max(192, value));
  const applyMobileOpen = open => {
    document.body.classList.toggle('sidebar-mobile-open', open);
    if (toggle) {
      const icon = toggle.querySelector('.material-symbols-outlined');
      toggle.setAttribute('aria-expanded', String(open));
      toggle.setAttribute('aria-label', open ? 'Close navigation' : 'Open navigation');
      toggle.title = open ? 'Close navigation' : 'Open navigation';
      if (icon) icon.textContent = open ? 'left_panel_close' : 'menu';
      toggle.style.left = '12px';
    }
  };
  const applyWidth = value => {
    const width = clamp(value);
    root.style.setProperty('--sidebar-width', `${width}px`);
    if (toggle && !document.body.classList.contains('sidebar-collapsed')) {
      toggle.style.left = `${width - 18}px`;
    }
    localStorage.setItem('careerOpsSidebarWidth', String(width));
  };
  const applyCollapsed = collapsed => {
    if (isCompact()) {
      applyMobileOpen(!collapsed);
      return;
    }
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
  if (isCompact()) applyMobileOpen(false);
  else applyCollapsed(storedCollapsed);

  toggle?.addEventListener('click', () => {
    if (isCompact()) {
      applyMobileOpen(!document.body.classList.contains('sidebar-mobile-open'));
      return;
    }
    applyCollapsed(!document.body.classList.contains('sidebar-collapsed'));
  });

  backdrop?.addEventListener('click', () => applyMobileOpen(false));

  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (isCompact()) applyMobileOpen(false);
    });
  });

  compactSidebarQuery.addEventListener('change', () => {
    applyMobileOpen(false);
    if (!isCompact()) applyCollapsed(localStorage.getItem('careerOpsSidebarCollapsed') === '1');
  });

  handle?.addEventListener('pointerdown', event => {
    if (isCompact()) return;
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
    setupHome();
    setupVault();
    renderWorkspaceView(viewFromPath());
    restoreResumeRuns();
    loadHome();
  } catch (e) {
    document.getElementById('dash-subtitle').textContent = 'Failed to load: ' + e.message;
  }
}

// ─── Navigation ───────────────────────────────────────────────────────────────
const VIEWS = ['home', 'dashboard', 'jobs', 'resume', 'outreach', 'contacts', 'vault', 'gmail-review', 'interviews', 'rejected', 'analytics', 'settings'];
const VIEW_PATHS = {
  home: '/',
  dashboard: '/dashboard',
  jobs: '/jobs',
  resume: '/resume',
  outreach: '/outreach',
  contacts: '/contacts',
  vault: '/career-profile',
  'gmail-review': '/gmail-review',
  interviews: '/interviews',
  rejected: '/rejected',
  analytics: '/analytics',
  settings: '/settings',
};
const PATH_VIEWS = {
  '/': 'home',
  '/home': 'home',
  '/dashboard': 'dashboard',
  '/jobs': 'jobs',
  '/resume': 'resume',
  '/outreach': 'outreach',
  '/contacts': 'contacts',
  '/career-profile': 'vault',
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
  return PATH_VIEWS[pathname] || 'home';
}

function showView(name, { push = true } = {}) {
  const viewName = VIEWS.includes(name) ? name : 'home';
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

document.getElementById('global-search').addEventListener('input', debounce(applyOppFilters));

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
    (job.status || '') === 'lead' && !hasGeneratedResume(job)
  );
}

function hasGeneratedResume(job) {
  const docs = job?.generatedDocs;
  if (!docs || typeof docs !== 'object' || Array.isArray(docs)) return false;
  return Object.values(docs).some(entry => {
    if (!entry || typeof entry !== 'object') return false;
    if (entry.docxUrl) return true;
    return Array.isArray(entry.history) && entry.history.some(item => item?.docxUrl);
  });
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
        ${item.needsReview ? `<p class="text-[11px] text-amber-700 mt-1">Needs review: ${esc((item.reviewReasons || []).join('; '))}</p>` : ''}
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

  applyOppFilters();
}

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
        ${renderScoreDetails('ATS score', atsStr, job._scoreExplanations?.ats || fallbackScoreExplanation(job, 'ats'), 'inline', atsColor)}
        ${renderScoreDetails('Priority', job._search?.score == null ? '—' : `${job._search.score}%`, job._scoreExplanations?.search || job._search || fallbackScoreExplanation(job, 'search'), 'inline', 'text-slate-700')}
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
    dRow.dataset.jobId = job.id;
    dRow.innerHTML = `<td colspan="7" class="px-6 py-4 border-b border-slate-100"></td>`;

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
      const job = jobById(dRow?.dataset.jobId);
      if (dRow && job) {
        ensureDetailRow(dRow, job, buildDetailPanel);
        dRow.classList.toggle('hidden');
      }
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

  parts.push(renderScoreExplanationPanel(job));
  parts.push(renderWhyThisRoleBrief(job));
  parts.push(renderCompanyResearchPanel(job));

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
        <option value="interviewer">Interviewer</option>
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
    interview_completed: 'Interview completed',
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

function scoreExplanationLines(model = {}) {
  const explanation = Array.isArray(model.explanation)
    ? model.explanation
    : Array.isArray(model.reasons)
      ? model.reasons
      : [];
  const missing = Array.isArray(model.missingSignals) ? model.missingSignals : [];
  const action = model.action || model.confidenceAction || '';
  return [
    ...explanation,
    ...missing.map(signal => `Missing: ${signal}`),
    action ? `Action: ${action}` : '',
  ].filter(Boolean);
}

function renderScoreDetails(label, value, model = {}, mode = 'block', color = 'text-slate-800') {
  const lines = scoreExplanationLines(model);
  const inline = mode === 'inline';
  if (!lines.length) return `<span class="font-bold ${color}">${esc(value)}</span>`;
  return `<details class="score-explanation ${inline ? 'mt-1' : 'border border-slate-100 rounded-lg px-3 py-2'}">
    <summary class="${inline ? 'inline-flex' : 'flex'} cursor-pointer items-center gap-1 text-xs font-semibold ${color}">
      <span>${esc(label)}: ${esc(value)}</span>
      <span class="material-symbols-outlined text-sm">expand_more</span>
    </summary>
    <ul class="mt-2 space-y-1 text-[11px] text-slate-500 leading-relaxed">
      ${lines.slice(0, 6).map(line => `<li>${esc(line)}</li>`).join('')}
    </ul>
  </details>`;
}

function fallbackScoreExplanation(job, kind) {
  if (kind === 'ats') {
    const score = atsPercent(job);
    return {
      explanation: [
        score == null ? 'No ATS score is available yet.' : `ATS score is ${Math.round(score)}%.`,
        hasGeneratedResume(job) ? 'A generated resume exists for this role.' : 'No generated resume is saved yet.',
      ],
      missingSignals: score == null ? ['evaluated resume score'] : hasGeneratedResume(job) ? [] : ['role-specific resume version'],
      action: score == null || score < 75 ? 'Generate or revise the resume before applying.' : 'Use this role as an application priority.',
    };
  }
  if (kind === 'oi') {
    const oi = job._oi || {};
    return {
      explanation: oi.reasons || [`Opportunity intelligence score is ${oi.score ?? 'unknown'}.`],
      missingSignals: oi.missingSignals || ['company research enrichment'],
      action: 'Enrich company signals to improve confidence.',
    };
  }
  return {
    explanation: [
      `Next action is ${nextActionLabel(job._workflow?.nextBestAction || 'review')}.`,
      hasGeneratedResume(job) ? 'Resume readiness signal is present.' : 'Resume readiness signal is missing.',
    ],
    missingSignals: [job._search ? '' : 'combined search priority score'].filter(Boolean),
    action: compactNextStep(job) || 'Review this role against current priorities.',
  };
}

function renderScoreExplanationPanel(job) {
  const explanations = job._scoreExplanations || {};
  const items = [
    ['ATS', atsScoreLabel(job), explanations.ats || fallbackScoreExplanation(job, 'ats'), atsScoreColor(job)],
    ['OI', job._oi?.score == null ? '—' : `${job._oi.score}%`, explanations.oi || job._oi || fallbackScoreExplanation(job, 'oi'), 'text-slate-800'],
    ['Search Priority', job._search?.score == null ? '—' : `${job._search.score}%`, explanations.search || job._search || fallbackScoreExplanation(job, 'search'), 'text-slate-800'],
  ];
  return `<div class="mt-3 mb-3 bg-white border border-slate-200 rounded-lg p-3">
    <p class="text-[10px] font-bold uppercase tracking-wide text-slate-400 mb-2">Score Explanations</p>
    <div class="grid grid-cols-1 md:grid-cols-3 gap-2">${items.map(([label, value, model, color]) => renderScoreDetails(label, value, model, 'block', color)).join('')}</div>
  </div>`;
}

function renderWhyThisRoleBrief(job) {
  const brief = job._brief || fallbackWhyThisRoleBrief(job);
  if (!brief) return '';
  const section = (label, values) => {
    const list = Array.isArray(values) ? values.filter(Boolean) : [values].filter(Boolean);
    if (!list.length) return '';
    return `<div><p class="text-[10px] font-bold uppercase tracking-wide text-slate-400 mb-1">${esc(label)}</p>
      <ul class="space-y-1 text-xs text-slate-600">${list.slice(0, 4).map(item => `<li>${esc(item)}</li>`).join('')}</ul></div>`;
  };
  return `<div class="mt-3 mb-3 bg-white border border-slate-200 rounded-lg p-3">
    <p class="text-[10px] font-bold uppercase tracking-wide text-slate-400 mb-2">Why This Role</p>
    <p class="text-xs text-slate-700 leading-relaxed mb-3">${esc(brief.fitThesis || '')}</p>
    <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
      ${section('Likely Objections', brief.likelyObjections)}
      ${section('Strongest Stories', brief.strongestStories)}
      ${section('Gaps', brief.gaps)}
      ${section('Questions To Ask', brief.questionsToAsk)}
    </div>
    ${brief.outreachAngle ? `<p class="text-xs font-semibold text-blue-700 bg-blue-50 rounded px-2 py-1 mt-3">${esc(brief.outreachAngle)}</p>` : ''}
  </div>`;
}

function fallbackWhyThisRoleBrief(job) {
  const gaps = Array.isArray(job.report?.gaps) ? job.report.gaps.slice(0, 4) : [];
  const stories = Array.isArray(job.report?.cv_match_table)
    ? job.report.cv_match_table.filter(row => /strong/i.test(row?.strength || '') && row.evidence).slice(0, 3).map(row => row.evidence)
    : [];
  return {
    fitThesis: job.report?.role_summary || job.score_analysis || `${job.company || 'This company'} is being tracked for ${job.title || 'this role'}.`,
    likelyObjections: gaps.length ? gaps : ['Confirm the highest-impact requirements before interview prep.'],
    strongestStories: stories,
    gaps,
    questionsToAsk: ['What would make the first 90 days successful?', 'Which customer or product priority matters most for this role?'],
    outreachAngle: compactNextStep(job) || 'Use the strongest matching story as the outreach hook.',
  };
}

function renderCompanyResearchPanel(job) {
  const research = job._companyResearch || fallbackCompanyResearch(job);
  if (!research) return '';
  const chips = [
    ['Funding', research.funding],
    ['Layoffs', research.layoffs],
    ['Leadership', research.leadership],
    ['Category', research.productCategory],
    ['Customers', Array.isArray(research.customers) ? research.customers.join(', ') : research.customers],
    ['Competitors', Array.isArray(research.competitors) ? research.competitors.join(', ') : research.competitors],
    ['News', Array.isArray(research.recentNews) ? research.recentNews.join(', ') : research.recentNews],
  ].filter(([, value]) => value);
  if (!chips.length && !research.missingSignals?.length) return '';
  return `<div class="mt-3 mb-3 bg-white border border-slate-200 rounded-lg p-3">
    <div class="flex items-center justify-between gap-2 mb-2">
      <p class="text-[10px] font-bold uppercase tracking-wide text-slate-400">Company Research</p>
      <span class="text-[10px] font-bold uppercase rounded px-2 py-0.5 bg-slate-100 text-slate-600">${esc(research.confidence ?? 0)}% confidence</span>
    </div>
    <div class="flex flex-wrap gap-1.5">
      ${chips.map(([label, value]) => `<span class="text-[11px] bg-slate-50 text-slate-600 border border-slate-100 rounded px-2 py-1"><strong>${esc(label)}:</strong> ${esc(value)}</span>`).join('')}
    </div>
    ${research.missingSignals?.length ? `<p class="text-[11px] text-slate-400 mt-2">Missing: ${esc(research.missingSignals.join(', '))}</p>` : ''}
  </div>`;
}

function fallbackCompanyResearch(job) {
  const oi = job._oi || {};
  return {
    confidence: oi.score ?? 0,
    funding: '',
    layoffs: '',
    leadership: '',
    productCategory: job.full_description || job.description_preview ? 'Inferred from job description' : '',
    customers: [],
    competitors: [],
    recentNews: [],
    missingSignals: oi.missingSignals || ['funding', 'layoffs', 'leadership', 'customers', 'competitors', 'recent news'],
  };
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

  document.getElementById('int-search').addEventListener('input',          debounce(renderInterviews));
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
    const nextRound = nextScheduledRound(job.interviews);
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
            ${nextRound ? `<p class="int-next-round text-[11px] font-semibold text-amber-700 truncate max-w-xs mt-0.5">Next interview: ${esc(interviewRoundTypeLabel(nextRound.roundType))} · ${nextRound.scheduledAt ? fmtDateTime(nextRound.scheduledAt) : 'date not set'}</p>` : ''}
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
    dRow.dataset.jobId = job.id;
    dRow.innerHTML = `<td colspan="6" class="px-6 py-5 border-b border-slate-100"></td>`;

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
      const dRow = document.getElementById(tr.dataset.detailId);
      const job = jobById(dRow?.dataset.jobId);
      if (dRow && job) {
        ensureDetailRow(dRow, job, buildIntDetailPanel);
        dRow.classList.toggle('hidden');
      }
    });
  });

  tbody.querySelectorAll('.int-add-note-btn').forEach(btn => {
    btn.addEventListener('click', () => openInterviewNote(btn.dataset.id));
  });

  tbody.querySelectorAll('.int-edit-btn').forEach(btn => {
    btn.addEventListener('click', () => openEditModal(btn.dataset.id));
  });

  bindInterviewNoteActions(tbody);
  bindWorkflowActions(tbody);
  bindContactWorkspace(tbody);
}

function bindInterviewNoteActions(root = document) {
  root.querySelectorAll('.int-note-input').forEach(ta => {
    if (ta.dataset.bound === '1') return;
    ta.dataset.bound = '1';
    const submitBtn = root.querySelector(`.int-note-submit[data-id="${CSS.escape(ta.dataset.id)}"]`);
    ta.addEventListener('input', () => {
      if (submitBtn) submitBtn.classList.toggle('hidden', !ta.value.trim());
    });
  });

  root.querySelectorAll('.int-note-submit').forEach(btn => {
    if (btn.dataset.bound === '1') return;
    btn.dataset.bound = '1';
    btn.addEventListener('click', async () => {
      const jobId = btn.dataset.id;
      const ta    = root.querySelector(`.int-note-input[data-id="${CSS.escape(jobId)}"]`);
      const logEl = root.querySelector(`.int-notes-log[data-id="${CSS.escape(jobId)}"]`);
      const text  = ta.value.trim();
      if (!text) return;
      btn.disabled = true;
      btn.textContent = 'Saving…';
      const today    = new Date().toISOString().slice(0, 10);
      const job      = allJobs.find(j => j.id === jobId);
      const existing = (job?.notes || '').trim();
      const newNotes = existing ? `${today}: ${text}\n${existing}` : `${today}: ${text}`;
      try {
        const result = await patchJob(jobId, { notes: newNotes });
        if (result.job) replaceJobInState(result.job);
        else if (job) job.notes = newNotes;
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
    const result = await postWorkflowEvent(jobId, { type, note });
    if (result.job) applyJobMutation(result.job);
    if (input) input.value = '';
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
    const result = await upsertJobContact(panel.dataset.jobId, { contact: readContactForm(panel) });
    if (result.job) applyJobMutation(result.job);
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
    const result = await upsertJobContact(panel.dataset.jobId, {
      contact: { ...contact, responseStatus: 'outreach_sent' },
      markOutreachSent: true,
    });
    if (result.job) applyJobMutation(result.job);
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
    const result = await generateContactOutreachDraft(panel.dataset.jobId, { contactId, type });
    if (result.job) applyJobMutation(result.job);
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
  loadHome();
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
  if (vaultData) renderVaultView();
}

function invalidateWorkspaceCaches() {
  resumeWorkspace = null;
  outreachWorkspace = null;
  contactsWorkspace = null;
  analyticsSummary = null;
  analyticsOutcomes = null;
  settingsHealth = null;
  vaultData = null;
}

function setupOperationalWorkspaces() {
  document.getElementById('resume-filter')?.addEventListener('change', renderResumeWorkspace);
  document.getElementById('contacts-search')?.addEventListener('input', debounce(renderContactsWorkspace));
  document.getElementById('contacts-relationship-filter')?.addEventListener('change', renderContactsWorkspace);
  document.getElementById('contacts-response-filter')?.addEventListener('change', renderContactsWorkspace);
  setupDelegatedWorkspaceActions();
}

function setupDelegatedWorkspaceActions() {
  if (delegatedWorkspaceActionsReady) return;
  delegatedWorkspaceActionsReady = true;

  const resumeRoot = document.getElementById('resume-queue-root');
  delegate(resumeRoot, 'click', '.resume-job-link', (event, btn) => showJobDetail(btn.dataset.id));
  delegate(resumeRoot, 'click', '.gen-btn', (event, btn) => triggerGenerate(btn.dataset.id, btn));

  const outreachRoot = document.getElementById('view-outreach');
  delegate(outreachRoot, 'click', '.outreach-open-job', (event, btn) => showJobDetail(btn.dataset.id));
  delegate(outreachRoot, 'click', '.draft-copy-btn', async (event, btn) => {
    await navigator.clipboard?.writeText(btn.dataset.text || '');
    btn.textContent = 'Copied';
    setTimeout(() => { btn.textContent = 'Copy'; }, 1200);
  });
  delegate(outreachRoot, 'click', '.draft-regenerate-btn', async (event, btn) => {
    const result = await generateContactOutreachDraft(btn.dataset.jobId, { contactId: btn.dataset.contactId, type: btn.dataset.type });
    if (result.job) replaceJobInState(result.job);
    else invalidateWorkspaceCaches();
    renderOutreachWorkspace();
  });
  delegate(outreachRoot, 'click', '.draft-mark-sent-btn', async (event, btn) => {
    const job = allJobs.find(item => item.id === btn.dataset.jobId);
    const contact = (job?.contacts || []).find(item => item.id === btn.dataset.contactId);
    if (!contact) return;
    const result = await upsertJobContact(btn.dataset.jobId, { contact: { ...contact, responseStatus: 'outreach_sent' }, markOutreachSent: true });
    if (result.job) replaceJobInState(result.job);
    else invalidateWorkspaceCaches();
    renderOutreachWorkspace();
  });

  const analyticsRoot = document.getElementById('view-analytics');
  delegate(analyticsRoot, 'click', '.job-open-btn', (event, btn) => showJobDetail(btn.dataset.id));
}

function renderWorkspaceView(viewName) {
  if (viewName === 'home') loadHome();
  if (viewName === 'jobs') renderJobsWorkspace();
  if (viewName === 'resume') renderResumeWorkspace();
  if (viewName === 'outreach') renderOutreachWorkspace();
  if (viewName === 'contacts') renderContactsWorkspace();
  if (viewName === 'vault') loadVault();
  if (viewName === 'analytics') renderAnalyticsWorkspace();
  if (viewName === 'settings') renderSettingsWorkspace();
}

function workspaceLoadingPanel(label = 'Loading workspace…') {
  return `<div class="p-8 text-sm text-slate-500 flex items-center gap-2">
    <span class="material-symbols-outlined text-base animate-spin">progress_activity</span>
    <span>${esc(label)}</span>
  </div>`;
}

function workspaceErrorPanel(message) {
  return `<div class="p-4 text-sm text-rose-600 bg-rose-50 border border-rose-100 rounded-lg">${esc(message)}</div>`;
}

function showJobDetail(jobId, { push = true, tab = null } = {}) {
  // Remember which list screen (Dashboard, Resume queue, Outreach, ...) the
  // person came from, so "Back to list" returns them there with whatever
  // filters/sort that screen already had (its DOM is never torn down when
  // hidden, so those controls just keep their values) rather than always
  // jumping to the generic Jobs tab.
  const visible = VIEWS.find(v => !document.getElementById('view-' + v)?.hidden);
  if (visible && visible !== 'jobs') jobDetailReturnView = visible;

  const sameJob = currentJobDetailId === jobId;
  currentJobDetailId = jobId;
  currentJobDetailTab = tab || (sameJob ? currentJobDetailTab : 'overview');
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
      const job = await fetchOpportunityWorkspace(currentJobDetailId);
      currentJobDetailData = job;
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

// ─── Phase 4: Opportunity Workspace (tabbed) ───────────────────────────────
const OPPORTUNITY_TABS = [
  ['overview', 'Overview'],
  ['fit', 'Fit'],
  ['resume', 'Resume'],
  ['contacts', 'Contacts'],
  ['application', 'Application'],
  ['interview', 'Interview'],
  ['activity', 'Activity'],
];

// Mirrors lib/opportunity-stages.mjs's PIPELINE_STAGES/STAGE_LABELS (kept in
// sync manually — this is UI-only display text, not validation; the server
// is the source of truth and rejects an unsupported stage regardless).
const PIPELINE_STAGE_OPTIONS = [
  ['discovered', 'Discovered'],
  ['qualified', 'Qualified'],
  ['review', 'Review'],
  ['pursuing', 'Pursuing'],
  ['materials_ready', 'Materials Ready'],
  ['applied', 'Applied'],
  ['recruiter_screen', 'Recruiter Screen'],
  ['interview', 'Interview'],
  ['final_round', 'Final Round'],
  ['offer', 'Offer'],
  ['rejected', 'Rejected'],
  ['withdrawn', 'Withdrawn'],
  ['archived', 'Archived'],
];

function renderJobDetailWorkspace(job) {
  // Pursue/Not Interested/Snooze reuse Phase 3's quick-decision endpoint,
  // which acts specifically on the "review this opportunity" action — only
  // meaningful before a decision has been made, so only shown then. Change
  // Stage works at any stage.
  const showEarlyStageActions = ['discovered', 'qualified'].includes(job.stage);
  return `<div class="space-y-4">
    <div class="flex items-center justify-between gap-3">
      <button id="job-detail-back" class="text-xs font-semibold text-slate-500 border border-slate-200 rounded-lg px-3 py-1.5 hover:bg-slate-50">Back to list</button>
      <div class="flex items-center gap-2">
        ${job.url ? `<a href="${esc(job.url)}" target="_blank" rel="noopener" class="text-xs font-semibold text-blue-600 border border-blue-100 rounded-lg px-3 py-1.5 hover:bg-blue-50">Posting</a>` : ''}
        <button class="gen-btn bg-primary text-white text-xs font-semibold rounded-lg px-3 py-1.5 hover:opacity-90" data-id="${esc(job.id)}">Generate resume</button>
        <button class="job-detail-edit text-xs font-semibold text-slate-600 border border-slate-200 rounded-lg px-3 py-1.5 hover:bg-slate-50" data-id="${esc(job.id)}">Edit</button>
      </div>
    </div>
    <div class="bg-white rounded-xl border border-slate-200 shadow-sm p-4">
      <div class="flex items-start justify-between gap-3 mb-3 flex-wrap">
        <div>
          <p class="text-[10px] font-bold uppercase tracking-wide text-slate-400">Opportunity</p>
          <h3 class="text-xl font-bold text-slate-900">${esc(job.company || 'Unknown company')}</h3>
          <p class="text-sm text-slate-500">${esc(job.title || 'Unknown role')}</p>
        </div>
        ${statusBadge(job.status)}
      </div>
      <div class="flex flex-wrap gap-2 mb-3">
        ${headerChip('Stage', esc(job.stageLabel || '—'))}
        ${headerChip('Priority', esc(priorityChipText(job.priority)))}
        ${headerChip('Fit', fitChipHtml(job))}
        ${headerChip('Freshness', esc(freshnessChipText(job.freshness)))}
      </div>
      <div class="flex flex-wrap items-center gap-2">
        ${showEarlyStageActions ? `
          <button class="opp-quick-decision text-xs font-semibold text-emerald-700 border border-emerald-200 rounded-lg px-3 py-1.5 hover:bg-emerald-50" data-decision="pursue">Pursue</button>
          <button class="opp-quick-decision text-xs font-semibold text-rose-700 border border-rose-200 rounded-lg px-3 py-1.5 hover:bg-rose-50" data-decision="not_interested">Not Interested</button>
          <button class="opp-quick-decision text-xs font-semibold text-slate-600 border border-slate-200 rounded-lg px-3 py-1.5 hover:bg-slate-50" data-decision="snooze">Snooze</button>
        ` : ''}
        <select class="opp-change-stage text-xs font-semibold border border-slate-200 rounded-lg px-2 py-1.5 bg-white">
          <option value="">Change stage…</option>
          ${PIPELINE_STAGE_OPTIONS.map(([value, label]) => `<option value="${value}" ${job.stage === value ? 'selected' : ''}>${esc(label)}</option>`).join('')}
        </select>
      </div>
      <p class="opp-action-error hidden text-xs text-rose-600 mt-2"></p>
    </div>
    <div class="border-b border-slate-200">
      <nav class="flex flex-wrap gap-1 -mb-px">
        ${OPPORTUNITY_TABS.map(([key, label]) => `<button class="opp-tab-btn text-xs font-semibold px-3 py-2 border-b-2 ${currentJobDetailTab === key ? 'border-primary text-primary' : 'border-transparent text-slate-500 hover:text-slate-700'}" data-tab="${key}">${label}</button>`).join('')}
      </nav>
    </div>
    <div id="opp-tab-content">${renderOppTabContent(job, currentJobDetailTab)}</div>
  </div>`;
}

function headerChip(label, valueHtml) {
  return `<div class="bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5">
    <p class="text-[9px] font-bold uppercase tracking-wide text-slate-400">${esc(label)}</p>
    <p class="text-xs font-semibold text-slate-700">${valueHtml}</p>
  </div>`;
}

function priorityChipText(priority) {
  return priority ? statusDisplayLabel(priority) : 'Not set';
}

function fitChipHtml(job) {
  const fit = job.fit;
  if (fit?.available) return `${esc(String(fit.overallScore))}% · ${esc(fit.pursuitClassification)}`;
  if (job.overallFit != null) return `${esc(String(job.overallFit))} <span class="text-slate-400 font-normal">(legacy score, not yet Phase 2-scored)</span>`;
  return 'Not scored';
}

function freshnessChipText(freshness) {
  if (!freshness?.bucket) return 'Unknown';
  const label = freshness.bucket.charAt(0).toUpperCase() + freshness.bucket.slice(1);
  return freshness.ageDays != null ? `${label} · ${freshness.ageDays}d old` : label;
}

function renderOppTabContent(job, tab) {
  switch (tab) {
    case 'fit': return renderFitTab(job);
    case 'resume': return renderResumeTab(job);
    case 'contacts': return renderContactWorkspace(job);
    case 'application': return renderApplicationTab(job);
    case 'interview': return renderInterviewTab(job);
    case 'activity': return renderActivityTab(job);
    default: return renderOverviewTab(job);
  }
}

function overviewField(label, value) {
  return `<div><p class="text-[10px] font-bold uppercase tracking-wide text-slate-400">${esc(label)}</p><p class="text-slate-700 font-medium">${esc(value)}</p></div>`;
}

function renderSummaryList(label, items) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return '';
  return `<div class="mb-3"><p class="text-[10px] font-bold uppercase tracking-wide text-slate-400 mb-1">${esc(label)}</p>
    <ul class="text-xs text-slate-600 space-y-0.5 list-disc list-inside">${list.map(i => `<li>${esc(i)}</li>`).join('')}</ul></div>`;
}

function renderOverviewTab(job) {
  const fit = job.fit;
  const blockers = fit?.available ? fit.hardBlockers : (Array.isArray(job.hardBlockers) ? job.hardBlockers : []);
  const summary = fit?.available ? fit.summary : null;
  const gmail = job.gmail || {};
  return `<div class="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_320px] gap-4">
    <div class="space-y-4">
      <div class="bg-white rounded-xl border border-slate-200 shadow-sm p-4">
        <p class="text-label-caps font-label-caps text-slate-500 mb-3">KEY DETAILS</p>
        <div class="grid grid-cols-2 md:grid-cols-3 gap-3">
          ${overviewField('Location', job.location || '—')}
          ${overviewField('Remote', job.remoteStatus || '—')}
          ${overviewField('Compensation', job.compensation || job.salary || '—')}
          ${overviewField('Source', job.source || '—')}
          ${overviewField('Discovered', fmtDate(job.discoveredDate || job.date_found))}
          ${overviewField('Posted', job.postedDate ? fmtDate(job.postedDate) : '—')}
          ${overviewField('Next Action', job.nextAction || nextActionLabel(job._workflow?.nextBestAction || 'review'))}
          ${overviewField('Next Action Date', job.nextActionDate ? fmtDate(job.nextActionDate) : '—')}
        </div>
      </div>
      ${blockers && blockers.length ? `<div class="bg-rose-50 border border-rose-200 rounded-xl p-4">
        <p class="text-label-caps font-label-caps text-rose-700 mb-2">BLOCKERS</p>
        <ul class="space-y-1 text-xs text-rose-700 list-disc list-inside">${blockers.map(b => `<li>${esc(typeof b === 'string' ? b : b.description || '')}</li>`).join('')}</ul>
      </div>` : ''}
      ${summary ? `<div class="bg-white rounded-xl border border-slate-200 shadow-sm p-4">
        <p class="text-label-caps font-label-caps text-slate-500 mb-2">WHY YOU FIT <span class="text-slate-400 font-normal normal-case">(Phase 2 fit analysis — see the Fit tab for full detail)</span></p>
        ${renderSummaryList('Strong matches', summary.whyYouFit)}
        ${renderSummaryList('Concerns', summary.concerns)}
        ${renderSummaryList('Unknowns', summary.unknowns)}
      </div>` : `<div class="bg-white rounded-xl border border-slate-200 shadow-sm p-4 text-xs text-slate-400">${esc(fit?.reason || 'Fit analysis needs a saved job description — see the Fit tab.')}</div>`}
      <div class="bg-white rounded-xl border border-slate-200 shadow-sm p-4">
        ${buildDetailPanel(job)}
      </div>
    </div>
    <div class="space-y-4">
      <div class="bg-white rounded-xl border border-slate-200 shadow-sm p-4">
        <p class="text-label-caps font-label-caps text-slate-500 mb-3">GMAIL SIGNALS</p>
        ${gmail.lastEmailDate ? `<div class="text-sm">
          <p class="font-semibold text-slate-700">${esc(gmail.lastEmailSubject || 'Latest Gmail signal')}</p>
          <p class="text-xs text-slate-400">${fmtDateTime(gmail.lastEmailDate)}</p>
          <p class="text-xs text-slate-500 mt-2">${esc(gmail.lastEmailSnippet || '')}</p>
        </div>` : '<p class="text-sm text-slate-400">No Gmail signal attached.</p>'}
      </div>
    </div>
  </div>`;
}

const FIT_TIER_COLOR = {
  strong_match: 'bg-emerald-50 text-emerald-700',
  partial_match: 'bg-amber-50 text-amber-700',
  unknown: 'bg-slate-100 text-slate-600',
  gap: 'bg-rose-50 text-rose-700',
  blocker: 'bg-rose-100 text-rose-800',
};

function renderFitTab(job) {
  const fit = job.fit;
  if (!fit?.available) {
    return `<div class="bg-white rounded-xl border border-slate-200 shadow-sm p-6 text-sm text-slate-500">
      <p class="font-semibold text-slate-700 mb-1">Fit analysis unavailable</p>
      <p>${esc(fit?.reason || 'No usable job description saved for this opportunity yet.')}</p>
    </div>`;
  }
  return `<div class="space-y-4">
    <div class="bg-white rounded-xl border border-slate-200 shadow-sm p-4 flex flex-wrap items-center gap-4">
      ${workspaceMetricCard('Overall Fit', fit.overallScore + '%', 'text-slate-800')}
      ${workspaceMetricCard('Classification', fit.pursuitClassification, 'text-slate-800')}
      <div>
        <p class="text-[10px] font-bold uppercase tracking-wide text-slate-400">Confidence</p>
        <p class="text-sm font-semibold text-slate-700">${esc(fit.confidence.level)}</p>
        <p class="text-[11px] text-slate-400 max-w-xs">${esc(fit.confidence.reason)}</p>
      </div>
    </div>
    <div class="bg-white rounded-xl border border-slate-200 shadow-sm overflow-x-auto">
      <table class="w-full text-xs">
        <thead><tr class="border-b border-slate-200 bg-slate-50">
          <th class="text-left px-3 py-2 font-bold text-slate-500 uppercase tracking-wide">Requirement</th>
          <th class="text-left px-3 py-2 font-bold text-slate-500 uppercase tracking-wide">Classification</th>
          <th class="text-left px-3 py-2 font-bold text-slate-500 uppercase tracking-wide">Supporting evidence</th>
        </tr></thead>
        <tbody>${fit.classifications.map(c => `<tr class="border-b border-slate-100 align-top">
          <td class="px-3 py-2 text-slate-700">${esc(c.label)}</td>
          <td class="px-3 py-2"><span class="text-[10px] font-bold uppercase rounded px-1.5 py-0.5 ${FIT_TIER_COLOR[c.tier] || 'bg-slate-100 text-slate-600'}">${esc(c.tierLabel)}</span></td>
          <td class="px-3 py-2 text-slate-500">${c.evidence.length ? c.evidence.map(e => esc(e)).join('<br>') : esc(c.reason)}</td>
        </tr>`).join('')}</tbody>
      </table>
    </div>
    ${fit.hardBlockers.length ? `<div class="bg-rose-50 border border-rose-200 rounded-xl p-4">
      <p class="text-label-caps font-label-caps text-rose-700 mb-2">HARD BLOCKERS</p>
      <ul class="text-xs text-rose-700 list-disc list-inside space-y-1">${fit.hardBlockers.map(b => `<li>${esc(b.description)}</li>`).join('')}</ul>
    </div>` : ''}
    ${fit.openQuestions.length ? `<div class="bg-white rounded-xl border border-slate-200 shadow-sm p-4">
      <p class="text-label-caps font-label-caps text-slate-500 mb-3">OPEN QUESTIONS <span class="text-slate-400 font-normal normal-case">(resolves the Unknowns above)</span></p>
      <div class="space-y-3">${fit.openQuestions.map(renderCandidateQuestion).join('')}</div>
    </div>` : ''}
  </div>`;
}

function renderCandidateQuestion(q) {
  return `<div class="candidate-question border border-slate-100 rounded-lg p-3" data-question-id="${esc(q.id)}">
    <p class="text-xs text-slate-700 mb-2">${esc(q.question)}</p>
    <div class="flex flex-col sm:flex-row gap-2">
      <input class="question-answer-input flex-1 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-xs outline-none focus:ring-2 focus:ring-blue-600/20" placeholder="Your answer">
      <button class="question-answer-btn text-xs font-semibold bg-primary text-white rounded-lg px-3 py-1.5 hover:opacity-90">Answer</button>
    </div>
    <p class="question-answer-error hidden text-xs text-rose-600 mt-1"></p>
  </div>`;
}

function renderResumeTab(job) {
  const versions = Array.isArray(job.resumeVersions) ? job.resumeVersions : generatedResumeVersions(job);
  const ats = job._ats;
  return `<div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
    <div class="bg-white rounded-xl border border-slate-200 shadow-sm p-4">
      <p class="text-label-caps font-label-caps text-slate-500 mb-3">ATS SCORE / AUDIT</p>
      <p class="text-h2 font-h2 ${atsScoreColor(job)} mb-1">${atsScoreLabel(job)}</p>
      <p class="text-xs text-slate-500 mb-3">${ats ? `${ats.mapped.length} of ${ats.total} keywords matched` : 'Not yet scored — generate a resume to score it.'}</p>
      ${ats?.missing?.length ? `<div><p class="text-[10px] font-bold uppercase tracking-wide text-slate-400 mb-1">Missing keywords</p>
        <div class="flex flex-wrap gap-1.5">${ats.missing.slice(0, 15).map(m => `<span class="text-[11px] bg-rose-50 text-rose-600 rounded px-2 py-0.5">${esc(m.keyword)}</span>`).join('')}</div></div>` : ''}
      <button class="gen-btn mt-3 bg-primary text-white text-xs font-semibold rounded-lg px-3 py-1.5 hover:opacity-90" data-id="${esc(job.id)}">${versions.length ? 'Regenerate resume' : 'Generate resume'}</button>
    </div>
    <div class="bg-white rounded-xl border border-slate-200 shadow-sm p-4">
      <p class="text-label-caps font-label-caps text-slate-500 mb-3">GENERATED RESUMES</p>
      ${versions.length ? versions.map(version => `<div class="border-b border-slate-100 last:border-0 py-2">
        <a href="${esc(version.docxUrl)}" download class="text-xs font-semibold text-blue-600 hover:underline truncate block">${esc(version.fileName)}</a>
        <p class="text-[11px] text-slate-400">${fmtDateTime(version.generatedAt)} · ${esc(resumeVersionScoreLabel(version))}</p>
      </div>`).join('') : '<p class="text-sm text-slate-400">No generated resume yet.</p>'}
    </div>
  </div>`;
}

function renderApplicationTab(job) {
  const applied = Boolean(job.appliedDate) || job.status === 'applied' || !['discovered', 'qualified', 'review', 'pursuing', 'materials_ready'].includes(job.stage);
  return `<div class="application-panel bg-white rounded-xl border border-slate-200 shadow-sm p-4 max-w-2xl">
    <div class="grid grid-cols-1 md:grid-cols-2 gap-3 mb-4">
      ${overviewField('Applied?', applied ? 'Yes' : 'No')}
      ${overviewField('Current Stage', job.stageLabel || '—')}
    </div>
    <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
      <label class="text-xs text-slate-500">Applied date
        <input type="date" class="app-applied-date mt-1 w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-xs outline-none focus:ring-2 focus:ring-blue-600/20" value="${esc((job.appliedDate || '').slice(0, 10))}">
      </label>
      <label class="text-xs text-slate-500">Application source
        <input class="app-source mt-1 w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-xs outline-none focus:ring-2 focus:ring-blue-600/20" value="${esc(job.applicationSource || '')}">
      </label>
      <label class="text-xs text-slate-500">Resume used
        <input class="app-resume-version mt-1 w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-xs outline-none focus:ring-2 focus:ring-blue-600/20" value="${esc(job.resumeVersion || '')}">
      </label>
      <label class="text-xs text-slate-500">Cover letter used
        <input class="app-cover-letter mt-1 w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-xs outline-none focus:ring-2 focus:ring-blue-600/20" value="${esc(job.coverLetterVersion || '')}">
      </label>
      <label class="text-xs text-slate-500">Referral
        <input class="app-referral mt-1 w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-xs outline-none focus:ring-2 focus:ring-blue-600/20" value="${esc(job.referral || '')}">
      </label>
    </div>
    <button class="application-save-btn mt-3 bg-primary text-white text-xs font-semibold rounded-lg px-3 py-1.5 hover:opacity-90">Save</button>
    <p class="application-save-error hidden text-xs text-rose-600 mt-2"></p>
  </div>`;
}

// ─── Phase 9.3: Interview Command Center (Interview tab) ────────────────────
// Renders Phase 9.1 rounds (job.interviews) and the Phase 9.2 read model
// (job.interviewPrep). Evidence shown here is exactly what the server's
// verified-only prep model returns; nothing is generated client-side.
const PREP_TIER_LABELS = {
  strong_match: 'Strong Match',
  partial_match: 'Partial Match',
  unknown: 'Unknown',
  gap: 'Gap',
  blocker: 'Blocker',
};

const LIKELY_QUESTION_BASIS = {
  round: ['Round', 'bg-blue-50 text-blue-700'],
  requirement: ['Requirement', 'bg-emerald-50 text-emerald-700'],
  gap: ['Gap', 'bg-rose-50 text-rose-700'],
};

function interviewCard(title, bodyHtml, extraClass = '') {
  return `<div class="bg-white rounded-xl border border-slate-200 shadow-sm p-4 ${extraClass}">
    <p class="text-label-caps font-label-caps text-slate-500 mb-3">${esc(title)}</p>
    ${bodyHtml}
  </div>`;
}

function optionTags(options, selected) {
  return options.map(([value, label]) => `<option value="${esc(value)}" ${value === selected ? 'selected' : ''}>${esc(label)}</option>`).join('');
}

function roundContactNames(round, contacts) {
  const byId = new Map((contacts || []).map(c => [c.id, c]));
  return (round.contactIds || []).map(id => byId.get(id)).filter(Boolean)
    .map(c => c.title ? `${c.name} (${c.title})` : c.name);
}

function renderRoundForm(round, contacts) {
  const r = round || {};
  const inputCls = 'mt-1 w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-xs outline-none focus:ring-2 focus:ring-blue-600/20';
  const selectedContacts = new Set(r.contactIds || []);
  // Interviewer contacts (Phase 9.4) listed first.
  contacts = [...(contacts || [])].sort((a, b) => Number(b.relationshipType === 'interviewer') - Number(a.relationshipType === 'interviewer'));
  return `<div class="interview-round-form space-y-3 pt-3" data-round-id="${esc(r.id || '')}">
    <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
      <label class="text-xs text-slate-500">Round type
        <select class="round-type ${inputCls}">${optionTags(INTERVIEW_ROUND_TYPE_OPTIONS, r.roundType || 'recruiter')}</select>
      </label>
      <label class="text-xs text-slate-500">Status
        <select class="round-status ${inputCls}">${optionTags(INTERVIEW_ROUND_STATUS_OPTIONS, r.status || 'scheduled')}</select>
      </label>
      <label class="text-xs text-slate-500">Date and time
        <input type="datetime-local" class="round-scheduled ${inputCls}" value="${esc(toDatetimeLocalValue(r.scheduledAt))}">
      </label>
      <label class="text-xs text-slate-500">Format
        <select class="round-format ${inputCls}">${optionTags(INTERVIEW_ROUND_FORMAT_OPTIONS, r.format || '')}</select>
      </label>
      <label class="text-xs text-slate-500 md:col-span-2">Location or meeting link
        <input class="round-location ${inputCls}" maxlength="300" value="${esc(r.location || '')}">
      </label>
    </div>
    <div>
      <p class="text-xs text-slate-500 mb-1">Interviewers</p>
      ${(contacts || []).length ? `<div class="flex flex-wrap gap-2">${contacts.map(c => `<label class="text-xs text-slate-600 bg-slate-50 border border-slate-200 rounded-lg px-2 py-1 flex items-center gap-1.5">
        <input type="checkbox" class="round-contact" value="${esc(c.id)}" ${selectedContacts.has(c.id) ? 'checked' : ''}>${esc(c.name)}${c.title ? ` <span class="text-slate-400">· ${esc(c.title)}</span>` : ''}
      </label>`).join('')}</div>` : '<p class="text-xs text-slate-400">No contacts on this opportunity yet. Add interviewers (relationship: Interviewer) in the Contacts tab, then link them here.</p>'}
    </div>
    <label class="text-xs text-slate-500 block">Notes
      <textarea class="round-notes ${inputCls} resize-y" rows="4" maxlength="5000">${esc(r.notes || '')}</textarea>
    </label>
    <label class="text-xs text-slate-500 block">Outcome
      <textarea class="round-outcome ${inputCls} resize-y" rows="2" maxlength="1000">${esc(r.outcome || '')}</textarea>
    </label>
    <div class="flex items-center gap-2">
      <button class="round-save-btn bg-primary text-white text-xs font-semibold rounded-lg px-3 py-1.5 hover:opacity-90">${r.id ? 'Save round' : 'Add round'}</button>
      <p class="round-save-error hidden text-xs text-rose-600"></p>
    </div>
  </div>`;
}

// Phase 9.5: thank-you drafts for a completed round. Drafts live on the
// interviewer contact (contact.outreachDrafts, type thank_you, roundId);
// "Mark thank-you sent" records a follow_up_done event, which clears the
// Command Center's send_thank_you action.
function renderRoundThankYou(job, round, contacts) {
  const linked = (round.contactIds || []).map(id => contacts.find(c => c.id === id)).filter(Boolean);
  const drafts = linked.flatMap(c => (c.outreachDrafts || [])
    .filter(d => d.type === 'thank_you' && d.roundId === round.id)
    .map(d => ({ ...d, contactName: c.name })))
    .sort((a, b) => String(b.generatedAt).localeCompare(String(a.generatedAt)));
  const sent = (job.activity || []).some(e => e.type === 'follow_up_done' && round.completedAt && e.at >= round.completedAt);
  return `<div class="round-thank-you mt-2 bg-slate-50 border border-slate-100 rounded-lg p-2" data-round-id="${esc(round.id)}">
    <p class="text-[10px] font-bold uppercase tracking-wide text-slate-400 mb-1">Thank-you</p>
    ${sent ? '<p class="text-xs font-semibold text-emerald-700">Thank-you marked sent.</p>' : ''}
    ${linked.length ? `<div class="flex flex-wrap gap-2">${linked.map(c => `<button class="round-thank-you-btn text-[11px] font-semibold text-slate-600 border border-slate-200 bg-white rounded-lg px-2.5 py-1 hover:bg-slate-50" data-round-id="${esc(round.id)}" data-contact-id="${esc(c.id)}">Draft thank-you to ${esc(c.name)}</button>`).join('')}</div>`
      : '<p class="text-xs text-slate-400">Link an interviewer to this round to draft a thank-you.</p>'}
    ${drafts.map(d => `<div class="mt-2">
      <p class="text-[10px] font-bold uppercase tracking-wide text-slate-400 mb-1">To ${esc(d.contactName)} · ${fmtDateTime(d.generatedAt)}${d.source === 'fallback' ? ' · template' : ''}</p>
      <textarea readonly class="w-full bg-white border border-slate-200 rounded-lg px-3 py-2 text-xs text-slate-600 leading-relaxed resize-y" rows="6">${esc(d.text)}</textarea>
    </div>`).join('')}
    ${sent ? '' : `<button class="round-thank-you-sent-btn mt-2 text-[11px] font-semibold text-emerald-700 border border-emerald-200 bg-white rounded-lg px-2.5 py-1 hover:bg-emerald-50" data-round-id="${esc(round.id)}" data-round-label="${esc(interviewRoundTypeLabel(round.roundType))}">Mark thank-you sent</button>`}
    <p class="round-thank-you-error hidden text-xs text-rose-600 mt-1"></p>
  </div>`;
}

function renderInterviewRoundsCard(job) {
  const rounds = Array.isArray(job.interviews) ? job.interviews : [];
  const contacts = Array.isArray(job.contacts) ? job.contacts : [];
  const list = rounds.length ? rounds.map(round => {
    const names = roundContactNames(round, contacts);
    const meta = [
      INTERVIEW_ROUND_STATUS_OPTIONS.find(([v]) => v === round.status)?.[1] || round.status,
      round.scheduledAt ? fmtDateTime(round.scheduledAt) : 'No date set',
      INTERVIEW_ROUND_FORMAT_OPTIONS.find(([v]) => v === round.format && v)?.[1] || '',
    ].filter(Boolean).join(' · ');
    return `<div class="interview-round border-b border-slate-100 last:border-0 py-3" data-round-id="${esc(round.id)}">
      <p class="text-sm font-semibold text-slate-700">${esc(interviewRoundTypeLabel(round.roundType))} interview</p>
      <p class="text-[11px] text-slate-400">${esc(meta)}</p>
      ${round.location ? `<p class="text-xs text-slate-500 mt-1 break-all">${esc(round.location)}</p>` : ''}
      ${names.length ? `<p class="text-xs text-slate-500 mt-1">With: ${esc(names.join(', '))}</p>` : ''}
      ${round.notes ? `<p class="text-xs text-slate-600 mt-2 whitespace-pre-wrap break-words">${esc(round.notes)}</p>` : ''}
      ${round.outcome ? `<p class="text-xs text-slate-700 mt-1"><strong>Outcome:</strong> ${esc(round.outcome)}</p>` : ''}
      ${round.status === 'completed' ? renderRoundThankYou(job, round, contacts) : ''}
      <details class="mt-2"><summary class="text-xs font-semibold text-blue-600 cursor-pointer">Edit round and notes</summary>${renderRoundForm(round, contacts)}</details>
    </div>`;
  }).join('') : '<p class="text-sm text-slate-400">No interview rounds recorded yet.</p>';
  return interviewCard('INTERVIEW ROUNDS', `${list}
    <details class="mt-3 border-t border-slate-100 pt-3" ${rounds.length ? '' : 'open'}>
      <summary class="text-xs font-semibold text-blue-600 cursor-pointer">Add interview round</summary>
      ${renderRoundForm(null, contacts)}
    </details>`);
}

function renderPrepBriefing(prep) {
  const b = prep.briefing || {};
  const next = prep.nextRound;
  const fields = [
    ['Stage', b.stageLabel || b.stage || '—'],
    ['Location', b.location || '—'],
    ['Compensation', b.compensation || '—'],
    ['Seniority', b.seniority || '—'],
    ['Domains', (b.domains || []).join(', ') || '—'],
    ['Fit', b.fit ? `${b.fit.overallScore}% · ${b.fit.pursuitClassification}` : 'Not scored'],
  ];
  return interviewCard('BRIEFING', `
    <p class="text-sm font-semibold text-slate-800">${esc(b.company || 'Unknown company')}</p>
    <p class="text-xs text-slate-500 mb-3">${esc(b.title || 'Unknown role')}</p>
    ${next ? `<p class="text-xs font-semibold text-amber-700 bg-amber-50 rounded px-3 py-2 mb-3">Next: ${esc(prep.roundTypeLabel || interviewRoundTypeLabel(next.roundType))} interview · ${next.scheduledAt ? fmtDateTime(next.scheduledAt) : 'date not set'}</p>` : '<p class="text-xs text-slate-400 mb-3">No upcoming round scheduled.</p>'}
    <div class="grid grid-cols-2 gap-2 text-xs mb-3">${fields.map(([label, value]) => `<div><p class="text-[10px] font-bold uppercase tracking-wide text-slate-400">${esc(label)}</p><p class="text-slate-700">${esc(value)}</p></div>`).join('')}</div>
    ${b.jdReason ? `<p class="text-xs text-slate-400">${esc(b.jdReason)}</p>` : ''}
    ${renderSummaryList('Key responsibilities', b.responsibilities)}
    ${(b.hardBlockers || []).length ? `<div class="bg-rose-50 border border-rose-200 rounded-lg p-2"><p class="text-[10px] font-bold uppercase tracking-wide text-rose-700 mb-1">Blockers</p>
      <ul class="text-xs text-rose-700 list-disc list-inside">${b.hardBlockers.map(x => `<li>${esc(x)}</li>`).join('')}</ul></div>` : ''}`);
}

function renderPrepChecklist(prep) {
  const items = prep.checklist || [];
  return interviewCard('PREP CHECKLIST', `<ul class="space-y-2">${items.map(item => `<li class="flex items-start gap-2 text-xs">
    <span class="material-symbols-outlined text-base leading-none ${item.done ? 'text-emerald-600' : 'text-slate-300'}">${item.done ? 'check_circle' : 'radio_button_unchecked'}</span>
    <span class="${item.done ? 'text-slate-500' : 'text-slate-700'}">${esc(item.label)}${item.detail ? ` <span class="text-slate-400">(${esc(item.detail)})</span>` : ''}</span>
  </li>`).join('')}</ul>`);
}

function renderLikelyQuestions(prep) {
  const questions = prep.likelyQuestions || [];
  return interviewCard('LIKELY QUESTIONS', questions.length ? `<ol class="space-y-2 list-decimal list-inside">${questions.map(q => {
    const [label, cls] = LIKELY_QUESTION_BASIS[q.basis] || ['', ''];
    return `<li class="text-xs text-slate-700">${esc(q.question)}${label ? ` <span class="text-[10px] font-bold uppercase rounded px-1.5 py-0.5 ${cls}">${esc(label)}</span>` : ''}</li>`;
  }).join('')}</ol>` : '<p class="text-sm text-slate-400">No likely questions available.</p>');
}

function renderPrepEvidence(prep) {
  const evidence = prep.evidence || [];
  const body = evidence.length ? evidence.map(e => {
    const shown = e.facts.slice(0, 3);
    const rest = e.facts.slice(3);
    const factItem = f => `<li>${esc(f.fact)}${f.employer ? ` <span class="text-slate-400">(${esc(f.employer)})</span>` : ''}</li>`;
    return `<div class="border-b border-slate-100 last:border-0 py-3">
      <p class="text-xs font-semibold text-slate-700 mb-1">${esc(e.requirement)} <span class="text-[10px] font-bold uppercase rounded px-1.5 py-0.5 ${FIT_TIER_COLOR[e.tier] || 'bg-slate-100 text-slate-600'}">${esc(PREP_TIER_LABELS[e.tier] || e.tier)}</span></p>
      ${shown.length ? `<ul class="text-xs text-slate-600 list-disc list-inside space-y-0.5">${shown.map(factItem).join('')}</ul>` : ''}
      ${rest.length ? `<details class="mt-1"><summary class="text-[11px] text-blue-600 cursor-pointer">${rest.length} more verified fact${rest.length === 1 ? '' : 's'}</summary><ul class="text-xs text-slate-600 list-disc list-inside space-y-0.5 mt-1">${rest.map(factItem).join('')}</ul></details>` : ''}
      ${e.stories.length ? e.stories.map(st => `<div class="mt-2 bg-slate-50 border border-slate-100 rounded-lg p-2 text-xs text-slate-600 space-y-0.5">
        <p class="text-[10px] font-bold uppercase tracking-wide text-slate-400">STAR story${st.employer ? ` · ${esc(st.employer)}` : ''}</p>
        <p><strong>S:</strong> ${esc(st.situation)}</p><p><strong>T:</strong> ${esc(st.task)}</p><p><strong>A:</strong> ${esc(st.action)}</p><p><strong>R:</strong> ${esc(st.result)}</p>
      </div>`).join('') : `<p class="text-[11px] text-slate-400 mt-1">${esc(e.storyNote)}</p>`}
    </div>`;
  }).join('') : '<p class="text-sm text-slate-400">No verified evidence matched this role\'s requirements yet.</p>';
  return interviewCard('RECOMMENDED VERIFIED EVIDENCE', `${prep.evidencePolicy ? `<p class="text-[11px] text-slate-400 mb-2">${esc(prep.evidencePolicy)}</p>` : ''}${body}`);
}

function renderPrepGaps(prep) {
  const gaps = prep.gaps || [];
  return interviewCard('GAPS AND UNKNOWNS TO PREPARE', gaps.length ? `<div class="space-y-2">${gaps.map(g => `<div class="text-xs">
    <p class="font-semibold text-slate-700">${esc(g.requirement)} <span class="text-[10px] font-bold uppercase rounded px-1.5 py-0.5 ${FIT_TIER_COLOR[g.tier] || 'bg-slate-100 text-slate-600'}">${esc(PREP_TIER_LABELS[g.tier] || g.tier)}</span></p>
    <p class="text-slate-500">${esc(g.reason)}</p>
    ${g.openQuestionId ? '<button class="prep-open-fit-tab text-[11px] font-semibold text-blue-600 hover:underline">Answer the open question in the Fit tab</button>' : ''}
  </div>`).join('')}</div>` : '<p class="text-sm text-slate-400">No gaps or unknowns identified.</p>');
}

function renderPrepQuestionsToAsk(prep) {
  const questions = prep.questionsToAsk || [];
  return interviewCard('QUESTIONS TO ASK', questions.length
    ? `<ul class="space-y-1.5 text-xs text-slate-700 list-disc list-inside">${questions.map(q => `<li>${esc(q)}</li>`).join('')}</ul>`
    : '<p class="text-sm text-slate-400">No questions yet.</p>');
}

function renderInterviewTab(job) {
  const prep = job.interviewPrep;
  return `<div class="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_340px] gap-4">
    <div class="space-y-4">
      ${renderInterviewRoundsCard(job)}
      ${prep ? renderLikelyQuestions(prep) : ''}
      ${prep ? renderPrepEvidence(prep) : ''}
      ${prep ? renderPrepGaps(prep) : ''}
    </div>
    <div class="space-y-4">
      ${prep ? renderPrepBriefing(prep) : ''}
      ${prep ? renderPrepChecklist(prep) : ''}
      ${prep ? renderPrepQuestionsToAsk(prep) : ''}
    </div>
  </div>`;
}

function renderActivityTab(job) {
  const events = [...(job.activity || [])].reverse(); // newest first by default
  return `<div class="space-y-4">
    ${renderWorkflowActions(job)}
    <div class="bg-white rounded-xl border border-slate-200 shadow-sm divide-y divide-slate-100">
      ${events.length ? events.map(e => `<div class="flex items-center justify-between gap-3 px-4 py-3">
        <div class="min-w-0">
          <p class="text-sm font-semibold text-slate-700">${esc(workflowEventLabel(e.type))}</p>
          ${e.label || e.note ? `<p class="text-xs text-slate-400 truncate">${esc(e.note || e.label)}</p>` : ''}
          ${e.from || e.to ? `<p class="text-xs text-slate-400">${esc(e.from || '')} → ${esc(e.to || '')}</p>` : ''}
        </div>
        <p class="text-xs text-slate-400 shrink-0">${fmtDateTime(e.at)}</p>
      </div>`).join('') : '<p class="p-4 text-sm text-slate-400">No activity recorded yet.</p>'}
    </div>
  </div>`;
}

function bindJobDetailActions(root, job) {
  root.querySelector('#job-detail-back')?.addEventListener('click', () => {
    currentJobDetailId = '';
    showView(jobDetailReturnView || 'jobs');
  });
  root.querySelector('.job-detail-edit')?.addEventListener('click', () => openEditModal(job.id));
  root.querySelector('.gen-btn')?.addEventListener('click', event => triggerGenerate(job.id, event.currentTarget));

  root.querySelectorAll('.opp-tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      currentJobDetailTab = btn.dataset.tab;
      const content = root.querySelector('#opp-tab-content');
      if (content && currentJobDetailData) {
        content.innerHTML = renderOppTabContent(currentJobDetailData, currentJobDetailTab);
        bindWorkflowActions(content);
        bindContactWorkspace(content);
        bindOppTabContentActions(content);
      }
      root.querySelectorAll('.opp-tab-btn').forEach(b => {
        b.className = `opp-tab-btn text-xs font-semibold px-3 py-2 border-b-2 ${b.dataset.tab === currentJobDetailTab ? 'border-primary text-primary' : 'border-transparent text-slate-500 hover:text-slate-700'}`;
      });
    });
  });

  root.querySelectorAll('.opp-quick-decision').forEach(btn => {
    btn.addEventListener('click', () => submitOppQuickDecision(root, job.id, btn.dataset.decision));
  });
  root.querySelector('.opp-change-stage')?.addEventListener('change', event => {
    const stage = event.currentTarget.value;
    if (stage) submitOppStageChange(root, job.id, stage);
  });

  bindOppTabContentActions(root.querySelector('#opp-tab-content'));
}

function bindOppTabContentActions(root) {
  if (!root) return;
  root.querySelector('.application-save-btn')?.addEventListener('click', () => submitApplicationTab(root, currentJobDetailId));
  root.querySelectorAll('.candidate-question').forEach(panel => {
    panel.querySelector('.question-answer-btn')?.addEventListener('click', () => submitQuestionAnswer(panel));
  });
  root.querySelectorAll('.interview-round-form').forEach(form => {
    form.querySelector('.round-save-btn')?.addEventListener('click', () => submitInterviewRound(form, currentJobDetailId));
  });
  root.querySelectorAll('.round-thank-you-btn').forEach(btn => {
    btn.addEventListener('click', () => submitThankYouDraft(btn, currentJobDetailId));
  });
  root.querySelectorAll('.round-thank-you-sent-btn').forEach(btn => {
    btn.addEventListener('click', () => submitThankYouSent(btn, currentJobDetailId));
  });
  root.querySelectorAll('.prep-open-fit-tab').forEach(btn => {
    btn.addEventListener('click', () => showJobDetail(currentJobDetailId, { push: false, tab: 'fit' }));
  });
}

async function runThankYouAction(btn, work) {
  const errorEl = btn.closest('.round-thank-you')?.querySelector('.round-thank-you-error');
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Working...';
  errorEl?.classList.add('hidden');
  try {
    await work();
    invalidateWorkspaceCaches();
    showJobDetail(currentJobDetailId, { push: false, tab: 'interview' });
  } catch (e) {
    if (errorEl) { errorEl.textContent = e.message; errorEl.classList.remove('hidden'); }
    btn.disabled = false;
    btn.textContent = label;
  }
}

function submitThankYouDraft(btn, id) {
  return runThankYouAction(btn, () => generateContactOutreachDraft(id, {
    contactId: btn.dataset.contactId,
    type: 'thank_you',
    roundId: btn.dataset.roundId,
  }));
}

function submitThankYouSent(btn, id) {
  return runThankYouAction(btn, () => postWorkflowEvent(id, {
    type: 'follow_up_done',
    label: 'Thank-you sent',
    note: `${btn.dataset.roundLabel} interview`,
  }));
}

async function submitInterviewRound(form, id) {
  const btn = form.querySelector('.round-save-btn');
  const errorEl = form.querySelector('.round-save-error');
  const roundId = form.dataset.roundId;
  const payload = buildRoundPayload({
    roundType: form.querySelector('.round-type')?.value,
    status: form.querySelector('.round-status')?.value,
    scheduledAt: fromDatetimeLocalValue(form.querySelector('.round-scheduled')?.value),
    format: form.querySelector('.round-format')?.value,
    location: form.querySelector('.round-location')?.value,
    contactIds: [...form.querySelectorAll('.round-contact:checked')].map(el => el.value),
    notes: form.querySelector('.round-notes')?.value,
    outcome: form.querySelector('.round-outcome')?.value,
  });
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Saving...';
  errorEl?.classList.add('hidden');
  try {
    if (roundId) await updateInterviewRound(id, roundId, payload);
    else await createInterviewRound(id, payload);
    invalidateWorkspaceCaches();
    showJobDetail(id, { push: false, tab: 'interview' });
  } catch (e) {
    if (errorEl) { errorEl.textContent = e.message; errorEl.classList.remove('hidden'); }
    btn.disabled = false;
    btn.textContent = label;
  }
}

async function submitOppQuickDecision(root, id, decision) {
  const errorEl = root.querySelector('.opp-action-error');
  errorEl?.classList.add('hidden');
  try {
    await postQuickDecision(id, decision);
    invalidateWorkspaceCaches();
    showJobDetail(id, { push: false });
  } catch (e) {
    if (errorEl) { errorEl.textContent = e.message; errorEl.classList.remove('hidden'); }
  }
}

async function submitOppStageChange(root, id, stage) {
  const errorEl = root.querySelector('.opp-action-error');
  errorEl?.classList.add('hidden');
  try {
    await postOpportunityStage(id, stage);
    invalidateWorkspaceCaches();
    showJobDetail(id, { push: false });
  } catch (e) {
    if (errorEl) { errorEl.textContent = e.message; errorEl.classList.remove('hidden'); }
  }
}

async function submitApplicationTab(root, id) {
  const btn = root.querySelector('.application-save-btn');
  const errorEl = root.querySelector('.application-save-error');
  const body = {
    appliedDate: root.querySelector('.app-applied-date')?.value || '',
    applicationSource: root.querySelector('.app-source')?.value.trim() || '',
    resumeVersion: root.querySelector('.app-resume-version')?.value.trim() || '',
    coverLetterVersion: root.querySelector('.app-cover-letter')?.value.trim() || '',
    referral: root.querySelector('.app-referral')?.value.trim() || '',
  };
  btn.disabled = true;
  btn.textContent = 'Saving...';
  errorEl?.classList.add('hidden');
  try {
    await patchOpportunity(id, body);
    invalidateWorkspaceCaches();
    showJobDetail(id, { push: false });
  } catch (e) {
    if (errorEl) { errorEl.textContent = e.message; errorEl.classList.remove('hidden'); }
    btn.disabled = false;
    btn.textContent = 'Save';
  }
}

async function submitQuestionAnswer(panel) {
  const btn = panel.querySelector('.question-answer-btn');
  const input = panel.querySelector('.question-answer-input');
  const errorEl = panel.querySelector('.question-answer-error');
  const answer = input?.value.trim();
  if (!answer) {
    if (errorEl) { errorEl.textContent = 'Enter an answer first.'; errorEl.classList.remove('hidden'); }
    return;
  }
  btn.disabled = true;
  btn.textContent = 'Saving...';
  errorEl?.classList.add('hidden');
  try {
    await answerCandidateQuestion(panel.dataset.questionId, answer);
    // Phase 5: offer to turn this answer into persisted, verified evidence
    // so the same requirement is never asked about again — only when Brian
    // explicitly confirms; answering a question never silently creates
    // evidence on its own.
    if (window.confirm('Save this answer as verified evidence in your Career Profile too, so Career-Ops stops asking about it?')) {
      try {
        await promoteQuestionToEvidence(panel.dataset.questionId);
      } catch (e) {
        window.alert('Answered, but could not save it as evidence: ' + e.message);
      }
    }
    invalidateWorkspaceCaches();
    showJobDetail(currentJobDetailId, { push: false, tab: 'fit' });
  } catch (e) {
    if (errorEl) { errorEl.textContent = e.message; errorEl.classList.remove('hidden'); }
    btn.disabled = false;
    btn.textContent = 'Answer';
  }
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
    if (!resumeWorkspace) {
      countEl.textContent = 'Loading resume queue…';
      queueRoot.innerHTML = workspaceLoadingPanel('Loading resume queue…');
      versionsRoot.innerHTML = workspaceLoadingPanel('Loading version history…');
      qualityRoot.innerHTML = workspaceLoadingPanel('Loading source quality…');
    }
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
  } catch (e) {
    countEl.textContent = 'Resume workspace unavailable';
    queueRoot.innerHTML = workspaceErrorPanel(e.message);
    versionsRoot.innerHTML = '';
    qualityRoot.innerHTML = '';
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
  const summaryRoot = document.getElementById('outreach-summary-root');
  const dueRoot = document.getElementById('outreach-due-root');
  const draftsRoot = document.getElementById('outreach-drafts-root');
  const sentRoot = document.getElementById('outreach-sent-root');
  const repliesRoot = document.getElementById('outreach-replies-root');
  if (!summaryRoot || !dueRoot || !draftsRoot || !sentRoot || !repliesRoot) return;
  try {
    if (!outreachWorkspace) {
      countEl.textContent = 'Loading outreach…';
      summaryRoot.innerHTML = '';
      dueRoot.innerHTML = workspaceLoadingPanel('Loading due follow-ups…');
      draftsRoot.innerHTML = workspaceLoadingPanel('Loading drafts…');
      sentRoot.innerHTML = workspaceLoadingPanel('Loading sent outreach…');
      repliesRoot.innerHTML = workspaceLoadingPanel('Loading replies…');
    }
    if (!outreachWorkspace) outreachWorkspace = await fetchOutreachWorkspace();
    const data = outreachWorkspace;
    countEl.textContent = `${data.dueFollowUps.length} due · ${data.drafts.length} draft${data.drafts.length === 1 ? '' : 's'} · ${data.replies.length} repl${data.replies.length === 1 ? 'y' : 'ies'}`;
    summaryRoot.innerHTML = [
      workspaceMetricCard('Due', data.dueFollowUps.length, 'text-amber-700'),
      workspaceMetricCard('Drafts', data.drafts.length, 'text-blue-700'),
      workspaceMetricCard('Sent', data.sentOutreach.length, 'text-slate-800'),
      workspaceMetricCard('Replies', data.replies.length, 'text-emerald-700'),
    ].join('');
    dueRoot.innerHTML = renderOutreachList('DUE FOLLOW-UPS', data.dueFollowUps, renderOutreachContactItem);
    draftsRoot.innerHTML = renderOutreachList('DRAFTS', data.drafts, renderDraftItem);
    sentRoot.innerHTML = renderOutreachList('SENT OUTREACH', data.sentOutreach, renderOutreachContactItem);
    repliesRoot.innerHTML = renderOutreachList('REPLIES', data.replies, renderOutreachContactItem);
  } catch (e) {
    countEl.textContent = 'Outreach unavailable';
    dueRoot.innerHTML = workspaceErrorPanel(e.message);
    draftsRoot.innerHTML = '';
    sentRoot.innerHTML = '';
    repliesRoot.innerHTML = '';
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
    const result = await generateContactOutreachDraft(btn.dataset.jobId, { contactId: btn.dataset.contactId, type: btn.dataset.type });
    if (result.job) replaceJobInState(result.job);
    else invalidateWorkspaceCaches();
    renderOutreachWorkspace();
  }));
  root.querySelectorAll('.draft-mark-sent-btn').forEach(btn => btn.addEventListener('click', async () => {
    const job = allJobs.find(item => item.id === btn.dataset.jobId);
    const contact = (job?.contacts || []).find(item => item.id === btn.dataset.contactId);
    if (!contact) return;
    const result = await upsertJobContact(btn.dataset.jobId, { contact: { ...contact, responseStatus: 'outreach_sent' }, markOutreachSent: true });
    if (result.job) replaceJobInState(result.job);
    else invalidateWorkspaceCaches();
    renderOutreachWorkspace();
  }));
}

async function renderContactsWorkspace() {
  const root = document.getElementById('contacts-root');
  const countEl = document.getElementById('contacts-count-label');
  if (!root || !countEl) return;
  try {
    if (!contactsWorkspace) {
      countEl.textContent = 'Loading contacts…';
      root.innerHTML = workspaceLoadingPanel('Loading contacts…');
      contactsWorkspace = await fetchContactsWorkspace();
      populateWorkspaceSelect('contacts-relationship-filter', contactsWorkspace.filters.relationshipTypes, 'All relationships');
      populateWorkspaceSelect('contacts-response-filter', contactsWorkspace.filters.responseStatuses, 'All statuses', contactStatusLabel);
    }
    const q = (document.getElementById('contacts-search')?.value || '').toLowerCase();
    const relationship = document.getElementById('contacts-relationship-filter')?.value || '';
    const response = document.getElementById('contacts-response-filter')?.value || '';
    let contacts = contactsWorkspace.contacts || [];
    if (q) contacts = contacts.filter(contact => [contact.name, contact.company, contact.jobCompany, contact.jobTitle, contact.title].join(' ').toLowerCase().includes(q));
    if (relationship) contacts = contacts.filter(contact => contact.relationshipType === relationship);
    if (response) contacts = contacts.filter(contact => contact.responseStatus === response);
    contacts = sortContacts(contacts);
    countEl.textContent = `${contacts.length} of ${(contactsWorkspace.contacts || []).length} contact${(contactsWorkspace.contacts || []).length === 1 ? '' : 's'}`;
    root.innerHTML = renderContactsTable(contacts);
    bindContactsWorkspaceActions(root, contacts);
  } catch (e) {
    countEl.textContent = 'Contacts unavailable';
    root.innerHTML = workspaceErrorPanel(e.message);
  }
}

function populateWorkspaceSelect(id, values, label, display = statusDisplayLabel) {
  const select = document.getElementById(id);
  if (!select || select.dataset.populated === '1') return;
  select.innerHTML = `<option value="">${esc(label)}</option>` + values.map(value => `<option value="${esc(value)}">${esc(display(value))}</option>`).join('');
  select.dataset.populated = '1';
}

function contactStatusLabel(status) {
  return ({
    not_contacted: 'Not Contacted',
    outreach_sent: 'Request Sent',
    responded: 'Connected',
  })[status] || statusDisplayLabel(status);
}

function contactStatusOptions(selected) {
  return [
    ['not_contacted', 'Not Contacted'],
    ['outreach_sent', 'Request Sent'],
    ['responded', 'Connected'],
  ].map(([value, label]) => `<option value="${value}" ${selected === value ? 'selected' : ''}>${label}</option>`).join('');
}

function contactExperienceMatchLabel(contact) {
  const pct = Number(contact?.experienceMatchPct);
  return Number.isFinite(pct) ? `${Math.round(pct)}%` : '—';
}

function contactExperienceMatchClass(contact) {
  const pct = Number(contact?.experienceMatchPct);
  if (!Number.isFinite(pct)) return 'text-slate-400';
  if (pct >= 80) return 'text-emerald-700 font-semibold';
  if (pct >= 50) return 'text-amber-700 font-semibold';
  return 'text-rose-600 font-semibold';
}

function contactInfluenceLabel(contact) {
  const score = Number(contact?.influenceScore ?? contact?.contactIntelligence?.score);
  return Number.isFinite(score) ? `${Math.round(score)}%` : '—';
}

function contactInfluenceClass(contact) {
  const score = Number(contact?.influenceScore ?? contact?.contactIntelligence?.score);
  if (!Number.isFinite(score)) return 'text-slate-400';
  if (score >= 75) return 'text-emerald-700 font-semibold';
  if (score >= 50) return 'text-amber-700 font-semibold';
  return 'text-slate-600';
}

function setContactsSort(col) {
  contactsSort = {
    col,
    dir: contactsSort.col === col && contactsSort.dir === 'asc' ? 'desc' : 'asc',
  };
  renderContactsWorkspace();
}

function contactsSortIcon(col) {
  if (contactsSort.col !== col) return '';
  return contactsSort.dir === 'asc' ? '↑' : '↓';
}

function contactSortButton(col, label) {
  return `<button class="contacts-sort-btn inline-flex items-center gap-1 hover:text-blue-600" data-col="${esc(col)}">${esc(label)}<span class="text-[10px]">${contactsSortIcon(col)}</span></button>`;
}

function contactSortValue(contact, col) {
  if (col === 'experienceMatchPct') {
    const pct = Number(contact.experienceMatchPct);
    return Number.isFinite(pct) ? pct : -1;
  }
  if (col === 'influenceScore') {
    const pct = Number(contact.influenceScore ?? contact.contactIntelligence?.score);
    return Number.isFinite(pct) ? pct : -1;
  }
  if (col === 'followUpDue') return contact.followUpDue || '9999-99-99';
  if (col === 'status') return contactStatusLabel(contact.responseStatus);
  if (col === 'relationship') return statusDisplayLabel(contact.relationshipType);
  if (col === 'company') return contact.jobCompany || contact.company || '';
  return contact.name || '';
}

function sortContacts(contacts) {
  const direction = contactsSort.dir === 'asc' ? 1 : -1;
  return [...contacts].sort((a, b) => {
    const av = contactSortValue(a, contactsSort.col);
    const bv = contactSortValue(b, contactsSort.col);
    if (typeof av === 'number' || typeof bv === 'number') {
      return ((Number(av) || 0) - (Number(bv) || 0)) * direction || String(a.name || '').localeCompare(String(b.name || ''));
    }
    return String(av).localeCompare(String(bv)) * direction || String(a.name || '').localeCompare(String(b.name || ''));
  });
}

function renderContactsTable(contacts) {
  if (!contacts.length) return '<div class="p-12 text-center text-slate-400">No contacts match these filters.</div>';
  return `<table class="dashboard-table w-full text-sm">
    <thead><tr class="border-b border-slate-200 bg-slate-50">
      <th class="text-left px-4 py-3 text-xs font-bold text-slate-500 uppercase tracking-wide">${contactSortButton('name', 'Contact')}</th>
      <th class="text-left px-4 py-3 text-xs font-bold text-slate-500 uppercase tracking-wide">${contactSortButton('relationship', 'Relationship')}</th>
      <th class="text-left px-4 py-3 text-xs font-bold text-slate-500 uppercase tracking-wide">${contactSortButton('experienceMatchPct', 'Experience Match')}</th>
      <th class="text-left px-4 py-3 text-xs font-bold text-slate-500 uppercase tracking-wide">${contactSortButton('influenceScore', 'Influence')}</th>
      <th class="text-left px-4 py-3 text-xs font-bold text-slate-500 uppercase tracking-wide">${contactSortButton('status', 'Status')}</th>
      <th class="text-left px-4 py-3 text-xs font-bold text-slate-500 uppercase tracking-wide">${contactSortButton('followUpDue', 'Follow-up')}</th>
      <th class="text-left px-4 py-3 text-xs font-bold text-slate-500 uppercase tracking-wide">Action</th>
    </tr></thead>
    <tbody>${contacts.map(contact => `<tr class="border-b border-slate-100 hover:bg-slate-50">
      <td class="px-4 py-3">
        <p class="font-semibold text-slate-800">${esc(contact.name)}</p>
        <p class="text-xs text-slate-500">${esc(contact.title || '')} · ${esc(contact.jobCompany)} · ${esc(contact.jobTitle)}</p>
        ${contact.linkedinUrl ? `<a class="inline-flex items-center gap-1 text-xs font-semibold text-blue-600 hover:underline mt-1" href="${esc(contact.linkedinUrl)}" target="_blank" rel="noopener"><span class="material-symbols-outlined text-sm">open_in_new</span><span>LinkedIn profile</span></a>` : ''}
      </td>
      <td class="px-4 py-3 text-xs text-slate-600">${esc(statusDisplayLabel(contact.relationshipType))}</td>
      <td class="px-4 py-3 text-xs ${contactExperienceMatchClass(contact)}">${esc(contactExperienceMatchLabel(contact))}</td>
      <td class="px-4 py-3 text-xs ${contactInfluenceClass(contact)}">
        ${renderScoreDetails('Influence', contactInfluenceLabel(contact), contact.contactIntelligence, 'inline', contactInfluenceClass(contact))}
      </td>
      <td class="px-4 py-3 text-xs text-slate-600">${esc(contactStatusLabel(contact.responseStatus))}</td>
      <td class="px-4 py-3 text-xs ${contact.followUpDueInDays != null && contact.followUpDueInDays <= 0 ? 'text-amber-700 font-semibold' : 'text-slate-500'}">${esc(contact.followUpDue || '—')}</td>
      <td class="px-4 py-3">
        <div class="flex gap-2">
          <button class="contact-open-job text-xs font-semibold text-blue-600 border border-blue-100 rounded-lg px-3 py-1.5 hover:bg-blue-50" data-id="${esc(contact.jobId)}">Open</button>
          <button class="contact-edit-workspace text-xs font-semibold text-slate-600 border border-slate-200 rounded-lg px-3 py-1.5 hover:bg-slate-50" data-job-id="${esc(contact.jobId)}" data-contact-id="${esc(contact.id)}">Edit</button>
        </div>
        <div class="contact-status-editor hidden mt-2 flex flex-wrap items-center gap-2" data-job-id="${esc(contact.jobId)}" data-contact-id="${esc(contact.id)}">
          <select class="contact-status-select bg-white border border-slate-200 rounded-lg px-2 py-1.5 text-xs outline-none focus:ring-2 focus:ring-blue-600/20">${contactStatusOptions(contact.responseStatus || 'not_contacted')}</select>
          <button class="contact-status-save text-xs font-semibold text-white bg-primary rounded-lg px-3 py-1.5 hover:opacity-90">Save</button>
          <button class="contact-status-cancel text-xs font-semibold text-slate-600 border border-slate-200 rounded-lg px-3 py-1.5 hover:bg-slate-50">Cancel</button>
        </div>
      </td>
    </tr>`).join('')}</tbody>
  </table>`;
}

function bindContactsWorkspaceActions(root, contacts) {
  root.querySelectorAll('.contacts-sort-btn').forEach(btn => btn.addEventListener('click', () => setContactsSort(btn.dataset.col)));
  root.querySelectorAll('.contact-open-job').forEach(btn => btn.addEventListener('click', () => showJobDetail(btn.dataset.id)));
  root.querySelectorAll('.contact-edit-workspace').forEach(btn => btn.addEventListener('click', async () => {
    const editor = root.querySelector(`.contact-status-editor[data-job-id="${CSS.escape(btn.dataset.jobId)}"][data-contact-id="${CSS.escape(btn.dataset.contactId)}"]`);
    editor?.classList.remove('hidden');
  }));
  root.querySelectorAll('.contact-status-cancel').forEach(btn => btn.addEventListener('click', () => {
    btn.closest('.contact-status-editor')?.classList.add('hidden');
  }));
  root.querySelectorAll('.contact-status-save').forEach(btn => btn.addEventListener('click', async () => {
    const editor = btn.closest('.contact-status-editor');
    const contact = contacts.find(item => item.id === editor?.dataset.contactId && item.jobId === editor?.dataset.jobId);
    if (!contact) return;
    const responseStatus = editor.querySelector('.contact-status-select')?.value || 'not_contacted';
    const result = await upsertJobContact(contact.jobId, { contact: { ...contact, responseStatus } });
    if (result.job) replaceJobInState(result.job);
    else invalidateWorkspaceCaches();
    renderContactsWorkspace();
  }));
}

// ─── Phase 10: Outcome Intelligence ────────────────────────────────────────
// Renders lib/outcome-intelligence.mjs output. Rates below the server's
// minimum sample are shown as raw counts marked "low sample", never as a
// percentage, and insights come verbatim from the server.
const OUTCOME_DIMENSION_ORDER = ['source', 'fitRange', 'roleCategory', 'networking', 'resume', 'workArrangement', 'company'];

async function renderOutcomeIntelligencePanel() {
  const root = document.getElementById('analytics-outcomes-root');
  if (!root) return;
  try {
    if (!analyticsOutcomes) {
      root.innerHTML = workspaceLoadingPanel('Loading outcome intelligence…');
      analyticsOutcomes = await fetchOutcomeIntelligence();
    }
    root.innerHTML = renderOutcomeIntelligence(analyticsOutcomes);
  } catch (e) {
    root.innerHTML = workspaceErrorPanel(e.message);
  }
}

function outcomeRateHtml(r) {
  if (!r || !r.denominator) return '<span class="text-slate-300">—</span>';
  if (!r.sufficient) return `<span class="text-slate-500">${r.numerator}/${r.denominator}</span> <span class="text-[10px] text-slate-400">low sample</span>`;
  return `<span class="font-semibold text-slate-800">${Math.round(r.rate * 100)}%</span> <span class="text-[10px] text-slate-400">(${r.numerator}/${r.denominator})</span>`;
}

function renderOutcomeFunnel(f) {
  const steps = [['Discovered', f.discovered], ['Pursued', f.interested], ['Applied', f.applied], ['Interviewed', f.interview], ['Offer', f.offer]];
  const max = Math.max(1, f.discovered);
  const closed = [
    ['Awaiting response', f.awaitingResponse],
    ['In interviews', f.inInterviews],
    ['Rejected after applying', f.rejectedAfterApplying],
    ['Rejected after interview', f.rejectedAfterInterview],
    ['Withdrawn', f.withdrawn],
    ['Closed before applying', f.closedBeforeApplying],
  ];
  return `<div class="space-y-1.5">${steps.map(([label, n]) => `<div class="flex items-center gap-3 text-xs">
      <span class="w-24 shrink-0 text-slate-500">${esc(label)}</span>
      <div class="flex-1 bg-slate-100 rounded h-4 overflow-hidden"><div class="bg-blue-600 h-4 rounded" style="width:${n ? Math.max(1.5, (n / max) * 100) : 0}%"></div></div>
      <span class="w-12 text-right font-semibold text-slate-700">${n}</span>
    </div>`).join('')}</div>
    <div class="flex flex-wrap gap-1.5 mt-3">${closed.map(([label, n]) => `<span class="text-[11px] bg-slate-50 text-slate-600 border border-slate-100 rounded px-2 py-1">${esc(label)}: <strong>${n}</strong></span>`).join('')}</div>`;
}

function renderOutcomeSegment(dim, seg, open) {
  const rows = seg.rows || [];
  return `<details class="outcome-segment border-b border-slate-100 last:border-0 py-2" data-dimension="${esc(dim)}" ${open ? 'open' : ''}>
    <summary class="text-xs font-semibold text-slate-700 cursor-pointer">${esc(seg.label)} <span class="text-slate-400 font-normal">(${rows.length} group${rows.length === 1 ? '' : 's'})</span></summary>
    ${rows.length ? `<div class="overflow-x-auto mt-2"><table class="w-full text-xs">
      <thead><tr class="border-b border-slate-200 text-slate-400 uppercase text-[10px] tracking-wide">
        <th class="text-left py-1 pr-2">Group</th><th class="text-right px-2">Tracked</th><th class="text-right px-2">Applied</th><th class="text-right px-2">Interviews</th><th class="text-right px-2">Offers</th><th class="text-right px-2">Rejected</th><th class="text-left px-2">App → interview</th><th class="text-left px-2">Interview → offer</th>
      </tr></thead>
      <tbody>${rows.map(r => `<tr class="border-b border-slate-50 align-top">
        <td class="py-1.5 pr-2 text-slate-700">${esc(r.label)}${r.caveat ? `<p class="text-[10px] text-amber-700 max-w-xs">${esc(r.caveat)}</p>` : ''}</td>
        <td class="text-right px-2 text-slate-500">${r.total}</td>
        <td class="text-right px-2 text-slate-700">${r.applied}</td>
        <td class="text-right px-2 text-slate-700">${r.interviews}</td>
        <td class="text-right px-2 text-slate-700">${r.offers}</td>
        <td class="text-right px-2 text-slate-500">${r.rejected}</td>
        <td class="px-2 whitespace-nowrap">${outcomeRateHtml(r.interviewRate)}</td>
        <td class="px-2 whitespace-nowrap">${outcomeRateHtml(r.offerRate)}</td>
      </tr>`).join('')}</tbody>
    </table></div>` : '<p class="text-xs text-slate-400 mt-1">No data.</p>'}
  </details>`;
}

function renderOutcomeIntelligence(data) {
  const measured = (data.insights || []).filter(i => i.kind === 'measured');
  const insufficient = (data.insights || []).filter(i => i.kind === 'insufficient');
  return `<div class="bg-white rounded-xl border border-slate-200 shadow-sm p-4 space-y-4">
    <div>
      <p class="text-label-caps font-label-caps text-slate-500">OUTCOME INTELLIGENCE</p>
      <p class="text-xs text-slate-400">Measured from your recorded job-search history. Rates need at least ${esc(data.minSample)} in the base; smaller groups show counts only.</p>
    </div>
    <div class="grid grid-cols-1 xl:grid-cols-2 gap-4">
      <div>
        <p class="text-[10px] font-bold uppercase tracking-wide text-slate-400 mb-2">Funnel (furthest stage reached)</p>
        ${renderOutcomeFunnel(data.funnel || {})}
      </div>
      <div>
        <p class="text-[10px] font-bold uppercase tracking-wide text-slate-400 mb-2">Conversion</p>
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-2">${(data.conversions || []).map(c => `<div class="outcome-conversion bg-slate-50 border border-slate-100 rounded-lg px-3 py-2">
          <p class="text-[10px] font-bold uppercase tracking-wide text-slate-400">${esc(c.label)}</p>
          <p class="text-sm">${c.sufficient ? outcomeRateHtml(c) : `<span class="text-slate-500">Not enough data</span> <span class="text-[10px] text-slate-400">(${c.numerator}/${c.denominator})</span>`}</p>
        </div>`).join('')}</div>
      </div>
    </div>
    <div class="grid grid-cols-1 xl:grid-cols-2 gap-4">
      <div>
        <p class="text-[10px] font-bold uppercase tracking-wide text-slate-400 mb-2">What the data shows</p>
        ${measured.length ? `<ul class="space-y-1.5">${measured.map(i => `<li class="outcome-insight-measured text-xs text-slate-700 flex gap-2"><span class="material-symbols-outlined text-base leading-none text-blue-600">insights</span><span>${esc(i.text)}</span></li>`).join('')}</ul>` : '<p class="text-xs text-slate-400">No differences large enough, with enough data, to report yet.</p>'}
        ${insufficient.length ? `<p class="text-[10px] font-bold uppercase tracking-wide text-slate-400 mt-3 mb-1">Not enough data yet</p>
          <ul class="space-y-1">${insufficient.map(i => `<li class="outcome-insight-insufficient text-xs text-slate-500">${esc(i.text)}</li>`).join('')}</ul>` : ''}
      </div>
      <div>
        <p class="text-[10px] font-bold uppercase tracking-wide text-slate-400 mb-2">Timing (median days, recorded dates only)</p>
        <table class="w-full text-xs"><tbody>${(data.timing || []).map(t => `<tr class="border-b border-slate-50">
          <td class="py-1.5 text-slate-600">${esc(t.label)}</td>
          <td class="py-1.5 text-right">${t.sufficient ? `<span class="font-semibold text-slate-800">${esc(t.medianDays)} days</span>` : t.n ? `<span class="text-slate-500">${esc(t.medianDays)} days</span> <span class="text-[10px] text-slate-400">low sample</span>` : '<span class="text-slate-400">No data</span>'}</td>
          <td class="py-1.5 text-right text-[10px] text-slate-400 w-12">n=${t.n}</td>
        </tr>`).join('')}</tbody></table>
      </div>
    </div>
    <div>
      <p class="text-[10px] font-bold uppercase tracking-wide text-slate-400 mb-1">Outcomes by segment</p>
      ${OUTCOME_DIMENSION_ORDER.filter(dim => data.segments?.[dim]).map((dim, i) => renderOutcomeSegment(dim, data.segments[dim], i === 0)).join('')}
    </div>
    <details class="text-xs text-slate-500">
      <summary class="font-semibold cursor-pointer">How this is measured and what's missing</summary>
      <ul class="list-disc list-inside space-y-1 mt-2">${[...(data.assumptions || []), ...(data.dataGaps || [])].map(x => `<li>${esc(x)}</li>`).join('')}</ul>
    </details>
  </div>`;
}

async function renderAnalyticsWorkspace() {
  const countEl = document.getElementById('analytics-count-label');
  if (!countEl) return;
  const summaryRoot = document.getElementById('analytics-summary-root');
  const stageRoot = document.getElementById('analytics-stage-root');
  const resumeRoot = document.getElementById('analytics-resume-root');
  const followupRoot = document.getElementById('analytics-followup-root');
  const outreachRoot = document.getElementById('analytics-outreach-root');
  const digestRoot = document.getElementById('analytics-digest-root');
  const priorityRoot = document.getElementById('analytics-priority-root');
  const staleRoot = document.getElementById('analytics-stale-root');
  const companyRoot = document.getElementById('analytics-company-root');
  const resumeFeedbackRoot = document.getElementById('analytics-resume-feedback-root');
  if (!summaryRoot || !stageRoot || !resumeRoot || !followupRoot || !outreachRoot || !digestRoot || !priorityRoot || !staleRoot || !companyRoot || !resumeFeedbackRoot) return;
  try {
    if (!analyticsSummary) {
      countEl.textContent = 'Loading pipeline health…';
      summaryRoot.innerHTML = '';
      digestRoot.innerHTML = workspaceLoadingPanel('Loading daily command center…');
      priorityRoot.innerHTML = workspaceLoadingPanel('Loading unified priority queue…');
      stageRoot.innerHTML = workspaceLoadingPanel('Loading pipeline distribution…');
      resumeRoot.innerHTML = workspaceLoadingPanel('Loading resume scores…');
      followupRoot.innerHTML = workspaceLoadingPanel('Loading follow-up debt…');
      outreachRoot.innerHTML = workspaceLoadingPanel('Loading outreach status…');
      staleRoot.innerHTML = workspaceLoadingPanel('Loading stale cleanup…');
      companyRoot.innerHTML = workspaceLoadingPanel('Loading company research…');
      resumeFeedbackRoot.innerHTML = workspaceLoadingPanel('Loading resume feedback loops…');
    }
    if (!analyticsSummary) analyticsSummary = await fetchAnalyticsSummary();
    const data = analyticsSummary;
    countEl.textContent = `${data.activeOpportunities} active opportunities · average ATS ${data.averageActiveAtsScore ?? '—'}%`;
    summaryRoot.innerHTML = [
      workspaceMetricCard('Active', data.activeOpportunities, 'text-slate-800'),
      workspaceMetricCard('Avg ATS', data.averageActiveAtsScore == null ? '—' : data.averageActiveAtsScore + '%', 'text-blue-700'),
      workspaceMetricCard('Follow-ups', data.followUpDebt.count, 'text-amber-700'),
      workspaceMetricCard('Stale', data.staleLeads.count, 'text-rose-700'),
    ].join('');
    digestRoot.innerHTML = renderDailyCommandCenter(data.commandCenter?.dailyDigest || {});
    priorityRoot.innerHTML = renderUnifiedPriorityQueue(data.commandCenter?.priorityQueue || []);
    stageRoot.innerHTML = renderKeyValuePanel('PIPELINE DISTRIBUTION', data.stageDistribution);
    resumeRoot.innerHTML = renderKeyValuePanel('RESUME SCORE DISTRIBUTION', data.resumeScoreDistribution);
    followupRoot.innerHTML = renderOutreachList('FOLLOW-UP DEBT', data.followUpDebt.items || [], renderOutreachContactItem);
    outreachRoot.innerHTML = renderKeyValuePanel('OUTREACH RESPONSE STATUS', data.outreachResponseStatus);
    staleRoot.innerHTML = renderStaleCleanupPanel(data.commandCenter?.staleCleanup || []);
    companyRoot.innerHTML = renderCompanyResearchRows(data.commandCenter?.companyResearch || []);
    resumeFeedbackRoot.innerHTML = renderResumeFeedbackPanel(data.commandCenter?.resumeFeedback || []);
    renderOutcomeIntelligencePanel();
  } catch (e) {
    countEl.textContent = 'Analytics unavailable';
    stageRoot.innerHTML = workspaceErrorPanel(e.message);
    resumeRoot.innerHTML = '';
    followupRoot.innerHTML = '';
    outreachRoot.innerHTML = '';
    digestRoot.innerHTML = '';
    priorityRoot.innerHTML = '';
    staleRoot.innerHTML = '';
    companyRoot.innerHTML = '';
    resumeFeedbackRoot.innerHTML = '';
  }
}

function renderAnalyticsJobLink(item, secondary = '') {
  return `<button class="job-open-btn text-left" data-id="${esc(item.jobId || item.id || '')}">
    <span class="block text-xs font-semibold text-slate-700 hover:text-blue-600">${esc(item.company || 'Unknown company')}</span>
    <span class="block text-[11px] text-slate-400">${esc(secondary || item.title || '')}</span>
  </button>`;
}

function renderCompactQueueList(items = [], empty = 'No items.') {
  if (!items.length) return `<p class="text-sm text-slate-400">${esc(empty)}</p>`;
  return `<div class="divide-y divide-slate-100">${items.map(item => `<div class="py-2 flex items-start justify-between gap-3">
    ${renderAnalyticsJobLink(item)}
    ${item.score != null ? `<span class="text-[10px] font-bold rounded px-2 py-0.5 bg-slate-100 text-slate-600">${esc(item.score)}%</span>` : ''}
  </div>`).join('')}</div>`;
}

function renderDailyCommandCenter(digest = {}) {
  const sections = [
    ['Top Jobs To Apply', digest.topJobsToApply || [], 'No apply priorities.'],
    ['Follow-ups Due', digest.followUpsDue || [], 'No follow-ups due.'],
    ['Stale Leads To Clean', digest.staleLeadsToClean || [], 'No stale cleanup items.'],
    ['High-priority New Roles', digest.highPriorityNewRoles || [], 'No new high-priority roles.'],
    ['Interviews To Prep', digest.interviewsToPrep || [], 'No interview prep due.'],
  ];
  return `<p class="text-label-caps font-label-caps text-slate-500 mb-3">DAILY COMMAND CENTER DIGEST</p>
    <div class="grid grid-cols-1 lg:grid-cols-5 gap-3">${sections.map(([title, items, empty]) => `<div class="border border-slate-100 rounded-lg p-3">
      <p class="text-[10px] font-bold uppercase tracking-wide text-slate-400 mb-2">${esc(title)}</p>
      ${renderCompactQueueList(items, empty)}
    </div>`).join('')}</div>`;
}

function renderUnifiedPriorityQueue(items = []) {
  if (!items.length) return '<p class="text-label-caps font-label-caps text-slate-500 mb-3">UNIFIED PRIORITY QUEUE</p><p class="text-sm text-slate-400">No active opportunities.</p>';
  return `<p class="text-label-caps font-label-caps text-slate-500 mb-3">UNIFIED PRIORITY QUEUE</p>
    <div class="overflow-x-auto"><table class="dashboard-table w-full text-sm">
      <thead><tr class="border-b border-slate-200 bg-slate-50">
        <th class="text-left px-3 py-2 text-xs font-bold text-slate-500 uppercase tracking-wide">Role</th>
        <th class="text-left px-3 py-2 text-xs font-bold text-slate-500 uppercase tracking-wide">Priority</th>
        <th class="text-left px-3 py-2 text-xs font-bold text-slate-500 uppercase tracking-wide">Resume</th>
        <th class="text-left px-3 py-2 text-xs font-bold text-slate-500 uppercase tracking-wide">Outreach</th>
        <th class="text-left px-3 py-2 text-xs font-bold text-slate-500 uppercase tracking-wide">Next</th>
      </tr></thead>
      <tbody>${items.slice(0, 12).map(item => `<tr class="border-b border-slate-100">
        <td class="px-3 py-2">${renderAnalyticsJobLink(item, item.title)}</td>
        <td class="px-3 py-2">${renderScoreDetails('Priority', `${item.score}%`, { explanation: item.explanation, missingSignals: item.missingSignals, action: item.recommendedAction }, 'inline', item.score >= 75 ? 'text-emerald-700' : item.score >= 55 ? 'text-amber-700' : 'text-slate-600')}</td>
        <td class="px-3 py-2 text-xs text-slate-600">${esc(item.resumeReadiness?.label || 'Review')} · ${esc(item.resumeReadiness?.score ?? '—')}%</td>
        <td class="px-3 py-2 text-xs text-slate-600">${esc(item.outreachStatus?.label || 'Review')} · ${esc(item.outreachStatus?.score ?? '—')}%</td>
        <td class="px-3 py-2 text-xs font-semibold text-slate-700">${esc(nextActionLabel(item.nextBestAction || 'review'))}</td>
      </tr>`).join('')}</tbody>
    </table></div>`;
}

function renderStaleCleanupPanel(items = []) {
  return `<p class="text-label-caps font-label-caps text-slate-500 mb-3">STALE-JOB CLEANUP</p>
    ${items.length ? `<div class="divide-y divide-slate-100">${items.slice(0, 8).map(item => `<div class="py-2">
      <div class="flex items-start justify-between gap-3">${renderAnalyticsJobLink(item, item.title)}
        <span class="text-[10px] font-bold uppercase rounded px-2 py-0.5 bg-amber-50 text-amber-700">${esc(statusDisplayLabel(item.recommendedAction || 'review'))}</span></div>
      <p class="text-[11px] text-slate-400 mt-1">${esc((item.reasons || []).join(', ') || 'Needs review')}</p>
    </div>`).join('')}</div>` : '<p class="text-sm text-slate-400">No stale, duplicate, expired, or no-response cleanup items.</p>'}`;
}

function renderCompanyResearchRows(rows = []) {
  return `<p class="text-label-caps font-label-caps text-slate-500 mb-3">COMPANY RESEARCH ENRICHMENT</p>
    ${rows.length ? `<div class="divide-y divide-slate-100">${rows.slice(0, 8).map(row => `<div class="py-2">
      <div class="flex items-center justify-between gap-3">
        <p class="text-xs font-semibold text-slate-700">${esc(row.company)}</p>
        <span class="text-[10px] font-bold rounded px-2 py-0.5 bg-slate-100 text-slate-600">${esc(row.confidence)}%</span>
      </div>
      <p class="text-[11px] text-slate-500 mt-1">${esc([row.funding, row.layoffs, row.leadership, row.productCategory].filter(Boolean).join(' · ') || 'Research signals missing')}</p>
      ${row.missingSignals?.length ? `<p class="text-[11px] text-slate-400 mt-1">Missing: ${esc(row.missingSignals.join(', '))}</p>` : ''}
    </div>`).join('')}</div>` : '<p class="text-sm text-slate-400">No company research rows yet.</p>'}`;
}

function renderResumeFeedbackPanel(rows = []) {
  return `<p class="text-label-caps font-label-caps text-slate-500 mb-3">RESUME VERSION FEEDBACK LOOPS</p>
    ${rows.length ? `<div class="overflow-x-auto"><table class="dashboard-table w-full text-sm">
      <thead><tr class="border-b border-slate-200 bg-slate-50">
        <th class="text-left px-3 py-2 text-xs font-bold text-slate-500 uppercase tracking-wide">Strategy</th>
        <th class="text-left px-3 py-2 text-xs font-bold text-slate-500 uppercase tracking-wide">Applications</th>
        <th class="text-left px-3 py-2 text-xs font-bold text-slate-500 uppercase tracking-wide">Reply Rate</th>
        <th class="text-left px-3 py-2 text-xs font-bold text-slate-500 uppercase tracking-wide">Interview Rate</th>
        <th class="text-left px-3 py-2 text-xs font-bold text-slate-500 uppercase tracking-wide">Ghosting</th>
      </tr></thead>
      <tbody>${rows.map(row => `<tr class="border-b border-slate-100">
        <td class="px-3 py-2 text-xs font-semibold text-slate-700">${esc(statusDisplayLabel(row.strategy))}</td>
        <td class="px-3 py-2 text-xs text-slate-600">${esc(row.applications)}</td>
        <td class="px-3 py-2 text-xs text-slate-600">${esc(row.replyRate)}%</td>
        <td class="px-3 py-2 text-xs text-slate-600">${esc(row.interviewRate)}%</td>
        <td class="px-3 py-2 text-xs text-slate-600">${esc(row.ghosting)}</td>
      </tr>`).join('')}</tbody>
    </table></div>` : '<p class="text-sm text-slate-400">Generate and use role-specific resumes to start measuring outcomes.</p>'}`;
}

async function renderSettingsWorkspace() {
  const countEl = document.getElementById('settings-count-label');
  if (!countEl) return;
  const pathsRoot = document.getElementById('settings-paths-root');
  const filesRoot = document.getElementById('settings-files-root');
  const healthRoot = document.getElementById('settings-health-root');
  if (!pathsRoot || !filesRoot || !healthRoot) return;
  try {
    if (!settingsHealth) {
      countEl.textContent = 'Loading local health…';
      pathsRoot.innerHTML = workspaceLoadingPanel('Loading local paths…');
      filesRoot.innerHTML = workspaceLoadingPanel('Loading file state…');
      healthRoot.innerHTML = workspaceLoadingPanel('Running health checks…');
    }
    if (!settingsHealth) settingsHealth = await fetchSettingsHealth();
    const data = settingsHealth;
    const failures = (data.checks || []).filter(check => check.status === 'FAIL').length;
    const warnings = (data.checks || []).filter(check => check.status === 'WARN').length;
    countEl.textContent = `${failures} failures · ${warnings} warnings · secrets hidden`;
    pathsRoot.innerHTML = `<p class="text-label-caps font-label-caps text-slate-500 mb-3">LOCAL PATHS</p>
      <div class="grid grid-cols-2 gap-2 text-xs">${Object.entries(data.paths || {}).map(([key, value]) => `<div class="border border-slate-100 rounded-lg p-2"><p class="font-semibold text-slate-500">${esc(statusDisplayLabel(key))}</p><p class="text-slate-700 break-all">${esc(value)}</p></div>`).join('')}</div>`;
    filesRoot.innerHTML = `<p class="text-label-caps font-label-caps text-slate-500 mb-3">CONFIG AND DATA FILES</p>
      <div class="divide-y divide-slate-100">${(data.files || []).map(file => `<div class="py-2 flex items-center justify-between gap-3">
        <div class="min-w-0"><p class="text-xs font-semibold text-slate-700">${esc(file.label)}</p><p class="text-[11px] text-slate-400 break-all">${esc(file.path)}</p></div>
        <span class="text-[10px] font-bold uppercase rounded px-2 py-0.5 ${file.present ? 'bg-emerald-50 text-emerald-700' : 'bg-rose-50 text-rose-700'}">${file.present ? 'Present' : 'Missing'}</span>
      </div>`).join('')}</div>`;
    healthRoot.innerHTML = `<p class="text-label-caps font-label-caps text-slate-500 mb-3">HEALTH CHECKS</p>
      <div class="divide-y divide-slate-100">${(data.checks || []).map(check => `<div class="py-2 flex items-start justify-between gap-3">
        <div><p class="text-xs font-semibold text-slate-700">${esc(check.name)}</p><p class="text-[11px] text-slate-500">${esc(check.message)}</p></div>
        <span class="text-[10px] font-bold uppercase rounded px-2 py-0.5 ${healthStatusClass(check.status)}">${esc(check.status)}</span>
      </div>`).join('')}</div>`;
  } catch (e) {
    countEl.textContent = 'Settings unavailable';
    pathsRoot.innerHTML = workspaceErrorPanel(e.message);
    filesRoot.innerHTML = '';
    healthRoot.innerHTML = '';
  }
}

function renderKeyValuePanel(title, values = {}) {
  return `<p class="text-label-caps font-label-caps text-slate-500 mb-3">${esc(title)}</p>
    <div class="divide-y divide-slate-100">${Object.entries(values).map(([key, value]) => `<div class="py-2 flex items-center justify-between gap-3">
      <span class="text-xs font-semibold text-slate-600">${esc(statusDisplayLabel(key))}</span>
      <span class="text-sm font-bold text-slate-800">${esc(value)}</span>
    </div>`).join('') || '<p class="text-sm text-slate-400">No data.</p>'}</div>`;
}

function workspaceMetricCard(label, value, color, explanation = null) {
  const details = explanation ? `<div class="mt-1">${renderScoreDetails(label, value, explanation, 'inline', color)}</div>` : `<p class="text-lg font-bold ${color}">${esc(value)}</p>`;
  return `<div class="bg-white border border-slate-200 rounded-lg p-3 min-h-[72px]">
    <p class="text-[10px] font-bold uppercase tracking-wide text-slate-400">${esc(label)}</p>
    ${details}
  </div>`;
}

function healthStatusClass(status) {
  if (status === 'PASS') return 'bg-emerald-50 text-emerald-700';
  if (status === 'WARN') return 'bg-amber-50 text-amber-700';
  return 'bg-rose-50 text-rose-700';
}

// ─── Rejected roles ──────────────────────────────────────────────────────────
function setupRejected() {
  document.getElementById('rej-search').addEventListener('input', debounce(renderRejected));
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
    dRow.dataset.jobId = job.id;
    dRow.innerHTML = `<td colspan="6" class="px-6 py-5 border-b border-slate-100"></td>`;

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
      const dRow = document.getElementById(tr.dataset.detailId);
      const job = jobById(dRow?.dataset.jobId);
      if (dRow && job) {
        ensureDetailRow(dRow, job, buildIntDetailPanel);
        dRow.classList.toggle('hidden');
      }
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
  const job = jobById(jobId);
  if (job) ensureDetailRow(detailRow, job, buildIntDetailPanel);
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
    const result = await patchJob(jobId, { flagged: nowFlagged });
    if (result.job) replaceJobInState(result.job);
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
    const result = await patchJob(jobId, body);
    if (result.job) replaceJobInState(result.job);
    else {
      const idx = allJobs.findIndex(j => j.id === jobId);
      if (idx !== -1) allJobs[idx] = { ...allJobs[idx], ...body };
      invalidateWorkspaceCaches();
    }
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

// ─── Home (Phase 3: Daily Command Center) ──────────────────────────────────────

const ACTION_TYPE_ICON = {
  review_opportunity: 'visibility',
  answer_question: 'help',
  generate_resume: 'description',
  review_resume: 'fact_check',
  apply: 'send',
  find_contact: 'person_search',
  follow_up: 'forum',
  prepare_interview: 'event_available',
  record_outcome: 'flag',
  send_thank_you: 'mail',
};

async function loadHome() {
  try {
    homeData = await fetchHome();
    renderHome();
  } catch (e) {
    const sub = document.getElementById('home-subtitle');
    if (sub) sub.textContent = 'Failed to load: ' + e.message;
  }
}

function actionCard(action, { compact = false } = {}) {
  const icon = ACTION_TYPE_ICON[action.type] || 'task_alt';
  return `<div class="action-card border border-slate-200 rounded-lg p-3 flex items-start gap-3 ${compact ? '' : 'bg-slate-50'}" data-action-id="${esc(action.id)}" data-opportunity-id="${esc(action.opportunityId)}" data-action-type="${esc(action.type)}">
    <span class="material-symbols-outlined text-slate-400 text-xl mt-0.5">${icon}</span>
    <div class="min-w-0 flex-1">
      <p class="text-sm font-semibold text-on-surface truncate">${esc(action.title)}</p>
      <p class="text-xs text-slate-500 mt-0.5">${esc(action.reason || '')}</p>
    </div>
    <button class="action-complete-btn shrink-0 text-xs font-semibold text-blue-600 hover:underline px-2 py-1" data-id="${esc(action.id)}" data-opp="${esc(action.opportunityId)}" data-type="${esc(action.type)}">
      Continue
    </button>
  </div>`;
}

// Phase 4: which Opportunity Workspace tab a given action type is "about" —
// so a Command Center action opens straight to the relevant tab instead of
// always landing on Overview.
const ACTION_TYPE_TAB = {
  review_opportunity: 'overview',
  answer_question: 'fit',
  generate_resume: 'resume',
  review_resume: 'resume',
  apply: 'application',
  find_contact: 'contacts',
  follow_up: 'application',
  prepare_interview: 'interview',
  record_outcome: 'activity',
  send_thank_you: 'interview',
};

function topPriorityCard(action) {
  if (!action) return '';
  return `<div class="bg-white p-5 rounded-xl border-2 border-blue-200 shadow-sm">
    <p class="text-label-caps font-label-caps text-blue-600 mb-2">DO THIS FIRST</p>
    <p class="text-h2 font-h2 text-on-surface mb-1">${esc(action.title)}</p>
    <p class="text-sm text-slate-500 mb-4">${esc(action.reason || '')}</p>
    <button id="home-top-priority-btn" class="flex items-center gap-1.5 bg-primary text-white text-sm font-semibold px-4 py-2 rounded-lg hover:opacity-90 transition-opacity"
      data-id="${esc(action.id)}" data-opp="${esc(action.opportunityId)}" data-type="${esc(action.type)}">
      Continue
      <span class="material-symbols-outlined text-lg">arrow_forward</span>
    </button>
  </div>`;
}

function pipelineStatTile(label, value) {
  return `<div class="bg-slate-50 rounded-lg p-3 text-center">
    <p class="text-h2 font-h2 text-on-surface">${value}</p>
    <p class="text-xs text-slate-500 uppercase tracking-wide">${esc(label)}</p>
  </div>`;
}

function renderHome() {
  if (!homeData) return;
  const sub = document.getElementById('home-subtitle');
  const caughtUpPanel = document.getElementById('home-caught-up');
  const content = document.getElementById('home-content');

  if (homeData.caughtUp) {
    if (sub) sub.textContent = "Nothing urgent right now.";
    caughtUpPanel.classList.remove('hidden');
    content.classList.add('hidden');
    return;
  }
  caughtUpPanel.classList.add('hidden');
  content.classList.remove('hidden');
  if (sub) sub.textContent = `${homeData.startMyDayQueue.length} thing${homeData.startMyDayQueue.length === 1 ? '' : 's'} to work through today.`;

  document.getElementById('home-top-priority-wrap').innerHTML = topPriorityCard(homeData.topPriority);

  const nextList = document.getElementById('home-next-list');
  nextList.innerHTML = homeData.next.length
    ? homeData.next.map(a => actionCard(a, { compact: true })).join('')
    : `<p class="text-sm text-slate-400">Nothing else queued.</p>`;

  const followUpsList = document.getElementById('home-followups-list');
  followUpsList.innerHTML = homeData.followUps.length
    ? homeData.followUps.map(a => actionCard(a, { compact: true })).join('')
    : `<p class="text-sm text-slate-400">No follow-ups due.</p>`;

  const { discovered, qualified, worthReviewing } = homeData.newOpportunities;
  document.getElementById('home-new-opportunities-text').textContent =
    `${discovered} discovered · ${qualified} qualified · ${worthReviewing} worth reviewing`;

  const snap = homeData.pipelineSnapshot;
  document.getElementById('home-pipeline-snapshot').innerHTML = [
    pipelineStatTile('Applied', snap.applied),
    pipelineStatTile('Recruiter Screens', snap.recruiterScreens),
    pipelineStatTile('Interviews', snap.interviews),
    pipelineStatTile('Offers', snap.offers),
  ].join('');
}

async function completeActionFromHome(id, opportunityId, type) {
  await postActionDecision(id, 'complete');
  await loadHome();
  if (opportunityId) showJobDetail(opportunityId, { tab: ACTION_TYPE_TAB[type] || 'overview' });
}

function setupHome() {
  document.getElementById('home-content')?.addEventListener('click', async (e) => {
    const btn = e.target.closest('.action-complete-btn, #home-top-priority-btn');
    if (!btn) return;
    await completeActionFromHome(btn.dataset.id, btn.dataset.opp, btn.dataset.type);
  });

  document.getElementById('home-review-btn')?.addEventListener('click', () => showView('dashboard'));
  document.getElementById('home-caught-up')?.querySelector('.home-review-new-btn')
    ?.addEventListener('click', () => showView('dashboard'));

  document.getElementById('start-my-day-btn')?.addEventListener('click', startMyDay);
  document.getElementById('start-day-close')?.addEventListener('click', closeStartMyDay);
  document.getElementById('start-day-backdrop')?.addEventListener('click', closeStartMyDay);
  document.getElementById('start-day-skip')?.addEventListener('click', () => advanceStartMyDay('skip'));
  document.getElementById('start-day-snooze')?.addEventListener('click', () => advanceStartMyDay('snooze'));
  document.getElementById('start-day-continue')?.addEventListener('click', () => advanceStartMyDay('complete'));
  document.getElementById('start-day-quick-decisions')?.addEventListener('click', async (e) => {
    const btn = e.target.closest('.quick-decision-btn');
    if (!btn) return;
    const current = startDayQueue[startDayIndex];
    if (current) await postQuickDecision(current.opportunityId, btn.dataset.decision);
    await advanceStartMyDay(null);
  });
}

function startMyDay() {
  startDayQueue = (homeData?.startMyDayQueue || []).slice();
  startDayIndex = 0;
  if (!startDayQueue.length) return;
  document.getElementById('start-day-modal').classList.remove('hidden');
  renderStartMyDayStep();
}

function closeStartMyDay() {
  document.getElementById('start-day-modal').classList.add('hidden');
  loadHome();
}

function renderStartMyDayStep() {
  const total = startDayQueue.length;
  const action = startDayQueue[startDayIndex];
  if (!action) { closeStartMyDay(); return; }
  document.getElementById('start-day-progress').textContent = `Task ${startDayIndex + 1} of ${total}`;
  document.getElementById('start-day-title').textContent = action.title;
  document.getElementById('start-day-reason').textContent = action.reason || '';
  document.getElementById('start-day-quick-decisions').classList.toggle('hidden', action.type !== 'review_opportunity');
  document.getElementById('start-day-continue').classList.toggle('hidden', action.type === 'review_opportunity');
}

async function advanceStartMyDay(decision) {
  const action = startDayQueue[startDayIndex];
  try {
    if (decision && action) await postActionDecision(action.id, decision);
  } catch { /* keep moving even if the decision call fails */ }
  startDayIndex += 1;
  if (startDayIndex >= startDayQueue.length) {
    closeStartMyDay();
    return;
  }
  renderStartMyDayStep();
}

// ─── Phase 5: Career Evidence Vault ────────────────────────────────────────
// UI over the Phase 0 canonical candidate fact files (data/candidate/*.json)
// via lib/evidence-vault.mjs — never a second candidate database, and never
// silently flips verified/allowed_in_resume; both are explicit checkboxes
// the person sets themselves on add/edit.
const SECTION_CATEGORY = {
  experience: 'employer',
  achievements: 'achievement',
  skills: 'skill',
  certifications: 'certification',
  metrics: 'metric',
  stories: 'story',
};
const SECTION_LABEL = {
  experience: 'Experience',
  achievements: 'Achievement',
  skills: 'Skill',
  certifications: 'Certification',
  metrics: 'Metric',
  stories: 'Story',
};
let editingVaultId = null;

async function loadVault() {
  try {
    vaultData = await fetchEvidenceVault();
    renderVaultView();
  } catch (e) {
    const root = document.getElementById('vault-content-root');
    if (root) root.innerHTML = `<div class="text-sm text-rose-600">${esc(e.message)}</div>`;
  }
}

function vaultFieldSchema(category) {
  if (category === 'story') {
    return [
      { key: 'situation', label: 'Situation', type: 'textarea' },
      { key: 'task', label: 'Task', type: 'textarea' },
      { key: 'action', label: 'Action', type: 'textarea' },
      { key: 'result', label: 'Result', type: 'textarea' },
      { key: 'employer', label: 'Employer / Context', type: 'text' },
      { key: 'source', label: 'Source', type: 'text' },
      { key: 'tags', label: 'Tags (comma separated)', type: 'tags' },
      { key: 'verified', label: 'Verified', type: 'checkbox' },
    ];
  }
  const fields = [
    { key: 'fact', label: category === 'skill' ? 'Skill' : 'Fact', type: 'textarea' },
    { key: 'employer', label: 'Employer / Context', type: 'text' },
    { key: 'source', label: 'Source', type: 'text' },
    { key: 'tags', label: 'Tags (comma separated)', type: 'tags' },
    { key: 'verified', label: 'Verified', type: 'checkbox' },
    { key: 'allowed_in_resume', label: 'Allowed in resume', type: 'checkbox' },
  ];
  if (category === 'skill') {
    fields.push(
      { key: 'evidence', label: 'Evidence', type: 'text' },
      { key: 'experienceDepth', label: 'Experience / Depth', type: 'text' },
      { key: 'lastUsed', label: 'Last used', type: 'text' },
    );
  }
  return fields;
}

function renderVaultFieldInputs(category, record = {}) {
  return vaultFieldSchema(category).map(f => {
    const val = record[f.key];
    if (f.type === 'checkbox') {
      return `<label class="flex items-center gap-2 text-xs text-slate-600 mb-2">
        <input type="checkbox" class="vault-field" data-field="${f.key}" ${val ? 'checked' : ''}> ${esc(f.label)}
      </label>`;
    }
    if (f.type === 'textarea') {
      return `<label class="block text-xs text-slate-500 mb-2">${esc(f.label)}
        <textarea class="vault-field mt-1 w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-xs outline-none focus:ring-2 focus:ring-blue-600/20" rows="2" data-field="${f.key}">${esc(val || '')}</textarea>
      </label>`;
    }
    if (f.type === 'tags') {
      const joined = Array.isArray(val) ? val.join(', ') : '';
      return `<label class="block text-xs text-slate-500 mb-2">${esc(f.label)}
        <input class="vault-field mt-1 w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-xs outline-none focus:ring-2 focus:ring-blue-600/20" data-field="${f.key}" value="${esc(joined)}">
      </label>`;
    }
    return `<label class="block text-xs text-slate-500 mb-2">${esc(f.label)}
      <input class="vault-field mt-1 w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-xs outline-none focus:ring-2 focus:ring-blue-600/20" data-field="${f.key}" value="${esc(val || '')}">
    </label>`;
  }).join('');
}

function collectVaultFieldValues(root, category) {
  const out = {};
  vaultFieldSchema(category).forEach(f => {
    const el = root.querySelector(`[data-field="${f.key}"]`);
    if (!el) return;
    if (f.type === 'checkbox') out[f.key] = el.checked;
    else if (f.type === 'tags') out[f.key] = el.value.split(',').map(s => s.trim()).filter(Boolean);
    else out[f.key] = el.value.trim();
  });
  return out;
}

function vaultVerifiedBadge(verified) {
  return `<span class="text-[10px] font-bold uppercase rounded px-1.5 py-0.5 ${verified ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700'}">${verified ? 'Verified' : 'Unverified'}</span>`;
}

function vaultResumeBadge(allowed) {
  return `<span class="text-[10px] font-bold uppercase rounded px-1.5 py-0.5 ${allowed ? 'bg-blue-50 text-blue-700' : 'bg-slate-100 text-slate-500'}">${allowed ? 'Allowed' : 'Not allowed'}</span>`;
}

function vaultTagsHtml(tags) {
  return (tags || []).map(t => `<span class="text-[10px] bg-slate-100 text-slate-600 rounded px-1.5 py-0.5 mr-1 inline-block mb-1">${esc(t)}</span>`).join('') || '<span class="text-slate-300 text-xs">—</span>';
}

function vaultEditFieldsBlock(section, record) {
  const category = SECTION_CATEGORY[section];
  return `${renderVaultFieldInputs(category, record)}
    <div class="flex items-center gap-2 mt-2">
      <button class="vault-save-btn bg-primary text-white text-xs font-semibold rounded-lg px-3 py-1.5 hover:opacity-90" data-id="${esc(record.id)}">Save</button>
      <button class="vault-cancel-btn text-xs font-semibold text-slate-500 border border-slate-200 rounded-lg px-3 py-1.5 hover:bg-slate-50">Cancel</button>
    </div>
    <p class="vault-edit-error hidden text-xs text-rose-600 mt-2"></p>`;
}

function vaultDisplayRow(section, record) {
  const category = SECTION_CATEGORY[section];
  let title = esc(record.fact || '');
  if (category === 'skill') {
    const extra = [];
    if (record.experienceDepth) extra.push(`Depth: ${record.experienceDepth}`);
    if (record.lastUsed) extra.push(`Last used: ${record.lastUsed}`);
    if (record.evidence) extra.push(`Evidence: ${record.evidence}`);
    if (extra.length) title += `<div class="text-[11px] text-slate-400 mt-1">${esc(extra.join(' · '))}</div>`;
  }
  return `<tr class="border-b border-slate-100 align-top" data-record-id="${esc(record.id)}">
    <td class="px-3 py-2 text-slate-700 max-w-sm">${title}</td>
    <td class="px-3 py-2 text-slate-500">${esc(record.employer || '—')}</td>
    <td class="px-3 py-2">${vaultVerifiedBadge(record.verified)}</td>
    <td class="px-3 py-2 text-slate-400 text-[11px] max-w-[160px] truncate">${esc(record.source || '—')}</td>
    <td class="px-3 py-2">${vaultResumeBadge(record.allowed_in_resume)}</td>
    <td class="px-3 py-2">${vaultTagsHtml(record.tags)}</td>
    <td class="px-3 py-2"><button class="vault-edit-btn text-xs font-semibold text-blue-600 hover:underline" data-id="${esc(record.id)}">Edit</button></td>
  </tr>`;
}

function renderVaultFactTable(section, records) {
  const category = SECTION_CATEGORY[section];
  if (!records.length) return `<div class="bg-white rounded-xl border border-slate-200 shadow-sm p-6 text-sm text-slate-400">No records yet.</div>`;
  return `<div class="bg-white rounded-xl border border-slate-200 shadow-sm overflow-x-auto">
    <table class="w-full text-xs">
      <thead><tr class="border-b border-slate-200 bg-slate-50">
        <th class="text-left px-3 py-2 font-bold text-slate-500 uppercase tracking-wide">${category === 'skill' ? 'Skill' : 'Fact'}</th>
        <th class="text-left px-3 py-2 font-bold text-slate-500 uppercase tracking-wide">Employer / Context</th>
        <th class="text-left px-3 py-2 font-bold text-slate-500 uppercase tracking-wide">Verified</th>
        <th class="text-left px-3 py-2 font-bold text-slate-500 uppercase tracking-wide">Source</th>
        <th class="text-left px-3 py-2 font-bold text-slate-500 uppercase tracking-wide">Resume</th>
        <th class="text-left px-3 py-2 font-bold text-slate-500 uppercase tracking-wide">Tags</th>
        <th></th>
      </tr></thead>
      <tbody>${records.map(r => r.id === editingVaultId
        ? `<tr data-record-id="${esc(r.id)}"><td colspan="7" class="px-3 py-3 bg-slate-50">${vaultEditFieldsBlock(section, r)}</td></tr>`
        : vaultDisplayRow(section, r)).join('')}</tbody>
    </table>
  </div>`;
}

function vaultStoryField(label, value) {
  return `<div class="mb-2"><p class="text-[10px] font-bold uppercase tracking-wide text-slate-400">${esc(label)}</p><p class="text-xs text-slate-700 whitespace-pre-wrap">${esc(value || '—')}</p></div>`;
}

function renderVaultStories(records) {
  if (!records.length) return `<div class="bg-white rounded-xl border border-slate-200 shadow-sm p-6 text-sm text-slate-400">No stories yet. Add one to capture a STAR example for interview prep.</div>`;
  return `<div class="space-y-3">${records.map(r => `<div class="bg-white rounded-xl border border-slate-200 shadow-sm p-4" data-record-id="${esc(r.id)}">
    ${r.id === editingVaultId ? vaultEditFieldsBlock('stories', r) : `
      <div class="flex items-center justify-between gap-2 mb-2">
        ${vaultVerifiedBadge(r.verified)}
        <button class="vault-edit-btn text-xs font-semibold text-blue-600 hover:underline" data-id="${esc(r.id)}">Edit</button>
      </div>
      ${vaultStoryField('Situation', r.situation)}
      ${vaultStoryField('Task', r.task)}
      ${vaultStoryField('Action', r.action)}
      ${vaultStoryField('Result', r.result)}
      <div class="flex flex-wrap gap-1 mt-2">${vaultTagsHtml(r.tags)}</div>
    `}
  </div>`).join('')}</div>`;
}

function renderVaultTabContent() {
  const root = document.getElementById('vault-content-root');
  if (!root || !vaultData) return;
  const records = vaultData[currentVaultTab] || [];
  root.innerHTML = currentVaultTab === 'stories' ? renderVaultStories(records) : renderVaultFactTable(currentVaultTab, records);
  bindVaultRowActions(root);
}

function renderVaultView() {
  document.querySelectorAll('.vault-tab-btn').forEach(btn => {
    const active = btn.dataset.vaultTab === currentVaultTab;
    btn.className = `vault-tab-btn text-xs font-semibold px-3 py-2 border-b-2 ${active ? 'border-primary text-primary' : 'border-transparent text-slate-500 hover:text-slate-700'}`;
  });
  renderVaultTabContent();
}

function bindVaultRowActions(root) {
  root.querySelectorAll('.vault-edit-btn').forEach(btn => btn.addEventListener('click', () => {
    editingVaultId = btn.dataset.id;
    renderVaultTabContent();
  }));
  root.querySelectorAll('.vault-cancel-btn').forEach(btn => btn.addEventListener('click', () => {
    editingVaultId = null;
    renderVaultTabContent();
  }));
  root.querySelectorAll('.vault-save-btn').forEach(btn => btn.addEventListener('click', () => submitVaultEdit(btn)));
}

async function submitVaultEdit(btn) {
  const id = btn.dataset.id;
  const category = SECTION_CATEGORY[currentVaultTab];
  const wrap = btn.closest('[data-record-id]');
  const errorEl = wrap?.querySelector('.vault-edit-error');
  errorEl?.classList.add('hidden');
  try {
    const fields = collectVaultFieldValues(wrap, category);
    await updateEvidenceFact(category, id, fields);
    editingVaultId = null;
    await loadVault();
  } catch (e) {
    if (errorEl) { errorEl.textContent = e.message; errorEl.classList.remove('hidden'); }
  }
}

function renderVaultAddForm(section) {
  const category = SECTION_CATEGORY[section];
  return `<div class="bg-white rounded-xl border border-slate-200 shadow-sm p-4 mb-4" data-add-form>
    <p class="text-label-caps font-label-caps text-slate-500 mb-3">ADD ${esc(SECTION_LABEL[section].toUpperCase())}</p>
    ${renderVaultFieldInputs(category)}
    <div class="flex items-center gap-2 mt-2">
      <button class="vault-add-save bg-primary text-white text-xs font-semibold rounded-lg px-3 py-1.5 hover:opacity-90">Save</button>
      <button class="vault-add-cancel text-xs font-semibold text-slate-500 border border-slate-200 rounded-lg px-3 py-1.5 hover:bg-slate-50">Cancel</button>
    </div>
    <p class="vault-add-error hidden text-xs text-rose-600 mt-2"></p>
  </div>`;
}

function bindVaultAddForm(root) {
  root.querySelector('.vault-add-cancel')?.addEventListener('click', () => { root.innerHTML = ''; });
  root.querySelector('.vault-add-save')?.addEventListener('click', async () => {
    const category = SECTION_CATEGORY[currentVaultTab];
    const errorEl = root.querySelector('.vault-add-error');
    errorEl?.classList.add('hidden');
    try {
      const fields = collectVaultFieldValues(root, category);
      await addEvidenceFact(category, fields);
      root.innerHTML = '';
      await loadVault();
    } catch (e) {
      if (errorEl) { errorEl.textContent = e.message; errorEl.classList.remove('hidden'); }
    }
  });
}

function setupVault() {
  document.getElementById('vault-add-btn')?.addEventListener('click', () => {
    const formRoot = document.getElementById('vault-add-form-root');
    if (!formRoot) return;
    if (formRoot.innerHTML.trim()) { formRoot.innerHTML = ''; return; }
    formRoot.innerHTML = renderVaultAddForm(currentVaultTab);
    bindVaultAddForm(formRoot);
  });
  document.querySelectorAll('.vault-tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      currentVaultTab = btn.dataset.vaultTab;
      editingVaultId = null;
      const formRoot = document.getElementById('vault-add-form-root');
      if (formRoot) formRoot.innerHTML = '';
      renderVaultView();
    });
  });
}

// ─── Start ────────────────────────────────────────────────────────────────────
showView(viewFromPath(), { push: false });
init();
