# LinkedIn CS Leadership Contact Scraper — Design Spec
**Date:** 2026-05-22

## Summary

A new script (`scripts/scrape-linkedin-contacts.mjs`) that uses the GoLogin desktop browser profile + Playwright to search LinkedIn for CS leadership contacts at every active-pipeline company, then upserts them into the existing `tracker.json` contacts system. Surfaces immediately in the `/contacts` dashboard workspace.

---

## Scope

**Target jobs:** All tracker entries with status in `applied`, `recruiter_screen`, `hiring_manager_screen`, `technical_screen` (~45 companies as of spec date).

**Target titles (keyword match):**
- VP of Customer Success
- Director of Customer Success
- Head of Customer Success
- Chief Customer Officer (CCO)
- Customer Success Manager / Senior CSM (hiring manager tier)

**Contacts per company:** Up to 5. Companies that already have ≥5 contacts are skipped.

---

## Architecture

### New file
`scripts/scrape-linkedin-contacts.mjs`

Uses existing infrastructure:
- `lib/gologin-browser.mjs` — `withBrowser(fn)` for GoLogin session
- `lib/job-contacts.mjs` — `upsertJobContact()` for safe contact writes
- `lib/tracker-store.mjs` — `loadTracker()` / `updateTracker()` for persistence
- `lib/env.mjs` — environment loading

No new lib files needed. No schema changes.

### npm script (package.json addition)
```json
"scrape-contacts": "node scripts/scrape-linkedin-contacts.mjs"
```

---

## CLI Interface

```bash
node scripts/scrape-linkedin-contacts.mjs              # scrape all active-pipeline companies
node scripts/scrape-linkedin-contacts.mjs --login      # one-time LinkedIn session setup
node scripts/scrape-linkedin-contacts.mjs --dry-run    # preview contacts found, no writes
node scripts/scrape-linkedin-contacts.mjs --company "Axonius"   # single company
node scripts/scrape-linkedin-contacts.mjs --limit 10   # cap companies processed
```

---

## Two Modes

### `--login` mode (one-time setup)
1. Call `withBrowser()` to start the GoLogin Linkedin profile
2. Navigate to `https://www.linkedin.com/login`
3. Print: `"Browser open — log in to LinkedIn, then press Enter here to save session and exit."`
4. Wait for user keypress (stdin)
5. Close browser — GoLogin saves cookies to the profile automatically
6. Exit

### Scrape mode (normal run)
See flow below.

---

## Scrape Flow

1. Load tracker, filter jobs to active-pipeline statuses
2. Deduplicate by company name (one scrape per company even if multiple jobs)
3. For each company:
   a. Skip if company already has ≥5 contacts across any of its jobs
   b. Open browser via `withBrowser()`
   c. Navigate to LinkedIn people search URL:
      `https://www.linkedin.com/search/results/people/?keywords=customer+success&company=[encoded company name]`
   d. If redirected to `/login` or `/authwall` → throw with instructions to run `--login` first
   e. Wait for results to load (`networkidle`, 15s timeout)
   f. Extract up to 5 result cards matching title keywords
   g. For each match: extract name, title, LinkedIn profile URL
   h. Upsert into all tracker jobs matching that company via `upsertJobContact()`
   i. Sleep 3–5s (randomised) before next company

4. Print summary: companies scraped, contacts found, contacts saved, companies skipped
5. If `--dry-run`: print found contacts, write nothing

---

## Contact Shape Written to Tracker

Uses existing schema — no new fields:

```js
{
  name: "Jane Smith",
  title: "VP of Customer Success",
  company: "Axonius",
  linkedinUrl: "https://linkedin.com/in/janesmith",
  relationshipType: "employee",
  responseStatus: "not_contacted"
}
```

`relationshipType` is set to `"employee"` for all scraped contacts (existing valid value). Users can manually change to `"hiring_manager"` or `"recruiter"` from the dashboard.

---

## Error Handling

| Condition | Behaviour |
|---|---|
| Not logged in (redirected to `/login` or `/authwall`) | Print clear message, exit with code 1: `"Run with --login first to set up your LinkedIn session."` |
| Company page returns no results | Skip silently, log `[skip] No results for CompanyName` |
| LinkedIn rate-limit page (429 / CAPTCHA detected) | Stop scraping, print warning with count of companies processed so far |
| GoLogin app not running | `withBrowser()` throws — message: `"GoLogin start failed: is the GoLogin desktop app running?"` |
| Individual contact parse fails | Skip that card, continue to next |

---

## Rate Limiting

- 3–5 second randomised sleep between companies
- At 45 companies × ~4s avg = ~3 minutes total runtime
- If LinkedIn throttles mid-run, script stops cleanly and reports progress
- `--limit N` flag lets user run in batches if needed

---

## Dashboard Impact

No dashboard changes required. Scraped contacts appear immediately in:
- `/contacts` workspace (existing `buildContactsWorkspace()` read model)
- `/jobs/:id` contact panel (existing contact list renderer)
- Urgency counters for follow-up tracking

---

## Testing

New test file: `test/scrape-linkedin-contacts.test.mjs`

- Unit test: title keyword matching function
- Unit test: LinkedIn search URL builder
- Unit test: contact card HTML parser (with fixture HTML)
- Unit test: `--dry-run` flag prevents writes
- Unit test: company dedup (multiple jobs at same company → one scrape)
- Integration: skips companies already at ≥5 contacts

No real browser calls in tests — parser functions tested against static HTML fixtures.

---

## Out of Scope

- Email address discovery (not available on LinkedIn without premium)
- Automatic outreach message generation (existing feature — user triggers manually)
- LinkedIn login automation (must be done manually via `--login` flag)
- Scraping contacts at companies not in the active pipeline
