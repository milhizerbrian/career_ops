#!/usr/bin/env node
import './lib/env.mjs';

import { readFileSync, existsSync, mkdirSync } from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import { load as cheerioLoad } from 'cheerio';
import yaml from 'js-yaml';
import { withBrowser } from './lib/gologin-browser.mjs';
import { findDuplicateJob } from './lib/dedupe-utils.mjs';
import { scoreWithClaude, scoreWithLmStudio } from './lib/evaluator.mjs';
import { loadTracker as loadStoredTracker, updateTracker } from './lib/tracker-store.mjs';
import { appendTextSafe, writeTextAtomic } from './lib/atomic-file.mjs';
import { parseDetail } from './scan-linkedin.mjs';

// ── Paths ────────────────────────────────────────────────────────────

const HOME              = process.env.HOME;
const COOKIES_FILE      = path.join(HOME, '.career-ops-linkedin', 'cookies.json');
const PORTALS_PATH      = 'portals.yml';
const PIPELINE_PATH     = 'data/pipeline.md';
const SCAN_HISTORY_PATH = 'data/scan-history.tsv';
const APPLICATIONS_PATH = 'data/applications.md';
const LI_BASE           = 'https://www.linkedin.com';
const liDetail          = (id) => `${LI_BASE}/jobs-guest/jobs/api/jobPosting/${id}`;
const liView            = (id) => `${LI_BASE}/jobs/view/${id}`;

mkdirSync('data', { recursive: true });

// ── Pure helpers (exported for testing) ─────────────────────────────

export function isAuthWall(url) {
  return /\/(login|authwall|checkpoint)(\/|$|\?)/.test(url);
}

export function buildSavedJobsUrl() {
  return `${LI_BASE}/jobs-tracker/`;
}

export function buildRecommendedUrl() {
  return `${LI_BASE}/jobs/collections/recommended/`;
}

export function scrapePageIds(html) {
  const $ = cheerioLoad(html);
  const ids = new Set();
  $('[data-entity-urn]').each((_, el) => {
    const urn = $(el).attr('data-entity-urn') || '';
    const m = urn.match(/urn:li:jobPosting:(\d+)/);
    if (m) ids.add(m[1]);
  });
  $('[data-job-id]').each((_, el) => {
    const id = $(el).attr('data-job-id');
    if (id && /^\d+$/.test(id)) ids.add(id);
  });
  return [...ids];
}

export function paginationUrls(search, pages = 3) {
  const urls = [];
  for (let i = 0; i < pages; i++) {
    const params = new URLSearchParams({
      keywords: search.keywords,
      location: search.location || 'United States',
      f_WT:     search.f_WT    || '',
      start:    String(i * 25),
    });
    urls.push(`${LI_BASE}/jobs/search/?${params}`);
  }
  return urls;
}

export function isCookieStale(savedAt, thresholdDays = 30) {
  if (!savedAt) return true;
  const ms = Date.now() - new Date(savedAt).getTime();
  return ms > thresholdDays * 24 * 60 * 60 * 1000;
}

// ── Cookie loading ────────────────────────────────────────────────────

function loadCookie() {
  if (!existsSync(COOKIES_FILE)) {
    process.stderr.write(
      'No LinkedIn session cookie found.\n' +
      'Run: node scripts/scrape-linkedin-contacts.mjs --set-cookie <value>\n'
    );
    process.exit(1);
  }
  const data = JSON.parse(readFileSync(COOKIES_FILE, 'utf8'));
  if (isCookieStale(data.savedAt)) {
    const days = Math.floor((Date.now() - new Date(data.savedAt).getTime()) / 86400000);
    process.stdout.write(
      `[warn] li_at cookie is ${days} days old — consider refreshing if you see auth failures.\n`
    );
  }
  return data.li_at;
}

// ── HTTP helpers (detail fetch via guest API) ─────────────────────────

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function randomDelay() {
  return sleep(3000 + Math.random() * 4000);
}

