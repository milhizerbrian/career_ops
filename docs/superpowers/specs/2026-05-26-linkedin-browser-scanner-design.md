# LinkedIn Browser Job Scanner — Design Spec

**Date:** 2026-05-26
**Status:** Approved

---

## Overview

A new authenticated LinkedIn job scanner (`scan-linkedin-browser.mjs`) that uses
a saved `li_at` session cookie via Playwright to scrape job listings from
LinkedIn's authenticated search pages and the user's saved-jobs list. Runs
alongside the existing guest-API scanner (`scan-linkedin.mjs`) — neither replaces
nor modifies it.

---

## Architecture & Files

| File | Change |
|---|---|
| `scan-linkedin-browser.mjs` | **New** — entry point for authenticated browser scan |
| `test/scan-linkedin-browser.test.mjs` | **New** — unit tests for pure helper functions |
| `lib/gologin-browser.mjs` | **None** — `withBrowser` already works as needed |
| `scan-linkedin.mjs` | **None** — guest API scanner untouched |
| `package.json` | Add `scan:linkedin:browser` script; add to `pipeline:all` |

The new scanner is **self-contained** — it does not import from `scan-linkedin.mjs`.
It duplicates only the two functions it needs (`buildSearches` from portals.yml,
`fetchJobDetail` via guest API). All other shared logic (tracker, pipeline.md,
scan-history, evaluator) is imported from `lib/` as normal.

---

## Data Flow

### Phase 1 — ID harvest via browser

1. Load `li_at` cookie from `~/.career-ops-linkedin/cookies.json`. If missing,
   fail fast with: *"No LinkedIn session cookie. Run: node scripts/scrape-linkedin-contacts.mjs --set-cookie <value>"*
2. If `savedAt` is older than 30 days, print a warning (non-blocking):
   *"li_at cookie is X days old — consider refreshing if you see auth failures."*
3. Call `withBrowser(async context => { … })` — launches Playwright Chromium with
   cookie injected.
4. **Auth check:** navigate to `https://www.linkedin.com/feed` (45s timeout).
   If final URL matches `/login` or `/authwall`, fail fast:
   *"LinkedIn session expired. Run: node scripts/scrape-linkedin-contacts.mjs --set-cookie <value>"*
5. **Keyword searches:** for each search from `buildSearches(config)`, generate
   paginated URLs (`start=0`, `start=25`, `start=50` … up to `--pages N`, default 3).
   Navigate each URL, extract IDs via `data-entity-urn` / `data-job-id` attributes.
   If a page yields 0 IDs, log a warning with the URL (selector rot signal) and
   continue.
6. **Saved jobs:** unless `--no-saved` is passed, navigate to
   `https://www.linkedin.com/my-items/saved-jobs/`, scroll to load all items,
   extract IDs the same way. If the page yields 0 IDs, log a warning and continue
   (don't abort the run). Tag these IDs in a separate `savedIds` Set.
7. Merge all IDs into one deduplicated Set. Filter against `seenIds`
   (scan-history + tracker + pipeline.md). For any ID already in tracker that came
   from `savedIds`, log: *"[saved] <title> at <company> — already tracked"*.

### Phase 2 — Detail fetch via guest API

For each unseen ID (up to `--limit N`, default 25):

- Fetch via `/jobs-guest/jobs/api/jobPosting/{id}` with the existing retry /
  rate-limit backoff (3 attempts, 60s wait on 429).
- Parse description, structured sections, compensation, keywords with the same
  Cheerio parsers used by the guest scanner.
- Tag `source: 'linkedin-browser'` for search-sourced jobs,
  `source: 'linkedin-saved'` for saved-jobs-sourced jobs.

### Phase 3 — Score + write

Pass each job through the existing `buildScoringState` / LM Studio / Claude
evaluator pipeline. Write results to `tracker.json`, `pipeline.md`, and
`scan-history.tsv`. Identical to what the guest scanner does.

---

## CLI Flags

| Flag | Default | Description |
|---|---|---|
| `--dry-run` | off | Preview without writing files |
| `--limit N` | 25 | Cap total detail fetches across all sources |
| `--pages N` | 3 | Pages of search results to scroll per search (~25 results each) |
| `--no-saved` | off | Skip saved-jobs harvest |
| `--saved-only` | off | Skip keyword searches, only harvest saved jobs |

---

## npm Scripts

```json
"scan:linkedin:browser": "node scan-linkedin-browser.mjs",
"pipeline:all": "node scan.mjs --days 2 && node scan-linkedin.mjs && node scan-linkedin-browser.mjs && node evaluate.mjs --concurrency 4"
```

---

## Error Handling

| Condition | Behavior |
|---|---|
| No `li_at` cookie on disk | Fail fast before launching browser |
| Cookie older than 30 days | Non-blocking warning, run continues |
| Auth wall on `/feed` navigate | Fail fast with refresh instructions |
| Search page yields 0 IDs | Warn + URL logged, continue |
| Saved-jobs page yields 0 IDs | Warn, continue (don't abort run) |
| Detail fetch 429 | 3-attempt backoff, 60s wait each |
| Page navigation timeout | 45s per page; error logged, page skipped |
| Saved job already in tracker | Log `[saved]` notice, skip re-add |

---

## Source Tags in scan-history / tracker

| Source | Meaning |
|---|---|
| `linkedin-guest-api` | Existing guest API scanner |
| `linkedin-browser` | New browser scanner — keyword search result |
| `linkedin-saved` | New browser scanner — from user's saved jobs list |

---

## Testing

File: `test/scan-linkedin-browser.test.mjs`

Pure functions only (no browser, no network):

- **`isAuthWall(url)`** — login/authwall URLs → true; feed/jobs URLs → false
- **`buildSavedJobsUrl()`** — returns correct LinkedIn saved-jobs URL
- **`scrapePageIds(html)`** — fixture HTML: normal results, zero results, mixed
  `data-entity-urn` and `data-job-id` attributes
- **`paginationUrls(search, pages)`** — correct URLs generated for 1, 3, and
  custom page counts
- **`isCookieStale(savedAt, thresholdDays)`** — date math, boundary cases

`withBrowser` and live LinkedIn navigation are integration-only — not unit tested,
consistent with contact scraper convention.
