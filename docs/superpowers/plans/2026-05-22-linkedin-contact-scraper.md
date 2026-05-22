# LinkedIn CS Leadership Contact Scraper Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `scripts/scrape-linkedin-contacts.mjs` — a CLI that uses GoLogin + Playwright to find CS leadership contacts at active-pipeline companies and save them to `tracker.json`.

**Architecture:** Single script exporting pure helpers for testability; one GoLogin browser session kept open across all companies; writes via existing `upsertJobContact` + `updateTracker` APIs; saves progress after each company so a mid-run interruption doesn't lose work.

**Tech Stack:** Node.js v22 ES modules, Playwright (CDP via GoLogin), Cheerio 1.x, `lib/gologin-browser.mjs`, `lib/job-contacts.mjs`, `lib/tracker-store.mjs`.

---

## File Map

| File | Action | Purpose |
|---|---|---|
| `scripts/scrape-linkedin-contacts.mjs` | Create | Pure helpers + browser scrape + CLI entry point |
| `test/scrape-linkedin-contacts.test.mjs` | Create | Unit tests for all pure/exported functions |
| `package.json` | Modify | Add `scrape-contacts` npm script |

---

## Task 1: Pure helper functions — tests first

**Files:**
- Create: `test/scrape-linkedin-contacts.test.mjs`
- Create: `scripts/scrape-linkedin-contacts.mjs` (pure functions only, no browser code yet)

- [ ] **Step 1: Write failing tests**

Create `test/scrape-linkedin-contacts.test.mjs`:

```js
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  matchesContactTitle,
  buildSearchUrl,
  getActiveCompanies,
  contactCountForCompany,
} from '../scripts/scrape-linkedin-contacts.mjs';

describe('matchesContactTitle', () => {
  it('matches VP of Customer Success', () => {
    assert.equal(matchesContactTitle('VP of Customer Success'), true);
  });
  it('matches Director, Customer Success', () => {
    assert.equal(matchesContactTitle('Director, Customer Success'), true);
  });
  it('matches Head of Customer Success', () => {
    assert.equal(matchesContactTitle('Head of Customer Success'), true);
  });
  it('matches Chief Customer Officer', () => {
    assert.equal(matchesContactTitle('Chief Customer Officer'), true);
  });
  it('matches Customer Success Manager', () => {
    assert.equal(matchesContactTitle('Customer Success Manager'), true);
  });
  it('matches Senior Customer Success Manager', () => {
    assert.equal(matchesContactTitle('Senior Customer Success Manager'), true);
  });
  it('rejects unrelated title', () => {
    assert.equal(matchesContactTitle('Software Engineer'), false);
  });
  it('rejects empty string', () => {
    assert.equal(matchesContactTitle(''), false);
  });
  it('is case-insensitive', () => {
    assert.equal(matchesContactTitle('VP OF CUSTOMER SUCCESS'), true);
  });
});

describe('buildSearchUrl', () => {
  it('builds a LinkedIn people search URL', () => {
    const url = buildSearchUrl('Axonius');
    assert.ok(url.startsWith('https://www.linkedin.com/search/results/people/'));
    assert.ok(url.includes('customer') && url.includes('success'));
    assert.ok(url.includes('Axonius') || url.includes(encodeURIComponent('Axonius')));
  });
  it('encodes company names with spaces', () => {
    const url = buildSearchUrl('Quest Software');
    assert.match(url, /Quest/);
    assert.match(url, /Software/);
  });
});

describe('getActiveCompanies', () => {
  const tracker = {
    'job-1': { id: 'job-1', company: 'Axonius',    status: 'applied',                contacts: [] },
    'job-2': { id: 'job-2', company: 'Bonterra',   status: 'recruiter_screen',       contacts: [] },
    'job-3': { id: 'job-3', company: 'Axonius',    status: 'hiring_manager_screen',  contacts: [] },
    'job-4': { id: 'job-4', company: 'OldCo',      status: 'rejected',               contacts: [] },
    'job-5': { id: 'job-5', company: 'ArchivedCo', status: 'archived',               contacts: [] },
  };

  it('returns only active-pipeline companies', () => {
    const names = getActiveCompanies(tracker).map(c => c.company);
    assert.ok(names.includes('Axonius'));
    assert.ok(names.includes('Bonterra'));
    assert.ok(!names.includes('OldCo'));
    assert.ok(!names.includes('ArchivedCo'));
  });

  it('deduplicates companies with multiple jobs', () => {
    const entries = getActiveCompanies(tracker).filter(c => c.company === 'Axonius');
    assert.equal(entries.length, 1);
  });

  it('collects all jobIds for the same company', () => {
    const axonius = getActiveCompanies(tracker).find(c => c.company === 'Axonius');
    assert.deepEqual(axonius.jobIds.sort(), ['job-1', 'job-3'].sort());
  });
});

describe('contactCountForCompany', () => {
  const tracker = {
    'job-1': {
      id: 'job-1', company: 'Axonius', status: 'applied',
      contacts: [
        { id: 'c1', name: 'Alice', title: 'VP CS',       company: 'Axonius', relationshipType: 'employee', responseStatus: 'not_contacted' },
        { id: 'c2', name: 'Bob',   title: 'Director CS', company: 'Axonius', relationshipType: 'employee', responseStatus: 'not_contacted' },
      ],
    },
    'job-2': {
      id: 'job-2', company: 'Axonius', status: 'recruiter_screen',
      contacts: [
        { id: 'c3', name: 'Carol', title: 'Head of CS', company: 'Axonius', relationshipType: 'employee', responseStatus: 'not_contacted' },
      ],
    },
    'job-3': { id: 'job-3', company: 'Bonterra', status: 'applied', contacts: [] },
  };

  it('sums contacts across all jobs for a company', () => {
    assert.equal(contactCountForCompany(tracker, 'Axonius'), 3);
  });

  it('returns 0 for a company with no contacts', () => {
    assert.equal(contactCountForCompany(tracker, 'Bonterra'), 0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
node --test test/scrape-linkedin-contacts.test.mjs 2>&1 | tail -5
```
Expected: `Cannot find module '../scripts/scrape-linkedin-contacts.mjs'`

