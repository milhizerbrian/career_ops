import PDFParser from 'pdf2json';
import fs from 'fs';

const STOPWORDS = new Set([
  'about', 'across', 'after', 'again', 'against', 'align', 'also', 'and', 'any',
  'are', 'based', 'been', 'being', 'between', 'build', 'business', 'can', 'client',
  'collaborate', 'customer', 'customers', 'data', 'deliver', 'drive', 'ensure',
  'experience', 'for', 'from', 'growth', 'have', 'help', 'including', 'into', 'lead',
  'leading', 'manage', 'more', 'must', 'need', 'our', 'own', 'partner', 'partners',
  'preferred', 'product', 'role', 'sales', 'service', 'skills', 'strong', 'success',
  'support', 'team', 'teams', 'that', 'the', 'their', 'this', 'through', 'using',
  'with', 'work', 'working', 'you', 'your',
]);

const KNOWN_ATS_TERMS = [
  'Account Management',
  'API',
  'ARR',
  'AWS',
  'Azure',
  'CISO',
  'CRM',
  'Customer Success',
  'Customer Success Manager',
  'Cybersecurity',
  'Datadog',
  'EDR',
  'Enterprise SaaS',
  'Executive Business Reviews',
  'Gainsight',
  'GCP',
  'IAM',
  'Incident Response',
  'Kubernetes',
  'NDR',
  'NRR',
  'Pendo',
  'QBR',
  'Renewals',
  'Retention',
  'Risk Management',
  'Salesforce',
  'SaaS',
  'Security Operations',
  'SIEM',
  'SOC',
  'SOAR',
  'Splunk',
  'SQL',
  'Technical Account Management',
  'Upsell',
  'XDR',
  'Zero Trust',
];

const EXPECTED_SECTION_HEADERS = [
  'summary',
  'experience',
  'education',
  'certifications',
  'skills',
];

