#!/usr/bin/env node
import './lib/env.mjs';

import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import yaml from 'js-yaml';

import { findDuplicateJob } from './lib/dedupe-utils.mjs';
import { scoreWithClaude, scoreWithLmStudio } from './lib/evaluator.mjs';
import { loadTracker as loadStoredTracker, updateTracker } from './lib/tracker-store.mjs';
import { appendTextSafe, writeTextAtomic } from './lib/atomic-file.mjs';
import {
  WTTJ_APP_BASE,
  buildWttjDetailQueue,
  buildWttjSearchUrl,
  canonicalWttjJobUrl,
  extractWttjJobUrls,
  isWttjLoginUrl,
  normalizeWttjJobId,
  parseWttjJobDetail,
} from './lib/wttj-browser-utils.mjs';
import { loginWttjSession, withWttjBrowser } from './lib/wttj-browser-session.mjs';

const PORTALS_PATH = 'portals.yml';
const PIPELINE_PATH = 'data/pipeline.md';
const SCAN_HISTORY_PATH = 'data/scan-history.tsv';
const APPLICATIONS_PATH = 'data/applications.md';

mkdirSync('data', { recursive: true });

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function randomDelay() {
  return sleep(1500 + Math.random() * 2500);
}

function buildTitleFilter(titleFilter) {
  const positive = (titleFilter?.positive || []).map(k => k.toLowerCase());
  const negative = (titleFilter?.negative || []).map(k => k.toLowerCase());
  return (title) => {
    const lower = String(title || '').toLowerCase();
    const hasPositive = positive.length === 0 || positive.some(k => lower.includes(k));
    const hasNegative = negative.some(k => lower.includes(k));
    return hasPositive && !hasNegative;
  };
}

function buildLocationFilter(locationFilter) {
  const negative = (locationFilter?.negative || []).map(k => k.toLowerCase());
  return (location) => {
    if (!location) return true;
    const lower = String(location || '').toLowerCase();
    return !negative.some(k => lower.includes(k));
  };
}

function loadTracker() {
  try {
    return loadStoredTracker();
  } catch {
    return {};
  }
}

function addSeenFromText(seenIds, text) {
  for (const match of String(text || '').matchAll(/https:\/\/app\.welcometothejungle\.com\/jobs\/[A-Za-z0-9_-]+/g)) {
    const id = normalizeWttjJobId(match[0]);
    if (id) seenIds.add(id);
  }
}

function loadSeenIds(tracker) {
  const seen = new Set();
  for (const key of Object.keys(tracker || {})) {
    const match = key.match(/^wttj-app-(.+)$/);
    if (match) seen.add(match[1]);
  }
  for (const file of [SCAN_HISTORY_PATH, PIPELINE_PATH, APPLICATIONS_PATH]) {
    if (existsSync(file)) addSeenFromText(seen, readFileSync(file, 'utf8'));
  }
  return seen;
}

