import Anthropic from '@anthropic-ai/sdk';
import { loadJobById, loadBragDoc, loadJdFromReports } from './data.mjs';
import { resolveTemplatePath, patchDocx, listTemplateFields } from './docx-utils.mjs';
import { docxToPdf, getPdfPageCount } from './pdf-utils.mjs';
import { createLogger } from './logger.mjs';
import { getLmStudioAnalysisModel } from './lm-studio-config.mjs';
import path from 'path';
import { fileURLToPath } from 'url';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PDF_VALIDATION_DISABLED = {
  status: 'skipped',
  message: 'PDF validation disabled',
};

// ── LM Studio helpers ─────────────────────────────────────────────────────────

const LM_STUDIO_BASE = 'http://localhost:1234';

async function lmStudioChat(model, messages, { maxTokens = 2000, timeoutMs = 30_000 } = {}) {
  const res = await fetch(`${LM_STUDIO_BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages, max_tokens: maxTokens }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`LM Studio HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? '';
}

function localKeywordExtract(jdText) {
  const freq = {};
  for (const w of jdText.replace(/[^a-zA-Z0-9\s\-]/g, ' ').split(/\s+/)) {
    if (w.length >= 7) freq[w.toLowerCase()] = (freq[w.toLowerCase()] || 0) + 1;
  }
  return Object.entries(freq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 30)
    .map(([w]) => w)
    .join(', ');
}

// ── Pass 1: LM Studio keyword analysis ───────────────────────────────────────

// Input caps for synthesis pass — tune via env vars
const CAP_BRAG  = parseInt(process.env.SYNTH_BRAG_CHARS  ?? '8000', 10);
const CAP_JD    = parseInt(process.env.SYNTH_JD_CHARS    ?? '5000', 10);

async function pass1KeywordAnalysis(jdText, log, notify = () => {}) {
  const model = getLmStudioAnalysisModel();
  const prompt = `Extract the 20 most important ATS keywords and required skills from this job description. Return a comma-separated list only, no explanation.\n\nJOB DESCRIPTION:\n${jdText.slice(0, 2500)}`;

  try {
    notify('lm-keyword', 'running', 'LM Studio', `Extracting keywords · ${model}`);
    const result = await lmStudioChat(model, [{ role: 'user', content: prompt }], { maxTokens: 300 });
    log('lm-studio-pass1', 'done');
    notify('lm-keyword', 'done', 'LM Studio', 'Keywords extracted');
    return result.trim();
  } catch (err) {
    if (err.code === 'ECONNREFUSED' || err.name === 'TimeoutError' || err.message.includes('fetch')) {
      log('lm-studio-pass1', `fallback to local extraction (${err.message.slice(0, 60)})`);
      notify('lm-keyword', 'fallback', 'local', 'LM Studio unavailable — local keyword extraction');
      return localKeywordExtract(jdText);
    }
    throw err;
  }
}

// ── Pass 2: Synthesis (Claude or LM Studio) ───────────────────────────────────

const SYNTHESIS_SYSTEM_PROMPT = `You are an elite executive resume strategist for top-1% enterprise Customer Success, CSE, TAM, and cybersecurity post-sales candidates. Return strict JSON only — no markdown, no explanation.

Fill every named template field with content tailored to the target job.

RULES:
1. Never invent employers, dates, metrics, certs, tools, or experience not in candidate history.
2. Mirror exact JD language for ATS matching only when candidate history supports it.
3. Every major JD requirement maps to a proof point with metric, scope, stakeholder, product/domain, or outcome.
4. Use the JD's dominant verbs naturally. No em dashes.
5. Banned: results-driven, proven track record, passionate, dynamic, synergy, leverage, world-class, thought leader.
6. QUALITY BAR: Write for a top-1% applicant. Basic bullets are unacceptable. Each job bullet must include at least three of these four elements: quantified business result, account/portfolio scope, named security/customer-success domain, and concrete action/mechanism.
7. DEPTH: Do not write generic activity bullets like "managed accounts", "supported customers", "partnered with teams", "drove adoption", or "improved engagement" unless the same sentence explains the specific scope, mechanism, and result.
8. TWO-PAGE TARGET: Fill the template as a dense two-page executive resume. Do not underfill. PROFESSIONAL_SUMMARY should be 55-75 words across 3 sentences. KEY_ACHIEVEMENT fields should be 18-28 words. JOB_N_CONTEXT fields should be 18-26 words. JOB_N_BULLET_N fields should be 22-34 words and may wrap to two lines if needed.
9. CHARACTER TARGETS: For JOB_1 through JOB_4 bullets, target 175-240 characters. For older or compressed JOB_5+ bullets, target 140-210 characters.
10. Use all listed bullet fields. For older or less relevant roles, compress by selecting fewer details, not by writing thin generic bullets. Do not over-compress useful detail or turn evidence into resume shorthand.

FIELDS: TITLE_LINE=positioning tagline | METRICS_LINE=4-5 compact career metrics | PROFESSIONAL_SUMMARY=3 strong executive sentences | CORE_COMPETENCIES=12-16 ATS skills mirroring JD | KEY_ACHIEVEMENT_1-4=metric-driven accomplishment | JOB_N_CONTEXT=scope sentence with role/domain/portfolio | JOB_N_BULLET_N=detailed impact bullet using real evidence

Return {fieldName: "replacement text"}.`;

async function pass2Synthesis(jdText, keywords, bragDoc, fields, log, notify = () => {}) {
  const preferClaude = (process.env.PREFER_CLAUDE_SYNTHESIS ?? '0') === '1';
  const buildContent = (historySlice) =>
    `CANDIDATE HISTORY:\n${historySlice}\n\nJOB DESCRIPTION:\n${jdText.slice(0, CAP_JD)}\n\nKEYWORDS FROM PASS 1:\n${keywords}\n\nTEMPLATE FIELDS TO FILL:\n${fields.map(f => `- ${f}`).join('\n')}\n\nReturn a JSON object mapping each field name to its replacement text.`;

  const lmContent   = buildContent(bragDoc.slice(0, CAP_BRAG));
  const fullContent = buildContent(bragDoc);

  if (preferClaude || !process.env.LM_STUDIO_SYNTHESIS_MODEL) {
    notify('lm-synthesis', 'skipped', 'LM Studio', 'PREFER_CLAUDE=1 — skipping LM Studio');
    return await claudeSynthesis(fullContent, log, notify);
  }

  const model = process.env.LM_STUDIO_SYNTHESIS_MODEL ?? 'qwen2.5-14b-instruct-1m';
  const maxTokens = parseInt(process.env.LM_STUDIO_MAX_OUTPUT_TOKENS ?? '4096', 10);
  const timeoutMs = parseInt(process.env.LM_STUDIO_SYNTHESIS_TIMEOUT_MS ?? '180000', 10);
  notify('lm-synthesis', 'running', 'LM Studio', `Synthesizing resume · ${model} (up to ${Math.round(timeoutMs/1000)}s)`);
  try {
    const raw = await lmStudioChat(
      model,
      [
        { role: 'system', content: SYNTHESIS_SYSTEM_PROMPT },
        { role: 'user', content: lmContent },
      ],
      { maxTokens, timeoutMs }
    );
    const cleaned = raw.replace(/^```(?:json)?\s*/m, '').replace(/\s*```\s*$/m, '').trim();
    const parsed = JSON.parse(cleaned);

    const filled = fields.filter(f => parsed[f] && String(parsed[f]).trim().length > 0).length;
    const coverage = filled / fields.length;
    if (coverage < 0.8) {
      log('lm-studio-pass2', `low coverage ${filled}/${fields.length} fields — falling back to Claude`);
      notify('lm-synthesis', 'fallback', 'LM Studio', `Low coverage ${filled}/${fields.length} fields → falling back to Claude`);
      return await claudeSynthesis(fullContent, log, notify);
    }

    log('lm-studio-pass2', `done (${filled}/${fields.length} fields)`);
    notify('lm-synthesis', 'done', 'LM Studio', `${filled}/${fields.length} fields filled`);
    return parsed;
  } catch (err) {
    log('lm-studio-pass2', `fallback to Claude (${err.message.slice(0, 80)})`);
    notify('lm-synthesis', 'fallback', 'LM Studio', `${err.message.slice(0, 60)} → falling back to Claude`);
    return await claudeSynthesis(fullContent, log, notify);
  }
}

async function claudeSynthesis(userContent, log, notify = () => {}) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');
  const client = new Anthropic({ apiKey });
  const model = process.env.CLAUDE_SYNTHESIS_MODEL ?? 'claude-sonnet-4-6';

  notify('claude-synthesis', 'running', 'Claude', `Synthesizing resume · ${model}`);
  const message = await client.messages.create({
    model,
    max_tokens: 4096,
    system: SYNTHESIS_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userContent }],
  });

  const rawText = message.content[0]?.text ?? '';
  const cleaned = rawText.replace(/^```(?:json)?\s*/m, '').replace(/\s*```\s*$/m, '').trim();
  const parsed = JSON.parse(cleaned);
  log('claude-synthesis', 'done');
  notify('claude-synthesis', 'done', 'Claude', 'Synthesis complete');
  return parsed;
}

