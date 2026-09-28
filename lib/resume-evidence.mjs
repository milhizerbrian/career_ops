// Resume evidence enforcement. Every factual career claim in a generated
// resume must trace to canonical, verified candidate evidence
// (career-evidence/candidate/*.json via loadCandidateFacts(): verified === true AND
// allowed_in_resume === true).
//
// Rules, per field:
//   - Role fields (JOB_n_*) are checked only against that role's employer's
//     facts plus employer-less facts (skills, certifications), so one
//     employer's dates or numbers can't vouch for another's.
//   - Bullets and key achievements must (a) contain no unsupported factual
//     token (numbers, tenure, proper nouns/acronyms, titles, credentials) and
//     (b) substantially match one specific verified fact. Removing numbers
//     from an unsupported claim is not enough to pass.
//   - Rejected bullets/achievements are replaced by an unused verified
//     achievement (JD-relevant first); if none remains the bullet is omitted.
//     Nothing is invented to fill space.
//   - Summary sentences, metrics segments, competency items, and the title
//     line are filtered item by item; unsupported pieces are dropped.
//   - A verified fact is used at most once; near-duplicate text is removed.
import { findUnsupportedFactualClaims } from './evidence-validator.mjs';

const STOPWORDS = new Set([
  'across', 'through', 'with', 'from', 'that', 'this', 'these', 'those', 'their', 'into', 'while', 'over',
  'under', 'including', 'using', 'based', 'more', 'most', 'very', 'also', 'which', 'where', 'when', 'within',
  'while', 'about', 'after', 'before', 'during', 'between', 'each', 'other', 'such', 'than', 'then', 'them',
  'they', 'were', 'have', 'has', 'been', 'being', 'will', 'would', 'could', 'should', 'your', 'ours',
]);
const MIN_FACT_OVERLAP = 0.5;
// A rewritten (non-verbatim) bullet may add at most ~20% new words to its
// matched fact; bigger rewrites change the claim, so the fact is used instead.
const MIN_PARAPHRASE_OVERLAP = 0.8;
const NEAR_DUPLICATE = 0.7;
const REPEATED_PHRASE_WORDS = 6;

function cleanFact(text) {
  const out = String(text ?? '')
    .replace(/\s+—\s+|—/g, ', ')
    .replace(/\s+/g, ' ')
    .trim();
  return out && !/[.!?]$/.test(out) ? `${out}.` : out;
}

function normalize(text) {
  return String(text ?? '').toLowerCase().replace(/[^a-z0-9$%]+/g, ' ').trim();
}

function contentWords(text) {
  return [...new Set(normalize(text).split(' ').filter(w => w.length >= 4 && !STOPWORDS.has(w)))];
}

function overlap(text, factText) {
  const words = contentWords(text);
  if (!words.length) return 0;
  const factWords = new Set(contentWords(factText));
  return words.filter(w => factWords.has(w)).length / words.length;
}

function jaccard(a, b) {
  const A = new Set(contentWords(a));
  const B = new Set(contentWords(b));
  if (!A.size || !B.size) return 0;
  const inter = [...A].filter(w => B.has(w)).length;
  return inter / (A.size + B.size - inter);
}

function roleIndexOf(field) {
  const m = String(field).match(/^JOB_(\d+)_/);
  return m ? Number(m[1]) : null;
}

/**
 * The part of a verified employer record after "Employer — Title," (dates,
 * location, products). Used as a role context line, since the template's
 * role header already shows employer and title.
 */
function employerContext(fact) {
  const afterDash = String(fact ?? '').split(/\s+—\s+|—/).slice(1).join(' ');
  const rest = afterDash.includes(',') ? afterDash.slice(afterDash.indexOf(',') + 1) : afterDash;
  return cleanFact(rest.trim());
}

