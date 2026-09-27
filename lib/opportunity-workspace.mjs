// Phase 4: Opportunity Workspace — single-page read model for one Opportunity.
//
// Composes existing Phase 0-3 building blocks (opportunity-store,
// workspace-read-models, candidate-fit-analysis, candidate-questions) into
// one payload for the Opportunity Workspace tabs (Overview / Fit / Resume /
// Contacts / Application / Interview / Activity). Nothing new is stored here
// except one thing: when Fit analysis finds an Unknown-tier requirement, it
// ensures a persisted, answerable candidate question exists for it — that's
// candidate-questions.mjs's own existing, idempotent mechanism (Phase 2),
// which nothing else in the app calls yet. Without this, Phase 3's
// "Answer candidate question" action could never fire and Unknowns would
// have no "existing mechanism to answer/resolve them", as this phase's spec
// requires.
//
// Fit analysis itself is never persisted — recomputed fresh on every read
// from the job's saved JD text, consistent with the "derive, don't store"
// approach already used by Phase 1's opportunity-store.mjs and Phase 3's
// action-engine.mjs.
import { getOpportunity, getActivity } from './opportunity-store.mjs';
import { stageLabel } from './opportunity-stages.mjs';
import { buildJobReadModel } from './workspace-read-models.mjs';
import { loadBragDoc, loadJdFromReports } from './data.mjs';
import { assessJobDescription, selectBestJobDescription } from './resume-gen.mjs';
import { analyzeFit, classifyFreshness } from './candidate-fit-analysis.mjs';
import { generateQuestionsForUnknowns, getOpenQuestions } from './candidate-questions.mjs';
import { loadCandidateFacts } from './candidate-data.mjs';

const TIER_LABELS = {
  strong_match: 'Strong Match',
  partial_match: 'Partial Match',
  unknown: 'Unknown',
  gap: 'Gap',
  blocker: 'Blocker',
};

/**
 * Reassembles the same JD text resume-gen.mjs's (unexported) buildJdText()
 * builds, from only exported functions — avoids adding an export to that
 * large, already-tested file for a single internal helper.
 */
function loadJdTextForFit(opp) {
  const reportText = loadJdFromReports(opp.id);
  const best = selectBestJobDescription(opp, reportText);
  const assessment = assessJobDescription(opp, reportText);
  return { ...assessment, text: best.text };
}

function buildFit(opp) {
  const jd = loadJdTextForFit(opp);
  if (!jd.usable) {
    return { available: false, reason: jd.reason, source: jd.source };
  }

  const facts = loadCandidateFacts();
  const factsById = new Map(facts.map(f => [f.id, f.fact]));
  const result = analyzeFit(opp, jd.text, { candidateFacts: facts });

  // Ensure every Unknown-tier requirement has a persisted, answerable
  // question (idempotent — never duplicates an already-open or already
  // answered question for the same requirement label).
  generateQuestionsForUnknowns(result.classifications, opp.id);
  const openQuestions = getOpenQuestions().filter(q => (q.jobIds || []).includes(opp.id));

  return {
    available: true,
    source: jd.source,
    overallScore: result.overallScore,
    confidence: result.confidence,
    pursuitClassification: result.pursuitClassification,
    freshnessBucket: result.freshnessBucket,
    freshnessAgeDays: result.freshnessAgeDays,
    hardBlockers: result.hardBlockers,
    summary: result.summary,
    classifications: result.classifications.map(c => ({
      ...c,
      tierLabel: TIER_LABELS[c.tier] || c.tier,
      evidence: c.evidenceIds.map(id => factsById.get(id)).filter(Boolean),
    })),
    openQuestions,
  };
}

/**
 * Builds the full Opportunity Workspace payload for one opportunity.
 * Throws (err.code === 'OPPORTUNITY_NOT_FOUND') if the id doesn't exist —
 * routes translate that to a 404, matching every other Phase 1-3 route.
 */
export function buildOpportunityWorkspace(id) {
  const opp = getOpportunity(id);
  const jobReadModel = buildJobReadModel(opp, { bragDoc: loadBragDoc() });
  const activity = getActivity(id); // chronological, oldest first
  const freshness = classifyFreshness(opp);
  const fit = buildFit(opp);

  return {
    ...jobReadModel,
    stageLabel: stageLabel(opp.stage),
    freshness,
    fit,
    activity,
  };
}
