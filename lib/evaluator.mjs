/**
 * lib/evaluator.mjs — Shared job evaluation logic
 *
 * Exports the core evaluation functions used by both evaluate.mjs (CLI) and
 * server.mjs (POST /api/evaluate-url). Keeping these here avoids duplicating
 * the JD fetching and scoring code.
 */

import { mkdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  loadTracker as loadStoredTracker,
  saveTrackerAtomic,
  updateTracker,
} from './tracker-store.mjs';
import { writeTextAtomic } from './atomic-file.mjs';
import { normalizeStatus } from './status-utils.mjs';
import { validatePublicHttpUrl } from './url-safety.mjs';
import { getLmStudioAnalysisModel } from './lm-studio-config.mjs';

const APP_ROOT    = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const FETCH_TIMEOUT_MS     = 15_000;
const LM_STUDIO_TIMEOUT_MS = 120_000;
const LM_STUDIO_BASE       = 'http://localhost:1234';

// Max chars stored in full_description — large enough to hold a complete JD
export const DESC_CAP = 8000;
// Chars sent to LM Studio for scoring — bounded by the model's context window
const SCORE_DESC_CAP = 2500;

export const PROFILE_SUMMARY = `CANDIDATE: Brian Milhizer | 22yr cybersecurity CSM | NDR/SIEM/XDR/EDR/IAM
ROLES: Strategic CSM, Director/VP CS, SE, TAM | LOCATION: DFW or remote only
COMP: $165K–$220K floor | CEH, Gainsight, Salesforce, SOAR
DEAL-BREAKERS (score≤1.5): <$165K comp, on-site outside DFW, no cyber relevance, pure sales (AE)
BOOSTS: post-2020 company+0.5, <1000 employees+0.5
SCALE: 5=perfect(cyber+comp+role) 4=strong 3=moderate 2=weak 1=poor`;

// ── Company name helpers ───────────────────────────────────────────────────

/**
 * Convert an ATS URL slug to a human-readable company name.
 * "palo-alto-networks" → "Palo Alto Networks"
 * "wiz-1"             → "Wiz"  (trailing numeric suffix stripped)
 */
export function slugToTitle(slug) {
  if (!slug) return '';
  return slug
    .replace(/-\d+$/, '')
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase())
    .trim();
}

/**
 * Extract a human-readable company name from a known ATS URL.
 * Returns '' for unrecognized URL patterns.
 */
