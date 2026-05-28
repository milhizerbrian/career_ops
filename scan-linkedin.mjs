#!/usr/bin/env node
import './lib/env.mjs';

/**
 * scan-linkedin.mjs — LinkedIn Guest API job scanner (no browser required)
 *
 * Hits the public LinkedIn guest endpoints directly:
 *   Search:  /jobs-guest/jobs/api/seeMoreJobPostings/search
 *   Detail:  /jobs-guest/jobs/api/jobPosting/{id}
 *
 * Parses HTML fragments with Cheerio. Updates tracker.json and pipeline.md.
 * Preserves existing status/notes for any job already tracked.
 *
 * Usage:
 *   node scan-linkedin.mjs                  # run all configured searches
 *   node scan-linkedin.mjs --dry-run        # preview without writing files
 *   node scan-linkedin.mjs --limit 20       # cap detail fetches per search
 */

import { readFileSync, existsSync, mkdirSync } from 'fs';
import { pathToFileURL } from 'url';
import { load as cheerioLoad } from 'cheerio';
import yaml from 'js-yaml';
import { findDuplicateJob } from './lib/dedupe-utils.mjs';
import { scoreWithClaude, scoreWithLmStudio } from './lib/evaluator.mjs';
import { getLmStudioAnalysisModel } from './lib/lm-studio-config.mjs';
import { loadTracker as loadStoredTracker, updateTracker } from './lib/tracker-store.mjs';
import { appendTextSafe, writeTextAtomic } from './lib/atomic-file.mjs';

// ── Paths ────────────────────────────────────────────────────────────

const PORTALS_PATH      = 'portals.yml';
const TRACKER_PATH      = 'data/tracker.json';
const PIPELINE_PATH     = 'data/pipeline.md';
const SCAN_HISTORY_PATH = 'data/scan-history.tsv';
const APPLICATIONS_PATH = 'data/applications.md';

mkdirSync('data', { recursive: true });

// ── LinkedIn URLs ────────────────────────────────────────────────────

const LI_BASE   = 'https://www.linkedin.com';
const LI_SEARCH = `${LI_BASE}/jobs-guest/jobs/api/seeMoreJobPostings/search`;
const liDetail  = (id) => `${LI_BASE}/jobs-guest/jobs/api/jobPosting/${id}`;
const liView    = (id) => `${LI_BASE}/jobs/view/${id}`;

// ── HTTP helpers ─────────────────────────────────────────────────────

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function randomDelay() {
  // 3–7 second delay between detail requests — stays within polite limits
  return sleep(3000 + Math.random() * 4000);
}

async function fetchText(url, attempt = 0) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': UA,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br',
      'Cache-Control': 'no-cache',
    },
    signal: AbortSignal.timeout(15_000),
  });

  if (res.status === 429) {
    if (attempt >= 2) throw new Error('Rate limit persists after 3 attempts');
    console.log(`  [429] Rate limited — waiting 60s (attempt ${attempt + 1}/3)…`);
    await sleep(60_000);
    return fetchText(url, attempt + 1);
  }

  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

// ── HTML parsers ─────────────────────────────────────────────────────

function parseJobIds(html) {
  const $ = cheerioLoad(html);
  const ids = [];
  // data-entity-urn="urn:li:jobPosting:1234567890"
  $('[data-entity-urn]').each((_, el) => {
    const urn = $(el).attr('data-entity-urn') || '';
    const m = urn.match(/urn:li:jobPosting:(\d+)/);
    if (m) ids.push(m[1]);
  });
  // Fallback: data-job-id attribute
  $('[data-job-id]').each((_, el) => {
    const id = $(el).attr('data-job-id');
    if (id && /^\d+$/.test(id)) ids.push(id);
  });
  return [...new Set(ids)];
}

// ── Section parser ───────────────────────────────────────────────────

