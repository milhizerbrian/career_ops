import {
  attachGmailAmbiguity,
  createDocs,
  deleteJobRequest,
  dismissGmailAmbiguity,
  evaluateUrl,
  fetchAmbiguousGmailJobs,
  fetchDashboard,
  generateContactOutreachDraft,
  patchJob,
  postWorkflowEvent,
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

function isRejectedJob(job) {
  return (job?.status || '').toLowerCase() === 'rejected';
}

function visibleDashboardJobs(jobs) {
  return jobs.filter(job => !isRejectedJob(job));
}

// ─── Boot ─────────────────────────────────────────────────────────────────────
async function init() {
  try {
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
  } catch (e) {
    document.getElementById('dash-subtitle').textContent = 'Failed to load: ' + e.message;
  }
}

// ─── Navigation ───────────────────────────────────────────────────────────────
const VIEWS = ['dashboard', 'gmail-review', 'interviews', 'rejected'];

function showView(name) {
  VIEWS.forEach(v => {
    document.getElementById('view-' + v).hidden = (v !== name);
  });
  document.querySelectorAll('.nav-btn').forEach(btn => {
    const active = btn.dataset.view === name;
    btn.className = 'nav-btn w-full flex items-center gap-3 px-3 py-2 rounded-lg transition-all text-sm font-medium '
      + (active ? 'nav-active' : 'nav-inactive');
  });
}

document.querySelectorAll('.nav-btn').forEach(btn => {
  btn.addEventListener('click', () => showView(btn.dataset.view));
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
  const scored       = activeJobs.filter(j => j.score != null);
  const avgAts       = scored.length
    ? Math.round(scored.reduce((s,j) => s + j.score, 0) / scored.length * 20) : 0;
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
  const kpis = computeKPIs(allJobs);
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

  document.getElementById('kpi-grid').innerHTML = [
    kpiCard('rocket_launch', 'bg-blue-50',   'text-blue-600',   'TOTAL LEADS',   kpis.total),
    kpiCard('forum',         'bg-purple-50', 'text-purple-600', 'INTERVIEWS',     kpis.interviews),
    kpiCard('analytics',     'bg-amber-50',  'text-amber-600',  'AVG ATS SCORE',  kpis.avgAts + '%'),
    kpiCard('show_chart',    'bg-rose-50',   'text-rose-600',   'RESPONSE RATE',  kpis.responseRate + '%'),
  ].join('');

  renderWorkflowSummary();
  renderPipelineBreakdown();
  renderGmailAmbiguities();
}

function renderWorkflowSummary() {
  const grid = document.getElementById('workflow-summary-grid');
  if (!grid) return;
  const counts = buildHealthSummaryCounts();
  const items = [
    ['urgent_followups', 'priority_high', 'bg-rose-50', 'text-rose-600', 'URGENT FOLLOW-UPS', counts.urgentFollowUps],
    ['stale_leads', 'schedule', 'bg-amber-50', 'text-amber-600', 'STALE LEADS', counts.staleLeads],
    ['gmail_ambiguity', 'mark_email_unread', 'bg-amber-50', 'text-amber-700', 'GMAIL REVIEW', counts.ambiguousGmailMatches],
    ['needs_resume', 'description', 'bg-blue-50', 'text-blue-600', 'NEEDS RESUME', counts.jobsNeedingResume],
    ['ready_apply', 'send', 'bg-emerald-50', 'text-emerald-600', 'READY TO APPLY', counts.jobsReadyToApply],
    ['prep_interview', 'event_available', 'bg-purple-50', 'text-purple-600', 'INTERVIEW PREP', counts.interviewsPrepNeeded],
  ];
  grid.innerHTML = items.map(([filter, icon, bg, color, label, value]) => {
    const active = activeHealthFilter === filter;
    return `<button class="health-summary-card text-left bg-white border ${active ? 'border-blue-300 ring-2 ring-blue-600/10' : 'border-slate-200'} rounded-xl shadow-sm p-3 flex items-center gap-3 hover:bg-slate-50 transition-colors"
      data-filter="${filter}" type="button">
      <span class="w-9 h-9 rounded-lg ${bg} ${color} flex items-center justify-center shrink-0">
        <span class="material-symbols-outlined text-xl">${icon}</span>
      </span>
      <div class="min-w-0">
        <p class="text-[10px] font-bold uppercase tracking-wide text-slate-400">${label}</p>
        <p class="text-lg font-bold text-slate-800">${value}</p>
      </div>
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
      const label = select.closest('[data-thread-id]')?.querySelector('.gmail-selected-job-label');
      const selectedText = select.selectedOptions?.[0]?.textContent || 'No candidate selected';
      if (label) label.textContent = selectedText.replace(/\s*\(\d+%\)\s*$/, '');
    });
  });
}

function renderGmailAmbiguityCard(item) {
  const threadId = item.thread_id || '';
  const candidates = Array.isArray(item.matchCandidates) ? item.matchCandidates : [];
  const selected = candidates[0] || null;
  const emailDate = item.last_email_date
    ? new Date(item.last_email_date).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    : 'Unknown time';
  const candidateRows = candidates.length
    ? candidates.map(c => `<div class="text-[11px] text-slate-500">
        <span class="font-semibold text-slate-700">${esc(c.company || '')}</span>
        ${esc(c.title || '')}
        <span class="text-slate-400">· ${formatConfidence(c.confidence)} · ${(c.matchedBy || []).map(esc).join(', ')}</span>
      </div>`).join('')
    : '<div class="text-[11px] text-slate-400">No candidates available.</div>';
  const options = candidates.map(c => {
    const label = `${c.company || 'Unknown'} — ${c.title || 'Unknown'} (${formatConfidence(c.confidence)})`;
    return `<option value="${esc(c.id)}">${esc(label)}</option>`;
  }).join('');
  const selectedLabel = selected
    ? `${selected.company || 'Unknown'} — ${selected.title || 'Unknown'}`
    : 'No candidate selected';

  return `<div class="border border-slate-200 rounded-lg p-3" data-thread-id="${esc(threadId)}">
    <div class="grid grid-cols-1 xl:grid-cols-[minmax(0,1.1fr)_minmax(280px,0.9fr)_220px] gap-4 items-start">
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
          Save subject, sender context, email date, snippet, confidence, and manual resolution metadata.
        </p>
        <p class="text-[11px] text-slate-400 mt-2">Job status will not change automatically.</p>
        <div class="mt-2 space-y-0.5">${candidateRows}</div>
        <p class="gmail-ambiguity-error hidden text-xs text-rose-600 mt-2"></p>
      </div>
      <div class="flex flex-col gap-2">
        <p class="text-[10px] font-bold uppercase tracking-wide text-slate-400">Decision</p>
        <select class="gmail-candidate-select border border-slate-200 rounded-lg px-3 py-2 text-xs bg-white text-slate-700 outline-none focus:ring-2 focus:ring-blue-600/20" ${candidates.length ? '' : 'disabled'}>
          ${options}
        </select>
        <div class="grid grid-cols-2 gap-2">
          <button class="gmail-attach-btn bg-primary text-white text-xs font-semibold px-3 py-2 rounded-lg hover:opacity-90 disabled:opacity-50" ${candidates.length ? '' : 'disabled'}>Approve</button>
          <button class="gmail-dismiss-btn text-xs font-semibold text-slate-600 border border-slate-200 px-3 py-2 rounded-lg hover:bg-slate-50">Decline</button>
        </div>
      </div>
    </div>
  </div>`;
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
    const { barColor } = statusStyle(status);
    return `<div class="flex-1 min-w-[90px] max-w-[160px]">
      <div class="flex justify-between text-xs mb-1">
        <span class="text-slate-600 font-medium truncate">${esc(statusDisplayLabel(status))}</span>
        <span class="text-slate-400 ml-1 shrink-0">${count}</span>
      </div>
      <div class="h-1.5 bg-slate-100 rounded-full overflow-hidden">
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
  document.getElementById('opp-clear-btn').addEventListener('click',       clearOppFilters);

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
  document.getElementById('opp-status-filter').value = '';
  document.getElementById('opp-score-filter').value  = '';
  document.getElementById('opp-source-filter').value = '';
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
  const COLS = ['company','score','status','location','date_updated'];
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

  const hasFilter = q || statusF || scoreF || sourceF || activeHealthFilter || oppSort.col !== 'date_updated';
  document.getElementById('opp-clear-btn').classList.toggle('hidden', !hasFilter);

  const dashboardJobs = visibleDashboardJobs(allJobs);
  let filtered = dashboardJobs.filter(j => {
    const haystack = ((j.company||'') + ' ' + (j.title||'')).toLowerCase();
    if (q       && !haystack.includes(q))    return false;
    if (statusF && j.status  !== statusF)     return false;
    if (sourceF && normalizeSource(j.source) !== sourceF) return false;
    if (!matchesHealthFilter(j)) return false;
    if (scoreF) {
      const pct = j.score != null ? j.score * 20 : null;
      if (scoreF === 'high' && (pct == null || pct < 80))              return false;
      if (scoreF === 'mid'  && (pct == null || pct < 50 || pct >= 80)) return false;
      if (scoreF === 'low'  && (pct == null || pct >= 50))             return false;
    }
    return true;
  });

  filtered = sortJobsBy(filtered, oppSort.col, oppSort.dir, STATUS_ORDER);

  document.getElementById('opp-count-label').textContent = `${filtered.length} of ${dashboardJobs.length} active jobs`;
  document.getElementById('opp-empty').classList.toggle('hidden', filtered.length > 0);

  const tbody = document.getElementById('opp-tbody');
  tbody.innerHTML = '';

  filtered.forEach(job => {
    const pct    = job.score != null ? Math.round(job.score * 20) : null;
    const atsStr = pct != null ? pct + '%' : '—';
    const atsColor = pct == null ? 'text-slate-400'
                   : pct >= 80  ? 'text-emerald-600'
                   : pct >= 50  ? 'text-amber-600'
                   : 'text-rose-600';
    const detailId = 'detail-' + job.id;

    const tr = document.createElement('tr');
    tr.className = 'border-b border-slate-100 hover:bg-slate-50 transition-colors cursor-pointer';
    tr.dataset.detailId = detailId;
    tr.innerHTML = `
      <td class="px-4 py-3">
        <div class="flex items-center gap-3">
          <div class="w-8 h-8 rounded-lg bg-surface-container-high flex items-center justify-center text-xs font-bold text-slate-600 shrink-0">
            ${esc((job.company||'?').slice(0,2).toUpperCase())}
          </div>
          <div class="min-w-0">
            <p class="font-semibold text-on-surface truncate max-w-xs">${esc(job.company)}</p>
            <p class="text-xs text-slate-500 truncate max-w-xs">${esc(job.title)}</p>
            <span class="inline-block mt-0.5 px-1.5 py-px rounded text-[10px] font-semibold uppercase tracking-wide ${sourceBadgeCls(job.source)}">${esc(sourceDisplayLabel(job.source))}</span>
          </div>
        </div>
      </td>
      <td class="px-4 py-3 hidden md:table-cell">
        <span class="font-bold ${atsColor}">${atsStr}</span>
      </td>
      <td class="px-4 py-3">${statusBadge(job.status)}</td>
      <td class="px-4 py-3 text-xs text-slate-500 hidden lg:table-cell">${esc(job.location||'—')}</td>
      <td class="px-4 py-3 text-xs text-slate-400 hidden md:table-cell">${fmtDate(job.date_updated)}</td>
      <td class="px-4 py-3">
        <div class="flex items-center gap-2">
          <button class="gen-btn px-3 py-1.5 bg-primary text-white text-xs font-bold rounded-lg hover:opacity-90 transition-opacity"
            data-id="${esc(job.id)}">Generate</button>
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
    dRow.innerHTML = `<td colspan="6" class="px-6 py-4 border-b border-slate-100">${buildDetailPanel(job)}</td>`;

    const pRow = document.createElement('tr');
    pRow.id = 'opp-prog-' + job.id;
    pRow.className = 'hidden';
    pRow.innerHTML = `<td colspan="6" class="px-6 pb-4 bg-slate-50/50">
      <div class="stage-log text-xs space-y-0.5 font-mono mt-1"></div>
      <div class="downloads mt-2 flex gap-4 text-xs"></div>
    </td>`;

    tbody.appendChild(tr);
    tbody.appendChild(dRow);
    tbody.appendChild(pRow);
  });

  // Row click → toggle detail; ignore clicks on action buttons
  tbody.querySelectorAll('tr[data-detail-id]').forEach(tr => {
    tr.addEventListener('click', e => {
      if (e.target.closest('.gen-btn') || e.target.closest('.edit-btn') || e.target.closest('.del-btn')) return;
      const dRow = document.getElementById(tr.dataset.detailId);
      if (dRow) dRow.classList.toggle('hidden');
    });
  });

  tbody.querySelectorAll('.gen-btn').forEach(btn => {
    btn.addEventListener('click', () => triggerGenerate(btn.dataset.id, btn));
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
        const as = a.score ?? -1, bs = b.score ?? -1;
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
    const pct      = job.score != null ? Math.round(job.score * 20) : null;
    const atsColor = pct == null ? 'text-slate-400' : pct >= 80 ? 'text-emerald-600' : pct >= 50 ? 'text-amber-600' : 'text-rose-600';
    const atsStr   = pct != null ? pct + '%' : '—';
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
          </div>
        </div>
      </td>
      <td class="px-4 py-3">
        ${statusBadge(job.status)}
        ${latestNoteText(job.notes) ? `<p class="text-xs text-slate-400 truncate max-w-[220px] mt-1">${esc(latestNoteText(job.notes))}</p>` : ''}
      </td>
      <td class="px-4 py-3 hidden md:table-cell"><span class="font-bold ${atsColor}">${atsStr}</span></td>
      <td class="px-4 py-3 text-xs text-slate-500 hidden lg:table-cell">${esc(job.location||'—')}</td>
      <td class="px-4 py-3 text-xs text-slate-400 hidden md:table-cell">${fmtDate(job.date_updated)}</td>
      <td class="px-4 py-3">
        <div class="flex items-center gap-2">
          <button class="int-gen-btn px-3 py-1.5 bg-primary text-white text-xs font-bold rounded-lg hover:opacity-90 transition-opacity"
            data-id="${esc(job.id)}">Generate</button>
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
      if (e.target.closest('.int-gen-btn') || e.target.closest('.int-edit-btn')) return;
      document.getElementById(tr.dataset.detailId)?.classList.toggle('hidden');
    });
  });

  tbody.querySelectorAll('.int-gen-btn').forEach(btn => {
    btn.addEventListener('click', () => triggerGenerate(btn.dataset.id, btn));
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
}

function renderAllViews() {
  renderDashboard();
  applyOppFilters();
  renderInterviews();
  renderRejected();
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
        const as = a.score ?? -1, bs = b.score ?? -1;
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
    const pct      = job.score != null ? Math.round(job.score * 20) : null;
    const atsColor = pct == null ? 'text-slate-400' : pct >= 80 ? 'text-emerald-600' : pct >= 50 ? 'text-amber-600' : 'text-rose-600';
    const atsStr   = pct != null ? pct + '%' : '—';
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
  const first = notesStr.split('\n').find(l => l.trim());
  if (!first) return '';
  const m = first.match(/^\d{4}-\d{2}-\d{2}:\s*(.*)/);
  return m ? m[1].trim() : first.trim();
}

function renderNotesLog(notesStr) {
  if (!notesStr || !notesStr.trim()) return '';
  return notesStr.split('\n').filter(l => l.trim()).map(line => {
    const m = line.match(/^(\d{4}-\d{2}-\d{2}):\s*(.*)/);
    if (m) return `<div class="py-1 text-xs text-slate-600"><span class="text-blue-500 font-semibold mr-1">${esc(m[1])}</span>${esc(m[2])}</div>`;
    return `<div class="py-1 text-xs text-slate-600">${esc(line)}</div>`;
  }).join('');
}

// ─── Job deletion ────────────────────────────────────────────────────────────
async function deleteJob(jobId) {
  if (!confirm('Remove this job from the tracker?')) return;
  try {
    await deleteJobRequest(jobId);
    allJobs = allJobs.filter(j => j.id !== jobId);
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
async function triggerGenerate(jobId, btn) {
  btn.disabled = true;
  btn.textContent = 'Generating…';

  showProgSection('opp-prog-' + jobId);
  showProgSection('int-prog-' + jobId);
  showProgSection('rej-prog-' + jobId);

  try {
    await createDocs(jobId);
  } catch (e) {
    appendLog(jobId, 'error', (e.response ? 'Server error: ' : 'Network error: ') + e.message);
    resetBtn(jobId);
  }
}

function showProgSection(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.remove('hidden');
  const log = el.querySelector('.stage-log');
  const dl  = el.querySelector('.downloads');
  if (log) log.innerHTML = '';
  if (dl)  dl.innerHTML  = '';
}

function genBtns(jobId) {
  return document.querySelectorAll(`.gen-btn[data-id="${jobId}"], .int-gen-btn[data-id="${jobId}"], .rej-gen-btn[data-id="${jobId}"]`);
}

function updateBtnProgress(jobId, pct, label) {
  genBtns(jobId).forEach(btn => {
    btn.style.backgroundColor = progressColor(pct);
    btn.style.removeProperty('opacity');
    btn.textContent = `${label}… ${pct}%`;
  });
}

socket.on('progress', ({ jobId, stage, status, message }) => {
  const baseStage = stage.split(':')[0];
  const label = STAGE_LABELS[baseStage] ?? humanizeStage(baseStage);
  const text  = message ? `${label}: ${message}` : `${label}: ${status}`;
  const kind  = (status === 'failed' || baseStage === 'error') ? 'error'
              : baseStage === 'warning' ? 'warning' : 'ok';
  appendLog(jobId, kind, text);

  const prog = STAGE_PROGRESS[baseStage];
  if (prog) updateBtnProgress(jobId, status === 'started' ? prog.started : prog.done, label);

  if (kind === 'error') resetBtn(jobId);
});

socket.on('complete', ({ jobId, docxUrl, pdfUrl }) => {
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
});

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
    applyOppFilters();
    renderDashboard();
    renderPipelineBreakdown();
    renderInterviews();
    renderRejected();
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
showView('dashboard');
init();