function appendToPipeline(offers) {
  if (!offers.length) return;
  let text = existsSync(PIPELINE_PATH) ? readFileSync(PIPELINE_PATH, 'utf8') : '# Pipeline\n\n## Pendientes\n\n';
  const marker = '## Pendientes';
  const idx = text.indexOf(marker);
  const block = '\n' + offers.map(o =>
    `- [ ] ${o.url} | ${o.company} | ${o.title}${o.possibleDup ? ' | ~dup?' : ''}`
  ).join('\n') + '\n';
  if (idx === -1) {
    text += `\n${marker}\n${block}`;
  } else {
    const after = idx + marker.length;
    const next = text.indexOf('\n## ', after);
    const at = next === -1 ? text.length : next;
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

function mergeIntoTracker(tracker, job, date) {
  const key = job.id;
  const current = tracker[key] || {};
  tracker[key] = Object.assign(
    { status: 'Lead', notes: '' },
    current,
    {
      title: job.title,
      company: job.company,
      location: job.location,
      responsibilities: job.responsibilities?.length ? job.responsibilities : (current.responsibilities || []),
      requirements: job.requirements?.length ? job.requirements : (current.requirements || []),
      qualifications: job.qualifications?.length ? job.qualifications : (current.qualifications || []),
      benefits: job.benefits?.length ? job.benefits : (current.benefits || []),
      compensation: job.compensation || current.compensation || '',
      keywords: job.keywords?.length ? job.keywords : (current.keywords || []),
      url: job.url,
      source: job.source,
      description_preview: job.description_preview || (job.description || '').slice(0, 600),
      full_description: job.description,
      date_found: current.date_found || date,
      date_updated: date,
    }
  );
  if (current.score === undefined && job._score !== undefined) {
    tracker[key].score = job._score;
    tracker[key].score_analysis = job._report?.score_analysis || job._report?.role_summary || '';
    tracker[key].report = job._report || {};
    tracker[key].score_date = date;
  }
}

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

function normalizeScoreResponse(report) {
  if (typeof report.score !== 'number') throw new Error('Missing numeric score');
  report.score = Math.min(5.0, Math.max(0.0, parseFloat(report.score.toFixed(1))));
  report.score_analysis = report.score_analysis || report.role_summary || '';
  report.role_summary = report.role_summary || report.score_analysis || '';
  report.cv_match_table = Array.isArray(report.cv_match_table) ? report.cv_match_table : [];
  report.gaps = Array.isArray(report.gaps) ? report.gaps : [];
  report.strategic_positioning = report.strategic_positioning || '';
  report.legitimacy_check = report.legitimacy_check || '';
  return report;
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
    url: job.url || '',
    company: job.company || '',
    title: job.title || '',
    source: job.source || 'wttj-browser',
  };
  const details = {
    title: job.title || '',
    company: job.company || '',
    location: job.location || '',
    description: [
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
      const suffix = state.lmStudioEnabled ? '; trying LM Studio... ' : '; scoring disabled. ';
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

async function scrollForJobs(page, pages) {
  const rounds = Math.max(1, pages) * 3;
  for (let i = 0; i < rounds; i++) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
    await sleep(1200);
  }
}

async function extractUrlsFromPage(page, pages) {
  await page.waitForLoadState('domcontentloaded', { timeout: 45_000 }).catch(() => {});
  await sleep(2000);
  await scrollForJobs(page, pages);
  return extractWttjJobUrls(await page.content());
}

async function tryFillSearch(page, query) {
  const selectors = [
    'input[type="search"]',
    'input[name="query"]',
    'input[placeholder*="Search" i]',
    'input[placeholder*="job" i]',
    'input[aria-label*="Search" i]',
    'input[aria-label*="job" i]',
  ];
  for (const selector of selectors) {
    const input = page.locator(selector).first();
    if (await input.count().catch(() => 0)) {
      await input.fill(query).catch(() => {});
      await input.press('Enter').catch(() => {});
      await sleep(2500);
      return true;
    }
  }
  return false;
}

async function harvestSearchUrls(page, queries, pages) {
  const urls = new Set();
  for (const query of queries) {
    process.stdout.write(`\nSearching WTTJ (browser): ${query}\n`);
    for (let pageIndex = 0; pageIndex < pages; pageIndex++) {
      const searchUrl = buildWttjSearchUrl(query, pageIndex);
      try {
        await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });
        if (isWttjLoginUrl(page.url())) throw new Error('WTTJ session expired');
        if (pageIndex === 0) await tryFillSearch(page, query);
        let found = await extractUrlsFromPage(page, 1);
        if (!found.length && pageIndex === 0) {
          await tryFillSearch(page, query);
          found = await extractUrlsFromPage(page, 1);
        }
        process.stdout.write(`  ${found.length} job URLs found (page=${pageIndex + 1})\n`);
        for (const url of found) urls.add(url);
      } catch (err) {
        process.stdout.write(`  [error] search page failed: ${err.message}\n`);
      }
    }
  }
  return urls;
}

async function harvestSurfaceUrls(page, label, candidateUrls, pages, { warnWhenEmpty = true } = {}) {
  const urls = new Set();
  process.stdout.write(`\nFetching WTTJ ${label} jobs...\n`);
  for (const url of candidateUrls) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      if (isWttjLoginUrl(page.url())) throw new Error('WTTJ session expired');
      const found = await extractUrlsFromPage(page, pages);
      process.stdout.write(`  ${found.length} job URLs found at ${new URL(url).pathname || '/'}\n`);
      for (const foundUrl of found) urls.add(foundUrl);
    } catch (err) {
      process.stdout.write(`  [warn] ${new URL(url).pathname || '/'} failed: ${err.message}\n`);
    }
  }
  if (!urls.size) {
    const prefix = warnWhenEmpty ? '[warn]' : '[info]';
    process.stdout.write(`  ${prefix} 0 ${label} job URLs found - list may be empty or not exposed in this WTTJ account\n`);
  }
  return urls;
}

