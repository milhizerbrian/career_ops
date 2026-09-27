// Shared word/number-boundary-safe substring matching.
//
// Plain `.includes()` produces false positives on numeric or short tokens
// ("20%" matching inside "120%", "5M" matching inside "65M", "8" matching
// inside "18"). This mirrors the fix already applied in
// lib/evidence-validator.mjs and scripts/migrate-candidate-data.mjs during
// Phase 0, generalized for reuse by Phase 2's JD parsing and evidence
// matching.

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * True if `term` appears in `text` as a whole token, not as a substring of
 * a larger number or word.
 */
export function containsTerm(text, term) {
  if (!text || !term) return false;
  const haystack = String(text);
  const needle = String(term).trim();
  if (!needle) return false;
  const esc = escapeRegExp(needle.toLowerCase());
  const lower = haystack.toLowerCase();
  if (/^[0-9]/.test(needle)) {
    // Numeric/currency-leading token: guard against digit/currency-symbol
    // characters immediately before or after (handles "$5M" vs "$65M",
    // "20%" vs "120%").
    return new RegExp(`(?<![0-9$.,])${esc}(?![0-9])`, 'i').test(lower);
  }
  return new RegExp(`\\b${esc}\\b`, 'i').test(lower);
}

/** Count of `terms` that appear (as whole tokens) in `text`. */
export function countTermHits(text, terms) {
  return (terms || []).filter(term => containsTerm(text, term)).length;
}

/** True if any of `terms` appears (as a whole token) in `text`. */
export function containsAnyTerm(text, terms) {
  return (terms || []).some(term => containsTerm(text, term));
}
