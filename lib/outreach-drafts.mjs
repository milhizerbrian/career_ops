import { loadBragDoc } from './data.mjs';
import { getLmStudioAnalysisModel } from './lm-studio-config.mjs';
import { normalizeContacts } from './job-contacts.mjs';
import { HUMANIZED_OUTPUT_RULES } from './humanizer.mjs';
import { loadCandidateFacts } from './candidate-data.mjs';
import { findUnsupportedClaims, findUnsupportedFactualClaims } from './evidence-validator.mjs';
import { normalizeInterviewRounds, roundTypeLabel } from './interview-rounds.mjs';
import { containsAnyTerm } from './text-match-utils.mjs';

export const OUTREACH_DRAFT_TYPES = [
  'linkedin_connection',
  'linkedin_follow_up',
  'email',
  'thank_you', // Phase 9.5: post-interview thank-you, tied to one interview round
];

const TYPE_SET = new Set(OUTREACH_DRAFT_TYPES);
const LM_STUDIO_BASE = 'http://localhost:1234';

function cleanString(value, max = 4000) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function sentence(value) {
  return cleanString(value, 240).replace(/\s+/g, ' ');
}

function firstUsefulLine(value) {
  return cleanString(value, 2000)
    .split('\n')
    .map(line => line.trim())
    .find(line => line.length >= 35 && !line.startsWith('#')) || '';
}

export function validateOutreachDraftPayload(payload = {}) {
  const contactId = cleanString(payload.contactId, 100);
  const type = cleanString(payload.type, 40) || 'linkedin_connection';
  if (!contactId) throw new Error('contactId is required');
  if (!TYPE_SET.has(type)) throw new Error(`Invalid outreach draft type: ${type}`);
  if (type === 'thank_you') {
    const roundId = cleanString(payload.roundId, 100);
    if (!roundId) throw new Error('roundId is required for thank_you drafts');
    return { contactId, type, roundId };
  }
  return { contactId, type };
}

// ── Phase 9.5: thank-you drafts ─────────────────────────────────────────
// Inputs are the round's own notes plus verified candidate facts only
// (verified + allowed_in_resume) — never the master brag doc. LM Studio
// output is checked with evidence-validator: $ / % claims must be in the
// verified facts, and every other factual token (numbers, tenure phrases,
// proper nouns/acronyms, titles, credentials) must be in the text the model
// was given. Any unsupported claim discards the AI text in favour of a
// claim-free template.
const THANK_YOU_STOPWORDS = new Set(['about', 'their', 'there', 'which', 'would', 'could', 'should', 'these', 'those', 'where', 'while', 'after', 'before', 'being', 'really', 'things', 'discussed', 'talked']);
const MAX_THANK_YOU_FACTS = 6;

function relevantVerifiedFacts(facts, text) {
  const terms = [...new Set(String(text || '').toLowerCase().match(/[a-z][a-z-]{4,}/g) || [])]
    .filter(t => !THANK_YOU_STOPWORDS.has(t));
  if (!terms.length) return [];
  return facts.filter(f => containsAnyTerm(f.fact, terms)).slice(0, MAX_THANK_YOU_FACTS);
}

export function buildThankYouFallback({ job = {}, contact = {}, round = {} } = {}) {
  const company = sentence(job.company || contact.company || 'your team');
  const title = sentence(job.title || 'the role');
  const firstName = sentence(contact.name).split(/\s+/)[0] || 'there';
  const roundLabel = roundTypeLabel(round.roundType).toLowerCase();
  return [
    `Subject: Thank you - ${title} at ${company}`,
    '',
    `Hi ${firstName},`,
    '',
    `Thank you for taking the time to meet with me for the ${roundLabel} conversation about the ${title} role at ${company}.`,
    'I appreciated learning more about the team and the priorities for this role, and our discussion reinforced my interest.',
    'Please let me know if there is anything else I can share as you move forward.',
    '',
    'Best,',
    'Brian',
  ].join('\n');
}

