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
const UNIT_NUMBER_RE = /(\d[\d,.]*)\s*(\+)?\s*(years?|months?|accounts?|clients?|customers?|direct reports?|reports?|deals?|logos?|renewals?|engineers?|employees?|team members?)\b/gi;
// Number-word binding: the words right after a number must appear with that
// number in ONE supporting text, so real numbers can't be recombined into
// new claims ("98% Net Revenue Retention" when the evidence says 98% Gross).
const METRIC_ABBREVIATIONS = [[/\bNRR\b/gi, 'net revenue retention'], [/\bGRR\b/gi, 'gross revenue retention']];
const METRIC_STOPWORDS = new Set(['of', 'in', 'to', 'with', 'by', 'across', 'and', 'or', 'the', 'a', 'an', 'for', 'on', 'from', 'at', 'as', 'over', 'per', 'into', 'through', 'while', 'that', 'which', 'including', 'within', 'after', 'before']);

function expandMetricAbbreviations(text) {
  return METRIC_ABBREVIATIONS.reduce((out, [pattern, full]) => out.replace(pattern, full), String(text ?? ''));
}

function metricBindings(text) {
  const bindings = [];
  for (const m of expandMetricAbbreviations(text).matchAll(/(\$?\d[\d,.]*%?[KMBkmb]?)((?:\s+[A-Za-z][A-Za-z-]*){1,3})/g)) {
    const words = [];
    for (const word of m[2].trim().split(/\s+/)) {
      const lower = word.toLowerCase();
      if (METRIC_STOPWORDS.has(lower)) break;
      words.push(lower);
    }
    if (words.length) bindings.push({ number: m[1].replace(/[.,]+$/, ''), words });
  }
  return bindings;
}

function bindingSupported({ number, words }, supportLower) {
  const numberRe = new RegExp(`(?<![0-9.,])${escapeRegExp(number.replace(/^\$/, '').toLowerCase())}(?![0-9])`);
  return supportLower.some(text => numberRe.test(text)
    && words.every(word => new RegExp(`(?<![a-z])${escapeRegExp(word.length >= 5 ? word.slice(0, 5) : word)}`).test(text)));
}

const TITLE_WORD_SET = new Set(['director', 'manager', 'vp', 'principal', 'architect', 'engineer', 'chief', 'president', 'founder', 'consultant', 'specialist', 'analyst', 'executive', 'lead', 'head']);
const CREDENTIAL_WORDS = /\b(?:certified|certifications?|certificates?|licensed|licen[sc]e|degree|mba|phd|bachelor'?s?|master'?s)\b/gi;
const TITLE_WORDS = /\b(?:director|manager|vp|vice president|head of|principal|architect|engineer|chief|president|founder|consultant|specialist|analyst|executive)\b/gi;