- [ ] **Step 3: Create the script with pure functions only**

Create `scripts/scrape-linkedin-contacts.mjs`:

```js
#!/usr/bin/env node
import '../lib/env.mjs';

import { load as cheerioLoad } from 'cheerio';
import { upsertJobContact } from '../lib/job-contacts.mjs';
import { loadTracker, updateTracker } from '../lib/tracker-store.mjs';
import { withBrowser } from '../lib/gologin-browser.mjs';

const ACTIVE_STATUSES = new Set([
  'applied', 'recruiter_screen', 'hiring_manager_screen', 'technical_screen',
]);
const MAX_CONTACTS_PER_COMPANY = 5;
const TITLE_KEYWORDS = ['vp', 'vice president', 'director', 'head of', 'chief customer', 'manager', 'lead'];

export function matchesContactTitle(title) {
  const t = title.toLowerCase();
  const hasCS  = t.includes('customer success');
  const hasCCO = t.includes('chief customer') || t.includes('cco');
  if (!hasCS && !hasCCO) return false;
  return TITLE_KEYWORDS.some(kw => t.includes(kw));
}

export function buildSearchUrl(company) {
  const params = new URLSearchParams({
    keywords: 'customer success',
    company,
    origin: 'FACETED_SEARCH',
  });
  return `https://www.linkedin.com/search/results/people/?${params}`;
}

export function getActiveCompanies(tracker) {
  const map = new Map();
  for (const job of Object.values(tracker)) {
    if (!ACTIVE_STATUSES.has(job.status) || !job.company) continue;
    const key = job.company.toLowerCase().trim();
    if (!map.has(key)) map.set(key, { company: job.company, jobIds: [] });
    map.get(key).jobIds.push(job.id);
  }
  return [...map.values()];
}

