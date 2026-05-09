#!/usr/bin/env node

/**
 * scan.mjs — Zero-token portal scanner
 *
 * Fetches Greenhouse, Ashby, and Lever APIs directly, applies title
 * filters from portals.yml, deduplicates against existing history,
 * and appends new offers to pipeline.md + scan-history.tsv.
 *
 * Zero Claude API tokens — pure HTTP + JSON.
 *
 * Usage:
 *   node scan.mjs                  # scan all enabled companies
 *   node scan.mjs --dry-run        # preview without writing files
 *   node scan.mjs --company Cohere # scan a single company
 */

import { readFileSync, existsSync, mkdirSync } from 'fs';
import yaml from 'js-yaml';
import { findDuplicateJob } from './lib/dedupe-utils.mjs';
import { loadTracker } from './lib/tracker-store.mjs';
import { appendTextSafe, writeTextAtomic } from './lib/atomic-file.mjs';
const parseYaml = yaml.load;

// ── Config ──────────────────────────────────────────────────────────

const PORTALS_PATH = 'portals.yml';
const SCAN_HISTORY_PATH = 'data/scan-history.tsv';
const PIPELINE_PATH = 'data/pipeline.md';
const APPLICATIONS_PATH = 'data/applications.md';

// Ensure required directories exist (fresh setup)
mkdirSync('data', { recursive: true });

const CONCURRENCY = 10;
const FETCH_TIMEOUT_MS = 10_000;

// ── Date filter helpers ──────────────────────────────────────────────

/**
 * Build a cutoff Date given --days N CLI flag, or null (no filter).
 * Uses first arg after --days.
 */
function parseDaysArg(args) {
  const idx = args.indexOf('--days');
  if (idx === -1) return null;
  const n = parseInt(args[idx + 1], 10);
  if (!n || n <= 0) return null;
  const cutoff = new Date(Date.now() - n * 24 * 60 * 60 * 1000);
  return cutoff;
}

function isAfterCutoff(dateStr, cutoff) {
  if (!cutoff || !dateStr) return true; // no filter or no date → pass
  const d = typeof dateStr === 'number' ? new Date(dateStr) : new Date(dateStr);
  return d >= cutoff;
}

// ── API detection ───────────────────────────────────────────────────