// ── Quality gate ──────────────────────────────────────────────────────────────

const GENERIC_BULLET_RE = /\b(managed|owned|supported|advised|maintained|partnered|worked|helped|assisted|handled|responsible for|drove adoption|improved engagement|ensured|collaborated)\b/i;
const PROOF_RE = /(\$[\d,.]+[MBK]?|\d+%|\d+\+?x|\b\d+\s*(accounts?|customers?|clients?|direct reports|opportunities|expansions|renewals|years?|ARR|NPS|CSAT)\b|\bFortune\s*\d+\b|\benterprise\b|\bCISO\b|\bVP\b)/i;
const DOMAIN_RE = /\b(NDR|NPM|SIEM|UEBA|EDR|IAM|DLP|CNAPP|CWPP|XDR|SaaS|security|cybersecurity|cloud|identity|endpoint|network|email|renewal|retention|expansion|onboarding|QBR|time-to-value|adoption)\b/i;
const MECHANISM_RE = /\b(by|through|using|via|with|across|for|while|including|tied to|resulting in|enabling|reducing|retaining|expanding|accelerating|recovering|introducing|building|stabilizing)\b/i;

function wordCount(value) {
  return String(value ?? '').trim().split(/\s+/).filter(Boolean).length;
}

function hasWeakGenericShape(value) {
  const text = String(value ?? '').trim();
  return GENERIC_BULLET_RE.test(text) && !(PROOF_RE.test(text) && DOMAIN_RE.test(text) && MECHANISM_RE.test(text));
}