const SECTION_HEADINGS = {
  responsibilities: [
    'responsibilities', "what you'll do", 'what you will do', 'your role',
    'key responsibilities', 'duties', 'the role', 'in this role',
    'day to day', 'what you will be doing', 'what you’ll do',
    'what you’ll be doing', 'about the role', 'role overview',
  ],
  requirements: [
    'requirements', "what you'll need", 'what we need', 'required qualifications',
    'must have', 'minimum qualifications', 'basic qualifications', 'you have',
    'you bring', 'what you need', 'what we are looking for',
    "what we're looking for", 'what we’re looking for', 'about you',
    'required skills', 'skills and experience', 'experience required',
    'your background', 'who you are', 'you should have',
  ],
  qualifications: [
    'qualifications', 'preferred qualifications', 'nice to have', 'preferred',
    'bonus points', 'what you bring', 'ideal candidate', 'plus if you have',
  ],
  benefits: [
    'benefits', 'what we offer', 'perks', 'why join', 'we offer', 'our offer',
    'compensation and benefits', 'total rewards',
  ],
};

function classifyHeading(text) {
  const lower = text.toLowerCase().trim();
  for (const [section, patterns] of Object.entries(SECTION_HEADINGS)) {
    if (patterns.some(p => lower.includes(p))) return section;
  }
  return null;
}

function appendSectionItem(result, section, value) {
  if (!section || !result[section]) return;
  const text = String(value || '')
    .replace(/\s+/g, ' ')
    .replace(/^[\-•*●▪]\s*/, '')
    .trim();
  if (text.length < 18) return;
  if (!result[section].includes(text)) result[section].push(text);
}

function blockText($, container) {
  const clone = container.clone();
  clone.find('br').replaceWith('\n');
  clone.find('li').each((_, el) => {
    const item = $(el);
    item.append('\n');
  });
  clone.find('p,div,h1,h2,h3,h4,h5,h6,section,ul,ol').each((_, el) => {
    $(el).append('\n');
  });
  return clone.text()
    .replace(/\r/g, '\n')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function splitLikelyLines(text) {
  const headingWords = [
    'responsibilities', "what you'll do", 'what you will do', 'what you’ll do',
    'requirements', 'required qualifications', 'minimum qualifications',
    'basic qualifications', 'preferred qualifications', 'what we need',
    'what we are looking for', "what we're looking for", 'what we’re looking for',
    'about you', 'who you are', 'you have', 'you bring', 'qualifications',
    'benefits', 'what we offer', 'perks', 'compensation and benefits',
    'the role', 'in this role', 'about the role',
  ];
  const headingPattern = headingWords
    .map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+'))
    .join('|');
  return text
    .replace(new RegExp(`\\s+((?:${headingPattern})\\s*:?)`, 'gi'), '\n$1')
    .split(/\n+|(?=\s*[•●▪]\s+)/)
    .map(line => line.replace(/^[\s\-•*●▪]+/, '').trim())
    .filter(Boolean);
}

function parseSectionsFromText(text) {
  const result = { responsibilities: [], requirements: [], qualifications: [], benefits: [] };
  let current = null;

  for (const line of splitLikelyLines(text)) {
    const headingCandidate = line.replace(/:$/, '').trim();
    if (headingCandidate.length <= 100) {
      const section = classifyHeading(headingCandidate);
      if (section) {
        current = section;
        continue;
      }
    }

    const colon = line.indexOf(':');
    if (colon > 0 && colon <= 90) {
      const section = classifyHeading(line.slice(0, colon));
      if (section) {
        current = section;
        appendSectionItem(result, current, line.slice(colon + 1));
        continue;
      }
    }

    appendSectionItem(result, current, line);
  }

  return result;
}

function inferMissingSectionsFromText(sections, text) {
  const sentenceCandidates = text
    .replace(/\r/g, '\n')
    .split(/(?:\n+|(?<=[.!?])\s+|[•●▪]\s*)/)
    .map(s => s.replace(/^[\s\-•*]+/, '').trim())
    .filter(s => s.length >= 35 && s.length <= 280);

  if (!sections.responsibilities.length) {
    for (const sentence of sentenceCandidates) {
      if (/\b(own|lead|manage|drive|partner|deliver|develop|support|advise|build|execute|collaborate|work with|responsible for)\b/i.test(sentence)) {
        appendSectionItem(sections, 'responsibilities', sentence);
        if (sections.responsibilities.length >= 6) break;
      }
    }
  }

  if (!sections.requirements.length) {
    for (const sentence of sentenceCandidates) {
      if (/\b(required|requirement|must|need|years? of|experience (?:with|in)|proven|ability to|familiarity with|knowledge of|proficiency|background in|you have|you bring)\b/i.test(sentence)) {
        appendSectionItem(sections, 'requirements', sentence);
        if (sections.requirements.length >= 6) break;
      }
    }
  }

  return sections;
}

export function parseSections($, container) {
  const result = { responsibilities: [], requirements: [], qualifications: [], benefits: [] };
  let current = null;

  container.contents().each((_, node) => {
    const el = $(node);
    const tag = (node.name || '').toLowerCase();

    // Detect heading: strong/b/h2/h3 tags, or <p> containing only a strong
    let headingText = null;
    if (['h2', 'h3', 'h4'].includes(tag)) {
      headingText = el.text().trim();
    } else if (tag === 'p') {
      const inner = el.children().filter((_, c) => ['strong', 'b', 'em'].includes(c.name));
      if (inner.length && el.text().trim() === inner.first().text().trim()) {
        headingText = inner.first().text().trim();
      }
    } else if (['strong', 'b'].includes(tag) && el.text().trim().length < 80) {
      headingText = el.text().trim();
    }

    if (headingText) {
      const section = classifyHeading(headingText);
      current = section; // null if unrecognized heading
      return;
    }

    if (!current || !result[current]) return;

    if (tag === 'ul' || tag === 'ol') {
      el.find('li').each((_, li) => {
        appendSectionItem(result, current, $(li).text());
      });
    } else if (tag === 'p') {
      appendSectionItem(result, current, el.text());
    }
  });

  const text = blockText($, container);
  const fallback = parseSectionsFromText(text);
  for (const section of Object.keys(result)) {
    for (const item of fallback[section]) appendSectionItem(result, section, item);
  }

  return inferMissingSectionsFromText(result, text);
}

function extractCompensation(text) {
  const patterns = [
    /\$[\d,]+\s*[-–]\s*\$[\d,]+/,
    /\$[\d]+[kK]\s*[-–]\s*\$?[\d]+[kK]/,
    /salary[^.]*\$[\d,]+[kK]?/i,
    /compensation[^.]*\$[\d,]+[kK]?/i,
    /base pay[^.]*\$[\d,]+[kK]?/i,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m) return m[0].trim();
  }
  return '';
}