export function buildEvidenceIndex(facts = []) {
  const verified = (Array.isArray(facts) ? facts : []).filter(f => f && f.verified === true && f.allowed_in_resume === true && f.fact);
  const employers = verified.filter(f => f.category === 'employer').sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const general = verified.filter(f => !f.employer);
  return {
    verified,
    employers,
    canonical: new Set([
      ...verified.map(f => normalize(cleanFact(f.fact))),
      ...employers.map(f => normalize(employerContext(f.fact))),
    ]),
    employerFor(roleIndex) {
      return employers[roleIndex - 1]?.employer ?? null;
    },
    scopeFacts(field) {
      const roleIndex = roleIndexOf(field);
      if (!roleIndex) return verified;
      const employer = this.employerFor(roleIndex);
      return verified.filter(f => f.employer === employer || !f.employer);
    },
  };
}

export function isCanonicalEvidenceText(index, text) {
  return index.canonical.has(normalize(cleanFact(text)));
}

function unsupportedTokens(text, scope, options = {}) {
  return findUnsupportedFactualClaims(text, scope.map(f => f.fact), options);
}

function bestFact(text, scope) {
  let best = null;
  let score = 0;
  for (const fact of scope) {
    if (fact.category !== 'achievement' && fact.category !== 'metric') continue;
    const s = overlap(text, fact.fact);
    if (s > score) { best = fact; score = s; }
  }
  return { fact: best, score };
}

function jdRelevance(factText, jdWords) {
  return contentWords(factText).filter(w => jdWords.has(w)).length;
}

const BULLET_FIELD = /^(JOB_\d+_BULLET_\d+|KEY_ACHIEVEMENT_\d+)$/;
const LINE_FIELDS = new Set(['TITLE_LINE', 'METRICS_LINE', 'CORE_COMPETENCIES', 'CERTIFICATIONS_LINE']);

function filterLineField(field, value, scope) {
  const segments = String(value ?? '').split(/\s*\|\s*/).filter(Boolean);
  const kept = [];
  for (const segment of segments) {
    const labelMatch = field === 'CORE_COMPETENCIES' ? segment.match(/^([^:]{1,60}):\s*(.*)$/) : null;
    if (labelMatch) {
      const items = labelMatch[2].split(/\s*,\s*/).filter(Boolean)
        .filter(item => !unsupportedTokens(item, scope, { strict: true }).length);
      if (items.length) kept.push(`${labelMatch[1]}: ${items.join(', ')}`);
      continue;
    }
    if (field === 'CERTIFICATIONS_LINE' || field === 'CORE_COMPETENCIES') {
      const items = segment.split(/\s*,\s*/).filter(Boolean).filter(item => !unsupportedTokens(item, scope, { strict: true }).length);
      if (items.length) kept.push(items.join(', '));
      continue;
    }
    if (!unsupportedTokens(segment, scope).length) kept.push(segment);
  }
  return kept.join(' | ');
}

function mostRecentTitle(index) {
  const fact = index.employers[0]?.fact ?? '';
  return fact.split(/\s+—\s+|—/)[1]?.split(',')[0]?.trim() ?? '';
}

/**
 * @param {object} replacements  field -> text
 * @param {string[]} fields
 * @param {object} index         buildEvidenceIndex(facts)
 * @param {object} options
 * @param {string} options.jdText
 * @param {(field: string, text: string) => boolean} options.qualityCheck  model-text quality rule (verified facts are exempt)
 */
