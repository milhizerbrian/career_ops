// Phase 3: Daily Command Center — Action Model
//
// Answers "what should Brian do next?" by generating a small set of
// concrete actions from Opportunity (Phase 1) + Intelligence (Phase 2, when
// present) state, ranking them, and explaining why each one exists.
//
// Design: actions are DERIVED, not stored. Each call to buildActions()
// regenerates the full candidate list from current opportunity/job state
// (deterministic — same inputs always produce the same actions, so a
// completed action whose trigger condition no longer holds simply stops
// being generated). The only thing persisted is the small set of Brian's
// own decisions (Completed / Skipped / Snoozed) in data/actions-state.json,
// keyed by a stable `${opportunityId}:${type}` id so re-running generation
// never produces a duplicate. This mirrors the "one authoritative dataset,
// decorated view" approach used by Phase 1's opportunity-store.mjs.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { writeJsonAtomic } from './atomic-file.mjs';
import { detectWorkflowStaleness, getLastWorkflowActivityAt, buildWorkflowTimeline, ACTIVITY_DISPLAY_CUTOFF } from './job-workflow.mjs';
import { TERMINAL_STAGES } from './opportunity-stages.mjs';
import { getOpenQuestions } from './candidate-questions.mjs';
import { normalizeInterviewRounds, roundTypeLabel } from './interview-rounds.mjs';
import { isDailyActionEligible } from './daily-eligibility.mjs';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const THANK_YOU_WINDOW_DAYS = 7;

export const ACTION_TYPES = [
  'review_opportunity',
  'answer_question',
  'generate_resume',
  'review_resume',
  'apply',
  'find_contact',
  'follow_up',
  'prepare_interview',
  'record_outcome',
  'send_thank_you', // Phase 9.5
];

export const ACTION_STATUSES = ['Pending', 'Completed', 'Skipped', 'Snoozed'];

const ACTION_TITLES = {
  review_opportunity: 'Review opportunity',
  answer_question: 'Answer candidate question',
  generate_resume: 'Generate resume',
  review_resume: 'Review resume',
  apply: 'Apply',
  find_contact: 'Find contact/referral',
  follow_up: 'Follow up',
  prepare_interview: 'Prepare interview',
  record_outcome: 'Record outcome',
  send_thank_you: 'Send thank-you',
};

// Baseline urgency per action type. Freshness/staleness/blockers/due-dates
// adjust this per-opportunity below. This number is an internal sort key
// only — never shown to Brian (the UI shows the `reason` text instead).
const TYPE_BASE_PRIORITY = {
  send_thank_you: 95,
  prepare_interview: 90,
  record_outcome: 85,
  follow_up: 80,
  apply: 75,
  review_resume: 65,
  answer_question: 60,
  generate_resume: 55,
  find_contact: 45,
  review_opportunity: 40,
};

// ── Persisted decision store (Completed/Skipped/Snoozed overlay) ──────────

function actionsStatePath() {
  const dataDir = process.env.CAREER_OPS_DATA_DIR
    ? path.resolve(process.env.CAREER_OPS_DATA_DIR)
    : path.resolve(APP_ROOT, 'data');
  return path.resolve(dataDir, 'actions-state.json');
}

