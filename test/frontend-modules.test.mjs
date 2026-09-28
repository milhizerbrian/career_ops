import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => fs.readFileSync(path.resolve(APP_ROOT, file), 'utf8');

describe('frontend ES modules', () => {
  it('loads dashboard as the browser module entrypoint', () => {
    const html = read('public/index.html');
    assert.match(html, /<script type="module" src="\/js\/dashboard\.js"><\/script>/);
    assert.doesNotMatch(html, /<script>\s*\/\/ ─── State/);
  });

  it('scales dashboard views across mobile and tablet widths', () => {
    const html = read('public/index.html');
    const dashboard = read('public/js/dashboard.js');

    assert.match(html, /\.dashboard-scroll \{ overflow: auto; \}/);
    assert.match(html, /\.dashboard-view \{\s+width: 100%;\s+min-width: 0;\s+max-width: 100%;\s+\}/);
    assert.match(html, /\.dashboard-table \{\s+width: 100%;\s+min-width: 0;/);
    assert.match(html, /@media \(max-width: 1179px\) \{/);
    assert.match(html, /\.dashboard-table thead \{ display: none; \}/);
    assert.match(html, /id="sidebar-backdrop"/);
    assert.match(dashboard, /matchMedia\('\(max-width: 1179px\)'\)/);
    assert.match(dashboard, /sidebar-mobile-open/);
    assert.match(html, /class="dashboard-scroll flex-1 p-6 space-y-6"/);
    for (const viewId of [
      'view-dashboard',
      'view-jobs',
      'view-resume',
      'view-outreach',
      'view-contacts',
      'view-gmail-review',
      'view-interviews',
      'view-rejected',
      'view-analytics',
      'view-settings',
    ]) {
      assert.match(html, new RegExp(`id="${viewId}"[^>]*class="dashboard-view"`));
    }
    assert.ok((html.match(/overflow-x-auto/g) || []).length >= 5);
    assert.ok((html.match(/dashboard-table w-full text-sm/g) || []).length >= 3);
  });

  it('keeps expected frontend modules present and imported', () => {
    for (const file of [
      'public/js/api.js',
      'public/js/state.js',
      'public/js/dashboard.js',
      'public/js/jobs-table.js',
      'public/js/progress.js',
      'public/js/source-badges.js',
    ]) {
      assert.ok(fs.existsSync(path.resolve(APP_ROOT, file)), `${file} exists`);
    }

    const dashboard = read('public/js/dashboard.js');
    for (const moduleName of ['api.js', 'state.js', 'jobs-table.js', 'progress.js', 'source-badges.js']) {
      assert.match(dashboard, new RegExp(`from '\\./${moduleName}'`));
    }
  });

  it('wires the Phase 9.3 Interview Command Center to the interview APIs and prep read model', () => {
    const dashboard = read('public/js/dashboard.js');
    const api = read('public/js/api.js');
    assert.ok(fs.existsSync(path.resolve(APP_ROOT, 'public/js/interview-ui.js')));
    assert.match(dashboard, /from '\.\/interview-ui\.js'/);
    assert.match(api, /function createInterviewRound\(opportunityId, body\)/);
    assert.match(api, /'\/interviews'/);
    assert.match(api, /function updateInterviewRound\(opportunityId, roundId, body\)/);
    assert.match(dashboard, /await updateInterviewRound\(id, roundId, payload\)/);
    assert.match(dashboard, /await createInterviewRound\(id, payload\)/);
    for (const section of ['INTERVIEW ROUNDS', 'BRIEFING', 'PREP CHECKLIST', 'LIKELY QUESTIONS', 'RECOMMENDED VERIFIED EVIDENCE', 'GAPS AND UNKNOWNS TO PREPARE', 'QUESTIONS TO ASK']) {
      assert.match(dashboard, new RegExp(`'${section}'`));
    }
    assert.match(dashboard, /job\.interviewPrep/);
    assert.match(dashboard, /class="round-notes/);
    assert.match(dashboard, /type="datetime-local" class="round-scheduled/);
    // Interviews page shows the next scheduled round per loop.
    assert.match(dashboard, /const nextRound = nextScheduledRound\(job\.interviews\)/);
    assert.match(dashboard, /int-next-round/);
  });

  it('wires Phase 9.4/9.5 interviewer contacts and thank-you follow-up', () => {
    const dashboard = read('public/js/dashboard.js');
    assert.match(dashboard, /<option value="interviewer">Interviewer<\/option>/);
    assert.match(dashboard, /send_thank_you: 'mail'/);
    assert.match(dashboard, /type: 'thank_you',\s+roundId: btn\.dataset\.roundId/);
    assert.match(dashboard, /type: 'follow_up_done',\s+label: 'Thank-you sent'/);
    assert.match(dashboard, /round\.status === 'completed' \? renderRoundThankYou\(job, round, contacts\)/);
  });

  it('renders Phase 10 Outcome Intelligence from the outcomes API', () => {
    const html = read('public/index.html');
    const dashboard = read('public/js/dashboard.js');
    const api = read('public/js/api.js');
    assert.match(html, /id="analytics-outcomes-root"/);
    assert.match(api, /function fetchOutcomeIntelligence\(\)/);
    assert.match(api, /'\/api\/analytics\/outcomes'/);
    assert.match(dashboard, /analyticsOutcomes = await fetchOutcomeIntelligence\(\)/);
    assert.match(dashboard, /'OUTCOME INTELLIGENCE'|OUTCOME INTELLIGENCE/);
    assert.match(dashboard, /Not enough data/);
    assert.match(dashboard, /low sample/);
    for (const dim of ['source', 'fitRange', 'roleCategory', 'networking', 'resume', 'workArrangement', 'company']) {
      assert.match(dashboard, new RegExp(`'${dim}'`));
    }
  });

  it('shows only current interview loops on the Interviews page and dashboard count', () => {
    const dashboard = read('public/js/dashboard.js');
    assert.match(dashboard, /function isCurrentInterviewLoop\(job\) \{\s+return INTERVIEW_STATUSES\.has\(job\.status \|\| ''\) && job\._workflow\?\.actionable !== false;/);
    assert.match(dashboard, /let list = allJobs\.filter\(isCurrentInterviewLoop\)/);
    assert.match(dashboard, /const interviews   = activeJobs\.filter\(isCurrentInterviewLoop\)/);
  });

  it('exposes sort handler for existing table header onclick attributes', () => {
    const html = read('public/index.html');
    const dashboard = read('public/js/dashboard.js');
    assert.match(html, /onclick="setOppSort\('company'\)"/);
    assert.match(dashboard, /window\.setOppSort = setOppSort/);
  });

  it('offers short posted-date filters on the dashboard', () => {
    const html = read('public/index.html');

    assert.match(html, /id="opp-posted-filter"/);
    assert.match(html, /<option value="1">Last 1 day<\/option>/);
    assert.match(html, /<option value="3">Last 3 days<\/option>/);
  });

  it('wires a standalone ambiguous Gmail review page', () => {
    const html = read('public/index.html');
    const dashboard = read('public/js/dashboard.js');
    const api = read('public/js/api.js');
    const server = read('server.mjs');

    assert.match(html, /data-view="gmail-review"/);
    assert.match(html, /id="view-gmail-review"/);
    assert.match(html, /id="gmail-ambiguity-panel"/);
    assert.match(html, /AMBIGUOUS EMAIL MATCHES/);
    assert.match(dashboard, /fetchAmbiguousGmailJobs/);
    assert.match(dashboard, /renderGmailAmbiguities/);
    assert.match(dashboard, /If approved/);
    assert.match(dashboard, /Status:/);
    assert.match(dashboard, /approval updates the selected job/);
    assert.match(dashboard, /buildGmailApprovalPreview/);
    assert.match(dashboard, /Approve/);
    assert.match(dashboard, /Decline/);
    assert.match(dashboard, /Edit selected job/);
    assert.match(dashboard, /showView\('gmail-review'\)/);
    assert.match(dashboard, /\/gmail-review/);
    assert.match(server, /\/gmail-review/);
    assert.match(dashboard, /attachGmailAmbiguity/);
    assert.match(dashboard, /dismissGmailAmbiguity/);
    assert.match(api, /\/api\/gmail-jobs\/'\s*\+\s*encodeURIComponent\(threadId\)\s*\+\s*'\/attach/);
  });

  it('restores resume generation progress after page refresh', () => {
    const dashboard = read('public/js/dashboard.js');
    const api = read('public/js/api.js');
    const server = read('server.mjs');

    assert.match(api, /fetchResumeRuns/);
    assert.match(server, /\/api\/resume-runs/);
    assert.match(dashboard, /restoreResumeRuns/);
    assert.match(dashboard, /reconcileResumeRuns/);
    assert.match(dashboard, /activeResumeJobs/);
    assert.match(dashboard, /Resume generation stopped before completion/);
    assert.match(dashboard, /processResumeProgress/);
    assert.match(dashboard, /alreadyRunning/);
  });

  it('cleans up resume helper processes after generation ends', () => {
    const server = read('server.mjs');
    const coordinator = read('lib/resume-run-coordinator.mjs');
    const cleanup = read('lib/resume-resource-cleanup.mjs');
    const throttle = read('lib/resume-resource-throttle.mjs');
    const pdf = read('lib/pdf-utils.mjs');

    assert.match(server, /beginSharedResumeResources/);
    assert.match(server, /canStartResumeRun/);
    assert.match(server, /resumeMaxConcurrent/);
    assert.match(coordinator, /cleanupResumeResourceProcesses/);
    assert.match(coordinator, /beginResumeResourceThrottle/);
    assert.match(coordinator, /scheduleResumeHelperRenice/);
    assert.match(coordinator, /RESUME_MAX_CONCURRENT/);
    assert.match(server, /finally/);
    // LM Studio now runs resume AI; its model must stay loaded between runs.
    assert.doesNotMatch(cleanup, /llmworker/);
    assert.match(cleanup, /headless LibreOffice/);
    assert.match(cleanup, /RESUME_CLEANUP_PROCESSES/);
    assert.match(throttle, /RESUME_RESOURCE_THROTTLE/);
    assert.match(throttle, /RESUME_NICE_LEVEL/);
    assert.match(throttle, /renice/);
    assert.match(pdf, /niceCommand/);
  });

  it('wires bulk visible resume generation with client-side concurrency', () => {
    const html = read('public/index.html');
    const dashboard = read('public/js/dashboard.js');

    assert.match(html, /bulk-generate-visible-btn/);
    assert.match(dashboard, /BULK_RESUME_CONCURRENCY = 3/);
    assert.match(dashboard, /triggerBulkGenerateVisible/);
    assert.match(dashboard, /bulkGenerateCandidates/);
    assert.match(dashboard, /Promise\.all/);
  });

  it('renders lightweight generated resume version history', () => {
    const dashboard = read('public/js/dashboard.js');
    assert.match(dashboard, /generatedResumeVersions/);
    assert.match(dashboard, /Resume Versions/);
    assert.match(dashboard, /resumeVersionScoreLabel/);
  });

  it('wires performance helpers for delegated events, debounced search, and lazy details', () => {
    const dashboard = read('public/js/dashboard.js');

    assert.match(dashboard, /function debounce\(fn, delay = 150\)/);
    assert.match(dashboard, /function delegate\(root, eventName, selector, handler\)/);
    assert.match(dashboard, /setupDelegatedWorkspaceActions/);
    assert.match(dashboard, /function ensureDetailRow\(detailRow, job, htmlBuilder\)/);
    assert.match(dashboard, /dataset\.lazyBuilt/);
    assert.match(dashboard, /function hasGeneratedResume\(job\)/);
    assert.match(dashboard, /!hasGeneratedResume\(job\)/);
    assert.match(dashboard, /'global-search'\)\.addEventListener\('input', debounce\(applyOppFilters\)\)/);
    assert.match(dashboard, /'int-search'\)\.addEventListener\('input',\s+debounce\(renderInterviews\)\)/);
    assert.match(dashboard, /'rej-search'\)\.addEventListener\('input', debounce\(renderRejected\)\)/);
    assert.match(dashboard, /'contacts-search'\)\?\.addEventListener\('input', debounce\(renderContactsWorkspace\)\)/);
  });

  it('does not render the brag doc quality coach on the dashboard', () => {
    const html = read('public/index.html');
    const dashboard = read('public/js/dashboard.js');
    const api = read('public/js/api.js');

    assert.doesNotMatch(html, /BRAG DOC COACH/);
    assert.doesNotMatch(html, /id="brag-quality-panel"/);
    assert.doesNotMatch(dashboard, /fetchBragQuality/);
    assert.doesNotMatch(dashboard, /renderBragQuality/);
    assert.match(api, /\/api\/brag-quality/);
  });

  it('renders compact job command center workflow indicators', () => {
    const html = read('public/index.html');
    const dashboard = read('public/js/dashboard.js');

    assert.match(html, /id="workflow-summary-grid"/);
    assert.match(dashboard, /renderWorkflowSummary/);
    assert.match(dashboard, /buildHealthSummaryCounts/);
    assert.match(dashboard, /GMAIL REVIEW/);
    assert.match(dashboard, /NEEDS RESUME/);
    assert.match(dashboard, /READY TO APPLY/);
    assert.match(dashboard, /INTERVIEW PREP/);
    assert.match(dashboard, /applyHealthSummaryFilter/);
    assert.match(dashboard, /Next Best Action/);
    assert.match(dashboard, /Workflow Timeline/);
  });

  it('wires command center analytics, score explanations, and research panels', () => {
    const html = read('public/index.html');
    const dashboard = read('public/js/dashboard.js');

    for (const id of [
      'analytics-digest-root',
      'analytics-priority-root',
      'analytics-stale-root',
      'analytics-company-root',
      'analytics-resume-feedback-root',
    ]) {
      assert.match(html, new RegExp(`id="${id}"`));
    }
    assert.match(dashboard, /renderDailyCommandCenter/);
    assert.match(dashboard, /renderUnifiedPriorityQueue/);
    assert.match(dashboard, /renderStaleCleanupPanel/);
    assert.match(dashboard, /renderCompanyResearchRows/);
    assert.match(dashboard, /renderResumeFeedbackPanel/);
    assert.match(dashboard, /Score Explanations/);
    assert.match(dashboard, /Why This Role/);
    assert.match(dashboard, /Company Research/);
    assert.match(dashboard, /contactInfluenceLabel/);
  });

  it('uses pipeline breakdown as the top dashboard card row', () => {
    const html = read('public/index.html');
    const dashboard = read('public/js/dashboard.js');

    assert.doesNotMatch(html, /id="kpi-grid"/);
    assert.match(html, /id="pipeline-breakdown" class="grid grid-cols-7 gap-2"/);
    assert.match(dashboard, /renderPipelineBreakdown/);
    assert.match(dashboard, /min-h-\[82px\]/);
    assert.doesNotMatch(dashboard, /document\.getElementById\('kpi-grid'\)\.innerHTML/);
  });

  it('does not expose dashboard job search ingestion controls', () => {
    const html = read('public/index.html');
    const dashboard = read('public/js/dashboard.js');
    const api = read('public/js/api.js');

    assert.doesNotMatch(html, /add-job-/);
    assert.doesNotMatch(html, /Scrape &amp; Add Job/);
    assert.doesNotMatch(dashboard, /submitAddJob/);
    assert.doesNotMatch(dashboard, /eval-progress/);
    assert.doesNotMatch(api, /evaluate-url/);
  });

  it('shows workflow card details on hover', () => {
    const dashboard = read('public/js/dashboard.js');

    assert.match(dashboard, /role="tooltip"/);
    assert.match(dashboard, /group-hover:block/);
    assert.match(dashboard, /aria-describedby="health-detail-\$\{filter\}"/);
    assert.match(dashboard, /Active leads without a generated resume/);
  });

  it('wires resizable and collapsible sidebar controls', () => {
    const html = read('public/index.html');
    const dashboard = read('public/js/dashboard.js');

    assert.match(html, /id="sidebar-toggle"/);
    assert.match(html, /id="sidebar-resize-handle"/);
    assert.match(html, /--sidebar-width/);
    assert.match(html, /body\.sidebar-collapsed/);
    assert.match(dashboard, /setupSidebarControls/);
    assert.match(dashboard, /careerOpsSidebarWidth/);
    assert.match(dashboard, /careerOpsSidebarCollapsed/);
    assert.match(dashboard, /setPointerCapture/);
  });

  it('wires manual job workflow action controls', () => {
    const dashboard = read('public/js/dashboard.js');
    const api = read('public/js/api.js');
    const server = read('server.mjs');

    assert.match(dashboard, /workflow-action-btn/);
    assert.match(dashboard, /submitWorkflowAction/);
    assert.match(api, /postWorkflowEvent/);
    assert.match(server, /\/api\/jobs\/:id\/workflow-event/);
  });

  it('wires a lightweight recruiter contact workspace', () => {
    const dashboard = read('public/js/dashboard.js');
    const api = read('public/js/api.js');
    const server = read('server.mjs');

    assert.match(dashboard, /function renderContactsWorkspace/);
    assert.match(dashboard, /contact-edit-workspace/);
    assert.match(dashboard, /contact-status-editor/);
    assert.match(dashboard, /contactStatusLabel/);
    assert.match(dashboard, /Request Sent/);
    assert.match(dashboard, /Connected/);
    assert.match(dashboard, /Experience Match/);
    assert.match(dashboard, /experienceMatchPct/);
    assert.match(dashboard, /contacts-sort-btn/);
    assert.match(dashboard, /function sortContacts/);
    assert.match(dashboard, /function setContactsSort/);
    assert.match(dashboard, /LinkedIn profile/);
    assert.match(dashboard, /contact\.linkedinUrl/);
    assert.match(dashboard, /fetchContactsWorkspace/);
    assert.doesNotMatch(dashboard, /parts\.push\(renderContactWorkspace\(job\)\)/);
    assert.match(api, /upsertJobContact/);
    assert.match(server, /\/api\/jobs\/:id\/contacts/);
  });

  it('does not render workflow or contact editors inside job detail panels', () => {
    const dashboard = read('public/js/dashboard.js');

    assert.doesNotMatch(dashboard, /parts\.push\(renderWorkflowActions\(job\)\)/);
    assert.doesNotMatch(dashboard, /parts\.push\(renderContactWorkspace\(job\)\)/);
  });

  it('wires contact outreach draft generation', () => {
    const dashboard = read('public/js/dashboard.js');
    const api = read('public/js/api.js');
    const server = read('server.mjs');

    assert.match(dashboard, /contact-draft-btn/);
    assert.match(dashboard, /generateContactDraft/);
    assert.match(dashboard, /outreachDrafts/);
    assert.match(api, /generateContactOutreachDraft/);
    assert.match(server, /\/api\/jobs\/:id\/contacts\/outreach-draft/);
  });

  it('uses real ATS match scores and compact next-step labels in job rows', () => {
    const dashboard = read('public/js/dashboard.js');
    const jobsTable = read('public/js/jobs-table.js');

    assert.match(dashboard, /function atsPercent\(job\)/);
    assert.match(dashboard, /job\?\._ats\?\.score/);
    assert.match(dashboard, /const scored\s+= activeJobs\.map\(atsPercent\)/);
    assert.match(dashboard, /const pct = atsPercent\(j\)/);
    assert.match(jobsTable, /function atsScore\(job\)/);
    assert.match(jobsTable, /job\?\._ats\?\.score/);
    assert.match(dashboard, /Next: \$\{esc\(nextStep\)\}/);
  });

  it('replaces interview resume generation with an add-note shortcut', () => {
    const dashboard = read('public/js/dashboard.js');

    assert.match(dashboard, /int-add-note-btn/);
    assert.match(dashboard, />Add note<\/button>/);
    assert.match(dashboard, /function openInterviewNote\(jobId\)/);
    assert.match(dashboard, /noteInput\?\.focus\(\)/);
    assert.doesNotMatch(dashboard, /int-gen-btn/);
  });

  it('renders the full latest interview note under Stage in compact rows', () => {
    const dashboard = read('public/js/dashboard.js');

    assert.match(dashboard, /function latestNoteText\(notesStr\)/);
    assert.match(dashboard, /noteLines\.push\(line\)/);
    assert.match(dashboard, /whitespace-pre-wrap break-words max-w-sm/);
    assert.doesNotMatch(dashboard, /text-slate-400 truncate max-w-\[220px\]/);
  });

  it('wires operational workspace routes and API helpers', () => {
    const html = read('public/index.html');
    const dashboard = read('public/js/dashboard.js');
    const api = read('public/js/api.js');
    const server = read('server.mjs');

    for (const view of ['jobs', 'resume', 'outreach', 'contacts', 'analytics', 'settings']) {
      assert.match(html, new RegExp(`data-view="${view}"`));
      assert.match(html, new RegExp(`id="view-${view}"`));
    }
    for (const helper of [
      // Phase 4 replaced the old job-detail modal's fetchJobDetail() call
      // with fetchOpportunityWorkspace() (the tabbed Opportunity Workspace);
      // fetchJobDetail itself still exists in api.js but dashboard.js no
      // longer calls it, so it's checked in api.js only, not here.
      'fetchOpportunityWorkspace',
      'fetchResumeWorkspace',
      'fetchOutreachWorkspace',
      'fetchContactsWorkspace',
      'fetchAnalyticsSummary',
      'fetchSettingsHealth',
    ]) {
      assert.match(dashboard, new RegExp(helper));
    }
    for (const helper of [
      'fetchJobDetail',
      'fetchOpportunityWorkspace',
      'fetchResumeWorkspace',
      'fetchOutreachWorkspace',
      'fetchContactsWorkspace',
      'fetchAnalyticsSummary',
      'fetchSettingsHealth',
    ]) {
      assert.match(api, new RegExp(`function ${helper}`));
    }
    assert.match(server, /\/api\/workspaces\/resume/);
    assert.match(server, /\/api\/workspaces\/outreach/);
    assert.match(server, /\/api\/workspaces\/contacts/);
    assert.match(server, /\/api\/analytics\/summary/);
    assert.match(server, /\/api\/settings\/health/);
    assert.match(server, /\/jobs\/:id/);
    assert.match(dashboard, /showJobDetail/);
    assert.match(dashboard, /renderJobDetailWorkspace/);
    assert.match(dashboard, /open-job-btn/);
    assert.match(dashboard, /category\.label/);
    assert.match(dashboard, /category\.signals/);
  });

  it('opens Phase 3 Command Center actions to the matching Opportunity Workspace tab (Phase 4 deep links)', () => {
    const dashboard = read('public/js/dashboard.js');

    // Every Phase 3 action type maps to a real Opportunity Workspace tab —
    // completing/continuing an action from Home or Start My Day should land
    // on the tab that action is about, not always Overview.
    assert.match(dashboard, /const ACTION_TYPE_TAB = \{/);
    for (const [type, tab] of [
      ['review_opportunity', 'overview'],
      ['answer_question', 'fit'],
      ['generate_resume', 'resume'],
      ['review_resume', 'resume'],
      ['apply', 'application'],
      ['find_contact', 'contacts'],
      ['follow_up', 'application'],
      ['prepare_interview', 'interview'],
      ['record_outcome', 'activity'],
      ['send_thank_you', 'interview'],
    ]) {
      assert.match(dashboard, new RegExp(`${type}:\\s*'${tab}'`));
    }
    assert.match(dashboard, /async function completeActionFromHome\(id, opportunityId, type\)/);
    assert.match(dashboard, /showJobDetail\(opportunityId, \{ tab: ACTION_TYPE_TAB\[type\] \|\| 'overview' \}\)/);
  });
});