function extractKeywords($) {
  const kw = new Set();
  $('[class*="skill"]').each((_, el) => {
    const text = $(el).text().trim();
    if (text && text.length < 60 && text.length > 2) kw.add(text);
  });
  // Also pick up pill/tag-style elements common in LinkedIn
  $('[class*="tag"], [class*="pill"]').each((_, el) => {
    const text = $(el).text().trim();
    if (text && text.length < 60 && text.length > 2) kw.add(text);
  });
  return [...kw].slice(0, 25);
}

function logFieldStatus(job) {
  const critical = ['title', 'company', 'responsibilities', 'requirements'];
  const all = {
    company_name:      job.company,
    job_title:         job.title,
    location:          job.location,
    employment_type:   job.employment_type,
    department:        job.department,
    seniority:         job.seniority,
    responsibilities:  job.responsibilities,
    requirements:      job.requirements,
    qualifications:    job.qualifications,
    benefits:          job.benefits,
    compensation:      job.compensation,
    keywords:          job.keywords,
  };

  const missing = [];
  for (const [field, val] of Object.entries(all)) {
    const ok = Array.isArray(val) ? val.length > 0 : Boolean(val);
    if (!ok) missing.push(field);
  }

  if (missing.length) {
    const criticalMissing = missing.filter(f =>
      critical.some(c => f === c || f === `${c}_name` || f === `job_${c}`)
    );
    if (criticalMissing.length) {
      console.warn(`  [WARN] Critical fields missing: ${criticalMissing.join(', ')}`);
    } else {
      console.log(`  [debug] Optional fields missing: ${missing.join(', ')}`);
    }
  }
}

function firstExisting($, selectors) {
  for (const selector of selectors) {
    const found = $(selector).first();
    if (found.length) return found;
  }
  return $('body').first();
}

