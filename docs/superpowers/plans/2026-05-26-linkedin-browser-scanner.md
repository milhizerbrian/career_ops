# LinkedIn Browser Job Scanner — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `scan-linkedin-browser.mjs` — an authenticated LinkedIn job scanner that uses a saved `li_at` session cookie via Playwright to scrape search results and the user's saved-jobs list, feeding into the existing tracker/pipeline/scoring infrastructure.

**Architecture:** A self-contained entry-point script that uses `withBrowser` from `lib/gologin-browser.mjs` to drive a Playwright browser with the `li_at` cookie. Phase 1 harvests job IDs from authenticated search pages and the saved-jobs page; Phase 2 fetches details via the existing guest-API endpoint; Phase 3 scores and writes to tracker/pipeline. `parseDetail` is imported from the already-exported symbol in `scan-linkedin.mjs` to avoid duplicating ~200 lines of HTML parsing logic. All other logic is self-contained or imported from `lib/`.

**Tech Stack:** Node.js v22 ES modules, Playwright (already installed), Cheerio, js-yaml, existing `lib/` utilities (gologin-browser, evaluator, tracker-store, atomic-file, dedupe-utils)

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `scan-linkedin-browser.mjs` | Create | Entry point: all phases, CLI, pure helpers |
| `test/scan-linkedin-browser.test.mjs` | Create | Unit tests for pure exported functions |
| `package.json` | Modify | Add `scan:linkedin:browser`; update `pipeline:all` |

---

## Task 1: Write failing tests for all pure helpers

**Files:**
- Create: `test/scan-linkedin-browser.test.mjs`

- [ ] **Step 1: Create the test file**