export function enforceResumeEvidence(replacements, fields, index, { jdText = '', qualityCheck = () => true } = {}) {
  const out = { ...replacements };
  const report = { rejected: [], replaced: [], omitted: [] };
  const used = new Set();
  const acceptedTexts = [];
  const jdWords = new Set(contentWords(jdText));

  const reject = (field, text, reason) => report.rejected.push({ field, text: String(text).slice(0, 200), reason });

  const pickReplacement = (field) => {
    const scope = index.scopeFacts(field);
    const isKey = /^KEY_ACHIEVEMENT_/.test(field);
    const pool = scope
      .filter(f => f.category === 'achievement' && !used.has(f.id))
      .filter(f => !acceptedTexts.some(t => jaccard(t, f.fact) >= NEAR_DUPLICATE))
      .map((f, i) => ({ f, i, rel: jdRelevance(f.fact, jdWords), num: /\d/.test(f.fact) ? 1 : 0 }))
      .sort((a, b) => (isKey ? b.num - a.num : 0) || b.rel - a.rel || a.i - b.i);
    return pool[0]?.f ?? null;
  };

  // Key achievements first so role bullets don't reuse the same fact.
  const bulletFields = fields.filter(f => BULLET_FIELD.test(f))
    .sort((a, b) => Number(/^JOB_/.test(a)) - Number(/^JOB_/.test(b)));

  for (const field of bulletFields) {
    const text = String(out[field] ?? '').trim();
    if (!text) continue;
    const scope = index.scopeFacts(field);
    const canonical = isCanonicalEvidenceText(index, text);
    const bad = unsupportedTokens(text, scope);
    const { fact, score } = bestFact(text, scope);
    // Claims in a paraphrase must come from its matched fact (plus that
    // employer's record), not from anywhere in the employer's evidence.
    const ownSupport = fact ? [fact, ...index.employers.filter(e => e.employer === fact.employer)] : [];
    const drift = !canonical && fact ? unsupportedTokens(text, ownSupport) : [];
    let reason = '';
    if (bad.length) reason = `unsupported: ${bad.slice(0, 5).join(', ')}`;
    else if (!fact || score < MIN_FACT_OVERLAP) reason = 'no matching verified fact';
    else if (!canonical && score < MIN_PARAPHRASE_OVERLAP) reason = `rewrite departs from its verified fact (${Math.round(score * 100)}% match)`;
    else if (drift.length) reason = `not in its matched fact: ${drift.slice(0, 5).join(', ')}`;
    else if (used.has(fact.id)) reason = `duplicate of already-used fact ${fact.id}`;
    else if (acceptedTexts.some(t => jaccard(t, text) >= NEAR_DUPLICATE)) reason = 'near-duplicate of another bullet';
    else if (!canonical && !qualityCheck(field, text)) reason = 'failed quality rules';

    if (!reason) {
      used.add(fact.id);
      acceptedTexts.push(text);
      continue;
    }
    reject(field, text, reason);
    const replacement = pickReplacement(field);
    if (replacement) {
      used.add(replacement.id);
      out[field] = cleanFact(replacement.fact);
      acceptedTexts.push(out[field]);
      report.replaced.push({ field, factId: replacement.id });
    } else {
      out[field] = '';
      report.omitted.push(field);
    }
  }

  for (const field of fields) {
    const value = String(out[field] ?? '').trim();
    if (!value || BULLET_FIELD.test(field)) continue;
    const scope = index.scopeFacts(field);

    if (/^JOB_\d+_CONTEXT$/.test(field)) {
      const bad = unsupportedTokens(value, scope);
      const weak = !bad.length && !isCanonicalEvidenceText(index, value) && !qualityCheck(field, value);
      if (bad.length || weak) {
        reject(field, value, bad.length ? `unsupported: ${bad.slice(0, 5).join(', ')}` : 'failed quality rules');
        const employerFact = index.employers[roleIndexOf(field) - 1];
        out[field] = employerFact ? employerContext(employerFact.fact) : '';
        report.replaced.push({ field, factId: employerFact?.id ?? null });
      }
      continue;
    }

    if (field === 'PROFESSIONAL_SUMMARY') {
      const sentences = value.match(/[^.!?]+[.!?]*/g)?.map(s => s.trim()).filter(Boolean) ?? [];
      const kept = sentences.filter(sentence => {
        const bad = unsupportedTokens(sentence, scope);
        if (bad.length) {
          reject(field, sentence, `unsupported: ${bad.slice(0, 5).join(', ')}`);
          return false;
        }
        // A sentence stating a metric must closely match one verified fact.
        if (/\d/.test(sentence) && !isCanonicalEvidenceText(index, sentence) && bestFact(sentence, scope).score < MIN_FACT_OVERLAP) {
          reject(field, sentence, 'metric claim does not match a single verified fact');
          return false;
        }
        return true;
      });
      if (kept.length > 3) reject(field, kept.slice(3).join(' '), 'summary limited to 3 sentences');
      out[field] = kept.slice(0, 3).join(' ');
      continue;
    }

    if (LINE_FIELDS.has(field)) {
      const filtered = filterLineField(field, value, scope);
      if (filtered !== value) reject(field, value, 'unsupported item(s) removed');
      out[field] = filtered || (field === 'TITLE_LINE' ? mostRecentTitle(index) : '');
    }
  }

  return { replacements: out, report };
}