function escapeWord(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function corpusHasWord(corpusLower, word) {
  return new RegExp(`(?<![a-z0-9])${escapeWord(word.toLowerCase())}(?![a-z0-9])`).test(corpusLower);
}

function capitalizedPhrases(text, { strict = false } = {}) {
  const phrases = [];
  for (const sentence of String(text).split(/[.!?]+\s+|\n+/)) {
    const words = sentence.trim().split(/\s+/).filter(Boolean);
    let current = [];
    const flush = () => { if (current.length) phrases.push(current.join(' ')); current = []; };
    words.forEach((raw, idx) => {
      const word = raw.replace(/^[("'“‘]+|[)"'”’,;:!?.]+$/g, '');
      const isCap = /^[A-Z][A-Za-z0-9&+'’.-]*$/.test(word);
      const lower = word.toLowerCase();
      const nextWord = (words[idx + 1] || '').replace(/^[("'“‘]+/, '');
      const startsCapPhrase = /^[A-Z]/.test(nextWord) && !/[,;:)]$/.test(raw);
      // A lone capitalized first word is ordinary sentence case ("Brings",
      // "Leading"); a sentence that opens with a multi-word proper noun
      // ("Palo Alto Networks") or an acronym is still checked.
      const neutral = !isCap
        || ALWAYS_ALLOWED_WORDS.has(lower)
        || (!strict && idx === 0 && word !== word.toUpperCase() && (!startsCapPhrase || SENTENCE_STARTERS.has(lower) || /(?:ing|ed)$/.test(lower)));
      if (neutral) flush();
      else current.push(word);
      if (/[,;:)]$/.test(raw)) flush();
    });
    flush();
  }
  return phrases;
}

/**
 * @param {object} [options]
 * @param {boolean} [options.strict] treat text as a list item, not a sentence:
 *   a leading capitalized word is checked too (e.g. "Kubernetes").
 */
export function findUnsupportedFactualClaims(text, supportTexts = [], { strict = false } = {}) {
  const value = String(text ?? '');
  const corpus = (Array.isArray(supportTexts) ? supportTexts : []).filter(Boolean).join(' \n ');
  // Standard metric abbreviations count as supported where the full term is.
  const corpusLower = METRIC_ABBREVIATIONS.reduce(
    (out, [pattern, full]) => (out.includes(full) ? `${out} ${pattern.source.replace(/\\b/g, '').toLowerCase()}` : out),
    corpus.toLowerCase(),
  );
  const corpusCompact = normalizeToken(corpus);
  const flagged = [];
  const flag = claim => { if (claim && !flagged.includes(claim)) flagged.push(claim); };

  for (const m of value.matchAll(/\d[\d,.]*/g)) {
    const token = m[0].replace(/[.,]+$/, '');
    // Whole-number match; a currency sign before it is fine ("$23M" supports "23").
    const pattern = new RegExp(`(?<![0-9.,])${escapeRegExp(normalizeToken(token))}(?![0-9])`, 'i');
    if (!pattern.test(corpusCompact)) flag(token);
  }
  // A number that carries a unit must be supported together with that unit:
  // "22% retention" does not support "22+ years" or "22 accounts".
  for (const m of value.matchAll(UNIT_NUMBER_RE)) {
    const number = m[1].replace(/[.,]+$/, '');
    const unitRoot = m[3].toLowerCase().replace(/s$/, '');
    const pattern = new RegExp(`(?<![0-9.,])${escapeRegExp(number)}\\+?\\s*${escapeRegExp(unitRoot)}`, 'i');
    if (!pattern.test(corpusLower)) flag(m[0].trim());
  }
  const supportLower = (Array.isArray(supportTexts) ? supportTexts : []).filter(Boolean)
    .map(text => expandMetricAbbreviations(text).toLowerCase());
  for (const binding of metricBindings(value)) {
    if (!bindingSupported(binding, supportLower)) flag(`${binding.number} ${binding.words.join(' ')}`);
  }
  for (const pattern of TENURE_PATTERNS) {
    for (const m of value.matchAll(pattern)) if (!corpusLower.includes(m[0].toLowerCase())) flag(m[0]);
  }
  for (const pattern of [CREDENTIAL_WORDS, TITLE_WORDS]) {
    for (const m of value.matchAll(pattern)) if (!corpusHasWord(corpusLower, m[0])) flag(m[0]);
  }
  for (const phrase of capitalizedPhrases(value, { strict })) {
    const words = phrase.split(' ');
    // A phrase naming a job title must contain a real two-word title
    // ("Success Engineer"), so held-title words can't be recombined into a
    // title never held ("Security Engineer").
    const titleIndex = words.findIndex(w => TITLE_WORD_SET.has(w.toLowerCase()));
    const titleOk = titleIndex < 1 || corpusHasWord(corpusLower, words.slice(titleIndex - 1, titleIndex + 1).join(' '));
    const supported = titleOk && (corpusHasWord(corpusLower, phrase) || words.every(w => corpusHasWord(corpusLower, w)));
    if (!supported) flag(phrase);
  }
  return flagged;
}