async function generateThankYouWithLmStudio({ job, contact, round, facts, fetchImpl = fetch } = {}) {
  const model = getLmStudioAnalysisModel();
  const prompt = [
    'Write a short post-interview thank-you email for a senior cybersecurity customer success candidate.',
    'Use ONLY the interview notes and the verified candidate facts below. Do not invent accomplishments, metrics, skills, relationships, or experience.',
    'If no verified facts are listed, do not mention any accomplishments. Return only the email text with subject, greeting, body, and signature "Brian".',
    HUMANIZED_OUTPUT_RULES,
    '',
    `Company: ${job.company || ''}`,
    `Job title: ${job.title || ''}`,
    `Interviewer: ${contact.name || ''}${contact.title ? ` (${contact.title})` : ''}`,
    `Round: ${roundTypeLabel(round.roundType)}`,
    `Interview notes:\n${cleanString(round.notes, 2000) || '(none)'}`,
    '',
    `Verified candidate facts:\n${facts.length ? facts.map(f => `- ${f.fact}`).join('\n') : '(none)'}`,
  ].join('\n');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const res = await fetchImpl(`${LM_STUDIO_BASE}/v1/chat/completions`, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.3,
        max_tokens: 400,
      }),
    });
    if (!res.ok) throw new Error(`LM Studio HTTP ${res.status}`);
    const json = await res.json();
    return cleanString(json.choices?.[0]?.message?.content, 4000);
  } finally {
    clearTimeout(timer);
  }
}

async function createThankYouDraft(job, contact, roundId, options) {
  const round = normalizeInterviewRounds(job.interviews).find(r => r.id === roundId);
  if (!round) throw new Error(`Interview round not found: ${roundId}`);
  const verified = (options.candidateFacts ?? loadCandidateFacts())
    .filter(f => f && f.verified === true && f.allowed_in_resume === true);
  const facts = relevantVerifiedFacts(verified, `${round.notes} ${job.title || ''}`);

  let text = '';
  let unsupportedClaims = [];
  const useLmStudio = options.useLmStudio !== false && process.env.CAREER_OPS_DISABLE_LM_STUDIO !== '1';
  if (useLmStudio) {
    try {
      const generated = await generateThankYouWithLmStudio({ job, contact, round, facts, fetchImpl: options.fetchImpl });
      const support = [...facts.map(f => f.fact), round.notes, job.company, job.title, contact.name, contact.title, roundTypeLabel(round.roundType)];
      unsupportedClaims = [...new Set([
        ...findUnsupportedClaims({ text: generated }, facts).map(c => c.text),
        ...findUnsupportedFactualClaims(generated, support),
      ])];
      if (generated && !unsupportedClaims.length) text = generated;
    } catch {
      text = '';
    }
  }
  return {
    type: 'thank_you',
    text: text || buildThankYouFallback({ job, contact, round }),
    generatedAt: (options.now || new Date()).toISOString(),
    contactId: contact.id,
    roundId,
    source: text ? 'lm_studio' : 'fallback',
    unsupportedClaims,
  };
}

export function buildOutreachDraftFallback({ job = {}, contact = {}, bragDoc = '', type = 'linkedin_connection' } = {}) {
  const company = sentence(job.company || contact.company || 'your team');
  const title = sentence(job.title || 'the role');
  const contactName = sentence(contact.name).split(/\s+/)[0] || 'there';
  const contactRole = sentence(contact.title || contact.relationshipType || 'your team');
  const fit = sentence(job.report?.role_summary || job.score_analysis || job.next_steps || firstUsefulLine(bragDoc));
  const candidateFit = fit || 'my background spans cybersecurity customer success, technical account leadership, and enterprise stakeholder work';

  if (type === 'email') {
    return [
      `Subject: ${company} - ${title}`,
      '',
      `Hi ${contactName},`,
      '',
      `I noticed ${company} is hiring for ${title}, and the scope looks closely aligned with ${candidateFit}.`,
      `My background is strongest where cybersecurity customers, executive stakeholders, and post-sale outcomes meet, so I would welcome a quick conversation about what your ${contactRole} team needs most in this role.`,
      '',
      'Best,',
      'Brian',
    ].join('\n');
  }

  if (type === 'linkedin_follow_up') {
    return `Hi ${contactName} - following up on ${title} at ${company}. The role caught my attention because it maps to ${candidateFit}; I would appreciate any direction on whether my background is worth a closer look.`;
  }

  return `Hi ${contactName} - I noticed ${company} is hiring for ${title}. My background maps to ${candidateFit}, and I would value connecting if you are close to this search.`;
}