function bulletRoleNumber(field) {
  return Number(field.match(/^JOB_(\d+)_BULLET_\d+$/i)?.[1] ?? 0);
}

function bulletTargets(field) {
  const roleNumber = bulletRoleNumber(field);
  if (!roleNumber) return null;
  if (roleNumber >= 5) {
    return { minWords: 15, idealWords: '15-28', minChars: 140, maxChars: 210, kind: 'older/compressed' };
  }
  return { minWords: 18, idealWords: '22-34', minChars: 175, maxChars: 240, kind: 'recent/relevant' };
}

export function validateResumeQuality(replacements, fields) {
  const issues = [];
  const missing = fields.filter((field) => !String(replacements[field] ?? '').trim());
  for (const field of missing) issues.push(`${field}: missing replacement`);

  for (const field of fields) {
    const value = String(replacements[field] ?? '').trim();
    if (!value) continue;

    const words = wordCount(value);
    if (/^PROFESSIONAL_SUMMARY$/i.test(field) && words < 45) {
      issues.push(`${field}: summary is too thin (${words} words, expected 45+)`);
    }
    if (/^KEY_ACHIEVEMENT_\d+$/i.test(field) && words < 14) {
      issues.push(`${field}: achievement is too short (${words} words, expected 14+)`);
    }
    if (/^JOB_\d+_CONTEXT$/i.test(field) && words < 12) {
      issues.push(`${field}: context is too short (${words} words, expected 12+)`);
    }
    if (/^JOB_\d+_BULLET_\d+$/i.test(field)) {
      const targets = bulletTargets(field);
      const chars = value.length;
      if (words < 15) issues.push(`${field}: bullet is too short (${words} words, expected 15+ even when compressed)`);
      if (targets && words < targets.minWords) {
        issues.push(`${field}: ${targets.kind} bullet is too short (${words} words, target ${targets.idealWords})`);
      }
      if (targets && chars < targets.minChars) {
        issues.push(`${field}: ${targets.kind} bullet is underfilled (${chars} characters, target ${targets.minChars}-${targets.maxChars})`);
      }
      if (!PROOF_RE.test(value)) issues.push(`${field}: bullet lacks metric, enterprise scope, or stakeholder proof`);
      if (!DOMAIN_RE.test(value)) issues.push(`${field}: bullet lacks relevant domain or CS/security language`);
      if (hasWeakGenericShape(value)) issues.push(`${field}: bullet reads like generic activity rather than differentiated impact`);
    }
  }

  if (issues.length) {
    const err = new Error(`Resume quality gate failed:\n${issues.slice(0, 20).join('\n')}`);
    err.issues = issues;
    throw err;
  }
  return true;
}

