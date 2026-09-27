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
