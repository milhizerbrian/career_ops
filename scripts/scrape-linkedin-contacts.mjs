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