export function buildResumeDebugStats(replacements, fields, { pageCount = null } = {}) {
  const bulletFields = fields.filter((field) => /^JOB_\d+_BULLET_\d+$/i.test(field));
  const bullets = bulletFields.map((field) => String(replacements[field] ?? '').trim()).filter(Boolean);
  const wordCounts = bullets.map(wordCount);
  const charCounts = bullets.map((bullet) => bullet.length);
  const avg = (values) => values.length
    ? Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 10) / 10
    : 0;
  const weakBulletCount = bullets.filter((bullet) =>
    wordCount(bullet) < 15 ||
    !PROOF_RE.test(bullet) ||
    !DOMAIN_RE.test(bullet) ||
    hasWeakGenericShape(bullet)
  ).length;
  const estimatedDensity = charCounts.reduce((sum, value) => sum + value, 0);

  return {
    bulletCount: bullets.length,
    avgBulletWordCount: avg(wordCounts),
    avgBulletCharacterCount: avg(charCounts),
    weakBulletCount,
    pageCount,
    estimatedDensity,
  };
}

export function isPdfExportEnabled() {
  return /^(1|true|yes)$/i.test(String(process.env.RESUME_PDF_EXPORT ?? '0'));
}

async function maybeExportPdf(docxPath, outputDir, replacements, fields, log, emit) {
  if (!isPdfExportEnabled()) {
    debugPipeline(log, 'page-density', {
      ...buildResumeDebugStats(replacements, fields),
      validationStatus: 'pass',
    });
    return {
      pdfUrl: null,
      pageCount: null,
      pageValidation: { ...PDF_VALIDATION_DISABLED },
    };
  }

  emit('pdf', 'started');
  try {
    const pdfPath = await docxToPdf(docxPath, outputDir);
    const pageCount = await getPdfPageCount(pdfPath);
    const pageValidation = pageCount
      ? {
          status: pageCount === 2 ? 'passed' : 'warning',
          message: pageCount === 2
            ? 'PDF page count is 2'
            : `Generated PDF is ${pageCount} page(s); target is 2 full pages`,
        }
      : {
          status: 'skipped',
          message: 'PDF page count unavailable',
        };
    debugPipeline(log, 'page-density', {
      ...buildResumeDebugStats(replacements, fields, { pageCount }),
      validationStatus: 'pass',
    });
    emit('pdf', 'done', pageCount ? { message: `${pageCount} PDF pages` } : { message: pageValidation.message });
    return {
      pdfUrl: `/output/${path.basename(pdfPath)}`,
      pageCount,
      pageValidation,
    };
  } catch (err) {
    log('pdf', `skipped (${err.message.slice(0, 100)})`);
    debugPipeline(log, 'page-density', {
      ...buildResumeDebugStats(replacements, fields),
      validationStatus: 'pass',
    });
    emit('pdf', 'skipped', { message: 'PDF export unavailable; DOCX generated' });
    return {
      pdfUrl: null,
      pageCount: null,
      pageValidation: { ...PDF_VALIDATION_DISABLED },
    };
  }
}

function debugPipeline(log, label, stats) {
  if (process.env.RESUME_DEBUG_PIPELINE !== '1') return;
  const message = [
    `average bullet word count=${stats.avgBulletWordCount}`,
    `average bullet character count=${stats.avgBulletCharacterCount}`,
    `weak bullet count=${stats.weakBulletCount}`,
    `validation=${stats.validationStatus ?? 'pending'}`,
    stats.pageCount ? `page count=${stats.pageCount}` : `estimated density=${stats.estimatedDensity}`,
  ].join(' | ');
  log(`resume-debug-${label}`, message);
  process.stderr.write(`[resume-debug:${label}] ${message}\n`);
}