export function parseDetail(html, id) {
  const $ = cheerioLoad(html);

  const title =
    $('.topcard__title').first().text().trim() ||
    $('h1.top-card-layout__title').first().text().trim() ||
    $('h2.top-card-layout__title').first().text().trim() ||
    $('h1').first().text().trim();

  const company =
    $('a.topcard__org-name-link').first().text().trim() ||
    $('.topcard__org-name-link').first().text().trim() ||
    $('.topcard__flavor--black-link').first().text().trim() ||
    $('a[data-tracking-control-name="public_jobs_topcard-org-name"]').first().text().trim();

  const location =
    $('.topcard__flavor--bullet').first().text().trim() ||
    $('.job-details-jobs-unified-top-card__bullet').first().text().trim();

  // Structured metadata from criteria section
  const criteriaText = (selector) =>
    $(`${selector} .job-criteria-text`).first().text().trim() ||
    $(`${selector} .description__job-criteria-text`).first().text().trim();

  const employment_type =
    criteriaText('.job-criteria-item:contains("Employment type")') ||
    criteriaText('.description__job-criteria-item:contains("Employment type")') || '';

  const seniority =
    criteriaText('.job-criteria-item:contains("Seniority")') ||
    criteriaText('.description__job-criteria-item:contains("Seniority level")') || '';

  const department =
    criteriaText('.job-criteria-item:contains("Industries")') ||
    criteriaText('.description__job-criteria-item:contains("Industries")') || '';

  // Structured sections from description
  const descContainer = firstExisting($, [
    '.description__text .show-more-less-html__markup',
    '.show-more-less-html__markup',
    '.description__text',
    '[class*="description"]',
  ]);

  const sections = parseSections($, descContainer);

  const fullDesc =
    blockText($, descContainer) ||
    $('[class*="description"]').first().text().trim();

  const compensation = extractCompensation(fullDesc);
  const keywords = extractKeywords($);

  const job = {
    id,
    title:               title    || '(unknown)',
    company:             company  || '(unknown)',
    location:            location || '',
    employment_type,
    seniority,
    department,
    responsibilities:    sections.responsibilities,
    requirements:        sections.requirements,
    qualifications:      sections.qualifications,
    benefits:            sections.benefits,
    compensation,
    keywords,
    description:         fullDesc,
    description_preview: fullDesc.slice(0, 600),
    url:                 liView(id),
    source:              'linkedin-guest-api',
  };

  logFieldStatus(job);
  return job;
}

// ── Dedup ────────────────────────────────────────────────────────────

function loadSeenIds() {
  const seen = new Set();

  if (existsSync(SCAN_HISTORY_PATH)) {
    for (const line of readFileSync(SCAN_HISTORY_PATH, 'utf8').split('\n').slice(1)) {
      const url = line.split('\t')[0];
      const m = url && url.match(/\/jobs\/view\/(\d+)/);
      if (m) seen.add(m[1]);
    }
  }

  if (existsSync(PIPELINE_PATH)) {
    for (const m of readFileSync(PIPELINE_PATH, 'utf8').matchAll(/linkedin\.com\/jobs\/view\/(\d+)/g)) {
      seen.add(m[1]);
    }
  }

  if (existsSync(APPLICATIONS_PATH)) {
    for (const m of readFileSync(APPLICATIONS_PATH, 'utf8').matchAll(/linkedin\.com\/jobs\/view\/(\d+)/g)) {
      seen.add(m[1]);
    }
  }

  return seen;
}

// ── Title filter (reuses portals.yml config) ─────────────────────────

function buildTitleFilter(titleFilter) {
  const pos = (titleFilter?.positive || []).map(k => k.toLowerCase());
  const neg = (titleFilter?.negative || []).map(k => k.toLowerCase());
  return (title) => {
    const t = title.toLowerCase();
    const ok  = pos.length === 0 || pos.some(k => t.includes(k));
    const bad = neg.some(k => t.includes(k));
    return ok && !bad;
  };
}

// ── Job scoring ──────────────────────────────────────────────────────

function preferClaudeEvaluation() {
  return (process.env.PREFER_CLAUDE_EVALUATION ?? process.env.PREFER_CLAUDE_SYNTHESIS ?? '1') !== '0';
}