async function generateWithLmStudio({ job, contact, bragDoc, type, fetchImpl = fetch } = {}) {
  const model = getLmStudioAnalysisModel();
  const prompt = [
    'Write concise outreach text for a senior cybersecurity customer success candidate.',
    'Do not invent relationships, referrals, or credentials. Return only the message text.',
    type === 'email' ? 'Format as a short email with subject, greeting, body, and signature.' : 'Format as a short LinkedIn message without subject or signature.',
    HUMANIZED_OUTPUT_RULES,
    '',
    `Message type: ${type}`,
    `Company: ${job.company || ''}`,
    `Job title: ${job.title || ''}`,
    `Contact: ${contact.name || ''}`,
    `Contact role: ${contact.title || contact.relationshipType || ''}`,
    `Fit/evaluation: ${job.report?.role_summary || job.score_analysis || job.next_steps || ''}`,
    '',
    `Candidate evidence:\n${bragDoc.slice(0, 1800)}`,
  ].join('\n');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const res = await fetchImpl(`${LM_STUDIO_BASE}/v1/chat/completions`, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.3,
        max_tokens: 350,
      }),
    });
    if (!res.ok) throw new Error(`LM Studio HTTP ${res.status}`);
    const json = await res.json();
    return cleanString(json.choices?.[0]?.message?.content, 4000);
  } finally {
    clearTimeout(timer);
  }
}

export async function createOutreachDraft(job, payload = {}, options = {}) {
  if (!job || typeof job !== 'object') throw new Error('job is required');
  const { contactId, type, roundId } = validateOutreachDraftPayload(payload);
  const contacts = normalizeContacts(job.contacts);
  const contact = contacts.find(item => item.id === contactId);
  if (!contact) throw new Error(`Contact not found: ${contactId}`);
  if (type === 'thank_you') return createThankYouDraft(job, contact, roundId, options);

  const bragDoc = options.bragDoc ?? loadBragDoc();
  let text = '';
  const useLmStudio = options.useLmStudio !== false && process.env.CAREER_OPS_DISABLE_LM_STUDIO !== '1';
  if (useLmStudio) {
    try {
      text = await generateWithLmStudio({ job, contact, bragDoc, type, fetchImpl: options.fetchImpl });
    } catch {
      text = '';
    }
  }
  if (!text) text = buildOutreachDraftFallback({ job, contact, bragDoc, type });

  return {
    type,
    text,
    generatedAt: (options.now || new Date()).toISOString(),
    contactId,
  };
}

export async function generateAndStoreOutreachDraft(job, payload = {}, options = {}) {
  const draft = await createOutreachDraft(job, payload, options);
  storeOutreachDraft(job, draft);
  return draft;
}

export function storeOutreachDraft(job, draft) {
  const contacts = normalizeContacts(job.contacts);
  const idx = contacts.findIndex(contact => contact.id === draft.contactId);
  if (idx < 0) throw new Error(`Contact not found: ${draft.contactId}`);
  const existingDrafts = Array.isArray(contacts[idx].outreachDrafts) ? contacts[idx].outreachDrafts : [];
  contacts[idx] = {
    ...contacts[idx],
    outreachDrafts: [...existingDrafts, draft],
    updatedAt: draft.generatedAt,
  };
  job.contacts = contacts;
  return job;
}