// ── Optional polish pass ──────────────────────────────────────────────────────

async function polishBullets(replacements, log, notify = () => {}) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    notify('claude-polish', 'skipped', 'Claude', 'Polish skipped — no API key');
    return replacements;
  }

  const bulletEntries = Object.entries(replacements)
    .filter(([k]) => k.toLowerCase().includes('achievement') || k.toLowerCase().includes('bullet'));
  if (!bulletEntries.length) {
    notify('claude-polish', 'skipped', 'Claude', 'No bullets to polish');
    return replacements;
  }

  const client = new Anthropic({ apiKey });
  const model = process.env.CLAUDE_POLISH_MODEL ?? 'claude-sonnet-4-6';
  notify('claude-polish', 'running', 'Claude', `Polishing ${bulletEntries.length} bullets · ${model}`);
  const prompt = `Rewrite these resume bullets to meet a top-1% executive resume bar while preserving only real facts already present in the text. Do not trim them into generic one-liners or resume shorthand. Each JOB bullet should be 22-34 words and include specific scope, concrete action/mechanism, domain language, and measurable outcome where available. For JOB_1 through JOB_4 bullets, target 175-240 characters. For older or compressed JOB_5+ bullets, target 140-210 characters. Each KEY_ACHIEVEMENT should be 18-28 words. Avoid generic verbs without proof, and do not over-compress useful detail. Return a JSON object with the same keys and refined values. No explanation.\n\n${JSON.stringify(Object.fromEntries(bulletEntries))}`;

  try {
    const message = await client.messages.create({
      model,
      max_tokens: 2048,
      messages: [{ role: 'user', content: prompt }],
    });
    const raw = message.content[0]?.text ?? '';
    const cleaned = raw.replace(/^```(?:json)?\s*/m, '').replace(/\s*```\s*$/m, '').trim();
    let polished;
    try {
      polished = JSON.parse(cleaned);
    } catch {
      polished = {};
      for (const m of cleaned.matchAll(/"([^"]+)":\s*"((?:[^"\\]|\\.)*)"/g)) {
        polished[m[1]] = m[2].replace(/\\n/g, '\n').replace(/\\"/g, '"');
      }
      if (!Object.keys(polished).length) throw new Error('no parseable pairs');
    }
    log('claude-polish', 'done');
    notify('claude-polish', 'done', 'Claude', `${Object.keys(polished).length} bullets polished`);
    return { ...replacements, ...polished };
  } catch (err) {
    log('claude-polish', `skipped (${err.message.slice(0, 60)})`);
    notify('claude-polish', 'skipped', 'Claude', `Polish skipped — ${err.message.slice(0, 50)}`);
    return replacements;
  }
}

// ── Shared setup helper ───────────────────────────────────────────────────────

function buildJdText(job, jobId) {
  return loadJdFromReports(jobId) || [
    `Company: ${job.company}`,
    `Role: ${job.title}`,
    `Location: ${job.location || ''}`,
    '',
    job.full_description || job.description_preview || '',
  ].join('\n');
}

function outputPaths(job) {
  const datePart = new Date().toISOString().slice(0, 10);
  const companySafe = (job.company || 'company').toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const outputDir = path.resolve(APP_ROOT, 'output');
  return { outputDir, docxFilename: `resume-${companySafe}-${datePart}.docx` };
}

// ── analyzeGaps ───────────────────────────────────────────────────────────────

export async function analyzeGaps(jobId) {
  const job = loadJobById(jobId);
  const bragDoc = loadBragDoc();
  const jdText = buildJdText(job, jobId);
  const model = getLmStudioAnalysisModel();
  const prompt = `You are a resume gap analyzer. Given the job description and candidate history below, list the skills, certifications, or experience required by the job that are NOT demonstrated in the candidate history. Return a JSON array of short strings only — no explanation.\n\nJOB DESCRIPTION:\n${jdText.slice(0, 3000)}\n\nCANDIDATE HISTORY:\n${bragDoc.slice(0, 3000)}`;

  try {
    const raw = await lmStudioChat(model, [{ role: 'user', content: prompt }]);
    const cleaned = raw.replace(/^```(?:json)?\s*/m, '').replace(/\s*```\s*$/m, '').trim();
    return JSON.parse(cleaned);
  } catch {
    // Fallback: extract required skills and flag common gaps
    const reqSection = jdText.match(/require[sd]?[:\s]+([\s\S]{0,800})/i)?.[1] ?? '';
    return reqSection
      .split(/[,\n•\-]/)
      .map(s => s.trim())
      .filter(s => s.length > 4 && s.length < 60)
      .slice(0, 10);
  }
}

// ── Draft / Finish (A/B variant support) ─────────────────────────────────────

export async function generateResumeDraft(jobId, io, injectedSkills, variant = 'default') {
  const runId = `${jobId}-${variant}-${Date.now()}`;
  const { log } = createLogger(runId);

  const emit = (stage, status, extra = {}) => {
    io.emit('progress', { jobId, stage: `${stage}:${variant}`, status, ...extra });
    log(stage, status);
  };

  const job = loadJobById(jobId);
  const jdText = buildJdText(job, jobId);
  const bragDoc = loadBragDoc();
  const templatePath = resolveTemplatePath();
  const fields = listTemplateFields(templatePath);

  emit('lm-studio', 'started');
  const keywords = await pass1KeywordAnalysis(jdText, log);
  emit('lm-studio', 'done');

  const variantHint = variant === 'technical'
    ? '\nEMPHASIS: Prioritize technical depth, integration expertise, and security stack knowledge.'
    : variant === 'outcomes'
    ? '\nEMPHASIS: Prioritize business outcomes, revenue metrics, customer retention, and executive-level impact.'
    : '';

  const skillsHint = injectedSkills
    ? `\nINJECTED SKILLS TO HIGHLIGHT: ${injectedSkills}`
    : '';

  emit('ai', 'started');
  const replacements = await pass2Synthesis(
    jdText + variantHint + skillsHint,
    keywords,
    bragDoc,
    fields,
    log,
  );
  emit('ai', 'done');

  return { jobId, io, job, jdText, templatePath, fields, replacements, keywords, variant, log };
}

export async function generateResumeFinish(state) {
  const { jobId, io, job, templatePath, fields, variant, log } = state;
  let { replacements } = state;

  const emit = (stage, status, extra = {}) => {
    io.emit('progress', { jobId, stage: `${stage}:${variant}`, status, ...extra });
    log(stage, status);
  };

  emit('polish', 'started');
  replacements = await polishBullets(replacements, log);
  emit('polish', 'done');

  emit('validation', 'started');
  try {
    validateResumeQuality(replacements, fields);
    debugPipeline(log, 'validation', {
      ...buildResumeDebugStats(replacements, fields),
      validationStatus: 'pass',
    });
  } catch (err) {
    debugPipeline(log, 'validation', {
      ...buildResumeDebugStats(replacements, fields),
      validationStatus: 'fail',
    });
    throw err;
  }
  emit('validation', 'done');

  emit('docx', 'started');
  const { outputDir, docxFilename } = outputPaths(job);
  const base = docxFilename.replace('.docx', `-${variant}`);
  const docxPath = path.resolve(outputDir, `${base}.docx`);
  const { unreplaced } = patchDocx(templatePath, replacements, docxPath);
  emit('docx', 'done');

  const docxUrl = `/output/${base}.docx`;
  const { pdfUrl, pageCount, pageValidation } = await maybeExportPdf(
    docxPath,
    outputDir,
    replacements,
    fields,
    log,
    emit,
  );

  io.emit('complete', { jobId, variant, docxUrl, pdfUrl, pageValidation });
  log('complete', `variant=${variant} docx=${base}.docx unreplaced=${unreplaced.length}`);

  if (unreplaced.length) {
    emit('warning', 'done', { message: `Unreplaced: ${unreplaced.join(', ')}` });
  }
  if (pageValidation.status === 'warning') {
    emit('warning', 'done', { message: pageValidation.message });
  }

  return { variant, docxUrl, pdfUrl, unreplaced, pageCount, pageValidation };
}

// ── Main export ───────────────────────────────────────────────────────────────

export async function generateResume(jobId, io, injectedSkills = '') {
  const state = await generateResumeDraft(jobId, io, injectedSkills, 'default');
  return generateResumeFinish(state);
}
