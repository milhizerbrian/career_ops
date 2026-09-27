// Phase 9.2: deterministic interview-prep read model. Pure — no I/O, no AI.
// Composes what the Opportunity Workspace already computes (Phase 2 fit
// classifications, open candidate questions, the "why this role" brief) with
// Phase 9.1 interview rounds and the canonical candidate evidence store.
//
// Evidence rule: only records passed in as verified are ever shown. Facts
// come from loadCandidateFacts() (verified + allowed_in_resume) and are
// resolved by the ids fit analysis already matched; stories are filtered
// to verified === true here and matched with the same classifyRequirement()
// alias matcher fit analysis uses. When nothing verified matches, the
// output says so — it never generates evidence, metrics, or stories.
// Likely questions are interviewer-side prompts only; they make no
// candidate claims.
import { classifyRequirement } from './candidate-fit-analysis.mjs';
import { roundTypeLabel } from './interview-rounds.mjs';

const MAX_LIKELY_REQUIREMENT_QUESTIONS = 8;
const SUPPORTED_TIERS = new Set(['strong_match', 'partial_match']);
const GAP_TIERS = new Set(['unknown', 'gap', 'blocker']);

const ROUND_QUESTIONS = {
  recruiter: [
    'Walk me through your background and why you are looking right now.',
    'Why are you interested in {company}?',
    'What are your compensation expectations?',
    'What is your availability and timeline?',
  ],
  hiring_manager: [
    'Why this {title} role, and why now?',
    'How would you approach your first 90 days?',
    'Tell me about a time you handled a difficult customer or stakeholder.',
    'How do you prioritize across a portfolio of accounts?',
  ],
  technical: [
    'Walk me through a technical problem you solved for a customer.',
    'How do you explain complex technical concepts to non-technical stakeholders?',
    'How do you get up to speed on a new product or technology?',
  ],
  panel: [
    'How do you work cross-functionally with Sales, Product, and Support?',
    'Tell me about a time you disagreed with a colleague and how you resolved it.',
    'What would your peers say about working with you?',
  ],
  executive: [
    'How does this role drive business outcomes for {company}?',
    'Where do you see the biggest risk or opportunity in a customer base like ours?',
    'How do you communicate customer health to executive leadership?',
  ],
  final: [
    'Why should we hire you for this {title} role?',
    'What questions or concerns do you still have about the role?',
    'What would make you say yes to an offer?',
  ],
  general: [
    'Tell me about yourself.',
    'Why are you interested in this {title} role at {company}?',
    'What are you looking for in your next role?',
  ],
};

const ROUND_QUESTIONS_TO_ASK = {
  recruiter: ['What are the next steps and the timeline for this process?', 'Who will I meet in the next rounds?'],
  hiring_manager: ['What does success look like in the first 90 days?', 'What are the biggest challenges facing the team right now?'],
  technical: ['What tools and systems does the team use day to day?', 'How does the team work with Product and Engineering on customer issues?'],
  panel: ['How do the teams represented here work together day to day?', 'What do you enjoy most about working here?'],
  executive: ['What are the company\'s top priorities for the next year?', 'How does this role contribute to those priorities?'],
  final: ['Is there anything about my background that gives you pause?', 'What are the next steps after this round?'],
  general: ['What does success look like in this role?', 'What are the next steps in the process?'],
};

function fill(template, opp) {
  return template
    .replace(/\{company\}/g, opp.company || 'the company')
    .replace(/\{title\}/g, opp.title || 'this');
}

function dedupe(list) {
  return [...new Set(list.filter(Boolean))];
}

function pickNextRound(rounds, now) {
  const scheduled = rounds.filter(r => r.status === 'scheduled');
  const upcoming = scheduled
    .filter(r => r.scheduledAt && r.scheduledAt >= now.toISOString())
    .sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt));
  return upcoming[0] || scheduled.find(r => !r.scheduledAt) || null;
}

function storyText(story) {
  return [story.situation, story.task, story.action, story.result].filter(Boolean).join(' ');
}

function requirementPriority(c) {
  const cats = c.categories || [];
  if (cats.includes('required')) return 0;
  if (cats.includes('preferred')) return 1;
  return 2;
}

function buildLikelyQuestions({ opp, roundType, classifications }) {
  const key = roundType && ROUND_QUESTIONS[roundType] ? roundType : 'general';
  const roundQuestions = ROUND_QUESTIONS[key].map(t => ({ question: fill(t, opp), basis: 'round', requirement: null, tier: null }));

  const ordered = [...classifications].sort((a, b) => requirementPriority(a) - requirementPriority(b));
  if (roundType === 'technical') ordered.sort((a, b) => Number(!(b.categories || []).includes('skills')) - Number(!(a.categories || []).includes('skills')));
  const requirementQuestions = ordered.slice(0, MAX_LIKELY_REQUIREMENT_QUESTIONS).map(c => ({
    question: SUPPORTED_TIERS.has(c.tier)
      ? `Tell me about your experience with ${c.label}.`
      : `This role involves ${c.label}. How would you approach it?`,
    basis: SUPPORTED_TIERS.has(c.tier) ? 'requirement' : 'gap',
    requirement: c.label,
    tier: c.tier,
  }));

  const seen = new Set();
  return [...roundQuestions, ...requirementQuestions].filter(q => !seen.has(q.question) && seen.add(q.question));
}