function normalizeText(value) {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/[\u2010-\u2015]/g, '-')
    .replace(/[^\w+#./ -]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function keywordKey(value) {
  return normalizeText(value).replace(/[^a-z0-9+#./]+/g, ' ').trim();
}

function addKeyword(map, keyword, source, weight = 1) {
  const cleaned = String(keyword ?? '').replace(/\s+/g, ' ').trim();
  const key = keywordKey(cleaned);
  if (!key || key.length < 2 || STOPWORDS.has(key)) return;
  const existing = map.get(key) || { keyword: cleaned, sources: new Set(), weight: 0 };
  existing.weight += weight;
  existing.sources.add(source);
  if (cleaned.length < existing.keyword.length || existing.keyword === key) {
    existing.keyword = cleaned;
  }
  map.set(key, existing);
}

function addKnownTerms(map, text, source) {
  const normalized = normalizeText(text);
  for (const term of KNOWN_ATS_TERMS) {
    const key = keywordKey(term);
    if (normalized.includes(key)) addKeyword(map, term, source, 3);
  }
}

function addPhrases(map, text, source) {
  const original = String(text ?? '');
  for (const match of original.matchAll(/\b(?:[A-Z][A-Za-z0-9+#./-]{1,}|[A-Z]{2,})(?:\s+(?:[A-Z][A-Za-z0-9+#./-]{1,}|[A-Z]{2,})){0,3}\b/g)) {
    const phrase = match[0].trim();
    const key = keywordKey(phrase);
    if (phrase.length >= 3 && !STOPWORDS.has(key)) addKeyword(map, phrase, source, 2);
  }

  for (const match of original.matchAll(/\b[A-Za-z][A-Za-z0-9+#./-]{3,}\b/g)) {
    const word = match[0];
    const key = keywordKey(word);
    if (!STOPWORDS.has(key) && /[A-Z0-9+#./-]/.test(word.slice(1))) {
      addKeyword(map, word, source, 2);
    }
  }
}

export function extractAtsKeywords(job, limit = 24) {
  const keywords = new Map();
  const reportRows = Array.isArray(job?.report?.cv_match_table) ? job.report.cv_match_table : [];
  for (const row of reportRows) {
    addKnownTerms(keywords, row.requirement, 'fit report');
    addPhrases(keywords, row.requirement, 'fit report');
  }

  for (const kw of job?.keywords || []) addKeyword(keywords, kw, 'scraped keywords', 3);
  for (const req of job?.requirements || []) {
    addKnownTerms(keywords, req, 'requirements');
    addPhrases(keywords, req, 'requirements');
  }

  const jdText = [
    job?.title,
    job?.full_description,
    job?.description,
    job?.description_preview,
  ].filter(Boolean).join('\n');
  addKnownTerms(keywords, jdText, 'job description');

  return [...keywords.values()]
    .sort((a, b) => b.weight - a.weight || a.keyword.localeCompare(b.keyword))
    .slice(0, limit)
    .map(item => ({
      keyword: item.keyword,
      key: keywordKey(item.keyword),
      sources: [...item.sources],
    }));
}

function containsKeyword(text, keyword) {
  const normalizedText = normalizeText(text);
  const key = keywordKey(keyword);
  if (!key) return false;
  if (normalizedText.includes(key)) return true;
  const compactText = normalizedText.replace(/[^a-z0-9+#./]+/g, '');
  const compactKey = key.replace(/[^a-z0-9+#./]+/g, '');
  return compactKey.length >= 5 && compactText.includes(compactKey);
}

export function scoreAtsMatch(job, candidateText, draftText = '') {
  const keywords = extractAtsKeywords(job);
  const reportRows = Array.isArray(job?.report?.cv_match_table) ? job.report.cv_match_table : [];
  const evidenceText = [
    candidateText,
    draftText,
    ...reportRows
      .filter(row => row.strength === 'Strong' || row.strength === 'Partial')
      .map(row => row.brian_evidence),
  ].filter(Boolean).join('\n');

  const mapped = [];
  const missing = [];
  for (const item of keywords) {
    const isMapped = containsKeyword(evidenceText, item.keyword);
    (isMapped ? mapped : missing).push({
      keyword: item.keyword,
      sources: item.sources,
    });
  }

  const score = keywords.length ? Math.round((mapped.length / keywords.length) * 100) : 0;
  return {
    score,
    total: keywords.length,
    mapped,
    missing,
    keywords: keywords.map(({ keyword, sources }) => ({ keyword, sources })),
  };
}

export function auditParsedText(rawText, keywords = []) {
  const text = String(rawText ?? '').replace(/\s+/g, ' ').trim();
  const normalized = normalizeText(text);
  const issues = [];

  if (text.length < 500) {
    issues.push({
      type: 'low-text',
      severity: 'high',
      message: 'PDF parser extracted very little text; ATS systems may see a blank or incomplete resume.',
    });
  }

  const foundHeaders = EXPECTED_SECTION_HEADERS.filter(header => normalized.includes(header));
  const missingCoreHeaders = ['experience'].filter(header => !foundHeaders.includes(header));
  for (const header of missingCoreHeaders) {
    issues.push({
      type: 'missing-header',
      severity: 'high',
      message: `Section header "${header[0].toUpperCase()}${header.slice(1)}" was not parsed cleanly from the PDF.`,
    });
  }

  const joinedHeaderPattern = /(summary|experience|education|certifications|skills)(?=(extra|crowdstrike|securonix|mcafee|keynote|professional|technical|certified))/i;
  if (joinedHeaderPattern.test(text.replace(/\s+/g, ''))) {
    issues.push({
      type: 'merged-header',
      severity: 'medium',
      message: 'A section header appears merged into neighboring text; consider simplifying spacing or layout.',
    });
  }

  const keywordIssues = [];
  for (const item of keywords.slice(0, 12)) {
    const keyword = typeof item === 'string' ? item : item.keyword;
    const key = keywordKey(keyword);
    const compactKey = key.replace(/[^a-z0-9+#./]+/g, '');
    if (key.includes(' ') && !normalized.includes(key) && compactKey.length >= 6 && normalized.replace(/[^a-z0-9+#./]+/g, '').includes(compactKey)) {
      keywordIssues.push(keyword);
    }
  }
  if (keywordIssues.length) {
    issues.push({
      type: 'merged-keywords',
      severity: 'medium',
      message: `Possible merged ATS keywords: ${keywordIssues.slice(0, 5).join(', ')}`,
    });
  }

  return {
    ok: !issues.some(issue => issue.severity === 'high'),
    textLength: text.length,
    foundHeaders,
    issues,
  };
}

export async function parsePdfText(pdfPath) {
  if (!fs.existsSync(pdfPath)) throw new Error(`PDF not found: ${pdfPath}`);
  return await new Promise((resolve, reject) => {
    const parser = new PDFParser(null, 1);
    parser.on('pdfParser_dataError', errData => {
      reject(errData.parserError || errData);
    });
    parser.on('pdfParser_dataReady', () => {
      resolve(parser.getRawTextContent());
    });
    parser.loadPDF(pdfPath);
  });
}

export async function auditPdf(pdfPath, keywords = []) {
  const rawText = await parsePdfText(pdfPath);
  return auditParsedText(rawText, keywords);
}