```javascript
// test/scan-linkedin-browser.test.mjs
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  isAuthWall,
  buildSavedJobsUrl,
  scrapePageIds,
  paginationUrls,
  isCookieStale,
} from '../scan-linkedin-browser.mjs';

describe('isAuthWall', () => {
  it('returns true for /login URL', () => {
    assert.equal(isAuthWall('https://www.linkedin.com/login'), true);
  });
  it('returns true for /authwall URL', () => {
    assert.equal(isAuthWall('https://www.linkedin.com/authwall'), true);
  });
  it('returns true for /checkpoint URL', () => {
    assert.equal(isAuthWall('https://www.linkedin.com/checkpoint/something'), true);
  });
  it('returns false for /feed', () => {
    assert.equal(isAuthWall('https://www.linkedin.com/feed'), false);
  });
  it('returns false for jobs search URL', () => {
    assert.equal(isAuthWall('https://www.linkedin.com/jobs/search/?keywords=CSM'), false);
  });
});

describe('buildSavedJobsUrl', () => {
  it('returns the LinkedIn saved-jobs URL', () => {
    assert.equal(buildSavedJobsUrl(), 'https://www.linkedin.com/my-items/saved-jobs/');
  });
});

describe('scrapePageIds', () => {
  it('extracts IDs from data-entity-urn attributes', () => {
    const html = `
      <ul>
        <li data-entity-urn="urn:li:jobPosting:1234567890">Job A</li>
        <li data-entity-urn="urn:li:jobPosting:9876543210">Job B</li>
      </ul>`;
    const ids = scrapePageIds(html);
    assert.deepEqual(ids.sort(), ['1234567890', '9876543210'].sort());
  });

  it('falls back to data-job-id attributes', () => {
    const html = `
      <div data-job-id="1111111111">Job A</div>
      <div data-job-id="2222222222">Job B</div>`;
    const ids = scrapePageIds(html);
    assert.deepEqual(ids.sort(), ['1111111111', '2222222222'].sort());
  });

  it('deduplicates IDs appearing in both attribute types', () => {
    const html = `
      <li data-entity-urn="urn:li:jobPosting:3333333333" data-job-id="3333333333">Job</li>`;
    const ids = scrapePageIds(html);
    assert.equal(ids.length, 1);
    assert.equal(ids[0], '3333333333');
  });

  it('returns empty array when no IDs found', () => {
    const html = '<div class="no-jobs">Nothing here</div>';
    const ids = scrapePageIds(html);
    assert.deepEqual(ids, []);
  });

  it('ignores non-job entity URNs', () => {
    const html = `
      <li data-entity-urn="urn:li:company:12345">Company</li>
      <li data-entity-urn="urn:li:jobPosting:9999999999">Job</li>`;
    const ids = scrapePageIds(html);
    assert.deepEqual(ids, ['9999999999']);
  });
});

describe('paginationUrls', () => {
  const search = { keywords: 'Customer Success Manager', location: 'United States', f_WT: '2' };

  it('returns 1 URL for pages=1 with start=0', () => {
    const urls = paginationUrls(search, 1);
    assert.equal(urls.length, 1);
    assert.ok(urls[0].includes('start=0'));
    assert.ok(urls[0].includes('Customer+Success+Manager') || urls[0].includes('Customer%20Success%20Manager'));
  });

  it('returns 3 URLs for pages=3 with start=0,25,50', () => {
    const urls = paginationUrls(search, 3);
    assert.equal(urls.length, 3);
    assert.ok(urls[0].includes('start=0'));
    assert.ok(urls[1].includes('start=25'));
    assert.ok(urls[2].includes('start=50'));
  });

  it('includes location in URLs', () => {
    const urls = paginationUrls(search, 1);
    assert.ok(urls[0].includes('United+States') || urls[0].includes('United%20States'));
  });

  it('includes f_WT filter in URLs', () => {
    const urls = paginationUrls(search, 1);
    assert.ok(urls[0].includes('f_WT=2'));
  });

  it('uses /jobs/search/ base path (not guest API)', () => {
    const urls = paginationUrls(search, 1);
    assert.ok(urls[0].includes('linkedin.com/jobs/search/'));
    assert.ok(!urls[0].includes('jobs-guest'));
  });
});

describe('isCookieStale', () => {
  it('returns false for a cookie saved yesterday', () => {
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    assert.equal(isCookieStale(yesterday, 30), false);
  });

  it('returns true for a cookie saved 31 days ago', () => {
    const old = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
    assert.equal(isCookieStale(old, 30), true);
  });

  it('returns false for a cookie saved exactly 29 days ago', () => {
    const fresh = new Date(Date.now() - 29 * 24 * 60 * 60 * 1000).toISOString();
    assert.equal(isCookieStale(fresh, 30), false);
  });

  it('returns true for null savedAt', () => {
    assert.equal(isCookieStale(null, 30), true);
  });

  it('returns true for undefined savedAt', () => {
    assert.equal(isCookieStale(undefined, 30), true);
  });
});
```

- [ ] **Step 2: Run tests to confirm they all fail (module not found is expected)**

```bash
node --test test/scan-linkedin-browser.test.mjs 2>&1 | head -20
```

Expected: Error about `../scan-linkedin-browser.mjs` not found. That's the correct failure.

---

## Task 2: Implement pure helpers — make tests pass

**Files:**
- Create: `scan-linkedin-browser.mjs`

- [ ] **Step 1: Create the file with imports and pure exported helpers**

```javascript
#!/usr/bin/env node
import './lib/env.mjs';

import { readFileSync, existsSync, mkdirSync } from 'fs';
import path from 'path';
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
  return `${LI_BASE}/my-items/saved-jobs/`;
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
```

- [ ] **Step 2: Run tests — confirm all pass**

```bash
node --test test/scan-linkedin-browser.test.mjs
```