/**
 * @param {object} input
 * @param {object} input.opp           Opportunity view (company, title, stage, ...)
 * @param {string} input.stageLabel
 * @param {object} input.fit           buildFit() output from opportunity-workspace
 * @param {object|null} input.parsedJd parseJobDescription() output, when a JD is usable
 * @param {object[]} input.rounds      normalized interview rounds
 * @param {object[]} input.facts       verified + allowed candidate facts
 * @param {object[]} input.stories     candidate stories (filtered to verified here)
 * @param {string[]} input.baseQuestionsToAsk
 * @param {number} input.resumeVersionCount
 * @param {Date} input.now
 */
export function buildInterviewPrep({
  opp,
  stageLabel = '',
  fit = { available: false },
  parsedJd = null,
  rounds = [],
  facts = [],
  stories = [],
  baseQuestionsToAsk = [],
  resumeVersionCount = 0,
  now = new Date(),
} = {}) {
  const nextRound = pickNextRound(rounds, now);
  const roundType = nextRound?.roundType ?? null;
  const classifications = fit?.available && Array.isArray(fit.classifications) ? fit.classifications : [];
  const openQuestions = fit?.available && Array.isArray(fit.openQuestions) ? fit.openQuestions : [];

  const factsById = new Map(facts.map(f => [f.id, f]));
  const verifiedStories = stories.filter(s => s && s.verified === true);
  const storyFacts = verifiedStories.map(s => ({ id: s.id, fact: storyText(s) }));
  const storiesById = new Map(verifiedStories.map(s => [s.id, s]));

  const evidence = classifications
    .filter(c => SUPPORTED_TIERS.has(c.tier))
    .map(c => {
      const matchedFacts = (c.evidenceIds || [])
        .map(id => factsById.get(id))
        .filter(Boolean)
        .map(f => ({ id: f.id, fact: f.fact, employer: f.employer ?? null, category: f.category ?? null }));
      const matchedStories = classifyRequirement(c.label, storyFacts).evidenceIds
        .map(id => storiesById.get(id))
        .map(s => ({ id: s.id, employer: s.employer ?? null, situation: s.situation, task: s.task, action: s.action, result: s.result }));
      return {
        requirement: c.label,
        tier: c.tier,
        facts: matchedFacts,
        stories: matchedStories,
        storyNote: matchedStories.length ? '' : 'No verified STAR story on file for this requirement. Add one in the Evidence Vault.',
      };
    })
    .filter(e => e.facts.length || e.stories.length);

  const gaps = classifications
    .filter(c => GAP_TIERS.has(c.tier))
    .map(c => ({
      requirement: c.label,
      tier: c.tier,
      reason: c.reason || '',
      openQuestionId: openQuestions.find(q => q.requirementLabel === c.label)?.id ?? null,
    }));

  const roundKey = roundType && ROUND_QUESTIONS_TO_ASK[roundType] ? roundType : 'general';
  const questionsToAsk = dedupe([...ROUND_QUESTIONS_TO_ASK[roundKey], ...baseQuestionsToAsk]);

  const briefing = {
    company: opp.company || '',
    title: opp.title || '',
    stage: opp.stage || '',
    stageLabel,
    location: opp.location || '',
    compensation: opp.compensation || opp.salary || '',
    seniority: parsedJd?.seniority ?? null,
    domains: Array.isArray(parsedJd?.domain) ? parsedJd.domain : [],
    responsibilities: (parsedJd?.responsibilities || []).map(r => r.text).filter(Boolean).slice(0, 6),
    fit: fit?.available ? { overallScore: fit.overallScore, pursuitClassification: fit.pursuitClassification } : null,
    hardBlockers: fit?.available ? (fit.hardBlockers || []).map(b => b.description).filter(Boolean) : [],
    jdReason: fit?.available ? '' : (fit?.reason || 'No usable job description saved.'),
  };

  const checklist = [
    { id: 'jd', label: 'Job description saved', done: Boolean(fit?.available), detail: fit?.available ? '' : briefing.jdReason },
    { id: 'resume', label: 'Tailored resume generated', done: resumeVersionCount > 0, detail: '' },
    { id: 'round_scheduled', label: 'Next interview round scheduled with a date', done: Boolean(nextRound?.scheduledAt), detail: nextRound ? '' : 'No upcoming round recorded.' },
    { id: 'interviewers', label: 'Interviewers identified for the next round', done: Boolean(nextRound?.contactIds?.length), detail: '' },
    { id: 'open_questions', label: 'Open candidate questions answered', done: openQuestions.length === 0, detail: openQuestions.length ? `${openQuestions.length} open` : '' },
    { id: 'stories', label: 'Verified STAR stories in the Evidence Vault', done: verifiedStories.length > 0, detail: verifiedStories.length ? `${verifiedStories.length} verified` : 'No verified stories yet.' },
  ];

  return {
    nextRound,
    roundType,
    roundTypeLabel: roundType ? roundTypeLabel(roundType) : '',
    briefing,
    likelyQuestions: buildLikelyQuestions({ opp, roundType, classifications }),
    evidence,
    gaps,
    questionsToAsk,
    checklist,
    evidencePolicy: 'Only verified candidate evidence is shown. Requirements without verified evidence are listed as gaps, not filled in.',
  };
}