/**
 * Final gate before a resume is marked successful. Returns a list of issues;
 * an empty list means every factual claim traces to verified evidence and
 * no serialized objects or repeated filler phrases remain.
 */
export function verifyResumeEvidence(replacements, fields, index) {
  const issues = [];
  const texts = [];
  for (const field of fields) {
    const value = String(replacements?.[field] ?? '').trim();
    if (!value) continue;
    if (/\[object Object\]/.test(value)) {
      issues.push(`${field}: serialized object instead of text`);
      continue;
    }
    const scope = index.scopeFacts(field);
    if (LINE_FIELDS.has(field)) {
      if (filterLineField(field, value, scope) !== value) issues.push(`${field}: unsupported item(s)`);
    } else {
      const bad = unsupportedTokens(value, scope);
      if (bad.length) issues.push(`${field}: unsupported ${bad.slice(0, 5).join(', ')}`);
      else if (field === 'PROFESSIONAL_SUMMARY') {
        for (const sentence of value.match(/[^.!?]+[.!?]*/g) ?? []) {
          if (/\d/.test(sentence) && !isCanonicalEvidenceText(index, sentence) && bestFact(sentence, scope).score < MIN_FACT_OVERLAP) {
            issues.push(`${field}: metric claim does not match a single verified fact ("${sentence.trim().slice(0, 80)}")`);
          }
        }
      } else if (BULLET_FIELD.test(field)) {
        const { fact, score } = bestFact(value, scope);
        if (score < MIN_FACT_OVERLAP) issues.push(`${field}: no matching verified fact`);
        else if (!isCanonicalEvidenceText(index, value)) {
          const drift = unsupportedTokens(value, [fact, ...index.employers.filter(e => e.employer === fact.employer)]);
          if (drift.length) issues.push(`${field}: not in its matched fact ${drift.slice(0, 5).join(', ')}`);
          else if (score < MIN_PARAPHRASE_OVERLAP) issues.push(`${field}: rewrite departs from its verified fact`);
        }
      }
    }
    texts.push({ field, words: normalize(value).split(' ').filter(Boolean) });
  }

  const seen = new Map();
  for (const { field, words } of texts) {
    const grams = new Set();
    for (let i = 0; i + REPEATED_PHRASE_WORDS <= words.length; i += 1) grams.add(words.slice(i, i + REPEATED_PHRASE_WORDS).join(' '));
    for (const gram of grams) {
      if (seen.has(gram) && seen.get(gram) !== field) {
        issues.push(`${field}: repeated phrase "${gram}" (also in ${seen.get(gram)})`);
      } else if (!seen.has(gram)) {
        seen.set(gram, field);
      }
    }
  }
  return [...new Set(issues)];
}

/**
 * One verified achievement (JD-relevant first) that no resume field already
 * states, for extending a thin summary without inventing anything. Returns
 * null when every verified achievement is already used.
 */
export function evidenceSummarySentences(replacements, fields, index, { jdText = '', limit = 2 } = {}) {
  const texts = fields.map(field => String(replacements?.[field] ?? '')).filter(Boolean);
  const jdWords = new Set(contentWords(jdText));
  const picked = [];
  const pool = index.verified
    .filter(f => f.category === 'achievement')
    .filter(f => !texts.some(t => overlap(t, f.fact) >= MIN_FACT_OVERLAP || jaccard(t, f.fact) >= 0.3))
    .map((f, i) => ({ f, i, rel: jdRelevance(f.fact, jdWords) }))
    .sort((a, b) => b.rel - a.rel || a.i - b.i);
  for (const { f } of pool) {
    if (picked.length >= limit) break;
    if (picked.some(p => jaccard(p, f.fact) >= 0.3)) continue;
    picked.push(cleanFact(f.fact));
  }
  return picked;
}

/** First of evidenceSummarySentences(), or null. */
export function evidenceSummarySentence(replacements, fields, index, options = {}) {
  return evidenceSummarySentences(replacements, fields, index, { ...options, limit: 1 })[0] ?? null;
}
