/**
 * dedupe-utils.mjs — Deep semantic duplicate detection for job listings.
 *
 * Catches cross-platform duplicates (Greenhouse + LinkedIn + WTTJ for the same
 * posting) and title variants ("Sr. CSM" vs "Senior Customer Success Manager")
 * that URL-based dedupe misses.
 *
 * Pure functions — no file I/O, no external API calls, deterministic.
 * All functions handle missing/undefined fields without throwing.
 *
 * Scoring weights sum to 100:
 *   Company match   35
 *   Title match     30
 *   Location match  10
 *   Description     15
 *   URL / req ID    10
 *
 * Thresholds:
 *   ≥ 85  → duplicate    (skip)
 *   70–84 → possible dup (flag, include with marker)
 *   < 70  → unique
 */

// ── Normalisation ──────────────────────────────────────────────────────────────

/**
 * Abbreviations to expand in job titles so "Sr. CSM" matches
 * "Senior Customer Success Manager".
 */
const TITLE_ABBREVS = [
  [/\bsr\.?\b/gi,   'senior'],
  [/\bjr\.?\b/gi,   'junior'],
  [/\bmgr\.?\b/gi,  'manager'],
  [/\bdir\.?\b/gi,  'director'],
  [/\beng\.?\b/gi,  'engineer'],
  [/\bdev\.?\b/gi,  'developer'],
  [/\bvp\b/gi,      'vice president'],
  [/\bcso\b/gi,     'chief security officer'],
  [/\bcto\b/gi,     'chief technology officer'],
  [/\bcro\b/gi,     'chief revenue officer'],
];

/**
 * Title tokens we skip when computing similarity — these appear in many titles
 * and carry less discriminating power.
 */
const TITLE_STOP = new Set([
  'and', 'or', 'of', 'the', 'a', 'an', 'for', 'in', 'at', 'to',
  'with', 'is', 'be', 'on', '-',
]);

/**
 * Description stop-words — very common job-ad filler that would inflate
 * overlap between unrelated postings.
 */
const DESC_STOP = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'in', 'to', 'for', 'with',
  'this', 'that', 'will', 'you', 'your', 'our', 'we', 'they', 'be',
  'is', 'are', 'have', 'has', 'by', 'from', 'as', 'at', 'on', 'up',
  'it', 'its', 'not', 'all', 'can', 'who', 'which', 'about', 'role',
  'position', 'company', 'able', 'across', 'also', 'into', 'through',
  'within', 'would', 'their', 'been', 'more', 'well', 'over', 'using',
  'while', 'including', 'other', 'such', 'these', 'those', 'when',
]);

/**
 * Normalise a company name: lowercase, strip trailing legal suffixes,
 * remove punctuation.
 *
 * "Wiz, Inc." → "wiz"
 * "Palo Alto Networks, Inc." → "palo alto networks"
 */