function addSourceUrls(sourceMap, urls, source, { override = false } = {}) {
  for (const url of urls) {
    const id = normalizeWttjJobId(url);
    if (!id) continue;
    if (override || !sourceMap.has(id)) sourceMap.set(id, source);
  }
}

async function verifySession(page) {
  await page.goto(WTTJ_APP_BASE, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  if (isWttjLoginUrl(page.url())) {
    throw new Error('WTTJ session expired. Run: node scan-wttj-browser.mjs --login');
  }
}

function defaultQueries(config) {
  return (config.wttj_searches?.queries || []).filter(Boolean);
}

async function main() {
  const args = process.argv.slice(2);
  const loginMode = args.includes('--login');
  if (loginMode) {
    await loginWttjSession();
    return;
  }

  const dryRun = args.includes('--dry-run');
  const noSearch = args.includes('--no-search');
  const noSaved = args.includes('--no-saved');
  const savedOnly = args.includes('--saved-only');
  const noRecommended = args.includes('--no-recommended');
  const limitIdx = args.indexOf('--limit');
  const maxDetail = limitIdx >= 0 ? (parseInt(args[limitIdx + 1], 10) || 25) : 25;
  const pagesIdx = args.indexOf('--pages');
  const pages = pagesIdx >= 0 ? (parseInt(args[pagesIdx + 1], 10) || 3) : 3;

  if (!existsSync(PORTALS_PATH)) {
    process.stderr.write('Error: portals.yml not found.\n');
    process.exit(1);
  }

  const config = yaml.load(readFileSync(PORTALS_PATH, 'utf8'));
  const queries = defaultQueries(config);
  const titleFilter = buildTitleFilter(config.title_filter);
  const locationFilter = buildLocationFilter(config.location_filter);
  const tracker = loadTracker();
  const seenIds = loadSeenIds(tracker);
  const trackerJobs = Object.values(tracker);
  const date = new Date().toISOString().slice(0, 10);

  if (dryRun) process.stdout.write('(dry run - no files will be written)\n\n');
  const scoringState = await buildScoringState();

  const sourceMap = new Map();
  let searchUrls = new Set();
  let recommendedUrls = new Set();
  let savedUrls = new Set();

  await withWttjBrowser(async context => {
    const page = await context.newPage();
    await verifySession(page);

    if (!savedOnly && !noSearch && queries.length) {
      searchUrls = await harvestSearchUrls(page, queries, pages);
      addSourceUrls(sourceMap, searchUrls, 'wttj-browser');
    }
    if (!savedOnly && !noRecommended) {
      recommendedUrls = await harvestSurfaceUrls(page, 'recommended', [
        `${WTTJ_APP_BASE}/jobs`,
        `${WTTJ_APP_BASE}/jobs-matches`,
        WTTJ_APP_BASE,
      ], pages);
      addSourceUrls(sourceMap, recommendedUrls, 'wttj-recommended');
    }
    if (!noSaved) {
      savedUrls = await harvestSurfaceUrls(page, 'saved', [
        `${WTTJ_APP_BASE}/saved-jobs`,
        `${WTTJ_APP_BASE}/jobs/saved`,
        `${WTTJ_APP_BASE}/saved`,
        `${WTTJ_APP_BASE}/bookmarks`,
      ], pages, { warnWhenEmpty: false });
      addSourceUrls(sourceMap, savedUrls, 'wttj-saved', { override: true });
    }

    const queue = buildWttjDetailQueue(sourceMap, seenIds, maxDetail);
    process.stdout.write(
      `\n${queue.length} new WTTJ jobs to fetch ` +
      `(${sourceMap.size} total, ${sourceMap.size - queue.length} already seen or over limit)\n\n`
    );

    const newJobs = [];
    const errors = [];
    let totalFiltered = 0;
    let totalSemanticDupes = 0;
    let totalPossibleDupes = 0;

    for (const item of queue) {
      seenIds.add(item.id);
      await randomDelay();
      try {
        await page.goto(canonicalWttjJobUrl(item.id), { waitUntil: 'domcontentloaded', timeout: 45_000 });
        if (isWttjLoginUrl(page.url())) throw new Error('WTTJ session expired');
        await page.waitForLoadState('domcontentloaded', { timeout: 45_000 }).catch(() => {});
        await sleep(1500);
        const job = parseWttjJobDetail(await page.content(), item.url);
        job.source = item.source;

        if (!titleFilter(job.title) || !locationFilter(job.location)) {
          totalFiltered++;
          continue;
        }

        const { isDuplicate, isPossibleDuplicate } = findDuplicateJob(job, trackerJobs);
        if (isDuplicate) {
          totalSemanticDupes++;
          process.stdout.write(`  ~ ${job.company} | ${job.title} - semantic dup skipped\n`);
          continue;
        }
        if (isPossibleDuplicate) {
          totalPossibleDupes++;
          job.possibleDup = true;
        }

        process.stdout.write(`  + [${job.source}] ${job.company} | ${job.title}`);
        const scored = await scoreJob(job, scoringState);
        if (scored) {
          job._score = scored.score;
          job._report = scored;
          process.stdout.write(` - ${scored.score}/5\n`);
        } else {
          process.stdout.write(' - (scoring unavailable)\n');
        }
        newJobs.push(job);
      } catch (err) {
        errors.push({ id: item.id, error: err.message });
        process.stdout.write(`  ! Detail failed for ${item.id}: ${err.message}\n`);
      }
    }

    if (!dryRun && newJobs.length > 0) {
      updateTracker(latest => {
        for (const job of newJobs) mergeIntoTracker(latest, job, date);
      });
      appendToPipeline(newJobs);
      appendToScanHistory(newJobs, date);
    }

    const bar = '-'.repeat(45);
    process.stdout.write(`\n${bar}\n`);
    process.stdout.write(`WTTJ Browser Scan - ${date}\n`);
    process.stdout.write(`${bar}\n`);
    process.stdout.write(`URLs harvested:   ${sourceMap.size} (${searchUrls.size} search, ${recommendedUrls.size} recommended, ${savedUrls.size} saved)\n`);
    process.stdout.write(`Filtered:         ${totalFiltered}\n`);
    process.stdout.write(`Semantic dupes:   ${totalSemanticDupes}\n`);
    process.stdout.write(`Possible dupes:   ${totalPossibleDupes}\n`);
    process.stdout.write(`New jobs added:   ${newJobs.length}\n`);
    process.stdout.write(`Errors:           ${errors.length}\n`);
    if (errors.length) {
      for (const e of errors) process.stdout.write(`  x ${e.id}: ${e.error}\n`);
    }
    if (dryRun) process.stdout.write('\n(dry run - run without --dry-run to save)\n');
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(err => {
    process.stderr.write(`Fatal: ${err.message}\n${err.stack}\n`);
    process.exit(1);
  });
}