async function isLmStudioAvailable() {
  try {
    const res = await fetch('http://localhost:1234/v1/models', {
      signal: AbortSignal.timeout(1500),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function buildScoringState() {
  const state = {
    preferClaude: preferClaudeEvaluation(),
    claudeEnabled: false,
    lmStudioEnabled: false,
    warnedUnavailable: false,
  };

  if (state.preferClaude) {
    state.claudeEnabled = Boolean(process.env.ANTHROPIC_API_KEY);
    if (state.claudeEnabled) {
      process.stdout.write('Scoring: Claude enabled');
    } else {
      process.stdout.write('Scoring: Claude disabled (ANTHROPIC_API_KEY not set)');
    }
  }

  state.lmStudioEnabled = await isLmStudioAvailable();
  if (state.lmStudioEnabled) {
    process.stdout.write(`${state.preferClaude ? '; ' : 'Scoring: '}LM Studio fallback available\n`);
  } else if (state.preferClaude) {
    process.stdout.write('; LM Studio fallback unavailable\n');
  } else {
    process.stdout.write('Scoring: LM Studio unavailable\n');
  }

  return state;
}

function normalizeScoreResponse(p) {
  if (typeof p.score !== 'number') throw new Error('Missing numeric score');
  p.score = Math.min(5.0, Math.max(0.0, parseFloat(p.score.toFixed(1))));
  // Normalise field names to match evaluate.mjs schema
  p.score_analysis        = p.score_analysis           || p.role_summary || '';
  p.role_summary          = p.role_summary             || p.score_analysis || '';
  p.cv_match_table        = Array.isArray(p.cv_match_table) ? p.cv_match_table : [];
  p.gaps                  = Array.isArray(p.gaps) ? p.gaps : [];
  p.strategic_positioning = p.strategic_positioning    || '';
  p.legitimacy_check      = p.legitimacy_check         || '';
  return p;
}

function canAttemptScoring(scoringState) {
  return scoringState.claudeEnabled || scoringState.lmStudioEnabled;
}

async function scoreLinkedInJob(job, scoringState) {
  if (!canAttemptScoring(scoringState)) {
    if (!scoringState.warnedUnavailable) {
      process.stdout.write('(scoring engines unavailable; leaving scores blank) ');
      scoringState.warnedUnavailable = true;
    }
    return null;
  }

  const item = {
    url:     job.url || '',
    company: job.company || '',
    title:   job.title || '',
    source:  job.source || 'linkedin-guest-api',
  };
  const details = {
    title:        job.title || '',
    company:      job.company || '',
    location:     job.location || '',
    description:  [
      job.responsibilities?.join('\n'),
      job.requirements?.join('\n'),
      job.description || '',
    ].filter(Boolean).join('\n\n'),
    compensation: job.compensation || '',
  };
  const log = (stage, message) => {
    if (stage === 'evaluate' && message.startsWith('prompt:')) {
      process.stdout.write(`(${message}) `);
    }
  };

  if (scoringState.claudeEnabled) {
    try {
      return normalizeScoreResponse(await scoreWithClaude(item, details, log));
    } catch (err) {
      scoringState.claudeEnabled = false;
      const suffix = scoringState.lmStudioEnabled ? '; trying LM Studio… ' : '; scoring disabled for this run. ';
      process.stdout.write(`Claude error: ${err.message}${suffix}`);
    }
  }

  if (!scoringState.lmStudioEnabled) return null;

  try {
    getLmStudioAnalysisModel();
    return normalizeScoreResponse(await scoreWithLmStudio(item, details, log));
  } catch (err) {
    scoringState.lmStudioEnabled = false;
    process.stdout.write(`LM Studio error: ${err.message}; scoring disabled for this run.\n`);
    return null;
  }
}

// ── Tracker helpers ──────────────────────────────────────────────────

function loadTracker() {
  try { return loadStoredTracker(); } catch { return {}; }
}

// Merge scraped fields into tracker — CRITICAL: preserve status, notes, score
function mergeIntoTracker(tracker, job, date) {
  const key     = `li-${job.id}`;
  const current = tracker[key] || {};

  tracker[key] = Object.assign(
    { status: 'Lead', notes: '' },   // 1. defaults for new entries
    current,                          // 2. preserve existing (status, notes, score…)
    {                                 // 3. always refresh scraped fields
      title:               job.title,
      company:             job.company,
      location:            job.location,
      employment_type:     job.employment_type || current.employment_type || '',
      seniority:           job.seniority       || current.seniority       || '',
      department:          job.department      || current.department      || '',
      responsibilities:    job.responsibilities?.length ? job.responsibilities : (current.responsibilities || []),
      requirements:        job.requirements?.length     ? job.requirements     : (current.requirements    || []),
      qualifications:      job.qualifications?.length   ? job.qualifications   : (current.qualifications  || []),
      benefits:            job.benefits?.length         ? job.benefits         : (current.benefits        || []),
      compensation:        job.compensation || current.compensation || '',
      keywords:            job.keywords?.length ? job.keywords : (current.keywords || []),
      url:                 job.url,
      description_preview: job.description_preview || job.description.slice(0, 600),
      full_description:    job.description,
      date_found:          current.date_found || date,
      date_updated:        date,
    }
  );

  // Write score + full report — only when not already present (rescore pass handles forced updates)
  if (current.score === undefined && job._score !== undefined) {
    tracker[key].score         = job._score;
    tracker[key].score_analysis = job._report?.score_analysis || job._report?.role_summary || '';
    tracker[key].report        = job._report || {};
    tracker[key].score_date    = date;
  }
}

// ── Pipeline / history writers ───────────────────────────────────────

function appendToPipeline(offers) {
  if (!offers.length) return;
  let text = existsSync(PIPELINE_PATH) ? readFileSync(PIPELINE_PATH, 'utf8') : '# Pipeline\n\n## Pendientes\n\n';
  const marker   = '## Pendientes';
  const idx      = text.indexOf(marker);
  const block    = '\n' + offers.map(o => `- [ ] ${o.url} | ${o.company} | ${o.title}${o.possibleDup ? ' | ~dup?' : ''}`).join('\n') + '\n';
  if (idx === -1) {
    text += `\n${marker}\n${block}`;
  } else {
    const after = idx + marker.length;
    const next  = text.indexOf('\n## ', after);
    const at    = next === -1 ? text.length : next;
    text = text.slice(0, at) + block + text.slice(at);
  }
  writeTextAtomic(PIPELINE_PATH, text);
}

function appendToScanHistory(offers, date) {
  if (!existsSync(SCAN_HISTORY_PATH)) {
    writeTextAtomic(SCAN_HISTORY_PATH, 'url\tfirst_seen\tportal\ttitle\tcompany\tstatus\n');
  }
  const lines = offers.map(o =>
    `${o.url}\t${date}\t${o.source}\t${o.title}\t${o.company}\tadded`
  ).join('\n') + '\n';
  appendTextSafe(SCAN_HISTORY_PATH, lines);
}

// ── Search config ────────────────────────────────────────────────────

function buildSearches(config) {
  // Allow portals.yml to define a linkedin_searches block; fall back to defaults
  if (config.linkedin_searches && config.linkedin_searches.length) {
    return config.linkedin_searches.filter(s => s.enabled !== false);
  }

  // Default searches based on Brian's target roles
  return [
    { keywords: 'Customer Success Manager cybersecurity remote',   location: 'United States', f_WT: '2' },
    { keywords: 'Strategic Customer Success cybersecurity',        location: 'United States', f_WT: '2' },
    { keywords: 'Technical Account Manager cybersecurity security', location: 'United States', f_WT: '2' },
    { keywords: 'Director Customer Success security SaaS',         location: 'United States', f_WT: '2' },
    { keywords: 'Customer Success Manager IAM identity access',    location: 'United States', f_WT: '2' },
  ];
}

// ── Main ─────────────────────────────────────────────────────────────

async function main() {
  const args        = process.argv.slice(2);
  const dryRun      = args.includes('--dry-run');
  const limitArg    = args.indexOf('--limit');
  const maxDetail   = limitArg !== -1 ? parseInt(args[limitArg + 1]) || 25 : 25;
  // --rescore <threshold>  Re-score entries with score < threshold (default 2.1)
  // --force-all            Re-score every li- entry unconditionally
  const forceAll    = args.includes('--force-all');
  const rescoreArg  = args.indexOf('--rescore');
  const rescoreMode = forceAll || rescoreArg !== -1;
  const rescoreThreshold = forceAll ? Infinity : (rescoreArg !== -1 ? (parseFloat(args[rescoreArg + 1]) || 2.1) : 2.1);

  if (!existsSync(PORTALS_PATH)) {
    console.error('Error: portals.yml not found. Run onboarding first.');
    process.exit(1);
  }

  const config      = yaml.load(readFileSync(PORTALS_PATH, 'utf8'));
  const titleFilter = buildTitleFilter(config.title_filter);
  const searches    = buildSearches(config);
  const seenIds     = loadSeenIds();
  const tracker     = loadTracker();
  const date        = new Date().toISOString().slice(0, 10);

  // Also seed seen IDs from existing tracker keys
  for (const key of Object.keys(tracker)) {
    const m = key.match(/^li-(\d+)$/);
    if (m) seenIds.add(m[1]);
  }

  // Pre-compute tracker snapshot for semantic dedupe (includes all sources)
  const trackerJobs = Object.values(tracker);
  if (trackerJobs.length > 0) {
    console.log(`Semantic dedupe: loaded ${trackerJobs.length} jobs from tracker`);
  }

  if (dryRun) console.log('(dry run — no files will be written)\n');

  const scoringState = await buildScoringState();

  let totalFound        = 0;
  let totalFiltered     = 0;
  let totalDupes        = 0;
  let totalSemanticDupes = 0;
  let totalPossibleDupes = 0;
  const newJobs         = [];
  const errors          = [];

  for (const search of searches) {
    const params = new URLSearchParams({
      keywords: search.keywords,
      location: search.location || 'United States',
      f_WT:     search.f_WT    || '',
      start:    '0',
      count:    '25',
    });

    const searchUrl = `${LI_SEARCH}?${params}`;
    console.log(`\nSearching: ${search.keywords}`);

    let ids = [];
    try {
      const html = await fetchText(searchUrl);
      ids        = parseJobIds(html);
      console.log(`  ${ids.length} job IDs found`);
      totalFound += ids.length;
    } catch (e) {
      errors.push({ search: search.keywords, error: e.message });
      console.error(`  ! Search failed: ${e.message}`);
      continue;
    }

    let fetched = 0;
    for (const id of ids) {
      if (seenIds.has(id)) { totalDupes++; continue; }
      seenIds.add(id);

      if (fetched >= maxDetail) break;
      fetched++;

      await randomDelay();

      try {
        const html = await fetchText(liDetail(id));
        const job  = parseDetail(html, id);

        if (!titleFilter(job.title)) {
          totalFiltered++;
          continue;
        }

        // Semantic dedupe — cross-platform duplicate detection
        const { isDuplicate, isPossibleDuplicate } = findDuplicateJob(job, trackerJobs);
        if (isDuplicate) {
          totalSemanticDupes++;
          process.stdout.write(`  ~ ${job.company} | ${job.title} — semantic dup skipped\n`);
          continue;
        }
        if (isPossibleDuplicate) {
          totalPossibleDupes++;
          job.possibleDup = true;
        }

        process.stdout.write(`  + ${job.company} | ${job.title}`);
        const scored = await scoreLinkedInJob(job, scoringState);
        if (scored) {
          job._score  = scored.score;
          job._report = scored;
          process.stdout.write(` — ${scored.score}/5\n`);
        } else {
          process.stdout.write(` — (scoring unavailable)\n`);
        }
        newJobs.push(job);
      } catch (e) {
        errors.push({ id, error: e.message });
        console.error(`  ! Detail failed for ${id}: ${e.message}`);
      }
    }
  }

  // ── Write new jobs ─────────────────────────────────────────────────

  if (!dryRun && newJobs.length > 0) {
    updateTracker(latest => {
      for (const job of newJobs) {
        mergeIntoTracker(latest, job, date);
      }
    });
    appendToPipeline(newJobs);
    appendToScanHistory(newJobs, date);
  }

  // ── Backfill (unscored) + optional rescore (score < threshold) ──────

  let backfilled = 0;
  if (!dryRun) {
    const toScore = Object.keys(tracker).filter(k => {
      if (!k.startsWith('li-')) return false;
      const s = tracker[k].score;
      if (s === undefined || s === null) return true;           // never scored
      if (rescoreMode && parseFloat(s) < rescoreThreshold) return true; // --rescore
      return false;
    });

    if (toScore.length) {
      const label = forceAll
        ? `Force re-scoring all ${toScore.length} entries…`
        : rescoreMode
          ? `Re-scoring ${toScore.length} entries with score < ${rescoreThreshold}…`
          : `Backfilling scores for ${toScore.length} unscored entries…`;
      console.log('\n' + label);

      for (const key of toScore) {
        if (!canAttemptScoring(scoringState)) {
          process.stdout.write('  Scoring engines unavailable — skipping remaining backfill entries.\n');
          break;
        }

        const entry = tracker[key];

        // Re-fetch detail page if we only have the 600-char preview (fixes truncation)
        let fullDesc = entry.full_description || '';
        if (fullDesc.length < 800 && entry.url) {
          const liId = key.replace('li-', '');
          try {
            process.stdout.write(`  [re-fetch] ${entry.company}…`);
            const html  = await fetchText(liDetail(liId));
            const fresh = parseDetail(html, liId);
            fullDesc    = fresh.description;
            // Persist the full description so future runs skip the fetch
            tracker[key].full_description    = fresh.description;
            tracker[key].description_preview = fresh.description_preview;
            process.stdout.write(' ok\n');
            await randomDelay();
          } catch (e) {
            process.stdout.write(` fetch failed (${e.message}) — using preview\n`);
            fullDesc = entry.description_preview || '';
          }
        }

        const stub = {
          title:            entry.title           || '',
          company:          entry.company         || '',
          location:         entry.location        || '',
          employment_type:  entry.employment_type || '',
          seniority:        entry.seniority       || '',
          department:       entry.department      || '',
          responsibilities: entry.responsibilities || [],
          requirements:     entry.requirements    || [],
          qualifications:   entry.qualifications  || [],
          benefits:         entry.benefits        || [],
          compensation:     entry.compensation    || '',
          keywords:         entry.keywords        || [],
          description:      fullDesc,
        };

        const prev = tracker[key].score !== undefined ? ` (was ${tracker[key].score}/5)` : '';
        process.stdout.write(`  ${stub.company} | ${stub.title}${prev}…`);
        const scored = await scoreLinkedInJob(stub, scoringState);
        if (scored) {
          tracker[key].score         = scored.score;
          tracker[key].score_analysis = scored.score_analysis || scored.role_summary || '';
          tracker[key].report        = scored;
          tracker[key].score_date    = date;
          process.stdout.write(` → ${scored.score}/5\n`);
          backfilled++;
        } else {
          process.stdout.write(` skipped (timeout or parse error)\n`);
        }
      }
      if (backfilled) {
        updateTracker(latest => {
          for (const [key, entry] of Object.entries(tracker)) {
            if (!latest[key] || entry.score === undefined) continue;
            latest[key].score = entry.score;
            latest[key].score_analysis = entry.score_analysis || '';
            latest[key].report = entry.report || {};
            latest[key].score_date = entry.score_date || date;
          }
        });
      }
    }
  }

  // ── Summary ────────────────────────────────────────────────────────

  console.log(`\n${'━'.repeat(45)}`);
  console.log(`LinkedIn Scan — ${date}`);
  console.log(`${'━'.repeat(45)}`);
  console.log(`Searches run:          ${searches.length}`);
  console.log(`Job IDs found:         ${totalFound}`);
  console.log(`Filtered by title:     ${totalFiltered} removed`);
  console.log(`Exact duplicates:      ${totalDupes} skipped`);
  console.log(`Semantic duplicates:   ${totalSemanticDupes} skipped`);
  console.log(`Possible dupes:        ${totalPossibleDupes} flagged (~dup? marker)`);
  console.log(`New offers added:      ${newJobs.length}`);
  console.log(`Scores backfilled:     ${backfilled}` + (forceAll ? ' (force-all)' : rescoreMode ? ` (rescore < ${rescoreThreshold})` : ''));
  if (dryRun) console.log('\n(dry run — run without --dry-run to save results)');

  if (errors.length) {
    console.log(`\nErrors (${errors.length}):`);
    for (const e of errors) console.log(`  ✗ ${e.search || e.id}: ${e.error}`);
  }

  if (newJobs.length > 0 && !dryRun) {
    console.log(`\nResults saved to ${PIPELINE_PATH}, ${SCAN_HISTORY_PATH}, and ${TRACKER_PATH}`);
  }

  console.log(`\n→ Run /career-ops pipeline to evaluate new offers.`);
  console.log('→ No browser used — pure HTTP + Cheerio.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(err => {
    console.error('Fatal:', err.message);
    process.exit(1);
  });
}