export function extractCompanyFromUrl(url) {
  if (!url) return '';
  const gh   = url.match(/greenhouse\.io\/([^/?#]+)\/jobs/);
  if (gh)   return slugToTitle(gh[1]);
  const lv   = url.match(/jobs\.lever\.co\/([^/?#]+)\//);
  if (lv)   return slugToTitle(lv[1]);
  const ab   = url.match(/ashbyhq\.com\/([^/?#]+)\//);
  if (ab)   return slugToTitle(ab[1]);
  const wttj = url.match(/welcometothejungle\.com\/en\/companies\/([^/?#]+)\//);
  if (wttj) return slugToTitle(wttj[1]);
  return '';
}

// ── ID generation ──────────────────────────────────────────────────────────

export function urlToId(url) {
  const ghMatch = url.match(/greenhouse\.io\/([^/?#]+)\/jobs[/?](?:gh_jid=)?(\d+)/);
  if (ghMatch) return `gh-${ghMatch[2]}`;

  const lvMatch = url.match(/lever\.co\/[^/]+\/([a-f0-9-]{8,})/i);
  if (lvMatch) return `lv-${lvMatch[1].slice(0, 8)}`;

  const abMatch = url.match(/ashbyhq\.com\/[^/]+\/([a-f0-9-]{8,})/i);
  if (abMatch) return `ab-${abMatch[1].slice(0, 8)}`;

  const wttjMatch = url.match(/welcometothejungle\.com\/en\/companies\/[^/]+\/jobs\/([^?#]+)/);
  if (wttjMatch) return `wttj-${wttjMatch[1].replace(/_/g, '-').slice(0, 24)}`;

  const wdMatch = url.match(/myworkdayjobs\.com\/[^/]+\/job\/[^/]+\/([^/?\s]+)/i);
  if (wdMatch) return `wd-${wdMatch[1].slice(0, 20)}`;

  // Fallback: djb2 hash
  let h = 5381;
  for (const c of url) h = ((h << 5) + h + c.charCodeAt(0)) | 0;
  return `url-${Math.abs(h).toString(36).padStart(8, '0')}`;
}

// ── Playwright renderer (lazy — only invoked when API/static fetch fails) ──

// Render a page with a headless browser and return the final HTML.
async function fetchRenderedHtml(url, timeoutMs = 30_000) {
  await validatePublicHttpUrl(url);
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.route('**/*', async route => {
      try {
        await validatePublicHttpUrl(route.request().url());
        await route.continue();
      } catch {
        await route.abort();
      }
    });
    await page.setExtraHTTPHeaders({ 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' });
    await page.goto(url, { waitUntil: 'networkidle', timeout: timeoutMs });
    return await page.content();
  } finally {
    await browser.close();
  }
}

// Render a company-hosted Greenhouse embed page and intercept the API call that
// the widget makes to discover the real board token, then fetch structured job
// data directly from the Greenhouse API.
async function fetchGreenhouseViaPlaywright(url, jobId, timeoutMs = 30_000) {
  await validatePublicHttpUrl(url);
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.route('**/*', async route => {
      try {
        await validatePublicHttpUrl(route.request().url());
        await route.continue();
      } catch {
        await route.abort();
      }
    });
    const interceptedTokens = new Set();
    page.on('request', req => {
      const m = req.url().match(/boards-api\.greenhouse\.io\/v1\/boards\/([^/]+)\/jobs/);
      if (m) interceptedTokens.add(m[1]);
    });
    await page.setExtraHTTPHeaders({ 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' });
    await page.goto(url, { waitUntil: 'networkidle', timeout: timeoutMs });

    // Try each token we intercepted from the widget's API calls
    for (const token of interceptedTokens) {
      try {
        const [jobData, boardData] = await Promise.all([
          fetchJson(`https://boards-api.greenhouse.io/v1/boards/${token}/jobs/${jobId}`),
          fetchJson(`https://boards-api.greenhouse.io/v1/boards/${token}`).catch(() => null),
        ]);
        if (jobData?.title) {
          const desc = jobData.content ? stripHtml(jobData.content) : '';
          return {
            title:        jobData.title || '',
            location:     jobData.location?.name || '',
            description:  desc,
            compensation: extractComp(desc),
            company:      boardData?.name || '',
          };
        }
      } catch { /* try next token */ }
    }

    // No token intercepted or API returned no data — fall back to rendered DOM
    const html = await page.content();
    const h1 = await page.$eval('h1', el => el.textContent.trim()).catch(() => '');
    const desc = stripHtml(html);
    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    const rawTitle = titleMatch ? titleMatch[1].replace(/\s*[-|].*$/, '').trim() : '';
    const careersAt = rawTitle.match(/^(?:Careers|Jobs)\s+at\s+(.+)$/i);
    return {
      title:        h1 || (careersAt ? '' : rawTitle),
      company:      careersAt ? careersAt[1].trim() : '',
      location:     '',
      description:  desc,
      compensation: extractComp(desc),
    };
  } finally {
    await browser.close();
  }
}

// ── HTTP helpers ───────────────────────────────────────────────────────────

async function safeFetch(url, { timeoutMs = FETCH_TIMEOUT_MS, headers = {}, maxRedirects = 5 } = {}) {
  let current = await validatePublicHttpUrl(url);
  for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(current, {
        signal: controller.signal,
        headers,
        redirect: 'manual',
      });
      if (res.status >= 300 && res.status < 400 && res.headers.has('location')) {
        if (redirectCount === maxRedirects) throw new Error('Too many redirects');
        current = await validatePublicHttpUrl(new URL(res.headers.get('location'), current).toString());
        continue;
      }
      return res;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error('Too many redirects');
}

async function fetchJson(url, timeoutMs = FETCH_TIMEOUT_MS) {
  const res = await safeFetch(url, { timeoutMs });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.json();
}

async function fetchHtml(url, timeoutMs = FETCH_TIMEOUT_MS) {
  const res = await safeFetch(url, {
    timeoutMs,
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; career-ops-evaluator/1.0)' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.text();
}

export function stripHtml(html) {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

export function extractComp(text) {
  if (!text) return '';
  const m = text.match(/\$[\d,]+(?:K|k)?(?:\s*[-–—]\s*\$[\d,]+(?:K|k)?)?(?:\s*(?:per year|annually|\/yr|base))?/);
  return m ? m[0] : '';
}

// ── JD fetchers per ATS ────────────────────────────────────────────────────

async function fetchGreenhouseJob(url) {
  const directMatch = url.match(/greenhouse\.io\/([^/?#]+)\/jobs\/(\d+)/);
  const jidMatch    = url.match(/greenhouse\.io\/([^/?#]+)\/jobs\?.*gh_jid=(\d+)/);
  const m = directMatch || jidMatch;

  if (m) {
    const [, board, jobId] = m;
    const data = await fetchJson(`https://boards-api.greenhouse.io/v1/boards/${board}/jobs/${jobId}`);
    const desc = data.content ? stripHtml(data.content) : '';
    return {
      title:        data.title || '',
      location:     data.location?.name || '',
      description:  desc,
      compensation: extractComp(desc),
    };
  }

  // Company-domain URL with ?gh_jid= — derive board token, then use API
  const jidOnly = url.match(/[?&]gh_jid=(\d+)/);
  if (jidOnly) {
    const jobId = jidOnly[1];

    // Fetch the page HTML (best-effort — JS-rendered pages may be empty)
    let html = '';
    try { html = await fetchHtml(url); } catch { /* ignore fetch errors */ }

    // Derive board token: embedded JS config takes priority, then hostname
    let boardToken = null;
    const tokenInHtml = html.match(/boardToken['":\s]+['"]([a-z0-9_-]+)['"]/i)
      || html.match(/greenhouse\.io[^"']*[?&]for=([a-z0-9_-]+)/i);
    if (tokenInHtml) {
      boardToken = tokenInHtml[1];
    } else {
      try {
        const hostname = new URL(url).hostname.replace(/^www\./, '');
        boardToken = hostname.split('.')[0];
      } catch { /* ignore */ }
    }

    // Try the Greenhouse API — attempt primary token and a dot→dash variant
    // (e.g. "placer.ai" → primary "placer", alternate "placer-ai")
    if (boardToken) {
      let hostname2 = '';
      try { hostname2 = new URL(url).hostname.replace(/^www\./, '').replace(/\./g, '-'); } catch { /* ignore */ }
      const candidates = [boardToken, hostname2].filter((t, i, a) => t && a.indexOf(t) === i);

      for (const token of candidates) {
        try {
          const [jobData, boardData] = await Promise.all([
            fetchJson(`https://boards-api.greenhouse.io/v1/boards/${token}/jobs/${jobId}`),
            fetchJson(`https://boards-api.greenhouse.io/v1/boards/${token}`).catch(() => null),
          ]);
          if (jobData?.title) {
            const desc = jobData.content ? stripHtml(jobData.content) : '';
            return {
              title:        jobData.title || '',
              location:     jobData.location?.name || '',
              description:  desc,
              compensation: extractComp(desc),
              company:      boardData?.name || '',
            };
          }
        } catch { /* try next candidate */ }
      }
    }

    // Last resort: try Playwright to intercept the widget's API call.
    try {
      const pw = await fetchGreenhouseViaPlaywright(url, jobId);
      if (pw?.title || pw?.description) return pw;
    } catch { /* Playwright unavailable or timed out — fall through */ }

    // Static HTML scrape — <title> "Careers at X" → extract company, leave title blank.
    const desc = html ? stripHtml(html) : '';
    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    const rawPageTitle = titleMatch ? titleMatch[1].replace(/\s*[-|].*$/, '').trim() : '';
    const careersAt = rawPageTitle.match(/^(?:Careers|Jobs)\s+at\s+(.+)$/i);
    return {
      title:        careersAt ? '' : rawPageTitle,
      company:      careersAt ? careersAt[1].trim() : '',
      location:     '',
      description:  desc,
      compensation: extractComp(desc),
    };
  }

  throw new Error('Cannot parse Greenhouse URL');
}

async function fetchLeverJob(url) {
  const m = url.match(/jobs\.lever\.co\/([^/?#]+)\/([a-f0-9-]+)/i);
  if (!m) throw new Error('Cannot parse Lever URL');
  const [, slug, uuid] = m;
  const data = await fetchJson(`https://api.lever.co/v0/postings/${slug}/${uuid}`);
  const descHtml = [data.descriptionBody, ...(data.lists || []).map(l => l.content)].filter(Boolean).join(' ');
  const desc = descHtml ? stripHtml(descHtml) : '';
  const comp = data.salaryRange
    ? `$${data.salaryRange.min?.toLocaleString()}–$${data.salaryRange.max?.toLocaleString()}`
    : extractComp(desc);
  return {
    title:        data.text || '',
    location:     data.categories?.location || data.workplaceType || '',
    description:  desc,
    compensation: comp,
  };
}

async function fetchAshbyJob(url) {
  const m = url.match(/ashbyhq\.com\/([^/?#]+)\/([a-f0-9-]+)/i);
  if (!m) throw new Error('Cannot parse Ashby URL');
  const [, slug, uuid] = m;

  try {
    const listing = await fetchJson(`https://api.ashbyhq.com/posting-api/job-board/${slug}?includeCompensation=true`);
    const job = (listing.jobs || []).find(j => j.id === uuid);
    if (job) {
      const desc = job.descriptionHtml ? stripHtml(job.descriptionHtml) : (job.descriptionPlain || '');
      const comp = job.compensation?.summaryShort || job.compensation?.summary || extractComp(desc);
      return {
        title:        job.title || '',
        location:     job.location || '',
        description:  desc,
        compensation: comp,
      };
    }
  } catch { /* fall through */ }

  let html = await fetchHtml(url);
  let nd = html.match(/"description"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  let descHtml = nd ? nd[1].replace(/\\n/g, '\n').replace(/\\"/g, '"') : '';
  let desc = descHtml ? stripHtml(descHtml) : stripHtml(html).slice(0, 3000);

  // Sparse result likely means a JS-rendered page — try Playwright
  if (desc.length < 400) {
    try {
      html = await fetchRenderedHtml(url);
      nd = html.match(/"description"\s*:\s*"((?:[^"\\]|\\.)*)"/);
      descHtml = nd ? nd[1].replace(/\\n/g, '\n').replace(/\\"/g, '"') : '';
      desc = descHtml ? stripHtml(descHtml) : stripHtml(html).slice(0, 3000);
    } catch { /* Playwright unavailable */ }
  }

  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  const rawPageTitle = titleMatch ? titleMatch[1].replace(/\s*[@|–-].*$/, '').trim() : '';
  const careersAt = rawPageTitle.match(/^(?:Careers|Jobs)\s+at\s+(.+)$/i);
  return {
    title:        careersAt ? '' : rawPageTitle,
    company:      careersAt ? careersAt[1].trim() : '',
    location:     '',
    description:  desc,
    compensation: extractComp(desc),
  };
}

async function fetchWttjJob(url) {
  const m = url.match(/\/companies\/([^/]+)\/jobs\/([^?#]+)/);
  if (m) {
    const [, orgSlug, jobSlug] = m;
    try {
      const apiUrl = `https://api.welcometothejungle.com/api/v1/organizations/${orgSlug}/jobs/${jobSlug}`;
      const data = await fetchJson(apiUrl);
      const job = data?.job;
      if (job) {
        const parts = [
          job.description || '',
          (job.key_missions || []).join(' '),
          job.profile || '',
          job.summary || '',
        ].filter(Boolean);
        const desc     = parts.length ? stripHtml(parts.join(' ')) : '';
        const offices  = job.offices || [];
        const usOffice = offices.find(o => o.country_code === 'US');
        const location = usOffice
          ? [usOffice.city, usOffice.state].filter(Boolean).join(', ')
          : (job.remote === 'full' ? 'Remote' : (offices[0]?.city || ''));
        const comp = (job.salary_min && job.salary_max)
          ? `$${Math.round(job.salary_min / 1000)}K–$${Math.round(job.salary_max / 1000)}K`
          : extractComp(desc);
        const company = data?.organization?.name || job.organization?.name || slugToTitle(orgSlug);
        return {
          title:        job.name?.trim() || '',
          company,
          location,
          description:  desc,
          compensation: comp,
        };
      }
    } catch { /* fall through */ }
  }
  // Fallback: fetch HTML and parse JSON-LD (app.welcometothejungle.com pages)
  const html = await fetchHtml(url);

  // WTTJ embeds schema.org JobPosting with the real ATS URL in identifier.value
  const jsonLdMatch = html.match(/<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/i);
  if (jsonLdMatch) {
    try {
      const schema = JSON.parse(jsonLdMatch[1]);
      if (schema['@type'] === 'JobPosting') {
        const jobTitle = schema.title || '';
        const company  = schema.hiringOrganization?.name || '';
        const atsUrl   = schema.identifier?.value || '';

        // jobLocation may be an array or a single object
        const locations = Array.isArray(schema.jobLocation) ? schema.jobLocation : (schema.jobLocation ? [schema.jobLocation] : []);
        const remote    = schema.jobLocationType === 'TELECOMMUTE' ? 'Remote' : '';
        const locationStr = remote || locations.map(l => l.address?.addressLocality).filter(Boolean)[0] || '';

        // Salary from baseSalary block
        const minSal = schema.baseSalary?.minValue;
        const maxSal = schema.baseSalary?.maxValue;
        const comp   = (minSal && maxSal)
          ? `$${Math.round(minSal / 1000)}K–$${Math.round(maxSal / 1000)}K`
          : '';

        // Use rich JSON-LD fields for description
        const descParts = [schema.description, schema.responsibilities, schema.skills]
          .filter(Boolean).map(s => stripHtml(s));
        const ldDesc = descParts.join('\n\n');

        // Follow the embedded ATS URL for the full JD text
        if (atsUrl) {
          const atsBase = atsUrl.split('?')[0];
          try {
            let d;
            if (/greenhouse\.io/i.test(atsBase)) d = await fetchGreenhouseJob(atsBase);
            else if (/lever\.co/i.test(atsBase))  d = await fetchLeverJob(atsBase);
            else if (/ashbyhq\.com/i.test(atsBase)) d = await fetchAshbyJob(atsBase);
            if (d) return { ...d, company: d.company || company, title: d.title || jobTitle, compensation: d.compensation || comp };
          } catch { /* fall through to JSON-LD data */ }
        }

        return {
          title:        jobTitle,
          company,
          location:     locationStr,
          description:  ldDesc || stripHtml(html).slice(0, 3000),
          compensation: comp || extractComp(ldDesc),
        };
      }
    } catch { /* fall through */ }
  }

  const text = stripHtml(html).slice(0, 3000);
  return { title: '', location: '', description: text, compensation: extractComp(text) };
}

// ── Workday fetcher ────────────────────────────────────────────────────────

async function fetchWorkdayJob(url, timeoutMs = 45_000) {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setExtraHTTPHeaders({ 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' });
    await page.goto(url, { waitUntil: 'networkidle', timeout: timeoutMs });

    // Title: Workday puts it in h2 (h1 is an empty container); fall back to <title>
    const title = await page.$eval(
      'h2[data-automation-id="jobPostingHeader"], h2',
      el => el.textContent.trim()
    ).catch(async () => {
      return page.title().catch(() => '');
    });

    // Company: breadcrumb or header element Workday uses for the org name
    const company = await page.$eval(
      '[data-automation-id="legalEntityName"], .css-h1jogs, [data-automation-id="company"]',
      el => el.textContent.trim()
    ).catch(async () => {
      // Fallback: extract subdomain from URL — salesforce.wd12 → Salesforce
      const m = url.match(/^https?:\/\/([^.]+)\./);
      return m ? m[1].replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) : '';
    });

    // Locations: Workday renders them as <dd> elements; filter to "State - City" shaped values
    const locationEls = await page.$$eval('dd', els =>
      els.map(el => el.textContent.trim())
         .filter(t => t.includes(' - ') && !/^(Office|Remote|Hybrid)/i.test(t) && t.length < 60)
    ).catch(() => []);
    const location = locationEls.join(', ');

    // Full job description text
    const html = await page.content();
    const text = stripHtml(html).slice(0, DESC_CAP);

    return {
      title,
      company,
      location,
      description: text,
      compensation: extractComp(text),
    };
  } finally {
    await browser.close();
  }
}

// ── Main fetcher (routes by ATS) ───────────────────────────────────────────

export async function fetchJobDetails(item) {
  const { url, company, title } = item;
  try {
    let d;
    if (/greenhouse\.io/i.test(url) || /gh_jid=/i.test(url)) d = await fetchGreenhouseJob(url);
    else if (/lever\.co/i.test(url))             d = await fetchLeverJob(url);
    else if (/ashbyhq\.com/i.test(url))          d = await fetchAshbyJob(url);
    else if (/welcometothejungle\.com/i.test(url)) d = await fetchWttjJob(url);
    else if (/myworkdayjobs\.com/i.test(url))    d = await fetchWorkdayJob(url);
    else {
      let html = await fetchHtml(url);
      let text = stripHtml(html).slice(0, DESC_CAP);
      // Sparse result likely means a JS-rendered page — try Playwright
      if (text.length < 400) {
        try {
          html = await fetchRenderedHtml(url);
          text = stripHtml(html).slice(0, DESC_CAP);
        } catch { /* Playwright unavailable */ }
      }
      d = { title, location: '', description: text, compensation: extractComp(text) };
    }
    if (d.description && d.description.length > DESC_CAP) {
      d = { ...d, description: d.description.slice(0, DESC_CAP) };
    }
    const resolvedCompany = company || extractCompanyFromUrl(url);
    return { ...d, title: d.title || title, company: d.company || resolvedCompany };
  } catch (err) {
    return { title, company, location: '', description: '', compensation: '', fetchError: err.message };
  }
}

// ── LM Studio scoring ──────────────────────────────────────────────────────

export async function scoreWithLmStudio(item, details, log = () => {}) {
  const model = getLmStudioAnalysisModel();

  const safeDesc = (details.description || '')
    .replace(/[^\x00-\x7F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, SCORE_DESC_CAP);

  const jdBlock = safeDesc
    ? `Title: ${details.title}\nCompany: ${details.company}\nLocation: ${details.location || 'N/A'}\nComp: ${details.compensation || 'N/A'}\n\nJD:\n${safeDesc}`
    : `Title: ${details.title}\nCompany: ${details.company}\nURL: ${item.url}\n(No JD)`;

  const prompt = `Score this job for the candidate. Return ONLY valid JSON, no markdown.
${PROFILE_SUMMARY}
---
${jdBlock}
---
JSON (all fields required):
{"score":<1.0-5.0>,"score_analysis":"2 sentences","role_summary":"1 sentence","gaps":["gap1"],"strategic_positioning":"1 sentence","legitimacy_check":"legitimate or suspicious","cv_match_table":[{"req":"req","evidence":"evidence or N/A","strength":"Strong|Moderate|Weak|Gap"}]}`;

  log('evaluate', `prompt: ${prompt.length} chars`);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LM_STUDIO_TIMEOUT_MS);
  try {
    const res = await fetch(`${LM_STUDIO_BASE}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 700,
        temperature: 0.2,
        num_ctx: 16384,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`LM Studio HTTP ${res.status}: ${body.slice(0, 120)}`);
    }
    const data = await res.json();
    const raw = data.choices?.[0]?.message?.content ?? '';
    const cleaned = raw.replace(/^```(?:json)?\s*/m, '').replace(/\s*```\s*$/m, '').trim();
    return JSON.parse(cleaned);
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('LM Studio timeout after 120s');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// ── Entry builder ──────────────────────────────────────────────────────────

export function buildEntry(id, item, details, scoring) {
  const today = new Date().toISOString().slice(0, 10);
  return {
    status:           normalizeStatus('lead'),
    notes:            '',
    title:            details.title || item.title || '',
    company:          details.company || item.company || '',
    location:         details.location || '',
    employment_type:  '',
    seniority:        '',
    department:       '',
    responsibilities: [],
    requirements:     [],
    qualifications:   [],
    benefits:         [],
    compensation:     details.compensation || '',
    keywords:         [],
    source:           item.source || 'manual',
    url:              item.url,
    description_preview: (details.description || '').slice(0, 500),
    full_description:    details.description || '',
    date_found:          today,
    date_updated:        today,
    score:               typeof scoring.score === 'number' ? Math.round(scoring.score * 10) / 10 : 0,
    score_analysis:      scoring.score_analysis ?? '',
    score_date:          today,
    report: {
      score:                 scoring.score ?? 0,
      role_summary:          scoring.role_summary ?? '',
      cv_match_table:        scoring.cv_match_table ?? [],
      gaps:                  scoring.gaps ?? [],
      strategic_positioning: scoring.strategic_positioning ?? '',
      interview_star_stories: scoring.interview_star_stories ?? [],
      legitimacy_check:      scoring.legitimacy_check ?? '',
    },
  };
}

// ── Tracker write ──────────────────────────────────────────────────────────

export function loadTrackerRaw() {
  return loadStoredTracker();
}

export function saveTracker(tracker) {
  return saveTrackerAtomic(tracker);
}

// ── High-level: evaluate a single URL end-to-end ───────────────────────────

/**
 * Fetch JD + score a single pipeline item with the shared dashboard evaluator.
 * @param {{ url: string, company?: string, title?: string, source?: string }} item
 * @param {{
 *   fullDescription?: string,
 *   onProgress?: (stage: string, msg: string) => void,
 *   dryRun?: boolean,
 *   scoreFallback?: boolean,
 *   shouldEvaluate?: (details: object) => boolean,
 *   tracker?: object,
 * }} opts
 * @returns {{ id, entry, alreadyExists, details, scoring }}
 */
export async function evaluateItem(item, {
  fullDescription = '',
  onProgress = () => {},
  dryRun = false,
  scoreFallback = true,
  shouldEvaluate = () => true,
  tracker = loadTrackerRaw(),
} = {}) {
  const { url, company = '', title = '' } = item;
  const id = urlToId(url);

  if (tracker[id]) {
    return { id, entry: tracker[id], alreadyExists: true, details: null, scoring: null };
  }

  let details;
  if (fullDescription) {
    // User supplied the JD directly — skip network fetch
    onProgress('fetch', 'Using provided job description…');
    details = {
      title:        title || '',
      company:      company || '',
      location:     '',
      description:  fullDescription.slice(0, DESC_CAP),
      compensation: extractComp(fullDescription),
    };
  } else {
    onProgress('fetch', 'Fetching job description…');
    details = await fetchJobDetails(item);
    if (details.fetchError) {
      onProgress('fetch', `Warning: ${details.fetchError} — scoring with available info`);
    } else {
      onProgress('fetch', `Fetched: ${details.title || url}`);
    }
  }

  // Apply overrides: user-supplied company/title win over auto-detected values
  if (company) details = { ...details, company };
  if (title)   details = { ...details, title };

  if (!shouldEvaluate(details)) {
    onProgress('skip', 'Skipped before scoring');
    return { id, entry: null, alreadyExists: false, skipped: true, details, scoring: null };
  }

  onProgress('score', 'Scoring with LM Studio…');
  let scoring;
  try {
    scoring = await scoreWithLmStudio(item, details, onProgress);
  } catch (err) {
    if (!scoreFallback) throw err;
    onProgress('score', `Scoring unavailable: ${err.message.slice(0, 60)}`);
    scoring = {
      score: 0, score_analysis: 'Score unavailable — LM Studio did not respond.',
      role_summary: '', gaps: [], strategic_positioning: '', legitimacy_check: '', cv_match_table: [],
    };
  }
  onProgress('score', `Score: ${scoring.score}`);

  const entry = buildEntry(id, item, details, scoring);
  if (dryRun) {
    onProgress('save', 'Dry run — not saved');
    return { id, entry, alreadyExists: false, details, scoring };
  }

  updateTracker(latest => {
    if (latest[id]) {
      return latest;
    }
    latest[id] = entry;
  });
  tracker[id] = entry;
  onProgress('save', 'Saved to tracker');

  // Write a report file so loadJdFromReports() finds it during resume generation
  _writeReportFile(id, entry, scoring);

  return { id, entry, alreadyExists: false, details, scoring };
}

/**
 * Fetch JD + score a single job URL, save to tracker.json.
 * @param {string} url
 * @param {{ company?: string, title?: string, fullDescription?: string, onProgress?: (stage, msg) => void }} opts
 * @returns {{ id, entry, alreadyExists }}
 */
export async function evaluateUrl(url, { company = '', title = '', fullDescription = '', onProgress = () => {} } = {}) {
  await validatePublicHttpUrl(url);
  return evaluateItem({ url, company, title }, { fullDescription, onProgress });
}

function _writeReportFile(id, entry, scoring) {
  try {
    const reportsDir = path.resolve(APP_ROOT, 'reports');
    mkdirSync(reportsDir, { recursive: true });
    const safe = s => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24);
    const filename = `${id}-${safe(entry.company)}-${safe(entry.title)}-${entry.date_found}.md`;
    const matchRows = (scoring.cv_match_table || [])
      .map(r => `| ${r.req} | ${r.evidence || 'N/A'} | ${r.strength || ''} |`)
      .join('\n');
    const gaps = (scoring.gaps || []).map(g => `- ${g}`).join('\n');
    const content = [
      `# ${entry.company} — ${entry.title}`,
      '',
      `**URL:** ${entry.url}`,
      `**Score:** ${entry.score}/5  |  **Date:** ${entry.date_found}`,
      '',
      '## Job Description',
      '',
      entry.full_description || '',
      '',
      '## AI Analysis',
      '',
      `**Role Summary:** ${scoring.role_summary || ''}`,
      `**Score Analysis:** ${scoring.score_analysis || ''}`,
      `**Strategic Positioning:** ${scoring.strategic_positioning || ''}`,
      `**Legitimacy:** ${scoring.legitimacy_check || ''}`,
      '',
      '### CV Match',
      '',
      '| Requirement | Evidence | Strength |',
      '|---|---|---|',
      matchRows,
      '',
      '### Gaps',
      '',
      gaps,
    ].join('\n');
    writeTextAtomic(path.resolve(reportsDir, filename), content);
  } catch (e) {
    process.stderr.write(`[evaluator] report write failed: ${e.message}\n`);
  }
}