async function fetchText(url, attempt = 0) {
  const res = await fetch(url, {
    headers: {
      'User-Agent':      UA,
      'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 429) {
    if (attempt >= 2) throw new Error('Rate limit persists after 3 attempts');
    process.stdout.write(`  [429] Rate limited — waiting 60s (attempt ${attempt + 1}/3)…\n`);
    await sleep(60_000);
    return fetchText(url, attempt + 1);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

// ── Search config ─────────────────────────────────────────────────────

function buildSearches(config) {
  if (config.linkedin_searches && config.linkedin_searches.length) {
    return config.linkedin_searches.filter(s => s.enabled !== false);
  }
  return [
    { keywords: 'Customer Success Manager cybersecurity remote',    location: 'United States', f_WT: '2' },
    { keywords: 'Strategic Customer Success cybersecurity',         location: 'United States', f_WT: '2' },
    { keywords: 'Technical Account Manager cybersecurity security', location: 'United States', f_WT: '2' },
    { keywords: 'Director Customer Success security SaaS',          location: 'United States', f_WT: '2' },
    { keywords: 'Customer Success Manager IAM identity access',     location: 'United States', f_WT: '2' },
  ];
}

function buildTitleFilter(titleFilter) {
  const pos = (titleFilter?.positive || []).map(k => k.toLowerCase());
  const neg = (titleFilter?.negative || []).map(k => k.toLowerCase());
  return (title) => {
    const t   = (title || '').toLowerCase();
    const ok  = pos.length === 0 || pos.some(k => t.includes(k));
    const bad = neg.some(k => t.includes(k));
    return ok && !bad;
  };
}

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

function loadTracker() {
  try { return loadStoredTracker(); } catch { return {}; }
}

// ── Scoring pipeline ──────────────────────────────────────────────────

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
    process.stdout.write(state.claudeEnabled
      ? 'Scoring: Claude enabled'
      : 'Scoring: Claude disabled (ANTHROPIC_API_KEY not set)');
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
  p.score                 = Math.min(5.0, Math.max(0.0, parseFloat(p.score.toFixed(1))));
  p.score_analysis        = p.score_analysis        || p.role_summary || '';
  p.role_summary          = p.role_summary          || p.score_analysis || '';
  p.cv_match_table        = Array.isArray(p.cv_match_table) ? p.cv_match_table : [];
  p.gaps                  = Array.isArray(p.gaps) ? p.gaps : [];
  p.strategic_positioning = p.strategic_positioning || '';
  p.legitimacy_check      = p.legitimacy_check      || '';
  return p;
}

function canAttemptScoring(state) {
  return state.claudeEnabled || state.lmStudioEnabled;
}

async function scoreJob(job, state) {
  if (!canAttemptScoring(state)) {
    if (!state.warnedUnavailable) {
      process.stdout.write('(scoring engines unavailable; leaving scores blank) ');
      state.warnedUnavailable = true;
    }
    return null;
  }

  const item = {
    url:     job.url     || '',
    company: job.company || '',
    title:   job.title   || '',
    source:  job.source  || 'linkedin-browser',
  };
  const details = {
    title:        job.title       || '',
    company:      job.company     || '',
    location:     job.location    || '',
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

  if (state.claudeEnabled) {
    try {
      return normalizeScoreResponse(await scoreWithClaude(item, details, log));
    } catch (err) {
      state.claudeEnabled = false;
      const suffix = state.lmStudioEnabled ? '; trying LM Studio… ' : '; scoring disabled. ';
      process.stdout.write(`Claude error: ${err.message}${suffix}`);
    }
  }

  if (!state.lmStudioEnabled) return null;

  try {
    return normalizeScoreResponse(await scoreWithLmStudio(item, details, log));
  } catch (err) {
    state.lmStudioEnabled = false;
    process.stdout.write(`LM Studio error: ${err.message}; scoring disabled.\n`);
    return null;
  }
}

// ── Tracker / pipeline writers ────────────────────────────────────────

function mergeIntoTracker(tracker, job, date) {
  const key     = `li-${job.id}`;
  const current = tracker[key] || {};
  tracker[key] = Object.assign(
    { status: 'Lead', notes: '' },
    current,
    {
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
      source:              job.source,
      description_preview: job.description_preview || (job.description || '').slice(0, 600),
      full_description:    job.description,
      date_found:          current.date_found || date,
      date_updated:        date,
    }
  );
  if (current.score === undefined && job._score !== undefined) {
    tracker[key].score          = job._score;
    tracker[key].score_analysis = job._report?.score_analysis || job._report?.role_summary || '';
    tracker[key].report         = job._report || {};
    tracker[key].score_date     = date;
  }
}

function appendToPipeline(offers) {
  if (!offers.length) return;
  let text    = existsSync(PIPELINE_PATH) ? readFileSync(PIPELINE_PATH, 'utf8') : '# Pipeline\n\n## Pendientes\n\n';
  const marker = '## Pendientes';
  const idx    = text.indexOf(marker);
  const block  = '\n' + offers.map(o =>
    `- [ ] ${o.url} | ${o.company} | ${o.title}${o.possibleDup ? ' | ~dup?' : ''}`
  ).join('\n') + '\n';
  if (idx === -1) {
    text += `\n${marker}\n${block}`;
  } else {
    const after = idx + marker.length;
    const next  = text.indexOf('\n## ', after);
    const at    = next === -1 ? text.length : next;
    text        = text.slice(0, at) + block + text.slice(at);
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

// ── Browser ID harvest ────────────────────────────────────────────────

async function harvestSearchIds(page, searches, pages) {
  const ids = new Set();
  for (const search of searches) {
    const urls = paginationUrls(search, pages);
    process.stdout.write(`\nSearching (browser): ${search.keywords}\n`);
    for (const url of urls) {
      try {
        await page.goto(url, { timeout: 45_000 });
        await sleep(2000); // allow React to render job cards
        const html    = await page.content();
        const pageIds = scrapePageIds(html);
        if (pageIds.length === 0) {
          process.stdout.write(`  [warn] 0 IDs on page — possible selector rot: ${url}\n`);
        } else {
          const startParam = new URL(url).searchParams.get('start') || '0';
          process.stdout.write(`  ${pageIds.length} IDs found (start=${startParam})\n`);
        }
        for (const id of pageIds) ids.add(id);
      } catch (err) {
        process.stdout.write(`  [error] page load failed: ${err.message} — skipping\n`);
      }
    }
  }
  return ids;
}

async function harvestSavedIds(page) {
  const url = buildSavedJobsUrl();
  process.stdout.write('\nFetching saved jobs…\n');
  try {
    await page.goto(url, { timeout: 45_000 });
    // Scroll 5× to trigger lazy-loading of all saved jobs
    for (let i = 0; i < 5; i++) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await sleep(1500);
    }
    const html = await page.content();
    const ids  = scrapePageIds(html);
    if (ids.length === 0) {
      process.stdout.write('  [warn] 0 saved job IDs found — list may be empty or selectors changed\n');
    } else {
      process.stdout.write(`  ${ids.length} saved job IDs found\n`);
    }
    return new Set(ids);
  } catch (err) {
    process.stdout.write(`  [error] saved jobs page failed: ${err.message} — skipping\n`);
    return new Set();
  }
}

async function harvestRecommendedIds(page, pages) {
  const url = buildRecommendedUrl();
  process.stdout.write('\nFetching recommended jobs…\n');
  try {
    await page.goto(url, { timeout: 45_000 });
    await sleep(2000); // initial render before scrolling
    // Each "page" is ~25 items; 3 scrolls per page is enough to trigger lazy loading
    const scrollRounds = pages * 3;
    for (let i = 0; i < scrollRounds; i++) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await sleep(1500);
    }
    const html = await page.content();
    const ids  = scrapePageIds(html);
    if (ids.length === 0) {
      process.stdout.write('  [warn] 0 recommended job IDs found — selectors may have changed\n');
    } else {
      process.stdout.write(`  ${ids.length} recommended job IDs found\n`);
    }
    return new Set(ids);
  } catch (err) {
    process.stdout.write(`  [error] recommended jobs page failed: ${err.message} — skipping\n`);
    return new Set();
  }
}

// ── Main ─────────────────────────────────────────────────────────────

async function main() {
  const args          = process.argv.slice(2);
  const dryRun        = args.includes('--dry-run');
  const noSaved       = args.includes('--no-saved');
  const savedOnly     = args.includes('--saved-only');
  const noRecommended = args.includes('--no-recommended');
  const limitIdx      = args.indexOf('--limit');
  const maxDetail     = limitIdx >= 0 ? (parseInt(args[limitIdx + 1]) || 25) : 25;
  const pagesIdx      = args.indexOf('--pages');
  const pages         = pagesIdx  >= 0 ? (parseInt(args[pagesIdx  + 1]) || 3)  : 3;

  // ── Pre-flight ──────────────────────────────────────────────────────
  loadCookie(); // exits with message if missing

  if (!existsSync(PORTALS_PATH)) {
    process.stderr.write('Error: portals.yml not found.\n');
    process.exit(1);
  }

  const config      = yaml.load(readFileSync(PORTALS_PATH, 'utf8'));
  const searches    = buildSearches(config);
  const titleFilter = buildTitleFilter(config.title_filter);
  const seenIds     = loadSeenIds();
  const tracker     = loadTracker();
  const date        = new Date().toISOString().slice(0, 10);

  // Seed seenIds from existing tracker keys
  for (const key of Object.keys(tracker)) {
    const m = key.match(/^li-(\d+)$/);
    if (m) seenIds.add(m[1]);
  }

  if (dryRun) process.stdout.write('(dry run — no files will be written)\n\n');

  const scoringState = await buildScoringState();
  const trackerJobs  = Object.values(tracker);

  // ── Phase 1: ID harvest ─────────────────────────────────────────────
  let searchIds      = new Set();
  let savedIds       = new Set();
  let recommendedIds = new Set();

  await withBrowser(async context => {
    const page = await context.newPage();

    // Auth check
    await page.goto('https://www.linkedin.com/feed', { timeout: 45_000 });
    if (isAuthWall(page.url())) {
      process.stderr.write(
        'LinkedIn session expired.\n' +
        'Run: node scripts/scrape-linkedin-contacts.mjs --set-cookie <value>\n'
      );
      process.exit(1);
    }

    if (!savedOnly) {
      searchIds = await harvestSearchIds(page, searches, pages);
      if (!noRecommended) {
        recommendedIds = await harvestRecommendedIds(page, pages);
      }
    }
    if (!noSaved) {
      savedIds = await harvestSavedIds(page);
    }
  });

  // ── Phase 2: Dedup + log already-tracked saved jobs ─────────────────
  const allIds = new Set([...searchIds, ...savedIds, ...recommendedIds]);
  const newIds = [...allIds].filter(id => !seenIds.has(id));

  for (const id of savedIds) {
    if (seenIds.has(id) && tracker[`li-${id}`]) {
      const e = tracker[`li-${id}`];
      process.stdout.write(`  [saved] ${e.title || '?'} at ${e.company || '?'} — already tracked\n`);
    }
  }

  process.stdout.write(
    `\n${newIds.length} new IDs to fetch ` +
    `(${allIds.size} total, ${allIds.size - newIds.length} already seen)\n\n`
  );

  // ── Phase 2: Detail fetch ───────────────────────────────────────────
  const newJobs = [];
  const errors  = [];
  let fetched   = 0;

  for (const id of newIds) {
    if (fetched >= maxDetail) break;
    seenIds.add(id);
    fetched++;

    await randomDelay();

    const source = savedIds.has(id) ? 'linkedin-saved' : 'linkedin-browser';

    try {
      const html = await fetchText(liDetail(id));
      const job  = parseDetail(html, id);
      job.source = source;
      job.url    = liView(id); // ensure correct URL regardless of what parseDetail sets

      if (!titleFilter(job.title)) continue;

      const { isDuplicate, isPossibleDuplicate } = findDuplicateJob(job, trackerJobs);
      if (isDuplicate) {
        process.stdout.write(`  ~ ${job.company} | ${job.title} — semantic dup skipped\n`);
        continue;
      }
      if (isPossibleDuplicate) job.possibleDup = true;

      process.stdout.write(`  + [${source}] ${job.company} | ${job.title}`);
      const scored = await scoreJob(job, scoringState);
      if (scored) {
        job._score  = scored.score;
        job._report = scored;
        process.stdout.write(` — ${scored.score}/5\n`);
      } else {
        process.stdout.write(' — (scoring unavailable)\n');
      }
      newJobs.push(job);
    } catch (err) {
      errors.push({ id, error: err.message });
      process.stdout.write(`  ! Detail failed for ${id}: ${err.message}\n`);
    }
  }

  // ── Phase 3: Write ──────────────────────────────────────────────────
  if (!dryRun && newJobs.length > 0) {
    updateTracker(latest => {
      for (const job of newJobs) mergeIntoTracker(latest, job, date);
    });
    appendToPipeline(newJobs);
    appendToScanHistory(newJobs, date);
  }

  // ── Summary ─────────────────────────────────────────────────────────
  const bar = '━'.repeat(45);
  process.stdout.write(`\n${bar}\n`);
  process.stdout.write(`LinkedIn Browser Scan — ${date}\n`);
  process.stdout.write(`${bar}\n`);
  process.stdout.write(`IDs harvested:   ${allIds.size} (${searchIds.size} search, ${recommendedIds.size} recommended, ${savedIds.size} saved)\n`);
  process.stdout.write(`New jobs added:  ${newJobs.length}\n`);
  process.stdout.write(`Errors:          ${errors.length}\n`);
  if (errors.length) {
    for (const e of errors) process.stdout.write(`  ✗ ${e.id}: ${e.error}\n`);
  }
  if (dryRun) process.stdout.write('\n(dry run — run without --dry-run to save)\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(err => {
    process.stderr.write(`Fatal: ${err.message}\n${err.stack}\n`);
    process.exit(1);
  });
}