export function contactCountForCompany(tracker, company) {
  const key = company.toLowerCase().trim();
  return Object.values(tracker)
    .filter(job => (job.company || '').toLowerCase().trim() === key)
    .reduce((sum, job) => sum + (Array.isArray(job.contacts) ? job.contacts.length : 0), 0);
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
node --test test/scrape-linkedin-contacts.test.mjs 2>&1 | tail -8
```
Expected: all tests pass, 0 fail

- [ ] **Step 5: Commit**

```bash
git add scripts/scrape-linkedin-contacts.mjs test/scrape-linkedin-contacts.test.mjs
git commit -m "Add pure helper functions for LinkedIn contact scraper with tests"
```

---

## Task 2: HTML parser for LinkedIn people search results — tests first

**Files:**
- Modify: `test/scrape-linkedin-contacts.test.mjs`
- Modify: `scripts/scrape-linkedin-contacts.mjs`

- [ ] **Step 1: Add parser tests**

Add to the bottom of `test/scrape-linkedin-contacts.test.mjs`:

```js
import {
  parseContactCards,
  normalizeLinkedInUrl,
} from '../scripts/scrape-linkedin-contacts.mjs';

const SAMPLE_RESULTS_HTML = `
<ul>
  <li class="reusable-search__result-container">
    <div class="entity-result__item">
      <div class="entity-result__title-text">
        <a href="/in/janesmith?miniProfileUrn=abc123">
          <span aria-hidden="true">Jane Smith</span>
        </a>
      </div>
      <div class="entity-result__primary-subtitle">VP of Customer Success at Acme Corp</div>
    </div>
  </li>
  <li class="reusable-search__result-container">
    <div class="entity-result__item">
      <div class="entity-result__title-text">
        <a href="/in/bobdoe?miniProfileUrn=def456">
          <span aria-hidden="true">Bob Doe</span>
        </a>
      </div>
      <div class="entity-result__primary-subtitle">Software Engineer at Acme Corp</div>
    </div>
  </li>
  <li class="reusable-search__result-container">
    <div class="entity-result__item">
      <div class="entity-result__title-text">
        <a href="/in/carolwhite?miniProfileUrn=ghi789">
          <span aria-hidden="true">Carol White</span>
        </a>
      </div>
      <div class="entity-result__primary-subtitle">Director, Customer Success at Acme Corp</div>
    </div>
  </li>
</ul>
`;

describe('parseContactCards', () => {
  it('extracts CS leadership contacts and filters out non-CS titles', () => {
    const contacts = parseContactCards(SAMPLE_RESULTS_HTML);
    assert.equal(contacts.length, 2);
    assert.equal(contacts[0].name, 'Jane Smith');
    assert.equal(contacts[1].name, 'Carol White');
    assert.ok(!contacts.some(c => c.name === 'Bob Doe'));
  });

  it('strips "at Company Name" from title', () => {
    const contacts = parseContactCards(SAMPLE_RESULTS_HTML);
    assert.equal(contacts[0].title, 'VP of Customer Success');
    assert.ok(!contacts[0].title.includes(' at '));
  });

  it('normalizes linkedinUrl without tracking params', () => {
    const contacts = parseContactCards(SAMPLE_RESULTS_HTML);
    assert.equal(contacts[0].linkedinUrl, 'https://www.linkedin.com/in/janesmith');
  });

  it('returns empty array for empty results HTML', () => {
    assert.deepEqual(parseContactCards('<ul></ul>'), []);
  });
});

describe('normalizeLinkedInUrl', () => {
  it('strips tracking params from a full URL', () => {
    assert.equal(
      normalizeLinkedInUrl('https://www.linkedin.com/in/janesmith?miniProfileUrn=abc'),
      'https://www.linkedin.com/in/janesmith'
    );
  });
  it('converts a relative /in/ path to a full URL', () => {
    assert.equal(
      normalizeLinkedInUrl('/in/janesmith?miniProfileUrn=abc'),
      'https://www.linkedin.com/in/janesmith'
    );
  });
  it('returns empty string for empty input', () => {
    assert.equal(normalizeLinkedInUrl(''), '');
  });
});
```

- [ ] **Step 2: Run tests to verify new tests fail**

```bash
node --test test/scrape-linkedin-contacts.test.mjs 2>&1 | grep -E "not ok|parseContactCards|normalizeLinkedInUrl" | head -5
```
Expected: failures referencing `parseContactCards` and `normalizeLinkedInUrl`

- [ ] **Step 3: Add `normalizeLinkedInUrl` and `parseContactCards` to the script**

Add after `contactCountForCompany` in `scripts/scrape-linkedin-contacts.mjs`:

```js
export function normalizeLinkedInUrl(href) {
  if (!href) return '';
  const full = href.match(/(https?:\/\/(?:www\.)?linkedin\.com\/in\/[^/?#]+)/);
  if (full) return full[1];
  const rel = href.match(/\/in\/([^/?#]+)/);
  if (rel) return `https://www.linkedin.com/in/${rel[1]}`;
  return '';
}

export function parseContactCards(html) {
  const $ = cheerioLoad(html);
  const contacts = [];

  $('li.reusable-search__result-container, li[class*="result-container"]').each((_, el) => {
    try {
      const $el = $(el);

      const nameEl = $el.find('.entity-result__title-text a span[aria-hidden="true"]').first();
      const name = nameEl.text().trim();
      if (!name || name === 'LinkedIn Member') return;

      const rawTitle = $el.find('.entity-result__primary-subtitle').first().text().trim();
      const title = rawTitle.replace(/\s+at\s+.+$/i, '').trim();
      if (!matchesContactTitle(title)) return;

      const href = $el.find('.entity-result__title-text a').first().attr('href') || '';
      const linkedinUrl = normalizeLinkedInUrl(href);
      if (!linkedinUrl) return;

      contacts.push({ name, title, linkedinUrl });
    } catch { /* skip malformed card */ }
  });

  return contacts;
}
```

- [ ] **Step 4: Run tests to verify all pass**

```bash
node --test test/scrape-linkedin-contacts.test.mjs 2>&1 | tail -8
```
Expected: all tests pass, 0 fail

- [ ] **Step 5: Commit**

```bash
git add scripts/scrape-linkedin-contacts.mjs test/scrape-linkedin-contacts.test.mjs
git commit -m "Add LinkedIn contact card HTML parser with tests"
```

---

## Task 3: Auth wall and rate limit detection — tests first

**Files:**
- Modify: `test/scrape-linkedin-contacts.test.mjs`
- Modify: `scripts/scrape-linkedin-contacts.mjs`

- [ ] **Step 1: Add detection tests**

Add to the bottom of `test/scrape-linkedin-contacts.test.mjs`:

```js
import {
  isAuthWall,
  isRateLimited,
} from '../scripts/scrape-linkedin-contacts.mjs';

describe('isAuthWall', () => {
  it('detects /login redirect', () => {
    assert.equal(isAuthWall('https://www.linkedin.com/login?session_redirect=...'), true);
  });
  it('detects /authwall redirect', () => {
    assert.equal(isAuthWall('https://www.linkedin.com/authwall?trk=bf'), true);
  });
  it('detects /checkpoint redirect', () => {
    assert.equal(isAuthWall('https://www.linkedin.com/checkpoint/lg/login-submit'), true);
  });
  it('passes on a valid search results URL', () => {
    assert.equal(isAuthWall('https://www.linkedin.com/search/results/people/?keywords=customer+success'), false);
  });
});

describe('isRateLimited', () => {
  it('detects CAPTCHA page content', () => {
    assert.equal(isRateLimited('<html><body>captcha required</body></html>'), true);
  });
  it('detects unusual activity message', () => {
    assert.equal(isRateLimited('<html><body>unusual activity detected</body></html>'), true);
  });
  it('passes on a normal results page', () => {
    assert.equal(isRateLimited('<html><body><ul class="reusable-search"></ul></body></html>'), false);
  });
});
```

- [ ] **Step 2: Run tests to verify new tests fail**

```bash
node --test test/scrape-linkedin-contacts.test.mjs 2>&1 | grep -E "not ok|isAuthWall|isRateLimited" | head -5
```
Expected: failures for `isAuthWall` and `isRateLimited`

- [ ] **Step 3: Implement `isAuthWall` and `isRateLimited`**

Add after `parseContactCards` in `scripts/scrape-linkedin-contacts.mjs`:

```js
export function isAuthWall(url) {
  return /\/(login|authwall|checkpoint)(\/|$|\?)/.test(url);
}

export function isRateLimited(html) {
  const lower = html.toLowerCase();
  return lower.includes('captcha') || lower.includes('unusual activity') || lower.includes('rate limit');
}
```

- [ ] **Step 4: Run tests to verify all pass**

```bash
node --test test/scrape-linkedin-contacts.test.mjs 2>&1 | tail -8
```
Expected: all tests pass, 0 fail

- [ ] **Step 5: Commit**

```bash
git add scripts/scrape-linkedin-contacts.mjs test/scrape-linkedin-contacts.test.mjs
git commit -m "Add auth wall and rate limit detection with tests"
```

---

## Task 4: Browser scrape session — `scrapeAllCompanies`

**Files:**
- Modify: `scripts/scrape-linkedin-contacts.mjs`

- [ ] **Step 1: Add `scrapeAllCompanies` to the script**

Add after `isRateLimited` in `scripts/scrape-linkedin-contacts.mjs`:

```js
function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function randomDelay() {
  return sleep(3000 + Math.random() * 2000);
}

async function scrapeAllCompanies(
  companies,
  tracker,
  { dryRun = false, maxContacts = MAX_CONTACTS_PER_COMPANY } = {}
) {
  let companiesScraped = 0;
  let contactsFound    = 0;
  let companiesSkipped = 0;
  const errors         = [];

  await withBrowser(async (browser) => {
    // Auth check on first open — navigate to feed to verify the session is live
    const checkPage = await browser.newPage();
    await checkPage.goto('https://www.linkedin.com/feed/', {
      waitUntil: 'domcontentloaded',
      timeout:   20_000,
    });
    const checkUrl = checkPage.url();
    await checkPage.close();
    if (isAuthWall(checkUrl)) {
      throw new Error(
        'Not logged in to LinkedIn. Run: node scripts/scrape-linkedin-contacts.mjs --login'
      );
    }

    for (let i = 0; i < companies.length; i++) {
      const { company, jobIds } = companies[i];
      const existingCount = contactCountForCompany(tracker, company);

      if (existingCount >= maxContacts) {
        process.stdout.write(`  [skip] ${company} — already has ${existingCount} contacts\n`);
        companiesSkipped++;
        continue;
      }

      try {
        const page = await browser.newPage();
        const url  = buildSearchUrl(company);

        await page.goto(url, { waitUntil: 'networkidle', timeout: 15_000 });

        if (isAuthWall(page.url())) {
          await page.close();
          throw new Error(
            'Not logged in to LinkedIn. Run: node scripts/scrape-linkedin-contacts.mjs --login'
          );
        }

        const html = await page.content();
        await page.close();

        if (isRateLimited(html)) {
          process.stdout.write(`\n[WARN] LinkedIn rate limit after ${companiesScraped} companies. Stopping.\n`);
          break;
        }

        const slots   = maxContacts - existingCount;
        const found   = parseContactCards(html).slice(0, slots);
        contactsFound += found.length;
        process.stdout.write(`  ${company}: ${found.length} contact(s) found\n`);

        if (dryRun) {
          for (const c of found) {
            process.stdout.write(`    · ${c.name} — ${c.title} (${c.linkedinUrl})\n`);
          }
        } else {
          for (const contact of found) {
            for (const jobId of jobIds) {
              if (!tracker[jobId]) continue;
              upsertJobContact(tracker[jobId], {
                name:             contact.name,
                title:            contact.title,
                company,
                linkedinUrl:      contact.linkedinUrl,
                relationshipType: 'employee',
                responseStatus:   'not_contacted',
              });
            }
          }
          // Save after each company so a mid-run interruption preserves progress
          updateTracker(tracker);
        }

        companiesScraped++;
      } catch (err) {
        if (err.message.includes('Not logged in')) throw err;
        process.stderr.write(`  [error] ${company}: ${err.message}\n`);
        errors.push({ company, error: err.message });
      }

      if (i < companies.length - 1) await randomDelay();
    }
  });

  return { companiesScraped, contactsFound, companiesSkipped, errors };
}
```

- [ ] **Step 2: Verify script syntax**

```bash
node --check scripts/scrape-linkedin-contacts.mjs && echo "syntax OK"
```
Expected: `syntax OK`

- [ ] **Step 3: Run full test suite to confirm no regressions**

```bash
npm test 2>&1 | tail -8
```
Expected: all tests pass, 0 fail

- [ ] **Step 4: Commit**

```bash
git add scripts/scrape-linkedin-contacts.mjs
git commit -m "Add browser scrape session with per-company progress saves"
```

---

## Task 5: `--login` mode and `main()` CLI entry point

**Files:**
- Modify: `scripts/scrape-linkedin-contacts.mjs`

- [ ] **Step 1: Add `doLogin` and `main` to the script**

Append to the end of `scripts/scrape-linkedin-contacts.mjs`:

```js
async function doLogin() {
  process.stdout.write('Starting GoLogin browser for LinkedIn login…\n');
  await withBrowser(async (browser) => {
    const page = await browser.newPage();
    await page.goto('https://www.linkedin.com/login', {
      waitUntil: 'domcontentloaded',
      timeout: 20_000,
    });
    process.stdout.write(
      '\nBrowser open — log in to LinkedIn, then press Enter here to save session and exit.\n'
    );
    await new Promise(resolve => {
      process.stdin.setRawMode(false);
      process.stdin.resume();
      process.stdin.once('data', () => {
        process.stdin.pause();
        resolve();
      });
    });
    await page.close();
  });
  process.stdout.write(
    'Session saved to GoLogin profile. You can now run the scraper without --login.\n'
  );
}

async function main() {
  const args          = process.argv.slice(2);
  const dryRun        = args.includes('--dry-run');
  const loginMode     = args.includes('--login');
  const limitIdx      = args.indexOf('--limit');
  const limit         = limitIdx >= 0 ? parseInt(args[limitIdx + 1], 10) : Infinity;
  const companyIdx    = args.indexOf('--company');
  const companyFilter = companyIdx >= 0 ? (args[companyIdx + 1] ?? '').toLowerCase() : null;

  if (loginMode) {
    await doLogin();
    return;
  }

  if (dryRun) process.stdout.write('(dry run — no files will be written)\n\n');

  const tracker = loadTracker();
  let companies = getActiveCompanies(tracker);

  if (companyFilter) {
    companies = companies.filter(c => c.company.toLowerCase().includes(companyFilter));
    if (!companies.length) {
      process.stderr.write(`No active-pipeline company matching "${companyFilter}"\n`);
      process.exit(1);
    }
  }

  if (Number.isFinite(limit)) companies = companies.slice(0, limit);

  process.stdout.write(`Scraping contacts for ${companies.length} companies…\n\n`);

  const result = await scrapeAllCompanies(companies, tracker, { dryRun });

  const date = new Date().toISOString().slice(0, 10);
  process.stdout.write(`\n${'━'.repeat(45)}\n`);
  process.stdout.write(`LinkedIn Contact Scrape — ${date}\n`);
  process.stdout.write(`${'━'.repeat(45)}\n`);
  process.stdout.write(`Companies scraped:   ${result.companiesScraped}\n`);
  process.stdout.write(`Companies skipped:   ${result.companiesSkipped} (already at limit)\n`);
  process.stdout.write(`Contacts found:      ${result.contactsFound}\n`);
  if (result.errors.length) {
    process.stdout.write(`\nErrors (${result.errors.length}):\n`);
    for (const e of result.errors) process.stdout.write(`  ✗ ${e.company}: ${e.error}\n`);
  }
  if (dryRun) process.stdout.write('\n(dry run — run without --dry-run to save results)\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(err => {
    process.stderr.write(`Fatal: ${err.message}\n`);
    process.exit(1);
  });
}
```

- [ ] **Step 2: Verify syntax**

```bash
node --check scripts/scrape-linkedin-contacts.mjs && echo "syntax OK"
```
Expected: `syntax OK`

- [ ] **Step 3: Run full test suite**

```bash
npm test 2>&1 | tail -8
```
Expected: all tests pass, 0 fail (new test file adds ~30 tests; total will exceed 309)

- [ ] **Step 4: Commit**

```bash
git add scripts/scrape-linkedin-contacts.mjs
git commit -m "Add --login mode and main CLI for LinkedIn contact scraper"
```

---

## Task 6: npm script + final verification

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Add `scrape-contacts` to `package.json`**

In `package.json`, add `"scrape-contacts"` after `"coach:brag"` so the scripts block reads:

```json
"scripts": {
  "start":            "node server.mjs",
  "test":             "node --test test/*.test.mjs",
  "scan":             "node scan.mjs",
  "scan:linkedin":    "node scan-linkedin.mjs",
  "evaluate":         "node evaluate.mjs",
  "pipeline":         "node scan.mjs --days 2 && node evaluate.mjs --concurrency 4",
  "pipeline:full":    "node scan.mjs --days 10 && node evaluate.mjs --concurrency 4",
  "pipeline:linkedin":"node scan-linkedin.mjs",
  "pipeline:all":     "node scan.mjs --days 2 && node scan-linkedin.mjs && node evaluate.mjs --concurrency 4",
  "gmail-sync":       "node gmail-sync.mjs",
  "health":           "node scripts/health-check.mjs",
  "enrich:brag":      "node scripts/enrich-brag-doc.mjs",
  "coach:brag":       "node scripts/brag-quality.mjs",
  "scrape-contacts":  "node scripts/scrape-linkedin-contacts.mjs"
}
```

- [ ] **Step 2: Smoke test — dry-run single company (GoLogin must be running)**

```bash
node scripts/scrape-linkedin-contacts.mjs --dry-run --company "Axonius" 2>&1
```
Expected if not yet logged in:
```
Not logged in to LinkedIn. Run: node scripts/scrape-linkedin-contacts.mjs --login
```
Expected after login:
```
Scraping contacts for 1 companies…

  Axonius: N contact(s) found
    · Name — Title (https://www.linkedin.com/in/...)
```

- [ ] **Step 3: Run full test suite one final time**

```bash
npm test 2>&1 | tail -8
```
Expected: all tests pass, 0 fail

- [ ] **Step 4: Final commit**

```bash
git add package.json
git commit -m "Add scrape-contacts npm script"
```

---

## Usage After Implementation

```bash
# 1. One-time: log in to LinkedIn via GoLogin (GoLogin app must be open)
npm run scrape-contacts -- --login

# 2. Dry-run to preview what would be found
npm run scrape-contacts -- --dry-run

# 3. Live run — scrape all 45 active-pipeline companies
npm run scrape-contacts

# 4. Single company
npm run scrape-contacts -- --company "Axonius"

# 5. Batch of 10
npm run scrape-contacts -- --limit 10
```

Contacts appear immediately in `/contacts` and `/jobs/:id` on the dashboard — no server restart needed.
