import { load as cheerioLoad } from 'cheerio';
import { WTTJ_APP_BASE, isWttjLoginUrl } from './wttj-browser-session.mjs';

const JOB_ID_RE = /^[A-Za-z0-9_-]+$/;

export { WTTJ_APP_BASE, isWttjLoginUrl };

export function canonicalWttjJobUrl(id) {
  return `${WTTJ_APP_BASE}/jobs/${id}`;
}

export function normalizeWttjJobId(value) {
  if (!value) return '';
  try {
    const url = new URL(value, WTTJ_APP_BASE);
    if (url.hostname !== 'app.welcometothejungle.com') return '';
    const match = url.pathname.match(/^\/(?:dashboard\/)?jobs\/([^/?#]+)/);
    const id = match?.[1] || '';
    return JOB_ID_RE.test(id) ? id : '';
  } catch {
    return '';
  }
}

export function normalizeWttjJobUrl(value) {
  const id = normalizeWttjJobId(value);
  return id ? canonicalWttjJobUrl(id) : '';
}

export function extractWttjJobUrls(html, base = WTTJ_APP_BASE) {
  const urls = new Set();
  const $ = cheerioLoad(html || '');

  $('a[href]').each((_, el) => {
    const normalized = normalizeWttjJobUrl($(el).attr('href'));
    if (normalized) urls.add(normalized);
  });

  const absoluteRe = /https:\/\/app\.welcometothejungle\.com\/(?:dashboard\/)?jobs\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)?/g;
  for (const match of String(html || '').matchAll(absoluteRe)) {
    const normalized = normalizeWttjJobUrl(match[0]);
    if (normalized) urls.add(normalized);
  }

  const relativeRe = /["'](\/(?:dashboard\/)?jobs\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)?)["']/g;
  for (const match of String(html || '').matchAll(relativeRe)) {
    const normalized = normalizeWttjJobUrl(new URL(match[1], base).href);
    if (normalized) urls.add(normalized);
  }

  return [...urls];
}

export function buildWttjSearchUrl(query, page = 0) {
  const url = new URL('/jobs', WTTJ_APP_BASE);
  url.searchParams.set('query', query);
  if (page > 0) url.searchParams.set('page', String(page + 1));
  return url.href;
}

function cleanText(value) {
  return String(value || '')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function pageLines($) {
  const root = $('main').first().length ? $('main').first() : $('body').first();
  const clone = root.clone();
  clone.find('script,style,noscript,svg').remove();
  clone.find('br').replaceWith('\n');
  clone.find('li').each((_, el) => $(el).append('\n'));
  clone.find('p,div,h1,h2,h3,h4,h5,h6,section,ul,ol').each((_, el) => $(el).append('\n'));
  return clone.text()
    .replace(/\r/g, '\n')
    .split(/\n+/)
    .map(line => cleanText(line))
    .filter(Boolean);
}

function extractCompensation(text) {
  const patterns = [
    /\$[\d,]+\s*[-\u2013]\s*\$[\d,]+(?:\s*[kK])?/,
    /\$[\d]+[kK]\s*[-\u2013]\s*\$?[\d]+[kK]/,
    /(?:salary|compensation|base pay)[^.:\n]*[:\s][^.:\n]*\$[\d,]+[kK]?/i,
  ];
  for (const pattern of patterns) {
    const match = String(text || '').match(pattern);
    if (match) return cleanText(match[0]);
  }
  return '';
}

function classifyHeading(line) {
  const text = line.toLowerCase().replace(/:$/, '').trim();
  if ([
    'role', 'the role', 'responsibilities', 'what you will do', "what you'll do",
    'what you will be doing', 'missions', 'key missions', 'your mission',
  ].some(value => text.includes(value))) return 'responsibilities';
  if ([
    'requirements', 'profile', 'preferred experience', 'what we are looking for',
    "what we're looking for", 'you have', 'about you', 'who you are',
  ].some(value => text.includes(value))) return 'requirements';
  if ([
    'benefits', 'what we offer', 'perks', 'compensation and benefits',
  ].some(value => text.includes(value))) return 'benefits';
  return null;
}

function appendSectionItem(sections, section, value) {
  const text = cleanText(value).replace(/^[\-\u2022*\u25cf\u25aa]\s*/, '');
  if (!section || !sections[section] || text.length < 18) return;
  if (!sections[section].includes(text)) sections[section].push(text);
}

export function parseWttjSectionsFromLines(lines) {
  const sections = { responsibilities: [], requirements: [], qualifications: [], benefits: [] };
  let current = null;

  for (const line of lines) {
    if (line.length <= 100) {
      const section = classifyHeading(line);
      if (section) {
        current = section;
        continue;
      }
    }

    const colon = line.indexOf(':');
    if (colon > 0 && colon <= 80) {
      const section = classifyHeading(line.slice(0, colon));
      if (section) {
        current = section;
        appendSectionItem(sections, current, line.slice(colon + 1));
        continue;
      }
    }

    appendSectionItem(sections, current, line);
  }

  if (!sections.responsibilities.length) {
    for (const line of lines) {
      if (/\b(own|lead|manage|drive|partner|deliver|build|support|collaborate|responsible for)\b/i.test(line)) {
        appendSectionItem(sections, 'responsibilities', line);
        if (sections.responsibilities.length >= 6) break;
      }
    }
  }
  if (!sections.requirements.length) {
    for (const line of lines) {
      if (/\b(required|must|years? of|experience (?:with|in)|proven|ability to|knowledge of|you have)\b/i.test(line)) {
        appendSectionItem(sections, 'requirements', line);
        if (sections.requirements.length >= 6) break;
      }
    }
  }

  return sections;
}

function firstText($, selectors) {
  for (const selector of selectors) {
    const text = cleanText($(selector).first().text());
    if (text) return text;
  }
  return '';
}

function extractTitleAndCompany($, lines) {
  const h1 = $('h1').first();
  const linkedCompany = cleanText(
    h1.find('a').first().text() ||
    $('a[href*="/companies/"], a[href*="welcometothejungle.com/en/companies/"]').first().text()
  );
  let title = '';
  if (h1.length) {
    const clone = h1.clone();
    clone.find('a').remove();
    title = cleanText(clone.text()).replace(/,\s*$/, '');
  }
  if (!title) title = firstText($, ['[data-testid*="job-title"]', '[class*="job-title"]', 'h1']);

  let company = linkedCompany;
  if (!company && title.includes(',')) {
    const parts = title.split(',');
    company = cleanText(parts.at(-1));
    title = cleanText(parts.slice(0, -1).join(','));
  }
  if (!company) {
    const companyLine = lines.find(line => /^company\b/i.test(line));
    if (companyLine) company = cleanText(companyLine.replace(/^company\s*/i, ''));
  }

  return { title, company };
}

function extractLocation(lines) {
  const noisy = /^(role|company mission|requirements|benefits|salary|compensation)$/i;
  return lines.find(line =>
    line.length <= 90 &&
    !noisy.test(line) &&
    /\b(remote|hybrid|united states|usa|new york|san francisco|austin|dallas|chicago|boston|atlanta|seattle|denver|los angeles|washington|miami|phoenix|portland|raleigh)\b/i.test(line)
  ) || '';
}

function extractKeywordsFromPage($, lines) {
  const keywords = new Set();
  $('[class*="tag"], [class*="pill"], [class*="badge"], [class*="skill"]').each((_, el) => {
    const text = cleanText($(el).text());
    if (text.length >= 3 && text.length <= 60) keywords.add(text);
  });
  for (const line of lines.slice(0, 40)) {
    if (line.length >= 3 && line.length <= 42 && /^(remote|hybrid|full-time|part-time|senior|mid-level|entry-level|employee|permanent)$/i.test(line)) {
      keywords.add(line);
    }
  }
  return [...keywords].slice(0, 25);
}

export function parseWttjJobDetail(html, url) {
  const $ = cheerioLoad(html || '');
  const lines = pageLines($);
  const text = lines.join('\n');
  const jobId = normalizeWttjJobId(url);
  const { title, company } = extractTitleAndCompany($, lines);
  const sections = parseWttjSectionsFromLines(lines);
  const descriptionStart = lines.findIndex(line => /^(role|the role|company mission|requirements|profile|preferred experience)$/i.test(line));
  const descriptionLines = descriptionStart >= 0 ? lines.slice(descriptionStart) : lines;
  const description = cleanText(descriptionLines.join('\n')).slice(0, 20_000);

  return {
    id: `wttj-app-${jobId}`,
    title: title || '(unknown)',
    company: company || '(unknown)',
    location: extractLocation(lines),
    compensation: extractCompensation(text),
    responsibilities: sections.responsibilities,
    requirements: sections.requirements,
    qualifications: sections.qualifications,
    benefits: sections.benefits,
    keywords: extractKeywordsFromPage($, lines),
    description,
    description_preview: description.slice(0, 600),
    url: canonicalWttjJobUrl(jobId),
    source: 'wttj-browser',
  };
}

export function buildWttjDetailQueue(sourceMap, seenIds = new Set(), limit = Infinity) {
  const queued = [];
  for (const [id, source] of sourceMap.entries()) {
    if (!id || seenIds.has(id)) continue;
    queued.push({ id, source, url: canonicalWttjJobUrl(id) });
    if (queued.length >= limit) break;
  }
  return queued;
}
