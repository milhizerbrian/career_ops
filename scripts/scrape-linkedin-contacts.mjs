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