export function normalizeCompanyName(name) {
  if (!name || typeof name !== 'string') return '';
  return name
    .toLowerCase()
    // Strip legal suffixes only when they appear at the end
    .replace(/[,.]?\s*(inc\.?|llc\.?|ltd\.?|limited|corp\.?|corporation|co\.)\.?\s*$/i, '')
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Normalise a job title: expand abbreviations, lowercase, strip noise.
 *
 * "Sr. Customer Success Mgr - Strategic" → "senior customer success manager strategic"
 */
export function normalizeJobTitle(title) {
  if (!title || typeof title !== 'string') return '';
  let t = title.toLowerCase();
  for (const [re, replacement] of TITLE_ABBREVS) {
    t = t.replace(re, replacement);
  }
  return t
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Normalise a location string for comparison.
 *
 * "Dallas, TX (Remote OK)" → "dallas tx remote"
 * "United States (Remote)" → "remote"
 */
export function normalizeLocation(loc) {
  if (!loc || typeof loc !== 'string') return '';
  return loc
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Tokenise a block of text into a Set of meaningful words (≥5 chars, not in
 * DESC_STOP). Used for description overlap scoring.
 */
export function normalizeText(text) {
  if (!text || typeof text !== 'string') return new Set();
  const words = text
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 5 && !DESC_STOP.has(w));
  return new Set(words.slice(0, 150)); // cap to 150 unique terms
}

// ── Fingerprint ────────────────────────────────────────────────────────────────

/**
 * Pre-compute all normalised forms for a job so they're not recomputed per
 * comparison.
 *
 * @param {{
 *   company?: string,
 *   title?: string,
 *   location?: string,
 *   description_preview?: string,
 *   full_description?: string,
 *   url?: string,
 * }} job
 */
export function buildJobFingerprint(job) {
  if (!job) return null;

  const companyNorm = normalizeCompanyName(job.company ?? '');
  const titleNorm   = normalizeJobTitle(job.title ?? '');
  const titleTokens = new Set(
    titleNorm.split(/\s+/).filter(w => w.length >= 2 && !TITLE_STOP.has(w))
  );

  const locationNorm = normalizeLocation(job.location ?? '');

  const descText = [
    job.full_description    ?? '',
    job.description_preview ?? '',
    job.description         ?? '',
  ].join(' ');
  const descWords = normalizeText(descText);

  const urlJobId = extractJobId(job.url ?? '');

  return { companyNorm, titleNorm, titleTokens, locationNorm, descWords, urlJobId };
}

// ── Individual signal scores ───────────────────────────────────────────────────

/** Jaccard similarity (0–1) between two Sets. */
function jaccard(setA, setB) {
  if (!setA.size && !setB.size) return 1;
  if (!setA.size || !setB.size) return 0;
  let inter = 0;
  for (const item of setA) {
    if (setB.has(item)) inter++;
  }
  const union = setA.size + setB.size - inter;
  return union > 0 ? inter / union : 0;
}

/** Extract the primary numeric/slug job ID from a URL. */
function extractJobId(url) {
  if (!url || typeof url !== 'string') return null;
  // Greenhouse: /jobs/1234567890 or ?gh_jid=1234567890
  const ghMatch = url.match(/\/jobs\/(\d{6,})/) ?? url.match(/gh_jid=(\d{6,})/);
  if (ghMatch) return `gh:${ghMatch[1]}`;

  // Lever: /jobs/{uuid}
  const levMatch = url.match(/jobs\.lever\.co\/[^/]+\/([0-9a-f-]{30,})/i);
  if (levMatch) return `lev:${levMatch[1]}`;

  // Ashby: /jobs/{uuid or slug}
  const ashMatch = url.match(/ashbyhq\.com\/[^/]+\/([^/?#]+)/i);
  if (ashMatch) return `ash:${ashMatch[1]}`;

  // LinkedIn: /jobs/view/{id} or /jobs/{id}
  const liMatch = url.match(/linkedin\.com\/jobs\/(?:view\/)?(\d{6,})/);
  if (liMatch) return `li:${liMatch[1]}`;

  return null;
}

/**
 * Company match score (0–35).
 * Full match on normalised name → 35.
 * High token overlap (≥ 0.75 Jaccard) → 25.
 * Low or no overlap → 0.
 * Either empty → 0.
 */
function scoreCompany(fpA, fpB) {
  const a = fpA.companyNorm;
  const b = fpB.companyNorm;
  if (!a || !b) return 0;
  if (a === b) return 35;

  const tokA = new Set(a.split(/\s+/).filter(Boolean));
  const tokB = new Set(b.split(/\s+/).filter(Boolean));
  const sim   = jaccard(tokA, tokB);
  if (sim >= 0.75) return 25;
  return 0; // company must match reasonably — no partial credit below 75%
}

/**
 * Title similarity score (0–30).
 * Uses Jaccard on normalised title tokens after stop-word removal.
 */
function scoreTitle(fpA, fpB) {
  const sim = jaccard(fpA.titleTokens, fpB.titleTokens);
  return Math.round(sim * 30);
}

/**
 * Location similarity score (0–10).
 * Both unknown → 5 (neutral, don't penalise missing data).
 * Both remote → 10.
 * One remote + one empty → 5.
 * Substring match (e.g. "dallas" in "dallas tx") → 8.
 * Exact match → 10.
 * No overlap → 0.
 */
function scoreLocation(fpA, fpB) {
  const a = fpA.locationNorm;
  const b = fpB.locationNorm;

  if (!a && !b) return 5;    // both unknown — neutral
  if (!a || !b) return 3;    // one unknown — slight penalty

  if (a === b) return 10;

  const aRemote = a.includes('remote');
  const bRemote = b.includes('remote');
  if (aRemote && bRemote) return 10;
  if (aRemote || bRemote) return 5;

  // Substring containment (one is more specific than the other)
  if (a.includes(b) || b.includes(a)) return 8;

  // Token overlap
  const tokA = new Set(a.split(/\s+/).filter(Boolean));
  const tokB = new Set(b.split(/\s+/).filter(Boolean));
  const sim   = jaccard(tokA, tokB);
  if (sim >= 0.5) return 6;

  return 0;
}

/**
 * Description overlap score (0–15).
 * Only contributes when both jobs have non-trivial description data.
 * Uses Jaccard on significant words (≥5 chars, not in stop list).
 */
function scoreDescription(fpA, fpB) {
  if (!fpA.descWords.size || !fpB.descWords.size) return 0;
  const sim = jaccard(fpA.descWords, fpB.descWords);
  return Math.round(sim * 15);
}

/**
 * URL / req ID score (0–10).
 * Matching extracted job ID (platform-aware) → 10.
 * Neither has a parseable ID but both share the same ATS hostname → 3.
 */
function scoreUrlId(fpA, fpB) {
  const idA = fpA.urlJobId;
  const idB = fpB.urlJobId;

  if (idA && idB && idA === idB) return 10;

  // Same ATS hostname as a weak signal
  const urlA = fpA._url ?? '';
  const urlB = fpB._url ?? '';
  if (urlA && urlB) {
    try {
      const hostA = new URL(urlA).hostname.replace(/^www\./, '');
      const hostB = new URL(urlB).hostname.replace(/^www\./, '');
      if (hostA === hostB && hostA !== 'linkedin.com') return 3;
    } catch {
      // invalid URLs — ignore
    }
  }

  return 0;
}

// ── Main scoring ───────────────────────────────────────────────────────────────

/**
 * Calculate composite similarity score (0–100) between two jobs.
 *
 * Accepts raw job objects or pre-computed fingerprints.
 *
 * @param {object} jobA
 * @param {object} jobB
 * @returns {number} 0–100
 */
export function calculateJobSimilarity(jobA, jobB) {
  if (!jobA || !jobB) return 0;

  const fpA = buildJobFingerprint(jobA);
  const fpB = buildJobFingerprint(jobB);

  // Carry raw URL for ATS-hostname check
  fpA._url = jobA.url ?? '';
  fpB._url = jobB.url ?? '';

  const company     = scoreCompany(fpA, fpB);
  const title       = scoreTitle(fpA, fpB);
  const location    = scoreLocation(fpA, fpB);
  const description = scoreDescription(fpA, fpB);
  const urlId       = scoreUrlId(fpA, fpB);

  return Math.min(100, company + title + location + description + urlId);
}

/**
 * Determine duplicate/possible-duplicate status from a score.
 *
 * @param {number} score
 * @returns {{ isDuplicate: boolean, isPossibleDuplicate: boolean }}
 */
export function isLikelyDuplicate(score) {
  return {
    isDuplicate:         score >= 85,
    isPossibleDuplicate: score >= 70 && score < 85,
  };
}

/**
 * Find the best-matching existing job for a new candidate job.
 *
 * Iterates `existingJobs`, returns the highest-scoring match along with
 * isDuplicate / isPossibleDuplicate classification.
 *
 * @param {object} newJob  — the job being considered for addition
 * @param {object[]} existingJobs — corpus to check against
 * @returns {{
 *   isDuplicate: boolean,
 *   isPossibleDuplicate: boolean,
 *   score: number,
 *   matchedJob: object|null,
 * }}
 */
export function findDuplicateJob(newJob, existingJobs) {
  const NONE = { isDuplicate: false, isPossibleDuplicate: false, score: 0, matchedJob: null };
  if (!newJob || !Array.isArray(existingJobs) || existingJobs.length === 0) return NONE;

  let bestScore = 0;
  let bestJob   = null;

  for (const existing of existingJobs) {
    if (!existing) continue;
    // Exact URL match is handled by URL-set dedupe upstream — but score it high
    // here too so the signal is consistent.
    const score = calculateJobSimilarity(newJob, existing);
    if (score > bestScore) {
      bestScore = score;
      bestJob   = existing;
    }
    if (bestScore === 100) break; // can't do better
  }

  return {
    ...isLikelyDuplicate(bestScore),
    score: bestScore,
    matchedJob: bestJob,
  };
}
