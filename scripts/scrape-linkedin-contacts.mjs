#!/usr/bin/env node
import '../lib/env.mjs';

import { load as cheerioLoad } from 'cheerio';
import { upsertJobContact } from '../lib/job-contacts.mjs';
import { loadTracker, updateTracker } from '../lib/tracker-store.mjs';
import { withBrowser, saveLinkedInCookie } from '../lib/gologin-browser.mjs';

const ACTIVE_STATUSES = new Set([
  'applied', 'recruiter_screen', 'hiring_manager_screen', 'technical_screen',
]);
const MAX_CONTACTS_PER_COMPANY = 5;
const TITLE_KEYWORDS = ['director', 'head of', 'chief customer', 'manager', 'lead'];

export function matchesContactTitle(title) {
  const t = title.toLowerCase();
  const hasCCO = t.includes('chief customer') || /\bcco\b/.test(t);
  if (hasCCO) return true; // CCO / Chief Customer Officer is always a match
  if (!t.includes('customer success')) return false;
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
  for (const [id, job] of Object.entries(tracker)) {
    if (!ACTIVE_STATUSES.has(job.status) || !job.company) continue;
    const key = job.company.toLowerCase().trim();
    if (!map.has(key)) map.set(key, { company: job.company, jobIds: [] });
    map.get(key).jobIds.push(job.id || id);
  }
  return [...map.values()];
}

export function contactCountForCompany(tracker, company) {
  const key = company.toLowerCase().trim();
  return Object.values(tracker)
    .filter(job => (job.company || '').toLowerCase().trim() === key)
    .reduce((sum, job) => sum + (Array.isArray(job.contacts) ? job.contacts.length : 0), 0);
}

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

  $('[role="listitem"], li.reusable-search__result-container, .reusable-search__result-container').each((_, el) => {
    try {
      const $el = $(el);

      // Profile URL: first /in/ link in the card
      let linkedinUrl = '';
      $el.find('a[href*="linkedin.com/in/"], a[href^="/in/"]').each((_, a) => {
        if (!linkedinUrl) linkedinUrl = normalizeLinkedInUrl($(a).attr('href') || '');
      });
      if (!linkedinUrl) return;

      // Name: profile photo img alt on live pages, title link text in saved/search fixtures.
      let name = '';
      $el.find('img[alt]').each((_, img) => {
        const alt = ($(img).attr('alt') || '').trim();
        if (alt && alt !== 'LinkedIn Member' && !name) name = alt;
      });
      if (!name) {
        name = $el.find('.entity-result__title-text a span[aria-hidden="true"]').first().text().trim()
          || $el.find('.entity-result__title-text a').first().text().trim();
      }
      if (!name) return;

      // Title: LinkedIn alternates between subtitle divs and leaf spans depending on page variant.
      let title = '';
      const titleCandidates = [
        $el.find('.entity-result__primary-subtitle').first().text().trim(),
        $el.find('.entity-result__summary').first().text().trim(),
      ].filter(Boolean);
      $el.find('span').each((_, span) => {
        if ($(span).children().length > 0) return; // skip non-leaf spans
        titleCandidates.push($(span).text().trim());
      });

      for (const text of titleCandidates) {
        if (matchesContactTitle(text)) {
          const cleaned = text.replace(/^Current:\s*/i, '');
          // Split on pipe, find the segment that itself matches CS keywords
          const segments = cleaned.split(/\s*\|\s*/);
          const best = segments.find(s => matchesContactTitle(s)) || segments[0];
          title = best.replace(/\s+at\s+.+$/i, '').trim();
          break;
        }
      }
      if (!title) return;

      contacts.push({ name, title, linkedinUrl });
    } catch { /* skip malformed card */ }
  });

  return contacts;
}

export function isAuthWall(url) {
  return /\/(login|authwall|checkpoint)(\/|$|\?)/.test(url);
}

export function isRateLimited(html) {
  const lower = html.toLowerCase();
  return lower.includes('captcha') || lower.includes('unusual activity') || lower.includes('rate limit');
}

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
      timeout:   30_000,
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

        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
        await sleep(3000); // let search results render

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
          const applyContacts = (draft) => {
            for (const contact of found) {
              const jobId = jobIds.find(id => draft[id]);
              if (!jobId) continue;
              upsertJobContact(draft[jobId], {
                name:             contact.name,
                title:            contact.title,
                company,
                linkedinUrl:      contact.linkedinUrl,
                relationshipType: 'employee',
                responseStatus:   'not_contacted',
              });
            }
          };

          // Save after each company so a mid-run interruption preserves progress
          updateTracker(applyContacts);
          applyContacts(tracker);
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

function doLogin() {
  process.stdout.write(`
LinkedIn session setup — one-time steps:

  1. Open LinkedIn in Chrome (linkedin.com) — you should already be logged in
  2. Open DevTools: Cmd+Option+I
  3. Application tab → Cookies → https://www.linkedin.com
  4. Find the cookie named  li_at  and copy its Value

  5. Run:
       node scripts/scrape-linkedin-contacts.mjs --set-cookie <paste_value_here>

That's it. After that, run the scraper normally without any flags.
`);
}

function doSetCookie(value) {
  if (!value || value.length < 20) {
    process.stderr.write('Error: provide the full li_at cookie value after --set-cookie\n');
    process.exit(1);
  }
  saveLinkedInCookie(value);
  process.stdout.write('LinkedIn session cookie saved. Run the scraper now.\n');
}

async function main() {
  const args          = process.argv.slice(2);
  const dryRun        = args.includes('--dry-run');
  const loginMode     = args.includes('--login');
  const limitIdx      = args.indexOf('--limit');
  const limit         = limitIdx >= 0 ? parseInt(args[limitIdx + 1], 10) : Infinity;
  const companyIdx    = args.indexOf('--company');
  const companyFilter = companyIdx >= 0 ? (args[companyIdx + 1] ?? '').toLowerCase() : null;
  const setCookieIdx  = args.indexOf('--set-cookie');

  if (loginMode) {
    doLogin();
    return;
  }

  if (setCookieIdx >= 0) {
    doSetCookie(args[setCookieIdx + 1]);
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