Expected output: all tests pass (some may warn about `parseDetail` import at module load if scan-linkedin.mjs runs side effects — that's OK, tests still pass).

- [ ] **Step 3: Commit**

```bash
git add scan-linkedin-browser.mjs test/scan-linkedin-browser.test.mjs
git commit -m "Add LinkedIn browser scanner pure helpers with tests"
```

---

## Task 3: Cookie loading and pre-flight checks

**Files:**
- Modify: `scan-linkedin-browser.mjs` — add after the pure helpers section

- [ ] **Step 1: Add cookie loading and pre-flight functions**

Add these functions after the `isCookieStale` export in `scan-linkedin-browser.mjs`:

```javascript
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
```

- [ ] **Step 2: Run all tests to confirm nothing broke**

```bash
node --test test/scan-linkedin-browser.test.mjs
```

Expected: all tests still pass.

- [ ] **Step 3: Commit**

```bash
git add scan-linkedin-browser.mjs
git commit -m "Add cookie loading with staleness warning"
```

---

## Task 4: HTTP fetch helpers

**Files:**
- Modify: `scan-linkedin-browser.mjs` — add after cookie loading section

- [ ] **Step 1: Add fetch helpers**

Add after the `loadCookie` function:

```javascript
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
```

- [ ] **Step 2: Run tests to confirm nothing broke**

```bash
node --test test/scan-linkedin-browser.test.mjs
```

Expected: all tests pass.

- [ ] **Step 3: Commit**

```bash
git add scan-linkedin-browser.mjs
git commit -m "Add HTTP fetch helpers with 429 retry backoff"
```

---

## Task 5: Search config, title filter, and seen-IDs loader

**Files:**
- Modify: `scan-linkedin-browser.mjs` — add after HTTP helpers

- [ ] **Step 1: Add these three functions**

```javascript
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
```

- [ ] **Step 2: Run tests**

```bash
node --test test/scan-linkedin-browser.test.mjs
```

Expected: all pass.

- [ ] **Step 3: Commit**

```bash
git add scan-linkedin-browser.mjs
git commit -m "Add search config, title filter, and seen-IDs loader"
```

---

## Task 6: Scoring pipeline

**Files:**
- Modify: `scan-linkedin-browser.mjs` — add after `loadTracker`

- [ ] **Step 1: Add scoring helpers**

```javascript
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
```

- [ ] **Step 2: Run tests**

```bash
node --test test/scan-linkedin-browser.test.mjs
```

Expected: all pass.

- [ ] **Step 3: Commit**

```bash
git add scan-linkedin-browser.mjs
git commit -m "Add scoring pipeline (Claude + LM Studio fallback)"
```

---

## Task 7: Tracker and pipeline write helpers

**Files:**
- Modify: `scan-linkedin-browser.mjs` — add after scoring pipeline

- [ ] **Step 1: Add write helpers**

```javascript
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
```

- [ ] **Step 2: Run tests**

```bash
node --test test/scan-linkedin-browser.test.mjs
```

Expected: all pass.

- [ ] **Step 3: Commit**

```bash
git add scan-linkedin-browser.mjs
git commit -m "Add tracker and pipeline write helpers"
```

---

## Task 8: Browser ID harvest

**Files:**
- Modify: `scan-linkedin-browser.mjs` — add after write helpers

- [ ] **Step 1: Add the two browser harvest functions**

```javascript
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
```

- [ ] **Step 2: Run tests**

```bash
node --test test/scan-linkedin-browser.test.mjs
```

Expected: all pass.

- [ ] **Step 3: Commit**

```bash
git add scan-linkedin-browser.mjs
git commit -m "Add browser ID harvest for search pages and saved jobs"
```

---

## Task 9: main() and CLI flags

**Files:**
- Modify: `scan-linkedin-browser.mjs` — add at the bottom of the file

- [ ] **Step 1: Add main() and the module entry guard**

```javascript
// ── Main ─────────────────────────────────────────────────────────────

async function main() {
  const args      = process.argv.slice(2);
  const dryRun    = args.includes('--dry-run');
  const noSaved   = args.includes('--no-saved');
  const savedOnly = args.includes('--saved-only');
  const limitIdx  = args.indexOf('--limit');
  const maxDetail = limitIdx >= 0 ? (parseInt(args[limitIdx + 1]) || 25) : 25;
  const pagesIdx  = args.indexOf('--pages');
  const pages     = pagesIdx  >= 0 ? (parseInt(args[pagesIdx  + 1]) || 3)  : 3;

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
  let searchIds = new Set();
  let savedIds  = new Set();

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
    }
    if (!noSaved) {
      savedIds = await harvestSavedIds(page);
    }
  });

  // ── Phase 2: Dedup + log already-tracked saved jobs ─────────────────
  const allIds = new Set([...searchIds, ...savedIds]);
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
  process.stdout.write(`IDs harvested:   ${allIds.size} (${searchIds.size} search, ${savedIds.size} saved)\n`);
  process.stdout.write(`New jobs added:  ${newJobs.length}\n`);
  process.stdout.write(`Errors:          ${errors.length}\n`);
  if (errors.length) {
    for (const e of errors) process.stdout.write(`  ✗ ${e.id}: ${e.error}\n`);
  }
  if (dryRun) process.stdout.write('\n(dry run — run without --dry-run to save)\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(err => {
    process.stderr.write(`Fatal: ${err.message}\n${err.stack}\n`);
    process.exit(1);
  });
}
```

- [ ] **Step 2: Run unit tests to confirm nothing broke**

```bash
node --test test/scan-linkedin-browser.test.mjs
```

Expected: all tests pass.

- [ ] **Step 3: Smoke test — dry run (requires li_at cookie to be present)**

```bash
node scan-linkedin-browser.mjs --dry-run --pages 1 --limit 3 2>&1 | head -30
```

Expected: Starts browser, navigates to LinkedIn feed, prints search output, exits cleanly. If you see `LinkedIn session expired` the cookie needs refreshing via `--set-cookie`.

- [ ] **Step 4: Commit**

```bash
git add scan-linkedin-browser.mjs
git commit -m "Add main() with CLI flags, browser harvest, dedup, and write pipeline"
```

---

## Task 10: Update package.json scripts

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Add `scan:linkedin:browser` and update `pipeline:all`**

In `package.json`, change:
```json
"pipeline:all": "node scan.mjs --days 2 && node scan-linkedin.mjs && node evaluate.mjs --concurrency 4",
```
to:
```json
"scan:linkedin:browser": "node scan-linkedin-browser.mjs",
"pipeline:all": "node scan.mjs --days 2 && node scan-linkedin.mjs && node scan-linkedin-browser.mjs && node evaluate.mjs --concurrency 4",
```

- [ ] **Step 2: Verify the scripts section looks right**

```bash
node -e "const p = JSON.parse(require('fs').readFileSync('package.json','utf8')); console.log(JSON.stringify(p.scripts, null, 2))"
```

Expected output includes:
```
"scan:linkedin:browser": "node scan-linkedin-browser.mjs",
"pipeline:all": "node scan.mjs --days 2 && node scan-linkedin.mjs && node scan-linkedin-browser.mjs && node evaluate.mjs --concurrency 4"
```

- [ ] **Step 3: Run all tests one final time**

```bash
npm test
```

Expected: all tests pass (existing suite + new browser scanner tests).

- [ ] **Step 4: Final commit**

```bash
git add package.json
git commit -m "Add scan:linkedin:browser script and include in pipeline:all"
```

---

## Self-Review Notes

- **Spec coverage check:** Phase 1 (browser harvest) ✓, Phase 2 (detail fetch) ✓, Phase 3 (score+write) ✓, all CLI flags ✓, all error handling cases ✓, source tagging ✓, already-tracked saved jobs logging ✓, cookie staleness warning ✓, package.json scripts ✓
- **`parseDetail` import:** Intentionally imported from `scan-linkedin.mjs` rather than duplicated — it's already exported there and pulling it in avoids ~200 lines of complex Cheerio parser duplication. The "self-contained" design intent was about not importing scan *logic* (buildSearches, main); parser utilities are stable utilities.
- **Type consistency:** `scrapePageIds` returns `string[]`, `paginationUrls` returns `string[]`, `isCookieStale` returns `boolean` — consistent throughout tasks 1–9.
- **`liView` in main():** `job.url = liView(id)` is set explicitly after `parseDetail` because `parseDetail` sets `source: 'linkedin-guest-api'` and we need to override that with the browser source tag.