export function loadActionState() {
  const filePath = actionsStatePath();
  if (!fs.existsSync(filePath)) return {};
  try {
    const value = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

function saveActionState(state) {
  writeJsonAtomic(actionsStatePath(), state);
}

export function actionId(opportunityId, type) {
  return `${opportunityId}:${type}`;
}

/**
 * Records Brian's decision on an action. `decision` is one of
 * 'complete' | 'skip' | 'snooze' | 'reopen'. `snoozeDays` only applies to
 * 'snooze' (default 3 days). Returns the persisted record.
 */
export function recordActionDecision(id, decision, { snoozeDays = 3, now = new Date() } = {}) {
  const state = loadActionState();
  if (decision === 'reopen') {
    delete state[id];
    saveActionState(state);
    return null;
  }
  const record = { decidedAt: now.toISOString() };
  if (decision === 'complete') record.status = 'Completed';
  else if (decision === 'skip') record.status = 'Skipped';
  else if (decision === 'snooze') {
    record.status = 'Snoozed';
    record.snoozeUntil = new Date(now.getTime() + snoozeDays * MS_PER_DAY).toISOString();
  } else {
    throw new Error(`Unsupported action decision: ${decision}`);
  }
  state[id] = record;
  saveActionState(state);
  return { id, ...record };
}

// ── Reason text + priority helpers ─────────────────────────────────────

function toIsoOrNull(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function daysSince(dateStr, now = new Date()) {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return null;
  return Math.floor((now.getTime() - d.getTime()) / MS_PER_DAY);
}

/** Legacy 0-100 fit percent, reusing the same fallback the dashboard UI already uses (public/js/dashboard.js's atsPercent). */
function legacyFitPercent(opp) {
  const ats = Number(opp?._ats?.score);
  if (Number.isFinite(ats)) return Math.round(ats);
  const legacy = Number(opp?.score);
  return Number.isFinite(legacy) ? Math.round(legacy * 20) : null;
}

/** Prefers Phase 2's persisted overallFit when present; falls back to the legacy ATS/score signal otherwise. */
/**
 * Phase 1's read-time Opportunity view (toOpportunityView) falls back to the
 * legacy 0-5 `score` field whenever `overallFit` was never explicitly set —
 * so `overallFit` being present does NOT by itself prove Phase 2 has scored
 * this job (it may just be that 0-5 legacy score, on the wrong scale).
 * `confidence` is only ever written alongside a genuine Phase 2 run, so its
 * presence is what distinguishes a real 0-100 fit percent from that
 * fallback; otherwise we compute the legacy percent ourselves.
 */
function fitPercent(opp) {
  if (opp?.confidence != null && opp?.overallFit != null) return opp.overallFit;
  return legacyFitPercent(opp);
}

function isWorthReviewing(opp) {
  const fit = fitPercent(opp);
  const blockers = Array.isArray(opp?.hardBlockers) ? opp.hardBlockers.length : 0;
  return fit != null && fit >= 50 && blockers === 0;
}

function reviewReason(opp, now) {
  const fit = fitPercent(opp);
  const ageDays = daysSince(opp.discoveredDate, now);
  const freshText = ageDays == null ? '' : ageDays <= 1 ? 'Posted 1 day ago.' : `Posted ${ageDays} days ago.`;
  const fitText = fit != null ? `${fit >= 80 ? 'Strong' : 'Reasonable'} match (${fit}%).` : 'Not yet scored.';
  return [fitText, freshText].filter(Boolean).join(' ');
}

function reviewPriority(opp, now) {
  const fit = fitPercent(opp) ?? 50;
  const ageDays = daysSince(opp.discoveredDate, now) ?? 999;
  const freshnessBonus = ageDays <= 3 ? 15 : ageDays <= 14 ? 8 : ageDays <= 30 ? 0 : -10;
  return TYPE_BASE_PRIORITY.review_opportunity + Math.round((fit - 50) / 2) + freshnessBonus;
}

function makeAction(opp, type, { title, reason, priority, dueDate = null } = {}) {
  return {
    id: actionId(opp.id, type),
    opportunityId: opp.id,
    type,
    title: title || `${ACTION_TITLES[type]} — ${opp.company || opp.id}`,
    reason,
    priority: Math.round(priority),
    dueDate,
    status: 'Pending',
    createdAt: new Date().toISOString(),
    completedAt: null,
  };
}

// ── Candidate generation (per opportunity, before the decision overlay) ───

/**
 * @param {object} opp - an Opportunity view (lib/opportunity-store.mjs's toOpportunityView), decorated with
 *   optional `_ats`/`_oi` (getCachedDashboard's per-job scoring) for the legacy fit fallback.
 * @param {object} ctx - { openQuestionIdsByJob: Map<jobId, string[]>, now: Date, workflowOptions }
 */
export function generateCandidateActions(opp, ctx = {}) {
  const now = ctx.now || new Date();
  const stage = opp.stage;
  const actions = [];
  if (TERMINAL_STAGES.has(stage)) return actions;
  // Shared daily-task rule: below-threshold, not-yet-applied roles never
  // generate actions (they stay stored for dedupe/history/outcomes).
  if (!isDailyActionEligible(opp)) return actions;

  // 1. Review opportunity — Priority (or any decent-fit) job not yet reviewed.
  if (['discovered', 'qualified'].includes(stage) && isWorthReviewing(opp)) {
    actions.push(makeAction(opp, 'review_opportunity', {
      title: `Review ${opp.company || 'this role'}${opp.title ? ' — ' + opp.title : ''}`,
      reason: reviewReason(opp, now),
      priority: reviewPriority(opp, now),
    }));
  }

  // 2. Answer candidate question — Pursuing + missing candidate evidence.
  const openQuestions = ctx.openQuestionsFor ? ctx.openQuestionsFor(opp.id) : [];
  if (['pursuing', 'materials_ready'].includes(stage) && openQuestions.length) {
    actions.push(makeAction(opp, 'answer_question', {
      title: `Answer a question for ${opp.company || 'this role'}`,
      reason: `${openQuestions.length} open question${openQuestions.length > 1 ? 's' : ''} affecting how confidently this role can be scored.`,
      priority: TYPE_BASE_PRIORITY.answer_question,
    }));
  }

  // 3. Generate resume — Pursuing + no tailored resume yet.
  const hasResume = ctx.hasGeneratedResume
    ? ctx.hasGeneratedResume(opp)
    : buildWorkflowTimeline(opp).some(e => e.type === 'resume_generated');
  if (stage === 'pursuing' && !hasResume) {
    actions.push(makeAction(opp, 'generate_resume', {
      title: `Generate a tailored resume for ${opp.company || 'this role'}`,
      reason: 'No tailored resume exists yet for this opportunity.',
      priority: TYPE_BASE_PRIORITY.generate_resume,
    }));
  }

  // 4. Review resume — resume exists, hasn't been signed off yet (review_resume not Completed).
  const reviewResumeId = actionId(opp.id, 'review_resume');
  const reviewResumeDone = ctx.isCompleted ? ctx.isCompleted(reviewResumeId) : false;
  if (['pursuing', 'materials_ready'].includes(stage) && hasResume && !reviewResumeDone) {
    actions.push(makeAction(opp, 'review_resume', {
      title: `Review the generated resume for ${opp.company || 'this role'}`,
      reason: 'A tailored resume was generated and needs a quick read before it goes out.',
      priority: TYPE_BASE_PRIORITY.review_resume,
    }));
  }

  // 5. Apply — Materials Ready → Apply (resume exists and has been reviewed).
  if (['pursuing', 'materials_ready'].includes(stage) && hasResume && reviewResumeDone) {
    actions.push(makeAction(opp, 'apply', {
      title: `Apply to ${opp.company || 'this role'}`,
      reason: 'Resume is ready and reviewed — this one is ready to submit.',
      priority: TYPE_BASE_PRIORITY.apply,
    }));
  }

  // 6. Find contact/referral — actively pursuing/applied with no contact on file.
  const hasContact = Array.isArray(opp.contacts) && opp.contacts.length > 0;
  if (['pursuing', 'materials_ready', 'applied'].includes(stage) && !hasContact) {
    actions.push(makeAction(opp, 'find_contact', {
      title: `Find a contact or referral at ${opp.company || 'this company'}`,
      reason: 'No recruiter, hiring manager, or referral contact recorded yet.',
      priority: TYPE_BASE_PRIORITY.find_contact,
    }));
  }

  // 7. Follow up — reuses Phase 0/1's existing staleness detector rather than reimplementing day math.
  const staleness = ctx.detectStaleness ? ctx.detectStaleness(opp) : detectWorkflowStaleness(opp, ctx.workflowOptions);
  if (staleness.needsAppliedFollowUp) {
    actions.push(makeAction(opp, 'follow_up', {
      title: `Follow up with ${opp.company || 'this company'}`,
      reason: `Applied ${staleness.appliedForDays} day${staleness.appliedForDays === 1 ? '' : 's'} ago. No response recorded.`,
      priority: TYPE_BASE_PRIORITY.follow_up + Math.min(20, Math.max(0, (staleness.appliedForDays ?? 0) - 7)),
      dueDate: now.toISOString(),
    }));
  } else if (staleness.staleLead && stage === 'pursuing') {
    actions.push(makeAction(opp, 'follow_up', {
      title: `Revisit ${opp.company || 'this opportunity'}`,
      reason: `No activity in ${staleness.inactiveForDays} days — decide whether to keep pursuing.`,
      priority: TYPE_BASE_PRIORITY.follow_up - 10,
    }));
  }

  // 8. Prepare interview — any active interview stage.
  if (['recruiter_screen', 'interview', 'final_round'].includes(stage)) {
    actions.push(makeAction(opp, 'prepare_interview', {
      title: `Prepare for the ${opp.company || 'upcoming'} interview`,
      reason: `Opportunity is in ${stage.replace(/_/g, ' ')} — get ready before the next conversation.`,
      priority: TYPE_BASE_PRIORITY.prepare_interview,
    }));
  }

  // 8b. Send thank-you — one action per round completed in the last
  // THANK_YOU_WINDOW_DAYS with no follow_up_done recorded since. The id
  // carries the round id so a decision on one round never hides another.
  const followUpTimes = buildWorkflowTimeline(opp).filter(e => e.type === 'follow_up_done').map(e => e.at);
  for (const round of normalizeInterviewRounds(opp.interviews)) {
    if (round.status !== 'completed' || !round.completedAt) continue;
    const age = daysSince(round.completedAt, now);
    if (age == null || age > THANK_YOU_WINDOW_DAYS) continue;
    if (followUpTimes.some(at => at >= round.completedAt)) continue;
    actions.push({
      ...makeAction(opp, 'send_thank_you', {
        title: `Send a thank-you for the ${opp.company || ''} ${roundTypeLabel(round.roundType).toLowerCase()} interview`.replace(/\s+/g, ' '),
        reason: 'Interview completed and no thank-you or follow-up recorded yet. Draft one from the Interview tab, then mark it sent.',
        priority: TYPE_BASE_PRIORITY.send_thank_you,
      }),
      id: `${actionId(opp.id, 'send_thank_you')}:${round.id}`,
      triggeredAt: round.completedAt,
    });
  }

  // 9. Record outcome — interview/final-round gone quiet for a while; needs a status check-in.
  const lastActivityAt = ctx.lastActivityAt ? ctx.lastActivityAt(opp) : getLastWorkflowActivityAt(opp);
  const discoveredAt = toIsoOrNull(opp.discoveredDate ?? opp.date_found) ?? toIsoOrNull(opp.date_updated);
  const inactiveDays = daysSince(lastActivityAt, now);
  if (['interview', 'final_round'].includes(stage) && inactiveDays != null && inactiveDays >= 10) {
    actions.push(makeAction(opp, 'record_outcome', {
      title: `Record an outcome for ${opp.company || 'this interview'}`,
      reason: `No update in ${inactiveDays} days since the last recorded activity — worth a status check-in.`,
      priority: TYPE_BASE_PRIORITY.record_outcome,
    }));
  }

  // When did the thing that caused each action happen? New-role reviews are
  // triggered by discovery; thank-yous by round completion; every other
  // action by the opportunity's latest real activity (stage change,
  // application, interview, reply, update).
  for (const action of actions) {
    if (action.triggeredAt) continue;
    action.triggeredAt = action.type === 'review_opportunity' ? discoveredAt : (lastActivityAt ?? null);
  }
  return actions;
}

// ── Persisted-decision overlay ──────────────────────────────────────────

/**
 * Merges freshly generated candidate actions with the persisted decision
 * state. Completed/Skipped actions are dropped once their cool-down window
 * passes (or immediately if the state has moved on since the decision —
 * job.lastActivity newer than decidedAt), so stale decisions disappear
 * rather than accumulating forever. Snoozed actions stay hidden from the
 * active list until `snoozeUntil` passes.
 */
export function applyDecisionOverlay(candidateActions, state, { now = new Date(), skipCooldownDays = 3 } = {}) {
  const out = [];
  for (const action of candidateActions) {
    const record = state[action.id];
    if (!record) { out.push(action); continue; }

    if (record.status === 'Completed') {
      out.push({ ...action, status: 'Completed', completedAt: record.decidedAt });
      continue;
    }
    if (record.status === 'Skipped') {
      const skippedDaysAgo = daysSince(record.decidedAt, now) ?? 0;
      if (skippedDaysAgo < skipCooldownDays) {
        out.push({ ...action, status: 'Skipped' });
      } else {
        out.push(action); // cool-down passed — surfaces again as Pending
      }
      continue;
    }
    if (record.status === 'Snoozed') {
      const stillSnoozed = record.snoozeUntil && new Date(record.snoozeUntil) > now;
      out.push(stillSnoozed ? { ...action, status: 'Snoozed', dueDate: record.snoozeUntil } : action);
      continue;
    }
    out.push(action);
  }
  return out;
}

// ── Top-level orchestration ─────────────────────────────────────────────

/**
 * Builds the full action list for a set of opportunities.
 * @param {object[]} opportunities - Opportunity views (lib/opportunity-store.mjs)
 * @param {object} options - { state, now, openQuestionIdsByJob, hasGeneratedResume, detectStaleness, lastActivityAt }
 */
export function buildActions(opportunities, options = {}) {
  const now = options.now || new Date();
  const state = options.state ?? loadActionState();
  const openQuestions = options.openQuestions ?? getOpenQuestions();
  const openQuestionsFor = (jobId) => openQuestions.filter(q => (q.jobIds || []).includes(jobId));

  const ctx = {
    now,
    openQuestionsFor,
    hasGeneratedResume: options.hasGeneratedResume,
    detectStaleness: options.detectStaleness,
    lastActivityAt: options.lastActivityAt,
    workflowOptions: options.workflowOptions,
    isCompleted: (id) => state[id]?.status === 'Completed',
  };

  // Presentation cutoff: actions whose triggering event predates the cutoff
  // are not current tasks (history itself is untouched). Pass
  // `cutoff: null` to include them.
  const cutoff = options.cutoff === undefined ? ACTIVITY_DISPLAY_CUTOFF : options.cutoff;
  const allCandidates = opportunities.flatMap(opp => generateCandidateActions(opp, ctx))
    .filter(action => !cutoff || (action.triggeredAt && action.triggeredAt >= cutoff));
  const withOverlay = applyDecisionOverlay(allCandidates, state, { now, skipCooldownDays: options.skipCooldownDays });
  return withOverlay.sort((a, b) => b.priority - a.priority);
}

// ── Home-screen summary ─────────────────────────────────────────────────

export function buildHomeSummary(opportunities, actions) {
  const pending = actions.filter(a => a.status === 'Pending');
  const followUps = pending.filter(a => a.type === 'follow_up');
  const rest = pending.filter(a => a.type !== 'follow_up');
  const topPriority = rest[0] || followUps[0] || null;
  const next = rest.filter(a => a !== topPriority).slice(0, 4);

  // "Active" (not yet closed out) excludes rejected/withdrawn/archived — but
  // keeps 'offer', since an offer is still a meaningful pipeline state to
  // show even though the action engine treats it as terminal (no more
  // automatic actions to generate once an offer is in hand).
  const CLOSED_OUT_STAGES = new Set(['rejected', 'withdrawn', 'archived']);
  const active = opportunities.filter(o => !CLOSED_OUT_STAGES.has(o.stage));
  const discovered = active.filter(o => o.stage === 'discovered').length;
  const qualified = active.filter(o => o.stage === 'qualified').length;
  const worthReviewing = pending.filter(a => a.type === 'review_opportunity').length;

  const pipelineSnapshot = {
    applied: active.filter(o => o.stage === 'applied').length,
    recruiterScreens: active.filter(o => o.stage === 'recruiter_screen').length,
    interviews: active.filter(o => ['interview', 'final_round'].includes(o.stage)).length,
    offers: active.filter(o => o.stage === 'offer').length,
  };

  return {
    topPriority,
    next,
    followUps: followUps.filter(a => a !== topPriority),
    newOpportunities: { discovered, qualified, worthReviewing },
    pipelineSnapshot,
    caughtUp: pending.length === 0,
    startMyDayQueue: [
      ...(topPriority ? [topPriority] : []),
      ...rest.filter(a => a !== topPriority),
      ...followUps.filter(a => a !== topPriority),
    ],
  };
}