function detectApi(company) {
  // Greenhouse: explicit api field
  if (company.api && company.api.includes('greenhouse')) {
    return { type: 'greenhouse', url: company.api };
  }

  const url = company.careers_url || '';

  // Ashby
  const ashbyMatch = url.match(/jobs\.ashbyhq\.com\/([^/?#]+)/);
  if (ashbyMatch) {
    return {
      type: 'ashby',
      url: `https://api.ashbyhq.com/posting-api/job-board/${ashbyMatch[1]}?includeCompensation=true`,
    };
  }

  // Lever
  const leverMatch = url.match(/jobs\.lever\.co\/([^/?#]+)/);
  if (leverMatch) {
    return {
      type: 'lever',
      url: `https://api.lever.co/v0/postings/${leverMatch[1]}`,
    };
  }

  // Greenhouse EU boards
  const ghEuMatch = url.match(/job-boards(?:\.eu)?\.greenhouse\.io\/([^/?#]+)/);
  if (ghEuMatch && !company.api) {
    return {
      type: 'greenhouse',
      url: `https://boards-api.greenhouse.io/v1/boards/${ghEuMatch[1]}/jobs`,
    };
  }

  return null;
}

// ── API parsers ─────────────────────────────────────────────────────

function parseGreenhouse(json, companyName, cutoff) {
  const jobs = json.jobs || [];
  return jobs
    .filter(j => isAfterCutoff(j.first_published || j.updated_at, cutoff))
    .map(j => ({
      title: j.title || '',
      url: j.absolute_url || '',
      company: companyName,
      location: j.location?.name || '',
    }));
}

function parseAshby(json, companyName, cutoff) {
  const jobs = json.jobs || [];
  return jobs
    .filter(j => isAfterCutoff(j.publishedAt, cutoff))
    .map(j => ({
      title: j.title || '',
      url: j.jobUrl || '',
      company: companyName,
      location: j.location || '',
    }));
}

function parseLever(json, companyName, cutoff) {
  if (!Array.isArray(json)) return [];
  return json
    .filter(j => isAfterCutoff(j.createdAt, cutoff)) // createdAt is ms timestamp
    .map(j => ({
      title: j.text || '',
      url: j.hostedUrl || '',
      company: companyName,
      location: j.categories?.location || '',
    }));
}

const PARSERS = {
  greenhouse: (json, name, cutoff) => parseGreenhouse(json, name, cutoff),
  ashby:      (json, name, cutoff) => parseAshby(json, name, cutoff),
  lever:      (json, name, cutoff) => parseLever(json, name, cutoff),
};

// ── Welcome to the Jungle (Algolia) ─────────────────────────────────

/**
 * Search WTTJ via Algolia for cybersecurity CS roles.
 * Uses a public search-only key (referer-restricted to welcometothejungle.com).
 * Returns a flat array of {title, url, company, location, source} objects.
 */
async function scanWttj(wttjConfig, titleFilter, locationFilter, seenUrls, seenCompanyRoles, cutoff) {
  const {
    algolia_app_id,
    algolia_api_key,
    algolia_index,
    queries = [],
    us_or_remote_only = true,
  } = wttjConfig;

  // Build Algolia numericFilters for date cutoff
  const numericFilters = cutoff
    ? [`published_at_timestamp >= ${Math.floor(cutoff.getTime() / 1000)}`]
    : [];

  const found = [];

  for (const query of queries) {
    let page = 0;
    while (true) {
      let data;
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS * 2);
        const res = await fetch(
          `https://${algolia_app_id}-dsn.algolia.net/1/indexes/${algolia_index}/query`,
          {
            method: 'POST',
            headers: {
              'X-Algolia-Application-Id': algolia_app_id,
              'X-Algolia-API-Key': algolia_api_key,
              'Content-Type': 'application/json',
              'Referer': 'https://www.welcometothejungle.com/',
              'Origin': 'https://www.welcometothejungle.com',
            },
            body: JSON.stringify({
              query,
              hitsPerPage: 50,
              page,
              filters: 'language:en',
              ...(numericFilters.length ? { numericFilters } : {}),
              attributesToRetrieve: [
                'name', 'slug', 'organization', 'offices',
                'remote', 'has_remote', 'reference', 'published_at_date',
              ],
            }),
            signal: controller.signal,
          }
        );
        clearTimeout(timer);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        data = await res.json();
      } catch (err) {
        process.stderr.write(`[wttj] query "${query}" page ${page}: ${err.message}\n`);
        break;
      }

      const hits = data.hits || [];

      for (const hit of hits) {
        const orgSlug = hit.organization?.slug;
        if (!orgSlug || !hit.slug) continue;

        const url = `https://www.welcometothejungle.com/en/companies/${orgSlug}/jobs/${hit.slug}`;

        // Determine US presence + remote status
        const offices = hit.offices || [];
        const usOffice = offices.find(o => o.country_code === 'US');
        const isRemote  = hit.remote === 'full' || hit.remote === 'partial' || hit.has_remote === true;

        if (us_or_remote_only && !usOffice && !isRemote) continue; // no US office, not remote

        // Build location string
        let location = '';
        if (usOffice) {
          location = [usOffice.city, usOffice.state].filter(Boolean).join(', ');
        } else if (isRemote) {
          location = 'Remote';
        } else {
          const first = offices[0];
          location = first ? [first.city, first.country].filter(Boolean).join(', ') : '';
        }

        if (!titleFilter(hit.name)) continue;
        if (!locationFilter(location)) continue;
        if (seenUrls.has(url)) continue;

        const key = `${(hit.organization?.name || '').toLowerCase()}::${hit.name.toLowerCase()}`;
        if (seenCompanyRoles.has(key)) continue;

        seenUrls.add(url);
        seenCompanyRoles.add(key);
        found.push({
          title:    hit.name.trim(),
          url,
          company:  hit.organization?.name || '',
          location,
          source:   'wttj',
        });
      }

      // Paginate if needed
      if (page >= (data.nbPages || 1) - 1 || hits.length < 50) break;
      page++;
    }
  }

  return found;
}

// ── Fetch with timeout ──────────────────────────────────────────────

async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// ── Title filter ────────────────────────────────────────────────────

function buildTitleFilter(titleFilter) {
  const positive = (titleFilter?.positive || []).map(k => k.toLowerCase());
  const negative = (titleFilter?.negative || []).map(k => k.toLowerCase());

  return (title) => {
    const lower = title.toLowerCase();
    const hasPositive = positive.length === 0 || positive.some(k => lower.includes(k));
    const hasNegative = negative.some(k => lower.includes(k));
    return hasPositive && !hasNegative;
  };
}

function buildLocationFilter(locationFilter) {
  const negative = (locationFilter?.negative || []).map(k => k.toLowerCase());
  // Empty location passes — many US-remote listings omit location entirely.
  return (location) => {
    if (!location) return true;
    const lower = location.toLowerCase();
    return !negative.some(k => lower.includes(k));
  };
}

// ── Dedup ───────────────────────────────────────────────────────────

function loadSeenUrls() {
  const seen = new Set();

  // scan-history.tsv
  if (existsSync(SCAN_HISTORY_PATH)) {
    const lines = readFileSync(SCAN_HISTORY_PATH, 'utf-8').split('\n');
    for (const line of lines.slice(1)) { // skip header
      const url = line.split('\t')[0];
      if (url) seen.add(url);
    }
  }

  // pipeline.md — extract URLs from checkbox lines
  if (existsSync(PIPELINE_PATH)) {
    const text = readFileSync(PIPELINE_PATH, 'utf-8');
    for (const match of text.matchAll(/- \[[ x]\] (https?:\/\/\S+)/g)) {
      seen.add(match[1]);
    }
  }

  // applications.md — extract URLs from report links and any inline URLs
  if (existsSync(APPLICATIONS_PATH)) {
    const text = readFileSync(APPLICATIONS_PATH, 'utf-8');
    for (const match of text.matchAll(/https?:\/\/[^\s|)]+/g)) {
      seen.add(match[0]);
    }
  }

  return seen;
}

/**
 * Load all jobs from tracker.json as a plain array for semantic dedupe.
 * Returns [] on any error (missing file, parse error, etc.).
 */
function loadTrackerForDedupe() {
  try {
    const obj = loadTracker();
    return Object.values(obj);
  } catch {
    return [];
  }
}

function loadSeenCompanyRoles() {
  const seen = new Set();
  if (existsSync(APPLICATIONS_PATH)) {
    const text = readFileSync(APPLICATIONS_PATH, 'utf-8');
    // Parse markdown table rows: | # | Date | Company | Role | ...
    for (const match of text.matchAll(/\|[^|]+\|[^|]+\|\s*([^|]+)\s*\|\s*([^|]+)\s*\|/g)) {
      const company = match[1].trim().toLowerCase();
      const role = match[2].trim().toLowerCase();
      if (company && role && company !== 'company') {
        seen.add(`${company}::${role}`);
      }
    }
  }
  return seen;
}

// ── Pipeline writer ─────────────────────────────────────────────────

function appendToPipeline(offers) {
  if (offers.length === 0) return;

  let text = existsSync(PIPELINE_PATH)
    ? readFileSync(PIPELINE_PATH, 'utf-8')
    : '# Pipeline\n\n## Pendientes\n\n';

  // Find "## Pendientes" section and append after it
  const marker = '## Pendientes';
  const idx = text.indexOf(marker);
  if (idx === -1) {
    // No Pendientes section — append at end before Procesadas
    const procIdx = text.indexOf('## Procesadas');
    const insertAt = procIdx === -1 ? text.length : procIdx;
    const block = `\n${marker}\n\n` + offers.map(o =>
      `- [ ] ${o.url} | ${o.company} | ${o.title}${o.possibleDup ? ' | ~dup?' : ''}`
    ).join('\n') + '\n\n';
    text = text.slice(0, insertAt) + block + text.slice(insertAt);
  } else {
    // Find the end of existing Pendientes content (next ## or end)
    const afterMarker = idx + marker.length;
    const nextSection = text.indexOf('\n## ', afterMarker);
    const insertAt = nextSection === -1 ? text.length : nextSection;

    const block = '\n' + offers.map(o =>
      `- [ ] ${o.url} | ${o.company} | ${o.title}${o.possibleDup ? ' | ~dup?' : ''}`
    ).join('\n') + '\n';
    text = text.slice(0, insertAt) + block + text.slice(insertAt);
  }

  writeTextAtomic(PIPELINE_PATH, text);
}

function appendToScanHistory(offers, date) {
  // Ensure file + header exist
  if (!existsSync(SCAN_HISTORY_PATH)) {
    writeTextAtomic(SCAN_HISTORY_PATH, 'url\tfirst_seen\tportal\ttitle\tcompany\tstatus\n');
  }

  const lines = offers.map(o =>
    `${o.url}\t${date}\t${o.source}\t${o.title}\t${o.company}\tadded`
  ).join('\n') + '\n';

  appendTextSafe(SCAN_HISTORY_PATH, lines);
}

// ── Parallel fetch with concurrency limit ───────────────────────────

async function parallelFetch(tasks, limit) {
  const results = [];
  let i = 0;

  async function next() {
    while (i < tasks.length) {
      const task = tasks[i++];
      results.push(await task());
    }
  }

  const workers = Array.from({ length: Math.min(limit, tasks.length) }, () => next());
  await Promise.all(workers);
  return results;
}

// ── Main ────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const companyFlag = args.indexOf('--company');
  const filterCompany = companyFlag !== -1 ? args[companyFlag + 1]?.toLowerCase() : null;
  const cutoff = parseDaysArg(args);
  if (cutoff) {
    console.log(`Date filter: jobs on or after ${cutoff.toISOString().slice(0, 10)} (${args[args.indexOf('--days') + 1]} days)`);
  }

  // 1. Read portals.yml
  if (!existsSync(PORTALS_PATH)) {
    console.error('Error: portals.yml not found. Run onboarding first.');
    process.exit(1);
  }

  const config = parseYaml(readFileSync(PORTALS_PATH, 'utf-8'));
  const companies = config.tracked_companies || [];
  const titleFilter = buildTitleFilter(config.title_filter);
  const locationFilter = buildLocationFilter(config.location_filter);

  // 2. Filter to enabled companies with detectable APIs
  const targets = companies
    .filter(c => c.enabled !== false)
    .filter(c => !filterCompany || c.name.toLowerCase().includes(filterCompany))
    .map(c => ({ ...c, _api: detectApi(c) }))
    .filter(c => c._api !== null);

  const skippedCount = companies.filter(c => c.enabled !== false).length - targets.length;

  console.log(`Scanning ${targets.length} companies via API (${skippedCount} skipped — no API detected)`);
  if (dryRun) console.log('(dry run — no files will be written)\n');

  // 3. Load dedup sets
  const seenUrls = loadSeenUrls();
  const seenCompanyRoles = loadSeenCompanyRoles();
  const trackerJobs = loadTrackerForDedupe();
  if (trackerJobs.length > 0) {
    console.log(`Semantic dedupe: loaded ${trackerJobs.length} jobs from tracker`);
  }

  // 4. Fetch all APIs
  const date = new Date().toISOString().slice(0, 10);
  let totalFound = 0;
  let totalFiltered = 0;
  let totalDupes = 0;
  let totalSemanticDupes = 0;
  let totalPossibleDupes = 0;
  const newOffers = [];
  const errors = [];

  const tasks = targets.map(company => async () => {
    const { type, url } = company._api;
    try {
      const json = await fetchJson(url);
      const jobs = PARSERS[type](json, company.name, cutoff);
      totalFound += jobs.length;

      for (const job of jobs) {
        if (!titleFilter(job.title)) {
          totalFiltered++;
          continue;
        }
        if (!locationFilter(job.location)) {
          totalFiltered++;
          continue;
        }
        if (seenUrls.has(job.url)) {
          totalDupes++;
          continue;
        }
        const key = `${job.company.toLowerCase()}::${job.title.toLowerCase()}`;
        if (seenCompanyRoles.has(key)) {
          totalDupes++;
          continue;
        }
        // Semantic dedupe — cross-platform / title-variant detection
        const { isDuplicate, isPossibleDuplicate } = findDuplicateJob(job, trackerJobs);
        if (isDuplicate) {
          totalSemanticDupes++;
          continue;
        }
        // Mark as seen to avoid intra-scan dupes
        seenUrls.add(job.url);
        seenCompanyRoles.add(key);
        newOffers.push({ ...job, source: `${type}-api`, possibleDup: isPossibleDuplicate });
        if (isPossibleDuplicate) totalPossibleDupes++;
      }
    } catch (err) {
      errors.push({ company: company.name, error: err.message });
    }
  });

  await parallelFetch(tasks, CONCURRENCY);

  // 4b. Scan Welcome to the Jungle (Algolia)
  if (config.wttj_searches?.enabled && !filterCompany) {
    process.stdout.write('Scanning Welcome to the Jungle (Algolia)...\n');
    try {
      const wttjOffers = await scanWttj(
        config.wttj_searches,
        titleFilter,
        locationFilter,
        seenUrls,
        seenCompanyRoles,
        cutoff
      );
      totalFound += wttjOffers.length;
      let wttjAdded = 0;
      for (const offer of wttjOffers) {
        const { isDuplicate, isPossibleDuplicate } = findDuplicateJob(offer, trackerJobs);
        if (isDuplicate) {
          totalSemanticDupes++;
          continue;
        }
        newOffers.push({ ...offer, possibleDup: isPossibleDuplicate });
        if (isPossibleDuplicate) totalPossibleDupes++;
        wttjAdded++;
      }
      process.stdout.write(`  WTTJ: ${wttjAdded} new offers found (${wttjOffers.length - wttjAdded} semantic dupes skipped)\n`);
    } catch (err) {
      errors.push({ company: 'Welcome to the Jungle', error: err.message });
    }
  }

  // 5. Write results
  if (!dryRun && newOffers.length > 0) {
    appendToPipeline(newOffers);
    appendToScanHistory(newOffers, date);
  }

  // 6. Print summary
  console.log(`\n${'━'.repeat(45)}`);
  console.log(`Portal Scan — ${date}`);
  if (cutoff) console.log(`Date filter:           since ${cutoff.toISOString().slice(0, 10)}`);
  console.log(`${'━'.repeat(45)}`);
  console.log(`Companies scanned:     ${targets.length}`);
  console.log(`Total jobs found:      ${totalFound}`);
  console.log(`Filtered by title/loc: ${totalFiltered} removed`);
  console.log(`Exact duplicates:      ${totalDupes} skipped`);
  console.log(`Semantic duplicates:   ${totalSemanticDupes} skipped`);
  console.log(`Possible dupes:        ${totalPossibleDupes} flagged (~dup? marker)`);
  console.log(`New offers added:      ${newOffers.length}`);

  if (errors.length > 0) {
    console.log(`\nErrors (${errors.length}):`);
    for (const e of errors) {
      console.log(`  ✗ ${e.company}: ${e.error}`);
    }
  }

  if (newOffers.length > 0) {
    console.log('\nNew offers:');
    for (const o of newOffers) {
      console.log(`  + ${o.company} | ${o.title} | ${o.location || 'N/A'}`);
    }
    if (dryRun) {
      console.log('\n(dry run — run without --dry-run to save results)');
    } else {
      console.log(`\nResults saved to ${PIPELINE_PATH} and ${SCAN_HISTORY_PATH}`);
    }
  }

  console.log(`\n→ Run /career-ops pipeline to evaluate new offers.`);
  console.log('→ Share results and get help: https://discord.gg/8pRpHETxa4');
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
