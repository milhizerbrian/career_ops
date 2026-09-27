// Phase 0: validates generated resume claims against the canonical
// candidate fact store (lib/candidate-data.mjs). Scoped narrowly to
// numeric claims — dollar amounts and percentages — since those are the
// highest-risk fabrication surface and the least likely to false-positive
// on legitimate paraphrasing of verified facts.
//
// This module never reads files or env vars itself; callers pass in the
// verified fact list and the enforcement mode, keeping it pure and easy
// to unit test.

const MONEY_RE = /\$[\d,.]+\s*[KMB]?\+?/gi;
const PERCENT_RE = /\b\d+(?:\.\d+)?%/g;

function normalizeToken(token) {
  return String(token ?? '').replace(/\s+/g, '').toLowerCase();
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildSupportedCorpus(candidateFacts) {
  return String(candidateFacts.map(f => f.fact).join(' \n ')).toLowerCase();
}

// Plain substring search would let "20%" false-match inside "120%", or
// "8 accounts" false-match inside "18 accounts". Guard both sides with a
// digit/currency-aware boundary so only a genuine, whole-number match counts.
function corpusContainsToken(corpus, token) {
  const escaped = escapeRegExp(normalizeToken(token));
  if (!escaped) return false;
  const pattern = new RegExp(`(?<![0-9$.,])${escaped}(?![0-9])`, 'i');
  return pattern.test(corpus);
}

/**
 * Extracts $ and % tokens from a piece of generated text.
 */
export function extractNumericClaims(text) {
  const tokens = new Set();
  for (const m of String(text ?? '').matchAll(MONEY_RE)) tokens.add(m[0].trim());
  for (const m of String(text ?? '').matchAll(PERCENT_RE)) tokens.add(m[0]);
  return [...tokens];
}

/**
 * Scans every field in `replacements` for numeric ($ / %) claims and checks
 * each one appears verbatim (whitespace/case-insensitive) somewhere in the
 * verified candidate fact corpus. Returns the list of unsupported claims;
 * an empty array means every numeric claim is traceable to verified evidence.
 */
export function findUnsupportedClaims(replacements, candidateFacts) {
  const facts = Array.isArray(candidateFacts) ? candidateFacts : [];
  const corpus = buildSupportedCorpus(facts);
  const corpusNormalized = normalizeToken(corpus);
  const unsupported = [];

  for (const [field, rawValue] of Object.entries(replacements ?? {})) {
    const value = String(rawValue ?? '');
    for (const token of extractNumericClaims(value)) {
      if (!corpusContainsToken(corpusNormalized, token)) {
        unsupported.push({ field, text: token, context: value.trim().slice(0, 160) });
      }
    }
  }
  return unsupported;
}

/**
 * mode: 'off' — skip entirely (returns no claims, never blocking).
 *       'warn' — claims are returned but blocking is always false.
 *       'block' — blocking is true when any unsupported claim is found.
 * Facts with zero entries (candidate data not migrated yet) short-circuits
 * to a no-op result rather than flagging every claim as unsupported — a
 * missing/empty fact store must never fail generation.
 */
export function validateGeneratedClaims(replacements, candidateFacts, { mode = 'off' } = {}) {
  if (mode === 'off') return { claims: [], blocking: false };
  const facts = Array.isArray(candidateFacts) ? candidateFacts : [];
  if (facts.length === 0) return { claims: [], blocking: false };
  const claims = findUnsupportedClaims(replacements, facts);
  return { claims, blocking: mode === 'block' && claims.length > 0 };
}

// ── Phase 10: general factual-claim check for short generated text ─────────
// Used for AI-written thank-you notes. Stricter than the numeric check
// above: any number, "N years"/vague-tenure phrase, proper noun or acronym
// (employers, products, certifications, titles), certification/degree word,
// or job-title word must be found in `supportTexts` (the verified facts,
// notes, and role/contact details the model was given). Callers treat any
// hit as "cannot establish support" and fall back to deterministic text.
// ponytail: heuristic, English-only, conservative — it rejects some
// harmless phrasing (safe direction). Tune the allowlists if good drafts
// fall back too often.
const ALWAYS_ALLOWED_WORDS = new Set([
  'i', "i'm", "i've", "i'd", "i'll", 'hi', 'hello', 'hey', 'dear', 'thank', 'thanks', 'best', 'regards',
  'sincerely', 'cheers', 'warmly', 'warm', 'subject', 're', 'brian', 'ok',
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
  'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december',
]);
const SENTENCE_STARTERS = new Set([
  'the', 'this', 'that', 'these', 'those', 'it', "it's", 'its', 'our', 'your', 'my', 'we', 'you', 'please', 'again',
  'also', 'as', 'after', 'before', 'since', 'if', 'when', 'while', 'with', 'from', 'in', 'on', 'at', 'for', 'to',
  'and', 'but', 'so', 'given', 'great', 'overall', 'really', 'hope', 'happy', 'glad', 'appreciate', 'let', 'have',
  'had', 'was', 'is', 'are', 'all', 'what', 'how', 'our', 'one', 'there', 'here', 'thank', 'thanks',
]);
const NUMBER_WORDS = 'one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty';
const TENURE_PATTERNS = [
  new RegExp(`\\b(?:${NUMBER_WORDS})\\s*\\+?\\s+years?\\b`, 'gi'),
  /\b(?:many|several|numerous|countless|multiple)\s+years\b/gi,
  /\b(?:over|more than|nearly|almost|about)\s+a\s+decade\b/gi,
  /\ba\s+decade\b/gi,
  /\bdecades\b/gi,
];
const CREDENTIAL_WORDS = /\b(?:certified|certifications?|certificates?|licensed|licen[sc]e|degree|mba|phd|bachelor'?s?|master'?s)\b/gi;
const TITLE_WORDS = /\b(?:director|manager|vp|vice president|head of|principal|architect|engineer|chief|president|founder|consultant|specialist|analyst|executive)\b/gi;

function escapeWord(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function corpusHasWord(corpusLower, word) {
  return new RegExp(`(?<![a-z0-9])${escapeWord(word.toLowerCase())}(?![a-z0-9])`).test(corpusLower);
}

function capitalizedPhrases(text) {
  const phrases = [];
  for (const sentence of String(text).split(/[.!?]+\s+|\n+/)) {
    const words = sentence.trim().split(/\s+/).filter(Boolean);
    let current = [];
    const flush = () => { if (current.length) phrases.push(current.join(' ')); current = []; };
    words.forEach((raw, idx) => {
      const word = raw.replace(/^[("'“‘]+|[)"'”’,;:!?.]+$/g, '');
      const isCap = /^[A-Z][A-Za-z0-9&+'’.-]*$/.test(word);
      const lower = word.toLowerCase();
      const neutral = !isCap
        || ALWAYS_ALLOWED_WORDS.has(lower)
        || (idx === 0 && (SENTENCE_STARTERS.has(lower) || /(?:ing|ed)$/.test(lower)) && word !== word.toUpperCase());
      if (neutral) flush();
      else current.push(word);
      if (/[,;:)]$/.test(raw)) flush();
    });
    flush();
  }
  return phrases;
}

export function findUnsupportedFactualClaims(text, supportTexts = []) {
  const value = String(text ?? '');
  const corpus = (Array.isArray(supportTexts) ? supportTexts : []).filter(Boolean).join(' \n ');
  const corpusLower = corpus.toLowerCase();
  const corpusCompact = normalizeToken(corpus);
  const flagged = [];
  const flag = claim => { if (claim && !flagged.includes(claim)) flagged.push(claim); };

  for (const m of value.matchAll(/\d[\d,.]*/g)) {
    const token = m[0].replace(/[.,]+$/, '');
    if (!corpusContainsToken(corpusCompact, token)) flag(token);
  }
  for (const pattern of TENURE_PATTERNS) {
    for (const m of value.matchAll(pattern)) if (!corpusLower.includes(m[0].toLowerCase())) flag(m[0]);
  }
  for (const pattern of [CREDENTIAL_WORDS, TITLE_WORDS]) {
    for (const m of value.matchAll(pattern)) if (!corpusHasWord(corpusLower, m[0])) flag(m[0]);
  }
  for (const phrase of capitalizedPhrases(value)) {
    const supported = corpusHasWord(corpusLower, phrase) || phrase.split(' ').every(w => corpusHasWord(corpusLower, w));
    if (!supported) flag(phrase);
  }
  return flagged;
}
